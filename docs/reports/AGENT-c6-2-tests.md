# AGENT 报告：c6-2-tests

角色：C6.2 测试方。分支 `claude/c6-2-tests`（从 `claude/c6-2` 的 71236d0 分出），worktree `.worktrees/c6-2-tests`。
依据：`docs/plan/artifact-transfer-contract.md` 第 1～7 节，以及后补的第 10 节第 1～9 条（主会话转来，已照改）。
只照契约写，没看 `claude/c6-2-asset`、`claude/c6-2-pipeline` 及其 worktree。

## 做了什么

| 文件 | 用例 |
|---|---|
| `server/test/asset-namespaces.test.mjs`（新） | S1、S2、S2b、S2c、S3、S4 |
| `server/test/asset-client.test.mjs`（新） | L1～L6 |
| `server/test/artifact-transfer.test.mjs`（新） | T1～T8 |
| `server/test/fake-asset-service.mjs`（新假件） | 三个文件共用：转译 `asset-service.ts`（C5 的办法）、起真 HTTP 素材服务（端口 0），三个命名空间都注入 memory 实现 |

新增用例共 **20 条**（S 6 条、L 6 条、T 8 条）。契约第 7 节三张表每行至少一条；另按第 10 节加了 S2b（MIME 表分开、候选扩展名）、S2c（fs 目录与候选文件名）、L6（超时）。

写法：
- **S 系列**：三个命名空间都注入 memory 实现，分片调成 1 KiB。S2 对 `media`、`snap`、`px` 各跑同一份剧本，逐字段比较状态码、11 个响应头和回包。剧本覆盖分片、对账、断片、收尾、409、Range、HEAD、CORS 预检、401。收尾回包的 `url` 按第 10 节第 2 条分命名空间核对；带 `url` 的回包不比 `content-length`，因为 url 长度不同。S3 的主体是 `asset-service.test.mjs`、`asset-store-http.test.mjs` 两个文件未改、照旧全过；另补一条：旧写法 `opts.store` 仍被认作 `media`。
- **L 系列**：真 HTTP。客户端的 `fetch` 包一层，记下每个请求（数 PUT、看请求头），必要时改写回包，用来模拟 5xx、网络错、篡改和永不返回。L2 **调小的是服务端 memory 实现的 `chunkSize`**（1 KiB），没有用大于 8 MiB 的数据。另验证：客户端 `chunkSize` 给 4096、256 或不给时，都按服务端的 1 KiB 切片（第 10 节第 4 条）。
- **T 系列**：不起 Chrome。`FramePipeline` 照 `card-lock-pipeline.test.mjs` 的办法构造：
  - 用 `mock.module` 换掉 `bakery/index.mjs`；
  - 注入 `environment`，`dataRoot` 指向临时目录；
  - 只用帧库、`commitSnapshots`、就绪索引和流生产者这几部分。

  其余做法：
  - A 的流按 `frame-stream.mjs` 的格式手工造（stream.json、init、m4s；字节是造的，不是真 fMP4）；
  - 任务的锁指纹故意与本机指纹不同；
  - `result` 经 JSON 往返后再交给 `applyResult`；
  - 查会话是否收到 `layer`：往 `pipeline.entries` 放一个带 `cardPlan` 的最小假 entry，再用 `ready.adopt` 建一个页面会话。

## 验证结果

- `node --check`：四个新文件都通过。
- 逐个跑（本分支上还没有实现，失败是预期的；没有标 skip）：

| 文件 | 命令 | 结果 |
|---|---|---|
| asset-namespaces | `node --test server/test/asset-namespaces.test.mjs` | 6 条全失败，2.4 s。S1、S4：未知路径落到兜底（没有 `snap` / `px` 路由）；S2：`snap` 的预检 404；S2b、S2c：`snap` PUT 404；S3：`opts.stores` 不认，走了缺省 fs 的 8 MiB 分片 |
| asset-client | `node --test server/test/asset-client.test.mjs` | 6 条全失败，0.3 s，原因都是「载不进 `server/asset-store/client.mjs`」 |
| artifact-transfer | `node --experimental-test-module-mocks --test server/test/artifact-transfer.test.mjs` | 8 条全失败，0.3 s，原因都是「载不进 client.mjs / artifact-transfer.mjs」 |

- `npm test`：退出码 1。共 2314 条：通过 2293，失败 20，跳过 1（原来就有）。**20 条失败正好是上面这 20 条新用例**，既有测试照旧全过。
- `npx tsc -b --force`：退出码 0，零错误。

**自检**：在临时 worktree `.worktrees/c6-2-tests-ref`（detached，不提交）里，按契约写了一份最小参考实现：
- `asset-service.ts` 的 `stores` 与命名空间路由、`isAssetServicePath` 的正则；
- `client.mjs`；
- `artifact-transfer.mjs`；
- `FramePipeline.adoptResult`；
- `StreamProducer.adoptSegments` 与 `adopted` 判定。

结果：
- 三个文件在参考实现上 **20 / 20 全过**：S 3.6 s、L 5.8 s、T 24.5 s，都在 60 s 内。
- 变异检查：去掉 `segmentState` 对 `adopted` 的判定，T5 失败；`applyResult` 不跳过已有帧，T4 失败。
- 自检时发现并修掉一个测试自身的错误：S2 原来连带 `url` 的回包也比 `content-length`。
- 用完已删掉那个 worktree（删前确认没有 junction）。

## 没做成的

- 第 10 节第 8、9 条是后补的，参考实现自检时还没有这两条。S2b、S2c 里针对第 8 条的断言，还没在参考实现上跑过：只过了 `node --check`，目前在本分支上照预期失败。
- `local-node.mjs` 什么时候把 `result` 带进 `session.complete`，契约说由 M5b 负责，本阶段没测。

## 契约疑点

1. **`collect*` 的回值形状**：第 4 节签名写 `→ SnapshotResult`，正文却说「同时返回一个 `readBlob`」。测试两种都认：`{ result, readBlob }`，或者清单本身、`readBlob` 挂在它上面。建议定成一种。
2. **`canvasHeavy` 从哪来**：任务（`TaskView`）里没有这个字段，`collectSnapshotResult(pipeline, task)` 拿不到卡的能力表。测试只要求 DOM 卡给出 `false`（T1），并要求 B 按它判出同样的 `oversize`（T2）。建议写明来源，比如 `task.input.canvasHeavy`，或者从帧库 `index.json` 记下来。
3. **本地档的 `sink.has(ref)`**：D.1 的 ref 只有 `{ resultKey, kind, tier, range }`。本地档的 `resultKey` 不等于落盘键（E.9），只凭 ref 算不出 `entryKey` 和 `dirKey`。测试传的 ref 多带了 `input`、`requires`，也只测了共享档和流的 `has`。建议规定 ref 带上 `input` 与 `requires`，或者说明本地档的 `has` 怎么算。
4. **`pipeline.streams()` 与现有的 `streamProducer()`**：第 5 节写 `pipeline.streams().adoptSegments`，现有代码里只有 `streamProducer()`，而且它只在 `interactive: true` 的实例里存在。测试两者都认；流用例的 B 用 `interactive: true`，并手动 `attachRoute()`、定下 `encoderName`。
5. **流分段的 `encoder` 字段**：现有 `stream.json` 的分段里没有 `encoder`，编码器名只记在 `inits[id].encoder` 上。测试期望清单里每个分段的 `encoder` 取它所用 init 的编码器名。
6. **新建的流 state 没有 `spec`**：`publish(state)` 要用 `spec.topClipId`，`segmentState` 要用 `spec.streamKey`。B 上原来没有这条流时，实现得自己补一个最小的 spec，否则发层会在 try 里被悄悄吞掉。T5 用 `stagedKeys()` 查发布结果，能暴露这个问题。
7. **T7「报错」落在哪一层**：测试允许 `collect*` 或 `pushResult` 抛出，`sink.put` 抛出或回 `{ complete: false }` 也都算报错，只是不能回 `complete: true`。建议写明 `sink.put` 遇到超限时是抛出，还是回 `complete: false`。
8. **`applyResult` 回值里 `written` 的口径**（算不算超限帧）没有定。测试只核 `fetched`、`skipped`；`written` 只要求不少于 59。
