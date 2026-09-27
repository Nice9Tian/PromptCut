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

/**
 * 在线浏览器模式里置灰的入口悬停时的说明(C10 契约第 10 节、第 17 节表 A):
 * 「在线浏览器模式暂不支持{入口名}，请在电脑上的 PromptCut 里使用。」
 * 入口名用用户在界面上看到的叫法(「导入媒体」「语音识别」「配音」……)。
 */
export const ONLINE_UNSUPPORTED_PREFIX = "在线浏览器模式暂不支持";
export const ONLINE_UNSUPPORTED_SUFFIX = "，请在电脑上的 PromptCut 里使用。";
export function onlineUnsupported(entry: string): string {
  return `${ONLINE_UNSUPPORTED_PREFIX}${entry}${ONLINE_UNSUPPORTED_SUFFIX}`;
}

/** 时间轴上含用户卡或图卡的片段的徽标悬停文案(语义原文,`product/platforms.md`「在线浏览器模式」) */
export const ONLINE_CUSTOM_CARD_TEXT = "该模式暂不支持自定义卡";
