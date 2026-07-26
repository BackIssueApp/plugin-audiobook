// Best-effort audiobook metadata from the hosted metadata service — the audio
// analogue of the ebooks plugin's metadata.js.
//
//   GET <base>/audiobooks/search?q=<text>&limit=N → { results: [{ asin, title,
//       subtitle, authors[], narrators[], series{ name, position }, description,
//       publisher, published_date, duration_min, genres[], language, isbn,
//       explicit, thumbnail }] }
//   GET <base>/audiobooks/<asin>                   → { audiobook: {same shape} }
//
// <base> is the app's metadata endpoint (default https://data.backissue.app/api),
// authed with the app's self-provisioned instance key (metadataInstanceKey) sent
// as x-api-key. Until that key exists the client reports unavailable — local
// files play fine unmatched (the <audio> element reads duration off the file
// itself), and the scan job retries the match on a later run.

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));

/** Jaccard-ish overlap of the SHORTER title's tokens ("Dune" vs
 *  "Dune (Unabridged)" should score high). */
function titleSimilarity(a, b) {
  const ta = tokens(a); const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

function authorsOverlap(a = [], b = []) {
  if (!a.length || !b.length) return null; // unknown — not a signal either way
  const bt = b.map(norm);
  // Surname-level match is enough ("Frank Herbert" vs "Herbert, Frank").
  return a.some((x) => {
    const words = norm(x).split(' ').filter((w) => w.length > 2);
    return words.some((w) => bt.some((y) => y.includes(w)));
  });
}

export function makeAudiobookClient(config, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const base = () => String(process.env.METADATA_BASE_OVERRIDE || 'https://data.backissue.app/api').trim().replace(/\/+$/, '');
  const key = () => config.metadataInstanceKey || null;

  async function getJson(url) {
    const r = await doFetch(url, { headers: { 'x-api-key': key() } });
    if (!r.ok) throw new Error(`metadata service HTTP ${r.status}`);
    return r.json();
  }
  return {
    /** Is the service usable right now? (No key yet → no.) */
    available: () => !!key(),
    /** Provision the shared instance key if the app hasn't yet — core only mints
     *  it on ITS first metadata call, which a fresh install may not have made
     *  when the first audiobook scan runs. Same path/guard as core; best-effort. */
    async ensureKey() {
      if (key()) return true;
      try {
        const { ensureInstanceKey } = await import('../../src/cv.js');
        await ensureInstanceKey(config, base(), doFetch);
        return !!key();
      } catch { return false; }
    },
    async search(q, limit = 5) {
      if (!key()) return null;
      const u = `${base()}/audiobooks/search?q=${encodeURIComponent(q)}&limit=${limit}`;
      return (await getJson(u))?.results || [];
    },
    async book(asin) {
      if (!key()) return null;
      return (await getJson(`${base()}/audiobooks/${encodeURIComponent(asin)}`))?.audiobook || null;
    },
  };
}

/** Pick the best search result for a scanned audiobook, or null. Audiobooks
 *  rarely carry an ISBN in their filenames, so the match is title+author: the
 *  titles must share most of the shorter title's words AND the authors must not
 *  contradict (either side unknown is fine). */
export function chooseMatch(book, results) {
  if (!Array.isArray(results) || !results.length) return null;
  for (const r of results) {
    if (titleSimilarity(book.title, r.title) >= 0.6 && authorsOverlap(book.authors, r.authors) !== false) {
      return { result: r, confidence: 'title' };
    }
  }
  return null;
}

/** Merge an accepted match into store fields. Service-only fields (narrators,
 *  duration, series, publisher, dates, genres, thumbnail) are always taken — a
 *  filename has no opinion on them. A filename-derived title is replaced by the
 *  service's (strictly better); an author fills only when the file had none;
 *  the longer description wins. */
export function mergeMatch(book, result, confidence) {
  const out = {
    match_id: String(result.asin),
    match_confidence: confidence,
    subtitle: result.subtitle ?? null,
    narrators: Array.isArray(result.narrators) ? result.narrators : [],
    series: result.series?.name ?? null,
    series_index: result.series?.position ?? null,
    publisher: result.publisher ?? null,
    published_date: result.published_date ?? null,
    duration: Number.isFinite(result.duration_min) ? Math.round(result.duration_min * 60) : null,
    genres: Array.isArray(result.genres) ? result.genres : [],
    language: result.language ?? book.language ?? null,
    thumbnail: result.thumbnail ?? null,
    explicit: !!result.explicit,
  };
  if (result.title && book.title_source !== 'embedded') out.title = result.title;
  if (String(result.description || '').length > String(book.description || '').length) {
    out.description = result.description;
  }
  if (!book.authors?.length && Array.isArray(result.authors) && result.authors.length) out.authors = result.authors;
  return out;
}

/** One audiobook, end to end: search (title+author), choose, merge. Returns the
 *  merged fields or null (no key / no confident match). */
export async function matchAudiobook(client, book) {
  if (!client.available()) return null;
  const q = [book.title, book.authors?.[0]].filter(Boolean).join(' ');
  if (!q) return null;
  const results = await client.search(q, 5);
  const choice = chooseMatch(book, results || []);
  return choice ? mergeMatch(book, choice.result, choice.confidence) : null;
}

/** Try each source in order and return the first confident match. A source that
 *  isn't usable, or that throws, is skipped so a flaky one never blocks a
 *  working one. */
export async function matchAudiobookAcross(clients, book) {
  for (const c of clients) {
    if (!c || !c.available()) continue;
    try {
      const m = await matchAudiobook(c, book);
      if (m) return m;
    } catch { /* source trouble → try the next source */ }
  }
  return null;
}

/** Best-effort pass over never-attempted audiobooks. `clients` is one client or
 *  an ordered array (preferred first). Every book gets its attempt recorded (hit
 *  or miss) so scans don't re-hammer the service; if EVERY source errors on a
 *  book the pass stops (transient trouble — retried next scan). */
export async function matchNewAudiobooks(store, clients, { log = () => {} } = {}) {
  const list = Array.isArray(clients) ? clients : [clients];
  for (const c of list) { if (c && !c.available()) await c.ensureKey?.(); }
  if (!list.some((c) => c && c.available())) return { matched: 0, checked: 0 };
  let matched = 0; let checked = 0;
  for (const book of store.unmatched()) {
    let errored = 0; let merged = null;
    for (const c of list) {
      if (!c || !c.available()) continue;
      try { merged = await matchAudiobook(c, book); if (merged) break; }
      catch { errored++; }
    }
    if (!merged && errored && errored === list.filter((c) => c && c.available()).length) {
      log('audiobooks: metadata match stopped (all sources erroring)');
      break;
    }
    if (merged) { store.applyMatch(book.id, merged); matched++; }
    else store.setMatchChecked(book.id);
    checked++;
  }
  return { matched, checked };
}
