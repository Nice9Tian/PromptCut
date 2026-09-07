import { useEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { Stage } from "./kernel/Stage";
import { installExportClock } from "./kernel/exportClock";
import type { Timeline } from "./kernel/types";
import { flattenOverlay, videoLayersAt, type Project } from "./kernel/project";
import { demoTimeline } from "./demo";
import "./cards";

// 只要进了导出视图就把页面时钟量化到导出帧(见 exportClock.ts),必须早于任何卡片挂载
if (new URLSearchParams(location.search).has("export")) installExportClock();

function waitForVideoSeek(v: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const checkReady = () => {
      if (done) return;
      if (v.readyState >= 2) {
        done = true;
        v.removeEventListener("seeked", checkReady);
        v.removeEventListener("error", checkReady);
        v.removeEventListener("loadeddata", checkReady);
        v.removeEventListener("canplay", checkReady);
        resolve();
      }
    };
    v.addEventListener("seeked", checkReady);
    v.addEventListener("error", checkReady);
    v.addEventListener("loadeddata", checkReady);
    v.addEventListener("canplay", checkReady);
  });
}

/**
 * 把 Project 里所有素材的网络 URL 预取成 blob: URL。
 * 必须在 window.__pcReady 置位之前做完:导出脚本每帧用的虚拟时间策略是
 * pauseIfNetworkFetchesPending,而 <video> 直接指向 http(s) 素材时,它的媒体流
 * 会一直挂着网络请求,虚拟时间预算永远不会 expire,逐帧循环会卡死在第 1 帧。
 * 预取成 blob: 之后 <video> 从内存读,不再产生网络请求。
 */
async function prefetchMedia(p: Project): Promise<Project> {
  const media = await Promise.all(
    p.media.map(async (m) => {
      if (!m.url || m.url.startsWith("blob:") || m.url.startsWith("data:")) return m;
      try {
        const res = await fetch(m.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { ...m, url: URL.createObjectURL(await res.blob()) };
      } catch (e) {
        console.warn(`[ExportView] 素材预取失败,该段将没有画面: ${m.url}`, e);
        return { ...m, url: "" };
      }
    }),
  );
  return { ...p, media };
}

/**
 * 把素材完整解码进内存,直到 readyState >= HAVE_ENOUGH_DATA。
 * 同样是为了虚拟时间:只要 <video> 还在「加载中」,pauseIfNetworkFetchesPending
 * 就认为有 fetch 挂着,virtualTimeBudgetExpired 永远不触发。必须在 __pcReady 之前做完。
 * 这一步跑在导出脚本还没接管虚拟时间的阶段,所以页面里的 setTimeout 可以正常当兜底用。
 */
function warmVideo(src: string, timeoutMs = 20000): Promise<void> {
  return new Promise<void>((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn("[ExportView] 素材预热超时,继续导出", src);
      finish();
    }, timeoutMs);
    v.addEventListener("canplaythrough", finish);
    v.addEventListener("error", finish);
    v.src = src;
    v.load();
  });
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
  /** 视频素材已整段解码进内存(没有视频素材时不会用到) */
  const [mediaWarm, setMediaWarm] = useState(false);

  const projectRef = useRef<Project | null>(null);
  /** 素材 id → <video> 元素。导出要同时管多层,不能只有一个 ref */
  const videoEls = useRef<Map<string, HTMLVideoElement>>(new Map());
  const pendingSeekRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    projectRef.current = project;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, [project]);

  useEffect(() => {
    const url = new URLSearchParams(location.search).get("timeline");
    (url ? fetch(url).then((r) => r.json()) : Promise.resolve(demoTimeline))
      .then(async (json: unknown) => {
        // Project 形状(有 tracks)先把素材预取成 blob:,再进入下面的常规流程
        if (json && Array.isArray((json as Project).tracks)) return await prefetchMedia(json as Project);
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

        const p = projectRef.current;
        if (p) {
          // 这一刻可能同时有多层画面(交叉溶解),每一层各自 seek,全部就位才算这一帧准备好
          const waits: Promise<void>[] = [];
          for (const l of videoLayersAt(p, sec)) {
            if (l.media.kind === "image") continue;
            const v = videoEls.current.get(l.media.id);
            if (!v) continue;
            v.currentTime = (l.clip.mediaOffset ?? 0) + (sec - l.clip.start);
            waits.push(waitForVideoSeek(v));
          }
          pendingSeekRef.current = waits.length ? Promise.all(waits).then(() => undefined) : null;
        } else {
          pendingSeekRef.current = null;
        }
      };

      window.__pcFrameReady = () => {
        return pendingSeekRef.current || Promise.resolve();
      };

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
        setMediaWarm(false);
        const next = raw && Array.isArray((raw as Project).tracks) ? await prefetchMedia(raw as Project) : raw;
        install(next);
      };

      // 没有视频素材就直接就绪;有视频素材要等它整段解码进内存(见下面的 effect)。
      if (!proj || !proj.media.some((m) => m.url)) window.__pcReady = true;
      else Promise.all(proj.media.filter((m) => m.url).map((m) => warmVideo(m.url))).then(() => setMediaWarm(true));
    });
  }, []);

  // video 元素挂上、整段缓冲完成之后才放行 __pcReady。
  // 否则导出脚本一进 pauseIfNetworkFetchesPending 就会因为媒体流还挂着而永远等不到 budget expired。
  useEffect(() => {
    if (!mediaWarm || window.__pcReady) return;
    const els = [...videoEls.current.values()];
    if (els.length === 0) return;
    const allReady = () => els.every((e) => e.readyState >= 4);
    if (allReady()) {
      window.__pcReady = true;
      return;
    }
    // 每个元素都要听:只听第一个的话,后就绪的那一段永远不会再触发检查,导出会一直等下去
    const on = () => {
      if (allReady()) {
        window.__pcReady = true;
        for (const e of els) e.removeEventListener("canplaythrough", on);
      }
    };
    for (const e of els) e.addEventListener("canplaythrough", on);
    return () => {
      for (const e of els) e.removeEventListener("canplaythrough", on);
    };
  }, [mediaWarm, project]);

  // 画面素材(视频/图片)常驻挂载:每个素材一个元素,这样它们能在 __pcReady 之前整段缓冲完;
  // 当前时刻谁该出现、以多大不透明度出现,由 videoLayersAt 决定——两段重叠+淡化就是交叉溶解。
  // 音频不在这里出声,导出的音轨由服务端用 ffmpeg 合成。
  const visualMedia = (project?.media || []).filter((m) => m.url && m.kind !== "audio");
  const layers = project ? videoLayersAt(project, t) : [];
  const layerOf = (mediaId: string) => layers.find((l) => l.media.id === mediaId);

  useEffect(() => {
    const p = projectRef.current;
    if (!p) return;
    const waits: Promise<void>[] = [];
    for (const l of videoLayersAt(p, t)) {
      if (l.media.kind === "image") continue;
      const v = videoEls.current.get(l.media.id);
      if (!v) continue;
      const targetTime = (l.clip.mediaOffset ?? 0) + (t - l.clip.start);
      if (Math.abs(v.currentTime - targetTime) > 0.001) {
        v.currentTime = targetTime;
        waits.push(waitForVideoSeek(v));
      }
    }
    pendingSeekRef.current = waits.length ? Promise.all(waits).then(() => undefined) : null;
  }, [t, project]);

  if (!timeline) return null;

  return (
    <div style={{ position: "relative", width: timeline.width, height: timeline.height, overflow: "hidden", background: "transparent" }}>
      {visualMedia.map((m) => {
        const l = layerOf(m.id);
        const common = {
          position: "absolute" as const,
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover" as const,
          opacity: l ? l.opacity : 0,
          visibility: (l ? "visible" : "hidden") as "visible" | "hidden",
        };
        return m.kind === "image" ? (
          <img key={m.id} src={m.url} alt="" style={common} />
        ) : (
          <video
            key={m.id}
            ref={(el) => {
              if (el) videoEls.current.set(m.id, el);
              else videoEls.current.delete(m.id);
            }}
            src={m.url}
            muted
            playsInline
            preload="auto"
            style={common}
          />
        );
      })}
      <div style={{ position: "absolute", inset: 0 }}>
        <Stage timeline={timeline} t={t} playToken={playToken} />
      </div>
    </div>
  );
}
