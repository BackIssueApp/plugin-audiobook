// Audiobook library scanner: walk every 'audiobook'-type library's folders and
// catalog each audio file as a core series/issue (via the store) — pruning
// catalog rows whose file is gone, the same way comic and ebook scans prune.
// Incremental: a file whose path+mtime+size already matches its row (and whose
// catalog rows are still intact) is skipped, so rescans of a big shelf are cheap.
//
// Titles/authors are derived from the folder layout (the dominant audiobook
// convention is <Author>/<Title>/… or <Author>/<Series>/<Title>/…); those are a
// best guess flagged title_source:'filename', which the hosted metadata match
// upgrades on the pass that runs after cataloging. Each audio FILE is one book —
// a single-file .m4b is the common case; a multi-file MP3 book lands as one
// series (its leaf folder) with a part per file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { libraryFolders } from '../../src/db.js';

// Formats scanned. Single-file .m4b/.m4a are the common audiobook containers;
// .mp3 covers older single- and multi-file books.
export const AUDIOBOOK_EXTS = ['.m4b', '.m4a', '.mp3'];

export const formatOf = (p) => path.extname(p).toLowerCase().replace('.', '') || 'm4b';

/** The 'audiobook'-type libraries from the core catalog, with their scan folders. */
export function audiobookLibraries(db) {
  try {
    return db.prepare("SELECT id, name, root_folder FROM libraries WHERE type = 'audiobook' ORDER BY sort_order, id")
      .all()
      .map((l) => ({ id: l.id, name: l.name, folders: libraryFolders(l.root_folder) }));
  } catch {
    return []; // core predates explicit libraries — nothing to scan
  }
}

/** Recursively list audio files under a folder (absolute paths). Dot-entries
 *  and unreadable subtrees are skipped, never fatal. */
export async function walkAudiobooks(folder) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(folder, e.name);
    if (e.isDirectory()) out.push(...await walkAudiobooks(full));
    else if (AUDIOBOOK_EXTS.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** Derive { title, author, series } from where the file sits under its library
 *  folder. Segments below the library root: [] → title is the filename;
 *  [Author] → <Author>/<Title>.ext; [Author, Title] → the leaf folder is the
 *  book; [Author, Series, Title, …] → the first is the author, the second the
 *  series, the leaf folder the book. A guess, corrected by the metadata match. */
export function parsePath(file, libFolder) {
  const rel = path.relative(libFolder, file);
  const segs = rel.split(/[\\/]/).filter(Boolean);
  const fileTitle = path.basename(file, path.extname(file));
  const dirs = segs.slice(0, -1); // drop the filename
  if (dirs.length === 0) return { title: fileTitle, author: null, series: null };
  if (dirs.length === 1) return { title: fileTitle, author: dirs[0], series: null };
  // dirs.length >= 2: leaf folder is the book title, first is the author, and a
  // middle folder (3+ deep) is the series.
  return {
    title: dirs[dirs.length - 1],
    author: dirs[0],
    series: dirs.length >= 3 ? dirs[1] : null,
  };
}

// Shared scan state for the status endpoint (one scan at a time).
export const scanState = {
  running: false, done: 0, total: 0, added: 0, updated: 0, removed: 0,
  startedAt: null, finishedAt: null, error: null,
};

/** Full incremental scan of every audiobook library. Returns the tallies. */
export async function scanLibraries({ store, log = console.log }) {
  if (scanState.running) return scanState;
  Object.assign(scanState, {
    running: true, done: 0, total: 0, added: 0, updated: 0, removed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
  });
  try {
    const libs = audiobookLibraries(store.db);
    // Gather first so done/total is meaningful to the UI. Keep each file's
    // owning library folder so parsePath can derive title/author relative to it.
    const work = [];
    for (const lib of libs) {
      const files = [];
      for (const folder of lib.folders) {
        for (const f of await walkAudiobooks(folder)) files.push({ file: f, folder });
      }
      work.push({ lib, files });
      scanState.total += files.length;
    }
    for (const { lib, files } of work) {
      const known = store.pathIndex(lib.id);
      const seen = new Set();
      for (const { file, folder } of files) {
        seen.add(file);
        try {
          const st = fs.statSync(file);
          const mtime = Math.round(st.mtimeMs);
          const prev = known.get(file);
          // Unchanged AND still cataloged → skip. A removed/untracked book (rows
          // gone, file still here) re-catalogs.
          if (prev && prev.mtime === mtime && prev.size === st.size && store.issueIntact(prev)) {
            scanState.done++;
            continue;
          }
          const meta = { ...parsePath(file, folder), title_source: 'filename' };
          store.catalogFile({ libraryId: lib.id, path: file, format: formatOf(file), size: st.size, mtime, meta });
          if (prev) scanState.updated++; else scanState.added++;
        } catch (e) {
          log(`audiobooks: skipped unreadable file ${file}: ${e?.message || e}`);
        }
        scanState.done++;
      }
      scanState.removed += store.removeMissing(lib.id, seen);
    }
    if (scanState.added || scanState.updated || scanState.removed) {
      log(`audiobooks: scan finished — ${scanState.added} added, ${scanState.updated} updated, ${scanState.removed} removed`);
    }
  } catch (e) {
    scanState.error = String(e?.message || e);
    log(`audiobooks: scan failed: ${scanState.error}`);
  } finally {
    scanState.running = false;
    scanState.finishedAt = new Date().toISOString();
  }
  return scanState;
}
