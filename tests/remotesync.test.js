// Network-free: a fake remote source drives the sync, a real core catalog DB
// (openDb) backs the store so catalogRemote exercises the production queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openAudiobooksStore } from '../store.js';
import { runRemoteSync, remoteSyncStatus } from '../remotesync.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sync-'));
  const dbPath = path.join(dir, 'catalog.db');
  openDb(dbPath).close();
  const store = openAudiobooksStore(dbPath);
  store.db.prepare("INSERT INTO libraries (name, type, sort_order) VALUES ('Audiobooks', 'audiobook', 1)").run();
  return { store, dir };
}
const book = (id, title) => ({ remote_id: id, title, author: 'A. Author', series: null, narrators: [], format: 'm4b', size: 10, chapters: [] });

test('first run walks every page; once complete, an incremental source is asked only for changes and the cursor stays put', async () => {
  const { store } = boot();
  const calls = [];
  const pages = [[book('r1', 'One'), book('r2', 'Two')], [book('r3', 'Three')]];
  const src = {
    id: 'fake', incremental: true,
    listPage: async (_cfg, page, opts = {}) => {
      calls.push({ page, updatedAfter: opts.updatedAfter || null });
      if (opts.updatedAfter) return { items: [book('r9', 'Nine (new)')], page: 1, totalPages: 1, total: 1 }; // what changed since
      return { items: pages[page - 1] || [], page, totalPages: pages.length, total: 3 };
    },
  };
  await runRemoteSync({ store, sources: [src] });
  let st = remoteSyncStatus();
  assert.equal(st.mode, 'full');
  assert.equal(st.created, 3);
  assert.deepEqual(calls.map((c) => c.page), [1, 2]);
  const info = store.remoteSyncInfo('fake');
  assert.equal(info.complete, true);
  assert.ok(info.synced_at, 'a clean finish is recorded');
  assert.equal(info.cursor_page, 3, 'the cursor sits past the last page');

  calls.length = 0;
  await runRemoteSync({ store, sources: [src] });
  st = remoteSyncStatus();
  assert.equal(st.mode, 'incremental');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].page, 1);
  assert.ok(calls[0].updatedAfter, 'asks for changes since the last run');
  assert.ok(Date.parse(calls[0].updatedAfter) < Date.parse(info.synced_at), 'with an overlap margin');
  assert.equal(st.created, 1, 'the new title is cataloged');
  assert.equal(store.remoteSyncInfo('fake').cursor_page, 3, 'incremental runs never move the page cursor');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audiobooks_files WHERE source='fake'").get().n, 4);

  // A source without incremental support keeps the old behaviour: resume from the cursor.
  calls.length = 0;
  const plain = { ...src, incremental: undefined };
  await runRemoteSync({ store, sources: [plain] });
  assert.equal(remoteSyncStatus().mode, 'full');
  assert.equal(calls[0].page, 3, 'resumes from the cursor');
  assert.equal(calls[0].updatedAfter, null);
  // resetCursor forces a full walk even for an incremental source.
  calls.length = 0;
  await runRemoteSync({ store, sources: [src], resetCursor: true });
  assert.equal(remoteSyncStatus().mode, 'full');
  assert.deepEqual(calls.map((c) => c.page), [1, 2]);
});

test('a DB from before the bookkeeping existed catches up from the cursor time with a wide margin', async () => {
  const { store } = boot();
  store.setRemoteCursor('old', 500, 49000);
  store.db.prepare("UPDATE audiobooks_remote_sync SET updated_at='2026-07-26T17:49:56Z', complete=1 WHERE source='old'").run();
  const info = store.remoteSyncInfo('old');
  assert.equal(info.complete, true);
  assert.equal(info.synced_at, null);
  assert.equal(info.since.slice(0, 10), '2026-04-27', 'ninety days before the cursor was last touched');
});

test('markUnavailable / markAvailable show up in the info map', async () => {
  const { store } = boot();
  const src = { id: 'fake', listPage: async () => ({ items: [book('r1', 'One')], page: 1, totalPages: 1, total: 1 }) };
  await runRemoteSync({ store, sources: [src] });
  const issueId = store.db.prepare("SELECT issue_id FROM audiobooks_files WHERE remote_id='r1'").get().issue_id;
  assert.equal(store.audiobookInfoMap([issueId])[issueId].unavailable, false);
  store.markUnavailable(issueId, 'Audiobook file not found in storage');
  const m = store.audiobookInfoMap([issueId])[issueId];
  assert.equal(m.unavailable, true);
  assert.equal(m.unavailableReason, 'Audiobook file not found in storage');
  store.markAvailable(issueId);
  assert.equal(store.audiobookInfoMap([issueId])[issueId].unavailable, false);
});

test('a cursor already past the end (pre-bookkeeping DB) catches up incrementally in the same run', async () => {
  const { store } = boot();
  store.setRemoteCursor('fake', 3, 2); // walked to the end before synced_at existed
  store.db.prepare("UPDATE audiobooks_remote_sync SET updated_at='2026-07-26T17:49:56Z' WHERE source='fake'").run();
  const calls = [];
  const src = {
    id: 'fake', incremental: true,
    listPage: async (_cfg, page, opts = {}) => {
      calls.push({ page, updatedAfter: opts.updatedAfter || null });
      if (opts.updatedAfter) return { items: [book('r9', 'Added in August')], page: 1, totalPages: 1, total: 1 };
      return { items: [], page, totalPages: 2, total: 2 }; // page 3 of 2: nothing there
    },
  };
  await runRemoteSync({ store, sources: [src] });
  assert.deepEqual(calls.map((c) => [c.page, !!c.updatedAfter]), [[3, false], [1, true]], 'full pass finds nothing, then the incremental pass runs');
  assert.equal(calls[1].updatedAfter.slice(0, 10), '2026-04-27');
  assert.equal(remoteSyncStatus().created, 1);
  const info = store.remoteSyncInfo('fake');
  assert.equal(info.complete, true);
  assert.ok(info.synced_at);
});

test('a new copy of a book prunes an older copy the source can no longer serve, and leaves one it still can', async () => {
  const { store } = boot();
  const inSeries = (id, title) => ({ ...book(id, title), series: 'Harry Potter (Full-Cast Editions)', series_index: 1 });
  const gone = new Set(['old-stone']);
  const src = {
    id: 'fake', incremental: true,
    listPage: async (_cfg, page, opts = {}) => {
      if (opts.updatedAfter) return { items: [inSeries('new-stone', 'The Stone'), inSeries('new-chamber', 'The Chamber')], page: 1, totalPages: 1, total: 2 };
      return page === 1 ? { items: [inSeries('old-stone', 'The Stone'), inSeries('old-chamber', 'The Chamber')], page: 1, totalPages: 1, total: 2 } : { items: [], page, totalPages: 1, total: 2 };
    },
    openStream: async (_cfg, remoteId) => (gone.has(remoteId) ? { status: 404, body: null } : { status: 206, body: { cancel: async () => {} } }),
  };
  await runRemoteSync({ store, sources: [src] });            // full walk: two old records
  await runRemoteSync({ store, sources: [src] });            // incremental: two new copies
  const st = remoteSyncStatus();
  assert.equal(st.created, 2);
  assert.equal(st.pruned, 1, 'only the twin the source says is gone');
  const rows = store.db.prepare("SELECT remote_id FROM audiobooks_files WHERE source='fake' ORDER BY remote_id").all().map((r) => r.remote_id);
  assert.deepEqual(rows, ['new-chamber', 'new-stone', 'old-chamber']);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM issues WHERE url LIKE 'audiobookremote:fake:old-stone'").get().n, 0, 'the dead entry is gone from the shelf too');
  assert.equal(store.remoteSyncInfo('fake').total, 2, 'an incremental run does not overwrite the catalog total');
});

test('a full walk that saw nothing and could not catch up leaves the bookkeeping alone', async () => {
  const { store } = boot();
  store.setRemoteCursor('plain', 3, 2);
  store.db.prepare("UPDATE audiobooks_remote_sync SET updated_at='2026-07-26T17:49:56Z' WHERE source='plain'").run();
  const plain = { id: 'plain', listPage: async (_cfg, page) => ({ items: [], page, totalPages: 2, total: 2 }) }; // no incremental support
  await runRemoteSync({ store, sources: [plain] });
  const info = store.remoteSyncInfo('plain');
  assert.equal(info.synced_at, null, 'not recorded as synced now');
  assert.equal(info.since.slice(0, 10), '2026-04-27', 'the catch-up window still reaches back from the cursor time');
});

test('a dead record on its own shelf is pruned when the same book arrives inside a series, and the empty shelf goes with it', async () => {
  const { store } = boot();
  const gone = new Set(['old-goblet']);
  const src = {
    id: 'fake', incremental: true,
    listPage: async (_cfg, page, opts = {}) => {
      if (opts.updatedAfter) return { items: [{ ...book('new-goblet', 'Goblet of Fire (Full-Cast)'), series: 'Harry Potter (Full-Cast Editions)', series_index: 4 }], page: 1, totalPages: 1, total: 1 };
      return page === 1 ? { items: [book('old-goblet', 'Goblet of Fire (Full-Cast)')], page: 1, totalPages: 1, total: 1 } : { items: [], page, totalPages: 1, total: 1 }; // no series info back then
    },
    openStream: async (_cfg, remoteId) => (gone.has(remoteId) ? { status: 404, body: null } : { status: 206, body: { cancel: async () => {} } }),
  };
  await runRemoteSync({ store, sources: [src] });
  const oldSeries = store.db.prepare("SELECT s.id, s.title FROM series s JOIN issues i ON i.series_id = s.id JOIN audiobooks_files f ON f.issue_id = i.id WHERE f.remote_id='old-goblet'").get();
  assert.equal(oldSeries.title, 'Goblet of Fire (Full-Cast)', 'standalone shelf named after the book');
  await runRemoteSync({ store, sources: [src] });
  assert.equal(remoteSyncStatus().pruned, 1);
  assert.deepEqual(store.db.prepare("SELECT remote_id FROM audiobooks_files WHERE source='fake'").all().map((r) => r.remote_id), ['new-goblet']);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM series WHERE id=?').get(oldSeries.id).n, 0, 'the empty shelf is removed');
});

test('the end-of-sync sweep removes entries a play attempt proved dead when their twin still streams', async () => {
  const { store } = boot();
  const gone = new Set(); // the file disappears AFTER both were cataloged
  const src = {
    id: 'fake', incremental: true,
    listPage: async (_cfg, page, opts = {}) => (opts.updatedAfter || page > 1) ? { items: [], page, totalPages: 1, total: 2 }
      : { items: [book('dead', 'Same Book'), { ...book('live', 'Same Book'), series: 'A Series', series_index: 1 }], page: 1, totalPages: 1, total: 2 },
    openStream: async (_cfg, remoteId) => (gone.has(remoteId) ? { status: 404, body: null } : { status: 206, body: { cancel: async () => {} } }),
  };
  await runRemoteSync({ store, sources: [src] }); // both cataloged; the dead one was never probed (nothing new arrived beside it)
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audiobooks_files WHERE source='fake'").get().n, 2);
  gone.add('dead');
  const deadIssue = store.db.prepare("SELECT issue_id FROM audiobooks_files WHERE remote_id='dead'").get().issue_id;
  store.markUnavailable(deadIssue, 'Audiobook file not found in storage'); // what a play attempt records
  await runRemoteSync({ store, sources: [src] });
  assert.equal(remoteSyncStatus().pruned, 1);
  assert.deepEqual(store.db.prepare("SELECT remote_id FROM audiobooks_files WHERE source='fake'").all().map((r) => r.remote_id), ['live']);
});
