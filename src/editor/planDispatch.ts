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
import { clipWeight, planPipelines, type PipelinePlan } from "../render/pipelinePlan.mjs";
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
 * 低内存档(c10a 契约第 17 节「全部按重卡」,语义 `product/platforms.md`「面向的平台」的过渡期):不测,所有卡按重卡处理 ——
 * 播放时一律贴预渲染小尺寸,不活渲任何卡。只有在线页面判为低内存档时由 `Preview` 打开;普通档不变。
 */
let allHeavy = false;
/**
 * L4(在线普通档,C10 契约第 6 节、第 18 节第 1 条):分派时每张重卡每拍的固定成本换成实测的换帧成本 `swapMs`
 * (`planPipelines` 的 `opts.deadMs`),与播放时 `beatSwap.mjs` 的 `fitBeatSwaps` 同一个数。null = 桌面的 `DEAD_MS`。
 */
let deadMs: number | null = null;
/** 上一次真的发出去的那份表的序列化结果，用来省掉「没变还发一遍」 */
let sentWire = "";
let scheduled = false;

/** 这一刻算出来的分派表（R5 / 验收探针用） */
export function currentPlan(): PipelinePlan | null {
  return plan;
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
    return;
  }
  const { identityKeys, frameModes } = clipIdentityOf(project);
  plan = planPipelines(project, costs, Math.max(1, project.fps || 30), { tuning, identityKeys, frameModes, ...(allHeavy ? { allHeavy: true } : {}), ...(deadMs !== null ? { deadMs } : {}) });
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

/** 低内存档打开 / 关上「全部按重卡」(c10a 契约第 17 节)。变了才重算重发 */
export function setPlanAllHeavy(on: boolean): void {
  if (allHeavy === !!on) return;
  allHeavy = !!on;
  schedule();
}

/** L4:在线普通档把分派的每拍重卡成本换成实测换帧成本(`null` 回到桌面的 `DEAD_MS`)。变了才重算重发 */
export function setPlanDeadMs(ms: number | null): void {
  const next = ms !== null && Number.isFinite(ms) && ms >= 0 ? ms : null;
  if (next === deadMs) return;
  deadMs = next;
  schedule();
}

/**
 * 这一刻轻管线里活渲的卡每拍占了多少毫秒(C10 契约第 18 节第 1 条的「已占用」):当前位置 `light` 集合里每张卡的
 * `clipWeight(...).w` 之和,口径与 `planPipelines` 的贪心同一份。不在任何位置(没有表、空白处)回 0。
 */
export function lightCostAt(t: number): number {
  if (!plan || !project) return 0;
  const seg = plan.segments.find((s) => t >= s.fromSec && t < s.toSec);
  if (!seg || !seg.light.size) return 0;
  const fps = Math.max(1, project.fps || 30);
  const { identityKeys, frameModes } = clipIdentityOf(project);
  const byKey = new Map(costs.map((r) => [r.identityKey, r]));
  let sum = 0;
  for (const clipId of seg.light) {
    const key = identityKeys[clipId];
    const w = clipWeight(key ? byKey.get(key) : undefined, frameModes[clipId], fps, tuning).w;
    if (Number.isFinite(w)) sum += w;
  }
  return sum;
}

/** 此刻是不是「全部按重卡」 */
export function planAllHeavy(): boolean {
  return allHeavy;
}

/** 测试用 */
export function resetPlanDispatch(): void {
  allHeavy = false;
  deadMs = null;
  project = null;
  costs = [];
  tuning = resolveTuning(null);
  plan = null;
  sentWire = "";
  scheduled = false;
}
