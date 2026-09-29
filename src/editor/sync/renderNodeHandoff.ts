/**
 * 桌面应用自动成为共享项目的渲染节点 —— 页面一侧(语义 `product/platforms.md`「渲染节点」:
 * 「加入共享项目的桌面应用自动成为这个项目的渲染节点」)。编辑器进程一侧见 `server/render-node-relay.mjs`,
 * 预渲染进程一侧见 `server/auto-render-node.mjs`。
 *
 * 预渲染进程启动时不知道任何共享项目,页面进入共享项目时把这个项目的共享配置交过去,和素材上传队列同一个思路
 * (`media/assetTiers.ts` 的 `startUploadTarget`):
 * - **交接**:`syncManager.ts` 的 `bind` 接上共享项目时 `POST /api/render-node/bind
 *   { url, projectId, contentId, assetBase?, ticket }`。`url` 是本页面连的那个文档服务(云端、局域网主机、本机都一样),
 *   `ticket` 是本页面在自己的连接上签的 render 角色连接票据(`auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'user' } }`)。
 *   不交项目口令,也不交 `K`。
 * - **素材基址**:本页面挑到了当前项目的素材服务(`assetTiers.ts`)就再交一次(同一个项目只换基址,不重建)。
 * - **票据往返**:预渲染进程每次建新会话要一张新票据(票据两分钟过期),编辑器进程经 HMR 发
 *   `pc:render-node { type: 'ticket', reqId, projectId }`,本页面连着的正是这个项目就签一张交回 `POST /api/render-node/ticket`。
 * - **撤掉**:本页面离开这个项目(回本机空间、取消协作、换开别的项目)时 `POST /api/render-node/unbind { projectId }`。
 *   页面关掉(或桌面版转入后台)不算离开:已建的会话照常用到断开为止,之后等页面回来再续(预渲染进程一侧)。
 *
 * 在线页面没有编辑器进程,不交接(`syncManager.ts` 只在桌面版调)。开发者开关 `PROMPTCUT_AUTO_RENDER_NODE=0` 在服务端判。
 */

/** 在线构建剪枝(写法见 `src/online/pageFlag.ts`):在线构建里本模块的 `/api/render-node/*` 调用整段剪掉 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

export interface RenderNodeBinding {
  url: string;
  projectId: string;
  /** 项目文档的 `id`(层表键 `layers:<id>` 用的那个) */
  contentId: string | null;
}

export interface RenderNodeHooks {
  /** 在本页面的共享项目连接上签一张 render 连接票据;拿不到就抛 */
  ticket: (projectId: string) => Promise<string>;
}

export interface RenderNodeDeps {
  post?: (path: string, body: unknown) => Promise<Record<string, unknown> | null>;
}

async function defaultPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

let post: NonNullable<RenderNodeDeps["post"]> = defaultPost;
let current: RenderNodeBinding | null = null;
let hooks: RenderNodeHooks | null = null;
let assetBase: string | null = null;
let lastAnswer: { at: number; ok: boolean; error?: string } | null = null;
const counters = { binds: 0, unbinds: 0, tickets: 0, ticketFailures: 0 };

/** 单测用:换掉 HTTP */
export function setRenderNodeDeps(deps: RenderNodeDeps): void {
  post = deps.post ?? defaultPost;
}

async function sendBind(b: RenderNodeBinding, withTicket: boolean): Promise<void> {
  if (ONLINE_BUILD) return;
  let ticket: string | null = null;
  if (withTicket && hooks) {
    try { ticket = await hooks.ticket(b.projectId); } catch { ticket = null; /* 预渲染进程建会话时再来要 */ }
  }
  if (current !== b) return;
  counters.binds++;
  const r = await post("/api/render-node/bind", { url: b.url, projectId: b.projectId, contentId: b.contentId, ...(assetBase ? { assetBase } : {}), ...(ticket ? { ticket } : {}) });
  if (r && r.ok === false) console.warn("[render-node] 共享配置没交给预渲染进程:", r.error ?? "无回包");
}

/** 页面接上了共享项目:把共享配置交给预渲染进程 */
export function bindRenderNode(b: RenderNodeBinding, h: RenderNodeHooks): void {
  if (ONLINE_BUILD) return;
  hooks = h;
  const same = current && current.url === b.url && current.projectId === b.projectId;
  if (same) {
    // 同一个项目:只是项目文档的 id 晚到了(加入别人的项目时 store 里的项目稍后才换成文档服务的那份),再交一次,不另签票据
    if (current!.contentId === b.contentId || !b.contentId) return;
    current = { ...current!, contentId: b.contentId };
    void sendBind(current, false);
    return;
  }
  current = { ...b };
  assetBase = null;
  void sendBind(current, true);
}

/** 本页面挑到了(或换了)当前共享项目的素材服务基址;null = 没有远程素材服务(本机就是主机) */
export function noteRenderNodeAssetBase(base: string | null): void {
  if (ONLINE_BUILD) return;
  const next = base ? base.replace(/\/+$/, "") : null;
  if (next === assetBase) return;
  assetBase = next;
  if (current && next) void sendBind(current, false);
}

/** 本页面离开了这个共享项目:撤掉(只撤同一个项目的,别的页面在别的项目上的不受影响) */
export function unbindRenderNode(projectId: string, reason = "page-left"): void {
  if (ONLINE_BUILD) return;
  if (!current || current.projectId !== projectId) return;
  current = null;
  assetBase = null;
  counters.unbinds++;
  void post("/api/render-node/unbind", { projectId, reason });
}

/** 预渲染进程要票据:本页面连着的正是这个项目才答(多个页面时第一个交回的算数) */
export async function answerRenderNodeTicket(d: Record<string, unknown>): Promise<void> {
  if (ONLINE_BUILD) return;
  const reqId = typeof d.reqId === "string" ? d.reqId : null;
  const b = current;
  if (!reqId || !b || b.projectId !== d.projectId || !hooks) return;
  let reply: Record<string, unknown>;
  try {
    reply = { reqId, ticket: await hooks.ticket(b.projectId) };
    counters.tickets++;
    lastAnswer = { at: Date.now(), ok: true };
  } catch (e) {
    reply = { reqId, error: (e as Error).message };
    counters.ticketFailures++;
    lastAnswer = { at: Date.now(), ok: false, error: (e as Error).message };
  }
  await post("/api/render-node/ticket", reply);
}

/** 诊断(探针读 `window.__pcRenderNodeHandoff`):不含票据 */
export function renderNodeHandoffDiag() {
  return { bound: current ? { url: current.url, projectId: current.projectId, contentId: current.contentId } : null, assetBase, counters: { ...counters }, lastAnswer };
}

/* HMR 通道:编辑器进程经它要票据。只在开发服务器给的页面里有(安装版就是开发服务器) */
if (!ONLINE_BUILD && typeof window !== "undefined" && import.meta.hot) {
  import.meta.hot.on("pc:render-node", (d: Record<string, unknown>) => {
    if (d?.type === "ticket") void answerRenderNodeTicket(d);
  });
  (window as unknown as { __pcRenderNodeHandoff?: () => unknown }).__pcRenderNodeHandoff = renderNodeHandoffDiag;
}
