// Duration and embedded chapters of a local audio file, read from its headers
// (never the whole file): MP4 audio (.m4b/.m4a) and MP3. Multi-file books need
// each part's length to play as one timeline, and a local file's own chapter
// marks are the only ones that line up with it exactly.
//
// MP4: duration from moov/mvhd; chapters from a QuickTime chapter track (a text
// track named by another track's tref/chap — what iTunes and most converters
// write) or else the Nero 'chpl' atom under moov/udta.
// MP3: chapters from ID3v2 CHAP frames; duration from the Xing/Info or VBRI
// header of the first frame, else TLEN, else the bitrate of a constant-rate file.
// Anything unreadable yields nulls, never an exception.
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_MOOV = 64 * 1024 * 1024; // a moov this large is not an audiobook's
const MAX_ID3 = 32 * 1024 * 1024;  // tags carry cover art; cap what we read

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

// ---- MP4 ---------------------------------------------------------------------

/** Child atoms of buf[start, end): [{ type, body: Buffer }]. */
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) { if (pos + 16 > end) break; size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) break;
    out.push({ type, body: buf.subarray(pos + hdr, pos + size) });
    pos += size;
  }
  return out;
}
const child = (buf, type) => boxes(buf).find((b) => b.type === type)?.body || null;
const childPath = (buf, ...types) => types.reduce((b, t) => (b ? child(b, t) : null), buf);

/** The moov atom of an MP4 file, located by walking top-level atom headers. */
async function readMoov(fh, size) {
  let pos = 0;
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return null;
    let len = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let hdr = 8;
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (len === 0) len = size - pos;
    if (len < hdr) return null;
    if (type === 'moov') return len - hdr > MAX_MOOV ? null : readAt(fh, pos + hdr, len - hdr);
    pos += len;
  }
  return null;
}

/** [timescale, duration] from an mvhd or mdhd body. */
function timing(body) {
  if (!body || body.length < 20) return [0, 0];
  if (body[0] === 1) return body.length >= 32 ? [body.readUInt32BE(20), Number(body.readBigUInt64BE(24))] : [0, 0];
  return [body.readUInt32BE(12), body.readUInt32BE(16)];
}
const trackId = (tkhd) => (!tkhd ? null : tkhd[0] === 1 ? tkhd.readUInt32BE(20) : tkhd.readUInt32BE(12));

function decodeText(b) {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const s = Buffer.from(b.subarray(2)); s.swap16(); return s.toString('utf16le');
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  return b.toString('utf8');
}

/** Chapters from a QuickTime chapter (text) track, as [{ title, start }]. */
async function quicktimeChapters(fh, moov) {
  const traks = boxes(moov).filter((b) => b.type === 'trak').map((b) => b.body);
  const chapIds = new Set();
  for (const t of traks) {
    const chap = childPath(t, 'tref', 'chap');
    if (chap) for (let i = 0; i + 4 <= chap.length; i += 4) chapIds.add(chap.readUInt32BE(i));
  }
  if (!chapIds.size) return null;
  const trak = traks.find((t) => chapIds.has(trackId(child(t, 'tkhd'))));
  if (!trak) return null;
  const [scale] = timing(childPath(trak, 'mdia', 'mdhd'));
  const stbl = childPath(trak, 'mdia', 'minf', 'stbl');
  if (!scale || !stbl) return null;
  const stts = child(stbl, 'stts'), stsz = child(stbl, 'stsz'), stsc = child(stbl, 'stsc');
  const stco = child(stbl, 'stco'), co64 = child(stbl, 'co64');
  if (!stts || !stsz || !stsc || !(stco || co64)) return null;
  // Sample start times.
  const times = [];
  let t = 0;
  for (let i = 0, n = stts.readUInt32BE(4); i < n; i++) {
    const count = stts.readUInt32BE(8 + i * 8), delta = stts.readUInt32BE(12 + i * 8);
    for (let k = 0; k < count && times.length < 5000; k++) { times.push(t); t += delta; }
  }
  // Sample sizes.
  const fixed = stsz.readUInt32BE(4), sampleCount = stsz.readUInt32BE(8);
  const sizes = Array.from({ length: Math.min(sampleCount, times.length) }, (_, i) => (fixed || stsz.readUInt32BE(12 + i * 4)));
  // Chunk offsets, then sample offsets via sample-to-chunk.
  const chunks = [];
  if (stco) for (let i = 0, n = stco.readUInt32BE(4); i < n; i++) chunks.push(stco.readUInt32BE(8 + i * 4));
  else for (let i = 0, n = co64.readUInt32BE(4); i < n; i++) chunks.push(Number(co64.readBigUInt64BE(8 + i * 8)));
  const runs = [];
  for (let i = 0, n = stsc.readUInt32BE(4); i < n; i++) runs.push({ first: stsc.readUInt32BE(8 + i * 12), per: stsc.readUInt32BE(12 + i * 12) });
  const offsets = [];
  for (let c = 0, s = 0; c < chunks.length && s < sizes.length; c++) {
    const run = runs.filter((r) => r.first <= c + 1).pop();
    let off = chunks[c];
    for (let k = 0; k < (run?.per || 1) && s < sizes.length; k++, s++) { offsets.push(off); off += sizes[s]; }
  }
  const out = [];
  for (let i = 0; i < offsets.length; i++) {
    const b = await readAt(fh, offsets[i], Math.min(sizes[i], 1024));
    if (b.length < 2) continue;
    const len = Math.min(b.readUInt16BE(0), b.length - 2);
    out.push({ title: decodeText(b.subarray(2, 2 + len)).trim(), start: times[i] / scale });
  }
  return out.length ? out : null;
}

/** Chapters from a Nero 'chpl' atom. Start times are in 100 ns units. */
function neroChapters(moov) {
  const chpl = childPath(moov, 'udta', 'chpl');
  if (!chpl || chpl.length < 5) return null;
  let p = 4;
  if (chpl[0] === 1) p += 4;
  const n = chpl[p++];
  const out = [];
  for (let i = 0; i < n && p + 9 <= chpl.length; i++) {
    const start = Number(chpl.readBigUInt64BE(p)) / 1e7; p += 8;
    const len = chpl[p++];
    out.push({ title: chpl.toString('utf8', p, p + len).trim(), start }); p += len;
  }
  return out.length ? out : null;
}

async function probeMp4(fh, size) {
  const moov = await readMoov(fh, size);
  if (!moov) return { duration: null, chapters: null };
  const [scale, units] = timing(child(moov, 'mvhd'));
  const duration = scale ? units / scale : null;
  const chapters = (await quicktimeChapters(fh, moov).catch(() => null)) || neroChapters(moov);
  return { duration, chapters };
}

// ---- MP3 ---------------------------------------------------------------------

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

function id3Text(b) {
  if (!b.length) return '';
  const enc = b[0], body = b.subarray(1);
  let s;
  if (enc === 0) s = body.toString('latin1');
  else if (enc === 3) s = body.toString('utf8');
  else if (enc === 2) { const x = Buffer.from(body.subarray(0, body.length & ~1)); x.swap16(); s = x.toString('utf16le'); }
  else s = decodeText(body.subarray(0, body.length & ~1)); // UTF-16 with a BOM
  return s.replace(/\0+$/, '').split('\0')[0].trim();
}

/** ID3v2.3/2.4 frames of a tag body: [{ id, data }]. */
function id3Frames(buf, major) {
  const out = [];
  let p = 0;
  while (p + 10 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = major === 4 ? syncsafe(buf, p + 4) : buf.readUInt32BE(p + 4);
    if (size <= 0 || p + 10 + size > buf.length) break;
    out.push({ id, data: buf.subarray(p + 10, p + 10 + size) });
    p += 10 + size;
  }
  return out;
}

const BITRATES = {
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** The first MPEG audio frame header at or after `from`. */
function frameAt(b, from) {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3, layerBits = (b[i + 1] >> 1) & 3;
    const brIdx = (b[i + 2] >> 4) & 15, srIdx = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const version = ver === 3 ? 1 : ver === 2 ? 2 : 25;
    const layer = 4 - layerBits;
    if (layer === 1) continue;
    const table = BITRATES[`${version === 1 ? 1 : 2}-${version === 1 ? layer : 3}`];
    const mono = ((b[i + 3] >> 6) & 3) === 3;
    return {
      at: i, version, layer, bitrate: table[brIdx] * 1000, rate: RATES[version][srIdx],
      spf: layer === 2 || version === 1 ? 1152 : 576,
      side: version === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17),
    };
  }
  return null;
}

async function probeMp3(fh, size) {
  const head = await readAt(fh, 0, 10);
  let audioStart = 0, chapters = null, tlen = null;
  if (head.length === 10 && head.toString('latin1', 0, 3) === 'ID3') {
    const major = head[3];
    const tagSize = syncsafe(head, 6);
    audioStart = 10 + tagSize + (head[5] & 0x10 ? 10 : 0);
    if (major >= 3 && tagSize <= MAX_ID3) {
      const tag = await readAt(fh, 10, tagSize);
      const list = [];
      for (const f of id3Frames(tag, major)) {
        if (f.id === 'TLEN') { const ms = Number(id3Text(f.data)); if (ms > 0) tlen = ms / 1000; }
        if (f.id !== 'CHAP') continue;
        const z = f.data.indexOf(0);
        if (z < 0 || z + 17 > f.data.length) continue;
        const startMs = f.data.readUInt32BE(z + 1);
        const sub = id3Frames(f.data.subarray(z + 17), major).find((s) => s.id === 'TIT2');
        list.push({ title: sub ? id3Text(sub.data) : '', start: startMs / 1000 });
      }
      if (list.length) chapters = list.sort((a, b) => a.start - b.start);
    }
  }
  const b = await readAt(fh, audioStart, 64 * 1024);
  const fr = frameAt(b, 0);
  let duration = null;
  if (fr) {
    const x = fr.at + 4 + fr.side;
    const tagAt = b.toString('latin1', x, x + 4);
    if ((tagAt === 'Xing' || tagAt === 'Info') && b.length >= x + 12 && (b.readUInt32BE(x + 4) & 1)) {
      duration = (b.readUInt32BE(x + 8) * fr.spf) / fr.rate;
    } else if (b.toString('latin1', fr.at + 36, fr.at + 40) === 'VBRI' && b.length >= fr.at + 54) {
      duration = (b.readUInt32BE(fr.at + 50) * fr.spf) / fr.rate; // 'VBRI', version, delay, quality, bytes, then frames
    }
    if (!duration && tlen) duration = tlen;
    if (!duration && fr.bitrate) duration = ((size - audioStart - fr.at) * 8) / fr.bitrate;
  } else if (tlen) duration = tlen;
  return { duration, chapters };
}

/** { duration: seconds | null, chapters: [{ title, start }] | null } */
export async function probeAudio(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const ext = path.extname(file).toLowerCase();
    const r = ext === '.mp3' ? await probeMp3(fh, size) : await probeMp4(fh, size);
    const duration = r.duration && Number.isFinite(r.duration) && r.duration > 0 ? Math.round(r.duration * 1000) / 1000 : null;
    const chapters = r.chapters && r.chapters.length
      ? r.chapters.filter((c) => Number.isFinite(c.start) && c.start >= 0).map((c) => ({ title: c.title || null, start: Math.round(c.start * 1000) / 1000 }))
      : null;
    return { duration, chapters: chapters && chapters.length ? chapters : null };
  } catch {
    return { duration: null, chapters: null };
  } finally {
    await fh?.close().catch(() => {});
  }
}
