# AGENT 报告：c10a-integ

分支 `claude/c10a-integ`，worktree `.worktrees/c10a-integ`，起点 C6.6 集成分支 `claude/c66-integ` 的 `3519ca1`（C6.6 还没合入 main；这一版含 C6.6 的素材同步与渲染主机用户卡两处修复）。端口段 5660～5669。

任务：把 C10a 的三个子分支（`claude/c10a-web`、`claude/c10a-lowmem`、`claude/c10a-tests`）合到一起，落实主会话的裁定，跑通本机验收。依据 `docs/plan/c10a-contract.md`（C10a 契约，下称「契约」；第 16 节「开工后的裁定」在 main 的 `dc28209` 上，本分支起点里还没有这一节，按 main 上的原文读）与三份子报告。

代号说明：「C10A-xx-nn」是 C10a 契约测试的用例号（IV 邀请码、LM 低内存档判定、GT 能力闸、PS 预渲染小尺寸、MP4 封装器、API 在线构建与 `/api` 守卫、MODE 本次新加的 `mode.ts` 引用守门）；「K1～K7」是测试方在 `server/test/c10a-kit.mjs` 里对未定接口的七条假设；「G0-R」是改了预览与导出路径时要跑的像素基线核对（主会话跑）。

## 进度

- [x] 依次合并三个子分支
- [x] `server/test/c10a-kit.mjs` 对账，C10A 53 条真跑、全过
- [x] 主会话裁定逐条落实
- [x] 验证
- [x] 报告写完

## 提交

| 提交 | 内容 |
|---|---|
| `ef09da6` | 建报告 |
| `9f1ef51` | 合并 `claude/c10a-web`（`c25394e`） |
| `0444b00` | 合并 `claude/c10a-lowmem`（`acc3a19`） |
| `6f4e35a` | 合并 `claude/c10a-tests`（`2aa0e6f`） |
| `03ccc9b` | C10A 契约测试对账（kit 的 K2～K6、API-03 改棘轮、PS-07 改写、GT-02 改口径）；`/api` 守卫加 `bootApiGuard(online)` |
| `3ca5872` | `dist-online` 进 `.gitignore`，SPR-6a、SPC6-3 排除它 |
| `faaa746` | 浏览器逐帧导出：`rafControl=1` 手动推 rAF；栅格化时带上导出页样式表 |
| `c697390` | 顶栏导出把「另存为」落点作为 `target` 传下去，`written: true` 时不再 `streamExportFile` |
| `8a0a8f0` | 在线页面认同源的素材服务；守门 C10A-MODE-01/02 |
| `8817b5c` | 在线模式的开发服务认 `?editor`（只给探针用，在线构建里剪掉） |
| `3214f4c` | 探针 `online-join-probe`：修好丢了反斜杠的正则；加 `--with-video` |

## 1. 合并与冲突

- 三次都是 `git merge --no-ff`，没有 rebase，**三次都没有冲突**。
- `src/online/mode.ts`：`c10a-web` 与 `c10a-lowmem` 两边 blob 都是 `247c9b4`，逐字节相同。
- 两个实现分支都改过的文件只有 `src/online/mode.ts`；`server/frame-pipeline.mjs` 由 git 自动合并（lowmem 的改动与 C6.6 在 `851ffe9..3519ca1` 之间的改动不重叠）。
- 合并信息：第一次合并时用了 git 默认的英文信息。当时后面还没有任何提交，我把分支重置回 `ef09da6`，用中文信息重做了三次合并（内容相同）。主会话提醒里提到的 `bc499a8` 因此不在本分支上。之后没有再改写历史。

## 2. `server/test/c10a-kit.mjs` 对账

合并后第一次跑：53 条里 37 过、16 败，0 跳过。对账后 53 条全过。下面逐条写改了什么。「用例改了」的都在用例旁边写了注释。

| 假设 | 实现的实际形状 | 改法 | 用例改了没有 |
|---|---|---|---|
| K1 邀请码 | 与假设一致 | 不改 | 没改，IV 20 条一次全过 |
| K2 低内存档判定 | `lowMemoryMode(online, { probe, override, session })`。`online` 由调用方传入：实现不 import `mode.ts`。判定每个会话只定一次。设备信息从 `probeDevice(env)` 读。舞台一侧是 `detectHostCapabilities({ online })` | kit 的 `pickDecider` 改成：读本进程里 `mode.ts` 的 `ONLINE`（已换成桩），每次判定前后 `resetLowMemoryForTest()`。新增 `hostCapabilitiesOf(stageRpc, mod)` | LM-08、LM-09 各改一行：原来直接调 `detectHostCapabilities()`，改成调 `hostCapabilitiesOf`。理由：实现把 `online` 交给调用方（`StageView` 传 `ONLINE`），而判定按会话缓存，不清缓存的话连续几个场景都会读到第一个场景的结论 |
| K3 能力闸 | `mediaTier` 的 `opts.lowMemory` 与假设一致；`stageSwap` 的闸是 `SwapHost.lowMemory()`，不从 `lowMemory.ts` 读 | 新增 `lowMemorySwapHost(host)`；桩的导出名照实现改 | GT-05、GT-06 的 `beforeEach` 里 `setSwapHost(...)` 外面包一层 `lowMemorySwapHost`。用例正文没动 |
| K3 素材只拉小尺寸 | 已经问过素材服务、小尺寸还没到齐时，回 `{ url: '', tier: 'none', awaiting: true }`：不挂地址，这一层显示占位与「等待上传方」角标 | — | **GT-02 改了口径**。原断言要求这时挂着小尺寸的地址（`tier: 'small'`）；改成断言「不给原尺寸、`awaiting` 为真；还没问过素材服务时先给小尺寸」。理由：挂一个素材服务上还没有的地址会 404，还会被舞台记成视频解码失败（参与运行中改判）；契约第 8 节「没有小尺寸……显示占位」也支持实现的读法。lowmem 自己的 LMT2 断言的也是实现这一种。**需要主会话认可** |
| K4 尺寸规则 | `server/bakery/small-bitmap.mjs` 的 `smallSize({ projectWidth, projectHeight, boxWidth?, boxHeight? })` | `findSmallSize` 直接指向它，按对象参数调用 | PS-01～03 没改 |
| K4 两档分开就绪 | 预渲染进程的就绪索引不收小尺寸。两档分开记在清单里（`frames` 与 `small`）；在线页面按 `small` 算就绪；导出前核对（`src/export/originals.ts`）只认 `frames` | — | **PS-07 改写**：原来要求 `READY_KINDS` 里有小尺寸那一档。改成：`READY_KINDS` 里没有 small；清单里小尺寸盖满 0～59、原尺寸只有 0～29 时，`loadOriginalsIndex` 仍把这张卡算作缺，第 40 帧的原尺寸是 `null`，补齐后才就绪。理由见上一栏。要实现去迁就原断言，就得在就绪索引里加一个没人用的 kind |
| K5 MP4 封装器 | `Mp4Muxer({ video: { codec, width, height, fps, avcC }, audio?, sink })`：解码配置在构造时就要给。`addVideoChunk(bytes, { timestampUs, key })`。`finalize()` 回字节数，产物在 `MemorySink` 里 | kit 里写了适配器 `muxerAdapter`，照 `browserExport.ts` 的做法：先攒块，等解码配置都到了再建封装器、补进去 | 没改，MP4 4 条过（含逐帧 md5） |
| K6 `/api` 守卫 | `installApiGuard()` 调了就装，不看模式；「只在 `ONLINE` 时装」写在 `boot.ts` 里 | 实现加 `bootApiGuard(online, options)`，`boot.ts` 改为调它。kit 照 `boot.ts` 的做法传 `ONLINE` | API-05、06 没改 |
| K6 静态检查 | — | 改成棘轮，见第 3 节 | API-03 改了（〔裁〕） |
| K7 单舞台 | 与假设一致 | 不改 | 没改 |

## 3. 主会话裁定的落实

1. **静态 `/api` 检查改棘轮**〔裁〕
   - 清单文件 `server/test/c10a-online-api-paths.json`，120 个路径，取自集成后的在线构建。口径与 kit 的 `apiLiterals` 相同：引号或反引号后紧跟 `/api/` 再紧跟地址字符；模板里 `${` 之后截断。
   - c10a-web 报告里的「124 种」是它探针里另一个正则的数法（`/api/` 前面不要求引号）。按那个数法，这次集成后是 124 种、203 处，见 `online-join-probe` 的 `online.static-scan`。
   - C10A-API-03 断言「产物里的路径 ⊆ 清单」。清单里有、产物里已经没有的路径只打诊断，不判红。
   - 最后一次在线构建：产物 120 个路径 = 清单 120 个，新出现 0 个，消失 0 个。
2. **`dist-online`**：加进 `.gitignore`。`server/test/sp-route.test.mjs`（SPC6-3）的 `EXCLUDE`、`server/test/sp-routing.test.mjs`（SPR-6a）的过滤与目录遍历都加上 `dist-online`。实测：把一份在线构建放进 worktree 的 `dist-online/`（里面含缺省托管 IP），两个文件 39/39 过；测完删掉。
3. **`shared/challenge` 的 429**：c10a-web 已经按这个裁定做了，没有再改。
   - `server/auth/http.mjs` 的 `tooMany`：挑战端点只带 `Retry-After` 头（经 `Access-Control-Expose-Headers` 放出），回包体照 AU8 原样；邀请码两个端点头与回包的 `retryAfter` 都带。
   - `server/auth/client.mjs` 的 `callJson` 先读回包的 `retryAfter`，没有再读头。
4. **导出动画相位漂移**（`faaa746`）
   - 改动：
     - `src/render/stageClockEntry.ts`：只在 `?export=1&rafControl=1` 时装手动 rAF 队列，挂 `window.__pcBrowserBeginFrame()`。另有兜底：有回调在排队而 5 秒没人推时自己推一拍，记进 `__pcRafFallbacks`。
     - `src/export/frameCompositor.ts`：导出页地址带上 `rafControl=1`；`raf()` 在有 `__pcBrowserBeginFrame` 时手动推一拍。
     - 桌面导出、预渲染的地址都不带 `rafControl`（`server/frame-pipeline.mjs`、`server/vite-plugin-export.ts` 等都是 `?export=1&timeline=`），走的代码与原来相同。
   - **查出误差的真正来源不是相位**：
     - 逐帧找最相近的帧：改前改后，浏览器第 i 帧都最接近桌面第 i 帧，即相位本来就对齐。
     - 剩下约 7.3 的平均绝对误差来自版式：浏览器那份的药丸、章节条整块偏大，动画停住以后也一样。
     - 原因：快照做样式内联时，和同标签基线相同的属性会省掉，而基线里含 Tailwind preflight 的 `box-sizing: border-box`。SVG foreignObject 里没有页面样式，省掉的 `box-sizing` 退回 `content-box`，内边距被加到内联的宽高外面。
     - 修法（同一提交）：栅格化时把导出页的样式表全文放进 SVG（`pageCssText`，第一帧读一次）。
   - `lowmem-export-compare`（45 帧，1920×1080，缩到 960×540 逐帧比）：

     | 版本 | 平均绝对误差 | 最小 / 平均 PSNR | 最差帧 | 推帧耗时 `stepMs` | 栅格化 `rasterMs` |
     |---|---|---|---|---|---|
     | 只改 rAF（`compare1`） | 7.33 | 19.14 / 20.35 dB | 第 6 帧 8.36 | 257 ms | 379 ms |
     | rAF + 样式表（`compare2`，最终版） | **2.22** | **31.74 / 34.10 dB** | 第 2 帧 3.04 | 279 ms | 1050 ms |
     | 只带样式表、不带 `rafControl`（对照，`compare3-noraf`） | 2.23 | 31.75 / 34.03 dB | 第 2 帧 3.05 | **13838 ms** | 887 ms |

     - lowmem 报告里改动前的数：第 0 帧 2.69 / 32.7 dB，之后约 7.4 / 19～20 dB。
     - 结论：在这个项目上，手动 rAF 对误差没有可测的影响（2.22 对 2.23）。它的收益是速度：45 帧的推帧耗时从 13.8 s 降到 0.28 s，`rafFallbacks = 0`，`manualTicks = 157`。误差下降来自带上样式表。
     - 看过同一帧的上下对照图（`compare2/f20-stack.png`，第 20 帧，上为浏览器、下为桌面），药丸与章节条的大小位置一致。
     - 剩下约 2 的误差：第 0 帧就是 2.67，与动画无关，推测是 H.264 两次编码（WebCodecs 与 ffmpeg）加 I420 换算的差，没有再查。
5. **层表放哪**
   - 查的结果：生产代码里没有任何地方按种类列出 `snapshot-manifest` 的全部条目。
     - `content.list` 只有 `server/card-sync.mjs` 在用，列的是 `card-source`；
     - `content.watch` 只订阅 `card-source`；
     - `snapshot-manifest` 只按键 `content.get`、`content.put`（`artifact-transfer.mjs`、`artifact-push.mjs`、`originals.ts`、`snapshotSource.ts`、探针）。
     - 按种类列的只有单测（`artifact-dedup.test.mjs` 带 `<resultKey>:` 前缀；`content-client.test.mjs` 列全部，但那是它自己的替身库）。
   - 做法：**沿用现状**，层表仍在 `snapshot-manifest` 类的 `layers:<项目 id>` 键下，没有加 `layer-map` 种类。
6. **三根线与一条约束**
   - `TopBar`（`c697390`）：`exportVideo({ target, ... })`；回 `written: true` 时不再 `createWritable` 加 `streamExportFile`。`exportVideo` 的返回类型补上 `written?`。桌面那一路不看 `target`。
   - 在线时 `pickAssetEndpoint` 接受同主机的素材服务（`8a0a8f0`）：
     - `pickAssetEndpoint(..., { online })` 与 `connectSharedAssets(link, base, { online })`，由 `syncManager` 按 `ONLINE` 传。`assetTiers.ts` 会被单测载入，所以不静态引 `mode.ts`。
     - 新单测 T5-shared-1b：桌面同主机仍算本机，在线时认同源的 `https://…/media/api/asset`。
   - 在线加入时调 `connectSharedAssets`：**不用另接**。c10a-web 的加入表单（`JoinForm`）走的就是 `syncManager.enterShared`，那里 `onOpen` 时已经调它。lowmem 报告写于看到 web 实现之前。
   - 约束「`mode.ts` 不许被 Node 单测会载的模块静态引用」：新增守门 `src/online/modeImportGuard.test.mjs`。
     - C10A-MODE-01：从每个单测文件出发，顺着静态 import 走（`import type` 与源码里的 `await import()` 不跟；单测里用 `mock.module(srcUrl(...))` 换掉的模块不往下走）。走到 `mode.ts` 而这个单测没换桩就判红，并给出引用链。
     - C10A-MODE-02：核对守门本身能认出静态引用。
     - 变异测试：临时在 `assetTiers.ts` 首行静态引 `mode.ts`，MODE-01 判红并列出 3 条链（`assetTiers.test`、`uploadTarget.test`、`io/mediaTiers.test` 经 `proc → io/index → assetTiers`）；还原后全过。
7. **取消多用户协作时拉回素材原尺寸，用带视频的项目补测**（本机托管组合，`3214f4c`）
   - 给 `online-join-probe` 加了 `--with-video`：
     - 创建者开启「放云端」**之前**导一段 2 秒带声音的视频（pre），开启**之后**在共享项目里再导一段（post）；
     - 等原尺寸传到托管端素材服务；取消前把创建者本机内容库里已上传的那份删掉，取消后核对它从托管端拉回、字节相同、项目仍引用它。
   - 结果：post 那一段上传、删掉、拉回全过（`video.post.pulled-back`，sha256 等于哈希），取消后「多用户协作已关闭，内容已拉回本机。」，托管端 `lookup` 回 404。
   - **新发现**：pre 那一段（开启前就在项目里的视频）开启放云端后 90 秒内**没有传到托管端**。上传队列只收到过 post 一条（`enqueued: 1, skippedLocal: 1`）。
     - 影响：开启前导入的素材，别的成员在云端取不到原尺寸，只有创建者本机有。
     - 取消时拉不回它（它本来就在本机，所以这次取消不受影响）。
     - 见第 6 节「需要主会话决定」。

## 4. 其余改动（集成时发现的）

- **`src/Shell.tsx`：在线模式的开发服务认 `?editor`**（`8817b5c`）。
  - c10a-web 让在线页面不认 `?editor`，打开就是开始页；而 c10a-lowmem 的 `lowmem-online-probe` 靠 `/?editor` 进编辑器。集成后该探针 G1～G3 全失败：页面停在开始页，没有舞台。
  - 改成只在 `ONLINE && import.meta.env.DEV` 时认 `?editor`，在线构建（生产）里这一支被剪掉。用户用不到这条路，但它是为探针加进产品代码的，请主会话过目。
- **`scripts/probes/online-join-probe.mjs` 修了语法错**：c10a-web 提交里 `staticScan` 的两个正则丢了反斜杠（`/.(js|mjs|css|html)$/`、`//api/…/g`），分支上这个文件 `node --check` 不过、跑不起来。已补回反斜杠。c10a-web 报告里的 39/39 应当是在改坏之前跑的。
- 同一探针的桌面编辑器加了 `PROMPTCUT_EXPORT_DIR=<临时数据目录>/out`，原来会把本机素材库写进 worktree 的 `out/`。

## 5. 验证（原始数字）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `npm test` | 退出码 0；tests 3203、pass 3202、fail 0、skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，要 5190）。`claude/c66-integ` 是 3081，本阶段净增 122 |
| C10A 契约测试 | 全量测试里的 C10A 行 | 53 条全过、0 跳过（全量结果里 `✔ C10A-(IV\|LM\|GT\|PS\|MP4\|API)-` 共 53 行）。按文件：`server/test/c10a-invite` 20、`c10a-online-build` 4、`c10a-small-prerender` 7；`src/online/c10a-lowmem` 8、`c10a-lowmem-desktop` 1、`c10a-api-guard` 1、`c10a-api-guard-desktop` 1；`src/render/c10a-gates` 4；`src/editor/c10a-swap-gate` 2、`c10a-single-stage` 1；`src/export/c10a-mp4` 4 |
| 本次新增守门 | `src/online/modeImportGuard.test.mjs` | 2/2 |
| c10a-web 的单测 | `invite-impl` 15、`deploy-editor` 4、`online-impl` 6 | 全过 |
| c10a-lowmem 的单测 | `lowMemory` 10、`mediaTierLowMemory` 7、`stageSwap` 17（含末条低内存档）、`small-tier` 9、`onlineSnapshotSource` 7、`mp4Mux` 4、`yuv` 3、`layering` 3 | 全过 |
| 本次改的单测 | `src/editor/media/assetTiers.test.mjs` | 10/10（含新加的 T5-shared-1b） |
| 在线构建 | `npx vite build --mode online --outDir <scratchpad>/dist-online` | 退出码 0；`index.html` 引 `/editor/assets/index-*.js` |
| 桌面构建 | `npx vite build --outDir <scratchpad>/dist-desktop` | 退出码 0；`index.html` 引 `/assets/index-*.js` |
| 棘轮 | 最后一次在线构建 vs 清单 | 120 / 120，新出现 0，消失 0 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5660/?export=1"` | 退出码 0；Total Frames 1800，Identical 1800，Different 0 |

探针（一次只跑一个；桌面 dev server 5660，舞台 5661/5662；在线模式 dev server 5663，舞台 5664/5665；数据目录都在 scratchpad 的临时目录，跑完已删）：

| 探针 | 结果 |
|---|---|
| `small-tier-probe.mjs --origin http://127.0.0.1:5660` | 退出码 0，`fails: []`。S1：60 帧 HTML、60 张小位图，全是 400×225；S2：清单 `frames 60, small 60`、`bad 0`；S3：层表列着 `clip-pill`；S4：`htmlDiff 0, indexSame, keySame` |
| `lowmem-online-probe.mjs --origin http://127.0.0.1:5663 --remote-port 5666` | 第一次失败（G1～G3，页面停在开始页，见第 4 节），改 `Shell.tsx` 后退出码 0，`fails: []`。G1：`caps.lowMemory: true`，只有一个 iframe `/?stage=1&id=A&preview=stage`；G2：请求 `smallA 2, origA 0, origB 0, px 2, snap 0`，重卡 `pc-snapshot pc-suppressed` 800×450，「等待上传方」角标在；G3：播放头 1 → 2.9，暂停后 `settling: []`；G4：等待上传方原文、取消后「导出已取消」，到齐后 60 帧 h264 + aac 94 帧，请求 `mediaOrig 2, snap 60, smallMedia 0`，第 30 帧中心像素 `[255,0,251]`（原尺寸快照的品红）。`onlineSource.errors: 2`，探针不判它 |
| `c10a-online-probe.mjs --dist <在线构建> --port 5667` | 退出码 0，15/15（S1～S5）。5667 不在测试方的端口段里，探针打了一行提示，不影响结果 |
| `online-join-probe.mjs … --desktop-port 5660 --proxy-port 5663 --doc-port 5664 --asset-port 5665 --with-video` | 47 项里 46 过；唯一失败是 `video.pre.uploaded-to-hosted`，即第 3 节第 7 条的新发现。create、online（四条路 + 限定进入两条 + 各错误口径 + `online.no-api-requests` 0 条）、desktop 三条路、regen、cancel（含视频拉回）全过 |
| `lowmem-export-compare.mjs --origin http://127.0.0.1:5660 --frames 45` | 退出码 0，`fails: []`，误差见第 3 节第 4 条 |

看过的图（scratchpad）：

- `compare1/browser-f6.png`、`desktop-f6.png`、`browser-f44.png`、`desktop-f44.png`（查出 `box-sizing` 的那组）；
- `compare2/f20-stack.png`（修后对照）；
- `lowmem-online/g2-phone.png`；
- `join-shots/cancel-1-done.png`。

## 6. 没做成的与需要主会话决定的事

1. **开启「放云端」时，开启前就在项目里的素材原尺寸不上传到托管端**（第 3 节第 7 条）。
   - C6.6 的上传队列只在导入时入队；`collab.ts` 开启时只做根替换写入，没有把已引用的本机素材交给上传队列。
   - 编辑器进程没有「按哈希入队」的接口，修要动 `server/vite-plugin-media.ts` 或上传队列（C6.6 的地盘），也牵涉语义（开启协作是否等于把素材搬上云），所以没有做。
   - 请主会话决定：归 C10a 返工，还是记进 C10 其余。
2. **GT-02 的口径**（第 2 节）：低内存档下小尺寸还没到齐时「不挂地址、显示占位与角标」（实现）还是「挂着小尺寸地址」（测试原文），我按实现改了用例，请确认。
3. **`Shell.tsx` 在线开发服务认 `?editor`**（第 4 节），请过目。
4. **手机上的界面**：`lowmem-online/g2-phone.png` 里，在线页面在 412 宽的手机视口上仍是桌面布局。右侧 AI 栏露出一条「获取 /api/…」的错误提示（守卫拦下了 AI 配置请求）。契约只要求在线页面不发 `/api/*`，这两处是否在 C10a 做请主会话定；我没有改。
5. 没做的（按任务书由主会话做或属待用户项）：G0-R 全套像素基线、部署与阿里云真机 demo、iOS 上能导出的时长与体积、真手机扫码。
6. `npm test` 期间，worktree 根下出现过一个 `data/auth/`（含 `server.json`）：某个测试或我跑的邀请码测试把托管端数据写到了相对路径 `data/`。它在 `.gitignore` 里（`/data/`），已删掉；来源没有细查。

## 7. 对契约的更正建议

1. 第 8 节「素材只拉小尺寸」：写明「已问过素材服务而小尺寸没到齐时，这一层不挂地址、显示占位与等待上传方角标」（与第 16 节第 1 条的图片音频例外并列）。
2. 第 9 节「两档的就绪分开记」：写明分开记在清单里（`frames` 与 `small`），预渲染进程的就绪索引不收小尺寸；再补一句「在线页面按渲染节点写进内容库的层表（`snapshot-manifest` 类、键 `layers:<项目 id>`）找每张重卡的清单」。
3. 第 11.1 节「逐帧」：写明浏览器里靠 SVG foreignObject 把快照栅格化，要把导出页的样式表一并放进去（快照按基线省掉了全局样式给的值）；导出页用 `rafControl=1` 由导出方逐拍推 rAF。
4. 第 12 节「`/api` 守卫」的静态一条：改成第 16 节之后的棘轮口径（清单 `server/test/c10a-online-api-paths.json`，只许删、不许加）。
5. 第 6 节「放云端」：补一句开启时已在项目里的素材原尺寸怎么上云（见第 6 节第 1 条的决定）。
6. 第 2 节：注明 `mode.ts` 不许被 Node 单测会载的模块静态引用（守门 C10A-MODE-01）。
