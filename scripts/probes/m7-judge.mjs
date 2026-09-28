/**
 * M7 验收探针（`m7-browser-probe.mjs`）里 D1-D2-D12 那一项的纯判据：不起进程、不连网络，单测在 `server/test/m7-judge.test.mjs`。
 *
 * 一张卡的「出键」= 任务要求的环境指纹（pc 的、页面的）。切分方对浏览器可做的卡按两种出键各出一份（D1），先认领者得卡、
 * 另一份整份作废。页面同时持几张卡的锁、一次只做一段时，没轮到的卡锁闲置超过 30 s 会被切分方按 D2 用自己的出键接手：
 * 被接手那份已做完的段留着有效、没做的段作废，接手方的出键从头出全一份。所以按出键分组判（主会话 2026-09-28）：
 *   - 有一组「每段恰好一份有效」覆盖全部段（得卡的那一组）；
 *   - 其余组要么整份作废（先认领者得卡的常规情形），要么部分作废（中途被 D2 接手：只作说明，不算失败）；
 *   - 层表 v3 这一层的候选里两组都在，这一层最终指向单一指纹（候选之一）。
 * 旧判据（所有出键合起来每段恰好一份有效）在中途接手时会把 0-59 这类两组都有效的段判成 `0-59:2`，那是 D2 的设计行为。
 */

/**
 * @param {{ groups: Record<string, Array<{ range: string, live: boolean }>>, candidates?: string[], layerFp?: string | null }} clip
 *   `groups`：出键名（'pc' / 'page' 或指纹）→ 这一出键下的每段是否有效（没被作废）；`candidates`：层表这一层候选的出键名；
 *   `layerFp`：层表这一层最终指向的出键名（层上的 `envFingerprint` 换成出键名）
 * @returns {{ ok: boolean, winner: string | null, fullySuperseded: string[], takenOverMidway: string[], badRanges: string[], reasons: string[] }}
 */
export function judgeDualClip({ groups, candidates = [], layerFp = null }) {
  const reasons = [];
  const names = Object.keys(groups ?? {}).filter((k) => (groups[k] ?? []).length > 0);
  const allRanges = [...new Set(names.flatMap((k) => groups[k].map((t) => t.range)))].sort();
  const liveCount = (k, r) => groups[k].filter((t) => t.range === r && t.live).length;
  // 同一出键下每段恰好一份有效、且覆盖全部段的组
  const full = names.filter((k) => allRanges.every((r) => liveCount(k, r) === 1));
  const fullySuperseded = names.filter((k) => groups[k].every((t) => !t.live));
  const takenOverMidway = names.filter((k) => !full.includes(k) && groups[k].some((t) => t.live) && groups[k].some((t) => !t.live));
  const badRanges = [];
  for (const k of names) for (const r of allRanges) if (liveCount(k, r) > 1) badRanges.push(`${k}:${r}:${liveCount(k, r)}`);
  if (names.length < 2) reasons.push('没有两种出键');
  if (full.length !== 1) reasons.push(full.length === 0 ? '没有哪一组出键每段恰好一份有效' : '两组出键都整份有效（没有作废）');
  const others = names.filter((k) => !full.includes(k));
  if (others.some((k) => !fullySuperseded.includes(k) && !takenOverMidway.includes(k))) reasons.push('另一组既不是整份作废也不是中途被接手');
  if (badRanges.length) reasons.push('同一出键下有段不止一份有效');
  if (!names.every((k) => candidates.includes(k))) reasons.push('层表候选里缺一组');
  if (!layerFp || !names.includes(layerFp)) reasons.push('层表这一层没有指向其中一组');
  return { ok: reasons.length === 0, winner: full.length === 1 ? full[0] : null, fullySuperseded, takenOverMidway, badRanges, reasons };
}
