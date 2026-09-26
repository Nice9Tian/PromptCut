/**
 * C6.6 两档素材与上传队列的现场探针(`docs/plan/c66-design.md` 第 2、3 节,验收 T1、T3)。
 *
 * 起两台真的编辑器(本检出、vite):
 *   - **R**:只当「远程素材服务」,端口 `--port-r`(缺省 5563);
 *   - **A**:导入方,端口 `--port-a`(缺省 5560),`PROMPTCUT_ASSET_URL` 指向 R 的素材服务 —— 上传队列的目标是 R。
 * 两台各用一个临时的 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`,不碰本检出的 out/ 和用户数据目录。
 *
 * 现场用 ffmpeg 生成三个素材(第 8 节「测试素材」):
 *   1. 1080p、带音轨、moov 在尾的 MP4(ffmpeg 写 MP4 的缺省,约 17 MB,3 片);
 *   2. ProRes 422 HQ 的 MOV(10 bit,无音轨);
 *   3. 640×360 的 H.264 MP4,刻意不加 `+faststart`(晚置 moov)。
 * 按页面导入的同一个请求(`POST /api/media/upload/<名字>?tiers=1`)依次导入 A,然后核对:
 *   - 重封装:三个都缺 faststart,都重封装了;新哈希 ≠ 源文件 sha256;库里的原片 moov 在前、各流编码与源文件相同;
 *   - 小版:A 的 `GET /api/media/tiers` 报 ready;小版 ≤ 800×600、H.264、faststart;不放大;
 *   - 队列:A 的上传队列清空;日志里的顺序是「逐个素材、先小后大」(`upload.tier-start` / `tier-done` / `item-done`);
 *   - R 上六个哈希(三个素材 × 两档)的 `chunks` 各自 `complete: true`,取回的字节 sha256 对得上。
 *
 *   node scripts/probes/tiers-probe.mjs [--port-a 5560] [--port-r 5563] [--timeout-min 6] [--keep]
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着(A 5560～5562,R 5563～5565);
 * 编辑器自己拉起的预渲染进程由系统给空端口(`vite-plugin-prerender.ts`)。结束时只结束本探针起的进程树。
 * 输出最后一行是一行 JSON:`{ ok, imports, queueOrder, remote, fails }`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT_A = Number(arg('--port-a', 5560));
const PORT_R = Number(arg('--port-r', 5563));
const TIMEOUT_MS = Number(arg('--timeout-min', 6)) * 60_000;
const KEEP = args.includes('--keep');
const STAMP = Date.now().toString(36);
const WORK = path.join(os.tmpdir(), `pc-tiers-probe-${STAMP}`);

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return cond; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
async function until(label, fn, timeoutMs = 120_000, everyMs = 500) {
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
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const portFree = async (port) => {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
};
const ff = (argv) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...argv], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
};
const ffprobe = (file) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' }).stdout);

const children = [];
async function startEditor(label, port, extraEnv) {
  const exportDir = path.join(WORK, label);
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_STREAMS: '0', ...extraEnv };
  for (const name of ['PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_PUSH', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_HEADLESS']) delete env[name];
  if (!extraEnv.PROMPTCUT_ASSET_URL) delete env.PROMPTCUT_ASSET_URL;
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(editor);
  const log = [];
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { log.push(line); if (log.length > 4000) log.shift(); }
  };
  editor.stdout.on('data', keep); editor.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  await until(`[${label}] 编辑器起来`, async () => (await fetch(`${origin}/api/media/upload-queue`).then((r) => r.ok, () => false)) || null, 120_000);
  return { label, origin, exportDir, log };
}

const out = { ports: { a: PORT_A, r: PORT_R }, work: WORK };
let ok = false;
try {
  for (const p of [PORT_A, PORT_A + 1, PORT_A + 2, PORT_R, PORT_R + 1, PORT_R + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const { faststartState } = await import(pathToFileURL(path.join(ROOT, 'server', 'media-tiers.mjs')).href);

  // ---- 素材 ----
  const fx = path.join(WORK, 'fixtures');
  await fs.mkdir(fx, { recursive: true });
  const SOURCES = [
    { name: 'probe-1080p.mp4', file: path.join(fx, 'probe-1080p.mp4'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]) },
    { name: 'probe-prores.mov', file: path.join(fx, 'probe-prores.mov'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', f]) },
    { name: 'probe-late-moov.mp4', file: path.join(fx, 'probe-late-moov.mp4'), make: (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-an', f]) },
  ];
  for (const s of SOURCES) {
    s.make(s.file);
    s.sha = sha(await fs.readFile(s.file));
    s.faststart = await faststartState(s.file);
    s.codecs = ffprobe(s.file).streams.map((x) => `${x.codec_type}:${x.codec_name}`);
    check(s.faststart === 'needs', `${s.name} 应当缺 faststart`, s.faststart);
  }

  // ---- 两台编辑器 ----
  const R = await startEditor('r', PORT_R, {});
  const A = await startEditor('a', PORT_A, { PROMPTCUT_ASSET_URL: `http://127.0.0.1:${PORT_R}/api/asset` });
  if (!R || !A) throw new Error('编辑器没起来');
  const q0 = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
  check(q0.target?.base === `http://127.0.0.1:${PORT_R}/api/asset`, 'A 的上传目标是 R', q0.target);

  // ---- 导入(与页面同一个请求) ----
  out.imports = [];
  for (const s of SOURCES) {
    const t0 = Date.now();
    const res = await fetch(`${A.origin}/api/media/upload/${encodeURIComponent(s.name)}?tiers=1`, { method: 'POST', body: await fs.readFile(s.file) });
    const body = await res.json();
    s.body = body;
    s.importMs = Date.now() - t0;
  }
  // ---- 小版 ----
  const hashes = SOURCES.map((s) => s.body.hash);
  const tiers = await until('小版全部生成', async () => {
    const j = await (await fetch(`${A.origin}/api/media/tiers?hashes=${hashes.join(',')}`)).json();
    return hashes.every((h) => j.items[h]?.state && j.items[h].state !== 'pending') ? j.items : null;
  }, TIMEOUT_MS);
  const dl = path.join(WORK, 'dl');
  await fs.mkdir(dl, { recursive: true });
  for (const s of SOURCES) {
    const b = s.body;
    const rec = tiers?.[b.hash] ?? {};
    const row = { name: s.name, src: s.sha.slice(0, 12), original: b.hash?.slice(0, 12), small: rec.small?.slice(0, 12) ?? null, remux: b.remux?.state, smallState: rec.state, importMs: s.importMs };
    check(b.ok === true && b.tiers?.original === b.hash, `${s.name} 回包有 tiers.original`, b);
    check(b.remux?.state === 'remuxed' && b.remux.from === s.sha && b.hash !== s.sha, `${s.name} 重封装、按输出哈希入库`, b.remux);
    // 原片:从 A 取回,moov 在前,编码与源文件相同
    const origFile = path.join(dl, `${b.hash}.${b.ext}`);
    const origBytes = Buffer.from(await (await fetch(`${A.origin}/@media/${b.hash}`)).arrayBuffer());
    await fs.writeFile(origFile, origBytes);
    row.originalFaststart = await faststartState(origFile);
    row.originalCodecs = ffprobe(origFile).streams.map((x) => `${x.codec_type}:${x.codec_name}`);
    check(sha(origBytes) === b.hash, `${s.name} 原片字节与哈希相符`);
    check(row.originalFaststart === 'faststart', `${s.name} 原片 moov 在前`, row.originalFaststart);
    check(JSON.stringify(row.originalCodecs) === JSON.stringify(s.codecs), `${s.name} 原片编码不变`, { src: s.codecs, got: row.originalCodecs });
    // 小版
    check(rec.state === 'ready' && /^[0-9a-f]{64}$/.test(rec.small ?? ''), `${s.name} 小版 ready`, rec);
    if (rec.small) {
      const smallFile = path.join(dl, `${rec.small}.mp4`);
      await fs.writeFile(smallFile, Buffer.from(await (await fetch(`${A.origin}/@media/${rec.small}`)).arrayBuffer()));
      const v = ffprobe(smallFile).streams.find((x) => x.codec_type === 'video');
      const srcV = ffprobe(s.file).streams.find((x) => x.codec_type === 'video');
      row.smallSize = `${v.width}x${v.height}`;
      row.smallCodec = v.codec_name;
      row.smallFaststart = await faststartState(smallFile);
      check(v.codec_name === 'h264', `${s.name} 小版 H.264`, v.codec_name);
      check(v.width <= 800 && v.height <= 600 && v.width % 2 === 0 && v.height % 2 === 0, `${s.name} 小版 ≤ 800×600 且偶数`, row.smallSize);
      check(v.width <= srcV.width && v.height <= srcV.height, `${s.name} 小版不放大`, row.smallSize);
      check(row.smallFaststart === 'faststart', `${s.name} 小版 faststart`, row.smallFaststart);
    }
    out.imports.push(row);
  }

  // ---- 上传队列:清空、顺序 ----
  await until('A 的上传队列清空', async () => {
    const j = await (await fetch(`${A.origin}/api/media/upload-queue`)).json();
    return j.queue && j.queue.items.length === 0 && !j.queue.working ? j : null;
  }, TIMEOUT_MS);
  const short = (h) => {
    for (const s of SOURCES) {
      if (h === s.body.hash) return `${s.name}:original`;
      if (h === tiers?.[s.body.hash]?.small) return `${s.name}:small`;
    }
    return h.slice(0, 8);
  };
  const events = [];
  for (const line of A.log) {
    const m = /\[media-tiers\] (upload\.(?:tier-start|tier-done|item-done|retry)) (\{.*\})$/.exec(line);
    if (!m) continue;
    const f = JSON.parse(m[2]);
    events.push(m[1] === 'upload.item-done' ? `item-done ${short(f.id)}` : `${m[1].slice(7)} ${short(f.hash ?? f.id)}`);
  }
  out.queueOrder = events;
  const expected = SOURCES.flatMap((s) => [`tier-start ${s.name}:small`, `tier-done ${s.name}:small`, `tier-start ${s.name}:original`, `tier-done ${s.name}:original`, `item-done ${s.name}:original`]);
  check(JSON.stringify(events) === JSON.stringify(expected), '队列顺序:逐个素材、先小后大', events);

  // ---- R 上两档分别 complete ----
  out.remote = {};
  for (const s of SOURCES) {
    for (const [tier, h] of [['small', tiers?.[s.body.hash]?.small], ['original', s.body.hash]]) {
      if (!h) continue;
      const c = await (await fetch(`${R.origin}/api/asset/media/${h}/chunks`)).json();
      const bytes = Buffer.from(await (await fetch(`${R.origin}/api/asset/media/${h}`)).arrayBuffer());
      out.remote[`${s.name}:${tier}`] = { complete: c.complete, chunks: c.received.length, shaOk: sha(bytes) === h };
      check(c.complete === true && sha(bytes) === h, `R 上 ${s.name} ${tier} complete 且字节相符`, c);
    }
  }
  ok = fails.length === 0;
} catch (err) {
  fails.push(`异常:${err?.stack ?? err}`);
} finally {
  for (const c of children) killTree(c);
  if (!KEEP) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify({ ok, ...out, fails }));
process.exit(ok ? 0 : 1);
