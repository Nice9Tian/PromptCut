// 0.7.18「云端 Agent 工具表接线」的端到端探针。
//
// 起的是账号模式「一条任务一个进程」的整套生产接线(夹具 server/test/fixtures/account-runner-process.mjs,主服务用生产的装配):
// 网站账号后端、文档服务、独立进程的素材服务、Agent 主服务(只做控制)、槽调度,每条任务一个真的任务子进程(真实运行器)。
// **模型是仓库里的模拟模型**(server/harness/providers/mock.mjs):照用户消息里的脚本逐回合发工具调用,不连任何模型服务。
// 工具的结果从这个对话落盘的模型历史里读(任务进程每完成一次工具往返落一次),再去文档服务的项目、数据目录、进程表里核。
//
// 跑:PROMPTCUT_ACCOUNT_PROVIDER_ROOT=… PROMPTCUT_PASSWORD_ORDER_MODULE=… node scripts/probes/cloud-tools-wire-probe.mjs [--only a,b] [--keep]
// 端口:28890～28949(夹具 28890～28945,假站 28946,编辑器 dev server 28947～28949)。
// 输出:每项一行 `PROBE <名字> OK|FAIL|SKIP <细节>`,末行 `PROBE-RESULT pass|fail {…}`;退出码 0 = 没有 FAIL。SKIP 是「这台机器没有这样东西,没跑」,原因写在行里。
//
// 各段验什么见 main() 里的注释。root 看操作系统的那一半在 Windows 上是受控的(见夹具文件头),进程被关用「这个子进程真的退出了」代替。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRunnerProcessFixture, until } from '../../server/test/fixtures/account-runner-process.mjs';
import { hostedBrowserDir } from '../../server/agent/service/hosted-browser.mjs';
import { accountToolStateDir, BROWSER_PURGE_MARK } from '../../server/agent/service/account-tools.mjs';
import { CLOUD_PROVIDER_TOOLS } from '../../server/agent/service/cloud-tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORTS = Object.freeze({ combo: [28890, 28891, 28892, 28893, 28894, 28895, 28896], agent: 28897,
  masterEvents: 28898, look: 28899, renderWorker: 28900, identityBase: 28901, controlBase: 28923 });
const SITE_PORT = 28946, DEV_PORT = 28947;
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(String(args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)) : null;
const wants = (name) => !only || only.has(name);
const keep = args.includes('--keep');

const results = [];
const line = (name, state, detail = '') => { results.push({ name, state }); console.log(`PROBE ${name} ${state} ${detail}`.trimEnd()); };
const check = (name, ok, detail = '') => line(name, ok ? 'OK' : 'FAIL', detail);
const skip = (name, why) => line(name, 'SKIP', why);
const brief = (value, max = 260) => { let s; try { s = JSON.stringify(value); } catch { s = String(value); } return s === undefined ? 'undefined' : s.length > max ? `${s.slice(0, max)}…` : s; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const script = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;

/* ---------- 本机有什么 ---------- */

function findFfmpeg() {
  const fromEnv = process.env.PROMPTCUT_FFMPEG;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
  const found = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
  return found ?? null;
}
async function findBrowser() {
  if (process.env.W1_BROWSER && fs.existsSync(process.env.W1_BROWSER)) return process.env.W1_BROWSER;
  try { const puppeteer = (await import('puppeteer')).default; const p = await puppeteer.executablePath(); return p && fs.existsSync(p) ? p : null; } catch { return null; }
}
/** 可见窗口(探针前后各看一次,不许多出来) */
function visibleWindows() {
  if (process.platform !== 'win32') return [];
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg' } | ForEach-Object { \"$($_.ProcessName):$($_.Id)\" }"],
  { windowsHide: true, encoding: 'utf8' });
  return String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}
/** 命令行里带着某个目录的进程(按数据目录查残留的浏览器、ffmpeg、python) */
function processesUnder(dir) {
  const needle = dir.replace(/\\/g, '\\\\');
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { "$($_.Name):$($_.ProcessId)" }`],
    { windowsHide: true, encoding: 'utf8' });
    return String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => !/^powershell/i.test(s));
  }
  const r = spawnSync('pgrep', ['-af', needle], { encoding: 'utf8' });
  return String(r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => !s.includes('pgrep'));
}

/* ---------- 假站:一页能读到固定文字的网页 ---------- */

function startSite() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>wire probe site</title></head><body><h1>接线探针的假站</h1><p id="marker">WIRE-PROBE-MARKER-7391 这一段字是云端浏览器读到的。</p><a href="/next">下一页</a></body></html>');
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(SITE_PORT, '127.0.0.1', () => resolve({ hits, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }) })); });
}

/* ---------- 一条任务:发消息、等结清、读这一轮的工具结果 ---------- */

function makeHarness(f) {
  let seq = 0;
  const historyFile = (projectId, conversationId) => path.join(f.dataDir, 'tenants', projectId, 'conversations', conversationId, 'history.json');
  /** 这个对话落盘的模型历史里,最近一轮里每次工具调用的 { name, input, result } */
  function toolRounds(conversationId) {
    let messages;
    try { const raw = JSON.parse(fs.readFileSync(historyFile(f.projectId, conversationId), 'utf8')); messages = Array.isArray(raw) ? raw : raw.messages ?? raw.history ?? []; } catch { return []; }
    const uses = new Map(); const out = [];
    for (const m of messages) {
      for (const block of Array.isArray(m?.content) ? m.content : []) {
        if (block?.type === 'tool_use') uses.set(block.id, { name: block.name, input: block.input });
        if (block?.type === 'tool_result') {
          const use = uses.get(block.tool_use_id) ?? {};
          let text = typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '');
          let result = text; try { result = JSON.parse(text); } catch { /* 不是 JSON 就原样 */ }
          out.push({ name: use.name, input: use.input, result, isError: block.is_error === true });
        }
      }
    }
    return out;
  }
  /**
   * 发一条消息并等它的任务结清。回这一轮的工具结果(按脚本里工具调用的次序)。
   * `waitSettled: false`:只等任务开始做第一件事就回(之后由调用方去停、去杀)。
   */
  async function run(actor, conversationId, steps, { attachments, waitSettled = true, timeoutMs = 240_000, selection = true } = {}) {
    const requestId = `wire-${++seq}`;
    const before = toolRounds(conversationId).length;
    const sent = await actor.agent(`/conversations/${conversationId}/messages`, { requestId, ...(selection ? { selectionSnapshot: { pageId: actor.pageId } } : {}),
      ...(attachments ? { attachments } : {}), prompt: script(steps) });
    if (sent.status === 403 && sent.body?.code === 'selection-page-unavailable' && !arguments[3]?.retried) {
      await actor.ensurePage();
      return run(actor, conversationId, steps, { attachments, waitSettled, timeoutMs, selection, retried: true });
    }
    if (sent.status !== 202) throw new Error(`发消息没有被接受:${sent.status} ${brief(sent.body)}`);
    const message = await until(() => f.messageOf(conversationId, requestId), { what: `消息 ${requestId} 入账`, timeoutMs: 20_000 });
    if (!waitSettled) return { requestId, messageId: message.messageId };
    try {
      await until(() => f.grantOf(message.messageId)?.state === 'finished', { what: `任务 ${requestId} 结清`, timeoutMs });
    } catch (error) {
      error.message += ` :: scheduler=${brief(f.scheduler.describe())} log=${brief(f.log.slice(-12).map((r) => ({ e: r.event, c: r.code })))} worker=${brief(lastWorkerLog(8))}`;
      throw error;
    }
    const grant = f.grantOf(message.messageId);
    const rounds = toolRounds(conversationId).slice(before);
    return { requestId, messageId: message.messageId, outcome: grant.terminalOutcome?.status, rounds, of: (name, nth = 0) => rounds.filter((r) => r.name === name)[nth]?.result };
  }
  const lastWorkerLog = (n = 20) => { const epoch = f.headRecord()?.head?.epoch; return epoch ? f.workerLog(epoch).slice(-n).map((r) => ({ e: r.event, c: r.code, ...(r.families ? { f: r.families, s: r.skipped } : {}), ...(r.kind ? { k: r.kind } : {}) })) : []; };
  const workerLogOf = (epoch) => f.workerLog(epoch);
  return { run, toolRounds, lastWorkerLog, workerLogOf, historyFile };
}

/* ---------- 注入真编辑器页面的那一小段 ----------
 * 替的是 useCloud.ts / session.ts 的会话接线(那一段要走账号登录界面,探针没有走):开事件流、把请求交给执行器、把答案原样交回。
 * 执行请求的是产品自己的模块:accountPage.ts 的账号模式执行器,加本机的播放头实现(改的是编辑器自己的 store)。
 * 发起页的在场页面号用的是夹具里这位成员连文档服务时报的那一个(在场表那一头在 Node 里连着)。服务端一侧全是产品接线。
 */
async function pageHarness({ agentUrl, conversation, pageId, ticket, holdAnswers = false }) {
  if (window.__wire?.stop) window.__wire.stop();
  const AP = await import('/src/ai/cloud/accountPage.ts');
  const PB = await import('/src/mcp/handlers/playback.ts');
  const UE = await import('/src/editor/userEditing.ts');
  const controller = new AbortController();
  const state = (window.__wire = { agentUrl, conversation, ticket, pageId, attached: false, status: null, received: [], posted: [], answers: [], error: null, stop: () => controller.abort() });
  const handler = AP.createAccountPageHandler({ pageId: () => pageId,
    exec: { seek: (a) => PB.playbackHandlers.seek(a), play: () => PB.playbackHandlers.play(), pause: () => PB.playbackHandlers.pause(), begin: UE.beginAgentTool, end: UE.endAgentTool } });
  void (async () => {
    const res = await fetch(`${agentUrl}/v1/conversations/${conversation}/events?after=0&page=${encodeURIComponent(pageId)}`, { headers: { authorization: `Bearer ${ticket}` }, signal: controller.signal });
    state.status = res.status; state.attached = res.ok;
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const row = buffer.slice(0, at).split('\n').find((l) => l.startsWith('data: '));
        buffer = buffer.slice(at + 2);
        if (!row) continue;
        let ev; try { ev = JSON.parse(row.slice(6)); } catch { continue; }
        if (ev.type !== 'page.request') continue;
        state.received.push({ id: ev.id, tool: ev.tool });
        if (holdAnswers) continue;
        const answer = await handler(ev);
        if (!answer) continue;
        state.answers.push(answer);
        const r = await fetch(`${agentUrl}/v1/conversations/${conversation}/page-results`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ticket}` }, body: JSON.stringify(answer) });
        state.posted.push({ id: ev.id, status: r.status });
      }
    }
    state.attached = false;
  })().catch((e) => { state.attached = false; state.error = String(e?.message ?? e); });
  return { pageId };
}

/* ---------- 主流程 ---------- */

async function main() {
  const windowsBefore = visibleWindows();
  const ffmpeg = findFfmpeg();
  const browser = await findBrowser();
  console.log(`# 本机:ffmpeg ${ffmpeg ? '在' : '不在'};无头浏览器 ${browser ? path.basename(browser) : '不在'};模型:模拟模型(脚本化地发工具调用)`);
  const site = await startSite();
  const tools = { ...(ffmpeg ? { PROMPTCUT_FFMPEG: ffmpeg } : {}), ...(browser ? { PROMPTCUT_AGENT_BROWSER: browser } : {}) };
  const f = await startRunnerProcessFixture({ ports: PORTS, productionMaster: true, tools,
    // 出网闸的测试例外:只放行本机假站这一个地址(生产不设)。浏览器等进程退出的时限放宽,只为机器忙时不误报
    runnerOptions: { egress: { testAllow: [`127.0.0.1:${SITE_PORT}`] } },
    toolLimits: { web: { closeMs: 40_000 }, settleMs: 180_000 } });
  const h = makeHarness(f);
  const actors = [];
  let failed = null;
  // 长时间的探针里页面到文档服务的连接票据会到期(文档服务把旧连接关掉,在场表里这张页面就不在了):隔几秒看一眼,断了就凭同一个登录重连
  const reconnecting = new Set();
  const keepPages = setInterval(() => { for (const actor of actors) { if (reconnecting.has(actor)) continue; reconnecting.add(actor);
    void actor.ensurePage().catch(() => {}).finally(() => reconnecting.delete(actor)); } }, 8_000);
  let pageTab = null, uiBrowser = null, desktop = null;
  try {
    const a = await f.connectActor(0); actors.push(a);
    await f.scheduler.start();
    await until(() => f.masterAssembly.schedulerAlive(), { what: '调度问到了主服务', timeoutMs: 20_000 });

    const profileDir = (conversationId) => hostedBrowserDir(f.dataDir, { projectId: f.projectId, conversationId });
    const profileState = (conversationId) => { const dir = profileDir(conversationId); try { return fs.readdirSync(dir).sort(); } catch { return null; } };
    const browsersOf = (conversationId) => processesUnder(profileDir(conversationId));
    const mediaOf = async (actor) => ((await actor.project()).project.media ?? []);
    let mediaId = null, clipId = null, shotsJobId = null;

    /* ===== 一、感知四族、后台作业、一键流程 ===== */
    if (wants('perception')) {
      const conv = 'wire_main';
      // 现造一段三个硬切场景的短片(每段 2 秒,25 帧,切点在 2.0 与 4.0 秒),带一条正弦音轨
      let video = null;
      if (ffmpeg) {
        const file = path.join(f.dir, 'wire-probe-clip.mp4');
        const made = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=25:duration=2',
          '-f', 'lavfi', '-i', 'rgbtestsrc=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
          '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
        if (made.status === 0 && fs.existsSync(file)) video = fs.readFileSync(file);
      }
      if (!video) skip('镜头识别(真 ffmpeg 的 scdet 档)', '这台机器没有 ffmpeg,造不出测试短片,没跑');
      else {
        const up = await a.upload(conv, 'clip.mp4', video);
        check('素材:测试短片经主服务传进这个对话的工作目录', up.status === 200, brief(up.body.attachment));
        const t1 = await h.run(a, conv, [{ tool: 'import_media', input: { url: up.body.attachment.url, name: 'clip.mp4' } },
          { tool: 'stt_status', input: {} }, { tool: 'track_status', input: {} }, { tool: 'subject_status', input: {} }, { say: '状态查完了' }], { attachments: [{ url: up.body.attachment.url }] });
        const imported = t1.of('import_media');
        mediaId = imported?.mediaId ?? null; clipId = imported?.clipId ?? null;
        check('导入:短片进了项目素材库(后面各族都凭素材号读它)', t1.outcome === 'done' && !!mediaId, brief({ outcome: t1.outcome, mediaId, clipId, kind: imported?.kind, duration: imported?.duration }));
        const sttStatus = t1.of('stt_status'), trackStatus = t1.of('track_status'), subjectStatus = t1.of('subject_status');
        check('语音转写的状态查询:节点没配 Python,如实回没配(不是「还没接上」)', sttStatus?.cloudUnavailable === true && sttStatus.code === 'PYTHON_MISSING' && !/这一版还用不了/.test(sttStatus.error ?? ''), brief(sttStatus));
        check('运动追踪的状态查询:如实回这台节点追不了', !!trackStatus && trackStatus.ready !== true && !/这一版还用不了/.test(JSON.stringify(trackStatus)), brief(trackStatus));
        check('主体识别的状态查询:如实回这台节点没配', !!subjectStatus && !/这一版还用不了/.test(JSON.stringify(subjectStatus)) && (subjectStatus.engine === null || subjectStatus.cloudUnavailable === true || subjectStatus.ok === false), brief(subjectStatus));

        // 镜头识别:模型只发起就结束这一轮;任务进程等这条后台作业做完才收尾,结果写进文档服务的项目
        const t2 = await h.run(a, conv, [{ tool: 'detect_shots', input: { mediaId } }, { say: '发起了镜头识别' }]);
        const started = t2.of('detect_shots');
        shotsJobId = started?.jobId ?? null;
        const media = (await mediaOf(a)).find((m) => m.id === mediaId);
        const cuts = (media?.shots?.shots ?? []).map((s) => [Number(s.start?.toFixed?.(2) ?? s.start), Number(s.end?.toFixed?.(2) ?? s.end)]);
        check('镜头识别:模型发起 → 任务进程里真 ffmpeg(scdet 档)执行 → 文档服务的项目里读得到三个镜头,切点对上真值 2.0 / 4.0 秒',
          t2.outcome === 'done' && !!shotsJobId && media?.shots?.engine === 'scdet' && cuts.length === 3 && Math.abs(cuts[0][1] - 2) <= 0.08 && Math.abs(cuts[1][1] - 4) <= 0.08,
          brief({ started: { ok: started?.ok, jobId: !!shotsJobId, engine: started?.engine }, engine: media?.shots?.engine, cuts }));

        const t3 = await h.run(a, conv, [{ tool: 'list_shots', input: { mediaId } }, { tool: 'background_job_status', input: { jobId: shotsJobId ?? 'job_none' } },
          { tool: 'transcribe_media', input: { mediaId } }, { tool: 'track_points', input: { mediaId, points: [[0, 160, 90]] } }, { tool: 'get_track', input: { mediaId } },
          { tool: 'attach_clip_motion', input: { clipId: clipId ?? 'clip_none', mediaId } }, { tool: 'detect_subjects', input: { mediaId } }, { tool: 'list_subjects', input: { mediaId } },
          { tool: 'auto_workflow', input: { mediaId } }, { say: '都试了一遍' }]);
        const listed = t3.of('list_shots'), jobStatus = t3.of('background_job_status');
        check('list_shots:由提供者答(读得到上一条任务写进项目的镜头)', Array.isArray(listed?.shots) && listed.shots.length === 3, brief({ shots: listed?.shots?.length, engine: listed?.engine, note: listed?.engineNote }));
        check('后台作业状态:上一条任务(另一代进程)里做完的镜头作业,这一条查得到、是完成', jobStatus?.kind === 'shots.detect' && jobStatus.done === true && jobStatus.ok === true, brief(jobStatus));
        const transcribe = t3.of('transcribe_media'), points = t3.of('track_points'), motion = t3.of('attach_clip_motion'), subjects = t3.of('detect_subjects'), workflow = t3.of('auto_workflow');
        check('语音转写:没装依赖,如实回这台节点做不了,不起作业', transcribe?.cloudUnavailable === true && !transcribe.jobId, brief(transcribe));
        check('运动追踪:没配 Python,如实拒绝', !!points && points.ok !== true && /没有配置运动追踪/.test(JSON.stringify(points)), brief(points));
        check('贴运动的拒绝路径:没有追踪结果,不提交、不伪造', !!motion && motion.ok !== true && !/这一版还用不了/.test(JSON.stringify(motion)), brief(motion));
        check('主体识别:两档都用不了,如实回,不起注定失败的作业', !!subjects && (subjects.cloudUnavailable === true || subjects.ok === false) && !/这一版还用不了/.test(JSON.stringify(subjects)), brief(subjects));
        const workflowJob = workflow?.jobId ?? null;
        check('一键流程:起了一个;第一阶段(语音转写)在这台节点没就绪,停在那里并说明,后面的阶段没做', !!workflowJob && workflow.ok === false && /语音转写/.test(String(workflow.error ?? '')), brief({ jobId: !!workflowJob, ok: workflow?.ok, error: String(workflow?.error ?? '').slice(0, 120) }));
        const afterWorkflow = (await mediaOf(a)).find((m) => m.id === mediaId);
        const t4 = await h.run(a, conv, [{ tool: 'auto_workflow_status', input: { jobId: workflowJob ?? 'job_none' } }, { tool: 'background_job_status', input: { jobId: workflowJob ?? 'job_none' } }, { say: '查过了' }]);
        const status = t4.of('auto_workflow_status'), viaJobs = t4.of('background_job_status');
        check('一键流程的状态:换了一代进程再查,说得清停在哪一阶段;项目里没有半截的字幕与卡片',
          status?.done === true && status.ok === false && Array.isArray(status.stages) && viaJobs?.kind === 'workflow.auto' && !afterWorkflow?.transcript,
          brief({ state: status?.state, stage: status?.stage, stages: (status?.stages ?? []).map((s) => `${s.stage ?? s.id}:${s.state ?? s.status}`), viaJobs: viaJobs?.state }));
        const stateFiles = (() => { try { return fs.readdirSync(accountToolStateDir(f.dataDir, f.projectId, conv)).sort(); } catch { return []; } })();
        check('作业账本落在这个对话自己的目录里', stateFiles.includes('tool-jobs.db'), stateFiles.join(','));
      }
    }

    /* ===== 二、网页操作 ===== */
    if (wants('web')) {
      const conv = 'wire_web';
      if (!browser) {
        const r = await h.run(a, conv, [{ tool: 'web_open', input: { url: `http://127.0.0.1:${SITE_PORT}/` } }, { say: '试过了' }]);
        check('网页操作:这台机器没有无头浏览器,工具如实回「节点没有配置浏览器」', r.of('web_open')?.code === 'BROWSER_MISSING', brief(r.of('web_open')));
        skip('网页操作:打开假站、读一段字、关掉', '这台机器没有 Chrome / chrome-headless-shell,没跑');
      } else {
        const r = await h.run(a, conv, [{ tool: 'web_open', input: { url: `http://127.0.0.1:${SITE_PORT}/` } }, { tool: 'web_read', input: {} },
          { tool: 'web_handoff', input: { reason: '探针' } }, { tool: 'web_close', input: {} }, { say: '读完关了' }]);
        const opened = r.of('web_open'), read = r.of('web_read'), handoff = r.of('web_handoff'), closed = r.of('web_close');
        check('网页操作:云端无头浏览器打开本机假站', opened?.ok === true && site.hits.length >= 1, brief({ ok: opened?.ok, title: opened?.title, url: opened?.url, clickable: opened?.clickable?.length, hits: site.hits.length, error: opened?.error }));
        check('网页操作:读到页面上的那段字', JSON.stringify(read ?? '').includes('WIRE-PROBE-MARKER-7391'), brief(read, 200));
        check('网页接管:发起人的页面没有连着事件流,如实回「发起方不在线」', handoff?.initiatorOffline === true, brief(handoff));
        check('网页操作:关掉', closed?.ok === true && closed.closed === true, brief(closed));
        // 用量:这条任务里网页操作的三次调用各记了一行(发起人页面那一族不记),成员经主服务查得到
        const usage = await a.agent('/usage');
        const webRow = (usage.body.services ?? []).find((row) => row.service === 'web');
        check('用量:成员经主服务查用量,拿到这条任务记的网页操作那几行(三次调用,按次数记)', usage.status === 200 && webRow?.vendor === 'chromium' && webRow.calls === 3 && webRow.unit === 'calls' && webRow.units === 3 && usage.body.project.calls >= 5,
          brief({ status: usage.status, web: webRow, modelCalls: usage.body.project?.calls, services: (usage.body.services ?? []).map((row) => `${row.service}:${row.calls}`) }));
        // 浏览器的帮手进程(崩溃上报那一个)在主进程退出后还会多活几秒:等它,最多半分钟
        const webGone = await (async () => { try { await until(() => browsersOf(conv).length === 0, { what: 'gone', timeoutMs: 30_000, everyMs: 500 }); return true; } catch { return false; } })();
        check('网页操作:任务结束后这个对话名下没有残留的浏览器进程;用户数据目录留着(登录态保留)', webGone && (profileState(conv) ?? []).includes('profile'), brief({ procs: browsersOf(conv), dir: profileState(conv) }));
      }
    }

    /* ===== 三、发起人页面的反向通道(真的无头浏览器里的真编辑器页面) ===== */
    if (wants('page')) {
      const conv = 'wire_page';
      try {
        const ui = await import('./cloud-agent-ui-lib.mjs');
        desktop = await ui.startDesktop({ port: DEV_PORT, dir: path.join(f.dir, 'editor') });
        uiBrowser = await ui.launchBrowser();
        const ctx = await uiBrowser.createBrowserContext();
        const page = await ctx.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        page.on('dialog', (d) => void d.accept());
        await ui.openDesktopEditor(page, desktop.origin);
        await page.waitForFunction(() => !!window.__pcStore && window.__pcStore.getState().project.duration > 0, { timeout: 240_000, polling: 500 });
        // 对话要先存在(事件流对不存在的对话回 404):先发一条不碰页面的消息
        await h.run(a, conv, [{ say: '开个头' }]);
        // 页面里接上:事件流挂到主服务(带发起页的在场页面号),收到的请求交给产品自己的执行器(accountPage.ts + 本机的播放头实现),答案原样交回
        const info = await page.evaluate(pageHarness, { agentUrl: `http://127.0.0.1:${PORTS.agent}`, conversation: conv, pageId: a.pageId, ticket: await a.delegation() });
        pageTab = { page, ui };
        await until(async () => (await page.evaluate(() => window.__wire.attached)) === true, { what: '页面的事件流挂上主服务', timeoutMs: 20_000 });
        const duration = await page.evaluate(() => window.__pcStore.getState().project.duration);
        const target = Math.round(Math.min(5, duration / 2) * 100) / 100;
        const before = await page.evaluate(() => window.__pcStore.getState().t);
        const r = await h.run(a, conv, [{ tool: 'seek', input: { t: target } }, { tool: 'play', input: {} }, { tool: 'pause', input: {} }, { say: '动过播放头了' }]);
        const after = await page.evaluate(() => ({ t: window.__pcStore.getState().t, playing: window.__pcStore.getState().playing, wire: window.__wire }));
        check('反向通道:模型调 seek → 任务进程 → 主服务的登记表 → 发起人的真编辑器页面,播放头真的变了',
          // seek 之后脚本还放了一小会儿又暂停,所以停下来的位置在目标之后不远处
          r.of('seek')?.ok === true && after.t >= target && after.t < target + 5 && before !== after.t && after.wire.received.filter((x) => x.tool === 'seek').length === 1 && after.wire.posted.every((p) => p.status === 200),
          brief({ info, target, before, after: after.t, seek: r.of('seek'), received: after.wire.received.map((x) => x.tool), posted: after.wire.posted.map((p) => p.status) }));
        check('反向通道:play / pause 也到了发起页并交回', after.wire.received.some((x) => x.tool === 'play') && after.wire.received.some((x) => x.tool === 'pause') && r.of('pause')?.ok !== false && after.playing === false, brief({ play: r.of('play'), pause: r.of('pause'), playing: after.playing }));
        try { await page.screenshot({ path: path.join(ROOT, 'docs', 'reports', 'assets', 'v18-wire', 'page-after-seek.png') }); } catch { /* 截图只是留证 */ }
        // 页面晚到的回答:拿上一条已经结束的请求再交一次(换一个结果),主服务拒收
        const late = await page.evaluate(async () => {
          const last = window.__wire.answers[window.__wire.answers.length - 1];
          const res = await fetch(`${window.__wire.agentUrl}/v1/conversations/${window.__wire.conversation}/page-results`, { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${window.__wire.ticket}` }, body: JSON.stringify({ ...last, ok: true, result: { ok: true, forged: 1 } }) });
          return { status: res.status, body: await res.json().catch(() => null) };
        });
        check('反向通道:这一轮结束之后页面再交(内容不同)被拒', [409, 410].includes(late.status), brief(late));
        // 发起页关掉:再调就是「发起方不在线」
        const received = after.wire.received.length;
        await page.evaluate(() => window.__wire.stop());
        await sleep(500);
        const off = await h.run(a, conv, [{ tool: 'seek', input: { t: 0 } }, { say: '页面不在了' }]);
        const still = await page.evaluate(() => ({ t: window.__pcStore.getState().t, received: window.__wire.received.length }));
        check('反向通道:发起页的事件流断开后再调 seek,回「发起方不在线」,页面没有动', off.of('seek')?.initiatorOffline === true && still.received === received && Math.abs(still.t - after.t) < 0.01, brief({ seek: off.of('seek'), still }));
      } catch (error) {
        check('反向通道:真编辑器页面这一段', false, String(error?.stack ?? error).slice(0, 600));
      }
    }

    /* ===== 四、收场 ===== */
    const longWeb = (extra = []) => [{ tool: 'web_open', input: { url: `http://127.0.0.1:${SITE_PORT}/` } }, ...extra, { sleepMs: 60_000 }, { say: '不该说到这里' }];
    const waitBrowser = async (conv) => until(() => (browsersOf(conv).length > 0 ? browsersOf(conv) : null), { what: `${conv} 的浏览器起来`, timeoutMs: 90_000, everyMs: 500 });
    const waitNoBrowser = async (conv, timeoutMs = 60_000) => { try { await until(() => browsersOf(conv).length === 0, { what: 'gone', timeoutMs, everyMs: 500 }); return true; } catch { return false; } };
    const epochNow = () => f.headRecord()?.head?.epoch;

    // 长时间的探针里页面到文档服务的连接票据会到期:每一段开头先看一眼,断了就重连(照旧报同一个在场页面号)
    const fresh = async (actor) => { try { await actor.ensurePage(); } catch (error) { console.log(`# 页面重连没成:${error?.message}`); } };

    if (wants('stop') && browser) {
      await fresh(a);
      const conv = 'wire_stop';
      const sent = await h.run(a, conv, longWeb(), { waitSettled: false });
      const procs = await waitBrowser(conv);
      const epoch = epochNow(), pid = f.generations.get(epoch).pid;
      const run = await until(() => f.events(conv).find((row) => (row.event?.type ?? row.type) === 'run'), { what: 'runId', timeoutMs: 30_000 });
      const aborted = await a.agent(`/conversations/${conv}/abort`, { runId: run.event?.runId ?? run.runId, requestId: 'wire-stop-1' });
      const gone = await waitNoBrowser(conv);
      const grant = f.grantOf(sent.messageId);
      check('停止:网页操作在跑时点停止 → 任务被中断,任务进程被关,这个对话的浏览器整棵进程树没了;用户数据目录留着',
        aborted.status === 200 && grant?.terminalOutcome?.status === 'interrupted' && gone && f.generations.get(epoch).gateway.describe().childClosed === true && (profileState(conv) ?? []).includes('profile'),
        brief({ abort: aborted.status, outcome: grant?.terminalOutcome?.status, before: procs.length, after: browsersOf(conv).length, workerPid: pid, dir: profileState(conv) }));
    }

    let b = null;
    if (wants('private') && browser) {
      // 成员乙在甲的共有对话里跑任务(开着网页),甲把对话转成私有:乙的这一轮被收回,对话的浏览器关掉、用户数据目录删掉
      const conv = 'wire_private';
      b = await f.connectActor(1); actors.push(b);
      await fresh(a);
      await h.run(a, conv, [{ say: '甲开的共有对话' }]);
      const sent = await h.run(b, conv, longWeb(), { waitSettled: false });
      const procs = await waitBrowser(conv);
      const epoch = epochNow();
      // 文档服务当场把对话转成私有、收回乙的这一轮;「办完」要等 root 把那一代进程关掉,没办完时回 503(还在办),凭同一个请求号再问
      const first = await a.agent(`/conversations/${conv}/visibility`, { visibility: 'private', requestId: 'wire-private-1' });
      let switched = first;
      for (let i = 0; i < 60 && switched.status === 503 && switched.body?.code === 'agent-fence-pending'; i++) { await sleep(500); switched = await a.agent(`/conversations/${conv}/visibility`, { visibility: 'private', requestId: 'wire-private-1' }); }
      const gone = await waitNoBrowser(conv);
      await until(() => f.grantOf(sent.messageId)?.state === 'finished', { what: '乙的任务结清', timeoutMs: 90_000 }).catch(() => {});
      const removed = await until(() => { const s = profileState(conv); return s === null || !s.includes('profile') ? true : null; }, { what: 'profile removed', timeoutMs: 30_000 }).catch(() => false);
      const fenced = h.workerLogOf(epoch).filter((r) => r.event === 'agent.account-tools.fenced').map((r) => ({ kind: r.kind, browser: r.browser, jobs: r.jobs }));
      check('转私有:别的成员在跑的这一轮被收回 → 浏览器进程没了,这个对话的浏览器用户数据目录删掉(只留清单版本计数)',
        switched.status === 200 && gone && removed === true && f.grantOf(sent.messageId)?.terminalOutcome?.status === 'interrupted',
        brief({ firstStatus: first.status, status: switched.status, before: procs.length, after: browsersOf(conv).length, dir: profileState(conv), outcome: f.grantOf(sent.messageId)?.terminalOutcome, workerFenced: fenced }));
      // 发起人自己把自己正在跑的对话转私有:这一轮保留;主服务留记号,任务进程收尾时清
      const own = 'wire_private_own';
      await fresh(a);
      const mine = await h.run(a, own, [{ tool: 'web_open', input: { url: `http://127.0.0.1:${SITE_PORT}/` } }, { sleepMs: 8_000 }, { tool: 'web_view', input: {} }, { say: '我自己的对话' }], { waitSettled: false });
      await waitBrowser(own);
      const ownSwitch = await a.agent(`/conversations/${own}/visibility`, { visibility: 'private', requestId: 'wire-private-2' });
      const marked = (profileState(own) ?? []).includes(BROWSER_PURGE_MARK);
      await until(() => f.grantOf(mine.messageId)?.state === 'finished', { what: '甲自己的任务结清', timeoutMs: 120_000 });
      const ownRounds = h.toolRounds(own);
      const ownGone = await waitNoBrowser(own, 30_000);
      check('转私有(发起人自己正在跑的对话):这一轮保留并做完;浏览器数据在下一次网页操作前被清掉(之后的 web_view 是「没开着」),任务结束后目录里只剩清单版本计数',
        ownSwitch.status === 200 && f.grantOf(mine.messageId)?.terminalOutcome?.status === 'done' && ownGone && !(profileState(own) ?? []).includes('profile') && !(profileState(own) ?? []).includes(BROWSER_PURGE_MARK),
        brief({ status: ownSwitch.status, marked, procs: browsersOf(own).length, outcome: f.grantOf(mine.messageId)?.terminalOutcome?.status, view: ownRounds.filter((r) => r.name === 'web_view').pop()?.result?.notOpen, dir: profileState(own) }));
    }

    if (wants('delete') && browser) {
      // 账号模式的删对话接口本身还没开放(回 503 deletion-pending);这里验的是备好的收场:浏览器目录整个删掉
      const conv = 'wire_web';
      const had = profileState(conv);
      const removed = had ? await f.masterAssembly.purgeBrowser({ projectId: f.projectId, conversationId: conv }, 'conversation-deleted') : null;
      const del = await a.agent(`/conversations/${conv}`, undefined);
      check('删对话的收场(接口未开放,直接调主服务备好的那一步):这个对话的浏览器目录整个没了', !!had && removed?.removed === true && profileState(conv) === null, brief({ had, removed, dirNow: profileState(conv), getStatus: del.status }));
    }

    if (wants('isolation')) {
      // 乙在自己的对话里查甲的作业号、调页面工具:查不到、到不了甲的页面
      b ??= await f.connectActor(1); if (!actors.includes(b)) actors.push(b);
      await fresh(b);
      const conv = 'wire_other';
      const r = await h.run(b, conv, [{ tool: 'background_job_status', input: { jobId: shotsJobId ?? 'job_00000000-0000-0000-0000-000000000000' } }, { tool: 'seek', input: { t: 1 } }, { tool: 'web_view', input: {} }, { say: '乙试过了' }]);
      const foreign = r.of('background_job_status'), seek = r.of('seek');
      const aPage = pageTab ? await pageTab.page.evaluate(() => window.__wire.received.length) : null;
      check('隔离:另一个账号在另一个对话里拿甲的作业号去查,查不到', !!foreign && foreign.ok !== true && foreign.done !== true && !foreign.kind, brief(foreign));
      check('隔离:乙的任务调 seek 到不了甲的页面(乙没有连着的发起页,回不在线)', seek?.initiatorOffline === true, brief({ seek, aPageReceived: aPage }));
      const dirs = [accountToolStateDir(f.dataDir, f.projectId, 'wire_main'), accountToolStateDir(f.dataDir, f.projectId, conv)];
      check('隔离:两个对话各有各的作业账本与浏览器目录', dirs[0] !== dirs[1] && profileDir('wire_main') !== profileDir(conv) && fs.existsSync(path.join(dirs[1], 'tool-jobs.db')), dirs.map((d) => path.basename(path.dirname(d))).join(' / '));
    }

    if (wants('kill') && browser) {
      // 任务进程被强杀(不走任何收尾):浏览器随管道断开自己退;下一条任务照常
      const conv = 'wire_kill';
      await fresh(a);
      const sent = await h.run(a, conv, longWeb(), { waitSettled: false });
      const procs = await waitBrowser(conv);
      const epoch = epochNow(), pid = f.generations.get(epoch).pid;
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
      const gone = await waitNoBrowser(conv, 90_000);
      await until(() => f.grantOf(sent.messageId)?.state === 'finished', { what: '被杀的任务被结清', timeoutMs: 120_000 }).catch(() => {});
      await fresh(a);
      const next = await h.run(a, conv, [{ tool: 'web_view', input: {} }, { say: '下一条' }]);
      check('任务进程被杀:它名下的浏览器整棵进程树自己退了;任务记失败;同一个对话的下一条任务照常(浏览器是「没开着」)',
        gone && ['failed', 'interrupted'].includes(f.grantOf(sent.messageId)?.terminalOutcome?.status) && next.outcome === 'done' && next.of('web_view')?.notOpen === true,
        brief({ before: procs.length, after: browsersOf(conv).length, killedPid: pid, outcome: f.grantOf(sent.messageId)?.terminalOutcome?.status, next: next.outcome }));
    }

    if (wants('agent-off') && browser) {
      // 创建者关掉这个项目的云端 Agent:在跑的任务被收回,浏览器关掉、用户数据目录删掉
      const conv = 'wire_off';
      await fresh(a);
      const sent = await h.run(a, conv, longWeb(), { waitSettled: false });
      const procs = await waitBrowser(conv);
      const off = await a.admin({ op: 'set-hosted-service', service: 'agent', enabled: false, requestId: 'wire-agent-off' });
      const gone = await waitNoBrowser(conv);
      await until(() => f.grantOf(sent.messageId)?.state === 'finished', { what: '被关掉的任务结清', timeoutMs: 90_000 }).catch(() => {});
      // 页面这时任何一次读取都会碰到「已关闭」,主服务据此把这个项目各对话的浏览器数据清一遍
      const info = await a.agent('/info');
      const removed = await until(() => { const s = profileState(conv); return s === null || !s.includes('profile') ? true : null; }, { what: 'profile removed', timeoutMs: 30_000 }).catch(() => false);
      const others = ['wire_stop', 'wire_kill'].map((c) => [c, profileState(c)]);
      const cleaned = await until(() => (others.every(([c]) => { const s = profileState(c); return s === null || !s.includes('profile'); }) ? true : null), { what: '别的对话的浏览器数据也清了', timeoutMs: 30_000 }).catch(() => false);
      check('关 Agent:在跑的任务被收回 → 浏览器进程没了、这个对话的用户数据目录删掉;项目里别的对话留着的浏览器数据也清掉',
        off.status === 200 && gone && removed === true && cleaned === true && f.grantOf(sent.messageId)?.terminalOutcome?.status === 'interrupted',
        brief({ off: off.status, info: info.status, before: procs.length, after: browsersOf(conv).length, dir: profileState(conv), others: others.map(([c]) => [c, profileState(c)]), outcome: f.grantOf(sent.messageId)?.terminalOutcome }));
      const on = await a.admin({ op: 'set-hosted-service', service: 'agent', enabled: true, requestId: 'wire-agent-on' });
      if (on.status !== 200) console.log(`# 重新打开云端 Agent 没成:${on.status}`);
    }

    if (wants('master-restart') && pageTab) {
      // 主服务关闭时有一条页面请求在等:任务进程那一头如实得到「发起方不在线」,登记表里那一行不是「在等」
      const conv = 'wire_page';
      await fresh(a);
      await pageTab.page.evaluate(pageHarness, { agentUrl: `http://127.0.0.1:${PORTS.agent}`, conversation: conv, pageId: a.pageId, ticket: await a.delegation(), holdAnswers: true });
      await until(async () => (await pageTab.page.evaluate(() => window.__wire.attached)) === true, { what: '页面重新挂上', timeoutMs: 20_000 });
      const before = h.toolRounds(conv).length;
      await h.run(a, conv, [{ tool: 'seek', input: { t: 2 } }, { say: '主服务没了' }], { waitSettled: false });
      try { await until(async () => (await pageTab.page.evaluate(() => window.__wire.received.length)) > 0, { what: '页面收到请求(压着不答)', timeoutMs: 60_000 }); }
      catch (error) { error.message += ` :: rounds=${brief(h.toolRounds(conv).slice(before))} wire=${brief(await pageTab.page.evaluate(() => ({ attached: window.__wire.attached, status: window.__wire.status, error: window.__wire.error })))} worker=${brief(h.lastWorkerLog(10))} sched=${brief(f.scheduler.describe())}`; throw error; }
      const epoch = epochNow();
      await f.masterAssembly.close();
      const round = await until(() => h.toolRounds(conv).slice(before).find((r) => r.name === 'seek') ?? null, { what: '任务进程里的 seek 有了结果', timeoutMs: 30_000 }).catch(() => null);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(f.dir, 'agent-master-data', 'page-requests.sqlite'), { readOnly: true });
      const rows = db.prepare("SELECT state, reason, tool FROM page_requests WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1").all(conv); db.close();
      check('主服务关闭(重启)时在等的页面请求:任务进程如实得到「发起方不在线」,没有一直挂着;登记表里那一行已经不是「在等」',
        round?.result?.initiatorOffline === true && rows[0]?.state && rows[0].state !== 'pending', brief({ seek: round?.result, row: rows[0], epoch }));
    }
  } catch (error) {
    failed = error;
    console.log(`PROBE 探针自己出错 FAIL ${String(error?.stack ?? error).slice(0, 1500)}`);
    results.push({ name: '探针自己出错', state: 'FAIL' });
  } finally {
    clearInterval(keepPages);
    if (pageTab || uiBrowser || desktop) {
      try {
        const ui = await import('./cloud-agent-ui-lib.mjs');
        const b1 = uiBrowser ? await ui.killBrowser(uiBrowser) : { gone: true };
        const d1 = desktop ? await ui.killDesktop(desktop) : { gone: true };
        check('探针自己起的无头浏览器与编辑器 dev server 都按进程号收掉', b1.gone !== false && d1.gone !== false, brief({ browser: b1, editor: d1 }));
      } catch (error) { check('探针自己起的无头浏览器与编辑器 dev server 都按进程号收掉', false, String(error?.message ?? error).slice(0, 200)); }
    }
    for (const actor of actors) await actor.close().catch(() => {});
    const closed = await f.close().catch((error) => ({ errors: [error], alive: -1 }));
    await site.close().catch(() => {});
    check('收尾:夹具关干净、没有活着的任务子进程', closed.alive === 0 && (closed.errors?.length ?? 0) === 0, `alive=${closed.alive} errors=${(closed.errors ?? []).map((e) => e?.code ?? e?.message).join('|').slice(0, 300)}`);
    const leftovers = processesUnder(f.dir);
    check('收尾:数据目录名下没有残留进程(浏览器、ffmpeg、python、node)', leftovers.length === 0, leftovers.join(' ').slice(0, 300));
    const windowsAfter = visibleWindows();
    const extra = windowsAfter.filter((w) => !windowsBefore.includes(w));
    check('没有新冒出来的可见窗口', extra.length === 0, `前 ${windowsBefore.length} 后 ${windowsAfter.length} ${extra.join(' ')}`);
    if (!keep) { try { fs.rmSync(f.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 临时目录,删不掉不影响结论 */ } }
  }
  const fails = results.filter((r) => r.state === 'FAIL').length, skips = results.filter((r) => r.state === 'SKIP').length;
  console.log(`PROBE-RESULT ${fails ? 'fail' : 'pass'} ${JSON.stringify({ total: results.length, ok: results.filter((r) => r.state === 'OK').length, fail: fails, skip: skips })}`);
  process.exitCode = fails || failed ? 1 : 0;
}

await main();
// 夹具里有不拉住进程的定时器之外的句柄时不赖着:结论已经打印
setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
