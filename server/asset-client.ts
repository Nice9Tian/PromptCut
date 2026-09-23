/**
 * 素材服务的客户端一侧:Agent 进程和预渲染进程**只经素材服务的 HTTP API** 取素材
 * (`docs/semantics/architecture/asset-storage.md`「职责」第三条),不读本地内容库的目录。
 * 契约在 `asset-service.ts` 文件头。
 *
 * 这个模块**不 import vite-plugin-media / asset-service**:用它的一方只认地址,不认目录。
 *
 * # 素材服务的基址怎么定
 *
 * 按顺序取第一个有的:
 *
 * 1. `PROMPTCUT_EDITOR_URL` —— 预渲染进程由编辑器那一端的 dev server 拉起时给的
 *    (`vite-plugin-prerender.ts`)。本地素材服务第一版就挂在编辑器进程里,所以它就是素材服务的源。
 *    没有新加环境变量:现有这一个够用。
 * 2. 本进程自己的监听地址 —— 媒体插件起来时记下的(`rememberLocalAssetOrigin`)。这是**单进程形态**:
 *    Agent 跑在编辑器进程里(没有单独的预渲染进程,或者就是编辑器进程自己在处理请求),
 *    素材服务就在本进程,照样走回环地址的 HTTP,不直接读目录。
 * 3. 都没有(纯脚本、单测)→ null,调用方如实说「素材服务不可达」。
 *
 * 将来连远程素材服务(F4 切换所连接的服务)时,基址换成远程那一个即可,路径不变。
 */
import type { Plugin } from "vite";
import type { AddressInfo } from "net";
import http from "http";
import https from "https";

const ORIGIN_KEY = Symbol.for("promptcut.asset-service.local-origin");
type Holder = { [ORIGIN_KEY]?: string | null };

/** vite 的 httpServer 可能是 http / https / http2 的 Server,这里只用到它们共有的这几样 */
type Listening = { listening: boolean; address(): AddressInfo | string | null; once(event: "listening", fn: () => void): unknown };

/**
 * 记下本进程素材服务的地址。配置被打包过一次、模块可能有两份实例,所以放在 globalThis 上。
 * 监听在 0.0.0.0 / :: 上时用回环地址访问自己。
 */
export function rememberLocalAssetOrigin(server: Listening | null | undefined): void {
  if (!server) return;
  const record = () => {
    const addr = server.address();
    if (!addr || typeof addr === "string") return;
    let host = addr.address;
    if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
    else if (host.includes(":")) host = `[${host}]`;
    (globalThis as Holder)[ORIGIN_KEY] = `http://${host}:${addr.port}`;
  };
  if (server.listening) record();
  else server.once("listening", record);
}

/** 素材服务的源(不带尾斜杠);取不到返回 null */
export function assetServiceOrigin(): string | null {
  const editor = String(process.env.PROMPTCUT_EDITOR_URL || "").trim().replace(/\/+$/, "");
  if (editor) return editor;
  return (globalThis as Holder)[ORIGIN_KEY] || null;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * 项目里一条素材记录 → 素材服务上取它的 HTTP 地址(给 ffmpeg 当输入,ffmpeg 自己会用 Range 定位)。
 *
 * - 有内容哈希(`m.hash`,或 `url` 是 `/@media/<hash>[.ext]`)→ `/@media/<hash>`;
 * - 迁移期按文件名存的(`/@media/<文件名>`,或只剩一个落在素材目录里的 `path`)→ `/@media/<文件名>`。
 *
 * **只取最后一段文件名**,不接受任何目录:素材服务那一侧只在本地内容库里找,外面递进来的
 * `path` 再怎么写也指不到库外的文件(原来 `mediaFileOf` 的白名单边界,现在由素材服务守)。
 */
export function mediaHttpUrl(m: any, origin: string | null = assetServiceOrigin()): string | null {
  if (!origin) return null;
  const hash = String(m?.hash || "").toLowerCase();
  if (HASH.test(hash)) return `${origin}/@media/${hash}`;
  const raw = String(m?.url || m?.path || "");
  if (!raw || /^(blob|data):/i.test(raw)) return null;
  let base = raw.split("?")[0].split(/[/\\]/).pop() || "";
  // 解码之后再切一次:`a%2F..%2Fx` 按斜杠切不开,解码完才露出斜杠
  try { base = decodeURIComponent(base); } catch { /* 原样 */ }
  base = (base.split(/[/\\]/).pop() || "").replace(/\.\./g, "");
  if (!base) return null;
  return `${origin}/@media/${encodeURIComponent(base)}`;
}

/* ------------------------------------------------------------------ *
 * 预渲染进程:素材路由转发到素材服务
 * ------------------------------------------------------------------ */

/** 这些路径在预渲染进程里原来由它自己挂的 mediaPlugin 直接读目录答;现在一律转发 */
function isMediaRoute(url: string | undefined): boolean {
  const u = String(url || "").toLowerCase();
  return u.startsWith("/@media/") || u.startsWith("/api/asset/") || u.startsWith("/api/media/");
}

/**
 * 预渲染进程的素材路由:原样转发给素材服务(`origin`),本进程不碰本地内容库。
 *
 * 渲染用的 Chrome 从预渲染进程的源加载导出页,页面里的 `/@media/<hash>` 是相对地址,
 * 所以这个源上还得答这些路由 —— 答法换成转发:方法、请求头(含 Range)、请求体、状态码、
 * 响应头(含 Content-Range / Accept-Ranges)全部透传,字节一个不改。
 */
export function assetProxyPlugin(origin: string): Plugin {
  const target = new URL(origin);
  const client = target.protocol === "https:" ? https : http;
  return {
    name: "promptcut-asset-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isMediaRoute(req.url)) return next();
        const headers = { ...req.headers, host: target.host };
        const upstream = client.request({
          protocol: target.protocol, hostname: target.hostname, port: target.port,
          method: req.method, path: req.url, headers,
        }, (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        });
        upstream.on("error", (err) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(`素材服务不可达(${origin}):${err.message}`);
          } else res.destroy();
        });
        // 页面那边中途不要了(拖动进度条换 Range 是常事),上游那一条也立刻收掉
        res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
        req.pipe(upstream);
      });
    },
  };
}
