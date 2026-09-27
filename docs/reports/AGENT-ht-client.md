# AGENT 报告：HT-a 客户端（`claude/ht-client`）

HT-a 是「文档服务的会话模型 + 序号确认 + WebSocket 传输接会话层 + 本机信任开关」这一阶段（契约 `docs/plan/http-transport-contract.md` 文件头「2026-09-27 拆分」）。本分支只做其中的**客户端**：`server/render-node/session-link.mjs` 的 `createDocEndpoint` 及其接入。服务端会话层、信任开关、部署脚本归 `claude/http-transport`。

分支从 `claude/c10a-integ` 的 `aa9a85b` 建出。代号说明：HT1～HT9 是契约第 11 节的验收编号；H1～H14 是测试方（`claude/ht-tests`）在 `server/test/ht-kit.mjs` 顶部写的对实现的假设编号；〔裁〕是会话里定的细节，合入前由用户审。

## 1. 做了什么（契约第 15 节里客户端的几行）

| 返工项 | 落实 |
|---|---|
| `server/render-node/session-link.mjs`（新） | `createDocEndpoint`：建会话（`protocols()` 现取的鉴权列表 + `promptcut.session.new`，收到 `session.welcome` 才调 `onOpen`）；出站业务消息带 `seq`、顺带 `ack`；入站按 `seq` 收（摘掉 `seq`/`ack` 再交上层、重发丢弃、跳号或越界 `ack` 以 1002 结束）；满 32 条、或收下的未确认原文满 64 KiB 立刻、否则 1 s 内单发 `session.ack`；传输断开只脱开，保留期内 `send` 进缓冲，按退避接续（子协议只有 `promptcut.v1` 与 `promptcut.session.<sid>.<ack>`，不再调 `protocols()`），接续调 `onResume` 不调 `onOpen`，按 `welcome.ack` 释放、其余按原 `seq` 补发；4404 / 4410（契约第 16 节）与脱开超过 `welcome.retainMs` 走「报 `onClose`、重新取凭证建新会话」；服务端以 4003、4004、1013、1001、1002 等关不接续；会话结束后未确认的丢弃并计入 `dropped`；未确认出站超 1 MiB 以 1013 结束；`close()` 先发 `session.close`。`url` 收 `ws(s)://` 与 `http(s)://`，一律换成 WebSocket 地址。`PROMPTCUT_TRANSPORT`（只在 Node 里读）/ 选项 `transport`：`ws` 强制、`auto` 缺省（HT-a 里就是 WebSocket）、`http` 构造时抛 `code: 'transport-unavailable'`（「未启用」）。HT-b 的接口位置：`fallbackAfter()`（HT-a 永远回 null）、`fetch`、`waitMs` 选项照收不用、`httpUrlOf`、`FALLBACK_REASONS`。会话号与凭证不进日志。 |
| `server/render-node/index.mjs` | 导出 `createDocEndpoint`、`SESSION_DEFAULTS`、`transportOf`、`wsUrlOf`、`httpUrlOf`；文件头注明例外。 |
| `ws-transport.mjs` | 留作底座（管理接口的令牌连接 `asset-announce`、只走一种传输的测试），文件头注明业务调用方改用 `createDocEndpoint`。第 14 节的错误归类是给第 1 版 `render-node/http-transport.mjs` 的，那个文件不在本分支（见第 5 节）。 |
| `server/vite-plugin-frames.ts` 三处 | 预渲染推送、本机队列节点、独立渲染主机都改用 `node.createDocEndpoint`；控制台打 `session.open / close / detach / resume`；主机的 `connectFailed`、`opens` 改数 `session.connect-failed`、`session.open`；`/api/frames/queue` 与队列诊断里每个节点多 `transport`（脱开时 null）、`resumes`、`legacy`。必需导出清单里 `createWsEndpoint` 换成 `createDocEndpoint`。 |
| `server/agent/doc-link.mjs` | 每条对话连接改为一个会话（`createDocEndpoint`，`renew: false`：一个端点只跑一个会话）：传输断了在会话层接续，在途请求照样拿到回包；会话结束才算断线（请求失败、订阅连接按原来的节奏重连），与改之前的断线后行为相同。日志多 `agent.link.detach / resume`。 |
| `src/editor/sync/`（`link.ts`、`syncManager.ts`） | `SyncLink` 讲会话，只走 WebSocket（`transport: 'ws'`）。一个端点一个会话，建新会话的退避与「一次都没连上过」「4003/4004 不再重连」仍在 `SyncLink`；传输断开时 DocSync 不离线、不重新 `project.open`、不重放，会话结束才 `ds.disconnect()`。`dropFor(ms)` 改为结束会话（离线对话框的验收仍用它）；新增 `cutTransport()` 只断传输；开发钩子 `__pcSyncTest.cut()`、`__pcSyncTest.link()`。 |
| 探针 | `shared-project-probe.mjs` 的 creator / member、`render-queue-e2e.mjs` 改用 `createDocEndpoint`；`--transport auto|ws` 缺省自动（不给就由 `PROMPTCUT_TRANSPORT` 定，再缺省自动），`http` 退出码 2 并说明未启用；输出多 `session` / `sessions`（实际传输、接续次数、是否旧服务端）。`render-queue-e2e` 的 `--url` 也收 `http(s)://`。 |
| 共享项目配置的 `transport` 字段 | 本分支上没有（第 1 版的改动只在 `claude/http-transport` 上），无须删；`shared-config.mjs` 注释改指会话层并写明配置里没有传输字段。集成时的处理见第 5 节。 |
| 节点 `hello.resume` | 接法不变：调用方在 `onOpen` 里起节点、发 `hello.resume`；`onOpen` 只在建新会话时调，接续不调，所以接续后不重发。 |
| 主会话中途补的〔裁〕（2026-09-27） | 接收侧「收下的未确认原文满 64 KiB 立刻单发 `session.ack`」已加（`SESSION_DEFAULTS.ackBytes`），单测 `SL-ack-bytes`。 |

新增测试（都提交了）：
- `server/test/session-gateway-kit.mjs`：**测试用的最小会话服务端桩**（会话网关）。照契约与 `ht-kit.mjs` 的形状讲会话，背后每个会话一条旧式连接到真文档服务；另有 HTTP 直通、旧客户端 TCP 直通、`cutAll()`、`onForward`，以及「旧服务端」前端 `startLegacyFront`（去掉握手里的会话项后直通，服务端会话层合入前后都能测退化）。它不是服务端会话层，不替代 `claude/http-transport`。
- `server/test/session-link.test.mjs`（11 条）：过网关对真服务的接续与两边补发、`dropTransport`、4410、4404、服务端 4003、`close()`、旧服务端退化、`renew: false` 与 `onConnectFail`、传输取值、doc-link 过网关、64 KiB 确认。
- `server/test/session-link-page.test.mjs`（4 条）：页面的 `SyncLink`（vite `ssrLoadModule` 载入）过网关：传输被掐断时不丢不重放、DocSync 不离线；`cutTransport()`；`dropFor()` 结束会话后重建；旧服务端退化。

## 2. 与测试方假设的对齐（客户端相关的几条）

| 假设 | 实现 |
|---|---|
| H3 会话项写法；接续只带 `promptcut.v1` 与接续项 | 一致。 |
| H4 welcome 形状 | 一致；`onOpen` 在收到 welcome 之后（测试方报告第 7 节第 7 条的建议）。 |
| H10 `createDocEndpoint` 的选项与返回值，另认 `transport` | 一致；另有契约外的 `onConnectFail`、`dropTransport`、`renew`、`maxPendingBytes`、`ackEvery`、`ackDelayMs`、`ackBytes`、`welcomeTimeoutMs`、`legacyProbeMs`，`stats()` 另有 `legacy`、`detached`、`mode`、`detaches`、`duplicates`。 |
| H11 读不到 404 / 410 时按保留期满重建 | 两条都做：收到 4404 / 4410（第 16 节）立刻重建；握不上时脱开超过 `welcome.retainMs` 也重建。 |
| H12 `close()` 先发 `session.close` | 一致。 |
| H14 探针 member 认 `PROMPTCUT_TRANSPORT=ws` 与 `--transport ws`，不出现 `session.fallback` | 一致（HT-a 不降级，没有这条日志）。 |

测试判据一条没改；测试方的文件只临时拷进来跑，跑完删掉，没有提交。

## 3. 验证

### 3.1 基线（本分支，最后一次提交之后）

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 3258、pass 3256、fail 0、skipped 2（`集成:/api/cards/layout 对真实项目返回整数框`、`SKILL 闸门:闸关之后无头实例的工具调用不落地`，都是显式开启的集成用例）。
- 中途两次 `npm test` 各有 1 条失败：`bad-ports.test.mjs`「坏端口已被全局准备占住」。原因是另一个会话的全量测试进程（PID 58972 / 50040，命令行是 `node --test-global-setup=server/test/global-setup.mjs …`，不是本会话起的，没动它）当时占着 1719 等坏端口，本次的全局准备占不到。那个进程结束后重跑即全过（上面的数字）。

### 3.2 测试方用例（`claude/ht-tests`，临时拷入）

- 本分支（服务端会话层未到位）：`ht4-client.test.mjs` 22 条：**19 过、0 失败、3 跳过**（`HT4-real-*` 三条要服务端会话层，按测试方的门自动跳过）。连跑 3 遍都是 19 过。
- **集成预演**：把 `claude/http-transport` 的服务端文件（`server/docservice/{session,service,ws,http-transport,shared-service,main}.mjs`、`server/hosted/{combo,main}.mjs`、`server/auth/http.mjs`）临时叠进工作区、不提交，跑完 `git checkout HEAD` 还原、删掉新增的两个文件：
  - HT4 **22 过、0 失败、0 跳过**（含 `HT4-real-resume`、`HT4-real-410`、`HT4-real-404`）；HT3 1 过；ht-legacy 3 过。
  - HT5（`shared-project-probe` member 过同形路由、信任开关 0）：**自动、强制 ws 两条都过**，用的是本分支改过的探针。
  - HT6 5 过。HT1 22 条里 7 条失败、HT2 5 条里 2 条失败：都是服务端的用例对着测试方原版 `ht-kit.mjs`（H5 仍写「握手回 404/410」，第 16 节已改成 4404/4410），服务端分支的报告写了 H5 对账，不是客户端的事。
  - 叠加状态下的全量 `npm test`：3318 条、fail 13 = 上面 9 条 + 坏端口 1 条（同 3.1 的原因）+ 本分支两条旧服务端退化用例（当时假定底下的文档服务没有会话层；已改用 `startLegacyFront`，叠加状态下重跑 15/15 过）+ `SPH-SP3`（服务端分支改了 `sp-hosting.test.mjs`，换成它那一版后 SP3 过）。
- 本分支自己的用例：`session-link.test.mjs` 11 过、`session-link-page.test.mjs` 4 过；各连跑 3 遍稳定。现有 Agent 用例 `agent-c65*.test.mjs` 15 过。

### 3.3 页面验证（dev server 5610，端口只用 5610～5616）

栈（都是本会话起的，验完已关，5610～5619 空出）：
- 托管组合 `server/hosted/combo.mjs`：文档服务 5613、素材服务 5614，数据目录在系统临时目录；
- 会话网关（`session-gateway-kit.mjs`，因为本分支没有服务端会话层）在 5615，背后接 5613，HTTP 与旧客户端直通；控制口 5616（取项目信息、`/cut` 从服务端这头掐断客户端传输、`/state` 以创建者身份直连 5613 读项目真身）；脚本在 scratchpad，不入库；
- 本 worktree 的 `vite --port 5610 --strictPort --host 127.0.0.1`（舞台 5611、5612），`PROMPTCUT_DATA_DIR` 指向 scratchpad、`PROMPTCUT_PUSH=0`。

步骤与结果（Browser pane，经页面 JS 驱动；窗口隐藏时点击不可用，输入框用原生 setter 填）：
1. 开始页「加入别人的项目」：先把「服务器地址」填成 `http://127.0.0.1:5615` 并核对，再填项目名、用户名、项目密码，点「加入」→ 进入共享项目，`status: online`，`__pcSyncTest.link()` 为 `{ transport: 'ws', legacy: false, opens: 1 }`。
2. 走界面同一条路（`store.setProject` → DocSync）：改 1 次、等落地；控制口 `/cut` 从服务端掐断传输，紧接着改 3 次；等接续；页面这头 `__pcSyncTest.cut()` 关掉 WebSocket，再改 2 次；等接续、等全部确认。
3. 结果：`pageRev 7 = serverRev 7 = rev0 1 + 6 次修改`；网关转给文档服务的 `project.op` 新增 6 条、6 个不同的 opId（没有重放重复）；页面项目的轨道与真身逐项相同（`pageEqualsServer: true`：序列 1、序列 2、断前 1、服务端断开期间 1～3、页面断开期间 1～2）；全程同步状态只有 `online`（DocSync 没离线过）；端点 `resumes: 2, detaches: 2, opens: 1, closes: 0, dropped: 0, pendingBytes: 0`；网关 `opened: 1, resumed: 2, badSeq: 0, expired: 0`。
4. 截图（Browser pane）：编辑器右上「成员 1 人」，时间轴轨道依次为「序列 2、断前 1、服务端断开期间 ×3、页面断开期间 ×2」各一条，底栏「序列 8」。
5. 第一轮验证时直接调了 `ds.commit`（绕过 store），界面不跟——这是 `bindStore` 的既定行为（commit 由 `setProject` 自己写 state），不是缺陷；第二轮改走 `setProject`，界面与真身一致。
6. 页面控制台的 503 / 404 与 `[cards] ws.connect-failed`：第一轮网关还没有旧客户端直通，编辑器进程的卡片同步（`card-sync.mjs`，仍是 `createWsEndpoint`、不带会话项）被网关拒；加了直通后第二轮只剩资源 503/404（与本改动无关的素材请求），未深究。

## 4. 偏离契约与契约外的补充

1. **旧服务端退化**（契约没写「新客户端连旧服务端」）：握手成功后第一条消息不是 `session.welcome` 就退化为「一条传输一个会话」，行为同 `createWsEndpoint`。为了尽快分辨，握手后 250 ms 内一条消息都没收到就发一条 `{ type: 'session.ack', ack: 0 }` 探测；新服务端早已发了 welcome（不会走到这一步，走到了也是合法的控制消息），旧服务端回 `error unsupported`（不交上层）。理由：桌面版升级而阿里云还没重新部署时照常能连；本分支自己的全量测试也靠它（服务端会话层不在本分支）。代价：对旧服务端建连多约 250 ms。
2. **传输故障码**：只有 1005、1006、1011、1012、1014、1015 与本端 `dropTransport` 算「传输断了、接续」；其余关闭码（含 1000、4009）都当服务端结束了会话。4009 当结束是为了防两个持有同一会话号的客户端互相顶替来回抢；契约只说旧传输以 4009 关，没说被顶掉的一方怎么办。
3. **4410 报给上层的 code 就是 4410**，原关闭码只在 `reason` 里（服务端写法未定）。所以「脱开期间项目被删（4004）」在页面上表现为会话结束后重建时进不去，而不是弹「项目已删除」。建议契约把 4410 的 `reason` 格式定下来（例如以原关闭码开头），客户端再据此还原。
4. **页面的未确认上限放宽到 32 MiB**（`PAGE_MAX_PENDING_BYTES`）：DocSync 的根替换分片上传（最多 64 片 × 128 Ki 字符）一口气发出好几 MiB，第一条确认回来前就会超过契约第 3.4 节的 1 MiB，会话被自己以 1013 结束、重建后重发、再超，死循环。节点侧仍是 1 MiB。需要契约定。
5. **`connected` 的含义**：会话在就为真，脱开、正在接续时也为真（这时 `send` 进缓冲）。契约说传输的断开只进日志与 `stats()`，所以没让它随传输跳。
6. **第一次建会话之前的 `send`**：丢弃并计数（与 `createWsEndpoint` 相同；测试方报告第 7 节第 9 条提到契约没写）。
7. **契约外的接口**：`onConnectFail`（页面要分辨「口令错被拒」、doc-link 要让 `open()` 失败）、`renew: false`（页面与 doc-link 各自管建新会话的节奏，端点只管同一会话的接续）、`dropTransport()`（开发与测试）、`welcomeTimeoutMs`（握手后 10 s 没 welcome 按握手失败）。
8. 〔裁〕2026-09-27（主会话）：接收侧满 64 KiB 立刻确认，已照做，契约第 17 节待补。

## 5. 没做成的、以及集成时要注意的

- **第 1 版的客户端改动不在本分支**：`server/render-node/http-transport.mjs`（第 14 节要改的错误归类：404 / 410 走重建会话、401 是鉴权失败）、`shared-config.mjs` 的 `transport` 字段与规整、`vite-plugin-frames.ts` 按 `entry.transport` 选端点、两个探针的 v1 `--transport ws|http`，都随 `claude/http-transport` 合 c10a-integ 带在那边。本分支按任务书不合并、不改对方文件，所以这几处在集成时处理：
  - `vite-plugin-frames.ts`：取本分支的（`createDocEndpoint`，第 1 版 `transport === "http"` 那一支消失）；**保留那边 `hostAssetClient` 把 `https:` 文档服务地址推成 `https:` 素材地址的一行**（第 14 节「保留」）。
  - `shared-config.mjs`：删 `transport` 字段、规整与它的测试，取本分支的注释。
  - `render-node/index.mjs`：两边的导出都留（`createHttpEndpoint` 等作底座）。
  - 两个探针：传输相关取本分支的（`--transport auto|ws`、`createDocEndpoint`）；保留那边文件头里 `PROMPTCUT_TRUST_LOOPBACK` 的说明。
  - `render-node/http-transport.mjs` 的错误归类（第 14 节）还没人改：HT-b 再接线时一并改即可，HT-a 里没有调用方。
- **仍用 `createWsEndpoint` 的业务调用方**：`server/card-sync.mjs`（编辑器进程与主机的卡片源码同步）、`scripts/probes/shared-project-lan.mjs`、`render-host-probe.mjs`、`c66-t9-probe.mjs` 的页面连接。契约第 15 节没列它们，本分支没改；它们对新服务端是旧客户端，照常能用，只是断一次就断线。建议后续把 `card-sync.mjs` 也接会话层。
- HT-b（HTTP 长轮询回落、`X-Promptcut-Fallback`、强制 http、HT8）按拆分不做。

## 6. 对契约的更正建议

1. 第 3.4 节：客户端未确认上限允许调用方按自己的突发量设（页面的分片上传会超 1 MiB），或规定上传类突发先等确认再发。
2. 第 4.1 / 16 节：写明 4410 的 `reason` 格式（带原关闭码的写法），客户端才能把「会话期间被踢 / 项目被删」还原给界面。
3. 第 4.2 节：列出「只脱开不结束」的关闭码（本实现：1005、1006、1011、1012、1014、1015），以及被 4009 顶掉的一方不再接续。
4. 第 4.3 节：补「新客户端连没有会话层的旧服务端」的退化规则（本实现见第 4 节第 1 条）。
5. 第 4.4 节：写明 `onOpen` 在收到 `session.welcome` 之后；`connected` 在脱开期间仍为真；第一次建会话之前的 `send` 丢弃。
6. 第 2 / 15 节的接入清单补 `server/card-sync.mjs`。

## 7. 提交

见回复主会话的提交列表（`git log aa9a85b..claude/ht-client`）。
