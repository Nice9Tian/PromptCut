# AGENT 报告：media-path（跨机器打开项目时的素材路径）

分支 `claude/media-path`，worktree `.worktrees/media-path`，起点 main `8d3a22c5`（0.7.9 之后）。任务书：`docs/plan/TODO.md`「语义与代码的差距」里「跨机器打开项目时的素材路径」一条（2026-09-30 `claude/pack-hash` 发现，见 `docs/archive/agent-reports/AGENT-pack-hash.md`）。

## 需要主会话先看的两处

1. **第 2 条比任务书写的多做了一步（三级〔裁 1〕）**：任务书第 2 条只说「只有路径、本机取不到文件的素材」标「(缺失)」，但验收探针第 ② 步要求「同一 `.proc` 在内容库里没有这些字节的第三个实例里打开，素材标『(缺失)』」——那个 `.proc` 里的素材**都带哈希**。只做「只有路径」那一半，探针 ② 过不了。所以打开**本机项目**时，带哈希、本地内容库里却没有这份字节的素材也标「(缺失)」（经素材服务现有接口 `GET /api/media/local?hashes=…` 问；哈希留着，下次打开照样按哈希找；有了之后去掉标记）。
2. **发现一处任务书外的缺口，没有修（需要主会话定）**：放云端的项目里**新导入**的图片、音频不会进上传队列。`server/media-tiers.mjs` 的 `prepareImport` 对非视频直接返回、不调 `handToQueue`，页面一侧也没有别处按哈希入队（只有开启放云端那一刻 `queueExistingMedia` 交一次）。所以开启放云端**之后**导入的配音、图片只在本机，别的成员拿不到。本任务第 3 条（后台补上哈希的素材）我在页面一侧显式入队、绕开了这个缺口，但普通导入那条路没动：它在 `server/`（素材导入）里，超出本任务的文件范围。建议另开一项（见「需要主会话决定的事」）。

## 状态

完成，等主会话审查。类型检查 0 错误；`npm test` 4212 项、失败 0、跳过 2；代码指纹不变；新探针与往返探针都退出码 0、`fails: []`；G0-R 导出确定性 1800 / 1800、与基准逐像素 0 不同 0 缺失、快照重放 PASS、其余探针过——**只有 `stream-produce-probe` 的编码耗时门槛三遍都没过（p50 329～892 ms，门槛 300 ms，同机有别的会话占 CPU），待整机空闲时复核**，见「验证」。

## 提交

| 提交 | 内容 |
|---|---|
| `9facccce` | 文档：建本报告 |
| `6802e030` | 修复：导出取素材有合法哈希时走 `/@media/<hash>`，只有没有哈希时才按 `path` 读；单测 MP-E1～E3 |
| `ac734b6b` | 修复：打开项目后本机取不到文件的只有路径的素材标「(缺失)」（共享项目不标，取到时去标记）；放云端后后台补上哈希的素材交给上传队列、补不上的列给用户；单测 MP-M1～M4、MP-U1～U4 |
| `bb21d84b` | 修复：打开本机项目时带哈希、本地内容库里没有这份字节的素材同样标「(缺失)」，有了去掉标记；单测 MP-M5、MP-M6 |
| `f52abb3c` | 探针：`cross-machine-proc-probe.mjs` |

（用例编号：MP-E 是导出取素材，MP-M 是标「(缺失)」，MP-U 是放云端后进上传队列。）

## 做了什么

改动文件：`server/vite-plugin-export.ts`、`src/editor/io/mediaUpload.ts`、`src/editor/media/assetTiers.ts`、`src/editor/sync/collab.ts`（只把 `postEnqueue` 改成导出）、`src/editor/Preview.tsx`（2 行）、新文件 `src/editor/sync/backfillUpload.ts`；测试 `server/test/export-media-url.test.mjs`、`src/editor/io/mediaPath.test.mjs`；探针 `scripts/probes/cross-machine-proc-probe.mjs`。

### 1. 导出按哈希取素材（`server/vite-plugin-export.ts`）

- 原先 `/api/export` 里「只要有 `path` 就改成 `/api/media/file?path=…`」那一段，和随后的 `normalizeExportMedia` 合成一个函数 `normalizeExportMedia`（导出，便于单测）：
  - 有合法哈希（`originalHashOf`：`tiers.original` → `hash` → 地址里的哈希，64 位十六进制）→ 地址一律 `/@media/<素材原尺寸哈希>`；地址本来就是这份哈希的（含带扩展名写法）原样留着；**不看 `path`**。与 `server/render-project.mjs`、`vite-plugin-vision.ts` 同一条规矩；
  - 没有哈希、有 `path` → 与改前逐字同一结果（在素材目录里且文件在的用解析后的绝对路径，否则用原路径）；
  - 没有哈希也没有 `path` → 暂存区地址 `/@export/media/…` 换成这次导出目录里的，同改前。
- 带哈希的素材改前若带 `/@export/media/…`（浏览器上传进暂存区）且没有 `path`，改前用暂存区地址，改后用按哈希地址。导出前已有「素材原尺寸到齐」的拦截（`exportOriginalsGate`），走到这里时按哈希一定取得到。
- `vite-plugin-export.ts` 不在 `SNAPSHOT_FILES`、也不在 `CAPTURE_FILES` 里，代码指纹不变（见验证）。
- 导出页在预渲染进程上跑，`/@media/<hash>` 由它转给素材服务（`vite.prerender.config.ts` 的 mediaRoutes），合成音轨那一步（`server/bakery/media.mjs`）也认这个地址。

### 2. 只有路径（以及带哈希但本机没有字节）的素材标「(缺失)」（`src/editor/io/mediaUpload.ts`）

打开项目后的后台检查（`startTierBackfill`，`Preview` 挂上时起，1.5 s 后、素材表每次变化后再判）里做：

- **只有路径的**：0.7.9 的 `ingestUnhashedMedia` 本来就会逐个读地址去取字节。现在 `ingestOne` 多回一个 `unreachable`：adopt 不收、且每个读地址都明确答了「没有」（非 2xx，或落到页面回退 `text/html`）才算本机取不到；取到了字节但入库失败、或请求本身出错（编辑器进程不在）都**不算**，不标。后台这一轮带 `markMissing` 时把 `unreachable` 的照现有规矩标：地址清空（预览、导出跳过）、名字前加「(缺失) 」（与 `restoreMediaUrls` 同一个前缀）、`path` 留着；控制台照旧打一行「缺失素材」。打包、放云端那两处调用不带 `markMissing`，只报告。
- **带哈希的**（〔裁 1〕）：新函数 `checkHashedMedia` 经 `GET /api/media/local?hashes=…`（素材服务现有接口，40 个一批）问本地内容库；没有的同样标「(缺失)」，哈希留着；以前标过、现在有了的去掉标记、地址换回 `/@media/<hash>`。问到有的哈希记住（哈希不可变），没有的每轮再问（期间可能导入了同样内容的文件）。编辑器进程答不上来时什么都不改。
- **补上了就去标记**：`ingestUnhashedMedia` 补上哈希时，名字带「(缺失) 」的去掉。
- **共享项目里不标**（〔裁 2〕）：`startTierBackfill(hooks)` 的 `hooks.shared()` 为真时两种都不标（带哈希的连问都不问）。
- **在线构建与只读页面**：`ingestUnhashedMedia`、`checkHashedMedia` 开头照旧直接返回，不改项目。
- 写回一律 `actions.updateMedia`（换新对象），单测断言旧对象没被原地改。

### 3. 放云端之后才补上哈希的素材进上传队列

**先核实**：改前不会全进。

- 视频：后台补入库走 adopt / upload 都带 `tiers=1`，服务端 `prepareImport` 在素材小尺寸转完后 `handToQueue`，**如果那时编辑器进程已经拿到上传目标**就进队；打开云端项目时上传目标是异步设的，赶不赶得上看时序。
- 图片、音频：`prepareImport` 对非视频直接返回，**永远不进队**（上面「需要主会话先看」第 2 条）。老项目里最典型的正是配音。

**补上的**：

- `assetTiers.ts` 新增 `queueBackfilledMedia(r, media, deps)`：`deps.shared()` 为真时等编辑器进程拿到带 rw 票据的上传目标（`whenUploadTargetReady`，缺省 30 s），把这次补上哈希的素材按哈希交给上传队列（复用 `enqueueExistingMedia`，图片、音频一档、视频两档；视频重复交无妨，队列按素材去重）；补不上的、队列回 `missing` 的用 `deps.notify` 列给用户，同一条素材一个页面会话里只列一次（后台检查每次素材表变化都会再跑）。不是共享项目、没有入队的口子（在线构建）、等不到上传目标（本机就是主机、签不到票据）都什么都不做。
- 新文件 `src/editor/sync/backfillUpload.ts` 把它接上：`shared = !!getSyncView().shared`；`notify` 用 0.7.9 放云端时的同一句话、同一种提示（`uploadMissingMessage` + `pushToast(…, "warn", Infinity)`）；入队用 `collab.ts` 的 `postEnqueue`（改成导出）。
- `Preview.tsx`：`startTierBackfill()` 改成 `startTierBackfill(backfillHooks)`。之所以绕一层而不在 `mediaUpload.ts` 里直接引同步层：`syncManager.ts` 在 Node 单测里加载不了（`online/mode.ts` 读 `import.meta.env`），io 也不该反过来依赖 sync。

## 〔裁〕

以下都是三级（机制；标记方式沿用现有「(缺失)」的显示），语义没写到、按任务书精神定的；用户合入前可推翻。

- **〔裁 1〕带哈希、本地内容库里没有字节的素材，打开本机项目时同样标「(缺失)」。** 理由见「需要主会话先看」第 1 条：验收探针 ② 的 `.proc` 素材都带哈希。只在本机项目里判：共享项目里本机没有是常态，读路由会向远程素材服务按需拉。
- **〔裁 2〕共享项目里不标「(缺失)」。** 标记写在项目的素材表里，会经文档服务同步给所有成员；一台机器取不到不代表别的成员取不到（尤其老素材只在它原来那台机器上）。共享项目里补不上的、放云端时照 0.7.9 的气泡列给用户。
- **〔裁 3〕「本机取不到」只认明确的否定回答。** 请求出错（编辑器进程不在）或取到了字节但入库失败都不标，避免因暂时故障把能用的素材清掉地址。
- **〔裁 4〕标记可恢复。** `path`、`hash` 都留着；补上哈希、或内容库里有了之后去掉名字前的标记、换回地址。改前 `restoreMediaUrls` 标的（死掉的 `blob:`、裸文件名）没有路径也没有哈希，不在此列。
- **〔裁 5〕放云端后补不上的提示，同一条素材一个页面会话里只弹一次。**

## 验证

跑测试和探针前都设了任务书给的 ffmpeg `PATH`。机器是笔记本（`LAPTOP-A56T03FK`，带耗时门槛项的基准机）；跑的时候同机还有别的会话在跑（CPU 占用开跑前约 60%）。端口只用了 6070～6087（预渲染进程由编辑器自己挑空闲端口）；dev server 带 `PROMPTCUT_NO_PORT_FILE=1`，探针的数据目录都在自己的临时目录。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 错误（最后一次在 `f52abb3c` 上） |
| 全量测试 | `npm test` | 退出码 0；tests 4212、pass 4210、fail 0、skipped 2、cancelled 0（`f52abb3c`；此前在 `ac734b6b` 上一遍 4210 / 4208 / 0 / 2） |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与基线一致（`vite-plugin-export.ts` 不在两个指纹的文件表里） |
| 本任务单测 | `node --test server/test/export-media-url.test.mjs` | 3 过 0 败（MP-E1～E3） |
| | `node --test src/editor/io/mediaPath.test.mjs` | 10 过 0 败（MP-M1～M6、MP-U1～U4） |
| | `node --test src/editor/io/tierBackfill.test.mjs src/editor/io/procp.test.mjs src/editor/media/enqueueExisting.test.mjs src/editor/media/uploadTarget.test.mjs` | 全过（0.7.9 的补入库、打包、入队相关用例不受影响） |
| 新探针 | `node scripts/probes/cross-machine-proc-probe.mjs --out <临时> --keep`（A 6070、B 6075、C 6080） | 退出码 0、`ok: true`、`fails: []` |
| 新探针对照 | 同上，但把 `server/vite-plugin-export.ts` 临时换回 main `8d3a22c5` 的版本（跑完即 `git checkout` 还原，没提交） | 退出码 1：`Video decode failed: /api/media/file?path=<A 的目录>…mp4`——探针确实能抓到改前的缺陷 |
| 往返探针 | `node scripts/probes/procp-roundtrip-probe.mjs --port-a 6082 --port-b 6085` | 退出码 0、`fails: []`；包里 project.proc + 3 份素材；B 三条 `/@media/<hash>` 200；导出老配音段 −24.5 dB / 440 Hz、新配音段 −24.6 dB / 880 Hz |

新探针的关键数（`f52abb3c`）：

- A：两条素材都带哈希，`path` 都在 A 的临时目录里；
- B：经上传接口放进去的两份字节哈希与 A 一致，`/api/media/local` 报两份都在；按 A 的路径读 `/api/media/file?path=…` 两条都是 403（改前导出按路径读必失败）；打开后两条按哈希还原、4 s 后仍没有「(缺失)」；导出页拿到的两条地址都是 `/@media/<hash>`；成片 h264 + aac 各 3 s；0.5 / 1.5 / 2.5 s 三个时刻的画面灰度标准差 63.6 / 63.9 / 63.5（有画面）；0.7～2.2 s 音频 −24.5 dB、440 Hz；
- C：打开后两条都变成「(缺失) …」、地址为空、哈希留着。

### G0-R（导出与预渲染的整套回归，主计划第 8 节）

脚本：`scratchpad/media-path/g0r-mp.sh`（照主会话的 `g0r.sh` 抄的，加了 `query-render-probe`、`video-source-cadence-probe`），dev server 6070（舞台 6071、6072），`ready-index` 6073、`query-render` 6076、`cadence` 6079。代码 `f52abb3c`。

| 项 | 结果 |
|---|---|
| `verify-determinism --url http://127.0.0.1:6070/?export=1` | 退出码 0，1800 / 1800 帧相同（632 s） |
| 与基准逐像素（`.worktrees/main-g0r/out/verify-a/frames`） | total 1800、identical 1800、different 0、missing 0、extra 0 |
| `verify-unified-frames --origin …6070` | PASS（含 exact video seek；这一项经 `/api/export`，走了改过的取素材路径） |
| `stream-produce-probe` | **第 1～3 遍都只挂一项耗时门槛**：「1080p 全幅流 15 帧分段编码 ≤ 300 ms（无别的编码器争 CPU）」p50 892 / 346 / 329 ms；其余断言全过。见下 |
| `stream-produce-probe --group` | 退出码 0、`fails: []` |
| `preview-fallback-probe` | 退出码 0、PASS |
| `preview-fallback-probe --page-preload` | 退出码 0、PASS，透明拍 0 |
| `ready-index-probe --port 6073` | 第 1 遍退出码 1（779 s，四条「超时」类：wanted 插队、区间长过锚帧等）；第 2 遍退出码 0、`fails: []`（179 s） |
| `query-render-probe --port 6076` | 退出码 0、`fails: []` |
| `video-source-cadence-probe --port 6079` | 退出码 0、`ok: true`（导出 34.7 s；这一项也经 `/api/export`，各段取帧序列与期望一致） |

关于 `stream-produce-probe` 那一项耗时门槛：

- 挂的只是编码耗时，门槛本身写着「无别的编码器争 CPU」。跑的时候同机有别的会话在占 CPU（开跑前整机占用 60%～62%，进程表里占用最多的是另外两个 `claude` 进程与 `msedgewebview2`）；三遍 892 → 346 → 329 ms 随负载变化。
- 本任务没有改到这条路径：`stream-produce-probe` 起的是预渲染进程的轨道流生产者，项目里没有素材；本分支改的服务端文件只有 `vite-plugin-export.ts`（`/api/export` 那一个路由），其余都是页面代码。
- 按 `verification.md`，笔记本上挂的耗时门槛不得判「机器差异」豁免；但这里的负载来自同机别的会话，不是机器本身。**请主会话在整机空闲时复核这一项**（或与 main 在同一负载下对照）。`ready-index` 的第 1 遍失败同属超时类，第 2 遍已过。

## 没做成的 / 没覆盖的

- 「放云端」那一处没有端到端验证（要托管端与 rw 票据，探针没搭）；覆盖到的是 `queueBackfilledMedia` 的单测（MP-U1 用真的 `startTierBackfill` + 假编辑器进程 + 真的上传目标状态机走了一遍）和 `backfillUpload.ts` 的类型检查。
- 标了「(缺失)」、只有路径的**视频**，导出时服务端照旧按 `path` 改写地址（任务书要求没哈希时退回按路径读），在取不到文件的机器上导出仍会「Video decode failed」——与改前相同，不是新问题。音频取不到时合成音轨那一步本来就跳过。要不要让导出尊重「地址为空 = 跳过」，见「需要主会话决定的事」。

## 更正建议

- 任务书第 2 条与验收探针 ② 不一致（一个说只有路径的，一个用的是带哈希的素材），本任务按两者都做（〔裁 1〕）。
- TODO 里这一条写的「改成有哈希就走 `/@media/<hash>`」已按素材原尺寸哈希（`tiers.original` 优先）做，与导出拦截认的哈希一致。

## 语义的 dry run（没有改语义文件）

「打开项目时素材找不到怎么显示」现在语义里没有写。建议补一句（二级，`product/asset-service.md`「本地内容库」一节末尾，或一级 `workflow/project.md`「打开」那条下面，由主会话定放哪本）：

- 修改前：（无）
- 修改后：「打开 `.proc` 时，素材按内容哈希在本地内容库里找回；本地没有这份字节、或老素材按原路径也取不到的，素材表里标『(缺失)』，预览和导出跳过它，换回有这些字节的环境后自动恢复。共享项目里不标，缺的素材由上传方补传。」

对应的三级（`mechanism/asset-service.md`）：「只认明确的否定回答；请求出错不判缺失」「放云端时后台补上哈希的素材按哈希交给上传队列」。

## 需要主会话决定的事

1. 合并 `claude/media-path`，还是返工；合并前请在整机空闲时复核 `stream-produce-probe` 的编码耗时门槛。
2. 〔裁 1〕～〔裁 5〕是否认可；语义 dry run 要不要写、写进哪本。
3. 是否另开一项修「放云端项目里新导入的图片、音频不进上传队列」（`server/media-tiers.mjs` 的 `prepareImport` 非视频不 `handToQueue`；或在页面导入完成后按哈希入队）。
4. 是否让导出尊重「没有哈希、地址为空 = 已标缺失，跳过」，免得标了「(缺失)」的老视频在导出时仍按路径读、解码失败。

## 主会话审查（2026-10-01，笔记本主会话）

- 审过导出的 `normalizeExportMedia`（有合法哈希走 `/@media/<素材原尺寸哈希>`，没有才按路径）、打开后的缺失判定（只认明确的否定回答）、`queueBackfilledMedia` 与 `backfillUpload.ts`。〔裁 1～5〕照留，待用户审。
- 更正（`claude/maint-4` 指出）：本报告「做了什么」第 2 节写的「地址清空（预览、导出跳过）」对导出不成立——导出并不跳过空地址的素材层，跳过改由 `claude/maint-4` 的 `dropSkippedMediaClips` 负责。
- 流式编码门槛在本分支三遍都超是机器负载所致（开跑前整机 CPU 约 60%）：主会话在集成分支 `claude/r10-merge` 的空闲机器上复核，见 `docs/reports/REPORT-post-M8.md` 第 10 轮。
- 采纳三级语义（判缺失只认明确的否定回答、放云端后入队），`mechanism/asset-service.md`（`f1050002`）；二级那句（打开项目时标缺失、导出跳过）列给用户定。合入 main `f454490d`。
