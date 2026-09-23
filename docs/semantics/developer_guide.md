# 开发者指南

给修改本仓库的开发者（人或 coding agent）的索引。规则本身在 `guide_files/` 里。

## 文件

| 文件 | 管什么 |
|---|---|
| `guide_files/suggested_agent_behavior.md` | 协作闭环：原则，以及对齐、执行、验证、汇报的工作流程 |
| `guide_files/constraints.md` | 改代码时必须守的硬性约束 |
| `guide_files/verification.md` | 基线由哪几项组成、什么改动必跑哪项、验证环境 |
| `guide_files/multi_agent.md` | 用了子 Agent 之后的协议 |
| `guide_files/git_and_release.md` | 提交、合并、构建、版本号 |

## 按任务读哪些语义

不需要通读 `docs/semantics/`，按改动范围读下表里的文件（路径相对于 `docs/semantics/`）。拿不准改动属于哪一块时，读 `architecture.md` 的角色表判断。

| 改动范围 | 先读 |
|---|---|
| 渲染、舞台、预渲染、导出（`src/render/`、`server/bakery/`、`server/frame-*`） | `architecture/rendering.md`、`architecture/cards.md` |
| 卡片、部件（`src/cards/`、`src/parts/`） | `architecture/cards.md` |
| 项目数据、时间轴、效果库（`src/kernel/`、`src/store/`） | `architecture/project-model.md` |
| 编辑界面（`src/editor/`） | `user-workflow.md`、`workflow/editing.md` |
| Agent 与工具（`src/ai/`、`src/mcp/`、`server/tools/`、`server/runners/`、`server/harness/`） | `architecture/agent.md`、`workflow/production.md` |
| 素材导入、感知类工具（`server/vite-plugin-media.ts` 等、`python/`） | `workflow/materials.md`、`architecture/asset-storage.md` |
| 文档服务、云端、协作 | `architecture/document-service.md`、`architecture/asset-storage.md` |
| 桌面壳、平台差异（`desktop/`） | `architecture/platforms.md` |
| 产品方向或架构本身 | `product-purpose.md`、`architecture.md` |
| 遇到不认识的术语 | `glossary.md`，只查那一条 |
