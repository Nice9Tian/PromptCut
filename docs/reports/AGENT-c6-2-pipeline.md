# C6.2 预渲染管线侧实现报告(c6-2-pipeline)

- 分支:`claude/c6-2-pipeline`(从 `claude/c6-2` 的 71236d0 拉出)
- worktree:`.worktrees/c6-2-pipeline`
- 依据:`docs/plan/artifact-transfer-contract.md` 第 3～6 节、第 8 节,以及 `claude/c6-2` 后来补的第 11 节(a5f9075,主会话中途通知);`render-queue-contract.md` D.1、E.9;`cloud-task.md` A3b
- 端口段:5480～5489(本分支 dev server 5480,基线对照 5483,`ready-index-probe` 自带的 dev server 5486)

## 做了什么

只动了清单里的三个文件,没碰 `server/render-node/`、`local-node.mjs`、`server/test/`。

### `server/artifact-transfer.mjs`(新)

- `collectSnapshotResult(pipeline, task, opts?)` → `{ result, readBlob }`:读 `index.json` 的 `frames ∪ oversize`,逐帧读文件算 sha256,按帧升序列出本段已落盘的帧(超体积的也在内)。落盘位置:共享档 `dirKey = resultKey`;本地档按 E.9,`dirKey = resultKeyOf(去掉 "<entryKey>/" 的 input.contentKey, requires.envFingerprint)`,缺任何一项就抛(不猜)。`canvasHeavy` 依次取 `opts.canvasHeavy`、`task.input.canvasHeavy`(布尔时),缺省 `false`。
- `collectStreamResult(pipeline, task, opts?)` → `{ result, readBlob }`:读盘上的 `stream.json`,列本段已产出的分段和它们用到的 init;分段的 `encoder` 取所用 init 的 `encoder`。
- 两个 `collect*` 在清单 JSON 超过 256 KiB 时抛 `code: 'result-too-large'`,不截断。
- `pushResult(client, result, readBlob)`:按块去重,快照进 `snap`(ext `html`)、流进 `px`(init `mp4`、分段 `m4s`),并发 4 个。推之前再核一次 sha256,素材服务回的哈希和清单不同也抛。全部成功才返回 `{ result, uploaded, skipped }`。
- `createAssetSink({ pipeline, client })`:
  - `has(ref)`:只看本机帧库是否覆盖整个 `range`(快照看 `frames ∪ oversize`;流看每个分段和它的 init 是否都在清单里)。
  - `put(ref)`:先 `collect*`,清单齐了再 `pushResult`,成功回 `{ complete: true, result }`。缺帧、推失败、清单超限,一律回 `{ complete: false }`。本地档要靠 `ref.input` 和 `ref.requires` 定位,缺了 `has` 回 false、`put` 回 `{ complete: false }`。
- `applyResult(pipeline, client, result)` → `{ written, skipped, fetched }`:
  - 快照:本机 `index.json` 里已有的帧(`frames` 或 `oversize`)跳过;其余从 `snap` 拉,每 8 帧交给 `commitSnapshots({ tier, entryKey, key: dirKey, clipId: null, capabilities: { canvasHeavy }, items })` 落盘一次,最后调 `pipeline.adoptResult(result)`。某块 404 或内容不对时,已拉到的照常落盘并发布,再整体抛错。块解码成 UTF-8 后再编码回不到原字节的,也按错误处理。
  - 流:用 `pipeline.streamProducer()`,没有就抛 `code: 'no-stream-producer'`。先调 `producer.adoptionNeeds(result)` 只下载本机缺的块,再交给 `adoptSegments`;块缺了,对应的分段不收、其余照收,最后抛错。
  - 计数:`written` 是实际落盘的帧数或分段数,`skipped` 是本机已有而跳过的,`fetched` 是下载的块数(init 也算)。
- 不 import `server/asset-store/client.mjs`,也不 import `frame-stream.mjs`,client 从参数传进来。

### `server/frame-pipeline.mjs`(只加 `adoptResult`)

- `adoptResult(result)`:
  - 快照:用 `wireSnapshotKey(tier, entryKey, dirKey)` 算出键,读落盘后的 `index.json`,调 `this.ready.stageByKey({ kind, key, ranges: frames })`,再对 `this.entries` 里每个 entry 调 `claimSessions(entry)`。`claimSessions` 自己会判断有没有会话在这一版上。
  - 流:什么都不做,发布交给 `adoptSegments`。
- 起初加过一个 `streams()` 访问器;按第 11 节第 4 条已删掉,沿用 `streamProducer()`。

### `server/frame-stream.mjs`

- `StreamProducer.adoptSegments(result, blobs)`:同一个 producer 上串行执行。
  - 先按 `streamAdoption(result)` 校验清单。
  - 取这条流的 state;没有就按清单 `header`(或盘上已有的 `stream.json`)建一个最小的,spec 带 `streamKey / kind / plane / clipIds / topClipId / fps / bound / offset / firstSegment / lastSegment`,并标 `adoptedOnly: true`。
  - 挑出要写的分段:本机没有的,或 `segmentState` 判为 `stale` 的。核对 sha256 后经 `atomic` 写 `init-<sha16>.mp4`、`<n>-<sha16>.m4s`。
  - 写完**同步地**以当时 `this.streams` 里的 state 为准,合进它在内存里的 `manifest`。分段记 `adopted: true`、`sig`、`encoder`(取 init 的)。
  - 之后 `StreamStore.save`,再 `publish(state)`。被替换的旧分段文件照 `storeSegment` 的做法,5 秒后删除。
- `segmentState`:`seg.adopted === true` 而且 `manifest.streamKey === spec.streamKey` 时,不按本机编码器名重算签名,直接回 `sparse` 或 `dense`。
- `adoptedOnly` 用的几处小守卫:
  - `nextTask`、`needsSparseAnywhere` 跳过它:它没有隔离工程,不补产,也不挡稀疏阶段;
  - `claimLayers` 跳过它:它不属于任何一版;
  - `publish` 对它只 `stageByKey`、不发 `layer`,免得按 `this.entryKey` 串到别的版本;
  - `update()` 接手这个 state 时 `delete state.adoptedOnly`,之后照常补产、发层、认领。
- 从未调过新接口时,没有任何 state 带 `adoptedOnly` 或 `adopted`,上面每处判断都不生效,现有路径行为不变。现有测试 `frame-stream.test.mjs` 手工塞 state 调 `republish`、`claimLayers` 的用例照过。
- 新增导出 `streamAdoption(result)`(校验并整理 StreamResult)和 `adoptionNeeds(result)`(拉取前只读地问缺哪些块)。

## 验证

### 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node ../../node_modules/typescript/bin/tsc -b --force`(worktree 里没有 node_modules,等价于 `npx tsc -b --force`) | 退出码 0,零错误 |
| 全量测试 | `npm test` | 退出码 0:tests 2294,pass 2293,fail 0,skipped 1。跳过的是需要 5190 的「集成:/api/cards/layout 对真实项目返回整数框」 |

两项在第 11 节对齐前后各跑了一次,结果相同。

### G0-R

在最终代码(feb638d)上跑。worktree 的 dev server 改完代码后重启过:`node C:\Users\admin\Documents\PromptCut\node_modules\vite\bin\vite.js --port 5480 --strictPort --host 127.0.0.1`,舞台端口 5481、5482。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5480/?export=1"` | 退出码 0,1800/1800 相同 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5480 node scripts/verify-unified-frames.mjs` | 退出码 0,`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 就绪索引 | `node scripts/probes/ready-index-probe.mjs --port 5486` | 退出码 0,`"fails": []` |
| 轨道流生产 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5480` | 退出码 0,`"fails": []` |
| 同上,组流 | 同上加 `--group` | 退出码 0,`"fails": []` |
| 预览兜底 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5480` | 退出码 0,`"fails": []` |
| 同上,页面自触发 | 同上加 `--page-preload` | 退出码 0,`"fails": []` |
| 与 main 逐像素对比 | 见下 | 1800 帧,不同帧 0,不同像素 0 |

逐像素对比的做法:

1. `git worktree add --detach .worktrees/c6-2-baseline main`,当时 main 在 cc60741;
2. 在 5483 起 dev server,跑同样的 `verify-determinism`:1800/1800 相同;
3. 用 pngjs 逐帧逐像素比较两边的 `out/verify-a/frames`:帧数 1800,不同帧 0,不同像素 0。

收尾:

- 两个 dev server 都已停止,5480～5489 没有监听;
- baseline worktree 删除前用 `Get-ChildItem -Attributes ReparsePoint -Recurse` 查过,没有 junction(0 个),然后 `git worktree remove --force` 删除。

### 自测(假客户端,不提交)

- 脚本在 scratchpad,不入库:`c62-selftest.mjs`。
- 假客户端按契约第 2 节实现 `put / get / has`,内存 Map,会记请求次数。
- A、B 是两个临时帧库上的 `FramePipeline`:A 是 `interactive: false`,B 是 `interactive: true`,都带固定的 `environment`。
- 命令:`node <scratchpad>/c62-selftest.mjs C:/Users/admin/Documents/PromptCut/.worktrees/c6-2-pipeline`,退出码 0。

输出摘录:

```
S1 共享档:A 60 帧(含 1 帧超 300 KB) → sink.has=true, sink.put complete, 清单 60 帧, JSON 4823 字节, 推送 60 块
S1b 重推:uploaded=0 skipped=60
S2 B.applyResult: { written: 60, skipped: 0, fetched: 60 } get 次数 60
S2 controls-html/95d3bdd6… A 与 B 逐字节相同(61 个文件,含 index.json)
S2 B index.json = {"count":59,"frames":[[0,6],[8,59]],"oversize":[[7,7]]}
S2 就绪索引 staged: [{"kind":"html","key":"95d3…","ranges":[[0,6],[8,59]]}]  会话 s1 收到: {"type":"layer","clipId":"c1","kind":"html","key":"95d3…","ranges":[[0,6],[8,59]]}
S3 本地档 dirKey=resultKeyOf(去前缀内容键, fp) 与 E.9 一致;B 已有 10 帧 → applyResult { written: 20, skipped: 10, fetched: 20 } get 次数 20
S3 controls-local/eeeeee…/68881fb0… A 与 B 逐字节相同(31 个文件)
S4 sink:ref 带 input/requires 时本地档 has(0..29)=true、has(0..30)=false、put(0..30)={complete:false}、put(0..29) complete;只给 D.1 四字段时 has=false、put={complete:false}
S4b canvasHeavy:缺省 false;input.canvasHeavy=true → true;opts.canvasHeavy=false 优先
S5 404:applyResult 抛错;B index.json = {"count":15,"frames":[[0,11],[13,15]]} 文件 16 个(无 .tmp)
S6 清单 311162 字节 > 262144:pushResult 抛 result-too-large
S6b 3500 帧的段:collectSnapshotResult 抛 result-too-large,sink.put 回 {complete:false}
T5a interactive:false 的 A 收流清单:applyResult 抛 no-stream-producer;清单分段 encoder = init 的 libx264
T5 流:清单 1080 字节,inits 1,segments 3,px 里 4 块
T5 B.applyResult: { written: 3, skipped: 0, fetched: 4 } get 次数 4
T5 B 的 init 与分段文件与 A 相同: 0-097101112f636fd2.m4s, 1-57f484001178ee3a.m4s, 2-82e696e4016e8f65.m4s, init-f99b72449f7ef966.mp4, stream.json
T5 B 的编码器名换成 h264_nvenc 后 segmentState = dense/dense/dense (不判 stale)
T5 ready 挂上 stream: {"kind":"stream","key":"8a3b…","ranges":[[0,2]]}
T5b 再拉一次: { written: 0, skipped: 3, fetched: 0 } get 次数 0
T5c 活流、分段 1 判旧:applyResult { written: 3, skipped: 0, fetched: 4 } 会话 s2 收到 {"type":"layer","clipId":"k1","kind":"stream","key":"21e2…","ranges":[[0,2]]}
全部通过
```

T5 还断言了三件事:

- B 上这条流的 state 是 `adoptedOnly`;
- `state.manifest` 与 `producer.store.manifests.get(key)` 是同一个对象,说明合进了内存里的 state,并经 `save` 落盘;
- `nextTask(null)` 为 null,`claimLayers()` 为空,说明 `adoptedOnly` 的流本机不补产、不认领。

## 没做成的

无。

## 契约疑点与更正建议(已按最保守读法实现)

1. **第 5、6 节的 `pipeline.streams()`**:第 11 节第 4 条已改为 `streamProducer()`。建议正文第 5 节里的 `pipeline.streams().adoptSegments` 同步改掉。
2. **`adoptedOnly` 的流**:拉进来、但不在本机任何一版计划里的流,本实现只挂键,不发 `layer`。按 `this.entryKey` 发层会串到别的版本,违反 Item 4 的闸。它也不补产(没有隔离工程)、不认领。等本机 `update` 把这条流排进计划后,由 `update` 接手这个 state,再照常发层。第 11 节第 5 条说的「保证之后 publish 能成功」,我理解为 `publish` 不因缺字段而在 try 里静默失败,而不是必须发层。若主会话要它发层,需要先定下发给哪个 entry。
3. **「本机已有且不是 stale 就跳过」**:照字面实现。本机有稀疏分段、对方给的是满密度分段时,也跳过、不升级,本机之后会自己补满密度。要不要让满密度的拉取结果覆盖本机的稀疏分段,请主会话定。
4. **`canvasHeavy` 的来源**:按第 11 节第 2 条取 `opts`、`input`,缺省 false。若 M5b 没把它写进 `input`,而卡实际是 canvas 卡,B 会用 DOM 档 300 KB 的上限重新判超限,帧大小在 300 KB～1 MB 之间的会被 B 判超限。A、B 的 `index.json` 这时会不一致,只有缺省值这条路会出现。我早先的版本是按 A 的 `index.json` 反推 `canvasHeavy`,能保证判决一致;为对齐第 11 节已去掉。建议 M5b 务必写进 `input.canvasHeavy`。
5. **一段流的拉取部分失败时**:缺块的分段不收,其余照收,然后整体抛错,和快照 T8 的口径对齐(已拉到的照常落盘并发布)。契约第 5 节「流」这一支没有明写。
6. **`stream.json` 并发存盘**:生产者自己 `storeSegment` 与 `adoptSegments` 可能同时 `save` 同一个清单对象。每次 save 都序列化整个对象;两次 rename 如果交错,文件可能暂时少掉后一次合并的内容,下一次 save 会补上,内存里的清单始终是全的。现有的双 worker `storeSegment` 也有同样的窗口,本阶段不另加锁。
7. **与主会话来信第 8 条**:流这一支的 `skipped` 包括两类:`adoptionNeeds` 判定本机已有、不下载的分段;`adoptSegments` 在写盘期间发现本机刚产好的分段(极少见)。
8. **本分支没有合入 `claude/c6-2` 上后续的契约文档提交**(第 10、11 节)。合并时以 `claude/c6-2` 的契约为准。
