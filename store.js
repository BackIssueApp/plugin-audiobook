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
import Database from 'better-sqlite3';
import { upsertLibraryFile, deleteLibraryFile } from '../../src/db.js';

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'untitled';
// One audiobook = one standalone self-described series keyed by title~author, so
// a re-sync lands on the same row.
export const seriesUrlFor = (libraryId, meta) =>
  `audiobook:l${libraryId}:b:${slug(meta.title)}~${slug(meta.author || (meta.authors || [])[0] || '')}`;
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

  const seriesByUrl = (url) => db.prepare('SELECT * FROM series WHERE url=?').get(url);
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
