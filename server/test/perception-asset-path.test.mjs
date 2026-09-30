/**
 * Agent 读写素材的路径,第二段(`docs/plan/TODO.md`「语义与代码的差距」;语义 `docs/semantics/product/agent.md`「素材与产物」、
 * `product/asset-service.md`「职责」):
 *   - 三个感知工具 `detect_shots`(/api/shots/detect)、`track_points`(/api/track/track)、`detect_subjects`(/api/subject/detect)
 *     只收素材标识,经素材服务的 HTTP 接口取字节(server/perception-source.mjs),请求体里的 path 不再读盘;
 *   - 配音 `voice_generate`(/api/voice/generate)的结果先落临时目录,再经素材服务的入库接口进内容库(server/media-ingest.mjs)。
 *     素材收集 `collect_download` 的同类用例在 collect-plugin.test.mjs(MI-5、MI-6)。
 *
 * 用例(PK = perception,感知工具读素材;MI = media ingest,生成的素材入库):
 *   PK-1  请求体 → 素材标识:只取 id / name / kind / url / hash,path 一概不取;没有标识 400、素材服务上没有 404、不可达 502;
 *   PK-2  Python 包认不认地址:ACCEPTS_URL 标记;问不出来按不认;问的那行代码不带 cmd 元字符;
 *   PK-3  流到临时文件:字节相同、cleanup 连目录删;404 / 连不上抛 AssetSourceError 且不留临时目录;
 *   ── 以下起真的素材服务(fs 内容库 + 媒体中间件,前面挂一个计数的转发)与真的 ffmpeg,插件经 typescript 转译后直接挂到 http 上 ──
 *   PK-4  镜头识别(scdet 档,不要 Python):素材目录不可读、素材服务可达时照常出结果,转场时刻、时长、帧率与直接读文件的 scdet 相同,
 *         缩略图与直接读文件抽的逐字节相同;字节确实经素材服务来(Range 请求);
 *   PK-5  三条接口:请求体带任意 path(指着真实存在的文件)不会被读;没有标识 400、素材服务上没有 404、素材服务不可达 502,分得清;
 *   PK-6  运动追踪(模板匹配档,要一个带 numpy 的 Python):经素材服务的地址追出来的点与直接读文件的逐项相同;
 *   PK-7  老的 Python 包(没有 ACCEPTS_URL):先把字节流到临时文件再递路径,结果照样相同,临时目录用完删掉;
 *   PK-8  主体检测:地址过得了 Python 的入口检查(不再报「找不到视频文件」);抽帧那一步经地址与读文件解出的像素逐字节相同;
 *   MI-1  入库:字节进内容库、哈希是内容的 sha256、同样内容第二次去重;
 *   MI-2  入库失败分得清:取不到地址 / 连不上 / 拒绝(HTTP 500) → AssetSourceError;要入库的文件不见了 → 普通错误;
 *   MI-3  配音:合成结果经入库接口进内容库,回 /@media/<hash> 与入库回包,不回临时路径;素材目录里没有绕过入库的文件;临时目录删掉;
 *   MI-4  配音时素材服务不可达:回 502 与 kind asset-service,素材目录与临时目录都不留东西。
 *
 * 跑:node --test server/test/perception-asset-path.test.mjs
 *   要 ffmpeg(找不到时 PK-4 起跳过);PK-6～PK-8 另要一个带 numpy 的 Python(PATH 上的 python,或 PROMPTCUT_TEST_PYTHON 指定),找不到时跳过。
 *   这台机器上没有 TransNetV2 / BootsTAPIR / YuNet 等模型,真的模型推理不在本文件里跑。
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { AssetSourceError, createAssetSourceResolver } from '../audio-source.mjs';
import { acceptsUrlCode, downloadToTemp, mediaRefOf, pythonAcceptsUrl, pythonInput, resolveMediaSource } from '../perception-source.mjs';
import { ingestFile } from '../media-ingest.mjs';
import { findFfmpeg } from '../ai-visual.mjs';

const harness = createAssetHarness();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-perception-test-'));
const SAVED_ENV = { ...process.env };
// 插件读的几个目录都指到临时目录:Python 的 pylibs / models、镜头缩略图(dataDir)、配音设置
process.env.PROMPTCUT_PYLIBS = path.join(TMP, 'pylibs');
process.env.PROMPTCUT_MODELS = path.join(TMP, 'models');
process.env.PROMPTCUT_DATA_DIR = path.join(TMP, 'data');
process.env.PROMPTCUT_AI_CONFIG = path.join(TMP, 'config', 'ai.json');
delete process.env.PROMPTCUT_PYTHON;
after(async () => {
  await harness.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 一个刚关掉的端口:连上去必然 ECONNREFUSED */
async function closedOrigin() {
  const s = await listen(() => {});
  await closeServer(s.server);
  return s.origin;
}

/* ------------------------------------------------------------------ PK-1 ～ PK-3:不要 ffmpeg */

test('PK-1 请求体 → 素材标识:path 一概不取;没有标识 400、没有这份素材 404、素材服务不可达 502', async () => {
  const h = 'ab'.repeat(32);
  assert.deepEqual(mediaRefOf({ mediaId: 'm1', media: { id: 'm1', name: 'a.mp4', kind: 'video', url: `/@media/${h}`, hash: h, path: 'C:\\Windows\\win.ini' } }),
    { id: 'm1', name: 'a.mp4', kind: 'video', url: `/@media/${h}`, hash: h });
  assert.equal(mediaRefOf({ path: 'C:\\Windows\\win.ini', mediaId: 'm1' }), null, '只有 path 的老请求体不算素材标识');
  assert.equal(mediaRefOf({ media: { id: 'm1', path: 'C:\\Windows\\win.ini' } }), null, 'media 里只有 path 也不算');
  assert.equal(mediaRefOf({ media: { hash: h } , mediaId: 'm2' }).id, 'm2', 'id 缺省取 mediaId');

  const seen = [];
  const svc = await listen((req, res) => {
    seen.push(req.url);
    if (req.url.endsWith('/missing')) { res.statusCode = 404; return res.end(); }
    res.writeHead(206, { 'Content-Range': 'bytes 0-0/10', 'Content-Length': 1 }); res.end('x');
  });
  const resolver = createAssetSourceResolver({ origin: () => svc.origin, toUrl: (m, o) => (m.hash ? `${o}/@media/${m.hash}` : null) });
  const noRef = await resolveMediaSource({ path: path.join(ROOT, 'package.json') }, resolver);
  assert.equal(noRef.status, 400);
  assert.match(noRef.error, /不再接受/);
  const miss = await resolveMediaSource({ media: { name: '丢了.mp4', hash: 'missing' } }, resolver);
  assert.equal(miss.status, 404);
  assert.match(miss.error, /素材服务上没有这份素材:丢了\.mp4/);
  const ok = await resolveMediaSource({ media: { hash: 'fine' }, path: 'D:\\secret.mp4' }, resolver);
  assert.deepEqual([ok.ok, ok.src], [true, `${svc.origin}/@media/fine`]);
  assert.deepEqual(seen, ['/@media/missing', '/@media/fine'], '没有标识的那次一个请求都没发');
  await closeServer(svc.server);

  const gone = await closedOrigin();
  const down = await resolveMediaSource({ media: { hash: 'x' } }, createAssetSourceResolver({ origin: () => gone, toUrl: (m, o) => `${o}/@media/${m.hash}` }));
  assert.equal(down.status, 502);
  assert.equal(down.kind, 'asset-service');
  assert.ok(down.error.includes(`素材服务不可达(${gone})`), down.error);
});

/** 带 numpy 的 Python:PROMPTCUT_TEST_PYTHON,或 PATH 上的 python / python3(要真实存在的可执行文件,findPython 只认存在的路径) */
function findTestPython() {
  const cands = [SAVED_ENV.PROMPTCUT_TEST_PYTHON, 'python', 'python3'].filter(Boolean);
  for (const cmd of cands) {
    try {
      const r = spawnSync(cmd, ['-c', 'import sys, numpy; sys.stdout.write(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      const exe = String(r.stdout || '').trim();
      if (r.status === 0 && exe && fs.existsSync(exe)) return exe;
    } catch { /* 下一个 */ }
  }
  return null;
}
const PY = findTestPython();
const skipPy = PY ? false : '没有带 numpy 的 Python';
/** 让 Python 找得到仓库里的包(和 vite-plugin-stt 的 buildEnv 对普通解释器的做法相同) */
const pyEnv = (pylibs = process.env.PROMPTCUT_PYLIBS) => ({ ...process.env, PYTHONPATH: pylibs + path.delimiter + path.join(ROOT, 'python'), PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PROMPTCUT_PYLIBS: pylibs });
const spawnPy = (python, args, env) => spawn(python, args, { env, windowsHide: true });

test('PK-2 Python 包认不认地址:三个包都带 ACCEPTS_URL;问不出来按不认;问的那行代码不带 cmd 元字符', { skip: skipPy }, async () => {
  for (const pkg of ['promptcut_shots', 'promptcut_track', 'promptcut_subject']) {
    assert.ok(!/[&|<>^"%]/.test(acceptsUrlCode(pkg)), '.cmd 解释器会拒绝带元字符的参数');
    assert.equal(await pythonAcceptsUrl({ python: PY, env: pyEnv(), pkg, spawnPython: spawnPy }), true, pkg);
  }
  assert.equal(await pythonAcceptsUrl({ python: PY, env: pyEnv(), pkg: 'promptcut_no_such_pkg', spawnPython: spawnPy }), false, 'import 失败按不认');
  assert.equal(await pythonAcceptsUrl({ python: path.join(TMP, 'no-python.exe'), env: pyEnv(), pkg: 'promptcut_track', spawnPython: spawnPy }), false, '解释器起不来按不认');
  assert.equal(await pythonAcceptsUrl({ python: PY, env: pyEnv(), pkg: 'promptcut_track', spawnPython: () => { throw new Error('refuse'); } }), false, 'spawn 抛错按不认');
});

test('PK-3 流到临时文件:字节相同、cleanup 连目录删;404 与连不上抛 AssetSourceError,不留临时目录', async () => {
  const body = crypto.randomBytes(300_000);
  const svc = await listen((req, res) => {
    if (req.url === '/missing') { res.statusCode = 404; return res.end('no'); }
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  const root = fs.mkdtempSync(path.join(TMP, 'dl-'));
  const t = await downloadToTemp(`${svc.origin}/ok`, { name: '镜头.MP4' }, { tmpRoot: root });
  assert.equal(path.extname(t.file), '.mp4', '扩展名照素材名');
  assert.deepEqual(fs.readFileSync(t.file), body);
  t.cleanup();
  assert.deepEqual(fs.readdirSync(root), []);
  await assert.rejects(downloadToTemp(`${svc.origin}/missing`, {}, { tmpRoot: root }), (e) => e instanceof AssetSourceError && /HTTP 404/.test(e.message));
  assert.deepEqual(fs.readdirSync(root), [], '失败也不留临时目录');
  await closeServer(svc.server);
  const gone = await closedOrigin();
  await assert.rejects(downloadToTemp(`${gone}/x`, {}, { tmpRoot: root }), (e) => e instanceof AssetSourceError && /取字节失败/.test(e.message));
  assert.deepEqual(fs.readdirSync(root), []);
  // 地址以外的输入原样递(解析器只拼 http 地址,这条只是兜底)
  const passthrough = await pythonInput({ src: 'C:\\x.mp4', ref: {}, python: 'none', env: {}, pkg: 'x', spawnPython: () => { throw new Error('不该问'); } });
  assert.equal(passthrough.input, 'C:\\x.mp4');
});

/* ------------------------------------------------------------------ 真的素材服务 + ffmpeg */

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), 'ffprobe' + path.extname(FFMPEG)) : null;
const skip = FFMPEG ? false : '没找到 ffmpeg';
// 镜头识别插件按名字 spawn ffprobe / ffmpeg(PATH 上找),把找到的那份放到 PATH 最前面
if (FFMPEG && path.isAbsolute(FFMPEG)) process.env.PATH = path.dirname(FFMPEG) + path.delimiter + process.env.PATH;

const gen = (out, args) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args, out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};

/** 素材服务(fs 内容库 + 媒体中间件),前面挂一个计数的转发;素材经 /api/media/upload 入库(和用户导入同一条路) */
async function startService() {
  const svc = await harness.serve({ stores: 'default' });
  const requests = [];
  const front = await listen((req, res) => {
    const up = http.request(new URL(req.url, svc.origin), { method: req.method, headers: req.headers }, (r) => {
      requests.push({ method: req.method, url: req.url, range: req.headers.range || null, status: r.statusCode });
      res.writeHead(r.statusCode, r.headers);
      res.on('close', () => r.destroy());
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end(); } });
    req.pipe(up);
  });
  const upload = async (file) => {
    const r = await fetch(`${svc.origin}/api/media/upload/${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: fs.readFileSync(file) });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.hash, sha256(fs.readFileSync(file)));
    return data.hash;
  };
  return {
    origin: front.origin, requests, upload, contentRoot: svc.root,
    mediaGets: (hash) => requests.filter((q) => q.method === 'GET' && q.url.startsWith(`/@media/${hash}`)),
    reset() { requests.length = 0; },
    async stop() { await closeServer(front.server); await svc.close(); },
  };
}

/** 把插件转译后挂到一个 http server 上;落到 next() 回 404 */
async function mountPlugin(file, exportName, root) {
  const mod = await import(harness.compileTs(path.join(ROOT, 'server', file)));
  let fn;
  mod[exportName]().configureServer({ config: { root }, middlewares: { use(f) { fn = f; } } });
  assert.ok(fn, `${file} 没有注册中间件`);
  const s = await listen((req, res) => { void fn(req, res, () => { res.statusCode = 404; res.end('next'); }); });
  return s;
}
const post = async (origin, url, body) => {
  const r = await fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function waitJob(origin, prefix, jobId, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${origin}${prefix}/job/${jobId}`);
    const data = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    if (data.job.status !== 'running') return data.job;
    assert.ok(Date.now() - t0 < timeoutMs, '作业迟迟不结束');
    await sleep(150);
  }
}

let service;
let shotsSrv;
let trackSrv;
let subjectSrv;
const files = {};
const hashes = {};
/** 空的项目根:没有 desktop 运行时、没有 python/.venv,findPython 在没设 PROMPTCUT_PYTHON 时找不到解释器 */
const BARE_ROOT = path.join(TMP, 'bare-root');
/** 素材记录里的 path 指向一个不存在的目录:素材目录不可读,只有标识可用 */
const GONE = path.join(TMP, '不存在的素材目录');
const refOf = (k) => ({ id: `m-${k}`, name: path.basename(files[k]), kind: 'video', url: `/@media/${hashes[k]}${path.extname(files[k])}`, hash: hashes[k] });

if (FFMPEG) {
  fs.mkdirSync(BARE_ROOT, { recursive: true });
  // 三段纯色硬切(1 秒、1 秒、1 秒):scdet 在 1 秒、2 秒处各报一次
  files.cuts = gen(path.join(TMP, 'cuts.mp4'), [
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=25:d=1',
    '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=25:d=1',
    '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  ]);
  // 黑底上一块向右匀速移动的白方块(160x120、10 fps、2 秒):模板匹配追它的中心
  files.move = gen(path.join(TMP, 'move.mp4'), [
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=white:s=16x16:r=10:d=2',
    '-filter_complex', "[0][1]overlay=x='20+t*30':y=50", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5',
  ]);
}

before(async () => {
  if (!FFMPEG) return;
  service = await startService();
  for (const [k, f] of Object.entries(files)) hashes[k] = await service.upload(f);
  process.env.PROMPTCUT_EDITOR_URL = service.origin;
  shotsSrv = await mountPlugin('vite-plugin-shots.ts', 'shotsPlugin', BARE_ROOT);
  // 追踪、主体检测要找得到仓库里的 python/ 包(buildEnv 按 <root>/python 补 PYTHONPATH),根用仓库目录;数据目录都指到了临时目录
  trackSrv = await mountPlugin('vite-plugin-track.ts', 'trackPlugin', ROOT);
  subjectSrv = await mountPlugin('vite-plugin-subject.ts', 'subjectPlugin', ROOT);
});
after(async () => {
  for (const s of [shotsSrv, trackSrv, subjectSrv, voiceSrv]) if (s) await closeServer(s.server);
  await service?.stop();
});

/** 改前的读法:直接交本地文件给 scdet(原来 detectWithScdet 的参数) */
function scdetTimes(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-vf', 'scdet=threshold=10', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  return [...String(r.stderr).matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
}

test('PK-4 镜头识别(scdet 档):素材目录不可读、素材服务可达时照常出结果,与直接读文件的结果与缩略图相同', { skip }, async () => {
  service.reset();
  const r = await post(shotsSrv.origin, '/api/shots/detect', { mediaId: 'm-cuts', media: refOf('cuts'), path: path.join(GONE, 'cuts.mp4') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const job = await waitJob(shotsSrv.origin, '/api/shots', r.json.jobId);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.engine, 'scdet', '空项目根没有 Python,走 scdet 兜底');
  assert.equal(job.mediaId, 'm-cuts');

  const expected = scdetTimes(files.cuts);
  assert.equal(expected.length, 2, '造的素材应该有两次硬切:' + JSON.stringify(expected));
  assert.deepEqual(job.transitions.map((t) => t.time), expected, '转场时刻与直接读文件的 scdet 相同');
  assert.deepEqual(job.shots.map((s) => [s.start, s.end]), [[0, expected[0]], [expected[0], expected[1]], [expected[1], job.duration]]);
  // 时长、帧率:与直接对文件跑同一组 ffprobe 参数相同
  const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate:format=duration', '-of', 'json', files.cuts], { encoding: 'utf8', windowsHide: true }).stdout);
  assert.equal(job.duration, Number(probe.format.duration));
  assert.equal(job.fps, 25);

  // 缩略图:与直接对文件抽(原来 grabThumbs 的参数)逐字节相同
  const thumbDir = path.join(process.env.PROMPTCUT_DATA_DIR, 'shots');
  for (const t of job.transitions) {
    assert.equal(t.thumbs?.length, 1);
    const direct = path.join(TMP, `direct-${t.thumbs[0]}`);
    const g = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t.end + 0.04)), '-i', files.cuts, '-frames:v', '1', '-vf', 'scale=160:-2', '-y', direct], { windowsHide: true });
    assert.equal(g.status, 0);
    assert.deepEqual(fs.readFileSync(path.join(thumbDir, t.thumbs[0])), fs.readFileSync(direct), `缩略图 ${t.thumbs[0]}`);
    // 缩略图经插件自己的路由照常取得到
    const img = await fetch(`${shotsSrv.origin}/api/shots/thumb/${t.thumbs[0]}`);
    assert.equal(img.status, 200);
  }
  // 字节确实经素材服务的接口来:探测 1 字节 + ffprobe / ffmpeg 的若干次 GET
  const gets = service.mediaGets(hashes.cuts);
  assert.ok(gets.length >= 4, '素材服务上应看到探测、ffprobe、scdet、缩略图的请求:' + JSON.stringify(gets));
  assert.equal(gets[0].range, 'bytes=0-0', '第一下是探测');
});

test('PK-5 三条接口:任意 path 不会被读;没有标识 400、没有这份素材 404、素材服务不可达 502', { skip }, async () => {
  const realFile = files.cuts; // 真实存在的视频:改前递 path 就会被读
  const endpoints = [
    [shotsSrv, '/api/shots/detect', {}],
    [trackSrv, '/api/track/track', { points: [[0, 28, 58]] }],
    [subjectSrv, '/api/subject/detect', { times: [0.5] }],
  ];
  for (const [srv, url, extra] of endpoints) {
    service.reset();
    const onlyPath = await post(srv.origin, url, { mediaId: 'm-x', path: realFile, ...extra });
    assert.equal(onlyPath.status, 400, `${url} 只给 path:` + JSON.stringify(onlyPath.json));
    assert.equal(onlyPath.json.jobId, undefined, '不起作业');
    const refPath = await post(srv.origin, url, { mediaId: 'm-x', media: { id: 'm-x', name: 'x.mp4', path: realFile }, ...extra });
    assert.equal(refPath.status, 400, `${url} media 里只有 path`);
    assert.equal(service.requests.length, 0, `${url}:没有标识时一个请求都不发`);

    const missing = await post(srv.origin, url, { mediaId: 'm-x', media: { id: 'm-x', name: '丢了.mp4', hash: 'fe'.repeat(32) }, path: realFile, ...extra });
    assert.equal(missing.status, 404, `${url} 素材服务上没有:` + JSON.stringify(missing.json));
    assert.match(missing.json.error, /素材服务上没有这份素材:丢了\.mp4/);
    assert.equal(missing.json.jobId, undefined, 'path 指着真实文件也不拿它顶替');
  }
  // 素材服务不可达
  const gone = await closedOrigin();
  process.env.PROMPTCUT_EDITOR_URL = gone;
  try {
    for (const [srv, url, extra] of endpoints) {
      const down = await post(srv.origin, url, { mediaId: 'm-cuts', media: refOf('cuts'), path: realFile, ...extra });
      assert.equal(down.status, 502, `${url} 不可达:` + JSON.stringify(down.json));
      assert.equal(down.json.kind, 'asset-service');
      assert.ok(down.json.error.includes(`素材服务不可达(${gone})`), down.json.error);
    }
  } finally {
    process.env.PROMPTCUT_EDITOR_URL = service.origin;
  }
});

/** 改前的读法:直接对本地文件跑 promptcut_track(模板匹配档),取 result 事件 */
function trackDirect(file, points, pylibs) {
  const r = spawnSync(PY, ['-m', 'promptcut_track', 'track', '--video', file, '--points', JSON.stringify(points)], { env: pyEnv(pylibs), encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const line = String(r.stdout).split(/\r?\n/).find((l) => l.includes('"event": "result"') || l.includes('"event":"result"'));
  assert.ok(line, '直接跑追踪没有 result:' + r.stdout + r.stderr);
  const ev = JSON.parse(line);
  return { engine: ev.engine, width: ev.width, height: ev.height, frames: ev.frames, points: ev.points };
}

const POINTS = [[0, 28, 58]];
const skipTrack = skip || skipPy;

test('PK-6 运动追踪(模板匹配档):经素材服务的地址追出来的与直接读文件的逐项相同', { skip: skipTrack }, async () => {
  process.env.PROMPTCUT_PYTHON = PY;
  try {
    service.reset();
    const r = await post(trackSrv.origin, '/api/track/track', { mediaId: 'm-move', media: refOf('move'), path: path.join(GONE, 'move.mp4'), points: POINTS });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = await waitJob(trackSrv.origin, '/api/track', r.json.jobId);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.engine, 'template', '这台机器没有 BootsTAPIR,走模板匹配');
    const direct = trackDirect(files.move, POINTS);
    assert.deepEqual({ engine: job.engine, width: job.width, height: job.height, frames: job.frames, points: job.points }, direct);
    assert.equal(job.frames, 20);
    const dx = job.points[0].xy.at(-1)[0] - job.points[0].xy[0][0];
    assert.ok(dx > 40 && dx < 70, `方块应右移约 57 像素,追到 ${dx}`);
    const gets = service.mediaGets(hashes.move);
    assert.ok(gets.length >= 2, '字节经素材服务来:' + JSON.stringify(gets));
    assert.ok(gets.slice(1).some((g) => g.range !== 'bytes=0-0'), '除了探测还有 ffmpeg 自己的读取');
  } finally {
    delete process.env.PROMPTCUT_PYTHON;
  }
});

/** 造一份「老包」:照仓库里的 promptcut_track 拷一份,去掉 ACCEPTS_URL 与地址放行,放进 pylibs(PYTHONPATH 里排在仓库之前) */
function makeOldTrackPackage(pylibs) {
  const src = path.join(ROOT, 'python', 'promptcut_track');
  const dst = path.join(pylibs, 'promptcut_track');
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.includes('__pycache__') });
  const init = path.join(dst, '__init__.py');
  const initSrc = fs.readFileSync(init, 'utf8');
  assert.ok(initSrc.includes('ACCEPTS_URL = True'));
  fs.writeFileSync(init, initSrc.replace('ACCEPTS_URL = True', ''));
  const main = path.join(dst, '__main__.py');
  let mainSrc = fs.readFileSync(main, 'utf8');
  for (const [a, b] of [
    ['from . import __version__, is_media_url', 'from . import __version__'],
    ['if not (is_media_url(args.video) or os.path.isfile(args.video)):', 'if not os.path.isfile(args.video):'],
  ]) {
    assert.ok(mainSrc.includes(a), a);
    mainSrc = mainSrc.replace(a, b);
  }
  fs.writeFileSync(main, mainSrc);
}

test('PK-7 老的 Python 包(没有 ACCEPTS_URL):先流到临时文件再递路径,结果相同,临时目录用完删掉', { skip: skipTrack }, async () => {
  const oldLibs = path.join(TMP, 'pylibs-old');
  makeOldTrackPackage(oldLibs);
  // 老包见到地址确实会拒绝(这正是要兜底的情形)
  const refused = spawnSync(PY, ['-m', 'promptcut_track', 'track', '--video', `${service.origin}/@media/${hashes.move}`, '--points', JSON.stringify(POINTS)], { env: pyEnv(oldLibs), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.match(refused.stdout, /找不到视频文件/, '老包应拒绝地址');
  assert.equal(await pythonAcceptsUrl({ python: PY, env: pyEnv(oldLibs), pkg: 'promptcut_track', spawnPython: spawnPy }), false);

  const privateTmp = path.join(TMP, 'os-tmp');
  fs.mkdirSync(privateTmp, { recursive: true });
  const saved = { PYLIBS: process.env.PROMPTCUT_PYLIBS, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { PROMPTCUT_PYTHON: PY, PROMPTCUT_PYLIBS: oldLibs, TEMP: privateTmp, TMP: privateTmp, TMPDIR: privateTmp });
  try {
    service.reset();
    const r = await post(trackSrv.origin, '/api/track/track', { mediaId: 'm-move', media: refOf('move'), points: POINTS });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = await waitJob(trackSrv.origin, '/api/track', r.json.jobId);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.deepEqual({ engine: job.engine, width: job.width, height: job.height, frames: job.frames, points: job.points }, trackDirect(files.move, POINTS));
    const gets = service.mediaGets(hashes.move);
    assert.ok(gets.some((g) => g.range === null && g.status === 200), '整份取了一次(流到临时文件):' + JSON.stringify(gets));
    assert.deepEqual(fs.readdirSync(privateTmp).filter((n) => n.startsWith('pc-perception-')), [], '临时目录用完删掉');
  } finally {
    for (const [k, v] of Object.entries({ PROMPTCUT_PYLIBS: saved.PYLIBS, TEMP: saved.TEMP, TMP: saved.TMP, TMPDIR: saved.TMPDIR })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete process.env.PROMPTCUT_PYTHON;
  }
});

test('PK-8 主体检测:地址过得了 Python 的入口检查;抽帧那一步经地址与读文件解出的像素逐字节相同', { skip: skipTrack }, async () => {
  process.env.PROMPTCUT_PYTHON = PY;
  try {
    service.reset();
    const r = await post(subjectSrv.origin, '/api/subject/detect', { mediaId: 'm-move', media: refOf('move'), path: path.join(GONE, 'move.mp4'), times: [0.5, 1.2] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const job = await waitJob(subjectSrv.origin, '/api/subject', r.json.jobId, 180_000);
    assert.doesNotMatch(String(job.message || ''), /找不到视频文件/, '地址要过得了入口检查');
    if (job.status === 'done') {
      // 装了模型的机器上真的跑完了:样本形状照常
      assert.equal(job.samples.length, 2);
      assert.deepEqual([job.width, job.height], [160, 120]);
    } else {
      // 没装主体检测拓展(这台机器的情形):停在「未就绪」,不是读素材失败
      assert.match(job.message, /未就绪/, JSON.stringify(job));
    }
  } finally {
    delete process.env.PROMPTCUT_PYTHON;
  }
  // 取字节那一步:frames.probe_size + grab_frame 经素材服务地址与直接读文件,宽高与 BGR 像素逐字节相同
  const script = path.join(TMP, 'frames_check.py');
  fs.writeFileSync(script, [
    'import sys, json, hashlib',
    'from promptcut_subject import frames as F',
    'ff = sys.argv[1]',
    'out = []',
    'for v in sys.argv[2:]:',
    '    w, h = F.probe_size(ff, v)',
    '    fw, fh = F.target_size(w, h, 640)',
    '    rows = []',
    '    for t in (0.0, 0.5, 1.2):',
    '        fr = F.grab_frame(ff, v, t, fw, fh)',
    '        rows.append([list(fr.shape), hashlib.sha256(fr.tobytes()).hexdigest()])',
    '    out.append({"size": [w, h], "frames": rows})',
    'print(json.dumps(out))',
  ].join('\n'));
  service.reset();
  const url = `${service.origin}/@media/${hashes.move}`;
  // 必须异步跑:素材服务就在本测试进程里,spawnSync 会卡住事件循环,ffprobe 发来的请求没人答
  const c = await runAsync(PY, [script, FFMPEG, url, files.move], pyEnv());
  assert.equal(c.status, 0, c.stderr);
  const [viaUrl, viaFile] = JSON.parse(c.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(viaUrl, viaFile);
  assert.deepEqual(viaUrl.size, [160, 120]);
  assert.ok(service.mediaGets(hashes.move).length >= 4, '抽帧经素材服务取字节');
});

function runAsync(cmd, args, env, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/* ------------------------------------------------------------------ MI:生成的素材经入库接口进内容库 */

test('MI-1 入库:字节进内容库、哈希是内容的 sha256、同样内容第二次去重', { skip }, async () => {
  const file = path.join(TMP, '配音 01.mp3');
  const bytes = crypto.randomBytes(50_000);
  fs.writeFileSync(file, bytes);
  const a = await ingestFile({ file, origin: () => service.origin, tiers: false });
  assert.equal(a.hash, sha256(bytes));
  assert.equal(a.url, `/@media/${a.hash}`);
  assert.equal(a.bytes, bytes.length);
  assert.equal(a.ext, 'mp3');
  const got = await fetch(`${service.origin}/@media/${a.hash}`);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
  const b = await ingestFile({ file, name: 'again.mp3', origin: () => service.origin });
  assert.equal(b.hash, a.hash);
  assert.equal(b.deduped, true);
  assert.ok(service.requests.some((q) => q.method === 'POST' && q.url.startsWith('/api/media/upload/')), '走的是入库接口');
});

test('MI-2 入库失败分得清:取不到地址 / 连不上 / 拒绝 → AssetSourceError;文件不见了 → 普通错误', async () => {
  const file = path.join(TMP, 'mi2.wav');
  fs.writeFileSync(file, 'RIFF');
  await assert.rejects(ingestFile({ file, origin: () => null }), (e) => e instanceof AssetSourceError && /取不到素材服务的地址/.test(e.message));
  const gone = await closedOrigin();
  await assert.rejects(ingestFile({ file, origin: () => gone }), (e) => e instanceof AssetSourceError && e.message.includes(`素材服务不可达(${gone})`));
  const bad = await listen((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 500; res.end('disk full'); }); });
  await assert.rejects(ingestFile({ file, origin: () => bad.origin }), (e) => e instanceof AssetSourceError && /拒绝了入库.*HTTP 500.*disk full/.test(e.message));
  await closeServer(bad.server);
  await assert.rejects(ingestFile({ file: path.join(TMP, 'nope.wav'), origin: () => 'http://127.0.0.1:9' }), (e) => !(e instanceof AssetSourceError) && /要入库的文件不见了/.test(e.message));
});

/** 配音插件:服务商的请求全部截下来回一段假的 mp3(hex 494433 = "ID3"),发往本机的照常 */
async function withFakeProvider(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    if (/^http:\/\/127\.0\.0\.1[:/]/.test(u)) return real(input, init);
    calls.push(u);
    return new Response(JSON.stringify({ data: { audio: '494433' }, base_resp: { status_code: 0 } }), { status: 200 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

let voiceSrv;
const VOICE_ROOT = path.join(TMP, 'voice-root');

async function voiceServer() {
  if (voiceSrv) return voiceSrv;
  const { writeVoiceConfig } = await import('../voice/voice-config.mjs');
  writeVoiceConfig({ apiKey: 'sk-test', baseUrl: 'https://voice-gateway.test' });
  fs.mkdirSync(VOICE_ROOT, { recursive: true });
  voiceSrv = await mountPlugin('vite-plugin-voice.ts', 'voicePlugin', VOICE_ROOT);
  return voiceSrv;
}
/** 编辑器自己的素材目录(改前配音直接写进这里) */
const voiceMediaDir = () => path.join(VOICE_ROOT, 'out', 'media');
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

async function withPrivateTmp(fn) {
  const dir = fs.mkdtempSync(path.join(TMP, 'os-tmp-'));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: dir, TMP: dir, TMPDIR: dir });
  try { return await fn(dir); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
/** 临时目录是异步删的(fs.rm 回调),等它空 */
async function waitEmpty(dir, prefix) {
  for (let i = 0; i < 50; i++) {
    if (!fs.readdirSync(dir).some((n) => n.startsWith(prefix))) return;
    await sleep(40);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(prefix)), [], '临时目录没删');
}

test('MI-3 配音:合成结果经入库接口进内容库,回 /@media/<hash> 与入库回包;素材目录里没有绕过入库的文件', { skip }, async () => {
  const srv = await voiceServer();
  await withPrivateTmp(async (tmp) => {
    await withFakeProvider(async (calls) => {
      service.reset();
      const r = await post(srv.origin, '/api/voice/generate', { text: '开场旁白：你好' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(calls.length, 1, '服务商只请求一次');
      const hash = sha256(Buffer.from('ID3', 'latin1'));
      assert.equal(r.json.hash, hash);
      assert.equal(r.json.url, `/@media/${hash}`);
      assert.equal(r.json.media.hash, hash, '入库回包原样带给页面(页面按它登记,和导入素材同一个写法)');
      assert.equal(r.json.path, undefined, '不回临时路径');
      assert.match(r.json.name, /^voice-\d{8}-\d{6}-开场旁白你好-[0-9a-f]{4}\.mp3$/);
      assert.ok(service.requests.some((q) => q.method === 'POST' && q.url.startsWith('/api/media/upload/')), '走的是入库接口');
      const got = await fetch(`${service.origin}/@media/${hash}`);
      assert.equal(Buffer.from(await got.arrayBuffer()).toString('latin1'), 'ID3');
    });
    assert.deepEqual(listDir(voiceMediaDir()), [], '素材目录里不该出现绕过入库的配音文件');
    await waitEmpty(tmp, 'pc-voice-');
  });
});

test('MI-4 配音时素材服务不可达:回 502 与 kind asset-service,素材目录与临时目录都不留东西', { skip }, async () => {
  const srv = await voiceServer();
  const gone = await closedOrigin();
  process.env.PROMPTCUT_EDITOR_URL = gone;
  try {
    await withPrivateTmp(async (tmp) => {
      await withFakeProvider(async () => {
        const r = await post(srv.origin, '/api/voice/generate', { text: '你好' });
        assert.equal(r.status, 502, JSON.stringify(r.json));
        assert.equal(r.json.kind, 'asset-service');
        assert.ok(r.json.error.includes(`素材服务不可达(${gone})`), r.json.error);
      });
      await waitEmpty(tmp, 'pc-voice-');
    });
    assert.deepEqual(listDir(voiceMediaDir()), []);
  } finally {
    process.env.PROMPTCUT_EDITOR_URL = service.origin;
  }
});
