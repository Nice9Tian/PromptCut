# 卡片级指纹锁：Node Agent 报告

分支 `claude/rq-card-lock-node`（基于 bc3004a），规格为 `docs/plan/render-queue-contract.md` F.2，另参照 B.1、B.4、B.5、D 节、E.5 和设计 `distributed-prerender-queue.md` 2.1「谁定指纹」。

状态：F.2 的节点部分已做完，基线全绿。等主 Agent 审查。

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
