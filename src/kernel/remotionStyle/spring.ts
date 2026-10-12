/**
 * remotion 式的框架：弹簧。
 *
 * Motion 的弹簧是一步步积分出来的，第 N 帧的位置取决于前面每一帧。这里用阻尼振子的解析解：
 * 给出时间 t 就直接算出位置，不用从头推，跳到哪一帧都是同一个公式。
 *
 * 模型：质量 m、劲度 k、阻尼 c 的弹簧从 `from` 出发（初速度 `velocity`），停在 `to`。
 *   ω0 = √(k/m)，ζ = c / (2√(km))
 *   ζ < 1（欠阻尼，会过冲）  x(t) = to + e^(−ζω0·t) · [ d·cos(ωd·t) + ((v + ζω0·d)/ωd)·sin(ωd·t) ]，ωd = ω0·√(1−ζ²)
 *   ζ = 1（临界阻尼）        x(t) = to + e^(−ω0·t) · [ d + (v + ω0·d)·t ]
 *   ζ > 1（过阻尼，不过冲）  x(t) = to + A·e^(r1·t) + B·e^(r2·t)，r1,2 = −ω0·(ζ ∓ √(ζ²−1))
 * 其中 d = from − to，v 是初速度。
 */

export interface SpringConfig {
  /** 劲度，越大越快到位。缺省 100 */
  stiffness?: number;
  /** 阻尼，越大晃得越少。缺省 10 */
  damping?: number;
  /** 质量，越大越迟钝。缺省 1 */
  mass?: number;
  /** 起点的值，缺省 0 */
  from?: number;
  /** 终点的值，缺省 1 */
  to?: number;
  /** 从第几秒开始，缺省 0 */
  delay?: number;
  /** 初速度（每秒走多少），缺省 0 */
  velocity?: number;
  /** 不许越过终点（过冲的部分截平），缺省 false */
  clamp?: boolean;
}

interface Resolved { k: number; c: number; m: number; from: number; to: number; delay: number; v0: number; clampOvershoot: boolean }

function resolve(config: SpringConfig | undefined): Resolved {
  const k = config?.stiffness ?? 100, c = config?.damping ?? 10, m = config?.mass ?? 1;
  if (!(k > 0) || !(m > 0) || !(c >= 0)) throw new Error(`spring 的参数不对：stiffness、mass 要大于 0，damping 不能是负数（收到 ${k}、${m}、${c}）`);
  return { k, c, m, from: config?.from ?? 0, to: config?.to ?? 1, delay: config?.delay ?? 0, v0: config?.velocity ?? 0, clampOvershoot: config?.clamp === true };
}

/** 起步后第 s 秒离终点还有多远（带符号） */
function displacement(s: number, r: Resolved): number {
  const d = r.from - r.to;
  const w0 = Math.sqrt(r.k / r.m);
  const zeta = r.c / (2 * Math.sqrt(r.k * r.m));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return Math.exp(-zeta * w0 * s) * (d * Math.cos(wd * s) + ((r.v0 + zeta * w0 * d) / wd) * Math.sin(wd * s));
  }
  if (zeta === 1) return Math.exp(-w0 * s) * (d + (r.v0 + w0 * d) * s);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root), r2 = -w0 * (zeta + root);
  const a = (r.v0 - r2 * d) / (r1 - r2);
  return a * Math.exp(r1 * s) + (d - a) * Math.exp(r2 * s);
}

/**
 * 弹簧在第 t 秒的位置，直接算，不依赖前一帧。开始之前（t 早于 `delay`）是 `from`。
 *
 * 例：`spring(t, { from: 0.6, to: 1, stiffness: 180, damping: 12 })` —— 从 0.6 弹到 1，略微过冲。
 */
export function spring(t: number, config?: SpringConfig): number {
  const r = resolve(config);
  const s = t - r.delay;
  if (!(s > 0)) return r.from;
  const x = r.to + displacement(s, r);
  if (!r.clampOvershoot) return x;
  return r.from <= r.to ? Math.min(x, r.to) : Math.max(x, r.to);
}

/**
 * 这根弹簧从开始到停稳要多少秒（含 `delay`）：此后离终点的距离不超过全程的 `restRatio`（缺省千分之一）。
 * 给 `lifecycle.settleMs`、错开进场的总时长这类地方用。
 *
 * 例：`springDuration({ stiffness: 180, damping: 12 })` ≈ 1.17。
 */
export function springDuration(config?: SpringConfig, restRatio = 0.001): number {
  const r = resolve(config);
  const d = r.from - r.to;
  const span = Math.abs(d);
  if (span === 0 && r.v0 === 0) return r.delay;
  const threshold = Math.max(span, Math.abs(r.v0) / Math.sqrt(r.k / r.m)) * (restRatio > 0 ? restRatio : 0.001);
  const w0 = Math.sqrt(r.k / r.m);
  const zeta = r.c / (2 * Math.sqrt(r.k * r.m));
  if (zeta > 0 && zeta < 1) {
    // 欠阻尼：振幅的包络是 C·e^(−ζω0·t)，包络降到阈值的那一刻
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const amplitude = Math.hypot(d, (r.v0 + zeta * w0 * d) / wd);
    return r.delay + Math.max(0, Math.log(amplitude / threshold) / (zeta * w0));
  }
  if (zeta === 0) return Infinity; // 没有阻尼，永远停不下来
  // 临界与过阻尼：按 1/240 秒一格往后找最后一次超出阈值的时刻（上限 60 秒）
  const step = 1 / 240;
  let last = 0;
  for (let i = 1; i <= 240 * 60; i++) if (Math.abs(displacement(i * step, r)) > threshold) last = i;
  return r.delay + (last + 1) * step;
}
