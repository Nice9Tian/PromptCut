# AGENT 报告：c66-integ（C6.6 集成）

分支 `claude/c66-integ`，worktree `.worktrees/c66-integ`，起点 main `8a5d6ff`。没有推送，没有合并进 main。

依据：`docs/plan/c66-design.md` 第 9 节「集成裁定」；四份子报告 `AGENT-c66-tiers`、`AGENT-c66-fetch`、`AGENT-c66-cards`、`AGENT-c66-tests`。

**状态**：四个分支已合并；c66-kit 已对账；第 9 节补做 1～3 已做并有单测；3b 查到根因、已修；T4 断言进了探针；第 5 条两点已复核。验证全绿，只有一项例外：**T8「5 s 内重测」在改后的做法下偶发超时**（约 1/8 的跑次重测拖到 16～19 s）。按任务第 8 条停在这一项，细节在第 8 节，交主会话定。

文中代号：T1～T9 是设计稿第 6 节的验收编号；K1～K5 是测试方在 `c66-kit.mjs` 里对接口的五条假设；C66-I1～I3 是本分支给第 9 节补做 1～3 条加的单测；C66-3b-* 是给 3b 加的单测；G0-R 是主会话要跑的「改了预览与导出路径」那组验证（导出确定性、快照重放、与 main 逐像素比、三个预渲染探针）。

## 1. 合并与冲突

依次 `git merge --no-ff`，没有 rebase、没有改写历史：

| 提交 | 合并 | 冲突与处理 |
|---|---|---|
| `7e9d1b6` | `claude/c66-tiers`（1af3e5c） | 无冲突 |
| `47e8d9f` | `claude/c66-fetch`（44169ee） | 3 处：<br>① `server/vite-plugin-media.ts`：tiers 加的 `/api/media/tiers`、`/api/media/upload-queue` 与 fetch 加的 `/api/media/remote|prefetch|originals` 在同一位置，两段都留，前后排列；<br>② `src/editor/Preview.tsx` 文件头注释：取 fetch 的新说法（轮询已接上），路径改成 main 现行的 `mechanism/asset-service.md`；<br>③ `src/render/mediaTier.ts` 两段注释：取 fetch 的内容，语义路径按 main 改为 `product/asset-service.md`、`mechanism/asset-service.md` |
| `2c8c55f` | `claude/c66-cards`（b25f482） | 1 处：`src/editor/sync/syncManager.ts` 的 import 行，fetch 加 `connectSharedAssets/disconnectSharedAssets`、cards 加 `bindCardSync/noteProjectForCardSync`，两行都留 |
| `e3f386a` | `claude/c66-tests`（069dc0e） | 无冲突 |

合并后另修两处（`1c27d6b`、`452d797`）：
- 四个分支新增文件的注释里还写着旧语义路径 `docs/semantics/architecture/asset-storage.md`，改成现行的 `product/asset-service.md` / `mechanism/asset-service.md`（`server/media-pull.mjs`、`media-tiers.mjs`、`upload-queue.mjs`、`src/editor/media/assetTiers.ts`）。
- **tiers 与 fetch 各在 `vite-plugin-media.ts` 里加了一个 `readJsonBody`**，git 自动合并没报冲突，合出来是重复声明。`npx tsc -b` 查不到（`tsconfig.json` 只包含 `src/`），dev server 会起不来。删掉 tiers 那份（两份只差上限 16 KB / 256 KB）。之后我用 esbuild 把本分支动过的 `server/*.ts` 都过了一遍语法，没有别的问题。

## 2. c66-kit 对账（K1～K5）

原则：`c66-kit.mjs` 里的 `load*` 把实际模块适配成测试方假设的形状，用例不动。文件头加了「集成对账」一节，逐条写明。

| 假设 | 实际 | 适配 |
|---|---|---|
| K1 `makeSmallTier` / `hasFaststart` / `ensureFaststart` / `prepareTiers` | `makeSmallVersion`（回 `{ ok }`，不抛）、`faststartState`（四态字符串）、`remuxIfNeeded`（写到给定的 `output`）、`createTierManager` | 前三个直接包一层。`prepareTiers` 用临时内容库，加上真的 `createTierManager().prepareImport()` 和 `idle()` 拼出来，走的是真实的重封装、排小尺寸、登记 |
| K2 `createUploadQueue({ file, base, fetch, ticket, chunkSize })` | `createUploadQueue({ file, target, resolveFile })`，档位是数组，要 `start()` | 用 `createAssetClient({ base, fetch, chunkSize })` 建客户端交给 `target()`；本地文件按 enqueue 时给的路径找（重启的新实例也找得到） |
| K3 `server/export-gate.mjs` 的 `checkExportOriginals` | 不存在 | 在 `src/render/mediaTier.ts` 新增 `checkExportOriginals({ project, has })`，页面与预渲染进程的 `/api/export` 共用（第 3 节第 3 条）；kit 指向它 |
| K4 `playability.ts` | 探测时给 `<video>` 设 `style`、挂进文档后 `remove()`、看 `videoWidth` | 假 DOM 补上这几样。另外假件的超时计时器从 20 ms 改为 200 ms：Windows 的计时粒度约 15 ms，试放的两步 5 ms 计时会和 20 ms 的超时赛跑（C66-T6-04 就这样偶发失败过一次） |
| K5 `createCardSync({ content, readLocal, install, backup, notify, scopeOf, stateFile })` | `createCardSync({ stateDir, files: { read, changed, install, backup }, connect, notify })`，经文档服务连接收发 `content.*` 消息 | 写了一个假端点，把 `content.watch/list/get/put` 转给 `fakeContentService`。覆盖提示是 `overwritten` 事件，映射成 `notify({ type: 'card-overwritten' })`。「是不是用户卡或改过的内置卡」在真实系统里由 `vite-plugin-cards.ts` 判，适配层按 `scopeOf` 判 |

**改了的用例（1 条）**：C66-T6-02 的 MIME 断言，从 `/^video\/quicktime/` 改为 `/^video\/mp4/`。理由：设计稿第 9 节认可了 c66-fetch 的做法（MOV 按 `video/mp4` 问 `canPlayType`；Chrome 152 对 `video/quicktime` 恒回空串）。用例里留了注释。

**为了让契约成立而改的实现（2 处，都很小）**：
- `src/render/playability.ts`：远端按「调用方标了远程，或地址是绝对 http(s) 地址」判。第 9 节认可了 c66-tests 的「远端按绝对 http(s) 地址判」，原实现只看调用方传的 `opts.remote`。
- `server/card-sync.mjs`：`files.install(rel, body, { rev })` 多传一个 `rev`（插件的实现不读它）。C66-T8-03 要核对「装上时带 cardRev」。

结果：契约 34 条全过（第 7 节）。

## 3. 第 9 节补做 1～3 条

### 第 1 条：页面把共享项目的素材服务交给上传队列（`f0d97e5`，`16099d3`）

- `src/editor/media/assetTiers.ts` 新增 `startUploadTarget(link, base)`。`connectSharedAssets` 挑到远程素材服务后，经本页面的文档服务连接签一张 `auth.ticket { kind: 'asset', access: 'rw' }`，`POST /api/media/upload-queue/target { base, ticket }`。从签发起过了 2/3 寿命（剩 1/3）就续签再推；签不到的话仍推基址（票据为 null），30 s 后再签。离开共享项目（`disconnectSharedAssets`，即回到本机空间）时推 `{ base: null }`。挑不到远程素材服务（本机就是主机）时只推 `{ base: null }`。
- 服务端（`vite-plugin-media.ts`）：`{ base: null }` 的含义定为**回到缺省目标**，即设了 `PROMPTCUT_ASSET_URL` 就回到它，否则回到本机。不这样的话，页面打开本机项目时会把环境变量给的上传目标清掉。tiers-probe 就是靠这个变量接远端的，第一次跑 T4 时发现了这个问题。
- 单测：C66-I1-01（服务端换目标、诊断回包不带票据、非 http 基址回 400）、C66-I1-05（环境变量目标与 `null` 回缺省）、C66-I1-02（签 rw、剩 1/3 续签、停止推 null、重复停止只推一次）、C66-I1-03（签不到票据、挑不到远程）、C66-I1-04（`connectSharedAssets` / `disconnectSharedAssets` 接到 `/api/media/upload-queue/target`）。
- 现场：tiers-probe 的「页面打开后 A 的上传目标仍是 R」一项通过（第 7 节）。真正的共享项目加远端上传这条链要到跨机 T9 才能端到端验证，本机没有演练。

### 第 2 条：打开项目时补转素材小尺寸（`f0d97e5`）

- 服务端：两档管理器新增 `backfill({ hash, ext, name })`。本地内容库里有这份素材原尺寸的视频才排进后台转码，**不重封装**，哈希就是项目引用的那个，`.procp` 还原的素材也一样。已经有小尺寸（文件还在）或确定没有视频流的不动；上次失败的再试一次。转好后照常交给上传队列，先小后大。新路由 `POST /api/media/tiers/backfill { items: [{ hash, name? }] }`；本地没有素材原尺寸的回 `absent`，不会为了转小尺寸去拉原尺寸。
- 页面：`src/editor/io/mediaUpload.ts` 新增 `backfillSmallTiers` / `startTierBackfill`，`Preview` 挂上时启动。它订阅素材表，1.5 s 后对缺 `tiers.small`、按哈希入库的视频发请求：回 `ready` 的当场写 `tiers.small`，回 `pending` 的交给原有的 `watchSmallTier` 每 2 s 盯一次。同一页面会话里问过的不再问；请求失败（没有本机编辑器）的不记为问过；只读页面不做。
- 单测：C66-I2-01（经插件的真实 HTTP：不带 tiers 入库、补转、原尺寸字节与 moov 位置不变、再问回 ready）、C66-I2-02（跳过图片与音频、`none` 不再转、失败的再试、先小后大交给队列）、C66-I2-03（页面：只问缺小尺寸的视频，ready 当场写，pending 盯到好，absent 不写，同会话不重复问）、C66-I2-04（没有编辑器时什么都不写、下次再问）。

### 第 3 条：服务端导出拦截（`f0d97e5`）

- `server/export-originals.ts` 新增 `exportOriginalsGate(project)`。它挑出被片段引用、带哈希的素材原尺寸，一次问编辑器进程的 `POST /api/media/originals`（c66-fetch 已有），然后用 `checkExportOriginals` 判。编辑器进程的源用 `assetServiceOrigin()`：预渲染进程里是 `PROMPTCUT_EDITOR_URL`，单进程形态是本进程。问不到时按全部没到齐算。没有带哈希的素材被引用时不发请求，直接放行。
- `server/vite-plugin-export.ts` 的 `handleExportStart` 在解析请求体之后、建导出目录之前调用它，缺素材就回 `409 { code: 'awaiting-uploader', message, missing }`。页面的 `exportVideo` 认得这个 409，按「等待上传方」提示。页面上原有的两处拦截保留。
- 单测：C66-I3-01（只问该问的、一次问齐、问不到就拦、没有哈希不发请求）、C66-I3-02（真的导出插件中间件：409、列出 m1/m2、不建导出目录）。

## 4. 卡片热更新的遗留（3b）

### 根因

不是「App 重新挂载」。直接原因是：改一张卡的热更新沿导入链冒到了编辑器的组件上，Fast Refresh 重跑了这些组件的 effect。两条链：

1. 卡片文件 → `cards/native/index.ts`（或 `cards/user/index.ts`）→ `src/cards/index.ts` → `Editor.tsx`、`StageView.tsx` …（`Editor.tsx` 还经 `nativeDemoClips` 直接引了 `cards/native/index.ts`）；
2. 卡片的 `?raw` → `src/render/cardSourceFiles.mjs`（它 glob 了 cards、parts、render、kernel 全部源码）→ `costIdentity` → `probeRunner` / `planDispatch` → `ProbeGate.tsx`、`Preview.tsx`。

`Preview.tsx` 里负责舞台握手的 effect 被重跑时，cleanup 把两个舞台的 RPC 客户端都 dispose 了。舞台 iframe 没有重载，不会再发 `pc-stage-ready`，于是主页面从此没有舞台客户端，舞台停在旧画面，不再更新。codex 在 `b25f482` 里整页重载两个舞台，治的就是这个症状。

我用观察脚本实测过（本机开发、改底版卡片 `blur-text.tsx`、没有改动层）：修之前热更新列表里有 `Editor.tsx`、`Preview.tsx`、`ProbeGate.tsx`、`StageView.tsx`；可见舞台改后 8 s 内一直停在旧标记，新标记没出现。编辑器 DOM 节点在热更新前后是同一批（21/21 保留），说明没有重挂。

「选择 AI 助手」对话框的真相：它是**首启对话框**，条件是 `localStorage.aiSetupDone` 为空、且 AI 供应商列表加载完。探针每次用全新的 Chrome 配置，供应商列表回来得晚，所以它碰巧在改卡之后才弹出，与热更新无关。用户关过一次之后就不会再弹，就算组件真的重挂了也不会。

### 修法（`b70f506`、`a36d6c6`）

- `src/cards/index.ts` 自己接住热更新（`import.meta.hot.accept()`）。它本来就在每次执行时从空重装整套卡片，引用它的地方都只是 `import "./cards"` 取副作用。重装完、这一批热更新全部落地后（`vite:afterUpdate`），调注册表的 `noteCardsUpdated(stamp)`，`stamp` 取自热更新负载里的时间戳。
- `src/render/cardSourceFiles.mjs` 自己接住热更新：重跑时把新表**原地**写进第一次导出的那个对象（经 `import.meta.hot.data` 保存），另记一个版本号 `cardSourceFilesVersion()`。
- 演示片段挪进纯数据的 `src/cards/demoClips.ts`，`Editor.tsx` 改从这里引。`cards/native`、`cards/magicui` 仍按原名转出。
- `kernel/registry.ts` 新增 `onCardsUpdated` / `cardsVersion` / `cardsStamp`。订阅方：`StageView` 重渲、换上新卡；`Editor` 重渲一次，刷新卡片库列表，只重渲、不重跑 effect；`ProbeGate` 显式重测（设计稿第 5 节「卡片代码变了要显式触发重测」，同步装上的和本机改的都算）。
- **舞台重载只在舞台代码确实过期时做**（`src/editor/stageCards.ts`）：舞台按新卡重渲后发 `pc-stage-cards { stamp }`（`render/stageRpc.ts` 的 `postStageCards`）。`ProbeGate` 先等两个舞台都报到这一版，再等后台舞台就绪，然后才排重测。4 s 内没报到的舞台才整页重载那一个；刚握过手的舞台算最新。`Preview.tsx` 里 `b25f482` 那段「每次卡片同步都重载两个舞台」去掉了。
- `vite.config.ts`：`react({ exclude: [node_modules, src/cards, src/parts] })`。卡片和部件文件导出的是卡片定义（对象），不是纯组件，Fast Refresh 本来就接不住：插件先把文件当成自接的边界，页面里校验不过再 invalidate，于是每改一张卡，编辑器页面和两个舞台还要各自再触发一轮热更新（实测晚到 3 s）。排除之后一次就走到 `cards/index.ts`。**这是构建配置的改动**，请主会话留意。
- 单测：C66-3b-01～03（`stageCards.ts`：都报到才放行；先报到或刚握手的立刻放行；超时只重载没报到的那一个；legacy 单舞台只等 A）。

### 量出来的数（原始数字）

本机开发、改底版卡片、没有改动层（观察脚本在 scratchpad 里，没有入库，见第 9 节第 5 条），修之后连改 3 次：

| 次 | 热更新列表 | 可见舞台最后一次旧标记 → 第一次新标记（ms） | 其间没画面（ms） | 主页面整页导航 | 编辑器 DOM 保留 |
|---|---|---|---|---|---|
| v1 | `cardSourceFiles.mjs`、`blur-text.tsx`、`cards/index.ts`、`App.tsx`、`ExportView.tsx`（后两个不在编辑器页面里挂载） | 391 → 403 | 0 | 0 | 是 |
| v2 | 同上 | 543 → 558 | 0 | 0 | 是 |
| v3 | 同上 | 435 → 451 | 0 | 0 | 是 |

新旧标记之间的 12～16 ms 就是采样间隔，也就是说没有看到中断。

共享项目、A 改用户卡、B 同步（`card-sync-probe`，最终代码连跑 3 次，都是退出码 0、`fails: []`）：

| 次 | installMs | hmrMs | 可见舞台 v1→v2（ms） | 断画（ms） | 舞台重载 | 编辑器 DOM | 对话框 前/后 | remeasureMs |
|---|---|---|---|---|---|---|---|---|
| f1 | 231 | 1607 | 1548 → 1559（间隔 11） | 0 | 0 | 27/27 | 否/否 | 3440 |
| f2 | 1538 | 1742 | 1545 → 1598（53） | 0 | 0 | 27/27 | 否/否 | 3385 |
| f3 | 130 | 2041 | 1895 → 1907（12） | 0 | 0 | 27/27 | 否/否 | 3845 |

对照：修之前（`b25f482` 的整页重载，在 `f0d97e5` 上用同一个探针跑 5 次）：remeasureMs 2345 / 2408 / 2315 / 2547 / 2529；**每次改卡可见舞台断画 1106～1314 ms，两个舞台各重载一次**。

T8「5 s 内装上并重测」：codex 在笔记本上测到 5396 / 2464 / 5307 ms。这台 PC 上用最终代码跑了 3 次，都在 5 s 以内（见上表）。但偶发超时，见第 8 节。

## 5. T4：后台上传期间主线程长任务

写在 `scripts/probes/tiers-probe.mjs` 里。A 上开一个编辑器页面（`?nosetup=1`），等测量遮罩退下、再静置 5 s。然后挂 `PerformanceObserver('longtask')`，每 120 ms 编辑一次（拖播放头、挪片段、改参数、改标签），先跑 3 s 没有导入和上传的对照窗口，再跑导入 → 转码 → 上传到队列清空的窗口。

**第一次跑没过，查出长任务来自编辑本身、与上传无关**。上传窗口 1.6 s 里有 7 个长任务（61～87 ms），对照窗口 3 s 里有 12 个（50～79 ms），每个都紧跟在一次挪片段、改参数或改标签之后（拖播放头没有）。用 CDP 做了 profile：每次项目变动，`planDispatch` → `costIdentity.sourceVersionsOf` 都要整张重算源码版本表，每张内置卡都拿正则扫一遍全部源码文件找入口（`cardSourceVersion.mjs:13`），10 次编辑累计约 383 ms。这是已有的性能问题，不是 C6.6 引入的。

修法（`16099d3`、`c82a6e5`）：
- 源码版本表按「注册表变动计数（`cardsRegistryGen`）、卡片源码表版本（`cardSourceFilesVersion`）、定制卡源码对象」记忆化，三样任何一样换了就重算。`resetClipIdentityCache` 也会清掉它。
- `probeRunner` 的 GPU 渲染器串一个页面会话只读一次（原来每排一轮都新建一个 WebGL 上下文去读）。

改后 10 次编辑的 profile 里已经看不到 `cardSourceVersion`。

最终代码连跑 3 次（g1～g3，都是退出码 0）：

| 次 | 上传窗口 ms | 窗口内编辑次数 | 窗口内 > 50 ms 长任务 | 对照窗口 ms / 编辑次数 / 长任务 |
|---|---|---|---|---|
| g1 | 1716 | 13 | 0（`longtasks: []`） | 3002 / 25 / 0 |
| g2 | 1576 | 12 | 0 | 3003 / 25 / 0 |
| g3 | 1593 | 12 | 0 | 3001 / 25 / 0 |

在 GPU 渲染器那条改动之前的 f1～f3 里，f3 的上传窗口出现过 1 个 59 ms 的长任务，紧跟在一次挪片段之后；对照窗口是 0。我判断是转码时 CPU 被占用、把一次本来就不轻的编辑推过了 50 ms。之后的 g1～g3 没再出现。

上传窗口只有 1.6～2.6 s：本机导入、转码、上传都很快。设计稿第 6 节 T4 没有规定窗口长度。

## 6. c66-fetch 那两点

1. **`planningSlots` 在导出路径上的影响**：没有影响，不用收窄。`VideoTrack` 只在 `FrameScene` 的 `mediaMode === "live"`（舞台页）挂载；导出页 `ExportView` 用 `FrameScene` 的缺省 `placeholder` 路，不挂 `VideoTrack`（`src/render/FrameScene.tsx` 第 185～260 行）。旁证：本分支 `verify-determinism` 导出 1800 帧逐像素相同（第 7 节）。与 main 的逐像素对比由主会话在 G0-R 里跑。
2. **预热期间每一帧都 `bump()`**：我试过改成「只在 ready 变化时 bump」，理由是播放中舞台每一拍本来就重渲，暂停中预热档停着、不交帧。改后 `tier-switch-probe` 3 次里第 1 次 T5b 没过：`frameError: null`、`observedGap: -6.05`，trace 里是一串 `playing:false` 的对齐帧。**我没法排除是这处改动引起的，就还原成了 codex 的写法**。还原后连跑 6 次（4～6 与最终 f1～f3）全过，`afterSwapBlack: 0`、`lumaBlack: 0`，没有黑帧。按代码看，每帧 bump 只发生在「第一次对齐成功」到「换档那次提交」之间，一般是 1～2 帧；换档后这个槽位就不再是预热槽位了。所以不会造成可见卡顿，保留原样。

## 7. 验证（命令与原始结果）

端口：dev server 与探针只用了 5590～5599（编辑器 5590 / 5594，舞台 +1、+2，tier-switch 的远端 5594）和托管组合的 8792、8793。每次跑完都按监听端口结束了自己起的进程树（`taskkill /T`），最后查过 5590～5599、8792、8793 都没有监听。用户常驻的 5190～5192 没碰。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行（最后一次提交 `95595a8` 之后） |
| 全量测试 | `npm test` | 退出码 0：`tests 3073`、`pass 3072`、`fail 0`、`cancelled 0`、`skipped 1`（跳过的是「集成:/api/cards/layout 对真实项目返回整数框」，要 5190）。main 是 2962，本分支多 111 条 |
| 契约 34 条 | `node --experimental-test-module-mocks --test server/test/c66-tiers.test.mjs server/test/c66-upload.test.mjs server/test/c66-fetch.test.mjs server/test/c66-cards.test.mjs` | `tests 34`、`pass 34`、`fail 0`（连跑多次都全过） |
| 四个子分支的单测 | `node --experimental-test-module-mocks --test server/test/media-tiers.test.mjs src/editor/io/mediaTiers.test.mjs server/test/media-pull.test.mjs src/render/tierSwitch.test.mjs src/editor/media/assetTiers.test.mjs src/render/mediaSync.test.mjs src/render/mediaTier.test.mjs server/test/card-sync.test.mjs` | `tests 102`、`pass 102`、`fail 0` |
| 集成新增 | `node --experimental-test-module-mocks --test server/test/c66-integ.test.mjs src/editor/media/uploadTarget.test.mjs src/editor/io/tierBackfill.test.mjs src/editor/stageCards.test.mjs` | `tests 14`、`pass 14`（C66-I1-01～05、I2-01～04、I3-01～02、3b-01～03）。注意：`server/test/c66-*.test.mjs` 这个 glob 现在也匹配 `c66-integ.test.mjs`，合起来是 40 条 |
| `tiers-probe`（含 T4） | `node scripts/probes/tiers-probe.mjs --port-a 5590 --port-r 5594` | 最终代码 g1～g3 退出码 0、`fails: []`。三个素材都 `remuxed`；小尺寸 800×450 / 640×360 / 640×360，都是 H.264、faststart；原尺寸编码不变（`video:h264+audio:aac`、`video:prores`、`video:h264`）；队列日志 15 条，逐个素材、先小后大；R 上六个哈希都 `complete` 且 sha 对得上；T4 见第 5 节 |
| `tier-switch-probe` × 3 | `node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5590 --remote-port 5594` | 最终代码 f1～f3 退出码 0、`fails: []`。T5a：帧号 75→75，黑帧 0，switchMs 1296 / 1514 / 1492。T5b：frameError -0.97 / -0.02 / 0.99，换档后黑帧 0。T6：停在小尺寸，缓存 `0`。T7：`awaiting-uploader`，导出请求 0。`remoteAuthSeen: true`，`pageErrors: []` |
| `card-sync-probe` × 3 | `node scripts/probes/card-sync-probe.mjs --doc-port 8792 --asset-port 8793 --a-port 5590 --b-port 5594` | 最终代码 f1～f3 退出码 0、`fails: []`（数字见第 4 节）。另外：身份键变了、托管端 `cardRev: 2` 且正文是 v2、底版仍是 v1、B 只收到一条 `installed`、B 没离开共享项目 |
| 导出一段 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5590/?export=1"` | 退出码 0：`Total Frames: 1800`、`Identical: 1800`、`Different: 0`、`All frames are identical. Determinism verified!`。3b 之前和最终代码各跑一次，结果相同 |

看过的图：`card-sync-probe` 第 1 次的 `muj1tpa5-b-2-after.png`（scratchpad `card-sync-1\`）。B 的舞台画着 `CS-PROBE-…-v2`，右上是「卡片 cards/user/cs-probe-muj1tpa5.tsx 已同步为 alice 的版本」气泡，没有「选择 AI 助手」对话框；时间轴上有「同步探针」片段；成员 2 人。

G0-R 按任务书不在这里跑。

## 8. 没做成的：T8 偶发超时（按第 8 条停手）

**失败用例**：`scripts/probes/card-sync-probe.mjs` 新加的断言 `remeasure-over-5s`（T8「5 s 内装上并重测」）。

**原样报错**（几次失败的 `fails`）：`["remeasure-over-5s(17652)"]`、`["remeasure-over-5s(17652)"]`、`["remeasure-over-5s(17819)"]`、`["remeasure-over-5s(18772)"]`、`["remeasure-over-5s(19127)"]`、`["remeasure-over-5s(17835)"]`。

**出现频率**：用本分支的无重载做法一共跑了 21 次，6 次超时。其中在「舞台报到后才重测」和「卡片不做 Fast Refresh」两处修正（`a36d6c6`）之后跑了 8 次，1 次超时（d13）。最终 f1～f3 都过。

**现象**（`PROBE_DEBUG=1` 下记的重测时间线，d13 原样）：`[{"ms":440,"s":"idle+block 1/1 - job=null q=0"},{"ms":1563,"s":"run 0/1 cs-probe-muj3a90h job=\"probe\" q=1"},{"ms":17784,"s":"idle 1/1 - job=null q=0"}]`。可以看出：
- 热更新和舞台换卡都正常：可见舞台 1475 ms 画上 v2，断画 0，舞台没有重载；
- 装上新卡后，后台舞台上的那一次探针测量（`runBackJob("probe")` → `probeCardOnce`，这张卡是 `direct` 帧模式，要做约 8 次 `setTime(…, { probe: true })`）在大约 1.6 s 开跑，有时 1.7 s 就测完，有时要 16 s；
- 超时前后，编辑器服务端日志只有一批热更新，没有 invalidate，也没有别的错误。

**我的判断（未验证）**：同一个后台舞台先测过这张卡的旧版，又在舞台里热更新换了卡，再接着测新版时，某一次 `setTime(probe)` 或快照没回来，等了约 15 s 才继续。stageRpc、stageJobs、probeRunner 里都没找到 15 s 的超时常数。`b25f482` 的做法（每次整页重载舞台）在同一个探针下 5 次都没出现，但代价是每次改卡可见舞台断画 1.1～1.3 s。

**相关提交**：`b70f506`（去掉重载、热更新边界）、`a36d6c6`（舞台报到、Fast Refresh 排除）、`16099d3`（源码版本表记忆化）。探针的调试时间线在 `PROBE_DEBUG=1` 下输出为 `res.debugTimeline`。

**要主会话定的**：
- (a) 保留本分支的做法（不断画），把 16 s 那一段交 codex 攻坚；
- (b) 退回 `b25f482` 的整页重载（重测稳定在 2.3～2.5 s，但每次改卡断画约 1.2 s）；
- (c) 折中：保留不断画的做法，另加「后台舞台上的探针测量超过 N 秒没回，就重载后台舞台再测」的兜底。

## 9. 偏离任务书的地方与更正建议

1. **动到了任务书没点名的文件**，都是为了 3b 与 T4：`vite.config.ts`（Fast Refresh 排除卡片与部件）、`src/kernel/registry.ts`、`src/cards/index.ts`、`src/cards/demoClips.ts`（新）、`src/render/cardSourceFiles.mjs` 及其 `.d.mts`、`src/editor/costIdentity.ts`、`src/editor/probeRunner.ts`、`src/editor/stageCards.ts`（新）、`src/render/stageRpc.ts`（新增一个握手类消息 `pc-stage-cards`，不是 `StageEvent`）、`src/StageView.tsx`、`src/Editor.tsx`。
2. **设计稿第 9 节第 1 条**建议补一句：「`{ base: null }` 表示回到缺省目标（设了 `PROMPTCUT_ASSET_URL` 就是它）」。
3. **`AGENT-c66-cards` 第 5 节与 `PAUSE-2026-09-26` 第 4 节第 2 条**需要更正：热更新没有让 App 重新挂载；「选择 AI 助手」是首启对话框，和改卡无关。真正的问题是热更新冒到 `Preview` 上、Fast Refresh 重跑 effect、清掉了舞台的 RPC 客户端。已修（第 4 节）。
4. **设计稿第 6 节 T4** 建议写明：长任务在「有无后台上传」两个窗口里对照着量。编辑本身的长任务是这次查出来并修掉的已有问题（源码版本表每次编辑整张重算）。
5. **本机开发时改底版卡片的观察脚本**在 scratchpad 里（`hmr-probe.mjs`），没有入库：它会临时改 `src/cards/native/blur-text.tsx`，在主工作区误跑会让用户常驻的编辑器也热更新。要不要做成正式探针，请主会话定。
6. **用词**：界面上「等待上传方」的提示已改用 glossary 的新词（`95595a8`，「素材原尺寸」）。四个子分支的代码注释里仍大量写「原片」「小版」。glossary 说这两个是被取代的旧词，但 `constraints.md` 的用词条目没有列它们。要不要统一，请主会话定。
7. **`c66-integ.test.mjs` 里各见过一次的快速失败**：C66-I2-01（82 ms）、C66-I3-02（5 ms），当时没有留下报错原文。之后在单文件、多文件并发、`npm test` 里复跑了 40 多次，都没再出现。现在断言会带上回包原文（`a0c26bd`），再出现就能看到原因。
8. **`card-sync-probe` 的抢跑**：原来只等「测量遮罩退下」就改卡，遮罩可能还没出来（见过一次改卡后才冒出进入共享项目那一轮的遮罩，测了 18 s）。现在改成读 `probeProgress()`，连续 1.5 s 空闲才算测完；3b 之后探针模块不在热更新链上了，可以直接读。

## 10. 提交

`41440c4` 开工，`7e9d1b6`、`47e8d9f`、`2c8c55f`、`e3f386a` 四次合并，`1c27d6b` 路径，`452d797` 对账，`f0d97e5` 补做 1～3，`b70f506` 3b，`16099d3` T4 与记忆化，`a36d6c6` 3b 续，`a0c26bd` 测试诊断，`c82a6e5` GPU 渲染器串，`95595a8` 用词，另加本报告的提交。
