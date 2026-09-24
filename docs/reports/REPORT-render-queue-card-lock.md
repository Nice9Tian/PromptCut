# 报告：卡片级指纹锁（M4 补充）

集成分支 `claude/rq-card-lock`，基于 main 的 `2df8bd2`（M4 已合入）。2026-09-24。按用户的「卡片级一致性锁定」决策实现，测试通过后按用户授权合入 main。

- 语义：`docs/semantics/architecture/rendering.md`「不同环境的结果不混用」「预渲染结果的复用」；`glossary.md` 新增「卡片级指纹锁」
- 设计：`docs/plan/distributed-prerender-queue.md` 2.1「谁定指纹」改为按卡锁定
- 契约：`docs/plan/render-queue-contract.md` F 节（F.7、F.8 是定稿后按实现方疑点补的细则）

分工：
- 三个实现方各在自己的分支上照契约写：队列（`-queue`）、节点（`-node`）、本机预渲染进程与页面（`-pipeline`）；
- 测试方（`-tests`）只照契约写测试，没有看实现；
- 合进集成分支后由主 Agent 重跑全部验证。

本文并写了四方的报告。

## 1. 规则

- **锁的单位**：一张卡的一种预渲染结果（快照、轨道流各一把），锁键 `<kind>:<内容键>`。
- **得锁**：最先为这张卡产出结果的环境得锁：
  - 页面测量推过的帧入库时，用页面浏览器的指纹得锁；
  - 本机预渲染进程开渲一张卡之前，用自己的指纹得锁；
  - 队列里第一次认领时，用任务的指纹得锁。
- **不得抢单**：别的环境不能替锁定方产这张卡的剩余帧：
  - 队列认领时拒（`card-locked`）；
  - 发布时拒建（`error: 'card-locked'`，不留死任务）；
  - 本机不给这张卡写帧。
- **接手**：用自己的指纹另起一套键、从头产整张卡，锁转过来，原环境的未完成任务作废（`superseded`），页面那一层整层换键。
  - 队列里：发布时带 `takeover`；
  - 本机：锁定方的结果已齐就直接投递、不渲（**复用前端算力**）；不齐且锁定方闲置满 30 秒（`CARD_LOCK_IDLE_MS`），就接手。
- 同一版项目里不同的卡可以出自不同环境；一层里的帧不混环境。

## 2. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | **tests 2194，pass 2193，fail 0，skipped 1**（跳过的照旧需要 5190）。M4 之后的 2121 条加新增 73 条 |
| 新增测试 | `card-lock-queue`（Q0～Q11）、`card-lock-node`（N1～N6）、`card-lock-pipeline`（L1～L10）、`src/editor/pageEnvironment.test.mjs`（W1～W2） | 合进集成分支后首跑全过；测试方在未跟踪副本里种了 54 个错，抓到 52 个，剩下 2 个与正确实现行为相同 |
| 锁、队列、节点、文档服务相关 | 上面四个文件加 `render-queue-*`、`render-node-*`、`docservice` | 264/264 |
| 就绪索引探针 | `node scripts/probes/ready-index-probe.mjs` | 退出码 0，`fails: []` |
| 轨道流探针 | `stream-produce-probe.mjs --origin http://127.0.0.1:5230`，另跑一遍带 `--group` | 两遍都 PASS |
| 预览兜底探针 | `preview-fallback-probe.mjs --origin http://127.0.0.1:5230`，另跑一遍带 `--page-preload` | 两遍都 PASS |
| 导出确定性 | `verify-determinism.mjs --url "http://127.0.0.1:5230/?export=1"` | 1800/1800 相同 |
| 导出与快照重放一致 | `verify-unified-frames.mjs` | PASS |

没有锁时（探针、导出的情形），流水线逐路径行为与之前相同；本分支没有改导出代码。

**现场核对**：对 5230 发 `PUT /api/frames/snapshot`，两种真实的页面环境：

| 步骤 | 结果 |
|---|---|
| 页面环境 A：`Win32` + NVIDIA + Chrome 152 | 指纹 `ec313bc687208b5c` |
| 页面环境 B：`MacIntel` + Apple M2 + Chrome 150 | 指纹 `57acddb84793b00c` |
| 本机预渲染 | `258acaaa7c5fe509` |
| 不带环境 | `ENV_MISSING` |
| A 推两帧 | 都 `stored`，键 = `resultKeyOf(内容键, A)`；锁 `source: 'page'`；这张卡的 control `foreign: true`、`snapshotKey` 换成 A 的键；A 的键第 5 帧 HTTP 200 |
| B 推一帧 | `CARD_LOCKED`，`lockedBy` 是 A |
| 12 秒后本机键第 0 帧 | 404：本机没有替 A 产这张卡 |
| A 停止推帧 | 约 49 秒后本机接手：锁转为本机指纹（`source: 'prerender'`），本机键第 0 帧变成 200；A 再推帧回 `CARD_LOCKED` |

## 3. 改了什么

| 模块 | 改动 |
|---|---|
| `server/render-queue/`（`queue.mjs`、`messages.mjs`、`index.mjs`） | 锁表 `locks`；`lockKeyOf`；新消息 `card.lock` / `card.locked`（进 `PUBLISHER_TYPES`，文档服务不用改就会路由）；认领第 3a 步 `card-locked`；发布按锁拒建、带 `takeover` 接手并作废异指纹任务；完成时刷新锁；`tick` 第 5 项回收闲置的锁；`describe().locks` |
| `server/render-node/fingerprint.mjs` | `normalizeOs` 认页面上报的 `Win32` / `MacIntel` / `Linux x86_64` / `macOS` |
| `server/render-node/split.mjs` | `splitPlan` 接受 `cardLocks`、`takeover`：被别的指纹锁定的卡按锁指纹出键；接手时按本节点指纹出键并带 `takeover: true`；`lockKeyOf` 改为转出队列那一份 |
| `server/render-node/local-node.mjs` | 派生任务发布带 `reqId`，等回包后才完成 `plan`（细任务因此继承页面订阅）；被拒建的卡照锁指纹重切重发（`takeoverLocked` 选项可改为接手），最多重来 2 轮 |
| `server/card-lock.mjs`（新） | 本机锁库 `<帧库>/controls-lock/<内容键>.json`（内存同步判锁、写盘异步合并）；纯函数 `cardLockDecision` → `own` / `reuse` / `defer` / `takeover` |
| `server/frame-pipeline.mjs` | `applyCardLocks`：被别的环境锁定的卡换成锁定方的键，投递、认领、扫盘重建自动跟着走；整场景路和 `fillCardControls` 不替锁定方产帧；写帧前得锁（本机已有结果也得）；延后的卡按闲置时限用计时器重判（同一版最多 20 次）；接手时同一内容键的所有片段一起换键；`acceptMeasuredSnapshot`；诊断加 `cardLocks` 与 `cardLock` |
| `server/vite-plugin-frames.ts` | 测量帧路由改为用页面上报的 `environment` 算指纹，交给 `acceptMeasuredSnapshot`（取代 M4 的 E.6 闸） |
| `src/editor/pageEnvironment.mjs`（新）、`probeRunner.ts` | 页面读自己的平台、UA、WebGL 渲染器，随测量帧上报 |
| `server/test/render-queue-inproc.test.mjs` | I6 第二轮按 F.7 改期望：被锁的卡仍由锁定方指纹的节点做完，不重复渲，不留死任务 |

## 4. 过程中定下的细则（都已写进契约）

**F.7（队列与节点）**：
- 不知道锁的切分节点会发出谁也认领不了的任务，所以改成发布时拒建、切分方照锁重发；
- 没锁时带 `takeover` 也作废异指纹任务；
- 锁回收用严格大于。

**F.8（本机）**：
- 本机已有结果也得锁，免得换键前已产齐的卡被页面的第一帧锁走；
- 延后的卡用计时器重判，不等下一次 `preload`，否则锁定方停下后要等项目改动才会接手；
- 同一内容键的片段一起换键；
- 没有内容键回 `NO_CONTENT_KEY`。

**实现方其余的小裁定**：
- 发布回包是 `error` 时，`plan` 按可重试失败处理；
- 重连后，按原 `reqId` 重发还在等回包的发布；
- `derived` 只列发布成功的 id。

## 5. 需要知道的

- **你的编辑器生效要重启**：5190 那台编辑器要重启预渲染进程（或整台 dev server）才会用上合入后的代码。
  - 此后页面测量独立卡时，会按你浏览器的环境锁定这张卡；
  - 测量已覆盖整张卡的，本机不再渲它的快照。
- **你的浏览器指纹**：页面的指纹由浏览器的 WebGL 渲染器决定。浏览器的「使用硬件加速」开关一变，指纹就变；旧指纹锁定的卡已齐的照样投递，不齐的在闲置后由本机接手。
- **测试方提的未覆盖项**：
  - `ensureCardLocks` 在 `rescanSnapshots` / `preload` / `cardRender` 里的调用点，和测量帧路由本身，没有单测；由探针和上面的现场核对覆盖；
  - 页面收到空区间的换键 `layer` 之后怎么显示，没有单独测。按现有语义是整层换键、按兜底顺序显示，本次现场核对没有看画面。
