import type { ChatMessage } from "./types";
import { getScript, setScript } from "./script";
import { getMessages, messagesForSave, replaceMessages } from "./liveChat";

/**
 * 随项目一起存取的 AI 状态:剧本 + 这段对话。
 *
 * 它和 `project` 平级放在 .proc 里,而不是塞进 Project 对象内部 ——
 * Project 会被 `get_project` 原样返回给模型,把整段对话history 放进去
 * 等于每次调用都把自己说过的话再读一遍,又贵又容易绕。
 *
 * 「每个项目一份对话」就是这么来的:打开哪个 .proc,就灌回哪一份。
 */
export interface ProjectAi {
  /** 剧本;空串表示没写 */
  script: string;
  /** 可见对话(不含执行轨迹,见 liveChat.messagesForSave) */
  messages: ChatMessage[];
}

export function collectProjectAi(): ProjectAi {
  return { script: getScript(), messages: messagesForSave() };
}

/**
 * 灌回一份 AI 状态。传 null / undefined(旧的 .proc 没有这一段)就清空 ——
 * 打开一个没有对话记录的项目,不该看到上一个项目的对话。
 */
export function applyProjectAi(ai: unknown): void {
  const src = (ai && typeof ai === "object" ? ai : {}) as Partial<ProjectAi>;
  setScript(typeof src.script === "string" ? src.script : "");
  replaceMessages(src.messages);
}

/** 新建项目:两样都清空 */
export function resetProjectAi(): void {
  applyProjectAi(null);
}

/** 有没有值得存的东西,用来决定 .proc 里要不要写这一段 */
export function hasProjectAi(): boolean {
  return getScript().trim() !== "" || getMessages().length > 0;
}
