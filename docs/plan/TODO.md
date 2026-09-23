# TODO

还没做完的工作。未开始的计划和它们的协议全文都在本目录 `docs/plan/` 里；已做完步骤的记录归档在 `docs/archive/`。计划与 `docs/semantics/` 冲突时，以 semantics 为准。

## 未开始的计划

| 事项 | 计划文件 | 状态 |
|---|---|---|
| 轨道流：重卡在播放时贴的 alpha 视频流 | `docs/plan/r8-streams-task.md`；编码原型报告 `docs/plan/g0-b-stream-prototype.md` | 未开始，编码原型已做完 |
| 共享 WebGL 渲染器：canvas 卡共用一个 WebGL 上下文 | `docs/plan/r9-webgl-task.md` | 未开始 |
| 云端：素材上云、文档服务、改动竞态、Agent 的查询进程、在线浏览器模式 | `docs/plan/cloud-task.md`，文末有 6 个动工前要定的问题 | 未开始 |
| 音频整体改成浏览器端 JS | `docs/plan/audio_structure_plan.md`（A0～A7）；判重测试计划 `docs/plan/audio_determine_plan.md` | 计划已写，未动工 |
| 以后再做：桌面版给只有原片的云端素材补转小版；导出页装虚拟定时器 | `docs/plan/future_planning.md` | 暂缓 |

## 已做步骤的遗留

- **R0**：仓库根 dev server 的冷启动量测没做。（`scripts/verify-unified-frames.mjs` 已整条通过；快照重放和整帧导出的残差查到只剩三处快照这一侧修不了的，见 `docs/archive/restructure_planning/reports/replay-mismatch-report.md` §12、§13。）
- **R7b 没做成的**：`stageSwap`、`snapshotFeed`、`demote` 和节拍循环没有单测；只预渲染重卡集合那一条只停了快照、没停 PNG；R7b 报告第 4 节的 8 条更正没折回 `docs/archive/restructure_planning/r2-r7-task.md`。
- **待用户定**：播放停顿期间要不要加音频看门狗，让音频立刻停。试验代码在分支 `probe/audio-watchdog`。

各步的详细状态见 `docs/archive/restructure_planning/hand_off.md`；独立复核的结论见 `docs/archive/restructure_planning/hunman_read.md`。

## 语义与代码的差距

`docs/semantics/` 已经定下、代码还没跟上的地方。按 `suggested_agent_behavior.md` 原则 2，这些都算代码要改。

- **工作方式**：去掉对话式布局；SKILL 改为桌面 APP 经 MCP 直接接入同一个项目（现在是把项目快照进独立任务目录、由无头实例改副本、最后三方合并）；关闭编辑界面转为托盘和悬浮窗后台运行。
- **Agent**：三档创造力等级（项目默认、对话可改）；主 Agent 拉起子 Agent 并附加角色，现有的分工模式归档；Agent 用 JS 自定义测量；看或改用户正在编辑的内容时返回「用户正在编辑」。
- **文档服务**：还不存在，项目的真身现在在页面里；Agent 的写操作现在经页面执行，没有经文档服务；覆盖通知覆盖方和被覆盖方都要知道。
- **素材存储**：还不存在；两档素材的字段只是占位；预渲染的产物要能上云，供无渲染能力的设备查看。旧计划里「像素缓存不上云」的规则以 `docs/semantics/architecture.md` 为准作废。
- **查询渲染**：Agent 专用渲染实例的优先通道、AI 栏操作预览的插队只有雏形。
- **在线浏览器模式**：还不存在。
- **Agent 系统提示词**：`server/ai-system-prompt.md` 说总时长不跟着内容走，和代码、语义都不符，要改。

## 文档

- `desktop/README.md` 的 SKILL 悬浮窗几节描述的是现在的代码，和 `user-workflow.md` 的托盘方案不同。代码改完后跟着改。
- 被忽略、不入库的 `AGY-TASK-*.md` 留在原处不处理。
