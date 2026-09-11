import puppeteer from 'puppeteer';
import { captureSnapshot } from './capture-snapshot.mjs';
import { installFrameMedia, prepareFrameMedia } from './frame-media.mjs';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildComposeArgs, clipFrameRange, composeLayers } from '../server/export-compose.mjs';
import { buildAudioPlan, buildFfmpegArgs, hasAudioStream } from './mux-audio.mjs';

/** Encode incoming screenshots immediately so Node retains at most one PNG. */
export function streamPngVideo(ffmpeg, file, fps) {
  const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png',
    '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks', '-profile:v', '4444',
    '-pix_fmt', 'yuva444p10le', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', inputError = null;
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(inputError || new Error(`ffmpeg ${code}: ${stderr}`)));
  });
  done.catch(() => {});
  return {
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
    },
    async finish() { proc.stdin.end(); await done; },
    async abort() { proc.stdin.destroy(); proc.kill(); await done.catch(() => {}); },
  };
}

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
      if (orig[i].tagName === 'VIDEO' && orig[i].dataset.pcMediaSrc) {
        copy[i].removeAttribute('src');
        copy[i].setAttribute('preload', 'none');
        copy[i].style.visibility = 'hidden';
      }
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
    const controls = [...clone.querySelectorAll('[data-pc-clip][data-pc-local-frame]')].map(el => ({
      id: el.getAttribute('data-pc-clip'), frame: Number(el.getAttribute('data-pc-local-frame')), html: el.outerHTML,
    }));
    return { html, lossy, controls };
  };
  /*
   * 毛玻璃遮罩(只渲卡片的导出用,见 server/export-compose.mjs 的 mask)。
   *
   * 卡片的玻璃是 backdrop-filter:blur,模糊的是它**背后**的东西。页面只渲卡片时背后是透明的,
   * 视频由 ffmpeg 事后垫进去 —— 玻璃就成了一块只带底色、不模糊视频的膜。要把模糊补回来,ffmpeg 得知道
   * 玻璃在画面上的确切形状:位置、缩放旋转三维、圆角、被祖先的 opacity 淡到几成、被谁裁掉。
   * 这些自己算很容易漏,所以让 Chrome 画:这一帧截完卡片之后,临时把舞台上除玻璃以外的东西全藏起来、
   * 玻璃本身涂成纯白,再截一张 —— 白的地方就是玻璃,alpha 就是它的覆盖度 × 不透明度。截完原样还回去。
   *
   * 还原时不能惊动任何动画:
   *   - 全程不碰 transition-property(改它会取消正在跑的 CSS 过渡),只把 duration / delay 压成 0,
   *     这样改值不会起新的过渡;
   *   - 撤掉时分两步:先撤掉覆盖、保留「duration 0」再强制算一次样式(值变回去也不起过渡),再整个删掉;
   *   - 动画(Motion 的 WAAPI、CSS animation)在层叠里低于 !important 的作者样式,覆盖期间被压住,撤掉即恢复;
   *   - 只有本来就可见的玻璃才标记:原本 visibility:hidden 的不能被这里的规则拉出来。
   * 祖先上的 filter 不动:去掉它会改变绝对定位后代的包含块,可能把玻璃挪位;代价是带强调阴影的玻璃卡,
   * 遮罩边上会多一圈淡淡的影子(模糊略微溢出玻璃边)。
   */
  const GLASS_HOLD = '#root *, #root *::before, #root *::after { transition-duration: 0s !important; transition-delay: 0s !important; }';
  const GLASS_ON = GLASS_HOLD + `
    #root *, #root *::before, #root *::after { visibility: hidden !important; }
    #root [data-bf-glass] { visibility: visible !important; background: #fff !important; border-color: #fff !important;
      box-shadow: none !important; outline: none !important; filter: none !important; backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important; color: transparent !important; text-shadow: none !important; }
    #root [data-bf-glass] *, #root [data-bf-glass]::before, #root [data-bf-glass]::after { visibility: hidden !important; }`;
  window.__bfGlassOn = () => {
    const root = document.getElementById('root');
    if (!root) return null;
    const els = [];
    const blurs = [];
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === 'none' || cs.visibility !== 'visible') continue;
      els.push(el);
      const m = /blur\(([\d.]+)px\)/.exec(bf);
      if (m) blurs.push(parseFloat(m[1]));
    }
    if (!els.length) return null;
    for (const el of els) el.setAttribute('data-bf-glass', '');
    const st = document.createElement('style');
    st.id = '__bf_glass';
    st.textContent = GLASS_ON;
    document.head.appendChild(st);
    window.__bfGlassEls = els;
    return { count: els.length, blurs };
  };
  window.__bfGlassOff = () => {
    const st = document.getElementById('__bf_glass');
    if (!st) return;
    st.textContent = GLASS_HOLD;
    void document.body.offsetHeight;
    st.remove();
    for (const el of window.__bfGlassEls || []) el.removeAttribute('data-bf-glass');
    window.__bfGlassEls = null;
    void document.body.offsetHeight;
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
  await page.evaluateOnNewDocument(installFrameMedia);
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
  const url = opts.url || DEFAULT_URL;

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
    /**
     * 备用页:提前开好一个**全新的**、停在空项目上的 page。来活时 resetWith 把项目原地灌进去。
     *
     * 为什么值得:一趟的准备里,新开 page + 导航 + 加载整张模块图 + 等就绪约 310 ms,而把项目灌进
     * 一个已经就绪的新页只要 3~4 ms(实测,rank-bars / mu-number-ticker / particles)。
     * 为什么不破坏确定性:备用页和现开的页一样是全新的、从没推过帧,灌项目走的是 loadProject
     * 这条「只在全新 page 上用」的路 —— 实测两条路渲同一帧逐字节相同(3 张卡 × 3 次,9/9)。
     */
    spare: null,
    preload(emptyUrl) {
      if (!bakery.spare) {
        bakery.spare = newSession(browser, emptyUrl);
        bakery.spare.catch(() => {}); // 备用页开失败不报,resetWith 会现开一个兜底
      }
      return bakery.spare;
    },
    /**
     * 扔掉备用页。卡片源码一改,备用页里加载的就是旧模块 —— 拿它灌下一个项目渲出来的是旧卡片,
     * 而且不报错(见 render-worker 的 invalidate)。
     */
    dropSpare() {
      const p = bakery.spare;
      bakery.spare = null;
      p?.then((s) => s?.page?.close(), () => {}).catch(() => {});
    },
    /** 用备用页(没有就现开一个空项目页)换一趟新的,再把 project 灌进去 */
    async resetWith(project, emptyUrl) {
      const old = bakery.page;
      let s = null;
      if (bakery.spare) {
        const p = bakery.spare;
        bakery.spare = null;
        s = await p.catch(() => null);
      }
      if (!s) s = await newSession(browser, emptyUrl);
      await s.loadProject(project);
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
 *   glassFrames    —— Set<帧号>:这些帧底下有素材,截完卡片再截一张毛玻璃遮罩(PAGE_PRELUDE 的 __bfGlassOn)
 *                     到 <out>/glass/%06d.png。没有玻璃的帧不写文件;返回值的 glass 里有写了几张、玻璃的模糊量
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
    if (!opts.glassFrames) {
      // Pixel maps rasterize a hidden source video into a canvas. Load only the
      // requested frame before freezing HTML; otherwise __bfFreeze would copy
      // an empty canvas into the snapshot and every cache replay would stay blank.
      const hasPixelMap = await page.evaluate(() => !!document.querySelector("canvas[data-pc-pixel-map]"));
      if (hasPixelMap) {
        await prepareFrameMedia(bakery);
        await beginFrame();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      const snapshot = await page.evaluate(() => window.__bfFreeze());
      if (snapshot.lossy) throw new Error(`Cannot snapshot ${snapshot.lossy} canvas elements`);
      return captureSnapshot(bakery, snapshot.html, shotParams);
    }
    await prepareFrameMedia(bakery);
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
      window.__pcHideFrameMedia?.();
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
      // 预热也看取消:不看的话,取消要等预热走完、进了逐帧循环才生效,这段时间 worker 其实还占着
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      await step(0, false);
      await beginFrame();
    }
    await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });
    await step(0, false);
    await beginFrame();
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

  const glassFrames = opts.glassFrames instanceof Set && opts.glassFrames.size ? opts.glassFrames : null;
  const glassDir = glassFrames ? path.join(outDir, 'glass') : null;
  if (glassDir) await fs.mkdir(glassDir, { recursive: true });
  const glass = { dir: glassDir, list: [], blurs: new Set() };
  /** 这一帧的毛玻璃遮罩;没有可见的玻璃返回 null。多出来的这一拍时间戳照旧钉着,rAF 循环空转(见 exportClock.ts) */
  const shootGlass = async () => {
    const info = await page.evaluate(() => window.__bfGlassOn());
    if (!info) return null;
    for (const b of info.blurs) glass.blurs.add(b);
    try {
      return await shoot();
    } finally {
      await page.evaluate(() => window.__bfGlassOff());
    }
  };

  /** 跑一遍全部帧。allowSkip 为假时每帧老老实实真截。返回判错的帧号;没判错返回 null。 */
  const renderPass = async (allowSkip) => {
    let lastBuf = null;  // 上一张**真截**出来的图
    let lastDom = null;  // 上一份冻结下来的舞台(gzip 过的)
    let runLen = 0;      // 已经连续复用了几帧
    // 上一张真截对应的遮罩:undefined = 还没截过(null = 截了,没有玻璃)。静止帧复用卡片图时遮罩也一起复用
    let lastGlass;
    reused = 0;
    domLossy = 0;
    glass.list = [];
    glass.blurs.clear();
    // Keep disk writes streaming with a small bounded queue.  The old code
    // appended one fs.writeFile Promise per frame; each pending Promise kept
    // its PNG Buffer alive until the whole movie finished, so a long export
    // grew to several gigabytes before ffmpeg even started.
    const writes = [];
    const queueWrite = async (file, data) => {
      writes.push(fs.writeFile(file, data));
      if (writes.length >= 4) await Promise.all(writes.splice(0));
    };
    for (let i = 0; i <= endFrame; i++) {
      /*
       * 取消只在两帧之间生效:这时上一帧的推进、排空、截图都已经做完,页面不在半路上。
       * 调用方(render-worker)据此只换一张新页,不必把整个浏览器当成可疑的重开。
       */
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      const wantShot = targetFrames ? targetFrames.has(i) : i >= startFrame;
      const isStatic = await step(i, wantShot);
      if (domDir || opts.onSnapshot) {
        const { html, lossy, controls } = await page.evaluate(() => window.__bfFreeze());
        if (lossy) throw new Error('HTML snapshot contains unreadable canvases');
        if (opts.onSnapshot) await opts.onSnapshot(i, html, controls);
        if (domDir) await fs.writeFile(path.join(domDir, String(i).padStart(6, '0') + '.html.gz'), gzip(Buffer.from(html, 'utf8')));
      }
      // Unified export first runs a complete HTML sampling pass (B).  That
      // pass intentionally does not write PNGs, but it still has to report
      // progress; otherwise the UI remains at its initial 0/1 for the whole
      // sampling pass and looks frozen on long projects.
      if (opts.onProgress) opts.onProgress(i, totalFrames, { sampled: true });
      if (!opts.quiet && opts.onProgressLog && ((i - startFrame + 1) % 10 === 0 || i === endFrame)) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
      if (!wantShot || opts.snapshotOnly) continue;

      let buf;
      let fresh = true;
      if (allowSkip && isStatic && lastBuf) {
        runLen++;
        if (runLen % verifyEvery === 0) {
          // 便宜的保险:连续复用到第 verifyEvery 帧就强制真截一张比一次。对不上就整趟作废重跑
          const real = await shoot();
          if (!real.equals(lastBuf)) { await Promise.all(writes.splice(0)); return i; }
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
      // A full export can hand the PNG straight to a local ffmpeg pipe.  The
      // callback is awaited before the next frame, so the screenshot Buffer is
      // released as soon as ffmpeg accepts it and never accumulates in Node.
      if (opts.onFrame) await opts.onFrame(i, buf);
      // 写盘不挡下一帧 (streaming exports may deliberately skip PNG files)
      if (opts.writeFrames !== false) await queueWrite(path.join(framesDir, `${name}.${ext}`), buf);
      if (fresh) lastGlass = undefined;
      if (glassFrames && glassFrames.has(i)) {
        if (lastGlass === undefined) lastGlass = await shootGlass();
        if (lastGlass) {
          glass.list.push(i);
          await queueWrite(path.join(glassDir, `${name}.png`), lastGlass);
        }
      }
      if (!opts.quiet && (process.env.PC_EXPORT_VERBOSE || (i - startFrame + 1) % 10 === 0 || i === endFrame)) {
        console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
      }
    }
    await Promise.all(writes.splice(0));
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
  console.log(`Export finished in ${elapsed}s (${totalFrames} frames${reused ? `, ${reused} reused` : ''}${glass.list.length ? `, ${glass.list.length} glass masks` : ''}).`);
  return {
    framesDir, ext, fps, width, height, startFrame, endFrame, totalFrames, durationSec, reused, elapsed, domDir,
    glass: { dir: glass.dir, list: glass.list, blurs: [...glass.blurs] },
  };
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
 * Prefer boundaries where a card mounts/unmounts. Cutting inside an active
 * card can change the first-frame anchor of Motion/WAAPI animations in a
 * parallel bakery. If there are too few boundaries, return fewer shards.
 */
export function safeTimelineShards(timeline, start, end, n) {
  const fps = timeline?.fps || 30;
  const cuts = new Set([start, end + 1]);
  for (const clip of timeline?.clips || []) {
    for (const t of [clip.start, clip.end]) {
      const f = Math.round(Number(t) * fps);
      if (Number.isFinite(f) && f > start && f <= end) cuts.add(f);
    }
  }
  const segments = [...cuts].sort((a, b) => a - b).map((a, i, all) => [a, all[i + 1] - 1]).filter(r => r[0] <= r[1]);
  if (segments.length <= n) return segments;
  const result = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const left = segments.length - at;
    const slots = n - k;
    const remainingFrames = segments.slice(at).reduce((sum, r) => sum + r[1] - r[0] + 1, 0);
    const target = Math.ceil(remainingFrames / slots);
    let count = 0, next = at;
    while (next < segments.length && (count === 0 || count + segments[next][1] - segments[next][0] + 1 <= target || slots === 1)) {
      count += segments[next][1] - segments[next][0] + 1;
      next++;
      if (slots > 1 && count >= target) break;
    }
    result.push([segments[at][0], segments[next - 1][1]]);
    at = next;
  }
  return result;
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
    const shards = safeTimelineShards(timeline, start, end, n);
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
      glass: {
        dir: r0.glass?.dir ?? null,
        list: results.flatMap((r) => r.glass?.list || []),
        blurs: [...new Set(results.flatMap((r) => r.glass?.blurs || []))],
      },
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

/** 本机的 ffmpeg:PATH 上有就用它,没有就退到 winget 装的那一份 */
export async function findFfmpeg() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const ffmpegFallback = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('close', code => code === 0 ? resolve() : reject());
      proc.on('error', reject);
    });
    return 'ffmpeg';
  } catch {
    return ffmpegFallback;
  }
}
const ffprobeOf = (ffmpegCmd) => ffmpegCmd.replace(/ffmpeg(.exe)?$/i, (m) => m.toLowerCase().startsWith('ffmpeg.exe') ? 'ffprobe.exe' : 'ffprobe');

const isInside = (file, dir) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * 素材在 ffmpeg 那边从哪儿读。页面是按 m.url 去 fetch 的,这里按同一个地址找:
 *   /@export/<id>/media/<文件> → <out>/media/<文件>(导出时浏览器上传的素材);
 *   /@media/<文件>、或 path 字段 → 素材目录里的文件(素材库);
 *   都不在本机就和页面一样走 HTTP 找 dev server 要(两处都支持 Range,ffmpeg 能 seek)。
 * 和 vite-plugin-vision 的 mediaFileOf 同一道边界:磁盘路径只认落在素材目录 / 产物目录里的,
 * HTTP 只认页面同源的 —— project.json 是浏览器发来的,不能让它指使 ffmpeg 读任意文件。
 */
export function mediaSourceOf(m, { outDir, pageUrl, mediaRoot }) {
  const url = String(m?.url || '');
  if (!url || /^(blob|data):/i.test(url)) return null;
  const exportMedia = path.resolve(outDir, 'media');
  const marker = url.lastIndexOf('/media/');
  if (url.startsWith('/@export/') && marker !== -1) {
    const f = path.join(exportMedia, decodeURIComponent(url.slice(marker + '/media/'.length).split('?')[0]));
    if (isInside(f, exportMedia) && fsSync.existsSync(f)) return f;
  }
  if (m.path) {
    const f = path.resolve(String(m.path));
    const roots = [mediaRoot, ...legacyMediaRoots()];
    if (roots.some((root) => isInside(f, root)) && fsSync.existsSync(f)) return f;
  }
  if (url.startsWith('/@media/')) {
    const f = path.join(mediaRoot, decodeURIComponent(url.slice('/@media/'.length).split('?')[0]));
    const roots = [mediaRoot, ...legacyMediaRoots()];
    if (roots.some((root) => isInside(f, root)) && fsSync.existsSync(f)) return f;
  }
  try {
    const u = new URL(url, pageUrl);
    if (u.origin === new URL(pageUrl).origin && /^https?:$/.test(u.protocol)) return u.href;
  } catch { /* 地址不合法 */ }
  return null;
}

/**
 * ffprobe 看一眼素材:有没有透明通道(决定强调算不算)、色彩空间(没标注的按 bt709 解,和 Chrome 一致)、
 * 要不要换解码器(带 alpha 的 VP8/VP9 用 ffmpeg 自带解码器会丢 alpha,得用 libvpx)。读不出来返回 null。
 */
function probeVisual(ffprobeCmd, src) {
  try {
    const out = execFileSync(ffprobeCmd, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,color_space:stream_tags=alpha_mode', '-of', 'json', src,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const s = JSON.parse(out).streams?.[0];
    if (!s) return null;
    const alphaTag = String(s.tags?.alpha_mode ?? s.tags?.ALPHA_MODE ?? '') === '1';
    const pix = String(s.pix_fmt || '');
    return {
      hasAlpha: alphaTag || /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(pix),
      colorSpace: s.color_space || 'unknown',
      decoder: alphaTag ? ({ vp8: 'libvpx', vp9: 'libvpx-vp9' })[s.codec_name] : undefined,
    };
  } catch {
    return null;
  }
}

/** 素材库目录(/@media/<文件> 落在这里)。画面层和音轨都按它找素材 */
const mediaRootDir = () => path.resolve(process.env.PROMPTCUT_EXPORT_DIR || path.resolve('out'), 'media');
// Older .proc files keep absolute paths in %USERPROFILE%/Videos/PromptCut/media.
// Keep ffmpeg's lookup in sync with the browser media endpoint so legacy
// projects render the same footage they show in the editor.
function legacyMediaRoots() {
  const roots = [path.join(process.env.USERPROFILE || process.env.HOME || '', 'Videos', 'PromptCut', 'media')];
  if (process.env.PROMPTCUT_MEDIA_DIR) roots.push(path.resolve(process.env.PROMPTCUT_MEDIA_DIR));
  return roots.filter(Boolean);
}

const DEFAULT_URL = 'http://127.0.0.1:5190/?export=1';

/** 页面拿的是哪份项目,ffmpeg 就用哪份:按导出页地址里的 timeline 去取;取不到再看 <out>/project.json */
async function loadProject(url, outDir) {
  try {
    const u = new URL(url);
    const tl = u.searchParams.get('timeline');
    if (tl) {
      const r = await fetch(new URL(tl, u));
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.tracks)) return j;
      }
    }
  } catch (e) {
    console.warn('取项目失败,改读产物目录里的 project.json:', e.message);
  }
  const f = path.join(outDir, 'project.json');
  if (fsSync.existsSync(f)) {
    const j = JSON.parse(fsSync.readFileSync(f, 'utf8'));
    if (j && Array.isArray(j.tracks)) return j;
  }
  return null;
}

/**
 * 烘帧之前先把素材层规划好:每段素材从哪儿读、有没有 alpha,以及哪些帧底下有素材
 * (那些帧要截毛玻璃遮罩;底下没素材的帧,玻璃背后只有灰底,模不模糊都一样)。
 */
async function planMedia(opts, outDir, ffmpegCmd) {
  const url = opts.url || DEFAULT_URL;
  const project = await loadProject(url, outDir);
  if (!project) return null;
  const all = composeLayers(project);
  if (!all.length) return { project, layers: [], glassFrames: new Set() };
  const mediaRoot = mediaRootDir();
  const ffprobeCmd = ffprobeOf(ffmpegCmd);
  const probed = new Map();
  const layers = all.map((l) => {
    let src = mediaSourceOf(l.media, { outDir, pageUrl: url, mediaRoot });
    let info = null;
    if (src) {
      if (!probed.has(src)) probed.set(src, probeVisual(ffprobeCmd, src));
      info = probed.get(src);
      if (!info) {
        console.warn(`素材「${l.media.name || l.media.id}」ffprobe 读不出来(${src}),这一层没有画面`);
        src = null;
      }
    } else {
      console.warn(`素材「${l.media.name || l.media.id}」找不到文件(${l.media.url || '无地址'}),这一层没有画面`);
    }
    return { ...l, src, hasAlpha: !!info?.hasAlpha, colorSpace: info?.colorSpace, decoder: info?.decoder };
  });
  const fps = opts.fps || project.fps || 30;
  let [f0, f1] = [0, Math.floor((project.duration || 20) * fps) - 1];
  if (opts.frames) [f0, f1] = opts.frames.split('-').map(Number);
  const glassFrames = new Set();
  for (const l of layers) {
    if (!l.src) continue;
    const r = clipFrameRange(l.clip, fps, f0, f1);
    if (r) for (let i = r[0]; i <= r[1]; i++) glassFrames.add(i);
  }
  return { project, layers, glassFrames };
}

/** 遮罩序列要每帧都有一张(image2 输入不能缺号):没有玻璃的帧补一张全透明的 */
async function fillGlassGaps(dir, startFrame, endFrame, width, height) {
  const { PNG } = await import('pngjs');
  const empty = PNG.sync.write(new PNG({ width, height }));
  const writes = [];
  for (let i = startFrame; i <= endFrame; i++) {
    const f = path.join(dir, `${String(i).padStart(6, '0')}.png`);
    if (!fsSync.existsSync(f)) writes.push(fs.writeFile(f, empty));
  }
  await Promise.all(writes);
}

/**
 * 一次性导出:自己开 bakery、烘帧、合成视频、关掉。CLI 和现有的 /api/export 走这条。
 * opts.workers:1(默认)/ 数字 / 'auto'。离散取样(targetFrames)和外部传进来的 bakery 一律单进程。
 * opts.media:素材怎么进成片。
 *   'chrome'(默认)—— 预览、see_frames、导出共用 FramePipeline/Chrome 页面，视频素材在截图帧才加载。
 *   'ffmpeg'       —— 兼容旁路:页面只渲卡片的透明层(?cardsOnly=1),视频 / 图片由 ffmpeg 合进 preview.mp4
 *                      (server/export-compose.mjs)。frames/ 和 overlay.mov 因此只有卡片。
 *   外部传进来的 bakery 已经导航到某个地址,改不了页面,按 'chrome' 处理。
 * opts.audio:声音怎么混。默认在 Chrome 里(OfflineAudioContext,带音频效果,见 mixAudioInChrome);
 *   'ffmpeg' 走 scripts/mux-audio.mjs 的滤镜图直接混(没有效果),对账和兜底用。
 */
export async function exportFrames(opts) {
  const outDir = opts.out || 'out';
  const noVideo = opts.noVideo || false;
  const workers = (opts.bakery || opts.targetFrames) ? 1 : await resolveWorkers(opts.workers);
  const mediaMode = opts.media === 'ffmpeg' && !opts.bakery ? 'ffmpeg' : 'chrome';
  const ffmpegCmd = await findFfmpeg();
  let plan = null;
  let bakeOpts = opts;
  if (mediaMode === 'ffmpeg') {
    const url = opts.url || DEFAULT_URL;
    bakeOpts = { ...opts, url: url + (url.includes('?') ? '&' : '?') + 'cardsOnly=1' };
    // 不出视频(--no-video)、离散取样都不合成,也就用不上素材规划和遮罩
    if (!noVideo && !opts.targetFrames) {
      plan = await planMedia(opts, outDir, ffmpegCmd);
      if (plan?.glassFrames.size) bakeOpts.glassFrames = plan.glassFrames;
    }
  }
  let baked;
  // Full single-worker exports stream Chrome PNGs directly into local ffmpeg.
  // No frame buffer list or PNG directory is needed for the compositor.
  // Stream only a complete timeline.  A --frames segment starts its PNG
  // sequence at an arbitrary absolute frame; keeping that path file-backed
  // preserves the segment's start_number and avoids treating a partial stream
  // as a timeline that begins at frame zero.
  const streamCards = !opts.bakery && workers === 1 && !opts.targetFrames && !opts.frames && !noVideo;
  await fs.mkdir(outDir, { recursive: true });
  const streamedCards = streamCards ? streamPngVideo(ffmpegCmd, path.join(outDir, 'overlay.mov'), opts.fps || 30) : null;
  try {
    const unifiedProject = mediaMode === 'chrome' && !opts.bakery ? await loadProject(opts.url || DEFAULT_URL, outDir) : null;
    if (unifiedProject) {
      const { exportUnified } = await import('./export-unified.mjs');
      baked = await exportUnified(unifiedProject, { ...opts, url: opts.url || DEFAULT_URL,
        ...(streamedCards ? { onFrame: (_frame, buf) => streamedCards.write(buf), writeFrames: false } : {}) });
    } else if (workers > 1) {
      baked = await bakeSharded(bakeOpts, workers);
    } else {
      const bakery = opts.bakery || await openBakery(bakeOpts);
      try { baked = await bakeFrames(bakery, { ...bakeOpts, ...(streamedCards ? { onFrame: (_frame, buf) => streamedCards.write(buf), writeFrames: false } : {}) }); }
      finally { if (!opts.bakery) await bakery.close(); }
    }
    if (streamedCards) await streamedCards.finish();
  } catch (error) {
    await streamedCards?.abort();
    throw error;
  }
  const { framesDir, ext, fps, width, height, startFrame, endFrame, durationSec } = baked;

  if (!noVideo) {
    console.log('Running ffmpeg to generate video files...');
    const runFfmpeg = (args) => new Promise((resolve, reject) => {
      const proc = spawn(ffmpegCmd, args, { stdio: 'inherit' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
      proc.on('error', reject);
    });
    try {
      // 卡片透明层。素材走 ffmpeg 时这里只有卡片 —— 名字说的就是它:叠到别的画面上用的那一层
      const bakedCardsVideo = baked.cardsVideo || null;
      if (streamCards || bakedCardsVideo) {
        console.log(`${bakedCardsVideo ? '分片 overlay.mov 已合并' : 'overlay.mov 已由 Chrome 帧流式写入'}本地 ffmpeg。`);
      }
      else {
        console.log('Creating overlay.mov...');
        await runFfmpeg(['-y', '-framerate', String(fps), '-start_number', String(startFrame),
          '-i', path.join(framesDir, `%06d.${ext}`), '-c:v', 'prores_ks', '-profile:v', '4444',
          '-pix_fmt', 'yuva444p10le', path.join(outDir, 'overlay.mov')]);
      }
      /*
       * 没有素材的项目也走同一条合成(0 个素材层 = 灰底 + 卡片)。以前这里单留一条老命令,它踩的是同一个坑:
       * 整帧不透明的卡片 PNG 不带 alpha,ffmpeg 中途重建滤镜图,随机丢帧、还可能卡死(实测旧 preview.mp4 1792/1800)。
       * buildComposeArgs 每个输入都带 -reinit_filter 0,还有看门狗;走它两条路就一起好了。
       */
      const layers = (plan?.layers || []).filter((l) => clipFrameRange(l.clip, fps, startFrame, endFrame));
      await composePreview({ ffmpegCmd, baked, layers, outDir,
        cardsVideo: bakedCardsVideo || (streamCards ? path.join(outDir, 'overlay.mov') : null) });
      // 音轨:逐帧截图只有画面,声音在这里拼回去(配乐 + 视频自带的声音 + 音频效果)
      try {
        // 页面拿的是哪份项目就混哪份(和 planMedia 同一个 loadProject):以前只认 <out>/project.json,
        // 命令行 --out 指到别处时就静悄悄地没声音
        const proj = await loadProject(opts.url || DEFAULT_URL, outDir);
        if (proj) {
          const ffprobeCmd = ffprobeOf(ffmpegCmd);
          // 和画面层同一套找素材的规则:素材库里的 /@media/<文件> 也要找得到,不然配乐 / 配音全被跳过
          const sourceOf = (m) => mediaSourceOf(m, { outDir, pageUrl: opts.url || DEFAULT_URL, mediaRoot: mediaRootDir() });
          const plan = buildAudioPlan(proj, outDir, undefined, sourceOf).filter((c) => hasAudioStream(c.file, ffprobeCmd));
          if (plan.length > 0) {
            const preview = path.join(outDir, 'preview.mp4');
            const withAudio = path.join(outDir, 'preview-audio.mp4');
            /*
             * 默认在 Chrome 里混(OfflineAudioContext,和编辑台预览同一套效果链,见 src/audio/renderMix.ts):
             * 音频效果只有这条路才有。失败(混音页起不来、页面地址没有 /@export/<id>)就退回 ffmpeg 直接混 ——
             * 那样效果没了,但配乐 / 配音 / 原声都在;--audio ffmpeg 强制走老路(对账用)。
             */
            let mixed = false;
            if (opts.audio !== 'ffmpeg') {
              try {
                const r = await mixAudioInChrome({ ffmpegCmd, outDir, plan, pageUrl: opts.url || DEFAULT_URL, durationSec });
                await runFfmpeg(['-y', '-i', preview, '-i', r.mixWav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durationSec), withAudio]);
                mixed = true;
                // 裁好的 float32 wav 和整条 mix.wav 一小时就是一两 GB,合进成片之后就没用了
                await fs.rm(path.join(outDir, 'audio'), { recursive: true, force: true }).catch(() => {});
              } catch (e) {
                const fx = plan.filter((c) => c.fx).length;
                console.error('Chrome 混音失败,退回 ffmpeg 直接混' + (fx ? '(' + fx + ' 段挂着的音频效果会丢)' : '') + ':', e.message);
              }
            }
            if (!mixed) {
              console.log('Muxing ' + plan.length + ' audio clip(s) with ffmpeg...');
              await runFfmpeg(buildFfmpegArgs(preview, plan, withAudio, durationSec));
            }
            fsSync.rmSync(preview);
            fsSync.renameSync(withAudio, preview);
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
      // 以前这里吞掉错误照常退出 0,界面报「导出完成」、取件时才发现没有 preview.mp4
      process.exitCode = 1;
    }
  }
}

/**
 * 声音在 Chrome 里混:每段先用 ffmpeg 裁出时间轴用到的那一截(48 kHz 立体声 float wav,几 MB),
 * 写一份 plan.json,开混音页(?audioMix=1,src/AudioMixView.tsx)在 OfflineAudioContext 里按位置、音量、
 * 淡入淡出、音频效果渲成整条 mix.wav 交回服务端(POST /api/export/<id>/audio-mix)。
 * 页面和预览用同一份效果链(src/audio/fxChain.ts),所以编辑台听到的就是导出的。
 * 需要页面地址里有 /@export/<id>/project.json —— 裁好的 wav 就靠这个 id 从 dev server 取。
 */
async function mixAudioInChrome({ ffmpegCmd, outDir, plan, pageUrl, durationSec }) {
  const u = new URL(pageUrl);
  const m = /^\/@export\/([^/]+)\/project\.json$/.exec(u.searchParams.get('timeline') || '');
  if (!m) throw new Error('页面地址里没有 /@export/<id>/project.json,混音页取不到裁好的 wav');
  const id = m[1];
  // 时间轴时长之后才开始的段不出声,不用裁(项目 duration 比内容短时 plan 里会有这种段)
  plan = plan.filter((e) => e.start < durationSec);
  const audioDir = path.join(outDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const run = (args) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegCmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code + ':' + err.trim().slice(-400)))));
    p.on('error', reject);
  });
  // 裁段:4 个并行,每段只解用到的那几秒
  const clips = new Array(plan.length);
  let next = 0;
  let aborted = false;
  const worker = async () => {
    while (next < plan.length && !aborted) {
      const i = next++;
      const e = plan[i];
      const wav = path.join(audioDir, 'clip-' + i + '.wav');
      await run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(e.offset), '-t', String(e.dur), '-i', e.file,
        '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', wav]);
      clips[i] = { clipId: e.clipId, url: '/@export/' + id + '/audio/clip-' + i + '.wav', start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx };
    }
  };
  // 一个裁段失败就让其余 worker 停下来,别让孤儿 ffmpeg 继续往 audio/ 里写
  await Promise.all(Array.from({ length: Math.min(4, plan.length) }, worker)).catch((e) => { aborted = true; throw e; });
  const mixPlan = { sampleRate: 48000, duration: Number(durationSec), clips };
  await fs.writeFile(path.join(audioDir, 'plan.json'), JSON.stringify(mixPlan));

  console.log('Mixing ' + clips.length + ' audio clip(s) in Chrome...');
  const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 120000, args: ['--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  let result;
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warn') console.log('MIX LOG:', msg.text()); });
    const mixUrl = u.origin + '/?audioMix=1&plan=' + encodeURIComponent('/@export/' + id + '/audio/plan.json') + '&out=' + encodeURIComponent('/api/export/audio-mix/' + id);
    const resp = await page.goto(mixUrl, { waitUntil: 'load', timeout: 60000 });
    // 拿到的不是混音页(403 说明页、404)就当场失败,别等到超时才退回 ffmpeg
    if (resp && !resp.ok()) throw new Error('混音页打不开:HTTP ' + resp.status());
    const handle = await page.waitForFunction(() => window.__pcAudioMix, { timeout: 90000, polling: 200 }).catch(async (e) => {
      const title = await page.title().catch(() => '');
      throw new Error('混音页 90 秒没有结果(页面标题「' + title + '」):' + e.message);
    });
    result = await handle.jsonValue();
  } finally {
    await browser.close().catch(() => {});
  }
  if (!result?.ok) throw new Error(result?.error || '混音页没有返回结果');
  for (const n of result.notes || []) console.warn('混音:', n);
  const mixWav = path.join(audioDir, 'mix.wav');
  if (!fsSync.existsSync(mixWav)) throw new Error('mix.wav 没交回来');
  const peakDb = 20 * Math.log10(Math.max(result.peak || 0, 1e-9));
  console.log('Chrome mix done in ' + ((result.renderMs || 0) / 1000).toFixed(2) + ' s, peak ' + peakDb.toFixed(1) + ' dBFS' + (peakDb > 0 ? '(削波!挂个 limiter 或压低音量)' : ''));
  return { mixWav, clips: clips.length };
}

/**
 * 跑一趟 ffmpeg,用 -progress 读出已出的帧数回调给 onFrame。
 * 看门狗:stallMs 内帧数一直不动就杀掉报错。ffmpeg 真卡住时 CPU 归零、不报错也不退出(实测过:卡片 PNG 中途变格式
 * 触发滤镜图重建,见 buildComposeArgs 里 -reinit_filter 那段),不设这道闸,导出会在界面上永远停在某个进度。
 */
function runFfmpegProgress(ffmpegCmd, args, onFrame, stallMs = Number(process.env.PC_COMPOSE_STALL_MS) || 45000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegCmd, ['-progress', 'pipe:1', '-nostats', '-loglevel', 'warning', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    let last = -1;
    let lastChange = Date.now();
    let stalled = false;
    const dog = setInterval(() => {
      if (Date.now() - lastChange > stallMs) {
        stalled = true;
        proc.kill();
      }
    }, 2000);
    proc.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        const m = /^frame=(\d+)$/.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n !== last) {
          last = n;
          lastChange = Date.now();
          onFrame(n);
        }
      }
    });
    proc.on('close', (code) => {
      clearInterval(dog);
      if (stalled) reject(Object.assign(new Error(`ffmpeg 合成 ${stallMs / 1000} 秒没有任何进展(停在第 ${Math.max(0, last)} 帧),已中止`), { stalled: true }));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg(素材合成)exited with code ${code}`));
    });
    proc.on('error', (e) => {
      clearInterval(dog);
      reject(e);
    });
  });
}

/**
 * 素材合成那一步:灰底 + 素材层(+ 毛玻璃)+ 卡片层 → preview.mp4,一趟 ffmpeg。
 * 进度用 -progress 读出来,打成 `Composited frame n/N`,vite-plugin-export 转给界面。
 */
async function composePreview({ ffmpegCmd, baked, layers, outDir, cardsVideo = null }) {
  const { framesDir, ext, fps, width, height, startFrame, endFrame } = baked;
  const total = endFrame - startFrame + 1;
  const glassList = baked.glass?.list || [];
  const blurs = baked.glass?.blurs || [];
  const blur = blurs.length ? Math.max(...blurs) : 0;
  if (blurs.length > 1) console.warn(`毛玻璃的模糊量不止一种(${blurs.join(' / ')} px),统一按最大的 ${blur}px 合成`);
  let mask = null;
  if (glassList.length && blur > 0) {
    await fillGlassGaps(baked.glass.dir, startFrame, endFrame, width, height);
    mask = { pattern: path.join(baked.glass.dir, '%06d.png'), blur };
  }
  const { args, graph, notes, sidecars = [] } = buildComposeArgs({
    width, height, fps, startFrame, endFrame, layers, mask,
    cardsPattern: path.join(framesDir, `%06d.${ext}`),
    cardsVideo,
    out: path.join(outDir, 'preview.mp4'),
    // 随时间变化的滤镜每段一份 sendcmd 脚本,写进导出目录;给绝对路径,不依赖 ffmpeg 的工作目录
    sidecarDir: path.resolve(outDir),
  });
  await Promise.all(sidecars.map((s) => fs.writeFile(s.file, s.text, 'utf8')));
  for (const n of notes) console.warn('合成:', n);
  let finalArgs = args;
  // 片段多、带强调时 filter graph 会很长;Windows 命令行上限 32K 字符,长了改用文件传
  if (graph.length > 8000) {
    const f = path.join(outDir, 'compose-filter.txt');
    await fs.writeFile(f, graph, 'utf8');
    const k = args.indexOf('-filter_complex');
    finalArgs = [...args.slice(0, k), '-/filter_complex', f, ...args.slice(k + 2)];
  }
  console.log(`Creating preview.mp4: compositing ${layers.length} media clip(s)${mask ? ` + glass blur ${blur}px on ${glassList.length} frame(s)` : ''} with ffmpeg...`);
  const t0 = Date.now();
  let printed = -1;
  await runFfmpegProgress(ffmpegCmd, finalArgs, (n) => {
    const k = Math.min(total, n);
    if (k !== printed) {
      printed = k;
      console.log(`Composited frame ${k}/${total}`);
    }
  });
  console.log(`Composited ${total} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

const isMain = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  // 默认单进程:分片的每一片都要从第 0 帧推起,实测提速有限、还和别的 Chrome 抢 CPU(见 balancedShards 上面)。
  // 以前这里默认 'auto',而 /api/export 不传 --workers,于是每次导出都开到 4 个分片
  const opts = { noVideo: false, workers: 'auto' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--workers') opts.workers = args[++i];
    else if (args[i] === '--media') opts.media = args[++i];
    else if (args[i] === '--audio') opts.audio = args[++i]; // ffmpeg:不走 Chrome 混音(没有音频效果),对账用
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
