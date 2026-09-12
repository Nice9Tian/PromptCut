import fs from 'node:fs/promises';
import path from 'node:path';
import { openBakery, bakeFrames, findFfmpeg } from '../scripts/export-frames.mjs';
import { captureSnapshot } from '../scripts/capture-snapshot.mjs';
import { frameVideo } from '../scripts/frame-video.mjs';
import { frameIdentity, trackPrefixes } from './frame-identity.mjs';
import { packFrames, unpackFrameArchive } from './frame-archive.mjs';
import { MovFrameStore, PlaybackMovStore } from './frame-mov.mjs';
import { FramePlayback } from './frame-playback.mjs';

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
    this.userPoolSize = 2;
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
      entry.mov = new MovFrameStore({ dir: entry.dir, fps: project.fps || 30 });
      this.entries.set(key, entry);
      entry.loading = fs.readFile(path.join(entry.dir, 'snapshots.base64'), 'utf8').then(encoded => {
        try {
          const archive = unpackFrameArchive(encoded, key, { spillDir: path.join(entry.dir, 'html-cache') });
          entry.html = archive.frames;
          entry.controls = archive.controls;
          entry.disposeArchive = archive.dispose;
        } catch { /* Disposable cache. */ }
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
      await bakery.loadProject(project, { deferCards: true });
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
    if (lane === 'background' && (this.backgroundYielding || this.backgroundLeaseUntil > Date.now())) throw Object.assign(new Error('Background yielded to playback'), { cancelled: true });
    const previous = this.lanes.get(lane);
    clearTimeout(previous?.timer);
    if (previous) {
      const empty = { ...project, tracks: [], media: [] };
      const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
      try {
        await previous.bakery.reset(project, url, { deferCards: true });
        await previous.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
        await previous.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        return previous.bakery;
      } catch { await previous.bakery.close().catch(() => {}); this.lanes.delete(lane); }
    }
    const bakery = await this.bakery(project, lane);
    if (lane === 'background' && (this.backgroundYielding || this.backgroundLeaseUntil > Date.now())) {
      await bakery.close();
      throw Object.assign(new Error('Background yielded to playback'), { cancelled: true });
    }
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
      while (!this.closed && this.userPool.filter(s => !s.dead).length < this.userPoolSize) {
        try {
          const bakery = await this.bakery(this.emptyProject(project), 'user');
          if (this.closed) { await bakery.close(); return; }
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
  async acquireUser(project, signal, onSession = () => {}) {
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    await this.prewarmUser(project);
    const waitStart = Date.now();
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const session = this.userPool.find(s => !s.dead && !s.busy);
      if (session) {
        session.busy = true;
        onSession(session);
        try {
          await session.bakery.reset(project, this.emptyUrl(project), { deferCards: true });
          await session.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
          await session.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
          if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
          return session;
        } catch (e) {
          if (e.cancelled) this.releaseUser(session);
          else this.dropUserSession(session);
          throw e;
        }
      }
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
    if (this.userPool.length > this.userPoolSize) this.dropUserSession(session);
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
  async see_frames(project, times, { signal, lane = 'agent', onFrame } = {}) {
    // `inter_face` is the explicit name used by the interactive client. Keep
    // `user` as a backwards-compatible alias; both must use the two hot pages.
    lane = lane === 'playback' ? lane : lane === 'inter_face' || lane === 'user' ? 'user' : lane === 'background' ? 'background' : 'agent';
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
    // Playback reservations already bound concurrency and supersede by epoch.
    // They must not cancel one another like interactive pointer requests do.
    if (lane === 'playback') return this.readFrames(entry, frames.sort((a, b) => a - b), lane, signal, onFrame);
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
      this.queue.push({ entry, frames, signal: renderSignal, lane, generation, onFrame, resolve, reject });
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
        const result = await this.readFrames(entry, frames, lane, group.find(r => !r.signal?.aborted)?.signal, async (frame, value) => {
          for (const request of group) if (!request.signal?.aborted && request.frames.includes(frame)) await request.onFrame?.(frame, value);
        });
        for (const request of group) {
          if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) request.reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
          else request.resolve(new Map(request.frames.map(n => [n, result.get(n)])));
        }
      } catch (e) { group.forEach(r => r.reject(e)); }
    }
  }
  async readFrames(entry, frames, lane = 'agent', signal, onFrame) {
    if (lane === 'user' || lane === 'playback') {
      const watchdog = new AbortController();
      const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
      let timer, ownedSession;
      let arm = () => {};
      const work = this.readFramesCore(entry, frames, lane, combined, session => { ownedSession = session; }, async (frame, value) => {
        if (lane === 'playback') arm(); // A healthy stream may run longer than ten seconds.
        await onFrame?.(frame, value);
      });
      let cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => {
          if (ownedSession && !ownedSession.dead) this.dropUserSession(ownedSession);
          reject(Object.assign(new Error('Frame request cancelled'), { cancelled: true }));
        };
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      });
      const timeout = new Promise((_, reject) => {
        arm = () => { clearTimeout(timer); timer = setTimeout(() => {
          watchdog.abort();
          // A stalled old request must not kill the other hot Chrome serving
          // the latest pointer position. Ownership begins before reset awaits.
          if (ownedSession && !ownedSession.dead) this.dropUserSession(ownedSession);
          void this.prewarmUser(entry.project).catch(() => {});
          reject(Object.assign(new Error(`用户预览渲染超过 ${USER_RENDER_TIMEOUT_MS / 1000} 秒，已重启 Chrome。`), { status: 504, timedOut: true }));
        }, USER_RENDER_TIMEOUT_MS); };
        arm();
      });
      try { return await Promise.race([work, timeout, cancelled]); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); work.catch(() => {}); }
    }
    return this.readFramesCore(entry, frames, lane, signal, undefined, onFrame);
  }
  async readFramesCore(entry, frames, lane = 'agent', signal, onSession, onFrame) {
    const result = new Map();
    const htmlFrames = [];
    const missing = [];
    const hasMedia = (entry.project.media || []).length > 0;
    await entry.mov?.ready;
    // MOV is the first lookup: it is already the full scene with media and is
    // the cheapest exact answer. HTML is the high-priority producer for a
    // missing MOV frame, so random access can still avoid loading media.
    for (const frame of frames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const buf = await entry.mov?.get(frame);
      if (buf) result.set(frame, { buf, source: 'mov' });
      else {
        // Compatibility with the pre-MOV cumulative PNG cache. It is still a
        // valid full-scene result and lets old projects avoid a re-render.
        try { result.set(frame, { buf: await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png')), source: 'rendered' }); }
        catch { if (!hasMedia && entry.html?.has?.(frame)) htmlFrames.push(frame); else missing.push(frame); }
      }
      if (result.has(frame)) await onFrame?.(frame, result.get(frame));
    }
    if (!htmlFrames.length && !missing.length) return result;
    const userSession = lane === 'user' || lane === 'playback' ? await this.acquireUser(entry.project, signal, onSession) : null;
    const bakery = userSession?.bakery || await this.acquire(lane, entry.project);
    try {
      // The full-scene MOV lane owns the result returned by see_frames. It
      // still records HTML snapshots while it advances, so the next request
      // can replay without loading media. HTML is the higher-priority cache;
      // MOV only fills frames absent from its table.
      const htmlReplay = async frame => {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const prefixes = this.prefixes(entry);
        let buf;
        for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
        await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
        result.set(frame, { buf, source: 'html' });
        await this.writeMov(entry, frame, buf);
        await onFrame?.(frame, { buf, source: 'html' });
      };
      for (const frame of htmlFrames) await htmlReplay(frame);
      if (!missing.length) return result;
      await this.renderMovFrames(entry, missing, bakery, signal, onFrame);
      for (const frame of missing) {
        const buf = await entry.mov.get(frame);
        if (!buf) throw new Error(`MOV frame ${frame} was not written`);
        result.set(frame, { buf, source: 'mov' });
      }
    } finally {
      if (userSession) this.releaseUser(userSession);
      else this.release(lane);
    }
    return result;
  }
  async renderMovFrames(entry, frames, bakery, signal, onFrame) {
    // Reuse HTML-complete frames first. This is the background equivalent of
    // see_frames' HTML lookup and avoids loading media for frames already
    // frozen by the higher-priority lane.
    const hasMedia = (entry.project.media || []).length > 0;
    const htmlFrames = hasMedia ? [] : frames.filter(frame => !entry.mov.has(frame) && entry.html.has(frame));
    for (const frame of htmlFrames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const prefixes = this.prefixes(entry);
      let buf;
      for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
      await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
      await this.writeMov(entry, frame, buf);
      await onFrame?.(frame, { buf, source: 'html' });
    }
    const missing = frames.filter(frame => !entry.mov.has(frame));
    if (!missing.length) return;
    const requested = new Set(missing);
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: missing, snapshotOnly: false, fullFrame: true,
      snapshotFrames: new Set(missing),
      writeFrames: false, signal,
      onFrame: async (frame, buf) => {
        if (requested.has(frame)) {
          await this.writeMov(entry, frame, buf);
          await onFrame?.(frame, { buf, source: 'live' });
        }
      },
      // MOV passes still record HTML for the same live state, but only when the
      // HTML lane did not already have that frame.
      onSnapshot: (n, html, controls) => !entry.html.has(n) && requested.has(n) && this.record(entry, n, html, controls),
    });
    await this.save(entry);
  }
  async writeMov(entry, frame, buf) {
    if (!entry.mov) return;
    // Store the random-access copy first. Starting ffmpeg for an isolated
    // high-numbered request would leave a pipe waiting forever for frame 0.
    await entry.mov.put(frame, buf);
    // During playback the append-only PNG MOV is the sink. Do not start an
    // additional ffmpeg stream competing for the same CPU budget.
    if (this.playback?.playing || this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) return;
    if (entry.mov.writer || entry.mov.writerError || await exists(entry.mov.movieFile)) return;
    try {
      if (frame === entry.mov.nextFrame) {
        const ffmpeg = await findFfmpeg();
        await entry.mov.start(ffmpeg);
      }
    } catch (error) {
      // MOV is a secondary cache; preserve the PNG/HTML result if the local
      // encoder is unavailable or exits unexpectedly.
      entry.mov.writerError ||= error;
    }
  }
  record(entry, n, html, controls = []) {
    entry.recordVersion = (entry.recordVersion || 0) + 1;
    entry.html.set(n, html);
    for (const control of controls) {
      if (!entry.controls.has(control.id)) entry.controls.set(control.id, new Map());
      // The control cache is intentionally addressed by the control's own
      // local frame (the `t` used by the card), so it can be replayed without
      // knowing the clip's global start time.
      entry.controls.get(control.id).set(control.frame, control.html);
    }
  }
  async save(entry) {
    const work = (entry.saveChain || Promise.resolve()).catch(() => {}).then(() => this.saveNow(entry));
    entry.saveChain = work;
    return work;
  }
  async saveNow(entry) {
    const version = entry.recordVersion;
    const encoded = packFrames(entry.key, entry.html, entry.controls, {
      fps: entry.project.fps || 30,
    });
    await atomic(path.join(entry.dir, 'snapshots.base64'), encoded);
    if (entry.recordVersion !== version) return;
    // Re-open our own archive so the hot pipeline keeps compressed blocks and
    // only a small expanded window, rather than every full HTML string.
    const archive = unpackFrameArchive(encoded, entry.key, { spillDir: path.join(entry.dir, 'html-cache') });
    // Concurrent playback batches may record new frames during the disk write.
    // Do not replace their live map with the older archive snapshot.
    if (entry.recordVersion === version) {
      const dispose = entry.disposeArchive;
      entry.html = archive.frames;
      entry.controls = archive.controls;
      entry.disposeArchive = archive.dispose;
      dispose?.();
    }
  }
  async preload(project) {
    const entry = await this.entry(project);
    if (this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) {
      (this.pausedPreloads ||= new Map()).set(project.id || 'active', project);
      return entry;
    }
    const owner = project.id || 'active';
    const previous = this.generations.get(owner);
    if (previous?.key === entry.key && !previous.controller.signal.aborted && !['error', 'cancelled'].includes(entry.status)) return entry;
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
          const blockFrames = Math.max(1, Math.round((project.fps || 30) * 60));
          await bakeFrames(bakery, { out: entry.dir, frames: `0-${count - 1}`, snapshotOnly: true,
            signal: controller.signal, onSnapshot: async (n, html, controls) => {
              this.record(entry, n, html, controls);
              // Flush one independently compressed time block while the bake
              // is still running. This bounds the full HTML held by Node.
              if ((n + 1) % blockFrames === 0) await this.save(entry);
            } });
          await this.save(entry);
        }
        entry.status = 'mov';
        // MOV must contain the full scene, including media. Its pass shares
        // the already warm background Chrome but deliberately uses the live
        // full-frame capture path; HTML snapshots have media removed.
        await this.fillMov(entry, controller.signal, bakery);
        entry.status = 'video';
        await this.prerender(entry, bakery, controller.signal);
        entry.status = 'ready';
      } catch (e) {
        entry.status = controller.signal.aborted ? 'cancelled' : 'error';
        entry.error = controller.signal.aborted ? null : String(e.message || e);
      } finally { if (bakery && this.lanes.get('background')?.bakery === bakery) this.release('background'); }
    });
    return entry;
  }
  async fillMov(entry, signal, bakery) {
    if (!entry.mov || await exists(entry.mov.movieFile)) return;
    const fps = entry.project.fps || 30;
    const count = Math.max(1, Math.floor(entry.project.duration * fps));
    if (signal?.aborted) throw new Error('Cancelled');
    await entry.mov.start(await findFfmpeg());
    await this.renderMovFrames(entry, Array.from({ length: count }, (_, i) => i), bakery, signal);
    await entry.mov.finish();
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
  /** Revoke only speculative B/MOV work; Agent renders keep their own lane. */
  async yieldBackground(owner, ttl = 5000) {
    const already = this.backgroundLeaseUntil > Date.now();
    this.backgroundLeaseVersion = (this.backgroundLeaseVersion || 0) + 1;
    this.backgroundLeaseOwner = owner;
    this.backgroundLeaseUntil = Date.now() + ttl;
    clearTimeout(this.backgroundLeaseTimer);
    this.backgroundLeaseTimer = setTimeout(() => { void this.resumeBackground(owner); }, ttl);
    this.backgroundLeaseTimer.unref?.();
    if (already || this.backgroundYielding) return this.yielding;
    this.backgroundYielding = true;
    this.yielding = (async () => {
      this.pausedPreloads ||= new Map();
      for (const [id, generation] of this.generations) {
        const entry = this.entries.get(generation.key);
        if (entry && entry.status !== 'ready') this.pausedPreloads.set(id, entry.project);
        generation.controller.abort();
      }
      const session = this.lanes.get('background');
      if (session) { clearTimeout(session.timer); this.lanes.delete('background'); await session.bakery.close().catch(() => {}); }
      await Promise.allSettled([...this.entries.values()].map(entry => entry.mov?.suspend()));
      await this.background.catch(() => {});
      await Promise.allSettled([...this.entries.values()].filter(entry => entry.html.size).map(entry => this.save(entry)));
    })().finally(() => { this.backgroundYielding = false; });
    return this.yielding;
  }
  async resumeBackground(owner) {
    if (owner !== this.backgroundLeaseOwner) return;
    const version = this.backgroundLeaseVersion;
    clearTimeout(this.backgroundLeaseTimer);
    await this.yielding?.catch(() => {});
    if (owner !== this.backgroundLeaseOwner || version !== this.backgroundLeaseVersion) return;
    clearTimeout(this.backgroundLeaseTimer); this.backgroundLeaseUntil = 0;
    const projects = [...(this.pausedPreloads?.values() || [])]; this.pausedPreloads?.clear();
    if (!this.closed) for (const project of projects) await this.preload(project);
  }
  async updatePlayback(project, input, { borrow = async () => false, release = async () => {} } = {}) {
    const work = (this.playbackChain || Promise.resolve()).catch(() => {}).then(() => this.updatePlaybackNow(project, input, { borrow, release }));
    this.playbackChain = work;
    return work;
  }
  async updatePlaybackNow(project, input, { borrow, release }) {
    if (this.closed) return { closed: true };
    this.retiredPlaybackOwners ||= new Set();
    if (this.retiredPlaybackOwners.has(input.owner)) return { closed: true };
    const entry = await this.entry(project);
    // A delayed cleanup from a previous project/tab cannot release its successor.
    if (input.close) {
      if (this.playback?.owner === input.owner && input.sequence > this.playback.sequence) {
        this.playback.sequence = input.sequence; await this.stopPlayback();
        this.retiredPlaybackOwners.add(input.owner);
      }
      return { closed: true };
    }
    if (!entry.playbackMovie) entry.playbackMovie = new PlaybackMovStore({ dir: entry.dir, width: project.width, height: project.height,
      fps: project.fps || 30, count: Math.max(1, Math.floor(project.duration * (project.fps || 30))) });
    await entry.playbackMovie.ready;
    if (!this.playback || this.playback.owner !== input.owner || this.playback.entry !== entry) {
      if (this.playback && this.playback.owner !== input.owner) this.retiredPlaybackOwners.add(this.playback.owner);
      await this.stopPlayback();
      this.playback = new FramePlayback({ entry, movie: entry.playbackMovie,
        render: (times, options) => this.see_frames(entry.project, times, options),
        cached: async frame => await entry.mov.get(frame) || await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png')).catch(() => null),
        stop: () => this.stopPlayback(), workers: 2 });
      this.playback.owner = input.owner;
    }
    const playback = this.playback;
    if (!playback.update(input)) return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
    if (input.playing) {
      playback.preparing = true;
      await this.yieldBackground(input.owner);
      playback.preparing = false; // The existing two hot slots can start now.
      const wasBorrowed = playback.borrowed;
      const borrowed = await borrow(input.owner);
      playback.borrowed = borrowed;
      if (borrowed && !wasBorrowed) await this.refreshSnapshots(entry);
      playback.release = release;
      playback.setWorkers(borrowed ? 3 : 2);
      this.userPoolSize = playback.workers;
      playback.preparing = false;
    } else {
      this.userPoolSize = 2;
      for (const session of [...this.userPool].reverse()) if (!session.busy && this.userPool.length > 2) this.dropUserSession(session);
      await this.resumeBackground(input.owner); await release(input.owner);
    }
    return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
  }
  async stopPlayback() {
    const playback = this.playback;
    if (!playback) return;
    playback.playing = false; playback.cancel();
    this.userPoolSize = 2;
    await this.resumeBackground(playback.owner); await playback.release?.(playback.owner);
    for (const session of [...this.userPool].reverse()) if (!session.busy && this.userPool.length > 2) this.dropUserSession(session);
  }
  async refreshSnapshots(entry) {
    // The separate background process flushes B before acknowledging yield.
    // Adopt those compressed blocks while preserving newer local samples.
    try {
      const archive = unpackFrameArchive(await fs.readFile(path.join(entry.dir, 'snapshots.base64'), 'utf8'), entry.key,
        { spillDir: path.join(entry.dir, 'html-cache') });
      for (const [frame, html] of entry.html) if (!archive.frames.has(frame)) archive.frames.set(frame, html);
      for (const [id, frames] of entry.controls) {
        if (!archive.controls.has(id)) archive.controls.set(id, new Map(frames));
        else for (const [frame, html] of frames) if (!archive.controls.get(id).has(frame)) archive.controls.get(id).set(frame, html);
      }
      const dispose = entry.disposeArchive;
      entry.html = archive.frames; entry.controls = archive.controls; entry.disposeArchive = archive.dispose;
      entry.recordVersion = (entry.recordVersion || 0) + 1;
      dispose?.();
    } catch { /* A missing/corrupt disposable archive cannot block playback. */ }
  }
  async close() {
    this.closing ||= this.closeNow();
    return this.closing;
  }
  async closeNow() {
    this.closed = true;
    await this.playbackChain?.catch(() => {});
    await this.stopPlayback();
    clearTimeout(this.backgroundLeaseTimer);
    clearTimeout(this.timer);
    this.userGenerationController?.abort();
    this.userGenerationController = null;
    await this.userPrewarm;
    for (const r of this.queue.splice(0)) r.reject(new Error('Renderer closed'));
    for (const generation of this.generations.values()) generation.controller.abort();
    await Promise.allSettled([this.foreground, this.background, ...this.laneChains.values()]);
    await Promise.allSettled([...this.lanes.values()].map(session => { clearTimeout(session.timer); return session.bakery.close(); }));
    this.lanes.clear();
    await Promise.allSettled(this.userPool.map(session => session.bakery.close()));
    this.userPool.length = 0;
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [entry.mov?.close(), entry.playbackMovie?.close()]));
    for (const entry of this.entries.values()) entry.disposeArchive?.();
  }
}
