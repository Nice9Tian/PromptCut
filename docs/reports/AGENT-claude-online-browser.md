# AGENT 报告：claude/online-browser

在线浏览器任务（`docs/plan/online-browser-task.md`）的第二、三、四步：撤销低内存档并落实身份；舞台闸门、崩溃记录、护栏、档位气泡；素材闸门、即时渲染闸门、最低一档。

- worktree：`.worktrees/online-browser`，分支 `claude/online-browser`，开工提交 `5f4523d0`（main）。
- 端口段：5870～5879。
- 主会话给的两处更正：分支从 main 切、不合别的分支；「预渲染小尺寸」已停产，第四步第 5 条不再拟方案。

## 进度

- [ ] 第二步：撤销低内存档，落实身份
- [ ] 第三步：舞台闸门、崩溃记录、护栏、气泡
- [ ] 第四步：素材闸门、即时渲染闸门、最低一档
- [ ] 机制文档与术语表改写
- [ ] 门槛验证

## 摸底与设计（开工时）

范围：`grep -E "lowMemory|低内存|LowMemory|low-memory|lowMem|LOW_MEM"` 在 `src/ server/ scripts/` 下命中 148 个文件（含测试 46 个、探针约 17 个、`server/` 约 20 个），与主会话数的 144 个同一量级。直接引 `src/online/lowMemory.ts` 的只有 6 个（`Preview.tsx`、`previewMode.ts`、`ProbeGate.tsx`、`OnlineAgentPage.tsx`、`pageStreams.ts`、`stageRpc.ts`），其余是这一档的布尔量一路传下去（舞台能力表、取档策略、分派表、流预算、GL 图集、成本记录键、运行状态、声音判定、浏览器节点资格……）。

低内存档在代码里其实捆着三件事，拆开后各归各处：

| 原来低内存档管的事 | 新归属 |
|---|---|
| 自动判定、设备设置「显示档」、进入提示、运行中整体降档、AI 栏占位、声音不合成、同步卡不执行（`low-memory` 运行状态）、`backfill` 优先级 | 删（任务书第二步第 1 条） |
| 只有一个舞台：不开后台舞台、借可见舞台测量（界限搜索）、停下时在可见舞台里逐层追一帧 | 舞台闸门第一级「精简模式」与最低一档 |
| 播放时一律不活渲、素材只用小尺寸、轨道流只贴稀疏版（每段第一帧）、解码器给得少、页面切后台就暂停 | 最低一档「低配模式」 |
| 不当渲染节点、只产稀疏版 | 身份为手机（不再看档位） |

新的会话状态集中在 `src/online/onlineTier.ts`（舞台闸门到了哪一级、是否最低一档、身份），崩溃记录与舞台闸门的判法放在 `src/online/crashLog.ts`、`src/online/stageGate.ts`（纯函数，可注入存储与时钟单测）。

（以下各节随工作推进补写。）
