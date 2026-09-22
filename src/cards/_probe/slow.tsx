import type { CardDef, CardProps } from "../../kernel/types";

/**
 * K6 的判例卡：**每一次 React 渲染都烧掉 `burnMs` 毫秒**。
 *
 * K6 的验收要「人为把一张卡的成本拉到 50 ms，播放不跳帧、`frame` 间隔变成约 50 ms、
 * 每拍都超过 40 ms……一秒内 K6 触发降级」。卡库里没有一张卡能**稳定**地这么慢：
 * 真正贵的那些（粒子、三维）贵在 rAF 回调和 GPU 上，而且机器一换数就变，
 * 验收里的「50 ms」就成了一个量不准的数。所以这里放一张成本由参数直接定的卡。
 *
 * 为什么把时间烧在 render 里而不是 rAF 回调里：K6 挑「最贵的那张轻卡」靠的是
 * `FrameScene` 的 live 路给每个片段套的 `<Profiler>`（`onRender` 的 `actualDuration`），
 * 它量的是这个片段子树的渲染 / 提交。rAF 回调跑在 `clock.tick` 里，
 * 回调和片段之间没有可靠的归属关系（见报告里的更正建议）。
 *
 * 计时用 `__pcRealNow`（舞台把 `performance.now` 换成了虚拟时钟，用它会空转到死）。
 */
function ProbeSlowCard({ params, t }: CardProps<{ burnMs: number; label: string }>) {
  const burn = Math.max(0, Number(params.burnMs) || 0);
  if (burn > 0) {
    const now = (window as unknown as { __pcRealNow?: () => number }).__pcRealNow ?? (() => Date.now());
    const until = now() + burn;
    // 忙等:要的就是「这一拍的 React 渲染真的花了这么久」
    while (now() < until) { /* 烧时间 */ }
  }
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div
        data-pc-probe="slow"
        style={{
          position: "absolute", left: 480, top: 420, width: 320, height: 240, borderRadius: 24,
          background: "#f97316", color: "#fff", fontSize: 40, display: "grid", placeItems: "center",
          // 让它每帧都有变化,免得 React 把这一支 memo 掉
          transform: `translateX(${((t ?? 0) * 10).toFixed(2)}px)`,
        }}
      >
        {params.label}
      </div>
    </div>
  );
}

export const probeSlowCard: CardDef<{ burnMs: number; label: string }> = {
  id: "probe-slow",
  name: "探针卡 · 可调成本",
  description: "K6 的判例:每次渲染烧掉 burnMs 毫秒(用 __pcRealNow 忙等),用来人为把一张卡的每拍成本拉高",
  source: "native",
  // direct:按 t 直接求值,没有动画历史 —— K6 要的是「一张**轻**卡被降级」,
  // 走推帧那条路的话它会先被 K2 的追帧上界判重,根本进不了轻管线
  frameMode: "direct",
  defaults: { burnMs: 0, label: "slow" },
  controls: [
    { key: "burnMs", type: "number", label: "每帧烧掉(ms)" },
    { key: "label", type: "text", label: "文字" },
  ],
  Component: ProbeSlowCard,
};
