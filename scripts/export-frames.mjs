import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * 逐帧导出 —— beginFrame 后端。
 *
 * # 为什么换掉虚拟时间那一套
 *
 * 原来的做法(已归档到 scripts/archive/export-frames-virtual-time.mjs)是 CDP 虚拟时间推一格,
 * 再用 `page.screenshot` 截图。慢不在编码:同一状态下截 1×1 的小图 66.7ms、截全屏 85ms ——
 * 截多大几乎一样慢,钱花在「为了截图让 Chrome 出一帧」上,外加截图时临时放开虚拟时间那一整套往返。
 *
 * 这里改用 chrome-headless-shell 的 `HeadlessExperimental.beginFrame`:**帧时间由我们给**,
 * 一拍里跑完 rAF + 画 + 截图,不再需要虚拟时间。实测(docs/render-rebuild-plan.md 阶段 1):
 *   - demo 全长 1800 帧:旧 107.7 ms/帧 → 这里 26.9 ms/帧,约 4 倍;
 *   - 和旧管线逐帧对账:两边各自两趟都是 1800/1800,彼此不一致的帧全部来自系统字体回退(已在主题里修掉),
 *     不是出帧方式的差异;
 *   - 旧管线自己偶发不确定(一次 600 帧两趟 13 帧不同),这里四次两两比对全部相同。
 *
 * # 每帧的步骤,和旧管线逐条对应
 *
 *   旧                                                  这里
 *   __pcSetT                                            同
 *   setVirtualTimePolicy(pauseIfNetworkFetchesPending)   等网络(Network 域数在路上的请求,清零才往下)→ 排空 → beginFrame() → 等网络
 *   settle():放 0.001ms 虚拟时间                        页面内 setTimeout(0),直到 __pcMutationCount 不再变
 *   __pcSyncAnims → settle → 等图片 decode / __pcFrameReady  同(合并成两次页面内调用)
 *   page.screenshot + 截图时切 advance                   beginFrame({ screenshot })
 *   预热 3 帧 → __pcRestartCards → 再丢 1 帧              同
 *
 * **等网络那一步不能省**:scene-3d 在提前挂载的那一帧动态 `import("three")`,不等它回来,三维画面
 * 晚一帧出现(实测第 119 帧 32 万像素不同);补上之后逐字节一致。旧管线靠 pauseIfNetworkFetchesPending
 * 隐式做了这件事。
 *
 * # 页面时钟
 *
 * performance.now / rAF 仍由 src/kernel/exportClock.ts 钉到 __pcExportMs;随机数、墙上时钟、crypto
 * 由 src/kernel/pinEntropy.ts 钉死。beginFrame 给的帧时间只要求单调递增,画面不读它。
 *
 * # 依赖
 *
 * 需要 chrome-headless-shell(`HeadlessExperimental` 域只在它里面有)。开发机上 puppeteer 默认就装;
 * 桌面安装包由 desktop/scripts/prepare-runtime.mjs 一起拷进 runtime/chrome。
 * 锁死版本:这是实验性 CDP 域,升级 Chrome 前先跑一遍 scripts/verify-determinism.mjs。
 */

/** 一拍的名义间隔(ms)。帧时间只要单调递增,取多少不影响画面 —— 画面读的是 __pcExportMs */
const FRAME_INTERVAL = 1000 / 60;

const CHROME_ARGS = [
  // beginFrame 的前提:渲染器不再自己出帧,每一帧都等我们发 BeginFrame
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
  '--hide-scrollbars',
  // 软件光栅化:GPU 光栅化在旋转/缩放的抗锯齿边缘上两次不完全一致(实测每帧差十几个像素、幅度 ≤ 8/255)
  '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing',
  '--font-render-hinting=none', '--force-device-scale-factor=1',
  // 关掉部分光栅化:上一帧的截图会改变合成器下一帧的失效区边界,同一份几何被光栅成两个样子
  '--disable-partial-raster',
  // 全部动画走主线程:合成器线程上的动画在截图那帧会按自己的钟多走半格
  '--disable-threaded-animation',
  // 上面那串 --disable-gpu* 会把 WebGL 一起关死(getContext 返回 null,three.js 卡渲成空画布且不报错);
  // 这个标志打开 SwiftShader 软件 WebGL,同一个三角形连画三趟逐字节相同
  '--enable-unsafe-swiftshader',
  // 实验/排查用:PC_CHROME_ARGS="--flag-a --flag-b" 追加启动参数
  ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
];

/**
 * 每个新文档加载前注入。挡掉 Vite 的 HMR / 心跳(它们会一直挂着网络请求),再放两个页面内的小工具:
 *   __bfSettle —— 让挂着的宏任务跑完,直到 DOM 不再变。React 经 Scheduler 的 MessageChannel 排的提交、
 *                 `v.on("change", setState)` 那条异步渲染都在这里落地;不排空的话它们会落到哪一帧取决于运气。
 *   __bfAssets —— 等图片 decode 和视频 seek(__pcFrameReady),各自最多 3 秒。
 * 没有虚拟时间以后,页面里的 setTimeout 是真的会走的,所以这两件事可以在页面里做,省几趟往返。
 */
function PAGE_PRELUDE() {
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    if (typeof input === 'string' && input.includes('__vite_ping')) {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return originalFetch.call(window, input, init);
  };
  class MockWebSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; setTimeout(() => this.dispatchEvent(new Event('open')), 10); }
    send() {}
    close() {}
  }
  window.WebSocket = MockWebSocket;
  window.location.reload = () => console.log('Intercepted location.reload');
  window.__bfSettle = async () => {
    for (let k = 0; k < 4; k++) {
      const b = window.__pcMutationCount ?? 0;
      await new Promise((r) => setTimeout(r, 0));
      if ((window.__pcMutationCount ?? 0) === b) return;
    }
  };
  window.__bfAssets = async () => {
    const cap = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 3000))]);
    await cap(Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
    await cap(window.__pcFrameReady ? window.__pcFrameReady() : Promise.resolve());
  };
  /*
   * 把此刻的舞台冻结成一份自给自足的 HTML(HTML 采样缓存,见 scripts/replay-frames.mjs)。
   * 三件事都是实测踩过的:
   *   - 全部计算样式内联,并写死 animation:none / transition:none —— 注入后不能再有任何还在走的钟;
   *   - id 统一改名并同步改掉 url(#…) / href="#…" —— SVG 渐变按 id 引用,重放页里要是还能解析到别的
   *     同名元素,填充整片错掉(growth-curve 实测);
   *   - canvas 换成同尺寸的图(读得出像素的话)—— 克隆出来的画布是空的,粒子和三维画面会整个消失。
   *     读不出来(被污染、WebGL 没开 preserveDrawingBuffer)就留空画布,返回里 lossy 计数。
   */
  window.__bfFreeze = () => {
    const stage = document.getElementById('root')?.firstElementChild;
    if (!stage) return { html: '', lossy: 0 };
    const clone = stage.cloneNode(true);
    const orig = [stage, ...stage.querySelectorAll('*')];
    const copy = [clone, ...clone.querySelectorAll('*')];
    let lossy = 0;
    for (let i = 0; i < orig.length; i++) {
      const cs = getComputedStyle(orig[i]);
      let s = '';
      for (let k = 0; k < cs.length; k++) { const q = cs.item(k); s += q + ':' + cs.getPropertyValue(q) + ';'; }
      s += 'animation:none !important;transition:none !important;';
      copy[i].setAttribute('style', s);
      if (orig[i].tagName === 'CANVAS') {
        let src = null;
        try { src = orig[i].toDataURL('image/png'); } catch { src = null; }
        if (src && src.length > 22) {
          const img = document.createElement('img');
          img.setAttribute('style', s);
          img.setAttribute('width', String(orig[i].width));
          img.setAttribute('height', String(orig[i].height));
          img.src = src;
          copy[i].replaceWith(img);
        } else lossy++;
      }
    }
    let html = clone.outerHTML;
    const ids = new Set([...stage.querySelectorAll('[id]')].map((e) => e.id).concat(stage.id ? [stage.id] : []));
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const id of ids) {
      const e = esc(id);
      html = html
        .replace(new RegExp(`(\\sid=")${e}(")`, 'g'), `$1${id}__r$2`)
        .replace(new RegExp(`(url\\((?:&quot;|["'])?[^)"'&]*#)${e}((?:&quot;|["'])?\\))`, 'g'), `$1${id}__r$2`)
        .replace(new RegExp(`((?:xlink:)?href="#)${e}(")`, 'g'), `$1${id}__r$2`);
    }
    return { html, lossy };
  };
}

/**
 * 在一个已经起好的浏览器里开一个**全新的、受帧控制的 page**,导航到导出页、等页面就绪。
 *
 * 为什么每趟都开新 page:页面上有动画锚点、已挂载的卡片、推到片尾的状态,原地再烘一趟拿到的不是
 * 第 0 帧的画面。新 page 是一个全新的 renderer,和全新起一个浏览器等价。
 * 页面必须用 `Target.createTarget({ enableBeginFrameControl: true })` 开 —— `browser.newPage()`
 * 开出来的页面不受帧控制,beginFrame 对它无效。
 */
async function newSession(browser, url) {
  const bs = await browser.target().createCDPSession();
  let targetId;
  try {
    ({ targetId } = await bs.send('Target.createTarget', { url: 'about:blank', enableBeginFrameControl: true, width: 1920, height: 1080 }));
  } finally {
    await bs.detach().catch(() => {});
  }
  const target = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 30000 });
  const page = await target.page();
  page.on('console', (msg) => { if (msg.type() !== 'debug') console.log('PAGE LOG:', msg.text()); });
  const client = await page.createCDPSession();
  await client.send('Page.enable');

  /*
   * 等网络:对应旧管线的 pauseIfNetworkFetchesPending。请求一直不回来(比如某个长连接)就显式报错,
   * 假死更糟。事件驱动:没有请求在路上时立刻返回,不白等。
   */
  /** requestId → 这条请求是什么,超时报错时要说得出是谁挂着 */
  const inflight = new Map();
  let waiters = [];
  const drained = () => {
    if (inflight.size) return;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  };
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (e) => {
    /*
     * <video>/<audio> 的媒体流不算。一段大视频挂在页面上,它的请求会一直开着边播边取,
     * 永远等不到 loadingFinished —— 算进来的话每帧都要白等满 30 秒然后报错(实测一个项目挂了
     * 20 段视频、最大 265 MB,导出一帧都出不来)。视频这一层有它自己的等法:ExportView 的
     * __pcFrameReady 逐层等 seek 到位,这里再等一遍既不需要也等不到。
     */
    if (e.type === 'Media') return;
    inflight.set(e.requestId, `${e.type || '?'} ${String(e.request?.url || '').slice(0, 120)}`);
  });
  for (const ev of ['Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache']) {
    client.on(ev, (e) => { inflight.delete(e.requestId); drained(); });
  }
  const waitNet = (ms = 30000) => (inflight.size === 0 ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `${inflight.size} 个网络请求 ${ms / 1000} 秒还没回来:页面可能挂着一直不结束的请求。`
      + `前几个:${[...inflight.values()].slice(0, 3).join(' | ')}`
    )), ms);
    waiters.push(() => { clearTimeout(timer); resolve(); });
  }));

  let tick = 1000;
  const beginFrame = (extra = {}) => client.send('HeadlessExperimental.beginFrame', {
    frameTimeTicks: (tick += FRAME_INTERVAL), interval: FRAME_INTERVAL, ...extra,
  });

  // 页面侧带超时的 evaluate(给调用方兜底用;虚拟时间没了以后页面自己的定时器也可靠了)
  const evalWithTimeout = (fn, ms) => Promise.race([
    page.evaluate(fn).catch(() => {}),
    new Promise((r) => setTimeout(r, ms)),
  ]);

  /** 等 window.__pcReady。受帧控制的页面不自己出帧,等的时候要一直发空拍(不画不截) */
  const waitReady = async () => {
    const t0 = Date.now();
    for (;;) {
      await beginFrame({ noDisplayUpdates: true }).catch(() => {});
      if (await page.evaluate(() => window.__pcReady === true).catch(() => false)) return;
      if (Date.now() - t0 > 60000) throw new Error('导出页 60 秒没就绪(window.__pcReady 一直不是 true)');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  await page.evaluateOnNewDocument(PAGE_PRELUDE);
  console.log(`Navigating to ${url}...`);
  await client.send('Page.navigate', { url });
  console.log('Waiting for window.__pcReady...');
  await waitReady();

  return {
    page, client, beginFrame, waitNet, evalWithTimeout,
    /**
     * 原地换一个项目再等就绪 —— 不重新导航。只在 reset() 里、在**全新 page** 上用;
     * 在用过的页面上原地换项目,动画锚点和已挂载的卡片都是上一趟的,拿到的不是第 0 帧。
     */
    async loadProject(project) {
      await page.evaluate((p) => window.__pcLoadProject(p), project);
      await waitReady();
    },
  };
}

/**
 * puppeteer 这一版要的 chrome-headless-shell 版本号。从 puppeteer-core 的 revisions 表里读 ——
 * 和 desktop/scripts/prepare-runtime.mjs 读 Chrome 版本是同一个来源,两边对得上。
 */
async function headlessShellBuildId() {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  const pkgDir = path.dirname(require_.resolve('puppeteer-core/package.json'));
  for (const rel of ['lib/esm/puppeteer/revisions.js', 'lib/cjs/puppeteer/revisions.js', 'lib/puppeteer/revisions.js']) {
    const f = path.join(pkgDir, rel);
    if (!fsSync.existsSync(f)) continue;
    const src = fsSync.readFileSync(f, 'utf8');
    const m = src.match(/['"]chrome-headless-shell['"]\s*:\s*['"]([^'"]+)['"]/) || src.match(/\bchrome\s*:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  throw new Error('读不到 puppeteer-core 的 chrome-headless-shell 版本号');
}

/** 同一个进程里并发开 bakery(分片导出)时只装一次 */
let installingShell = null;

/** 把 chrome-headless-shell 装进 puppeteer 的缓存目录(桌面版 = runtime/chrome) */
async function installHeadlessShell() {
  installingShell ??= (async () => {
    const os = await import('node:os');
    const { install, Browser, detectBrowserPlatform } = await import('@puppeteer/browsers');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
    const buildId = await headlessShellBuildId();
    console.log(`安装 chrome-headless-shell@${buildId} 到 ${cacheDir}(约 100 MB,只装这一次)…`);
    await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform: detectBrowserPlatform() });
  })();
  try {
    await installingShell;
  } finally {
    installingShell = null;
  }
}

/**
 * 开一个「烘焙间」:起浏览器、导航到导出页、等页面就绪。
 *
 * 单独拆出来是为了让常驻进程(scripts/render-worker.mjs)复用同一个浏览器:冷启动要几秒,
 * 复用只要换一个 page。复用姿势:每趟烘帧之前调一次 `await bakery.reset(project, url)`,然后 bakeFrames。
 */
export async function openBakery(opts = {}) {
  const url = opts.url || 'http://127.0.0.1:5190/?export=1';

  console.log('Launching Puppeteer (chrome-headless-shell)...');
  const launch = () => puppeteer.launch({ headless: 'shell', protocolTimeout: 60000, args: CHROME_ARGS });
  let browser;
  try {
    browser = await launch();
  } catch (e) {
    if (!/could not find/i.test(e?.message || '')) throw e;
    /*
     * 没找到就现装一份。为什么需要这一步:更新补丁只带 runtime/app(Node 那半边),不带 runtime/chrome;
     * 从 0.3.x 打补丁升上来的用户手里只有完整 Chrome、没有 headless-shell,导出会直接起不来。
     * 装进 PUPPETEER_CACHE_DIR(桌面版 = runtime/chrome),只装这一次;装不上(没网)就报清楚该怎么办。
     */
    console.warn('没找到 chrome-headless-shell,尝试自动安装……');
    try {
      await installHeadlessShell();
    } catch (e2) {
      throw new Error(
        '导出需要 chrome-headless-shell,没找到,自动安装也失败了(' + (e2?.message || e2) + ')。' +
        '桌面版请用完整安装包重装一次;开发机上跑 `npx puppeteer browsers install chrome-headless-shell`。原始错误:' + e.message,
      );
    }
    browser = await launch();
  }

  const bakery = {
    browser,
    ...(await newSession(browser, url)),
    /**
     * 换一趟新的:开一个全新 page(可选地把项目灌进去),换掉 bakery 上的 page/client,再关掉旧 page。
     * 旧 page 必须关:每趟漏一个不关,renderer 进程线性泄漏(这台机器多开 Chrome 复现过 0xC0000142)。
     * `nextUrl` 换一个导出页地址再开 —— 常驻 worker 每趟烘的是不同的隔离项目,项目由页面自己去 fetch。
     */
    async reset(project, nextUrl) {
      const old = bakery.page;
      const s = await newSession(browser, nextUrl || url);
      if (project) await s.loadProject(project);
      Object.assign(bakery, s);
      await old.close();
    },
    /** 旧管线里「放开虚拟时间」的接口。这里没有虚拟时间,保留成空操作,老调用方不用改 */
    releaseClock: async () => {},
    close: () => browser.close(),
  };
  return bakery;
}

/**
 * 在一个已经开着的 bakery 上烘一段帧。返回给 ffmpeg 用的那些参数。
 *
 * opts:
 *   format/quality —— 'png' 带 alpha(导出交付物要),'jpeg' 不带(预览烘焙够用)。
 *                     PNG 走 optimizeForSpeed:仍然无损(实测逐字节解码后与普通 PNG 相同),只是压得快、文件大一倍。
 *   staticSkip     —— 画面静止的帧直接复用上一张,连截都不截。判据见 ExportView 的 __pcStaticProbe
 *   verifyEvery    —— 连续复用多少帧就强制真截一张比对一次
 *   targetFrames   —— 只截这几帧(离散取样,给预烘用);仍从第 0 帧顺推,只是沿途只截这几张
 */
export async function bakeFrames(bakery, opts = {}) {
  const { page, client, beginFrame, waitNet } = bakery;
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
  let startFrame = 0;
  let endFrame = Math.floor((timeline.duration || 20) * fps) - 1;
  if (opts.frames) {
    const [a, b] = opts.frames.split('-').map(Number);
    startFrame = a;
    endFrame = b;
  }
  /*
   * 只截这几帧(离散取样)。仍然从第 0 帧顺推 —— 动画的锚点是「首次出现那一帧」,跳着推就没有锚点,
   * 按 delta 积分的卡片也会走样。一趟推过去沿途截,推进只付一次(分 N 趟截 N 个时刻是 O(N²))。
   * 静态跳过在这种模式下必须关死:lastBuf 可能是几十帧之前的,直接复用就是把时间轴压扁。
   */
  const targetFrames = Array.isArray(opts.targetFrames) && opts.targetFrames.length
    ? new Set(opts.targetFrames.map((n) => Math.max(0, Math.round(Number(n)))))
    : null;
  if (targetFrames) {
    startFrame = Math.min(...targetFrames);
    endFrame = Math.max(...targetFrames);
  }
  const staticSkip = targetFrames ? false : wantStaticSkip;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // 透明底一次性打开,不用 puppeteer 的 omitBackground(那个每截一张开关一次,开关本身会触发重绘)
  if (format !== 'jpeg') {
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const shotParams = format === 'jpeg'
    ? { format: 'jpeg', quality }
    : { format: 'png', optimizeForSpeed: true };

  /** 截一张:发一拍并要这一拍的截图。此刻动画已钉住、页面时钟已量化,这一拍里画面不会再变 */
  const shoot = async () => {
    const r = await beginFrame({ screenshot: shotParams });
    if (!r.screenshotData) throw new Error('beginFrame 这一拍没有返回截图');
    return Buffer.from(r.screenshotData, 'base64');
  };

  // 一帧 = 下发时间 → 等网络 → 排空 → 推一拍(React 提交后的 rAF、Motion 建动画都在这一拍里)→ 等网络
  //       → 排空 → 钉动画 → 排空 → 探针 → 等素材。截不截图由调用方决定。返回这一帧画面静不静止。
  const step = async (frameIndex, wantTrace) => {
    // 两个计数器要在推进之前取、推进之后比;取值和下发时间合并成一次 evaluate
    const before = await page.evaluate((sec) => {
      const n = { raf: window.__pcRafCount ?? 0, mut: window.__pcMutationCount ?? 0 };
      window.__pcSetT(sec);
      return n;
    }, frameIndex / fps);
    // 挂载时发出的请求(动态 import、素材)先落地,再推这一拍
    await waitNet();
    await page.evaluate(() => window.__bfSettle());
    await beginFrame();
    await waitNet();
    /*
     * 排空 → 钉动画 → 再排空 → 探针,一次页面内调用做完。
     * 钉之前排空:这一拍里排队的提交要先落地,新建的动画 __pcSyncAnims 才看得见。
     * 钉之后再排空:__pcSyncAnims 对越过终点的动画调 finish(),Motion 在 onfinish 回调里把终态写进 style ——
     * 那是排队的任务,排空后探针的 mut 才看得见它。
     */
    const probe = await page.evaluate(async () => {
      await window.__bfSettle();
      if (window.__pcSyncAnims) window.__pcSyncAnims();
      await window.__bfSettle();
      return window.__pcStaticProbe ? window.__pcStaticProbe() : null;
    });
    if (trace && wantTrace) trace.push(await page.evaluate((i) => ({
      i, perfNow: performance.now(), timelineNow: document.timeline.currentTime, probeMs: window.__pcProbeMs,
      anims: document.getAnimations().map((a) => [a.playState, a.currentTime, a.startTime, a.effect && a.effect.target && a.effect.target.className && String(a.effect.target.className).slice(0, 24)]),
    }), frameIndex));
    // 再等一次网络:这一拍里新挂的组件发出的请求,requestWillBeSent 事件和 beginFrame 的回复谁先到 Node 没有保证,
    // 上面那次 waitNet 可能正好看见 0 个在途。经过一次页面内往返,事件已经追上;没有请求时这里不花时间。
    await waitNet();
    await page.evaluate(() => window.__bfAssets());
    // 四个条件同时成立才算静止,少一个都会渲出坏帧 —— 理由见 ExportView 的 __pcStaticProbe。
    // finished:这一帧被 __pcSyncAnims 收束的动画数。动画在这一帧跳到终态,画面变了,但收束后 anims 里
    // 已经没有它、DOM 也没动 —— 只看 anims 会在动画结束那一帧误判静止。
    const isStatic = !!probe && probe.anims === 0 && probe.finished === 0 && probe.mut === before.mut
      && probe.raf === before.raf && !probe.video && !probe.canvas;
    if (process.env.PC_STATIC_TRACE) {
      console.log(`  静态判定 帧${frameIndex}: anims=${probe?.anims} finished=${probe?.finished} mut=${before.mut}->${probe?.mut} raf=${before.raf}->${probe?.raf} video=${probe?.video} canvas=${probe?.canvas} => ${isStatic ? '静止' : '在变'}`);
    }
    return isStatic;
  };

  // 预热:让字体、布局、首批挂载稳定下来,然后重新挂载全部卡片并清空动画锚点,正式从第 0 帧开始。
  // 重挂载之后再走一整帧并丢掉:重挂载会让整页失效重绘,让这一次落在丢掉的帧上。
  const warmUp = async () => {
    console.log(`Warm-up ${warmFrames} frames...`);
    for (let i = 0; i < warmFrames; i++) {
      await step(0, false);
      await shoot();
    }
    await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });
    await step(0, false);
    await shoot();
    await page.evaluate(() => { window.__pcResetAnims && window.__pcResetAnims(); });
  };

  const totalFrames = targetFrames ? targetFrames.size : endFrame - startFrame + 1;
  const durationSec = (totalFrames / fps).toFixed(3);
  let reused = 0;

  /*
   * HTML 采样缓存(opts.domCache):每截完一帧顺手把舞台冻结成 HTML,gzip 后写到 <out>/dom/%06d.html.gz。
   * 之后要重截(换格式、渐进铺开、多进程并行)就走 scripts/replay-frames.mjs,不必再从第 0 帧顺推。
   * 实测冻结 10~36 ms/帧,gzip 后 8~15 KB/帧。静态跳过复用的帧,快照也复用上一份。
   */
  const domDir = opts.domCache ? path.join(outDir, 'dom') : null;
  const gzip = domDir ? (await import('node:zlib')).gzipSync : null;
  if (domDir) await fs.mkdir(domDir, { recursive: true });
  let domLossy = 0;

  /** 跑一遍全部帧。allowSkip 为假时每帧老老实实真截。返回判错的帧号;没判错返回 null。 */
  const renderPass = async (allowSkip) => {
    let lastBuf = null;  // 上一张**真截**出来的图
    let lastDom = null;  // 上一份冻结下来的舞台(gzip 过的)
    let runLen = 0;      // 已经连续复用了几帧
    reused = 0;
    domLossy = 0;
    const writes = [];
    for (let i = 0; i <= endFrame; i++) {
      const wantShot = targetFrames ? targetFrames.has(i) : i >= startFrame;
      const isStatic = await step(i, wantShot);
      if (!wantShot) continue;

      let buf;
      let fresh = true;
      if (allowSkip && isStatic && lastBuf) {
        runLen++;
        if (runLen % verifyEvery === 0) {
          // 便宜的保险:连续复用到第 verifyEvery 帧就强制真截一张比一次。对不上就整趟作废重跑
          const real = await shoot();
          if (!real.equals(lastBuf)) { await Promise.all(writes); return i; }
          lastBuf = real;
          buf = real;
        } else {
          buf = lastBuf;
          reused++;
          fresh = false;
        }
      } else {
        runLen = 0;
        buf = await shoot();
        lastBuf = buf;
      }
      const name = String(i).padStart(6, '0');
      // 写盘不挡下一帧
      writes.push(fs.writeFile(path.join(framesDir, `${name}.${ext}`), buf));
      if (domDir) {
        if (fresh || !lastDom) {
          const { html, lossy } = await page.evaluate(() => window.__bfFreeze());
          domLossy += lossy;
          lastDom = gzip(Buffer.from(html, 'utf8'));
        }
        writes.push(fs.writeFile(path.join(domDir, `${name}.html.gz`), lastDom));
      }
      if (process.env.PC_EXPORT_VERBOSE || (i - startFrame + 1) % 10 === 0 || i === endFrame) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
    }
    await Promise.all(writes);
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
  if (domDir) {
    // 重放要知道画幅、帧率,以及去哪个导出页拿字体和样式表(去掉 timeline 参数:内容全在快照里)
    const exportUrl = page.url().replace(/([?&])timeline=[^&]*&?/, '$1').replace(/[?&]$/, '');
    await fs.writeFile(path.join(domDir, 'manifest.json'), JSON.stringify({
      width, height, fps, startFrame, endFrame, themeId: timeline.themeId ?? null, exportUrl, lossyCanvases: domLossy,
    }, null, 1));
    if (domLossy) console.warn(`HTML 采样缓存:${domLossy} 个画布读不出像素,重放时这些画布是空的`);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Export finished in ${elapsed}s (${totalFrames} frames${reused ? `, ${reused} reused` : ''}).`);
  return { framesDir, ext, fps, width, height, startFrame, endFrame, totalFrames, durationSec, reused, elapsed, domDir };
}

/*
 * 多进程分片(docs/render-rebuild-plan.md 阶段 5)。
 *
 * 每个分片**都从第 0 帧推起**,只截自己那一段 —— 动画锚点、按 delta 积分的卡片、带种子的随机数流
 * 都依赖「前面推过哪些帧」,跳着推就对不上。所以分片的输出和单进程逐字节相同,代价是每个分片都要
 * 付「推到自己那段开头」的钱:实测推进一帧约 20 ms、截一张约 24.5 ms(demo + 粒子 + scene-3d)。
 * 最后一个分片无论如何要把整条时间轴推一遍,所以理论上限约 (20+24.5)/20 ≈ 2.2 倍。
 *
 * **实测远到不了这个上限**(demo 全长 1800 帧 + 粒子 + scene-3d,28 线程机器):
 *   1 个 54.8s / 4 个 44.8s / 8 个 62.4s(比单进程还慢),三种输出两两 1800/1800 逐字节相同。
 * 软件光栅化的 Chrome 同时跑几个就互相抢 CPU,「推到自己那段开头」的钱又省不掉。
 * 所以默认单进程,分片只作为可选项(--workers N),'auto' 最多 4 个。
 * 真要大幅提速得换思路:按片段边界跳过前面的推进(对全局随机数流有影响,见 pinEntropy.ts),
 * 或者用 HTML 采样缓存乱序重截(scripts/replay-frames.mjs)。
 *
 * 为了让各分片同时结束,段长不是均分的:越靠前的分片推得越少,就多截几帧。按
 * 「分片成本 = (段尾+1)×推进 + 段长×截图」二分出一个共同的成本上限,再从前往后切。
 */
const PUSH_MS = 20;
const SHOOT_MS = 24.5;

/** 把 [start, end] 切成 n 段,让每段「推到段尾 + 截本段」的成本尽量一样 */
export function balancedShards(start, end, n) {
  const cost = (a, b) => (b + 1) * PUSH_MS + (b - a + 1) * SHOOT_MS;
  const fits = (limit) => {
    const out = [];
    let a = start;
    while (a <= end) {
      if (out.length === n) return null;
      let b = a;
      if (cost(a, b) > limit) return null;
      while (b < end && cost(a, b + 1) <= limit) b++;
      out.push([a, b]);
      a = b + 1;
    }
    return out;
  };
  let lo = cost(end, end), hi = cost(start, end);
  let best = fits(hi);
  for (let k = 0; k < 40 && hi - lo > 1; k++) {
    const mid = (lo + hi) / 2;
    const r = fits(mid);
    if (r) { best = r; hi = mid; } else lo = mid;
  }
  return best;
}

/**
 * 开几个分片。'auto':每个 Chrome 约 1.9 个核、约 750 MB(实测),按核数和空闲内存一起夹,最多 8
 * (旧管线实测 8 个是拐点,12 个反而更慢)。
 */
export async function resolveWorkers(w) {
  if (w === undefined || w === null || w === '' || w === 1 || w === '1') return 1;
  if (w !== 'auto') return Math.max(1, Math.min(16, Math.floor(Number(w)) || 1));
  const os = await import('node:os');
  const byCpu = Math.floor(os.cpus().length / 3);
  const byMem = Math.floor((os.freemem() / 1e9 - 1) / 0.8);
  return Math.max(1, Math.min(4, byCpu, byMem));
}

async function bakeSharded(opts, n) {
  const first = await openBakery(opts);
  const bakeries = [first];
  try {
    const timeline = await first.page.evaluate(() => window.__pcTimeline);
    if (!timeline) throw new Error('Timeline not found');
    const fps = opts.fps || timeline.fps || 30;
    let start = 0;
    let end = Math.floor((timeline.duration || 20) * fps) - 1;
    if (opts.frames) [start, end] = opts.frames.split('-').map(Number);
    const shards = balancedShards(start, end, n);
    console.log(`分片导出:${shards.length} 个进程,段 ${shards.map(([a, b]) => `${a}-${b}`).join(' ')}`);
    while (bakeries.length < shards.length) bakeries.push(await openBakery(opts));
    const t0 = Date.now();
    const results = await Promise.all(shards.map(([a, b], k) => bakeFrames(bakeries[k], { ...opts, frames: `${a}-${b}` })));
    const r0 = results[0];
    const totalFrames = end - start + 1;
    const merged = {
      ...r0,
      startFrame: start, endFrame: end, totalFrames,
      durationSec: (totalFrames / r0.fps).toFixed(3),
      reused: results.reduce((s, r) => s + (r.reused || 0), 0),
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
    };
    // 各分片各写了一份只覆盖自己那段的清单,合成一份覆盖全段的
    if (r0.domDir) {
      const mf = path.join(r0.domDir, 'manifest.json');
      const m = JSON.parse(await fs.readFile(mf, 'utf8'));
      await fs.writeFile(mf, JSON.stringify({ ...m, startFrame: start, endFrame: end }, null, 1));
    }
    console.log(`分片导出完成:${totalFrames} 帧,${merged.elapsed}s。`);
    return merged;
  } finally {
    await Promise.all(bakeries.map((b) => b.close().catch(() => {})));
  }
}

/**
 * 一次性导出:自己开 bakery、烘帧、合成视频、关掉。CLI 和现有的 /api/export 走这条。
 * opts.workers:1(默认)/ 数字 / 'auto'。离散取样(targetFrames)和外部传进来的 bakery 一律单进程。
 */
export async function exportFrames(opts) {
  const outDir = opts.out || 'out';
  const noVideo = opts.noVideo || false;
  const workers = (opts.bakery || opts.targetFrames) ? 1 : await resolveWorkers(opts.workers);
  let baked;
  if (workers > 1) {
    baked = await bakeSharded(opts, workers);
  } else {
    const bakery = opts.bakery || await openBakery(opts);
    try {
      baked = await bakeFrames(bakery, opts);
    } finally {
      if (!opts.bakery) await bakery.close();
    }
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
        const { buildAudioPlan, buildFfmpegArgs, hasAudioStream } = await import('./mux-audio.mjs');
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
  // 命令行默认按机器自动分片(/api/export 走的就是这条);要单进程传 --workers 1
  const opts = { noVideo: false, workers: 'auto' };
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
    else if (args[i] === '--dom-cache') opts.domCache = true;
    else if (args[i] === '--target-frames') opts.targetFrames = args[++i].split(',').map(Number).filter(Number.isFinite);
  }
  exportFrames(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
