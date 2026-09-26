/**
 * 卡片源码同步的端到端探针(C6.6 设计稿 `docs/plan/c66-design.md` 第 5 节、验收 T8 前半):
 * 两个编辑器实例加入同一个共享项目(本机托管组合 `server/hosted/main.mjs`,代替阿里云),A 改卡,B 看到新代码生效。
 *
 * 用法(在仓库根或 worktree 根):
 *   node scripts/probes/card-sync-probe.mjs [--doc-port 8790] [--asset-port 8791] [--a-port 5580] [--b-port 5583] [--out <截图目录>] [--keep-temp]
 *
 * 做什么:
 *   1. 在临时目录起托管组合(文档服务 --doc-port、素材服务 --asset-port,只绑 127.0.0.1);
 *   2. 在本仓库根起两个编辑器(vite,端口各占 +1、+2 当舞台端口),各有自己的卡片改动层(PROMPTCUT_CARD_OVERRIDES,临时目录)
 *      和设备号;两者共用仓库里的底版,所以「B 装上新版」只能是写进 B 的改动层,仓库里的原卡不动;
 *   3. 写一张探针用的用户卡(底版,画面上写着记号 v1),A 的项目里放一个它的片段;经托管端建一个共享项目,
 *      A 以创建者、B 以成员进入(syncManager.enterShared,和「打开共享项目」对话框同一条路);
 *   4. A 经 `/api/cards/edit`(edit_card 的服务端)把记号改成 v2;
 *   5. 计时并核对 B 这一侧:
 *      - installMs:B 的 `/api/cards/source` 读到 v2(B 的改动层里装上了);
 *      - hmrMs:B 页面注册表里这张卡的源码是 v2(热更新落地);
 *      - remeasureMs:B 页面这个片段的身份键(cardCostKey,带源码版本)变了,且探针为这张卡重测(进度里出现它,或成本表里出现新键的记录);
 *      - stageMs:B 的舞台(iframe)里画出了 v2 记号(尽力而为,拿不到记 null);
 *      - 托管端内容库里这张卡的 cardRev 与正文;底版文件仍是 v1,A、B 的改动层都是 v2;
 *   6. 收尾:只结束自己起的进程树(两个编辑器、托管组合),删掉探针卡的底版、它在 .pc-work/card-history 的旧版、
 *      还原 src/cards/user/_scopes.json;临时目录缺省删掉(--keep-temp 留着)。
 *
 * 输出:过程写 stderr;stdout 只有最后一行 JSON:
 *   { ok, installMs, hmrMs, remeasureMs, stageMs, cardRev, ..., fails: [] }。ok 要求 installMs ≤ 5000 且各项核对通过。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildAuthProtocols } from '../../server/auth/client.mjs';
import { createSharedProject, wsBaseOf } from '../../server/auth/route.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DOC_PORT = Number(arg('--doc-port', '8790'));
const ASSET_PORT = Number(arg('--asset-port', '8791'));
const A_PORT = Number(arg('--a-port', '5580'));
const B_PORT = Number(arg('--b-port', '5583'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'card-sync-probe')));
fs.mkdirSync(OUT, { recursive: true });

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(100);
  }
}

const RUN = Date.now().toString(36);
const CARD_ID = `cs-probe-${RUN}`;
const CARD_REL = `src/cards/user/${CARD_ID}.tsx`;
const CARD_ABS = path.join(ROOT, CARD_REL);
const MARK = (v) => `CS-PROBE-${RUN}-${v}`;
const cardSource = (v) => `import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 72, color: "#fff", background: "#224" }}>{"${MARK(v)}"} {params.text}</div>;
}
export const csProbe: CardDef<Params> = {
  id: "${CARD_ID}", name: "同步探针", description: "card-sync-probe", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-card-sync-probe-'));
const SCOPES = path.join(ROOT, 'src', 'cards', 'user', '_scopes.json');
const scopesBefore = fs.existsSync(SCOPES) ? fs.readFileSync(SCOPES) : null;
const procs = [];
const fails = [];
const navigations = [];
const res = { runId: RUN, cardId: CARD_ID, docPort: DOC_PORT, ports: { a: A_PORT, b: B_PORT } };

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
  const log = [];
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const p = { name, child, log };
  procs.push(p);
  say('spawn', { name, pid: child.pid });
  return p;
}

async function stopAll() {
  for (const p of procs.reverse()) {
    const c = p.child;
    if (!c.pid || c.exitCode !== null) continue;
    const exited = new Promise((r) => c.once('exit', r));
    // 编辑器还拉着预渲染进程和 Chrome:连进程树一起结束(只结束自己起的这几棵)
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
    say('stopped', { name: p.name, pid: c.pid });
  }
}

async function startEditor(tag, port) {
  const overrides = path.join(TMP, tag, 'card-overrides');
  fs.mkdirSync(overrides, { recursive: true });
  const p = start(`editor-${tag}`, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    PROMPTCUT_PUSH: '0',
    PROMPTCUT_LAN_HOST: '',
    PROMPTCUT_CARD_OVERRIDES: overrides,
    PROMPTCUT_DEVICE_ID: `cardsync-${tag}-${RUN}`.padEnd(16, '0'),
    PROMPTCUT_DEVICE_NAME: `card-sync-probe-${tag}`,
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (p.child.exitCode !== null) throw new Error(`编辑器 ${tag} 退出了:${p.log.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, `编辑器 ${tag} 起来`);
  return { tag, origin, overrides, proc: p };
}

const P = (page, fn, ...args) => page.evaluate(fn, ...args);

async function openEditor(browser, ed) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => say('pageerror', { tag: ed.tag, message: String(e?.message ?? e).slice(0, 300) }));
  page.on('dialog', (d) => void d.dismiss());
  // 主框架整页导航(刷新)记下来:卡换代码时页面应当热更新,不该整页刷新(刷新会离开共享项目)
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push({ tag: ed.tag, at: Date.now(), url: f.url() }); });
  await page.goto(`${ed.origin}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => P(page, () => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 120_000, `${ed.tag} 页面同步接上`);
  // 打开项目时的卡片测量遮罩:等它退下
  await waitFor(() => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 300_000, `${ed.tag} 测量遮罩退下`).catch(() => null);
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  return page;
}

const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());

/** 托管端内容库里这张卡:凭创建者身份另开一条连接 content.get */
async function hostedCard(base, projectId, cred) {
  const protocols = await buildAuthProtocols({
    base, projectId, username: cred.username, as: cred.as, password: cred.password, role: 'page',
    deviceId: `cardsync-reader-${RUN}`.padEnd(16, '0'), deviceName: 'card-sync-probe-reader',
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBaseOf(base), protocols);
    const timer = setTimeout(() => { reject(new Error('托管端 content.get 超时')); ws.close(); }, 10_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'content.get', kind: 'card-source', key: CARD_REL, reqId: 'g1' })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.reqId !== 'g1') return;
      clearTimeout(timer);
      resolve(m);
      ws.close();
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连不上托管端')); });
  });
}

/**
 * 页面里:这张卡的源码(注册表)、片段的身份键、测量遮罩在不在。
 * 注册表(kernel/registry.ts)不在卡片的热更新链上,热更新后仍是同一个实例、内容是新的;身份键用 costIdentity 按注册表里的
 * 源码现算(清掉它的记忆化)。探针模块在热更新链上会被重跑,evaluate 里 import 到的是旧实例,所以不读它的进度,看遮罩。
 */
const pageCardState = (page, cardId, clipId) => P(page, async (cardId, clipId) => {
  const R = await import('/src/kernel/registry.ts');
  const I = await import('/src/editor/costIdentity.ts');
  const S = await import('/src/store/project.ts');
  const u = R.userCardSources();
  const file = u.fileOf[cardId];
  const src = file ? u.files[file] ?? null : null;
  I.resetClipIdentityCache();
  const key = I.clipIdentityOf(S.getState().project).identityKeys[clipId] ?? null;
  const gate = document.querySelector('[data-pc="probe-gate"]')?.innerText?.replace(/s+/g, ' ') ?? null;
  return { src, key, gate };
}, cardId, clipId);

/** 舞台 iframe 里有没有画出这段文字 */
async function stageHas(page, text) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      if (await f.evaluate((t) => document.body?.innerText?.includes(t) ?? false, text)) return f.url();
    } catch { /* 跨源或正在导航的 frame 取不到就跳过 */ }
  }
  return null;
}

let browser = null;
try {
  // ---------- 1. 托管组合
  const hostedDir = path.join(TMP, 'hosted');
  fs.mkdirSync(hostedDir, { recursive: true });
  const hosted = start('hosted', [path.join(ROOT, 'server', 'hosted', 'main.mjs')], {
    PROMPTCUT_DATA_DIR: hostedDir,
    PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT),
    PROMPTCUT_ASSET_PORT: String(ASSET_PORT),
    PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
  });
  const hostedUrl = `http://127.0.0.1:${DOC_PORT}`;
  await waitFor(async () => {
    if (hosted.child.exitCode !== null) throw new Error(`托管组合退出了:${hosted.log.join('').slice(-600)}`);
    return fetch(`${hostedUrl}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  }, 30_000, '托管组合起来');
  say('hosted.ready', { hostedUrl });

  // ---------- 2. 探针卡(底版)与两个编辑器
  fs.writeFileSync(CARD_ABS, cardSource('v1'));
  const A = await startEditor('a', A_PORT);
  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  const pageA = await openEditor(browser, A);
  // A 先起、页面打开之后再起 B:两个实例共用仓库根,依赖预构建错开
  const B = await startEditor('b', B_PORT);
  const pageB = await openEditor(browser, B);
  say('editors.ready', { a: A.origin, b: B.origin });

  // ---------- 3. A 的项目里放一个探针卡的片段,建共享项目,A、B 进入
  await waitFor(() => P(pageA, async (id) => (await import('/src/kernel/registry.ts')).getCard(id) != null, CARD_ID), 30_000, 'A 页面认出探针卡');
  const clipId = await P(pageA, async (id) => {
    const S = await import('/src/store/project.ts');
    const c = S.actions.addCardClip(id, 0, { duration: 5 });
    S.actions.seek(1);
    return c?.id ?? null;
  }, CARD_ID);
  if (!clipId) throw new Error('A 没放上探针卡的片段');
  res.clipId = clipId;

  const name = `card-sync-${RUN}`;
  const creatorPw = `cpw-${randomBytes(6).toString('hex')}`;
  const projectPw = `ppw-${randomBytes(6).toString('hex')}`;
  const shared = await createSharedProject({
    where: 'hosted', hostedUrl, name, mode: 'free', creator: { username: 'alice', password: creatorPw }, password: projectPw,
    kdf: { alg: 'pbkdf2-sha256', iter: 100000 },
  });
  res.projectId = shared.projectId;
  const candidate = { where: 'hosted', base: shared.base, projectId: shared.projectId, name: shared.name, mode: shared.mode };
  const enter = (page, cred) => P(page, async (candidate, cred) => {
    const M = await import('/src/editor/sync/syncManager.ts');
    return M.enterShared(candidate, cred);
  }, candidate, cred);
  const ea = await enter(pageA, { as: 'creator', username: 'alice', password: creatorPw });
  if (!ea?.ok) throw new Error(`A 进不去共享项目:${JSON.stringify(ea)}`);
  // A 把项目带进共享项目时,项目用到的探针卡(用户卡)传上内容库
  const aPushed = await waitFor(async () => {
    const s = await getJson(`${A.origin}/api/cards/sync/status`);
    return s.projectId === shared.projectId && s.connected && s.records?.[CARD_REL]?.rev >= 1 ? s : null;
  }, 20_000, 'A 把探针卡传上内容库');
  say('a.pushed', { rev: aPushed.records[CARD_REL].rev, spaceId: aPushed.spaceId });

  const eb = await enter(pageB, { as: 'member', username: 'bob', password: projectPw });
  if (!eb?.ok) throw new Error(`B 进不去共享项目:${JSON.stringify(eb)}`);
  await waitFor(() => P(pageB, async (clipId) => (await import('/src/store/project.ts')).getState().project.tracks.some((t) => t.clips.some((c) => c.id === clipId)), clipId), 20_000, 'B 看到探针卡的片段');
  await P(pageB, async () => (await import('/src/store/project.ts')).actions.seek(1));
  const bBound = await waitFor(async () => {
    const s = await getJson(`${B.origin}/api/cards/sync/status`);
    return s.projectId === shared.projectId && s.connected && s.records?.[CARD_REL] ? s : null;
  }, 20_000, 'B 对账到探针卡');
  say('b.bound', { record: bBound.records[CARD_REL] });
  // 进入共享项目后的第一轮测量(挡界面的那一轮)先测完,再改卡
  await waitFor(() => P(pageB, () => !document.querySelector('[data-pc="probe-gate"]')), 300_000, 'B 测量遮罩退下').catch(() => null);
  await sleep(1500);
  const before = await pageCardState(pageB, CARD_ID, clipId);
  res.keyBefore = before.key;
  if (!before.src?.includes(MARK('v1'))) fails.push('b-page-not-v1-before');
  const stageBefore = await stageHas(pageB, MARK('v1'));
  res.stageV1 = !!stageBefore;
  await pageB.screenshot({ path: path.join(OUT, `${RUN}-b-1-before.png`) });

  // ---------- 4. A 改卡(edit_card 的服务端)
  const t0 = Date.now();
  const edit = await fetch(`${A.origin}/api/cards/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: CARD_ID, find: MARK('v1'), replace: MARK('v2') }),
  }).then((r) => r.json());
  if (!edit.ok) throw new Error(`A 改卡失败:${edit.error}`);
  res.aEditBackup = edit.backup ?? null; // B2:用户卡也备份
  if (!edit.backup) fails.push('a-edit-no-backup(B2)');
  say('a.edited', { backup: edit.backup });

  // ---------- 5. B 这一侧
  const installed = await waitFor(async () => {
    const s = await getJson(`${B.origin}/api/cards/source?id=${CARD_ID}`);
    return s.ok && s.source.includes(MARK('v2')) ? Date.now() : null;
  }, 15_000, 'B 装上新版').catch(() => null);
  res.installMs = installed ? installed - t0 : null;
  const hmr = await waitFor(async () => {
    const s = await pageCardState(pageB, CARD_ID, clipId);
    return s.src?.includes(MARK('v2')) ? Date.now() : null;
  }, 15_000, 'B 页面热更新').catch(() => null);
  res.hmrMs = hmr ? hmr - t0 : null;
  // 重测:身份键(带源码版本)变了,且按现有规则重排了一轮——测量遮罩出现过,或成本表里有了新键的记录(测完)
  let remeasure = null;
  let recordedAt = null;
  let keyAfter = null;
  let gateSeen = null;
  const tr = Date.now();
  while (Date.now() - tr < 60_000) {
    const s = await pageCardState(pageB, CARD_ID, clipId).catch(() => null);
    if (s) {
      keyAfter = s.key;
      if (s.gate && !gateSeen) gateSeen = { at: Date.now(), text: s.gate };
      if (s.key && s.key !== res.keyBefore) {
        if (!remeasure && gateSeen) remeasure = { at: gateSeen.at, via: 'gate' };
        const costs = await getJson(`${B.origin}/api/data/costs`).catch(() => null);
        if ((costs?.costs ?? []).some((r) => r.identityKey === s.key)) { recordedAt = Date.now(); if (!remeasure) remeasure = { at: recordedAt, via: 'record' }; break; }
      }
    }
    await sleep(100);
  }
  res.keyAfter = keyAfter;
  res.remeasureMs = remeasure ? remeasure.at - t0 : null;
  res.remeasureVia = remeasure?.via ?? null;
  res.gate = gateSeen ? { ms: gateSeen.at - t0, text: gateSeen.text } : null;
  res.newCostRecordMs = recordedAt ? recordedAt - t0 : null;
  const stageAt = await waitFor(async () => ((await stageHas(pageB, MARK('v2'))) ? Date.now() : null), 15_000, 'B 舞台画出 v2').catch(() => null);
  res.stageMs = stageAt ? stageAt - t0 : null;
  await pageB.screenshot({ path: path.join(OUT, `${RUN}-b-2-after.png`) });
  res.navigationsAfterEdit = navigations.filter((n) => n.at >= t0).map((n) => ({ tag: n.tag, ms: n.at - t0 }));
  res.bKindAfter = await P(pageB, () => window.__pcSyncTest?.view().kind ?? null).catch(() => null);
  res.shots = [`${RUN}-b-1-before.png`, `${RUN}-b-2-after.png`].map((f) => path.join(OUT, f));

  // 服务端与文件核对
  const bStatus = await getJson(`${B.origin}/api/cards/sync/status`);
  const aStatus = await getJson(`${A.origin}/api/cards/sync/status`);
  res.bRecord = bStatus.records?.[CARD_REL] ?? null;
  res.aRecord = aStatus.records?.[CARD_REL] ?? null;
  res.bNotices = (bStatus.notices ?? []).map((n) => ({ type: n.type, key: n.key, rev: n.rev, by: n.actor?.userId ?? null, backup: n.backup ?? null }));
  const host = await hostedCard(shared.base, shared.projectId, { as: 'creator', username: 'alice', password: creatorPw });
  res.cardRev = host.rev ?? null;
  res.hostedHasV2 = typeof host.body === 'string' && host.body.includes(MARK('v2'));
  res.baseStillV1 = fs.readFileSync(CARD_ABS, 'utf8').includes(MARK('v1'));
  const overOf = (ed) => { try { return fs.readFileSync(path.join(ed.overrides, CARD_REL), 'utf8'); } catch { return null; } };
  res.aOverrideV2 = !!overOf(A)?.includes(MARK('v2'));
  res.bOverrideV2 = !!overOf(B)?.includes(MARK('v2'));

  if (!(res.installMs !== null && res.installMs <= 5000)) fails.push(`installMs=${res.installMs}`);
  if (res.hmrMs === null) fails.push('b-page-no-hmr');
  if (res.remeasureMs === null) fails.push('b-no-remeasure');
  if (!(res.keyAfter && res.keyAfter !== res.keyBefore)) fails.push('b-identity-key-unchanged');
  if (!res.hostedHasV2) fails.push('hosted-not-v2');
  if (!(res.cardRev >= 2)) fails.push(`cardRev=${res.cardRev}`);
  if (!res.baseStillV1) fails.push('base-touched');
  if (!res.aOverrideV2) fails.push('a-override-not-v2');
  if (res.navigationsAfterEdit.length) fails.push('page-reloaded');
  if (res.bKindAfter !== 'shared') fails.push(`b-left-shared(${res.bKindAfter})`);
  if (!res.bOverrideV2) fails.push('b-override-not-v2');
  if (res.bRecord?.rev !== res.cardRev) fails.push('b-record-rev');
  if (!res.bNotices.some((n) => n.type === 'installed' && n.rev === res.cardRev)) fails.push('b-no-installed-notice');
  if (res.bNotices.some((n) => n.type === 'overwritten')) fails.push('b-unexpected-overwritten');
} catch (err) {
  fails.push(`error:${String(err?.message ?? err)}`);
  say('error', { message: String(err?.stack ?? err).slice(0, 1200) });
  for (const p of procs) if (p.child.exitCode !== null) say('proc.exited', { name: p.name, code: p.child.exitCode, tail: p.log.join('').slice(-800) });
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  await stopAll();
  // 探针卡的底版、card-history 里的旧版、归属表
  try { fs.rmSync(CARD_ABS, { force: true }); } catch { /* 没有就算了 */ }
  try {
    const hist = path.join(ROOT, '.pc-work', 'card-history');
    for (const f of fs.existsSync(hist) ? fs.readdirSync(hist) : []) if (f.startsWith(`${CARD_ID}.`)) fs.rmSync(path.join(hist, f), { force: true });
  } catch { /* 清不掉不影响结论 */ }
  try {
    if (scopesBefore === null) fs.rmSync(SCOPES, { force: true });
    else fs.writeFileSync(SCOPES, scopesBefore);
  } catch { /* 同上 */ }
  if (!argv.includes('--keep-temp')) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶有句柄没放 */ } }
  else res.temp = TMP;
  res.fails = fails;
  res.ok = fails.length === 0;
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
