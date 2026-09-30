# AGENT-query-render 报告

分支 `claude/query-render`，worktree `.worktrees/query-render`，起点 main `d23d97cf`。

任务：查询渲染（按 Agent 要求渲染画面、供 Agent 观察）的两处差距——G1 用户在 AI 栏点开的操作预览不占 Agent 专用实例、插到普通预渲染待办之前；G2 Agent 专用实例空闲时接普通预渲染；搭车 G3 Tailwind 扫描源。

## 1. 差距清单

对照的语义：`product/rendering.md` 第 64、65 行（「Agent 优先只是插队」「AI 栏的操作预览可以插队」），`mechanism/rendering.md`「查询渲染与预渲染进程」（三种模式；「Agent 优先只是插队」一条），`architecture.md` 第 13、43 行，`workflow/editing.md` 第 15 行，`product/agent.md` 第 14 行。行号是起点 `d23d97cf` 上的。

| # | 语义 | 现状 | 证据 |
|---|---|---|---|
| D1 | Agent 的请求只在一个专用渲染实例里走 | **做到**。`see_frames` 的 agent 批、`layout`、`entityRects`、`/api/cards/dom` 都经 `runAgentTask` 排同一条链、借同一个 `'agent'` 预渲染间 | `server/frame-pipeline.mjs:495-511`（`runAgentTask`）、`:843-846`、`:2814`、`:2866` |
| D2 | 不提高进程优先级 | **做到**。代码里没有 `os.setPriority`，Agent 与预渲染同一个进程 | 全仓 grep 无 `setPriority` |
| D3 | 专用实例不打断正在跑的任务 | **做到**（链式串行，任务之间不抢） | `:498` 的 `laneChains.get('agent')…then` |
| D4 | 专用实例每做完一个任务先从 Agent 队列按先后取下一个 | **只做到一半**：链里除了 Agent 的请求，还混着不是 Agent 的活——3D 视图的空闲贴图预取（`/api/vision/bake-batch`，优先级 0）、用户在 AI 栏点开的动图（见 D7）都进同一条链，FIFO 排。所以 Agent 请求**会排在已在链里的预渲染 / 用户预览后面**，违反「Agent 任务永远不排在排队中的预渲染任务后面」 | `server/vision/render.ts:135` 写死 `lane: "agent"`；`server/vision/bake.ts:310`、`:377` 经它；`server/vision/routes.ts:546`（bake-batch）；`src/editor/preview/useBakePrefetch.ts:414`（调用方） |
| D5 | Agent 队列空时专用实例接普通预渲染任务 | **没做**。Agent lane 空闲只起 10 分钟的关闭计时器，不接任何预渲染 | `server/frame-pipeline.mjs:783-795`（`release`，`agent` 走 `AGENT_IDLE_MS`） |
| D6 | 专用实例永远不占用别的实例 | **做到**。Agent 的活只借 `'agent'` 那一个预渲染间 | `:500-505` |
| D7 | AI 栏的操作预览由用户触发，不占用 Agent 的专用实例 | **没做到，且相反**。用户点开动图的 `GET /api/ai/visual/gif/<key>.gif` → `ensureGif(key, 0)` → `renderFrames` → `see_frames(…, { lane: "agent" })` → `runAgentTask`：正是在 Agent 的专用实例上渲 | `server/vision/routes.ts:279`、`:244`；`server/vision/render.ts:135` |
| D8 | AI 栏的操作预览排到普通预渲染队列所有待办之前、不打断正在跑的那一批 | **没做**。它走 vision 的优先级队列（`render-queue.ts` 的 `enqueue`，优先级 0 = 与空闲预渲染同级、导出期间整个暂停），再落到 Agent 链尾；和 `FramePipeline` 的预渲染队列（`'background'` 链、`'queue'` lane）不是同一个队列，插不到它们前面 | `server/vision/routes.ts:244`；`server/vision/render-queue.ts:92-97`（优先级 0 在导出期间 break）、`:130-133` |
| D9 | 模型自己要的动图（`get_gif` 的 `/render`）与 `see_frames` 走 Agent 专用实例 | **做到** | `server/vision/routes.ts:306`（`ensureGif(key, 1)`）、`:420`、`:453` |
| D10 | 预渲染进程三种模式（Agent / User / Full） | **没做**（不在本任务范围，只记录）。代码里没有 `PROMPTCUT_PRERENDER_MODE`，预渲染进程总是三条 lane 都建，相当于一直是 Full 模式；Agent 模式（云端只查询）与 User 模式（不建 Agent lane）都不存在 | 全仓 grep 无 `PRERENDER_MODE`；`docs/plan/cloud-task.md` I1、I4 |
| D11 | 编辑器进程没有 Agent lane；用户交互需要的查询在用户自己的后台舞台上算 | **做到** | `server/frame-pipeline.mjs:476-481`（`laneRefused`），`server/test/agent-lane.test.mjs` 第 2 个用例 |
| D12 | 查询渲染的结果从渲染所在的位置直接回传给 Agent，不经素材服务 | **做到**（`/api/vision/snapshot` 直接回图） | `server/vision/routes.ts:355-460` |
| D13 | AI 栏显示操作详细预览：看过的图、改动前后的动图、参数差异 | **做到**（界面层） | `src/editor/right/chat/OpDetailPreview.tsx`、`src/editor/right/ToolVisual.tsx:96-132`；`server/vision/routes.ts:318-350`（记录里的 `images` / `before` / `after` / `diff`） |

本任务修 D4、D5、D7、D8；D10 只记录。

## 进度

- [x] 差距清单
- [ ] G1
- [ ] G2
- [ ] G3
- [ ] 验证
