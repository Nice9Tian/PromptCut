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
 * 组装经 `docservice/shared-service.mjs`(`mode: 'lan'`,局域网主机;契约 `docs/plan/auth-contract.md`):
 * 渲染任务队列、项目版本、内容库按空间各起一份,另挂服务地址登记与共享项目模块。
 * 本机(`local`)空间的日志落在 `<root>/out/docservice`,共享项目的空间在 `<root>/out/docservice/tenants/<projectId>/`,
 * 凭证存储在 `<root>/out/docservice/auth/`(`vite.config.ts` 的 `fsDeny` 挡住了整个目录,不经静态服务暴露)。
 * 凭证存储按目录取进程内单例(`auth/store.mjs` 的 `credentialStoreFor`),素材服务(`vite-plugin-media.ts`)
 * 用同一份核对票据的代数与签名密钥。
 *
 * 共享端点:`/docservice/shared/{create,lookup,challenge}`(HTTP,跨源 `*`),只有本机回环能建项目。
 *
 * 鉴权(按 `http-guard.mjs` 的 `clientAddressOf` 判真实对端,舞台端口的反向代理转来的也按它写进的真实对端算):
 * - 本机回环来的连接什么都不带:本机身份 `{ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }`;
 *   带 `promptcut.tenant.<projectId>` 的是本机声明(创建者自己的页面、预渲染进程加入本机托管的共享项目);
 * - 局域网来的连接只能凭证明或连接票据进入;
 * - 集群令牌在挂载模式下一律不认(局域网主机的管理接口只绑回环、不要令牌,契约第 10 节)。
 * 凭证存储加载不了时只打 `config.error { reason: 'auth-store' }`:本机身份照常,局域网来的一律 401;
 * 以局域网主机身份运行(`PROMPTCUT_LAN_HOST=1`)时则拒绝启动(SP 契约第 5 节)。
 *
 * **局域网主机**(契约 `docs/plan/shared-project-contract.md` 第 4、5 节):`PROMPTCUT_LAN_HOST=1` 时 `vite.config.ts` 让编辑器绑
 * `0.0.0.0`,文档服务与素材服务挂在同一个 http 服务器上,随之对局域网可达。编辑器绑了非回环地址、且有共享项目时,
 * 按 `lan/discovery.mjs` 在本网段广播与应答(`createLanHosting`);项目删光或编辑器退出时停。管理接口只认回环(上面第三条)。
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
const SHARED_PREFIX = `${WS_PATH}/shared/`;

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

/** 编辑器以局域网主机身份运行(`PROMPTCUT_LAN_HOST=1`,`vite.config.ts` 据此绑 `0.0.0.0`) */
export const lanHostRequested = () => process.env.PROMPTCUT_LAN_HOST === "1";

/** 监听地址是不是只在回环上(`127.x`、`::1`、`localhost`);`0.0.0.0`、`::`、局域网地址都不是 */
export function isLoopbackListen(address: string | null | undefined): boolean {
  const a = String(address ?? "").toLowerCase();
  return a === "localhost" || isLoopbackAddress(a);
}

type LanStore = { list(): Array<{ projectId: string; name: string; mode: string }> };
type LanHost = { start(): Promise<void>; stop(): Promise<void>; refresh(): Promise<void>; running(): boolean };

/**
 * 局域网发现的主机端(契约 `docs/plan/shared-project-contract.md` 第 4 节,`lan/discovery.mjs`):
 * - 编辑器绑了非回环地址(`PROMPTCUT_LAN_HOST=1`,或 `npm run dev` 的 `--host 0.0.0.0`)、且凭证存储里有共享项目时,
 *   开始广播与应答;挂载模式的凭证存储里只有局域网模式的项目(托管模式的项目在托管端);
 * - 项目建成(`shared/create`)、删掉(创建者操作 `delete`)时重新核对:还有项目就立即通告一次,一个都不剩就停;
 * - 编辑器只绑回环时不广播:通告出去的地址别人连不上;
 * - 编辑器退出(http 服务器关闭)时停。
 * UDP 端口打不开等错误只打日志(`[docservice] lan.error`),不影响编辑器。
 *
 * `createHost` 只给测试注入(缺省 `lan/discovery.mjs` 的 `createLanHost`)。
 */
type HttpServerLike = Pick<import("node:http").Server, "address" | "once" | "listening">;
type LanHostOptions = { projects: () => Array<{ projectId: string; name: string; mode: string }>; hostDeviceName: string; servicePort: number; log: Log };
export function createLanHosting(
  httpServer: HttpServerLike,
  { createHost, log: say = log }: { createHost?: (options: LanHostOptions) => LanHost | Promise<LanHost>; log?: Log } = {},
) {
  let store: LanStore | null = null;
  let hostDeviceName = "";
  let servicePort: number | null = null;
  let host: LanHost | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();

  const listProjects = () => {
    try {
      return store?.list() ?? [];
    } catch {
      return [];
    }
  };

  const step = async () => {
    if (closed || !store || servicePort === null) return;
    const want = listProjects().length > 0;
    if (want && !host) {
      const make = createHost ?? (async (o: LanHostOptions) => (await import("./lan/discovery.mjs")).createLanHost(o) as LanHost);
      try {
        host = await make({ projects: listProjects, hostDeviceName, servicePort, log: say });
        await host.start();
      } catch (err) {
        say("lan.error", { stage: "start", message: errText(err) });
        host = null;
      }
    } else if (!want && host) {
      const h = host;
      host = null;
      await h.stop();
    } else if (host) {
      await host.refresh();
    }
  };

  const sync = () => {
    chain = chain.then(step).catch((err) => say("lan.error", { stage: "sync", message: errText(err) }));
    return chain;
  };

  const onListening = () => {
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") return;
    if (isLoopbackListen(addr.address)) {
      say("lan.skip", { reason: "loopback-only", address: addr.address });
      return;
    }
    servicePort = addr.port;
    sync();
  };
  if (httpServer.listening) queueMicrotask(onListening);
  else httpServer.once("listening", onListening);
  httpServer.once("close", () => {
    closed = true;
    chain = chain.then(async () => {
      const h = host;
      host = null;
      await h?.stop();
    }).catch(() => {});
  });

  return {
    /** 凭证存储与本机设备名就绪;若 http 服务器已经在听,立即核对一次 */
    attach(options: { store: LanStore | null; hostDeviceName: string }) {
      store = options.store;
      hostDeviceName = options.hostDeviceName;
      sync();
    },
    sync,
  };
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
      let handleShared: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
      let storeMissing = false;
      // 局域网发现的主机端(契约 `docs/plan/shared-project-contract.md` 第 4 节):项目建成、删掉时由共享端点回调
      const lan = createLanHosting(httpServer);
      try {
        const [{ createSharedDocService }, { credentialStoreFor }, { localDeviceInfo }] = await Promise.all([
          import("./docservice/shared-service.mjs"),
          import("./auth/store.mjs"),
          import("./auth/device.mjs"),
        ]);
        const dataDir = path.join(server.config.root, "out", "docservice");
        // 凭证存储:进程内单例,素材服务按同一个目录取到同一份
        let store: object | null = null;
        try {
          store = credentialStoreFor(path.join(dataDir, "auth"), { log });
        } catch (err) {
          storeMissing = true;
          log("config.error", { reason: "auth-store", message: errText(err) });
        }
        const isLoopback = (req: IncomingMessage) => {
          const address = clientAddressOf(req);
          return address !== null && isLoopbackAddress(address);
        };
        const built = createSharedDocService({
          mode: "lan",
          dataDir,
          store,
          server: httpServer,
          path: WS_PATH,
          isLoopback,
          remoteOf: (req: IncomingMessage) => clientAddressOf(req),
          localDevice: localDeviceInfo(),
          log,
          onCreate: () => lan.sync(),
          onDelete: () => lan.sync(),
        });
        lan.attach({ store: store as LanStore | null, hostDeviceName: localDeviceInfo().deviceName });
        service = built.service;
        handleShared = built.handleHttp;
        log("docservice.attach", { path: WS_PATH, modules: built.service.health().modules, authStore: store ? "ok" : "unavailable" });
      } catch (err) {
        log("docservice.error", { stage: "attach", message: errText(err) });
        return;
      }

      // 局域网主机(PROMPTCUT_LAN_HOST=1)绑非回环而凭证存储没加载:拒绝启动(SP 契约第 5 节、M6a 失败即关)
      if (lanHostRequested() && storeMissing) {
        log("config.error", { reason: "auth-store", lanHost: true });
        throw new Error("局域网主机(PROMPTCUT_LAN_HOST=1)要求凭证存储可用:<root>/out/docservice/auth 读不了,拒绝启动");
      }

      // 共享端点的预检要抢在 vite 自带的 cors 中间件前面答(它不认局域网的源,理由同 asset-service.ts 的 assetPreflightMiddleware)
      server.middlewares.stack.unshift({
        route: "",
        handle: ((req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (String(req.method || "").toUpperCase() !== "OPTIONS" || !pathnameOf(req)?.startsWith(SHARED_PREFIX)) return next();
          if (!handleShared!(req, res)) next();
        }) as any,
      });
      server.middlewares.use((req, res, next) => {
        if (!pathnameOf(req)?.startsWith(SHARED_PREFIX)) return next();
        if (!handleShared!(req, res)) next();
      });

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
