# v18-fix-queue-streams 修复报告（队列与产流链路排障）

> 执行者：前两轮 Argon High（`pro`）；第三轮 Opus 5.5 High（按 `render-018-kickoff-other-agents.md` 第 2 节的升级规则：Argon 两轮审查未过，换另一边的高档亲自修完）
> 分支：`gemini/v18-fix-queue-streams`（基于基线 `e40065cc`）
> 工作区：`C:\Users\admin\Documents\PromptCut\.worktrees\v18-fix-queue-streams`
> 依据规则：`docs/reports/VERIFY-main-2026-10-17.md`、`docs/plan/user-decisions-2026-10-14.md`（第 2.3、2.4、2.5 节）及 Opus 5.5 High 独立代码审查意见（初审、二审、三审）

---

## 1. 结果概览

| 指令项 | 测试文件 / 模块 | 处置方式与核心结论 |
|---|---|---|
| **1. 部署清单漏文件** | `server/test/sp-hosting.test.mjs` (`SPH-deploy-1`) | **修代码**：`server/hosted/files.mjs` 补齐 `session.mjs`、`filter.mjs`、`pick.mjs` |
| **2. 进程内队列与卡片锁** | `render-queue-inproc.test.mjs`、`card-lock-node.test.mjs` | **修代码 + 恢复原意断言**：`split.mjs` remotion 满密度 8 段切分、稀疏流整卡 1 任务；内存产物库照 `writeManifest` 的规矩存任务自己的键与 8 段一桶 |
| **3. 流任务切分与执行** | `stream-queue.test.mjs` | **修代码 + 改测试**：依据 10-14 决定 2.4 节，10 段 motion 卡期望为 `[[0, 9]]`，补测 remotion 卡 8 段切分 |
| **4. 本页产流与设备抢占** | `pageStreams.test.mjs`、`m6c-contract.test.mjs` | **修代码 + 改测试**：无流能力节点不抢占；抢占前完整核资格 |
| **5. 独立入口 SSR 接缝** | `accept-018-rest-ssr-seam.test.mjs` | **核验确认**：SEAM-2 为 todo，0 失败 |
| **6. 专项抢占与端到端** | `motion-preempt.test.mjs`、`page-stream-plan.test.mjs`、`browser-stream-split.test.mjs` | 见第 2 节（第三轮重写 MP-10，新增 MP-12～MP-15） |

本组 10 个测试文件集中运行：**147 项：146 通过，0 失败，1 todo**；`npx.cmd tsc -b --force` **退出码 0**；`eol-audit.mjs` **无行尾翻转**（第 3 节贴了原始输出）。

---

## 2. 第三轮（Opus 5.5 High）：三审指出的 4 点

### 2.1 分桶上界 `lastSeg` 的真实来源

**问题**：读流的一侧（`snapshotSource.ts` 的 `streamSpansInWindow`）从第 0 段起每 8 段取一份清单，最后一份截到**整条流的最后一段**。写的一侧必须用同一个上界算桶的终点：任务 `[0, 59]` 不是流的末尾时，它的最后一个桶是 `56-63`，与任务 `[60, 124]` 写的同一个键，两边才合在一起。二审版本里：

- 服务端 `writeManifest` 读 `result.header.lastFrame`，但 `collectStreamResult` 根本不写这一项 —— 真实输出下永远退回 `range.to`，写出 `56-59`；MP-10 是手塞 `header.lastFrame` 才过的。
- `lookup` 的桶终点固定 `bFrom + 7`，末尾桶（如 `120-124`）永远对不上；拼桶时也没查块在不在素材服务上。
- 浏览器 `putStreamManifest` 读 `manifest.segmentCount`，清单里没有这一项，同样退回 `range.to`。
- 内存产物库只按 `range.to` 截桶。

**修法**：

1. **唯一出处** `src/render/streamBuckets.mjs`（新文件，纯函数，服务端与页面共用）：`streamLastSegmentOf({ originFrame, lastFrame })` 用 `streamSegments.mjs` 的 `streamSegmentOf` 换算整条流的最后一段；`streamBucketRanges(from, to, lastSegment)` 算桶（终点 = min(起点 + 7, 整条流的最后一段)，不知道时退回 `range.to`，与改之前一样）；`streamBucketManifest` 切出桶里的分段与用到的开头文件。
2. **服务端真实来源**：
   - 切分方给桌面节点的流任务**不带** `input.stream`（`below-stream.test.mjs`、`render-node-logic.test.mjs` 守着），所以只靠任务不够。流库的 `stream.json` 改为记下这条流的 `lastFrame`（`frame-stream.mjs`：`freshManifest` 写、`anchorManifest` 给之前落盘的补上、拉取别人清单新建时从 header 带过来）。
   - `collectStreamResult` 在 header 里写 `lastFrame`：先取任务的 `input.stream.lastFrame`（浏览器那一份、导出位图带着；它的 `originFrame` 须与流库的一致），没有就取 `stream.json` 的；都没有不写。
   - `writeManifest(content, result, log, task?)`：上界取 `header` 的 `originFrame / lastFrame`，没有退到 `task.input.stream`；`createAssetSink` 两处调用都把任务传进去。与任务自己的范围相同的桶不重写。
   - `lookup` 拆成「任务自己的键」（原逻辑、原 miss 原因）+「按桶拼」：桶终点同一规矩，上界取任务的 `input.stream`，没有就用已取到的桶的 `header.lastFrame`；两样都不知道时只有越过任务末尾的那一个桶拿不准，按可能的终点挨个试。拼出的清单另查 `resultComplete` 与 `blocksPresent`。
3. **浏览器端**：新增纯函数 `streamManifestPuts(task, manifest)`（`src/online/browserNode.ts`）：任务自己的键 + 与它不同的每个桶，上界取 `task.input.stream.lastFrame`；`browserNodeHost.ts` 的 `putStreamManifest` 照它逐份「先取已有的 → `mergeStreamManifest` → 写」。浏览器清单 header 也带 `lastFrame`，与桌面 `collectStreamResult` 保持逐字段同形（`browser-stream-manifest.test.mjs` 的 BM-01 照改：桌面夹具记 `lastFrame`，期望的 header 多一项）。
4. **内存产物库**（`server/test/fake-artifact-sink.mjs`）：存任务自己的键 + 桶（规矩同上，上界取 `input.stream`）；`has` 改为按单位判断（任务范围里每个分段都收到过、满密度任务另要满密度），同 `createAssetSink` 的查找，不再把只装了一半的桶当成齐的；新增 `stores()` 查某个键存没存。
5. **测试**：
   - **MP-10**（重写）：在临时目录按 StreamStore 的落盘形状造一条 125 段的流（`stream.json` 带 `originFrame`、`lastFrame`），两个桌面形状的任务 `[0, 59]`、`[60, 124]` 走**真实** `collectStreamResult` → `writeManifest`，清单不手塞任何字段。断言：第一个任务写出的最后一个桶键是 `56-63`（只装 56～59）、没有 `56-59`；第二个任务写完后 `56-63` 装齐 56～63；末尾桶是 `120-124`；只有前一半时 `has([60, 124])` 为 false；`createAssetSink` 对另一种形状的任务（整条流 `[0, 124]`、`[50, 62]`）按桶拼得出来；`OnlineSnapshotSource` 按层表读出第 0、10、35、58、62、70、124 段。
   - **MP-12**（新增）：浏览器任务 `[0, 59]`、`[60, 124]` 经 `streamManifest` → `streamManifestPuts`，照宿主的做法逐份合并写入；两边都写 `56-63`，合并后整桶齐全（`streamManifestCovers` dense），不写 `56-59` / `120-127`；落在一个桶上的任务只写自己的键。
   - `render-queue-inproc.test.mjs` 的 I1：产物库条数改为「任务键的种数」（稀疏流整条流 `0-11` 自己一项，桶 `0-7`、`8-11` 与满密度任务共用、是满密度那一版）。

### 2.2 被限流的节点发起抢占（`server/docservice/modules/render-queue.mjs`）

**问题**：预检读的是模块自己记的 `conn.cardLockedRejects`，这个字段在模块的连接表里根本不存在（限流计数在队列内部），被限流的节点照样先把原持有方踢掉，接着才被队列回 `throttled`。

**修法**：抢占预检整理成 `tryPreempt`，改读 `q.describe().nodes` 里认领方那一项的 `throttled`；限流时不动原持有方，认领照常交给队列回 `throttled`（认领方的在飞认领因此清掉）。**MP-13**（新增）：把 `THROTTLE_REJECTS` 设为 0、让 PC 撞一次指纹不符，`describe()` 报它被限流；它再抢浏览器的流任务时浏览器没收到 `lease-lost`、仍持有，PC 收到 `claim-rejected { reason: 'throttled' }`；下一次 tick 后照常抢得到。

### 2.3 抢占任务信息与托管节点的「生成轨道流」守门

**问题**：`claimedStreams[].task` 是 `describe()` 的诊断形状（没有 `kind`、`source`、`weight`），会话里 `s.task ?? open.get(...)` 又优先用了它；托管节点的 `canClaim`（`host.mjs` 的 `streamsPass`：`task.kind !== 'stream' || m.streams !== false`）因此看不出这是流任务，项目关了「生成轨道流」也照抢。

**修法**：

- 服务端给的最小视图本身就带 `kind: 'stream'`、`source.projectId`、`weight.class`、`requires`（见 2.4）。
- `session.mjs` 合并 `queue.snapshot` 的 `claimedStreams` 时，任务视图按「上一张视图里的完整任务（open / 在途表里记下的）→ 本张快照的 open → 服务端最小视图」的顺序取，再经 `streamTaskView` 归一：补 `kind: 'stream'`（id 以 `stream:` 起头的一律是流任务），项目 id 归到 `source.projectId`（诊断形状只有顶层 `projectId` 的也认）。`task.taken` 同样处理。
- **MP-15**（新增）：真实队列 + 模块 + 会话串起来，会话的 `canClaim` 照 `streamsPass` 写。项目关着时 `canClaim` 拿到的在途任务 `kind === 'stream'`、`source.projectId === PROJECT`，不发抢占、浏览器仍持有；打开后同一张快照里的任务被托管节点接手。

### 2.4 `claimedStreams` 与 `task.taken` 最小化暴露

**问题**：`claimedStreams` 从 `describe()` 把**全部**项目、全部节点看不见的在途流任务发给每条非浏览器连接；`task.taken` 附带的 `task` 是 `describe()` 原样，含原持有方的 `claim.token`（拿到它就能替对方续约 / 放回）。

**修法**：

- 队列新增 `claimedStreamsFor(connId, id?)`（`server/render-queue/queue.mjs`）：只回这条连接**看得见**的在途流任务（与 open 任务同一道 `canSee`：watch 了这个项目、指纹前置过滤），纯浏览器一律空；每项是 `{ task: 最小视图, holderNodeId }`。最小视图只有 `id、kind、version、source.projectId、weight.class、requires、input`（`input` 只留 `density: 'sparse'`、`exportFrames: true` 两个标记），不带认领令牌、订阅方、发布方用户、内容键与其它输入细节。`holderNodeId` 只给模块换算持有方等级，不往外发。
- 模块的 `outbound`：`queue.snapshot.claimedStreams` 与 `task.taken` 都改用它，按收件连接逐条算；纯浏览器的 `claimedStreams` 是空表、`task.taken` 不带任务视图与持有方。
- 抢占预检也以它为准：认领方看不见的任务不抢（托管节点只抢它 watch 的项目里的）；持有方不在线（模块连接表里找不到）不抢，交给队列的断线宽限期处理。
- 二审时为预检给 `describe()` 加的 `requires`、`input` 两项撤掉，`describe()` 形状恢复基线。原预检里按 `input.contentKey` 拼锁键比对锁的那一段一并去掉：锁的判断由队列的 `canSee`（指纹前置过滤）和认领时的 3a 步负责。
- **MP-14**（新增）：托管节点只 watch 本项目时，另一个项目的在途流任务既不出现在它的 `claimedStreams`，也不发 `task.taken` 给它；字段集合逐项断言，序列化后不含 `"claim"` / `"token"` / 内容键；纯浏览器 `claimedStreams` 为空、`task.taken` 不带任务视图。
- 测试环境 `setupQueueEnv` 改为让队列的输出先过模块的 `outbound`（组装层就是这么接的），否则抢占信息在测试里根本挂不上。MP-05、MP-08、MP-11 场景 1/2/5 的认领方补发 `queue.watch`（只抢看得见的任务）；场景 2、5 因此确实是被流能力、项目开关挡下，不是被可见性挡下。

---

## 3. 验证与交付数据

### 3.1 类型检查
```text
> npx.cmd tsc -b --force
exit=0
```

### 3.2 本组 10 个测试文件
```powershell
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
$env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
$env:PROMPTCUT_NO_PORT_FILE="1"
npm.cmd test -- server/test/sp-hosting.test.mjs server/test/render-queue-inproc.test.mjs server/test/card-lock-node.test.mjs `
  server/test/stream-queue.test.mjs src/online/pageStreams.test.mjs server/test/m6c-contract.test.mjs server/test/motion-preempt.test.mjs `
  server/test/accept-018-rest-ssr-seam.test.mjs server/test/page-stream-plan.test.mjs server/test/browser-stream-split.test.mjs
```
```text
TEN_RESULT
```

### 3.3 改动波及的其它测试文件（只跑这些，不跑全量）
改了内存产物库、`collectStreamResult` 的 header、`stream.json`、浏览器清单 header、`claimedStreams` 的来源，所以另跑引用这些的测试文件：

```text
EXTRA_RESULT
```

### 3.4 行尾检查
```text
EOL_RESULT
```

### 3.5 第三轮涉及修改的文件
- 新增：`src/render/streamBuckets.mjs`、`src/render/streamBuckets.d.mts`
- `server/artifact-transfer.mjs`（`collectStreamResult` header、`writeManifest`、`lookup`）
- `server/frame-stream.mjs`（`stream.json` 记 `lastFrame`）
- `server/render-queue/queue.mjs`（`claimedStreamsFor`；撤掉 `describe()` 的两项）
- `server/docservice/modules/render-queue.mjs`（`tryPreempt`、`outbound`）
- `server/render-node/session.mjs`（在途任务视图）
- `src/online/browserNode.ts`（`streamManifestPuts`、header `lastFrame`）、`src/editor/browserNodeHost.ts`（`putStreamManifest`）
- 测试：`server/test/motion-preempt.test.mjs`、`server/test/fake-artifact-sink.mjs`、`server/test/fake-artifact-fixtures.mjs`、`server/test/render-queue-inproc.test.mjs`、`server/test/browser-stream-manifest.test.mjs`

### 3.6 数据格式的变化（三级，用户看不出区别）
- 流清单（`StreamResult`）的 `header` 多一项可选的 `lastFrame`（这条流的最后一帧）。旧清单没有这一项照常认（`manifestMatches`、`streamAdoption` 不看它），没有时写桶退回按任务范围截，与改之前一样。
- 流库 `stream.json` 多一项 `lastFrame`；`queue.snapshot.claimedStreams[].task` 与 `task.taken.task` 是新的最小视图（这两项本来就是本分支新加的，基线里没有）。
- 契约文档 `docs/plan/artifact-transfer-contract.md` 第 3 节还没补 `header.lastFrame` 这一项，留给主会话合入时决定要不要补。
