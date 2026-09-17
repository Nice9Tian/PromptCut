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
 * 但只接管 performance.now 和 rAF 还不够。页面上还有第三个时钟 document.timeline.currentTime
 * (WAAPI 自己的,真实时间、从不归零),Motion 建 WAAPI 动画时把 startTime 写成被接管的
 * performance.now(舞台时间,从 0 起),WAAPI 却按第三个时钟解读它 —— 于是动画一出生
 * currentTime 就是「页面已经打开了多久」,越过 endTime 直接 finished,pinAnimations 又按约定
 * 跳过 finished,入场动画在预览里一律直接跳到终态。实测拖到 t=0.1s:导出页 20 个动画 paused
 * 在 100ms,预览页 20 个全部 finished。exportClock 的 patchAnimate 就是治这个的,这里同样要装。
 *
 * 只能装在渲染面的 iframe 里。装到编辑器主文档上会把编辑器自己的 UI 动画一起冻住。
 */
import { patchAnimate } from "../kernel/exportClock";

export interface StageClock {
  now(): number;
  /** 直接把时钟拨到某毫秒,不跑帧(用于重挂载前设定时间原点) */
  set(ms: number): void;
  /**
   * 跑一帧:时钟拨到 ms,执行这一帧排队的 rAF 回调。**返回跑了几个回调。**
   *
   * 这个数是「这一帧有没有卡片在自己动」的判据:卡片自带的循环、Motion 的帧循环都靠 rAF,
   * 一个都没有就说明这一帧没人会改自己的状态。调用方拿它决定要不要提交 React ——
   * 补跑几百帧时,大部分帧其实什么都没发生,不必每帧都渲一遍。
   */
  tick(ms: number): number;
  /**
   * 从当前时刻推进到 target,分步跑帧。
   * 一定要分步:Motion 的帧循环会把单帧 delta 夹到 40ms 上限(防切回标签页时跳变),
   * 一步跨几秒的话动画只会前进 40ms。
   */
  advanceTo(target: number, opts?: { step?: number; maxCatchUp?: number; onFrame?: (ms: number, ran: number) => void }): void;
  /**
   * 和 advanceTo 一样地补跑,但**每帧之间让出一个微任务**。
   *
   * 为什么需要这个:同步补跑跑出来的画面和「一帧一帧推过去」不一样,而导出永远是后者。
   * 实测同一个预览页、同一个 t=1.8s,跳过去和逐帧推过去,particles 差 12.9 万个像素、
   * word-rotate 差 2.2 万个 —— 差的是那些**跨不过同步块的东西**:Motion 解析关键帧、
   * AnimatePresence 换人、粒子引擎异步装载,它们都要一个任务边界才推得动。
   *
   * 让出微任务而不是真帧:微任务在同一个任务里排干,不用等 vsync,几百帧也就几十毫秒;
   * 等真帧的话跳 6 秒要等 180 个 vsync = 3 秒,没法用。
   *
   * `abort` 让新的一次渲染能把上一次还在飞的补跑掐掉(快速拖播放头时会发生)。
   */
  advanceToAsync(target: number, opts?: {
    step?: number;
    maxCatchUp?: number;
    /** **跑这一帧之前**调:提交 React。和导出的 step 同序 —— 那边也是先 __pcSetT 再推虚拟时间 */
    onFrame?: (ms: number) => void;
    /** 跑完这一帧的 rAF 回调之后调:钉动画(这一帧里新建的动画要在这时候才拿得到) */
    afterFrame?: (ms: number) => void;
    abort?: () => boolean;
    /**
     * 每推这么多帧就让出一个**宏任务**(真 setTimeout 0),不只是微任务。
     * 后台舞台的探针(K1)用它:一张卡推几百帧时主线程不能一直被占着,
     * 父页的 RPC 消息、iframe 自己的 resize 都得有机会进来。缺省不让(只让微任务)。
     */
    yieldEvery?: number;
  }): Promise<void>;
}

const DEFAULT_STEP = 1000 / 60;
/** 补跑上限(ms):落后超过这么多就先把时钟直接拨到 target-上限,再分步跑完最后这段 */
const DEFAULT_MAX_CATCH_UP = 6000;

export function installStageClock(): StageClock {
  const w = window as Window & { __pcStageClock?: StageClock };
  if (w.__pcStageClock) return w.__pcStageClock;

  // WAAPI 动画一出生就停在 0,时间此后完全由 pinAnimations 的锚点决定(见文件头「第三个时钟」)
  patchAnimate();

  let now = 0;
  let nextId = 1;
  let queue: { id: number; cb: FrameRequestCallback }[] = [];

  /*
   * 真墙钟留一份(J4 / K1):接管之后 performance.now 恒等于舞台时间,量探针耗时、
   * RPC 回包里的 elapsedMs、K4 的拍长都不能再用它。setTimeout 同理留一份真的(E4b:
   * 暂停态虚拟时钟不动,.pc-awaiting 的 500 ms 兜底要靠真时钟)。
   */
  window.__pcRealNow = performance.now.bind(performance);
  window.__pcRealSetTimeout = window.setTimeout.bind(window);
  performance.now = () => now;
  /*
   * 原始 rAF 留一份。**接管之后页面里就再没有「等浏览器画一帧」的办法了** —— 而有些活儿
   * 非等不可:Motion 解析关键帧要跨一个任务边界,跳转那一下的补跑是同步跑完的,它来不及,
   * 卡片就停在 initial 那一帧(见 StageView 里 settle 的说明)。
   * 和 exportClock 挂同一个名字,两边取法一致。
   */
  window.__pcRealRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    queue = queue.filter((e) => e.id !== id);
  };

  const tick = (ms: number): number => {
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
    return due.length;
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
        opts.onFrame?.(target, tick(target));
        return;
      }
      if (target - now > maxCatchUp) now = target - maxCatchUp;
      let ms = now;
      while (ms < target) {
        ms = Math.min(target, ms + step);
        opts.onFrame?.(ms, tick(ms));
      }
      if (now !== target) {
        opts.onFrame?.(target, tick(target));
      }
    },
    async advanceToAsync(target, opts = {}) {
      const step = opts.step ?? DEFAULT_STEP;
      const maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
      if (target < now) {
        now = target;
        opts.onFrame?.(target);
        tick(target);
        opts.afterFrame?.(target);
        return;
      }
      if (target - now > maxCatchUp) now = target - maxCatchUp;
      /*
       * 一帧里的顺序:**让出微任务 → 拨时钟 → 提交 React → 跑 rAF 回调 → 钉动画**。
       *
       * 和导出的 step() 逐步对齐:那边 `__pcSetT(sec)` 里先写 `__pcExportMs` 再 flushSync 提交,
       * 然后 `advance(budget)` 推一格虚拟时间跑这一帧,最后 `__pcSyncAnims()` 钉动画。
       * 少了「先拨时钟」这一步,React 渲染时读到的 performance.now 还是上一帧的;顺序反过来的话,
       * 凡是要**量布局**
       * 的东西就会比导出差一帧 —— 实测 chapter-bar 里 layoutId 那块高亮,预览被投影补了
       * translateY(-13.442px),而导出是 none,那 13.44 正好是父元素一帧的位移量。
       *
       * 让出微任务是给跨不过同步块的东西留口子(Motion 解析关键帧、粒子引擎异步装载)。
       */
      let ms = now;
      let ran = 0;
      const realTimeout = window.__pcRealSetTimeout ?? window.setTimeout.bind(window);
      while (ms < target) {
        if (opts.yieldEvery && ran > 0 && ran % opts.yieldEvery === 0) await new Promise<void>((r) => realTimeout(r, 0));
        else await Promise.resolve();
        if (opts.abort?.()) return;
        ran++;
        ms = Math.min(target, ms + step);
        now = ms;                 // 先拨时钟:React 渲染时读到的就是这一帧
        opts.onFrame?.(ms);       // 提交
        tick(ms);                 // 跑这一帧的 rAF 回调
        opts.afterFrame?.(ms);    // 钉动画
      }
      await Promise.resolve();
      if (opts.abort?.()) return;
      if (now !== target) { now = target; opts.onFrame?.(target); tick(target); opts.afterFrame?.(target); }
    },
  };

  w.__pcStageClock = clock;
  return clock;
}
