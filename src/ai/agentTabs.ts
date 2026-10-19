import { useSyncExternalStore } from "react";
import { MAIN_TAB, dropChatStore, getChatStore } from "./liveChat.ts";
import { normalizeCreativity, type CreativityLevel } from "../kernel/creativity.mjs";

/**
 * AI 助手面板的分页:每一页是一个独立的 Agent 对话,可以同时跑。
 *
 * 页的身份有两层:
 *   - tabId:页面内部用的键(store、localStorage 后缀),主页固定叫 main;
 *   - conversationId:这一页的会话归档 id(useChatHistory 管的那个)。**给模型看的
 *     「Agent 对话 ID」就是它** —— send_message 的收件人、范围变动里的「谁改的」都写它,
 *     历史里能按它找回整段对话。
 *
 * 列表存 localStorage:刷新页面回来分页还在,每页的对话由 conversationId 从归档里找回。
 */
export interface AgentTab {
  id: string;
  conversationId: string | null;
  /** 用户可见的名字;没声明范围之前是「Agent N」 */
  title: string;
  /** 「Agent N」的 N:创建时取当前最小的空号,关掉别的页不改它;子 Agent 页(有角色名)没有 */
  num?: number;
  /** Agent 用 declare_scope 声明的修改范围,如「剪辑1->序列2」 */
  scope: string | null;
  /** 正在跑(流式回复中) */
  busy: boolean;
  /** 还没送达的其他 Agent 消息数(标在页签上) */
  unread: number;
  createdAt: number;
  /**
   * 这个对话单独设的创造力等级(`kernel/creativity.mjs`);null = 跟项目的默认等级。
   * 只存在本机的页签里(计划 agent-workflow-plan.md 第 4 节第 3 条),不进项目文档;随每条聊天请求带给服务端。
   */
  creativity: CreativityLevel | null;
  /**
   * 多 Agent(计划 agent-workflow-plan.md A3):`spawn_agent` 拉起的子 Agent 带预设角色(id 与中文名)、父对话 ID,
   * 以及拉起时沿用父对话的驱动(`provider`,这一页的驱动下拉框按它预选)。主对话与用户自己开的页都是 null。
   */
  role?: string | null;
  roleName?: string | null;
  parent?: string | null;
  provider?: string | null;
}

interface TabsState {
  tabs: AgentTab[];
  activeId: string;
}

const STORAGE_KEY = "pc.agentTabs";
const ACTIVE_KEY = "pc.agentTabs.active";

/** 老数据没存编号:从「Agent N」的名字里认;改过名又没有角色的按位置给;子 Agent 页没有 */
function tabNumber(t: Partial<AgentTab>, i: number): number | undefined {
  if (typeof t.num === "number" && t.num > 0) return t.num;
  const m = typeof t.title === "string" ? /^Agent (\d+)$/.exec(t.title) : null;
  if (m) return Number(m[1]);
  return t.roleName ? undefined : i + 1;
}

/** 当前最小的没被占用的「Agent N」编号 */
function smallestFreeNum(tabs: readonly AgentTab[]): number {
  const used = new Set(tabs.map((t) => t.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function load(): TabsState {
  let tabs: AgentTab[] = [];
  let activeId = "";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as Partial<AgentTab>[]) : [];
    tabs = arr
      .filter((t) => typeof t.id === "string" && t.id)
      .map((t, i) => ({
        id: t.id!,
        conversationId: typeof t.conversationId === "string" ? t.conversationId : null,
        title: typeof t.title === "string" && t.title ? t.title : `Agent ${i + 1}`,
        num: tabNumber(t, i),
        scope: typeof t.scope === "string" ? t.scope : null,
        busy: false,
        unread: 0,
        createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
        creativity: normalizeCreativity(t.creativity),
        role: typeof t.role === "string" ? t.role : null,
        roleName: typeof t.roleName === "string" ? t.roleName : null,
        parent: typeof t.parent === "string" ? t.parent : null,
        provider: typeof t.provider === "string" ? t.provider : null,
      }));
    const a = localStorage.getItem(ACTIVE_KEY);
    if (a) activeId = a;
  } catch {
    /* 本地存储不可用就从一页开始 */
  }
  // 主页(MAIN_TAB)也能关;只有一页都没有(第一次打开)时才补一个,AI 栏总有一页
  if (tabs.length === 0) {
    tabs.push({ id: MAIN_TAB, conversationId: null, title: "Agent 1", num: 1, scope: null, busy: false, unread: 0, createdAt: 0, creativity: null });
  }
  if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0].id;
  return { tabs, activeId };
}

let state: TabsState = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(state.tabs.map(({ id, conversationId, title, num, scope, createdAt, creativity, role, roleName, parent, provider }) => ({ id, conversationId, title, num, scope, createdAt, creativity, role, roleName, parent, provider }))),
    );
    localStorage.setItem(ACTIVE_KEY, state.activeId);
  } catch {
    /* 忽略 */
  }
}

function commit(next: TabsState) {
  state = next;
  persist();
  for (const fn of listeners) fn();
}

function patchTab(id: string, patch: Partial<AgentTab>) {
  if (!state.tabs.some((t) => t.id === id)) return;
  commit({ ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

export function getTabs(): AgentTab[] {
  return state.tabs;
}

export function getActiveTabId(): string {
  return state.activeId;
}

export function addTab(): AgentTab {
  const n = smallestFreeNum(state.tabs);
  const tab: AgentTab = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    conversationId: null,
    title: `Agent ${n}`,
    num: n,
    scope: null,
    busy: false,
    unread: 0,
    createdAt: Date.now(),
    creativity: null,
  };
  commit({ tabs: [...state.tabs, tab], activeId: tab.id });
  return tab;
}

/**
 * `spawn_agent` 拉起的子 Agent 开一页(A3):对话 ID 由服务端定(= 它的新身份),先写进这一页记会话 id 的键,
 * 页面挂上时 useChatHistory 就读到它;不抢当前页的焦点。同一个对话 ID 已经有页就回那一页。
 */
export function addSpawnedTab(spec: { conversationId: string; role: string; roleName: string; parent: string; provider: string | null; creativity: CreativityLevel | null }): AgentTab {
  const hit = state.tabs.find((t) => t.conversationId === spec.conversationId);
  if (hit) return hit;
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  try {
    localStorage.setItem(`pcChatId:${id}`, spec.conversationId);
  } catch {
    /* 存不了的话 useChatHistory 会另起一个 id,页签上的对话 ID 在下面这份里仍是对的 */
  }
  const same = state.tabs.filter((t) => t.roleName === spec.roleName).length;
  const tab: AgentTab = {
    id,
    conversationId: spec.conversationId,
    title: same ? `${spec.roleName} ${same + 1}` : spec.roleName,
    scope: null,
    busy: false,
    unread: 0,
    createdAt: Date.now(),
    creativity: normalizeCreativity(spec.creativity),
    role: spec.role,
    roleName: spec.roleName,
    parent: spec.parent,
    provider: spec.provider,
  };
  commit({ ...state, tabs: [...state.tabs, tab] });
  return tab;
}

/** 这一页拉起时定下的驱动(子 Agent 沿用父对话的);没有回 null */
export function getTabProvider(id: string): string | null {
  return state.tabs.find((x) => x.id === id)?.provider ?? null;
}

/** 还能不能关这一页:每页都能关(含主页),只剩最后一页时不能 */
export function canCloseTab(id: string): boolean {
  return state.tabs.length > 1 && state.tabs.some((t) => t.id === id);
}

/**
 * 关页。每页都能关,最后一页不能关;关掉的是当前页就切到左边那页(它在最左就切到右边那页)。
 * 主页的对话 store 是随项目存取的那一份、不销毁,关它时清空,免得隐形地留着一段没人看的对话。
 */
export function closeTab(id: string): void {
  if (!canCloseTab(id)) return;
  const idx = state.tabs.findIndex((t) => t.id === id);
  const tabs = state.tabs.filter((t) => t.id !== id);
  const activeId = state.activeId === id ? tabs[Math.max(0, idx - 1)].id : state.activeId;
  if (id === MAIN_TAB) getChatStore(MAIN_TAB).replace([]);
  else dropChatStore(id);
  commit({ tabs, activeId });
}

export function activateTab(id: string): void {
  if (state.activeId === id || !state.tabs.some((t) => t.id === id)) return;
  commit({ ...state, activeId: id });
}

export function setTabConversation(id: string, conversationId: string | null): void {
  const t = state.tabs.find((x) => x.id === id);
  if (!t || t.conversationId === conversationId) return;
  patchTab(id, { conversationId });
}

export function setTabBusy(id: string, busy: boolean): void {
  const t = state.tabs.find((x) => x.id === id);
  if (!t || t.busy === busy) return;
  patchTab(id, { busy });
}

/** 这一页单独设创造力等级;null = 回到跟项目 */
export function setTabCreativity(id: string, creativity: CreativityLevel | null): void {
  const t = state.tabs.find((x) => x.id === id);
  const next = normalizeCreativity(creativity);
  if (!t || t.creativity === next) return;
  patchTab(id, { creativity: next });
}

export function getTabCreativity(id: string): CreativityLevel | null {
  return state.tabs.find((x) => x.id === id)?.creativity ?? null;
}

export function setTabUnread(id: string, unread: number): void {
  const t = state.tabs.find((x) => x.id === id);
  if (!t || t.unread === unread) return;
  patchTab(id, { unread });
}

/** Agent 声明了范围:页签名字跟着改,好让用户一眼看出哪页在改哪儿 */
export function setScopeByConversation(conversationId: string, scope: string | null): AgentTab | null {
  const t = state.tabs.find((x) => x.conversationId === conversationId);
  if (!t) return null;
  const idx = state.tabs.indexOf(t);
  if (t.scope === scope) return t;
  // 子 Agent 的页签名以角色名打头,声明了范围再接上范围
  const base = t.roleName ? (t.title.startsWith(t.roleName) ? t.title.split(" · ")[0] : t.roleName) : null;
  patchTab(t.id, { scope, title: base ? (scope ? `${base} · ${scope}` : base) : scope || `Agent ${t.num ?? idx + 1}` });
  return state.tabs.find((x) => x.id === t.id) ?? null;
}

export function findTabByConversation(conversationId: string): AgentTab | null {
  return state.tabs.find((x) => x.conversationId === conversationId) ?? null;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useAgentTabs(): TabsState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function subscribeTabs(fn: () => void): () => void {
  return subscribe(fn);
}
