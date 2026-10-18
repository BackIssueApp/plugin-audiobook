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
