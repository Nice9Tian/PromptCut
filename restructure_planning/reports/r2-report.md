# R2「双舞台与协议补齐」实施报告

- 分支：`worktree-agent-ad0f905cb3294844d`
- 工作区：`C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-ad0f905cb3294844d`
- 起点：`git merge --ff-only main` 到 `6876dd7`，工作区干净
- dev server：`npx vite --port 5211 --strictPort --host 127.0.0.1`，舞台端口随之 5212 / 5213；收尾已全部关掉
- **非 legacy 模式的开关名：`?preview=stage`**（缺省、以及任何别的值都是 legacy）

## 提交

| 提交 | 内容 |
|---|---|
| `74f3539` | 舞台 RPC 协议补齐：角色闸门、`PlayReply`、`RenderAborted` 加 `'role'`、事件来源判据 |
| `58f0a8f` | `stageBridge` 的 `whenStageReady` / `pushProject`、事件来源过滤、后台舞台单飞队列 `stageJobs` |
| `2d73576` | 两个舞台端口（反向代理 + OAC 头）与第二个舞台 iframe、`?preview=stage` |
| `bde8439` | 进程隔离探针；探针测试页改由真 http 服务发；冒烟补 `get_layout` 与移动工具拖动 |

## 改了哪些文件

新增
- `server/stage-ports.mjs` —— `STAGE_PORTS = 2` 的算式，四处共用（起代理 / 拼 CORS / 写 port.json / 页面拼 src）
- `server/vite-plugin-stage-ports.ts` —— 两个反向代理端口
- `src/editor/previewMode.ts` —— `?preview=stage` 开关、舞台实例名与 src / targetOrigin
- `src/editor/stageJobs.ts` —— 后台舞台单飞队列 + `renderAbortAction`
- `src/render/stageRpc.test.mjs`、`src/editor/stageBridge.test.mjs`、`src/editor/stageJobs.test.mjs`
- `scripts/probes/stage-isolation-probe.mjs`

改
- `src/render/stageRpc.ts`、`src/StageView.tsx`、`src/editor/stageBridge.ts`、`src/editor/Preview.tsx`、`src/mcp/common.ts`
- `vite.config.ts`、`server/vite-plugin-prerender.ts`（CORS 名单）、`server/vite-plugin-ai.ts`（port.json）
- `scripts/probes/stage-rpc-probe.mjs`、`scripts/probes/editor-preview-smoke.mjs`
- `scripts/probe-card-costs.mjs`、`scripts/probes/snapshot-size-probe.mjs`、`docs/snapshot-size-audit.md`（`id=back` → `id=B`）
- `package.json`（`npm run preview` 5191 → 5195，见下）

## 决定与理由

1. **开关名 `?preview=stage`，缺省 legacy。** 任务书 D5 / F2 只定义了 `?preview=legacy`，而「没有 `legacy` 就是新路」在 R2 里不成立：用户手里那份编辑台刷新一下就会踩上跨源双舞台，和「可见行为逐项不变」直接冲突。所以另起一个显式值。`StageView` 自己那个 `LEGACY`（`?preview=legacy` 时 `setProject` 立刻按跳转重算）**一个字没动**，而且 `Preview` 从来不把 `preview` 参数传进 iframe，所以它的行为和今天完全一样。
2. **队列的三档 vs RPC 的三个枚举值。** 任务要求 `job: 'probe' | 'catchup' | 'measure'`，J4 的 RPC 枚举是 `'probe' | 'catchup' | 'bake'`，D4 和 E0 又明写「页面侧测量进场先 `setRole('back', { job: 'catchup' })`」。做法：**队列一侧分三档**（`catchup` > `measure` > `probe`，优先级要分），**RPC 一侧不加第四个值**，`measure` 映射成 `'catchup'`。舞台分辨不出「补跑」和「测量」的差别——它要的语义（探针挂起、自己灌的项目掐出来的 `'project'` 不重发）完全一样。
3. **`renderAbortAction` 把 E0 五种 reason 的规矩做成纯函数**，放 `stageJobs.ts`，配单测。R2 里没有 `render` 的生产调用方（父页不对可见舞台发 `render`，探针是 R4），所以规矩先钉在一个能测的地方，R4 / R5 直接用。
4. **legacy 单舞台下队列不发 `setRole`。** `backStage()` 在 legacy 下退回可见舞台，对它发 `setRole('back')` 会清掉快照 / 抑制集合、停节拍循环——用户眼前的画面就没了。队列照常串行化，行为和今天一样。
5. **`measureContentBoxes` 保留「舞台没就绪就当场说清楚」的早退**，不排队等。队列会一直等到有舞台为止，而这条路接的是 Agent 的 `get_layout`，挂住一次工具调用不如让它拿到提示再来一次。
6. **`syncProject` 那处（`src/mcp/common.ts`）按要求保持原样**，只是它和 `pushProject` 现在共用同一个 `send()`（串行链 + 基线）。单测里专门钉了「绕过基线会让下一次同步静默不发」这条 E0 点名的坑。
7. **OAC 头加在代理的所有响应上**，不挑舞台文档。Chromium 按 BrowsingInstance 缓存「这个 origin 是不是 origin-keyed」，**第一次加载**漏掉就整轮失效；多加的那些响应上它不起任何作用。
8. **Host 头原样转发给 vite**，所以 vite 那边看到的 Host 就是舞台端口，`/api/**` 的同源守卫（`originOk` 比 `origin === "http://" + host`）照样判同源，**不用给守卫开任何口子**。
9. **端口被占就不起那一个代理**，注入给页面的端口表里没有它，`dualStage()` 看到表不全就退回同源单舞台。dev server 不能因为一个多出来的端口起不来就挂掉。
10. **页面拿端口靠注入的 `window.__PC_STAGE_PORTS__`**（`transformIndexHtml`，会等代理起完），不靠 fetch：iframe 的 src 在第一次 render 时就要定下来，多一次异步往返就多一帧空窗。探针 / 桌面壳走 `GET /api/stage/ports`。
11. **舞台源按当前页面的 hostname 拼**，不写死 127.0.0.1：用户从 `localhost` 打开时两个 iframe 也得是 `localhost`——同 host 不同端口 + OAC 头才是 `docs/g0-a-webview2-probe.md` 实测过的那条路。
12. **`hostCapabilities.stageId` 缺省从 `"front"` 改成 `"A"`**：缺省值也不该再把实例名读成角色名。
13. **`npm run preview` 的端口 5191 → 5195**：编辑器在 5190 起来之后 5191 就是它的舞台端口，两个脚本会撞。

## 验收数字（dev server 5211，舞台端口 5212 / 5213）

### 类型与单测
- `npx tsc -b --force`：**0 错误**（每次改动后都跑，末次干净）
- `npm test`：**1505 / 1504 通过 / 0 失败 / 1 跳过**（main 基线 1481 / 1480 / 0 / 1；新增 24 条 = `stageRpc` 4 + `stageBridge` 10 + `stageJobs` 10）

### `scripts/probes/stage-rpc-probe.mjs`（各跑 3 次，`fails` 全为 0）
| 模式 | `setTime` 舞台主线程 p90（3 次） | 中位数 | 17×10 `rectsWithBounds` p50 |
|---|---|---|---|
| 跨源双舞台（缺省） | 2.40 / 2.80 / 2.50 ms | **2.50 ms** | 0.30 ms |
| `--legacy`（同源） | 2.90 / 2.70 / 2.90 ms | **2.90 ms** | 0.20～0.30 ms |

含三维卡的那一组 `setTime` p90：跨源 2.30 / 2.10 / 2.70 ms，legacy 2.60 / 2.40 / 2.90 ms（只报数，不判）。

角色闸门（两种模式都过）：
- 对默认角色（`front`）的实例发 `render` → `{ aborted: true, reason: 'role' }`
- 对它发 `setTime(t, { probe: true })` → `{ aborted: true, reason: 'role' }`
- 不带 `probe` 的 `setTime` **不**被挡（`{ path: 'set' }`）
- **同一个实例** `setRole('back')` 之后就过闸门了（回 `reason: 'project'`，因为那会儿它还没有项目）——闸门判的是角色，不是实例名
- `caps.stageId === 'A'` / `capsB.stageId === 'B'`，而此刻两个的角色都还是缺省的 `front`
- `play` / `pause` 都回统一后的 `{ ok: false, reason: 'unsupported' }`
- B 那个 iframe 收到的 `probe-frame` 条数 = 0（事件只从发起它的那个 iframe 出来）

### `scripts/probes/stage-isolation-probe.mjs`（跑 3 轮，每轮内部 3 次）
| 轮 | CDP `type: 'iframe'` target | A 死循环 2.5 s 时父页最坏 rAF 间隔 | 中位数 |
|---|---|---|---|
| 1 | **2** | 11 / 4.3 / 6.3 ms | 6.3 ms |
| 2 | **2** | 6.6 / 4.5 / 7.8 ms | 6.6 ms |
| 3 | **2** | 6.3 / 5.2 / 6.1 ms | 6.1 ms |

三轮中位数的中位数 **6.3 ms < 20 ms**。target 的 url 是 `http://127.0.0.1:5212/?stage=1&id=A` 和 `:5213/?stage=1&id=B`。
每一轮都断言了「A 真的卡满了 2500 ms」（`blockedMs: 2500`），不然这个数是白量的。
对照：`window.originAgentCluster` 两个 iframe 都回 `true` —— 印证任务书那句「不能当判据」。

**量法上的一条更正（重要）**：这台机器上 Chrome 的 BeginFrame 退到 10 Hz —— 实测连 `about:blank` 的 rAF 间隔中位数都是 **100.4 ms**、最坏 100.9 ms，编辑台（legacy 和 stage 都一样）也是 100.4 ms。那时候「父页最坏 rAF 间隔 < 20 ms」**在任何实现下都不可能成立**，量到的是显示节拍不是卡顿。所以探针带 `--disable-gpu-vsync --disable-frame-rate-limit` 跑，rAF 不再等垂直同步，间隔就等于主线程两次让出之间的时间——正是这条判据真正要问的量。同样开关下的对照：空白页最坏 1.3 ms，不卡舞台的编辑台最坏 3～6 ms（探针里 `baseline` 一项，跑的时候别的 Agent 在忙时会飘到 30 ms 上下）。

### `scripts/probes/editor-preview-smoke.mjs`（两种模式都 `fails: []`）
| 项 | legacy（缺省） | `--stage`（跨源双舞台） |
|---|---|---|
| 舞台显示两张卡、本地帧 | 45 / 45（t=1.5 s @30fps） | 45 / 45 |
| `pushedProject('front')` 基线 == store 项目 | 是 | 是 |
| 选中描边贴内容（比画框小） | 176.3 × 118.3 vs 688 × 387 | 176.3 × 118.3 vs 688 × 387 |
| 点内容中心选中它 | 是 | 是 |
| 点空白取消选中 | 是 | 是 |
| 播放 1 秒后舞台跟上 | t=1.433，帧 43 / 43 | t=1.467，帧 44 / 44 |
| `get_layout`（`contentLayoutOf`，走单飞队列） | `contentBox {714,375,492,330}` | **同一个数** `{714,375,492,330}` |
| 移动工具拖 40×24 后写进 frame | `{x:112,y:67}` | **同一个数** `{x:112,y:67}` |
| `backRole()` / 有没有独立 back | `front` / 否 | `back` / 是 |
| 两个 iframe 的源 | —— | `:5212` / `:5213`，都不是编辑器的 `:5211` |
| 页面错误 | 0 | 0 |

`get_layout` 和拖动在两种模式下回的是**逐位相同**的数——跨源模式下它是经后台舞台（另一个进程里的 iframe）量出来的。

### 端口与代理本身
- `GET /api/stage/ports` → `{"ok":true,"count":2,"ports":[5212,5213]}`
- `curl -I http://127.0.0.1:5212/?stage=1` → `origin-agent-cluster: ?1`
- Range/206 透传：`Range: bytes=10-99` 打 5212，回 `206 Partial Content` + `content-range: bytes 10-99/453` + `accept-ranges: bytes`，和直连 5211 逐项一致
- HMR：两个舞台 iframe 的控制台都打出 `[vite] connected.`（WebSocket 经代理的 `upgrade` 转发到 vite）
- 注入：`<script>window.__PC_STAGE_PORTS__=[5212,5213];</script>` 在 `<head>` 最前

## 对任务书的更正建议

1. **任务书原句**（E1 / J4）：「`job: 'probe' | 'catchup' | 'bake'`」，而本次任务描述写的是「`job: 'probe' | 'catchup' | 'measure'`」。
   **怎么做的**：队列一侧分三档 `catchup` / `measure` / `probe`（优先级要分），RPC 一侧保持 J4 的三个枚举值，`measure` 映射成 `'catchup'`。
   **为什么**：D4 明写「测量进场先 `setRole('back', { job: 'catchup' })`」，E0 的「掐断后不重发」例外也把「D4 的页面侧测量」列在 `job: 'catchup'` 名下。舞台分辨不出这两者的差别，加第四个枚举值只会让「例外按工作项判」这条规则多一个分支。**建议在任务书里把这两处口径统一成：队列分三档、RPC 三个值、测量走 `catchup`。**
2. **任务书原句**（R2 验收）：「A 舞台死循环 2.5 秒时父页最坏 rAF 间隔 < 20 ms」。
   **怎么做的**：探针带 `--disable-gpu-vsync --disable-frame-rate-limit`，量到 6.3 ms 中位数。
   **为什么**：不带这两个开关时，这台机器上连 `about:blank` 的 rAF 间隔都是 100.4 ms，判据恒不成立。**建议在任务书里补一句量法前提**（和 `oac-probe.mjs` 的 7～17 ms 也对得上：那份是在有显示节拍的会话里跑的）。
3. **任务书原句**（E1）：「桌面版写进 port.json」。
   **怎么做的**：写进了 `%TEMP%\promptcut\port.json`（`server/vite-plugin-ai.ts` 里唯一一处写 port.json 的地方），新增字段 `stagePorts: [P+1, P+2]`。
   **为什么**：`desktop/` 下**没有**任何写 port.json 的代码——桌面壳把编辑器端口硬编码成 5210（`lib.rs:24` / `:435`）。**建议任务书改成「写进 `%TEMP%\promptcut\port.json`」**。
4. **新发现的连带影响：舞台端口是「编辑器端口 +1 / +2」，会吃掉相邻端口。**
   - `npm run preview` 原本是 5191 —— 正好是 5190 编辑器的第一个舞台端口。本次改成 5195。
   - 用户的 `dev-test`（5197）起来之后会占 **5198 / 5199**，而 5199 在用户的保留端口列表里。**建议要么把 `dev-test` 挪到别的端口，要么把舞台端口的偏移做成可配。**
   - 桌面版 5210 的舞台端口是 5211 / 5212。
5. **`?preview=stage` 这个值是我定的**（任务书只定义了 `?preview=legacy`）。建议写进任务书 F2 / D5，R7 翻缺省时把它改成「`?preview=stage` 保留为显式开，缺省即新路」。

## 没做成 / 留给后续步骤

- **`play` / `pause` 仍回 `{ ok: false, reason: 'unsupported' }`**（K4 的节拍循环本体是 R5）。协议面（`PlayReply`、七种事件的类型、来源过滤、父页分发骨架）已就位，R5 只改这两个函数体和 `Preview.tsx` 里那个 `switch` 的分支体，不用再动协议。
- **七种事件在 R2 里一条都不会来**：没有节拍循环（`frame` / `ended` / `settled`）、没有探针（`probe` / `probe-frame`）、没有降级（`demote`）、素材层还没进舞台（`mediaReady`）。来源过滤是纯函数 + `stageBridge` 路由，有单测；端到端只能等 R4 / R5。
- **`setRole('back')` 的清理只到骨架**：`suppressed` / `snapshots` / `streamPlanes` / `awaiting` / `settling` 五个集合 + `beatPaused` + `catchUpGen` 都清了，但平面本体是 R3、`streamPlayer` 是 R8、循环本体是 R5。
- **队列里现在只有 D4 的页面侧测量**一种活。R4 的探针、R5 的补跑往 `runBackJob('probe' | 'catchup', …)` 里排即可。
- **后台舞台目前拿不到项目**，除非有人经 `pushProject('back', …)` / `syncProject('back', …)` 推（`get_layout` 会推）。`ProbeGate`（R4）负责开机就把它喂上。
- 没碰 R4 的 `src/render/pipelinePlan.mjs` / `pipelineTuning.mjs`，没碰 R6 的就绪索引 / SSE / `server/frame-pipeline.mjs` / `mirror-store.mjs` / `snapshot-store.mjs` / `vite-plugin-mirror.ts` / `src/render/dataMirror.ts`。
- 没摘 `opacity: 0`、没删 `mediaRects`（R7）。

## 桌面壳 Rust 侧需要配合改的清单（**本次没改**）

1. **`desktop/src-tauri/src/lib.rs` 的端口占用预检（`probe_port` `:160-164`，弹窗 `:274-284`）只查 5210。**
   舞台端口是 5211 / 5212，它们被占时代理起不来，页面静默退回同源单舞台（R2 无感，**R7 之后就是没有后台舞台**）。
   建议：预检把 5211 / 5212 一起查，弹窗点名是哪一个被占。端口号从 port.json 的 `stagePorts` 或同一条「+1 / +2」算式来。
2. **`desktop/scripts/smoke-boot.mjs` 只等 5210 应答。** 建议补等 5211 / 5212 各回一次 200（带 `Origin-Agent-Cluster: ?1`），装完就能发现代理没起来。
3. **不用改的两处，但值得复核一遍**：
   - `lib.rs:329` 的 `on_navigation` 已经按 host 放行（`127.0.0.1` / `localhost` / `*.localhost`，**不看端口**），所以 5211 / 5212 的 iframe 能加载。
   - `agent_webview::browser_args`（`agent_webview.rs:82`）只关了 `msWebOOUI,msPdfOOUI,msSmartScreenProtection`，**没有**关站点隔离，OAC 头照常生效（WebView2 153 已在 `docs/g0-a-webview2-probe.md` 实测过）。
   - `desktop/src-tauri/capabilities/remote.json` 的 `remote.urls` 只列了 5210。**舞台页面不调任何 Tauri 命令**，所以不加反而更干净；将来舞台真要 IPC 时才需要把 5211 / 5212 补进去。
4. **`prepare-runtime.mjs` 不用改**：它是 `copyRecursive(PROJECT_ROOT, appDir, shouldCopyApp)` 整棵拷，新增的 `server/stage-ports.mjs`、`server/vite-plugin-stage-ports.ts`、`src/editor/*.ts` 自动带上。
