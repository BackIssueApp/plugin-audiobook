// Audiobook library scanner: walk every 'audiobook'-type library's folders and
// catalog each audio file as a core series/issue (via the store) — pruning
// catalog rows whose file is gone, the same way comic and ebook scans prune.
// Incremental: a file whose path+mtime+size already matches its row (and whose
// catalog rows are still intact) is skipped, so rescans of a big shelf are cheap.
//
// Titles/authors are derived from the folder layout (the dominant audiobook
// convention is <Author>/<Title>/… or <Author>/<Series>/<Title>/…); those are a
// best guess flagged title_source:'filename', which the hosted metadata match
// upgrades on the pass that runs after cataloging. A single-file .m4b is the
// common case; the files of a book folder (<Author>/<Title>/…) are ONE book
// whose parts play in filename order. Each file's length and chapter marks are
// read from its headers (audiometa.js) when it is new or has changed.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { libraryFolders } from '../../src/db.js';
import { probeAudio } from './audiometa.js';

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

/** Which book a file belongs to: its folder when the folder is the book
 *  (two or more levels below the library root, where parsePath takes the
 *  title from the folder), else the file itself. */
export function bookKey(file, libFolder) {
  const depth = path.relative(libFolder, file).split(/[\\/]/).filter(Boolean).length - 1;
  return depth >= 2 ? path.dirname(file) : file;
}
// Play order: natural, so "Part 2" comes before "Part 10".
const byName = (a, b) => path.basename(a.file).localeCompare(path.basename(b.file), undefined, { numeric: true, sensitivity: 'base' });

// Files are stat'ed a few at a time, asynchronously: a rescan of an unchanged
// library is mostly stats, and on network storage a synchronous stat per file
// held the whole server for the length of the scan.
const STAT_BATCH = 8;
/** stat(files[i]), fetched STAT_BATCH at a time just ahead of the loop. */
export function batchedStat(files, size = STAT_BATCH) {
  let base = -1, batch = null;
  return async (i) => {
    const b = i - (i % size);
    if (b !== base) {
      base = b;
      batch = Promise.all(files.slice(b, b + size).map((f) => fsp.stat(f).catch((e) => e)));
    }
    const st = (await batch)[i - b];
    if (st instanceof Error) throw st;
    return st;
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
      // Group into books: a book folder's files together, everything else alone.
      const books = new Map();
      for (const f of files) {
        const k = bookKey(f.file, f.folder);
        if (!books.has(k)) books.set(k, []);
        books.get(k).push(f);
      }
      const groups = [...books.values()];
      for (const group of groups) group.sort(byName);
      const statOf = batchedStat(groups.flatMap((g) => g.map((f) => f.file)));
      let at = 0; // position in that flat list
      for (const group of groups) {
        const multi = group.length > 1;
        const items = [];
        for (const { file, folder } of group) {
          seen.add(file);
          try {
            const st = await statOf(at++);
            items.push({ file, folder, st, mtime: Math.round(st.mtimeMs), prev: known.get(file) });
          } catch (e) {
            log(`audiobooks: skipped unreadable file ${file}: ${e?.message || e}`);
          }
        }
        if (!items.length) { scanState.done += group.length; continue; }
        // Unchanged, still cataloged, already read, and already shaped as this
        // book (one issue, parts in this order) → skip. Anything else
        // re-catalogs the whole book.
        const issue0 = items[0].prev?.issue_id;
        const current = items.every((it, i) => it.prev && it.prev.mtime === it.mtime && it.prev.size === it.st.size
          && it.prev.probed_mtime === it.mtime && store.issueIntact(it.prev)
          && (multi ? (it.prev.issue_id === issue0 && it.prev.part === i + 1) : it.prev.part == null));
        if (current) { scanState.done += group.length; continue; }
        try {
          for (const it of items) {
            // Re-read headers only for a file that changed since the last read.
            it.probe = it.prev && it.prev.probed_mtime === it.mtime ? null : await probeAudio(it.file);
          }
          const meta = { ...parsePath(items[0].file, items[0].folder), title_source: 'filename' };
          if (multi) {
            store.catalogBook({ libraryId: lib.id, meta, files: items.map((it) => ({ path: it.file, format: formatOf(it.file), size: it.st.size, mtime: it.mtime, probe: it.probe })) });
          } else {
            const it = items[0];
            store.catalogFile({ libraryId: lib.id, path: it.file, format: formatOf(it.file), size: it.st.size, mtime: it.mtime, meta, probe: it.probe });
          }
          for (const it of items) { if (it.prev) scanState.updated++; else scanState.added++; }
        } catch (e) {
          log(`audiobooks: skipped ${items[0].file}: ${e?.message || e}`);
        }
        scanState.done += group.length;
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
