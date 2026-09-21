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
export type ReadyIndex = Map<string, Map<ReadyKind, { key: string; ranges: ReadyRange[] }>>;

/**
 * 把一条消息应用到页面的 `readyIndex`。`reset` 清表,`layer` 整层替换
 * (C3 是全量语义 —— 不能合并,否则卡的参数变了之后旧区间会赖着不走)。
 */
export function applyReadyMessage(index: ReadyIndex, message: ReadyMessage): ReadyIndex {
  if (message.type === "reset") { index.clear(); return index; }
  if (message.type !== "layer") return index;
  let byKind = index.get(message.clipId);
  if (!byKind) { byKind = new Map(); index.set(message.clipId, byKind); }
  byKind.set(message.kind, { key: message.key, ranges: message.ranges });
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
      let base = "";
      try { base = await this.base(); } catch { base = ""; }
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
