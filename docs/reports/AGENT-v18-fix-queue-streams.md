# v18-fix-queue-streams 修复报告（队列与产流链路排障）

> 执行者：Argon High (`pro`)
> 分支：`gemini/v18-fix-queue-streams`（基于基线 `e40065cc`）
> 工作区：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-fix-queue-streams`
> 依据规则：`docs/reports/VERIFY-main-2026-10-17.md`、`docs/plan/user-decisions-2026-10-14.md`（第 2.3、2.4、2.5 节）及 Opus 5.5 High 独立代码审查意见（初审与二审）

---

## 1. 结果概览

经过两轮代码审查、深入排查与闭环修复，本组负责的所有渲染队列、切分、抢占、清单对接及部署清单问题已彻底修复并全量验证通过：

| 指令项 | 测试文件 / 模块 | 最终测试状态 | 处置方式与核心结论 |
|---|---|---|---|
| **1. 部署清单漏文件** | `server/test/sp-hosting.test.mjs` (`SPH-deploy-1`) | 15/15 全过 | **修代码**：在 `server/hosted/files.mjs` 补齐 `session.mjs`、`filter.mjs`、`pick.mjs` |
| **2. 进程内队列与卡片锁** | `server/test/render-queue-inproc.test.mjs`<br>`server/test/card-lock-node.test.mjs` | 13/13 全过<br>19/19 全过 | **修代码 + 恢复原意断言**：<br>① `fake-artifact-sink.mjs` 支持全局 8 段分桶对齐存储与去重判定<br>② `split.mjs` 保持 remotion 满密度 8 段切分，所有卡稀疏流整卡 1 任务<br>③ 恢复 `I1`（同范围共用清单项，entries 严格为 8）与 `I2`（满密度覆盖时稀疏去重跳过，`seededAll.length === 3`）断言 |
| **3. 流任务切分与执行** | `server/test/stream-queue.test.mjs` | 13/13 全过 | **修代码 + 改测试**：<br>① `artifact-transfer.mjs` 的 `writeManifest` 写入任务全量键的同时按全局 8 段一桶分桶存储，`lookup` 递归检查分桶<br>② 依据 10-14 决定 2.4 节将 10 段 motion 卡期望更正为 `[[0, 9]]`，并补测 remotion 卡 8 段切分 |
| **4. 本页产流与设备抢占** | `src/online/pageStreams.test.mjs`<br>`server/test/m6c-contract.test.mjs` | 19/19 全过<br>19/19 全过 | **修代码 + 改测试**：<br>① `session.mjs` 限制无流能力（`streams: false`）的节点 rank 设为 0，且抢占前必须通过 `filterClaimable`、`canClaim` 和 `!planOnly`<br>② 服务端 `render-queue.mjs` 抢占预检未通过时正常放行底层队列回拒，不盲目释放原持有方，未找到持有方时 `holderRank` 设为 `null` |
| **5. 独立入口 SSR 接缝** | `server/test/accept-018-rest-ssr-seam.test.mjs` | 4 通过，0 失败，1 todo | **核验确认**：SEAM-2 标记为 todo，套件判定为 0 失败正常放行 |
| **6. 专项抢占与端到端切分验证** | `server/test/motion-preempt.test.mjs`<br>`server/test/page-stream-plan.test.mjs`<br>`server/test/browser-stream-split.test.mjs` | 11/11 全过<br>29/29 全过 | **新增 2 项端到端及安全拦截测试**：<br>① **MP-10**：端到端验证 125 段（包含任务 1 `[0, 59]` 与 任务 2 `[60, 124]`）motion 卡产出后，跨越任务边界的桶 `56-63` 被两边无缝合并，`OnlineSnapshotSource` 成功读取第 0、10、35、58、62、70、124 段<br>② **MP-11**：验证 5 种非法抢占场景被服务端与节点侧安全拦截并返回 `claim-rejected`（`taken`） |

全组 10 个测试文件集中运行：**143 项用例：142 通过，0 失败，1 todo**；类型检查 `npx.cmd tsc -b --force` **0 错误**；行尾检查 `eol-audit.mjs` **0 行尾翻转**。

---

## 2. 核心架构问题与修复实现（针对 Opus 5.5 High 二审）

### 2.1 【B1 + 非阻断 4】60 段 `motion` 任务跨 8 段桶边界对齐与非 `motion` 卡稀疏流整卡 1 任务
- **问题分析**：
  - 30fps 下 `motion` 卡每个满密度任务是至少 60 段（例如 125 段卡切为任务 1 `[0, 59]` 和任务 2 `[60, 124]`）。
  - 播放器 `snapshotSource.ts:streamSpansInWindow` 永远按照全局 8 段对齐边界（从 0 起：`0-7`、…、`48-55`、**`56-63`**、**`64-71`**、…）进行预取和查找。
  - 若服务端与测试夹具从任务各自的 `from` 步长加 8 写入，任务 1 会写出 `56-59`，任务 2 会写出 `60-67`，跨越两个任务边界的全局桶 `56-63` 永远缺失，导致播放头经过第 56 段后画面全部丢失！
- **修复方案**：
  1. **服务端与测试夹具分桶边界全局对齐（`server/artifact-transfer.mjs` & `server/test/fake-artifact-sink.mjs`）**：
     - 在 `writeManifest` 中，除了写出任务本身全量键 `${resultKey}:${from}-${to}` 外，分桶起点对齐到全局 8 段边界：
       ```javascript
       const firstBucket = Math.floor(from / 8) * 8;
       for (let bFrom = firstBucket; bFrom <= to; bFrom += 8) {
         const bTo = Math.min(lastSeg, bFrom + 7);
         // 提取该桶内的分段与开头文件...
         await writeSingleManifest(content, bucketResult, log);
       }
       ```
     - 任务 1（`[0, 59]`）在写入分桶时，最后一个桶的键是 `56-63`（放入 56..59 段）；任务 2（`[60, 124]`）在写入分桶时，第一个桶的键也是 `56-63`（放入 60..63 段），经由 `mergedForWrite` 与 `mergeStreamResult`，两个任务的分段无缝合并进同一个 `56-63` 桶清单中！
  2. **非 motion 卡稀疏流整卡 1 任务恢复**：
     - 在 `split.mjs` 和 `pageStreamPlan.ts` 中，所有卡（含 `remotion`）的稀疏流任务（`density === STREAM_DENSITY_SPARSE`）保持整张卡 1 个任务 `[firstSegment, lastSegment]`。
     - 满密度任务中，`remotion` 保持 8 段切分，`motion` 保持至少 60 段切分且末段不足 60 段并入前一段。
  3. **单测断言恢复与扩充**：
     - `render-queue-inproc.test.mjs` 中 `I1` 断言 `rig.sink.entries().length === expected.filter(t => !t.density).length`（8 桶）和 `I2` 去重逻辑完全闭环。
     - `motion-preempt.test.mjs` 的 `MP-10` 端到端单测扩充为 125 段（覆盖任务 1 `[0, 59]` 和任务 2 `[60, 124]`），验证跨界桶 `56-63` 里的第 58 段、第 62 段以及后续第 70 段、第 124 段全部成功读出！

---

### 2.2 【B2】浏览器端 `putStreamManifest` 全局 8 段分桶写入（`src/editor/browserNodeHost.ts`）
- **问题分析**：
  - 浏览器自产流（通过 `browserNodeHost.ts` 的 `putStreamManifest`）此前只向内容库写了一份整任务键（如 `0-59` 或 `0-N:sparse`），在播放器按 8 段查找时同样无法命中。
- **修复方案**：
  - 在 `src/editor/browserNodeHost.ts` 的 `putStreamManifest` 中：
    当流任务跨度不是单个对齐 8 段桶、跨度大于 8 段、或是稀疏流时，除了写原始任务键外，同步按 `firstBucket = Math.floor(from / 8) * 8` 步长加 8 循环切出每个 8 段桶，抽取属于该桶的分段，并通过 `putSingle`（内置 `mergeStreamManifest`）合并写入对应桶清单键 `${task.resultKey}:${bFrom}-${bTo}`。

---

### 2.3 【B3 + 非阻断 1, 2, 3】抢占拦截返回 `claim-rejected` 与信息最小化
- **问题分析**：
  - 服务端在抢占预检不通过时静默 `return`，导致认领方的 `inflight` 标记永远挂起，无法重试或认领其他任务；
  - `conns` 中节点的 `throttled` 限流状态未纳入抢占预检；
  - 节点侧 `session.mjs` 缺少 `item.task` 时会发生盲抢；
  - 给纯浏览器下发了不必要的 `claimedStreams`，给 host/pc 下发的 `claimedStreams.task` 泄漏了内部 `claim` 令牌。
- **修复方案**：
  1. **服务端（`server/docservice/modules/render-queue.mjs`）**：
     - 非法抢占预检失败时不直接 `return`，而是让代码继续流转至底层队列 `q.handle(connId, msg)`，由底层队列依据 `task.state !== 'open'` 正常回送 `task.claim-rejected`（`reason: 'taken'`），确保认领方 `session` 的 `inflight` 被清空！
     - 增加 `conn?.cardLockedRejects > QUEUE_DEFAULTS.THROTTLE_REJECTS` 限流预检；
     - 在下发 `queue.snapshot` 给纯浏览器时 `claimedStreams = []`；给 host/pc 下发时通过 `const { claim: _claim, ...safeTask } = t;` 剔除敏感令牌。
  2. **节点侧（`server/render-node/session.mjs`）**：
     - 在 `start()` 中发送 `node.hello` 时，把 `planOnly: Boolean(node.planOnly)` 和 `projectStreams` 完整上报；
     - 在抢占循环中，若 `!item.task` 则直接 `continue`，严禁盲抢。
  3. **单测覆盖（`server/test/motion-preempt.test.mjs: MP-11`）**：
     - 针对 5 种非法抢占场景（异指纹 PC、`streams: false` PC、`canClaim` 拒绝、`planOnly` 节点、项目 `streams: false` 下的托管节点），断言抢占方收到 `task.claim-rejected`，原持有方租约不丢失。

---

## 3. 验证与交付数据

### 3.1 编译与类型检查
```bash
npx.cmd tsc -b --force
```
- **0 错误**（干净退出）。

### 3.2 全量关联测试套件执行
```powershell
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
$env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
$env:PROMPTCUT_NO_PORT_FILE="1"

npm.cmd test -- `
  server/test/sp-hosting.test.mjs `
  server/test/render-queue-inproc.test.mjs `
  server/test/card-lock-node.test.mjs `
  server/test/stream-queue.test.mjs `
  src/online/pageStreams.test.mjs `
  server/test/m6c-contract.test.mjs `
  server/test/motion-preempt.test.mjs `
  server/test/accept-018-rest-ssr-seam.test.mjs `
  server/test/page-stream-plan.test.mjs `
  server/test/browser-stream-split.test.mjs
```
- **输出统计**：
  ```text
  ℹ tests 143
  ℹ suites 0
  ℹ pass 142
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 1
  ℹ duration_ms 25525.8296
  ✓ npm test 最终结果：零失败
  ```

### 3.3 行尾检查
```bash
node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . e40065cc HEAD
```
- **0 行尾翻转**。

### 3.4 涉及修改文件清单
- `server/hosted/files.mjs`
- `server/artifact-transfer.mjs`
- `server/docservice/modules/render-queue.mjs`
- `server/render-node/session.mjs`
- `server/render-node/split.mjs`
- `server/render-queue/queue.mjs`
- `src/editor/browserNodeHost.ts`
- `src/online/pageStreamPlan.ts`
- `src/online/pageStreams.test.mjs`
- `server/test/fake-artifact-sink.mjs`
- `server/test/card-lock-node.test.mjs`
- `server/test/render-queue-inproc.test.mjs`
- `server/test/stream-queue.test.mjs`
- `server/test/motion-preempt.test.mjs`
- `docs/reports/AGENT-v18-fix-queue-streams.md`
