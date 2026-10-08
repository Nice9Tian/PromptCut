/**
 * 在线页面的纯浏览器渲染节点(M7 契约 `docs/plan/m7-contract.md` 第 2、4、5、7 节;第 13 节裁定 D6、D8、D10、D14、D16)。
 *
 * 本模块只有编排与判据,不碰舞台、网络、存储、界面:它们由宿主(`src/editor/browserNodeHost.ts`)经 `deps` 注入。
 * 节点会话(认领、续约、放回、丢认领)用渲染节点同一份状态机 `server/render-node/session.mjs`;细任务的执行规矩(先报 0、去重、
 * 推完才完成、丢认领丢结果)用桌面同一份 `server/render-node/task-runner.mjs`(D11 (a));本页只在它的 `render` 里管帧与让路。
 *
 * # 当节点的条件(`browserNodeEligibility`,第 2 节)
 *
 * 在线构建、嵌了代码版本(D16:开发构建不当)、普通档、两个跨源舞台都握上手、Chromium 内核(D14)、以成员身份连着云端项目、
 * 打开项目的测量已落定 —— 全部成立才当。纯函数,不读编译期常量(Node 单测直接载它)。
 *
 * # 报到(D10 页面侧)
 *
 * `node.hello { profile: 'browser', maxConcurrent: 1, environment }`:只报原始值(`pageEnvironment()`),不报指纹;
 * 指纹由文档服务按原始值算、在 `node.welcome.envFingerprint` 回来,节点记下它(节点侧过滤按它比任务的指纹),
 * 并交给宿主(清单计划的 `input.browser` 要它,第 3.3 节)。`queue.watch` 只列本项目(队列不许纯浏览器 watch `'all'`)。
 *
 * # 用户卡与图卡(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节)
 *
 * 本页能执行同步来的用户卡与图卡时(`deps.cardInfo()` 回登记处的内容,`nodeCardInfo.ts`):
 *   - `node.hello` 多报一项 `cardRuntime`(在线卡片运行时版本,原始值;指纹仍由文档服务算);
 *   - 文档服务在 `node.welcome` 多回 `cardEnvFingerprint`(环境三项再加运行时版本),节点记下:用户卡、图卡的任务用它比指纹
 *     (`filter.mjs` 规则 1),内置卡的任务照旧比 `envFingerprint`;
 *   - 能力位 `capabilities.userCards` / `graphCards` 与 `cardSourceVersions`(每张本页已载入成功的卡的代码身份)随登记处实时更新,
 *     节点侧过滤(规则 1、3)据此认领;换代后一小段时间不报(登记处的 `NODE_CARD_SETTLE_MS`)。
 * 运行时版本在报到之后才变得可报(闸门晚于报到才立起来)时,重发一次 `node.hello`(带手里的认领接续)。不能执行时与原来完全相同。
 *
 * # 一段细任务(第 4 节)
 *
 *   认领到 → `progress(0)`(停滞规则要覆盖卡死的执行器)→ 去重(给了 `lookupResult`:内容库清单在、块都在就直接 complete)
 *   → 取项目:任务的 `projectRev` 那一版,先用发布时留存的(`keptProject`),没有再 `fetchSnapshot`,都没有就放回
 *     (`reason: 'no-snapshot'`),不拿别的版本渲(D6)
 *   → 逐帧 `bakeFrame`(后台舞台生成快照、推素材服务、进页面内快照库都在宿主那一侧),每帧 `progress(已做帧数)`
 *   → 全段齐后 `finishTask`(组清单、写内容库)→ `task.complete { ranges, ...清单 }`。
 *
 * 已做的帧按任务 id 留在本页:让路放回后重新认领到同一段只补缺的帧(第 2 节「让路」)。
 *
 * # 让路(D8,`yieldFor`)
 *
 * - `play` / `drag` / `urgent`(播放、拖动开始,更急的后台活来了):不再认领;当前这一帧做完就 `task.release`(不计失败,C2),
 *   不再生成下一帧。手里没有在做的帧(还在取项目、查去重)就立即放回。
 * - `hidden`(页面隐藏、父页 rAF 断档):不等当前帧,中止它(`signal`)并立即放回;迟到的结果丢掉。
 * 让路之后认不认领由宿主的 `isIdle()` 定(不在播放、不在拖动、离上一次交互过了安静期……)。
 *
 * # 报忙(M7 D2 补充〔裁〕,`claude/queue-maint`)
 *
 * 队列锁闲置超 30 s 会被切分方接手(D2)。页面锁着一张卡、手里却在做别的(生成别的卡的快照,或后台舞台在测量、补跑)时,
 * 那张卡没有产出,但页面没走。`node.welcome` 带 `activeIntervalMs`(新队列)时,节点在这种时候按这个间隔发
 * `node.active { busy }`(`busy`:手里有认领为 `'bake'`,否则问宿主的 `busy()`,如 `'stage'`);队列据此不把它锁着的卡判闲置。
 * 闲着、页面隐藏、只是在播放或拖动而后台没活时不发:这些时候锁照旧按产出算闲置。旧队列不带 `activeIntervalMs`,一条也不发。
 *
 * # 丢认领
 *
 * `task.lease-lost`、`node.welcome.lost`:中止这次生成快照、丢弃结果;已推的块不回收(按内容寻址,下一个认领者去重用得上)。
 *
 * # 诊断(第 7 节)
 *
 * `debug()`:状态(`off` / `idle` / `busy` / `baking`)与原因、`nodeId`、`envFingerprint`、`codeVersion`、持有的任务;
 * 计数(认领、完成、去重、放回按原因、失败、丢认领、生成快照帧数与每帧耗时 p50 / p95、被节点侧过滤挡掉的任务按原因);最近一次错误。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor,不引 `mode.ts`。
 */
// @ts-expect-error 无类型声明的 .mjs(浏览器与 Node 通用,纯逻辑)
import { createNodeSession as createNodeSessionUntyped } from "../../server/render-node/session.mjs";
// @ts-expect-error 无类型声明的 .mjs(纯函数)
import { checkClaimable as checkClaimableUntyped } from "../../server/render-node/filter.mjs";
// @ts-expect-error 无类型声明的 .mjs(同构:细任务的执行规矩,桌面与页面共用,D11)
import { createTaskRunner as createTaskRunnerUntyped, ABORTED as ABORTED_UNTYPED } from "../../server/render-node/task-runner.mjs";

/* ------------------------------------------------------------------ 当节点的条件 */

/**
 * UA 是不是 Chromium 内核(D14)。认 `Chrome/<数>`、`Chromium/<数>`、`HeadlessChrome/<数>`(Edge、Opera 等 Chromium 系都带);
 * iOS 上的 Chrome / Firefox / Edge(`CriOS`、`FxiOS`、`EdgiOS`)是 WebKit,Firefox 带 `Firefox/`,都不算。
 * 与文档服务一侧的判法相同(那边挡住不诚实的页面,这边让诚实的页面干脆不开连接)。
 */
export function isChromiumUserAgent(userAgent: unknown): boolean {
  const ua = String(userAgent ?? "");
  if (/\b(?:CriOS|FxiOS|EdgiOS)\//.test(ua) || /\bFirefox\//.test(ua)) return false;
  return /\b(?:HeadlessChrome|Chrome|Chromium)\/\d+/.test(ua);
}

export interface EligibilityInput {
  /** 在线构建(`src/online/mode.ts` 的 `ONLINE`,由调用方传) */
  online: boolean;
  /** 在线构建嵌的代码版本(`buildInfo.ts` 的 `CODE_VERSION`);开发构建为空 */
  codeVersion: string | null | undefined;
  lowMemory: boolean;
  /** 两个跨源舞台都握上手为 `'dual'`;退回同源单舞台为 `'single'` */
  stageLayout: "dual" | "single";
  userAgent: string;
  /** 以成员身份连着放云端的共享项目(页面连接在线) */
  member: boolean;
  /** 打开项目的测量已落定(加载遮罩撤下) */
  measured: boolean;
}

export type EligibilityReason = "not-online" | "dev-build" | "low-memory" | "single-stage" | "not-chromium" | "not-member" | "measuring";

/** 当节点的条件(第 2 节):全部成立回 `{ ok: true }`,否则回第一条不成立的原因 */
export function browserNodeEligibility(input: EligibilityInput): { ok: boolean; reason: EligibilityReason | null } {
  const no = (reason: EligibilityReason) => ({ ok: false, reason });
  if (input.online !== true) return no("not-online");
  if (typeof input.codeVersion !== "string" || !input.codeVersion) return no("dev-build");
  if (input.lowMemory) return no("low-memory");
  if (input.stageLayout !== "dual") return no("single-stage");
  if (!isChromiumUserAgent(input.userAgent)) return no("not-chromium");
  if (input.member !== true) return no("not-member");
  if (input.measured !== true) return no("measuring");
  return { ok: true, reason: null };
}

/* ------------------------------------------------------------------ 编排 */

/** 队列里的一个任务(契约 A.4 的 TaskView;这里只用到这些字段) */
export interface NodeTask {
  id: string;
  kind: string;
  tier?: string;
  resultKey: string;
  range: { unit?: string; from: number; to: number } | null;
  source: { projectId: string; projectRev: number; userId?: string };
  input?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  version?: number;
  [k: string]: unknown;
}

/** 一帧的产出(宿主的 `bakeFrame` 回的) */
export interface BakedFrame {
  /** 原尺寸 HTML 快照(原始字节)的 sha256 */
  hash: string;
  bytes: number;
  htmlGz?: ArrayBuffer;
  /** 预渲染小尺寸(WebP)的 sha256 与字节数 */
  small?: { hash: string; bytes: number } | null;
  [k: string]: unknown;
}
export type FrameRecord = BakedFrame & { localFrame: number };

export type YieldCause = "play" | "drag" | "urgent" | "hidden";

export interface BrowserNodeDeps {
  nodeId: string;
  projectId: string;
  /** 「用户名@设备」(与文档服务按凭证填的 `source.userId` 同形) */
  userId: string;
  codeVersion: string | null;
  /** `pageEnvironment()` 的原始值 */
  environment: { platform: string; userAgent: string; renderer: string; vendor: string };
  now: () => number;
  /** 闲的判据(父页判,第 2 节) */
  isIdle: () => boolean;
  /** 往 render 连接发一条 */
  send: (message: Record<string, unknown>) => boolean | void;
  /** 发布清单计划时留存的已确认版本(D6);没有回 null */
  keptProject: (rev: number) => unknown | null;
  /** `project.snapshot.get` 那一版;没有回 null */
  fetchSnapshot: (rev: number) => Promise<unknown | null>;
  /** 生成这一帧(后台舞台)并推送;`signal` 中止时尽早停手 */
  bakeFrame: (job: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal }) => Promise<BakedFrame>;
  /** 全段齐后组清单、写内容库;回的对象展开进 `task.complete` 的结果 */
  finishTask: (arg: { task: NodeTask; frames: FrameRecord[] }) => Promise<Record<string, unknown>>;
  /** 去重(第 4.1 节):内容库清单在、覆盖整段、块都在素材服务上就回清单,否则 null */
  lookupResult?: (task: NodeTask) => Promise<Record<string, unknown> | null>;
  /** 一段任务收尾(完成、失败、放回、丢认领)之后调:宿主据此交还后台舞台 */
  onTaskEnd?: (task: NodeTask, outcome: string) => void;
  /** `node.welcome` 回了指纹 */
  onFingerprint?: (envFingerprint: string) => void;
  /**
   * 本页能执行同步来的用户卡与图卡时回登记处的内容(`nodeCardInfo.ts` 的 `getNodeCardInfo`);不能或不给就是原来的纯浏览器节点。
   * 每个节拍读一次,不缓存。
   */
  cardInfo?: () => { cardRuntime: string | null; userCards: boolean; graphCards: boolean; cardSources: Readonly<Record<string, string>> } | null;
  /** `node.welcome` 回了(或没回)用户卡、图卡用的指纹(没有时传 null) */
  onCardEnvFingerprint?: (cardEnvFingerprint: string | null) => void;
  /** 报到被文档服务拒了(`forbidden`、`not-chromium`、`bad-message`……):宿主结束会话,不重连 */
  onRefused?: (reason: string) => void;
  /**
   * 手里没有认领时,页面此刻在忙什么(报忙用,M7 D2 补充):后台舞台在测量、补跑回 `'stage'` 之类的短串;闲着、页面隐藏、
   * 只是在播放或拖动而后台没活回 null。不给就只在手里有认领时报忙
   */
  busy?: () => string | null;
  random?: () => number;
  constants?: Record<string, unknown>;
}

export interface BrowserNodeDebug {
  state: "off" | "idle" | "busy" | "baking";
  reason: string | null;
  nodeId: string;
  envFingerprint: string | null;
  /** 用户卡、图卡的任务用的指纹(块 N);没报运行时版本或旧队列为 null */
  cardEnvFingerprint: string | null;
  /** 此刻报给节点侧过滤的用户卡、图卡能力与卡片代码身份(块 N):卡片 id → 身份 */
  cards: { runtime: string | null; userCards: boolean; graphCards: boolean; sources: Record<string, string> };
  codeVersion: string | null;
  holding: { id: string; token: number; done: number; of: number; projectRev: number | null }[];
  counters: {
    claims: number; completed: number; dedup: number; failed: number; lost: number; bakedFrames: number;
    /** 发了几条 `node.active`(报忙,M7 D2 补充) */
    active: number;
    released: Record<string, number>;
    /** 被节点侧过滤挡掉的任务,按「规则号:原因」(每个任务 id 只记一次) */
    blocked: Record<string, number>;
    frameMs: { n: number; p50: number | null; p95: number | null };
  };
  lastError: string | null;
}

export interface BrowserNode {
  /** 报到并 watch 本项目(新会话建成时调;带手里的认领去接续) */
  start(): void;
  /** render 连接上收到的消息 */
  receive(message: Record<string, unknown>): void;
  /** 认领与续约的节拍(宿主按间隔调) */
  tick(): void;
  /** 让路(D8) */
  yieldFor(cause: YieldCause): void;
  /** 下线:放回全部,不再认领 */
  stop(): void;
  debug(): BrowserNodeDebug;
  readonly envFingerprint: string | null;
  readonly cardEnvFingerprint: string | null;
}

type NodeSession = {
  start(resume?: { id: string; token: number }[]): void;
  receive(message: unknown): void;
  tick(): void;
  progress(id: string, done: number): boolean;
  complete(id: string, result?: unknown): boolean;
  fail(id: string, error?: string, retryable?: boolean): boolean;
  yieldAll(reason?: string): number;
  held(): { id: string; token: number; lastSentAt: number }[];
  known(): NodeTask[];
};
const createNodeSession = createNodeSessionUntyped as (options: Record<string, unknown>) => NodeSession;
const checkClaimable = checkClaimableUntyped as (task: unknown, node: unknown) => { ok: boolean; rule?: number; reason?: string };

type TaskRunner = {
  onTask(task: NodeTask, ctx: { token: number }): void;
  onLost(id: string, reason: string): void;
  stop(reason?: string): void;
  tokenOf(id: string): number | null;
};
const createTaskRunner = createTaskRunnerUntyped as (options: Record<string, unknown>) => TaskRunner;
/** 中止标记(与 task-runner 同一个:赛跑输给中止信号,不是执行器的错) */
const ABORTED = ABORTED_UNTYPED as symbol;

function untilAborted<T>(work: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const settled = new Promise<T>((resolve) => resolve(work()));
  return Promise.race([settled, aborted]).finally(() => { if (onAbort) signal.removeEventListener("abort", onAbort); });
}

const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

/** 每帧耗时留最近这么多个样本算 p50 / p95 */
const FRAME_SAMPLES = 200;
/**
 * 让路(play / drag / urgent)之后等当前这一帧做完最多这么久;过了就像页面隐藏那样中止它、立即放回(三级数字)。
 * 播放、拖动时后台活的门会关,正在做的那一帧在舞台里被挡住,不设上限就既不出帧也不放回(M7 验收探针 A5 / A6)。
 */
export const YIELD_FRAME_MAX_MS = 1000;
/** 已做的帧留几段(让路后重新认领同一段只补缺的帧) */
const RETAINED_TASKS = 8;

/** 本页这一侧对一次认领的记账(执行的规矩在 task-runner 里;这里只管帧、让路与诊断) */
interface Run {
  task: NodeTask;
  token: number;
  /** 中止舞台这次生成快照:跟着 runner 的中止信号,另在隐藏时由本页中止 */
  controller: AbortController;
  /** 在哪一步:查去重与取项目(`prep`)、等 `bakeFrame` 回来(`baking`)、帧间(`between`)、全段齐后组清单(`finishing`) */
  phase: "prep" | "baking" | "between" | "finishing";
  /** 要求让路的原因(做完当前帧就放回) */
  yieldCause: YieldCause | null;
  /** 要求让路的时刻(`deps.now()`):当前帧 `YIELD_FRAME_MAX_MS` 之内做不完就立即放回 */
  yieldAt: number | null;
  frames: Map<number, FrameRecord>;
  /** 去重查到的清单(`sink.resultFor` 回它) */
  found: Record<string, unknown> | null;
  ended: boolean;
}

export function createBrowserNode(deps: BrowserNodeDeps): BrowserNode {
  const nodeDesc = {
    profile: "browser",
    nodeId: deps.nodeId,
    userId: deps.userId,
    envFingerprint: null as string | null,
    /** 用户卡、图卡的任务用的指纹(块 N,`node.welcome.cardEnvFingerprint`);filter.mjs 规则 1 对这类任务拿它比 */
    cardEnvFingerprint: null as string | null,
    codeVersions: deps.codeVersion ? [deps.codeVersion] : [],
    capabilities: { transcode: false, streams: false, userCards: false, graphCards: false },
    cardSourceVersions: {} as Record<string, string[]>,
  };
  /** 最近一次报给节点侧过滤的卡片登记(诊断)与最近一次 `node.hello` 里报的运行时版本(判要不要重新报到) */
  let cardsNow: { runtime: string | null; userCards: boolean; graphCards: boolean; sources: Record<string, string> } = { runtime: null, userCards: false, graphCards: false, sources: {} };
  let helloRuntime: string | null = null;
  /** 此刻本页的卡片登记(宿主给);读不到、抛错都当没有 */
  const readCardInfo = () => {
    try {
      const info = deps.cardInfo?.() ?? null;
      if (!info || typeof info.cardRuntime !== "string" || !info.cardRuntime) return { runtime: null, userCards: false, graphCards: false, sources: {} as Record<string, string> };
      return { runtime: info.cardRuntime, userCards: info.userCards === true, graphCards: info.graphCards === true, sources: { ...info.cardSources } };
    } catch { return { runtime: null, userCards: false, graphCards: false, sources: {} as Record<string, string> }; }
  };
  /** 把登记同步进节点描述(能力位与卡片代码身份):节点侧过滤与认领据此判 */
  const refreshCards = () => {
    cardsNow = readCardInfo();
    // 文档服务没有回 cardEnvFingerprint(旧队列、运行时版本不合格)时不报能力:认领了也会因为指纹对不上被拒,不必白发请求
    const usable = cardsNow.runtime !== null && nodeDesc.cardEnvFingerprint !== null;
    nodeDesc.capabilities = { ...nodeDesc.capabilities, userCards: usable && cardsNow.userCards, graphCards: usable && cardsNow.graphCards };
    const versions: Record<string, string[]> = {};
    if (usable) for (const [id, v] of Object.entries(cardsNow.sources)) versions[id] = [v];
    nodeDesc.cardSourceVersions = versions;
  };
  let stopped = false;
  let welcomed = false;
  let refused: string | null = null;
  let run: Run | null = null;
  let lastError: string | null = null;
  /** 报忙的间隔(`node.welcome.activeIntervalMs`);旧队列不带,为 null,一条也不发 */
  let activeEvery: number | null = null;
  let lastActiveAt = -Infinity;
  /** 已做的帧:任务 id → 帧;按插入顺序淘汰 */
  const retained = new Map<string, Map<number, FrameRecord>>();
  const blockedSeen = new Set<string>();
  const frameMs: number[] = [];
  const counters = {
    claims: 0, completed: 0, dedup: 0, failed: 0, lost: 0, bakedFrames: 0, active: 0,
    released: {} as Record<string, number>,
    blocked: {} as Record<string, number>,
  };
  const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };

  /** 发往 render 连接:`node.hello` 只报原始值(D10),自报的指纹去掉 */
  const send = (message: Record<string, unknown>) => {
    let m = message;
    if (m.type === "node.hello") {
      const { envFingerprint: _own, ...rest } = m;
      m = { ...rest, profile: "browser", maxConcurrent: 1, environment: { ...deps.environment } };
      // 块 N:能执行用户卡与图卡就多报运行时版本(原始值,文档服务算 cardEnvFingerprint);不能执行时与原来一字不差
      const runtime = readCardInfo().runtime;
      helloRuntime = runtime;
      if (runtime) m = { ...m, cardRuntime: runtime };
    }
    if (m.type === "task.claim") counters.claims++;
    return deps.send(m);
  };

  const holding = (r: Run) => !stopped && !r.ended && run === r && !r.controller.signal.aborted
    && session.held().some((h) => h.id === r.task.id && h.token === r.token);

  const endRun = (r: Run, outcome: string) => {
    if (r.ended) return;
    r.ended = true;
    if (run === r) run = null;
    try { deps.onTaskEnd?.(r.task, outcome); } catch { /* 宿主坏了不影响协议 */ }
  };

  const keepFrames = (id: string, frames: Map<number, FrameRecord>) => {
    retained.delete(id);
    if (!frames.size) return;
    retained.set(id, frames);
    while (retained.size > RETAINED_TASKS) retained.delete(retained.keys().next().value as string);
  };

  /** 不等当前帧:中止它并立即放回(页面隐藏;让路之后当前帧超时做不完) */
  const abortAndRelease = (r: Run, reason: string) => {
    if (!holding(r)) return;
    keepFrames(r.task.id, r.frames);
    session.yieldAll(reason);
    bump(counters.released, reason);
    r.controller.abort();
    endRun(r, `released:${reason}`);
  };

  /** 放回手里这一段(让路、取不到项目):不计失败(C2)。放回之后 runner 判「不再持有」,丢掉这次执行 */
  const release = (r: Run, reason: string) => {
    if (!holding(r)) { endRun(r, "discarded"); return; }
    keepFrames(r.task.id, r.frames);
    session.yieldAll(reason);
    bump(counters.released, reason);
    endRun(r, `released:${reason}`);
  };

  const runOf = (ref: { resultKey?: unknown; range?: { from?: unknown; to?: unknown } | null }) => {
    const r = run;
    return r && r.task.resultKey === ref?.resultKey && r.task.range?.from === ref?.range?.from && r.task.range?.to === ref?.range?.to ? r : null;
  };

  /** 执行一段(task-runner 的 executor.render):取项目、逐帧生成快照、处理让路。回这一段的帧 */
  async function render(task: NodeTask, { signal, progress }: { signal: AbortSignal; progress: (done: number) => void }): Promise<FrameRecord[] | null> {
    const r = run && run.task.id === task.id ? run : null;
    if (!r) throw ABORTED;
    signal.addEventListener("abort", () => r.controller.abort(), { once: true });
    const mine = r.controller.signal;
    if (task.kind !== "snapshot" || !task.range) {
      // 节点侧过滤只让快照任务进来;万一来了别的,放回、不做
      release(r, "unsupported");
      return null;
    }
    if (r.yieldCause) { release(r, `yield-${r.yieldCause}`); return null; }
    // D6:任务的 projectRev 那一版;先用发布时留存的,没有再取快照,都没有就放回,不拿别的版本渲
    const rev = Number(task.source?.projectRev);
    let project: unknown = Number.isSafeInteger(rev) ? deps.keptProject(rev) : null;
    if (!project && Number.isSafeInteger(rev)) {
      project = await untilAborted(() => deps.fetchSnapshot(rev), mine).catch((e) => { if (e === ABORTED) throw e; return null; });
      if (!holding(r)) return null;
    }
    if (!project) {
      lastError = `取不到第 ${Number.isSafeInteger(rev) ? rev : "?"} 版项目`;
      release(r, "no-snapshot");
      return null;
    }
    const { from, to } = task.range;
    for (let f = from; f <= to; f++) {
      if (r.frames.has(f)) continue;
      if (r.yieldCause) { release(r, `yield-${r.yieldCause}`); return null; }
      if (!holding(r)) return null;
      const t0 = deps.now();
      r.phase = "baking";
      let out: BakedFrame;
      try {
        out = await untilAborted(() => deps.bakeFrame({ task, project, localFrame: f, signal: mine }), mine);
      } finally {
        r.phase = "between";
      }
      if (!holding(r)) return null;
      r.frames.set(f, { ...out, localFrame: f });
      counters.bakedFrames++;
      frameMs.push(Math.max(0, deps.now() - t0));
      if (frameMs.length > FRAME_SAMPLES) frameMs.splice(0, frameMs.length - FRAME_SAMPLES);
      progress(r.frames.size);
    }
    // 全段齐:此后即使被要求让路也收尾(这一批已做完,放回只会让下一个认领者重做)
    r.phase = "finishing";
    return [...r.frames.values()].sort((a, b) => a.localFrame - b.localFrame);
  }

  const sink = {
    /** 去重(第 4.1 节):内容库清单在、覆盖整段、块都在就直接完成 */
    async has(ref: { resultKey: string; range: NodeTask["range"] }) {
      const r = runOf(ref);
      if (!r || !deps.lookupResult) return false;
      const found = await untilAborted(() => deps.lookupResult!(r.task), r.controller.signal).catch((e) => { if (e === ABORTED) throw e; return null; });
      r.found = found && typeof found === "object" ? found : null;
      return !!r.found;
    },
    async resultFor(ref: { resultKey: string; range: NodeTask["range"] }) {
      return runOf(ref)?.found ?? null;
    },
    /** 全段齐后组清单、写内容库(宿主的 finishTask);回的清单展开进 `task.complete` */
    async put(entry: { resultKey: string; range: NodeTask["range"]; artifacts: FrameRecord[] | null }) {
      const r = runOf(entry);
      if (!r || !Array.isArray(entry.artifacts)) return { complete: false };
      const result = await deps.finishTask({ task: r.task, frames: entry.artifacts });
      return { complete: true, result };
    },
  };

  /** task-runner 的诊断事件:收尾与计数 */
  const onRunnerEvent = (e: { type: string; id: string; error?: string; retryable?: boolean }) => {
    const r = run && run.task.id === e.id ? run : null;
    switch (e.type) {
      case "completed":
        counters.completed++;
        retained.delete(e.id);
        if (r) endRun(r, "completed");
        break;
      case "dedup":
        counters.dedup++;
        retained.delete(e.id);
        if (r) endRun(r, "dedup");
        break;
      case "failed":
        counters.failed++;
        lastError = e.error ?? lastError;
        if (r) { keepFrames(e.id, r.frames); endRun(r, e.retryable === false ? "failed-final" : "failed"); }
        break;
      case "discarded":
        if (r) { keepFrames(e.id, r.frames); endRun(r, "discarded"); }
        break;
      default:
        break;
    }
  };

  const runner = createTaskRunner({
    nodeId: deps.nodeId,
    session: () => session,
    executor: { render },
    sink,
    emit: (e: { type: string; id: string; error?: string; retryable?: boolean }) => { try { onRunnerEvent(e); } catch { /* 诊断出错不打断协议 */ } },
  });

  const session = createNodeSession({
    nodeId: deps.nodeId,
    node: nodeDesc,
    send,
    now: deps.now,
    isIdle: () => !stopped && refused === null && welcomed && deps.isIdle(),
    maxConcurrent: 1,
    projects: [deps.projectId],
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.constants ? { constants: deps.constants } : {}),
    onTask: (task: NodeTask, ctx: { token: number }) => {
      if (!task || typeof task.id !== "string") return;
      if (run) { run.controller.abort(); endRun(run, "replaced"); }
      run = {
        task, token: ctx.token, controller: new AbortController(), phase: "prep", yieldCause: null, yieldAt: null,
        frames: new Map(retained.get(task.id) ?? []), found: null, ended: false,
      };
      // 开工先报 0、去重、执行、推送、完成的规矩在 task-runner(桌面与页面同一份,D11)
      runner.onTask(task, ctx);
    },
    onLost: (id: string, reason: string) => {
      counters.lost++;
      runner.onLost(id, reason);
      const r = run;
      if (r && r.task.id === id) { r.controller.abort(); keepFrames(id, r.frames); endRun(r, `lost:${reason}`); }
    },
  });

  /** 此刻忙什么(报忙用):手里有认领就是在生成快照;否则问宿主(后台舞台的更急的活) */
  const busyNow = (): string | null => {
    const r = run;
    if (r && !r.ended) return "bake";
    try {
      const b = deps.busy?.() ?? null;
      return typeof b === "string" && b ? b.slice(0, 32) : null;
    } catch { return null; }
  };

  /** 报忙(M7 D2 补充):新队列、报到过、忙着、离上一次过了间隔才发 */
  const reportActive = () => {
    if (activeEvery === null || !welcomed || stopped || refused) return;
    const now = deps.now();
    if (now - lastActiveAt < activeEvery) return;
    const busy = busyNow();
    if (!busy) return;
    if (send({ type: "node.active", busy }) === false) return;
    lastActiveAt = now;
    counters.active++;
  };

  /** 被节点侧过滤挡掉的任务按原因记一次(诊断;服务端与节点侧都挡,页面不另判) */
  const noteBlocked = () => {
    for (const task of session.known()) {
      if (blockedSeen.has(task.id)) continue;
      const c = checkClaimable(task, nodeDesc);
      if (c.ok) continue;
      blockedSeen.add(task.id);
      bump(counters.blocked, `${c.rule}:${c.reason}`);
    }
    if (blockedSeen.size > 5000) blockedSeen.clear();
  };

  return {
    start() {
      if (stopped || refused) return;
      welcomed = false;
      // 新会话:带手里、真在跑的认领去接续(HT-a 第 4.4 节;队列按令牌接续,对不上的回 lost)
      session.start(session.held().filter((h) => runner.tokenOf(h.id) === h.token).map(({ id, token }) => ({ id, token })));
    },
    receive(message) {
      if (stopped || !message || typeof message !== "object") return;
      if (message.type === "node.welcome") {
        welcomed = true;
        // 新队列认 node.active(M7 D2 补充):记下间隔;每次报到从头算,忙着就在下一拍报
        const every = Number(message.activeIntervalMs);
        activeEvery = Number.isFinite(every) && every > 0 ? every : null;
        lastActiveAt = -Infinity;
        const fp = typeof message.envFingerprint === "string" && message.envFingerprint ? message.envFingerprint : null;
        if (fp && fp !== nodeDesc.envFingerprint) {
          nodeDesc.envFingerprint = fp;
          try { deps.onFingerprint?.(fp); } catch { /* 宿主坏了 */ }
        }
        // 块 N:用户卡、图卡用的指纹(没有就清掉:重新报到、旧队列)
        const cardFp = typeof message.cardEnvFingerprint === "string" && message.cardEnvFingerprint ? message.cardEnvFingerprint : null;
        if (cardFp !== nodeDesc.cardEnvFingerprint) {
          nodeDesc.cardEnvFingerprint = cardFp;
          try { deps.onCardEnvFingerprint?.(cardFp); } catch { /* 宿主坏了 */ }
        }
        refreshCards();
      } else if (message.type === "error" && !welcomed && message.reqId === undefined) {
        // 报到被拒(D9 forbidden、D14 not-chromium、D10 bad-message):不当节点、不重连
        refused = String(message.reason ?? "error");
        lastError = `报到被拒:${refused}`;
        try { deps.onRefused?.(refused); } catch { /* 宿主坏了 */ }
      }
      if (message.type === "queue.snapshot" || message.type === "task.opened") refreshCards();
      session.receive(message);
      if (message.type === "queue.snapshot" || message.type === "task.opened") noteBlocked();
    },
    tick() {
      if (stopped || refused) return;
      // 块 N:登记变了随时同步进节点描述;运行时版本在报到之后才可报(或变了)就重新报到一次(带手里的认领接续)
      refreshCards();
      if (welcomed && cardsNow.runtime !== helloRuntime) {
        welcomed = false;
        session.start(session.held().filter((h) => runner.tokenOf(h.id) === h.token).map(({ id, token }) => ({ id, token })));
      }
      // 让路之后当前帧迟迟做不完(播放、拖动时后台活的门关了,这一帧在舞台里被挡住):不再等,中止并立即放回
      const r = run;
      if (r && !r.ended && r.yieldCause && r.phase === "baking" && r.yieldAt !== null && deps.now() - r.yieldAt >= YIELD_FRAME_MAX_MS) {
        abortAndRelease(r, `yield-${r.yieldCause}`);
      }
      session.tick();
      reportActive();
    },
    yieldFor(cause) {
      const r = run;
      if (!r || r.ended) return;
      if (cause === "hidden") {
        // 隐藏页的计时器被节流,续约不可靠:不等当前帧,中止并立即放回;迟到的结果丢掉
        abortAndRelease(r, "yield-hidden");
        return;
      }
      if (!r.yieldCause) { r.yieldCause = cause; r.yieldAt = deps.now(); }
      // 在等哪一步决定什么时候放回:
      //   prep       还没开始生成快照(查去重、取项目),没有「当前这一批」:立即放回并中止
      //   baking     当前这一帧做完再放回(执行循环在帧回来之后看 yieldCause)
      //   finishing  全段已齐,只剩组清单与报完成:照常完成(放回只会让下一个认领者重做)
      if (r.phase === "prep") {
        release(r, `yield-${cause}`);
        r.controller.abort();
      }
    },
    stop() {
      if (stopped) return;
      const r = run;
      if (r) { r.controller.abort(); keepFrames(r.task.id, r.frames); }
      try { session.yieldAll("offline"); } catch { /* 连接已坏 */ }
      if (r) endRun(r, "released:offline");
      stopped = true;
      runner.stop("offline");
    },
    debug() {
      const sorted = [...frameMs].sort((a, b) => a - b);
      const r = run;
      const held = session.held();
      const state: BrowserNodeDebug["state"] = stopped || refused ? "off" : r && !r.ended ? (r.phase === "baking" ? "baking" : "busy") : "idle";
      return {
        state,
        reason: stopped ? "stopped" : refused ? `refused:${refused}` : !welcomed ? "hello" : r?.yieldCause ? `yield-${r.yieldCause}` : null,
        nodeId: deps.nodeId,
        envFingerprint: nodeDesc.envFingerprint,
        cardEnvFingerprint: nodeDesc.cardEnvFingerprint,
        cards: { runtime: cardsNow.runtime, userCards: nodeDesc.capabilities.userCards, graphCards: nodeDesc.capabilities.graphCards, sources: { ...cardsNow.sources } },
        codeVersion: deps.codeVersion,
        holding: held.map((h) => ({
          id: h.id, token: h.token,
          done: r && r.task.id === h.id ? r.frames.size : 0,
          of: r && r.task.id === h.id && r.task.range ? r.task.range.to - r.task.range.from + 1 : 0,
          projectRev: r && r.task.id === h.id ? Number(r.task.source?.projectRev) : null,
        })),
        counters: {
          claims: counters.claims, completed: counters.completed, dedup: counters.dedup, failed: counters.failed, lost: counters.lost,
          bakedFrames: counters.bakedFrames, active: counters.active,
          released: { ...counters.released }, blocked: { ...counters.blocked },
          frameMs: { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) },
        },
        lastError,
      };
    },
    get envFingerprint() { return nodeDesc.envFingerprint; },
    get cardEnvFingerprint() { return nodeDesc.cardEnvFingerprint; },
  };
}
