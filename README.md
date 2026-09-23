# PromptCut

PromptCut 是一个 AI 视频剪辑工作台：用户用自然语言指挥 Agent 完成视频剪辑，也可以自己动手剪辑、调整参数，两者可以并行。

## 文档

| 想了解 | 看这里 |
|---|---|
| 产品为什么存在、要达到什么 | [docs/semantics/product-purpose.md](docs/semantics/product-purpose.md) |
| 系统由哪几部分组成 | [docs/semantics/architecture.md](docs/semantics/architecture.md)，细节在 [architecture/](docs/semantics/architecture/) |
| 用户怎么用 | [docs/semantics/user-workflow.md](docs/semantics/user-workflow.md)，细节在 [workflow/](docs/semantics/workflow/) |
| 术语 | [docs/semantics/glossary.md](docs/semantics/glossary.md) |
| 为什么这样设计 | [docs/rationale/](docs/rationale/) |
| 排障、对账等操作知识 | [docs/guides/](docs/guides/) |
| 还没做完的事 | [docs/plan/TODO.md](docs/plan/TODO.md) |
| 旧文档（历史资料） | [docs/archive/](docs/archive/) |

## 开发

- 给 coding agent 的规则在 [docs/semantics/agent-guide.md](docs/semantics/agent-guide.md)，入口是 [AGENTS.md](AGENTS.md)。
- 本地起编辑器：`npm run dev`；测试：`npm test`；构建：`npm run build`。
- 桌面版的构建和发版见 [desktop/README.md](desktop/README.md)。
