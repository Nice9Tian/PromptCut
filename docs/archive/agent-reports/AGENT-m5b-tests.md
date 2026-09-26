# M5b 测试方报告（m5b-tests）

分支 `claude/rq-m5b-tests`，基于 `claude/rq-m5b`（5c4635f）。依据：`docs/plan/render-queue-contract.md` J 节（J.7 的 J1～J11）、设计附件 `docs/plan/queue-executor-design.md` 第 2、3、7 节。对抗式分工：没看实现方分支 `claude/rq-m5b-svc`、`-node`、`-pipeline` 及其 worktree。

## 做了什么

新增三个测试文件，没有新增 `fake-*.mjs`（复用 `fake-docservice-env`、`fake-manifest-env`、`fake-ws-kit`、`fake-loopback-transport`、`fake-render-executor`、`fake-asset-service`、`fake-artifact-fixtures`）。没改生产代码，没标 skip。

| 文件 | 用例 | 做法 |
|---|---|---|
| `server/test/project-snapshot.test.mjs` | J1～J4，13 条 | 真文档服务（独立模式、端口 0、memory 或临时目录的文件存储）挂项目模块；J4 用 M5a 的 `createWsEndpoint`，「服务端不回」用吞掉 `project.*` 的假模块，乱序配对与摘要校验用只记消息的假端点 |
| `server/test/queue-node-wiring.test.mjs` | J5～J7，11 条 | J5：真队列 + 环回传输 + 一个本机节点 + 页面发布方，先用记账的假 sink，再用 C6.2 的真 `createAssetSink`（真帧库、memory 素材服务、内容库）走 put 与跨机去重；J6：`splitPlan` / `planTaskOf` 单测，外加带 `requires` 的 plan 经真队列发布；J7：注入的 `fetch`，不起服务器 |
| `server/test/prerender-executor.test.mjs` | J8～J11，9 条 | 照附件第 7 节：`mock.module` 换掉 `bakery/index.mjs`，假 `openBakery` 回的预渲染间 `page.evaluate` 给出 `{ graph, sourceVersions, environment }`；`FramePipeline` 注入 `environment`；对照组在另一个帧库上跑现有的 `fillCardControls` / `renderLocalSnapshots` |

每个文件 `node --check` 通过；全部用 `node:test`、测试名以编号开头、端口 0、不起 Chrome。

## 当前结果（实现未合入）

`node --experimental-test-module-mocks --test <文件>`：

- `project-snapshot.test.mjs`：0 过 / 13 败。全部因为项目模块回 `unsupported`、`project-client.mjs` 不存在、存储没有 `writeBlob`。
- `queue-node-wiring.test.mjs`：2 过 / 9 败。
  - 通过的两条是兼容性用例：「put 回 `{ complete: true }` 不带 result 时只报 `{ ranges }`」「sink 没有 `resultFor` 时只报 `{ ranges, dedup: true }`」。
  - 失败的九条：J5 的清单没进 `result`、`resultFor` 没被调用；J6 缺 `canvasHeavy`、`planTaskOf` 不写 `requires`；J7 没有 `editor` 一项。
- `prerender-executor.test.mjs`：1 过 / 8 败。
  - 通过的是 J11（对照现有行为）。
  - J8～J10 全部因为 `server/prerender-executor.mjs` 不存在。

逐条：

| 用例 | 现在 |
|---|---|
| J1 分片上传后 get 按序收回、逐字节相同 | 败 |
| J1 乱序、重传、收齐前 missing、各版不互相覆盖 | 败 |
| J1 大快照约 1.5 MiB，get 分多片送回、连接不被背压关掉 | 败 |
| J2 摘要不符回 digest-mismatch、丢弃已收分片、重传可收齐 | 败 |
| J2 没 announce 的版本回 unknown-rev | 败 |
| J3 文件存储重启后能取回、missing、无临时文件残留 | 败 |
| J3 存储层 writeBlob / readBlob（memory 与文件） | 败 |
| J4 announce、putSnapshot、get 往返，分片 ≤ 512 KiB，index.mjs 转出 | 败 |
| J4 并发两份不串 | 败 |
| J4 putSnapshot 被拒时带 reason | 败 |
| J4 超时 code: timeout | 败 |
| J4 断线 code: disconnected、不重放 | 败 |
| J4 get 校验摘要、按 reqId 配对 | 败 |
| J5 put 路径：`{ ranges, ...result }`，ref 带 input / requires | 败 |
| J5 put 不带 result：只报 `{ ranges }` | 过 |
| J5 去重路径：`{ ranges, dedup: true, ...resultFor }` | 败 |
| J5 没有 resultFor：只报 `{ ranges, dedup: true }` | 过 |
| J5 resultFor 回 null | 败 |
| J5 真 sink：A 走 put、B 跨机去重 | 败 |
| J6 input.canvasHeavy | 败 |
| J6 planTaskOf 写 requires | 败 |
| J6 带 requires 的 plan 经真队列：代码版本过滤 | 败 |
| J7 editor 模式、源推导、https→wss | 败 |
| J7 顺序：环境变量 → 编辑器 → 回环 → 离线 | 败 |
| J8 plan：entryKey、cardId、去掉 sourceDependent、streams 空、锚帧、权重、E.5 不变量、不渲染 | 败 |
| J8 plan：no-snapshot、可重试、不开预渲染间 | 败 |
| J8 isIdle | 败 |
| J9 共享档逐段渲 = fillCardControls 一次渲完（调用记录、落盘逐字节）、进度 | 败 |
| J10 本地档逐段渲 = renderLocalSnapshots（全局帧换算、落盘逐字节） | 败 |
| J10 本地档只渲缺的帧 | 败 |
| J10 plan-mismatch（8 种）、stream-not-supported | 败 |
| J10 中途中止、重渲补齐 | 败 |
| J11 不传范围参数时 fillCardControls 不变 | 过 |

合计新增 33 条：3 过、30 败。

## 自检：临时参考实现

在 worktree 里建了唯一名字的沙箱目录 `.m5b-ref-831ade4b/`，内容是 `server/`、`src/` 的副本，依赖向上解析到主仓库的 `node_modules`。在沙箱里按契约写了最小参考实现，覆盖：

- 存储的 `writeBlob` / `readBlob`；
- 项目模块的快照；
- `project-client.mjs`；
- `local-node` 的 ref 与完成清单；
- `split` 的 `canvasHeavy` 与 `planTaskOf`；
- `endpoint` 的编辑器一项；
- `FramePipeline` 的 `runQueueTask`、`planForQueue`、`renderCardSnapshotRange`、`renderSceneSnapshotRange` 和 `fillCardControls` 的第 5 个参数；
- `prerender-executor.mjs`。

用这份参考实现跑三个测试文件：

- `project-snapshot`：12 过 / 1 败。败的是「J1 大快照」，原因见疑点 1。
- `queue-node-wiring`：11 / 11 过。
- `prerender-executor`：9 / 9 过。

自检发现并修正了测试本身的三处问题（都已提交）：

- J4 超时用例三个请求一次全发出，后两个计时为 0；改成逐个发。
- J4 并发用例体积大到撞上背压，和它要测的「不串」无关；缩小了体积。
- J6 队列用例原先断言「别的指纹认领不到 plan」，契约不支持这个断言（见疑点 3）；改成只断言代码版本过滤。

沙箱已删除，参考实现没有提交。

## 基线

- `npm test`（worktree 里，含新文件）第一次：2427 条，2395 过、31 败、1 跳过。
  - 31 条里 30 条是上面列的新用例。
  - 另一条是既有的 `asset-client.test.mjs` 的 L3「某片回 500 两次再成功」，在满载并行下偶发失败。单独跑 3 次都是 6/6 过。
- `npm test` 第二次：2396 过、30 败、1 跳过。失败的只有三个新文件（8 + 13 + 9）。既有测试全过。
- `npx tsc -b --force`：退出码 0，无输出。

## 契约疑点与更正建议

1. **J.1 的 `get` 与 H.2 的背压冲突（参考实现实测复现）。**
   - 冲突在哪：`get` 一次回齐全部分片，单片可到 512 KiB，整份可到 32 MiB；核心的出站上限 `MAX_PENDING_BYTES` 是 1 MiB。
   - 实测：参考实现取 1.5 MiB 的快照，连接被以 `1013/backpressure` 关掉。
   - 为什么模块自己绕不过去：模块拿到的 `ctx` 只有 `send`，没有 `buffered` / `drained`，没法自己节流。
   - J4 第一条（1.2 MB）在参考实现上碰巧通过，是本机回环的内核缓冲吃下了，换成真网络就不稳。
   - 建议三选一：
     - `project.snapshot.get` 带 `index`，由客户端逐片要；
     - 核心给模块一个按排空节奏发送的接口；
     - 放宽这类回包的上限。
   - 测试按「32 MiB 以内取得回来、连接不被关」写，没有改。
2. **`isIdle` 的依据写错了节号。** J.4 写「附件第 5 节的判据」，附件第 5 节讲的是卡片源码，判据其实就在 J.4 正文里。
   - 另外「流在忙」没定义，可能指 `streamBusy()`，也可能指 StreamProducer 在产。测试只测了「后台让路中」和「preload 代际」两条。
   - 已中止的代际按「不是活的」处理，依据是 J.4 的「有活的 preload 代际」。
3. **plan 的 `requires.envFingerprint` 不参与认领过滤。**
   - B 节 `filter.mjs` 规则 1 和 I.2 都把 plan 排除在指纹过滤之外。
   - 后果：附件第 6 节说的「发布方所在进程优先认领」没有机制保证。任何代码版本相同的节点都能认领 plan，并用它自己的指纹给全部细任务出键。
   - 需要主 Agent 定：要不要让 plan 的指纹也参与过滤。
4. **快照文件名与 `writeBlob` 的 name 形式没写死。**
   - 契约写的是 `projects/<编码后的 projectId>@<projectRev>.json`，没说 `@` 本身编不编码。按 C6.3 的规则，`@` 会编成 `%40`。
   - `writeBlob` / `readBlob` 是同步还是异步也没写。
   - 测试只要求：`projects/` 下有 `.json`、没有临时文件残留、`writeBlob('projects/p@1', …)` 能往返（测试里一律 `await`，同步、异步都行）。
5. **announce 登记的摘要与上传的 `digest` 不同时，什么时候报错没说。** 测试两种都接受：第一片就拒，或收齐后才报，但必须是 `digest-mismatch`、不能收齐。
6. **收齐之前 `get` 回什么没说。** 测试按「没有这份快照」回 `missing` 断言。
7. **几处形状是按附件推断的**：
   - `fillCardControls` 的第 5 个参数取 `{ range: { from, to }, onBatch }`；
   - `weightOf` 回 `{ class }`，与 D.1 相同；
   - `createProjectClient` 只断言 `timeoutMs` 这一个选项（`content-client` 另外还能注入计时器）；
   - 流任务带不带 `canvasHeavy` 没写，测试没管。
8. **J8 另加了一条断言**：plan 不借 `background` lane（附件第 2 节：用新的 queue lane）。
