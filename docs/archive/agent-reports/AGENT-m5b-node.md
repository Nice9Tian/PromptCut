# M5b 节点侧（m5b-node）报告

分支 `claude/rq-m5b-node`（基于 `claude/rq-m5b` 的 `5c4635f`），worktree `.worktrees/rq-m5b-node`。

依据：`docs/plan/render-queue-contract.md` J.3 的 `local-node.mjs` 与 `split.mjs` 两条（文件照 J.8 的 node 行），以及 D.1、D.2、B.4、E.5；`docs/plan/artifact-transfer-contract.md` 第 11 节第 2、3 条；`docs/plan/manifest-contract.md` 第 3 节。

## 1. 做了什么

只改了 J.8 node 行的两个文件。

### `server/render-node/local-node.mjs`

- 细任务的 sink `ref` 改为 `{ resultKey, kind, tier, range, input: task.input, requires: task.requires }`，`has`、`put`、`resultFor` 收到的都是它（`put` 另加 `artifacts`、`meta`）。
- `put` 路径：`session.complete(id, { ranges, ...r.result })`。
- 去重路径：sink 有 `resultFor` 时 `await` 它（和中止信号赛跑，落定后重判「仍持有」），`session.complete(id, { ranges, dedup: true, ...清单 })`；没有 `resultFor` 时与 D.2 完全一样。
- 展开前过一个小函数 `resultFields`：`null`、缺省、数组、非对象一律当没有清单，不展开。
- JSDoc 的 `SinkRef`、`Sink` 补上 `input`、`requires`、`put` 回包的 `result` 和可选的 `resultFor`；文件头的流程说明同步。
- 依赖没变，只引 `./session.mjs`、`./split.mjs`，D1 守门照旧。

### `server/render-node/split.mjs`

- 快照任务 `input.canvasHeavy = control.capabilities?.canvasHeavy === true`，总是写（布尔值）；流任务不写。
- `planTaskOf({ projectId, projectRev, priority, codeVersion, envFingerprint })`：给了的项写进 `requires`，没给的不写。两个都不给时 `requires` 仍是 `{}`，与 B.4 相同；`id`、`resultKey` 不变。

## 2. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | tests 2394，pass 2391，**fail 2**，skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，需要 5190） |
| 自测 | scratch 脚本（未提交，放在会话 scratchpad） | 退出码 0，`ALL OK` |

### 2.1 两条失败（没有改测试，待主会话裁定）

都在 `server/test/render-node-logic.test.mjs`，原因相同：测试对快照任务整形状做 `deepStrictEqual`，期望的 `input` 是 `{ clipId, cardId, entryKey, contentKey }`，实际多了 `canvasHeavy: false`。

- 第 521 行 `B.4 splitPlan：shared 与 local 档的内容键、结果键和完整任务形状`（期望形状在第 484 行的辅助函数里）
- 第 552 行 `B.4 splitPlan：没有 control.tier 时按 snapshotTier(capabilities) 定档；belowDependent 可取自 capabilities`

`render-queue-inproc`、`card-lock-node`、`env-fingerprint-keys`、`artifact-adopt` 等其余既有测试全过；`task.done` 的 `result` 多字段、`ref` 多字段没有引起失败。

两种处理，请主会话选：
- **A（我倾向）**：改测试的期望形状，加 `canvasHeavy: false`（夹具没有 `canvasHeavy` 的卡）。这与 J.3 的字面「`input.canvasHeavy = …=== true`」一致，J6 也可以断言 DOM 卡为 `false`。
- **B**：`split.mjs` 只在 `true` 时写。`collect*` 对缺省当 `false`（C6.2 第 11 节第 2 条），功能等价，既有测试不用动；但与 J.3 字面不符，J6 若断言 `=== false` 会失败。

### 2.2 自测内容

真队列（`createRenderQueue`）+ 环回（`fake-loopback-transport.mjs`）+ `createLocalNode` + 自写假执行器 + 自写假 sink（`put` 回 `{ complete: true, result: 清单 }`，可选 `resultFor`）。页面用 `planTaskOf({ …, codeVersion, envFingerprint })` 发布 plan，驱动到快照细任务的 `task.done`。

- `split`：`planTaskOf` 带两项时 `requires` 恰为 `{ codeVersion, envFingerprint }`，不带时 `{}`；canvasHeavy 卡、DOM 卡、本地档卡的 `input.canvasHeavy` 依次为 `true`、`false`、`false`；流任务没有该字段。
- plan 带 `requires` 后仍被同指纹、同代码版本的节点认领并完成。
- put 路径 `task.done.result`：
  `{"ranges":[[0,59]],"v":1,"kind":"snapshot","tier":"shared","resultKey":"3cba…","range":{"from":0,"to":59},"canvasHeavy":true,"frames":[[0,"hhh…",10]]}`；sink 调用序列 `has → put`，每次的 `ref.input.canvasHeavy === true`、`ref.input.contentKey`、`ref.requires.envFingerprint`、`ref.requires.codeVersion` 都在。
- 去重路径（有 `resultFor`）：`{"ranges":[[0,59]],"dedup":true,"v":1,…,"frames":[…]}`；调用序列 `has → resultFor`，`resultFor` 收到的 `ref` 带 `requires`。
- 去重路径（无 `resultFor`）：结果恰为 `{ ranges: [[0,59]], dedup: true }`，与 D.2 相同。

## 3. 没做成的

无。J.3 的 `endpoint.mjs`、`index.mjs` 两条属 svc 分支，按分工不做。

## 4. 契约疑点与更正建议

1. **`input.canvasHeavy` 与 B.4 的既有测试冲突**：见 2.1，需要裁定 A 或 B。建议 B.4 的任务形状里补上 `canvasHeavy`，免得以后照 B.4 写的测试再撞上。
2. **展开顺序**：J.3 写的是 `{ ranges, ...r.result }`、`{ ranges, dedup: true, ...清单 }`，清单在后，理论上清单里若有 `ranges` / `dedup` 字段会盖掉前面的值。C6.2 第 3 节的清单没有这两个字段，所以现在无害；我照字面实现。若想防，可以把 `ranges`、`dedup` 放到最后。
3. **`resultFor` 抛错**：照字面 `await`，抛错就走执行出错的分支，任务按可重试失败。`createAssetSink.resultFor` 自己吞错回 `null`，现在不会发生；若别的 sink 实现会抛，也许该当成「没有清单」照常去重完成，请裁定是否要写进 D.1。
4. **`planTaskOf` 缺省**：契约没说没给 `codeVersion` / `envFingerprint` 时怎样。我选了「不写这一项」，保住 B.4 的 `requires: {}` 和既有测试；若要求总写（值为 `undefined` 会在 JSON 里丢掉，效果一样），无需改动。
5. **`canvasHeavy` 只看 `control.capabilities`**：照 J.3 字面，没看 `control.canvasHeavy` 之类的顶层字段。`frame-pipeline.mjs` 第 1357、1401 行判卡级优先级时还看了另一处 `caps.canvasHeavy`（审阅表），如果 card plan 的 `capabilities` 不含审阅表的 `canvasHeavy`，两边会不一致；需要 pipeline 方确认 `CardFrameCache.plan()` 输出的 `capabilities` 是合并过审阅表的。

## 5. 按主会话裁定返工（契约 J.10）

- **选 A**：server/test/render-node-logic.test.mjs 的期望形状加 canvasHeavy: false。两条用例（第 521、552 行）的期望都由同一个辅助函数 expectSnapshot（第 484 行）生成，这个函数只有这两条用例在用，所以只改了这一行，别的没动。
- **esultFor 抛错算「没有清单」**：local-node.mjs 去重分支捕获 esultFor 的异常，照旧 session.complete(id, { ranges, dedup: true })；被中止时照旧丢弃。JSDoc 同步。
- 第 4 节第 2、4、5 条照原读法，不改。

验证（返工后）：
- 
px tsc -b --force：退出码 0。
- 
pm test：退出码 0；tests 2394，pass 2393，fail 0，skipped 1（需要 5190 的那条）。
- 自测加了一条：esultFor 抛错时 	ask.done.result 恰为 {"ranges":[[0,59]],"dedup":true}，调用序列 has → resultFor；原有四组照旧通过，ALL OK，退出码 0。