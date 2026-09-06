import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

export async function exportFrames(opts) {
  const url = opts.url || 'http://127.0.0.1:5190/?export=1';
  const outDir = opts.out || 'out';
  const noVideo = opts.noVideo || false;

  const framesDir = path.join(outDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });

  console.log(`Launching Puppeteer...`);
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  const client = await page.createCDPSession();

  // Block Vite HMR WebSocket so concurrent edits from others don't break determinism
  await page.evaluateOnNewDocument(() => {
    window.WebSocket = undefined;
    Object.defineProperty(window, '__pcClockRate', {
      get: () => 1,
      set: () => {}
    });
  });

  await client.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });

  console.log(`Navigating to ${url}...`);
  page.goto(url).catch(() => {});

  console.log('Waiting for window.__pcReady...');
  while (true) {
    const isReady = await page.evaluate(() => window.__pcReady).catch(() => false);
    if (isReady) break;
    await client.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: 100 });
    await new Promise(r => client.once('Emulation.virtualTimeBudgetExpired', r));
  }

  const timeline = await page.evaluate(() => window.__pcTimeline);
  if (!timeline) throw new Error('Timeline not found');
  
  await page.evaluate(() => window.__pcSetT && window.__pcSetT(-1));
  
  const width = timeline.width;
  const height = timeline.height;
  let fps = opts.fps || timeline.fps;
  let startFrame = 0;
  let endFrame = Math.floor(timeline.duration * fps) - 1;

  if (opts.frames) {
    const [a, b] = opts.frames.split('-').map(Number);
    startFrame = a;
    endFrame = b;
  }

  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  console.log(`Timeline: ${width}x${height} @ ${fps}fps. Exporting frames ${startFrame}-${endFrame}.`);

  // Allow React initial render and clock rate calibration
  console.log('Advancing initial virtual time (100ms)...');
  await client.send('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending',
    budget: 100
  });
  await new Promise(r => {
    client.once('Emulation.virtualTimeBudgetExpired', r);
  });
  // One extra rAF to settle
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));

  const totalFrames = endFrame - startFrame + 1;
  const startTime = Date.now();

  for (let i = startFrame; i <= endFrame; i++) {
    await page.evaluate(sec => window.__pcSetT(sec), i / fps);
    
    await client.send('Emulation.setVirtualTimePolicy', {
      policy: 'pauseIfNetworkFetchesPending',
      budget: 1000 / fps
    });
    await new Promise(r => {
      client.once('Emulation.virtualTimeBudgetExpired', r);
    });

    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
    await page.evaluate(() => Promise.all([...document.images].map(img => img.decode().catch(() => {}))));

    const probeMs = await page.evaluate(() => window.__pcProbeMs);

    const framePath = path.join(framesDir, `${String(i).padStart(6, '0')}.png`);
    await page.screenshot({ omitBackground: true, type: 'png', path: framePath });

    if ((i - startFrame + 1) % 10 === 0 || i === endFrame || i <= 2) {
      console.log(`Exported frame ${i} (${i - startFrame + 1}/${totalFrames}), Probe Ms: ${probeMs}`);
    }
  }

  await browser.close();
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Export finished in ${elapsed}s.`);

  if (!noVideo) {
    console.log('Running ffmpeg to generate video files...');
    const localAppData = process.env.LOCALAPPDATA || '';
    const ffmpegFallback = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe');
    
    // Quick check if ffmpeg is in PATH by running `ffmpeg -version`
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
      const overlayArgs = [
        '-y',
        '-framerate', String(fps),
        '-start_number', String(startFrame),
        '-i', path.join(framesDir, '%06d.png'),
        '-c:v', 'prores_ks',
        '-profile:v', '4444',
        '-pix_fmt', 'yuva444p10le',
        path.join(outDir, 'overlay.mov')
      ];
      console.log(`Creating overlay.mov...`);
      await runFfmpeg(overlayArgs);

      const previewArgs = [
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=#333333:s=${width}x${height}:r=${fps}`,
        '-framerate', String(fps),
        '-start_number', String(startFrame),
        '-i', path.join(framesDir, '%06d.png'),
        '-filter_complex', '[0:v][1:v]overlay[out]',
        '-map', '[out]',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-shortest',
        path.join(outDir, 'preview.mp4')
      ];
      console.log(`Creating preview.mp4...`);
      await runFfmpeg(previewArgs);
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
    else if (args[i] === '--no-video') opts.noVideo = true;
  }
  exportFrames(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
