# AGENT-maint-4

分支 `claude/maint-4`，worktree `.worktrees/maint-4`，起点 `claude/media-path` 的 `a4538834`（main 之上加了「导出按哈希取素材、只有路径又取不到的素材标缺失、放云端后补上哈希的素材进上传队列」，报告 `docs/reports/AGENT-media-path.md`）。三件维护项：

1. 部署时给在线构建的静态资源预压缩（`.gz`）；
2. 放云端之后新导入的图片、音频也进上传队列；
3. 标了「(缺失)」、只有路径的老视频，导出时跳过它所在的片段并提示，不再整次导出失败。

## 需要主会话先看的

- **没有改语义文件，也不需要改二级语义。** 三项都在现有语义之内；〔裁〕都是三级（机制），见「〔裁〕」。
- **第 3 项比任务书多做了一步**：任务书说「对没有哈希、地址为空的素材跳过这一段」，实测只把地址留空不够——导出页照样给它挂一个 `<video data-pc-media-src="">`，逐帧取素材时 `Video decode failed:  (4)`，整次导出仍然失败（对照实验见「验证」）。所以预渲染进程收到导出请求时，**从这次导出自己的那份项目 JSON 里去掉引用缺失素材的片段**（〔裁 3〕），没动渲染代码，代码指纹不变。
- 媒体路径报告里「(缺失) = 地址清空（预览、导出跳过）」这句话对导出不成立（见上），建议该报告归档时加一句更正。

## 状态

完成，等主会话审查。类型检查 0 错误；`npm test` 4218 项、失败 0、跳过 2；代码指纹不变；新探针、扩展后的探针都退出码 0、`fails: []`，两者都做了改前对照（改前都失败）；G0-R 全套退出码 0，导出像素基线 0 不同、0 缺失。

## 提交

| 提交 | 内容 |
|---|---|
| `ca4cf823` | 文档：建本报告 |
| `bf26a3c8` | 部署：`deploy-hosted --editor` 在本机暂存目录里给 `assets/` 生成 `.gz`，换代保留上一代时 `.gz` 随原文件一起补；单测 DEP-5、DEP-6；迁移文档补 `gzip_static` |
| `77a1a374` | 修复：`prepareImport` 对图片、音频也把素材原尺寸交给上传队列；单测 T2-3（改前失败、改后通过） |
| `36e78774` | 探针：`shared-import-upload-probe.mjs`（放云端后导入图片与音频，成员取得到） |
| `e2c911a7` | 修复：导出跳过缺失老素材所在的片段并在完成对话框里列出；单测 MP-E4～E6；`cross-machine-proc-probe.mjs` 加第 4 步 |

用例编号：DEP 是部署脚本（`server/test/deploy-editor.test.mjs`），T2 是两档素材与上传队列（`server/test/media-tiers.test.mjs`），MP-E 是导出取素材（`server/test/export-media-url.test.mjs`）。

## 1. 部署时预压缩在线构建的静态资源

改动：`server/hosted/deploy.mjs`、`scripts/remote/docservice.mjs`、`server/test/deploy-editor.test.mjs`、`docs/plan/hosting-migration.md`。**没有连服务器、没有部署。**

- `deploy.mjs` 新增 `precompressAssets(assetsDir)` 与 `stageEditorBuild(srcDir, outDir)`：把 `dist-online/` 原样拷进本机暂存目录，给 `assets/` 下（含子目录）**大于 1 KB**、扩展名为 `.js .mjs .css .json .svg .wasm`（不分大小写）的文件生成同名 `.gz`，`zlib` 最高级别（`Z_BEST_COMPRESSION`），`.gz` 的 mtime 与原文件相同。源目录不动。
- `docservice.mjs deploy-hosted --editor`：原先直接从 `dist-online/` scp；现在先 `stageEditorBuild(editorDir, <暂存>/.incoming-editor)`，打一行「预压缩 N 个 assets」，再从暂存目录 scp 成远端的 `.incoming-editor`（暂存目录在 `finally` 里删掉，与服务端文件的暂存同一个目录）。
- `editorSwapLines()`（远端换代脚本）：
  - `.assets-own` 本来就是 `find assets -maxdepth 1 -type f` 列出的本代所有文件，`.gz` 自然在清单里，下一代照样随清单补回——**原逻辑对 `.gz` 已经成立**；
  - 另加一条：补上一代某个原文件时，它旁边若有同名 `.gz` 也一起补。这是为了**第一次**用新脚本换代时：服务器上现有那一代的 `.gz` 是主会话手工生成的，不在那一代的 `.assets-own` 里，不加这条就会丢，旧页面刷新前取旧脚本会退回动态 gzip。
- 迁移文档第 2 节第 1 步的 nginx 那条补上：两份站点配置的 `location ^~ /editor/assets/` 要有 `gzip_static on;`，部署会生成 `.gz`；原因（分块传输在部分 Chrome 配置下让入口脚本卡死）指向 `docs/archive/agent-reports/AGENT-nav-hang.md`。

证据：`node --test server/test/deploy-editor.test.mjs server/test/c10-deploy-stage-origins.test.mjs server/test/sp-hosting.test.mjs` → 23 过 0 败 0 跳过。

- DEP-5：六种扩展名各一个 4 万字节的文件 + 大写 `UP.JS` + 子目录里的 5000 字节随机 `.wasm` 都有 `.gz`，逐个 `gunzip` 后与原文件逐字相同；`a-x1.js.gz` 与 `zlib.gzipSync(…, { level: 9 })` 逐字相同；恰好 1024 字节的 `.js`、`.png`、`.woff2`、`catalog/` 下的 `.json` 都不压；其余文件原样拷过去；源目录不变。
- DEP-6（Git Bash 真跑换代脚本四次）：v0（清单里没有 `.gz`，之后手工补一个 `.gz`）→ v1：v0 的原文件与手工 `.gz` 都补上；v1 的 `.assets-own` 含本代两个 `.gz`、不含补进来的 v0；→ v2：v1 的 js 与 `.gz` 保留一代、v0 的不再保留，同名 `.gz` 用新版；→ v3：只剩 v2 一代。

## 2. 放云端之后新导入的图片、音频进上传队列

改动：`server/media-tiers.mjs`、`server/test/media-tiers.test.mjs`、新探针 `scripts/probes/shared-import-upload-probe.mjs`。

**先核实**：新用例 T2-3 在改前的 `media-tiers.mjs` 上跑，失败于「still.png 在远端 complete」——连着远程素材服务导入的 PNG、MP3 没进上传队列。

**修法**：`prepareImport` 原先对非视频直接返回；现在先 `handOriginalToQueue(stored)`：把素材原尺寸一档交给上传队列（`{ name, tiers: [{ tier: 'original', hash, ext }] }`），不登记进两档转码状态。队列本身不变：连本机素材服务时（`target()` 为 null）入队是空操作，所以本机项目行为不变（T1-4、T3-2 照过）；连远程时传过去。视频的两档逻辑一行没动。

覆盖到的导入入口：页面导入与后台补入库（`?tiers=1`）、Agent 的配音与素材收集（`server/media-ingest.mjs` 缺省带 `tiers`）。**没覆盖的**：`.procp` 拆包（`procp.ts` 不带 `tiers`，打开包时还不是共享项目）、声音复刻的源文件（不进项目）。

证据：

- T2-3：改前失败、改后通过；`node --test server/test/media-tiers.test.mjs` 全部通过（在 `npm test` 里）。
- 探针 `node scripts/probes/shared-import-upload-probe.mjs --out <临时> --keep`（托管组合 6120/6121、A 6110、B 6115）：退出码 0、`fails: []`。
  - 托管组合**关掉本机信任、带随机集群令牌**（与阿里云同一种布置，回环读写也要票据）；
  - A 以创建者进入后，上传目标 = `http://127.0.0.1:6121/api/asset`；经素材库文件输入导入 PNG（320×240）与 MP3，两条都带哈希；A 的上传队列 `enqueued 2、done 2、failures 0、skippedLocal 0`；
  - 托管端管理接口按哈希取回两份字节，sha256 与本机一致（200 / 200）；
  - B 开始时本地内容库里没有这两份（`/api/media/local` 为空）；以成员进入后素材表同步来两条（同一哈希）；`/@media/<hash>` 经 B 的编辑器进程向托管端取到 8946 / 33095 字节、sha256 一致；B 页面里这张图片解码为 320×240。
- 探针对照：把 `server/media-tiers.mjs` 临时换回改前版本再跑（跑完即 `git checkout` 还原，没提交）：退出码 1——「等不到：A 的上传队列清空」「托管端素材服务里有 image/audio 的同一份字节（404）」「B：/@media/<hash> 取到…（404）」「B：图片解码（失败）」。

## 3. 缺失的老视频导出时跳过这一段并提示

改动：`server/vite-plugin-export.ts`、新文件 `src/editor/io/exportSkipped.ts`、`src/editor/io/index.ts`、`src/editor/TopBar.tsx`、`src/editor/ExportDialog.tsx`、`server/test/export-media-url.test.mjs`、`scripts/probes/cross-machine-proc-probe.mjs`。

- 预渲染进程 `/api/export`：
  - `normalizeExportMedia` 回 `{ skipped }`：**没有合法哈希、地址为空、不是上传中（`pending`）** 的素材——打开项目后本机取不到文件、已标「(缺失)」的老素材——地址留空，不再改成 `/api/media/file?path=…`，列进 `skipped`；
  - 新函数 `dropSkippedMediaClips(project, skipped)`：从这次导出的项目 JSON 里去掉引用它们的片段，回真的被去掉了片段的素材（带片段数）；没有片段引用的缺失素材不影响导出，不列；
  - 回包多一个 `skippedMedia: [{ id, name, clips }]`，并打一行 `[export] 跳过缺失素材所在的片段:…`。
- 页面：`exportVideo` 把回包的 `skippedMedia` 带到结果里；顶栏导出完成时用 `exportSkippedMessage` 拼成一句话写进导出对话框的 `message`；对话框在「导出完成」下面用错误的红字（`pc-export-err`，`data-pc="export-skipped"`）列出——与打包保存列缺素材的写法一致（名字去重、去掉「(缺失) 」、超过 12 条截断）。
- 带哈希、本地内容库里没有字节的缺失素材不在本项范围：照旧按哈希走、由现有的「素材原尺寸没到齐」拦截提示。

证据：

- 单测 MP-E4～E6 通过；MP-E2 里原来那条「地址为空 + path → 按路径读」的断言改成「有地址 + path」（旧断言描述的正是这次要改掉的行为）。
- 探针 `node scripts/probes/cross-machine-proc-probe.mjs --port-a 6110 --port-b 6115 --port-c 6120 --out <临时> --keep`：退出码 0、`fails: []`。原有第 1～3 步照过（B 导出画面标准差 63.6 / 63.9 / 63.5、440 Hz −24.5 dB；C 两条标「(缺失)」、地址清空）。新第 4 步（在实例 C 里）：
  - 项目：C 导入的视频 0～3 s、C 入库的 660 Hz 音频 0.5～2.5 s、老形态只有 `path`（A 的文件）的视频 1～2 s；后台检查把老视频标成「(缺失) old-clip-….mp4」、地址为空、没有哈希；
  - 从顶栏「导出视频」导出（去掉 `showSaveFilePicker`，走「留在产物目录」那条兜底路）：对话框标题「导出完成」，红字「下面 1 条素材本机找不到文件（素材库里标着「(缺失)」），导出时跳过了它们所在的片段，其余画面与声音照常：· old-clip-….mp4」；
  - 成片 h264 + aac 各 3 s；0.5 / 1.5 / 2.5 s 画面灰度标准差 63.6 / 63.9 / 63.5；0.7～2.2 s 音频 −24.5 dB、660 Hz；导出用的 `project.json` 里引用老视频的片段 0 个、老视频地址为空。
  - 看过的图：`D-export-dialog-*.png`（完成对话框在中间，红字列出被跳过的素材，时间轴上「老视频」序列那一段还在——只是导出时跳过，不改用户的项目）。
- 对照 1：`server/vite-plugin-export.ts` 换回改前版本：退出码 1，对话框「导出失败」`Video decode failed: /api/media/file?path=…A\out\media\….mp4 (4)`。
- 对照 2：只把地址留空、**不去掉片段**（临时改一行，跑完还原）：仍退出码 1，`Video decode failed:  (4)`——导出页对空地址照样挂 `<video data-pc-media-src="">`、取帧时报错。这就是〔裁 3〕的依据。

## 〔裁〕

都是三级（机制），语义没写到的细节；用户合入前可推翻。

- **〔裁 1〕预压缩在本机暂存目录里做，不在远端做。** 远端只换名，不依赖远端有 gzip、不拖长换代窗口；逻辑在 Node 里、能在本机单测。代价是 scp 多传一份 `.gz`（在线构建 js 约 4 MB，`.gz` 约 1.3 MB）。
- **〔裁 2〕换代补上一代原文件时，同名 `.gz` 一并补**（即使不在上一代清单里），见第 1 项。
- **〔裁 3〕缺失老素材在导出里「跳过这一段」= 从这次导出自己的项目 JSON 里去掉引用它的片段**，而不是改导出页的渲染代码去认空地址。理由：只留空地址导出照样失败（对照 2）；改 `src/render/` 会动代码指纹、G0-R 基线；去掉片段对别的层没有影响（那一层本来就画不出东西，玻璃遮罩帧也只按有来源的素材层算）。用户的项目不改。
- **〔裁 4〕只列真有片段被去掉的缺失素材**；素材库里有但没上时间轴的缺失素材不影响导出，不提示。上传中（`pending`）的不算缺失，行为不变。
- **〔裁 5〕提示放在导出完成对话框里**（红字），与打包保存「包里缺哪些素材」同一种写法；不另弹窗。

## 验证

跑测试和探针前都设了任务书给的 ffmpeg `PATH`。端口只用了 6110～6129（预渲染进程由编辑器自己挑空闲端口）；手动起的 dev server 带 `PROMPTCUT_NO_PORT_FILE=1`，探针的数据目录都在自己的临时目录。只结束了自己起的进程。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 错误（`e2c911a7`） |
| 全量测试 | `npm test` | 退出码 0；tests 4218、pass 4216、fail 0、skipped 2、cancelled 0（`e2c911a7`） |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，不变 |
| 部署单测 | `node --test server/test/deploy-editor.test.mjs …c10-deploy-stage-origins… …sp-hosting…` | 23 过 0 败 0 跳过 |
| 第 2 项探针 | `shared-import-upload-probe.mjs` | 退出码 0、`fails: []`；改前对照退出码 1 |
| 第 3 项探针 | `cross-machine-proc-probe.mjs --port-a 6110 --port-b 6115 --port-c 6120` | 退出码 0、`fails: []`；改前对照、只留空地址对照都退出码 1 |

### G0-R

脚本照 `claude/media-path` 的 `g0r-mp.sh`（临时目录里，不入库）：dev server 6110（舞台 6111、6112），`ready-index` 6113、`query-render` 6116、`cadence` 6119。代码 `e2c911a7`。同机有别的子 Agent 在跑压测，带耗时门槛的项只作参考。

| 项 | 结果 |
|---|---|
| `verify-determinism --url http://127.0.0.1:6110/?export=1` | 退出码 0，1800 / 1800 帧相同（516 s） |
| 与基准逐像素（`.worktrees/main-g0r/out/verify-a/frames`） | total 1800、identical 1800、different 0、missing 0、extra 0 |
| `verify-unified-frames --origin …6110` | 退出码 0，PASS（含 exact video seek；经 `/api/export`，走了本分支改过的导出取素材路径） |
| `stream-produce-probe` | 退出码 0、`fails: []`、PASS（编码 p50 260 ms，门槛 300 ms，本次过了；参考值） |
| `stream-produce-probe --group` | 退出码 0、`fails: []`、PASS |
| `preview-fallback-probe` | 退出码 0、PASS |
| `preview-fallback-probe --page-preload` | 退出码 0、PASS |
| `ready-index-probe --port 6113` | 退出码 0、`fails: []`（101 s） |
| `query-render-probe --port 6116` | 退出码 0、`fails: []`（186 s） |
| `video-source-cadence-probe --port 6119` | 退出码 0、`ok: true`（导出 12.5 s，各段取帧序列与期望一致） |

## 没做成的 / 没覆盖的

- 第 1 项没有在服务器上验证（任务书禁止连服务器）；nginx 实际是否取 `.gz` 由主会话部署后用 `curl -sI -H 'Accept-Encoding: gzip' …/editor/assets/<入口>.js` 看 `Content-Encoding: gzip` 与 `Content-Length` 核对。
- 第 2 项：打开云端项目时上传目标是异步设上的，**目标设好之前**导入的素材入队时队列看到的是本机目标，会被当作空操作丢掉（视频同样，`claude/media-path` 报告已提过时序问题）。本任务没有改这个时序。
- 第 3 项只处理「没有哈希、地址为空」的；卡片参数里直接引用的素材地址（例如聚焦卡的 `camSrc`）不经素材表，不在此列。

## 更正建议

- `docs/reports/AGENT-media-path.md`「做了什么」第 2 节写「地址清空（预览、导出跳过）」：导出并不跳过空地址的素材层（本报告对照 2），建议归档时注明，改由本分支的 `dropSkippedMediaClips` 负责跳过。

## 语义的 dry run（没有改语义文件）

可选，建议补进 `mechanism/asset-service.md`（三级）：

- 修改前：（无）
- 修改后：「打开项目后标了『(缺失)』、没有哈希的老素材，导出时不按原路径读：这次导出跳过引用它的片段，导出完成时列出这些素材。」

## 需要主会话决定的事

1. 合并 `claude/maint-4`，还是返工。
2. 〔裁 1〕～〔裁 5〕是否认可；语义 dry run 要不要写。
3. 第 1 项合入后部署时：确认两份站点配置都有 `gzip_static on;`，部署后核对入口脚本带 `Content-Length` 发。
4. 是否另开一项处理「打开云端项目后、上传目标设好之前导入的素材不入队」的时序缺口。
