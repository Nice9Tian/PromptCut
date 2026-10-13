// P5 真实验证的公共部分(放在 server/test/ 是因为 server/ 下的测试不许 import scripts/;探针脚本反过来引用这里):
// 找依赖(转写:P2 的 Python + faster-whisper small;镜头:ffmpeg;主体:装了 onnxruntime 的 Python + light 权重)、造素材、造真提供方。
// 素材放 out/p5/(被 .gitignore 忽略,不入库)。依赖不下载:转写用 `cloud-tools-p2-stt-probe.mjs --setup` 备好的一份。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, findPython, realDepsMissing, copyDeps, ensureMedia, ROOT } from './cloud-tools-p2-real-lib.mjs';
import { createSttTools } from '../agent/service/perception/stt.mjs';
import { createShotsTools, readShotsConfig } from '../agent/service/perception/shots.mjs';
import { createSubjectTools, readSubjectConfig } from '../agent/service/perception/subject.mjs';
import { loadTestKernel } from './cloud-tools-p4-fixture.mjs';

export { ROOT };
export const OUT = path.join(ROOT, 'out', 'p5');
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
export const SUBJECT_PYTHON = process.env.PROMPTCUT_P4_PYTHON ?? path.join(home, 'anaconda3', 'envs', 'cuda_Vit', 'python.exe');
export const PLAIN_PYTHON = process.env.PROMPTCUT_P4_PLAIN_PYTHON ?? path.join(home, 'anaconda3', 'python.exe');
export const SUBJECT_MODELS = process.env.PROMPTCUT_P4_MODELS ?? path.join(ROOT, '..', '..', 'out', 'models');

const run = (command, args, options = {}) => spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 180_000, ...options });

export function findFfmpeg() {
  if (process.env.PROMPTCUT_FFMPEG && fs.existsSync(process.env.PROMPTCUT_FFMPEG)) return process.env.PROMPTCUT_FFMPEG;
  const where = run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const first = where.stdout?.split(/\r?\n/).find(Boolean)?.trim();
  return first && fs.existsSync(first) ? first : null;
}

/** 缺什么说什么;齐了回 null */
export function realChainMissing() {
  const stt = realDepsMissing();
  if (stt) return `转写依赖:${stt}`;
  if (!findFfmpeg()) return '找不到 ffmpeg';
  if (!fs.existsSync(SUBJECT_PYTHON)) return `主体识别的 Python 不存在:${SUBJECT_PYTHON}`;
  for (const f of ['yunet.onnx', 'rtdetr_r18vd.onnx']) if (!fs.existsSync(path.join(SUBJECT_MODELS, f))) return `主体识别 light 档权重缺 ${f}(${SUBJECT_MODELS})`;
  if (process.platform !== 'win32') return '造中文合成语音要 Windows 自带的 Huihui 声音';
  return null;
}

/**
 * 造一段真短片:Windows 自带的中文合成语音念一段带关键词的话(增长倍数 / 所谓…指的是 / 第一步第二步),
 * 画面是三个明显不同的场景硬切(测试图案 / 公有领域人像照片 / 彩条),声音就是这段话。已知切点在 1/3 与 2/3 处。
 */
export function ensureChineseClip() {
  copyDeps();
  ensureMedia();
  fs.mkdirSync(OUT, { recursive: true });
  const ffmpeg = findFfmpeg();
  const ffprobe = path.join(path.dirname(ffmpeg), `ffprobe${path.extname(ffmpeg)}`);
  const wav = path.join(OUT, 'zh-speech.wav');
  const video = path.join(OUT, 'zh-clip.mp4');
  const need = (f) => !fs.existsSync(f) || fs.statSync(f).size === 0;
  if (need(wav)) {
    const ps1 = path.join(OUT, 'speak.ps1');
    const text = '去年我们的用户增长了三百倍,这是一个了不起的结果。所谓留存率,指的是用户回来的比例。第一步,打开软件,第二步,导入素材,第三步,导出视频。';
    fs.writeFileSync(ps1, `﻿Add-Type -AssemblyName System.Speech\n$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n$s.SelectVoice('Microsoft Huihui Desktop')\n$s.Rate = -1\n$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')\n$s.Speak('${text}')\n$s.Dispose()\n`, 'utf8');
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ps1]);
    if (r.status !== 0 || need(wav)) throw new Error(`合成中文语音失败:${r.stderr}`);
  }
  const probe = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', wav]);
  const duration = Number(probe.stdout.trim());
  if (!(duration > 5)) throw new Error(`合成语音时长不对:${probe.stdout} ${probe.stderr}`);
  const scene = Math.round((duration / 3) * 25) / 25;       // 每个场景整数帧
  if (need(video)) {
    const photoLookup = run(SUBJECT_PYTHON, ['-c', "import matplotlib,os;print(os.path.join(os.path.dirname(matplotlib.__file__),'mpl-data','sample_data','grace_hopper.jpg'))"]);
    const photo = photoLookup.stdout.trim();
    if (!photo || !fs.existsSync(photo)) throw new Error('找不到人像照片(需要装了 matplotlib 的解释器)');
    const filter = '[0:v]setsar=1,format=yuv420p[a];[1:v]scale=-2:360,pad=640:360:(ow-iw)/2:0,setsar=1,fps=25,format=yuv420p[p];[2:v]setsar=1,format=yuv420p[c];[a][p][c]concat=n=3:v=1:a=0[v]';
    const r = run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${scene}`,
      '-loop', '1', '-t', String(scene), '-i', photo,
      '-f', 'lavfi', '-i', `smptebars=size=640x360:rate=25:duration=${scene}`,
      '-i', wav, '-filter_complex', filter, '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    if (r.status !== 0) throw new Error(`ffmpeg 造片失败:${r.stderr}`);
  }
  const vp = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', video]);
  return { wav, video, ffmpeg, duration: Number(vp.stdout.trim()), cuts: [scene, scene * 2], scene };
}

/** 造三个真提供方的工厂(转写 / 镜头 scdet / 主体 light)。`subjectPython` 可换成没装 onnxruntime 的解释器,演示「依赖没就绪」 */
export async function makeRealProviders({ subjectPython = SUBJECT_PYTHON, subjectModels = SUBJECT_MODELS, sttLimits = {} } = {}) {
  const kernel = await loadTestKernel();
  const ffmpeg = findFfmpeg();
  const shotsConfig = readShotsConfig({ PROMPTCUT_FFMPEG: ffmpeg }, { root: ROOT });
  const subjectConfig = readSubjectConfig({ PROMPTCUT_AGENT_SUBJECT_PYTHON: subjectPython, PROMPTCUT_AGENT_SUBJECT_MODELS: subjectModels, PROMPTCUT_FFMPEG: ffmpeg }, { root: ROOT });
  if (shotsConfig?.error || subjectConfig?.error) throw new Error(`配置不对:${shotsConfig?.error ?? subjectConfig?.error}`);
  return ({ resources, assets, jobs, wsOf, project }) => ({
    stt: createSttTools({
      resources, assets, jobs, workspace: wsOf, commitTranscript: (ctx, input) => project.commitTranscript(ctx, input),
      runtime: { pythonPath: findPython(), sourceRoot: PATHS.sourceRoot, pylibs: PATHS.pylibs, modelsDir: PATHS.models, ffmpegDir: path.dirname(ffmpeg), requirements: {} },
      limits: { engines: ['faster-whisper'], progressMs: 300, transcribeMs: 10 * 60_000, ...sttLimits },
    }),
    shots: createShotsTools({ config: shotsConfig, resources, assets, jobs, workspace: wsOf, project, kernel }),
    subject: createSubjectTools({ config: subjectConfig, resources, assets, jobs, workspace: wsOf, project, kernel }),
  });
}

/** 数一数还活着的转写/镜头/主体相关进程(python 与它们起的 ffmpeg) */
export function liveProcesses() {
  if (process.platform !== 'win32') return Number(run('pgrep', ['-fc', 'promptcut_(stt|subject|shots)']).stdout.trim() || '0');
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'promptcut_(stt|subject|shots)' -and $_.Name -match 'python|ffmpeg' }).Count"]);
  return Number(r.stdout.trim() || '0');
}
export function visibleWindows() {
  if (process.platform !== 'win32') return 0;
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg|python' }).Count"]);
  return Number(r.stdout.trim() || '0');
}
