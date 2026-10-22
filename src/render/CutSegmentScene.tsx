import { createContext, useContext } from "react";
import type { CutSegmentRender } from "../kernel/cutSegments";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { withMediaRates } from "../kernel/clipTime.mjs";
import type { Timeline } from "../kernel/types";
import { FrameScene } from "./FrameScene";
import type { StagePlaneProps } from "./Stage";

/**
 * 剪辑段的画面(`kernel/cutSegments.ts` 文件头、`mechanism/rendering.md`「剪辑段」)。
 *
 * 舞台把剪辑段当成一张卡:包裹层照卡片的规矩摆框、算不透明度与淡入淡出、定层序;包裹层里就是这里 ——
 * 一个嵌套的 `FrameScene`,按 `offset + 本地时间` 渲被引用剪辑的整帧。被引用剪辑的画面先在自己的
 * 画幅(项目宽高)里合成,再整块缩放进段的框里、超出的部分裁掉(包裹层 `overflow: hidden`)。
 *
 * 宿主(外层 `FrameScene`)是哪种素材变体、播没播、拖没拖、素材服务报了哪些哈希,经 `SceneHostContext`
 * 递进来:嵌套的场景照同一种变体渲 —— 舞台里是真在放的素材层,导出页是截图那一步才装的占位
 * (`__pcPrepareFrameMedia` 按 `data-pc-media-*` 找到它们,嵌套的也在同一个文档里),所以
 * 预览、导出、预渲染出的是同一帧。没有宿主(平铺时间轴的导出页)按导出页的占位变体。
 *
 * 嵌套场景里的包裹层不挂 `data-pc-clip`(挂 `data-pc-nested-clip`):命中测试、钉动画、量实体框、
 * 预渲染按轨道前缀拆层这些按「舞台顶层片段」工作的地方,看到的只有剪辑段自己这一层。
 *
 * **嵌套场景是毛玻璃的采样边界**(〔裁〕R01):剪辑段的画面是被引用剪辑的整帧合成(`product/project-model.md`),里面的毛玻璃
 * (`backdrop-filter`)滤的只是这条剪辑里排在它下面的层,不透过段去滤段外面的层。场景这一层挂 `clip-path: inset(0)` 让它成为
 * 毛玻璃的采样根(Backdrop Root;`isolation`、`overflow` 挡不住,`clip-path` 挡得住)。和已有的 `overflow: hidden` 裁的是同一个框,
 * 别的像素逐字节不变(Chrome 152 实测:平移、缩放、旋转三种框,软件光栅与 GPU 都一样;见 `docs/reports/AGENT-claude-cut-stream.md`)。
 * 以前只有段在淡入淡出、不透明度小于 1 的那几帧这样(不透明度本来就让它成为采样根),现在每一帧一致。
 * 剪辑段里依赖下层的卡的流因此按嵌套场景自己的坐标产、只带场景里的下层(`server/frame-stream.mjs` 的 `belowStreamSpecs`)。
 *
 * 剪辑段里的卡和父时间轴上的卡一样分轻重(用户 2026-10-21 定;`kernel/cutFlatten.mjs` 的摊平视图):舞台把六个平面 prop
 * 原样递进来(`planes`),嵌套舞台按「`flatPrefix` + 片段 id」(计划一侧的虚拟片段 id)查 —— 判重的卡藏活子树、贴自己的流,
 * 没流时显示占位;轻卡照常活渲。导出页、预渲染页不传平面,DOM 一个字不变。
 */
export interface SceneHost {
  live: boolean;
  /** 素材层跟的时刻(宿主场景的时间) */
  mediaT: number;
  playing: boolean;
  scrubbing: boolean;
  localHashes?: readonly string[];
}

export const SceneHostContext = createContext<SceneHost | null>(null);

const graphMemo = new WeakMap<object, Timeline["graph"] | null>();
function subGraph(project: CutSegmentRender["project"]): Timeline["graph"] | undefined {
  if (graphMemo.has(project)) return graphMemo.get(project) ?? undefined;
  let graph: Timeline["graph"] | null = null;
  try {
    // 变速段的素材节点补上倍率(kernel/clipTime.mjs 的 withMediaRates;没有变速段时原样)
    graph = project.cardNodes?.length ? withMediaRates(project, projectCardGraph(project)) : null;
  } catch {
    // 算不出来(悬空输入之类)时和顶层一样按「图卡不画」兜底
    graph = null;
  }
  graphMemo.set(project, graph);
  return graph ?? undefined;
}

export function CutSegmentScene({ seg, start, localT, localDirectT = localT, playToken, size, flatPrefix, planes }: {
  seg: CutSegmentRender;
  /** 这一段在父剪辑上的起点(秒) */
  start: number;
  /** 段内本地时间(秒):舞台传给卡片的那个 `t` */
  localT: number;
  localDirectT?: number;
  playToken: number;
  /** 段的框(像素) */
  size: { width: number; height: number };
  /** 这一段里的片段在计划一侧的 id 前缀(`<段 id>~`,`kernel/cutFlatten.mjs`) */
  flatPrefix?: string;
  /** 舞台的六个平面 prop(按虚拟片段 id 发的);导出页、预渲染页不传 */
  planes?: StagePlaneProps;
}) {
  const host = useContext(SceneHostContext);
  const { project, offset, duration } = seg;
  const tau = offset + localT;
  const tauDirect = offset + localDirectT;
  // 被引用剪辑事后变短:超出它总时长的部分透明无声(Argon 审核意见冲突 3)
  if (!(tau >= 0 && tau < duration) && !(tauDirect >= 0 && tauDirect < duration)) return null;
  const W = Math.max(1, project.width), H = Math.max(1, project.height);
  const sx = size.width / W, sy = size.height / H;
  const live = !!host?.live;
  const mediaT = host ? offset + (host.mediaT - start) : tau;
  return (
    <div data-pc-cut-scene={seg.cutId} style={{
      position: "absolute", left: 0, top: 0, width: W, height: H, overflow: "hidden", clipPath: "inset(0)",
      ...(sx !== 1 || sy !== 1 ? { transform: `scale(${sx}, ${sy})`, transformOrigin: "0 0" } : null),
    }}>
      <FrameScene nested project={project} t={tau} directT={tauDirect} playToken={playToken} graph={subGraph(project)}
        mediaMode={live ? "live" : "placeholder"} mediaT={mediaT}
        playing={live && !!host?.playing} scrubbing={live && !!host?.scrubbing} localHashes={host?.localHashes}
        flatPrefix={flatPrefix} {...planes} />
    </div>
  );
}
