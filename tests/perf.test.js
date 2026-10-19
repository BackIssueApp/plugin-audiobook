// The cheaper paths keep their answers: "on the shelf?" through its indexes
// (and past a crowd of same-first-word titles), title keys kept for local
// books, async scan stats, and a remote sync committed per page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openAudiobooksStore } from '../store.js';
import { batchedStat } from '../scanner.js';
import { runRemoteSync } from '../remotesync.js';

function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-perf-'));
  const dbPath = path.join(dir, 'catalog.db');
  openDb(dbPath).close();
  const store = openAudiobooksStore(dbPath);
  const lib = store.db.prepare("INSERT INTO libraries (name, type, sort_order) VALUES ('Audiobooks', 'audiobook', 1)").run().lastInsertRowid;
  const rm = () => { store.close?.(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reaped later */ } };
  return { dir, dbPath, store, lib, rm };
}
const meta = (title, author = 'Ann Author') => ({ title, author, title_source: 'embedded' });

test('onShelf finds by match id and by title past 40 look-alikes, through indexes', () => {
  const { store, lib, rm } = boot();
  try {
    for (let k = 0; k < 60; k++) store.catalogFile({ libraryId: lib, path: `/a/the-${k}.m4b`, format: 'm4b', size: 1, mtime: 1, meta: meta(`The Aardvark ${k}`) });
    const target = store.catalogFile({ libraryId: lib, path: '/a/zebra.m4b', format: 'm4b', size: 1, mtime: 1, meta: meta('The Zebra Road') });
    store.db.prepare("UPDATE audiobooks_files SET match_id='au-9' WHERE issue_id=?").run(target.issueId);
    const want = { issueId: target.issueId, seriesId: target.seriesId };
    assert.deepEqual(store.onShelf({ matchId: 'au-9' }), want);
    assert.deepEqual(store.onShelf({ title: 'The Zebra Road (Unabridged)', author: 'Ann Author' }), want);
    assert.equal(store.onShelf({ title: 'The Zebra Road', author: 'Someone Else' }), null);
    assert.equal(store.onShelf({ matchId: 'nope', title: 'Nothing Like It' }), null);
    const plan = (sql, ...a) => store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map((r) => r.detail).join(' | ');
    assert.match(plan('SELECT issue_id FROM audiobooks_files WHERE match_id = ?', 'x'), /idx_abfiles_match/);
    assert.match(plan('SELECT issue_id FROM audiobooks_files f WHERE f.title_key >= ? AND f.title_key < ?', 'a', 'b'), /idx_abfiles_titlekey/);
  } finally { rm(); }
});

test('local title keys follow the title (and every part of a book); keys missing on open are filled', () => {
  const { dbPath, store, lib, rm } = boot();
  try {
    const one = store.catalogFile({ libraryId: lib, path: '/a/x.m4b', format: 'm4b', size: 1, mtime: 1, meta: meta('  First Name ') });
    const key = (id) => store.db.prepare('SELECT title_key FROM audiobooks_files WHERE issue_id=?').all(id).map((r) => r.title_key);
    assert.deepEqual(key(one.issueId), ['first name']);
    store.applyMatch(one.issueId, { title: 'Second Name', match_id: 'm1' });
    assert.deepEqual(key(one.issueId), ['second name']);

    const many = store.catalogBook({ libraryId: lib, meta: meta('Parted'), files: [1, 2, 3].map((n) => ({ path: `/a/p/${n}.mp3`, format: 'mp3', size: 1, mtime: 1 })) });
    assert.deepEqual(key(many.issueId), ['parted', 'parted', 'parted']);

    store.db.exec('UPDATE audiobooks_files SET title_key = NULL');
    const again = openAudiobooksStore(dbPath);
    assert.deepEqual(again.db.prepare('SELECT title_key FROM audiobooks_files WHERE issue_id=?').all(one.issueId).map((r) => r.title_key), ['second name']);
    again.close?.();
  } finally { rm(); }
});

test('batchedStat stats a few files at a time, in order, and reports a missing one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-stat-'));
  try {
    const files = Array.from({ length: 11 }, (_, k) => path.join(dir, `f${k}.mp3`));
    files.forEach((f, k) => fs.writeFileSync(f, 'x'.repeat(k + 1)));
    files[9] = path.join(dir, 'gone.mp3');
    const statOf = batchedStat(files, 4);
    for (let k = 0; k < files.length; k++) {
      if (k === 9) { await assert.rejects(() => statOf(k), /ENOENT/); continue; }
      assert.equal((await statOf(k)).size, k + 1);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remote sync commits a page at a time and stays idempotent', async () => {
  const { store, rm } = boot();
  try {
    const src = { id: 'p', listPage: async (_c, page) => ({
      page, totalPages: 3, total: 30,
      items: page > 3 ? [] : Array.from({ length: 10 }, (_, k) => ({ remote_id: `r${page}-${k}`, title: `Title ${page}-${k}`, author: 'A', format: 'm4b', chapters: [], narrators: [] })),
    }) };
    const commits = [];
    const orig = store.db.transaction.bind(store.db);
    store.db.transaction = (fn) => { const tx = orig(fn); return (...a) => { const out = tx(...a); if (!store.db.inTransaction) commits.push(1); return out; }; };
    const r = await runRemoteSync({ store, sources: [src] });
    store.db.transaction = orig;
    assert.equal(r.created, 30);
    assert.equal(commits.length, 3, 'one commit per page');
    const again = await runRemoteSync({ store, sources: [src], resetCursor: true });
    assert.equal(again.updated + again.created, 30);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audiobooks_files WHERE source='p'").get().n, 30);
  } finally { rm(); }
});
