# C6.6 阶段报告：两档素材与换档、卡片源码同步

2026-09-27。合入 main `9236d44`（`合并 claude/c66-integ`），release 同步快进到 `9236d44`。设计稿 `docs/plan/c66-design.md`（发给用户但不等；第 9 节是集成裁定）。主会话：2026-09-27 起为 PC 上的「PromptCut 主会话（PC）」（交接见 `docs/reports/HANDOFF-2026-09-27.md`）。

## 1. 结论

- 本机项全部通过：G0（类型检查、全量测试、构建）、G0-R（导出确定性、导出像素与 main 零差异、快照重放一致、三个预渲染探针）、C6.6 自己的三个探针（`tiers-probe`、`tier-switch-probe`、`card-sync-probe`），以及 T9 的本机替身（`--role all` 连跑两次三方全过）。按主计划 6.8 节，本机项全过即合入。
- 跨机 W-T9：**真跨机全过**（2026-09-27 补记）。笔记本当独立渲染主机三轮（T9-X1～X3）都过：认领并完成 PC 发布的任务、经内容库同步装上本来没有的用户卡。笔记本当观察端：T9-X1 因探针场景（两档都传完才放观察端进来）没测到「先小后大」；T9-X2 改场景（约 44 MB 原尺寸传到半路时放观察端进来）后先小后大、换档覆盖、帧号都过，只挂「换档期间有黑帧」，查出一处产品缺陷与一处探针判法问题（第 4 节第 5 条）；修好后 T9-X3 观察端与主机全过（第 7 节）。
- T9 共暴露五处问题（本机替身四处、真跨机 T9-X2 一处），其中四处是产品缺陷、一处是**代码与语义冲突**（按语义改了代码，语义未改），都已修复并合入（第 4 节）。

## 2. 交付

| 部分 | 分支 / 提交 | 内容 |
|---|---|---|
| 两档生成与上传队列 | `claude/c66-tiers`（`1af3e5c`） | 素材小尺寸生成、素材原尺寸重封装、持久上传队列、带宽闸 |
| 拉取与换档 | `claude/c66-fetch`（`0b87440`，codex 攻坚 `44169ee`） | 按需拉取、预取、双缓冲换档、可播性、页面导出拦截；T5b 偶发 3 帧的根因修复 |
| 卡片源码同步 | `claude/c66-cards`（`b0425b2`，codex 攻坚 `b25f482`） | `card-source` 经内容库同步；通知类型不再被覆盖 |
| 契约测试 | `claude/c66-tests`（`069dc0e`） | C66-T1～T8 对抗式用例 34 条 |
| 集成 | `claude/c66-integ` | 四次合并与冲突处理、c66-kit 对账、第 9 节补做三条（C66-I1～I3）、3b 根因修复、T4 断言、源码版本表记忆化 |
| T8 攻坚 | `claude/c66-t8`（codex，`4e12ca9`） | 后台舞台探针测量跨任务边界生成快照，修掉约 16 s 的重测停顿 |
| T9 探针 | `claude/c66-t9` | `scripts/probes/c66-t9-probe.mjs`（`--role creator / observer / host / all`） |
| T9 暴露的修复 | `claude/c66-media-sync`、`claude/c66-host-cards`、`claude/c66-plan-timing`（codex）、`claude/c66-t9-fix`（三轮，最后一轮 `19f1dec`） | 见第 4 节 |
| T9 探针取回时限 | `claude/c66-t9-verify` | 创建方最后「整个取回两档、核哈希」改用 10 分钟时限，取不回时记错误原文（第 7 节 T9-X3） |

### 2.1 3b 的根因（更正 `PAUSE-2026-09-26.md` 第 4 节第 2 条与 `AGENT-c66-cards` 第 5 节）

不是 App 重新挂载。改卡的热更新沿导入链冒到 `Preview.tsx`，Fast Refresh 重跑了它负责舞台握手的 effect，清掉了两个舞台的 RPC 客户端；「选择 AI 助手」是探针每次用全新浏览器时的首启对话框，和改卡无关。修法：热更新在 `src/cards/index.ts` 与 `src/render/cardSourceFiles.mjs` 接住；卡片与部件不做 Fast Refresh（`vite.config.ts`）；舞台报到换上新卡才重测，超时没报到的才重载那一个舞台（新握手类消息 `pc-stage-cards`）；去掉 `b25f482` 每次改卡整页重载两个舞台。效果：可见舞台 v1→v2 间隔 10～63 ms、断画 0、舞台重载 0（旧做法每次改卡断画 1.1～1.3 s）。

## 3. 验收

| 编号 | 标准（设计稿第 6 节） | 结果 |
|---|---|---|
| T1 | 1080p 导入：小尺寸 ≤ 800×600、H.264、faststart；原尺寸编码不变；`tiers` 两个哈希 | `tiers-probe` 过；契约测试 C66-T1 过 |
| T2 | 断网导入再联网只补缺片；两档 `chunks` 都 complete；项目与 `.proc` 无同步状态 | 契约测试 C66-T2（`c66-upload.test.mjs`）过 |
| T3 | 逐个素材、先小后大 | `tiers-probe` 过；T9 里日志顺序 `tier-start small → tier-done small → tier-start original → tier-done original → item-done`、`originalBeforeSmall: 0` |
| T4 | 后台上传期间编辑，主线程 > 50 ms 长任务为 0 | `tiers-probe`：上传窗口 1462 ms、编辑 11 次、长任务 0；无上传对照窗口 3000 ms、编辑 25 次、长任务 0 |
| T5 | 先透明、小尺寸出现、原尺寸到了换档；帧误差不超过一帧；无黑帧 | `tier-switch-probe` ×3：`ok`，frameError −0.05 / 0.99 / 0 |
| T6 | 原尺寸不可播（ProRes）：预览停在小尺寸，导出用原尺寸 | `tier-switch-probe` 与契约测试过 |
| T7 | 原尺寸没到时导出提示「等待上传方」、不出片 | `tier-switch-probe`：`awaiting-uploader`、导出请求 0；服务端 `/api/export` 拦截 C66-I3 过 |
| T8 | A 改用户卡，B 5 s 内装上新版并重测；两端同改，后写的赢、先写的有备份与提示 | `card-sync-probe` ×3：remeasureMs 1976 / 1977 / 2007，断画 0，重载 0，编辑器 DOM 27/27，改卡后无跳转；契约测试 C66-T8 过 |
| T9 | 跨机：创建方导入、生成小尺寸、预渲染，项目放云端；观察端先小后大、卡片源码自动装上；独立渲染主机认领并完成 | 本机替身连跑两次三方全过（第 3.2 节）；真跨机 T9-X3 观察端、主机全过，创建方各步全过，只有探针最后「整个取回原尺寸核哈希」因单个请求 30 s 时限没读完而判不符——在阿里云上直接对存储文件算 sha256，两档都与哈希相符，探针已改（第 7 节） |
| 通用 | G0 + G0-R；导出像素与 main 0 差异 | 第 3.1 节 |

### 3.1 基线与 G0-R（主会话在 PC 上跑）

- **合入结果 `9236d44`**（C6.6 试合到 main `c1ac3ca` 上，含同期合入的 V8、callId、聊天列表）：`npx tsc -b --force` 退出码 0；`npm test` 3114 条、3113 通过、0 失败、1 跳过（需要 5190 的那条）；`npm run build` 成功。
- **集成分支 `cf5c5fc`**（合入前最后一次改到产品代码的版本；之后只改了探针与报告）：
  - `npx tsc -b --force` 0；`npm test` 3082 / 3081 / 0 / 1；
  - dev server `npx vite --port 5690 --strictPort --host 127.0.0.1`（舞台 5691 / 5692）；
  - `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5690/?export=1"`：1800/1800 逐像素相同；
  - 导出像素基线：与 main 基准（`.worktrees/pc-main-g0r`，main `bc2652f` 的 1800 帧；main 自那以后没有改到渲染的提交）逐像素比，total 1800 / identical 1800 / different 0 / missing 0 / extra 0；
  - `verify-unified-frames`：PASS（no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames）；
  - `ready-index-probe --port 5693`：退出码 0、`fails: []`；
  - `stream-produce-probe` 与 `--group`：都 PASS；
  - `preview-fallback-probe` 与 `--page-preload`：都 PASS，透明拍数 0（各 281 拍）；
  - 此前在 `29c9cb1` 上同样的 G0-R 六项也全过，看过「超过 6 路流」截图：粒子流照常，超预算的两块显示沙漏占位（不透明），符合 `rendering.md`「兜底顺序」。

### 3.2 T9 本机替身

`run-t9-local.sh`：临时托管组合（只绑回环，8794 / 8795）+ 临时协调口（8796）+ `c66-t9-probe.mjs --role all`（creator 5590、observer 5593、host 5596）。在 `claude/c66-t9-fix` 上连跑两次（fast1、fast2），三方都 `ok: true`、`fails: []`：

| 轮 | creator | host | observer |
|---|---|---|---|
| fast1（151.8 s） | 8 任务 8 完成（PC 4、host 4），发布到落定 127.4 s，改卡 69 ms | 认领 4、完成 4，恰好一次 8/8，清单 8、块 24 无缺，v2 56 ms 进改动层、底版不动，代码版本与 creator 相同 | 先小（帧号 75）后大（帧号 75），换档间隔 716 ms、换档前小尺寸样本 7 个、黑帧 0；播放头一直 2.5 s；v2 196 ms，重测 1666 ms |
| fast2（160.6 s） | 8 任务 8 完成（PC 4、host 4），发布到落定 136.5 s，改卡 66 ms | 认领 4、完成 4，恰好一次 8/8，清单 8、块 32 无缺，v2 16 ms | 先小（75）后大（75），换档间隔 743 ms、样本 7 个、黑帧 0；v2 177 ms，重测 1495 ms |

原始结果行在 `docs/archive/agent-reports/AGENT-c66-t9-fix.md`。主会话在 `cf5c5fc` 上另跑一轮（`final1`）：creator、host 全过；observer 播放头稳在 2.5 s、先小后大、帧号 75/75、黑帧 0，但两档在观察端加入前已齐，小尺寸出画面后 21 ms 就换原尺寸（快于一个采样间隔），三条采样判法取不到样本——探针判法对这种合法的快速换档太严，已改（快换时小尺寸帧号取首次出画面的帧号、不要求采样覆盖换档；先小后大与无黑帧照旧），用 `final1` 的数据回放验过。

## 4. T9 暴露的问题与修复

| # | 现象 | 根因 | 修复 | 性质 |
|---|---|---|---|---|
| 1 | 观察端拿不到视频：素材记录一直 `pending: true, hash: null` | `mediaUpload.ts` 三处原地改 media 再调只换 `path` 的 `setMediaPath`；共享项目按对象身份判断改动，只看到 `path` | 新增 `actions.updateMedia(mediaId, patch)`（新对象、新数组、不进撤销栈），三处改走它（`claude/c66-media-sync`，先提交失败的复现单测） | 产品缺陷 |
| 2 | 另一台机器上的独立渲染主机只要没有创建者的用户卡，一个任务也认领不了 | `server/frame-code.mjs` 的全局代码版本哈希整个 `src/`（含 `src/cards/user`） | 全局代码版本不含用户卡、换行统一；用到用户卡的任务在 `requires.cardSources` 标卡片代码身份，节点按本机有没有这份代码认领；独立渲染主机经内容库 `card-source` 同步用户卡（`claude/c66-host-cards`） | **代码与语义冲突**：语义 `product/platforms.md`「渲染节点」规定独立渲染主机「能认领：全部」，`mechanism/document-service.md` 规定任务标明要不要用户卡、节点按能力过滤。按语义改代码，语义未改。契约 `render-queue-contract.md` B.4、`render-host-contract.md` 第 3、4、7 节同步 |
| 3 | 重卡片段的计划时而切 0 个任务、不重发；`sink-incomplete` 可重试任务无人做完 | 页面在测量落定前就发 preload；可重试任务重新开放后原节点立刻重领 | 测量完成后通知预渲染调度器、按测量后的集合重发；`sink-incomplete` 的原节点退避一个巡检周期（`claude/c66-plan-timing`，codex 攻坚） | 产品缺陷 |
| 4 | 观察端播放头被冲回 0 | 成员加入、卡片同步装卡后舞台重载，暂停中的停止处理把新舞台的 0 写进播放头 | 真的发过播放才采用舞台回报的 `stoppedAt`（`Preview.tsx`，`claude/c66-t9-fix`） | 产品缺陷（用户看得见：暂停时舞台重载不再把播放头冲回 0） |
| 5 | 真跨机 T9-X2：观察端换档期间逐帧采样 106 个「黑帧」，全是「显示中的原尺寸元素 `readyState` 1」 | ① Chrome 在 seek 期间先把目标帧交给合成器（`requestVideoFrameCallback` 回调）、缓冲够了才发 `seeked`；换档按设计以「真有一帧画到屏幕上」为准，所以对调时 `readyState` 仍是 1，截图显示的就是对齐的那一帧（亮度 130），探针把它当成了黑帧。② 查的时候另发现：素材服务上某一档刚到齐与预热槽位换上这一档的 src 恰在同一轮时，刚换上 src 的槽位因 `networkState` 本就是 `NETWORK_NO_SOURCE` 被多 `load()` 一次，打断刚发出的请求与 seek | ① 探针判黑改看真实画面：`readyState < 2` 时截合成后的舞台量亮度、并看元素此前出没出过帧；② 判据抽成纯函数 `reloadOnComplete`（`src/render/mediaSync.ts`），这一轮刚换上 src 的槽位不重载，`VideoTrack.tsx` 按槽位记 `fresh`，单测 3 条（`claude/c66-t9-fix` 第三轮，`287eca9`）；用 `--observer-throttle` 限速在本机复现与验收 | ① 探针判法；② 产品缺陷（换档时多一次加载等待，用户看得见的是换档变慢，不是黑帧） |

另：重卡片段靠测量判重，`probe-typewriter` 闲机上追帧比 80 / 门槛 60 勉强判重、忙机上判轻，探针前提被机器负载左右。探针改用产品已有的人工钉死（`pinnedHeavy`）把重卡片段钉成重卡，轻重门槛与判定不变〔裁：T9 验的是跨机的素材与卡片同步和主机认领，不是轻重判定；「测量→判重→重发」由 codex 的单测覆盖；确定判重的探针卡记为以后的加固项〕。

## 5. 主会话的裁定（〔裁〕）

- T8 偶发 16 s：选 (a)，保留不断画的做法交 codex 攻坚，未放宽 5 s 门槛、未加重载兜底。
- `vite.config.ts` 对卡片与部件不做 Fast Refresh：接受（只影响开发期，探针证实不断画、不重载）。
- 本机改底版卡片的观察脚本不入库（运行时要改仓库卡片文件，误跑会波及用户常驻编辑器）。
- 上传目标 `{ base: null }` 回到缺省目标（设了 `PROMPTCUT_ASSET_URL` 就是它）。
- 渲染主机的换行统一：接受（否则 Linux 云端主机与 Windows PC 永不同池；代价是 Windows 上的预渲染结果一次性重渲）。
- 主机本来没有的用户卡写进检出目录 `src/cards/user/`：暂时接受（与桌面同步、打开 `.proc` 同一条路，用户卡加载器只扫这个目录）。一台主机服务多个项目时同名卡后装的赢、另一项目的相应任务跳过（不会用错代码）。
- T9 探针用人工钉死的重卡片段；快速换档的判法。
- C6.6 与 C10a 重叠排期：C10a 三个分支从 C6.6 集成分支拉出，与 T9 并行（不跳过任何验收）。

## 6. 远端操作记录（8.219.80.16）

- 2026-09-27T01:35:29Z：从 `claude/c66-integ` `29c9cb1` 部署托管组合（`deploy-hosted --save`，数据目录保留），先备份 `/opt/promptcut-hosted/pm2.config.cjs` 为 `pm2.config.cjs.bak-20260927-c66`。部署脚本把两个公网地址写回了 `ws://8.219.80.16:8787`、`http://8.219.80.16:8788/api/asset`，已手工改回 `wss://8-219-80-16.sslip.io/hosted/`、`https://8-219-80-16.sslip.io/media/api/asset` 并 `pm2 startOrReload --update-env`、`pm2 save`。核对：本机回环两个 healthz 200；经 443 `/hosted/healthz`、`/media/healthz` 200；匿名 WebSocket 升级 401；匿名读信箱 401；匿名读素材 `chunks` 401；远端 `vite-plugin-media.ts` 的 sha256 与分支一致（`3791417ab54b491b…`）。`promptcut-hosted` 重载一次，当时没有成员在线。
- 2026-09-27T04:39:41Z：从 `88fbf8c` 重新部署（带 `server/render-queue/queue.mjs` 的重试退避；远端 `queue.mjs` sha256 前 16 位 `fcb2cdd10468b326` 与分支一致），公网地址同样改回，经 443 两个 healthz 200、匿名升级 401。
- 2026-09-27（笔记本主会话，交接前）：`probe-coord` 换新版（消息种类加 `status`），21:36:15Z 重启，旧版备份 `/opt/probe-coord/probe-coord.mjs.bak-20260927`，`mail.jsonl` 保留。

## 7. 跨机指令与回执

- to-cloud seq 8【W-开工-2】（2026-09-26T23:15:59Z）：请云端报到并复测经代理连 `/hosted/`；两个长轮询周期内无回执，按 6.8 节判为不在线，登记不等（后台等待一直挂着）。
- 【L-1】（跨会话，PC → 笔记本辅助节点）局域网 TCP 双向可达：笔记本 → PC `http://192.168.50.96:8797/` 回 `pc-lan-ok`；PC → 笔记本 `http://192.168.50.247:5561/` 回 `laptop-lan-ok`；两台机器都是 Public 网络类别，`C:\program files\nodejs\node.exe` 入站放行（笔记本只放行这一份 node）。辅助节点端口段 5560～5579。
- 【T9-X1】（跨会话）：笔记本在 `.worktrees/lt-T9-X1` 检出 `88fbf8c`（node v24.19.0、Chrome 153.0.8010.53），observer 端口 5563、host 端口 5566，run `t9x10927a`，2026-09-27T04:41:14Z～04:44:17Z；PC 创建方同 run、端口 5590，托管组合与协调口在阿里云。
  - creator（PC）：两档先小后大传到阿里云（small 1446 ms、original 1645 ms complete）；计划 8 任务 8 完成（PC 4、笔记本主机 4），发布到落定 156.3 s；改卡 72 ms、cardRev 2；项目已删。
  - host（笔记本）原样：`{"role":"host","run":"t9x10927a","port":5566,"cardInRepoBefore":false,"readyQueue":{"profile":"host","nodes":1,"maxConcurrent":2,"codeVersion":"707837925081"},"cardSync":{"connected":true,"rev":1,"notices":[]},"profile":"host","claimed":4,"completed":4,"dedup":0,"failed":0,"lost":0,"connected":true,"assetBase":"https://8-219-80-16.sslip.io/media/api/asset","codeVersion":"707837925081","plan":{"planId":"plan:p-mujbzhdu-9d1f7688@2","tasks":8,"done":8},"creatorCodeVersion":"707837925081","doneCounts":{"tasks":8,"exactlyOnce":8,"missing":0,"duplicate":0},"artifacts":{"manifests":8,"missingManifests":0,"blocks":25,"missingBlocks":[]},"cardV2":{"ms":3,"rev":2,"inOverlay":true,"baseUntouched":null},"exitCode":0,"released":0,"ms":180283,"fails":[],"ok":true}`
  - observer（笔记本）：卡片同步过（v1、v2 都装上，`installMs` 633、`remeasureMs` 1061，播放头 2.5）；「先小后大」没测到：`tierSequence` none(1389 ms) → original idx 0(2350 ms) → original idx 75(2481 ms)。原因是探针场景：测试视频约 100 KB，两档都传完才放观察端进来，原尺寸直接先到（合法行为：原尺寸已齐就给最好的画质）。探针改为「原尺寸传到半路时暂停上传队列（目标 `{ base: null }`）、放观察端进来、看到小尺寸后再恢复」，改好后发 T9-X2 补做。
- 【T9-X2】（跨会话，先列后发）：笔记本检出 `7d90218`（node v24.19.0、Chrome 153.0.8010.53），observer 5563、host 5566，run `t9x20927b`，2026-09-27T05:06:17Z～05:10:17Z；PC 创建方同 run、端口 5590。场景改为：创建方导入约 44 MB 原尺寸（6 片），小尺寸传完就暂停上传，观察端看到小尺寸稳定（KV `observer.small`）后续传。
  - creator（PC）：视频 44,611,416 字节；小尺寸 6514 ms complete，原尺寸 122,889 ms complete；暂停时正在传的那一片回 401（暂停清掉票据，队列记一次重试，续传时小尺寸一片不重发、原尺寸只补缺的片，属设计行为）；只因观察端失败判 `ok: false`。
  - host（笔记本）：`ok: true`；认领 4、完成 4，恰好一次 8/8，代码版本 `27fcbf9f4dfd` 与创建方相同。
  - observer（笔记本）：只挂「换档期间逐帧采样无黑帧」一条（106 个样本）；其余全过：首帧是小尺寸（帧号 75、800 宽），当时原尺寸 0/6 片、未 complete；小尺寸 13.6 s 出画面，原尺寸 109.2 s 换上（帧号 75、1920 宽）；换档覆盖（`covered`，采样 11,277 个）；卡片同步过。根因与修复见第 4 节第 5 条。
- 【T9-X3】（跨会话，先列后发）：笔记本检出 `19f1dec`（main，含第 4 节第 5 条的修复；node v24.19.0、Chrome 153.0.8010.53），observer 5563、host 5566，run `t9x30927c`，2026-09-27T06:12:29Z～06:16:55Z；PC 创建方在 `.worktrees/merge-test`（同为 `19f1dec` 的干净检出）、端口 5590。
  - observer（笔记本）：`ok: true`、`fails: []`。首帧小尺寸（帧号 75、800 宽），当时原尺寸 0/6 片、未 complete、创建方尚未续传；小尺寸 7.1 s 出画面、换档前稳定；原尺寸 109.5 s 换上（帧号 75、1920 宽），帧号误差 0；`covered`，采样 12,027 个、换档前小尺寸 11,986 个、**黑帧 0**；`lowReadyState`：37 个样本都此前出过帧、都有截图，3 张截图亮度都是 130，只出现在换档那一刻的一个 351 ms 窗口里（与第 4 节第 5 条的「seek 未完成前先出帧」一致）；媒体日志里 `load()` 两次：一次是原尺寸到齐时重载之前因「还在上传」失败过的元素（`VideoTrack` 唯一的 `load()` 调用点，刚换上 src 的槽位已排除），一次是可播性探测收尾；卡片 v1、v2 都装上，`installMs` 690、`remeasureMs` 1695；播放头一直 2.5；页面错误 0。
  - host（笔记本）：`ok: true`、`fails: []`。认领 4、完成 4，恰好一次 8/8，清单 8、块 23 无缺；代码版本 `bc6acc7b6d5c` 与创建方相同；v2 4 ms 进改动层。
  - creator（PC）：视频 44,272,711 字节（1920×1080、30 fps、6 s）；小尺寸 6887 ms complete 时暂停，原尺寸 0/6；观察端报小尺寸稳定后 24.9 s 续传，原尺寸在导入后 119.8 s complete（续传后约 88 s，PC 到新加坡的上行）；暂停那一片 401 → 重试一次，续传时小尺寸 0 片重发、原尺寸发 6 片；计划 8 任务 8 完成（PC 4、笔记本主机 4），发布到落定 136.0 s；改卡 63 ms、`cardRev` 2；项目已删。
  - creator 判 `ok: false`，唯一一条是探针最后的「托管端 original 字节与哈希相符」。查实：这一步用素材服务客户端的 `get()` 在**一个请求**里取回整个 44 MB 原尺寸，客户端对单个请求（含读完回包）缺省限时 30 s、重试也各 30 s；T9-X2 那次在时限内读完，这次没读完，`.catch(() => null)` 把超时吞成了「不符」。当场在阿里云上对存储文件核对（只读）：`/var/lib/promptcut/hosted/assets/media/2f/2fcf0b4e….mp4` 44,272,711 字节、`sha256sum` = `2fcf0b4ec536513ecc0864f479634f9007dfed631923ee7a09a5430fb6725b1d`；小尺寸 `9a/9a5be842….mp4` 9,722,395 字节、`sha256sum` = `9a5be8428f19aec1dd649f4e890fdf8100cf4dd2807064269adbf6b3d768c6a8`，两档都与哈希相符；经 443 的取用路径由观察端显示原尺寸画面证实。探针改为这一步用 10 分钟时限、取不回时把错误原文记进 `hostedBytes`（`claude/c66-t9-verify`）。本机替身复跑时这一步取回两档 9,743,709 / 44,254,543 字节、249 / 1373 ms、核哈希通过；那一轮整体没过：机器满载（CPU 97%，同时有两份全量测试并行、HT-a 与 C10a 的验证在跑），「plan 切分完、细任务都落定」超时，三方随之中止，与本改动无关（同一提交在真跨机 T9-X3 里 136.0 s 落定）。

## 8. 顾问调用记录

| 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|
| 查资料（codex，`gpt-6-sol`/`high`） | 两档命令、faststart 判定、可播性、无缝换档、测试素材 | 设计稿第 8 节 | 采纳 |
| 攻坚（codex worktree） | `c66-cards` 的「B 端装上新卡后不重测」 | thread `01a0dfb0-5037-7ea2-a96e-f5b460a2fb22`；`b25f482`；根因是服务端把 `pc:card-sync` 的通知类型覆盖成 `installed` | 采纳（整页重载的修法后被集成的 3b 根因修复取代） |
| 攻坚（codex worktree） | `c66-fetch` 的 T5b 偶发 3 帧 | thread `01a0dfb0-9c61-7fa0-aa34-198f5b9f02cd`；`44169ee`；按同一显示时刻外推比较预热帧、对齐播放速率 | 采纳；PC 主会话复审接受，G0-R 复核通过 |
| 攻坚（codex worktree） | T8 改卡后重测偶发 16 s | thread `01a0e06d-3165-7620-ab0b-f84c537b8ee2`，1531 s；`4e12ca9`；后台舞台真 rAF 被节流到约 1 s，16 次测量逐样本等待 | 采纳 |
| 攻坚（codex worktree） | 重卡计划切 0 个任务、可重试任务无人做完 | thread `01a0e0ac-f028-7ea2-98fa-e70e4f9be2d1`，1801 s + 1753 s；`25f2267`、`432769a`、`b528375` | 采纳 |
| 自检连通性 | 空问答 | codex thread `01a0dffe-c833-7791-917d-d4aa56193f3f`；agy conversation `69cf3abf-17eb-4a88-b652-b60e9fc3d305` | — |
| Gemini | 本阶段没有走到发散求解（第 3 级），交互文案沿用设计稿 | — | 没有调用 |

## 9. 同期合入 main 的维护分支（不属于 C6.6 本身）

| 分支 | main 提交 | 内容与验证 |
|---|---|---|
| `claude/flaky-timing` | `2958b7b` | proc-lock 等条件成立、V8 最多八批摊开量；试合后 tsc 0、npm test 2962/2961/0/1 |
| `claude/v8-diff-perf`（`opus-dev-high`） | `f126bf0` | `diffIdArray` 递归前廉价判「不出操作」，整份深拷贝项 2.0 → 0.70 ms；V8B 等价对拍 20330 组逐条相同；主会话逐分支核对 `noOpsBetween` 与 `diffValue`，重跑 tsc 0、npm test 2971/2970/0/1；笔记本复核【V-1】20/20，深拷贝项中位数 0.935～0.994 ms。flaky-timing 报告第 4 节的 a、c 两条搁置〔裁〕 |
| `claude/runner-callid`（`opus-dev`） | `d2c66de` | codex、agy 两路的工具调用也带 `callId`（`server/agent/call-pairing.mjs`，宁可不配、不许配错）；真实跑 codex、agy 各一次，聊天记录里出现「撤销这步」；试合后 tsc 0、npm test 2982/2981/0/1；`c65-design.md` 第 7 节同步（`fa8adaa`） |
| `claude/chat-list-window`（`opus-dev`） | `03945fa` | AI 栏聊天记录超过 150 条〔裁：原定 40〕时窗口化；顺带修掉滚动区子元素被 flex 压缩；探针 19/19（2000 条的会话消息节点 3～7 个、无长任务；main 同探针 7 项失败、176 个长任务）；试合后 tsc 0、npm test 2994/2993/0/1 |

release 每次都按 `git_and_release.md` 判过并快进（`8a5d6ff`、`f126bf0`、`d2c66de`、`03945fa`、`9236d44`）。另有别的会话在 main 上提交过 `46b8cd2`、`45cc902`（`docs/auto_long_work/` 会话提示词模板，纯文档）。

## 10. 待跨机复核项

- **T9-X2**（观察端在「原尺寸还在路上」时先小后大）：已补做完，T9-X2 查出问题、T9-X3 全过（第 7 节）。
- **云端当独立渲染主机**（覆盖原 HT9 的硬验收）：云端会话不在线（W-开工-2 无回执），登记不等；云端回来后补做。
- **放本机版 T9**（辅助节点窗口项，不挡合入）：PC 当主机、笔记本经局域网直连加入。

## 11. 要在 M8 之内修的遗留（本阶段新增或更新）

- 点「撤销这步」后文档服务里那条轨道已删，页面时间轴要等下一次改动才刷新（`src/editor/sync/`，runner-callid 端到端时发现）。
- 代码注释里的旧词「原片」「小版」统一换成「素材原尺寸」「素材小尺寸」。
- T9 用确定判重的探针卡代替人工钉死（加固项）。
- 主机本来没有的用户卡目前写进检出目录；「主机完全不写检出目录」要求用户卡加载器也扫改动层。
- `server/test/skill-gate.test.mjs` 缺省连 5190：用户编辑器开着时 `npm test` 会对它发写请求（关、开 SKILL 模式，占独占锁）。已派维护分支改为显式开启（`claude/skill-gate-optin`）。修复进 main 前，主会话跑全量测试一律把 `PROMPTCUT_BASE` 指到连不上的端口。
- `PAUSE-2026-09-26.md` 第 4 节其余三条照旧（`create_card` 带 overwrite 被改动层旧版盖住；聊天记录窗口化与 callId 两条已在本期修掉）。
- `server/vite-plugin-frames.ts` 第 52 行引用的 `AGENT-c6-4-pipeline.md` 在仓库历史里不存在（早先就断掉的引用）。

## 12. 需要用户决定或知道的事

- **建议写进开发规则**：「不许原地改 store 里的项目对象——共享项目靠对象身份判断改动」（素材同步那处缺陷就是这样来的），放 `guide_files/` 哪一节由你定。
- **建议补语义（三级）**：`mechanism/rendering.md` 的轻重判定一节补「人工钉死」（它和降级一样决定判重）。
- **`Preview.tsx` 的改动你看得见**：暂停时舞台重载（例如同步装上别人改的卡）不再把播放头冲回 0。
- **你的编辑器可能被测试打扰过**：修复 `skill-gate.test.mjs` 之前，若你在 5190 开着编辑器、恰逢子 Agent 跑全量测试，测试会关掉并重开编辑器的 SKILL 模式。C10a 集成的一次全量测试里这条测试失败过一次，说明当时 5190 上有服务在跑。
- **待用户项**：
  - 笔记本回收站里的凭证压缩包 `promptcut-laptop-credentials.zip`，可选清空（交接文件第 5 节）；
  - agy 配置里 145 条常驻 MCP 放行规则（91 条 `mcp(promptcut/*)`、54 条 `mcp(winauto/*)`，含安装、登录、蓝牙与音频设置、删除类工具）是否保留。

## 13. 与对齐时不一致的地方

- W-开工-2 先发出、后在对话里补列（6.3 节要求先列后发）；之后的 L-1、V-1、T9-X1 都先列后发。
- C10a 三个分支在 C6.6 合入前就从 C6.6 集成分支拉出（排期裁定，第 5 节）。
- 子 Agent 报告按 `multi_agent.md` 归档到 `docs/archive/agent-reports/`：C6.6 的十份（`AGENT-c66-*`）与同期维护分支的五份（`AGENT-coord-mailbox`、`AGENT-flaky-timing`、`AGENT-v8-diff-perf`、`AGENT-runner-callid`、`AGENT-chat-list-window`）；仍在用的契约与代码注释里的路径已改到归档位置。
