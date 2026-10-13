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
  try {
    const a = await f.connectActor(0); actors.push(a);
    await f.scheduler.start();
    await until(() => f.masterAssembly.schedulerAlive(), { what: '调度问到了主服务', timeoutMs: 20_000 });

    if (wants('explore')) {
      const r = await h.run(a, 'wire_explore', [{ tool: 'stt_status', input: {} }, { tool: 'web_view', input: {} }, { say: '好了' }]);
      console.log('# outcome', r.outcome, 'rounds', brief(r.rounds, 1200));
      console.log('# worker log', brief(h.lastWorkerLog(30), 2000));
      try { console.log('# history head', brief(JSON.parse(fs.readFileSync(h.historyFile(f.projectId, 'wire_explore'), 'utf8')), 900)); } catch (error) { console.log('# history unreadable', error.message); }
    }
  } catch (error) {
    failed = error;
    console.log(`PROBE 探针自己出错 FAIL ${String(error?.stack ?? error).slice(0, 1500)}`);
    results.push({ name: '探针自己出错', state: 'FAIL' });
  } finally {
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
