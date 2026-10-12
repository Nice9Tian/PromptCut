# AGENT-rr-noreplay：产流时 remotion 式的卡不从挂载帧回放（服务端一半）

分支 `claude/rr-noreplay`，基于 main（`2adfce53`）。依据：`docs/plan/prerender-products-contract.md` 第 4.2 节、第 9.3 节、第 16 节；
`docs/plan/render-refactor-task.md`「戊」现状第 3 条。在线一侧（`src/StageView.tsx` 的 `bakeFrame` 直接拨时钟）不是这一块，另有子 Agent 在改。

## 做了什么

只改了 `server/frame-stream.mjs`（外加测试与探针），`server/bakery/` 一个字没动。

1. **`planStreams` 每条流带 `replay`**（要不要从挂载帧回放）。判据是新导出的 `streamNeedsReplay(controls)`：
   全部成员都是 remotion 式（`control.frameMode === 'direct'`，顶层没有时退到 `capabilities.frameMode`）才不要回放；
   成员里有一张 motion 式（`stateful`）的、写法没带的、声明了 `need_prerendering` 的，一律要回放（宁可多回放，不可画错）。
   这和 `server/snapshot-tier.mjs` 判「有状态」的口径一致。`replay` 不进任何键：流键由成员的内容身份算出，那里已经带着卡的声明，所以键没有变。
2. **`StreamProducer.runSegment`**：不要回放的流给 `bakeStream` 传 `warm: 0`、不传 `mountFrame`。`bakeStream` 对没给 `mountFrame` 的处理本来就是从 `fromFrame` 起挂载，
   所以接不上租约时只付一次重灌页面，不再从挂载帧逐帧推过来，也不预热 3 帧。要回放的流行为一字未变。
3. **分段可以不按顺序产**：调度那边（`planStreamSegments`、`nextTask`）本来就不要求顺序，只是「接得上租约就接着做」。不要回放以后，跳段的代价从「重灌页面 + 回放 N 帧」降到「重灌页面」，
   无需再改调度；单测与探针都按 7、3、5/9 这样不相邻的顺序产过。
4. **诊断**：`StreamProducer.status()` 的每条流多 `replay` 和累计 `replayedFrames`，`stats` 多 `replayedFrames`（取自 `bakeStream` 回的 `replayed`），供探针核对「恒为 0」。
5. 没动 `server/card-cache.mjs`（`plan` 已经带着 `frameMode`）。`queueStreamOf`（切分给浏览器节点的任务输入）没加 `replay`：浏览器节点产流走在线一侧的 `bakeFrame`，那边不归我。

## 提交

- `c1a20100` 不回放：产流计划带「要不要回放」，runSegment 不传挂载帧、预热 0；建报告
- `ed7740d8` 测试：planStreams 的 replay、runSegment 的选项、分段不按顺序产
- `6a7d6489` 探针：`scripts/probes/stream-noreplay-probe.mjs`

## 验证

测试用的 dev server 开在 27570（`vite --port 27570`，临时数据目录），探针自己的 dev server 开在 27560；用完按进程号收掉，无残留进程、无可见窗口（前后各查一次，均为 0）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（设了两个账号服务环境变量） | 退出码 0；tests 5691，pass 5687，fail 0，skipped 4 |
| 新单测 | `npm test -- server/test/frame-stream.test.mjs server/test/stream-noreplay.test.mjs` | 都过。故意把 `runSegment` 改成永远回放，新单测变红（`clip-d#7:不传 mountFrame`），还原后变绿 |
| 新探针 | `node scripts/probes/stream-noreplay-probe.mjs --port 27560` | 退出码 0，`ok: true`，`fails: []`（细节见下） |
| 生成快照的代码指纹 | `snapshotCode()` | 改前（main 根，`2adfce53`）`fb896e2f434c3133a459f35f9f5756ed`，改后（本分支）同一个值 |
| 截图的代码指纹 | `captureCode()` | 改前 `77387697d2c06da9d066bfa313508aaf`，改后同一个值 |
| 现有流生产探针 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:27570` | 退出码 0，`PASS`，`fails: []` |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:27570 node scripts/verify-unified-frames.mjs` | 退出码 0，PASS |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27570/?export=1"` | 退出码 0，1800 帧全部相同（Identical 1800，Different 0） |
| 源码版本的键 | `node scripts/probes/card-source-version-compare.mjs --base main` | 退出码 0，88 条源码版本、61 个身份，变 0 |
| 卡片身份摘要 | `node scripts/probes/card-table-digest-compare.mjs --expect ""` | 退出码 0，101 张内置卡的能力表、源码版本、三个键逐张相同，变 0。缺省的 `--expect` 是丁那一项的四张卡，本项不该变，所以传空 |

新探针做了什么（`scripts/probes/stream-noreplay-probe.mjs`；用 `av-pulse`、`probe-slow` 两张 remotion 式的内置卡，`punch-pill`、`probe-typewriter` 两张 motion 式的内置卡；
remotion 式的卡声明上是轻卡、不进预渲染集合，探针把 `pipeline.streamPicked` 钉成全选，让它们有流可产。夹具目录 `remotion-style/` 里的示例卡在审阅表里没有登记，
`compositing` 是 `unknown`，进不了流，所以没有用它们，用的是审阅表里登记过 independent 的内置 remotion 式卡）：

1. `planStreams` 的 `replay`：`clip-av`、`clip-slow` 是 false，`clip-pill`、`clip-type` 是 true。
2. 第一轮全部产完：两条 remotion 式的流 `replayedFrames` 为 0。
3. 把中间 7、3、5 三段作废再产（互不相邻，每段都断租约，`resets` 每条流 +6，稀疏一趟加补密一趟）：remotion 式的流 `replayedFrames` 增量 0；motion 式的流增量各 450（= (45+75+105)×2，照旧从挂载帧回放）。
4. 逐帧比（每条流的第 2、6 段，同一个会话重灌页面后分别 A 路不回放、B 路照旧回放，共 15 帧，PNG 像素逐个比）：
   - `clip-av` 第 2、6 段、`clip-slow` 第 2、6 段：不同的像素数各为 0（B 路分别回放了 16、76、30、90 帧；画面里有墨迹，不是空的）；
   - 对照：`clip-pill` 第 2、6 段差异像素合计 1538284、1346760，`clip-type` 第 2、6 段合计 15288、42588，必须比出差别、确实比出了。看图：`clip-pill` 第 6 段，不回放那路停在弹入途中（胶囊偏大带光晕），回放那路已经落定，所以该回放的卡不能省。
     图在 `out/noreplay-probe/shots/`（`out/` 不入库）。
5. 流库里 `runSegment` 不回放产出的 remotion 式的分段，与「B 路 PNG 用同一个编码器编出来的分段」**逐字节相同**（四对：22399、16267、14614、13981 字节，`sameBytes: true`）。

## 没做成的与原因

没有。耗时没有当通过条件；产流本身变快了多少没有专门量（只记：探针里 remotion 式的流断租约重产每段只付一次重灌页面，回放那路要多推 15～90 帧）。

## 对任务书或语义的更正建议

1. 契约第 4.2 节写「`bakeStream` 现在对『没给 `mountFrame`』的处理就是从 `fromFrame` 起，所以这一块可以不动 `bake.mjs`」：属实，本块没改。但同一节「预热帧数传 0（`bakeStream` 的 `warm`）」要注意，
   `warmUpAt` 传 0 时仍会做一次 `__pcRestartCards`、`__pcResetAnims` 和一帧 `step`，不是整段预热都省掉；探针显示画面逐字节相同，不影响正确性。
2. 契约第 4.2 节验收写 `StreamProducer.status()` 的 `resets`：`status().streams[].resets` 是活对象引用（不是拷贝），读的时候要立刻取数。本块新增的 `replayedFrames` 是数值，没这个问题。
3. 稀疏那一趟（`stride = 3`）里 `bakeStream` 仍然对每个没截图的中间帧调 `stepper`（为了租约连续）。对 remotion 式的流，这些中间帧是白推的，但要省掉得改 `bake.mjs`
   （会让生成快照和截图两份代码指纹换键），按契约第 9.3 节本块不做，记为以后改 `bake.mjs` 时可以顺手做的一项。
4. 浏览器节点认领的单卡流任务，任务输入由 `queueStreamOf` 给出，里面没有 `replay`（本块没加：它在 `server/render-node/split.mjs` 与在线一侧的消费方之间，不在本块的文件清单里，我也没有去核在线页面怎么用它）。
   若要让浏览器节点产流也不回放，要由负责在线一侧的那一块决定是否带上这一项。
