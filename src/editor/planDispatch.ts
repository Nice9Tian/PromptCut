/**
 * K2 的分派表下发（E0 的 `setPlan`）。
 *
 * `costs` / 项目 / `tuning` 任一变了，父页就用 `planPipelines`（配 `clipCostIndex`）重算一张表，
 * 把 `{ plan, costs }` 发给 `front`。**集合在线上序列化成数组**（`wirePlan.ts`），
 * 舞台收到后回填成 `Set` 并提供 `pipelineAt` 查询。
 *
 * **两端不交换表，只同步 `costs`**（K2 末条）：预渲染进程用同一份 `planPipelines`、同一份
 * `costs` 和同一份 `tuning` 自己算，算出来逐字段相同。这里发给舞台是因为**舞台不拉 `costs`**
 * （它跨源、只经 RPC 说话），不是因为两端要对表。
 *
 * # 角色转正时补发
 *
 * K5 (5) / K3(b) (5)：`setRole('front')` 之后父页要在同一批里**先**发一次 `setPlan`
 * —— 新 `front` 作为 `back` 时没有表。那一条就是 `sendPlanTo('front')`，R5 直接调它。
 *
 * # 谁来喂它
 *
 * - 项目：`ProbeGate` 在 effect 里 `setPlanProject(project)`；
 * - `costs` / `tuning`：`probeRunner` 每轮开头拉到的那一份 + 每写完一条记录顺手合并一条
 *   （再 GET 一次等于每张卡多一次往返，而我们手里本来就有这条记录）。
 */
import type { Project } from "../kernel/project";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { planPipelines, type PipelinePlan } from "../render/pipelinePlan.mjs";
import { resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import type { StageRole } from "../render/stageRpc";
import { wirePlan } from "../render/wirePlan";
import { clipIdentityOf } from "./costIdentity";
import { frontStage, backStage } from "./stageBridge";

let project: Project | null = null;
let costs: CardCostRecord[] = [];
let tuning: PipelineTuning = resolveTuning(null);
let plan: PipelinePlan | null = null;
/**
 * 低内存档(语义 `product/platforms.md`「面向的平台」;只有在线页面判为低内存档时由 `Preview` 打开,普通档不变)。两张表:
 * - **显示用的表**(`currentPlan`,发给舞台、`snapshotFeed` 按它抑制和选帧):每张卡在每个位置都判重 ——
 *   低内存档播放时只看预渲染小尺寸,不活渲任何卡,判轻的卡也一样(没有产物就是占位,停下时画出);
 * - **判定的表**(`judgedPlan`):轻重按界限搜索的结果(`lowMemoryLight`,`src/editor/lowMemorySearch.ts`)。
 *   补渲只对它判重、又缺产物的层发(`lowMemoryBackfill.ts`);导出时判轻的卡本机逐帧渲、判重的卡用预渲染原尺寸。
 *   搜索完成之前 `lowMemoryLight` 是 null:没有结果,补渲不发,判定的表里全部按重卡。
 * C10a 的过渡做法(判定也全部按重卡)随之退出(契约 `docs/plan/c10-contract.md` 第 3 节)。
 */
let lowMemory = false;
/** 界限搜索判轻的卡的 identityKey;null = 还没有结果 */
let lowMemoryLight: ReadonlySet<string> | null = null;
let judged: PipelinePlan | null = null;
/** 上一次真的发出去的那份表的序列化结果，用来省掉「没变还发一遍」 */
let sentWire = "";
let scheduled = false;

/** 这一刻算出来的分派表（R5 / 验收探针用）。低内存档里是显示用的那一张（全部判重），判定看 `judgedPlan` */
export function currentPlan(): PipelinePlan | null {
  return plan;
}

/** 轻重判定的表：普通档与 `currentPlan` 是同一张；低内存档按界限搜索的结果（还没有结果时全部判重） */
export function judgedPlan(): PipelinePlan | null {
  return judged;
}

export function currentCosts(): CardCostRecord[] {
  return costs;
}

/** 这一刻生效的可调系数（舞台经 `setPlan` 拿的是同一份，K3 / K5 分档要一致） */
export function currentTuning(): PipelineTuning {
  return tuning;
}

function recompute(): void {
  if (!project) {
    plan = null;
    judged = null;
    return;
  }
  const { identityKeys, frameModes } = clipIdentityOf(project);
  const fps = Math.max(1, project.fps || 30);
  plan = planPipelines(project, costs, fps, { tuning, identityKeys, frameModes, ...(lowMemory ? { allHeavy: true } : {}) });
  judged = lowMemory ? planPipelines(project, costs, fps, { tuning, identityKeys, frameModes, lowMemoryLight: lowMemoryLight ?? [] }) : plan;
}

/**
 * 把表发给某个角色。**角色转正时补发**走的就是它（K5 (5) / K3(b) (5)）。
 * 返回有没有真的发出去（舞台还没就绪、或者表没变时回 false）。
 */
export async function sendPlanTo(role: StageRole, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!plan) return false;
  const stage = role === "front" ? frontStage() : backStage();
  if (!stage || stage.disposed) return false;
  // clipId → identityKey / frameMode 一起带过去:舞台要按 clipId 查 vtOk / seekOk（K3 / K5）
  const wire = wirePlan(plan, clipIdentityOf(project), tuning);
  const serialized = JSON.stringify(wire);
  // 补发(force)一律发:新 front 作为 back 时手里没有表,「和上次发的一样」对它不成立
  if (!opts.force && role === "front" && serialized === sentWire) return false;
  try {
    await stage.setPlan({ plan: wire, costs });
    if (role === "front") sentWire = serialized;
    return true;
  } catch {
    // iframe 正在换:下一次变动会重发,角色转正那一条由 R5 自己再调一次
    return false;
  }
}

/** 攒一拍再算再发:一轮探针里连着写 20 条记录,不该算 20 次表 */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    recompute();
    void sendPlanTo("front");
  });
}

/** 项目变了（`ProbeGate` 的 effect 里叫）。引用没变就什么都不做 */
export function setPlanProject(next: Project | null): void {
  if (next === project) return;
  project = next;
  schedule();
}

/** 整份 `costs` / `tuning` 换了（探针每轮开头 `GET /api/data/costs` 拿到的那一份） */
export function setPlanCosts(nextCosts: CardCostRecord[], nextTuning: PipelineTuning): void {
  costs = [...nextCosts];
  tuning = resolveTuning(nextTuning);
  schedule();
}

/**
 * 刚写进去的几条记录，就地并进手里这份（按 `(identityKey, device)` 去重，和
 * `costs-store.mjs` 的 upsert 同一个键）。省掉每张卡一次 GET。
 */
export function mergePlanCosts(records: readonly CardCostRecord[]): void {
  if (!records.length) return;
  const keyOf = (r: CardCostRecord) => `${r.identityKey} ${r.device}`;
  const byKey = new Map(costs.map((r) => [keyOf(r), r]));
  for (const r of records) byKey.set(keyOf(r), r);
  costs = [...byKey.values()];
  schedule();
}

/** 低内存档打开 / 关上。变了才重算重发;关上时丢掉搜索结果 */
export function setPlanLowMemory(on: boolean): void {
  if (lowMemory === !!on) return;
  lowMemory = !!on;
  if (!lowMemory) lowMemoryLight = null;
  schedule();
}

/** 此刻是不是低内存档(显示用的表全部判重) */
export function planLowMemory(): boolean {
  return lowMemory;
}

/**
 * 界限搜索的结果:判轻的卡的 identityKey(`null` = 撤掉结果,判定回到全部按重)。同一份集合不重算。
 * 表同步重算(不攒拍):补渲、导出拿到结果后马上就要用判定的表。
 */
export function setPlanLowMemoryLight(keys: Iterable<string> | null): void {
  const next = keys === null ? null : new Set(keys);
  const same = next === null ? lowMemoryLight === null
    : lowMemoryLight !== null && next.size === lowMemoryLight.size && [...next].every((k) => lowMemoryLight!.has(k));
  if (same) return;
  lowMemoryLight = next;
  recompute();
  schedule();
}

/** 低内存档的轻重判定有没有结果(界限搜索做完了);普通档恒为 true */
export function lowMemoryJudged(): boolean {
  return !lowMemory || lowMemoryLight !== null;
}

/** 界限搜索判轻的卡(诊断与探针用) */
export function planLowMemoryLight(): ReadonlySet<string> | null {
  return lowMemoryLight;
}

/** 测试用 */
export function resetPlanDispatch(): void {
  lowMemory = false;
  lowMemoryLight = null;
  judged = null;
  project = null;
  costs = [];
  tuning = resolveTuning(null);
  plan = null;
  sentWire = "";
  scheduled = false;
}
