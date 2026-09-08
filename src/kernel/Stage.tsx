import { AnimClock } from "./AnimClock";
import { frameCss } from "./layout";
import { perspectivePx } from "./space3d";
import { motionAt } from "./motion";
import { cardOpacityAt, hasOpacityControls } from "./project";
import { emphasisFilter } from "./emphasis";
import { getCard } from "./registry";
import { PartTree } from "./PartTree";
import { frameBox } from "./layout";
import type { Timeline } from "./types";

/** 提前 0.05s 挂载,让进场动画的第一帧正卡在 start 上 */
const LEAD = 0.05;

/**
 * 舞台:按当前时刻挑出活跃 clip 并挂载。卡片以 clip.id + playToken 作 key,
 * 进入区间即重新挂载、从头播放(和导出时的行为一致)。
 */
export function Stage({ timeline, t, playToken, speed = 1 }: { timeline: Timeline; t: number; playToken: number; speed?: number }) {
  const active = timeline.clips.filter((c) => t >= c.start - LEAD && t < c.end);
  // 自带三维场景的卡(scene-3d)要用和 A 层同一台相机,所以把画幅和 fov 一起递下去。
  // 对象整体透传,别的卡收到了也不看。
  const stageInfo = { width: timeline.width, height: timeline.height, camera3dFov: timeline.camera3dFov };
  return (
    <div
      className="pc-stage"
      style={{ position: "relative", width: timeline.width, height: timeline.height, overflow: "hidden", background: "transparent" }}
    >
      {/*
        三维的透视挂在这一层,不是挂在舞台那一格 —— 因为 CSS 的 `perspective`
        **只作用于直接子元素**,而卡片 div 的直接父元素就是 AnimClock 这一层。
        往外挪一格就会静悄悄失效(实测:卡片高度一点不变,rotateY 只剩仿射拉伸),
        而且外面那格还有 overflow:hidden,它会把 transform-style 强制打回 flat。

        放在 Stage 里而不是各个视图里,是为了让预览和导出走同一条路:
        StageView / ExportView 拿到的都只是 Timeline,任何一方漏写就是
        「预览有透视、导出没有」,而那种分叉不报错。

        perspective 的值就是相机到 z=0 平面的距离,和 three.js 那边同一个数、
        同一个单位(见 kernel/space3d.ts)—— A 层和 B 层不用标定就能对齐,靠的就是这个。
        不开三维时一个属性都不加:老项目的导出有逐像素基线。

        **这里没有 transform-style: preserve-3d,是故意的。** 直觉上「开三维就该加上它」,
        实测下来它做的完全是另一件事(perspective 618、一张 translateZ(-300) 的卡):

          无 perspective            卡片投影宽 300.00   画面上在前的是 DOM 靠后那张
          perspective + preserve-3d 卡片投影宽 201.96   画面上在前的变成 z 更近那张
          只有 perspective          卡片投影宽 201.96   画面上在前的仍是 DOM 靠后那张

        投影宽两行一模一样 —— 它**对透视一点贡献都没有**;它唯一的作用是把兄弟卡片
        从「按 DOM 顺序叠」改成「按 z 深度排序」。那正好推翻这套设计写死的两条约定:
        谁盖住谁只看序列(trackId),以及卡片之间不做穿插。加上它的话,Agent 把最上层的卡
        往里推一点(translateZ 负值),它会立刻被下面所有卡盖住 —— 和工具描述承诺的相反。

        它还会顺手改掉**没碰过三维的卡**的像素:一张只有 scale+rotate 的卡,截图 sha256
        在「不开三维」和「只有 perspective」下相同,加了 preserve-3d 就变了。
        也就是说一旦有人调 set_camera3d,画面里另外那些卡全部换了光栅路径。
      */}
      <AnimClock
        speed={speed}
        style={
          timeline.camera3dFov
            ? {
                perspective: `${perspectivePx({ width: timeline.width, height: timeline.height }, timeline.camera3dFov)}px`,
                perspectiveOrigin: "50% 50%",
              }
            : undefined
        }
      >
        {active.map((clip) => {
          const def = getCard(clip.cardId);
          if (!def) return null;
          const C = def.Component;

          // 绑了轨迹的 clip 整层跟着目标平移。平移放在**外层**而不是交给卡片：
          // 卡片不知道自己被绑了，也不该知道——换一张卡，跟随照样生效。
          const m = clip.motion ? motionAt(clip.motion, Math.max(0, t - clip.start)) : null;
          if (m && clip.motion!.whenHidden === "hide" && !m.visible) return null;

          // 卡片的框(位置/尺寸/锚点/缩放/旋转)和轨迹平移一样放在外层:卡片不知道自己被摆到了哪儿。
          // 没有 frame 时 frameCss 输出的就是以前那套 inset:0,老项目逐字节不变。
          // 不透明度 / 淡入淡出同理放外层,而且只在设了的时候才写 opacity —— 没设的卡 DOM 一个字不变。
          const op = hasOpacityControls(clip) ? cardOpacityAt(clip, t) : 1;
          // 强调(阴影 / 描边)沿 alpha 边缘走,所以挂在卡片外层这一格上;没设就一个字不写
          const filter = emphasisFilter(clip.emphasis);
          return (
            <div
              key={`${clip.id}:${playToken}`}
              data-pc-clip={clip.id}
              style={{
                ...frameCss(clip.frame, timeline, m ? { dx: m.dx, dy: m.dy } : undefined),
                ...(op < 1 ? { opacity: op } : null),
                ...(filter ? { filter } : null),
              }}
            >
              {/*
                clip.params 在写入时就是全量的(见 store 的 addCardClip),
                这里铺一层 defaults 只是兜底:卡片以后新增参数时,先前存下的 clip
                里没有那个键,没有这层就会把 undefined 传进组件。
                正常情况下它一项都不会补 —— 补上了就说明 clip 缺参数。
              */}
              {clip.cardId === "composite" && clip.parts?.length ? (
                // 组合卡:部件实例树逐级渲染,画布尺寸就是这张卡的框(没有框 = 整个舞台)
                <PartTree parts={clip.parts} size={frameBox(clip.frame, timeline)} t={Math.max(0, t - clip.start)} playToken={playToken} />
              ) : (
                <C params={{ ...def.defaults, ...clip.params }} playToken={playToken} t={Math.max(0, t - clip.start)} duration={clip.end - clip.start} stage={stageInfo} />
              )}
            </div>
          );
        })}
      </AnimClock>
    </div>
  );
}
