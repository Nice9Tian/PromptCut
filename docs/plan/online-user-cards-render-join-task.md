# 任务：账号项目里在线页面跑起用户卡、云端渲染服务进项目

2026-10-18 写（Claude 调试会话）。交给 Antigravity 的 Argon 新会话做。

## 0. 一句话

在项目 `sp_4lcukykm2blylc5lok7za46yu3`（「九天之测试」，账号 9tian）里，户型图那张用户卡 `fp-photo-scan` 在在线页面上显示「需要本地 PC 渲染辅助」，云端渲染服务也不替它出预渲染结果。原因有三个，都已经在节点和页面上实测确认过，见第 1 节。这三个都修好以后：在线页面能自己跑这张卡，渲染服务能进项目、给它出预渲染结果。

## 1. 现状与证据（2026-10-18 02:40～03:00 JST 实测）

### 1.1 舞台站点的 nginx 只认旧票据

- 页面上：两台舞台握手正常（`__pcStageHandshake().phase === "ok"`，`__pcStageWatch()` A、B 都是 `alive`），`/editor/runtime-config.json` 的 `onlineCardExec` 是 `true`，但 `__pcCardExecDiag()` 回 `available: false`，`fp-photo-scan` 的运行状态是 `not-isolated`。
- 节点上：`/etc/nginx/sites-available/promptcut-stages` 第 17 行 `map $http_authorization` 只认 `v1\.…\.…`，第 28 行 `pc_grant_cookie` 也只认 `v1\..+`。账号项目的素材票据是 43 个字符的 base64url，所以 `/media-s/<sid>/_grant` 的交接被拒，执行闸门一直关着。
- 仓库里早就修了：`f49a4220`（`src/online/stagePolicy.mjs:37` 的 `TICKET_PATTERN`，模板 `server/hosted/deploy/nginx-site-promptcut-stages.conf`），但节点上的配置是 2026-10-06 按旧模板部署的，之后没有重新生成。

### 1.2 文档服务不把账号项目的在线成员算进目录

- 渲染服务 `curl -s http://127.0.0.1:5399/status` 的 `directory.list` 里，这个项目一直是 `enabled: true, active: false, members: false`。我开着一个在线页面进了这个项目，它也还是 `members: false`。
- 渲染服务只进 `active` 的项目，所以 `projects` 是 `[]`、`queue.nodes` 是 `[]`。看画面请求进来以后，按 `blocked: { "not-ready": 1 }` 一直排着（我用主服务的密钥直接发过一条，就是这样卡住的，之后被孤儿清理撤回了）。这个项目里也没有任何层是渲染服务渲的。
- `active` / `members` 由 `server/docservice/modules/hosted.mjs` 的 `activeFor` 和 `present` 算。连接进来时由 `connect()` 用 `classOf(principal)` 记一笔。要查清的是：账号项目的成员连接（`server/docservice/account-hosted.mjs` 里 `scope: 'member', realm: 'account'` 那种）为什么没记进 `present`。是 `connect()` 没被调用、`inSpace` / `isHostedProjectId` 没认出来，还是别的原因。
- 同一个文件里另有两个小毛病，顺手一起修：`bump()` 不返回新值，所以 `disconnect()` 里 `bump(...) === 0` 永远不成立，`lingering` 不会被写；`next` 为 0 时也不删那个键，计数会一直停在 1。改之前先写单测，把这两个问题钉住。

### 1.3 渲染服务还在跑旧版本

- `pm2 describe promptcut-render`：脚本是 `/opt/promptcut-render/releases/41b6d3358438/server/hosted-render/main.mjs`，工作目录是 `/opt/promptcut-render/current`。而 Agent 主服务、root 调度、任务槽已经跑 `35f7b2abb9db`，在线编辑器是 `fb472090` 构建的。
- 它的日志每 10 分钟报一次 `render.code-mismatch`，`detail` 是「渲染服务与在线页面（或 Agent 服务）不是同一个提交：它们发的任务这台一个也认领不了」。`status` 里的 `codeVersion` 是 `{ editor: "different", agent: "unknown", match: false }`。
- 环境变量里 `PROMPTCUT_RENDER_USER_CARDS=isolated`，`isolation.enabled: true`，但 `isolation.runs: 0`：项目没进来，隔离工作进程（专门渲用户卡的那个）就从没起过。

## 2. 要做到什么（验收）

每一项的证据（命令、退出码、`status` 的那几个字段、页面诊断函数的返回值、截图）直接贴在对话里。

1. 节点上 `promptcut-stages` 按当前模板重新生成：替换占位符后，先和节点现有文件逐段 diff，只改票据那两处，别的手工改动保留（见 `docs/plan/four-stage-deploy-checklist.md` 第 99 行附近）。然后 `nginx -t`、`systemctl reload nginx`。在线页面进这个项目后：`__pcCardExecDiag().available === true`；`fp-photo-scan` 的运行状态是 `ready`（或先 `loading` 再 `ready`）；舞台上画得出户型图，没有「需要本地 PC 渲染辅助」的图标和时间轴徽标。回归：旧共享项目（`v1.` 票据）的舞台交接照常。
2. 文档服务修好以后，有成员页面在线时，渲染服务 `status` 的 `directory.list` 里这个项目是 `members: true, active: true`，`projects` 里有它；成员全部离开、过了 `lingerMs` 后回到 `active: false`。单测覆盖：账号成员连接计入和撤出、`bump` 归零删键、`lingering` 写入。
3. 渲染服务升到当前发布目录以后，`status.codeVersion.match === true`（至少不再报 `code-mismatch`）；带用户卡的这个项目能起隔离工作进程（`isolation.runs >= 1`）；`fp-photo-scan` 那一段有渲染服务渲的层（层表里有）。
4. `docs/local.md`「新节点 0.7.18 正式部署与清理记录」那一节补上这次的记录：改了哪些文件、备份在哪、怎么回退。
5. 报告写到 `docs/reports/AGENT-<分支名>.md`。

## 3. 不归你管的（别碰这些文件）

主会话正在改云端 Agent 的 `see_frames`（时间轴看画面）。下面这些文件和问题归它，你不要改：

- `server/agent/service/frame-dispatcher.mjs`、`server/agent/service/account-runner.mjs`
- `src/mcp/handlers/vision.ts`、`src/ai/mcpExecutor.ts`
- `server/agent-service/look-client.mjs`、`account-task-worker-config.mjs`、`account-master-assembly.mjs`

如果你修到一半发现非改它们不可，停下来告诉用户。不要自己改。

另外，`efa66ace` 那个 Argon 会话正在节点上部署「运行素材」（`docs/plan/cloud-run-assets-deploy-task.md`）。

## 4. 边界与约束

- **同一时间只有一个会话往节点上部署。** 开工前看 `docs/local.md` 的最新记录，再看节点上最近改过的文件（`find /opt/promptcut-* /etc/promptcut* /etc/nginx -newermt '-2 hours'`）。运行素材那个会话还在部署时，先做第 1.2 节的代码部分，节点上的操作等它做完再做；拿不准就问用户。
- **有任务在跑时不重启任何服务。** 重启前先核账本里没有 `currentRunId`、队列里没有 `queued/preparing/running`。nginx 只 `reload`，不 `restart`。
- **换任何文件之前，先确认服务实际跑的是哪个目录**：systemd 单元用 `systemctl show <单元> -p ExecStart`，pm2 用 `pm2 describe`。改之前一律备份，写清回退步骤。
- 连节点的写法见 `docs/local.md`「新云节点」：带 `-i`、`BatchMode=yes`、`ConnectTimeout`；后台命令必须自己会结束。
- 只在应用层动，不改宿主机网络（防火墙、路由、代理、网卡）。不碰账本里的业务数据。
- 代码改动在 worktree（`.worktrees/<名>`，分支 `gemini/<名>`）里做，基于最新 main。合入前过基线：`npx tsc -b --force` 零错误、`npm test` 零失败；跑之前设好 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，值在 `docs/local.md`。
- 规矩照 `AGENTS.md` → `docs/semantics/developer_guide.md` 和 `guide_files/`。会让用户看到不同的改动，按二级语义办。

## 5. 要读的

- `AGENTS.md` 和它指向的四份。
- 语义：`docs/semantics/product/platforms.md`（在线浏览器执行用户卡）、`product/rendering.md`「兜底顺序」、`product/hosting.md`。
- `docs/plan/online-card-exec-contract.md` 第 3.1、8 节；`docs/reports/AGENT-v18-cardsync.md`「发现的三个现状问题」第 2 条（这一条的由来）。
- `server/hosted/deploy/README.md`；`docs/plan/four-stage-deploy-checklist.md`（搜 `promptcut-stages`、`promptcut-render`）。
- `server/docservice/modules/hosted.mjs`、`server/docservice/account-hosted.mjs`、`server/hosted-render/directory.mjs`、`server/hosted-render/main.mjs`（`status` 与 `isolation` 那几段）。
