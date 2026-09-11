// filters.mjs 的类型。实现写成纯 JS 是为了 node 直接跑的服务端合成也能 import,见那边的头注释。

export type FilterKind = "brightness" | "contrast" | "saturate" | "hue" | "grayscale" | "sepia" | "invert" | "blur";

export interface FilterKindSpec {
  label: string;
  min: number;
  max: number;
  neutral: number;
  unit?: string;
  hint: string;
}

export interface FilterParamSpec {
  default: number;
  min?: number;
  max?: number;
  label?: string;
}

/** 一步:数字,或随时间变化的表达式字符串(变量 t / d / p + 声明的参数) */
export interface FilterOp {
  kind: FilterKind;
  value: number | string;
}

/** 滤镜库里的一条(project.filters),素材库「转场/滤镜」页列的就是它 */
export interface FilterDef {
  id: string;
  name: string;
  description?: string;
  params?: Record<string, FilterParamSpec>;
  ops: FilterOp[];
  createdBy?: "agent" | "user";
  createdAt?: number;
}

/** 片段上挂的滤镜:引用库里的一条 + 逐段覆盖参数 */
export interface ClipFilter {
  id: string;
  params?: Record<string, number>;
}

export interface ResolvedOp {
  kind: FilterKind;
  value: number;
}

export interface FfmpegStage {
  filter: "lutrgb" | "colorchannelmixer" | "gblur";
  opts: Record<string, number | string>;
  linear?: { slope: number; icpt: number };
}

export const FILTER_KINDS: Record<FilterKind, FilterKindSpec>;
export const MAX_OPS: number;
export const MAX_PARAMS: number;
export const MAX_EXPR_LEN: number;
export const BASE_VARS: string[];
export const EXPR_HELP: string;
export class FilterExprError extends Error {}

export function compileExpr(src: string, vars?: string[]): { fn: (env: Record<string, number>) => number; uses: Set<string> };
export function normalizeFilterDef(input: unknown): Omit<FilterDef, "id" | "createdBy" | "createdAt">;
export function normalizeClipParams(def: FilterDef, input: unknown): Record<string, number> | undefined;
export function resolveOps(def: Pick<FilterDef, "ops" | "params">, clipParams: Record<string, number> | undefined, t: number, d: number): ResolvedOp[];
export function isAnimated(def: Pick<FilterDef, "ops" | "params">): boolean;
export function describeFilter(def: Pick<FilterDef, "ops">): string;
export function cssFilter(ops: ResolvedOp[], pxScale?: number): string;
export function colorMatrix(kind: FilterKind, v: number): number[] | null;
export function ffmpegStages(ops: ResolvedOp[], blurScale?: number): FfmpegStage[];
export function blurPadOf(sigma: number): number;
export function ffmpegChain(stages: FfmpegStage[], tag?: string, blurPad?: number): string;
export function ffmpegStaticChain(ops: ResolvedOp[], blurScale?: number): string;
export function sendcmdScript(
  def: Pick<FilterDef, "ops" | "params">,
  clipParams: Record<string, number> | undefined,
  d: number,
  frames: { ts: number; t: number }[],
  tag: string,
  blurScale?: number,
  fps?: number,
): { script: string; blurPad: number };
export function filterOfClip(project: { filters?: FilterDef[] }, clip: { filter?: ClipFilter } | null | undefined): FilterDef | null;
export function clipFilterOpsAt(project: { filters?: FilterDef[] }, clip: { filter?: ClipFilter; start: number; end: number }, T: number): ResolvedOp[] | null;
