# AGENT 报告：claude/clip-speed

任务：前置项里的「速度」入口（`docs/plan/three-versions-progress.md`「『速度』入口」一条）。给视频段加面向用户的片段速度 `TrackClip.speed`（缺省 1），各处时间换算改调同一个纯函数；变速段原声第一版自动静音并在界面写明；手机版加「速度」入口，桌面编辑分区也加。

- worktree：`.worktrees/clip-speed`，分支 `claude/clip-speed`，从 main `5a8f375a` 切。端口段 5920～5939（实际用了 5920、5923、5926、5929、5930～5937）。
- 做完**没有**合入 main、没有推送，等用户审〔裁〕。
- 「〔裁〕」指会话在执行中自己定、要用户在合入前审的决定；本报告里新出的〔裁〕都标「clip-speed 2026-10-23」。

## 结论

- **做通了**：画面（导出、预渲染、舞台、Agent 看画面、导出兼容旁路、剪辑段里、套了素材效果卡的视频段）按「素材时刻 = mediaOffset + (t − start) × speed」取帧，逐帧比对 480/480；声音按〔裁〕变速段不出原声，两条导出混音路都实测无声；手机版与桌面都有入口，界面写明。
- **像素基线**：见「门槛」一节（与 `5f4523d0` 的全长导出比对）。
- **身份键缺省 1 逐字不变**：固定样例在开工提交与当前工作区上 57/57 项逐字相同（帧身份、轨道前缀、镜像哈希、层表输入签名、卡片计划的六个键与其余字段、混音清单、取帧时刻、导出兼容旁路参数）。
- **一处任务书没写到的硬约束**：素材节点的倍率原打算写进 `src/kernel/cardGraph.mjs` 的 `projectCardGraph`，全量测试捞出它在**三张内置有声卡的源码导入闭包**里（守门 `src/render/audioCardSourceVersion.test.mjs`），改一个字就会让用户已生成的卡片声音全部判「已过期」。已还原 `cardGraph.mjs`（与 main 逐字相同），改由新函数 `withMediaRates` 在出画面、出键的五处补倍率。

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
- 连带：变速段不能当音频素材效果卡的声音输入（`render/cards/audioSources.ts`，和原有「边上 rate ≠ 1 不支持」同一个报法）；不能音画分离、不能转换为声音（`store/actions/audio.ts`，提示「先把速度改回 1×」）。
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

〔裁：clip-speed 2026-10-23〕执行中自己定的几处（都在代码注释里写明）：

1. 速度范围 0.25～4×，九档；只给视频素材段（含套了素材效果卡的视频段）。
2. 改速度保住入点、用到的那截素材不变、终点重算；后面紧挨着片段、放不下时截到下一段的起点（提示「后面放不下，已截到下一段的起点」）；挂着转场的拒绝（同转场「组内不能单独改时长」）；序列锁着的拒绝。
3. 变速段不能音画分离、不能转换为声音、不能当音频素材效果卡的声音输入（从「原声不出」推出来的）。
4. 桌面也给入口（理由见「入口」）。
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

（门槛、像素基线、界面探针各节在下面补。）
