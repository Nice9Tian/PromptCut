/**
 * 「分工模式」这一个开关。
 *
 * 单独一个模块，而不是塞进 useAiChat —— 编排器和界面都要读它，而这两边是
 * 两个人在并行写。放进 useAiChat 就意味着两边抢同一个文件；放这里，
 * 两边都只是 import，谁都不用改对方的代码。
 *
 * 是长期偏好，所以落 localStorage：用户勾上之后不该每次开软件都要重勾。
 */

const KEY = "aiTeamMode";

type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // 隐私模式 / 禁用了站点数据时读不到,按关闭算
    return false;
  }
}

let current = read();

/** 当前开着没有 */
export function isTeamMode(): boolean {
  return current;
}

export function setTeamMode(on: boolean): void {
  if (on === current) return;
  current = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // 存不下也让本次会话生效,不要因为存储不可用就把开关卡住
  }
  for (const l of listeners) l(on);
}

/** 订阅变化。返回退订函数。 */
export function subscribeTeamMode(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
