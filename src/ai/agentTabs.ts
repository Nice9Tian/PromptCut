import { useSyncExternalStore } from "react";
import { MAIN_TAB, dropChatStore } from "./liveChat.ts";

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
  /** Agent 用 declare_scope 声明的修改范围,如「剪辑1->序列2」 */
  scope: string | null;
  /** 正在跑(流式回复中) */
  busy: boolean;
  /** 还没送达的其他 Agent 消息数(标在页签上) */
  unread: number;
  createdAt: number;
}

interface TabsState {
  tabs: AgentTab[];
  activeId: string;
}

const STORAGE_KEY = "pc.agentTabs";
const ACTIVE_KEY = "pc.agentTabs.active";

function load(): TabsState {
  let tabs: AgentTab[] = [];
  let activeId = MAIN_TAB;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as Partial<AgentTab>[]) : [];
    tabs = arr
      .filter((t) => typeof t.id === "string" && t.id)
      .map((t, i) => ({
        id: t.id!,
        conversationId: typeof t.conversationId === "string" ? t.conversationId : null,
        title: typeof t.title === "string" && t.title ? t.title : `Agent ${i + 1}`,
        scope: typeof t.scope === "string" ? t.scope : null,
        busy: false,
        unread: 0,
        createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
      }));
    const a = localStorage.getItem(ACTIVE_KEY);
    if (a) activeId = a;
  } catch {
    /* 本地存储不可用就从一页开始 */
  }
  if (!tabs.some((t) => t.id === MAIN_TAB)) {
    tabs.unshift({ id: MAIN_TAB, conversationId: null, title: "Agent 1", scope: null, busy: false, unread: 0, createdAt: 0 });
  }
  if (!tabs.some((t) => t.id === activeId)) activeId = MAIN_TAB;
  return { tabs, activeId };
}

let state: TabsState = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(state.tabs.map(({ id, conversationId, title, scope, createdAt }) => ({ id, conversationId, title, scope, createdAt }))),
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
  const n = state.tabs.length + 1;
  const tab: AgentTab = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    conversationId: null,
    title: `Agent ${n}`,
    scope: null,
    busy: false,
    unread: 0,
    createdAt: Date.now(),
  };
  commit({ tabs: [...state.tabs, tab], activeId: tab.id });
  return tab;
}

/** 关页。主页不能关;关掉的是当前页就切到左边那页 */
export function closeTab(id: string): void {
  if (id === MAIN_TAB) return;
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  const activeId = state.activeId === id ? tabs[Math.max(0, idx - 1)].id : state.activeId;
  dropChatStore(id);
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
  patchTab(t.id, { scope, title: scope || `Agent ${idx + 1}` });
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
