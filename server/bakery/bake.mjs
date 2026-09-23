/**
 * 在一个已经开着的 bakery 上逐帧预渲染。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运);预渲染间本身在 ./chrome.mjs。
 */

import path from 'path';
import fs from 'fs/promises';
import { captureSnapshot } from './capture-snapshot.mjs';
import { captureFrame } from './capture-frame.mjs';
import { framesInWindow } from '../../src/render/frameWindow.mjs';
import { waitFrameReady } from './frame-ready.mjs';
import { prepareFrameMedia } from './frame-media.mjs';

/**
 * 在一个已经开着的 bakery 上渲一段帧。返回给 ffmpeg 用的那些参数。
 *
 * opts:
 *   format/quality —— 'png' 带 alpha(导出交付物要),'jpeg' 不带(预览用的预渲染够用)。
 *                     PNG 走 optimizeForSpeed:仍然无损(实测逐字节解码后与普通 PNG 相同),只是压得快、文件大一倍。
 *   staticSkip     —— 画面静止的帧直接复用上一张,连截都不截。判据见 ExportView 的 __pcStaticProbe
 *   verifyEvery    —— 连续复用多少帧就强制真截一张比对一次
 *   targetFrames   —— 只截这几帧; fullFrame 时只回推目标所需卡片的历史
 *   seekFromActiveClips —— false 保留从 0 推进的参考路径,用于逐像素回归比对
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
   * 只截这几帧(离散取样)。完整画面从目标所需卡片的最早历史帧顺推;HTML 采样仍覆盖全部历史。
   * 保留卡片的原始挂载时刻,不跳过区间内的帧,避免按 delta 积分的动画走样。一趟推进沿途截图。
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
  const frameWindow = opts.fullFrame && targetFrames && opts.seekFromActiveClips !== false && !opts.snapshotOnly && !opts.domCache
    ? await page.evaluate(({ frames, fps }) => {
      if (!window.__pcPlanFrameWindow) throw new Error('Frame window planner is unavailable');
      return window.__pcPlanFrameWindow(frames, fps);
    }, { frames: [...targetFrames], fps }) : null;
  const advanceStartFrame = frameWindow?.startFrame ?? 0;
  const renderRanges = frameWindow?.ranges ?? [[advanceStartFrame, endFrame]];
  const sortedTargets = targetFrames ? [...targetFrames].sort((a, b) => a - b) : [];
  const directFrameAt = frame => frameWindow ? (sortedTargets.find(n => n >= frame) ?? frame) : frame;
  // Mount after planning, including the full-history / HTML paths. This also
  // clears the selection when a bakery is reused for a different kind of pass.
  await page.evaluate(({ clipIds, time, directTime }) => {
    if (!window.__pcSetFrameWindow) throw new Error('Frame window API is unavailable');
    window.__pcSetFrameWindow(clipIds, time, directTime);
  }, { clipIds: frameWindow?.clipIds ?? null, time: advanceStartFrame / fps, directTime: directFrameAt(advanceStartFrame) / fps });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // 透明底一次性打开,不用 puppeteer 的 omitBackground(那个每截一张开关一次,开关本身会触发重绘)
  if (format !== 'jpeg') {
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const shotParams = format === 'jpeg'
    ? { format: 'jpeg', quality }
    : { format: 'png', optimizeForSpeed: true };

  /*
   * 生成快照前把 Motion 的 JS 帧循环推一拍。
   *
   * 卡片上有两种动画,定住的办法不一样:
   *   - 交给 WAAPI 的那些(opacity、tween 的 transform)由 __pcSyncAnims 每帧显式钉 currentTime,
   *     getComputedStyle 立刻反映,快照拿到的就是对的;
   *   - Motion 自己的 JS 帧循环驱动的那些(spring、MotionValue)只在批处理跑一拍时才把新值
   *     写进 inline style,没有任何东西钉它。
   * 而这一拍**只有真正画一帧才会跑**:实测不带截图的 beginFrame(包括 noDisplayUpdates、
   * 先制造 DOM damage 再发)一律推不动 Motion 的 frameData.timestamp,带 screenshot 的能。
   * 于是整帧路每帧截图、DOM 总是当前帧的;HTML 快照在截图之前生成,拿到的是上一次画帧时
   * 写下的旧值 —— 纯采样的 snapshotOnly 一趟里一张图都不截,整段冻在第一帧的相位上
   * (punch-pill 的弹簧:第 1 帧之后永远是 scale(0.933311),而导出是正确的 1.0678 → 1.0037 → …)。
   *
   * 所以生成快照之前先画一拍、把图丢掉。只加在快照这一侧:整帧导出不生成快照,
   * 一步也不多走,逐字节基线不受影响。图要最便宜的(jpeg quality 0),反正立刻扔掉。
   *
   * `prime`:上一个时间点没画过(没截图、也没推过这一拍)时要**画两拍**。只画一拍,
   * Motion 的值还停在上一次画帧时的相位 —— 实测 punch-pill 只取第 8 帧(前面 0～7 帧只推时间、
   * 不截图),推一拍后快照里药丸仍是第 1 帧的 `scale(0.933311)`,活渲已经是 `none`。
   * 和 `captureFrame` 的 `prime` 是同一件事、同一个判据:紧挨着的上一帧画过才能省。
   */
  const FLUSH_SHOT = { format: 'jpeg', quality: 0 };
  const flushFrameLoop = async (prime) => {
    if (prime) await beginFrame({ screenshot: FLUSH_SHOT });
    await beginFrame({ screenshot: FLUSH_SHOT });
  };

  /** 截一张:发一拍并要这一拍的截图。此刻动画已钉住、页面时钟已量化,这一拍里画面不会再变
   *  prime:上一个时间点没截过图时先截一张丢掉,见 captureFrame。primeCapture:false 只给回归对照用 */
  const shoot = async (prime = true) => {
    const captureOpts = { prime: prime && opts.primeCapture !== false };
    // MOV/full-scene cache: keep the live scene (including video/image media)
    // visible. HTML snapshots deliberately remove video sources, so they can
    // never be used as the full-frame movie source.
    if (opts.fullFrame) {
      await prepareFrameMedia(bakery);
      return captureFrame(bakery, shotParams, opts.signal, captureOpts);
    }
    if (!opts.glassFrames) {
      // Pixel maps rasterize a hidden source video into a canvas. Load only the
      // requested frame before creating the HTML snapshot; otherwise __pcCreateSnapshot would copy
      // an empty canvas into the snapshot and every cache replay would stay blank.
      const hasPixelMap = await page.evaluate(() => !!document.querySelector("canvas[data-pc-pixel-map]"));
      if (hasPixelMap) {
        await prepareFrameMedia(bakery);
        await beginFrame();
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      // prime 只按「上一帧截没截过图」判,不知道 renderPass 这一帧是不是已经推过 —— 宁可多画一拍(幂等)
      await flushFrameLoop(prime);
      const snapshot = await page.evaluate(() => window.__pcCreateSnapshot());
      if (snapshot.lossy) throw new Error(`Cannot snapshot ${snapshot.lossy} canvas elements`);
      return captureSnapshot(bakery, snapshot.html, shotParams);
    }
    await prepareFrameMedia(bakery);
    return captureFrame(bakery, shotParams, opts.signal, captureOpts);
  };

  // 一帧 = 下发时间 → 等网络 → 排空 → 推一拍(React 提交后的 rAF、Motion 建动画都在这一拍里)→ 等网络
  //       → 排空 → 钉动画 → 排空 → 探针 → 等素材。截不截图由调用方决定。返回这一帧画面静不静止。
  const step = async (frameIndex, wantTrace) => {
    // 两个计数器要在推进之前取、推进之后比;取值和下发时间合并成一次 evaluate
    const before = await page.evaluate(({ sec, directSec }) => {
      const n = { raf: window.__pcRafCount ?? 0, mut: window.__pcMutationCount ?? 0 };
      window.__pcHideFrameMedia?.();
      window.__pcSetT(sec, directSec);
      return n;
    }, { sec: frameIndex / fps, directSec: directFrameAt(frameIndex) / fps });
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
    let probe = await page.evaluate(async () => {
      await window.__bfSettle();
      if (window.__pcSyncAnims) window.__pcSyncAnims();
      await window.__bfSettle();
      return window.__pcStaticProbe ? window.__pcStaticProbe() : null;
    });
    if (probe?.finished) {
      // WAAPI finish events and AnimatePresence's replacement child need a
      // compositor tick, then a React commit and a second tick to create the
      // entering animation. Drain these at the SAME timeline time. Otherwise
      // taking an intermediate screenshot supplies those ticks by accident,
      // and a random seek differs from a sequential export by one subtitle frame.
      const finished = probe.finished;
      for (let pass = 0; pass < 2; pass++) {
        await beginFrame();
        probe = await page.evaluate(async () => {
          await window.__bfSettle();
          window.__pcSyncAnims?.();
          await window.__bfSettle();
          return window.__pcStaticProbe?.();
        });
      }
      if (probe) probe.finished += finished;
    }
    if (trace && wantTrace) trace.push(await page.evaluate((i) => ({
      i, perfNow: performance.now(), timelineNow: document.timeline.currentTime, probeMs: window.__pcProbeMs,
      anims: document.getAnimations().map((a) => [a.playState, a.currentTime, a.startTime, a.effect && a.effect.target && a.effect.target.className && String(a.effect.target.className).slice(0, 24)]),
    }), frameIndex));
    // 再等一次网络:这一拍里新挂的组件发出的请求,requestWillBeSent 事件和 beginFrame 的回复谁先到 Node 没有保证,
    // 上面那次 waitNet 可能正好看见 0 个在途。经过一次页面内往返,事件已经追上;没有请求时这里不花时间。
    await waitNet();
    await waitFrameReady(bakery, opts.signal);
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

  // 预热停在本次推帧起点,不能回到 0 挂载无关卡片、重置目标卡的入场相位。
  // 重挂载之后再走一整帧并丢掉:重挂载会让整页失效重绘,让这一次落在丢掉的帧上。
  const warmUp = async () => {
    // Direct React cards need a layout/capture at t, not animation warm-up or
    // a restart from their clip start. The ordinary step below commits them.
    if (frameWindow && !frameWindow.replayClipIds.length) return;
    console.log(`Warm-up ${warmFrames} frames...`);
    for (let i = 0; i < warmFrames; i++) {
      // 预热也看取消:不看的话,取消要等预热走完、进了逐帧循环才生效,这段时间 worker 其实还占着
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      await step(advanceStartFrame, false);
      await beginFrame();
    }
    await page.evaluate(() => { window.__pcRestartCards && window.__pcRestartCards(); window.__pcResetAnims && window.__pcResetAnims(); });
    await step(advanceStartFrame, false);
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
      // 同一时间点刚截过卡片图,画面已是最新,不用再预热
      return await shoot(false);
    } finally {
      await page.evaluate(() => window.__bfGlassOff());
    }
  };

  /** 跑一遍全部帧。allowSkip 为假时每帧老老实实真截。返回判错的帧号;没判错返回 null。 */
  const renderPass = async (allowSkip) => {
    let lastBuf = null;  // 上一张**真截**出来的图
    let lastShotFrame = null; // 上一张真截对应的帧号:紧挨着的上一帧截过图才能省掉预热
    let lastDrawnFrame = null; // 上一次带截图的一拍落在哪一帧(真截和生成快照前推的那一拍都算),见 flushFrameLoop
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
    for (const i of framesInWindow(renderRanges)) {
      /*
       * 取消只在两帧之间生效:这时上一帧的推进、排空、截图都已经做完,页面不在半路上。
       * 调用方(render-worker)据此只换一张新页,不必把整个浏览器当成可疑的重开。
       */
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      const wantShot = targetFrames ? targetFrames.has(i) : i >= startFrame;
      const isStatic = await step(i, wantShot);
      const snapshotWanted = domDir || (opts.onSnapshot && (!opts.snapshotFrames || opts.snapshotFrames.has(i)));
      if (snapshotWanted) {
        await flushFrameLoop(lastDrawnFrame !== i - 1);
        lastDrawnFrame = i;
        const { html, lossy, controls } = await page.evaluate(() => window.__pcCreateSnapshot());
        if (lossy) throw new Error('HTML snapshot contains unreadable canvases');
        if (opts.onSnapshot && snapshotWanted) await opts.onSnapshot(i, html, controls);
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
          const real = await shoot(lastShotFrame !== i - 1);
          lastShotFrame = lastDrawnFrame = i;
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
        buf = await shoot(lastShotFrame !== i - 1);
        lastShotFrame = lastDrawnFrame = i;
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
    framesDir, ext, fps, width, height, startFrame, endFrame, advanceStartFrame,
    advancedFrames: renderRanges.reduce((sum, [a, b]) => sum + b - a + 1, 0),
    totalFrames, durationSec, reused, elapsed, domDir,
    glass: { dir: glass.dir, list: glass.list, blurs: [...glass.blurs] },
  };
}
