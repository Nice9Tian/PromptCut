# AGENT 报告：claude/online-browser

在线浏览器任务（`docs/plan/online-browser-task.md`）的第二、三、四步：撤销低内存档并落实身份；舞台闸门、崩溃记录、护栏、档位气泡；素材闸门、即时渲染闸门、最低一档。

- worktree：`.worktrees/online-browser`，分支 `claude/online-browser`，开工提交 `5f4523d0`（main）。没有推送、没有合并。
- 端口段：5870～5879（探针、dev server 只用这一段）。
- 主会话给的两处更正：分支从 main 切、不合别的分支；「预渲染小尺寸」已停产（只留轨道流），第四步第 5 条不再拟方案。

文中几个代号第一次出现时的白话：「〔裁〕」是执行中按解法表自己定下、等用户合入前审的决定；「三级」是用户看不出区别的机制，「二级」是用户看得到的行为；S1～S20 是 `scripts/probes/stage-gate-probe.mjs` 的场景编号；SG、MG、OT、LS、CP 等是单测用例编号的前缀。

## 进度

- [x] 第二步：撤销低内存档，落实身份
- [x] 第三步：舞台闸门、崩溃记录、护栏、气泡、查看口
- [x] 第四步：素材闸门、即时渲染闸门、最低一档、页面本地缓存上限
- [x] 机制文档与术语表改写（`mechanism/platforms.md`「三道闸门」、`mechanism/rendering.md`「界限搜索与成本记录」、`mechanism/document-service.md` 的优先级与成本记录、`glossary.md`）
- [x] 在线页面探针按撤档改写
- [x] 门槛验证（见「验证」一节，逐项记通过 / 失败 / 未跑 / 不适用）

## 每一步的结论（给主会话）

- **第二步**：`src/online/lowMemory.ts` 连同自动判定、设备设置「显示档」、进入提示、运行中降档（WebGL 上下文丢失、连续解码失败）、AI 栏占位、声音不合成、同步卡 `low-memory` 运行状态、`backfill` 优先级的发布方全部删掉。原来低内存档捆着的「只有一个舞台」那一套归舞台闸门第一级（精简模式），「播放时不活渲、只用小尺寸、只贴稀疏流」归最低一档，「不当渲染节点、只产稀疏版」归身份为手机。手机、iPad 和电脑走同一条路。所有在线页面都写成本记录、都能用界限搜索；「过渡期全部按重卡」删了。
- **第三步**：崩溃记录（`localStorage`，每标签页一段 + 设备级结果，`BroadcastChannel` 防多标签误判）、舞台闸门六步、护栏（30 分钟起每崩一次翻倍）与两种清零、握手容错只管当次、iPad 按闸门结果定身份、档位气泡（用户定的四句原文）、只读查看口 `?gates=1`。无头 Chrome 里真杀页面进程（CDP `Page.crash`）验了 S1～S14，全过。
- **第四步**：素材闸门（解码上限五级、按素材判；网速看实际下载，8/12 Mbps 两条线；载入原尺寸前留记录，撑崩了下次调低一级）、即时渲染闸门（基准卡 `punch-pill`、测每张卡前留记录、测崩的卡钉死为重）、最低一档（播放全部判重、停下逐层追一帧不设时限、只用小尺寸、只贴稀疏流）、页面本地缓存上限按实测环境分配。两个舞台而项目里已有别的设备测好的记录时，先用界限搜索划线，常驻探针随后在后台补测（S20）。S15～S20 真浏览器验过。

## 做了什么

### 第二步：撤销低内存档（提交 `6fb4441f`，测试跟改在 `75685dc4`）

开工摸底：`lowMemory|低内存|LowMemory|low-memory|lowMem|LOW_MEM` 在 `src/ server/ scripts/` 下命中 148 个文件，直接引 `lowMemory.ts` 的只有 6 个，其余是这一档的布尔量一路传下去。拆分如下：

| 原来低内存档管的事 | 新归属 |
|---|---|
| 自动判定、设备设置「显示档」、进入提示、运行中整体降档、AI 栏占位、声音不合成、同步卡不执行（`low-memory` 运行状态）、`backfill` 优先级 | 删（任务书第二步第 1 条） |
| 只有一个舞台：不开后台舞台、借可见舞台测量（界限搜索）、停下时在可见舞台里逐层追一帧 | 舞台闸门第一级「精简模式」与最低一档 |
| 播放时一律不活渲、素材只用小尺寸、轨道流只贴稀疏版（每段第一帧）、解码器给得少、页面切后台就暂停 | 最低一档「低配模式」 |
| 不当渲染节点、只产稀疏版 | 身份为手机（不再看档位） |

按文件：

- 删：`src/online/lowMemory.ts`（及其单测 `lowMemory.test.mjs`、`c10a-lowmem.test.mjs`、`c10a-lowmem-desktop.test.mjs`）、`src/editor/lowMemoryBackfill.ts`（及 `c10a-l17-backfill.test.mjs`）、`src/render/lowMemorySettle.ts`（逻辑并进 `settleFrame.ts`）、`src/editor/lowMemorySearch.ts`（逻辑并进 `costSearch.ts`）。
- 改名并改写：`LowMemoryGate.tsx` → `CostSearchGate.tsx`（`data-pc="cost-search-gate"`）；`lowMemorySearch.test.mjs` → `costSearch.test.mjs`（LS-01～07）；`c10a-l17-lowmem.test.mjs` → `settleFrame.test.mjs`；`mediaTierLowMemory.test.mjs` → `mediaTierSmallOnly.test.mjs`。
- 舞台能力表 `stageRpc.ts`：`lowMemory` 拆成 `compact`（只有一个舞台）、`glRoute`、`lowest`（最低一档）；删 `StageTroubleMessage`；`stageMessageGuard.ts` 照着消毒新字段、`RUN_STATES` 去掉 `low-memory`。
- GL：`glHost`、`glParent`、`glWorker`、`renderer`、`CanvasCardProgram`、`atlasPack(.d.mts)` 的 `lowMemory` 改 `compact`（`ATLAS_MAX_COMPACT`）；`ExportView` 传 `compact:false`。
- 成本记录设备串 `costDevice.mjs`：字段名冻结为 `lowMemory=`（`COST_DEVICE_COMPACT_FIELD`），值改为「只有一个舞台」——改字段名会让每台桌面版升级后整套卡重测一遍〔裁，三级〕；`resolveGlRoute(glRoute, fallback)`。
- 取档策略 `mediaTier.ts`：`lowMemory` 改 `smallOnly`（最低一档）、加 `decodeMaxPixels`、`smallFirst`；`smallOnlyFor` 按素材判。
- 分派：`planDispatch.ts` 加 `setPlanSearch` / `setPlanLowest` / `setPlanSearchLight` / `setPlanForcedHeavy`；`pipelinePlan.mjs` 加 `searchLight` 档；`boundarySearch.mjs` 加 `measureUnrecorded`（没有记录的卡逐张实测）。
- 渲染节点资格：`browserNode.ts` 的 `EligibilityInput` 改看 `phone` / `lowest`（理由 `phone`、`lowest`）；`browserNodeHost.ts` 的 `ownSparseOnly`；`pageStreams.ts` 的 `sparseOnly`。
- 流：`snapshotSource.ts`（`sparseOnly` 只在最低一档、`SPARSE_STREAM_CACHE_MAX_BYTES`）、`streamBudget.mjs`（`sparseStreamBudget`）、`streamPlayer.ts` / `streamSegments.mjs` 注释、`snapshotFeed.ts`（`single` / `lowest`）。
- 声音：`onlineSoundBoot`、`onlineSoundJudge`、`exportSounds`、`CardAudioForm`、`isolatedSound`、`src/audio/cardAudio.ts`、`soundCost.ts`：不再按档预先禁用；单舞台时声音线程在 A。
- 用户卡：`stageIsolation.ts` 改 `setStages(ids)`，单舞台同样跨源隔离、同样执行；`cardRunStates.ts`、`registry` 去掉 `low-memory`。
- 界面：`OnlineAgentPage.tsx` 恒挂云端 AI 栏；`DockPages.tsx` 去掉占位；`Preview.tsx` 去掉 `DisplayTierPicker`、进入提示、`trouble` 降档；`Shell.tsx` 的界面选择改看 `predictIdentity`。
- 成本记录：`sharedCosts.ts` 的 `measuredHere` 不再按档过滤（所有在线页面测完都写）。
- `server/` 下的 `artifact-transfer`、`costs-store`、`docservice/modules/costs`、`frame-pipeline`、`prerender-set`、`render-node/{filter,host,local-node,split}`、`render-queue/{messages,queue}`：只改注释（`backfill` 只为部署切换期间的老页面留着）。`git diff` 核过这些文件没有一行代码变。

### 第三步：舞台闸门（提交 `75685dc4`，探针 `9861e12b`）

- 新 `src/online/crashLog.ts`：记录的形状（每标签页一段 + 设备记录）、读写、判崩（`judgeLoad`）、修剪、测崩的卡（上限 500 张）。
- 新 `src/online/stageGate.ts`：判法 `decideStageGate`（纯函数，注入存储、时钟、环境）、护栏 `guardMsOf`、多标签 `pingTabs`、页面一侧的 `beginStageGate` 会话（每一步留记录、心跳、`pagehide`/`pageshow`/`visibilitychange`、`fallback`、测量与素材留记录）、`predictIdentity`、强制档位 `forcedTierOf`。
- 新 `src/online/onlineTier.ts`：这次会话的档位状态（目标、到达、走完没有、最低一档、身份、基准卡），`tierStart`（起手路线，舞台 iframe 地址只按它拼）、四档名字与气泡原文。
- `src/online/boot.ts`：编辑页载入时起舞台闸门，随后测解码上限。
- `src/editor/Preview.tsx`：闸门驱动（可见舞台就绪后才挂后台舞台、`setGlRoute` 换到各一套、放掉编辑器页共用的 Worker、`?gateHold=` 验收钩子、`window.__pcGates()`）；握手失败调 `fallback(1)` 并挂跨源单舞台 A。
- `src/StageView.tsx`：RPC `setGlRoute`（原地换路线）；能力表读 `gl` / `compact` / `lowest` 参数。
- `src/editor/previewMode.ts`、`src/online/stageOrigins.ts`：`stageLayout({ single })`；舞台地址带起手的档位参数。
- 新 `src/editor/TierBubble.tsx`（气泡）、`src/editor/GateViewer.tsx`（查看口）。
- 单测：`stageGate.test.mjs`（SG-01～16）、`onlineTier.test.mjs`（OT-01～05）。
- 探针：新 `scripts/probes/stage-gate-probe.mjs`（S1～S14：真杀页面进程）。

### 第四步：素材闸门、即时渲染闸门、最低一档（提交 `c24a8fc5`、`7661ea4f`、`e391ecbc`）

- 新 `src/online/mediaGate.ts`：解码上限（五级阶梯、`mediaCapabilities` → `VideoDecoder` → 按 1080p、撑崩过的往下调级）、要载入原尺寸的素材签名。单测 `mediaGate.test.mjs`（MG-01～08）。
- 新 `src/render/netSpeed.ts`：舞台里看资源计时算网速，事件 `net-speed` 报给父页（查看口用）。
- `Preview.tsx`：取档策略带解码上限；载入原尺寸前留记录（等闸门走完、基准卡测完才记，免得盖掉舞台闸门的步骤）；基准卡（`runBenchmark`，两个舞台在后台舞台测、单舞台借可见舞台）；测每张卡前后留记录（`probeRunner.ts` 的 `setProbeMeasureHooks`、`costSearch.ts` 的 `beforeMeasure` / `afterMeasure`）；测崩的卡 `setPlanForcedHeavy`；单舞台界限搜索；两个舞台有记录时的界限搜索（`holdProbe` / `releaseProbe` 让常驻探针先等，`__pcDualSearch`）；所有档都发布清单计划。
- `src/editor/costSearch.ts`：`runCostSearch`、`measureNewCards`、基准卡 `BENCHMARK_CARD_ID` / `benchmarkVerdict`。
- `src/render/settleFrame.ts`：停下逐层追一帧，`clampSettleTimeout` 回 `null` 表示不设时限；舞台 RPC `settleLayers`（父页等回包上限 10 分钟）。
- `src/online/l2.ts`：页面本地缓存软上限 `l2LimitOf(estimate, deviceMemory)`。
- 探针：S15～S20。

### 文档（提交 `e391ecbc`、`fb1ff894`）

- `mechanism/platforms.md`「三道闸门」整节按实现改写（崩溃记录、步骤、容错、身份与 iPad、素材闸门、即时渲染闸门、最低一档、气泡、查看口、测试钩子）；L2 软上限、运行状态那一行同改。
- `mechanism/rendering.md`「界限搜索与成本记录」整节改写；有声动效卡那一条去掉「代码中的旧限制仍待改」。
- `mechanism/document-service.md`：`backfill` 只为老页面留着；所有在线页面打开项目时读全部记录。
- `glossary.md`：删「低内存档」一条。任务书说的「预渲染任务」那一条没有删：术语表里「预渲染任务」是现行用词（2026-10-09 用户定，指发出去等节点认领的那种），撤销的是「为弱设备补发的预渲染任务」这一类，术语表里本来没有单独的条目。
- 用词：代码与探针注释里「在线普通档」改成「在线双舞台」或「电脑浏览器」（`product/platforms.md`：「普通档」一词随之不用）。

### 越出清单改的文件（都为跟着撤档，逐个说明）

| 文件 | 为什么 |
|---|---|
| `src/Shell.tsx` | 界面选择原来看 `lowMemory` 的设备种类，改看 `predictIdentity`（iPad 按闸门预判） |
| `src/render/**`（`stageRpc`、`mediaTier`、`settleFrame`、`netSpeed`、`costDevice`、`snapshotSource`、`streamBudget`、`pipelinePlan`、`boundarySearch`、GL 一组、`atlasPack`） | 低内存档的布尔量一路传到这里，不改就编不过；新的网速子闸门在舞台里跑 |
| `src/StageView.tsx`、`src/ExportView.tsx` | 舞台能力表与 RPC（`setGlRoute`、`settleLayers`）；导出页传 `compact:false` |
| `src/kernel/project.ts` | 只改注释 |
| `src/export/onlineExport.ts`、`src/editor/io/index.ts` | 只改注释（探针文件名） |
| `server/**`（非测试） | 只改注释 |
| `server/test/*`（c10a-kit、c10-kit、c10-l2、c10-stages、c10-ui-gates、c10a-l17-queue、below-stream、m7-kit、m7-page-node） | 测试跟着撤档改 |
| `scripts/probe-card-costs.mjs` | 设备串的读法跟着 `compact` 改 |
| `src/cards/_probe/slow.tsx` | 只改注释（「在线普通档」） |

没动：`src/mobile/**`、`src/ai/cloud/**`、`CloudAiPanel.tsx`、`AiSetupDialog.tsx`、`server/runners/setup.mjs`、`src/editor/sync/accountMove*.ts`、`CollabSection.tsx`、`ProjectSettingsDialog.tsx`、`scripts/probes/playback-probe.mjs`、`docs/plan/**`。`server/agent/service/frame-dispatcher.mjs` 里把 `kind === 'lowmem'` 当手机的别名留着没动（Agent 服务的分派，旧客户端可能还报这个值）。

**要主会话改的 `src/editor/ProjectSettingsDialog.tsx`（我不许动）**：

- 第 71 行注释「空串 = 按宿主能力(低内存档 shared,否则 perDocument)」→ 建议「空串 = 桌面按缺省(perDocument);在线浏览器不看这一项,跟舞台闸门走」。
- 第 228～239 行「三维渲染」下拉：选项「自动(按本机内存)」的说法与在线页面不符（在线页面的路线跟舞台闸门走，见〔裁〕表第 7 条）。建议在线页面上隐藏这一行，或把「自动」改成「自动」并加一句「在线浏览器按设备能力自动选」。这是用户看得见的文字，属二级，请主会话定。

## 数字与依据（三级，均标〔裁〕，已写回机制文档）

| 数 | 取值 | 依据 | 写在 |
|---|---|---|---|
| 崩溃记录心跳 | 5 秒 | 一次读写约 2 KB 的 JSON，这台 PC 实测 0.013 毫秒；1 分钟的判崩线减去 5 秒，崩后 55 秒内重新载入都接得住 | `crashLog.ts` `HEARTBEAT_MS` |
| 多标签问一声 | `BroadcastChannel`，等 200 毫秒 | 同源标签页互通；200 毫秒够同机另一个标签页回音，又不明显拖慢打开 | `stageGate.ts` `TAB_PING_MS` |
| 测崩的卡上限 | 500 张 | 防记录无限长；一个项目很少超过这个数 | `crashLog.ts` `HEAVY_CARDS_MAX` |
| 解码上限分级 | 2160p / 1440p / 1080p / 720p / 480p | 手机素材常见的五档分辨率 | `mediaGate.ts` `DECODE_LADDER` |
| 解码上限测法 | `mediaCapabilities.decodingInfo`（H.264 High `avc1.640033`、30 帧、各级常见码率 45/24/16/8/3 Mbps，要 `supported` 且 `smooth`）→ `VideoDecoder.isConfigSupported` → 问不出按 1080p；都说解不动按 480p；每级最多等 3 秒 | 浏览器自报，免实测解码的耗时与风险；这台 PC 测出 2160p，78 毫秒 | `mediaGate.ts` |
| 载入原尺寸记录时长 | 15 秒 | 原尺寸首帧解码、预热大多在几秒内；这段时间里崩了算在素材头上 | `mediaGate.ts` `MEDIA_MARK_MS` |
| 网速界线 | 低于 8 Mbps 先小后大，高于 12 Mbps 只拉原尺寸，中间不变 | 手机拍的 1080p30 H.264 常见 8～17 Mbps；两条线之间留回差防来回抖 | `netSpeed.ts` |
| 网速样本 | 只看素材服务的请求，≥ 256 KiB、下载 ≥ 50 毫秒；指数滑动平均，新样本占 0.3 | 太小太快的是缓存或只有响应头，算不准 | `netSpeed.ts` |
| 基准卡 | 「金句药丸」`punch-pill`，缺省参数、2 秒、30 帧；跑不动 = 单帧耗时 × 成本倍率 > B（30 帧 23.3 毫秒） | 内置卡里最简单的一类（一行字弹入）；与判重同一个式子。PC 测出 0.5 毫秒，舞台降速 60 倍时 25.9 毫秒判跑不动 | `costSearch.ts` |
| 从共用换到各一套渲染器 | 不重建舞台，RPC `setGlRoute` 原地换 | `glHost.setRoute` 本来能原地换；舞台 iframe 地址只按起手路线拼，试的途中不变（S1 核过） | `Preview.tsx`、`StageView.tsx` |
| iPad 识别 | 标识里有 iPad，或标识是 Macintosh 而 `maxTouchPoints > 1` | iPad Safari 缺省报桌面声明；Mac 没有多点触控 | `stageGate.ts` |
| 两样声明都读不到 | 算电脑（2026-10-21 用户定） | — | `stageGate.ts` |
| 页面本地缓存上限 | 有 `storage.estimate()`：剩余额度的 10%，夹在 32 MiB～1 GiB；没有：`deviceMemory` 每 GiB 32 MiB，夹在 64～256 MiB；都没有：128 MiB | 按实测环境分（用户定）；PC 的无头 Chrome 报 10 GiB 额度，取到 1 GiB | `l2.ts` `l2LimitOf` |
| 气泡 | 等基准卡结论最多 15 秒，显示 5 秒 | 用户定「几秒后自动消失」；等基准卡是为了低配模式那一句说得准 | `TierBubble.tsx`、`onlineTier.ts` |
| 停下追一帧 | 不设时限；父页等回包上限 10 分钟 | 用户定「不设时限」；10 分钟只为防 RPC 永远挂着 | `settleFrame.ts` |
| 只有一个舞台时的流预算 | 只贴稀疏版、解码器 4 个、画幅之和两张 1080p 满屏卡、流字节 16 MiB；起播不等流的第一帧 | 沿用原低内存档的数（`streamBudget.mjs` 文件头的依据）。模拟手机（CPU 降速 4 倍、精简模式）实测：按双舞台那一套同屏 5 条流，起播头 3 拍把 5 张重卡全活渲了，舞台每拍第 95 百分位 160～200 毫秒；按这一套 0.5 毫秒 | `streamBudget.mjs`、`snapshotSource.ts`、`snapshotFeed.ts`、`StageView.tsx` |

用户定死、没动的数：1 分钟、8 GB、护栏 30 分钟起每次翻倍、崩一次就算。

## 〔裁〕清单

### 三级（用户看不出区别）

1. 成本记录设备串的字段名冻结为 `lowMemory=`，值改成「只有一个舞台」。
2. 崩溃记录每标签页一段 + 设备级结果，标签页 id 放 `sessionStorage`，新标签页先经 `BroadcastChannel` 问一声。
3. 从共用换到各一套渲染器不重建舞台。
4. 解码上限按单路分辨率分级，同时几路不另测（交给已有的预热名额与流预算）。
5. 两个舞台、项目里已有对得上的记录：打开时先用界限搜索在后台舞台只测几张划线，常驻探针随后在后台补测，补测完分派改按成本记录（任务书只说「两个舞台照旧常驻探针」，混合做法让有记录的项目打开更快，补测保证 K3/K5 追帧、互换要的记录齐全）。
6. 「性能不足时只贴稀疏版」归只有一个舞台的页面（精简模式与最低一档，`product/platforms.md` 留给「做的时候定」）：只贴稀疏版、解码器 4 个、起播不等流的第一帧，就是原低内存档那一套，给的也是原来那一批设备（内存不到 8 GB 的安卓、撑不住双舞台的 iPad 与手机）。先归给最低一档时，模拟手机（精简模式）同屏 5 条流每拍 160～200 毫秒，所以改归单舞台。
7. 测试钩子 `?tier=`、`?gateHold=`、`?gates=1` 只给开发与验收用，不在界面上给入口。
8. 两个舞台的界限搜索测过的卡里判重的，遮罩照旧挡着、紧接着给它产稀疏版（和常驻探针同一个口子 `runCardMeasuredHook`）；按记录划线判重、没测的归闲时产（`rendering.md`「测量」原有的规矩）。
9. 本页产流的「舞台布局」多一个 `pending`：按两个舞台开、还没都握上手（舞台闸门在试后台舞台）时不当节点，也不按只有一个舞台算（不然会当成只产稀疏版、不等计划就开工）。
10. 护栏内、崩过、安卓不到 8 GB 的那一次打开（舞台闸门一开始就算走完），基准卡等舞台按那一级挂好才测（`gateDriven`）。

### 二级（用户看得到区别；需要主会话播报、用户合入前审）

1. **握手失败时挂跨源单舞台 A**
   - 修改前：两个跨源舞台握不上手时一个舞台都不挂（2026-10-14 撤掉退回同源单舞台之后），预览没有画面。
   - 修改后：退回跨源单舞台 A，这次使用期间按第一级（精简模式）运行：借可见舞台测、停下逐层追一帧。
   - 理由：`mechanism/platforms.md` 写的是「退回单舞台」，不挂舞台等于预览不可用；跨源 A 仍满足「一律跨源隔离」。
2. **在线页面不看项目选项「三维渲染」**
   - 修改前：项目设置的「三维渲染」（每个舞台各一个 / 两个舞台共用）在线页面也生效，缺省按低内存档选。
   - 修改后：在线页面的 canvas 渲染路线跟舞台闸门走（到第三级各一套，其余共用），项目选项只对桌面版生效。
   - 理由：舞台闸门的第二、三级就是由路线定义的；照项目选项走会让闸门试出来的结果失效，崩溃记录也会记错。界面文字要改的地方见上文「要主会话改的 ProjectSettingsDialog.tsx」。
3. **只有一个舞台时同样执行用户卡与素材效果卡**
   - 修改前：只有一个舞台（原低内存档）时同步卡运行状态是 `low-memory`，不执行，显示沙漏等渲染节点。
   - 修改后：单舞台同样跨源隔离、同样执行，运行状态 `ready`。
   - 理由：用户 2026-10-06 定所有在线浏览器执行；单舞台 A 与双舞台的 A 是同一种隔离文档。
4. **档位气泡等基准卡**
   - 修改前：（新功能）
   - 修改后：舞台闸门走完后最多再等 15 秒基准卡的结论才出气泡，免得先说「精简模式」随即变「低配模式」；显示 5 秒。
5. **手机与 iPad 的声音照常测、照常合成**（随撤档而来，不是我新定的）：原来低内存档的声音不测、不合成、导出缺声音就失败；现在和电脑一样。`rendering.md` 有声动效卡一节原本就写着这条规则待落地。

## 验收中查出并修好的问题（都在本分支）

| 提交 | 问题 | 怎么查出来的 | 修法 |
|---|---|---|---|
| `1c8bd28d` | 只有一个舞台停下追一帧时，正在画的那一层既不显示占位符也没有画面（暂停着没有下一拍来刷占位符），慢卡要空白一两秒。原低内存档同样如此，只是那时有 5 秒时限 | `page-stream-probe --only lowest` 第六条「停下以后这张卡显示精确画面」截到空白；排查脚本逐 30 毫秒看那一层：画的 1.5 秒里在 `pc-settling` 下、占位符不显示 | 每画一层之前刷一次占位符（`StageView.tsx` 的 `drawSettleLayer`）。之后同一条通过 |
| `5fcf0b49` | 两个舞台用界限搜索时，测过的重卡没在遮罩下产稀疏版（`rendering.md`「测量」要求紧接着产） | `page-stream-probe` 甲的加载遮罩一直等不到（甲走了界限搜索那条路） | 见〔裁〕第 8 条；探针里加卡的那一页改用最低一档（不写成本记录），几场照旧验「常驻探针在遮罩下逐张测」那条路 |
| `f2010ab1` | 精简模式按双舞台的流预算贴流，模拟手机同屏 5 条流时起播头 3 拍把 5 张重卡全活渲了（每拍 160～200 毫秒） | `page-stream-probe --only mobile` 的「播放节拍 p95 < 33 ms」；main 上同一场只有 1 拍 | 见〔裁〕第 6 条 |
| `7a505b65` | 舞台闸门试后台舞台那几秒里，本页产流把页面当成只有一个舞台：不等清单计划没人认领就开工 | `page-stream-probe` solo 场「计划发出去 5000 毫秒以上仍是 open，本页才开工」（实际 922 毫秒）；main 上同一场这一条过 | 见〔裁〕第 9 条 |
| `b40d84b7` | 护栏内、崩过的那一次打开：基准卡在后台舞台还没挂好时就测，测不出来；测完把记录的那一步还原成过时的「开可见舞台」，查看口一直停在那一步 | `stage-gate-probe` 的 S3 偶发失败；排查脚本看到重新载入后 `step` 从「第 2 级运行中」退回「开可见舞台」 | 见〔裁〕第 10 条；测量、载入原尺寸结束时那一步已过时就回「第几级运行中」（`stageGate.ts`，单测 SG-17） |
| `82bda2b2`、`6c8d202a`，由 `617b7fcb` 撤回 | （误判）`below-online-e2e-probe` 的 E、G、H 像素比对失败，先以为是「试第三级时原地换渲染路线」和「两个舞台的界限搜索」引起的，分别改成重建舞台、撤掉两个舞台的界限搜索 | 之后在 main（`out/baseline`）上连跑两次，同样的 8 条以同样的数字失败（只有第一次碰巧过）：这支探针在 main 上就是时过时不过 | 两处改动整个撤回，代码与文档回到撤回前；这支探针记为「与 main 相同」 |

## 验证

门槛按主会话 2026-10-22 改过的要求：不跑全量 `npm test`，跑改动影响到的测试文件；类型检查、渲染附加项、本块探针照旧。

| 项 | 命令 | 结果 | 结论 |
|---|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出为空（最后一次在 `570eb092` 上） | 通过 |
| 改动影响到的测试 | 按 `git diff 5f4523d0..HEAD -- src server` 里改过的非测试文件，找出引用它们（按文件名）的测试文件，加上本分支改过、新加的测试与引用改过的 `*-kit.mjs` 的测试：399 个文件，分 5 批 `npm test -- <文件…>`（一次全给命令行太长）；另加 `src/online`、`src/editor`、`src/render`、`src/audio`、`src/export`、`src/store` 下没被圈进去的 83 个，共 482 个文件。设了两个账号服务的环境变量 | 6 批测试数 566 / 940 / 932 / 680 / 656 / 610，共 4384 个；失败 1 个：`src/editor/measureGate.test.mjs` 的 MG-06（按源码切片核「界限搜索等门」，两个舞台的界限搜索加在前面以后切到了那一处），改测试（`570eb092`）后该批重跑 680/680、该文件 8/8；跳过 2 个（原本就标跳过） | 通过 |
| 构建 | `npm run build` | 退出码 0 | 通过 |
| 在线构建 | `npx vite build --mode online --outDir out/dist-online` | 退出码 0 | 通过 |
| 与开工提交的导出像素比对 | `out/baseline`（`git archive 5f4523d0`）与本分支各起一台 dev server（5870、5875），`scripts/export-frames.mjs --url …/?export=1 --fps 30 --workers 1 --no-video`，再 `scripts/probes/export-baseline-compare.mjs` | 逐字节相同 1800/1800 | 通过 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url http://127.0.0.1:5875/?export=1 --fps 30` | Identical 1800、Different 0 | 通过 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5875 node scripts/verify-unified-frames.mjs` | PASS | 通过 |

### 探针（端口段 5870～5879，在线构建 `out/dist-online`；对照是同一支探针在 `out/baseline` 上用 main 的在线构建跑）

| 探针 | 本分支 | main 对照 | 结论 |
|---|---|---|---|
| `stage-gate-probe.mjs`（新） | S1～S20 共 20 场，全量跑一次只有 S16 不过（舞台降速 60 倍时基准卡测不出来，判「不知道」、没进最低一档）；S16 单独跑 3 次过 2 次（单帧 160、53.5 毫秒，判跑不动） | 新探针 | S16 时过时不过，见「没做成的」 |
| `page-stream-probe.mjs` mobile / mask / slow / desk | 全过 | — | 通过 |
| `page-stream-probe.mjs` solo | 3 条不过 | 同样 3 条（「测量时本页产了这条流稀疏的两段」等） | 与 main 相同 |
| `page-stream-probe.mjs` splitter | 2 条不过（「这条流经队列产出来」超时） | 同样 2 条 | 与 main 相同 |
| `page-stream-probe.mjs --only lowest`（原 `lowmem`） | 3 条不过（第四条的像素比对：参照截图里卡没画出来） | main 上 `--only lowmem` 同样 3 条 | 与 main 相同；第六条（停下以后显示精确画面）本分支修好后通过 |
| `online-card-exec-probe.mjs` | 61/61 | — | 通过 |
| `online-card-security-probe.mjs` | 113/113 | — | 通过 |
| `online-user-cards-probe.mjs` | 通过 | — | 通过 |
| `sound-ab-probe.mjs`（桌面、在线、手机三段） | 71/71 | — | 通过 |
| `cut-online-e2e-probe.mjs` | 通过 | — | 通过 |
| `stateful-seq-vs-jump-probe.mjs` | 退出码 0 | — | 通过 |
| `below-online-e2e-probe.mjs` | 8 条不过（E、G、H 的像素比对） | main 上 3 次：1 次过、2 次同样 8 条、同样的数 | 与 main 相同（时过时不过） |
| `online-stale-layer-probe.mjs` | 20 条不过 | 同样 20 条 | 与 main 相同（v18 清单里记过「6 条断言不过，原因没查」，现在更多，main 上也是 20） |
| `browser-stream-node-probe.mjs` | 13 条不过（等「这张卡的快照任务」超时及其后续） | 同样 13 条 | 与 main 相同；本分支第一次跑时页面中途掉成单舞台、多 10 条，重跑没再出现 |
| `browser-stream-e2e-probe.mjs` | 卡在「甲做完这张卡的流任务与快照任务」，我手动停了 | 没跑 | 未跑完（同类的 node 探针在 main 上卡在同一处；快照任务 2026-10-13 起已不产） |
| `online-stream-play-probe.mjs` | 多条不过（先是「等不到:card:快照齐」） | main 上跑到一半为腾端口停了 | 未比对（渲染重构一带的探针，v18 清单里排除了） |
| `online-export-modes-probe.mjs` | 没跑 | — | 未跑：它要连号 20 个端口（+10～+12 起渲染主机），我的段只有 10 个 |
| `stage-push-before-after-probe.mjs` | 没跑 | — | 不适用：验的是改舞台推帧公共代码（`pinAnimations.ts`、`stageClock.ts`）前后，本分支没改它们 |
| `m7-browser-probe`、`c10-cost-probe`、`c10a-demo-probe`、`c10-browser-probe`、`c10-ui-probe`、`cloud-agent-ui-probe` | 没跑 | — | 未跑：入口在 0.7.18 起就跑不通（`scripts/acceptance/v18-manifest.mjs` 的 STALE_OLD_ENTRY）或要账号服务；只改了与低内存档有关的断言 |

看过的图：`S15-low-settled.png`（最低一档停下以后金句药丸画出来了）、最低一档停下追帧排查脚本截图（画好后橙块出现）、`below-online` 的 `new-ref-28` 对 `jia-new-drag-28-stream` 对 `jia-new-settled-28`（参照里里程表还在滚，后两张是 86420；main 上同样）。

### 测试覆盖不到的范围（发版前全量照这个核）

全仓库 917 个测试文件，跑了 482 个；没跑的 435 个：`server/test` 351 个、`src/ai` 34、`src/kernel` 22、`desktop/test` 6、`src/cards` 4、`src/account` 3、`src/mobile` 2、`src/mcp` 2、`server/bakery` 2，其余零星几个（`archive/python-cards`、`tools/report-worker`、`src/ui`、`src/skins`、`src/parts`、`scripts/probes`、`docs/reports` 下的）。`src/online`、`src/editor`、`src/render`、`src/audio`、`src/export`、`src/store` 下的全跑了。没跑的文件清单：worktree 里 `out/b2.txt` 减 `out/ran.txt`（`out/` 不入库，要的话主会话可按上面的办法重算）。其中与本分支关系最近、建议发版全量时留意的：`src/mobile/**`（身份为手机进手机版界面；本分支改了 `Shell.tsx` 的身份判法，iPad 按闸门预判）、`server/test` 里 Agent 服务按设备分派的测试（`frame-dispatcher.mjs` 还认 `lowmem` 这个旧别名）。

## 测试与探针：删了、改了哪些，为什么

### 单测

| 删 / 改 | 原因 |
|---|---|
| 删 `src/online/lowMemory.test.mjs`、`c10a-lowmem.test.mjs`、`c10a-lowmem-desktop.test.mjs` | 测的是 `lowMemory.ts`（自动判定、显示档、降档），模块已删；替代：`stageGate.test.mjs`、`onlineTier.test.mjs` |
| 删 `src/editor/c10a-l17-backfill.test.mjs` | 测的是 `lowMemoryBackfill.ts`（为弱设备补发预渲染任务），这一类任务撤销 |
| `c10-cost-plan.test.mjs` 删 CP-03（预渲染重试只对判重又缺产物的层）、加 CP-07 | 同上；CP-07 是新行为：测崩过的卡直接当重卡 |
| `exportSounds.test.mjs` 删 A12（低内存档导出缺声音直接失败） | 手机不再按档禁用声音 |
| 各处 `low-memory` 运行状态的断言 | 运行状态撤销 |
| `lowMemorySearch.test.mjs` → `costSearch.test.mjs`（LS-01～07） | 改名并加「没有记录的逐张实测」「测量前后留记录」 |
| `c10a-l17-lowmem.test.mjs` → `settleFrame.test.mjs` | 改名；时限改成「不设时限」 |
| `mediaTierLowMemory.test.mjs` → `mediaTierSmallOnly.test.mjs` | 改名；加按素材判 |
| `boundarySearch` BS-C11、`c10a-single-stage` C10A-GT-07b、`stageIsolation` OCS-S-14、`pageStreams` PS-17～19 等 | 新行为的用例 |
| 其余（`l2`、`onlineCards*`、`cardRuntime`、`soundThread`、`onlineSoundJudge`、`sharedCosts`、`snapshotFeed`、`stageSwap`、`stageMessageGuard`、`stageOrigins/Handshake/Watch`、`costDevice`、`atlasPack`、`server/test/c10*`、`m7*` 等） | 跟着字段改名、撤档改期望 |

### 探针

| 探针 | 改了什么 | 原因 |
|---|---|---|
| `page-stream-probe.mjs` | `lowmem` 场改名 `lowest`，页面乙带 `?tier=low`（原来设设备设置「显示档：低内存」）；`mobile` 场改核「安卓 4 GB 停在第一级（精简模式）、身份手机、气泡原文」，原来核低内存档的进入提示；模拟手机经 CDP 一并报安卓的 `userAgentData`、用 `?layout=desktop` 看桌面界面；加卡的页面改用最低一档（不写成本记录，几场照旧验常驻探针那条路）；收尾前先把结论写进日志（收尾偶尔卡住时结果不丢）；遮罩判据加上 `cost-search-gate` | 撤档；两个舞台有记录时走界限搜索；收尾卡住丢过一次结果 |
| `online-user-cards-probe.mjs` | 模拟手机那一段：原来看 `__pcBackfill()`，改看清单计划 `__pcPlanPublisher()`，并核 `__pcBackfill` 已不存在；停下追一帧改为等画完（不设时限） | 补发那一类任务撤销 |
| `online-card-exec-probe.mjs` | E9 由「低内存档不执行（`low-memory`）」改成「模拟手机单舞台照样执行（`ready`，记号只在那一个舞台里）」 | 二级〔裁〕第 3 条 |
| `online-card-security-probe.mjs` | 场景 M 由「低内存档回退不执行」改成正向：跨源单舞台、执行开关开、用户卡只在那一个舞台里执行 | 同上 |
| `sound-ab-probe.mjs` | `lowmem` 段改名 `phone`：L1 改核「不再回 `low-memory`、照常测量」；删「未生成的有声卡预览不出声、提示写明低内存档」；L3 改核「导出时先生成再导出」 | 手机不再按档禁用声音 |
| `m7-browser-probe.mjs` | 最低一档的页面改用 `?tier=low`；A9 判据名 `page-lowest-shows-small` | 撤档 |
| `c10-cost-probe.mjs` | 第 4 步改核单舞台界限搜索（`__pcCostSearch`）、清单计划、判轻的卡播放时活渲 | 撤档；入口本身（邀请链接）在 0.7.18 起已跑不通 |
| `cloud-agent-ui-probe.mjs` | O6 改核「手机进项目后不再是低内存档的占位」，删「手机没有发往 /agent/ 的请求」 | AI 栏不分身份 |
| `stage-rpc-probe.mjs`、`c10-browser-probe.mjs`、`m7-bake-probe.mjs`、`m7-bake-node-probe.mjs`、`fixtures/online-card-boundary/*` | 能力表字段 `lowMemory` → `compact` / `lowest` | 字段改名 |
| `lowmem-online-probe.mjs` | 文件头标〔已退役〕，断言不改 | 整支按低内存档写；接替的见文件头；它本来就在验收清单的排除表里 |
| `c10a-demo-probe.mjs` | 文件头标第 2、2c、4 步失效，断言不改 | 那几步按低内存档写（且依赖已停产的预渲染小尺寸）；整支的入口 0.7.18 起已跑不通，要重写主干 |
| `stage-gate-probe.mjs`（**就地改写**） | S1～S20：三道闸门、崩溃记录、护栏、气泡、查看口、最低一档、基准卡、测崩的卡、解码上限、界限搜索；从文档一开始记气泡文字；等闸门超时时把查看口写进日志；S15 加「画好的那一层看得见、有内容」 | 第三、四步的真浏览器验收。**注意**：main 上同名那支原来验的是 `server/stage-gate.mjs` 的舞台端口放行白名单（另一回事），我没留意就把它改写了；主会话已在 main 上另存为 `scripts/probes/stage-port-whitelist-probe.mjs`，合并时两支都留 |
| 新 `scripts/probes/lib/android-ua.mjs` | 模拟安卓手机时经 CDP `Emulation.setUserAgentOverride` 一并给 `userAgentMetadata` | Puppeteer 的 `emulate` / `setUserAgent` 只改 UA 字符串，`userAgentData` 还报 Windows、非手机，在线页面按它判身份与「安卓、内存不到 8 GB」 |
| `online-user-cards`、`online-card-exec`、`online-card-security`、`sound-ab`、`c10-cost`、`cloud-agent-ui-lib` | 模拟手机都用上 `android-ua.mjs`；前四支进页面带 `?layout=desktop`（身份为手机缺省进手机版界面，这几支看的是桌面界面的选择器） | 同上 |
| `online-card-security-probe.mjs` 场景 N | 原因由 `single-stage` 改为 `no-stage` | 没有挂着的舞台时现在报 `no-stage`（单舞台照样执行，`single-stage` 不再是不执行的原因） |
| `sound-ab-probe.mjs` 手机段 | 等舞台闸门、基准卡、界限搜索落定再听 | 精简模式打开项目时借可见舞台做界限搜索，遮罩挡着、预览不播 |

## 没做成的与原因

1. `stage-gate-probe` 的 S16（舞台 CPU 降速 60 倍时基准卡判跑不动）时过时不过：全量跑与单独跑一共 5 次过 2 次。不过的那几次基准卡测不出来（判「不知道」），按机制文档「测不出来不算跑不动」不进最低一档。降速 60 倍下测量的 RPC 有时等不到回包；要不要把「测量超时」也算跑不动，留给用户定（见待用户项）。
2. `browser-stream-e2e-probe`、`online-stream-play-probe` 没比对完（见验证表）；同类探针在 main 上卡在同一处（等已停产的快照任务），推测与 main 相同，没实证。
3. `online-export-modes-probe` 没跑（要 20 个连号端口）。
4. 安卓、iPhone、iPad 真机没测（主会话做；做法与预期见下两节）。

## 待用户项

1. 二级〔裁〕五条（见上）请用户合入前审。
2. `ProjectSettingsDialog.tsx`「三维渲染」那一行在在线页面上怎么显示（隐藏还是改文字）。
3. `docs/plan/TODO.md` 里与本任务对应的那一行由主会话划掉（`docs/plan/**` 不归我改）。
4. 真机核对（见下两节）。
5. 基准卡测不出来（例如设备慢到测量的 RPC 超时）要不要算跑不动、进最低一档。现在按机制文档不算。
6. `scripts/probes/stage-gate-probe.mjs` 被我改写成三道闸门的探针，main 上原来那支（舞台端口白名单）主会话已另存为 `stage-port-whitelist-probe.mjs`；验收清单要指对。

## 安卓真机测试的做法与预期（主会话做）

打开在线页面时在地址后加 `?gates=1`，右上角是只读查看口；也可以在远程调试里执行 `window.__pcGates()` 看同样的数据。

1. **内存不到 8 GB 的安卓手机（Chrome）**：打开项目 → 气泡「这台设备运行在精简模式：复杂的效果交给云端渲染」；查看口「档位」精简、「舞台闸门」目标 1、到达 1、「这次怎么走」android-memory、身份手机；只有一个舞台 iframe。
2. **8 GB 以上的安卓手机或平板**：从低往高试，正常到第三级「顶配模式」或第二级「标准模式」；查看口能看到每一步。
3. **崩溃路径**：在试的途中让页面被系统杀掉（例如同时开很多大页面压内存），1 分钟内点「重新加载」→ 停在下一级，查看口「上次崩没崩」是、崩在哪一步、崩的次数 1、护栏约 30 分钟；30 分钟内再开停在同一级不试。过了 1 分钟才点重新加载的，按全新打开（会再试）。
4. **舞台进程崩了页面还在**（安卓 Chrome 多数是独立进程）：只看到那个舞台重载；反复崩才退回单舞台，重新载入照常试，查看口不留崩溃记录。
5. **最低一档**：地址加 `?tier=low` 可强制看效果：播放时没有即时渲染（都是预渲染结果或占位），停下后逐层画出当前帧；气泡「这台设备运行在低配模式：播放时只显示已渲染好的画面」。
6. **素材闸门**：导入一段 4K 视频，查看口展开的完整记录里解码上限若低于 2160p，预览只用小尺寸；网速慢时（完整记录里各舞台报的网速低于 8 Mbps）先小后大。

## 真机核对清单（无头 Chrome 核不了的）

- [ ] iPhone Safari：页面进程被杀后自动重新载入一次；短时间内再崩改显示出错页（判崩逻辑依赖这一条）。
- [ ] iPad Safari：缺省报桌面声明、`maxTouchPoints > 1`；试后台舞台时崩 → 重新载入停在第一级、身份改判手机、用手机版界面。
- [ ] 安卓 Chrome：页面被系统杀后显示出错页、点「重新加载」后 `sessionStorage` 还在（无头里已核：同一个标签页崩了重新载入还在）。
- [ ] 安卓 Chrome 报的 `userAgentData.platform` 与 `deviceMemory`（不到 8 GB 的真机是不是报 4 或 6）。
- [ ] 舞台在安卓上是不是独立进程（舞台崩了页面还在）。
- [ ] 四档气泡的位置与停留时间在手机窄屏上是否合适。
- [ ] `mediaCapabilities.decodingInfo` 在真手机上给出的解码上限是否合理（与实际能播的分辨率对得上）。
- [ ] 资源计时在真手机上能不能看到 `<video>` 的分段请求（看不到就一直先小后大，不会出错）。

## 对任务书与语义的更正建议

1. 任务书第二步说在 `glossary.md` 删「预渲染任务」一条：术语表里「预渲染任务」是现行用词，撤销的只是「为弱设备补发的」那一类，建议任务书改成「删『低内存档』；『预渲染任务』保留」。
2. `product/platforms.md` 第 17 行「代码里的低内存档……都待按『在线浏览器』一节改掉」在本分支合入后已完成，建议主会话合入时删掉这一句（二级文档，不归我改）。
3. `guide_files/verification.md` 第 33 行「普通档浏览器探针」：「普通档」一词已不用，建议改成「在线页面的浏览器探针」。
4. `wait_to_judge_html/source/items/P-H.md`、`R.md` 里还有低内存档的说法（不归我改）。
5. `mechanism/platforms.md` 的「页面内快照库」还挂着「`snapshots`、`ranges` 两张表删表还是改存稀疏流，实现时定」，本任务没碰。
