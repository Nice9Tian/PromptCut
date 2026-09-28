# AGENT-host-diag 报告

分支 `claude/host-diag`，从 main `a038948` 出发，worktree `.worktrees/host-diag`，端口 5650～5659。

任务来历：`REPORT-HT-a.md` 第 4 节的后续项——主机端点的 `session.*` 日志打在预渲染进程控制台，编辑器进程只留 30 块尾巴（崩溃报错用），转不出来；M8 的混沌项（断网、pm2 restart、代理丢包、传输中断后会话接续）要从诊断里判「接续了几次、丢了几次、是否重建会话」。

## 1. 做了什么

| 提交 | 内容 |
|---|---|
| `7d46cec` | 本报告占位 |
| `f3b748d` | `session-link.mjs` 加计数；新模块 `server/render-node/session-diag.mjs`；单测 `server/test/session-diag.test.mjs`（8 条） |
| `4a8bc3d` | 接线：`vite-plugin-frames.ts`（三处端点）、`vite-plugin-prerender.ts`（编辑器进程转会话行）、`scripts/render-host.mjs`（主机自己的会话状态行） |

- **计数**（`server/render-node/session-link.mjs`，`stats()` 多出的项）：`renews`（前一个会话结束后又建成的，即重建）、`lost`（接续被服务端以 4404 / 4410 拒）、`expired`（本端判出脱开超过保留期）、`connectFails`（建新会话没成）、`lastClose { code, reason, at }`（reason 截 120 字符）、`lastDetach { code, at }`。原有的 `opens`、`resumes`、`detaches`、`closes`、`dropped` 不变。`session.open` 日志在重建时带 `renew: true`。
- **诊断字段**：`/api/frames/queue` 每个节点（本机 PC 节点与独立渲染主机的每个项目节点）多一个 `session`：
  `{ opens, resumes, detaches, renews, lost, expired, connectFails, closes, dropped, detached, lastClose, lastDetach }`。
  原有的顶层 `transport`、`resumes`、`legacy`（以及主机的 `opens`、`connectFailed`）保留不动，`ht-w-probe.mjs` 照读。`/api/frames/diagnostics` 的 `queue`（`describe()`）同样带上。
- **会话事件日志**：三处端点（推送队列、本机队列节点、独立渲染主机的每个项目）的 `log` 统一走 `sessionLogger`：事件集合从 4 种扩到 11 种（加 `lost`、`expired`、`connect-failed`、`resume-failed`、`backpressure`、`bad-seq`、`bad-ack`），**按事件节流**（每种事件每 60 s 最多 5 行，压下的条数随下一行带出 `suppressed`）；主机原来「connect-failed 只打头 3 次、之后永久不打」改成同一节流。
- **转到编辑器进程**：`vite-plugin-prerender.ts` 收预渲染进程 stdout / stderr 时，按行挑出 `[queue-node] docservice.session.*` 与 `[artifact-push] docservice.session.*`，加前缀 `[prerender] ` 打进编辑器进程的日志（`createSessionLineForwarder`：跨块拼行、单行截 2000 字符、再兜一层每种事件每 60 s 10 行）。独立渲染主机的 `render-host.mjs` 原本就转 `[queue-node]` 行，现在这些行经编辑器进程真的到了它那里。
- **独立渲染主机自己的状态输出**：`render-host.mjs` 在 `ready` 之后每 5 s 读一次 `/api/frames/queue`，会话计数（不含认领数等）有变化才打一行 `[render-host] session {"nodes":[{ projectId, nodeId, connected, transport, session }]}`（`sessionStatusOf`）；`ready` 与 `exit` 两行里的 `queue` 本来就是整份诊断，自然带上 `session`。
- **不含凭证**：计数只有数字、关闭码与服务端关闭原因；日志沿用 `session-link.mjs` 的 `safeUrl`（去掉查询串），不含会话号、子协议、口令、令牌。单测 SD-cut 把随机「凭证」放进子协议与地址查询串，断言诊断与日志里都没有它、也没有会话号；实测时核对编辑器日志不含项目口令。

## 2. 验证

- `npx tsc -b --force`：退出码 0。
- `npm test`（`4a8bc3d`）：tests 3418、pass 3416、fail 0、skipped 2、退出码 0。
- `node --test server/test/session-diag.test.mjs`：8/8，连跑 3 遍都 8/8（第一次冷启动时 SD-cut 的「建会话」3 s 等待在满载机器上超时，已放宽到 10 s）。`session-link.test.mjs` 20/20。
- **实测一：桌面编辑器（PC 节点）**。本机托管组合 5650 / 5651（`PROMPTCUT_TRUST_LOOPBACK=0`，现场生成集群令牌，不打印）、`render-queue-proxy.mjs --cut-once --stdin-control` 在 5652 转到 5650、编辑器 5655（队列模式，`PROMPTCUT_SHARED_CONFIG` 以创建者、`role: 'render'` 经代理连一个新建的共享项目）。往代理标准输入写 `cut`。脚本在 scratchpad（`host-diag-verify.mjs`，未入库）。原样输出：

  ```
  --- GET /api/frames/queue 掐断前(原样)
  {"profile":"pc","nodes":[{"projectId":"sp_7pmbzqe5nc6g5byv6egepyh35z","nodeId":"prerender:DESKTOP-GS40TCK:5655","connected":true,"transport":"ws","resumes":0,"legacy":false,"session":{"opens":1,"resumes":0,"detaches":0,"renews":0,"lost":0,"expired":0,"connectFails":0,"closes":0,"dropped":0,"detached":false,"lastClose":null,"lastDetach":null},"claimed":0,"completed":0,"dedup":0,"failed":0,"lost":0}],"codeVersion":"b9c01f1d…","envFingerprint":"258acaaa7c5fe509","maxConcurrent":1}
  --- 代理输出里的切断行
  {"t":"2026-09-27T20:39:45.591Z","event":"conn.cut","id":1,"by":"stdin"}
  {"t":"2026-09-27T20:39:45.591Z","event":"conn.cut","id":2,"by":"stdin"}
  --- GET /api/frames/queue 掐断后(原样)
  {"profile":"pc","nodes":[{"projectId":"sp_7pmbzqe5nc6g5byv6egepyh35z","nodeId":"prerender:DESKTOP-GS40TCK:5655","connected":true,"transport":"ws","resumes":1,"legacy":false,"session":{"opens":1,"resumes":1,"detaches":1,"renews":0,"lost":0,"expired":0,"connectFails":0,"closes":0,"dropped":0,"detached":false,"lastClose":null,"lastDetach":{"code":1006,"at":1790541585594}},"claimed":0,"completed":0,"dedup":0,"failed":0,"lost":0}],…}
  --- 编辑器进程日志里转出的会话事件行
  [prerender] [artifact-push] docservice.session.open {"url":"ws://127.0.0.1:5652/","transport":"ws","retainMs":60000}
  [prerender] [queue-node] docservice.session.open {"url":"ws://127.0.0.1:5652/","transport":"ws","retainMs":60000}
  [prerender] [artifact-push] docservice.session.detach {"url":"ws://127.0.0.1:5652/","code":1006,"pendingBytes":0}
  [prerender] [queue-node] docservice.session.detach {"url":"ws://127.0.0.1:5652/","code":1006,"pendingBytes":0}
  [prerender] [queue-node] docservice.session.resume {"url":"ws://127.0.0.1:5652/","transport":"ws","gapMs":794,"resend":0}
  [prerender] [artifact-push] docservice.session.resume {"url":"ws://127.0.0.1:5652/","transport":"ws","gapMs":810,"resend":0}
  --- 托管端 /healthz sessions(去掉 list)
  {"total":3,"ws":3,"http":0,"detached":0,"legacy":1,"opened":3,"resumed":2,"expired":0,"fallbacks":0}
  --- 编辑器日志含项目口令? false
  ```
  接续 0→1、脱开 0→1、建立仍 1、重建 0、丢弃 0。代理切了两条连接（推送队列与队列节点各一条会话，都接续）；`legacy: 1` 那条是卡片同步的旧客户端（`card-sync.mjs`，HT-b 后续项，不在本任务）。

- **实测二：独立渲染主机**（同一套托管组合与代理，`scripts/render-host.mjs --port 5655`）：`/api/frames/queue` 的节点 `session` 同样从 `resumes 0 / detaches 0` 变为 `resumes 1 / detaches 1 / opens 1 / renews 0`；主机自己打出：

  ```
  [render-host] session {"nodes":[{"projectId":"sp_lxmmqt26h2pbj7e4nstkjetfca","nodeId":"host:DESKTOP-GS40TCK:5655/p0","connected":true,"transport":"ws","session":{"opens":1,"resumes":1,"detaches":1,"renews":0,"lost":0,"expired":0,"connectFails":0,"closes":0,"dropped":0,"detached":false,"lastClose":null,"lastDetach":{"code":1006,"at":1790541630362}}}]}
  ```
  它的输出里也有转出来的 `[prerender] [queue-node] docservice.session.detach` / `.resume`（带 `project`、`projectId`）。托管端 `sessions.resumed` 0→1。

- 两次实测起的进程（托管组合、代理、编辑器 / render-host 及其子进程树）都由脚本结束，5650～5659 事后无监听，临时目录已删。
- 没跑：G0-R 与导出像素基线（不动渲染路径）；跨机与阿里云（任务只要求本机）。

## 3. 没做成的与留意的

- `server/card-sync.mjs` 仍是旧客户端（`createWsEndpoint`），它的连接不在会话计数里；主机诊断的 `cardSync[].opens` 是它自己的计数。属契约第 17.1 节第 3 条的 HT-b 后续项。
- 节点诊断顶层原有一个 `lost`（队列租约丢失数），新 `session.lost` 是「接续被拒」，名字相同、含义不同，放在 `session` 里分开了；读的时候别混。
- 节流是「按事件、每窗口头几条」：断网很久时 `connect-failed` 每分钟最多 5 行，总数看 `session.connectFails`。

## 4. 对任务书与语义的更正建议

- 契约 `docs/plan/http-transport-contract.md` 第 17.2 节第 9 条（「`/api/frames/queue` 与队列诊断里每个节点多 `transport`、`resumes`、`legacy`」）合入时可补一句：另有 `session` 计数（本报告第 1 节的字段），会话事件经编辑器进程转出、带节流。本分支没改契约（不在给定范围）。
- `scripts/probes/ht-w-probe.mjs` 的 `not-new-session` 注释写「主机端点的 `session.*` 日志……编辑器不转出来」，现在已转出；后续可改为直接读 `nodes[0].session.renews` / `lost` 判「没重建、没丢」。
