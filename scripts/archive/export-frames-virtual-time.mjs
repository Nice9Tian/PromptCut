import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * 逐帧导出。确定性模型:
 *   - 页面时间由 CDP 虚拟时间驱动,每帧推进 1000/fps ms;Motion 的 JS 动画读 performance.now(虚拟),天然逐帧一致。
 *   - CSS / Web Animations 的动画钟和虚拟时钟不同步,不靠实测比值校正(比值随机器负载变),
 *     而是每帧在虚拟时间暂停后由页面里的 __pcSyncAnims() 把每个动画的 currentTime 显式钉到
 *     「导出毫秒 − 该动画首次出现那一帧的导出毫秒」,再截图。与负载无关,导两遍逐帧相同。
 *   - rAF 等待必须在推进预算之前发出:预算耗尽后虚拟时间暂停,rAF 永远不会再回调。
 *   - 还有第三个时钟 document.timeline(WAAPI 用它解读 startTime,单调递增从不归零)。
 *     它以前会让动画一出生就 finished、画面直接跳终态,现在由 exportClock.ts 的 patchAnimate
 *     从根上断掉。详见那里的注释。
 *
 *   - 每帧推完预算后还要 settle() 一次,把 React 挂着的提交排空再截图 —— 否则那批活儿只能
 *     在截图窗口里和截图抢跑。见下面 settle 的注释。
 *
 * 还剩一类小两个数量级的残差,和上面这些无关,修完仍然偶发(≈每几趟出现一趟、每趟 1~3 帧,
 * 机器负载重时更频繁):rank-bars 第 18 帧固定 5 个像素(一条柱右端圆头的抗锯齿),
 * growth-curve 固定 23 个像素(数字徽标 + 曲线/标签),最大通道差 5~26。特征:
 *   - 同一个 DOM 连截 6 张逐字节相同,两派的 outerHTML / getBoundingClientRect 完全一致 ——
 *     不是页面算错了,是同一份几何被光栅成了两个样子(疑似部分重绘的失效区边界);
 *   - 只烘目标帧一帧(前面的帧只推时间不截图)时 6/6 稳定,逐帧都截才会两派分化;
 *   - 全新浏览器之间同样发生,不是复用引入的,demo 时间轴上暂时没踩到。
 * 这条建议单独立案,大概率要从卡片侧下手(把 `v.on("change", setState)` 改成同步写 DOM,
 * 照 magicui/vendor/number-ticker.tsx 的写法),不在这一轮的改动范围里。
 */
/**
 * 在一个已经起好的浏览器里开一个**全新的 page**,装好拦截、导航到导出页、等页面就绪。
 *
 * 为什么一定要新开 page 而不是在旧 page 上重新 goto:虚拟时间策略是**按 renderer** 记的。
 * 旧 page 烘过帧之后策略停在 pause,此时连主文档请求都不会完成,直接 goto 必然 30 秒超时;
 * 而先 setVirtualTimePolicy({policy:'advance'}) 再 goto 虽然能导航成功(实测 148~207ms),
 * 加载期间虚拟时间会无节制狂奔,新文档经历的加载时序和「虚拟时间从没启用过」的全新浏览器
 * 完全不同 —— 实测这样烘出来的帧和全新浏览器差 26(rank-bars)/65(growth-curve)帧,
 * 等于悄悄换了一套确定性基线。新开的 page 是一个全新的 renderer,从没被启用过虚拟时间,
 * 和全新浏览器等价,实测逐字节一致。
 */
async function newSession(browser, url) {
  const page = await browser.newPage();
  page.on('console', msg => { if (msg.type() !== 'debug') console.log('PAGE LOG:', msg.text()); });
  const client = await page.createCDPSession();

  // 推进一格虚拟时间,同时等一次 rAF(rAF 只会在预算窗口内触发,所以要先挂上再推进)。
  // 预算迟迟不 expire 说明页面还挂着网络请求(pauseIfNetworkFetchesPending 会一直暂停),显式报错比假死好。
  const advance = async (budget) => {
    let timer;
    const expired = new Promise((resolve, reject) => {
      client.once('Emulation.virtualTimeBudgetExpired', resolve);
      timer = setTimeout(() => reject(new Error(
        'virtualTimeBudgetExpired 超时:页面可能有一直挂着的网络请求(pauseIfNetworkFetchesPending 会一直暂停虚拟时间)'
      )), 30000);
    });
    // 用未被计数的原始 rAF:走 exportClock 包过的那层会把 __pcRafCount 顶起来,
    // 于是「这一格没有新的 rAF 注册」这个静态判据永远为假,静态跳过就一帧也命中不了。
    const rafDone = page.evaluate(() => new Promise(r => {
      const raf = window.__pcRealRaf || window.requestAnimationFrame.bind(window);
      raf(() => r());
    })).catch(() => {});
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget });
    try {
      await expired;
    } finally {
      clearTimeout(timer);
    }
    // 预算内正常会回调;万一没回调(页面这一格没产生帧)也不能卡死,node 侧兜底
    await Promise.race([rafDone, new Promise(r => setTimeout(r, 500))]);
  };

  // 页面侧带超时的 evaluate:虚拟时间暂停时页面的 setTimeout 不会触发,超时必须放 node 侧
  const evalWithTimeout = (fn, ms) => Promise.race([
    page.evaluate(fn).catch(() => {}),
    new Promise(r => setTimeout(r, ms)),
  ]);

  // 挡掉 Vite 的 HMR/心跳,免得它们在虚拟时间里挂着网络请求
  await page.evaluateOnNewDocument(() => {
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (typeof input === 'string' && input.includes('__vite_ping')) {
        return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      return originalFetch.call(window, input, init);
    };
    class MockWebSocket extends EventTarget {
      constructor() {
        super();
        this.readyState = 1;
        setTimeout(() => this.dispatchEvent(new Event('open')), 10);
      }
      send() {}
      close() {}
    }
    window.WebSocket = MockWebSocket;
    window.location.reload = () => console.log('Intercepted location.reload');
  });

  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: 'load' });

  console.log('Waiting for window.__pcReady...');
  await page.waitForFunction(() => window.__pcReady === true, { timeout: 60000, polling: 100 });

  return {
    page, client, advance, evalWithTimeout,
    /**
     * 原地换一个项目再等就绪 —— 不重新导航,走的是页面里的 install 自己。
     *
     * ⚠ 单用它复用**不满足逐帧确定性**,不要拿它直接跑导出交付物 —— 要复用请走 bakery.reset()。
     * 原因:同一个 document 连烘两次时,Motion 写给 WAAPI 的 startTime 用的是「导出毫秒」
     * (performance.now 被 exportClock 钉到 __pcExportMs,每趟从 0 起),而 WAAPI 按
     * document.timeline.currentTime 解读它 —— 后者单调递增、从不归零,而且 shoot() 里那段
     * 不带预算的 policy:'advance' 会让它在页面静止的帧上一口气涨十几亿毫秒(实测一趟累计 26 亿)。
     * 于是第二趟新建的动画一出生就越过 endTime、直接 finished,__pcSyncAnims 又显式跳过
     * finished,卡片直接渲成终态:rank-bars 差 26 帧、growth-curve 差 65 帧,而且差的都是
     * 动画期那几十帧(结束后逐字节相同)。odometer / ring-metric 干净只是因为它们一条 WAAPI
     * 动画都不建(纯 JSAnimation,时基是被钉住的 performance.now)。
     * 这也解释了为什么加预热帧"时好时坏":预热只是把 timeline 往前推,推过不同动画的
     * endTime 阈值而已(warm=8 修好 rank-bars 却把 growth-curve 从 3 帧劣化到 39 帧)。
     * 只压虚拟时间预算不管用 —— 实测把 timeline 从 26 亿压到 3.5 万,差异帧数一帧没少,
     * 因为 35 秒仍远大于动画时长(500~1280ms);两个时钟坐标系不同才是病根。
     *
     * 它现在的正当用途:reset() 内部的一步(在**全新 page** 上灌项目,那里没有上面的问题),
     * 以及不在意逐像素一致的场合(比如只想看一眼画面)。
     */
    async loadProject(project) {
      await page.evaluate((p) => window.__pcLoadProject(p), project);
      await page.waitForFunction(() => window.__pcReady === true, { timeout: 60000, polling: 50 });
    },
  };
}

/**
 * 开一个「烘焙间」:起浏览器、装好拦截、导航到导出页、等页面就绪。
 *
 * 单独拆出来是为了让常驻进程复用同一个浏览器。现在 /api/export 每次都 spawn 一个新 node 子进程,
 * 实测这条路固定要 4.4 秒才开始出第一帧(node 启动 + 起 Chrome + goto + 字体首次布局);
 * 在已经热着的 node 里直接开 bakery 只要 0.58 秒。一次性导出付一遍无所谓,但「改完参数
 * 立刻重烘一次给预览看」这个用法每次都重付的话,剩下的优化全被它盖过去。
 *
 * 复用姿势:每趟烘帧之前调一次 `await bakery.reset(project)`(换 page,省掉起 Chrome 的钱),
 * 然后照常 bakeFrames。别用 loadProject 原地换 —— 理由见上面。
 */
export async function openBakery(opts = {}) {
  const url = opts.url || 'http://127.0.0.1:5190/?export=1';

  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 60000,
    // 桌面壳里导出时不让 Chrome 窗口出现在屏幕上
    args: [
      '--window-position=-32000,-32000', '--hide-scrollbars',
      // 软件光栅化:GPU 光栅化在旋转/缩放的抗锯齿边缘上两次不完全一致(实测每帧差十几个像素、幅度 ≤ 8/255)
      '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing',
      '--font-render-hinting=none', '--force-device-scale-factor=1',
      // 关掉部分光栅化:上一帧的截图会改变合成器下一帧的失效区边界,同一份几何被光栅成两个样子。
      // 特征是每几趟出现一趟、单帧 3~23 个像素、幅度 ≤27/255(圆角/字形边缘的抗锯齿)。
      // 实测 demo 时间轴第 1 帧:不加 6 趟里 2 趟差 16px,加了 8/8 逐字节一致。
      '--disable-partial-raster',
      // 全部动画走主线程:CSS transform/opacity 动画默认跑在合成器线程,主线程 __pcSyncAnims 已经
      // pause 了它还晚一拍,截图那帧又按自己的钟走半格(约 16ms)。负载重时 demo 第 0 帧 probe 卡的
      // pcSpin 方块整个时有时无(3359 像素、通道差 255)。另一个会话的 A/B(两组各 30 趟同时跑
      // 互相制造负载,只导第 0-1 帧):不加翻 6 次,加了 0 次。软件合成本来就开着,线程动画只剩风险。
      '--disable-threaded-animation',
      // WebGL:上面那串 --disable-gpu* 把它一起关死了 —— 不是「慢一点」,是 getContext('webgl')
      // 直接返回 null,three.js 那类卡在导出里会渲成一张空画布,而且**不报错**
      // (空 canvas 的 PNG 也有一千多字节,只看文件大小根本发现不了)。
      // 这个标志把 SwiftShader 的软件 WebGL 打开。名字里的 unsafe 指的是「没有 GPU 沙箱那层保障」,
      // 不是画得不准 —— 实测同一个三角形连画三趟 PNG 逐字节相同(hash 9ec00ecd ×3),
      // 确定性正是导出这条路唯一在乎的东西。
      // 加它也不动老基线:demo 时间轴第 0~14 帧,开与不开烘出来 15/15 逐字节相同
      // (它只是给 WebGL 上下文补了一个软件实现,2D 那条光栅路径本来就已经是软件的了)。
      '--enable-unsafe-swiftshader',
      // 实验/排查用:PC_CHROME_ARGS="--flag-a --flag-b" 追加启动参数,不设就是上面这套
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
    ],
  });

  const bakery = {
    browser,
    ...(await newSession(browser, url)),
    /**
     * 换一趟新的:开一个全新 page(可选地把项目灌进去),换掉 bakery 上的 page/client/advance,
     * 再关掉旧 page。**这是复用 bakery 的唯一正确姿势**:新 page 是一个全新的 renderer,
     * 从没被启用过虚拟时间,和全新起一个浏览器等价。
     * 实测(1920x1080 / 30fps / 90 帧 / PNG,配合 exportClock 的 patchAnimate):
     *   - 复用连烘两趟:rank-bars 26 → 0 帧,odometer / ring-metric / type-shift 0 → 0 帧;
     *   - 复用烘的 vs 全新起浏览器烘的:rank-bars 四趟(2 新鲜 + 2 复用)两两 6/6 全 0 帧;
     *   - staticSkip 开着的复用烘焙 vs 不开跳过的新鲜烘焙:rank-bars 0 帧。
     * growth-curve 另有一类和复用无关的残差(每帧固定 23 个像素,新鲜 vs 新鲜同样发生),
     * 见文件头注释,别把它算在这条路上。
     *
     * 旧 page 必须关:每趟漏一个不关,renderer 进程线性泄漏(这台机器多开 Chrome 复现过 0xC0000142)。
     * 关掉时它的虚拟时间还停在 pause,close 不受影响。
     * 实测 reset 全程 200~345ms(含关旧页),冷启动(起 Chrome + goto + 灌项目)459ms,每趟省约 250ms。
     *
     * `nextUrl` 换一个导出页地址再开(不给就还用开 bakery 时那个)。常驻 worker 要它:
     * 每趟烘的是**不同的**隔离项目(`?timeline=/@export/<id>/project.json`),而项目由页面自己
     * 去 fetch,所以换项目就得换地址。走 goto 而不是 loadProject 是有意的 —— 新 page 上
     * goto 和「全新起一个浏览器」等价,而 loadProject 那条路的确定性问题见它自己的说明。
     */
    async reset(project, nextUrl) {
      const old = bakery.page;
      const s = await newSession(browser, nextUrl || url);
      if (project) await s.loadProject(project);
      Object.assign(bakery, s);
      await old.close();
    },
    /**
     * 放开虚拟时间。bakeFrames 每帧以 setVirtualTimePolicy({policy:'pause'}) 收尾,整趟烘完
     * 策略就停在 pause —— 此时 Blink 不推进任务队列,连主文档请求都不会完成,拿这个 page 再
     * page.goto/reload 必然 30 秒超时(实测 waitUntil 换成 domcontentloaded 一样超时,
     * 因为导航根本没 commit)。要在旧 page 上再导航就得先调这个。
     * ⚠ 放开之后 advance 不带预算,页面会以最高速空转 rAF/timer 烧 CPU,用完尽快 close。
     */
    releaseClock: () => bakery.client.send('Emulation.setVirtualTimePolicy', { policy: 'advance' }),
    close: () => browser.close(),
  };
  return bakery;
}

/**
 * 在一个已经开着的 bakery 上烘一段帧。返回给 ffmpeg 用的那些参数。
 *
 * 实测每帧 106ms 的去向(rank-bars,1080p):截图 90.7ms 占 85%,推进虚拟时间 13.3ms 占 13%,
 * 其余全部加起来 2ms。所以能动的只有截图那一块,而且**跳过一帧比换编码格式值钱得多**。
 *
 * opts:
 *   format/quality —— 'png' 带 alpha(导出交付物要),'jpeg' 不带(预览烘焙够用)。
 *                     注意 JPEG 在真实卡片上只快两成:卡片大部分区域全透明,PNG 压透明区几乎免费。
 *                     合成的全屏不透明页面上是 200.9ms vs 49.3ms,那个四倍不能拿来预期。
 *   staticSkip     —— 画面静止的帧直接复用上一张,连截都不截,省掉整整 90.7ms。
 *                     判据见 ExportView 的 __pcStaticProbe
 *   verifyEvery    —— 连续复用多少帧就强制真截一张比对一次
 */
export async function bakeFrames(bakery, opts = {}) {
  const { page, client, advance, evalWithTimeout } = bakery;
  const outDir = opts.out || 'out';
  const warmFrames = opts.warm ?? 3;
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = opts.quality ?? 80;
  const wantStaticSkip = opts.staticSkip ?? false;
  const verifyEvery = opts.verifyEvery ?? 10;
  const ext = format === 'jpeg' ? 'jpg' : 'png';

  const framesDir = path.join(outDir, 'frames');
  // PC_EXPORT_TRACE=1 时每帧记录页面时钟和全部动画状态到 <out>/trace.json,排查确定性问题用
  const trace = process.env.PC_EXPORT_TRACE ? [] : null;
  await fs.mkdir(framesDir, { recursive: true });

  const timeline = await page.evaluate(() => window.__pcTimeline);
  if (!timeline) throw new Error('Timeline not found');

  const width = timeline.width || 1920;
  const height = timeline.height || 1080;
  const fps = opts.fps || timeline.fps || 30;
  const budget = 1000 / fps;
  let startFrame = 0;
  let endFrame = Math.floor((timeline.duration || 20) * fps) - 1;
  if (opts.frames) {
    const [a, b] = opts.frames.split('-').map(Number);
    startFrame = a;
    endFrame = b;
  }
  /*
   * **只截这几帧**(离散取样)。给预烘用:它要的是一张卡的若干个**时刻**,不是连续一段。
   *
   * 为什么值这一改:不管要第几帧,下面 renderPass 都从第 0 帧顺推(确定性要求 —— 动画的锚点是
   * 「首次出现那一帧」,跳着推就没有锚点,按 delta 积分的卡片也会走样)。所以烘同一张卡的 N 个时刻,
   * 分 N 趟就是 N 次重复顺推,是 O(N²);一趟推过去沿途截,推进只付一次。
   * 实测(1920x1080、7 个时刻):分趟 30.7s → 一趟 6.9s;推一帧约 18~23ms,截一张约 78ms。
   *
   * 静态跳过在这种模式下必须关死:它的 lastBuf 是「上一张真截的」,离散取样时那可能是几十帧之前,
   * 直接复用就是把时间轴压扁;verifyEvery 又是按「连续跳过次数」计数的,离散下那个保险也失效。
   */
  const targetFrames = Array.isArray(opts.targetFrames) && opts.targetFrames.length
    ? new Set(opts.targetFrames.map((n) => Math.max(0, Math.round(Number(n)))))
    : null;
  if (targetFrames) {
    startFrame = Math.min(...targetFrames);
    endFrame = Math.max(...targetFrames);
  }
  // 离散取样和静态跳过不兼容(见上),这里一律关掉,不看调用方传了什么
  const staticSkip = targetFrames ? false : wantStaticSkip;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // 从这一刻起页面时间归导出脚本管
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

  // 透明底**一次性**打开,不用 puppeteer 的 omitBackground。
  // omitBackground 是每截一张就 setDefaultBackgroundColorOverride 开一次、截完再关一次,
  // 这一开一关会让页面重绘一遍,而它和 shoot() 里那段自由跑的虚拟时间抢跑
  // —— 实测这是玻璃卡片圆角上那类残差的大头(experiment: opts.stickyOmit)。
  if (format !== 'jpeg') {
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const shotOpts = format === 'jpeg'
    // 预览烘焙不需要 alpha —— 预览窗口看的就是合成结果
    ? { type: 'jpeg', quality }
    : { type: 'png' };

  /**
   * 截一张,返回 Buffer。
   * 截图要等页面出一帧,而虚拟时间暂停时只有主线程有可见改动 Chrome 才会出帧(全是合成层动画或空舞台时就永远不出)。
   * 所以先把截图的 promise 挂上,再放虚拟时间让 BeginFrame 跑起来,截完立刻 pause。
   * 此时动画已全部 pause 并钉住、页面时钟已量化,这一小段里内容不会变,只是让帧产生。
   *
   * ⚠ 这里的 advance **故意不带预算**,别去"优化"它。不带预算时虚拟时间在这个窗口里无节制
   * 狂奔(实测页面静止的帧单帧涨 13 亿 ms、一趟累计 26 亿 ms ≈ 33 天),看着吓人,但正因为
   * 跑到"无穷远",所有挂着的 setTimeout / 宏任务都被一次跑完,窗口结束时页面处在同一个
   * 稳定态。换成有界预算(实测 17ms 一格、截到就停、最多 40 格)反而不确定:一帧要放几格
   * 取决于截图这次实际花了多少真实时间,于是每趟放行的定时器数量不一样 —— 用 demo 时间轴
   * 跑 npm run verify,有界版是 45/90 帧不同,不带预算版是 0/90。
   * 时间线因此会顶到天文数字这件事本身不再有害:WAAPI 那条路已经由 exportClock.ts 的
   * patchAnimate 从根上和 document.timeline 解耦了(见那里的「三个时钟」)。
   */
  const shoot = async () => {
    // ⚠ 这一小段自由跑的虚拟时间里 rAF 会按真实节奏多触发几次 —— **不用堵,别改**。
    // 试过 CDP 关脚本执行(Motion 帧循环死掉,动画从第 5 帧起全冻住,三趟冻得一样,逐字节看不出来)
    // 和让包装 rAF 按住回调(word-rotate 换词那帧 1/5 抖动),都比不堵更糟。不堵是确定的:时间戳被
    // 钉住,读时间的循环多算几轮是同一个数,按 delta 走的(tsParticles)零 delta 就是空转。
    // 详见 exportClock.ts 里 rAF 包装旁的说明。
    const shot = page.screenshot(shotOpts);
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'advance' });
    try {
      return await shot;
    } finally {
      await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    }
  };

  /**
   * 把渲染器挂着的宏任务排空,直到 DOM 不再变。
   *
   * 为什么需要:虚拟时间 pause 时渲染器的任务队列是冻住的,React 经 Scheduler 的 MessageChannel
   * 排的那批活儿(卡片切换时的挂载提交、`v.on("change", setDisplayValue)` 那条异步渲染)
   * 只能在 shoot() 里放开虚拟时间的那一小段里落地 —— 那一段和截图抢跑,落不落得下取决于
   * 截图这次花了多少真实时间。实测这正是 demo 时间轴上卡片切换那一下不确定的原因:同一份
   * 代码连导两趟,blur-fade 的两条入场动画一趟在第 59 帧就建好了、另一趟到第 60 帧才建,
   * 整段入场差一帧相位(第 60~71 帧像素全不同)。
   * 放一小格虚拟时间(0.001ms)等价于「把挂着的宏任务跑完再回来」,跑到 DOM 不再变为止,
   * 截图窗口里就没有活儿可干了,React 的提交落在哪一帧只由虚拟时间决定。
   *
   * 位置必须在 __pcSyncAnims **之前**:这一小格里 CSS/WAAPI 会自己往前走一点点,随后 syncAnims
   * 会重新钉住并 pause。谁要是把它挪到 syncAnims 之后,就直接破坏了 WAAPI 那条路的确定性。
   * 代价实测约 3.4ms/帧。
   */
  const settle = async () => {
    for (let k = 0; k < 4; k++) {
      const before = await page.evaluate(() => window.__pcMutationCount ?? 0);
      await client.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: 0.001 });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('排空挂起渲染时虚拟时间预算迟迟不 expire')), 30000);
        client.once('Emulation.virtualTimeBudgetExpired', () => { clearTimeout(timer); resolve(); });
      });
      const after = await page.evaluate(() => window.__pcMutationCount ?? 0);
      if (after === before) return;
    }
  };

  // 一帧 = 下发时间 → 推进预算(React 提交、rAF、Motion 建动画都在这一格里发生)→ 排空挂起渲染 → 钉动画 → 等素材。
  // 截不截图由调用方决定(静态帧复用上一张)。返回这一帧画面静不静止。
  const step = async (frameIndex, wantTrace) => {
    // 两个计数器都要在推进之前取,和推进之后比。取值和下发时间合并成一次 evaluate,不多花一趟往返。
    const before = await page.evaluate(sec => {
      const n = { raf: window.__pcRafCount ?? 0, mut: window.__pcMutationCount ?? 0 };
      window.__pcSetT(sec);
      return n;
    }, frameIndex / fps);
    // 这一帧的 React 提交(含 clip 边界上卡片的挂载)已经在上面 __pcSetT 里 flushSync 同步落地,
    // 所以推一格就够:第一次 rAF 里 Motion 就把 WAAPI 动画建好,不依赖截图耗时。
    // (曾经试过把一格拆成两半各等一次 rAF 来"钉住"挂载后那次 rAF —— 那是在调竞态的相位,
    //  时好时坏;根因是挂载走了异步提交,治在 __pcSetT 上。)
    await advance(budget);
    await settle();
    await page.evaluate(() => { if (window.__pcSyncAnims) window.__pcSyncAnims(); });
    // 钉完动画**再**排空一次,然后才探针。__pcSyncAnims 对越过终点的动画调 finish(),Motion 会在
    // onfinish 回调里把终态写进 style —— 那是排队的任务,排空后探针的 mut 才看得见它。
    // (动画结束那一帧本身的误判由 probe.finished 兜住,见下面;这里的排空是让探针拿到干净的 DOM 状态。)
    // 此时活动动画已全部 pause 并钉住,JS 动画读的是被钉住的 performance.now,settle 的微量推进
    // 不会挪动任何画面值,只是让排队的任务跑完。
    await settle();
    const probe = await page.evaluate(() => window.__pcStaticProbe ? window.__pcStaticProbe() : null);
    if (trace && wantTrace) trace.push(await page.evaluate((i) => ({
      i, perfNow: performance.now(), timelineNow: document.timeline.currentTime, probeMs: window.__pcProbeMs,
      anims: document.getAnimations().map(a => [a.playState, a.currentTime, a.startTime, a.effect && a.effect.target && a.effect.target.className && String(a.effect.target.className).slice(0, 24)]),
    }), frameIndex));
    await evalWithTimeout(() => Promise.all([...document.images].map(img => img.decode().catch(() => {}))), 3000);
    await evalWithTimeout(() => (window.__pcFrameReady ? window.__pcFrameReady() : Promise.resolve()), 3000);
    // 四个条件同时成立才算静止,少一个都会渲出坏帧 —— 理由见 ExportView 的 __pcStaticProbe。
    // 两个计数器比的是「推进这一格之后的值」和「推进之前的值」:相等就说明这一格里
    // 既没人改 DOM、也没人再要下一帧。
    // finished:这一帧被 __pcSyncAnims 收束的动画数。动画在这一帧从"还差一小段"跳到终态,画面变了,
    // 但收束后 anims 里已经没有它、DOM 也没动 —— 只看 anims 会在动画结束那一帧误判静止。
    const isStatic = !!probe && probe.anims === 0 && probe.finished === 0 && probe.mut === before.mut
      && probe.raf === before.raf && !probe.video && !probe.canvas;
    if (process.env.PC_STATIC_TRACE) {
      console.log(`  静态判定 帧${frameIndex}: anims=${probe?.anims} finished=${probe?.finished} mut=${before.mut}->${probe?.mut} raf=${before.raf}->${probe?.raf} video=${probe?.video} canvas=${probe?.canvas} => ${isStatic ? '静止' : '在变'}`);
    }
    return isStatic;
  };

  // 预热:让字体、布局、首批挂载稳定下来,然后重新挂载全部卡片并清空动画锚点,正式从第 0 帧开始。
  // 预热帧也真截一张丢掉 —— 第一次截图要初始化编码器,不预热的话这笔钱会记在第 0 帧头上。
  const warmUp = async () => {
    console.log(`Warm-up ${warmFrames} frames...`);
    for (let i = 0; i < warmFrames; i++) {
      await step(0, false);
      await shoot();
    }
    await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });
    // 重挂载之后再走一整帧并丢掉:重挂载会让整页失效重绘,而这次重绘的光栅结果和之后
    // 稳定下来的不完全一样(实测第 0 / 第 1 帧偶发几十个像素的圆角抗锯齿差)。让这一次
    // 落在丢掉的帧上,正式的第 0 帧就和后面的帧处在同一种绘制状态。锚点在这之后再清一次。
    await step(0, false);
    await shoot();
    await page.evaluate(() => { window.__pcResetAnims && window.__pcResetAnims(); });
  };

  const totalFrames = targetFrames ? targetFrames.size : endFrame - startFrame + 1;
  const durationSec = (totalFrames / fps).toFixed(3);
  let reused = 0;

  /**
   * 跑一遍全部帧。allowSkip 为假时每帧老老实实真截。
   * 返回判错的帧号;没判错返回 null。
   */
  const renderPass = async (allowSkip) => {
    let lastBuf = null;  // 上一张**真截**出来的图
    let runLen = 0;      // 已经连续复用了几帧
    reused = 0;
    for (let i = 0; i <= endFrame; i++) {
      const wantShot = targetFrames ? targetFrames.has(i) : i >= startFrame;
      const isStatic = await step(i, wantShot);
      if (!wantShot) continue;

      let buf;
      if (allowSkip && isStatic && lastBuf) {
        runLen++;
        if (runLen % verifyEvery === 0) {
          // 便宜的保险:连续复用到第 verifyEvery 帧就强制真截一张比一次。
          // 静态判据漏了什么(将来新加的 CSS 属性、卡片自己开 canvas)都会在这里当场暴露,
          // 而不是等用户看到坏帧。对不上就整趟作废重跑,所以判错的代价是慢一倍,不是渲错。
          const real = await shoot();
          if (!real.equals(lastBuf)) return i;
          lastBuf = real;
          buf = real;
        } else {
          buf = lastBuf;
          reused++;
        }
      } else {
        runLen = 0;
        buf = await shoot();
        lastBuf = buf;
      }
      await fs.writeFile(path.join(framesDir, `${String(i).padStart(6, '0')}.${ext}`), buf);
      if (process.env.PC_EXPORT_VERBOSE || (i - startFrame + 1) % 10 === 0 || i === endFrame) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
    }
    return null;
  };

  const startTime = Date.now();
  let mismatchAt = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.warn(`静态跳过在第 ${mismatchAt} 帧判错(复用的和真截的不一致),禁用跳过重跑一遍`);
    }
    await warmUp();
  mismatchAt = await renderPass(staticSkip && attempt === 0);
    if (mismatchAt === null) break;
  }

  if (trace) await fs.writeFile(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 1));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Export finished in ${elapsed}s (${totalFrames} frames${reused ? `, ${reused} reused` : ''}).`);
  return { framesDir, ext, fps, width, height, startFrame, endFrame, totalFrames, durationSec, reused, elapsed };
}

/** 一次性导出:自己开 bakery、烘帧、合成视频、关掉。CLI 和现有的 /api/export 走这条。 */
export async function exportFrames(opts) {
  const outDir = opts.out || 'out';
  const noVideo = opts.noVideo || false;
  const bakery = opts.bakery || await openBakery(opts);
  let baked;
  try {
    baked = await bakeFrames(bakery, opts);
  } finally {
    if (!opts.bakery) await bakery.close();
  }
  const { framesDir, ext, fps, width, height, startFrame, durationSec } = baked;

  if (!noVideo) {
    console.log('Running ffmpeg to generate video files...');
    const localAppData = process.env.LOCALAPPDATA || '';
    const ffmpegFallback = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
    let ffmpegCmd = 'ffmpeg';
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-version']);
        proc.on('close', code => code === 0 ? resolve() : reject());
        proc.on('error', reject);
      });
    } catch {
      ffmpegCmd = ffmpegFallback;
    }
    const runFfmpeg = (args) => new Promise((resolve, reject) => {
      const proc = spawn(ffmpegCmd, args, { stdio: 'inherit' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
      proc.on('error', reject);
    });
    try {
      console.log('Creating overlay.mov...');
      await runFfmpeg([
        '-y', '-framerate', String(fps), '-start_number', String(startFrame),
        '-i', path.join(framesDir, `%06d.${ext}`),
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        path.join(outDir, 'overlay.mov'),
      ]);
      console.log('Creating preview.mp4...');
      await runFfmpeg([
        // 灰底是 lavfi 生成的无限流,-shortest 拦不住它(帧序列结束后 overlay 会一直重复最后一帧),
        // 必须给灰底 d= 时长并用 -t 截断,否则 ffmpeg 永远不退出、文件无限长。
        '-y', '-f', 'lavfi', '-i', `color=c=#333333:s=${width}x${height}:r=${fps}:d=${durationSec}`,
        '-framerate', String(fps), '-start_number', String(startFrame),
        '-i', path.join(framesDir, `%06d.${ext}`),
        '-filter_complex', '[0:v][1:v]overlay=eof_action=endall[out]', '-map', '[out]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(durationSec),
        path.join(outDir, 'preview.mp4'),
      ]);
      // 音轨:逐帧截图只有画面,声音在这里拼回去(配乐 + 视频自带的声音)
      try {
        const { buildAudioPlan, buildFfmpegArgs, hasAudioStream } = await import('../mux-audio.mjs');
        const projectJsonPath = path.join(outDir, 'project.json');
        if (fsSync.existsSync(projectJsonPath)) {
          const proj = JSON.parse(fsSync.readFileSync(projectJsonPath, 'utf8'));
          const ffprobeCmd = ffmpegCmd.replace(/ffmpeg(.exe)?$/i, (m) => m.toLowerCase().startsWith('ffmpeg.exe') ? 'ffprobe.exe' : 'ffprobe');
          const plan = buildAudioPlan(proj, outDir).filter((c) => hasAudioStream(c.file, ffprobeCmd));
          if (plan.length > 0) {
            const withAudio = path.join(outDir, 'preview-audio.mp4');
            console.log(`Muxing ${plan.length} audio clip(s)...`);
            await runFfmpeg(buildFfmpegArgs(path.join(outDir, 'preview.mp4'), plan, withAudio, durationSec));
            fsSync.rmSync(path.join(outDir, 'preview.mp4'));
            fsSync.renameSync(withAudio, path.join(outDir, 'preview.mp4'));
            console.log('Audio muxed into preview.mp4');
          } else {
            console.log('No audio clips; preview.mp4 stays silent.');
          }
        }
      } catch (e) {
        console.error('Audio mux failed (video is still fine):', e.message);
      }
      console.log('Video synthesis complete.');
    } catch (e) {
      console.error('FFmpeg failed:', e.message);
    }
  }
}

const isMain = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const opts = { noVideo: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--frames') opts.frames = args[++i];
    else if (args[i] === '--fps') opts.fps = parseFloat(args[++i]);
    else if (args[i] === '--warm') opts.warm = parseInt(args[++i], 10);
    else if (args[i] === '--no-video') opts.noVideo = true;
    else if (args[i] === '--format') opts.format = args[++i];
    else if (args[i] === '--quality') opts.quality = parseInt(args[++i], 10);
    else if (args[i] === '--static-skip') opts.staticSkip = true;
    else if (args[i] === '--target-frames') opts.targetFrames = args[++i].split(',').map(Number).filter(Number.isFinite);
  }
  exportFrames(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
