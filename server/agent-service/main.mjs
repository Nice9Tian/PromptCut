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
 *   PROMPTCUT_AGENT_DATA      数据目录,必须已存在且可写
 *   PROMPTCUT_AGENT_DOC_URL   文档服务地址(同机回环)
 *   PROMPTCUT_AGENT_HOST      缺省 127.0.0.1;只许回环(对外只经反向代理)
 *   PROMPTCUT_AGENT_PORT      缺省 8790
 *
 * 失败即关(打一行 `config.error { reason }`,退出码 1):`data-dir`、`doc-url`、`bind-public`、`listen`。
 *
 * 鉴权:成员的委托票据与托管方的服务身份由后面的块接上(契约第 4 节)。接上之前命令行入口没有 `credentials`,
 * 除 `/healthz` 外一律 401 —— 进程起得来、不接任何对话。测试经 `startAgentService({ authenticate, credentials })` 给替身。
 * 本文件不引用 `src/`。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { createAgentHttp } from './http.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export class AgentConfigError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.reason = reason;
  }
}

const isLoopbackHost = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);

/** 缺省的模型配置:数据目录或 PROMPTCUT_AI_CONFIG 指的那份 ai.json(Key 在同目录 keys/ 下,现有封装) */
async function defaultModelConfig() {
  const mod = await import(new URL('../ai-config.mjs', import.meta.url).href);
  return mod.readConfig()?.api ?? {};
}

/**
 * 起服务。回 `{ url, port, service, close }`。
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} o.docUrl
 * @param {string} [o.host]
 * @param {number} [o.port] 0 = 随机(测试)
 * @param {(req) => object | null} [o.authenticate] 请求 → 身份;不给时一律 401
 * @param {{ protocolsFor(identity, n): string[] | Promise<string[]> }} [o.credentials] 连文档服务的凭证;不给时任何对话都起不来
 * @param {() => object | Promise<object>} [o.modelConfig]
 */
export async function startAgentService({
  dataDir,
  docUrl,
  host = '127.0.0.1',
  port = 8790,
  authenticate = null,
  credentials = null,
  modelConfig = defaultModelConfig,
  gate,
  limits,
  root = ROOT,
  version = 'dev',
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
    modelConfig,
    dataDir,
    ...(gate ? { gate } : {}),
    ...(limits ? { limits } : {}),
    log,
  });
  const api = createAgentHttp({ service, authenticate, version, log });
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

async function main() {
  const fail = (reason, extra = {}) => {
    const text = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason, ...extra })}\n`;
    process.stdout.write(text);
    process.stderr.write(text);
    process.exitCode = 1;
  };
  const port = process.env.PROMPTCUT_AGENT_PORT === undefined ? 8790 : Number(process.env.PROMPTCUT_AGENT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) return fail('listen', { detail: 'PROMPTCUT_AGENT_PORT 不是端口号' });
  let started;
  try {
    started = await startAgentService({
      dataDir: process.env.PROMPTCUT_AGENT_DATA,
      docUrl: process.env.PROMPTCUT_AGENT_DOC_URL,
      host: process.env.PROMPTCUT_AGENT_HOST || '127.0.0.1',
      port,
      log: line,
    });
  } catch (err) {
    if (err instanceof AgentConfigError) return fail(err.reason, { detail: err.message });
    throw err;
  }
  line('agent.ready', { url: started.url, auth: 'unconfigured' });
  const stop = () => { void started.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`);
    process.exit(1);
  });
}
