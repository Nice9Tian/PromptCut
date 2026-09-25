# C6.4 测试方报告（c6-4-tests）

- 分支：`claude/c6-4-tests`（从 `claude/c6-4` dc1addc 起）
- 依据：`docs/plan/manifest-contract.md` 第 6 节；前提 `artifact-transfer-contract.md`（C6.2）、`docservice-contract.md`（C6.3）
- 对抗式分工：只照契约写，没看 `claude/c6-4-node`、`claude/c6-4-pipeline` 及其 worktree

## 做了什么

四个测试文件、两个新假件，共 24 条用例（契约表 16 个编号，部分编号拆成两三条）：

| 文件 | 用例 |
|---|---|
| `server/test/content-client.test.mjs` | Q1；Q2 ×2（真服务 / 假端点乱序回包）；Q3 ×4（超时、断线立即失败、断线不重放与迟到回包、断线状态下发请求） |
| `server/test/artifact-dedup.test.mjs` | U1 ×2（清单键与正文，含本地档、流；写清单失败不影响完成）；U2 ×2（sink 层；接进真 `local-node` 看执行器 0 次）；U3；U4；U5 |
| `server/test/artifact-push.test.mjs` | W1 ×2（130 帧三段、每段一次；推送卡住不挡 `commitSnapshots`）；W2；W3；W4；W5；W6 |
| `server/test/artifact-adopt.test.mjs` | A1 ×2（快照：共享档 + 本地档；流）；A2 |

新假件：

- `server/test/fake-manifest-env.mjs`：起文档服务（内容库，memory）、连 M5a 端点、建内容库客户端；计数包装（内容库、素材客户端，可注入失败与卡住）；可注入的假时钟；按真时间轮询的 `until`。
- `server/test/fake-artifact-fixtures.mjs`：沿用 C6.2 测试的任务、帧、流夹具；临时帧库与管线；素材服务 + 文档服务一起起。

写法：`node:test`，测试名以编号开头，端口一律 0，不起 Chrome（`bakery/index.mjs` 用 `mock.module` 换掉，并记调用次数作为「没有渲染」的判据）。

## 验证

### 语法

四个测试文件与两个假件 `node --check` 全部通过。

### 当前结果（实现未合入）

在本分支上直接跑（`node --experimental-test-module-mocks --test <文件>`）：

| 文件 | 通过 | 失败 | 说明 |
|---|---|---|---|
| content-client | 0 | 7 | 全部因 `server/render-node/content-client.mjs` 不存在 |
| artifact-dedup | 0 | 7 | 同上（每条用例起服务时要连内容库客户端） |
| artifact-push | 1 | 6 | W6 通过（它守的就是现状）；其余缺 `content-client.mjs` / `artifact-push.mjs` |
| artifact-adopt | 0 | 3 | 缺 `content-client.mjs` / `adoptFromManifests` |

另外只把我的参考客户端临时放进去（模拟 node 分支已合、pipeline 分支未合）再跑：dedup 1/7 过（U1 第二条：C6.2 的 sink 本来就不写清单），push 1/7 过（W6），adopt 0/3。失败原因都落在 pipeline 分支负责的部分。

### 用参考实现自检测试本身

在 scratchpad 私有目录按契约写了一份最小参考实现（内容库客户端、sink 的去重与写清单、推送队列、`frame-pipeline.mjs` 的钩子与 `adoptFromManifests`），跑测试时临时拷进 worktree、跑完 `git checkout` / 删除还原，没有提交：

- content-client 7/7、artifact-dedup 7/7、artifact-push 7/7（连跑 3 次都是 7/7，约 9.7 s）、artifact-adopt 3/3。
- 自检中发现参考实现的一个错（推送队列在块级优先级还没算完时就开推，W2/W3 顺序错），改参考实现后通过。测试本身没因此改。

### W6 的金样

W6 要求「没配推送队列时与 C6.2 之后的 main 完全一样」。做法：在 `claude/c6-4`（dc1addc，含 C6.2、C6.3）上跑同一串写入（两批共享档含一帧超体积、一批本地档、`storeSegment` 两个分段），把返回值、就绪索引的键、帧库里每个文件的 sha256（`stream.json` 的 `at` 先归一）记成常量写进测试。连跑两遍结果相同。

### 既有测试与类型检查

- `npx tsc -b --force`：退出码 0。
- `npm test`（本 worktree）：tests 2376，pass 2352，fail 23，skipped 1。23 条失败全部是本分支新增的四个文件（7 + 7 + 6 + 3），既有测试全过；skipped 的一条是既有的「集成:/api/cards/layout 对真实项目返回整数框」，与本分支无关。
- 参考实现与自检用的临时文件已删除；worktree 里没有留下未提交的生产代码改动。

## 没做成的、以及刻意没测的

- **U2「B 没有调执行器」**：除了 sink 层的断言，另写了一条接进真 `createLocalNode` + 环回队列的用例。它依赖 local-node 现有的「`sink.has` 为真就去重完成」（M3 已有），不依赖 M5b。`resultFor` 进 `task.done` 的 `result` 是 M5b 的事，这里没测。
- **A1 流**：`adoptFromManifests` 怎么算流的键，契约只说「每条流」。测试按 `planStreams(entry, { envFingerprint: 本机指纹, codeVersion: '<STREAM_CODE_VERSION>:' })` 算（与 `StreamProducer.update` 一致，管线缺省 `captureCode()` 为空）。实现若用别的办法算出不同的键，这条会失败。
- **钩子里本地档的 resultKey**：W1/W3 只走共享档的钩子；本地档的钩子没测（见下面疑点 3）。W2 的本地档是直接 `enqueue` 的。
- **第 4 节「接线」**（`vite-plugin-frames.ts`）与第 8 节的 G0-R、W3 换机实测：不在测试方范围。

## 契约疑点（请主 Agent 裁定）

1. **「配了推送队列的管线」怎么配没写。** `createPushQueue({ pipeline, … })` 收了管线，但管线怎么知道队列（构造参数、`setPushQueue`、还是 `createPushQueue` 自己挂上去）没定。测试的写法：管线有 `setPushQueue` 就调，否则设 `pipeline.pushQueue`。建议契约定成其中一种。
2. **退避的「注入时钟」没有选项名。** 测试按 M5a `createWsEndpoint` 的习惯传 `now`、`setTimeout`、`clearTimeout`。实现若用别的名字，W5 会失败（W4 也会挂一个真的 5 s 计时器）。
3. **钩子怎么得到 `count` 与本地档的 `contentKey`、锁指纹。** `commitSnapshots` 只收 `{ tier, entryKey, key, clipId, capabilities, items }`：
   - 最后一段的 `to` 要与 `split.mjs` 一致（`count - 1`），得从 card plan 找到这张卡的 control；
   - 本地档的 `resultKey = resultKeyOf("<entryKey>/<contentKey>", fp)` 同样要 control 的 `contentKey` 和指纹。
   测试在管线上挂了一个 entry，card plan 里有 control，以便实现能找到。建议契约写明「按 `entries` 的 card plan 用 `key`（+`entryKey`）反查 control；找不到就不进队」，以及钩子里的卡级条件（`canvasHeavy`、图卡、`unknown`、`belowDependent`）分别从哪里取。
4. **`enqueue(unit, priority)` 的 `priority` 是什么。** 数字还是名字（`'normal'`）？是调用方算好的最终级，还是只给卡级、块级由队列自己读帧文件算？测试 W2 直接传数字 0/1/2（含超体积的那段直接传 2）；W3 走钩子，只看推送顺序，不管这个参数怎么分工。建议写明。
5. **`adoptFromManifests` 的 `manifests` 计数口径。** 本机已有的段是「不查就跳过」，还是「查到清单、但一帧都不拉」？前者不计入 `manifests`，后者可能计入。A2 两种都认（2 或 3），`fetched`、`written` 按精确值断言。建议写明。
6. **`resultFor(ref)` 同步还是异步。** 签名写 `→ result | null`，但「本机覆盖的由 `collect*` 现算」只能异步。测试一律 `await`。建议写成 `→ Promise<result | null>`。
7. **`has` 的去重是否要求清单 `range` 与问的段完全一致**：契约只说「清单覆盖整段」。U4 只测了「清单少帧」，没测「清单 range 比问的更大」。现在的键已经含 range，查到的清单 range 必然一致，所以这条不影响结果，只是提一下。
8. **W1「每段进队恰好一次」的判据**：测试用「每段的清单只写一次、每个块只推一次」来判，不强求钩子只调一次 `enqueue`（契约允许钩子多调、队列去重）。
