/**
 * 0.7.18 块四的探针：打开旧云端项目文件（凭「已不存在」的证明转成本地项目）与缺素材占位，在真的编辑器里走一遍。
 * 对应 `docs/plan/account-binding-task.md`「逐项验收」的「过期云端项目转本地」「非过期与坏文件」「缺失视觉/音频素材」三行。
 *
 * 起的东西（都只听 127.0.0.1，端口在派给本块的那一段里）：
 *   - 一个假的云端文档服务入口：真的账号账本（临时目录里的 SQLite）、真的签发方（`server/account/authority.mjs`）、
 *     真的公开入口处理函数（`server/docservice/modules/account-projects.mjs`）；墓碑经真的登记脚本
 *     `server/hosted/deploy/legacy-tombstones.mjs` 的 plan / apply / verify 写入与核对；
 *   - 一台编辑器（开发服务器，自己的临时数据目录，内容库起初是空的）。信任表不经产品代码注入：探针在自己起的浏览器里
 *     拦下页面对证明模块的请求换内容（`lib/gone-trust-intercept.mjs`），把页面指到上面那个入口。
 *
 * 合成的旧文件矩阵（每格的预期照任务书）：
 *   过期且有证明（素材全在 / 部分缺 / 全缺）、过期但证明对不上、服务说得清没有墓碑（没过期，这台设备上没有身份 → 要认证）、
 *   暂时离线（签发方连不上）、文件损坏六种、协作关联版本不认识。
 *   「没过期且连得上原项目」「没有权限」两格要一台活着的旧云端服务，这里起不了，由状态机单测
 *   `server/test/cloud-gone-recovery.test.mjs` 覆盖。
 *
 *   node scripts/probes/v18-missing-probe.mjs [--port 28460] [--doc-port 28470] [--out <目录>] [--shots <截图目录>] [--keep]
 *
 * 输出最后一行是一行 JSON：`{ ok, cells, fails }`，退出码 0 = 全过。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';
import { interceptGoneTrust } from './lib/gone-trust-intercept.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { openAccountLedger } from '../../server/account/ledger.mjs';
import { createAccountAuthority } from '../../server/account/authority.mjs';
import { mountAccountProjects } from '../../server/docservice/modules/account-projects.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(arg('--port', 28460));
const DOC_PORT = Number(arg('--doc-port', 28470));
const DEAD_PORT = Number(arg('--dead-port', 28479)); // 没人听：模拟签发方连不上
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-v18-missing-${RUN}`)));
const SHOTS = path.resolve(arg('--shots', path.join(OUT, 'shots')));
const KEEP = args.includes('--keep');

const fails = [];
const cells = {};
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); return !!cond; };
const log = (...a) => console.error('[v18-missing]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ffmpeg = await findFfmpeg();
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}:${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
function node(a) {
  const r = spawnSync(process.execPath, a, { encoding: 'utf8', windowsHide: true, cwd: REPO });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** 不堵住本进程事件循环的那一种（被叫的脚本要回头来问本进程里起的假文档服务） */
function nodeAsync(a) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, a, { windowsHide: true, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function audioRms(file, start, dur) {
  const pcm = run(ffmpeg, ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const n = Math.floor(pcm.length / 2); let sq = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sq += v * v; }
  const rms = n ? Math.sqrt(sq / n) : 0;
  return { samples: n, rmsDb: rms ? +(20 * Math.log10(rms)).toFixed(1) : -120 };
}
function frameStats(file, at) {
  const raw = run(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
  let sum = 0; for (const b of raw) sum += b;
  const mean = raw.length ? sum / raw.length : 0; let v = 0; for (const b of raw) v += (b - mean) ** 2;
  return { mean: +mean.toFixed(1), std: raw.length ? +Math.sqrt(v / raw.length).toFixed(1) : 0 };
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const roomId = () => { const abc = 'abcdefghijklmnopqrstuvwxyz234567'; return 'sp_' + [...crypto.randomBytes(26)].map((b) => abc[b % 32]).join(''); };

const SERVICE_OK = 'https://old-hosted-ok.invalid/hosted';
const SERVICE_BADKEY = 'https://old-hosted-badkey.invalid/hosted';
const SERVICE_OFFLINE = 'https://old-hosted-offline.invalid/hosted';
const SERVICE_UNKNOWN = 'https://someone-else.invalid/hosted';

const out = { ok: false, run: RUN, out: OUT, shots: SHOTS };
let browser = null, server = null, docServer = null, ledger = null;
try {
  await fs.mkdir(OUT, { recursive: true }); await fs.mkdir(SHOTS, { recursive: true });

  // ── 假的云端文档服务入口：真账本、真签发方、真处理函数 ──
  const keys = crypto.generateKeyPairSync('ed25519');
  const keyFile = path.join(OUT, 'doc-signing.pem');
  await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const ledgerFile = path.join(OUT, 'doc', 'account-v2.sqlite');
  ledger = openAccountLedger({ file: ledgerFile, authorityId: 'doc-probe' });
  const authority = createAccountAuthority({ ledger, accountClient: new Proxy({}, { get: () => () => { throw Object.assign(new Error('no account service in this probe'), { status: 503, code: 'account-unavailable' }); } }),
    initializeProject: async () => ({}), authorityUrl: `http://127.0.0.1:${DOC_PORT}/editor`, signingKey: keys.privateKey, keyId: 'k1', pollMs: 0 });
  const mounted = mountAccountProjects({ authority });
  const docHits = [];
  docServer = http.createServer(async (req, res) => {
    docHits.push(req.url);
    if (!await mounted.handlePublic(req, res)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"no-route"}'); }
  });
  await new Promise((resolve, reject) => { docServer.once('error', reject); docServer.listen(DOC_PORT, '127.0.0.1', resolve); });
  const hitsFor = (id) => docHits.filter((u) => u.includes(id)).length;

  const rooms = { full: roomId(), partial: roomId(), all: roomId(), alive: roomId(), badkey: roomId(), offline: roomId(), unknown: roomId() };
  // 墓碑登记脚本：先空跑、再真写、再从「公网」核对（这里的公网就是上面那个入口）
  const idsFile = path.join(OUT, 'legacy-ids.txt');
  await fs.writeFile(idsFile, `# 探针：要登记墓碑的旧项目号\n${rooms.full}\n${rooms.partial}\n${rooms.all}\n${rooms.badkey}\n${rooms.offline}\n`);
  const absentFile = path.join(OUT, 'absent-ids.txt');
  await fs.writeFile(absentFile, `${rooms.alive}\n`);
  const cli = path.join(REPO, 'server', 'hosted', 'deploy', 'legacy-tombstones.mjs');
  const common = ['--ledger', ledgerFile, '--authority-id', 'doc-probe', '--ids', idsFile];
  const plan = node([cli, 'plan', ...common]);
  check(plan.status === 0 && /空跑，没有写/.test(plan.stdout) && /新登记 5/.test(plan.stdout), '登记脚本：空跑报 5 个要新登记', plan);
  check(ledger.read().legacyTombstones === undefined, '登记脚本：空跑没有写账本');
  check((await fetch(`http://127.0.0.1:${DOC_PORT}/hosted/shared/account/gone?authorityId=doc-probe&projectId=${rooms.full}`)).status === 404, '登记之前：公开入口答没有墓碑');
  const apply = node([cli, 'apply', ...common, '--source', `probe ${RUN}`]);
  check(apply.status === 0 && /已写入/.test(apply.stdout) && /墓碑 0 → 5/.test(apply.stdout), '登记脚本：真写 5 个', apply);
  const again = node([cli, 'apply', ...common, '--source', `probe ${RUN} again`]);
  check(again.status === 0 && /已登记过 5/.test(again.stdout) && /墓碑 5 → 5/.test(again.stdout), '登记脚本：重复跑不重复写', again);
  const pub = node([cli, 'print-public-key', '--signing-key-file', keyFile]);
  const publicKey = pub.stdout.trim();
  check(pub.status === 0 && /^[A-Za-z0-9_-]{43}$/.test(publicKey) && !/PRIVATE/.test(pub.stdout), '登记脚本：打印出公钥（不含私钥）', pub);
  const verify = await nodeAsync([cli, 'verify', '--origin', `http://127.0.0.1:${DOC_PORT}`, '--authority-id', 'doc-probe', '--kid', 'k1', '--public-key', publicKey, '--service', SERVICE_OK, '--ids', idsFile, '--absent', absentFile]);
  check(verify.status === 0 && /全部对上：6\/6/.test(verify.stdout), '登记脚本：从公开入口核对，5 个拿得到验得过的证明、1 个明确没有墓碑', verify);
  out.cli = { plan: plan.stdout.trim().split('\n').pop(), apply: apply.stdout.trim().split('\n').pop(), again: again.stdout.trim().split('\n').pop(), verify: verify.stdout.trim().split('\n').pop() };

  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const authorities = [
    { authorityId: 'doc-probe', origin: `http://127.0.0.1:${DOC_PORT}`, services: [SERVICE_OK], keys: { k1: publicKey } },
    { authorityId: 'doc-probe', origin: `http://127.0.0.1:${DOC_PORT}`, services: [SERVICE_BADKEY], keys: { k1: otherKey } },
    { authorityId: 'doc-probe', origin: `http://127.0.0.1:${DEAD_PORT}`, services: [SERVICE_OFFLINE], keys: { k1: publicKey } },
  ];

  // ── 素材：现场生成 ──
  const src = path.join(OUT, 'src'); await fs.mkdir(src, { recursive: true });
  const files = {
    video: path.join(src, `镜头-${RUN}.mp4`), lost: path.join(src, `丢失的镜头-${RUN}.mp4`),
    voice: path.join(src, `旁白-${RUN}.mp3`), lostVoice: path.join(src, `丢失的旁白-${RUN}.mp3`), image: path.join(src, `封面-${RUN}.png`),
  };
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=${RUN}`, files.video]);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=lost-${RUN}`, files.lost]);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=${RUN}`, files.voice]);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=lost-${RUN}`, files.lostVoice]);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2266aa:s=640x360', '-frames:v', '1', files.image]);
  const bytes = {}; const hash = {};
  for (const [k, f] of Object.entries(files)) { bytes[k] = await fs.readFile(f); hash[k] = sha256(bytes[k]); }
  const wavFile = path.join(REPO, 'src', 'audio', 'assets', 'missing-material.wav');
  const wavHash = sha256(await fs.readFile(wavFile)).toUpperCase();
  check(wavHash === '5E615376504BDD9350A88E890E3FE320109719A5DAB42D760BC658B993CCF4E7', '随软件分发的人声文件就是契约里记的那一份', wavHash);

  // ── 编辑器 ──
  const dirs = { exportDir: path.join(OUT, 'ed', 'out'), dataDir: path.join(OUT, 'ed', 'data'), projectsDir: path.join(OUT, 'ed', 'projects') };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  log(`起编辑器(${PORT})`);
  server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log,
    env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1' } });
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const events = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('dialog', async (d) => { events.push({ type: d.type(), message: d.message() }); await d.accept().catch(() => {}); });
  page.on('pageerror', (e) => events.push({ type: 'pageerror', message: String(e?.message || e) }));
  // 信任表不经产品代码注入：在这只浏览器里拦下页面对证明模块的请求，换成带测试签发方的内容
  const trust = await interceptGoneTrust(page, authorities);
  await page.goto(server.origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });

  const upload = async (key) => {
    const r = await fetch(`${server.origin}/api/media/upload/${encodeURIComponent(path.basename(files[key]))}`, { method: 'POST', body: bytes[key] });
    const j = r.ok ? await r.json() : null;
    check(j?.hash === hash[key], `内容库收下 ${key} 的同一份字节`, j);
  };

  /** 在页面里搭一份项目并存成 `.proc` 文本（素材只登记哈希与「别的机器上」的路径，不带字节） */
  const build = (name, media, clips) => page.evaluate(async (o) => {
    const { actions, getState } = await import('/src/store/project.ts');
    const { serializeProc } = await import('/src/editor/io/proc.ts');
    actions.newProject(o.name);
    const ids = {};
    for (const m of o.media) ids[m.key] = actions.addMedia({ kind: m.kind, name: m.name, url: `/@media/${m.hash}`, hash: m.hash, ext: m.name.split('.').pop(), path: `Z:/old-machine/media/${m.name}`, duration: m.duration, ...(m.kind === 'audio' ? {} : { width: 640, height: 360 }) }).id;
    const tracks = {};
    for (const c of o.clips) {
      tracks[c.track] ??= actions.addTrack(c.track).id;
      if (!actions.addMediaClip(ids[c.key], c.start, { trackId: tracks[c.track], duration: c.duration })) throw new Error(`放不上时间轴:${c.key}`);
    }
    const doc = JSON.parse(serializeProc());
    return { text: JSON.stringify(doc), ids, projectId: getState().project.id };
  }, { name, media, clips });
  const withRoom = (text, descriptor) => { const doc = JSON.parse(text); doc.collaboration = descriptor; return JSON.stringify(doc, null, 2); };
  const hostedFile = (text, room, service = SERVICE_OK) => withRoom(text, { version: 1, roomId: room, service, where: 'hosted' });

  /** 打开一份 `.proc` 文本（和开始页「打开文件」同一条路），回打不开时的报错 */
  const open = (text, name = 'old-cloud.proc') => page.evaluate(async (t, n) => {
    const { actions } = await import('/src/store/project.ts');
    const { loadProc } = await import('/src/editor/io/proc.ts');
    const { setActiveDraftId } = await import('/src/editor/io/drafts.ts');
    try { actions.loadProject(loadProc(t), n); setActiveDraftId(null); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }, text, name);
  /** 页面此刻的样子 */
  const snap = () => page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    const S = await import('/src/editor/sync/syncManager.ts');
    const A = await import('/src/editor/sync/recoveryAssociation.ts');
    const { confirmedMissing } = await import('/src/audio/missingMaterialRecord.ts');
    const p = getState().project; void S;
    const chip = document.querySelector('[data-pc="collaboration-recovery"]');
    return {
      id: p.id, name: p.name,
      clips: p.tracks.flatMap((t) => t.clips.map((c) => ({ mediaId: c.mediaId ?? null, start: c.start, end: c.end }))),
      media: p.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, url: m.url, hash: m.hash ?? null, missing: confirmedMissing(m) })),
      association: A.currentAssociation(), convertedFrom: A.convertedFromOf(p),
      chip: chip ? { kind: chip.getAttribute('data-kind'), text: chip.textContent } : null,
      goneDialog: document.querySelector('[data-pc="cloud-gone-dialog"]')?.textContent ?? null,
      missingDialog: [...document.querySelectorAll('[data-pc="missing-material-item"]')].map((el) => el.textContent),
      missingDialogText: document.querySelector('[data-pc="missing-materials-dialog"]')?.textContent ?? null,
    };
  });
  const until = async (pred, ms = 30000) => { const t0 = Date.now(); let s; do { s = await snap(); if (pred(s)) return s; await sleep(250); } while (Date.now() - t0 < ms); return s; };
  const shot = async (name) => { const file = path.join(SHOTS, name); await page.screenshot({ path: file }); return file; };
  const dismiss = () => page.evaluate(() => { for (const sel of ['[data-pc="cloud-gone-ok"]', '[data-pc="missing-materials-ok"]']) document.querySelector(sel)?.click(); });

  const M = {
    video: { key: 'video', kind: 'video', name: path.basename(files.video), hash: hash.video, duration: 3 },
    lost: { key: 'lost', kind: 'video', name: path.basename(files.lost), hash: hash.lost, duration: 2 },
    voice: { key: 'voice', kind: 'audio', name: path.basename(files.voice), hash: hash.voice, duration: 2 },
    lostVoice: { key: 'lostVoice', kind: 'audio', name: path.basename(files.lostVoice), hash: hash.lostVoice, duration: 2 },
    image: { key: 'image', kind: 'image', name: path.basename(files.image), hash: hash.image, duration: 2 },
  };
  const C = {
    video: { key: 'video', track: '画面', start: 0, duration: 3 }, image: { key: 'image', track: '画面', start: 3, duration: 2 },
    lost: { key: 'lost', track: '画面', start: 5, duration: 2 }, voice: { key: 'voice', track: '配音', start: 0.5, duration: 2 },
    lostVoice: { key: 'lostVoice', track: '配音', start: 3, duration: 2 },
  };

  // ════ 格 1：过期且有证明，素材全在 ════
  for (const k of ['video', 'voice', 'image']) await upload(k);
  const full = await build(`全在-${RUN}`, [M.video, M.voice, M.image], [C.video, C.image, C.voice]);
  await open(hostedFile(full.text, rooms.full));
  let s = await until((x) => x.goneDialog !== null);
  await sleep(4500); s = await snap(); // 等打开后的后台检查做完
  cells.goneFull = { id: s.id, wasId: full.projectId, association: s.association, convertedFrom: s.convertedFrom, goneDialog: s.goneDialog, missingDialog: s.missingDialog, media: s.media.map((m) => [m.name, m.missing]) };
  check(s.goneDialog !== null, '全在：提示了一次', s.goneDialog);
  check(s.id && s.id !== full.projectId, '全在：换了新的本地项目号', [s.id, full.projectId]);
  check(s.association === null && s.chip === null, '全在：协作关联清掉了（多用户协作关）', [s.association, s.chip]);
  check(s.convertedFrom?.roomId === rooms.full && s.convertedFrom.authorityId === 'doc-probe', '全在：记下了出处', s.convertedFrom);
  check(s.clips.length === 3 && s.clips.every((c, i) => c.start === [0, 3, 0.5][i]), '全在：片段位置原样', s.clips);
  check(s.media.length === 3 && s.media.every((m) => !m.missing && !m.name.startsWith('(缺失)')), '全在：没有素材被认定缺失', s.media);
  check(s.missingDialog.length === 0, '全在：不弹缺素材的窗口', s.missingDialog);
  await shot('01-gone-converted-dialog.png');
  await dismiss();

  // ════ 格 2：过期且有证明，素材部分缺（丢失的镜头、丢失的旁白没有） ════
  const partial = await build(`部分缺-${RUN}`, [M.video, M.voice, M.image, M.lost, M.lostVoice], [C.video, C.image, C.lost, C.voice, C.lostVoice]);
  const partialFile = hostedFile(partial.text, rooms.partial);
  const hitsBefore = hitsFor(rooms.partial);
  await open(partialFile);
  s = await until((x) => x.goneDialog !== null);
  check(s.goneDialog !== null && s.association === null && s.id !== partial.projectId, '部分缺：转成了本地项目', [s.goneDialog, s.association, s.id]);
  await shot('02-partial-gone-dialog.png');
  await page.evaluate(() => document.querySelector('[data-pc="cloud-gone-ok"]')?.click());
  s = await until((x) => x.missingDialog.length >= 2);
  cells.gonePartial = { missingDialog: s.missingDialog, text: s.missingDialogText, media: s.media.map((m) => [m.name, m.missing]), clips: s.clips };
  check(s.missingDialog.length === 2 && s.missingDialog.some((t) => t.includes(M.lost.name)) && s.missingDialog.some((t) => t.includes(M.lostVoice.name)), '部分缺：弹窗列出缺的两条（原名）', s.missingDialog);
  check(s.media.filter((m) => m.missing).map((m) => m.id).sort().join() === [partial.ids.lost, partial.ids.lostVoice].sort().join(), '部分缺：只有那两条被认定缺失', s.media);
  check(s.clips.length === 5 && JSON.stringify(s.clips.map((c) => [c.start, c.end])) === JSON.stringify([[0, 3], [3, 5], [5, 7], [0.5, 2.5], [3, 5]]), '部分缺：片段的位置和编排原样', s.clips);
  await shot('03-partial-missing-dialog.png');
  await dismiss();
  const convertedId = s.id;

  // 预览：画面占位（6 s 处是丢失的镜头）、声音占位（3.2 s 处是丢失的旁白）
  const stageText = async () => { const found = []; for (const f of page.frames()) { try { found.push(...await f.evaluate(() => [...document.querySelectorAll('[data-pc-confirmed-missing]')].map((el) => ({ text: el.textContent, clip: el.getAttribute('data-pc-clip'), visible: el.getBoundingClientRect().width > 0 })))); } catch { /* 跨源或已卸载的帧 */ } } return found; };
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause?.(); actions.seek(6); });
  let placeholders = []; for (let i = 0; i < 40 && !placeholders.length; i++) { await sleep(250); placeholders = await stageText(); }
  cells.previewVisual = placeholders;
  check(placeholders.some((p) => p.text === `找不到素材${M.lost.name}` && p.visible), '预览：缺失的画面显示「找不到素材」加文件名', placeholders);
  const awaitingBadge = async () => { let n = 0; for (const f of page.frames()) { try { n += await f.evaluate(() => document.querySelectorAll('[data-pc-media-awaiting]').length); } catch { /* 同上 */ } } return n; };
  check(await awaitingBadge() === 0, '预览：占位上不叠「等待上传方」');
  await shot('04-preview-missing-visual.png');
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(1); });
  await sleep(1200);
  check((await stageText()).length === 0, '预览：素材在的片段不出占位');
  await shot('05-preview-present-visual.png');
  // 声音：从 2.9 s 播到 4.6 s，丢失的旁白那一段（3～5 s）的 <audio> 用的是随软件分发的那段人声，并且真的在走
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(2.9); actions.play(); });
  const audioSamples = [];
  for (let i = 0; i < 14; i++) {
    await sleep(150);
    audioSamples.push(await page.evaluate(() => [...document.querySelectorAll('audio[data-pc-audio-clip]')].map((a) => ({ src: a.currentSrc || a.src, paused: a.paused, t: +a.currentTime.toFixed(2), ready: a.readyState, err: a.error?.code ?? null, volume: a.volume, muted: a.muted }))));
  }
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
  const wavPlays = audioSamples.flat().filter((a) => /missing-material.*\.wav/.test(a.src));
  cells.previewAudio = { samples: wavPlays.slice(0, 8), elements: audioSamples.at(-1) };
  check(wavPlays.some((a) => !a.paused && a.t > 0.2 && a.err === null && !a.muted && a.volume > 0), '预览：缺失的声音放的是随软件分发的人声，播放头在走、没有静音', wavPlays.slice(0, 6));
  const wavUrl = wavPlays[0]?.src;
  if (wavUrl) check(sha256(Buffer.from(await (await fetch(wavUrl)).arrayBuffer())).toUpperCase() === wavHash, '预览：页面放的就是那一份文件（哈希一致）', wavUrl);

  // 导出：缺失片段照原位置出占位，声音里有那段人声
  log('导出');
  const exp = await page.evaluate(async () => { const io = await import('/src/editor/io/index.ts'); const r = await io.exportVideo(); return { outDir: r.outDir, skipped: r.skippedMedia ?? [] }; });
  const mp4 = path.join(OUT, `export-${RUN}.mp4`);
  await fs.copyFile(path.join(exp.outDir, 'preview.mp4'), mp4);
  const pj = JSON.parse(await fs.readFile(path.join(exp.outDir, 'project.json'), 'utf8'));
  const exportShot = path.join(SHOTS, '06-export-frame-missing-visual.png');
  run(ffmpeg, ['-y', '-v', 'error', '-ss', '6', '-i', mp4, '-frames:v', '1', exportShot]);
  run(ffmpeg, ['-y', '-v', 'error', '-ss', '1', '-i', mp4, '-frames:v', '1', path.join(SHOTS, '07-export-frame-present-visual.png')]);
  const eLost = frameStats(mp4, 6), ePresent = frameStats(mp4, 1), eImage = frameStats(mp4, 4);
  const voiceLost = audioRms(mp4, 3.05, 1.2), voiceTail = audioRms(mp4, 4.6, 0.35), voiceReal = audioRms(mp4, 0.8, 1.4), voiceLostVideo = audioRms(mp4, 5.05, 1.2);
  cells.export = { file: mp4, skipped: exp.skipped, clipsInExport: (pj.tracks || []).flatMap((t) => t.clips || []).length, frames: { lost: eLost, present: ePresent, image: eImage }, audio: { lostVoice: voiceLost, afterVoice: voiceTail, realVoice: voiceReal, lostVideo: voiceLostVideo } };
  check(exp.skipped.length === 0 && cells.export.clipsInExport === 5, '导出：没有片段被跳过', cells.export);
  check(eLost.mean > 25 && eLost.mean < 80 && eLost.std > 3 && eLost.std < 60, '导出：6 s 处是深色底加白字的占位（不是彩条、也不是空白）', eLost);
  check(ePresent.std > 20, '导出：素材在的片段画面正常', ePresent);
  check(voiceLost.rmsDb > -40, '导出：丢失的旁白那一段有人声', voiceLost);
  check(voiceTail.rmsDb < -50, '导出：人声只放一次，放完是静音（不循环）', voiceTail);
  check(voiceReal.rmsDb > -40, '导出：素材在的配音照常', voiceReal);

  // 保存（原文件保留）→ 重开：占位还在、不再提示、不再去连旧云端
  const saved = await page.evaluate(async () => { const { serializeProc } = await import('/src/editor/io/proc.ts'); return serializeProc(); });
  const savedFile = path.join(OUT, `converted-${RUN}.proc`); await fs.writeFile(savedFile, saved);
  const savedDoc = JSON.parse(saved);
  check(savedDoc.collaboration === undefined && savedDoc.convertedFrom?.roomId === rooms.partial, '保存：新文件不带协作关联，带出处记录', [savedDoc.collaboration, savedDoc.convertedFrom]);
  check(savedDoc.project.id === convertedId, '保存：存的是新的本地项目号');
  check(savedDoc.project.media.filter((m) => m.missingMaterial?.reason === 'confirmed-missing').length === 2, '保存：两条「确认缺失」的记录随文件保存');
  check(!/wav|missing-material/.test(JSON.stringify(savedDoc.project.media.map((m) => [m.url, m.path]))), '保存：占位人声不进项目');
  check(JSON.parse(partialFile).collaboration.roomId === rooms.partial, '原文件（输入）没有被改');
  const hitsAfterConvert = hitsFor(rooms.partial);
  await open(full.text, 'something-else.proc'); await sleep(800); await dismiss(); // 先换到别的项目
  await open(saved, 'converted.proc');
  await sleep(5000); s = await snap();
  cells.reopen = { id: s.id, association: s.association, goneDialog: s.goneDialog, missingDialog: s.missingDialog, media: s.media.map((m) => [m.name, m.missing]), docHits: [hitsBefore, hitsAfterConvert, hitsFor(rooms.partial)] };
  check(s.id === convertedId && s.association === null && s.chip === null, '重开：就是那个本地项目，没有协作关联', [s.id, s.association, s.chip]);
  check(s.goneDialog === null && s.missingDialog.length === 0, '重开：不再提示', [s.goneDialog, s.missingDialog]);
  check(hitsFor(rooms.partial) === hitsAfterConvert && hitsAfterConvert > hitsBefore, '重开：没有再去问旧云端项目', cells.reopen.docHits);
  check(s.media.filter((m) => m.missing).length === 2, '重开：两条素材仍是「确认缺失」', s.media);
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(6); });
  placeholders = []; for (let i = 0; i < 40 && !placeholders.length; i++) { await sleep(250); placeholders = await stageText(); }
  check(placeholders.some((p) => p.text === `找不到素材${M.lost.name}`), '重开：占位还在', placeholders);
  await shot('08-reopen-placeholder-still-there.png');

  // 找回：把丢失的两份文件放进内容库（相当于用户重新导入了同样内容的文件），后台检查清掉记录，占位消失
  await upload('lost'); await upload('lostVoice');
  await page.evaluate(async () => { const { checkHashedMedia } = await import('/src/editor/io/mediaUpload.ts'); await checkHashedMedia(); });
  s = await until((x) => x.media.every((m) => !m.missing), 10000);
  cells.recovered = s.media.map((m) => [m.name, m.missing, m.url]);
  check(s.media.every((m) => !m.missing && !m.name.startsWith('(缺失)') && m.url === `/@media/${m.hash}`), '找回：记录清掉，名字和地址恢复', s.media);
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(6.2); });
  let gone = true; for (let i = 0; i < 40 && gone; i++) { await sleep(250); gone = (await stageText()).length > 0; }
  check(!gone, '找回：占位消失');
  await sleep(1500); await shot('09-recovered-real-material.png');

  // ════ 格 3：过期且有证明，素材全缺 ════
  const rnd = () => crypto.randomBytes(32).toString('hex');
  const allMedia = [{ ...M.video, key: 'v', name: `全缺镜头-${RUN}.mp4`, hash: rnd() }, { ...M.voice, key: 'a', name: `全缺旁白-${RUN}.mp3`, hash: rnd() }, { ...M.image, key: 'i', name: `全缺封面-${RUN}.png`, hash: rnd() }];
  const all = await build(`全缺-${RUN}`, allMedia, [{ key: 'v', track: '画面', start: 0, duration: 3 }, { key: 'i', track: '画面', start: 3, duration: 2 }, { key: 'a', track: '配音', start: 0.5, duration: 2 }]);
  await open(hostedFile(all.text, rooms.all));
  s = await until((x) => x.goneDialog !== null); await page.evaluate(() => document.querySelector('[data-pc="cloud-gone-ok"]')?.click());
  s = await until((x) => x.missingDialog.length >= 3);
  cells.goneAll = { missingDialog: s.missingDialog, media: s.media.map((m) => [m.name, m.missing]), clips: s.clips.length };
  check(s.association === null && s.id !== all.projectId, '全缺：转成了本地项目');
  check(s.missingDialog.length === 3 && s.media.every((m) => m.missing) && s.clips.length === 3, '全缺：三条都列出、都认定缺失，片段都在', cells.goneAll);
  await shot('10-all-missing-dialog.png'); await dismiss();
  await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(4); });
  placeholders = []; for (let i = 0; i < 40 && !placeholders.length; i++) { await sleep(250); placeholders = await stageText(); }
  check(placeholders.some((p) => p.text === `找不到素材全缺封面-${RUN}.png`), '全缺：图片片段也出占位', placeholders);
  await shot('11-all-missing-image-placeholder.png');

  // ════ 不转的各格：内容照常载入、关联保留、不换项目号、不提示 ════
  const notConverted = async (label, file, wantChip) => {
    const before = full.projectId;
    await open(file); await sleep(3500);
    const x = await snap();
    cells[label] = { id: x.id, association: x.association?.roomId ?? null, chip: x.chip, goneDialog: x.goneDialog, clips: x.clips.length };
    check(x.id === before, `${label}：项目号没变（没有转成本地项目）`, [x.id, before]);
    check(x.association !== null, `${label}：云端关联保留`, x.association);
    check(x.goneDialog === null, `${label}：没有提示「已转成本地项目」`, x.goneDialog);
    check(x.clips.length === 3 && x.media.length === 3, `${label}：文件里的内容照常载入，不是空项目`, [x.clips.length, x.media.length]);
    check(wantChip.includes(x.chip?.kind), `${label}：状态条报的是 ${wantChip.join(' / ')}`, x.chip);
    return x;
  };
  // 服务说得清没有墓碑（项目没过期）：这台设备上没有这个项目的身份 → 要认证
  await notConverted('alive', hostedFile(full.text, rooms.alive), ['needs-auth']);
  await shot('12-not-expired-needs-auth.png');
  // 过期但证明对不上（信任表里的钥匙不是签发方的）
  await notConverted('badkey', hostedFile(full.text, rooms.badkey, SERVICE_BADKEY), ['needs-auth', 'proof-rejected']);
  // 暂时离线（签发方连不上）
  await notConverted('offline', hostedFile(full.text, rooms.offline, SERVICE_OFFLINE), ['needs-auth', 'waiting-host', 'recovering']);
  await shot('13-offline-not-converted.png');
  // 文件里记的服务不在信任表里
  await notConverted('unknownService', hostedFile(full.text, rooms.unknown, SERVICE_UNKNOWN), ['needs-auth', 'waiting-host', 'recovering']);
  // 协作关联的版本不认识：内容照常载入，关联原样留着
  const unsupported = await notConverted('assocVersion', withRoom(full.text, { version: 9, roomId: rooms.alive, service: SERVICE_OK, where: 'hosted', future: { kept: true } }), ['unsupported']);
  check(unsupported.association?.future?.kept === true, '关联版本不认识：未知字段原样留着', unsupported.association);

  // ════ 文件损坏：报错、当前项目原样、不拿空项目顶 ════
  await open(full.text, 'baseline.proc'); await sleep(500); await dismiss();
  const baseline = await snap();
  const good = hostedFile(full.text, rooms.full);
  const broken = {
    'JSON 截断': good.slice(0, Math.floor(good.length / 2)),
    '空文件': '',
    '没有项目内容': JSON.stringify({ format: 'promptcut-project', version: 1, savedAt: 'x', thumbnail: null }),
    '项目内容不成形': JSON.stringify({ format: 'promptcut-project', version: 1, project: { id: 'x', name: 'x' } }),
    '更新的格式版本': JSON.stringify({ ...JSON.parse(good), version: 99 }),
    '房间号写坏了': withRoom(full.text, { version: 1, roomId: 'not-a-room', service: SERVICE_OK, where: 'hosted' }),
  };
  cells.broken = {};
  for (const [label, text] of Object.entries(broken)) {
    const r = await open(text, `${label}.proc`); await sleep(300);
    const x = await snap();
    cells.broken[label] = r.error ?? 'opened';
    check(r.ok === false && !!r.error, `坏文件「${label}」：报错`, r);
    check(x.id === baseline.id && x.clips.length === baseline.clips.length && x.name === baseline.name, `坏文件「${label}」：当前项目原样，没有被空项目顶掉`, [x.id, x.clips.length]);
    check(x.goneDialog === null, `坏文件「${label}」：不转成本地项目`);
  }
  // .procp 包截断
  const procp = await page.evaluate(async (t) => {
    const { writeZip, loadProcpFile } = await import('/src/editor/io/procp.ts');
    const { getState } = await import('/src/store/project.ts');
    const zip = await writeZip([{ name: 'project.proc', blob: new Blob([t]) }]);
    const cut = zip.slice(0, Math.floor(zip.size / 2));
    const before = getState().project.id; let error = null;
    try { await loadProcpFile(cut); } catch (e) { error = String(e?.message || e); }
    return { error, same: getState().project.id === before };
  }, good);
  cells.broken['.procp 截断'] = procp.error;
  check(!!procp.error && procp.same, '坏文件「.procp 截断」：报错，当前项目原样', procp);

  check(trust.served >= 1 && !trust.error, '信任表是探针在浏览器里拦截换上的（产品代码里没有注入口）', trust);
  check(!events.some((e) => e.type === 'pageerror'), '页面没有报错', events);
  out.docHits = docHits.length;
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  await browser?.close().catch(() => {});
  server?.stop();
  await new Promise((r) => (docServer ? docServer.close(() => r()) : r()));
  try { ledger?.close(); } catch { /* 已关 */ }
  if (!KEEP && fails.length === 0 && !args.includes('--out')) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}
out.cells = cells; out.fails = fails; out.ok = fails.length === 0;
void fsSync;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
