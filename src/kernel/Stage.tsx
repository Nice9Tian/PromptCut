import { AnimClock } from "./AnimClock";
import { memo, useEffect, useMemo, useRef } from "react";
import { frameCss } from "./layout";
import { perspectivePx } from "./space3d";
import { motionAt } from "./motion";
import { cardOpacityAt, hasOpacityControls } from "./project";
import { emphasisFilter } from "./emphasis";
import { getCard } from "./registry";
import { PartTree } from "./PartTree";
import { GraphCard } from "../render/cards/GraphCard";
import { frameBox } from "./layout";
import type { CardDef, CardProps, Timeline } from "./types";
import { cardMountedAt } from "../render/frameWindow.mjs";
import { clipFrameMode } from "./frameMode.mjs";
import { guardCompositing, shouldGuard } from "../render/capabilityGuard";

// Keep direct-evaluation cards at the requested time while other cards replay.
// Their CSS/DOM stays in the same stacking tree (including paper/glass styles),
// but their component is not run for each stateful history frame.
const DirectCard = memo(function DirectCard({ def, params, ...props }: CardProps<any> & { def: CardDef<any> }) {
  // 图卡没有 Component,但它在下面的分支顺序里排在这一支**前面**,走到这里必有组件。
  // 这里**不能**改成 `if (!C) return null` —— 分支顺序万一写错,那就是一张静默的空白卡。
  const C = def.Component!;
  return <C {...props} params={{ ...def.defaults, ...params }} />;
});

/**
 * 实体模式:浏览时把每张卡换成一个色块。给一个「这张卡该画成什么样」的查询函数,
 * Stage 只负责摆位置 —— 颜色怎么来的、什么时候采样,是 render/solidMode.ts 的事。
 *
 * 不传 = 真渲,DOM 和以前**一个字都不差**(导出走的就是这条路)。
 */
export type ProxyRender = (clipId: string) => { color: string; box: { left: number; top: number; width: number; height: number } | null };

/**
 * 舞台:按当前时刻挑出活跃 clip 并挂载。卡片以 clip.id + playToken 作 key,
 * 进入区间即重新挂载、从头播放(和导出时的行为一致)。
 */
export function Stage({ timeline, t, directT = t, playToken, speed = 1, proxy }: { timeline: Timeline; t: number; directT?: number; playToken: number; speed?: number; proxy?: ProxyRender }) {
  const timeOf = (c: Timeline['clips'][number]) => clipFrameMode(c, getCard(c.cardId)) === 'direct' ? directT : t;
  const active = timeline.clips.filter((c) => cardMountedAt(c, timeOf(c)));
  // 自带三维场景的卡(scene-3d)要用和 A 层同一台相机,所以把画幅和 fov 一起递下去。
  // 对象整体透传,别的卡收到了也不看。
  const stageInfo = useMemo(() => ({ width: timeline.width, height: timeline.height, camera3dFov: timeline.camera3dFov }), [timeline.width, timeline.height, timeline.camera3dFov]);
  /*
   * 审阅表（src/cards/capabilities.json）说 independent、画面上却量到 backdrop-filter 的卡，
   * 挂上之后报一次警并降级成 belowDependent（render/capabilityGuard.ts）。
   * 每张卡一辈子只量一次，且只在开发态的交互舞台上跑 —— 导出 / 预渲染那条路 shouldGuard() 直接 false，
   * 一个 getComputedStyle 都不会执行，逐像素基线不受影响。DOM 一个字不改（只加了个 ref）。
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const guardKey = active.map((c) => c.cardId).join("|");
  useEffect(() => {
    if (!shouldGuard()) return;
    const handle = requestAnimationFrame(() => {
      guardCompositing(stageRef.current, active.map((c) => ({ id: c.id, cardId: c.cardId })));
    });
    return () => cancelAnimationFrame(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardKey]);
  return (
    <div
      ref={stageRef}
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
        {active.map((clip, i) => {
          const def = getCard(clip.cardId);
          /*
           * 三道都在取 def 这一格剔掉,不放到分支里:
           *  - 定义没了(用户卡文件被删)——图卡的 def 在注册表里必然取得到,挡不住下面两种;
           *  - 既没有 card 也没有 Component:音频图卡万一带着 cardId 进来也不炸;
           *  - 图卡但没有图(projectCardGraph 抛了):没有图解不出输入,画不出东西。
           */
          if (!def || (!def.card && !def.Component) || (def.card && !timeline.graph)) return null;
          const C = def.Component!;
          const cardT = timeOf(clip);

          // 绑了轨迹的 clip 整层跟着目标平移。平移放在**外层**而不是交给卡片：
          // 卡片不知道自己被绑了，也不该知道——换一张卡，跟随照样生效。
          const m = clip.motion ? motionAt(clip.motion, Math.max(0, cardT - clip.start)) : null;
          if (m && clip.motion!.whenHidden === "hide" && !m.visible) return null;

          // 卡片的框(位置/尺寸/锚点/缩放/旋转)和轨迹平移一样放在外层:卡片不知道自己被摆到了哪儿。
          // 没有 frame 时 frameCss 输出的就是以前那套 inset:0,老项目逐字节不变。
          // 不透明度 / 淡入淡出同理放外层,而且只在设了的时候才写 opacity —— 没设的卡 DOM 一个字不变。
          const op = hasOpacityControls(clip) ? cardOpacityAt(clip, cardT) : 1;
          // 强调(阴影 / 描边)沿 alpha 边缘走,所以挂在卡片外层这一格上;没设就一个字不写
          const filter = emphasisFilter(clip.emphasis);
          return (
            <div
              key={`${clip.id}:${playToken}`}
              data-pc-clip={clip.id}
              data-pc-local-frame={Math.round((cardT - clip.start) * timeline.fps)}
              data-pc-frame-mode={clipFrameMode(clip, def)}
              className={proxy ? "pc-proxy" : undefined}
              style={{
                ...frameCss(clip.frame, timeline, m ? { dx: m.dx, dy: m.dy } : undefined),
                ...(op < 1 ? { opacity: op } : null),
                ...(filter ? { filter } : null),
                /*
                 * 层序写死在这里,不靠 DOM 顺序。
                 *
                 * `active` 已经是画家顺序(flattenOverlay 倒着遍历 tracks,所以最后一个 =
                 * 时间轴最上面那条序列 = 最上层),但光有 DOM 顺序不够:卡片内部只要有人写了
                 * z-index,而外层又不是层叠上下文,那个 z-index 就会跑到舞台这一级去比,
                 * 越过后面的兄弟。实测 focus-card 内部有 `zIndex: 100`(focus-card.tsx:40),
                 * 于是把三维卡放到最上面那条序列,画面中心仍然是 focus-card ——
                 * Agent 按「靠上的序列盖住靠下的」去排层,结果和承诺相反。
                 *
                 * 所以两件事一起做:显式 z-index 定序,`isolation: isolate` 造一个层叠上下文
                 * 把卡片内部的 z-index 关在里面。这就是设计文档里「每个 A/B 对象带一个遮蔽标识、
                 * 0 在最前面」那条 —— 遮蔽标识就是序列顺序,这里把它翻译成 CSS 的方向
                 * (CSS 是数字越大越靠前,和「0 最前」正好相反,所以只能写死在一处)。
                 */
                zIndex: i + 1,
                isolation: "isolate",
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
              ) : def.card ? (
                // 图卡:经 Stage、有包裹层,hitTest / rects / 快照 / 抑制全部照常
                <GraphCard def={def} clip={clip} graph={timeline.graph} fps={timeline.fps}
                  t={Math.max(0, cardT - clip.start)} params={{ ...def.defaults, ...clip.params }} stage={stageInfo} />
              ) : clipFrameMode(clip, def) === 'direct' ? (
                <DirectCard def={def} params={clip.params} playToken={playToken} t={Math.max(0, cardT - clip.start)} duration={clip.end - clip.start} stage={stageInfo} />
              ) : (
                <C params={{ ...def.defaults, ...clip.params }} playToken={playToken} t={Math.max(0, cardT - clip.start)} duration={clip.end - clip.start} stage={stageInfo} />
              )}
              {/*
                代理色块是卡片的**兄弟**,不是把卡片包起来 —— 真卡由 .pc-proxy 那条
                CSS 规则藏掉(见 render/solidMode.ts)。包一层 div 的话,切换实体模式那一刻
                React 会重挂载卡片,而重挂载会丢掉 pinAnimations 的锚点:
                用户看到的是「每次暂停,字都重新飞进来一次」。
                box 是「这张卡真正画了东西的那一块」,坐标相对卡片自己的框;
                量不到(或者内容本来就铺满这张卡)就 inset:0。
              */}
              {proxy ? (() => {
                const px = proxy(clip.id);
                return (
                  <div
                    data-pc-proxy-plane=""
                    style={{
                      position: "absolute",
                      ...(px.box ?? { inset: 0 }),
                      background: px.color,
                      borderRadius: 6,
                    }}
                  />
                );
              })() : null}
            </div>
          );
        })}
      </AnimClock>
    </div>
  );
}
