// 假的 promptcut_stt 命令行,只给 cloud-tools-p2-stt.test.mjs 用:按 JSONL 约定输出,行为由第一个参数(模式)决定。
// 真 Python 的验证在 cloud-tools-p2-stt-real.test.mjs 和 scripts/probes/cloud-tools-p2-stt-probe.mjs。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [mode, sub, ...rest] = process.argv.slice(2);
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

if (sub === 'status') {
  if (mode === 'broken') { process.stderr.write('boom\n'); process.exit(1); }
  emit({
    python: '3.11.9', executable: 'C:\\secret\\python.exe', package: '0.1.0',
    pylibs: { path: 'C:\\secret\\pylibs', exists: true, writable: mode !== 'readonly-pylibs' },
    models_dir: 'C:\\secret\\models',
    engines: {
      'faster-whisper': mode === 'no-engine' ? { installed: false, version: null, error: 'x' } : { installed: true, version: '1.2.1', error: null },
      whisper: { installed: false, version: null, error: 'x' },
    },
    cuda: false,
    models: [{ name: 'models--Systran--faster-whisper-small', path: 'C:\\secret\\models\\m', bytes: 1234 }],
    available_models: { 'faster-whisper': mode === 'no-model' ? [] : ['small'], whisper: [] },
    ffmpeg: mode === 'no-ffmpeg' ? null : 'C:\\secret\\ffmpeg.exe',
  });
  process.exit(0);
}

if (sub === 'install') {
  fs.writeFileSync(path.join(process.cwd(), 'install-argv.json'), JSON.stringify(rest));
  emit({ event: 'start', engine: arg('--engine') });
  for (let i = 0; i < 3; i += 1) emit({ event: 'log', line: `pip line ${i}` });
  if (mode === 'slow') {
    fs.writeFileSync(path.join(process.cwd(), 'install-pid.json'), JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
  } else if (mode === 'fail') {
    emit({ event: 'error', message: 'pip 安装失败(退出码 1)', code: 1 });
    process.exit(1);
  } else {
    emit({ event: 'done', engine: arg('--engine'), seconds: 0.1 });
    process.exit(0);
  }
} else if (sub === 'transcribe') {
  const input = arg('--input');
  const bytes = fs.readFileSync(input);
  const sha = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(process.cwd(), 'transcribe-argv.json'), JSON.stringify(rest));
  emit({ event: 'start', engine: arg('--engine') });
  if (mode === 'slow') {
    // 再起一个孙进程,证明杀的是整棵树
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(process.cwd(), 'pids.json'), JSON.stringify({ child: process.pid, grandchild: grand.pid }));
    emit({ event: 'progress', done: 1, total: 10 });
    setInterval(() => {}, 1000);
  } else if (mode === 'fail-generic' || mode === 'fail-model' || mode === 'fail-noaudio') {
    const kind = { 'fail-generic': 'transcribe-failed', 'fail-model': 'model-missing', 'fail-noaudio': 'no-audio' }[mode];
    emit({ event: 'error', message: `C:\\secret\\tmp\\x 出错了 ${kind}`, kind });
    process.exit(1);
  } else {
    const delay = mode === 'delay' ? 700 : 0;
    const segments = mode === 'silent' ? [] : mode === 'badsegs' ? 'oops' : mode === 'huge'
      ? Array.from({ length: 30 }, (_, i) => ({ start: i, end: i + 0.5, text: `s${i}` }))
      : [{ start: 0, end: 1.2, text: `sha:${sha.slice(0, 12)}` }, { start: 1.2, end: 2.5, text: '  第二段  ' }, { start: 3, end: 2, text: '坏段(终点早于起点)' }];
    const finish = () => {
      emit({ event: 'done', segments, text: 'x', language: arg('--language') === 'auto' ? 'zh' : arg('--language'), engine: arg('--engine'), model: arg('--model'), duration: 2.5, seconds: 0.1 });
      process.exit(0);
    };
    emit({ event: 'progress', done: 1, total: 2 });
    setTimeout(() => { emit({ event: 'progress', done: 2, total: 2 }); setTimeout(finish, delay); }, delay);
  }
} else {
  process.stderr.write(`unknown sub ${sub}\n`);
  process.exit(2);
}
