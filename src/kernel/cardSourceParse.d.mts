import type { Control } from "./types";

/** 源码里认出的一张卡(`defaults` / `controls` / `description` 只认字面量,见 `cardSourceParse.mjs` 文件头) */
export interface ParsedCardSource {
  id: string;
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  /** 有控件没认出来(或整个 `controls` 不是字面量) */
  controlsIncomplete: boolean;
}
/** 一份卡片源码里定义的卡(不执行源码);认不出回空数组 */
export function parseCardSource(source: string): ParsedCardSource[];
/** 一个已求值的控件对象 → `Control`;画不出来的回 null */
export function controlOf(v: unknown): Control | null;
/** 内容库里的卡片源码键是不是一张用户卡的入口文件(`src/cards/user/<名>.tsx`) */
export function isUserCardEntryKey(key: unknown): boolean;
