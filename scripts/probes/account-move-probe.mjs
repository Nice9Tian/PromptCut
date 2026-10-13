/**
 * 账号办法的「搬到云端」端到端探针(桌面版;报告 `docs/reports/AGENT-v18-move.md`)。
 *
 * 真的服务组合:账号后端、文档服务、独立的素材服务进程、TLS 入口(`server/test/fixtures/cloud-queue-user-path.mjs`,两个账号);
 * 两个桌面编辑器进程(本工作区起的开发服务器,各有自己的数据目录、卡片改动层、设备号);无头 Chrome 经界面真点。
 *
 *   node scripts/probes/account-move-probe.mjs [--only local,room] [--keep-temp]
 *   (要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,同账号那几条测试)
 *
 * 端口只用 28950～28999:夹具 28950～28956、云端 Agent 入口 28957;甲的编辑器 28960(舞台 +1、+2)、乙的编辑器 28965(+1、+2)。
 *
 * **不是真的桌面外壳**:页面里的 `window.__TAURI__.core.invoke('account_bridge', …)` 由探针在 Node 一侧照外壳的接口代答
 * (`desktop/src-tauri/src/account_vault.rs`:configuration / login / recover / request,同样的路径白名单与 1 MiB 上限);
 * 恢复凭证与令牌只在探针的内存里。除此之外页面走的都是产品代码:设置对话框、登录表单、「确定」「搬到云端」按钮。
 *
 * 两遍:
 *   本地项目   甲没登录,开一个本地项目(一张只在甲的改动层里的用户卡、一段视频、一段卡片声音、大于 1 MiB 的正文),存成草稿;
 *              设置里勾多用户协作、选云端、点确定 → 提示登录 → 在设置里登录 → 接着搬。头一次云端中途不可用(取票据一直回 503):
 *              失败、本机原样可用;恢复后再点确定:接着用同一个云端项目搬成。乙(另一个账号、另一台编辑器)凭项目链接加入,
 *              看到同样的内容、卡片画得出来、两档素材和卡片声音的字节都取得到。
 *   协作房间   甲(已登录)开一个本机协作房间(同样的内容),设置里点「搬到云端」→ 确认框 → 头一次新建的回包丢了(断连接):
 *              失败、本机房间逐项不变(记录、能编辑能保存、成员还能连);再点一次:同一个请求号、同一个云端项目,搬成;
 *              本机房间记录没了、旧凭证连不进去;乙凭新链接加入看到同样的内容。
 * 每遍截图:搬之前、进行中、失败的提示、成功后的提示(`docs/reports/assets/v18-move/`)。
 * 输出:过程写 stderr;stdout 最后一行是一行 JSON(`fails` 为空才算过)。不打印密码、令牌、票据。
 */
import '../lib/no-user-dirs.mjs';
import { srcUrl } from '../../src/testing/registerTs.mjs';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WS from 'ws';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';
import { buildAuthProtocols } from '../../server/auth/client.mjs';

const M = await import(srcUrl('editor/sync/accountMove.ts'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs', 'reports', 'assets', 'v18-move')));
const ONLY = arg('--only', 'local,room').split(',');
const KEEP = argv.includes('--keep-temp');
const FIXTURE_PORTS = [28950, 28951, 28952, 28953, 28954, 28955, 28956], AGENT_PORT = 28957;
const A_PORT = 28960, B_PORT = 28965;
fs.mkdirSync(OUT, { recursive: true });

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields }).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(150);
  }
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const secret = () => randomBytes(18).toString('base64url');

const RUN = Date.now().toString(36);
const CARD_ID = `move-probe-${RUN}`;
const CARD_REL = `src/cards/user/${CARD_ID}.tsx`;
const MARK = `MOVE-${RUN}`.toUpperCase();
const cardSource = `import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 220, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 72, color: "#fff", background: "#224" }}>{"${MARK}"} {params.text}</div>;
}
export const ${CARD_ID.replace(/[^a-zA-Z0-9]/g, '_')}: CardDef<Params> = {
  id: "${CARD_ID}", name: "搬到云端探针", description: "account-move-probe", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-move-'));
const procs = [];
const fails = [];
const res = { runId: RUN, cardId: CARD_ID, ports: { fixture: FIXTURE_PORTS, agent: AGENT_PORT, a: A_PORT, b: B_PORT }, shots: [], timings: {} };
let fixture = null, browser = null, ca = null, ORIGIN = '';
const check = (ok, name, detail) => { if (!ok) { fails.push(detail === undefined ? name : `${name}(${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); say('FAIL', { name, detail }); } else say('ok', { name }); return !!ok; };

/* ---------------- 云端一侧收到的请求(方法、路径、状态码) ---------------- */
const cloudLog = [];
{
  const original = https.createServer;
  https.createServer = (...args) => {
    const server = original(...args);
    server.prependListener('request', (req, r) => {
      const entry = { method: req.method, path: String(req.url).split('?')[0] };
      r.once('finish', () => { entry.status = r.statusCode; cloudLog.push(entry); });
    });
    return server;
  };
}
const cloudSince = (from, pattern) => cloudLog.slice(from).filter((e) => pattern.test(e.path));

/* ---------------- 进程 ---------------- */

function viteBin() {
  const main = createRequire(import.meta.url).resolve('vite/package.json');
  return path.join(path.dirname(main), 'bin', 'vite.js');
}
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const log = [];
  const keep = (c) => { log.push(c.toString()); if (log.length > 6000) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const p = { name, child, log, text: () => log.join('') };
  procs.push(p);
  say('spawn', { name, pid: child.pid });
  return p;
}
async function stopAll() {
  for (const p of procs.reverse()) {
    const c = p.child;
    if (!c.pid || c.exitCode !== null) continue;
    const exited = new Promise((r) => c.once('exit', r));
    // 编辑器还拉着预渲染进程和它的 Chrome:连进程树一起结束(只结束自己起的这几棵)
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
    say('stopped', { name: p.name, pid: c.pid });
  }
}
async function startEditor(tag, port) {
  const dataDir = path.join(TMP, tag);
  const overrides = path.join(dataDir, 'card-overrides');
  for (const d of [overrides, path.join(dataDir, 'vite-cache')]) fs.mkdirSync(d, { recursive: true });
  const proc = start(`editor-${tag}`, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], reopenEditorEnv(dataDir, {
    PROMPTCUT_VITE_CACHE_DIR: path.join(dataDir, 'vite-cache'),
    PROMPTCUT_CARD_OVERRIDES: overrides,
    PROMPTCUT_DEVICE_ID: `move-${tag}-${RUN}`.padEnd(16, '0'),
    PROMPTCUT_DEVICE_NAME: `account-move-${tag}`,
    PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_NODE_PROFILE: 'user', PROMPTCUT_SHARED_CONFIG: '', PROMPTCUT_QUEUE_NODE: '0',
    // 编辑器进程自己连夹具的入口(自签根证书);真环境里是正式证书,不需要这一项
    NODE_EXTRA_CA_CERTS: fixture.caFile,
    // 账号项目的卡片同步只许连账号云端的文档服务;探针的账号云端是夹具,显式放行它的源
    PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: ORIGIN,
  }));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (proc.child.exitCode !== null) throw new Error(`编辑器 ${tag} 退出了:${proc.text().slice(-600)}`);
    return fetch(`${base}/api/docservice/device`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  }, 240_000, `编辑器 ${tag} 起来`);
  return { tag, base, dataDir, overrides, proc };
}

/* ---------------- 夹具入口上的请求(Node 一侧)与账号桥的替身 ---------------- */

function edge(route, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(new URL(route, ORIGIN), { method: data === null ? 'GET' : 'POST', ca, timeout: 20_000,
      headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 不是 JSON */ } resolve({ status: r.statusCode, body: json }); });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end(data ?? undefined);
  });
}
/**
 * 桌面外壳账号桥的替身。`state.fault(path)` 让某个请求出故障:
 * 数字 = 云端回这个状态码(请求没发出去);'drop-response' = 请求到了云端、回包丢了(断连接)。
 */
function nativeBridge(state) {
  const ROUTES = ['/hosted/shared/account/create', '/hosted/shared/account/join', '/hosted/shared/account/session', '/hosted/shared/account/admin', '/hosted/shared/account/members'];
  const out = (r) => (r.status >= 200 && r.status < 300 && r.body?.ok ? r.body : { ok: false, status: r.status, code: r.body?.code ?? 'cloud-request-failed' });
  return async (operation, args = {}) => {
    try {
      if (operation === 'configuration') return { ok: true, origin: ORIGIN };
      if (operation === 'login') {
        const v = out(await edge('/api/account/editor/login', { body: args }));
        if (v.ok) { state.recovery = v.recoveryToken; state.deviceId = args.deviceId; state.token = v.accessToken; state.accountId = v.account?.id; }
        return v;
      }
      if (operation === 'recover') {
        if (!state.recovery) return null;
        const v = out(await edge('/api/account/editor/recover', { body: { recoveryToken: state.recovery, deviceId: state.deviceId, requestId: randomUUID() } }));
        if (v.ok) { state.recovery = v.recoveryToken; state.token = v.accessToken; }
        return v;
      }
      if (operation === 'request') {
        if ((!ROUTES.includes(args.path) && args.path !== '/api/account/cloud-agent-consent') || !args.accessToken) throw new Error('bad-path');
        if (Buffer.byteLength(JSON.stringify({ operation, args })) > 1024 * 1024) return { ok: false, status: 503, code: 'desktop-account-request-too-large' };
        state.requests.push({ path: args.path, bytes: Buffer.byteLength(JSON.stringify(args.body ?? null)), requestId: args.body?.requestId ?? null });
        const fault = state.fault?.(args.path);
        if (typeof fault === 'number') return { ok: false, status: fault, code: 'authority-unavailable' };
        const r = await edge(args.path, { body: args.body, token: args.accessToken });
        if (fault === 'drop-response') return { ok: false, status: 0, code: 'network' };
        return out(r);
      }
      throw new Error('bad-operation');
    } catch { return { ok: false, status: 503, code: 'desktop-account-bridge' }; }
  };
}
class CaWebSocket extends WS { constructor(url, protocols) { super(url, protocols, { ca }); } }
const sessionOf = (state, projectId) => edge('/hosted/shared/account/session', { body: { projectId, deviceId: state.deviceId, requestId: randomUUID() }, token: state.token });
/** 凭某个账号的登录,从云端把项目内容读回来(另开一条文档连接) */
async function cloudContent(state, projectId) {
  const r = await M.readProjectContent({ url: `${ORIGIN.replace(/^https:/, 'wss:')}/hosted/`, WebSocketImpl: CaWebSocket,
    ticket: async () => {
      // 先用手里的访问令牌(页面自己会续);过期了再凭恢复凭证续一次
      let s = await sessionOf(state, projectId);
      if (s.status === 401) { await nativeBridge(state)('recover'); s = await sessionOf(state, projectId); }
      if (s.status !== 200) throw Object.assign(new Error(s.body?.code), { status: s.status, code: s.body?.code });
      return s.body.connectionTicket;
    } }, projectId, { tracks: [] });
  return r.project;
}
/** 云端文档服务里有内容的项目号 */
function cloudProjects() {
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === 'tenants') return path.join(dir, e.name);
      if (depth > 0) { const hit = walk(path.join(dir, e.name), depth - 1); if (hit) return hit; }
    }
    return null;
  };
  const tenants = walk(path.join(fixture.fixtureDir, 'doc'), 2);
  return tenants ? fs.readdirSync(tenants).filter((n) => /^sp_[a-z2-7]{26}$/.test(n)).sort() : [];
}

/* ---------------- 页面 ---------------- */

const P = (page, fn, ...args) => page.evaluate(fn, ...args);
const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());

async function openDesktop(ed, state, label) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.dialogs = [];
  page.on('pageerror', (e) => say('pageerror', { label, message: String(e?.message ?? e).slice(0, 300) }));
  page.on('dialog', (d) => { page.dialogs.push({ type: d.type(), message: d.message() }); void d.accept(); });
  page.on('console', (m) => { if (/\[(collab|sync)\]/.test(m.text())) say('console', { label, text: m.text().slice(0, 240) }); });
  page.setDefaultNavigationTimeout(300_000);
  // 本机协作恢复接口的失败(哪个接口、什么原因):探针自己排查用
  page.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/collaboration/')) void r.json().then((b) => { if (r.status() >= 400 || b?.ok === false) say('collaboration.fail', { label, path: u.pathname, status: r.status(), error: b?.error ?? null }); }, (e) => say('collaboration.fail', { label, path: u.pathname, status: r.status(), unreadable: String(e?.message ?? e).slice(0, 80) })); });
  await page.exposeFunction('__probeNative', nativeBridge(state));
  // 桌面外壳的全局对象:只给账号桥这一个命令(别的命令回 null,等于没有外壳)
  await page.evaluateOnNewDocument(() => {
    window.__TAURI__ = { core: { invoke: async (command, payload) => (command === 'account_bridge' ? window.__probeNative(payload?.operation, payload?.args ?? {}) : null) } };
    window.__pcMoveTest = { contentTimeoutMs: 6000 };
  });
  await page.goto(`${ed.base}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => P(page, () => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 240_000, `${label} 页面接上本机文档服务`);
  await waitFor(() => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 300_000, `${label} 测量遮罩退下`).catch(() => null);
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog button')) if (b.textContent?.trim() === '关闭') b.click(); });
  return page;
}
const viewOf = (page) => P(page, () => { const v = window.__pcSyncTest.view();
  return { kind: v.kind, status: v.status, blocked: v.blocked, reopenState: v.reopenState,
    shared: v.shared && { projectId: v.shared.projectId, where: v.shared.where, accountId: v.shared.accountId ?? null, creator: v.shared.creator, name: v.shared.name, base: v.shared.base },
    association: v.association && { roomId: v.association.roomId, where: v.association.where, service: v.association.service } }; });
const toastsOf = (page) => P(page, () => window.__pcSyncTest.view().toasts.map((t) => t.text));
const statusText = (page) => P(page, () => document.querySelector('[data-pc="collab-status"]')?.textContent ?? null);
const contentOf = (page) => P(page, async () => JSON.stringify((await import('/src/store/project.ts')).getState().project));
async function openSettings(page) { await P(page, () => window.dispatchEvent(new Event('pc-open-project-settings'))); await page.waitForSelector('[data-pc="collab-section"]', { timeout: 15_000 }); }
async function closeSettings(page) { await P(page, () => [...document.querySelectorAll('.pc-dialog button')].find((b) => b.textContent?.trim() === '取消')?.click()); await sleep(200); }
const clickConfirm = (page) => P(page, () => [...document.querySelectorAll('.pc-dialog-foot button')].find((b) => b.textContent?.trim() === '确定').click());
async function shot(page, name) {
  await waitFor(() => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 30_000, '测量遮罩退下').catch(() => null);
  if (await P(page, () => !!document.querySelector('.ais-dialog')).catch(() => false)) throw new Error('AI 助手设置对话框还开着,不截图');
  // 截图里不留项目密码、邀请链接、二维码
  await P(page, () => { for (const el of document.querySelectorAll('[data-pc="collab-project-password"] code, [data-pc="collab-invite-link"], [data-pc="collab-qr"]')) el.replaceChildren(document.createTextNode('[已遮住]')); });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  res.shots.push(path.relative(ROOT, file).split(path.sep).join('/'));
}
async function stageHas(page, text) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try { if (await f.evaluate((t) => document.body?.innerText?.includes(t) ?? false, text)) return f.url(); } catch { /* 正在导航的 frame 取不到就跳过 */ }
  }
  return null;
}
const overrideOf = (ed, rel) => { try { return fs.readFileSync(path.join(ed.overrides, rel), 'utf8'); } catch { return null; } };
const cardStatus = (ed) => getJson(`${ed.base}/api/cards/sync/status`);
const draftText = (ed, id) => fetch(`${ed.base}/api/projects/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.text() : null));

/** 在页面里搭一个项目:一张用户卡的片段、一段视频、一段卡片声音、大于 1 MiB 的正文(转写文本);回各样东西的号 */
async function buildProject(page, ed, name, videoB64) {
  const contentId = await P(page, async (name) => {
    const proc = await import('/src/editor/io/proc.ts');
    return proc.newProject(name).id;
  }, name);
  await waitFor(() => P(page, (id) => window.__pcSyncTest.docProjectId() === id && window.__pcSyncTest.view().status === 'online', contentId), 20_000, '本机项目接上');
  if (!overrideOf(ed, CARD_REL)) {
    const created = await postJson(`${ed.base}/api/cards/create`, { id: CARD_ID, source: cardSource, existingIds: [], projectId: contentId });
    if (!created.ok) throw new Error(`建卡失败:${created.error}`);
  }
  await waitFor(() => P(page, async (id) => (await import('/src/kernel/registry.ts')).getCard(id) != null, CARD_ID), 60_000, '页面认出新卡');
  const built = await P(page, async (cardId, b64, run) => {
    const S = await import('/src/store/project.ts');
    const io = await import('/src/editor/io/index.ts');
    const G = await import('/src/editor/io/cardAudioGeneration.ts');
    const clip = S.actions.addCardClip(cardId, 0, { duration: 5, params: { text: '搬到云端' } });
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    await io.importVideoFiles([new File([arr], `move-${run}.mp4`, { type: 'video/mp4' })]);
    for (let i = 0; i < 200 && S.getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const video = S.getState().project.media.find((m) => m.kind === 'video');
    if (video && !S.getState().project.tracks.some((t) => t.clips.some((c) => c.mediaId === video.id))) S.actions.addMediaClip(video.id, 0, { duration: 2 });
    // 卡片声音:一张带内嵌声音的内置卡,生成的 WAV 进本机素材服务、作为素材记在项目里
    let audio = null;
    try {
      const av = S.actions.addCardClip('av-pulse', 6, { duration: 2 });
      const r = await G.generateCardAudio(av.id);
      audio = S.getState().project.media.find((m) => m.id === r.mediaId)?.hash ?? null;
    } catch (e) { audio = { error: String(e?.message ?? e).slice(0, 160) }; }
    // 大正文:给视频挂一份很长的转写(真实项目里正文大多是它)
    const segments = [];
    for (let i = 0; i < 700; i++) segments.push({ start: i, end: i + 1, text: `${i}:` + '转写'.repeat(400) });
    if (video) S.actions.setMediaTranscript(video.id, { engine: 'probe', model: 'probe', createdAt: '2026-10-14T00:00:00.000Z', segments });
    S.actions.seek(1);
    return { clipId: clip?.id ?? null, videoId: video?.id ?? null, audio };
  }, CARD_ID, videoB64, RUN);
  // 等小尺寸生成出来(页面把它的哈希写回素材表)
  const tiers = await waitFor(() => P(page, async (id) => { const m = (await import('/src/store/project.ts')).getState().project.media.find((x) => x.id === id); return m?.tiers?.small && m?.tiers?.original ? m.tiers : null; }, built.videoId), 120_000, '视频的小尺寸生成出来').catch(() => null);
  await P(page, async () => (await import('/src/editor/sync/syncManager.ts')).whenSaved(10_000));
  const text = await contentOf(page);
  return { contentId, ...built, tiers, bytes: Buffer.byteLength(text), text };
}
/** 本机这一份现在还能不能改、能不能存(改一下再改回去,内容不变) */
const editAndSave = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  const sync = await import('/src/editor/sync/syncManager.ts');
  const before = S.getState().project.name;
  try {
    S.actions.setProjectMeta({ name: `${before}-改` }); await sync.whenSaved(5000);
    const changed = S.getState().project.name === `${before}-改`;
    S.actions.setProjectMeta({ name: before }); await sync.whenSaved(5000);
    return { ok: changed && S.getState().project.name === before, status: sync.getSyncView().status };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 120) }; }
});
/** 乙:登录(经账号桥的替身)、凭项目链接加入并进项目 */
async function joinByLink(page, account, link) {
  return P(page, async (origin, name, password, link) => {
    const C = await import('/src/account/client.ts');
    const Sync = await import('/src/editor/sync/syncManager.ts');
    const K = await import('/src/kernel/project.ts');
    const device = await Sync.ensureDevice();
    const client = window.__probeClient ?? C.createAccountClient({ online: false, origin, device, native: (operation, args) => window.__probeNative(operation, args ?? {}) });
    window.__probeClient = client;
    if (!client.account && !(await client.restore())) await client.login(name, password, false);
    const projectId = C.projectIdFromLink(link, origin);
    const first = await client.join(projectId, crypto.randomUUID());
    await Sync.enterAccountProject({ client, origin, projectId, name: '搬过来的项目', initial: K.createEmptyProject('搬过来的项目'), firstSession: first });
    return projectId;
  }, ORIGIN, account.name, account.password, link);
}
/** 乙凭自己的素材票据把一份素材取下来,回字节数和哈希对不对 */
const fetchAsset = (page, hash) => P(page, async (hash) => {
  const T = await import('/src/editor/media/assetTiers.ts');
  const ticket = await T.remoteAssetTicket();
  const r = await fetch(`${T.remoteAssetBase()}/media/${hash}?t=${encodeURIComponent(ticket ?? '')}`, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) return { status: r.status };
  const buf = await r.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { status: r.status, bytes: buf.byteLength, sameHash: digest === hash };
}, hash);

/** 乙那一头的核对:内容一样、卡片装上并画出来、素材两档与卡片声音取得到 */
async function verifyOnB(pageB, B, built, link, tag) {
  const projectId = await joinByLink(pageB, fixture.accounts[1], link);
  await waitFor(() => P(pageB, () => !!window.__pcSyncTest.view().shared?.accountId), 30_000, '乙进入云端项目');
  const bText = await waitFor(async () => { const t = await contentOf(pageB); return JSON.parse(t).media?.length ? t : null; }, 30_000, '乙拿到项目内容');
  check(M.sameContent(JSON.parse(bText), JSON.parse(built.text)), `${tag}-乙看到的项目内容与搬之前本机那一份逐字段相同`, { bytes: Buffer.byteLength(bText) });
  const installed = await waitFor(() => (overrideOf(B, CARD_REL)?.includes(MARK) ? true : null), 60_000, '乙的改动层里装上卡片源码').catch(() => null);
  check(!!installed && !fs.existsSync(path.join(ROOT, CARD_REL)), `${tag}-乙的桌面拿到用户卡的源码(改动层里;仓库里没有这个文件)`);
  await P(pageB, async () => (await import('/src/store/project.ts')).actions.seek(1));
  const drawn = await waitFor(() => stageHas(pageB, MARK), 120_000, '乙的舞台画出用户卡').catch(() => null);
  check(!!drawn, `${tag}-乙的舞台画出用户卡`);
  const assets = {};
  for (const [what, hash] of [['small', built.tiers?.small], ['original', built.tiers?.original], ['cardAudio', typeof built.audio === 'string' ? built.audio : null]]) {
    if (!hash) { assets[what] = null; continue; }
    assets[what] = await waitFor(async () => { const r = await fetchAsset(pageB, hash); return r.status === 200 ? r : null; }, 120_000, `乙取到 ${what}`).catch(async () => fetchAsset(pageB, hash));
  }
  check(assets.small?.sameHash === true && assets.original?.sameHash === true, `${tag}-乙凭自己的素材票据取到视频的小尺寸和原尺寸,字节哈希相符`, assets);
  check(assets.cardAudio?.sameHash === true, `${tag}-乙取到卡片声音的字节,哈希相符`, assets.cardAudio ?? built.audio);
  await sleep(1500);
  await shot(pageB, `${tag}-6-second-account`);
  return { projectId, assets };
}

/* ---------------- 本地项目搬上去 ---------------- */

async function scenarioLocal({ A, B, stateA, stateB, video }) {
  const out = {};
  const page = await openDesktop(A, stateA, '甲');
  const name = `搬到云端-本地-${RUN}`;
  const built = await buildProject(page, A, name, video);
  out.built = { contentId: built.contentId, bytes: built.bytes, tiers: !!built.tiers, audio: typeof built.audio === 'string' ? 'ok' : built.audio };
  check(built.bytes > 1024 * 1024, '本地-正文大于 1 MiB', built.bytes);
  check(!!built.tiers, '本地-视频两档都在(小尺寸已生成)');
  check(typeof built.audio === 'string', '本地-卡片声音已生成并记在项目里', built.audio);
  check(overrideOf(A, CARD_REL)?.includes(MARK) && !fs.existsSync(path.join(ROOT, CARD_REL)), '本地-用户卡只在甲的改动层里');
  // 存成草稿:之后核对「本机文件一个字都没改」
  const draftId = await P(page, async () => { const D = await import('/src/editor/io/drafts.ts'); const id = D.newDraftId(); D.setActiveDraftId(id); await D.saveDraft(id); return id; });
  const draftBefore = await draftText(A, draftId);
  const cloudBefore = cloudProjects();
  await waitFor(() => stageHas(page, MARK), 120_000, '甲的舞台画出用户卡').catch(() => null);

  // —— 界面:勾多用户协作、选云端、填云端地址
  await openSettings(page);
  await page.click('[data-pc="collab-toggle"]');
  await page.waitForSelector('[data-pc="collab-where-hosted"]');
  await page.click('[data-pc="collab-where-hosted"]');
  await page.waitForSelector('[data-pc="collab-hosted-url"]');
  await page.focus('[data-pc="collab-hosted-url"]');
  await page.$eval('[data-pc="collab-hosted-url"]', (el) => el.select());
  await page.keyboard.press('Backspace');
  await page.type('[data-pc="collab-hosted-url"]', `${ORIGIN}/hosted`);
  await page.waitForSelector('[data-pc="collab-account-intro"]', { timeout: 15_000 });
  await page.waitForSelector('[data-pc="collab-account-login"]', { timeout: 15_000 });
  out.introText = await P(page, () => document.querySelector('[data-pc="collab-account-intro"]').textContent);
  check(await P(page, () => !document.querySelector('#pc-collab-creator') && !document.querySelector('#pc-collab-cpw')), '本地-目标是账号云端时不显示创建者用户名和密码');
  await shot(page, 'local-1-before');

  // —— 没登录点确定:提示登录,不发任何云端请求
  const cloudMark0 = cloudLog.length;
  await clickConfirm(page);
  await waitFor(async () => (await statusText(page)) === M.ACCOUNT_MOVE_TEXT.needLogin, 15_000, '提示先登录');
  check(cloudSince(cloudMark0, /^\/hosted\//).length === 0, '本地-没登录时没有向云端发任何项目请求', cloudSince(cloudMark0, /^\/hosted\//));
  await shot(page, 'local-2-login');
  // 点「确定」时设置对话框会把项目名、画幅等写回项目(值没变);「搬之前」的内容从这里取
  await P(page, async () => (await import('/src/editor/sync/syncManager.ts')).whenSaved(10_000));
  built.text = await contentOf(page);

  // —— 登录后接着搬;头一次云端中途不可用(取连接票据一直回 503)
  stateA.fault = (p) => (p === '/hosted/shared/account/session' ? 503 : null);
  await page.type('[data-pc="collab-account-name"]', fixture.accounts[0].name);
  await page.type('[data-pc="collab-account-password"]', fixture.accounts[0].password);
  const t0 = Date.now();
  await page.click('[data-pc="collab-account-submit"]');
  await waitFor(async () => /上传项目内容/.test((await statusText(page)) ?? ''), 30_000, '进行到上传项目内容');
  out.progressText = await statusText(page);
  await shot(page, 'local-3-progress');
  await waitFor(async () => { const t = await statusText(page); return t && !/^正在/.test(t); }, 40_000, '第一次的结果');
  out.failText = await statusText(page);
  check(/项目内容没有传完/.test(out.failText) && /本机项目没有改动/.test(out.failText) && /不会多建一个/.test(out.failText), '本地-失败的提示说清停在哪、本机没动、再点不会多建', out.failText);
  await shot(page, 'local-4-failed');
  // 本机原样可用
  const vFail = await viewOf(page);
  check(vFail.kind === 'local' && vFail.shared === null && vFail.association === null && vFail.status === 'online', '本地-失败后编辑器仍在本机项目里(没有协作关联)', vFail);
  check((await contentOf(page)) === built.text, '本地-失败后编辑器里的项目内容一字不差');
  check((await draftText(A, draftId)) === draftBefore, '本地-失败后本机草稿文件一个字节都没变');
  const edit = await editAndSave(page);
  check(edit.ok, '本地-失败后本机项目照常能改、能存', edit);
  built.text = await contentOf(page);
  const afterFail = cloudProjects();
  const made = afterFail.filter((id) => !cloudBefore.includes(id));
  check(made.length === 1, '本地-失败时云端只多出一个项目(内容还是占位)', made.length);
  const stub = made.length === 1 ? await cloudContent(stateA, made[0]) : null;
  check(!!stub && stub.media?.length === 0 && stub.id === built.contentId, '本地-失败时云端那个项目的内容是占位(空白项目)', stub && { media: stub.media?.length, tracks: stub.tracks?.length });
  out.createRequests = stateA.requests.filter((q) => q.path === '/hosted/shared/account/create').map((q) => ({ bytes: q.bytes }));
  check(out.createRequests.length === 1 && out.createRequests[0].bytes < 4096, '本地-新建请求只发了一次、请求体只带占位', out.createRequests);

  // —— 恢复后再点确定:接着用同一个云端项目
  stateA.fault = null;
  const pendingHint = await P(page, () => document.querySelector('[data-pc="collab-move-pending"]')?.textContent ?? null);
  check(/已经建好/.test(pendingHint ?? ''), '本地-设置里提示上次没做完、云端项目已建好', pendingHint);
  await clickConfirm(page);
  await waitFor(async () => { const t = await statusText(page); return t && !/^正在/.test(t) && t !== out.failText; }, 90_000, '第二次的结果');
  out.doneText = await statusText(page);
  res.timings.localMoveMs = Date.now() - t0;
  check(out.doneText === M.ACCOUNT_MOVE_TEXT.doneLocal, '本地-成功的提示', out.doneText);
  const vDone = await waitFor(async () => { const v = await viewOf(page); return v.shared?.accountId ? v : null; }, 20_000, '甲进入云端项目');
  check(vDone.shared.where === 'hosted' && vDone.shared.projectId === made[0] && vDone.shared.creator === true && vDone.association === null, '本地-编辑器接着就在这个云端项目里(创建者,同一个项目号)', vDone.shared);
  check(stateA.requests.filter((q) => q.path === '/hosted/shared/account/create').length === 1, '本地-第二次没有再发新建请求');
  check(cloudProjects().length === afterFail.length, '本地-云端没有多出第二个项目', cloudProjects().length - cloudBefore.length);
  out.toasts = await toastsOf(page);
  check(out.toasts.includes(M.ACCOUNT_MOVE_TEXT.toastLocal), '本地-气泡提示把项目链接发给其他成员', out.toasts);
  check(await P(page, () => !!document.querySelector('[data-pc="collab-move-link"]')), '本地-设置里有「复制项目链接」');
  await shot(page, 'local-5-done');
  await closeSettings(page);
  const cloudNow = await cloudContent(stateA, made[0]);
  check(M.sameContent(cloudNow, JSON.parse(built.text)), '本地-云端内容与搬之前本机那一份逐字段相同');
  check((await contentOf(page)) === built.text || M.sameContent(JSON.parse(await contentOf(page)), JSON.parse(built.text)), '本地-甲编辑器里的内容没变');
  // 本机那份草稿:仍是普通的本地项目(没有协作关联),内容就是搬之前那一份
  const draftAfter = JSON.parse(await draftText(A, draftId));
  const differing = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !M.sameContent(a[k], b[k]));
  out.draftDiff = { vsBefore: differing(draftAfter.project, JSON.parse(draftBefore).project), vsMoved: differing(draftAfter.project, JSON.parse(built.text)) };
  // 素材表里的元数据(波形、缩略图等)是导入之后在后台陆续回填的,两次存盘之间会多出几个字段;素材本身按号和哈希比
  const mediaKeys = (p) => (p.media ?? []).map((m) => `${m.id}:${m.hash ?? ''}`).sort().join(',');
  check(!draftAfter.collaboration && draftAfter.project.id === built.contentId && out.draftDiff.vsBefore.every((k) => k === 'media') &&
    mediaKeys(draftAfter.project) === mediaKeys(JSON.parse(built.text)),
    '本地-本机草稿仍是普通的本地项目(没有协作关联),内容就是搬上去的那一份', { collaboration: draftAfter.collaboration ?? null, id: draftAfter.project.id, ...out.draftDiff });
  check(await P(page, async () => (await import('/src/editor/io/drafts.ts')).getActiveDraftId() === null), '本地-搬完之后的保存不再写回那份草稿');

  // —— 卡片源码、素材:刚搬上去这一刻照常同步
  const aCard = await waitFor(async () => { const s = await cardStatus(A); return s.projectId === made[0] && s.records?.[CARD_REL]?.rev >= 1 ? s.records[CARD_REL] : null; }, 60_000, '甲把用户卡的源码传上云端内容库').catch(() => null);
  check(!!aCard, '本地-搬完后甲的卡片源码同步绑在云端项目上并把用户卡传了上去', aCard);
  const uploadingToast = M.ACCOUNT_MOVE_TEXT.uploading(2);
  const seen = new Set(await toastsOf(page));
  const queueEmpty = await waitFor(async () => { for (const t of await toastsOf(page)) seen.add(t); const q = await getJson(`${A.base}/api/media/upload-queue`); return q.queue && q.queue.items.length === 0 && q.queue.working === false ? q : null; }, 120_000, '上传队列传完').catch(() => null);
  check(!!queueEmpty, '本地-素材上传队列传完');
  await waitFor(async () => { for (const t of await toastsOf(page)) seen.add(t); return seen.has(M.ACCOUNT_MOVE_TEXT.uploaded); }, 20_000, '提示素材已全部传到云端').catch(() => null);
  out.uploadToasts = [...seen].filter((t) => /素材/.test(t));
  check([...seen].some((t) => /^素材还在后台上传/.test(t)), '本地-搬完时提示素材还在后台上传', { expectedLike: uploadingToast, seen: out.uploadToasts });
  check(seen.has(M.ACCOUNT_MOVE_TEXT.uploaded), '本地-传完后提示素材已全部传到云端', out.uploadToasts);
  // 先小后大:编辑器进程的上传日志里,视频的小尺寸先于原尺寸开始
  const log = A.proc.text();
  const order = [...log.matchAll(/upload\.tier-start (\{[^\n]*\})/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  const iSmall = order.findIndex((e) => e.tier === 'small' && e.hash === built.tiers?.small), iOrig = order.findIndex((e) => e.tier === 'original' && e.hash === built.tiers?.original);
  out.uploadOrder = order.map((e) => `${e.tier}:${String(e.hash).slice(0, 8)}`);
  check(iSmall >= 0 && iOrig > iSmall, '本地-视频先传小尺寸、再传原尺寸', out.uploadOrder);

  // —— 乙凭项目链接加入
  const link = `${ORIGIN}/editor?project=${made[0]}`;
  const pageB = await openDesktop(B, stateB, '乙');
  out.b = await verifyOnB(pageB, B, built, link, 'local');
  await page.bringToFront();
  await sleep(500);
  out.projectId = made[0];
  return { out, page, pageB, built };
}

/* ---------------- 本机协作房间搬上去 ---------------- */

async function scenarioRoom({ A, B, stateA, stateB, video }) {
  const out = {};
  // 甲的登录还在保险箱里(上一遍登录过);没有跑上一遍时在这里直接登录
  if (!stateA.recovery) await nativeBridge(stateA)('login', { ...fixture.accounts[0], deviceId: `move-a-${RUN}`.padEnd(16, '0'), deviceName: 'account-move-a', requestId: randomUUID() });
  const page = await openDesktop(A, stateA, '甲(房间)');
  const name = `搬到云端-房间-${RUN}`;
  const built = await buildProject(page, A, name, video);
  check(built.bytes > 1024 * 1024, '房间-正文大于 1 MiB', built.bytes);
  const projectPassword = secret();
  const created = await P(page, async (o) => (await import('/src/editor/sync/collab.ts')).enableCollab(o), { where: 'lan', mode: 'free', name, creator: { username: 'host', password: secret() }, projectPassword, hostedUrl: `${ORIGIN}/hosted` });
  if (!created.ok) throw new Error(`本机协作房间没开成:${created.error}`);
  const room = await viewOf(page);
  check(room.shared?.where === 'lan' && room.association?.where === 'lan', '房间-本机协作房间开着(放本机)', room.shared);
  const roomId = room.shared.projectId;
  await sleep(1500);
  // 存成草稿:这份文件里带着房间关联;搬完之后它应当变回普通的本地项目
  const draftId = await P(page, async () => { const D = await import('/src/editor/io/drafts.ts'); const id = D.newDraftId(); D.setActiveDraftId(id); await D.saveDraft(id); return id; });
  check(JSON.parse(await draftText(A, draftId)).collaboration?.roomId === roomId, '房间-搬之前本机草稿里记着房间关联');
  // 房间里的内容以文档服务为准:取进了房间之后的那一份当「搬之前」
  await P(page, async () => (await import('/src/editor/sync/syncManager.ts')).whenSaved(10_000));
  built.text = await contentOf(page);
  const recordFile = path.join(A.dataDir, 'docservice', 'auth', 'projects', `${roomId}.json`);
  const recordBefore = fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8') : null;
  check(!!recordBefore, '房间-磁盘上有本机房间记录');
  const memberCanAuth = async () => { try { await buildAuthProtocols({ base: room.shared.base, projectId: roomId, username: 'member-probe', as: 'member', password: projectPassword, deviceId: 'move-probe-member-0001', deviceName: 'member-probe' }); return true; } catch (e) { return { status: e?.status ?? null, reason: e?.reason ?? String(e?.message ?? e).slice(0, 80) }; } };
  check((await memberCanAuth()) === true, '房间-搬之前凭项目密码能取到进入房间的证明');
  const cloudBefore = cloudProjects();

  await openSettings(page);
  await page.waitForSelector('[data-pc="collab-move-hosted"]');
  await shot(page, 'room-1-before');

  // —— 头一次:新建的请求到了云端、回包丢了(断连接)
  stateA.fault = (p) => (p === '/hosted/shared/account/create' ? 'drop-response' : null);
  const createsBefore = stateA.requests.filter((q) => q.path === '/hosted/shared/account/create').length;
  const t0 = Date.now();
  await page.click('[data-pc="collab-move-hosted"]');
  await waitFor(async () => { const t = await statusText(page); return t && !/^正在/.test(t); }, 40_000, '第一次的结果');
  out.confirm = page.dialogs.at(-1)?.message ?? null;
  check(page.dialogs.length === 1 && /本机协作会关闭/.test(out.confirm ?? '') && /旧邀请码作废/.test(out.confirm ?? '') && out.confirm.includes(fixture.accounts[0].name), '房间-点「搬到云端」先弹确认框(账号名、关闭本机协作、旧邀请码作废)', out.confirm);
  out.failText = await statusText(page);
  check(/连不上云端/.test(out.failText) && /本机协作没有改动/.test(out.failText), '房间-失败的提示说清本机协作没有改动', out.failText);
  await shot(page, 'room-2-failed');
  // 本机房间逐项不变
  const vFail = await viewOf(page);
  check(vFail.shared?.where === 'lan' && vFail.shared.projectId === roomId && vFail.status === 'online' && vFail.association?.roomId === roomId, '房间-失败后仍连着原来的本机房间', vFail);
  check(fs.existsSync(recordFile) && fs.readFileSync(recordFile, 'utf8') === recordBefore, '房间-失败后磁盘上的房间记录一个字节都没变');
  check((await contentOf(page)) === built.text, '房间-失败后项目内容一字不差');
  const edit = await editAndSave(page);
  check(edit.ok, '房间-失败后房间照常能改、能存', edit);
  check((await memberCanAuth()) === true, '房间-失败后成员照常能取到进入房间的证明');
  const restore = await P(page, async (d) => { const r = await fetch('/api/collaboration/restore-host', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ descriptor: d, task: 'account-move-probe', taskVersion: 0 }) }); return r.status; }, { version: 1, ...vFail.association });
  check(restore === 200, '房间-失败后主机恢复接口照常放行', restore);
  const afterFail = cloudProjects();
  check(afterFail.length === cloudBefore.length + 1, '房间-云端其实已经建了一个(回包丢了,本机不知道)', afterFail.length - cloudBefore.length);
  built.text = await contentOf(page);

  // —— 再点一次:同一个请求号,拿回同一个云端项目
  stateA.fault = null;
  await page.click('[data-pc="collab-move-hosted"]');
  let sawProgress = false;
  await waitFor(async () => {
    const t = await statusText(page);
    if (!sawProgress && /^正在搬到云端/.test(t ?? '')) { sawProgress = true; out.progressText = t; await shot(page, 'room-3-progress').catch(() => undefined); }
    return t && !/^正在/.test(t) && t !== out.failText;
  }, 120_000, '第二次的结果');
  out.doneText = await statusText(page);
  res.timings.roomMoveMs = Date.now() - t0;
  check(out.doneText === M.ACCOUNT_MOVE_TEXT.doneRoom, '房间-成功的提示(本机协作已关闭、旧邀请码已作废、把新链接发给原来的成员)', out.doneText);
  const requestIds = stateA.requests.filter((q) => q.path === '/hosted/shared/account/create').slice(createsBefore).map((q) => q.requestId);
  check(requestIds.length === 2 && requestIds[0] === requestIds[1], '房间-两次新建用的是同一个请求号', requestIds.length);
  const made = cloudProjects().filter((id) => !cloudBefore.includes(id));
  check(made.length === 1, '房间-云端只多出一个项目(没有重名的第二个)', made.length);
  const vDone = await waitFor(async () => { const v = await viewOf(page); return v.shared?.accountId ? v : null; }, 20_000, '甲进入云端项目');
  check(vDone.shared.where === 'hosted' && vDone.shared.projectId === made[0] && vDone.association === null && vDone.blocked === null, '房间-编辑器接着就在云端项目里,没有弹「项目被删除」', vDone);
  out.toasts = await toastsOf(page);
  check(out.toasts.includes(M.ACCOUNT_MOVE_TEXT.toastRoom), '房间-气泡提示把新的项目链接发给原来的成员、旧邀请码已作废', out.toasts);
  check(await P(page, () => !document.querySelector('[data-pc="collab-move-lan"]')), '房间-搬完后不显示「搬回本机」');
  await shot(page, 'room-4-done');
  await closeSettings(page);
  // 本机协作关掉了:房间记录没了、旧凭证连不进去
  const recordAfter = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, 'utf8')) : null;
  check(recordAfter === null || recordAfter.deleted || recordAfter.deletedAt, '房间-磁盘上的本机房间记录已删除', recordAfter && Object.keys(recordAfter));
  const draftAfter = JSON.parse(await draftText(A, draftId));
  check(!draftAfter.collaboration && draftAfter.project.id === built.contentId, '房间-搬完后本机草稿是普通的本地项目(房间关联没了)', { collaboration: draftAfter.collaboration ?? null });
  const authAfter = await memberCanAuth();
  check(authAfter !== true, '房间-旧的项目密码进不了原房间', authAfter);
  const cloudNow = await cloudContent(stateA, made[0]);
  check(M.sameContent(cloudNow, JSON.parse(built.text)), '房间-云端内容与关协作之前房间里那一份逐字段相同');
  await waitFor(async () => { const q = await getJson(`${A.base}/api/media/upload-queue`); return q.queue && q.queue.items.length === 0 && q.queue.working === false; }, 120_000, '上传队列传完').catch(() => null);

  const pageB = await openDesktop(B, stateB, '乙(房间)');
  out.b = await verifyOnB(pageB, B, built, `${ORIGIN}/editor?project=${made[0]}`, 'room');
  out.projectId = made[0];
  return { out };
}

/* ---------------- 主流程 ---------------- */

try {
  for (const name of ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE']) if (!process.env[name]) throw new Error(`缺环境变量 ${name}`);
  const { startCloudQueueUserFixture } = await import('../../server/test/fixtures/cloud-queue-user-path.mjs');
  fixture = await startCloudQueueUserFixture({ ports: FIXTURE_PORTS, agentPort: AGENT_PORT });
  ORIGIN = fixture.origin;
  ca = fs.readFileSync(fixture.caFile);
  say('fixture.ready', { origin: ORIGIN });
  const health = await new Promise((resolve, reject) => { const req = https.request(`${ORIGIN}/hosted/healthz`, { ca, timeout: 8000 }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString())); } catch (e) { reject(e); } }); }); req.once('error', reject); req.end(); });
  check(health.accountMode === 'v2' && health.accountRequired === true, '云端节点是账号模式', { accountMode: health.accountMode, accountRequired: health.accountRequired });

  // 一段带声音的测试视频
  const ffmpeg = await findFfmpeg();
  const videoFile = path.join(TMP, 'clip.mp4');
  const made = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=${RUN}`, videoFile], { windowsHide: true });
  if (made.status !== 0) throw new Error(`测试视频没生成:${String(made.stderr).slice(0, 200)}`);
  const video = fs.readFileSync(videoFile).toString('base64');
  res.video = { bytes: fs.statSync(videoFile).size, sha256: sha256(fs.readFileSync(videoFile)).slice(0, 12) };

  const A = await startEditor('a', A_PORT);
  const B = await startEditor('b', B_PORT);
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, defaultViewport: { width: 1440, height: 900 }, protocolTimeout: 300_000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const stateA = { requests: [], fault: null }, stateB = { requests: [], fault: null };
  say('editors.ready', { a: A.base, b: B.base });

  if (ONLY.includes('local')) { const r = await scenarioLocal({ A, B, stateA, stateB, video }); res.local = r.out; await r.page.close().catch(() => undefined); await r.pageB.close().catch(() => undefined); }
  if (ONLY.includes('room')) { const r = await scenarioRoom({ A, B, stateA, stateB, video }); res.room = r.out; }
  check(!fs.existsSync(path.join(ROOT, CARD_REL)), '探针没有往仓库里写卡片文件');
} catch (error) {
  fails.push(`探针中断:${String(error?.message ?? error).slice(0, 300)}`);
  say('ERROR', { message: String(error?.stack ?? error).slice(0, 1200) });
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  await fixture?.close().catch(() => undefined);
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  res.fails = fails;
  const text = JSON.stringify(res, null, 2).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]');
  fs.writeFileSync(path.join(OUT, 'evidence.json'), text);
  process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, fails, shots: res.shots, timings: res.timings }).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')}\n`);
  process.exit(fails.length ? 1 : 0);
}
