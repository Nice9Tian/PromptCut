/**
 * 共享项目里新导入的图片、音频经素材服务到达其它成员的端到端探针(`docs/reports/AGENT-maint-4.md` 第 2 项;
 * 语义 `docs/semantics/product/asset-service.md`「职责」「上传」:共享项目的素材都经素材服务入库、上传,成员凭票据取)。
 * 缺陷:`server/media-tiers.mjs` 的 `prepareImport` 原先只把视频交给上传队列,放云端之后新导入的图片、音频只在导入方本机。
 *
 *   node scripts/probes/shared-import-upload-probe.mjs [--doc-port 6120] [--asset-port 6121] [--port-a 6110] [--port-b 6115]
 *        [--out <临时目录>] [--keep]
 *
 * 全程在本机,绝不连真正的托管端:
 *   1. 在 `--out` 下起本机托管组合(`server/hosted/combo.mjs`,只绑 127.0.0.1,**关掉本机信任**、带随机集群令牌 ——
 *      与阿里云上同一种布置:回环来的读写也要票据);
 *   2. 起编辑器 A、B(各自的数据目录、导出目录都在 `--out` 下;端口各占 +1、+2 当舞台端口);
 *   3. A 的页面新建项目、经托管端建自由进入的共享项目并以创建者进入(`syncManager.enterShared`,与「打开共享项目」同一条路),
 *      等页面把托管端素材服务交给 A 的上传队列;
 *   4. 经素材库的文件输入(用户导入的那条路,`?tiers=1`)导入一张 PNG、一条 MP3(内容每轮不同,哈希全新);
 *      等 A 的上传队列清空;经托管端的管理接口(集群令牌)按哈希取回两份字节,sha256 与本机一致;
 *   5. B 的页面以成员进入同一个项目:素材表同步过来两条、都带同一哈希;B 的本地内容库原先没有这两份字节
 *      (`/api/media/local`),`/@media/<hash>` 经 B 的编辑器进程按需向托管端素材服务取到、sha256 一致;B 的页面里这张图片解码出来。
 *
 * 起 Chrome 的参数以 `--disable-field-trial-config` 打头(部分实验配置下分块传输的入口脚本会让页面卡死,
 * 见 `docs/archive/agent-reports/AGENT-nav-hang.md`)。
 * 输出:过程写 stderr;stdout 最后一行是一行 JSON `{ ok, ..., fails: [] }`,退出码 0 = 全过。口令与令牌不打印。
 * 只结束自己起的进程(两台编辑器的进程树、同进程里的托管组合)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { startDevServer } from '../lib/dev-server.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, wsBaseOf } from '../../server/auth/route.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DOC_PORT = Number(arg('--doc-port', 6120));
const ASSET_PORT = Number(arg('--asset-port', 6121));
const PORT_A = Number(arg('--port-a', 6110));
const PORT_B = Number(arg('--port-b', 6115));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-shared-import-${RUN}`)));
const KEEP = args.includes('--keep');

// 编辑器不连外面的文档服务、不起队列节点
for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_ASSET_URL',
  'PROMPTCUT_HEADLESS', 'PROMPTCUT_LAN_HOST', 'PROMPTCUT_PUSH', 'PROMPTCUT_ROLE']) delete process.env[key];

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const log = (...a) => console.error('[shared-import]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const HASH = /^[0-9a-f]{64}$/;
async function until(what, fn, ms = 30_000, every = 300) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const getJson = async (url, headers = {}) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  return r.ok ? r.json() : null;
};

const ffmpeg = await findFfmpeg();
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}:${String(r.stderr).slice(-600)}`);
  return r.stdout;
}

const dirsOf = (name) => {
  const base = path.join(OUT, name);
  return { base, exportDir: path.join(base, 'out'), dataDir: path.join(base, 'data'), projectsDir: path.join(base, 'projects'), tmp: path.join(base, 'tmp') };
};
const envOf = (d) => ({
  PROMPTCUT_EXPORT_DIR: d.exportDir, PROMPTCUT_DATA_DIR: d.dataDir, PROMPTCUT_PROJECTS_DIR: d.projectsDir, PROMPTCUT_NO_PORT_FILE: '1',
  PROMPTCUT_STREAMS: '0', TEMP: d.tmp, TMP: d.tmp, TMPDIR: d.tmp,
});

async function openEditor(browser, origin, events) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('dialog', async (d) => { events.push({ type: d.type(), message: d.message() }); await d.dismiss().catch(() => {}); });
  page.on('pageerror', (e) => events.push({ type: 'pageerror', message: String(e?.message || e).slice(0, 300) }));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180_000, polling: 500 });
  await page.evaluate(() => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  return page;
}

const mediaOf = (page) => page.evaluate(async () => {
  const { getState } = await import('/src/store/project.ts');
  return getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, pending: !!m.pending }));
});

const out = { ok: false, run: RUN, out: OUT, ports: { doc: DOC_PORT, asset: ASSET_PORT, a: PORT_A, b: PORT_B } };
const servers = [];
let browser = null;
let combo = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  const A = dirsOf('A');
  const B = dirsOf('B');
  for (const d of [A, B]) for (const k of ['exportDir', 'dataDir', 'projectsDir', 'tmp']) await fs.mkdir(d[k], { recursive: true });

  // ── 素材:内容每轮不同 ──
  const src = path.join(OUT, 'src');
  await fs.mkdir(src, { recursive: true });
  const rnd = crypto.randomBytes(4);
  const png = path.join(src, `still-${RUN}.png`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1',
    '-vf', `drawbox=x=${rnd[0] % 200}:y=${rnd[1] % 150}:w=60:h=60:color=0x${rnd.toString('hex').slice(0, 6)}:t=fill`, png]);
  const mp3 = path.join(src, `voice-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${400 + (rnd[2] % 200)}:sample_rate=44100`, '-t', '2',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=${RUN}`, mp3]);
  const files = [
    { kind: 'image', file: png, name: path.basename(png), hash: sha256(await fs.readFile(png)) },
    { kind: 'audio', file: mp3, name: path.basename(mp3), hash: sha256(await fs.readFile(mp3)) },
  ];
  out.files = files.map((f) => ({ kind: f.kind, name: f.name, hash: f.hash }));

  // ── 1. 托管组合:关掉本机信任、带集群令牌 ──
  const clusterToken = crypto.randomBytes(32).toString('base64url');
  const hostedData = path.join(OUT, 'hosted');
  await fs.mkdir(hostedData, { recursive: true });
  const assetPublicUrl = `http://127.0.0.1:${ASSET_PORT}/api/asset`;
  combo = await startHostedCombo({
    dataDir: hostedData, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', clusterToken, trustLoopback: false,
    docPublicUrl: `ws://127.0.0.1:${DOC_PORT}`, assetPublicUrl, log: () => {},
  });
  check((await getJson(`http://127.0.0.1:${ASSET_PORT}/healthz`))?.ok, '托管组合的素材服务 /healthz');
  const admin = { Authorization: `Bearer ${clusterToken}` };

  // ── 2. 两台编辑器 ──
  log(`起编辑器 A(${PORT_A})`);
  const srvA = await startDevServer({ port: PORT_A, env: envOf(A), logFile: path.join(OUT, 'vite-A.log'), log });
  servers.push(srvA);
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 900_000,
    args: ['--disable-field-trial-config', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'],
  });
  const eventsA = [];
  const pageA = await openEditor(browser, srvA.origin, eventsA);
  log(`起编辑器 B(${PORT_B})`);
  const srvB = await startDevServer({ port: PORT_B, env: envOf(B), logFile: path.join(OUT, 'vite-B.log'), log });
  servers.push(srvB);

  // ── 3. A 新建项目、建共享项目并以创建者进入 ──
  await pageA.evaluate(async (name) => (await import('/src/store/project.ts')).actions.newProject(name), `shared-import-${RUN}`);
  const creatorPw = crypto.randomBytes(12).toString('base64url');
  const projectPw = crypto.randomBytes(12).toString('base64url');
  const shared = await createSharedProject({
    where: 'hosted', hostedUrl: wsBaseOf(`http://127.0.0.1:${DOC_PORT}`), name: `shared-import-${RUN}`, mode: 'free',
    creator: { username: 'alice', password: creatorPw }, password: projectPw, kdf: { alg: 'pbkdf2-sha256', iter: 100000 },
  });
  out.projectId = shared.projectId;
  const candidate = { where: 'hosted', base: shared.base, projectId: shared.projectId, name: shared.name, mode: shared.mode };
  const enter = (page, cred) => page.evaluate(async (c, cr) => (await import('/src/editor/sync/syncManager.ts')).enterShared(c, cr), candidate, cred);
  const ea = await enter(pageA, { as: 'creator', username: 'alice', password: creatorPw });
  if (!check(ea?.ok, 'A 以创建者进入共享项目', ea)) throw new Error('A 进不去共享项目');
  const targetA = await until('A 的上传队列拿到托管端素材服务', async () => {
    const q = await getJson(`${srvA.origin}/api/media/upload-queue`);
    return q?.target?.base && q.target.base.replace(/\/+$/, '') === assetPublicUrl ? q.target.base : null;
  }, 60_000);
  out.a = { uploadTarget: targetA };

  // ── 4. 经素材库的文件输入导入图片与音频 ──
  const input = await pageA.$('[data-pc="library"] input[type=file]');
  if (!input) throw new Error('A 的页面上找不到素材库的文件输入');
  await input.uploadFile(...files.map((f) => f.file));
  const importedA = await until('A 的素材表里两条都入库(带哈希)', async () => {
    const list = await mediaOf(pageA);
    const got = files.map((f) => list.find((m) => m.name === f.name && m.hash && !m.pending) ?? null);
    return got.every(Boolean) ? got : null;
  }, 60_000);
  out.a.media = importedA;
  if (importedA) for (let i = 0; i < files.length; i++) check(importedA[i].hash === files[i].hash, `A:${files[i].kind} 的哈希就是文件的 sha256`, importedA[i]);
  const drained = await until('A 的上传队列清空、两条都传完', async () => {
    const q = await getJson(`${srvA.origin}/api/media/upload-queue`);
    const qs = q?.queue;
    return qs && qs.items?.length === 0 && (qs.done ?? 0) >= files.length ? qs : null;
  }, 60_000, 500);
  out.a.queue = drained ? { done: drained.done, enqueued: drained.enqueued, failures: drained.failures, skippedLocal: drained.skippedLocal } : null;
  const onHost = [];
  for (const f of files) {
    const r = await fetch(`http://127.0.0.1:${ASSET_PORT}/admin/blob/media/${f.hash}`, { headers: admin, signal: AbortSignal.timeout(20_000) });
    const bytes = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    onHost.push({ kind: f.kind, status: r.status, sha: bytes ? sha256(bytes) : null });
  }
  out.hosted = { blobs: onHost };
  for (let i = 0; i < files.length; i++) check(onHost[i].sha === files[i].hash, `托管端素材服务里有 ${files[i].kind} 的同一份字节`, onHost[i]);
  check(!eventsA.some((e) => e.type === 'pageerror'), 'A:页面没有报错', eventsA);

  // ── 5. B 以成员进入,取得到 ──
  const localBefore = await getJson(`${srvB.origin}/api/media/local?hashes=${files.map((f) => f.hash).join(',')}`);
  out.b = { localBefore: localBefore?.hashes ?? null };
  check(Array.isArray(localBefore?.hashes) && files.every((f) => !localBefore.hashes.includes(f.hash)), 'B:开始时本地内容库里没有这两份字节', localBefore);
  const eventsB = [];
  const pageB = await openEditor(browser, srvB.origin, eventsB);
  const eb = await enter(pageB, { as: 'member', username: 'bob', password: projectPw });
  if (!check(eb?.ok, 'B 以成员进入共享项目', eb)) throw new Error('B 进不去共享项目');
  const syncedB = await until('B 的素材表同步过来两条(同一哈希)', async () => {
    const list = await mediaOf(pageB);
    const got = files.map((f) => list.find((m) => m.hash === f.hash) ?? null);
    return got.every(Boolean) ? got : null;
  }, 60_000);
  out.b.media = syncedB;
  await until('B 的编辑器进程拿到托管端素材服务', async () => {
    const q = await getJson(`${srvB.origin}/api/media/upload-queue`);
    return q?.target?.base && q.target.base.replace(/\/+$/, '') === assetPublicUrl;
  }, 60_000);
  const fetched = [];
  for (const f of files) {
    const r = await fetch(`${srvB.origin}/@media/${f.hash}`, { signal: AbortSignal.timeout(60_000) });
    const bytes = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    fetched.push({ kind: f.kind, status: r.status, bytes: bytes?.length ?? 0, sha: bytes ? sha256(bytes) : null });
  }
  out.b.fetched = fetched;
  for (let i = 0; i < files.length; i++) check(fetched[i].sha === files[i].hash, `B:/@media/<hash> 取到 ${files[i].kind} 的同一份字节`, fetched[i]);
  const img = await pageB.evaluate(async (h) => new Promise((resolve) => {
    const el = new Image();
    el.onload = () => resolve({ ok: true, w: el.naturalWidth, h: el.naturalHeight });
    el.onerror = () => resolve({ ok: false });
    el.src = `/@media/${h}`;
  }), files[0].hash);
  out.b.image = img;
  check(img.ok && img.w === 320 && img.h === 240, 'B:页面里这张图片解码出来(320×240)', img);
  check(!eventsB.some((e) => e.type === 'pageerror'), 'B:页面没有报错', eventsB);
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) s.stop();
  await combo?.close?.().catch?.(() => {});
  if (!KEEP && fails.length === 0) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
