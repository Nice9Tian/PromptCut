import fs from 'node:fs/promises';
import path from 'node:path';
import { openBakery, bakeFrames, findFfmpeg } from './bakery/index.mjs';
import { captureSnapshot } from './bakery/capture-snapshot.mjs';
import { frameVideo } from './bakery/frame-video.mjs';
import { frameIdentity, trackPrefixes } from './frame-identity.mjs';
import { packFrames, unpackFrameArchive, createFrameArchive, packFrameCache, unpackFrameCache } from './frame-archive.mjs';
import { MovFrameStore, PlaybackMovStore, atomic } from './frame-mov.mjs';
import { FramePlayback } from './frame-playback.mjs';
import { CardFrameCache } from './card-cache.mjs';
import { SnapshotStore, snapshotTier, rangeHas, rangeCount } from './snapshot-store.mjs';
import { createReadyIndex, kindOfTier, wireSnapshotKey } from './ready-index.mjs';
import { prerenderSetOfPlan } from './prerender-set.mjs';
import { createMediaStamper } from './media-stamp.mjs';
import { createHash } from 'node:crypto';
import { isFullyTransparentPng } from './frame-validity.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';
import { anchorFrames } from '../src/render/snapshotPick.mjs';
import { StreamProducer, STREAM_POOL_DEFAULT, STREAM_POOL_MAX } from './frame-stream.mjs';
import { dirtyStreamLease } from './bakery/bake.mjs';

const pad = n => String(n).padStart(6, '0');
const exists = file => fs.access(file).then(() => true, () => false);
// The interactive editor must never wait forever on a renderer that stopped
// answering.  Agent/background renders have their own (longer) budgets; this
// watchdog is only for the human preview lane.
// TODO: 10 seconds may be too aggressive for complex projects or a cold media
// decode. Keep this configurable until we have latency telemetry; raise it
// with PROMPTCUT_USER_RENDER_TIMEOUT_MS when the preview needs more headroom.
const USER_RENDER_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTCUT_USER_RENDER_TIMEOUT_MS) || 10000);
// An open preview repeats its preload request every 2 s until the scene is
// ready (UnifiedPreview). An owner that has not asked for this long has gone
// away: its page was closed or reloaded, and a reloaded default project gets a
// new id. Its background pass must not keep the current project waiting.
export const PRELOAD_STALE_MS = 8000;
/** Agent lane 的 Chrome 空闲这么久就关,下次查询再拉起(cloud-task.md I1) */
export const AGENT_IDLE_MS = 10 * 60 * 1000;

const roundBox = b => ({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) });

/**
 * 素材段的 `contentBox` **一律等于它的 `frameCss` 框**(D4(b)):不在快照里量,按项目数据算。
 * 和 `src/kernel/layout.ts` 的 `frameBox` 同一个式子(锚点在 (x,y),左上角 = (x,y) 减锚点偏移),
 * 宽高走 `src/kernel/frameSize.mjs` 的 `resolveFrameSize` —— 舞台和服务端共用的唯一一份。
 */
export function frameContentBox(frame, stage) {
  const { w, h } = resolveFrameSize(frame, stage);
  const anchor = frame?.anchor ?? [0, 0];
  return roundBox({ left: (frame?.x ?? 0) - (anchor[0] ?? 0) * w, top: (frame?.y ?? 0) - (anchor[1] ?? 0) * h, width: w, height: h });
}

/**
 * D4(b) 回包的**纯计算**部分:片段分成「素材段(按 frameBox 算)」和「卡片(按冻结快照量)」,
 * 再把量出来的实体框并回去。`measured` = `window.__pcSolid.rectsWithBounds` 的返回值,
 * 传 null 表示还没量(只要名单)。不传 `clipIds` 就是全部片段(卡片 + 素材段)。
 *
 * 取 `bounds ?? rect`、四舍五入到整数 —— 和页面侧 `measureContentBoxes` 一字不差。
 */
export function layoutClips(project, clipIds, measured = null, t = 0) {
  const stage = { width: Number(project?.width) > 0 ? project.width : 1920, height: Number(project?.height) > 0 ? project.height : 1080 };
  const byId = new Map();
  for (const track of project?.tracks || []) for (const clip of track?.clips || []) if (clip?.id && !byId.has(clip.id)) byId.set(clip.id, clip);
  const ids = clipIds?.length ? [...new Set(clipIds.map(String))] : [...byId.keys()];
  const clips = {};
  const cardIds = [];
  for (const id of ids) {
    const clip = byId.get(id);
    if (!clip) { clips[id] = { contentBox: null, contentNote: `找不到 clip ${id}` }; continue; }
    // 素材段:不进快照测量,框由项目数据决定
    if (!clip.cardId) { clips[id] = { contentBox: frameContentBox(clip.frame, stage) }; continue; }
    cardIds.push(id);
    if (!measured) { clips[id] = { contentBox: null }; continue; }
    const hit = measured.find(m => m?.clipId === id);
    if (!hit) {
      clips[id] = { contentBox: null, contentNote: `这张卡此刻不在画面上(t=${t}s 不在它的 ${clip.start}~${clip.end}s 区间内),先 seek 进它的时段再读` };
      continue;
    }
    clips[id] = { contentBox: roundBox(hit.bounds ?? hit.rect) };
  }
  return { stage, clips, cardIds };
}

/**
 * D3:`see_frames` 每帧附的实体矩形,在 `captureSnapshot` 的 `afterFonts` 钩子里量(和 `layoutNow` 同一个钩子位置)。
 * 根传 `#pc-frame-snapshot [data-pc-scene]`,调 `window.__pcSolid.rectsWithBounds(root, { pixels: 'all' })`。
 *
 * 回 `Array<{ clipId, box: [x, y, w, h], solid: [x, y, w, h] | null }>`,舞台像素坐标、取整:
 * `box` = 包裹层外框,`solid` = 实体范围,**`null` = 这张卡此刻没有实体像素**。
 * `bounds()` 量不到实体时会退回包裹层外框(给选中描边兜底),和「实体正好铺满包裹层」分不开,
 * 所以这里按 `bounds()` 同一条走法(平面算实体、`isSolid` 的元素不再往下、组流平面跳过、
 * 快照里的 `<img>` 按 `data-pc-painted-box` 那块算)先问一句「舞台内有没有实体」,没有就给 `null`。
 * 页面上没挂 `__pcSolid` 时回 null(不是空数组),调用方据此说「没量出来」。
 */
export const measureEntityRects = page => page.evaluate(() => {
  const root = document.querySelector('#pc-frame-snapshot [data-pc-scene]');
  const api = window.__pcSolid;
  if (!root || typeof api?.rectsWithBounds !== 'function' || typeof api.isSolid !== 'function') return null;
  const origin = root.getBoundingClientRect();
  const r4 = b => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
  const onStage = rc => rc.width > 0 && rc.height > 0 && rc.right > origin.left && rc.left < origin.right && rc.bottom > origin.top && rc.top < origin.bottom;
  // 同 solid.ts 的 paintedBoxAttr + paintedBoxRect:画布像素坐标按 <img> 当前外框换算
  const paintedRect = el => {
    const n = (el.getAttribute('data-pc-painted-box') || '').split(',').map(Number);
    if (n.length !== 4 || n.some(v => !Number.isFinite(v))) return null;
    const rect = el.getBoundingClientRect();
    const w = Number(el.getAttribute('width')) || el.naturalWidth || rect.width;
    const h = Number(el.getAttribute('height')) || el.naturalHeight || rect.height;
    if (!(w > 0) || !(h > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
    const sx = rect.width / w, sy = rect.height / h;
    return new DOMRect(rect.left + n[0] * sx, rect.top + n[1] * sy, n[2] * sx, n[3] * sy);
  };
  const painted = el => {
    if (el.hasAttribute('data-pc-group-plane')) return false;
    if (el.hasAttribute('data-pc-proxy-plane') || el.hasAttribute('data-pc-snapshot-plane') || el.hasAttribute('data-pc-stream-plane')) return onStage(el.getBoundingClientRect());
    if (api.isSolid(el, root)) return onStage((el.tagName === 'IMG' && paintedRect(el)) || el.getBoundingClientRect());
    for (const c of el.children) if (painted(c)) return true;
    return false;
  };
  return api.rectsWithBounds(root, { pixels: 'all' }).map(({ clipId, rect, bounds }) => {
    const wrap = root.querySelector(`[data-pc-clip="${CSS.escape(clipId)}"]`);
    const solid = bounds && wrap && [...wrap.children].some(painted) ? r4(bounds) : null;
    return { clipId, box: r4(rect), solid };
  });
});

/** A foreground batch queue, B complete HTML sampling, C cumulative-track rasterization.
 * Each lane owns its Chrome; foreground never waits for a background bake to finish.
 */
/** C4:没接镜像插件时的播放头(`frameService` 会把真的那个注进来) */
const NO_PLAYHEAD = () => /** @type {{ t: number, playing: boolean, wanted?: { clipId: string, frame: number }[] } | null} */ (null);

export class FramePipeline {
  /**
   * `interactive`(D5):这个实例要不要为页面的交互帧请求养一对热 Chrome。
   *
   *   预渲染进程 `interactive: true` —— 热池在这里,改叫 `streamPool`(G 的分段和
   *     C2 的锚帧用它;大小是 G0-b 的输出参数,初值 2);
   *   编辑器进程 `interactive: false` —— `user` / `playback` lane 立即拒绝
   *     `USE_PRERENDER`,不进 `acquireUser`,两处 `prewarmUser` 都不调。
   *
   * **R6 只加参数和代码路径,默认值保持今天的行为**(两个进程都 `true`);真正把
   * 编辑器进程切成 `false` 是 R7 的原子切换。播放热池的借还和 `stopPlayback()`
   * 还在用,没有删(计划 3.4 末条:底稿说「已删除」是错的)。
   *
   * `playhead`:C4 的 `wanted` 从哪儿读(镜像插件的 `latestPlayhead()`)。
   * frame-pipeline 是 .mjs、镜像插件是 .ts,所以由 `frameService()` 注进来。
   *
   * `mediaUrl(m)`:素材服务上这条素材的绝对 HTTP 地址(取不到回 null),给没有内容哈希的素材打戳时
   * 发 `HEAD` 用(`media-stamp.mjs`)。同样由 `frameService()` 注进来(`ffmpeg-frames.ts` 的
   * `mediaSourceOf`,基址按 `asset-client.ts` 定);不注就是「素材服务不可达」,那种素材的戳是 `'missing'`。
   */
  constructor({ root, origin, code = () => '', captureCode = () => undefined, interactive = true, playhead = NO_PLAYHEAD, mediaUrl = () => null }) {
    this.root = root;
    this.origin = origin;
    this.code = code;
    this.captureCode = captureCode;
    this.interactive = interactive !== false;
    this.playhead = playhead;
    /**
     * 素材戳(`_frameSourceStamp`,进 `frameIdentity`):有哈希就是哈希,没有就问素材服务的 `HEAD`,
     * 不读素材服务的存储目录(`media-stamp.mjs` 文件头)。`/@export/<id>/media/` 是导出自己的产物目录,照旧本地 stat。
     */
    this.mediaStamper = createMediaStamper({ mediaUrl, exportRoot: () => process.env.PROMPTCUT_EXPORT_DIR || path.dirname(this.root) });
    /** C3 的就绪索引。SSE 端点(`GET /api/frames/ready`)直接订阅它 */
    this.readyIndex = createReadyIndex();
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
    /**
     * R8 的 `streamPool`(D5):轨道流自己的裸 bakery,**不经 `acquireUser`、不进 `laneChains`**,
     * 和 legacy 的 `userPool` 热池不共用会话。数量由 `StreamProducer` 定(缺省 1,最多 2)。
     */
    this.streamSessions = [];
  }
  /**
   * 热池在预渲染进程里的名字(D5)。R8 的轨道流按分段借还它
   * (`leaseStreamBakery()` / `returnStreamBakery()`,连同 G4 租约的 `dirty` 位:
   * 任何非 `bakeStream` 的调用跑完就置 `dirty`,下一次 `bakeStream` 见 `dirty`
   * 当租约断掉、付一次完整回放)—— 那两个方法是 R8 的,这里只留位。
   */
  get streamPool() { return this.streamSessions; }
  get streamPoolSize() { return this._streams?.pool ?? STREAM_POOL_DEFAULT; }
  set streamPoolSize(value) { if (this._streams) this._streams.pool = Math.max(1, Math.min(STREAM_POOL_MAX, Math.round(value) || 1)); }
  /**
   * 轨道流的生产者(R8 / G4)。**只在接交互的那个实例(预渲染进程,`interactive: true`)里有** ——
   * 编辑器进程不产流;`streams` 开关关着(`PROMPTCUT_STREAMS=0`)时它在,但什么都不做。
   */
  streamProducer() {
    if (!this.interactive || this.closed) return null;
    return this._streams ||= new StreamProducer(this);
  }
  /**
   * 借一个轨道流会话(G4「会话从哪来」)。空闲的先借;没有就新开一个裸 bakery
   * (停在空项目页上,第一次 `bakeStream` 之前由生产者把隔离工程灌进来)。
   * 同时开着的会话不超过 `STREAM_POOL_MAX`。
   */
  async leaseStreamBakery() {
    for (;;) {
      if (this.closed) throw Object.assign(new Error('Renderer closed'), { cancelled: true });
      const free = this.streamSessions.find(s => !s.busy && !s.dead && s.bakery);
      if (free) {
        free.busy = true;
        clearTimeout(free.idleTimer);
        return free.bakery;
      }
      if (this.streamSessions.filter(s => !s.dead).length < STREAM_POOL_MAX) {
        const session = { bakery: null, busy: true, dead: false, idleTimer: null };
        this.streamSessions.push(session);
        try {
          session.bakery = await openBakery({ url: this.emptyUrl() });
          session.bakery.streamLease = null;
          return session.bakery;
        } catch (error) {
          session.dead = true;
          const at = this.streamSessions.indexOf(session);
          if (at >= 0) this.streamSessions.splice(at, 1);
          throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  /**
   * 还回轨道流会话。`dirty`:借去做了别的(非 `bakeStream`)事 —— 租约作废(D5)。
   * `dead`:会话坏了,关掉。空闲 60 秒的会话也关掉(预渲染进程自建池,不常驻热池)。
   */
  returnStreamBakery(bakery, { dirty = false, dead = false } = {}) {
    const session = this.streamSessions.find(s => s.bakery === bakery);
    if (!session) return;
    if (dirty) dirtyStreamLease(bakery);
    if (dead || this.closed) {
      session.dead = true;
      const at = this.streamSessions.indexOf(session);
      if (at >= 0) this.streamSessions.splice(at, 1);
      void bakery.close().catch(() => {});
      return;
    }
    session.busy = false;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.busy || session.dead) return;
      session.dead = true;
      const at = this.streamSessions.indexOf(session);
      if (at >= 0) this.streamSessions.splice(at, 1);
      void bakery.close().catch(() => {});
    }, 60000);
    session.idleTimer.unref?.();
  }
  /**
   * 现在是不是「忙」(G0-b 结论 1:只在机器空闲时生产;用户拖动或播放时生产暂停让路)。
   * 判据:legacy 播放热池在用 / 后台让路租约在期;镜像插件报的播放头「在播」且 5 秒内有过音讯
   * (播放中页面按 100 ms 节流报 `wanted`,停下也会报一次);或者 800 ms 内刚动过(拖动)。
   */
  streamBusy(now = Date.now()) {
    if (this.closed) return true;
    if (this.playback?.playing) return true;
    if (this.backgroundLeaseUntil > now) return true;
    let head = null;
    try { head = this.playhead(); } catch {}
    const at = Number(head?.at);
    if (Number.isFinite(at)) {
      if (head.playing && now - at < 5000) return true;
      if (now - at < 800) return true;
    }
    return false;
  }
  /**
   * 这个实例接不接页面的交互 / 播放 lane(D5 的 `interactive`),以及 Agent lane。
   *
   * `interactive: false` 的实例(编辑器进程)**没有 Agent lane**:Agent 的查询(`see_frames` 的
   * agent 批、`layout`、`entityRects`、`/api/cards/dom`)只在预渲染进程里跑
   * (`docs/semantics/architecture/rendering.md`「查询渲染与预渲染进程」)。编辑器进程里
   * 走到这里就回 `503 NO_AGENT_LANE`,不在编辑器这一侧开 Chrome。
   */
  laneRefused(lane) {
    if (this.interactive) return null;
    if (lane === 'agent') return Object.assign(new Error('这个进程没有 Agent lane:Agent 的查询只在预渲染进程里跑。'), { status: 503, code: 'NO_AGENT_LANE', retryable: true });
    if (lane !== 'user' && lane !== 'playback') return null;
    return Object.assign(new Error('交互帧请求请直接打预渲染进程。'), { status: 503, code: 'USE_PRERENDER' });
  }
  /**
   * **Agent lane 的唯一入队口**(T1a 审查 #12)。`see_frames` 的 agent 批、`layout`、`entityRects`、
   * `/api/cards/dom`(`vite-plugin-cards.ts`)都经它排进同一条链:每个任务「等前一个 → 借 bakery →
   * 干活 → 还」,所以同一时刻至多一个任务在驱动 agent lane 的那一个页面,谁也绕不过谁。
   *
   * 以前 `layout` / `entityRects` 各自 `laneChains.get('agent')` 再 `set` 回去,`/api/cards/dom`
   * 另有一条 `domChain` 和一个自己的 Chrome —— 后者和在飞的 `see_frames` 同时驱动页面是可能的。
   *
   * `work(lease)`:`lease(project)` 借 agent lane 的 bakery,按 `project` 重置同一个页面
   * (一个任务里可以借多次,比如一批里有两个项目);`lease(project, { asIs: true })` 不重置、
   * 原样交出(调用方马上自己 `reset`,省一次开页)。**借过才还,还由这里统一做**,调用方不调
   * `release('agent')`。空闲关闭见 `release`。
   */
  runAgentTask(work) {
    const refused = this.laneRefused('agent');
    if (refused) return Promise.reject(refused);
    const task = (this.laneChains.get('agent') || Promise.resolve()).catch(() => {}).then(async () => {
      let leased = false;
      const lease = async (project, { asIs = false } = {}) => {
        leased = true;
        const current = this.lanes.get('agent');
        if (asIs && current) { clearTimeout(current.timer); return current.bakery; }
        return this.acquire('agent', project);
      };
      try { return await work(lease); }
      finally { if (leased) this.release('agent'); }
    });
    this.laneChains.set('agent', task.catch(() => {}));
    return task;
  }
  /** C4:镜像插件里这一刻的 `wanted`(页面报的「播放头附近现在缺哪些层」) */
  playheadWanted() {
    try { return this.playhead()?.wanted ?? []; } catch { return []; }
  }
  /** C4:`wanted` 让哪一批插了队。只给诊断看,留最近 32 条 */
  notePromotion(record) {
    (this.promotions ||= []).push({ ...record, at: Date.now() });
    while (this.promotions.length > 32) this.promotions.shift();
  }
  /** 端到端探针的读口:超限帧(A3c)、`wanted` 的插队(C4)、预渲染集合(pinned 渲染 9) */
  diagnostics() {
    return { oversize: this._snapshots?.oversize ?? [], promotions: this.promotions ?? [], plans: this.planDiagnostics(),
      streams: this._streams?.status() ?? null };
  }
  /**
   * 每个 entry 此刻的预渲染集合和它的 card plan 摘要 —— `ready-index-probe` 靠它
   * 证明「在所有位置都判轻的卡不产快照」,顺带把 `costKey` 露出来,探针才能为某张卡
   * PUT 一条成本记录(那个键只有 `card-cache.mjs` 的 `plan()` 算得出来)。只读、不改状态。
   */
  planDiagnostics() {
    const list = [];
    for (const entry of this.entries?.values?.() ?? []) {
      if (!entry?.cardPlan?.length) continue;
      list.push({
        key: entry.key,
        prerenderSet: entry.prerenderSet instanceof Set ? [...entry.prerenderSet].sort() : null,
        controls: entry.cardPlan.map(control => ({
          clipId: control.clipId, costKey: control.costKey, snapshotKey: control.snapshotKey,
          frameMode: control.frameMode ?? control.capabilities?.frameMode ?? null,
          tier: control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none',
          picked: this.prerenderPicked(entry, control.clipId),
        })),
      });
    }
    return list;
  }
  async entry(project) {
    project = { ...project, media: await Promise.all((project.media || []).map(async media => {
      const stamp = await this.mediaStamper.stamp(media);
      return stamp === undefined ? media : { ...media, _frameSourceStamp: stamp };
    })) };
    const code = this.code(project);
    const key = frameIdentity(project, code);
    if (!this.entries.has(key)) {
      const entry = { key, code, project: structuredClone(project), recordVersion: 0, html: new Map(), controls: new Map(), dir: path.join(this.root, key), status: 'idle', error: null };
      // Controls are content addressed independently of the full-scene entry;
      // a project edit that invalidates the scene can still reuse an unchanged
      // card MOV from <pipeline-root>/controls/<control-key>.
      entry.cardCache = new CardFrameCache({ root: this.root, project: entry.project,
        capture: () => this.captureCode(), scale: () => this.scaleForLane('background') });
      const cold = createFrameArchive({ spillDir: path.join(entry.dir, 'html-cache') });
      entry.html = cold.frames; entry.controls = cold.controls;
      entry.createControl = cold.createControl; entry.disposeArchive = cold.dispose;
      entry.mov = new MovFrameStore({ dir: entry.dir, fps: project.fps || 30 });
      // A removed or replaced full-scene frame must not stay published in the
      // playback movie: put that sample back to transparent.
      entry.mov.onEvict = frame => entry.playbackMovie?.evict(frame);
      this.entries.set(key, entry);
      entry.loading = this.loadArchive(entry).then(archive => {
        try {
          entry.disposeArchive?.();
          entry.html = archive.frames;
          entry.controls = archive.controls;
          entry.createControl = archive.createControl;
          entry.disposeArchive = archive.dispose;
        } catch { /* Disposable cache. */ }
      }, () => {});
    }
    const entry = this.entries.get(key);
    await entry.loading;
    return entry;
  }
  async loadArchive(entry) {
    const options = { dir: entry.dir, spillDir: path.join(entry.dir, 'html-cache') };
    try { return unpackFrameCache(await fs.readFile(path.join(entry.dir, 'html-manifest.json'), 'utf8'), entry.key, options); }
    catch {
      const file = path.join(entry.dir, 'snapshots.base64');
      // Old monolithic local caches are disposable. Do not read a multi-GB
      // legacy file into memory just to discover that it cannot be opened.
      if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('Legacy frame cache exceeds import budget');
      return unpackFrameArchive(await fs.readFile(file, 'utf8'), entry.key, options);
    }
  }
  async portableArchive(entry) {
    await this.save(entry);
    return packFrames(entry.key, entry.html, entry.controls, { fps: entry.project.fps || 30, maxBytes: 16 * 1024 * 1024 });
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
  /** What a full-scene frame must have been produced by to be served: the
   * capture code and the keys of the cards visible at that frame. The entry key
   * already covers the project; these are the inputs it does not. Card keys are
   * unknown (null) until a browser plan has been computed for this entry.
   *
   * The device scale is deliberately not part of it: with
   * PROMPTCUT_PRERENDER_SCALE set, the background lane and the 1x lanes would
   * evict each other's frames forever and full.mov would never complete. Mixed
   * scales in one store predate this check and remain as they were. */
  // eslint-disable-next-line no-unused-vars
  renderSignature(entry, frame, lane) {
    const fps = Number(entry.project.fps) || 30;
    let cards = null;
    if (Array.isArray(entry.cardPlan)) {
      const keys = entry.cardPlan.filter(control => frame >= control.sampling.firstFrame && frame / fps < control.end - 1e-9)
        .map(control => control.key).sort();
      cards = createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
    }
    return { capture: this.captureCode() || undefined, cards };
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
    // D5:`interactive: false` 的实例(R7 之后的编辑器进程)不养热 Chrome
    if (!this.interactive) return;
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
  /**
   * 还 lane 的 bakery,起空闲计时器。`background` 30 秒没人借就关;`agent` 10 分钟
   * (`docs/plan/cloud-task.md` I1:一个 Chrome、按需拉起、空闲 10 分钟关 —— 以前 `/api/cards/dom`
   * 自己那个 Chrome 闲 90 秒关,并进 agent lane 之后统一由这里管)。下一次 `acquire` 清掉计时器。
   */
  release(lane) {
    const session = this.lanes.get(lane);
    if (!session) return;
    if (lane === 'user') return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.lanes.get(lane) !== session) return;
      this.lanes.delete(lane);
      void session.bakery.close().catch(() => {});
    }, lane === 'agent' ? AGENT_IDLE_MS : 30000);
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
          } else if (currentLane === 'agent') {
            // #12:agent 批和 layout / entityRects / DOM 查询排同一条队,bakery 由 runAgentTask 借还
            this.runAgentTask(lease => this.flush(laneRequests, currentLane, lease))
              .catch(error => laneRequests.forEach(r => r.reject(error)));
          } else {
            const chain = (this.laneChains.get(currentLane) || Promise.resolve()).catch(() => {}).then(() => this.flush(laneRequests, currentLane));
            this.laneChains.set(currentLane, chain);
          }
        }
      }, 12);
    });
  }
  /** `lease`:agent 批由 `runAgentTask` 传进来的借 bakery 函数;其余 lane 不传,照旧自己 `acquire` */
  async flush(requests, lane = 'agent', lease) {
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
        }, lease);
        for (const request of group) {
          if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) request.reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
          else request.resolve(new Map(request.frames.map(n => [n, result.get(n)])));
        }
      } catch (e) { group.forEach(r => r.reject(e)); }
    }
  }
  async readFrames(entry, frames, lane = 'agent', signal, onFrame, lease) {
    // D5:`interactive: false` 时这两条 lane 立即拒绝,不进 `acquireUser`
    const refused = this.laneRefused(lane);
    if (refused) throw refused;
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
    return this.readFramesCore(entry, frames, lane, signal, undefined, onFrame, lease);
  }
  /** `lease`:见 `flush`。传了就用它借 bakery、不自己还(`runAgentTask` 统一还) */
  async readFramesCore(entry, frames, lane = 'agent', signal, onSession, onFrame, lease) {
    const result = new Map();
    const htmlFrames = [];
    const missing = [];
    await entry.mov?.ready;
    // MOV is the first lookup: it is already the full scene with media and is
    // the cheapest exact answer. HTML is the high-priority producer for a
    // missing MOV frame, so random access can still avoid loading media.
    for (const frame of frames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const buf = await entry.mov?.lookup(frame, this.renderSignature(entry, frame, lane));
      if (buf) result.set(frame, { buf, source: 'mov' });
      else {
        // Compatibility with the pre-MOV cumulative PNG cache. It is still a
        // valid full-scene result and lets old projects avoid a re-render.
        // It has no render record, so an empty image there is not trusted.
        try {
          const legacy = await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png'));
          if (isFullyTransparentPng(legacy)) throw new Error('Empty legacy frame');
          result.set(frame, { buf: legacy, source: 'rendered' });
        }
        catch { if (entry.html?.has?.(frame)) htmlFrames.push(frame); else missing.push(frame); }
      }
      if (result.has(frame)) await onFrame?.(frame, result.get(frame));
    }
    if (!htmlFrames.length && !missing.length) return result;
    // While a required card is still being prerendered, the paused stage asks
    // for the same frame every 700 ms. Serve the placeholder already rendered
    // for exactly the cards still missing instead of rendering another one.
    if ((lane === 'user' || lane === 'playback') && entry.placeholders?.size && entry.cardPlan?.length) {
      const waiting = [...htmlFrames, ...missing].filter(frame => entry.placeholders.has(frame));
      const state = waiting.length ? await entry.cardCache.renderState(entry.cardPlan, waiting) : null;
      for (const frame of waiting) {
        const absent = state.missing[frame] || [];
        if (!absent.length || entry.placeholders.get(frame) !== absent.join('\n')) continue;
        const buf = await fs.readFile(path.join(entry.dir, 'preview-frames', pad(frame) + '.png')).catch(() => null);
        if (!buf) continue;
        const value = { buf, source: 'preview', incomplete: true, missing: absent };
        result.set(frame, value);
        await onFrame?.(frame, value);
      }
      for (const list of [htmlFrames, missing]) {
        for (let i = list.length - 1; i >= 0; i--) if (result.has(list[i])) list.splice(i, 1);
      }
      if (!htmlFrames.length && !missing.length) return result;
    }
    const userSession = lane === 'user' || lane === 'playback' ? await this.acquireUser(entry.project, signal, onSession) : null;
    const bakery = userSession?.bakery || await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      // The browser owns graph planning because it is the only place that can
      // prove a legacy Chrome card's capabilities.  Cache misses are supplied
      // only to interactive rendering; agent/final lanes keep the real Chrome
      // card so their result can never accidentally become a final placeholder.
      const cardRender = await this.cardRender(entry, bakery, frames, lane);
      const incompleteFor = frame => (lane === 'user' || lane === 'playback') ? (cardRender?.missing?.[frame] || []) : [];
      if (cardRender && (Object.keys(cardRender.frames).length || (lane === 'user' || lane === 'playback') && Object.keys(cardRender.missing).length)) {
        await this.installCardRender(bakery, entry.project, cardRender);
      }
      // The full-scene MOV lane owns the result returned by see_frames. It
      // still records HTML snapshots while it advances, so the next request
      // can replay without loading media. HTML is the higher-priority cache;
      // MOV only fills frames absent from its table.
      const htmlReplay = async frame => {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const prefixes = this.prefixes(entry);
        let buf;
        for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
        if (!incompleteFor(frame).length) await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
        const absent = incompleteFor(frame);
        // A placeholder is a user-preview artifact.  It must never enter the
        // durable full-scene MOV or HTML/final raster cache.
        if (!absent.length) await this.writeMov(entry, frame, buf, this.renderSignature(entry, frame, lane));
        else {
          await atomic(path.join(entry.dir, 'preview-frames', pad(frame) + '.png'), buf);
          (entry.placeholders ||= new Map()).set(frame, absent.join('\n'));
        }
        const value = absent.length ? { buf, source: 'preview', incomplete: true, missing: absent }
          : { buf, source: 'html', ...(entry.mov?.unconfirmedClear(frame) ? { unconfirmedClear: true } : {}) };
        result.set(frame, value);
        await onFrame?.(frame, value);
      };
      for (const frame of htmlFrames) await htmlReplay(frame);
      if (!missing.length) return result;
      const transient = Object.keys(cardRender?.missing || {}).length ? new Map() : null;
      await this.renderMovFrames(entry, missing, bakery, signal, async (frame, value) => {
        const absent = incompleteFor(frame);
        if (absent.length) {
          await atomic(path.join(entry.dir, 'preview-frames', pad(frame) + '.png'), value.buf);
          (entry.placeholders ||= new Map()).set(frame, absent.join('\n'));
        }
        await onFrame?.(frame, absent.length ? { ...value, source: 'preview', incomplete: true, missing: absent } : value);
      }, transient, lane);
      for (const frame of missing) {
        const buf = transient?.get(frame) || await entry.mov.get(frame);
        const absent = incompleteFor(frame);
        if (!buf && !absent.length) throw new Error(`MOV frame ${frame} was not written`);
        if (absent.length) result.set(frame, { buf, source: 'preview', incomplete: true, missing: absent });
        else result.set(frame, { buf, source: 'mov', ...(entry.mov.unconfirmedClear(frame) ? { unconfirmedClear: true } : {}) });
      }
    } finally {
      if (userSession) this.releaseUser(userSession);
      else if (!lease) this.release(lane);
    }
    return result;
  }
  async browserCardPlan(bakery) {
    try {
      return await bakery.page.evaluate(() => typeof window.__pcCardPlan === 'function' ? window.__pcCardPlan() : null);
    } catch { return null; }
  }
  async cardRender(entry, bakery, frames, lane) {
    const browserPlan = await this.browserCardPlan(bakery);
    if (!browserPlan) return null;
    let plan;
    try { plan = entry.cardCache.plan(browserPlan); } catch { return null; }
    this.adoptCardPlan(entry, plan);
    if (!plan.length) return null;
    const state = await entry.cardCache.renderState(plan, frames);
    // The final/agent path deliberately does not inject `missing`: an absent
    // control must fall through to the original Chrome implementation.  The
    // interactive path gets an explicit incomplete signal for its placeholder.
    if (lane !== 'user' && lane !== 'playback') state.missing = {};
    return state;
  }
  async installCardRender(bakery, project, cardRender) {
    const rendered = { ...project, _cardRender: cardRender };
    await bakery.loadProject(rendered, { deferCards: true });
    await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
  }
  async renderMovFrames(entry, frames, bakery, signal, onFrame, transient = null, lane = 'background') {
    // Every write and every "already rendered" decision is checked against
    // what would produce the frame now (see renderSignature). An empty image
    // stays "waiting to render" until a second render agrees with it.
    const signature = frame => this.renderSignature(entry, frame, lane);
    const flag = frame => !transient && entry.mov.unconfirmedClear(frame) ? { unconfirmedClear: true } : {};
    // Frames the other process (editor server / prerender worker) already rendered count.
    await entry.mov.hydrate(frames);
    // Reuse HTML-complete frames first. This is the background equivalent of
    // see_frames' HTML lookup and avoids loading media for frames already
    // frozen by the higher-priority lane.
    const htmlFrames = frames.filter(frame => !entry.mov.valid(frame, signature(frame)) && entry.html.has(frame));
    for (const frame of htmlFrames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const prefixes = this.prefixes(entry);
      let buf;
      for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
      if (!transient) await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
      if (transient) transient.set(frame, buf); else await this.writeMov(entry, frame, buf, signature(frame));
      await onFrame?.(frame, { buf, source: 'html', ...flag(frame) });
    }
    const missing = frames.filter(frame => !entry.mov.valid(frame, signature(frame)));
    if (!missing.length) return;
    const requested = new Set(missing);
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: missing, snapshotOnly: false, fullFrame: true,
      snapshotFrames: new Set(missing),
      writeFrames: false, signal,
      onFrame: async (frame, buf) => {
        if (requested.has(frame)) {
          if (transient) transient.set(frame, buf); else await this.writeMov(entry, frame, buf, signature(frame));
          await onFrame?.(frame, { buf, source: 'live', ...flag(frame) });
        }
      },
      // MOV passes still record HTML for the same live state, but only when the
      // HTML lane did not already have that frame.
      onSnapshot: (n, html, controls) => !transient && !entry.html.has(n) && requested.has(n) && this.record(entry, n, html, controls),
    });
    if (!transient) await this.save(entry);
  }
  async writeMov(entry, frame, buf, signature = null) {
    if (!entry.mov) return;
    // Store the random-access copy first. Starting ffmpeg for an isolated
    // high-numbered request would leave a pipe waiting forever for frame 0.
    await entry.mov.put(frame, buf, signature);
    // During playback the append-only PNG MOV is the sink. Do not start an
    // additional ffmpeg stream competing for the same CPU budget.
    if ((this.playback?.playing || this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) && entry.stage !== 'required') return;
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
      if (!entry.controls.has(control.id)) entry.controls.set(control.id, entry.createControl?.(control.id) || new Map());
      // The control cache is intentionally addressed by the control's own
      // local frame (the `t` used by the card), so it can be replayed without
      // knowing the clip's global start time.
      entry.controls.get(control.id).set(control.frame, control.html);
    }
    this.recordSnapshots(entry, controls);
  }
  /**
   * pinned 渲染 9:**只预渲染预渲染集合 `plan.prerenderSet`(任一位置判重的卡的并集)
   * 里的卡** —— 在所有位置都判轻的卡不产快照、不进就绪索引。
   *
   * 集合由 `adoptCardPlan` 用两端同一份 `planPipelines` 按实测 `costs` 算;一条成本
   * 记录都没有时 `prerenderSetOfPlan` 自己按声明兜底(`declaredHeavy`)。集合压根没
   * 算过(没走过 `adoptCardPlan`,比如手工构造 entry 的调用方)时不过滤。
   */
  prerenderPicked(entry, clipId) {
    const set = entry?.prerenderSet;
    if (!(set instanceof Set)) return true;
    return set.has(clipId);
  }
  /** clipId → { tier, key }:整场景路冻出来的 control 子树该落到哪个档、哪个键。
   * 只有 `card-cache.mjs` 的 `plan` 手里有共享键(`cardSnapshotIdentity` 算的),
   * 所以这里认 `entry.cardPlan`(`preload` 里存下来的那份);拿不到就不写快照库。
   * 不在预渲染集合里的卡一律不给 target —— 整场景路(`recordSnapshots` /
   * `renderLocalSnapshots`)因此对它什么都不产(pinned 渲染 9)。 */
  snapshotTargets(entry) {
    const plan = entry.cardPlan;
    if (!plan?.length) return null;
    if (entry.snapshotPlan !== plan || entry.snapshotTargetSet !== entry.prerenderSet) {
      entry.snapshotPlan = plan;
      entry.snapshotTargetSet = entry.prerenderSet;
      entry.snapshotTargetMap = new Map(plan
        .filter(control => control.clipId && control.snapshotKey && this.prerenderPicked(entry, control.clipId))
        .map(control => [control.clipId, { tier: control.tier || snapshotTier(control.capabilities), key: control.snapshotKey, capabilities: control.capabilities }])
        .filter(([, target]) => target.tier === 'shared' || target.tier === 'local'));
    }
    return entry.snapshotTargetMap;
  }
  /**
   * 整场景路(C2)冻出来的 control HTML 同时写进 A3a 的快照库
   * (`<root>/controls-html/<共享键>/` 与 `<root>/controls-local/<entry.key>/<共享键>/`)。
   *
   * 老的 `entry.controls` → `html-manifest.json` **一并保留**:今天的回放和导出
   * 还从那份 manifest 读(`renderState` / `unpackFrameCache`),现在抽掉会直接缺料。
   * 两处并存期间快照库是「去向」、manifest 是「现状」,第 4 步之后才换读侧。
   *
   * `belowDependent`(毛玻璃)只能由这条整场景路产:它的结果受下层影响,隔离工程
   * 里画不出来。它的本地档键这一版按 A3a 先用整项目的 `entry.key` 兜底
   * (更粗:项目里任何改动都会换 `entry.key`、整棵本地档作废),`localSceneKey`
   * 和「下层活跃控件的共享键 + 位置」是后面的事。
   */
  recordSnapshots(entry, controls) {
    const targets = this.snapshotTargets(entry);
    if (!targets?.size || !controls?.length) return;
    for (const control of controls) {
      const target = targets.get(control.id);
      if (!target || !Number.isInteger(control.frame)) continue;
      const entryKey = target.tier === 'local' ? entry.key : undefined;
      const batches = (entry.snapshotPending ||= new Map());
      const id = `${target.tier}\u0000${entryKey ?? ''}\u0000${target.key}`;
      // #9:写帧、判体积、并 index 由快照库的 `batch` 一起做(攒满 4 帧交一次)。A3c 的通用兜底
      // 照旧:超限的那一帧**照常落盘**,但不进就绪索引、不投递 —— 那一层按缺料处理(贴更早的
      // 合格快照,没有就透明),并记一条诊断;R6-14:帧号记进 index.json 的 `oversize`,下一趟跳过。
      if (!batches.has(id)) batches.set(id, this.snapshots().batch({ tier: target.tier, entryKey, key: target.key, clipId: control.id, capabilities: target.capabilities }));
      const batch = batches.get(id);
      const html = control.html;
      entry.snapshotChain = (entry.snapshotChain || Promise.resolve()).then(async () => {
        // 快照库是旁路:写失败不能把整条预渲染管线带下去(老 manifest 仍然写成了)。
        try { await batch.add(control.frame, html); } catch {}
      });
    }
  }
  /** 等这一批帧交完(写文件 + 并 index,由快照库的 `batch` 一起做),再按 C3 把这一层此刻的
   * 全部就绪区间发出去(全量语义)。全是超限帧的批也照样写了 index(R6-14),只是不发 `layer`。 */
  async flushSnapshots(entry) {
    try { await entry.snapshotChain; } catch {}
    const batches = entry.snapshotPending;
    if (!batches?.size) return;
    entry.snapshotPending = new Map();
    for (const batch of batches.values()) {
      try {
        const index = await batch.close();
        if (index && batch.written) this.publishLayer({ clipId: batch.clipId, snapshotKey: batch.key }, batch.tier, index.frames, batch.entryKey);
      } catch {}
    }
  }
  async save(entry) {
    const work = (entry.saveChain || Promise.resolve()).catch(() => {}).then(() => this.saveNow(entry)).then(() => this.flushSnapshots(entry));
    entry.saveChain = work;
    return work;
  }
  async saveNow(entry) {
    const version = entry.recordVersion;
    if (entry.savedVersion !== undefined && entry.savedVersion === version) return;
    const encoded = packFrameCache(entry.dir, entry.key, entry.html, entry.controls, {
      fps: entry.project.fps || 30,
    });
    await atomic(path.join(entry.dir, 'html-manifest.json'), encoded);
    entry.savedVersion = version;
    if (entry.recordVersion !== version) return;
    // Re-open our own archive so the hot pipeline keeps compressed blocks and
    // only a small expanded window, rather than every full HTML string.
    const archive = unpackFrameCache(encoded, entry.key, { dir: entry.dir, spillDir: path.join(entry.dir, 'html-cache') });
    // Concurrent playback batches may record new frames during the disk write.
    // Do not replace their live map with the older archive snapshot.
    if (entry.recordVersion === version) {
      const dispose = entry.disposeArchive;
      entry.html = archive.frames;
      entry.controls = archive.controls;
      entry.createControl = archive.createControl;
      entry.disposeArchive = archive.dispose;
      dispose?.();
    }
  }
  /** Abort the background generations of owners that stopped asking (PRELOAD_STALE_MS).
   * Background passes run one after another, so a generation nobody waits
   * for would otherwise hold every later project behind its whole pipeline. */
  retireStalePreloads(owner, now = Date.now()) {
    for (const [other, generation] of this.generations) {
      if (other === owner || now - generation.seenAt <= PRELOAD_STALE_MS) continue;
      generation.controller.abort();
      this.generations.delete(other);
    }
  }
  async preload(project) {
    const entry = await this.entry(project);
    const owner = project.id || 'active';
    const now = Date.now();
    this.retireStalePreloads(owner, now);
    const previous = this.generations.get(owner);
    if (previous?.key === entry.key && !previous.controller.signal.aborted && !['error', 'cancelled', 'partial'].includes(entry.status)) {
      previous.seenAt = now;
      return entry;
    }
    previous?.controller.abort();
    const controller = new AbortController();
    this.generations.set(owner, { key: entry.key, controller, seenAt: now });
    entry.status = 'queued';
    this.background = this.background.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      let bakery;
      try {
        entry.status = 'html';
        const count = Math.max(1, Math.floor(project.duration * (project.fps || 30)));
        bakery = await this.acquire('background', entry.project);
        const browserPlan = await this.browserCardPlan(bakery);
        let cardPlan = [];
        try { cardPlan = browserPlan ? entry.cardCache.plan(browserPlan) : []; } catch {}
        if (browserPlan) this.adoptCardPlan(entry, cardPlan);
        entry.stage = 'required';
        // C2:**锚帧全部就绪前不开始其余后台预渲染**。
        await this.fillAnchorSnapshots(entry, bakery, controller.signal);
        // R8 / G4:锚帧就绪之后轨道流开始生产。它有自己的会话(`streamPool`),不占这条 lane,
        // 也不等它 —— 这里只是把这一版的流交给生产者
        if (!controller.signal.aborted) void this.streamProducer()?.update(entry).catch(() => {});
        await this.fillCardControls(entry, bakery, controller.signal, cardPlan.filter(c => c.cacheable && c.needPrerendering));
        // C2 本地档那一趟:一趟整场景服务该帧上全部本地档卡(毛玻璃 / unknown)
        await this.renderLocalSnapshots(entry, await this.missingSnapshotFrames(entry, { tiers: ['local'] }), bakery, controller.signal);
        await this.fillRequiredScene(entry, bakery, controller.signal, cardPlan);
        if (this.playback?.playing) { entry.status = 'partial'; return; }
        entry.stage = 'direct';
        await this.fillCardControls(entry, bakery, controller.signal, cardPlan.filter(c => c.cacheable && !c.needPrerendering));
        // `size === count` is not enough for a sparse archive: a foreground
        // request can contain exactly `count` entries while still missing one
        // frame and containing an out-of-range index.  C must only start after
        // B has every frame in the canonical 0..count-1 range.
        const complete = entry.html.size === count && [...Array(count).keys()].every(n => entry.html.has(n));
        if (!complete) {
          const blockFrames = Math.max(1, Math.min(16, Math.round(project.fps || 30)));
          await bakeFrames(bakery, { out: entry.dir, frames: `0-${count - 1}`, snapshotOnly: true,
            signal: controller.signal, onSnapshot: async (n, html, controls) => {
              this.record(entry, n, html, controls);
              // Publish small increments: a 60-second batch of frozen 1080p
              // HTML can take seconds to compress even when spills bound RAM.
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
        entry.stage = 'ready';
      } catch (e) {
        entry.status = controller.signal.aborted ? 'cancelled' : 'error';
        entry.error = controller.signal.aborted ? null : String(e.message || e);
        // A cancelled MOV pass leaves its stream open; closing the pipeline
        // later would publish that prefix as the whole movie. Drop the stream;
        // the next pass replays the PNGs.
        if (controller.signal.aborted) await entry.mov?.suspend().catch(() => {});
      } finally { if (entry.stage !== 'ready') entry.stage = undefined; if (bakery && this.lanes.get('background')?.bakery === bakery) this.release('background'); }
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
  async fillRequiredScene(entry, bakery, signal, controls) {
    const fps = Number(entry.project.fps) || 30, wanted = new Set();
    for (const control of controls) if (control.needPrerendering && !control.cacheable) {
      for (let frame = control.sampling.firstFrame; frame / fps < control.end - 1e-9; frame++) wanted.add(frame);
    }
    if (wanted.size) await this.renderMovFrames(entry, [...wanted].sort((a, b) => a - b), bakery, signal);
  }
  /** A3a 的 HTML 快照库(<root>/controls-html、<root>/controls-local)。
   * 和 `entry.cardCache`(PNG/MOV,legacy 整帧通道和导出用)并存 —— 后者随
   * legacy 通道一起删,在那之前照常写,不然导出和旧播放路会缺料。 */
  snapshots() { return this._snapshots ||= new SnapshotStore(this.root); }
  /**
   * F5 预渲染进程重启后的恢复:起来先扫
   * `controls-html/<共享键>/index.json` 和 `controls-local/<entry.key>/<共享键>/index.json`,
   * 重建 C3 的就绪索引。
   *
   * **扫盘只得到「键 → 区间」** —— 目录名是剥掉 clipId 的共享键,所以这里只把它们
   * 挂在键上(`stageByKey`),不发 `layer`;等 `ensureMirror` 回拉 / `repushMirror`
   * 补推把项目送回来、`adoptCardPlan` 重算出 card plan,再按
   * `control.clipId` ↔ `control.snapshotKey` 反查、一次 `reset` + 全量 `layer`。
   *
   * 轨道流(R8)的清单 `<库根>/streams/<streamKey>/stream.json` 同样扫一遍、挂在键上(`kind: 'stream'`)。
   */
  async rescanSnapshots() {
    const store = this.snapshots();
    const read = async target => {
      try { return await store.snapshotIndex(target); } catch { return { count: 0, frames: [] }; }
    };
    const list = async dir => { try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; } };
    let found = 0;
    for (const item of await list(path.join(this.root, 'controls-html'))) {
      if (!item.isDirectory()) continue;
      const index = await read({ tier: 'shared', key: item.name });
      if (!index.count) continue;
      this.readyIndex.stageByKey({ kind: 'html', key: item.name, ranges: index.frames });
      found++;
    }
    for (const outer of await list(path.join(this.root, 'controls-local'))) {
      if (!outer.isDirectory()) continue;
      for (const item of await list(path.join(this.root, 'controls-local', outer.name))) {
        if (!item.isDirectory()) continue;
        const index = await read({ tier: 'local', entryKey: outer.name, key: item.name });
        if (!index.count) continue;
        // 本地档的线上 `key` 自带一个斜杠:`<entry.key>/<共享键>`(C3 / J3)
        this.readyIndex.stageByKey({ kind: 'local', key: `${outer.name}/${item.name}`, ranges: index.frames });
        found++;
      }
    }
    try { found += (await this.streamProducer()?.rescan()) ?? 0; } catch {}
    return found;
  }
  /**
   * card plan 到位(F5)。扫盘只得到「键 → 区间」,`layer` 和页面的 `readyIndex`
   * 却都按 clipId 索引 —— 所以重启之后要等项目回来、重算 card plan,才能用
   * `control.clipId` ↔ `control.snapshotKey` 反查。认领成功时索引自己会先发
   * `reset` 再发全量 `layer`(C3 本来就是全量语义,不加新端点)。
   *
   * 顺带把「产哪些卡」记在 entry 上(`prerenderSetOf` 的窄接口)。这个集合是
   * **消费方**:`prerenderPicked` 把它接进 `snapshotTargets` / `missingSnapshotFrames` /
   * `fillCardControls` / 就绪索引认领,在所有位置都判轻的卡因此什么都不产(pinned 渲染 9)。
   */
  adoptCardPlan(entry, plan) {
    entry.cardPlan = plan;
    /*
     * C3 的 `reset`(R6-7:以前 `ready-index.mjs` 的 `reset()` 压根没有调用方)。
     * `entry.key` 是内容寻址的 —— 换项目、改编排都会换一个 key,那一刻页面手里的表
     * 还挂着上一版的层(已删片段的旧层会一直留着,第二个项目的 `done` 也不会再发)。
     * 认领路(`claim`)只有扫盘挂着东西时才 reset,常规路径上走不到,所以在这里补一次。
     */
    if (this.adoptedEntryKey !== entry.key) {
      this.adoptedEntryKey = entry.key;
      try { this.readyIndex.reset(this.readyIndex.localRev); } catch {}
    }
    // K2 / K6:真的按 planPipelines 的表算(costs / tuning 由编辑器进程转发过来、落在本机那一份)
    entry.prerenderSet = prerenderSetOfPlan(plan, { fps: Number(entry.project?.fps) || 30, root: this.root });
    const layers = [];
    for (const control of plan ?? []) {
      // pinned 渲染 9:在所有位置都判轻的卡不进就绪索引
      if (!this.prerenderPicked(entry, control.clipId)) continue;
      const tier = control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      const kind = kindOfTier(tier);
      const key = wireSnapshotKey(tier, entry.key, control.snapshotKey);
      if (kind && key && control.clipId) layers.push({ clipId: control.clipId, kind, key });
    }
    // R8:已经在生产者手里的流一并认领(F5 扫盘挂着的流键也在这里认)
    for (const layer of this._streams?.claimLayers() ?? []) layers.push(layer);
    try { this.readyIndex.claim(layers, this.readyIndex.localRev); } catch {}
    // 认领是「清表后全量重发」,组流的 `groupClipIds` 不在认领表里 —— 由生产者按清单补发一次
    this._streams?.republish();
    return plan;
  }
  /** C3:把某一层此刻的全部就绪区间发出去(全量语义,`ready-index.mjs`)。 */
  publishLayer(control, tier, ranges, entryKey) {
    const kind = kindOfTier(tier);
    const key = wireSnapshotKey(tier, entryKey, control?.snapshotKey);
    if (!kind || !key || !control?.clipId) return;
    this.readyIndex.setLayer({ clipId: control.clipId, kind, key, ranges });
  }
  /**
   * C4 的调度点:这一批该从哪个本地帧开始。
   *
   * 镜像插件里有页面报的 `wanted`(播放头附近缺的层)时,含它的那一批先跑;
   * 没有就回到顺序批。**不打断正在跑的那一批** —— 这个函数只在批与批之间被调。
   */
  nextBatchStart(pending, control) {
    const ordered = [...pending].sort((a, b) => a - b);
    for (const item of this.playheadWanted()) {
      if (item?.clipId !== control.clipId) continue;
      const local = Number(item.frame) - control.sampling.firstFrame;
      if (!Number.isInteger(local) || local < 0 || local >= control.count) continue;
      const start = local - (local % 4);
      if (!pending.has(start) || start === ordered[0]) continue;
      console.log(`[frames] wanted: 片段 ${control.clipId} 的第 ${start}~${Math.min(start + 3, control.count - 1)} 批提前(顺序批本来是 ${ordered[0]})`);
      // 预渲染进程的 stdout 被编辑器进程收走了(`vite-plugin-prerender` 的 `keep`),
      // 端到端探针看不见上面那行;所以同一件事也记一条,经 `/api/frames/diagnostics` 读。
      this.notePromotion({ clipId: control.clipId, start, instead: ordered[0], frame: Number(item.frame) });
      return start;
    }
    return ordered[0];
  }
  /**
   * C2 的本地档那一趟:**一趟整场景渲染服务该帧上全部本地档卡**(不是每卡一趟)。
   *
   * 为什么不能走隔离单卡:`isolatedCardProject` 剥掉了下层场景,毛玻璃没有背景
   * 可采;`unknown` 卡(定制卡、带部件的组合卡片段)同理拿不到自己要的上下文。
   *
   * 为什么不能复用 `renderMovFrames` 现成的回调:它的 `requested` 只含 MOV 缺的帧,
   * `onSnapshot` 还被 `!entry.html.has(n)` 挡着,`htmlFrames` 重放路根本不进 `bakeFrames`。
   *
   * 参数照 C2 钉死:`targetFrames: frames`、`fullFrame: true`(不带它 `bake.mjs:69`
   * 的帧窗规划不生效)、`snapshotOnly: false`(`bake.mjs:281` 的守卫;改成 `true`
   * 会关掉帧窗规划、也跳过 `shoot` 里的 `prepareFrameMedia`,而本地档正是毛玻璃 /
   * `unknown` 卡 —— 素材层没准备好,快照里就是错的画面)、`writeFrames: false`、
   * `snapshotFrames: new Set(frames)`。**每帧因此多截一张没人消费的 PNG,这是已知代价。**
   *
   * `frames` = 本地档索引里任一本地档卡缺的**全局**帧的并集。
   */
  async renderLocalSnapshots(entry, frames, bakery, signal) {
    const targets = this.snapshotTargets(entry);
    if (!targets?.size) return;
    const locals = new Map([...targets].filter(([, target]) => target.tier === 'local'));
    const list = [...new Set(frames ?? [])].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
    if (!locals.size || !list.length) return;
    const capabilities = new Map((entry.cardPlan ?? []).map(control => [control.clipId, control.capabilities]));
    /** clipId → 快照库的攒批写(#9:写帧 + 判体积 + 并 index 一步做,A3c / R6-14 的超限帧记进 `oversize`) */
    const batches = new Map();
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: list, snapshotOnly: false, fullFrame: true, writeFrames: false, signal,
      snapshotFrames: new Set(list),
      // `__pcCreateSnapshot` 的产物每项只有 id(= clipId)/ frame / html,**不含共享键** ——
      // 键用 card plan 的 `control.clipId` ↔ `control.snapshotKey` 反查。
      onSnapshot: async (_frame, _html, produced) => {
        if (signal?.aborted) return;
        for (const item of produced ?? []) {
          const target = locals.get(item.id);
          if (!target || !Number.isInteger(item.frame)) continue;
          if (!batches.has(item.id)) batches.set(item.id, this.snapshots().batch({ tier: 'local', entryKey: entry.key, key: target.key, clipId: item.id, capabilities: capabilities.get(item.id) }));
          try { await batches.get(item.id).add(item.frame, item.html); }
          catch { continue; }
        }
      },
    });
    // 中途取消:已经交掉的批都在 index 里(盘面和 index 一致),没交的几帧丢掉,下一趟补
    if (signal?.aborted) return;
    for (const [clipId, batch] of batches) {
      const index = await batch.close();
      if (index && batch.written) this.publishLayer({ clipId, snapshotKey: batch.key }, 'local', index.frames, entry.key);
    }
  }
  /**
   * 整场景路要渲哪些**全局**帧:某一档的卡在这一帧还缺快照,这一帧就得渲(并集 ——
   * 一趟整场景渲染服务该帧上全部同档卡)。顺带把已有的区间发成 `layer`(C3)。
   *
   *   `tiers`      只看这几档(本地档那一趟传 `['local']`,锚帧那一趟两档都要);
   *   `restrictTo` 只在这些全局帧里挑(锚帧那一趟传锚帧集合;不传 = 全部)。
   */
  async missingSnapshotFrames(entry, { tiers = ['local'], restrictTo = null } = {}) {
    const plan = entry.cardPlan;
    if (!plan?.length) return [];
    const fps = Number(entry.project.fps) || 30;
    const only = restrictTo ? new Set(restrictTo) : null;
    const wanted = new Set();
    for (const control of plan) {
      // pinned 渲染 9:不在预渲染集合里的卡不产快照,也就没有「缺帧」可言
      if (!this.prerenderPicked(entry, control.clipId)) continue;
      const tier = control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      if (!tiers.includes(tier)) continue;
      const entryKey = tier === 'local' ? entry.key : undefined;
      const index = await this.snapshots().snapshotIndex({ tier, entryKey, key: control.snapshotKey });
      if (index.count) this.publishLayer(control, tier, index.frames, entryKey);
      // R6-14:超限被丢掉的帧不算「缺」—— 它们已经渲过一次、也已经判过一次超限
      if (index.count + rangeCount(index.oversize) >= control.count) continue;
      for (let local = 0; local < control.count; local++) {
        if (rangeHas(index.frames, local) || rangeHas(index.oversize, local)) continue;
        const global = local + control.sampling.firstFrame;
        if (global / fps >= control.end - 1e-9) break;
        if (!only || only.has(global)) wanted.add(global);
      }
    }
    return [...wanted].sort((a, b) => a - b);
  }
  /**
   * C2 **先预渲染锚帧**:锚帧全部就绪前不开始其余后台预渲染。
   *
   * 锚帧集合 = 每个片段的 `mountFrameOf`、`clipFrameSpan` 的 `last + 1`、第 0 帧
   * (C1 末句;算式在 `src/render/snapshotPick.mjs`,两端同一份)。这一趟走整场景
   * 路,所以共享档和本地档的卡一起产 —— C4 的「同区间内回溯」靠的正是段起点那一帧
   * 早早就绪,冷缓存拖到第 1000 帧才有东西可贴。
   */
  async fillAnchorSnapshots(entry, bakery, signal) {
    const fps = Number(entry.project.fps) || 30;
    const count = Math.max(1, Math.floor(entry.project.duration * fps));
    const clips = (entry.project.tracks || []).flatMap(track => track.clips || []);
    const anchors = anchorFrames(clips, fps).filter(frame => frame >= 0 && frame < count);
    const frames = await this.missingSnapshotFrames(entry, { tiers: ['shared', 'local'], restrictTo: anchors });
    if (!frames.length) return this.readyIndex.markDone();
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: frames, snapshotOnly: false, fullFrame: true, writeFrames: false, signal,
      snapshotFrames: new Set(frames),
      onSnapshot: (n, html, controls) => this.record(entry, n, html, controls),
    });
    await this.flushSnapshots(entry);
    if (!signal?.aborted) this.readyIndex.markDone();
  }
  async fillCardControls(entry, bakery, signal, controls = null) {
    if (!controls) {
      const browserPlan = await this.browserCardPlan(bakery);
      if (!browserPlan) return;
      try { controls = entry.cardCache.plan(browserPlan); } catch { return; }
    }
    for (const control of controls.filter(control => control.cacheable)) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      // 走哪一档由审阅表的 capabilities 决定,不由 `cacheable` 决定:
      // 共享档 = independent / sourceDependent 且 stateful;其余 stateful
      // (含 belowDependent 和 unknown)本地档;非 stateful 不产快照。
      // 本地档在这里只可能出现在显式传进来的 controls 上 —— 常规路径上
      // belowDependent / unknown 的快照由 C2 的整场景路(`renderLocalSnapshots`)产。
      // 没有共享键就没法寻址(手工构造的 control、以及还没接上键的调用方),不写快照。
      // pinned 渲染 9:不在预渲染集合里的卡走 `target = null` —— 不写快照、不更新
      // index.json、不发 `layer`。PNG 那一支(legacy 整帧通道与 `renderState` 的料)
      // 照旧,不然 `?preview=legacy` 会缺料。
      const tier = control.snapshotKey && this.prerenderPicked(entry, control.clipId)
        ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      const entryKey = tier === 'local' ? entry.key : undefined;
      const target = tier === 'none' ? null : { tier, entryKey, key: control.snapshotKey };
      // C2:HTML 侧另有一条完整性判据 —— `index.json` 的 `count` 是**已有帧数**
      // (`snapshot-store.mjs` 的 `rangeCount`),完整 = `index.count === control.count`。
      // PNG 侧的 `hasComplete` 管不到它:同一趟里 PNG 可能齐了而快照缺一段。
      let index = target ? await this.snapshots().snapshotIndex(target) : { count: 0, frames: [], oversize: [] };
      if (target && index.count) this.publishLayer(control, tier, index.frames, entryKey);
      // R6-14:超限被丢掉的帧算「已经处理过」—— 不然 `htmlComplete` 永远为 false,
      // 每一趟都把整张卡重渲一遍、再判一遍超限、再丢一遍。
      const htmlComplete = !target || index.count + rangeCount(index.oversize) >= control.count;
      if (htmlComplete && await entry.cardCache.hasComplete(control)) continue;
      const isolated = this.isolatedCardProject(entry.project, control);
      // A small batch retains Chrome state inside a stateful card, while every
      // batch boundary remains cancellable/schedulable.  `fullFrame` is vital:
      // the cache image is a full transparent stage, never a crop to be framed
      // again during composition.
      //
      // C4:批次边界是可调度点 —— 每批开始前读镜像插件的 `latestPlayhead().wanted`,
      // 含它的那一批先跑,再回到顺序批(`nextBatchStart`)。
      const pending = new Set();
      for (let first = 0; first < control.count; first += 4) pending.add(first);
      while (pending.size) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        const first = this.nextBatchStart(pending, control);
        pending.delete(first);
        const localFrames = Array.from({ length: Math.min(4, control.count - first) }, (_, n) => first + n);
        // C2:帧集合收窄成**本卡缺的那些帧**(按该键 `index.json` 已有区间扣除)。
        // PNG 那一支照旧要全部帧(`targetFrames` 不动),只有生成快照这一支收窄。
        // R6-14:已经判过超限的那些帧也扣掉,不再白渲一遍
        const missing = target ? localFrames.filter(n => !rangeHas(index.frames, n) && !rangeHas(index.oversize, n)) : [];
        await bakery.reset(isolated, this.emptyUrl(isolated), { deferCards: true });
        await bakery.page.setViewport({ width: isolated.width, height: isolated.height, deviceScaleFactor: this.scaleForLane('background') });
        const produced = [];
        await bakeFrames(bakery, { out: path.join(this.root, 'controls', control.key), targetFrames: localFrames,
          snapshotOnly: false, fullFrame: true, writeFrames: false, signal,
          snapshotFrames: new Set(missing),
          onFrame: async (frame, png) => entry.cardCache.put(control.key, frame, png, () => !signal?.aborted),
          // 隔离工程里目标片段是唯一可见输出,所以这一帧的 control 列表里认
          // `control.clipId` 那一条就是这张卡的子树。`data-pc-local-frame` 是卡片
          // 自己的本地帧,和隔离工程的帧号一致(片段被平移到了 -phase),但仍以
          // 冻结结果里带的那个为准 —— 目录是按本地帧寻址的。
          onSnapshot: async (frame, html, items) => {
            if (!target || signal?.aborted) return;
            const own = (items || []).find(item => item.id === control.clipId);
            if (!own || !Number.isInteger(own.frame)) return;
            produced.push({ localFrame: own.frame, html: own.html });
          } });
        // 每批(4 帧)交一次(不是每帧):写帧文件、判体积、并 index.json 由快照库一步做(#9)。
        // A3c:超限的帧照常落盘,但不进就绪索引、不投递(诊断记在快照库里);R6-14:帧号记进
        // `oversize`,下一趟跳过。一个键几千帧时,读-改-写一个小 JSON 也比不上批量摊薄。
        if (produced.length && !signal?.aborted) {
          index = await this.snapshots().commitSnapshots({ ...target, clipId: control.clipId, capabilities: control.capabilities, items: produced });
          // C3:这一层的区间长了就发一条全量 `layer`
          if (index.written.length) this.publishLayer(control, tier, index.frames, entryKey);
        }
      }
      if (!signal?.aborted) await entry.cardCache.finish(control);
    }
    // `fillCardControls` shares the background Chrome with the mandatory
    // complete-scene pass. Restore its normal project before snapshot/MOV.
    await bakery.reset(entry.project, this.emptyUrl(entry.project), { deferCards: true });
    await bakery.page.setViewport({ width: entry.project.width, height: entry.project.height, deviceScaleFactor: this.scaleForLane('background') });
  }
  isolatedCardProject(project, control) {
    const targetId = control.clipId;
    const phase = Number(control.sampling.phase.numerator) / Number(control.sampling.phase.denominator);
    const duration = control.end - control.start;
    let found = false;
    const tracks = [];
    const sourceTrackIds = new Set((project.tracks || []).map(track => track.id));
    for (const track of project.tracks || []) {
      const target = (track.clips || []).find(clip => clip.id === targetId);
      if (target) {
        found = true;
        // The target is the only visible output.  Siblings can nevertheless be
        // raw graph inputs (especially multi-input 图卡), so retain
        // them in a separate hidden source track rather than dropping them.
        tracks.push({ ...structuredClone(track), hidden: false, sourceOnly: false,
          clips: [{ ...structuredClone(target), start: -phase, end: duration - phase }] });
        const siblings = (track.clips || []).filter(clip => clip.id !== targetId);
        if (siblings.length) {
          let id = `__pc_source_${track.id}`; let suffix = 1;
          while (sourceTrackIds.has(id)) id = `__pc_source_${track.id}_${suffix++}`;
          sourceTrackIds.add(id);
          tracks.push({ ...structuredClone(track), id, hidden: true, sourceOnly: true, clips: structuredClone(siblings) });
        }
        continue;
      }
      // Keep original clips available to 图卡 source resolution without
      // letting them paint.  The browser's source-only tracks are deliberately
      // explicit rather than attempting to infer graph dependencies here.
      tracks.push({ ...structuredClone(track), hidden: true, sourceOnly: true });
    }
    if (!found) throw new Error(`Independent card clip is missing: ${targetId}`);
    return { ...structuredClone(project), duration: Math.max(duration, control.count / (Number(project.fps) || 30)), tracks, _cardRender: { mode: 'final', frames: {}, missing: {} } };
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
  /**
   * D4(b) `/api/cards/layout`:Agent 的 `get_layout` —— **整场景**在 t 时刻的实体框,跑在预渲染进程
   * (pinned 架构 4:Agent 的 query 走预渲染,用户交互的 query 走自己的离屏舞台)。
   *
   * 一次请求只渲**一遍**,和问了几个 clipId 无关:`entry.html` 有这一帧就直接拿它,没有就
   * `bakeFrames` 出这一帧并 `record`(下次就命中)。**MOV/PNG 命中不能短路** —— 实体框要 DOM,
   * 像素答不了;所以只看 `entry.html`,不看 `entry.mov`。
   *
   * 量法:把冻结 HTML 注进 `#pc-frame-snapshot`(和 `rasterPrefix` 同一条 `captureSnapshot` 路),
   * 在 `document.fonts.ready` 之后、`prepareFrameMedia` 之前对 `#pc-frame-snapshot [data-pc-scene]`
   * 调 `window.__pcSolid.rectsWithBounds({ pixels: 'none' })` —— 快照里 canvas 已经换成
   * 带 `data-pc-painted-box` 的 `<img>`,所以不用(也不能)读像素。`screenshot: false` 让这一趟
   * 不白付一张 1080p PNG。
   *
   * agent 车道串行:经 `runAgentTask` 和 `see_frames` 的 agent 批、`entityRects`、DOM 查询排同一条队(#12)。
   */
  async layout(project, options = {}) {
    return this.runAgentTask(lease => this.layoutNow(project, options, lease));
  }
  /** `lease` 缺省时自己 `acquire` / `release`;经 `layout` 进来时由 `runAgentTask` 借还 */
  async layoutNow(project, { t = 0, clipIds = null, signal } = {}, lease = null) {
    const lane = 'agent';
    const entry = await this.entry(project);
    const fps = Number(entry.project.fps) > 0 ? entry.project.fps : 30;
    const max = Math.max(0, Math.floor((Number(entry.project.duration) || 0) * fps) - 1);
    const frame = Math.max(0, Math.min(max, Math.round((Number(t) || 0) * fps)));
    const at = frame / fps;
    const { cardIds } = layoutClips(entry.project, clipIds, null, at);
    let baked = false;
    let measured = [];
    // 只问素材段(或问的片段一个都不存在)时不用开浏览器:它们的框全由项目数据决定
    if (!cardIds.length) {
      const { stage, clips } = layoutClips(entry.project, clipIds, [], at);
      return { stage, t: at, frame, clips, baked };
    }
    const bakery = await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      if (!entry.html?.has?.(frame)) {
        baked = true;
        await bakeFrames(bakery, {
          out: entry.dir, targetFrames: [frame], snapshotOnly: true, writeFrames: false,
          snapshotFrames: new Set([frame]), signal,
          onSnapshot: (n, html, controls) => { if (n === frame) this.record(entry, n, html, controls); },
        });
        await this.save(entry);
      }
      const html = entry.html?.get?.(frame);
      if (typeof html !== 'string' || !html) throw new Error(`第 ${frame} 帧没有冻结快照，量不到实体框`);
      measured = await captureSnapshot(bakery, html, undefined, {
        screenshot: false,
        afterFonts: page => page.evaluate(ids => {
          const root = document.querySelector('#pc-frame-snapshot [data-pc-scene]');
          if (!root || typeof window.__pcSolid?.rectsWithBounds !== 'function') return [];
          return window.__pcSolid.rectsWithBounds(root, { pixels: 'none', ...(ids ? { clipIds: ids } : null) });
        }, cardIds.length ? cardIds : null),
      }) || [];
    } finally { if (!lease) this.release(lane); }
    const { stage, clips } = layoutClips(entry.project, clipIds, measured, at);
    return { stage, t: at, frame, clips, baked };
  }
  /**
   * D3:`see_frames` 渲出来的那几帧各附一份实体矩形(`measureEntityRects`)。回 `Map<帧号, 矩形数组 | null>`。
   *
   * 和 `layoutNow` 同一个道理:像素命中(MOV / PNG)答不了实体框,只看 `entry.html`。`see_frames`
   * 刚渲过的帧多半已经 `record` 进去了(MOV 那一趟边推边记快照),直接注回去量;没有的一次
   * `bakeFrames` 补齐(只生成快照、不产 PNG)。每帧只注一次快照、`screenshot: false`,不装素材。
   * 经 `runAgentTask` 走 agent 车道的同一条队(#12)。
   */
  async entityRects(project, times, options = {}) {
    return this.runAgentTask(lease => this.entityRectsNow(project, times, options, lease));
  }
  async entityRectsNow(project, times, { signal } = {}, lease = null) {
    const lane = 'agent';
    const entry = await this.entry(project);
    const fps = Number(entry.project.fps) > 0 ? entry.project.fps : 30;
    const max = Math.max(0, Math.floor((Number(entry.project.duration) || 0) * fps) - 1);
    const frames = [...new Set(times.map(t => Math.max(0, Math.min(max, Math.round((Number(t) || 0) * fps)))))].sort((a, b) => a - b);
    const out = new Map();
    if (!frames.length) return out;
    const bakery = await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      const missing = frames.filter(frame => !entry.html?.has?.(frame));
      if (missing.length) {
        const wanted = new Set(missing);
        await bakeFrames(bakery, {
          out: entry.dir, targetFrames: missing, snapshotOnly: true, writeFrames: false,
          snapshotFrames: wanted, signal,
          onSnapshot: (n, html, controls) => { if (wanted.has(n) && !entry.html.has(n)) this.record(entry, n, html, controls); },
        });
        await this.save(entry);
      }
      for (const frame of frames) {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const html = entry.html?.get?.(frame);
        out.set(frame, typeof html === 'string' && html
          ? (await captureSnapshot(bakery, html, undefined, { screenshot: false, afterFonts: measureEntityRects })) ?? null
          : null);
      }
    } finally { if (!lease) this.release(lane); }
    return out;
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
      const requiredActive = [...this.generations.values()].some(generation => this.entries.get(generation.key)?.stage === 'required');
      for (const [id, generation] of this.generations) {
        const entry = this.entries.get(generation.key);
        if (entry && entry.status !== 'ready') this.pausedPreloads.set(id, entry.project);
        // Required work is allowed to finish while playback starts. Direct
        // control/HTML/MOV work observes this abort at its four-frame boundary.
        if (entry?.stage !== 'required') generation.controller.abort();
      }
      const session = this.lanes.get('background');
      if (session && !requiredActive) { clearTimeout(session.timer); this.lanes.delete('background'); await session.bakery.close().catch(() => {}); }
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
        // Warm frames are verified like see_frames lookups; an empty legacy
        // raster is not trusted and goes back to the render queue instead.
        cached: async frame => await entry.mov.lookup(frame, this.renderSignature(entry, frame, 'playback'))
          || await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png')).then(buf => isFullyTransparentPng(buf) ? null : buf, () => null),
        stop: () => this.stopPlayback(), workers: 2 });
      this.playback.owner = input.owner;
    }
    const playback = this.playback;
    if (!playback.update(input)) return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
    if (input.playing) {
      playback.preparing = true;
      playback.release = release;
      // Playback must answer this heartbeat immediately. Yielding a low lane,
      // borrowing a remote slot and adopting its snapshots are background
      // housekeeping, never a prerequisite for the hot two local renderers.
      playback.setWorkers(2); this.userPoolSize = 2; playback.preparing = false;
      void this.yieldBackground(input.owner).catch(() => {});
      void (async () => {
        const wasBorrowed = playback.borrowed;
        const borrowed = await borrow(input.owner);
        if (this.playback !== playback || !playback.playing) { if (borrowed) await release(input.owner); return; }
        playback.borrowed = borrowed;
        playback.setWorkers(borrowed ? 3 : 2); this.userPoolSize = playback.workers;
        if (borrowed && !wasBorrowed) await this.refreshSnapshots(entry);
      })().catch(() => {});
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
      const archive = await this.loadArchive(entry);
      for (const frame of entry.html.keys()) if (!archive.frames.has(frame)) archive.frames.set(frame, entry.html.get(frame));
      for (const [id, frames] of entry.controls) {
        if (!archive.controls.has(id)) archive.controls.set(id, archive.createControl(id));
        for (const frame of frames.keys()) if (!archive.controls.get(id).has(frame)) archive.controls.get(id).set(frame, frames.get(frame));
      }
      const dispose = entry.disposeArchive;
      entry.html = archive.frames; entry.controls = archive.controls; entry.disposeArchive = archive.dispose;
      entry.createControl = archive.createControl;
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
    await this._streams?.close();
    await Promise.allSettled(this.streamSessions.splice(0).map(session => { clearTimeout(session.idleTimer); return session.bakery?.close(); }));
    await Promise.allSettled([...this.lanes.values()].map(session => { clearTimeout(session.timer); return session.bakery.close(); }));
    this.lanes.clear();
    await Promise.allSettled(this.userPool.map(session => session.bakery.close()));
    this.userPool.length = 0;
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [entry.mov?.close(), entry.playbackMovie?.close(), entry.cardCache?.close()]));
    for (const entry of this.entries.values()) entry.disposeArchive?.();
  }
}
