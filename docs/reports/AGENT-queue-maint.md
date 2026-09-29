# AGENT-queue-maint

分支 `claude/queue-maint`（起点 main `98e042d0`），worktree `.worktrees/queue-maint`。端口段 5710～5719。

任务（主会话派，M7 遗留三条，出处 `docs/reports/REPORT-M7.md` 第 11 节、`docs/archive/agent-reports/AGENT-rq-m7-node.md`「没做成的」）：

- D：页面只是忙，不被 D2 接手。D2 = M7 契约第 3.4 节「队列锁闲置接手」：一张卡锁在某个环境上，锁定方闲置超 30 s、卡又没做完，切分方（pc / 独立渲染主机）就带 `takeover` 按自己的指纹接手整张卡；
- E：执行器按本机快照库的超限记录（`index.json` 的 `oversize`，R6-14 = 超过 300 KB 被丢弃的快照帧）标 `snapshotOversize`；
- F：舞台互换（K5 = 后台舞台补跑完与可见舞台对调角色）时生成快照跟着后台位置走的专门剧本。

## 提交

| 提交 | 内容 |
|---|---|
| `e0d5a185` | 建本报告 |
| `6cc8aade` | 任务 D |
| `8a34ff80` | 任务 E |
| `0d09583b` | 任务 F |
| `2137950c` | 报告初稿 |
| （本报告的最后一次提交） | 报告定稿（探针结果） |

## 任务 D：页面只是忙，不被 D2 接手

### 查到的

- 判定在队列：`server/render-queue/queue.mjs` 的 `lockInfo` 回 `lockIdleMs = now - producedAt`，`producedAt` 只在认领、续约、完成、`card.lock` 时刷新；切分方 `server/render-node/local-node.mjs` 的 `idleLockTakeover` 在 `lockIdleMs > 30 s && lockUndone !== 0` 时接手。
- 页面（`src/online/browserNode.ts`，`maxConcurrent: 1`）锁住卡 X 之后去做卡 Y 的段、或后台舞台在测量 / 补跑（让路放回了 X 的段）时，队列收不到任何关于 X 的消息，X 30 s 后就被接手。队列只知道节点连着没连着，分不出「在忙」与「闲着不回来」。

### 改法（三级机制，契约改处标〔裁〕）

- 队列：
  - `node.welcome` 多带 `activeIntervalMs`（`NODE_ACTIVE_INTERVAL_MS` = 10 s，`server/render-queue/constants.mjs`，不进 `QUEUE_DEFAULTS`：那张表被契约 A.2 与 `render-queue-protocol.test.mjs` 列死）；
  - 新节点消息 `node.active { busy?: string ≤ 32 字 }`，进 `NODE_TYPES`（文档服务按这张表路由，模块不用改），不回包，只记节点的 `activeAt` / `activeBusy`；
  - 锁多记 `nodeId`：最后一次经认领、续约、完成为它产出的节点（`card.lock`、接手建的锁不记）；
  - 回包的 `lockIdleMs = now - max(producedAt, owner.activeAt)`，`activeAt` 只在那个节点此刻连着（`conn` 在，断开后的宽限期里不算）、指纹仍是锁的指纹时才算；否则只看 `producedAt`，与改前相同；
  - `describe().nodes[]` 在节点报过忙时多带 `activeAt`、`activeBusy`，别的节点形状不变。
- 页面节点：welcome 带 `activeIntervalMs` 才发；手里有认领报 `'bake'`，否则问宿主 `busy()`：后台舞台单飞队列里有补跑、测量、探针报 `'stage'`；页面隐藏、父页 rAF 断档、闲着、只在播放或拖动而后台没活时不报。`debug().counters.active` 计数。
- 切分方不改：它读的还是 `lockIdleMs`，所以已经装在用户机器上的旧 pc 节点连上新队列也受益。

### 向后兼容

| 组合 | 行为 |
|---|---|
| 新队列 + 旧页面 | 旧页面不发 `node.active`，锁按产出算，与改前相同（QM-D-06） |
| 旧队列 + 新页面 | welcome 不带 `activeIntervalMs`，页面一条不发（旧队列会把未知类型回 `bad-message`）（QM-D-P1） |
| 新队列 + 旧切分方 | 切分方照读 `lockIdleMs`，照样不接手忙着的页面 |

### 取舍（请主会话看）

- 只在「真有后台活」时报忙，播放、拖动本身不算：用户连续播放几分钟而后台舞台没活时，锁照旧 30 s 后可被接手。这样保住 D2 的本意（页面不回来时别让卡一直缺），代价是长播放时已做的帧仍可能白费。要把播放、拖动也算忙，只需宿主的 `busy()` 在 `playing || scrubbing` 时回 `'interact'`，一行改动。
- 别的节点（同指纹的另一个页面、别的用户）报忙不作数：锁的 `lockKey` 跨项目全局，别的用户的页面不能替本人的锁续命；页面重载换了 nodeId 也回到只看产出（旧页面走了）。
- 没有加「忙也最多保多久」的上限：忙的来源（别的卡的段、测量、补跑）都有限，页面迟早回到这张卡。

### 单测

- `server/test/queue-maint-d2-busy.test.mjs`：QM-D-01～10（页面忙不接手、断开照旧接手、停报 30 s 后接手、恢复产出锁续上、旧页面同改前、别的节点报忙不作数、消息格式、describe、进程内真队列 + 真切分方）。变异验证：把 `lockIdleMs` 改回 `now - producedAt`，QM-D-02～05、10 变红。
- `src/online/browserNodeActive.test.mjs`：QM-D-P1～P4（旧队列不发、有认领按间隔报 bake、宿主报 stage、下线与被拒不报）。

## 任务 E：执行器标 `snapshotOversize`

### 改法

`server/prerender-executor.mjs` 新增导出 `markSnapshotOversize(pipeline, context)`，`plan()` 每次切分前调：共享档卡在本机快照库里本机指纹的键（`control.snapshotKey`）、或锁定方指纹的键（`context.cardLocks` 里这张卡锁在别的环境上时）下，`index.json` 的 `oversize` 非空，就给交给切分的 control 标 `snapshotOversize: true`；`split.mjs` 已有的判定据此不给纯浏览器另出一份。

- **标在整张卡上，不按段**：卡片级指纹锁下，浏览器认领任一段就锁住整张卡，超限那几段它做了也被丢、别的环境又被锁挡住。按段挡等于把卡留成死卡。
- 每次现读，不进按版本的上下文缓存（超限记录随本机渲染、拉取变多）；标了的 control 是新对象，缓存不改。
- 本地档、画布卡不看（本来就不给浏览器）；读不到快照库（测试替身、库坏了）当没有记录，`plan()` 回原上下文。
- 独立渲染主机用同一个执行器，也会标。

### 跨机器拿不到记录时

超限记录只在本机快照库里。这台机器没渲过、也没拉过这张卡时不标，浏览器照旧拿到一份：浏览器做出的超限帧照桌面列进清单，由拉取方判（`src/online/bakeTask.ts` 第 78 行），也就是白做一趟。这台一旦拉回这张卡的结果（`applyResult` 落盘走同一个写入口 `commitSnapshots`，超限照样判出来记下）或自己渲过，下一次切分就标。`split.mjs` 按卡种（Lottie、画布卡）挡浏览器的规则照旧在，兜住已知的大卡。

### 单测

`server/test/queue-maint-oversize.test.mjs`：QM-E-01～06（有记录的标、切分不给浏览器、没记录的照旧给；锁定方指纹键下的记录；整张卡标；不标的情形；现读不改缓存；跨机器）。用真的 `SnapshotStore`（临时目录）与真的 `splitPlan`。

## 任务 F：舞台互换时生成快照跟着后台位置走

### 做法

为了不起浏览器写剧本，把宿主（`src/editor/browserNodeHost.ts`）一帧的前半段（单飞队列里的 `bake` 活、每帧前核后台位置、换人就重灌、顺推时先发下一帧、`bake-frame` 事件对账）原样拆到 `src/editor/stageBake.ts`，宿主改用它，后半段（解压、推素材服务、进页面内快照库）留在宿主。剧本 `src/editor/stageBake.test.mjs` 用真的 `browserNode.ts`、`stageJobs.ts`、`stageBridge.ts`（含按角色滤事件、`swapStageClients`、按客户端记的推送基线）、`stageBake.ts`，配假舞台（产出只由灌进来的项目与本地帧决定，没重灌就出不同字节；不是后台回 `role`；一帧在飞时角色变了回 `cancelled`，同 `StageView.tsx`）和一个任务的假队列。

| 用例 | 断言 |
|---|---|
| QM-F-01 | 基线：不互换，10 帧、灌一次隔离单卡工程、可见舞台一帧不做 |
| QM-F-02 | 契约流程：第 4 帧在飞时补跑排进来 → 当前帧做完、报 5 帧之后才放回（`yield-urgent`）→ 放回之后补跑才在旧后台上开工 → 互换 → 重新认领，新后台先收 `setRole('back', { job: 'bake' })` 与整份隔离单卡工程，再从第 5 帧做到第 9 帧；旧后台互换后一帧不做；清单与每帧 HTML 与基线逐字节相同 |
| QM-F-03 | 两帧之间换人（没有补跑先行）：下一帧前核到换人、先重灌再做；旧舞台上先发的那一帧作废；不放回不失败；逐字节相同 |
| QM-F-04（两种） | 一帧在飞时换人：旧舞台回 `cancelled`；或帧做完了而事件在互换后才到、被按角色滤掉 —— 都在新后台上重做，不计失败；逐字节相同 |
| QM-F-04b | 后台没换人时 `cancelled` 照旧按可重试失败交回 |
| QM-F-05 | 补跑刚完、互换之前就从单飞队列开出的 `bake` 活（活记的是旧后台）：第一帧前核到换人，帧只出自新后台，旧后台只收过补跑那份整场景项目，最后留在 front 角色 |

### 剧本查出并修掉的缺陷

一帧**在飞时**后台位置换了人（没有补跑先行的互换、iframe 重载、QM-F-05 那一小段窗口），旧舞台回 `cancelled` / `role`，或帧做完了而事件被 `stageBridge` 按角色滤掉。宿主原来把这当成可重试失败交回（计一次失败，三次进 `failed`），与契约第 4.3 节「跟着后台位置走」不符。现在后台位置确实换了人，就在新后台上重灌、重做这一帧，每帧最多 `SWAP_REDO_MAX` = 2 次（三级数字），不计失败；后台没换人照旧交回失败。另外换人之后不再往旧舞台先发下一帧。

变异验证：`SWAP_REDO_MAX` 改 0，两条 QM-F-04 变红（即原行为），其余照过；去掉每帧前核位置，QM-F-03、04、05 变红。

诊断：`__pcBrowserNode().stage.restage = { restages, redos, pushes }`。

### 没改的

`stageJobs.ts` 的 `pump` 在补跑一完就可能把排着的 `bake` 活开在旧后台上、给旧后台发 `setRole('back', { job: 'bake' })`，接着 `swapAndDress` 再把它设成 front。剧本里（Node 的微任务顺序）最后角色是对的、帧也只出自新后台（靠每帧前核位置）；真浏览器里两条 RPC 在同一个 iframe 上按发出顺序到达，`setRole('front')` 在后，所以也不会留在 back。这是 K5 共用的单飞队列，不只影响生成快照，没动；如要彻底，可在 `sendJob` 发之前再核一次 `stage === backStage()`。

## 对接口 / 契约 / 语义的改动与建议

### 接口（都向后兼容，标〔裁〕）

- 队列：新节点消息 `node.active`；`node.welcome` 多 `activeIntervalMs`；`describe().nodes[]` 在报过忙时多 `activeAt` / `activeBusy`。`lockIdleMs` 的含义改为「此刻减最后一次产出或报忙」。
- 执行器：`plan()` 回的 PlanContext 里 control 可能带 `snapshotOversize: true`（切分已认）。
- 页面：`BrowserNodeDeps.busy?()`、`debug().counters.active`；`__pcBrowserNode().stage.restage`。

### 契约改处（〔裁〕）

- `docs/plan/m7-contract.md` 第 3.4 节：加「页面只是忙不算闲置」一条（任务 D）；第 4.3 节末条下加「一帧中途换人在新后台重做」（任务 F）；第 13 节「探针之后的更正」第 6 条落实列补标记来源（任务 E，非改动，只补实现说明）。
- `docs/plan/render-queue-contract.md`：A.6 表加 `node.active` 行；A.11 注 `node.welcome` 多 `activeIntervalMs`；F.1 末加一句指向 F.9；新增 F.9「页面只是忙不算闲置」。

### 语义（未写，dry run，三级，交主会话定）

`docs/semantics/mechanism/rendering.md`「预渲染结果的复用」末句：

- 修改前：「本机预渲染进程遇到被别的环境锁定的卡：已经齐了就直接投递，不再渲；还缺帧、而锁定方已经有一段时间没有再产出，就用自己的指纹接手整张卡。」
- 修改后：「本机预渲染进程遇到被别的环境锁定的卡：已经齐了就直接投递，不再渲；还缺帧、而锁定方已经有一段时间既没有再产出、也没有报告自己还在忙（页面还开着、在做别的卡或在测量），就用自己的指纹接手整张卡。」

理由：现句的「没有再产出」若按「为这张卡产出」读，任务 D 的改法比它宽；加半句把「页面还在、只是忙」写明。

## 验证

机器状态：同机另有两个子 Agent 在跑测试与探针，负载高（全量测试里一个 ffmpeg 转码用了 82 s，平时约 0.4 s）。

| 项 | 命令 | 结果 |
|---|---|---|
| 新单测 | `node --test server/test/queue-maint-d2-busy.test.mjs` | 10/10 过 |
| | `node --test src/online/browserNodeActive.test.mjs` | 4/4 过 |
| | `node --test server/test/queue-maint-oversize.test.mjs` | 6/6 过 |
| | `node --test src/editor/stageBake.test.mjs` | 7/7 过 |
| 相关旧单测 | `prerender-executor`、`m7-queue`、`m6c-executor`、`m7-node-rules`、`stall-phases`、`host-card-code` | 73/73 过 |
| | `src/online/browserNode.test.mjs`、`stageJobs`、`stageBridge`、`pageNodeImports` | 过 |
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 行输出 |
| 全量测试 | `npm test` | 3990 条：3987 过、0 失败、2 跳过、1 cancelled（`C66-I2-01`：60 s 超时，机器忙，ffmpeg 转码 82 s）；该文件单独重跑 `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/c66-integ.test.mjs` 6/6 过（`C66-I2-01` 405 ms）。main 上 3963 条，多出的 27 条是本分支新增 |
| 代码指纹 | `node -e "import('./server/frame-code.mjs')…"` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，不变；`server/bakery/`、快照代码文件 0 改动 |
| 在线构建 | `npx vite build --mode online --outDir out/dist-online` | 退出码 0 |
| 探针 | `PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/m7-browser-probe.mjs --role all --base-port 5710 --dist out/dist-online` | 第 1 次：node 角色页面导航 180 s 超时（暂时性故障，机器忙），一项没走到；退避 60 s 重跑。第 2 次（run `mun3z68y968d`）：`fails []`，creator / node 退出码都是 3（没有失败、只有待定）。M7-A1、A2、A3、A6、A7、A8、A9、A10、A11、D9、D10、D14、D1-D2-D12 全过；待定的只有带耗时门槛的项与跨机：A4 `page-within-30s`（参考判定 pass，最差 23.8 s）、A5 `page-resume-after-500ms`（参考判定 pass，634 ms 后恢复、500 ms 内 0 次认领）、A12 两项长任务、W7 cross-machine 与笔记本计时。bakeMs p50 100 / p95 146（180 帧）。同 M7 最终一轮的形状（`REPORT-M7.md` 第 5 节） |
| 探针 | `PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/desktop-auto-node-probe.mjs --dist out/dist-online --base-port 5710 --skip-off` | 退出码 0，`ok: true`、`fails []`；A1 3.1 s、A2 7.8 s、A7 457 s（泄漏 0、挡掉 108 段）、A3 79 s、A4 31 s、A5 3.5 s |
| 进程 | 探针结束后查 5710～5719 的监听 | 无残留 |

带耗时门槛的项（A4 的 30 s、A5 的 500 ms、A12）在 PC 上只作参考，且跑时机器忙；按 `verification.md` 以笔记本为准，交主会话在空闲机器上判。

## 没做成的

- 真页面上没有直接看到 `node.active` 的线上消息：两个探针都不读这个计数（`debug().counters.active`、`__pcBrowserNode().stage.restage` 是本分支新加的），也不留 WebSocket 帧。行为由单测（QM-D、QM-D-P，含进程内真队列 + 真切分方）证；要在真页面上看，可在 `m7-node-adapter.mjs` 里读 `counters.active` 与 `stage.restage`，属探针改动，本分支没动。
- 任务 D 里播放、拖动不算忙（见「取舍」），是否也算由主会话定。
- `stageJobs.ts` 补跑与互换之间的窗口（见任务 F「没改的」）没改。
- G0-R 按任务书不跑。
