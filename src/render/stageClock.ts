/**
 * 驱动式时钟(渲染面 ?stage=1 专用)。
 *
 * 预览窗口不该「按墙上时钟自己播」——它要显示的是时间轴 t 那一帧。
 * 所以在渲染面这个独立文档里把时间接管掉:performance.now() 读我们给的值,
 * requestAnimationFrame 不再由浏览器触发,而是排进队列、由 tick() 显式跑。
 * Motion 的帧循环、卡片自己的 rAF 循环都读这两个,于是「现在是第几帧」完全由我们说了算。
 *
 * 和导出内核(kernel/exportClock.ts)是同一个思路:那边的时间由 CDP 虚拟时间推,
 * 这边由编辑器下发的 t 推。卡片代码两边一模一样,所以预览所见 = 导出所得。
 *
 * 只能装在渲染面的 iframe 里。装到编辑器主文档上会把编辑器自己的 UI 动画一起冻住。
 */

export interface StageClock {
  now(): number;
  /** 直接把时钟拨到某毫秒,不跑帧(用于重挂载前设定时间原点) */
  set(ms: number): void;
  /** 跑一帧:时钟拨到 ms,执行这一帧排队的 rAF 回调 */
  tick(ms: number): void;
  /**
   * 从当前时刻推进到 target,分步跑帧。
   * 一定要分步:Motion 的帧循环会把单帧 delta 夹到 40ms 上限(防切回标签页时跳变),
   * 一步跨几秒的话动画只会前进 40ms。
   */
  advanceTo(target: number, opts?: { step?: number; maxCatchUp?: number; onFrame?: (ms: number) => void }): void;
}

const DEFAULT_STEP = 1000 / 60;
/** 补跑上限(ms):落后超过这么多就先把时钟直接拨到 target-上限,再分步跑完最后这段 */
const DEFAULT_MAX_CATCH_UP = 6000;

export function installStageClock(): StageClock {
  const w = window as Window & { __pcStageClock?: StageClock };
  if (w.__pcStageClock) return w.__pcStageClock;

  let now = 0;
  let nextId = 1;
  let queue: { id: number; cb: FrameRequestCallback }[] = [];

  performance.now = () => now;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    queue = queue.filter((e) => e.id !== id);
  };

  const tick = (ms: number) => {
    now = ms;
    // 先取走再跑:回调里重新注册的 rAF 属于下一帧,不然会在同一帧里无限自我调用
    const due = queue;
    queue = [];
    for (const e of due) {
      try {
        e.cb(ms);
      } catch (err) {
        console.error("[stageClock] rAF 回调抛错", err);
      }
    }
  };

  const clock: StageClock = {
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    tick,
    advanceTo(target, opts = {}) {
      const step = opts.step ?? DEFAULT_STEP;
      const maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
      if (target < now) {
        // 往回走:调用方负责重挂载,这里只把时钟拨过去
        now = target;
        tick(target);
        opts.onFrame?.(target);
        return;
      }
      if (target - now > maxCatchUp) now = target - maxCatchUp;
      let ms = now;
      while (ms < target) {
        ms = Math.min(target, ms + step);
        tick(ms);
        opts.onFrame?.(ms);
      }
      if (now !== target) {
        tick(target);
        opts.onFrame?.(target);
      }
    },
  };

  w.__pcStageClock = clock;
  return clock;
}
