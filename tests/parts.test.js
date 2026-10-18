// Multi-file audiobooks and local chapters: a book folder's files become ONE
// book with parts in play order, each file's length and chapter marks are read
// from its headers, progress and bookmarks from the files' old one-entry-each
// days move onto the book at the right place, and the stream serves a part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAudio } from '../audiometa.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny synthetic files ---------------------------------------------------
const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
function id3Frame(id, data) { return Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(data.length), Buffer.alloc(2), data]); }
const tit2 = (s) => id3Frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]));
/** An MP3: optional ID3v2.4 CHAP frames, then one MPEG-1 Layer III frame
 *  carrying a Xing header whose frame count says `seconds`. */
function mp3(seconds, chapters = []) {
  let tag = Buffer.alloc(0);
  if (chapters.length) {
    const frames = chapters.map((c, i) => {
      const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
      return id3Frame('CHAP', Buffer.concat([Buffer.from(`ch${i}\0`, 'latin1'), u32(c.start * 1000), u32((c.end ?? c.start + 1) * 1000), u32(0xffffffff), u32(0xffffffff), tit2(c.title)]));
    });
    const body = Buffer.concat(frames);
    tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
  }
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);           // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo
  frame.write('Xing', 4 + 32, 'latin1');          // after 32 bytes of side info
  frame.writeUInt32BE(1, 4 + 32 + 4);             // flags: frame count present
  frame.writeUInt32BE(Math.round((seconds * 44100) / 1152), 4 + 32 + 8);
  return Buffer.concat([tag, frame]);
}
/** An MP4 with only what the probe reads: mvhd and a Nero chpl atom. */
function mp4Nero(seconds, chapters) {
  const box = (type, ...parts) => { const body = Buffer.concat(parts); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(seconds * 1000, 16);
  const entries = chapters.map((c) => { const t = Buffer.from(c.title, 'utf8'); const s = Buffer.alloc(9); s.writeBigUInt64BE(BigInt(Math.round(c.start * 1e7))); s[8] = t.length; return Buffer.concat([s, t]); });
  const chpl = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(4), Buffer.from([chapters.length]), ...entries]);
  return Buffer.concat([box('ftyp', Buffer.from('M4B 0000', 'latin1')), box('moov', box('mvhd', mvhd), box('udta', box('chpl', chpl)))]);
}

test('probe: durations and chapter marks from MP3, Nero MP4 and QuickTime chapter tracks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-probe-'));
  fs.writeFileSync(path.join(dir, 'a.mp3'), mp3(600, [{ start: 0, title: 'Opening' }, { start: 245, title: 'Second' }]));
  fs.writeFileSync(path.join(dir, 'b.m4b'), mp4Nero(90, [{ start: 0, title: 'Uno' }, { start: 42.5, title: 'Dos' }]));
  const a = await probeAudio(path.join(dir, 'a.mp3'));
  assert.ok(Math.abs(a.duration - 600) < 0.1, `mp3 duration ${a.duration}`);
  assert.deepEqual(a.chapters, [{ title: 'Opening', start: 0 }, { title: 'Second', start: 245 }]);
  const b = await probeAudio(path.join(dir, 'b.m4b'));
  assert.equal(b.duration, 90);
  assert.deepEqual(b.chapters, [{ title: 'Uno', start: 0 }, { title: 'Dos', start: 42.5 }]);
  // Made by ffmpeg: a QuickTime text track named by the audio track's tref/chap.
  const q = await probeAudio(path.join(HERE, 'fixtures', 'qt-chapters.m4b'));
  assert.ok(Math.abs(q.duration - 4) < 0.1, `m4b duration ${q.duration}`);
  assert.deepEqual(q.chapters, [{ title: 'Prologue', start: 0 }, { title: 'The Long Road', start: 1.5 }]);
  assert.deepEqual(await probeAudio(path.join(dir, 'missing.mp3')), { duration: null, chapters: null });
});

test('scan: a book folder becomes one book with parts; old per-file progress and bookmarks move onto it', async () => {
  process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
  process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';
  const { openDb } = await import('../../../src/db.js');
  const { pluginApi, registeredRoutes } = await import('../../../src/plugins.js');
  const config = (await import('../../../src/config.js')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-parts-'));
  config.dbPath = path.join(dir, 'cat.db');
  config.metadataInstanceKey = '';
  const db = openDb(config.dbPath);
  const root = path.join(dir, 'audio');
  const book = path.join(root, 'Frank Herbert', 'Dune');
  fs.mkdirSync(book, { recursive: true });
  // Natural order: "Part 2" before "Part 10"; part 2 carries its own chapters.
  fs.writeFileSync(path.join(book, 'Dune - Part 1.mp3'), mp3(100));
  fs.writeFileSync(path.join(book, 'Dune - Part 2.mp3'), mp3(200, [{ start: 0, title: 'Muad’Dib' }, { start: 50, title: 'The Desert' }]));
  fs.writeFileSync(path.join(book, 'Dune - Part 10.mp3'), mp3(300));
  // A single-file book beside it stays a single file.
  fs.writeFileSync(path.join(root, 'Frank Herbert', 'Short Story.mp3'), mp3(60, [{ start: 0, title: 'Only' }]));
  const lib = Number(db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Audiobooks', 'audiobook', ?, 0)").run(root).lastInsertRowid);

  (await import('../index.js')).default(pluginApi);
  const { openAudiobooksStore } = await import('../store.js');
  const store = openAudiobooksStore(config.dbPath);
  const { scanLibraries } = await import('../scanner.js');

  // How earlier versions catalogued the folder: one entry per file. Someone
  // listened 30s into "Part 2" and bookmarked 40s.
  const files = ['Dune - Part 1.mp3', 'Dune - Part 2.mp3', 'Dune - Part 10.mp3'].map((f) => path.join(book, f));
  const old = files.map((f) => store.catalogFile({ libraryId: lib, path: f, format: 'mp3', size: 1, mtime: 1, meta: { title: 'Dune', author: 'Frank Herbert', title_source: 'filename' } }).issueId);
  assert.equal(new Set(old).size, 3, 'the old layout: an entry per file');
  store.setProgress(5, old[1], { position: 30, duration: 200 });
  db.prepare('INSERT INTO audiobooks_bookmarks (user_id, issue_id, position, note) VALUES (5, ?, 40, ?)').run(old[1], 'here');

  await scanLibraries({ store, log: () => {} });

  const rows = db.prepare('SELECT path, issue_id, part, file_duration FROM audiobooks_files WHERE library_id=? ORDER BY path').all(lib);
  const duneRows = rows.filter((r) => r.path.startsWith(book));
  assert.equal(new Set(duneRows.map((r) => r.issue_id)).size, 1, 'one book');
  const issueId = duneRows[0].issue_id;
  const tl = store.bookTimeline(issueId);
  assert.deepEqual(tl.parts.map((p) => [p.part, Math.round(p.start), Math.round(p.duration)]), [[1, 0, 100], [2, 100, 200], [3, 300, 300]], 'natural order, cumulative starts');
  assert.equal(Math.round(tl.duration), 600);
  assert.deepEqual(tl.chapters.map((c) => [c.title, Math.round(c.start), c.part ?? null]),
    [[null, 0, 1], ['Muad’Dib', 100, null], ['The Desert', 150, null], [null, 300, 3]], 'embedded marks in book time; bare parts become a chapter each');
  for (const id of old) assert.equal(db.prepare('SELECT 1 x FROM issues WHERE id=?').get(id) && id !== issueId ? 'left' : 'gone', 'gone', 'old entries retired');
  assert.equal(Math.round(store.getProgress(5, issueId).position), 130, 'progress moved to part 2’s place in the book');
  assert.equal(Math.round(db.prepare('SELECT position FROM audiobooks_bookmarks WHERE user_id=5').get().position), 140);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issues i JOIN series s ON s.id=i.series_id WHERE s.library_id=?').get(lib).n, 2, 'Dune and the short story');

  const single = rows.find((r) => r.path.endsWith('Short Story.mp3'));
  assert.equal(single.part, null);
  assert.deepEqual(store.bookTimeline(single.issue_id).chapters, [{ title: 'Only', start: 0 }], 'a single local file keeps its own chapters');

  // A rescan with nothing changed leaves everything alone.
  const before = db.prepare('SELECT COUNT(*) n FROM audiobooks_files').get().n;
  await scanLibraries({ store, log: () => {} });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audiobooks_files').get().n, before);
  assert.equal(db.prepare('SELECT issue_id FROM audiobooks_files WHERE path=?').get(files[2]).issue_id, issueId);

  // The info and chapters routes speak in book time; the stream serves a part.
  const route = (m, p) => registeredRoutes().find((r) => r.method === m && r.path === p).handler;
  const call = (m, p, req) => new Promise((resolve) => {
    const res = {
      code: 200, headers: {}, status(c) { this.code = c; return this; }, json: (b) => resolve({ code: res.code, body: b }),
      end: () => resolve({ code: res.code }), sendFile: (f) => resolve({ code: res.code, file: f }), set() { return this; }, setHeader() {},
    };
    route(m, p)({ params: {}, query: {}, headers: {}, user: { id: 5 }, ...req }, res);
  });
  const info = (await call('get', '/api/audiobooks/info', { query: { issues: String(issueId) } })).body.info[issueId];
  assert.equal(Math.round(info.duration), 600);
  assert.equal(info.parts.length, 3);
  const ch = (await call('get', '/api/audiobooks/issue/:id/chapters', { params: { id: String(issueId) } })).body;
  assert.equal(ch.parts.length, 3);
  assert.equal((await call('get', '/api/audiobooks/issue/:id/stream', { params: { id: String(issueId) }, query: { part: '3' } })).file, files[2]);
  assert.equal((await call('get', '/api/audiobooks/issue/:id/stream', { params: { id: String(issueId) } })).file, files[0], 'no part: the first');

  // One part going missing keeps the book (and the listener's place).
  fs.rmSync(files[2]);
  await scanLibraries({ store, log: () => {} });
  assert.ok(db.prepare('SELECT 1 x FROM issues WHERE id=?').get(issueId), 'the book stays');
  assert.equal(store.bookTimeline(issueId).parts.length, 2);
  assert.ok(store.getProgress(5, issueId).position > 0);
});
