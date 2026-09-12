import fs from 'node:fs/promises';
import path from 'node:path';
import { openBakery, bakeFrames, findFfmpeg } from '../scripts/export-frames.mjs';
import { captureSnapshot } from '../scripts/capture-snapshot.mjs';
import { frameVideo } from '../scripts/frame-video.mjs';
import { frameIdentity, trackPrefixes } from './frame-identity.mjs';
import { packFrames, unpackFrameArchive } from './frame-archive.mjs';

const pad = n => String(n).padStart(6, '0');
const exists = file => fs.access(file).then(() => true, () => false);
// The interactive editor must never wait forever on a renderer that stopped
// answering.  Agent/background renders have their own (longer) budgets; this
// watchdog is only for the human preview lane.
// TODO: 10 seconds may be too aggressive for complex projects or a cold media
// decode. Keep this configurable until we have latency telemetry; raise it
// with PROMPTCUT_USER_RENDER_TIMEOUT_MS when the preview needs more headroom.
const USER_RENDER_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTCUT_USER_RENDER_TIMEOUT_MS) || 10000);
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

/** A foreground batch queue, B complete HTML sampling, C cumulative-track rasterization.
 * Each lane owns its Chrome; foreground never waits for a background bake to finish.
 */
export class FramePipeline {
  constructor({ root, origin, code = () => '' }) {
    this.root = root;
    this.origin = origin;
    this.code = code;
    this.entries = new Map();
    this.queue = [];
    // The human preview, Agent and background bake each own an independent
    // serialized queue.  A long Agent render must never hold the hot user Chrome.
    this.foreground = Promise.resolve();
    this.laneChains = new Map([['user', Promise.resolve()], ['agent', Promise.resolve()], ['background', Promise.resolve()]]);
    this.background = Promise.resolve();
    this.generations = new Map();
    this.lanes = new Map();
    // Keep two independent renderer processes ready for the editor.  A stuck
    // renderer can be discarded while the other one takes the next request.
    this.userPool = [];
    this.userPrewarm = null;
    // The editor can emit many pointer events before the previous render
    // completes. Keep one generation only; stale user requests must never
    // accumulate pages or force both hot Chromes to restart.
    this.userGeneration = 0;
    this.userGenerationController = null;
  }
  async entry(project) {
    project = { ...project, media: await Promise.all((project.media || []).map(async media => {
      let file = media.path;
      if (!file && String(media.url).startsWith('/@media/')) file = path.join(this.root, '..', 'media', decodeURIComponent(media.url.slice('/@media/'.length)));
      if (!file) return media;
      try { const stat = await fs.stat(file); return { ...media, _frameSourceStamp: `${stat.size}:${stat.mtimeMs}` }; }
      catch { return { ...media, _frameSourceStamp: 'missing' }; }
    })) };
    const code = this.code(project);
    const key = frameIdentity(project, code);
    if (!this.entries.has(key)) {
      const entry = { key, code, project: structuredClone(project), html: new Map(), controls: new Map(), dir: path.join(this.root, key), status: 'idle', error: null };
      this.entries.set(key, entry);
      entry.loading = fs.readFile(path.join(entry.dir, 'snapshots.base64'), 'utf8').then(encoded => {
        try { const archive = unpackFrameArchive(encoded, key); entry.html = archive.frames; entry.controls = archive.controls; } catch { /* Disposable cache. */ }
      }, () => {});
    }
    const entry = this.entries.get(key);
    await entry.loading;
    return entry;
  }
  async bakery(project, lane = 'agent') {
    const empty = { ...project, tracks: [], media: [] };
    const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
    const bakery = await openBakery({ url });
    try {
      await bakery.loadProject(project);
      await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
      await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      return bakery;
    }
    catch (e) { await bakery.close(); throw e; }
  }
  scaleForLane(lane) {
    if (lane !== 'background') return 1;
    const value = Number(process.env.PROMPTCUT_PRERENDER_SCALE || 1);
    return Number.isFinite(value) && value > 0 ? Math.min(3, Math.max(0.5, value)) : 1;
  }
  async acquire(lane, project) {
    const previous = this.lanes.get(lane);
    clearTimeout(previous?.timer);
    if (previous) {
      const empty = { ...project, tracks: [], media: [] };
      const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
      try {
        await previous.bakery.reset(project, url);
        await previous.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
        await previous.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        return previous.bakery;
      } catch { await previous.bakery.close().catch(() => {}); this.lanes.delete(lane); }
    }
    const bakery = await this.bakery(project, lane);
    this.lanes.set(lane, { bakery });
    return bakery;
  }
  emptyProject(project = {}) {
    return {
      width: Number(project.width) > 0 ? project.width : 1920,
      height: Number(project.height) > 0 ? project.height : 1080,
      fps: Number(project.fps) > 0 ? project.fps : 30,
      duration: 1,
      tracks: [],
      media: [],
    };
  }
  emptyUrl(project = {}) {
    const empty = this.emptyProject(project);
    return this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
  }
  async prewarmUser(project = {}) {
    if (this.userPrewarm) return this.userPrewarm;
    this.userPrewarm = (async () => {
      while (this.userPool.filter(s => !s.dead).length < 2) {
        try {
          const bakery = await this.bakery(this.emptyProject(project), 'user');
          this.userPool.push({ bakery, busy: false, dead: false });
        } catch (e) {
          // A missing browser should be reported by the first request with the
          // original error.  Do not make server startup fail just because the
          // optional hot pair could not be warmed yet.
          this.userPrewarm = null;
          return;
        }
      }
    })().finally(() => { this.userPrewarm = null; });
    return this.userPrewarm;
  }
  dropUserSession(session) {
    session.dead = true;
    const at = this.userPool.indexOf(session);
    if (at >= 0) this.userPool.splice(at, 1);
    void session.bakery?.close().catch(() => {});
  }
  async acquireUser(project, signal) {
    await this.prewarmUser(project);
    const waitStart = Date.now();
    for (;;) {
      const session = this.userPool.find(s => !s.dead && !s.busy);
      if (session) {
        session.busy = true;
        try {
          await session.bakery.reset(project, this.emptyUrl(project));
          await session.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
          await session.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
          return session;
        } catch (e) {
          this.dropUserSession(session);
          throw e;
        }
      }
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      // The pair is intentionally bounded.  Waiting here is short in normal
      // use; a watchdog around readFrames will kill a renderer that does not
      // release its slot.
      if (Date.now() - waitStart > USER_RENDER_TIMEOUT_MS) {
        throw Object.assign(new Error(`用户预览等待 Chrome 超过 ${USER_RENDER_TIMEOUT_MS / 1000} 秒，已放弃这次旧请求。`), { status: 504, timedOut: true });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  releaseUser(session) {
    if (!session || session.dead) return;
    session.busy = false;
  }
  dropBusyUsers() {
    for (const session of [...this.userPool]) if (session.busy) this.dropUserSession(session);
    // Replenish asynchronously so the next pointer event lands on a hot page.
    void this.prewarmUser().catch(() => {});
  }
  release(lane) {
    const session = this.lanes.get(lane);
    if (!session) return;
    if (lane === 'user' || lane === 'agent') return;
    session.timer = setTimeout(() => {
      if (this.lanes.get(lane) !== session) return;
      this.lanes.delete(lane);
      void session.bakery.close().catch(() => {});
    }, 30000);
    session.timer.unref?.();
  }
  /** Shared public entry point. Independent requests in the same turn merge into one forward pass. */
  async see_frames(project, times, { signal, lane = 'agent' } = {}) {
    // `inter_face` is the explicit name used by the interactive client. Keep
    // `user` as a backwards-compatible alias; both must use the two hot pages.
    lane = lane === 'inter_face' || lane === 'user' ? 'user' : lane === 'background' ? 'background' : 'agent';
    const generation = lane === 'user' ? ++this.userGeneration : 0;
    const generationController = lane === 'user' ? new AbortController() : null;
    if (generationController) {
      this.userGenerationController?.abort();
      this.userGenerationController = generationController;
    }
    const renderSignal = generationController
      ? (signal ? AbortSignal.any([signal, generationController.signal]) : generationController.signal)
      : signal;
    const entry = await this.entry(project);
    const fps = project.fps || 30;
    const max = Math.max(0, Math.floor(project.duration * fps) - 1);
    if (!times.length || times.some(t => !Number.isFinite(t))) throw new Error('Frame times must be finite numbers');
    const frames = [...new Set(times.map(t => Math.max(0, Math.min(max, Math.round(t * fps)))))];
    return new Promise((resolve, reject) => {
      if (lane === 'user' && generation !== this.userGeneration) {
        reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
        return;
      }
      if (lane === 'user') {
        // Remove requests that reached the queue before this pointer event.
        // Agent/background queues are deliberately left untouched.
        const stale = this.queue.filter(r => r.lane === 'user');
        this.queue = this.queue.filter(r => r.lane !== 'user');
        stale.forEach(r => r.reject(Object.assign(new Error('交互帧请求已被更新的请求替代。'), { status: 499, cancelled: true, superseded: true })));
      }
      this.queue.push({ entry, frames, signal: renderSignal, lane, generation, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => {
        this.timer = null;
        const requests = this.queue.splice(0);
        for (const currentLane of ['user', 'agent', 'background']) {
          const laneRequests = requests.filter(r => r.lane === currentLane);
          if (!laneRequests.length) continue;
          // User requests are independent: the two hot Chrome slots are
          // deliberately allowed to overlap.  Agent/background lanes remain
          // serialized for deterministic animation state.
          if (currentLane === 'user') {
            const task = this.flush(laneRequests, currentLane);
            this.foreground = task;
            task.catch(() => {});
          } else {
            const chain = (this.laneChains.get(currentLane) || Promise.resolve()).catch(() => {}).then(() => this.flush(laneRequests, currentLane));
            this.laneChains.set(currentLane, chain);
          }
        }
      }, 12);
    });
  }
  async flush(requests, lane = 'agent') {
    const groups = new Map();
    for (const request of requests) {
      if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) {
        request.reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
        continue;
      }
      const list = groups.get(request.entry.key) || [];
      list.push(request); groups.set(request.entry.key, list);
    }
    for (const group of groups.values()) {
      const entry = group[0].entry;
      const frames = [...new Set(group.flatMap(r => r.frames))].sort((a, b) => a - b);
      try {
        const result = await this.readFrames(entry, frames, lane, group.find(r => !r.signal?.aborted)?.signal);
        for (const request of group) {
          if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) request.reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
          else request.resolve(new Map(request.frames.map(n => [n, result.get(n)])));
        }
      } catch (e) { group.forEach(r => r.reject(e)); }
    }
  }
  async readFrames(entry, frames, lane = 'agent', signal) {
    if (lane === 'user') {
      const watchdog = new AbortController();
      const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
      let timer;
      const work = this.readFramesCore(entry, frames, lane, combined);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          watchdog.abort();
          this.dropBusyUsers();
          reject(Object.assign(new Error(`用户预览渲染超过 ${USER_RENDER_TIMEOUT_MS / 1000} 秒，已重启 Chrome。`), { status: 504, timedOut: true }));
        }, USER_RENDER_TIMEOUT_MS);
      });
      try { return await Promise.race([work, timeout]); }
      finally { clearTimeout(timer); work.catch(() => {}); }
    }
    return this.readFramesCore(entry, frames, lane, signal);
  }
  async readFramesCore(entry, frames, lane = 'agent', signal) {
    const result = new Map();
    const missing = [];
    for (const frame of frames) {
      const file = path.join(entry.dir, 'frames', pad(frame) + '.png');
      try { result.set(frame, { buf: await fs.readFile(file), source: 'rendered' }); }
      catch { missing.push(frame); }
    }
    if (!missing.length) return result;
    const userSession = lane === 'user' ? await this.acquireUser(entry.project, signal) : null;
    const bakery = userSession?.bakery || await this.acquire(lane, entry.project);
    try {
      const uncached = missing.filter(n => !entry.html.has(n));
      if (uncached.length) {
        // A/Agent sparse requests still have to advance through every
        // intermediate frame for deterministic Motion state, but retaining
        // all of those HTML snapshots would turn a 60-frame random probe on
        // a long timeline into a multi-gigabyte in-memory cache. B preload
        // passes an explicit full range and continues to record every frame.
        const requestedSnapshots = new Set(uncached);
        await bakeFrames(bakery, { out: entry.dir, targetFrames: uncached, snapshotOnly: true, signal,
          onSnapshot: (n, html, controls) => requestedSnapshots.has(n) && this.record(entry, n, html, controls) });
        await this.save(entry);
      }
      for (const frame of missing) {
        const html = entry.html.get(frame);
        if (html === undefined) throw new Error(`Frame ${frame} was not sampled`);
        const prefixes = this.prefixes(entry);
        let buf;
        for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
        await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
        result.set(frame, { buf, source: uncached.includes(frame) ? 'advance' : 'html' });
      }
    } finally {
      if (userSession) this.releaseUser(userSession);
      else this.release(lane);
    }
    return result;
  }
  record(entry, n, html, controls = []) {
    entry.html.set(n, html);
    for (const control of controls) {
      if (!entry.controls.has(control.id)) entry.controls.set(control.id, new Map());
      entry.controls.get(control.id).set(control.frame, control.html);
    }
  }
  save(entry) { return atomic(path.join(entry.dir, 'snapshots.base64'), packFrames(entry.key, entry.html, entry.controls)); }
  async preload(project) {
    const entry = await this.entry(project);
    const owner = project.id || 'active';
    const previous = this.generations.get(owner);
    if (previous?.key === entry.key && entry.status !== 'error') return entry;
    previous?.controller.abort();
    const controller = new AbortController();
    this.generations.set(owner, { key: entry.key, controller });
    entry.status = 'queued';
    this.background = this.background.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      let bakery;
      try {
        entry.status = 'html';
        const count = Math.max(1, Math.floor(project.duration * (project.fps || 30)));
        bakery = await this.acquire('background', entry.project);
        // `size === count` is not enough for a sparse archive: a foreground
        // request can contain exactly `count` entries while still missing one
        // frame and containing an out-of-range index.  C must only start after
        // B has every frame in the canonical 0..count-1 range.
        const complete = entry.html.size === count && [...Array(count).keys()].every(n => entry.html.has(n));
        if (!complete) {
          await bakeFrames(bakery, { out: entry.dir, frames: `0-${count - 1}`, snapshotOnly: true,
            signal: controller.signal, onSnapshot: (n, html, controls) => { this.record(entry, n, html, controls); } });
          await this.save(entry);
        }
        entry.status = 'video';
        await this.prerender(entry, bakery, controller.signal);
        entry.status = 'ready';
      } catch (e) {
        entry.status = controller.signal.aborted ? 'cancelled' : 'error';
        entry.error = controller.signal.aborted ? null : String(e.message || e);
      } finally { this.release('background'); }
    });
    return entry;
  }
  prefixes(entry) {
    const prefixes = trackPrefixes(entry.project, entry.code);
    if (!prefixes.length) prefixes.push({ key: entry.key, trackIds: [] });
    return prefixes;
  }
  async rasterPrefix(entry, bakery, frame, i, prefixes) {
    const prefix = prefixes[i];
    const dir = path.join(this.root, 'tracks', prefix.key);
    const file = path.join(dir, pad(frame) + '.png');
    try { return await fs.readFile(file); } catch {}
    // A lower cumulative track is a single lossless bitmap under the upper HTML.
    const base = i ? await fs.readFile(path.join(this.root, 'tracks', prefixes[i - 1].key, `${pad(frame)}.png`)) : null;
    const html = await bakery.page.evaluate(({ html, ids, base }) => {
      const template = document.createElement('template'); template.innerHTML = html;
      const tracks = [...template.content.querySelectorAll('[data-pc-track]')];
      for (const track of tracks) if (!ids.includes(track.getAttribute('data-pc-track'))) track.remove();
      if (base) {
        const img = document.createElement('img'); img.src = 'data:image/png;base64,' + base;
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        template.content.firstElementChild.prepend(img);
      }
      return template.innerHTML;
    }, { html: entry.html.get(frame), ids: i ? [prefix.trackId] : prefix.trackIds, base: base?.toString('base64') || null });
    const buf = await captureSnapshot(bakery, html);
    await atomic(path.join(dir, `${pad(frame)}.png`), buf);
    return buf;
  }
  async prerender(entry, bakery, signal) {
    const prefixes = this.prefixes(entry);
    const ffmpeg = await findFfmpeg();
    const frames = [...entry.html.keys()].sort((a, b) => a - b);
    for (let i = 0; i < prefixes.length; i++) {
      if (signal.aborted) throw new Error('Cancelled');
      const prefix = prefixes[i];
      const dir = path.join(this.root, 'tracks', prefix.key);
      const video = path.join(dir, 'preview.mp4');
      const final = i === prefixes.length - 1;
      if (!(await exists(video))) {
        await fs.mkdir(dir, { recursive: true });
        const temp = path.join(dir, `preview-${process.pid}.tmp.mp4`);
        const stream = frameVideo(ffmpeg, temp, entry.project.fps || 30);
        try {
          for (const frame of frames) {
            if (signal.aborted) throw new Error('Cancelled');
            const buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
            await stream.write(buf);
          }
          await stream.finish();
          await fs.rename(temp, video);
        } catch (e) { await stream.abort(); await fs.rm(temp, { force: true }); throw e; }
      }
      if (final) {
        for (const frame of frames) {
          await atomic(path.join(entry.dir, 'frames', `${pad(frame)}.png`), await fs.readFile(path.join(dir, `${pad(frame)}.png`)));
        }
        const temp = path.join(entry.dir, `preview-${process.pid}.tmp.mp4`);
        await fs.copyFile(video, temp);
        await fs.rename(temp, path.join(entry.dir, 'preview.mp4'));
      }
    }
  }
  async close() {
    clearTimeout(this.timer);
    this.userGenerationController?.abort();
    this.userGenerationController = null;
    for (const r of this.queue.splice(0)) r.reject(new Error('Renderer closed'));
    for (const generation of this.generations.values()) generation.controller.abort();
    await Promise.allSettled([this.foreground, this.background, ...this.laneChains.values()]);
    await Promise.allSettled([...this.lanes.values()].map(session => { clearTimeout(session.timer); return session.bakery.close(); }));
    this.lanes.clear();
    await Promise.allSettled(this.userPool.map(session => session.bakery.close()));
    this.userPool.length = 0;
  }
}
