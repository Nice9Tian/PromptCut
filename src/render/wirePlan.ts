/**
 * `setPlan` 在线上的形状（E0 / K2）：**集合序列化成数组**。
 *
 * `planPipelines` 回的 `PipelinePlan` 里 `heavy` / `light` / `prerenderSet` 都是 `Set`。
 * 结构化克隆确实搬得动 `Set`，但 RPC 这一面要的是「可结构化克隆**且**换个宿主还认得出来」
 * 的最小形状（E0：协议里不放任何依赖同源的东西），而且将来 L1 的在线浏览器模式会把同一份
 * 表经 JSON 发给 Worker / 云端 —— `Set` 过不了 `JSON.stringify`。所以线上一律数组，
 * 舞台收到之后自己回填成 `Set`，消费侧（K3 / K5，R5）照常用 `pipelineAt`。
 *
 * 两个方向都在这里，父页和舞台各 import 一半，省得两处各写一遍序列化顺序。
 * **数组顺序原样保留**：`planPipelines` 建集合时就是从排好序的数组建的（R4a 报告 §2），
 * 这里 `[...set]` 的迭代顺序因此是确定的，两端序列化出来的 JSON 逐字节相同。
 */
import type { PipelinePlan } from "./pipelinePlan.mjs";
import type { CardCostRecord } from "./cardCostKey.mjs";

/** 线上的分段：集合换成数组 */
export interface WireSegment {
  fromSec: number;
  toSec: number;
  heavy: string[];
  light: string[];
}

export interface WirePlan {
  segments: WireSegment[];
  prerenderSet: string[];
}

/** 舞台手里的那一份：回填成 `Set` 之后就是 `pipelineAt` 认的形状，外加原始 `costs` */
export interface StagePlan {
  plan: PipelinePlan;
  costs: CardCostRecord[];
}

/** `planPipelines` 的结果 → 线上的形状 */
export function wirePlan(plan: PipelinePlan): WirePlan {
  return {
    segments: plan.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })),
    prerenderSet: [...plan.prerenderSet],
  };
}

/** 线上的形状 → `pipelineAt` 认的形状。坏数据一律当空表，不抛——舞台不能因为一份表挂掉 */
export function revivePlan(wire: WirePlan | null | undefined): PipelinePlan {
  const segments = Array.isArray(wire?.segments) ? wire.segments : [];
  return {
    segments: segments.map((s) => ({
      fromSec: Number(s?.fromSec) || 0,
      toSec: Number(s?.toSec) || 0,
      heavy: new Set(Array.isArray(s?.heavy) ? s.heavy : []),
      light: new Set(Array.isArray(s?.light) ? s.light : []),
    })),
    prerenderSet: new Set(Array.isArray(wire?.prerenderSet) ? wire.prerenderSet : []),
  };
}
