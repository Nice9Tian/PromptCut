/**
 * WAAPI / CSS 动画钉时间。
 *
 * 驱动式时钟能管住 Motion 的帧循环和卡片自己的 rAF,但管不到 CSS animation /
 * transition / WAAPI:它们跑在合成线程上,按浏览器自己的时钟走。
 * 做法和导出视图的 __pcSyncAnims 一样:记下每个动画头一次出现时的舞台时间当锚点,
 * 之后每帧把 currentTime 钉到「现在 − 锚点」并暂停,数值就只由时间决定,和机器快慢无关。
 * 前提是动画出生时就已经停在 0 —— 由 stageClock 装的 patchAnimate 保证。少了它,动画会按
 * document.timeline 的真实时间出生即 finished,下面那句「跳过 finished」就把整个入场跳掉了。
 */
export interface AnimationPinner {
  /** 每跑一帧调一次:nowMs = 当前舞台时间 */
  sync(nowMs: number): void;
  /** 重挂载卡片前调一次,丢掉旧锚点 */
  reset(): void;
  /**
   * **只清一个片段子树的锚点**(K3 的「重挂载定位配方」第一步)。
   * `reset()` 是把整份 `WeakMap` 换掉,会连带把别的卡的锚点也丢了 —— 重挂载的粒度是片段,
   * 探针的复位、K5 第一路的起步、K3(a′) 的向后跳都只该动这一张卡。
   */
  resetIn(el: Element): void;
  /**
   * **只钉一个片段子树的动画**(K5 第一路 / K1 的两趟布尔探针)。
   *
   * `stageMs` 的时间基**一律是全局舞台毫秒**,和 `sync` 同一个基 —— 喂本地毫秒会让锚点
   * 落在本地基上,交回全局 `sync` 时 `target` 多出 `clip.start × 1000`,下面那句
   * 「越过结尾就 finish()」会一把把它推到终态(K5 点名的坑)。
   */
  syncIn(el: Element, stageMs: number): void;
}

export function createAnimationPinner(doc: Document = document): AnimationPinner {
  let anchors = new WeakMap<Animation, number>();

  /** 一条动画钉到 nowMs。`sync` 和 `syncIn` 共用同一段,免得两处的锚点规则走偏 */
  const pin = (a: Animation, nowMs: number) => {
    if (a.playState === "finished" || a.playState === "idle") return;
    let anchor = anchors.get(a);
    if (anchor === undefined) {
      anchor = nowMs;
      anchors.set(a, anchor);
    }
    const target = Math.max(0, nowMs - anchor);
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && Number.isFinite(end) && target >= end) {
      // 越过结尾:finish() 让 Motion 提交终态、CSS 动画回到自然样式,和正常播完一致
      a.finish();
      return;
    }
    if (a.playState !== "paused") a.pause();
    a.currentTime = target;
  };

  /** 一个子树里的动画。老浏览器 / 测试替身没有 getAnimations 时当空表,不抛 */
  const inSubtree = (el: Element): Animation[] => {
    try {
      return typeof el?.getAnimations === "function" ? el.getAnimations({ subtree: true }) : [];
    } catch {
      return [];
    }
  };

  return {
    reset() {
      anchors = new WeakMap<Animation, number>();
    },
    resetIn(el: Element) {
      for (const a of inSubtree(el)) anchors.delete(a);
    },
    sync(nowMs: number) {
      for (const a of doc.getAnimations()) pin(a, nowMs);
    },
    syncIn(el: Element, stageMs: number) {
      for (const a of inSubtree(el)) pin(a, stageMs);
    },
  };
}
