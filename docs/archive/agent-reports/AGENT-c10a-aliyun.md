# C10a 阿里云第 2 步失败的排查与修复

工作区 `.worktrees/c10a-aliyun`，分支 `claude/c10a-aliyun`，起点 `5b2fccc`（`claude/c10a-integ` 的头）。端口 5630～5659。C10a 是在线浏览器模式演示。

主会话 2026-09-27 要求交接给笔记本主会话：约 45 分钟内收口，不再请求重新部署阿里云、不再对阿里云跑探针。本报告按这个口径写。

## 现象（主会话 10:35～10:44Z 对阿里云跑的一轮，代码 5b2fccc）

- 只挂第 2 步「手机上重卡贴着预渲染小尺寸」（144 s 超时）。
- 第 1 步：plan 5 个细任务全完成，重卡 300 帧，小尺寸只有 295 张。
- 第 2 步手机诊断：在线来源 `ready 115`、`ranges 2`，`picks: []`，舞台里重卡抑制着、一张小位图也没贴；另有 2 次 `404 /@media/<素材原尺寸哈希>`。

## 进度一览（给接手的笔记本主会话）

| 件 | 根因 | 证据 | 修了没有 | 单测 | 验证 |
|---|---|---|---|---|---|
| 1. 重卡 295/300 张小尺寸 | 缺陷：预渲染进程重启前渲好的帧只有原尺寸；之后的细任务只给新产出的帧排小尺寸，完成判据只看原尺寸 | 代码路径，加上手机 `ready 115 / ranges 2` 的算术（见第 1 节）；阿里云那一轮的项目已删，没有逐帧名单 | 修了（`93a0ed0`） | ST10～ST13 | 单测过；`--local` R1 第 1 步 300/300（本机本来就不缺，不是判别性验证）；阿里云未验 |
| 2. 手机一张没贴、只取 4 张 | 不是「缺几张就整段不用」。手机停在第 0 帧，第 0 帧正是缺小尺寸的帧之一，同区间里没有更早的帧可回溯，按兜底顺序这一层显示占位。根因是第 1 件 | 同上；只取 4 张是因为探针卡的小位图大量重复 | 不需要改代码 | OS10、snapshotFeed 低内存档缺口选帧（锁住现行为） | 单测过；`--local` R1 第 2 步过 |
| 3. 手机请求 `/@media/<原尺寸哈希>` | 缺陷：时间轴波形 `loadWave` 的 `fetch(media.url)` 与素材库缩略的 `<video src={m.url}>` 直接用项目里的 `media.url` | `--local` 诊断轮 R0 用探针新挂的钩子抓到发起方与调用栈（见第 3 节） | 修了（`bd2adaa`） | LMT9 | 单测过；`--local` R1：手机 `/@media` 请求 0；阿里云未验 |

## 1. 渲染节点：重卡只有 295/300 张小尺寸

### 根因

- 预渲染小尺寸只在「本进程写快照、且配着推送队列」时排（`frame-pipeline.mjs` 的 `commitSnapshots` 钩子 → `scheduleSmallSnapshots`，画在下一次换页前）。
- 演示第 1 步里，预渲染进程先在没有共享配置的情况下起着（`PROMPTCUT_SHARED_CONFIG` 指向还不存在的文件 → `bad-config` → 不建推送队列 → 小尺寸关着）。放上重卡片段后，它按本机 preload 先渲了锚帧第 0 帧和播放头所在的那一批（创建者 `seek(1)` → 第 30 帧 → 批 28～31），共 5 帧，只有原尺寸。
- 探针随后结束预渲染进程，重启后连上托管端、走队列。细任务（每段 60 帧）只渲本段缺的原尺寸帧，已有的 5 帧不重渲，也就不排小尺寸。
- 完成判据（`artifact-transfer.mjs` 的 `createAssetSink.put`）只核原尺寸覆盖整段，不核小尺寸。于是 5 个任务全 `done`，清单里 300 帧原尺寸、295 张小尺寸。契约第 9 节「任务完成的条件：两档都推送成功」没有落到代码。
- 本机 `--local` 各轮不缺，是时序差：本机开启协作快，重启前 preload 还没渲到重卡。

### 证据

- 手机在线来源的 `ready 115`、`ranges 2`：窗口（播放头 0 秒，前后各 2 秒）覆盖本地帧 0～59、60～119 两段共 120 帧。缺第 0、28～31 帧，正好是 115 帧、两段区间 `[1,27]`、`[32,119]`。OS10 按这个样子构造，`debug().layers[0].ready` 也是 115。
- 没有逐帧名单：阿里云那一轮收尾时删了云端项目。探针现在第 1 步记下 `missingSmall`（缺小尺寸的帧号），并断言「每帧两档都在」。

### 修法（`93a0ed0`）

- `FramePipeline.scheduleMissingSmall(entry, control, range)`：本段里已有原尺寸、缺 `<帧>.small.webp` 的帧，从帧库读回 HTML 排进待画小尺寸。开关同 `smallTierEnabled()`，关着时不读任何文件。
- `FramePipeline.flushPendingSmall(bakery, project)`：还有待画的，就在这个预渲染间上换一次页（换页前的钩子画掉），页面恢复成空项目；没有待画的不换页。
- `renderCardSnapshotRange`：借预渲染间之前先 `scheduleMissingSmall`，收尾 `flushPendingSmall`。
- `renderSceneSnapshotRange`（本地档）：一帧都不用渲、只差小尺寸时，也借预渲染间补。
- `createAssetSink`（开着小尺寸时）：
  - `put`：缺任何一张小尺寸回 `{ complete: false }`，记 `sink.small-incomplete`；节点按可重试失败交回，重做时补上。
  - `has`：本机帧库覆盖整段但缺小尺寸，回 false，而且不再去认内容库里的清单（那份多半是本机推送队列边渲边写的，原尺寸齐、小尺寸缺）。
  - `resultFor`：同样要求两档齐。
  - 导出的 `smallComplete(result)`：流恒为真。
- 桌面上没配推送队列时（不连文档服务）行为逐字节不变；配了推送队列的桌面节点，细任务完成条件多了「两档齐」，这是契约第 9 节本来的要求。
- 连带效果：本机从素材服务拉来（`adopted`）、缺小尺寸的帧，被本机的细任务覆盖到时也会补画小尺寸。契约第 9 节把「已有产物补小尺寸」划给 C10 其余，这里只在本机本来就要完成这一段任务时顺带发生。

### 单测（`server/test/small-tier.test.mjs`）

- ST10 已有原尺寸、缺小尺寸的帧排进小尺寸，从帧库读回原 HTML；没开小尺寸不读。
- ST11 细任务收尾：有待画的就换一次页画掉；没有不换页。
- ST12 sink：缺一张小尺寸，`put` 回 incomplete、`has` 回 false、不认内容库里缺小尺寸的清单；补齐后两档一起推。
- ST13 细任务（共享档、本地档）在原尺寸早就齐、只差小尺寸时也补上。

## 2. 手机：清单有小尺寸，却一张没贴

### 结论

- 怀疑的「一段清单缺几张就整段当未满不用、每 2 秒重取」不成立：`OnlineSnapshotSource.readyFrames` 把不满的段里有小尺寸的帧照常算就绪（原有的 OS2 已覆盖）。不满的段确实每 2 秒重取一次清单，这是为等补齐，不是丢弃。
- `picks: []` 的原因：手机停在第 0 帧，第 0 帧缺小尺寸。选帧规则（`mechanism/rendering.md`「兜底顺序」第 3 步：同一区间内向前回溯、不跨区间）在第 0 帧没有更早的帧，这一层按第 4 步显示占位。这符合语义「缺哪帧只对那一帧按兜底顺序占位，有的帧照常贴」。所以第 2 步的失败由第 1 件造成，第 1 件修好后第 0 帧有小尺寸就贴得上。
- 只取了 4 张：探针卡的小位图大量重复，窗口里只有 4 个不同的哈希（本机各轮也只有 5、6 次 px）。不是缺陷。

### 单测（锁住现行为）

- `src/render/onlineSnapshotSource.test.mjs` OS10：按阿里云的样子构造（300 帧，缺第 0、28～31），就绪区间 `[1,27]`、`[32,119]`，ready 115；第 5 帧照常选、第 30 帧回溯到 27、第 0 帧不选（占位）；有的帧取得到字节，缺的抛错；清单补满后区间补齐。
- `src/editor/snapshotFeed.test.mjs`「低内存档：一层的就绪表有缺口……」：暂停、低内存档下同样的选帧。

### 没做

- 舞台在第 0 帧那种情况下是否真的显示了占位（不透明），没有在阿里云现场核过：诊断只看了 `img[data-pc-small-snapshot]` 与快照平面。占位由舞台的 `placeholderWanted` 管，是现有路径。
- 建议（机制，未改）：不满的段清单长期不变时，重取间隔可以退避（比如 2 秒起、翻倍到 30 秒，清单一变就回到 2 秒）。阿里云那轮 144 s 里 `manifestFetches 57`。退避会拉长「新小尺寸到手机」的时间，所以这次没动。

## 3. 手机（低内存档）请求素材原尺寸、走相对 `/@media`

### 根因与证据

诊断轮 R0（`--local`，代码 `ad77330`，即第 1 件已修、第 3 件未修）用探针新挂的钩子抓到两次请求，与阿里云那两次同形（`/@media/<素材原尺寸哈希>`，只有这两次）：

1. `fetch`，调用栈 `window.fetch ← … ← loadWave ← (effect) ← React 提交`：时间轴片段的波形 `AudioWaveform` 用 `loadWave(media.url)` 把整份原尺寸读下来解码。
2. `<video>` 的 `src` 属性，由 React 提交时 `setAttribute` 设（请求类型 `media`，元素尚未挂进文档）：素材库缩略 `MediaThumb` / `MediaTile` 的 `<video src={m.url}>`。页面上只有这两处以视频素材的 `media.url` 挂 `<video>`（另一处 `transitionsGroup` 的静帧那时不显示）。

`media.url` 是项目里记的 `/@media/<原尺寸哈希>`，桌面由本机编辑器进程提供这条路由；在线页面没有这条路由，而且低内存档本来就不该取原尺寸（契约第 8 节能力闸）。R2 修的 `mediaTier`（LMT8）只管舞台与声音层走 `playbackUrl` 的那几条路，编辑界面这几处预览绕过了它。

### 修法（`bd2adaa`）

- `src/render/mediaTier.ts`：
  - `previewMediaUrl(media, policy)`：桌面（`policy.online` 为假）原样 `media.url`；在线页面经 `chooseTier` 换成远程素材服务地址——低内存档视频只给小尺寸，没有小尺寸给 ""；普通档给「先小后大」的小；远程地址没就绪给 ""。不探可播性。
  - `subscribeMediaTierPolicy`：策略真的变了才通知（同值不换对象）。
- `src/editor/media/previewUrl.ts`（新）：`useMediaTierPolicy`、`usePreviewMediaUrl`、`previewCacheKey`（去掉查询串，票据轮换不重下）。
- 改用预览地址的地方：
  - `src/editor/timeline/AudioWaveform.tsx`：波形；`loadWave` 的缓存键去掉查询串（桌面的 `/@media` 地址没有查询串，不变）。
  - `src/editor/left/library/mediaGroups.tsx`：`MediaTile`、`MediaThumb`、`AudioRow`、总览里的音频条。
  - `src/editor/left/library/transitionsGroup.tsx`：转场卡的静帧。
- 单测：`src/render/mediaTierLowMemory.test.mjs` LMT9。
- 低内存档下波形改为读素材小尺寸（带 64 kbps AAC）整份解码。长片在手机上会占内存，这次没改；要不要在低内存档里不画波形，属于一级，留给用户定。

### 没改、留给后面的

在线页面上还有几处按 `media.url` 或 `/@media` 取东西，这次的演示路径碰不到：

- 素材右键「按素材比例设画幅」量尺寸（`measureVideoDimensions(m.url)`，只在素材没有宽高时）；
- `SpeakerPicker` 把 `m.url` 当参数交出去；
- 舞台里卡片自己引用素材（`src/render/cards/mediaSource.ts`）与卡片声音的 `/@media/<hash>/pcm`（`src/render/cards/audioSources.ts`）；
- `procp.ts` 的打包保存。

## 4. 探针改动（`ad77330`）

`scripts/probes/c10a-demo-probe.mjs`：

- 手机页面挂钩子，记下 `/@media/…` 请求：请求记录里的发起方类型与调用栈、页面里 `fetch` / XHR 的调用栈、媒体与图片元素设 `src` 时的元素链。同源舞台 iframe 里一样挂。
- 新断言：
  - 第 2 步「手机：没有 /@media 请求」；
  - 第 4 步末「手机整段（进入、改一处、导出）：没有 /@media 请求」；
  - 第 1 步「plan 落定时重卡每帧两档都在」，结果里写 `missingSmall`；
  - 第 3 步「整段重渲完成」改成新键下帧数等于层的帧数、且每帧都有小尺寸（R2 报告第 5 节的建议）。

## 5. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（含 `bd2adaa`） |
| 全量测试 | `npm test`（代码 `bd2adaa`） | 退出码 0；3268 tests，3266 pass，0 fail，2 skipped |
| 新单测 | 同上，逐条在输出里 | ST10～ST13、OS10、「低内存档：一层的就绪表有缺口……」、LMT9 全部 ✔ |
| 演示探针 R0（诊断） | `c10a-demo-probe.mjs --local --port 5640 --proxy-port 5643 --doc-port 5644 --asset-port 5645`，代码 `ad77330` | 313 s；只挂两条新加的 `/@media` 断言（第 3 件未修，预期）；其余全过：第 1 步 300/300，第 2 步 6.9 s 贴上小尺寸，导出 300 帧 h264 + aac |
| 演示探针 R1 | 同上，代码 `bd2adaa` | **全过**，327 s。第 1 步 61 s，plan 5/5，重卡 300 帧、小尺寸 300；第 2 步 11.6 s 贴上小尺寸，请求：素材小尺寸 3、原尺寸 0，px 6，snap 0，`/@media` 0；第 3 步新键 4.1 s、新小尺寸到手机 56 s、整段两档齐 170 s（300/300）；导出 300 帧、10.000 s、h264 + aac，素材原尺寸 2、snap 300；旧链接被拒、新链接能进；桌面手填与粘贴都进；云端项目已删（lookup 404）；意外重载 0 |
| 演示探针第二轮 | — | 没跑：主会话要求收口 |
| 阿里云 | — | 没跑：主会话要求不再部署、不再对阿里云跑 |
| G0-R 全套 | — | 没跑：收口时间不够。改动面：`server/frame-pipeline.mjs` 只动了队列细任务那两个方法（只在队列模式、配了推送队列时生效）；`src/render/mediaTier.ts` 只加函数与通知，桌面分支原样 `media.url`；编辑界面三处预览在桌面上仍是 `media.url` |

## 6. 还差什么、下一步（给笔记本主会话）

1. **G0-R 全套**：dev server 5650（舞台 5651/5652），verify-determinism 1800/1800、与 main 基准逐帧比、verify-unified-frames、ready-index-probe、stream-produce-probe 与 `--group`、preview-fallback-probe 与 `--page-preload`。本分支没跑。
2. **`--local` 第二轮**：任务书要连跑 2 轮，只跑了 R1 一轮（R0 是修第 3 件之前的诊断轮）。
3. **阿里云**：第 3 件改了在线页面代码，要从本分支（或合进 `claude/c10a-integ` 之后）重新部署在线页面，再跑一轮。第 1 件的修复在创建者本机的渲染节点上，随本机代码生效，不需要部署。看：
   - 第 1 步 `heavy.small === frames === 300`，不出现 `missingSmall`；
   - 第 2 步贴上小尺寸，`relMedia 0`，`badResponses` 里没有 `/@media`；
   - 第 1 步如再缺小尺寸，节点日志里应有 `sink.small-incomplete`，任务会失败重做而不是 `done`。
4. 第 3 节「没改、留给后面的」那几处在线页面的 `/@media` 用法，可另开小任务。
5. 第 2 节的清单重取退避要不要做，由主会话定。

## 7. 对任务书或语义的更正建议

- 任务书第 2 件的假设（缺几张就整段不用）与代码不符：实际是段首帧缺小尺寸导致的正常占位，根因在第 1 件。
- 契约第 9 节「已有产物补小尺寸属于 C10 其余」：本次修复会在本机细任务覆盖到的段里，顺带补画本机帧库里缺小尺寸的帧（包括从素材服务拉来的）。建议契约里注明这一条，免得审〔裁〕时当作越界。
- 演示探针第 1 步在预渲染进程重启前就放上了重卡片段，重启前的本机 preload 会先渲一部分帧。这正好覆盖了「推送队列配上之前已有产物」的情形，建议保留，并在探针文件头写明用意。

## 提交

- `c8de68e` 报告：AGENT-c10a-aliyun 开工
- `93a0ed0` 修：队列细任务两档齐才算完成——已有原尺寸、缺小尺寸的帧补画；sink 缺小尺寸回 incomplete；单测 ST10～ST13
- `01a9163` 测试：清单缺几帧小尺寸时在线来源不整段丢、选帧有的照常贴（OS10 与低内存档缺口选帧）
- `ad77330` 探针：c10a-demo 记下手机上的 /@media 请求与发起方；plan 落定时核每帧两档都在；第 3 步整段重渲按帧数齐判
- `bd2adaa` 修：在线页面的素材库缩略、时间轴波形、转场静帧不再拿 media.url 取 /@media（低内存档只给远程小尺寸）；单测 LMT9
- 本报告另起一个提交。
