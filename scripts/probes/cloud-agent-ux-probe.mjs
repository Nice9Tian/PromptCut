#!/usr/bin/env node
/**
 * 云端 Agent「关掉软件照常运转」的端到端探针(任务书 `docs/plan/cloud-agent-task.md`「用户体验验收」的本机版,回归项)。
 *
 * 这一版没有界面:创建者的页面由一个**独立的 Node 进程**扮演(本文件带 `--child` 再起一遍)——真口令握手进项目、
 * 真向文档服务要委托票据与对话委托、真 HTTP 发消息、真接事件流。「关掉软件」是把这个进程**真的结束**(SIGKILL),
 * 不是断线、不是关流。带界面的同一条探针在界面合流之后另做。
 *
 * 搭法(全部真进程,只绑 127.0.0.1,数据在一个临时目录里,结束时删掉;不连任何远端):
 *   托管组合 `server/hosted/main.mjs`(文档 + 素材,本机信任关着)
 *   渲染服务 `server/hosted-render/main.mjs`(管理进程 + 工作进程 + 它的 Chrome),服务身份 render
 *   Agent 服务 `server/agent-service/main.mjs`(命令行入口,服务身份 agent),模型是模拟模型提供方(照提示词里的脚本走)
 *   项目(限定进入):创建者 alice,成员 bob(另一位成员)、carol(中途被移出的那位)。项目里三张要预渲染的卡(两张探针重卡加一张带参数的内置图表卡 rank-bars)。
 *
 *   node scripts/probes/cloud-agent-ux-probe.mjs [--steps leave,later,reopen,stop,errors,load] [--doc-port 8798] [--asset-port 8799]
 *        [--agent-port 5741] [--render-port 5830] [--keep] [--verbose]
 *   `--render-port` +0/+1/+2 是渲染工作进程的三个端口,+6 是管理进程的诊断口。
 *
 * 验收标准(任务书「用户体验验收」六条,逐条对应;每条断言一行 JSON,`ok` 全为 true 才算过):
 *
 * 一、发出任务后完全退出(步骤 leave)
 *   U1  创建者的页面进程发出一个要跑一段时间、改多处(改文案、挪片段、调卡片参数各 4 次,共 12 次写入)的任务;
 *       事件流里看到第 2 个工具结果(任务已被云端接下)后,这个进程被 SIGKILL,确实没了;文档服务里这个项目没有任何成员连接。
 * 二、之后云端自己把事做完(步骤 leave)
 *   U2  没有任何成员连接的这段时间里(全程从渲染服务的目录里看 `members` 恒为假):对话跑到结束(`idle`),12 次写入逐次落地。
 *   U3  被改动的重卡由渲染服务渲出来、产物入库:Agent 服务以服务身份发布的清单计划被渲染服务认领,全部细任务做完,
 *       Agent 服务记下「渲染完成」;素材服务里多出产物块。三者的代码版本相同(计划的 `requires.codeVersion` 对得上)。
 * 三、另一位成员之后进项目(步骤 later;「改动一条条出现」在步骤 stop 里对着进行中的对话验)
 *   U4  bob 进项目:读到全部 12 次改动的结果,版本号连续加 12;每次写入的工具调用事件都在,署名是创建者本人加
 *       `service: 'agent'`(界面据此显示「alice 的云端 Agent」);成员列表顶层有 `hosted.agent`。
 *   U5  bob 不发任何渲染任务,直接取得到这一版的层表、各段清单与清单里的块(不是没有产物)。
 * 四、创建者重新打开(步骤 reopen;新进程、同一身份、同一设备)
 *   U6  列得出这段对话;事件从头补齐,与 Agent 服务盘上的事件记录逐条相同,`seq` 连续;看得到 12 次工具调用、收尾与「渲染完成」;
 *       项目是最新版本;预渲染的层表已在。
 *   U7  撤销:取得到 Agent 最后一次写入的逆操作(文档服务的事件模块),以创建者自己的身份提交,那一步的改动撤掉;
 *       bob 那边看到撤销的结果。再对一个被别人改过的实体撤销:逆操作与现状对不上,照现有规则不盲目覆盖(这里只验逆操作的归属与内容)。
 * 五、中途想停、换设备(步骤 stop)
 *   U8  另起一遍更长的任务,发起进程同样被结束。bob 在线看着:改动一条条到达(到达时刻分散),每条的署名是「alice 的云端 Agent」所需的字段;
 *       成员列表里 alice 那一行下有 `service: 'agent'` 的连接。
 *   U9  创建者在另一台设备(另一个设备号、同一创建者身份、另一个进程)打开:`info.running` 里有这个对话,接上事件流看得到过程;
 *       停掉 → 2 秒内收尾,项目停在最后一次成功写入的版本上;接着在这台设备上说一句,新的一轮正常跑完,`seq` 接着往后。
 * 六、出错不悄悄丢(步骤 errors;发起方都已离线,事后从对话记录里看)
 *   U10 模型调用失败:对话记录里有「模型调用失败」,状态 failed / model;项目停在失败前最后一次成功写入。
 *   U11 额度用尽:对话记录里有带已用与上限的那句话,状态 failed / quota-exceeded;已落地的保留;清掉额度后恢复。
 *   U12 创建者中途关了开关:状态 revoked / disabled,记录里有原因;之后没有新的写入。
 *   U13 发起成员中途被移出:状态 revoked / removed(他回不来,从 Agent 服务盘上的对话记录看)。
 *   U14 渲染失败:渲染服务停着,对话照常做完,对话记录里有 `render failed` 与原因、涉及的片段;项目内容不受影响。
 *   每一种都断言:项目内容完好(结构不变、片段都在)、版本号等于成功写入的次数、之后 1.5 秒没有新的写入。
 * 附:节点资源(步骤 load,任务书完成条件第 9 条的本机版,数字只作参考)
 *   U15 全节点同时进行的一轮不超过 6、每个项目不超过 3:超出的回 429 busy。
 *   U16 满载(6 轮对话同时写 + 渲染服务在渲)时文档服务 `/healthz` 与一次读项目的往返时延,对比空闲时的,写明数字。
 * 最后一行是汇总 `{ ok, passed, failed, timings }`。退出码 0 过、1 不过、2 起不来。不打印口令、票据、私钥。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSharedProject } from '../../server/auth/client.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import {
  ROOT, KDF, sleep, waitFor, portBusy, killTree, startProcess, startHosted, startAgent, joinAs, adminOp, projectOf, putProject, mockScript, agentApi, createChecks, readTree,
} from './cloud-agent-probe-lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };

/* ================================================================== 子进程:扮演一位成员的页面 */

if (args.includes('--child')) {
  const cfg = JSON.parse(process.env.PC_UX_CHILD ?? '{}');
  delete process.env.PC_UX_CHILD;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const proj = { projectId: cfg.projectId, creator: { username: cfg.username, password: cfg.password } };
  const page = await joinAs(cfg.base, proj, { username: cfg.username, password: cfg.password, as: cfg.as, device: cfg.device });
  if (!page) { out({ event: 'join-failed' }); process.exit(3); }
  const api = agentApi(cfg.agentUrl, page);

  if (cfg.role === 'initiator') {
    // 页面的顺序:进项目 → 要对话委托 → 带委托票据发消息 → 接事件流。之后一直开着,直到被结束
    const sent = await api.send(cfg.conversationId, cfg.prompt, { extra: cfg.pageState ? { pageState: cfg.pageState } : {} });
    out({ event: 'sent', status: sent.status, code: sent.code ?? null, runId: sent.runId ?? null });
    if (sent.status !== 202) process.exit(4);
    await api.events(cfg.conversationId, { after: 0, ms: 3_600_000, until: () => false, onEvent: (e) => out({ event: 'ev', type: e.type, seq: e.seq, ok: e.ok ?? null }) });
    await new Promise(() => {});
  }

  // role === 'visitor':重新打开(或另一台设备)。按 cfg.do 里列的做,最后打一行结果
  const r = { event: 'result' };
  const act = cfg.do ?? {};
  r.info = await api.info();
  r.list = (await api.list()).items ?? null;
  if (act.watchMs) {
    // 接上一个还在跑的对话看一会儿
    const w = await api.events(cfg.conversationId, { after: 0, ms: act.watchMs, until: () => false });
    r.watched = { count: w.events.length, types: [...new Set(w.events.map((e) => e.type))], lastSeq: w.events.at(-1)?.seq ?? 0, sawEnd: w.events.some((e) => e.type === 'end') };
  }
  if (act.abort) {
    const before = (await projectOf(page, cfg.projectId)).rev;
    const stream = api.events(cfg.conversationId, { after: r.watched?.lastSeq ?? 0, ms: 15_000 });
    await sleep(300);
    const t0 = Date.now();
    r.abort = await api.abort(cfg.conversationId);
    const s = await stream;
    const end = s.events.find((e) => e.type === 'end');
    r.aborted = { end: end ? { state: end.state, reason: end.reason ?? null } : null, ms: end ? end._at - t0 : null, status: s.events.find((e) => e.type === 'status')?.text ?? null };
    const a = (await projectOf(page, cfg.projectId)).rev;
    await sleep(1500);
    const b = (await projectOf(page, cfg.projectId)).rev;
    r.aborted.rev = { before, afterStop: a, later: b };
    r.aborted.meta = (await api.meta(cfg.conversationId)).meta ?? null;
  }
  if (act.say) {
    const lastSeq = (await api.meta(cfg.conversationId)).meta?.lastSeq ?? 0;
    const sent = await api.send(cfg.conversationId, act.say);
    const s = sent.status === 202 ? await api.events(cfg.conversationId, { after: lastSeq, ms: 60_000 }) : { events: [] };
    r.said = { status: sent.status, code: sent.code ?? null, firstSeq: sent.seq ?? null, prevLastSeq: lastSeq, end: s.events.find((e) => e.type === 'end')?.state ?? null, from: s.events.find((e) => e.type === 'user')?.from ?? null, toolResults: s.events.filter((e) => e.type === 'tool_result').map((e) => e.ok) };
  }
  if (act.replay) {
    const s = await api.events(cfg.conversationId, { after: 0, ms: 20_000, until: (e) => (act.replayUntilSeq === undefined ? e.type === 'end' : e.seq >= act.replayUntilSeq) });
    r.replay = s.events.map(({ _at, ...e }) => e);
    r.meta = (await api.meta(cfg.conversationId)).meta ?? null;
  }
  if (act.project) {
    const p = await projectOf(page, cfg.projectId);
    r.project = { rev: p.rev, clips: p.project?.tracks?.flatMap((t) => t.clips.map((c) => ({ id: c.id, label: c.label ?? null, start: c.start, end: c.end, params: c.params ?? {} }))) ?? null };
    const map = await page.ask({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${cfg.projectId}` });
    r.layers = { found: map.type === 'content.item' && !map.missing, layers: Array.isArray(map.body?.layers) ? map.body.layers.length : 0, rev: map.body?.projectRev ?? map.body?.rev ?? null };
  }
  if (act.undo) {
    // 「撤销这一步」:从文档服务的事件模块取这次工具调用的完成事件(带 opId 与逆操作),以自己的身份提交逆操作
    const listing = await page.ask({ type: 'events.list', projectId: cfg.projectId });
    const items = listing.items ?? [];
    const target = [...items].reverse().find((e) => Array.isArray(e.inverse) && e.inverse.length && (act.undo.callId ? e.callId === act.undo.callId : true));
    r.undo = { listed: items.length, withInverse: items.filter((e) => Array.isArray(e.inverse) && e.inverse.length).length, found: !!target };
    if (target) {
      const who = target.actor ?? target.by ?? target.identity ?? null;
      r.undo.event = { callId: target.callId ?? null, tool: target.tool ?? target.name ?? null, opId: target.opId ?? null, rev: target.rev ?? null, inverseOps: target.inverse.length, actor: who ? { userId: who.userId, role: who.role, service: who.service ?? null } : null };
      const before = await projectOf(page, cfg.projectId);
      const res = await page.ask({ type: 'project.op', projectId: cfg.projectId, opId: `undo-${randomBytes(4).toString('hex')}`, session: 'page-undo', ops: target.inverse });
      const after = await projectOf(page, cfg.projectId);
      r.undo.submit = res.type === 'project.op.ok' ? 'ok' : `${res.type}:${res.reason ?? ''}`;
      r.undo.rev = [before.rev, after.rev];
      r.undo.clip = after.project?.tracks?.flatMap((t) => t.clips).find((c) => c.id === act.undo.clipId) ?? null;
    }
  }
  out(r);
  page.close();
  process.exit(0);
}

/* ================================================================== 主进程 */

const ALL_STEPS = ['leave', 'later', 'reopen', 'stop', 'errors', 'load'];
const STEPS = String(argOf('--steps', ALL_STEPS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const DOC_PORT = Number(argOf('--doc-port', 8798));
const ASSET_PORT = Number(argOf('--asset-port', 8799));
const AGENT_PORT = Number(argOf('--agent-port', 5741));
const RENDER_PORT = Number(argOf('--render-port', 5830));
const KEEP = args.includes('--keep');
const VERBOSE = args.includes('--verbose');
const BASE = `ws://127.0.0.1:${DOC_PORT}`;
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
const RENDER_STATUS = `http://127.0.0.1:${RENDER_PORT + 6}`;
const RENDER_STALL_MS = 12_000;

const { results, check } = createChecks();
const note = (step, fields = {}) => { if (VERBOSE) process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-ux-'));
const D = { hosted: path.join(tmp, 'hosted'), agent: path.join(tmp, 'agent'), agentSecrets: path.join(tmp, 'agent-secrets'), render: path.join(tmp, 'render'), renderSecrets: path.join(tmp, 'render-secrets') };
let hosted = null;
let agent = null;
let render = null;
const children = new Set();
const timings = {};

function startRender() {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') env[k] = undefined;
  render = startProcess(path.join(ROOT, 'server', 'hosted-render', 'main.mjs'), {
    ipc: true,
    env: {
      ...env,
      PROMPTCUT_RENDER_DOC_URL: BASE, PROMPTCUT_RENDER_SECRETS: D.renderSecrets, PROMPTCUT_RENDER_DATA: D.render,
      PROMPTCUT_RENDER_PORT: String(RENDER_PORT), PROMPTCUT_RENDER_STATUS_PORT: String(RENDER_PORT + 6),
      PROMPTCUT_RENDER_MAX_CONCURRENT: '2', PROMPTCUT_RENDER_SAMPLE_MS: '2000', PROMPTCUT_RENDER_MEM_LOW: '256M',
      PROMPTCUT_RENDER_EDITOR_DIR: path.join(tmp, 'no-editor'), PROMPTCUT_RENDER_AGENT_STATUS_URL: `${AGENT_URL}/healthz`,
      ...(process.platform === 'win32' && !process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ? { PROMPTCUT_TEST_ENV_FINGERPRINT: '7e57c10d00000002' } : {}),
    },
  });
  return render;
}
const renderStatus = async () => (await fetch(`${RENDER_STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();
const waitRenderReady = () => waitFor(async () => { const s = await renderStatus(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪', 1000);
async function stopRender() {
  const r = render;
  render = null;
  if (!r) return;
  await r.stop(30_000);
  killTree(r.child.pid);
}
/** 渲染服务的目录里这个项目此刻有没有成员在线(不开任何成员连接就能看) */
const membersOnline = async (projectId) => (await renderStatus()).directory?.list?.find((p) => p.projectId === projectId)?.members ?? null;

/** 起一个扮演页面的子进程 */
function spawnPage(cfg) {
  const child = spawn(process.execPath, [SELF, '--child'], { cwd: ROOT, env: { ...process.env, PC_UX_CHILD: JSON.stringify({ base: BASE, agentUrl: AGENT_URL, ...cfg }) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const lines = [];
  let tail = '';
  child.stdout.on('data', (b) => {
    const parts = (tail + b.toString('utf8')).split('\n');
    tail = parts.pop() ?? '';
    for (const l of parts) { try { lines.push(JSON.parse(l)); } catch { /* 不是 JSON */ } }
  });
  let err = '';
  child.stderr.on('data', (b) => { err = (err + b.toString('utf8')).slice(-2000); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
  return { child, lines, exited, stderr: () => err };
}
/** 一次性的访客进程(重新打开、另一台设备):等它打出结果 */
async function visit(cfg, ms = 120_000) {
  const p = spawnPage({ role: 'visitor', ...cfg });
  const done = await Promise.race([p.exited, sleep(ms).then(() => null)]);
  if (!done) { p.child.kill('SIGKILL'); throw new Error('访客进程超时'); }
  const r = p.lines.find((l) => l.event === 'result');
  if (!r) throw new Error(`访客进程没有结果(退出码 ${done.code}):${p.stderr().slice(-400)}`);
  return r;
}
/** 发起方进程:发出任务,等事件流里出现第 n 个工具结果(已被云端接下),然后真的结束它 */
async function initiateAndLeave(cfg, n = 2) {
  const p = spawnPage({ role: 'initiator', ...cfg });
  await waitFor(() => p.lines.some((l) => l.event === 'sent') || p.child.exitCode !== null, 60_000, '发起方发出消息');
  const sent = p.lines.find((l) => l.event === 'sent') ?? null;
  if (!sent || sent.status !== 202) { p.child.kill('SIGKILL'); return { sent, killed: false, seen: 0, stderr: p.stderr() }; }
  await waitFor(() => p.lines.filter((l) => l.event === 'ev' && l.type === 'tool_result').length >= n, 60_000, `事件流里出现第 ${n} 个工具结果`);
  const seen = p.lines.filter((l) => l.event === 'ev').length;
  const pid = p.child.pid;
  p.child.kill('SIGKILL');
  const exit = await Promise.race([p.exited, sleep(5000).then(() => null)]);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  return { sent, killed: !!exit && !alive, exit, pid, seen };
}

const HEAVY = ['clip-stateful', 'clip-canvas'];
function projectDoc(id, salt) {
  return {
    version: 1, id, name: '云端 Agent 用户体验探针', width: 1920, height: 1080, fps: 30, duration: 3, themeId: 'dark', camera3dFov: 50,
    media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, transitions: [],
    tracks: [
      { id: 'tr-0', name: '图表', hidden: false, clips: [{ id: 'clip-bars', kind: 'card', cardId: 'rank-bars', start: 0, end: 3, params: { title: '原文案', rows: '微信,85|抖音,62', suffix: '%' } }] },
      { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] },
      { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: { probeSalt: salt } }] },
    ],
  };
}
/** 第 i 次写入(从 1 起):改文案、挪片段、调卡片参数轮着来 */
let moveSeq = 0;
let MAIN_SALT = null;
function writeStep(i, salt) {
  // 主任务(步骤 leave)的值是固定的,好在后面逐个核对;别的任务每次写的值都与现状不同(同值的写入不产生新版本,数不清)
  const main = salt === MAIN_SALT;
  if (i % 3 === 1) return { tool: 'update_clip', input: { clipId: 'clip-bars', params: { title: main ? `第 ${i} 次:改文案` : `${salt} 第 ${i} 次:改文案` } } };
  if (i % 3 === 2) return { tool: 'update_clip', input: { clipId: 'clip-stateful', start: 0, end: main ? 3 - (i % 2 ? 0.5 : 1) : Number((1.01 + ((moveSeq += 1) % 39) / 20).toFixed(2)) } };
  return { tool: 'update_clip', input: { clipId: 'clip-bars', params: { rows: `微信,${50 + i}|抖音,62|${salt},${i}` } } };
}
const writeScript = (n, gapMs, salt, tail = [{ say: '都做完了' }]) => mockScript([...Array.from({ length: n }, (_, k) => [{ sleepMs: gapMs }, writeStep(k + 1, salt)]).flat(), ...tail]);
const clipOf = (project, id) => project?.tracks?.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
const intact = (project) => !!project && Array.isArray(project.tracks) && project.tracks.length === 3 && ['clip-bars', 'clip-stateful', 'clip-canvas'].every((id) => !!clipOf(project, id));
const agentLogCount = (event, projectId) => agent.logs.filter((l) => l.event === event && (!projectId || l.projectId === projectId)).length;
const convDirs = (projectId) => { const dir = path.join(D.agent, 'tenants', projectId); return fs.existsSync(dir) ? dir : null; };
/** 从 Agent 服务盘上找一个对话的 meta 与事件记录(探针自己的临时目录;成员回不来时用) */
function diskConversation(projectId, conversationId) {
  const root = convDirs(projectId);
  if (!root) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const p = path.join(dir, item.name);
      if (item.name === conversationId && fs.existsSync(path.join(p, 'meta.json'))) {
        const events = fs.existsSync(path.join(p, 'events.jsonl')) ? fs.readFileSync(path.join(p, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
        return { meta: JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8')), events };
      }
      stack.push(p);
    }
  }
  return null;
}
const quiet = async (observer, docId) => { const a = (await projectOf(observer, docId)).rev; await sleep(1500); const b = (await projectOf(observer, docId)).rev; return a === b; };
const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };

async function main() {
  for (const s of STEPS) if (!ALL_STEPS.includes(s)) throw new Error(`不认识的步骤 ${s}`);
  for (const [name, port] of [['文档服务', DOC_PORT], ['素材服务', ASSET_PORT], ['Agent 服务', AGENT_PORT], ['渲染工作进程', RENDER_PORT], ['渲染工作进程', RENDER_PORT + 1], ['渲染工作进程', RENDER_PORT + 2], ['渲染管理进程', RENDER_PORT + 6]]) {
    if (await portBusy(port)) throw new Error(`端口 ${port}(${name})已被占用`);
  }
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.renderSecrets, '--instance-name', '托管方的渲染节点(探针)']);
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.agentSecrets, '--service', 'agent', '--instance-name', '云端 Agent(探针)']);
  hosted = await startHosted({ dataDir: D.hosted, docPort: DOC_PORT, assetPort: ASSET_PORT, env: { PROMPTCUT_AGENT_PUBLIC_URL: `${AGENT_URL}/v1` } });

  const pw = () => `pw-${randomBytes(6).toString('hex')}`;
  const creds = { alice: { username: 'alice', password: pw() }, bob: { username: 'bob', password: pw() }, carol: { username: 'carol', password: pw() } };
  const tag = randomBytes(4).toString('hex');
  const proj = { ...(await createSharedProject({ base: BASE, name: `ux-${tag}`, mode: 'restricted', creator: creds.alice, list: [creds.bob, creds.carol], kdf: KDF })), creator: creds.alice };
  const PID = proj.projectId;
  const salt = `ux-${tag}`;
  MAIN_SALT = salt;
  const dev = { a1: { deviceId: `ux-${tag}-alice-desktop-01`, deviceName: 'alice 的电脑' }, a2: { deviceId: `ux-${tag}-alice-laptop-002`, deviceName: 'alice 的笔记本' }, carol: { deviceId: `ux-${tag}-carol-desktop-1`, deviceName: 'carol 的电脑' } };
  const aliceCfg = (device) => ({ projectId: PID, username: 'alice', password: creds.alice.password, as: 'creator', device });
  {
    const seed = await joinAs(BASE, proj, { ...creds.alice, as: 'creator', device: dev.a1 });
    await putProject(seed, PID, projectDoc(PID, salt));
    seed.close();
  }
  const SEED_REV = 1;

  startRender();
  const bootAgent = async (env = {}) => { await agent?.stop(); agent = await startAgent({ dataDir: D.agent, secrets: D.agentSecrets, docPort: DOC_PORT, port: AGENT_PORT, env }); agent.shortStall = !!env.PROMPTCUT_AGENT_RENDER_STALL_MS; };
  await bootAgent();
  const ready = await waitRenderReady();
  const agentHealth = await (await fetch(`${AGENT_URL}/healthz`)).json();
  check('U0 三个服务起来;Agent 服务与渲染服务的代码版本相同(同一个提交)', ready.queue.codeVersion === agentHealth.codeVersion && !!agentHealth.codeVersion, {
    renderCodeVersion: String(ready.queue.codeVersion).slice(0, 12), agentCodeVersion: String(agentHealth.codeVersion).slice(0, 12), agentAuth: agent.ready?.auth ?? null, heapLimitMb: agent.ready?.heapLimitMb ?? null,
  });
  const blobBytes = () => { let n = 0; const walk = (d) => { if (!fs.existsSync(d)) return; for (const i of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, i.name); if (i.isDirectory()) walk(p); else n += 1; } }; walk(path.join(D.hosted, 'assets')); return n; };
  const assetFilesBefore = blobBytes();

  let mainEvents = null;
  const N = 12;
  const rowsOf = (i) => `微信,${50 + i}|抖音,62|${salt},${i}`;

  /* ---------------------------------------------------------------- 一、二 */
  if (STEPS.includes('leave')) {
    const t0 = Date.now();
    const left = await initiateAndLeave({ ...aliceCfg(dev.a1), conversationId: 'ux-main', prompt: writeScript(N, 1200, salt), pageState: { t: 1, selection: ['clip-bars'] } }, 2);
    timings.acceptedMs = Date.now() - t0;
    await waitFor(async () => (await membersOnline(PID)) === false, 10_000, '成员连接都断开').catch(() => null);
    const membersAfterKill = await membersOnline(PID);
    check('U1 发起方发出任务、被云端接下后进程被真的结束;项目里没有任何成员连接', left.sent?.status === 202 && left.killed && membersAfterKill === false, {
      sent: left.sent?.status ?? null, eventsSeenBeforeLeaving: left.seen, pid: left.pid, exit: left.exit, processGone: left.killed, membersOnline: membersAfterKill,
    });
    // 之后:不开任何成员连接,只看 Agent 服务与渲染服务自己报的
    let sawMembers = false;
    const polling = setInterval(() => { void membersOnline(PID).then((m) => { if (m === true) sawMembers = true; }).catch(() => {}); }, 500);
    const endLog = await waitFor(() => agent.logs.find((l) => l.event === 'agent.run.end' && l.projectId === PID), 120_000, '对话跑到结束', 200);
    timings.runMs = Date.now() - t0;
    const rendered = await waitFor(() => agent.logs.find((l) => (l.event === 'agent.render.done' || l.event === 'agent.render.failed' || l.event === 'agent.render.unavailable' || l.event === 'agent.render.gave-up') && l.projectId === PID), 400_000, '补渲有结果', 500);
    timings.renderedMs = Date.now() - t0;
    clearInterval(polling);
    const disk = diskConversation(PID, 'ux-main');
    mainEvents = disk?.events ?? [];
    const toolOk = mainEvents.filter((e) => e.type === 'tool_result' && e.ok === true).length;
    check('U2 没有任何成员在线,对话跑到结束,12 次写入全部落地', endLog.state === 'idle' && toolOk === N && sawMembers === false && disk?.meta?.state === 'idle', {
      end: endLog.state, writesLanded: toolOk, membersEverOnline: sawMembers, runMs: timings.runMs, metaState: disk?.meta?.state ?? null, lastSeq: disk?.meta?.lastSeq ?? null,
    });
    const st = await renderStatus();
    const node = (st.queue?.nodes ?? []).find((n) => n.projectId === PID) ?? null;
    const renderEvents = mainEvents.filter((e) => e.type === 'render').map((e) => ({ state: e.state, clips: e.clips?.length ?? 0, ...(e.reason ? { reason: e.reason } : {}) }));
    const published = agent.logs.filter((l) => l.event === 'agent.publish.plan' && l.projectId === PID);
    check('U3 被改动的重卡由渲染服务渲出来、产物入库(全程没有成员在线)', rendered.event === 'agent.render.done' && (node?.completed ?? 0) > 0 && (node?.failed ?? 0) === 0 && blobBytes() > assetFilesBefore && sawMembers === false
      && renderEvents.some((e) => e.state === 'published') && renderEvents.at(-1)?.state === 'done', {
      outcome: rendered.event, renderEvents, plansPublished: published.length, renderNode: node ? { claimed: node.claimed, completed: node.completed, dedup: node.dedup, failed: node.failed } : null,
      assetFiles: [assetFilesBefore, blobBytes()], renderedMs: timings.renderedMs, membersEverOnline: sawMembers,
    });
  }

  /* ---------------------------------------------------------------- 三 */
  let bob = null;
  if (STEPS.includes('later')) {
    bob = await joinAs(BASE, proj, creds.bob);
    const p = await projectOf(bob, PID);
    const listing = await bob.ask({ type: 'events.list', projectId: PID });
    const items = listing.items ?? [];
    const writesSeen = items.filter((e) => e.opId !== undefined && e.opId !== null);
    const actors = writesSeen.map((e) => e.actor ?? e.by ?? e.identity ?? {});
    const members = await bob.ask({ type: 'shared.members' });
    const title = clipOf(p.project, 'clip-bars');
    const canvas = title;
    check('U4 另一位成员之后进项目:读到每一条改动,署名是创建者本人加 service: agent', p.rev === SEED_REV + N && title?.params?.title === '第 10 次:改文案' && canvas?.params?.rows === rowsOf(12) && clipOf(p.project, 'clip-stateful')?.end === 2.5
      && writesSeen.length === N && actors.every((a) => String(a.userId ?? '').startsWith('alice@') && a.role === 'agent' && a.service === 'agent') && members.hosted?.agent?.available === true, {
      rev: [SEED_REV, p.rev], title: title?.params?.title ?? null, rowsAreTwelfth: canvas?.params?.rows === rowsOf(12), statefulEnd: clipOf(p.project, 'clip-stateful')?.end ?? null,
      toolEventsWithWrite: writesSeen.length, writers: [...new Set(actors.map((a) => `${String(a.userId ?? '').split('@')[0]}/${a.role}/${a.service ?? '-'}`))], hostedAgent: members.hosted?.agent ?? null,
    });
    const map = await bob.ask({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${PID}` });
    const list = await bob.ask({ type: 'content.list', kind: 'snapshot-manifest' });
    const ticket = await bob.ask({ type: 'auth.ticket', kind: 'asset', access: 'r' });
    const keys = (list.items ?? []).map((i) => i.key).filter((k) => !k.startsWith('layers:'));
    let found = 0; let missing = 0;
    for (const key of keys.slice(0, 4)) {
      const item = await bob.ask({ type: 'content.get', kind: 'snapshot-manifest', key });
      for (const hash of [...new Set(JSON.stringify(item.body ?? {}).match(/\b[0-9a-f]{64}\b/g) ?? [])].slice(0, 5)) {
        let ok = false;
        for (const ns of ['snap', 'px']) {
          const res = await fetch(`http://127.0.0.1:${ASSET_PORT}/api/asset/${ns}/${hash}`, { method: 'HEAD', headers: { authorization: `Bearer ${ticket.ticket}` } });
          if (res.status === 200) { ok = true; break; }
        }
        if (ok) found += 1; else missing += 1;
      }
    }
    const layers = Array.isArray(map.body?.layers) ? map.body.layers.length : 0;
    const mapRev = map.body?.projectRev ?? map.body?.rev ?? null;
    check('U5 他不发任何渲染任务,直接取得到这一版的层表、清单与产物', map.type === 'content.item' && !map.missing && layers > 0 && keys.length > 0 && found > 0 && (mapRev === null || mapRev === SEED_REV + N), {
      layerMap: map.type === 'content.item' && !map.missing, layers, layerMapRev: mapRev, manifests: keys.length, blobsFound: found, blobsMissing: missing, publishedByBob: bob.all.filter((m) => m.type === 'task.published').length,
    });
  }

  /* ---------------------------------------------------------------- 四 */
  if (STEPS.includes('reopen')) {
    bob ??= await joinAs(BASE, proj, creds.bob);
    const lastWrite = [...(mainEvents ?? [])].reverse().find((e) => e.type === 'tool_call');
    const r = await visit({ ...aliceCfg(dev.a1), conversationId: 'ux-main', do: { replay: true, replayUntilSeq: mainEvents?.at(-1)?.seq, project: true, undo: { callId: lastWrite?.callId, clipId: 'clip-bars' } } });
    const replay = r.replay ?? [];
    // 盘上的事件记录把一轮里逐字的回复并成了整段(补发时拆回原来的增量),所以逐条比的是回复正文之外的全部事件,正文比拼起来的整段
    const solid = (list) => list.filter((e) => e.type !== 'text' && e.type !== 'thinking').map((e) => JSON.stringify(e));
    const textOf = (list) => list.filter((e) => e.type === 'text').map((e) => e.delta ?? e.text ?? '').join('');
    const a = solid(replay); const b = solid(mainEvents ?? []);
    const same = a.length === b.length && a.every((x, i) => x === b[i]) && textOf(replay) === textOf(mainEvents ?? []) && textOf(replay).includes('都做完了');
    const seqOk = replay.every((e, i) => i === 0 || e.seq > replay[i - 1].seq) && replay[0]?.seq === 1;
    const item = (r.list ?? []).find((i) => i.id === 'ux-main');
    check('U6 创建者重新打开(新进程、同一身份):列得出对话,完整过程从头补齐,项目是最新版本,预渲染结果已在', !!item && item.state === 'idle' && same && seqOk
      && replay.filter((e) => e.type === 'tool_call').length === N && replay.some((e) => e.type === 'end' && e.state === 'idle') && replay.some((e) => e.type === 'render' && e.state === 'done')
      && replay[0]?.type === 'user' && r.project?.rev === SEED_REV + N && r.layers?.found === true && r.layers.layers > 0 && (r.info?.running ?? []).length === 0, {
      listed: item ? { title: item.title, state: item.state, lastSeq: item.lastSeq, startedOn: item.startedOn } : null, replayed: replay.length, onDisk: mainEvents?.length ?? null, identicalToServerRecord: same, seqContinuous: seqOk,
      types: [...new Set(replay.map((e) => e.type))], toolCalls: replay.filter((e) => e.type === 'tool_call').length, projectRev: r.project?.rev ?? null, layers: r.layers ?? null, running: r.info?.running ?? null,
    });
    await sleep(500);
    const seen = await projectOf(bob, PID);
    const u = r.undo ?? {};
    check('U7 撤销能撤掉 Agent 的改动:重开后取得到逆操作,以创建者自己的身份提交,别的成员看到结果', u.found === true && u.event?.actor?.service === 'agent' && u.event?.actor?.role === 'agent' && String(u.event?.actor?.userId ?? '').startsWith('alice@')
      && u.submit === 'ok' && u.rev?.[1] === u.rev?.[0] + 1 && u.clip?.params?.rows === rowsOf(9) && clipOf(seen.project, 'clip-bars')?.params?.rows === rowsOf(9) && seen.rev === SEED_REV + N + 1, {
      eventsListed: u.listed ?? null, withInverse: u.withInverse ?? null, undone: u.event ?? null, submit: u.submit ?? null, rev: u.rev ?? null,
      rowsBackToNinth: u.clip?.params?.rows === rowsOf(9), otherMemberSees: clipOf(seen.project, 'clip-bars')?.params?.rows === rowsOf(9), otherMemberRev: seen.rev,
    });
  }

  /* ---------------------------------------------------------------- 五 */
  if (STEPS.includes('stop')) {
    bob ??= await joinAs(BASE, proj, creds.bob);
    const startRev = (await projectOf(bob, PID)).rev;
    const mark = bob.all.length;
    const left = await initiateAndLeave({ ...aliceCfg(dev.a1), conversationId: 'ux-stop', prompt: writeScript(40, 900, `${salt}-s`) }, 2);
    await sleep(4500);
    const ops = bob.all.slice(mark).filter((m) => m.type === 'project.ops');
    const whos = ops.map((m) => m.by ?? m.identity ?? m.actor ?? {});
    const members = await bob.ask({ type: 'shared.members' });
    const aliceRow = (members.devices ?? []).filter((d) => d.username === 'alice');
    const agentConns = aliceRow.flatMap((d) => (d.conns ?? []).filter((c) => c.service === 'agent'));
    const pageConns = aliceRow.flatMap((d) => (d.conns ?? []).filter((c) => c.role === 'page'));
    check('U8 另一位成员在线看着:改动一条条到达,署名是「alice 的云端 Agent」所需的字段;成员列表里看得到', left.killed && ops.length >= 4 && whos.every((w) => String(w.userId ?? '').startsWith('alice@') && w.role === 'agent' && w.service === 'agent')
      && new Set(ops.map((m) => m.rev)).size === ops.length && agentConns.length >= 1 && pageConns.length === 0, {
      initiatorGone: left.killed, opsArrived: ops.length, revs: ops.map((m) => m.rev).slice(0, 8), writer: whos[0] ? { username: String(whos[0].userId).split('@')[0], role: whos[0].role, service: whos[0].service } : null,
      aliceRow: { agentConnections: agentConns.length, pageConnections: pageConns.length, tags: aliceRow[0]?.tags ?? null },
    });
    // 另一台设备(另一个设备号、同一创建者身份):看得到在跑的,接着看,停掉,接着说
    const r = await visit({ ...aliceCfg(dev.a2), conversationId: 'ux-stop', do: { watchMs: 3000, abort: true, say: mockScript([{ tool: 'update_clip', input: { clipId: 'clip-bars', label: '换了设备接着说' } }, { say: '接上了' }]), project: true } });
    const a = r.aborted ?? {};
    check('U9 另一台设备打开同一个对话:看得到在跑的并接着看;停掉后 2 秒内收尾、项目停在最后一次成功写入;接着说,新一轮正常跑完', (r.info?.running ?? []).includes('ux-stop') && (r.list ?? []).some((i) => i.id === 'ux-stop' && i.state === 'running')
      && r.watched?.count > 5 && r.watched.types.includes('tool_result') && !r.watched.sawEnd && a.end?.state === 'idle' && a.ms !== null && a.ms <= 2000 && a.rev?.afterStop === a.rev?.later && a.rev.afterStop > startRev && a.rev.afterStop < startRev + 40
      && a.meta?.state === 'idle' && a.meta?.reason === 'stopped' && r.said?.status === 202 && r.said.end === 'idle' && r.said.firstSeq === r.said.prevLastSeq + 1 && r.said.from === dev.a2.deviceName
      && clipOf({ tracks: [{ clips: r.project?.clips ?? [] }] }, 'clip-bars')?.label === '换了设备接着说', {
      running: r.info?.running ?? null, watched: r.watched ?? null, stop: a.end ?? null, stoppedInMs: a.ms ?? null, statusText: a.status ?? null, rev: a.rev ?? null, recorded: a.meta ? { state: a.meta.state, reason: a.meta.reason } : null,
      continued: r.said ?? null, label: r.project?.clips?.find((c) => c.id === 'clip-bars')?.label ?? null,
    });
  }

  /* ---------------------------------------------------------------- 六 */
  if (STEPS.includes('errors')) {
    bob ??= await joinAs(BASE, proj, creds.bob);
    /** 跑一遍:发起、离开、等收尾;回 { before, after, meta, events, quiet, intact } */
    async function offlineRun(cfg, id, prompt, { during } = {}) {
      const before = (await projectOf(bob, PID)).rev;
      const left = await initiateAndLeave({ ...cfg, conversationId: id, prompt }, 1);
      if (during) await during();
      const disk = await waitFor(() => { const d = diskConversation(PID, id); return d && d.meta.state !== 'running' ? d : null; }, 90_000, `${id} 收尾`, 200);
      const calm = await quiet(bob, PID);
      const after = await projectOf(bob, PID);
      const ok = disk.events.filter((e) => e.type === 'tool_result' && e.ok === true).length;
      return { left, before, after, disk, calm, ok, err: disk.events.find((e) => e.type === 'error') ?? null, whole: intact(after.project) };
    }
    const brief = (x) => ({ initiatorGone: x.left.killed, recorded: { state: x.disk.meta.state, reason: x.disk.meta.reason }, message: x.err?.message ?? null, code: x.err?.code ?? null, writesLanded: x.ok, rev: [x.before, x.after.rev], noWritesAfter: x.calm, projectIntact: x.whole, hasEnd: x.disk.events.at(-1)?.type === 'end' || x.disk.events.some((e) => e.type === 'end') });
    const sane = (x, n) => x.left.killed && x.after.rev === x.before + n && x.ok === n && x.calm && x.whole && x.disk.events.some((e) => e.type === 'end');

    // 模型调用失败
    {
      const x = await offlineRun(aliceCfg(dev.a1), 'ux-fail-model', mockScript([{ sleepMs: 300 }, writeStep(1, 'm'), { sleepMs: 300 }, writeStep(4, 'm'), { fail: '上游接口 500(探针注入)' }, writeStep(7, 'm')]));
      check('U10 模型调用失败:对话记录里留下原因,项目停在失败前最后一次成功写入', sane(x, 2) && x.disk.meta.state === 'failed' && x.disk.meta.reason === 'model' && x.err?.code === 'model' && /模型调用失败/.test(x.err?.message ?? '')
        && clipOf(x.after.project, 'clip-bars')?.params?.title === 'm 第 4 次:改文案', brief(x));
    }
    // 额度用尽
    {
      const admin = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'agent-service', 'admin.mjs'), ...a], { cwd: ROOT, env: { ...process.env, PROMPTCUT_AGENT_DATA: D.agent }, windowsHide: true, encoding: 'utf8' });
      const usage = JSON.parse(admin('usage', '--project', PID, '--json').stdout || '{}');
      const used = usage.projects?.[PID]?.tokens ?? usage.project?.tokens ?? usage.tokens ?? null;
      const usedNow = Number.isFinite(used) ? used : (await agentApi(AGENT_URL, bob).call('GET', '/v1/usage')).project?.tokens ?? 0;
      const set = admin('quota', 'set', PID, '--tokens', String(usedNow + 1));
      await sleep(300);
      const x = await offlineRun(aliceCfg(dev.a1), 'ux-fail-quota', mockScript([writeStep(1, 'q'), { sleepMs: 300 }, writeStep(4, 'q'), writeStep(7, 'q'), { say: '不会到' }]));
      const refused = await agentApi(AGENT_URL, bob).send('ux-bob-quota', mockScript([{ say: 'x' }]));
      admin('quota', 'clear', PID);
      await sleep(300);
      const again = await agentApi(AGENT_URL, bob).send('ux-bob-quota', mockScript([{ say: '额度清掉后恢复' }]));
      if (again.status === 202) await agentApi(AGENT_URL, bob).settled('ux-bob-quota');
      check('U11 额度用尽:对话记录里留下带已用与上限的原因,已落地的保留;之后的请求被明确拒绝,清掉额度后恢复', set.status === 0 && sane(x, 1) && x.disk.meta.state === 'failed' && x.disk.meta.reason === 'quota-exceeded'
        && /额度已用完\(已用 \d+ \/ 上限 \d+\)/.test(x.err?.message ?? '') && refused.status === 429 && refused.code === 'quota-exceeded' && again.status === 202, { ...brief(x), nextRequest: `${refused.status}:${refused.code}`, afterClear: again.status });
    }
    // 创建者中途关了开关(从另一台设备)
    {
      const owner2 = await joinAs(BASE, proj, { ...creds.alice, as: 'creator', device: dev.a2 });
      const x = await offlineRun(aliceCfg(dev.a1), 'ux-fail-switch', writeScript(30, 400, 'sw'), { during: async () => { await sleep(900); await adminOp(owner2, proj, 'set-hosted-service', { service: 'agent', enabled: false }); } });
      const on = await adminOp(owner2, proj, 'set-hosted-service', { service: 'agent', enabled: true });
      owner2.close();
      await sleep(300);
      check('U12 创建者中途关了开关:对话被停掉,记录里留下原因,项目停在完好的版本上', x.left.killed && x.disk.meta.state === 'revoked' && x.disk.meta.reason === 'disabled' && x.err?.code === 'revoked' && /已关闭云端 Agent/.test(x.err?.message ?? '')
        && x.ok >= 1 && x.ok < 30 && x.after.rev === x.before + x.ok && x.calm && x.whole && on.type === 'shared.admin.ok', brief(x));
    }
    // 发起成员中途被移出
    {
      const owner2 = await joinAs(BASE, proj, { ...creds.alice, as: 'creator', device: dev.a2 });
      const x = await offlineRun({ projectId: PID, username: 'carol', password: creds.carol.password, as: 'member', device: dev.carol }, 'ux-fail-removed', writeScript(30, 400, 'rm'), {
        during: async () => { await sleep(900); await adminOp(owner2, proj, 'set-list', { list: [{ username: 'bob', keep: true }] }); },
      });
      owner2.close();
      // 改名单让项目代数加一:bob 的连接还在,但要新委托得重新进入
      bob.close();
      bob = await joinAs(BASE, proj, creds.bob);
      const back = await joinAs(BASE, proj, { ...creds.carol, device: dev.carol });
      check('U13 发起成员中途被移出:对话被停掉,记录里留下原因,项目停在完好的版本上;他回不来', x.left.killed && x.disk.meta.state === 'revoked' && x.disk.meta.reason === 'removed' && x.err?.code === 'revoked' && /移出/.test(x.err?.message ?? '')
        && x.ok >= 1 && x.ok < 30 && x.after.rev === x.before + x.ok && x.calm && x.whole && back === null, { ...brief(x), removedMemberCanRejoin: back !== null });
      back?.close();
    }
    // 渲染失败:渲染服务停着
    {
      // 渲染服务停掉;Agent 服务重起一遍,把补渲「连续没有进度就放弃」的时限缩短(生产 10 分钟),别的步骤都用缺省值
      await stopRender();
      await bootAgent({ PROMPTCUT_AGENT_RENDER_STALL_MS: String(RENDER_STALL_MS) });
      const failedBefore = agentLogCount('agent.render.gave-up', PID) + agentLogCount('agent.render.failed', PID);
      const x = await offlineRun(aliceCfg(dev.a1), 'ux-fail-render', mockScript([writeStep(3, 'rf'), { sleepMs: 200 }, writeStep(2, 'rf'), { say: '改完了,渲染节点不在' }]));
      await waitFor(() => agentLogCount('agent.render.gave-up', PID) + agentLogCount('agent.render.failed', PID) > failedBefore, RENDER_STALL_MS * 4 + 20_000, '补渲放弃', 300);
      await sleep(300);
      const d = diskConversation(PID, 'ux-fail-render');
      const rf = d.events.filter((e) => e.type === 'render');
      const failed = rf.find((e) => e.state === 'failed');
      const after = await projectOf(bob, PID);
      check('U14 渲染失败:对话照常做完,对话记录里留下 render failed 与原因、涉及的片段;项目内容不受影响', sane(x, 2) && x.disk.meta.state === 'idle' && !!failed && typeof failed.reason === 'string' && failed.reason.length > 0
        && failed.clips?.includes('clip-bars') && rf.findIndex((e) => e.state === 'failed') > 0 && after.rev === x.after.rev && intact(after.project), {
        ...brief(x), renderEvents: rf.map((e) => ({ state: e.state, clips: e.clips ?? [], ...(e.reason ? { reason: e.reason } : {}) })), renderEventsAfterEnd: d.events.findIndex((e) => e.type === 'render') > d.events.findIndex((e) => e.type === 'end'),
        note: `渲染服务被探针停掉;补渲「连续没有进度」的时限在这次演练里缩成 ${RENDER_STALL_MS / 1000} 秒(生产 10 分钟,原因文字是固定的那一句)`,
      });
    }
  }

  /* ---------------------------------------------------------------- 附:节点资源 */
  if (STEPS.includes('load')) {
    bob ??= await joinAs(BASE, proj, creds.bob);
    if (agent.shortStall) await bootAgent();
    if (!render) { startRender(); await waitRenderReady(); }
    // 第二个项目:全节点 6 轮要两个项目各 3 轮(每项目上限 3、每成员上限 2)
    const c2 = { dan: { username: 'dan', password: pw() }, eve: { username: 'eve', password: pw() } };
    const proj2 = { ...(await createSharedProject({ base: BASE, name: `ux2-${tag}`, mode: 'restricted', creator: c2.dan, list: [c2.eve], kdf: KDF })), creator: c2.dan };
    const dan = await joinAs(BASE, proj2, { ...c2.dan, as: 'creator' });
    const eve = await joinAs(BASE, proj2, c2.eve);
    await putProject(dan, proj2.projectId, projectDoc(proj2.projectId, `${salt}-2`));
    const alice = await joinAs(BASE, proj, { ...creds.alice, as: 'creator', device: dev.a2 });
    const api = { alice: agentApi(AGENT_URL, alice), bob: agentApi(AGENT_URL, bob), dan: agentApi(AGENT_URL, dan), eve: agentApi(AGENT_URL, eve) };
    const sample = async (n, gap) => {
      const http = []; const ws = [];
      for (let i = 0; i < n; i += 1) {
        let t = performance.now();
        await (await fetch(`http://127.0.0.1:${DOC_PORT}/healthz`)).arrayBuffer();
        http.push(performance.now() - t);
        t = performance.now();
        await bob.ask({ type: 'project.open', projectId: PID });
        ws.push(performance.now() - t);
        await sleep(gap);
      }
      const f = (l) => ({ p50: Number(pct(l, 0.5).toFixed(1)), p95: Number(pct(l, 0.95).toFixed(1)), max: Number(Math.max(...l).toFixed(1)), n: l.length });
      return { healthz: f(http), projectOpen: f(ws) };
    };
    await sleep(3000);
    const idle = await sample(40, 100);
    const long = (who) => writeScript(60, 150, `${salt}-load-${who}`);
    const sends = [];
    sends.push(['alice#1', await api.alice.send('load-a1', long('a1'))], ['alice#2', await api.alice.send('load-a2', long('a2'))], ['bob#1', await api.bob.send('load-b1', long('b1'))]);
    const fourth = await api.bob.send('load-b2', long('b2'));
    sends.push(['dan#1', await api.dan.send('load-d1', long('d1'))], ['dan#2', await api.dan.send('load-d2', long('d2'))], ['eve#1', await api.eve.send('load-e1', long('e1'))]);
    const seventh = await api.eve.send('load-e2', long('e2'));
    check('U15 并发上限生效:每个项目同时 3 轮、全节点 6 轮,超出的回 429 busy', sends.every(([, s]) => s.status === 202) && fourth.status === 429 && fourth.code === 'busy' && seventh.status === 429 && seventh.code === 'busy', {
      accepted: sends.map(([k, s]) => `${k}:${s.status}`), fourthInProject: `${fourth.status}:${fourth.code}`, seventhOnNode: `${seventh.status}:${seventh.code}`,
    });
    await sleep(4000); // 让补渲的计划发出去、渲染服务开始渲
    const st0 = await renderStatus();
    const busy = await sample(40, 100);
    const st1 = await renderStatus();
    const mem = agent.child.pid ? spawnSync(process.platform === 'win32' ? 'powershell' : 'ps', process.platform === 'win32' ? ['-NoProfile', '-Command', `(Get-Process -Id ${agent.child.pid}).WorkingSet64`] : ['-o', 'rss=', '-p', String(agent.child.pid)], { windowsHide: true, encoding: 'utf8' }).stdout.trim() : '';
    const rssMb = mem ? Math.round(Number(mem) / (process.platform === 'win32' ? 1024 * 1024 : 1024)) : null;
    const running = [...(await api.alice.info()).running ?? [], ...(await api.dan.info()).running ?? []];
    const rendering = (st0.queue?.nodes ?? []).concat(st1.queue?.nodes ?? []).some((n) => (n.holding ?? n.running ?? n.claimedNow ?? 0) > 0) || (st1.queue?.nodes ?? []).some((n) => n.claimed > 0);
    check('U16 满载时同机文档服务的响应时间(6 轮对话同时写 + 渲染服务在渲),对比空闲时', busy.healthz.p95 < 500 && busy.projectOpen.p95 < 1000, {
      idle, loaded: busy, runsDuringSample: running.length, renderNodesBusy: rendering, agentRssMb: rssMb, agentHeapLimitMb: agent.ready?.heapLimitMb ?? null,
      note: '本机数字只作参考;门槛只卡「没有被拖垮」(healthz p95 < 500 ms,与渲染服务的背压线相同)',
    });
    for (const [a, ids] of [[api.alice, ['load-a1', 'load-a2']], [api.bob, ['load-b1']], [api.dan, ['load-d1', 'load-d2']], [api.eve, ['load-e1']]]) for (const id of ids) await a.abort(id);
    await sleep(500);
    for (const c of [dan, eve, alice]) c.close();
  }
  bob?.close();
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 2;
  process.stdout.write(`${JSON.stringify({ check: '探针自身', ok: false, error: String(err?.stack ?? err).slice(0, 1500), agentLogTail: agent ? agent.text().slice(-1200) : null })}\n`);
} finally {
  for (const c of [...children]) { try { c.kill('SIGKILL'); } catch { /* 已经没了 */ } }
  await agent?.stop();
  try { await stopRender(); } catch { /* 已停 */ }
  await hosted?.stop();
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着,留给系统清 */ } }
}
const failed = results.filter((r) => !r.ok);
if (code === 0 && failed.length) code = 1;
process.stdout.write(`${JSON.stringify({ ok: code === 0, passed: results.filter((r) => r.ok).length, failed: failed.map((r) => r.check), timings, ...(KEEP ? { tmp } : {}) })}\n`);
process.exit(code);
