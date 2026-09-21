import type { CardNode } from '../kernel/cardGraph.mjs';
import type { CardCostRecord } from './cardCostKey.mjs';
import type { PipelineTuning, PipelineTuningOverrides } from './pipelineTuning.mjs';

/** 一个位置（相邻两个分段边界之间）的实时判定结果 */
export interface PipelineSegment {
  fromSec: number;
  toSec: number;
  /** 该位置贴死素材的卡 */
  heavy: Set<string>;
  /** 该位置活渲的卡 */
  light: Set<string>;
}

export interface PipelinePlan {
  segments: PipelineSegment[];
  /** 任一位置判重的卡的并集（pinned 渲染 9）：进预渲染管线的静态集合，整段预渲染 */
  prerenderSet: Set<string>;
}

/** 片段 → 成本记录的索引。Map 和普通对象都收。 */
export type ClipIndex<V> = Readonly<Record<string, V>> | ReadonlyMap<string, V>;

export interface PlanPipelinesOptions {
  /** 一个重卡每拍贴一帧死素材的固定成本（ms）。缺省 `DEAD_MS`；只有 L4 换成实测换帧成本。 */
  deadMs?: number;
  /** 可调系数的覆盖值，或已经 `resolveTuning` 过的一份。两端必须一样。 */
  tuning?: PipelineTuning | PipelineTuningOverrides;
  /** clipId → `cardCostKey` 的结果（见 `clipCostIndex`）。缺的片段按「没有记录」兜底。 */
  identityKeys?: ClipIndex<string>;
  /** clipId → 声明的帧模式。只在这张卡没有成本记录时用：`direct` 视为轻，其余视为重。 */
  frameModes?: ClipIndex<string>;
}

export const DEAD_MS: number;
export const CATCHUP_STEPS_PER_BEAT: number;
export function maxCatchUpBeats(fps: number): number;
/** pinned 渲染 3 的预算：`1000 / fps × 70%` */
export function budgetOf(fps: number): number;

/** 一张卡走的档位。`pinned` 的三档（`capped` / `over-catchup` / `declared-heavy`）每个位置都判重。 */
export type PipelineTier =
  | 'declared-light' | 'declared-heavy'
  | 'capped' | 'over-catchup'
  | 'direct' | 'seek' | 'catchup-a' | 'catchup-b';

export interface ClipWeight {
  /** 每个位置都判重、不参加贪心 */
  pinned: boolean;
  /** 每拍权重（`pinned` 时是 Infinity） */
  w: number;
  tier: PipelineTier;
}

/** 一张卡的每拍权重和档位。导出只为诊断和单测，`planPipelines` 内部用同一份。 */
export function clipWeight(
  record: CardCostRecord | null | undefined,
  frameMode: string | undefined,
  fps: number,
  tuning?: PipelineTuning | PipelineTuningOverrides,
): ClipWeight;

export function planPipelines(
  project: any,
  costs: readonly CardCostRecord[] | null | undefined,
  fps: number,
  opts?: PlanPipelinesOptions,
): PipelinePlan;

export function pipelineAt(plan: PipelinePlan | null | undefined, clipId: string, tSec: number): 'light' | 'heavy';

export function clipCostIndex(
  project: any,
  graph: { nodes?: CardNode[] } | null | undefined,
  sourceVersionOf?: (node: CardNode) => string | null,
): { identityKeys: Record<string, string>; frameModes: Record<string, string> };
