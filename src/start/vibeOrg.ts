/**
 * 侧栏那棵树里「只记在这台浏览器里」的那一半:本机分组、项目放在哪个分组、置顶、归档、手排的顺序。
 *
 * **为什么只在本机**:分组(以及「用户怎么组织项目」整件事)语义里还没有,属一级(`user-workflow.md`),会话不许自定。
 * 这一版先把它做成每个账号(游客按游客编号)在这台浏览器里各一份的本地整理,不进服务端、不跨设备、不给别的成员看;
 * 要不要放到服务端、跨设备同步,列为待用户项(`docs/reports/AGENT-claude-vibe-wire.md`)。
 *
 * 项目本身(有哪些、叫什么、谁建的)一律以云端文档服务的列表为准:这里只记整理信息,列表里没有的项目不会凭空出现;
 * 列表暂时取不到时也不丢已经记下的整理信息(`withProjects` 把这次没出现的条目原样留着)。
 *
 * 纯函数加一对读写,不碰 React;读写都包 try/catch(无痕窗口、禁了站点数据会直接抛),取不到就当没记过。
 * 一律返回新对象,不原地改(仓库约束)。单测 `vibeOrg.test.mjs`。
 */
import type { Ratio, TreeFlags, VibeChat, VibeGroup, VibeProject } from "./types.ts";

export interface OrgProject extends TreeFlags {
  id: string;
  groupId: string | null;
}

export interface OrgChat extends TreeFlags {
  id: string;
  projectId: string;
}

export interface OrgState {
  v: 1;
  groups: VibeGroup[];
  /** 数组顺序就是显示顺序(同级之间) */
  projects: OrgProject[];
  chats: OrgChat[];
}

export const EMPTY_ORG: OrgState = Object.freeze({ v: 1, groups: [], projects: [], chats: [] }) as OrgState;

/** 本机存储的键:按账号(游客按游客编号)各一份 */
export const orgKey = (scope: string): string => `pc.start.org.${scope}`;

function flagsOf(x: unknown): TreeFlags {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const out: TreeFlags = {};
  if (r.pinned === true) out.pinned = true;
  if (r.archived === true) out.archived = true;
  return out;
}

function idOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200;
}

type Loose = Record<string, unknown>;
const rows = (x: unknown): Loose[] => (Array.isArray(x) ? x.filter((r) => r && typeof r === "object") : []) as Loose[];

/** 读回来的东西不可信(手改过、旧版本写的别的形状):逐条认,认不出的丢掉 */
export function parseOrg(raw: string | null): OrgState {
  if (!raw) return EMPTY_ORG;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY_ORG;
  }
  const r = (v && typeof v === "object" ? v : {}) as Loose;
  const groups: VibeGroup[] = rows(r.groups)
    .filter((g) => idOk(g.id) && typeof g.name === "string" && g.name.trim() !== "")
    .map((g) => ({ id: g.id as string, name: String(g.name).slice(0, 200), ...flagsOf(g) }));
  const groupIds = new Set(groups.map((g) => g.id));
  const projects: OrgProject[] = rows(r.projects)
    .filter((p) => idOk(p.id))
    .map((p) => ({ id: p.id as string, groupId: idOk(p.groupId) && groupIds.has(p.groupId) ? p.groupId : null, ...flagsOf(p) }));
  const chats: OrgChat[] = rows(r.chats)
    .filter((c) => idOk(c.id) && idOk(c.projectId))
    .map((c) => ({ id: c.id as string, projectId: c.projectId as string, ...flagsOf(c) }));
  return { v: 1, groups, projects, chats };
}

export function loadOrg(scope: string | null): OrgState {
  if (!scope) return EMPTY_ORG;
  try {
    return parseOrg(localStorage.getItem(orgKey(scope)));
  } catch {
    return EMPTY_ORG;
  }
}

export function saveOrg(scope: string | null, org: OrgState): void {
  if (!scope) return;
  try {
    localStorage.setItem(orgKey(scope), JSON.stringify(org));
  } catch {
    /* 存不了就只在这次打开期间有效 */
  }
}

/** 云端列表里的一个项目(我创建的、我加入的、游客自己的) */
export interface CloudEntry {
  id: string;
  name: string;
  role: VibeProject["role"];
}

/** 这台浏览器打开过这个项目时记下的画面信息(`thumbCache.ts`) */
export interface SeenMeta {
  ratio: Ratio | null;
  duration: number | null;
  thumb: string | null;
  seenAt: string | null;
}

/**
 * 把云端列表和本机整理拼成侧栏要的项目清单。顺序:本机记过顺序的按记的排;这次新出现的(刚建的、刚被拉进来的)排最前面,
 * 彼此之间保持列表里的先后。同一个项目在「我创建的」「我加入的」里都出现时只留第一次。
 */
export function mergeProjects(org: OrgState, cloud: readonly CloudEntry[], meta: Readonly<Record<string, SeenMeta>> = {}): VibeProject[] {
  const byId = new Map<string, CloudEntry>();
  for (const c of cloud) if (!byId.has(c.id)) byId.set(c.id, c);
  const groupIds = new Set(org.groups.map((g) => g.id));
  const known = org.projects.filter((p) => byId.has(p.id));
  const knownIds = new Set(known.map((p) => p.id));
  const fresh: OrgProject[] = [...byId.values()].filter((c) => !knownIds.has(c.id)).map((c) => ({ id: c.id, groupId: null }));
  return [...fresh, ...known].map((o) => {
    const c = byId.get(o.id)!;
    const m = meta[o.id];
    const p: VibeProject = {
      id: c.id,
      name: c.name,
      role: c.role,
      groupId: o.groupId && groupIds.has(o.groupId) ? o.groupId : null,
      ratio: m?.ratio ?? null,
      duration: m?.duration ?? null,
      thumb: m?.thumb ?? null,
      seenAt: m?.seenAt ?? null,
    };
    if (o.pinned) p.pinned = true;
    if (o.archived) p.archived = true;
    return p;
  });
}

/**
 * 侧栏改过项目之后(置顶、归档、排序、换分组)写回整理信息。这次清单里没有的条目(列表暂时取不到、换了账号范围)原样留在后面,不丢。
 */
export function withProjects(org: OrgState, list: readonly Pick<VibeProject, "id" | "groupId" | "pinned" | "archived">[]): OrgState {
  const ids = new Set(list.map((p) => p.id));
  const rest = org.projects.filter((p) => !ids.has(p.id));
  return {
    ...org,
    projects: [...list.map((p) => ({ id: p.id, groupId: p.groupId ?? null, ...flagsOf(p) })), ...rest],
  };
}

export function withGroups(org: OrgState, groups: readonly VibeGroup[]): OrgState {
  const ids = new Set(groups.map((g) => g.id));
  return {
    ...org,
    groups: groups.map((g) => ({ id: g.id, name: g.name, ...flagsOf(g) })),
    // 删掉的分组:里面的项目回到「没放进分组」
    projects: org.projects.map((p) => (p.groupId && !ids.has(p.groupId) ? { ...p, groupId: null } : p)),
  };
}

export function withChats(org: OrgState, projectId: string, list: readonly Pick<VibeChat, "id" | "pinned" | "archived">[]): OrgState {
  const ids = new Set(list.map((c) => c.id));
  const rest = org.chats.filter((c) => !(c.projectId === projectId && ids.has(c.id)));
  return { ...org, chats: [...list.map((c) => ({ id: c.id, projectId, ...flagsOf(c) })), ...rest] };
}

/** 新建分组。名字空白就叫「新分组」;编号在这一份里不重复 */
export function addGroup(org: OrgState, name: string, rand: () => string = () => Math.random().toString(36).slice(2, 8)): { org: OrgState; id: string } {
  const taken = new Set(org.groups.map((g) => g.id));
  let id = `g-${rand()}`;
  for (let i = 0; taken.has(id) && i < 50; i++) id = `g-${rand()}${i}`;
  const group: VibeGroup = { id, name: name.trim().slice(0, 200) || "新分组" };
  return { org: { ...org, groups: [...org.groups, group] }, id };
}

/** 把一个项目放进某个分组(null 是移出分组) */
export function moveProject(org: OrgState, projectId: string, groupId: string | null): OrgState {
  const target = groupId && org.groups.some((g) => g.id === groupId) ? groupId : null;
  const has = org.projects.some((p) => p.id === projectId);
  const projects = has
    ? org.projects.map((p) => (p.id === projectId ? { ...p, groupId: target } : p))
    : [{ id: projectId, groupId: target }, ...org.projects];
  return { ...org, projects };
}

/* ---------------- 项目 Agent:看得到哪些对话 ---------------- */

/** 云端历史列表里的一条(`src/ai/cloud/types.ts` 的 `CloudChatItem`,这里只认用得到的几项) */
export interface ChatItemLike {
  id: string;
  title: string;
  state: VibeChat["state"];
  visibility?: "shared" | "private";
  ownerAccountId?: string;
  creatorReadOnly?: boolean;
}

/**
 * 当前账号看得到的对话(`product/agent.md`「接入」):共有对话同项目有效成员都看得到;私有对话只有所属账号,
 * 例外是项目创建者能只读地看。服务端已经按这条过滤过,页面再复核一遍:**不能把别人的私有对话列出来**。
 * 没带归属的老条目(服务端没给 `ownerAccountId`)以服务端的过滤为准、照列。
 */
export function viewableChats(items: readonly ChatItemLike[], viewer: { accountId: string | null; creator: boolean }, projectId: string): VibeChat[] {
  const out: VibeChat[] = [];
  for (const it of items) {
    const visibility = it.visibility === "private" ? "private" : "shared";
    const owned = typeof it.ownerAccountId === "string" && it.ownerAccountId !== "";
    const mine = owned && viewer.accountId !== null && it.ownerAccountId === viewer.accountId;
    if (visibility === "private") {
      // 私有:没带归属的只在服务端说了是创建者只读时才列;带了归属的,是自己的或自己是创建者才列
      if (!owned && !it.creatorReadOnly && viewer.accountId === null) continue;
      if (owned && !mine && !viewer.creator) continue;
    }
    out.push({
      id: it.id,
      name: it.title || "云端对话",
      projectId,
      state: it.state,
      visibility,
      readOnly: visibility === "private" && (it.creatorReadOnly === true || (owned && !mine)),
    });
  }
  return out;
}

/** 把本机记的置顶、归档、顺序套到这个项目的对话上。服务端新出现的对话排前面(和项目同一个规矩) */
export function mergeChats(org: OrgState, projectId: string, chats: readonly VibeChat[]): VibeChat[] {
  const byId = new Map(chats.map((c) => [c.id, c]));
  const known = org.chats.filter((c) => c.projectId === projectId && byId.has(c.id));
  const knownIds = new Set(known.map((c) => c.id));
  const fresh = chats.filter((c) => !knownIds.has(c.id));
  return [
    ...fresh,
    ...known.map((o) => {
      const c: VibeChat = { ...byId.get(o.id)! };
      if (o.pinned) c.pinned = true;
      if (o.archived) c.archived = true;
      return c;
    }),
  ];
}
