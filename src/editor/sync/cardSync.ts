/**
 * 卡片源码同步的页面一侧(C6.6 设计稿第 5 节;编辑器进程一侧在 `server/vite-plugin-cards.ts` 与 `server/card-sync.mjs`)。
 *
 * 同步本身在编辑器进程里做(它有文件、有改动层、有自己的一条文档服务连接),页面只做三件事:
 * - **绑定**:页面接上文档服务时(`syncManager.ts` 的 `bind`)告诉编辑器进程「我在哪个空间、项目用到哪些卡」
 *   (`POST /api/cards/sync/bind`);项目用到的卡变了(时间轴上添了卡)再报一次,新的用户卡 / 改过的内置卡会传上去;
 * - **票据**:共享项目里编辑器进程要一张 page 角色的连接票据(经 HMR 的 `pc:card-sync` `{ type: 'ticket' }`),
 *   页面在自己那条共享项目连接上签(`auth.ticket`),交回 `POST /api/cards/sync/ticket`;
 * - **提示**:装上了别人的版本、自己那份被覆盖(已备份)、覆盖了别人、装不上,都给气泡。
 *
 * 装上之后的重测、重排预渲染不在这里做:编辑器进程照 edit_card 的做法热更新,卡片模块的热更新沿导入链一路重跑到
 * `ProbeGate.tsx`(探针、身份键、分派表都在链上),按现有规则重排一轮,身份键里的源码版本变了的卡补测。
 * **本模块不能静态引入那条链上的任何模块**(`probeRunner`、`costIdentity` 引了 `cardSourceFiles.mjs`,
 * 它把 `src/cards/**` 的源码全 glob 进来):一旦引了,`syncManager` 也成了每张卡的热更新祖先,
 * 改一张卡它就被重跑,页面的共享项目连接随之丢掉、退回本机空间(实测)。
 */
import type { Project } from "../../kernel/project";
import { usedCardIds, peekScopes } from "../cardScope";

export interface CardSyncHooks {
  /** 给一张 page 角色的连接票据(共享项目才会被要);拿不到就抛 */
  ticket: (projectId: string) => Promise<string>;
  /** 气泡 */
  toast: (text: string, tone: "info" | "warn", ms?: number) => void;
  /** 写入身份 → 显示名(「你」「Agent 对话 2」「bob」) */
  who: (actor: Record<string, unknown> | null | undefined) => string;
}

interface Binding {
  kind: "local" | "shared";
  projectId: string;
  url: string;
}

let hooks: CardSyncHooks | null = null;
let current: Binding | null = null;
let lastSent = "";
let cardIdsKey = "";

/** 项目要带上的卡:时间轴上用到的(含卡片图里的节点)+ 归属表记在本项目名下的 */
export function projectCardIds(p: Project, projectId?: string | null): string[] {
  const ids = usedCardIds(p);
  const nodes = (p as { cardNodes?: unknown }).cardNodes;
  const list = Array.isArray(nodes) ? nodes : nodes && typeof nodes === "object" ? Object.values(nodes) : [];
  for (const n of list) {
    const id = (n as { cardId?: unknown })?.cardId;
    if (typeof id === "string" && id) ids.add(id);
  }
  const scopes = peekScopes();
  const pid = projectId ?? p.id;
  if (scopes && pid) for (const [cardId, e] of Object.entries(scopes)) if (e.scope === "project" && e.projectId === pid) ids.add(cardId);
  return [...ids].sort();
}

async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

async function send(b: Binding, cardIds: string[]) {
  const body =
    b.kind === "local"
      ? { mode: "local" }
      : { mode: "ticket", projectId: b.projectId, url: b.url, cardIds };
  const key = JSON.stringify(body);
  if (key === lastSent) return;
  lastSent = key;
  const j = await post("/api/cards/sync/bind", body);
  if (!j?.ok) {
    if (lastSent === key) lastSent = "";
    console.warn("[cards] 卡片源码同步没绑上:", j?.error ?? "无回包");
  }
}

/** 页面换了空间(本机项目 / 共享项目):告诉编辑器进程 */
export function bindCardSync(b: Binding, project: Project, h: CardSyncHooks): void {
  hooks = h;
  current = b;
  const ids = projectCardIds(project, b.kind === "shared" ? b.projectId : project.id);
  cardIdsKey = ids.join(",");
  void send(b, ids);
}

/** 项目变了:用到的卡有变化才再报一次(只在共享项目里有意义) */
export function noteProjectForCardSync(project: Project): void {
  const b = current;
  if (!b || b.kind !== "shared") return;
  const ids = projectCardIds(project, b.projectId);
  const k = ids.join(",");
  if (k === cardIdsKey) return;
  cardIdsKey = k;
  void send(b, ids);
}

const nameOf = (key: unknown) => {
  const s = String(key ?? "");
  return s.replace(/^src\//, "");
};

function onNotice(d: Record<string, unknown>) {
  const h = hooks;
  const file = nameOf(d.key);
  switch (d.type) {
    case "installed":
      if (!d.backup) h?.toast(`卡片 ${file} 已同步为 ${h.who(d.actor as Record<string, unknown>)} 的版本。`, "info", 5000);
      return;
    case "overwritten":
      h?.toast(
        `你对卡片 ${file} 的改动已被 ${h.who(d.actor as Record<string, unknown>)} 覆盖。你的版本已备份到 ${String(d.backup ?? "(没有备份)")}。`,
        "warn",
        10_000,
      );
      return;
    case "overwrote":
      h?.toast(`你覆盖了 ${h.who(d.previousActor as Record<string, unknown>)} 对卡片 ${file} 的改动。`, "info", 8000);
      return;
    case "rejected":
      h?.toast(`卡片 ${file} 没同步上:${String(d.error ?? "")}`, "warn", 10_000);
      return;
    default:
      return;
  }
}

async function onTicket(d: Record<string, unknown>) {
  const reqId = typeof d.reqId === "string" ? d.reqId : null;
  const b = current;
  // 不是本页面连着的共享项目:让别的页面答(多个页面时第一个交回的算数)
  if (!reqId || !b || b.kind !== "shared" || b.projectId !== d.projectId || !hooks) return;
  let reply: Record<string, unknown>;
  try {
    reply = { reqId, ticket: await hooks.ticket(b.projectId) };
  } catch (e) {
    reply = { reqId, error: (e as Error).message };
  }
  await post("/api/cards/sync/ticket", reply);
}

/* HMR 通道:编辑器进程经它要票据、送提示。只在开发服务器给的页面里有 */
if (typeof window !== "undefined" && import.meta.hot) {
  import.meta.hot.on("pc:card-sync", (d: Record<string, unknown>) => {
    if (d?.type === "ticket") void onTicket(d);
    else if (d?.type === "notice") onNotice(d);
  });
}
