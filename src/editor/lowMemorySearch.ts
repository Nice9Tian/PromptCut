/**
 * 低内存档的轻重判定:共享成本记录加界限搜索(语义 `product/platforms.md`「面向的平台」、`mechanism/rendering.md`「低内存档」;
 * 契约 `docs/plan/c10-contract.md` 第 3 节,分支 `claude/c10-cost`)。纯的部分在 `src/render/boundarySearch.mjs`,
 * 这里是页面一侧的驱动:取记录、在唯一那个舞台里测、把结果交给分派(`planDispatch.setPlanLowMemoryLight`)。
 *
 * # 流程
 *
 * 1. 打开项目时经共享项目的文档服务连接读本项目的全部成本记录(`sharedCosts.ts` 的 `listSharedCosts`),顺带拿到本机环境的指纹;
 * 2. 项目里每张卡(按 `identityKey` 去重;用户卡、图卡这台设备渲染不了,不参加、按重卡)交给 `boundarySearch`;
 * 3. 测量在**自己的舞台**里做:低内存档只有一个舞台,不开后台舞台。测量期间把它临时切成 `back` 角色(舞台的探针闸门只认 `back`),
 *    一次只测一个片段(缩水项目,同 `probeRunner.ts`),只走计时趟、不生成快照(`render(…, { probe: 'time' })`;
 *    `direct` 卡按播种的随机帧逐帧 `setTime(…, { probe: true })`),单帧耗时按 `summarizeProbe` 同一口径取;
 *    测完切回 `front`,整份项目重灌,由调用方(`Preview`)把画面、抑制与快照重投一遍;
 * 4. 本机测过的结果按「卡片身份 + 本机环境指纹」经注入的 `store`(`getCost` / `putCost`)存下,下次打开复用。
 *    缺省是页面内存(`createMemoryCostStore`),集成时接到页面内快照库 L2 的 `costs` 表。
 *
 * # 界面
 *
 * 真要在舞台里测的时候(本地复用全命中就一次都不测),盖一层与桌面加载遮罩同样的遮罩(`LowMemoryGate`):舞台测量时画面会被
 * 拨到缩水项目上,遮罩挡住这段画面和编辑操作(语义 `product/rendering.md`「测量」:打开项目时在加载遮罩下测;
 * 测量遮罩是「预览不无提示地透明」的唯一例外)。测量期间父页不投快照、不发抑制、不拨时间(`lowMemoryMeasuring()`)。
 * 取记录、判定都很快,不挡界面。
 */
import type { Project } from "../kernel/project";
import type { RenderAborted, RenderReply, SetTimeAborted, SetTimeReply, StageRpcClient } from "../render/stageRpc";
import { boundarySearch, classifyWithBoundary, maxMeasurements, type BoundaryResult, type CostStore } from "../render/boundarySearch.mjs";
import { budgetOf } from "../render/pipelinePlan.mjs";
import { PROBE_MAX_FRAMES, resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import { summarizeProbe } from "../render/probeSummary.mjs";
import { listSharedCosts, type PageEnvironment, type SharedCostRecord } from "./sharedCosts";

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
type Clip = Project["tracks"][number]["clips"][number];

/* ------------------------------------------------------------------ 状态(遮罩与父页的闸门读它) */

export interface LowMemorySearchState {
  /** 正在舞台里测(遮罩在) */
  measuring: boolean;
  /** 这一轮已经真测了几张 */
  done: number;
  /** 最多测几张(`maxMeasurements`) */
  estimate: number;
  /** 正在测的卡(cardId) */
  card: string | null;
}

const IDLE: LowMemorySearchState = { measuring: false, done: 0, estimate: 0, card: null };
let state: LowMemorySearchState = IDLE;
const listeners = new Set<(s: LowMemorySearchState) => void>();

function setState(patch: Partial<LowMemorySearchState>) {
  state = { ...state, ...patch };
  for (const cb of listeners) cb(state);
}

export function lowMemorySearchState(): LowMemorySearchState {
  return state;
}
export function onLowMemorySearch(cb: (s: LowMemorySearchState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** 舞台此刻被测量占着:父页不投快照、不发抑制、不拨时间、不推项目 */
export function lowMemoryMeasuring(): boolean {
  return state.measuring;
}

/* ------------------------------------------------------------------ 测一张卡 */

/** 挂载后给一个真任务边界再开测(同 `probeRunner.ts`) */
const MOUNT_SETTLE_MS = 150;
const CANVAS_WAIT_TRIES = 20;
const CANVAS_WAIT_STEP_MS = 50;
/** 一张卡被项目重灌(`'project'`)打断后最多重来几次 */
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAborted = (r: RenderReply): r is RenderAborted => !!r && (r as { aborted?: boolean }).aborted === true;
const isSetTimeAborted = (r: SetTimeReply): r is SetTimeAborted => !!r && (r as { aborted?: boolean }).aborted === true;
const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export interface MeasureJob {
  clipId: string;
  cardId: string;
  frameMode: string;
  canvasHeavy: boolean;
  fps: number;
  lenSec: number;
  durationFrames: number;
  project: Project;
}

/** 缩水项目:一条轨道一个片段,从 0 开始(同 `probeRunner.ts` 的 `shrinkProject`) */
export function shrinkProject(project: Project, track: Project["tracks"][number], clip: Clip): Project {
  return {
    ...project,
    duration: Math.max(1 / Math.max(1, project.fps || 30), clip.end - clip.start),
    media: [],
    filters: undefined,
    cardNodes: undefined,
    tracks: [{ ...track, hidden: false, clips: [{ ...clip, start: 0, end: clip.end - clip.start }] }],
  } as Project;
}

/** 项目里每个 identityKey 取第一个片段做测量任务 */
export function measureJobsOf(project: Project, identityKeys: Record<string, string>, capabilities: ReadonlyMap<string, Record<string, unknown>>): Map<string, MeasureJob> {
  const fps = Math.max(1, project.fps || 30);
  const out = new Map<string, MeasureJob>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const key = identityKeys[clip.id];
      if (!key || out.has(key)) continue;
      const caps = capabilities.get(clip.id) ?? {};
      const lenSec = Math.max(1 / fps, Number(clip.end) - Number(clip.start));
      out.set(key, {
        clipId: clip.id,
        cardId: clip.cardId ?? clip.nodeId ?? "?",
        frameMode: typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
        canvasHeavy: caps.canvasHeavy === true,
        fps,
        lenSec,
        durationFrames: Math.max(1, Math.round(lenSec * fps)),
        project: shrinkProject(project, track, clip),
      });
    }
  }
  return out;
}

async function waitForCanvas(stage: StageRpcClient, clipId: string): Promise<void> {
  for (let i = 0; i < CANVAS_WAIT_TRIES; i++) {
    try {
      const list = await stage.rectsWithBounds({ pixels: "all", clipIds: [clipId] });
      const box = list.find((r) => r.clipId === clipId)?.bounds;
      if (box && box.width > 1 && box.height > 1) break;
    } catch {
      return;
    }
    await sleep(CANVAS_WAIT_STEP_MS);
  }
  await sleep(MOUNT_SETTLE_MS);
}

/**
 * 在(已切成 `back` 的)舞台里测一张卡的活渲单帧耗时:只计时、不生成快照。回 `{ stepMs, samples }`,测不出来回 null;
 * 被项目重灌打断回 `'retry'`。
 */
export async function measureOnce(
  stage: StageRpcClient,
  job: MeasureJob,
  pushProject: (project: Project) => Promise<void>,
  tuning: PipelineTuning,
): Promise<{ stepMs: number; samples: number } | null | "retry"> {
  await pushProject(job.project);
  await stage.setTime(0);
  await sleep(MOUNT_SETTLE_MS);
  if (job.canvasHeavy) await waitForCanvas(stage, job.clipId);
  const steps: number[] = [];
  let kind: "random" | "stepped";
  let totalFrames = job.durationFrames;
  let truncated = false;
  if (job.frameMode === "direct") {
    kind = "random";
    const want = Math.max(8, Math.min(tuning.STEP_MIN_SAMPLES, job.durationFrames));
    const rnd = mulberry32(seedOf(job.cardId));
    const picks = new Set<number>();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, job.durationFrames); i++) picks.add(Math.floor(rnd() * job.durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    for (const n of frames) {
      const r = await stage.setTime(n / job.fps, { probe: true });
      if (isSetTimeAborted(r)) return null;
      steps.push(Number(r.stepMs) || 0);
    }
    totalFrames = frames.length;
  } else {
    kind = "stepped";
    const lastSec = Math.max(0, job.lenSec - 1 / job.fps);
    totalFrames = Math.max(1, Math.round(lastSec * job.fps) + 1);
    const timePass = await stage.render(lastSec, { jump: true, probe: "time", maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES });
    if (isAborted(timePass)) {
      if (timePass.reason === "project" || timePass.reason === "superseded") return "retry";
      if (timePass.reason !== "timeout") return null;
      truncated = true; // 撞封顶:长片段的正常路径,按已推帧算
    }
    for (const s of (timePass as { steps?: number[] }).steps ?? []) steps.push(Number(s) || 0);
  }
  if (!steps.length) return null;
  const summary = summarizeProbe({ kind, steps, inline: [], raster: [], serialize: [], totalFrames, truncated }, tuning);
  return { stepMs: Number(summary.stepMs.toFixed(3)), samples: steps.length };
}

/* ------------------------------------------------------------------ 一轮搜索 */

export interface LowMemorySearchDeps {
  request: Request;
  projectId: string;
  project: Project;
  environment: PageEnvironment;
  identityKeys: Record<string, string>;
  capabilities: ReadonlyMap<string, Record<string, unknown>>;
  /** 这台设备渲染不了的片段(用户卡、图卡):不参加、按重卡 */
  unsupported: (clip: Clip) => boolean;
  /** 唯一那个舞台 */
  stage: () => StageRpcClient | null;
  /** 往这个舞台整份重灌一个项目(`stageBridge.pushProject('front', p, { reset: true })`) */
  pushProject: (project: Project) => Promise<void>;
  /** 测完:切回 `front` 之后调,由调用方把整份项目、时间、抑制与快照重投一遍 */
  restore: () => Promise<void> | void;
  /** 此刻的整份项目(测完重灌用) */
  currentProject: () => Project;
  store: CostStore;
  tuning?: PipelineTuning;
  mode?: "dev" | "build";
}

export interface LowMemorySearchOutcome {
  result: BoundaryResult;
  records: SharedCostRecord[];
  envFingerprint: string;
  /** 参加搜索的卡(identityKey) */
  keys: string[];
  /** 用户卡、图卡(identityKey):按重卡 */
  forcedHeavy: string[];
  /** 判轻的卡(identityKey),交给 `setPlanLowMemoryLight` */
  light: Set<string>;
  elapsedMs: number;
}

/** 项目里要判的卡:参加搜索的与这台设备渲染不了的(都按 identityKey 去重) */
export function keysOf(project: Project, identityKeys: Record<string, string>, unsupported: (clip: Clip) => boolean): { keys: string[]; forcedHeavy: string[] } {
  const keys = new Set<string>();
  const forced = new Set<string>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const key = identityKeys[clip.id];
      if (!key) continue;
      (unsupported(clip) ? forced : keys).add(key);
    }
  }
  for (const k of forced) keys.delete(k);
  return { keys: [...keys].sort(), forcedHeavy: [...forced].sort() };
}

/**
 * 跑一轮界限搜索。取不到记录(没连上、被拒)抛错,由调用方稍后再试;测量中的舞台错误按那张卡跑不动算。
 */
export async function runLowMemorySearch(deps: LowMemorySearchDeps): Promise<LowMemorySearchOutcome> {
  const started = Date.now();
  const tuning = resolveTuning(deps.tuning ?? null);
  const { records, envFingerprint } = await listSharedCosts({ request: deps.request, projectId: deps.projectId, environment: deps.environment });
  const { keys, forcedHeavy } = keysOf(deps.project, deps.identityKeys, deps.unsupported);
  const jobs = measureJobsOf(deps.project, deps.identityKeys, deps.capabilities);
  const fps = Math.max(1, deps.project.fps || 30);
  const withRecords = new Set(records.map((r) => r.identityKey));
  const estimate = maxMeasurements(keys.filter((k) => withRecords.has(k)).length);

  let leased: StageRpcClient | null = null;
  let done = 0;
  const measure = async (key: string): Promise<{ stepMs: number; samples: number } | null> => {
    const job = jobs.get(key);
    const stage = deps.stage();
    if (!job || !stage) return null;
    if (!leased) {
      setState({ measuring: true, done: 0, estimate, card: job.cardId });
      try { await stage.setRole("back", { job: "probe" }); } catch { return null; }
      leased = stage;
    }
    setState({ card: job.cardId, done });
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const r = await measureOnce(stage, job, deps.pushProject, tuning);
        if (r !== "retry") return r;
      }
      return null;
    } catch {
      return null;
    } finally {
      done++;
      setState({ done });
    }
  };

  let result: BoundaryResult;
  try {
    result = await boundarySearch({
      keys, records, budgetMs: budgetOf(fps), measure, store: deps.store, envFingerprint,
      scale: tuning.COST_SCALE, mode: deps.mode ?? "build",
    });
  } finally {
    if (leased) {
      const stage: StageRpcClient = leased;
      try { await stage.setRole("front"); } catch { /* iframe 换了:新的握手会重设角色 */ }
      try { await deps.pushProject(deps.currentProject()); } catch { /* 同上 */ }
      setState({ measuring: false, card: null });
      try { await deps.restore(); } catch { /* 调用方自己兜 */ }
    }
  }
  const light = new Set(result.light);
  for (const k of forcedHeavy) light.delete(k);
  return { result, records, envFingerprint, keys, forcedHeavy, light, elapsedMs: Date.now() - started };
}

/**
 * 搜索做完之后项目又变了(加了卡、改了参数):不再测,按已有的界限判新卡(`classifyWithBoundary`)。回判轻的 identityKey。
 */
export function reclassify(outcome: LowMemorySearchOutcome, project: Project, identityKeys: Record<string, string>, unsupported: (clip: Clip) => boolean): Set<string> {
  const { keys } = keysOf(project, identityKeys, unsupported);
  return classifyWithBoundary(outcome.result, keys, outcome.records).light;
}

/** 测试用 */
export function resetLowMemorySearch(): void {
  state = IDLE;
  listeners.clear();
}
