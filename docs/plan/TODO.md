# TODO

还没做完的工作。未开始的计划和它们的协议全文都在本目录 `docs/plan/` 里；已做完步骤的记录归档在 `docs/archive/`。计划与 `docs/semantics/` 冲突时，以 semantics 为准。

## 未开始的计划

| 事项 | 计划文件 | 状态 |
|---|---|---|
| 轨道流：重卡在播放时贴的 alpha 视频流 | `docs/plan/r8-streams-task.md`；编码原型报告 `docs/plan/g0-b-stream-prototype.md` | 未开始，编码原型已做完 |
| 共享 WebGL 渲染器：canvas 卡共用一个 WebGL 上下文 | `docs/plan/r9-webgl-task.md` | 未开始 |
| 素材服务与文档服务（本地或远程，可任意组合部署）、产物入库、改动竞态、Agent 的查询进程、在线浏览器模式 | `docs/plan/cloud-task.md`；动工前的问题已定，见文末「已定的决议」。2026-09-24 按路线 B 改写，尚未独立审查 | 未开始 |
| 分布式预渲染：文档服务托管的拉取式渲染任务队列，本机 PC、独立渲染主机、纯浏览器认领任务 | `docs/plan/distributed-prerender-queue.md`；前置：上一行的文档服务与产物入库（A3b）；背景评估 `docs/reports/REPORT-architecture-agent-prerender.md` | 设计已审核（2026-09-24）；落地任务书 `docs/plan/TASK-distributed-prerender-queue.md`（M0～M8，M1 纯内存队列本体可先于前置动工）；M1、M2 已在分支 `claude/rq-m1-m2` 完成（报告 `docs/reports/REPORT-render-queue-m1.md`），待合并；M3 起另行下发指令 |
| 音频整体改成浏览器端 JS | `docs/plan/audio_structure_plan.md`（A0～A7）；判重测试计划 `docs/plan/audio_determine_plan.md` | 计划已写，未动工 |
| 以后再做：桌面版给只有原片的云端素材补转小版；导出页装虚拟定时器 | `docs/plan/future_planning.md` | 暂缓 |

**路线 B**（2026-09-24 用户定）：素材服务是字节的唯一读写出口，素材服务在本机时也经它，Agent 进程和预渲染进程同样只走它的 HTTP API；预渲染产物（HTML 快照、PNG、MOV、轨道流）生成后一律推送到素材服务；两个服务部署不设限、可任意组合，素材服务允许局域网跨源访问，文档服务预留连接发现 / 信令接口；第 5 步只建素材服务空壳与底层 API 契约，A1 的其余部分、A5、A3b 在第 6 步；`uploaded` 字段废除，同步状态只问素材服务；原第 8 步移交 R 系列。

## 已做步骤的遗留

- **R0**：仓库根 dev server 的冷启动量测没做。（`scripts/verify-unified-frames.mjs` 已整条通过；快照重放和整帧导出的残差查到只剩三处快照这一侧修不了的，见 `docs/archive/restructure_planning/reports/replay-mismatch-report.md` §12、§13。）
- **R7b 没做成的**：只预渲染重卡集合那一条只停了快照、没停 PNG；R7b 报告第 4 节的 8 条更正没折回 `docs/archive/restructure_planning/r2-r7-task.md`。
- **see_frames 回包附实体矩形**：原云端计划第 8 步，协议在 `docs/archive/restructure_planning/r2-r7-task.md` 的 D3，归 R 系列，可与云端计划并行推进。
- **待用户定**：播放停顿期间要不要加音频看门狗，让音频立刻停。

各步的详细状态见 `docs/archive/restructure_planning/hand_off.md`；独立复核的结论见 `docs/archive/restructure_planning/hunman_read.md`。

## 语义与代码的差距

`docs/semantics/` 已经定下、代码还没跟上的地方。按 `suggested_agent_behavior.md` 原则 2，这些都算代码要改。

- **工作方式**：去掉对话式布局；SKILL 改为桌面 APP 经 MCP 直接接入同一个项目（现在是把项目快照进独立任务目录、由无头实例改副本、最后三方合并）；关闭编辑界面转为托盘和悬浮窗后台运行。
- **Agent**：三档创造力等级（项目默认、对话可改）；主 Agent 拉起子 Agent 并附加角色，现有的分工模式归档；Agent 用 JS 自定义测量；看或改用户正在编辑的内容时返回「用户正在编辑」。
- **文档服务**：还不存在，项目的真身现在在页面里；Agent 的写操作现在经页面执行，没有经文档服务；覆盖通知覆盖方和被覆盖方都要知道。
- **素材服务**：还不存在；桌面运行环境现在直读本机素材目录，没有经服务接口；两档素材的字段只是占位；预渲染产物还没有入库，只留在本机。
- **查询渲染**：Agent 专用渲染实例的优先通道、AI 栏操作预览的插队只有雏形。
- **在线浏览器模式**：还不存在。
- **渲染任务队列与渲染节点**：还不存在；预渲染现在只由本机预渲染进程按页面的 preload 做。本机现有的预渲染结果键（共享键、本地档键、流键）还没有并入环境指纹，接队列时要整体换键一次。设计见 `docs/plan/distributed-prerender-queue.md`。
- **手动截短总时长的入口**：语义允许用户手动缩短总时长（`project-model.md`「总时长」），但编辑界面没有入口，现在只有 Agent 能经 `set_project_meta` 截断。UI 层要补手动截短总时长的操作入口，规则用 `src/kernel/duration.ts` 现成的那套。

## 文档

- `desktop/README.md` 的 SKILL 悬浮窗几节描述的是现在的代码，和 `user-workflow.md` 的托盘方案不同。代码改完后跟着改。
- 被忽略、不入库的 `AGY-TASK-*.md` 留在原处不处理。
