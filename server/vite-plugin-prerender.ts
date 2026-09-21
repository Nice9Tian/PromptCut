import type { Plugin, ViteDevServer } from "vite";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { isPrerender } from "./render-role.mjs";
import { prerenderState, setPrerender } from "./prerender-client.mjs";
import { repushMirror } from "./vite-plugin-mirror";
import { stageOriginsOf } from "./stage-ports.mjs";

/**
 * 拉起并看护预渲染进程(docs/decoupling-plan.md 第 3 节「预渲染」,阶段 2)。
 *
 * 编辑器这一端的 dev server 一开始监听,就用同一个 node 起第二个 Vite(vite.prerender.config.ts),
 * 放在另一个端口上,**进程优先级设成低于正常**。之后它拉起的渲染 worker 和 Chrome 都继承这个优先级
 * (Windows 上子进程默认继承父进程的 BELOW_NORMAL),所以 Agent 同时开几个 Chrome 在渲,
 * 系统也会先把 CPU 分给编辑器和界面自己那对热备渲染器。
 *
 * 页面从 /api/prerender/info 拿到它的地址,挂得久的请求(预渲染、动图、导出进度)直接发过去。
 */

/** 连续崩几次就不再重启,免得一个起不来的进程被无限拉起 */
const MAX_RESTARTS = 5;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** 编辑器那一端可能被浏览器以哪几种写法打开 —— 预渲染的跨源放行名单 */
/**
 * 放行给预渲染进程的源。编辑器自己那个源,**外加两个舞台端口的源**(E1):
 * 舞台 iframe 里的页面打预渲染进程(J3 的快照字节、C3 的 SSE)时带的 Origin 是它自己的源,
 * 不是编辑器的源 —— 漏掉就是一片 403。
 */
function editorOrigins(server: ViteDevServer): string[] {
  const addr = server.httpServer?.address() as AddressInfo | null;
  const port = addr?.port || server.config.server.port || 5190;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...stageOriginsOf(port)];
}

/**
 * 起第二个 Vite 用的那个 bin 在哪。
 *
 * 先看 `<root>/node_modules/vite/bin/vite.js`(常规安装),**找不到就按模块解析** ——
 * git worktree 里没有自己的 `node_modules`(Node 会往上走到主仓库那一份),
 * pnpm 的非提升布局同理。写死路径的话这两种情况下预渲染进程根本起不来,
 * 而症状只是「一直没就绪」,很难看出是解析问题。
 *
 * vite 的 `exports` 不放行 `./bin/vite.js`,所以解析主入口再回到包根。
 */
function viteBin(root: string): string {
  const local = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (fs.existsSync(local)) return local;
  try {
    const main = createRequire(import.meta.url).resolve("vite");
    const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
    if (at < 0) return local;
    const guess = path.join(main.slice(0, at + 6), "bin", "vite.js");
    return fs.existsSync(guess) ? guess : local;
  } catch { return local; }
}

function killTree(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || !child.pid) return;
  // 预渲染自己还拉着渲染 worker 和 Chrome,只杀它会留孤儿
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

export function prerenderPlugin(): Plugin {
  return {
    name: "promptcut-prerender",
    configureServer(server: ViteDevServer) {
      if (isPrerender) return;
      const root = server.config.root;

      server.middlewares.use("/api/prerender/info", (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        const s = prerenderState();
        res.end(JSON.stringify({ ok: true, url: s.url, ready: s.ready, error: s.error }));
      });

      let child: ChildProcess | null = null;
      let closing = false;
      const tail: string[] = [];

      const start = async () => {
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, [
          viteBin(root), "--config", path.join(root, "vite.prerender.config.ts"),
          "--port", String(port), "--strictPort", "--host", "127.0.0.1",
        ], {
          cwd: root,
          env: {
            ...process.env,
            PROMPTCUT_ROLE: "prerender",
            PROMPTCUT_CORS_ORIGINS: editorOrigins(server).join(","),
            /*
             * 编辑器那一端的地址,给镜像插件回拉整份项目用(A7)。帧请求的 body 里只有
             * `{session, localRev}`,转发丢了或者这个进程刚起来的时候,它就按这个键
             * 去 `GET /api/data/project?session=&localRev=` 把那一版要回来。
             * (将来 `agent` 模式的预渲染进程不带它 —— 那一份的项目由 Agent 服务端推,I2。)
             */
            PROMPTCUT_EDITOR_URL: editorOrigins(server)[0],
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        try {
          os.setPriority(child.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch { /* 设不了优先级不影响功能,只是少了一层保护 */ }
        const keep = (c: Buffer) => { tail.push(c.toString()); if (tail.length > 30) tail.shift(); };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        setPrerender({ url, ready: false, error: null });

        const me = child;
        me.on("exit", (code) => {
          if (child === me) child = null;
          setPrerender({ ready: false, error: `预渲染进程退出(代码 ${code}):${tail.join("").trim().slice(-400)}` });
          if (closing) return;
          const n = prerenderState().restarts + 1;
          setPrerender({ restarts: n });
          if (n <= MAX_RESTARTS) setTimeout(() => { if (!closing) start().catch(() => {}); }, 1000 * n);
        });

        // 就绪 = 它自己的健康检查接口答话(vite-plugin-vision 在 prerender 这一端注册)
        const t0 = Date.now();
        while (child === me && Date.now() - t0 < 120000) {
          try {
            const r = await fetch(`${url}/api/prerender/health`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) {
              setPrerender({ ready: true, error: null, restarts: 0 });
              /*
               * 它刚起来(或刚崩完重起),手里一份项目都没有。把每个 session 的最新一版
               * 补推过去,不然下一个帧请求只能靠回拉兜 —— 回拉是一趟额外的往返,
               * 而且崩溃重启往往正赶上用户在拖时间轴。
               */
              void repushMirror(url).catch(() => {});
              return;
            }
          } catch { /* 还没起来 */ }
          await new Promise((r) => setTimeout(r, 300));
        }
      };

      server.httpServer?.once("listening", () => {
        start().catch((e) => setPrerender({ ready: false, error: e?.message || String(e) }));
      });
      const stop = () => { closing = true; killTree(child); };
      server.httpServer?.on("close", stop);
      process.once("exit", stop);
    },
  };
}

export default prerenderPlugin;
