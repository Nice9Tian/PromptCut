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
 *   PROMPTCUT_ACCOUNT_V2 / PROMPTCUT_ACCOUNT_V2_REQUIRED
 *                                  账号版使用 1；required=1 时缺账号配置启动失败，绝不退回旧服务身份/用户名路径
 *   PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN / PROMPTCUT_AGENT_DOC_FINGERPRINT256
 *                                  账号版 doc 独立内部 mTLS HTTPS 源与 pinned 服务端证书
 *   PROMPTCUT_AGENT_CLIENT_KEY_FILE / PROMPTCUT_AGENT_CLIENT_CERT_FILE / PROMPTCUT_AGENT_CA_FILE
 *                                  Agent 独占 mTLS 私钥、证书、私有 CA 文件；只读，值不进日志
 *   PROMPTCUT_AGENT_CONTROL_PORT    账号执行器独立回环 mTLS 控制口，必须与公开 HTTP 口不同
 *   PROMPTCUT_AGENT_SECRETS        服务身份的私钥目录(缺省 /var/lib/promptcut/agent-secrets),里面是 keygen 生成的 service-key.json(服务名 agent)
 *   PROMPTCUT_AGENT_HOST           缺省 127.0.0.1;只许回环(对外只经反向代理)
 *   PROMPTCUT_AGENT_PORT           缺省 8790
 *   PROMPTCUT_AGENT_PUBLIC_ORIGIN  可不设:对外的源(如 https://149-88-94-84.sslip.io),只做格式检查并记进日志。
 *                                  页面拿到的地址由托管组合的 PROMPTCUT_AGENT_PUBLIC_URL 经文档服务下发,不由本进程给
 *   PROMPTCUT_AGENT_ASSET_URL      同机素材服务的地址(回环,如 http://127.0.0.1:8788)。云端 Agent 导入素材、配音入库时按内容哈希写进它
 *                                  (凭代成员的素材票据,权限不超过成员本人)。不设时这些工具回「没有配置素材服务」
 *   PROMPTCUT_AGENT_LOOK_URL       同机渲染服务管理进程的诊断与代理口(回环,如 http://127.0.0.1:5399)。云端 Agent 看画面(`see_frames` 等)时凭服务私钥的
 *                                  签名向它要一帧(`look-client.mjs`;契约第 9.8 节)。不设时看画面的工具不交给模型,系统提示词写「看不了画面」
 *   PROMPTCUT_AGENT_COLLECT_PYTHON  装了 yt-dlp 的 Python 解释器(绝对路径)。配了网页采集才可用;采集的子进程只经出网闸的代理出网。
 *                                  没配时采集的工具回「这台云节点没有装采集工具」(模型不能触发往节点上装东西)
 *   PROMPTCUT_AGENT_COLLECT_TEST_ARGS 只给探针:把 `-m promptcut_collect` 换成一个替身脚本。生产不设;设了日志里有 `agent.collect.test-runner`,
 *                                  `/healthz` 的 `collectTestRunner` 为 true
 *   PROMPTCUT_AGENT_EGRESS_TEST_ALLOW
 *                                  **只给探针与演练**:逗号分隔的「IP:端口」,出网闸对它们放行(用来在本机回环上起「测试专用外部地址」)。
 *                                  生产不设;设了会在日志里打 `agent.egress.test-allow`,`/healthz` 的 `egressTestAllow` 为 true
 *   PROMPTCUT_AGENT_REHEARSAL_DESKTOP_MODEL
 *                                  **只给本机演练**:设成 1 时模型配置改读这台电脑上桌面版已配好的 API 直连配置(只读,见 `rehearsal-model.mjs`),
 *                                  用来在本机跑真实模型。云节点上不设(节点的 Key 走加密分发)
 *   PROMPTCUT_AGENT_RENDER_STALL_MS / PROMPTCUT_AGENT_RENDER_DEBOUNCE_MS
 *                                  可不设:补渲「连续多久没有进度就放弃」(缺省 10 分钟)与「写入落地后攒多久再发」(缺省 3 秒),排查与演练用
 *
 * 失败即关(打一行 `config.error { reason }`,退出码 1):`data-dir`、`doc-url`、`asset-url`、`service-identity`(私钥读不到、格式不对、
 * 服务名不是 agent)、`look-url`(不是回环上的 http 地址)、`public-origin`、`bind-public`、`listen`。文档服务一时连不上不算:控制连接自己退避重连,期间新请求回 503 `unavailable`。
 *
 * 数据目录里(契约第 2.2 节):`config/ai.json` 与 `config/keys/custom.key`(模型配置与 Key 的密文,`set-key.mjs` 写)、
 * `config/voice.json` 与 `config/keys/voice.key`(托管方的配音配置与令牌的密文,可没有)、`work/`(各对话的工作目录:附件、下载的文件)、
 * `config/limits.json`(各项目额度与节点并发,`admin.mjs quota` 写,改了即生效)、`tenants/`(对话)、`usage/`(用量流水)。
 * 进程起来时把上一个进程没收尾的对话标成「中断」(不自动续跑),并按各对话的 `pending-render.json` 重发补渲。
 * 收到 SIGTERM / SIGINT:旧 LAN 模式记「中断」并停下,状态落盘,5 秒内退出。
 * 账号模式等待 owned 资源真实关闭;不以 5 秒超时替代关闭证明或成功退出。
 *
 * 账号版以同一个 RAM 注册客户端装配 run/data/read-control 与持久事件；
 * 真实关闭 producer/终态结算尚未接通，完成状态严格 pending，不能宣称整链 ready。
 * 旧模式鉴权(契约第 4 节):命令行入口凭服务私钥连文档服务的控制连接(`server/auth/service-client.mjs`),每个请求的委托票据、
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
import { parseTestAllow } from '../agent/service/egress.mjs';
import { readCollectConfig } from '../agent/service/hosted-collect.mjs';
import { readDesktopModelConfig } from './rehearsal-model.mjs';
import { createLookClient, parseLookUrl } from './look-client.mjs';
import { createConversationClient } from './conversation-client.mjs';
import { createRunClient } from './run-client.mjs';
import { createConversationControlClient } from './conversation-control-client.mjs';
import { createAccountExecutorAssembly } from './account-executor-assembly.mjs';

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
  assetBase = null,
  look = null,
  egress,
  voiceConfig,
  workspaceLimits,
  toolLimits,
  collect = null,
  accountMode = false,
  conversationClient = null,
  accountExecutor = null,
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
  if (accountMode === true && (!/^wss:\/\//.test(docUrl) || typeof conversationClient?.identity !== 'function'))
    throw new AgentConfigError('account-v2', '账号模式需要真实安全文档连接和对话权威');
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

  const serviceOptions = {
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
    ...(assetBase ? { assetBase } : {}),
    ...(look ? { look } : {}),
    ...(egress ? { egress } : {}),
    ...(voiceConfig ? { voiceConfig } : {}),
    ...(workspaceLimits ? { workspaceLimits } : {}),
    ...(toolLimits ? { toolLimits } : {}),
    ...(collect ? { collect } : {}),
    ...(accountMode ? { accountMode: true, conversationClient } : {}),
    log,
  };
  let executor = null, service;
  try {
    if (accountMode && accountExecutor) {
      // CLI supplies its one already-created RAM runClient and read-control
      // client. No secondary tool/model process registers a different instance.
      executor = await createAccountExecutorAssembly({ ...serviceOptions, ...accountExecutor,
        dataDir, conversationClient, root, loadModule: serviceOptions.loadModule,
        modelConfig: serviceOptions.modelConfig, log });
      service = executor.service;
    } else service = createHostedAgentService(serviceOptions);
  } catch (error) { await vite.close(); throw error; }
  const api = createAgentHttp({ service, authenticate, version, codeVersion, log });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (err) {
    try { if (executor) await executor.close(); else await service.close(); }
    finally { await vite.close(); }
    throw new AgentConfigError('listen', `监听失败:${err?.message ?? err}`);
  }
  const actual = server.address().port;
  log('agent.listen', { host, port: actual });

  let closing = null;
  return {
    port: actual,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${actual}`,
    service,
    executor,
    close() {
      closing ??= (async () => {
        if (executor) {
          // Close actual public HTTP/SSE owners before waiting on read-control
          // receipts. HTTP finish alone cannot stand in for socket close.
          server.closeAllConnections?.();
          await new Promise(resolve => server.close(resolve));
          try { await executor.close(); } finally { await vite.close(); }
        } else {
          await service.close();
          server.closeAllConnections?.();
          await new Promise(resolve => server.close(resolve));
          await vite.close();
        }
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
  const assetBase = env.PROMPTCUT_AGENT_ASSET_URL || '';
  if (assetBase) {
    let ok = false;
    try { const u = new URL(assetBase); ok = (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname.replace(/^\[|\]$/g, '')); } catch { ok = false; }
    if (!ok) return fail('asset-url', { detail: 'PROMPTCUT_AGENT_ASSET_URL 要是同机素材服务的回环地址,如 http://127.0.0.1:8788' });
  }
  const lookUrl = env.PROMPTCUT_AGENT_LOOK_URL ? parseLookUrl(env.PROMPTCUT_AGENT_LOOK_URL) : null;
  if (env.PROMPTCUT_AGENT_LOOK_URL && !lookUrl) return fail('look-url', { detail: 'PROMPTCUT_AGENT_LOOK_URL 要是同机渲染服务的回环地址,如 http://127.0.0.1:5399' });
  const testAllow = parseTestAllow(env.PROMPTCUT_AGENT_EGRESS_TEST_ALLOW);
  // 网页采集:节点上装没装由部署决定;没配这个变量时采集的工具回「这台云节点没有装采集工具」
  const collect = readCollectConfig(env, { root: ROOT });
  if (collect?.error) return fail('collect', { detail: collect.error });
  if (collect?.testRunner) line('agent.collect.test-runner', {});
  // 只给本机演练:用这台电脑上桌面版已配好的 API 直连(只读;日志里只有厂商与模型名)
  const rehearsal = env.PROMPTCUT_AGENT_REHEARSAL_DESKTOP_MODEL === '1';
  if (rehearsal) {
    const c = readDesktopModelConfig();
    line('agent.rehearsal.desktop-model', { found: !!c.apiKey, vendor: c.vendor ?? null, model: c.model ?? null });
  }
  let version = 'dev';
  try { version = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? 'dev'); } catch { /* 读不到就算了 */ }
  if (env.PROMPTCUT_ACCOUNT_V2_REQUIRED !== undefined && !['0', '1'].includes(env.PROMPTCUT_ACCOUNT_V2_REQUIRED)) return fail('account-v2-required');
  if (env.PROMPTCUT_ACCOUNT_V2 !== undefined && !['0', '1'].includes(env.PROMPTCUT_ACCOUNT_V2)) return fail('account-v2');
  const accountMode = env.PROMPTCUT_ACCOUNT_V2 === '1';
  if (env.PROMPTCUT_ACCOUNT_V2_REQUIRED === '1' && !accountMode) return fail('account-v2-required');
  if (accountMode && !/^wss:\/\//.test(docUrl)) return fail('account-v2', { detail: 'doc-url-must-be-wss' });
  let key = null, client = null, conversationClient = null, runClient = null, conversationControl = null, wiring, accountExecutor = null;
  if (accountMode) {
    try {
      const file = name => {
        const filename = env[name];
        if (!filename || !path.isAbsolute(filename)) throw new Error('account-v2-file');
        return fs.readFileSync(filename);
      };
      const options = { origin: env.PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN,
        serverFingerprint256: env.PROMPTCUT_AGENT_DOC_FINGERPRINT256,
        tls: { key: file('PROMPTCUT_AGENT_CLIENT_KEY_FILE'), cert: file('PROMPTCUT_AGENT_CLIENT_CERT_FILE'),
          ca: file('PROMPTCUT_AGENT_CA_FILE') } };
      conversationClient = createConversationClient(options);
      runClient = createRunClient(options);
      conversationControl = createConversationControlClient({ ...options, runClient,
        receiptFile: path.join(env.PROMPTCUT_AGENT_DATA, 'conversation-read-closures.sqlite'),
        onDiagnostic: event => line('agent.read-control', event) });
      // Assembly owns this client once started; outer boot/stop cleanup may
      // still run after assembly startup rejected. Share that one real close,
      // including its rejection, rather than closing the receipt DB twice.
      const closeReadControl = conversationControl.close.bind(conversationControl);
      let readClosing = null;
      conversationControl.close = () => readClosing ??= Promise.resolve().then(closeReadControl);
      conversationClient.useReadControl(conversationControl);
      const controlPort = Number(env.PROMPTCUT_AGENT_CONTROL_PORT);
      if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535 || controlPort === port)
        throw new AgentConfigError('account-executor', 'separate-control-port-required');
      accountExecutor = { doc: options, runClient, readControl: conversationControl, controlPort };
      wiring = createHostedWiring({ accountMode: true, conversationClient, log: line });
    } catch {
      await conversationControl?.close(); conversationClient?.close(); runClient?.close(); return fail('account-v2');
    }
  } else {
    try {
      key = readServiceKeyFile(env.PROMPTCUT_AGENT_SECRETS || '/var/lib/promptcut/agent-secrets');
      if (key.service !== 'agent') throw new Error('wrong-service-identity');
    } catch (err) { return fail('service-identity', { detail: String(err?.message ?? err).slice(0, 200) }); }
    client = createServiceClient({ base: docUrl, key, log: line });
    // Legacy service control connection remains explicit; account mode never falls through here.
    void client.ready().catch(() => {});
    wiring = createHostedWiring({ client, docUrl, root: ROOT, log: line });
  }
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
      ...(assetBase ? { assetBase } : {}),
      // 看画面:凭这把服务私钥的签名向同机的渲染服务要一帧
      ...(!accountMode && lookUrl ? { look: createLookClient({ url: lookUrl, key, log: line }) } : {}),
      ...(testAllow.length ? { egress: { testAllow } } : {}),
      ...(collect ? { collect } : {}),
      ...(accountMode ? { accountMode: true, conversationClient, accountExecutor } : {}),
      ...(rehearsal ? { modelConfig: () => readDesktopModelConfig() } : {}),
      version,
      codeVersion: () => wiring.publisher?.codeVersion?.() ?? version,
      log: line,
    });
  } catch (err) {
    wiring.close();
    await conversationControl?.close(); client?.close(); runClient?.close();
    if (err instanceof AgentConfigError) return fail(err.reason, { detail: err.message });
    throw err;
  }
  wiring.attach(started.service);
  let registerTimer = null, registerStopped = false;
  const registerInstance = async () => {
    if (registerStopped || !runClient) return;
    try {
      const instance = await runClient.registerInstance();
      await conversationControl?.start();
      line('agent.instance.registered', { instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration });
    } catch (error) {
      if (registerStopped) return;
      line('agent.instance.pending', { code: error?.code ?? 'unavailable' });
      registerTimer = setTimeout(registerInstance, 2_000); registerTimer.unref?.();
    }
  };
  if (runClient && !started.executor) void registerInstance();
  line('agent.ready', {
    url: started.url, auth: accountMode ? 'account-v2-mtls' : 'service-identity',
    service: 'agent', ...(key ? { kid: key.kid } : {}), version, accountMode,
    ...(accountMode ? { runAuthorityMounted: !!started.executor, runDataProofReady: !!started.executor,
      completionReady: false } : {}),
    ...(origin ? { publicOrigin: origin } : {}),
    assetService: !!assetBase, look: !accountMode && !!lookUrl, egressTestAllow: testAllow.length > 0,
    collect: !accountMode && !!collect, collectTestRunner: !accountMode && collect?.testRunner === true,
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024)),
  });
  const stop = () => {
    registerStopped = true; if (registerTimer) clearTimeout(registerTimer);
    if (started.executor) {
      // No five-second successful exit can certify an unobserved old OS tree.
      void started.close().then(() => { wiring.close(); runClient?.close(); conversationClient?.close(); })
        .catch(error => { line('agent.close.pending', { code: error?.code ?? 'closure-pending' }); process.exitCode = 1; });
      return;
    }
    void Promise.resolve(conversationControl?.close()).then(() => started.close()).then(() => { wiring.close(); client?.close(); runClient?.close(); process.exit(0); });
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
