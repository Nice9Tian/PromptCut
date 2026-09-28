# AGENT-xnode-dedup

分支 `claude/xnode-dedup`（从 main `29e6e837` 拉）。任务：查清并修好「文档服务重启后，别的节点已经做完、产物已在素材服务里的任务，被另一个节点领到后整段重渲」。现象来自 M8 E3 放本机（M8 端到端用例 E3「文档服务重启」，放本机即 C4：探针强杀局域网主机编辑器再同端口起），run `m8e3lanM`，探针判据 `no-rerender-of-done`（重启前已完成的段重启后 0 次重渲）挂。

代号：**E3** = M8 端到端用例「文档服务重启」；**C4** = E3 放本机时的重启方式（结束局域网主机编辑器进程树、同端口再起）；**C2** = E3 放云端时的重启方式（托管组合 `pm2 restart`）；**c10a 第 9 节** = `docs/plan/c10a-contract.md` 的「预渲染小尺寸」（两档都推才算完成）；**〔裁〕** = 执行中按 `suggested_agent_behavior.md`「对齐」自行做的最小修改，待用户审。

## 状态

修完、验证完，待主会话审。

## 1. 观测（先加的诊断）

- `server/artifact-transfer.mjs` 的 `createAssetSink().has()` 回 `false` 前记一行 `sink.has-miss { resultKey(前 16 位), kind, range, reason, covered, … }`。`reason`：`no-content` / `no-key` / `manifest-get-failed`（带 `code`、`message`）/ `manifest-missing` / `manifest-mismatch`（带第一处对不上的 `field`）/ `manifest-incomplete`（带 `listed`）/ `blocks-missing`（带 `total`、`present`、`missing`、`errors`、`sample` 前两个缺块、`error` 第一处问不到的原因）/ `local-small-missing`（本机覆盖了原尺寸、缺小尺寸；修后另带 `manifest`：内容库那份为什么也不能用）。本机覆盖而补推出错的照旧记 `sink.has-push-failed`。
- 这行经预渲染进程的 `[queue-node]` 日志出来，但编辑器进程的转发器（`server/render-node/session-diag.mjs` 的 `TASK_LINE_RE`）原来只放行逐任务收尾行与 `sink.incomplete`，第一轮复现时编辑器日志里一行都看不到。扩了白名单：`sink.has-miss`、`sink.has-pushed`、`sink.has-push-failed`、`manifest.get-failed`、`manifest.put-failed`。独立渲染主机的日志（`scripts/render-host.mjs`）同一个转发器，也看得到。
- 只加日志，不改行为（诊断那两个提交 `9f7d7246`、`1ddf02c4` 上跑的 `run2` 行为与 main 相同）。

## 2. 复现

### 2.1 本机替身探针（修前）

`node scripts/probes/m8-e-probe.mjs --role all --case e3 --place lan --keep --keep-temp --run xdA1 --out <scratchpad>/run1`（端口 5740～5749），2026-09-28T15:19Z～15:33Z，退出码 1：

```
creator:no-rerender-of-done  ok:false  {"doneBeforeRestart":5,"rerendered":[{"h":"pc","id":"snapshot:844724ed…:0-59"}]}
```

与 `m8e3lanM` 同形：host-a 在 15:20:41 做完 `844724ed…:0-59`（推送 `blocks 120`），重启后 PC 领到，`node.task-completed … done 60 … push {"blocks":180,"pushed":180}`。

第二轮 `xdA2`（已带转发的诊断）过了（`rerendered []`）：重启后 PC 先领到的是 PC 自己做过的段（去重）和没做完的段，host-a 做完的段又被 host-a 自己领走——**取决于重启后谁领到哪一段**，印证任务书的猜测。

### 2.2 看盘定位（run1 保留的帧库）

PC 帧库 `controls-html/844724ed…/`：

| 文件 | 修改时刻（UTC） | 说明 |
|---|---|---|
| `0.html`、`0.small.webp` | 15:19:37 / 15:19:39 | PC 自己渲的锚帧 |
| `30.html`、`59.html` | 15:20:41.88 / 15:20:42.25 | host-a 15:20:41.48 报完成后，PC 收 `task.done` 按清单拉来 |
| `59.small.webp` | 15:21:31 | 重启后 PC 领到这一段时补画的小尺寸 |
| `60.html`～`299.html` 有，`100.small.webp` 等没有 | — | host-a 做的段只有原尺寸 |

结论：PC **没有重渲原尺寸**（`59.html` 没被改写），它做的是「从本机原尺寸补画整段小尺寸（59 张），再推 180 块」，然后以「完成」而非「去重」收尾，探针按「PC 完成」记成重渲。任务书写的「整段重渲」按此更正为「整段补画小尺寸 + 推送」；对判据来说二者一样都不是去重。

### 2.3 根因

两处合起来：

1. **独立渲染主机不产预渲染小尺寸。** 小尺寸只在 `FramePipeline.smallTierEnabled()`（= 配了推送队列）时生成；主机没有推送队列（`startArtifactPush` 对 `host-profile` 直接跳过，产物由 sink 推），所以主机的清单只有原尺寸与 PNG（120 块），sink 的完成条件也不要求小尺寸。这与二级语义冲突：`product/rendering.md`「两档」「渲染节点产出原尺寸后一并生成小尺寸，两档都推送到素材服务」，c10a 第 9 节「由渲染节点（桌面版的队列节点、独立渲染主机……）在产出预渲染原尺寸时一并生成」「任务完成的条件：两档都推送成功」。
2. **PC 的 `has()` 在「本机覆盖原尺寸、缺小尺寸」时直接回 `false`，不查内容库。** PC 收 `task.done` 用 `applyResult` 拉别人的段——只拉原尺寸和 PNG、不拉小尺寸——于是别人做完的每一段在 PC 本机都成了「覆盖了、缺小尺寸」。原来的注释说这时不查内容库，是怕认了本机推送队列边渲边写、缺小尺寸的清单。所以即便产出方两档齐，PC 领到也不会去重，而是补画小尺寸重推（还会以本机补画的小位图覆盖内容库里的清单）。

诊断的原因在单测里复现为：`sink.has-miss {"reason":"local-small-missing","covered":true}`（X1 修前输出，见 4.1）。

## 3. 修法

- `server/frame-pipeline.mjs`：加 `enableSmallTier()`；`smallTierEnabled()` 改为「有推送队列**或**被打开」且 `PROMPTCUT_SMALL_TIER` 不是 0；`commitSnapshots` 的钩子在没有推送队列、但开了小尺寸时照样 `scheduleSmallSnapshots`（不进推送队列）。有推送队列的 PC 行为不变。
- `server/vite-plugin-frames.ts` 的 `startHostNode`：起节点前 `service.enableSmallTier()`。主机从此产两档、按两档推（`scheduleMissingSmall` / `flushPendingSmall` 与 PC 同一套），sink 的完成条件照样要两档。
- `server/artifact-transfer.mjs` 的 `has()`：本机覆盖、缺小尺寸时查内容库，**只认两档都齐**、块都在素材服务上的清单（回 `true`，`resultFor` 回那份清单）；清单缺小尺寸（本机推送队列边渲边写的那种）才回 `false`，交给执行器补画——原来防的那种情况照旧防住。内容库查询抽成 `lookup()`，本机没有这一段时的判据（不要求小尺寸）不变。
- 契约 `docs/plan/artifact-transfer-contract.md` 第 4 节 `has` 加〔2026-09-29 `claude/xnode-dedup` 裁〕，写明上面两条与原因。

没改的：`applyResult` 仍不拉小尺寸（PC 桌面预览只用原尺寸，按清单去重不需要本机有小尺寸）；本机没有这一段、清单缺小尺寸时照旧去重（不然 PC 要整段重渲原尺寸才能补小尺寸，更糟）。

## 4. 验证

### 4.1 单测 `server/test/xnode-dedup.test.mjs`（新增）

X1～X4 用帧库替身、素材服务与内容库替身；X5 用真的 `FramePipeline`；X6 是整条链：真 `FramePipeline` ×2、真素材服务（`fake-asset-service` 起的 HTTP 服务）+ 真 `createAssetClient`、真内容库（文档服务内容模块 + WS 客户端）、真队列 `createRenderQueue` + 真 `createLocalNode`：host 两档做完推上去 → PC `applyResult` 拉原尺寸 → 新 epoch 的队列（文档服务重启、队列清空）重新发布同一段、只有 PC 的节点在 → 应以去重完成、执行器 0 次。

修前（测试提交 `163418c0`、实现停在 `1ddf02c4`）`node --experimental-test-module-mocks --test server/test/xnode-dedup.test.mjs`：pass 1 / fail 4（X6 另跑也挂）：

```
✖ X1 … AssertionError: 应走去重:[{"resultKey":"a6849768a3cc88bc","kind":"snapshot","range":{…"from":0,"to":7},"reason":"local-small-missing","covered":true}]  actual: false  expected: true
✖ X2 … 写明内容库里那份清单为什么也不能用  actual: undefined  expected: 'no-small'
✖ X3 … actual: 'local-small-missing'  expected: 'blocks-missing'
✖ X5 …（没有 enableSmallTier）
✖ X6 … 收到 task.done:["publisher.welcome","task.published","task.failed"];节点事件:[{"type":"failed",…"error":"sink-incomplete",…"why":"small-missing"…
```

修后（`a5e12bd4`）同一组加相关旧测试（`sink-has`、`artifact-dedup`、`small-tier`、`c10a-small-prerender`、`artifact-transfer`、`stall-phases-diag`）：tests 50 / pass 50 / fail 0。

### 4.2 探针 `m8-e-probe --role all --case e3`（本机替身，5740～5749）

| run | 代码 | place | 退出码 | `no-rerender-of-done` | 说明 |
|---|---|---|---|---|---|
| `xdA1` | 诊断（未转发） | lan | 1 | **挂** `rerendered [pc 844724ed…:0-59]` | 修前复现 |
| `xdA2` | 诊断（已转发） | lan | 0 | 过 `rerendered []` | 修前；这一轮 PC 没领到 host 做完的段 |
| `xdL3` | 修后 `a5e12bd4` | lan | 0 | 过 `doneBeforeRestart 5, rerendered []` | 见下 |
| `xdC1` | 修后 | cloud | 待填 | 待填 | |

`xdL3` 说明修复的路径真被走到了：host-a 重启前完成 `13150623…:0-59`、`a087f3ca…:0-59`、`7a657a52…:0-59`（主机推送 `blocks 180`，修前是 120——主机现在产小尺寸）；重启后 PC 在 15:56:11～15:56:15 连续 `node.task-dedup` 5 段，其中就有这三段（修前这就是 `xdA1` 那种补画重推）。其余检查全过：J-全完 30/30、J-恰一（按 epoch）、J-纯层 6 层、`reconnected-host-a`、`endpoint-reannounced-host-a`。主机每段用时 30～38 s（修前 `xdA1` 约 35 s），多出的小尺寸没有明显拖慢。

### 4.3 G0 与 G0-R

（待填）

## 5. 偏离与待定

- **任务书现象的更正**：不是「整段重渲」，是「整段补画小尺寸 + 推送」（2.2 节）。对判据一样挂。
- **二级语义冲突（已按语义改代码，未改语义）**：独立渲染主机不产预渲染小尺寸，与 `product/rendering.md`「两档」、c10a 第 9 节冲突；按原则 2 改了代码。影响：主机多一步截小位图、多推一档（每段多 60 块、约 0.3 MB），用时见 4.2。请主会话确认接受。
- **〔裁〕**：`artifact-transfer-contract.md` 第 4 节 `has` 的补充（3 节末条）。属三级（机制），用户看不出区别；待主会话 / 用户审。
- **探针判据的口径**：`no-rerender-of-done` 把 PC 重启后「完成」的已完成段都算重渲；修后不会再有「只补小尺寸」的完成，但若产出方是修前版本的主机（只有原尺寸），PC 领到仍会补画小尺寸、判据仍挂。跨版本混跑时请注意。
- **跨机没跑**：只跑了本机替身（lan、cloud 各一次），真跨机（笔记本 + PC）与阿里云 C2 没跑（任务书不要求，也不许连阿里云）。
- 探针 `--keep` 跑的两轮（`xdA1`、`xdA2`）在 worktree 的 `out/docservice` 里留了两个项目（`m8e-e3-xdA1`、`m8e-e3-xdA2`），不入库；删 worktree 时一起没。
