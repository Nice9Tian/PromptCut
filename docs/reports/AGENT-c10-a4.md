# AGENT 报告：claude/c10-a4

分支 `claude/c10-a4`，工作区 `.worktrees/c10-a4`，从 `origin/claude/c10-browser` 的 `9ad7429` 拉出。端口段 5430～5439。

任务：查清并修好 C10-A4（契约 `docs/plan/c10-contract.md` 第 20 节验收第 4 条：换帧预算装不下的层显示占位；暂停后追到精确活渲；占位撤下后不再盖回）的后半条——在线普通档暂停后在后台舞台追到精确活渲、再与可见舞台互换，没有发生。

状态：**根因查到并修好，A4 连过两轮，G0 与三项 G0-R 过**（等主会话审）。

代号：K5 第二路 = 暂停态里「判重且 `vtOk = false` 的卡」由后台舞台整场景补跑到当前时刻、再与可见舞台互换（`src/editor/stageSwap.ts` 的 `runSettleSwap`）；K3(b) 播放态互换 = 播放中一张 (b) 档、`vtOk = false` 的轻卡由后台舞台整场景补跑后互换（`runPlayingSwap`）；R5-15 = 「第二路跑着时又来的 settle 只记最后一个、做完再补」那条既有规矩。G0 = 类型检查 + 全量测试；G0-R = 改了预览与导出路径时加跑的回归（`verification.md`）。

## 提交

| 提交 | 内容 |
|---|---|
| `5fc7e14` | 建报告 |
| `b98a5f9` | 诊断：`stageSwap.ts` 记 `swapTrace`（`runSettleSwap` 进门与出门原因、`staleOnBackCatchUp` 按卡的判据、补跑排队 / 开始 / 渲完、播放态互换的起止与 `pendingSettleT`），`__pcPreviewDiag` 带出；探针加 `--only-a4`，输出带 `settleTrace` |
| `aa7b86e` | 单测（修前失败）：播放态互换跑着时来的暂停态 settle 不丢；收手时又在播放就不补 |
| `24c62ea` | 修：`runPlayingSwap` 收手时把跑着时记下的 `pendingSettleT` 交给 `runSettleSwap` |

## 根因（证据：修前 run1 的 `settleTrace`）

复现：`node scripts/probes/c10-browser-probe.mjs --base-port 5430 --only-a4`（修前，`b98a5f9`）。A4 后半条照旧不过，3 秒后主重卡仍挂快照平面。`swapTrace`（毫秒是页面的 `performance.now`）：

```
4195   settle t=0     stale=10            ← 起播前那次暂停态互换,照常做完(swapLog: ready, swapped)
10207  playing t=1    ids=[轻卡 probe-typewriter]   ← K3(b):播放头进入 (b) 档 vtOk=false 的轻卡,发起播放态互换
10211  catchup-start  t=1.033
19209  settle t=10    out=running runningKind=playing   ← 播放到头
20091  settle t=0.5   out=running runningKind=playing   ← 探针点到 0.5 秒
21305  catchup-rendered t=1.033                          ← 整场景补跑到 1.03 秒用了 11 秒(9 张 40 ms/帧的重卡一起推)
21606  playing-end    pendingSettleT=0.5                 ← 播放态这一路收手,0.5 那次没人做
```

此后 `swapInFlight: false`、`swapLog` 只有 t=0 那一条、`settledAll: false`，前台舞台 B 挂着 10 张快照、没有补跑任务。

即：播放中那张轻卡（`probe-typewriter`，记录 `vtOk: false`、`catchup-b` 档）发起了播放态互换，它占着 `running`；播放到头与点到 0.5 秒两次 `runSettleSwap` 都撞上 `running`，只把 t 记进 `pendingSettleT` 就返回。R5-15 只在 `runSettleSwap` 自己的循环里消费 `pendingSettleT`，`runPlayingSwap` 收手时既不做也不交出去，于是停下那一次的第二路永远没发生，直到下一次跳转或播放。

对照怀疑点：`pipelineAt` 判重正常（10 张都 `heavy`）；`recordOf` 按 identityKey 找 L2 来的记录正常（`costs: 4`、t=0 那次 `stale=10`）；在线分派的 `deadMs` 与此无关；是 `running` 标志——但不是卡死，而是被播放态互换占着、且那一路丢了排队的 settle。桌面 G0-R 的 preview-fallback-probe 不经过「播放态互换跑着时停下」这个时序，所以一直过。

## 修法

`src/editor/stageSwap.ts` 的 `runPlayingSwap` 的 `finally`：放掉 `running` 之后，取出 `pendingSettleT` 并清空；有值且此刻没在播放，就 `void runSettleSwap(那个 t)`。又在播放了就不补（下一次停下自己会来）。`resetStageSwap` 顺带清 `pendingSettleT` 与诊断标志（测试隔离）。

对桌面的影响：这是桌面与在线共用的代码。桌面行为只在同一个时序下变化——以前停下那一次被吞掉、重层停在快照上（同样违背「停下就精确」），现在照常补跑互换；其它路径一字未动。三项 G0-R 结果不变。请主会话确认这算「修桌面的同一个缺陷」而不是「改变桌面行为」。

## 单测

`src/editor/stageSwap.test.mjs` 新增两条：

- 「播放态互换跑着时停下:停下那一次的暂停态第二路不丢,播放态收手后接着做(C10-A4)」——修前失败（`AssertionError: 收手之后按最后一次停下的 0.5 秒补跑`，`aa7b86e` 上跑的），修后过；
- 「播放态互换跑着时来的 settle,收手时又在播放了就不补」。

`stageSwap.test.mjs` 19/19、`stageSwapBaseline.test.mjs` 4/4、`c10a-swap-gate.test.mjs` 2/2。

## 验证（PC）

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3437、pass 3435、fail 0、skipped 2（比 c10-browser 收口时多 2 条，就是新加的两条）。
- `c10-browser-probe --base-port 5430 --only-a4`，修后连跑两轮都 `ok: true`、`fails: []`：

| 轮 | 暂停后追到精确活渲 | 3 秒后仍是活渲 | 关键时序 |
|---|---|---|---|
| run2 | 过 | 过 | 点 0.5 秒 20520 → 播放态收手 22080 → 暂停态补跑 0.5（stale 10）→ 渲完 28276 |
| run3 | 过 | 过 | 点 0.5 秒 20490 → 收手 21993 → 补跑 0.5（stale 10）→ 渲完 28192 |

  两轮其余各条也过（播放 10 秒主文档长任务 0、主重卡快照换了 57 帧、按拍投递 242 / 270 次、0.1 秒处 `fit` 7、`deadMs` 23.33、两层显示占位）。看过 run2 的 `a4-settled-live.png`：播放头 0.50、暂停，重层都是活渲的卡面，没有占位、没有沙漏。
- G0-R（dev server 用本分支、`npx vite --port 5436 --strictPort --host 127.0.0.1`，舞台 5437 / 5438 带 OAC 头）：
  - `preview-fallback-probe --origin http://127.0.0.1:5436`：PASS，beats 287、transparentBeats 0、fails []；
  - 同上加 `--page-preload`：PASS，beats 291、transparentBeats 0、fails []；
  - `verify-determinism --url "http://127.0.0.1:5436/?export=1"`：1800 帧，identical 1800、different 0。
- 没跑的：stream-produce-probe、ready-index-probe、verify-unified-frames、与基准帧逐像素比对（任务书没点名；改动只在父页的暂停态第二路调度，不碰导出与预渲染）。带耗时门槛的项一律没在 PC 上判。
- 收尾：自己起的 dev server（PID 24536）已结束，5430～5439 无监听（netstat 核过）；探针每轮都删了自己建的云端项目（`shared.admin.ok`）。

## 没做成的与观察

1. **停下到精确的延迟仍有 7～8 秒**（点下 0.5 秒到补跑渲完）。其中约 1.5 秒是等播放态那次补跑收手，约 6 秒是补跑本身：整场景从 0 推到 0.5 秒，9 张 40 ms/帧的探针重卡一起推。探针判据是 120 秒内，所以过了；但 `mechanism/rendering.md` 低内存档的「停下追一帧」有 5 秒时限，普通档没有时限。要不要给普通档的第二路也设时限、或让暂停态 settle 抢断正在跑的播放态补跑（现在是等它自己收手），属于新的机制决定，没做，留给主会话。
2. **播放态互换在这个项目里注定追不上**：播放头进入 (b) 档轻卡时，整场景补跑要把判重的慢卡一起推，花了 11 秒，可见舞台早已走过目标拍。目标拍是按那张轻卡自己的 `catchUpMs` 估的（`guessCatchUpMs`），没算同场判重卡的推帧成本。这不影响 A4，但会在播放中白占后台舞台十几秒（测量、认领都得让路）。建议主会话另立一条看是否要把同场重卡的推帧成本计入估时，或在补跑明显追不上时提早放弃。
3. 诊断 `swapTrace` 留在代码里（只记内存环形数组，最多 40 条），集成时要去掉只需撤 `b98a5f9` 里 `stageSwap.ts` 的 `trace(...)` 与 `Preview.tsx` 的一行。

## 对任务书或语义的更正建议

- `AGENT-c10-browser.md`「没做完的」第 1 条列的怀疑点（`pipelineAt` 判重、`recordOf`、在线 `deadMs`）都不是根因；根因是 `running` 被播放态互换占着、且排队的 settle 被丢。语义不用改。
