/**
 * 在线构建时嵌进页面的代码版本(C10 契约第 7 节;主会话 2026-09-28 的补充约束):用渲染节点同一套算法
 * (`server/frame-code.mjs` 的 `frameCode`,换行统一成 LF)在构建时算出,由 `vite.config.ts` 的在线构建以 `__PC_CODE_VERSION__` 注入。
 * 页面发布的清单计划写进 `requires.codeVersion`:代码版本不同的节点不认领(语义 `product/platforms.md`「渲染节点」:
 * 节点渲染用的代码与发布方一致)。开发构建、桌面构建、Node 单测里没有它,为 null(不写,靠层表对不上当没有兜底)。
 */
declare const __PC_CODE_VERSION__: string | undefined;

export const CODE_VERSION: string | null = typeof __PC_CODE_VERSION__ === "string" && __PC_CODE_VERSION__ ? __PC_CODE_VERSION__ : null;
