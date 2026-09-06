/**
 * WAAPI / CSS 动画钉时间。
 *
 * 驱动式时钟能管住 Motion 的帧循环和卡片自己的 rAF,但管不到 CSS animation /
 * transition / WAAPI:它们跑在合成线程上,按浏览器自己的时钟走。
 * 做法和导出视图的 __pcSyncAnims 一样:记下每个动画头一次出现时的舞台时间当锚点,
 * 之后每帧把 currentTime 钉到「现在 − 锚点」并暂停,数值就只由时间决定,和机器快慢无关。
 */
export interface AnimationPinner {
  /** 每跑一帧调一次:nowMs = 当前舞台时间 */
  sync(nowMs: number): void;
  /** 重挂载卡片前调一次,丢掉旧锚点 */
  reset(): void;
}

export function createAnimationPinner(doc: Document = document): AnimationPinner {
  let anchors = new WeakMap<Animation, number>();
  return {
    reset() {
      anchors = new WeakMap<Animation, number>();
    },
    sync(nowMs: number) {
      for (const a of doc.getAnimations()) {
        if (a.playState === "finished" || a.playState === "idle") continue;
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
          continue;
        }
        if (a.playState !== "paused") a.pause();
        a.currentTime = target;
      }
    },
  };
}
