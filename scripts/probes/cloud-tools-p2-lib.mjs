// P2(云端语音转写)真实验证的公共部分:找依赖、造素材。素材放 out/p2-stt/(被 .gitignore 忽略,不入库)。
// 依赖(Python、faster-whisper、权重)不入库也不下载:从主工作区已装好的一份复制到 out/p2-stt/(只读主工作区),
// 复制只在 out/p2-stt/ 里没有时做一次。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const OUT = path.join(ROOT, 'out', 'p2-stt');
export const PATHS = {
  root: ROOT,
  out: OUT,
  pylibs: path.join(OUT, 'pylibs'),
  models: path.join(OUT, 'models'),
  media: path.join(OUT, 'media'),
  sourceRoot: path.join(ROOT, 'python'),
};
const MAIN = path.resolve(ROOT, '..', '..');
const MODEL_DIR = 'models--Systran--faster-whisper-small';

export function findPython() {
  const candidates = [process.env.PROMPTCUT_PYTHON, path.join(MAIN, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe'),
    path.join(ROOT, 'desktop', 'src-tauri', 'runtime', 'python', 'python.exe')].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 120_000, ...options });
}

export const ffmpegBin = () => (run('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null);

/** 缺什么就说缺什么;齐了回 null */
export function realDepsMissing() {
  if (!findPython()) return '没有找到内置 Python(PROMPTCUT_PYTHON 或主工作区 desktop/src-tauri/runtime/python)';
  if (!fs.existsSync(path.join(PATHS.pylibs, 'faster_whisper'))) return 'out/p2-stt/pylibs 里没有 faster_whisper(先跑 node scripts/probes/cloud-tools-p2-stt-probe.mjs --setup)';
  if (!fs.existsSync(path.join(PATHS.models, MODEL_DIR))) return 'out/p2-stt/models 里没有 faster-whisper small 的权重(先跑 --setup)';
  if (!ffmpegBin()) return 'PATH 上没有 ffmpeg';
  return null;
}

/** 把主工作区里已装好的 pylibs 和 small 权重复制进 out/p2-stt/(只读主工作区;已有则不动) */
export function copyDeps() {
  fs.mkdirSync(PATHS.out, { recursive: true });
  const todo = [[path.join(MAIN, 'out', 'pylibs'), PATHS.pylibs], [path.join(MAIN, 'out', 'models', MODEL_DIR), path.join(PATHS.models, MODEL_DIR)]];
  for (const [from, to] of todo) {
    if (fs.existsSync(to)) continue;
    if (!fs.existsSync(from)) throw new Error(`主工作区里没有可复制的 ${from}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  }
}

/** 造真实的短素材:Windows 系统自带的合成语音念一段已知的英文;再用 ffmpeg 拼成带视频、无音轨、长音频几种 */
export function ensureMedia() {
  fs.mkdirSync(PATHS.media, { recursive: true });
  const m = (name) => path.join(PATHS.media, name);
  const need = (file) => !fs.existsSync(file) || fs.statSync(file).size === 0;
  const ff = (args) => {
    const r = run('ffmpeg', ['-v', 'error', '-y', ...args]);
    if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
  };
  const english = m('en-speech.wav');
  if (need(english)) {
    if (process.platform !== 'win32') throw new Error('en-speech.wav 要用 Windows 自带合成语音生成;其它系统请自己放一份念「quick brown fox」的 wav 到 out/p2-stt/media/');
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $s.SetOutputToWaveFile('${english.replace(/'/g, "''")}'); $s.Speak('Hello. This is a short test of cloud speech recognition. The quick brown fox jumps over the lazy dog.'); $s.Dispose()`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
    if (r.status !== 0 || need(english)) throw new Error(`合成语音失败:${r.stderr}`);
  }
  const chinese = m('zh-speech.wav');
  if (need(chinese)) fs.copyFileSync(path.join(ROOT, 'src', 'audio', 'assets', 'missing-material.wav'), chinese);
  const video = m('en-speech-video.mp4');
  if (need(video)) ff(['-f', 'lavfi', '-i', 'testsrc=d=10:s=160x120:r=10', '-i', english, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  const silentVideo = m('silent-video.mp4');
  if (need(silentVideo)) ff(['-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo]);
  const long = m('en-speech-long.wav');
  if (need(long)) ff(['-stream_loop', '5', '-i', english, '-c', 'copy', long]);
  return { english, chinese, video, silentVideo, long };
}
