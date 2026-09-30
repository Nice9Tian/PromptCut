# AGENT-asset-path：Agent 读素材的路径改走素材服务

分支 `claude/asset-path`，worktree `.worktrees/asset-path`，起点 main `82294fea`。任务出处：`docs/plan/TODO.md`「语义与代码的差距」的「Agent 读素材的路径」一条。

**没有改语义，也不需要改二级语义。**

## 状态

完成，待主会话审查。两条测量工具（`measure_audio` 测响度、`measure_audio_js` 自定义测量）已改成经素材服务的 HTTP 接口取字节，输出与改前逐字相同；基线见「验证」。排查出另外 6 处 Agent 会走到的直接读写素材目录的路径，都牵动页面、服务端插件或 Python 多处，只记录没改（见「排查清单」）。

## 提交

| 提交 | 内容 |
|---|---|
| `625173ab` | 文档：建本报告 |
| `43fbe58e` | 修复：两条测量经素材服务的 HTTP 接口取字节 |
| `cf058edd` | 测试：`audio-asset-path.test.mjs` |
| `5727e09a` | 测试：探针 `asset-path-probe.mjs`；`custom-measure-probe.mjs` 端口检查放宽 |
| `a65f0d7e` | 测试：用例改名 AR-（原 AP- 与 `agent-c65-pagestate.test.mjs` 的用例号撞名）；文档：报告写完 |
| （本次） | 文档：报告提交表补全 |

## 做了什么

| 文件 | 改动 |
|---|---|
| `server/audio-source.mjs`（新） | 解析器 `createAssetSourceResolver`：素材记录 → 素材服务上的 HTTP 地址，先用 `Range: bytes=0-0` 探一下，分清三种结果：2xx 用这个地址；404 或拼不出地址回 null（照旧「素材文件不存在」）；取不到基址、连不上、超时、401/403/5xx 抛 `AssetSourceError`（写明素材服务地址与原因）。另有异步的 `hasAudioStreamAsync`、`probeAudioChannelsAsync`（ffprobe 参数与原来相同）。 |
| `server/audio-loudness.mjs`（新） | `measureLoudness`：`/api/audio/measure` 的主体从 `vite-plugin-audio.ts` 原样搬出（回包形状、状态码、报错文字不变），素材从注入的 `resolveSource` 取；多一种回包：素材服务不可达或拒绝读取回 502。搬出来是为了不依赖 vite 就能测。 |
| `server/audio-measure-js.mjs` | `measureJs` 收 `resolveSource`（可异步，旧名 `resolveFile` 仍认），缺省用异步的 ffprobe；素材服务不可达回 `kind: 'asset-service'`。 |
| `server/vite-plugin-audio.ts` | 删掉 `mediaFileOf`（按素材目录找文件）；两条路由都用同一个解析器，基址取 `asset-client.ts` 的 `assetServiceOrigin()`，地址用 `vision/ffmpeg-frames.ts` 的 `mediaSourceOf`（和看画面的素材层同一条），导出期的 `/@export/<id>/media/<文件>` 照原样走编辑器的 HTTP 路由。导出 `audioMediaUrl` 给单测。 |
| `server/test/audio-asset-path.test.mjs`（新） | 用例 AR-1～AR-8，见「验证」。 |
| `scripts/probes/asset-path-probe.mjs`（新） | 端到端探针，见「验证」。 |
| `scripts/probes/custom-measure-probe.mjs` | 端口检查原来写死 5860～5867，按任务要求要跑 `--port 5920`，改成按段判断（占 PORT～PORT+2，同一个 10 口段，不碰 5190～5192、5580～5599）。探针本身的检查项没动。 |

代号说明：A6 指 `docs/plan/agent-workflow-plan.md` 里「Agent 用 JS 自定义测量」那一步（`measure_audio_js`）；AR-n 是本任务单测的用例号（AR = asset read）；P1～P5 是新探针的检查项；M1～M4 是 `custom-measure-probe.mjs` 原有的检查项。

## 〔裁〕

以下都是三级（改了用户看不出区别），语义没写到的细节，按 `suggested_agent_behavior.md`「对齐」自己定：

1. **〔裁〕把素材服务的 HTTP 地址直接交给 ffmpeg 当输入，不先流到临时文件。** 理由：ffmpeg 自己按 Range 分段取，大文件只传需要的那几段（AR-5：34.6 MB 的 wav 测第 150 秒起 2 秒，经素材服务实际传过来 4.4～4.7 MB（两次运行），其中大半是开放区间请求在客户端断开前塞进套接字缓冲的）；不占临时盘、不用清理；与看画面的素材层（`server/vision/ffmpeg-frames.ts`）是同一种读法，已有单测证明经 HTTP 抽的帧与读文件逐字节相同。代价：每次测量多一个探测请求和若干 Range 请求，本机回环上可以忽略。
2. **〔裁〕基址只认本进程的素材服务（`assetServiceOrigin()`），不直接连共享项目登记的远程素材服务。** 共享项目时，本地素材服务的 `/@media/<hash>` 在本地内容库没有这份内容时会向当前连接的远程素材服务按需拉取（`server/media-pull.mjs`，票据也由它带），所以编辑器进程只认一个地址就同时覆盖本机模式与共享项目；这也是 `mediaSourceOf`、预渲染进程读素材的现有写法。探针 P1～P3 验证了共享项目这一路。
3. **〔裁〕解析时先发一个 1 字节的 Range GET 探测**，把「素材服务上没有这份素材」（404，照旧「素材文件不存在」、时间轴档跳过那一段）与「素材服务不可达 / 拒绝」（新报错，时间轴档整次报错，不当成跳过）分开。不可达的报错：`measure_audio` 回 HTTP 502 `{ ok:false, error:"素材服务不可达(<地址>):<原因>" }`，页面侧 `measureAudio` 照旧把 `error` 抛给 Agent；`measure_audio_js` 回 `{ ok:false, kind:"asset-service", error }`。探测时限 10 秒。
4. **〔裁〕ffprobe 改成异步 spawn。** 单进程形态里素材服务就在编辑器进程自己身上，原来的 `execFileSync` 会卡住事件循环，ffprobe 发来的 HTTP 请求没人答，只能等到 15 秒超时再误报「没有音频流」（AR-8 验证三次探测 143 ms 内完成）。
5. **〔裁〕请求体里递进来的 `path` 不再用来读盘。** 地址只由哈希、最后一段文件名、老 .proc 的 `/api/media/file?path=`（那一侧按白名单判）或导出期路由拼成，越界的边界改由素材服务那一侧守（AR-2、AR-7：`path` 指着一个真实存在的文件也不读它）。

## 与改前逐字相同的证据

- 测响度：AR-3 对素材 / 片段 / 时间轴三档、wav / mp3 / m4a / 单声道 wav / mp4 音轨共 9 种请求，同一份请求体分别用「直接交本地文件路径」（原来 `mediaFileOf` 返回的就是这个，参数经 `measureArgs` / `timelineMeasureArgs` 不变）与「经素材服务」各跑一次，整个回包（状态码与 JSON）`JSON.stringify` 后逐字相同。探针 P2 在真的编辑器里对 20 秒噪声素材比了 integrated / truePeak / LRA / LRA low / LRA high / threshold / duration 七项，逐项相同。
- 自定义测量：AR-4 对单文件、片段窗口、m4a 混单声道、mp4 音轨、时间轴混音窗口、时间轴混音单声道 6 种参数，`decodePcm` 解出的每个声道 `Float32Array` 字节逐字节相同；再经真的沙箱跑 3 种 `measureJs`，结果（去掉 `elapsedMs`）deepEqual。探针 P3、P4 在真的编辑器里比了沙箱里算的 PCM 的 FNV-1a 指纹与帧数。

## 发现：时间轴档的逐秒曲线偶发缺点（改前就有，与读法无关）

`measure_audio` 时间轴档里，**有一段先于时间轴结尾结束时**，ffmpeg 9 的 amix 偶发给之后的帧打上 NOPTS 时间戳，ebur128 打出 `t: -192153584101141.0625`（= INT64_MIN / 48000），`parseEbur128` 的 `t:\s*([\d.]+)` 匹配不到负数，逐秒曲线在那之后缺点（integrated 等汇总值不受影响）。用改前的读法（直接读本地文件）重复 30 次，缺点 2 次；第一次跑单测时经素材服务的那一次缺点、第二次复现时直接读文件的那一次缺点，两边都会出。AR-3 的时间轴用例因此让几段都放到时间轴结尾，避开这个偶发。建议另开一项修（例如在 `timelineMeasureArgs` 的 amix 之后、ebur128 之前加 `asetpts=N/SR/TB`，或解析时按帧序号补时间），它会改动时间轴档在出错那几次的输出，不属于本任务「输出与改前逐字相同」的范围，没动。

## 排查清单

范围：Agent 工具会走到的服务端路径（`server/tools/` 的工具定义 → `src/mcp/handlers/` 在页面里执行 → 调的 `/api/*`，以及 `server/agent/agent-exec.mjs` 在服务端直接执行的那几条）。预渲染进程、导出不在范围。

| # | 工具 | 位置 | 读写的是什么 | 改的难度 |
|---|---|---|---|---|
| 1 | `measure_audio`、`measure_audio_js` | 原 `server/vite-plugin-audio.ts` 的 `mediaFileOf` | 按素材目录找文件交 ffmpeg | **已改**（本任务） |
| 2 | `detect_shots` | 页面 `src/mcp/handlers/ai.ts:34,42` 要求并发送 `media.path`；服务端 `server/vite-plugin-shots.ts:307-308` 收 `body.path`（任意绝对路径）`existsSync` 后交 ffprobe / ffmpeg / Python（TransNetV2） | 直接读素材服务存储里的原文件；共享项目里没有本机 `path` 的素材用不了 | 中：页面改成发 `mediaId` / `url` / `hash`，服务端用本任务的解析器换成 HTTP 地址；`python/promptcut_shots/detector.py` 用 ffmpeg 子进程解帧，吃 URL 应无问题但要验；缩略图那一步同理。三处一起改、要补测试，只记录 |
| 3 | `track_points` | `src/mcp/handlers/ai.ts:150,155`；`server/vite-plugin-track.ts:205-206` | 同上 | 中：同 2，Python 侧 `promptcut_track` 要验 |
| 4 | `detect_subjects` | `src/mcp/handlers/ai.ts:288,338`；`server/vite-plugin-subject.ts:316-317` | 同上（`python/promptcut_subject/frames.py` 每个时刻起一次 ffmpeg 抽帧，吃 URL 应可行） | 中：同 2 |
| 5 | `voice_generate` | `server/vite-plugin-voice.ts:113`（`outDir: mediaDir(root)`），页面 `src/mcp/handlers/audio.ts:77` 再按回来的 `url` / `path` 导入 | **写**：TTS 结果直接写进素材目录，没经素材服务的上传入库（`product/asset-service.md`「入库这一步不能省」） | 中：服务端改成生成到临时目录后经素材服务分片上传入库、回哈希地址；页面的导入要跟着改 |
| 6 | `collect_download` | `server/vite-plugin-collect.ts:184`（yt-dlp `--out-dir mediaDir(root)`）、`:508` | **写**：下载结果直接落进素材目录 | 中偏大：yt-dlp 要落在临时目录，完成后入库；牵动下载作业的进度与结果回报，只记录 |
| 7 | `bake_card` | `server/vision/bake.ts:249,359`、`server/vision/bake-cache.ts:19,50`（经 `agent-exec.mjs:486` 转预渲染进程） | **写与读**：卡片快照 PNG（预渲染的产物）直接写进 / 列出 / 删除素材目录里的 `bake-*.png`，回 `/@media/bake-….png` | 大：`product/asset-service.md`「预渲染的产物」要求产物推送到素材服务；这条在预渲染进程里跑、又牵动缓存淘汰（`listBakes` / `evictBakes`），按语义判断属于产物入库一类，只记录 |
| 8 | （提示词）附件 | `server/vite-plugin-ai.ts:994-998` | 给模型的提示词里写附件的「磁盘路径」 | 小，但要定语义：CLI Agent 只放行 `mcp__promptcut__*`，读不了这个路径，同一文件 `:979-980` 的注释已说明素材库那几条为此去掉了磁盘路径；附件这条没去。是否去掉要看附件是不是素材服务里的素材，只记录 |

不需要改的（查过）：`/api/vision/sheet` 与看画面的素材层已经经素材服务的 HTTP（`server/vision/ffmpeg-frames.ts`）；`server/vision/http.ts:57` 只拿 `path` 的文件名拼 `/@media/` 地址，仍走 HTTP；`/api/ai/visual`（`server/ai-visual.mjs`）只读写自己的产物目录；`transcribe_media` 是页面把内存里的 `File` 上传给 `/api/stt/upload`，不读素材目录（素材不在内存里时直接报错，另一回事）；`server/harness/tools/textEditor.mjs` 限在 `exports/ai-workspace/`。

## 验证

跑测试与探针前都设了 `PATH` 里的 winget ffmpeg 9.0.1。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 错误（改完代码后、写完测试后各跑一次） |
| 全量测试 | `npm test` | 退出码 0：tests 4097、pass 4095、fail 0、skipped 2（两条跳过是原有的：`/api/cards/layout` 集成、SKILL 闸门集成，都要自己起的 dev server）；跑 1 遍，一次过 |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs").then(...)'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与任务书给的相同 |
| 本任务单测与相关单测 | `node --test server/test/audio-asset-path.test.mjs server/test/custom-measure.test.mjs server/test/audio-measure.test.mjs server/test/creativity-gate.test.mjs server/test/asset-service.test.mjs server/test/vision-media-source.test.mjs` | 退出码 0：53 通过、0 失败、0 跳过。`audio-asset-path` 单独又连跑 5 遍，每遍 8/8 |
| 原有探针 | `node scripts/probes/custom-measure-probe.mjs --port 5920` | 退出码 0，「探针通过:21 项」（M1～M4 全过，M3 里低、中档的内置 `measure_audio` 也照常，integrated -6） |
| 新探针 | `node scripts/probes/asset-path-probe.mjs --port 5920`（远程素材服务占 5925） | 退出码 0，「探针通过:17 项」 |

单测用例（`server/test/audio-asset-path.test.mjs`）：

- AR-1 解析器：取不到基址、连不上（端口已关）、超时（300 ms 不答）都抛 `AssetSourceError` 且写明地址与原因；401 回「拒绝了读取(HTTP 401)」；404 回 null；206 回地址；探测只要 1 个字节。
- AR-2 地址拼法（转译 `vite-plugin-audio.ts` 取 `audioMediaUrl`）：哈希优先、`path` 只取文件名、老 `/api/media/file?path=` 原样、`/@export/<id>/media/` 原样、`blob:` 回 null。
- AR-3 测响度：起真的素材服务（`server/asset-service.ts` + 媒体中间件，fs 内容库，素材经分片上传入库），素材记录的 `path` 指向不存在的目录；9 种请求经素材服务与直接读文件的回包逐字相同，每种都在素材服务上看到了 ≥ 2 次 GET。
- AR-4 自定义测量：6 种解码参数 PCM 逐字节相同；3 种 `measureJs` 经真沙箱结果相同，且看到 ffmpeg 发来的非探测 GET。
- AR-5 大文件：34 560 078 字节的 wav 入库 5 个分片；片段档测第 150 秒起 2 秒，回包与直接读文件逐字相同；请求序列 `bytes=0-0`（探测）、`bytes=0-`、`bytes=78-`（ffprobe）、`bytes=0-`、`bytes=78-`、`bytes=28800078-`（ffmpeg 定位到 150 秒处），经素材服务传过来 4 390 913 / 4 718 593 字节（两次运行）；同一段的 PCM 也逐字节相同。
- AR-6 素材服务不可达：测响度回 502 与「素材服务不可达(<地址>)…」，时间轴档也回 502 不当成跳过；自定义测量回 `kind: 'asset-service'`，取不到基址时也一样；沙箱一次没进。
- AR-7 素材服务上没有（404）：「素材文件不存在」（`path` 指着真实存在的文件也不读）；没有音频流的 mp4 仍是「该文件没有音频流」；时间轴档跳过那一段并在 notes 里点名；自定义测量回 `no-media`。
- AR-8 单进程形态：素材服务就在测试进程里，三次异步 ffprobe 探测 143 ms 内完成，期间本进程的定时器照常转。

新探针（`scripts/probes/asset-path-probe.mjs`）：自己起编辑器（5920，`PROMPTCUT_NO_PORT_FILE=1`，临时目录），另在 5925 起一台计数的「远程素材服务」；测试音频只放在远程那台上，编辑器的素材目录一开始是空的，素材记录的 url 是不带扩展名的 `/@media/<hash>`、`path` 指向不存在的目录。

- P1 编辑器经 `POST /api/media/remote` 连上远程素材服务（共享项目时页面做的事）。
- P2 `measure_audio` 测 20 秒噪声：`{"integrated":-20.6,"truePeak":-12.8,"lra":0.1,"lraLow":-20.6,"lraHigh":-20.6,"threshold":-30.6,"duration":20}`，与探针自己直接读本地文件算的逐项相同；远程素材服务收到 `GET /api/asset/media/20f3f70a…` 1 次 —— 字节确实经素材服务的接口来。
- P3 `measure_audio_js`（登记为「高」的对话）测正弦波：两声道 RMS -9.0309 dBFS、峰值 -5.98 dBFS，与理论值一致；沙箱里的 PCM 指纹 3069163361、48000 帧，与探针直接解码本地文件的相同；远程收到这份素材的 GET 1 次；片段档 mono 48 kHz 照常。
- P4 断开远程回到本机空间：本地内容库里是 `<hash>.wav` 与 `index.json`，按目录拼 url 最后一段或文件名都找不到（改前的 `mediaFileOf` 在这里会报「素材文件不存在」），只有素材服务按哈希找得到；两条工具照常、数值与指纹不变；远程一次没被打到。
- P5 哪儿都没有的素材：`measure_audio` 回「素材文件不存在」，`measure_audio_js` 回 `kind: 'no-media'`；编辑器照常应答，页面没有未捕获的异常。

两支探针都只停了自己起的编辑器进程树和计数服务；没有碰 5190～5192、5580～5599。

## 没做成的

- 排查清单第 2～8 项只记录没改：每项都牵动页面 handler、服务端插件与 Python 或预渲染进程多处，超出「小而清楚」。
- 托管部署（反向代理之后、`PROMPTCUT_TRUST_LOOPBACK=0`）时，回环请求也要票据，编辑器进程自己请求 `/@media/<hash>` 会被拒；这时两条测量工具回「素材服务拒绝了读取(HTTP 401)」这句清楚的错，而不是读成功。看画面的素材层（`mediaSourceOf`）也是同样的处境。托管端的编辑器进程里是否会跑这两条工具、要不要给编辑器进程自己配票据，需要主会话判断。

## 更正建议

- `docs/plan/TODO.md`「语义与代码的差距」的「Agent 读素材的路径」一条：本分支合入后可改成「`measure_audio` / `measure_audio_js` 已改（`claude/asset-path`）；同类的直接读写还有 `detect_shots`、`track_points`、`detect_subjects`（读 `media.path`）、`voice_generate`、`collect_download`（直接写素材目录）、`bake_card`（产物直接写素材目录），见 `AGENT-asset-path.md` 排查清单」。
- 另记一条偶发：时间轴档测响度的逐秒曲线偶发缺点（ffmpeg amix NOPTS），见上文。
- 语义不需要改。

## 需要主会话决定的事

1. 合并本分支（`--no-ff`）还是返工。
2. 排查清单第 2～7 项是否另开任务，按什么顺序（建议先做 2～4，它们在共享项目里直接不可用；5、6 是写入绕过入库；7 牵动产物推送，最大）。
3. 时间轴逐秒曲线的 ffmpeg 偶发要不要另开一项修。
4. 托管部署下编辑器进程自己读 `/@media` 要票据的问题（见「没做成的」第二条）。
