# M6c X2～X5 实现报告（claude/m6c-queue）

状态：实现与验证完成，等主会话审查。分支 `claude/m6c-queue`（基于 `claude/m6`），worktree `.worktrees/m6c-queue`。未推送、未合并。

契约：`docs/plan/m6c-contract.md` 的 X2、X3、X4、X5；相关的旧契约是 `render-queue-contract.md` 的 A、F、I、J 节，`auth-contract.md` 第 6 节，`render-host-contract.md`。

## 1. 做了什么

### X2 没有哈希的素材：本地档能力闸

- **切分**（`server/render-node/split.mjs`）：`splitPlan` 新增两个参数，`localMedia`（发布方的 nodeId）和 `usesLocalMedia(control)`。两个都给了、且判真的快照任务和流任务，会在 `requires` 里写 `localMedia`。不给 `localMedia` 时任务形状完全不变。`localMedia` 不进结果键，任务 id 也不变。
- **哪些任务要设闸**（新文件 `server/queue-local-media.mjs`）：
  - 素材要同时满足两条：`mediaHashOf` 为空，而且按本机地址取，即 `path`、`/@media/<文件名>`、`/api/media/file?`、`/@export/`。
  - 项目里有这种素材时：
    - 本地档和流一律设闸；
    - 共享档（隔离单卡渲）只在它的片段 JSON 引用了这种素材的 id、url 或 path 时设闸；
    - 找不到片段时保守地设闸。
- **owner**：取 plan 的 `source.publisher.id`。M5b 起预渲染进程替页面发布 plan，PC 节点的发布方 id 就是它的 nodeId。所以即使窗口过后由别的 pc 切分，闸也指向素材所在的那台机器。
- **接线**（`server/vite-plugin-frames.ts`）：执行器的 `plan` 外面包一层，按 `service.entries.get(ctx.entryKey).project` 调 `withLocalMedia`。`prerender-executor.mjs` 没改，它的 `plan-mismatch` 照旧做纵深防御。
- **节点侧过滤**（`server/render-node/filter.mjs`，规则 1）：`requires.localMedia` 与 `node.nodeId` 不同就拒，原因是 `local-media`。
  - 会话（`session.mjs`）过滤时把自己的 nodeId 补进节点描述。
  - 放在规则 1 而不是新开规则 7，是为了不和 X1 在 `filter.mjs` 里加的 streams 规则撞号。
- **队列**（`server/render-queue/queue.mjs`）：
  - 可见性：`canSee` 在 `PREFILTER` 下加 `localMediaAllows`，和 I.2 的指纹前置过滤在同一处。别的节点在 `queue.snapshot` 和 `task.opened` 里都看不见这类任务。
  - 认领：别的节点回 `claim-rejected { reason: 'local-media', state, version, localMedia }`。
    - 这一条不看 `PREFILTER`：它和 F.1 的 3a 一样是正确性闸。
    - 它计入限流次数。

### X3 `watch: 'all'` 收紧（队列本体）

- **`browser` 用 `'all'`**：回 `error { reason: 'forbidden' }`，带 reqId，原来的 watch 不变。
- **`host` 用 `'all'`**：
  - 回一条 `queue.summary { at, projects }`，形状照 H.3：只列有 open 或 claimed 的项目，带 `topPriority` 和 `openByFingerprint`，按 projectId 升序。
  - 此后每次 `tick()`，摘要与上次发给这条连接的不同才发，所以每个扫描周期至多一条。
  - 单任务增量一条都不发。
- **`pc`**：照旧。
- **host 怎么找到活**（`session.mjs` 的 `followSummary`）：
  - host 会话照旧报到后 watch `'all'`。收到摘要后，改 watch「摘要里有 open 的项目 ∪ 已 watch、摘要里还列着的项目」，随即收到这些项目的快照与增量。
  - 队列这边，host 的非空项目列表不停摘要，所以新项目有活时，下一条摘要又会带出来。空列表连摘要一起停：文档服务模块切到频道摘要时，替它发的正是空列表，这样不会重复收摘要。
  - 新项目最迟一个扫描周期（5 s）后被发现。
  - 诊断：`session.watching()`；`createRenderHost().nodes()` 多一项 `watching`。
- **换 profile 重新报到**：同一连接换 profile 再报到时，`'all'` 只有 pc 能留着，摘要只有 host 能留着。

### X4 plan 就近认领

- **常量**：`constants.mjs` 加 `PLAN_PREFER_MS: 5_000`，环境变量名 `PROMPTCUT_QUEUE_PLAN_PREFER_MS`。
- **发布**：
  - `planTaskOf` 接受 `preferNode`，写进 `requires`。
  - `vite-plugin-frames.ts` 发布 plan 时，`preferNode` 设为本机节点 id。
- **认领**（`queue.mjs`）：
  - host 或 browser 认领任何 plan，一律回 `plan-profile`。窗口内外都是，排在 `taken` 之前。
  - 带 `preferNode` 的 plan，发布后在 `at <= publishedAt + PLAN_PREFER_MS` 之内，只给那个节点认领。
    - 别的节点回 `claim-rejected { reason: 'preferred', state, version, preferNode, retryInMs }`。
    - 过期按 A.8 的口径用严格大于判。
  - 带 `preferNode` 的 plan 要查指纹，实现「任何指纹符合的 pc」：
    - 队列的前置过滤、认领时的 `fingerprint-mismatch`、节点侧规则 1 都查；
    - 没带 `preferNode` 的旧形状 plan 照 I.10 第 7 条不查，所以 V4、B.2 的旧用例不用动。
- **会话**：收到 `preferred` 时，候选留在视图里，搁到本地时刻 `now + retryInMs` 之后再考虑，不是每拍都撞。

### X5 本机队列节点的闲时门槛放宽

- **新文件 `server/queue-idle.mjs`**：`createQueueIdleGate` 的判据是：最近 500 ms 没有交互帧请求，而且管线不忙，就可以认领。
  - 交互帧请求：`/api/frames/see` 的 `user` lane、`/api/frames/playback`。`vite-plugin-frames.ts` 在这两处路由记时刻。
  - 管线忙：以下任一。
    - 旧预览热池在播；
    - 后台让路租约在期，或正在让路；
    - 播放头在播、且 5 s 内有过音讯；
    - 播放头 500 ms 内动过。
- **不挡的**：preload 没到 ready、流在产。
- **执行器有空位**：由会话的 `maxConcurrent` 守，本机节点为 1。
- **本机节点**：`isIdle` 从 `executor.isIdle()` 换成门槛。
- **忙时的处理**：去掉了 M5b 在忙时 `yieldAll("busy")` 的那一句，改成照语义「不认领新的，手里在做的做完」，见第 4 节的语义冲突。
- **诊断**：`queue.idle`（此刻不能认领的原因）、`queue.firstClaims`（第一次认领 plan 和第一次认领细任务的时刻，以及那一刻 preload 各代际的状态）。
- **`queue-mode-probe`**：队列模式那一趟多打一行 `[x5] {…}`，输出里另有 `x5` 字段。它只记录，不据此判失败。

## 2. 文件

| 文件 | 改动 |
|---|---|
| `server/render-queue/constants.mjs` | `PLAN_PREFER_MS` 及其环境变量名 |
| `server/render-queue/queue.mjs` | X2 可见性与认领闸；X3 `onWatch`、`summaryOf`、tick 第 6 项；X4 `plan-profile`、`preferred`、plan 指纹 |
| `server/render-node/filter.mjs` | 规则 1：`local-media`、带 `preferNode` 的 plan 查指纹 |
| `server/render-node/session.mjs` | 过滤补 nodeId；`preferred` 搁置；host 的 `followSummary`、`watching()` |
| `server/render-node/split.mjs` | `planTaskOf` 的 `preferNode`；`splitPlan` 的 `localMedia` / `usesLocalMedia` |
| `server/render-node/local-node.mjs` | 只补 JSDoc（PlanContext 的两项） |
| `server/render-node/host.mjs` | 文件头说明；诊断 `nodes()` 加 `watching` |
| `server/vite-plugin-frames.ts` | 执行器包一层加 localMedia；plan 带 `preferNode`；闲时门槛；路由记交互；诊断 |
| `server/queue-local-media.mjs` | **新**：X2 判据 |
| `server/queue-idle.mjs` | **新**：X5 门槛 |
| `scripts/probes/queue-mode-probe.mjs` | X5 证据行 `[x5]` 与输出字段 `x5` |
| `server/test/m6c-queue-impl.test.mjs` | **新**：X2-1～X5-3，共 17 条 |
| 既有测试 11 个文件 | 见第 5 节 |

没改：`prerender-executor.mjs`、`frame-stream.mjs`（归 X1）、`frame-pipeline.mjs`、`server/docservice/modules/render-queue.mjs`。

## 3. 验证（命令、退出码、原始关键行）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，没有输出 |
| 全量测试 | `npm test` | 第一次：`tests 2614 / pass 2612 / fail 1 / skipped 1`；第二次：`tests 2614 / pass 2613 / fail 0 / skipped 1`，退出码 0。第一次那条失败的原因见下 |
| 本任务单测 | `node --test server/test/m6c-queue-impl.test.mjs` | `tests 17 / pass 17 / fail 0`，第一次就全过 |
| 队列相关的旧测试 | `node --test server/test/render-queue-*.test.mjs render-node-* card-lock-* render-host* queue-node-wiring docservice* auth-*` | 改测试前：`tests 518 / fail 55`（原因见第 5 节）；按 X3 / X4 调整后：`tests 518 / pass 518 / fail 0` |
| ready-index-probe | `node scripts/probes/ready-index-probe.mjs --port 5430`（TEMP / TMP 指到 scratchpad） | 退出码 0，`"fails": []` |
| preview-fallback-probe | 自起 `vite --port 5430 --strictPort --host 127.0.0.1`，再跑 `--origin http://127.0.0.1:5430` | 退出码 0，`PASS`；`beats 286, transparentBeats 0, taskP90 13.767, pageErrors [], fails []` |
| preview-fallback-probe `--page-preload` | 同一台 dev server | 退出码 0，`PASS`；`beats 283, transparentBeats 0, taskP90 15.44, pageErrors [], fails []` |
| queue-mode-probe | `node scripts/probes/queue-mode-probe.mjs --normal-port 5430 --queue-port 5433 --docservice-port 5436` | 退出码 0，最后一行见下 |

**第一次 `npm test` 那条失败**：失败的是 `bad-ports.test.mjs` 的「npm test 下坏端口在 127.0.0.1 上已被全局准备占住」。`PROMPTCUT_TEST_BAD_PORTS_HELD` 是空的，也就是全局准备一个坏端口也没占到。随后用 netstat 看，这些端口已经没人占，推断是同一时刻别的 worktree 的 `npm test` 占着它们（跨进程冲突）。这条与本改动无关，我没有去排查，只按回退规则允许的一次重跑了全量，第二次全绿。

**queue-mode-probe 的 X5 证据行（原样）**：

```
[x5] {"readyAfterMs":73908,"firstPlanClaim":{"id":"plan:queue-mode-probe@1","afterPreloadMs":138,"preload":["html"]},"firstFineClaim":{"id":"snapshot:5cfc864ede7c3a160687bdde5fd1218d522523904c822f418c7ca0e149bd7ad0:0-59","afterPreloadMs":2148,"preload":["html"]},"claimedWhileNotReady":3,"fineClaimedBeforeReady":true}
{"ok":true,"tasks":5,"done":5,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"x5":{…同上…},"fails":[]}
```

- preload 开跑后 138 ms 认领了 plan，2148 ms 认领了第一个细任务，那一刻 preload 的状态都还是 `html`。preload 到 ready 用了 73.9 s，等 ready 期间读到的认领数是 3。
- 队列模式的统计：`claimed 6 / completed 5 / dedup 0 / failed 0 / lost 0 / planSplit 1`。
- 与普通模式的帧库逐字节相同：`identical: true`。
- 两趟 preload 的时长：普通模式 100.7 s，队列模式 73.9 s；队列模式全部细任务落定用了 102.2 s。

**X2～X5 验收对照**（`m6c-queue-impl.test.mjs`）：

| 编号 | 验收标准 | 对应用例 | 结果 |
|---|---|---|---|
| X2 | 别的节点对这类任务的认领数为 0，收到的 `task.opened` 为 0 条；发布方节点把它们全部完成 | X2-5 端到端；另有 X2-1～X2-4 覆盖判据、切分、节点侧过滤、队列前置过滤与认领闸（过滤开、关两种） | 全过。X2-4 的 diagnostic：`PREFILTER=true：B 快照 0 条，B 收到 localMedia 任务的 opened 0 条`；`PREFILTER=false：B 快照 1 条，opened 1 条`，但认领照样回 `local-media` |
| X3 | `browser` 节点 `watch: 'all'` 回 `forbidden` | X3-1 | 全过 |
| X3 | `host` 用 `watch: 'all'` 时单任务增量 0 条，摘要每项目每周期至多 1 条 | X3-2（diagnostic：`单任务增量 0 条，摘要 6 条（6 个周期）`，每个没有变化的 tick 为 0 条）；另有 X3-3、X3-4 | 全过 |
| X4 | 窗口内别的 `pc` 节点认领 `plan` 回拒绝 | X4-2 | 全过 |
| X4 | 窗口过后能认领 | X4-3、X4-5 | 全过 |
| X4 | `host` 与 `browser` 认领 `plan` 0 次 | X4-4（三个时刻各试 host 和 browser，认领 0 次） | 全过 |
| X5 | preload 未 `ready` 时本机节点已开始认领细任务 | X5-2（单测）；queue-mode-probe 的 `[x5]` 证据行（真实运行） | 全过 |
| X5 | 模拟拖动期间新认领 0 次 | X5-3（diagnostic：`拖动 3 s 期间新认领 0 次；拖动前在做的 … 状态 done`，没有 `task.release`，停手满 500 ms 后恢复认领）；另有 X5-1 覆盖门槛判据 | 全过 |

没跑的项：`verify-determinism`、`verify-unified-frames`、导出像素比对。本任务不改渲染、导出、快照的产出路径，只改由谁认领、什么时候认领。queue-mode-probe 的队列模式帧库与普通模式逐字节相同，可以旁证。这几项留给主会话集成时的 G0-R 一并跑。

进程：dev server 是我用 `Start-Process` 起的（PID 57316），探针跑完用 `taskkill /PID 57316 /T /F` 只结束了它自己的进程树，5430～5432 已释放。其余探针自己起、自己关。跑完 5430～5439 没有监听。

## 4. 与契约、语义不一致之处，以及〔实现方的取舍〕

1. **语义冲突（已按语义改）**：M5b 的本机节点在播放、拖动时 `yieldAll("busy")`，把在跑的任务放回去。这与 `docs/semantics/architecture/platforms.md` 第 30 行不符：原文说播放、拖动时不认领新任务，「手里在做的那一批做完为止」。X5 按语义去掉了放回。
   - 遗留：旧预览的让路租约在期时，`frame-pipeline.mjs` 的 `'queue'` lane 仍会抛 `Background yielded to playback`，那一段任务按可重试失败处理。这个文件不在本任务的范围内。
2. **X4 推翻了 `render-host-contract.md` 第 6 节的一条裁定**：原裁定是「队列侧不因 `profile: 'host'` 拒 plan 认领」。按 X4「host、browser 始终不认领 plan」，现在队列侧回 `plan-profile`。建议主会话在那一节补注。
3. **X3 放在队列本体实现**，没放在文档服务模块，理由有三：
   - X2 明说前置过滤在队列里；
   - 单测能直接覆盖；
   - 更要紧的是，host 要「摘要 + 具体项目的增量」同时成立才找得到活，而 H.3 模块层的「以最后一条为准」让这两者互斥。
   - 由此定的细则：host 的非空项目列表不停摘要，空列表停。这是对 H.3 的补充，建议写进契约。
   - 队列发出的 `queue.summary` 经模块的 `outbound` 时不带合并键。队列本身每个 tick 至多一条，影响不大，模块想合并可以以后补。
4. **X4 的指纹只对带 `preferNode` 的 plan 生效**：旧形状的 plan（没有 `preferNode`）照 I.10 第 7 条不查指纹，这样 V4、B.2 的既有断言不用改。M6c 起预渲染进程发的 plan 都带 `preferNode`。
5. **X2 的认领闸不看 `PREFILTER`**，可见性过滤看。理由：对照组只关前置过滤；认领闸管的是正确性，与 3a 同类。
6. **X2 的判据是启发式的**：共享档只按片段 JSON 找素材的 id、url、path。卡片经图节点（`cardNodes`）间接引用本地素材的情形判不出来，登记为遗留。本地档与流一律设闸，是保守的做法。
7. **端口段重叠**：契约的分支表把 5430～5439 分给了 `claude/m6c-tests`，本次也分给了我。我跑探针时没遇到冲突，但两边并行时可能撞上。

## 5. 改过的旧测试（全部因为 X3 / X4 的行为变化，逐条）

原则：旧测试里 host 只是「只看不做的 watch 者」或者一般的工作节点、依赖 `'all'` 全量增量的，改用 pc。这样行为与 X3 之前完全相同：队列里 pc 与 host 只在 X3 / X4 上有区别，节点侧 pc 空闲时的重度策略也是全收。纯浏览器节点的 `'all'` 改成列出项目，可见性相同。断言一条都没放宽。

| 文件 | 用例 | 改了什么 | 为什么 |
|---|---|---|---|
| `render-queue-fault.test.mjs` | 公共 `setup` 的 W（F1～F7 共 25 条都用它） | W 从 host 改为 pc；文件头注释同步 | X3：host 的 `'all'` 不再收 `task.opened` / `closed` |
| `render-queue-protocol.test.mjs` | 公共 `setup` 的 W | host → pc；注释同步 | 同上 |
| 同上 | P5 | br2 的 watch 从 `'all'` 改为 `['proj-1','proj-2']` | X3：browser 的 `'all'` 回 forbidden |
| 同上 | P7 | br 的 watch 从 `'all'` 改为 `['proj-1']` | 同上 |
| 同上 | P14 | 常量表与环境变量表加 `PLAN_PREFER_MS` | X4：新常量进 `constants.mjs` |
| 同上 | P15、P16 | 切分节点 n、m、n2 从 host 改为 pc；P15 的 br1、brS 改为 watch `['proj-1']` | X4：host 认领 plan 回 `plan-profile`；X3 同上 |
| `render-queue-state.test.mjs` | 公共 `setup` 的 W | host → pc | X3 |
| 同上 | S-4 | 随机模型里 node-B 从 host 改为 pc；browser 抽到 `'all'` 时改列两个项目（仍消耗同一个随机数，随机序列不变） | X3 |
| `render-queue-prefilter.test.mjs` | `joinNode`、V4 的 node-E、K 系列会话的 `nodeDesc` | host → pc | X3：这些用例要的是全量可见性 |
| `card-lock-queue.test.mjs`（**Q 系列的公共夹具**） | `setup` 的 watch 者 w | host → pc，注释同步 | X3。Q4（两条）、Q9、Q11 断言 w 收到 `task.closed` 等增量。**Q 系列的断言一条没改**，只改了夹具里 w 的 profile |
| `render-queue-inproc.test.mjs` | I5 | `addNode` 新增可选的 `projects`；浏览器节点 watch `['p1','p2']` | X3：browser 的 `'all'` 回 forbidden |
| `auth-spaces.test.mjs` | AU9（第一条） | host 节点的 watch 从 `'all'` 改为 `[task.source.projectId]`，仍比对快照 | X3：host 的 `'all'` 回摘要而不是快照 |
| `docservice-auth.test.mjs` | A3 | host 节点 watch `['proj']` | X3：要看 `task.opened` |
| `docservice-backpressure.test.mjs` | I4 末段「切回全量」 | host2 改为 pc | X3：host 的全量 `'all'` 只收摘要；这一段验证的是模块的切换 |
| `render-node-ws.test.mjs` | 公共 `NODE`（T 系列） | host → pc | X3：host 按扫描周期发现项目，T 系列测的是传输 |
| `render-host.test.mjs` | RH2、RH6 | 等待循环里加一次队列 tick（RH2 是 `svc.service.tick()`，这个服务 autoTick 关着；RH6 是 `s.queue.tick()`） | X3：host 凭 tick 发的摘要才知道哪个项目有活。host 仍是被测对象，断言不变 |

N、L、W 系列：没有改。Q 系列：只改了第 5 节表里那一处公共夹具。

## 6. 遗留

- X2 判不出经图节点间接引用的本地素材，见第 4 节第 6 条。
- `frame-pipeline.mjs` 的 `'queue'` lane 在让路租约期间仍会取消任务，见第 4 节第 1 条。
- host 发现新项目要等一个扫描周期（生产 5 s）。如果要更快，可以在队列里加「新项目出现时立即补发一条摘要」，但那样就不满足「每周期至多一条」了，需要主会话定。
- `prerender-executor.mjs` 的 `isIdle()` 已经不被 PC 节点使用；host 本来就不用它。清理留给 X1 所在的分支，或者集成时处理。
- 文档服务模块转发队列发出的 `queue.summary` 时不带合并键，见第 4 节第 3 条。
- 建议主会话把第 4 节第 2、3 条补进对应契约。
