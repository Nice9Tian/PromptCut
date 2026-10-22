/** 只给测试用的 Agent 服务入口：单独一个进程里起账号版 Agent 的对话接口与读取控制（和
 * `account-password-user-path.mjs` 进程内那一套是同样几样：对话客户端、主身份、读取控制客户端、对话服务、HTTP），
 * 让测试能**真的结束这个进程**（硬杀，不给它收口的机会）再在同一个数据目录上起一个新的，复现「Agent 服务重启」。
 *
 * 配置从环境变量 `PROMPTCUT_TEST_AGENT_CONFIG`（一段 JSON）读：文档服务内部口、它的证书指纹、本进程的客户端证书与私钥、
 * CA 的文件路径、本地回执账本的路径、HTTP 端口。里面没有秘密以外的东西会被打印。
 *
 * 父进程经进程间通道能说三样：
 * - `{ type: 'hold-read-close' }`：之后文档服务点名要关的读取先不关（模拟这个实例活着、却迟迟没关完），回 `held`；
 * - `{ type: 'release-read-close' }`：放开，回 `released`；
 * - `{ type: 'close' }`：正常收口再退出。
 * 起好以后在标准输出打一行 `{"event":"agent.ready","pid":…,"instanceId":…,"instanceGeneration":…}`。
 */
import fs from 'node:fs';
import http from 'node:http';
import { createConversationClient } from '../../agent-service/conversation-client.mjs';
import { createRunClient } from '../../agent-service/run-client.mjs';
import { createConversationControlClient } from '../../agent-service/conversation-control-client.mjs';
import { createHostedWiring } from '../../agent-service/hosted-wiring.mjs';
import { createHostedAgentService } from '../../agent/service/create-agent-service.mjs';
import { createAgentHttp } from '../../agent-service/http.mjs';

const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
const config = JSON.parse(process.env.PROMPTCUT_TEST_AGENT_CONFIG ?? '{}');
const options = { origin: config.origin, serverFingerprint256: config.serverFingerprint256,
  tls: { key: fs.readFileSync(config.keyFile), cert: fs.readFileSync(config.certFile), ca: fs.readFileSync(config.caFile) } };
let client, runClient, control, service, server, release = null, gate = null;
try {
  client = createConversationClient(options);
  runClient = createRunClient(options);
  control = createConversationControlClient({ ...options, runClient, receiptFile: config.receiptFile,
    onDiagnostic: entry => log('agent.read-control', { code: entry?.code ?? null }) });
  client.useReadControl(control);
  // 「迟迟没关完」：文档服务点名要关的读取，先等父进程放开再关
  const transports = control.transports, fence = transports.fence;
  transports.fence = ids => {
    if (!gate) return fence.call(transports, ids);
    const waiting = (async () => { await gate; return fence.call(transports, ids); })();
    waiting.catch(() => {}); return waiting;
  };
  await control.start();
  const until = Date.now() + 15_000;
  while (!control.describe().connected) {
    if (Date.now() > until) throw Object.assign(new Error('read-control-not-ready'), { code: 'read-control-not-ready' });
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const wiring = createHostedWiring({ accountMode: true, conversationClient: client });
  service = createHostedAgentService({ accountMode: true, conversationClient: client });
  const agentHttp = createAgentHttp({ service, authenticate: wiring.authenticate });
  server = http.createServer((req, res) => { void agentHttp.handle(req, res); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  const identity = runClient.instanceIdentity();
  log('agent.ready', { pid: process.pid, instanceId: identity.instanceId, instanceGeneration: identity.instanceGeneration });
} catch (error) {
  log('agent.start-failed', { code: error.code ?? error.message ?? 'agent-start' });
  process.exitCode = 1; process.disconnect?.();
}
process.on('message', message => {
  if (message?.type === 'hold-read-close') { gate = new Promise(resolve => { release = resolve; }); process.send({ type: 'held' }); }
  else if (message?.type === 'release-read-close') { release?.(); gate = null; release = null; process.send({ type: 'released' }); }
  else if (message?.type === 'close') {
    release?.();
    void (async () => {
      await control?.close();
      await new Promise(resolve => { if (!server?.listening) return resolve(); server.close(resolve); server.closeAllConnections?.(); });
      await service?.close?.(); await client?.close?.(); await runClient?.close?.();
    })().catch(() => { process.exitCode = 1; }).finally(() => process.disconnect());
  }
});
