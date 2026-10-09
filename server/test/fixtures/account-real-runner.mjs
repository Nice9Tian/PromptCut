import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { startCloudQueueUserFixture } from './cloud-queue-user-path.mjs';
import { createAccountExecutorAssembly } from '../../agent-service/account-executor-assembly.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const REAL_RUNNER_PORTS = Object.freeze([6660, 6661, 6662, 6663, 6664, 6665, 6668]);
export const REAL_RUNNER_TEXT = '真实文档短任务已执行；关闭结算仍在等待。';
export const REAL_RUNNER_NAME = 'Agent actual document edit';
export const REAL_RUNNER_PROMPT = '验证真实工具与项目修改。\n```mock-script\n' + JSON.stringify([
  { tool: 'get_project', input: {} }, { tool: 'get_selection', input: {} },
  { tool: 'report_progress', input: { final: false, stage: '真实工具短链', done: ['已读真实项目与选区'], todo: ['等待关闭结算'] } },
  { tool: 'set_project_meta', input: { name: REAL_RUNNER_NAME } },
  { say: REAL_RUNNER_TEXT },
]) + '\n```';

// True VH + hosted doc/order/instance/read control + independent asset. Only
// model responses use the existing scripted mock provider; runner/tools/SSR/WSS
// and accepted operation projection are the real product implementations.
export async function startAccountRealRunnerFixture({ publicHandler = null, diagnostic = () => {} } = {}) {
  let executor, vite, runClient; const logs = [], humanSockets = new Set();
  const fixture = await startCloudQueueUserFixture({ ports: [...REAL_RUNNER_PORTS], agentPort: 6666, publicHandler,
    diagnostic, async createAgentService({ agentOptions, agentClient, agentRunClient, agentReadControl, dir, combo: actualCombo }) {
      runClient = agentRunClient;
      vite = await createServer({ configFile: false, root: ROOT, cacheDir: path.join(dir, 'agent-vite-cache'),
        logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
      try {
        executor = await createAccountExecutorAssembly({ dataDir: path.join(dir, 'actual-agent'), doc: agentOptions,
          runClient: agentRunClient, conversationClient: agentClient, readControl: agentReadControl,
          controlPort: 6669, root: ROOT, loadModule: id => vite.ssrLoadModule(id),
          modelConfig: async () => ({ vendor: 'mock', model: 'scripted-local-response' }),
          log: (event, fields) => logs.push({ event, code: fields?.code }) });
        return { service: executor.service, async close() {
          const results = await Promise.allSettled([executor.close(), vite.close()]);
          const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
          if (errors.length) throw new AggregateError(errors, 'real-runner-assembly-close');
        } };
      } catch (error) { await vite.close(); throw error; }
    } });
  const ca = fs.readFileSync(fixture.caFile);
  const request = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(fixture.origin + route, { method, ca, timeout: 10000,
      headers: { ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers } }, res => {
        const bytes = []; res.on('data', chunk => bytes.push(chunk)); res.once('error', reject);
        res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(bytes).toString()),
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); } catch (error) { reject(error); } });
      });
    req.once('error', reject); req.once('timeout', () => req.destroy(Error('fixture-http-timeout'))); req.end(text);
  });
  const connectActor = async index => {
    let cookie = '', csrf = '';
    const site = async (route, body) => { const result = await request('/api/account' + route, { method: body ? 'POST' : 'GET', body,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: fixture.origin, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
      if (result.cookie) cookie = result.cookie; if (result.body.csrfToken) csrf = result.body.csrfToken; return result; };
    await site('/me'); const login = await site('/login', fixture.accounts[index]);
    if (login.status !== 200) throw Error('actual-account-login');
    const editor = await site('/editor/session', { deviceId: `actual-runner-${index}`, deviceName: 'Runner target', requestId: `actual-editor-${index}` });
    if (editor.status !== 200) throw Error('actual-editor-session');
    const doc = (route, body) => request('/hosted/shared/account/' + route, { method: 'POST', body,
      headers: { authorization: `Bearer ${editor.body.accessToken}` } });
    const consent = await site('/cloud-agent-consent', { accept: true, noticeVersion: 1, requestId: `actual-consent-${index}` });
    if (consent.status !== 200) throw Error('actual-account-consent');
    let session = await doc('session', { projectId: fixture.projectId, deviceId: `actual-runner-${index}`, requestId: `actual-session-${index}` });
    if (session.status !== 200) throw Error('actual-doc-session');
    if (index === 0) {
      const changed = await doc('admin', { projectId: fixture.projectId, op: 'set-hosted-service', service: 'agent', enabled: true,
        expectedAccessRevision: session.body.accessRevision, requestId: 'actual-enable-agent' });
      if (changed.status !== 200) throw Error('actual-agent-admin');
      session = await doc('session', { projectId: fixture.projectId, deviceId: `actual-runner-${index}`, requestId: 'actual-enabled-session' });
    }
    const ws = new WebSocket(fixture.origin.replace('https:', 'wss:') + '/hosted/',
      ['promptcut.v1', `promptcut.account.${session.body.connectionTicket}`], { ca, origin: fixture.origin });
    const closed = new Promise(resolve => ws.once('close', resolve)); humanSockets.add(ws); ws.once('close', () => humanSockets.delete(ws));
    const send = frame => new Promise((resolve, reject) => { const reqId = `human-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { ws.off('message', receive); reject(Error('actual-page-request-timeout')); }, 10000);
      const receive = bytes => { const reply = JSON.parse(bytes.toString()); if (reply.reqId !== reqId) return;
        clearTimeout(timer); ws.off('message', receive); resolve(reply); };
      ws.on('message', receive); ws.send(JSON.stringify({ ...frame, reqId })); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const opened = await send({ type: 'project.open', projectId: fixture.projectId });
    const pageId = `actual-page-${index}`;
    const selection = await send({ type: 'selection.set', projectId: fixture.projectId, pageId, revision: 1, selection: { clipIds: [] } });
    if (selection.type !== 'selection.ok') throw Error('actual-page-selection');
    return { opened, pageId, send, session: session.body,
      agent: (route, body) => request('/agent/v1' + route, { method: body ? 'POST' : 'GET', body,
        headers: { authorization: `Bearer ${session.body.agentDelegationTicket}` } }),
      async close() { ws.terminate(); await closed; } };
  };
  return { ...fixture, connectActor, rows: (projectId, conversationId) => executor.service.runEvents.after({ projectId, conversationId }).events,
    describe: () => ({ ...executor.describe(), dataConnections: executor.dataClient.openCount(), logs: logs.slice() }),
    checkRun: row => runClient.checkAccess({ projectId: row.projectId, runGrantId: row.runGrantId, action: 'read' }),
    async close() { await Promise.all([...humanSockets].map(ws => { const done = new Promise(resolve => ws.once('close', resolve)); ws.terminate(); return done; }));
      return fixture.close(); } };
}
