import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { STAGE_PORTS, stagePortsOf } from "./stage-ports.mjs";

/**
 * 两个舞台端口(E1)。编辑器端口 +1 / +2 各起一个**透明反向代理**,原样转回同一份 vite,
 * 只多做一件事:给每个响应加 `Origin-Agent-Cluster: ?1`。
 *
 * # 为什么要另开端口
 *
 * 两个舞台 iframe 必须落在**自己的渲染进程**里,否则一张重卡推帧就把编辑器主文档一起卡住
 * (pinned 渲染 1:用户交互不允许有任何卡顿)。Chromium 把「进不进独立进程」按 **site** 算,
 * 而 site 不含端口 —— 同一个 host 换个端口照样是同一个 site,实测(`scripts/probes/oac-probe.mjs`,
 * Chrome 152 / WebView2 153,报告 `restructure_planning/g0-a-webview2-probe.md`)不加头时两个 iframe 和父页
 * 挤在一个进程里,A 死循环 2.5 秒父页最坏 rAF 间隔两千多毫秒。加上 `Origin-Agent-Cluster: ?1`
 * 之后这个源按 **origin** 分簇,iframe 成了独立进程,父页最坏间隔 7～17 ms。
 *
 * **这个头必须在这个源第一次加载时就带上**:Chromium 按 BrowsingInstance 缓存
 * 「这个 origin 是不是 origin-keyed」的判定,补加无效。所以这里对**所有**响应都加,
 * 而不是只挑舞台文档 —— 挑错一个就整轮失效,而多加的那些响应上它不起任何作用。
 * (`window.originAgentCluster` 恒回 true,不能当判据;验收看 CDP `Target.getTargets` 里
 * 有没有 `type: 'iframe'` 的 target。)
 *
 * # 透传的两件事
 *
 * - **Range / 206**:舞台里的 `<video>` 拖动时打自己的源要分段取(R3 素材层进舞台之后)。
 *   状态码和响应头原样抄回去就够,不要自作主张改 `content-length` / `content-range`。
 * - **`upgrade`**:vite 的 HMR WebSocket。客户端脚本算出来的地址是
 *   `importMetaUrl.hostname:importMetaUrl.port`(vite 8 的 client.mjs),也就是舞台端口;
 *   不转发的话它会退回直连 vite 那个端口(vite 自带的 fallback),控制台每次刷都留一行
 *   连接失败。转发之后和同源时一模一样。
 *
 * # 起不来怎么办
 *
 * 端口被占就**不起那一个代理**,注入给页面的端口表里也就没有它;页面看到表不全就退回
 * 同源单舞台(`previewMode.ts`)。dev server 不能因为一个多出来的端口起不来就挂掉。
 */

/** 页面靠这个全局知道有哪几个舞台端口真的起来了;起不来就是空表,页面退回同源单舞台 */
const INJECT_MARK = "__PC_STAGE_PORTS__";

export function stagePortsPlugin(): Plugin {
  let ports: number[] = [];
  const servers: http.Server[] = [];
  /** 代理起完了没有。注入端口表之前要等它 —— 否则第一次打开页面可能拿到一张空表 */
  let ready: Promise<void> = Promise.resolve();

  /** 一个舞台端口的代理:全部转回 127.0.0.1:<vite 端口>,响应加 OAC 头 */
  const makeProxy = (listenHost: string, listenPort: number, targetPort: number): Promise<http.Server | null> =>
    new Promise((resolve) => {
      const proxy = http.createServer((req, res) => {
        const up = http.request(
          { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: req.headers },
          (pres) => {
            /*
             * Host 头原样转过去,所以 vite 那边看到的 Host 还是舞台端口 —— `/api/**` 的同源守卫
             * (`http-guard.mjs` 的 `originOk`)比的是 `origin === "http://" + host`,舞台页面
             * 发给自己这个源的请求因此照样算同源,不用给守卫开任何口子。
             */
            res.writeHead(pres.statusCode ?? 502, { ...pres.headers, "origin-agent-cluster": "?1" });
            pres.pipe(res);
          },
        );
        up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(up);
      });
      // vite 的 HMR WebSocket:客户端打的是舞台端口,原样接到 vite 上
      proxy.on("upgrade", (req, socket: Duplex, head: Buffer) => {
        const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: req.headers });
        up.on("upgrade", (pres, psocket, phead) => {
          const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}`];
          for (const [k, v] of Object.entries(pres.headers)) {
            for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
          }
          socket.write(lines.join("\r\n") + "\r\n\r\n");
          if (phead?.length) socket.write(phead);
          psocket.pipe(socket);
          socket.pipe(psocket);
          psocket.on("error", () => socket.destroy());
          socket.on("error", () => psocket.destroy());
        });
        up.on("error", () => socket.destroy());
        if (head?.length) up.write(head);
        up.end();
      });
      proxy.on("error", () => resolve(null));
      proxy.listen(listenPort, listenHost, () => resolve(proxy));
    });

  return {
    name: "promptcut-stage-ports",
    apply: "serve",

    configureServer(server: ViteDevServer) {
      // 探针和桌面壳从这里问「舞台端口是哪两个」(页面走下面注入的全局,不用打接口)
      server.middlewares.use("/api/stage/ports", (_req, res) => {
        void ready.then(() => {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ ok: true, count: STAGE_PORTS, ports }));
        });
      });

      server.httpServer?.on("listening", () => {
        const addr = server.httpServer?.address() as AddressInfo | null;
        if (!addr || typeof addr === "string") return;
        const host = addr.address === "::" || addr.address === "0.0.0.0" ? "127.0.0.1" : addr.address;
        ready = (async () => {
          for (const p of stagePortsOf(addr.port)) {
            const s = await makeProxy(host, p, addr.port);
            if (s) { servers.push(s); ports.push(p); }
            else server.config.logger.warn(`[stage-ports] 端口 ${p} 起不来(多半被占),这一个舞台退回同源`);
          }
          if (ports.length) server.config.logger.info(`[stage-ports] 舞台端口 ${ports.join(" / ")}(带 Origin-Agent-Cluster: ?1)`);
        })();
      });

      const stop = () => { for (const s of servers) s.close(); servers.length = 0; ports = []; };
      server.httpServer?.on("close", stop);
      const origClose = server.close.bind(server);
      server.close = async () => { stop(); return origClose(); };
    },

    /*
     * 把端口表注入进每一个页面(编辑器页和舞台页都走同一个 index.html)。
     * 走注入而不是让页面去 fetch:iframe 的 src 在第一次 render 时就要定下来,
     * 多一次异步往返就多一帧「舞台还没挂上」的空窗。
     */
    async transformIndexHtml() {
      await ready;
      return [{
        tag: "script",
        injectTo: "head-prepend" as const,
        children: `window.${INJECT_MARK}=${JSON.stringify(ports)};`,
      }];
    },
  };
}

export default stagePortsPlugin;
