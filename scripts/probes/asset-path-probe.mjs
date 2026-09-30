/**
 * Agent 读素材的路径的端到端探针(`docs/reports/AGENT-asset-path.md`;语义 `docs/semantics/product/agent.md`「素材与产物」):
 * 证明 `measure_audio` 与 `measure_audio_js` 在编辑器进程里是**经素材服务的接口**取的字节,不是按素材目录找文件。
 *
 *   node scripts/probes/asset-path-probe.mjs [--port 5920] [--keep]
 *
 * 自己起一个编辑器 dev server(`--port`,缺省 5920,舞台另占 +1、+2;带 PROMPTCUT_NO_PORT_FILE=1),产物与素材落在新建的临时目录;
 * 再在 `--port + 5` 上起一台计数的「远程素材服务」(只实现 `GET/HEAD <base>/media/<hash>`,支持 Range),充当共享项目登记的那一台。
 * 两段测试音频**只放在这台远程素材服务上**,编辑器的素材目录里一开始什么都没有;项目里素材记录的 `path` 指向不存在的目录。
 *
 *   P1 编辑器经 `POST /api/media/remote` 连上这台远程素材服务(共享项目时页面做的事);
 *   P2 `measure_audio` 测噪声素材:integrated / truePeak / LRA / threshold / duration 与探针自己用 ffmpeg 直接读本地文件
 *      (改前的读法)算出来的逐项相同;远程素材服务被请求过这份素材 —— 字节确实是经素材服务的接口来的;
 *   P3 `measure_audio_js`(登记为「高」的对话)测正弦波素材:RMS / 峰值与理论值一致;沙箱里算的 PCM 指纹与探针自己解码
 *      本地文件的相同;远程素材服务被请求过这份素材;
 *   P4 断开远程(回到本机空间):这时素材只在本地内容库里、按哈希存(`<hash>.<ext>`),素材记录的 url 不带扩展名,
 *      按目录拼文件名(改前的 `mediaFileOf`)找不到它,只有素材服务按哈希能找到;两条工具照常出结果、数值不变,远程一次也没被打到;
 *   P5 一份哪儿都没有的素材:两条工具回清楚的错(素材文件不存在 / no-media),不崩。
 *
 * 结束时只停自己起的进程(编辑器进程树、计数服务、探针的 puppeteer Chrome);`--keep` 不关、不删临时目录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,并设 PROMPTCUT_NO_PORT_FILE=1
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { findFfmpeg } from '../../server/ai-visual.mjs';
import { measureArgs, parseEbur128 } from '../../server/audio-measure.mjs';
import { filePcmArgs, decodePcm } from '../../server/audio-pcm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5920);
const KEEP = args.includes('--keep');
const REMOTE_PORT = PORT + 5;
const clashes = (p) => (p >= 5190 && p <= 5192) || (p >= 5580 && p <= 5599);
if (!(PORT >= 1024 && PORT % 10 <= 4) || [PORT, PORT + 1, PORT + 2, REMOTE_PORT].some(clashes)) {
  throw new Error(`--port ${PORT} 不行:占 PORT～PORT+2 与 PORT+5,要落在同一个 10 口段里(PORT 的个位 ≤ 4),且不碰 5190～5192、5580～5599`);
}
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-asset-path-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
const MEDIA_DIR = path.join(EXPORT_DIR, 'media');
const SRC_DIR = path.join(EXPORT_DIR, 'remote-src'); // 远程素材服务的字节(编辑器不知道这个目录)
const GONE = path.join(EXPORT_DIR, '不存在的素材目录');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(SRC_DIR, { recursive: true });

const fails = [];
const passes = [];
const out = { port: PORT, remotePort: REMOTE_PORT, exportDir: EXPORT_DIR };
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600)));
  return cond;
};

async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- 计数的远程素材服务:GET/HEAD /api/asset/media/<hash>,Range ---- */
const remoteFiles = new Map(); // hash → 文件
const remoteLog = [];
const remote = http.createServer((req, res) => {
  const m = /^\/api\/asset\/media\/([0-9a-f]{64})$/.exec(String(req.url).split('?')[0]);
  remoteLog.push({ method: req.method, url: req.url, range: req.headers.range || null, hash: m?.[1] ?? null });
  const file = m && remoteFiles.get(m[1]);
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.statusCode = 404; return res.end('Not found'); }
  const size = fs.statSync(file).size;
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  const head = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' };
  if (r) {
    const start = r[1] === '' ? Math.max(0, size - Number(r[2])) : Number(r[1]);
    const end = r[1] !== '' && r[2] !== '' ? Math.min(size - 1, Number(r[2])) : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});
const hitsOf = (hash) => remoteLog.filter((e) => e.hash === hash && e.method === 'GET').length;

const mcpCall = async (tool, callArgs, agent) => {
  const res = await fetch(`${EDITOR}/api/mcp/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args: callArgs, ...(agent ? { agent } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => null);
  return body?.result ?? body;
};
/** 登记这个对话的等级:真的走 /api/ai/chat,provider 不存在,登记之后起模型那一步直接报错,不花额度 */
const register = (conv, creativity) => fetch(`${EDITOR}/api/ai/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'probe-none', prompt: 'x', conversationId: conv, creativity, projectCreativity: 'high' }),
}).then((r) => r.text()).catch(() => '');

/** 沙箱里算:每声道 RMS / 峰值,加上全部样本字节的 FNV-1a 指纹 */
const RMS_PEAK_FNV = [
  'const out = []; let h = 2166136261 >>> 0;',
  'for (const x of input.channels) {',
  '  let s = 0, pk = 0;',
  '  for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; const a = Math.abs(x[i]); if (a > pk) pk = a; }',
  '  out.push({ rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) });',
  '  const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);',
  '  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }',
  '}',
  'return { channels: out, frames: input.frames, sampleRate: input.sampleRate, fnv: h };',
].join('\n');
function fnvOf(channels) {
  let h = 2166136261 >>> 0;
  for (const x of channels) {
    const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  }
  return h;
}
const RMS = 20 * Math.log10(0.5 / Math.SQRT2); // -9.031
const PEAK = 20 * Math.log10(0.5); // -6.021
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) < tol;
const LOUD_KEYS = ['integrated', 'truePeak', 'lra', 'lraLow', 'lraHigh', 'threshold', 'duration'];
const pick = (o) => Object.fromEntries(LOUD_KEYS.map((k) => [k, o?.[k]]));

/** 探针自己按改前的读法(ffmpeg 直接读本地文件)测响度 */
function loudnessDirect(ffmpeg, file) {
  const r = spawnSync(ffmpeg, measureArgs({ file }), { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return parseEbur128(r.stderr);
}

let browser = null;
try {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('找不到 ffmpeg(把它放进 PATH 或设 PROMPTCUT_FFMPEG)');
  const gen = (name, lavfi) => {
    const file = path.join(SRC_DIR, name);
    const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...lavfi, file], { windowsHide: true });
    if (r.status !== 0) throw new Error(`生成 ${name} 失败:${String(r.stderr).slice(0, 200)}`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    remoteFiles.set(hash, file);
    return { file, hash };
  };
  const wave = '0.5*sin(2*PI*1000*t)';
  const sine = gen('sine.wav', ['-f', 'lavfi', '-i', `aevalsrc=${wave}|${wave}:s=48000:d=3`, '-c:a', 'pcm_s24le']);
  const noise = gen('noise.wav', ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.25:duration=20:sample_rate=48000:seed=3', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=20',
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]', '-map', '[a]', '-c:a', 'pcm_s16le']);
  const ghostHash = 'ee'.repeat(32);
  out.hashes = { sine: sine.hash, noise: noise.hash };

  await new Promise((resolve, reject) => { remote.once('error', reject); remote.listen(REMOTE_PORT, '127.0.0.1', resolve); });
  if (!(await startEditor())) throw new Error('编辑器进程没起来');
  check(fs.readdirSync(MEDIA_DIR).length === 0, '开始时编辑器的素材目录是空的', fs.readdirSync(MEDIA_DIR));

  browser = await puppeteer.launch({ headless: true, args: ['--window-position=-32000,-32000', '--no-first-run'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(EDITOR + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  const placed = await page.evaluate(async ({ sine, noise, ghost, gone }) => {
    const m = await import('/src/store/project.ts');
    m.actions.newProject?.();
    // url 不带扩展名、path 指向不存在的目录:按目录拼文件名找不到,只能经素材服务按哈希找
    const a = m.actions.addMedia({ id: 'm-sine', kind: 'audio', name: 'sine.wav', url: `/@media/${sine}`, hash: sine, path: `${gone}\\sine.wav`, duration: 3 });
    const b = m.actions.addMedia({ id: 'm-noise', kind: 'audio', name: 'noise.wav', url: `/@media/${noise}`, hash: noise, path: `${gone}\\noise.wav`, duration: 20 });
    const c = m.actions.addMedia({ id: 'm-ghost', kind: 'audio', name: 'ghost.wav', url: `/@media/${ghost}`, hash: ghost, path: `${gone}\\ghost.wav`, duration: 3 });
    const clip = m.actions.addMediaClip(a.id, 1, { duration: 2 });
    return { sine: a.id, noise: b.id, ghost: c.id, clipId: clip?.id ?? null, hashes: m.getState().project.media.map((x) => x.hash ?? null) };
  }, { sine: sine.hash, noise: noise.hash, ghost: ghostHash, gone: GONE });
  out.placed = placed;
  check(!!placed.clipId && placed.hashes.includes(sine.hash), '素材记录进了项目(带哈希)、正弦波放上了时间轴', placed);

  /* ---- P1 连上远程素材服务 ---- */
  const base = `http://127.0.0.1:${REMOTE_PORT}/api/asset`;
  const set = await fetch(EDITOR + '/api/media/remote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base }) }).then((r) => r.json()).catch(() => null);
  const status = await fetch(EDITOR + '/api/media/remote').then((r) => r.json()).catch(() => null);
  check(set?.ok && status?.base === base, 'P1 编辑器连上了这台远程素材服务', status);

  /* ---- P2 measure_audio ---- */
  const direct = loudnessDirect(ffmpeg, noise.file);
  out.loudDirect = pick(direct);
  const loud = await until('measure_audio 测噪声素材', async () => {
    const r = await mcpCall('measure_audio', { mediaId: placed.noise });
    return r && typeof r.integrated === 'number' ? r : (r && !/找不到素材|编辑台没有打开/.test(String(r.error || '')) ? r : null);
  }, 90000, 1000);
  out.loud = loud && { ...pick(loud), error: loud.error };
  check(loud && JSON.stringify(pick(loud)) === JSON.stringify(pick(direct)), 'P2 measure_audio 的数值与直接读本地文件(改前的读法)逐项相同', { now: pick(loud), direct: pick(direct) });
  const noiseHits = hitsOf(noise.hash);
  check(noiseHits >= 1, `P2 远程素材服务被请求过噪声素材(${noiseHits} 次 GET):字节经素材服务的接口来`, remoteLog.filter((e) => e.hash === noise.hash).slice(0, 8));

  /* ---- P3 measure_audio_js ---- */
  const conv = `approbe${Date.now().toString(36)}`;
  await register(conv, 'high');
  const pcmDirect = await decodePcm(ffmpeg, filePcmArgs({ file: sine.file, sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  const js = await mcpCall('measure_audio_js', { mediaId: placed.sine, code: RMS_PEAK_FNV }, conv);
  out.js = js;
  check(js?.ok === true && js.value?.channels?.length === 2 && js.value.channels.every((ch) => near(ch.rmsDb, RMS, 0.05) && near(ch.peakDb, PEAK, 0.1)),
    'P3 measure_audio_js:两个声道的 RMS / 峰值与理论值一致', js);
  check(js?.value?.fnv === fnvOf(pcmDirect) && js?.value?.frames === pcmDirect[0].length, 'P3 沙箱拿到的 PCM 与直接解码本地文件的逐字节相同(FNV 指纹、帧数)', { now: js?.value?.fnv, direct: fnvOf(pcmDirect), frames: js?.value?.frames, directFrames: pcmDirect[0].length });
  check(hitsOf(sine.hash) >= 1, `P3 远程素材服务被请求过正弦波素材(${hitsOf(sine.hash)} 次 GET)`);
  const clipJs = await mcpCall('measure_audio_js', { clipId: placed.clipId, mono: true, sampleRate: 48000, code: RMS_PEAK_FNV }, conv);
  check(clipJs?.ok === true && near(clipJs.value?.channels?.[0]?.rmsDb, RMS, 0.05), 'P3 片段档(mono、48 kHz)照常', clipJs && { ok: clipJs.ok, error: clipJs.error, v: clipJs.value?.channels });

  /* ---- P4 回到本机空间:只剩本地内容库,按哈希存 ---- */
  await until('远程拉完、进了本地内容库', async () => {
    const s = await fetch(EDITOR + '/api/media/remote').then((r) => r.json());
    return s.jobs.every((j) => j.done) ? s : null;
  }, 30000, 500);
  await fetch(EDITOR + '/api/media/remote', { method: 'DELETE' });
  const lib = fs.readdirSync(MEDIA_DIR);
  out.localLibrary = lib;
  check(lib.some((f) => f.startsWith(noise.hash + '.')) && !lib.includes(noise.hash) && !lib.includes('noise.wav'),
    'P4 本地内容库里是 <hash>.<ext>:按目录拼 url 的最后一段(<hash>)或文件名都找不到', lib);
  const before = remoteLog.length;
  const loud2 = await mcpCall('measure_audio', { mediaId: placed.noise });
  check(loud2 && JSON.stringify(pick(loud2)) === JSON.stringify(pick(direct)), 'P4 本机空间:measure_audio 照常、数值不变', loud2 && { ...pick(loud2), error: loud2.error });
  const js2 = await mcpCall('measure_audio_js', { mediaId: placed.sine, code: RMS_PEAK_FNV }, conv);
  check(js2?.ok === true && js2.value?.fnv === fnvOf(pcmDirect), 'P4 本机空间:measure_audio_js 照常、PCM 不变', js2 && { ok: js2.ok, error: js2.error, fnv: js2.value?.fnv });
  check(remoteLog.length === before, 'P4 远程素材服务一次也没被打到', remoteLog.slice(before, before + 5));

  /* ---- P5 哪儿都没有的素材 ---- */
  const g1 = await mcpCall('measure_audio', { mediaId: placed.ghost });
  check(g1 && typeof g1.integrated !== 'number' && /素材文件不存在/.test(String(g1.error || '')), 'P5 measure_audio 对哪儿都没有的素材回「素材文件不存在」', g1);
  const g2 = await mcpCall('measure_audio_js', { mediaId: placed.ghost, code: 'return 1' }, conv);
  check(g2?.ok === false && g2.kind === 'no-media', 'P5 measure_audio_js 回 kind no-media', g2);
  const alive = await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false);
  check(alive, '编辑器照常应答');
  check(pageErrors.length === 0, '页面没有未捕获的异常', pageErrors.slice(0, 5));
  out.remoteRequests = remoteLog.length;
} catch (error) {
  fails.push('exception: ' + (error?.stack || error));
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolve) => { remote.closeAllConnections?.(); remote.close(() => resolve()); });
  if (!KEEP) {
    stopEditor();
    await delay(500);
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } else {
    out.kept = EXPORT_DIR;
  }
}
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
for (const p of passes) console.log('PASS', p);
for (const f of fails) console.log('FAIL', f);
if (fails.length) console.log(editorLog.join('').slice(-3000));
console.log(fails.length ? `探针未过:${fails.length} 项失败,${passes.length} 项通过` : `探针通过:${passes.length} 项`);
process.exit(fails.length ? 1 : 0);
