/**
 * 在线普通档播放时的「按拍换快照」预算(C10 契约 `docs/plan/c10-contract.md` 第 6 节、第 18 节第 1 条;
 * 语义 `product/rendering.md`「兜底顺序」、`product/platforms.md`「在线浏览器模式」)。
 *
 * 在线页面没有预渲染进程,也就没有轨道流:重层每拍换一次 HTML 快照。换一次快照的成本 `swapMs` 计入每拍预算,
 * 装不下的重层这一拍显示占位符(兜底顺序第 4 步)。
 *
 *   deadMs = max(0, B − 已占用)          B = budgetOf(fps) = 1000 / fps × 0.7(与 `pipelinePlan.mjs` 的分派同一个预算)
 *   装得下的重层数 = floor(deadMs / swapMs)
 *
 * 「已占用」是这一拍轻管线里活渲的卡的权重之和(`planDispatch.ts` 的 `lightCostAt`,口径同 `clipWeight` 的 `w`)。
 * 重层按调用方给的顺序取(调用方从上到下排:最上面的层先换);同一输入结果稳定。
 *
 * 纯函数:浏览器与 Node 同一份。
 */
import { budgetOf } from './pipelinePlan.mjs';

/** 换一次快照的成本缺省值(毫秒)。按卡种实测后写进 `mechanism/rendering.md`(C10 契约第 6 节) */
export const SWAP_MS = 3;

/**
 * @param {{ fps: number, occupiedMs?: number, layers: readonly string[], swapMs?: number }} input
 * @returns {{ swap: string[], placeholder: string[], deadMs: number, fit: number }}
 */
export function fitBeatSwaps({ fps, occupiedMs = 0, layers, swapMs = SWAP_MS }) {
  const rate = Math.max(1, Number(fps) || 30);
  const occupied = Math.max(0, Number(occupiedMs) || 0);
  const cost = Number(swapMs) > 0 ? Number(swapMs) : SWAP_MS;
  const deadMs = Math.max(0, budgetOf(rate) - occupied);
  const list = [];
  const seen = new Set();
  for (const id of layers ?? []) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  // 浮点:17.5 / 3.5 这类整除的情形别因为 4.999999 少装一层
  const fit = Math.max(0, Math.floor(deadMs / cost + 1e-9));
  return { swap: list.slice(0, fit), placeholder: list.slice(fit), deadMs, fit };
}
