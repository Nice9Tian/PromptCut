// W1 重启测试里扮「Agent 服务进程」的子进程:起网页操作工具、打开一页、把浏览器的进程号报给父进程,然后挂着等被杀。
// 授权在这里是放行的桩(这条测试验的是进程的生死,授权在 cloud-tools-w1-browser.test.mjs 里验)。
import { createEgressGate } from '../agent/service/egress.mjs';
import { createHostedBrowserTools } from '../agent/service/hosted-browser.mjs';

const [dataDir, executablePath, url, allow] = process.argv.slice(2);
const resources = {
  authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }),
  register: async () => ({ signal: new AbortController().signal, closed: new Promise(() => {}) }),
};
const gate = createEgressGate({ testAllow: [allow], resolve: async () => { throw new Error('ENOTFOUND'); } });
const extraArgs = String(process.env.W1_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean);
const tools = createHostedBrowserTools({ resources, egress: gate, dataDir, runtime: { executablePath, extraArgs } });
const context = { projectId: 'sp_restart', conversationId: 'conversation_restart', runId: 'run1', runGrantId: 'grant1', instanceId: 'instance1', instanceGeneration: 1, senderAccountId: 'sender', messageId: 'message1' };
const view = await tools.call('web_open', { url }, context);
const session = tools.describe().sessions[0];
process.stdout.write(`${JSON.stringify({ ok: view.ok, error: view.error ?? null, rev: view.rev, uids: (view.clickable ?? []).map((c) => c.u), browserPid: session?.browserPid, pids: session?.pids ?? [] })}\n`);
setInterval(() => {}, 1000);
