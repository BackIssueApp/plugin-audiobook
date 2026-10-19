// The home page's Continue listening rail asks /api/collection for a status-only
// filter ({"status":"reading"}). This plugin answers it itself, so the rail
// works without the Shelves plugin: per user, only for audiobook libraries,
// and leaving richer selections to Shelves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('status-only filter: reading / finished / unread per user, audiobook libraries only', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';
  const { openDb } = await import('../../../src/db.js');
  const { pluginApi, registeredCollectionFilters } = await import('../../../src/plugins.js');
  const config = (await import('../../../src/config.js')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-rails-'));
  const oldDbPath = config.dbPath;
  try {
    config.dbPath = path.join(dir, 'cat.db');
    const db = openDb(config.dbPath);
    const lib = db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Audiobooks', 'audiobook', ?, 0)").run(dir).lastInsertRowid;
    const comics = db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Comics', 'comic', ?, 1)").run(dir).lastInsertRowid;
    const book = (title) => {
      const s = db.prepare("INSERT INTO series (title, url, type, library_id) VALUES (?, ?, 'audiobook', ?)").run(title, 'local:' + title, lib).lastInsertRowid;
      const i = db.prepare('INSERT INTO issues (series_id, title, url) VALUES (?, ?, ?)').run(s, title, 'local:i:' + title).lastInsertRowid;
      return { s: Number(s), i: Number(i) };
    };
    const [midway, nearEnd, done, untouched] = ['Midway', 'Near End', 'Done', 'Untouched'].map(book);

    (await import('../index.js')).default(pluginApi);
    const filter = registeredCollectionFilters().find((f) => f.id === 'audiobooks-status');
    assert.ok(filter, 'the plugin registers its status filter');

    const put = db.prepare('INSERT INTO audiobooks_progress (user_id, issue_id, position, duration, finished) VALUES (?, ?, ?, ?, ?)');
    put.run(7, midway.i, 600, 3600, 0);
    put.run(7, nearEnd.i, 3590, 3600, 0); // within the last 30 seconds counts as finished
    put.run(7, done.i, 0, 3600, 1);
    put.run(8, untouched.i, 100, 3600, 0); // someone else's progress

    const ask = (status, extra = {}) => filter.resolve({ status, ...extra }, { db, userId: 7, library: lib });
    const sorted = (a) => (a ? [...a].sort((x, y) => x - y) : a);
    assert.deepEqual(ask('reading'), [midway.s]);
    assert.deepEqual(sorted(ask('finished')), sorted([nearEnd.s, done.s]));
    assert.deepEqual(ask('unread'), [untouched.s], "another user's progress does not count");
    // A core that takes exclusions gets only the begun books, not every unread one.
    const begun = filter.resolve({ status: 'unread' }, { db, userId: 7, library: lib, canExclude: true });
    assert.deepEqual(sorted(begun.excludeIds), sorted([midway.s, nearEnd.s, done.s]));
    assert.equal(ask('reading', { authors: [3] }), null, 'richer selections are left to Shelves');
    assert.equal(ask('bogus'), null);
    assert.equal(filter.resolve({ status: 'reading' }, { db, userId: 7, library: comics }), null, 'not for other library types');
    assert.equal(filter.resolve({ status: 'reading' }, { db, userId: 7, library: null }), null);
    db.close();
  } finally {
    config.dbPath = oldDbPath;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reaped later */ }
  }
});

test('finished: the last two minutes, or the last 1% of a long book, never more than the last 10%', async () => {
  const { isFinished } = await import('../store.js');
  const tenHours = 36000;
  assert.equal(isFinished(tenHours * 0.99, tenHours), true, '99% of a ten-hour book (six minutes left) is finished');
  assert.equal(isFinished(tenHours * 0.98, tenHours), false);
  assert.equal(isFinished(3600 - 100, 3600), true, 'an hour-long book with 100 seconds left is finished');
  assert.equal(isFinished(3600 - 200, 3600), false);
  assert.equal(isFinished(5, 60), false, 'a one-minute clip is not finished five seconds in');
  assert.equal(isFinished(55, 60), true, 'but is in its last 10%');
  assert.equal(isFinished(100, 0), false, 'no duration, no verdict');
});

test('store: Remove from Continue listening resets every part of the series for that user only', async () => {
  const { openDb } = await import('../../../src/db.js');
  const { openAudiobooksStore } = await import('../store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-reset-'));
  try {
    const dbPath = path.join(dir, 'cat.db');
    const core = openDb(dbPath);
    const s = Number(core.prepare("INSERT INTO series (title, url, type) VALUES ('Saga', 'local:saga', 'audiobook')").run().lastInsertRowid);
    const parts = [1, 2].map((n) => Number(core.prepare('INSERT INTO issues (series_id, title, url) VALUES (?, ?, ?)').run(s, 'Part ' + n, 'local:saga:' + n).lastInsertRowid));
    core.close();
    const store = openAudiobooksStore(dbPath);
    store.setProgress(1, parts[0], { position: 900, duration: 3600 });
    store.setProgress(1, parts[1], { position: 50, duration: 3600 });
    store.setProgress(2, parts[0], { position: 700, duration: 3600 });
    assert.equal(store.resetSeriesProgress(1, s), 2);
    assert.equal(store.getProgress(1, parts[0]).position, 0);
    assert.equal(store.getProgress(1, parts[1]).position, 0);
    assert.equal(store.getProgress(2, parts[0]).position, 700, "another user's progress is untouched");
    // A row saved under the old 30-second rule is caught up when the store opens.
    store.db.prepare('UPDATE audiobooks_progress SET position=?, duration=?, finished=0 WHERE user_id=2').run(35640, 36000);
    store.db.close();
    const again = openAudiobooksStore(dbPath);
    assert.equal(again.getProgress(2, parts[0]).finished, 1, 'backfilled to finished');
    again.db.close();
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reaped later */ } }
});
