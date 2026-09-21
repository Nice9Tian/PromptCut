/**
 * 舞台 ↔ 父页的 postMessage RPC(E0)。
 *
 * - 一个 iframe 实例一个客户端(`createStageRpc`),请求带自增 id,回包按 id 对上;
 *   iframe 换了(切 2D/3D、改画幅、热重载)就换一个客户端,旧客户端挂着的请求全部按 `detached` 回绝。
 * - **时间一律秒**(`setTime(tSec)`、`render(tSec)`、`play(fromSec)`、`setMediaT(tSec)`、
 *   回包里的 `caughtUpAtSec`、事件里的 `sec`);舞台内部自己换算成毫秒(stageClock 的 `now` 是毫秒)。
 * - 舞台 → 父页除 `pc-stage-ready` 握手和 RPC 回包外只有七种事件(`StageEvent`),父页按
 *   `event.source` 过滤来源:`frame` / `ended` / `settled` / `demote` 只认当前 `front`,
 *   `mediaReady` / `probe` / `probe-frame` 只认当前 `back`(第 4 步 E1 双舞台时生效;第 3 步单舞台
 *   全部来自同一个 iframe)。
 * - 现在同源,第 4 步 E1 之后跨源;协议里不放任何依赖同源的东西(不传函数、不传 DOM、只传可结构化克隆的值)。
 */
import type { Project } from "../kernel/project";
import type { RectWithBounds, RectsWithBoundsOptions, StageHit } from "./solid";
import type { ProjectPatch } from "./changedClips.mjs";
import type { CardCostRecord } from "./cardCostKey.mjs";

export type StageRole = "front" | "back";
export type BackJob = "probe" | "catchup" | "bake";

export interface HostCapabilities {
  /** 本地模式有预渲染进程(由父页经 iframe 的 src 查询串告知,舞台自己不探测) */
  prerender: boolean;
  /** Worker 里能拿到 OffscreenCanvas 的 webgl2 */
  offscreenGl: boolean;
  /** navigator.deviceMemory ≤ 4 或 Safari */
  lowMemory: boolean;
  /** 父页在 src 查询串里给的舞台 id */
  stageId: string;
}

export interface StageReadyMessage {
  type: "pc-stage-ready";
  hostCapabilities: HostCapabilities;
}

/**
 * 生成快照的三段耗时(任务书 3.8):在一次 `render` / `setTime` 里**累加**本次推过的每一帧。
 * 三个都不进判重 —— 判重只看活渲的 `stepMs`。
 */
export interface SnapshotCost {
  /** 样式内联(含复制 DOM) */
  inlineMs: number;
  /** 画布栅格化(没有画布的卡是 0) */
  rasterMs: number;
  /** 素材层占位 + 序列化 */
  serializeMs: number;
}

export interface RenderResult {
  remounted: boolean;
  caughtUpAtSec: number;
  elapsedMs: number;
  /**
   * **活渲耗时**:`elapsedMs` 减掉本次生成快照花的时间(任务书 3.3 / 3.8)。
   * 只有它进判重(`capped = stepMs > B`)。不带 `probe` 时 = `elapsedMs`。
   */
  stepMs: number;
  /** probe 第一趟:推了几帧、有没有被一拍上限截断 */
  frames?: number;
  truncated?: boolean;
  /** 只在 probe 时有 */
  snapshot?: SnapshotCost;
}
export interface RenderAborted {
  aborted: true;
  reason: "superseded" | "project" | "timeout" | "detached";
  elapsedMs?: number;
  stepMs?: number;
  frames?: number;
  truncated?: boolean;
  snapshot?: SnapshotCost;
}
export type RenderReply = RenderResult | RenderAborted;

export interface SetTimeOptions {
  /** C4 的快照增量,和 t 同一次提交生效(第 4 步) */
  snapshots?: Record<string, string | null>;
  /** 本次要加 `.pc-awaiting` 的片段(第 4 步) */
  awaiting?: string[];
  /** 启动 K5 的暂停态活渲(第 4 步) */
  settle?: true;
  /** K1 探针:走跳转路径、等一次真 rAF、生成一次本控件的快照,回包带四个数 */
  probe?: true;
}
export interface SetTimeReply {
  /** 只在 probe 时有:`__pcRealNow` 量的墙钟(含那一次真 rAF 的等待) */
  elapsedMs?: number;
  /**
   * 只在 probe 时有:**活渲耗时**,唯一进判重的数(任务书 3.3 / 3.8)。
   * 量的是 `clock.set` → `flushSync` → 钉动画 → `settle` 这一段,
   * **不含**那一次真 rAF 的等待(它至少是一个垂直同步,约 17 ms,见 3.8 末条),
   * 也不含生成快照。
   */
  stepMs?: number;
  /** 只在 probe 时有:生成快照的三段耗时 */
  snapshot?: SnapshotCost;
  /** 这次 setTime 走的路径,给验收和调试看 */
  path: "continuous" | "set";
}

export interface RenderOptions {
  /** true = 重挂载并从 mountFrameOf 推到 tSec;缺省 = 续推(不重挂载,从 clock.now() 推到 tSec) */
  jump?: boolean;
  maxCatchUp?: number;
  probe?: true;
  maxFrames?: number;
}

export interface SetProjectOptions {
  /** full 项目整份替换 */
  reset?: boolean;
}
export interface SetRoleOptions {
  job?: BackJob;
}
export interface SetRoleReply {
  ok: boolean;
  reason?: "unsupported";
}
export interface PauseReply {
  stoppedAt?: number;
  passed?: true;
  ok?: boolean;
  reason?: string;
}

/** 舞台对父页暴露的方法(全部异步、带请求 id) */
export interface StageRpcApi {
  setProject(project: Project | ProjectPatch, opts?: SetProjectOptions): Promise<{ ok: true }>;
  setTime(tSec: number, opts?: SetTimeOptions): Promise<SetTimeReply>;
  render(tSec: number, opts?: RenderOptions): Promise<RenderReply>;
  hitTest(x: number, y: number): Promise<StageHit | null>;
  rectsWithBounds(opts?: RectsWithBoundsOptions): Promise<RectWithBounds[]>;
  size(): Promise<{ width: number; height: number }>;
  setProxy(on: boolean): Promise<{ ok: true }>;
  setRole(role: StageRole, opts?: SetRoleOptions): Promise<SetRoleReply>;
  /** K2 的分派表 + K1 的每卡记录(第 4 步用;第 3 步舞台只存起来) */
  setPlan(plan: { plan: unknown; costs: CardCostRecord[] }): Promise<{ ok: true }>;
  /** K4(第 4 步):第 3 步回 { ok: false, reason: 'unsupported' } */
  play(fromSec: number): Promise<{ ok: boolean; reason?: string }>;
  pause(opts?: { atSec?: number }): Promise<PauseReply>;
  setSuppressed(clipIds: string[]): Promise<{ ok: true }>;
  setStreamPlanes(planes: Array<{ clipIds: string[] }>): Promise<{ ok: true }>;
  setScrubbing(on: boolean): Promise<{ ok: true }>;
  setPlaying(on: boolean): Promise<{ ok: true }>;
  setMediaT(tSec: number): Promise<{ ok: true }>;
  setLocalHashes(hashes: string[]): Promise<{ ok: true }>;
  /** A3c:patch 是相对上次投递的增量,null = 摘掉;reset = 先清空全部再应用 */
  setSnapshots(patch: Record<string, string | null>, opts?: { reset?: boolean }): Promise<{ ok: true; bytes: number }>;
}

export type StageEvent =
  | { type: "mediaReady"; sec: number }
  | { type: "frame"; sec: number }
  | { type: "ended"; sec: number }
  | { type: "settled"; sec: number; clipIds: string[] }
  /**
   * K1 的一条成绩。只报**测量值** —— `device` / `measuredAt` / `mode` / `demoted` 由父页补齐
   * 后整条 PUT(任务书 3.3)。四个数分开报(3.8):`stepMs` 是活渲单帧最差、唯一进判重的数;
   * `inlineMs` / `rasterMs` / `serializeMs` 是生成快照那三段各自的单帧最差,只排产能。
   * 旧的 `frameMs`(含生成快照的单帧最差)已删,不留兼容。
   */
  | { type: "probe"; identityKey: string; fps: number; stepMs: number; inlineMs: number; rasterMs: number; serializeMs: number; catchUpMs: number; capped?: boolean; kind: "random" | "stepped"; vtOk?: boolean; seekOk?: boolean; seekMs?: number | null }
  | { type: "demote"; clipId: string }
  | { type: "probe-frame"; clipId: string; localFrame: number; html: string };

export const STAGE_EVENT_TYPES = new Set<StageEvent["type"]>(["mediaReady", "frame", "ended", "settled", "probe", "demote", "probe-frame"]);

interface RpcRequest {
  type: "pc-rpc";
  id: number;
  method: keyof StageRpcApi;
  args: unknown[];
}
interface RpcReply {
  type: "pc-rpc-reply";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const isRpcRequest = (d: unknown): d is RpcRequest => !!d && typeof d === "object" && (d as RpcRequest).type === "pc-rpc" && typeof (d as RpcRequest).id === "number";
export const isRpcReply = (d: unknown): d is RpcReply => !!d && typeof d === "object" && (d as RpcReply).type === "pc-rpc-reply" && typeof (d as RpcReply).id === "number";
export const isStageEvent = (d: unknown): d is StageEvent => !!d && typeof d === "object" && STAGE_EVENT_TYPES.has((d as StageEvent).type);

export interface StageRpcClient extends StageRpcApi {
  /** 这个客户端绑的 iframe 窗口 */
  readonly target: Window;
  /** 订阅舞台事件(只收这个 iframe 发来的) */
  onEvent(listener: (e: StageEvent) => void): () => void;
  /** iframe 换了 / 卸了:挂着的请求全部按 detached 回绝,不再收消息 */
  dispose(): void;
  readonly disposed: boolean;
}

const METHODS: (keyof StageRpcApi)[] = ["setProject", "setTime", "render", "hitTest", "rectsWithBounds", "size", "setProxy", "setRole", "setPlan",
  "play", "pause", "setSuppressed", "setStreamPlanes", "setScrubbing", "setPlaying", "setMediaT", "setLocalHashes", "setSnapshots"];

/**
 * 父页侧:给一个舞台 iframe 建一个 RPC 客户端。
 * `targetOrigin` 现在是 `location.origin`(同源);第 4 步 E1 跨源时传舞台端口的 origin。
 */
export function createStageRpc(target: Window, targetOrigin: string = location.origin): StageRpcClient {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  const listeners = new Set<(e: StageEvent) => void>();
  const onMessage = (e: MessageEvent) => {
    if (e.source !== target) return;
    const d = e.data;
    if (isRpcReply(d)) {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || `stage rpc ${p.method} failed`));
      return;
    }
    if (isStageEvent(d)) for (const l of listeners) l(d);
  };
  window.addEventListener("message", onMessage);
  const call = (method: keyof StageRpcApi, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (disposed) {
        if (method === "render") resolve({ aborted: true, reason: "detached" });
        else reject(new Error("stage rpc: detached"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      const msg: RpcRequest = { type: "pc-rpc", id, method, args };
      try {
        target.postMessage(msg, targetOrigin);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  const client = {
    target,
    get disposed() { return disposed; },
    onEvent(listener: (e: StageEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("message", onMessage);
      for (const [id, p] of pending) {
        pending.delete(id);
        if (p.method === "render") p.resolve({ aborted: true, reason: "detached" });
        else p.reject(new Error("stage rpc: detached"));
      }
      listeners.clear();
    },
  } as StageRpcClient;
  for (const m of METHODS) (client as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => call(m, args);
  return client;
}

/**
 * 舞台侧:把方法表挂到 message 上。每个方法可以返回值或 Promise;抛错就回 `{ ok: false, error }`。
 * 只认 `window.parent` 发来的请求;回包发回 `event.source`(它就是父页)。
 */
export function serveStageRpc(api: StageRpcApi, opts: { parentOrigin?: string } = {}): () => void {
  const onMessage = (e: MessageEvent) => {
    const d = e.data;
    if (!isRpcRequest(d)) return;
    if (e.source !== window.parent) return;
    const reply = (r: RpcReply) => {
      try {
        (e.source as Window | null)?.postMessage(r, opts.parentOrigin ?? (e.origin && e.origin !== "null" ? e.origin : "*"));
      } catch (err) {
        console.error("[stage rpc] reply failed", err);
      }
    };
    const fn = (api as unknown as Record<string, unknown>)[d.method];
    if (typeof fn !== "function") {
      reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: `unknown method ${String(d.method)}` });
      return;
    }
    let out: unknown;
    try {
      out = (fn as (...a: unknown[]) => unknown).apply(api, d.args);
    } catch (err) {
      reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    Promise.resolve(out).then(
      (result) => reply({ type: "pc-rpc-reply", id: d.id, ok: true, result }),
      (err) => reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** 舞台侧:向父页发一条事件(七种之一) */
export function postStageEvent(e: StageEvent, parentOrigin = "*"): void {
  window.parent?.postMessage(e, parentOrigin);
}

/** 舞台侧:握手(带宿主能力表,J4) */
export function postStageReady(hostCapabilities: HostCapabilities, parentOrigin = "*"): void {
  const msg: StageReadyMessage = { type: "pc-stage-ready", hostCapabilities };
  window.parent?.postMessage(msg, parentOrigin);
}

/** 舞台侧:按 J4 探测宿主能力。`prerender` 与 `stageId` 来自父页写在 src 查询串里的值 */
export function detectHostCapabilities(): HostCapabilities {
  const q = new URLSearchParams(location.search);
  const ua = navigator.userAgent;
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  let offscreenGl = false;
  try {
    // 主线程上的近似:Worker 里的 OffscreenCanvas webgl2 与主线程同源同能力(Safari 17 之前 Worker 里没有 WebGL)
    offscreenGl = typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined" && !!new OffscreenCanvas(1, 1).getContext("webgl2") && !(safari && !/Version\/(1[7-9]|[2-9]\d)/.test(ua));
  } catch {
    offscreenGl = false;
  }
  return {
    prerender: q.get("prerender") === "1",
    offscreenGl,
    lowMemory: (typeof mem === "number" && mem <= 4) || safari,
    stageId: q.get("id") || "front",
  };
}
