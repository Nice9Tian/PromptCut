/**
 * 在线浏览器模式的**运行期**标记(C10a 集成返工)。
 *
 * `mode.ts` 的 `ONLINE` 是编译期常量,但它读 `import.meta.env`,会被 Node 单测载入的模块不能静态引它
 * (守门 `src/online/modeImportGuard.test.mjs`)。这些模块要在在线页面里停掉编辑器进程的 `/api/*` 调用
 * (契约第 2 节:要么隐藏或置灰,要么走在线替代),就读这个标记:`boot.ts` 在 `ONLINE` 时、别的模块求值之前设上。
 * 桌面运行环境与 Node 单测里恒为 false。
 */
const KEY = "__pcOnlinePage";

export function onlinePage(): boolean {
  return (globalThis as Record<string, unknown>)[KEY] === true;
}

export function markOnlinePage(): void {
  (globalThis as Record<string, unknown>)[KEY] = true;
}

/** 在线浏览器模式里置灰的入口用的说明(与 `TopBar.tsx` 的 `ONLINE_OFF` 同一句) */
export const ONLINE_UNSUPPORTED = "在线浏览器模式暂不支持，请在桌面版里做";
