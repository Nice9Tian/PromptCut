# AGENT 报告：m5b-queue-tests

角色：M5b 队列部分的测试方。分工是对抗式的：只照契约写，没看 `claude/rq-m5b-queue`。
分支：`claude/rq-m5b-queue-tests`，从 `claude/rq-m5b` 起。
依据：`docs/plan/render-queue-contract.md` 的 I 节（用例表 I.8），以及 A、B.5、D.3、F 节。

## 做了什么

新建了 `server/test/render-queue-prefilter.test.mjs`，共 13 条用例，每个编号至少一条：

| 编号 | 用例 | 怎么驱动 |
|---|---|---|
| V1 | 指纹不同的任务：`queue.snapshot`、`task.opened` 都看不见；不带指纹的节点全看得见；`task.taken` / `task.closed` 的收件人同样按可见性 | `createQueueHarness`，过滤开 / 关各跑一遍 |
| V2 | 锁在别的指纹上时看不见（不带指纹、但有锁键的任务也看不见）；锁在自己的指纹上时看得见；不带指纹的节点不受第 2 条限制 | 同上 |
| V3 | 接手 X→Y：X 收到撤回（不带指纹的任务是 `hidden` / `card-locked`），Y 收到 `task.opened`，Z 收到 0 条；别的卡不受影响 | 同上 |
| K1 | 两种指纹各 4 个节点，20 张卡 × 两种指纹 × 5 段 = 200 个任务；一半的卡锁在 A 上，另一半锁在 B 上。过滤开时 `card-locked` 为 0，且不超过认领数的 1%；过滤关作对照，断言对照组确实出现拒绝 | 环回 + 真队列 + 8 个 B.5 会话，假时钟 |
| K2 | 同 K1 场景：过滤开时，不匹配的节点在锁定之后收到已锁卡任务的 `task.opened` 为 0；锁新建时，每个节点收到的 `hidden` 撤回恰好是本指纹的死任务 | 同上（场景只跑一次，K1、K2 共用） |
| K3 | 运行中把 20 张卡从 X 接手给 Y：X 节点恰好收到这 40 个任务的撤回，Y 节点恰好收到 40 个补发，Z 节点 0 条；跑到底，每个任务恰好一次 `task.done`，作废的恰好一次 `task.failed`（`superseded`） | 环回 + 会话，X/Y/Z 共 4+4+2 个节点 |
| K4 ×2 | 无视过滤的节点：前 21 次 `card-locked`，之后一律 `throttled`（可认领的任务、不存在的任务也一样，不改状态）；其它节点照常认领、各自计数；`tick()` 后恢复。另一条验证阈值取 `constants.THROTTLE_REJECTS` | `createQueueHarness` |
| K5 ×2 | 过滤关：`describe().prefilter === false`，锁新建、接手、不带指纹的任务都不产生 `hidden`；另一条核对 I.1 常量、环境变量名、I.7 的 `describe` 新字段 | `createQueueHarness` |
| K6 ×3 | 会话收到 `throttled` 后：候选不删；`SWEEP_INTERVAL_MS` 之内（在 `-1` 毫秒处验）不认领、续约照发；到点恢复；`constants.SWEEP_INTERVAL_MS` 可覆盖；`task.closed { state: 'hidden' }` 会把任务从 `known()` 里删掉 | 手写回包 |

两种开关都跑的用例，先跑关（对照组）再跑开，这样实现还没合进来时，对照组的数字也能先用 `t.diagnostic` 写进输出。

没有新建假件：用的是既有的 `fake-render-queue-env.mjs`（`createQueueHarness`、`makeTaskInput`、`createFakeClock`）和 `fake-loopback-transport.mjs`（`createLoopback`）。

## 验证

- `node --check server/test/render-queue-prefilter.test.mjs`：退出码 0。
- 在当前分支（实现还没合进来）上跑 `node --experimental-test-module-mocks --test server/test/render-queue-prefilter.test.mjs`：13 条里通过 1 条、失败 12 条，符合预期，整个文件约 0.2 秒。
  - 通过：K6 补充（hidden 从视图移除）。现有会话本来就对所有 `task.closed` 移除任务。
  - 失败：V1、V2、V3、K1、K2、K3、K4、K4 补充、K5、K5 常量、K6、K6 补充。都是因为前置过滤、限流、`prefilter` 字段和会话退避还没有实现。每条的对照组部分（过滤关）在现有代码上都能过，失败只出在过滤开的部分，或者出在新字段上。
- `npm test`：共 2365 条，通过 2352、失败 12、跳过 1。失败的 12 条都在新文件里；既有测试全部通过；跳过的那 1 条原本就跳过。
- `npx tsc -b --force`：退出码 0。
- **用参考实现自检**：在 scratchpad 里拷了一份队列和会话，按契约 I.1～I.7 打了一个最小补丁，然后跑本文件：13 条全过。原始数字如下：
  - K1：过滤关时认领 526 次、`card-locked` 400 次；过滤开时认领 120 次、`card-locked` 0 次；两边的活任务都 100 个做完。
  - K2：锁定之后给不匹配节点的 `task.opened`，过滤关 400 条，过滤开 0 条；锁定时的 `hidden` 撤回，过滤开 400 条。
  - K3：接手那一步，过滤关时 X、Y、Z 节点分别收到 160、160、80 条 `closed:failed`；过滤开时 X 收到 160 条 `closed:failed`，Y 收到 160 条 `opened`，Z 收到 0 条。
  - K4：过滤开时 21 次 `card-locked`，之后 9 次 `throttled`；过滤关时 30 次都是 `card-locked`。
- **变异检验**：对参考实现做了 4 种变异，每种都有测试抓到。
  - 限流阈值写成 `>=`：K4 两条失败；
  - `card.lock` 新建锁时不发增量：K1、K2 失败；
  - 作废任务的撤回按变更后的可见性发：V3、K3 失败；
  - `tick()` 不清零计数：K4 两条失败。
- 参考实现只用于自检，已从 scratchpad 删除，没有提交。

## 契约疑点和更正建议

1. **接手时，作废任务的撤回按哪一刻的可见性发（I.3 与 F.1 的交界）。** 接手时，X 指纹的任务照 F.1 作废为 `failed`，并给「可见的 watch 者」发 `task.closed { state: 'failed' }`。如果按变更**之后**的可见性算，X 节点已经看不见这些任务，结果谁都收不到，X 节点的视图里会残留死任务。I.3 的 `hidden` 只针对变更后仍是 `open` 的任务。V3 / K3 要求 X 节点对每个作废任务**恰好收到一条** `task.closed`，`state` 是 `failed` 或 `hidden` 都接受。建议在契约里写明：作废消息按变更**之前**的可见性发。
2. **I.2 第 2 条对不带指纹的任务也生效。** 这条的条件只要求「T 有锁键」，所以有 `contentKey`、但没有 `requires.envFingerprint` 的任务会按锁的指纹隐藏。而 F.1 说这种任务「不参与锁」：不被拒建、不被作废、认领时不查锁。V2 / V3 是照 I.2 的字面写的。如果主 Agent 的本意是「不参与锁的任务也不受第 2 条限制」，需要改 I.2，同时改 V2 / V3 里 `tN` 的期望。
3. **K1 的「认领到全部完成」。** 按 F.1 / F.7，指纹与锁不同的任务谁都认领不了：没有接手，它们就一直 `open`。所以 K1 定义的「全部完成」是：与锁同指纹的 100 个活任务全部完成，另外 100 个死任务始终 `open`、`version` 为 1。死任务只能在锁定**之前**建出来，因为锁定之后 F.7 会拒建，所以场景的顺序是「先发布死任务 → 再 `card.lock` → 再发布活任务」。
4. **K1 没有构造竞态窗口。** 锁都在节点开始认领之前定好，所以过滤开时是严格 0 次拒绝，1% 的上限自然也满足。只有「首次认领建锁」和锁变更与在飞的认领交错时，才会出现竞态窗口；在环回里构造这种情形不稳定，这次没做。
5. **限流的临界点。** 按「超过 `THROTTLE_REJECTS`」的字面理解：第 1～21 次拒绝都是 `card-locked`，从第 22 次认领起回 `throttled`。实现方如果写成「达到 20」就会不符，K4 会抓到。
6. **`throttled` 回包的形状。** 按 I.5 的字面，只断言了 `id` 和 `reason`，没有要求 `state` / `version`。
7. **既有测试预计会失败，I.9 的「不改既有测试」做不到。** 在参考实现上跑既有测试，134 条里有 4 条失败：
   - `card-lock-queue` 的 Q4 两条和 Q11：带指纹 B 的节点期望收到 A 指纹作废任务的 `task.closed failed`，开了前置过滤后它本来就看不见这些任务。这是 I.9 已经预见的情形，需要主 Agent 裁决：在这几条里显式加 `PREFILTER: false`，还是改期望。
   - `render-queue-protocol` 的 P14：它把 `QUEUE_DEFAULTS` / `QUEUE_ENV` 的键全量钉死了，而 I.1 要求新增两个键，所以这条**必然**失败，只能改期望。建议在 I.9 里把 P14 列为例外。
   - `render-queue-inproc` 的 I6，在我的参考实现上是通过的。

## 没做的

- 没改任何生产代码和既有测试，没有标记 skip。
- 没推送、没合并、没建 junction、没跑 `npm ci`。
