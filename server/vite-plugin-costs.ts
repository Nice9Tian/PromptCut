import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCosts, upsertCosts, filterCosts } from "./costs-store.mjs";
import { isPrerender } from "./render-role.mjs";
import { prerenderState } from "./prerender-client.mjs";

/**
 * K1 探针记录的 HTTP 面(目标 K/K1)。**两个进程都挂这一份插件**,和 A7 的镜像一样。
 *
 *   GET  /api/data/costs?device=<字符串>   → { ok, device, costs }
 *   PUT  /api/data/costs  { records: [] }  → { ok, count, added, updated }
 *
 * # 为什么预渲染那一端也要挂
 *
 * `user` / `full` 模式的预渲染进程要按 `costs` 算 `plan.prerenderSet`(K6 的
 * 降级 → 预渲染 → 就绪 → 切换那条闭环)。它自己的页面不跑探针,记录只能从编辑器进程来。
 * 和镜像同一个套路:编辑器进程落盘之后把**同一份 PUT** 原样转过去(不等回复),
 * 预渲染那一端的这份插件就地写自己那一份副本,`frame-pipeline.mjs` 在 4 帧批边界读它。
 * 转发丢了也不致命 —— 下一次探针 PUT 会把整批再带过去,而记录本身是幂等 upsert。
 *
 * `agent` 模式的预渲染进程用不上(Agent 的查询全活渲、不预渲染),但「是不是 agent 模式」
 * 在编辑器这一端看不出来(那是预渲染进程自己的启动参数),所以照转不误 —— 它那边只是
 * 多写一个没人读的文件,没有副作用。
 *
 * # 去重
 *
 * 按 `(identityKey, device)`,见 `server/costs-store.mjs`。`identityKey` 已含 fps,
 * 所以键里不再单列 fps。
 *
 * # 方法
 *
 * 语义上是整批 upsert,所以用 PUT;POST 也收(转发链路和某些旧调用方只会发 POST)。
 * 同源守卫(`vite-plugin-api-guard`)排在所有接口前面,这里不重复判。
 */

const MAX_BODY = 8 * 1024 * 1024;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, res: ServerResponse, then: (d: any) => void) {
  let body = "", size = 0, over = false;
  req.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) { over = true; sendJson(res, 413, { ok: false, error: "探针记录太大" }); req.destroy(); return; }
    body += c;
  });
  req.on("end", () => {
    if (over) return;
    try { then(JSON.parse(body || "{}")); }
    catch (e: any) { sendJson(res, 400, { ok: false, error: e?.message || String(e) }); }
  });
}

function query(req: IncomingMessage, key: string): string | null {
  try { return new URL(req.url || "/", "http://127.0.0.1").searchParams.get(key); } catch { return null; }
}

/* ---------------------------------------------------------------- 转发 */

// 串成一条链发:两批探针记录同时飞的话,到达顺序没保证,后发的那一批可能先落盘。
// upsert 是幂等的,但「后写的是旧数据」仍然会让预渲染那一端短暂拿到过期成绩。
let forwardChain: Promise<unknown> = Promise.resolve();

/** 把这一次 PUT 转给当前就绪的预渲染进程。只有编辑器进程做这件事,而且不等回复 */
function forwardToPrerender(records: unknown[]) {
  if (isPrerender) return;
  const remote = prerenderState();
  if (!remote.ready || !remote.url) return;
  const url = remote.url + "/api/data/costs";
  forwardChain = forwardChain.then(async () => {
    try {
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { /* 预渲染没就绪 / 正在重启:下一批探针 PUT 会把记录再带过去 */ }
  }, () => {});
}

export function costsPlugin(): Plugin {
  return {
    name: "promptcut-costs",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use("/api/data/costs", (req, res) => {
        const method = String(req.method || "GET").toUpperCase();
        if (method === "GET") {
          const device = query(req, "device");
          const costs = filterCosts(loadCosts(root), device);
          return sendJson(res, 200, { ok: true, device: device ?? null, costs });
        }
        if (method !== "PUT" && method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / PUT only" });
        readBody(req, res, (d) => {
          const records = Array.isArray(d?.records) ? d.records : Array.isArray(d) ? d : null;
          if (!records) return sendJson(res, 400, { ok: false, error: "缺 records:[]" });
          try {
            const out = upsertCosts(root, records);
            sendJson(res, 200, { ok: true, count: out.count, added: out.added, updated: out.updated });
            forwardToPrerender(records);
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}

export default costsPlugin;
