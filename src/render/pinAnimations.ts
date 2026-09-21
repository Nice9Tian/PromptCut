/**
 * WAAPI / CSS 动画钉时间。
 *
 * 驱动式时钟能管住 Motion 的帧循环和卡片自己的 rAF,但管不到 CSS animation /
 * transition / WAAPI:它们跑在合成线程上,按浏览器自己的时钟走。
 * 做法和导出视图的 __pcSyncAnims 一样:记下每个动画头一次出现时的舞台时间当锚点,
 * 之后每帧把 currentTime 钉到「现在 − 锚点」并暂停,数值就只由时间决定,和机器快慢无关。
 * 前提是动画出生时就已经停在 0 —— 由 stageClock 装的 patchAnimate 保证。少了它,动画会按
 * document.timeline 的真实时间出生即 finished,下面那句「跳过 finished」就把整个入场跳掉了。
 *
 * # 三个按子树的口子(R3:K3 / K5)
 *
 * 舞台要按**片段**做三件事,全局的 `sync` / `reset` 太粗:
 *
 *   - `resetIn(el)`  重挂载一个片段前只丢它自己的锚点(整份 WeakMap 重建会把别的卡一起清掉,
 *                    它们的入场动画会在那一刻从头播一遍);
 *   - `syncIn(el, stageMs)` 只钉这个片段子树里的动画 —— K3(a′) 的 `seekOk` 一步定位、
 *                    K5 第一路的子树追帧都用它。**时间基一律是全局舞台毫秒**:喂本地毫秒
 *                    会让锚点落在本地基上,交回全局 `sync` 时 target 多出 `clip.start × 1000`,
 *                    一把 `finish()` 到终态;
 *   - `sync(nowMs, skip)` 全局钉,但跳过 `skip` 里那些包裹层子树的动画 —— 正在自己追帧
 *                    (`.pc-settling`)或被抑制(`.pc-suppressed`)的片段不能被全局时钟拨回去。
 */
export interface AnimationPinner {
  /**
   * 每跑一帧调一次:nowMs = 当前舞台时间。
   * `skip`:这些包裹层(`[data-pc-clip]`)子树里的动画这一帧不钉(K5 第一路 / E7 第 5 条)。
   */
  sync(nowMs: number, skip?: ReadonlySet<Element>): void;
  /** 只钉 `el` 子树里的动画,时间基同样是**全局舞台毫秒**(K3(a′) / K5 第一路) */
  syncIn(el: AnimationHost | null | undefined, stageMs: number): void;
  /** 重挂载卡片前调一次,丢掉旧锚点 */
  reset(): void;
  /** 只丢 `el` 子树里那些动画的锚点(按片段重挂载,K3),别的卡不动 */
  resetIn(el: AnimationHost | null | undefined): void;
}

/** 能交出自己子树里那些动画的东西。真实场景里就是 `Element`;单测里给一个假的 */
export interface AnimationHost {
  getAnimations(options?: { subtree?: boolean }): Animation[];
}

/** 这条动画挂在哪个片段的包裹层上(找不到就是 null:不属于任何片段) */
function clipWrapperOf(a: Animation): Element | null {
  const target = (a.effect as KeyframeEffect | null)?.target ?? null;
  return target && typeof target.closest === "function" ? target.closest("[data-pc-clip]") : null;
}

export function createAnimationPinner(doc: Document = document): AnimationPinner {
  let anchors = new WeakMap<Animation, number>();

  /** 把一条动画钉到 nowMs。返回 false 表示这条不用管(已经结束 / 还没开始) */
  const pin = (a: Animation, nowMs: number): void => {
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

  return {
    reset() {
      anchors = new WeakMap<Animation, number>();
    },
    resetIn(el) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) anchors.delete(a);
    },
    sync(nowMs: number, skip?: ReadonlySet<Element>) {
      for (const a of doc.getAnimations()) {
        /*
         * 正在自己追帧 / 被抑制的片段这一帧不钉。判据是「这条动画的目标元素往上最近的
         * [data-pc-clip] 在不在 skip 里」—— 不能按 target 本身查,卡片内部随便哪一层都能起动画。
         */
        if (skip?.size) {
          const wrap = clipWrapperOf(a);
          if (wrap && skip.has(wrap)) continue;
        }
        pin(a, nowMs);
      }
    },
    syncIn(el, stageMs: number) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) pin(a, stageMs);
    },
  };
}
