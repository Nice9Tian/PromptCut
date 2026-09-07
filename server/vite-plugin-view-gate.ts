import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Skill 无头实例的「只读浏览」钥匙。
 *
 * # 要解决的是什么
 *
 * agent 干活时常想亲眼看一下编辑台的画面。但这个端口上的页面只能有一个主人 ——
 * 桥同一时刻只认一个编辑台,agent 直接开一下就把无头实例自己那个页面踢掉了,
 * 之后它所有的工具调用全部失败,任务当场哑掉。
 *
 * 上一版的做法是在 SKILL.md 里写一条规矩:「想看就必须加 ?observe=1」。规矩是对的,
 * 但它把记性的负担压在了 agent 身上 —— 而这类「你必须记得加个后缀,否则后果严重」的
 * 约定,恰恰是最容易被漏掉的一种。
 *
 * 现在改成:**我们直接给它一条完整的链接**,钥匙已经在里面了。它照常打开,不用记任何东西。
 *
 * # 两把钥匙
 *
 * 都由 scripts/headless.mjs 在起 vite 之前生成,通过环境变量交给这里:
 *
 *   PROMPTCUT_OWNER_TOKEN   谁是编辑台。无头实例自己用,能读能写。
 *   PROMPTCUT_VIEW_TOKEN    只读浏览。给 agent 的那条链接里带的就是它。
 *
 * 分成两把而不是一把当两用:同一把的话,把 `view=` 改成 `owner=` 就能变成主人。
 * agent 不是敌人,但它会照着自己的理解改 URL —— 两把钥匙让这件事做不到。
 *
 * # 「不能编辑」是真的,不是靠自觉
 *
 * 两道:
 *
 *   1. **页面这一层**:没有钥匙就打不开编辑台,回一张说明页,上面就是那条正确的链接
 *      (它自愈 —— 就算 agent 直接开了裸地址,也当场知道该开哪一条);
 *   2. **写这一层**:改项目的接口(`PUT` / `DELETE /api/projects/...`)必须带上
 *      owner 那把钥匙。只读页面拿不到它,所以点保存也落不了盘。
 *
 * 光靠第 1 道不够 —— 那只是「不连桥」,页面上的保存按钮照样能把 project.proc 覆盖掉,
 * 和正在写回的无头实例互相踩。第 2 道才让「不能编辑」这句话立得住。
 *
 * # 对用户自己那份 PromptCut 没有任何影响
 *
 * 两个环境变量只有 headless.mjs 会设。用户自己跑的 dev server 和桌面版都没有,
 * 这个插件整个是空转的。
 */

/** 只读页面把项目写回去的那几条路。别的接口不归这里管 */
const PROJECT_WRITE = /^\/api\/projects(\/|$)/;
const WRITE_METHODS = new Set(["PUT", "POST", "PATCH", "DELETE"]);

function param(req: IncomingMessage, name: string): string {
  try {
    return new URL(req.url || "/", "http://localhost").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

/** 定长比较,别让比较耗时把钥匙漏出去 */
function same(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 这次请求是不是「浏览器要打开一个页面」,而不是取 js / css / 图片 */
function isDocumentRequest(req: IncomingMessage): boolean {
  if ((req.method || "GET").toUpperCase() !== "GET") return false;
  const accept = String(req.headers.accept || "");
  if (!accept.includes("text/html")) return false;
  const pathname = (req.url || "/").split("?")[0];
  // vite 自己的东西和带扩展名的资源都不是导航
  if (pathname.startsWith("/@") || pathname.startsWith("/node_modules/")) return false;
  return !/\.[a-z0-9]+$/i.test(pathname);
}

function lockedPage(viewUrl: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>需要只读链接</title>
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh;
         font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif; background:#14161a; color:#e6e8ec; }
  main { max-width:44rem; padding:2rem; }
  h1 { font-size:1.15rem; margin:0 0 1rem; }
  p { margin:0 0 .8rem; color:#aab; }
  a { display:block; margin:1rem 0; padding:.9rem 1rem; border-radius:8px;
      background:#1e222b; color:#8ab4ff; text-decoration:none;
      word-break:break-all; font-family:ui-monospace,Consolas,monospace; }
  a:hover { background:#252a35; }
  code { color:#e6c07b; }
</style></head><body><main>
<h1>这个端口上有 Skill 任务正在跑</h1>
<p>编辑台被那个任务占着。直接打开会把它从工具通道上挤掉,它之后的每一次工具调用都会失败。</p>
<p>要看画面请走下面这条<strong>只读链接</strong>(钥匙已经在里面了,原样打开即可):</p>
<a href="${viewUrl}">${viewUrl}</a>
<p>只读页面能看,不能改:保存会被服务端拒掉。这条链接也写在任务目录的
<code>instance.json</code> 里(<code>viewUrl</code> 字段)。</p>
</main></body></html>`;
}

export function viewGatePlugin(): Plugin {
  return {
    name: "promptcut-view-gate",
    configureServer(server: ViteDevServer) {
      const viewToken = process.env.PROMPTCUT_VIEW_TOKEN || "";
      const ownerToken = process.env.PROMPTCUT_OWNER_TOKEN || "";
      // 不是 Skill 无头实例 —— 什么都不做
      if (!viewToken) return;

      const viewUrlFor = (req: IncomingMessage) => {
        const host = req.headers.host || "127.0.0.1";
        return `http://${host}/?draft=project&view=${encodeURIComponent(viewToken)}`;
      };

      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        const hasView = same(param(req, "view"), viewToken);
        const hasOwner = same(param(req, "owner"), ownerToken);

        // ── 1. 页面这一层:没钥匙就给说明页 ──
        if (isDocumentRequest(req) && !hasView && !hasOwner) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          return res.end(lockedPage(viewUrlFor(req)));
        }

        // ── 2. 写这一层:改项目必须有 owner 那把钥匙 ──
        const method = String(req.method || "GET").toUpperCase();
        const pathname = (req.url || "/").split("?")[0];
        if (WRITE_METHODS.has(method) && PROJECT_WRITE.test(pathname)) {
          // 无头实例自己写回时会带这个头(见 src/editor/io/drafts.ts)
          const header = String(req.headers["x-pc-owner"] || "");
          if (!same(header, ownerToken)) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            return res.end(JSON.stringify({
              ok: false,
              viewOnly: true,
              error: "这是只读查看模式,改不了这个项目",
              hint: "这个实例上的项目由 Skill 任务里的 agent 负责改。你看到的是只读视图。",
            }));
          }
        }

        next();
      });

      // 完整链接由 headless.mjs 写进 instance.json 的 viewUrl(那边才知道最终端口)
      server.config.logger.info("  ➜  只读浏览已启用:没有 view 钥匙打不开编辑台,改项目的接口要 owner 钥匙");
    },
  };
}

export default viewGatePlugin;
