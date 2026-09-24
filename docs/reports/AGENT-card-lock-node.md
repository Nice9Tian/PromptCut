# 卡片级指纹锁：Node Agent 报告

分支 `claude/rq-card-lock-node`（基于 bc3004a），规格为 `docs/plan/render-queue-contract.md` F.2，另参照 B.1、B.4、B.5、D 节、E.5 和设计 `distributed-prerender-queue.md` 2.1「谁定指纹」。

状态：F.2 的节点部分和 F.7 第 5 条都已做完，基线全绿。等主 Agent 审查。F.7 的部分见文末「第二轮」。

## 范围

只改了 `server/render-node/` 下的 `fingerprint.mjs`、`split.mjs`、`session.mjs`、`local-node.mjs`、`index.mjs`。没有写 `server/test/`，没有碰 `server/render-queue/`。

## 逐文件

### `fingerprint.mjs`

- `normalizeOs` 先走原有的精确匹配，之后按前缀补三条（先转小写、去掉首尾空白再比）：
  - `win` 开头 → `windows`；
  - `mac` 开头 → `macos`；
  - `linux` 开头 → `linux`。
- 其余输入照旧返回 `other`，比如 `android`、`freebsd`、空串。
- 抽查结果：`Win32`、`MacIntel`、`Linux x86_64`、`Windows`、`macOS`、`Linux` 分别映射到 windows、macos、linux、windows、macos、linux。
- 用真实页面 UA（Win32、ANGLE NVIDIA、Chrome/152）算 `describeEnvironment`，结果和 `win32 / NVIDIA / 152` 的进程侧指纹相同，都是 `ec313bc687208b5c`。

### `split.mjs`

- `splitPlan` 新增两个参数：
  - `cardLocks`：缺省 `{}`。可以是 `Map`，也可以是普通对象；只要对象有 `get` 方法就按 Map 读。普通对象只看自有属性。
  - `takeover`：缺省 `false`。可以是 `true`、`Set` 或任何带 `has` 的对象，也可以是 `(lockKey) => boolean`。函数或 `has` 返回 `=== true` 才算命中。
- 锁键规则：
  - 快照是 `snapshot:<contentKey>`，流是 `stream:<contentKey>`；
  - `contentKey` 按 E.5 算，和任务的 `input.contentKey` 是同一个值；本地档因此带 `<entryKey>/` 前缀。
- 出键分三种情况，每张卡、每条流只判一次，所有段用同一个结果：
  - 没锁，或锁在本节点指纹上：用本节点指纹，不加 `takeover` 字段。输出和改动前逐字节相同。
  - 锁在别的指纹 X 上，且接手命中：用本节点指纹出键，每个任务加 `takeover: true`，这个字段放在任务顶层（F.1 的 `TaskInput.takeover`）。
  - 锁在别的指纹 X 上，接手没命中：`resultKey = resultKeyOf(contentKey, X)`，`requires.envFingerprint = X`，其余字段不变。任务 `id` 由 `resultKey` 算出，所以也跟着变。
- 文件头注释补了「卡片级指纹锁」一节。

### `session.mjs`

- 行为没改，只补了注释。
- 现有的 `onRejected` 对 `stale` 以外的所有原因（包括认不出的原因）都会把任务移出本地视图（`open.delete(id)`），同时清掉在飞的认领。
- 所以 `card-locked` 已经按 `taken` 处理：候选被丢掉，不重试。
- 任务在队列里仍然是 `open`。只有队列再发 `task.opened` 或 `queue.snapshot` 时，它才会回到本节点的视图。

### `local-node.mjs`

- 代码不用改：切分调用是 `splitPlan({ ...ctx, planTask, envFingerprint, codeVersion, constants })`，`ctx` 里的 `cardLocks`、`takeover` 已经随展开原样传过去。
- 在调用处补了注释。
- 在 `PlanContext` 的 JSDoc typedef 里补了 `cardLocks`、`takeover` 两项，并注明依据是 B.4 和 F.2。

### `index.mjs`

- 出口不变，只在文件头注释里注明 `split.mjs` 含卡片级指纹锁。

## 验证

- 类型检查：在 worktree 里跑 `npx tsc -b --force`，退出码 0，零错误。注意 `tsconfig.json` 的 `include` 只有 `src`，所以 `server/*.mjs` 不在类型检查范围内。
- 全量测试：在 worktree 里跑 `npm test`，退出码 0。
  - 共 2121 项：通过 2120，失败 0，跳过 1。
  - 跳过的那项是既有的「集成：/api/cards/layout 对真实项目返回整数框」（带 SKIP 标记），与本次改动无关。
- 切分冒烟：脚本在 scratchpad 里，不入库。覆盖了以下情况，每个任务都满足 `resultKey === resultKeyOf(input.contentKey, requires.envFingerprint)`：
  - 没锁；
  - Map 锁：异指纹锁定、同指纹锁定、本地档键 `snapshot:E/CB`、流键 `stream:STC`；
  - 对象锁配 Set 接手；
  - 函数接手；
  - `takeover: true` 全部接手（同指纹那张卡照旧不带 `takeover`）。

## 失败清单与归类

没有失败的测试。按 F.2 预判，既有测试里可能因新映射失败的，只有 `render-node-logic.test.mjs` 的 B.1 用例：它断言 `freebsd`、`aix`、`sunos`、`android`、`''` 映射到 `other`。这几个输入都不以 win、mac、linux 开头，所以没有失败。

## 契约疑点（都按最贴近设计的做法实现了，没有改契约）

1. **锁指纹的合法值**：F.2 没说 `cardLocks` 的值不是非空字符串时怎么办。我按「没锁」处理，和 F.1「锁指纹是非空字符串」一致。
2. **`takeover` 怎样算命中**：函数返回值、`Set.has` 的结果必须 `=== true` 才算命中；`takeover` 为 `true` 以外的其它非函数、非 Set 值都当不接手。F.2 只列了布尔、Set、函数三种形态，没说真值（truthy）是否算数，我按严格布尔处理，和 F.1 对入站 `takeover` 的「必须是布尔」一致。任何带 `has` 方法的对象都按 Set 处理。
3. **同指纹时接手命中**：只有锁在别的指纹上时才加 `takeover: true`。没锁、或锁在本节点指纹上时，就算 `takeover` 命中也不加，这是按 F.2 第一条字面实现的。结果是：没锁的卡发布时不会带 `takeover` 去抢先建锁（F.1 表里「没锁 + takeover → 建锁」这一行，本节点的切分不会触发），锁要等第一次认领时才建。如果主 Agent 希望「接手」也能对还没锁的卡抢先建锁，需要改 F.2。
4. **`session.mjs` 丢掉候选之后**：任务在队列里仍然是 `open`。按 B.5，只有队列之后为这个任务再发 `task.opened` 时，它才会回到视图。F.1 的认领拒绝本身不发 `task.opened`，所以本节点不会反复认领它，满足 N4 的「不重试」。

## 第二轮：契约 F.7 第 5 条（`local-node.mjs` 等发布回包，并照锁重发）

先按主 Agent 的指令合并了 `claude/rq-card-lock`，这次合并只改了 `render-queue-contract.md`，读到了 F.7。疑点 3 的裁定是维持 F.2 的字面做法，代码不动。

### `split.mjs`

- 新增并导出 `lockKeyOf(task)`，和 F.1 同口径：
  - `kind` 是 `snapshot` 或 `stream`，且 `input.contentKey` 是非空字符串时，返回 `` `${kind}:${contentKey}` ``；
  - 其余返回 `null`。
- 这个分支上还没有队列侧的 `server/render-queue/index.mjs` 转出的同名函数，所以在这里放了本地实现，没有改 `server/render-queue/`。
- `render-node/index.mjs` 没有转出它，免得出现两个公开的 `lockKeyOf`。队列侧合入后，建议 `local-node` 改用队列侧的那个。

### `local-node.mjs`

- **发布带 `reqId`，等回包才完成**：
  - 派生任务的 `task.publish` 带本实例内唯一的 `reqId`，形如 `<publisherId>#publish-<序号>`；
  - 等到同一 `reqId` 的 `task.published` 回来，才 `complete` 这个 `plan`；
  - 等待先登记再发送，这样同步传输也不会漏掉回包；
  - 等待和 `signal` 赛跑，丢认领、让路、`stop` 都会让它落定，落定后撤掉登记；
  - 不开计时器，只由收到的消息和中止信号推进；
  - 每次等完都重新判一次「仍持有」，不再持有就丢弃结果，发 `discarded`。
- **照锁重发**：
  - 回包里 `error: 'card-locked'` 的项，按原任务算出锁键，把锁键和 `lockedBy` 并进 `cardLocks`：`ctx.cardLocks` 可以是 Map 或普通对象，和各轮学到的锁合成一个新 Map；
  - 用 `splitPlan` 重切，只重发锁键在这一轮被拒结果里的任务；
  - 这些锁键是否接手由新选项 `takeoverLocked` 决定：布尔，或 `(lockKey, lockedBy) => boolean`，只认 `=== true`，缺省 `false`，即照锁定方的指纹重发；
  - 最多重来 2 轮（首发之后再发两次），第 3 次仍被拒的锁键记进 `gaveUp`；
  - 有过重发时，在 `complete` 之前发事件 `{ type: 'plan-relocked', id, lockKeys: 重发过的锁键（升序）, gaveUp: 最后仍被拒的（升序，没有就是 []) }`。
- **`derived` 的口径**：只列最终回包里没有 `error` 的 id，已存在的 `done` / `failed` 任务也算。`limit` 等其它错误不进 `derived`，也不做锁处理（F.7 第 4 条）。
  - 这和 M3 有一处行为差：M3 的 `derived` 是切分出的全部 id。不涉及锁、也没有 `limit` 时，两者完全相同。
- **自己补的两条收尾规则**（契约没写，按「不留死等」选的做法）：
  1. 同一 `reqId` 回的是 `error`（例如 `bad-message`、`not-registered`）：这个 `plan` 按可重试失败处理，`task.fail`，`error` 为 `publish-<reason>`。
  2. `start()` 重连时，对已接续、仍持有且还在等回包的 `plan`，按原 `reqId` 重发一次 `task.publish`。旧连接上的回包不会再来，而发布是幂等的，只合并订阅者，此刻 `plan` 仍由本节点认领，继承条件照样成立。
  - 回包丢了但不重连（例如分区后又恢复）时，续约的进度停在 0，由队列的停滞规则回收。
- `takeoverLocked` 已写进 JSDoc 的参数说明；文件头补了「发布被锁拒绝」一节。

### 第二轮验证

- `npx tsc -b --force`：退出码 0，零错误（只查 `src`）。
- `npm test`：退出码 0，共 2121 项：通过 2120，失败 0，跳过 1，跳过的仍是那项既有 SKIP。
- 单跑 `render-queue-inproc`、`render-node-session`、`render-node-logic` 三个文件：119 项全过。
- **I6 在本分支上没有超时，照样通过**。原因是队列侧的拒建不在本分支上：发布不会回 `card-locked`，节点只发一轮，行为和 M3 相同。测试方按 F.7 改了 I6 的期望，并和队列侧合并之后，I6 要以合并结果为准重跑。
- scratchpad 里的冒烟脚本不入库，用手搭的端点驱动 `createLocalNode`，下面 7 个场景全部通过：
  1. 照锁指纹重发：第二轮只发被拒卡的两段，`requires.envFingerprint` 为 X，`resultKey === resultKeyOf('CA', 'X')`，不带 `takeover`；`plan-relocked` 的形状为 `{ lockKeys: ['snapshot:CA'], gaveUp: [] }`；`derived` 是另一张卡的任务加上重发成功的任务。首轮回包到达前没有发 `task.complete`；别的 `reqId` 的回包不算数。
  2. `takeoverLocked` 函数收到 `('snapshot:CA', 'X')`，返回真时按本节点指纹重发，任务带 `takeover: true`。
  3. 一直被拒：共发 3 次，`gaveUp: ['snapshot:CA']`，`derived` 不含这张卡。
  4. 没锁：只发 1 次，不发 `plan-relocked`。
  5. 等回包时收到 `lease-lost`：不 `complete` 也不 `fail`，报 `discarded`。
  6. 同一 `reqId` 回 `error`：`task.fail`，`error` 为 `publish-bad-message`，可重试。
  7. 重连且接续 `plan`：按原 `reqId` 重发，回包到了之后才 `complete`。

### 第二轮的契约疑点

1. **同一 `reqId` 回 `error` 时怎么办**：契约没写。我按可重试失败处理，理由是不留死等，而且重新认领的节点会重切重发。如果希望 `bad-message` 不可重试，需要在契约里补一条。
2. **重连时怎么接着等**：契约没写。我选了按原 `reqId` 重发。另一种做法是直接让 `plan` 失败重试，也可以；我没这么做，因为那样会多算一次计划。
3. **`derived` 的口径**：现在不含 `limit` 等其它错误的 id，这是按「最终发布成功」字面实现的。若有测试断言 `limit` 情形下 `derived` 仍含全部切分 id，需要按 F.7 改期望。现有测试没有这种断言。
4. **`lockKeyOf` 暂有两份**：队列侧那份合入后，`split.mjs` 里的本地实现应当删掉，或者改成转出队列侧的，免得两处口径分叉。
