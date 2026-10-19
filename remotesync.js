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
  // Returns true when the NEW entry itself turned out dead and was undone:
  // a source can keep listing a record whose file is gone, and walking from
  // page 1 again would otherwise bring back one pruned earlier.
  const gone = async (src, remoteId) => {
    const up = await src.openStream(null, remoteId, { range: 'bytes=0-0' });
    if (up?.status === 404 || up?.status === 410) return true;
    try { if (up?.body?.cancel) await up.body.cancel(); else up?.body?.destroy?.(); } catch { /* fine */ }
    return false;
  };
  const pruneDeadTwins = async (src, remoteId) => {
    if (typeof src.openStream !== 'function' || typeof store.duplicateRemoteEntries !== 'function') return false;
    const twins = store.duplicateRemoteEntries(src.id, remoteId);
    for (const twin of twins) {
      try { if (await gone(src, twin.remote_id)) { store.removeIssue(twin.issue_id); remoteSyncState.pruned++; } }
      catch { /* source unreachable right now: leave the twin alone */ }
    }
    if (!twins.length) return false;
    try {
      if (!(await gone(src, remoteId))) return false;
      const self = store.db.prepare('SELECT issue_id FROM audiobooks_files WHERE source=? AND remote_id=?').get(src.id, String(remoteId));
      if (!self) return false;
      store.removeIssue(self.issue_id);
      return true;
    } catch { return false; }
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
      const walk = async (incremental, fromStart = false) => {
        remoteSyncState.mode = incremental ? 'incremental' : 'full';
        let page = incremental || resetCursor || fromStart ? 1 : Math.max(1, Number(store.remoteCursor(src.id)) || 1);
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

          // The whole page is cataloged in ONE transaction (each title's own
          // transaction nests as a savepoint, so one bad entry still rolls back
          // alone): a commit per title was a quarter of a million commits for
          // a full catalog. The twin probes are network calls, so they run
          // after the commit.
          let interrupted = false;
          const fresh = [];
          store.db.transaction(() => {
            for (const b of items) {
              if (stopRequested()) { interrupted = true; break; }
              if (!b || b.remote_id == null) continue;
              const isNew = !store.db.prepare('SELECT 1 x FROM audiobooks_files WHERE source=? AND remote_id=?').get(src.id, String(b.remote_id));
              if (isNew && cap > 0 && claimed >= cap) { interrupted = true; break; }
              remoteSyncState.current = { remote_id: b.remote_id, title: b.title || String(b.remote_id) };
              try {
                const { created } = store.catalogRemote({ libraryId: lib.id, source: src.id, remoteId: b.remote_id, meta: b });
                if (created) { fresh.push(b.remote_id); claimed++; }
                else { remoteSyncState.updated++; remoteSyncState.done++; }
              } catch (e) { remoteSyncState.error = String(e?.message || e); }
              emit();
            }
          })();
          for (const remoteId of fresh) {
            if (await pruneDeadTwins(src, remoteId)) { claimed--; continue; } // a dead record: undone, counts as nothing
            remoteSyncState.created++; remoteSyncState.done++;
          }
          if (fresh.length) emit();
          // Let queued requests run between pages even when the source
          // answers from a cache.
          await new Promise((r) => setImmediate(r));
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
      // A source that can't list "what changed" has no catch-up: once a walk
      // has finished, the next run would start past the end and see nothing.
      // Walk it again from page 1 (cataloging is idempotent).
      else if (remoteSyncState.mode === 'full' && r.clean && r.pagesSeen === 0 && !canCatchUp && Number(store.remoteCursor(src.id)) > 1 && !stopRequested()) {
        r = await walk(false, true);
      }
      // Entries a play attempt already proved dead, whose twin still streams:
      // drop them now rather than waiting for a re-import to arrive.
      if (!stopRequested() && typeof store.unavailableWithTwin === 'function' && typeof src.openStream === 'function') {
        const checked = new Set();
        for (const d of store.unavailableWithTwin(src.id)) {
          if (checked.has(d.issue_id)) continue;
          checked.add(d.issue_id);
          try {
            const twin = await src.openStream(null, d.twin_remote_id, { range: 'bytes=0-0' });
            const twinOk = twin?.status >= 200 && twin?.status < 300;
            try { if (twin?.body?.cancel) await twin.body.cancel(); else twin?.body?.destroy?.(); } catch { /* fine */ }
            if (!twinOk) continue;
            const dead = await src.openStream(null, d.remote_id, { range: 'bytes=0-0' });
            if (dead?.status === 404 || dead?.status === 410) { store.removeIssue(d.issue_id); remoteSyncState.pruned++; }
            else { try { if (dead?.body?.cancel) await dead.body.cancel(); else dead?.body?.destroy?.(); } catch { /* fine */ } if (dead?.status >= 200 && dead?.status < 300) store.markAvailable?.(d.issue_id); }
          } catch { /* source unreachable: next time */ }
        }
      }
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
