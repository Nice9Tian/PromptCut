# AGENT-asset-path-2：感知工具与写入工具改走素材服务

分支 `claude/asset-path-2`，worktree `.worktrees/asset-path-2`，起点 `claude/r6-merge` 的 `cd37c8ed`。任务出处：`docs/plan/TODO.md`「语义与代码的差距」的「Agent 读素材的路径」剩下几条，即 `AGENT-asset-path.md`「排查清单」第 2～8 行。

**没有改语义，也不需要改二级语义。** 语义文件一个没动；下面的〔裁〕都是三级（改了用户看不出区别）。

## 状态

轻量部分做完、已提交，第一轮审查的四条决定也已处理；重的验证（`npx tsc -b --force`、`npm test`、代码指纹、真起编辑器的探针）按任务书的重活禁令**还没跑**，等主会话发「可以跑重活」。

- 三个感知工具（`detect_shots` 镜头识别、`track_points` 运动追踪、`detect_subjects` 主体检测）：页面只发素材标识，服务端经素材服务的 HTTP 地址取字节，请求体里的 `path` 不再读盘。
- 两个写入工具（`voice_generate` 配音、`collect_download` 素材收集）：先落临时目录，再经素材服务的入库接口 `POST /api/media/upload/<文件名>?tiers=1`（用户导入素材走的同一条）进内容库，回入库后的标识，页面按它登记。
- 配音的试听、音色设计与复刻的试听：改落数据目录下的试听缓存 `cache/voice-preview/`，经 `GET /api/voice/preview/<文件名>` 回放，不再写素材目录（〔裁〕4）。
- `bake_card`：只调查，dry run 见下文；主会话已定另开任务。
- 提示词里附件那一条不再给磁盘路径。
- 按主会话第一轮审查：要真 Python 的检查挪进探针（P6～P11），单测只留不依赖 Python 的部分，`npm test` 的跳过数不随机器变。

## 提交

| 提交 | 内容 |
|---|---|
| `2f58a0ec` | 文档：建本报告 |
| `6df39fb2` | 修复：三个感知工具、两个写入工具、提示词附件 |
| `1fadea91` | 测试：`collect-plugin.test.mjs` 改为经真的素材服务入库（MI-5），假解释器 `fake-collect.cmd` 把文件写进作业的临时目录 |
| `53a6fb3d` | 测试：`perception-asset-path.test.mjs`（PK-1～PK-8、MI-1～MI-4）与素材收集 MI-6 |
| `021d75a5` | 文档：报告（轻量部分） |
| `5d0a2521` | 测试：要真 Python 的检查挪进探针 `asset-path-probe.mjs`（P6～P11），单测 PK-2、PK-3 改用假的解释器 |
| `35b26d3a` | 修复：配音试听、音色设计与复刻的试听改落试听缓存（MI-7） |
| （本次） | 文档：报告按第一轮审查更新 |

代号说明：PK-n 是本任务感知工具那一组单测的用例号（PK = perception，感知）；MI-n 是写入工具那一组（MI = media ingest，入库）；P6～P11 是探针 `asset-path-probe.mjs` 里本任务加的检查项（P1～P5 是上一段的）。AR-n 是上一段 `claude/asset-path` 的用例号。

## 做了什么

| 文件 | 改动 |
|---|---|
| `server/perception-source.mjs`（新） | `mediaRefOf`：请求体 → 素材标识，只取 `id / name / kind / url / hash`，`path`（含 `media.path`）一概不取。`resolveMediaSource`：用上一段的解析器（`audio-source.mjs` 的 `createAssetSourceResolver`，先发 1 字节的 Range 探测）分清四种结果：2xx 用地址；没有标识 400；素材服务上没有 404；不可达或拒绝 502 且带 `kind: "asset-service"`。`pythonAcceptsUrl` / `pythonInput`：问 Python 包认不认地址，认就递地址，不认就先 `downloadToTemp` 流到临时文件、递路径、作业结束删。 |
| `server/media-ingest.mjs`（新） | `ingestFile`：把本机临时文件流式 POST 到素材服务的 `/api/media/upload/<文件名>?tiers=1`，回哈希、`/@media/<hash>`、入库回包；取不到地址、连不上、超时、非 2xx、回包没哈希都抛 `AssetSourceError` 并写明素材服务地址。 |
| `server/vite-plugin-shots.ts`、`vite-plugin-track.ts`、`vite-plugin-subject.ts` | 删掉收 `body.path` 再 `existsSync` 的写法；解析器与上一段相同（`mediaSourceOf`，基址 `assetServiceOrigin()`）。ffprobe、scdet、抓缩略图直接吃地址；Python 那一半走 `pythonInput`。追踪顺带把 `spawnPython` 抛错的情形收了尾（原来会让作业永远停在 running，现在还会漏删临时文件）。 |
| `python/promptcut_shots`、`promptcut_track`、`promptcut_subject` 的 `__init__.py` 与 `__main__.py` | 包里加 `ACCEPTS_URL = True` 与 `is_media_url`；入口的 `os.path.isfile(args.video)` 检查对 http / https 地址放行。解码本来就是起 ffmpeg / ffprobe 子进程，它们自己按 Range 取，其余代码不用改。 |
| `src/ai/perceptionMedia.ts`（新） | 页面侧的 `perceptionMediaRef`（只拿标识，不拿 `path`）与 `mediaReadyForServer`（不在 pending，且有哈希或非 `blob:` / `data:` 的地址）。 |
| `src/ai/shots.ts`、`track.ts`、`subject.ts`；`src/mcp/handlers/ai.ts`、`vision.ts` | `startShotDetection` / `startTracking` / `startSubjectDetection` 改收素材标识，请求体 `{ mediaId, media }`；原来「没有服务端可读的路径」的判断改成 `mediaReadyForServer`。`vision.ts` 的看镜头那条也调 `startShotDetection`，签名变了只好一起改（任务书没列这个文件）。 |
| `server/vite-plugin-voice.ts` | 正式合成先写 `os.tmpdir()/pc-voice-*`，经 `ingestFile` 入库，回 `{ url: /@media/<hash>, hash, bytes, media: 入库回包, name, provider… }`，不回临时路径，临时目录随即删；素材服务不可达回 502 `kind: "asset-service"`。试听（`preview: true`）、`/api/voice/design` 的试听、`/api/voice/clone` 的示范音改写 `<数据目录>/cache/voice-preview/`，新路由 `GET /api/voice/preview/<文件名>`（文件名只认 `[\w.-]+\.(mp3|wav|flac|pcm)`，服务商给的音色 id 拼进文件名前洗掉别的字符）回放；页面本来就照回包里的地址播（`src/voice/VoiceSettings.tsx`），不用改。 |
| `server/vite-plugin-collect.ts` | yt-dlp 的 `--out-dir` 改成这个作业自己的临时目录 `pc-collect-*`；进程退出、见到 `done` 之后进入新阶段 `ingest`，对 Python 报上来的每个文件（只取文件名最后一段、只认临时目录这一层）调 `ingestFile`，作业结果的 `items` 带 `url: /@media/<hash>`、`hash`、`media`，不再带 `path`；入库失败作业报错「下载好了但没能送进素材库:…」；临时目录无论成败都删。`/download` 回包去掉 `outDir`。 |
| `src/ai/voice.ts`、`src/ai/collect.ts`、`src/mcp/handlers/audio.ts`、`collect.ts`、`src/editor/io/index.ts` | 类型跟着改（`VoiceResult.media`、`CollectItem.media`、阶段 `ingest`）；`importAudioFromServer` / `importVideoFromServer` 改收 `uploaded`（入库回包），按 `applyUploadedMedia` 写回哈希、扩展名、两档（与导入素材同一个写法），不再调 `/api/media/adopt` 就地补算哈希。`collect_job` 回给 Agent 的每一项把 `path` 换成 `hash`。 |
| `server/vite-plugin-ai.ts` | 附件那一条去掉两处「磁盘路径」（`a.path`，以及按 `public/` 拼出来的路径），标题改成「附件(在对话的工作目录里,不在素材库;要剪辑、转写或配动效,先用 import_media 传它的站内地址装进素材库)」，与 `import_media` 的工具说明一致。 |
| `server/test/perception-asset-path.test.mjs`（新）、`collect-plugin.test.mjs`、`fake-collect.cmd` | 见「验证」。 |
| `scripts/probes/asset-path-probe.mjs` | 加 P6～P11（感知工具与要真 Python 的检查），编辑器带 `PROMPTCUT_PYTHON`（本机带 numpy 的 Python）、`PROMPTCUT_PYLIBS` / `PROMPTCUT_MODELS`（探针的临时目录）起；远程素材服务按扩展名回 Content-Type。**还没跑**。 |

## 〔裁〕

都是三级，语义没写到的细节按 `suggested_agent_behavior.md`「对齐」自己定：

1. **〔裁〕Python 那一半新包递地址、老包流到临时文件。** 任务书说 Python 吃不了 URL 的先流到临时文件。三个 Python 包的解码都是起 ffmpeg 子进程，吃地址只差入口那一句 `isfile` 检查，所以改成认地址（主体检测每个采样时刻只按 Range 取那一段，不必整份拷下来）。但桌面版的 Python 包在打包时复制进运行时的 `site-packages`（`desktop/scripts/prepare-python.mjs`），只打 Node 这一半的补丁（`--patch-only`）时运行时里的包还是旧的，旧包见到地址会报「找不到视频文件」。所以 Node 侧先用一行 `python -c` 问包里有没有 `ACCEPTS_URL`（约零点几秒，问不出来按不认），不认就退回临时文件（`os.tmpdir()/pc-perception-*`，作业结束删）。PK-7 用改回旧样子的包验证了这条退路。
2. **〔裁〕素材服务上没有的回 404，不可达回 502，没有标识回 400。** 原来三条接口一律 400「找不到视频文件」。页面侧照旧把 `error` 抛给 Agent，报错文字写明是哪一种。
3. **〔裁〕入库用 `/api/media/upload/<文件名>?tiers=1`，不用分片接口 `/api/asset/media/…`。** 任务书要求和用户导入走同一条路，页面导入（`uploadMediaFile`）用的就是这条；视频顺带做 faststart 判定、排素材小尺寸，和导入一致。基址同样只认本进程的素材服务（`assetServiceOrigin()`）。
4. **〔裁〕配音的试听、音色设计与复刻的试听落试听缓存，不入库。** 它们只在设置面板里听一下（`voice-preview-<服务商>.mp3` 每次覆盖，`voice-design-*.mp3`、`voice-clone-*.mp3`），不是素材，入库只会往内容库里塞没人引用的字节；原来直接写素材目录，绕过了素材服务。现在写 `<数据目录>/cache/voice-preview/`（不是素材服务的存储目录），由配音插件自己的 `GET /api/voice/preview/<文件名>` 回放，回包里的地址跟着换，页面照回包地址播，不用改。按主会话第一轮审查的决定做。
5. **〔裁〕素材收集按内容去重，不再按文件复用。** 原来 yt-dlp 落在素材目录，同一条链接再下时能看到已有文件就跳过；现在每个作业一个临时目录，同一条链接再下会重新下载，入库时按内容哈希去重（素材库不会多一份）。`collect_job` 里「已下好的文件会被复用」那句提示跟着改了。
6. **〔裁〕`collect_job` 回给 Agent 的项目里去掉 `path`，换成 `hash`。** 原来的 `path` 指向素材目录里的文件，Agent 读不了；现在临时文件入库后就删了，给出来只会误导。

## 验证

跑单测前都设了 `PATH` 里的 winget ffmpeg 9.0.1。按重活禁令，下面都是一次一个测试文件。

| 项 | 命令 | 结果 |
|---|---|---|
| 本任务单测 | `node --test server/test/perception-asset-path.test.mjs` | 退出码 0：10 通过、0 失败、0 跳过，约 2.4 秒（第一轮审查后：去掉要真 Python 的 PK-6～PK-8，PK-2 / PK-3 改用假解释器，加 MI-7）。挪之前那一版 12 条也全过，其中 PK-6～PK-8 的检查现已搬进探针 |
| 素材收集插件 | `node --test server/test/collect-plugin.test.mjs` | 退出码 0：17 通过、0 失败、0 跳过（含 MI-5、MI-6） |
| 相关单测 | `node --test server/test/voice.test.mjs`；`server/test/media-hash.test.mjs`；`src/kernel/subject.test.mjs` | 18 / 11 / 29 通过，0 失败 |
| 类型检查 | `npx tsc -b --force` | **未跑**（重活禁令） |
| 全量测试 | `npm test` | **未跑**（重活禁令） |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | **未跑**；本任务没动 `server/frame-*`、`src/render/`、卡片，预期不变 |
| 探针 | 扩 `asset-path-probe.mjs` 或新写 | **未写未跑**（要起 dev server，属重活） |

单测用例（`server/test/perception-asset-path.test.mjs`；插件经 typescript 转译后直接挂在 http 上，素材服务是真的：fs 内容库 + 媒体中间件，前面挂一个计数的转发；**不依赖本机 Python**，没有 ffmpeg 时 PK-4 起跳过，与上一段 AR 用例同一个做法）：

- PK-1 请求体 → 素材标识：`path`、`media.path` 不取；只有 `path` 的老请求体 400 且一个请求都不发；404、502（写明地址）分得清。
- PK-2 用假的解释器（node 子进程写 1 / 0）：答 1 才算认；答 0、退出码非 0、解释器起不来、spawn 抛错都按不认；问的参数是 `-c` 加那一行代码，不含 cmd 元字符（`.cmd` 解释器会拒绝）。
- PK-3 给 Python 的输入：认地址原样递地址；不认就流到临时文件，30 万字节逐字节相同、扩展名照素材名、cleanup 连目录删；404 与连不上抛 `AssetSourceError` 且不留临时目录。
- PK-4 镜头识别（scdet 档，空项目根没有 Python）：素材记录的 `path` 指向不存在的目录；两次硬切的时刻、三个镜头、时长、帧率与直接对本地文件跑 scdet / ffprobe 的相同；两张缩略图与直接对文件抽的逐字节相同；素材服务上看到第一下 `bytes=0-0` 探测，其后是 ffmpeg 的读取。
- PK-5 三条接口各自：只给 `path`（指着真实存在的视频）或 `media` 里只有 `path` → 400，不起作业、素材服务一个请求都没收到；标识指向不存在的哈希、同时带真实文件的 `path` → 404「素材服务上没有这份素材:丢了.mp4」，不拿 `path` 顶替；素材服务端口已关 → 502 `kind: "asset-service"`。
- MI-1 入库：哈希是内容的 sha256、字节经 `/@media/<hash>` 取回相同、第二次 `deduped: true`，走的是 `/api/media/upload/`。
- MI-2 取不到地址、连不上、HTTP 500（带回包文字）→ `AssetSourceError`；要入库的文件不见了 → 普通错误。
- MI-3 配音（服务商请求在测试里截下，回 3 字节的假 mp3）：回 `/@media/<hash>`、`hash`、`media`，不回 `path`；字节在内容库里；编辑器自己的素材目录是空的；`pc-voice-*` 临时目录删了。
- MI-4 配音时素材服务不可达：502 `kind: "asset-service"`，素材目录与临时目录都不留东西。
- MI-5（`collect-plugin.test.mjs`）素材收集：`/download` 不再回 `outDir`；作业 `items[0]` 带 `hash`（= 假文件内容的 sha256）、`url: /@media/<hash>`、`media`，没有 `path`；字节经素材服务取回相同；编辑器自己的素材目录是空的。
- MI-6（同上）素材服务不可达：作业报错并写明地址，`items` 为空，素材目录与 `pc-collect-*` 临时目录都不留文件。
- MI-7 配音试听：回 `/api/voice/preview/voice-preview-minimax.mp3`，不回磁盘路径，经这个地址取回的就是合成的字节；音色设计的试听同理，服务商给的音色 id `ttv-voice/1` 拼进文件名时斜杠洗成下划线；`..%2F..%2Fpackage.json`、`..%5Cai.json`、`x.txt`、空名都回 404；素材目录里没有试听文件。

挪进探针的检查（第一轮审查前在单测里跑过、全部通过；现在是探针的 P7～P11，**还没在探针里跑**）：

- P7（原 PK-6）运动追踪（模板匹配档）：经地址追出来的 `engine / width / height / frames / points` 与直接对本地文件跑 `promptcut_track` 的逐项相同；20 帧，方块右移约 57 像素。
- P8（原 PK-8 前半）主体检测：这台机器没装主体检测拓展，作业停在「未就绪」而不是「找不到视频文件」（地址过了入口检查）。
- P9（原 PK-2 前半）三个 Python 包都答 `ACCEPTS_URL`。
- P10（原 PK-7）老包：照仓库拷一份、去掉 `ACCEPTS_URL` 与放行；它确实拒绝地址；Node 改走临时文件，字节相同、结果与直接读文件相同、用完删。单测里那一版是经插件跑的；探针里在探针进程中直接调 `pythonInput`，因为编辑器进程起来之后换不了 pylibs。
- P11（原 PK-8 后半）`frames.probe_size` + `grab_frame`：经素材服务地址与读文件在 0、0.5、1.2 秒解出的 BGR 像素 sha256 相同、宽高 160×120。
- 另加 P6：`detect_shots` 在真的编辑器里（scdet 档）转场时刻与直接读文件相同，远程素材服务被请求过这段视频。

哪几项真跑了模型：**都没有**。这台机器上没有 TransNetV2、BootsTAPIR、YuNet / RT-DETR、Grounding DINO 的权重和运行库（`onnxruntime`、`torch` 都没装）。真跑的是 scdet（镜头识别的兜底档）、模板匹配（运动追踪的兜底档，numpy）和主体检测的取字节那一步。

单测不再依赖本机 Python，`npm test` 的跳过数不随机器变。探针要一个带 numpy 的 Python（PATH 上的 `python`，或 `PROMPTCUT_TEST_PYTHON`），找不到时 P7～P11 记为失败而不是静默跳过。

## 没做成的

- 重的验证（类型检查、全量测试、代码指纹、探针）等「可以跑重活」。
- 探针还没写：计划扩 `scripts/probes/asset-path-probe.mjs`，在 5950～5969 起编辑器（`PROMPTCUT_NO_PORT_FILE=1`）和一台计数的远程素材服务，素材只放远程，三个感知工具各调一次（镜头识别出结果；运动追踪用模板匹配出结果；主体检测证明取字节那一步与作业走到「未就绪」），再调一次 `voice_generate`（截服务商）或直接打 `/api/voice/generate` 看入库。
- `bake_card` 只写了 dry run（下一节），主会话已定另开任务。
- 配音复刻的**源文件**仍经素材目录的路径读：页面先把源文件经 `/api/media/upload` 入库，再把回包里的 `path`（本地内容库里的绝对路径）交给 `/api/voice/clone`，服务端 `isInside(src, mediaDir(root))` 后直接读。这是设置面板的功能，不是 Agent 工具，本段没改。改法：`/api/voice/clone` 收哈希，服务端用本段的解析器经素材服务的地址交 ffmpeg 转音频（`prepareCloneAudio` 的 `-i` 本来就能吃地址，要把 `spawnSync` 换成异步，理由同上一段〔裁〕4），页面 `src/ai/voice.ts` 的 `cloneVoice` 改发 `hash`；牵动两个文件，可以另开小项。

## `bake_card` 的 dry run（没改）

现状：`bake_card`（经 `server/agent/agent-exec.mjs:486` 或 `server/vite-plugin-ai.ts:225` 转到预渲染进程的 `/api/vision/bake`）由 `server/vision/bake.ts` 的 `bakeOne` / `bakeClip` 把卡片快照 PNG 原子写进素材目录 `out/media/bake-<clipId>-<输入哈希12位>.png`，回 `/@media/bake-….png`；命中缓存靠 `fs.stat` 这个文件。`server/vision/bake-cache.ts` 的 `listBakes` / `evictBakes` 直接列、删这个目录里的 `bake-*.png`，页面的 `src/editor/preview/useBakePrefetch.ts`（经 `/api/vision/bake-status`、`/api/vision/bake-evict`）按它做预取与淘汰，3D 视图（`Scene3DView.tsx`，`/api/vision/bake-batch`、`/api/ui-render/bake-batch`）也走同一份缓存。这些都是预渲染产物，按 `product/asset-service.md`「预渲染的产物」应当推送到素材服务。

改法（建议）：

1. 产物字节推进素材服务的 `px` 命名空间：用 `server/asset-store/client.mjs` 的 `createAssetClient().put`（按内容哈希、分片、可带票据），URL 改为 `/api/asset/px/<内容哈希>`。
2. 缓存键仍是输入哈希，但它不等于内容哈希，需要一张「输入哈希 → 内容哈希、宽高、字节数」的小索引。索引放哪儿要定：放预渲染进程自己的数据目录（只是缓存，不是字节，不违反「不直接读素材服务的存储目录」），或素材服务上以输入哈希为名的元数据。前者简单。
3. `bake-status` 改查索引加 `has`（`chunks.complete`）；`bake-evict` 改成删索引条目。素材服务现在**没有删除接口**（按内容寻址、写入后不可变），真正回收字节要么加一个受限的删除 / 过期接口（改对外接口，按三级〔裁〕办并播报），要么交给素材服务自己的容量淘汰。
4. 兼容：项目文档里已经有卡片参数写着 `/@media/bake-….png`（scene-3d 的 texture）。老地址要继续能取（素材目录里的旧文件不删，或在 `/@media/bake-*` 上做一次查索引转发），导出与预渲染进程读贴图的路径也要跟着认新地址。

影响面：`server/vision/bake.ts`、`bake-cache.ts`、`routes.ts`（bake、bake-batch、bake-status、bake-evict 四条）、`ui-renderer.ts`；页面 `useBakePrefetch.ts`、`bakePlan.ts`、`Scene3DView.tsx`；`agent-exec.mjs` 与 `vite-plugin-ai.ts` 的回包说明；可能还有 `server/asset-service.ts`（删除接口）。难度大：跨预渲染进程、页面、素材服务三方，还有老项目的兼容，建议单独开一项，先定索引位置与淘汰方式。

## 更正建议

- `docs/plan/TODO.md`「语义与代码的差距」的「Agent 读素材的路径」：本分支合入后可改为「三个感知工具与两个写入工具已改（`claude/asset-path-2`）；剩 `bake_card`（产物直接写素材目录，dry run 见 `AGENT-asset-path-2.md`）与配音试听、音色设计 / 复刻试听直接写素材目录」。
- `AGENT-asset-path.md` 排查清单第 6 行把 `collect_download` 评为「中偏大」，实际改动集中在 `runDownload` 一个函数，页面只改登记那一行；难点在测试的假解释器。
- 语义不需要改。

## 托管部署下要票据的问题（本段不改，记进 TODO）

托管部署（反向代理之后、`PROMPTCUT_TRUST_LOOPBACK=0`）时，编辑器进程回环请求自己的素材服务也要出示票据；编辑器进程自己没有票据，所以下面这些工具在托管端都读不到 / 写不进，回的是写明原因的错，不会静默失败：

| 工具 | 接口 | 现在回的错 |
|---|---|---|
| `detect_shots` | `POST /api/shots/detect` | HTTP 502 `{ ok:false, kind:"asset-service", error:"素材服务拒绝了读取(<编辑器地址>,HTTP 401)" }`，页面把 `error` 抛给 Agent |
| `track_points` | `POST /api/track/track` | 同上 |
| `detect_subjects` | `POST /api/subject/detect` | 同上 |
| `measure_audio`（上一段） | `POST /api/audio/measure` | HTTP 502 `{ ok:false, error:"素材服务拒绝了读取(…,HTTP 401)" }` |
| `measure_audio_js`（上一段） | `POST /api/audio/measure-js` | `{ ok:false, kind:"asset-service", error:"素材服务拒绝了读取(…,HTTP 401)" }` |
| `voice_generate` | `POST /api/voice/generate` | HTTP 502 `{ ok:false, kind:"asset-service", error:"素材服务拒绝了入库(<编辑器地址>,HTTP 401):<回包>" }`（合成已经发生、已计费，字节没进库，临时文件已删） |
| `collect_download` | `POST /api/collect/download` → `GET /api/collect/job/<id>` | 作业 `status: "error"`，`message: "下载好了但没能送进素材库:素材服务拒绝了入库(…,HTTP 401):…"`（下载的临时文件已删） |
| 看画面的素材层（`see_frames`、`/api/vision/sheet`，不是本段改的） | `mediaSourceOf` | 那一层留空，notes 里写抽帧失败 |

托管端的编辑器进程是否会跑这些工具、要不要给编辑器进程自己配一张回环用的票据，由主会话定。

## 需要主会话决定的事

1. 发「可以跑重活」之后，我跑类型检查、全量测试、代码指纹和探针（`node scripts/probes/asset-path-probe.mjs --port 5950`，远程素材服务占 5955），再更新本报告。
2. 配音复刻的源文件仍按路径读本地内容库（见「没做成的」），要不要另开小项。
3. 合并本分支（`--no-ff`）还是返工。

已由主会话在第一轮审查定下的：要真 Python 的检查挪进探针（已做）；试听改落缓存（已做，〔裁〕4）；`bake_card` 另开任务（本段只留 dry run）；托管部署的票据问题本段不改（上一节）。
