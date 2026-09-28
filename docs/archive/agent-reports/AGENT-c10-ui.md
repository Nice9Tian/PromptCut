# AGENT 报告：claude/c10-ui

分支 `claude/c10-ui`，从 `claude/c10-integ` 的 `e067d0b` 拉出；工作区 `.worktrees/c10-ui`；端口段 5700～5709。
任务：C10 契约（`docs/plan/c10-contract.md`，C10 = 在线浏览器模式普通档的其余部分）第 9、10、11、19 节，加第 18 节第 4、6 条（主会话派活前补的裁定：备份怎么下载、用户卡图卡的豁免放在哪），以及交接文件 `HANDOFF-2026-09-27-pc.md` 第 4 节最后一条（在线页面仍直接用 `media.url` 的几处）。

状态：做完，验证全过（见第 3 节），等主会话审。

## 1. 做了什么

### 1.1 用户卡与图卡（契约第 9 节 + 第 18 节第 6 条）

- **选帧与投递豁免**（`src/editor/snapshotFeed.ts`，改动集中在一处）：新导出 `exemptOnline(clip)`，判法与舞台同一个（`placeholderHost` 的 `needsLocalPc`），开关沿用 `setOnlineBrowserMode`。`planFeed` 里判重之后加一行 `if (exemptOnline(clip)) continue;`：在线时这些层不进 `heavy`（不抑制）、不选帧、不报缺口，`deliverSnapshots` / `pickForSetTime` 也就不为它们取字节。桌面开关恒为假，照旧。
- **父页的开关**：`src/editor/Preview.tsx` 模块顶层 `setOnlineBrowserMode(ONLINE || ?platform=browser)`，与 `StageView` 同一判据（原来只有舞台设它）。
- **在线快照来源也不取**：`src/render/snapshotSource.ts` 的 `OnlineSnapshotDeps` 加可选 `skipLayer(clipId)`，`loadWindow`（取清单）与 `prefetchWindow`（预取 `px/`）跳过被点名的层；`Preview` 按 `exemptOnline` 传入。没有这一条的话，层表里有用户卡那一层时，预取仍会拉它的字节（契约第 18 节第 6 条只说了选帧与投递，预取是同一件事的另一条路，一并堵上）。
- **时间轴徽标**（`src/editor/timeline/ClipView.tsx`、`src/skins/skins.css`）：`unsupportedHere` 为真的片段在右上角挂「电脑 + 离线」小徽标（`data-pc="clip-custom-card"`），`title` 为「该模式暂不支持自定义卡」。鼠标按下照样冒泡到片段，选中、移动、删除、改参数都不挡。
- 「该模式暂不支持素材输入的音频图卡」代码里本来就没有；`docs/plan/c10a-contract.md` 表 C 那一行注明「已由 C10 第 9 节取消」。
- **音频图卡在线不求值**（`src/audio/cardAudio.ts` 的 `generatedCardAudioClipsAt` 在线回空；`src/render/cards/audioSources.ts` 在线不发 `/@media/<hash>/pcm`）：`/pcm` 是编辑器进程的 ffmpeg 接口，远程素材服务没有；图卡在这台设备上本来就渲染不了。这一段的原生声音照旧被 `shouldMuteNativeAudio` 静掉，不拿素材声音顶上。

### 1.2 置灰（契约第 10 节）

文案统一走 `src/online/pageFlag.ts` 的 `onlineUnsupported(入口名)` =「在线浏览器模式暂不支持{入口名}，请在电脑上的 PromptCut 里使用。」（表 A）。原来的 `ONLINE_UNSUPPORTED`（「…请在桌面版里做」）与 `TopBar` 的 `ONLINE_OFF` 都换成点名的新文案。点了不发请求：按钮 `disabled`，处理函数里再判一次。

| 入口 | 位置 | 做法 |
|---|---|---|
| 导入媒体 | 素材库「导入媒体」、空组的「导入…」、口播选择器「从本地文件导入」 | 置灰 + 表 A |
| 语音识别 | 素材右键、片段右键「转写字幕」（已有字幕的「查看字幕」照常）、字幕分区「重新转写」、转写面板 | 置灰 + 表 A；转写面板在线不查引擎状态（原来露红字报错），只给一个置灰的「开始转写」 |
| 配音 | 顶栏「配音设置」、标题栏菜单「配音设置…」命令 | 置灰 + 表 A；标题栏命令在线不做 |
| 镜头检测与跟踪、网页采集 | 编辑界面里没有手动入口（只有 MCP 与开始页，在线都到不了） | 镜头标记在线不取 `/api/shots/thumb/` 缩略图（`<img>` 请求守卫拦不到），只画竖线 |
| 建卡与改卡 | 没有手动建卡 / 改源码的界面；自定义卡右键「转换为自定义素材 / 收归本项目」 | 置灰 + 表 A（「改卡」） |
| AI 栏 | C10a 已换成占位 | 占位文字换成表 A |
| 其它 | SKILL 模式（ModeSwitch）；标题栏的新建 / 打开 / 保存 / 合并命令（菜单项已置灰，命令绕过了它） | SKILL 置灰 + 表 A；四个命令在线不做 |

`/api` 棘轮：在线构建产物里的 `/api/` 路径 120 个，清单 120 个，多出 0、少了 0（见第 3 节）。本期没从清单里删路径：这些入口都是置灰，调用代码仍在产物里。

### 1.3 离线提示（契约第 10 节 + 第 17 节表 A）

- **顶栏五条措辞**（`src/editor/sync/onlineStatus.ts` 纯函数 + `SyncChips.tsx`，只在在线页面）：断网（`navigator.onLine` 为假）、连不上文档服务、连不上素材服务、恢复中、恢复完成，一字不差照表 A。「同步已暂停」照旧用 C6.5 的小部件。桌面仍是原来的「离线」小部件，不变。
- **HT-a 会话接续期间不闪**：传输断了在会话层里接续，DocSync 看不见，状态本来不变；另外离线类措辞要持续 1.5 秒才出（`OFFLINE_SHOW_DELAY_MS`，三级数字）。探针实测：断开后 7 秒内顶栏什么都不显示，62 秒会话结束后才出「连不上服务器…」。
- **恢复中 / 恢复完成**：`syncManager` 在在线页面每 500 ms 看一眼 DocSync 的 `unconfirmed`（它没有这个事件），按 `nextRecovery` 状态机算阶段；「恢复完成」显示 4 秒。暂停（第一条被拒）之后交给 C6.5 的离线对话框，不论重放还是丢弃都不再报「已全部提交」（第一轮探针发现丢弃后误报，已修）。
- **连不上素材服务**：`assetTiers.ts` 的 `askComplete` 记下一轮对账是否全是网络错误（4xx/5xx 不算），素材全到齐时每 5 轮顺带问一张已到齐的原片探活（`remoteAssetsDown` / `subscribeRemoteAssetsHealth`）。
- **常驻提示**：离线且有未提交的修改时，底部状态栏上方居中常驻「当前离线，有未提交的修改。关闭页面将丢失这些操作。」（放顶上会盖住顶栏的状态措辞，第一轮截图发现后挪到底部）；离线或暂停且有未提交时挂浏览器原生的离开确认（`beforeunload`）。

### 1.4 本地备份（契约第 10 节 + 第 18 节第 4 条）

- `src/editor/sync/onlineBackups.ts`：`createOnlineBackups({ download, projectName })` → `save(backup)`、`list()`、`download(i)`、`subscribe(cb)`。只进内存，不碰 localStorage / sessionStorage / IndexedDB，不自动下载，关页面即丢；下载是 Blob + `<a download>` 的 JSON 文件（内容是 `LocalBackup` 原样加项目名）。工厂名与方法名取的是 `c10-kit.mjs` K10 候选表里的第一个。
- `syncManager` 的 `saveBackup` 在线时：存进内存；被覆盖 → 一条 10 秒自己消失的气泡，带「下载备份」按钮，不打断操作；丢弃离线修改 → 气泡留到用户关，带「下载备份」。气泡（`Toast`）加了可选的 `action` 按钮；`pushToast` 的时长给 `Infinity` 不自己消失。
- **同步面板**：在线页面顶栏同步小部件里有备份时出现「备份 N」，点开列出本页内存里的全部备份、逐个「下载备份」；「项目」菜单「本地备份…」在线时也打开同一个列表（原来在线置灰）。桌面的备份对话框（写草稿目录、能恢复）不变。
- C6.5 的离线对话框、`docsync.ts` 没改，在线与桌面共用。

### 1.5 预留接口（契约第 11 节）

- 素材服务 `POST merge/<projectId>/<共享键>` 回 501 `{ ok: false, error: "not-implemented" }`（`server/asset-service.ts` 的 `isAssetMergePath` / `answerMerge`，中间件最前面答掉）；不解析 `projectId`、不读请求体、不碰数据层；别的方法 405，带 CORS 头。不进同源守卫的豁免正则。单测一条（`server/test/asset-service.test.mjs`）。
- `cloud-task.md` L5 第 2 条对齐 R8 的 `StreamSource`（`manifest` / `init` / `segment`），第 3 条改指 `docs/plan/direct-connect-plan.md`，文档服务不加 `peer.*`（组件表那一行、「不做」那一条同步注明）。

### 1.6 计划文档勘误（契约第 19 节）

- `TODO.md`：R8（`787f7d9`）、R9（`eff2011`）标已合入。
- `cloud-task.md`：「读法」改现状；A3b 加现行键形 `<resultKey>:<from>-<to>`、环境指纹进结果键与卡片级指纹锁（M4）；L1 注「并入 M7」，节拍改「父页判空闲、舞台 `setTimeout` 逐帧；页面隐藏就停」；L3 注「页面不算键，按层表」；L5 按上一节；L5 出处改 `mechanism/platforms.md`；L 节验收按第 8、9 节改（两条移到 M7、音频图卡一条删去）。
- `Master-Execution-Plan.md` 第 7 节：C10 其余的验收注明上面的改动、以契约第 20 节为准；M7 验收补「一批 = 一帧」「界面不加后台提示」（L1 的两条原已并入）。

### 1.7 在线页面仍直接用 `media.url` 的几处（交接文件第 4 节末条）

新增 `src/render/mediaTier.ts` 的 `originalMediaUrl(media)`：桌面原样 `media.url`；在线是远程素材服务上的原尺寸（带只读票据），远程还没就绪给 ""。

| 地方 | 改法 |
|---|---|
| 素材右键「按素材比例设画幅」量尺寸（只在素材没记下宽高时） | 走 `originalMediaUrl`：量的必须是原尺寸，走 `previewMediaUrl` 会量到小尺寸、把画幅设小。低内存档平时不拉原尺寸，不量，照实提示 |
| `procp.ts` 打包保存 | `packProcpFrom` 加可选的取地址函数，`packProcp` 传 `originalMediaUrl`（包里要原尺寸）。在线菜单里打包保存本来就置灰 |
| 卡片里用的素材（`src/render/cards/mediaSource.ts`） | 走远程原尺寸（画进画布、导出都要原尺寸）；图卡在线预览里本来不挂 |
| 卡片声音的 `/pcm` | 在线不取（见 1.1） |
| `SpeakerPicker` | **没改成取字节的地址**：它交出去的 `m.url` 是写进项目的素材身份（`/@media/<hash>`），换成带票据的远程地址会把会过期的票据写进项目、别的成员用不了。只把它的「从本地文件导入」置灰（见偏离第 2 条） |

## 2. 提交

| 提交 | 内容 |
|---|---|
| `7e73566` | 报告开工 |
| `bbbac77` | 素材服务 `POST merge/…` 回 501 + 单测 |
| `3369ed8` | 用户卡、图卡的选帧与投递豁免，在线快照来源 `skipLayer`，单测 |
| `5db20c0` | 离线措辞、常驻提示、离开确认、内存备份与下载、同步面板、时间轴徽标与文案常量，单测 |
| `85c0515` | 置灰各入口，AI 占位文案，镜头标记，原尺寸地址（量尺寸、打包、卡片素材），音频图卡在线不求值 |
| `2b4ba49` | 计划文档勘误 |
| `cb6f807` | 暂停后不报「已全部提交」、常驻提示只在真离线时出；验收探针 `scripts/probes/c10-ui-probe.mjs` |
| `2b349a4` | 徽标挪到右上角、常驻提示挪到底部、置灰的导入入口加暗；探针修正 |

## 3. 验证

全部在笔记本（性能基准机）上跑，G0-R 除外（见最后一行）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test`（带 ffmpeg 的 PATH） | 最后一次：tests 3402，pass 3400，fail 0，skipped 2（`集成:/api/cards/layout` 要 5190 的 dev server，另一条同基线）；其中 `C10A-API-03` 棘轮通过 |
| 桌面构建 | `npm run build` | 退出码 0 |
| 在线构建 | `npx vite build --mode online --outDir <scratchpad>/online-dist` | 退出码 0 |
| `/api` 棘轮 | 用 `c10a-kit.mjs` 的 `apiPaths` 对在线产物 | `{"built":120,"list":120,"extra":[],"gone":[]}` |
| 新单测 | `snapshotFeed.test.mjs`（在线豁免）、`onlineSnapshotSource.test.mjs`（`skipLayer`）、`src/editor/sync/onlineSync.test.mjs`（表 A 措辞、状态机、备份只进内存、不自动下载）、`asset-service.test.mjs`（merge 501） | 全过（含在全量里） |
| C10-A6、A7、A8 | `node scripts/probes/c10-ui-probe.mjs --dist <在线构建> --out %TEMP%\c10-ui-shots`（本机托管组合 + 两个 nginx 形状的代理 + 无头 Chrome 1600×900，在线构建，两个成员） | 退出码 0，`ok: true, fails: []`，数字见下 |
| 低内存档回归 `lowmem-online-probe` | 在线模式 dev server 5700，替身素材服务 5707 | 退出码 1，唯一失败 G3「暂停后贴小尺寸」；**在基线 `e067d0b` 上同样失败**（见第 5 节第 1 条），不是本分支带来的；G1、G2、G4、G5 过 |
| 低内存档回归 `small-tier-probe` | 桌面 dev server 5700 | 退出码 0，`fails: []`；S1 60 帧 HTML + 60 张 400×225 小位图，S2 `bad 0`，S4 `htmlDiff 0` |
| G0-R | 主会话交 PC 跑（提交 `2b4ba49`） | `verify-determinism` 退出码 0，1800 / 1800 相同；与 PC 自己的 main `d70fce7` 基准帧逐像素比较 `total 1800, identical 1800, different 0, missing 0, extra 0`。在 PC 上跑、基准是 PC 自己的帧，用时不作性能验收。之后的 `cb6f807`、`2b349a4` 只动编辑界面的同步小部件、CSS 与探针，没碰渲染路径 |

**C10-A6～A8 探针数字**（最后一次，`probe7`）：

- A6：层表里用户卡那一层 `px/` 请求 **0**、就绪帧 0（清单没取）；对照的内置卡那一层 `px/` 请求 183、就绪帧 120；选帧里没有用户卡；时间轴徽标只在用户卡片段上，`title` =「该模式暂不支持自定义卡」；舞台里 1 个常驻占位，文字「需要本地 PC 渲染辅助」；片段点得选中；改参数、移动后另一成员看到 `start 0.5`、`text "c10-ui 改过"`。
- A7：导入媒体、配音、SKILL、片段右键「转写字幕」都 `disabled`，`title` 是表 A 文案；AI 占位是表 A 文案；点一遍后新请求 0（素材服务的对账轮询除外）、页面错误 0；被覆盖气泡带「下载备份」，点前下载 0 份、点后落盘 1 份 JSON；断开后 7 秒内顶栏无状态（不闪），62 秒出「连不上服务器…」，常驻提示在，`beforeunload` 被拦；`setOfflineMode` 后「当前没有网络连接。」；恢复后第一条被拒 → 离线对话框 →「不要了」→ 气泡带「下载备份」（点前没有自动下载），下载出 `offline-discard`、2 步的 JSON；之后没报「已全部提交」；「备份 2」面板列 2 行，两个按钮各发起一次下载（`<a download>` + `blob:`；无头 Chrome 对同一页面第三次起的下载要「允许下载多个文件」、给不了，所以面板这两次按「发起」计，气泡那两次已真落盘）；浏览器存储里没有任何备份键（localStorage 4 个既有键、sessionStorage 只有 `pc.shared.resume`、IndexedDB 空）；第二轮无冲突离线：「恢复中」→「离线时的修改已全部提交。」，乙收到甲离线时的修改；断 `/media/` →「连不上素材服务…」，恢复后撤下；全程 `/api` 守卫拦截 0、代理记录里 `/api/` 请求 0、`pageerror` 0。
- A8：`POST /media/api/asset/merge/<projectId>/<键>` → 501 `{"ok":false,"error":"not-implemented"}`。

**截图**（仓库外，`C:\Users\yuchiron\AppData\Local\Temp\c10-ui-shots\`）：`a6-1-user-card.png`（徽标、舞台常驻图标）、`a7-1-import-hover.png`、`a7-2-stt-menu.png`、`a7-3-overwritten-toast.png`、`a7-4-doc-down-unsent.png`（顶栏措辞 + 底部常驻提示）、`a7-5-no-network.png`、`a7-6-offline-dialog.png`、`a7-7-discard-toast.png`、`a7-8-backups-panel.png`、`a7-9-recovered.png`、`a7-10-asset-down.png`；下载的 JSON 在 `downloads\`。看过的：a6-1、a7-4、a7-7、a7-8（第一轮看出徽标盖住片段标题、常驻提示盖住顶栏状态，已修后重看 a7-4）。原生 `title` 提示在无头截图里不出现，悬停文案以 DOM 属性为证。

## 4. 偏离契约之处

1. **快照来源的预取也豁免**（契约第 18 节第 6 条只说选帧与投递）：层表里有用户卡那一层时，`OnlineSnapshotSource` 的预取与取清单不看选帧、照样会拉。加了 `skipLayer` 一并堵上，否则 C10-A6「该层不发快照请求」不成立。`c10-browser` 在重写快照来源（L2、L3），集成时把这个钩子带过去即可。
2. **`SpeakerPicker` 没改走 `previewMediaUrl`**：它交出的是写进项目的素材身份，不是取字节的地址（理由见 1.7）。
3. **常驻提示放在底部**，不在顶栏下方：顶栏高度随壳变（在线页面有标题栏菜单行），放顶上会盖住顶栏的状态措辞。表 A 只定了文案，没定位置，属三级。
4. **「本地备份…」菜单在线时打开**（C10a 置灰过）：它和同步面板的「备份 N」打开同一个内存列表，免得菜单说「不支持」而面板里有备份。
5. **暂停时仍挂离开确认**，但常驻提示只在真离线时出（暂停时已连上，说「当前离线」不对；关页面照样会丢攒着的修改）。
6. 新增三级数字：离线类措辞延迟 1.5 秒、「恢复完成」显示 4 秒、在线页面每 500 ms 看一次未确认条数、素材全到齐时每 5 轮对账探活一次。C10 合入时按契约的做法写进 `mechanism/platforms.md`（本分支没动语义文档）。

## 5. 需要主会话定的事

1. **`lowmem-online-probe` 的 G3 在基线上就挂**：断言是「暂停后重卡仍抑制、贴小尺寸（不追活渲）」，而 C10a 第 17 节已改成「停下追当前一帧」，追完就撤小尺寸，`hasSmall: false`。我在同一个 dev server 上把 `src/` 临时换回 `e067d0b` 跑，结果相同（`settling: [], hasSmall: false`），之后已换回本分支（`git checkout HEAD -- src/`，丢掉的两处 CSS 改动已重做并提交在 `2b349a4`）。建议探针的 G3 按第 17 节改写（归 `c10-cost` 或维护项），我没改这个探针（不在我的范围）。
2. 棘轮清单这次没删路径；要让它真的变短，得把置灰入口背后的调用按编译期 `ONLINE` 剪掉（如 `collab.ts` 的做法），属于后续维护。
3. 第 4 节第 1、3、4、5 条请审；第 6 条的数字合入时写进 `mechanism/platforms.md`。
4. 集成时与 `c10-browser` 的接缝：`snapshotFeed.ts` 只多了一个导出和 `planFeed` 里一行；`snapshotSource.ts` 多了 `skipLayer` 依赖与两处 `continue`；`Preview.tsx` 顶部一行开关 + 构造在线来源时传 `skipLayer`。

## 6. 仍在运行的进程

无。本分支起过的 vite（5700～5702，两次）、托管组合与代理（5703～5706）、替身素材服务（5707）、无头 Chrome 都已关掉，收尾时 `netstat` 查 5700～5709 没有监听。
