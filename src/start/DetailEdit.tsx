/**
 * 「详细编辑」:拓展栏「画面」那一段的段头按钮点开它,展开占满整个聊天区(用户 2026-10-23 定)。
 * **输入框留在下面不收** —— 这正是它的用处:在这儿右键一张卡,把它引用进输入框,接着跟 Agent 说
 * 「这一张怎么怎么改」。
 *
 * 形状:上面是舞台和一排传输控件,下面是时间轴。
 *
 * 舞台是这个项目的真画面(`VibeStage.tsx`);时间轴**就是编辑界面那条真时间轴**(`src/editor/timeline/`),
 * 不是另画一条只能看的 —— 拖动、裁剪、跨序列、吸附、分割、删除、剪辑标签都在。
 * 这对应 `user-workflow.md`「工作方式」那一行:氛围式里「主要是 Agent 动手；用户也能自己调——
 * 从右侧拓展栏的「画面」进详细编辑，那里的时间轴可调」。要整套编辑界面(素材库、特效、AI 栏)才「进入传统式」。
 *
 * 2026-10-23 先做的那一版是自己画的只读轨道(拖不动、改不了),和上面那句语义对不上,同日换成了真时间轴。
 * 真时间轴的右键菜单在这一页多一项「引用到输入框」(`TimelineView` 的 `quoteClip`,只这一页传),
 * 写法和编辑器「引用到 AI」同一个(`@卡片 名字(片段 id)`,`src/mobile/agentView.ts` 的 `quoteToken`),Agent 认得。
 */
import type { JSX } from "react";
import { actions, useStore } from "../store/project";
import { TimelineView } from "../editor/timeline";
import { quoteToken } from "../mobile/agentView";
import { VibeStage } from "./VibeStage";

const secs = (t: number) => `${t.toFixed(2)} s`;

export function DetailEdit(props: {
  /**
   * 切到**传统式**:打开编辑界面(左栏 + 预览 + 时间轴 + AI 栏,`workflow/editing.md`「编辑界面」)。
   * 用户 2026-10-23 裁定:不另起「专业模式」这个名字,就用语义里已有的「传统式」。
   */
  onPro: () => void;
  onClose: () => void;
  /** 把一张卡引用进输入框 */
  onQuote: (text: string) => void;
}): JSX.Element {
  const duration = useStore((s) => Math.max(0.1, s.project.duration));
  const total = useStore((s) => s.project.duration);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);

  return (
    <div className="ps-detail" data-pc="start-detail">
      <header className="ps-detail-head">
        <span className="ps-detail-title">详细编辑</span>
        <span className="ps-detail-sub">时间轴可调；右键一张卡可以引用进下面的输入框</span>
        <span className="ps-rail-spacer" />
        {/*
          这一页属于氛围式 —— 对着 Agent 说话、在这儿看一眼、顺手调一下;
          点这个切到「传统式」,也就是打开整套编辑界面(`user-workflow.md`「工作方式」)。
        */}
        <button type="button" className="ps-mode-btn" data-pc="start-enter-traditional" title="打开编辑界面自己动手：左栏 + 预览 + 时间轴 + AI 栏" onClick={props.onPro}>
          进入传统式
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-close" onClick={props.onClose}>
          收起
        </button>
      </header>

      <div className="ps-detail-stage">
        <VibeStage className="ps-detail-screen" pc="start-detail-stage" />
      </div>

      <div className="ps-detail-transport">
        <button type="button" className="ps-detail-play" data-pc="start-detail-play" aria-label={playing ? "暂停" : "播放"} onClick={() => actions.togglePlay()}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
          )}
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind" onClick={() => { actions.pause(); actions.seek(0); }}>
          回到开头
        </button>
        <input type="range" className="ps-detail-scrub" data-pc="start-detail-scrub" min={0} max={duration} step={0.05}
          value={Math.min(t, duration)} aria-label="进度" onChange={(e) => actions.seek(Number(e.target.value))} />
        <span className="ps-detail-time">{secs(t)} / {secs(total)}</span>
      </div>

      {/*
       * 真时间轴。它自己是 `h-full`,所以这一框要有确定的高度(CSS 里 `.ps-detail-tl` 定死一截),
       * 上面的舞台拿剩下的。行高、缩放、剪辑标签都在它自带的那一条工具栏里,这里不再另给一套。
       */}
      <div className="ps-detail-tl" data-pc="start-detail-tl">
        <TimelineView
          quoteClip={(clip, label) => props.onQuote(quoteToken({ id: clip.id, label }))}
          // 叠加卡比片段细一级:一段上挂两张同名的压暗很常见,不指明哪一张 Agent 只能反问
          quoteOverlay={(clip, item) => props.onQuote(quoteToken({ id: `${clip.id}#${item.kind}:${item.refId}`, label: item.name, kind: "叠加卡" }))}
        />
      </div>
    </div>
  );
}
