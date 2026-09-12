import fs from 'node:fs/promises';
import path from 'node:path';

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
    if (!this.frames.has(frame)) return undefined;
    try { return await fs.readFile(path.join(this.frameDir, `${pad(frame)}.png`)); }
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
    await this.ready;
    if (this.writer || this.writerError || await exists(this.movieFile)) return;
    try {
      const create = streamFactory || (await import('../scripts/export-frames.mjs')).streamPngVideo;
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
}
