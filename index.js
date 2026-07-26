// Audiobooks plugin — an on-demand audiobook library with an in-browser player.
//
// Mirrors the ebooks plugin, but audiobooks are large (~1GB m4b) so they STREAM
// rather than download: a registered remote source (registerRemoteMediaSource
// with mediaType 'audiobook') exposes the catalog as file-less entries, and
// playback proxies range requests
// to the source (credentials stay server-side). Audiobooks are self-described
// `audiobook`-type catalog rows, so the Library grid, series pages, permissions
// and the mature filter all ride core.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import config from '../../src/config.js';
import { registeredRemoteMediaSources } from '../../src/plugins.js';
import { openAudiobooksStore } from './store.js';
import { runRemoteSync, stopRemoteSync, remoteSyncStatus, isRemoteSyncRunning } from './remotesync.js';

export default function register(api) {
  const store = openAudiobooksStore(config.dbPath);
  const CAN_USE = 'audiobooks.use';
  const CAN_MANAGE = 'library.manage';

  api.registerLibraryType?.({ id: 'audiobook', label: 'Audiobooks', selfDescribed: true });
  api.registerPermission?.({
    key: CAN_USE, label: 'Audiobooks', tier: 'viewer',
    description: 'Browse and play audiobooks',
  });
  api.registerClientAsset({ js: 'client/player.js', css: 'client/player.css' });

  const sources = () => registeredRemoteMediaSources('audiobook');
  const sourceFor = (id) => sources().find((s) => s.id === id) || null;
  const uid = (req) => (req.user && req.user.id) || 0;

  // ---- Streaming: range proxy (remote) or cached file (materialized) ----------
  // The <audio> element issues Range requests to seek; forward them upstream and
  // pipe the 206 straight through, so nothing buffers a whole 1GB file in memory.
  api.registerRoute('get', '/api/audiobooks/issue/:id/stream', async (req, res) => {
    const issueId = Number(req.params.id);
    const row = store.fileByIssue(issueId);
    if (!row) return res.status(404).end();

    if (row.path && fs.existsSync(row.path)) {          // cached on disk → let Express handle Range/ETag
      return res.sendFile(row.path, { headers: { 'Content-Type': mimeFor(row.format), 'Cache-Control': 'private, max-age=0' } });
    }
    const src = sourceFor(row.source);
    if (!src) return res.status(404).end();
    try {
      const up = await src.openStream(null, row.remote_id, { range: req.headers.range || null });
      res.status(up.status || 200);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = up.headers?.get ? up.headers.get(h) : up.headers?.[h];
        if (v) res.setHeader(h, v);
      }
      if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=0');
      if (!up.body) return res.end();
      const nodeStream = up.body.pipe ? up.body : Readable.fromWeb(up.body);
      nodeStream.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
      req.on('close', () => { try { nodeStream.destroy?.(); } catch { /* client gone */ } });
      nodeStream.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: String(e?.message || e) });
    }
  }, { access: CAN_USE });

  // Cover: redirect to the source's thumbnail proxy (nothing embedded here).
  api.registerRoute('get', '/api/audiobooks/issue/:id/cover', (req, res) => {
    const c = store.cover(Number(req.params.id));
    if (!c || !c.thumbnail) return res.status(404).end();
    res.redirect(302, c.thumbnail);
  }, { access: CAN_USE });

  // Chapters for the player's chapter list. The catalog sync stores none (the
  // list endpoint omits them), so fetch lazily from the source's detail the
  // first time and cache them on the row.
  api.registerRoute('get', '/api/audiobooks/issue/:id/chapters', async (req, res) => {
    const issueId = Number(req.params.id);
    const row = store.fileByIssue(issueId);
    if (!row) return res.json({ chapters: [], duration: null });
    let chapters = [];
    try { chapters = row.chapters ? JSON.parse(row.chapters) : []; } catch { chapters = []; }
    if (!chapters.length && row.source && row.remote_id) {
      const src = sourceFor(row.source);
      if (src?.chapters) {
        try {
          const r = await src.chapters(null, row.remote_id);
          chapters = r?.chapters || [];
          if (chapters.length) store.db.prepare('UPDATE audiobooks_files SET chapters=? WHERE issue_id=?').run(JSON.stringify(chapters), issueId);
        } catch { /* leave empty */ }
      }
    }
    res.json({ chapters, duration: row.duration ?? null });
  }, { access: CAN_USE });

  // Per-issue playback info, scoped to the requested issue ids (client detects
  // audiobook rows + shows the player without shipping the whole catalog).
  api.registerRoute('get', '/api/audiobooks/info', (req, res) => {
    const ids = String(req.query.issues || '').split(',').map(Number).filter(Boolean);
    res.json({ info: store.audiobookInfoMap(ids) });
  }, { access: CAN_USE });

  // ---- Per-user progress (resume) --------------------------------------------
  api.registerRoute('get', '/api/audiobooks/issue/:id/progress', (req, res) => {
    res.json(store.getProgress(uid(req), Number(req.params.id)));
  }, { access: CAN_USE });
  api.registerRoute('post', '/api/audiobooks/issue/:id/progress', (req, res) => {
    const { position, duration } = req.body || {};
    res.json(store.setProgress(uid(req), Number(req.params.id), { position: Number(position) || 0, duration: Number(duration) || 0 }));
  }, { access: CAN_USE });

  // ---- Bookmarks --------------------------------------------------------------
  api.registerRoute('get', '/api/audiobooks/issue/:id/bookmarks', (req, res) => {
    res.json({ bookmarks: store.listBookmarks(uid(req), Number(req.params.id)) });
  }, { access: CAN_USE });
  api.registerRoute('post', '/api/audiobooks/issue/:id/bookmarks', (req, res) => {
    const { position, note } = req.body || {};
    res.json(store.addBookmark(uid(req), Number(req.params.id), position, note));
  }, { access: CAN_USE });
  api.registerRoute('delete', '/api/audiobooks/bookmarks/:bid', (req, res) => {
    store.deleteBookmark(uid(req), Number(req.params.bid));
    res.json({ ok: true });
  }, { access: CAN_USE });

  // ---- Listening stats --------------------------------------------------------
  api.registerRoute('get', '/api/audiobooks/stats', (req, res) => res.json(store.stats(uid(req))), { access: CAN_USE });

  // ---- On-demand catalog sync (curation) -------------------------------------
  api.registerRoute('post', '/api/audiobooks/remote-sync/start', (req, res) => {
    if (isRemoteSyncRunning()) return res.status(409).json({ error: 'A sync is already running.', state: remoteSyncStatus() });
    const srcs = sources();
    if (!srcs.length) return res.status(400).json({ error: 'No remote audiobook source is available. Enable a source plugin first.' });
    const { sourceId, libraryId, maxBooks, resetCursor } = req.body || {};
    runRemoteSync({
      store, sources: srcs, sourceId: sourceId || null,
      libraryId: libraryId != null ? Number(libraryId) : null,
      maxBooks: Number(maxBooks) || 0, resetCursor: !!resetCursor,
    }).catch((e) => console.warn('[audiobooks] remote sync failed:', e?.message || e));
    res.json({ started: true, state: remoteSyncStatus() });
  }, { access: CAN_MANAGE });
  api.registerRoute('post', '/api/audiobooks/remote-sync/stop', (_req, res) => res.json(stopRemoteSync()), { access: CAN_MANAGE });
  api.registerRoute('get', '/api/audiobooks/remote-sync/status', (_req, res) => {
    res.json({ ...remoteSyncStatus(), hasSource: sources().length > 0 });
  }, { access: CAN_MANAGE });
}

const MIME = { m4b: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };
function mimeFor(format) { return MIME[String(format || '').toLowerCase()] || 'audio/mpeg'; }
