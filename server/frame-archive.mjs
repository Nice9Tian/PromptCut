import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Version 2 stores independently compressed 60 second blocks. A complete
 * checkpoint is kept every 10 seconds; frames between checkpoints only carry
 * a prefix/suffix delta. The outer archive remains one gzip/base64 field.
 */
export const FRAME_ARCHIVE_VERSION = 2;
export const FRAME_CHECKPOINT_SECONDS = 10;
export const FRAME_BLOCK_SECONDS = 60;
const MAX_EXPANDED_FRAMES = 16;

const asEntries = value => value instanceof Map ? [...value.entries()] : [...(value || [])];
const b64 = value => Buffer.from(value).toString('base64');
const unb64 = value => Buffer.from(value, 'base64');

function delta(previous, html) {
  let prefix = 0, suffix = 0;
  while (prefix < previous.length && prefix < html.length && previous[prefix] === html[prefix]) prefix++;
  while (suffix < previous.length - prefix && suffix < html.length - prefix && previous[previous.length - suffix - 1] === html[html.length - suffix - 1]) suffix++;
  return [prefix, suffix, html.slice(prefix, html.length - suffix)];
}

function materializeBlock(block) {
  let previous = '';
  const values = new Map();
  for (const record of decodeBlock(block)) {
    const frame = Number(record[0]);
    previous = apply(previous, record);
    values.set(frame, previous);
  }
  return values;
}

function apply(previous, record) {
  if (record[1] === 1) {
    if (typeof record[4] !== 'string') throw new Error('Corrupt frame checkpoint');
    return record[4];
  }
  const [, , prefix, suffix, middle] = record;
  if (!Number.isSafeInteger(prefix) || !Number.isSafeInteger(suffix) || prefix < 0 || suffix < 0 || prefix + suffix > previous.length || typeof middle !== 'string') throw new Error('Corrupt frame delta');
  return previous.slice(0, prefix) + middle + (suffix ? previous.slice(-suffix) : '');
}

function encodeBlocks(frames, { fps = 30, checkpointSeconds = FRAME_CHECKPOINT_SECONDS, blockSeconds = FRAME_BLOCK_SECONDS } = {}) {
  // Loading an existing v2 archive and saving it again should not inflate all
  // blocks just to recompress the unchanged portion. New samples are kept in
  // `overlay`; only that uncommon case needs materialization.
  if (frames instanceof LazyFrameStore) {
    if (frames.overlay.size === 0 && frames.pendingSpill.size === 0) return frames.blocks;
    const pending = frames.pendingEntries();
    const merged = [];
    const ranges = [...frames.blocks].sort((a, b) => a.start - b.start);
    for (const block of frames.blocks) {
      const affected = [...pending.keys()].filter(frame => frame >= block.start && frame <= block.end);
      if (!affected.length) { merged.push(block); continue; }
      const values = materializeBlock(block);
      for (const frame of affected) { values.set(frame, pending.get(frame)); pending.delete(frame); }
      merged.push(...encodeBlocks(values, { fps, checkpointSeconds, blockSeconds }));
    }
    // Do not let a sparse pending range bridge across an existing block: that
    // would create overlapping blocks and make a later binary lookup choose
    // the wrong stream. Split at every old block boundary instead.
    let segment = [], previousFrame;
    for (const frame of [...pending.keys()].sort((a, b) => a - b)) {
      if (previousFrame !== undefined && ranges.some(range => previousFrame < range.start && range.start <= frame)) {
        merged.push(...encodeBlocks(segment, { fps, checkpointSeconds, blockSeconds }));
        segment = [];
      }
      segment.push([frame, pending.get(frame)]);
      previousFrame = frame;
    }
    if (segment.length) merged.push(...encodeBlocks(segment, { fps, checkpointSeconds, blockSeconds }));
    return merged.sort((a, b) => a.start - b.start);
  }
  const sorted = asEntries(frames).filter(([n, html]) => Number.isSafeInteger(Number(n)) && typeof html === 'string')
    .map(([n, html]) => [Number(n), html]).sort(([a], [b]) => a - b);
  if (!sorted.length) return [];
  const checkpointEvery = Math.max(1, Math.round(Number(fps) * Number(checkpointSeconds)) || 1);
  const blockEvery = Math.max(checkpointEvery, Math.round(Number(fps) * Number(blockSeconds)) || checkpointEvery);
  const blocks = [];
  for (let at = 0; at < sorted.length;) {
    const start = sorted[at][0], endLimit = start + blockEvery, records = [];
    let previous = '', checkpointFrame = -Infinity;
    while (at < sorted.length && sorted[at][0] < endLimit) {
      const [frame, html] = sorted[at++];
      const checkpoint = records.length === 0 || frame - checkpointFrame >= checkpointEvery;
      const [prefix, suffix, middle] = checkpoint ? [0, 0, html] : delta(previous, html);
      records.push([frame, checkpoint ? 1 : 0, prefix, suffix, middle]);
      previous = html;
      if (checkpoint) checkpointFrame = frame;
    }
    blocks.push({ start: records[0][0], end: records[records.length - 1][0], index: records.map(record => record[0]), data: b64(gzipSync(Buffer.from(JSON.stringify(records), 'utf8'))) });
  }
  return blocks;
}

function decodeBlock(block) {
  let records;
  try { records = JSON.parse(gunzipSync(unb64(block.data), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8')); }
  catch { throw new Error('Corrupt frame archive block'); }
  if (!Array.isArray(records)) throw new Error('Corrupt frame archive block');
  return records;
}

function findBlock(blocks, frame) {
  let selected = null;
  for (const block of blocks) {
    if (frame < block.start) break;
    selected = block;
    if (frame <= block.end) break;
  }
  return selected;
}

/** Lazy Map-like store. Only the block containing a requested frame is inflated. */
function controlDirectoryName(id) {
  // Control ids are project data. Keep them out of the filesystem path while
  // still making the directory stable across archive reopen/save cycles.
  return createHash('sha1').update(String(id)).digest('hex');
}

function prepareSpillDirectory(spillDir, encoded) {
  if (!spillDir) return;
  const dir = path.resolve(spillDir);
  const marker = path.join(dir, '.archive-sha256');
  const signature = createHash('sha256').update(String(encoded)).digest('hex');
  try {
    const previous = fs.readFileSync(marker, 'utf8').trim();
    if (previous !== signature) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Missing marker means the directory may contain an older archive's spill.
    // Clearing it avoids returning stale HTML after an import or rebuild.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Disposable cache. */ }
  }
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, signature); } catch { /* Spill remains optional. */ }
}

export class LazyFrameStore {
  constructor(blocks = [], { spillDir = null } = {}) {
    this.blocks = blocks;
    this.spillDir = spillDir ? path.resolve(spillDir) : null;
    this.cache = new Map();
    this.decoded = new Map();
    this.overlay = new Map();
    // A live sampler can produce more frames than the in-memory window before
    // the next archive flush. Keep those pending values on disk too, while
    // retaining their frame numbers so packFrames can fold them back in.
    this.pendingSpill = new Set();
    this.index = new Set(blocks.flatMap(block => block.index || []));
    for (const block of blocks) if (!block.index) for (let n = block.start; n <= block.end; n++) this.index.add(n);
  }
  get size() { return this.index.size + [...this.overlay.keys()].filter(n => !this.index.has(n)).length; }
  has(frame) { return this.overlay.has(Number(frame)) || this.index.has(Number(frame)); }
  spillPath(frame) {
    return this.spillDir ? path.join(this.spillDir, `${Number(frame)}.html.gz`) : null;
  }
  removeSpill(frame) {
    const file = this.spillPath(frame);
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch { /* Disposable cache. */ }
  }
  writeSpill(frame, value) {
    const file = this.spillPath(frame);
    if (!file || typeof value !== 'string') return false;
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.mkdirSync(this.spillDir, { recursive: true });
      fs.writeFileSync(temp, gzipSync(Buffer.from(value, 'utf8')));
      fs.renameSync(temp, file);
      return true;
    } catch {
      try { fs.rmSync(temp, { force: true }); } catch { /* Best effort cleanup. */ }
      // Unsaved samples have no archive fallback: callers must retain them
      // in memory until a later spill or archive save succeeds.
      return false;
    }
  }
  readSpill(frame) {
    const file = this.spillPath(frame);
    if (!file) return undefined;
    try {
      return gunzipSync(fs.readFileSync(file), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8');
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* Disposable cache. */ }
      return undefined;
    }
  }
  set(frame, value) {
    frame = Number(frame);
    this.overlay.set(frame, value);
    this.index.add(frame);
    // A newly sampled frame supersedes any previously spilled expansion.
    this.removeSpill(frame);
    this.pendingSpill.delete(frame);
    this.cache.delete(frame);
    while (this.overlay.size > MAX_EXPANDED_FRAMES) {
      const old = this.overlay.keys().next().value;
      const oldValue = this.overlay.get(old);
      if (!this.writeSpill(old, oldValue)) break;
      this.overlay.delete(old);
      this.pendingSpill.add(old);
    }
    return this;
  }
  pendingEntries() {
    const values = new Map(this.overlay);
    for (const frame of this.pendingSpill) {
      if (!values.has(frame)) {
        const value = this.readSpill(frame);
        if (value === undefined) throw new Error(`HTML frame cache ${frame} is missing or unreadable; rebuild the frame cache before saving.`);
        values.set(frame, value);
      }
    }
    return values;
  }
  get(frame) {
    frame = Number(frame);
    if (this.overlay.has(frame)) return this.overlay.get(frame);
    if (this.cache.has(frame)) return this.cache.get(frame);
    const spilled = this.readSpill(frame);
    if (spilled !== undefined) {
      this.cache.set(frame, spilled);
      while (this.cache.size > MAX_EXPANDED_FRAMES) {
        const old = this.cache.keys().next().value;
        const value = this.cache.get(old);
        this.cache.delete(old);
        this.writeSpill(old, value);
      }
      return spilled;
    }
    const block = findBlock(this.blocks, frame);
    if (!block) return undefined;
    let records = this.decoded.get(block);
    if (!records) {
      records = decodeBlock(block);
      this.decoded.set(block, records);
      // Keep decompressed records bounded. HTML strings requested by callers
      // remain in `cache`, while the much larger delta array is short lived.
      while (this.decoded.size > 1) this.decoded.delete(this.decoded.keys().next().value);
    }
    let previous = '';
    for (const record of records) {
      const n = Number(record[0]);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Corrupt frame archive');
      previous = apply(previous, record);
      if (n === frame) {
        this.cache.set(frame, previous);
        while (this.cache.size > MAX_EXPANDED_FRAMES) {
          const old = this.cache.keys().next().value;
          const value = this.cache.get(old);
          this.cache.delete(old);
          this.writeSpill(old, value);
        }
        return previous;
      }
      if (n > frame) break;
    }
    return undefined;
  }
  *keys() { yield* [...this.index].sort((a, b) => a - b); }
  *entries() { for (const key of this.keys()) yield [key, this.get(key)]; }
  [Symbol.iterator]() { return this.entries(); }
  materialize() { return new Map(this.entries()); }
}

function decodeLegacy(deltas) {
  let previous = '', last = -Infinity;
  const frames = new Map();
  for (const [frame, prefix, suffix, middle] of deltas) {
    if (!Number.isSafeInteger(frame) || frame <= last || !Number.isSafeInteger(prefix) || !Number.isSafeInteger(suffix) || prefix < 0 || suffix < 0 || prefix + suffix > previous.length || typeof middle !== 'string') throw new Error('Corrupt frame delta');
    previous = previous.slice(0, prefix) + middle + (suffix ? previous.slice(-suffix) : '');
    frames.set(frame, previous); last = frame;
  }
  return frames;
}

export function packFrames(key, frames, controls = new Map(), options = {}) {
  const fps = Number(options.fps || 30);
  const doc = { version: FRAME_ARCHIVE_VERSION, key, fps,
    checkpointSeconds: Number(options.checkpointSeconds || FRAME_CHECKPOINT_SECONDS), blockSeconds: Number(options.blockSeconds || FRAME_BLOCK_SECONDS),
    blocks: encodeBlocks(frames, { fps, checkpointSeconds: options.checkpointSeconds, blockSeconds: options.blockSeconds }),
    controls: asEntries(controls).map(([id, values]) => [id, encodeBlocks(values, { fps, checkpointSeconds: options.checkpointSeconds, blockSeconds: options.blockSeconds })]) };
  return b64(gzipSync(Buffer.from(JSON.stringify(doc), 'utf8')));
}

export function unpackFrameArchive(encoded, key, { spillDir = null } = {}) {
  const doc = JSON.parse(gunzipSync(unb64(encoded), { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'));
  if (doc.key !== key || !Array.isArray(doc.blocks || doc.deltas)) throw new Error('Incompatible frame archive');
  if (doc.version === 1) return { version: 1, frames: decodeLegacy(doc.deltas), controls: new Map((doc.controls || []).map(([id, deltas]) => [id, decodeLegacy(deltas)])) };
  if (doc.version !== FRAME_ARCHIVE_VERSION || !Array.isArray(doc.blocks)) throw new Error('Incompatible frame archive');
  prepareSpillDirectory(spillDir, encoded);
  const stageDir = spillDir ? path.join(spillDir, 'stage') : null;
  return {
    version: FRAME_ARCHIVE_VERSION,
    frames: new LazyFrameStore(doc.blocks, { spillDir: stageDir }),
    controls: new Map((doc.controls || []).map(([id, blocks]) => [id, new LazyFrameStore(blocks, { spillDir: spillDir ? path.join(spillDir, 'controls', controlDirectoryName(id)) : null })])),
    fps: doc.fps,
    checkpointSeconds: doc.checkpointSeconds,
    blockSeconds: doc.blockSeconds,
  };
}

export function unpackFrames(encoded, key) {
  const frames = unpackFrameArchive(encoded, key).frames;
  return frames instanceof LazyFrameStore ? frames.materialize() : frames;
}
