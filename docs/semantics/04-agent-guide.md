# Agent 指南

本文写给修改本仓库的 coding agent（Claude Code、Codex、Antigravity 等）。软件里帮用户剪辑的 Agent 不适用本文。细节在 `agent/` 分册，分册从属于本文。

## 原则

1. **协作闭环。** 每个任务按「对齐 → 执行 → 验证 → 汇报 → 用户决定」走完一圈，不跳环节。任务由用户确认结束，Agent 不自行宣布完成。
2. **语义优先。** `docs/semantics/` 里已确定的语义高于现有代码。代码与语义冲突时按语义改，并告诉用户冲突在哪、改了什么。语义未定的地方不自行决定，要问用户。
3. **基线始终全绿。** 进入 main 的代码任何时候都必须通过基线验证。
4. **main 由用户把关。** 写 main 的操作（提交、合并、推送、改写历史）必须先得到用户授权。其它分支不受限。
5. **规则唯一。** 本仓库的规则只写在本文和 `agent/` 分册里。发现别处有重复或冲突的规则，以本文为准，并告诉用户。

## 按任务读哪些语义

不需要通读 `docs/semantics/`，按改动范围读下表里的文件（路径相对于 `docs/semantics/`）。拿不准改动属于哪一块时，读 `02-architecture.md` 的角色表判断。

| 改动范围 | 先读 |
|---|---|
| 渲染、舞台、预渲染、导出（`src/render/`、`server/bakery/`、`server/frame-*`） | `architecture/rendering.md`、`architecture/cards.md` |
| 卡片、部件（`src/cards/`、`src/parts/`） | `architecture/cards.md` |
| 项目数据、时间轴、效果库（`src/kernel/`、`src/store/`） | `architecture/project-model.md` |
| 编辑界面（`src/editor/`） | `03-user-workflow.md`、`workflow/editing.md` |
| Agent 与工具（`src/ai/`、`src/mcp/`、`server/tools/`、`server/runners/`、`server/harness/`） | `architecture/agent.md`、`workflow/production.md` |
| 素材导入、感知类工具（`server/vite-plugin-media.ts` 等、`python/`） | `workflow/materials.md`、`architecture/asset-storage.md` |
| 文档服务、云端、协作 | `architecture/document-service.md`、`architecture/asset-storage.md` |
| 桌面壳、平台差异（`desktop/`） | `architecture/platforms.md` |
| 产品方向或架构本身 | `01-product-purpose.md`、`02-architecture.md` |
| 遇到不认识的术语 | `00-glossary.md`，只查那一条 |

## 工作流程

### 对齐

- 动手前和用户确认：做什么、做不做得到、做完是什么样。
- 可行性没把握时，先用实验或探针验证，再定方案。
- 以下情况先 dry run，用户确认后再动：改语义文档；改对外接口或数据格式；删除文件、数据或功能；影响面超过一个模块。
- 用户用 `/goal` 设定完成条件时，该条件就是这次任务的验收标准。
- 判定是否达成的是另一个模型，它只读对话、不自己运行命令，所以验证的证据（测试输出、探针结果、看过的图）必须直接出现在对话里。
- `/goal` 判定达成，只代表执行和验证这一段完成。汇报和用户决定照常进行，写 main 仍须授权。

### 执行

- 会让基线变红的改动（代码、测试、构建配置、依赖，以及运行时或脚本会读的文件）一律在专用 worktree 里做，一个任务一个 worktree、一个分支。
- 不会让基线变红、且和用户逐句确认的纯文档改动，可以在主工作区里改。
- 在 worktree 分支上早提交、勤提交。

### 验证

两件事都成立才算完成：

1. **任务完成**：对照对齐时定下的内容（以及 goal）逐项核对。
2. **基线全绿**：类型检查零错误；全量测试通过；涉及渲染的改动看图或跑探针；导出像素基线不变，要变须事先和用户确认。基线的组成和跑法见 `agent/verification.md`。

任务涉及发版时，按 `agent/git-and-release.md` 改版本号；构建在提交之后进行。

验证没通过时：改动提交在 worktree 分支上保留，不回滚、不删 worktree；告诉用户哪一项没过、为什么，由用户决定下一步。

### 汇报

- 做了什么；验证结果和证据；与对齐时不一致的地方；发现的语义冲突。
- 列清需要用户决定的事：合并、返工，还是放弃。

## 约束

- **分层**：kernel ← render ← editor / mcp / ai，下层不引用上层，守门测试会拦。
- **卡片**：卡片代码遵守 `server/card-authoring-guide.md` 里的硬约束。
- **用词**：文档和注释里说「预渲染」「生成快照」，不说「烘焙」「冻结」。代码标识符不受限。
- **不碰用户在跑的东西**：用户常驻的编辑器、桌面版的运行时副本、用户数据目录只读不写；不结束不是自己启动的进程。
- **安装要问**：新增依赖、安装系统软件之前，先得到用户同意。
- **本机信息不进仓库**：只和这台机器有关的环境信息（磁盘、本机工具的怪癖、账号与密钥的位置）写在 `docs/local.md`。该文件不入库，可能不存在。
