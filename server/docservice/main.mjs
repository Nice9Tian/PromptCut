/**
 * 独立运行的文档服务骨架。可以跑在本机、局域网里的另一台机器或公网云端，协议相同
 * （`docs/semantics/architecture/document-service.md`「部署组合」）。
 *
 * 跑：node server/docservice/main.mjs
 * 环境变量：PROMPTCUT_DOCSERVICE_PORT（缺省 8787）、PROMPTCUT_DOCSERVICE_HOST（缺省 0.0.0.0）。
 * 渲染任务队列用仓库里的 createRenderQueue，经 mountRenderQueue 挂上。
 * 只依赖 Node 内置模块和 `server/render-queue/`，部署时拷这两个目录即可（`scripts/remote/docservice.mjs deploy`）。
 */
import { createDocService } from './service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';

const port = Number(process.env.PROMPTCUT_DOCSERVICE_PORT ?? 8787);
const host = process.env.PROMPTCUT_DOCSERVICE_HOST ?? '0.0.0.0';

const service = createDocService();
const queue = createRenderQueue({ now: Date.now, send: service.send });
service.mountRenderQueue(queue);

const addr = await service.listen(port, host);
process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event: 'listen', host: addr.address, port: addr.port, node: process.version })}\n`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    service.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
