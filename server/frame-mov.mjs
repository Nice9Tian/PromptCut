import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';

const pad = n => String(n).padStart(6, '0');
const exists = file => fs.access(file).then(() => true, () => false);

async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

/**
 * Full-scene MOV cache.
 *
 * PNGs are the random-access side of the cache and the MOV is the sequential
 * side.  A small frame table is persisted separately so a missing frame can
 * be distinguished from a frame that has not been rendered yet.  The writer
 * consumes only a contiguous prefix (out-of-order see_frames requests stay on
 * disk until their gap is filled), which keeps the ffmpeg pipe bounded.
 */
export class MovFrameStore {
  constructor({ dir, fps = 30 } = {}) {
    this.dir = dir;
    this.fps = Number(fps) || 30;
    this.movDir = path.join(dir, 'mov');
    this.frameDir = path.join(this.movDir, 'frames');
    this.tableFile = path.join(this.movDir, 'frames.json');
    this.movieFile = path.join(this.movDir, 'full.mov');
    this.tempMovie = path.join(this.movDir, `full-${process.pid}.tmp.mov`);
    this.frames = new Set();
    this.pending = new Set();
    this.nextFrame = 0;
    this.writer = null;
    this.writerError = null;
    this.writeChain = Promise.resolve();
    this.tableDirty = false;
    this.ready = this.load();
  }

  async load() {
    const movieExists = await exists(this.movieFile);
    try {
      const doc = JSON.parse(await fs.readFile(this.tableFile, 'utf8'));
      if (doc && Array.isArray(doc.frames)) for (const n of doc.frames) if (Number.isSafeInteger(n) && n >= 0) this.frames.add(n);
    } catch {}
    // MOV frames live in their own directory. The old `frames/` directory is
    // an HTML/track raster cache and must never be mistaken for full-scene
    // media frames.
    try {
      for (const name of await fs.readdir(this.frameDir)) {
        const m = /^(\d{6})\.png$/.exec(name);
        if (m) this.frames.add(Number(m[1]));
      }
    } catch {}
    while (this.frames.has(this.nextFrame)) this.nextFrame++;
    // If the PNG side predates the MOV side (or MOV was interrupted), replay
    // the contiguous PNG prefix into the new stream once a writer is started.
    if (!movieExists) {
      this.nextFrame = 0;
      for (const frame of this.frames) this.pending.add(frame);
    }
    return this;
  }

  has(frame) { return this.frames.has(Number(frame)); }

  async get(frame) {
    await this.ready;
    frame = Number(frame);
    // The background service may have populated the shared cache since load.
    try {
      const buf = await fs.readFile(path.join(this.frameDir, `${pad(frame)}.png`));
      if (!this.frames.has(frame)) { this.frames.add(frame); if (frame >= this.nextFrame) this.pending.add(frame); this.tableDirty = true; }
      return buf;
    }
    catch { this.frames.delete(frame); this.tableDirty = true; return undefined; }
  }

  async persist() {
    if (!this.tableDirty) return;
    await atomic(this.tableFile, JSON.stringify({ version: 1, fps: this.fps, frames: [...this.frames].sort((a, b) => a - b), movie: path.basename(this.movieFile) }));
    this.tableDirty = false;
  }

  async put(frame, buffer) {
    await this.ready;
    frame = Number(frame);
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid MOV frame');
    return this.writeChain = this.writeChain.then(async () => {
      if (!this.frames.has(frame)) {
        await atomic(path.join(this.frameDir, `${pad(frame)}.png`), buffer);
        this.frames.add(frame);
        this.pending.add(frame);
        this.tableDirty = true;
      }
      // The common forward case goes directly from the in-memory screenshot
      // buffer into ffmpeg. The PNG remains the durable random-access copy.
      if (this.writer && frame === this.nextFrame && this.pending.has(frame)) {
        try {
          await this.writer.write(buffer);
          this.pending.delete(frame);
          this.nextFrame++;
        } catch (error) {
          this.writerError = error;
          await this.writer.abort().catch(() => {});
          this.writer = null;
        }
      }
      await this.flush();
      // Persist in small batches. A process crash can lose only the latest
      // batch; the PNGs are adopted automatically on the next load.
      if (this.tableDirty && (this.frames.size % 16 === 0 || !this.writer)) await this.persist();
    });
  }

  async start(ffmpeg, streamFactory) {
    if (this.starting) return this.starting;
    this.starting = this.startNow(ffmpeg, streamFactory).finally(() => { this.starting = null; });
    return this.starting;
  }
  async startNow(ffmpeg, streamFactory) {
    const epoch = this.streamEpoch;
    await this.ready;
    if (this.writer || this.writerError || await exists(this.movieFile)) return;
    try {
      const create = streamFactory || (await import('../scripts/export-frames.mjs')).streamPngVideo;
      if (epoch !== this.streamEpoch) return;
      this.writer = create(ffmpeg, this.tempMovie, this.fps);
      await this.flush();
    } catch (error) {
      // MOV is an optimization. Random PNG access remains valid when ffmpeg
      // is unavailable, so do not make see_frames fail for the stream alone.
      this.writerError = error;
      this.writer = null;
    }
  }

  async flush() {
    if (!this.writer) return;
    while (this.pending.has(this.nextFrame)) {
      const frame = this.nextFrame;
      const buffer = await fs.readFile(path.join(this.frameDir, `${pad(frame)}.png`));
      try { await this.writer.write(buffer); }
      catch (error) { this.writerError = error; await this.writer.abort().catch(() => {}); this.writer = null; return; }
      this.pending.delete(frame);
      this.nextFrame++;
    }
  }

  async finish() {
    await this.starting;
    await this.writeChain;
    await this.flush();
    if (this.writer) {
      try {
        if (this.pending.size) {
          // A sparse see_frames request may have no frame 0 yet. Never publish
          // a truncated movie; keep the PNG table and let a later request
          // start the stream once the gap is filled.
          await this.writer.abort();
          await fs.rm(this.tempMovie, { force: true });
          this.writer = null;
          await this.persist();
          return;
        }
        await this.writer.finish();
        await fs.rename(this.tempMovie, this.movieFile);
      } catch (error) {
        this.writerError = error;
        await fs.rm(this.tempMovie, { force: true }).catch(() => {});
      }
      this.writer = null;
    }
    await this.persist();
  }

  async close() { await this.finish(); }

  async suspend() {
    this.streamEpoch = (this.streamEpoch || 0) + 1;
    const writer = this.writer; this.writer = null;
    await writer?.abort().catch(() => {});
    await this.starting;
    await this.writeChain.catch(() => {});
    this.nextFrame = 0; this.pending = new Set(this.frames);
    await this.persist();
  }
}

const u32 = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const atom = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type), body]); };
const matrix = () => u32(65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000);

/** A complete, sparse PNG MOV. Every unfilled sample references ONE transparent
 * PNG. Screenshots append to mdat, then their sample-table entries are patched.
 * No encoder, frame-sized holes, or second Chrome/render path is involved.
 * The live reader uses published immutable byte ranges, never a half-patched
 * table. Ordinary MOV readers can open the file at any completed write. */
export class PlaybackMovStore {
  constructor({ dir, width, height, fps = 30, count }) {
    this.fps = fps; this.count = count;
    this.width = width; this.height = height;
    this.name = `playback-${randomUUID()}.mov`;
    this.movieFile = path.join(dir, 'mov', this.name);
    this.samples = new Map();
    this.writeChain = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    const { width, height, count, fps } = this;
    if (![width, height, count].every(n => Number.isSafeInteger(n) && n > 0) || width > 65535 || height > 65535 || count > 10000000 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid playback movie dimensions');
    const transparent = PNG.sync.write(new PNG({ width, height }));
    const timescale = Math.round(fps * 1000), duration = count * 1000;
    if (duration > 0xffffffff || timescale > 0xffffffff) throw new Error('Playback movie duration is too large');
    const mvhd = atom('mvhd', u32(0, 0, 0, timescale, duration, 65536, 0x01000000), Buffer.alloc(8), matrix(), Buffer.alloc(24), u32(2));
    const tkhd = atom('tkhd', u32(7, 0, 0, 1, 0, duration), Buffer.alloc(16), matrix(), u32(width * 65536, height * 65536));
    const mdhd = atom('mdhd', u32(0, 0, 0, timescale, duration, 0));
    const hdlr = atom('hdlr', u32(0, 0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('PromptCut playback\0'));
    const sample = Buffer.alloc(78);
    sample.writeUInt16BE(1, 6); sample.writeUInt16BE(width, 24); sample.writeUInt16BE(height, 26);
    sample.writeUInt32BE(72 * 65536, 28); sample.writeUInt32BE(72 * 65536, 32);
    sample.writeUInt16BE(1, 40); sample.writeUInt16BE(32, 74); sample.writeInt16BE(-1, 76);
    const stsz = atom('stsz', u32(0, 0, count), Buffer.alloc(count * 4));
    const co64 = atom('co64', u32(0, count), Buffer.alloc(count * 8));
    const stbl = atom('stbl', atom('stsd', u32(0, 1), atom('png ', sample)), atom('stts', u32(0, 1, count, 1000)),
      atom('stsc', u32(0, 1, 1, 1, 1)), stsz, co64);
    const minf = atom('minf', atom('vmhd', u32(1, 0, 0)), atom('dinf', atom('dref', u32(0, 1), atom('url ', u32(1)))), stbl);
    const moov = atom('moov', mvhd, atom('trak', tkhd, atom('mdia', mdhd, hdlr, minf)));
    const header = Buffer.concat([atom('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  ')), moov, u32(0), Buffer.from('mdat')]);
    // The uniquely constructed table atoms are located before any PNG bytes.
    this.sizeTable = header.indexOf(Buffer.from('stsz')) + 16;
    this.offsetTable = header.indexOf(Buffer.from('co64')) + 12;
    this.placeholder = { offset: header.length, size: transparent.length };
    for (let n = 0; n < count; n++) {
      header.writeUInt32BE(transparent.length, this.sizeTable + n * 4);
      header.writeBigUInt64BE(BigInt(header.length), this.offsetTable + n * 8);
    }
    await fs.mkdir(path.dirname(this.movieFile), { recursive: true });
    this.file = await fs.open(this.movieFile, 'wx+');
    await this.writeAt(header, 0); await this.writeAt(transparent, header.length);
    this.end = header.length + transparent.length;
  }
  async writeAt(buffer, position) {
    let written = 0;
    while (written < buffer.length) {
      const { bytesWritten } = await this.file.write(buffer, written, buffer.length - written, position + written);
      if (!bytesWritten) throw new Error('Playback MOV write made no progress');
      written += bytesWritten;
    }
  }
  has(frame) { return this.samples.has(frame); }
  async put(frame, buffer) {
    await this.ready;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= this.count) throw new Error('Invalid playback frame');
    const work = this.writeChain.then(async () => {
      if (this.samples.has(frame) || this.closed) return;
      const offset = this.end;
      await this.writeAt(buffer, offset);
      this.end += buffer.length;
      const encodedOffset = Buffer.alloc(8); encodedOffset.writeBigUInt64BE(BigInt(offset));
      await this.writeAt(u32(buffer.length), this.sizeTable + frame * 4);
      await this.writeAt(encodedOffset, this.offsetTable + frame * 8);
      this.samples.set(frame, { offset, size: buffer.length });
    });
    this.writeChain = work.catch(() => {});
    return work;
  }
  index(start, end) {
    const frames = [];
    for (let frame = Math.max(0, start); frame <= Math.min(this.count - 1, end); frame++) {
      const sample = this.samples.get(frame);
      if (sample) frames.push({ frame, ...sample });
    }
    return { fps: this.fps, count: this.count, width: this.width, height: this.height, placeholder: this.placeholder, frames };
  }
  async close() { await this.ready; await this.writeChain; this.closed = true; await this.file?.close(); }
}
