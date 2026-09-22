import type { CardCostRecord } from './cardCostKey.d.mts';

/**
 * K3(b) 的「实际要追多少」（pinned 渲染 4：`t_c = (t − t_start) × FPS × t_oc`）。
 * `frames` 是从入点到此刻的帧数；回毫秒，封顶在整段 `catchUpMs` 上，
 * 算不出来就回整段代价（再没有就是 0，调用方自己兜底）。
 */
export function catchUpEstimateMs(
  record: Partial<CardCostRecord> | null | undefined,
  frames: number,
): number;
