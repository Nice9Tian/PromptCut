# 计划：音频处理整体改成浏览器端 JS（流式、省内存、阈值比对）

2026-09-23。依据是你的三条决定：
- "我决定使用JS完整重构，让音频可以使用流式写入节省内存，运行在浏览器端。"
- "同时，放宽逐字节比对，改为阈值，比如8%最大差。"
- 前一轮：文档云端只存工程文档，素材云端是纯存储，服务端一律不处理音频。

判重的测试计划在 `audio_determine_plan.md`，本文的 A6 步实现它的定稿结果。本文引用的实测数字都来自 `reports/audio-probe-2026-09-23.json`（探针 `scripts/probes/audio-determine-probe.mjs`）。

---

## 0. 先说几件会改变做法的事实

1. **浏览器端能力够用，但格式覆盖会变窄。** Chrome 152 的 WebCodecs 能解 AAC、Opus、MP3、FLAC、Vorbis、PCM，能编 AAC、Opus；**不能编 FLAC**。
   - 解码比实时快几百倍（AAC `decRtf 0.0018`，Opus `0.0025`）。
   - 素材库现在接受的 `wma`，以及视频里常见的 AC-3、DTS 音轨，浏览器没有解码器。现在它们在导出时靠 ffmpeg 还有声音，重构之后就没有了。第 6 节待定 3。

   出处：验证：`codec.encoder` / `codec.decoder` 支持表；"wma: \"audio\", aiff: \"audio\""——`src/editor/io/mediaKinds.ts` 的 `EXT_KIND`。
2. **FLAC、Vorbis 必须把容器里的初始化数据传给解码器**，不传会直接抛 `TypeError`。解封装层要负责取出这些数据。
   出处：验证：`decoder.flac: "throw:TypeError"`（没给 `description`）；Gemini 讨论第 1 轮指出这是 WebCodecs 规范要求。
3. **分段渲染的接缝误差由「预滚」控制，而且可以算出来**：预滚 ≥ 效果尾巴的长度，误差就降到 1e-7。尾巴的长度能从效果参数直接算出来，见 A4。
   出处：验证：`chunk.all` 预滚 4 秒 `maxRel 1.8e-7`；`longTail` 预滚 4 秒 `0.0040`、8 秒 `1.8e-5`。
4. **8% 只能比编码前的 PCM。** AAC 往返之后，带噪声的信号最大差 54%，比成片没有意义。
   出处：验证：`roundtrip["music:mp4a.40.2"].maxRel 0.5407`。
5. **现在「测整条时间轴响度」量的不是导出的那条声音**：它用 ffmpeg 直接混素材，不带音频效果，也跳过音频图卡。重构之后，响度直接量导出同一条混音，这是修正而不是回归。
   出处："预览不用它……测响度(measure_audio 的 timeline 档,浏览器把这份清单发给服务端)"——`src/kernel/audioPlan.mjs` 文件头；`audioPlanOf` 只收 `c.mediaId` 有素材的片段；`server/vite-plugin-audio.ts` 的 timeline 分支只拼素材文件。

## 1. 假设

- **范围**：预览播放、音频图卡求值、导出混音、响度测量、时间轴波形，一共五块，全部改到浏览器里做。**不在范围内**：
  - 语音转文字（`python/promptcut_stt`，分析类功能）；
  - 画面合成（ffmpeg 的 `composePreview`）；
  - 画面的逐字节对账。
- **本地模式导出时，ffmpeg 只做一件事**：把页面编好的 AAC 按 `-c copy` 原样装进 mp4，不解码、不混、不重编码。这一步只是装进容器，不算音频处理。要不要连这一步也搬进 JS，是第 6 节待定 2。
- **「浏览器端」的含义**：
  - 本地模式下，是编辑器页面加上 puppeteer 开的导出 / 混音页；
  - 在线浏览器模式下，是用户自己的标签页。

  两者跑同一份代码。
- **比对口径**：沿用 `audio_determine_plan.md` 第 1 节，`maxRel ≤ 0.08`，只比 PCM。

## 2. 现状清单：哪里用了什么、改成什么

| 块 | 现在 | 改成 | 文件 |
|---|---|---|---|
| 素材解码（给音频图卡） | 服务端 `GET /@media/<hash>/pcm`，由 ffmpeg 按区间裁 | Worker 里 JS 解封装 + `AudioDecoder` 按区间解 | `src/render/cards/audioSources.ts`、`server/vite-plugin-media.ts` |
| 预览播放 | 每段声音一个 `<audio>` 元素，按 `planSync` 追播放头；挂了效果的才接进 Web Audio | 一个 `AudioContext` 调度引擎：Worker 提前 2 秒算块，`AudioBufferSourceNode` 按时刻拼接，后面接效果链 | `src/editor/preview/MediaLayers.tsx`、`src/audio/previewAudio.ts` |
| 音频图卡预览 | 整段算完编成 WAV 再交给 `<audio>` | 和素材走同一个调度引擎，边算边播 | `src/audio/cardAudio.ts` 的 `acquireCardAudioClipUrl` |
| 导出混音 | ffmpeg 先把每段裁成 wav；整条时间轴一个 `OfflineAudioContext` 一次渲完；整段 POST；ffmpeg 编 AAC；失败时退回 ffmpeg 直接混（没有效果） | 页面按 10 秒一段加预滚分段渲，每段编成 AAC 立刻追加上传；ffmpeg 只 `-c copy` | `src/audio/renderMix.ts`、`server/bakery/audio-mix.mjs`、`server/bakery/mux-audio.mjs`、`server/bakery/export.mjs` |
| 响度 | 服务端 ffmpeg `ebur128` | JS 实现 EBU R128，量导出同一条混音 | `server/vite-plugin-audio.ts`、`src/mcp/common.ts` 的 `measure_audio` |
| 波形 | `decodeAudioData` 把整个文件读进内存解 | Worker 按区间解码，只存峰值，按素材哈希缓存 | `src/editor/timeline/AudioWaveform.tsx` |

内存的原因：
- 现在导出 10 分钟时间轴，光输出缓冲就要 `600 × 48000 × 2 × 4 B ≈ 230 MB`，编 WAV 时再复制一份，峰值约 460 MB；每段素材还要再各解一份。
- 分段之后，每段最多（10 秒 + 预滚 8 秒）× 384 KB/s ≈ 6.9 MB，和时间轴多长无关。

出处："const ctx = new OfflineAudioContext(2, length, sr)"——`src/audio/renderMix.ts` 的 `renderMix`；`encodeWavFloat32` 另开 `new ArrayBuffer(44 + bytes)`。

## 3. 推荐方案和候选

**推荐：一个「音频内核」，三个外壳。**

内核跑在 Worker 里，负责三件事：解封装、解码、求值音频图卡。三个外壳共用这个内核：
1. **预览引擎**：主线程上的 `AudioContext` 调度；
2. **分段渲染器**：导出和测响度用，`OfflineAudioContext` 逐段渲；
3. **判重 / 预渲染**：见 A6。

效果链继续用 `src/audio/fxChain.ts`，预览和导出共用，这条原则不变。
出处："预览……和导出……都调这里的 buildFxChain —— 同一份代码、同一套 DSP,所以编辑台听到的就是导出的"——`src/audio/fxChain.ts` 文件头。重构之后，**解码**也变成同一份，这条原则比现在更彻底。

**候选路线和不选的理由：**
- **ffmpeg.wasm**：格式最全，但体积约 30 MB；要开多线程还得加跨源隔离头，会和舞台 iframe 的隔离方案相互牵连。只在第 6 节待定 3 选「补格式」时才考虑。（一般经验，无原文；体积没有实测。）
- **继续用 `<audio>` 元素播放素材，只把音频图卡改成 JS**：改动小，但预览和导出的解码不是同一份，流式和内存问题也只解决了一半，不满足「完整重构」。

## 4. 步骤

每步照项目惯例派 Opus 进子 worktree，回来由主会话审查、重跑 `tsc` / `npm test` 后合并。
出处："可解耦的子任务派 Opus 进子 worktree……回来由我审查、重跑 `tsc` / `npm test` 后 `--no-ff` 合并"——`docs/archive/restructure_planning/hand_off.md` 第 6 节。
端口按 10 个一段分，A 系列从 5231 起。

依赖关系：`A0 → A1 → {A2, A3, A4, A5} → A6 → A7`。A2～A5 可以并行，但 A3 和 A4 都会碰 `fxChain.ts` 的调用方式，合并时要注意。

### A0 前置（1 天）

- 做 `audio_determine_plan.md` 的 T8（比对工具 `scripts/probes/audio-compare.mjs`）和 T4（WebView2、iPad 上的 WebCodecs 支持表）。
- 选定解封装的做法（第 6 节待定 1），并准备测试素材：每种格式一个短样本，放 `out/audio-fixtures/`，不进仓库。样本清单：
  - mp4 + AAC；mov + AAC；
  - mp3（带 LAME 头）；
  - wav（16 位、24 位、float）；aiff；
  - flac；ogg + Vorbis；ogg + Opus；
  - webm + Opus；
  - adts；
  - 一个 AC-3 视频（用来验证「不支持」的提示）。
- **完成的标志**：比对工具的三组自检都过；三台设备的支持表写进 `audio_determine_plan.md` 的 T4 一节。

### A1 音频内核：Worker 里的解封装 + 按区间解码（3～4 天）

- 新文件 `src/audio/kernel/`，对外只有一个接口：`decodeRange(source, startFrame, count) → Float32Array`（48 kHz 立体声交错，和现在 `/pcm` 返回的格式一样，调用方不用改口径）。
  出处："路由固定 `ch=2`"——`src/render/cards/audioSources.ts` 的 `MEDIA_PCM_CHANNELS`。
- **读取**：本地模式对 `/@media/<文件>` 发 HTTP Range 请求（静态文件服务，不算处理）；在线模式对素材云端的地址发同样的请求；拖进来的文件用 `File.slice`。只读索引和用到的那几块，不整份读。
- **按区间解码**：先找目标位置之前最近的同步点，再多解一段预滚（AAC 至少 2 个包），扔掉预滚部分，只返回要的那一段。
- **开头对齐**：
  - mp4 里读 `edts/elst` 扣掉编码器的起始空白；
  - mp3 读 LAME 头里的 delay / padding；
  - 其余格式按规范处理。

  这是最容易错的一步，验收单列（见下）。
- **重采样**：用 `OfflineAudioContext` 做（原生实现），或者 JS 的多相滤波。统一到 48 kHz。
- **缓存**：按（素材哈希、块号）做 LRU，上限按内存档分，桌面 64 MB，低内存档 16 MB。
- **验收**：
  1. 每个样本和参考 PCM 比，`maxRel ≤ 0.08`，同时记 `rmsDb`。参考 PCM 用 ffmpeg 预先生成、存成测试夹具，ffmpeg 只在开发时用一次，产品路径不调用。
  2. **开头对齐**：在一个带「咔」声的样本上找峰值位置，和参考相差 ≤ 1 个 AAC 包（1024 个采样，约 21 ms）。
  3. 随机跳到 100 个位置解 0.5 秒，每次都和参考对齐。
  4. 10 分钟的 4K 视频（大于 1 GB）取中间 5 秒，内存增长 < 20 MB，耗时 < 200 ms。

### A2 音频图卡接内核（1～2 天）

- `audioSources.ts` 的 `mediaBlock` 从 `fetch('/@media/<hash>/pcm')` 改成调内核的 `decodeRange`。
- 求值搬进 Worker（用户卡在 Worker 里 import，和画面卡的注册表一样，按源码版本重载）。
- 缓存键按 `audio_determine_plan.md` 第 2.4 节补全：加上参数和输入身份。
- 删掉 `acquireCardAudioClipUrl` 那种整段编 WAV 的做法。
  出处："Preview's <audio> needs one seekable URL, so join blocks into one local WAV"——`src/audio/cardAudio.ts`。
- **验收**：
  - `src/audio/cardAudio.test.mjs`、`src/render/cards/audioSources.test.mjs` 全部改到新路径后全绿；
  - 探针里的 9 张合成卡在新路径下和旧路径的输出 `maxRel ≤ 0.08`，纯的卡应当逐样本相同；
  - `cloud-task.md` L 节「素材输入的音频图卡报错」这条改成「支持」。

### A3 预览播放引擎（3～4 天）

- **播放**：一个 `AudioContext`（48 kHz）。每个正在出声的片段一个「声部」：
  - Worker 提前 2 秒算好 0.5 秒一块；
  - 用 `AudioBufferSourceNode.start(when)` 在精确时刻无缝拼接；
  - 后面依次接 `GainNode`（音量 × 淡入淡出曲线，复用 `kernel/audioPlan.mjs` 的 `fadeEnvelope`）和 `fxChain`。
- **跟住 t**（pinned 架构 10）：
  - 引擎以舞台报来的 t 为准，把 t 换算成 `AudioContext` 的时刻来排块。
  - 停顿超过 40 ms 就 `ctx.suspend()`，恢复时从当前 t 重新排块。
  - 漂移小于 40 ms 不动；达到 40 ms，就在下一个块边界重排，用 5 ms 淡入淡出防咔哒。

  出处："音频跟着 t（停顿超过约 40 毫秒就暂停音频、恢复时对齐）。阈值固定 40 毫秒"——`docs/archive/user_pinned_goal.md` 架构 10。
  **看门狗（交接文档的待定 5b）在新引擎里就是「定时器到点就 `suspend()`」，实现成本很低，但加不加仍然要你定。**
- **拖动**：照现在的行为，拖动时不出声，松手后按新 t 排块。
  出处："拖动时鼠标每动一下就是一次"——`src/render/mediaSync.ts` 的 `SCRUB_SEEK_MIN_MS` 注释。现在拖动时 `playing = false`，只 seek、不出声。
- **删除**：`MediaLayers.tsx` 的 `AudioLayer`、`previewAudio.ts` 的 `createMediaElementSource` 接线，以及只给音频用的那部分 `planSync` 调用。视频画面层在舞台里继续用 `mediaSync`，不动。
- **验收**：
  - `playback-probe` 24 / 25 / 30 / 60 fps 各播 10 秒，断音 0 次、主线程长任务 0 次；
  - 声画偏差：拍手样本，画面上的「拍」和声音峰值相差 ≤ 1 帧；
  - 人为卡住舞台 300 ms，音频在停顿开始后 ≤ 80 ms 内停下（只有加了看门狗才能做到；不加，就改测「恢复后 ≤ 1 块内重新对齐」）；
  - 起播延迟 p90 不比现在慢（`audio_determine_plan.md` T3）。

### A4 导出：分段渲染 + 流式写（2～3 天）

- **分段**：窗口 W 缺省 10 秒；每段的预滚 P 取这一段里所有正在出声的片段中，效果尾巴最长的那个：
  - 回声：`time × ln(1e-4) / ln(feedback)`；
  - 混响：`decay`（脉冲响应的长度就是 decay 秒，见 `kernel/audioFx.mjs` 的 `reverbImpulse`）；
  - 压缩 / 限幅：`7 × release`；
  - 滤波：0.05 秒；
  - 音频图卡本身不需要预滚，它按区间随机访问。

  上面几条公式是我按指数衰减推的，还要实测核（A4 验收第 1 条）。
- **尾巴特别长的情况**：尾巴超过 30 秒（比如回声间隔 2 秒、反馈 0.9，算出来约 175 秒），就把 W 放大到 2P，并在导出日志里告警，内存按实际用量计入。
  出处：验证：`longTail`（0.4 秒 / 0.6）预滚 4 秒仍有 0.4% 的误差，和公式估的约 5.4 秒一致。
- **随时间变的效果**：自动化时刻按「段起点 − 预滚」平移，每段各排各的。
- **流式写**：
  1. 每段渲完，立刻交给 `AudioEncoder`（AAC-LC 192k，ADTS 格式）；
  2. 编出来的字节按序号 `POST /api/export/audio-mix/<id>?seq=n` 追加。服务端只按序号拼接写盘，不解析、不处理；
  3. 最后 ffmpeg `-c copy` 装进 mp4。

  在线浏览器模式改写进 OPFS（`FileSystemWritableFileStream`）。
- **编码器起始空白**：AAC 编码器会在开头多出 1024～2112 个采样的空白，ADTS 格式里没有地方记这件事，直接装进 mp4 会让声音整体晚 21～44 ms。做法二选一，由验收决定：
  - 装 mp4 时给 ffmpeg 传 `-itsoffset` 补偿；
  - 由 JS 写 m4a，带上 `edts`。
- **导出对账**：另外产一份 s16 PCM（`--audio-pcm` 开关，缺省关）给比对工具用。
- **删除**：
  - `audio-mix.mjs` 里 ffmpeg 裁段那部分；
  - `mux-audio.mjs` 的 ffmpeg 直接混退路，以及 `--audio ffmpeg` 选项；
  - `renderMix.ts` 的一次渲完。

  出处："'ffmpeg' 走 scripts/mux-audio.mjs 的滤镜图直接混(没有效果),对账和兜底用"——`server/bakery/export.mjs` 头注释。这条退路本身就不带音频效果，和「预览听到的就是导出的」矛盾，删掉不丢能力。
- **验收**：
  1. 同一条时间轴，分段结果和一次渲完比 `maxRel ≤ 0.08`（预期 ≤ 1e-3）；对每种效果单独验证预滚公式。
  2. 新导出和旧导出（旧的 Chrome 混音路径）比 `maxRel ≤ 0.08`。
  3. 10 分钟和 60 分钟两条时间轴导出，混音页渲染进程的内存峰值相差 ≤ 20%，也就是和时长无关。
  4. 成片声画偏差 ≤ 1 ms：拍手样本，解码成片找峰值。
  5. 同一个项目导出两次，PCM 逐样本相同（这条只告警、不卡关，因为 8% 才是门槛）。

### A5 响度和波形（2 天）

- **响度**：JS 实现 EBU R128，全部做纯函数，放 `src/kernel/loudness.mjs`，node 单测也能跑：
  - K 加权（两级 biquad，按 BS.1770 的系数）；
  - 400 ms 块、75% 重叠，−70 LUFS 绝对门限、−10 LU 相对门限，算出综合响度；
  - 3 秒短期响度加 −20 LU 相对门限，取第 10 / 95 百分位，算出 LRA；
  - 4 倍过采样算真峰值。

  量的范围：
  - 素材 / 片段：用 A1 按区间解码；
  - 整条时间轴：用 A4 的分段渲染器边渲边量，不写盘。

  出处："ffmpeg ebur128 的 `LRA low / LRA high` 就是它,实测和自己算的分位数逐位一致(-15.5 / -8.2)"——`docs/archive/topics/audio-fx.md`「先说几件和直觉相反的事」。说明这套算法已经对照 ffmpeg 核过一次。
- **波形**：Worker 按区间解码算峰值，每素材一个峰值文件，按内容哈希缓存（本地放内容库旁边，在线模式放 IndexedDB）。
- **删除**：`server/vite-plugin-audio.ts` 的 `/api/audio/measure`；`measure_audio` 改成在页面里算。
- **验收**：
  - 5 个样本的综合响度和 ffmpeg 参考值相差 ≤ 0.1 LU，真峰值相差 ≤ 0.2 dB，LRA 相差 ≤ 0.2 LU；
  - `server/test/audio-measure.test.mjs` 改写成对 JS 实现的测试；
  - 1 GB 的素材出波形时，内存增长 < 20 MB。

### A6 判重和预渲染（2～3 天，等 `audio_determine_plan.md` 定稿后开工）

- 按那份计划第 2 节实现：
  - 整趟探针加临时分类；
  - 按位置贪心分派；
  - 缓冲水位低时的运行时降级；
  - 缓存键；
  - s16 + deflate-raw 存进 OPFS / 内容库；
  - 就绪索引里加一类 `'audio'`。
- **PC 客户端上传、浏览器拉取**：接口形状照 `cloud-task.md` 的快照上云，第一版可以只把接口留好，和「在线重型控件服务」一样先留口子。
  出处："请为这些内容留接口"——`docs/archive/user_pinned_goal.md` 架构 3。
- **验收**：以那份计划 T1～T8 的判据为准；另加一条，重卡拉不到时静音、界面显示「预渲染中」、播放头不停。

### A7 清理和文档（1 天）

- 删掉服务端的 `/@media/<hash>/pcm`（`server/vite-plugin-media.ts`）和 `server/test/media-pcm.test.mjs`。
- 改 `cloud-task.md`：删掉「Agent 云端环境要预装 `ffmpeg`……`/@media/<hash>/pcm`」这条，Agent 端音频也走 JS；导出装 mp4 还用不用 ffmpeg，看待定 2。
- 改 `docs/archive/topics/audio-fx.md` 的结构图；在音频图卡的作者约定里写明「必须是按区间的纯函数」，并在 `cardAuthoring` 的校验里加上分块无关性检查。
- 更新 `hand_off.md`、`render_pipeline_restructure_check.md`。
- **完成的标志**：
  - `grep -rn "pcm\|ebur128\|aac" server/` 只剩导出装 mp4 那一处；
  - `tsc` 零错误，`npm test` 全绿；
  - 全部探针在 5231 起的端口段里重跑一遍。

## 5. 优点 / 缺点 / 限制

- **优点：满足「服务端不处理音频」，在线浏览器模式第一次有完整的声音**，包括读素材的音频图卡。
  出处："**素材输入的音频图卡报错「该模式暂不支持素材输入的音频图卡」**"——`docs/plan/cloud-task.md` L 节验收。重构后这条限制取消。
- **优点：导出内存和时间轴长度无关**，从约 460 MB 降到每段约 7 MB（第 2 节的算式）。
- **优点：预览和导出连解码都是同一份代码，响度量的也是真正导出的那条声音**（第 0 节第 5 条）。
- **缺点：改动面大。** 现有音频相关测试文件里至少 5 个要重写或删除（下面出处列的那几个）；`<audio>` 元素加 `planSync` 这一路已经调好了一轮（R7b 刚修过 24 / 25 fps 的误判），这次要整体换掉。
  出处：`git ls-files` 里 `mux-audio.test.mjs`、`audio-measure.test.mjs`、`media-pcm.test.mjs`、`cardAudio.test.mjs`、`audioSources.test.mjs` 等；R7b 报告的「必修 4」。
- **缺点：格式覆盖变窄**（WMA、AC-3、DTS），而且现在导出时这些格式还有声音，所以对这些格式是回归。
  出处：第 0 节第 1 条。
- **缺点：导出多了约 26%～42% 的渲染时间**（预滚 2～4 秒对 10 秒一段）。绝对值很小：60 秒时间轴从 0.67 秒变成 0.85～0.96 秒。
  出处：验证：`chunk.all oneShotMs 671.6`，预滚 2 秒 `848.5`、4 秒 `955`。
- **风险（未核实）：AAC 编码器起始空白导致声画偏移**，要到 A4 的验收才知道哪种补偿方法有效。
- **限制：iPad Safari 的 WebCodecs 音频支持没测过。** 如果不支持，在线模式在 iPad 上就只能播放 PC 客户端预渲染好的块，读素材的功能不可用。结论要等 T4。
- **限制：分段渲染和一次渲完不会逐样本相同**（预滚够长时差 1e-7 量级），所以导出对账必须改成阈值，这正是你已经做的决定。
  出处：验证：`chunk.all` 预滚 4 秒、8 秒都是 `1.796e-7`，不为 0。

## 6. 要你定的

1. **解封装：自己写，还是引入库？**
   - 自己写：要覆盖 MP4 / MOV、WAV / AIFF、MP3、ADTS、FLAC、Ogg、WebM 七种容器。仓库里已经有一个只认 fMP4 视频的最小解析器（`scripts/probes/stream-demux-browser.js`，216 行），可以当起点。
   - 引入库：要装依赖，需要你同意；许可证和体积我还没核。

   我建议 A0 先花半天评估一个现成库（许可证、体积、容器覆盖、能不能跑在 Worker 里），再决定。
2. **导出装 mp4 那一步**：接受 ffmpeg `-c copy`（不解码、不处理），还是连这一步也用 JS 写 mp4？后者可以等 R8 的轨道流做 fMP4 写入时一起做。我建议先接受 `-c copy`。
3. **浏览器解不了的格式**（WMA、AC-3、DTS）：
   - (a) 导入时直接提示「请先转成 AAC / Opus / MP3 / FLAC / WAV」；
   - (b) 桌面版导入时，在本地把音轨转一份存进内容库，这等于在本地做处理，和你的决定是否冲突要你判断。

   我建议 (a)。
4. **看门狗**（交接文档待定 5b）：新引擎里加它只要一个定时器，加吗？
5. **这几条要不要钉进 pinned**：「音频全部浏览器端 JS、流式分段」「音频比对按 PCM 最大差 8%」。要的话，我拟好原文弹窗给你勾选。
6. **和 R8 的先后**：A 系列和 R8 的文件交集主要是 `Preview.tsx`（播放状态），可以并行。要并行，还是 R8 先做？

## 7. 第一步

做 A0 里的比对工具（也就是 `audio_determine_plan.md` 的 T8），半天能完成：

```bash
node --no-warnings scripts/probes/audio-determine-probe.mjs --only chunk --json out/audio-chunk.json
```

跑完拿这份结果里的三组已知答案（逐样本相同、预滚 0 约 0.86、预滚 4 秒约 1.8e-7）作为比对工具的自检标准，然后开始写 `scripts/probes/audio-compare.mjs`。
