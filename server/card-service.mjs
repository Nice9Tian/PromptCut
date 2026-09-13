import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { projectCardGraph, cardJson } from '../src/kernel/cardGraph.mjs';
import { CardRuntime } from './card-runtime.mjs';
import { findFfmpeg } from '../scripts/export-frames.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : cardJson(value)).digest('hex');
const MAX_BUFFER = 256 * 1024 * 1024;
const within = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const error = message => Object.assign(new Error(message), { code: 'CARD_VALUE' });

export async function validateCardBuffer(root, value) {
  if (!value || !/^[a-f0-9]{32}\.bin$/.test(value.file || '')) throw error('Invalid card buffer file');
  const file = path.join(root, value.file), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !within(await fs.realpath(root), await fs.realpath(file))) throw error('Card output escaped its task directory');
  let expected;
  if (value.type === 'pixels') {
    if (value.format !== 'rgba8' || value.alpha !== 'straight' || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
      || value.width < 1 || value.height < 1 || value.width > 8192 || value.height > 8192 || value.stride !== value.width * 4) throw error('Invalid pixel buffer layout');
    expected = value.width * value.height * 4;
  } else if (value.type === 'audio') {
    if (value.format !== 'f32le' || !Number.isSafeInteger(value.frames) || value.frames < 1 || !Number.isSafeInteger(value.channels)
      || value.channels < 1 || value.channels > 32 || !Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 192000
      || !Number.isSafeInteger(value.startSample)) throw error('Invalid audio buffer layout');
    expected = value.frames * value.channels * 4;
  } else throw error('Unknown card buffer type');
  if (expected > MAX_BUFFER || value.bytes !== expected || stat.size !== expected) throw error('Card output size mismatch');
  // Copy before publication. The worker retains write access only to its staging
  // file; the content-addressed host cache is never granted to it.
  const bytes = await fs.readFile(file);
  if (bytes.length !== expected) throw error('Card output changed during read');
  return bytes;
}

export function wavFloat32(bytes, sampleRate, channels) {
  const out = Buffer.alloc(44 + bytes.length);
  out.write('RIFF'); out.writeUInt32LE(36 + bytes.length, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(3, 20); out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * channels * 4, 28);
  out.writeUInt16LE(channels * 4, 32); out.writeUInt16LE(32, 34); out.write('data', 36);
  out.writeUInt32LE(bytes.length, 40); bytes.copy(out, 44); return out;
}

async function commandBuffer(executable, args, signal, max = MAX_BUFFER) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = []; let size = 0, diagnostic = '';
    const abort = () => child.kill();
    if (signal?.aborted) { child.kill(); reject(error('Source decoding cancelled')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > max) { child.kill(); reject(error('Source buffer exceeds budget')); } else parts.push(chunk); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
    child.on('error', reject);
    child.on('close', code => { signal?.removeEventListener('abort', abort); if (code !== 0 || signal?.aborted) reject(error(`Source decoder failed: ${diagnostic}`)); else resolve(Buffer.concat(parts)); });
  });
}

/** Shared visual/audio evaluator. Native effects and Chrome remain graph adapters. */
export class CardService {
  constructor({ root, dir, renderValue, renderChrome, runtime, maxOpenedScopes = 4 }) {
    this.root = root; this.dir = dir; this.renderValue = renderValue; this.renderChrome = renderChrome;
    this.runtime = runtime || new CardRuntime({ root }); this.maxOpenedScopes = maxOpenedScopes;
    this.scopes = new Map(); this.values = new Map(); this.registrations = new Map();
    this.admission = Promise.resolve(); this.closed = false; this.scopeWaiters = []; this.scopeGeneration = 0;
  }
  async runtimeDir() {
    for (const dir of [process.env.PROMPTCUT_PYTHON_DIR, path.resolve(this.root, '..', 'python'), path.join(this.root, 'runtime', 'python'), path.join(this.root, 'desktop', 'src-tauri', 'runtime', 'python')].filter(Boolean)) {
      if (await fs.stat(path.join(dir, 'python.exe')).then(x => x.isFile(), () => false)) return dir;
    }
    throw Object.assign(error('Packaged Python runtime is missing'), { code: 'ISOLATION_UNAVAILABLE' });
  }
  async context(project) {
    const graph = projectCardGraph(project);
    await Promise.all(graph.nodes.filter(node => node.adapter === 'media' && node.media).map(async node => {
      // Unrelated unavailable assets must not prevent rendering this subgraph.
      let stat = null;
      try { stat = await fs.stat(this.sourcePath(node.media)); } catch { /* Evaluating that input reports the precise error. */ }
      node.media = { ...node.media, _frameSourceStamp: stat ? [stat.size, stat.mtimeMs, stat.ctimeMs] : 'missing' };
    }));
    const revision = hash([graph, project.style || {}, project.width, project.height, project.fps || 30]);
    if (!this.scopes.has(revision)) {
      const directory = path.join(this.dir, 'scopes', revision);
      const context = { revision, project: structuredClone(project), graph, nodes: new Map(graph.nodes.map(n => [n.id, n])),
        input: path.join(directory, 'input'), output: path.join(directory, 'output'), temp: path.join(directory, 'temp'), opened: null, active: 0, lastUsed: 0 };
      this.scopes.set(revision, context);
      context.ready = Promise.all([context.input, context.output, context.temp].map(dir => fs.mkdir(dir, { recursive: true })));
    }
    const context = this.scopes.get(revision); await context.ready; return context;
  }
  async admit(work, signal) {
    const prior = this.admission;
    let release;
    this.admission = new Promise(resolve => { release = resolve; });
    // The lock itself is deliberately not abort-raced: every path below owns
    // release in finally, so a cancelled waiter cannot poison admission.
    await prior;
    try { return await work(); } finally { release(); }
  }
  async reserve(context, signal) {
    return this.admit(async () => {
      // Reserve before awaiting runtime.open so a just-created stateful scope
      // cannot be selected as an idle victim by a concurrent evaluation.
      if (this.closed || signal?.aborted) throw error('Card service is closed');
      context.active++; context.lastUsed = Date.now();
      try {
      // A crashed runner clears its scopes. Reopen the existing graph metadata
      // instead of retaining a successful promise for a process that is gone.
      if (context.opened && this.runtime.scopes instanceof Map && !this.runtime.scopes.has(context.revision)) context.opened = null;
      if (context.opened) return await context.opened;
      for (;;) {
        const opened = [...this.scopes.values()].filter(x => x.opened);
        if (opened.length < this.maxOpenedScopes) break;
        const victim = opened.filter(x => x !== context && x.active === 0 && !x.closing).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!victim) { const busy = error('Card scope capacity is busy'); busy.code = 'CARD_SCOPE_BUSY'; busy.generation = this.scopeGeneration; throw busy; }
        victim.closing = true;
        try { await victim.opened; await this.runtime.closeScope(victim.revision, victim.revision); victim.opened = null; }
        finally { victim.closing = false; }
      }
      context.opened = (async () => {
      await this.runtime.open(context.revision, context.revision, { runtimeDir: await this.runtimeDir(), inputDirs: [context.input],
        outputDir: context.output, tempDir: context.temp, workers: 2 });
      })().catch(error => { context.opened = null; throw error; });
      return await context.opened;
      } catch (e) { context.active--; throw e; }
    }, signal);
  }
  async lease(context, signal) {
    for (;;) {
      try { await this.reserve(context, signal); break; }
      catch (e) {
        if (e.code !== 'CARD_SCOPE_BUSY') throw e;
        await new Promise((resolve, reject) => {
          const waiter = () => { this.scopeWaiters = this.scopeWaiters.filter(x => x !== waiter); signal?.removeEventListener('abort', abort); resolve(); };
          const abort = () => { this.scopeWaiters = this.scopeWaiters.filter(x => x !== waiter); reject(error('Card evaluation cancelled')); };
          this.scopeWaiters.push(waiter); signal?.addEventListener('abort', abort, { once: true });
          // A lease may release between admission rejection and waiter setup.
          if (signal?.aborted) abort();
          else if (this.closed || this.scopeGeneration !== e.generation) waiter();
        });
      }
    }
    let released = false;
    return () => { if (released) return; released = true; context.active--; context.lastUsed = Date.now(); this.scopeGeneration++; for (const wake of this.scopeWaiters.splice(0)) wake(); };
  }
  async asset(bytes, extension) {
    const key = hash(bytes), name = key + '.' + extension, file = path.join(this.dir, 'assets', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, bytes, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return { file, url: '/api/card-runtime/asset/' + name };
  }
  async publicValue(context, value, depth = 0) {
    if (depth > 64 || !value || typeof value !== 'object') throw error('Invalid card drawing description');
    if (value.type === 'pixels') {
      const bytes = await validateCardBuffer(context.output, value);
      const png = PNG.sync.write({ width: value.width, height: value.height, data: bytes });
      const asset = await this.asset(png, 'png');
      return { type: 'pixels', width: value.width, height: value.height, url: asset.url };
    }
    if (value.type === 'source') {
      if (!context.nodes.has(value.nodeId)) throw error('Card requested an unauthorized source node');
      return { type: 'source', nodeId: value.nodeId, time: value.time };
    }
    if (value.type === 'glsl') {
      if (typeof value.fragment !== 'string' || value.fragment.length > 512 * 1024 || !Array.isArray(value.inputs) || value.inputs.length > 16) throw error('Invalid GLSL descriptor');
      return { type: 'glsl', fragment: value.fragment, inputs: await Promise.all(value.inputs.map(v => this.publicValue(context, v, depth + 1))), uniforms: value.uniforms || {} };
    }
    if (value.type === 'draw') {
      if (!Array.isArray(value.commands) || value.commands.length > 10000) throw error('Drawing command budget exceeded');
      for (const command of value.commands) if (!['solid','rect'].includes(command.type) || !Array.isArray(command.color) || command.color.length !== 4 || command.color.some(x => !Number.isFinite(x))) throw error('Invalid drawing command');
      return structuredClone(value);
    }
    throw error('Unsupported visual card result');
  }
  async evaluate(project, nodeId, time, { signal, register = false, domain = 'visual', start, count, sampleRate = 48000 } = {}) {
    const context = await this.context(project);
    if (!context.nodes.has(nodeId)) throw error('Unknown card node');
    if (domain === 'audio' && (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1 || count > 1048576)) throw error('Invalid audio range');
    if (domain === 'visual' && !(Number.isFinite(time) || (Array.isArray(time) && time.length === 2 && time.every(Number.isFinite) && time[1] >= time[0]))) throw error('Invalid card time');
    const release = await this.lease(context, signal);
    const payload = { graph: context.graph, definitions: context.graph.definitions.filter(d => d.language === 'python'),
      style: project.style || {}, nodeId, time, fps: project.fps || 30, outputDir: context.output, domain, start, count, sampleRate };
    let raw;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          raw = await this.runtime.request(register ? 'register' : 'evaluate', context.revision, context.revision, payload,
            { signal, input: query => this.input(context, query, signal) });
          break;
        } catch (failure) {
          // A dead/replaced LPAC slot or another request's cancellation may
          // interrupt this consumer. Give the replacement one attempt while
          // retaining the scope lease. User-code errors and caller aborts are
          // never retried, and a persistently crashing card still fails.
          if (attempt || signal?.aborted || !['worker_exited', 'worker_write', 'card_cancelled'].includes(failure.code)) throw failure;
        }
      }
    }
    finally { release(); }
    if (domain === 'audio') {
      if (raw.type !== 'audio' || raw.frames !== count || raw.startSample !== start || raw.sampleRate !== sampleRate) throw error('Audio card returned a different sample range');
      const bytes = await validateCardBuffer(context.output, raw);
      for (let i = 0; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i))) throw error('Audio card returned non-finite samples');
      const asset = await this.asset(wavFloat32(bytes, sampleRate, raw.channels), 'wav');
      return { url: asset.url, format: 'wav', sampleRate, frames: count, channels: raw.channels };
    }
    if (register && !raw.registered) return { ...raw, revision: context.revision };
    if (raw.type === 'frames') return { interval: raw.interval, frames: await Promise.all(raw.frames.map(async frame => ({ time: frame.time, value: await this.publicValue(context, frame.value) }))), revision: context.revision };
    const value = await this.publicValue(context, register ? raw.value : raw);
    return { value, revision: context.revision, ...(register ? { registered: true } : {}) };
  }
  shared(map, key, start, signal) {
    let entry = map.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      entry = { controller, users: 0, settled: false };
      entry.promise = Promise.resolve().then(() => start(controller.signal)).then(
        value => { entry.settled = true; return value; },
        reason => { entry.settled = true; if (map.get(key) === entry) map.delete(key); throw reason; },
      );
      // Prevent an abandoned shared request from becoming an unhandled rejection.
      entry.promise.catch(() => {});
      map.set(key, entry);
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return; done = true;
        signal?.removeEventListener('abort', abort);
        entry.users--;
        if (!entry.settled && entry.users === 0) entry.controller.abort();
        fn(value);
      };
      const abort = () => finish(reject, error('Card request cancelled'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(resolve, value), reason => finish(reject, reason));
    });
  }
  async visual(project, nodeId, time, { signal } = {}) {
    if (Array.isArray(time)) return this.evaluate(project, nodeId, time, { signal });
    const context = await this.context(project);
    const key = context.revision + ':' + nodeId;
    const registration = await this.shared(this.registrations, key,
      sharedSignal => this.evaluate(project, nodeId, 0, { signal: sharedSignal, register: true }), signal);
    if (registration.registered) return registration;
    const frameKey = key + ':' + time;
    return this.shared(this.values, frameKey,
      sharedSignal => this.evaluate(project, nodeId, time, { signal: sharedSignal }), signal);
  }
  sourcePath(media) {
    if (!media) throw error('Input media is missing');
    if (media.path) return media.path;
    if (String(media.url).startsWith('/api/media/file?')) return new URL(media.url, 'http://localhost').searchParams.get('path');
    if (String(media.url).startsWith('/@media/')) return path.join(process.env.PROMPTCUT_MEDIA_DIR || path.join(this.root, 'out', 'media'), decodeURIComponent(media.url.slice(8)));
    if (String(media.url).startsWith('/@export/')) {
      const relative = decodeURIComponent(media.url.slice('/@export/'.length).split('?')[0]);
      const root = process.env.PROMPTCUT_EXPORT_DIR || path.join(this.root, 'out');
      const match = /^([^/]+)\/media\/(.+)$/.exec(relative);
      const file = path.resolve(root, match ? `export-${match[1]}/media/${match[2]}` : relative);
      if (within(root, file)) return file;
    }
    throw error('Card source requires an authorized local media file');
  }
  async sourcePng(context, nodeId, time, signal) {
    if (!Number.isFinite(time)) throw error('Source time must be finite');
    const node = context.nodes.get(nodeId);
    if (!node) throw error('Unknown source node');
    if (node.adapter === 'media') {
      const file = this.sourcePath(node.media);
      const sourceTime = Math.max(0, time + (node.offset || 0));
      const still = node.media.kind === 'image' || /^image\//.test(node.media.type || '') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file);
      return commandBuffer(await findFfmpeg(), ['-v','error',...(still ? [] : ['-ss',String(sourceTime)]),'-i',file,'-frames:v','1','-vf',
        `scale=${context.project.width}:${context.project.height}:force_original_aspect_ratio=increase,crop=${context.project.width}:${context.project.height}`,
        '-f','image2pipe','-vcodec','png','pipe:1'], signal);
    }
    if (node.adapter === 'chrome') {
      if (!this.renderChrome) throw error('Chrome source adapter is unavailable');
      return this.renderChrome(context, node, time, signal);
    }
    if (node.adapter === 'python') {
      const result = await this.visual(context.project, nodeId, time, { signal });
      return this.renderValue(context, result.value, time, signal);
    }
    // Legacy filter/emphasis descriptions remain in the browser composition.
    // They are materialized through the same full Chrome source adapter.
    if (this.renderChrome) return this.renderChrome(context, node, time, signal);
    throw error('Source adapter is unavailable: ' + node.adapter);
  }
  async input(context, query, signal) {
    if (query.start !== undefined) {
      const node = context.nodes.get(query.nodeId);
      if (!node || node.adapter !== 'media') throw error('Audio source must resolve to media or a Python input');
      const { start, count, sampleRate } = query;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1 || count > 1048576 || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw error('Invalid source audio range');
      const channels = 2, position = start + Math.round((node.offset || 0) * sampleRate);
      const leading = Math.min(count, Math.max(0, -position));
      const pcm = leading === count ? Buffer.alloc(0) : await commandBuffer(await findFfmpeg(), ['-v','error','-ss',String(Math.max(0,position) / sampleRate),'-i',this.sourcePath(node.media),
        '-t',String((count-leading)/sampleRate),'-vn','-ar',String(sampleRate),'-ac',String(channels),'-f','f32le','pipe:1'], signal);
      const bytes = Buffer.alloc(count * channels * 4); pcm.copy(bytes, leading * channels * 4, 0, (count-leading)*channels*4);
      const file = path.join(context.input, hash(bytes) + '.bin'); await fs.writeFile(file, bytes);
      return { type:'audio',format:'f32le',path:file,sampleRate,channels,startSample:start,frames:count };
    }
    const value = query.value || { type:'source',nodeId:query.nodeId,time:query.time };
    let png;
    if (value.type === 'source') png = await this.sourcePng(context, value.nodeId, value.time, signal);
    else {
      if (!this.renderValue) throw error('GPU pixel materialization is unavailable');
      png = await this.renderValue(context, await this.publicValue(context, value), 0, signal);
    }
    const decoded = PNG.sync.read(png);
    const file = path.join(context.input, hash(decoded.data) + '.bin'); await fs.writeFile(file, decoded.data);
    return { type:'pixels',format:'rgba8',alpha:'straight',path:file,width:decoded.width,height:decoded.height,stride:decoded.width*4 };
  }
  async close() {
    this.closed = true;
    for (const wake of this.scopeWaiters.splice(0)) wake();
    await this.admission;
    await this.runtime.close();
  }
}
