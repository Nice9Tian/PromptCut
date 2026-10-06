/**
 * 云端 Agent 两个带界面的探针(`cloud-agent-ui-probe.mjs`、`cloud-agent-ux-ui-probe.mjs`)共用的搭法。
 *
 * 服务端全部是**真进程、真身份**(与 `cloud-agent-probe-lib.mjs` 同一套):托管组合 `server/hosted/main.mjs`(本机信任关着)、
 * Agent 服务 `server/agent-service/main.mjs`(凭 keygen 生成的服务私钥连控制连接,模型是模拟模型提供方的脚本模式)、
 * 可选的渲染服务 `server/hosted-render/main.mjs`(管理进程 + 工作进程 + 它的 Chrome)。页面一侧:
 *   - 在线构建(`vite build --mode online`,从当前工作区现打)由本进程里一个仿 nginx 的代理提供:编辑器页的源、两个舞台的源、
 *     `/hosted/`(文档服务)、`/media/`(素材服务)、`/agent/`(Agent 服务;可以掐断事件流模拟断线,只动本机代理的 socket);
 *   - 桌面版形态的编辑器:本 worktree 的 dev server(独立进程、临时数据目录),经同一个代理连托管端与 Agent 服务(跨源)。
 * 页面的身份是真的:委托票据与对话委托都由页面在自己到文档服务的连接上要,探针不注入任何替身。
 *
 * 只绑 127.0.0.1,数据全在调用方给的临时目录里,不连任何远端。结束进程只按探针自己起的进程号(及其子孙)来。不打印口令、票据、私钥。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { ROOT, startProcess, startHosted, startAgent, killTree as killTreeOf } from './cloud-agent-probe-lib.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';

export { ROOT };
export const sleep = (ms) => delay(ms);
export const killTree = killTreeOf;

/** 用户常驻的编辑器与安装版的端口:任何探针端口碰到就不跑 */
export const USER_PORTS = Object.freeze([5190, 5191, 5192, 5210, 5211, 5212]);

export function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

export const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** 进程还在不在 */
export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 一个进程此刻的全部子孙进程号(Windows 上按父进程号一层层找;别的平台回空,由进程组收) */
export function descendantsOf(pid) {
  if (!pid || process.platform !== 'win32') return [];
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8', windowsHide: true });
  const kids = new Map();
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    const [id, parent] = [Number(m[1]), Number(m[2])];
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(id);
  }
  const out = [];
  const stack = [pid];
  const seen = new Set([pid]);
  while (stack.length) {
    for (const k of kids.get(stack.pop()) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/** 真的结束一个进程和它此刻的全部子孙(先记下子孙的进程号,再逐个按进程号结束);回 `{ pids, gone }` */
export async function killHard(pid) {
  if (!pid) return { pids: [], gone: true };
  const pids = [pid, ...descendantsOf(pid)];
  killTreeOf(pid);
  for (const p of pids) if (alive(p)) killTreeOf(p);
  for (let i = 0; i < 50 && pids.some(alive); i++) await delay(100);
  return { pids, gone: !pids.some(alive) };
}

/* ================================================================== 结果收集 */

export function createUi({ maxLine = 1800 } = {}) {
  const results = [];
  const check = (name, ok, detail = {}) => {
    results.push({ check: name, ok: !!ok });
    console.log(JSON.stringify({ check: name, ok: !!ok, detail }).slice(0, maxLine));
    return !!ok;
  };
  const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
  /** 等到 `fn` 为真;到时限没等到记一条失败的断言并回 null */
  async function until(what, fn, ms = 30_000, every = 200) {
    const t0 = Date.now();
    let last = null;
    for (;;) {
      let v = null;
      try { v = await fn(); } catch (e) { last = String(e?.message ?? e).slice(0, 200); }
      if (v) return v;
      if (Date.now() - t0 > ms) { check(`等到:${what}`, false, { last }); return null; }
      await delay(every);
    }
  }
  return { results, check, say, until };
}

/* ================================================================== 服务端一整套 */

/**
 * 起托管组合 + Agent 服务(+ 渲染服务)+ 仿 nginx 的代理。
 * `buildEnv`:在线构建时额外带的环境变量(例如 `VITE_DIAG_SUBMIT_URL`,让页面的诊断报告提交打到探针自己起的假收集端)。
 * `ports`:`{ site, stageA, stageB, doc, asset, agent, render? }`(`render` 给了才起渲染服务,另占 +1、+2 与 +6)。
 * 回一个句柄,见各字段的注释;`stop()` 把它起的全部停掉。
 */
export async function startStack({ tmp, ports, dist = null, say = () => {}, agentEnv = {}, buildEnv = {} }) {
  const need = [ports.site, ports.stageA, ports.stageB, ports.doc, ports.asset, ports.agent, ...(ports.render ? [ports.render, ports.render + 1, ports.render + 2, ports.render + 6] : [])];
  for (const p of need) {
    if (USER_PORTS.includes(p)) throw new Error(`端口段碰到了 ${p}(用户的编辑器或安装版)`);
    if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  }
  const SITE = `http://127.0.0.1:${ports.site}`;
  const STAGE_ORIGINS = [`http://127.0.0.1:${ports.stageA}`, `http://127.0.0.1:${ports.stageB}`];
  const D = { hosted: path.join(tmp, 'hosted'), agent: path.join(tmp, 'agent'), agentSecrets: path.join(tmp, 'agent-secrets'), render: path.join(tmp, 'render'), renderSecrets: path.join(tmp, 'render-secrets') };
  const S = {
    SITE, STAGE_ORIGINS, D, ports,
    DOC_DIRECT: `http://127.0.0.1:${ports.doc}`,
    DOC_WS: `ws://127.0.0.1:${ports.doc}`,
    /** 页面(桌面版)连托管端用的地址:经代理,与在线页面同一个源 */
    HOSTED_URL: `${SITE}/hosted/`,
    /** 文档服务下发给页面的 Agent 服务地址(经代理的 `/agent/v1`,与真节点的 nginx 同形状) */
    AGENT_PUBLIC: `${SITE}/agent/v1`,
    AGENT_DIRECT: `http://127.0.0.1:${ports.agent}`,
    DIST: null, hosted: null, agent: null, render: null,
    /** 经代理转发的 /agent/ 请求(每条 `{ method, path, origin, at }`) */
    agentLog: [],
  };

  // 在线构建:没给就从当前工作区现打(渲染服务认领要求它与渲染服务、Agent 服务是同一份代码)
  let DIST = dist;
  if (!DIST) {
    DIST = path.join(tmp, 'dist-online');
    say('build-online', { dist: DIST });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...buildEnv } });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  S.DIST = DIST = path.resolve(DIST);

  if (ports.render) runKeygen(['--hosted-data', D.hosted, '--secrets', D.renderSecrets, '--instance-name', '托管方的渲染节点(探针)']);
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.agentSecrets, '--service', 'agent', '--instance-name', '云端 Agent(探针)']);
  S.hosted = await startHosted({
    dataDir: D.hosted, docPort: ports.doc, assetPort: ports.asset,
    env: { PROMPTCUT_DOCSERVICE_PUBLIC_URL: `ws://127.0.0.1:${ports.site}/hosted/`, PROMPTCUT_ASSET_PUBLIC_URL: `${SITE}/media/api/asset`, PROMPTCUT_AGENT_PUBLIC_URL: S.AGENT_PUBLIC },
  });

  /* ---- 仿 nginx 的代理 */
  const proxies = [];
  const upgraded = new Set();
  const agentStreams = new Set();
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
  const makeProxy = (port) => {
    const origin = `http://127.0.0.1:${port}`;
    const forward = (req, res, upstream, strip, { stream = false } = {}) => {
      const target = req.url.slice(strip.length) || '/';
      const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC });
        r.pipe(res);
        // 上游中途没了(服务被结束):照 nginx 的做法把下游也断开,不留一条半开的连接
        r.on('close', () => { if (!r.complete && !res.writableEnded) res.destroy(); });
      });
      up.on('error', () => { try { res.writeHead(502, OAC); } catch { /* 已发 */ } res.end('bad gateway'); });
      if (stream) {
        const h = { up, res };
        agentStreams.add(h);
        res.on('close', () => { agentStreams.delete(h); up.destroy(); });
      }
      req.pipe(up);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, ports.doc, '/hosted');
      if (url.pathname.startsWith('/media/')) return forward(req, res, ports.asset, '/media');
      if (url.pathname.startsWith('/agent/') && port === ports.site) {
        S.agentLog.push({ method: req.method, path: url.pathname + url.search, origin: req.headers.origin ?? null, at: Date.now() });
        return forward(req, res, ports.agent, '/agent', { stream: /\/events$/.test(url.pathname) });
      }
      const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
      const sendFile = (file, cache) => {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
        fs.createReadStream(file).pipe(res);
      };
      if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec }); return res.end(runtimeConfig); }
      const index = path.join(DIST, 'index.html');
      if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
      if (url.pathname.startsWith('/editor/')) {
        const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
        if (f.startsWith(DIST) && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(f, 'public, max-age=31536000, immutable');
        return sendFile(index, 'no-store');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
      res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, origin);
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      const up = net.connect(ports.doc, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      upgraded.add(up);
      up.on('close', () => { upgraded.delete(up); socket.destroy(); });
      socket.on('close', () => up.destroy());
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([makeProxy(ports.site), makeProxy(ports.stageA), makeProxy(ports.stageB)]);

  /** 掐掉所有 /agent/ 的事件流连接(应用层模拟断线:只动本机代理的 socket,不动宿主机网络) */
  S.dropAgentStreams = () => {
    const n = agentStreams.size;
    for (const s of [...agentStreams]) { try { s.up.destroy(); } catch { /* 已断 */ } try { s.res.destroy(); } catch { /* 已断 */ } }
    agentStreams.clear();
    return n;
  };
  /** 此刻开着的事件流条数 */
  S.agentStreamCount = () => agentStreams.size;

  /* ---- 渲染服务(可选) */
  const RENDER_STATUS = ports.render ? `http://127.0.0.1:${ports.render + 6}` : null;
  S.startRender = () => {
    if (!ports.render) throw new Error('这一套没有配渲染服务的端口');
    const env = {};
    for (const k of Object.keys(process.env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') env[k] = undefined;
    S.render = startProcess(path.join(ROOT, 'server', 'hosted-render', 'main.mjs'), {
      ipc: true,
      env: {
        ...env,
        PROMPTCUT_RENDER_DOC_URL: S.DOC_WS, PROMPTCUT_RENDER_SECRETS: D.renderSecrets, PROMPTCUT_RENDER_DATA: D.render,
        PROMPTCUT_RENDER_PORT: String(ports.render), PROMPTCUT_RENDER_STATUS_PORT: String(ports.render + 6),
        PROMPTCUT_RENDER_MAX_CONCURRENT: '2', PROMPTCUT_RENDER_SAMPLE_MS: '2000', PROMPTCUT_RENDER_MEM_LOW: '256M',
        // 在线页面的构建就是代理在发的那一份:渲染服务拿它比代码版本
        PROMPTCUT_RENDER_EDITOR_DIR: DIST, PROMPTCUT_RENDER_AGENT_STATUS_URL: `${S.AGENT_DIRECT}/healthz`,
        ...(process.platform === 'win32' && !process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ? { PROMPTCUT_TEST_ENV_FINGERPRINT: '7e57c10d00000002' } : {}),
      },
    });
    return S.render;
  };
  S.renderStatus = async () => (await fetch(`${RENDER_STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();
  S.waitRenderReady = async (ms = 300_000) => {
    const t0 = Date.now();
    for (;;) {
      const s = await S.renderStatus().catch(() => null);
      if (s?.directory?.connected && s.worker?.ready && s.queue) return s;
      if (S.render?.child.exitCode !== null && S.render?.child.exitCode !== undefined) throw new Error(`渲染服务退出了:${S.render.text().slice(-600)}`);
      if (Date.now() - t0 > ms) throw new Error(`等渲染服务就绪超时:${S.render?.text().slice(-600)}`);
      await delay(1000);
    }
  };
  S.stopRender = async () => {
    const r = S.render;
    S.render = null;
    if (!r) return;
    const pid = r.child.pid;
    const kids = descendantsOf(pid);
    await r.stop(30_000);
    killTreeOf(pid);
    for (const k of kids) if (alive(k)) killTreeOf(k);
  };
  /** 渲染服务的目录里这个项目此刻有没有成员在线(不开任何成员连接就能看) */
  S.membersOnline = async (projectId) => (await S.renderStatus()).directory?.list?.find((p) => p.projectId === projectId)?.members ?? null;

  /* ---- Agent 服务 */
  S.bootAgent = async (env = {}) => {
    await S.agent?.stop();
    S.agent = await startAgent({ dataDir: D.agent, secrets: D.agentSecrets, docPort: ports.doc, port: ports.agent, env: { ...agentEnv, ...env } });
    return S.agent;
  };
  await S.bootAgent();
  say('stack.up', { site: SITE, doc: ports.doc, asset: ports.asset, agent: ports.agent, render: ports.render ?? null, dist: DIST });

  S.agentLogs = (event, projectId) => S.agent.logs.filter((l) => l.event === event && (!projectId || l.projectId === projectId));
  /** 从 Agent 服务盘上找一个对话的 meta 与事件记录(探针自己的临时目录;不经任何成员连接) */
  /** 附件传到 Agent 服务的这个对话工作目录里没有:找 …/<对话 id>/attachments/<文件名>,回字节(没有回 null) */
  S.attachmentOnDisk = (conversationId, name) => {
    const stack = [D.agent];
    while (stack.length) {
      const dir = stack.pop();
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const p = path.join(dir, item.name);
        if (item.name === conversationId) {
          const f = path.join(p, 'attachments', name);
          if (fs.existsSync(f)) return fs.readFileSync(f);
        }
        stack.push(p);
      }
    }
    return null;
  };
  S.diskConversation = (projectId, conversationId) => {
    const root = path.join(D.agent, 'tenants', projectId);
    if (!fs.existsSync(root)) return null;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const p = path.join(dir, item.name);
        if (item.name === conversationId && fs.existsSync(path.join(p, 'meta.json'))) {
          try {
            const events = fs.existsSync(path.join(p, 'events.jsonl')) ? fs.readFileSync(path.join(p, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
            return { meta: JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8')), events };
          } catch { return null; } // 正写到一半:下一次再读
        }
        stack.push(p);
      }
    }
    return null;
  };
  /** 素材服务盘上的文件数(产物入库前后比) */
  S.assetFiles = () => {
    let n = 0;
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const i of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, i.name); if (i.isDirectory()) walk(p); else n += 1; } };
    walk(path.join(D.hosted, 'assets'));
    return n;
  };

  S.stop = async () => {
    for (const s of upgraded) { try { s.destroy(); } catch { /* 已关 */ } }
    S.dropAgentStreams();
    await Promise.all(proxies.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))).catch(() => {});
    await S.agent?.stop().catch(() => {});
    try { await S.stopRender(); } catch { /* 已停 */ }
    await S.hosted?.stop().catch(() => {});
  };
  /** 这一套占的端口此刻还有没有人在听(收尾后应全为空) */
  S.portsStillBusy = async () => {
    const busy = [];
    for (const p of need) if (!(await portFree(p))) busy.push(p);
    return busy;
  };
  return S;
}

/* ================================================================== 桌面版形态的编辑器(本 worktree 的 dev server) */

/**
 * 起一台桌面版形态的编辑器:独立进程、数据全在 `dir`(设备号固定,同一个 `dir` 再起一台就是「同一台电脑重新打开软件」)。
 * 模型配置、命令行登录状态、SKILL 目录都指进 `dir`(`reopen-editor-env.mjs`),不读用户的。回 `{ child, pid, origin, log, dir }`。
 * 这台编辑器自己不当渲染节点(`PROMPTCUT_AUTO_RENDER_NODE=0`、`PROMPTCUT_PUSH=0`):探针要看的是云节点上的渲染服务把活干了。
 */
export async function startDesktop({ port, dir, deviceId, deviceName = '探针的电脑', env = {} }) {
  for (const p of [port, port + 1, port + 2]) {
    if (USER_PORTS.includes(p)) throw new Error(`端口段碰到了 ${p}(用户的编辑器或安装版)`);
    if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  }
  const tmpDir = path.join(dir, 'tmp');
  for (const d of [dir, tmpDir, path.join(dir, 'drafts'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: reopenEditorEnv(dir, {
      BROWSER: 'none', PROMPTCUT_WORK_DIR: path.join(dir, 'work'), TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir,
      ...(deviceId ? { PROMPTCUT_DEVICE_ID: deviceId, PROMPTCUT_DEVICE_NAME: deviceName } : {}),
      PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_QUEUE_NODE: '0', PROMPTCUT_SHARED_CONFIG: '',
      ...env,
    }),
  });
  const log = [];
  const keep = (c) => { for (const line of c.toString().split(/\r?\n/)) if (line) { log.push(line); if (log.length > 4000) log.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`编辑器退出了:${log.slice(-6).join(' | ').slice(0, 400)}`);
    const ok = await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() - t0 > 240_000) { await killHard(child.pid); throw new Error(`编辑器没起来:${log.slice(-6).join(' | ').slice(0, 400)}`); }
    await delay(500);
  }
  return { child, pid: child.pid, origin, log, dir, port };
}

/** 真的结束这台编辑器(进程和它的全部子孙,不给收尾的机会);回 `{ pids, gone, portsFree }` */
export async function killDesktop(desktop) {
  if (!desktop?.pid) return { pids: [], gone: true, portsFree: true };
  const r = await killHard(desktop.pid);
  let portsFree = false;
  for (let i = 0; i < 50 && !portsFree; i++) {
    portsFree = (await Promise.all([desktop.port, desktop.port + 1, desktop.port + 2].map(portFree))).every(Boolean);
    if (!portsFree) await delay(200);
  }
  return { ...r, portsFree };
}

/* ================================================================== 浏览器与页面小件 */

export async function launchBrowser({ extraArgs = [] } = {}) {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
}

/** 真的结束一个浏览器(它的主进程和全部子进程);回 `{ pid, gone }` */
export async function killBrowser(browser) {
  const pid = browser?.process()?.pid;
  if (!pid) return { pid: null, gone: true };
  const r = await killHard(pid);
  try { browser.disconnect(); } catch { /* 已断 */ }
  return { pid, gone: r.gone };
}

export const P = (page, fn, ...a) => page.evaluate(fn, ...a);

export async function newPage(ctx, { mobile = false, init = [] } = {}) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.requests = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  // 每个请求记:带没带票据(只记形状,不记值)、发消息的请求体里有没有对话委托
  page.on('request', (r) => {
    const a = r.headers().authorization ?? '';
    let grant = null;
    let attUrls = null;
    try {
      if (r.method() === 'POST' && /\/messages$/.test(new URL(r.url()).pathname)) {
        const body = JSON.parse(r.postData() ?? '{}');
        grant = typeof body.grant === 'string';
        // 发消息带的附件:只记 url(work:attachments/…),不记别的
        attUrls = Array.isArray(body.attachments) ? body.attachments.map((x) => String(x?.url ?? '')) : [];
      }
    } catch { grant = false; }
    // 传附件的请求(POST …/attachments?name=):记内容类型与文件名(请求体是文件字节,探针不记内容)
    let att = null;
    try {
      const u = new URL(r.url());
      if (r.method() === 'POST' && /\/attachments$/.test(u.pathname)) att = { ctype: r.headers()['content-type'] ?? null, name: u.searchParams.get('name') };
    } catch { att = null; }
    page.requests.push({ method: r.method(), url: r.url(), auth: a ? (a.startsWith('Bearer ') && !a.startsWith('Bearer test:') && a.length > 60 ? 'ticket' : 'other') : null, ...(grant !== null ? { grant, attUrls } : {}), ...(att ? { att } : {}) });
  });
  // 传附件的回包(状态与回的附件信息:名字、地址、大小、类型):在页面里包一层 fetch 记下,读 window.__pcAttachResponses
  await page.evaluateOnNewDocument(() => {
    const orig = window.fetch;
    window.__pcAttachResponses = [];
    window.fetch = function (input, init) {
      const p = orig.apply(this, arguments);
      try {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if ((init?.method ?? 'GET') === 'POST' && /\/attachments$/.test(url.pathname)) {
          const name = url.searchParams.get('name');
          p.then((res) => res.clone().json().then((body) => window.__pcAttachResponses.push({ status: res.status, name, body }), () => window.__pcAttachResponses.push({ status: res.status, name, body: null })), () => {});
        }
      } catch { /* 不是这类请求 */ }
      return p;
    };
  });
  page.attachResponses = () => page.evaluate(() => window.__pcAttachResponses ?? []).catch(() => []);
  page.failures = [];
  page.on('requestfailed', (r) => page.failures.push(`${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) page.failures.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`); });
  page.consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[collab]')) page.consoleErrors.push(m.text().slice(0, 300)); });
  if (mobile) {
    await page.emulate({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else await page.setViewport({ width: 1600, height: 900 });
  for (const code of init) await page.evaluateOnNewDocument(code);
  return page;
}

export async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}

export const mockSteps = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;

/** 云端 AI 栏里的消息与会话状态(经 `window.__pcCloud` 的只读钩子) */
export const msgs = (page, tab = 'main') => P(page, (t) => window.__pcCloud?.[t]?.messages() ?? null, tab).catch(() => null);
export const view = (page, tab = 'main') => P(page, (t) => window.__pcCloud?.[t]?.view() ?? null, tab).catch(() => null);
export const conversationOf = (page, tab = 'main') => P(page, (t) => window.__pcCloud?.[t]?.conversationId() ?? null, tab).catch(() => null);
export const toolParts = (messages) => (messages ?? []).filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []).filter((p) => p.kind === 'tool');
export const toolCount = (messages) => toolParts(messages).length;
export const lastAssistant = (messages) => [...(messages ?? [])].reverse().find((m) => m.role === 'assistant') ?? null;
export const idle = (page) => view(page).then((v) => v && !v.streaming);
export const panelText = (page) => P(page, () => document.querySelector('[data-pc="cloud-ai-panel"]')?.innerText ?? '').catch(() => '');
export const providerOptions = (page) => P(page, () => {
  const s = document.querySelector('[data-pc="ai-provider"]');
  return s ? { value: s.value, options: [...s.options].map((o) => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled, title: o.title })) } : null;
}).catch(() => null);

export async function sendText(page, text, panelSel = '[data-pc="cloud-ai-panel"]') {
  await P(page, (t, sel) => {
    const ta = document.querySelector(`${sel} [data-pc="ai-input"]`);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, t);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, text, panelSel);
  // 测量遮罩常在项目被改之后几秒才冒出来(冷启动的桌面 dev server 上更晚):多等一会儿再点,免得点在遮罩上、消息没发出去
  await gateSettled(page, { appearMs: 1500 });
  await page.click(`${panelSel} [data-pc="ai-send"]`);
}

/** 在线页面:开始页填项目名、用户名、密码进项目(`asCreator` 走「我是创建者」) */
export async function joinOnline(page, { site, name, username, password, asCreator = false }) {
  await page.goto(`${site}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  if (asCreator) await page.click('[data-pc="join-as-creator"]');
  await typeInto(page, '[data-pc="join-name"]', name);
  const userLocked = await page.$eval('[data-pc="join-username"]', (i) => i.disabled).catch(() => false);
  if (!userLocked) await typeInto(page, '[data-pc="join-username"]', username);
  await typeInto(page, '[data-pc="join-password"]', password);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await page.waitForFunction(() => !!window.__pcStore && window.__pcStore.getState().project.tracks.length > 0, { timeout: 60_000 });
  await gateSettled(page);
}

/**
 * 等「正在测量卡片」的遮罩放开并稳住:它在进项目几秒之后才出现(舞台就绪了才开始测),期间盖住整个编辑器、鼠标点不下去。
 * 连续 `quietMs` 没有遮罩才算放开。
 */
export async function gateSettled(page, { appearMs, quietMs = 3000, ms = 300_000 } = {}) {
  const t0 = Date.now();
  const up = () => page.evaluate(() => !!document.querySelector('[data-pc="probe-gate"]')).catch(() => false);
  // 先等它出现(这一页已经等过一次、之后又没出现过的,只等一小会儿)
  const waitAppear = appearMs ?? (page.__gateSeen ? quietMs : 12_000);
  let seen = false;
  while (Date.now() - t0 < waitAppear) {
    if (await up()) { seen = true; break; }
    await delay(200);
  }
  page.__gateSeen = true;
  if (!seen) return true;
  // 出现了:等它放开,并连续 quietMs 没有再出现(测完一轮可能紧接着再排一轮)
  let clearSince = null;
  while (Date.now() - t0 < ms) {
    if (await up()) clearSince = null;
    else if (clearSince === null) clearSince = Date.now();
    else if (Date.now() - clearSince >= quietMs) return true;
    await delay(200);
  }
  return false;
}

/** 点一个按钮,直到 `done()` 为真(遮罩刚好盖上来、点不下去时再点);回点了几次,没成回 0 */
export async function clickUntil(page, selector, done, { tries = 4, waitMs = 3000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    await gateSettled(page, { appearMs: 600 });
    await page.click(selector).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (await done().catch(() => false)) return i;
      await delay(150);
    }
  }
  return 0;
}

/** 桌面版形态的页面:进编辑器、等舞台起来、关掉首次打开的 AI 设置弹窗 */
export async function openDesktopEditor(page, origin, query = 'editor&nosetup=1&aimock=1') {
  await page.goto(`${origin}/?${query}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]'), { timeout: 300_000, polling: 500 });
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  await page.waitForSelector('[data-pc="ai-provider"]', { timeout: 60_000 }).catch(() => {});
  await gateSettled(page);
}

/** 桌面版形态的页面此刻连着的共享项目号(没连回 null) */
export const sharedProjectOf = (page) => P(page, async () => { const S = await import('/src/editor/sync/syncManager.ts'); return S.getSyncView().shared?.projectId ?? null; }).catch(() => null);

/** 项目设置里某个托管方服务的勾选状态 */
export const hostedToggle = (page, service) => page.$eval(`[data-pc="collab-hosted-${service}-toggle"]`, (i) => ({ checked: i.checked, disabled: i.disabled })).catch(() => null);

/** 打开项目设置(监听挂上之前发的事件会丢:隔几秒再发,直到「多用户协作」一组出来) */
export async function openProjectSettings(page, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    await P(page, () => window.dispatchEvent(new Event('pc-open-project-settings')));
    if (await page.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 3000 }).then(() => true, () => false)) return;
    if (Date.now() - t0 > ms) throw new Error('项目设置没打开');
  }
}

/** 创建者在项目设置里点某个托管方服务的勾选:验证创建者身份 → 确认。回确认弹窗里的那句话 */
export async function creatorToggleService(page, service, creatorPassword) {
  await page.waitForSelector(`[data-pc="collab-hosted-${service}-toggle"]`, { visible: true, timeout: 15_000 });
  await page.click(`[data-pc="collab-hosted-${service}-toggle"]`);
  await page.waitForSelector('[data-pc="creator-verify"]', { visible: true, timeout: 10_000 });
  await typeInto(page, '#pc-cv-pw', creatorPassword);
  await P(page, () => [...document.querySelectorAll('[data-pc="creator-verify"] button')].find((b) => b.textContent?.trim() === '验证')?.click());
  await page.waitForSelector('[data-pc="hosted-service-dialog"]', { visible: true, timeout: 15_000 });
  const body = await page.$eval('[data-pc="hosted-service-dialog"]', (el) => el.textContent ?? '').catch(() => '');
  await page.click('[data-pc="hosted-service-confirm"]');
  await page.waitForFunction(() => !document.querySelector('[data-pc="hosted-service-dialog"]'), { timeout: 15_000 });
  return body;
}

/** 关掉项目设置等弹窗 */
export async function closeDialogs(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.$('.pc-dialog, [data-pc="collab-section"]'))) return;
    await page.keyboard.press('Escape');
    await delay(250);
  }
}

/** AI 栏里的「Agent 操作记录」:总条数,与此刻画出来的几行(最新的在前;列表是虚拟化的,只画可见的十来行) */
export const eventLog = (page) => P(page, () => {
  const box = document.querySelector('[data-pc="agent-event-log"]');
  if (!box) return null;
  return {
    count: Number((box.querySelector('.pc-evlog-count')?.textContent ?? '').replace(/\D/g, '')) || 0,
    rows: [...box.querySelectorAll('[data-pc="agent-event"]')].map((r) => {
      const undo = r.querySelector('[data-pc="agent-undo"]');
      return { id: r.getAttribute('data-event-id'), tool: r.querySelector('.pc-evlog-tool')?.textContent ?? '', who: r.querySelector('.pc-evlog-who')?.textContent ?? '', status: r.getAttribute('data-status'), undo: undo ? (undo.disabled ? 'done' : 'ready') : null };
    }),
  };
}).catch(() => null);

/** 成员列表弹层里的行(点开再读,读完关上) */
export async function membersList(page, opts = {}) {
  await page.click('[data-pc="members-button"]');
  await page.waitForSelector('[data-pc="members-pop"]', { visible: true, timeout: 8000 }).catch(() => {});
  // 有 Agent 连接的行逐个点开读(一次只展开一行;「〈成员名〉的云端 Agent」在展开的子行里)
  const out = await P(page, async () => {
    const pop = document.querySelector('[data-pc="members-pop"]');
    const rows = [];
    for (const r of pop?.querySelectorAll('.pc-members-row') ?? []) {
      const main = r.querySelector('.pc-members-row-main.is-expandable');
      if (main && !r.querySelector('.pc-members-sub')) { main.click(); await new Promise((ok) => setTimeout(ok, 120)); }
      rows.push({
        text: (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
        cloudTag: !!r.querySelector('[data-pc="members-cloud-agent"]'),
        cloudRow: r.querySelector('[data-pc="members-cloud-agent-row"]')?.textContent?.trim() ?? null,
        editing: /\[编辑中\]/.test(r.textContent ?? ''),
        offlineTag: r.querySelector('[data-pc="members-offline-agent"]')?.textContent?.trim() ?? null,
        name: r.querySelector('.pc-members-name')?.textContent?.trim() ?? null,
      });
    }
    return { button: document.querySelector('[data-pc="members-button"]')?.textContent?.trim() ?? '', count: document.querySelector('[data-pc="members-count"]')?.textContent?.trim() ?? '', rows };
  }).catch(() => null);
  if (opts.shot) await page.screenshot({ path: opts.shot }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 887);
  return out;
}

/* ---------------- 舞台 ---------------- */

export const stageFrames = (page) => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
export async function visibleStage(page) {
  for (const f of stageFrames(page)) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return stageFrames(page)[0] ?? null;
}
/** 可见舞台里某个片段:有没有贴着预渲染的快照(快照层里有内容)、占位显没显示与原因 */
export async function clipOnStage(page, id) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((cid) => {
    const w = document.querySelector(`[data-pc-clip="${cid}"]:not([data-pc-media])`);
    if (!w) return { wrapper: false };
    const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
    const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
    const plane = slot?.querySelector('[data-pc-placeholder-plane]');
    return {
      wrapper: true,
      snapshot: !!snap && snap.childElementCount > 0,
      snapNodes: snap ? snap.querySelectorAll('*').length : 0,
      placeholder: !!slot && !slot.hidden,
      reason: slot && !slot.hidden ? (slot.getAttribute('data-pc-placeholder-reason') ?? plane?.getAttribute('data-pc-placeholder-reason') ?? null) : null,
      suppressed: w.classList.contains('pc-suppressed'),
    };
  }, id).catch(() => null);
}
/** 给可见舞台截图(放大到约 1600 宽);回文件路径与截图的字节 */
export async function stageShot(page, file) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const bytes = await page.screenshot({ path: file, clip: { ...box, scale: Math.min(4, 1600 / box.width) } }).catch(() => null);
  return bytes ? { file, bytes: Buffer.from(bytes) } : null;
}
/**
 * 一张截图的像素统计(在一个空白页里解码,不引图片库):不同颜色的个数(量化到每通道 16 级)、最多的那种颜色占多少。
 * 画面是渲出来的内容时颜色有好几种、没有哪一种占满;占位或空白时几乎只有一种颜色。
 */
export async function pixelStats(browser, pngBytes) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Map();
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) { // 每 7 个像素取一个
        const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        seen.set(k, (seen.get(k) ?? 0) + 1);
        n += 1;
      }
      const top = Math.max(...seen.values());
      return { width: c.width, height: c.height, colors: seen.size, topShare: Number((top / n).toFixed(4)) };
    }, Buffer.from(pngBytes).toString('base64'));
  } finally { await page.close().catch(() => {}); }
}
