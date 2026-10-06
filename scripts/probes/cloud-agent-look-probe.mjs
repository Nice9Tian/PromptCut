#!/usr/bin/env node
/**
 * 云端 Agent「看画面」的端到端探针（契约 `docs/plan/cloud-agent-contract.md` 第 9.8 节；`docs/plan/hosted-render-contract.md` 第 8a 节）。
 * 用断言，不靠推断。
 *
 *   node scripts/probes/cloud-agent-look-probe.mjs [--doc-port 8798] [--asset-port 8799] [--agent-port 5745] [--render-port 5820]
 *        [--steps builtin,tools,usercard,readonly,off] [--keep] [--verbose]
 *
 * 全部是真进程、真握手，只绑 127.0.0.1，数据在一个临时目录里，结束时删掉；不连任何远端。模型是仓库里的模拟模型提供方（照脚本走），不花钱。
 *   托管组合（文档 + 素材）`server/hosted/main.mjs`，本机信任关着
 *   渲染服务 `server/hosted-render/main.mjs`（管理进程 + 常驻工作进程；带用户卡的项目另起隔离工作进程），服务身份 render
 *   Agent 服务 `server/agent-service/main.mjs`，服务身份 agent，`PROMPTCUT_AGENT_LOOK_URL` 指到渲染服务管理进程的口子
 * 端口：`--render-port` +0/+1/+2 常驻工作进程、+3/+4/+5 隔离工作进程、+6 管理进程的诊断与代理口（看画面的口子也在它上面）。
 *
 * 模型看到的画面怎么取回来：一轮结束后读 Agent 服务数据目录里这个对话的模型历史（`history.json`，探针自己的临时目录）——里面的图片块
 * 就是交给模型的那几张。所以下面的像素断言同时证明了「图片进了模型的历史」。
 *
 * # 验收标准（每条一行「过 / 不过」；stdout 最后一行是 JSON `{ ok, pass, fails, … }`；退出码 0 过、1 不过、2 起不来）
 *
 * K0 三个服务起来；渲染服务的状态口报看画面开着、登记表里有 agent 的公钥；Agent 服务的 `/healthz` 报 `look: true`。
 * K1 只用内置卡的项目（步骤 builtin）：模拟模型调 `see_frames { t: 0.5 }`、`{ t: 1.5 }`，拿到的两张图里那块绿色横移的方块分别在
 *    该时刻应在的位置（按 1920 宽折算 810 与 1110，各允许 ±60）——**是这个时刻的画面**；再 `update_clip` 把片段截到 1 秒
 *    （项目总时长跟着变成 1 秒），第三次 `see_frames { t: 1.5 }` 渲的是这一版的最后一帧（0.97 秒，方块在 950）并在结果里注明——
 *    **是这一版项目的画面**。三张都由常驻工作进程出，隔离工作进程没有为它起过。
 * K2 `get_layout` 的实体框（步骤 builtin）：结果里那个片段的 `contentBox` 不是 null。
 * K3 其余三个工具各调一次（步骤 tools）：`inspect_card_dom`、`bake_card`、`get_gif`，逐个记「成 / 不成与原因」。`inspect_card_dom` 必须成；
 *    另两个不成不算探针失败，原因写进结果（决定它们在云端的工具表里怎么归类）。
 * K4 含用户卡的项目（步骤 usercard）：云端 Agent 用 `create_card` 建一张纯色卡（`fixtures/cloud-look/look-solid.tsx`）并放上时间轴，
 *    `see_frames` 看到的画面中心是参数给的红色；`update_clip` 把参数改成蓝色后再看是蓝色；`edit_card` 把源码改成恒为绿色后再看是绿色
 *    （渲染服务等隔离工作进程把改过的卡同步到位才出图）。三张都由隔离工作进程出；常驻工作进程对这个项目一帧也没出、一个任务也没认领。
 * K5 只读成员也能看（步骤 readonly）：只读成员发起的对话里 `see_frames` 照常拿到画面（看不改项目），同一轮里的写入照旧被拒。
 * K6 开关（步骤 off，放最后）：项目创建者关掉「渲染节点」后，`see_frames` 回「这次没看成」（原因是渲染节点关着），这一轮照常结束、不挂住；
 *    重新打开后又看得到。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSharedProject } from '../../server/auth/client.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import {
  ROOT, KDF, sleep, waitFor, portBusy, killTree, startProcess, startHosted, startAgent, joinAs, adminOp, projectOf, putProject, mockScript, agentApi, createChecks,
} from './cloud-agent-probe-lib.mjs';

const { PNG } = createRequire(import.meta.url)('pngjs');
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const ALL_STEPS = ['builtin', 'tools', 'usercard', 'readonly', 'off'];
const STEPS = String(argOf('--steps', ALL_STEPS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const DOC_PORT = Number(argOf('--doc-port', 8798));
const ASSET_PORT = Number(argOf('--asset-port', 8799));
const AGENT_PORT = Number(argOf('--agent-port', 5745));
const RENDER_PORT = Number(argOf('--render-port', 5820));
const KEEP = args.includes('--keep');
const VERBOSE = args.includes('--verbose');
const BASE = `ws://127.0.0.1:${DOC_PORT}`;
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
const RENDER_STATUS = `http://127.0.0.1:${RENDER_PORT + 6}`;

const { results, check } = createChecks();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-look-'));
const D = { hosted: path.join(tmp, 'hosted'), agent: path.join(tmp, 'agent'), agentSecrets: path.join(tmp, 'agent-secrets'), render: path.join(tmp, 'render'), renderSecrets: path.join(tmp, 'render-secrets') };
let hosted = null;
let agent = null;
let render = null;

function startRender() {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') env[k] = undefined;
  render = startProcess(path.join(ROOT, 'server', 'hosted-render', 'main.mjs'), {
    ipc: true,
    env: {
      ...env,
      PROMPTCUT_RENDER_DOC_URL: BASE, PROMPTCUT_RENDER_SECRETS: D.renderSecrets, PROMPTCUT_RENDER_DATA: D.render,
      PROMPTCUT_RENDER_PORT: String(RENDER_PORT), PROMPTCUT_RENDER_ISO_PORT: String(RENDER_PORT + 3), PROMPTCUT_RENDER_STATUS_PORT: String(RENDER_PORT + 6),
      PROMPTCUT_RENDER_MAX_CONCURRENT: '2', PROMPTCUT_RENDER_SAMPLE_MS: '2000', PROMPTCUT_RENDER_MEM_LOW: '256M',
      PROMPTCUT_RENDER_EDITOR_DIR: path.join(tmp, 'no-editor'), PROMPTCUT_RENDER_AGENT_STATUS_URL: `${AGENT_URL}/healthz`,
      // 核对云端 Agent 服务签名用的登记表：这个临时托管组合的那一份
      PROMPTCUT_RENDER_LOOK_SERVICES: path.join(D.hosted, 'secrets', 'services.json'),
      ...(VERBOSE ? { PROMPTCUT_RENDER_VERBOSE: '1' } : {}),
      ...(process.platform === 'win32' && !process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ? { PROMPTCUT_TEST_ENV_FINGERPRINT: '7e57c10d00000002' } : {}),
    },
  });
  return render;
}
const renderStatus = async () => (await fetch(`${RENDER_STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();
const waitRenderReady = () => waitFor(async () => { const s = await renderStatus(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪', 1000);

/* ------------------------------------------------------------------ 取回模型看到的画面 */

/** Agent 服务盘上这个对话的目录（探针自己的临时目录） */
function conversationDir(projectId, conversationId) {
  const root = path.join(D.agent, 'tenants', projectId);
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const p = path.join(dir, item.name);
      if (item.name === conversationId && fs.existsSync(path.join(p, 'meta.json'))) return p;
      stack.push(p);
    }
  }
  return null;
}
/** 这个对话交给模型的图片（按先后）与工具结果事件 */
function conversationOutput(projectId, conversationId) {
  const dir = conversationDir(projectId, conversationId);
  if (!dir) return { images: [], tools: [], meta: null };
  const images = [];
  try {
    const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    const messages = Array.isArray(history) ? history : (history.messages ?? []);
    for (const m of messages) for (const b of Array.isArray(m?.content) ? m.content : []) if (b?.type === 'image' && typeof b.data === 'string') images.push(PNG.sync.read(Buffer.from(b.data, 'base64')));
  } catch { /* 没有历史：下面按 0 张判 */ }
  const events = fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const tools = events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '') }));
  return { images, tools, meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) };
}
const pixel = (png, fx, fy) => { const x = Math.min(png.width - 1, Math.max(0, Math.round(fx * png.width))); const y = Math.min(png.height - 1, Math.max(0, Math.round(fy * png.height))); const i = (y * png.width + x) * 4; return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]; };
/** 那块绿色（`bg-emerald-600`，约 rgb(5,150,105)）的像素数与重心的横坐标（折算到 1920 宽） */
function emerald(png) {
  let n = 0; let sx = 0;
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
    const i = (y * png.width + x) * 4;
    const r = png.data[i]; const g = png.data[i + 1]; const b = png.data[i + 2];
    if (r < 70 && g > 110 && g < 200 && b > 60 && b < 150 && g - r > 60 && g - b > 20) { n += 1; sx += x; }
  }
  return { count: n, share: n / (png.width * png.height), x: n ? Math.round((sx / n) * (1920 / png.width)) : null };
}
const near = (rgb, want, tol = 40) => !!rgb && Math.abs(rgb[0] - want[0]) <= tol && Math.abs(rgb[1] - want[1]) <= tol && Math.abs(rgb[2] - want[2]) <= tol;

async function main() {
  for (const s of STEPS) if (!ALL_STEPS.includes(s)) throw new Error(`不认识的步骤 ${s}`);
  for (const [name, port] of [['文档服务', DOC_PORT], ['素材服务', ASSET_PORT], ['Agent 服务', AGENT_PORT], ...[0, 1, 2, 3, 4, 5, 6].map((d) => ['渲染服务', RENDER_PORT + d])]) {
    if (await portBusy(port)) throw new Error(`端口 ${port}(${name})已被占用`);
  }
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.renderSecrets, '--instance-name', '托管方的渲染节点(探针)']);
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.agentSecrets, '--service', 'agent', '--instance-name', '云端 Agent(探针)']);
  hosted = await startHosted({ dataDir: D.hosted, docPort: DOC_PORT, assetPort: ASSET_PORT, env: { PROMPTCUT_AGENT_PUBLIC_URL: `${AGENT_URL}/v1` } });

  const pw = () => `pw-${randomBytes(6).toString('hex')}`;
  const creds = { alice: { username: 'alice', password: pw() }, rita: { username: 'rita', password: pw() }, ula: { username: 'ula', password: pw() } };
  const tag = randomBytes(4).toString('hex');
  const px = { ...(await createSharedProject({ base: BASE, name: `look-x-${tag}`, mode: 'restricted', creator: creds.alice, list: [creds.rita], kdf: KDF })), creator: creds.alice };
  const py = { ...(await createSharedProject({ base: BASE, name: `look-y-${tag}`, mode: 'restricted', creator: creds.ula, list: [], kdf: KDF })), creator: creds.ula };
  const X = px.projectId;
  const Y = py.projectId;
  // 只读成员：直接写项目记录（停进程、改文件、再起）
  await hosted.stop();
  {
    const file = path.join(D.hosted, 'docservice', 'auth', 'projects', `${X}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.readonly = ['rita'];
    fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  }
  hosted = await startHosted({ dataDir: D.hosted, docPort: DOC_PORT, assetPort: ASSET_PORT, env: { PROMPTCUT_AGENT_PUBLIC_URL: `${AGENT_URL}/v1` } });

  const base = (id, name, tracks) => ({
    version: 1, id, name, width: 1920, height: 1080, fps: 30, duration: 3, themeId: 'dark', camera3dFov: 50,
    media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, transitions: [], tracks,
  });
  const alice = await joinAs(BASE, px, { ...creds.alice, as: 'creator' });
  const ula = await joinAs(BASE, py, { ...creds.ula, as: 'creator' });
  await putProject(alice, X, base(X, '看画面探针·内置卡', [{ id: 'tr-0', name: 'tr-0', hidden: false, clips: [{ id: 'clip-slide', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] }]));
  await putProject(ula, Y, base(Y, '看画面探针·用户卡', [{ id: 'tr-0', name: 'tr-0', hidden: false, clips: [] }]));

  startRender();
  agent = await startAgent({ dataDir: D.agent, secrets: D.agentSecrets, docPort: DOC_PORT, port: AGENT_PORT, env: { PROMPTCUT_AGENT_LOOK_URL: RENDER_STATUS } });
  await waitRenderReady();
  const health = await (await fetch(`${AGENT_URL}/healthz`)).json();
  const st0 = await renderStatus();
  check('K0 三个服务起来；渲染服务报看画面开着、登记表里有 agent 的公钥；Agent 服务报 look', st0.look?.enabled === true && (st0.look?.registry?.agentKeys ?? 0) >= 1 && health.look === true, {
    look: st0.look ? { enabled: st0.look.enabled, agentKeys: st0.look.registry?.agentKeys ?? null } : null, agentLook: health.look ?? null, userCards: st0.userCards,
  });

  /** 以某位成员的身份跑一轮模拟模型的脚本，等它结束；回这个对话交给模型的图片与工具结果 */
  const run = async (page, projectId, conversationId, steps, { ms = 300_000, creativity } = {}) => {
    const api = agentApi(AGENT_URL, page);
    const sent = await api.send(conversationId, mockScript(steps), { extra: creativity ? { creativity } : {} });
    if (sent.status !== 202) return { sent, images: [], tools: [], meta: null, ms: 0 };
    const t0 = Date.now();
    const meta = await api.settled(conversationId, ms).catch(() => null);
    await sleep(300);
    return { sent, ...conversationOutput(projectId, conversationId), meta, ms: Date.now() - t0 };
  };
  const toolsLine = (tools) => tools.map((t) => `${t.name}:${t.ok ? 'ok' : `不成 ${t.summary.slice(0, 160)}`}`);

  if (STEPS.includes('builtin')) {
    const r = await run(alice, X, 'look-builtin', [
      { tool: 'see_frames', input: { source: 'timeline', t: 0.5 } },
      { tool: 'see_frames', input: { source: 'timeline', t: 1.5 } },
      { tool: 'get_layout', input: { clipId: 'clip-slide' } },
      { tool: 'update_clip', input: { clipId: 'clip-slide', start: 0, end: 1 } },
      { tool: 'see_frames', input: { source: 'timeline', t: 1.5 } },
      { say: '看过了' },
    ]);
    const e = r.images.map(emerald);
    const st = await renderStatus();
    const isoRunsForX = (st.isolation?.history ?? []).filter((h) => h.projectId === X).length + (st.isolation?.current?.projectId === X ? 1 : 0);
    check('K1 只用内置卡的项目：see_frames 拿到的是这个时刻（绿色方块在 810 / 1110）、这一版项目（截到 1 秒后要 1.5 秒得到的是最后一帧，方块在 950）的画面；由常驻工作进程出', r.sent.status === 202 && r.meta?.state === 'idle'
      && r.images.length === 3 && e[0].count > 500 && Math.abs(e[0].x - 810) <= 60 && e[1].count > 500 && Math.abs(e[1].x - 1110) <= 60 && e[2].count > 500 && Math.abs(e[2].x - 950) <= 60 && /超过了整条片子的长度/.test(r.tools.filter((t) => t.name === 'see_frames')[2]?.summary ?? '')
      && (st.look?.byWorker?.resident ?? 0) >= 3 && isoRunsForX === 0, {
      end: r.meta?.state ?? null, ms: r.ms, tools: toolsLine(r.tools), images: r.images.map((p) => `${p.width}x${p.height}`),
      emerald: e.map((x) => ({ pixels: x.count, x: x.x })), expectX: [810, 1110, 950], byWorker: st.look?.byWorker ?? null, isolatedRunsForThisProject: isoRunsForX,
    });
    const layout = r.tools.find((t) => t.name === 'get_layout');
    const box = /"contentBox":(null|\{[^}]*\}|\[[^\]]*\])/.exec(layout?.summary ?? '')?.[1] ?? '没有这个字段';
    check('K2 get_layout 的实体框量出来了', layout?.ok === true && box !== 'null' && box !== '没有这个字段', { contentBox: box.slice(0, 120), note: /"contentNote":"([^"]*)"/.exec(layout?.summary ?? '')?.[1] ?? null });
  }

  if (STEPS.includes('tools')) {
    // 先把片段放回 3 秒（上一步截短过），再逐个调
    const r = await run(alice, X, 'look-tools', [
      { tool: 'update_clip', input: { clipId: 'clip-slide', start: 0, end: 3 } },
      { tool: 'inspect_card_dom', input: { clipId: 'clip-slide' } },
      { tool: 'bake_card', input: { clipId: 'clip-slide', t: 1, size: 256 } },
      { tool: 'get_gif', input: { clipId: 'clip-slide' } },
      { say: '试过了' },
    ]);
    const by = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    check('K3 inspect_card_dom 成；bake_card、get_gif 各记成与不成', r.meta?.state === 'idle' && by.inspect_card_dom?.ok === true, {
      end: r.meta?.state ?? null, ms: r.ms, tools: toolsLine(r.tools), imagesToModel: r.images.length,
      bake_card: by.bake_card ? (by.bake_card.ok ? `成 ${by.bake_card.summary.slice(0, 200)}` : `不成：${by.bake_card.summary.slice(0, 240)}`) : '没有调到',
      get_gif: by.get_gif ? (by.get_gif.ok ? `成 ${by.get_gif.summary.slice(0, 200)}` : `不成：${by.get_gif.summary.slice(0, 240)}`) : '没有调到',
    });
  }

  if (STEPS.includes('usercard')) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-look', 'look-solid.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const before = await renderStatus();
    const r = await run(ula, Y, 'look-usercard', [
      { tool: 'create_card', input: { id: 'look-solid', source } },
      { tool: 'add_clip', input: { cardId: 'look-solid', start: 0, duration: 2, trackId: 'tr-0', params: { color: '#ff0000' } } },
      { tool: 'see_frames', input: { source: 'timeline', t: 1 } },
      { tool: 'list_tracks', input: {} },
      { say: '第一段看过了' },
    ], { creativity: 'high' });
    const clipId = (await projectOf(ula, Y)).project?.tracks?.flatMap((t) => t.clips).find((c) => c.cardId === 'look-solid')?.id ?? null;
    const r2 = clipId ? await run(ula, Y, 'look-usercard-2', [
      { tool: 'update_clip', input: { clipId, params: { color: '#0000ff' } } },
      { tool: 'see_frames', input: { source: 'timeline', t: 1 } },
      { tool: 'edit_card', input: { cardId: 'look-solid', find: 'style={{ background: params.color }}', replace: 'style={{ background: "#00ff00" }}' } },
      { tool: 'see_frames', input: { source: 'timeline', t: 1 } },
      { say: '第二段看过了' },
    ], { creativity: 'high' }) : { images: [], tools: [], meta: null, ms: 0 };
    const c = [...r.images, ...r2.images].map((p) => pixel(p, 0.5, 0.5));
    const st = await renderStatus();
    const resident = (st.queue?.nodes ?? []).find((n) => n.projectId === Y) ?? null;
    const isoRuns = [...(st.isolation?.history ?? []), ...(st.isolation?.current ? [st.isolation.current] : [])].filter((h) => h.projectId === Y).length;
    check('K4 含用户卡的项目：create_card 之后 see_frames 看到这张卡渲出来的样子（红）；改参数后是蓝；edit_card 改源码后是绿；都由隔离工作进程出', r.sent.status === 202 && r.meta?.state === 'idle' && r2.meta?.state === 'idle'
      && c.length === 3 && near(c[0], [255, 0, 0]) && near(c[1], [0, 0, 255]) && near(c[2], [0, 255, 0])
      && (st.look?.byWorker?.isolated ?? 0) - (before.look?.byWorker?.isolated ?? 0) >= 3 && (st.look?.byWorker?.resident ?? 0) === (before.look?.byWorker?.resident ?? 0)
      && isoRuns >= 1 && (resident?.claimed ?? 0) === 0, {
      end: [r.meta?.state ?? null, r2.meta?.state ?? null], ms: [r.ms, r2.ms], tools: [...toolsLine(r.tools), ...toolsLine(r2.tools)],
      centerPixels: c, expect: ['红 255,0,0', '蓝 0,0,255', '绿 0,255,0'], byWorker: st.look?.byWorker ?? null, isolatedRunsForThisProject: isoRuns,
      residentWorker: resident ? { claimed: resident.claimed, hold: resident.hold ?? null, cards: resident.cards?.state ?? null } : null,
      ...(c.length === 3 ? {} : { lookLog: render.logs.filter((l) => /^look\.|isolation\./.test(String(l.event))).slice(-14).map((l) => JSON.stringify(l).slice(0, 240)) }),
    });
  }

  if (STEPS.includes('readonly')) {
    const rita = await joinAs(BASE, px, creds.rita);
    const before = (await projectOf(alice, X)).rev;
    const r = rita ? await run(rita, X, 'look-readonly', [
      { tool: 'see_frames', input: { source: 'timeline', t: 0.5 } },
      { tool: 'update_clip', input: { clipId: 'clip-slide', start: 0, end: 2 } },
      { say: '只读成员看过了' },
    ]) : { sent: { status: 0 }, images: [], tools: [], meta: null, ms: 0 };
    const after = (await projectOf(alice, X)).rev;
    const see = r.tools.find((t) => t.name === 'see_frames');
    const write = r.tools.find((t) => t.name === 'update_clip');
    check('K5 只读成员也能看画面；同一轮里的写入照旧被拒、项目版本不变', !!rita && r.sent.status === 202 && see?.ok === true && r.images.length === 1 && emerald(r.images[0]).count > 500 && write?.ok === false && after === before, {
      sent: r.sent.status, tools: toolsLine(r.tools), imagesToModel: r.images.length, rev: [before, after],
    });
    rita?.close();
  }

  if (STEPS.includes('off')) {
    const off = await adminOp(alice, px, 'set-hosted-service', { service: 'render', enabled: false });
    await waitFor(async () => (await renderStatus()).directory?.list?.find((p) => p.projectId === X)?.enabled === false, 15_000, '渲染服务看到开关关了').catch(() => null);
    const r = await run(alice, X, 'look-off', [{ tool: 'see_frames', input: { source: 'timeline', t: 0.5 } }, { say: '关着的时候看了一次' }], { ms: 120_000 });
    const see = r.tools.find((t) => t.name === 'see_frames');
    const on = await adminOp(alice, px, 'set-hosted-service', { service: 'render', enabled: true });
    await waitFor(async () => (await renderStatus()).directory?.list?.find((p) => p.projectId === X)?.enabled === true, 15_000, '渲染服务看到开关开了').catch(() => null);
    const r2 = await run(alice, X, 'look-on-again', [{ tool: 'see_frames', input: { source: 'timeline', t: 0.5 } }, { say: '重新打开后又看了一次' }]);
    const see2 = r2.tools.find((t) => t.name === 'see_frames');
    check('K6 项目的「渲染节点」开关关掉后要不到画面（回「这次没看成」，这一轮照常结束）；重新打开后又看得到', off.type !== 'error' && on.type !== 'error'
      && r.meta?.state === 'idle' && see?.ok === false && /这次没看成/.test(see.summary) && r.images.length === 0 && see2?.ok === true && r2.images.length === 1, {
      adminOff: off.type, adminOn: on.type, whileOff: see ? { ok: see.ok, says: see.summary.slice(0, 160) } : null, endWhileOff: r.meta?.state ?? null, msWhileOff: r.ms,
      afterOn: see2 ? { ok: see2.ok } : null, imagesAfterOn: r2.images.length,
    });
  }

  alice.close();
  ula.close();
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 2;
  process.stdout.write(`${JSON.stringify({ check: '探针自己出错', ok: false, message: String(err?.stack ?? err).slice(0, 1500), renderTail: render ? render.text().slice(-1500) : null, agentTail: agent ? agent.text().slice(-800) : null })}\n`);
} finally {
  const lookLog = render ? render.logs.filter((l) => /^look\./.test(String(l.event))).length : 0;
  try { await agent?.stop(); } catch { /* 已经没了 */ }
  try { if (render) { await render.stop(30_000); killTree(render.child.pid); } } catch { /* 已经没了 */ }
  try { await hosted?.stop(); } catch { /* 已经没了 */ }
  const left = [];
  for (const port of [DOC_PORT, ASSET_PORT, AGENT_PORT, ...[0, 1, 2, 3, 4, 5, 6].map((d) => RENDER_PORT + d)]) if (await portBusy(port)) left.push(port);
  if (!KEEP) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { await sleep(500); } } }
  const fails = results.filter((r) => !r.ok).map((r) => r.check);
  if (code === 0 && fails.length) code = 1;
  process.stdout.write(`${JSON.stringify({ ok: code === 0, pass: results.filter((r) => r.ok).length, fails, steps: STEPS, lookLogLines: lookLog, portsStillBusy: left, tmp: KEEP ? tmp : null })}\n`);
  process.exit(code);
}
