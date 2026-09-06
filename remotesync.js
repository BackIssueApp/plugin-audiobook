// On-demand catalog sync for the audiobooks plugin: walk a registered remote
// audiobook source's pages and catalog every title as a file-less entry
// (store.catalogRemote) — metadata + cover only, no downloads (audiobooks stream
// on play). Resumable/cancellable from a per-source page cursor, one run at a
// time. No source-specific knowledge here — everything rides the generic hook.
//
// Two modes. The first run walks every page (the cursor makes it resumable).
// Once a walk has completed, a source that declares `incremental: true` is
// asked only for what changed since the last run (listPage's `updatedAfter`),
// because a page cursor cannot see titles added after the walk began — a
// source that lists newest-first puts them on page 1, behind the cursor.

export const remoteSyncState = {
  running: false, sourceId: null, libraryId: null, mode: null, // 'full' | 'incremental'
  page: 0, total: 0, created: 0, updated: 0, done: 0, pruned: 0,
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
    running: true, sourceId: sourceId || null, libraryId: lib.id, mode: null, page: 0, total: 0,
    created: 0, updated: 0, done: 0, pruned: 0, current: null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedAt: null, error: null,
  });
  const stopRequested = () => stopFlag || (typeof shouldStop === 'function' && shouldStop());
  const emit = () => { if (typeof onProgress === 'function') onProgress(remoteSyncStatus()); };

  let claimed = 0;
  // A re-imported book arrives next to its old record, whose file is usually
  // the reason it was re-imported. When the source confirms the old copy is
  // gone (404), drop it — otherwise the shelf shows the same book twice, one
  // of them dead.
  const pruneDeadTwins = async (src, remoteId) => {
    if (typeof src.openStream !== 'function' || typeof store.duplicateRemoteEntries !== 'function') return;
    for (const twin of store.duplicateRemoteEntries(src.id, remoteId)) {
      try {
        const up = await src.openStream(null, twin.remote_id, { range: 'bytes=0-0' });
        if (up?.status === 404 || up?.status === 410) { store.removeIssue(twin.issue_id); remoteSyncState.pruned++; }
        else { try { if (up?.body?.cancel) await up.body.cancel(); else up?.body?.destroy?.(); } catch { /* fine */ } }
      } catch { /* source unreachable right now: leave the twin alone */ }
    }
  };
  try {
    for (const src of chosen) {
      if (stopRequested()) break;
      const info = typeof store.remoteSyncInfo === 'function' ? store.remoteSyncInfo(src.id) : { complete: false, since: null };
      const canCatchUp = src.incremental === true && !!info.since && !resetCursor;
      const runStartedAt = new Date().toISOString();

      // One pass over the source: every page from the cursor (full), or the
      // pages of "what changed since" (incremental). Reports whether it saw
      // the end cleanly and how many pages actually carried titles.
      const walk = async (incremental) => {
        remoteSyncState.mode = incremental ? 'incremental' : 'full';
        let page = incremental ? 1 : (resetCursor ? 1 : Math.max(1, Number(store.remoteCursor(src.id)) || 1));
        let totalPages = Infinity;
        let clean = true; // false when stopped/capped part-way — not a finish
        let pagesSeen = 0;
        while (page <= totalPages && !stopRequested()) {
          remoteSyncState.page = page;
          const res = await src.listPage(null, page, incremental ? { updatedAfter: info.since } : {});
          const items = Array.isArray(res?.items) ? res.items : [];
          if (res?.total) remoteSyncState.total = res.total;
          if (res?.totalPages) totalPages = res.totalPages;
          if (!items.length) break;
          pagesSeen++;

          let interrupted = false;
          for (const b of items) {
            if (stopRequested()) { interrupted = true; break; }
            if (!b || b.remote_id == null) continue;
            const isNew = !store.db.prepare('SELECT 1 x FROM audiobooks_files WHERE source=? AND remote_id=?').get(src.id, String(b.remote_id));
            if (isNew && cap > 0 && claimed >= cap) { interrupted = true; break; }
            remoteSyncState.current = { remote_id: b.remote_id, title: b.title || String(b.remote_id) };
            try {
              const { created } = store.catalogRemote({ libraryId: lib.id, source: src.id, remoteId: b.remote_id, meta: b });
              if (created) { remoteSyncState.created++; claimed++; await pruneDeadTwins(src, b.remote_id); } else remoteSyncState.updated++;
              remoteSyncState.done++;
            } catch (e) { remoteSyncState.error = String(e?.message || e); }
            emit();
          }
          if (interrupted) { clean = false; break; }
          if (!incremental) store.setRemoteCursor(src.id, page + 1, remoteSyncState.total);
          page += 1;
        }
        if (stopRequested()) clean = false;
        return { clean: clean && page > totalPages, pagesSeen };
      };

      let r = await walk(canCatchUp && info.complete);
      // A full walk with nothing left to see (the cursor was already past the
      // end — a DB from before this bookkeeping existed) is not a catch-up:
      // anything added since sits behind the cursor. Follow it with the
      // incremental pass right away, so one click brings the catalog current.
      if (remoteSyncState.mode === 'full' && r.clean && r.pagesSeen === 0 && canCatchUp && !stopRequested()) r = await walk(true);
      // A clean finish is what makes the next run incremental; a run that
      // stopped early resumes from the cursor instead. A full walk that saw
      // nothing and could not catch up (the source has no incremental
      // support) proves nothing — recording it as "synced now" would shrink
      // a later catch-up window to a day and skip everything in between.
      const sawNothing = remoteSyncState.mode === 'full' && r.pagesSeen === 0;
      if (r.clean && !sawNothing && typeof store.markRemoteSynced === 'function') {
        // The catalog total is only meaningful from a full walk; an incremental
        // run's total is the size of the change set.
        store.markRemoteSynced(src.id, { at: runStartedAt, complete: true, total: remoteSyncState.mode === 'full' ? (remoteSyncState.total || null) : null });
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
