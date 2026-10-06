/**
 * 托管档 Agent 服务的入口(契约 `docs/plan/cloud-agent-contract.md` 第 2.1、2.2 节):一个不带编辑页的 Node 进程。
 *
 *   1. 进程内起一个不带任何插件的 vite(middleware 模式,不监听、不提供页面),只用它的 `ssrLoadModule`
 *      载入工具实现(与 `server/test/c65b-kit.mjs` 的起法相同);前端代码只经 `server/agent/ssr-host.mjs` 这一处载入缝;
 *   2. 自己起一个 http 服务,只绑回环,提供 `http.mjs` 的接口。没有任何 `/api/*`;
 *   3. 按「项目 × 成员」分实例(`server/agent/service/create-agent-service.mjs`)。
 *
 * 跑:PROMPTCUT_AGENT_DATA=<数据目录> PROMPTCUT_AGENT_DOC_URL=ws://127.0.0.1:8787 node server/agent-service/main.mjs
 *
 * 环境变量:
 *   PROMPTCUT_AGENT_DATA           数据目录,必须已存在且可写
 *   PROMPTCUT_AGENT_DOC_URL        文档服务地址(同机回环,如 ws://127.0.0.1:8787;控制连接只认本机发起)
 *   PROMPTCUT_AGENT_SECRETS        服务身份的私钥目录(缺省 /var/lib/promptcut/agent-secrets),里面是 keygen 生成的 service-key.json(服务名 agent)
 *   PROMPTCUT_AGENT_HOST           缺省 127.0.0.1;只许回环(对外只经反向代理)
 *   PROMPTCUT_AGENT_PORT           缺省 8790
 *   PROMPTCUT_AGENT_PUBLIC_ORIGIN  可不设:对外的源(如 https://149-88-94-84.sslip.io),只做格式检查并记进日志。
 *                                  页面拿到的地址由托管组合的 PROMPTCUT_AGENT_PUBLIC_URL 经文档服务下发,不由本进程给
 *   PROMPTCUT_AGENT_RENDER_STALL_MS / PROMPTCUT_AGENT_RENDER_DEBOUNCE_MS
 *                                  可不设:补渲「连续多久没有进度就放弃」(缺省 10 分钟)与「写入落地后攒多久再发」(缺省 3 秒),排查与演练用
 *
 * 失败即关(打一行 `config.error { reason }`,退出码 1):`data-dir`、`doc-url`、`service-identity`(私钥读不到、格式不对、
 * 服务名不是 agent)、`public-origin`、`bind-public`、`listen`。文档服务一时连不上不算:控制连接自己退避重连,期间新请求回 503 `unavailable`。
 *
 * 数据目录里(契约第 2.2 节):`config/ai.json` 与 `config/keys/custom.key`(模型配置与 Key 的密文,`set-key.mjs` 写)、
 * `config/limits.json`(各项目额度与节点并发,`admin.mjs quota` 写,改了即生效)、`tenants/`(对话)、`usage/`(用量流水)。
 * 进程起来时把上一个进程没收尾的对话标成「中断」(不自动续跑),并按各对话的 `pending-render.json` 重发补渲。
 * 收到 SIGTERM / SIGINT:进行中的每一轮记「中断」后停下,状态落盘,5 秒内退出。
 *
 * 鉴权(契约第 4 节):命令行入口凭服务私钥连文档服务的控制连接(`server/auth/service-client.mjs`),每个请求的委托票据、
 * 每一轮的对话委托都交文档服务核验;连文档服务的数据连接用凭对话委托换来的连接票据(`hosted-wiring.mjs`)。
 * 补渲经服务身份的发布连接进文档服务的任务队列(`render-publisher.mjs`)。测试经 `startAgentService({ authenticate, credentials })` 给替身。
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import v8 from 'node:v8';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { readModelConfig } from '../agent/service/model-config.mjs';
import { createAgentHttp } from './http.mjs';
import { createHostedWiring } from './hosted-wiring.mjs';
import { createServiceClient } from '../auth/service-client.mjs';
import { readServiceKeyFile } from '../auth/service-identity.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export class AgentConfigError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.reason = reason;
  }
}

const isLoopbackHost = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);


/**
 * 起服务。回 `{ url, port, service, close }`。
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} o.docUrl
 * @param {string} [o.host]
 * @param {number} [o.port] 0 = 随机(测试)
 * @param {(req) => object | null} [o.authenticate] 请求 → 身份;不给时一律 401
 * @param {{ protocolsFor(identity, n): string[] | Promise<string[]> }} [o.credentials] 连文档服务的凭证;不给时任何对话都起不来
 * @param {() => object | Promise<object>} [o.modelConfig] 不给就读数据目录里的模型配置
 * @param {object} [o.publisher] 补渲的发布通道(接口位,见 `server/agent/service/render-request.mjs`)
 * @param {object} [o.projectState] 各项目的开关(接口位,见 `create-agent-service.mjs`)
 */
export async function startAgentService({
  dataDir,
  docUrl,
  host = '127.0.0.1',
  port = 8790,
  authenticate = null,
  credentials = null,
  modelConfig = null,
  gate,
  limits,
  publisher = null,
  projectState,
  storeLimits,
  renderLimits,
  root = ROOT,
  version = 'dev',
  codeVersion = null,
  log = () => {},
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new AgentConfigError('data-dir', '没有给数据目录');
  try {
    if (!fs.statSync(dataDir).isDirectory()) throw new Error('不是目录');
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (err) {
    throw new AgentConfigError('data-dir', `数据目录不可用:${err?.message ?? err}`);
  }
  if (typeof docUrl !== 'string' || !/^wss?:\/\//.test(docUrl)) throw new AgentConfigError('doc-url', '文档服务地址要是 ws(s)://');
  if (!isLoopbackHost(host)) throw new AgentConfigError('bind-public', '这个服务只许绑回环地址,对外经反向代理');

  // 测试用的换驱动口子不带进这个进程(契约第 2.1 节)
  delete process.env.PROMPTCUT_AI_FAKE_RUNNER;
  delete process.env.PROMPTCUT_AI_RUNNER_MODULE;

  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  const service = createHostedAgentService({
    root,
    loadModule: (id) => vite.ssrLoadModule(id),
    docUrl,
    credentials: credentials ?? { protocolsFor: async () => { throw new Error('这个进程还没有连文档服务的凭证'); } },
    // 缺省读数据目录里的那一份(`config/ai.json` 与 `config/keys/custom.key`,由 set-key.mjs 写);每一轮开始时现读,换 Key 不用重启。
    // 不读 PROMPTCUT_AI_CONFIG,也不读这台机器上用户自己的 ai.json
    modelConfig: modelConfig ?? (() => readModelConfig(dataDir)),
    dataDir,
    ...(gate ? { gate } : {}),
    ...(limits ? { limits } : {}),
    ...(publisher ? { publisher } : {}),
    ...(projectState ? { projectState } : {}),
    ...(storeLimits ? { storeLimits } : {}),
    ...(renderLimits ? { renderLimits } : {}),
    log,
  });
  const api = createAgentHttp({ service, authenticate, version, codeVersion, log });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (err) {
    await service.close();
    await vite.close();
    throw new AgentConfigError('listen', `监听失败:${err?.message ?? err}`);
  }
  const actual = server.address().port;
  log('agent.listen', { host, port: actual });

  let closing = null;
  return {
    port: actual,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${actual}`,
    service,
    close() {
      closing ??= (async () => {
        await service.close();
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
        await vite.close();
      })();
      return closing;
    },
  };
}

/* ---------------- 命令行入口 ---------------- */

function line(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

const positiveMs = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; };

async function main() {
  const fail = (reason, extra = {}) => {
    const text = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason, ...extra })}\n`;
    process.stdout.write(text);
    process.stderr.write(text);
    process.exitCode = 1;
  };
  const env = process.env;
  const port = env.PROMPTCUT_AGENT_PORT === undefined ? 8790 : Number(env.PROMPTCUT_AGENT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return fail('listen', { detail: 'PROMPTCUT_AGENT_PORT 不是端口号' });
  const docUrl = env.PROMPTCUT_AGENT_DOC_URL;
  if (typeof docUrl !== 'string' || !/^wss?:\/\//.test(docUrl)) return fail('doc-url', { detail: '文档服务地址要是 ws(s)://' });
  const origin = env.PROMPTCUT_AGENT_PUBLIC_ORIGIN || '';
  if (origin && !/^https?:\/\/[^/\s]+$/.test(origin)) return fail('public-origin', { detail: 'PROMPTCUT_AGENT_PUBLIC_ORIGIN 要是 http(s)://主机[:端口],不带路径' });
  let key;
  try {
    key = readServiceKeyFile(env.PROMPTCUT_AGENT_SECRETS || '/var/lib/promptcut/agent-secrets');
    if (key.service !== 'agent') throw new Error(`私钥文件是服务 ${key.service} 的,不是 agent`);
  } catch (err) {
    return fail('service-identity', { detail: String(err?.message ?? err).slice(0, 200) });
  }
  let version = 'dev';
  try { version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? 'dev'); } catch { /* 读不到就算了 */ }

  const client = createServiceClient({ base: docUrl, key, log: line });
  // 文档服务一时连不上不退出:客户端自己退避重连,期间请求回 503
  void client.ready().catch(() => {});
  const wiring = createHostedWiring({ client, docUrl, root: ROOT, log: line });
  const stall = positiveMs(env.PROMPTCUT_AGENT_RENDER_STALL_MS);
  const debounce = positiveMs(env.PROMPTCUT_AGENT_RENDER_DEBOUNCE_MS);
  let started;
  try {
    started = await startAgentService({
      dataDir: env.PROMPTCUT_AGENT_DATA,
      docUrl,
      host: env.PROMPTCUT_AGENT_HOST || '127.0.0.1',
      port,
      authenticate: wiring.authenticate,
      credentials: wiring.credentials,
      projectState: wiring.projectState,
      publisher: wiring.publisher,
      renderLimits: { ...(stall ? { stallMs: stall } : {}), ...(debounce ? { debounceMs: debounce } : {}) },
      version,
      codeVersion: () => wiring.publisher.codeVersion(),
      log: line,
    });
  } catch (err) {
    wiring.close();
    client.close();
    if (err instanceof AgentConfigError) return fail(err.reason, { detail: err.message });
    throw err;
  }
  wiring.attach(started.service);
  line('agent.ready', {
    url: started.url, auth: 'service-identity', service: key.service, kid: key.kid, version,
    ...(origin ? { publicOrigin: origin } : {}),
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)),
  });
  const stop = () => {
    void started.close().then(() => { wiring.close(); client.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // PM2 在 Windows 上、以及父进程经 IPC 管它时,用一条消息让它收尾
  process.on('message', (m) => { if (m === 'shutdown' || m?.type === 'shutdown') stop(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`);
    process.exit(1);
  });
}
