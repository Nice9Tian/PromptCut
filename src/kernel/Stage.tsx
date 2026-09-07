import { AnimClock } from "./AnimClock";
import { motionAt } from "./motion";
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

          // 绑了轨迹的 clip 整层跟着目标平移。平移放在**外层**而不是交给卡片：
          // 卡片不知道自己被绑了，也不该知道——换一张卡，跟随照样生效。
          const m = clip.motion ? motionAt(clip.motion, Math.max(0, t - clip.start)) : null;
          if (m && clip.motion!.whenHidden === "hide" && !m.visible) return null;

          return (
            <div
              key={`${clip.id}:${playToken}`}
              data-pc-clip={clip.id}
              style={{
                position: "absolute",
                inset: 0,
                ...(m ? { transform: `translate(${m.dx}px, ${m.dy}px)`, willChange: "transform" } : null),
              }}
            >
              {/*
                clip.params 在写入时就是全量的(见 store 的 addCardClip),
                这里铺一层 defaults 只是兜底:卡片以后新增参数时,先前存下的 clip
                里没有那个键,没有这层就会把 undefined 传进组件。
                正常情况下它一项都不会补 —— 补上了就说明 clip 缺参数。
              */}
              <C params={{ ...def.defaults, ...clip.params }} playToken={playToken} t={Math.max(0, t - clip.start)} duration={clip.end - clip.start} />
            </div>
          );
        })}
      </AnimClock>
    </div>
  );
}
