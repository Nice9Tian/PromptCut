# AGENT-maint-3

分支 `claude/maint-3`（起点 `claude/r7-merge` 的 `e4f6e8df`），worktree `.worktrees/maint-3`。一批维护项，来自 `docs/plan/TODO.md` 与最近几份归档报告：

1. legacy 整帧通道的方案 B（「legacy 整帧通道」指整帧预览那条老路及其四块存储，方案 B 是 `AGENT-query-render-2.md` 第 8 节 dry run 里「只删没人用的产物」那一档）；
2. 时间轴档测响度的逐秒曲线偶发缺点；
3. 配音复刻的源文件经素材服务取字节；
4. 队列模式认领闸的端到端探针（「认领闸」指本机渲染节点在 Agent 专用实例开着且空闲时多认领一项快照任务的那道判断，`server/queue-agent-spare.mjs`）。

## 状态

轻量部分做完：四项的代码、单测、探针脚本都已提交；单个测试文件逐个跑过。**重活还没跑**（主会话在同机跑带耗时门槛的整套验证，按任务书的重活禁令等放行）：`npx tsc -b --force`、`npm test`、G0-R（第 1 项改到预渲染要跑的一组渲染验收）、第 4 项探针的真跑。

用户看不出区别：第 1 项删的两个文件从来没人读；`/status` 回包形状不变。没有需要停下的用户可见影响。

## 提交

| 提交 | 内容 |
|---|---|
| `3bb8c2f6` | 文档：建本报告 |
| `191089d3` | 修复：legacy 整帧通道方案 B——不再产 `preview.mp4` 与整场景 `full.mov`（单测 MNT3-B-1～6） |
| `9b593817` | 修复：时间轴档测响度在混音之后按样本序号重打时间戳（单测 MNT3-L-1～2） |
| `4999fa65` | 测试：CM-3 的混音图比对认多出的 `asetpts` |
| `2ec60323` | 修复：配音复刻的源文件经素材服务取字节（单测 MNT3-V-1～3） |
| `a7cea78a` | 探针：认领闸端到端探针 `claim-gate-probe`（判定单测 MNT3-C-1～3） |

用例编号前缀 `MNT3-` 是本任务新起的（B = 方案 B，L = 响度，V = 配音复刻，C = 认领闸），仓库里原来没有。

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
- G0-R：**没跑**，等放行。

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
- **探针还没真跑**，等放行。

## 〔裁〕

1. **`/status` 回包里的 `video`、`mov` 与 `/see` 的 `mov`：保留字段，恒为 `null`。** 删字段和恒为 `null` 对现有调用方都没有区别（没有读它的）；保留则旧页面、旧探针见到的回包形状不变，`null` 本来就表示「还没有」。代价是两个永远为 `null` 的字段，注释里写明了。（三级）
2. **整场景 `MovFrameStore` 载入时删旧版本留下的 `full.mov`，`prerender()` 顺手删旧的 `preview.mp4`。** 它们是不再有人产、也没人读的缓存文件，不删会一直占盘到这一版被淘汰。删的是本机帧库里的预渲染缓存，不是用户数据。（三级）
3. **`asetpts=N/SR/TB` 只加在测响度的参数里，不改共用的混音图。** 自定义测量的 PCM 路径实测不受影响；改共用的那份会连带导出侧的比对。（三级）

没有改二级语义；语义文件没动。

## 验证（到目前为止）

| 项 | 命令 | 结果 |
|---|---|---|
| 新单测 | `node --experimental-test-module-mocks --test server/test/maint-3-*.test.mjs`（逐个） | B 6/6、L 2/2、V 3/3、C 3/3 |
| 相关旧单测 | 见各节，逐个跑 | 全部通过 |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | 不变 |
| 类型检查 | `npx tsc -b --force` | **没跑**（重活禁令） |
| 全量测试 | `npm test` | **没跑**（重活禁令） |
| G0-R | 确定性、与基准逐像素、快照重放、流式生产两种、预览退回两种、就绪索引、查询渲染 | **没跑**（重活禁令） |
| 认领闸探针 | `node scripts/probes/claim-gate-probe.mjs` | **没跑**（重活禁令） |

## 更正建议（dry run，没改任何文件）

- `docs/plan/TODO.md`：「legacy 整帧通道」一条改为「方案 B 已做（`claude/maint-3`）；C、D 待用户定端口回退时的行为」；「时间轴逐秒曲线偶发缺点」「配音复刻源文件」「认领闸端到端探针」三条合入后划掉。
- `docs/plan/storage-plan.md` 里提到整场景 `full.mov` 的地方，合入后注明「整场景那份已不再产，只剩独立卡那份」。
- `server/bakery/frame-video.mjs`（及 worker、`frame-video.test.mjs`）已无生产调用方，可另开小项删掉（删文件按「对齐」先 dry run）。
- 独立卡那份 `controls/<键>/mov/full.mov` 同样只被判存在（`png-adopt-probe` 用它当信号）；要不要一起停，另议。
- `server/test/audio-asset-path.test.mjs` 里 AR-3 为躲这个偶发把几段都放到时间轴结尾，本修合入后可以恢复「有一段先结束」的写法。

## 需要主会话决定的事

1. 放行后跑重活：`tsc`、`npm test`、G0-R、认领闸探针。
2. 〔裁 1〕～〔裁 3〕是否照留。
3. 上面几条更正建议要不要另开小项。
