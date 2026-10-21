# AGENT 报告：claude/mobile-entries

0.7.19 前置项：手机版补「滤镜」入口、缩略卡与素材格子显示真画面、「速度」入口调研。
出处：`docs/plan/mobile-online-task.md`「待用户项」第 4、5 条（用户 2026-10-21 定：先补「速度」和「滤镜」；缩略卡真画面「要」）。

- worktree：`.worktrees/mobile-entries`，分支 `claude/mobile-entries`，从 main `141e0be8` 切出。
- 端口：只用了 5820～5827（探针的编辑器代理 5820～5822、第二套代理 5823～5825、文档服务 5826、素材服务 5827）。
- 状态：第 1、2 件做完并验证；第 3 件只调研（结论在下面）。未推送、未合并。

## 提交

| 提交 | 内容 |
|---|---|
| `49a7b043` | 建本报告 |
| `5a9912fb` | 滤镜入口（卡片库「滤镜」分类、调整面板滤镜一栏） |
| `91022e42` | 素材格子、缩略卡显示真画面 |
| `76d5d3cd` | 缩略图取不到时按退避重试；同一张别处取到时一并显示 |
| `e0de002d` | 缩略图等素材服务收全再取（去掉上传中的 404） |

## 做了什么（逐文件）

### 第 1 件：滤镜入口

- `src/mobile/filters.tsx`（新）
  - `FiltersGrid`：卡片库「滤镜」分类，列项目的滤镜库（`project.filters`）。每格是套上滤镜的彩色样片（同桌面 `filtersGroup.tsx` 的样片算法）、名字、「用在 N 段 · 描述」。
  - 点格子：选中的是视频或图片段时挂上；它已经挂着这个滤镜时摘掉（同桌面的「挂到选中 / 摘掉」）。没选中可挂的段时格子置灰，提示先选中。
  - 右上角「×」删除：还挂在片段上时，先确认「用在 N 段上，删了会把这些段上的它一起摘掉」，确认后 `force` 删除（理由写「用户在手机版卡片库里删除」）。
  - `ClipFilterFields`：调整面板里视频、图片段的「滤镜」一栏。下拉选「无 / 库里的滤镜」，下面是描述，再下面逐个画滤镜声明的参数：有 min/max 的用 `Slider`，没有的用数字框。改参数时只带声明过的键（同桌面）。
  - 校验和门槛与桌面、Agent 的 `apply_filter` / `remove_filter` 共用一份 `createFilterTools`（从 `src/editor/right/filterTools.ts` 只读引入，没改它）。
  - 空库提示：口径同桌面，把位置改成手机版的说法：
    - 卡片库：「还没有滤镜。让 Agent 建一个（比如「给夜景那几段做个冷色调」），它会出现在这里，之后能挂到任意视频 / 图片片段上复用。」
    - 调整面板：「滤镜库是空的：让 Agent 建一个，会出现在卡片库的「滤镜」分类」
- `src/mobile/controls.tsx`（新）：把 `sheets.tsx` 里的 `Slider`、`ControlField` 原样挪出来并导出，调整面板和滤镜一栏共用，没有另造样式。
- `src/mobile/sheets.tsx`
  - `CardTab` 加 `"filter"`，分类顺序为 动效 / 文字 / 滤镜 / 转场（演示稿是 动效 / 滤镜 / 转场 / 音效；手机版原先就把「文字」单列，没动）。
  - `ParamsSheet` 在视频、图片段的不透明度之后插入 `ClipFilterFields`。
- `src/mobile/mobile.css`：加 `--fx-sample` 变量（样片的固定渐变，和桌面同色，照文件头规矩放在 `.pcm` 变量里），以及 `.tile.fx`、`.fx-swatch`、`.fx-del`、`.hint.err`。

### 第 2 件：素材格子、缩略卡显示真画面

- `src/mobile/thumbs.ts`（新）：取缩略图的队列、缓存和解码。
  - **取素材的路**：只用编辑界面现成的素材预览地址 `usePreviewMediaUrl`（`src/editor/media/previewUrl.ts` → `render/mediaTier.ts` 的 `previewMediaUrl`），没有另造取素材的路。
    - 在线页面上，它给的是远程素材服务带只读票据的地址（`?t=`），先小后大。
    - 远程地址还没就绪、或素材确认缺失时，它给 ""，这时不发请求。
    - 不碰本机路径。
  - **等素材服务收全再取**：判据只问素材服务（`mechanism/asset-service.md`「同步状态只问素材服务」），即编辑器每 2 秒轮询得到的已收全哈希集合（`useTierHashes`）。
    - 问过了：地址里的哈希（或这份素材原尺寸的哈希）在集合里才取。
    - 还没问过：素材还在入库（`pending`）就等，否则先取。
  - **按需**：格子进了视口附近（`IntersectionObserver`，多看 120px）才排队取；滑走了、还没轮到的撤掉不取。
  - **限流**：同时最多解码 2 个，其余排队。
  - **缓存**：解码成宽不超过 224 像素的小 JPEG（data URL）。缓存键是去掉票据查询串的地址，视频再加取帧时刻；最近用过的留 160 张。票据轮换不重取，面板关了再开也不重取。
  - **取不到**（解码失败、超时 20 秒、跨源画不进画布）：一律当没取到，格子仍是原来的取色底色加类型图标，不出现空白或破图；失败不进缓存。
  - **视频**：用一个不挂到页面上的 `<video>`（`muted`、`playsInline`）seek 到目标时刻，画进画布，取完立刻卸掉源。图片用 `Image()` 解码再缩。
- `src/mobile/Thumb.tsx`（新）
  - `useThumb(media, t)`：给一个素材和取帧时刻拿缩略图。
  - 取不到时按 2、4、8、15、15、15 秒退避重试，试满就停。等格子下次出现（面板重开），或素材上传完（`pending` 变了）再从头试。
  - 同一张在别处取到了（`loader.watch`），这里也立即显示。
  - `ThumbImg`：盖在底色上的 `<img class="thumb-img">`。没取到时透明占位（留着让视口观察器量得到它），不挂 `src`。
- `src/mobile/sheets.tsx`：素材格子改用 `AssetPic`（底色和图标打底，取到就盖上真画面并藏掉图标，时长和「上传中 / 已转写」角标照旧在上面）。
- `src/mobile/ThumbStrip.tsx`：缩略卡加 `BlockThumb`。
  - 视频段取**它入点那一帧**（`mediaOffset`），图片段取缩略图。
  - 剪辑段、卡片段、声音不取，仍是取色底色。
- `src/mobile/thumbs.test.mjs`（新，11 条）：缓存键去掉票据、取帧时刻钳制、缩放比例、限流、缓存命中、撤销排队、两处共享、失败不缓存可重试、最近使用淘汰、跨请求通知、「没收全不取」判据。

## 验证

跑 `npm test` 前设了任务书里的两个环境变量（值没写进任何文件）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在 `e0de002d` 上跑） |
| 全量测试 | `npm test` | 退出码 0：tests 7437、pass 7422、fail 0、cancelled 0、skipped 15。没有失败项，所以不需要单跑复核；没有出现「满载失败、单跑通过」的情况 |
| 手机版单测 | `npm test -- src/mobile/mobile.test.mjs src/mobile/thumbs.test.mjs src/mobile/agentView.test.mjs` | 退出码 0：24 / 24 通过 |
| 在线构建 | `npx vite build --mode online` | 退出码 0 |
| 手机版界面探针 | `node scripts/probes/mobile-ui-probe.mjs --out out/mobile-ui --base-port 5820 --base2-port 5823 --doc-port 5826 --asset-port 5827` | 退出码 0，`ok: true`，`fails: []`，控制台零报错 |
| 手机版业务层探针 | `node scripts/probes/mobile-business-probe.mjs --out out/mobile-business --base-port 5820 --base2-port 5823 --doc-port 5826 --asset-port 5827` | 退出码 0，`ok: true` |
| 本任务的验收探针 | `node out/probes/mobile-entries-probe.mjs`（默认端口 5820/5826/5827） | 退出码 0，`ok: true`，`fails: []`；`badResponses` 0 条 |

### 中途发现并修掉的问题

- **刚导入的格子一直是底色**：本任务探针第一次跑时，T1、T2 不过。原因是刚导入的素材还在上传，素材服务答 404；格子挂载时取一次失败，之后不再重试。修法：`76d5d3cd` 加退避重试和跨请求通知。
- **上传中打出 404**：`mobile-ui-probe` 跑一次时 W 项（控制台零报错）不过，两条 404 来自格子在上传完成前就去取。修法：`e0de002d` 改成等素材服务收全再取。之后两个探针都全过，`badResponses` 为 0。

### 本任务探针的断言与实测

| 项 | 断言 | 实测 |
|---|---|---|
| T1 | 图片格子显示真画面 | 红图格子中心 `[210,40,40]`、绿图 `[40,189,69]`；格子上挂的是 `data:image/jpeg`（缩小后的图），不是原图地址 |
| T2 | 视频格子显示首帧 | 视频首秒蓝、后一秒黄；格子中心 `[36,57,200]`，即蓝 |
| T3 | 缩略卡显示入点帧 | 视频段缩略卡中心 `[36,57,200]`（入点 0 秒，蓝）；在 1.5 秒处切开后，后半段（`mediaOffset` 1.5）中心 `[224,217,39]`（黄） |
| T4 | 取不到时退回底色 | 用 CDP `Fetch.failRequest` 掐断红图的请求（掐了 3 次）。红图格子 `data-thumb` 未就绪、背景是 `linear-gradient(...hsl(...))`、类型图标可见、不挂 `src`；页面破图 0 张 |
| T5 | 按需取 | 30 张图刷新后打开面板：30 格里 15 格出画面，只请求了 15 份素材；滑到底后最后一格出画面，累计请求 30 份 |
| F1 | 空库提示 | 两处空库提示与上文口径逐字相同 |
| F2 | 调整面板挂滤镜、调参数、撤销 | 下拉挂上 `flt-probe`；参数框输入 1.5 后 `clip.filter.params.s = 1.5`；撤销一步后只撤回参数，滤镜仍挂着 |
| F3 | 卡片库挂、摘、删 | 选中段挂着的滤镜标成选中；点一下摘掉（`filter = null`），再点挂上；删除先确认，提示「「探针冷调」用在 1 段上，删了会把这些段上的它一起摘掉。删除？」；确认后库空、片段上的一起摘掉、出现空库提示 |

### 看过的图

截图都在 worktree 的 `out/` 下（`out/` 不入库）：

- `out/mobile-entries/T1-assets-images.png`：素材库图片分类，红、绿两格是真画面。
- `out/mobile-entries/T2-assets-video.png`：视频格子是首帧（蓝）。
- `out/mobile-entries/T3-strip.png`、`out/mobile-entries/T3-strip-split.png`：缩略时间轴的卡是真画面；切开后后半段是黄。
- `out/mobile-entries/T4-fallback.png`：被掐断的红图格子是取色底色加图标，其余格子是真画面。
- `out/mobile-entries/T5-lazy-top.png`、`out/mobile-entries/T5-lazy-bottom.png`：按需取，滑到底后最后一行也出画面。
- `out/mobile-entries/F1-cards-filter-empty.png`、`out/mobile-entries/F1-params-filter-empty.png`：两处空库提示。
- `out/mobile-entries/F2-params-filter.png`：调整面板的滤镜一栏，下拉、描述「饱和度 s · 色相 180°」、参数滑块 1.5。
- `out/mobile-entries/F3-cards-filter.png`：卡片库「滤镜」分类，样片、名字、「用在 1 段」、删除钮、选中描边。
- 现有探针的截图：`out/mobile-ui/`（含 `side-*.png` 与演示稿并排对照）、`out/mobile-business/`。

## 没做成的及原因

- **验收探针没放进 `scripts/probes/`**：`scripts/` 不在我的文件清单里，所以放在 `out/probes/mobile-entries-probe.mjs`（不入库，worktree 删掉就没了）。建议主 Agent 合并前把它收进 `scripts/probes/mobile-entries-probe.mjs`，路径前缀 `../../scripts/probes/` 改成 `./`。文件头写了用法和断言。
- **卡片库没加「音效」分类**：不在本任务范围（用户 2026-10-21 定往后放）。
- **时间轴分页选中片段时的子导航栏没加「滤镜」项**：演示稿片段工具里没有这一项（只有静音、速度、调整）。滤镜从两处进：
  - 缩略预览页选中片段后点「卡片」→「滤镜」；
  - 时间轴分页点「调整」里的滤镜一栏。
- **不经意观察到的两点，与本任务无关，没改**：
  - 在线页面导入视频时，视频会自动放进时间轴一次（探针里导入后、还没点格子，主轨上已经有这段视频）；再点格子就是第二段。不知道是不是有意的，请主 Agent 判断。
  - 手机上进项目仍弹「已切换低内存模式…」，即任务书待用户项第 6 条，已知。

## 第 3 件：「速度」入口调研（没写代码，没动 `src/kernel/`、`src/render/`、`src/audio/`）

### 1. 现在能不能在一个素材段上做慢放 / 快放

**画面能做，声音不能。**

- **机制**：素材效果卡的输入边带时间映射 `{ nodeId, offset, rate }`。
  - 定义在 `src/kernel/cardGraph.mjs` 的 `normalizeCardInput`。
  - 取输入的时刻 = 「这张卡自己的时间 × rate + offset + 那段素材的裁剪起点」（`src/render/cards/GraphCard.tsx` 的 `renderNode`）。
  - 这个映射进预渲染的身份键（`server/card-identity.mjs` 的 `cardSnapshotInputKeys`）。
  - 取帧规则见 `mechanism/cards.md` 第 50 行：「变速与偏移先算出 t 再取帧」。那一条〔裁〕的出处是用户真机报的「0.5 倍慢放节奏不均」，说明已经有人这样用。
- **怎么做（只有 Agent 能做）**：
  1. Agent 用 `create_card` 写一张直通的素材效果卡：`card()` 把 `source` 输入原样输出。
  2. 用 `apply_card` 挂到素材段上，`inputs: { source: { clipId: <这一段>, rate: 0.5 } }`。工具说明在 `server/tools/cards.mjs` 第 82 行：「可加offset秒和rate倍率」。
  3. 片段时长要手动拉长或缩短：0.5 倍要拉成原长的 2 倍，否则素材播不完。
- **限制**：
  - **声音不跟着变**：片段原声走 `audioPlan.mjs` → `renderMix.ts` / `mux-audio.mjs`，按 1 倍从 `mediaOffset` 起切。慢放段的原声会和画面错开，只能静音。
  - 要写一张卡，在线浏览器里用户卡只在隔离环境运行。
  - 时长、素材末尾都要自己算。
- **桌面端用户现在怎么做**：界面上没有任何速度入口；编辑分区和右键菜单都没有，节点图也不提供改边的 `rate`。只能让 Agent 按上面的办法做。
- **结论**：「补速度入口」不是接线。业务层没有面向用户的片段速度，算新增用户看得见的能力（二级），按任务书「设计决定」3 不该由手机版先发明。

### 2. 如果要加片段速度，最小改动和风险

最小形态：`TrackClip.speed?: number`（缺省 1，例如 0.25～4），时间映射统一为 素材时刻 = `mediaOffset + (t - start) × speed`。

| 位置 | 要改什么 | 风险 |
|---|---|---|
| `src/kernel/project.ts` | 加字段与注释 | 低；老文件没有这个字段，按 1 算 |
| 新增一个纯函数（如 `kernel/clipTime`） | `sourceTime(clip, t)`、`sourceSpan(clip)` 统一时间换算，下面各处都改调它 | 低；但下面每一处漏改，就会出一处错位 |
| `src/store/actions/clips.ts` | `addMediaClip` 时长 = 素材余量 ÷ speed；改时长的上限；分割时后半段 `mediaOffset += (切点 - start) × speed`（第 186 行）；`moveClip` 改左边沿时的 `sourceShift`（第 33～36 行）；新增 `setClipSpeed`：改速度时保住入点、按新速度重算终点，挂转场时按现有规则拒绝 | **中**：这几处是现有剪辑行为的核心，各有单测；改左边沿、分割的偏移是最容易错的 |
| `src/render/VideoTrack.tsx`、`src/render/mediaSync.ts`、`src/render/mediaDrive.ts` | 实时播放：目标时刻用新映射；`playbackRate` 基准从 1 改成 speed。纠偏的 ±10% 改为在 speed 上浮动 | **中高**：`mediaSync` 的纠偏全按 rate = 1 写死（第 111～151 行）；高倍速下浏览器解码跟不上，会频繁硬 seek；手机上更明显 |
| `src/render/FrameScene.tsx`（`data-pc-media-time`，第 114、296 行）→ `src/render/frameMedia.ts` | 导出 / 预渲染取帧时刻用新映射。`frameMedia.ts` 本身只按给的时刻 seek（含 2 ms 提前量），不用改 | 中：快放时每帧都远距离 seek，导出变慢；慢放时相邻帧可能取同一帧（预期之内） |
| `src/render/layerInputSig.mjs`、`server/frame-identity.mjs` 等身份键 | 键里加 `speed` | **高**：漏了会命中旧的预渲染结果，画面错而不报错；缺省 1 时必须不进键，否则所有已有快照失效 |
| `src/kernel/audioPlan.mjs`、`src/audio/renderMix.ts`、`server/bakery/mux-audio.mjs`、`src/editor/preview/MediaLayers.tsx` | 声音：要么按 speed 改 `playbackRate`（变调），要么保调变速（浏览器离线混音没有现成的保调变速；ffmpeg 有 `atempo`，两边结果会不一致） | **高**：语义「导出与预览一致」（`renderMix.ts` 头注释说它和 `mux-audio.mjs` 一一对应）；保调变速要引入算法或依赖。最小可行是第一版变速段自动静音或变调，这本身是二级决定 |
| `src/kernel/captions.ts`、`src/store/actions/captions.ts`、`src/kernel/cutFlatten.mjs`、`src/kernel/cutAudio.mjs`、`src/kernel/motion.ts`、`src/editor/timeline/AudioWaveform.tsx`、`ShotMarkers.tsx`，以及 `server/` 下 `export-compose.mjs`、`vision-compose.mjs`、云端工具 | 凡是用 `mediaOffset` 换算素材时刻的都要换成统一函数（`grep -rln mediaOffset` 共 38 个非测试文件） | 中：面广，单个都简单，但漏一处就是字幕、波形、镜头标记和画面对不上 |
| 转场 | 交叉溶解的重叠段两边各按自己的速度取帧，靠统一函数自然成立；转场「把相邻段绑成一组」，改速度会改时长，要按现有规则（挂着转场不能改时长）拒绝或先解绑 | 中 |
| MCP 工具与 Agent 语义 | `update_clip` 之类要能读写 `speed`；`product/agent.md` 的工具说明 | 低 |
| 导出像素基线 | 缺省 1 时只要换算写成 `x × 1` 精确不变、身份键不加字段，像素基线不变；基线演示项目里没有变速段，全量比对测不到新功能，要另做变速项目逐帧比对 | 缺省路径低；新功能需要另做比对 |

### 3. 解法表

卡点 1：要满足「手机版补『速度』入口」（待用户项第 4 条，用户 2026-10-21 定）。

- **现在观察到的**：业务层没有片段速度；已有的变速只在素材效果卡输入边上，没有用户入口，声音不跟着变。
- **尺子**：手机上选中视频段，能把它改成 0.5 倍或 2 倍，预览、导出画面和声音一致，撤销正确（暂无探针，要做时新写）。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 手机版「速度」项改成：生成一张直通素材效果卡、套在选中段上并设输入边的 `rate`，同时按倍率改片段时长，用现有 `applyCardDefinition` | 复用已有的变速取帧（已进身份键、取帧规则已定） | 3 | 4 | 7 | 未试 | 开放 | 画面成立；声音仍按 1 倍，只能顺手静音，而「自动静音」是用户看得到的行为，实为二级。在线浏览器里用户卡要走隔离执行，手机上成本高 |
| 2 | 1 | 三级 | — | 只在手机版界面里存一个「速度」显示值，不进业务层 | 无 | — | — | — | — | 关闭·剪（无机制） | 预览、导出都不会变 |
| 3 | 1 | 二级 | — | 新增 `TrackClip.speed`，画面按统一时间换算，声音第一版变调（`playbackRate`），桌面编辑分区与手机「速度」同时上 | 业务层有了片段速度，各管线统一换算 | 4 | 2 | 6 | 未试 | 锁住 | 改动见上表，涉及 kernel、render、audio、server 四层；身份键与混音一致性是主要风险；要事先定声音策略 |
| 4 | 1 | 二级 | 3 | 同 3，但声音保调变速：浏览器离线混音自带 WSOLA 一类算法，导出端用 `atempo`，两边对齐 | 声音不变调 | 5 | 2 | 7 | 未试 | 锁住 | 要新算法或依赖；预览与导出一致性难证 |
| 5 | 1 | 二级 | 3 | 同 3，但变速段原声自动静音（界面写明「变速后不出原声」） | 绕开声音一致性 | 3 | 3 | 6 | 未试 | 锁住 | 最省；用户会看到「变速段没声音」 |
| 6 | 1 | 二级 | — | 手机版暂不放「速度」入口，等桌面先有片段速度再照接（维持任务书「设计决定」3：业务层没有的不显示） | 不新增能力 | 1 | 5 | 6 | — | 锁住 | 等于没做到这一条，交用户定 |

按 `solution_table.md`，三级层还有一条开放（行 1），但它的声音问题本质是二级，所以我判断这一条**要用户定方向**，不由会话自己升级：

- 选行 3 / 5（加片段速度，声音先变调或先静音），要动 `src/kernel/`、`src/render/`、`src/audio/`、`server/`，并改 `product/project-model.md`（二级）；
- 或选行 6，先不做。

我的建议是行 3 加行 5 的组合：第一版变速段原声静音并明示，下一版再做保调。理由：画面路径已有成熟的变速取帧可参照，声音一致性是最大风险，先绕开。

## 对任务书或语义的更正建议

- 任务书说渲染取帧在 `src/render/frameMedia.ts`。更准确地说：导出与预渲染的取帧时刻在 `src/render/FrameScene.tsx` 的 `data-pc-media-time` 里算出，`frameMedia.ts` 只按给的时刻 seek。加速度时要改的是前者。
- 待用户项第 4 条「速度」应注明：它是新增二级能力，不是接线；第 4 条列的「业务层没有、手机版没显示」本身已经这么分类，建议在 0.7.19 计划里单列为二级项，先定声音策略。
- 手机版加了滤镜入口之后，`workflow/editing.md`「手机版界面」一节没有提卡片库分类。我没改语义（不在清单里），也不需要改：语义只说「交互以演示稿为准」，演示稿卡片库本来就有「滤镜」分类。
- 关于〔裁〕：本分支没有改任何语义文档，没有二级改动，所以没有〔裁〕。缩略图「先等素材服务收全再取」「按需、限流、缓存」都是三级实现，用户看不出区别（除了不再出现 404），只写在代码注释里。

## 收到的一条串错的消息

工作中收到一条主 Agent 消息，内容是「安全专审回来了……`CloudAiPanel.tsx` 第 103 行……`cloudApi.ts` 我授权你改……写进 `docs/semantics/mechanism/agent.md`」。它说的是 `claude/consent-once` 分支的事：消息里提到的提交 `771b5d3d` 只在 `claude/consent-once` 上，不在本分支；`grantCloudConsent`、`CLOUD_CONSENT_PERMIT_TTL_MS` 在本 worktree 里也不存在。`src/ai/cloud/**` 又是任务书点名不要动的。所以我没有照做，请主 Agent 转给 consent-once 那个 Agent。
