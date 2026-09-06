import { AnimClock } from "./AnimClock";
import { getCard } from "./registry";
import type { Timeline } from "./types";

/** 提前 0.05s 挂载,让进场动画的第一帧正卡在 start 上 */
const LEAD = 0.05;

/**
 * 舞台:按当前时刻挑出活跃 clip 并挂载。卡片以 clip.id + playToken 作 key,
 * 进入区间即重新挂载、从头播放(和导出时的行为一致)。
 */
export function Stage({ timeline, t, playToken, speed = 1 }: { timeline: Timeline; t: number; playToken: number; speed?: number }) {
  const active = timeline.clips.filter((c) => t >= c.start - LEAD && t < c.end);
  return (
    <div
      className="pc-stage"
      style={{ position: "relative", width: timeline.width, height: timeline.height, overflow: "hidden", background: "transparent" }}
    >
      <AnimClock speed={speed}>
        {active.map((clip) => {
          const def = getCard(clip.cardId);
          if (!def) return null;
          const C = def.Component;
          return (
            <div key={`${clip.id}:${playToken}`} style={{ position: "absolute", inset: 0 }}>
              <C params={{ ...def.defaults, ...clip.params }} playToken={playToken} />
            </div>
          );
        })}
      </AnimClock>
    </div>
  );
}
