import { useSyncExternalStore } from "react";
import type { ChatMessage } from "./types";

/**
 * 当前项目正在进行的这段 AI 对话。
 *
 * (和 chatStore.ts 不是一回事:那个管的是服务端的历史会话归档,
 *  这里管的是「此刻屏幕上这一段」。)
 *
 * 以前它是 useAiChat 里的一个 useState,并按 provider 存进 localStorage
 * (`aiChat:claude`)—— 那意味着对话跟着「用哪个模型」走、跨项目共用同一份,
 * 打开另一个项目还接着上一个项目的话。但对话其实是**项目的一部分**:
 * 它记录的正是这条片子怎么做出来的。
 *
 * 所以挪成模块级 store:组件外也读得到(存 .proc 要收集、打开 .proc 要灌回),
 * 并且随项目整体换掉。
 */

let messages: ChatMessage[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getMessages(): ChatMessage[] {
  return messages;
}

/** 和 React 的 setState 一样,支持直接给值或给更新函数 */
export function setMessages(next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) {
  const value = typeof next === "function" ? next(messages) : next;
  if (value === messages) return;
  messages = value;
  emit();
}

/** 换项目 / 新建项目时整体换掉 */
export function replaceMessages(next: unknown) {
  messages = Array.isArray(next) ? (next as ChatMessage[]) : [];
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useChatMessages(): ChatMessage[] {
  return useSyncExternalStore(subscribe, getMessages, getMessages);
}

/**
 * 存进 .proc 的那一份。
 *
 * 只留可见对话和工具调用摘要:执行轨迹(trace)体积很大而且只对当场排查有用,
 * 没跑完的消息(pending)存下来也复原不了,一并去掉。
 * 条数封顶,免得一个长项目把 .proc 撑到几十兆。
 */
export function messagesForSave(limit = 100): ChatMessage[] {
  return messages
    .filter((m) => !m.pending)
    .slice(-limit)
    .map(({ trace, traceBytes, traceTruncated, ...rest }) => rest);
}
