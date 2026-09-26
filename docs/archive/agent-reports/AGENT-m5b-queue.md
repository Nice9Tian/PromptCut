# AGENT 报告：M5b 队列部分（m5b-queue）

- 分支：`claude/rq-m5b-queue`（基于 `claude/rq-m5b` 的 `6533050`）
- worktree：`.worktrees/rq-m5b-queue`
- 依据：`docs/plan/render-queue-contract.md` I 节（I.1～I.7），以及 A、B.5、F（含 F.7）、H 节
- 改动文件：`server/render-queue/constants.mjs`、`server/render-queue/queue.mjs`、`server/render-node/session.mjs`。`messages.mjs` 没改：出站消息不校验枚举，`hidden`、`throttled` 不用登记。
- 没碰：`server/test/`、`server/docservice/`、`frame-pipeline.mjs`、渲染。本阶段不碰渲染，没跑 G0-R 和导出基线。

## 做了什么

| 条目 | 实现 |
|---|---|
| I.1 | `QUEUE_DEFAULTS` 加 `PREFILTER: true`、`THROTTLE_REJECTS: 20`，`QUEUE_ENV` 加 `PROMPTCUT_QUEUE_PREFILTER`、`PROMPTCUT_QUEUE_THROTTLE_REJECTS`。`createRenderQueue` 的 `constants` 覆盖：`PREFILTER` 只收布尔，其余照旧只收有限数。 |
| I.2 | `canSee` 末尾加 `C.PREFILTER && !envAllows(node, task)`。`envAllows`：节点没带指纹时放行；第 1 条比 `requires.envFingerprint`（非 plan）；第 2 条用 `lockIdOf` 取锁身份，锁在别的指纹上就不可见。snapshot、opened、taken、closed 都走 `canSee`，所以收件人一起变了。 |
| I.3 | 新增 `changeLock(key, mutate, except)`。每次改锁的指纹都经过它：认领建锁、`card.lock` 建锁、接手（发布和 `card.lock` 共用 `takeoverLock`）。它先记下改锁前每条 watch 连接能看见这个锁键下哪些 open 任务，改完再比一遍，只给可见性变了的连接发 `task.closed { state: 'hidden', reason: 'card-locked' }` 或 `task.opened`。这些消息在本步的回包之后发，经 `send`，所以 H.3 的合并键照旧适用。同一次 `task.publish` 里新建的任务不参与比对：它们的 `task.opened` 在这一步结束时按最后的可见性发，参与比对的话会重复发。认领建锁时，被认领的那个任务本身也不参与比对。`tick` 第 5 项删锁时，这把锁已经没有任何任务引用，不会有可见性变化，所以不用比对。 |
| I.4 | 第 3a 步 `card-locked` 原样保留。 |
| I.5 | 每条连接加 `cardLockedRejects`，每次回 `card-locked` 时加一（两种模式都计），`tick()` 结束时清零。`PREFILTER` 开着且计数 `> THROTTLE_REJECTS` 时，`onClaim` 一开头就回 `task.claim-rejected { id, reason: 'throttled' }`（带 reqId），任务状态不看也不改。 |
| I.6 | `session.mjs`：收到 `throttled` 时清掉在飞的认领，记 `throttledUntil = now() + SWEEP_INTERVAL_MS`，候选保留在视图里；`tick()` 在 `at < throttledUntil` 时不发认领，续约照常。`task.closed`（包括 hidden）原本就会把任务移出视图，这里只补了注释。 |
| I.7 | `describe()` 顶层加 `prefilter`；每个 `nodes[i]` 加 `cardLockedRejects`（这个节点当前那条连接的计数，节点已断开时记 0）和 `throttled`（`PREFILTER && cardLockedRejects > THROTTLE_REJECTS`）。 |

`PREFILTER: false` 时，`canSee` 与锁无关，`changeLock` 只做改锁这一步，限流也不生效。出站消息与改动前逐字节相同，差分自测见下文。`describe()` 在两种模式下都带 I.7 的新字段，这是契约要求的，K5 要读 `describe().prefilter`。

## 提交

- `e6e4e23` 文档:m5b-queue 报告骨架
- `fd1681d` 功能:队列按节点指纹前置过滤、锁变更定向增量、card-locked 拒绝限流;节点会话对 throttled 退避(契约 I.1～I.7)
- 本报告的提交（见分支最新）

## 验证

### 类型检查

`npx tsc -b --force`：退出码 0，零错误。

### 全量测试

`npm test`（默认 `PREFILTER: true`）：退出码 1。tests 2352、pass 2347、fail 4、skipped 1。4 条失败见下面「需要主会话裁决」一节。

对照组：临时把 `constants.mjs` 的缺省值改成 `PREFILTER: false` 跑了一遍 `npm test`，跑完已用 `git checkout` 还原，没提交。结果 pass 2349、fail 2：
- P14，失败原因同下；
- `render-node-ws.test.mjs` 的 T9：原因是「等两个节点报到超时（3000 ms）」，是全量并行下的时序抖动。单独跑这个文件 3 次都是 15/15 通过，与本改动无关。

开工前的基线：队列相关的 4 组测试（render-queue-*、card-lock-*、render-node-*、docservice-*）共 332 条，全部通过。

### 自测（scratch 脚本，不提交）

脚本放在 scratchpad：`m5b-selftest.mjs`、`m5b-diff.mjs`，用 `node <脚本>` 跑，两个都退出码 0。

**`m5b-selftest.mjs`（9 项全过）**

- **V1**：过滤开时，指纹 A 的节点在 `task.opened` 和 `queue.snapshot` 里只看得见 A 任务和不带指纹的任务，C 节点只看得见不带指纹的任务。不带指纹的节点三个都看得见。过滤关时所有节点三个都看得见。`describe().prefilter` 与开关一致。
- **V2**：A 节点认领建锁后，B 节点收到 `[{"type":"task.closed","id":"snapshot:rk-ck1-bbbb…:120-179","state":"hidden","reason":"card-locked"}]`。C 节点什么都没收到。不带指纹的节点只收到 `taken`。重新 watch 时，A 的 snapshot 有 a2，B 的是空的。
- **V3**（`card.lock` 带 takeover，锁从 A 转到 B）：
  - 过滤开：
    - a2 只收到 a2 的 hidden；
    - a（认领者）收到 hidden，另收到 a1 的 `lease-lost superseded`；
    - b、b2 各收到 b1、b2 的 `task.opened`，只有这两条；
    - c 收到 0 条；
    - 不带指纹的 n 收到两条 `closed failed`。
  - 过滤关：所有 watch 者都收到两条 `closed failed`，与改动前相同。
- **K1 / K2**：50 张卡，每张卡 A、B 两种指纹各 2 段，共 200 个任务。前 25 张卡预先被「另一种」指纹锁住，后 25 张由第一次认领定锁。两种指纹各 4 个节点，用真 `createNodeSession`、环回传输、假时钟，每 5 轮 `tick` 一次。

  | | 认领请求 | 认领成功 | card-locked 拒绝 | hidden | 可完成的完成数 | 异指纹锁卡收到的 `task.opened` |
  |---|---|---|---|---|---|---|
  | 过滤开 | 100 | 100 | **0** | 200 | 100/100 | **0** |
  | 过滤关 | 500 | 100 | **400** | 0 | 100/100 | 0 |

  两种模式下，每个完成的任务都恰好收到一次 `task.done`。
- **K3（简化）**：运行到第 3 轮，把 10 张被 A 锁住的卡接手给 B。
  - A 节点：nA0、nA1 各收到 10 条 hidden 和 1 条 `lease-lost superseded`，nA2、nA3 各收到 10 条 hidden；
  - B 节点：每个都只收到 20 条 `task.opened`；
  - 所有消息都属于被接手的卡。之后 card-locked 为 0，每个完成的任务恰好一次 `task.done`。
- **K4**：A 节点连续认领 25 张被 B 锁住的卡：
  - 前 21 次回 `card-locked`，之后回 `throttled`；
  - `describe(node-A)` 为 `{"cardLockedRejects":21,"throttled":true}`；
  - 限流期间，连可认领的任务也回 `throttled`，回包不带 `state` / `version`，任务状态不变；
  - a2 照常认领，`throttled: false`；
  - `advance(5000)` 触发 `tick` 后，计数归零，a 能正常认领。
  - 过滤关时，30 次全部回 `card-locked`，`describe` 为 `cardLockedRejects: 30, throttled: false`。
- **K6（简化）**：会话收到 `throttled` 后候选保留在视图里；`t=1000`、`t=4999` 两次 `tick` 只发了 `task.progress,task.progress`；`t=5000` 时恢复，发出 1 条认领。`hidden` 会把任务移出视图。

**`m5b-diff.mjs`**

- **对照组逐字节相同**：新队列开 `PREFILTER: false`，改动前的队列用 `git show 6533050` 取出来，两边用同一个种子跑同一串随机操作：发布（含 takeover、不带指纹的任务、流任务）、认领、完成 / 放回 / 失败 / 续约、`card.lock`（含接手）、断开重连、改 watch、退订、`tick`。20 个种子、每个 3000 步，共 **116830 条出站消息逐条 JSON 相同**。`describe()` 去掉 I.7 的新字段后也相同。
- **过滤开时视图一致**：每条 watch 连接按收到的增量重建本地视图，规则是 snapshot 整体替换、opened 加入、taken / closed / 自己的 claimed 移除。另外断言：`opened` 从不发给已经看得见这个任务的连接，`hidden` 只发给看得见它的连接。30 个种子、每个 4000 步（其间共 11182 条 hidden），最后每条连接的重建视图都等于重新 `queue.watch` 拿到的 snapshot。

## 需要主会话裁决（既有测试失败，没改测试）

1. **`render-queue-protocol.test.mjs` P14**：测试按 A.2 断言 `QUEUE_DEFAULTS` 恰好有 11 个键，I.1 新增了 `PREFILTER`、`THROTTLE_REJECTS` 两个。`QUEUE_ENV` 那条断言也会因为新增的两个名字失败，只是排在后面没跑到。**建议**：P14 的期望表补上这两项。契约 I.1 明确要求新增，没有别的改法。
2. **`card-lock-queue.test.mjs` 的 Q4「带 takeover 发布（全量核对）」、Q4「card.lock 带 takeover 同样接手」、Q11「没锁时带 takeover 发布」**：
   - 失败的断言：原指纹节点 `a` 在接手时应收到被作废任务的 `task.closed { state: 'failed' }`。实际情况：
     - Q4 两条：open 的 `…:120-179` 收到的是 `state: 'hidden'`（reason `card-locked`），claimed 的 `…:60-119` 什么都没收到；
     - Q11：两条都成了 `hidden`。
   - 原因：F.1 的接手顺序是先改锁，再作废原指纹的未完成任务。按 I.3，改锁那一刻这些任务还是 open，原指纹节点改锁前看得见、改锁后看不见，所以发 hidden。随后的 `closed failed` 按改锁后的可见性发，原指纹节点已经看不见，就不再收。V3 写的「X 节点收到这些任务的 hidden」也是这个意思：在带指纹的正常场景下，X 节点在接手时看得见的只有 X 指纹的任务，而它们正是被作废的那些。
   - 对节点没有实际影响：hidden 和 failed 一样会把任务移出本地视图；认领者照旧收到 `lease-lost superseded`；订阅者照旧收到 `task.failed`；不带指纹的 watch 者照旧收到 `closed failed`。
   - **建议**：这三条测的是 F.1 本身，与过滤无关，可以照 I.9 在测试里显式加 `constants: { PREFILTER: false }`，期望保持原样。另一种做法是把期望改成：open 的收 hidden，claimed 的不收。**不建议**为了保住 Q4 把实现改成「作废的任务按改锁前的可见性发 `closed failed`」：那样 V3 里 X 节点就收不到 hidden 了。这件事请主会话连同 V3 一起定。
3. `render-queue-inproc` 的 I6、`card-lock-node` 的 N5 / N6 都通过了，契约 I.9 担心的「看不见」导致失败没有出现。

## 契约疑点（都按保守读法实现，请确认）

1. **I.2 第 2 条用 `lockIdOf`，没用字面上的 `lockKeyOf`**：契约写的是「T 有锁键（lockKeyOf）」，但 F.1 规定「没有锁键或锁指纹的任务不参与锁」，Q9 也断言这类任务「不受锁影响」，认领时第 3a 步同样只看带锁指纹的任务。所以任务没带 `requires.envFingerprint` 时，就算它的卡被锁了，也不因为锁而藏起来。按字面读，这类任务会对异指纹节点隐藏，但节点照样可以认领它，与 3a 对不上。
2. **plan 任务不参与第 1 条**：与节点侧 `filter.mjs` 规则 1 一致，plan 不查指纹，谁认领谁的指纹就是这一版的指纹。plan 带了 `requires.envFingerprint` 也不藏；Q9 里就有这种 plan 任务。
3. **空串指纹当作没带**：节点 `hello` 的 `envFingerprint: ''` 能通过校验（`optStr`），按「没带」处理，第 1、2 条都不生效。任务的锁指纹本来就要求非空（F.1）。
4. **认领不按指纹拦**：语义 `document-service.md` 写的是「不发给该节点，也不让它认领」，契约 I.2 说可见性只决定 snapshot 和增量的收件人，I.4 也只保留 card-locked。所以指纹不符、但锁没挡住的任务，节点直接按 id 认领还能成功。这里照契约没加新的拒绝原因。要补的话需要新的 `reason`，还要改 `messages` 的文档。
5. **`describe().nodes` 的新字段**：I.7 说的是「每条节点连接」，`describe().nodes` 是按节点身份列的，所以取这个身份当前那条连接的值，节点已断开时记 0 / false。
6. **会话的 `throttledUntil` 在 `start()` 时不清**：I.6 没提。队列的计数挂在连接上，新连接不会被限流，所以重连后最多多等一个扫描周期。要清的话加一行就行。
7. **`describe()` 在 `PREFILTER: false` 时也带新字段**：「逐字节相同」按出站消息理解；I.7 和 K5 要求 `describe().prefilter` 在对照组里也能读到。

## 对任务书或语义的更正建议

- I.3 可以写明接手时「被作废的原指纹 open 任务」算在锁变更之内（原指纹节点收 hidden），以及 F.1 第 3 步「给可见的 watch 者发 `task.closed failed`」的可见性按改锁后算。这样 Q4 / Q11 与 V3 就不再矛盾。
- I.2 第 2 条可以改成「T 参与锁（有锁键和锁指纹，F.1）」，与 3a 和 Q9 对齐。

## 第二轮：按契约 I.10 补充（已合并 `claude/rq-m5b` 的 `8de7bc0`）

### 改动

- **第 4 条**：`queue.mjs` 的认领，在 `taken` 之后、第 3a 步之前新增一项判断。条件是 `PREFILTER` 为真、任务不是 plan、节点和任务都带非空指纹、且两个指纹不同。满足时回 `task.claim-rejected { id, reason: 'fingerprint-mismatch', state: 'open', version }`，带 reqId，任务状态不变，拒绝次数计入 `cardLockedRejects`（字段名没改，限流和诊断共用这一个计数）。
  - 放在这个位置有两个原因：契约要求回包带 `state`、`version`，taken 之后这里的 state 一定是 open；环境本来就不对的节点，也不必知道这张卡锁在谁那里。
  - 会话侧不用改代码：非 `stale`、非 `throttled` 的拒绝原本就按 `taken` 处理、丢掉候选，这里只补了注释。
- **第 5 条**：`session.mjs` 收到 `error` 时，只有消息不带 `reqId` 才清掉在飞的认领。
- **第 6 条**：`session.mjs` 的 `start()` 把 `throttledUntil` 重置为 `-Infinity`。
- **第 7、8 条**：第一轮已经是这样实现的，没再改。第 8 条的临界点有自测证据：第 21 次仍回原因，第 22 次起回 `throttled`。

### 验证

- `npx tsc -b --force`：退出码 0。
- `npm test`：退出码 1。tests 2352、pass 2346、fail 5、skipped 1。失败的 5 条：
  - P14、Q4（两条）、Q11：I.10 第 3 条已裁定由测试方改；
  - **新增 Q8**（`card-lock-queue.test.mjs`「describe().locks 的形状与排序……新 epoch 的队列没有锁」）：后半段让指纹 B 的节点 `b` 认领指纹 A 的任务 `snap('bb', FP_A)`，期望成功并且由认领建锁。按 I.10 第 4 条，这次认领现在回 `fingerprint-mismatch`。**需要主会话裁决**。建议后半段的 `h2` 显式传 `constants: { PREFILTER: false }`，这条测的是 F.1 的「新 epoch 没有锁」，与过滤无关；或者把节点换成指纹 A 的。
- 自测：
  - `m5b-selftest.mjs`：9 项全过。K1 过滤开时 card-locked 为 0、认领 100 次；过滤关时 card-locked 为 400、认领 500 次。
  - `m5b-diff.mjs`：`PREFILTER: false` 与改动前逐字节相同，20 个种子共 116830 条出站消息；过滤开时，30 个种子的增量视图都等于重新拿到的 snapshot。
  - 新增 `m5b-i10.mjs`，全过，覆盖：
    - 异指纹认领回 `fingerprint-mismatch`（带 state、version、reqId）；
    - 连续 25 次认领的回包是 21 次原因加 4 次 `throttled`，诊断为 `cardLockedRejects: 21, throttled: true`；
    - 任务不带指纹、plan 任务、节点指纹为空串，这三种都不拒；
    - 过滤关时照旧认领成功；
    - 会话把 `fingerprint-mismatch` 当 `taken`，丢掉候选；
    - 带 `reqId` 的 `error` 不清在飞的认领，不带的清；
    - `start()` 之后限流解除。
