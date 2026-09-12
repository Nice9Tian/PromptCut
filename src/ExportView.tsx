import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { FrameScene } from "./render/FrameScene";
import { Stage } from "./kernel/Stage";
import { installExportClock } from "./kernel/exportClock";
import type { Timeline } from "./kernel/types";
import { flattenOverlay, type Project } from "./kernel/project";
import { themeStyle } from "./themes";
import { frameWorkStatus, waitForFrameWork } from "./kernel/frameReady";
import { demoTimeline } from "./demo";
import "./cards";

// 只要进了导出视图就把页面时钟量化到导出帧(见 exportClock.ts),必须早于任何卡片挂载
if (new URLSearchParams(location.search).has("export")) installExportClock();

/*
 * ?cardsOnly=1:素材(视频 / 图片)一概不挂,只渲卡片的透明层。
 * 默认导出和 see_frames 走完整的 Chrome FrameScene；显式 --media=ffmpeg 时才走这条
 * 卡片透明层旁路。保留 cardsOnly 是为了兼容旁路和需要只烘卡片的调用。
 */
const CARDS_ONLY = new URLSearchParams(location.search).get("cardsOnly") === "1";
function stripMedia(p: Project): Project {
  return { ...p, media: [], tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => !c.mediaId) })) };
}

/**
 * 导出视图(?export=1)。导出脚本的每帧顺序:
 *   1. page.evaluate(window.__pcSetT(sec))  → 写 __pcExportMs、setT 触发 React 重渲染
 *   2. 推进 CDP 虚拟时间 1/fps(React 提交、rAF、Motion 建动画都在这一格里发生)
 *   3. window.__pcSyncAnims() 把所有 Web Animations 的 currentTime 钉到导出时间
 *   4. 等素材(图片 decode、视频 seek)→ 截图
 * 页面挂载后把 window.__pcReady 置 true,脚本等它。
 * 时间轴可由 ?timeline=<url> 指定(JSON),默认用 demo。
 */
export default function ExportView() {
  const [t, setT] = useState(0);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [playToken, setPlayToken] = useState(1);
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    const url = new URLSearchParams(location.search).get("timeline");
    (url ? fetch(url).then((r) => r.json()) : Promise.resolve(demoTimeline))
      .then(async (json: unknown) => {
        // Project 形状(有 tracks)先把素材预取成 blob:,再进入下面的常规流程
        if (json && Array.isArray((json as Project).tracks)) return CARDS_ONLY ? stripMedia(json as Project) : (json as Project);
        return json;
      })
      // 命名函数表达式:函数体既是首次加载的装配流程,也是换项目时要重跑的那一套。
      // 取个名字就能在体内自己调用(见下面的 __pcLoadProject),不用把这一大块抽出去。
      .then(function install(json: any) {
      let tl: Timeline;
      let proj: Project | null = null;

      if (json && Array.isArray(json.tracks)) {
        proj = json as Project;
        tl = flattenOverlay(proj);
      } else {
        tl = json as Timeline;
      }

      setProject(proj);
      setTimeline(tl);
      window.__pcTimeline = tl;
      window.__pcExportMs = 0;


      window.__pcSetT = (sec: number) => {
        window.__pcExportMs = sec * 1000;
        // flushSync:和下面 __pcRestartCards 同一个理由 —— 这一帧的渲染(尤其是 clip 边界上
        // 卡片的挂载/卸载)必须在这次调用里同步提交完。不然 React 把它排进调度器,落在
        // 下一格虚拟时间的哪个位置取决于这一帧截图花了多少真实时间;Motion 要等挂载提交后的
        // 下一次 rAF 才建 WAAPI 动画,于是动画有时算进这一帧、有时要到下一帧才被 __pcSyncAnims
        // 看见,锚点差一帧,整段入场差一帧相位。实测 demo 时间轴 blur-fade 卡切进来那一段
        // (第 60~71 帧)连导两趟约一半概率全不同,就是它。同步提交之后,挂载在推进虚拟时间之前
        // 就已落地,第一次 rAF 里 Motion 就把动画建好,不再依赖截图耗时。
        flushSync(() => setT(sec));

      };
      window.__pcFrameReady = waitForFrameWork;
      window.__pcFrameWorkStatus = frameWorkStatus;

      // flushSync:重挂载在这次调用里同步完成。否则 React 的调度任务落在下一格虚拟时间的哪个位置
      // 两次导出不一样,卡片的第一帧就会差一帧。
      window.__pcRestartCards = () => {
        // 随机种子先拨回起点,再重挂载:卡片挂载时抽的随机数(粒子初始位置之类)每趟都一样
        window.__pcResetRandom?.(1);
        flushSync(() => setPlayToken((n) => n + 1));
      };

      // 动画锚点:每个 Web Animation 首次出现那一帧的导出毫秒。
      // 导出脚本每帧推进完虚拟时间后调 __pcSyncAnims,把 currentTime 钉到「现在 − 锚点」再截图。
      // CSS / WAAPI 动画钟和虚拟时钟不同步,用实测比值校正 playbackRate 会随机器负载变;显式钉时间与负载无关。
      let anchors = new WeakMap<Animation, number>();
      window.__pcResetAnims = () => {
        anchors = new WeakMap<Animation, number>();
      };
      // 必须 pause:transform / opacity 这类动画跑在合成线程上,只设 currentTime 不暂停的话,
      // 截图那一帧合成器仍按它自己的时钟采样,两次导出差零点几帧。暂停后数值只由 currentTime 决定。
      // 越过结尾的用 finish():Motion 等 finished 才提交终态样式,CSS 动画则回到自然样式,和正常播完一致。
      // 这一帧被 finish() 收束的动画数。静态判定要看它:动画在这一帧从"还差一小段"跳到终态,
      // 画面是变了的,但收束之后 getAnimations() 里它已经是 finished、DOM 也没被改过 ——
      // 探针只看得见"结束后的状态",看不见"在这一帧结束"这件事。实测 type-shift 外层过渡恰好在
      // 第 6 帧结束,静态跳过复用了第 5 帧,和不跳过差 28085 个像素。
      let finishedThisFrame = 0;
      window.__pcSyncAnims = () => {
        const now = window.__pcExportMs ?? 0;
        finishedThisFrame = 0;
        for (const a of document.getAnimations()) {
          if (a.playState === "finished" || a.playState === "idle") continue;
          let s0 = anchors.get(a);
          if (s0 === undefined) {
            s0 = now;
            anchors.set(a, s0);
          }
          const target = Math.max(0, now - s0);
          const end = a.effect?.getComputedTiming().endTime;
          if (typeof end === "number" && Number.isFinite(end) && target >= end) {
            a.finish();
            finishedThisFrame++;
            continue;
          }
          if (a.playState !== "paused") a.pause();
          a.currentTime = target;
        }
      };
      /**
       * 这一帧画面静不静止。四个条件同时成立才算,因为单看任何一个都会漏:
       *   anims —— getAnimations() 只看得见 CSS/过渡/WAAPI;
       *   mut   —— 补上它看不见的 JS 动画(Motion 的 MotionValue,例如 rank-bars 的滚动数值),
       *            以及卡片刚重挂载、动画还没建起来那几帧 —— 那时 anims 是 0,画面却在变;
       *   raf   —— 走了被替换的 rAF 的第三方循环。Motion 走不到这里(见 exportClock.ts),
       *            留着是因为不要钱,多罩一层算一层;
       *   video —— 前三个都看不见的第四种变化:底下 <video> 在放。它自己会变,而且
       *            卡片上的 backdrop-filter 毛玻璃会把它的变化采样进来,于是毫无动画的玻璃板也在逐帧变。
       * 判静态是为了复用上一帧的截图,判错了会渲出坏帧,所以宁可保守。
       */
      window.__pcStaticProbe = () => ({
        anims: document.getAnimations().filter((a) => a.playState !== "finished" && a.playState !== "idle").length,
        finished: finishedThisFrame,
        raf: window.__pcRafCount ?? 0,
        mut: window.__pcMutationCount ?? 0,
        video: Array.from(document.querySelectorAll("video")).some((v) => {
          const s = getComputedStyle(v);
          return s.visibility !== "hidden" && parseFloat(s.opacity) > 0;
        }),
        // canvas 上画的东西不在 DOM 里,MutationObserver 看不见;有可见的 canvas 就不敢判静止
        canvas: Array.from(document.querySelectorAll("canvas")).some((c) => {
          const s = getComputedStyle(c);
          return s.visibility !== "hidden" && parseFloat(s.opacity) > 0 && c.width > 0 && c.height > 0;
        }),
      });
      /**
       * 原地换一个项目,不重新导航。常驻烘焙进程靠它复用同一个页面:
       * 起 Chrome + goto + 字体首次布局加起来是固定的几秒钟,每烘一次都重付一遍太贵。
       * 走的是 install 自己,和重新加载页面同一条路径,不会两套行为。
       */
      window.__pcLoadProject = async (raw: unknown) => {
        window.__pcReady = false;
        const next = raw && Array.isArray((raw as Project).tracks)
          ? (CARDS_ONLY ? stripMedia(raw as Project) : (raw as Project))
          : raw;
        install(next);
      };

      window.__pcReady = true;
    });
  }, []);

  if (!timeline) return null;

  return (
    <div
      style={{
        position: "relative",
        width: timeline.width,
        height: timeline.height,
        overflow: "hidden",
        background: "transparent",
        /*
         * **主题变量必须挂在这里**,和 StageView 那一处对齐。
         *
         * 少了它,卡片里每一处 `var(--pc-…, 兜底)` 在导出里都会走兜底 —— 而预览走的是主题值。
         * 默认主题下大部分兜底和主题值碰巧相同,所以这条漏了很久都没被发现;只有等宽字体
         * 露了馅:主题是 `ui-monospace, Consolas, monospace`,兜底是 `ui-monospace, monospace`,
         * 后者在 Windows 上落到 NSimSun —— 预览里是带斜杠零的 Consolas,成片里是一套衬线字。
         * 换个主题(比如 Courier New 那套、或者任何改了配色的)就是全线不一致。
         */
        ...themeStyle(timeline.themeId),
      }}
    >
      {project ? <FrameScene project={project} t={t} playToken={playToken} />
        : <Stage timeline={timeline} t={t} playToken={playToken} />}

    </div>
  );
}
