# PromptCut

PromptCut 是一个 AI 视频剪辑工作台：用户用自然语言指挥 Agent 完成视频剪辑，也可以自己动手剪辑、调整参数，两者可以并行。

## 文档

| 想了解 | 看这里 |
|---|---|
| 产品为什么存在、要达到什么 | [docs/semantics/product-purpose.md](docs/semantics/product-purpose.md) |
| 系统由哪几部分组成 | [docs/semantics/architecture.md](docs/semantics/architecture.md)，产品功能在 [product/](docs/semantics/product/)，具体机制在 [mechanism/](docs/semantics/mechanism/) |
| 用户怎么用 | [docs/semantics/user-workflow.md](docs/semantics/user-workflow.md)，细节在 [workflow/](docs/semantics/workflow/) |
| 术语 | [docs/semantics/glossary.md](docs/semantics/glossary.md) |
| 为什么这样设计 | [docs/rationale/](docs/rationale/) |
| 排障、对账等操作知识 | [docs/guides/](docs/guides/) |
| 还没做完的事 | [docs/plan/TODO.md](docs/plan/TODO.md) |
| 旧文档（历史资料） | [docs/archive/](docs/archive/) |

## 开发

- 语义库的读法、按改动范围该读哪几份，见 [docs/semantics/README.md](docs/semantics/README.md)。约束、验证、发版三份规则在 [docs/semantics/guide_files/](docs/semantics/guide_files/)。
- 本地起编辑器：`npm run dev`；测试：`npm test`；构建：`npm run build`。
- 桌面版的构建和发版见 [desktop/README.md](desktop/README.md)。

## 给 coding agent 的入口

本仓库**不放** `AGENTS.md` 和 `CLAUDE.md`：这两个文件会被各家工具无条件注入上下文，把本项目的协作习惯塞进别人的 Agent。需要的话自己在工作副本里建一份，内容照抄下面这段就够，别提交（`.gitignore` 已挡掉）：

````markdown
# PromptCut

AI 视频剪辑工作台。改这个仓库之前先知道这几件事：

- 语义库在 `docs/semantics/`：产品承诺在 `product/`，实现机制在 `mechanism/`，用户流程在 `workflow/`。语义与代码冲突时以语义为准。
- 硬约束在 `docs/semantics/guide_files/constraints.md`，必须守。其中分层是 kernel ← render ← editor / mcp / ai，下层不引用上层，守门测试会拦。
- 怎么验证、什么改动必跑哪一项，在 `docs/semantics/guide_files/verification.md`。
- 提交、合并、发版、版本号规则在 `docs/semantics/guide_files/git_and_release.md`。
- 按改动范围该读哪几份语义，见 `docs/semantics/README.md`。
- 只和本机有关的环境信息在 `docs/local.md`（不入库，可能不存在）。
````
