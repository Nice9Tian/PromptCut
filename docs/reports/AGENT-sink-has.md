# AGENT-sink-has

分支 `claude/sink-has`（从 `claude/stall-phases` 的 `889a8ef` 拉出）。任务：`AGENT-stall-phases.md` 的遗留第 1 条——产物库 `createAssetSink().has`（`server/artifact-transfer.mjs`）在本机帧库覆盖整段时直接回「已有」、不查素材服务。

代号：E3 = M8 验收里「文档服务重启后，已完成的任务走去重、执行器渲染 0 次」那一例；〔裁〕= 执行时因现有契约做不下去而改的地方，合入前请审。

## 提交

| 提交 | 内容 |
|---|---|
| `43eceb8` | 报告占位 |
| `2aff744` | 修复：`has` 补齐素材服务上缺的块再算已有；runner 给 `has` 传进度回调；测试 `sink-has.test.mjs` |
| （本报告） | 契约加注〔裁〕、报告 |

`src/`、`frame-pipeline.mjs` 都没动（代码版本不变）。

## 根因

`has` 的第 1 条是「本机帧库覆盖了整个 range → true，只看本机，不查素材服务」（`artifact-transfer-contract.md` 第 4 节原文）。推到一半丢了认领（例如 stall-phases 那种停滞收回、或断线），同一节点又认领到这一段时，本机帧库是全的，`has` 回 true，节点以去重完成——素材服务上只有前一次推上去的那一半块，别的成员按清单取不到。违反语义「节点先把产物推送到素材服务，再向文档服务报完成」（`product/document-service.md`）。

## 修法与理由

两条路比较：

| 路 | 块齐时 | 缺块时 | 代价 |
|---|---|---|---|
| (1) `has` 本机覆盖时按本机字节补推缺的块，推齐才回 true | 只问、不推，去重完成 | 补推缺的块（不重渲），去重完成 | 本机覆盖的段每次多问一遍素材服务（每块一次，并发 4） |
| (2) 缺块时 `has` 回 false、交回执行 | 同上（要逐块问） | 走执行器 → `put`：执行器会借预渲染间、可能开 Chrome、PNG 缓存不全时还会补渲 PNG；或按可重试失败交回，下一个认领者多半本机没有帧，要整段重渲 | 重渲或白借预渲染间 |

选 (1)：本机帧库里的字节就是要推的产物，直接补推既满足「先推送再报完成」，又满足 E3 的「已在素材服务里的直接完成、不重渲」。查的开销沿用 `pushResult` 的做法：每块 `client.put` 先 `GET chunks`，已有就跳过（`uploaded: false`），并发上限 4（`TRANSFER_CONCURRENCY`），不逐块串行；块齐时只有这些问询，没有上传。原来走内容库清单那一支本来就要逐块 `client.has`（`blocksPresent`），开销同一量级。

细节（`server/artifact-transfer.mjs` 的 `has`）：

- 本机覆盖整段、清单完整（开着小尺寸时两档都齐）→ 按本机帧库列清单 → `pushResult`（缺的补推、有的跳过）→ 写清单进内容库 → 回 true；推了东西时记一行 `sink.has-pushed { uploaded, skipped }`。
- 补推出错 → 回 false，记 `sink.has-push-failed { code, message, blocks, pushed }`；节点照常走执行 → `put` 再推（`put` 同样跳过已有的块）。
- 本机覆盖但缺小尺寸 → 回 false（与原来相同，交给执行器补小尺寸）。
- `has(ref, { report })` 的第二个参数可选，同 `put`：补推时每处理完一块报一次。`task-runner.mjs` 在去重阶段传进去，每报一次算工作推进了一步（契约 A.12 第 4 条的 `step`），补推一段较长时不会被当成卡死。

## PC 节点

`server/vite-plugin-frames.ts` 的本机队列节点（第 377 行）与独立渲染主机（第 821 行）用的是同一个 `createAssetSink`，原来有同样的问题；PC 另有推送队列（`artifact-push.mjs`）会在后台把本机产的段推上去，所以素材服务上最终会齐，但节点报完成时可能还没齐，订阅方那一刻按清单取会缺。这次一起修好了。纯浏览器节点（`src/online/browserNode.ts`）的 `has` 只认内容库清单且逐块核过，没有本机捷径，没有这个问题。

## 验证

- `npx tsc -b --force`：退出码 0，无输出。
- `npm test`：`tests 3773 / pass 3771 / fail 0 / skipped 2`，退出码 0。
- stall-phases 两份测试与本次新测试：`stall-phases.test.mjs` + `stall-phases-diag.test.mjs` + `sink-has.test.mjs` 共 15 / 15 过。
- 新用例改前 / 改后（改前 = 把 `artifact-transfer.mjs`、`task-runner.mjs` 的改动 `git stash` 掉，跑两遍结果一致）：

  ```
  改前 ✔ H2 本机帧库有、素材服务上块齐:has 回 true,一块都不推
       ✖ H1 本机帧库有、素材服务上缺一半块:has 补推缺的块(已有的跳过)后回 true   AssertionError: 素材服务上这一段的块齐了
       ✖ H3 补推失败:has 回 false,记一行 sink.has-push-failed                  actual: true, expected: false
       ✖ H4 推到一半丢认领、同一节点重新认领:以去重完成、执行器没再渲,素材服务上块齐   AssertionError: 素材服务上这一段的块应全齐,缺 30 块
       ℹ pass 1  fail 3
  改后 ℹ pass 4  fail 0（连跑 3 遍）
  ```

  H4 起初偶发一次「第二次认领在 manifest 阶段也被判停滞」：测试台的假时钟每拍推进 500 ms，而产物库读的是真文件，读文件的那几拍假时钟白白走过。改成每拍让真 I/O 落定再推进假时钟后稳定（这是测试台的时差，不是产品行为）。
- 本机替身「推到一半丢认领、自己重新认领」（脚本在会话临时目录 `sinkhas-probe.mjs`，没入库）：真文档服务（托管模式、凭证握手、WebSocket）+ 真素材服务（`asset-service.ts` 中间件、内存块库）+ 真素材客户端 + 真产物库 + 真 `createLocalNode`；素材服务前面一层在收下 30 块之后把其余 PUT 挂住不回，节点按停滞丢认领后放开（挂住的那 4 个请求一直不回，模拟旧执行的推送停在那里）。客户端时限放宽到 10 分钟，让它等到停滞收回而不是先按超时失败。改前用 `889a8ef` 的 `server/`（`git archive` 到 gitignore 下的 `out/`，跑完已删），端口 5752/5753 与 5754/5755，跑完进程自己退出、端口已释放：

  ```
  改前 131.3s node.task-lost {"reason":"stalled","phase":"push","push":{"blocks":60,"pushed":30,…}}
       131.8s node.task-dedup {"phase":"manifest"}   131.8s task.done {"dedup":true}
       133.2s result {"done":true,"renders":1,"blocks":60,"presentOnAssetService":30,"missing":30}
  改后 131.5s node.task-lost {"reason":"stalled","phase":"push","push":{"blocks":60,"pushed":30,…}}
       132.2s sink.has-pushed {"uploaded":30,"skipped":30}
       132.2s node.task-dedup {"phase":"manifest"}   132.2s task.done {"dedup":true}
       133.4s result {"done":true,"renders":1,"blocks":60,"presentOnAssetService":60,"missing":0}
  ```

  两遍都只渲了一次（第二次认领走去重），改前报完成时素材服务缺 30 块，改后补推 30 块、跳过 30 块，块齐才报完成。
- 没跑：导出确定性、快照重放一致、画面探针（没有改渲染与画面相关代码）。

## 改了哪些文件

- `server/artifact-transfer.mjs`：`has` 的本机分支、文件头注释。
- `server/render-node/task-runner.mjs`：去重阶段给 `has` 传 `{ signal, report }`。
- `server/test/sink-has.test.mjs`：新增 H1～H4。
- 契约：`docs/plan/artifact-transfer-contract.md` 第 4 节 `has` 那一条加〔裁〕（原文「只看本机，不查素材服务」）；`docs/plan/manifest-contract.md` 的 `has` 第 1 条加一句指过去。语义文档没改（这次是代码回到语义）。

〔裁〕原文：

> 〔2026-09-28 `claude/sink-has` 裁：本机覆盖了整段还不够，素材服务上也得齐——按本机帧库列清单，经 `pushResult`「先问 chunks、有了就跳过」把缺的块用本机字节补推（不重渲），推齐后写清单、回 `true`；补推出错回 `false`，交给执行 → `put` 再推。原因：推到一半丢了认领、又被自己重新认领时，只看本机会以去重完成，而素材服务上缺块，别的成员按清单取不到，违反语义「节点先把产物推送到素材服务，再向文档服务报完成」（`product/document-service.md`）。块齐时只问不推，「已在素材服务里的直接完成、不重渲」不变。报告 `docs/reports/AGENT-sink-has.md`〕

## 没做成的与建议

- 开销：本机覆盖的段去重时，每块多一次到素材服务的问询（一段 60 帧两档约 120 次，并发 4）。PC 上预渲染进程自产的段较多，重连后重新发布的一版会多出这些问询；经公网时每段约几秒到十几秒。若嫌多，可以在 sink 里记「这一段已确认推齐」（按清单哈希，进程内），同一进程里第二次就不再问——这次没做，先保正确。
- 补推用的是 `pushResult` 的逐块 `GET chunks`；素材服务若将来有批量「这些哈希在不在」的接口，可以换成一次问询。
