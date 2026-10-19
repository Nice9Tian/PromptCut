# AGENT 报告：剪辑默认一条、进素材库、剪辑套剪辑、时间轴剪辑标签

分支 `claude/cut-nesting`，工作区 `.worktrees/cut-nesting`，基于 `37a9ca0a`（已合入 `claude/accept-018-fixes`）。
任务书 `docs/plan/cut-nesting-task.md`；审核意见 `docs/plan/cut-nesting-argon-review.md`（Gemini 4 Argon 审）。

## 状态

完成，等主会话审查。没有推送、没有合并。

## 用户原话

> 我发现开一个项目，剪辑默认有3个，这不符合预期——用户又没创建那么多，只留一个就行了。并且剪辑应该也出现在素材库中。用户可以拖动剪辑N到剪辑M的轨道中。也可以点击剪辑，随后下方激活剪辑轨道（失去焦点不要消失，一直保留，直到用户手动点'x"）。

## 验收逐条结论

| 验收条 | 结论 | 证据 |
|---|---|---|
| 新建项目只有「剪辑1」；旧项目剪辑数不变 | 过 | UI 探针 A1；`cuts.test.mjs`「已经带着三条剪辑的项目:原样保留」 |
| 素材库出现「剪辑」组，显示名称与时长 | 过 | A2，图 `ui-01` |
| 单击剪辑在时间轴上方开标签并激活 | 过 | A3，图 `ui-03` |
| 点别处、切面板、失去焦点标签都在 | 过 | A4（点预览、切左栏分区、失焦、点 AI 栏），图 `ui-04` |
| 「×」只关标签；最后一个关不掉 | 过 | A5、A5b，图 `ui-02` |
| 剪辑2 拖进剪辑1：出现剪辑段，预览画面正确 | 过 | A6，图 `ui-05`；预览探针 5 个跳转点与平铺等价物逐像素相同 |
| 剪辑段的声音正确 | 过 | 导出：声音探针 PASS（段前静音、淡入、电平与原素材差 < 0.01 dB、段后无声）；预览：声音层只在段的窗口里挂 `s1/a1` |
| 改剪辑2，剪辑1 跟着变 | 过 | A7，图 `ui-06` |
| 导出成片正确（逐帧看图） | 过 | 导出探针 A 240/240、D 180/180 逐字节；图 `export-*` |
| 拖剪辑1 进剪辑1、做 A→B→A 被拒并有说明 | 过 | A8，图 `ui-07-08`（落点标红，写「不能把剪辑「剪辑1」放进它自己」「剪辑「剪辑1」已经引用了「剪辑2」,再放进来会循环引用」） |
| 删除被引用的剪辑有说明与确认，可撤销 | 过 | A9，图 `ui-09`、`ui-10` |
| Agent 能列出、放置剪辑段；拒绝循环 | 过 | `src/mcp/handlers/cutSegments.test.mjs` 3 条；云端副本逐个跑开放工具 75 个无 HTTP（CA-TOOL-03） |
| 类型检查、全量测试 | 过 | 见下 |
| 导出确定性、快照重放、像素基线 | 过 | 见下 |
| 在线（visuhive.com/editor）实测 | **没做** | 不碰生产节点；待部署后由主会话按「部署要换什么」做 |

## 做了什么

### 1. 可行性探针与渲染路线（先做的）

三条路（实时预览的跨源隔离舞台、导出、预渲染）共用 `FrameScene` / `Stage`，所以选「**剪辑段当一张卡、包裹层里挂嵌套场景**」：`flattenOverlay` 把剪辑段交成 `cardId: "@cut"` 的时间轴片段，带被引用剪辑的子项目；`Stage` 给它一个普通卡片包裹层（框、不透明度、淡入淡出、层序、强调都照卡片），里面挂 `CutSegmentScene` → 嵌套 `FrameScene`，按 `cutOffset + (t − 段起点)` 渲被引用剪辑的整帧。预览、导出、预渲染、Agent 看画面走的是同一份代码，同一帧。

探针（`docs/reports/assets/cut-nesting/` 里的图；脚本在会话临时目录 `cut-probe.mjs`，用法同 `export-baseline-compare.mjs run`）：

| 用例 | 内容 | 结果 |
|---|---|---|
| A | 剪辑段恒等（起点 0、偏移 0）引用 demo 全部内容 | 240/240 帧与 demo 导出逐字节相同 |
| D | 起点 3、偏移 2（全预卷） | 段内 180/180 帧与 demo 第 60～239 帧逐字节相同，与「内容整体后移的平铺等价物」E 也 180/180 相同；段前 90 帧透明 |
| B | 起点 1、偏移 2（贴着开头，预卷只够 1 秒） | 174/180 相同；前 6 帧（0.2 秒）不同，是预卷截到段起点的已知近似 |
| C | 缩放 0.6、旋转 8°、不透明度 0.8、淡入 0.5 | 看图：段前透明，时间码与 τ 对得上（`export-C-*.png`） |

预览：无头 Chrome 打开编辑台，载入剪辑段项目 D 与平铺等价物 E，在 3.5、4、5、6.5、8 秒跳转后截预览，五张逐像素相同（`preview-seg-vs-flat.png`）。第一次跑时跳转后剪辑段停在错误状态——原因是剪辑段没有成本记录、不进分派表，舞台不追帧；改为把「此刻挂着、要按历史推进的剪辑段」并进「整场景后台补跑后互换」那一路（`stageSwap.ts` 的 `statefulSegmentsAt`）后相同。

路线写进 `mechanism/rendering.md`「剪辑段」。

### 2. 数据模型（`src/kernel/`）

- `cutSegments.ts`（新）：剪辑段判断、剪辑内容、引用图、任意深度防环与原因、协作成环与悬空引用兜底（路径上已有、找不到、超过 32 层 → 该段返回空，不抛）、删除时连带剪辑段与转场、渲染子项目（按 `cuts` 引用记忆化）、预卷、推帧口径（查注册表）。
- `cutAudio.mjs`（新，纯 JS，服务端可直接 import）：包络 `envelopeAt`、声音派生项目 `audioProjectOf`（平移、裁窗、源时钟后移、音量相乘、静音传递、每层包络）。
- `cutIdentity.mjs`（新，纯 JS）：激活剪辑能走到的剪辑内容、能走到的素材。
- `cuts.ts`：`DEFAULT_CUT_COUNT = 1`；`listCuts` 带 `referencedBy` / `references`；`removeCut` 连带删剪辑段并回 `removedSegments`；`placeCutSegment`。
- `project.ts`：`TrackClip` 加 `cutId`、`cutOffset`（落盘）与 `cutEnv`、`cutOrigin`（只在派生项目上）；`opacityAt` 乘包络；`flattenOverlay` 交出剪辑段。
- `audioPlan.mjs`：先展开、条目带 `env`；`gainCurve`、`needsGainCurve`。
- `cardAudioRendition.mjs`：`clipHasAudio` 对剪辑段为真（可独立静音、调音量）。

### 3. 渲染、身份、混音

- `src/render/CutSegmentScene.tsx`（新）、`Stage.tsx`、`FrameScene.tsx`：嵌套场景；嵌套层挂 `data-pc-nested-clip`、不挂 `data-pc-track` / `data-pc-native-layer`；预卷期间不透明度 0、不接点击；宿主素材变体经 `SceneHostContext` 传下去。
- 身份只在有剪辑段时加进：`changedClips.mjs` 的 `projectHash`、`frameClient.ts` 的快照签名、`server/frame-identity.mjs` 的 `frameIdentity`；`trackPrefixes` 的素材子集、`frame-stream.mjs` 的 `hasMedia`、`mediaTier.ts` 的导出原尺寸拦截都算被引用剪辑里的素材。没有剪辑段的项目一个字节不变（像素基线、确定性见下）。
- 混音：`server/bakery/mux-audio.mjs`（每层包络各一条 afade）、`server/bakery/audio-mix.mjs` 与 `src/export/browserExport.ts`（带 `env`）、`src/audio/renderMix.ts`（`gainCurve`）、`src/editor/preview/MediaLayers.tsx`（预览声音走派生项目）。

### 4. 界面

- 时间轴上方剪辑标签栏（`src/editor/timeline/CutTabs.tsx` 重写为 `CutTabBar`、`cutTabsState.ts`、`cut-tabs.css`）：单击切换、双击改名、× 只关标签、最后一个无 ×、`+` 新建并打开；按项目 id 存本地，激活的自动补、删掉的自动拿掉。
- 素材库「剪辑」组（`src/editor/left/library/cutsGroup.tsx`）：名称、时长、段数、被引用数；单击打开；拖到序列放剪辑段；悬停按钮与右键改名、删除（被引用时确认框写明被哪些剪辑用着，可撤销；最后一条不能删）；组详情顶上「新建剪辑」。
- 拖放：`dnd.ts` 加 `MIME_CUT`；`dropPlan.ts` 对循环引用标红写原因；`useDropTarget.ts` 落剪辑段。
- 时间轴剪辑段（`ClipView.tsx`）：标签跟被引用剪辑现在的名字、胶片齿孔样式、双击与右键「打开剪辑」、被引用剪辑变短时超出部分斜线。
- 撤掉左侧竖栏剪辑组（`RailBar.tsx`、`railLayout.ts`：老布局里残留的那一项读进来就丢）。

### 5. store

`src/store/actions/cuts.ts`：`addCutSegment`、`setCutSegment`、`cutReferences`、`cutCycleReason`，`removeCut` 回 `removedSegments`。`clips.ts`：剪辑段修头偏移跟着走、出点不超出被引用剪辑剩下的长度（已超出的不自动裁）、切分后半段偏移累加。

### 6. Agent 工具

- `server/tools/cuts.mjs`：`list_cuts` 描述去掉「默认三条」、说明 `referencedBy` / `references`；`remove_cut` 说明被引用时要 `force` + `reason`；新增 `add_cut_segment`、`set_cut_segment`。
- `src/mcp/handlers/cutSegments.ts`（新）、`effects.ts`（`remove_cut` 门槛与 `removedSegments`）、`clips.ts`（`get_clip` 带 `cutSegment`）。
- 两个新工具借 `addClip` / `updateClip` 的方法名路由（`src/mcp/routes.mjs`）：`EditorApi` 类型在 `src/ai/mcpExecutor.ts`，属另一位子 Agent 的范围，本任务没改它。
- `server/ai-system-prompt.md` 讲剪辑的那一行：新项目只有剪辑1、剪辑段、引用关系、删被引用剪辑要 force。
- `server/agent/service/cloud-tools.mjs`：两个新工具登记为在副本上执行（见「越界」）。

### 7. 语义文档

按任务书的修改后写入，补 Argon 指出的漏改，标「2026-10-20 用户定」与〔裁：Argon 审 2026-10-20〕：`product/project-model.md`、`workflow/materials.md`、`workflow/editing.md`、`glossary.md`；新建 `mechanism/project-model.md`（存法、防环、删除连带、标签存法、身份）；`mechanism/rendering.md` 加「剪辑段」节。

## 文件清单（相对 `37a9ca0a`）

新增：`src/kernel/cutSegments.ts`、`cutAudio.mjs`(+`.d.mts`)、`cutIdentity.mjs`(+`.d.mts`)、`src/render/CutSegmentScene.tsx`、`src/editor/timeline/cutTabsState.ts`、`src/editor/left/library/cutsGroup.tsx`、`src/mcp/handlers/cutSegments.ts`、`docs/semantics/mechanism/project-model.md`、测试 `src/kernel/cutSegments.test.mjs`、`src/store/actions/cutSegments.test.mjs`、`src/editor/timeline/cutTabsState.test.mjs`、`src/mcp/handlers/cutSegments.test.mjs`、`server/test/cut-segment-audio.test.mjs`、探针 `scripts/probes/cut-nesting-ui-probe.mjs`、`scripts/probes/cut-segment-audio-probe.mjs`。

修改：`src/kernel/{cuts.ts,project.ts,audioPlan.mjs,audioPlan.d.mts,cardAudioRendition.mjs}`、`src/render/{Stage.tsx,FrameScene.tsx,changedClips.mjs,frameClient.ts,mediaTier.ts}`、`src/export/browserExport.ts`、`src/store/actions/{cuts.ts,clips.ts}`、`src/editor/{dnd.ts,stageSwap.ts}`、`src/editor/dock/{RailBar.tsx,railLayout.ts}`、`src/editor/left/{LibrarySection.tsx,library/groups.tsx}`、`src/editor/timeline/{CutTabs.tsx,cut-tabs.css,ClipView.tsx,dropPlan.ts,useDropTarget.ts,index.tsx}`、`src/editor/preview/MediaLayers.tsx`、`src/audio/renderMix.ts`、`src/mcp/{routes.mjs,handlers/clips.ts,handlers/effects.ts}`、`server/{frame-identity.mjs,frame-stream.mjs,ai-system-prompt.md}`、`server/bakery/{mux-audio.mjs,audio-mix.mjs}`、`server/tools/cuts.mjs`、`server/agent/service/cloud-tools.mjs`；测试 `src/kernel/cuts.test.mjs`、`src/render/changedClips.test.mjs`、`src/editor/dock/railLayout.test.mjs`、`server/test/cloud-agent-service.test.mjs`、`server/test/cloud-agent-runs.test.mjs`；语义 `docs/semantics/{product/project-model.md,workflow/materials.md,workflow/editing.md,glossary.md,mechanism/rendering.md}`。

## 越界（不在给定清单里、动了的文件）

都是最小改动，理由如下，请主会话审：

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `src/editor/stageSwap.ts` | `statefulSegmentsAt` 并进两处补跑目标 | 不加，预览跳转后剪辑段停在错误状态（违反「停下就精确」），见第 1 节 |
| `src/editor/preview/MediaLayers.tsx` | 只出声音时走 `audioProjectOf` | 预览里剪辑段的声音 |
| `src/audio/renderMix.ts` | 增益曲线换成 `gainCurve` | 导出的 Chrome 离线混音带上剪辑段包络 |
| `server/agent/service/cloud-tools.mjs` | 两个新工具各一行 `{ mode: R }` | 守门测试要求每个工具都在云端工具表归类；不是看画面那条链路 |
| `scripts/probes/*`（两个新探针） | 新增 | 验收证据 |

没碰：`src/ai/**`、`src/editor/right/**`、`server/harness/**`、`server/runners/**`、系统提示词的汇报段落、看画面链路。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`(命令里设两个 VisuHive 变量) | 最终一轮(提交 `391cc7d6` 上)7160 条:7146 过、0 败、0 取消,「零失败」,退出码 0。前两轮暴露的问题(卡片声音源码闭包、cards.test、云端工具归类与计数、探针 import 顺序)都已修掉 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url <剪辑段项目 D>` | 270/270 相同，退出码 0 |
| 导出确定性（缺省 demo） | `node scripts/verify-determinism.mjs --url http://127.0.0.1:5350/?export=1` | 1800/1800 相同，退出码 0 |
| 快照重放一致 | `baseline-driver.mjs --mode unified --port 5356` | PASS，退出码 0 |
| 与开工前的导出像素比对 | `bash .worktrees/_export-baseline/check.sh <本树> cut-nesting 5356` | 对 89c15177 第二种结果 240/240 逐字节相同，PASS |
| 剪辑段导出逐帧 | 会话临时目录 `cut-probe.mjs` | A 240/240、D 180/180、D 对 E 180/180；B 174/180（已知近似） |
| 剪辑段预览 | 会话临时目录 `preview-probe.mjs`（无头 Chrome） | 5 个跳转点与平铺等价物逐像素相同 |
| 界面验收 | `node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5350` | A1～A9 全过，页面零报错 |
| 声音端到端 | `node scripts/probes/cut-segment-audio-probe.mjs --port 5356` | 缺省与 `--audio ffmpeg` 两遍都 PASS：段前 −200 dB、2～2.5 秒 −34.9 dB、3～3.5 秒 −24.09 dB、3.5～6.9 秒 −24.09 dB（原素材 −24.08 dB）、7 秒后无声音样本 |
| 新增单测 | `cutSegments`(12)、`cuts`(12)、store(4)、标签(3)、Agent(3)、混音(2)、`changedClips`(+1) | 全过 |

看过的图：`docs/reports/assets/cut-nesting/` 下 13 张（界面 9、预览 1、导出 3）。

dev server：本树 5350（+5351/5352 舞台）与探针用的 5356（+5357/5358）。5353～5355 里 5354 被一个不是本会话起的进程占着，没碰。

## 没做成的与原因

1. **在线（visuhive.com/editor）实测**：要部署到生产节点，任务规定不碰；留给主会话部署后做。
2. **剪辑段与里面的卡不测量、不判重、不产轨道流**：一律在舞台里活渲。内容很重时预览播放会按「慢帧就等」变慢，画面不错；剪辑段里的卡没有自己的占位符。写进 `mechanism/rendering.md`〔裁〕。
3. **预卷贴着时间轴开头不够时的近似**：段起点小于需要的预卷时截到 0，被截掉历史的那几张按状态推进的卡开头约 0.2 秒和单独渲染不同（用例 B 6 帧）。
4. **被引用剪辑里的有声动效卡**：声音产物要在被引用剪辑里先生成；导出前的自动生成（`src/editor/io/exportSounds.ts`，不在清单里）不进剪辑段，缺了就照「导出不得悄悄省略声音」失败并指出片段。
5. **只渲卡片层的兼容旁路**（显式 `--media=ffmpeg`）：剪辑段里的视频与图片不经 ffmpeg 合成。缺省路线不受影响。
6. **剪辑段的属性面板**（右栏 `src/editor/right/**`，另一位子 Agent 的范围）：没改。剪辑段的不透明度、淡入淡出、框目前靠时间轴拖动、Agent 工具；音量与静音靠时间轴右键。
7. **Chrome 离线混音带包络**（有音频效果时才走的那条）只有单测（`gainCurve`），声音端到端探针两遍实际都走了 ffmpeg 混音。
8. 剪辑段的组不透明度与逐层不透明度：嵌套场景整块合成后再乘段的不透明度（组不透明度），和「逐层相乘」不同，是选定的口径。

## 对任务书或语义的更正建议

- 任务书三级第 1 条写「离屏合成后再贴」：实际是「同一个舞台里的嵌套场景整块合成」，不是离屏位图（跨源舞台里每拍栅格化做不到 30 fps）。已按实际写进 `mechanism/rendering.md`。
- 任务书「打开的剪辑标签列表是本机界面状态」原放三级：按 Argon 拆成一级一句（`workflow/editing.md`：不同步给别的成员）＋三级存法（`mechanism/project-model.md`）。
- `docs/semantics/developer_guide.md` 的「按任务读哪些语义」表，「项目数据、时间轴」一行可以加「改实现再读 `mechanism/project-model.md`」（不在本任务清单里，没改）。
- `EditorApi`（`src/ai/mcpExecutor.ts`）建议由主会话加上 `addCutSegment` / `setCutSegment` 两个方法，路由表改成直连（现在借 `addClip` / `updateClip` 的方法名，靠参数分支）。

## 〔裁〕清单

〔裁〕= 执行中按「对齐」一节自己定、用户合入前要审的决定。

| # | 级 | 内容 | 写在 |
|---|---|---|---|
| 1 | 二 | 「任意深度」防环 | `product/project-model.md`「剪辑」 |
| 2 | 二 | 协作成环与悬空引用：那一段不画、不出声，不白屏 | 同上 |
| 3 | 二 | 最后一条剪辑不能删（代码原已如此） | 同上 |
| 4 | 二 | 序列：卡片段、素材段和剪辑段 | 「序列」 |
| 5 | 二 | 剪辑段：独立静音、参与转场、切分复制；不挂滤镜、像素映射、音频效果；被引用剪辑变短时起止不动、超出部分透明无声 | 「片段」 |
| 6 | 一 | 素材库里新建、改名、删除剪辑 | `workflow/materials.md` |
| 7 | 一 | 撤掉竖栏剪辑组；双击剪辑段打开；剪辑删掉时标签自动消失 | `workflow/editing.md` |
| 8 | 一 | 标签是本机界面状态，不同步 | 同上 |
| 9 | 三 | 存法、防环算法、删除连带、标签存法、身份 | `mechanism/project-model.md` |
| 10 | 三 | 嵌套场景路线、预卷、推帧口径、后台补跑、不测量不产流、声音平移展开、兼容旁路 | `mechanism/rendering.md`「剪辑段」 |
| 11 | 三 | 剪辑段不透明度按组不透明度（整帧合成后乘） | 同上 |

二级〔裁〕1～5 都来自 Argon 审核意见、按主会话「采纳 Argon 的意见」执行，所以没有另行播报。

## 部署要换什么

- **在线前端重建并换静态页**（`/opt/promptcut-hosted/editor`）：编辑台、舞台、导出页的代码都改了。
- **托管服务的服务端文件**（Agent 服务与文档服务所在的 `promptcut-hosted`）：`server/tools/cuts.mjs`、`server/ai-system-prompt.md`、`server/agent/service/cloud-tools.mjs`，以及它们在副本上执行时加载的 `src/mcp/**`、`src/kernel/**`、`src/store/**`（含新文件 `src/kernel/cutSegments.ts`、`cutAudio.mjs`、`cutIdentity.mjs`）。需要重启 Agent 服务进程。
- **渲染服务**（托管渲染与预渲染进程）要换：`server/frame-identity.mjs`、`server/frame-stream.mjs`、`server/bakery/mux-audio.mjs`、`server/bakery/audio-mix.mjs` 与它们 import 的 `src/kernel/cutIdentity.mjs`、`cutAudio.mjs`、`audioPlan.mjs`；导出页是同一份前端构建。没有剪辑段的项目帧身份不变，旧缓存照用。
- **桌面版**：随 0.7.18 补丁一起出（前端与 `server/` 都在补丁里）。
- 文档服务本身、素材服务不用换（剪辑段只是项目里的普通字段）。

## 回滚

- 代码：不合这条分支，或在 main 上 `git revert -m 1 <合并提交>`。
- 数据：已经放进剪辑段的项目，在旧版本里剪辑段只是不画、不出声，字段原样保留，不丢数据；默认一条只影响新建项目。
- 标签状态在浏览器本地存储 `pc.cutTabs.v1:<项目 id>`，旧版本不读它，不用清。

## 分支提交

见 `git log 37a9ca0a..claude/cut-nesting`；最新提交号在主会话回执里。
