# AGENT-maint-3

分支 `claude/maint-3`（起点 `claude/r7-merge` 的 `e4f6e8df`），worktree `.worktrees/maint-3`。一批维护项，来自 `docs/plan/TODO.md` 与最近几份归档报告：

1. legacy 整帧通道的方案 B（「legacy 整帧通道」指整帧预览那条老路及其四块存储，方案 B 是 `AGENT-query-render-2.md` 第 8 节 dry run 里「只删没人用的产物」那一档）；
2. 时间轴档测响度的逐秒曲线偶发缺点；
3. 配音复刻的源文件经素材服务取字节；
4. 队列模式认领闸的端到端探针（「认领闸」指本机渲染节点在 Agent 专用实例开着且空闲时多认领一项快照任务的那道判断，`server/queue-agent-spare.mjs`）；
5. （主会话追加）第 4 项探针量到 Agent 查询要等 38 秒：专用实例上的队列任务改成按批（4 帧）给 Agent 让路。

## 状态

五项做完。前四项主会话审过、〔裁 1～3〕认可。第 5 项（按批让路）做完后，重活在机器空闲时全部重跑：

- 类型检查 0 错误。
- 全量测试 4153 条，0 失败、跳过 2。第一遍有 1 条与本改动无关的环回连接超时，单跑该文件 6/6 过，整套重跑 0 失败；两遍都如实记在「验证」。
- 代码指纹不变。
- G0-R（第 1 项改到预渲染要跑的一组渲染验收）功能判定全过，耗时门槛也过（流式生产 p50 263 ms，门槛 300 ms）。
- 认领闸探针全过。**Agent 查询的等待从 38.3 s 降到 1.2 s，整次请求从 40.6 s 降到 6.1 s。**

用户看不出区别的：第 1 项删的两个文件从来没人读，`/status` 回包形状不变。用户看得出区别的只有第 5 项：后台预渲染进行中，Agent 看画面变快了。这是主会话要求修掉的退步。

## 提交

| 提交 | 内容 |
|---|---|
| `3bb8c2f6` | 文档：建本报告 |
| `191089d3` | 修复：legacy 整帧通道方案 B——不再产 `preview.mp4` 与整场景 `full.mov`（单测 MNT3-B-1～6） |
| `9b593817` | 修复：时间轴档测响度在混音之后按样本序号重打时间戳（单测 MNT3-L-1～2） |
| `4999fa65` | 测试：CM-3 的混音图比对认多出的 `asetpts` |
| `2ec60323` | 修复：配音复刻的源文件经素材服务取字节（单测 MNT3-V-1～3） |
| `a7cea78a` | 探针：认领闸端到端探针 `claim-gate-probe`（判定单测 MNT3-C-1～3） |
| `8c826de5` | 文档：报告写到轻量部分做完 |
| `3b36d480` | 文档：补重活的验证结果 |
| `1322aabc` | 修复：Agent 专用实例做队列细任务时按批（4 帧）给 Agent 让路（单测 MNT3-Y-1～6；探针加等待判定，MNT3-C-4） |
| `ebb2dc52` | 修复：批边界让路时等 1 秒宽限期，前后脚的 Agent 任务同一次让路里做完（单测 MNT3-Y-7） |
| （本次） | 文档：补第 5 项与重跑的验证 |

用例编号前缀 `MNT3-` 是本任务新起的（B = 方案 B，L = 响度，V = 配音复刻，C = 认领闸，Y = 让路），仓库里原来没有。

## 1. legacy 整帧通道方案 B

### 先核消费方（全仓 grep，含探针、脚本、页面、Agent 工具、桌面壳）

- **`prerender()` 产的 `preview.mp4`**（`tracks/<前缀>/preview.mp4` 与 `<键>/preview.mp4`）：`src/`、`desktop/`、Agent 工具里出现的 `preview.mp4` 都是导出成片的同名文件（`export-*`、`exports-list`、`storage-leftovers` 的 `EXPORT_DELIVERABLES`）。唯一读帧库这份的是 `scripts/verify-unified-frames.mjs`：用 ffprobe 数它有 10 帧。已改（见下）。
- **整场景 `mov/full.mov`**：只有 `vite-plugin-frames.ts` 的 `/status`、`/see` 判它在不在、拼出 `mov` 字段；页面 `src/render/frameClient.ts` 只把字段改写成绝对地址，之后没人读 `result.mov` / `result.video`。探针里没有读这两个字段的。推送素材服务（`artifact-*`）不推整场景的 `full.mov`。
- **没动的**：独立卡那一份 `controls/<键>/mov/full.mov`（`card-cache.mjs`，缺省 `movie: true`）照旧编。任务书只点名 `fillMov` 那一份；而且 `png-adopt-probe` 把卡片那份 `full.mov` 在不在当作「这台跑没跑过 PNG 那一支」的信号，要删得另议（见「更正建议」）。

### 改了什么

- `server/frame-mov.mjs`：`MovFrameStore` 多一个选项 `movie`（缺省 true）。传 false 时 `start()` 不起编码流，载入时删掉旧版本留下的 `full.mov`，`frames.json` 里 `movie: null`；逐帧 PNG 表照旧。
- `server/frame-pipeline.mjs`：
  - 整场景的 `entry.mov` 以 `movie: false` 建；
  - `writeMov` 只存 PNG，不再顺手起 ffmpeg；
  - `fillMov` 不再以 `full.mov` 在不在判「做过了」，每趟都交给 `renderMovFrames`，后者本来就跳过表里已有且有效的帧（第二趟只读一遍各帧 PNG 头里的产出记录，不重渲）；
  - `prerender()` 只按轨道前缀栅格化、把最后一个前缀抄进 `<键>/frames/`（这两样有消费方：`rasterPrefix` 的缓存、`readFramesCore` 的兼容读法、播放的暖帧），不再编 `preview.mp4`，旧的顺手删；
  - 去掉不再用的 `frameVideo`、`findFfmpeg` 引用。`server/bakery/frame-video.mjs` 现在没有生产调用方了，只剩它自己的测试（没删，见「更正建议」）。
- `server/vite-plugin-frames.ts`：`/status` 的 `video`、`mov` 与 `/see` 的 `mov` 恒为 `null`〔裁 1〕。
- `scripts/verify-unified-frames.mjs`：原来的「流出来的视频有 10 帧」改成「整场景 PNG 表有全部 10 帧、`frames/` 有 10 张、`preview.mp4` 与 `mov/full.mov` 都不存在」。

### `ready` 的判据

后台那一趟的阶段照旧是 `required → direct → mov → video → ready`，阶段名没改（页面只认 `ready`：`src/editor/preview/prerenderPreload.ts`）。变的是每一步做什么：`mov` 阶段只补齐整场景逐帧 PNG，`video` 阶段只做栅格化和抄 `frames/`。`ready` 不再等两次 ffmpeg 编码，会早一点到；两步不再因编码器出错让整趟重跑。

### 证据（单个测试文件）

- `node --experimental-test-module-mocks --test server/test/maint-3-legacy-mov.test.mjs`：6 / 6 通过。
- 相关旧单测逐个跑：`frame-cache-validation` 14、`frame-archive` 15、`frame-preload` 3、`card-lock-pipeline` 21、`frame-playback` 12、`query-render-2` 11、`frame-user-watchdog` 4，全部通过、0 失败。
- 代码指纹：`00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，不变（改的文件都不在 `SNAPSHOT_FILES` / `CAPTURE_FILES` 里；`frame-pipeline.mjs` 只进 `frameCode`，那个指纹本来就随管线改动变）。
- G0-R：见「验证」，全过。

## 2. 时间轴档测响度的逐秒曲线偶发缺点

### 复现

临时脚本（放在我自己的临时目录）用与 `audio-asset-path` 同样的素材造法，时间轴 7 秒，几种配置各跑 100 次，按改前的参数：

| 配置 | 缺点次数 / 100 |
|---|---|
| a：一段 3.5 s 结束 | 0 |
| b：一段 2 s 结束、其余到结尾 | 1 |
| c：四段，m4a 0～2 s、单声道 2～5 s 先结束 | 13 |

缺点那几次 stderr 里都有负的 `t:`（ffmpeg 9 的 amix 给之后的帧打了 NOPTS）。

### 修法

`server/audio-measure.mjs` 的 `timelineMeasureArgs`：在 amix（及 atrim）之后、ebur128 之前加 `asetpts=N/SR/TB`，按样本序号重打时间戳。放在 atrim 之后，是因为 atrim 遇到 NOPTS 会按样本数续算，本身不出错；也因此不必改 `timelineMixParts`（它和自定义测量的 PCM 解码、导出的混音图保持同一份）。

### 证据

- 修后同三种配置各 100 次：缺点 0 / 0 / 0。
- 修后与改前没出错的那几次逐字比较（汇总值 integrated / truePeak / LRA / LRA low / LRA high / threshold 加上整条逐秒曲线）：三种配置各 60 次，`identical: true`。
- 自定义测量的 PCM 路径（`timelinePcmArgs`，同一张混音图）也查了：配置 c 两种窗口各跑 80 次，sha1 每次相同，不受这个偶发影响，没动。
- 单测：`maint-3-loudness-pts` 2 / 2（MNT3-L-2 用真 ffmpeg 重复 40 次，并与改前参数没出错的那几次逐字比）；`audio-measure` 4 / 4、`audio-asset-path` 8 / 8、`custom-measure` 14 / 14。
- `audio-measure.test.mjs`（与导出混音图的比对）、`custom-measure.test.mjs` CM-3（与 PCM 混音图的比对）两处期望串跟着认多出的 `asetpts`。

## 3. 配音复刻的源文件经素材服务取字节

- `server/vite-plugin-voice.ts`：
  - 新 `resolveCloneSource(body, resolve)`：照 `perception-source.mjs` 的 `resolveMediaSource`，只认 `media: { id, name, kind, url, hash }`，经素材服务的解析器（`createAssetSourceResolver` + `mediaSourceOf`，和感知工具同一条）换成地址。请求体里的 `path`（连同 `media.path`）一概不看。没给标识、素材服务上没有回 400 类的 `VoiceError`；素材服务不可达抛 `AssetSourceError`，路由的 `fail` 回 502 `kind: "asset-service"`。
  - `prepareCloneAudio` 改成异步起 ffmpeg：单进程形态里素材服务在编辑器进程自己身上，原来的 `spawnSync` 会卡住事件循环，ffmpeg 发来的 HTTP 请求没人答（理由同 `audio-source.mjs` 的 `ffprobeText`）。临时文件名带 pid 和随机后缀；失败时删临时文件。
  - 去掉 `mediaDir`、`isInside` 的引用；音色备注里的「源文件」改记素材名。
- `src/ai/voice.ts` 的 `cloneVoiceFromFile`：上传后递 `media: { hash, url, name }`，不再递 `path`。页面 `VoiceSettings.tsx` 调用方式不变。
- 只牵动这两个文件，和 `AGENT-asset-path-2.md` 说的一致。
- 单测 `maint-3-voice-clone-source` 3 / 3：MNT3-V-1 老请求体只给 `path` 被拒、解析器都不问；MNT3-V-2 起真的素材服务（在测试进程里，即单进程形态）+ 真 ffmpeg，入库一段 12 秒音频，经标识取字节转出单声道 32 kHz wav，秒数对得上，转码期间事件循环在转；MNT3-V-3 页面递 `media` 不递 `path`。旧的 `perception-asset-path`（其中挂载了配音插件）10 / 10。
- 没真打第三方复刻接口（要真 API Key 且收费），路由里第三方那一段没改。

## 4. 认领闸的端到端探针

- 新 `scripts/probes/claim-gate-probe.mjs`，判定放 `scripts/probes/claim-gate-judge.mjs`（纯函数）。前后两趟，各起独立文档服务（临时数据目录、只绑回环）+ 队列模式编辑器（`PROMPTCUT_QUEUE_NODE=1`、`PROMPTCUT_NO_PORT_FILE=1`、流关掉），同一个 6 秒三张卡的项目：
  - 趟 1「专用实例没开」：不碰 Agent 直接 preload。每 150 ms 采一次诊断，判持有数（`queue.held`）从没超过 1、多出的那一格（`queue.spare.spare`）从没开、专用实例从没开、`queue@agent` 为 0。
  - 趟 2「专用实例开着」：先让模型看一帧，再 preload。判见过持有两项、见过多出的那一格开、`queue@agent ≥ 1`；采样中见到专用实例正做着一项队列任务（`scheduler.agentUnit === 'queue'`）时模型再看一帧，判这次的第一个 Agent 任务开工之前专用实例没接新的普通预渲染（只等手里那一项），输出 `agentWaitMs`。
  - 两趟都判 ready、细任务全部 done、没有失败。
- 端口：趟 1 编辑器 5990（+1、+2 舞台）、文档服务 5993；趟 2 编辑器 5994～5996、文档服务 5997。预渲染进程的端口由编辑器按系统分配的空闲端口挑（同现有探针）。
- 判定单测 `maint-3-claim-gate-judge` 3 / 3；`bakery-deps.test.mjs` 的例外表登记了这个新测试（测 `scripts/` 的测试要显式列出）。
- **真跑过一遍，`ok: true`、`fails: []`，退出码 0**（明细见「验证」）。

## 5. 专用实例上的队列任务按批给 Agent 让路

### 起因

第 4 项探针实测：认领闸把一整项快照细任务（60 帧一段）交给 Agent 专用实例后，这时来的 Agent 查询要等这一整项做完，38 s。

专用实例只在 Agent 最近 10 分钟用过时才开着，认领闸恰好在 Agent 活跃、两次工具调用之间给它接活，所以这种情况常见。上一轮的设计（后台那一趟的卡批）是「至多等一批（4 帧）」，这是退步。主会话要求在本分支修掉。

### 改了什么（`server/frame-pipeline.mjs`、`server/prerender-executor.mjs`）

- **收件箱**：专用实例借去做一项普通预渲染队列的项（`kickAgentIdle` 取的 `source: 'queue'`）时，这一项带一个收件箱。这时 `runAgentTask` 来的 Agent 任务不再挂在它整项之后的链上，而是进收件箱。
- **批边界让路**：`runQueueItem` 给 `work` 传第二个参数 `{ worker, shouldYield, yieldPoint }`；`work` 不认它时行为不变。
  - 共享档（`fillCardControls`）逐批跑时，在两批之间问一次。
  - 共享档一趟顺推（`singlePass`）时，每交完一个 4 帧块问一次。有 Agent 任务就在这一块之后停下这一趟（取消只在两帧之间生效，页面不在半路上），让路，再从下一个没做的批起顺推。起点仍按 4 帧对齐，和逐批跑的批一模一样；已交的帧不重做。
  - 本地档（`renderLocalSnapshots`）每 4 帧问一次。停下时已攒的批照常收尾、发层，让完从没做的帧接着做（这个函数本来就收任意帧集合）。
- **让路就是把收件箱做空**（`drainAgentInbox`）：
  - 做的时候又来的接着做；空了再等 `agentGraceMs`（1 s）看有没有紧跟着的〔裁 5〕。
  - 之后回到队列任务，这一步就是「恢复到队列任务的状态」：共享档下一批开头本来就按队列任务的状态 `reset` 页面；本地档那一路重新借一次（`resetAgentFor`）。
- **开工前、做完后各清一次收件箱**：排进来到开工之间、最后一批之后到的 Agent 任务，也不排在整项后面。计划、预览这类不在批边界停的项，Agent 任务照旧在它做完后立即做。
- **租约**：
  - 让路期间，开头、每 20 s（`AGENT_YIELD_BEAT_MS`）、结尾各调一次执行器给的 `heartbeat`。
  - 执行器把它接到阶段回调 `phase('agent-yield')`，经节点编排变成会话的工作计数（`step`）。队列看到 step 变了就重起停滞计时，所以 Agent 连着做很久，也不会把这一项判成停滞（`STALL_MS` 120 s）收回。
  - 续约本来就按节拍照发，不受影响。
- **专用实例在让路时被换掉**（Agent 任务重开了 Chrome）：抛 `agentGone`，这一项交还 `'queue'` 预渲染间接着做，已交的帧不重做。
- **诊断**：
  - 新增 `scheduler.yields = { count, tasks, ms, last }`，即批边界让路次数、做了几个 Agent 任务、让路总耗时、最近一次；
  - 执行器的 `executor.render-timing` 日志多 `worker`、`yields`、`yieldMs` 三个字段。
- 代码指纹不变（改的文件都不在 `SNAPSHOT_FILES` / `CAPTURE_FILES` 里）。

### 单测（`server/test/maint-3-agent-yield.test.mjs`，7 / 7）

- MNT3-Y-1 顺推时让路：推到第 5 帧来了 Agent 任务，第 4～7 帧这一块交完就停，从第 8 帧起再顺推。两趟截过的帧恰好是不让路那一趟的帧；进度、盘上的快照、index 与不让路时逐字相同。
- MNT3-Y-2 逐批跑时在两批之间让路，盘上相同。
- MNT3-Y-3 管线整合（真 `runQueueTask` / `kickAgentIdle` / `runAgentTask` / `renderCardSnapshotRange`）：
  - queue lane 被占，快照细任务交给专用实例；
  - 推到第 2 帧来了 Agent 任务，它在第 3 帧交完后开工，不等整段 24 帧；
  - 队列任务最后完成，盘上的帧与不让路时相同；`yields.count` 为 1；心跳调过。
- MNT3-Y-4 `drainAgentInbox`：连着来的一次做完，心跳开头一次、每 20 s 一次、结尾一次。
- MNT3-Y-5 租约：真队列 + 真节点编排 + 真执行器，队列任务中途让路 200 s。带心跳时一次完成、没有 lease-lost；不带心跳的对照按 `stalled` 收回，说明这条用例真的测到了停滞规则。
- MNT3-Y-6 本地档那一路：每 4 帧问一次，停下回停下的帧，已攒的批照常收尾。
- MNT3-Y-7 前后脚的两个 Agent 任务（第二个在第一个做完 20 ms 后到）：同一次让路里做完，中间队列任务没再推帧；`yields.count` 为 1、`tasks` 为 2。

相关旧单测都过：`query-render` 16、`query-render-2` 11（含 QR2-C-4 的顺序断言）、`agent-lane` 5、`queue-single-pass-fill` 3、`card-lock-pipeline` 21、`stall-phases` 6、`prerender-executor` 10、`m6c-executor` 6。

### 探针

`claim-gate-probe` 加两条判定：

- Agent 查询的等待不超过「一批加一次切换」的量级（`--agent-wait-limit-ms`，缺省 15000；判定函数 `judgeAgentWait`，单测 MNT3-C-4）；
- `scheduler.yields.count ≥ 1`。

实测见「验证」。

## 〔裁〕

1. **`/status` 回包里的 `video`、`mov` 与 `/see` 的 `mov`：保留字段，恒为 `null`。** 删字段和恒为 `null` 对现有调用方都没有区别（没有读它的）；保留则旧页面、旧探针见到的回包形状不变，`null` 本来就表示「还没有」。代价是两个永远为 `null` 的字段，注释里写明了。（三级）
2. **整场景 `MovFrameStore` 载入时删旧版本留下的 `full.mov`，`prerender()` 顺手删旧的 `preview.mp4`。** 它们是不再有人产、也没人读的缓存文件，不删会一直占盘到这一版被淘汰。删的是本机帧库里的预渲染缓存，不是用户数据。（三级）
3. **`asetpts=N/SR/TB` 只加在测响度的参数里，不改共用的混音图。** 自定义测量的 PCM 路径实测不受影响；改共用的那份会连带导出侧的比对。（三级）
4. **一趟顺推的让路做法：在 4 帧块边界停下这一趟、从下一个没做的批再顺推；不把专用实例上的任务一律改成逐批跑。**
   - 逐批跑每批都要换页，一段 60 帧里换页占一半以上时间（`AGENT-uc-latency.md`），专用实例上的吞吐会掉一截；停下再顺推只在真有 Agent 任务来时多一次换页加回放。
   - 续推的起点按 4 帧对齐，与逐批跑的批一样，落在现有「顺推与逐批从头推对 DOM 卡像素相同」的结论之内（canvas 卡本来就不走顺推）。
   - 单测 MNT3-Y-1 核了帧与不让路时逐字相同，G0-R 与基准逐像素相同。（三级）
5. **让路时收件箱空了再等 1 秒**（`agentGraceMs`，与专用实例接普通预渲染前的空档同一个值）。这是主会话提的「Agent 任务连着来时一次做完再切回」。
   - 起因是实测：一次 `see_frames` 是两个前后脚的 Agent 任务（渲完才排「量实体框」）。不等的话，第二个前面要切回队列任务一次（换页加一个 4 帧块），实测第二个任务多等 2.1 s。
   - 加了之后第二个等 0 ms；代价是每次让路给队列任务多 ≤ 1 s。（三级）
6. **计划、预览这类不在批边界停的队列项，不加让路点。** Agent 任务仍在它们开工前、做完后立即做（收件箱）。它们本身短（预览插队、计划切分），加让路点要改各自的实现，收益小。（三级）

没有改二级语义；语义文件没动。

## 验证

每条命令都在本 worktree 里跑，PATH 里加了 ffmpeg 9.0.1。端口只用了 5990～5997、6003～6008；dev server 带 `PROMPTCUT_NO_PORT_FILE=1`。跑完我按进程树结束了自己起的进程，最后核过 5990～6009 上没有残留监听。

### 第 5 项之后的重跑（最终代码 `ebb2dc52`，机器上没有别的子 Agent 在跑重活）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | 第 1 遍 tests 4153 / pass 4150 / **fail 1** / skipped 2，失败见表下说明；**整套重跑第 2 遍** tests 4153 / pass 4151 / fail 0 / skipped 2，退出码 0 |
| 新单测 | `server/test/maint-3-*.test.mjs` | B 6/6、L 2/2、V 3/3、C 4/4、Y 7/7 |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，不变 |
| 导出确定性 | 6003 这台，`node scripts/verify-determinism.mjs --url "http://127.0.0.1:6003/?export=1"` | Identical 1800 / Different 0，退出码 0 |
| 与基准逐像素 | 自写比较脚本（放在我的临时目录）逐帧解码比 RGBA：`.worktrees/main-g0r/out/verify-a/frames` 对本分支 `out/verify-a/frames` | baseline 1800、candidate 1800、same 1800、diff 0、missing 0 |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:6003 node scripts/verify-unified-frames.mjs` | PASS，退出码 0 |
| 流式生产 | `stream-produce-probe.mjs --origin …6003` | 1 遍，`fails: []`、退出码 0；1080p 全幅流 15 帧分段编码 p50 **263 ms**（门槛 300 ms），另一条 p50 40 ms |
| 流式生产（组流） | 同上加 `--group` | 1 遍，`fails: []`、退出码 0 |
| 预览退回 | `preview-fallback-probe.mjs --origin …6003`，另跑一遍加 `--page-preload` | 两种各 1 遍，都 `fails: []`、`transparentBeats: 0`、`pageErrors: []`；taskP90 为 25.9 / 28.4 ms |
| 就绪索引 | `ready-index-probe.mjs --port 6003`（自起 dev server） | 1 遍，`fails: []`，退出码 0 |
| 查询渲染 | `query-render-probe.mjs --port 6006` | 1 遍，`fails: []`，退出码 0；`card-batch@agent` 39；Agent 任务等待 `[2859, 0]` ms（等的是后台那一趟的一批卡批，那条路本来就是至多一批，没变） |
| 认领闸 | `node scripts/probes/claim-gate-probe.mjs --port 5990 --doc-port 5993` | 1 遍，`ok: true`、`fails: []`，退出码 0（明细见下） |

全量测试第 1 遍失败的是 `asset-store-http.test.mjs` 的 H1：`fetch failed … connect ETIMEDOUT 127.0.0.1:63574`，素材存储的 HTTP 测试连本机环回超时，与本改动无关。单跑该文件 6 / 6 过，整套重跑 0 失败。

中间还有一版代码（`1322aabc`，没有 1 秒宽限期）跑过一遍：

- tsc 0；全量 4152 / 4150 / 0 失败 / 2 跳过；
- G0-R 全过：确定性 1800/1800、逐像素 1800 相同、流式 p50 275 ms、预览退回 taskP90 29.4 / 28.2 ms、就绪索引、查询渲染；
- 认领闸探针 `ok: true`，Agent 等待 1490 ms。但第二个前后脚的 Agent 任务等了 2093 ms，因为中间切回了队列任务一次。于是加了宽限期〔裁 5〕，再按上表整套重跑。

### 认领闸探针明细（最终代码）

| | 趟 1「专用实例没开」 | 趟 2「专用实例开着」 |
|---|---|---|
| 模式 | full | full |
| 细任务 | 9 个快照，全部 done，没有失败 | 9 个快照，全部 done，没有失败 |
| 后台那一趟 | ready，176.8 s | ready，147.3 s |
| 最大持有数 `queue.held` | 1 | 2（持有两项的样本 466 个） |
| 多出的那一格开过 | 否 | 是 |
| 专用实例开过 | 否 | 是（preload 前模型先看了一帧） |
| 调度计数 | `queue@queue` 10 | `queue@queue` 4、`queue@agent` 6、`agent@agent` 4 |
| 让路 `scheduler.yields` | 0 次 | 1 次，做了 2 个 Agent 任务，耗时 5.9 s |

**Agent 查询的等待（改前 → 改后）**：趟 2 里看到专用实例在做一项队列任务时（那一项在发请求前 73 ms 开工），模型再看一帧。

| | 改前（`3b36d480`） | 改后（`ebb2dc52`） |
|---|---|---|
| 第一个 Agent 任务等待 `agentWaitMs` | 38 347 ms（等整项 60 帧） | **1 201 ms**（等手里那个 4 帧块交完） |
| 第二个 Agent 任务（量实体框）等待 | 0 ms（整项已做完） | 0 ms（同一次让路里接着做） |
| 整次请求耗时 | 40 560 ms | **6 125 ms** |
| 发请求后、Agent 开工前专用实例又接普通预渲染 | 没有 | 没有 |

1.2 s 在「一批加一次切换」的量级之内：切换（让路后恢复队列任务的那次换页）在 Agent 做完之后，不算在等待里。整次请求里剩下的约 5 s，是两个 Agent 任务自己的活（按 Agent 的项目换页、渲一帧、量实体框）。

### 第 5 项之前的那一轮（前四项，当时 bake-asset 子 Agent 在同机跑重活）

- tsc 0；全量 4145 / 4143 / 0 失败 / 2 跳过；指纹不变。
- 确定性 1800/1800；逐像素 1800 相同；快照重放 PASS。
- 流式生产第 1 遍耗时门槛超（p50 363 ms），重跑第 2 遍过（272 ms）；组流、预览退回两种、就绪索引、查询渲染各 1 遍全过。
- 认领闸 1 遍全过，即上表「改前」那一列。

跑的过程中有两次是我自己起错了环境，与代码无关：

- 第一次把 dev server 起在 6000：Chrome 认 6000 为不安全端口（`ERR_UNSAFE_PORT`），导出页打不开，改用 6003。**6000 在分配的 5990～6009 段里，但不能用作页面端口**（6000 是 X11 端口，Chrome 拒连）。
- 第一次跑快照重放时，我给 dev server 设了临时的 `PROMPTCUT_EXPORT_DIR`：脚本把测试素材写进工作副本的 `out/media`，dev server 却去临时目录找，素材 404、解码失败。去掉这个变量（缺省就在工作副本的 `out/` 下）重起后通过。确定性那一遍用的是前一台 dev server，导出页不读素材，结果有效。

## 更正建议（dry run，没改任何文件）

- `docs/plan/TODO.md`：「legacy 整帧通道」一条改为「方案 B 已做（`claude/maint-3`）；C、D 待用户定端口回退时的行为」；「时间轴逐秒曲线偶发缺点」「配音复刻源文件」「认领闸端到端探针」三条合入后划掉。
- `docs/plan/storage-plan.md` 里提到整场景 `full.mov` 的地方，合入后注明「整场景那份已不再产，只剩独立卡那份」。
- `server/bakery/frame-video.mjs`（及 worker、`frame-video.test.mjs`）已无生产调用方，可另开小项删掉（删文件按「对齐」先 dry run）。
- 独立卡那份 `controls/<键>/mov/full.mov` 同样只被判存在（`png-adopt-probe` 用它当信号）；要不要一起停，另议。
- `server/test/audio-asset-path.test.mjs` 里 AR-3 为躲这个偶发把几段都放到时间轴结尾，本修合入后可以恢复「有一段先结束」的写法。
- `docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」（三级）：
  - 修改前（`AGENT-query-render-2.md` 第 9.1 节建议加的那一条）：「本机渲染节点在 Agent 专用实例开着且空闲、专做队列任务的那个实例正做着一项时，多认领一项快照任务交给专用实例；不是同一张卡、不认领轨道流。专用实例没开时不多认领。」
  - 修改后，在它后面加一句：「专用实例做队列任务时按批（4 帧）给 Agent 让路：批边界有 Agent 任务就先做完（前后脚到的一起做）再接着做，Agent 任务至多等一批。」
- `AGENT-query-render-2.md` 的〔裁 6〕（等待上界是一项）已被第 5 项取代，合入时在 TODO 或归档报告里注一句。
- 分配端口段时避开 6000（主会话已记下）。

## 需要主会话决定的事

1. 合并 `claude/maint-3`，还是返工。
2. 〔裁 4〕～〔裁 6〕（第 5 项）是否照留。
3. 上面几条更正建议要不要另开小项，以及 `mechanism/rendering.md` 那一句要不要随合入写进语义。

## 主会话审查（2026-09-30，笔记本主会话）

- 审过方案 B（不再编没人用的 `preview.mp4`、整场景 `full.mov`，`/status` 与 `/see` 的字段留着恒为 `null`）、响度的 `asetpts`、配音复刻源文件经素材服务取字节、认领闸探针。
- 探针暴露认领闸让 Agent 查询等 38 s（专用实例接了一整项 60 帧的任务），主会话要求在本分支修掉：专用实例上的队列任务按批（4 帧）给 Agent 让路，实测等待 38.3 s → 1.2 s、整次请求 40.6 s → 6.1 s。〔裁 1～6〕照留，待用户审；`AGENT-query-render-2.md` 的〔裁 6〕（等待上界是一项）被本分支第 5 项取代。
- 采纳语义：`mechanism/rendering.md` 补专用实例按批让路一条（三级〔裁〕）。
- 主会话在 `claude/r8-merge` 上重跑整套，`claim-gate-probe` 退出 0；其余见 `docs/reports/REPORT-post-M8.md` 第 8 轮。合入 main `ec983fc0`。
