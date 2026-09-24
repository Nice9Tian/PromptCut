# 卡片级指纹锁：队列侧（Protocol/State）报告

- 分支：`claude/rq-card-lock-queue`（基于契约提交 bc3004a）
- 规格：`docs/plan/render-queue-contract.md` F.1（改 A.4～A.8、A.10）；设计 2.1「谁定指纹」
- 文件范围：`server/render-queue/queue.mjs`、`messages.mjs`、`index.mjs`。`constants.mjs` 没改（锁回收用现有的 `DONE_TTL`）
- 没写 `server/test/`，没改文档服务

## 逐文件做了什么

### `server/render-queue/messages.mjs`

- `TaskInput` 新增可选的 `takeover`：只有 `undefined` 算没给；`null` 和其它非布尔值都判为整条 `bad-message`，和 `task.fail` 的 `retryable` 一样处理。校验结果里带 `takeover: boolean`，但队列建任务时不存它，`TaskView` 不变。
- 新增并导出 `lockKeyOf(task)`：`kind` 是 `snapshot` / `stream`，且 `input.contentKey` 是非空字符串时返回 `` `${kind}:${contentKey}` ``，其余情况返回 `null`。入站任务、TaskView、队列内部的任务都可以传进来，传入非对象也不抛。
- 新增入站消息 `card.lock`，字段是 `kind`（`snapshot` / `stream`）、`contentKey`（非空）、`envFingerprint`（非空）、`takeover?`（布尔），格式不对整条 `bad-message`。
- `card.lock` 加进了 `PUBLISHER_TYPES`，文档服务按这个集合路由，不用改文档服务。

### `server/render-queue/index.mjs`

- 多导出一个 `lockKeyOf`。

### `server/render-queue/queue.mjs`

- **锁表**：`locks: Map<lockKey, { envFingerprint, source, since, touchedAt }>`，只在内存里，新实例从空开始。
- **`lockIdOf(task)`**（内部用）：返回锁键加锁指纹 `requires.envFingerprint`（非空字符串）。两样缺一样就返回 `null`，这个任务既不参与锁，也不受锁影响（Q9）。
- **认领**：
  - 在第 3 步 `taken` 和第 4 步 `stale` 之间加第 3a 步。锁在别的指纹上时回 `claim-rejected { reason: 'card-locked', state: 'open', version, lockedBy }`，版本不变。
  - 认领成功时：没锁就建锁，`source` 记 `'claim'`；锁在同一指纹上就刷新 `touchedAt`。
- **发布**：
  - 原来处理已有同 `id` 任务的那段拆成了 `mergeExisting`，行为不变。
  - 每项在原有处理之后调 `lockOnPublish`，照 F.1 的表：
    - 没锁、带 `takeover`：建锁，`source` 记 `'takeover'`；
    - 没锁、不带 `takeover`：不建锁；
    - 锁在同一指纹上：刷新 `touchedAt`；
    - 锁在别的指纹上、带 `takeover`：接手；
    - 锁在别的指纹上、不带 `takeover`：回包里这一项加 `lockedBy`。
- **接手**：`takeoverLock` 由 `card.lock` 和发布共用。
  - 先把锁改成 `{ F, 'takeover', since: now, touchedAt: now }`。
  - 再处理锁键是 L、锁指纹不是 F、状态是 `open` 或 `claimed` 的每个任务：`version` 加 1，状态改成 `failed`，记 `finishedAt`，`lastError` 记 `'superseded'`，`attempts` 不变，`claim` 清空。
  - 状态全部改完、主回包发出去以后，再逐个任务发通知，顺序是：
    1. 原认领者的连接还在时，给它发 `task.lease-lost { reason: 'superseded' }`；
    2. 给订阅者发 `task.failed { error: 'superseded' }`；
    3. 给 watch 者发 `task.closed { state: 'failed' }`。
  - `done` 的任务不动。
- **`card.lock`**：
  - 没锁时建锁，`source` 记 `'lock'`；
  - 锁在同一指纹上时刷新 `touchedAt`；
  - 锁在别的指纹上时，带 `takeover` 就接手，不带就不动。
  - 回包是 `card.locked { lockKey, envFingerprint: 处理后锁上的指纹, granted }`，带 `reqId`；接手引起的通知排在回包之后。
- **完成**：锁存在就刷新 `touchedAt`。
- **`tick()` 第 5 项**：在前四项之后执行。表里没有任何任务的 `lockKeyOf` 等于 L，且 `now - touchedAt >= DONE_TTL`，就删掉 L。它排在 TTL 扫描之后，所以同一次 tick 里刚过期被删的任务不再算引用。
- **`describe()`**：新增 `locks: [{ lockKey, envFingerprint, source, since, touchedAt }]`，按 `lockKey` 升序，照旧返回深拷贝。

## 验证

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 1。共 2121 个测试，通过 2119，失败 1，跳过 1。
- 文档服务测试和三份队列单测一起跑（`docservice`、`render-queue-state`、`render-queue-protocol`、`render-queue-fault`）：72 个测试，72 个通过，0 失败。
- 另外在 scratchpad 里写了冒烟脚本，跑了一遍锁的主要路径，全部断言通过。覆盖的路径：
  - `card.lock` 回 `not-registered`；
  - 带非法 `takeover` 的发布回 `bad-message`，状态不变；
  - 首次认领建锁；
  - 异指纹认领回 `card-locked`；
  - 发布回包里的 `lockedBy`；
  - `card.lock` 的三种情况，以及 `kind: 'plan'` 回 `bad-message`；
  - 带 `takeover` 发布引起接手：认领者收到 `lease-lost`，订阅者收到 `task.failed`，watch 者收到 `task.closed`；
  - tick 回收没有任务引用的锁。

  这个脚本不入库。

### 失败清单与归类

| 测试 | 归类 | 说明 |
|---|---|---|
| `server/test/render-queue-inproc.test.mjs` I6「两种环境指纹的 pc 节点…」 | **F.1 锁语义直接导致的预期变化**，不是实现缺陷 | 见下文 |

I6 为什么失败：

- 第一轮由 FP_B 节点认领 plan，细任务被 FP_B 认领，每张卡、每条流都锁在 FP_B 上（失败时 `describe().locks` 里 4 把锁都是 `fedcba9876543210`，`source: 'claim'`）。
- 第二轮由 FP_A 节点切分。内容键没变，锁键也就没变；测试的 PlanContext 没给 `cardLocks`，切分出的是 FP_A 的细任务，认领全部回 `card-locked`，任务一直停在 `open`，`drive` 超过 4000 步后超时。
- 把 `server/render-queue/` 临时换回 bc3004a 单独跑 I6，结果通过。用完已换回 HEAD，工作区干净。所以失败只来自本次的锁。
- 这正是 F.1 和设计 2.1 要的效果：已被别的环境锁定的卡不再混入另一种环境的帧。
- 测试按我的文件范围没有改。按 F.5「既有测试因本节失效的，只按本节改输入或期望」，应由 Verification 调整第二轮的期望。例如第二轮给 PlanContext 带上 `cardLocks`，期望第二轮的细任务按 FP_B 出键、由 FP_B 节点完成；或者让第二轮的内容键变化。

## 契约疑点与我的选择（没改契约）

1. **`takeover: null`**：F.1 写的是「不是布尔就整条 `bad-message`」。其它可选字段把 `null` 当作没给，这里我按原文把 `null` 也判为 `bad-message`，和 `retryable` 一致。
2. **发布项因 `limit` 没建成时不看锁**：F.1 只说「逐个任务在原有处理之后看锁」。任务没建成时如果照样接手，旧指纹的任务作废了，却没有新任务顶上，所以这一项跳过锁处理。
3. **发布时锁身份取哪一份**：已有同 `id` 任务时，锁键和锁指纹取表里存的任务，不取这次入站的；新建的任务两者本来就相同。这样和认领第 3a 步查的是同一份。`id` 按内容寻址，两者实际不会不同。
4. **没锁时带 `takeover`**：
   - 发布：按表只建锁（`source: 'takeover'`），不作废别的指纹的任务；
   - `card.lock`：按原文建锁，`source: 'lock'`，不记 `'takeover'`。
   - 边角情形：这时如果表里已有同锁键的异指纹 `open` 任务（两个节点几乎同时切分），它们会一直回 `card-locked`、停在 `open`，只有等订阅者退订或宽限期过后才会被删。
   - 建议主 Agent 考虑：「没锁 + takeover」也走一遍作废。
5. **锁回收的比较**：F.1 写的是 `>=` 和 `DONE_TTL_MS`，A.8 说前四项一律严格大于，常量名实际是 `DONE_TTL`。实现照 F.1 用 `>=`，常量用 `C.DONE_TTL`。建议契约把名字改成 `DONE_TTL`。
6. **第 5 项的「引用」**：按原文，只看表里任务的 `lockKeyOf`，不要求任务也有锁指纹。有锁键、没有指纹的任务也算引用，锁不回收。
7. **接手时的消息顺序**：F.1 只写了先给原认领者发 `lease-lost`、再清 `claim`。实现是先改完全部状态，发主回包（`task.published` 或 `card.locked`），然后按任务逐个发 `lease-lost`、`task.failed`、`task.closed`。这和现有的「回包在前、通知在后」一致。
8. **被别的指纹锁住的任务没人能做（语义层面的缺口，建议主 Agent 裁定）**：
   - 切分节点只能从 PlanContext 的 `cardLocks` 知道锁（F.2），队列没有「查锁」的消息。`card.lock` 在没锁时会建锁，不能拿来查。
   - 分布式场景里，一个不同指纹的节点切分时，如果不知道队列上的锁，发出去的细任务会一直回 `card-locked`：停在 `open`，不失败，页面也收不到 `task.failed`。I6 就是这种情形。
   - 发布回包里的 `lockedBy` 能让切分节点知道这件事，但 F.2 没规定节点收到后怎么办（改用锁指纹重发，或者接手）。
   - 建议在 F.2 补一条：切分节点看到 `results[i].lockedBy` 时，按锁指纹重新出键并发布；或者由队列把这类任务直接判 `failed`（`card-locked`）。
9. **被作废的任务在 TTL 内拿不回来**：已作废（`failed` / `superseded`）的任务，在 `DONE_TTL` 内同 `id` 重新发布时，按 C1 仍然是 `failed`。原指纹的一方在 TTL 内再接手回来，那部分帧就没有任务可认领了。这是 C1 与接手叠加的结果，只列出来，不处理。

## 第二轮：按契约 F.7 调整（2026-09-24）

主 Agent 在 F.7 裁定了上面的疑点 1～5。本分支先合入了 `claude/rq-card-lock`（只改文档），拿到 F.7，然后只改了 `server/render-queue/queue.mjs`。提交是 c1c45eb。

### 改动

1. **发布时拒建（F.7 第 1 条，对应疑点 8）**：新增 `lockRefusal(input)`。满足下面四条时，这一项不建，`results[i] = { id, error: 'card-locked', lockedBy: X }`：
   - 表里没有同 `id` 的任务；
   - 这一项有锁键 L 和锁指纹 F；
   - 锁在别的指纹 X 上；
   - 没带 `takeover`。

   它和 `limit` 一样只影响这一项。已过 TTL 的 `done` / `failed` 按 A.10a 当作不存在，同样按新建处理，会被拒建。已有同 `id` 任务的，照 A.7.1 合并并带 `lockedBy`（`lockOnPublish` 里原有的分支，现在只剩合并会走到这里）。
2. **没锁时带 `takeover`（F.7 第 2 条，对应疑点 4）**：改为调用 `takeoverLock`。建锁（`source: 'takeover'`）的同时，作废锁键为 L、指纹不是 F 的 `open` / `claimed` 任务，通知排在回包之后。`card.lock` 在没锁时仍按 F.1 建 `source: 'lock'` 的锁：没锁意味着还没有人在产出，F.7 没改这一条。
3. **锁回收（F.7 第 3 条，对应疑点 5）**：改为严格大于 `now - touchedAt > C.DONE_TTL`，注释同步改了。
4. **`limit` 没建成的项（F.7 第 4 条，对应疑点 2）**：维持原做法，跳过锁处理。`limit` 的判断排在拒建之前，两者同时成立时回 `limit`。

### 验证

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 1。共 2121 个测试，通过 2119，失败 1（I6），跳过 1。
- 文档服务测试和三份队列单测一起跑：72 个测试，72 个通过。
- scratchpad 冒烟脚本（不入库）全部断言通过，覆盖以下几点：
  - 没锁时带 `takeover`：锁记为 `takeover`，异指纹的 `open` 任务作废（`superseded`）；
  - 拒建：新建项回 `{ id, error: 'card-locked', lockedBy }`，任务表里没有它；同一条消息里的其它项照常新建；已有同 `id` 的项照旧合并并带 `lockedBy`；
  - 锁回收：闲置恰好等于 `DONE_TTL` 时保留，多 1 毫秒才删。

### I6 仍失败（预期内，由测试方按 F.7 第 6 条改）

失败的样子变了。第二轮 FP_A 的细任务现在在发布时就被拒建，任务表是空的，页面等不到这些细任务的 `task.done`，`drive` 超时。

要等两件事都落地，I6 才会恢复通过：
- 节点侧 F.7 第 5 条：`local-node` 等发布回包，并照锁指纹重发；
- 测试方按 F.7 第 6 条改期望。

这两件都不在本分支的范围内。
