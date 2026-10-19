// Audiobook catalog plumbing — the audio analogue of the ebooks store.
//
// Audiobooks are REAL catalog rows: each audiobook is a self-described
// `audiobook`-type core `series` with a single core `issue` (the whole book),
// so the Library grid, series pages, permissions and the mature filter all ride
// core with no parallel UI. A file-less remote entry has no file on disk — it
// STREAMS from its source on play (see index.js) — so `library_files` is only
// written once a file is actually cached to disk.
//
// This module owns only what core has no home for: the path/stream mapping with
// audio metadata (audiobooks_files), the per-user playback position
// (audiobooks_progress), bookmarks (audiobooks_bookmarks), and the sync cursor.
// Same catalog.db file, own connection.
import path from 'node:path';
import Database from 'better-sqlite3';
import { upsertLibraryFile, linkLibraryFile, deleteLibraryFile, getLibraryFile } from '../../src/db.js';

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'untitled';
// A series-grouped book (folder layout <Author>/<Series>/<Title>) is keyed by
// library + series; a standalone by title~author — so both a rescan and a
// remote re-sync land on the same row.
export const seriesUrlFor = (libraryId, meta) => (meta.series
  ? `audiobook:l${libraryId}:s:${slug(meta.series)}`
  : `audiobook:l${libraryId}:b:${slug(meta.title)}~${slug(meta.author || (meta.authors || [])[0] || '')}`);
const issueUrlFor = (p) => 'audiobookfile:' + p;
/** A title reduced to what identifies the book: lower-case, bracketed notes
 *  dropped, cut at a subtitle (": A Novel", " - Book One"), punctuation
 *  collapsed — "Theo of Golden: A Novel (English Edition)" → "theo of golden". */
export function titleKey(t) {
  return String(t || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s*[:–—]\s*|\s+-\s+/)[0]
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const indexNumber = (n) => (Number.isFinite(Number(n)) && String(n).trim() !== '' ? String(n) : '1');
const year4 = (s) => (String(s || '').match(/(\d{4})/) || [])[1] || null;
const nownow = () => new Date().toISOString();

// When a listen counts as finished: within the last two minutes, or the last
// 1% of a long book, whichever is more; never more than the last 10% (so a
// short clip isn't finished the moment it starts). Stopping at 99% of a
// ten-hour book used to leave it on Continue listening for good.
const finishWindow = (duration) => Math.min(Math.max(120, duration * 0.01), duration * 0.1);
export const isFinished = (position, duration) => duration > 0 && position >= duration - finishWindow(duration);
/** The same rule in SQL, over a progress row aliased `a`. */
export const FINISHED_SQL = (a) => `${a}.duration > 0 AND ${a}.position >= ${a}.duration - MIN(MAX(120, ${a}.duration * 0.01), ${a}.duration * 0.1)`;

export function openAudiobooksStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audiobooks_files (
      path         TEXT PRIMARY KEY,   -- NULL for a remote entry until cached (SQLite keeps NULL PKs distinct)
      library_id   INTEGER NOT NULL,
      series_id    INTEGER,
      issue_id     INTEGER,            -- core issue row (route key)
      format       TEXT NOT NULL DEFAULT 'm4b',
      size         INTEGER,
      duration     INTEGER,            -- seconds
      narrators    TEXT,               -- comma-joined
      chapters     TEXT,               -- JSON [{ title, start }]
      cover_type   TEXT,
      thumbnail    TEXT,               -- remote cover proxy URL
      explicit     INTEGER NOT NULL DEFAULT 0,
      source       TEXT,               -- NULL = a local file; else the registered remote source id
      remote_id    TEXT,               -- id in that source's catalog (with source = sync identity)
      added_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_abfiles_library ON audiobooks_files (library_id);
    CREATE INDEX IF NOT EXISTS idx_abfiles_issue ON audiobooks_files (issue_id);
    CREATE INDEX IF NOT EXISTS idx_abfiles_remote ON audiobooks_files (source, remote_id);

    -- Per-user playback position, keyed by CORE issue id. position/duration in
    -- seconds; finished flips at ~the end so "Finished" shelves work.
    CREATE TABLE IF NOT EXISTS audiobooks_progress (
      user_id    INTEGER NOT NULL DEFAULT 0,
      issue_id   INTEGER NOT NULL,
      position   REAL NOT NULL DEFAULT 0,
      duration   REAL NOT NULL DEFAULT 0,
      finished   INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (user_id, issue_id)
    );

    CREATE TABLE IF NOT EXISTS audiobooks_bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 0,
      issue_id   INTEGER NOT NULL,
      position   REAL NOT NULL,      -- seconds
      note       TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_abbookmarks ON audiobooks_bookmarks (user_id, issue_id);

    CREATE TABLE IF NOT EXISTS audiobooks_remote_sync (
      source      TEXT PRIMARY KEY,
      cursor_page INTEGER NOT NULL DEFAULT 1,
      total       INTEGER,
      updated_at  TEXT
    );

    -- Per-user visibility of each audiobook home rail (both default on).
    CREATE TABLE IF NOT EXISTS audiobooks_home_prefs (
      user_id       INTEGER PRIMARY KEY,
      show_continue INTEGER NOT NULL DEFAULT 1,
      show_new      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audiobooks_wanted (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id   TEXT NOT NULL UNIQUE,   -- the catalog's id for the book
      title      TEXT NOT NULL,
      author     TEXT,
      year       TEXT,
      isbn       TEXT,
      cover      TEXT,
      added_by   INTEGER NOT NULL DEFAULT 0,
      added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      tried_at   TEXT,
      last_error TEXT
    );
  `);
  // The original table only carried remote (file-less) entries; add the columns
  // a LOCAL scanned file needs (the incremental-skip key + metadata-match state)
  // to an existing DB. Fresh DBs get them here too — harmless if already present.
  const abCols = db.prepare("SELECT name FROM pragma_table_info('audiobooks_files')").all().map((r) => r.name);
  for (const [col, decl] of [
    ['mtime', 'INTEGER'], ['title_source', 'TEXT'],
    ['match_id', 'TEXT'], ['match_confidence', 'TEXT'], ['match_checked_at', 'TEXT'],
    // A remote title the source could not serve (its file is gone): when, and
    // what it said. Cleared the moment a stream succeeds again.
    ['unavailable_at', 'TEXT'], ['unavailable_reason', 'TEXT'],
    // lower(trim(issue title)) — see the twin indexes below.
    ['title_key', 'TEXT'],
    // A book spread over several files: each file is a row on the same issue,
    // numbered from 1 in play order (NULL = a single-file book). Each local
    // file's own length and chapter marks, read from its headers, and the
    // mtime they were read at (so a rescan re-reads only a changed file).
    ['part', 'INTEGER'], ['file_duration', 'REAL'], ['embedded_chapters', 'TEXT'], ['probed_mtime', 'INTEGER'],
  ]) {
    if (!abCols.includes(col)) db.exec(`ALTER TABLE audiobooks_files ADD COLUMN ${col} ${decl}`);
  }
  // The duplicate-twin lookups (remotesync) match remote entries by title.
  // Comparing issue titles across a join was a whole-table scan per lookup:
  // on a 244k-title remote catalog one lookup took minutes of blocked main
  // thread, and a sync that found a few new books took the server down. The
  // normalised title now lives on the row (filled lazily for rows from before
  // this column existed), under an index the lookups probe instead.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_abfiles_twin ON audiobooks_files (source, library_id, title_key);
    CREATE INDEX IF NOT EXISTS idx_abfiles_unavailable ON audiobooks_files (source, unavailable_at);
    CREATE INDEX IF NOT EXISTS idx_abfiles_part ON audiobooks_files (issue_id, part);
  `);
  // "Already on the shelf?" runs for every result of a catalog search. It was
  // two scans per result (match id, an issue-title LIKE). Each now probes an
  // index — the title one on title_key, which local books now carry too
  // (remote rows always did; the twin lookups only ever compare rows of one
  // source, so local keys never meet them).
  // Rows without a key (written before this, or by an older version since) get
  // one on open: a table scan the first time, then a probe of the new index.
  const keyIndexed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_abfiles_titlekey'").get();
  const fillTitleKeys = () => {
    try {
      db.prepare(`UPDATE audiobooks_files
        SET title_key = (SELECT lower(trim(i.title)) FROM issues i WHERE i.id = audiobooks_files.issue_id)
        WHERE title_key IS NULL AND issue_id IS NOT NULL`).run();
    } catch { /* no core issues table yet — so no rows to fill */ }
  };
  if (!keyIndexed) fillTitleKeys();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_abfiles_titlekey ON audiobooks_files (title_key);
    CREATE INDEX IF NOT EXISTS idx_abfiles_match ON audiobooks_files (match_id);
  `);
  if (keyIndexed) fillTitleKeys();
  /** Fill title_key for a source's rows that predate the column (or lost it). */
  const ensureTitleKeys = (source) => {
    db.prepare(`UPDATE audiobooks_files
      SET title_key = (SELECT lower(trim(i.title)) FROM issues i WHERE i.id = audiobooks_files.issue_id)
      WHERE source = ? AND title_key IS NULL`).run(source);
  };
  // Sync bookkeeping beyond the page cursor: when the last run finished, and
  // whether a full walk has ever completed (after which runs are incremental).
  const rsCols = db.prepare("SELECT name FROM pragma_table_info('audiobooks_remote_sync')").all().map((r) => r.name);
  for (const [col, decl] of [['synced_at', 'TEXT'], ['complete', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!rsCols.includes(col)) db.exec(`ALTER TABLE audiobooks_remote_sync ADD COLUMN ${col} ${decl}`);
  }

  // Rows saved under the old 30-second rule that the current one counts as
  // finished (idempotent; a no-op once caught up).
  db.exec(`UPDATE audiobooks_progress AS p SET finished = 1 WHERE p.finished = 0 AND ${FINISHED_SQL('p')}`);

  /** Write a local file's audiobooks_files row (insert or refresh in place).
   *  title_key follows the issue title for local rows; a cached remote row
   *  keeps the source's title (its twin lookups compare that). */
  function upsertFileRow({ path: p, libraryId, seriesId, issueId, format, size, mtime, titleSource, part = null, probe = null }) {
    db.prepare(`INSERT INTO audiobooks_files
        (path, library_id, series_id, issue_id, format, size, mtime, title_source, added_at, part, file_duration, embedded_chapters, probed_mtime, title_key)
      VALUES (@path, @lib, @sid, @iid, @format, @size, @mtime, @title_source, @now, @part, @fdur, @echap, @pm,
        (SELECT lower(trim(title)) FROM issues WHERE id = @iid))
      ON CONFLICT(path) DO UPDATE SET
        title_key=CASE WHEN audiobooks_files.source IS NULL THEN excluded.title_key ELSE audiobooks_files.title_key END,
        library_id=excluded.library_id, series_id=excluded.series_id, issue_id=excluded.issue_id,
        format=excluded.format, size=excluded.size, mtime=excluded.mtime,
        title_source=excluded.title_source, part=excluded.part,
        file_duration=COALESCE(excluded.file_duration, CASE WHEN excluded.probed_mtime IS NULL THEN file_duration END),
        embedded_chapters=CASE WHEN excluded.probed_mtime IS NULL THEN embedded_chapters ELSE excluded.embedded_chapters END,
        probed_mtime=COALESCE(excluded.probed_mtime, probed_mtime)`)
      .run({
        path: p, lib: libraryId, sid: seriesId, iid: issueId, format,
        size: size ?? null, mtime: mtime ?? null, title_source: titleSource || null, now: nownow(), part,
        fdur: probe?.duration ?? null, echap: probe?.chapters ? JSON.stringify(probe.chapters) : null,
        pm: probe ? (mtime ?? 0) : null,
      });
  }
  const seriesByUrl = (url) => db.prepare('SELECT * FROM series WHERE url=?').get(url);
  const isStandalone = (seriesRow) => /^audiobook:l\d+:b:/.test(String(seriesRow?.url || ''));
  const authorsOf = (seriesRow) => String(seriesRow?.publisher || '').split(',').map((a) => a.trim()).filter(Boolean);
  // The book's first (or only) file row.
  const fileByIssue = (issueId) => db.prepare('SELECT * FROM audiobooks_files WHERE issue_id=? ORDER BY COALESCE(part, 1) LIMIT 1').get(issueId);
  /** Every file of a book, in play order. */
  const partsOf = (issueId) => db.prepare('SELECT * FROM audiobooks_files WHERE issue_id=? ORDER BY COALESCE(part, 1), path').all(issueId);
  const parseJson = (s) => { try { const v = s ? JSON.parse(s) : null; return Array.isArray(v) ? v : null; } catch { return null; } };
  /** A local book as one timeline: its total length, its chapters in book
   *  time, and where each part starts. Embedded chapter marks win; a part
   *  without any becomes one chapter of its own ({ title: null, part }, which
   *  the player names "Part n"). Remote or unprobed books fall back to the
   *  stored duration and chapters. */
  function bookTimeline(issueId) {
    const rows = partsOf(issueId);
    if (!rows.length) return null;
    if (rows.length === 1) {
      const r = rows[0];
      return {
        duration: r.file_duration ?? r.duration ?? null,
        chapters: parseJson(r.embedded_chapters) || parseJson(r.chapters) || [],
        parts: [],
      };
    }
    let t = 0;
    const parts = [], chapters = [];
    rows.forEach((r, i) => {
      const n = r.part || i + 1;
      const len = r.file_duration || 0;
      parts.push({ part: n, start: t, duration: len || null, name: path.basename(r.path || '', path.extname(r.path || '')) });
      const own = parseJson(r.embedded_chapters);
      if (own && own.length) for (const c of own) chapters.push({ title: c.title || null, start: t + (Number(c.start) || 0) });
      else chapters.push({ title: null, start: t, part: n });
      t += len;
    });
    return { duration: t || rows[0].duration || null, chapters, parts };
  }
  /** Move what users kept on an issue that no longer stands for a book (a
   *  file's own entry, before its folder became one multi-part book) onto the
   *  book: progress and bookmarks shift by where that file starts in it. The
   *  old issue goes once no file row points at it. */
  function retireIssue(oldId, newId, offset = 0, total = 0) {
    if (!oldId || oldId === newId) return;
    if (db.prepare('SELECT 1 x FROM audiobooks_files WHERE issue_id=? LIMIT 1').get(oldId)) return;
    for (const p of db.prepare('SELECT user_id, position, updated_at FROM audiobooks_progress WHERE issue_id=? AND position > 0').all(oldId)) {
      const pos = offset + p.position;
      db.prepare(`INSERT INTO audiobooks_progress (user_id, issue_id, position, duration, finished, updated_at)
          VALUES (@u, @i, @p, @d, 0, @at)
        ON CONFLICT(user_id, issue_id) DO UPDATE SET
          position = MAX(position, excluded.position), duration = MAX(duration, excluded.duration),
          updated_at = MAX(COALESCE(updated_at, ''), COALESCE(excluded.updated_at, ''))`)
        .run({ u: p.user_id, i: newId, p: pos, d: total || 0, at: p.updated_at || nownow() });
    }
    db.prepare('UPDATE audiobooks_bookmarks SET issue_id=?, position=position+? WHERE issue_id=?').run(newId, offset, oldId);
    db.prepare('DELETE FROM audiobooks_progress WHERE issue_id=?').run(oldId);
    const old = db.prepare('SELECT series_id FROM issues WHERE id=?').get(oldId);
    db.prepare("DELETE FROM issues WHERE id=? AND url LIKE 'audiobook%'").run(oldId);
    if (old) db.prepare(`DELETE FROM series WHERE id=? AND url LIKE 'audiobook:%' AND NOT EXISTS (SELECT 1 FROM issues WHERE series_id=?)`).run(old.series_id, old.series_id);
  }

  const api = {
    db,

    /** Per-user visibility of each audiobook home rail. Both rails default on;
     *  setHomePrefs takes a partial and merges (mirrors the reader plugin). */
    homePrefs(userId) {
      const r = db.prepare('SELECT * FROM audiobooks_home_prefs WHERE user_id=?').get(userId);
      return {
        showContinue: r ? !!r.show_continue : true,
        showNew: r ? !!r.show_new : true,
      };
    },
    setHomePrefs(userId, partial) {
      const m = { ...this.homePrefs(userId), ...(partial || {}) };
      db.prepare(`
        INSERT INTO audiobooks_home_prefs (user_id, show_continue, show_new)
          VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          show_continue = excluded.show_continue,
          show_new      = excluded.show_new
      `).run(userId, m.showContinue ? 1 : 0, m.showNew ? 1 : 0);
      return this.homePrefs(userId);
    },

    /** Catalog a file-less remote audiobook: a self-described `audiobook` series
     *  with one issue, plus the audiobooks_files row carrying the stream identity
     *  (source, remote_id) and audio metadata. Idempotent by (source, remote_id);
     *  `restricted` follows the source's `explicit` flag. Returns ids + created. */
    catalogRemote({ libraryId, source, remoteId, meta = {} }) {
      const title = meta.title || 'Untitled';
      const author = meta.author || (meta.authors || []).join(', ') || null;
      const standalone = !meta.series;
      const url = seriesUrlFor(libraryId, meta.series ? { series: meta.series } : { title, author });
      const issueUrl = `audiobookremote:${source}:${remoteId}`;
      const year = year4(meta.year);
      const restricted = meta.explicit ? 1 : 0;
      const tx = db.transaction(() => {
        const prev = db.prepare(`SELECT ef.rowid AS ab_rowid, ef.issue_id, i.series_id AS prev_series_id
          FROM audiobooks_files ef LEFT JOIN issues i ON i.id = ef.issue_id
          WHERE ef.source=? AND ef.remote_id=?`).get(source, String(remoteId));
        const created = !prev;
        db.prepare(`INSERT INTO series (title, url, publisher, type, library_id, description, year, restricted)
          VALUES (@title, @url, @publisher, 'audiobook', @lib, @description, @year, @restricted)
          ON CONFLICT(url) DO UPDATE SET
            title=excluded.title,
            publisher=COALESCE(excluded.publisher, series.publisher),
            type='audiobook', library_id=excluded.library_id,
            description=COALESCE(excluded.description, series.description),
            year=COALESCE(excluded.year, series.year),
            restricted=excluded.restricted`)
          .run({ title: standalone ? title : meta.series, url, publisher: author, lib: libraryId,
            description: standalone ? (meta.description || null) : null, year: standalone ? year : null, restricted });
        const seriesId = seriesByUrl(url).id;
        db.prepare(`INSERT INTO issues (series_id, title, issue_number, url, status, file_path)
          VALUES (?, ?, ?, ?, 'done', NULL)
          ON CONFLICT(url) DO UPDATE SET series_id=excluded.series_id, title=excluded.title, issue_number=excluded.issue_number, status='done'`)
          .run(seriesId, title, standalone ? '1' : indexNumber(meta.series_index), issueUrl);
        const issueId = db.prepare('SELECT id FROM issues WHERE url=?').get(issueUrl).id;
        // Point the series cover at this issue's cover route (which redirects to
        // the source thumbnail) — the Library grid and the player both read
        // series.cover_url. Set it whenever the source provided a cover.
        if (meta.coverUrl) db.prepare('UPDATE series SET cover_url=? WHERE id=?').run(`/api/audiobooks/issue/${issueId}/cover`, seriesId);
        // If a re-sync moved this book to a different series (its title, hence its
        // derived url, changed), prune the vacated series when it's left empty.
        if (prev?.prev_series_id && prev.prev_series_id !== seriesId) {
          const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(prev.prev_series_id).n;
          if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'audiobook:%'").run(prev.prev_series_id);
        }
        // The plugin row — keyed by (source, remote_id). A re-sync refreshes
        // metadata but never clobbers a cached path/size a materialize recorded.
        if (prev) {
          db.prepare(`UPDATE audiobooks_files SET library_id=@lib, series_id=@sid, issue_id=@iid,
              format=@format, duration=@duration, narrators=@narrators, chapters=@chapters,
              thumbnail=@thumb, explicit=@explicit, title_key=lower(trim(@title)) WHERE rowid=@rowid`)
            .run({ rowid: prev.ab_rowid, lib: libraryId, sid: seriesId, iid: issueId, title,
              format: (meta.format || 'm4b'), duration: meta.duration ?? null,
              narrators: (meta.narrators || []).join(', ') || null,
              chapters: meta.chapters ? JSON.stringify(meta.chapters) : null,
              thumb: meta.coverUrl || null, explicit: restricted });
        } else {
          db.prepare(`INSERT INTO audiobooks_files
              (path, library_id, series_id, issue_id, format, size, duration, narrators, chapters, thumbnail, explicit, source, remote_id, added_at, title_key)
              VALUES (NULL, @lib, @sid, @iid, @format, @size, @duration, @narrators, @chapters, @thumb, @explicit, @source, @remote, @now, lower(trim(@title)))`)
            .run({ lib: libraryId, sid: seriesId, iid: issueId, format: (meta.format || 'm4b'), title,
              size: meta.size ?? null, duration: meta.duration ?? null,
              narrators: (meta.narrators || []).join(', ') || null,
              chapters: meta.chapters ? JSON.stringify(meta.chapters) : null,
              thumb: meta.coverUrl || null, explicit: restricted, source, remote: String(remoteId), now: nownow() });
        }
        return { seriesId, issueId, created };
      });
      return tx();
    },

    /** Catalog one scanned LOCAL audiobook file: a self-described `audiobook`
     *  series (standalone by title~author, or grouped when the folder layout
     *  names a series) with one issue, the shared library_files row, and the
     *  audiobooks_files row carrying path/mtime/format. `source` stays NULL (a
     *  local file). A filename-derived title is flagged title_source so the
     *  metadata match may upgrade it; identity is sticky per path so a re-parse
     *  renames the standalone series in place rather than spawning a duplicate. */
    catalogFile({ libraryId, path: p, format, size, mtime, meta = {}, issueKey = null, part = null, probe = null }) {
      const iurl = issueKey || issueUrlFor(p);
      const author = meta.author || null;
      const standalone = !meta.series;
      const title = meta.title || 'Untitled';
      const url = seriesUrlFor(libraryId, meta);
      const tx = db.transaction(() => {
        const prev = db.prepare(`SELECT ef.rowid AS ab_rowid, ef.issue_id, ef.match_id,
            i.series_id AS prev_series_id, i.title AS prev_title, i.issue_number AS prev_number
          FROM audiobooks_files ef LEFT JOIN issues i ON i.id = ef.issue_id WHERE ef.path=?`).get(p);
        const prevSeries = prev?.prev_series_id
          ? db.prepare('SELECT * FROM series WHERE id=?').get(prev.prev_series_id) : null;
        // A match-upgraded title survives a re-parse that still has only the
        // filename to offer (strictly worse data).
        const keepTitle = !!(prev?.match_id && meta.title_source === 'filename' && prev.prev_title);
        const issueTitle = keepTitle ? prev.prev_title : title;
        // The metadata match may have grouped this book into a series (a folder
        // with no series name of its own). Keep it there across rescans instead of
        // demoting it back to a standalone shelf.
        const matchGrouped = !!(prev?.match_id && prevSeries && !isStandalone(prevSeries) && standalone);
        const issueNum = matchGrouped ? (prev.prev_number || '1') : (standalone ? '1' : indexNumber(meta.series_index));
        let seriesId;
        if (matchGrouped) {
          seriesId = prevSeries.id;
        } else if (prevSeries && standalone && isStandalone(prevSeries) && String(prevSeries.url).startsWith(`audiobook:l${libraryId}:`)) {
          db.prepare("UPDATE series SET title=?, publisher=COALESCE(?, publisher), type='audiobook', library_id=? WHERE id=?")
            .run(issueTitle, author, libraryId, prevSeries.id);
          seriesId = prevSeries.id;
        } else {
          db.prepare(`INSERT INTO series (title, url, publisher, type, library_id)
            VALUES (@title, @url, @publisher, 'audiobook', @lib)
            ON CONFLICT(url) DO UPDATE SET
              title=excluded.title,
              publisher=COALESCE(excluded.publisher, series.publisher),
              type='audiobook', library_id=excluded.library_id`)
            .run({ title: standalone ? issueTitle : meta.series, url, publisher: author, lib: libraryId });
          seriesId = seriesByUrl(url).id;
        }
        db.prepare(`INSERT INTO issues (series_id, title, issue_number, url, status, file_path)
          VALUES (?, ?, ?, ?, 'done', ?)
          ON CONFLICT(url) DO UPDATE SET series_id=excluded.series_id, title=excluded.title,
            issue_number=excluded.issue_number, status='done', file_path=excluded.file_path`)
          .run(seriesId, issueTitle, issueNum, iurl, p);
        const issueId = db.prepare('SELECT id FROM issues WHERE url=?').get(iurl).id;
        // A regroup left the old series behind — prune it if now empty.
        if (prevSeries && prevSeries.id !== seriesId) {
          const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(prevSeries.id).n;
          if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'audiobook:%'").run(prevSeries.id);
        }
        // The shared file index — has_metadata=1 (ComicInfo tagging doesn't apply
        // to audiobooks, so they must never look "untagged").
        upsertLibraryFile(db, {
          path: p, dir: path.dirname(p), name: path.basename(p), size, mtime,
          page_count: null, has_metadata: 1, valid: 1, error: null, verified: 0,
        });
        linkLibraryFile(db, p, seriesId, issueId);
        upsertFileRow({ path: p, libraryId, seriesId, issueId, format, size, mtime, titleSource: meta.title_source, part, probe });
        // The file used to be its own book (or part of another): carry what
        // users kept on that entry over, and drop it.
        if (prev?.issue_id && prev.issue_id !== issueId) retireIssue(prev.issue_id, issueId);
        return { seriesId, issueId };
      });
      return tx();
    },

    /** Catalog a book that spans several local files (one folder, files in
     *  play order) as ONE issue with numbered parts. Each file's earlier entry
     *  (from before it was grouped) hands its progress and bookmarks over at
     *  that part's place in the book. files = [{ path, size, mtime, probe }]. */
    catalogBook({ libraryId, files, meta = {} }) {
      if (!files.length) return null;
      const key = 'audiobookdir:' + path.dirname(files[0].path);
      const tx = db.transaction(() => {
        const prevIds = files.map((f) => db.prepare('SELECT issue_id FROM audiobooks_files WHERE path=?').get(f.path)?.issue_id ?? null);
        const first = files[0];
        const { seriesId, issueId } = api.catalogFile({ libraryId, path: first.path, format: first.format, size: first.size, mtime: first.mtime, meta, issueKey: key, part: 1, probe: first.probe });
        files.slice(1).forEach((f, i) => {
          upsertLibraryFile(db, {
            path: f.path, dir: path.dirname(f.path), name: path.basename(f.path), size: f.size, mtime: f.mtime,
            page_count: null, has_metadata: 1, valid: 1, error: null, verified: 0,
          });
          linkLibraryFile(db, f.path, seriesId, issueId);
          upsertFileRow({ path: f.path, libraryId, seriesId, issueId, format: f.format, size: f.size, mtime: f.mtime, titleSource: meta.title_source, part: i + 2, probe: f.probe });
        });
        // Rows of this book whose file is no longer in the folder's set.
        const keep = new Set(files.map((f) => f.path));
        for (const r of partsOf(issueId)) {
          if (r.path && !keep.has(r.path)) { deleteLibraryFile(db, r.path); db.prepare('DELETE FROM audiobooks_files WHERE path=?').run(r.path); }
        }
        const tl = bookTimeline(issueId);
        files.forEach((f, i) => retireIssue(prevIds[i], issueId, tl?.parts[i]?.start || 0, tl?.duration || 0));
        return { seriesId, issueId };
      });
      return tx();
    },
    partsOf,
    bookTimeline,

    /** path → { path, mtime, size, issue_id, source } for one library — the
     *  incremental-scan skip index. Remote entries (path NULL) key to `null` and
     *  never collide with a real path. */
    pathIndex(libraryId) {
      const rows = db.prepare('SELECT path, mtime, size, issue_id, source, part, probed_mtime FROM audiobooks_files WHERE library_id=?').all(libraryId);
      return new Map(rows.map((r) => [r.path, r]));
    },
    /** Are this file's catalog rows still in place? A local file needs its
     *  library_files row too; a materialized remote entry (source set) is intact
     *  as long as its issue survives, so the disk scanner never re-catalogs it. */
    issueIntact(row) {
      if (!row?.issue_id) return false;
      if (!db.prepare('SELECT 1 x FROM issues WHERE id=?').get(row.issue_id)) return false;
      if (row.source) return true;
      return !!getLibraryFile(db, row.path);
    },
    /** Prune a library's LOCAL rows whose file vanished (library_files + issue +
     *  progress + bookmarks + plugin row together, and an emptied series). Remote
     *  entries (source set) are never disk files, so they're left alone. */
    removeMissing(libraryId, keep) {
      const gone = db.prepare('SELECT path, issue_id, series_id, source FROM audiobooks_files WHERE library_id=?').all(libraryId)
        .filter((r) => !r.source && !keep.has(r.path));
      const seriesTouched = new Set();
      const tx = db.transaction(() => {
        for (const r of gone) {
          deleteLibraryFile(db, r.path);
          db.prepare('DELETE FROM audiobooks_files WHERE path=?').run(r.path);
          // One missing part of a multi-part book doesn't take the book with it.
          const left = r.issue_id != null && db.prepare('SELECT 1 x FROM audiobooks_files WHERE issue_id=? LIMIT 1').get(r.issue_id);
          if (r.issue_id != null && !left) {
            db.prepare('DELETE FROM audiobooks_progress WHERE issue_id=?').run(r.issue_id);
            db.prepare('DELETE FROM audiobooks_bookmarks WHERE issue_id=?').run(r.issue_id);
            db.prepare('DELETE FROM issues WHERE id=?').run(r.issue_id);
          }
          if (r.series_id != null) seriesTouched.add(r.series_id);
        }
        for (const sid of seriesTouched) {
          const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(sid).n;
          if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'audiobook:%'").run(sid);
        }
      });
      tx();
      return gone.length;
    },

    /** Local audiobooks never attempted against the metadata service, in matcher
     *  shape. Remote entries (source set) carry their source's metadata already,
     *  so they're excluded — re-matching them would hammer the service. */
    unmatched(limit = 200) {
      const rows = db.prepare(`SELECT ef.issue_id, ef.title_source, i.title, i.series_id AS core_series_id
        FROM audiobooks_files ef JOIN issues i ON i.id = ef.issue_id
        WHERE ef.match_id IS NULL AND ef.match_checked_at IS NULL AND ef.source IS NULL
        ORDER BY ef.issue_id LIMIT ?`).all(limit);
      return rows.map((r) => {
        const s = db.prepare('SELECT * FROM series WHERE id=?').get(r.core_series_id);
        return {
          id: r.issue_id, title: r.title, title_source: r.title_source,
          authors: authorsOf(s),
          description: isStandalone(s) ? (s?.description || null) : null,
        };
      });
    },
    /** Fold an accepted metadata match into the catalog: a filename-derived title
     *  upgrades (issue + standalone series title), author/description/year fill
     *  in, and audio fields (narrators, duration, chapters, cover, mature flag)
     *  land on the plugin row — the match identity recorded so scans don't re-ask. */
    applyMatch(issueId, merged) {
      const row = fileByIssue(issueId);
      if (!row) return;
      let series = db.prepare('SELECT * FROM series WHERE id=?').get(row.series_id);
      if (!series) return;
      const tx = db.transaction(() => {
        // Series grouping: when the match names a series (Audnexus seriesPrimary)
        // and this audiobook is a standalone, move its issue onto a shared series
        // row (creating it if needed), ordered by the book's position, and prune
        // the vacated standalone — the audio analogue of the ebooks calibre-series
        // grouping, so e.g. all Harry Potter audiobooks share one shelf.
        if (merged.series && isStandalone(series)) {
          const libId = series.library_id;
          const byline = (Array.isArray(merged.authors) && merged.authors.length) ? merged.authors.join(', ') : (series.publisher || null);
          const surl = seriesUrlFor(libId, { series: merged.series });
          db.prepare(`INSERT INTO series (title, url, publisher, type, library_id, restricted)
              VALUES (@title, @url, @publisher, 'audiobook', @lib, @restricted)
              ON CONFLICT(url) DO UPDATE SET type='audiobook', library_id=excluded.library_id,
                publisher=COALESCE(series.publisher, excluded.publisher)`)
            .run({ title: merged.series, url: surl, publisher: byline, lib: libId, restricted: merged.explicit ? 1 : 0 });
          const target = seriesByUrl(surl);
          if (target && target.id !== series.id) {
            const oldId = series.id;
            db.prepare('UPDATE issues SET series_id=?, issue_number=? WHERE id=?').run(target.id, indexNumber(merged.series_index), issueId);
            db.prepare('UPDATE audiobooks_files SET series_id=? WHERE issue_id=?').run(target.id, issueId);
            const left = db.prepare('SELECT COUNT(*) n FROM issues WHERE series_id=?').get(oldId).n;
            if (!left) db.prepare("DELETE FROM series WHERE id=? AND url LIKE 'audiobook:l%'").run(oldId);
            series = target; // all further updates target the grouped row
          }
        }
        const standalone = isStandalone(series);
        if (merged.title) {
          db.prepare('UPDATE issues SET title=? WHERE id=?').run(merged.title, issueId);
          db.prepare('UPDATE audiobooks_files SET title_key=lower(trim(?)) WHERE issue_id=? AND source IS NULL').run(merged.title, issueId);
          if (standalone) db.prepare('UPDATE series SET title=? WHERE id=?').run(merged.title, series.id);
        }
        if (Array.isArray(merged.authors) && merged.authors.length && !series.publisher) {
          db.prepare('UPDATE series SET publisher=? WHERE id=?').run(merged.authors.join(', '), series.id);
        }
        if (standalone && String(merged.description || '').length > String(series.description || '').length) {
          db.prepare('UPDATE series SET description=? WHERE id=?').run(merged.description, series.id);
        }
        if (merged.published_date && standalone && !series.year) {
          const y = year4(merged.published_date);
          if (y) db.prepare('UPDATE series SET year=? WHERE id=?').run(y, series.id);
        }
        if (merged.explicit != null) db.prepare('UPDATE series SET restricted=? WHERE id=?').run(merged.explicit ? 1 : 0, series.id);
        db.prepare(`UPDATE audiobooks_files SET
            match_id=@match_id, match_confidence=@match_confidence,
            duration=COALESCE(@duration, duration),
            narrators=COALESCE(@narrators, narrators),
            chapters=COALESCE(@chapters, chapters),
            thumbnail=COALESCE(@thumbnail, thumbnail),
            explicit=@explicit, match_checked_at=@now
          WHERE issue_id=@iid`)
          .run({
            iid: issueId, match_id: merged.match_id ?? null, match_confidence: merged.match_confidence ?? null,
            duration: merged.duration ?? null,
            narrators: (merged.narrators && merged.narrators.length) ? merged.narrators.join(', ') : null,
            chapters: merged.chapters ? JSON.stringify(merged.chapters) : null,
            thumbnail: merged.thumbnail ?? null, explicit: merged.explicit ? 1 : 0, now: nownow(),
          });
        // A cover-less book adopts the service thumbnail via the cover route; the
        // series cover fills in from it when still blank.
        if (merged.thumbnail && !series.cover_url) {
          db.prepare('UPDATE series SET cover_url=? WHERE id=?').run(`/api/audiobooks/issue/${issueId}/cover`, series.id);
        }
      });
      tx();
    },
    setMatchChecked(issueId) {
      db.prepare('UPDATE audiobooks_files SET match_checked_at=? WHERE issue_id=?').run(nownow(), issueId);
    },

    /** Record a cached-to-disk file for a previously file-less entry. */
    materializedPath(issueId, filePath, size) {
      const row = fileByIssue(issueId);
      if (!row) return;
      db.prepare('UPDATE audiobooks_files SET path=?, size=COALESCE(?, size) WHERE issue_id=?').run(filePath, size ?? null, issueId);
      try { upsertLibraryFile(db, { series_id: row.series_id, issue_id: issueId, path: filePath, name: filePath.split(/[\\/]/).pop(), valid: 1, size: size ?? null }); } catch { /* library_files optional */ }
    },

    fileByIssue,

    /** Cover for an issue: the remote thumbnail proxy (nothing embedded here). */
    cover(issueId) {
      const r = fileByIssue(issueId);
      return r && r.thumbnail ? { thumbnail: r.thumbnail } : null;
    },

    /** Per-issue playback info for the client (scoped to the given issue ids). */
    audiobookInfoMap(issueIds) {
      const roundSecs = (s) => (s == null || !Number.isFinite(Number(s)) ? null : Math.round(Number(s)));
      const out = {};
      const ids = (issueIds || []).map(Number).filter(Boolean);
      if (!ids.length) return out;
      const q = db.prepare(`SELECT issue_id, format, duration, narrators, source, path, unavailable_at, unavailable_reason FROM audiobooks_files
        WHERE issue_id IN (${ids.map(() => '?').join(',')})`);
      for (const r of q.all(...ids)) {
        if (out[r.issue_id]) continue; // a multi-part book: one entry, from its timeline
        const local = r.path && !r.source;
        const tl = local ? bookTimeline(r.issue_id) : null;
        out[r.issue_id] = {
          // Whole seconds: the mobile apps read the length as an integer.
          format: r.format, duration: roundSecs(tl?.duration ?? r.duration), narrators: r.narrators,
          remote: !!r.source && !r.path, audiobook: true,
          unavailable: !!r.unavailable_at, unavailableReason: r.unavailable_reason || null,
          ...(tl && tl.parts.length > 1 ? { parts: tl.parts.map(({ part, start, duration }) => ({ part, start, duration })) } : {}),
        };
      }
      return out;
    },

    // ---- per-user progress ----
    /** "Remove from Continue listening": every part of this series goes back
     *  to not started for this user. */
    resetSeriesProgress(userId, seriesId) {
      return db.prepare(`UPDATE audiobooks_progress SET position=0, finished=0, updated_at=?
        WHERE user_id=? AND issue_id IN (SELECT id FROM issues WHERE series_id=?)`)
        .run(nownow(), userId || 0, seriesId).changes;
    },
    getProgress(userId, issueId) {
      return db.prepare('SELECT position, duration, finished FROM audiobooks_progress WHERE user_id=? AND issue_id=?')
        .get(userId || 0, issueId) || { position: 0, duration: 0, finished: 0 };
    },
    setProgress(userId, issueId, { position = 0, duration = 0 }) {
      const finished = isFinished(position, duration) ? 1 : 0;
      db.prepare(`INSERT INTO audiobooks_progress (user_id, issue_id, position, duration, finished, updated_at)
        VALUES (@u, @i, @p, @d, @f, @now)
        ON CONFLICT(user_id, issue_id) DO UPDATE SET position=@p, duration=@d, finished=@f, updated_at=@now`)
        .run({ u: userId || 0, i: issueId, p: position, d: duration, f: finished, now: nownow() });
      return { position, duration, finished };
    },

    // ---- bookmarks ----
    listBookmarks(userId, issueId) {
      return db.prepare('SELECT id, position, note, created_at FROM audiobooks_bookmarks WHERE user_id=? AND issue_id=? ORDER BY position')
        .all(userId || 0, issueId);
    },
    addBookmark(userId, issueId, position, note) {
      const info = db.prepare('INSERT INTO audiobooks_bookmarks (user_id, issue_id, position, note, created_at) VALUES (?,?,?,?,?)')
        .run(userId || 0, issueId, Number(position) || 0, note || null, nownow());
      return { id: info.lastInsertRowid };
    },
    deleteBookmark(userId, id) {
      db.prepare('DELETE FROM audiobooks_bookmarks WHERE id=? AND user_id=?').run(id, userId || 0);
    },

    // ---- per-user listening stats ----
    stats(userId) {
      const r = db.prepare(`SELECT COUNT(*) titles, COALESCE(SUM(position),0) seconds,
          SUM(CASE WHEN finished=1 THEN 1 ELSE 0 END) finished
        FROM audiobooks_progress WHERE user_id=? AND position > 0`).get(userId || 0);
      return { titles: r.titles || 0, seconds: Math.round(r.seconds || 0), finished: r.finished || 0 };
    },

    // ---- remote sync cursor ----
    remoteCursor(source) {
      const r = db.prepare('SELECT cursor_page FROM audiobooks_remote_sync WHERE source=?').get(source);
      return r ? r.cursor_page : 1;
    },
    /** Everything the sync needs to pick a mode: the page cursor, whether a
     *  full walk has completed, and when the last run finished. `since` is the
     *  point an incremental run should ask the source for: the last finish,
     *  or — for a DB from before this bookkeeping existed — the cursor's last
     *  touch with a generous margin, so nothing in between is missed. */
    remoteSyncInfo(source) {
      const r = db.prepare('SELECT cursor_page, total, updated_at, synced_at, complete FROM audiobooks_remote_sync WHERE source=?').get(source);
      if (!r) return { cursor_page: 1, total: null, complete: false, synced_at: null, since: null };
      const since = r.synced_at
        ? new Date(Date.parse(r.synced_at) - 24 * 3600 * 1000).toISOString()
        : (r.updated_at ? new Date(Date.parse(r.updated_at) - 90 * 24 * 3600 * 1000).toISOString() : null);
      return { cursor_page: r.cursor_page, total: r.total, complete: !!r.complete, synced_at: r.synced_at || null, since };
    },
    setRemoteCursor(source, page, total) {
      db.prepare(`INSERT INTO audiobooks_remote_sync (source, cursor_page, total, updated_at)
        VALUES (@s, @p, @t, @now)
        ON CONFLICT(source) DO UPDATE SET cursor_page=@p, total=COALESCE(@t, audiobooks_remote_sync.total), updated_at=@now`)
        .run({ s: source, p: page, t: total ?? null, now: nownow() });
    },
    /** A run finished cleanly (full walk or incremental): remember when, and
     *  that the source is fully walked from here on. */
    markRemoteSynced(source, { at = null, complete = true, total = null } = {}) {
      db.prepare(`INSERT INTO audiobooks_remote_sync (source, cursor_page, total, updated_at, synced_at, complete)
        VALUES (@s, 1, @t, @now, @at, @c)
        ON CONFLICT(source) DO UPDATE SET synced_at=@at, complete=@c, total=COALESCE(@t, audiobooks_remote_sync.total), updated_at=@now`)
        .run({ s: source, t: total ?? null, now: nownow(), at: at || nownow(), c: complete ? 1 : 0 });
    },
    /** The source could not serve this title (file gone upstream). */
    /** Drop every file-less entry a remote source put on the shelf — the
     *  source was removed, or the shelf is being reset — with their issues,
     *  the series left empty, and the source's sync cursor, so a later
     *  re-enable starts from scratch. → { entries, series, kept } */
    removeRemoteSource(source) {
      const src = String(source || '');
      if (!src) return { entries: 0, series: 0, kept: 0 };
      return db.transaction(() => {
        db.exec('CREATE TEMP TABLE IF NOT EXISTS gone_issues (id INTEGER PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS gone_series (id INTEGER PRIMARY KEY); DELETE FROM gone_issues; DELETE FROM gone_series');
        db.prepare('INSERT OR IGNORE INTO gone_issues SELECT issue_id FROM audiobooks_files WHERE source=? AND path IS NULL AND issue_id IS NOT NULL').run(src);
        db.prepare("INSERT OR IGNORE INTO gone_series SELECT series_id FROM issues WHERE id IN (SELECT id FROM gone_issues) AND url LIKE 'audiobookremote:%'").run();
        const entries = db.prepare('DELETE FROM audiobooks_files WHERE source=? AND path IS NULL').run(src).changes;
        db.prepare("DELETE FROM issues WHERE id IN (SELECT id FROM gone_issues) AND url LIKE 'audiobookremote:%'").run();
        const series = db.prepare("DELETE FROM series WHERE id IN (SELECT id FROM gone_series) AND url LIKE 'audiobook:%' AND NOT EXISTS (SELECT 1 FROM issues WHERE issues.series_id = series.id)").run().changes;
        const kept = db.prepare('SELECT COUNT(*) n FROM audiobooks_files WHERE source=?').get(src).n;
        try { db.prepare('DELETE FROM audiobooks_remote_sync WHERE source=?').run(src); } catch { /* no cursor kept */ }
        db.exec('DROP TABLE gone_issues; DROP TABLE gone_series');
        return { entries, series, kept };
      })();
    },


    /** Is this catalog book on the shelf already? By its catalog id, its ISBN,
     *  or the same title with an author that does not contradict. → { issueId,
     *  seriesId } or null. */
    onShelf({ matchId = null, isbn = null, title = null, author = null } = {}) {
      const found = (issueId) => {
        const i = db.prepare('SELECT id, series_id FROM issues WHERE id=?').get(issueId);
        return i ? { issueId: i.id, seriesId: i.series_id } : null;
      };
      const byKey = matchId != null
        && db.prepare('SELECT issue_id FROM audiobooks_files WHERE match_id = ? AND issue_id IS NOT NULL LIMIT 1').get(String(matchId));
      if (byKey) { const f = found(byKey.issue_id); if (f) return f; }
      if (!title) return null;
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      // The same book is titled many ways — "Theo of Golden", "Theo of Golden:
      // A Novel", "Theo of Golden (English Edition)" — so titles are compared
      // by their key: the part before a subtitle, with bracketed notes dropped.
      const key = titleKey(title);
      if (!key) return null;
      // Candidates: books whose title starts with the key's first word — a
      // range on idx_abfiles_titlekey, walked until a real match (not just
      // the first 40 sharing a common first word, which could miss it).
      const first = key.split(' ')[0];
      const a = norm(author);
      const last = a.split(' ').pop();
      const candidates = db.prepare(`SELECT f.issue_id, i.title, s.publisher FROM audiobooks_files f
          JOIN issues i ON i.id = f.issue_id JOIN series s ON s.id = i.series_id
         WHERE f.title_key >= ? AND f.title_key < ? LIMIT 5000`).iterate(first, first + String.fromCodePoint(0x10ffff));
      for (const r of candidates) {
        if (titleKey(r.title) === key
          && (!a || !r.publisher || norm(r.publisher).includes(a) || a.includes(norm(r.publisher)) || (last && norm(r.publisher).includes(last)))) {
          candidates.return();
          return found(r.issue_id);
        }
      }
      return null;
    },

    /** Want a catalog book: one row per catalog id (asking again refreshes it). */
    addWanted(item, userId = 0) {
      const r = db.prepare(`INSERT INTO audiobooks_wanted (match_id, title, author, year, isbn, cover, added_by)
          VALUES (@match_id, @title, @author, @year, @isbn, @cover, @added_by)
          ON CONFLICT(match_id) DO UPDATE SET title=excluded.title, author=excluded.author, year=excluded.year, isbn=excluded.isbn, cover=excluded.cover`)
        .run({ match_id: String(item.id), title: item.title || 'Untitled', author: item.author || null, year: item.year || null, isbn: item.isbn || null, cover: item.cover || null, added_by: userId || 0 });
      return this.wantedByMatch(String(item.id)) || this.wantedById(r.lastInsertRowid);
    },
    wantedById(id) { return db.prepare('SELECT * FROM audiobooks_wanted WHERE id=?').get(Number(id)) || null; },
    wantedByMatch(matchId) { return db.prepare('SELECT * FROM audiobooks_wanted WHERE match_id=?').get(String(matchId)) || null; },
    listWanted() { return db.prepare('SELECT * FROM audiobooks_wanted ORDER BY id').all(); },
    removeWanted(id) { return db.prepare('DELETE FROM audiobooks_wanted WHERE id=?').run(Number(id)).changes; },
    noteWantedTry(id, error = null) {
      db.prepare(`UPDATE audiobooks_wanted SET tried_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), last_error=? WHERE id=?`).run(error, Number(id));
    },

    markUnavailable(issueId, reason = null) {
      db.prepare('UPDATE audiobooks_files SET unavailable_at=?, unavailable_reason=? WHERE issue_id=?').run(nownow(), reason ? String(reason).slice(0, 200) : null, issueId);
    },
    markAvailable(issueId) {
      db.prepare('UPDATE audiobooks_files SET unavailable_at=NULL, unavailable_reason=NULL WHERE issue_id=? AND unavailable_at IS NOT NULL').run(issueId);
    },

    /** Remove an audiobook entry (issue + plugin row + any library_file). */
    removeIssue(issueId) {
      const row = fileByIssue(issueId);
      if (row?.path) { try { deleteLibraryFile(db, row.path); } catch { /* none */ } }
      db.prepare('DELETE FROM audiobooks_files WHERE issue_id=?').run(issueId);
      // A file-less remote entry is nothing without its plugin row — and a
      // shelf it was the only book on is nothing without it.
      const issue = db.prepare("SELECT series_id FROM issues WHERE id=? AND url LIKE 'audiobookremote:%'").get(issueId);
      if (issue) {
        db.prepare('DELETE FROM issues WHERE id=?').run(issueId);
        db.prepare(`DELETE FROM series WHERE id=? AND url LIKE 'audiobook:%' AND NOT EXISTS (SELECT 1 FROM issues WHERE series_id=?)`).run(issue.series_id, issue.series_id);
      }
    },
    /** Other remote entries from the same source and library that are the
     *  same book (same title) — the way a re-import shows up next to a record
     *  whose file has since gone. Matched across series on purpose: the old
     *  record often sat alone on its own shelf (no series info at the time)
     *  while the new one joined the series. */
    duplicateRemoteEntries(source, remoteId) {
      ensureTitleKeys(source);
      // CROSS JOIN pins f1 (one row, by its remote identity) as the outer
      // loop, and `+f2.path` keeps the planner off the path primary key —
      // every remote row has a NULL path, so that "unique" index is the
      // whole table. f2 is then a probe of idx_abfiles_twin.
      return db.prepare(`SELECT f2.issue_id, f2.remote_id
        FROM audiobooks_files f1
        CROSS JOIN audiobooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
          AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL
        WHERE f1.source = ? AND f1.remote_id = ? AND f1.title_key IS NOT NULL`).all(source, String(remoteId));
    },
    /** Entries already known to be unavailable that have a same-titled twin
     *  which is not — candidates for the end-of-sync sweep. */
    unavailableWithTwin(source) {
      ensureTitleKeys(source);
      return db.prepare(`SELECT DISTINCT f1.issue_id, f1.remote_id, f2.issue_id AS twin_issue_id, f2.remote_id AS twin_remote_id
        FROM audiobooks_files f1
        CROSS JOIN audiobooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
          AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL AND +f2.unavailable_at IS NULL
        WHERE f1.source = ? AND +f1.path IS NULL AND f1.unavailable_at IS NOT NULL AND f1.title_key IS NOT NULL`).all(source);
    },
  };
  return api;
}
