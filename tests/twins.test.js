// The duplicate-twin lookups must be index probes: on a 244k-title remote
// catalog the old title join scanned the whole table per lookup (minutes of
// blocked main thread each) and took a server down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openAudiobooksStore } from '../store.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-twins-'));
  const dbPath = path.join(dir, 'catalog.db');
  openDb(dbPath).close();
  const store = openAudiobooksStore(dbPath);
  store.db.prepare("INSERT INTO libraries (name, type, sort_order) VALUES ('Audiobooks', 'audiobook', 1)").run();
  return store;
}
const book = (id, title) => ({ remote_id: id, title, author: 'A. Author', series: null, narrators: [], format: 'm4b', size: 10, chapters: [] });
const plan = (db, sql, ...args) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' | ');

test('same-titled remote entries are found through the title index, not a table scan', () => {
  const store = boot();
  const a = store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r1', meta: book('r1', 'Dune') });
  const b = store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: book('r2', '  dune ') });
  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r3', meta: book('r3', 'Other') });
  store.catalogRemote({ libraryId: 1, source: 'other', remoteId: 'r4', meta: book('r4', 'Dune') });

  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r1'), [{ issue_id: b.issueId, remote_id: 'r2' }]);
  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r3'), []);
  assert.deepEqual(store.unavailableWithTwin('fake'), []);
  store.markUnavailable(a.issueId, 'gone');
  assert.deepEqual(store.unavailableWithTwin('fake'),
    [{ issue_id: a.issueId, remote_id: 'r1', twin_issue_id: b.issueId, twin_remote_id: 'r2' }]);

  // A re-sync that renames the book moves it out of the twin set.
  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: book('r2', 'Dune Messiah') });
  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r1'), []);

  // Rows from before the column existed are keyed on first use.
  store.db.prepare('UPDATE audiobooks_files SET title_key = NULL').run();
  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: book('r2', 'DUNE') });
  store.db.prepare("UPDATE audiobooks_files SET title_key = NULL WHERE remote_id = 'r1'").run();
  assert.deepEqual(store.duplicateRemoteEntries('fake', 'r1'), [{ issue_id: b.issueId, remote_id: 'r2' }]);

  const dup = plan(store.db, `SELECT f2.issue_id FROM audiobooks_files f1
    CROSS JOIN audiobooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
      AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL
    WHERE f1.source = ? AND f1.remote_id = ? AND f1.title_key IS NOT NULL`, 'fake', 'r1');
  assert.match(dup, /f1 USING INDEX idx_abfiles_remote/);
  assert.match(dup, /f2 USING INDEX idx_abfiles_twin/);
  assert.doesNotMatch(dup, /SCAN/);
  const sweep = plan(store.db, `SELECT f1.issue_id FROM audiobooks_files f1
    CROSS JOIN audiobooks_files f2 ON f2.source = f1.source AND f2.library_id = f1.library_id
      AND f2.title_key = f1.title_key AND f2.issue_id <> f1.issue_id AND +f2.path IS NULL AND +f2.unavailable_at IS NULL
    WHERE f1.source = ? AND +f1.path IS NULL AND f1.unavailable_at IS NOT NULL AND f1.title_key IS NOT NULL`, 'fake');
  assert.match(sweep, /f1 USING INDEX idx_abfiles_unavailable/);
  assert.match(sweep, /f2 USING INDEX idx_abfiles_twin/);
  assert.doesNotMatch(sweep, /SCAN/);
  store.db.close();
});

test('removeRemoteSource drops a source\'s file-less entries and their issues, and no one else\'s', () => {
  const store = boot();
  const a = store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r1', meta: book('r1', 'Dune') });
  store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r2', meta: book('r2', 'Dune Messiah') });
  const other = store.catalogRemote({ libraryId: 1, source: 'other', remoteId: 'r4', meta: book('r4', 'Emma') });
  const removed = store.removeRemoteSource('fake');
  assert.equal(removed.entries, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audiobooks_files WHERE source='fake'").get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM issues WHERE id=?').get(a.issueId).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM issues WHERE id=?').get(other.issueId).n, 1);
  assert.equal(store.removeRemoteSource('fake').entries, 0, 'idempotent');
});

test('wanted audiobooks: one row per catalog id; onShelf finds a title+author or a matched id', () => {
  const store = boot();
  const w = store.addWanted({ id: 'B00X', title: 'Dune', author: 'Frank Herbert', year: '2007' }, 3);
  assert.equal(store.addWanted({ id: 'B00X', title: 'Dune' }).id, w.id);
  assert.equal(store.listWanted().length, 1);
  assert.equal(store.onShelf({ matchId: 'B00X', title: 'Dune', author: 'Frank Herbert' }), null);
  const r = store.catalogRemote({ libraryId: 1, source: 'fake', remoteId: 'r1', meta: book('r1', 'Dune') });
  const on = store.onShelf({ title: 'Dune', author: 'A. Author' });
  assert.deepEqual(on, { issueId: r.issueId, seriesId: r.seriesId });
  assert.equal(store.onShelf({ title: 'Dune', author: 'Somebody Else' }), null);
  assert.deepEqual(store.onShelf({ title: 'Dune: The Original Novel', author: 'A. Author' }), on, 'a subtitle is the same book');
  assert.equal(store.onShelf({ title: 'Dune Messiah', author: 'A. Author' }), null);
  store.noteWantedTry(w.id, null);
  assert.equal(store.wantedById(w.id).last_error, null);
  assert.equal(store.removeWanted(w.id), 1);
});
