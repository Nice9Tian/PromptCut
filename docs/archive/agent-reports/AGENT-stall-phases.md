# AGENT-stall-phases

分支 `claude/stall-phases`（从 main `5649236` 拉出）。任务：M8 的 C1（放云端，run `m8c1c`，2026-09-28 08:19～08:36Z）里查出的渲染任务队列缺陷——连接活着、续约照发、在干活的独立渲染主机被队列收回，任务反复重做直到永久失败；另查 3 次 `sink-incomplete`。

代号：C1 = M8 验收里「受害主机的连接被代理扣住 30 s」那一例；I8 = 契约用例「执行器卡死、从不报进度、但节点照常续约，要能被停滞规则收回」；A.8 第 2 项 = 队列的停滞规则（`done` 超过 `STALL_MS` 没变就收回）；〔裁〕= 执行时因现有契约做不下去而由会话改的地方，合入前请审。

## 提交

| 提交 | 内容 |
|---|---|
| `7a9eaf8` | 报告占位 |
| `e854934` **诊断:** | 队列给出真实收回原因、任务视图带 `lastError`；节点逐任务的阶段与毫秒数进日志 |
| `c1faa64` 修复 | `task.progress.step`（推块、换阶段也算进度）；独立渲染主机闲时认领；（丢认领停推，下一提交撤回） |
| `6b53828` 修复 | 撤回「丢认领就停推」 |
| （本报告） | 文档 |

诊断提交 `e854934` 可以单独挑出合入：不依赖后面的提交，不改 `frame-pipeline.mjs` 与 `src/`（代码版本不变）。整个分支同样不改这两处。

## 证据与根因

### 推断的核对

主会话的推断是「只能是停滞」。现有代码里三种回收（A.8 第 1～3 项）都发 `lease-lost { reason: 'expired' }`（`server/render-queue/queue.mjs` 的 `reclaim`），日志分不出来；C1 的原始日志不在本机，没法事后核对。所以先做诊断，再在本机替身上把现象做出来，用新诊断看它停在哪个阶段。

C1 里能对上的数字：受害方被扣的 `184ecf…:0-59` 在恢复（08:20:12.5）后 154 s 被收回。停滞规则是「`done` 严格超过 120 s 没变」+ 扫描周期 5 s，所以 `done` 最后一次变化约在 08:20:42～08:20:46——恢复后又出了几批帧、渲完，之后 120 s 帧数不动。渲完之后到完成之间只有「补小尺寸 / 换页」与「推产物」，而受害方最后自己做完了（完成报告按令牌作废），说明它是在推产物时被收回的。

### 本机替身复现（改前）

1. **测试台**（`server/test/stall-phases.test.mjs`，真队列 + 真 `createLocalNode` / `createRenderHost` + 真 `prerender-executor.mjs`，管线换成假时钟上的一条串行 lane 替身，产物库替身按块推）。在诊断提交上跑（修复代码先 `git stash` 掉）：

   ```
   ✖ S1 推产物超过 STALL_MS(约 150 s):推送中每推完一块算进度,一次完成、没有 lease-lost
       actual: [ 'stalled', 'stalled', 'stalled' ],   expected: []
   ✖ S2 主机 maxConcurrent 2、一条串行 lane(每段 135 s):排队的那段不被判停滞,全部一次完成
       actual: [ 'stalled', 'stalled' ],   expected: []
   ✖ Q1 队列:step 变了重起停滞计时;…     actual: 'open',  expected: 'claimed'
   ℹ tests 6  pass 3  fail 3
   ```

   S1 节点的 `lost` 事件（诊断提交加的字段）：

   ```
   {"type":"lost","reason":"stalled","phase":"push","done":60,"sinceDoneMs":120500,"sinceClaimMs":135500,
    "phaseMs":120500,"detail":{"name":"push"},"push":{"blocks":60,"pushed":48,"bytes":48000,"ms":120500}}   ×3 → task.failed
   ```

   S2 的：

   ```
   {"id":"…:120-179","reason":"stalled","phase":"render","detail":{"name":"lane","ahead":1},"sinceDoneMs":120500}
   {"id":"…:60-119","reason":"stalled","phase":"render","detail":{"name":"lane","ahead":1},"sinceDoneMs":120500}
   ```

   `lane ahead=1`：交给管线时前面还有一段在 lane 里，这一段排了 120.5 s 没出过一批帧。

2. **真实时间、真网络的替身**（脚本在会话临时目录 `stall-realtime-probe.mjs`，没入库）：托管模式的真文档服务（凭证握手、WebSocket，端口 5750 / 5751）+ `createRenderHost`（`maxConcurrent` 2）+ 真执行器（串行 lane 替身，每 4 帧 0.7 s）+ 推块替身（60 块、每块 10 s、并发 4，约 150 s）。改前代码取自 `e854934`（`git archive` 到 `out/stall-before/`，gitignore 下）：

   ```
    141.9s node.task-lost {"id":"63aa8eb:0-59","reason":"stalled","phase":"push","done":60,"sinceDoneMs":120092,
           "sinceClaimMs":140719,"push":{"blocks":60,"pushed":44,"bytes":44000,"ms":120092}}
   ```

   结果行见文末「验证」。

### 根因

队列的停滞规则只认帧数 `done`（`queue.mjs` `onProgress`：`done` 变了才重起计时）。节点在「推产物」「在串行预渲染间里排队」这两段里帧数不变，续约只带同一个 `done`，超过 120 s 就被当成卡死收回。推产物在云端（每块 `GET chunks` → `PUT` → `POST complete`，快照段另带 X7 的 PNG 缓存帧）很容易超过 2 分钟；主机 `maxConcurrent` 2 时第二段在唯一的 `'queue'` lane 里排在第一段后面。被收回的一段重做，又在同一处被收回，满 3 次永久失败。语义（`docs/semantics/mechanism/document-service.md`「渲染任务队列」）是「在约定时间内既没报进度也没报完成」才收回；现行代码只认帧数，比语义严。

两个阶段在 C1 里都可能发生：推产物（受害方那一段，时刻对得上）；排队（两台主机都是 `maxConcurrent` 2）。

## 修法与理由

比较了任务书给的三条路：

| 路 | 管得到推产物 | 管得到排队 | 问题 |
|---|---|---|---|
| (a) 进度带一个随工作推进而变的计数 | 能 | 不能：排队时本来没有工作在推进 | — |
| (b) 真正开工才报 `progress(0)`，排队只受租约管，另加本地看门狗 | 不能：推产物时帧数照样不变 | 能 | 看门狗是另一套卡死判定，要自己定时限 |
| (c) 主机只在执行器空着时认领 | 不能 | 能 | — |

定为 **(a) + (c)**，两条各管一段，都在语义之内（「报进度」本来就不限于帧数；「闲时认领」是语义原文）：

- **(a) `task.progress.step`**（契约 A.12 第 4 条〔裁〕）：节点对每个认领记一个工作计数，换阶段、出一批帧、推完一块时加一；续约本身不加。队列在 `done` 或 `step` 变了时重起停滞计时。执行器或产物库真卡死时这些回调都不来，计数不动，照旧收回（I8 与新用例 S4 都过）。节点侧会话 `advance(id)` 只记不发，下一次 `progress` 或续约带上；换阶段时当场报一次，下一步卡死时计时从这一刻算起（不然 I8 的收回时刻会晚一个续约周期，现有 I8 用例抓到了这一点）。
  - 兼容：旧节点不带 `step`，队列只看 `done`，行为不变；旧队列（云端托管端没更新前）丢掉这个字段，新节点照旧工作，只是推产物慢时仍会被误判——**这一条要托管端也更新才生效**。
- **(c) 独立渲染主机闲时认领**（A.12 第 5 条〔裁〕，`render-host-contract.md` 第 3 节「闲时门槛」加注）：快照与 `plan` 共用的串行 lane 空着（执行器 `laneBusy() === 0`）、全部节点手里没有还没走到推送的同 lane 任务（runner 的 `occupying()`）、也没有在飞的同 lane 认领时，才认领这类任务。推产物不占 lane，前一段推送时下一段照样认领、渲染（S3 验证重叠）；流任务走流预渲染间池，不受这道闸。执行器不给 `laneOf` 时不加闸，现有的主机测试替身（RH4 等）行为不变。
  - 对真实主机的影响：`maxConcurrent` 2 以前是「1 段在渲 + 1 段在 lane 里排队」，现在是「1 段在渲 + 1 段在推」，吞吐不降（lane 本来就是串行的）。

撤回的一条：起初还让「丢了认领就不再开推新的块」（产物库 `put` 认 `signal`），想省被收回节点的上行带宽。后来发现同一台主机若马上重新认领这一段，`sink.has` 按本机帧库覆盖就判已有、以去重完成，而素材服务上的块并没推齐（见「遗留」第 1 条），停推会让这种情况更常见；修好误判之后被收回的节点多半本就连接有问题，省下的带宽不大。`6b53828` 撤回。

## 诊断（`e854934`）

- 队列：A.8 回收给原认领者的 `task.lease-lost` 带真实原因 `lease-expired` / `stalled` / `disconnected`（原来一律 `expired`）；放弃过的任务视图带 `lastError`（放回 `open` 的 `task.opened`、`queue.snapshot`、认领回包里的 `task`）。节点只把 reason 原样交给 `onLost`，旧节点照常工作。
- `task-runner.mjs`：每次执行记阶段（`dedup` / `manifest` / `render` / `push` / `plan`，及执行器报的 `project` / `lane{ahead}` / `frames` / `finish`、产物库报的 `collect` / `push`）、帧数、距上次帧数变化 `sinceDoneMs`、距认领 `sinceClaimMs`、在这一阶段多久 `phaseMs`、推送的 `{ blocks, pushed, bytes, ms }`；`lost` / `discarded` / `failed` / `completed` / `dedup` 事件都带上。
- 产物库 `put(entry, { report })`：没收全时回 `reason`（`range-missing` / `small-missing` / `collect-failed:<code>` / `push-failed:<code>` / `bad-kind`）与 `stats`，并记一行 `sink.incomplete`；`failed` 事件带 `why`。
- 日志：预渲染进程打 `[queue-node] node.task-<lost|failed|discarded|completed|dedup> {…}`（`vite-plugin-frames.ts` 的 `taskEventLog`，PC 节点与主机都打，主机带 `project` / `projectId`）；编辑器进程的转发器（`session-diag.mjs` 的 `createSessionLineForwarder`）放行这几种行与 `sink.incomplete`，另用每种每分钟 60 行的额度（会话行仍是 10 行）。`scripts/render-host.mjs` 本来就转出含 `[queue-node]` 的行，所以主机日志里能看到；PC 编辑器日志里是 `[prerender] [queue-node] node.task-…`。字段只有任务 id、原因、阶段、毫秒数、块数，没有会话号、票据、口令。
- 下一轮 C1 看什么：每条 `node.task-lost` 的 `reason` 与 `phase`；`sink.incomplete` / `node.task-failed` 的 `why`；`node.task-completed` 的 `push.ms`（推一段要多久）。

## `sink-incomplete`

没能在本机复现出同样的三次，下面是证据与判断：

1. **主机上不会是缺小尺寸**：小尺寸只在配了推送队列时开（`smallTierEnabled()`），独立渲染主机没有推送队列。
2. **最可能是推送出错**：旧代码 `createAssetSink().put` 把 `pushResult` 抛的错一律吞成 `{ complete: false }`，不记任何日志，所以 C1 里看不出原因。推送路径上：素材客户端每个请求 30 s 超时、3 次重试（`asset-store/client.mjs`）；快照段除 HTML 外还推 X7 的 PNG 缓存帧（整幅透明 PNG，一段 60 张）；C1 时两台主机、PC 拉取、以及被误收回后仍在后台推的旧执行（`untilAborted` 让执行落定，但 `put` 本身不停）同时经公网推到同一台云端。任何一块超时 3 次，这一段就是 `sink-incomplete`。误判停滞修好之后，重复推送与后台旧推送都会少很多。诊断提交之后，`why` 会直接写出 `push-failed:timeout` 之类。
3. **缺帧（`range-missing`）的路径也存在**：`renderCardSnapshotRange` 正常返回、帧库却没有这一段的 HTML 快照时（例如本机锁库拒锁 `acquireCardLock` 失败、或本机预渲染集合没选中这张卡），`put` 会回缺帧。查过预渲染集合：主机没有成本记录时按声明兜底，共享档卡都判重，不太会漏；锁库那一支没有证据。`why: range-missing` 出现时再查。
4. **与收回的关系**：收回本身不会把同一段的帧库或待画的小尺寸弄坏（中止只让 `fillCardControls` 在下一批前停手、跳过收尾的换页；帧写入是原子的）。三次失败都发生在各自持有期间（丢了认领的只会记 `discarded`，不会 `fail`）。

建议：下一轮 C1 带上这个分支（托管端也更新，否则 `step` 不生效），按 `why` 定下一步。若是超时，考虑按块大小放宽素材客户端 `PUT` 的时限，或推送时不带 X7 的 PNG（它只给 legacy 整帧通道用）——都超出本任务范围，没做。

## 改了哪些文件

- `server/render-queue/queue.mjs`、`messages.mjs`：收回原因、视图 `lastError`、`step`。
- `server/render-node/task-runner.mjs`：阶段诊断、工作计数、`occupying()`；`session.mjs`：`advance`、`step`、`canClaim`；`local-node.mjs`：传 `now` / `canClaim`、露 `occupying`；`host.mjs`：闲时认领的闸；`session-diag.mjs`：转发器。
- `server/prerender-executor.mjs`：阶段回调、按管线记 lane 工作数、`laneOf` / `laneBusy`。
- `server/artifact-transfer.mjs`：`pushResult` 的 `onBlock`、`put` 的 `report` / `reason` / `stats`。
- `server/vite-plugin-frames.ts`：逐任务收尾行进日志。
- 契约：`docs/plan/render-queue-contract.md` 新增 A.12（第 1～5 条，〔裁〕），A.4 TaskView、A.6 `task.progress`、A.7.6、A.8 第 2 项各加一句指过去；`docs/plan/render-host-contract.md` 第 3 节「闲时门槛」加注〔裁〕。
- 测试：新增 `server/test/stall-phases-diag.test.mjs`（D1～D5）、`server/test/stall-phases.test.mjs`（S1～S5、Q1）；原来断言 `reason: 'expired'` 的 `render-queue-fault` / `render-queue-inproc` / `render-queue-state` 改成具体原因；`small-tier` ST12 与 `m6c-integ` MI-no-isIdle 跟着回包与执行器接口的新字段改。
- 语义文档没改：「报进度」本来不限于帧数，「闲时认领」是原文，这次是代码回到语义。

A.12 的〔裁〕原文（节选，全文在契约里）：

> M8 的 C1（放云端）里两台独立渲染主机各丢了 6、7 次认领，节点那边只收到 `lease-lost { reason: 'expired' }`，分不出是租约到期、停滞还是断线；主机的逐任务事件也不进日志。试过只看现有日志与诊断接口：队列对三种回收发的是同一个 reason，任务视图不带 `lastError`，`describe()` 只在托管端进程里、事后拿不到。只能改消息形状……
>
> 比较过三条路：(a) 进度带一个随工作推进而变的计数；(b) 真正开工才报 `progress(0)`、排队只受租约管、另加节点本地看门狗；(c) 主机只在执行器空着时认领。只用 (b)：推产物阶段帧数照样不变，还是会误判，看门狗又是一套新的卡死判定；只用 (c)：推产物仍误判；只用 (a)：排队时本来就没有工作在推进，计数也不动。定为 (a) + (c)……

## 验证

- `npx tsc -b --force`：退出码 0，无输出（最后一次在 `6b53828` 上跑）。
- `npm test`：`tests 3769 / pass 3767 / fail 0 / skipped 2`，退出码 0（`6b53828`）。诊断提交时跑过一次：3763 / 3760 / 1 失败（ST12 断言回包全等，已改）/ 2 跳过。
- 新用例改前 / 改后：见上文「本机替身复现」（改前 S1、S2、Q1 失败）；改后 `stall-phases.test.mjs` 6 / 6 过、`stall-phases-diag.test.mjs` 5 / 5 过。
- 卡死仍被收回：S4（产物库永不报进度、永不返回，STALL_MS 后按 `stalled` 收回，`phase: 'push'`）；原有 I8 两条照过。
- 真实时间替身：见下。
- 没跑：导出确定性、快照重放一致、画面探针——没有改渲染、快照、卡片与画面的代码（`frame-pipeline.mjs`、`src/` 未动）。`m8-e-probe --role all` 没跑：5740～5749 有别的会话在用（`netstat` 看到活动连接），改用自己端口段里的真实时间替身。

真实时间替身（15 分钟上限，两遍同时跑，端口 5750 / 5751，跑完进程自己退出、端口已释放）：

| | 认领 | 完成 | 丢认领 | 丢弃 | 过程 |
|---|---|---|---|---|---|
| 改前（`e854934`） | 6 | 0 | 6 | 6 | 两段各在推到第 44～48 / 60 块时按 `stalled` 收回（131.7 / 141.9 / 262.9 / 273.6 / 394.2 / 404.9 s，`sinceDoneMs` 都是 120.1～120.5 s，`phase: push`），各满 3 次后再没人认领（永久失败），到 900 s 一段也没完成 |
| 改后（工作区，等同 `6b53828` 的代码） | 2 | 2 | 0 | 0 | 第二段在第一段开推（11.2 s）后才进 lane；两段推送各用 150 s（超过 STALL_MS），161.3 s、172.0 s 完成 |

结果行原文：

```
改前  900.3s result {"outcome":{},"claimed":6,"completed":0,"lost":6,"failed":0,"discarded":6,"seconds":900}
改后  900.5s result {"outcome":{},"claimed":2,"completed":2,"lost":0,"failed":0,"discarded":0,"seconds":900}
```

（`outcome` 是空的：脚本收 `task.done` 用的测试件 `next()` 有 2 s 超时，第一次超时就不再收了，是脚本的毛病；完成与否以主机的计数与逐任务行为准。）

## 没做成的与建议

1. **遗留（没改）**：`createAssetSink().has` 在本机帧库覆盖整段时直接回 true（不查素材服务）。主机上若一段推到一半就丢了认领、又被自己重新认领，会以去重完成而素材服务上缺块；PC 有推送队列兜着，主机没有。建议另开任务：主机（没有推送队列时）本机覆盖的也用 `blocksPresent` 核一遍，缺就走 `put`（`put` 会跳过已有的块）。
2. `sink-incomplete` 的真正原因要下一轮 C1 的 `why` 才能定（见上）。
3. `step` 要托管端（云端文档服务）也更新才生效；只更新节点时行为与现在相同。
4. 对任务书的更正：任务书让先 `npm ci`；子 Agent 协议（`multi_agent.md`）与派发说明都不许跑，worktree 在仓库目录下、依赖向上解析就能跑，所以没跑。
