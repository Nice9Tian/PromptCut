/**
 * 导出模式的页面时钟量化。
 *
 * 导出脚本每帧推进一格虚拟时间,但 React 提交、rAF 回调落在这一格里的哪个位置,
 * 取决于页面加载时消耗了多少虚拟时间,两次导出不一样。凡是读 performance.now() 或
 * rAF 时间戳的动画(Motion 的帧循环、第三方 rAF 循环)就会跟着差出零点几帧。
 *
 * 这里把两者都钉到当前帧的导出毫秒 window.__pcExportMs:同一帧里不管回调何时跑,
 * 读到的时间都一样,于是逐帧确定。Web Animations / CSS 动画不走这条路,由
 * ExportView 的 __pcSyncAnims 每帧显式钉 currentTime。
 *
 * ⚠ 页面上其实有**三个**时钟,第三个一直没写进文档,是一批确定性 bug 的来源:
 *   1. performance.now() —— 被这里钉到 __pcExportMs,每趟从 0 起。
 *   2. CDP 虚拟时间 —— 导出脚本每帧推一格。
 *   3. document.timeline.currentTime —— WAAPI 自己的时间线,**单调递增、从不归零**,
 *      而且 export-frames.mjs 的 shoot() 里那段不带预算的 policy:'advance' 会让它在页面
 *      静止的帧上一口气涨十几亿毫秒(实测一趟累计 26 亿 ≈ 33 天)。
 * Motion 建 WAAPI 动画时把 startTime 写成 time.now(),也就是 1 号时钟的读数(导出毫秒),
 * 而 WAAPI 按 3 号时钟解读它 —— 两个坐标系对不上,动画一出生就可能越过 endTime 直接
 * finished,__pcSyncAnims 又显式跳过 finished,卡片当场渲成终态。下面 patchAnimate() 就是
 * 断掉 3 号时钟对画面的影响。
 *
 * 只在导出视图里装;__pcExportMs 还没就位(时间轴加载前)时回落到真实时钟。
 */
export function installExportClock(): void {
  const w = window as Window & { __pcExportClockInstalled?: boolean };
  if (w.__pcExportClockInstalled) return;
  w.__pcExportClockInstalled = true;

  const realNow = performance.now.bind(performance);
  performance.now = () => (typeof window.__pcExportMs === "number" ? window.__pcExportMs : realNow());

  const realRaf = window.requestAnimationFrame.bind(window);
  // 原始 rAF 留一份给导出脚本:它每帧要等一次 rAF,走包过的那层会把 __pcRafCount 顶起来,
  // 静态判定就永远为假。
  window.__pcRealRaf = realRaf;
  window.__pcRafCount = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    // 计数用于静态帧判定:见 clock.ts 里 __pcRafCount 的说明。
    window.__pcRafCount = (window.__pcRafCount ?? 0) + 1;
    return realRaf((ts) => cb(typeof window.__pcExportMs === "number" ? window.__pcExportMs : ts));
  };

  /*
   * DOM 变动计数 —— 静态帧判定的主力。
   *
   * 上面那个 rAF 计数抓不到 Motion 的 JS 动画:motion-dom 的 frameloop 在**模块求值时**就把
   * 原始 requestAnimationFrame 存进了批处理器(frameloop/frame.mjs),而 ESM 的 import 求值
   * 早于本函数被调用,替换永远够不着它。把安装时机提前倒是能罩住,但那会连带换掉 Motion 拿到的
   * 时间戳来源 —— 为一个启发式去动确定性的根基,不划算。
   *
   * 换个抓法:JS 动画再怎么绕过 rAF,每帧总要把新值写回 style 或文本节点,这个躲不掉。
   * 于是盯 DOM 变动。它同时还罩住了卡片重挂载那几帧(getAnimations() 那时还是空的,
   * 因为 Motion 要到下一帧才建动画,而画面已经在变了)。
   */
  patchAnimate();

  window.__pcMutationCount = 0;
  new MutationObserver((records) => {
    window.__pcMutationCount = (window.__pcMutationCount ?? 0) + records.length;
  }).observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

/**
 * 让 WAAPI 动画一出生就停在 0,时间此后由 __pcSyncAnims 独占。
 *
 * 为什么要这么做:Motion 建 WAAPI 动画时会把 startTime 写成 time.now()(= 被钉住的
 * performance.now,也就是导出毫秒,每趟从 0 起),而 WAAPI 按 document.timeline.currentTime
 * 解读 startTime —— 后者单调递增从不归零,烘一趟就能涨到十几亿(见文件头「三个时钟」)。
 * 于是「开烘那一刻 timeline 已经是多少」直接决定了新建的动画会不会一出生就 finished:
 *   - 复用同一个 document 连烘两次:第二趟 timeline 已到 164 亿,全部动画出生即 finished,
 *     __pcSyncAnims 又跳过 finished,卡片直接渲成终态 —— rank-bars 差 26 帧、growth-curve 差 65 帧。
 *   - 就算每趟都开全新的页面也不安全:开烘那一刻 timeline 是 590 还是 650ms 取决于这次加载
 *     花了多久,endTime 落在这个区间里的动画(rank-bars 第一行:delay 0 / dur 500)就随机
 *     出生即 finished。实测两个全新浏览器烘同一张 rank-bars 差 16 帧(第 0~11 帧整行入场没播),
 *     也就是说**现有的一次性导出路径本来就不是确定的**,只是掷硬币两次常常掷到同一面。
 *
 * 修法:把动画一建出来就 pause 并钉到 0,并把这个实例的 startTime 这个 JS setter 吞掉
 * (Motion 自己在 NativeAnimationExtended 的注释里就写了「给 paused 的 WAAPI 动画设
 * startTime 会把它 unpause」)。此后动画时间完全来自 __pcSyncAnims 的锚点,和 timeline 无关。
 * 实测(90 帧 / 1920x1080 / 30fps / PNG 逐字节比):复用 bakery 连烘两次 rank-bars 26 → 0 帧;
 * 两个全新浏览器之间 rank-bars 16 → 0 帧;odometer / ring-metric / type-shift 本来就 0,没被带坏。
 * growth-curve 的 65 帧也没了,但它另有一类每帧固定 23 个像素的残差(玻璃板圆角的抗锯齿,
 * 新鲜 vs 新鲜同样发生,和这条修法无关),见 scripts/export-frames.mjs 的文件头注释。
 *
 * ⚠ 这一改必须和 export-frames.mjs 里每帧的 settle()(排空 React 挂起的提交)配套:动画真的
 * 会播之后,「卡片挂载提交落在哪一帧」才开始影响画面,而那件事以前是在截图窗口里和截图抢跑的。
 * 只加这一层、不加 settle,demo 时间轴上 npm run verify 会在卡片切换处红 12 帧;两个都在则 90/90。
 *
 * ⚠ 约定:导出页里 animation.startTime 恒为 null,不要拿它做算术。a.finish() 走的是规范内部
 * 逻辑、不经过这个访问器,照常收束到 endTime。
 * ⚠ 导出产物会变(变对了):endTime 小于「开烘那一刻 timeline」的动画以前从来没播过入场,
 * 现在会正常淡入。任何逐像素基线快照都要重新生成。
 */
function patchAnimate(): void {
  const realAnimate = Element.prototype.animate;
  Element.prototype.animate = function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const a = realAnimate.call(this, keyframes, options);
    try {
      a.pause();
      a.currentTime = 0;
      Object.defineProperty(a, "startTime", { get: () => null, set: () => {}, configurable: true });
    } catch {
      // 异常实现放过:宁可这条动画不确定,也不能让导出页整个崩掉
    }
    return a;
  };
}
