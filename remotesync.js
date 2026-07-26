// On-demand catalog sync for the audiobooks plugin: walk a registered remote
// audiobook source's pages and catalog every title as a file-less entry
// (store.catalogRemote) — metadata + cover only, no downloads (audiobooks stream
// on play). Resumable/cancellable from a per-source page cursor, one run at a
// time. No source-specific knowledge here — everything rides the generic hook.

export const remoteSyncState = {
  running: false, sourceId: null, libraryId: null,
  page: 0, total: 0, created: 0, updated: 0, done: 0,
  current: null, startedAt: null, finishedAt: null, stoppedAt: null, error: null,
};
let stopFlag = false;

export function remoteSyncStatus() { return { ...remoteSyncState }; }
export function isRemoteSyncRunning() { return remoteSyncState.running; }
export function stopRemoteSync() {
  if (remoteSyncState.running) { stopFlag = true; remoteSyncState.stoppedAt = new Date().toISOString(); }
  return { ...remoteSyncState };
}

// Audiobook-type libraries (name + id) straight from the core catalog.
function audiobookLibraries(db) {
  try {
    return db.prepare("SELECT id, name FROM libraries WHERE type='audiobook' ORDER BY sort_order, id").all();
  } catch { return []; }
}

export async function runRemoteSync({
  store, sources = [], sourceId = null, libraryId = null,
  maxBooks = 0, resetCursor = false, onProgress = null, shouldStop = null,
} = {}) {
  if (remoteSyncState.running) throw new Error('A sync is already running.');
  const libs = audiobookLibraries(store.db);
  if (!libs.length) throw new Error('Create an Audiobooks library first — there is no audiobook library to sync into.');
  const lib = (libraryId != null && libs.find((l) => l.id === Number(libraryId))) || libs[0];
  const chosen = sourceId ? sources.filter((s) => s.id === sourceId) : [...sources];
  if (!chosen.length) throw new Error(sourceId ? `No remote audiobook source "${sourceId}" is registered.` : 'No remote audiobook source is registered.');
  const cap = Math.max(0, Number(maxBooks) || 0);

  stopFlag = false;
  Object.assign(remoteSyncState, {
    running: true, sourceId: sourceId || null, libraryId: lib.id, page: 0, total: 0,
    created: 0, updated: 0, done: 0, current: null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedAt: null, error: null,
  });
  const stopRequested = () => stopFlag || (typeof shouldStop === 'function' && shouldStop());
  const emit = () => { if (typeof onProgress === 'function') onProgress(remoteSyncStatus()); };

  let claimed = 0;
  try {
    for (const src of chosen) {
      if (stopRequested()) break;
      let page = resetCursor ? 1 : Math.max(1, Number(store.remoteCursor(src.id)) || 1);
      let totalPages = Infinity;
      while (page <= totalPages && !stopRequested()) {
        remoteSyncState.page = page;
        const res = await src.listPage(null, page);
        const items = Array.isArray(res?.items) ? res.items : [];
        if (res?.total) remoteSyncState.total = res.total;
        if (res?.totalPages) totalPages = res.totalPages;
        if (!items.length) break;

        let interrupted = false;
        for (const b of items) {
          if (stopRequested()) { interrupted = true; break; }
          if (!b || b.remote_id == null) continue;
          const isNew = !store.db.prepare('SELECT 1 x FROM audiobooks_files WHERE source=? AND remote_id=?').get(src.id, String(b.remote_id));
          if (isNew && cap > 0 && claimed >= cap) { interrupted = true; break; }
          remoteSyncState.current = { remote_id: b.remote_id, title: b.title || String(b.remote_id) };
          try {
            const { created } = store.catalogRemote({ libraryId: lib.id, source: src.id, remoteId: b.remote_id, meta: b });
            if (created) { remoteSyncState.created++; claimed++; } else remoteSyncState.updated++;
            remoteSyncState.done++;
          } catch (e) { remoteSyncState.error = String(e?.message || e); }
          emit();
        }
        if (!interrupted) { store.setRemoteCursor(src.id, page + 1, remoteSyncState.total); page += 1; }
        else break;
      }
    }
    if (stopRequested() && !remoteSyncState.stoppedAt) remoteSyncState.stoppedAt = new Date().toISOString();
    return remoteSyncStatus();
  } finally {
    remoteSyncState.running = false;
    remoteSyncState.finishedAt = new Date().toISOString();
    remoteSyncState.current = null;
    emit();
  }
}
