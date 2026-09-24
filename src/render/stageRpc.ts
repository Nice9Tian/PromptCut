/**
 * 舞台 ↔ 父页的 postMessage RPC(E0)。
 *
 * - 一个 iframe 实例一个客户端(`createStageRpc`),请求带自增 id,回包按 id 对上;
 *   iframe 换了(热重载、卸载)就换一个客户端,旧客户端挂着的请求全部按 `detached` 回绝;
 *   目标窗口关了(iframe 被拿出 DOM)也一样 —— 发请求时、以及有请求挂着时每 `CLOSED_POLL_MS` 查一次。
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
import type { StreamPlaneRequest } from "./streamPlayer";

export type { StreamPlaneRequest };

export type StageRole = "front" | "back";
export type BackJob = "probe" | "catchup" | "bake";

export interface HostCapabilities {
  /** 本地模式有预渲染进程(由父页经 iframe 的 src 查询串告知,舞台自己不探测) */
  prerender: boolean;
  /** Worker 里能拿到 OffscreenCanvas 的 webgl2 */
  offscreenGl: boolean;
  /** navigator.deviceMemory ≤ 4 或 Safari */
  lowMemory: boolean;
  /**
   * 父页在 src 查询串里给的舞台 id(`A` / `B`)。**只是实例名,和角色无关**(E1):
   * 角色只经 `setRole` 定,两个 iframe 谁当 `front` 都行、中途还会互换(K5)。
   */
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

/**
 * K1 的探针分两趟(任务书 K1,用户 2026-09-22 确认)。
 * - `'time'` **计时趟**:只推进,不生成快照、不 post `probe-frame`;按
 *   `PROBE_MAX_FRAMES` / `PROBE_MAX_MS` 封顶(**不按一拍预算截断**——旧做法让 61 张推帧卡
 *   全部只推了 1～10 帧);回包带 `steps`(每帧的活渲耗时),`stepMs` 取它的稳健值、
 *   `catchUpMs` 取它的和。
 * - `'snapshot'` **快照趟**:每帧先推进、再生成快照并 post `probe-frame`,量三段快照耗时;
 *   仍受一拍预算约束,它的截断不影响任何判定。
 *
 * - `'booleans'` **两趟布尔探针**(R4b 加):`vtOk` / `seekOk` / `seekMs`。整趟都在舞台里跑
 *   (它要 `pinner.syncIn` 钉子树虚拟时间,父页够不到),回包带 `booleans`。
 *   三趟各自先按 K3 的「重挂载定位配方」复位,各 `PROBE_BOOL_FRAMES` 帧或 `PROBE_BOOL_MS` 封顶;
 *   **生成的快照一律不 post `probe-frame`**(它们按定义可能与正确帧不同,存下去会覆盖正确的死素材)。
 *
 * `true` 等于 `'snapshot'`(兼容旧调用方)。
 */
export type ProbeMode = "time" | "snapshot" | "booleans";

/**
 * K1 的两趟布尔探针结果(pinned 划分轴一「如何区分 SeekOK」)。
 *
 * - `vtOk`:能不能只用**子树虚拟时间**推(`pinner.syncIn` + 组件本地 `t`,全局时钟不动)。
 *   决定 K3(b) / K5 走哪条追帧路。读全局帧循环时间戳的 Motion JS 动画推不动,是 `false`。
 * - `seekOk`:能不能**一步钉到**目标帧(不经中间帧),结果和逐帧推到那一帧相同。
 *   **只看结果一致,不看代价** —— 代价是 K2 的事。
 * - `seekMs`:从第 0 帧直接钉到片段最后一帧的墙钟(`__pcRealNow`)。
 *   超过 `PROBE_BOOL_MS` 记 `null`(未知)—— 记上限值再线性缩放得到的是乐观的下界,
 *   K2 对 `null` 一律按推帧卡规则走,和 `catchUpMs` 截断时的外推口径一样是保守的。
 */
export interface ProbeBooleans {
  vtOk: boolean;
  seekOk: boolean;
  seekMs: number | null;
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
  /** probe 第一趟:推了几帧、有没有被上限截断 */
  frames?: number;
  truncated?: boolean;
  /** 只在 probe 时有 */
  snapshot?: SnapshotCost;
  /**
   * 只在 `probe: 'time'` 时有:**每一帧**的活渲耗时(`__pcRealNow` 量,不含帧间让出的时间、
   * 不含生成快照)。`stepMs` 要取它的百分位(`robustStep`)而不是单次最大 ——
   * 限 2 核下同一张卡两次实测的单帧最差能差十几倍,越线的是偶发卡顿、不是稳定成本。
   */
  steps?: number[];
  /**
   * 只在 `probe: 'snapshot'` 时有:**每一帧**生成快照那三段的耗时。
   *
   * 同一趟的 `snapshot` 是这些的**累加**(给「这一趟花了多久」用),而成本记录要的是
   * **单帧的稳健值**(`robustStep`,任务书 K1),累加值换算不回来。离线探针为了拿逐帧数
   * 只好一帧发一次 `render`(40 次往返);常驻探针在加载遮罩下跑,40 × N 次往返太慢,
   * 所以这里和 `steps` 对称地把逐帧样本一起带回去,一次往返就够。
   */
  snapshotSteps?: SnapshotCost[];
  /** 只在 `probe: 'booleans'` 时有 */
  booleans?: ProbeBooleans;
}
/**
 * `render` 被掐断 / 拒绝时的回包。父页对每个 reason 的规矩不一样(E0):
 *   - `superseded`:父页自己的新 `render` 掐的,**直接丢弃**,重发只会再掐掉新的那次;
 *   - `project`:`setProject` 掐的,按当前目标重发(最多 3 次);**例外**是 `back` 正处在
 *     `job: 'catchup'` 期间(补跑 / 页面侧测量自己灌的项目),那时一律丢弃 —— 闸门按工作项判、
 *     不按 `settling` 标志判(stageJobs.ts 的 `renderAbortAction`);
 *   - `timeout`:K1 探针的封顶,既不重发也不当错误(截断 ≠ `capped`);
 *   - `role`:E1 的角色闸门,收到的舞台不是 `back`。**当错误、不重发** —— 重发也还是同一个角色;
 *   - `detached`:RPC 客户端在 iframe 换掉 / 卸载时自己造的。丢弃回包、按新客户端重发当前目标。
 */
export interface RenderAborted {
  aborted: true;
  reason: "superseded" | "project" | "timeout" | "role" | "detached";
  elapsedMs?: number;
  stepMs?: number;
  frames?: number;
  truncated?: boolean;
  snapshot?: SnapshotCost;
  steps?: number[];
  snapshotSteps?: SnapshotCost[];
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
export interface SetTimeResult {
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
  /**
   * 只在 probe 且有 canvas 卡时有(R9 M4):GL Worker 报的每卡 GPU 时间(毫秒,`gl.finish()` 前后的墙钟)。
   * 诊断用,不进判重 —— 判重的 `stepMs` 已经含 `beat → done` 往返。
   */
  glGpuMs?: Record<string, number>;
  /** 这次 setTime 走的路径,给验收和调试看 */
  path: "continuous" | "set";
}
/**
 * 带 `probe: true` 的 `setTime` 撞上角色闸门(E1):收到的舞台不是 `back`。
 * 和 `render` 的 `role` 同一条规矩 —— 父页当错误、不重发。不带 `probe` 的 `setTime`
 * 两种角色都收(拖动发给 `front`、D4 的页面侧测量发给 `back`),不会走到这里。
 */
export interface SetTimeAborted {
  aborted: true;
  reason: "role";
}
export type SetTimeReply = SetTimeResult | SetTimeAborted;

export interface RenderOptions {
  /** true = 重挂载并从 mountFrameOf 推到 tSec;缺省 = 续推(不重挂载,从 clock.now() 推到 tSec) */
  jump?: boolean;
  maxCatchUp?: number;
  /** K1 探针的趟别(见 `ProbeMode`)。`true` 等于 `'snapshot'`。 */
  probe?: true | ProbeMode;
  /** 封顶帧数。计时趟不给就用 `PROBE_MAX_FRAMES`。 */
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
/**
 * `play` / `pause` 共用的回包(K4)。第 3 步 `play` 的内联回包和 `PauseReply` 是两个形状,
 * R2 统一成这一个,**`ok` 不可选** —— 调用方先看 `ok` 再取别的字段,不用猜缺省值。
 *
 * 三种情况:
 *   - `{ ok: true, stoppedAt }`:停在这一秒(= 最后一拍的 `sec`)。不带 `atSec` 的立即停、
 *     带 `atSec` 的武装停到达、以及循环本来就停着(`ended` 之后 / 重复 `pause()`)都回它;
 *   - `{ ok: true, passed: true }`:武装停的那一拍**已经 post 过**(当前拍序号 ≥ `atSec` 的拍序号),
 *     不停 —— 否则永远等不到那一拍、RPC 永不回包;
 *   - `{ ok: false, reason }`:做不了。R2 的舞台还没有节拍循环(K4 是 R5 的活),
 *     `play` / `pause` 一律回 `{ ok: false, reason: 'unsupported' }`。
 */
export type PlayReply =
  | { ok: true; stoppedAt: number; passed?: undefined }
  | { ok: true; stoppedAt?: undefined; passed: true }
  | { ok: false; reason: string };

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
  /** K4(R5):R2 的舞台还没有节拍循环,两个都回 { ok: false, reason: 'unsupported' } */
  play(fromSec: number): Promise<PlayReply>;
  pause(opts?: { atSec?: number }): Promise<PlayReply>;
  setSuppressed(clipIds: string[]): Promise<{ ok: true }>;
  /**
   * G1 / C3 的流平面(父页按就绪索引里 `kind: 'stream'` 的层合成)。元素的形状仍是 `{ clipIds }`,
   * R8 加了两个可选字段:`key`(流键)和 `ranges`(就绪的分段号闭区间)—— 舞台里的 `streamPlayer`
   * 凭它们去拉分段;不带 `key` 的平面只占位、不解码(R8 之前的调用方照旧只发 `clipIds`)。
   */
  setStreamPlanes(planes: StreamPlaneRequest[]): Promise<{ ok: true }>;
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

/**
 * 每种事件**只认哪个角色**发来的(E0 末条:父页按 `event.source` 过滤来源)。
 *
 * `frame` / `ended` / `settled` / `demote` 是播放器舞台的事,只认当前 `front` 那个 iframe;
 * `mediaReady` / `probe` / `probe-frame` 是后台舞台的事,只认当前 `back` 的。
 * **不过滤就会重复 `tick`**:K5 的角色互换那一拍两个舞台都可能 post
 * (旧 `front` 走完本拍才停,新 `front` 已经开始报 `frame`)。
 *
 * 过滤落在 `stageBridge.ts` 的 `onStageEvent`:只有那里同时知道「哪个客户端」和
 * 「它此刻是什么角色」。`createStageRpc` 那一层的 `e.source !== target` 只解决前半个问题。
 */
const FRONT_EVENT_TYPES = new Set<StageEvent["type"]>(["frame", "ended", "settled", "demote"]);

/** 这种事件该由哪个角色的舞台发出来 */
export function stageEventRole(type: StageEvent["type"]): StageRole {
  return FRONT_EVENT_TYPES.has(type) ? "front" : "back";
}

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
 * 有请求挂着时,每隔这么久看一眼目标窗口还在不在。
 *
 * **为什么要有它**:iframe 从 DOM 里拿掉之后,发给它的 `postMessage` 被浏览器**静默丢弃**,
 * 不抛错、也永远没有回包;而 `call()` 本身不设超时(`render` / 武装停的 `pause` 本来就可能等很久,
 * 一刀切的超时会误杀它们)。以前唯一的出路是等下一次 `pc-stage-ready` 来 `dispose()` ——
 * 3D 页卸掉舞台 iframe 那一次,`play()` 就这样挂了一分钟,播放头纹丝不动。
 * 窗口关了就不可能再回包,所以按「关了」判比按时长判准:活着的慢请求一个都不误杀。
 */
export const CLOSED_POLL_MS = 1000;

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
  /** 窗口关了没有。`closed` 读不到(极老的宿主 / 测试替身)时当作还开着,退回旧行为 */
  const targetClosed = () => { try { return target.closed === true; } catch { return false; } };
  /** 挂着请求时才转的巡检(见 CLOSED_POLL_MS);窗口一关就整个客户端按 detached 收摊 */
  let poll: ReturnType<typeof setInterval> | null = null;
  const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };
  const startPoll = () => {
    if (poll !== null) return;
    poll = setInterval(() => {
      if (!pending.size) stopPoll();
      else if (targetClosed()) client.dispose();
    }, CLOSED_POLL_MS);
  };
  const call = (method: keyof StageRpcApi, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      // 窗口已经关了:和 dispose 之后同一套回法,别把请求发进一个不会回包的窗口
      if (!disposed && targetClosed()) client.dispose();
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
        return;
      }
      startPoll();
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
      stopPoll();
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
    // 主线程上的近似:Worker 里的 OffscreenCanvas webgl2 与主线程同源同能力(Safari 17 之前 Worker 里没有 WebGL)。
    // 真正决定走不走 Worker 的是 glHost 在 Worker 里的实测(R9 M2);这里只给 `device` 串和父页选路线用。
    const probe = typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined" ? new OffscreenCanvas(1, 1).getContext("webgl2") : null;
    offscreenGl = !!probe && !(safari && !/Version\/(1[7-9]|[2-9]\d)/.test(ua));
    // 探完立刻放掉:验收要「舞台主线程 0 个活的 WebGL 上下文」(R9),这一个不能留着等 GC
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    offscreenGl = false;
  }
  // `?glOffscreen=0`:把探测强制为 false(R9 验收「能力退路」;glHost 读同一个开关走主线程)
  if (q.get("glOffscreen") === "0") offscreenGl = false;
  return {
    prerender: q.get("prerender") === "1",
    offscreenGl,
    lowMemory: (typeof mem === "number" && mem <= 4) || safari,
    // stageId **只是实例名,和角色无关**(E1):两个 iframe 是 `A` / `B`,谁是 front / back
    // 只经 setRole 定。缺省给 `A` 而不是 `front`,免得又把实例名读成角色名。
    stageId: q.get("id") || "A",
  };
}
