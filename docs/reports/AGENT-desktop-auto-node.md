# AGENT 报告：桌面应用自动成为共享项目的渲染节点

分支 `claude/desktop-auto-node`，worktree `.worktrees/desktop-auto-node`，起点 main `2e1518a3`（v0.7.1）。端口段 5750～5759。

## 任务

落地 `docs/semantics/product/platforms.md`「渲染节点」里「加入共享项目的桌面应用自动成为这个项目的渲染节点」，修真机缺陷：安装版桌面打开放云端的项目，预渲染产物不推到云端、也不成为渲染节点，浏览器端用户卡全部显示「需要本地 PC 渲染辅助」。

## 设计

### 三段与数据流

```
页面(桌面版,src/editor/sync/renderNodeHandoff.ts)
  │ 进入共享项目:POST /api/render-node/bind { url, projectId, contentId, assetBase?, ticket }
  │ 离开项目:    POST /api/render-node/unbind { projectId }
  │ 答票据:      HMR pc:render-node {type:'ticket',reqId,projectId} → POST /api/render-node/ticket { reqId, ticket|error }
  ▼
编辑器进程(server/vite-plugin-prerender.ts + server/render-node-relay.mjs)
  │ 记住配置(不记票据),转给预渲染进程;预渲染进程重启后照记下的再转一次(不带票据)
  │ 预渲染进程要票据:POST /api/render-node/ticket-request { projectId }(只认不带 Origin 的本机请求)→ 经 HMR 问页面
  ▼
预渲染进程(server/vite-plugin-frames.ts + server/auto-render-node.mjs)
    POST /api/frames/render-node / .../unbind / GET 状态
    建推送队列(startArtifactPush)与本机节点(startQueueNode),都接「自动链接」;补推交接前已有的层
```

- `url` 是页面连的那个文档服务：云端项目是托管端的 `wss://…/hosted/`，局域网成员是主机的 `/docservice`，本机当主机就是本机的 `/docservice`。三种走同一套。
- `projectId` 是共享项目 id（文档服务的空间）；`contentId` 是页面里项目文档的 `id`（层表键 `layers:<id>` 用它，补推时按它挑 entry）；`assetBase` 是页面挑到的素材服务（`assetTiers.ts` 的 `startUploadTarget` 顺手交）。
- 预渲染进程选推送的素材服务：`PROMPTCUT_ASSET_URL` → 页面给的 → 服务地址登记里别的机器的 → 本机（原 J.13 的顺序里插进「页面给的」）。页面后来才给或换了，下一次调用就换上。

### 凭证与票据往返

- 不交项目口令与 `K`。页面在自己已认证的连接上签 `auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'user' } }`，交给预渲染进程。
- 预渲染进程的 `protocols()`（每次建新会话调，接续不调）：手里的票据剩 30 秒以上直接用（票据无状态，推送队列与节点两条连接可共用），否则向页面要一张；两条连接同时要只要一次。
- 要不到（没有页面连着 HMR 时编辑器立即回「没有页面」，页面 10 秒不交回回超时）：`protocols()` 抛错，会话层照常退避（最长 15 秒）重试；已建的会话照常用到断开为止。状态记「等页面」，日志只打第一次和每 20 次一次。页面回来（刷新后回到项目、或同项目再交接）交来新票据，下一次重试就续上，不重建。
- 素材票据仍由预渲染进程在自己的会话上 `auth.ticket { kind: 'asset', access: 'rw' }` 取（原 `ticketFor` / `createTicketSource`）。
- 票据、口令、`K` 不进日志、诊断、报告；单测 ARN-03、RLY-03 核对。

### 生命周期

- 进入：`syncManager.bind` 接上共享项目（`kind: 'shared'`，桌面版）时交接；项目文档 id 晚到（加入别人的项目时 store 稍后才换成文档服务那份）再交一次，不另签票据。
- 同一个项目（同 `url` + `projectId`）重复交接只换票据、素材基址、文档 id，不重建；换了项目先撤旧的（让掉认领）再起新的。
- 离开：本页面从共享项目回本机空间、取消协作、换开别的项目时撤（只撤同一个项目的，别的标签页在别的项目上的不受影响）。页面刚打开时先接本机空间不算离开。页面关掉、桌面版转入后台也不算离开：节点照常在线（语义「关闭编辑界面后转入后台运行」）。
- 撤掉：`release()` 让掉手里全部认领、停节点、关连接；停推送队列并从管线上摘下（`pipeline.pushQueue = null`）；清素材回退；`leaveQueueMode()` 把交给队列的快照交回本机自己产。`/api/frames/queue` 的 `nodes` 回空。
- 预渲染进程崩溃重启：编辑器进程在重放 preload 之后照记下的配置再转一次。
- 推送队列文件按项目分目录（帧库下 `push/<文档服务 host>-<项目 id>`）：撤掉时没推完的段留给同一个项目下次接着推，不会推进别的项目的素材服务。

### 补推交接前已有的层

推送队列只在帧**写进**帧库时进队。用户在交接之前就渲过的层（真机缺陷里「两小时前渲过、只在本地」），交接后 preload 命中已有帧、不再写，永远到不了素材服务，层表也不写。所以交接后每 5 秒扫一次：这个项目（`entry.project.id === contentId`）正被会话用着的 entry，每个补一次——写层表（`publishLayerMap`），每张卡已有的快照帧按段进推送队列（队列去重，素材服务已有的块跳过）。轨道流不补（在线页面不用轨道流）。

### 开关

- `PROMPTCUT_AUTO_RENDER_NODE=0`：关掉自动成为渲染节点与自动推送（编辑器进程不记不转，预渲染进程也拒），缺省开。给观察端（C6.6 T9，即卡片同步验收里只看不渲的那一端）用。
- 环境变量已经把进程配成节点或推送方时（`PROMPTCUT_SHARED_CONFIG`、`PROMPTCUT_QUEUE_NODE=1`、`PROMPTCUT_PUSH=1`、`PROMPTCUT_NODE_PROFILE=host`）不接动态交接，老路径原样（探针、独立渲染主机）；`PROMPTCUT_PUSH=0`、无头实例一律不接。

### 日志

编辑器进程的日志转出 `[prerender] [queue-node] render-node.*`（交接、起停、补推、等页面）与 `[prerender] [artifact-push] push.started|skip|asset-base`：安装版用户只交得出编辑器进程的日志，「有没有成为节点、推到哪台素材服务」要在那里看得到。`queue.started` 等别的行照旧不转。

## 改动的文件

| 文件 | 改了什么 |
|---|---|
| `server/auto-render-node.mjs`（新） | 预渲染进程一侧的状态机：开关、配置校验、交接 / 同项目 / 换项目 / 撤掉、票据缓存与向页面要票据 |
| `server/render-node-relay.mjs`（新） | 编辑器进程一侧：票据中转（HMR）、配置记忆 |
| `server/vite-plugin-prerender.ts` | `/api/render-node/*` 五个接口；预渲染进程重启后重交配置 |
| `server/vite-plugin-frames.ts` | `startArtifactPush` / `startQueueNode` 接自动链接；`selectAssetClient` 加「页面给的」；`/api/frames/render-node`；补推；撤掉；`/api/frames/queue` 带 `auto` 状态 |
| `server/render-node/session-diag.mjs` | 转发器多放行自动节点与推送建队的行 |
| `src/editor/sync/renderNodeHandoff.ts`（新） | 页面一侧：交接、素材基址、答票据、撤掉；在线构建剪枝 |
| `src/editor/sync/syncManager.ts` | `bind` 里交接 / 撤掉；render 票据的签发钩子 |
| `src/editor/media/assetTiers.ts` | `startUploadTarget` 顺手把素材基址交给交接模块 |
| `server/test/auto-render-node.test.mjs`、`src/editor/sync/renderNodeHandoff.test.mjs`（新） | 单测 |
| `scripts/probes/desktop-auto-node-probe.mjs`（新） | 照壳启动环境的端到端探针 |

没有碰另一个子智能体的文件清单，也没有碰生成快照的输入（`createSnapshot.ts`、`snapshot/*`、`snapshotRename.ts`、`server/bakery/*`、`CAPTURE_FILES`）；`server/frame-pipeline.mjs` 没改。
