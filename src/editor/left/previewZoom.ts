import { useEffect, useRef, useState, type RefObject } from "react";
import { measureContentBox, unionBox, type Box } from "./contentBox";

/**
 * 预览卡的缩放:按动效**跑完整段**时内容最大的包围盒来缩,量一次、记住,之后不再动。
 *
 * 以前是悬停后在 160 / 600 / 1400ms 各量一次、每量到一次就把视野再推近一点 —— 画面会晃,
 * 而且入场从画外飞进来的动效第一次量到的是半路的框。现在:
 *   1. 第一次悬停先做一遍**测量跑**:舞台藏着(opacity 0)挂上去,等动画建好之后,把舞台里所有
 *      Web Animations 暂停、逐个时刻拨 currentTime(0 到落定时刻,每 100ms 一档),每一档量包围盒取并集。
 *      这一步是同步的,不靠 requestAnimationFrame,窗口在后台、动画被节流也照样量得出来;
 *   2. 量完存进缓存(按卡片 / 部件 id),视野一步到位推到那个盒子,再从头正常速度播一遍;
 *   3. 之后每次悬停直接用缓存,不再量。
 * 量的时长最多 MAX_MEASURE_MS;不是 Web Animations 驱动的部分(跟 t 走的 Lottie、打字机)按 t = 0 量。
 */
export interface PreviewZoom {
  /** 量出来的盒子;null = 没量到或内容铺满整幅,按整幅显示 */
  box: Box | null;
  /** 正在测量跑:舞台藏起来 */
  measuring: boolean;
  /** 每次重播 +1,和以前一样用它做 key 重挂载 */
  token: number;
}

const MAX_MEASURE_MS = 4000;
const STEP_MS = 100;
/** 挂上去之后等动画建好再量;motion 在挂载后的下一帧才创建 Web Animations */
const SETTLE_DELAY_MS = 80;
const cache = new Map<string, Box | null>();

/** 让别处(比如改了卡片源码热更新后)能把缓存丢掉 */
export function invalidatePreviewZoom(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

/** 同步量一遍:把舞台里的动画拨到各个时刻取包围盒并集;量完把动画拨回 0 */
function measureAcross(stage: HTMLElement, totalMs: number): Box | null {
  const anims = stage.getAnimations({ subtree: true });
  let union: Box | null = null;
  const set = (t: number) => {
    for (const a of anims) {
      try {
        a.pause();
        a.currentTime = t;
      } catch { /* 有的动画不让改(比如已经结束的),跳过 */ }
    }
  };
  for (let t = 0; t <= totalMs; t += STEP_MS) {
    set(t);
    union = unionBox(union, measureContentBox(stage));
  }
  set(0);
  return union;
}

export function usePreviewZoom(key: string, stageRef: RefObject<HTMLElement | null>, hot: boolean, animMs: number): PreviewZoom {
  const [box, setBox] = useState<Box | null>(() => cache.get(key) ?? null);
  const [measuring, setMeasuring] = useState(false);
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (!hot) return;
    setToken((n) => n + 1);
    if (cache.has(key)) {
      setBox(cache.get(key) ?? null);
      setMeasuring(false);
      return;
    }
    // 第一次:测量跑
    setMeasuring(true);
    const total = Math.min(MAX_MEASURE_MS, Math.max(400, animMs) + 300);
    const timer = window.setTimeout(() => {
      const stage = stageRef.current;
      const union = stage ? measureAcross(stage, total) : null;
      cache.set(key, union);
      setBox(union);
      setMeasuring(false);
      // 量完从头正常速度再播一遍
      setToken((n) => n + 1);
    }, SETTLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hot, key, animMs, stageRef]);

  return { box, measuring, token };
}

/** 有盒子就推到盒子(留一圈边),没有就整幅;返回舞台该放的位置和比例 */
export function zoomFor(box: Box | null, view: { w: number; h: number }, stage: { width: number; height: number }, pad = 0.1) {
  const fullScale = view.w && view.h ? Math.min(view.w / stage.width, view.h / stage.height) : 1;
  let scale = fullScale;
  let left = (view.w - stage.width * scale) / 2;
  let top = (view.h - stage.height * scale) / 2;
  if (box) {
    const bw = Math.max(1, box.r - box.l);
    const bh = Math.max(1, box.b - box.t);
    scale = Math.min(view.w / (bw * (1 + pad * 2)), view.h / (bh * (1 + pad * 2)));
    // 别推得比整幅还远(盒子量错成一大片时退回整幅),也别放大到糊成马赛克
    scale = Math.max(fullScale, Math.min(scale, 2));
    const cx = (box.l + box.r) / 2;
    const cy = (box.t + box.b) / 2;
    left = view.w / 2 - cx * scale;
    top = view.h / 2 - cy * scale;
  }
  return { scale, left, top };
}
