// Media handler: an audiobook a download source fetched is moved into the
// library as Author/Title (a single file) or Author/Title/<parts> and
// catalogued like a scanned one, named from the asker's hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openAudiobooksStore } from '../store.js';
import { fileAudiobook, makeMediaHandler, destinationsFor } from '../importer.js';

function setup() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-import-'));
  const shelf = path.join(p, 'shelf');
  const dl = path.join(p, 'downloads');
  fs.mkdirSync(shelf, { recursive: true });
  fs.mkdirSync(dl, { recursive: true });
  const dbPath = path.join(p, 'cat.db');
  const core = openDb(dbPath);
  core.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Audiobooks', 'audiobook', ?, 0)").run(shelf);
  core.close();
  const store = openAudiobooksStore(dbPath);
  const rm = () => { store.db.close(); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* reaped later */ } };
  return { shelf, dl, store, rm };
}

test('a single-file download files as Author/Title.m4b and catalogs one issue', async () => {
  const { shelf, dl, store, rm } = setup();
  try {
    const src = path.join(dl, 'Brandon.Sanderson.The.Way.of.Kings.M4B-GRP.m4b');
    fs.writeFileSync(src, Buffer.alloc(4096));
    const handler = makeMediaHandler({ store, getClients: () => [] });
    assert.equal(handler.type, 'audiobook');
    const out = await handler.file({ path: dl, files: [src], libraryId: 1, hint: { title: 'The Way of Kings', author: 'Brandon Sanderson', year: '2010' } });
    const dest = path.join(shelf, 'Brandon Sanderson', 'The Way of Kings.m4b');
    assert.equal(out.path, dest);
    assert.ok(fs.existsSync(dest) && !fs.existsSync(src), 'moved into the library');
    const s = store.db.prepare("SELECT * FROM series WHERE type='audiobook'").get();
    assert.equal(s.title, 'The Way of Kings');
    assert.equal(s.publisher, 'Brandon Sanderson');
    const i = store.db.prepare('SELECT * FROM issues WHERE id=?').get(out.issueId);
    assert.equal(i.file_path, dest);
    assert.equal(i.series_id, out.seriesId);
    // The same book again lands as a numbered sibling, not over the first.
    const again = path.join(dl, 'again.m4b');
    fs.writeFileSync(again, Buffer.alloc(10));
    const out2 = await fileAudiobook({ store, files: [again], libraryId: 1, hint: { title: 'The Way of Kings', author: 'Brandon Sanderson' } });
    assert.equal(out2.path, path.join(shelf, 'Brandon Sanderson', 'The Way of Kings (2).m4b'));
  } finally { rm(); }
});

test('a multi-part download files as Author/Title/<parts>; the best format wins over loose parts', async () => {
  const { shelf, dl, store, rm } = setup();
  try {
    const rel = path.join(dl, 'release');
    fs.mkdirSync(rel);
    const parts = ['10.mp3', '2.mp3', '1.mp3'].map((n) => { const f = path.join(rel, n); fs.writeFileSync(f, Buffer.alloc(100)); return f; });
    const out = await fileAudiobook({ store, files: parts, libraryId: 1, hint: { title: 'Dune', author: 'Frank Herbert, Someone Else' } });
    const dir = path.join(shelf, 'Frank Herbert', 'Dune');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['1.mp3', '10.mp3', '2.mp3']);
    assert.equal(out.path, path.join(dir, '1.mp3'), 'the first part in natural order');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM audiobooks_files').get().n, 3);

    // An m4b next to loose mp3 parts is the book; the parts are leftovers.
    const rel2 = path.join(dl, 'release2');
    fs.mkdirSync(rel2);
    const m4b = path.join(rel2, 'book.m4b'); fs.writeFileSync(m4b, Buffer.alloc(100));
    const mp3 = path.join(rel2, '01.mp3'); fs.writeFileSync(mp3, Buffer.alloc(100));
    const out2 = await fileAudiobook({ store, files: [mp3, m4b], libraryId: 1, hint: { title: 'Elantris', author: 'Brandon Sanderson' } });
    assert.equal(out2.path, path.join(shelf, 'Brandon Sanderson', 'Elantris.m4b'));
    assert.ok(fs.existsSync(mp3), 'the loose part is left where it was');

    await assert.rejects(() => fileAudiobook({ store, files: [path.join(dl, 'missing.m4b')], libraryId: 1 }), /no audio files/);
  } finally { rm(); }
});

test('destinationsFor: reserved characters are stripped, a missing hint falls back to the file name', () => {
  const lib = { folders: ['/lib'] };
  const [one] = destinationsFor(lib, ['/dl/x.m4b'], { title: 'What: Now?', author: 'A/B' });
  assert.equal(one, path.join('/lib', 'A B', 'What Now.m4b'));
  const [two] = destinationsFor(lib, ['/dl/Some Book.mp3', '/dl/b.mp3'], {});
  assert.equal(two, path.join('/lib', 'Unknown Author', 'Some Book', 'Some Book.mp3'));
});
