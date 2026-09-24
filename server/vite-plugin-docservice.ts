import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import { apiPath, clientAddressOf, isLoopbackAddress } from "./http-guard.mjs";
import { rejectUpgrade } from "./docservice/ws.mjs";

/**
 * 本地文档服务(契约 `docs/plan/docservice-contract.md` 第 5 节、第 10 节)。
 *
 * 同一份文档服务代码(`server/docservice/`)以**挂载模式**挂进 vite 的 http 服务器:
 * - WebSocket:`ws://<编辑器地址>/docservice`(子协议 `promptcut.v1`)。只接这一条路径的升级,
 *   vite 的 HMR 也走 `upgrade`,文档服务一概不碰别的路径;
 * - `GET /api/docservice/healthz`:与远程文档服务的 `/healthz` 相同的对象。受 `/api/**` 的同源守卫管
 *   (`vite-plugin-api-guard.ts`),只给本机和同源用。
 *
 * 挂四个模块:渲染任务队列、服务地址登记、项目版本、内容库。后两个的日志落在 `<root>/out/docservice`
 * (`vite.config.ts` 的 `fsDeny` 挡住了它,不经静态服务暴露)。
 *
 * 鉴权:本机回环来的连接(按 `http-guard.mjs` 的 `clientAddressOf` 判真实对端,舞台端口的反向代理转来的
 * 也按它写进的真实对端算)是 `{ userId: 'local', tenantId: 'local' }`;别的一律要集群令牌
 * (`PROMPTCUT_CLUSTER_TOKEN`),没配令牌就全部拒绝。
 *
 * **停用模式**(`PROMPTCUT_HEADLESS === "1"`,`scripts/headless.mjs` 起的无头实例):无头实例是 Skill 的临时副本,
 * 不能自己发 `projectRev`,所以不建文档服务、不写日志;但插件照样注册,把两条路由明确答掉,
 * 免得页面的握手挂着没人回:`/docservice` 的升级回 `503` 并关掉 socket,`/api/docservice/healthz` 回
 * `503 { ok: false, disabled: true, reason: 'headless' }`。
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

const pathnameOf = (req: IncomingMessage): string | null => {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
};

function sendJson(res: ServerResponse, status: number, body: object, head: boolean) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(head ? undefined : JSON.stringify(body));
}

/**
 * 给 http 服务器上**每一个**升级请求的 socket 挂一个空的 `error` 监听(契约第 10 节第 14 条)。
 *
 * Node 把 `upgrade` 交给监听者之后就不再兜底 socket 的错误。vite 的 HMR 监听遇到不是自己的路径直接 return,
 * 既不回包也不挂 `error` 监听;这样的握手挂着时对端一重置(`ECONNRESET`),就是未处理的 `error` 事件,
 * 整个 dev server 退出(实测:正常模式任意非 HMR 路径、无头实例的 `/docservice` 都能打崩)。
 *
 * 这个监听只挂错误监听:不回包、不关 socket、不读数据,所以不影响 HMR 和别的处理器,
 * 挂在 vite 的 HMR 监听之前或之后都一样安全——`error` 只会在 `upgrade` 事件同步分发完之后才发生,
 * 那时所有监听者都已经跑过。这里用 `prependListener` 放到最前,只是为了让它先于任何可能同步抛错的处理器挂上。
 * 同一个 socket 只挂一次(WeakSet 去重)。
 */
function guardUpgradeSockets(httpServer: NonNullable<import("vite").ViteDevServer["httpServer"]>) {
  const guarded = new WeakSet<Duplex>();
  const onUpgrade = (_req: IncomingMessage, socket: Duplex) => {
    if (guarded.has(socket)) return;
    guarded.add(socket);
    socket.on("error", () => {});
  };
  httpServer.prependListener("upgrade", onUpgrade);
  httpServer.once("close", () => httpServer.off("upgrade", onUpgrade));
}

/** 停用模式:不建文档服务,两条路由明确回 503 */
function attachDisabled(server: import("vite").ViteDevServer, httpServer: NonNullable<import("vite").ViteDevServer["httpServer"]>) {
  const onUpgrade = (req: IncomingMessage, socket: Duplex) => {
    if (pathnameOf(req) !== WS_PATH) return;
    socket.on("error", () => {});
    rejectUpgrade(socket, 503, "Service Unavailable");
  };
  httpServer.on("upgrade", onUpgrade);
  httpServer.once("close", () => httpServer.off("upgrade", onUpgrade));
  server.middlewares.use((req, res, next) => {
    if (apiPath(req.url) !== HEALTH_PATH) return next();
    const method = String(req.method || "GET").toUpperCase();
    sendJson(res, 503, { ok: false, disabled: true, reason: "headless" }, method === "HEAD");
  });
  log("docservice.disabled", { reason: "headless", path: WS_PATH });
}

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
      // 两种模式都挂:防止没人接的升级被对端重置时把 dev server 带崩
      guardUpgradeSockets(httpServer);

      if (process.env.PROMPTCUT_HEADLESS === "1") {
        attachDisabled(server, httpServer);
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
        // (没配令牌时 createClusterAuth 在拒绝时记 `auth.reject { reason: 'no-token' }`,令牌原文不进日志)
        const token = process.env.PROMPTCUT_CLUSTER_TOKEN || undefined;
        let remoteAuth: (req: IncomingMessage) => Principal | null;
        try {
          remoteAuth = createClusterAuth({ token, allowAnonymous: false, log }).authenticate;
        } catch (err) {
          log("config.error", { reason: "bad-token-format", message: errText(err) });
          remoteAuth = createClusterAuth({ allowAnonymous: false, log }).authenticate;
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
        let body: object;
        try {
          body = service!.health();
        } catch (err) {
          log("docservice.error", { stage: "health", message: errText(err) });
          return sendJson(res, 500, { ok: false, error: "internal" }, method === "HEAD");
        }
        sendJson(res, 200, body, method === "HEAD");
      });

      httpServer.once("close", () => {
        service?.close().catch((err: unknown) => log("docservice.error", { stage: "close", message: errText(err) }));
      });
    },
  };
}

export default docservicePlugin;
