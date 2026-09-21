/**
 * K1 的**常驻探针**（父页一侧的驱动）。
 *
 * 打开项目时在加载遮罩（`ProbeGate`）下把所有活跃卡逐张测完才进编辑（pinned 渲染 5）；
 * 之后新添加的卡、或 `cardCostKey` 变了的卡随即在后台舞台补测，那时不再挡界面。
 *
 * 离线版是 `scripts/probe-card-costs.mjs`，做的是同一件事、同一套数：
 * `device` 串（`src/render/costDevice.mjs`）和统计口径（`src/render/probeSummary.mjs`）
 * 都是同一份代码，两条路测出来的记录因此互相认得、可以并排比。
 *
 * # 一张卡怎么测（K1）
 *
 * 1. `pushProject('back', 缩水项目, { reset: true })` —— **一次只测一个片段**：`render` 没有
 *    clipId，不缩水的话舞台会把此刻全部活跃卡一起推，测出来的数被污染还不报错。
 *    形状同 `FrameScene` 的 `legacyTimeline`：一条轨道一个 clip。
 *    必须走 `pushProject` 而不是直接 `setProject` —— 后者绕过基线，之后的 `syncProject`
 *    会因为「和基线比没变」静默不发，`back` 就一直留在缩水项目上（E0 点名的坑）。
 * 2. `stepped` 卡三趟：
 *    - **计时趟** `render(最后一帧, { jump: true, probe: 'time', maxCatchUp: Infinity })`，
 *      拿逐帧活渲耗时 `steps`；**撞封顶回的 `{ aborted: true, reason: 'timeout' }` 是长片段的
 *      正常路径，不是失败**（R4a 报告 §8 第 8 条），按已推帧外推 `catchUpMs`；
 *    - **快照趟** `render(…, { probe: 'snapshot' })`，拿逐帧的三段生成快照耗时
 *      （回包的 `snapshotSteps`，一次往返；离线脚本为了同一批数逐帧发了 40 次往返，
 *      那在加载遮罩下太慢）。它仍受一拍预算约束，截断不影响任何判定；
 *    - **两趟布尔探针** `render(…, { probe: 'booleans' })`：`vtOk` / `seekOk` / `seekMs`
 *      整趟在舞台里跑（要 `pinner.syncIn` 钉子树虚拟时间，父页够不到）。
 * 3. `direct` 卡：按 cardId 播种随机抽本地帧，各发一次 `setTime(t, { probe: true })`，
 *    抽满 `STEP_MIN_SAMPLES`（8 不够就补抽，否则走不到百分位），`catchUpMs = 0`。
 * 4. 父页补齐 `device` / `mode` / `measuredAt` / `demoted: false` 后**整条 PUT**
 *    （`costs-store` 是整条替换，`validRecord` 要 `identityKey` + `device`）。
 *    `demoted: false` 要**显式写**：`STICKY_FLAGS` 是「没带就沿用旧值」，不写的话 K6 写过一次
 *    `true` 之后每次重测都会被贴回 `true`，卡就永久判重了（3.3）。
 *
 * # 跳过已经测过的
 *
 * 同一 `(identityKey, device)` 已有记录**且 `demoted !== true`** 的整张跳过
 * （pinned 渲染 5 末句：身份没变就直接复用）。`costs` 全命中时一张都不测，遮罩一帧都不出现。
 *
 * # 排队与掐断
 *
 * 每张卡的整套活经 `stageJobs` 的单飞队列排一次，档位是最低的 `'probe'` ——
 * 补跑（K5）和页面侧测量（D4）进来时探针让路，`ctx.signal` 一响就收摊，
 * 这张卡从头重排（E0：「`settled` 或补跑中止后……探针从当前这张卡的头重排」）。
 *
 * `render` 中止回包按 E0 的五条规矩走（`renderAbortAction`）：
 *   `'timeout'` 忽略（正常路径）、`'project'` 重发（先重发缩水项目，最多 3 次）、
 *   `'superseded'` 丢弃、`'detached'` 换客户端重来、`'role'` 当错误。
 *
 * **项目变了按新项目重排队列**：`syncProbeRun(project)` 递增代数，正在跑的那一张测完就退出，
 * 重新拉一次 `costs`、重新算 `identityKey`、重新排。新添加或 `cardCostKey` 变了的卡自然补测。
 */
import type { Project } from "../kernel/project";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { allCards, getCard, userCardSources } from "../kernel/registry";
import { cardSourceVersion } from "../render/cardSourceVersion.mjs";
import { builtinCardSourceFiles } from "../render/cardSourceFiles.mjs";
import { costDeviceString, readGpuRenderer, resolveGlRoute } from "../render/costDevice.mjs";
import { clipCostIndex, budgetOf } from "../render/pipelinePlan.mjs";
import { resolveTuning, PROBE_MAX_FRAMES, type PipelineTuning } from "../render/pipelineTuning.mjs";
import { summarizeProbe } from "../render/probeSummary.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import type { RenderAborted, RenderReply, SetTimeAborted, SetTimeReply, SnapshotCost, StageEvent, StageRpcClient } from "../render/stageRpc";
import { mirrorKey } from "../render/dataMirror";
import { onStageEvent, pushProject, stageCapabilities, whenStageReady } from "./stageBridge";
import { MAX_PROJECT_RESENDS, currentBackJob, renderAbortAction, runBackJob } from "./stageJobs";

/* ------------------------------------------------------------------ 进度 */

export interface ProbeProgress {
  /** 这一轮还在测 */
  running: boolean;
  /**
   * 这一轮**要不要挡住界面**。只有「打开项目的第一轮」是 true（pinned 渲染 5）；
   * 之后新添加的卡在后台补测，不再挡（K1：「兜底分派只用于『新卡还没测完』那几秒」）。
   */
  blocking: boolean;
  /** 这一轮要测几张 */
  total: number;
  /** 测完几张 */
  done: number;
  /** 正在测的那张卡的 id（遮罩上的文案用） */
  card: string | null;
  /** 测不出来的（诊断用，不挡流程） */
  failed: string[];
}

const IDLE: ProbeProgress = { running: false, blocking: true, total: 0, done: 0, card: null, failed: [] };

let progress: ProbeProgress = IDLE;
const listeners = new Set<(p: ProbeProgress) => void>();

export function probeProgress(): ProbeProgress {
  return progress;
}

export function onProbeProgress(cb: (p: ProbeProgress) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function setProgress(patch: Partial<ProbeProgress>): void {
  progress = { ...progress, ...patch };
  for (const cb of listeners) cb(progress);
}

/* ------------------------------------------------------------------ 常量 */

/** 挂载那一下给一个真任务边界再开测：React 要建树、Motion 要解析关键帧 */
const MOUNT_SETTLE_MS = 150;
/** canvas 卡（three.js / tsParticles）还要等它异步把画布装起来，不然量的是一个空壳 */
const CANVAS_WAIT_TRIES = 20;
const CANVAS_WAIT_STEP_MS = 50;
/** 一张卡最多重来几次（`'project'` 重发的上限 + 一次换客户端） */
const MAX_ATTEMPTS = MAX_PROJECT_RESENDS + 1;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 身份与设备 */

/** 源码版本，照 `ExportView.tsx` 的 `__pcCardPlan` 那份算法 */
function sourceVersionsOf(): Record<string, string> {
  const user = userCardSources();
  const out: Record<string, string> = {};
  for (const card of allCards()) {
    const file = user.fileOf[card.id];
    out[card.id] = file && user.files[file] !== undefined
      ? `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`
      : `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
  }
  return out;
}

/** `import.meta.env.DEV`：桌面版跑的就是 vite dev server，分派用当前运行模式的记录（3.1） */
const RUN_MODE: "dev" | "build" = import.meta.env.DEV ? "dev" : "build";

/**
 * 本机身份（J4）。`lowMemory` / `offscreenGl` 取**舞台握手报上来的那一份** ——
 * 离线探针拿的也是它，主文档自己再探一遍会是第二份实现、会走偏。
 */
function deviceStringOf(tuning: PipelineTuning): string {
  const caps = stageCapabilities("back");
  const lowMemory = !!caps?.lowMemory;
  return costDeviceString({
    ua: navigator.userAgent,
    renderer: readGpuRenderer(document),
    lowMemory,
    offscreenGl: !!caps?.offscreenGl,
    glRoute: resolveGlRoute(null, lowMemory),
    mode: RUN_MODE,
    tuning,
  });
}

/* ------------------------------------------------------------------ 要测哪些卡 */

interface ProbeJob {
  clipId: string;
  cardId: string;
  identityKey: string;
  /** 声明的帧模式：`direct` 抽样，其余推帧 */
  frameMode: string;
  canvasHeavy: boolean;
  /** 审阅表的轴三。只有 `independent` 的卡才把探针帧存成预渲染素材（K1 末句） */
  independent: boolean;
  fps: number;
  lenSec: number;
  durationFrames: number;
  /** 缩水项目：一条轨道一个 clip，形状同 `FrameScene` 的 `legacyTimeline` */
  project: Project;
}

/** 缩水项目（K1「一次只测一个片段」） */
function shrinkProject(project: Project, track: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]): Project {
  return {
    ...project,
    duration: Math.max(1 / Math.max(1, project.fps || 30), clip.end - clip.start),
    media: [],
    filters: undefined,
    cardNodes: undefined,
    tracks: [{ ...track, hidden: false, clips: [{ ...clip, start: 0, end: clip.end - clip.start }] }],
  } as Project;
}

function planJobs(project: Project, costs: CardCostRecord[], device: string): ProbeJob[] {
  let graph;
  try {
    graph = projectCardGraph(project, getCard);
  } catch {
    // 一张坏卡（悬空输入）不该让整轮探针跑不起来：没有图就没有身份键，这一轮不测
    return [];
  }
  const versions = sourceVersionsOf();
  const { identityKeys } = clipCostIndex(project, graph, (node) => versions[(node as { cardId?: string }).cardId ?? ""] ?? null);
  const capsOf = new Map<string, Record<string, unknown>>();
  for (const node of graph.nodes ?? []) {
    if (typeof node.clipId === "string" && !capsOf.has(node.clipId)) {
      capsOf.set(node.clipId, (node.capabilities ?? {}) as Record<string, unknown>);
    }
  }

  // 已有记录且 demoted !== true 的整张跳过（pinned 渲染 5 末句）
  const known = new Set(costs.filter((r) => r.device === device && r.demoted !== true).map((r) => r.identityKey));
  const fps = Math.max(1, project.fps || 30);
  const jobs: ProbeJob[] = [];
  const seen = new Set<string>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const identityKey = identityKeys[clip.id];
      if (!identityKey) continue;
      // 同一张卡的多个片段身份相同，只测一次
      if (seen.has(identityKey) || known.has(identityKey)) continue;
      seen.add(identityKey);
      const caps = capsOf.get(clip.id) ?? {};
      const lenSec = Math.max(1 / fps, Number(clip.end) - Number(clip.start));
      jobs.push({
        clipId: clip.id,
        cardId: clip.cardId ?? clip.nodeId ?? "?",
        identityKey,
        frameMode: typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
        canvasHeavy: caps.canvasHeavy === true,
        independent: caps.compositing === "independent",
        fps,
        lenSec,
        durationFrames: Math.max(1, Math.round(lenSec * fps)),
        project: shrinkProject(project, track, clip),
      });
    }
  }
  return jobs;
}

/* ------------------------------------------------------------------ 端点 */

async function getCosts(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }> {
  try {
    const res = await fetch("/api/data/costs");
    if (!res.ok) return { costs: [], tuning: resolveTuning(null) };
    const data = await res.json();
    return {
      costs: Array.isArray(data?.costs) ? (data.costs as CardCostRecord[]) : [],
      tuning: resolveTuning(data?.tuning),
    };
  } catch {
    // 插件没挂上 / 离线：这一轮用缺省系数，不跳过任何卡（测完 PUT 也会失败，但不该因此卡住界面）
    return { costs: [], tuning: resolveTuning(null) };
  }
}

async function putCosts(records: CardCostRecord[]): Promise<boolean> {
  try {
    const res = await fetch("/api/data/costs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------------------------------- 探针帧存成预渲染素材（TODO(R6)：端点还没合进来） */

/** 端点回过一次 404 就不再试：`PUT /api/frames/snapshot` 由 R6 的 Agent 在做 */
let snapshotEndpointMissing = false;

/**
 * 快照趟里后台舞台 post 的 `probe-frame`，父页转发到 `PUT /api/frames/snapshot`
 * （**TODO(R6)**：这个端点由 R6 在做，还没合进来 —— 404 时静默丢弃、不报错）。
 *
 * **只转发审阅表 `independent` 的卡**（K1 末句）：`sourceDependent`（链上的源在缩水项目里没有）
 * 和 `belowDependent`（没有下层背景）在缩水项目里都拿不到输入，探针只计时、不存帧，
 * 它们的本地档仍由 C2 的整场景路产。
 *
 * `kind` / `key` 由预渲染进程按镜像里的项目用 A3a 的规则算，父页只带
 * `{ session, localRev, clipId, localFrame, html }`。
 */
async function forwardProbeFrame(e: Extract<StageEvent, { type: "probe-frame" }>): Promise<void> {
  if (snapshotEndpointMissing) return;
  const key = mirrorKey();
  if (!key) return;
  try {
    const res = await fetch("/api/frames/snapshot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: key.session, localRev: key.localRev, clipId: e.clipId, localFrame: e.localFrame, html: e.html }),
    });
    if (res.status === 404) snapshotEndpointMissing = true;
  } catch {
    snapshotEndpointMissing = true;
  }
}

/* ------------------------------------------------------------------ 测一张卡 */

const isAborted = (r: RenderReply): r is RenderAborted => !!r && (r as { aborted?: boolean }).aborted === true;
/** 带 `probe` 的 `setTime` 只会被角色闸门拒（`{ aborted: true, reason: 'role' }`） */
const isSetTimeAborted = (r: SetTimeReply): r is SetTimeAborted => !!r && (r as { aborted?: boolean }).aborted === true;

type Attempt =
  | { kind: "ok"; record: CardCostRecord }
  /** 这张卡从头重排（`'project'` / `'detached'` / 更急的活抢了队） */
  | { kind: "retry" }
  /** 这一轮别再试了（`'role'` / 抛错） */
  | { kind: "fail" };

/** 按 cardId 播种的随机数，和离线探针同一份实现 —— 同一台机器上复跑抽到同一批帧、可比 */
const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * canvas 卡把画布装起来了没有。**跨源摸不到 iframe 的 document**（离线探针那一侧是同源、
 * 直接查 `[data-pc-clip] canvas`），所以改问 `rectsWithBounds({ pixels: 'all' })`：
 * 它会让舞台读一次画布像素算实体框，框出来了就说明画布真画上了东西。
 */
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

async function probeCardOnce(
  job: ProbeJob,
  stage: StageRpcClient,
  signal: AbortSignal,
  tuning: PipelineTuning,
  device: string,
  stale: () => boolean,
): Promise<Attempt> {
  /** 中止回包按 E0 的五条规矩翻译成「这张卡怎么办」 */
  const onAbort = (r: RenderAborted): Attempt | null => {
    switch (renderAbortAction(r.reason, currentBackJob())) {
      case "ignore": return null;            // 'timeout'：长片段的正常路径，不是失败
      case "resend": return { kind: "retry" };
      case "rebind": return { kind: "retry" };
      case "drop": return { kind: "retry" };
      case "error": return { kind: "fail" };
    }
  };

  // 一次只测一个片段：先换缩水项目，再 render（顺序反了会在全量项目上把全部活跃卡一起推）
  await pushProject("back", job.project, { reset: true });
  if (stale() || signal.aborted) return { kind: "retry" };
  await stage.setTime(0);
  await sleep(MOUNT_SETTLE_MS);
  if (job.canvasHeavy) await waitForCanvas(stage, job.clipId);
  if (stale() || signal.aborted) return { kind: "retry" };

  const steps: number[] = [];
  const inline: number[] = [];
  const raster: number[] = [];
  const serialize: number[] = [];
  let kind: "random" | "stepped";
  let totalFrames = job.durationFrames;
  let truncated = false;
  let booleans: { vtOk?: boolean; seekOk?: boolean; seekMs?: number | null } = {};

  if (job.frameMode === "direct") {
    kind = "random";
    /*
     * 固定随机抽本地帧，**抽满 STEP_MIN_SAMPLES**（K1：8 次不够就补抽）——
     * 不补的话 8 个样本走不到百分位，`robustStep` 只好退回取最大。
     */
    const want = Math.max(8, Math.min(tuning.STEP_MIN_SAMPLES, job.durationFrames));
    const rnd = mulberry32(seedOf(job.cardId));
    const picks = new Set<number>();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, job.durationFrames); i++) picks.add(Math.floor(rnd() * job.durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    for (const n of frames) {
      if (stale() || signal.aborted) return { kind: "retry" };
      const r = await stage.setTime(n / job.fps, { probe: true });
      if (isSetTimeAborted(r)) return { kind: "fail" };   // 只会是 'role'：角色闸门，重发也还是同一个角色
      // stepMs 是舞台在等那一次真 rAF **之前**取的，所以已经不含垂直同步（3.8 末条）
      steps.push(Number(r.stepMs) || 0);
      inline.push(Number(r.snapshot?.inlineMs) || 0);
      raster.push(Number(r.snapshot?.rasterMs) || 0);
      serialize.push(Number(r.snapshot?.serializeMs) || 0);
    }
    totalFrames = frames.length;
  } else {
    kind = "stepped";
    const lastSec = Math.max(0, job.lenSec - 1 / job.fps);
    totalFrames = Math.max(1, Math.round(lastSec * job.fps) + 1);

    /* ---- 计时趟：只推进、不生成快照 ---- */
    const timePass = await stage.render(lastSec, { jump: true, probe: "time", maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES });
    if (isAborted(timePass)) {
      const out = onAbort(timePass);
      if (out) return out;
      truncated = true;                        // 'timeout'：撞封顶，正常路径
    }
    for (const s of (timePass as { steps?: number[] }).steps ?? []) steps.push(Number(s) || 0);
    if (stale() || signal.aborted) return { kind: "retry" };

    /* ---- 快照趟：每帧生成一次快照并 post probe-frame；仍受一拍预算约束 ---- */
    const snapPass = await stage.render(lastSec, { jump: true, probe: "snapshot", maxCatchUp: Infinity });
    if (isAborted(snapPass)) {
      const out = onAbort(snapPass);
      if (out) return out;
    }
    for (const s of ((snapPass as { snapshotSteps?: SnapshotCost[] }).snapshotSteps ?? [])) {
      inline.push(Number(s.inlineMs) || 0);
      raster.push(Number(s.rasterMs) || 0);
      serialize.push(Number(s.serializeMs) || 0);
    }
    if (stale() || signal.aborted) return { kind: "retry" };

    /* ---- 两趟布尔探针：整趟在舞台里跑（K1） ---- */
    const boolPass = await stage.render(lastSec, { jump: true, probe: "booleans" });
    if (isAborted(boolPass)) {
      const out = onAbort(boolPass);
      if (out) return out;
    } else if (boolPass.booleans) {
      booleans = boolPass.booleans;
    }
  }

  const summary = summarizeProbe({ kind, steps, inline, raster, serialize, totalFrames, truncated }, tuning);
  const capped = summary.stepMs * tuning.COST_SCALE > budgetOf(job.fps);
  const round = (x: number) => Number(x.toFixed(3));

  return {
    kind: "ok",
    record: {
      identityKey: job.identityKey,
      fps: job.fps,
      // 五个数分开报（3.8 + K1）；旧的 frameMs 已删，不留兼容
      stepMs: round(summary.stepMs),
      stepMaxMs: round(summary.stepMaxMs),
      inlineMs: round(summary.inlineMs),
      rasterMs: round(summary.rasterMs),
      serializeMs: round(summary.serializeMs),
      catchUpMs: round(summary.catchUpMs),
      ...(capped ? { capped: true } : {}),
      kind,
      ...(typeof booleans.vtOk === "boolean" ? { vtOk: booleans.vtOk } : {}),
      ...(typeof booleans.seekOk === "boolean" ? { seekOk: booleans.seekOk } : {}),
      ...(booleans.seekMs !== undefined ? { seekMs: booleans.seekMs === null ? null : round(booleans.seekMs) } : {}),
      mode: RUN_MODE,
      // **显式写 false**（3.3）：STICKY_FLAGS 是「没带就沿用旧值」，不写的话 K6 写过一次 true
      // 之后每次重测都会被贴回 true，这张卡就永久判重了。pinnedHeavy 留给人工钉死，这里不写。
      demoted: false,
      measuredAt: Date.now(),
      device,
    },
  };
}

/* ------------------------------------------------------------------ 主循环 */

let currentProject: Project | null = null;
/** 项目变了就 +1：正在跑的那一轮据此收摊、按新项目重排 */
let generation = 0;
let looping = false;
/** 「打开项目的第一轮」过去了没有 —— 之后的补测不再挡界面 */
let firstPassDone = false;

const hasCardClip = (p: Project | null): boolean =>
  !!p?.tracks?.some((tr) => tr.clips?.some((c) => !!c.cardId || !!c.nodeId));

/**
 * 项目变了叫一次（`ProbeGate` 在 effect 里叫）。同一个对象引用不重排 ——
 * store 是不可变更新，引用没变就什么都没变。
 */
export function syncProbeRun(project: Project | null): void {
  if (project === currentProject) return;
  currentProject = project;
  generation++;
  if (!looping) void runLoop();
}

async function runLoop(): Promise<void> {
  looping = true;
  try {
    // E1：后台舞台就绪了才开工（不去够 Preview 内部的 stageReady）
    await whenStageReady("back");
    for (;;) {
      const gen = generation;
      const project = currentProject;
      if (!project) break;

      const { costs, tuning } = await getCosts();
      const device = deviceStringOf(tuning);
      if (gen !== generation) continue;          // 拉 costs 期间项目又变了：重排

      const jobs = planJobs(project, costs, device);
      setProgress({ running: jobs.length > 0, blocking: !firstPassDone, total: jobs.length, done: 0, card: jobs[0]?.cardId ?? null, failed: [] });

      const failed: string[] = [];
      let done = 0;
      for (const job of jobs) {
        if (gen !== generation) break;
        setProgress({ card: job.cardId, done });
        const record = await probeCard(job, tuning, device, () => gen !== generation);
        if (gen !== generation) break;
        if (record) await putCosts([record]);
        else failed.push(job.cardId);
        done++;
        setProgress({ done, failed: [...failed] });
      }

      if (gen !== generation) continue;          // 中途换了项目：从头再排一轮
      // 这一轮走完了。项目里确实有卡片段时才算「打开项目的第一轮」过去了 ——
      // 空项目 / 还没加载完时那一轮不算，否则真项目到位时遮罩就不出现了。
      if (hasCardClip(project)) firstPassDone = true;
      setProgress({ running: false, card: null });
      if (gen === generation) break;
    }
  } catch (err) {
    // 探针挂了不能把编辑器挡在遮罩后面：记一条诊断，放行
    console.error("[probeRunner] 探针这一轮出错", err);
    setProgress({ running: false, card: null });
    firstPassDone = true;
  } finally {
    looping = false;
    // 收摊期间又换了项目：接着跑下一轮
    if (generation !== 0 && currentProject && progress.running) void runLoop();
  }
}

/** 一张卡：排进单飞队列，按 E0 的规矩最多重来几次 */
async function probeCard(job: ProbeJob, tuning: PipelineTuning, device: string, stale: () => boolean): Promise<CardCostRecord | null> {
  // 探针帧存成预渲染素材：只有审阅表 independent 的卡存（K1 末句）
  const off = job.independent
    ? onStageEvent((e) => { if (e.type === "probe-frame") void forwardProbeFrame(e); })
    : () => {};
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (stale()) return null;
      let out: Attempt;
      try {
        out = await runBackJob("probe", (ctx) => probeCardOnce(job, ctx.stage, ctx.signal, tuning, device, stale));
      } catch {
        // iframe 正在换 / RPC 抛了：换一次客户端再来
        await whenStageReady("back").catch(() => undefined);
        continue;
      }
      if (out.kind === "ok") return out.record;
      if (out.kind === "fail") return null;
    }
    return null;
  } finally {
    off();
  }
}

/** 测试用：把驱动恢复成刚加载的样子 */
export function resetProbeRunner(): void {
  currentProject = null;
  generation = 0;
  firstPassDone = false;
  snapshotEndpointMissing = false;
  progress = IDLE;
  listeners.clear();
}
