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
const indexNumber = (n) => (Number.isFinite(Number(n)) && String(n).trim() !== '' ? String(n) : '1');
const year4 = (s) => (String(s || '').match(/(\d{4})/) || [])[1] || null;
const nownow = () => new Date().toISOString();

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
  `);
  // The original table only carried remote (file-less) entries; add the columns
  // a LOCAL scanned file needs (the incremental-skip key + metadata-match state)
  // to an existing DB. Fresh DBs get them here too — harmless if already present.
  const abCols = db.prepare("SELECT name FROM pragma_table_info('audiobooks_files')").all().map((r) => r.name);
  for (const [col, decl] of [
    ['mtime', 'INTEGER'], ['title_source', 'TEXT'],
    ['match_id', 'TEXT'], ['match_confidence', 'TEXT'], ['match_checked_at', 'TEXT'],
  ]) {
    if (!abCols.includes(col)) db.exec(`ALTER TABLE audiobooks_files ADD COLUMN ${col} ${decl}`);
  }

  const seriesByUrl = (url) => db.prepare('SELECT * FROM series WHERE url=?').get(url);
  const isStandalone = (seriesRow) => /^audiobook:l\d+:b:/.test(String(seriesRow?.url || ''));
  const authorsOf = (seriesRow) => String(seriesRow?.publisher || '').split(',').map((a) => a.trim()).filter(Boolean);
  const fileByIssue = (issueId) => db.prepare('SELECT * FROM audiobooks_files WHERE issue_id=?').get(issueId);

  const api = {
    db,

    /** Catalog a file-less remote audiobook: a self-described `audiobook` series
     *  with one issue, plus the audiobooks_files row carrying the stream identity
     *  (source, remote_id) and audio metadata. Idempotent by (source, remote_id);
     *  `restricted` follows the source's `explicit` flag. Returns ids + created. */
    catalogRemote({ libraryId, source, remoteId, meta = {} }) {
      const title = meta.title || 'Untitled';
      const author = meta.author || (meta.authors || []).join(', ') || null;
      const url = seriesUrlFor(libraryId, { title, author });
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
          .run({ title, url, publisher: author, lib: libraryId, description: meta.description || null, year, restricted });
        const seriesId = seriesByUrl(url).id;
        db.prepare(`INSERT INTO issues (series_id, title, issue_number, url, status, file_path)
          VALUES (?, ?, '1', ?, 'done', NULL)
          ON CONFLICT(url) DO UPDATE SET series_id=excluded.series_id, title=excluded.title, status='done'`)
          .run(seriesId, title, issueUrl);
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
              thumbnail=@thumb, explicit=@explicit WHERE rowid=@rowid`)
            .run({ rowid: prev.ab_rowid, lib: libraryId, sid: seriesId, iid: issueId,
              format: (meta.format || 'm4b'), duration: meta.duration ?? null,
              narrators: (meta.narrators || []).join(', ') || null,
              chapters: meta.chapters ? JSON.stringify(meta.chapters) : null,
              thumb: meta.coverUrl || null, explicit: restricted });
        } else {
          db.prepare(`INSERT INTO audiobooks_files
              (path, library_id, series_id, issue_id, format, size, duration, narrators, chapters, thumbnail, explicit, source, remote_id, added_at)
              VALUES (NULL, @lib, @sid, @iid, @format, @size, @duration, @narrators, @chapters, @thumb, @explicit, @source, @remote, @now)`)
            .run({ lib: libraryId, sid: seriesId, iid: issueId, format: (meta.format || 'm4b'),
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
    catalogFile({ libraryId, path: p, format, size, mtime, meta = {} }) {
      const author = meta.author || null;
      const standalone = !meta.series;
      const title = meta.title || 'Untitled';
      const url = seriesUrlFor(libraryId, meta);
      const tx = db.transaction(() => {
        const prev = db.prepare(`SELECT ef.rowid AS ab_rowid, ef.issue_id, ef.match_id,
            i.series_id AS prev_series_id, i.title AS prev_title
          FROM audiobooks_files ef LEFT JOIN issues i ON i.id = ef.issue_id WHERE ef.path=?`).get(p);
        const prevSeries = prev?.prev_series_id
          ? db.prepare('SELECT * FROM series WHERE id=?').get(prev.prev_series_id) : null;
        // A match-upgraded title survives a re-parse that still has only the
        // filename to offer (strictly worse data).
        const keepTitle = !!(prev?.match_id && meta.title_source === 'filename' && prev.prev_title);
        const issueTitle = keepTitle ? prev.prev_title : title;
        let seriesId;
        if (prevSeries && standalone && isStandalone(prevSeries) && String(prevSeries.url).startsWith(`audiobook:l${libraryId}:`)) {
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
          .run(seriesId, issueTitle, standalone ? '1' : indexNumber(meta.series_index), issueUrlFor(p), p);
        const issueId = db.prepare('SELECT id FROM issues WHERE url=?').get(issueUrlFor(p)).id;
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
        db.prepare(`INSERT INTO audiobooks_files
            (path, library_id, series_id, issue_id, format, size, mtime, title_source, added_at)
          VALUES (@path, @lib, @sid, @iid, @format, @size, @mtime, @title_source, @now)
          ON CONFLICT(path) DO UPDATE SET
            library_id=excluded.library_id, series_id=excluded.series_id, issue_id=excluded.issue_id,
            format=excluded.format, size=excluded.size, mtime=excluded.mtime,
            title_source=excluded.title_source`)
          .run({ path: p, lib: libraryId, sid: seriesId, iid: issueId, format,
            size: size ?? null, mtime: mtime ?? null, title_source: meta.title_source || null, now: nownow() });
        return { seriesId, issueId };
      });
      return tx();
    },

    /** path → { path, mtime, size, issue_id, source } for one library — the
     *  incremental-scan skip index. Remote entries (path NULL) key to `null` and
     *  never collide with a real path. */
    pathIndex(libraryId) {
      const rows = db.prepare('SELECT path, mtime, size, issue_id, source FROM audiobooks_files WHERE library_id=?').all(libraryId);
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
          if (r.issue_id != null) {
            db.prepare('DELETE FROM audiobooks_progress WHERE issue_id=?').run(r.issue_id);
            db.prepare('DELETE FROM audiobooks_bookmarks WHERE issue_id=?').run(r.issue_id);
            db.prepare('DELETE FROM issues WHERE id=?').run(r.issue_id);
          }
          db.prepare('DELETE FROM audiobooks_files WHERE path=?').run(r.path);
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
      const series = db.prepare('SELECT * FROM series WHERE id=?').get(row.series_id);
      const standalone = isStandalone(series);
      const tx = db.transaction(() => {
        if (merged.title) {
          db.prepare('UPDATE issues SET title=? WHERE id=?').run(merged.title, issueId);
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
      const out = {};
      const ids = (issueIds || []).map(Number).filter(Boolean);
      if (!ids.length) return out;
      const q = db.prepare(`SELECT issue_id, format, duration, narrators, source, path FROM audiobooks_files
        WHERE issue_id IN (${ids.map(() => '?').join(',')})`);
      for (const r of q.all(...ids)) out[r.issue_id] = {
        format: r.format, duration: r.duration, narrators: r.narrators,
        remote: !!r.source && !r.path, audiobook: true,
      };
      return out;
    },

    // ---- per-user progress ----
    getProgress(userId, issueId) {
      return db.prepare('SELECT position, duration, finished FROM audiobooks_progress WHERE user_id=? AND issue_id=?')
        .get(userId || 0, issueId) || { position: 0, duration: 0, finished: 0 };
    },
    setProgress(userId, issueId, { position = 0, duration = 0 }) {
      const finished = duration > 0 && position >= duration - 30 ? 1 : 0;
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
    setRemoteCursor(source, page, total) {
      db.prepare(`INSERT INTO audiobooks_remote_sync (source, cursor_page, total, updated_at)
        VALUES (@s, @p, @t, @now)
        ON CONFLICT(source) DO UPDATE SET cursor_page=@p, total=COALESCE(@t, audiobooks_remote_sync.total), updated_at=@now`)
        .run({ s: source, p: page, t: total ?? null, now: nownow() });
    },

    /** Remove an audiobook entry (issue + plugin row + any library_file). */
    removeIssue(issueId) {
      const row = fileByIssue(issueId);
      if (row?.path) { try { deleteLibraryFile(db, row.path); } catch { /* none */ } }
      db.prepare('DELETE FROM audiobooks_files WHERE issue_id=?').run(issueId);
    },
  };
  return api;
}
