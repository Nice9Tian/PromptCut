# AGENT-rq-m7-tests 报告

分支 `claude/rq-m7-tests`（起点 `origin/claude/c10-integ` 24c2c57）。任务：照 `docs/plan/m7-contract.md`（M7 = 纯浏览器节点这一阶段；按第 13 节主会话裁定）与 `docs/plan/render-queue-contract.md` 独立写 M7-T 单测（M7-T = M7 的测试分支），不看实现分支（`claude/rq-m7-queue`、以后的页面节点分支）。

## 做了什么

只加测试文件，没改任何生产代码：

| 文件 | 管什么 |
|---|---|
| `server/test/m7-kit.mjs` | 公共件：假设 K1～K11、门、夹具（任务、环境原始值、文档服务 + 队列模块 + 队列的试验台） |
| `server/test/m7-e5-b2.test.mjs` | E5（纯浏览器只见本人任务，分发与认领两层，同名不同设备算两人）、B2（只认领 light / medium 共享档快照）、D4（只收独立卡） |
| `server/test/m7-queue-lock.test.mjs` | D1 队列侧（建锁时作废另一份）、D2 队列侧（`lockIdleMs` / `lockedByProfile`、续约刷新 `touchedAt`） |
| `server/test/m7-credentials.test.mjs` | D9（profile 与 nodeId 绑凭证，自报不作数）、D10（指纹由服务端算）、D14 服务端这一侧 |
| `server/test/m7-split.test.mjs` | D1 切分侧（双份出键）与端到端、D2 切分侧的接手判定 |
| `server/test/m7-layer.test.mjs` | D12（层表 v3 候选、读 v2 兼容） |
| `server/test/m7-page-node.test.mjs` | 页面节点：当节点的条件（低内存档、单舞台、开发构建、非 Chromium 等）、D10 页面侧、第 4.1 节、D8 让路、D6 用任务的 projectRev |

代号：D1～D18 是契约第 11 节的待定点、第 13 节的裁定；K1～K11 是本测试方的接口假设（`m7-kit.mjs` 文件头）；M7-A1～A12 是契约第 10 节的验收编号。

## 用例清单（47 条）

现在就跑的（零件已在代码里，守回归）：

- E5 分发：A 一整轮发布、切分、认领、完成，别的用户与同名不同设备的纯浏览器收到 A 的任务消息 0 条，A 自己的纯浏览器看得见（M7-A1）；
- E5 分发：后 watch 的别人的纯浏览器，`queue.snapshot` 里没有 A 的任务；
- E5 认领：别人认领 A 的快照与 plan 一律 `forbidden`、不带 state / version；A 自己认领 plan 回 `plan-profile`（M7-A2）；
- E5：纯浏览器 `watch 'all'` 与摘要订阅一律 forbidden；
- B2 节点侧过滤：13 种任务逐条判（M7-A3 的任务表）；
- B2 跑满 60 s（假时钟）：真队列 + 纯浏览器节点会话，禁收的认领 0 次，light / medium 本人任务各认领一次并完成，别人的 0 次；
- D12 读旧 v2：给不给 `alive` 都照旧回那一层。

门后面的（实现不在时 skip，门一开就真跑）：

- D4：纯浏览器只收 `compositing === 'independent'`，pc 不受影响（1 条）；
- D1 队列侧：浏览器先认领则切分方那份全部作废、`attempts` 不变、不发 lease-lost、每个任务恰好一次 `task.done`；切分方先认领则浏览器那份作废；作废的不再占 `MAX_TASKS_PER_PROJECT`；不带 dual 的不变；只作废同锁键异指纹的；锁在第三种环境上两份都发不进（6 条）；
- D2 队列侧：认领回包、发布回包带 `lockIdleMs`、`lockedByProfile`；续约刷新 `touchedAt`；闲置超 30 s 后带 takeover 接手（4 条）；
- D9：`normalizeOwner` 认 browser；浏览器凭证以 pc / host 报到 forbidden 且不登记；M7-A2 末句（B 以 pc 报到拿不到 A 的任务）；nodeId 绑第一次报到的 userId（同名不同设备、别的用户、别的 owner 冒用都 forbidden，原节点不受影响）；同一 userId 重连照常；不带浏览器归属的连接照旧（6 条）；
- D10：welcome 回服务端算的指纹；自报指纹不作数（可见与认领都按服务端的）；只自报不报原始值的认领不到（3 条）；
- D14 服务端：Firefox、Safari 的节点一个快照任务也认领不到，哪怕键正好是它会撞的指纹（1 条）；
- D1 切分侧：可做的卡每段两份、键按 B.1、都 dual、都不带 takeover、浏览器那份带 `bake` 与 `compositing`、锚帧优先级一致；做不了的卡（heavy、本地档、非独立、用户卡、图卡、改过源码、锁在第三种环境）只出一份；不带意向时与今天相同；端到端（切分 → 发布 → 本人纯浏览器看得见浏览器那份、先认领得卡、切分方那份作废）（4 条）；
- D2 切分侧判定：严格大于 30 s 才接手，没有 `lockIdleMs` 不接手（1 条）；
- D12 v3：认定哪份活着就整份用哪份；认不出时 null 或整份一个候选、绝不混；只有一个候选当 v2 用；候选缺指纹不回（3 条）；
- 页面：当节点的条件（1 条，九种不当的情形）；D10 页面侧 hello（1 条）；认领到先 progress(0)、逐帧、complete 一次（1 条）；D8 让路 drag / play / urgent 各一条、隐藏一条（4 条）；D6 三条（3 条）。

todo（不算失败，待主会话定）：契约第 3.2 节写纯浏览器只收 `tier: 'shared'`，节点侧过滤规则 0～6 里没有 tier 这一条（今天靠切分方给本地档记 heavy、规则 4 挡住）。

## K 假设（集成对账只改 `m7-kit.mjs`）

- K1 通用：`.ts` 经 `src/testing/registerTs.mjs` import；门靠静态找标志或导出名。
- K2 D9：票据 `owner: { kind: 'browser' }` → principal 同 `memberPrincipal` 形状多一种 owner；`normalizeOwner` 认它；非 browser profile 与冒用 nodeId 回 `{ type: 'error', reason: 'forbidden' }`、不登记。门：模块或队列源码出现 `.owner`。
- K3 D10：hello 带 `environment: { platform, userAgent, renderer, vendor }`；服务端按 `describeEnvironment({ platform, renderer, vendor, chromeVersion: userAgent })` 算（与测量帧入库路由同一换算），`node.welcome.envFingerprint` 回它；自报的不作数。门：出现 `describeEnvironment`。
- K4 D1 队列：`input.dual: true`；建锁时同锁键异指纹 dual 的 open 任务进 failed / `superseded`。门：`queue.mjs` 出现 `dual`。
- K5 D2 队列：回包字段名 `lockIdleMs`、`lockedByProfile`；续约刷新 `touchedAt`（`describe().locks` 可见）。门：出现 `lockIdleMs`。
- K6 D1 切分：`splitPlan` 从 `planTask.input.browser` 读意向（测试同时传同名选项 `browser`）；浏览器那份 `input.bake` 带 `count`、`sampling` 两个键。门：`split.mjs` 出现 `dual`。
- K7 D4：`checkClaimable` 对纯浏览器只收 `input.compositing === 'independent'`。门：`filter.mjs` 出现 `compositing`。
- K8 D2 判定：导出 `fn(lockKey, lockedBy, { lockIdleMs, lockedByProfile }) → 布尔`，候选名与文件见 `IDLE_TAKEOVER_*`。
- K9 D12：v3 层带 `candidates: [{ resultKey, envFingerprint, key }]`（层上字段等于第一个候选）；`layerRefOf(table, clipId, { alive: Set<resultKey> })`。门：`KNOWN_LAYER_MAP_VERSIONS` 含 3。
- K10 当节点的条件：`fn({ online, codeVersion, lowMemory, stageLayout, userAgent, member, measured })` → 布尔或 `{ ok | eligible }`。
- K11 页面节点编排：`factory({ nodeId, projectId, userId, codeVersion, environment, now, isIdle, send, keptProject, fetchSnapshot, bakeFrame, finishTask })`，方法 `start / receive / tick / yieldFor(cause) / stop`（候选名见 `NODE_METHODS`）。这一条猜得最多，页面节点分支派出时建议把 K10、K11 直接写进它的任务书，或集成时改 `m7-kit.mjs` 的 `nodeRig`。

## 验证

- 本分支现状（门都关着）：`node --experimental-test-module-mocks --test server/test/m7-*.test.mjs` → tests 47、pass 7、fail 0、skipped 39、todo 1。
- 自检：照契约写了最小参考实现（队列 D1 / D2、队列模块 D9 / D10 / D14、`normalizeOwner`、filter D4、split D1、判定 K8、层表 v3 读法、页面节点 `src/online/browserNode.ts`），**不提交**，放在会话 scratchpad（`ref/apply.mjs`、`ref/browserNode.ts`、`ref/ref.diff`）。打上后同一命令 → tests 47、pass 46、fail 0、skipped 0、todo 1。自检中查出本测试方一处错：D1 端到端把页面自己的清单计划也算进纯浏览器看见的任务（它本来就该看得见），已改为只看细任务（提交 ee7b2c7）。
- 变异测试：在参考实现上逐处改错 30 次，每次跑对应测试文件，**30 次全部判红**：
  - 队列：作废时不看 dual；建锁时不作废；`lockIdleMs` 按 `since` 算；续约不刷新；不记 `lockedByProfile`；
  - 凭证：不查 profile；nodeId 不绑 userId；信自报指纹；不查 Chromium；
  - 切分：不看 compositing；浏览器那份带 takeover；浏览器那份指纹写错；判定用 `>=`；
  - 过滤：D4 连 pc 也挡；现有代码的分发不按 userId 挡、认领不按 userId 挡、只比用户名（同名不同设备算本人）、浏览器重度策略放进 heavy；
  - 层表：不看 alive；混候选（只换结果键）；v2 也要 alive；
  - 页面：资格不查低内存档、不查内核；隐藏也等当前帧；让路不等当前帧；让路改成暂停保持认领（D8 的选项 b）；D6 先拉快照；取不到版本拿当前版本渲；页面自己算指纹；不先报 progress(0)。
- 基线：见下「基线结果」。

## 没做成的及原因

- D1 页面侧「清单计划等 render 会话报到拿到指纹再发、最多等 3 s、`input.browser`」：要猜 `planPublisher` 的新接口，没写，留给页面节点分支的任务书。
- D12 写入方（切分完成后按实际出键写 v3 层表）：写入函数的形状契约没定（`layerMapOf` 从 card plan 出、不见细任务），没写；只测了页面读法与「不混候选」。
- 第 4.4、4.5 节（`foreignObject` 小尺寸、上传、清单形状 ≤ 256 KiB、`content.put`）、第 7 节诊断、M7-A4～A12 的计时与真页面项：要真浏览器或探针，不是模块级能测的；契约里写明由探针 `m7-browser-probe` 与主会话集成做，本分支没写探针（任务书只要单测）。
- D13（同键任务归属）：裁定维持现状，不写用例。

## 需要主会话定的事

1. **tier 一条**（todo 用例）：契约第 3.2 节把 `tier: 'shared'` 写成节点自挑的条件，但 `filter.mjs` 规则 0～6 没有；今天靠切分方给本地档记 heavy 挡住。要么契约改成「由重度间接挡」，要么 `claude/rq-m7-queue` 在节点侧加一条。
2. **D14 服务端要不要也挡**：契约只写「一期只在 Chromium 内核当节点」，没说服务端判。本测试方按 D10「指纹由服务端算」推论：服务端算出会撞的指纹时，这个节点一个任务也不该认领到（报到被拒或认领一律不给，二者都认）。若主会话认为只由页面挡，删 `m7-credentials.test.mjs` 最后一条即可。
3. **D9 nodeId 绑定的范围**：本测试方读成「浏览器凭证第一次报到的 nodeId，别的 userId 一律不能再用（包括桌面凭证）」。若只拦浏览器凭证之间，改那条用例里 `x3` 一项。
4. **D1 切分方那份被作废后的通知**：参考实现照 `takeoverLock` 给订阅者发 `task.failed { error: 'superseded' }`；页面要把它当「另一份活着」而不是失败。用例只断言状态，没断言页面怎么解读，页面节点分支要注意。
5. **K10、K11 的形状**：页面节点分支还没派，建议派出时把这两条写进任务书，省得集成返工。

## 基线结果


- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3610、pass 3568、fail 0、cancelled 0、skipped 41、todo 1。
  - 跳过 41 = 原有 2 条（`/api/cards/layout` 集成、SKILL 闸门集成，都要真 dev server）+ 本分支按门跳过 39 条：
    D4 1、D1 队列 6、D2 队列 4、D9 6（`normalizeOwner` 1 条的门在 `protocol.mjs`，其余 5 条的门是 `.owner`）、D10 3、D14 1、D1 切分 4、D2 判定 1、D12 v3 3、页面节点 10（条件 1、hello 1、第 4.1 节 1、D8 4、D6 3）。M7 集成后这 39 条必须全部转为真跑。
  - todo 1 是上面「tier 一条」：node:test 把失败的 todo 列进 failing 清单，但不计失败、不改退出码。
- 计时：全部用假时钟或「让出宏任务回合」，没有真实耗时断言，忙机上不会误报。
