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

## 要核对的几点

1. **桌面页面打开云端项目时，本地项目 id 与云端项目 id 是否一致；层表键对不对得上。**
   结论：对得上。要分清两个 id：
   - 共享项目 id（文档服务的空间，探针里是 `sp_…`）：只用于连接与空间；
   - 项目文档里的 `id`（`p-…`，创建者本地项目原来的 id，放云端时随文档一起上去）：桌面预渲染进程的 `entry.project.id` 是它，在线页面 `getState().project.id` 也是它（在线页面读层表用的是 `setProject(getState().project.id)`，不是 `currentDocProjectId()`；后者在共享项目里是空间 id）。
   探针 run3：桌面 `p-mulysgmc-62ece872`、在线页面 `p-mulysgmc-62ece872`、层表 body 的 `projectId` 同值，空间 id `sp_axashgh7pvxsskq7gvxyfeu2e5`。补推按 `contentId`（页面交来的项目文档 id）挑 entry。
2. **桌面自己 preload 渲出的层（含用户卡）会被推到云端素材服务，并写进云端层表。**
   结论：会。交接前本机渲好的重卡 H（120 帧，只在本机帧库里，就是真机缺陷的情形）交接后由补推推上去：日志 `render-node.backfill { frames: 120, segments: 2 }`，云端层表 H 那一层 120 帧清单齐、120 个块都在云端素材服务里（A2）。
   用户卡：桌面版自己按成本判它轻、本机 preload 不预渲染它（`picked: false`，探针 step0 记录），所以用户卡的层是由在线页面发布的清单计划（页面一律按重卡）经这台桌面的节点渲出、推上去、写进层表的（A3、A4）。
3. **渲染节点上报的代码版本与同一提交的在线构建一致（`requires.codeVersion`）。**
   结论：同一工作树里一致。探针在在线构建的脚本里找到了节点报的 64 位代码版本（`codeVersionInOnlineBuild: true`），在线页面的清单计划也被这台桌面认领了（节点侧按 `requires.codeVersion` 过滤，不一致就认领不了）。
   安装版：这台机器（笔记本）上没有安装版，没法直接比安装版 `runtime/app` 的 `frameCode`。按代码推：`frameCode` 哈希 `src/` 下全部源码（用户卡除外、换行统一成 LF）加几份服务端文件；`prepare-runtime.mjs` 从干净检出拷 `src/`，只挡 `src/__probe-*`。所以**在线构建必须从同一提交的干净检出做**（工作树里有未入库的 `src/` 文件、或 `src/__probe-*` 残留，代码版本就会和安装版不同，桌面节点一个在线计划都认领不了）。建议主会话部署时核一次：`node -e "import('./server/frame-code.mjs').then(m=>console.log(m.frameCode(process.argv[1])))" <安装版 runtime/app>` 与在线构建嵌的值比。
4. **撤掉时推送队列和节点都停干净，`nodes` 回空。**
   结论：停干净。A5：桌面页面离开项目后 `nodes: []`、`auto.bound: false`，预渲染进程诊断里没有 `push`，编辑器进程不再记着配置，日志 `render-node.teardown { reason: 'left', push: true, node: true }`。
   第一版有过一个问题（run2 查出）：撤掉时先等节点 `release()`，它要等手里在跑的那一批做完才返回，推送队列一直没停。改成先停推送队列、节点收尾最多等 10 秒。

## 验证

### 探针 `scripts/probes/desktop-auto-node-probe.mjs`（照壳的真实启动环境）

命令：`node scripts/probes/desktop-auto-node-probe.mjs --base-port 5750 --out out/auto-node-run3`，退出码 0，用时 574 秒。桌面版环境里的 `PROMPTCUT_*` 只有 `PROMPTCUT_DATA_DIR`、`PROMPTCUT_EXPORT_DIR`、`PROMPTCUT_PROJECTS_DIR`、`PROMPTCUT_WORK_DIR`（都在系统临时目录；第二遍多一个 `PROMPTCUT_AUTO_RENDER_NODE`）。

| 断言 | 结果 |
|---|---|
| A1 桌面进入项目后 `nodes` 里有这个项目的节点；`push.started` 目标是云端素材服务 | 过：节点 `prerender:LAPTOP-A56T03FK:5755` 连着；`push.started { docservice: 'page', url: 'ws://127.0.0.1:5750/hosted', asset: 'http://127.0.0.1:5750/media/api/asset' }`，推送与节点的素材服务都是 `source: 'page'` |
| A2 云端层表里有 H（交接前渲的）与用户卡 U1 那一层，字节在云端 | 过：H 120/120 块、U1 120/120 块，层表 v3 |
| A3 在线页面（另一个浏览器上下文 = 另一个设备 id）贴出 U1，没有图标与徽标 | 过：刚进时 U1 带「需要本地 PC 渲染辅助」徽标（桌面没渲它），164 秒后贴上 |
| A4 桌面页面关掉（节点照常在线）后，在线页面把 U2 改成新内容：在线页面的清单计划被这台桌面认领、切分，细任务由它完成，在线页面贴上 | 过：计划 `plan:sp_…@2#clips:…` 认领并切出 6 个细任务，本机完成 5 个（另一个是去重）；U2 的结果键换了（`5337cbf1…` → `a5ed607b…`），云端 120/120 块，在线页面贴上新内容 |
| A5 桌面页面回来（同一标签页刷新后回到共享项目，同项目重交只换票据，`starts` 仍是 1），再离开：`nodes` 回空、推送停 | 过 |
| A6 `PROMPTCUT_AUTO_RENDER_NODE=0`：不起节点、不推送 | 过：`nodes: []`，预渲染进程报 `off: 'disabled'`，编辑器进程不记不转，日志没有 `push.started` / `render-node.bind`，云端没有这个项目的层表 |
| 另核：两边项目文档 id 一致；节点代码版本在在线构建里 | 过 |

最后一行（节选）：`{"ok":true,"run":"mulys…","target":"local","steps":{…},"cleanup":{"deleted":[{"projectId":"sp_axashgh7pvxsskq7gvxyfeu2e5","result":"shared.admin.ok"},{"projectId":"sp_uqifextqqtzg2nh5khp4pq3l7b","result":"shared.admin.ok"}],"listening":[]},"ms":574104,"fails":[]}`

看过的图：`a3-online-u1.png`（在线页面舞台上 U1、U2 的闪光文字与 H 都是贴的快照，时间轴片段没有徽标）、`a4-online-u2-before.png`、`a4-online-u2-after.png`（U2 换成「U2 新内容 …」）。

前两次没过、已修：run1 交接后节点没起（`DOCSERVICE_MODES` 不认 `page`）；run2 A1 推送队列起步时落到本机素材服务（页面第一次交接时还没挑到素材服务）、A5 推送队列没停（见上）。

### 基线

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：3827 个，通过 3825，失败 0，跳过 2（退出码 0）。
- 新增单测：`server/test/auto-render-node.test.mjs` 11 个（ARN-01～08 开关、校验、交接、票据往返与缓存、等页面与续上、同项目 / 换项目、撤掉与起步期间撤掉、日志转发；RLY-01～03 中转与配置记忆），`src/editor/sync/renderNodeHandoff.test.mjs` 5 个（RNH-01～05），全过。

### 老路径回归：`c10-browser-probe.mjs --user-card --only-a4 --no-video --base-port 5750`

退出码 0，`ok: true`，`fails: []`，用时 1237 秒；用户卡端到端过（成员页 636 秒贴上桌面节点产的层）。创建者的编辑器日志里没有任何 `render-node.*` 行：环境变量配出来的节点（`PROMPTCUT_SHARED_CONFIG` + `PROMPTCUT_QUEUE_NODE=1`）照旧，动态交接按 `env-configured` 不接。探针日志与 run3 的编辑器日志里查过没有票据形状的串。

## 没做成的、没跑的

- **本机当主机（局域网主机）没跑端到端。** 代码上是同一套：创建者页面进本机托管的共享项目时也是用证明连本机 `/docservice`（`collab.ts` 的 `enableCollab` → `enterShared`），签得出 render 票据，交接的 `url` 就是本机的文档服务，推送的素材服务按「页面给的（本机当主机时页面挑不到远程的，是 null）→ 登记里别的机器的 → 本机」落到本机素材服务。没跑是因为放本机要让编辑器以 `PROMPTCUT_LAN_HOST=1` 绑局域网地址，会在宿主机上弹防火墙询问；安装版的壳也不设这个变量（放本机在安装版里要按提示重启编辑器）。
  另外核对了原来的 `editor` 模式：`PROMPTCUT_QUEUE_NODE=1` 不带 `PROMPTCUT_SHARED_CONFIG` 时，预渲染进程以本机身份连本机文档服务，落在 `local` 空间，**不在**共享项目的空间里，认领不到成员的任务——它本来就接不上本机托管的共享项目，所以没有「接到同一套」这回事；新路径用票据进空间，覆盖了这种情形。
- **安装版的代码版本没法在这台机器上比**（笔记本上没有安装版），见「要核对的几点」第 3 条的建议。
- **没对阿里云跑**（按任务书）。`--remote https://<站点>` 用法已留：不起本机托管组合，桌面页面当场建项目放云端（凭证是页面表单生成的，只在内存里用），结束时用创建者凭证删掉项目（`--keep-project` 不删）。

## 观察到的、不在本任务范围的

- **在线页面改了用户卡的参数之后，舞台上先接着贴旧内容的快照**，直到新一层写进层表（run3 A4：改完 1.5 秒截图 `a4-online-u2-before.png` 里时间轴已是「U2 新内容」，舞台还是旧文字；约 3.5 分钟后换成新内容）。层表按片段 id 记层，在线页面算不出内容键，分不出「这一层是改之前的」。语义说「只有这一帧没有预渲染结果、又轮到这台设备自己渲染时」显示「需要本地 PC 渲染辅助」，这里显示的是过期结果。属于在线页面（另一个子智能体 `claude/online-user-cards-2` 的范围），建议主会话转给那边判定。
- **老路径的推送队列起步时也会先落到本机素材服务**：c10 回归里 `push.started` 的 `asset` 是 `http://127.0.0.1:5755/api/asset`，登记到了才换成云端。新路径由页面先交素材基址避开了；老路径（探针、独立渲染主机）没动。
- 自动节点绑着某个共享项目时，这台桌面上别的本地项目的预渲染帧写进帧库也会进同一个推送队列（快照钩子不分项目，老的环境变量路径也一样）；补推只补这个项目的 entry。只要同时开着别的本地项目才会有，影响是多推一些块到这个项目的素材服务。记在这里，没改。

## 建议主会话改的文档

- `docs/plan/TODO.md` 第 50 行「加入共享项目的桌面应用自动成为渲染节点」这一条划掉（或改成已落地，指向本报告）。
- `docs/plan/render-queue-contract.md`：
  - J.5「开关」：补一句——除 `PROMPTCUT_QUEUE_NODE=1` 外，页面交来共享配置（`POST /api/frames/render-node`）时也起本机节点，开关 `PROMPTCUT_AUTO_RENDER_NODE=0` 关；环境变量已配节点时不接交接。
  - J.12 第 2 条「推送只在显式开启时生效」：补「或页面交来了共享配置」；并注明模式名 `page`（`DOCSERVICE_MODES` 已加）。
  - J.13 素材服务基址的顺序改成：`PROMPTCUT_ASSET_URL` → 页面给的 → 服务地址登记里别的机器的 → 本机。
- `docs/plan/auth-contract.md` 第 11 节「Node 进程怎么拿凭证」：补第三种——桌面版的预渲染进程不读配置文件，由页面经编辑器进程交 render 角色的连接票据（`owner: { kind: 'user' }`），每次建新会话经 HMR 向页面要一张；不交口令与 `K`。第 8 节 `kind: 'conn'` 的例子已经写着「页面替本机的预渲染进程要一张 render 票据」，正好对上。
- `docs/semantics/` 不用改：`product/platforms.md`「渲染节点」「桌面应用」、`product/document-service.md`「票据」「渲染任务队列」的承诺都做到了，没有碰到做不到的地方。机制层（`mechanism/platforms.md` 或 `mechanism/document-service.md`）如果要写，可写「页面交配置、票据经 HMR 往返、等页面、撤掉」这一段和 5 秒 / 10 秒 / 30 秒几个数字。

## 提交

见 `git log main..claude/desktop-auto-node`。
