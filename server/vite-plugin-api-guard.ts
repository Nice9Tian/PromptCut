import type { Plugin, ViteDevServer } from "vite";
import { originOk, jsonContentType } from "./http-guard.mjs";

/**
 * `/api/**` 的同源守卫。**一个卡口,不是十二个。**
 *
 * # 为什么要有
 *
 * sidecar 监听 127.0.0.1,很容易觉得「只有自己人访问得到」。不对:用户浏览器里**任何一个
 * 网页**都能往 127.0.0.1 发请求。跨源的响应它读不到(同源策略挡的是「读」),但请求照发,
 * **副作用照发生** —— 只要那是一个「简单请求」(GET/HEAD,或 POST 且 Content-Type 属于
 * text/plain、application/x-www-form-urlencoded、multipart/form-data 三者之一),浏览器
 * 连预检都不发,服务端这边根本没有拒绝的机会。
 *
 * 0.3.0 评审实际打穿的一条:恶意页面对 `/api/ai/config` 发一个 `text/plain` 的 POST,
 * body 是 `{"api":{"baseUrl":"https://攻击者"}}`。writeConfig 是局部合并,payload 里没有
 * apiKey 就沿用旧的 —— 用户真实的 Key 原样留着,下一次对话连着 Key 一起打到攻击者服务器。
 * 攻击者全程不需要读到任何响应。同类的还有任意文件读(`/api/chats/attach/import`、
 * `/api/skill/open-path`)、任意写(`/api/media/upload/`)、强制弹资源管理器
 * (`/api/ai/diagnostics/save`)、递归删目录(`/api/skill/jobs/<id>/delete`)。
 * (注:上一行的路径别写成星号通配 —— 那会在块注释里造出一个 `*` 加 `/`,把注释提前闭合。)
 *
 * # 为什么放在一个中间件里,而不是每个 handler 开头加一句
 *
 * 全仓 14 个插件、几十条路由,靠「每个人记得加」这件事已经失败过一次 —— 改之前整个仓库
 * 只有 2 处调了 originOk。卡口放在最前面,新加的路由**默认就是受保护的**,忘不掉。
 *
 * # 两道判据
 *
 * 1. **Origin**:跨源 POST 浏览器必带 Origin,和本站对不上就 403。同源 GET 和 curl /
 *    sidecar / MCP 脚本不带 Origin —— 放行,CSRF 讲的是「浏览器替用户发的请求」。
 * 2. **带 body 就必须是 application/json**:那三种「简单类型」一律拒。这一道比第 1 道硬,
 *    它不依赖 Origin 头存在:攻击页想带 body 就必须声明 Content-Type,声明 json 就会触发
 *    预检,而我们不回 CORS 头,预检过不去。
 *    没有 Content-Type 的请求(无 body 的 POST,如 `/api/shots/install`)豁免这一道 ——
 *    自家界面就是这么发的 —— 它们由第 1 道兜。
 *
 * 上传原始字节的两条路由豁免第 2 道:它们的 body 是一个 File,Content-Type 由浏览器按文件
 * 类型填(传 .txt 就正好是 text/plain)。它们仍受第 1 道保护。
 */

/** body 是原始字节、Content-Type 由文件类型决定的路由前缀 */
const RAW_BODY_PREFIXES = ["/api/media/upload/", "/api/export/media/"];

export function apiGuardPlugin(): Plugin {
  return {
    name: "promptcut-api-guard",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "/";
        if (!url.startsWith("/api/")) return next();

        const deny = (error: string) => {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ ok: false, error }));
        };

        if (!originOk(req)) {
          return deny(`跨源请求被拒绝(Origin: ${req.headers.origin})`);
        }

        const method = String(req.method || "GET").toUpperCase();
        const hasCt = !!req.headers["content-type"];
        const raw = RAW_BODY_PREFIXES.some((p) => url.startsWith(p));
        if (method !== "GET" && method !== "HEAD" && hasCt && !raw && !jsonContentType(req)) {
          return deny("这个接口只接受 Content-Type: application/json");
        }

        next();
      });
    },
  };
}

export default apiGuardPlugin;
