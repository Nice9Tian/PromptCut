# AGENT 报告：c10a-lowmem

分支 `claude/c10a-lowmem`，worktree `.worktrees/c10a-lowmem`，起点 `claude/c66-integ` 的 `851ffe9`（C6.6 集成分支；主会话裁定 C10a 与 C6.6 的 T9 重叠进行，C6.6 合入 main 后用合并跟上）。端口段 5640～5649：桌面 dev server 5640（舞台 5641/5642），在线模式 dev server 5643（`VITE_PC_ONLINE=1`，舞台 5644/5645），替身素材服务 5646。数据目录都在 scratchpad 的临时目录。

范围：`docs/plan/c10a-contract.md`（下称「契约」）第 8 节（低内存档）、第 8.1 节（在线页面单舞台 live 预览）、第 9 节（预渲染小尺寸）、第 11.1 节（低内存档逐帧导出）；`src/online/mode.ts` 逐字节照第 2 节；文案照第 14 节表 C。

## 做了什么

### 1. 判定（契约第 8 节「判定」）

- `src/online/mode.ts`：照第 2 节逐字节写（`git` 里的 blob 是 LF）。
- `src/online/lowMemory.ts`：`judgeLowMemory`（`deviceMemory <= 4`，或粗指针 + 触点 ≥ 2 + 屏幕长边 ≤ 1600；`pointer`/`any-pointer` 两个 media query，不看 UA）；设备设置「显示档：自动 / 低内存 / 普通」存 `localStorage`，下次载入生效，从低内存切到普通提示一次；运行中 `webglcontextlost` 一次或视频解码连续失败 3 次（中间成功清零）本次会话改按低内存档（记在 `sessionStorage`，同一标签页刷新仍是低内存档）并提示一次；只在在线模式里判，`online = false` 恒为普通档。本文件不 import `mode.ts`（Node 单测里没有 `import.meta.env`），由调用方传 `ONLINE`。
- `stageRpc.detectHostCapabilities({ online })`：`hostCapabilities.lowMemory` 换成上面的判定（旧判据「`deviceMemory <= 4` 或 Safari」删掉）。桌面恒为 false —— 这会让 `deviceMemory <= 4` 的桌面机的 K1 `device` 串与共享 WebGL 路线缺省值变回普通档（契约第 8 节的明文要求）。
- 分层：主会话裁定 `src/online/` 与 render 同层，`src/layering.test.mjs` 的禁引表加 `online: ["editor", "mcp", "ai"]`。

### 2. 能力闸与单舞台 live 预览（第 8 节「能力闸」、第 8.1 节）

- `previewMode.ts`：`ONLINE` 时 `dualStage()` 恒为 false（即使页面上有舞台端口表）；新增 `singleLiveStage()`（= `ONLINE`）与 `liveStage()`（双舞台或在线单舞台）。`stageSrc` 在线时给同源舞台 A 带 `&preview=stage`（live 变体：素材层进舞台、六个平面生效）。
- `Preview.tsx`：原来按 `dual` 判的「可见舞台是 live 的」那些逻辑（K4 播放头跟舞台 `frame`、快照 / 抑制投递、`setMediaT` / `setPlaying` / `setLocalHashes` 下发、舞台露出、不挂 `UnifiedPreview`）改按 `live`；只和后台舞台 B 有关的（互换、补跑、页面触发预渲染 `usePrerenderPreload`、`frame` 里的 `runPlayingSwap`）仍按 `dual`，在线时一条都不走。
- **不开后台舞台**：在线没有 iframe B；`probeRunner.runLoop` 等 `whenStageReady("back")` 永远等不到，因此不测、不拉 `/api/data/costs`，`ProbeGate` 不出现（没改 `ProbeGate.tsx`，它不在我的清单里；分派表照常按声明兜底：`direct` 轻、其余重）。页面从不认领任务（在线没有编辑器进程）。
- **不追活渲**：低内存档不发 `settle`；`stageSwap.ts` 的 `SwapHost` 加 `lowMemory()`，`runSettleSwap` / `runPlayingSwap` / `catchUpBack` 在低内存档一步不走。另外低内存档**暂停、拖动时也抑制重卡**（`suppressedAt({...head, playing: true})`）：子树藏着不活渲，有预渲染小尺寸就贴它，没有由舞台显示占位符（`placeholderWanted` 的 `no-data`）——否则暂停时重卡会露出活渲的精确画面，等于自己追了精确画面。
- **素材只拉小尺寸**：`mediaTier.ts` 加模块级取档策略 `setMediaTierPolicy({ lowMemory, remote })`。低内存档：有小尺寸恒给小尺寸（轮询回过而它没到齐就等待上传方，不回退原尺寸）；没有小尺寸的视频不给地址、显示「等待上传方」角标（`VideoTrack` 空地址不进槽位、不挂 `<img src="">`）。图片、音频按主会话裁定（C6.6 只给视频做小尺寸）照常用唯一一档。在线时按哈希寻址的地址换成远程素材服务的 `GET <base>/media/<hash>?t=<只读票据>`（`<video>` 带不了头）。舞台是另一个文档，父页经新 RPC `setMediaPolicy` 下发（只在在线模式发，桌面一个字节不变）。
- **运行中改判**：舞台在 document 上按捕获阶段接 `webglcontextlost`、`<video>` 的解码错误 / `loadeddata`，发握手类消息 `pc-stage-trouble`，父页改判、提示、重发策略。
- **提示**：进入项目时提示一次表 C 第 1 行（`pushToast`）；预览标签栏右侧加「显示档」设备设置（只在在线页面出现）。低内存档切到后台（`visibilitychange` / `pagehide`）时停预览（契约第 13 节 Q2 的采纳）。
- `assetTiers.ts`：在线时不再请求编辑器进程（`/api/media/remote`、`/api/media/prefetch`、`/api/media/upload-queue/target`），没连上远程素材服务时不轮询本地素材服务；记下 `connectSharedAssets` 交进来的文档服务连接（`docRequest`），给在线快照来源取内容库；导出 `remoteAssetTicket` / `subscribeRemoteAssets` / `assetAuthHeaders`。在线时不跑 C6.6 的补转（`startTierBackfill`）。
- `StageView.tsx`：`setOnlineBrowserMode(ONLINE || platform=browser)`（在线时用户卡 / 图卡显示 `unsupported` 占位）。

### 3. 预渲染小尺寸：渲染节点一侧（第 9 节「尺寸」「生成」「入库与清单」）

- `server/bakery/small-bitmap.mjs`：尺寸规则 `s = min(1, 800/项目宽, 600/项目高)`，像素向下取整（16:9 → 800×450，9:16 → 337×600）。**小位图画的是包裹层的框**（片段框 w×h，`src/kernel/frameSize.mjs`）里的内容，按同一个 `s` 缩：HTML 快照只是包裹层的 innerHTML，页面把它挂在包裹层里 `inset: 0` 的快照平面上，所以小位图铺满同一块地方；没设框的卡正好是整幅（800×450）。把这一帧的快照 HTML 放进框大小的盒子、`scale(s)`，在导出页（`/?export=1`，字体与快照重放环境相同）上用 beginFrame 截成 WebP（质量 80，带 alpha）。另有 `renderPng`（PNG 等比缩一次）备用，见「没做成的」。
- `frame-pipeline.mjs`：`commitSnapshots` 的推送钩子里把这一批记下（只在配了推送队列、`PROMPTCUT_SMALL_TIER` 不为 0 时；从素材服务拉来的 `adopted` 不做）；**在预渲染间下一次换页（`reset` / `resetWith`）之前、在要扔掉的那一页上画**（`chrome.mjs` 加 `beforeReset` 钩子，`FramePipeline.bakery()` 挂上 `flushSmallOn`），写 `<帧>.small.webp`，写完同一段再进推送队列。`index.json`、`<帧>.html`、键一字不动。
  - 最初的做法是在同一浏览器里另开一个受帧控制的页面，实测会把预渲染间那一页的就绪等待卡死（「导出页 60 秒没就绪」），改成现在这样；改法见提交 `b204201`。
- `artifact-transfer.mjs`：`collectSnapshotResult` 列清单前等正在画的小尺寸落定（只等，不渲染），清单另带 `small: [[帧, 哈希, 字节]]`（只列原尺寸也在这一段的帧；一张都没有就不带这一项，清单与 C6.4 一字不差）；`resultBlocks` 把小位图推进 `px`（扩展名 webp）；`manifestMatches` 核 `small` 的形状。两档分开记：`frames` 只认原尺寸，去重与导出只看它。
- **给在线页面的层表**（契约没写死的地方，见「偏离」第 1 条）：`layerMapOf` 列这一版 card plan 里在预渲染集合、产快照的卡（线上键、清单结果键、`firstFrame`、`count`、段长），`FramePipeline.publishLayerMap` 在认下 card plan 时交给推送队列的 `putLayerMap`（攒 300 ms、后写的赢、内容相同不重写、失败按退避重试），写进内容库 `snapshot-manifest` 类的 `layers:<项目 id>`。

### 4. 预渲染小尺寸：在线页面一侧（第 9 节「在线页面拉取」、第 8 节「缓存」）

- `snapshotSource.ts` 加在线实现 `OnlineSnapshotSource`：取层表（每 3 秒）→ 只取播放头前后 2 秒落在的段清单（没满的每 2 秒再取）→ 就绪区间 = 清单 `small` 表里的帧，照 C3 的全量 `layer` 消息发 → 取字节 `GET <素材服务>/px/<hash>`（`Authorization: Bearer` 只读票据），包成铺满快照平面的 `<img>`（data 地址）。内存 LRU 按字节 64 MiB；预取播放头前后 2 秒、当前可见的重层，近的先取；换键（重渲之后）按新键重算，卡不在层表里了发空层撤掉。
- `Preview.tsx` 在线时换上它（`setSnapshotSource`），消息直接并进 `snapshotFeed` 的就绪索引（`currentReadyIndex()`），到货后自己重投一次——`snapshotFeed.ts` 一行没改（它不在我的清单里）。

### 5. 低内存档逐帧导出（第 11.1 节、第 11 节〔裁〕封装器）

- `src/export/mp4Mux.ts`：自写最小 MP4 封装器，一条 H.264 轨 + 可选 AAC 轨；`ftyp | mdat(64 位长度，样本随到随写) | moov`，`finalize` 回头补长度；`co64`、`stss`、有 B 帧时 `ctts`（v1）；`MemorySink` / 按位置写的落点。
- `src/export/capability.ts`：安全上下文、`VideoEncoder`、按原尺寸与帧率 `isConfigSupported`，H.264 依次试 `avc1.640028` → `avc1.4D0028` → `avc1.42E028`；`AudioEncoder` 的 AAC。都不支持就停下提示表 C。
- `src/export/originals.ts`：导出前核对 / 导出中取用预渲染原尺寸（层表 + 每段清单的 `frames` 盖满整段；取 `snap/<hash>`）。没有层表时退回页面自己判重的片段，一律算缺。
- `src/export/frameCompositor.ts`：同源导出页（`?export=1`，opacity 0 的 iframe）照 `bake.mjs` 的步子逐帧推（rAF 代替 beginFrame），生成整场景快照；重卡的包裹层换成预渲染原尺寸 HTML；素材按原尺寸地址装（`<video>` 自己按 Range 取，`crossOrigin = anonymous`），画成 JPEG（0.95）替进占位；整张快照包成 SVG `foreignObject`、以 **data 地址**载成图画到复用的原尺寸画布。实测 Chrome：data 地址的 foreignObject 图不污染画布（能 `new VideoFrame(canvas)`），blob 地址的会污染。
- `src/export/browserExport.ts`：能力探测 →（没有 AAC 先问一次）→ 导出前核对（素材原尺寸 `complete`、重卡原尺寸齐全；没过就提示、3 秒后再核，不设超时，可取消）→ 提示保持前台 → 混音（`audioPlanOf` + `renderMix`，素材原尺寸取一次、在浏览器里按时间轴裁段喂给 `renderMix`；没有声音轨的 ISO-BMFF 视频不进混音，同桌面的 `hasAudioStream`）并编 AAC → 逐帧合成、`encode()`、`frame.close()`，`encodeQueueSize` ≤ 3，关键帧每 2 秒 → 封装写出。
- `src/editor/io/index.ts`：`exportVideo` 在线分支（`exportVideoOnline`）：暂停预览、释放小尺寸缓存；给了「另存为」的落点就按位置流式写（回 `written: true`），否则攒在内存由 `streamExportFile` / `fetchExportFile` 取走，连「另存为」都没有的（iOS）攒成 Blob 直接下载；`cancelExport` 认在线任务。探针入口 `window.__pcIo.exportVideoBrowser`。文案照表 C（`src/export/text.ts`）。

## 验证

（截图与产物在主会话 scratchpad 的 `probe-online/`、`probe-small/`、`probe-compare2/`。）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,零错误 |
| 全量测试 | `npm test` | 退出码 0;tests 3114,pass 3113,fail 0,skipped 1(`集成:/api/cards/layout 对真实项目返回整数框`,需要 5190 的那一条) |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5640/?export=1"` | 退出码 0;Total Frames 1800,Identical 1800,Different 0(帧写在本 worktree 的 `out/verify-a|b`) |
| 本分支单测 | 下面各文件 | 全过 |

本分支新增 / 改的单测(都在 `npm test` 里):

- `src/online/lowMemory.test.mjs` LM1～LM10:注入 `deviceMemory`、屏幕尺寸、触点数、`pointer` / `any-pointer` 的桩;覆盖值;桌面恒普通档;设置下次载入生效与切到普通的提示;`webglcontextlost` 一次改判、解码失败连续 3 次改判且中间成功清零、每会话只提示一次;表 C 原文。
- `src/render/mediaTierLowMemory.test.mjs` LMT1～LMT7:低内存档只给小尺寸、小尺寸没到齐等待上传方不回退、没有小尺寸的视频不给地址、图片音频照常、普通档不变、模块级策略、在线远程地址带查询串票据。
- `src/editor/stageSwap.test.mjs` 末条:低内存档下 `runSettleSwap` / `runPlayingSwap` 一条 RPC、一个后台任务都不发。
- `server/test/small-tier.test.mjs` ST1～ST9:尺寸规则(16:9 → 800×450、9:16 → 337×600、不放大、框按同一缩放比)、WebP 头、清单两档分开(没有小位图时清单一字不差、只有小位图的帧不进任何表)、`small` 形状核对、两档推送(HTML 进 `snap`、WebP 进 `px`,推送不渲染)、完成条件(列清单前等小尺寸落定)、什么时候排(没配推送队列不排、拉来的不排、攒太多只留最新)、层表内容、层表写入(攒、后写的赢、相同不重写、失败退避重试)。
- `src/render/onlineSnapshotSource.test.mjs` OS1～OS7:只取播放头前后 2 秒的段、就绪 = 有小位图的帧、选帧与本地模式同一条路、只拉 `px/<hash>` 且带票据、缓存命中、换键与撤层、没满的段 2 秒后再取、LRU 按字节、没连上不抛。
- `src/export/mp4Mux.test.mjs` MX1～MX4(用 ffmpeg 造 H.264 / AAC 样本,ffprobe 核对):只有视频轨 90 帧 3 秒 320×240 `30/1`;视频 50 帧 + AAC 48 kHz 双声道,帧数与时长对得上;60 fps 竖屏 120 帧、关键帧 2 个;mdat 64 位长度回头补、MemorySink 拼接。
- `src/export/yuv.test.mjs` YUV1～YUV3:BT.601 有限范围的纯色值;奇数宽高;与 ffmpeg `rgba → yuv420p` 逐字节比误差 ≤ 1。

探针(端口段内,原始输出的关键数):

- `node scripts/probes/lowmem-online-probe.mjs --origin http://127.0.0.1:5643`(在线模式 dev server,Chrome 移动端仿真 412×915、触屏、`deviceMemory: 4`;替身素材服务 5646)→ `ok: true, fails: []`:
  - G1:`caps.lowMemory: true`;iframe 只有一个 `/?stage=1&id=A&preview=stage`;`(pointer: coarse)` 与 `(any-pointer: coarse)` 都为真;舞台里的取档策略 `lowMemory: true`;没有探针遮罩;没有 `/api/data/costs`、`/api/frames/*` 请求;进入提示照抄表 C。
  - G2:请求记录 `smallA: 2, origA: 0, origB: 0, px: 2, snap: 0`,票据全是只读票据 —— **网络记录里只有素材小尺寸与预渲染小尺寸**;没有小尺寸的视频显示「等待上传方」;重卡包裹层 `pc-snapshot pc-suppressed`,贴着 800×450 的小位图。
  - G3:播放 2 秒 `t0: 1 → t1: 2.87`;暂停后重卡仍 `pc-suppressed` 且贴小尺寸,`settling: []`(不追活渲)。
  - G4:原尺寸没到齐时回「等待上传方:这些素材的原尺寸还没传完,导出只用素材原尺寸,传完后再导出 —— a.mp4」,取消后回「导出已取消」、不出片;到齐后导出 60 帧用时约 30 秒,ffprobe:`h264` 60 帧 2.000 s 1920×1080 + `aac` 94 帧 2.005 s;请求记录 `mediaOrig: 2, snap: 60, smallMedia: 0`(用的是素材原尺寸与预渲染原尺寸);第 30 帧重卡那一层中心像素 `[255, 0, 251]`(原尺寸快照的品红,不是活渲的药丸)。截图 `g2-phone.png`、导出帧 `export-f30.png` 看过:画面左上 960×540 是品红「原尺寸 30」,其余是素材原尺寸。
- `node scripts/probes/small-tier-probe.mjs --origin http://127.0.0.1:5640`(本进程 FramePipeline + 真 Chrome,推送队列接内存替身)→ `ok: true, fails: []`:S1 60 帧 HTML 旁各有小位图、全部 400×225(框 960×540 × 800/1920)、带 alpha;S2 一段清单 `frames: 60, small: 60`,哈希对得上盘上文件,`snap` 与 `px/webp` 都在素材服务上;S3 层表 `layers:c10a-small-tier-probe` 列着这张卡;S4 关掉小尺寸再跑,`htmlDiff: 0, indexSame: true, keySame: true`,清单不带 `small`。小位图 `frame30.small.webp` 看过:药丸居中,边缘有外发光,透明底。
- `node scripts/probes/lowmem-export-compare.mjs --origin http://127.0.0.1:5640 --frames 45`(浏览器逐帧导出 vs 桌面 `/api/export`,同一项目:一段带声音的视频 + 金句药丸 + 章节条)→ `ok: true`:两边都是 h264 45 帧 1.5 s + aac;缩到 960×540 逐帧比:**第 0 帧平均绝对误差 2.69、PSNR 32.7 dB;之后稳定在平均绝对误差约 7.4、PSNR 约 19～20 dB**。看过同一帧的两张图:素材层与颜色一致(改成自己换 I420 之后;改之前红色差 23 个色阶);差在两张卡的动画相位 —— 浏览器那一份的药丸与章节条比桌面「走得快」。原因与修法见「没做成的」第一条。浏览器导出 45 帧用时约 23.6 s(推帧 13.7 s、素材 4.7 s、快照 0.8 s、栅格化 0.25 s),桌面约 9.1 s。

## 没做成的及原因

- **逐帧导出的动画相位漂移(需要主会话批一处越界)**:浏览器里的导出页不受 CDP 帧控制,Motion 的帧循环在模块求值时就抓走了**原始** `requestAnimationFrame`(`exportClock` 的包装够不着它),于是每个真实 vsync 都跑一拍;时间戳虽被钉住,Motion 每拍至少推进 1 ms,一帧要合成约 0.3 秒 ≈ 18 个 vsync,弹簧类动画就越走越快(实测第 0 帧 PSNR 32.7 dB,之后约 19～20 dB)。桌面导出没有这个问题(beginFrame 控制每一拍)。修法:在 `src/render/stageClockEntry.ts`(`main.tsx` 的第一个 import,赶在 Motion 之前)里对 `?export=1&rafControl=1` 装一个手动 rAF 队列、挂 `window.__pcBrowserBeginFrame()`,逐帧导出的合成器用它代替等真 rAF —— 约 15 行,只影响带这个参数的页面。该文件不在契约第 11 节我的清单里,所以没改,**请主会话决定是否放行**。
- **PNG 快照的小尺寸**（契约第 9 节「PNG 快照：从原图等比缩一次」）：只写了 `renderPng`，没接进管线。PNG 缓存帧（X7 的 `pngs`）在 C10a 里没有消费方（在线页面只贴 HTML 快照的小尺寸），而它们落在 `controls/<key>/mov/frames/`，接进来要动 `MovFrameStore` 的目录与清单格式，超出「只多产一份小位图」的最小改动。建议随 C10 其余。
- **iOS 上能导出的时长与体积**（契约第 11.1 节要求写进报告）：这台机器没有 iOS 设备，记为待用户项。另有已知风险：Safari 历来对画 foreignObject 的画布置污染位，若 iOS 上 `new VideoFrame(canvas)` 报 SecurityError，这条导出路在 iOS 上走不通（Android Chrome 与桌面 Chrome 实测通）。
- **导出期间票据续签**：导出页里素材原尺寸的地址是开导出那一刻带的只读票据（15 分钟）；超过 15 分钟的导出中途会 401。10 秒 demo 不受影响；长片要在导出页里定期换地址，未做。
- **真实端到端（阿里云 + 笔记本渲染节点 + 手机仿真）**：按任务书由主会话做；本分支的探针用替身素材服务与替身内容库验页面一侧，用真 Chrome 验渲染节点一侧，两侧之间的对接（内容库的真连接）没有在同一条链上跑过。

## 偏离契约的地方（需要主会话定）

1. **层表**（契约第 9 节没写页面怎么知道每张重卡的键）：在线页面没有预渲染进程，算不出键（键里有渲染节点的环境指纹、`snapshotCode()` 的哈希）。我让渲染节点把「片段 → 线上键、清单结果键、采样窗口」写进内容库，放在已有的 `snapshot-manifest` 类下、键 `layers:<项目 id>`（`server/docservice/modules/content.mjs` 的类别表不在我的清单里，没加新类）。建议集成时在内容库加一个 `layer-map` 类，把层表挪过去。
2. **低内存档暂停时也抑制重卡**（见第 2 节）：契约只说「不追活渲、停在已有的预渲染小尺寸上」，我按字面做成「暂停、拖动时重卡也藏子树、贴小尺寸或占位」，否则暂停就露出活渲。
3. **图片、音频**：主会话已裁定，照做（只对视频执行只拉小尺寸）。
4. **显示档设置的位置与提示文案**：契约只说「设备设置」「要提示」，没给位置与字。我放在预览标签栏右侧（只在线页面出现），切到普通档的提示写「改为普通档后，下次载入页面时生效。这台设备内存不够时可能卡顿或关掉页面。」，其余切换写「显示档已保存，下次载入页面时生效。」。
5. **低内存档的分派**：在线页面不测（没有后台舞台），重卡按声明兜底（`direct` 轻、其余重），不看渲染节点的判定。渲染节点判轻、页面判重的卡没有小尺寸，页面显示占位。

## 需要集成方（c10a-web / 主会话）接的线

- **`TopBar.tsx`（归 c10a-web）**：现在的流程「先另存为 → `exportVideo()` → `streamExportFile`」在线时照样能用（产物攒在内存，由 `streamExportFile` 整块写过去）。要流式写（常量内存），把拿到的 `FileSystemFileHandle` 作为 `exportVideo({ target })` 传进来，并在回包 `written: true` 时**不要**再 `createWritable` + `streamExportFile`（那会把写好的文件换成空的）。导出前核对的等待提示经 `onWaiting` 回调给出，没接时用气泡。
- **远程素材服务的基址**：`assetTiers.pickAssetEndpoint` 排除「和本页同 host」的地址；在线页面与素材服务同源（`https://host/media/api/asset`），照现在的规则会被排除、`setRemoteAssets` 不会被设 —— 在线模式下这条要放开（c10a-web 的在线接线）。本分支的取档策略、在线快照来源、导出都读 `assetTiers` 的远程基址与票据，基址没设就什么都拉不到。
- **文档服务连接**：在线快照来源经 `assetTiers.docRequest` 走 `connectSharedAssets` 交进来的那条连接；在线进入共享项目时要照桌面一样调 `connectSharedAssets(link, docBase)`。
- **`/api` 守卫**：本分支的在线路径实测不发 `/api/data/costs`、`/api/frames/*`；`dataMirror`、`mcpExecutor` 那几条归 web 处理。

## 对契约或语义的更正建议

- 契约第 9 节补一句「在线页面按渲染节点写进内容库的层表找每张重卡的清单」，并在内容库加 `layer-map` 类（见偏离第 1 条）。
- 契约第 11.1 节「逐帧：合成一帧到复用的原尺寸画布」在浏览器里只能靠 `foreignObject` 栅格化 DOM（没有别的不污染画布的办法），建议写明这一点与它的限制：卡片自带的外部字体（KaTeX 等）会退回系统字体；Safari 可能污染画布（iOS 待实测）。
- 契约第 9 节「生成」建议写明小位图画的是**包裹层的框**里的内容（与快照平面同一块地方），而不是整幅舞台；只有没设框的卡两者相同。

## 文件边界

契约第 11 节我那一行之外动过的文件,都是清单里文件的直接调用方或测试,列在这里供审:

- `src/render/VideoTrack.tsx`、`src/editor/media/assetTiers.ts`:`mediaTier.ts` 的调用处(契约写「`mediaTier.ts` 及其调用处」)。
- `src/layering.test.mjs`:主会话裁定允许,加 `online` 一行。
- `src/editor/stageSwap.test.mjs`:给 `stageSwap.ts` 的改动加一条单测。
- 新建:`src/export/onlineExport.ts`(`exportVideo` 在线分支的本体,放在 `src/export/*`)、`server/bakery/small-bitmap.mjs`、各单测与三支探针(`scripts/probes/lowmem-online-probe.mjs`、`small-tier-probe.mjs`、`lowmem-export-compare.mjs`,名字不带 `c10a-`,不与测试方的文件撞)。
- 没动:`ProbeGate.tsx`、`snapshotFeed.ts`、`stageBridge.ts`、`syncManager.ts`、`TopBar.tsx`、`main.tsx`、`vite.config.ts`、`src/render/stageClockEntry.ts`、内容库模块。

另:`src/online/mode.ts` 读 `import.meta.env`,Node 的单测里没有它 —— 凡是会被单测载入的模块(`stageRpc.ts`、`mediaTier.ts`、`lowMemory.ts`、`io/index.ts` 等)都不能静态 import 它;本分支在这些地方由调用方传 `online`,或按需 `await import`。集成时 c10a-web 也要守这一条(否则 `C65B-V7-01` 这类载入 `io/index.ts` 的测试会挂,本分支中途踩过)。

## 需要主会话决定的事

1. 是否放行改 `src/render/stageClockEntry.ts`(约 15 行)来消除逐帧导出的动画相位漂移(见「没做成的」第一条)。不放行的话,低内存档导出的卡片动画与桌面导出有相位差,误差如上。
2. 层表放在 `snapshot-manifest` 类下(键 `layers:<项目 id>`)是权宜;是否在内容库加 `layer-map` 类(集成时改两处:`content.mjs` 的类别表、本分支的两个 `LAYER_MAP_PREFIX` 使用处)。
3. 「偏离」第 2、4、5 条是否认可。
4. c10a-web 那边要接的三根线(`TopBar` 的 `target` / `written`、在线时放开同源素材服务、在线进入共享项目时调 `connectSharedAssets`)。
5. 合并方式:本分支从 `claude/c66-integ` 的 `851ffe9` 起;C6.6 合入 main 后等主会话通知再把 main 合进来(用合并,不 rebase)。
