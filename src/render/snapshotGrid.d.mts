import type { ReadyRange } from './snapshotPick.mjs';

/** 每隔多少帧存一张快照(只在 `snapshotGrid.mjs` 里定义) */
export const SNAPSHOT_STRIDE: number;

export type GridShape = {
  /** 这张卡的帧数 */
  count: number;
  /** 这张卡第一帧的全局帧号(缺省 0) */
  firstFrame?: number;
  /** 锚帧,全局帧号(`snapshotPick.mjs` 的 `anchorFrames`) */
  anchors?: readonly number[];
};

export function gridLocalFrames(input: GridShape): number[];
export function gridWants(input: GridShape & { localFrame: number }): boolean;
export function gridComplete(input: GridShape & {
  /** 就绪区间,本地帧口径的闭区间,不要求已合并或有序 */
  ranges?: readonly ReadyRange[];
  /** 只问这一段的起止(本地帧,闭区间);都不给就问整套 */
  from?: number;
  to?: number;
}): boolean;
