# AGENT 报告：claude/clip-speed

任务：前置项里的「速度」入口（`docs/plan/three-versions-progress.md`「『速度』入口」一条）。给视频段加面向用户的片段速度 `TrackClip.speed`（缺省 1），各处时间换算改调同一个纯函数；变速段原声第一版自动静音并在界面写明；手机版加「速度」入口，桌面编辑分区也加。

- worktree：`.worktrees/clip-speed`，分支 `claude/clip-speed`，从 main `5a8f375a` 切。端口段 5920～5939（实际用了 5920、5923、5926、5929、5930～5937）。
- 做完**没有**合入 main、没有推送，等用户审〔裁〕。
- 「〔裁〕」指会话在执行中自己定、要用户在合入前审的决定；本报告里新出的〔裁〕都标「clip-speed 2026-10-23」。

## 结论

- **做通了**：画面（导出、预渲染、舞台、Agent 看画面、导出兼容旁路、剪辑段里、套了素材效果卡的视频段）按「素材时刻 = mediaOffset + (t − start) × speed」取帧，逐帧比对 480/480；声音按〔裁〕变速的视频段不出原声；音画分离出来的变速声音段随倍率变调，两条导出混音路（Chrome 离线混音、ffmpeg）实测对得上（见「返工记录」）；手机版与桌面都有入口，能手动输入倍率，界面写明。
- **像素基线没有变**：与开工提交 `5f4523d0` 的全长导出逐字节相同 1800/1800。
- **身份键缺省 1 逐字不变**：固定样例在开工提交与当前工作区上 57/57 项逐字相同（帧身份、轨道前缀、镜像哈希、层表输入签名、卡片计划的六个键与其余字段、混音清单、取帧时刻、导出兼容旁路参数）。
- **一处任务书没写到的硬约束**：素材节点的倍率原打算写进 `src/kernel/cardGraph.mjs` 的 `projectCardGraph`，全量测试捞出它在**三张内置有声卡的源码导入闭包**里（守门 `src/render/audioCardSourceVersion.test.mjs`），改一个字就会让用户已生成的卡片声音全部判「已过期」。已还原 `cardGraph.mjs`（与 main 逐字相同），改由新函数 `withMediaRates` 在出画面、出键的五处补倍率。

## 返工记录（2026-10-23，用户审〔裁〕之后）

用户逐条审了〔裁〕，这一轮按用户的话改了三处，加上前一条消息里的让位规则（见「用户定的推开规则」）。这几条都是**用户定的，不是〔裁〕**。

### 1. 速度范围认可，另加手动输入

- 桌面编辑分区「速度」一栏：下拉九档旁边加一个数字框（回车或失焦提交）；手机速度面板加「自定义倍率」输入框和「应用」按钮。可带小数，取到 0.01 倍（输入 1.333 存 1.33，界面显示的就是实际值）。
- **超出 0.25～4 拒绝并提示**「速度要在 0.25～4 倍之间」，项目一点不改。不选「夹到边界」：输入 9 倍悄悄变成 4 倍，用户以为是 9 倍，这种悄悄改值正是这次反复要避免的。`store.setClipSpeed` 里判（`clipTime.mjs` 的 `speedInRange`），两个界面共用。

### 2. 挂着转场的段可以改速度（「可以改」「气泡提示即可」）

规则（`store.setClipSpeed`）：

- 淡入、淡出、交叉溶解的淡化都写在片段两端（`fadeIn` / `fadeOut` 相对片段），跟着片段两端走，时长不变。
- 这一段是交叉溶解的**前一段**：后一段（在另一条序列上）跟着这一段的终点平移同样多，溶解的重叠长度不变（变长往后挪、变短往前挪）；后一段所在序列上它后面的段按让位规则推开；往前挪撞上那条序列上前面的段就整个不改并说明。
- 这一段是交叉溶解的**后一段**：起点不动、前一段不动、重叠不变。
- **装不下转场时转场跟着缩短**：这一段身上不比新长度短的转场缩到「新长度 − 0.01 秒」（取到 0.01 秒，不短于 0.1 秒；和加转场时「转场要比片段短」同一条规矩）。交叉溶解缩短时两头的淡化一起改；这一段是后一段时，靠这一段整体往后挪「缩掉的那么多」让重叠变短（入点内容不变）。连 0.1 秒的转场都装不下才拒绝。
- **气泡**：结果里带上每条转场从几秒缩到几秒，手机版弹 toast 气泡，桌面在编辑分区「速度」一栏下面的状态行显示同一句（桌面没有全局气泡组件）。措辞（`clipTime.mjs` 的 `speedChangeNotes`）例：「已改成 4×，这一段不出原声；淡出跟着缩短：2.50 秒 → 1.49 秒（这一段变短，原来的转场装不下）」；交叉溶解的另一段跟着挪时加「交叉溶解的另一段跟着挪了」；这一段为缩溶解往后挪时加「为了缩短交叉溶解，这一段整体往后挪了（内容不变）」。
- 撤销一步全退回（速度、挪动、转场时长、两头淡化），单测核了。

### 3. 变速段可以音画分离；分出来的声音随倍率变调

- **数据**：音画分离照旧把视频段标成片段静音（`audioMuted: true`），另起一条声音序列放分出来的声音段（素材 `kind: "audio"`、和视频共用同一个文件）；变速时声音段**带上同样的 `speed`**。转换为声音同理放开。
- **「变速段原声静音」这条不变**，只是把对象说准了：`speedMutesSource(clip, project)` 只对**视频**素材段成立；**声音段**（素材是 audio）变速时照常出声、随倍率变调。所以同一个画面上：
  - 视频段：没分离时时间轴标「已静音」，说明「已变速 2×，变速段不出原声」；分离之后是「片段已静音」（和普通视频分离后一样）。编辑分区说明「变速后这一段视频不出原声（第一版不做变速声音）；要听声音可以音画分离，分出来的声音跟着变速、会变调。改回 1× 恢复。」
  - 声音段：在单独的声音序列上，名字后带「· 2×」，没有静音标记；编辑分区说明「声音段变速后跟着变调（第一版不做保调变速）。」
- **两条混音路怎么对齐**：选**变调**（varispeed），不选保调（`atempo`）。理由：预览的 `<audio>` 用 `playbackRate`、在线浏览器导出没有 ffmpeg，这两处都只有变调能做；保调在浏览器离线混音里没有现成算法，两边会不一致。具体：
  - 桌面导出：`server/bakery/mux-audio.mjs` 的 `playableAudioPlan` 先用 ffmpeg 把变速声音段做成一段时间轴长度的 wav（读 `时长 × 速度` 秒素材，滤镜 `aresample=48000,asetrate=48000×速度,aresample=48000`），**Chrome 离线混音的裁段与 ffmpeg 混音都从这同一份 wav 起**。不改 `audio-mix.mjs`：它和 `export.mjs` 等七个模块进共享快照键的代码指纹（`server/frame-code.mjs` 的 `SNAPSHOT_FILES`），改了会让所有片段的 contentKey / snapshotKey 都变（返工中途实测过：键比对 45/57，改回后 57/57）。
  - 预览：`MediaLayers.tsx` 的声音层 `playbackRate = 速度`、`preservesPitch = false`。
  - 在线浏览器导出：`browserExport.ts` 用 `resampleVarispeed`（按速度步进线性插值，同一语义；插值算法和 ffmpeg 的 swr 不同）。**没有实测**——仓库没有在线浏览器导出带声音的探针。
  - 测响度（本机 `audio-measure.mjs`、云端 `hosted-audio-js.mjs`）用同一个 ffmpeg 滤镜（`audio-measure.mjs` 会被 Agent 服务进程载，不许 import `src/`，照抄了一份并注明出处）。
- **实测**（`clip-speed-export-probe.mjs`，B、C 两段的视频静音、各有一段同速度的分离声音段；440 Hz 的素材声音）：见下「验证」里「声音」表。
- **更正**：前两轮报告里写的「两条导出混音路都实测无声」，那两次其实**都走了 ffmpeg**：探针用 `data:` 地址带项目，Chrome 混音找不到 `/@export/<id>/project.json`，日志里是「Chrome 混音失败，退回 ffmpeg 直接混」。这一轮探针改成按产品导出的摆法放 `export-<id>/project.json`，并核对日志确认 Chrome 那一次真在 Chrome 里混（`mixedIn: chrome`）。静音的结论不变，但证据换成了这一轮的。
- **语音转文字**：转写挂在素材上，转的是原素材（1 倍）的声音，没有变；铺字幕时按片段速度把文字时间戳换到时间轴（`captions.ts` 的 `timelineTimeAt`，第一轮就改了）。分出来的声音素材继承视频的转写，在它的变速声音段上铺字幕同样按速度换算。单测：素材第 8 秒、起点 4、2 倍 → 时间轴 10 + (8 − 4)/2 = 12，句长除以 2。
- **请你记进 `TODO.md` 的待办**：分出来的声音随倍率变调（2× 高八度、0.5× 低八度），第一版不做保调。以后要做保调变速，ffmpeg（`atempo`）、Chrome 离线混音、在线浏览器导出、预览四处都要有结果一致的实现，否则破「导出与预览一致」。
- 仍拒绝的一处：变速的**视频段**当音频素材效果卡的声音输入（用户没提，原声不出这条的推论，没动）。

### 4. 桌面入口：批准，不变

### 开工提交上的「新元素第一帧取到第 0 帧」

开工提交 `5a8f375a` 上同一份变速项目共跑了 4 遍（`out/speed/export-base`、`r2/export-base-1`、`r2/export-base-2`、`r3/export-base`），按 1 倍算的取帧每遍 360/360 全对，**一次都没复现**；当前代码完整跑了 7 遍，复现 1 次（第 1 遍）。**确认不了**它在开工提交上同样出现，维持原来的判断（同一个 seek 目标、同一种新挂元素时机，怀疑是原有竞态），没有更多证据。

## 那个纯函数

`src/kernel/clipTime.mjs`（纯 JS，服务端直接 import；类型在 `clipTime.d.mts`）：

```js
export function clipSpeed(clip)            // 没有字段、不是有限正数 → 1
export function mediaTimeAt(clip, t)       // (clip.mediaOffset ?? 0) + (t - clip.start) * clipSpeed(clip)
export function timelineTimeAt(clip, m)    // clip.start + (m - (clip.mediaOffset ?? 0)) / clipSpeed(clip)
export function mediaOffsetAfter(clip, dt) // (clip.mediaOffset ?? 0) + dt * clipSpeed(clip)   切分后半段、剪辑段截掉的一截
export function mediaSpanOf(clip, dur)     // dur * clipSpeed(clip)                              这段用掉多少秒素材
export function timelineSpanOf(clip, md)   // md / clipSpeed(clip)
export function speedMutesSource(clip)     // !!clip.mediaId && clipSpeed(clip) !== 1           〔裁〕变速段不出原声
export function speedKeyPart(clip)         // 速度不是 1 → { speed },是 1 → null               按字段进键的地方用
export function withSpeed(clip, speed)     // 换速度的新对象;speed 为 1 时删掉字段
export function withMediaRates(project, graph) // 卡片图里变速段的素材节点补 rate;没有变速段回同一个对象
export function normalizeSpeed(v)          // 夹到 [0.25, 4]、取到 0.01;不是正数 → null
```

缺省 1 为什么逐位不变：IEEE 754 里 `x * 1 === x`、`x / 1 === x`，所以 `off + (t − start) × 1` 与原来的 `off + (t − start)` 逐位相同（单测随机 2 万组 `Object.is` 全等）。唯一的例外是导出取帧的 `FrameScene.tsx`，原式是 `(off + t) − start`（结合顺序不同，浮点可能差最后一位），所以那里速度为 1 时保留原式（`exportMediaTime`），只有变速时才走 `mediaTimeAt`。

## 身份键怎么处理缺省 1

- **整份序列进哈希的三处**（帧服务的帧身份 `server/frame-identity.mjs`、镜像的项目哈希 `render/changedClips.mjs`、快照签名 `render/frameClient.ts`）：代码一行没改。片段对象上多了 `speed` 键自然就变；缺省 1 时店里**从不写 `speed: 1`**（`setClipSpeed(…, 1)` 删字段，单测钉住 `'speed' in clip === false`），所以不变。
- **按字段挑着进键的两处**：
  - 层表输入签名 `render/layerInputSig.mjs`：`...speedKeyPart(clip)`，只在不是 1 时加 `speed`；显式写了 `speed: 1` 也按缺省（单测钉住签名等于开工提交上的值）。
  - 卡片图的素材节点（共享快照内容键、结果键、单卡流成员键都从它算）：`withMediaRates` 只给变速段的 `@clip/<id>/source` 节点加 `rate`；没有变速段时返回同一个对象。调用处：`ExportView.tsx`（渲染用的图、`__pcCardPlan` 的两条路）、`StageView.tsx`、`render/CutSegmentScene.tsx`、`editor/browserNodeHost.ts`（在线页面的卡片计划，与导出页同一份）。
- **怎么验证「缺省 1 逐字不变」**（两层）：
  1. 单测 `server/test/clip-speed.test.mjs` 第一条：固定样例的帧身份、三个轨道前缀、镜像哈希、四个片段的输入签名、素材效果卡的上游键，与**在开工提交 `5a8f375a` 上用同一份样例算出的固定值**（`out/speed/golden.mjs` 在 `out/base-5a8f375a` 和 `out/base-5f4523d0` 上各算一遍，两边相同）逐字相等。
  2. 探针 `scripts/probes/clip-speed-key-compare.mjs --base 5a8f375a`：样例项目（视频段、带裁剪起点的视频段、接视频的素材效果卡、交叉溶解、剪辑段里的视频、音频段、卡片）在开工提交与当前工作区各算一遍，**57/57 项逐字相同**；再把两段改成 2× 和 0.5×，当前工作区里 12 项该变的都变了、没碰的片段 34 项不变；而开工提交上**有 6 项改了速度却没变**（`sig v-fx`、`sig seg~b1`、`plan v-fx.contentKey`、`plan v-fx.streamMemberKey`、取帧时刻、ffmpeg 参数）——这就是「漏加 speed 会命中旧快照、画面错了不报错」的情形，现在堵上了。输出原文见下「验证」。

## 声音：静音怎么做、界面怎么写明

〔裁〕已定：第一版变速段原声自动静音，不做变调或保调变速（我没有改它，也认为它对，理由见末节）。

- 判断只有一条 `speedMutesSource`，用在：导出混音清单 `kernel/audioPlan.mjs`（Chrome 离线混音 `renderMix.ts`、在线浏览器导出 `browserExport.ts`、ffmpeg 混音 `mux-audio.mjs` 都吃这一份）、`mux-audio.mjs` 的音频素材效果卡那一路、预览的声音层 `MediaLayers.tsx`、`kernel/project.ts` 的 `audioClipsAt`、`audio/cardAudio.ts`（`shouldMuteNativeAudio`、`generatedCardAudioClipsAt`、导出前的卡片声音核对）、云端测响度 `hosted-audio-js.mjs`（时间轴那一档跳过变速段）。
- 连带：变速的视频段不能当音频素材效果卡的声音输入（`render/cards/audioSources.ts`，和原有「边上 rate ≠ 1 不支持」同一个报法；用户这次只放开了音画分离，这一条没动）。~~不能音画分离、不能转换为声音~~——返工时已放开，见「返工记录」第 3 条。
- 界面写明（同一句话 `SPEED_MUTE_NOTE`：「变速后这一段不出原声（第一版不做变速声音）；改回 1× 恢复。」）：
  - 手机版「速度」面板的说明框；调整面板里变速段的音量一栏上方；完整时间轴上这一段标「2× 无原声」（静音图标）；缩略卡时长后带「2×」和静音图标。
  - 桌面编辑分区「速度」一栏下的说明；时间轴片段名后带「· 2×」；时间轴的静音标记（`ClipMuteBadge`）出现，说明是「已变速 2×，变速段不出原声」。

## 入口

- **手机版**：时间轴分页选中视频段，子导航栏是「引用、分割、复制、静音、**速度**、调整、删除」，顺序照演示稿 `prototypes/mobile-ui-demo/index.html` 的 `toolsFor`（演示稿里就有「速度」一项，只是「演示未做」；图标也取自演示稿）。点开是速度面板：0.25×～4× 九档，当前一档高亮，写明不出原声，撤销按钮。
- **桌面**：给了，理由——语义 `product/project-model.md` 的素材段属性是两个平台共有的业务层能力，`workflow/editing.md` 写手机版「交互以演示稿为准」，没有说手机独有；mobile-entries 那次调研的结论也是「手机版不先发明业务层没有的东西」。所以速度进业务层（`store.setClipSpeed`），两个平台都接：桌面在编辑分区视频段的「速度」一栏（下拉九档）。套了素材效果卡的视频段（片段同时带 `cardId` 和 `mediaId`）桌面走卡片那一支面板，同样显示这一栏。
- **Agent**：时间轴一览（`mcp/tools/toolEcho.ts` 的 `timelineDigest`）里变速段带 `speed`，看得到；**没有**给改速度的工具（要改 `product/agent.md`，待用户定，见末节）。

## 做了什么（逐文件）

`grep -rln mediaOffset` 在 `src/`、`server/` 下实际是 39 个非测试文件（任务书写 38）。逐个处理：

| 文件 | 改了什么 |
|---|---|
| `src/kernel/clipTime.mjs`、`.d.mts` | 新增，见上 |
| `src/kernel/project.ts` | `TrackClip.speed?` 与注释；`audioClipsAt` 跳过变速段 |
| `src/kernel/audioPlan.mjs` | 变速段不进混音清单 |
| `src/kernel/captions.ts` | 素材秒 → 时间轴秒用 `timelineTimeAt`，句长除以速度 |
| `src/kernel/cutFlatten.mjs` | 剪辑段摊平：截掉的一截按速度推进素材起点 |
| `src/kernel/cutAudio.mjs` | 同上（声音展开那一份，口径一致） |
| `src/kernel/motion.ts` | 跟随轨迹：起点帧按速度换算，覆盖长度乘速度，存的步长除以速度 |
| `src/kernel/cardGraph.mjs` | **不改**（有声卡源码闭包），改由 `withMediaRates` |
| `src/render/FrameScene.tsx` | 导出取帧时刻 `exportMediaTime`；像素映射素材的预览速率 |
| `src/render/VideoTrack.tsx` | 槽位带速度、素材区间按速度、播放速率以速度为基准、换档对齐按速度外推 |
| `src/render/mediaSync.ts` | `planSync` 加 `baseRate`（缺省 1，原来写死 1 的地方都换成它）；`SlotClip.speed`；`frontTimeAtDisplay` 加 `rate` |
| `src/render/mediaDrive.ts` | `targetTimeOf` 调 `mediaTimeAt`；`Want.rate` 传给 `planSync` |
| `src/render/layerInputSig.mjs` | `speedKeyPart` |
| `src/render/cards/GraphCard.tsx` | 素材节点取帧时刻 = 时间 × `rate` + offset（没有 rate 不乘） |
| `src/render/cards/audioSources.ts` | 变速段不能当声音输入 |
| `src/render/CutSegmentScene.tsx`、`src/StageView.tsx`、`src/ExportView.tsx`、`src/editor/browserNodeHost.ts` | 图后接 `withMediaRates` |
| `src/audio/cardAudio.ts` | 三处跳过变速段 |
| `src/editor/preview/MediaLayers.tsx` | 视频的声音层跳过变速段 |
| `src/editor/left/CaptionsTab.tsx` | `timelineTimeAt` |
| `src/editor/left/ClipSpeedForm.tsx`（新）、`Inspector.tsx` | 桌面「速度」一栏 |
| `src/editor/timeline/AudioWaveform.tsx`、`ShotMarkers.tsx` | 波形取的素材区间、镜头标记位置按速度 |
| `src/editor/timeline/ClipView.tsx`、`ClipMuteBadge.tsx` | 名字带倍数；静音标记写明原因 |
| `src/editor/sync/mergeItems.ts` | 冲突合并里属性名「速度」 |
| `src/store/actions/clips.ts` | 新增 `setClipSpeed`；切分后半段 `mediaOffsetAfter`（缺省逐位同原式）；修头推进源时钟那一处变速时按速度 |
| `src/store/actions/audio.ts` | 变速段拒绝音画分离、转换为声音 |
| `src/mcp/common.ts` | 测响度的片段档：时长 = 用到的那截素材 |
| `src/mcp/handlers/ai.ts` | 绑跟随轨迹时把源片段速度传给 `buildClipMotion` |
| `src/mcp/tools/autoWorkflow.ts` | 文字稿映射 `timelineTimeAt` |
| `src/mcp/tools/toolEcho.ts` | 时间轴一览带 `speed` |
| `src/mobile/MobileEditor.tsx`、`sheets.tsx`、`icons.tsx`、`FullTimeline.tsx`、`ThumbStrip.tsx` | 手机版入口、面板、标记 |
| `server/export-compose.mjs` | 兼容旁路：读的素材长度乘速度、`setpts=PTS/speed+…`；缺省写法不变 |
| `server/vision-compose.mjs` | 看画面的素材时刻 `mediaTimeAt` |
| `server/bakery/mux-audio.mjs` | 卡片声音那一路跳过变速段 |
| `server/agent/service/hosted-workflow.mjs`、`hosted-audio-js.mjs`、`account-tools.mjs` | 云端同口径（Agent 服务这一侧不 import `src/`，照抄式子并注明出处） |
| 不用改的 11 个 | `audio/soundRequest.ts`、`editor/io/soundGeneration.ts`、`editor/left/SoundEffectForm.tsx`、`store/actions/sound.ts`、`server/agent/service/hosted-sound.mjs`（音效挂在卡片段上，卡片段没有速度）；`kernel/cardAudioRendition.mjs`（卡片声音的源时钟；变速段的卡片声音在混音前已整段不出）；`kernel/cardAuthoring.mjs`（切分时素材效果卡边上的偏移按时间轴秒减，素材节点再乘倍率，推导过一致）；`store/actions/captions.ts`、`server/vite-plugin-media.ts`（只是注释）；`mobile/ThumbStrip.tsx` 的缩略图取入点那一帧（入点与速度无关，只加了标记） |

测试与探针：`src/kernel/clipTime.test.mjs`、`server/test/clip-speed.test.mjs`（新）；`scripts/probes/clip-speed-key-compare.mjs`、`clip-speed-export-probe.mjs`、`clip-speed-ui-probe.mjs`（新）。

### 用户定的推开规则（2026-10-23 用户定，不是〔裁〕）

用户原话：「变长以后如果会重合就推着后移，但是变短的时候尾部留空。」做法（`src/store/actions/clips.ts` 的 `setClipSpeed`）：

1. **推到哪为止**：同一条序列里排在这一段后面的**所有**段整体后移，移动量 = 新终点 − 下一段起点（只推到放得下为止：这一段和下一段之间原有的空档先被吃掉，后面各段之间的相对关系一个不变）。例：0～4 秒的段改 0.5×，变成 0～8 秒，后面 5～8、10～13 两段变成 8～11、13～16。理由：只推被挤到的那一段会让它去挤再下一段，等于还是要整体推；按「新终点 − 原终点」推则会把原有空档白白保留成更大的位移，后面的段离开原位更远，不如「推到放得下为止」。
2. **撞上别的东西**：
   - 被推的段挂着转场：整组一起推（组员可能在别的序列上，那些组员也跟着推），组内相对关系不变，推得动；
   - 被推的段是剪辑段：剪辑段只是平移，起点偏移不变，推得动；
   - 被推的段的声音伴随段（音效挂在源片段上的那种）跟着平移；
   - 别的序列上的段不动（相对关系只保同一条序列内的；画面上叠在被推段上面的卡片会和它错开，用户撤销或手动挪）；
   - **推不动就整个不改**，回原因：转场组员在锁着的序列上（「后面的段和锁着的序列「…」上的段绑在转场里，推不开；先解锁那条序列」）、伴随段在锁着的序列上、组员推过去会和别的序列上的段重叠（「……没有改速度」）。没有任何「放不下就裁掉」的路。
   - 时间轴总长：缺省跟着内容末尾走，所以整条序列自然变长；用户手动截短过总长的，截短值不动（`kernel/duration.ts` 的原规则）。
3. **撤销一步**：速度、被推开的所有段、伴随段在同一次 `setProject` 里提交，撤销一次全退回（单测与界面探针都核了）。
4. **界面提示**：「被下一段截住」的提示删了。推开时桌面编辑分区写「后面 N 段整体往后推了 X 秒」，手机版 toast「已改成 0.5×，这一段不出原声；后面 N 段往后推了 X 秒」；手机速度面板的说明改成「变长碰到后面的段会把它们一起往后推，变短尾部留空」。
5. 改前红、改后绿：新测试在上一版（截断）的 `clips.ts` 上跑是红的（`out/speed/red-push.log`：`+ capped: true` / `- pushed: { by: 7, clips: 1 }`，2 条失败），改后 17/17 绿。

〔裁：clip-speed 2026-10-23〕执行中自己定的几处（都在代码注释里写明）：

1. 速度范围 0.25～4×，九档；只给视频素材段（含套了素材效果卡的视频段）。——用户审过：认可，另要手动输入（已做，见「返工记录」）。
2. ~~后面放不下时截到下一段的起点~~——**已撤**，换成下面「用户定的推开规则」。保住入点、用到的那截素材不变、终点重算；它自己~~它自己挂着转场的拒绝~~——用户审过：撤掉，挂着转场可以改（见「返工记录」第 2 条）；序列锁着的拒绝仍是〔裁〕。
3. ~~变速段不能音画分离、不能转换为声音~~——用户审过：撤掉，可以分离（已做，见「返工记录」）；当音频素材效果卡的声音输入仍拒绝。
4. 桌面也给入口（理由见「入口」）。——用户审过：批准。
5. Agent 第一版只读得到速度、改不了。

## 验证

### 改前红、改后绿

先写测试、只加纯函数，跑 `npm test -- server/test/clip-speed.test.mjs src/kernel/clipTime.test.mjs`（提交 `9e817ef9`，日志 `out/speed/red-before.log`）：

```
✔ 缺省 1:帧身份、轨道前缀、镜像哈希、输入签名、卡片图上游键与开工提交逐字相同
✖ 变速:层表输入签名、卡片图素材节点、接它的素材效果卡上游键都跟着变;别的片段不变   → AssertionError: 变速段自己的签名要变
✖ 看画面(vision-compose):素材时刻按速度换算
✖ 导出兼容旁路(export-compose):…                                                     → 素材要读 3 秒 × 2 + 两头余量
✖ 素材效果卡的素材节点…
✖ 导出混音清单(audioPlanOf):变速的视频段不出原声,别的段原样                         → 变速段不在混音清单里
✖ 剪辑段摊平(cutFlatten):…                                                           → 截掉 1 秒时间轴 = 2 秒素材
✖ 预览同步(mediaSync.planSync):…                                                     → 对齐时按 2 倍放(1 !== 2)
✖ 字幕铺放(captions):…
✖ 跟随轨迹(motion):…
✖ store.setClipSpeed:…                                                               → TypeError: actions.setClipSpeed is not a function
ℹ tests 16
ℹ pass 6
ℹ fail 10
```

改完（日志 `out/speed/green-3.log`）：

```
ℹ tests 16
ℹ pass 16
ℹ fail 0
```

（缺省 1 那一条改前就绿，它是回归守门；纯函数的五条测的是新文件。）

### 键比对探针（改前改后）

`node scripts/probes/clip-speed-key-compare.mjs --base 5a8f375a`，退出码 0（`out/speed/key-compare.log`）：

```
== 1. 不带 speed:基准与当前逐字相同 ==
✔ 57/57 项逐字相同
== 2. v-fx 改 2 倍、剪辑段里的 b1 改 0.5 倍 ==
✔ 当前:frameIdentity / projectHash / audioPlan / vision@9 / compose.args / compose.graph / sig v-fx / sig seg~b1 /
  plan v-fx.contentKey / plan v-fx.snapshotKey / plan v-fx.streamMemberKey / plan seg~b1.contentKey 变了(12 项)
✔ 当前:没碰的片段 34 项不变
基准(改前)不认 speed:6 项改了速度却没变 —— sig v-fx、sig seg~b1、plan v-fx.contentKey、plan v-fx.streamMemberKey、vision@9、compose.graph
✔ 全部相符
```

### 变速项目逐帧比对与静音（自造项目，在 `out/` 下）

`scripts/probes/clip-speed-export-probe.mjs`：20 秒素材，第 N 帧整幅涂成能反推 N 的颜色，另带 440 Hz 正弦声；项目 16 秒八段——A 1×、B 2×、C 0.5×、D 剪辑段（里面 2×，从被引用剪辑第 0.5 秒起）、E 4×、F 0.25×、G 2× 套反色素材效果卡、H 1×。每帧解出素材帧号，和 `⌊(素材时刻 + 2 ms) × 30⌋` 比；再导两次成片（Chrome 离线混音、`--audio ffmpeg`）量各段响度。

| 树 | 画面逐帧 | 各段 | Chrome 混音 | ffmpeg 混音 |
|---|---|---|---|---|
| 改前 `out/base-5a8f375a`（`out/speed/export-base.json`） | **125/480** | A 60/60、H 60/60；B、C、E、F、G 各 1/60，D 0/60（另核：B、C、E、F 按 1 倍算 60/60 全对上，即改前无视速度） | 八段都是 −21.1 dBFS（变速段照常出 1 倍原声，和画面错开） | 同左 |
| 当前，第 1 遍（`out/speed/export-current.json`） | 479/480 | 只有 E 的第一帧（第 240 帧）取到素材第 0 帧 | A、H −21.1；B～G **−200**（无声） | 同左 |
| 当前，第 2 遍（`out/speed/export-current-r2.json`，只验画面） | **480/480** | 八段全 60/60 | — | — |

第 1 遍那一帧：第 240 帧是 E 段的第一帧，素材时刻 2.0 秒，和改前（1 倍下这一帧同样是素材第 2.0 秒）**同一个 seek 目标、同样新建一个视频元素**；取到第 0 帧是新元素第一次出画的那类竞态（`docs/plan/TODO.md` 里 `frameMedia.ts` 取帧竞态一条同类），第 2 遍没有复现。我判断不是这次改出来的，但没有再深挖，列在「没做成的」里。

看过的图：`out/speed/export-current/frames-run/frames/000090.png`（B 段 t=3 秒，中心像素 (88,16,126) = 素材第 75 帧 = 0.5 + 1×2 = 2.5 秒 ✓）、`000390.png`（G 段，反色后的绿，反推素材第 240 帧 = 6 + 1×2 = 8 秒 ✓）、`000380.png`（排查时 G 段没带 cardId 的白屏，见下）。

排查记录：G 段第一次 0/60（整幅白），起因是探针夹具里 G 段没带 `cardId`（apply_card 挂上之后片段同时带 `cardId` 和 `mediaId`）；把 G 改成 1× 复跑同样 0/60，确认与速度无关，修夹具后 1× 60/60、2× 60/60。顺带发现 `setClipSpeed` 原先拒绝带 `cardId` 的视频段，已放开（〔裁〕第 1 条）。


### 界面探针（手机版与桌面）

`npx vite build --mode online` 之后 `node scripts/probes/clip-speed-ui-probe.mjs --dist dist-online --out out/speed/ui`（本机托管组合 + 仿 nginx 代理，端口 5930～5932、5936、5937），退出码 0，`"ok":true,"fails":[]`。要点原文：

```
"P1":{"tools":["sub-ref","sub-split","sub-dup","sub-mute","sub-speed","sub-adjust","sub-del"]}
"P2":{"note":"声音：变速后这一段不出原声（第一版不做变速声音）；改回 1× 恢复。", …,"after":{"start":0,"end":3,"mediaOffset":0,"speed":2}}
"P3":{"badge":"2× 无原声"}
"P4-before":{"audioLayer":true}   "P4-after":{"audioLayer":false}
"P5":{"rates":[{"url":"http://s1.pc.localhost:5931/editor/stage.html?…","r":[{"rate":2.0239381333333335,"t":0.73}]}]}
"P6":{"speedField":false,"end":6}
"D1":{"note":"变速后这一段不出原声（第一版不做变速声音）；改回 1× 恢复。","after":{"start":0,"end":6,"speed":0.5}}
"D1-cap"(这一条是推开规则之前的版本,见「返工后复跑」)
"D2":{"label":"tone.mp4 · 0.5×","badgeTitle":"tone.mp4：已变速 0.5×，变速段不出原声"}
"D-sync":{"phoneSeesHalf":true}   "errors":{"phone":[],"desktop":[]}
```

即：手机版子导航「静音、速度、调整」顺序同演示稿；点 2× 后起点、素材起点不动、时长 6 → 3 秒；预览主文档里这一段的 `<audio>` 变速前在、变速后没了；播放时舞台里这段视频 `playbackRate` 2.02（2 倍上叠了纠偏）；撤销一步回 1× 且不留 `speed` 字段；桌面编辑分区「速度」一栏改 0.5×（这一遍还是截断的旧规则，返工后的结果见下）；时间轴名字带「· 0.5×」、静音标记写明原因；手机页同步到 0.5×。

看过的图：`out/speed/ui/P2-sheet-after.png`（手机速度面板，2× 高亮、说明框、toast「已改成 2×，这一段不出原声」）、`P3-timeline-badge.png`、`D2-timeline.png`（桌面编辑分区与时间轴的「· 0.5×」「已静音」）、`D0-selected.png`。

探针调通前的三次失败都是探针自己的问题，记下来：素材库面板没关上挡住了分页按钮（改成点到没有面板为止）；桌面左栏默认在「素材库」分区，要先点「编辑」；有一遍 P5 在 8 秒内没等到舞台里有视频在放（起播慢），另一遍 1.8 秒就放上了，这一条的等待只为防卡死。

### 返工后复跑（提交 `e48b94d1` 及之后只动了探针与报告）

**改前红、改后绿**（返工的四条新测试）：把新测试放到上一版 `22e3e713` 的树上（只换进新的 `clipTime.mjs`，`out/head-22e3`）跑，`ℹ tests 21` `ℹ pass 17` `ℹ fail 4`（`out/speed/red-round3.log`）：

```
✖ store.setClipSpeed 手动输入:0.25～4 之外拒绝并提示(不夹)…        → 0.2 被夹到 0.25 照改了(true !== false)
✖ store.setClipSpeed 挂着转场:…                                   → + error: '这一段挂着转场，改速度会改时长；先删掉转场'
✖ store.setClipSpeed:…切分…                                       → 分离被拒(false !== true)
✖ 声音段变速(音画分离出来的):…                                   → 声音段不在清单里
```

当前：`ℹ tests 21` `ℹ pass 21` `ℹ fail 0`（`out/speed/green-7.log`）。推开规则那两条的改前红见「用户定的推开规则」第 5 条。

**键比对**（`out/speed/r4/key-compare.log`）：`✔ 57/57 项逐字相同`、`✔ 全部相符`。返工中途改过 `server/bakery/audio-mix.mjs` 时这里是 `✖ 45/57`（12 处都是 contentKey / snapshotKey，因为那个文件进共享快照键的代码指纹），还原后回到 57/57。

**变速项目逐帧比对 + 声音**（`out/speed/r4/export-current.json`，退出码 0，`"ok": true, "fails": []`）：

画面 480/480。声音（B、C 两段视频静音，各有一段同速度的分离声音段；素材声音 440 Hz）：

| 段 | 内容 | Chrome 离线混音 | ffmpeg 混音 | 两路差（差信号 / 信号） |
|---|---|---|---|---|
| A | 1×，视频原声 | −21.1 dBFS / 439.6 Hz | −21.1 dBFS / 440.0 Hz | −36.3 dB |
| B | 2×，分离出来的声音段 | −21.1 dBFS / 879.6 Hz | −21.1 dBFS / 880.0 Hz | −48.7 dB |
| C | 0.5×，分离出来的声音段 | −21.1 dBFS / 220.0 Hz | −21.1 dBFS / 219.6 Hz | −53.7 dB |
| D～G | 变速视频段（剪辑段里的 2×、4×、0.25×、套素材效果卡的 2×），没分离 | −200 dBFS | −200 dBFS | — |
| H | 1×，视频原声 | −21.1 dBFS / 439.6 Hz | −21.1 dBFS / 439.6 Hz | −54.7 dB |

- 两路确实各走各的：日志核对 Chrome 那一次是「Mixing … in Chrome」、没有「退回 ffmpeg」（`mixedIn: chrome` / `ffmpeg`）。
- 尺子：两条路本来就不逐采样相同（Chrome 混音 + AAC 编码 vs ffmpeg 混音 + AAC 编码），1 倍的 A、H 两段差 −36.3 dB 与 −54.7 dB；变速的 B、C 是 −48.7 dB、−53.7 dB，在 1 倍段的范围之内，判「对得上」。A 段那 −36.3 dB 是 1 倍原声本来的差（改前的树上 A 也是 −36.3 dB），和速度无关，没查。
- 改前对照（开工提交，`out/speed/r3/export-base.json`）：B、C 主频都是 440 Hz（速度被忽略，按 1 倍出声），D～G 都是 −21.1 dBFS（变速段照常出 1 倍原声），画面 125/480。

**界面探针**（`out/speed/r4/ui`，最后一遍退出码 0，`"fails":[]`）：在上一节各条之外，新加的几步原文：

```
"P2b":{"rejectedToast":true,"speedAfterBad":2,"speedAfterOk":1.5,"end":4}
"P6":{"afterOneUndo":[1.5,4],"speedField":false,"end":6}
"P7":{"added":true,"bubble":"…已改成 4×，这一段不出原声；淡出跟着缩短：2.50 秒 → 1.49 秒（这一段变短，原来的转场装不下）","clip":{"start":0,"end":1.5,"fadeOut":1.49,"speed":4},"transitionDur":1.49}
"D1-input":{"msg":"速度要在 0.25～4 倍之间","speed":1}
"D1-push":{"nextAfter":[12,18],"pushMsg":"后面 1 段整体往后推了 6.00 秒"}   "D1-undo":{"v":[0,6,null],"next":[6,12]}
"P5":{"rates":[{"…s1.pc.localhost:5931/editor/stage.html…","r":[{"rate":2.0230722666666665,"t":0.63}]}]}
```

看过的图：`out/speed/r4/ui/P7-transition-bubble.png`（手机 toast 气泡）、`P2-sheet-after.png`、`D2-timeline.png`、`P5-playing.png`。

P5（播放中舞台视频按 2 倍放）**不稳**：最后几遍里 2 遍在等待时限内一直没看到舞台里有视频在放（两个视频元素都是暂停的，播放头照走），另几遍都看到 2.02 倍左右。没查到原因，不确定和速度有没有关系，记在「没做成的」里。调稳的另外几处（先关面板、等面板滑入动画、直接点元素）都是探针自己的问题。

## 门槛

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，没有任何输出（`out/speed/r4/tsc.log` 只有脚本自己写的 `exit 0`） |
| 全量测试 | `npm test`（两个账号变量用反斜杠） | 汇总行原文 `ℹ tests 7709` `ℹ pass 7694` `ℹ fail 0` `ℹ cancelled 0` `ℹ skipped 15` `ℹ duration_ms 244787.7703`；退出码 0；日志 927,433 字节（`out/speed/r4/npm-test.log`） |
| 网页构建 | `npm run build` | 退出码 0 |
| 在线构建 | `npx vite build --mode online` | 退出码 0 |
| 与 `5f4523d0` 的全长导出比对 | 两棵树各起自己的开发服务器跑 `scripts/export-frames.mjs --url <origin>/?export=1 --fps 30 --workers 1 --no-video`（基准 5926、候选 5929，驱动 `out/speed/render-gate.mjs`），再 `export-baseline-compare.mjs` | 原文 `逐字节:相同 1800/1800` `✅ 全长导出逐字节相同`，退出码 0 |
| 导出确定性 | `scripts/verify-determinism.mjs --url <origin>/?export=1 --fps 30`（5932） | `Total Frames: 1800` `Identical: 1800` `Different: 0`，退出码 0 |
| 快照重放 | `scripts/verify-unified-frames.mjs --origin <origin>`（5926） | `PASS: no video during B; …`，退出码 0 |

以上是返工后在 `e48b94d1` 上跑的（`out/speed/r4/`）；之前每一轮的同一套也都跑过，结果相同（`out/speed/r2/`、`r3/`、根目录的 `npm-test-full-2.log`）。返工第三轮中途的全量捞到 3 条真红：两条 SEAM 守门（Agent 服务进程会载的 `server/audio-measure.mjs` 不许 import `src/`）和「要拷到节点的那几样就够」，已把那一个滤镜函数照抄进 `audio-measure.mjs`，复跑通过。

最早第一遍全量（`out/speed/npm-test-full-1.log`，7704 条、**6 条失败**）就是上面说的有声卡源码闭包守门：`av-pulse` / `sound-notification` / `sound-keyboard` 三张卡各两条（闭包多了 `/src/kernel/clipTime.mjs`；`cardGraph.mjs` 内容变了，源码版本从钉住的 `535ba03a…` / `1a663d9c…` 变了）。按测试文件头「红了先停、问过用户再改钉住值」，我没有改钉住值，而是把 `cardGraph.mjs` 还原、改用 `withMediaRates`；第二遍全量 0 失败。

像素基线的演示项目里没有视频，所以它只证明「缺省路径没动」；变速的画面由上面自造项目的逐帧比对证明。

## 没做成的及原因

0. **界面探针的 P5 不稳**：见上「返工后复跑」。**在线浏览器导出的变速声音没有实测**（没有对应探针），只有单测核了插值函数。分出来的声音变调是用户定的待办（请记进 `TODO.md`）。

1. **Agent 改速度**：没有加工具，只让 Agent 在时间轴一览里看得到 `speed`。加工具要改 `product/agent.md` 的工具清单，属二级，待用户定。
2. **导出时新视频元素第一帧偶发取到素材第 0 帧**：变速项目第 1 遍 480 帧里有 1 帧（E 段第一帧），第 2 遍 0 帧。和改前同一个 seek 目标、同一种「新建元素第一次出画」的时机，判断是 `frameMedia.ts` 原有的那类竞态，不是这次引入的；没有深挖，建议另开一条用 `video-seek-race-probe` 的办法量一下「新挂元素」这种情形。
3. ~~手机版主要内容变速后留空档~~：用户已答（见「用户定的推开规则」），按它改了。
6. **main 前进了**：分支从 `5a8f375a` 切，没有合 main（按主会话说的，由主会话合进来解冲突）。
4. **保调变速**：按〔裁〕不做。
5. 没跑的：`video-seek-race-probe`、`video-source-cadence-probe` 等其余 G0-R 探针（任务门槛没要求；取帧只改了时刻的算法，取帧本身的机制没动）；桌面版（Tauri）里没有实测，只测了开发服务器与在线构建两种页面。

## 对〔裁〕的意见

- 「第一版变速段原声自动静音」：我认为**不该推翻**。实测下来它是唯一能让两条混音路（Chrome 离线混音与 ffmpeg）结果一致的做法，两条路逐段都是 −200 dBFS（数字静音），预览也一致；改前则是变速段照常出 1 倍原声（−21.1 dBFS），声音和画面错开。只补一句建议：界面现在写的是「第一版不做变速声音」，等以后做保调变速，这句话要跟着改。

## 语义要改哪几句（只写建议，没有改 `docs/semantics/**`）

### 1. `product/project-model.md`「片段」·素材段（二级）

修改前：

> - **素材段**：用哪段素材、从素材的哪一秒开始，以及和卡片段相同的框、淡入淡出、不透明度；音频段的不透明度即音量。素材段可挂滤镜、像素映射、音频效果。

修改后：

> - **素材段**：用哪段素材、从素材的哪一秒开始，以及和卡片段相同的框、淡入淡出、不透明度；音频段的不透明度即音量。素材段可挂滤镜、像素映射、音频效果。
> - **素材段的速度**（2026-10-23 用户定）：视频段和声音段有播放速度，缺省 1 倍，可设 0.25～4 倍，可选几档也可手动输入（可带小数，超出范围拒绝并提示）；套了素材效果卡的视频段同样可设。改速度保住入点（起点和从素材第几秒开始不变），用到的那截素材不变，时长按新速度重算；变长会和下一段重合时，同一条序列里它后面的段整体往后推、推到放得下为止，变短时尾部留空、后面的段不动；推不开时整个不改并说明原因，不截断。挂着转场的段可以改：转场跟着片段两端走，交叉溶解的另一段跟着挪、重叠不变；变短后装不下转场时转场跟着缩短并提示用户缩成多少。切分时后半段的素材起点按速度推进。预览、导出、Agent 看画面按同一个速度取帧。
> - **变速的声音**：〔裁：主会话 2026-10-22〕第一版变速的视频段不出原声，界面写明。视频段可以音画分离（2026-10-23 用户定），分出来的声音段带着同样的速度，随倍率变速变调；保调变速留作以后（待办）。

### 2. `mechanism/project-model.md` 新增一节「片段速度」（三级，〔裁：clip-speed 2026-10-23〕）

> ## 片段速度
>
> - 素材时刻 = `mediaOffset + (t − start) × speed`，全项目只此一个纯函数（`src/kernel/clipTime.mjs`），各处调它；速度不是有限正数时按 1。
> - 等于 1 时不写 `speed` 字段（store 改回 1 就删掉），不留 `speed: 1`：整份序列进哈希的三处身份（镜像的项目哈希、快照签名、帧服务的帧身份）因此逐字不变；按字段挑着进键的层表输入签名只在不是 1 时加 `speed`；卡片图里变速段的素材节点由 `withMediaRates` 在出画面、出键的几处补上倍率 `rate`（导出页的画面与卡片计划、舞台、剪辑段的嵌套场景、在线页面的卡片计划），不写在 `projectCardGraph` 里——`cardGraph.mjs` 在内置有声卡的源码导入闭包里，改它会让已生成的卡片声音全部过期。
> - 导出与预渲染取帧（`data-pc-media-time`）在速度为 1 时保留原来的运算顺序 `(mediaOffset + t) − start`，变速时按统一换算；导出的兼容旁路（`--media ffmpeg`）读的素材长度乘速度、时间戳 `setpts=PTS/speed+…`。
> - 预览的视频元素以片段速度为基准播放速率，纠偏的 ±10% 乘在它上面，暂停时也停在它上面。
> - 变速的视频段原声不出的判断只有一条（`speedMutesSource(clip, project)`：素材是视频、速度不是 1），预览的声音层、导出混音的两条路（Chrome 离线混音与 ffmpeg）、测响度共用；变速的视频段不能当音频素材效果卡的声音输入。声音段（素材是 audio，比如音画分离出来的）变速时照常出声、变调：桌面导出由 `mux-audio.mjs` 的 `playableAudioPlan` 先用 ffmpeg（`aresample,asetrate=48000×速度,aresample`）做成时间轴长度的 wav，两条混音路共用这一份；预览 `playbackRate = 速度`、`preservesPitch = false`；在线浏览器导出按速度线性插值；测响度同一个 ffmpeg 滤镜。`server/bakery/` 里进共享快照键代码指纹的七个模块（`frame-code.mjs` 的 `SNAPSHOT_FILES`）不改。
> - 改速度遇到转场：转场时长不变、跟着两端走；装不下时缩到「新长度 − 0.01 秒」（不短于 0.1 秒），交叉溶解的后一段靠整体后挪缩短重叠；结果里带上缩了哪几条，界面提示。

### 3. `workflow/editing.md`（一级，由用户定；这里只给建议）

「手机版界面」一节末尾加一条：

> - 选中视频段时，子导航栏是「引用、分割、复制、静音、速度、调整、删除」（同演示稿）；「速度」打开速度面板，几档倍数，写明「变速后这一段不出原声」。完整时间轴上变速段标出「2× 无原声」，缩略卡的时长后面带倍数和静音图标。

「编辑界面」（桌面）加一条：

> - 视频段的编辑分区有「速度」一栏（几档倍数，同一句「变速后这一段不出原声」）；时间轴上变速段的名字后带倍数，静音标记写明「已变速 2×，变速段不出原声」。

### 4. `product/agent.md`（二级，建议，待用户定）

现状：Agent 的时间轴一览（`timelineDigest`）里变速段带 `speed`，Agent 看得到；但没有改速度的工具。建议用户定：要不要给 Agent 一个改速度的工具（比如 `set_clip_speed`），还是第一版只让人改。

### 5. `docs/plan/three-versions-progress.md`（计划文档，建议更正）

- 「`grep -rln mediaOffset` 共 38 个非测试文件」：`src/` 与 `server/` 下实际 39 个（另有 15 个在 `scripts/`）。其中 11 个不用改（见报告逐文件表），`cardGraph.mjs` 是**不能改**（有声卡源码闭包），改由 `withMediaRates` 在出画面出键处补倍率。
