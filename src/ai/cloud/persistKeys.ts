/**
 * 云端对话在浏览器本地存储里的几个键。没有 React，Node 里有单测(`persist-keys.test.mjs`)。
 *
 * 「这个项目这一页上次看的对话」「还没发过消息的新对话」「对话标题」在账号模式下按**账号编号**分，不按账号范围里的绑定版本分：
 * 绑定版本(`consent.ts` 的 bindingVersion)是这张页面内存里的计数，进出项目、登录变化各加一，刷新页面后从头数。
 * 原来拿它拼键，刷新后（或建完项目再进来）数到的不是同一个数，就找不到上次的对话，面板退成一个空的新对话
 * （2026-10-19 生产环境实测：重开项目后面板是新对话，要从历史里手动找回）。
 * 本地存储里只是「上次看的是哪一个」的指针；能不能读这个对话由服务端每次核对。
 */

type Storageish = Pick<Storage, "getItem"> & { readonly length: number; key(index: number): string | null };

/** 本地存储的键用的账号段：账号模式是账号编号（没有时 "none"），旧通道（不分账号）是空串 */
export const persistScopeOf = (accountMode: boolean, accountId: string | null): string => (accountMode ? accountId ?? "none" : "");

export const chatKey = (projectId: string, tabId: string, scope = "") => scope
  ? `pc.cloudChat:${scope}:${projectId}:${tabId}` : `pc.cloudChat:${projectId}:${tabId}`;
/** 这一页上「刚建的、还没发过消息」的新对话的 id(服务端还没有它;发出第一条消息后清掉)。刷新页面后靠它认出这仍是新对话 */
export const freshKey = (projectId: string, tabId: string, scope = "") => scope
  ? `pc.cloudFresh:${scope}:${projectId}:${tabId}` : `pc.cloudFresh:${projectId}:${tabId}`;
export const titlesKey = (projectId: string, scope = "") => scope
  ? `pc.cloudTitles:${scope}:${projectId}` : `pc.cloudTitles:${projectId}`;

/**
 * 旧版本按「账号编号:绑定版本」记的「上次看的对话」：新键还没有时找一次（只认这个账号、这个项目、这一页的；
 * 有好几个时取绑定版本最大的那个，那是旧版本里最后写的）。找不到回 null。
 */
export function legacyCloudChatId(storage: Storageish | null, projectId: string, tabId: string, accountId: string): string | null {
  if (!storage) return null;
  try {
    const head = `pc.cloudChat:${accountId}:`, tail = `:${projectId}:${tabId}`;
    let best: { version: number; value: string } | null = null;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(head) || !k.endsWith(tail)) continue;
      const middle = k.slice(head.length, k.length - tail.length);
      if (!/^\d+$/.test(middle)) continue;
      const value = storage.getItem(k);
      if (value && (!best || Number(middle) > best.version)) best = { version: Number(middle), value };
    }
    return best?.value ?? null;
  } catch {
    return null;
  }
}
