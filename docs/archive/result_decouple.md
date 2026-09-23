# 解耦工作交接(result_decouple)

范围:`fba57c3`(不含)→ `f8ba00d`(本地 main)。19 个非合并提交 + 6 个合并提交,213 个文件,+4841 / −3814。
日期:2026-09-21 ~ 09-22。本地 main 领先 origin/main 24 个提交,**尚未 push**。

---

## 1. 结论

这一段历史**全部是解耦改动**,没有功能改动,对外接口未变:

| 对外接口 | 核对方式 | 结果 |
|---|---|---|
| MCP 工具表(119 个,含顺序、schema、`side`、`timeoutMs`) | `fba57c3` 与 main 两份 `server/mcp-tools.mjs` 逐项序列化比较 | 完全一致 |
| MCP 工具 → `EditorApi` 的分发语义 | 旧 103 条 `else if` 与新路由表逐项比 (方法名, 是否 await, 是否传参, 顺序) | 零差异 |
| vision 插件的 HTTP 路由(11 个路径) | 拆分前后路径集合比较 + 处理体逐字比较 | 一致 |
| `src/store/project.ts` 的公开导出 | 对照拆分前(`b5c65dc`)的 export 列表 | 一致;全仓库无人依赖被收回的内部名字 |
| `npm run export` 命令行 | 8 组参数向量解析结果 + 一次早失败实跑的 stdout/stderr | 一致 |
| `server/vite-plugin-vision.ts` 的 export(`visionPlugin`、default、`bakeTarget`) | 静态测试钉住 | 不变 |
| `package.json` / lockfile / `tsconfig.json` / `vite*.ts` / `.claude/` / `desktop/src-tauri/` | `git diff --name-only` | 未触碰 |

逐文件分类(脚本对 213 个文件的每一行改动分类):

- **111 个**:纯移动,或只改了 import / export-from 路径
- **47 个**:只改注释或文档里的路径字符串
- **25 个**:新增文件(拆出来的模块、路由表、5 个守门测试、`kernel/cardGpu.ts`)
- **30 个**:有 import 之外的代码改动 —— 全部在 §3 的「非逐字搬运清单」里逐条列出,没有清单外的改动

---

## 2. 做了什么(对应审查的 5 条发现)

### 2.1 store:解掉 `project ↔ actions` 运行时循环 — 合并 `d6d590e`
- `src/store/actions/*` 不再 `import { actions } from "../project"`。同文件内调用改成本文件对象(`tracks.removeTracks`),跨文件只有两条边:`captions → tracks`、`captions → clips`,无新环。
- `src/store/project.ts` 不再 `export * from "./core"`,只转出 `EditorState` / `planPlacement` / `getState` / `subscribe` / `useStore` / `actions`。`core.ts` 的 `state` / `set` / `setProject` / `history` 等是包内原语,只给 `src/store/actions` 用(文件头有注释)。
- 85 个 action 键集合与顺序不变;函数体除 9 处调用前缀外逐 token 一致。全仓库无处运行时替换 `actions.xxx`,所以直接 import 与走 `actions.` 拿到的是同一个函数。

### 2.2 MCP:分发链 → 路由表,非 UI 工具模块下沉 — 合并 `41848a9`
- `src/ai/mcpExecutor.ts` 里 103 条 `else if (tool === "xxx")` 抽成 `src/mcp/routes.mjs`(纯数据)+ `routes.d.mts`(类型)。每项 `{ method, passArgs, awaited }` **逐条照抄原语义,不统一 await**(多一个微任务会改变与后续 `getState()` / `flushDataMirror()` 的时序)。`ToolRoute` 按 `passArgs` 做成可辨识联合,分发处没有任何 `as` / `any`。
- 留在表外的特殊分支(`SPECIAL_TOOLS`):`declare_scope` / `list_agents` / `send_message` / `check_messages`(走 agentBus)、`see_frames`(一名两实现)、`get_gif`(实现不在 EditorApi 上)、`web_*` 8 个(服务端浏览器)。
- `git mv` 到 `src/mcp/tools/`:`toolEcho.ts`、`trackTools.ts`、`pixelMapTools.ts`、`autoWorkflow.ts`(含各自单测)。
- **没动**:`filterTools.ts` / `audioFxTools.ts`(左栏 4 个 `.tsx` 表单在用)、`cardScope.ts`(4 个 UI 文件在用)。前两者现在从 `src/mcp/tools/toolEcho` 引 `lookHint`,多一条 `editor → mcp` 边,方向正确(上层依赖下层)。

### 2.3 渲染引擎:`scripts/` → `server/bakery/` — 合并 `a1d50db`
- `scripts/export-frames.mjs` 1406 行 → 42 行(只剩参数解析 + `isMain`,并保留一行 `export * from "../server/bakery/index.mjs"` 兼容转出)。
- 新模块:`chrome.mjs`(394,继承原文件历史)、`bake.mjs`(356)、`export.mjs`(207)、`media.mjs`(164)、`ffmpeg.mjs`(122)、`shards.mjs`(118)、`audio-mix.mjs`(90)、`index.mjs`(27,转出原来那 9 个名字)。
- 为断掉 `server → scripts`,连带整体搬运 11 个传递依赖:`export-unified` / `capture-frame` / `capture-snapshot` / `frame-ready` / `frame-media` / `chrome-health` / `png-integrity` / `browser-loss` / `mux-audio`(+test)/ `frame-video`。
- `export-frames ↔ export-unified` 的运行时环解掉(`exportFrames` 里那行 `await import('./export-unified.mjs')` 改为 `export.mjs` 静态 import)。
- 模块级可变状态只有两处,均未被拆成两份:`installingShell`(`chrome.mjs`)、`table`(`png-integrity.mjs`)。

### 2.4 分层:`kernel ← render ← editor` — 合并 `c0ab418`
全部 `git mv`,移动文件除 import 路径与注释路径外零改动:

```
src/render/frameMode.mjs(.d.mts)  → src/kernel/frameMode.mjs(.d.mts)
src/kernel/Stage.tsx              → src/render/Stage.tsx
src/kernel/PartTree.tsx           → src/render/PartTree.tsx
src/editor/prerender.ts           → src/render/prerender.ts
src/editor/dataMirror.ts          → src/render/dataMirror.ts
src/editor/left/contentBox.ts     → src/render/contentBox.ts
src/parts/types.ts                → src/kernel/partTypes.ts
src/parts/registry.ts             → src/kernel/partRegistry.ts
新建 src/kernel/cardGpu.ts —— 从 render/cards/gpuExecutor.ts 原样搬出的 8 个纯类型,gpuExecutor 反过来 import 并 re-export
```

`src` 内反向依赖 20 条 → 5 条。剩下的:`kernel/clock.ts → render/*` 4 条(`declare global` 里 `window.__pc*` 的 inline 类型,编译后不留 import;测试白名单里写明了原因,边修好后白名单必须同步删)、`kernel/frameMode.mjs → cards/capabilities.json`(数据文件,不算模块边)。

### 2.5 vision:2012 行巨石 → 9 个模块 — 合并 `98c0f70`
`server/vite-plugin-vision.ts` 只剩 56 行外壳。`server/vision/`:

| 文件 | 行 | 职责 | 归它管的模块级状态 |
|---|---|---|---|
| `ffmpeg-frames.ts` | 118 | ffmpeg 定位、素材路径白名单、抽帧、素材层 | `ffmpegResolved` |
| `render-queue.ts` | 142 | 并发队列与优先级插队 | `renderWaiting`、`renderRunning` |
| `http.ts` | 82 | 回 JSON / 断开检测 / 地址改写 / 回连源 | 无 |
| `bake-cache.ts` | 56 | 预渲染产物盘点与清理 | 无 |
| `bake.ts` | 387 | `bakeTarget`、`bakeOne`、`bakeClip` | `bakeInFlight` |
| `worker-pool.ts` | 369 | 常驻 Chrome worker 池 | `renderWorkers`、`renderJobSeq`、`lastRenderOrigin` |
| `ui-renderer.ts` | 163 | 编辑器侧热备渲染器 A/B | (闭包内,未提到模块级) |
| `render.ts` | 153 | `renderOneFrame` / `renderFrames` | `counter` |
| `routes.ts` | 618 | `registerEditorSide` + `registerPrerenderSide` | 无 |

依赖单向:`routes → {bake, render, ui-renderer} → worker-pool → render-queue`。每份状态只有一个归属,跨模块通过函数读写(`nextCounter()`、`setLastRenderOrigin()`)。已用 rolldown 打包探针证明 `renderRunning` 是同一份活绑定(观测 `0 → 1 → 0`)。

**给后续工作的路标**(`user_pinned_goal.md` 架构第 4、5 条):Agent 专用 Chrome 优先通道改 `worker-pool.ts` 的取任务逻辑;AI 菜单操作预览插队改 `render-queue.ts` 的入队位置。两者现在互不牵连,也不牵连路由和 ffmpeg。详见 `docs/vision-plugin-refactoring-plan.md`(已更新为完成状态)。

---

## 3. 非逐字搬运清单(全部)

除 import/export 语句外,代码层面的改动只有这些:

| # | 位置 | 改动 | 性质 |
|---|---|---|---|
| 1 | `src/store/actions/{audio,captions,coreActions,cuts,effects,tracks}.ts` | 9 处 `actions.xxx(` → 本文件对象 / `clipActions.` / `trackActions.` | 解环必需,调到同一函数 |
| 2 | `src/ai/mcpExecutor.ts` | 103 条 `else if` → 查 `TOOL_ROUTES` 的 4 行分发 | 语义逐条保留 |
| 3 | 同上 | 用 `Object.hasOwn` 查表 | 保证 `toString` 之类的名字仍回「未知工具」(与原 if 链一致) |
| 4 | `server/bakery/export.mjs` | `exportFrames` 去掉 `await import('./export-unified.mjs')`,改静态 import | 解环必需 |
| 5 | `server/vision/bake.ts` | `${counter++}` → `${nextCounter()}` | 状态归属 `render.ts` |
| 6 | `server/vision/ui-renderer.ts` | `lastRenderOrigin = …` → `setLastRenderOrigin(…)` | 状态归属 `worker-pool.ts` |
| 7 | `server/vision/routes.ts` | `new URL("./ai-visual.mjs", import.meta.url)` → `"../ai-visual.mjs"` | 文件进了子目录,相对路径必须多退一级(运行时冒烟抓到,静态检查看不出) |
| 8 | `server/vite-plugin-vision.ts` | 内联的 514 行预渲染侧路由 → `registerPrerenderSide(server, root)`;删掉从未使用的 `cardsOnly` import | 拆分 |
| 9 | `server/vision/render.ts` | 一段错位夹在 `listBakes` 上方的 `renderOneFrame` 文档注释放回原主头上 | 文字未改,只改位置 |
| 10 | `server/frame-code.mjs` | `CAPTURE_FILES` / `FREEZE_FILES` 里的 `scripts/*` 路径 → `server/bakery/*`(原整个 `export-frames.mjs` = 现在 7 个模块) | 哈希覆盖的内容集合不变 |
| 11 | `scripts/verify-bake-protocol.mjs` | `SCANNED_FILES` 同步新路径 | 同上 |
| 12 | `server/vite-plugin-cards.ts`、`server/frame-mov.mjs` 等 | 按路径动态 import 的字符串同步新路径 | 路径同步 |
| 13 | `src/kernel/partRegistry.ts` | 文件头新增一段说明注释(为什么注册表放 kernel) | 仅注释 |
| 14 | `src/parts/lib/*.tsx`(26 个) | `../types` → `../../kernel/partTypes` | 路径同步,未留转发壳 |

测试侧:

| 位置 | 改动 |
|---|---|
| `server/test/tool-schema.test.mjs` | 「三处声明必须对齐」两条用例改为认路由表 |
| `server/test/cards.test.mjs` | 转译器:相对 `.mjs` 一律试着指回原地,原地不存在的原样留着(`registry.ts` 的 import 变成同目录 `./frameMode.mjs` 后原正则匹配不到,50 个用例会一起挂)。**未放宽任何断言** |
| `server/test/cards-layout.test.mjs` | 两条 `mock.module` URL 改到 `../bakery/*`(逐条核对过 mock 仍生效) |
| `server/test/media-pcm.test.mjs`、`card-snapshot-identity.test.mjs`、`card-source.test.mjs` 等 | 路径字符串同步 |
| `src/{editor/right/audioFxTools,editor/right/filterTools,kernel/clipVolume,mcp/tools/trackTools}.test.mjs` | `createServer` 加 `hmr: false, watch: null`(见 §6.2) |

---

## 4. 新增的守门(5 个测试文件 + 1 处类型守门)

| 测试 | 守什么 |
|---|---|
| `src/store/importGraph.test.mjs` | `src/store/**` 运行时 import 无环;`actions/*` 不 import `../project` |
| `server/test/mcp-routes.test.mjs`(8 条) | browser 侧工具 ⇔ 路由表 ∪ 特殊分支,双向无增无减;`method` 真在 `EditorApi` 上;报错文案未变 |
| `server/test/bakery-deps.test.mjs` | `server/**` 不 import `scripts/`(白名单仅 `bake-protocol.test.mjs` 一项);`server/bakery/**` 无环 |
| `src/layering.test.mjs` | `kernel` 不 import `render/editor/mcp/ai/store/cards/parts`;`render` 不 import `editor/mcp/ai`;白名单反向盯梢 |
| `server/test/vision-modules.test.mjs` | `server/vision/**` 无环;外壳 < 400 行;三个对外 export 不变 |
| (上一轮 PR #1)`src/mcp/api.ts` 去掉 `as EditorApi` | handler 少一个键 `tsc` 直接失败 |

每条都做过反向验证(故意破坏 → 测试失败 → 还原)。

---

## 5. 验证记录(均在合并后的 main 上)

- `tsc -b --force`:零错误
- `npm test`:1462 个,**1461 pass / 0 fail / 1 skipped**(基线 1443/1442;+19 为新增守门测试)
- `vite build`:通过,无新增警告
- 真实渲染冒烟(puppeteer + 5197,每次看图确认):
  1. 渲染引擎搬家后:`bakeCard` 单卡预渲染,画面正确
  2. 分层调整后:`seePreview` 整帧预览经移动后的 `Stage` 渲染,画面正确
  3. vision 拆分后:`seePreview`(走 `ui-renderer`)+ `bakeCard`(走 `bake` + `worker-pool`),第二次命中缓存 5ms;`/api/vision/health` 200;无页面与服务端报错
  4. vision 预渲染侧(子 Agent,`PROMPTCUT_ROLE=prerender`,5231 端口):7 条请求拆分前后响应码与 JSON 逐字相同
- STT 端到端(PR #1 合并后):`stt_status` → `import_media` → `transcribe_media` → `get_transcript`,文字逐字对上

---

## 6. 需要知道的事

### 6.1 帧缓存与共享快照会失效一次
渲染引擎搬家后 `frameCode` / `captureCode` / `freezeCode` 指纹变化(路径进哈希),已有缓存需重渲一遍。哈希覆盖的**内容集合**已对齐成与搬家前一致,之后不会有额外失效面。vision 拆分不在任何指纹清单里,不影响指纹。

### 6.2 `out/frame-library/` 有约 16 万个文件,会拖垮 vite 的文件监听
合并 vision 后两个测试稳定超时,二分后确认**与代码无关**:同一提交在干净 worktree 里 2 秒过,在主检出目录超时。原因是 vite 以仓库根为 root 时监听器初次扫描 `out/`,磁盘缓存一冷就堵过 60 秒的 `fetchModule` 超时。已给 4 个只用 `ssrLoadModule` 的测试关掉监听(`f8ba00d`,另 2 处本来就是这么写的)。
**遗留**:在仓库根起 dev server 的冷启动同样受影响,值得单独处理(`server.watch.ignored` 加 `out/**`,或清理 `frame-library`)。

### 6.3 桌面端
- `prepare-runtime` 是黑名单式整目录拷贝,`server/bakery/`、`server/vision/`、`src/mcp/` 自动带上,无需改清单;`make-patch` 会把被移走的旧路径列入 `removed`,`apply-patch.ps1` 会删除。
- `node desktop/scripts/prepare-runtime.mjs --check` 当前只报「runtime/app 落后于源码」—— 预期内,**出桌面包前需重跑 `npm run prepare-runtime`**。
- Rust 壳(`desktop/src-tauri/src`)、`tauri.conf.json`、`package.json` 脚本、`vite.config.ts` / `vite.prerender.config.ts` 的入口路径都没变。

### 6.4 用户自定义卡 / 部件
- 用户卡(只存在于 `%LOCALAPPDATA%\PromptCut\runtime\app\src\cards\user`)实测只 import `kernel/types`、`kernel/frameReady`、`native/hud`、`magicui/vendor/cn` 与第三方包,**都没被移动**。
- `runtime/app/src/parts/lib` 里没有仓库之外的用户部件。注意:`src/parts/types.ts` 已搬到 `src/kernel/partTypes.ts` 且**没留转发壳**,今后若有人按旧指南写部件 `import … from "../types"` 会失败 —— `server/card-authoring-guide.md` 与 `server/README.md` 已同步新路径。

### 6.5 保留的例外与既有问题
- `server/test/bake-protocol.test.mjs → scripts/verify-bake-protocol.mjs`:该测试测的就是这个命令行脚本本身,静态测试里是唯一一项显式白名单。
- `server/vision/` 里有 3 条既有类型错误(原 111 / 876 / 1159 行,现 `ffmpeg-frames.ts:67`、`worker-pool.ts:115`、`render.ts:73`)。`tsconfig.json` 只 include `src`,`server/**` 一直不在检查范围;用同一份临时配置对比拆分前后,错误集合完全一致,按纯重构规矩未改。
- 两组旧的运行时循环依赖不在本次范围:`editor/io/proc ↔ combineImport ↔ skill/skillMode`(构建时那条 `INEFFECTIVE_DYNAMIC_IMPORT` 警告的来源)、`server/runners/*`(5 个文件)。
- 未更新的旧路径(历史记录,有意保留):`AGY-TASK-*.md`、`desktop/release/manifest-*.json`、`archive/python-cards/**`、`.pc-work/**`、`reply_to_users_goal.md:133`(提到 `src/parts/registry.ts`,现为 `src/kernel/partRegistry.ts`)、`scripts/probes/backdrop-probe.mjs:3` 的一句注释(该文件工作区有未提交改动,未碰)。

### 6.6 体积现状
超过 1000 行的逻辑文件还剩 4 个:`server/vite-plugin-cards.ts`(1511)、`server/frame-pipeline.mjs`(1155)、`server/vite-plugin-ai.ts`(1152)、`src/ai/useAiChat.ts`(1002)。前两个出度低、无人依赖,职责相对单一;建议下一轮先看 `vite-plugin-cards.ts`。

---

## 7. 过程说明

- 5 项由 5 个 Opus 子 Agent 各自在独立 worktree 完成,约束一致:纯重构、函数体与注释逐字保留、`git mv`、不许 `as`/`any`、不建 junction、不装依赖、不 push 不合并。每个分支由主会话独立复核(逐行读 diff + 自写对账脚本 + 类型检查 + 全量测试 + 涉及渲染的看图冒烟)后以 `--no-ff` 合入。
- 唯一一次合并冲突在 `EDITOR-DESIGN.md`(两个分支各改了同一行里的不同路径),两边的更新都保留。
- 5 个子 Agent worktree 与分支已清理(删前逐个确认无 junction、无未提交改动、已合并)。`.claude/worktrees/agent-af0dae85c12674862` 属于别的会话,内有 18 个未提交改动,未动。
- 事故记录:PR #1 审查阶段,清理带 `node_modules` junction 的临时 worktree 时 `git worktree remove --force` 顺着 junction 清空了主仓库 `node_modules`,已用 `npm ci` 恢复并验证(node-pty 可加载、puppeteer 可启动 Chrome)。此后所有 worktree 均建在仓库内靠向上解析依赖,不再使用 junction。

## 8. 提交索引

```
f8ba00d 测试:借 vite 做 SSR 加载的四个测试关掉文件监听
98c0f70 合并:vite-plugin-vision 2012 行拆成 server/vision/ 九个模块,外壳 56 行
  52d5859 文档:vision 解耦计划改成「已完成」
  e1caecb 修:ai-visual 的动态 import 路径要跟着搬家多退一级
  8333db0 测试:server/vision/** import 无环 + 外壳行数
  36490ba 重构(2/4):routes.ts 拆成八个模块
  5a12d3c 重构(1/4):vite-plugin-vision.ts 整体 git mv 进 server/vision/routes.ts
c0ab418 合并:理顺 kernel ← render ← editor 分层,消掉 15 条反向依赖
  212b310 / 997b6c1 / 53b0f49 / de9e26b / 1807811 / 530fa4e / f507951
a1d50db 合并:渲染引擎从 scripts/ 搬到 server/bakery/
  01361fb 重构(2/2):拆成七个模块   4967718 重构(1/2):整体 git mv
41848a9 合并:MCP 分发链改成路由表,非 UI 工具模块下沉到 src/mcp/tools
  7160020 / 11e499c / 37f08b6
d6d590e 合并:store 解掉 project ↔ actions 运行时循环,收窄门面导出
  955d6eb
e8d36e1 Merge pull request #1(含 fba57c3:补回 get_clip / set_camera3d、恢复注释、去掉 as EditorApi)
```
