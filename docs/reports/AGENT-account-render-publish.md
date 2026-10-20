# AGENT 报告：account-render-publish

分支 `claude/account-render-publish`（起点 main `3267ce84`），工作区 `.worktrees/account-render-publish`。

任务：账号项目里云端 Agent 改完重卡后发布预渲染重试（`product/agent.md` 第 41、42 行），尊重「生成轨道流」开关，对话里如实报渲染结果。

## 进度

- 开工，建报告。读完规则、语义与背景报告（`AGENT-ux-probe-account.md`）。
- 查清根因、定做法（下节）；实现主服务一侧的预渲染重试、任务进程报片段、对话文案；补测试 AR-01～AR-09。
- 查出发布票据这一段要改文档服务（不在本任务的文件清单里），按规矩没有动，写在「没做成的」。

## 根因

账号模式下一条任务一个进程（`account-task-worker`），一轮收尾这一代进程就关掉；而预渲染重试（`server/agent/service/render-request.mjs`）只接在旧的常驻 Agent 服务里（`create-agent-service.mjs` 旧路的 `createRenderRequests({ publisher })`，写入回调 `onWrite`）。账号路径三处都没接：

1. 任务进程的实例（`account-runner.mjs` 的 `createAgentInstance`）没给 `onWrite`，写入落地了没人知道要渲哪些片段；
2. 主服务（`account-master-assembly.mjs`）没有预渲染重试，也没有发布通道；
3. 命令行入口（`main.mjs`）账号分支只建了 mTLS 的主身份，没建服务身份的控制连接，`render-publisher.mjs` 只在旧分支用。

所以 Agent 改完重卡，没人发清单计划，托管渲染服务没有活可认领，对话里也不会有任何渲染结果。

## 做法

按现有的隔离设计（任务进程只凭这条任务的授权，私钥只在主服务；看画面也是任务进程请主服务代签）选「经主服务代发」，并沿用旧路「一轮先收尾、渲染结果之后补进对话」的做法（旧路 `render.flush` 在 `end` 之后异步发，`render` 事件随后追加）：

- **任务进程**（`server/agent/service/account-runner.mjs`）：实例加 `onWrite`，每次写入落地按项目副本挑出要预渲染的片段（同旧路 `renderableClips`：还在项目里、不是素材片段），发一条 `render_request { clips, rev, userCards }` 事件。它和别的事件一样经主服务内部口交上去；任务进程不拿任何发布凭证。
- **主服务**（新文件 `server/agent-service/account-render-requests.mjs`，装进 `account-master-assembly.mjs`）：每条任务事件收下之后看一眼回执；回执里的绑定是文档服务逐条核过的（`worker-event-internal.mjs` → `workerEventSource`），**项目号只从这份绑定取**，事件正文里写什么项目都不起作用，一条任务只能让本项目的片段被发布。复用 `render-request.mjs`（3 秒防抖、每计划 200 片段、10 分钟无进展放弃、12 小时上限、盘上清单重启重发），只把「对话记录」换成主服务的事件库：结果按写到它的那一轮的绑定追加成 `render` 事件。一轮收尾（`runner_done`）时马上发。对话删了清掉它的目录与跟进。
- **发布身份**：主服务凭 Agent 服务的服务私钥（`PROMPTCUT_AGENT_SECRETS`，托管方的服务身份，不是任何成员的）开**本机**文档服务的控制连接（新变量 `PROMPTCUT_AGENT_RENDER_DOC_URL`，如 `ws://127.0.0.1:8787`；控制连接只认本机发起），订目录拿每个项目的「渲染节点 / 生成轨道流」开关，要只能发布的票据、发清单计划（`createAccountRenderPublisher` + 现有 `render-publisher.mjs`）。没配地址或私钥读不到：启动时记一行 `agent.render.publisher-off { why }`，每次改重卡在对话里记「云端渲染暂不可用」，不悄悄丢。
- **「生成轨道流」开关**（`product/rendering.md`「谁产流与托管方开关」）：发布通道的 `availability` 多给一个 `streams`（渲染节点开着且「生成轨道流」开着才是 true；只有账号模式的发布通道给，旧路不给、行为不变）。`streams === false` 时不开连接、不发，记 `render { state: 'off' }`，页面文案（`src/ai/cloud/events.ts`）：「这个项目没开「生成轨道流」,云端没有预渲染;重卡会在打开项目的设备上生成」。
- **不假报完成**：只有渲染节点把计划切出的细任务都做出结果才记 `done`（旧路规则不变）；关着记 `off`、没通道记 `unavailable`、失败记 `failed` 带原因。另补一处：文档服务**明确**不给发布票据（`no-project`、`forbidden`、`service-disabled`、`service-revoked` 等）时，旧路当成暂时性故障每 2 秒重试、对话里什么都不记；现在记一次 `failed`（「云端渲染服务不接这个项目的预渲染(原因)」）并停下（`render-request.mjs` 的 `PERMANENT_OPEN_REASONS`）。

## 文件清单

| 文件 | 改了什么 |
|---|---|
| `server/agent/service/account-runner.mjs` | 实例加 `onWrite`，报 `render_request` 事件 |
| `server/agent/service/render-request.mjs` | `noteWrite` 收已挑好的 `clips`；`streams === false` 记 `off`；发布票据被明确拒绝记 `failed` 不重试 |
| `server/agent-service/account-render-requests.mjs`（新） | 主服务一侧的预渲染重试（事件库做对话记录）与账号模式发布通道 |
| `server/agent-service/account-master-assembly.mjs` | 装上预渲染重试：事件回执后交给它、起来时重发、删对话时清、关时收 |
| `server/agent-service/render-publisher.mjs` | `availability` 透传 `streams` |
| `server/agent-service/main.mjs` | 账号分支建服务身份的控制连接与发布通道（`PROMPTCUT_AGENT_RENDER_DOC_URL`） |
| `src/ai/cloud/events.ts` | `render` 事件新增 `off` 状态的文案 |
| `server/test/account-render-publish.test.mjs`（新） | AR-01～AR-09 |
| `server/test/fixtures/account-runner-process.mjs` | `productionMaster` 时可给主服务传 `render`（替身发布通道） |

## 没做成的：账号项目的发布票据要文档服务配合（越界，没有动）

主服务这一侧已经能以服务身份要票据、发计划；但**账号模式的文档服务现在不给 Agent 服务签账号项目的发布票据**，所以在真节点上它会走到「云端渲染失败:云端渲染服务不接这个项目的预渲染(no-project)」（如实，但没渲）。证据：

- `server/docservice/modules/hosted.mjs` 的 `ticket`：Agent 服务登记为代成员（`actsFor: 'member'`），直接进 `memberServiceTicket`；它 `purpose: 'publish'` 那一支只查旧的凭证存储（`storeOf()?.peek(projectId)`），没有账号项目那一支（渲染服务那一支有：`runtime.issueServiceTicket`）。
- `server/docservice/account-hosted.mjs`：`issueServiceTicket` 只看 `project.hosted[服务名]`，不带 `purpose`；`resolveService` 解出的身份没有 `purpose: 'publish'`；`gate` 对 `service === 'agent'` 一律按任务授权查（`getRunProvider().checkAccess`），服务身份的发布连接会被拒。
- `server/docservice/service-gate.mjs` 的 `SERVICE_PUBLISH_ALLOW.agent`（只许 `publisher.hello`、`task.publish` 带片段清单的计划、`task.unsubscribe`）本身可以直接沿用，不用改。

建议的最小改动（三级，用户看不出区别，`server/docservice/**` 归文档服务那一位或主会话授权后改）：

1. `modules/hosted.mjs` `memberServiceTicket` 的「不带委托、`purpose: 'publish'`」一支：先查账号运行时，项目在账号账本里就 `runtime.issueServiceTicket({ service, serviceKid, deviceId, deviceName, projectId, purpose: 'publish' })`，与渲染服务那一支同样先核登记表与项目状态。
2. `account-hosted.mjs`：`issueServiceTicket` 收 `purpose`；`purpose === 'publish'` 只许 `agent`，要求项目 `active` 且渲染节点开着、「生成轨道流」开着（`accountRenderState(project)`；关着就回 `service-disabled`，主服务据此记失败——不过主服务在关着时本来就不发，这条只是兜底）；票据条目记 `purpose`。`resolveService` 对这种票据按同样条件复核，解出的身份带 `purpose: 'publish'`、`scope: 'service'`。`gate` 在「`service === 'agent'` 按任务授权查」之前加一支：`scope === 'service' && purpose === 'publish'` 时只核项目号一致、项目还在、渲染与生成轨道流还开着；消息种类交给现有的 `SERVICE_PUBLISH_ALLOW`。
3. 对应测试：账号项目要发布票据（开/关生成轨道流、项目不在、公钥被撤）；凭它发清单计划成功、发别的消息被拒；成员与任务连接不受影响。

做完这三条，再跑一次本机隔离托管组合 + 真渲染服务的端到端（AR-09 现在用的是替身发布通道，见「验证」）。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 新测试 | `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/account-render-publish.test.mjs`（设两个 VisuHive 变量） | 退出码 0，9/9 通过（AR-01～AR-09） |
| 全量测试 | `npm test`（设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | tests 7221，pass 7206，fail 1，skipped 14，cancelled 0 |

全量里那 1 个失败与本改动无关，是**工作区目录名**造成的：`server/test/account-v2-deploy-config.test.mjs` 第 114 行的用例断言部署配置的结果里 `JSON.stringify(result).includes('render') === false`，而结果里带着 `accountOrderModuleFile` 的绝对路径（第 65 行由 `import.meta.url` 推出），本工作区路径是 `.worktrees/account-render-publish/...`，含 `render`。证据：被测的 `server/hosted/deploy/account-v2-config.mjs` 只引 `node:fs`、`node:path`、`node:crypto`，本分支没有改到它和它的测试（`git diff 3267ce84 --stat` 只有上表文件）；同一个测试文件在主工作区（main `3267ce84`）跑 pass 9 / fail 0，在本工作区跑 pass 8 / fail 1。主会话合入前在别的目录名下重跑即可；这条断言本身对路径敏感，可另记一条小修（只比生成的登记表与公开配置，不比整份结果）。

AR-09 是真实任务进程（另一个操作系统进程里的真实运行器、真实工具、文档服务组合、主服务的生产装配与内部口），只有**发布通道是替身**：先关着「生成轨道流」让 Agent 加一张 `blur-text` 重卡——任务进程报了 `render_request`（项目号、任务号与文档服务核过的一致，片段就是新加的那张），主服务没开发布连接、没发计划，对话里只有一条 `render off`；再打开开关让 Agent 改这张卡——主服务以服务身份对这个项目发了只含这一片段的计划，那一轮先结清（`runner_done`），断开唯一的成员后替身报完成，对话里补上 `render done`，文案是「云端渲染完成」。事件顺序（节选）：`… tool_call, render_request, tool_result, …, render published, runner_done, render done`。

没跑：本机隔离托管组合 + 真渲染服务的端到端。原因：账号文档服务现在不给 Agent 服务签账号项目的发布票据（见上节），真发布通道在这里只会走到「云端渲染失败(no-project)」；等文档服务那三条改完再跑。渲染附加项（导出确定性、快照重放）不适用：没有改到画面。

## 部署要换什么

- **Agent 主服务**（`promptcut-agent`，账号版主服务进程）：换代码后重启。环境里加 `PROMPTCUT_AGENT_RENDER_DOC_URL=ws://127.0.0.1:8787`（本机文档服务地址；部署模板 `server/hosted/deploy/agent-account.env.example`、`pm2-promptcut-agent.config.cjs` 不在本任务文件清单里，没改，要由主会话补）；确认 `PROMPTCUT_AGENT_SECRETS` 下的 `service-key.json`（服务名 `agent`）在、且它的公钥在文档服务的服务登记表里（`hosted.watch` 与发布票据都凭它）。没配时启动日志会有 `agent.render.publisher-off { why }`。
- **任务进程**（各槽的 `account-task-worker-cli.mjs`）：换代码即可，下一代进程起来就用新代码；不用改 root 入口的配置。
- **文档服务**：本分支没改。要真的渲出来，先合入上节三条改动，再重启文档服务（重启前确认没有正在写入的客户端）。
- **前端**：改了 `src/ai/cloud/events.ts`（一条文案）。按惯例整份 `src/` 同步进渲染树，先换在线前端，再重启渲染服务（渲染服务本身的代码没改，同步是为了代码版本一致：清单计划带 `codeVersion`，渲染节点只认领代码版本相同的计划）。

## 语义

- 没改语义文档。做法在 `product/agent.md` 第 41、42 行、`product/rendering.md` 第 45 行之内。
- 建议主会话在 `mechanism/agent.md`「补发预渲染任务」一条后补一句账号模式的做法（三级）：任务进程只报片段，主服务以托管方服务身份发布并跟到结果、补进对话；项目号取自文档服务核过的事件绑定。以及「生成轨道流」关着时对话记 `off`、发布票据被明确拒绝时记失败不重试。
- 需要用户定的：无。`off` 那句文案是按任务书的措辞写的（「这个项目没开『生成轨道流』，云端没有预渲染；重卡会在打开项目的设备上生成」），用户想改措辞可以直接改 `src/ai/cloud/events.ts` 一行。
