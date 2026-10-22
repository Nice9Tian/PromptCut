/**
 * 编辑界面的「只读」：这个项目只给了只读权限（游客进别人的项目就是这样，2026-10-23 用户定）时，
 * 改项目的控件置灰并说明原因，而不是让人点了才被服务端拒、看到一串莫名其妙的错误。
 *
 * 判断只来自 `io/viewOnly.ts` 的 `viewOnlyReason()`，这里不另存一份：
 *   - `'read-only-member'`：这个项目没给你写的权限。**本文件管的就是这一种**；
 *   - `'observe'`（`?observe=1` 打开的只读查看页）：它原来怎么处理还怎么处理（保存按钮禁用、顶栏徽标），不并进这里，
 *     所以这里的函数在 observe 下一律回「没锁」。
 *
 * 只读不等于看不了：播放、预览、翻时间轴、选中片段看它的参数、读 Agent 对话历史、导出，都照常。
 * 导出为什么放开：导出只读项目、把成片写到本机，不改项目，也不碰云端的项目文档。
 *
 * 这不是权限，是让界面别让人白做一遍：真正拦住写的是服务端（`server/account/authority.mjs`、
 * `server/docservice/modules/project.mjs`），这一份被绕过去也改不动云端的项目。
 *
 * 组件里用 `useReadOnly()`（权限变化时重渲）；不在组件里的处理函数用 `readOnlyCore.ts` 的 `memberReadOnlyNow()`。
 * 禁用的控件挂 `ro.why` 当悬停说明——那一句永远是 `viewOnlyText()`，各处不自己编。
 */
import { useSync } from "./sync/syncManager";
import { memberReadOnlyNow, readOnlyState, type ReadOnlyState } from "./readOnlyCore";

export { memberReadOnlyNow, readOnlyState, blockedByReadOnly, type ReadOnlyState } from "./readOnlyCore";

/**
 * 组件里读只读状态。权限是 `syncManager` 进 / 退项目时拨的（`setProjectAccess`），
 * 它每次更新同步状态都会通知订阅方，所以这里订阅同步状态、读出来的是布尔值，权限不变就不重渲。
 */
export function useReadOnly(): ReadOnlyState {
  const locked = useSync(() => memberReadOnlyNow());
  return readOnlyState(locked);
}

/** 只要布尔值的地方 */
export function useMemberReadOnly(): boolean {
  return useSync(() => memberReadOnlyNow());
}
