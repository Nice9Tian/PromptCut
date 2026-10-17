# 任务：账号项目里在线页面画出用户卡、云端渲染服务进项目

2026-10-18 写（Claude 调试会话），同日按主会话的复核改过一版。交给 Antigravity 的 Argon 新会话做。

## 0. 一句话

在项目 `sp_4lcukykm2blylc5lok7za46yu3`（「九天之测试」，账号 9tian）里，户型图那张用户卡 `fp-photo-scan` 原来在在线页面上显示「需要本地 PC 渲染辅助」。这一条主会话已经修好：节点上的舞台 nginx 改了，这张卡在两台舞台上都是 `ready`，提示没了（第 1.1 节）。

还没好的有五处，都在第 1 节：

- 卡里的户型图是空白（1.4）；
- 舞台和编辑器不同站，舞台读素材的 cookie 用不上（1.5）；
- 打开项目时卡一直是沙漏，要动一下播放头才画出来（1.6）；
- 文档服务不把账号项目的在线成员算进目录，渲染服务不进项目（1.2）；
- 渲染服务还在跑旧版本（1.3）。

全修好以后：在线页面（visuhive.com/editor）打开项目就能直接画出带户型图的这张卡；渲染服务能进项目，能给判重的卡出预渲染结果。

## 1. 现状与证据（2026-10-18 02:40～03:20 JST 实测）

### 1.1 舞台站点的 nginx 只认旧票据（**已由主会话修好**，只做回归核对，不再改）

- 修之前，页面上：两台舞台握手正常（`__pcStageHandshake().phase === "ok"`，`__pcStageWatch()` A、B 都是 `alive`），`/editor/runtime-config.json` 的 `onlineCardExec` 是 `true`，但 `__pcCardExecDiag()` 回 `available: false`，`fp-photo-scan` 的运行状态是 `not-isolated`。
- 原因：节点上 `/etc/nginx/sites-available/promptcut-stages` 的 `map $http_authorization`（第 17 行）和 `pc_grant_cookie`（第 28 行）只认 `v1.` 开头的票据。账号项目的素材票据是 43 个字符的 base64url，`/media-s/<sid>/_grant` 的交接被拒，执行闸门一直关着。仓库里早修了（`f49a4220`），节点上的配置没按新模板重新生成。
- 主会话 2026-10-17 18:00 UTC 按模板改了第 14（注释）、17、28 三行，别的没动；`nginx -t` 后 reload。备份 `/root/nginx-promptcut-stages.bak-20261017T180027Z`，记录在 `docs/local.md`「舞台站点票据形状修正（2026-10-18）」。
- 修之后：`__pcCardExecDiag()` 回 `available: true`，`fp-photo-scan` 在 A、B 两台舞台都是 `ready`；页面上没有「需要本地 PC 渲染辅助」。

### 1.2 文档服务不把账号项目的在线成员算进目录

- 渲染服务 `curl -s http://127.0.0.1:5399/status` 的 `directory.list` 里，这个项目一直是 `enabled: true, active: false, members: false`。我开着一个在线页面进了这个项目，它也还是 `members: false`。
- 渲染服务只进 `active` 的项目，所以 `projects` 是 `[]`、`queue.nodes` 是 `[]`。看画面请求进来以后，按 `blocked: { "not-ready": 1 }` 一直排着（我用主服务的密钥直接发过一条，就是这样卡住的，之后被孤儿清理撤回了）。这个项目里也没有任何层是渲染服务渲的。
- `active` / `members` 由 `server/docservice/modules/hosted.mjs` 的 `activeFor` 和 `present` 算。连接进来时由 `connect()` 用 `classOf(principal)` 记一笔。要查清的是：账号项目的成员连接（`server/docservice/account-hosted.mjs` 里 `scope: 'member', realm: 'account'` 那种）为什么没记进 `present`。是 `connect()` 没被调用、`inSpace` / `isHostedProjectId` 没认出来，还是别的原因。
- 同一个文件里另有两个小毛病，顺手一起修：`bump()` 不返回新值，所以 `disconnect()` 里 `bump(...) === 0` 永远不成立，`lingering` 不会被写；`next` 为 0 时也不删那个键，计数会一直停在 1。改之前先写单测，把这两个问题钉住。

### 1.3 渲染服务还在跑旧版本

- `pm2 describe promptcut-render`：脚本是 `/opt/promptcut-render/releases/41b6d3358438/server/hosted-render/main.mjs`，工作目录是 `/opt/promptcut-render/current`。Agent 主服务、root 调度、任务槽已经跑 `35f7b2abb9db`。在线编辑器（`/opt/promptcut-hosted/editor`）是哪个提交构建的没核实过：目录里没有构建信息文件，开工时自己查。
- 它的日志每 10 分钟报一次 `render.code-mismatch`，`detail` 是「渲染服务与在线页面（或 Agent 服务）不是同一个提交：它们发的任务这台一个也认领不了」。`status` 里的 `codeVersion` 是 `{ editor: "different", agent: "unknown", match: false }`。
- 环境变量里 `PROMPTCUT_RENDER_USER_CARDS=isolated`，`isolation.enabled: true`，但 `isolation.runs: 0`：项目没进来，隔离工作进程（专门渲用户卡的那个）就从没起过。

### 1.4 卡里的户型图是空白：舞台里没有 `/@media` 这条路

- 1.1 修好后，在线页面上这张卡画出来了（纸张、扫描线、说明文字都在），但纸面是空白，左上角是一个破图标。
- 这张卡的参数 `photo` 是文本控件，值是素材库的 `cardUrl`，形如 `/@media/<哈希>.jpg`（`server/card-authoring-guide.md` 第 4.7 节就是这么教的）。卡片直接拿它当图片地址。跨源舞台在 `s1`/`s2` 源上，nginx 只给 `/media`、`/media-s/`、`/editor`、`/catalog/`，`/@media/…` 是 404。
- 契约 `docs/plan/online-card-exec-contract.md` 第 4.1 节规定舞台取素材用 `/media-s/<sid>/media/<哈希>`。素材效果卡走 `src/render/cards/mediaSource.ts` 的 `cardMediaUrl`，已经按这条换了。用户卡自己写的 `<img src={params.photo}>` 没人换。
- 修法方向（三级，用户看不出区别之外的部分自己定）：舞台里给同步来的用户卡传参数时，把形如 `/@media/<哈希>[.扩展名]` 的字符串换成 `remoteMediaUrl(…)`（`src/render/mediaTier.ts`），挂卡的地方在 `src/render/Stage.tsx` 第 374～378 行附近。桌面没有 `remote`，原样不变，导出像素基线不能动。

### 1.5 舞台和编辑器不同站，读素材的 cookie 用不上（推断，未实测，先实测确认）

- 编辑器在 `https://visuhive.com/editor/`，舞台在 `https://s1.149-88-94-84.sslip.io`、`s2.…`（`runtime-config.json` 的 `stageOrigins`），两者不同站。
- `/media-s/<sid>/_grant` 发的 cookie 是 `SameSite=Strict`。按浏览器规范，跨站响应设的 Strict cookie 存不下；嵌在别的站下面的 iframe 发请求也不带 Strict cookie。所以 1.4 修好后，舞台凭 cookie 读素材很可能是 401。契约第 4.1 节自己写了「两个舞台源必须与编辑器页同站」。
- 还有一处要注意：交接请求本身回 204，页面就认为交接成功（`cardExec.reason: "ok"`），cookie 没存下来也不会被当成交接失败。
- 要同站，得给 `visuhive.com` 加 `s1`、`s2` 两个子域。域名解析在 Namecheap（`dns1/dns2.registrar-servers.com`），会话没有账号：**加两条 A 记录（`s1.visuhive.com`、`s2.visuhive.com` → `149.88.94.84`）是待用户项**。记录生效后再签证书、加舞台站点、改 `frame-ancestors` 和 `stageOrigins`。
- `https://149-88-94-84.sslip.io/editor` 和 `visuhive.com/editor` 共用同一份 `/opt/promptcut-hosted/editor`（同一份 `runtime-config.json`），换舞台源时要想清楚 sslip.io 那个入口怎么办，拿不准就问用户。

### 1.6 打开项目时卡一直是沙漏，要动一下播放头才画出来

- 刚进项目时，`__pcPreviewDiag().swapTrace` 只有一条 `settle`（t=0），那时这张卡还没 `ready`，按「没测过就按重」记成 `pipeline: "heavy"`，片段被抑制，舞台上是沙漏。
- 之后卡变成 `ready`、测量也做完了（`probeRun.done: 1`），但没有再触发 `settle`。一直等也还是沙漏。
- 在时间尺上点一下（播放头到 2.73 秒）后，才有第二条 `settle`：`pipeline: "light"`，`record: true`，抑制撤掉，卡片在浏览器里活渲出来。
- 要修的是：同步卡的运行状态变成 `ready`、或者测量结果到了以后，停着的舞台要重新结算当前这一帧。

## 2. 要做到什么（验收）

每一项的证据（命令、退出码、`status` 的那几个字段、页面诊断函数的返回值、截图）直接贴在对话里。

1. **回归核对 1.1（不重做）**：在线页面进这个项目后，`__pcCardExecDiag().available === true`，`fp-photo-scan` 的运行状态是 `ready`，没有「需要本地 PC 渲染辅助」的图标和时间轴徽标。旧共享项目（`v1.` 票据）的舞台交接照常。
2. **1.6**：在线页面打开项目、什么都不点，几秒内这张卡在舞台上活渲出来，不停在沙漏。
3. **1.4**：舞台里这张卡的图片请求走 `/media-s/<sid>/media/<哈希>`，不再请求 `/@media/…`。桌面版和导出不受影响：导出像素基线不变。
4. **1.5**：先实测确认 cookie 在 visuhive.com 下是否真的存不下、带不上（把实测方法和结果写进报告）。用户加好 DNS 之前，这一条记为待用户项，不停，接着做别的；加好之后做完舞台换源，visuhive.com/editor 上这张卡画得出户型图（截图）。
5. **1.2**：文档服务修好以后，有成员页面在线时，渲染服务 `status` 的 `directory.list` 里这个项目是 `members: true, active: true`，`projects` 里有它；成员全部离开、过了 `lingerMs` 后回到 `active: false`。单测覆盖：账号成员连接计入和撤出、`bump` 归零删键、`lingering` 写入。
6. **1.3**：渲染服务升到当前发布目录以后，`status.codeVersion.match === true`（至少不再报 `code-mismatch`）。验证渲染服务能给这个项目出图：**不要拿 `fp-photo-scan` 验**，它测量后判轻，不会发预渲染任务，层表里本来就不会有它的层。改成：在这个项目里放一张判重的卡，层表里有渲染服务渲的层；带用户卡的项目起得来隔离工作进程（`isolation.runs >= 1`）。
7. `docs/local.md`「新节点 0.7.18 正式部署与清理记录」那一节补上这次的记录：改了哪些文件、备份在哪、怎么回退。
8. 报告写到 `docs/reports/AGENT-<分支名>.md`。

## 3. 别碰这些文件

云端 Agent 的 `see_frames`（时间轴看画面）另有一张任务，还没开工，也不归你。下面这些文件留给那张任务，你不要改：

- `server/agent/service/frame-dispatcher.mjs`、`server/agent/service/account-runner.mjs`
- `src/mcp/handlers/vision.ts`、`src/ai/mcpExecutor.ts`
- `server/agent-service/look-client.mjs`、`account-task-worker-config.mjs`、`account-master-assembly.mjs`

如果你修到一半发现非改它们不可，停下来告诉用户。不要自己改。

另外，`efa66ace` 那个 Argon 会话正在节点上部署「运行素材」（`docs/plan/cloud-run-assets-deploy-task.md`）。

## 4. 边界与约束

- **同一时间只有一个会话往节点上部署。** 开工前看 `docs/local.md` 的最新记录，再看节点上最近改过的文件（`find /opt/promptcut-* /etc/promptcut* /etc/nginx -newermt '-2 hours'`）。运行素材那个会话还在部署时，先做代码部分（1.2、1.4、1.6），节点上的操作等它做完再做；拿不准就问用户。
- **有任务在跑时不重启任何服务。** 重启前先核账本里没有 `currentRunId`、队列里没有 `queued/preparing/running`。nginx 只 `reload`，不 `restart`。
- **换任何文件之前，先确认服务实际跑的是哪个目录**：systemd 单元用 `systemctl show <单元> -p ExecStart`，pm2 用 `pm2 describe`。改之前一律备份，写清回退步骤。
- 连节点的写法见 `docs/local.md`「新云节点」：带 `-i`、`BatchMode=yes`、`ConnectTimeout`；后台命令必须自己会结束。
- 只在应用层动，不改宿主机网络（防火墙、路由、代理、网卡）。不碰账本里的业务数据。
- 代码改动在 worktree（`.worktrees/<名>`，分支 `gemini/<名>`）里做，基于最新 main。合入前过基线：`npx tsc -b --force` 零错误、`npm test` 零失败；跑之前设好 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，值在 `docs/local.md`。涉及渲染的改动（1.4、1.6）要看图，导出像素基线不变。
- 规矩照 `AGENTS.md` → `docs/semantics/developer_guide.md` 和 `guide_files/`。会让用户看到不同的改动，按二级语义办。

## 5. 要读的

- `AGENTS.md` 和它指向的四份。
- 语义：`docs/semantics/product/platforms.md`（在线浏览器执行用户卡）、`product/rendering.md`「兜底顺序」、`mechanism/rendering.md`「停下追一帧」、`product/hosting.md`。
- `docs/plan/online-card-exec-contract.md` 第 3.1、4.1、8 节；`docs/reports/AGENT-v18-cardsync.md`「发现的三个现状问题」第 2 条（1.1 的由来）。
- `server/card-authoring-guide.md` 第 4.7 节（用户卡怎么引用素材）。
- `server/hosted/deploy/README.md`；`docs/plan/four-stage-deploy-checklist.md`（搜 `promptcut-stages`、`promptcut-render`）。
- `server/docservice/modules/hosted.mjs`、`server/docservice/account-hosted.mjs`、`server/hosted-render/directory.mjs`、`server/hosted-render/main.mjs`（`status` 与 `isolation` 那几段）。
- `src/render/Stage.tsx`、`src/render/mediaTier.ts`、`src/render/cards/mediaSource.ts`、`src/online/stageIsolation.ts`、`src/editor/Preview.tsx`（运行状态与 `settle` 那几段）。
