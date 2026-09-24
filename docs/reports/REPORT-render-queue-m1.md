# 报告：渲染任务队列 M1（队列本体）与 M2（节点纯逻辑）

集成分支 `claude/rq-m1-m2`（worktree `.worktrees/rq-m1-m2`），基于 main 的 `e6c9e93`。2026-09-24。未合并 main，等用户审核。

- 依据：`docs/plan/distributed-prerender-queue.md`（设计，含 5.1 节 C1～C6）
- 任务书：`docs/plan/TASK-distributed-prerender-queue.md`
- 契约：`docs/plan/render-queue-contract.md`（主 Agent 定稿，含 A.10a 与 B.5 补充细则）

子 Agent 按 harness 规则不能写报告文件，四份报告由主 Agent 并在本文里（第 3 节）。

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | **tests 2072，pass 2071，fail 0，skipped 1**。原有基线 1912 条加新增 160 条。跳过的 1 条与之前相同：`集成:/api/cards/layout 对真实项目返回整数框`，需要 5190 的 dev server |
| 容错矩阵 | `server/test/render-queue-fault.test.mjs` | F1.1～F9.3 共 35 条全过 |
| 协议用例 | `server/test/render-queue-protocol.test.mjs` | P1～P14 加 P15（派生任务继承）共 15 条全过 |
| 状态机与随机序列 | `server/test/render-queue-state.test.mjs` | S-1～S-4 全过；S-4 固定种子 20260924，3000 步，每步逐条对账 |
| 节点纯逻辑 | `server/test/render-node-logic.test.mjs` | 67 条全过（B.1 13、B.2 22、B.3 9、B.4 23） |
| 节点会话 | `server/test/render-node-session.test.mjs` | 39 条全过，含 2 条「会话 × 真队列」联调：20 个任务，每个恰好完成一次；中途让路的任务被另一节点接手 |
| 边界约束 | `server/render-queue/`、`server/render-node/` | 不读环境变量、不开计时器、不做文件 I/O；除测试外没有任何模块引用它们（`server/vision/render-queue.ts` 是同名的旧模块，与本次无关，未改动） |

**首次对账**：测试方与实现方互不看对方代码，只照契约写。合进集成分支后：

- 队列测试 54 条首跑全过；
- 节点测试 103 条首跑 102 过。唯一不过的一条是契约没写的行为：重连接续后，实现把 `lastSentAt` 置为 `now - RENEW_INTERVAL_MS`，下一次 tick 立即续约。裁定以实现为准（理由见第 4 节），契约 B.5 补上细则，测试按细则拆成两条并补 2 条；
- 修订后 106 条全过。

## 2. 文件变更清单（相对 main）

| 文件 | 行数 | 归属 |
|---|---|---|
| `server/render-queue/constants.mjs` | 23 | Protocol/State |
| `server/render-queue/messages.mjs` | 195 | Protocol/State |
| `server/render-queue/queue.mjs` | 574 | Protocol/State |
| `server/render-queue/index.mjs` | 7 | Protocol/State |
| `server/render-node/fingerprint.mjs` | 84 | Pipeline/Node |
| `server/render-node/filter.mjs` | 100 | Pipeline/Node |
| `server/render-node/pick.mjs` | 42 | Pipeline/Node |
| `server/render-node/split.mjs` | 131 | Pipeline/Node |
| `server/render-node/session.mjs` | 234 | Pipeline/Node |
| `server/render-node/index.mjs` | 17 | Pipeline/Node |
| `server/test/fake-render-queue-env.mjs` | 197 | Verification（队列） |
| `server/test/render-queue-fault.test.mjs` | 809 | Verification（队列） |
| `server/test/render-queue-protocol.test.mjs` | 848 | Verification（队列） |
| `server/test/render-queue-state.test.mjs` | 819 | Verification（队列） |
| `server/test/render-node-logic.test.mjs` | 747 | Verification（节点） |
| `server/test/render-node-session.test.mjs` | 817 | Verification（节点） |
| `docs/plan/render-queue-contract.md` | 新建 | 主 Agent |
| `docs/plan/distributed-prerender-queue.md` | 第 5.1 节 C1～C6；4.2 伪代码的 `progress` 与契约对齐 | 主 Agent |
| `docs/plan/TASK-distributed-prerender-queue.md` | 第 7 节标为已确认 | 主 Agent |
| `docs/plan/TODO.md` | 状态更新 | 主 Agent |
| `docs/reports/REPORT-render-queue-m1.md` | 本文 | 主 Agent |

没有改动任何既有业务代码。

## 3. 各子 Agent 的工作（摘自它们交回的报告）

| 角色 | 分支 | 提交 | 做了什么 | 自测 |
|---|---|---|---|---|
| Protocol/State | `claude/rq-m1-state` | `ba12a8e`、`713d1f4`、`de2225b`、`c75665c` | 任务书 S1～S11：常量、消息校验与出站构造、发布与幂等合并、退订、节点报到与可见性、认领（gone → forbidden → taken → stale）、令牌栅栏、四项扫描（严格大于）、连接生命周期与宽限、epoch、`describe()`；按契约修订加了派生任务继承和「无订阅者放回即删」 | 临时目录一次性脚本 19/19 组，含 5000 步随机序列 |
| Pipeline/Node | `claude/rq-m2-node` | `c7b5fcc`、`4ddba09`、`8e64959`、`cc3c0d4`、`fa3ad1a` | 环境指纹与结果键、过滤规则 0～6 与重度策略、前 K 随机挑选与同优先级按项目轮转、`planTaskOf` / `splitPlan`（段切分、锚帧优先级、去重）、节点会话状态机（认领节流、续约、stale 重试、让路、重连） | 29 条，含用真实 `CardFrameCache.plan()` 夹具的切分、会话 × 假队列的同步与异步接线各 5 个种子、节点卡死后被接手 |
| Verification（队列） | `claude/rq-tests-queue` | `8bc8ed9`、`138d745`、`e004522`、`c3ecdc6` | 假件与三份测试，54 条；每条断言任务状态、每条连接的消息、`describe()` 三样；所有时间窗口都测「恰好到点不动、多 1 ms 才动」 | 对照契约写的假实现 54/54；注入 19 个变异全部被抓到 |
| Verification（节点） | `claude/rq-tests-node` | `151ef2f`、`7f8eeb0`、`562d91c`、`ce4de14` | 两份测试，106 条；哈希期望值用公式独立算，不借被测函数 | 对照契约写的假实现 103/103；注入 18 个变异全部被抓到 |

**集成**：主 Agent 用 `--no-ff` 依次合并，集成提交 `edccd95`、`c50451d`、`94fee05`、`68b85c1`、`97ac2bb`。

## 4. 主 Agent 的裁决（冲突一律以设计为准）

| 来源 | 问题 | 裁决 |
|---|---|---|
| 节点方 | 契约 A.4 让队列按发布连接填 `userId`，与设计第 3 节「细任务继承 plan 任务的 userId，不取切分节点的身份」冲突：纯浏览器节点会看不到本人的细任务，页面也收不到细任务的 `task.done` | 以设计为准。契约 A.4 加「派生任务的继承」：plan 此刻由发布连接的节点认领时，细任务继承它的 `userId` / `tenantId` 和订阅者。条件限定为「认领者就是本节点」，防止冒用 |
| 队列方 | 没有订阅者的任务被 release 后会永远留着 | 同 A.7.6，放回时也删除；`fail-ack` 的 state 可以是 `removed` |
| 队列方 | 令牌取认领时的 `version`，任务过 TTL 重建后可能重号 | 维持设计 4.2 的字面（令牌 = 认领时的 version，测试 S-2 按此断言），列为已知限制。别的节点靠 `nodeId` 核对挡住；同一节点的残留旧 worker 最坏拿旧令牌完成新一轮认领，但产物按内容寻址，内容相同 |
| 双方 | lastError 何时写、`progress.done` 取值、被取代的旧连接、校验顺序、reqId 回显、缺省字段、TTL 惰性判断等 11 项契约未写死的细节 | 全部按实现方的做法写进契约 A.10a，测试方按 A.10a 核对 |
| 节点测试 | 重连接续后要不要立即续约 | 以实现为准：断线宽限 10 s 加续约间隔 10 s，最坏情况会顶到 30 s 租约的边界。契约 B.5 补细则 |
| 节点测试 | `onLost` 重复调用、迟到 `lease-lost`、`start()` 清在飞、让路时认领在飞、认领后移出本地视图、流段起点、gpu 字符串拼接 | 实现已经按稳妥的方式处理，照实现写进 B.5 补充细则 |
| 队列测试 | resume 里列了自己名下的任务、但令牌不对 | 实现已按 `not-resumed` 放弃，写进 A.10a |
| 队列测试 | 纯浏览器 resume 被回绝时，reason 暴露任务是否存在 | 接受：只回显它自己给的 id，不带内容和归属 |

## 5. 遗留与建议（不在 M1 / M2 范围内）

- **令牌重号**：见第 4 节。以后可以改成队列全局递增的序号，要同时改设计 4.2 和测试 S-2。
- **M3 调用方要做的**：
  - 切分节点除 `node.hello` 外，还要在同一连接上 `publisher.hello`，才能发布细任务（契约 A.5）；
  - `task.claim` 没带 `reqId`，`error` 回包对不上是哪一条请求，会话按兜底清在飞。以后可以在契约里给认领加 `reqId`。
- **浏览器可用性**：`render-node/index.mjs` 会连带引入 `snapshot-store.mjs`（带 pngjs）和 `node:crypto`，不能整体在浏览器里用。M7 的纯浏览器节点只引 `session.mjs`、`filter.mjs`、`pick.mjs`，或者到时把哈希换成浏览器也能用的实现。
- **任务书 5.2 的更正**：
  - 约定写「常量用基线值」，但 F3.3 要证明「从未报进度就不看停滞」，只有把 `STALL_MS` 调得比租约短才看得出来。测试多加了一组覆盖常量的检查；
  - 协议用例表应补上 P15。
- **设计文字待同步**：4.1 的 `task.taken` 发给「其它」watch 者；4.2 的 `claimed` 回包按契约写成 `{ id, token, version, leaseUntil, task }`；第 3 节示例的 `progress.at` 应为 `changedAt`。
- **发布方断开期间的 `task.done`**：这段时间里完成的任务，通知会丢。要靠重连后重新 `publish`，借 `DONE_TTL` 补回来。以后在设计第 5 节写明。

## 6. 需要用户决定

- 是否把 `claude/rq-m1-m2` 合并进 main（`--no-ff`）。
- 合并后是否清理五个 worktree（`.worktrees/` 下，都没有 junction）和对应分支。
