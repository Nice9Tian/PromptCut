/**
 * 独立运行的文档服务。可以跑在本机、局域网里的另一台机器或公网云端，协议相同
 * （`docs/semantics/architecture/document-service.md`「部署组合」）。
 *
 * 跑：node server/docservice/main.mjs
 * 环境变量：
 *   PROMPTCUT_DOCSERVICE_PORT   缺省 8787
 *   PROMPTCUT_DOCSERVICE_HOST   缺省 0.0.0.0
 *   PROMPTCUT_CLUSTER_TOKEN     集群令牌（契约 `docs/plan/render-queue-contract.md` G.5）
 *
 * 失败即关：
 *   - 设了令牌但格式不对（要 32～256 个 base64url 字符）→ 打 `config.error { reason: 'bad-token-format' }`，退出码 1；
 *   - 没设令牌而绑的不是回环地址（127.0.0.1、::1、localhost）→ 打 `config.error { reason: 'token-required' }`，退出码 1；
 *   - 没设令牌、只绑回环 → 匿名模式（本机开发、旧客户端）；
 *   - 设了令牌 → 令牌模式，绑哪里都一样。
 *
 * 生成令牌（32 字节随机数的 base64url，43 个字符）：
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
 * 令牌只放在环境变量里，不写进仓库、不上命令行；日志里只记拒绝原因，不记令牌。
 *
 * 挂两个模块：渲染任务队列（仓库里的 createRenderQueue，经 mountRenderQueue 挂上）、服务地址登记。
 * 只依赖 Node 内置模块、`server/docservice/`（含 `modules/`）和 `server/render-queue/`，
 * 部署时拷这两个目录即可（`scripts/remote/docservice.mjs deploy`）。
 */
import { createDocService } from './service.mjs';
import { createClusterAuth, checkTokenFormat, isLoopbackHost } from './auth.mjs';
import { endpointsModule } from './modules/endpoints.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';

function log(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/** 配置错误：同一行写到 stdout 与 stderr，然后以退出码 1 结束 */
function configError(reason) {
  const line = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason })}\n`;
  process.stdout.write(line);
  process.stderr.write(line);
  process.exitCode = 1;
}

async function main() {
  const port = Number(process.env.PROMPTCUT_DOCSERVICE_PORT ?? 8787);
  const host = process.env.PROMPTCUT_DOCSERVICE_HOST ?? '0.0.0.0';
  const token = process.env.PROMPTCUT_CLUSTER_TOKEN;

  if (token !== undefined && !checkTokenFormat(token)) return configError('bad-token-format');
  if (token === undefined && !isLoopbackHost(host)) return configError('token-required');

  const auth = createClusterAuth({ token, allowAnonymous: token === undefined, log });
  const service = createDocService({ authenticate: auth.authenticate, log });
  const queue = createRenderQueue({ now: Date.now, send: service.send });
  service.mountRenderQueue(queue);
  service.mount(endpointsModule());

  const addr = await service.listen(port, host);
  log('listen', { host: addr.address, port: addr.port, node: process.version, auth: token === undefined ? 'anonymous' : 'token' });

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      service.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

await main();
