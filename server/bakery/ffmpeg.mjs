/**
 * ffmpeg 这一层:去哪儿找它、怎么把 Chrome 的 PNG 流直接喂给它、怎么读它的进度。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。
 */

import path from 'path';
import zlib from 'zlib';
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

/* ======================================================================== *
 * 轨道流(R8 / G3)的分段编码器
 *
 * 一个分段 = 一次 ffmpeg 调用:PNG 经 image2pipe 从 stdin 喂进去,fMP4 字节从 stdout 收回来。
 * 切 init / 分段、丢 mfra 在 Node 端(`server/frame-stream.mjs`),这里只管「编」。
 * ======================================================================== */

/** 每个分段恰好这么多个样本(G2;末段除外) */
export const STREAM_SEGMENT_FRAMES = 15;

/**
 * 每个编码器一行参数(G3 的表):**不要拿公共块去拼** —— `-sc_threshold` 这类不是所有编码器都认。
 * `pixFmt`:滤镜链尾巴的像素格式。`h264_mf` 的硬件路径只收 `nv12`(G0-b (7):写 `yuv420p`
 * 直接 `format negotiation failed`)。
 *
 * nvenc / qsv / amf 三行本机没跑成(G0-b (7):驱动 / 硬件缺席),是照任务书原样保留的,不是实测结论;
 * nvenc 的 `-tune ll` 与 `-rc vbr -cq` 二选一也没测成,这里保留任务书写的 `-rc vbr -cq` 那一组。
 */
export const STREAM_ENCODERS = {
  libx264: { pixFmt: 'yuv420p', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0'] },
  h264_nvenc: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '16', '-b:v', '0', '-g', '15', '-bf', '0', '-no-scenecut', '1', '-forced-idr', '1', '-strict_gop', '1'] },
  h264_qsv: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '16', '-g', '15', '-bf', '0'] },
  h264_amf: { pixFmt: 'yuv420p', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '16', '-qp_p', '16'] },
  h264_mf: { pixFmt: 'nv12', args: ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '90', '-g', '15', '-bf', '0'] },
};

/** 探测顺序(G0-b 结论 4):硬件优先,`libx264` 排在 `h264_mf` 前面(后者慢一倍、只出 Baseline) */
export const STREAM_ENCODER_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264', 'h264_mf'];

/**
 * 缺省编码器是 `libx264`(G0-b 结论 4:本机唯一实测全过,耗时、体积、profile 三项都最好)。
 * 硬件编码器**只在显式点名时才先试**(`PROMPTCUT_STREAM_ENCODER=auto` 按上面的顺序探测,
 * 或直接写编码器名):本机四个硬件编码器全是「列着但跑不了」,而 nvenc 那一行的参数没实测过。
 */
export function streamEncoderPreference(env = process.env) {
  const want = String(env.PROMPTCUT_STREAM_ENCODER || '').trim();
  if (!want) return ['libx264', 'h264_mf'];
  if (want === 'auto') return [...STREAM_ENCODER_ORDER];
  return [want, ...STREAM_ENCODER_ORDER.filter(name => name !== want)].filter(name => STREAM_ENCODERS[name]);
}

/**
 * G3 的滤镜链。**色半区存预乘色**(`premultiply=inplace=1`,透明处 RGB 恒为纯黑);
 * **`out_range=tv`**(G0-b 结论 2:`pc` 在 Chrome 上会被当成限定范围再展开一次,alpha 平均误差 8.4/255)。
 * 宽高已经是 G1 外扩过的偶数,滤镜链不再取整。
 */
export function streamFilter(pixFmt = 'yuv420p') {
  return '[0:v]format=gbrap,premultiply=inplace=1,format=rgba,split=2[c][a];'
    + '[c]format=rgb24,pad=iw:ih+8:0:0:black[rgb];'
    + '[a]alphaextract,format=gray,format=rgb24,pad=iw:ih+8:0:0:black[mask];'
    + `[rgb][mask]vstack=inputs=2,scale=out_range=tv:out_color_matrix=bt709,format=${pixFmt}`;
}

/** 一个分段的完整命令行(输出 fMP4 到 stdout) */
export function streamSegmentArgs({ encoder = 'libx264', fps }) {
  const spec = STREAM_ENCODERS[encoder];
  if (!spec) throw new Error(`未知的轨道流编码器 ${encoder}`);
  if (!(Number(fps) > 0)) throw new Error('轨道流编码要帧率');
  return ['-y', '-hide_banner', '-loglevel', 'error',
    '-reinit_filter', '0', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', streamFilter(spec.pixFmt),
    ...spec.args,
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-video_track_timescale', String(fps),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-an',
    '-f', 'mp4', 'pipe:1'];
}

/**
 * 开一个分段编码器。`write(png)` 按到达顺序喂(背压:等 stdin 收下),`finish()` 回 ffmpeg 输出的
 * 整段 fMP4 字节(`ftyp moov moof mdat mfra`),`abort()` 丢掉。
 * 喂进去几帧、ffmpeg 就该编出几帧 —— 对不上由切分那一侧按样本数判(G2「少一帧就重拍」)。
 */
export function openStreamSegmentEncoder(ffmpeg, { encoder = 'libx264', fps }) {
  const args = streamSegmentArgs({ encoder, fps });
  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const chunks = [];
  let stderr = '', inputError = null, written = 0;
  const startedAt = Date.now();
  proc.stdout.on('data', d => chunks.push(d));
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  proc.stdin.on('error', e => { inputError = e; });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(Buffer.concat(chunks))
      : reject(inputError || new Error(`ffmpeg(${encoder})退出码 ${code}:${stderr.trim()}`)));
  });
  done.catch(() => {});
  return {
    encoder,
    get written() { return written; },
    async write(buffer) {
      if (inputError) throw inputError;
      await new Promise((resolve, reject) => proc.stdin.write(buffer, e => e ? reject(e) : resolve()));
      written++;
    },
    async finish() {
      proc.stdin.end();
      const bytes = await done;
      return { bytes, encodeMs: Date.now() - startedAt, written };
    },
    async abort() { try { proc.stdin.destroy(); } catch {} proc.kill(); await done.catch(() => {}); },
  };
}

/** 探测用的一小段:两张 320×240 的半透明 PNG(内联,不依赖任何素材文件;`h264_mf` 太小的画面直接拒编) */
function probePngs() {
  // RGBA,左半不透明红、右半全透明;两张内容相同即可 —— 只看能不能编出来
  const width = 320, height = 240;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      if (x < width / 2) { raw[i] = 255; raw[i + 3] = 255; }
    }
  }
  return [pngOf(raw, width, height), pngOf(raw, width, height)];
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function pngOf(raw, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * 这台机器上哪些 H.264 编码器**真的能编**(G0-b 结论 4:必须真编一小段再判定 ——
 * 本机四个硬件编码器全是「`ffmpeg -encoders` 里列着但跑不了」)。
 *
 * 走的是和分段一模一样的命令行(同一条滤镜链、同一组参数、同样输出 fMP4),
 * 编出来的字节里要有 `moof` 才算过。按 `order` 顺序逐个试,回全部结果。
 */
export async function probeEncoders(ffmpeg, { order = STREAM_ENCODER_ORDER, fps = 30, timeoutMs = 15000 } = {}) {
  const pngs = probePngs();
  const results = [];
  for (const name of order) {
    if (!STREAM_ENCODERS[name]) { results.push({ name, ok: false, error: '未知编码器' }); continue; }
    const started = Date.now();
    const enc = openStreamSegmentEncoder(ffmpeg, { encoder: name, fps });
    const timer = setTimeout(() => { void enc.abort(); }, timeoutMs);
    try {
      for (const png of pngs) await enc.write(png);
      const { bytes } = await enc.finish();
      const ok = bytes.includes(Buffer.from('moof', 'latin1')) && bytes.includes(Buffer.from('avcC', 'latin1'));
      results.push({ name, ok, ms: Date.now() - started, error: ok ? null : '输出里没有 moof / avcC' });
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - started, error: String(e?.message || e).split(/\r?\n/).slice(-2).join(' ') });
    } finally { clearTimeout(timer); }
  }
  return results;
}

/** 按 `preference` 找第一个真能编的编码器;一个都不行就抛。结果按 ffmpeg 路径缓存 */
const pickedEncoders = new Map();
export async function pickStreamEncoder(ffmpeg, preference = streamEncoderPreference()) {
  const key = `${ffmpeg}\u0000${preference.join(',')}`;
  if (!pickedEncoders.has(key)) {
    pickedEncoders.set(key, (async () => {
      const results = await probeEncoders(ffmpeg, { order: preference });
      const hit = results.find(r => r.ok);
      if (!hit) throw Object.assign(new Error(`没有能用的 H.264 编码器:${results.map(r => `${r.name}(${r.error})`).join('; ')}`), { code: 'NO_STREAM_ENCODER', results });
      return { encoder: hit.name, results };
    })());
    pickedEncoders.get(key).catch(() => pickedEncoders.delete(key));
  }
  return pickedEncoders.get(key);
}
