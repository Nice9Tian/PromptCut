# MCP Editor API (`src/mcp`)

**最后重构日期：** 2026-09-19

## 重构说明 (Refactoring Note)
如果你是之前的维护者，你会发现原本巨大的 `src/editor/right/index.tsx` 被大幅度精简了。
过去，超过 100 个供 MCP Server 调用的 `EditorApi` 工具逻辑被硬编码在 `RightPanel` 的 `useEffect` 中，这导致该文件极度臃肿（超过 125KB），极大地增加了 AI 辅助编程时的 Token 消耗。

因此，我们进行了**彻底的架构解耦**：
1. **解耦 UI 与 AI API：** 所有的 MCP 工具实现逻辑都被抽离到了当前的 `src/mcp/` 目录下。
2. **状态与帮助函数提取：** 工具所依赖的闭包状态（如 `sttJobs`, `cardScopes`）和通用帮助函数被提取到了 `common.ts`。
3. **领域化打散：** 105 个庞大的工具对象被切分为 13 个独立的文件（位于 `handlers/` 目录下）。

## 文件结构

- **`api.ts`**: 聚合层。它导入 `handlers/` 下的所有子模块，拼装成完整的 `editorApi` 对象。UI 层的 `index.tsx` 只需 `import { editorApi } from "../../mcp/api"` 并将其挂载。
- **`common.ts`**: 原本在 `index.tsx` 里的所有纯函数、状态变量及外部 import。各个 handler 都从这里引入公用依赖。
- **`handlers/*.ts`**: 具体工具分类实现。例如 `vision.ts` 处理看图和排版，`audio.ts` 处理声音相关逻辑。若你需要新增或修改某个 MCP 工具，只需在对应的 handler 文件里修改即可，不再需要阅读几千行的无关代码。
