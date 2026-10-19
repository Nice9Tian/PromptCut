/**
 * 一个项目（同一账号、同一服务地址）的云端对话列表，页面里只有一份。没有 React，Node 里有单测(`history-store.test.mjs`)。
 *
 * 原来每个 Agent 分页各起一个每 3 秒读一次的轮询，另外换对话、发出第一条、切权限后各自再读一次：
 * 两个分页开着时约 2 分钟读了 39 次（2026-10-19 生产环境实测），而且每个分页都要等自己那一次读回来，才把输入框放开。
 * 现在同一个项目只有一份列表、一个轮询（`subscribe` 的人都走了就停）；同时只有一次在途，别人要读时等这一次的结果；
 * 刚读回来不到 `freshMs` 的不再读。读到过一次以后 `loaded` 为真，分页打开时直接拿来判断这段对话是谁的、是不是只读。
 *
 * 列表只是界面的显示与开关依据；发消息、切权限、停止、删除在服务端按账号逐次核对，不因为这里读得早而放宽。
 */
import { createPoller, type Poller } from "./poll.ts";
import type { CloudChatItem } from "./types.ts";

export interface CloudHistorySnapshot {
  items: CloudChatItem[];
  /** 读到过至少一次 */
  loaded: boolean;
  /** 最近一次读回来的时刻（毫秒）；没读到过是 0 */
  loadedAt: number;
}

export interface CloudHistoryEntry {
  get(): CloudHistorySnapshot;
  /** 读一次；同时只有一次在途，`maxAgeMs` 内读回来过的直接用（缺省总是读）。成功回 true；失败抛出（`silent` 时不抛、回 false 并记在 `lastError`） */
  refresh(o?: { maxAgeMs?: number; silent?: boolean }): Promise<boolean>;
  lastError(): unknown;
  /** 订阅变化；第一个订阅者到了就起轮询，最后一个走了就停 */
  subscribe(fn: () => void): () => void;
  /** 立刻读一次（回到前台、有人删了对话） */
  kick(): void;
  /** 还有人订阅着 */
  active(): boolean;
}

export interface CloudHistoryDeps {
  list: () => Promise<CloudChatItem[]>;
  /** 后台轮询间隔；0 = 不轮询，只在调用 refresh 时读 */
  pollMs: number;
  /** 后台轮询读失败时：回 "stop" 就不再轮询（登录失效） */
  onPollError?: (err: unknown) => "stop" | void;
  now?: () => number;
  createPoller?: typeof createPoller;
}

const entries = new Map<string, { entry: CloudHistoryEntry; deps: CloudHistoryDeps }>();

export function createCloudHistory(deps: CloudHistoryDeps): CloudHistoryEntry {
  const now = deps.now ?? Date.now;
  let snap: CloudHistorySnapshot = { items: [], loaded: false, loadedAt: 0 };
  let inflight: Promise<boolean> | null = null;
  let error: unknown = null;
  const listeners = new Set<() => void>();
  let poller: Poller | null = null;

  const publish = (next: CloudHistorySnapshot) => { snap = next; for (const l of [...listeners]) l(); };

  function load(): Promise<boolean> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const items = await deps.list();
        error = null;
        // 没变就沿用原数组，订阅者不白白重绘
        const same = snap.loaded && JSON.stringify(snap.items) === JSON.stringify(items);
        publish({ items: same ? snap.items : items, loaded: true, loadedAt: now() });
        return true;
      } catch (err) {
        error = err;
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  const entry: CloudHistoryEntry = {
    get: () => snap,
    async refresh(o = {}) {
      if (o.maxAgeMs !== undefined && snap.loaded && now() - snap.loadedAt <= o.maxAgeMs && !inflight) return true;
      if (!o.silent) return load();
      try { return await load(); } catch { return false; }
    },
    lastError: () => error,
    subscribe(fn) {
      listeners.add(fn);
      if (!poller && deps.pollMs > 0) {
        poller = (deps.createPoller ?? createPoller)({ baseMs: deps.pollMs, run: async () => {
          try { await load(); }
          catch (err) { if (deps.onPollError?.(err) === "stop") return "stop"; throw err; }
        } });
        poller.start();
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size && poller) { poller.stop(); poller = null; }
      };
    },
    kick() { poller?.kick(); },
    active: () => listeners.size > 0,
  };
  return entry;
}

/** 按键（项目、服务地址、账号范围、身份版本）取这一份；没有就建。`deps` 只在建的时候用 */
export function cloudHistoryFor(key: string, deps: () => CloudHistoryDeps): CloudHistoryEntry {
  let hit = entries.get(key);
  if (!hit) {
    const d = deps();
    hit = { entry: createCloudHistory(d), deps: d };
    entries.set(key, hit);
    // 只留最近的几份（换账号、换项目留下的旧键不再有人订阅）
    if (entries.size > 8) for (const [k, v] of [...entries]) { if (entries.size <= 8) break; if (k !== key && !v.entry.active()) entries.delete(k); }
  }
  return hit.entry;
}

/** 单测用 */
export function _resetCloudHistories(): void { entries.clear(); }
