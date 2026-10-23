# AGENT 报告：claude/speed-audio-input

任务：用户 2026-10-23 回「放开。」推翻〔裁〕V21-25 的第三件。V21-25 是 0.7.21 发版时记的一条裁定：用户那句「可以分离，失真问题记待办」本来管三件事，当时只放开了前两件（音画分离、转成声音），第三件「变速的视频段当音频素材效果卡的声音输入」仍然拒绝。这次放开第三件：变速的素材段可以当音频素材效果卡的声音输入，卡拿到的声音按倍率变速变调。

分支 `claude/speed-audio-input`，从 main `fb108d97` 切出。提交：`a405c9cc`（建报告）、`8e349128`（实现与测试）、`9356362f`（探针）、`e0b17d6f`（语义与注释）、本报告定稿一次。

## 倍率在哪一层生效：页面取样层

音频素材效果卡的素材输入走 `GET /@media/<hash>/pcm?start=&count=&sampleRate=&ch=2`（`server/vite-plugin-media.ts` 的 `handleMediaPcm`，ffmpeg 按采样区间裁），页面侧是 `src/render/cards/audioSources.ts` 的 `blockOf → mediaBlock`。

选的是**页面里按倍率多取、取回来再插值**（新函数 `varispeedBlock`），路由一个字没动：

- 下游第 `i` 个采样 = 素材第 `mediaOffset + (start + 边.offset + i) × 倍率` 个采样。这和画面那一路完全对应（`GraphCard.tsx`：取帧时刻 = (下游时刻 × 边.rate + 边.offset) × 节点 rate + 节点 offset），也和导出两条混音路「读 `时长 × 倍率` 秒素材、压成时长」同一语义。
- 先按倍率向服务端要那一截原始采样（多 1～2 帧给插值；超过路由上限 1,048,576 帧时分几次取），再按**绝对采样坐标**线性插值，与在线浏览器导出的 `resampleVarispeed` 同一插值。
- **为什么不放到服务端用 `ffmpegVarispeed` 做**：卡片声音是一块一块取的（生成卡片声音按 8192 帧一块，导出的 Chrome 离线混音按自己的块）。块起点映射到素材上一般不在整数采样上；ffmpeg 的 `asetrate` 每块重起一次滤镜链，块与块之间相位接不上、首尾还有重采样滤波器的过渡段，拼起来每块一声咔哒。按绝对坐标插值，同一时刻不论落在哪一块都取到同一个值。单元测试「按块取与一次取逐个采样相同」直接核了这一点（1.37 倍，3000 帧一次取 vs 三块 1000 帧，`deepEqual` 通过）。
- 代价：线性插值没有抗混叠滤波，和 ffmpeg 那一路（swr 的 sinc）不逐采样相同。归入用户已说过的「失真问题记待办」。
- 倍率来源：合成过的素材节点上带 `rate`（`withMediaRates` 加的）就用它；没带时（`cardAudio.ts` 给的图是 `projectCardGraph` 的结果，不经 `withMediaRates`）按节点的 `clipId` 查片段速度；生 `cardNodes` 里没有素材节点、走 `{ clipId }` 分支的，直接取片段速度。
- **边上的 `rate ≠ 1`（第 166 行那条既有限制）没动**，两者在实现上不共用一条路：边的 rate 在 `blockOf` 入口就报错，片段速度在分支里才看。新测试「变速的素材段 + 边上的 rate ≠ 1」确认仍报「第一版不支持」。

## 改了哪些文件

| 文件 | 改了什么 |
|---|---|
| `src/render/cards/audioSources.ts` | 去掉两处「变速的素材段……不能当音频素材效果卡的声音输入」的拒绝；新增 `mediaNodeSpeed`、`mediaSpan`（超上限分段取）、`varispeedBlock`；1 倍时仍是原来那一次 `mediaBlock` 请求，位置和长度一个不差 |
| `src/audio/cardAudio.ts` | 新增导出函数 `speedMutesCardAudio`：变速视频段上挂的卡片声音，只有**声画一体卡**仍不出；`generatedCardAudioClipsAt`（预览）改用它，于是挂在变速视频段上的音频素材效果卡预览照常出声 |
| `server/bakery/mux-audio.mjs` | `buildAudioPlan` 收音频素材效果卡那一路去掉 `speedMutesSource`（这一路只收 `kind: "audio"` 的卡节点）；去掉不再用的 import。**不在 `BAKERY_FILES` 里** |
| `src/kernel/cardAudioRendition.mjs` | `cardAudioIdentity` 里输入素材那一项在倍率不是 1 时带上 `speed`（1 倍逐字不变）。不然改了输入段的速度，已生成的卡片声音会被当成没过期 |
| `src/kernel/audioPlan.mjs`、`src/kernel/clipTime.mjs` | 只改注释（原注释写着「接在它上面的卡片声音也不出」，已不对） |
| `src/render/cards/audioSources.test.mjs` | 新增 5 个测试 |
| `server/test/clip-speed.test.mjs` | 新增 1 个测试（导出清单收变速段上的音频素材效果卡；身份 1 倍逐字不变、2 倍带 `speed: 2`） |
| `scripts/probes/speed-audio-input-probe.mjs` | 新探针：导出后测主频 |
| `docs/semantics/product/project-model.md` | 「视频段的速度」的声音一条：写明可以当音频素材效果卡的声音输入、随倍率变速变调，注明 2026-10-23 用户定「放开。」；末尾〔裁〕里删掉「仍然拒绝」那半句；「卡片声音同样不出」收窄为「声画一体卡的声音同样不出」 |
| `docs/semantics/mechanism/project-model.md` | 「片段速度」一节补一条「音频素材效果卡的声音输入」（倍率在哪一层、为什么、倍率来源、身份、预览与导出两处），标〔裁：speed-audio-input 2026-10-23，三级〕；探针清单由三支改为四支 |
| `docs/reports/AGENT-claude-speed-audio-input.md` | 本报告 |

没有动：`server/bakery/` 里进指纹的七个模块（`git diff fb108d97 --stat -- server/bakery` 只有 `mux-audio.mjs`）、`server/audio-measure.mjs`、`server/vite-plugin-media.ts`、`server/asset-service.ts`、`cardGraph.mjs`（它在内置有声卡的源码闭包里）。

## 验证

全部在 worktree 里跑，测试命令都带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`、`PROMPTCUT_NO_PORT_FILE=1`。

- **类型检查**：`npx tsc -b --force`，退出码 0，零错误（实现后与改完注释后各跑一次）。
- **受影响的测试**（没跑全量）：最后一轮一条命令跑 21 个文件——`src/render/cards/*.test.mjs`、`src/audio/*.test.mjs`、`server/test/audio*.test.mjs`、`server/test/clip-speed.test.mjs`、`src/kernel/clipTime.test.mjs`、`src/kernel/cardAudioRendition.test.mjs`、`src/layering.test.mjs`、`src/render/audioCardSourceVersion.test.mjs`（内置有声卡源码版本的守门）、`src/online/cardRuntime/soundThread.test.mjs`、`server/bakery/audio-mix.test.mjs`、`server/bakery/mux-audio.test.mjs`、`server/test/cut-segment-audio.test.mjs`、`src/editor/io/cardAudioGeneration.test.mjs`、`src/editor/io/exportSounds.test.mjs`、`src/editor/io/onlineSoundJudge.test.mjs`、`src/kernel/audioMute.test.mjs`、`src/kernel/audioPlan.test.mjs`、`src/kernel/clipAudioState.test.mjs`、`src/kernel/clipVolume.test.mjs`、`src/kernel/cutSegments.test.mjs`：**177/177 通过**，退出码 0。另跑键与接缝守门 5 个文件（`accept-018-rest-ssr-seam`、`card-cache-upstream-key`、`card-snapshot-identity`、`host-card-code`、`page-stream-plan`）：**53/53 通过**。没有失败，不需要单跑复核。
- **键比对探针**：`node scripts/probes/clip-speed-key-compare.mjs --base 5a8f375a`，退出码 0：「✔ 57/57 项逐字相同」，变速那一组各项照常变、「没碰的片段 34 项不变」，「✔ 全部相符」。实现提交 `8e349128` 后跑一次，改完注释后再跑一次，两次都是 57/57。
- **真听一遍**：`node scripts/probes/speed-audio-input-probe.mjs --port 6480`，退出码 0。素材是带 440 Hz 正弦声的 20 秒视频，卡是临时写进改动层的直通音频素材效果卡，导出走缺省的 Chrome 离线混音（日志核实 `mixedIn: chrome`，没有退回 ffmpeg）。成片各段中间 1.4 秒：

  | 段 | 接法 | 倍率 | 期望 | 过零点测得 | DFT 峰 | 响度 |
  |---|---|---|---|---|---|---|
  | A | 卡挂在片段自己身上 | 1× | 440 Hz | 439.6 Hz | 440 Hz | −21.1 dBFS |
  | B | 卡挂在片段自己身上 | 2× | 880 Hz | 880.0 Hz | 880 Hz | −21.1 dBFS |
  | C | 卡挂在片段自己身上 | 0.5× | 220 Hz | 220.0 Hz | 220 Hz | −21.1 dBFS |
  | D | 另一条序列上的卡片段接 `@clip/V/source`，V 是 2× 视频段 | 2× | 880 Hz | 880.0 Hz | 880 Hz | −21.1 dBFS |

  开发服务器用 6480（舞台 6481、6482），跑完已收掉，6480～6489 没有残留监听。产物在 `out/speed-audio-input/`（不入库）。

## 二级〔裁〕：用户看得见的其它变化（单列）

1. **挂在变速视频段上的音频素材效果卡，现在预览和导出都会出声**（以前连同原声一起不出）。这是「放开」的直接结果：卡挂在这一段上，读的正是这一段的素材。产品语义里「挂在它上面的……卡片声音同样不出」已收窄为「声画一体卡的声音同样不出」。
2. **声画一体卡（自带画面又自带声音的卡，例如 av-pulse）挂在变速视频段上，声音仍然不出**，没有放开。理由：用户这次放开的是「当音频素材效果卡的声音输入」；声画一体卡的时钟锚在 `mediaOffset`（素材秒），变速后切分、裁剪时它已生成的声音按什么偏移播放要另想，不在这次范围。**请用户确认是否也要放开**。
3. **音频素材效果卡拿到的变速声音用线性插值**，和音画分离出来的变速声音段在桌面导出里用的 ffmpeg 重采样不逐采样相同（同一语义、同样变调，高倍率下这一路的混叠会多一点）。随「失真问题记待办」记待办。
4. 卡片声音的身份带上输入段倍率：读变速段的卡，改输入段速度后已生成的卡片声音会判「已过期，请重新生成」。1 倍的身份逐字不变，现有已生成的卡片声音不受影响（以前读变速段的卡根本生成不出来，所以没有存量）。

## 没做成的、没验证的

- `--audio ffmpeg` 那条导出老路没测：它对音频素材效果卡本来就明确拒绝（1 倍也拒绝），与这次无关。
- 预览（编辑器里实时播放）没在浏览器里实听，只有单元层面：预览走的是同一个 `blockOf`，`generatedCardAudioClipsAt` 的放开靠代码阅读与类型检查。
- 在线浏览器模式不取素材的采样块（既有限制，素材效果卡由渲染节点出），这次不涉及。
- 没有在改前的树上跑同一支探针做对照（要另解一棵带 `scripts/` 和 vite 配置的树）；改前会在取样时报「变速的素材段第一版不出原声，不能当音频素材效果卡的声音输入」，见原代码第 172、185 行。

## 对任务书或语义的更正建议

- 任务书说「第 185 行……要放开的只有『片段自己带速度』这一半」。实际第 185 行那两半（`node.rate ≠ 1` 和 `owner` 片段速度 ≠ 1）说的是同一件事：`node.rate` 就是 `withMediaRates` 抄过来的片段速度，不是边上的 rate。所以两半都放开了；边上的 rate 是第 166 行那条，没动。第 172 行（`{ clipId }` 分支）也有一处同样的拒绝，一并放开。
- 任务书只点了 `audioSources.ts`，但要让用户真听到，还得改预览（`cardAudio.ts`）与导出清单（`mux-audio.mjs`）两处「变速段上的卡也不出」的过滤，以及卡片声音身份（`cardAudioRendition.mjs`），不然改速度后会用旧声音。都是最小改动，已列在上表。
- 产品语义里那条〔裁〕的括号原文是「挂在它上面的音频效果、卡片声音同样不出」，「卡片声音」没有区分音频素材效果卡和声画一体卡。这次收窄成「声画一体卡的声音」；如果用户本意是两类都放开，见上面二级〔裁〕第 2 条。

## 能不能合进 main

可以。类型检查零错误，受影响的测试 177 + 53 全过，键比对 57/57，测频四段都对。全量测试按约定由主会话发版前统一跑。
