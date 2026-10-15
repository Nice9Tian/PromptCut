# AGENT-rr-motion-preempt 最终完成报告

## 1. 任务背景与完成范围

依据 `docs/plan/user-decisions-2026-10-14.md` 第 2.4 节（预渲染的切分与强弱设备抢占）及第 2.5 节 S2（时间轴拖动保活），在独立分支 `gemini/rr-motion-preempt`（独立工作区 `C:\Users\admin\Documents\PromptCut\.worktrees\rr-motion-preempt`）完成以下两项核心特性：

1. **特性一：`motion` 式卡片流任务拆分长度至少 30 秒**：
   - `motion` 式卡片（登记表 `src/cards/capabilities.json` 或卡片源码能力里 `writing === 'motion'` 或 `frameMode === 'stateful'`，即有状态、跨段推帧卡）：
     - 满密度流任务每个分段至少管 30 秒（按项目帧率换算为 `Math.ceil(30 * fps / 15)` 个 15 帧分段，在 30fps 下为 60 个分段 / 900 帧）。
     - 时长不足 30 秒的 `motion` 式卡，整张卡作为一个任务一口气由单台设备做完。
   - `remotion` 式卡片保持原来的 8 个分段（4 秒 / 120 帧）一个任务不变。
   - 稀疏流任务照旧整张卡一个任务。
2. **特性二：跨层强设备主动抢占在途流任务 + 时间轴拖动保活**：
   - 设备层级权重定义：`桌面版（pc / local，权重 3） > 托管方渲染服务（hosted / host 且具备 streams 能力，权重 2） > 浏览器（browser / 无 streams 能力，权重 1）`。
   - 强设备向队列认领任务时，若无 open 状态的候选任务，自动识别并抢占弱设备正在执行的在途流任务（处于 `claimed` / `in_progress` 状态的 `stream:*` 任务，优先抢占稀疏流以保障全局基本画面）。
   - 弱设备已经上传至素材服务的分段予以保留，强设备接手后可复用已上传分段；被抢占的弱设备（如浏览器节点）在收到 `task.lease-lost`（`reason: 'preempted'`）时，立即中止 hand 上的 `runController` 与编码进程，停止耗电产流。
   - 穿梭/拖动保活（S2）：浏览器在用户拖动时间轴（scrubbing/dragging）时，通过 `node.active`（`busy: 'scrub'` / `'drag'`）向文档服务队列上报活跃状态，刷新流任务租约并重置停滞计时，免于超时并防止同层浏览器节点接走任务，同时保留被跨层强设备主动抢占的规则。

---

## 2. 核心架构与修改清单

修改严格遵守允许的边界范围，未碰触任何受限目录（`src/editor/**`、`src/render/**`、`src/export/**`、`server/vision/**`、`docs/plan/*-progress.md` 等均未改动）：

| 文件路径 | 修改类型 | 职责与变更说明 |
|---|---|---|
| `server/render-node/split.mjs` | 修改 | 实现 `isMotionCard(clip, cardId)` 判据；在 `splitPlan` 中将 `motion` 卡满密度流任务按 `Math.ceil(30 * fps / 15)` 切分（不足 30s 整卡切为 1 任务），`remotion` 卡保持 8 段，`sparse` 保持整卡 1 任务。 |
| `src/online/pageStreamPlan.ts` | 修改 | 同步实现与导出 `isMotionCard`，并在 `pageStreamTasks` 中对齐服务端 `splitPlan` 的分段切分规则，确保前端与切分方对拍一致。 |
| `server/render-node/session.mjs` | 修改 | 导出 `deviceRank(node)` 设备权重函数；在节点会话维护 `inFlightStreams` 跟踪在途流任务；在 `tick()` 中当无 open 候选时，若本节点为强设备（权重 > 1），主动发起对弱设备流任务的抢占，优先抢占稀疏流。 |
| `server/docservice/modules/render-queue.mjs` | 修改 | 引入 `deviceRank`；在 `task.claim` 处拦截对已认领 `stream:*` 任务的强弱层级判断，若认领方权重高于持有方，强制从原持有者释放、向其发送 `task.lease-lost { reason: 'preempted' }` 并以递增版本原子抢占；在 `node.active`（`busy: scrub/drag/play`）处刷新任务租约与 `changedAt`，实现防同层抢占与防超时保活。 |
| `src/online/browserNode.ts` | 修改 | 完善 `busyNow()` 识别 `deps.busy?.() === 'drag' \| 'scrub'`；在 `onLost(id, reason)` 处识别 `reason === 'preempted'` 并立即中止该流任务的 `runController`。 |
| `server/test/page-stream-plan.test.mjs` | 修改 | 调整 PSP-04 测试用例中的切分断言以对齐 remotion 卡片能力。 |
| `server/test/motion-preempt.test.mjs` | 新增 | 编写 9 项涵盖切分算法、设备等级、PC/Host 抢占 Browser、同层保护、稀疏流优先抢占、拖动保活、被抢中止等完整特性的单元测试。 |

---

## 3. 关键实现细节

### 3.1 `motion` 式卡片的判定与分段拆分
1. **识别判据**：
   - 优先检查卡片自身显式声明：若片段参数或自身对象带有 `writing: 'motion' | 'remotion'`，直接返回对应布尔值。
   - 查阅 `src/cards/capabilities.json` 登记表：`reviewedCard(cardId)?.writing === 'motion'` 则判定为 motion 卡。
   - 回退检查 `frameMode`：若为 `'stateful'` 则判定为 motion 卡；其余或未登记卡默认回退为 remotion（`false`），确保通用流切分与既有测试兼容。
2. **切分步长**：
   - 稀疏流：`segmentsPerTask = Math.max(1, lastSegment - firstSegment + 1)`，整张卡单任务。
   - 满密度 Motion 卡：
     - 若总时长 `< 30s`（即总分段数 `< Math.ceil(30 * fps / 15)`），整张卡切为 1 个任务（`segmentsPerTask = lastSegment - firstSegment + 1`）；
     - 若总时长 `>= 30s`，按 `Math.ceil(30 * fps / 15)` 个 15 帧分段切分（30fps 下为 60 段 / 900 帧）。
   - 满密度 Remotion 卡：保持 `streamSegments`（默认 8 段 / 120 帧）拆分。

### 3.2 跨层强弱设备在途流任务抢占
1. **设备层级权重**：
   - `pc`（桌面应用 / local node）：权重 3。
   - `host`（托管渲染服务）且具备 `capabilities.streams === true`：权重 2；无 streams 能力则为权重 1。
   - `browser`（浏览器节点）：权重 1。
2. **会话层抢占调度**：
   - 节点会话通过 `inFlightStreams` 跟踪所有在途的流任务及其持有节点权重；
   - 当节点自身并发有空额且队列中无匹配的 `open` 任务时，强节点（权重 > 1）筛选持有方权重更弱的在途任务，按稀疏流优先排序，发出 `task.claim` 抢占请求。
3. **文档服务队列仲裁与原子接手**：
   - 文档服务在 `handle` 处理 `task.claim` 时，如果任务已被认领：
     - 检查认领方权重 `claimerRank` 与持有方权重 `holderRank`；
     - 若 `claimerRank > holderRank` 且任务为 `kind === 'stream'`，向原持有者连接发送 `task.lease-lost { id, token, reason: 'preempted' }`，从底层队列中将任务状态释放；
     - 随后立即将任务以 `expectVersion: targetTask.version + 1` 认领给强设备，并将新认领信息广播给全网。
4. **被抢占端中止响应**：
   - 浏览器节点在收到 `task.lease-lost` 时，若 `reason === 'preempted'`，立即调用 Hand 上的 `runController.abort()`，中断 WebCodecs 编码与分段上传，避免无效耗电与资源竞争。

### 3.3 时间轴拖动/穿梭保活机制
1. **前端忙碌状态上报**：
   - 浏览器在用户交互拖动（scrub / drag）时，通过 `node.active { busy: 'scrub' }` 向服务端心跳通道汇报活跃。
2. **服务端租约与超时刷新**：
   - 文档服务收到携带 `busy === 'scrub' | 'drag' | 'play'` 的 `node.active` 时，遍历该连接持有的所有流任务，自动向队列派发 `task.progress` 递增步骤，刷新 `leaseUntil` 租约时长，并更新 `claim.progress.changedAt` 重置停滞（stall）计时器。
   - 这使得同层浏览器或超时巡检器不会判定该任务停滞或接走任务，保护了当前正在交互的浏览器节点的产流连续性。

---

## 4. 测试验证与结果

### 4.1 TypeScript 强类型编译
- 命令：`npx.cmd tsc -b --force`
- 结果：**0 错误**，前后端类型完全对齐。

### 4.2 专属功能测试（`server/test/motion-preempt.test.mjs`）
- 测试用例数：9 项全部通过。
  - `MP-01 isMotionCard: 识别 remotion 式与 motion 式卡片`
  - `MP-02 切分流任务：motion 卡至少 30 秒（60段），短于 30s 仅 1 个任务；remotion 保持 8 段；sparse 整卡 1 任务`
  - `MP-03 deviceRank：桌面版 (3) > 托管方渲染服务且带 streams (2) > 浏览器 / 不带 streams (1)`
  - `MP-04 跨层抢占：PC (rank 3) 抢占浏览器 (rank 1) 执行中的 stream 任务`
  - `MP-05 跨层抢占：Host (rank 2) 抢占浏览器 (rank 1)；但同层浏览器之间不可相互抢占`
  - `MP-06 非 stream 任务（快照与计划）不被抢占`
  - `MP-07 节点会话：无 open 候选时，PC 自动发起对弱设备 stream 任务的抢占，且优先抢占稀疏流`
  - `MP-08 拖动/穿梭保活：浏览器报 node.active (busy: scrub) 刷新租约与停滞计时，免于超时并防同层抢占`
  - `MP-09 被抢占的浏览器节点：收到 task.lease-lost (preempted) 立即中止 runController 并停工`

### 4.3 相关及既有测试回归验证
- 命令：
  1. `npm.cmd test -- server/test/motion-preempt.test.mjs server/test/page-stream-plan.test.mjs`（22 tests passed）
  2. `npm.cmd test -- server/test/render-node-logic.test.mjs server/test/render-node-network.test.mjs src/online/browserNode.test.mjs src/online/l2.test.mjs`（79 tests passed）
- 结果：**101 项测试全部通过，0 失败**。

### 4.4 行尾符审计（EOL Audit）
- 命令：`node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD`
- 结果：所有修改文件均严格保持统一 CRLF 行尾符，**0 翻转，0 孤立 CR**。

---

## 5. 交付物与结论

- 本次修改覆盖完整的任务切分与跨层抢占闭环，各层级协作顺畅，边界清晰，基线全绿。
- 分支与修改物料已准备就绪，等待主会话验收合入。
