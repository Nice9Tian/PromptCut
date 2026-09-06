import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * 逐帧导出。确定性模型:
 *   - 页面时间由 CDP 虚拟时间驱动,每帧推进 1000/fps ms;Motion 的 JS 动画读 performance.now(虚拟),天然逐帧一致。
 *   - CSS / Web Animations 的动画钟和虚拟时钟不同步,不靠实测比值校正(比值随机器负载变),
 *     而是每帧在虚拟时间暂停后由页面里的 __pcSyncAnims() 把每个动画的 currentTime 显式钉到
 *     「导出毫秒 − 该动画首次出现那一帧的导出毫秒」,再截图。与负载无关,导两遍逐帧相同。
 *   - rAF 等待必须在推进预算之前发出:预算耗尽后虚拟时间暂停,rAF 永远不会再回调。
 */
export async function exportFrames(opts) {
  const url = opts.url || 'http://127.0.0.1:5190/?export=1';
  const outDir = opts.out || 'out';
  const noVideo = opts.noVideo || false;
  const warmFrames = opts.warm ?? 3;

  const framesDir = path.join(outDir, 'frames');
  // PC_EXPORT_TRACE=1 时每帧记录页面时钟和全部动画状态到 <out>/trace.json,排查确定性问题用
  const trace = process.env.PC_EXPORT_TRACE ? [] : null;
  await fs.mkdir(framesDir, { recursive: true });

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
    ],
  });
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
    const rafDone = page.evaluate(() => new Promise(r => requestAnimationFrame(() => r()))).catch(() => {});
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
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // 从这一刻起页面时间归导出脚本管
  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

  // 一帧 = 下发时间 → 推进预算(React 提交、rAF、Motion 建动画都在这一格里发生)→ 钉动画 → 等素材 → 截图
  const step = async (frameIndex, shotPath) => {
    await page.evaluate(sec => window.__pcSetT(sec), frameIndex / fps);
    await advance(budget);
    await page.evaluate(() => window.__pcSyncAnims && window.__pcSyncAnims());
    if (trace && shotPath) trace.push(await page.evaluate((i) => ({
      i, perfNow: performance.now(), timelineNow: document.timeline.currentTime, probeMs: window.__pcProbeMs,
      anims: document.getAnimations().map(a => [a.playState, a.currentTime, a.startTime, a.effect && a.effect.target && a.effect.target.className && String(a.effect.target.className).slice(0, 24)]),
    }), frameIndex));
    await evalWithTimeout(() => Promise.all([...document.images].map(img => img.decode().catch(() => {}))), 3000);
    await evalWithTimeout(() => (window.__pcFrameReady ? window.__pcFrameReady() : Promise.resolve()), 3000);
    // 截图要等页面出一帧,而虚拟时间暂停时只有主线程有可见改动 Chrome 才会出帧(全是合成层动画或空舞台时就永远不出)。
    // 所以截图的同时再放一小段虚拟时间让 BeginFrame 跑起来。此时动画已全部 pause 并钉住、页面时钟已量化,
    // 这一小段里内容不会变,只是让帧产生。
    const shot = shotPath
      ? page.screenshot({ omitBackground: true, type: 'png', path: shotPath })
      : page.screenshot({ encoding: 'binary' });
    // 截图期间让虚拟时间按真实时间流动(advance),截完立刻 pause。此时动画已 pause 并钉住、页面时钟已量化,
    // 这段时间里画面不会变,只是让合成器把帧交出来。
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'advance' });
    try {
      await shot;
    } finally {
      await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    }
  };

  // 预热:让字体、布局、首批挂载稳定下来,然后重新挂载全部卡片并清空动画锚点,正式从第 0 帧开始
  console.log(`Warm-up ${warmFrames} frames...`);
  for (let i = 0; i < warmFrames; i++) await step(0, null);
  await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });

  const totalFrames = endFrame - startFrame + 1;
  const durationSec = (totalFrames / fps).toFixed(3);
  const startTime = Date.now();
  for (let i = 0; i <= endFrame; i++) {
    const shot = i >= startFrame ? path.join(framesDir, `${String(i).padStart(6, '0')}.png`) : null;
    await step(i, shot);
    if (shot && (process.env.PC_EXPORT_VERBOSE || (i - startFrame + 1) % 10 === 0 || i === endFrame)) console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames})`);
  }

  await browser.close();
  if (trace) await fs.writeFile(path.join(outDir, 'trace.json'), JSON.stringify(trace, null, 1));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Export finished in ${elapsed}s (${totalFrames} frames).`);

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
        '-i', path.join(framesDir, '%06d.png'),
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        path.join(outDir, 'overlay.mov'),
      ]);
      console.log('Creating preview.mp4...');
      await runFfmpeg([
        // 灰底是 lavfi 生成的无限流,-shortest 拦不住它(帧序列结束后 overlay 会一直重复最后一帧),
        // 必须给灰底 d= 时长并用 -t 截断,否则 ffmpeg 永远不退出、文件无限长。
        '-y', '-f', 'lavfi', '-i', `color=c=#333333:s=${width}x${height}:r=${fps}:d=${durationSec}`,
        '-framerate', String(fps), '-start_number', String(startFrame),
        '-i', path.join(framesDir, '%06d.png'),
        '-filter_complex', '[0:v][1:v]overlay=eof_action=endall[out]', '-map', '[out]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(durationSec),
        path.join(outDir, 'preview.mp4'),
      ]);
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
  }
  exportFrames(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
