/**
 * K3(b)「实际要追多少」的估算（pinned 渲染 4）。纯函数，单独一个文件是为了能单测 ——
 * `stageSwap.ts` 那一侧要卡片注册表和 store，拿不进 `node --test`。
 *
 * # 公式
 *
 *   `t_c = (t − t_start) × FPS × t_oc`
 *
 * 长 motion 走的是**虚拟时间**：播放头此刻踩在它身上的第几帧，就只要追这么多帧。
 * `t_oc` 是单帧最差耗时 —— K1 探针量的正是「推帧过程中最慢一帧」（`stepMaxMs`），
 * 没有这个数就退回 p90 的 `stepMs`。
 *
 * # 为什么不直接用整段 `catchUpMs`
 *
 * 整段 `catchUpMs` 是「从第 0 帧冲到**最后一帧**」的总代价（pinned 渲染 3 末句，K2 用它
 * 判轻重）。播放头刚进入一个 60 秒的片段时按它估，K5 第二路的目标拍 `T` 会被推出去好几秒：
 * 可见舞台白等，那张卡在 `suppressed` 里多透明一大截，而后台其实几十毫秒就补完了。
 *
 * # 封顶
 *
 * 位置估算**取不过整段代价**：`t_oc` 是单帧最差，乘满整段会比实测的整段总代价还悲观。
 * 算不出位置（没有 `t_oc`、或帧数为 0）就退回整段代价。
 *
 * **只影响「追多少」这个实际取值**：K2 的轻重分派仍按整段最差判（`clipWeight` 不受影响）。
 */

/**
 * 一张卡在播放位置 `frames`（= `(t − t_start) × fps`，已推进的帧数）上的补跑代价估计（毫秒）。
 *
 * @param {{ catchUpMs?: number, stepMaxMs?: number, stepMs?: number } | null | undefined} record K1 的成本记录
 * @param {number} frames 从入点到此刻的帧数
 * @returns {number} 毫秒；没有任何可用的数就回 0（调用方自己兜底）
 */
export function catchUpEstimateMs(record, frames) {
  const whole = Number(record?.catchUpMs) || 0;
  const perFrame = Number(record?.stepMaxMs) || Number(record?.stepMs) || 0;
  const n = Number(frames);
  const steps = Number.isFinite(n) && n > 0 ? n : 0;
  const byPosition = perFrame > 0 && steps > 0 ? steps * perFrame : 0;
  if (byPosition <= 0) return whole;
  return whole > 0 ? Math.min(byPosition, whole) : byPosition;
}
