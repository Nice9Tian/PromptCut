/**
 * 无头实例在页面里的那一小截。
 *
 * scripts/headless.mjs 用 puppeteer 开着这张编辑器页面,每秒调一次
 * `window.__pcHeadless.flush()`:项目脏了就把它写回当前草稿(也就是任务目录里的
 * project.proc)。agent 通过 MCP / pc-tool 改项目,改动落盘不需要它自己操心保存。
 *
 * 只在 URL 带 `?headless=1` 时装上,普通用户的页面不会多出这个全局。
 */
import { getState, actions } from "./store/project";
import { getActiveDraftId, saveDraft } from "./editor/io/drafts";

export interface HeadlessStatus {
  dirty: boolean;
  /** 这一轮有没有真的写盘 */
  saved: boolean;
  savedAt: string | null;
  name: string;
  clips: number;
  error?: string;
}

declare global {
  interface Window {
    __pcHeadless?: { flush(): Promise<HeadlessStatus>; status(): HeadlessStatus };
  }
}

let lastSavedAt: string | null = null;

function snapshot(): HeadlessStatus {
  const s = getState();
  return {
    dirty: s.dirty,
    saved: false,
    savedAt: lastSavedAt,
    name: s.project.name,
    clips: s.project.tracks.reduce((n, t) => n + t.clips.length, 0),
  };
}

export function installHeadlessHooks(): void {
  window.__pcHeadless = {
    status: snapshot,
    async flush() {
      const s = getState();
      if (!s.dirty) return snapshot();
      const id = getActiveDraftId();
      if (!id) return { ...snapshot(), error: "没有激活的草稿,不知道该写到哪个文件" };
      try {
        await saveDraft(id);
        // markSaved 只清脏标记,不动撤销栈 —— agent 那边看到的 undo 历史照旧
        actions.markSaved(getState().filePath);
        lastSavedAt = new Date().toISOString();
        return { ...snapshot(), saved: true };
      } catch (e) {
        return { ...snapshot(), error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
