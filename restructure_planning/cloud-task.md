# 云端与文档服务任务书：素材上云、文档服务、改动竞态、Agent 查询进程、在线浏览器模式

这份文件是原第 5～10 步（云端存储层、本机 / 云端文档服务、改动上传的竞态、Agent 的只查询预渲染进程、迁移回滚离线、在线浏览器模式）的**协议全文**，自成一体：动工的人读 `user_pinned_goal.md`、`restructure_planning/render_pipeline_restructure.md`（总览、实测数据、步骤依赖）和这一份就够，不需要再翻 `AGY-TASK-cloud-doc-and-write-race.md`。渲染管线那一半（C、D3～D5、E、G、K、M、F2、F5、J3、J4）在 `restructure_planning/r2-r7-task.md`，以及将要写的 `restructure_planning/r8-streams-task.md`（轨道流 G）和 `restructure_planning/r9-webgl-task.md`（共享 WebGL 渲染器 M）；本文只指路，不重复。

**怎么来的**（2026-09-22）：正文各节取自任务书第 111 版的对应节，逐条折进了四样东西——第 75 轮分步审查里已采纳的处理意见（`restructure_planning/r75/fold-notes.md` 的 r75-07 / 08 / 09 / 10 四节，原文在同一目录的 `agy-r75-07.md`～`agy-r75-10.md`）、`restructure_planning/render_pipeline_restructure.md` 第 3 节与第 6 节的更正、2026-09-22 用户改过的 `user_pinned_goal.md` 架构 1（素材两档的上传 / 拉取顺序）、以及解耦重构之后的文件路径与符号名（`createSnapshot` 一族、`stepMs`、`mode=dev|build`）。

**还没做的事**：这份折叠稿**没有经过独立审查**。第 75 轮审的是折叠之前的第 111 版；折叠本身只有我自己核过锚点和措辞。第 5 步动工前应当让一位没参与折叠的审查者对着代码过一遍 A1 / A3b / I1 / I4 四节。文末「需要定的问题」里的几条没有结论，动工前要先问。

## 读法

- **步骤名的对应**：正文里的「第 1 / 2 / 2b / 3 步」都已落地（提交 `b5c65dc`）；「3b 步」「A2(8)」= R1（差异样式内联），已完成（`e67390e`）；「第 4 步」= `restructure_planning/r2-r7-task.md` 的 R2～R7，加 R8（轨道流）、R9（共享 WebGL 渲染器），**都还没做**。本文是「第 5～10 步」。正文提到 C、E、G、K、M 各节的地方，只需要知道它们是别的步骤的内容：**`streams` 开关在 R8 之前恒为关**，**canvas 卡在 R9 之前照旧在主线程自己画**。
- **本文的步骤依赖**：第 5 步依赖 R1（快照格式与 `snapshotCode` 已定）和 R6（A3a 的目录形状、C3 的就绪索引）；第 6 步依赖第 5 步的内容寻址设施；第 7 步（B）依赖第 6 步的本机文档服务；第 7b 步（I）依赖 R7 的 `interactive` 参数、A7 的镜像插件和第 6 步的本机文档服务；第 9 步（F1 / F3 / F4）排在第 5 步之后；第 10 步（L）依赖 J 全部、A3b、K 全部，是最后一步。
- **行号**：正文里的 `文件:行号` 是 **2026-09-22 在 `048074c` 上逐条打开核对过的**（少数几处明确标注「`b5c65dc` 的行号，仅作提示」）。这些文件之后还会被 R1～R9 动，**行号只作定位提示，以符号名和引用的代码原句为准**。引用的符号在当前代码里都 grep 得到；标「新」的是本任务要创建的。
- **用词**：一律说「生成快照」（`createSnapshot`：`cloneScene → inlineDOMStyles → rasterizeCanvas → stripMedia → serializeScene`）、「预渲染」。「冻住」只用来说被抑制的卡的 `t` 停在某一刻。代码标识符里残留的 `bake*` / `freeze*` 不受这条约束。
- **时间单位**：舞台 RPC 接口、`frame` 消息、`t` 一律用**秒**。
- **三个版本号**：`projectRev`（文档服务，项目每次操作 +1）、`cardRev`（文档服务，卡片源码每次上传 +1）、`localRev`（本地副本，`project` 引用每变一次 +1，播放头不算；和 `session` 一起构成镜像插件的键）。三个都是新字段。`projectRev` 在模式切换时**不归零**（F4）。

**路径缩写表**（正文里的裸文件名都指下面这些；2026-09-22 按解耦后的位置核过，标「新」的文件还不存在、由本任务创建）：`project.ts` = `src/store/project.ts`（`src/kernel/project.ts` 另写全）；`mediaUpload.ts` = `src/editor/io/mediaUpload.ts`；`mediaUrls.ts` = `src/editor/io/mediaUrls.ts`；`mediaTier.ts` = `src/render/mediaTier.ts`；`procp.ts` = `src/editor/io/procp.ts`；`proc.ts` = `src/editor/io/proc.ts`；`drafts.ts` = `src/editor/io/drafts.ts`；`TopBar.tsx` = `src/editor/TopBar.tsx`；`dataMirror.ts` = `src/render/dataMirror.ts`；`prerender.ts` = `src/render/prerender.ts`；`frameClient.ts` = `src/render/frameClient.ts`；`createSnapshot.ts` = `src/render/createSnapshot.ts`（R1 之前叫 `snapshotFreeze.ts`，差异内联在 `src/render/snapshot/inlineStyles.ts`、画布栅格化在 `src/render/snapshot/rasterizeCanvas.ts`）；`snapshotSource.ts` = `src/render/snapshotSource.ts`（新，R6 建）；`streamPlayer.ts` = `src/render/streamPlayer.ts`（新，R8 建）；`StageView.tsx` = `src/StageView.tsx`；`Preview.tsx` = `src/editor/Preview.tsx`；`FrameScene.tsx` = `src/render/FrameScene.tsx`；`MediaLayers.tsx` = `src/editor/preview/MediaLayers.tsx`；`mediaSync.ts` = `src/editor/preview/mediaSync.ts`（R3 搬到 `src/render/mediaSync.ts`）；`VideoTrack.tsx` = `src/render/VideoTrack.tsx`（新，R3 建）；`agentBus.ts` = `src/ai/agentBus.ts`；`mcpExecutor.ts` = `src/ai/mcpExecutor.ts`（按工具名的分支已搬到 `src/mcp/routes.mjs` 的路由表）；`common.ts` = `src/mcp/common.ts`；`OpDetailPreview.tsx` = `src/editor/right/chat/OpDetailPreview.tsx`；`ProjectSettingsDialog.tsx` = `src/editor/ProjectSettingsDialog.tsx`；`frame-pipeline.mjs` / `frame-code.mjs` / `card-identity.mjs` / `card-cache.mjs` / `snapshot-store.mjs` / `mirror-store.mjs` / `costs-store.mjs` / `prerender-client.mjs` / `mcp-tools.mjs` 都在 `server/`；`vite-plugin-*.ts` = `server/vite-plugin-*.ts`；`vite-plugin-docservice.ts` = `server/vite-plugin-docservice.ts`（新，第 6 步建）；vision 拆开之后：`server/vision/http.ts`（`resolveMediaUrls`）、`server/vision/routes.ts`（`ensureGif`）、`server/vision/render.ts`（写死 `lane: 'agent'` 的那一支）、`server/vision/render-queue.ts`（AI 菜单预览插队的落点）、`server/vision/worker-pool.ts`（Agent 专用 Chrome 优先通道的落点）；`server/bakery/bake.mjs` / `chrome.mjs` / `capture-snapshot.mjs` / `ffmpeg.mjs`（`findFfmpeg`）是原 `scripts/export-frames.mjs` 一族拆开之后的位置。

## 六步各做什么、读哪几节、怎么验收

| 步 | 做什么 | 读正文哪几节 | 单步验收 |
|---|---|---|---|
| **第 5 步 素材上云** | A1 的素材上云与按需拉取（两档、分片、断点续传、换档）、A3b 的**块**上传 / 下载、A5。两个云端服务本身不在本仓库，接口形状见组件表 | A1、A3b、A5、A3a（只读「哪些卡上云」那半） | A1 / A3 的验收条目；断网导入再联网只补缺的分片；小版先于原片到达另一台机器 |
| **第 6 步 文档服务** | D1、D2、D4 的服务端侧，含本机文档服务 `vite-plugin-docservice.ts`（WebSocket、操作日志落 `out/docservice/<projectId>.ndjson`、`projectRev` / `cardRev`、内容库）；**A6 卡片源码同步和 A3b 的快照清单读写也在这一步**（它们要内容库） | D1、D2、A6、A3b 的清单那半、组件表的「文档服务」「内容库」两行 | D 的验收条目；`.proc` 仍由页面在 ack 之后写 |
| **第 7 步 改动竞态** | B0～B6，在本机文档服务上先验收，云端模式只是换端点 | B 全节 | B 的验收条目 |
| **第 7b 步 Agent 查询进程** | I0～I4：同一份预渲染代码带 `PROMPTCUT_PRERENDER_MODE=agent`；用户机缺省不单独起（本机有 Agent 时那一个进程以 `full` 跑、Agent 查询优先），`PROMPTCUT_PRERENDER_SPLIT=1` 才拆；Agent 云端环境里单独起 | I 全节 | I 节的两段验收（云端、本机） |
| **第 8 步 D3 的预渲染部分** | `see_frames` 回包附实体矩形。**协议在 `restructure_planning/r2-r7-task.md` 的 D3 节**，落点是 `capture-snapshot.mjs` 的 `afterFonts` 钩子（和 `/api/cards/layout` 同一个） | 只需读 r2-r7 的 D3 | 见 r2-r7 |
| **第 9 步 迁移回滚离线** | F1（素材哈希迁移与两种缓存 GC）、F3（离线攒日志与重放）、F4（模式切换）。F2 回滚开关随 R7、F5 重启恢复随 R6，都在 r2-r7 | F 全节 | F 的验收条目 |
| **第 10 步 在线浏览器模式** | L1～L5：后台 iframe 当预渲染者、IndexedDB 快照库、云端快照直接进热舞台、没有流按拍换快照、两个「将来」只留接口 | L 全节、A3b、J（指 r2-r7） | L 节验收，纯浏览器环境 |

**每一步通用的收尾**：`npx tsc -b --force` 零错误；`npm test` 全过；不改导出像素基线。验证改动用 5197 端口（`.claude/launch.json` 的 `dev-test`），不要碰用户常驻的 5190，不要动 `%LOCALAPPDATA%\PromptCut\runtime\app`。

---

## 总规则：文档服务是所有修改的唯一入口；云端只存代码与 HTML 快照

- **项目文档的真身在文档服务**（本地模式在本机编辑器进程里，云端模式在文档云端），页面的 store 永远是副本，所有改动都经它排序、记版本、发通知、管锁。本地模式跳过素材云端、直接读文件，但**不跳过文档服务**（pinned 架构 2）。
- **云端拆两块**（pinned 架构 1）：**文档云端**是一条 WebSocket、小消息、快速响应（项目 JSON、`projectRev`、卡片源码的 `cardRev`、操作日志、写入身份、锁、通知、D2 的操作级事件），旁边挂内容库；**素材云端**是 HTTP blob 库、大文件大带宽，按 sha256 寻址、不可变（素材字节 `media/<hash>`、HTML 快照块 `snap/<hash>`）。**素材字节和快照块永远不走文档云端的 WebSocket。**
- **上云的只有代码和 HTML 快照，像素缓存（PNG / MOV / 轨道流）永远只在本地。** `canvasHeavy` 卡和图卡只同步代码、本地重放（A5）；`unknown` 卡按下层依赖卡处理，只有本地档快照，不上云、不进流。
- **改动上传：最后写的赢，不做合并；但被覆盖的一方必须知道**（B）。
- **渲染永远在「看图的那一方」旁边、按「谁在看」分进程**：用户机上一个 `full` 进程两方都渲、Agent 优先（拆分时各一个，I4），Agent 云端环境的 `agent` 进程渲云端 Agent 看的（I1～I3）。**云端不渲染**；素材字节只在素材云端和各方的本地内容库，文档云端不存字节。
- **两种运行环境**：**本地模式**（桌面版或本机 dev server，有编辑器进程和预渲染进程）和**在线浏览器模式**（只有页面：文档走文档云端、素材直接打素材云端、Agent 走 Agent 云端、预渲染者是后台 iframe，L）。两种模式下页面、舞台、预渲染、Agent 的代码路径完全一样，只差文档服务的端点和素材层的来源。**页面代码只按宿主能力表分支，不按平台名分支**（J4 的 `hostCapabilities`，见 r2-r7）。

## 组件与术语（只留和本文有关的行）

| 名字 | 在哪 | 职责 | 现状 |
|---|---|---|---|
| **文档服务** | 云端模式在文档云端，本地模式在本机编辑器进程里；同一份代码同一协议 | **所有修改请求的唯一入口**：页面和 Agent 都只向它提交操作，它排序、记版本、发通知、管锁。真身是操作日志（追加写到 `out/docservice/<projectId>.ndjson`，崩溃恢复用；B6 的锁状态变更也作为 `type: 'lock'` 的条目记进同一份日志，重启后靠重放恢复）。**它不写 `.proc`**：`.proc` 的成文和写盘都留在页面（成文 `serializeProc()` `proc.ts:84`——`ai` / `cards` / `snapshots` / `skill` / `thumbnail` 五段只有页面拿得到；写盘走今天的两条路：`TopBar.tsx:306` 的 `writeProcToDisk`（`proc.ts:239`，用 `FileSystemFileHandle.createWritable`，服务端接管不了）和 `drafts.ts:47` 的草稿 PUT），**但只在拿到文档服务对最新操作的 ack 之后才写**，`ProcFile` 加 `projectRev` 记下 ack 过的版本。**一条 WebSocket、小消息、快速响应** | 不存在 |
| **内容库** | 文档云端（云端模式）/ 和本机文档服务同进程（本地模式） | 小件：卡片源码（按 `cardRev`）、快照清单、D2 的操作级事件详情。**块本身不在这里。协议走文档服务的那条 WebSocket，三条消息**：`content.put { kind, key, body }` → `{ ok, hash, rev? }`；`content.get { kind, key }` → `{ body, hash, rev? }`（没有回 `{ missing: true }`）；`content.list { kind, prefix? }` → `Array<{ key, hash, rev? }>`。`kind` ∈ `'card-source'`（`key` = 卡片文件的仓库相对路径，`rev` = `cardRev`，A6）\| `'snapshot-manifest'`（`key` = 共享键，`body` = A3b 的清单）\| `'event-detail'`（`key` = D2 的事件 id）。随文档服务在第 6 步落地，A6 和 A3b 的清单读写是它的第一批客户端 | 不存在 |
| **素材云端** | 云端（只在云端模式存在；本地模式直接读本地内容库的文件，跳过它，不生成小分辨率版、不上传） | **大文件大带宽的 blob 库，按 sha256 寻址、不可变**：素材字节 `media/<hash>`、HTML 快照块 `snap/<hash>`；HTTP，Range/206，分片上传 + 断点续传，可挂 CDN；配额 + LRU；**没有项目语义、不转码** | 不存在 |
| **本地内容库** | 用户机 / Agent 云端环境 | 按哈希存素材字节。本地模式：素材的真身，`/@media/<hash>` 直接读文件；云端模式：素材云端的本地缓存兼上传队列——本机导入的先落这里再上传，别处引用的按哈希从素材云端拉进来。落点是 `out/media`（`vite-plugin-media.ts:17` 的 `outRoot`，`:67` 拼 `media/`），文件名 `<hash>.<ext>`（`:171` 的 `resolveHashFile`） | 已有（按哈希存已落地，`vite-plugin-media.ts:235` 的 `storeMediaStream` 边落盘边算 sha256） |
| **Agent 服务端** | 云端或用户机，同一份代码，按部署位置选预渲染 base URL（I4(c)） | 对话记录、收件箱、向文档服务提交操作、向文档服务提交操作级事件（D2；由文档服务经那条 WebSocket 推给页面，**Agent 服务端不直接连页面**）、`get_layout`、`message_ignore`（B3）、`send_message`（B5） | 不存在（今天 `vite-plugin-ai.ts` 的服务端工具就在编辑器进程里） |
| **Agent 云端环境** | 云端，与项目云端分开 | Agent 进程 + 自己的本地内容库（按哈希从素材云端拉，可用 `.procp` 预灌）+ 一个只查询预渲染进程；从文档云端拉项目和卡片源码，`see_frames` / `get_layout` / `inspect_card_dom` / `get_gif` 打自己的预渲染进程 | 不存在 |
| **预渲染进程** | 用户机 / Agent 云端环境 | 同一份代码有 `user` / `agent` / `full` 三种模式（pinned 架构 4，I1）：`user` 只预渲染（锚帧、快照、轨道流），`agent` 只接 Agent 的查询、不预渲染，`full` 三条 lane 都建、Agent 查询优先。用户机上缺省一个进程：本机有 Agent 时 `full`，没有时 `user`；`PROMPTCUT_PRERENDER_SPLIT=1` 时拆成两个（I4(d)）。`/api/cards/layout` 只在 `agent` / `full` 模式挂，借 `agent` lane，`user` 模式回 `503 NO_AGENT_LANE`。`user` / `full` 的实例 spawn 时多传 `PROMPTCUT_EDITOR_URL`（`agent` 模式不传） | 已有（`agent` 模式和第二个进程不存在） |
| **`.procp`** | 文件 | 离线交换包：zip，首条目 `project.proc`，其余 `media/<hash>.<ext>`。**只打包原片**（`tiers.original`）——小分辨率版是可再生的派生物，不进包。导入 = 解包进本地内容库 + 把素材云端没有的哈希排队上传；导出 = 从本地内容库打包，缺的先从素材云端拉。不再是素材字节的唯一通道 | 已落地（`procp.ts` 自写 zip） |
| **镜像插件** | 两个进程都挂 | `vite-plugin-mirror.ts:158`：按 `{session, localRev}` 存最近 8 版项目（`mirror-store.mjs`），接收两层 diff；三个端点 `/api/data/project` `:163`、`/api/data/diff` `:196`、`/api/data/playhead` `:223`；`ensureMirror:60`（`user` / `full` 模式缺哪版就按 `PROMPTCUT_EDITOR_URL` 回拉）、`repushMirror:121`（重启补推）。**Agent 的查询走它的整份推那条路**（I2） | 已落地 |
| **在线浏览器模式** | 用户浏览器 | 只有页面、没有本机进程（pinned 架构 3）：文档走文档云端、素材直接打素材云端、Agent 走 Agent 云端；后台 iframe 当预渲染者（L1），快照存 IndexedDB（L2），云端快照直接进热舞台（L3），没有流（L4）；云端合并分发、在线重型控件服务只留接口（L5） | 不存在 |
| **云端** | 泛指 | **项目云端** = 文档云端（文档服务 + 内容库）+ 素材云端，两块按访问模式分、可以分开部署。**访问模式**（每个项目一次只在一种）：**本地模式** = 本机文档服务 + 直接读文件，没有素材云端、不上传任何东西；**云端模式** = 文档云端 + 素材云端。F4 负责切换。**Agent 云端** = Agent 服务端 + Agent 云端环境，只是文档云端和素材云端的一个客户端 | 不存在 |
| **面向平台** | 全部 | 六个平台只有两种运行形态（pinned 平台，第 2～6 项共用在线浏览器模式的全部机制）：**桌面版 APP** = 本地模式；**桌面浏览器 / iPad 浏览器 / iPad APP / 手机浏览器 / 手机 APP** = 在线浏览器模式。APP 壳里没有 Node 也没有预渲染进程。**iPad APP 与手机 APP 的原生壳本任务先不做**，只保证在线浏览器模式的代码不依赖平台名。**Agent 端**（Agent 服务端 + 预渲染进程的 `agent` / `full` 模式）面向 Windows、Linux、Ubuntu，差异只在无头 Chrome 的启动参数与系统字体、ffmpeg 可用的编码器、路径与端口文件的形状，见 I0 | 新增 |

---

## 目标 A：云端存储层

两种访问模式。**本地模式**：文档服务跑在本机编辑器进程里（同一份协议），素材直接读本地内容库的文件，没有素材云端。**云端模式**：文档云端存项目文档、卡片源码、快照清单；素材云端按 sha256 存素材字节和 HTML 快照块。`.procp` 是离线交换包，不再是素材的唯一通道。像素缓存（PNG / MOV / 轨道流）永远只在本地。

**已落地的部分**（`b5c65dc`，不重复细节）：A0 卡片能力审计（审阅表 `src/cards/capabilities.json`、`checkCardSource` `vite-plugin-cards.ts:702`）；A1 的素材键与路由（sha256 在服务端边落盘边算 `vite-plugin-media.ts:235`、`/@media/<hash>` 哈希优先 `:508`、`mediaUrlFromHash` `mediaUrls.ts:24`、`.procp` 自写 zip、`project.media[i]` 已有 `hash` / `ext` / `size` / `pending` / `tiers` 五个字段，`src/kernel/project.ts:140` / `:142` / `:151`）；A2 快照格式改造（全部，含 R1 的差异样式内联）；A3a 的键与目录形状（`cardSnapshotIdentity` `card-identity.mjs:99`、`snapshot-store.mjs` 的两档目录与 `index.json`、`snapshotTier` `:61`）；A3c 的体积上限（R1 之后实测：DOM 卡 p90 185.8 KB、canvas 位图 p90 466 KB / max 628 KB，超 300 KB 的 DOM 卡只剩两张 `lottie-*`）；A4、A7（镜像插件）。

### A1 素材上云、按需拉取、两档、分片（第 5 步，只在云端模式）

**上云。** 导入落本地内容库后排队上传素材云端。`project.media[i]` 加 `uploaded`，**按两档分开记**：

```ts
uploaded?: { small?: boolean; original?: boolean };   // 只在云端模式有
```

（`tiers` 的形状不动：`MediaTiers { small?: string; original: string }`，`src/kernel/project.ts:115-118`，值是各自的内容哈希，`original` 就是 `MediaAsset.hash`。）

**上传一律走分片**，没有整件 `PUT media/<hash>` 这条路：

- `PUT media/<hash>/<n>` —— 固定 8 MB 一片，小于 8 MB 的素材就是 1 片；
- `GET media/<hash>/chunks` → `{ size, chunkSize, received: number[], complete }` —— 断点续传只补 `received` 里缺的片；
- `POST media/<hash>/complete` —— 服务端按 sha256 校验全件，不符回 409；校验过了这一档的 `uploaded` 才翻真。

上传后台、低优先级，不挡编辑；项目提交（B）不等上传完成。别的客户端引用到还没传完的哈希时，那一层透明并提示「等待上传方」。

**两档，先小后大**（pinned 架构 1，2026-09-22 定稿）：

1. **小分辨率版** = 等比缩到 800×600 以内的 H.264（`-preset veryfast -crf 26`，帧率跟原片、上限 60，AAC 64k，`-movflags +faststart`）；
2. **原片**保持原编码，没有 faststart 的先 `-c copy -movflags +faststart` 重封装（moov 在前，Range 拖动不用整段下完）。**不转码原片**——转码会破坏「导出只用原片」和导出像素基线。

两档都在**导入方本机**用 `findFfmpeg`（`server/bakery/ffmpeg.mjs`）生成，**云端不转码**。桌面版自带 ffmpeg；在线浏览器模式没有本机 ffmpeg，**浏览器里导入的素材只有原片一档**（别人拉它时按 pinned「还没有小版就直接拉原片」走；「桌面版发现云端缺小版就补转一份传上去」记在 `restructure_planning/future_planning.md` 第 1 条，以后再做，本任务不做，也不在页面里用 WebCodecs 转）。

**上传队列的顺序**：**逐个素材，同一个素材先传小分辨率版、再传原素材，两份都 `uploaded` 才轮到下一个素材**。（第 111 版写的是「所有素材的小版先传、原片后传」，按 2026-09-22 的 pinned 改成这一条。）

**原片可不可播。** 原片保持原编码，可能是浏览器放不了的格式（ProRes、DNxHD、10 bit HEVC 之类）。导入时探一次可播性，写 `media[i].playable`；`playable === false` 的素材**预览永远停在小分辨率版、不换档**，导出照旧只用原片。

**按需拉取。** `/@media/<hash>` 在本地内容库找不到时，`vite-plugin-media.ts:508` 那条路由先向素材云端 `GET media/<hash>`（流式落盘到本地内容库、边落边按 Range 服务），素材云端 404 才回 404。页面照常挂 `src`，同一次请求就拿到字节，没有「重挂」这一步；首字节到达前 `<video>` 只是在缓冲、那一层什么都不画，这就是它的「透明」。

**预取队列。** 打开项目后编辑器进程的媒体插件按两档先小后大、按片段在时间轴上的先后，把项目引用的每个哈希拉进本地内容库。页面每 2 秒问一次 `GET /api/media/local?hashes=`（端点已落地，`vite-plugin-media.ts:486`；只在还有素材没到顶档时问），拿到「本地已完整落盘的哈希集合」；**超过 100 个哈希分批问**，别把它们塞进一个查询串。在线浏览器模式没有这个端点，见下面 `playbackUrl` 的 `cloudBase`。

**换档 = 槽位级的换段。** `project.media[i].url` 保持 `/@media/<original 哈希>` 不变（它是身份）。要改的两处服务端改写：`vite-plugin-frames.ts:53-54` 今天是「`m.path` 存在且（`m.url` 缺失、是 `blob:` 或不以 `/@export/` 开头）就改写成 `/api/media/file?path=`」，改成 `m.hash` 存在时一律保留 `/@media/<hash>`、只对没有 `hash` 的迁移期素材才按 `path` 改写；`server/vision/http.ts:45` 的 `resolveMediaUrls` 同样。

`mediaTier.ts:18` 的 `playbackUrl` 已经有占位实现（今天只做「有 hash 就用 `/@media/<hash>`」），本步把它补成：

```ts
playbackUrl(
  media: Pick<MediaAsset, "url" | "hash" | "tiers" | "playable">,
  localHashes: Set<string> | string[] = [],
  opts?: { cloudBase?: string },
): string
```

规则：按「本地已完整落盘的最高档」返回 `/@media/<那一档的哈希>`；集合为空时 `tiers.small` 存在就返回小分辨率档、否则才返回原片档（pinned 架构 1 先小后大，打开项目第一帧不能直接拉原片）；`playable === false` 时永远返回小分辨率档。给了 `cloudBase` 就返回绝对地址（在线浏览器模式直接打素材云端，`localHashes` 改由文档云端项目里的 `uploaded` 标记决定）。

**只有 live 路的 `VideoTrack`（R3 抽出来的那份，即今天 `MediaLayers.tsx` 的 `<video src>` / `<img src>`）从 `playbackUrl` 取 `src`**；`FrameScene` 的 `placeholder` 路、预渲染、导出、`see_frames` 一律用 `media.url`（原片）。`localHashes` 由主文档每 2 秒问一次 `/api/media/local` 得到，经 E0 新增的 `setLocalHashes(hashes: string[])` 下发给可见舞台，`FrameScene` 加 prop `localHashes` 透传给 `VideoTrack`；legacy 分支不下发。

换段的接法（`mediaSync.ts` 的 `planSlots` 那条路，具体行号见 r2-r7 的 E7 与 R3 搬家清单）：`VideoTrack` 在喂 `planSlots` 之前把 `cur` / `next` 的 `url` 换成 `playbackUrl(...)` 的结果，`holding` 改成同时比 `id` 和 `url`，`sameUrl` 不动——**url 变了就是新段**，同一片段换档就等于换了一段；`MediaLayers` 里那个「`s.clip?.id === c.id` 就早退」的判断也改成同时比 `url`，于是 `lastSeekAt.delete(el)` 会跑、700 ms 冷却不会吞掉回跳。换段前记 `currentTime`，React 换好 `src` 后在 `loadedmetadata` seek 回去，不跳、不重头。导出侧原片没到就是「等待上传方」，**不拿小分辨率档代理导出**。

**为什么不做单流时间分层**：H.264 没有时间分层；VP9 / AV1 的 temporal layer 只能经 WebCodecs 用、`<video>` 不认，补全等于整段重解。参考帧占一份编码一半到七成的字节，首播要等的量只比整片少一点，收益远小于换档。留到将来给原片档做补全（不做清单）。

### A3a 共享键与两档快照（只留「哪些卡上云」那半；键与目录形状已落地，其余在 R6）

**共享快照（可上云）**：审阅表 `independent` 或 `sourceDependent` 且 `stateful` 的卡，canvas 卡同样按这个判据（它的快照里 `[data-pc-gl-plane]` 已转成 `<img>`，R9）。键是 `cardSnapshotIdentity`（`card-identity.mjs:99`），在 `card-identity.mjs` 原有的剥除之外**再剥 `clipId`**，加上 fps、采样相位、片段时长、解析后的片段框宽高、主题 id、`fontFingerprint`（定义见 I0）和 `snapshotCode`（`frame-code.mjs:75`，哈希 `SNAPSHOT_FILES` `:71`）。内容寻址、与位置无关，所以能跨机复用。存 `<root>/controls-html/<共享键>/<本地帧>.html`。

**本地专用快照（不上云）**：其余预渲染集合里的 `stateful` 卡，含 `belowDependent` 毛玻璃卡和 **`unknown` 卡**（`unknown` 一律按 `belowDependent` 处理——只有本地档，不上云、不进流；代码要跟一处：`snapshot-store.mjs:61` 的 `snapshotTier` 今天对 `unknown` 回 `'none'`，改成 stateful 的 `unknown` 回 `'local'`，这一改属于 R4 / R6 的范围）。存 `<root>/controls-local/<entry.key>/<共享键>/<本地帧>.html`。

**图卡只做本地档**（A5）。目录形状、`index.json`、两档判据的完整口径在 `restructure_planning/r2-r7-task.md` 的 A3a。

### A3b 快照上云与下载（只在云端模式；本地模式共享档也只留在本机 `controls-html/`）

**只有共享档上云。** 三条不上云的规则，顺序是先卡级、后块级：

1. **卡级（A5）**：`canvasHeavy` 卡和图卡只同步代码、不上传快照；`unknown` 和 `belowDependent` 只有本地档，本来就不上云。
2. **块级**：`data:image` 占比超过一半的块不上云（传它不如本地重算）。
3. **体积兜底**：任何一帧快照超过上限（DOM 卡 300 KB、canvas 卡位图 1 MB）**不进就绪索引、不投递、也不上云**。

**上传**：块按内容 sha256 `PUT snap/<hash>` 到素材云端（不可变、天然去重）；配额 + LRU 在素材云端。

**清单**写文档云端的内容库（`content.put { kind: 'snapshot-manifest', key: 共享键, body }`，第 6 步才有内容库）。清单形状：

```ts
{ key: string, frames: Array<[localFrame: number, blockHash: string]>, skipped: Array<[from: number, to: number]> }
```

`skipped` = **已产但故意不上云**的本地帧闭区间（上面三条规则任何一条命中）。下载端见到 `skipped` 就走本地预渲染，**不等**。

**下载**：打开项目时按每张共享卡的共享键 `content.get` 取清单，本地 `controls-html/<共享键>/` 缺的块从素材云端按哈希拉。**落盘走 `snapshot-store.mjs` 里的同一个写入函数**（写文件 + 更新该目录的 `index.json`，区间合并用 `mergeRanges` `:30`），C3 才算它就绪——绕过这个函数直接写文件会让 `index.json` 和磁盘不一致。换一台机器打开同一项目，Motion 卡不用重新预渲染。

**分步**：块的 `PUT` / `GET`（按哈希）在第 5 步；清单的读写在第 6 步（要内容库）。第 5 步的单步验收只能用本机已有的 `controls-html/` 目录自验（把键列表直接喂给上传 / 下载函数），**跨机复用要等第 6 步接上清单才能端到端验**。

### A5 不上传缓存的卡（第 5 步）

`canvasHeavy` 卡和图卡（H）只同步代码，本地重放；图卡的像素、`ImageBitmap`、音频块永远只在本地算。

**A5 是卡级，A3b 的「`data:image` 过半不上云」是块级，两层**：先按 A5 判这张卡上不上云，再按 A3b 判这个块上不上云。

### A6 卡片源码同步（走文档服务的内容库；**第 6 步**，不是第 5 步）

每个卡片文件记内容哈希。文档服务每次收到卡片源码就发新的 `cardRev`（本地模式下由本机文档服务在 `edit_card` / `create_card` 落盘时自增，「同步」那一半是空操作，B3 / B4 / B6 照常有版本轴）。本地记上次同步到的 `cardRev`；本地未改且云端更新则下载，本地改了则上传（后上传的赢，见 B）。走内容库的 `content.put` / `content.get`，`kind: 'card-source'`、`key` = 卡片文件的仓库相对路径、`rev` = `cardRev`。

**它为什么在第 6 步**：内容库和 `cardRev` 都是本机文档服务的产物，第 5 步还没有它们。

---

## 目标 B：改动上传的竞态（第 7 步）

原则：**最后写的赢，不做合并；但被覆盖的一方必须知道。** 前提是 D1（Agent 直接写文档服务）。在本机文档服务上先验收，云端模式只是换端点。

- **B0 传输是一条 WebSocket。** 每个客户端（编辑页、Agent 服务端）到文档服务一条长连接（本地模式打编辑器进程里的本机文档服务，云端模式打文档云端，协议相同）：提交操作 → 回 ack（新的 `projectRev` / `cardRev`，或拒绝原因）；别人的操作、B3 / B6 的通知、锁状态变更、D2 的操作级事件、内容库的三条消息都从这条连接走，**不轮询**。断线按 F3 攒本地日志、重连后按序提交。**素材字节和快照块不走它**（素材云端，A1 / A3b）。

- **B1 每次写带身份。** `actor = human:<userId>/<pageSession>` 或 `agent:<agentId>/<conversationId>`，文档服务记进每个版本。

- **B2 覆盖前备份。** 被覆盖方换成**文档服务上的最新版本**（本地模式是本机文档服务的，云端模式是文档云端的）之前，先把自己那份存成本地备份：复用 `edit_card` 的备份机制——`vite-plugin-cards.ts:1197` 今天是 `isUserDef ? undefined : backupBeforeEdit(root, target, before)`（`backupBeforeEdit` 在 `:175`），**用户卡不备份，改成用户卡也备份**。**备份由接收方客户端在收到 B3 通知、换版本之前自己做**，路径由它自己补进气泡 / 收件箱条目——文档服务的通知里不带路径（它不知道各客户端的磁盘）。

- **B3 通知对象按最近参与者算。** 每张卡记最近 10 个 `cardRev` 或 30 分钟内的写入者；新版本落地时，列表里除本次写入者外每人收通知（内容：接收方最后写的 `cardRev`、当前 `cardRev`、相对那版的 diff 摘要）。人类收气泡；Agent 收收件箱。**退出跟踪**：Agent 调 `message_ignore({ cardId })`（Agent 服务端自己的工具，不进 `MIRRORED_TOOLS`、不经预渲染进程）、人类点「不再提醒」，两者发同一条 WebSocket 消息 `{ type: 'card.unfollow', cardId }`，文档服务把发送方从这张卡的写入者列表剔除。单位是卡；再写会重新进入；熔断不受影响。

- **B4 写工具带期望版本，只约束 Agent 的写工具。** 页面的在线操作**不带**期望版本，按到达顺序落地、最后写的赢（离线重放的第一条是例外，F3）。Agent 的 `edit_card` 带 `expectedVersion = cardRev`，项目写操作带 `expectedVersion = projectRev`；不符就拒绝并说明。**项目级没有「写入者列表」**（B3 的列表按卡记），所以项目级不另发 B3 通知：被拒的一方从拒绝回包里拿

  ```ts
  { rejected: true, reason: 'stale', currentRev: number,
    since: Array<{ rev: number; actor: string; opSummary: string }> }
  ```

  `since` 是期望版本之后落地的每个操作。Agent 服务端把它**原样**放进工具结果，模型据此重读再改。

- **B5 Agent 间消息。** `send_message(agentId, text)`；存 Agent 服务端按 agent id 投递；返回投递状态和对方最后活动时间。

- **B6 互改熔断。** 同一张卡 30 分钟窗内两个 Agent 交替写入超过 6 次：锁**上一个写的**那个对这张卡的写权限，最后写的继续。被锁方对这张卡**源码**的写工具（`edit_card`、带 `overwrite` 的 `create_card`）都收拒绝并附最后 6 次改动；**定位类工具写的是项目 JSON，不在锁的范围**。双方收件箱各一条；人类气泡带「看改动」「解锁」。解锁 = 人类点，或继续者在这张卡上 30 分钟无活动后自动解锁并通知被锁方。

---

## 目标 D（节选）：D1 Agent 直接写文档服务、D2 页面按操作收增量（第 6 步）

D3（命中测试与实体矩形）、D4（`get_layout`）、D5（舞台露出来）的协议在 `restructure_planning/r2-r7-task.md` 的「目标 D」；其中 **D4 的服务端侧落在本文的第 6 步**——把 `MIRRORED_TOOLS`（`vite-plugin-ai.ts:207`，那张「服务端直接执行、经 `prerenderPost` 打预渲染进程、不经页面」的工具表）搬去 Agent 服务端，`get_layout` 进这张表；**D3 的预渲染部分是第 8 步**，协议同样在 r2-r7。

- **D1 Agent 直接写文档服务。** 写工具不再经页面执行（今天是经 SSE 送进页面、由 `mcpExecutor.ts` 改 store，`agentBus.ts`）；Agent 作为文档服务的客户端提交操作（带 B1 身份、B4 期望版本），页面和其他客户端一样收操作。**本地模式也一样**：本机 Agent 服务端向本机文档服务提交，页面不再是「唯一写 store 的人」。

  **只有必须在页面里做的工具留在页面**，判据：**只读页面独有状态、既不写项目也不写卡片的那些**（选区、播放头交互、面板 UI、`web_handoff` 一类）。`mcp-tools.mjs` 里逐条标。

  一个连带后果：今天 `mcpExecutor.ts` 在页面工具调用的公共出口上调 `flushDataMirror()`，D1 之后写工具不再经页面执行，它对写操作不再触发；Agent 服务端不能再靠它保证读后写一致，改由 I2 的「先 ack、再推镜像、再查」保证。

- **D2 页面按「操作」收增量。** 每个工具调用两条事件：创建时（工具名、图标、目标片段、参数摘要）和完成时（状态、摘要、耗时）；文字回复整条完成时推；每条事件只更新对应记录；列表虚拟化。

  **完整参数按事件 id 拉**：Agent 服务端在发「创建」事件的同时，把完整参数作为小件写进内容库 `content.put({ kind: 'event-detail', key: 事件 id, body })`；页面展开那一条时 `content.get({ kind: 'event-detail', key: 事件 id })`。同一条 WebSocket，协议见组件表的「内容库」行。

  **推送方向**：Agent 服务端把操作级事件提交给**文档服务**，由文档服务经那条 WebSocket 推给页面；**Agent 服务端不直接连页面**。

---

## 目标 F（节选）：素材哈希迁移与 GC、离线、模式切换（第 9 步）

F2（`?preview=legacy` 回滚）随 R7、F5（预渲染进程重启后的就绪索引恢复）随 R6，协议都在 `restructure_planning/r2-r7-task.md` 的「目标 F（节选）」。下面三项依赖第 5 步的内容寻址设施（A1 两档、A3b、A5），排在第 5 步之后。

- **F1 素材哈希迁移与两种缓存 GC。** 旧 `.proc` 打开时后台算 sha256，算完前按文件名解析。

  **帧缓存的 GC**：只扫 `this.root` 的直接子项，跳过 `controls`、`controls-html`、`controls-local`、`streams`、`tracks`，其余 hex 目录按 mtime 保留 7 天（`tracks/` 下也有 hex 子目录）；五个共享目录做引用计数 + LRU。

  **本地内容库（`out/media`）另有口径**：本地模式下它是**素材的真身，不自动回收**，只在用户显式「清理未引用素材」时删；云端模式下它是素材云端的本地缓存兼上传队列，按 LRU + 配额（默认 20 GB，可配）**只淘汰「两档都已 `uploaded` 且当前打开的项目不引用」的条目**，上传队列里的永不淘汰。

- **F3 离线。** 云端不可达时照常编辑，操作攒本地日志；恢复后按序提交：**只有第一条**用离线时记下的 `expectedVersion` 做冲突检测，它被 ack 之后，后续每一条的 `expectedVersion` 改写成上一条 ack 回来的 `projectRev`（`cardRev` 同理，按卡各记一条链）。第一条被拒说明离线期间别人写过，**整批停下**，走 B2 备份 + B3 通知，由人决定重放还是丢弃。

  素材：离线导入只落本地内容库，恢复后补传；别处引用、本地没有的哈希在恢复前那一层透明。离线交换只靠 `.procp`。

  **上面这三句只对有本机进程的宿主（桌面版）成立。** 在线浏览器模式没有本地内容库：离线时操作日志攒在 IndexedDB、恢复后走同一套重放规则，**素材导入按钮置灰**（提示「离线时不能导入」），`.procp` 导入 / 导出第一版不支持（见不做清单）。

- **F4 模式切换是显式操作，不自动。**

  **本地 → 云端**：项目整份推到文档云端后立刻标成云端模式。文档云端没有这个 `projectId` 就新建，`projectRev` **沿用本机文档服务的当前值、不归零**——本机文档服务从第 6 步起一直在记 `projectRev`，归零会让「云端 → 本地 → 云端」往返一圈版本号回退。云端已有同一 `projectId` 就带 `expectedVersion`（= 上次从云端拉下来时记的 `projectRev`），不等就走 B2 备份 + 拒绝回包的 `since`（B4），由人决定覆盖还是另存为新项目。素材按 A1 两档生成并上传、共享快照按 A3b 上传，都在后台低优先级跑，传完前别的客户端看到的是「等待上传方」。

  **云端 → 本地**：拉整份项目和**原片**进本地内容库、本机文档服务接管，`projectRev` 续用。

  编辑锁只覆盖「整份推送 + `projectRev` 切换」那一小段，转码和上传期间照常编辑。

---

## 目标 I：Agent 的只查询预渲染进程（第 7b 步；本机第二进程与 Agent 云端环境共用一份代码）

**为什么分进程。** Agent 的看图是成批的长活（一批 `see_frames` 几十帧、`inspect_card_dom` 重挂载 + 补跑），用户的是零碎的短活（锚帧、layout、轨道流分段）。同一个进程里即使分 lane（`frame-pipeline.mjs:90` 的 `laneChains`），也共用一个 Node 事件循环、一个 Vite、一组 Chrome，谁卡谁说不准。所以**渲染代码一份、进程按「谁在看」分开**：`user` 模式服务用户，`agent` 模式服务 Agent。Agent 在用户机时和用户共用本地内容库，在云端时从素材云端按哈希拉进自己的本地内容库。

### I0 Agent 端跨平台（Windows、Linux、Ubuntu）

预渲染进程和 Agent 服务端是同一份 Node 代码，三处按平台**探测**、不按平台名分支：

1. **无头 Chrome**：`CHROME_ARGS`（在 `server/bakery/chrome.mjs`）**保持不动**——它已经把 WebGL 固定在 SwiftShader 上（`--disable-gpu*` + `--enable-unsafe-swiftshader`，为的是逐字节确定性），跨平台同一条光栅路径、不需要 GPU。Linux 上**只**在 `process.getuid?.() === 0 || 存在 /.dockerenv` 时追加 `--no-sandbox --disable-dev-shm-usage`，**不加任何 `--use-gl` / `--use-angle`**（会换光栅路径、破坏确定性）。

   **字体不随包分发**（不做清单）：Agent 端的部署脚本在 Linux 上装同一套字体包（`fonts-noto-cjk` 等，清单写进新文件 `docs/agent-deploy.md`），缺字体时启动自检报错而不是静默换字。共享键里的 `fontFingerprint` = `document.fonts` 里已加载的 family 名排序拼串，**它的计算属于 A3a、已在第 2 步落地**，I0 只负责部署时装同一套字体和缺字体时的启动自检。同一字体指纹下 Windows 和 Linux 产出的快照上云后互相可用，指纹不同的另存一份；`scripts/verify-unified-frames.mjs` 的像素比对按平台各留一份基线。

2. **ffmpeg 的编码器按 `ffmpeg -encoders` 探测**：`h264_nvenc`（NVIDIA）→ `h264_qsv`（Intel）→ `libx264`（兜底）。第一版**不做 `h264_vaapi`**（要 `hwupload` / `nv12` 的专用 filter 链，和 G3 写死的 `format=yuv420p` 链尾不兼容，alpha 上下拼合在它下面是否成立未实测）。R8 的编码原型在每个平台各跑一次、结果写进报告。

3. **路径与端口**：`port.json`、`out/` 目录、`PROMPTCUT_EDITOR_URL` 用 `path.join` / `os.tmpdir()`，不写 Windows 形状；服务端不依赖 `runtime\app` 那份副本的布局。

**验收**：同一项目在 Windows 和 Ubuntu 22.04 上跑 `agent` 模式的 `see_frames`，30 帧全部返回、无 `EACCES` / 字体缺失警告；两平台各自的像素基线通过；**`full` 模式在 Ubuntu 22.04 上也跑一遍**（pinned 平台末句把 `full` 也算进 Agent 端）。

### I1 模式开关

`vite-plugin-prerender.ts` spawn 预渲染进程时传的环境变量（`:80-88`）再加 `PROMPTCUT_PRERENDER_MODE`，三种值（pinned 架构 4）：

- **`user`**（只有交互编辑在本地）：只预渲染预渲染集合里的卡——锚帧、快照、轨道流；**不建 `agent` lane**，`/api/cards/layout` 回 `503 NO_AGENT_LANE`。
- **`agent`**（只有 Agent 在本地或托管在服务器）：不预渲染、只查精确某帧，只建 `agent` lane。
- **`full`**（交互编辑和 Agent 都在本地）：三条 lane 都建，**优先 Agent 查询、其次预渲染**——「优先」= 可以插队，不是进程优先级更高（细则见 I4(b)）。用户机有本机 Agent 时的缺省。

lane 名（`user` / `agent` / `background`，`frame-pipeline.mjs:90`）和模式名**同字不同物**：代码里模式用 `PRERENDER_MODE` 常量、lane 用 `LANE` 常量，别混。Agent 云端环境自己以 `PROMPTCUT_ROLE=prerender PROMPTCUT_PRERENDER_MODE=agent` 直接起 `vite --config vite.prerender.config.ts`（不经编辑器进程，云端没有编辑器进程）。

**`agent` 模式下**：`FramePipeline` 只建 `agent` 一条 lane（`user` / `background` 不建，`acquire('background', …)` 直接抛 `cancelled`）；`/preload` 回 `{ ok: true, skipped: 'agent' }`；`streamPool` 大小 0；C2 锚帧和 G 的生产不启动；就绪 SSE 只发 `reset`。

**`/api/cards/layout` 和 `bake_card` 在 `agent` / `full` 模式下一律借 `agent` lane 的那一个 bakery**（`frame-pipeline.mjs:195` 的 `acquire(lane, project)`，`:931-933` 已经把 layout 排进 `agent` 链），**不经 `streamPool`**。

**`/api/cards/dom`（`inspect_card_dom`）今天自持一个 Chrome**——`vite-plugin-cards.ts:1237` 的 `domBakery`、`:1239` 的 `domChain` 串行队列、`:1275-1276` 的 `openBakery({ url })` / `reset(null, url)`、`:1292` 出错时的 `close()`、`:1296` 的 90 秒空闲关闭，和 `FramePipeline` 的 lane 无关。改法：

- `agent` / `full` 模式下换成 `const bakery = await pipeline.acquire('agent', project)`（**两个参数**；`:204` 直接读 `project.width`，所以 `project` 要用 `renderDomTree` 的入参 `isoProject`，**不能从 `domProjects` 取**——那里存的是 `JSON.stringify` 出来的字符串，喂进去 `project.width` 是 `undefined`）；返回值就是 bakery 本身，直接有 `.reset` / `.page`，`:1275-1276` 换成 `await bakery.reset(null, url)`。
- **`:1239` 的 `domChain` 保留**：`laneChains` 只串行化请求批处理的 `flush`（`frame-pipeline.mjs:352`），`acquire` 的调用点在 `readFramesCore` 里（`:464`），从 `/api/cards/dom` 直接调 `acquire` 不进链，删了 `domChain` 就会和在飞的 `see_frames` 同时驱动同一个页面。`agent` / `full` 模式下让 `see_frames` 的 `agent` 批处理和 `/api/cards/dom` 排**同一条队**：把 `domChain` 换成 `pipeline.laneChains.get('agent')` 那条链，`/api/cards/dom` 的活以「先等链、再 `acquire`、干活、把自己接回链尾」的方式挂进去。
- `:1292` / `:1296` 在这两种模式下**不得**调 `bakery.close()`（那是 pipeline 的 lane bakery）。**空闲关闭统一由 `FramePipeline` 做**：`release('agent')` 今天对 `agent` 直接早退（`frame-pipeline.mjs:292`），改成**只重置空闲计时器**；`/api/cards/dom` 和 `see_frames` 干完活都调 `release('agent')`；`agent` lane 的空闲计时器 10 分钟到点就 `bakery.close()` 并从 `this.lanes` 删掉，下次 `acquire` 重开。
- `user` 模式没有 `agent` lane，这条路由回 `503 NO_AGENT_LANE`。

不改就多起一个 Chrome，违反验收第一条。**一个 Chrome，按需拉起，空闲 10 分钟关。**

### I2 项目和代码从哪来

**云端**：Agent 服务端（D1）每拿到新的 `projectRev` 就把整份项目 `POST` 到自己 `agent` 进程的镜像插件（`vite-plugin-mirror.ts:163` 的整份推那条路；`session` 用 Agent 的身份 id，`localRev` = `projectRev`）。云端起的 `agent` 进程 `PROMPTCUT_EDITOR_URL` 为空即跳过回拉。

**本机**：同一条路——Agent 服务端拿到本机文档服务的 ack（新 `projectRev`）之后，把整份项目 `POST` 到本机 `agent` 进程的镜像插件（同一对键）。`agent` 模式的进程不带 `PROMPTCUT_EDITOR_URL`（`full` 模式带，它也服务用户）。

**Agent 侧的查询一律带 I2 推送时的同一对键**：`see_frames` / `get_gif` / `inspect_card_dom` / `get_layout` 的请求体都带 `{ session: agentId, localRev: 刚 ack 的 projectRev }`，**先推到 200 再查**。`agent` 模式不回拉，所以键不在时服务端回 409 `MIRROR_MISSING`，**Agent 服务端重推一次再查**；第二次仍失败才回错给工具调用方。（`/api/cards/layout` 的 body 形状不改，`vite-plugin-frames.ts:86` 注释里写的就是 `{ session, localRev, t, clipIds? }`。）

**卡片源码**：云端是 Agent 云端环境的仓库副本 + 内容库同步下来的 `src/cards/user/*.tsx`（A6 那条路，同用户机）；本机就是用户机上那份仓库。**快照不需要**：`agent` 模式每次查询按现在的方式在 `agent` lane 里重挂载 + 补跑。

### I3 素材字节从哪来

**云端**：Agent 云端环境有自己的本地内容库（A1 的目录形状 `media/<hash>.<ext>`），项目引用的哈希本地没有就按 A1 的按需拉取从素材云端拉进来，`/@media/<hash>` 从那里服务。启动参数 `--procp <file>`（或环境变量 `PROMPTCUT_PROCP`）可选，只用来预灌本地内容库（离线批量），不是必需。

**Agent 云端环境要预装 `ffmpeg` 并在 `PATH` 上**：`/@media/<hash>/pcm`（音频图卡的素材输入，`vite-plugin-media.ts:334` 的 `PCM_URL`）和导出侧都靠 `findFfmpeg`（`server/bakery/ffmpeg.mjs`），它的兜底路径是 Windows 的 winget 目录，云端没有。

**本机**：缺省一个进程，本地内容库就一份；拆分（I4(d)）时 `agent` 进程从 `process.env` 继承和 `user` 进程同一个 `PROMPTCUT_EXPORT_DIR`，`vite-plugin-media.ts:17` 的 `outRoot` 因此指向同一个 `out/media`——用户的 `.procp` 解包一次、两个进程都读。`--procp` 只在云端用。

**缺素材怎么回**：项目引用的哈希本地没有、素材云端也没有时（上传方还没传完或离线，本机不该发生），对应素材层画出来是透明，所以要靠回包告诉 Agent。**`missingMedia` 由服务端算**：遍历 `project.media[].hash`，本地内容库 `stat` 不到的先按 A1 向素材云端拉一次，仍拿不到（404）的进列表——**与哪一帧渲没渲到无关**。`server/vision/render.ts` 的 `renderFrames` 返回值从 `Map<number, FrameResult>` 改成 `{ frames: Map<number, FrameResult>, missingMedia: string[] }`，`missingMedia` 在函数开头算一次、**每个返回点都带上**；调用点逐处同步改，并 `grep "renderFrames("` 复核（`server/` 没有类型检查，漏一处要到运行期才炸）。工具回包原样带出；`get_layout` 照常（几何不依赖字节）。

### I4 本机：一个进程，Agent 优先；分进程降为可选开关

**(a) 拉起。** 编辑器进程只拉起**一个**预渲染进程：本机配置了 Agent（今天 `vite-plugin-ai.ts` 的服务端工具就在编辑器进程里，即 Agent 在本地）时以 `full` 模式起，没有本机 Agent 时以 `user` 模式起。`vite-plugin-prerender.ts:80-88` 的 env 多两项：`PROMPTCUT_PRERENDER_MODE`，以及 `user` / `full` 模式才有的 `PROMPTCUT_EDITOR_URL`（A7 回拉整份项目和 `costs` 都靠它；`agent` 模式不传）。

**(b) Agent 优先的调度（`full` 模式）。** **Agent 请求只在一个 Chrome 里走优先，「优先」= 可以插队，不是进程优先级更高**（不动 `os.setPriority`，所有 Chrome 同一优先级）。`agent` lane 独占它那一个 bakery（`acquire('agent', …)`）；这个专用 Chrome 每做完一个任务，先从 Agent 任务队列里按先后取下一个。

**Agent 队列空时它不空着**：接普通预渲染队列的下一个任务。落点是 `FramePipeline` 的 `agentIdle` 钩子——`agent` lane 的链空且它的 bakery 空闲时，由它去接 C2 的锚帧队列和 C4 的 `wanted` 单帧（都是独立的单帧任务，在**自己的** bakery 上跑、每帧前照 `frame-pipeline.mjs:824` 的做法 `bakery.reset(isolated, …)`）。**不碰 `fillCardControls` 的顺序批**——`frame-pipeline.mjs:799` 的 4 帧批是绑死单个 bakery 的 `for` 循环、`:732` 是一条串行 `background` 链、它的簿记不是并发安全的；`streamPool` 的分段也不借（租约绑会话，G4）。

正在跑的预渲染任务不被打断，所以**一个 Agent 请求最多等这个 Chrome 上一个预渲染任务跑完；因为这个 Chrome 只接锚帧和 `wanted` 单帧，等待上界 = 一帧**。其余 Chrome（`streamPool` 和 `background` 用的）按先来后到处理预渲染请求，不为 Agent 暂停。于是 Agent 任务永远不排在**排队中的**预渲染任务后面，Agent 的并发也永远占不满预渲染资源、用户永远等得到预渲染；**Agent 没活时这个 Chrome 也不空着**（接锚帧和 `wanted` 单帧）。

（专用 Chrome 只接单帧任务是刻意的，就是为了保证这个等待上界——pinned 架构 4 的「不打断正在跑的那个」。解耦之后这条的落点是 `server/vision/worker-pool.ts` 的取任务逻辑。）

**(b2) AI 菜单的操作预览可以插在预渲染前面**（pinned 架构 5）。聊天气泡的操作详细预览控件（`OpDetailPreview.tsx`）点开一张操作动图 / 位图时发的 `GET /api/ai/visual/gif/<key>.gif`（`server/vision/routes.ts:198` 的 `ensureGif`，今天用户触发的那一支传优先级 0，`:249`）是**用户触发的请求**，要插到普通 Chrome 的预渲染队列最前面。

**落点不在 vision 的优先级队列**：`server/vision/render-queue.ts:115` 的 `enqueue` 和 `FramePipeline` 的 `background` 链、`fillCardControls` 的 4 帧批是**两个队列**，改它的优先级排不到预渲染批之前；而且 `ensureGif` 今天就跑在 Agent 专用 Chrome 上（`server/vision/render.ts:73` 写死 `lane: "agent"`）。改法两步：

- (a) `renderFrames` 的调用加显式 lane，`ensureGif` 在 `user` / `full` 模式传 `lane: 'background'`（`render.ts:73` 那支改成 `o.lane ?? 'agent'`）。
- (b) `FramePipeline` 给 `background` 链加一个**插队队列**（不限帧数——`ensureGif` 是多帧请求；一次只让一个插队项占用一个 bakery）。**读点与交接**：`fillCardControls` 的批边界（以及 `fillRequiredScene` / `fillMov` / `prerender` 的等价可调度点）检查插队队列，有插队项时 `this.background` 那条链**主动把 background bakery 交出去**——`await` 该插队项跑完再继续下一批，插队项复用交出来的这个 bakery、**不走 `acquire('background')`**（走 `laneChains.get('background')` 会在 4 帧批中途 `reset` 同一个 bakery）。**`background` 链上没有批在跑时，插队项自己走 `acquire('background')` 直接跑**，不必空等一个不会到来的批边界。

用户点开的操作预览走它；`agentIdle` 那个只接单帧是另一回事（它跑在 Agent 专用 Chrome 上、要保证 Agent 请求的等待上界是一帧）。它不用 Agent 的专用 Chrome，`user` 模式同样适用，`agent` 模式（云端）没有这个入口。**验收**：这张 GIF 的**第一帧**在当前批结束后立即开始渲染；插队期间 `fillCardControls` 的批次计数不回退、不重放。解耦之后这条的落点是 `server/vision/render-queue.ts` 的入队位置，和 (b) 的 worker-pool 改动互不牵连。

**预渲染不服务用户的即时交互请求**（pinned 架构 4 的方括号）：用户点选、拖动、`get_layout` 页面侧的实体框都在页面自己的舞台上算（D4 页面侧走后台舞台的 `rectsWithBounds`），预渲染只在闲时完成用户的预渲染任务；**`/api/cards/layout` 只服务 Agent 的 `get_layout`**。

**(c) 路由。** `prerender-client.mjs:13` 的 `state` 按角色两份（`{ user, agent }`），单进程时两份指向同一个地址（`/api/prerender/info`（`vite-plugin-prerender.ts:58`）回包多一项 `agent: { url, ready, error }`，不拆分时 `agent.url` = `url`）。`setPrerender`（`:16`）/ `prerenderState`（`:21`）/ `whenPrerenderReady` / `prerenderPost` / `proxyToPrerender`（`:86`）各加一个角色参数：

- **Agent 的路一律 `'agent'`**：`MIRRORED_TOOLS`（`vite-plugin-ai.ts:207`：`get_project` / `see_frames` / `get_gif` / `bake_card` / `inspect_card_dom`）经 `prerenderPost` 的那些调用、`:253` 的 `/api/ai/visual`、`vite-plugin-cards.ts:1303` 的 `proxyToPrerender`，**以及 `/api/cards/layout`**（它只服务 Agent 的 `get_layout`，和 D4、(b2) 末句一致）。
- **用户的路一律 `'user'`**：帧、锚帧、轨道流。
- **一条例外**（pinned 架构 5）：**用户点开的 `GET /api/ai/visual/gif/<key>.gif` 走 `'user'` 角色**（`lane: 'background'` 插队，(b2)）；**模型的 `get_gif` 工具调用走 `'agent'`**。拆分模式下如果把这条路由整个划进 `'agent'`，用户点开的动图就会被塞进 Agent 专用 Chrome，和 pinned 架构 5 冲突。

`prerender.ts` 的单份缓存（`base` / `checkedAt` / `asking` / `firstAsk`、`invalidatePrerenderBase`、`usePrerenderBase`）按角色各一份，`ask()` 从 `url` 和 `agent.url` 各取各的。这样**拆不拆分对调用方透明**。第 6 步把 `MIRRORED_TOOLS` 搬去 Agent 服务端之后：Agent 服务端在本机时 base URL 就是 `/api/prerender/info` 里的 `agent.url`，在云端时是 Agent 云端环境自己的 `agent` 进程；两条路的工具语义完全一样。

**(d) 可选拆分 `PROMPTCUT_PRERENDER_SPLIT=1`（缺省关）。** 编辑器进程拉起 `user` + `agent` 两个进程：`vite-plugin-prerender.ts` 的 `start()` 按角色参数化成 `start('user')` / `start('agent')`，`child` / `closing` / `tail` 和 `:108` 的退出重启（`MAX_RESTARTS` = 5，`:23`）每个角色各一份；`stop` 对两个角色都置 `closing` 并 `killTree`（否则编辑器退出时 `agent` 进程和它的 Chrome 成孤儿）。`agent` 那份的 env 是 `PROMPTCUT_PRERENDER_MODE: 'agent'`，端口另 `freePort()`（`:25`），同样 `PRIORITY_BELOW_NORMAL`、同样传 `PROMPTCUT_CORS_ORIGINS`，**不传 `PROMPTCUT_EDITOR_URL`**（项目由 Agent 服务端推，I2）。

三处不能共用的东西：`vite.prerender.config.ts` 的 `cacheDir` 按模式再分一份 `node_modules/.vite-prerender-agent`（两个进程同时写一个依赖预构建缓存会互相踩）；`frame-library` 分开——`agent` lane 的条目必落盘，两个进程写同一棵会互相踩，`agent` 进程改成同一个 `PROMPTCUT_EXPORT_DIR` 下的 `frame-library-agent`，F1 的 GC 两棵各扫各的；**`out/media` 只有一份**（I3）。`agent` 进程没就绪或挂了，Agent 工具回 `PRERENDER_UNAVAILABLE`，**不退回 `user` 进程**，等编辑器进程按 `MAX_RESTARTS` 拉起。重启后的恢复见 r2-r7 的 F5（任一模式都适用，不只拆分模式）。

### I 节验收

**云端**：Agent 云端环境用 `agent` 模式起预渲染进程，进程树里只有一个 Chrome、没有后台预渲染任务、`streams/` 目录不生成；对一个含 3 个素材（其中 1 个故意没上传到素材云端）的项目调 `see_frames`，回包 `missingMedia` 恰好 1 项、其余两层从素材云端拉下来后正常；`get_layout` 与用户机上同一项目的结果逐字段相同；空闲 10 分钟 Chrome 退出、再查询自动拉起；`projectRev` 变化后 3 秒内 `see_frames` 反映新内容；`inspect_card_dom` 与 `see_frames` 同时发，两者串行完成、始终一个 Chrome。

**本机**：缺省（不拆分）用户机上进程树只有一个 `vite --config vite.prerender.config.ts` 进程，env 带 `PROMPTCUT_PRERENDER_MODE=full`（没有本机 Agent 时是 `user`）。Agent 连发一批 30 帧的 `see_frames` 期间：这 30 个请求全部在同一个 Chrome 上串行，**第一个**从到达到开始执行至多等这个 Chrome 上一个在跑的锚帧 / `wanted` 单帧任务（记下这一帧的实测上界），其后每一个只等前一个 Agent 请求；Agent 队列空下来之后日志里能看到这个 Chrome 接了预渲染任务（不空转）、其余 Chrome 的 `background` `flush` 和 `streamPool` run 照常进行、用户拖动播放头的 `user` lane 请求照常响应、舞台不卡（缺的层透明）。预渲染队列里已有 5 批待预渲染时在聊天气泡点开一张操作动图，它的渲染在当前批结束后立即开始（等待 ≤ 一批的时长），不排在那 5 批之后，**且不占用 Agent 的专用 Chrome**。`get_layout` 在本机 Agent 与云端 Agent 上对同一项目逐字段相同。`PROMPTCUT_PRERENDER_SPLIT=1` 时：两个进程、`.vite-prerender` 与 `.vite-prerender-agent` 两个缓存目录、`out/media` 一份、`frame-library` 与 `frame-library-agent` 两棵；杀掉 `agent` 进程时 Agent 工具回 `PRERENDER_UNAVAILABLE`、用户舞台不受影响、编辑器进程在 `MAX_RESTARTS` 内把它拉起；**用户在聊天气泡点开的动图仍走 `user` 进程**。两种情况下 `user` lane 的行为与 R7 验收完全相同。

---

## 目标 L：在线浏览器模式（pinned 架构 3；第 10 步）

编辑器分两种运行环境：**本地模式**（桌面版或本机 dev server：有编辑器进程和预渲染进程）和**在线浏览器模式**（编辑器直接跑在用户浏览器里，只有页面）。在线浏览器模式请求不到预渲染进程：文档走文档云端（B0 的 WebSocket），素材直接打素材云端（A1 的 CORS + Range），Agent 走 Agent 云端（`agent` 模式的进程在服务器，I）；**预渲染者是后台 iframe**。宿主能力由 J4 的 `hostCapabilities` 报给父页（协议在 r2-r7），页面代码只按能力分支。

- **L1 后台 iframe 当预渲染者（J4 的 `bake` 角色）。** `setRole('back', { job: 'bake' })`：后台舞台在闲时——探针队列空，且页面可见时用 `requestIdleCallback` 的窗口、不可见时按 E4 每 8 帧让出——按 C2 的优先级（锚帧先、播放头前方优先、其余逐帧）对预渲染集合（`plan.prerenderSet`）里的片段逐帧推，**每帧调页面协议 `window.__pcCreateSnapshot()` 生成本控件的 HTML 快照**（取回包的 `controls` 项），和 K1 探针同一套机器，只是不计时、持续跑。用户一操作（`setTime` / `play` / `setProject` 到达 `front`）就让路，空闲再续。产物按 A3a 的档位 / 键规则写进 L2 的库。

- **L2 页面内快照库（J3 的第二个实现 `IdbSnapshotSource`）。** IndexedDB 一库三表：

  - `costs` —— key = `identityKey`，K1 的成本记录。浏览器模式没有 `/api/data/costs`，第二次打开靠它跳过探针。**在线浏览器模式跑的是构建产物，所以只认 `mode=build` 的记录**（桌面版跑的是 vite dev server，看 `mode=dev` 的；`mode` 拼在 `device` 串里，见 `restructure_planning/render_pipeline_restructure.md` 3.1 第 1 条）。
  - `snapshots` —— **复合键 `[kind, key, localFrame]`**（不拼斜杠——`kind: 'local'` 的 `key` 自带一个斜杠，拼起来会歧义），值 = deflate 后的 HTML。
  - `ranges` —— 每层就绪区间，和 C3 的 `readyIndex` 同形状。

  `subscribeReady` **由 L2 的每一次写入触发**（不经 SSE），不管这次写入来自 L1 的后台 iframe 还是 L3 的云端下载；`fetchSnapshot` 读 IndexedDB。配额和 LRU 同 A3b；换项目不清库，按键命中就复用。

- **L3 云端快照直接进热舞台。** 打开项目时按每张共享卡的共享键查文档云端的快照清单（内容库的 `content.get { kind: 'snapshot-manifest' }`），缺的块从素材云端拉（A3b 的下载路）写进 L2、`ranges` 立即就绪——**别人预渲染过的 Motion 卡在这台浏览器上不用重新预渲染**。清单里 `skipped` 的区间不等，直接交给 L1 本地产。本机预渲染出的共享档照 A3b 上传。

- **L4 没有流。** 浏览器里没有 ffmpeg，重卡播放时贴不了流。**DOM 重卡和 canvas 重卡同一规则：按拍换 HTML 快照**（`.pc-snapshot` 平面的 `innerHTML` 每拍替换一次——这是「逐帧换快照播放」在本任务里唯一允许的地方，不受 C4 的 33 ms 节流；canvas 卡的快照里画布已经是 `<img>`）；**实测换帧成本装不下预算的重卡透明**；暂停态照 K5 追到活渲。

  （第 111 版写的是「canvas 卡在浏览器模式下不按拍换快照、它是活渲的」，那和 pinned 渲染 7「重卡播放和拖动只贴死素材、缺就透明」、pinned 平台一节、不做清单都冲突，按 `restructure_planning/render_pipeline_restructure.md` 3.7 改成这一条。R9 之后 canvas 卡的主线程成本很小、多数位置判轻，这条实际只落在 `dom2d` 粒子卡和没有 Worker 退路的设备上。）

  **换帧成本进预算**：`planPipelines` 的 `opts.deadMs` 从标量放宽成 `number | ((identityKey: string) => number)`；浏览器模式传函数，背后是一张**只在本次会话生效的 `swapMs` 表**（不进 `costs`，因为它量的是这台机器这一次的 DOM 替换速度）。第一次播放前用常量 `SWAP_MS = 3` 估，播放中按 K6 的每拍每卡计时实测后替换。

- **L5 只留接口**（pinned 架构 3 的两个「将来」）。

  1. **云端合并分发**：素材云端在 `PUT snap/<hash>`（A3b）之外加 `POST merge/<projectId>/<共享键>`——任何客户端把自己预渲染出的共享档块和清单片段推上去，云端按键合并去重、清单走文档云端按 `projectRev` 分发。**本任务只实现「上传自己的」，`merge` 端点回 `501`。**
  2. **在线重型控件渲染服务**：接口形状 = `agent` 模式预渲染进程的 `see_frames` / `bake_card`，再加 `GET stream/<streamKey>/<segment>`。浏览器模式的 `streamPlayer.ts` 照 J3 的思路把取流抽成 `StreamSource` 接口：

     ```ts
     interface StreamSource {
       subscribeIndex(session: string, localRev: number,
                      onMessage: (m: StreamIndexMessage) => void): () => void;
       fetchInit(streamKey: string, signal?: AbortSignal): Promise<ArrayBuffer>;      // init.mp4
       fetchSegment(streamKey: string, segment: number,
                    signal?: AbortSignal): Promise<ArrayBuffer>;                      // 一个 fMP4 分段
     }
     ```

     分段号就是 G2 的分段号（帧号 = 分段号 × 15 + 样本序号），签名比对由调用方按索引消息里的 `signature` 做（G6）。**本任务只实现本地 HTTP 那一份（R8），浏览器模式下没有实现**——拿不到 `StreamSource` 就走 L4。**这两个名字（`streamKey` 的拼法、索引消息的字段）要和 R8 最终定下来的索引与分段命名对齐**，R8 定了之后回来改这里。

### L 节验收

纯浏览器（没有本机进程）打开一个含 3 张重 Motion 卡的云端项目：清单命中的卡立刻有快照、`ranges` 就绪；没命中的卡后台 iframe 在 30 秒内预渲染完 10 秒时间轴的锚帧，IndexedDB 里出现对应条目；播放时重卡按拍换快照、主文档 Long Task 为 0；关掉再开同一项目不重新预渲染（`costs` 表里是 `mode=build` 的记录）；`POST merge/...` 回 `501`；用户拖动期间后台 iframe 的预渲染让路（拖动 3 秒内不新增条目）。另加两条断言：**含用户卡 / 图卡的项目在时间轴上给出「该模式暂不支持自定义卡」的提示**，那些片段透明；**素材输入的音频图卡报错「该模式暂不支持素材输入的音频图卡」**。

---

## 约束

- 项目文档真身在文档服务（本地模式在本机编辑器进程里，云端模式在文档云端）；页面的 store 永远是副本，所有改动经文档服务。本地模式跳过素材云端、直接读文件，但不跳过文档服务（pinned 架构 2）。操作的生成：订阅 `project` 引用变化；每次变更一条操作；diff 两层（用 `changedClips`）；打开项目视为整份替换；`applyingRemote` 抑制回环。**撤销在客户端。**
- 渲染永远在「看图的那一方」旁边、按「谁在看」分进程（I）。**云端不渲染**；素材字节只在素材云端和各方的本地内容库，文档云端不存字节。
- **素材的小分辨率档跟原片帧率、上限 60**（`>60` 的按 60 抽帧）。项目 `fps` 四档（24 / 25 / 30 / 60）可切、切换后全部 `costs` 和死素材作废并重走探针遮罩——这条完整口径在 `restructure_planning/r2-r7-task.md` 的「约束」，本文只用到「小分辨率档跟原片帧率」这一句。新项目默认 fps 沿用 `src/kernel/project.ts:334` 的 30。fps 下拉要加进 `ProjectSettingsDialog.tsx`（今天那里没有 fps 项）。
- **不改导出像素基线**：导出和像素级检查**只用原片档**，原片没到就是「等待上传方」、不拿小分辨率档代理导出；预渲染、导出、`see_frames` 一律用 `media.url`，只有 live 路的 `VideoTrack` 走 `playbackUrl`。
- **Python 在本仓库只剩感知用途**：`python/promptcut_stt` / `promptcut_shots` / `promptcut_subject` / `promptcut_track` / `promptcut_collect` 五个离线工具包照旧，不动。Agent 在自己的环境里对 `see_frames` 拿到的图跑自定义分析代码属于 Agent 自己的工具箱，不在本仓库、不在本任务内。
- **交互设计（pinned 交互 1～3）不在本任务范围**，另开任务书；本任务只保证不堵路：桌面端 Agent 用自己的识别码走同一条 B3 通知 / 收件箱路，两侧菜单里按识别码展示；悬浮窗展开后的「Agent 修改预览窗口」就是 AI 菜单的操作预览（I4(b2) 的 `OpDetailPreview.tsx` 和插队的 GIF）；本任务不改任何样式文件、不新增与圆角 / Fluent 深色 / 青蓝酱紫主题冲突的固定配色。
- 顺序见文首的分步表。

## 验收（合验）

各目标的专属验收在目标节内（A3b / A5 / A6 在各自条目、I 在 I 节末、L 在 L 节末、I0 在 I0）。下面只列跨目标的合验。

- **本地模式**：没有任何云端配置、断网，打开项目、编辑、保存到 `.proc`、本机 Agent 改卡、B3 通知、B6 熔断全部可用；`/@media/<hash>` 直接读文件、**不生成小分辨率版、不上传**；进程对外没有网络连接；页面和本机 Agent 各自写同一张卡时，落地顺序与文档服务日志一致。

- **A1（第 2 步部分已落地；「第 5 步后」的条目未做）**：mtime 不同 `entry.key` 相同；导入 4 GB 视频主服务响应 ≤ 100 ms；`.procp` 去重且**只含原片**；`/@media/<64 位 hex>` 正确 contentType 并支持 Range；导入后 `project.media[].url` 无 `blob:`。第 5 步后：导入的素材在后台上传期间时间轴可继续编辑、主线程无长任务；另一台机器打开同一项目，素材层先透明、拉完自动出现；断网导入再联网，补传完成后 `uploaded.small` 和 `uploaded.original` **分别**翻真；导入两小时 4 GB 素材，**小分辨率版先于原片到达另一台机器**（且上传队列是逐个素材、同一素材先小后大），它到达后素材层出现、再换到原片时 `currentTime` 不跳，原片到达前导出提示「等待上传方」；上传中断网再恢复，`GET media/<hash>/chunks` 报出已收分片、**只补缺的分片**、`POST media/<hash>/complete` 校验通过后 `uploaded` 才翻真；原片是浏览器放不了的编码（`playable === false`）时预览一直停在小分辨率版、导出仍用原片。

- **A3（键与目录形状已落地）**：共享键对 x / y、不透明度、motion、`clipId` 不敏感，对参数、源码版本、时长、相位、框宽高、画幅、parts、`snapshotCode`、审阅表内容敏感；毛玻璃卡和 `unknown` 卡有本地快照且不上云；超上限的那一帧不进就绪索引、不投递、不上云；B 机首次打开 A 机预渲染过的项目不起历史推进即显示 `independent` 卡（清单命中 → 块下载 → 落盘走 `snapshot-store` 的写入函数 → `index.json` 与磁盘一致 → C3 判就绪）。

- **D**：Agent 连续 30 次 `add_clip` / `set_position`，播放头在 60 秒处，编辑器页面主线程长任务合计 < 300 ms（同一套 puppeteer 测法）；100 个工具调用每条事件更新 < 10 ms 且只重渲对应记录；展开一条事件时经内容库 `content.get` 拿到完整参数。

- **B**：同一张卡上 A 写 `cardRev` v5、B 写 v6、C 写 v7，A 和 B 都收到 v7 通知，D 不收，A 的 diff 相对 v5；两个 Agent 交替 `edit_card` 7 次，第 7 次落地并锁住上一个写的，被锁方的下一次 `edit_card` 收拒绝并附最后 6 次改动、最后写的继续成功、两条收件箱消息、一条气泡；被锁方的定位类工具仍能写；解锁与自动解锁按 B6。页面的在线操作不带期望版本、按到达顺序落地。

- **F**：旧 `.proc` 后台补哈希期间预览可用；GC 后五个共享目录里被引用的条目一个不少，本地内容库在本地模式下不被自动回收；断网 10 步（含撤销）恢复后恰好 10 条操作按序提交、全部 ack、`projectRev` 连续加 10，不回环；离线期间别人写过时第一条被拒、其余不提交、弹出 B3 通知；本地 → 云端 → 本地往返一圈后 `projectRev` 不回退。

- **零卡顿**和 **D5 + E + K** 的总验收在 `restructure_planning/r2-r7-task.md` 的「验收（合验）」，本文的改动不得让它们回退。

- `npm test`、`npm run build` 通过。

## 不做

- 冲突合并、CRDT、OT。
- iPad APP、手机 APP 的原生壳（iOS / Android）；手机竖屏布局。
- 字体随包分发；像素缓存（PNG / MOV / 轨道流）上云。
- Agent 的云端渲染池。
- 云端转码（小分辨率版一律由上传方本机转）；桌面版给「只有原片」的云端素材补转小版（记在 `restructure_planning/future_planning.md` 第 1 条，以后再做）；在页面里用 WebCodecs 转码。
- 单流时间分层做素材的渐进补全（H.264 没有；VP9 / AV1 的 temporal layer 只能经 WebCodecs 用、`<video>` 不认）。本任务的渐进就是两档换档。
- 整件 `PUT media/<hash>`（上传一律分片）。
- 素材字节或快照块走文档云端的 WebSocket（大件一律素材云端，B0）。
- 给 `/@media` 加 CORS（本地模式同源；在线浏览器模式直接打素材云端）。
- 本地模式生成小分辨率版、上传素材或快照；绕过本机文档服务擅自改 store；在没拿到最新操作的 ack 之前写 `.proc`。
- 让文档服务写 `.proc`（成文和写盘都留在页面）。
- `agent` 进程做后台预渲染、锚帧、轨道流（只接查询；两种部署的 `agent` 进程都只接收 Agent 服务端推来的整份项目，I2 的正路）。
- Agent 云端环境把素材云端整个镜像下来（只按需拉项目引用的哈希，I3）。
- 本机 Agent 改打 Agent 云端的预渲染；在 `user` 模式的进程上跑 Agent 查询（`user` 模式不建 `agent` lane，有本机 Agent 就用 `full`）。
- 拆分（`PROMPTCUT_PRERENDER_SPLIT=1`）时第二个进程拷贝一份 `out/media`（两个进程读同一个 `outRoot`，I4(d)）。
- 把用户点开的 AI 菜单操作预览路由进 Agent 专用 Chrome（pinned 架构 5，I4(c) 的例外）。
- `get_layout` 走可见舞台；写工具返回 `contentBox`（协议在 r2-r7 的 D4）。
- 逐帧换 HTML 快照的播放方式——**在线浏览器模式的 L4 是唯一例外**（没有流）；拖动中按 C4 换快照、播放中流缺分段时贴最近快照不算。
- 在线浏览器模式做流、做云端合并分发、做在线重型控件渲染服务、做素材转码（L5 只留接口）。
- 在线浏览器模式加载用户卡 / 图卡（页面只有预构建 bundle、没有 TSX 编译器）：第一版只支持内置卡，含用户卡 / 图卡的项目在浏览器模式下这些片段透明并在时间轴上提示「该模式暂不支持自定义卡」。将来的路是页面内用 `esbuild-wasm` / `sucrase` 转译并 `import(blobUrl)` 注册，`sourceVersion` 进 `localSceneKey`。（这和 `unknown` 卡是两回事：`unknown` 是审阅表没覆盖到、照常渲，这里是加载不了、没有组件可挂。）
- 在线浏览器模式下音频图卡取素材 PCM（`/@media/<hash>/pcm` 要本机 ffmpeg，素材云端没有项目语义）：第一版报错，图卡与图卡之间的递归取块照常。
- 在线浏览器模式离线时导入素材、导入 / 导出 `.procp`（F3）。
- 向前兼容 Python 卡（滤镜、转场、音效在内）：旧 `.proc` 的 python 定义和节点加载时丢弃，不做占位卡、不做 `list_cards` 提示、不自动翻译。
- 把 `unknown` 卡当成「不预渲染」的表达方式（它按 `belowDependent` 走本地档）。真要让某张卡完全不产快照、不进流，用审阅表上显式的 `prerender: false`。

---

## 本文没带走的内容

- **版本考古**：第 111 版文首那段「第 N 版折进去 / 第 N 轮审查」的沿革（约 16 KB）整段丢掉。只留现在成立的规定和它的理由；某一条为什么是现在这个样子，要查就去 `restructure_planning/r75/`（第 75 轮十份报告与逐条结论）和 `restructure_planning/render_pipeline_restructure.md` 第 3、6 节。
- **已落地节的细节**：A0（卡片能力审计）、A1 的素材键与路由部分、A2（含 R1 的差异样式内联）、A3a 的键与目录形状、A3c 的体积实测、A7（镜像插件）、C1、H（JS 图卡接替 Python 卡）、J1 / J2（生成快照进页面 bundle、页面协议清单）——本文各留一两句现状和代码位置，不抄细节。要看细节就去代码，或 `docs/bake-page-protocol.md`、`docs/snapshot-size-audit.md`。
- **渲染管线整半**：C（锚帧预加载与按层回溯）、D3 / D4 / D5、E（双舞台与舞台内容）、K（分派与播放）、F2 / F5、J3 / J4 在 `restructure_planning/r2-r7-task.md`；G（轨道流）将在 `restructure_planning/r8-streams-task.md`、M（共享 WebGL 渲染器）将在 `restructure_planning/r9-webgl-task.md`。本文只在用得到的地方指路。
- **A3a 的完整键定义**（`sourceDependent` / `belowDependent` 两种键怎么拼、隔离工程怎么平移、`localSceneKey` 怎么算）：在 r2-r7 的 A3a。本文只保留「哪些卡上云、哪些只留本地」这一层，因为那是 A3b 的输入。
- **A4 整场景一帧靠拼**：纯舞台侧的事，在 r2-r7。
- **`frameMs`**：这个字段已经删掉，判重只看活渲单帧耗时 `stepMs`；原文里所有用 `frameMs` 表述的门槛一律换成 `stepMs`，成本记录的四个数（`stepMs` / `inlineMs` / `rasterMs` / `serializeMs`）的定义在 `restructure_planning/render_pipeline_restructure.md` 3.8 和 r2-r7 的 K1。
- **`__bfFreeze` / `freezeScene` / `snapshotFreeze.ts` / `freezeCode` 这组旧名字**：一律换成 `window.__pcCreateSnapshot` / `createSnapshot` / `createSnapshot.ts` / `snapshotCode`。
- **G0-b（轨道流准入实测）在各平台各跑一次**：I0 只留了「结果写进准入报告」这一句，实测本身属于 R8。
- **总验收里的渲染条目**（A2、A7、C1、C、第 3 步、D5 + E + K、G、零卡顿）：只留指针，正文在 r2-r7。

## 需要主会话 / 用户定的问题

1. **A3b 的块上传在第 5 步、清单在第 6 步**，第 5 步单独验收只能自造键列表，跨机复用要等第 6 步。要不要干脆把整个 A3b 挪到第 6 步？（fold-notes r75-07 第 7 条只说「A6 和 A3b 的清单读写挪到第 6 步」，没说块。）
2. **`media[i].playable` 是新字段**，第 111 版没有，是 r75-07 第 9 条的功能性修正。它怎么探（`HTMLMediaElement.canPlayType` 还是真的试放一次）、探不出来时默认哪一边，没有结论。fold-notes 同时说「**写进 `reply_to_users_goal.md` 请用户确认读法**」——「原素材（保持原编码）」这个读法要不要放宽 pinned 架构 1 的措辞，还没问过用户。
3. **`uploaded` 从 `boolean` 改成 `{ small?, original? }`**，`src/kernel/project.ts` 里今天还没有这个字段（只有 `tiers`）。改的时候顺带要定：本地模式下这个字段是不存在还是恒为 `undefined`，以及存盘到 `.proc` 时带不带它（带了换台机器就是错的）。
4. **`StreamSource` 的 `streamKey` 拼法和索引消息字段**要和 R8 定下来的命名对齐，现在写的是按 G2 / G5 / G6 推的形状，R8 落地后要回来改。
5. **L5 的「在线重型控件渲染服务」接口**只说了「形状 = `agent` 模式的 `see_frames` / `bake_card` 加 `GET stream/...`」，没有定鉴权、计费、并发上限。第一版不实现，但要不要现在就把形状写死，没定。
6. **第 8 步（D3 的预渲染部分）到底算哪一半**：它的协议在 r2-r7 的 D3，但排在第 7b 步之后、和云端那一半同期做。本文只在分步表里留了指针。
