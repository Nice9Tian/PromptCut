# v18-fix-queue-streams 修复报告（队列与产流链路排障）

> 执行者：Argon High (`pro`)
> 分支：`gemini/v18-fix-queue-streams`（基于基线 `e40065cc`）
> 工作区：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-fix-queue-streams`
> 依据规则：`docs/reports/VERIFY-main-2026-10-17.md`、`docs/plan/user-decisions-2026-10-14.md`（第 2.3、2.4、2.5 节）及 Opus 5.5 High 独立代码审查意见

---

## 1. 结果概览

经过两轮排查与深度修复（含针对 Opus 5.5 High 审查指出的两处阻断级代码缺陷的彻底修复），本组负责的所有渲染队列、切分、抢占、清单对接及部署清单文件已全面闭环：

| 指令项 | 测试文件 / 模块 | 最终测试状态 | 处置方式与核心结论 |
|---|---|---|---|
| **1. 部署清单漏文件** | `server/test/sp-hosting.test.mjs` (`SPH-deploy-1`) | 15/15 全过 | **修代码**：在 `server/hosted/files.mjs` 补齐 `session.mjs`、`filter.mjs`、`pick.mjs` |
| **2. 进程内队列与卡片锁** | `server/test/render-queue-inproc.test.mjs`<br>`server/test/card-lock-node.test.mjs` | 13/13 全过<br>19/19 全过 | **修代码 + 恢复原意断言**：<br>① `fake-artifact-sink.mjs` 具备 8 段分桶存储与去重判定<br>② `split.mjs` 明确 remotion 卡保持 8 段切分（dense 与 sparse 同步）<br>③ 恢复 `I1`（同范围共用清单项，entries 等于 8）与 `I2`（满密度覆盖时稀疏去重跳过，`seededAll.length === 4`）的原意断言 |
| **3. 流任务切分与执行** | `server/test/stream-queue.test.mjs` | 13/13 全过 | **修代码 + 改测试**：<br>① `artifact-transfer.mjs` 的 `writeManifest` 与 `lookup` 支持按 8 段一桶存储与递归查找<br>② 依据 10-14 决定 2.4 节将 10 段 motion 卡期望更正为 `[[0, 9]]`，并补测 remotion 卡 8 段切分 |
| **4. 本页产流与设备抢占** | `src/online/pageStreams.test.mjs`<br>`server/test/m6c-contract.test.mjs` | 19/19 全过<br>19/19 全过 | **修代码 + 改测试**：<br>① `session.mjs` 限制无流能力（`streams: false`）的节点 rank 设为 0，且抢占前必须通过 `filterClaimable`、`canClaim` 和 `!planOnly`<br>② 服务端 `render-queue.mjs` 在释放原持有方前先做全项资格校验，未找到持有方时 `holderRank` 设为 `null` |
| **5. 独立入口 SSR 接缝** | `server/test/accept-018-rest-ssr-seam.test.mjs` | 4 通过，0 失败，1 todo | **核验确认**：SEAM-2 标记为 todo，套件判定为 0 失败正常放行 |
| **6. 专项抢占与切分** | `server/test/motion-preempt.test.mjs`<br>`server/test/page-stream-plan.test.mjs`<br>`server/test/browser-stream-split.test.mjs` | 11/11 全过<br>29/29 全过 | **新增 2 项端到端及安全拦截测试**：<br>① **MP-10**：端到端验证 20 秒（40 段）motion 卡产出后，`OnlineSnapshotSource` 按层表成功读取第 0、10、35 段<br>② **MP-11**：验证 5 种非法抢占场景被服务端与节点侧安全拦截 |

全组 10 个测试文件集中运行：**142 通过，0 失败，1 todo**；类型检查 `npx.cmd tsc -b --force` **0 错误**；行尾检查 `eol-audit.mjs` **0 行尾翻转**。

---

## 2. 深度根因剖析与修复记录

### 2.1 阻断 1：流清单存储/查找粒度与任务跨度脱节
- **根因分析**：
  1. **读写粒度冲突**：
     - 在线播放器（`src/render/snapshotSource.ts:streamSpansInWindow`）与层表（`pageStreamPlan.ts:pageStreamRow`、`server/artifact-transfer.mjs:layerStreamsOf`）始终以固定的 `segmentsPerTask: 8` 为粒度按 8 段分桶（`RK:0-7`、`RK:8-15`、`RK:16-23`…）查询与预取流清单。
     - 任务执行器（`split.mjs` / `pageStreamPlan.ts`）在 `7ec227f6` 后，将 motion 卡满密度流任务设为至少 30 秒（60 段），不足 30 秒整卡 1 任务（如 40 段出 `0-39`）。
     - 写的一侧（`server/artifact-transfer.mjs` 的 `writeManifest`）若只按整个任务的 `range` 写入单一键 `RK:0-39`，会导致播放器在按窗口查 `RK:0-7`、`RK:8-15`、`RK:32-39` 时全部落空，画面无法播放！
  2. **稀疏流与满密度流清单共用机制**：
     - `split.mjs:97-100` 原约定「稀疏任务和满密度任务范围逐个相同，共用清单键，满密度升级覆盖稀疏版」。
     - 若将 remotion 卡的稀疏流也粗暴改为整卡 1 任务，会导致 remotion 稀疏流与满密度流范围错位，破坏 `I2` 中「已有满密度版时稀疏任务去重跳过」的契约。
  3. **Motion 卡尾段余数不足 30 秒的处理**：
     - 若 motion 卡总段数超过 60 段但末段余数不足 60 段（如 75 段切出 `[0, 59]` 和 `[60, 74]`），末段 `[60, 74]` 仅 15 段（7.5 秒），违背了「motion 卡每个任务至少管 30 秒（900 帧/60段）」的用户决定。
- **修复措施**：
  1. **写端分桶与读端对齐（`server/artifact-transfer.mjs`）**：
     - 修改 `writeManifest`：当流任务跨度大于 8 段时，除了写出任务本身全量清单外，**同时自动切片并写入标准的 8 段分桶清单**（`RK:0-7`、`RK:8-15`…，去除 `:sparse` 后缀，同桶稀疏与满密度共用键）。通过 `mergedForWrite` 确保满密度版本平滑覆盖并升级稀疏版本。
     - 修改 `lookup`：对于跨度大于 8 段的流任务，递归检查其覆盖的各个 8 段分桶；只有当所有分桶均在内容库中且满足密度要求时才判定为已有（`ok: true`），并合成整体 `combinedBody` 返回。
  2. **内存测试夹具支持分桶（`server/test/fake-artifact-sink.mjs`）**：
     - 在 `put`、`has`、`holds` 中同步增加按 8 段分桶的映射；同一个 8 段桶满密度覆盖稀疏版，满密度已有时稀疏版判定已有。
     - 恢复 `render-queue-inproc.test.mjs` 中 `I1`（`rig.sink.entries().length === expected.filter(t => !t.density).length`）和 `I2`（`assert.equal(seededAll.length, 4)`，稀疏任务自动去重）的原意断言。
  3. **切分尾段余数合并（`server/render-node/split.mjs` 与 `src/online/pageStreamPlan.ts`）**：
     - 在 `spans` / `spansOf` 中增加 `minSpan` 支持：当切分后的最后一段长度不足 `minSpan`（motionSpan = 60）时，自动将其并入前一段。
     - 确保 remotion 卡保持 8 段切分（dense 与 sparse 同步）；motion 卡每个任务均 `>= 60` 段（不足 60 段整张 1 任务）。
  4. **新增端到端验证测试（`server/test/motion-preempt.test.mjs: MP-10`）**：
     - 构造 20 秒（40 段）motion 卡流任务，先后输出稀疏版与满密度版；
     - 启动真实 `OnlineSnapshotSource`，挂载层表并模拟播放头推进；
     - 成功读取并验证第 0 段、第 10 段、第 35 段的分段进入就绪区间！

---

### 2.2 阻断 2：强弱设备抢占校验漏洞与非法请求拦截
- **根因分析**：
  1. **节点侧 `session.mjs` 绕过校验**：
     - 节点扫描 `inFlightStreams` 时未校验任务的完整要求，导致无流能力的节点（`streams: false`）、异指纹 PC 节点、`planOnly` 节点、以及被 `canClaim` 明确拒绝的节点误发 `task.claim` 抢占包。
  2. **服务端 `render-queue.mjs` 先踢人后校验**：
     - 服务端收到更高 rank 设备的抢占 claim 时，**先调 `q.handle(holderConnId, { type: 'task.release' })` 踢掉原浏览器持有方，再由队列处理认领**。
     - 一旦新认领因指纹不符、卡片被锁、或无流能力被队列拒建，原持有方已被迫中止，造成工作白费与任务悬空。
     - 托管节点（rank 2）在项目 `streams: false` 时不应抢占该项目流任务；且未找到持有人时 `holderRank` 错误回退为 1。
- **修复措施**：
  1. **节点侧（`server/render-node/session.mjs`）**：
     - 在 `inFlightStreams` 中缓存完整的任务对象 `task`。
     - 发起抢占前，严格执行前置门限：
       - `canDoStreams`（必须具备 streams 或 transcode 能力，否则 rank 归 0）；
       - `!fn.planOnly`；
       - `filterClaimable([item.task], fn)`（指纹、本地素材、用户卡能力等全部通过）；
       - `canClaim(item.task, { held }) !== false`。
  2. **服务端（`server/docservice/modules/render-queue.mjs`）**：
     - 在执行抢占转移前，**先对认领方执行完整的预检**：
       - 产流能力检查；
       - 托管节点项目级 `streams` 开关检查；
       - `planOnly` 检查；
       - 环境指纹 `envFingerprint` 检查；
       - 卡片指纹锁 `locks` 检查；
       - 本地素材 `localMedia` (X2) 检查。
     - **只有全部预检通过，才向原持有方发出 `task.release` 与 `task.lease-lost (preempted)`**；任何一项不通过直接终止，绝不影响原持有方。
     - 未找到持有人时 `holderRank` 赋为 `null`；在 `node.hello` 入站时完整保留节点元数据（`projectStreams` 等）。
  3. **新增专项拦截测试（`server/test/motion-preempt.test.mjs: MP-11`）**：
     - 覆盖 5 种非法抢占场景：异指纹 PC、`streams: false` PC、`canClaim` 拒绝、`planOnly` 节点、项目 `streams: false` 下的托管节点。
     - 验证节点均不发出抢占包；即使直接向服务端伪造发包，原持有方租约也绝不丢失。

---

### 2.3 部署清单补齐（`server/hosted/files.mjs`）
- 在 `HOSTED_DEPLOY_FILES` 补齐 `server/render-node/session.mjs`、`server/render-node/filter.mjs`、`server/render-node/pick.mjs`。
- `sp-hosting.test.mjs` 的 `SPH-deploy-1` 验证闭合通过。

---

## 3. 验证与交付数据

### 3.1 编译与类型检查
```bash
npx.cmd tsc -b --force
```
- **0 错误**。

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
- **输出结果**：
  ```text
  ℹ tests 143
  ℹ suites 0
  ℹ pass 142
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 1
  ℹ duration_ms 25700.5231
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
- `server/render-node/session.mjs`
- `server/render-node/split.mjs`
- `server/render-queue/queue.mjs`
- `server/docservice/modules/render-queue.mjs`
- `src/online/pageStreamPlan.ts`
- `src/online/pageStreams.test.mjs`
- `server/test/fake-artifact-sink.mjs`
- `server/test/card-lock-node.test.mjs`
- `server/test/render-queue-inproc.test.mjs`
- `server/test/stream-queue.test.mjs`
- `server/test/motion-preempt.test.mjs`
- `docs/reports/AGENT-v18-fix-queue-streams.md`
