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
  /** 层表 v 2(C10 契约第 18 节第 3 条):共享档的内容键;v 1 或取不到为 null */
  contentKey?: string | null;
  /** 层表 v 2:产出这一层的环境的指纹;v 1 或取不到为 null */
  envFingerprint?: string | null;
  /**
   * 层表 v 3(M7 契约 D12):这一层的候选 —— 切分方自己的、纯浏览器的,各是一种环境出的一套键;层上的 `resultKey` /
   * `envFingerprint` / `key` 就是第一个候选。哪一份活着由页面按 `task.done` 与清单认定(`layerRefOf` 的 `alive`)。
   * v 2 没有这一项,当作一个候选(`layerCandidates`)。
   */
  candidates?: LayerCandidate[];
}

/** 层表 v 3 的一个候选(M7 契约 D12):一种环境出的一套键 */
export interface LayerCandidate {
  envFingerprint: string;
  resultKey: string;
  /** 就绪索引线上的键 */
  key: string;
}

export interface LayerMap {
  /** 层表的版本(`server/artifact-transfer.mjs` 的 `LAYER_MAP_VERSION`);没写当 1 */
  v: number;
  projectId: string | null;
  fps: number;
  span: number;
  layers: OnlineLayer[];
}

/** 在线普通档认的层表版本(C10 契约第 18 节第 3 条);低内存档 v 1、v 2 都认 */
export const LAYER_MAP_V2 = 2;
/** 层表 v 3(M7 契约 D12):每层带候选;v 2 的字段照旧(等于第一个候选),旧读法照样能读 */
export const LAYER_MAP_V3 = 3;
/** 页面认得的层表版本;不认得的 `v` 整张当没有 */
export const KNOWN_LAYER_MAP_VERSIONS = [1, 2, 3] as const;

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
  /**
   * 这一层不取(C10 契约第 9 节):在线浏览器模式下的用户卡、图卡常驻「需要本地 PC 渲染辅助」,不贴别人预渲染好的快照,
   * 所以既不取它的清单也不预取它的字节。由父页按片段判(`snapshotFeed` 的 `exemptOnline`);不给就都取。
   */
  skipLayer?: (clipId: string) => boolean;
}

/** 层表 v 3 的候选表:只留三项都是非空字符串的,坏项跳过 */
function candidatesOf(raw: unknown): LayerCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: LayerCandidate[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    const { envFingerprint, resultKey, key } = c;
    if (typeof envFingerprint !== "string" || !envFingerprint || typeof resultKey !== "string" || !resultKey || typeof key !== "string" || !key) continue;
    out.push({ envFingerprint, resultKey, key });
  }
  return out;
}

/**
 * 这一层的候选(M7 契约 D12):v 3 的 `candidates`;v 2(或 v 3 的层没写候选、候选全坏)当作一个候选 —— 层自己的键与指纹;
 * v 1、缺指纹的层没有候选。
 */
export function layerCandidates(layer: OnlineLayer): LayerCandidate[] {
  if (layer.candidates?.length) return layer.candidates.map((c) => ({ ...c }));
  if (layer.envFingerprint && layer.resultKey && layer.key) return [{ envFingerprint: layer.envFingerprint, resultKey: layer.resultKey, key: layer.key }];
  return [];
}

/** 内容库回包里的层表;形状不对回 null */
export function parseLayerMap(body: unknown): LayerMap | null {
  const b = body as { v?: unknown; kind?: unknown; projectId?: unknown; fps?: unknown; span?: unknown; layers?: unknown } | null;
  if (!b || b.kind !== "layer-map" || !Array.isArray(b.layers)) return null;
  // 不认得的版本整张当没有(C10 契约第 18 节第 3 条);没写版本的是 v 1(C10a 的形状)
  const v = b.v === undefined ? 1 : Number(b.v);
  if (!(KNOWN_LAYER_MAP_VERSIONS as readonly number[]).includes(v)) return null;
  const span = Math.max(1, Math.floor(Number(b.span) || 60));
  const layers: OnlineLayer[] = [];
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  for (const raw of b.layers as Record<string, unknown>[]) {
    const kind = raw?.kind;
    if (kind !== "html" && kind !== "local") continue;
    const firstFrame = Number(raw.firstFrame), count = Number(raw.count);
    if (typeof raw.clipId !== "string" || typeof raw.key !== "string" || typeof raw.resultKey !== "string") continue;
    if (!Number.isInteger(firstFrame) || firstFrame < 0 || !Number.isInteger(count) || count < 1) continue;
    const candidates = v >= LAYER_MAP_V3 ? candidatesOf(raw.candidates) : [];
    layers.push({ clipId: raw.clipId, kind, key: raw.key, resultKey: raw.resultKey, firstFrame, count,
      ...(v >= LAYER_MAP_V2 ? { contentKey: str(raw.contentKey), envFingerprint: str(raw.envFingerprint) } : {}),
      ...(candidates.length ? { candidates } : {}) });
  }
  return { v, projectId: typeof b.projectId === "string" ? b.projectId : null, fps: Number(b.fps) || 30, span, layers };
}

/**
 * 这一层在这一档能不能用(C10 契约第 5 节、第 18 节第 3 条):
 *   - 普通档(取预渲染原尺寸):只认 v 2、且带 `contentKey` 与 `envFingerprint` 的层 —— 页面不算键,
 *     部署的 `/editor` 与渲染节点代码版本对不上、层表缺这两项时,这一层按「没有预渲染结果」处理(占位、暂停活渲),不报错;
 *   - 低内存档(取预渲染小尺寸):v 1、v 2 都认。
 */
export function usableLayer(map: Pick<LayerMap, "v">, layer: OnlineLayer, { lowMemory = false }: { lowMemory?: boolean } = {}): boolean {
  if (lowMemory) return true;
  return map.v >= LAYER_MAP_V2 && !!layer.contentKey && !!layer.envFingerprint;
}

/**
 * 层表里某个片段那一层(普通档口径):层表对得上回 `{ …, contentKey, envFingerprint }`;对不上(不认得的版本、v 1、
 * 缺内容键、缺指纹、没这一层、层表坏)回 null,不抛。`table` 收内容库回包的 body 或已解析的层表。
 *
 * 层表 v 3(M7 契约 D12):`opts.alive` 是页面认定活着的结果键(由 `task.done` 与清单得出)。候选里有活着的,
 * 就整份换成那个候选(结果键、指纹、线上键同出一个候选,不混);没有 `alive` 或认不出时回层上的(第一个候选)。
 * v 2 不看 `alive`。
 */
export function layerRefOf(table: unknown, clipId: string, opts: { lowMemory?: boolean; alive?: ReadonlySet<string> } = {}): OnlineLayer | null {
  let map: LayerMap | null = null;
  try {
    map = table && typeof table === "object" && Array.isArray((table as LayerMap).layers) && (table as LayerMap).v !== undefined && typeof (table as { kind?: unknown }).kind !== "string"
      ? (table as LayerMap) : parseLayerMap(table);
  } catch { map = null; }
  if (!map) return null;
  const layer = map.layers.find((l) => l.clipId === clipId);
  if (!layer) return null;
  if (map.v >= LAYER_MAP_V3 && opts.alive && layer.candidates?.length) {
    const pick = layer.candidates.find((c) => opts.alive!.has(c.resultKey));
    if (pick) {
      const chosen: OnlineLayer = { ...layer, resultKey: pick.resultKey, envFingerprint: pick.envFingerprint, key: pick.key };
      return usableLayer(map, chosen, opts) ? chosen : null;
    }
  }
  return usableLayer(map, layer, opts) ? layer : null;
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
  /** 本地帧 → 原尺寸 HTML 快照哈希(`frames` 表) */
  frames: Map<number, string>;
  /** 这一段每一帧都有这一档了:不必再取 */
  full: boolean;
  fetchedAt: number;
}

/**
 * 在线来源取哪一档(C10 契约第 5 节):普通档取预渲染原尺寸(`snap/<hash>` 的 HTML 快照),低内存档取预渲染小尺寸
 * (`px/<hash>` 的小位图)。
 */
export type OnlineTier = "small" | "original";

/** 页面内快照库 L2 用到的那几样(`src/online/l2.ts` 的 `L2Store`;这里只列接口,不引实现) */
export interface L2Like {
  putBlock(key: string, bytes: Uint8Array | ArrayBuffer, type?: string): Promise<unknown>;
  getBlock(key: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  hasBlock(key: string): boolean;
  putRange(layerKey: string, from: number, to: number): Promise<Array<[number, number]>>;
  getRanges(layerKey: string): Promise<Array<[number, number]>>;
  subscribeReady(cb: (e: { layerKey: string; ranges: Array<[number, number]> }) => void): () => void;
}

export interface OnlineSourceOptions {
  /** 没有 L2 时的内存缓存上限(C10a 的 64 MiB) */
  maxBytes?: number;
  tier?: OnlineTier;
  /** 页面内快照库 L2(C10 契约第 4 节);给了就把块存进它,内存里只留一小份刚用过的 */
  store?: L2Like | Promise<L2Like | null> | null;
}

/** 等 L2 打开最多这么久(毫秒),打不开就照内存走 */
export const STORE_WAIT_MS = 5000;
/** 有 L2 时内存里只留这么多刚用过的(免得同一窗口里反复解码 / 反复读库) */
export const ONLINE_HOT_CACHE_BYTES = 16 * 1024 * 1024;

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

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
  readonly tier: OnlineTier;
  private store: L2Like | null = null;
  private storeOff: (() => void) | null = null;
  /**
   * L2 还在打开时先别取:不然第一轮预取在库打开之前就发出去,关掉再开时已在库里的块又被请求一遍(C10-A2)。
   * 最多等 `STORE_WAIT_MS`,打不开就照内存走。
   */
  private storeWait: Promise<unknown> | null = null;
  /** 原尺寸:每层(按结果键)已在 L2 里的本地帧(`ranges` 表的镜像) */
  private inStore = new Map<string, Set<number>>();
  private rangesLoaded = new Set<string>();
  /** 取到一张新的块之后叫(宿主据此重投一次) */
  onFetched: (() => void) | null = null;
  /** 层表取回来过没有(取到了,或者内容库回「没有这一项」);取之前判不了哪些层缺产物 */
  private mapKnown = false;
  readonly stats = { mapFetches: 0, manifestFetches: 0, smallFetches: 0, smallBytes: 0, snapFetches: 0, snapBytes: 0, l2Hits: 0, errors: 0 };

  constructor(deps: OnlineSnapshotDeps, { maxBytes = ONLINE_CACHE_MAX_BYTES, tier = "small", store = null }: OnlineSourceOptions = {}) {
    this.deps = deps;
    this.tier = tier;
    this.cache = new ByteLru(store ? Math.min(maxBytes, ONLINE_HOT_CACHE_BYTES) : maxBytes);
    if (store) {
      const opened = Promise.resolve(store).then((s) => {
        if (!s || this.stopped) return;
        this.store = s;
        this.storeOff = s.subscribeReady((e) => this.onStoreReady(e.layerKey, e.ranges));
        this.rangesLoaded.clear();
      }, () => { /* 打不开 L2:照内存走 */ });
      this.storeWait = Promise.race([opened, new Promise((r) => setTimeout(r, STORE_WAIT_MS))]).then(() => { this.storeWait = null; });
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private get lowMemory(): boolean { return this.tier === "small"; }

  /** 这一档此刻能用的层(普通档只认 v 2 且两项齐的层) */
  private layers(): OnlineLayer[] {
    const map = this.map;
    if (!map) return [];
    return map.layers.map((l) => this.chosen(map, l)).filter((l) => usableLayer(map, l, { lowMemory: this.lowMemory }));
  }

  /*
   * 层表 v 3 的候选(M7 契约 D12):哪一份活着由本页按队列推来的 `task.done`(活)与 `task.failed { error: 'superseded' }`
   * (那一份作废了 —— 另一份活着,不是失败)认定。认定活着的候选优先;都没认定时取第一个没作废的;全作废或没有候选照旧用层上的。
   * 选定之后整份换成那个候选(`layerRefOf` 的 `alive`,结果键、指纹、线上键同出一个候选)。
   */
  private aliveKeys = new Set<string>();
  private deadKeys = new Set<string>();

  private chosen(map: LayerMap, layer: OnlineLayer): OnlineLayer {
    if (map.v < LAYER_MAP_V3 || !layer.candidates?.length) return layer;
    const pick = layer.candidates.find((c) => this.aliveKeys.has(c.resultKey)) ?? layer.candidates.find((c) => !this.deadKeys.has(c.resultKey));
    if (!pick || pick.resultKey === layer.resultKey) return layer;
    return layerRefOf(map, layer.clipId, { lowMemory: this.lowMemory, alive: new Set([pick.resultKey]) }) ?? layer;
  }

  /**
   * 队列推给本页(作为发布方)的 `task.done` / `task.failed`(M7 D12):完成的结果键认定活着,`superseded` 作废的那一份当死。
   * 认定变了就马上重发各层(换了候选的层整层换键)。别的消息不理。
   */
  noteQueueEvent(msg: { type?: unknown; id?: unknown; resultKey?: unknown; error?: unknown }): void {
    const id = typeof msg?.id === "string" ? msg.id : "";
    const keyOf = () => {
      if (typeof msg.resultKey === "string" && msg.resultKey) return msg.resultKey;
      // 细任务 id:`<kind>:<resultKey>:<from>-<to>`
      const m = /^(?:snapshot|stream):(.+):\d+-\d+$/.exec(id);
      return m ? m[1] : null;
    };
    let changed = false;
    if (msg?.type === "task.done") {
      const key = keyOf();
      if (key && !this.aliveKeys.has(key)) { this.aliveKeys.add(key); this.deadKeys.delete(key); changed = true; }
    } else if (msg?.type === "task.failed" && msg.error === "superseded") {
      const key = keyOf();
      if (key && !this.deadKeys.has(key) && !this.aliveKeys.has(key)) { this.deadKeys.add(key); changed = true; }
    }
    if (changed) { this.publishLayers(); this.kick(); }
  }

  /** 本页自己产出并完成了这一段(纯浏览器节点):这个结果键活着 */
  markAlive(resultKey: string): void {
    this.noteQueueEvent({ type: "task.done", resultKey });
  }

  /** 看哪个项目(层表的键);换了项目就清表重来 */
  setProject(projectId: string | null): void {
    const next = projectId || null;
    if (next === this.projectId) return;
    this.projectId = next;
    this.map = null;
    this.mapSig = "";
    this.mapKnown = false;
    this.manifests.clear();
    this.emitted.clear();
    this.lastMapAt = -Infinity;
    this.emit({ type: "reset", localRev: 0 });
    this.kick();
  }

  /**
   * 队列报了 `task.done`(C10 契约第 7 节「页面订阅 task.done,并入层表与就绪」):不等下一轮轮询,马上重取层表、
   * 还没满的清单也重取。
   */
  refresh(): void {
    this.lastMapAt = -Infinity;
    for (const st of this.manifests.values()) if (!st.full) st.fetchedAt = -Infinity;
    this.kick();
  }

  /** 播放头挪了:取这一窗口的清单,预取这一窗口可见重层的块 */
  focus(t: number, fps: number): void {
    this.playhead = { t: Number(t) || 0, fps: Math.max(1, Number(fps) || 30) };
    this.kick();
  }

  subscribeReady(_session: string, _localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    this.listeners.add(onMessage);
    // 新订阅方:先 reset,再把手里已有的层全量发一遍(C3 的恢复路)
    try { onMessage({ type: "reset", localRev: 0 }); } catch { /* 订阅方坏了 */ }
    for (const layer of this.layers()) {
      try { onMessage(this.layerMessage(layer)); } catch { /* 同上 */ }
    }
    this.kick();
    return () => { this.listeners.delete(onMessage); };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    if (this.storeWait) await this.storeWait;
    if (this.tier === "original") {
      const hit = this.frameOf(kind, key, localFrame);
      if (!hit) throw Object.assign(new Error(`没有这一帧的预渲染原尺寸:${kind}/${key}/${localFrame}`), { status: 404 });
      const cached = this.cache.get(`snap/${hit.hash}`);
      if (cached !== undefined) return cached;
      return this.fetchOriginal(hit.hash, hit.layer, localFrame, signal);
    }
    const hash = this.smallHashOf(kind, key, localFrame);
    if (!hash) throw Object.assign(new Error(`没有这一帧的预渲染小尺寸:${kind}/${key}/${localFrame}`), { status: 404 });
    const hit = this.cache.get(hash);
    if (hit !== undefined) return smallSnapshotHtml(hit);
    return smallSnapshotHtml(await this.fetchSmall(hash, signal));
  }

  /**
   * 层表里列着的片段(c10a 契约第 17 节「补渲」按清单判产物:不在层表里的判重层,素材服务里就没有它的产物)。
   * 层表还没取回来过回 null(判不了);内容库里没有层表回空集合(一层都没有)。
   */
  layerClipIds(): ReadonlySet<string> | null {
    if (!this.mapKnown) return null;
    return new Set(this.layers().map((l) => l.clipId));
  }

  /** 此刻的层表(探针用);还没有回 null */
  layerMap(): LayerMap | null {
    return this.map;
  }

  /** 导出前释放缓存(契约第 11.1 节):内存里那一份;L2 是可重建的缓存库,不动 */
  clearCache(): void { this.cache.clear(); }
  get cacheBytes(): number { return this.cache.total; }
  get cacheSize(): number { return this.cache.size; }
  /** 探针用:此刻的层表与各层就绪帧数 */
  debug() {
    const usable = this.layers();
    return {
      projectId: this.projectId,
      tier: this.tier,
      mapVersion: this.map?.v ?? null,
      store: !!this.store,
      layers: usable.map((l) => ({ clipId: l.clipId, kind: l.kind, key: l.key, resultKey: l.resultKey, envFingerprint: l.envFingerprint ?? null, ready: this.readyFrames(l).length,
        candidates: l.candidates?.length ?? 0 })),
      aliveKeys: this.aliveKeys.size,
      deadKeys: this.deadKeys.size,
      skipped: (this.map?.layers ?? []).filter((l) => !usable.includes(l)).map((l) => l.clipId),
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
    this.storeOff?.();
    this.storeOff = null;
  }

  /** 单测用:手动跑一轮(取层表、取窗口里的清单、预取) */
  async tickNow(): Promise<void> { await this.tick(); }

  /** 单测用:等在飞的取块都落定 */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && (this.inflight.size || this.active || this.queue.length); i++) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

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
    const have = this.inStore.get(layer.resultKey);
    for (let from = 0; from < layer.count; from += span) {
      const st = this.manifests.get(this.manifestKey(layer, this.segOf(layer, from)));
      if (!st) continue;
      if (this.tier === "original") {
        // 写入即就绪(C10 契约第 4 节):清单里有、块也已写进 L2 的帧才算就绪;没有 L2 时退回「清单里有」
        for (const f of st.frames.keys()) if (!this.store || have?.has(f)) out.push(f);
      } else {
        for (const f of st.small.keys()) out.push(f);
      }
    }
    return out;
  }

  private layerMessage(layer: OnlineLayer): ReadyMessage {
    return { type: "layer", clipId: layer.clipId, kind: layer.kind, key: layer.key, ranges: framesToRanges(this.readyFrames(layer)) };
  }

  /** 各层的就绪区间变了才发(全量语义) */
  private publishLayers() {
    for (const layer of this.layers()) {
      const msg = this.layerMessage(layer);
      if (msg.type !== "layer") continue;
      const id = `${layer.kind}:${layer.clipId}`;
      const sig = `${msg.key}|${JSON.stringify(msg.ranges)}`;
      if (this.emitted.get(id) === sig) continue;
      this.emitted.set(id, sig);
      this.emit(msg);
    }
  }

  /** L2 的 `ranges` 写入了(写入即就绪):更新镜像,重发就绪 */
  private onStoreReady(layerKey: string, ranges: Array<[number, number]>) {
    const set = new Set<number>();
    for (const [a, b] of ranges) for (let f = a; f <= b; f++) set.add(f);
    this.inStore.set(layerKey, set);
    if (this.layers().some((l) => l.resultKey === layerKey)) this.publishLayers();
  }

  /** 层表到了:把每层已在 L2 里的区间读进镜像(关掉再开时,已在库里的块不再请求) */
  private async loadStoreRanges(): Promise<void> {
    const store = this.store;
    if (!store || this.tier !== "original") return;
    let changed = false;
    for (const layer of this.layers()) {
      if (this.rangesLoaded.has(layer.resultKey)) continue;
      this.rangesLoaded.add(layer.resultKey);
      try {
        const ranges = await store.getRanges(layer.resultKey);
        const set = this.inStore.get(layer.resultKey) ?? new Set<number>();
        for (const [a, b] of ranges) for (let f = a; f <= b; f++) set.add(f);
        this.inStore.set(layer.resultKey, set);
        changed = true;
      } catch { this.rangesLoaded.delete(layer.resultKey); }
    }
    if (changed) this.publishLayers();
  }

  private smallHashOf(kind: ReadyKind, key: string, localFrame: number): string | null {
    for (const layer of this.layers()) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.small.get(localFrame);
      if (hash) return hash;
    }
    return null;
  }

  /**
   * 原尺寸:这一帧的 HTML 快照哈希与它所在的那一层。一层只取层表记录的那一种环境的帧(C10 契约第 5 节):
   * 清单按层表那一层的结果键取,而结果键就是「内容键 × 那个环境的指纹」。
   */
  private frameOf(kind: ReadyKind, key: string, localFrame: number): { hash: string; layer: OnlineLayer } | null {
    for (const layer of this.layers()) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.frames.get(localFrame);
      if (hash) return { hash, layer };
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
    if (this.storeWait) await this.storeWait;
    const now = this.now();
    if (this.projectId && now - this.lastMapAt >= LAYER_MAP_POLL_MS) {
      this.lastMapAt = now;
      await this.loadMap();
    }
    await this.loadStoreRanges();
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
    if (reply?.type !== "content.item" || reply.missing) {
      // 内容库明确回「没有」:渲染节点还没写过层表,这个项目一层产物都没有
      if (reply?.type === "content.item") this.mapKnown = true;
      return;
    }
    const map = parseLayerMap(reply.body);
    if (!map) return;
    this.mapKnown = true;
    const sig = `v${map.v}|` + JSON.stringify(map.layers) + `|${map.span}`;
    if (sig === this.mapSig) return;
    const prevLayers = this.layers();
    this.map = map;
    this.mapSig = sig;
    const alive = new Set(this.layers().map((l) => `${l.kind}:${l.clipId}`));
    for (const old of prevLayers) {
      const id = `${old.kind}:${old.clipId}`;
      if (alive.has(id)) continue;
      // 这张卡不在层表里了(改判轻、删了、这一档不认了):发一条空层,把页面表里的旧区间撤掉
      this.emitted.delete(id);
      this.emit({ type: "layer", clipId: old.clipId, kind: old.kind, key: old.key, ranges: [] });
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
    for (const layer of this.layers()) {
      if (this.deps.skipLayer?.(layer.clipId)) continue;
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
    const pick = (list: unknown, seg: [number, number]) => {
      const out = new Map<number, string>();
      for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
        if (!Array.isArray(item) || !Number.isInteger(item[0]) || !/^[0-9a-f]{64}$/.test(String(item[1]))) continue;
        const f = item[0] as number;
        if (f < seg[0] || f > seg[1]) continue;
        out.set(f, String(item[1]));
      }
      return out;
    };
    await Promise.all(wanted.map(async ({ seg, key }) => {
      this.manifestFlying.add(key);
      try {
        const reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key });
        this.stats.manifestFetches++;
        const prev = this.manifests.get(key);
        if (reply?.type !== "content.item" || reply.missing) {
          this.manifests.set(key, { small: prev?.small ?? new Map(), frames: prev?.frames ?? new Map(), full: false, fetchedAt: this.now() });
          return;
        }
        const body = reply.body as { small?: unknown; frames?: unknown } | undefined;
        const small = pick(body?.small, seg);
        const frames = pick(body?.frames, seg);
        const mine = this.tier === "original" ? frames : small;
        const full = mine.size === seg[1] - seg[0] + 1;
        const before = this.tier === "original" ? prev?.frames : prev?.small;
        if (!before || before.size !== mine.size || [...mine].some(([f, h]) => before.get(f) !== h)) changed = true;
        this.manifests.set(key, { small, frames, full, fetchedAt: this.now() });
      } catch {
        this.stats.errors++;
      } finally {
        this.manifestFlying.delete(key);
      }
    }));
    if (changed && this.map === map && !this.stopped) this.publishLayers();
  }

  /** 预取:这一窗口里当前可见的重层、这一档有块的帧,离播放头近的先取;已在 L2 里的不再请求 */
  private prefetchWindow() {
    const map = this.map;
    if (!map || !this.deps.assetBase()) return;
    const [lo, hi] = this.windowFrames();
    const g = Math.max(0, Math.floor(this.playhead.t * (map.fps || this.playhead.fps) + 1e-6));
    const wanted: { hash: string; dist: number; layer: OnlineLayer; local: number }[] = [];
    for (const layer of this.layers()) {
      if (this.deps.skipLayer?.(layer.clipId)) continue;
      const first = Math.max(lo, layer.firstFrame), last = Math.min(hi, layer.firstFrame + layer.count - 1);
      for (let gf = first; gf <= last; gf++) {
        const local = gf - layer.firstFrame;
        if (this.tier === "original") {
          const hit = this.frameOf(layer.kind, layer.key, local);
          if (!hit) continue;
          const id = `snap/${hit.hash}`;
          if (this.store?.hasBlock(id)) {
            // 块已在库里(同一内容别的层取过、或上次打开取过):不请求,补记这一层的就绪
            if (!this.inStore.get(layer.resultKey)?.has(local)) void this.store.putRange(layer.resultKey, local, local).catch(() => {});
            continue;
          }
          if (!this.cache.has(id) && !this.inflight.has(id)) wanted.push({ hash: hit.hash, dist: Math.abs(gf - g), layer, local });
        } else {
          const hash = this.smallHashOf(layer.kind, layer.key, local);
          if (hash && !this.cache.has(hash) && !this.inflight.has(hash)) wanted.push({ hash, dist: Math.abs(gf - g), layer, local });
        }
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.hash)) continue;
      seen.add(w.hash);
      if (this.tier === "original") void this.fetchOriginal(w.hash, w.layer, w.local).catch(() => { /* 下一轮再取 */ });
      else void this.fetchSmall(w.hash).catch(() => { /* 下一轮再取 */ });
    }
  }

  /** 从素材服务取一块(凭只读票据);超时、中止都算失败 */
  private async fetchAsset(ns: "px" | "snap", hash: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; type: string }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const ms = this.deps.assetTimeoutMs ?? 15_000;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        (async () => {
          const base = this.deps.assetBase();
          if (!base) throw new Error("还没有远程素材服务");
          const headers = await this.deps.authHeaders();
          const f = this.deps.fetch ?? fetch;
          const res = await f(`${base.replace(/\/+$/, "")}/${ns}/${hash}`, { headers, signal: controller.signal, cache: "force-cache" });
          if (!res.ok) throw Object.assign(new Error(`取不到 ${ns}/${hash}:${res.status}`), { status: res.status });
          const bytes = new Uint8Array(await res.arrayBuffer());
          const fallback = ns === "px" ? "image/webp" : "text/html";
          const type = (res.headers.get("content-type") || fallback).split(";")[0].trim() || fallback;
          return { bytes, type };
        })(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error("素材请求超时")); }, ms); }),
      ]);
    } finally {
      if (deadline !== null) clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
    }
  }

  private fetchSmall(hash: string, signal?: AbortSignal): Promise<string> {
    const flying = this.inflight.get(hash);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          let block = this.store ? await this.store.getBlock(`px/${hash}`) : null;
          if (block) this.stats.l2Hits++;
          else {
            block = await this.fetchAsset("px", hash, signal);
            this.stats.smallFetches++;
            this.stats.smallBytes += block.bytes.length;
            // 低内存档的 L2 只存小尺寸(C10 契约第 4 节)
            if (this.store) void this.store.putBlock(`px/${hash}`, block.bytes, block.type).catch(() => {});
          }
          const url = `data:${block.type || "image/webp"};base64,${bytesToBase64(block.bytes)}`;
          this.cache.set(hash, url);
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

  /**
   * 原尺寸(C10 契约第 5 节「流程」):可见范围的重层 → 按层表取清单 → 缺的块凭只读票据从素材服务拉 → 写 L2 →
   * `ranges` 就绪 → 可见舞台下一拍换上。块在 L2 里就不请求。
   */
  private fetchOriginal(hash: string, layer: OnlineLayer, localFrame: number, signal?: AbortSignal): Promise<string> {
    const id = `snap/${hash}`;
    const flying = this.inflight.get(id);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          let block = this.store ? await this.store.getBlock(id) : null;
          if (block) this.stats.l2Hits++;
          else {
            block = await this.fetchAsset("snap", hash, signal);
            this.stats.snapFetches++;
            this.stats.snapBytes += block.bytes.length;
            if (this.store) await this.store.putBlock(id, block.bytes, block.type || "text/html").catch(() => {});
          }
          const html = textDecoder ? textDecoder.decode(block.bytes) : String.fromCharCode(...block.bytes);
          this.cache.set(id, html);
          // 写入即就绪:这一层这一帧记进 ranges;L2 通知之后本来源重发就绪(onStoreReady)
          if (this.store && !this.inStore.get(layer.resultKey)?.has(localFrame)) await this.store.putRange(layer.resultKey, localFrame, localFrame).catch(() => {});
          resolve(html);
          try { this.onFetched?.(); } catch { /* 宿主坏了 */ }
        } catch (e) {
          this.stats.errors++;
          reject(e);
        }
      });
      this.pump();
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, work);
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
