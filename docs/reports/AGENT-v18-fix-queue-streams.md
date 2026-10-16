# v18-fix-queue-streams 修复报告（队列与产流链路排障）

> 执行者：Argon High (`pro`)
> 分支：`gemini/v18-fix-queue-streams`（基于基线 `e40065cc`）
> 工作区：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-fix-queue-streams`
> 依据规则：`docs/reports/VERIFY-main-2026-10-17.md`、`docs/plan/user-decisions-2026-10-14.md`（第 2.3、2.4、2.5 节）

---

## 1. 结果概览

针对 2026-10-17 核对报告中记录由 `7ec227f6`（`rr-motion-preempt`）合入后引入的约 32 条失败测试及 SSR 接缝，逐条排查是修代码还是按用户新规则更新测试断言，完成修复与闭环验证：

| 指令项 | 测试文件 / 模块 | 修复前状态 | 修复后状态 | 处置方式 |
|---|---|---|---|---|
| **1. 部署清单漏文件** | `server/test/sp-hosting.test.mjs` (`SPH-deploy-1`) | 1 失败（找不到 `session.mjs`） | 15/15 全过 | **修代码**：在 `server/hosted/files.mjs` 补齐 `session.mjs` 及 `filter.mjs`、`pick.mjs` |
| **2. 进程内队列整链路与卡片锁** | `server/test/render-queue-inproc.test.mjs`<br>`server/test/card-lock-node.test.mjs` | 19 失败（>4000/3000 步未满足、derived 不符） | 13/13 全过<br>19/19 全过 | **改测试**：测试夹具 `expectedDerived` 期望按 10-14 新规适配整卡 1 个稀疏流任务 |
| **3. 流任务切分与执行** | `server/test/stream-queue.test.mjs` | 5 失败（X1-split、plan、render、skip、sparse） | 13/13 全过 | **改测试**：按 10-14 决定 2.4 节将 10 段 motion 卡期望更正为 `[[0,9]]`，并补测 remotion 卡 8 段切分 |
| **4. 本页产流与设备抢占** | `src/online/pageStreams.test.mjs`<br>`server/test/m6c-contract.test.mjs` | 5 失败（PS-01、03、04、13、14）<br>1 失败（MC-X1-queue-claims 报 4 次认领） | 19/19 全过<br>19/19 全过 | **修代码 + 改测试**：<br>① 代码修复：`session.mjs` 限制仅在具备 `streams !== false` 时才可抢占，且未知持有人不盲目当 rank 1<br>② 测试适配：`pageStreams` 适配 motion 卡 `0-9` 单任务 |
| **5. 独立入口 SSR 接缝** | `server/test/accept-018-rest-ssr-seam.test.mjs` | 核对表标注 1 失败 | 4 通过，0 失败，1 todo | **核验确认**：SEAM-2 原为 todo 项，测试套件判定为 0 失败正常放行 |
| **专项抢占与切分** | `server/test/motion-preempt.test.mjs`<br>`server/test/page-stream-plan.test.mjs`<br>`server/test/browser-stream-split.test.mjs` | — | 9/9 全过<br>29/29 全过 | **保持全绿**：抢占机制与两端切分逻辑完全兼容 |

全组 10 个测试文件集中运行：**140 通过，0 失败，1 todo**；类型检查 `npx.cmd tsc -b --force` **0 错误**；行尾检查 `eol-audit.mjs` **0 行尾翻转**。

---

## 2. 逐项根因与修复说明

### 2.1 部署清单漏文件（`server/hosted/files.mjs`）
- **现象**：
  - `sp-hosting.test.mjs` 的 `SPH-deploy-1` 报错：`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/render-node/session.mjs' imported from .../server/docservice/modules/render-queue.mjs`。
- **根因**：
  - `7ec227f6` 中，为了在文档服务队列模块中实现强弱设备抢占判断，`server/docservice/modules/render-queue.mjs` 引入了 `import { deviceRank } from '../../render-node/session.mjs'`。
  - `server/render-node/session.mjs` 本身又静态依赖了同目录的 `./filter.mjs` 与 `./pick.mjs`。
  - 但部署清单 `server/hosted/files.mjs` 的 `HOSTED_DEPLOY_FILES` 仅包含了 `session-link.mjs`、`ws-transport.mjs` 和 `fingerprint.mjs`，未收录 `session.mjs` 及其依赖，导致独立暂存目录部署缺失文件无法启动。
- **修复措施**：
  - 在 `server/hosted/files.mjs` 的 `HOSTED_DEPLOY_FILES` 中添加：
    - `'server/render-node/session.mjs'`
    - `'server/render-node/filter.mjs'`
    - `'server/render-node/pick.mjs'`
  - 重新运行 `npm.cmd test -- server/test/sp-hosting.test.mjs`，15/15 全部通过。

---

### 2.2 渲染队列整链路仿真与卡片锁（`render-queue-inproc.test.mjs`、`card-lock-node.test.mjs`）
- **现象**：
  - `render-queue-inproc.test.mjs` 用例 I1～I11 全部报错：「超过 4000 步仍未满足条件；queue.describe() tasks: []」。
  - `card-lock-node.test.mjs` 用例 N5、N6 报错：「超过 3000 步仍未满足条件」，N6 报错「derived 只含最终发布成功的：期望包含 `stream:...:0-7:sparse` 与 `stream:...:8-11:sparse`，实际为 `stream:...:0-11:sparse`」。
- **根因**：
  - 在 `7ec227f6` 之前，稀疏流与满密度流均按每 8 段（120 帧）一个任务切分。
  - `7ec227f6`（依据用户 2026-10-14 决定与 `rr-motion-preempt` 规范）在 `server/render-node/split.mjs` 中实施了新规则：
    `span = density === STREAM_DENSITY_SPARSE ? Math.max(1, lastSegment - firstSegment + 1) : ...`
    即：**稀疏流（sparse stream）任务整张卡仅切为 1 个任务**（分段 `[firstSegment, lastSegment]`）。
  - 但 `render-queue-inproc.test.mjs` 与 `card-lock-node.test.mjs` 测试文件中的测试夹具 `expectedDerived` 未同步更新，仍然通过循环 `for (let from = s.firstSegment; from <= s.lastSegment; from += 8)` 期望切出多个 8 段稀疏任务（例如 `0-7:sparse` 与 `8-9:sparse`）。
  - 队列中实际发布并完成的是 `0-11:sparse`，驱动循环 `drive` 的 `until` 条件（要求收到 `0-7:sparse` 与 `8-9:sparse` 的 `task.done`）永远无法达成，超时 4000 步退出。
- **修复措施**：
  - 按 10-14 决定与 `7ec227f6` 新规则更新 `render-queue-inproc.test.mjs` 与 `card-lock-node.test.mjs` 中的 `expectedDerived` 期望构造函数：
    稀疏流固定为整条流 1 个任务 `from: s.firstSegment, to: s.lastSegment`，满密度任务保持按段切分。
  - 同步更新测试中的断言：
    - I1：细任务预期数量由 10 个（6 快照 + 2 稀疏流 + 2 满密度流）更正为 9 个（6 快照 + 1 稀疏流 + 2 满密度流）；产物库条目断言适配稀疏流整条范围（0-11 与满密度的 0-7、8-11 范围不同，各占独立 entry）。
    - I2：预置三段命中去重任务数更新为 3 个。
  - 修复后两个文件 13 + 19 = 32 条测试全部毫秒级飞速通过。

---

### 2.3 流任务切分与执行（`stream-queue.test.mjs`）
- **现象**：
  - `X1-split`：期望分段 `[[0, 7], [8, 9]]`，实际 `[[0, 9]]`。
  - `X1-plan`：期望 `streamTasksOf(ctx)` 包含两个 `'clip-a'`，实际仅一个。
  - `X1-render`：期望非 belowDependent 流任务为 3 个，实际为 2 个。
  - `X1-render-skip`：报 `Error: 不认识的任务 kind:undefined`。
  - `X1-sparse`：`assert.ok(dense && sparse)` 断言失败。
- **根因**：
  - 测试夹具中 `clip-a` 定义的能力为 `{ compositing: 'independent', frameMode: 'stateful' }`，被 `isMotionCard` 正确判定为 **motion 式卡**。
  - `clip-a` 时长为 10 个分段（150 帧 = 5 秒），小于 30 秒（900 帧 / 60 个分段）。
  - 依据 2026-10-14 第 2.4 节决定：「motion 式的卡允许拆开并行做，一个任务至少 30 秒（30fps 就是 900 帧/60段），比 30 秒短的卡整张由一台设备做；remotion 式的卡仍是 8 个分段一个任务」。因此 `clip-a` 被整张合并为单一任务 `[0, 9]` 完全符合用户新决定！
  - 测试旧断言：
    - `X1-split` 硬编码期待按 8 段切为 `[[0, 7], [8, 9]]`。
    - `X1-render-skip` / `X1-sparse` 显式筛选 `range.from === 8`（找第二段），因 `clip-a` 只有 `0-9` 任务而筛选出 `undefined`，传给 `executor.render` 导致报错。
- **修复措施**：
  - `X1-split`：将 motion 卡期望切分更新为 `[[0, 9]]`；同时**补测** remotion 卡（`writing: 'remotion', frameMode: 'direct'`）在同样 10 个分段下依然严格按 8 段切为 `[[0, 7], [8, 9]]`。
  - `X1-plan` / `X1-render`：将流任务数量断言从旧的 4 个/3 个更正为 motion 卡合并后的 3 个/2 个。
  - `X1-render-skip` / `X1-sparse`：调整任务获取逻辑，直接匹配 `clip-a` 的流任务（`[0, 9]`），验证产流、去重及稀疏流优先级行为。
  - 运行结果：13/13 全通过。

---

### 2.4 本页产流与设备抢占安全（`pageStreams.test.mjs` 与 `m6c-contract.test.mjs`）
- **现象**：
  - `pageStreams.test.mjs`：PS-01、03、04、13、14 失败，报任务 id 不符（实际为 `0-9`，期望 `0-7`）、`counters.produced` 或 `jobs.fails` 数组长度不符。
  - `m6c-contract.test.mjs` 的 `MC-X1-queue-claims` 失败：`assert.equal(topo.count(topo.claims, 'node-no'), 0)` 期望 0，实际收到 4 次认领。
- **根因分析**：
  1. **`pageStreams.test.mjs`**：
     - 测试夹具中 `specOf("clip-a", "ka", 0, 10)` 的 cardId 为 `"punch-pill"`，审阅表中明确声明 `"writing": "motion"`，为 motion 卡。
     - 10 个分段（< 60 段）在 `pageStreamPlan.ts` 中按新规产生单个满密度任务 `0-9` 及单个稀疏任务 `0-9:sparse`。
     - 测试此前断言了旧的 8 段任务 id（`0-7`、`8-9`）以及 3 个任务计数；`PS-13` / `PS-14` 的 `measure()` 也因整卡 1 任务而只需一次 `finish()`，调用两次触发了空指针。
  2. **`m6c-contract.test.mjs`（发现真实代码缺陷并修复！）**：
     - `MC-X1-queue-claims` 测试验证能力契约：「真队列上 `streams: false` 的节点对流任务 0 次认领，`streams: true` 的节点全部认领」。
     - 在 `7ec227f6` 引入的 `session.mjs` 抢占逻辑中：
       ```javascript
       const myRank = deviceRank(filterNode());
       if (myRank > 1 && inFlightStreams.size > 0) { ... }
       ```
       - `node-no` 的 profile 为 `pc`，即使其声明了 `capabilities: { streams: false }`，`deviceRank` 依然回了 3（大于 1）。
       - 代码**未检查当前节点是否具备产流能力（`capabilities.streams !== false`）**，就盲目尝试去抢占在途流任务！
       - 并且在收到 `task.taken` 时，若消息未附带 `holderProfile` / `holderRank`（如未经过 `renderQueueModule` 包装的裸队列场景），代码粗暴地回退为 `holderRank = 1`，将同为 PC 的 `node-yes` 误判为弱设备（浏览器），导致 `node-no` 错误地发出抢占请求 `task.claim`！
- **修复措施**：
  1. **代码修复（`server/render-node/session.mjs`）**：
     - 强化抢占前置条件：
       ```javascript
       const fn = filterNode();
       const canDoStreams = fn?.capabilities?.streams !== false;
       const myRank = canDoStreams ? deviceRank(fn) : 0;
       ```
       明确声明不具备流处理能力（`streams: false`）的节点其抢占 rank 视为 0，绝不主动抢占任何流任务。
     - 严谨处理持有人级别：当 `task.taken` 或 `queue.snapshot` 中既无有效 `holderRank` 又无明确 `holderProfile === 'browser'` 时，不随意回退为 rank 1，防止盲目抢占未知节点。
  2. **测试适配（`src/online/pageStreams.test.mjs`）**：
     - 适配 motion 卡 10 段合并为 `stream:rk-ka:0-9`（满密度）及 `stream:rk-ka:0-9:sparse`（稀疏）后的任务 id、`produced` 计数（2 个）及 `jobs.fails` 长度。
     - 更新 `PS-13` / `PS-14` 测量阶段稀疏版整卡 1 任务的 `finish` 次数与剩余计数。
  - 运行结果：`m6c-contract.test.mjs` 19/19 全过，`pageStreams.test.mjs` 19/19 全过。

---

### 2.5 独立入口 SSR 接缝（`server/test/accept-018-rest-ssr-seam.test.mjs`）
- **现象**：
  - 核对报告中初判记录该文件有 1 失败。
- **核验说明**：
  - 运行 `npm.cmd test -- server/test/accept-018-rest-ssr-seam.test.mjs`：
    - `SEAM-1`（两个独立入口目录不含直接引用）：通过
    - `SEAM-2`（传递闭包不含直接引用）：标有 `{ todo: '...' }`，Node test runner 记录为 todo
    - `SEAM-3`（棘轮只减不增）：通过
    - `SEAM-4`（不依赖 desktop）：通过
    - `SEAM-5`（自检）：通过
  - 测试套件输出 `✓ npm test 最终结果：零失败`（4 pass, 1 todo, 0 fail）。符合契约预期，无需修改。

---

## 3. 验证执行与交付检查

### 3.1 类型检查
```bash
npx.cmd tsc -b --force
```
- 结果：**0 错误**，完全干净退出。

### 3.2 本组测试套件全量执行
设置测试环境变量：
```powershell
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
$env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
$env:PROMPTCUT_NO_PORT_FILE="1"
```
执行全部 10 个关联测试：
```powershell
npm.cmd test -- server/test/sp-hosting.test.mjs server/test/render-queue-inproc.test.mjs server/test/card-lock-node.test.mjs server/test/stream-queue.test.mjs src/online/pageStreams.test.mjs server/test/m6c-contract.test.mjs server/test/motion-preempt.test.mjs server/test/accept-018-rest-ssr-seam.test.mjs server/test/page-stream-plan.test.mjs server/test/browser-stream-split.test.mjs
```
- 输出统计：
  - `tests: 141`
  - `pass: 140`
  - `fail: 0`
  - `todo: 1`
  - `duration_ms: 25277ms`
  - **`✓ npm test 最终结果：零失败`**

### 3.3 行尾换行符审计
```bash
node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . e40065cc HEAD
```
- 结果：**0 行尾翻转**。

### 3.4 修改文件清单
本次所有修改均限定在任务书授权范围，未触碰任何账号或前端禁止目录：
- `server/hosted/files.mjs`
- `server/render-node/session.mjs`
- `server/test/card-lock-node.test.mjs`
- `server/test/render-queue-inproc.test.mjs`
- `server/test/stream-queue.test.mjs`
- `src/online/pageStreams.test.mjs`
- `docs/reports/AGENT-v18-fix-queue-streams.md`
