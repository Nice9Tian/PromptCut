import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { apiPath, clientAddressOf, isLoopbackAddress } from "./http-guard.mjs";

/**
 * 本地文档服务(契约 `docs/plan/docservice-contract.md` 第 5 节)。
 *
 * 同一份文档服务代码(`server/docservice/`)以**挂载模式**挂进 vite 的 http 服务器:
 * - WebSocket:`ws://<编辑器地址>/docservice`(子协议 `promptcut.v1`)。只接这一条路径的升级,
 *   vite 的 HMR 也走 `upgrade`,文档服务一概不碰别的路径;
 * - `GET /api/docservice/healthz`:与远程文档服务的 `/healthz` 相同的对象。受 `/api/**` 的同源守卫管
 *   (`vite-plugin-api-guard.ts`),只给本机和同源用。
 *
 * 挂四个模块:渲染任务队列、服务地址登记、项目版本、内容库。后两个的日志落在 `<root>/out/docservice`。
 *
 * 鉴权:本机回环来的连接(按 `http-guard.mjs` 的 `clientAddressOf` 判真实对端,舞台端口的反向代理转来的
 * 也按它写进的真实对端算)是 `{ userId: 'local', tenantId: 'local' }`;别的一律要集群令牌
 * (`PROMPTCUT_CLUSTER_TOKEN`),没配令牌就全部拒绝。
 *
 * 文档服务只在编辑器进程里一份,预渲染进程(`vite.prerender.config.ts`)不挂。
 * 任何一步出错都只打日志,不影响编辑器启动。
 */

const WS_PATH = "/docservice";
const HEALTH_PATH = "/api/docservice/healthz";
const LOCAL = Object.freeze({ userId: "local", tenantId: "local" });

type Principal = { userId: string; tenantId: string | null };
type Log = (event: string, fields: object) => void;

/** 连接开合、握手被拒这些事件照常打;别的也打,都带 `[docservice]` 前缀,一行一条 */
const log: Log = (event, fields) => {
  try {
    console.info("[docservice]", event, JSON.stringify(fields));
  } catch {
    console.info("[docservice]", event);
  }
};

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function docservicePlugin(): Plugin {
  return {
    name: "promptcut-docservice",
    apply: "serve",
    async configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) {
        log("docservice.skip", { reason: "no-http-server" });
        return;
      }
      let service: { health(): object; close(): Promise<void> } | null = null;
      try {
        const [{ createDocService }, { createClusterAuth }, { endpointsModule }, { projectModule }, { contentModule }, { createFileStore }, { createRenderQueue }] =
          await Promise.all([
            import("./docservice/service.mjs"),
            import("./docservice/auth.mjs"),
            import("./docservice/modules/endpoints.mjs"),
            import("./docservice/modules/project.mjs"),
            import("./docservice/modules/content.mjs"),
            import("./docservice/store/index.mjs"),
            import("./render-queue/index.mjs"),
          ]);

        // 非本机连接的鉴权:只认集群令牌。没配令牌、或令牌格式不对,就一律拒绝(失败即关)
        const token = process.env.PROMPTCUT_CLUSTER_TOKEN;
        let remoteAuth: (req: IncomingMessage) => Principal | null = () => null;
        if (token) {
          try {
            remoteAuth = createClusterAuth({ token, allowAnonymous: false, log }).authenticate;
          } catch (err) {
            log("config.error", { reason: "bad-token-format", message: errText(err) });
          }
        }
        const authenticate = (req: IncomingMessage): Principal | null => {
          const address = clientAddressOf(req);
          if (address !== null && isLoopbackAddress(address)) return { ...LOCAL };
          return remoteAuth(req);
        };

        const svc = createDocService({ server: httpServer, path: WS_PATH, authenticate, log });
        const queue = createRenderQueue({ now: Date.now, send: svc.send });
        svc.mountRenderQueue(queue);
        svc.mount(endpointsModule());
        const store = createFileStore({ dir: path.join(server.config.root, "out", "docservice"), log });
        svc.mount(projectModule({ store }));
        svc.mount(contentModule({ store }));
        service = svc;
        log("docservice.attach", { path: WS_PATH, modules: svc.health().modules });
      } catch (err) {
        log("docservice.error", { stage: "attach", message: errText(err) });
        return;
      }

      server.middlewares.use((req, res, next) => {
        if (apiPath(req.url) !== HEALTH_PATH) return next();
        const method = String(req.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end();
          return;
        }
        let body: string;
        try {
          body = JSON.stringify(service!.health());
        } catch (err) {
          log("docservice.error", { stage: "health", message: errText(err) });
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: "internal" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(method === "HEAD" ? undefined : body);
      });

      httpServer.once("close", () => {
        service?.close().catch((err: unknown) => log("docservice.error", { stage: "close", message: errText(err) }));
      });
    },
  };
}

export default docservicePlugin;
