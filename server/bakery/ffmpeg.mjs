/**
 * ffmpeg 这一层:去哪儿找它、怎么把 Chrome 的 PNG 流直接喂给它、怎么读它的进度。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。
 */

import path from 'path';
import { spawn } from 'child_process';

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

/** Encode incoming screenshots immediately so Node retains at most one PNG.
 * The movie must hold exactly the frames written: a shorter file shifts every
 * later shard in the concatenated export, so a mismatch is an error.
 */
export function streamPngVideo(ffmpeg, file, fps) {
  const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2', '-f', 'image2pipe', '-vcodec', 'png',
    '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks', '-profile:v', '4444',
    '-pix_fmt', 'yuva444p10le', file], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', partial = '', inputError = null, written = 0;
  const progress = {};
  proc.stderr.on('data', d => {
    const lines = (partial + d).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      const m = /^(frame|drop_frames|dup_frames|progress)=(\S*)$/.exec(line);
      if (m) progress[m[1]] = m[2];
      else if (!/^[a-z_0-9]+=/.test(line)) stderr = (stderr + line + '\n').slice(-8000);
    }
  });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      if (partial && !/^[a-z_0-9]+=/.test(partial)) stderr = (stderr + partial).slice(-8000);
      code === 0 ? resolve() : reject(inputError || new Error(`ffmpeg ${code}: ${stderr}`));
    });
  });
  done.catch(() => {});
  return {
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
      written++;
    },
    async finish() {
      proc.stdin.end();
      await done;
      const encoded = Number(progress.frame);
      if (process.env.PC_STREAM_DEBUG) console.log(`[stream-png] ${file}: written=${written} encoded=${progress.frame} drop=${progress.drop_frames} dup=${progress.dup_frames}`);
      if (encoded !== written) {
        throw new Error(`${file}: wrote ${written} frames but ffmpeg encoded ${progress.frame ?? 'unknown'} (drop=${progress.drop_frames}, dup=${progress.dup_frames}) ${stderr}`);
      }
    },
    async abort() { proc.stdin.destroy(); proc.kill(); await done.catch(() => {}); },
  };
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

export { ffprobeOf, runFfmpegProgress };
