# AGENT-push-incomplete

分支 `claude/push-incomplete`，起点 main `6f0ad9e9`（0.7.12 之后）。

任务：查明并修好渲染节点推预渲染产物时偶发的 `素材服务 POST px/<hash>/complete 回 400：incomplete`（节点这次认领判 `sink-incomplete`、白费一遍渲染，重领后才判重通过）。

## 结论

根因在素材服务的数据层（`server/asset-store/fs-store.mjs`、`memory-store.mjs`），不在推送端：**同一份内容被两路同时推时，后到的一路会把先到的一路已经答过「收到」的分片标记撤掉**，先到的一路紧接着 `complete`，就回 400 `incomplete`。等后到那一路写完，标记又补上了——这就是「重领后判重通过、那一块后来到了」。

现场的两路是：渲染节点的产物库（`artifact-transfer.mjs` 的 `createAssetSink().put`）和本机的无条件推送队列（`artifact-push.mjs`）。节点渲完一段、帧落进本机帧库，推送队列马上把这一段排进去在后台推；同时节点自己的 `put` 也在推同一段的 180 块。两边都是 `pushResult`（每路 4 并发）→ `client.put`（问 `chunks` → PUT 缺的片 → POST `complete`）。大多数块一路先收尾、另一路问 `chunks` 时已 `complete` 就跳过；撞在同一时刻的那一两块就出事。

## 尺子

`scripts/probes/push-race-probe.mjs`（新建）：本进程里起一个真的素材服务（`asset-service.ts` 中间件 + 真的数据层），两个真的客户端照现场的形状（每轮 180 块各 20 KB 的随机内容、每路 4 并发、同一顺序）同时推，数失败。

```
node scripts/probes/push-race-probe.mjs --store <flat|shard|memory> --rounds 30
```

`shard` 是托管组合（M7 探针里的素材服务就是它）用的分目录布局，`flat` 是本机编辑器的布局。每遍 30 轮 = 60 次推送（每次 180 块）：

| 数据层 | 改前：失败的推送 / 400 incomplete 次数 | 改后 |
|---|---|---|
| fs `shard` | 38 / 109（另一遍 15/20、55 次） | 0 / 0 |
| fs `flat` | 5 / 5（另一遍 2/20、2 次） | 0 / 0 |
| memory | 0 / 0（时序上撞不上，但逻辑有同样的洞，单测能摆出来） | 0 / 0 |

只改客户端、服务端仍是旧代码时（把 main 的数据层拷到临时目录跑同一探针，跑完已删）：旧客户端 37/60 失败、117 次；新客户端 0/60。

另有确定性的单测 `server/test/blob-store-concurrent-push.test.mjs`（新建）：用可控的 source 把交错摆出来，三种数据层各三条，**改前 9/9 失败，改后 9/9 通过**。

## 根因（证据）

1. 日志：所有 `sink.incomplete` 都是 `push-failed:400`、`px/…/complete 回 400：incomplete`，`blocks: 180, pushed: 179`（一次 178）；px 块 ~20 KB，单片。`m7race/run0-before` 的编辑器日志里，节点队列（`for: "queue"`）与推送队列（`for: "push"`）连的是同一个素材服务 `http://127.0.0.1:6300/media/api/asset`。推送端单路是逐片 `await` 之后才 `complete`，单路里不可能缺片，所以必须有第二个写者。
2. 代码（改前）`fs-store.mjs` 的 `putChunk` 登记段：
   ```js
   await fs.rm(path.join(d, `${n}.ok`), { force: true });   // 写之前先撤这一片的标记
   ```
   而补标记 `fs.writeFile(<n>.ok)` 在锁外。于是有两种交错：
   - **A 已收到、B 重传**：A 写完第 0 片、补上 `0.ok`、回 200；B 进登记段删掉 `0.ok` 开始重写；A 的 `complete` 看到缺第 0 片 → 400 incomplete。
   - **判与删之间被插入**（只修上一条之后 shard 仍有 37 次，靠它定位）：B 在锁里先看「没有 `0.ok`」，A 恰在此时（锁外）补上 `0.ok`，B 接着删掉了它。
   memory 实现同理（`st.received.delete(n)`）。
3. 另一个附带问题：A 先收尾入库、暂存目录被删，B 写完补标记失败 → 回 409 `staging-discarded`，而这时内容其实已经入库了。客户端 4xx 不重试，会白白失败一次。

## 修法

服务端数据层（根因）：
- 已收到的片再传：不重写、不撤标记，只把请求体读完核对长度；长度对回 `ok`，长度不对才撤标记回 `length`（与原契约用例 K4「已收到的一片重传时长度不对，变回没收到」一致）；读的途中断流照原样抛、标记保留（存着的字节没被碰过）。
- 登记时判过「没有标记」之后不再删标记；只在从没登记过（没有 `meta.json`）时删一次，清来历不明的残留。
- 写完补标记时发现暂存已被另一路收尾入库：回 `complete`（HTTP 层回 200 `complete: true`），不回 `discarded`。

客户端兜底（`client.mjs`）：`complete` 回 400 `incomplete` 时等 100 ms / 200 ms 重问 `chunks`，已 `complete` 就算成，否则补传缺的片再收尾，至多补 2 轮。为的是线上已部署的老素材服务还有这个洞，新节点连上去也不白费一遍渲染。

素材服务的对外协议（分片 PUT、`chunks`、`complete` 的形状与状态码）没改。

## 改了哪些文件

- `server/asset-store/fs-store.mjs`、`server/asset-store/memory-store.mjs`：上面三条。
- `server/asset-store/blob-store.mjs`：接口说明里的规则改写；新增 `countSource`（读完计字节，出错照抛）。
- `server/asset-store/client.mjs`：`complete` 回 incomplete 后的补传（`completeWithResync`，导出 `INCOMPLETE_RESYNC_ROUNDS = 2`）。
- `server/test/blob-store-concurrent-push.test.mjs`（新）、`server/test/asset-client-resync.test.mjs`（新）。
- `scripts/probes/push-race-probe.mjs`（新，尺子）。
- `docs/semantics/mechanism/asset-service.md`：「上传」一节加一句，标〔裁〕。

## 验证

按 `verification.md`「子分支与集成分支各跑什么」，子分支跑类型检查、全量测试与点名的探针；没动渲染代码，不跑 G0-R。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出 0，零错误 |
| 全量测试 | `npm test` | 退出 0；tests 4243、pass 4241、fail 0、skipped 2 |
| 相关单测（改后） | `node --test` 跑 blob-store-concurrent-push、blob-store-conformance、asset-store-http、asset-service、asset-client、asset-namespaces、asset-client-resync | 90 条全过（新单测改前 9/9 失败） |
| 尺子 | `push-race-probe.mjs --store shard/flat/memory --rounds 30` | 改前 shard 38/60 次推送失败（109 次 incomplete）、flat 5/60（5 次）；改后三种都是 0/60、0 次 |
| 在线构建 | `npx vite build --mode online --outDir out/dist-online --emptyOutDir` | 退出 0 |
| M7 | `m7-browser-probe --role all --timing-authoritative --base-port 6400 --dist out/dist-online` | 退出 3，`fails: []`，pending 只有「W7 真跨机待复核」（本机替身的常态）；用时 1105 s |
| M7 编辑器日志 | 在 `editor-6403.log` 里数 | `incomplete` 0 次、`sink-incomplete` 0、`sink.incomplete` 0、`sink.has-push-failed` 0、`staging-discarded` 0；`node.task-completed` 21。改前旧日志每遍 1～4 次 `sink.incomplete`（m7race run0 2 行、cadence-race 4 行、codex-test-env 6 行、r12-merge 8 行，每次失败两行）。这遍里的 21 次 `node.task-failed` 全是开头「文档服务上没有项目快照 …@1/2/3」，旧日志里同样有，与本缺陷无关 |
| 共享导入上传 | `shared-import-upload-probe.mjs --doc-port 6420 --asset-port 6421 --port-a 6410 --port-b 6415` | 退出 0，`fails: []` |
| 桌面自动节点 | `desktop-auto-node-probe.mjs --base-port 6430`（本机模式） | 退出 0，`fails: []` |

只跑了一遍 M7：改前每遍都有 1～4 次，这遍 0 次能对上，但一遍不算统计意义上的证明；可靠的对照是上面的尺子。

## 语义改动与〔裁〕

`docs/semantics/mechanism/asset-service.md`「上传」加一句（三级）：

> **几路同时推同一份内容**：素材服务已答过「收到」的分片，不因另一路重传同一片而撤销；推送方收尾时得到「没收全」，先重新对账、补传缺的片再收尾，补两轮仍不齐才算失败。〔裁：2026-10-01 `claude/push-incomplete`〕

这不是「按现有语义做不下去」的那种〔裁〕：原语义没写这件事，这里只是把新机制补进三级。

## 对任务书 / 其它文档的更正建议（交主会话）

- `docs/plan/asset-store-contract.md` 第 87 行「一片算不算收到：先撤掉这一片的『收到』标记，写完、长度核对无误再补上标记」已不准确——就是它导致了这个缺陷。建议改成：「没收到的片写完、长度核对无误才补标记；已收到的片再传不重写、不撤标记，只核对长度，长度不对才撤」，并补一句「写完时暂存已被收尾入库回 `complete`」。该文件不在本分支可改清单里，没动。
- 两路推同一段本身是重复劳动（每段的块都问两遍 `chunks`）。不影响正确性，修完后也不再失败；要省掉，可以让推送队列跳过节点队列正在推的段，但那是 `artifact-push.mjs` 与节点之间的协调，超出这次范围。

## 主会话审查（2026-10-01，笔记本主会话）

- 根因坐实：节点自己的推送与本机后台推送队列同时推同一段，存储层再传已收到的片时先撤「收到」标记再重写（两个窗口：已答 200 的片被撤；登记判过「没有标记」后误删对方刚补的标记），另一路收尾即 `incomplete`；另一路先收尾入库时这边白收 409。审过 `fs-store`、`memory-store`、`blob-store` 的改法：标记只在写完并核对长度后才打、全件收尾时仍按 sha256 校验，所以「已收到的片不重写」不会放进坏字节；长度不对才撤标记，契约用例 K4 照过。客户端兜底（complete 回 incomplete 时重问 `chunks`、补传、至多 2 轮）对还没升级的托管端同样有效：老服务端代码下老客户端 60 次推送挂 37 次、新客户端 0 次。
- 尺子：`scripts/probes/push-race-probe.mjs`（进程内真素材服务、两路真客户端同推 180 块）分片布局改前 60 次挂 38 次、incomplete 109 次，改后 0；强制交错的单测改前 9/9 挂、改后 9/9 过；M7 一遍编辑器日志里 incomplete 0 次（旧日志每遍 1～4 次）。复现探针分片、平铺两种布局已纳入集成分支 `claude/r13-merge` 的整套。
- 采纳三级〔裁〕（`mechanism/asset-service.md`「上传」一句）；契约 `asset-store-contract.md`「一片算不算收到」由主会话照改（原文正是病根）。素材服务对外协议（形状、状态码）不变。托管端的存储层随 0.7.13 重部署。
- 两路仍各推一遍每一段（重复劳动、不再出错），记 TODO 未排期。合入 main `83c6d74f`。
