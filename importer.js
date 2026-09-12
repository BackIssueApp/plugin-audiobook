// Media handler: an audiobook a download source fetched (for an approved
// request, say) is moved into an Audiobooks library and catalogued like a
// scanned one. The library layout the scanner reads is Author/Title.ext for a
// single file and Author/Title/<parts> for a multi-file book, so that is what
// is written — named from the asker's hint (the catalog title and author),
// which is cleaner than any release name.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { audiobookLibraries, parsePath, formatOf, AUDIOBOOK_EXTS } from './scanner.js';
import { matchNewAudiobooks } from './metadata.js';

// Windows-safe path segment: strip reserved characters, keep it readable.
export const sanitizeSegment = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
  .replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim() || 'Unknown';

// Move across devices too (rename first, copy+unlink on EXDEV).
async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await fsp.rename(src, dest); }
  catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

/** Where a download files to: a single file as <Author>/<Title>.<ext>, a
 *  multi-part book as <Author>/<Title>/<part files>. */
export function destinationsFor(lib, files, hint = {}) {
  const author = sanitizeSegment(hint.author ? String(hint.author).split(',')[0] : 'Unknown Author');
  const title = sanitizeSegment(hint.title || path.basename(files[0], path.extname(files[0])));
  const root = lib.folders[0];
  if (files.length === 1) return [path.join(root, author, title + path.extname(files[0]).toLowerCase())];
  // Parts keep their own names (01.mp3, Chapter 02.mp3 …) so they still sort.
  return files.map((f) => path.join(root, author, title, sanitizeSegment(path.basename(f, path.extname(f))) + path.extname(f).toLowerCase()));
}

/** Move the audio files of one download into the library and catalog them.
 *  Returns { issueId, seriesId, path } for the book (its first part). */
export async function fileAudiobook({ store, clients = [], files, libraryId = null, hint = {}, log = () => {} }) {
  const audio = (files || []).filter((f) => AUDIOBOOK_EXTS.includes(path.extname(f).toLowerCase()) && fs.existsSync(f));
  if (!audio.length) throw new Error('no audio files to file');
  // A release that ships both a single-file book and its loose parts is one
  // book: keep the best format only (AUDIOBOOK_EXTS is best-first).
  const ext = AUDIOBOOK_EXTS.find((e) => audio.some((f) => path.extname(f).toLowerCase() === e));
  const parts = audio.filter((f) => path.extname(f).toLowerCase() === ext);
  const libs = audiobookLibraries(store.db);
  const lib = libs.find((l) => l.id === libraryId) || libs[0];
  if (!lib || !lib.folders.length) throw new Error('no Audiobooks library to file into');
  // Parts in their natural (name) order so "part 1" stays first.
  parts.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
  const dests = destinationsFor(lib, parts, hint);
  let first = null;
  for (const [i, src] of parts.entries()) {
    let dest = dests[i];
    if (path.resolve(dest) !== path.resolve(src)) {
      for (let n = 2; fs.existsSync(dest); n++) {
        const ext = path.extname(dests[i]);
        dest = path.join(path.dirname(dests[i]), path.basename(dests[i], ext) + ` (${n})` + ext);
      }
      await moveFile(src, dest);
    }
    const st = await fsp.stat(dest);
    const meta = { ...parsePath(dest, lib.folders[0]), title_source: 'filename' };
    const out = store.catalogFile({ libraryId: lib.id, path: dest, format: formatOf(dest), size: st.size, mtime: Math.round(st.mtimeMs), meta });
    first ||= { ...out, path: dest };
  }
  // Covers, narrators and series from the metadata service — best-effort.
  try { await matchNewAudiobooks(store, clients, { log }); }
  catch (e) { log(`audiobooks: metadata matching skipped: ${e?.message || e}`); }
  log(`audiobooks: filed "${hint.title || path.basename(first.path)}" into ${lib.name}`);
  return first;
}

/** The registerMediaHandler implementation. */
export function makeMediaHandler({ store, getClients }) {
  return {
    type: 'audiobook',
    exts: AUDIOBOOK_EXTS,
    async file({ files, libraryId, hint, log = () => {} }) {
      const clients = typeof getClients === 'function' ? await getClients() : (getClients || []);
      return fileAudiobook({ store, clients, files, libraryId, hint, log });
    },
  };
}
