/**
 * 0.7.18 验收补证据（组名 auth）共用的底座。只被 server/test/accept-018-auth-*.test.mjs 用，不改任何产品代码和已有的底座。
 *
 * 端口：见 acceptPorts（缺省在 31000～37999 里随机挑空着的连续一段，同一次 npm test 里的各文件互不撞）。
 * 手动跑时可设环境变量 ACCEPT018_AUTH_PORT_BASE（28560～28599 内），就从这个号起连着用，
 * 此时同一时间只能跑一个用到端口的 accept-018-auth 文件。
 *
 * 需要账号后端源码，要和 npm test 一样设好 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE。
 */
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { freePorts } from '../free-ports.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const providerAvailable = Boolean(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT) &&
  Boolean(process.env.PROMPTCUT_PASSWORD_ORDER_MODULE) &&
  fs.existsSync(path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT, 'account/internal.mjs'));
export const SKIP_WITHOUT_PROVIDER = providerAvailable ? false :
  'account provider unavailable; set PROMPTCUT_ACCOUNT_PROVIDER_ROOT and PROMPTCUT_PASSWORD_ORDER_MODULE';

const canListen = port => new Promise(resolve => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

/**
 * 要连续的 count 个端口。手动跑设了 ACCEPT018_AUTH_PORT_BASE 就从那里起；否则在 31000～37999 里随机挑一段、逐个试着监听确认空着。
 * 不用系统的临时端口段：那一段也是本机发出连接时随机取源端口的地方，刚放掉的号可能马上被别的连接占走，起素材子进程时会报 EADDRINUSE。
 * 挑不到才退回向系统要空闲端口。
 */
export async function acceptPorts(count) {
  const base = Number(process.env.ACCEPT018_AUTH_PORT_BASE);
  if (Number.isInteger(base) && base >= 28560 && base + count - 1 <= 28599)
    return Array.from({ length: count }, (_, index) => base + index);
  for (let attempt = 0; attempt < 40; attempt++) {
    const start = 31000 + Math.floor(Math.random() * 7000);
    const range = Array.from({ length: count }, (_, index) => start + index);
    let free = true;
    for (const port of range) if (!await canListen(port)) { free = false; break; }
    if (free) return range;
  }
  return freePorts(count);
}

/** JSON 请求；返回 { status, body, cookie }，对方不是 JSON 时 body 为 null */
export function httpsJson(origin, ca, route, { method = 'GET', body, headers = {}, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(origin + route, { method, ca, timeout,
      headers: { ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
      const bytes = [];
      res.on('data', chunk => bytes.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(bytes).toString('utf8')); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: parsed, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(Error('accept-http-timeout')));
    req.end(text);
  });
}

/**
 * 真实的账号模式云端 Agent 全链：账号后端（真源码）、文档服务、独立素材进程、Agent 公共入口、
 * 真的任务执行器（模型替身按脚本回话，工具和文档写入是真的）。和 account-real-runner 的搭法相同，
 * 差别：端口可指定；文档服务的时钟可整体向前拨（clock.offset），用来验身份证明过期。
 */
export async function startAgentPath({ diagnostic = () => {}, extraPorts = 2 } = {}) {
  const clock = { offset: 0 };
  const realCombo = await import('../../hosted/combo.mjs');
  mock.module(pathToFileURL(path.join(ROOT, 'server/hosted/combo.mjs')).href, {
    namedExports: { ...realCombo, startHostedCombo: options => realCombo.startHostedCombo({ ...options, now: () => Date.now() + clock.offset }) } });
  const { startCloudQueueUserFixture } = await import('./cloud-queue-user-path.mjs');
  const { createAccountExecutorAssembly } = await import('../../agent-service/account-executor-assembly.mjs');
  const { createServer } = await import('vite');
  const ports = await acceptPorts(7 + extraPorts);
  const [agentPort, controlPort] = ports.slice(7);
  let executor, vite; const logs = [];
  const fixture = await startCloudQueueUserFixture({ ports: ports.slice(0, 7), agentPort, diagnostic,
    async createAgentService({ agentOptions, agentClient, agentRunClient, agentReadControl, dir }) {
      vite = await createServer({ configFile: false, root: ROOT, cacheDir: path.join(dir, 'agent-vite-cache'),
        logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
      try {
        executor = await createAccountExecutorAssembly({ dataDir: path.join(dir, 'actual-agent'), doc: agentOptions,
          runClient: agentRunClient, conversationClient: agentClient, readControl: agentReadControl,
          controlPort, root: ROOT, loadModule: id => vite.ssrLoadModule(id),
          modelConfig: async () => ({ vendor: 'mock', model: 'scripted-local-response' }),
          log: (event, fields) => logs.push({ event, code: fields?.code }) });
        return { service: executor.service, async close() {
          const results = await Promise.allSettled([executor.close(), vite.close()]);
          const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
          if (errors.length) throw new AggregateError(errors, 'accept-auth-assembly-close');
        } };
      } catch (error) { await vite.close(); throw error; }
    } });
  const ca = fs.readFileSync(fixture.caFile);
  const agentDataDir = path.join(fixture.fixtureDir, 'actual-agent');
  const sockets = new Set();

  /** 一个账号：用网站路径注册或登录，拿到编辑器令牌；之后按项目取会话、开页面连接 */
  async function openAccount({ name, password, register = false }) {
    let cookie = '', csrf = '';
    const request = (route, opts) => httpsJson(fixture.origin, ca, route, opts);
    const site = async (route, body) => {
      const result = await request('/api/account' + route, { method: body ? 'POST' : 'GET', body,
        headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: fixture.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
      if (result.cookie) cookie = result.cookie;
      if (result.body?.csrfToken) csrf = result.body.csrfToken;
      return result;
    };
    await site('/me');
    const entered = await site(register ? '/register' : '/login', { name, password });
    if (entered.status !== 200) throw Error(`accept-account-${register ? 'register' : 'login'}-${entered.status}`);
    const editor = await site('/editor/session', { deviceId: `accept-${name}`, deviceName: `Accept ${name}`, requestId: `accept-editor-${name}` });
    if (editor.status !== 200) throw Error(`accept-editor-session-${editor.status}`);
    const accessToken = editor.body.accessToken;
    const doc = (route, body) => request('/hosted/shared/account/' + route, { method: 'POST', body, headers: { authorization: `Bearer ${accessToken}` } });
    const consent = await site('/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId: `accept-consent-${name}` });
    if (consent.status !== 200) throw Error(`accept-consent-${consent.status}`);
    const account = { name, accountId: entered.body.account.id, site, doc, accessToken, request, sessions: new Map() };
    /** 取这个项目的会话（含对话委托），可选再开一条页面连接并设置选区 */
    account.enter = async (projectId, { page = true, deviceTag = 'main' } = {}) => {
      const session = await doc('session', { projectId, deviceId: `accept-${name}-${deviceTag}`, requestId: `accept-session-${name}-${projectId}-${deviceTag}-${Date.now()}` });
      if (session.status !== 200) return { session, denied: true };
      const entry = { session, projectId, delegation: session.body.agentDelegationTicket,
        agent: (route, body, opts = {}) => request('/agent/v1' + route, { method: opts.method ?? (body ? 'POST' : 'GET'), body,
          headers: { authorization: `Bearer ${opts.token ?? session.body.agentDelegationTicket}` } }) };
      if (page) {
        const ws = new WebSocket(fixture.origin.replace('https:', 'wss:') + '/hosted/',
          ['promptcut.v1', `promptcut.account.${session.body.connectionTicket}`], { ca, origin: fixture.origin });
        const closed = new Promise(resolve => ws.once('close', resolve));
        sockets.add(ws); ws.once('close', () => sockets.delete(ws));
        const send = frame => new Promise((resolve, reject) => {
          const reqId = `accept-${Math.random().toString(36).slice(2)}`;
          const timer = setTimeout(() => { ws.off('message', receive); reject(Error('accept-page-request-timeout')); }, 10_000);
          const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return; clearTimeout(timer); ws.off('message', receive); resolve(reply); };
          ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId }));
        });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        entry.opened = await send({ type: 'project.open', projectId });
        entry.pageId = `accept-page-${name}-${deviceTag}`;
        const selection = await send({ type: 'selection.set', projectId, pageId: entry.pageId, revision: 1, selection: { clipIds: [] } });
        if (selection.type !== 'selection.ok') throw Error('accept-page-selection');
        Object.assign(entry, { send, ws, closed });
      }
      account.sessions.set(`${projectId}/${deviceTag}`, entry);
      return entry;
    };
    return account;
  }

  return { ...fixture, clock, ca, agentDataDir, openAccount, portList: ports,
    logs: () => logs.slice(),
    describe: () => executor.describe(),
    rows: (projectId, conversationId) => executor.service.runEvents.after({ projectId, conversationId }).events,
    async close() {
      await Promise.all([...sockets].map(ws => { const done = new Promise(resolve => ws.once('close', resolve)); ws.terminate(); return done; }));
      return fixture.close();
    } };
}

/** 模型替身的脚本：```mock-script 代码块（见 server/harness/providers/mock.mjs） */
export const script = steps => '验收脚本。\n```mock-script\n' + JSON.stringify(steps) + '\n```';

export const waitUntil = async (check, label, ms = 30_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= until) throw Error(`timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
