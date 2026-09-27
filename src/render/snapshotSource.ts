import type { PickedSnapshot, ReadyKind, ReadyLayer, ReadyRange } from "./snapshotPick.mjs";

/**
 * J3 舞台侧的快照来源接口。
 *
 * 页面里消费快照的**两处** —— C3 就绪索引的 SSE 订阅、C4 取快照字节的
 * `GET ${prerenderBase()}/api/frames/snapshot/<kind>/<key>/<localFrame>` —— 收口到
 * 这一个文件。`StageView` / `Preview` 不直接 `fetch` 快照、不直接 `new EventSource`:
 * 在线浏览器模式(L2)换成 `IdbSnapshotSource` 时,消费方一行都不用改。
 *
 * 本地模式的实现是 `HttpSnapshotSource`:**直连预渲染进程**(和 SSE 同源,同走
 * `PROMPTCUT_CORS_ORIGINS`;编辑器进程不代理)。断线按 1s / 2s / 4s / 8s(封顶 8s)
 * 退避重连**同一条 SSE**,重连成功时服务端照 F5 的做法先发 `reset` 再发全量 `layer` ——
 * 和 F5 共用一条恢复路径,没有轮询端点。
 *
 * **这一层只负责「拿得到」**:33 ms 的换 DOM 节流、`setSnapshots` 的投递基线、
 * 一次投递 ≤ 2 MB 的拆分都是父页消费方的事(R5)。所以接口做成了两个无状态的动词
 * 加一个订阅,消费方想怎么排程就怎么排程。
 */

export type { ReadyKind, ReadyLayer, ReadyRange, PickedSnapshot };

/** C3 的三种消息,形状定死 */
export type ReadyMessage =
  | { type: "reset"; localRev: number }
  | { type: "layer"; clipId: string; kind: ReadyKind; key: string; ranges: ReadyRange[]; groupClipIds?: string[] }
  | { type: "done"; localRev: number };

export interface SnapshotSource {
  /** 订阅就绪索引。返回退订函数;重连、`reset` 都在实现里处理掉 */
  subscribeReady(session: string, localRev: number, onMessage: (m: ReadyMessage) => void): () => void;
  /** 取一帧快照的 HTML。缺帧抛(那一层按缺料处理,C4 会选更早的一帧) */
  fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string>;
}

/** A3c / J3:页面内存缓存 64 条,LRU */
export const SNAPSHOT_CACHE_MAX = 64;
/** J3:断线重连的退避,封顶 8 秒 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * 拼快照地址。`kind` 为 `local` 时 `key` 是 `<entry.key>/<共享键>`、**自带一个斜杠**
 * (C3),所以按段 `encodeURIComponent`,不能对整个 `key` 编码 —— 整编会把那个斜杠
 * 变成 `%2F`,服务端的路由正则就配不上了。
 */
export function snapshotPath(kind: ReadyKind, key: string, localFrame: number): string {
  const segments = String(key).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/frames/snapshot/${encodeURIComponent(kind)}/${segments}/${localFrame}`;
}

/** 就绪索引的页面侧形状(C3):同一张重卡的 `stream` 表和 `html` 表并存、互不覆盖 */
export type ReadyIndex = Map<string, Map<ReadyKind, { key: string; ranges: ReadyRange[]; groupClipIds?: string[] }>>;

/**
 * 把一条消息应用到页面的 `readyIndex`。`reset` 清表,`layer` 整层替换
 * (C3 是全量语义 —— 不能合并,否则卡的参数变了之后旧区间会赖着不走)。
 */
export function applyReadyMessage(index: ReadyIndex, message: ReadyMessage): ReadyIndex {
  if (message.type === "reset") { index.clear(); return index; }
  if (message.type !== "layer") return index;
  let byKind = index.get(message.clipId);
  if (!byKind) { byKind = new Map(); index.set(message.clipId, byKind); }
  // 组流(R8 / G1)的层带 `groupClipIds`:父页按它合成一条 `{ clipIds: groupClipIds }` 的流平面
  byKind.set(message.kind, { key: message.key, ranges: message.ranges, ...(message.groupClipIds?.length ? { groupClipIds: [...message.groupClipIds] } : {}) });
  return index;
}

/** 就绪索引里取一层;没有就 null(那一层这一拍透明) */
export function layerOf(index: ReadyIndex, clipId: string, kind: ReadyKind): ReadyLayer | null {
  const hit = index.get(clipId)?.get(kind);
  return hit ? { clipId, kind, key: hit.key, ranges: hit.ranges } : null;
}

/**
 * 内存 LRU:`Map` 的插入序就是使用序,命中就删了再放回去。
 *
 * (这个文件里不用 TS 的「构造函数参数属性」`constructor(private x)` —— 那是
 * 非类型语法,Node 的类型擦除跑不了,单测就 import 不进来。)
 */
class SnapshotCache {
  private map = new Map<string, string>();
  private max: number;
  constructor(max = SNAPSHOT_CACHE_MAX) { this.max = max; }
  get(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  set(id: string, html: string) {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, html);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

/**
 * 预渲染进程的源。**按需 import** `./prerender.ts`:那个模块带 React hook
 * (`usePrerenderBase`),静态 import 会把 React 拖进这条本该只有 fetch 的路
 * (以及 Node 侧的单测)。调用方自己传 `base` 时这一行永远不跑。
 */
const defaultBase = async (): Promise<string> => (await import("./prerender.ts")).prerenderBase();

/** 本地模式:直连预渲染进程 */
export class HttpSnapshotSource implements SnapshotSource {
  private cache = new SnapshotCache();
  /** 同一帧同时被两处要到时只飞一次 */
  private inflight = new Map<string, Promise<string>>();
  private base: () => Promise<string>;

  constructor(base: () => Promise<string> = defaultBase) { this.base = base; }

  subscribeReady(session: string, localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (stopped) return;
      /*
       * D5「同源退回删除」:拿不到预渲染的源就**不连**,退避之后重新问。
       * 以前这里退回空串(同源),EventSource 于是连到编辑器自己的源上 ——
       * 那里没有这个端点,连上就错、错了又重连,白占一条连接还把真实故障藏起来。
       */
      let base: string;
      try { base = await this.base(); } catch { return retry(); }
      if (stopped) return;
      const url = `${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=${encodeURIComponent(String(localRev))}`;
      try {
        source = new EventSource(url);
      } catch {
        return retry();
      }
      source.onopen = () => { attempt = 0; };
      source.onmessage = (event: MessageEvent) => {
        if (stopped) return;
        try { onMessage(JSON.parse(String(event.data)) as ReadyMessage); }
        catch { /* 半条消息:下一条全量 layer 会把这一层补回来 */ }
      };
      source.onerror = () => {
        // EventSource 自己也会重连,但它不会重新问 `prerenderBase()` —— 预渲染崩了
        // 会换一个新端口,所以这里自己关掉、退避、重新问地址再连。
        try { source?.close(); } catch { /* 已经关了 */ }
        source = null;
        retry();
      };
    };

    const retry = () => {
      if (stopped || timer !== null) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt++;
      timer = setTimeout(() => { timer = null; void connect(); }, delay);
    };

    void connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try { source?.close(); } catch { /* 已经关了 */ }
      source = null;
    };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    const id = `${kind}/${key}/${localFrame}`;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const flying = this.inflight.get(id);
    if (flying) return flying;
    const work = (async () => {
      const base = await this.base();
      const res = await fetch(base + snapshotPath(kind, key, localFrame), { signal, cache: "force-cache" });
      if (!res.ok) throw Object.assign(new Error(`快照还没就绪:${id}`), { status: res.status });
      const html = await res.text();
      this.cache.set(id, html);
      return html;
    })().finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, work);
    return work;
  }

  /** 项目换版之后把缓存丢掉(键是内容寻址的,所以平时不需要) */
  clearCache() { this.cache.clear(); }
  get cacheSize() { return this.cache.size; }
}

/* ======================================================================== *
 * 在线浏览器模式:从素材服务读预渲染小尺寸(`docs/plan/c10a-contract.md` 第 9 节「在线页面拉取」)
 * ======================================================================== */

/**
 * 在线页面没有预渲染进程,也就没有 SSE 就绪索引、没有 `/api/frames/snapshot`。它这样拿重层的画面:
 *
 * 1. **层表**:渲染节点认下一版 card plan 时写进内容库的一条(`snapshot-manifest` 类,键 `layers:<项目 id>`,
 *    `server/artifact-transfer.mjs` 的 `layerMapOf`):每张重卡的线上键、清单的结果键、采样窗口。页面按项目 id 取它,
 *    每 `LAYER_MAP_POLL_MS` 再取一次(改了一处之后,渲染节点重渲、换键,页面跟着换)。
 * 2. **清单**:只取「当前播放头前后各 `PREFETCH_SEC` 秒」落在哪几段的清单(`<resultKey>:<from>-<to>`,段长是层表的 `span`),
 *    每段一份;清单里的 `small` 表就是这一段有哪些帧的小位图、各自的哈希。还没满的清单每 `MANIFEST_POLL_MS` 再取。
 * 3. **就绪**:每层的就绪区间 = 已取到的清单里有小位图的帧,照 C3 的 `layer` 消息(全量语义)交给订阅方 ——
 *    和本地模式同一条消费路(`snapshotFeed` 的选帧、兜底、投递一行不改)。原尺寸不算:小尺寸就绪不是原尺寸就绪,
 *    在线页面也从不拉原尺寸。
 * 4. **取字节**:`GET <素材服务>/px/<hash>`(只读票据,`Authorization` 头),包成一张铺满快照平面的 `<img>`
 *    (data URL,不用 blob URL:舞台是另一个文档,父页撤销 blob 时舞台上的图会断)。
 * 5. **缓存**:只在内存里按 LRU 存小尺寸,上限 `ONLINE_CACHE_MAX_BYTES`(64 MiB,契约第 8 节〔裁〕,不做 IndexedDB)。
 *    预取:播放头前后各 2 秒、当前可见的重层。导出前 `clearCache()` 释放(契约第 11.1 节)。
 *
 * 文档服务与素材服务都经注入的依赖访问(页面里由 `Preview` 接到 `assetTiers.ts` 的 `docRequest` / `assetAuthHeaders`),
 * 这里不认识 `/api`,单测注入假的。
 */

/** 在线页面的小尺寸缓存上限(契约第 8 节〔裁〕) */
export const ONLINE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 预取范围:播放头前后各这么多秒(契约第 9 节) */
export const PREFETCH_SEC = 2;
/** 层表多久再取一次 */
export const LAYER_MAP_POLL_MS = 3000;
/** 还没满的清单多久再取一次 */
export const MANIFEST_POLL_MS = 2000;
/** 同时在飞的小位图请求 */
export const ONLINE_FETCH_CONCURRENCY = 4;
/** 层表在内容库里的键前缀(与 `server/artifact-transfer.mjs` 的 `LAYER_MAP_PREFIX` 同值) */
export const LAYER_MAP_PREFIX = "layers:";

export interface OnlineLayer {
  clipId: string;
  kind: ReadyKind;
  key: string;
  resultKey: string;
  firstFrame: number;
  count: number;
}

export interface LayerMap {
  projectId: string | null;
  fps: number;
  span: number;
  layers: OnlineLayer[];
}

export interface OnlineSnapshotDeps {
  /** 文档服务上的一次请求(`content.get`);没连上就抛 */
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** 远程素材服务的 API 基址(形如 `https://host/media/api/asset`);还没有给 null */
  assetBase(): string | null;
  /** 带只读素材票据的请求头 */
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** 单次内容库请求的兜底超时；连接实现也应自行超时 */
  requestTimeoutMs?: number;
  /** 取单张小位图的兜底超时 */
  assetTimeoutMs?: number;
}

/** 内容库回包里的层表;形状不对回 null */
export function parseLayerMap(body: unknown): LayerMap | null {
  const b = body as { kind?: unknown; projectId?: unknown; fps?: unknown; span?: unknown; layers?: unknown } | null;
  if (!b || b.kind !== "layer-map" || !Array.isArray(b.layers)) return null;
  const span = Math.max(1, Math.floor(Number(b.span) || 60));
  const layers: OnlineLayer[] = [];
  for (const raw of b.layers as Record<string, unknown>[]) {
    const kind = raw?.kind;
    if (kind !== "html" && kind !== "local") continue;
    const firstFrame = Number(raw.firstFrame), count = Number(raw.count);
    if (typeof raw.clipId !== "string" || typeof raw.key !== "string" || typeof raw.resultKey !== "string") continue;
    if (!Number.isInteger(firstFrame) || firstFrame < 0 || !Number.isInteger(count) || count < 1) continue;
    layers.push({ clipId: raw.clipId, kind, key: raw.key, resultKey: raw.resultKey, firstFrame, count });
  }
  return { projectId: typeof b.projectId === "string" ? b.projectId : null, fps: Number(b.fps) || 30, span, layers };
}

/** 一层落在 `[fromGlobal, toGlobal]`(全局帧,闭区间)的那几段:本地帧 0 起每 `span` 帧一段、最后一段到 `count - 1` */
export function segmentsInWindow(layer: Pick<OnlineLayer, "firstFrame" | "count">, span: number, fromGlobal: number, toGlobal: number): Array<[number, number]> {
  const lo = Math.max(0, fromGlobal - layer.firstFrame);
  const hi = Math.min(layer.count - 1, toGlobal - layer.firstFrame);
  if (hi < lo) return [];
  const out: Array<[number, number]> = [];
  for (let from = lo - (lo % span); from <= hi; from += span) out.push([from, Math.min(layer.count - 1, from + span - 1)]);
  return out;
}

/** 帧号表 → 合并好的闭区间 */
export function framesToRanges(frames: Iterable<number>): ReadyRange[] {
  const sorted = [...new Set(frames)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out as unknown as ReadyRange[];
}

/** 小位图包成一张铺满快照平面的图(快照平面是包裹层里 inset:0 的一层,小位图画的正是包裹层的框) */
export function smallSnapshotHtml(dataUrl: string): string {
  return `<img data-pc-small-snapshot="" alt="" src="${dataUrl}" style="position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none">`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** 按字节计的 LRU(data URL 的长度就是它在内存里的大小的量级) */
export class ByteLru {
  private map = new Map<string, string>();
  private bytes = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  get(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  set(id: string, value: string): void {
    const old = this.map.get(id);
    if (old !== undefined) { this.bytes -= old.length; this.map.delete(id); }
    this.map.set(id, value);
    this.bytes += value.length;
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.length;
      this.map.delete(first);
    }
  }
  has(id: string): boolean { return this.map.has(id); }
  get size(): number { return this.map.size; }
  get total(): number { return this.bytes; }
  clear(): void { this.map.clear(); this.bytes = 0; }
}

interface ManifestState {
  /** 本地帧 → 小位图哈希 */
  small: Map<number, string>;
  /** 这一段每一帧都有小位图了:不必再取 */
  full: boolean;
  fetchedAt: number;
}

/** 在线实现(见上) */
export class OnlineSnapshotSource implements SnapshotSource {
  private deps: OnlineSnapshotDeps;
  private cache: ByteLru;
  private inflight = new Map<string, Promise<string>>();
  private projectId: string | null = null;
  private map: LayerMap | null = null;
  private mapSig = "";
  private manifests = new Map<string, ManifestState>();
  private manifestFlying = new Set<string>();
  private emitted = new Map<string, string>();
  private listeners = new Set<(m: ReadyMessage) => void>();
  private timer: unknown = null;
  private playhead = { t: 0, fps: 30 };
  private lastMapAt = -Infinity;
  private stopped = false;
  private running: Promise<void> | null = null;
  private again = false;
  private queue: Array<() => Promise<void>> = [];
  private active = 0;
  /** 取到一张新的小位图之后叫(宿主据此重投一次) */
  onFetched: (() => void) | null = null;
  readonly stats = { mapFetches: 0, manifestFetches: 0, smallFetches: 0, smallBytes: 0, errors: 0 };

  constructor(deps: OnlineSnapshotDeps, { maxBytes = ONLINE_CACHE_MAX_BYTES }: { maxBytes?: number } = {}) {
    this.deps = deps;
    this.cache = new ByteLru(maxBytes);
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** 看哪个项目(层表的键);换了项目就清表重来 */
  setProject(projectId: string | null): void {
    const next = projectId || null;
    if (next === this.projectId) return;
    this.projectId = next;
    this.map = null;
    this.mapSig = "";
    this.manifests.clear();
    this.emitted.clear();
    this.lastMapAt = -Infinity;
    this.emit({ type: "reset", localRev: 0 });
    this.kick();
  }

  /** 播放头挪了:取这一窗口的清单,预取这一窗口可见重层的小位图 */
  focus(t: number, fps: number): void {
    this.playhead = { t: Number(t) || 0, fps: Math.max(1, Number(fps) || 30) };
    this.kick();
  }

  subscribeReady(_session: string, _localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    this.listeners.add(onMessage);
    // 新订阅方:先 reset,再把手里已有的层全量发一遍(C3 的恢复路)
    try { onMessage({ type: "reset", localRev: 0 }); } catch { /* 订阅方坏了 */ }
    for (const layer of this.map?.layers ?? []) {
      try { onMessage(this.layerMessage(layer)); } catch { /* 同上 */ }
    }
    this.kick();
    return () => { this.listeners.delete(onMessage); };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    const hash = this.smallHashOf(kind, key, localFrame);
    if (!hash) throw Object.assign(new Error(`没有这一帧的预渲染小尺寸:${kind}/${key}/${localFrame}`), { status: 404 });
    const hit = this.cache.get(hash);
    if (hit !== undefined) return smallSnapshotHtml(hit);
    return smallSnapshotHtml(await this.fetchSmall(hash, signal));
  }

  /** 导出前释放小尺寸缓存(契约第 11.1 节) */
  clearCache(): void { this.cache.clear(); }
  get cacheBytes(): number { return this.cache.total; }
  get cacheSize(): number { return this.cache.size; }
  /** 探针用:此刻的层表与各层就绪帧数 */
  debug() {
    return {
      projectId: this.projectId,
      layers: (this.map?.layers ?? []).map((l) => ({ clipId: l.clipId, kind: l.kind, key: l.key, ready: this.readyFrames(l).length })),
      manifests: this.manifests.size,
      cacheBytes: this.cache.total, cacheSize: this.cache.size, ...this.stats,
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.queue.length = 0;
  }

  /** 单测用:手动跑一轮(取层表、取窗口里的清单、预取) */
  async tickNow(): Promise<void> { await this.tick(); }

  /* ---------------- 内部 ---------------- */

  private emit(m: ReadyMessage) {
    for (const l of [...this.listeners]) { try { l(m); } catch { /* 订阅方坏了不影响别人 */ } }
  }

  private manifestKey(layer: OnlineLayer, seg: [number, number]) { return `${layer.resultKey}:${seg[0]}-${seg[1]}`; }

  private segOf(layer: OnlineLayer, localFrame: number): [number, number] {
    const span = this.map?.span ?? 60;
    const from = localFrame - (localFrame % span);
    return [from, Math.min(layer.count - 1, from + span - 1)];
  }

  private readyFrames(layer: OnlineLayer): number[] {
    const out: number[] = [];
    const span = this.map?.span ?? 60;
    for (let from = 0; from < layer.count; from += span) {
      const st = this.manifests.get(this.manifestKey(layer, this.segOf(layer, from)));
      if (st) for (const f of st.small.keys()) out.push(f);
    }
    return out;
  }

  private layerMessage(layer: OnlineLayer): ReadyMessage {
    return { type: "layer", clipId: layer.clipId, kind: layer.kind, key: layer.key, ranges: framesToRanges(this.readyFrames(layer)) };
  }

  /** 各层的就绪区间变了才发(全量语义) */
  private publishLayers() {
    for (const layer of this.map?.layers ?? []) {
      const msg = this.layerMessage(layer);
      if (msg.type !== "layer") continue;
      const id = `${layer.kind}:${layer.clipId}`;
      const sig = `${msg.key}|${JSON.stringify(msg.ranges)}`;
      if (this.emitted.get(id) === sig) continue;
      this.emitted.set(id, sig);
      this.emit(msg);
    }
  }

  private smallHashOf(kind: ReadyKind, key: string, localFrame: number): string | null {
    for (const layer of this.map?.layers ?? []) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.small.get(localFrame);
      if (hash) return hash;
    }
    return null;
  }

  private kick() {
    if (this.stopped) return;
    void this.tick();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d));
    if (this.timer !== null) clear(this.timer);
    this.timer = set(() => { this.timer = null; void this.tick(); }, ms);
  }

  /** 跑一轮;正在跑就记一笔、跑完再跑一轮(播放头、项目在这一轮里又变了) */
  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try { await this.tickOnce(); } catch { this.stats.errors++; }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
      this.schedule(MANIFEST_POLL_MS);
    });
    return this.running;
  }

  private async tickOnce(): Promise<void> {
    const now = this.now();
    if (this.projectId && now - this.lastMapAt >= LAYER_MAP_POLL_MS) {
      this.lastMapAt = now;
      await this.loadMap();
    }
    await this.loadWindow(now);
    this.prefetchWindow();
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = this.deps.requestTimeoutMs ?? 12_000;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.deps.request(msg, ms),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("内容库请求超时")), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  private async loadMap(): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    let reply: Record<string, unknown>;
    try {
      reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key: LAYER_MAP_PREFIX + projectId });
    } catch { this.stats.errors++; this.lastMapAt = -Infinity; return; }
    if (this.projectId !== projectId || this.stopped) return;
    this.stats.mapFetches++;
    if (reply?.type !== "content.item" || reply.missing) return;
    const map = parseLayerMap(reply.body);
    if (!map) return;
    const sig = JSON.stringify(map.layers) + `|${map.span}`;
    if (sig === this.mapSig) return;
    const prev = this.map;
    this.map = map;
    this.mapSig = sig;
    if (prev) {
      const alive = new Set(map.layers.map((l) => `${l.kind}:${l.clipId}`));
      for (const old of prev.layers) {
        const id = `${old.kind}:${old.clipId}`;
        if (alive.has(id)) continue;
        // 这张卡不在层表里了(改判轻、删了):发一条空层,把页面表里的旧区间撤掉
        this.emitted.delete(id);
        this.emit({ type: "layer", clipId: old.clipId, kind: old.kind, key: old.key, ranges: [] });
      }
    }
    // 换了键的层(重渲之后):就绪区间按新键重算、全量发;新键的清单还没到时区间是空的,页面按兜底顺序显示占位
    this.publishLayers();
  }

  /** 播放头这一窗口(前后各 `PREFETCH_SEC` 秒)的全局帧区间 */
  private windowFrames(): [number, number] {
    const fps = this.map?.fps || this.playhead.fps;
    const g = Math.max(0, Math.floor(this.playhead.t * fps + 1e-6));
    const pad = Math.ceil(PREFETCH_SEC * fps);
    return [Math.max(0, g - pad), g + pad];
  }

  private async loadWindow(now: number): Promise<void> {
    const map = this.map;
    if (!map) return;
    const [lo, hi] = this.windowFrames();
    const wanted: { seg: [number, number]; key: string }[] = [];
    for (const layer of map.layers) {
      for (const seg of segmentsInWindow(layer, map.span, lo, hi)) {
        const key = this.manifestKey(layer, seg);
        const st = this.manifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < MANIFEST_POLL_MS) continue;
        if (this.manifestFlying.has(key) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ seg, key });
      }
    }
    if (!wanted.length) return;
    let changed = false;
    await Promise.all(wanted.map(async ({ seg, key }) => {
      this.manifestFlying.add(key);
      try {
        const reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key });
        this.stats.manifestFetches++;
        const prev = this.manifests.get(key);
        if (reply?.type !== "content.item" || reply.missing) {
          this.manifests.set(key, { small: prev?.small ?? new Map(), full: false, fetchedAt: this.now() });
          return;
        }
        const body = reply.body as { small?: unknown } | undefined;
        const small = new Map<number, string>();
        for (const item of Array.isArray(body?.small) ? (body!.small as unknown[]) : []) {
          if (!Array.isArray(item) || !Number.isInteger(item[0]) || !/^[0-9a-f]{64}$/.test(String(item[1]))) continue;
          const f = item[0] as number;
          if (f < seg[0] || f > seg[1]) continue;
          small.set(f, String(item[1]));
        }
        const full = small.size === seg[1] - seg[0] + 1;
        if (!prev || prev.small.size !== small.size || [...small].some(([f, h]) => prev.small.get(f) !== h)) changed = true;
        this.manifests.set(key, { small, full, fetchedAt: this.now() });
      } catch {
        this.stats.errors++;
      } finally {
        this.manifestFlying.delete(key);
      }
    }));
    if (changed && this.map === map && !this.stopped) this.publishLayers();
  }

  /** 预取:这一窗口里当前可见的重层、有小位图的帧,离播放头近的先取 */
  private prefetchWindow() {
    const map = this.map;
    if (!map || !this.deps.assetBase()) return;
    const [lo, hi] = this.windowFrames();
    const g = Math.max(0, Math.floor(this.playhead.t * (map.fps || this.playhead.fps) + 1e-6));
    const wanted: { hash: string; dist: number }[] = [];
    for (const layer of map.layers) {
      const first = Math.max(lo, layer.firstFrame), last = Math.min(hi, layer.firstFrame + layer.count - 1);
      for (let gf = first; gf <= last; gf++) {
        const hash = this.smallHashOf(layer.kind, layer.key, gf - layer.firstFrame);
        if (hash && !this.cache.has(hash) && !this.inflight.has(hash)) wanted.push({ hash, dist: Math.abs(gf - g) });
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    for (const { hash } of wanted) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      void this.fetchSmall(hash).catch(() => { /* 下一轮再取 */ });
    }
  }

  private fetchSmall(hash: string, signal?: AbortSignal): Promise<string> {
    const flying = this.inflight.get(hash);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          const ms = this.deps.assetTimeoutMs ?? 15_000;
          let deadline: ReturnType<typeof setTimeout> | null = null;
          let bytes: Uint8Array;
          let type: string;
          try {
            ({ bytes, type } = await Promise.race([
              (async () => {
                const base = this.deps.assetBase();
                if (!base) throw new Error("还没有远程素材服务");
                const headers = await this.deps.authHeaders();
                const f = this.deps.fetch ?? fetch;
                const res = await f(`${base.replace(/\/+$/, "")}/px/${hash}`, { headers, signal: controller.signal, cache: "force-cache" });
                if (!res.ok) throw Object.assign(new Error(`取不到小位图 ${hash}:${res.status}`), { status: res.status });
                const bytes = new Uint8Array(await res.arrayBuffer());
                const type = (res.headers.get("content-type") || "image/webp").split(";")[0].trim() || "image/webp";
                return { bytes, type };
              })(),
              new Promise<never>((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error("小位图请求超时")); }, ms); }),
            ]));
          } finally {
            if (deadline !== null) clearTimeout(deadline);
            signal?.removeEventListener("abort", abort);
          }
          const url = `data:${type};base64,${bytesToBase64(bytes)}`;
          this.cache.set(hash, url);
          this.stats.smallFetches++;
          this.stats.smallBytes += bytes.length;
          resolve(url);
          try { this.onFetched?.(); } catch { /* 宿主坏了 */ }
        } catch (e) {
          this.stats.errors++;
          reject(e);
        }
      });
      this.pump();
    }).finally(() => { this.inflight.delete(hash); });
    this.inflight.set(hash, work);
    return work;
  }

  private pump() {
    while (this.active < ONLINE_FETCH_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }
}

/** 此刻在用的在线来源(导出前释放它的小尺寸缓存:契约第 11.1 节);没有给 null */
let activeOnline: OnlineSnapshotSource | null = null;
export function setActiveOnlineSource(src: OnlineSnapshotSource | null): void {
  activeOnline = src;
}
export function activeOnlineSource(): OnlineSnapshotSource | null {
  return activeOnline;
}
