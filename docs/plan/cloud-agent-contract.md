# 云端 Agent 服务：设计与契约

状态：**第二稿已由主会话审过并认可（2026-10-06），按它开工**；主会话的十三条裁定已写进对应处，标「〔裁：主会话 2026-10-06〕」，其中待用户审的汇在第 19 节。原状态：设计稿第二稿（2026-10-06，分支 `claude/cloud-agent`，起点 `e7d18340`，已并入 main `de03c915` 的任务书更新）。第二稿相对第一稿改了哪些见第 17 节。任务书 `cloud-agent-task.md`；用户的决定 E～J 在任务书里，本文不重复，只写怎么做到。

- 〔裁〕是本会话在任务书授权范围内自行定的细节，每条写了理由，主会话与用户可以推翻。
- 代码位置写「文件:行号」，以起点提交为准。
- 测试编号前缀 `CA`（Cloud Agent）；探针编号前缀 `CAP`。
- 托管方服务身份照第三段的 `hosted-render-contract.md`（`claude/render-service` 的 `acbb2993`，草稿，待主会话审）。开工时它还不存在，写第 4 节前再看时已有，第 4 节按它对齐；第 4.7 节逐条列了我对它的要求与还差什么。它定稿时有改动的，本文标「待对齐」的地方跟着改。

---

## 1. 名词

| 名词 | 含义 |
|---|---|
| Agent 服务 | 接对话请求、调模型、执行工具、向文档服务提交改动的那一套服务端逻辑。两种挂法：**桌面档**（挂在编辑器进程里，现状）与**托管档**（云节点上的独立进程） |
| 实例 | Agent 服务里一份互相隔离的运行状态。托管档按「项目 × 成员」一份；桌面档只有一份 |
| 对话 | 实例里的一个对话，页面给的对话 id（`/^[A-Za-z0-9_-]{1,64}$/`）；文档服务那一侧是这个实例里的第几个对话（对话号） |
| 一轮 | 用户发一条消息到这条消息处理完（或被停掉）的那一次运行，有一个 `runId` |
| 委托票据 | 文档服务签给成员页面的短期票据（2 分钟），页面打 Agent 服务的每个请求时出示（4.2） |
| 对话委托 | 文档服务签的、绑定「成员 × 项目 × 对话」的票据（60 分钟），让 Agent 服务在成员离线后仍能代他跑完这一轮（4.2）。任务书 H 里的「发起成员的身份证明」就是它 |
| 主人 | 一个云端对话归谁：项目里的这个用户名（7.2） |
| 发布连接 | Agent 服务用服务身份开的、只用来发布补渲计划的连接（第 16 节） |
| 托管方服务身份 | 托管方自己的服务（渲染服务、Agent 服务）连文档服务用的身份，由第三段定义 |
| 闸 | 所有对话与模型调用都经过的那一处额度与并发检查（第 6 节） |

## 2. 独立入口的形态

### 2.1 一份实现，两种挂法

把 `server/vite-plugin-ai.ts` 里与 vite 无关的逻辑抽成 `server/agent/service/`（新目录），对外一个工厂：

```js
createAgentService({
  profile: 'desktop' | 'hosted',
  loadModule,        // (id) => Promise<模块>：前端代码的唯一入口，只传给 ssr-host.mjs
  instances,         // 实例登记表（第 3 节）
  gate,              // 闸（第 6 节）
  modelConfig,       // () => 这一轮用的模型配置（含 Key 明文，只在进程内）
  pageChannel,       // 桌面档：SSE 页面通道；托管档：null（云端的一轮不依赖任何页面，9.4）
  prerenderPost,     // 桌面档：预渲染进程；托管档第一版：null
  stores,            // 对话记录、模型历史、用量记录各自的存取口
  log,
})  →  { chat(req, res), abort(...), callTool(...), bind(...), status(), close() }
```

- **桌面档**：`vite-plugin-ai.ts` 变成薄壳，只做三件事——用 `server.ssrLoadModule` 当 `loadModule`、把 `/api/ai/*`、`/api/mcp/*`、`/api/agent/*` 的请求原样转给这份服务、保留只属于桌面的接口（安装与登录、诊断、机器码、`port.json`、SKILL 预览）。路径、请求与回包、SSE 事件一个字段都不变。「桌面版改用同一个入口」指的是这一条：同一份 `createAgentService`、同一套实例管理，桌面是只有一个实例的特例。**不新增桌面进程，不动桌面壳。**〔裁：主会话 2026-10-06〕〔原裁：任务书写「不动桌面壳」；桌面另起一个 Agent 进程要改壳的进程管理与补丁判定，而用户看到的行为没有任何变化，不值得〕
- **托管档**：新入口 `server/agent-service/main.mjs`，一个 Node 进程：
  1. 进程内起一个 vite（`createServer({ configFile: false, root, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } })`，与 `server/test/c65b-kit.mjs:274` 现成的起法相同），只用它的 `ssrLoadModule`，不监听端口、不提供页面；
  2. 自己起一个 `http.createServer`，只绑回环（缺省 `127.0.0.1:8790`），提供第 2.3 节的接口；
  3. 用托管方服务身份向文档服务建一条控制连接（第 4.3 节）。
- **载入缝**：服务代码对 `src/` 的依赖只经 `server/agent/ssr-host.mjs` 的 `loadSsrHost(load)`。现状另有三处直接引用 `src/kernel/creativity.mjs`（`vite-plugin-ai.ts:19`、`server/agent/agent-sessions.mjs:21`、`server/agent/creativity-gate.mjs:21`），是起点就有的，本次不新增也不顺手改；新目录 `server/agent/service/` 与 `server/agent-service/` 里**不许出现指向 `src/` 的 import**，单测 CA-SEAM-01 守门（扫这两个目录的 import 语句）。
- 托管档进程不挂 `vite.config.ts` 里任何插件：没有 `/api/*`，没有 `port.json`，没有 CLI 驱动、安装登录、SKILL 闸、桌面会话分组。启动时删掉环境变量 `PROMPTCUT_AI_FAKE_RUNNER`、`PROMPTCUT_AI_RUNNER_MODULE`（测试用的换驱动口子不带进生产进程）〔裁〕。

### 2.2 托管档的进程与目录

| 项 | 值 |
|---|---|
| 进程名 | PM2 app `promptcut-agent`，fork 模式，单进程 |
| 代码 | 完整仓库加依赖（要 vite 与 `src/`），不是托管组合那份精简清单。与第三段的渲染服务共用同一份检出，目录由主会话在部署时与第三段统一（待对齐） |
| 监听 | `PROMPTCUT_AGENT_HOST`（缺省 `127.0.0.1`）、`PROMPTCUT_AGENT_PORT`（缺省 8790）。只经 nginx 对外 |
| 数据目录 | `PROMPTCUT_AGENT_DATA`，必须已存在且可写，0700。布局见下 |
| 文档服务地址 | `PROMPTCUT_AGENT_DOC_URL`（同机回环 `ws://127.0.0.1:8787`，不绕公网） |
| 公网源 | `PROMPTCUT_AGENT_PUBLIC_ORIGIN`（如 `https://149-88-94-84.sslip.io`）：只认这个源来的浏览器请求 |
| 服务身份凭证 | `PROMPTCUT_AGENT_SECRETS`（缺省 `/var/lib/promptcut/agent-secrets/`，目录 0700）下的 `service-key.json`：服务名 `agent` 的 Ed25519 私钥，由第三段的 `keygen` 生成（待对齐）。不读集群令牌 |

数据目录布局：

```
<PROMPTCUT_AGENT_DATA>/
  config/ai.json            模型配置（厂商、地址、模型清单），0600
  config/keys/custom.key    模型 Key 的密文（现有封装，第 8 节），0600
  config/limits.json        节点级上限与各项目额度（第 6 节），0600
  tenants/<projectId>/owners/<ownerKey>/conversations/<对话 id>/
      meta.json             标题、状态、最近一轮、结束原因
      events.jsonl          事件记录（给人看的全过程，2.4）
      history.json          模型那一侧的消息历史
      pending-render.json   还没渲完的补渲清单（第 16 节）
  usage/<yyyy-mm>.jsonl     用量记录（追加写）
  usage/totals.json         各项目、各成员的累计（检查点）
  tmp/                      进程的临时目录（TMPDIR 指到这里）
```

`<ownerKey>` = `sha256(主人键)` 的前 32 个十六进制字符，主人键见 7.2〔裁：用户名可以含任意字符，不直接当目录名〕。

失败即关（打一行 `config.error { reason }`，退出码 1）：`data-dir`、`doc-url`、`public-origin`、`service-identity`（凭证读不到或格式不对）、`listen`、`bind-public`（绑了非回环地址：拒绝启动，这个服务只许经反向代理对外）。没有模型 Key 照常启动，对话请求回 `error { code: 'no-model-key' }`。

### 2.3 托管档对外接口

全部在 `/v1/` 下（经 nginx 是 `/agent/v1/`）。除 `healthz` 外都要 `Authorization: Bearer <委托票据>`（第 4 节）。回包 JSON，`Cache-Control: no-store`。请求体上限 256 KiB〔裁：第一版不收附件，消息加素材清单远小于此〕。

跨源：在线页面与它同源；桌面版的页面从本机源（`http://127.0.0.1:<端口>`）跨源来打（第 10.4 节）。所以它答预检，`Access-Control-Allow-Origin: *`、允许 `Authorization` 与 `Content-Type` 请求头，不收也不发 Cookie。鉴权只看票据，放开来源不多给任何人权限（与文档服务的共享端点同一做法，`auth-contract.md` 第 4 节）。

| 接口 | 请求 | 成功 | 说明 |
|---|---|---|---|
| `GET /healthz` | — | `{ ok, version }` | 不鉴权，不含任何项目信息 |
| `GET /v1/info` | — | `{ ok, enabled, render: { enabled }, models: [..], defaultModel, limits: { rounds, runMs }, usage: { tokens, limitTokens }, running: [对话 id] }` | 页面进入「云端」接入方式时取一次；`running` 是这位成员在这个项目里还在跑的对话 |
| `POST /v1/conversations/<id>/messages` | `{ prompt, grant, model?, effort?, creativity?, script?, library?: [素材清单], pageState?: { t, selection }, pageId? }`（`pageId`：发这条消息的那张页面的页面号，第 28 节） | 202 `{ ok, runId, seq }` | 发一条消息、起一轮。**这一轮从此与这个请求的连接无关。** `grant` 是这一轮的对话委托（4.2）。同一个对话已有进行中的回 409 `busy-conversation` |
| `GET /v1/conversations/<id>/events` | `?after=<seq>`，可选 `&page=<页面号>`（第 28 节），`Accept: text/event-stream` | SSE（第 2.4 节） | 先补发 `seq` 大于 `after` 的全部事件，再接实时的。可以同时开多条（多台设备、多个页签） |
| `POST /v1/conversations/<id>/abort` | — | `{ ok }` | 停这个对话进行中的一轮。对话的主人从任何设备都能停 |
| `GET /v1/conversations` | — | `{ ok, items: [{ id, title, updatedAt, state, lastSeq, startedOn: 设备名 }] }` | 这位成员在这个项目里的云端对话（归属见 7.2） |
| `GET /v1/conversations/<id>` | — | `{ ok, meta: { id, title, state, lastSeq, reason? } }` | `state`：`idle`、`running`、`interrupted`、`failed`、`revoked` |
| `PATCH /v1/conversations/<id>` | `{ title }` | `{ ok }` | 改标题 |
| `DELETE /v1/conversations/<id>` | — | `{ ok }` | 进行中的先停；连模型历史一起删 |
| `GET /v1/usage` | `?since=<毫秒>` | `{ ok, project: { tokens, calls }, members: [{ username, tokens, calls }] }` | 项目内任何成员可查本项目的 |
| `POST /v1/conversations/<id>/page-results` | `{ id, pageId, ok, result?, error? }` | `{ ok }` | 反向通道（第 28 节）：发起人的页面交回一次 `page.request` 的结果。按「这个对话的主人、发起这一轮的 `userId`、这一轮的页面号、还在等的 `id`」核对，一次有效；别人的或不存在的对话 404，不在等的（编的、过期的、交过的、这一轮已结束）410 `page-request-gone`，结果超过 64 KiB 回 413。〔这一行原来是占位的 `page-result { reqId, result?, error? }`，从未实现过；2026-10-07 按做成的改〕 |

请求里**不收**这些桌面字段：`provider`（恒为 API 直连）、`sessionId`（模型历史按对话 id 找，不认页面自报的）、`deepAuto`、`reviewLoop`、`schemaCompat`、`attachments`、`hops`、`projectCreativity`（服务端读副本）。带了也忽略。

错误统一为 `{ ok: false, code, message }`；`code` 取：`unauthorized`（401，不说原因）、`forbidden`（403）、`disabled`（项目关了开关）、`busy`（节点或项目并发已满）、`busy-conversation`、`quota-exceeded`、`no-model-key`、`too-large`、`bad-request`、`bad-grant`（对话委托不对：过期、不是这个对话的、不是这位成员的）、`unavailable`（文档服务连不上）、`page-request-gone`（410，只在 `page-results` 上：这次请求已经不在等了）。

### 2.4 事件流：存下来再发

**一轮的每个事件先追加进这个对话的事件记录（磁盘），再发给此刻连着的流。** 没有任何流连着，这一轮照样跑、照样记。流是「看」，不是「跑」的一部分：

- 流断开（关页签、退出桌面版、断网）：这一轮**不停**。只有三件事能停它：主人调 `abort`、撤销（4.5）、出错或到上限。
- 重新打开、换设备：`GET …/events?after=<上次看到的 seq>`，服务端先从事件记录补发，再接上实时的；`after=0` 就是从头看完整过程。补发与实时之间不丢、不重（同一把锁里切换）。
- 页面的对话界面完全由事件重建，页面不向服务端存对话记录。

格式：`text/event-stream`，带 `X-Accel-Buffering: no`，每 15 秒一行 `: ping`。每个事件一行 `data: <JSON>`，带递增的 `seq`（每个对话从 1 起，跨轮连续）。事件类型在桌面 `/api/ai/chat` 的基础上（`run`、`session`、`status`、`text`、`thinking`、`tool_call`、`tool_result`（不带完整 `output`）、`progress`、`diagnostic`、`error`、`done`）加：

- `user`：一条用户消息 `{ runId, prompt, from: 设备名, at }`——别的设备补看时要看得到问的是什么；
- `error` 带 `code`：`revoked`（开关关了、被移出或踢出、项目删了，附 `reason`）、`interrupted`（服务重启留下的）、`model`（模型接口报错）、`quota-exceeded`、`limit`（到了轮数或时间上限）；
- `render`：这一轮的改动引出的补渲的进展 `{ state: 'published' | 'progress' | 'done' | 'failed' | 'unavailable', clips, done?, total?, reason? }`（第 16 节）；
- `end`：一轮收尾 `{ runId, state }`，之后没有这一轮的事件了。
- `page.request`：反向通道的一次请求 `{ id, runId, tool, args, timeoutMs }`（第 28 节）。它**不带 `seq`、不进事件记录、只发给发起这一轮的那张页面的那条流**；补发里没有它。不认得它的页面按「不认得的事件类型原样放过」处理。

`text`、`thinking` 的增量在一轮结束时在事件记录里合并成整段（实时流照发增量），免得事件记录被逐字的增量撑大。`diagnostic` 在托管档只发 `configuration` 与 `request` / `response` 的计数，不带模型接口地址〔裁：地址是托管方的配置，成员不需要知道〕。

### 2.5 鉴权（概述，细节在第 4 节）

每个请求独立核验：取 `Authorization` 里的委托票据 → 问文档服务核验（结果短时缓存）→ 得到 `{ projectId, userId, username, creator, access }` → 定出对话的主人（7.2）与运行实例（3.1）→ 只在这个范围里办事。URL 与请求体里**没有** `projectId`、`userId` 字段：身份只来自票据，页面自报不了。

发消息另需一张对话委托（4.2）：它让这一轮在成员离线后仍然有凭证连文档服务。

---

## 3. 按「项目 × 成员 × 对话」分实例

### 3.1 实例的边界

```
进程
 ├─ 闸、用量记录、模型配置、SSR 宿主（一份）
 └─ 实例登记表
      └─ 实例（托管档：键 = projectId + userId；桌面档：只有一个，键 = 'desktop'）
           ├─ AgentSide：到文档服务的连接、项目副本、执行器（agent-side.mjs 原样）
           ├─ 会话登记表、公告板、在场桥、「用户正在编辑」看板
           ├─ 页面通道（桌面档才有）
           ├─ 审查环路锁
           └─ 对话（键 = 对话 id）
                ├─ 对话号、最后读到的版本（执行器里）
                ├─ 进行中的一轮（runId、abort）
                └─ 对话记录、模型历史（磁盘）
```

〔裁〕**托管档的运行实例按「项目 × 成员（`userId`，即用户名加设备）」，不按项目。** 一个实例里的每条文档服务连接都是凭这位成员的委托票据开的，副本里的每个字节都是这位成员有权读到的；撤销某位成员就是关掉他的实例，不用在共享的副本里分辨谁读过什么。代价是同一项目的两位成员各持一份副本（项目 JSON 通常几百 KB 到几 MB），由第 11 节的实例数上限兜住。

运行实例与对话的**归属**是两回事：对话记录按主人键存（7.2），创建者与限定进入的成员换一台设备能找回；每一轮在发起它的那台设备的 `userId` 的实例里跑，用的是那台设备要来的对话委托。同一个对话先后两轮可以在两个实例里跑，同一时刻只有一轮。

桌面档的那一个实例沿用现在的绑定规则：页面 `POST /api/agent/bind` 换项目时，旧的 AgentSide 关掉、新的建起来（`vite-plugin-ai.ts:297`～`298` 的「后绑的顶掉先绑的」），实例里其余状态不清——与现在逐项相同。

### 3.2 全局状态清单

下表列全了现在的进程级状态（42 项）。「作用域」：进程 / 实例 / 对话 / 一轮 / 仅桌面。「桌面」一列写桌面档怎么退化成现在的行为。

**A. `server/vite-plugin-ai.ts` 插件闭包里的**

| # | 状态 | 位置 | 改成 | 怎么改 | 桌面 |
|---|---|---|---|---|---|
| 1 | `editorRes`：唯一的页面 SSE | :54 | 实例 | 收进 `pageChannel` 对象（连同 2、3、12、23） | 一个实例一条，后连的挤掉先连的，同现在 |
| 2 | `nextCallId` | :55 | 实例 | 同上 | 同现在 |
| 3 | `pendingCalls` | :56 | 实例 | 同上 | 同现在 |
| 4 | `activeRuns`：`runId` → 中止函数 | :57 | 进程，每条带所属实例 | `abort` 先核对实例；托管档 `runId` 改用 `crypto.randomUUID()`（现在是 `Math.random` 7 位，:1122） | 只有一个实例，核对恒过；`runId` 仍是原来的 7 位（页面与补丁脚本读它，形状不动） |
| 5 | `callPairing` | :62 | 仅桌面 | 托管档不建（只为 codex、agy 两路配对） | 不变 |
| 6 | `quotaGuardPromise`：CLI 额度熔断 | :67 | 仅桌面，进程 | 托管档不建。它管的是这台机器上用户自己的命令行订阅，本来就是机器级的 | 不变 |
| 7 | `failProviderRuns` | :72 | 仅桌面 | 随 6 | 不变 |
| 8 | 写 `port.json` | :85～:115 | 仅桌面 | 留在薄壳里 | 不变 |
| 9 | `getRunner` 读环境变量换驱动 | :117～:130 | 进程 | 托管档启动时删这两个环境变量，驱动固定为 API 直连 | 不变 |
| 10 | `userEditingBoard` | :256 | 实例 | 托管档由在场桥喂（别的成员页面的「正在编辑」），没有本机页面那一路 | 不变 |
| 11 | `agentBinding`：绑定的项目 | :263 | 实例登记表 | 见 3.1 | 登记表里只有一个实例，重绑即替换 |
| 12 | `ticketSeq`、`ticketWaiters`：向页面要连接票据 | :264～:265 | 实例（桌面） | 托管档不用这条路：凭证是服务身份加委托票据（第 4 节） | 不变 |
| 13 | `editorPortOf`、回环文档服务地址 | :268、:292 | 进程配置 | 托管档读 `PROMPTCUT_AGENT_DOC_URL` | 不变 |
| 14 | `agentLog` → `console.info` | :269 | 进程 | 托管档换成一行一条的 JSON 日志；字段只许是 id、计数、原因码，单测 CA-LOG-01 核对不出现正文、票据、Key | 不变 |
| 15 | `loopToolLock`：审查环路只读锁 | :373 | 实例 | 锁放到实例上 | 一个实例，锁住期间这个进程里所有对话的写都被拦，与现在「有意的全局」相同。托管档只锁这位成员自己的对话，并且第一版不开审查环路（第 9.3 节），实际不会上锁 |
| 16 | `agentSessions`：对话登记表 | :379 | 实例 | 每实例一份。对话 id 是页面起的，放在进程级的表里两个成员能撞上或互相冒用 | 一份 |
| 17 | `desktopPushTimer`、`desktopActivity` | :384、:393 | 仅桌面 | 不建 | 不变 |
| 18 | `requestSkillPreview`、SKILL 闸 | :409、:538 | 仅桌面 | 托管档不经 SKILL 闸（没有桌面会话） | 不变 |
| 19 | `projectCreativityHint` | :419 | 实例 | 托管档恒读副本，不用页面报的 | 不变 |
| 20 | `userCardExists` 读本机卡片目录 | :432 | 仅桌面 | 托管档恒为假，且建卡改卡不开放 | 不变 |
| 21 | `lastTabs` | :452 | 实例 | — | 不变 |
| 22 | `presenceBridge` | :453 | 实例 | — | 不变 |
| 23 | `boardPushTimer` | :454 | 实例 | 随页面通道 | 不变 |
| 24 | `boards`、`boardKeys`：公告板 | :463、:472 | 实例 | 每实例一份登记表。现在按项目键分，放进程级的话两个成员的对话 id 会进同一张板 | 一份，键仍是当前项目 |
| 25 | `spawnSeq`、`spawnWaiters` | :484～:485 | 实例（桌面） | 托管档不开多 Agent 工具 | 不变 |
| 26 | `multiAgent` | :499 | 实例 | — | 不变 |
| 27 | `setupService`：安装与登录作业 | :745 | 仅桌面 | 留在薄壳里 | 不变 |
| 28 | 工作目录 `<root>/exports/ai-workspace`，所有对话共用 | :1119 | 仅桌面 | 托管档没有工作目录，不给 `text_editor` 工具，不收附件 | 不变 |
| 29 | 系统提示词里的「当前端口、编辑台已连接」 | :1094～:1098 | 一轮 | 托管档换成「你运行在云端，没有编辑界面可用」加第 9.2 节的不支持清单 | 不变 |

**B. 别的模块里的**

| # | 状态 | 位置 | 改成 | 怎么改 | 桌面 |
|---|---|---|---|---|---|
| 30 | `ai.json` 与密钥文件：整台机器一份 | `server/ai-config.mjs:23`～`:35` | 进程（节点一份） | 托管档用 `PROMPTCUT_AI_CONFIG` 指到数据目录；每一轮由服务读出后经 `opts.apiConfig` 交给驱动（`server/runners/api.mjs:154` 已有这个口子），驱动不自己读文件。页面没有任何读写配置的接口 | 不变 |
| 31 | 密钥派生缓存 | `server/runners/config-crypt.mjs:53` | 进程 | 不动 | 不变 |
| 32 | 模型历史文件 `%TEMP%/promptcut/harness-sessions/<sessionId>.json`，`sessionId` 由请求给 | `server/runners/api.mjs:136`、`:196`～`:198` | 对话 | 给 `startRun` 加可选的 `historyFile`：托管档传对话目录下的 `history.json`，不收页面的 `sessionId`。**这是现状里最直接的串台口子：知道别人的 `sessionId` 就能接着别人的历史说** | 不传，仍是原路径 |
| 33 | 审查教训 `review-lessons.json`：整台机器一份 | `server/runners/api.mjs:12` | 仅桌面 | 托管档不开审查环路，不读不写 | 不变 |
| 34 | `text_editor` 的撤销栈 | `server/harness/tools/textEditor.mjs:5` | 仅桌面 | `buildTools` 加 `localTools: false` 时不带这个工具 | 不变 |
| 35 | 驱动清单缓存、登录探活缓存、codex 登录状态 | `server/runners/index.mjs:24`～`:26`、`auth.mjs:6`、`codex-auth-state.mjs:103` | 仅桌面 | 托管档不载入 | 不变 |
| 36 | 对话记录 `.pc-chats/`、附件 `.pc-work/` | `server/vite-plugin-chats.ts:12`、`:18` | 对话 | 托管档不挂这个插件，对话记录走第 7 节 | 不变 |
| 37 | 数据镜像与播放头 `latestMirror`、`latestPlayhead` | `server/mirror-store.mjs:29`～`:33` | 仅桌面 | 托管档 `playhead` 恒为 0，或用页面随消息报的值（第 9 节可选项） | 不变 |
| 38 | 预渲染进程地址 | `server/prerender-client.mjs`（模块状态） | 仅桌面 | 托管档第一版 `prerenderPost` 为空 | 不变 |
| 39 | **服务端 store 单例**：整个进程一份 `state` | `src/store/core.ts:57`；用法 `server/agent/ssr-host.mjs:34`～`:40` | 进程，加进程级的锁与清场 | 见 3.3 | 不变 |
| 40 | 执行器的串行锁，每个执行器一把 | `server/agent/agent-exec.mjs:212`、`:228` | 进程（托管档） | 见 3.3 | 一个执行器，一把锁，同现在 |
| 41 | 工具实现打编辑器接口的地址 | `src/mcp/apiUrl.ts:8`；设置处 `ssr-host.mjs:30` | 进程 | 托管档设成解析不了的 `http://agent-service.invalid`：漏网的调用立刻失败，不会打到同机别的服务 | 不变 |
| 42 | 工具实现里的作业表与结果表（转写、采集、镜头、追踪、主体） | `src/mcp/common.ts:163`～`:302` | 进程 | 用到它们的工具在托管档都不开放（第 9 节）；单测 CA-TOOL-03 核对开放的工具不碰这些表 | 不变 |

执行器与连接内部的状态（`agent-exec.mjs:210`～`:211` 的对话表与对话号、`doc-link.mjs:199`～`:209` 的连接表与副本）本来就在 AgentSide 实例上，随实例走，不用改。

### 3.3 最难的三处

**（一）服务端 store 是进程里的单例（39、40）。** 工具实现经 `ssrLoadModule` 载入后，读写的是 `src/store/core.ts` 模块里那一份 `state`。现在一个进程只有一个执行器，靠执行器自己的串行锁保证「放项目、跑实现、取结果」一气呵成。多实例后两个实例各有各的锁，就会交错：甲的项目放进去，乙的实现跑在上面，算出的差异提交到乙的项目里——直接跨项目泄露内容。改法：

- 锁上移到 SSR 宿主：`loadSsrHost` 返回的对象带一把**进程级**的 `exclusive(fn)`，执行器不再自己建锁，改用注入的这一把（桌面档注入的也是它，只有一个执行器，行为不变）。
- 托管档每次进锁先**清场**：`host.resetStore()` 把 store 里项目以外的全部字段（播放头、选区、播放状态、手动时长等，按 `EditorState` 的初值）还原，出锁时把项目换成 `null`。否则上一位成员的实现留下的选区（刚加的片段 id）会被下一位成员的实现读到。桌面档不清场（现在不清，页面状态的缺省值已被依赖）。
- 锁里不许等外部：托管档开放的、走路由表的工具必须是同步实现（`src/mcp/routes.mjs` 里 `awaited: false`）。一个等着网络的实现会让全节点所有对话的工具排队。单测 CA-TOOL-02 对着路由表核对这一条。
- 单测 CA-ISO-01 用两个项目、两个执行器并发各跑 200 次写工具，断言每次提交的操作只含自己项目的实体。

**（二）一切以页面自报的 id 为键的状态（4、16、24、32、36）。** 对话 id、`sessionId`、`runId` 都是页面起的或可猜的。改法是没有例外的一条规则：**托管档里任何查找都先定实例（来自票据），再在实例里按 id 找**；磁盘路径由服务端按「项目、成员、对话」拼，页面给的 id 只当最后一段且先过字符集检查。单测 CA-ISO-02 逐个接口拿乙的 id 用甲的票据去读、去停、去删、去续，全部当作不存在。

**（三）桌面行为不变的证明。** 抽服务是对 1500 行闭包的大搬家。办法：先只搬不改（提交一），跑桌面版与 Agent 相关的全部单测与探针（第 13.4 节的清单）确认不变红；再加实例登记表与托管档（提交二起）。每一步桌面档的状态归属见上表「桌面」一列，逐项可核对。

### 3.4 实例的生命周期

- 建：第一个带有效票据的请求到达时建（连文档服务、等副本就绪）。同一个键并发到达的请求共用同一次建立。
- 闲置回收：没有进行中的一轮、10 分钟没有请求，关连接、丢副本〔裁，数字进 `mechanism/agent.md`〕。**有没有人连着看不算数**：一轮在跑，实例就在。补渲的发布连接不属于实例，寿命另算（第 16 节）。
- 撤销：见第 4.5 节，立即关。
- 进程退出（SIGTERM）：停止接新请求 → 给每个进行中的一轮记 `error { code: 'interrupted' }` 并中止 → 落事件记录与状态 → 关连接 → 5 秒内退出。

---

## 4. H：认证流程

托管方服务身份这一层照第三段的 `hosted-render-contract.md`（提交 `acbb2993`，草稿）第 1 节与第 8 节：每个服务一对 Ed25519 密钥、文档服务只存公钥的登记表、只认本机发起的控制连接、目录模块 `hosted`、带 `sv` 字段的连接票据、按服务名查的消息白名单。本节只写 Agent 多出来的部分，就是那份契约第 8 节「留给第四段定的」那几条。第三段定稿时改了的地方，本节跟着改。

### 4.1 三样凭证各管什么

| 凭证 | 谁持有 | 证明什么 | 谁签、谁验 |
|---|---|---|---|
| 托管方服务身份（服务名 `agent`） | Agent 服务进程（私钥在 `/var/lib/promptcut/agent-secrets/`，0700） | 「我是这台节点上托管方的 Agent 服务」 | 第三段：Ed25519 签挑战，文档服务按登记表里的公钥验 |
| 委托票据 | 成员的页面取得，随请求交给 Agent 服务 | 「成员某某此刻在项目某某里，同意云端 Agent 代他工作，权限是读写或只读」 | 项目的文档服务签，也只有它验 |
| 页面自己的连接 | 成员的页面 | 成员身份（现有的证明或连接票据） | 不变 |

Agent 服务**不持有**任何成员的口令、`K`、项目的 `ticketKey`，也不持有集群令牌。它单凭服务身份进不了任何项目的数据面（不带委托票据，文档服务不给它签任何连接票据）；委托票据落到别人手里也没用，因为拿它换连接票据要经服务身份的控制连接。两样齐了才得到「成员某某的云端 Agent」这个身份。

### 4.2 两种身份证明：委托票据与对话委托

都沿用 `auth-contract.md` 第 8 节的票据格式与签名密钥（项目记录的 `ticketKey`），都由项目的文档服务签、也只有它验，都只有成员身份、`page` 角色的连接能要（`auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`）。`agent`、`render` 角色的连接要不到（Agent 不能给自己续命）；本机 `local` 身份、服务身份要不到。登记表里没有 `agent` 服务、或项目的云端 Agent 开关关着时回 `error { reason: 'service-disabled' }`。

| | 委托票据 | 对话委托 |
|---|---|---|
| 用途 | 页面的每个 HTTP 请求出示：「我是谁」 | 一轮开始时交给 Agent 服务：「在这个对话里代我行事，我离线了也算数」 |
| 负载 | `{ kid, k: 'dlg', p, u, dn, cr?, aud: 'agent', acc, g, ug, exp, iat }` | 同左，另加 `cid: <对话 id>`、`run: true` |
| 绑定 | 成员 × 项目 | 成员 × 项目 × 对话 |
| 有效期 | 2 分钟 | 60 分钟〔裁：主会话 2026-10-06〕 |
| 怎么要 | 不带 `conversation` | 带 `conversation: <对话 id>` |
| 存在哪 | 页面内存 | 页面要来后随「发消息」交给 Agent 服务；Agent 服务**只放内存**，不落盘、不进日志 |
| 能换什么 | 只能过 `hosted.delegate.verify` | 能过 `hosted.ticket` 换这个对话的连接票据 |

- **发起方离线后怎么持续有效**：对话委托的核对不看成员在不在线，只看四样——签名、没过期、项目代数与成员代数没变、成员此刻仍在名单里且没被禁入、开关开着。成员退出软件不改变其中任何一样，所以这一轮照跑。
- **多久失效**：一张对话委托 60 分钟；一轮的上限是 30 分钟（7.3），所以一轮之内不需要续。**一轮一张**：每发一条消息带一张新的。成员离线期间没有续期这回事——到期了，这个对话也早就说完了；主人回来说下一句时带新的。
- **服务端可撤销，且立刻**：不靠等过期。4.5 的四种触发发生时，文档服务当场关掉这位成员的云端 Agent 连接、并让代数或开关变化使委托作废；Agent 服务的连接一断就停这一轮。委托本身是无状态的票据，撤销靠的是文档服务手里的代数、名单、禁入表、开关——这些正是现有票据的撤销办法，不另建一张「已发委托」的表〔裁：少一份要持久、要同步的状态；撤销的即时性由「关连接」保证，不由查表保证〕。
- **`acc`**：由文档服务按这位成员此刻的权限填，页面不能指定更高的。见 4.6。
- **核对**：与现有票据相同（先验签名再采信字段、30 秒时钟偏差），另加 `aud` 必须等于来要的那个服务的服务名；对话委托的 `cid` 必须等于换票据时报的对话。
- **防伪造**：签名密钥只在文档服务进程里。
- **防重放与外泄**：只在 TLS 里传；不进地址、不进日志（日志只记 SHA-256 前 8 位）。对话委托比委托票据活得久，所以多三道：只有 `agent` 服务的控制连接能拿它换东西，而控制连接只认本机发起的；它绑死一个对话；Agent 服务只放内存。即使它在传输之外泄露，拿到的人没有服务私钥、又不在节点本机上，换不出连接；拿它当委托票据去打 HTTP 接口，至多是 60 分钟内以这位成员的名义读写这位成员自己的云端对话、发消息（仍受开关、额度管）——这一条是把有效期从 2 分钟放到 60 分钟的代价，写在这里；觉得长可以把上限与一轮的时限一起调小。
- 委托票据**不绑对话**〔裁〕：对话列表、用量这些接口不属于某个对话。

### 4.3 时序

```
成员页面                  nginx           Agent 服务                       文档服务
   │  auth.ticket{delegate}（自己的连接上）─────────────────────────────────▶│
   │◀──────────────────────────────────────────── auth.ticket.ok{ticket,exp} │
   │  发消息  Bearer <委托票据> + 对话委托 ───▶│─▶│                           │
   │                                          │  │ ① 控制连接上：             │
   │                                          │  │   hosted.delegate.verify ─▶│ 验签名、代数、开关、名单、禁入
   │                                          │  │◀ ok{projectId,userId,      │
   │                                          │  │     username,acc,exp}      │
   │                                          │  │ ② 过闸（第 6 节）          │
   │                                          │  │ ③ 找到或建实例；这个对话要 │
   │                                          │  │   连接时，控制连接上：     │
   │                                          │  │   hosted.ticket{projectId, │
   │                                          │  │    conversation,delegation}▶│ 再验一次，签连接票据
   │                                          │  │◀ hosted.ticket.ok{ticket}  │
   │                                          │  │ ④ 握手 promptcut.ticket.… ─▶│ 现有的票据握手
   │◀─ 202；事件流另开，可断可续 ──────────────│  project.op（以这个身份）─▶│
   │（页面此后可以关掉）                        │  │                           │
   │                                          │  │◀ hosted.project（开关变化、删除，随时）
```

- **①核验**：目录模块 `hosted` 加一种消息，只有服务名是 `agent` 的控制连接能发：`hosted.delegate.verify { delegation }` → `hosted.delegate.ok { projectId, userId, username, deviceName, creator, acc, exp }` 或 `error { reason }`（`reason` 只在这条受信的连接上给：`expired`、`generation`、`signature`、`no-project`、`service-disabled`、`banned`、`not-listed`、`audience`）。它不签任何东西，给不需要开连接的接口用（对话列表、用量）。Agent 服务把结果按票据摘要缓存 15 秒〔裁：不缓存到票据过期，被踢的成员最多再读 15 秒自己的对话列表〕。Agent 服务对页面一律回 401 `unauthorized`；只有 `service-disabled` 回 403 `disabled`（页面要据此显示「创建者已关闭」）。
- **③换连接票据**：用第三段在 `hosted.ticket` 上留的两个可选字段。`hosted.ticket { projectId, conversation: <对话号>, delegation: <对话委托> }`（短的委托票据换不了，必须是带 `cid`、`run` 的对话委托），文档服务：
  - 发来的控制连接的服务名必须是 `agent`（登记表里角色是 `agent`）；`render` 服务带了 `delegation` 回 `forbidden`；`agent` 服务**不带** `delegation` 只能要发布用的票据（`purpose: 'publish'`，第 16.3 节 R2），别的回 `forbidden`——它没有「服务自己读写项目」这回事；
  - 对话委托按 4.2 核对，`p` 必须等于 `projectId`；开关开着；名单与禁入表按成员再核一次。**不看成员此刻在不在线**；
  - 签一张连接票据：`{ kid, k: 'conn', p, u: <成员的 userId>, r: 'agent', c: <对话号>, sv: 'agent', acc, dn, cr?, g, ug: <成员的代数>, exp, iat }`。与渲染服务的票据不同的两处：`u` 是**成员**的 `userId`（不是 `service:…`），`ug` 是成员的代数——所以踢人、移出名单对它和对成员自己的票据一样生效。
- **④握手**：Agent 服务拿这张票据走现有的 `promptcut.ticket.<票据>` 握手，`auth-contract.md` 第 5 节「至多一项鉴权」不用改。握手对 `sv: 'agent'` 的票据：登记表里还有 `agent` 服务、开关开着、名单与禁入表照成员核（`admissionOf`），得到 principal：

```js
{ userId, tenantId: projectId, scope: 'member', username, deviceId, deviceName, creator,
  role: 'agent', conversation, owner: null,
  service: 'agent', access: 'rw' | 'r' }
```

  `scope` 是 `member` 而不是第三段渲染连接的 `service`：它进的是成员的身份，名单、禁入、按 `userId` 的代数都照成员办；`service: 'agent'` 这个字段让消息白名单（4.4）、成员列表与署名认得出它是云端的。会话接续（`resumeGate`）与逐消息的 `gate` 照第三段的办法重新看开关与登记表。
- **续期**：连接票据只在握手时用，握手之后连接一直用到断。这一轮里连接断了要重连、或会话要接续时，Agent 服务拿手里那张对话委托再换一张连接票据——**不需要页面在场**。对话委托过期（60 分钟，长于一轮的上限）或被撤销时换不出来，这一轮按 4.5 停下并记原因。
- **私钥在哪个进程**：第三段的做法是私钥只在管理进程里、干活的进程只拿短期票据（因为渲染进程里跑卡片代码）。Agent 服务第一版不执行任何用户写的代码（建卡改卡、自定义测量都关着），单进程持有私钥〔裁〕；以后开放会执行代码的工具时，要先把执行挪到不持私钥的子进程里，这一条写进 `draft_cloud-node-and-agent.md` 步骤 3 的遗留。

### 4.4 权限不超过成员本人

- 身份就是成员的 `userId`，进的就是成员所在的那个空间：文档服务现有的按空间隔离（`auth-contract.md` 第 6 节）原样生效，另一个项目的任何东西它都看不到。
- 带 `service: 'agent'` 的连接照第三段的办法走**消息白名单**（缺省拒绝）。`agent` 服务这一行：

| 能做 | 消息 |
|---|---|
| 读项目、收别人的改动 | `project.open`、`project.close` |
| 改项目（`access: 'rw'` 才行） | `project.op`、`project.upload` |
| 工具调用事件 | `events.create`、`events.complete`、`events.text`（事件模块借内容库写 `event-detail`，不经这条连接直接写内容库） |
| 在场状态 | 在场模块的发布与订阅（别的成员「正在编辑」的片段；Agent 的范围；「这一轮在不在跑」的 `cloud-run`，第 5 节） |
| 卡片源码〔2026-10-07〕 | `content.get`、`content.list`、`content.put`，只许 `kind: 'card-source'`；`content.put` 要 `access: 'rw'`（建卡改卡，第 9.3 节） |
| 素材票据〔2026-10-07〕 | `auth.ticket { kind: 'asset', access }`：读写的要 `access: 'rw'`；签出的票据是成员的身份加 `sv: 'agent'`（导入素材、配音入库，第 9.4 节） |

  明确拒绝、各有单测的：`auth.ticket` 里素材票据以外的种类（要不到连接票据、委托票据：不能给自己换角色、续命）、内容库里卡片源码以外的类别、`content.watch`、`shared.*`（含创建者操作与成员列表）、`node.hello` 与全部队列消息、`content.put`、`project.snapshot.put`、`service.announce` / `service.withdraw`、成本记录。白名单以实现时在探针里抓到的消息类型为准，多一种就回来改本表。
- `access: 'r'` 的连接发 `project.op`、`project.upload` 回 `forbidden`；事件照发（读工具也有事件）。
- 素材〔2026-10-07 改：原「第一版 Agent 不取素材票据」作废〕：云端 Agent 代成员取素材票据，权限不超过成员本人——只读成员要不到读写的；素材服务每次核对都重看登记表、开关、名单、禁入表与成员此刻的权限，撤销后当场失效；只能写素材原件（`media`），不能写预渲染产物。读素材与成员本人同一个口径（按哈希读，`auth-contract.md` 第 8 节的既有裁定）。细节见第 9.4 节。

### 4.5 三种失效怎么传到并停掉对话

| 触发 | 文档服务做什么 | Agent 服务怎么知道 | 流上的 `reason` |
|---|---|---|---|
| 创建者关掉云端 Agent 开关 | 记录落盘；本空间里 `service: 'agent'` 的连接以 4003 `service-disabled` 关闭；之后委托票据的签发与核验、连接票据的签发、握手、接续一律拒；目录推 `hosted.project { projectId, enabled: false }`；给其余连接发 `shared.notice { event: 'hosted-service-changed', service: 'agent', enabled }` | 连接被关，或目录推送，哪个先到算哪个 | `disabled` |
| 成员被移出名单（`set-list`） | 现有：该用户名全部连接以 4003 `removed` 关闭、代数加一。云端 Agent 的连接带同一个用户名，随同被关 | 连接被关 | `removed` |
| 成员被踢（`kick`） | 现有：该 `userId` 的连接以 4003 `kicked` 关闭、进禁入表、成员代数加一。同上 | 连接被关 | `kicked` |
| 项目删除（`delete`） | 现有：全空间连接以 4004 关闭；目录推 `removed` | 连接被关，或目录推送 | `deleted` |
| 改项目口令（`set-password`） | 现有：代数加一，在线连接不断。云端 Agent 的连接也不断（与成员自己的连接一致）；成员下一次要委托票据前得先用新口令进入 | — | — |

- 进行中的一轮手里至少有一条开着的连接（副本的订阅连接），所以「连接被关」这一路对进行中的对话总是到得了，不需要另加按成员的推送。**这条路不经过成员的任何设备**：成员全都离线时，创建者（或别的设备上的他自己）关开关、踢人、删项目，照样在 2 秒内停掉云端的这一轮。停下的原因记进事件记录，主人回来看得到（7.3）。没有进行中对话的闲置实例没有要停的东西，下一次请求时核验不过。
- Agent 服务收到其中任何一种：立刻中止受影响实例里所有进行中的一轮（模型请求的 `AbortController`、等待中的工具），流上发 `error { code: 'revoked', reason }` 后结束；关实例；清掉这个实例的核验缓存。「立刻」的口径：文档服务处理完创建者操作到 Agent 服务停止向模型发新请求与提交新写入，不超过 2 秒〔裁〕；之后就算有漏网的写入，连接已关，文档服务也不收。
- 控制连接断开期间，Agent 服务核验不了票据、换不了连接票据：不接新对话（回 `unavailable`），已有连接的对话照常跑，靠各自连接被关来停。
- 项目删除后，Agent 服务删掉 `tenants/<projectId>/` 下的对话记录与模型历史（用量记录留着，它是托管方的账）。

### 4.6 只读成员

现行语义里没有只读成员：`workflow/project.md` 写「其余操作所有成员一样」。任务书完成条件第 4 条要求「只读成员发起的对话改不了项目」。本设计把**机制**做全：委托票据带 `acc`、连接票据与 principal 带 `access`、文档服务按它拒写（4.4）；`acc` 由文档服务的一个函数 `memberAccess(项目记录, 用户名)` 决定，它读项目记录里一个可选字段 `readonly: [用户名]`，没有这个字段时人人是 `rw`。这一版**不加**设置这个字段的界面与创建者操作〔裁：主会话 2026-10-06〕〔原裁：加了就是一个任务书没列的用户可见功能〕；隔离探针在本机隔离的托管组合里直接写项目记录来造一个只读成员。这一条请主会话确认（第 15 节）。

### 4.7 我对通用「托管方服务身份」的要求（给第三段）

第三段的草稿已经满足大部分，逐条对照：

| # | 要求 | 第三段草稿 | 还差什么 |
|---|---|---|---|
| 1 | 服务身份带服务种类，一种服务的凭证冒充不了另一种 | 满足：登记表里一个服务一把密钥，角色写在登记表里 | `keygen.mjs` 要能给 `--service agent` 生成，私钥目录可指定 |
| 2 | 服务单独握手得到不属于任何项目的控制连接 | 满足（1.2、1.3） | — |
| 3 | 控制连接上能知道项目的开关变化与删除 | 满足（`hosted.watch` 推 `hosted.project`） | `enabled` 要**按发起订阅的服务**取：`agent` 服务看到的是云端 Agent 的开关。`active` 对 Agent 没用，照给即可 |
| 4 | 凭委托换连接票据 | 留了口子：`hosted.ticket` 的 `conversation`、`delegation` | 按 4.3 ③填：只对 `agent` 服务认；`agent` 不带 `delegation` 回 `forbidden`；票据的 `u`、`ug` 取成员的 |
| 5 | 只核验不签的入口 | 没有 | 加 `hosted.delegate.verify`（4.3 ①），只对 `agent` 服务开 |
| 6 | 每个项目对每种服务一个开关，同一种创建者操作与通知 | 渲染的是 `hostedRender: { enabled }`、`set-hosted-render`、`hosted-render-changed`、成员列表顶层 `hostedRender: { available, enabled }` | 〔裁：主会话 2026-10-06〕 统一成一种，两段都照此做：项目记录 `hosted: { render: { enabled }, agent: { enabled } }`（缺省都算开）；创建者操作 `shared.admin { op: 'set-hosted-service', service, enabled, proof }`；`shared.members.list` 顶层 `hosted: { render: { available, enabled }, agent: { available, enabled } }`；通知 `shared.notice { event: 'hosted-service-changed', service, enabled }` |
| 7 | 消息白名单按服务名查 | 满足（1.5），本段只填 `render` 一行 | 白名单要能按连接的 `service` 字段查，而不只按 `scope === 'service'`：云端 Agent 的连接 `scope` 是 `member`（4.3 ④） |
| 8 | 握手对带 `sv` 的票据怎么核 | 渲染：不查名单、不查禁入表 | `sv: 'agent'` 的票据**要查**名单与禁入表（它用的是成员身份）。握手里按 `sv` 的值分两支 |
| 9 | 成员列表里认得出 | 行上的 `service: 'render'` | 云端 Agent 的连接归在成员那一行的 `conns` 里，连接项带 `service: 'agent'`（第 5 节），不另起一行 |
| 10 | 关开关时关连接的关闭码 | 4003 `service-disabled` | 同用，不另设关闭码 |
| 11 | 凭证不是集群令牌、不由它派生；日志不记原文 | 满足 | — |
| 12 | 保留用户名 `service:` | 满足 | Agent 的连接用成员的用户名，不受影响 |

---

## 5. 署名与成员列表

- 写入身份（项目版本日志、内容库、事件的 `actor`）在现有 `{ userId, deviceId, role, conversation, session }` 上加 `service: 'agent'`（取自连接的 principal）。`userId` 是发起成员的，所以覆盖通知、撤销冲突、「谁刚改过」这些按身份判的逻辑不用改；别人看到的是「张三的云端 Agent 刚改过」。
- 显示名规则（页面一处函数，桌面与在线共用）：`role === 'agent'` 且 `service === 'agent'` → 「〈用户名〉的云端 Agent」；不带的照旧「用户名 · Agent · 第几个对话」。同一位成员开了多个云端对话时在后面加「· 第几个对话」。
- 成员列表：云端 Agent 的连接归在发起成员那一行下（`conns` 里多一项 `{ role: 'agent', conversation, service: 'agent' }`，`tags.agents` 照常加一），界面在这位成员下显示「云端 Agent」标记〔裁：不另起一行。它用的是这位成员的身份与权限，另起一行会被读成多了一个成员〕。
- 撤销语义不变：AI 栏「撤销这一步」仍由页面以自己的身份提交逆操作（`c65-design.md` 第 8 节），工具调用事件照旧经对话连接发给文档服务的事件模块，在线页面从文档服务收。

---

## 6. G：闸与用量记录

### 6.1 开关与额度存在哪

| 项 | 归谁管 | 存在 | 缺省 |
|---|---|---|---|
| 项目的「云端 Agent」开关 | 项目创建者 | 文档服务的项目记录 `hosted: { render: { enabled }, agent: { enabled } }`（缺省都算开），创建者操作 `shared.admin { op: 'set-hosted-service', service: 'render' | 'agent', enabled, proof }`〔裁：主会话 2026-10-06〕 | 开 |
| 项目的额度 | 托管方（节点的主人） | Agent 服务的 `config/limits.json` 的 `projects[<projectId>]` | 不限 |
| 节点级的资源上限 | 托管方 | 同一文件的 `node` | 第 11 节的数字 |

〔裁〕额度不放进文档服务的项目记录：它是托管方发给项目的，不是创建者自己能改的；放在 Agent 服务自己的配置里，创建者的任何操作都碰不到它。

`limits.json`：

```json
{
  "v": 1,
  "node": { "maxRuns": 6, "maxRunsPerProject": 3, "maxRunsPerMember": 2, "maxInstances": 24 },
  "defaults": { "limitTokens": null, "window": "total", "maxRuns": null },
  "projects": { "sp_…": { "limitTokens": 2000000, "window": "month", "maxRuns": 2 } }
}
```

- `limitTokens`：`null` 不限；数字是这个窗口内输入加输出的 token 上限。`window`：`total`（累计）、`month`、`day`（按 UTC）。
- 服务每次过闸前看文件的修改时间，变了就重读；格式不对保留上一份并记日志。**发上限只改这个文件，不改代码、不重启。** 另给一条命令 `node server/agent-service/admin.mjs quota set <projectId> --tokens <N> [--window month]`、`quota clear <projectId>`、`usage [--project <id>] [--since <日期>]`，它只是改这个文件、读用量记录。

### 6.2 闸

一个模块 `server/agent/service/gate.mjs`，两个入口，所有路径都走它：

```js
gate.admitRun({ projectId, userId })              // 一轮开始前
gate.admitModelCall({ projectId, userId, model }) // 每次向模型发请求前
  → { ok: true } | { ok: false, code: 'disabled' | 'busy' | 'quota-exceeded', message }
gate.record({ projectId, userId, username, conversationId, runId, vendor, model, input, output, cacheRead, ok, ms })
```

- 接线：`admitRun` 在「发消息」处理的最前面；`admitModelCall` 与 `record` 接在驱动里每次模型请求的前后——给 `server/harness/agent.mjs` 加一个可选的 `onModelCall(phase, info)` 回调（`before` 可以抛错中止，`after` 带这一次的 `usage`），`api.mjs` 透传。模型请求只从这一处发出，审查环路（以后开的话）也经它。单测 CA-GATE-01 断言每次模型请求前都调过闸。
- 判定顺序：开关（`disabled`）→ 节点并发、项目并发、成员并发（`busy`）→ 额度（`quota-exceeded`）。
- **现在永远放行的含义**：`defaults.limitTokens` 为 `null`、`projects` 为空时，额度那一步对任何项目都放行；项目并发 `defaults.maxRuns` 为 `null`。节点级的三个并发数是保护同机服务的资源上限（任务书完成条件第 9 条），有数字，不属于「额度」。
- 拒绝的话：`quota-exceeded` →「这个项目的云端 Agent 额度已用完（已用 X / 上限 Y）。请联系托管方。」；`busy` →「云端 Agent 正忙，请稍后再试。」；`disabled` →「项目创建者已关闭云端 Agent。」一轮中途超额：当前这次模型请求不发，流上发 `error { code: 'quota-exceeded' }` 后结束，已落地的改动保留。

### 6.3 用量记录

- 每次模型请求一行，追加到 `usage/<yyyy-mm>.jsonl`：

```json
{"t":1759737600000,"projectId":"sp_…","userId":"alice@dev1","username":"alice","conversationId":"c-…","runId":"…","vendor":"anthropic","model":"…","input":1234,"output":567,"cacheRead":0,"ok":true,"ms":8421}
```

- 不含提示词、回复、工具参数、Key。文件 0600。
- `usage/totals.json`：各项目、各成员在各窗口的累计，每 30 秒与退出时落一次；启动时用它加上之后的流水重建。它坏了就从流水全量重算。
- 查询：成员用 `GET /v1/usage`（本项目的总量与各成员的量）；托管方用 `admin.mjs usage`（可跨项目）。
- 模拟模型提供方也照常报 `usage`，所以第 7 条验收不依赖真实模型。

---

## 7. 对话的状态：存在云端，不依赖发起方

### 7.1 存什么、存在哪

Agent 服务的数据目录，按「项目 / 主人 / 对话」分目录（2.2 节）。每个对话四个文件，全部由**服务端**写：

| 文件 | 内容 | 什么时候写 |
|---|---|---|
| `meta.json` | 标题（第一条消息的前 40 个字，可改）、状态、`lastSeq`、最近一轮的 `runId`、起止时刻、结束原因、发起设备名 | 状态每变一次（临时文件加改名） |
| `events.jsonl` | 事件记录（2.4）：用户消息、流式回复、工具调用过程、进度、错误、补渲进展 | 每个事件追加一行 |
| `history.json` | 模型那一侧的消息历史，页面读不到 | 每完成一次工具往返落一次（见下） |
| `pending-render.json` | 这个对话引出、还没渲完的补渲清单（第 16 节） | 发布、完成时 |

对话记录、进行中状态、工具调用过程都在节点上；页面与桌面版本地不存云端对话的任何东西（页面可以缓存，丢了能从 `events` 重新拉）。

〔裁〕不放文档服务的内容库：对话正文可能很长、带模型的原始输出，文档服务是「只传小消息」的调度中心；放进去还要给内容库加按成员的读权限。

模型历史**每完成一次工具往返就落一次盘**。现在只在一轮结束或出错时落（`api.mjs:326`），进程被杀时这一轮做过的事全丢，而改动已经进了项目。给 `startRun` 加可选的 `checkpoint: true`，托管档打开，桌面本机 Agent 不传。

### 7.2 对话归谁、谁能读

- **主人键**〔裁：主会话 2026-10-06〕（待用户审），按进入方式分：

| 这位成员是 | 主人键 | 换设备能不能找回 |
|---|---|---|
| 以创建者身份进入的（出示了创建者口令） | 项目 + 「创建者」 | 能 |
| 限定进入的名单成员（各有自己的口令） | 项目 + 用户名 | 能 |
| 自由进入的成员（用户名是自报的） | 项目 + `userId`（用户名加设备） | 不能，只能在原设备找回 |

  取保守的一条：不新增「知道项目口令并自报同名就能接管别人对话」这种用户可见的安全后果；用户体验验收要求的是创建者换设备，已满足。主人键由文档服务核验委托票据后回的字段算（`creator`、项目的进入方式 `mode`、`username`、`userId`），页面自报不了；`hosted.delegate.ok` 因此多回一个 `mode`。
- 别的项目读不到；同项目里别的用户名读不到〔裁：对话里有成员自己的措辞与没采纳的想法，项目的共同成果是落地的改动与工具调用事件，那些所有成员都看得到〕。
- 托管方能读（数据在它的节点上）。任务书没有要求对托管方保密，写在这里让用户知道。
- 成员被移出、被踢后对话记录留着但他读不到（要不到票据）；项目删除时删掉。
- 容量：每个对话 `events.jsonl` 上限 8 MiB（到了就不再记 `thinking` 与 `diagnostic`，再到 12 MiB 这个对话不能再发消息，提示新开一个）、`history.json` 上限 8 MiB（超了按现有的历史截断）；每个主人每个项目最多 50 个对话，超了删最久没动且不在跑的〔裁，数字进 `mechanism/agent.md`〕。

### 7.3 一轮的生命周期

```
发消息（202）──▶ running ──┬─▶ idle（正常说完）
                           ├─▶ idle（主人停掉；事件里记「已停止」）
                           ├─▶ failed（模型失败、额度用尽、到上限；记原因）
                           ├─▶ revoked（开关关了、被移出、被踢、项目删除；记原因）
                           └─▶ interrupted（服务进程重启；记原因）
```

- 一轮只属于服务端。发起它的 HTTP 请求在回 202 时就结束了；之后有没有人连着看都一样跑。
- 每种收尾都在事件记录里留一条给人看的原因（`error` 事件）与一条 `end`，`meta.json` 的状态与原因同步改。**出了错不悄悄丢**：模型调用失败 →「模型调用失败：〈接口给的原因，去掉 Key 与地址〉」；额度用尽 → 6.2 的话；被移出、被踢、关开关、删项目 → 4.5 的 `reason` 对应的话；补渲失败 → 第 16 节的 `render` 事件。
- **项目停在完好的版本上**：每次工具写入是文档服务的一次原子提交，一轮在任何时刻被停，项目都停在最后一次成功提交之后，没有半截的写入。事件记录里能看到做到了第几步。
- 上限：一轮最多 24 次模型往返、30 分钟〔裁：主会话 2026-10-06〕；到了记 `error { code: 'limit' }`，对话可以接着说。

### 7.4 重新打开后怎么找回

- **在线页面**：进入项目、AI 栏挂起来时调 `GET /v1/info` 与 `GET /v1/conversations`。对话列表（现在 AI 栏的历史列表）列出这位成员在这个项目里的云端对话，在跑的带「进行中」标记；`info.running` 不空时自动打开那个对话并接上流（`events?after=0`），不用用户去找。
- **桌面版**：同一套。打开一个放云端的项目、文档服务连上之后，AI 栏的历史列表里本机对话与云端对话分两组；有在跑的云端对话时，AI 栏顶上出一条提示「云端有一个对话正在进行」，带按钮「接上看看」，点了即接上（〔用户 2026-10-07 定〕：保留提示条，不做页签标记；实现与第 21 节一致）。**不自动把接入方式切到「云端」**（本机 Agent 仍是缺省）。
- 另一台设备：同一个用户名进同一个项目，看到的是同一份列表（7.2）；打开在跑的对话即接着看，`abort` 能停，说下一句就是在那台设备上起新的一轮（带那台设备的对话委托）。
- 撤销：Agent 的每次写入在文档服务的事件模块里有完成事件（带 `callId`、`opId`、逆操作，`c65-design.md` 第 7 节）。重新打开后页面照常从文档服务取这些事件，按 `callId` 对上事件记录里的工具调用，「撤销这一步」与本机 Agent 相同，由页面以自己的身份提交逆操作。**待实现时用探针验**：页面在这些事件发生时不在线，重开后取不取得回逆操作；取不回就按 `solution_table.md` 建表（候选：页面进入时向事件模块补拉最近 N 条；逆操作改从内容库的 `event-detail` 取）。

### 7.5 进程被杀之后

- 进程起来时扫所有 `meta.json`：`running` 的改成 `interrupted`，事件记录末尾补一条 `error { code: 'interrupted' }`「云端 Agent 服务中断，这一轮没有做完。已经落地的改动保留在项目里。」与 `end`。
- **不自动续跑**〔裁：主会话 2026-10-06〕：续跑要凭证，而对话委托只在内存里（4.2），重启后没有了；让它无凭证地继续不行，把委托落盘又是在节点上多存一份能代成员行事的东西。主人回来看到中断，说一句「继续」就是新的一轮：模型历史接着上一次落盘处（悬空的工具调用由现有的 `healDanglingToolUse` 补平）。
- 没渲完的补渲清单（`pending-render.json`）在进程起来后重新发布（第 16 节），不需要成员在场。
- PM2 负责拉起（`autorestart`）。

---

## 8. F：模型 Key

〔用户 2026-10-07 推翻:正式的 Key 录入改为加密分发（节点报机器识别码 → 用户在自己的电脑上用 `make-api-share.bat` 生成只有这台节点解得开的密文 → 会话把密文送到节点导入）；明文不再经会话，也不再要求用户在节点终端里手敲。办法与命令见第 23.2 节；下面 8.2 的交互式录入保留，只作本机调试用〕

### 8.1 保存

沿用 `server/ai-config.mjs` 与 `server/runners/config-crypt.mjs`：`config/ai.json` 存厂商、接口地址、模型清单（`a|b|c`）、`maxTokens`；Key 的密文在 `config/keys/custom.key`（`PCENC1.` 封装，口令由本机指纹派生，Linux 上取 `/etc/machine-id`，`machine-id.mjs:82`），文件 0600。整个文件拷到别的机器上解不开。Key 的明文只在 Agent 服务进程的内存里；事件、历史、日志里出现时照现有逻辑替换掉（`api.mjs:143`、`:332`）。

这层封装挡的是「明文躺在文件里」，挡不住能以同一个系统用户在节点上跑代码的人（`config-crypt.mjs` 文件头已写明）。节点是托管方自己的，这一条如实写进给用户的说明。

### 8.2 录入办法（由用户在节点上执行）〔用户 2026-10-07 推翻:只作本机调试用,正式录入见 23.2〕

新脚本 `server/agent-service/set-key.mjs`：

```
cd <部署目录> && PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/set-key.mjs
```

- 交互式：依次问厂商（anthropic / openai / gemini）、接口地址（可空）、模型清单、Key。Key 那一问关掉回显（终端 raw 模式逐字符读，不打印），读完立刻封装写盘，变量清掉。
- **不接受命令行参数与环境变量里的 Key**（给了就报错退出），所以进不了 shell 历史与进程列表；标准输入不是终端时拒绝运行（防止被管道喂进来顺手留在历史里）。
- 脚本自己不打印 Key，结束时只打印「已保存，末四位 ××××」。写完给运行中的服务发 `SIGHUP`（经 PM2 的进程号），服务重读配置，不用重启。
- 清除：`set-key.mjs --clear`。
- 给用户的说明（进报告与 `hosting-migration.md`）另写三句：用 SSH 登录后直接运行，不要用 `ssh host "命令"` 的形式把 Key 写在命令里；不要把 Key 发到任何对话里；想换 Key 重新运行一次。

### 8.3 模拟模型提供方

- 现成的在 `server/harness/providers/mock.mjs`，`ai.json`（或 `opts.apiConfig`）里 `vendor: 'mock'` 时启用（`api.mjs:227`），不需要 Key（`api.mjs:173`）。它现在是写死的两回合（调一次 `get_editor_state`、说一句话），不够跑「改文案、挪片段、调卡片参数」。
- 扩成**按提示词里的脚本走**：用户消息里出现形如

  ````
  ```mock-script
  [{"tool":"get_project","input":{}},{"tool":"update_clip","input":{"clipId":"…","params":{"text":"新文案"}}},{"say":"改好了"}]
  ```
  ````

  的代码块时，模拟提供方逐回合照它发工具调用与文字，每回合报一次 `usage`（按字符数算出的确定值）；另认 `{"sleepMs":N}`（测停止、测并发）与 `{"fail":"message"}`（测模型报错）。没有脚本块时保持现在的两回合不变（现有单测不动）。
- 切换：`set-key.mjs --mock` 把 `config/ai.json` 写成 `vendor: 'mock'`；录入真 Key 时覆盖回来。`GET /v1/info` 在模拟时带 `mock: true`，页面的模型名显示「模拟模型」，免得有人以为是真的。

---

## 9. J：工具清单与 I：界面

〔用户 2026-10-07 更正〕原先写的「第一版不开放建卡改卡、导入素材、网页采集、配音」是会话的建议被误记成用户的决定，作废。**云端 Agent 的工具与本机 Agent 一致**；唯一可以缺省的是要操作发起人自己界面的工具。本节按这个范围重写（2026-10-07，分支 `claude/cloud-agent`），旧的「开放清单 66 个」与「云端暂不支持」不再存在。

### 9.1 判定规则

工具表（`server/mcp-tools.mjs`，128 个）里的**每一个**工具在 `server/agent/service/cloud-tools.mjs` 的 `CLOUD_TOOL_PLAN` 里归到五种跑法之一。没有归类的工具（以后新加的）按「还没接上」答，并由单测 CA-TOOL-02 拦住：新加工具必须表态。

| 跑法 | 含义 | 个数 |
|---|---|---|
| 在副本上执行（`route`） | 在服务端的项目副本上同步执行，改动带期望版本提交给文档服务；进程级的锁里跑，实现必须是同步的。其中看画面的四个（标 `look`）读副本后向同机的渲染服务要一帧，不进锁（9.8） | 71 |
| 服务端另有实现（`hosted`） | `server/agent/service/hosted-tools.mjs`（声音的三组在 `hosted-sound.mjs`、`hosted-audio.mjs`、`hosted-card-audio.mjs`，网页采集在 `hosted-collect.mjs`）：文件只进这个对话的工作区、出网只经出网闸、素材经素材服务、卡片源码经文档服务的内容库、花钱的调用记用量。外部的等待在锁外，进锁只做同步的改项目 | 20 |
| 就地执行（`server`） | 不碰项目：`wait`、`report_progress`、多 Agent 公告板四个 | 6 |
| 要操作发起人的界面（`initiator`） | 发起方不在线时立刻回 `{ ok: false, initiatorOffline: true, error }`，Agent 据此继续；在线时四个（`seek`、`play`、`pause`、`get_selection`）经反向通道让他的页面执行（第 28 节），另外四个回 `initiatorOnly` 并写明差什么 | 8 |
| 这一版还没接上（`pending`） | 逐项写明差什么，记未达成；不交给模型，调用时回 `{ ok: false, cloudUnavailable: true, error: '云端 Agent 这一版还用不了 <工具>：<差什么>。…' }` | 23 |

交给模型的是前四类共 105 个（加驱动自带的 `think`）〔2026-10-07 接上声音的六个与网页采集的七个，见 9.4a～9.4d 与第 26、27 节〕；节点没有配看画面的口子（`PROMPTCUT_AGENT_LOOK_URL`）时少掉看画面的四个与卡片声音的两个（都要同机的渲染服务），是 99 个，看画面的四个调用时回 `{ ok: false, cloudUnavailable: true, error: '云端 Agent 在这台节点上看不了画面…' }`；`text_editor` 仍不提供（它读写的是驱动的工作目录，云端的文件只经工作区的工具）。工具调用的总入口再判一次。

### 9.2 逐个工具

| 分组 | 在副本上执行 | 服务端另有实现 | 要操作发起人的界面 | 这一版还没接上（差什么） |
|---|---|---|---|---|
| project（7） | `get_project`、`list_media`、`set_project_meta`、`set_theme`、`list_media_effects` | `import_media` | `get_selection`（在线：经反向通道读页面当下的选区；第 28 节） | — |
| clips（8）、layout（6）、tracks（5）、parts（6）、effects（10） | 全部。`get_layout` 的实体框向渲染服务量（9.8）；节点没配看画面的口子、或这次没量成时只回规定的框，`contentBox` 是 null 并带一句原因 | — | — | — |
| cuts（8） | 全部。`switch_cut`、`add_cut`、`remove_cut` 要播放头：在线用发消息时的，不在线按 0 记并注明 | — | — | — |
| audio（19） | `set_clip_volume`、`set_clip_muted`、`separate_audio`、`create_audio`、五个 `*_audio_fx`、`sound_presets` | `voice_list`、`voice_generate`；`sound_generate`、`sound_status`、`sound_cancel`（9.4a）；`measure_audio`（9.4b）；`render_card_audio`、`cancel_card_audio`（9.4c，要节点配了看画面的口子） | — | `measure_audio_js`：模型写的测量脚本要在断网的无头浏览器里跑，Agent 服务进程不起浏览器；差渲染服务那一侧开一个跑脚本的口子（解码出来的 PCM 怎么送过去、脚本的时限与内存上限怎么并进渲染服务的看护） |
| ai（19） | `detach_clip_motion`、`get_transcript`、`fill_captions`、`list_captions`、`edit_caption`、`list_shots`、`list_subjects` | — | — | `stt_status`、`stt_install`、`transcribe_media`（语音识别）、`detect_shots`（镜头）、`track_points`、`get_track`、`track_status`、`track_install`（追踪）、`detect_subjects`、`subject_status`、`subject_install`（主体）：要节点上的 Python 运行环境与模型权重，并把页面里的作业表搬到服务端。`attach_clip_motion`：要一份追踪结果 |
| cards（8） | `list_cards`（含本项目的用户卡）、`apply_card`；`bake_card`、`inspect_card_dom`（看画面，9.8） | `card_authoring_guide`、`get_card_source`、`create_card`、`edit_card` | — | — |
| vision（2） | `see_frames`（时间轴的画面）、`get_gif`（看画面，9.8） | — | — | `see_frames` 的素材镜头拼图（`source: "media"`）：要节点上的镜头识别，回明确的原因 |
| collect（9） | — | `collect_status`、`collect_install`（云端不装东西）、`collect_search`、`collect_probe`、`collect_download`、`collect_job`、`collect_logout`（9.4d；节点上没装采集工具时回明确的原因） | `collect_login`、`collect_login_check`（要用户自己扫码或输口令；在线时也做不了，原因见第 28.3 节） | — |
| browser（8） | — | — | `web_handoff`（在线时也做不了，第 28.3 节） | 其余七个：要节点上的浏览器，并让它只经出网闸的代理出网、按对话隔离用户数据目录 |
| agent（5） | — | —（`declare_scope`、`list_agents`、`send_message`、`check_messages` 就地执行） | `spawn_agent`（要页面开页签；在线时也做不了，第 28.3 节） | — |
| core（8） | —（`wait`、`report_progress` 就地执行） | — | `seek`、`play`、`pause`（在线：经反向通道在发起人的页面上执行；第 28 节） | `background_job_status`、`auto_workflow`、`auto_workflow_status`：依赖语音识别等后台作业 |

「这一版还没接上」的 23 个都不是事先排除：接上之后把它在 `CLOUD_TOOL_PLAN` 里挪到上面某一类即可。节点上要装什么见 9.9。

**要操作发起人界面的八个，发起方在线时**〔2026-10-07 做成反向通道后改，细节在第 28 节〕：`seek`、`play`、`pause`、`get_selection` 经反向通道让**发起这一轮的那张页面**用它本机同一份实现执行，结果与本机同形；那张页面不在（没连着、到时限没答、等的中途断了）回 `initiatorOffline`，其中 `get_selection` 在这位成员还有别的窗口连着看时退回发消息时的选区并注明。`web_handoff`、`collect_login`、`collect_login_check`、`spawn_agent` 在线时仍回 `{ ok: false, initiatorOnly: true, error }`，`error` 里逐个写明差什么（第 28.3 节）。

### 9.3 建卡改卡

- 卡片源码存在**这个项目的内容库**里（文档服务的 `card-source`，键是仓库相对路径，如 `src/cards/user/<id>.tsx`），与本机 Agent 在协作项目里建卡同一条路：别的成员的页面、渲染节点从内容库取。云端 Agent 的连接为此在白名单里多了 `content.get`、`content.list`、`content.put`，只许 `card-source` 这一类，写要读写权限（第 4.4 节）。
- `create_card` / `edit_card` 只做静态的事：翻译器、审查、语法检查（`server/vite-plugin-cards.ts` 的 `translateCardSource`、`checkCardSource`、`checkSourceEdit`、`applyCardPatch`，与桌面版同一份函数），另过一遍渲染节点装卡时用的预检（`server/hosted-render/source-gate.mjs` 的 `checkSyncedSource`），不过就不入库并把原因回给模型。**Agent 服务进程里不执行卡片代码**（所以第 4.3 节「单进程持有私钥」的裁定不变）。
- Agent 自己要「认得」这张卡（`list_cards`、`add_clip` 校验参数）：用 `src/kernel/cardSourceParse.mjs` 静态解析出 id、名字、默认值与控件（只认字面量），在进程级的锁里临时登记进服务端的卡片表、出锁撤掉（`ssr-host.mjs` 的 `registerProjectCards`，登记的是只有数据的空壳）。卡片表是进程里的单例，所以一个项目的卡不会留给下一个项目。`id`、`name`、`defaults`、`controls` 不是字面量的卡入得了库、成员也能用，但 `add_clip` 在云端认不出它（工具结果里明说）。
- 改内置卡：改动写进本项目的内容库（键是那个文件的仓库相对路径），只影响这个项目；云端 Agent 自己的卡片表里那张内置卡的参数表仍是检出里的那一份。
- 创造力等级照旧管：新建是「高」、整篇重写已有的是「中」；「有没有这张卡」按本项目的内容库判。
- 这张卡在别的成员的浏览器与渲染节点上执行，由第二、三段的隔离保护；云端不另设限制。卡片里不能引用外链的图片、字体（渲染节点与在线舞台不出网），系统提示词里写明。

### 9.4 导入素材、配音与附件

- **素材票据**：云端 Agent 的连接可以要素材票据（`auth.ticket { kind: 'asset', access }`），由文档服务签成「成员的身份加 `sv: 'agent'`」，`r` 不超过成员此刻的权限（只读成员要不到读写的）。素材服务每次核对票据都重新看登记表、项目开关、名单、禁入表与成员此刻的权限：关开关、被踢、被移出、被改成只读后当场失效。这种票据只能写素材原件（`media`），不能写预渲染产物（`snap`、`px`）；它写的块算成员的，不进托管方服务的容量账。渲染服务（`sv: 'render'`）的规则不变。
- **读素材的口径不变，工具层另加一道**〔裁：主会话 2026-10-07〕：素材服务按哈希读的既有口径没动（`auth-contract.md` 第 8 节），云端 Agent 的票据与成员本人同口径；工具层另加一道——云端 Agent 的工具只按本项目素材表里的素材 id 工作，不接受裸的哈希，同机素材服务的地址在出网闸那里就被拒（隔离探针 T1c）。这是纵深，不是改口径。
- `import_media { url, name? }`：`url` 是附件地址（`work:attachments/<文件名>`，或桌面版写法 `/@pcwork/<本对话 id>/<文件名>`）或 http(s) 地址（经出网闸下载到工作区）。先确认成员写得进（只读成员在下载之前就被拒），再按内容哈希分片写进素材服务，然后在副本上登记素材；视频照桌面版放上时间轴（发起方在线放在他发消息时的播放头，不在线接在现有内容后面）。素材条目只有原件一档（`tiers: { original }`），小尺寸一档没有做（要节点上的 ffmpeg 转码），记未达成。时长与宽高：图片读文件头，音视频用节点上的 ffprobe（没有就只认 WAV，其余在结果里注明没读出来）。
- `voice_generate`：用托管方的配音配置（`<数据目录>/config/voice.json` 与 `config/keys/voice.key`，与模型 Key 同一套落盘加密与导入办法），先确认成员写得进（只读成员不花钱），合成后入库、登记，每次调用记一行用量（第 6.3 节）。没配时工具回明确的原因。
- **附件**：页面把文件传到 `POST /v1/conversations/<id>/attachments?name=<文件名>`（请求体是文件字节，单个 512 MiB），存进这个对话工作区的 `attachments/` 下，回 `{ attachment: { name, url: 'work:attachments/…', size, kind, text? } }`；发消息时请求体多一个可选的 `attachments: [{ url }]`，服务端只认这个对话工作区里真有的文件，拼进提示词（不给磁盘路径，小的文本内联）。要进素材库由 Agent 调 `import_media`。

### 9.4a 音效合成（`sound_generate`、`sound_status`、`sound_cancel`）

〔2026-10-07 做成，实现记录在第 26 节〕`server/agent/service/hosted-sound.mjs`。

- **在 Agent 服务进程里按块合成。** 提示音与键盘声的合成内核是确定性的纯计算（`src/kernel/soundEffects.ts`），不执行任何项目带来的代码，所以不违反「Agent 服务进程不执行卡片代码」。
- **与桌面版同一份函数**：参数 → 配方与落点是 `src/audio/soundRequest.ts` 的 `planSoundGeneration`（从编辑器的绑定里搬出来的纯函数，桌面版也改用它）；配方 → PCM16 WAV 是 `src/audio/soundGeneration.ts` 的 `renderSoundEffectWav`（桌面版在 Web Worker 里跑的就是它）；登记是 `commitSoundEffect`（素材条目带配方与内容哈希、片段带配方与 requestId，一次提交）。所以同一份配方两边合成出的 WAV 逐样本相同。
- **顺序**：先确认成员写得进（只读成员在合成之前被拒）→ 在项目副本上算计划 → 合成 → 凭成员本人的素材票据写进素材服务（`media`）→ 进锁原子登记。提交时照桌面版核对：计划时的目标片段、来源片段若已被改，这次结果不应用（`stale`），旧音效不动。
- **作业表按实例（项目 × 成员）分**：别的项目、别的成员的对话看不到、查不到、取消不了；作业号带随机数（`sound-<12 位十六进制>`）。同一位成员在同一个项目里的几个对话互相看得到（`sound_status` 不传 jobId 列出来）。
- **上限**：配方的上限照内核（60 秒、1 万个事件、96 KiB 的配方）；一位成员在一个项目里最多排 4 个；整个进程里同时只合成一个，每块让出一次事件循环。
- **幂等**：同一个 requestId 重试加入已有的作业或直接回已有的结果，不再合成、不多出片段；同一个 requestId 换了配方被拒。
- **结果的形状**：成功 `{ ok: true, jobId, requestId, state: 'succeeded', progress: 1, result: { mediaId, clipId?, reused } }`；没成 `{ ok: false, state: 'failed' | 'cancelled' | 'stale', error }`。
- **用量**：每次合成记一行 `kind: 'service'`、`service: 'sound'`、`vendor: 'builtin'`、`model: <预设>`、`units: <WAV 字节数>`、`unit: 'bytes'`（不花钱，记的是做了多少）。
- 服务重启后作业表清空（配方已经随片段存在项目里，重新生成即可）。一轮被停掉时正在合成的作业不随之取消（与桌面版关掉 AI 栏相同）。

### 9.4b 测响度（`measure_audio`）

〔2026-10-07 做成〕`server/agent/service/hosted-audio.mjs`。

- 「测谁」在项目副本上算（`src/mcp/common.ts` 的 `measureAudioRequest`，与桌面版同一份；只认本项目素材表里的素材 id）。
- 素材凭成员本人的**只读**素材票据按内容哈希取到这个对话的工作目录（`measure/` 下），取完核对哈希；一次测量取来的素材合计不超过 1 GiB；量完删掉。只读成员也能量。
- ffprobe / ffmpeg 只经工作区的受限子进程起（9.5）；参数与解析是桌面版那一份（`server/audio-loudness.mjs`），另在每个输入前加 `-protocol_whitelist file`：素材是成员传的，伪装成媒体的播放列表不能让 ffmpeg 去连网络地址。整个进程里同时只跑一个测量；ffmpeg 的时限 50 秒。
- 不是按内容哈希登记的素材（迁移期按文件名的）云端读不到，回「素材文件不存在」。节点上没有 ffmpeg 时回 `{ ok: false, error: '这台云节点没有装 ffmpeg / ffprobe…' }`。
- 残余面：播放列表里写本机文件路径时，ffmpeg 会去读那个文件（读得到的只是「是不是一段能解码的声音」与它的响度数字）；靠 9.5 的「子进程用独立的非特权用户跑」兜底。

### 9.4c 卡片声音（`render_card_audio`、`cancel_card_audio`）

〔2026-10-07 做成〕`server/agent/service/hosted-card-audio.mjs`；渲染服务一侧是 `POST /look` 多出的一条 `/api/cards/audio`（`server/hosted-render/look.mjs`、`server/vite-plugin-cards.ts`、`src/audio/cardAudioHost.ts`）。

- **Agent 服务进程不执行卡片代码**（9.3、25.1 的裁定不变）。卡片的 `audio()`（含用户卡）交给同机的渲染服务，走看画面的同一条路：服务私钥签名、项目由宿主绑死、带卡片源码的项目只由按项目隔离的工作进程碰并等它把卡装到这一版（9.8）。页面请求闸与出口限制没有为此放宽：新接口是工作进程里 Node 一侧的，与看画面那一批一样只认管理进程转来的口令；声音在渲染页里求值，那一页照旧受闸与出口限制管。
- **求值与记录是桌面版那一份**：渲染页动态载入 `src/audio/cardAudioHost.ts`，用 `renderEmbeddedCardWav`（48000 Hz、32 位浮点、最长 60 秒）与 `cardAudioIdentity` 生成 WAV 与身份记录；WAV 分块从页面取回，随回包交给 Agent 服务（上限 32 MiB）。
- **Agent 服务一侧只做**：确认成员写得进（只读成员在问渲染服务之前被拒）→ 交项目副本与片段 id → **逐项核对**回来的东西（渲染页跑过项目带来的代码，回来的只当数据：WAV 的格式、长度与记录对得上，记录是这张卡的、字段齐、身份不超过 96 KiB，多出来的字段不留）→ 凭成员本人的素材票据写进素材服务 → 进锁用 `commitCardAudio` 原子登记（比的是 Agent 服务自己取副本那一刻看到的片段，不用渲染页报的）。
- **复用**：没传 `force` 且渲染页判定已有的记录还对得上时不重算；Agent 服务另核对项目素材表里那一条的字节在素材服务里真有，没有就强制重算。
- **取消**：掐掉在途的请求；已经回来的不上传、不提交。一位成员在一个项目里最多同时 4 个。单次时限按看画面的那一档（180 秒）。
- **结果的形状**与桌面版相同：`{ ok: true, clipId, mediaId, reused }` 或 `{ ok: false, code: 'CARD_AUDIO_FAILED' | 'CARD_AUDIO_CANCELLED', error }`；渲染服务回「这次没看成：…」时原因带回、开头换成「卡片声音这次没有生成:」。节点没配看画面的口子时这两个工具不交给模型。
- **用量**：每次生成记一行 `service: 'card-audio'`、`vendor: 'render'`、`units: <WAV 字节数>`。
- 入库的 WAV 是以**成员本人**的权限写的（不占托管方渲染服务的产物容量）。

### 9.4d 网页采集（`collect_status`、`collect_install`、`collect_search`、`collect_probe`、`collect_download`、`collect_job`、`collect_logout`）

〔2026-10-07 做成，实现记录在第 27 节〕`server/agent/service/hosted-collect.mjs`。

- **外部程序与桌面版是同一个**：`python -m promptcut_collect <子命令>`（检出里的 `python/promptcut_collect`，里面是 yt-dlp 与 ffmpeg），同一份命令行与 JSONL 约定。
- **只经工作区的受限子进程起**（9.5）：工作目录是这个对话的工作目录，环境变量按白名单重建，不带任何 `PROMPTCUT_*`。
- **只经出网闸的代理出网**（9.6）：每次调用起一个只绑回环的代理、用完关掉；子进程的环境里只有指向它的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（大小写两套），`NO_PROXY` 是空的。代理对每个目标做与出网闸相同的检查：回环、内网、云厂商元数据地址、同机各服务一律到不了。
- **模型给的链接**只收 `http(s)://` 开头的地址，或 B 站的 BV 号 / av 号；别的（`file:`、`ftp:`、以 `-` 开头的）在起子进程之前就被拒。
- **下载物只落在对话的工作目录**（`collect/<作业号>/`）。入库走 `import_media` 的那条路（成员本人的素材票据、在项目副本上登记，视频照桌面版放上时间轴）；只读成员在下载之前就被拒。只认作业目录里这一层的文件（下载器报的别处的路径不认），入库后整个作业目录删掉。
- **作业表在服务端**，按实例（项目 × 成员）分，作业号带随机数（`collect-<12 位十六进制>`）；同一位成员在同一个项目里的几个对话互相查得到，别的项目、别的成员查不到。作业表随对话落盘（工作目录的 `collect/jobs.json`）：服务重启后在原来的对话里查，得到的是「云端 Agent 服务重启过，这次下载中断了」，不是「找不到」。
- **上限**：一个作业的下载物合计 512 MiB（边下边量，超了就停）、片子时长 2 小时、墙钟 15 分钟、最多入库 20 个文件；一位成员在一个项目里同时只跑 1 个下载，整个进程同时 2 个。超限的不入库、不留文件，作业记 `error` 与原因。
- **`collect_install` 在云端不装东西**：节点上有没有采集工具由部署决定（`PROMPTCUT_AGENT_COLLECT_PYTHON`，9.9）。没装时 `collect_status` 回 `{ ok: true, ready: false, ytdlp: { installed: false }, hint: '这台云节点没有装采集工具…' }`，`collect_install` 与 `collect_download` 回 `{ ok: false, cloudUnavailable: true, error }`，`collect_probe`、`collect_search` 报同一句原因；一个子进程也不起。装了时 `collect_install` 回 `{ ok: true, alreadyInstalled: true }`，同样不起安装的子进程。
- **登录态**：`collect_login`、`collect_login_check` 要用户自己扫码，是「要操作发起人界面」的工具（9.2）。云端不存任何站点的 cookies：下载按未登录的画质，`collect_download` 的 `cookies` 参数不用（结果的 `notes` 里注明），`collect_logout` 回 `{ ok: true, loggedOut: false, note }`。
- **用量**：每次调用记一行 `service: 'collect'`、`vendor: 'yt-dlp'`、`model: <子命令>`、`units: <下载的字节数，查状态 / 探测 / 搜索是 0>`、`unit: 'bytes'`；汇总里的 `calls` 就是次数。
- **残余面**（照实写）：代理只管「经它出去的」；下载器若不认环境里的代理、自己去连，或往工作目录以外写文件，代码这一层拦不住——靠节点上用独立的非特权用户跑子进程与系统级的出站限制兜底（9.5、9.6 的同一条）。yt-dlp 与它调用的 ffmpeg 都认环境里的代理。
- 对话被删时还在跑的下载不会被主动停掉（它的作业目录随对话的工作目录删掉，之后入库会失败并记 `error`）。

### 9.5 工作区：按「项目 × 对话」隔离

`server/agent/service/workspace.mjs`。凡是读写本地文件的工具只经它：

- 目录是 `<数据目录>/work/<项目 id>/<主人键>/<对话 id>/`，三段都来自鉴权与服务端，不来自工具参数；
- 工具给的相对路径先在字面上拒掉绝对路径、盘符、UNC 与设备路径、`..`、NUL、Windows 保留设备名、备用数据流、结尾的点与空格；再解析并核对在对话目录之内；再对已存在的最深一层取真实路径（跟符号链接、junction），核对仍在对话目录的真实路径之内；
- 上限：单个文件 1 GiB、一个对话 2 GiB、一个项目 8 GiB、一个对话 2000 个文件，超了拒写；
- 对话删除、项目删除时整棵删掉；
- 子进程只经 `spawn()` 起：工作目录是对话目录，环境变量按白名单重建（不带任何 `PROMPTCUT_*`、代理、别的凭证变量），临时目录在对话目录里，不弹窗口。节点上应当再用独立的非特权用户跑这些子进程（部署说明里写），代码不假设它存在。

### 9.6 出网闸

`server/agent/service/egress.mjs`。凡是按模型给的地址发请求的工具只经它（`import_media` 的按地址导入在进程内经它；网页采集的子进程经它的代理，9.4d；网页接管接上时同样经代理）：

- 只许 http / https；地址里不许带用户名口令；端口只许 80、443、8080、8443；
- 主机名先解析，解析出的**每一个**地址都要过黑名单：回环、链路本地（含 `169.254.169.254`）、私有网段、运营商级 NAT、保留与组播段、本机各网卡的地址，以及 IPv6 的对应范围与把 IPv4 包进去的前缀（IPv4 映射、NAT64、6to4、Teredo）；有一个不过就整个拒；
- 按解析结果连接、不二次解析（连接的 `lookup` 钉死在核过的地址上）；
- 重定向每一跳重查，最多 5 跳，跨源的跳不带鉴权头；响应体上限 512 MiB（各工具可以更小）、整体有时限；
- 给子进程用的正向代理（只绑回环、随机端口）过同一道闸；
- **测试例外**：环境变量 `PROMPTCUT_AGENT_EGRESS_TEST_ALLOW`（逗号分隔的「IP:端口」）只给探针与演练，生产不设；设了日志里有 `agent.egress.test-allow`，`/healthz` 的 `egressTestAllow` 为 `true`（部署后的核对看它）。
- 托管方自己配置的地址（模型接口、配音服务、同机的文档服务与素材服务）不经出网闸：它们不是模型给的。

### 9.7 系统提示词

`cloudSystemNote({ look })` 只写与本机真实的差别：用户可能已经离开（「发起方不在线」时不要等）；网页采集经托管方的出口出网、不带登录态、节点没装时不能由模型来装；声音（音效与测响度照常用，卡片声音由渲染服务生成）；看画面（节点配了口子：照常用但比本机慢，带自定义卡片的项目第一次要等十来秒、别的项目在渲时要排队，工具回「这次没看成」时不要反复重试、按规定框继续并在汇报里说明；没配：看不了画面，要求看画面的步骤一律跳过、汇报里说明）；这一版还没有的工具；附件与素材的地址写法；建卡要写成字面量、不能引用外链；配音会产生费用。不再有「只能用内置卡」「云端暂不支持」这类话。第 22.3 节列的五个缺口：1、2、4 已写进提示词；3 不再成立（可以建卡）；5（摘要里没标哪些内置卡需要素材）没有做。

### 9.8 看画面（即时渲染）

〔2026-10-07 做成，实现记录在第 25 节；渲染服务一侧的口子在 `hosted-render-contract.md` 第 8a 节〕

- **怎么要**：Agent 服务（`server/agent-service/look-client.mjs`）向同机渲染服务管理进程的 `POST /look`（只绑回环）发 `{ projectId, path, body, cards, timeoutMs }`。`path` 是本机 Agent 看画面用的同一批接口（`/api/vision/snapshot`、`/api/cards/layout`、`/api/cards/dom`、`/api/vision/bake`、`/api/ai/visual` 与 `/api/ai/visual/render`），`body` 里带着**这一版项目副本**与时刻；所以 `server/agent/agent-exec.mjs` 里看画面的那几个读工具与桌面版是同一份实现，只是「问谁」不同。
- **认身份**：每个请求用 Agent 服务的**服务私钥**签名（时刻、一次性随机数、请求体摘要）；渲染服务按服务登记表核对，只认服务 `agent`。
- **一个对话要不到别的项目的画面**：`projectId` 由宿主在建实例时绑死（来自鉴权——委托里的项目），工具参数改不了；请求体里的项目内容是这个实例的副本。只读成员照常能看（看不改项目）。
- **带用户卡的项目**：随请求报这个项目内容库里卡片源码的「键 → 版本」；渲染服务据此只让隔离工作进程出图，并等它把这几份卡装到至少这个版本——所以 `create_card` / `edit_card` 之后紧接着 `see_frames`，看到的就是刚写的那一版。
- **图片怎么进模型**：与本机相同（`server/harness/agent.mjs`）：工具结果里的 `__image` / `__images` 摘出来，作为图片块跟在同一条 user 消息的工具结果之后；历史里只留最近 10 张；历史文件超过 `maxHistoryBytes`（8 MiB）按现有办法从最早的整对消息截。事件记录与发给页面的工具结果里不带图片。
- **云端的结果不带页面取不到的东西**：聊天栏的可视化记录与动图存在渲染服务的工作进程里，在线页面取不到，所以结果里没有 `visualId` 与动图地址，`get_gif` 只把 4×2 的拼图交给模型（说明里照实写）；改片段时的前后对比记录云端不存。
- **时限与没看成**：看画面的工具单次最多等 180 秒（别的工具 60 秒）。渲染服务回 `{ ok: false, look: <原因码>, error: '这次没看成：…' }` 时原话交给模型，这一轮照常继续；原因码与原话见 `hosted-render-contract.md` 第 8a 节。
- **开关**：项目的「渲染节点」关着、项目的「云端 Agent」关着、托管方关掉渲染服务的看画面（`PROMPTCUT_RENDER_LOOK=off`）、Agent 服务没配 `PROMPTCUT_AGENT_LOOK_URL`，任一成立都要不到画面。

### 9.9 节点上要装什么（给部署说明）

| 用途 | 要装的 | 现在 |
|---|---|---|
| 导入素材读音视频的时长与宽高 | ffprobe（随 ffmpeg；`PROMPTCUT_FFPROBE` 或 `PROMPTCUT_FFMPEG` 指路径） | 可选：没有时图片与 WAV 照常，其余不带时长 |
| `measure_audio` | ffmpeg 与 ffprobe（`PROMPTCUT_FFMPEG`、`PROMPTCUT_FFPROBE` 指路径，或在 PATH 上；Agent 服务的运行用户要能执行） | 已接上；没装时工具回明确的原因 |
| 素材小尺寸一档 | ffmpeg | 没接上 |
| 语音识别、镜头、追踪、主体 | Python 3 与各扩展包、模型权重（`python/` 下各包的 `requirements-*.txt`），`PROMPTCUT_PYTHON` | 没接上 |
| 网页采集 | Python 3 与 yt-dlp（`PROMPTCUT_AGENT_COLLECT_PYTHON` 指解释器的绝对路径）、ffmpeg（`PROMPTCUT_FFMPEG`）；步骤见 27.4 | 已接上；没配时工具回「这台云节点没有装采集工具」 |
| 网页接管、`measure_audio_js` | 无头浏览器 | 没接上 |
| 音效合成 | 不用装东西（纯计算） | 已接上 |
| 卡片声音 | 同「看画面」：同机的渲染服务与 `PROMPTCUT_AGENT_LOOK_URL` | 已接上 |
| 看画面 | 同机的渲染服务（它的无头浏览器与预渲染管线）；环境变量 `PROMPTCUT_AGENT_LOOK_URL`（渲染服务管理进程的回环口子；PM2 模板已带）。`get_gif` 另要渲染服务的工作进程里有 ffmpeg（渲染节点本来就装） | 已接上 |
| 配音 | 托管方的配音服务地址与令牌（导入办法同模型 Key） | 已接上 |
| 素材写入 | 环境变量 `PROMPTCUT_AGENT_ASSET_URL`（同机素材服务的回环地址；PM2 模板已带） | 已接上 |

### 9.10 第一版不提供的对话选项

「深度自主」与「审查环路」在云端仍不提供〔用户 2026-10-07 确认「深度自主」保持置灰〕：用的是托管方的 Key、现在没有上限，而云端的一轮在用户离开后没人看着。

### 9.11 界面（I）

与原 9.5 节相同的不再重复，改动的几处：

- 云端下**附件按钮可用**〔用户 2026-10-07 确认〕：传到 9.4 的接口，随下一条消息带上；第 19 节 U5「云端下不能附文件」作废。
- 「一键配特效」「✦」菜单里的项：只依赖工具的改回可用，仍做不了的写真实的原因（见第 24 节的实现记录）。
- 成员列表的「离线，Agent 在跑」与 Agent 数按「有一轮在跑」算（第 5 节与第 24 节）。

---

## 10. 页面到 Agent 服务的通道

### 10.1 选哪条

**经 nginx 的新路径 `/agent/`，HTTP 加 SSE，直达 Agent 服务进程。** 在线页面打同源的 `https://<主站>/agent/v1/…`；桌面版打同一个地址（跨源，10.4）。

nginx 主站 `server` 块加（模板进 `server/hosted/deploy/nginx-site-promptcut.conf`）：

```
location /agent/ { rewrite ^/agent/?(.*)$ /$1 break; proxy_pass http://127.0.0.1:8790;
                   proxy_http_version 1.1; proxy_set_header Connection "";
                   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                   proxy_buffering off; proxy_read_timeout 3600s; proxy_send_timeout 3600s;
                   client_max_body_size 5m; add_header Referrer-Policy "no-referrer" always; }
```

两个舞台源（`s1`、`s2`）的 `server` 块**不加**这一段：舞台里跑的是卡片代码，够不着 Agent 服务。

为什么不选别的：

| 方案 | 不选的理由 |
|---|---|
| 经文档服务中继 | 文档服务的语义是「只传小消息、不是计算服务」；模型的流式正文与长时间的请求压在它的会话上，Agent 服务出问题会连带它。也违背任务书「Agent 服务会拖垮同机的文档服务」这条核心红线的方向 |
| WebSocket | 桌面现成的是 `fetch` 加 SSE，事件格式与页面解析代码可以原样共用；上行只有「发消息、停止」两种离散请求，用不着双向长连接 |
| 页面直连 Agent 服务的端口 | 要多开一个公网端口、多一张证书、多一个跨源；经 nginx 同源最省 |

### 10.2 凭什么不违反「在线页面不请求 `/api/*`」

`c10a-contract.md` 第 2 节那一条的本意写在它自己的理由里：`/api/*` 是**编辑器进程**的同源接口，在线页面没有编辑器进程，这些请求发出去只会落空或打到不该打的地方；所以在线页面里凡是做不了的入口置灰，能做的改走**托管端的服务**（文档服务 `/hosted/`、素材服务 `/media/`）。

`/agent/` 是这张表里新增的第三个托管端服务，不是把编辑器进程的接口搬到公网：

- 它是独立进程，只有第 2.3 节那几个接口，没有 `/api/ai/config`、`/api/mcp/call` 这类桌面接口；
- 每个请求都要文档服务签的委托票据，和素材服务凭票据放行是同一个模式；桌面的 `/api/*` 靠的是「同源即本机」；
- 路径不以 `/api/` 开头，`src/online/apiGuard.ts` 不用改、照常装着，任何漏网的 `/api/*` 仍被就地拦下。

### 10.3 守卫与棘轮清单怎么改

- `src/online/apiGuard.ts`：不改。
- 棘轮清单 `server/test/c10a-online-api-paths.json`（现 19 条）与基线 `c10-api-ratchet-baseline.json`：**一条都不加**。AiPanel 进了在线构建之后，它背后的桌面调用必须全被摇掉；摇不干净，C10A-API-03 当场判红。
- 新增守门（`server/test/c10a-online-build.test.mjs`）：
  - C10A-API-05：在线产物里以 `/agent/` 开头的地址字面量只有 `/agent/v1/` 一种前缀；
  - C10A-API-06：（作废。第一稿是「桌面产物里没有 `/agent/v1/`」；I 改了之后桌面版也带云端后端，换成 13.1 的 CA-DESK-02～04）
  - C10A-API-07：在线产物里没有这些桌面专用的标识：`/api/mcp/events`、`/api/ai/setup`、`/api/chats/`、`PROMPTCUT_AGENT`（由 03 已经覆盖路径类的，这一条补非路径的）。
- 运行期探针 CAP-UI-02：在线页面完整走一遍对话，`window.__pcApiBlocked` 为空，网络记录里没有 `/api/`。
- `c10a-contract.md` 第 2 节「在线模式的替代」那张小表加一行「Agent 服务 = 同源的 `/agent/v1/`，凭委托票据」；`c10-contract.md` 第 10 节置灰清单里的「AI 栏（C10a 已置灰）」改成「AI 栏：普通档可用（云端 Agent），低内存档仍置灰」，并把云端下仍置灰的子入口列进去。

### 10.4 桌面版到云节点

桌面版选「云端」时，**页面直接打云节点的 Agent 服务**，与在线页面是同一条通道、同一套接口、同一种凭证，不经本机的编辑器进程转发：

- 地址从哪来：文档服务下发。`shared.members.list` 顶层的 `hosted.agent: { available, enabled, url }`，`url` 是托管组合启动时配的公网地址（环境变量 `PROMPTCUT_AGENT_PUBLIC_URL`，如 `https://149-88-94-84.sslip.io/agent/v1`）。页面不自己拼，放本机的项目没有这个字段，所以「云端」一项出不来。
- 凭证：桌面页面在自己到云端文档服务的连接上要委托票据与对话委托（4.2），与在线页面相同。本机的 Agent 服务、`K`、项目口令都不参与。
- 跨源：桌面页面的源是本机地址，Agent 服务按 2.3 放开跨源、只认票据。请求只从页面发出，不经 `/api/*`，所以本机编辑器进程的同源卡口（`vite-plugin-api-guard`）与它无关。
- 为什么不让本机 Agent 进程转发：转发的话桌面版一退出转发就断，云端的一轮虽然还在跑，但「同一条通道」不成立、还要在本机多维护一套代理与凭证；而用户体验验收的核心正是「退出后与本机无关」。
- 桌面版退出后：页面没了，云端的一轮照跑（7.3）。重新打开见 7.4。
- 对桌面现有行为的影响：只多一个接入方式选项与历史列表里的一组；不选它，所有请求与今天逐条相同。CA-DESK-02 守这一条。

---

## 11. 节点资源上限

节点 8 核、16 GB、无 swap；同机有托管组合（文档与素材，一个 Node 进程）、nginx、渲染服务（带 Chrome，是内存大户，上限由第三段定）。Agent 服务第一版没有 Chrome，是一个单线程的 Node 进程。

| 项 | 数字〔裁：主会话 2026-10-06〕 | 手段 |
|---|---|---|
| V8 老生代 | 1536 MiB | `node --max-old-space-size=1536` |
| 进程常驻内存 | 超过 2 GB 重启 | PM2 `max_memory_restart: '2G'`。重启前先走 3.4 的收尾（`kill_timeout: 8000`） |
| CPU | 至多占满 1 核，优先级低于文档与素材服务 | 单线程；启动脚本 `nice -n 10` |
| 同时进行的一轮 | 全节点 6，每项目 3，每成员 2 | 闸（6.2）；满了回 `busy`，不排队 |
| 存活实例 | 24 个，超了先回收闲置最久的，回收不动就回 `busy` | 实例登记表 |
| 单个项目副本 | JSON 超过 16 MiB 的项目不服务，回「项目太大」 | 建实例时判 |
| 一轮 | 24 次模型往返、30 分钟、单次工具 60 秒 | 驱动与执行器 |
| 补渲 | 只发受影响的片段，每个计划最多 200 个；连续 10 分钟没有进度放弃，绝对上限 12 小时；每个项目一条发布连接 | 第 16 节 |
| 事件记录 | 每个对话 8 MiB 起降级、12 MiB 封顶 | 7.2 |
| 请求体 | 256 KiB | HTTP 层 |
| 事件流 | 每个主人同时 8 条、全节点 200 条，超了回 `busy` | HTTP 层 |
| 磁盘 | 对话见 7.2；用量流水每月一个文件，不清 | — |

依据的估算（实现时用探针 CAP-RES-01 实测并把数字写进报告，估算不准就调上表）：vite 载入 `src/` 的模块图约 300～500 MB；每个实例一份副本，按 5 MB 的项目、解析后约 3 倍，24 个实例约 360 MB；模型历史在一轮期间驻留内存，每轮上限 8 MiB。合计在 1.5 GB 的堆内有余量。

满载对同机的影响（完成条件第 9 条）由主会话在新节点上测；本机用隔离的托管组合先测一遍方法：6 轮并发的模拟对话（每轮 20 次写工具）跑着时，量文档服务 `project.op` 的往返时间（中位数与 P95）与素材服务下载一个 100 MB 文件的速度，各与空载比。本机的数字只说明方法可行，不当作节点的结论。

---

## 12. 语义改写的逐字稿

〔2026-10-07 已落稿：逐字稿落进了 `docs/semantics/` 的各册，落稿时加了用户 2026-10-07 的决定（第 22 节）并按实现改了几处；与本节不同时以语义文档为准。〕下面是当时的逐字稿，保留作对照。

这一轮不落盘，实现阶段照此改。E～J 是用户定的；数字与办法进 `mechanism/`，标〔裁〕。

### 12.1 `product/agent.md`

**「接入」第一条**

- 修改前：所有 Agent 通过同一套工具接口操作项目，不论它是 AI 栏里经命令行或 API 接入的，还是桌面 APP 经 MCP 接入的。
- 修改后：所有 Agent 通过同一套工具接口操作项目，不论它是 AI 栏里经命令行或 API 接入的、桌面 APP 经 MCP 接入的，还是托管方的云端 Agent。

**「运行位置」整节**

- 修改前：
  - Agent 默认在用户本机运行。
  - 项目方提供的云端 Agent 是愿景：它在云端有自己的运行环境、本地内容库和只做即时渲染的渲染进程，从文档服务拉项目，从素材服务拉素材和预渲染的产物。
- 修改后：
  - Agent 默认在用户本机运行。桌面版的 AI 栏缺省用本机 Agent。
  - **云端 Agent**：托管方提供的 Agent 服务，跑在云节点上，只为放在这台节点上的项目服务。在线浏览器模式的用户在 AI 栏里用它；项目放云端时桌面版的 AI 栏也可以选它。对话与工具调用由它执行，改动经文档服务落地，和本机 Agent 的改动一样排序、记版本、通知、可撤销。
  - **发出任务后可以离开**：云端的对话在云节点上运行，不依赖发起它的设备。发起的成员关掉页面或退出软件后，对话继续跑到结束，改动照常落地；被改动的重卡由云节点上托管方的渲染节点渲出来并入库，全程不需要任何成员的设备在线。成员重新打开项目，或在另一台设备上以同一个用户名进入，能看到对话的完整过程、停掉还在跑的对话、接着说。
  - **出错留痕**：模型调用失败、额度用尽、渲染失败、对话被停掉或失效时，对话记录里留下明确的原因，项目停在最后一次成功的改动之后。
  - **模型**：云端 Agent 用托管方的模型凭证，服务端直连模型接口。凭证只在云节点上。
  - **身份**：云端 Agent 服务用托管方的服务身份接入文档服务；每个对话另须出示发起成员的身份证明，由文档服务核验。这份证明在成员发消息时签发，成员离线后在这一轮之内仍然有效。它在这个对话里能做的不超过该成员本人的权限，改动署名为「〈成员名〉的云端 Agent」，成员列表里看得到。它不使用任何成员的项目凭证。
  - **开关与失效**：每个项目有「云端 Agent」开关，缺省开，创建者可以关。创建者关掉开关、成员被移出、项目删除后，对应的对话立刻失效，进行中的对话被停掉。
  - **上限**：所有对话与模型调用都经过同一处额度与并发检查；每个项目有一个额度，缺省不限，由托管方按项目发放。用量按项目、按成员记录，可查。
  - **第一版的范围**：云端 Agent 能读项目、改项目（时间轴、片段、卡片参数、效果、素材引用）。暂不支持、会明确回「云端暂不支持」的：读写节点本地文件、网页采集与网页接管、语音识别与配音、新建或修改卡片代码、SKILL 相关。看画面不在第一版的承诺里。读页面状态的工具用发消息时的选区与播放头；发起方不在线时回明确的「发起方不在线」，Agent 据此继续。〔用户 2026-10-07 推翻:这一条整段作废：云端 Agent 的工具与本机一致，只有要操作发起人自己界面的工具可缺省；语义文档已按第 23.1 节改〕
  - **对话记录**存在云节点上，归项目里发起它的那个用户名，只有他能读。

**「工具」的「看」一条末尾加一句**：云端 Agent 第一版没有渲染能力，也不经素材服务拉取产物来看。

### 12.2 `mechanism/agent.md`（新增一节「云端 Agent」，全部〔裁〕，出处写本文节号）

- 一份服务实现两种挂法；托管档按「项目 × 成员」分实例；闲置 10 分钟回收。（第 2、3 节）
- 委托票据：`k: 'dlg'`、`aud: 'agent'`、有效期 2 分钟、由项目的文档服务签；凭它经控制连接换带 `sv: 'agent'` 的连接票据；核验缓存 15 秒；撤销在 2 秒内停掉对话。（第 4 节）
- 写入身份带 `service: 'agent'`。（第 5 节）
- 闸的两个入口、判定顺序、`limits.json` 的字段、用量流水的字段。（第 6 节）
- 对话委托：绑成员 × 项目 × 对话、60 分钟、一轮一张、只放内存。（4.2）
- 一轮与连接脱钩；事件先存后发、按 `seq` 补发；事件记录与模型历史的目录、上限；收尾的五种状态；每次工具往返落盘；重启后不自动续跑。（第 2.4、7 节）
- 对话归属的主人键。（7.2）
- 页面状态用发消息时的快照；「发起方在线」的判定。（9.4）
- 改动落地后攒 3 秒发布补渲计划、只发受影响的片段、每个计划最多 200 个、连续 10 分钟没有进度放弃、绝对上限 12 小时、重启后重发。（第 16 节）
- Key 的封装与录入脚本、模拟提供方的脚本格式。（第 8 节）
- 开放清单的判定规则与数目。（第 9 节）
- 资源上限的数字。（第 11 节）

### 12.3 `architecture.md`

**角色表「Agent」一行**

- 修改前：读项目、发出修改、请求即时渲染。可替换：本地模型、用户自己的服务、项目方的服务，对其它角色是同一种角色；由谁提供决定是否由项目方计费
- 修改后：读项目、发出修改、请求即时渲染。可替换：本地模型、用户自己的服务、托管方的云端 Agent 服务，对其它角色是同一种角色；由谁提供决定用量记在谁名下

**扩展点表第一行**

- 修改前：| Agent | 项目方服务器 | 愿景 |
- 修改后：| Agent | 托管方的云节点（云端 Agent 服务） | 已做：在线浏览器模式的 AI 栏使用；项目放云端时桌面版可选，缺省仍是本机 Agent |

**「数据流」的「Agent 看画面」之后加一条**：云端 Agent 服务与文档服务之间只走文档服务的会话；页面（在线页面，或选了「云端」的桌面版）与云端 Agent 服务之间只传对话（消息、过程的事件流、停止），不传项目内容与素材字节。云端 Agent 的改动引出的预渲染任务由 Agent 服务经文档服务的任务队列发布，由云节点的渲染节点认领。

### 12.4 `product/platforms.md`

**「面向的平台」表后的最后一条**

- 修改前：Agent 端（Agent 服务与预渲染进程的 Agent 模式、Full 模式）面向 Windows、Linux、Ubuntu。
- 修改后：Agent 端（Agent 服务与预渲染进程的 Agent 模式、Full 模式）面向 Windows、Linux、Ubuntu。云端 Agent 服务跑在 Linux 云节点上，不带编辑界面。

**「在线浏览器模式」加一条**（放在「请求不到预渲染进程」一条之前）

- 新增：**AI 栏**：普通档的右侧 AI 栏可用，接入方式是「云端」，由托管方的云端 Agent 服务执行（见 `agent.md` 的「运行位置」）。本机没有进程，所以没有命令行与桌面 APP 这两种接入。低内存档的 AI 栏暂不可用。

**「桌面应用」加一条**

- 新增：项目放云端时，桌面应用的 AI 栏可以选「云端」，由托管方的云端 Agent 服务执行；缺省仍是本机 Agent。选「云端」的对话在云节点上运行，桌面应用退出（含后台运行一并退出）后继续，重新打开项目能找回。

**「低内存档」列表加一条**

- 新增：**AI 栏**：暂不可用，显示说明（竖屏界面另有计划）。

### 12.5 `product/hosting.md`

「不是什么」一节现在写的是云端托管服务（牵线与中继）「不是计算服务」，这句不动。第三段会在本册加「托管方自带的渲染节点」；Agent 这边在其后加一节（与第三段合并时主会话统一小节标题）：

- 新增小节 **托管方的 Agent 服务**：云节点上另有托管方的云端 Agent 服务。它是独立部署的服务，不属于云端托管服务（牵线与中继）、文档服务、素材服务中的任何一个；它用托管方的服务身份加发起成员的身份证明接入文档服务，不持有集群令牌，不持有任何成员的项目凭证。只为放在这台节点上的项目服务，放本机的项目不受它影响。产品承诺见 `agent.md` 的「运行位置」。

### 12.6 `product/document-service.md`

**「版本与身份」第二条**

- 修改前：身份来自凭证，不由消息自报。共享项目里，用户由进入时的凭证确定；Agent 沿用它所属用户的凭证，另记它是第几个对话。
- 修改后：身份来自凭证，不由消息自报。共享项目里，用户由进入时的凭证确定；本机 Agent 沿用它所属用户的凭证，另记它是第几个对话。托管方的云端 Agent 不沿用成员的凭证：它出示托管方的服务身份与发起成员的身份证明，文档服务核验后按该成员的权限放行，写入记为这位成员的云端 Agent。

**「共享项目与权限」加一条**

- 新增：项目对托管方的每种服务各有一个开关（渲染节点、云端 Agent），缺省开，只有创建者能改。关掉后文档服务立刻断开该服务在这个项目里的连接，并拒绝它再进入。

### 12.7 一级文档（请主会话确认授权范围后由主会话落，见第 15 节）

`user-workflow.md`「Agent 接入方式」表加一行：

- 新增：| **云端** | 托管方的云端 Agent | AI 栏 | 传统式 |

并在表后加三句：在线浏览器模式只有「云端」一种接入。桌面版在项目放云端时多出「云端」一项，缺省仍是本机的接入方式。云端的对话发出后可以关掉软件，它在云端继续；重新打开项目能接着看、停掉或接着说。

`workflow/project.md`「多用户协作」：

- 修改前：创建者特权只有三项：改项目密码、名单或邀请码，删项目，踢人；其余操作所有成员一样。
- 修改后（〔裁：主会话 2026-10-06〕，待用户审；`product/document-service.md`「共享项目与权限」里同一句照此改，两处一致）：创建者特权只有四项：改项目密码、名单或邀请码，删项目，踢人，开关托管方在这个项目里的服务（渲染节点、云端 Agent）；其余操作所有成员一样。
- 修改前：Agent 用所属用户的身份，显示为「用户名 · Agent · 第几个对话」，界面用标签区分真人和 Agent。
- 修改后：Agent 用所属用户的身份，显示为「用户名 · Agent · 第几个对话」，界面用标签区分真人和 Agent。云端 Agent 显示为「〈用户名〉的云端 Agent」。

`workflow/project.md`「多用户协作」在第三段加的「托管方的渲染节点」那一条后面加一条：

- 新增：项目放云端时，项目设置里另有一个勾选「云端 Agent」，缺省勾上：在线浏览器模式的成员可以在 AI 栏里用托管方的云端 Agent。项目创建者可以取消，取消后进行中的云端对话立刻停掉；其他成员看得到这一项，不能改。放本机的项目没有这一项。

`workflow/project.md`「项目设置」：

- 修改前：名称、画幅比例与方向、帧率、分辨率、主题、创造力等级；多用户协作的开关、放在本机或云端、进入方式与创建者信息。
- 修改后：名称、画幅比例与方向、帧率、分辨率、主题、创造力等级；多用户协作的开关、放在本机或云端、进入方式与创建者信息；放云端的项目另有托管方服务的开关（渲染节点、云端 Agent）。

`workflow/production.md`「用户发送指令」加一句：接入方式选「云端」时不能附文件；云端暂不支持的操作 Agent 会直接说明；发出后可以离开。〔用户 2026-10-07 推翻:云端下附件可用、工具与本机一致，语义文档已改，见第 23.1 节〕

`glossary.md`「接入方式」一条改成：Agent 的四种接入：CLI、API（在 AI 栏里对话）、桌面 APP（经 SKILL）、云端（AI 栏里，对话在云节点上运行；在线浏览器模式只有这一种）。

「创建者特权」那一句与第三段的 D 是同一处，两段只能改一次，由主会话统一。

### 12.8 受影响的契约

| 契约 | 改哪里 |
|---|---|
| `auth-contract.md` | 第三段会加托管方服务身份的一整节（握手项、目录模块、`sv` 票据、白名单）；本段在它之上加：第 1 节名词「委托票据」；第 6 节 principal 的 `service: 'agent'`（`scope` 仍是 `member`）与 `access`，写入身份加 `service`；第 7 节 `auth.ticket` 加 `kind: 'delegate'`，创建者操作 `set-hosted-service`（与第三段共用），成员列表的连接项加 `service`、顶层 `hosted.agent`（另带 `url`，10.4）；第 8 节票据加 `k: 'dlg'` 与 `aud`、`acc`，连接票据加 `acc`；托管方服务一节里 `hosted.ticket` 的 `conversation`、`delegation` 两个字段、`hosted.delegate.verify`、`agent` 服务的白名单；第 12 节测试编号接着第三段的往后排。第 5 节「至多一项鉴权」不用改 |
| `c10a-contract.md` | 第 2 节「在线模式的替代」加 Agent 服务一行；第 2 节 nginx 清单加 `/agent/`；第 12 节守门加 C10A-API-05、07 |
| `c10-contract.md` | 第 10 节置灰清单按 10.3 改；第 17 节表 A 加云端下几条文案 |
| `c65-design.md` | 第 5 节「Agent 一侧」加一句托管档的凭证来源；第 13、14 节显示名的裁定处加云端的写法 |
| `shared-project-contract.md` | 第 10 节部署清单不变（Agent 服务不在托管组合的清单里），加一句指向本文 |
| `hosting-migration.md` | 加 Agent 服务的迁移：数据目录整个拷走；Key 密文换机后解不开，要重新录入 |

---

## 13. 测试与探针计划

### 13.1 单测（`server/test/cloud-agent-*.test.mjs`，全部不出网，模型用模拟提供方）

| 编号 | 断言 | 对应完成条件 |
|---|---|---|
| CA-SEAM-01 | `server/agent/service/`、`server/agent-service/` 里没有指向 `src/` 的 import | 2 |
| CA-ENTRY-01 | 托管档入口不带页面起得来：`/healthz` 200；没有任何 `/api/*` 路由（逐个打桌面的 30 来个路径，全 404） | 3 |
| CA-ENTRY-02 | 绑非回环地址拒绝启动；缺数据目录、缺服务身份各自的 `config.error` 与退出码 | 3 |
| CA-ENTRY-03 | 不带票据、票据格式不对、过期：401，响应体不说原因；带 `Origin` 不是公网源：403 | 3、4 |
| CA-ISO-01 | 两个项目两个执行器并发各 200 次写工具：每次提交只含自己项目的实体；store 出锁后项目为 `null` | 3、4 |
| CA-ISO-02 | 甲的票据拿乙的对话 id、`runId` 去读、停、删、续：全部当作不存在；乙的对话不受影响 | 4 |
| CA-ISO-03 | 同一项目两位成员各一个对话同时跑：各自的写入身份、对话号、最后读到的版本互不影响；两人用同一个对话 id 也不串 | 3、6 |
| CA-ISO-04 | 页面在请求体里带别人的 `projectId`、`userId`、`sessionId`：被忽略，仍按票据的身份办 | 4 |
| CA-AUTH-01 | 委托票据：只有 `page` 角色的成员连接要得到；`agent`、`render`、`local` 要不到；开关关着、登记表里没有 `agent` 服务回 `service-disabled` | 4 |
| CA-AUTH-02 | `hosted.ticket`：`agent` 服务带有效委托票据 → 连接票据的 `u`、`ug` 是成员的、带 `sv: 'agent'` 与 `acc`，凭它握手得到的 principal 带 `service: 'agent'`、`access`、成员的 `userId`；`agent` 服务不带委托票据 → `forbidden`；`render` 服务带委托票据 → `forbidden`；委托票据的 `p` 与 `projectId` 不符 → 拒；把委托票据直接当握手票据用 → 401 | 4 |
| CA-AUTH-03 | 伪造（改一个字节、换别的项目的 `ticketKey` 签）、过期（注入时钟）、代数变了、`aud` 不对：核验与握手都拒 | 4 |
| CA-AUTH-04 | `access: 'r'`：`project.op`、`project.upload`、内容库写入回 `forbidden`；读照常 | 4 |
| CA-AUTH-05 | 带 `service: 'agent'` 的连接：4.4 白名单之外的消息类型逐个发一遍，全部 `forbidden`（至少 `auth.ticket` 三种、`shared.admin`、`shared.members`、`node.hello`、`task.claim`、`content.put`、`service.announce`） | 4 |
| CA-AUTH-06 | 控制连接：`render` 服务发 `hosted.delegate.verify` → `forbidden`；`agent` 服务的 `hosted.watch` 看到的 `enabled` 是云端 Agent 的开关，不是渲染的；核验结果在踢人后 15 秒内失效 | 4 |
| CA-REVOKE-01 | 一轮进行中（模拟提供方 `sleepMs`）关开关：2 秒内流上收到 `error { code: 'revoked', reason: 'disabled' }`，之后没有新的模型请求、没有新的 `project.op` 落地；再发消息回 `disabled` | 4 |
| CA-REVOKE-02 | 同上，触发换成 `set-list` 移出、`kick`、`delete`；`delete` 后对话目录被删 | 4 |
| CA-REVOKE-03 | 关开关只停这个项目的；同一位成员在另一个项目的对话照常 | 4 |
| CA-GATE-01 | 每次模型请求前都调过 `admitModelCall`，每次请求后都有一行用量 | 7 |
| CA-GATE-02 | 额度设成很小的数：超出后下一次模型请求不发，流上 `quota-exceeded`，话里带已用与上限；设回 `null` 后恢复；不重启 | 7 |
| CA-GATE-03 | 用量流水与 `GET /v1/usage`、`admin.mjs usage` 查到这几次调用的项目、成员、模型、token 数，三处一致 | 7 |
| CA-GATE-04 | 并发：全节点、每项目、每成员三个上限各自生效，满了回 `busy`，结束后名额释放（含异常结束、被中止） | 9 |
| CA-GATE-05 | `limits.json` 写坏：保留上一份，不崩 | 7 |
| CA-CHAT-01 | 事件的顺序与形状（`user`、`run`、`session`、`tool_call`、`tool_result`、`text`、`done`、`end`），`seq` 跨轮递增；`tool_result` 不带完整输出 | 5 |
| CA-RUN-01 | 发消息回 202 后立刻断开请求、不开任何事件流：这一轮跑完，改动全部落地，事件记录完整 | 体验 |
| CA-RUN-02 | 事件流看到一半断开，再用 `after=<seq>` 连：补发的加实时的与一口气看完的逐事件相同，不丢不重；`after=0` 从头 | 体验 |
| CA-RUN-03 | 两条事件流同时看同一个对话（两个 `userId`、同一个主人）：内容相同；其中一条调 `abort`，一轮停下，两条都收到 `end` | 体验 |
| CA-RUN-04 | 主人键：同用户名不同设备读得到同一份对话列表；创建者身份与同名成员身份互相读不到；不同用户名读不到 | 4、体验 |
| CA-RUN-05 | 每种收尾（说完、停掉、模型报错、额度用尽、到上限、撤销四种、进程重启）各自的 `meta.json` 状态、原因与事件记录里的那句话 | 体验 |
| CA-GRANT-01 | 对话委托：带 `cid`、`run`，60 分钟；短的委托票据换不出连接票据；对话委托的 `cid` 与对话不符换不出；别的成员的换不出 | 4 |
| CA-GRANT-02 | 成员的所有连接都断开后，Agent 服务凭对话委托仍能换票据、重连、提交写入 | 体验 |
| CA-GRANT-03 | 成员离线时关开关、移出、踢人、删项目：2 秒内这一轮停下，之后凭同一张对话委托换不出票据 | 4、体验 |
| CA-GRANT-04 | 对话委托不落盘：跑完一轮后数据目录与日志全文里没有它 | 规矩 |
| CA-PAGE-01 | 发起方的事件流连着：`get_selection` 回发消息时的选区；断开后同一轮里再调：立刻回 `initiatorOffline`（100 毫秒内，不等待）；切剪辑的三个工具离线时照常执行并注明 | J |
| CA-RENDER-01 | 写入落地后 3 秒攒批发出一个清单计划，形状与在线页面的 `planPublisher` 逐字段相同；新计划发出后旧的被撤回；一轮结束时补发 | 体验 |
| CA-RENDER-02 | `task.done` → `render done` 事件、清单清空、发布连接关闭；`task.fail` → `render failed` 带片段与原因；渲染开关关着 → `render unavailable`、不发布 | 体验 |
| CA-RENDER-03 | 没渲完时杀 Agent 服务再起：按 `pending-render.json` 重新发布，不需要任何成员连接 | 体验 |
| CA-RENDER-04 | 发布连接的票据不带委托：能发布清单计划，发细任务、`node.hello`、`project.open`、`auth.ticket` 都 `forbidden` | 4 |
| CA-RR-01～07 | 项目一直往前走时补渲不以失败收场（间隔长的多次写入、旧计划被取代、发布方断线重连重发、渲染节点中途重启），逐条见第 16.4 节 | 体验 |
| CA-CHAT-02 | 停止：`abort` 后 1 秒内这一轮结束，模型请求被中止，名额释放；别的主人调这个对话的 `abort` 当作不存在 | 5 |
| CA-CHAT-03 | 对话的列、取、改标题、删；事件记录的 8 MiB 降级与 12 MiB 封顶；50 个对话的淘汰不动在跑的 | 5 |
| CA-CRASH-01 | 一轮进行中杀子进程再起：`meta.json` 变 `interrupted`、事件记录末尾有中断说明与 `end`；不自动续跑；接着发消息能续上，历史里没有悬空的工具调用 | 6 |
| CA-TOOL-01 | 开放清单 ⊆ 工具表；不在清单里的 62 个逐个调用都回 `cloudUnsupported`，且文档服务没有收到任何提交 | J |
| CA-TOOL-02 | 清单里走路由表的工具都是 `awaited: false` | 3 |
| CA-TOOL-03 | 清单里的工具逐个在托管档跑一遍（最小参数）：没有一次请求打到 `agent-service.invalid`，没有碰作业表 | J |
| CA-TOOL-04 | 交给模型的工具表只有清单里的加 `think` | J |
| CA-KEY-01 | `set-key.mjs`：命令行或环境变量里带 Key 拒绝；标准输入不是终端拒绝；写出的文件是密文、0600；输出里没有 Key | 8 |
| CA-KEY-02 | Key 出现在模型报错里时，流、对话记录、模型历史、日志四处都被替换掉 | 8 |
| CA-LOG-01 | 跑完一整轮，日志全文里没有提示词、回复正文、票据、Key | 规矩 |
| CA-MOCK-01 | 模拟提供方照脚本走；没有脚本块时与现在逐事件相同 | 8 |
| CA-DESK-01 | 桌面档：`/api/ai/*`、`/api/mcp/*`、`/api/agent/*` 的路径清单与抽服务之前逐条相同（对着起点提交生成的清单） | 3 |
| CA-DESK-02 | 桌面版不选「云端」时：打开项目、发消息、工具调用全程没有任何发往 `hosted.agent.url` 的请求（放云端的项目只多一次 `info` 与一次对话列表） | 3、I |
| CA-DESK-03 | 「云端」一项的出现条件：放本机的项目、未协作的项目、草稿里没有；放云端且 `available` 时有；开关关着时置灰；从不被自动选中，新页签的缺省仍是上次的本机接入方式 | I |
| CA-DESK-04 | 桌面版选「云端」发消息：本机的 `/api/ai/chat`、`/api/mcp/*`、`/api/agent/bind` 一次都没被调 | I |
| C10A-API-05、07 | 见 10.3 | 5 |
| AU16 起 | `auth-contract.md` 的新增条目各一条（委托票据的签发与核对、`set-hosted-service` 的 `agent` 一支、关开关时以 4003 `service-disabled` 关连接） | 4 |

### 13.2 探针（`scripts/probes/cloud-agent-probe.mjs`，文件头写验收标准）

本机搭法：一个临时数据目录；`server/hosted/main.mjs` 起在 8798（文档）与 8799（素材），`PROMPTCUT_TRUST_LOOPBACK=0`；Agent 服务起在 5741，`vendor: 'mock'`；在线构建由 `vite preview` 类的静态服务加一个把 `/hosted`、`/media`、`/agent` 转到上面三个端口的小反向代理提供，占 5740（应用层代理，不动宿主机网络）；桌面版一侧用 `dev-test` 那样的隔离实例，端口 5743～5745。全部静默运行，结束时只杀自己起的进程。

| 编号 | 做什么 | 对应 |
|---|---|---|
| CAP-ISO-01 | 两个项目、三位成员（甲在项目一，乙在项目二，丙两个都在）。甲的对话让模型读项目二的实体 id、往项目二写：读不到、写不进；丙在两个项目的对话记录互相列不出；甲拿乙的票据摘要、对话 id 试各接口 | 4 |
| CAP-ISO-02 | 伪造与过期的委托票据打每个接口：全 401 | 4 |
| CAP-ISO-03 | 只读成员（直接改项目记录造出来）发起对话让模型改文案：工具回 `forbidden`，项目版本号不变 | 4 |
| CAP-ISO-04 | 创建者关开关：进行中的对话 2 秒内停，页面显示「已关闭」 | 4 |
| CAP-UI-01 | 在线宽屏：AI 栏可用、接入方式有「云端」；发消息、流式回复、停止、工具调用过程、重开对话各截一张图 | 5 |
| CAP-UI-04 | 桌面隔离实例打开放云端的项目：接入方式里有「云端」、缺省仍是本机；选它发消息，改动落地；同一个 AI 栏里另一个页签用本机 Agent（模拟驱动）同时工作，互不影响。放本机的项目里没有「云端」。各截一张图 | I |
| CAP-UI-02 | 全程 `__pcApiBlocked` 为空，网络记录没有 `/api/` | 5 |
| CAP-UI-03 | Chrome 手机仿真（低内存档）：仍是占位，没有任何 `/agent/` 请求 | 5 |
| CAP-E2E-01 | 桌面隔离实例建协作项目放到本机的托管组合；在线成员让云端 Agent 改文案、挪片段、调卡片参数各一次；桌面与另一位在线成员都看到，署名「某某的云端 Agent」；成员列表里看得到 | 6 |
| CAP-E2E-02 | 「撤销这一步」与本机 Agent 同样生效；被别人改过的实体同样报冲突 | 6 |
| CAP-E2E-03 | 两位成员同时各开一个对话，各做 10 次写：互不串，版本连续 | 6 |
| CAP-E2E-04 | 杀 Agent 服务进程（探针自己起的那个）：自动拉起，页面报中断，重开后继续 | 6 |
| CAP-QUOTA-01 | 第 7 条的三步在页面上走一遍，截图 | 7 |
| CAP-TOOL-04 | 含用户卡片段的项目：挪、删可以，改参数回说明 | J |
| CAP-RES-01 | 6 轮并发时 Agent 服务的常驻内存、堆、CPU；文档服务往返时间与素材下载速度的前后对比（方法验证） | 9 |

**用户体验验收的端到端探针**（`scripts/probes/cloud-agent-leave-probe.mjs`，回归项；文件头逐条写任务书「用户体验验收」的六条与对应断言）。搭法在上面那一套之外再加第三段的渲染服务（本机用 `PROMPTCUT_TEST_ENV_FINGERPRINT` 报一个与桌面不同的指纹）。发起方是**探针自己起的真实进程**：桌面一侧是一个隔离的编辑器进程加它的无头页面，在线一侧是一个独立的 Chrome 进程；「离开」是把那个进程树真的结束掉（桌面实例整棵进程树、浏览器整个进程），不是断网、不是关流。测试项目里放至少两张重卡；模拟模型的脚本做 12 次写入（改文案、挪片段、调卡片参数，其中 4 次改到重卡），每步之间 `sleepMs: 3000`，全程约 40 秒。

| 编号 | 做什么与断言 | 验收条目 |
|---|---|---|
| CAP-UX-01 | 桌面实例发出任务，等到事件流里出现第 2 次 `tool_result`（已被云端接下）后结束它的整棵进程树；核对进程确实没了、文档服务的成员列表里这位成员的页面连接没了。之后：事件记录走到 `end`、状态 `idle`；12 次写入全部落地，版本号连续；每次写入的署名是「〈创建者〉的云端 Agent」 | 一、二 |
| CAP-UX-02 | 接上一条，全程没有任何成员连接的那段时间里：渲染服务认领了 Agent 服务发的计划，四张被改的重卡的产物进了素材服务、清单进了内容库；事件记录里有 `render done` | 二 |
| CAP-UX-03 | 任务跑到一半时另一位成员从在线浏览器进项目：改动一条条到达（收到的版本数随时间增加，不是一次到齐）；跑完后他的预览里那四张重卡是贴上的产物，不是占位（读层表与截图）；他没有发布过任何计划（网络与消息记录） | 三 |
| CAP-UX-04 | 重新起桌面实例、打开同一个项目：AI 栏自动出现那个云端对话，事件从头补齐，与服务端的事件记录逐条相同；项目是最新版本；四张重卡的预渲染结果已在（不触发重渲）；对最后一步点「撤销这一步」，那一步的改动撤掉、别的成员也看到 | 四 |
| CAP-UX-05 | 换一个更长的脚本：发出后结束发起进程，再起一个**不同设备 id、同一用户名**的在线页面：列表里看得到在跑的对话，接上流，调停止，2 秒内 `end`、项目停在最后一次成功写入的版本；接着在这台设备上说一句，新的一轮正常跑完 | 五 |
| CAP-UX-06 | 出错的五种各跑一遍，发起方都已离线：模拟模型在第 5 步 `fail`；额度设成只够 4 步；渲染服务对一个片段报失败（用它的测试钩子，待第三段给）；跑到一半创建者从另一台设备把发起成员移出；跑到一半关开关。每种断言：事件记录里有对应的那句原因、`meta.json` 的状态与原因正确、项目版本号等于最后一次成功写入、项目内容能被 `applyOps` 从头重放出来（完好）、之后没有新的写入 | 六 |
| CAP-UX-07 | 把 CAP-UX-01 的发起方换成在线浏览器（结束 Chrome 进程），其余同 01、02、04 | 一（在线再验一遍） |

### 13.3 只能在新节点上验的（留给主会话）

- 完成条件第 6 条用真实模型再跑一遍（用户录入 Key 之后）。
- 用户体验验收在新节点上的那一遍：发起方用真正安装的桌面版（连托盘退出）与真实浏览器，渲染服务是节点上常驻的那一个（真实的 Linux 指纹）。探针 `cloud-agent-leave-probe.mjs` 给一个 `--base <节点地址>` 的模式跑其中不需要结束本机桌面版的部分（在线发起、离线运行、另一成员看、换设备停、出错留痕），桌面版退出那一步由主会话按规矩手工做。
- 第 9 条的正式数字（节点上的渲染服务同时在跑）。
- nginx 的 `/agent/` 段、证书、SSE 经公网不被缓冲（看首个事件的到达时间）。
- PM2 的拉起与内存上限、节点重启后自启。
- `set-key.mjs` 在节点的终端里的实际表现（由用户执行）。
- `/etc/machine-id` 存在且稳定（云厂商重装镜像会变，变了要重新录 Key，写进 `hosting-migration.md`）。

### 13.4 桌面不退步要跑的现有项

`server/test/` 下：`agent-c65*.test.mjs`、`agent-lane`、`agent-summary-shape`、`agent-invalid-tool-name`、`c65b-agent`、`c65b-undo`、`multi-agent`、`skill-mcp`、`creativity-gate`、`deep-auto`、`cli-loop`、`api-*.test.mjs`、`harness-smoke`、`tool-protocol-smoke`、`codex-*`、`agy-*`、`config-*`、`mcp-routes`、`docservice-events`、`auth-*`。探针：`scripts/probes/` 下的 `c65-editor-probe`、`multi-agent-probe`、`skill-mcp-probe`、`claim-gate-probe`（主会话派活时点名，按 `verification.md` 不自行扩到全套）。外加全量 `npx tsc -b --force`、`npm test`、`npm run build`。

---

## 14. 文件清单与分工建议

### 14.1 会改或新增的文件

| 块 | 文件 |
|---|---|
| 甲 抽服务与多实例 | 新增 `server/agent/service/*.mjs`（服务工厂、实例登记表、页面通道、对话处理）；改 `server/vite-plugin-ai.ts`（变薄壳）、`server/agent/ssr-host.mjs`（进程级的锁与清场）、`server/agent/agent-exec.mjs`（锁改注入）、`server/agent/agent-side.mjs`（透传）、`server/runners/api.mjs`（`historyFile`、`checkpoint`、透传 `onModelCall`）、`server/harness/agent.mjs`（`onModelCall`）、`server/harness/tools/index.mjs`（`localTools`、工具过滤） |
| 乙 身份与隔离 | 改 `server/auth/tickets.mjs`、`protocol.mjs`、`handshake.mjs`、`store.mjs`；`server/docservice/modules/shared.mjs`、`modules/project.mjs`、`modules/content.mjs`、`modules/actor.mjs`；新增 `server/docservice/modules/hosted.mjs`（控制连接，与第三段合写）；改 `server/agent/doc-link.mjs`（连接被关时把关闭码与原因报给实例）；新增 `server/agent/service/delegation.mjs`（核验缓存与撤销） |
| 丙 托管档入口、闸、用量、对话与事件记录、补渲发布、Key | 新增 `server/agent-service/main.mjs`、`http.mjs`、`admin.mjs`、`set-key.mjs`；`server/agent/service/gate.mjs`、`usage.mjs`、`conversations.mjs`（事件记录、状态、补发与实时的切换）、`runs.mjs`（一轮的生命周期）、`render-request.mjs`（第 16 节）、`cloud-tools.mjs`；改 `server/harness/providers/mock.mjs`、`server/ai-system-prompt.md`（或新增云端那一段的文件） |
| 丁 界面（在线与桌面） | 新增 `src/ai/backend/{index,desktop,cloud}.ts`；接入方式选择器加「云端」及其出现条件；历史列表分组与「进行中」标记；改 `src/ai/useAiChat.ts`、`chatStore.ts`、`providerState.ts`、`src/editor/right/AiPanel.tsx` 及其子组件、`src/editor/dock/DockPages.tsx`、成员列表与显示名所在文件、`src/editor/sync/` 里取委托票据的一处、`src/editor/ProjectSettingsDialog.tsx`（开关） |
| 戊 部署与文档 | `server/hosted/deploy/` 的 nginx 模板与 README、新增 PM2 配置；`scripts/remote/docservice.mjs`（加 `deploy-agent`）；`docs/semantics/` 与各契约按第 12 节；`hosting-migration.md`；`draft_cloud-node-and-agent.md` 步骤 3 |
| 己 测试与探针 | `server/test/cloud-agent-*.test.mjs`、`server/test/c10a-online-build.test.mjs`、`scripts/probes/cloud-agent-probe.mjs` |

### 14.2 分块、人选与先后

```
甲（opus-dev）──┬──▶ 丙（sonnet-dev-high）──┬──▶ 己的探针（sonnet-dev-high）
                │                            │
乙（opus-dev）──┘        丁（sonnet-dev-high，可与丙并行，先对着模拟的 /agent/v1 做）
戊（sonnet-dev-high，最后）
```

- 甲、乙必须 `opus-dev`，可以并行（文件不重叠，接口在本文第 2.1、4.3 节）。乙依赖第三段的服务身份骨架（握手、目录模块、`sv` 票据、白名单）：最省事是等第三段的实现合进集成分支后从集成分支出发；要并行就先只做不依赖它的部分（委托票据的签发与核对、`memberAccess`、`access` 拒写、`hosted.agent` 开关与 `set-hosted-service` 的 `agent` 一支），`hosted.ticket` 的委托分支等骨架到了再接。
- 甲分两个提交：只搬不改（跑 13.4 的清单）→ 加实例登记表与锁。
- 己的单测跟着各块写；CA-ISO、CA-AUTH、CA-REVOKE 由写乙的人之外的一方写更好（只照本文写，不看实现）。

估计工作量（子 Agent 的净工作时间，不含主会话审查）：甲 5～7 小时，乙 6～8 小时（含对话委托、发布用票据、与第三段对齐），丙 7～9 小时（一轮与连接脱钩、事件记录与补发、补渲发布是第二稿新增的大头，其中 `runs.mjs` 与 `conversations.mjs` 建议也由 `opus-dev` 做），丁 7～9 小时（多了桌面版一侧），戊 2 小时，己的探针与修问题 7～10 小时（端到端探针依赖第三段的渲染服务已在集成分支上）。并行后日历时间约两天半。

### 14.3 与并行分支可能冲突的文件

| 文件 | 对方 | 怎么避 |
|---|---|---|
| `server/auth/*`、`server/docservice/modules/shared.mjs`、`server/docservice/shared-service.mjs` | 第三段 | 乙在第三段合进集成分支之后再从集成分支出发；服务握手、登记表、目录模块 `hosted`、`sv` 票据、白名单的骨架由第三段先落，乙只加 Agent 的部分（4.7 表里「还差什么」一列） |
| `server/hosted/deploy/*`、`scripts/remote/docservice.mjs`、`hosting-migration.md` | 第三段 | 同上，戊最后做 |
| `src/editor/ProjectSettingsDialog.tsx`、成员列表组件 | 第三段 | 第三段先加「托管方服务」一组，丁在同一组里加一行 |
| `src/ai/mcpExecutor.ts`、`server/tools/audio.mjs`、`src/mcp/handlers/audio.ts` | 第一段（声音） | 本任务不改这三个文件；起点 `e7d18340` 已含声音的合入，开放清单按已含声音工具的表写的 |
| `src/online/*`、`src/editor/sync/*`、`DockPages.tsx` | 第二段 | 丁只在 `src/editor/sync/` 加取委托票据的一个函数；`DockPages.tsx` 只动第 36～46 行那一段。第二段若也动了这一段，合流时人工并 |
| `server/test/c10a-online-build.test.mjs`、棘轮清单 | 第二段 | 清单本任务不加条目；第二段若删了条目，以它为准 |
| `docs/semantics/product/platforms.md`、`hosting.md`、`workflow/project.md` | 第二、三段 | 语义留到各段合流后由主会话按逐字稿统一落 |

---

## 15. 希望主会话定的，与要问用户的

见返回给主会话的消息；这里留一份备查。

**希望主会话定的**

1. 「桌面版改用同一个入口」按 2.1 的理解：同一份实现挂在编辑器进程里，不另起桌面进程。
2. 只读成员（4.6）：只做机制与探针里造出来的只读成员，不加界面。
3. 效果类工具（`create_filter`、`create_pixel_map`、`create_audio_fx` 及其 `update_*`）：J 把「效果」列在开放一侧，本文照开。但像素映射的定义会编成片元着色器在别人的浏览器与渲染节点上执行，性质上接近「写出要被执行的源码」。若主会话认为该归到关着的一侧，开放清单去掉 `create_pixel_map`、`update_pixel_map` 两个即可，其余不变。
4. 实例按「项目 × 成员」而不是按项目（3.1）。
5. 对话归「项目里的用户名」、同项目别的用户名不可见（7.2）。
6. 可选项：看画面不做；页面状态用发消息时的快照，反向通道不做（9.4）。〔用户 2026-10-07 推翻:「看画面不做」作废,看画面要做,见 23.1;页面状态用发消息时的快照、反向通道不做,不受影响〕
9. 对话委托 60 分钟、一轮 30 分钟、不自动续跑（4.2、7.3、7.5）。
10. 无人在线时的补渲走 16.2（Agent 服务发布）还是让渲染服务自己发；16.3 的 R1～R9 与第三段协调。
11. 「云端对话在跑时关页签或退出，不拦不弹确认」（9.5）。
7. 与第三段的对齐：共用代码检出目录与 PM2 配置的写法；开关用两个字段两种操作（照第三段现状）还是合成一个（4.7 第 6 条）；4.7 表里其余「还差什么」由哪一段落。
8. 第 11 节的数字。

**可能要问用户的（任务书没列的用户可见行为）**

1. **云端下不提供「深度自主」与「审查环路」**（9.3）。不提供是收窄，理由是费用没有上限；若用户希望云端也有，需要先有额度。
2. **一级文档的改动**（12.7）：`user-workflow.md` 加「云端」接入方式、`workflow/project.md` 与 `product/document-service.md` 的「创建者特权只有三项」改成四项（已裁定，待用户审）。E～J 的决定里含了这两件事的实质，但任务书点名的语义文件里没有这两份；草稿 `draft_cloud-node-and-agent.md` 把它们列为一级改动。
3. **云端下不能附文件**（9.5）。它是 J「读写节点本地文件的不开放」的直接后果，列出来让用户知道。〔用户 2026-10-07 推翻:附件在云端可用,见 23.1〕
5. **自由进入的成员只能在原设备找回云端对话**（7.2，已裁定取保守的一条，待用户审）。
6. **含用户卡的片段在没人在线时能不能渲**取决于第三段第 0 节第 1 条选 A 还是 B；选 B 时用户体验验收里「画面是渲好的」对用户卡不成立。
4. **对话记录托管方读得到**（7.2）。

---

## 16. 没有任何成员在线时，重卡怎么渲出来

### 16.1 现状与缺口

预渲染任务现在都是页面发布的：在线页面发带片段清单的计划任务（`src/online/planPublisher.ts`，`c10-contract.md` 第 7 节），桌面版由本机预渲染进程发。队列只在内存里，按发布方的连接记账（`mechanism/document-service.md`「队列只在内存里」）。云端 Agent 改了一张重卡而没有任何页面在线时，没有人发布任务，渲染服务无活可接；等下一位成员进来，看到的是占位，他的页面再发任务、再等渲。这不满足「另一成员进来看到的画面是渲好的」。

### 16.2 方案：Agent 服务在改动落地后发布补渲计划

〔裁：主会话 2026-10-06〕：无人在线时的补渲由 Agent 服务发布；16.3 的 R1～R9 已转第三段。

选「谁改的谁发」：Agent 服务自己知道每次写入动了哪些片段（执行器的 `ctx.write.clipIds`，`agent-exec.mjs:387`），不用任何一方去猜。

- **发布方**：Agent 服务，用**服务身份**（不是成员的委托）在这个项目里开一条只用来发布的连接（下称发布连接）。不用成员身份的理由：补渲要活过这一轮、活过成员被移出，也不该占成员的权限；它只是「请渲染节点把这几个片段渲了」，不读不写项目内容。
- **发什么**：与在线页面同一种清单计划——`kind: 'plan'`、`id: plan:<projectId>@<项目版本>#clips:<清单签名>`、`input.clips` 为片段 id 清单、`requires.codeVersion` 为这份检出的代码版本、不写环境指纹（让渲染服务按自己的环境切）。优先级用补渲那一档（排在成员本机判重的任务之后，`document-service.md`「补渲排在后面」）。计划的形状与签名算法只有一份：从 `src/online/planPublisher.ts` 里把纯函数部分经 `ssr-host.mjs` 载入（仍是那一处载入缝），不在服务端另写一遍。
- **清单里放哪些片段**：这一轮里被写到的、需要预渲染的片段。Agent 服务没有成本记录的判定，按低内存档过渡期的同一条规则办：**全部按重卡处理**（`platforms.md`「轻重判定」）；素材片段（视频、图片、音频）不放。已经有结果的由渲染服务按结果键跳过，不重做。**一次改动只发受影响的片段**：清单是「上一个计划之后被写到的片段」的并集，不是整个项目；每个计划最多 200 个片段，多了分批〔裁：按主会话 2026-10-06 转来的第三段估计改〕。
- **什么时候发**：每次写入落地后攒 3 秒（一连串写入合成一个计划），按当时的项目版本发；新的计划发出后撤回这个对话上一个还没被认领完的旧计划（旧版本的画面没人要了）。一轮结束时再补发一次，保证最后的版本有计划。写入之间隔得比 3 秒长时每次写入各发一个计划，中途的改动不等一轮结束就开始渲；这时计划里的版本号会落后于项目，怎么收场见 16.4。
- **保持到结果入库**：发布连接与 `pending-render.json` 的寿命跟着计划走，不跟着那一轮、也不跟着实例走。计划完成（收到 `task.done`）→ 记 `render { state: 'done' }` 事件、清掉清单；全部清单清空后关发布连接。**按「连续多久没有进度」判，不按总时长判**〔裁：按主会话 2026-10-06 转来的第三段估计改〕：第三段估一个 200 片段的清单计划一般约 70 分钟、最坏约 8 小时，不确定度是倍数级，定一个总时长没有意义。队列让发布方看得到进度（细任务的认领、`task.progress`、完成）：**连续 10 分钟**没有任何一条进度或完成就放弃，记 `render { state: 'failed', reason: '渲染节点 10 分钟没有进展' }` 并撤回；另留一个很宽的绝对上限 **12 小时**作保险。放弃之后由下一个进来的页面按现有规则自己发。每有一批完成就记一条 `render { state: 'progress', done, total }`（节流到每 30 秒至多一条）。
- **失败不悄悄丢**：收到 `task.fail`（原因是 `superseded` 的除外，那是作废不是失败，见 16.4）→ 事件记录里记 `render { state: 'failed', clips, reason }`，对话界面在那一轮下面显示「以下片段的预渲染没有完成：…，有渲染节点的成员上线后会自动补上」。项目内容不受影响。渲染服务的项目开关关着、或节点上没有渲染服务 → 不发布，记 `render { state: 'unavailable' }`，显示「托管方的渲染节点没有为这个项目开启，重卡的画面要等有渲染节点的成员上线」。
- **Agent 服务重启**：起来后扫各对话的 `pending-render.json`，按清单重新发布（队列在内存里，文档服务或 Agent 服务任何一方重启都靠重发）。这一步只用服务身份，不需要成员在场。
- **云端 Agent 的开关关了、项目删了**：撤回并清掉清单。成员被移出：他名下对话的清单照常渲完（改动已经在项目里了，别人要看）。
- 兜底不变：任何成员的页面进来，仍按现有规则自己判重、自己发计划。上面这一套只是让「没人在线的那段时间」也有人发。

### 16.3 对第三段的要求

第三段的草稿（`acbb2993`）是「只连有成员在线的项目」「服务身份只能发细任务」。要满足用户体验验收，需要它改这几处：

| # | 要求 | 草稿现状 | 说明 |
|---|---|---|---|
| R1 | **项目「活跃」的判据要把云端 Agent 算进去**：空间里有任何不是渲染服务自己的连接（成员的页面、云端 Agent 代成员开的连接、Agent 服务的发布连接），或队列里有未完成的任务，都算活跃 | `active` = 有不是托管方服务的连接，最后一个成员走后保持 60 秒 | 否则成员一走，渲染服务 60 秒后就断开这个项目，Agent 接着改出来的重卡没人渲 |
| R2 | **`agent` 服务能以服务身份当发布方**：`hosted.ticket { projectId, purpose: 'publish' }`（不带委托）给 `agent` 服务签一张只能发布的连接票据；这条连接的白名单只有 `publisher.hello`、`task.publish`（只许带片段清单的 `plan`）、`task.withdraw`、订阅自己发布的任务的完成与失败；不能 `node.hello`、不能认领、不能读写项目与内容库、不能取任何票据 | 服务连接 `task.publish` 只许细任务，`kind: 'plan'` 回 `forbidden`；`agent` 服务的白名单留空 | 4.3 ③里「`agent` 服务不带委托一律 `forbidden`」相应改成「不带委托只能要 `purpose: 'publish'` 的票据」 |
| R3 | **渲染服务认领 `agent` 服务发的清单计划**，与在线页面、低内存档发的同样对待（切分、按自己的指纹出细任务、产小尺寸） | 认领范围写的是「在线页面的清单计划、低内存档的补渲计划」 | 形状相同，只是发布方身份不同；请确认认领逻辑不按发布方的身份种类筛 |
| R4 | **发布方短暂断开不丢任务**：发布连接断开后，它发的计划与切出的细任务至少保留到会话接续的时限；已经认领的细任务做完照常入库、照常写清单 | 待第三段说明队列现在对发布方断开的处理 | 结果入库与写预渲染清单是渲染服务自己做的，不依赖发布方在不在，这一点请写明并加单测 |
| R5 | **结果要让后来的页面直接贴上**：渲染服务产出后写内容库的预渲染清单，后进来的在线页面不用再发计划就能取到 | 白名单里已有写 `render-manifest`、`snapshot-manifest` | 请确认「发布方不是页面」时清单照写 |
| R6 | 渲染服务与 Agent 服务**出自同一个提交**（计划里的 `requires.codeVersion` 要对得上），部署顺序与检出目录一起定 | 草稿 7.4 要求渲染服务与在线页面同提交 | 三者同提交；Agent 服务的代码版本用同一个 `frameCode` 算 |
| R7 | 渲染服务对这个项目的开关与可用性，Agent 服务要能知道 | `hosted.watch` 推的 `enabled` 是订阅者自己那种服务的 | 请在 `hosted.project` 里另带 `render: { available, enabled }`，或允许 `agent` 服务另订一份渲染的 |
| R8 | 用户卡片段的任务按第三段第 0 节第 1 条的选择办；Agent 服务不区分，清单里照放，由渲染服务按能力认领或留着 | **方案 B**（主会话 2026-10-06 转来的结论，见第 20 节）：托管方的渲染节点不认领含用户卡的任务 | 含用户卡的片段在没人在线时渲不出来；端到端探针用内置重卡验 |
| R9 | 渲染服务满载或排队时任务等着，不报失败；Agent 服务这边连续 10 分钟没有进度才记失败（第三段已给估计：200 片段一般约 70 分钟、最坏约 8 小时） | 草稿第 4 节的并发上限 | 两边的时限要对得上：请第三段给出「一个 200 片段的计划在节点上最坏多久」的估计，我据此调 30 分钟 |

如果主会话更愿意走另一条路（**渲染服务自己盯着项目的变化发布**，Agent 服务什么都不发）：对我这边更省事（16.2 整节不用做，只留 `render` 事件靠订阅队列得到），但渲染服务要自己判断「哪些片段变了、要不要渲」，等于把在线页面的判重搬一份进渲染服务，并且在有页面在线时会与页面发的计划重复。我的建议仍是 16.2。

---

### 16.4 项目往前走了：旧计划与旧细任务怎么收场（2026-10-06，分支 `claude/cloud-agent`）

**缺陷。** 云端 Agent 的写入之间隔得比防抖长时（真模型的每次往返都是几秒），每次写入各发一个指着当时版本的清单计划；项目接着往前走。有真身的项目文档服务只给得出**当前**版本的项目快照（`project.snapshot.get`：旧版本没有人上传过快照，发布连接的白名单也不许上传）。渲染节点两处取不到旧版本：计划被认领时项目已经不是它指的那一版；细任务排到时也一样，而且同一个结果键的细任务不另起，新计划切出的任务常常就是旧计划建的那一个，带着旧版本号。取不到就以「文档服务上没有项目快照」失败（可重试，三次后定为失败），订阅它的新计划跟着失败。修之前步骤 `spaced`（12 次写入、每次隔 9 秒）跑三遍，渲染节点各失败 24、22、23 个任务（记了原因的那一遍：9 次是计划、14 次是细任务，全是这一句；一个任务重试三次各记一次）；对话记录里最后是不是「云端渲染失败」看时序。在线页面发的清单计划在连续编辑时有同一个问题，只是人手慢、不常撞上。

**原则。** 细任务的结果按内容寻址，任务里的项目版本号只是「去哪一版取输入」的线索，不是任务的身份。项目往前走了不是失败。

**做法**（全文在 `render-queue-contract.md` J.15；队列本体没有改）：

| 谁 | 做什么 |
|---|---|
| 文档服务 | 取不到的那一版若属于有真身的项目，回包多带当前版本号 `currentRev` |
| 渲染节点（执行器） | 取不到任务指的那一版就按当前版本算；带片段清单的计划与它切出的细任务另加一条：本进程已经算过更新的一版，就不回头用旧的。计划按实际那一版切，层表也按那一版写。细任务在实际那一版里按片段与内容键核对：**内容没变的照做**（产物相同），**片段没了或内容换了的作废**（报给队列 `superseded`，不可重试），不渲、不记失败 |
| 队列 | 不改。作废沿用现有的 `superseded`：订阅者收到 `task.failed { error: 'superseded' }`，之后同一个任务再被发布时当它不存在、重新建 |
| Agent 服务（发布通道） | 细任务作废算「有了结局」，不算失败：计划照常收尾。计划有了结局（完成、失败、撤回）就退订它与它切出的细任务（别的计划还要的不退），账上这些细任务的失败与作废记录一并清掉——之后的计划再遇到同一个细任务，队列会把那一刻的真实状态补发过来，不凭旧账判。计划每被切一次（原计划、断线重发后核对的那一次）都以最新那一次给的细任务清单为准。两条细则：(1) 手里还有没切的计划时，被撤回的旧计划的细任务先不退订（新计划切出来的可能正是它们；这时退了就再也收不到结局），等手里的计划都切完、知道谁还要哪些再退；(2) 计划切出的清单里有账上记成作废的细任务：队列在切分时已经把作废的重建了，旧账不作数，清掉，并照「核对一次」的办法让渲染节点再切一遍、以新清单为准 |

**结果。** 不论写入间隔多长、写多少次：

- 最后一版上 Agent 改过的片段都渲出来、入库、写进层表。最后一次写入一定有计划（防抖到点或一轮结束时补发），它指的就是最后一版；它切出的细任务要么是新建的，要么是内容相同的旧任务。
- 被取代的旧计划：还没被认领的随撤回从队列里删掉；已经被认领的按当前版本切，切出的就是当前内容的细任务。被取代的旧细任务：计划任务排在细任务前面（`render-node/pick.mjs`），新计划先被认领，之后旧细任务一排到就作废，不渲。
- 渲染节点白做的上限：新版本写入时**正在渲的那一段**（60 帧）做完；另外，写入落地到它的计划发出之间有 3 秒防抖，这 3 秒里渲染节点还不知道项目变了，开工的旧细任务会渲完（串行，一般一两段）。这些产物仍按内容寻址入库，改回原样时用得上。
- 对话记录里的补渲事件只有 `published`、`progress`、`done`；`failed` 只在真失败时出现（渲染节点崩了、产物到了容量上限、连续 10 分钟没有进度）。
- 别的成员在 Agent 的计划渲完之前改了同一个片段：Agent 那一份内容作废，计划照常记完成；新内容由改它的那一方发计划（在线页面按现有规则发，桌面版自己预渲染），与「谁改的谁发」一致。

**没有采用的两条路。** (a) 一轮进行中不发计划、只在结束时发：一轮上限 30 分钟，中途的改动最长要等 30 分钟才开始渲，而且计划发出到被认领之间别的成员一改，仍然撞同一个缺陷。(b) 文档服务在收下清单计划时把那一版的快照留下来：旧任务能做完，但做的是没人要的旧画面；每个项目要按版本留整份项目（每份可到几 MiB，留多久、何时清都要另定），计划发出时版本已经落后的那一种仍然留不下来。

**单测**（`server/test/cloud-agent-rerender.test.mjs`）：

| 编号 | 断言 |
|---|---|
| CA-RR-01 | 间隔长的多次写入（8 次，每次各发一个计划）：计划被认领时项目已经往前走、细任务排到时内容已换。没有任务以失败收场，最后一版全部渲完，层表是最后一版的且不被迟到的旧计划写回旧版本，渲染节点没有为已被取代的内容开工 |
| CA-RR-02 | 旧计划被取代：没人认领的撤掉；切出来还没开工的，内容没变照做（只渲一次）、内容换了作废；对话记录里只有已发布与完成 |
| CA-RR-03 | 发布方断线重连重发：断开期间细任务做完、过了队列的宽限期、项目又往前走、渲染节点手里也没有旧版本了；重发的旧计划经核对的那一次切分（按当前版本）对上，记完成 |
| CA-RR-04 | 渲染节点中途重启：手里的一段被队列收回，新进程接着做；旧版本取不到就按当前版本核对，内容没变的照做（清单计划切出的细任务按任务记进预渲染集合）、内容换了的作废 |
| CA-RR-05 | 执行器：按文档服务回的当前版本算；计划带回实际切的版本；细任务内容没变照做、换了抛 `superseded`；文档服务没说当前版本时照旧是 `no-snapshot`；不是清单计划切出的任务有缓存的旧版本照旧按旧版本做 |
| CA-RR-06 | 文档服务与项目客户端：有真身的项目取旧版本回 `missing` 加 `currentRev`；取当前版本照给；没有真身的项目不带 |
| CA-RR-07 | 发布通道：作废不算失败（完成事件带作废数）；有了结局就退订（别的计划还要的不退）并清旧账；以最新一次切分的清单为准；手里还有没切的计划时细任务先不退；还订着的细任务被作废过、新计划又切出同一个时再核对一次 |

**探针。** `cloud-agent-ux-ui-probe` 的步骤 `spaced`（缺省就跑，K1～K3）与 `cloud-agent-ux-probe` 的步骤 `spaced`（U17～U19）：12 次写入、每次隔 9 秒；补渲的结局是完成，渲染节点失败任务数为 0（作废的单列），渲完之后才上线的成员取到的是最后一版的预渲染结果。

---

## 17. 第二稿相对第一稿的改动（2026-10-06，任务书更新后）

任务书加了「用户体验验收」、改了 I、补了 J 之后，第一稿（提交 `c3c94fdb`）里这些地方改了：

| 处 | 第一稿 | 第二稿 |
|---|---|---|
| 2.3 接口 | `POST /v1/chat` 直接回流，一轮绑在这条连接上；页面 `PUT` 对话记录 | 发消息回 202，一轮与连接无关；事件流单独一个接口，可补看、可多处同时看；对话记录由服务端写；`abort` 按对话；放开跨源（桌面版要打） |
| 2.4 流 | 断流即中止，`seq` 只留格式 | 事件先存后发；断流不停；按 `seq` 补发再接实时 |
| 3.1 实例 | 「项目 × 成员（`userId`）」一份，对话记录也按它 | 运行实例仍按「项目 × `userId`」；对话的归属按主人键（7.2）：创建者与限定进入的成员按用户名，能换设备找回；自由进入的成员按 `userId` |
| 3.4 回收 | 闲置 10 分钟回收实例 | 同，但有未渲完的补渲清单时发布连接另算（第 16 节） |
| 4.2、4.3 身份证明 | 一种委托票据，2 分钟；页面关了又要重连就停 | 两种：委托票据（2 分钟，给页面的每个请求用）与**对话委托**（绑成员 × 项目 × 对话，60 分钟，一轮一张，成员离线后仍有效，可撤销） |
| 4.3 | `agent` 服务不带委托一律拒 | 不带委托只能要发布用的票据（16.3 R2） |
| 7 对话记录 | 页面存 `transcript.json`；同一成员换设备看不到 | 服务端写事件记录；按用户名归属，换设备看得到 |
| 7.3 | 一轮 24 次往返、15 分钟 | 24 次往返、30 分钟 |
| 9.2、9.4 页面状态 | 只做「随消息带播放头」；`get_selection` 不开放 | 随消息带播放头与选区；`get_selection` 与三个切剪辑的工具开放；发起方不在线时回明确的「发起方不在线」 |
| 9.5 界面 | 桌面版不加「云端」 | 项目放云端时桌面版 AI 栏有「云端」，本机仍是缺省；桌面构建也带云端后端 |
| 10 通道 | 只有在线页面同源访问；守门 C10A-API-06「桌面产物里没有 `/agent/v1/`」 | 加 10.4：桌面版直连云节点；C10A-API-06 作废，换成 CA-DESK-02～04 |
| 13 测试 | — | 加 CA-RUN、CA-GRANT、CA-RENDER、CA-DESK-02～04 与端到端探针 CAP-UX-01～06 |
| 16 | 没有 | 新增：无人在线时的补渲与对第三段的要求 |

---

## 18. 依据

仓库内（起点 `e7d18340`）：

- 进程级状态：`server/vite-plugin-ai.ts`（行号见 3.2）；`server/runners/api.mjs:12`、`:136`、`:154`、`:173`、`:196`、`:227`、`:326`；`server/ai-config.mjs:23`～`:56`；`server/runners/config-crypt.mjs:22`～`:65`；`server/runners/machine-id.mjs:66`～`:89`；`server/agent/agent-exec.mjs:210`～`:232`、`:337`～`:358`；`server/agent/ssr-host.mjs:19`～`:82`；`src/store/core.ts:57`；`src/mcp/apiUrl.ts`；`src/mcp/common.ts:163`～`:302`。
- 现成的无插件 vite 起法：`server/test/c65b-kit.mjs:274`。
- 鉴权：`server/auth/handshake.mjs:122`～`:261`、`server/auth/tickets.mjs:40`～`:128`、`server/docservice/modules/shared.mjs`、`server/docservice/modules/project.mjs:519`（渲染角色不能改项目的现成先例）、`server/docservice/shared-service.mjs:128`～`:209`。
- 守卫与棘轮：`src/online/apiGuard.ts`、`server/test/c10a-online-build.test.mjs:72`～`:80`、`server/test/c10a-online-api-paths.json`（19 条）、`src/online/onlinePrune.test.mjs`。
- 工具表：`server/mcp-tools.mjs`（128 个；各组数目与 `side` 用 `node -e` 现场列出）、`src/mcp/routes.mjs`。
- 模拟提供方：`server/harness/providers/mock.mjs`；用法 `server/test/harness-smoke.mjs:41`。
- 部署模板：`server/hosted/deploy/nginx-site-promptcut.conf`、`server/hosted/main.mjs` 文件头。

外部（2026-10-06 查）：

- nginx `ngx_http_proxy_module` 文档（`https://nginx.org/en/docs/http/ngx_http_proxy_module.html`）：`proxy_read_timeout` 缺省 60 秒，且只算两次读之间的间隔——所以 SSE 要么调大它、要么靠 15 秒一次的 ping，本文两样都做；响应头 `X-Accel-Buffering: no` 可按响应关掉缓冲；`proxy_http_version` 在 1.29.7 之前缺省是 1.0（节点上是 1.18），所以模板里显式写 1.1。
- PM2 应用声明文档（`https://pm2.keymetrics.io/docs/usage/application-declaration/`）：`max_memory_restart` 超过即重启；`kill_timeout` 是发最终 SIGKILL 前等的毫秒数；`autorestart` 缺省开；`max_restarts` 缺省 16 次不稳定重启后停止拉起。`exp_backoff_restart_delay` 在这一页没有查到，实现时以节点上装的 PM2 版本的 `pm2 start --help` 为准，没有就改用 `restart_delay`。
- Node.js 命令行文档（`https://nodejs.org/api/cli.html`）：`--max-old-space-size` 的单位是 MiB；进程用的内存超过系统认为合适的量时可能被系统直接结束——节点无 swap，所以另加 PM2 的常驻内存上限。

---

## 19. 待用户审的裁定（主会话 2026-10-06 定，合入 main 前由用户审，可以推翻）

| # | 裁定 | 在哪 | 用户看得到的后果 |
|---|---|---|---|
| U1 | 云端对话的归属：创建者与限定进入的成员按用户名、能换设备找回；自由进入的成员按「用户名 + 设备」、只能在原设备找回 | 7.2 | 自由进入的成员换一台设备进项目，看不到自己在另一台设备上发起的云端对话 |
| U2 | 云端第一版只开普通对话，不提供「深度自主」与「审查环路」 | 9.3 | 选「云端」时这两项不可选并说明原因 〔用户 2026-10-07 确认:「深度自主」在云端保持置灰;「普通对话」之外的工具范围按 23.1 放开〕 |
| U3 | 「创建者特权只有三项」改成四项，第四项是「开关托管方在这个项目里的服务（渲染节点、云端 Agent）」 | 12.7（`workflow/project.md`、`product/document-service.md`） | 项目设置里多两个只有创建者能改的开关 |
| U4 | 一级文档：`user-workflow.md` 的接入方式加「云端」；`workflow/project.md` 加「云端 Agent」开关一条 | 12.7 | E～I 的直接后果 |
| U5 | ~~云端下不能附文件~~〔用户 2026-10-07：附件改回可用，见第 9.4、9.11 节〕；云端对话记录存在托管方的节点上，托管方读得到 | 9.5、7.2 | 界面说明与语义里照写 〔用户 2026-10-07 推翻:「云端下不能附文件」推翻,附件在云端可用(23.1);「对话记录托管方读得到」不变〕 |

---

## 20. 合流与接线的实现记录（2026-10-06，分支 `claude/cloud-agent`）

第三段（`claude/render-service`）与身份一块（`claude/cloud-agent-auth`）合进本分支之后，Agent 服务接上真身份与真队列时定下、或与上文不同的地方。上文与本节冲突时以本节为准。

**入口与配置（第 2.2 节）**

- 命令行入口读 `PROMPTCUT_AGENT_SECRETS`（缺省 `/var/lib/promptcut/agent-secrets`）下的 `service-key.json`，服务名必须是 `agent`，否则 `config.error service-identity`。文档服务一时连不上不退出：控制连接自己退避重连，期间新请求回 503 `unavailable`。
- `PROMPTCUT_AGENT_PUBLIC_ORIGIN` 是可选项，只做格式检查并记进日志，**不拿它拒绝请求**：桌面版的页面从本机源跨源来打（第 2.3、10.4 节），鉴权只看票据。第 13.1 节 CA-ENTRY-03 里「带 `Origin` 不是公网源：403」这一句作废。页面拿到的地址由托管组合的 `PROMPTCUT_AGENT_PUBLIC_URL` 经文档服务下发。
- `GET /healthz` 多回一个 `codeVersion`（这份检出的代码版本，与渲染服务、在线页面同一种算法）：渲染服务的管理进程拿它核对三者是不是同一个提交（它的 `PROMPTCUT_RENDER_AGENT_STATUS_URL` 指到这里）。不含任何项目信息。
- 另有两个排查与演练用的环境变量：`PROMPTCUT_AGENT_RENDER_STALL_MS`、`PROMPTCUT_AGENT_RENDER_DEBOUNCE_MS`（补渲的两个时限）。
- `end` 事件多带 `reason`（有原因时：`stopped`、`model`、`quota-exceeded`、`limit`、撤销的各种原因、`interrupted`）。只追加。

**认证（第 4 节）**

- 接线在 `server/agent-service/hosted-wiring.mjs`：请求头里的票据 → `hosted.delegate.verify` → 身份（文档服务回的 `ownerKey` 直接当归属键）；按票据摘要缓存 15 秒，且不晚于票据自己到期。`service-disabled` 回 403 `disabled`，控制连接断着或超时回 503 `unavailable`，其余 401。
- 委托票据与对话委托**都能当请求头里的票据用**（第 4.2 节「防重放与外泄」已写明这一条的代价）；发消息请求体里的 `grant` 则必须是对话委托，并且是这个项目、这位成员、这个对话的，否则 403 `bad-grant`、不起任何一轮。不带 `grant` 同样 `bad-grant`。
- **实例自己的那条连接**（副本的订阅、在场状态；执行器里没有对话 id 的那一条）没有自己的对话委托：借这个实例里一个手里有委托的对话的 id 与委托去换连接票据。它与对话的连接是同一位成员的身份、同一份权限，文档服务一侧不区分。后果：那个对话的委托过期（60 分钟）之后这条连接若断了、实例里别的对话又没有更新的委托，要等这位成员的下一条消息才连得回来；一轮的上限是 30 分钟，正常用不到。一轮结束后它的委托就从内存里清掉。
- **撤销的两条路都在用**（第 4.5 节），哪条先到算哪条：文档服务以 4003 / 4004 关掉数据连接（移出、踢人、删项目实测都是这一条先到）；控制连接上的目录推送（关开关实测是这一条先到）。目录推送还让没有进行中对话的闲置实例也被关掉。撤销时受影响成员开着的事件流在写完原因与 `end` 之后被服务端结束。
- 项目从目录里消失有删除与搬迁两种可能。Agent 服务这时问文档服务一次（要一张发布票据）：回 `no-project` 才按删除办（删对话记录）；回 `relocating` / `relocated` 只停不删；问不到就不动。
- 没有进行中对话、也没有实例的成员被踢或被移出后：他要不到新的委托票据，手里那张最多再用 15 秒（缓存）加它自己剩下的有效期；已经开着的事件流不会被主动关掉（它只看得到他自己的对话，之后也不会再有新内容）。

**补渲（第 16 节）**

- 发布通道在 `server/agent-service/render-publisher.mjs`：一个项目一条发布连接（`hosted.ticket { purpose: 'publish' }`），发布方 id 在进程与项目上稳定。连接开着期间每分钟 `hosted.demand` 一次（保持 2 分钟），关的时候撤回。
- 进度照第三段 5a 节：计划被切分后先收到计划自己的 `task.done`（结果里的 `derived` 是切出的细任务），之后每做完一段一条 `task.done`。任何一条 `task.done` 都算这个项目里各计划的进度；一个计划的全部细任务都有了结果才算完成，有细任务失败就记失败。
- 发布连接中途断开：退避重开（2、5、15、60 秒），把没渲完的计划原样重发。断开期间做完的细任务队列不会补发通知；别的发布方（在线页面）先发过、已经切完的同一个计划，发布方也不在它的细任务的订阅者里。这两种情况改发**同一份清单的补渲档计划**（结果键不同）让渲染节点重新切一次：已有的细任务把发布方并进订阅者，做完的当场各补一条。同一份清单只这样核对一次；还对不上就由「连续没有进度」放弃。
- 撤回用 `task.unsubscribe`（队列没有 `task.withdraw`），连同已知的细任务一起退订；别的计划还要的细任务不退。计划完成或失败之后同样退订（第 16.4 节）。
- 有细任务失败就记失败这一句，`superseded`（作废）除外：它算有了结局、不算失败（第 16.4 节）。核对用的那一次切分给出的细任务清单与原来不同时以新的为准。
- 优先级是 `normal`（与在线页面发的清单计划逐字段相同），核对用的那一个是 `backfill`。
- 「连续没有进度」放弃时写进对话记录的原因是固定的一句「渲染节点 10 分钟没有进展」；时限被环境变量改短时这句话不跟着变。
- **R8 又改回方案 A**（主会话 2026-10-07 转来，`claude/render-service` 的 `a3898559` 已合进本分支）：托管方渲染服务用按项目隔离的工作进程执行项目带来的用户卡（同时最多一个、一轮一个项目、闲置 60 秒结束、冷启动约 7～11 秒），所以云端 Agent 建卡、改到用户卡片段之后没人在线也渲得出来，只是更慢。体验探针的进程版已加这一步并通过（U20，第 24.2 节）；界面版没有加。以下是改之前的记录——
- **R8 的结论改成方案 B**（主会话 2026-10-06 转来）：第三段的用户卡隔离工作进程没有交付，托管方的渲染节点不认领含用户卡的任务。云端 Agent 改到用户卡片段时清单里照放，渲染节点不接，Agent 服务一侧表现为连续没有进度后记 `render failed`；这些片段的画面要等有渲染节点的成员上线后由页面按现有规则补上。这是已知范围，不是缺陷。

**资源上限（第 11 节）**

- 「单次工具 60 秒」已做：到时不再等，工具结果明说这一步没做完、可能没有生效。「`history.json` 8 MiB」已做：落盘时超了按现有的历史截断（从最早的整对消息删起）再落。
- PM2 配置（`server/hosted/deploy/pm2-promptcut-agent.config.cjs`）：`--max-old-space-size=1536`、`max_memory_restart: '2G'`、`kill_timeout: 8000`。`nice` 没有做（PM2 的配置里没有对应项，要另包一层启动脚本；记在未达成里）。

**部署（第 2.2、10.1 节）**

- Agent 服务不单独上传代码，用 `deploy-render` 放上去的那份检出（`/opt/promptcut-render/current`）。子命令 `keygen-agent`、`deploy-agent`、`status-agent`、`stop-agent`（都收 `--dry-run`）；nginx 的 `/agent/` 一段在 `server/hosted/deploy/nginx-location-agent.conf`。

**没有并掉的重复**

- `server/hosted-render/directory.mjs` 与 `server/auth/service-client.mjs` 都是「凭服务私钥连控制连接、订目录、要票据」，重叠约七成。这一轮没有并：两者的退避参数、错误码（`directory-offline` 等）、每 60 秒主动重订、`status()` 的形状都不同，渲染服务的管理进程与它的单测按这些形状写；第三段的隔离工作进程还在另一个分支上改同一目录。并的办法是让 `directory` 包在 `service-client` 外面（清单的缓存、`since`、定时重订留在外层），等第三段的分支都合完之后做。

---

## 21. 界面合流与页面一侧接线的实现记录（2026-10-06，分支 `claude/cloud-agent`）

界面（丁块，`claude/cloud-agent-ui`）合进本分支、接上真身份之后定下、或与上文不同的地方。上文与本节冲突时以本节为准。

**身份（第 4.2、10.4 节）**

- 委托票据与对话委托只有一个来源：同步管理（`src/editor/sync/syncManager.ts` 的 `cloudIdentityOf`）在页面接上共享项目时注入，两样都在页面自己到文档服务的那条连接上要（`auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`）；回本机空间、离开项目时撤掉。在线页面与桌面版同一条路。票据不缓存、不进日志。
- 界面分支留的两个全局回退口子（`globalThis.__pcCloudIdentity`、`globalThis.__pcCloudAgent`）与可注入来源 `setCloudAgentSource` 已删；守门单测 CAU-ID-02（`src/ai/cloud/cloud-chat.test.mjs`）：页面源码里不出现这三个名字，设了那两个全局变量也不起作用。
- 文档服务拒签时页面不发请求（不带对话委托发出去只会换回 `bad-grant`）：`service-disabled` 显示「项目创建者已关闭云端 Agent。」，连接断着显示连不上，其余按身份验证没过。单测 CAU-API-02。
- `end` 事件带 `reason: 'stopped'` 才算主人停掉；界面分支「靠先前一条『已停止』状态判」的旁路已去掉。

**地址与开关（第 9.5、10.4 节）**

- Agent 服务的地址与开关只取成员列表顶层的 `hosted.agent { available, enabled, url }` 与通知 `hosted-service-changed`。在线页面在成员列表到达之前先按同源的 `/agent/v1`、开着算；到了以它为准：地址用下发的 `url`（托管端没配 `PROMPTCUT_AGENT_PUBLIC_URL` 时仍是同源的那个），`available` 为假时 AI 栏说明「这个项目所在的托管端没有云端 Agent 服务。」。
- 项目设置里的开关是 `HostedServiceRows` 的 `agent` 一行（`hostedServices.ts` 的 `HOSTED_SERVICE_ROWS`、`HOSTED_SERVICE_TEXT`），排在「托管方的渲染节点」之后；每种服务的确认弹窗各有一句话（`confirm`）。创建者改完后自己这一页的 AI 栏马上跟着变（通知只发给别的连接）。
- 创建者把开关关了又打开：页面重取一次 `info`、清掉「已关闭」的提示、把停下的事件流接回去。

**署名与成员列表（第 5 节）**

- 显示名在 `src/editor/sync/labels.ts` 的 `writerLabel`：`role: 'agent'` 且 `service: 'agent'` → 「〈成员名〉的云端 Agent」（`hostedServices.ts` 的 `cloudAgentLabel`）；发起的那台设备上自己看到「你的云端 Agent」。写入身份里没有用户名，成员名取 `userId`（`用户名@设备`）里最后一个 `@` 之前的部分，所以发起成员不在线时也有名字。
- 第 5 节「同一位成员开了多个云端对话时在后面加『· 第几个对话』」**没有做**：云端对话的 id 是字符串，连接上的 `conversation` 是连接序号，界面拿不到「第几个」。
- 成员列表：成员行里带 `service: 'agent'` 的连接显示成一个「[云端 Agent]」标记，展开的子行是「〈成员名〉的云端 Agent」；本机 Agent 的计数不含它。成员本人不在线、只有他的云端 Agent 连着时，这一行仍在（计入成员数）。
- AI 栏顶上「别的成员那边的 Agent 正在改」那一行（`RemoteAgentsStrip`）：来源是云端 Agent 时写「〈成员名〉的云端 Agent正在改:…」。

**撤销（第 7.4 节）**

- 探针验过：页面在这些事件发生时不在线，重开后经 `events.list` 取得回完成事件里的逆操作（文档服务在内存里按项目留最近 500 条，重启后从新的事件开始）；「撤销这步」与本机 Agent 相同，由页面以自己的身份提交。文档服务重启过的话，重启之前的云端改动在界面上没有「撤销这步」。

**没有做的**

- 对话重命名与删除（`PATCH`、`DELETE /v1/conversations/<id>`）、用量查询（`GET /v1/usage`）的界面入口：这一版不做，接口在。
- 桌面版 rail 页签图标上的「云端对话进行中」标记：做成了面板顶上的提示条。

**探针发现、待定的两处（服务端，这一轮没有改）**

- **写入之间隔得比补渲的防抖（3 秒）长时，补渲有时会失败**：**已修**（2026-10-06，第 16.4 节）。原来的现象：Agent 服务每写一次就发一个指着当时版本的清单计划；项目接着往前走，渲染节点取不到旧版本的项目快照，计划与细任务以「文档服务上没有项目快照」失败，新计划经同一个细任务跟着失败。修法是「取不到旧版本就按当前版本核对，内容没变照做、已被取代的作废」，没有靠拉长防抖或加重试。步骤 `spaced` 改成两个体验探针缺省都跑的一步。
- **成员列表与目录里的「有没有成员在线」含会话的保留期**：`server/docservice/modules/hosted.mjs` 文件头写 `members` 「不含保持期」，实际按模块的连接进出计数，传输断开后会话保留 60 秒（`session.mjs` 的 `RETAIN_MS`）期间仍算在线。发起方被结束后约 60 秒，成员列表里才不再显示他「编辑中」，渲染服务的目录里 `members` 才变假。

---

## 22. 用户 2026-10-07 的决定与落实（分支 `claude/cloud-agent`）

用户看了界面块报告里的「任务书没列的用户可见行为」16 条后做了决定。上文与本节冲突时以本节为准；语义文档里逐处标「〔用户 2026-10-07 定〕」。

### 22.1 决定与落实

| 清单号 | 决定 | 落在哪 |
|---|---|---|
| 22 | 成员列表分开计数：「成员：N 人 · Agent：M 个」。人数只算真人在线的；本机 Agent 与云端 Agent 都算进 Agent 数；本人不在线、只有他的云端 Agent 在跑时，他那一行照常显示并标「离线，Agent 在跑」，不计入人数、计入 Agent 数；渲染节点那一行不计入任何一个数 | `src/editor/sync/hostedServices.ts`（`memberCounts`、`memberCountLabel`、`isCloudAgentOnly`）、`MembersPanel.tsx`；单测 CAU-MEM-01、02；探针 O7、D6 |
| 6 | 云端模式下「诊断报告」要能用，不置灰不隐藏；内容是这段云端对话的过程、出错原因、客户端与版本信息，不含任何凭证；「一键配特效」置灰并在悬停写原因 | `src/ai/cloud/report.ts`（纯函数，三道脱敏）、`CloudAiPanel.tsx`、`ReportDialog.tsx`（在线构建里「保存为文件」是浏览器下载）、`Composer.tsx`；单测 CAU-DIAG-01～03；探针 O9、D9；守门 C10A-API-07 加 `/api/ai/diagnostics`。在线页面不请求 `/api/*`：报告在页面里生成，保存是 Blob 下载，提交走与桌面相同的收报告地址（`VITE_DIAG_SUBMIT_URL`，没配时置灰并说明），不经编辑器进程；桌面版保存与提交沿用现有通道 |
| 16 | 空对话的示例句清空，本机与云端都只留「为我快速创建一个视频告诉我软件都可以做什么。」；云端第一版用这一句要能只靠内置卡做出一支短片 | `MessageList.tsx` 的 `EMPTY_EXAMPLE`；单测 CAU-EMPTY-01；探针 O8、D11；首支短片探针 `scripts/probes/cloud-agent-first-video-probe.mjs`（缺省冒烟，真实模型留给新节点录入 Key 之后）；工具与提示词的缺口见 22.3 |
| 19 | 只在创建者关闭「云端 Agent」开关时给别的成员气泡，打开时不提示（渲染节点开关的气泡保持现状）〔用户 2026-10-07 推翻:两个开关同一个规矩:只在关闭时给别的成员气泡,打开时不提示,见 23.4〕 | `hostedServices.ts` 的 `HOSTED_SERVICE_TEXT.agent.changed`；单测 CAU-SW-01；探针 O10 |
| 9 | 这一版不加云端对话的删除与重命名入口 | `TODO.md` 记一条；接口（`PATCH`、`DELETE /v1/conversations/<id>`、`GET /v1/usage`）已有 |
| 10 | 保留面板顶上的提示条「云端有一个对话正在进行」 | 本文 7.4 与 9.5 已改成与实现一致 |
| 14 | 保留各类出错文案 | 原文表见 22.2 |
| 其余（1、2、3、4、5、7、8、11、12、13、15、17、18、20、21、23～28）与三处不一致 | 保留现状：多对话署名不加「第几个对话」；被移出的成员自己看不到原因；发起方退出后约 60 秒才不显示在线 | 语义文档里已写明（见 `mechanism/agent.md` 的「成员列表的计数」与 `workflow/production.md` 的「云端对话」） |

### 22.2 出错文案原文表

「出自」：服务端 = `server/` 里写的、经事件流或接口回包到页面；页面 = `src/ai/cloud/` 与 `src/editor/` 里写的。同一场景两边都有话时，页面只在服务端没给说明（`message`）时用自己的；除额度、「文档服务连不上」两种与兜底外，页面对接口错误码一律用自己的措辞。

| 场景 | 文案原文 | 出自 |
|---|---|---|
| 身份验证没通过（401） | 云端 Agent 暂时连不上:身份验证没有通过。请刷新页面或重新进入项目。 | 页面（`cloudApi.ts`） |
| 页面还没取得身份证明 | 云端 Agent 暂时用不了:还没有取得身份证明。 | 页面 |
| 没有权限（403） | 你没有权限使用这个项目的云端 Agent。 | 页面 |
| 创建者关了开关（发消息被拒、AI 栏顶上的说明） | 项目创建者已关闭云端 Agent。 | 页面与服务端同一句 |
| 这个托管端没有 Agent 服务 | 这个项目所在的托管端没有云端 Agent 服务。 | 页面 |
| 节点、项目或成员并发满了 | 云端 Agent 正忙,请稍后再试。 | 页面与服务端同一句 |
| 同一个主人同时开了太多事件流（429 `busy`） | 页面显示上一行；服务端原话：同时打开的对话窗口太多,请关掉几个再试。 | 页面（服务端原话页面不用） |
| 对话里还有一轮在跑时又发消息 | 这个对话还有一轮在进行,等它结束或先停止。 | 页面（服务端原话：这个对话还有一轮在进行。） |
| 额度用尽（发消息被拒或一轮中途） | 这个项目的云端 Agent 额度已用完(已用 X / 上限 Y)。请联系托管方。 | 服务端（页面兜底：这个项目的云端 Agent 额度已用完。） |
| 托管方没配模型 | 云端 Agent 还没有配置模型,请联系托管方。 | 页面（服务端原话：托管方还没有为云端 Agent 配置模型。） |
| 消息太长、或对话记录已太长（`too-large`） | 消息太长了,云端 Agent 收不下。请缩短后再发。 | 页面（服务端原话：对话记录太长时是「这个对话的记录已经太长,请新开一个对话。」，请求体超限时是「请求体超过 256 KiB」；页面两种都显示这一句，见 22.4） |
| 对话委托不对或过期（`bad-grant`） | 这次对话的授权已失效,请重新发送。 | 页面 |
| 文档服务暂时连不上（发消息时） | 云端 Agent 暂时连不上文档服务,请稍后再试。 | 服务端（页面兜底同句；服务端另有：文档服务暂时连不上,请稍后再试。／这个项目的云端 Agent 还没接上文档服务,请稍后再试。／云端 Agent 连不上这个项目的文档服务:〈原因〉） |
| 页面连不上 Agent 服务（断网） | 连不上云端 Agent 服务,请检查网络。 | 页面 |
| 别的错误码 | 云端 Agent 出错了(〈错误码〉)。 | 页面 |
| 事件流断了（AI 栏顶上的提示条） | 和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。 | 页面 |
| 对话记录里：被撤销（按原因） | 项目创建者已关闭云端 Agent,这一轮已停下。已经落地的改动保留在项目里。／你已被移出这个项目,云端 Agent 的这一轮已停下。已经落地的改动保留在项目里。／你已被请出这个项目,云端 Agent 的这一轮已停下。已经落地的改动保留在项目里。／项目已删除,云端 Agent 的这一轮已停下。／这一轮的授权已过期,已停下。已经落地的改动保留在项目里;再发一条消息即可继续。／项目的成员名单或口令改过,这一轮的授权已失效,已停下。已经落地的改动保留在项目里;再发一条消息即可继续。／这一轮的授权没有被文档服务接受,已停下。已经落地的改动保留在项目里;再发一条消息即可继续。 | 服务端（页面兜底：云端 Agent 的这段对话已失效(开关被关、你被移出项目或项目已删除)。已经落地的改动保留在项目里。） |
| 对话记录里：服务重启中断 | 云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。 | 服务端；服务端把对话丢了而页面还有没收尾的一轮时，页面也用这一句 |
| 对话记录里：模型调用失败 | 模型调用失败:〈接口给的原因,已去掉 Key〉 | 服务端（页面兜底：模型调用失败。） |
| 对话记录里：到轮数上限 | 这一轮到了 24 次模型往返的上限,已停下。已经落地的改动保留在项目里,可以接着说。 | 服务端（数字是配置的上限；页面兜底：这一轮达到了轮数或时间上限,已停下。已经落地的改动保留在项目里。） |
| 对话记录里：到时间上限 | 这一轮超过了 30 分钟的上限,已停下。已经落地的改动保留在项目里。 | 服务端 |
| 对话记录里：项目太大 | 项目太大,云端 Agent 暂不支持这个项目。请在电脑上的 PromptCut 里使用。 | 服务端 |
| 工具不在开放清单里（模型看到，据此告诉用户） | 云端暂不支持 〈工具名〉:〈原因〉。请告诉用户在电脑上的 PromptCut 里使用,不要找替代办法。 | 服务端 |
| 读页面状态时发起方不在线（模型看到） | 发起方不在线,读不到页面的选区。请按项目内容继续,不要等待。 | 服务端 |
| 补渲进展（对话里一行状态） | 已把 N 个片段交给云端渲染／云端渲染中:x/y／云端渲染完成／云端渲染失败:〈原因〉／云端渲染暂不可用,画面会在渲染节点恢复后补上 | 页面（`events.ts` 的 `renderStatusText`） |
| 补渲失败的原因（跟在「云端渲染失败:」后） | 渲染节点 10 分钟没有进展／渲染节点报告失败:〈原因〉／渲染节点没有接下这个计划:〈原因〉／渲染节点上一次没有做成这一版,稍后由进入项目的页面重发 | 服务端 |

### 22.3 首支短片：云端开放的工具与系统提示词够不够（静态核对，2026-10-07）

从空项目（两条空序列、没有素材）做出一支只用内置卡的短片，要用到：`get_project`（读全貌）、`list_cards`（先摘要、再带 `cardId` 取参数；云端改在服务端注册表上答，只有内置卡）、`add_clip`（`cardId`、`start`、`duration`、`params`、`trackId`）、`update_clip`、`set_project_meta`（时长）、`add_transition`、`add_track`、`set_theme`、`report_progress`。**这些全在开放清单里**（开放 66 个）。探针冒烟（模拟模型，只用其中四个）8 项全过；另把 42 个内置卡 id 逐个用缺省参数 `add_clip`，40 个成功，两个没成功：`particles-*` 是 `capabilities.json` 里的通配键、不是卡；`caption-track` 要必填的 `lines`。云端没有因工具不开放而做不成的地方。

提示词（`server/ai-system-prompt.md` 加 `CLOUD_SYSTEM_NOTE`）的缺口，供主会话决定要不要补一句：
1. 底座提示词在多处**要求看画面**（`see_frames`：「先确认真实画面情况再动手」「放完再用返回里的 `look` 看一眼」），云端没有这个工具；`CLOUD_SYSTEM_NOTE` 只说「用户要这些时直接告诉他云端暂不支持」，没说「提示词里要求看画面的步骤一律跳过」。模型有可能因此停下报告「看不了画面」，而不是继续排卡。
2. 底座提示词有「**素材库里没有用户要的画面,就自己去找**」「做个宣传片就去采集」一段，空项目加「快速创建一个视频」正好撞上；`CLOUD_SYSTEM_NOTE` 没有明说「素材库是空的也不要找素材,用内置卡做」。
3. 没有明说「只能用内置卡」：只说不支持新建或修改卡片代码；底座提示词里「建新卡是最后手段」那一段仍在，工具虽不交给模型，模型可能在文字里提议建卡。建议补一句「`list_cards` 列出的卡就是全部可用的卡,没有合适的就用最接近的卡调参数」。
4. `add_clip`、`update_clip` 的返回里带 `look`（让模型去调 `see_frames`），云端用不上，属于噪音，不影响做成。
5. 摘要里没有标出哪些内置卡需要素材（如口播视频、图片参数）；空项目里模型若选了它们，`add_clip` 能加上（缺省参数），但画面会是空的。

这些都是提示词措辞，不是缺工具；按任务书这一轮不动 `server/`，列在这里交主会话。

### 22.4 实现时发现、任务书与清单都没列的用户可见行为

- 顶栏计数里「Agent：M 个」一直显示（M 为 0 时写「Agent：0 个」）。
- 「离线，Agent 在跑」按成员行里是否只剩云端 Agent 的连接判：成员的页面断开后文档服务把会话留 60 秒，所以发起方关掉软件约 60 秒后才改标；云端 Agent 的实例在一轮说完后还连着、直到闲置回收（10 分钟），所以一轮说完后这个标记最多还会挂 10 分钟，这时写「Agent 在跑」并不准确。要精确得让连接项带上「这一轮是否在跑」，需要改文档服务与 Agent 服务，这一轮没做。
- 对话是空的时「诊断报告」置灰（没有内容可导，与本机相同）；有了对话就可用。
- `too-large` 页面一律显示「消息太长了…」，服务端对「对话记录太长，请新开一个对话」另有一句话，页面没用（见 22.2）。

---

## 23. 用户 2026-10-07 的更正与补充（任务书 F、J、K 与完成条件第 8 条）

任务书 `cloud-agent-task.md` 在 2026-10-07 更新了 F、J、K。上文与本节冲突时以本节为准；语义文档里逐处标「〔用户 2026-10-07 定〕」。第 9 节的工具表由另一路（`claude/cloud-agent`）按新范围改，本节不动它。

### 23.1 J：工具范围推翻了「第一版」的限制

- 旧写法「第一版不开放建卡改卡、导入素材、网页采集、配音；看画面不做；云端下不能附文件；示例句只靠内置卡」是会话的建议被误记成用户的决定，**作废**。用户定的是把 Agent 服务搬到云端，所以云端 Agent 的工具与本机 Agent 一致。
- 唯一可以缺省的是要操作发起人自己界面的工具（选区、播放头、播放与暂停、网页接管这类）：发起方不在线时回明确的「发起方不在线」，Agent 据此继续。其余都要能用，包括建卡改卡、导入素材、网页采集、配音、感知类工具、看画面（即时渲染）。确因节点条件做不了的，逐项写明原因与差什么，记未达成，不事先排除——清单在**第 9 节的工具表**（由另一路改完才有，本节不列）。
- 配套要求（任务书 J 原文）：建卡改卡的源码靠第二、三段的隔离保护，不另设限制；工具读写按项目隔离、读写不到别的项目、系统文件、凭证与别的服务的数据目录；能发网络请求的工具不能访问回环地址、内网地址与同机别的服务的接口；配音等要花钱的调用用托管方的配置、用量并进 G 的用量记录；以上并进隔离验收探针。
- 「深度自主」与「审查环路」在云端保持置灰（U2，用户确认）；附件在云端可用（U5 的前半推翻，用户确认）。
- 语义文档的对应改动：`product/agent.md`「运行位置」的「工具范围」「隔离」「花钱的外部调用」、`workflow/production.md`、`mechanism/agent.md`「云端 Agent」。

### 23.2 F：模型 Key 的加密分发（取代 8.2 的录入办法）

- **流程**：节点报出机器识别码 → 用户在自己的电脑上用 `make-api-share.bat` 把 Key 加密成只有这台节点解得开的密文（明文只经用户自己的手）→ 会话把密文送到节点 → 节点本机解开，按现有的落盘加密保存（`ai.json` 与 `keys/custom.key`，与 `model-config.mjs` 读的位置与格式一致）。会话全程只接触密文，不向用户要明文。
- **机器识别码**（`server/agent-service/machine-id.mjs`，调 `server/runners/machine-id.mjs` 的 `machineCode()`）：Linux 取 `/etc/machine-id`，取不到再取 `/var/lib/dbus/machine-id`，加盐取 SHA-256 的前 100 位，Crockford Base32 分四组；不掺主机名、IP、用户名。云节点是 Ubuntu 22.04 虚拟机（systemd），`/etc/machine-id` 首次启动生成、重启不变，所以换账号、改主机名、改 IP 都不变；**重装系统、或克隆镜像后重新生成 machine-id 才会变**（落盘加密用的是同一个指纹，所以变了之后原来存的 Key 也解不开，要重新导入）。容器里常常没有 `/etc/machine-id`、会退到「主机名 + 网卡」的兜底，每次重建容器就变；节点不是容器，不涉及，兜底时 `machine-id.mjs` 会警告。
- **命令**：节点上 `node server/agent-service/machine-id.mjs [--json]`；`PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/import-key.mjs --file <密文文件> [--service model|voice]`（密文也可以从标准输入给，不能写在命令行上）；本机的 `scripts/remote/docservice.mjs` 加 `machine-id-agent` 与 `import-key-agent --file <密文文件> [--service …]`（都收 `--dry-run`；密文经 ssh 标准输入送到节点数据目录的 `tmp/`，导入完删掉）。输出只有厂商、模型清单与 Key 末四位。
- **报错**：不是密文、格式不对、被截断、头部异常、已过期、厂商不对、没写模型、数据目录不可用，各有明确的中文原因；**不是按这台机器的识别码生成的，与密文被改过，在密码学上分不出来（AES-GCM 的校验标签），报同一句**；任何一种都不写任何文件。
- **按服务名导入**：`--service model`（缺省）与 `--service voice`（配音；`config/voice.json` 与 `config/keys/voice.key`，`PCVOC1.` 封装，与对话 Key 是两把）。读出用 `server/agent-service/service-keys.mjs` 的 `readServiceKey(dataDir, service)`（配音的另一路要用的就是它）；加别的服务只在服务表里加一项。
- **`set-key.mjs`**：保留 `--mock` 与 `--clear`；交互式录入明文改为仅供本机调试，运行时先写明，正式录入走加密分发。
- **测试**：`server/test/cloud-agent-keys.test.mjs` CAU-KEY-01～09；用 `src/ai/configShare.ts` 的 `encryptConfig`（与 `tools/api-share-gui` 同一份信封的 TypeScript 一端）生成给「节点识别码」的密文，假 Key、临时目录；Rust 一端 `share.rs` 里那条 JS 生成的基准密文在节点这边的 Node 解密里同样解得开（CAU-KEY-02）。
- 给用户的步骤原文在 `server/hosted/deploy/README.md`「模型 Key 的加密分发」一节末尾。

### 23.3 K：诊断报告

- **现状**：本机对话原来就按对话出报告（`src/ai/debug.ts` 的 `conversationReport`，含这段对话的消息、每一步执行事件与环境快照）；云端对话的报告在页面内由 `src/ai/cloud/report.ts` 生成；两处共用 `ReportDialog.tsx`，三个出口：复制、保存为文件、提交。本次补的是：本机报告的脱敏补到与云端同一道底线、两个出口的单测与探针断言。
- **去向一，下载**：在线页面是浏览器本地下载（Blob），桌面版沿用本机写盘并打开所在文件夹，都不经在线页面对 `/api/*` 的请求。
- **去向二，提交**：`reportSubmit.ts` 的 `submitReport`，页面直接对收集端地址（构建期变量 `VITE_DIAG_SUBMIT_URL`，令牌 `VITE_DIAG_SUBMIT_TOKEN`）发跨源 POST，`Content-Type: text/plain`（CORS 简单请求，无预检）；收集端 `tools/report-worker/worker.js` 的响应（成功与出错）本来就带 `Access-Control-Allow-Origin: *`，所以**收集端不用改、不用重新部署**。没配地址时按钮置灰并说明原因（保持）。取回用 `report-inbox.bat`。在线构建怎么带这两个变量，见 `server/hosted/deploy/README.md`「在线页面的诊断报告」（只写变量名）。
- **内容与脱敏**：这段对话的过程、出错原因、客户端与版本信息；不含票据、委托、模型 Key 与提交令牌。`redactDebug` 补了 `v1.<段>.<段>` 票据形状、`AIza`/`xai-`/`gsk_` 形状的 Key、键名 ticket/delegation/grant，本机报告与云端报告同一道底线；单测 CAU-DIAG-04/04b/05/06/06b。
- **探针**：`cloud-agent-ui-probe.mjs` 起假收集端（跑仓库里真的 `worker.js`，内存 KV、假令牌；`startStack` 加 `buildEnv` 把地址与令牌编进在线构建与桌面编辑器）；O9(K) 断言下载得到文件、内容就是对话框里的报告，提交后收集端存下的就是这份报告且不含凭证与提交令牌；D9(K) 桌面版同样。

### 23.4 两个开关的气泡

「托管方的渲染节点」与「云端 Agent」同一个规矩：只在创建者**关闭**时给别的成员气泡，打开时不提示（推翻 22.1 第 19 项括号里「渲染节点开关的气泡保持现状」）。创建者自己页面上的确认弹窗不动。`hostedServices.ts` 的 `HOSTED_SERVICE_TEXT.render.changed(true)` 改为空串；单测 CAU-SW-01。探针搭法里没有登记渲染节点、开不了它的开关，渲染节点这一条由单测守，云端 Agent 那一条的真实浏览器断言仍是 O10。

### 23.5 仍保持现状的四条用户可见行为

空对话时「诊断报告」置灰；消息太长时页面一律显示「消息太长了…」；创建者自己页面上改开关后的确认气泡；顶栏「Agent：0 个」一直显示。

---

## 24. 工具范围改成与本机一致的实现记录（2026-10-07，分支 `claude/cloud-agent`）

用户 2026-10-07 更正任务书 J 之后的返工。上文与本节冲突时以本节为准；第 9 节已按新范围整节重写。

**做成的**

- 工具表逐个归类（第 9.1、9.2 节）：128 个里 88 个交给模型（在副本上执行 67、服务端另有实现 7、就地执行 6、要操作发起人界面 8），40 个记「这一版还没接上」并逐项写明差什么。
- 按「项目 × 对话」隔离的工作区（第 9.5 节）、出网闸（第 9.6 节）、代成员的素材写入（第 4.4、9.4 节）、建卡改卡经内容库且不在服务进程里执行卡片代码（第 9.3 节）、配音用托管方的配置并记用量（第 9.4 节；用量流水多一类 `kind: 'service'`，不占 token 额度，`GET /v1/usage` 多回 `services`）、附件（第 9.4 节）、系统提示词（第 9.7 节）。
- 「这一轮在不在跑」：有一轮在跑时，Agent 服务经实例自己的那条连接在在场状态里挂 `presence.set { key: 'cloud-run', ttlMs: 90000, data: { v: 1, kind: 'cloud-run', runs } }`，每 30 秒续一次，最后一轮结束时撤掉；页面据它标「离线，Agent 在跑」并计入 Agent 数，闲置的连接不标、不计。
- 多 Agent 的公告板四个工具（`declare_scope`、`list_agents`、`send_message`、`check_messages`）在云端可用：同一位成员的几个云端对话、以及经在场状态与别的成员那边的 Agent，都看得到彼此的范围与消息。

**对外接口与鉴权消息的改动**

| 改动 | 在哪 |
|---|---|
| 新接口 `POST /v1/conversations/<id>/attachments?name=`（请求体是文件字节）；`POST …/messages` 的请求体多一个可选的 `attachments: [{ url }]` | `server/agent-service/http.mjs` |
| `GET /healthz` 多回 `egressTestAllow`；`GET /v1/usage` 多回 `services` | 同上 |
| 环境变量 `PROMPTCUT_AGENT_ASSET_URL`（同机素材服务的回环地址，格式不对 `config.error asset-url`）、`PROMPTCUT_AGENT_EGRESS_TEST_ALLOW`（只给探针） | `server/agent-service/main.mjs` |
| `SERVICE_ALLOW.agent` 加 `content.get`、`content.list`、`content.put`（只许 `card-source`）与 `auth.ticket`（只许素材票据）；`AGENT_WRITE_TYPES` 加 `content.put` | `server/docservice/service-gate.mjs` |
| 文档服务给云端 Agent 的连接签代成员的素材票据（`k: 'asset'`，`u` 是成员，带 `sv: 'agent'`、`sk`、`cr`） | `server/docservice/modules/shared.mjs` |
| 素材服务对 `sv: 'agent'` 的票据从「只读」改成「按成员本人的权限、只许写 `media`」；核对结果多一个 `actsFor: 'member'` | `server/auth/asset-tickets.mjs`、`server/asset-service.ts` |
| 工具结果的三种新形状：`{ ok: false, cloudUnavailable: true, error }`（原 `cloudUnsupported` 不再有）、`{ ok: false, initiatorOffline: true, error }`（八个工具都会回，原来只有 `get_selection`）、`{ ok: false, initiatorOnly: true, error }` | `server/agent/service/cloud-tools.mjs` |

**没有做成的（记未达成，原因与差什么）**

1. ~~看画面（即时渲染）：`see_frames`、`get_gif`、`bake_card`、`inspect_card_dom`、`get_layout` 的实体框~~——已做成（2026-10-07，第 25 节）。仍差的只有 `see_frames` 的素材镜头拼图（要镜头识别）。
2. 感知类工具（语音识别、镜头、追踪、主体）、`auto_workflow`、`background_job_status`、`attach_clip_motion`——差节点上的 Python 环境与模型权重，以及把页面里的作业表搬到服务端。
3. ~~音效合成与卡片声音生成、`measure_audio`~~——已做成（2026-10-07，第 26 节）。仍差的只有 `measure_audio_js`（要渲染服务一侧开一个跑脚本的口子）。
4. ~~网页采集（七个）~~——已做成（2026-10-07，第 27 节；链路用下载器替身验通，真的 yt-dlp 留到节点上验）。网页接管（七个）仍差节点上的浏览器，并让它只经出网闸的代理出网、按对话隔离用户数据目录。
5. 发起方在线时反过来操作他的页面（`seek`、`play`、`pause`、`web_handoff`、`collect_login`、`collect_login_check`、`spawn_agent`）——差云端到页面的反向通道；现在在线时回 `initiatorOnly`，不在线时回「发起方不在线」。
6. 导入的素材没有小尺寸一档；节点上没有 ffprobe 时音视频（WAV 除外）不带时长与宽高。
7. 子进程用独立的非特权用户跑——只写进了部署说明的要求，代码里没有子进程在用（上面第 2～4 项接上时才用得到）。

**残余面（照实写）**

- 素材按哈希读（既有口径）：任何持有素材票据的成员知道别的项目某块素材的哈希就读得到；云端 Agent 与成员本人同一个口径。云端 Agent 的工具列举不了别的项目的素材，也不接受裸的哈希与同机素材服务的地址。
- 出网闸只管 Agent 服务进程自己发的请求与经它代理的请求；以后接上的子进程若自己解析、自己连（不走代理），要靠部署时的系统级限制兜底。
- 文档服务的内容库按空间分；托管端每个项目一个空间，所以卡片源码按项目隔离。本机档（一个空间里多个项目）不在云端 Agent 的范围里。

### 24.1 真实模型的本机演练（2026-10-07，完成条件第 8 条）

起法：Agent 服务设 `PROMPTCUT_AGENT_REHEARSAL_DESKTOP_MODEL=1`，模型配置改读这台电脑上桌面版已配好的 API 直连（`server/agent-service/rehearsal-model.mjs`：只读 `ai.json` 与 `keys/custom.key`，Key 在进程内解开、只留内存；日志里只有厂商与模型名）。云节点上不设它。模型 `gemini-3.8-flash`（OpenAI 格式的网关），其余全是本机隔离的真进程（托管组合、渲染服务、Agent 服务）。

| 演练 | 命令 | 结果 | 模型往返 | token（输入 / 输出） |
|---|---|---|---|---|
| 示例句「为我快速创建一个视频告诉我软件都可以做什么。」对空项目 | `cloud-agent-first-video-probe.mjs --real-model` | 8 项全过。一轮 23 秒做出 5 段、20 秒的短片：底轨一条粒子背景（0～20 秒），上面依次是模糊浮现的开场、逐项打勾的能力清单、数据实证、行动号召；时间轴连续，项目时长改成 20 秒。用到的工具：`declare_scope` 1、`get_project` 1、`list_cards` 7、`add_clip` 5、`set_project_meta` 1、`report_progress` 1。没有建卡、没有导入素材，也没有碰到「还用不了」的工具 | 4 | 214553 / 1897 |
| 完成条件第 6 条与「用户体验验收」（进程版） | `cloud-agent-ux-probe.mjs --real-model` | R1～R8 全过：一句自然语言交代三处改动（改文案、调卡片参数、挪片段）→ 发起方进程被结束 → 云端 18～22 秒做完 → 重卡渲出来（约 52～56 秒）→ 后来的成员读到三处改动、署名是创建者本人加 `service: agent` → 重开找得回对话 → 撤销最后一次写入 → 两位成员同时各开一个对话，各改各的都落地、互不串 | 15 | 573875 / 1752 |
| 同上（界面版，在线浏览器发起） | `cloud-agent-ux-ui-probe.mjs --real-model` | RA1～RA7 全过：发起方的浏览器进程被结束后云端做完、渲出来；另一位成员的页面看到改动、「Agent 操作记录」署名「alice的云端 Agent」、舞台上两张重卡贴着快照；创建者重开从历史里找回对话；「撤销这步」两边都看到 | 4 | 153427 / 518 |

进程版第一次跑有两条探针自己的断言写错了（把盘上并过段的回复与补发时拆开的增量比条数；把「写入因对方刚改过而被要求重读」时工具结果里提到对方改的片段当成对话串了），分析后改了断言重跑一次通过；那一次用掉 14 次往返、534308 / 1999 token。四次合计 37 次往返，输入约 147.6 万、输出约 0.6 万 token。

看到的事实：

- 每次模型往返的输入约 3.8 万～5.4 万 token：系统提示词加 88 个工具的说明占了大头，与任务大小无关。
- 模型没有因为看不了画面而停下（系统提示词里那一段起了作用），也没有去找素材。
- 真实模型的一轮只有二十来秒，短于文档服务保留断掉会话的 60 秒，所以「写入落在没有任何成员连接之后」只在模拟模型的跑法里断言。
- 出错留原因（模型失败、额度、撤销、渲染失败）只在模拟模型的跑法里验，真实模型下没有去造这些错。
- 桌面版发起的界面版（`--real-how desktop`）没有用真实模型跑。

### 24.2 用户卡的补渲（2026-10-07）

- `cloud-agent-ux-probe.mjs` 加一步 `usercard`（U20）：云端 Agent 用 `create_card` 建一张判重的用户卡（`frameMode: stateful`，夹具是 `scripts/probes/fixtures/render-isolation/overreach-marker-jia.tsx`）并用它 `add_clip`，发起方的进程被结束、全程没有成员连接。结果：卡片源码在项目的内容库里；补渲计划由渲染服务的**隔离工作进程**（`hosted-render-iso:` 节点）认领并渲完，常驻工作进程对这个项目一个任务也没认领（搁着、报有卡片代码）；从发出到渲完约 27 秒；之后才上线的成员不发任何渲染任务，取到的层表里有这张用户卡的那一层、块在素材服务里。
- 这一步头两次没过，原因不在 Agent 一侧：渲染服务的内存看护在 Windows 上把隔离工作进程量成超限、起来 4 秒就结束它（`reason: oom`）。合入 `claude/render-service` 的 `497fbd52`（内存看护的量法修复）之后通过。
- 「连续没有进度就放弃」的时限：项目的内容库里有卡片源码时从 10 分钟放长到 30 分钟（`render-request.mjs` 的 `userCardStallMs`；隔离工作进程同时只渲一个项目、多个项目在等时每个最多 5 分钟一换），放弃时写进对话记录的原因是「渲染节点 30 分钟没有进展(带用户卡的项目要排队渲)」。进程重启后重发的计划不知道项目带不带用户卡，一律按 30 分钟等。
- 界面版（`cloud-agent-ux-ui-probe.mjs`）没有加这一步：「后来的成员在浏览器里贴得上这张用户卡的快照」没有在真实浏览器里断言。

### 24.3 看画面：这一轮没有做成（2026-10-07）

〔同日稍后做成：见第 25 节。下面是当时查到的现状，留作记录；其中「工作进程的端口不对别的进程开放」不准确——页面请求闸只拦浏览器形状的请求，Node 一侧的请求原来是放行的，这次给看画面的那批接口另加了口令。〕

`see_frames`、`get_gif`、`bake_card`、`inspect_card_dom` 与 `get_layout` 的实体框仍归在「这一版还没接上」。查到的现状与差的东西：

- 渲染服务的工作进程里有一份预渲染用的 Vite，本机 Agent 看画面用的那几条接口（`/api/vision/snapshot`、`/api/vision/bake`、`/api/cards/dom`、`/api/cards/layout`、`/api/ai/visual`）就在它上面；但工作进程的页面请求闸（`server/hosted-render/page-gate.mjs`）只放行渲染页自己要用的那一条，别的 `/api/**` 一律 403，工作进程的端口也不对别的进程开放。
- 要做成需要：① 渲染服务的管理进程加一个只绑回环的内部口子，凭 Agent 服务的服务身份（或管理进程发的一次性口令）认调用方；② 管理进程把请求转给工作进程，并在页面请求闸上为这一路单开放行（只认管理进程转来的）；③ 有卡片源码的项目必须走隔离工作进程——它同时只渲一个项目、按项目起停、冷启动约 10 秒，「要一帧」得排进它的轮转里，不能让常驻工作进程去装卡；④ 取素材要的票据由渲染服务按项目取（现有的目录与票据那一套）；⑤ 并发与内存上限并进渲染服务现有的看护；⑥ Agent 服务一侧把 `prerenderPost` 指到这个口子，把四个工具与 `get_layout` 的实体框挪出「还没接上」，图片交给模型。
- 没有做的原因：这要动渲染服务的隔离边界（页面请求闸、隔离工作进程的轮转），第三段刚在这上面收口；这一轮余下的时间不够把它做稳并补上隔离探针，所以没有动 `server/hosted-render/`，记未达成。

---

## 25. 看画面的实现记录（2026-10-07，分支 `claude/cloud-agent`）

任务书 J〔2026-10-07 更正〕要求云端 Agent 的工具与本机一致，包括看画面。第 24 节那一轮没做成，这一节是补做的记录。上文与本节冲突时以本节为准；第 9.1、9.2、9.7、9.8、9.9 节已按实现改过。渲染服务一侧写在 `hosted-render-contract.md` 第 8a 节与它的实现记录里。

### 25.1 方案与理由

- **画面由同机的渲染服务出，Agent 服务只是来要。** Agent 服务进程持服务私钥，不执行卡片代码、不起浏览器（第 4.3、9.3 节的裁定不变）；渲染服务已有无头浏览器、预渲染管线、页面请求闸、出口限制与按项目的隔离工作进程。复用它，卡片代码在「看画面」时能做的事与预渲染时完全相同，不多出一个要另外设防的执行环境。
- **口子在渲染服务的管理进程上**（`POST /look`，只绑回环，与诊断口、代理口同一个监听）。管理进程不执行卡片代码，它只核对身份、定路由、转发。
- **认身份用 Agent 服务的服务私钥签名**，渲染服务按服务登记表（只有公钥）核对〔裁，二级：决定「谁能让渲染服务出图」〕。不改文档服务的任何接口与白名单；不把成员的委托交给渲染服务；撤钥跟着登记表走。
- **项目内容随请求带来**（Agent 服务此刻的项目副本），不是让渲染服务按版本号去文档服务取：副本里已经有这一轮刚落地的改动，「这一版」没有歧义；渲染服务也不必为了一帧去开一条读项目的连接。
- **带卡片源码的项目只由隔离工作进程出图。** 请求里带着这个项目卡片源码的「键 → 版本」，渲染服务等隔离工作进程这一轮正是这个项目、这几份卡装到了这个版本才转给它。常驻工作进程照旧不装任何项目带来的卡。
- **看画面优先于预渲染任务**，但不打断已经在做的任务：同一时刻只转发一个看画面的请求，在途时让出一个并发名额；理由是模型的一轮正等着这一帧。排队、背压、时限都回明确的「这次没看成」，不挂住一轮。
- **Agent 服务一侧不另写一套工具**：给 `agent-exec.mjs` 一个与桌面版同形状的 `prerenderPost`（桌面版问本机的预渲染进程，云端问渲染服务），`see_frames`、`get_gif`、`bake_card`、`inspect_card_dom` 与 `get_layout` 的实体框用的是同一份实现。

### 25.2 各工具做到哪一步

| 工具 | 状态 | 说明 |
|---|---|---|
| `see_frames`（时间轴） | 接上 | 单个时刻、多个时刻（`times`）、只看一个片段（`clipId`）都走同一条；图片交给模型 |
| `get_layout` 的实体框 | 接上 | 没量成（渲染服务忙、关着）时照旧回规定的框，`contentBox` 是 null 并带原因 |
| `inspect_card_dom` | 接上 | — |
| `bake_card` | 接上 | 贴图先进渲染工作进程自己的素材库，再推到项目的素材服务（`px`，渲染服务的身份）；成员凭自己的素材票据取得到 |
| `get_gif` | 接上一半 | 4×2 的拼图交给了模型；**动图用户看不到**——它存在渲染服务工作进程的数据目录里，在线页面取不到（带用户卡的项目那个目录每一轮还会清空）。结果里不带动图地址，说明里照实写。差：把动图推进素材服务，并让在线页面的工具结果能按素材地址显示它 |
| `see_frames` 的素材镜头拼图（`source: "media"`） | 没接上 | 要节点上的镜头识别（Python 环境与模型权重，同第 24 节「没有做成的」第 2 项）；调用回明确的原因 |
| 聊天栏里「看得见的工具结果」（`visualId`：看过的画面、改片段的前后对比） | 没接上 | 记录存在渲染服务的工作进程里，在线页面取不到。云端的工具结果不带 `visualId`。差：记录与图片改存素材服务（或 Agent 服务的对话目录），在线页面的 `ToolVisual` 按那个地址取 |

### 25.3 对外接口、配置与行为的改动

| 改动 | 在哪 |
|---|---|
| 渲染服务管理进程新增 `POST /look`（回环）；状态口多 `look`、`isolation.lastQueue`；节点计数多 `plans` | `server/hosted-render/look.mjs`、`broker.mjs`、`main.mjs`、`server/render-node/host.mjs` |
| 渲染服务新配置 `PROMPTCUT_RENDER_LOOK`（`on` / `off`，缺省 `on`）、`PROMPTCUT_RENDER_LOOK_SERVICES`（登记表路径） | `server/hosted-render/main.mjs`；PM2 模板与 `deploy.mjs` |
| 托管方工作进程里看画面的那批接口，Node 一侧的请求也要带这个工作进程自己的口令（原来不带任何凭证就放行） | `server/hosted-render/vite-gate.mjs` |
| 隔离工作进程：要看画面的项目没有任务也算候选并排最前；有人等着看画面时当前一轮最多再做 45 秒就轮换 | `server/hosted-render/isolation.mjs` |
| 托管方工作进程（代理模式）登记卡片快照的远程素材服务（`bake_card` 的贴图推到项目的素材服务） | `server/vite-plugin-frames.ts` 的 `startHostNode` |
| Agent 服务新配置 `PROMPTCUT_AGENT_LOOK_URL`（不是回环上的 http 地址：`config.error look-url`）；`/healthz` 多回 `look` | `server/agent-service/main.mjs`、`http.mjs`、`look-client.mjs` |
| 工具表：`see_frames`、`get_gif`、`bake_card`、`inspect_card_dom` 从「还没接上」挪到「在副本上执行」并标 `look`；没配口子时不交给模型 | `server/agent/service/cloud-tools.mjs`、`instance.mjs` |
| 系统提示词 `cloudSystemNote({ look })`（`CLOUD_SYSTEM_NOTE` 留作没配口子时的那一段） | 同上 |
| 看画面的工具单次时限 180 秒（`HOSTED_DEFAULTS.lookToolMs`） | `server/agent/service/create-agent-service.mjs` |
| 内容库里卡片源码的版本（`rev`）记进实例的卡片源码表 | `server/agent/service/hosted-tools.mjs` |

语义文档没有改。「谁能让渲染服务出图」「看画面优先于预渲染任务」是这次新定的，分别标了〔裁〕（二级、三级），合入 main 前请用户审。

### 25.4 两处小修

1. **一轮结束后范围声明还挂着。** 云端的一轮结束（说完、模型失败、被停、被撤销）时撤掉这个对话声明的范围（`agent-board.mjs` 的 `clearScope`，`instance.mjs` 在一轮收尾处调并发 `presence.clear`）。原因：云端的对话没有页签可关，范围一直留到实例闲置回收。单测 CA-SCOPE-01。
2. **隔离工作进程的 `completed` 一直是 0。** 计数本身没有错，是看的时机与位置：工作进程每秒向管理进程交一次诊断，任务做完的那一刻读状态口拿到的是上一拍的；这一轮闲置结束后 `isolation.queue` 被清成 null，之后再看就看不到这一轮做了什么；计划任务做完原来不计在任何一项里。改法：节点计数加 `plans`；状态口的 `isolation` 多 `lastQueue`（上一轮结束时的计数）；`cloud-agent-ux-probe` 的 `usercard` 一步等两拍再读（本机复跑：`claimed: 2, completed: 1, plans: 1`）。

### 25.5 验收（本机，Windows，20 核）

- `npx tsc -b --force`：零错误。`npm test`：4697 项、4696 通过、1 跳过、零失败（起点 4686 项；新增 HR38～HR43 六个、CA-LOOK-01～04 四个、CA-SCOPE-01 一个）。
- `cloud-agent-look-probe`（新）：K0～K7 八条全过。像素断言：只用内置卡的项目，`see_frames { t: 0.5 }` 与 `{ t: 1.5 }` 里横移的绿色方块重心在 808 与 1108（应在 810、1110）；把片段截到 1 秒后要 1.5 秒，得到的是这一版的最后一帧（方块在 948，应在 950）。含用户卡的项目：`create_card` 之后 `see_frames` 的画面中心是 (255,0,0)；改参数后是 (0,0,255)；`edit_card` 改源码后是 (0,255,0)；三张都由隔离工作进程出，常驻工作进程对这个项目一帧没出、一个任务没认领。`bake_card` 的贴图成员在项目的素材服务上取得到；只读成员能看、同一轮里的写入照旧被拒；关掉项目的「渲染节点」后回「这次没看成」并照常收尾；桌面版的看画面照常（K7）。
- `hosted-render-isolation-probe`：49 条全过（原 37 条，新增 L 组 12 条：越权探测卡经 `/look` 渲一帧，同样读不到别的项目的内容与卡片源码、节点上的假凭证、工作进程的本机接口（含看画面的那两条）、管理进程与同机各服务、元数据地址、工作目录以外的文件，收集站 0；口子认身份；绕过管理进程直连两个工作进程 403）。
- `cloud-agent-isolation-probe`：30 条全过（原 24 条，新增 V0～V3 六条：甲项目的对话要不到乙项目的画面；伪造身份八种写法全被拒、一帧没多出；项目的「渲染节点」、项目的「云端 Agent」、托管方的总开关三层关掉后都要不到）。
- `hosted-render-probe` 十步全过（缺省上限，没有加 `--memory-max`）；`cloud-agent-ux-probe` 21 条全过；`cloud-agent-first-video-probe`（模拟模型冒烟）8 条全过。
- 真实模型没有再跑（有费用）。真实模型下图片块怎么送进各家接口走的是桌面版已有的那一段（`server/harness/` 的各家提供方），云端没有另写。

### 25.6 实现时发现、任务书与清单都没列的用户可见行为

1. 云端 Agent 看过的画面只有模型看得到：AI 栏里点开「看了画面」这一步没有图，`get_gif` 也没有动图可点（桌面版有）。
2. 带自定义卡片的项目，云端第一次看画面（含 `get_layout` 量实体框）要等十来秒：隔离工作进程按项目现起。之后 90 秒内再看是快的。
3. 渲染服务正在渲别的项目的自定义卡片时，带自定义卡片的项目看画面要排队，最长等到时限（`see_frames` 约三分钟、`get_layout` 一分钟）后回「这次没看成」，模型按规定框继续并在汇报里说明。
4. 项目创建者关掉「渲染节点」后，云端 Agent 也看不了这个项目的画面（工具回「这次没看成：项目创建者关掉了这个项目的渲染节点」）。
5. 云端 Agent 用 `bake_card` 做的贴图是以渲染服务的身份写进素材服务的，按现有规则应计在托管方渲染服务的产物容量里（`hosted-render-contract.md` 第 6 节）、不算在成员名下；这一点是按规则推的，没有单独验。
6. 一轮结束后，别的成员 AI 栏顶上「〈成员〉的云端 Agent 正在改：…」那一行随之消失（原来一直挂着）。

### 25.7 没做成的与留给新节点的

- `get_gif` 的动图、聊天栏的可视化记录：见 25.2。
- `cloud-agent-ux-ui-probe` 没有加用户卡一步（真实浏览器里「后来的成员贴得上云端 Agent 建的用户卡的快照」仍没有断言）；看画面没有界面可验，界面探针没有动。
- 有人等着看画面时提前轮换隔离工作进程（45 秒）只有单测（HR41），没有用两个带卡项目的真进程演练。
- 新节点上要核对的：管理进程读得到登记表（`PROMPTCUT_RENDER_LOOK_SERVICES`；它与托管组合不是同一个用户时要给读权限，文件里只有公钥）；`/status` 的 `look.registry.agentKeys` 不是 0；非 root 的工作进程用户下 `bake_card` 的贴图推得进素材服务；Linux 上 Agent 通道那个浏览器实例多占的内存（常驻那棵树看画面后大约多一个浏览器进程，闲置 10 分钟关掉）计进了内存看护的读数。

---

## 26. 声音三组工具的实现记录（2026-10-07，分支 `claude/cloud-agent`）

任务书 J 要求云端 Agent 的工具与本机一致；这一节是接上音效合成、测响度、卡片声音的记录。上文与本节冲突时以本节为准；第 9.1、9.2、9.9 节已改，新增 9.4a～9.4c。语义文档没有改。

### 26.1 各工具做到哪一步

| 工具 | 状态 | 说明 |
|---|---|---|
| `sound_generate`、`sound_status`、`sound_cancel` | 接上 | 9.4a |
| `measure_audio` | 接上 | 9.4b；节点上要装 ffmpeg / ffprobe |
| `render_card_audio`、`cancel_card_audio` | 接上 | 9.4c；要节点配了看画面的口子 |
| `measure_audio_js` | 没接上 | 模型写的脚本要在断网的无头浏览器里跑。Agent 服务进程不起浏览器（25.1），所以得由渲染服务出一个跑脚本的口子：解码出来的 PCM（最多 1200 万个样本）怎么送过去、脚本的时限与内存炸弹怎么并进渲染服务的内存看护、它与预渲染任务怎么排队，都要定；这一轮没有做 |

「一键配特效」仍差语音识别，没有动。

### 26.2 对外接口、配置与行为的改动

| 改动 | 在哪 |
|---|---|
| 渲染服务的 `POST /look` 多一条 `path: '/api/cards/audio'`（请求体 `{ project, clipId, force }`；回 `{ ok, clipId, expectedClip, reusable? }` 或带 `name`、`bytes`、`rendition`、`wav`〔base64〕） | `server/hosted-render/look.mjs` 的 `LOOK_ROUTES` |
| 工作进程（预渲染进程）新接口 `POST /api/cards/audio`；托管方的工作进程里它与看画面那一批一样要口令（`LOOK_WORKER_PREFIXES`） | `server/vite-plugin-cards.ts`、`server/hosted-render/vite-gate.mjs` |
| 渲染页一侧的新模块（只在被动态载入时执行） | `src/audio/cardAudioHost.ts` |
| 用量流水的 `service` 多两种：`sound`（`unit: 'bytes'`）、`card-audio`（`unit: 'bytes'`）；`GET /v1/usage` 的 `services` 里跟着多出来 | `server/agent/service/hosted-sound.mjs`、`hosted-card-audio.mjs` |
| 工具表：六个工具从「还没接上」挪到「服务端另有实现」；卡片声音的两个标 `render`（没配口子时不交给模型）；`CLOUD_SLOW_TOOLS`（单次时限按 180 秒） | `server/agent/service/cloud-tools.mjs`、`instance.mjs` |
| 前端代码的载入缝多三组：`sound`（计划、合成、登记）、`audio`（测谁、标注）、`cardAudio`（只有登记） | `server/agent/ssr-host.mjs` |
| 桌面版的两处搬动（行为不变）：`sound_generate` 的参数 → 计划搬成纯函数；`measureAudio` 拆成「测谁」与「标注」两半 | `src/audio/soundRequest.ts`、`src/editor/io/soundGeneration.ts`、`src/mcp/common.ts` |

### 26.3 验收（本机，Windows）

- 单测：`cloud-agent-sound.test.mjs`（CA-SND-01～04）、`cloud-agent-audio.test.mjs`（CA-AUD-01～03）、`cloud-agent-card-audio.test.mjs`（CA-CAU-01～06）。CA-SND-01 把云端合成的 WAV 与桌面版入口同配方合成的逐字节比对，并钉死两份内容哈希。
- `cloud-agent-sound-probe`（新，真进程）S0～S5 六条全过：提示音（122924 字节）与键盘声（187244 字节）入库，别的成员凭自己的票据取得到、哈希相符；与本机同配方合成的逐字节相同；**与无头浏览器里桌面版入口在真的 Web Worker 里合成的内容哈希相同**（Chrome 152）；只读成员的 `sound_generate`、`render_card_audio` 被拒、项目不变，`measure_audio` 照常；`measure_audio` 量出提示音 -29 LUFS / -19.7 dBTP、时间轴带逐秒曲线，工作目录不留文件；带 `audio()` 的用户卡由隔离工作进程求值（常驻工作进程 0 次），24000 个样本逐个等于公式（最大差 0），代码里的记号不在 Agent 服务的输出里，再调一次 `reused: true`。
- `cloud-agent-isolation-probe`：31 条全过（原 30 条，新增 T6：音效只进本项目；另一个项目的对话看不到、查不到、取消不了这边的作业，量不了、重生成不了这边的素材与片段；只读成员生成不了；量完不留取来的素材）。

### 26.4 没做成的与留给新节点的

- `measure_audio_js`：见 26.1。
- 卡片声音的身份记录里的源码版本（`identity.sourceVersion`）是渲染页按桌面版同一算法算的；「在线成员的页面按这份记录判它没过期、放得出声」没有在真实浏览器里断言。
- 带输入的声音卡（`inputs` 引素材或别的节点）没有验：渲染页求值时要按素材地址取 PCM，那条路在托管方工作进程里通不通没有试；探针里的夹具是纯合成（`inputs: {}`）。
- 新节点上要核对的：Agent 服务的运行用户执行得了 ffmpeg / ffprobe；ffmpeg 子进程是不是在独立的非特权用户下（代码不假设）；`cloud-agent-sound-probe` 的 S3、S5 在 Linux 上重跑一遍。

---

## 27. 网页采集的实现记录（2026-10-07，分支 `claude/cloud-agent`）

接着第 26 节，把网页采集的七个工具接上。上文与本节冲突时以本节为准；第 9.1、9.2、9.6、9.7、9.9 节已改，新增 9.4d。语义文档没有改。

### 27.1 各工具做到哪一步

| 工具 | 状态 | 说明 |
|---|---|---|
| `collect_status`、`collect_search`、`collect_probe`、`collect_download`、`collect_job` | 接上（链路用下载器替身验通；真的 yt-dlp 留到节点上验） | 9.4d |
| `collect_install` | 接上，但在云端不装东西 | 没装回明确的原因；装了回「已经装好」 |
| `collect_logout` | 接上 | 云端不存登录态，回「没有可退出的」 |
| `collect_login`、`collect_login_check` | 仍是「要操作发起人界面」 | 不在线回「发起方不在线」，在线回「云端还不能反过来操作他的页面」（没有动） |

### 27.2 对外接口、配置与行为的改动

| 改动 | 在哪 |
|---|---|
| Agent 服务新配置 `PROMPTCUT_AGENT_COLLECT_PYTHON`（装了 yt-dlp 的 Python 解释器的绝对路径；不存在 `config.error collect`）；ffmpeg 的目录取自 `PROMPTCUT_FFMPEG`（加到子进程的 PATH 最前面） | `server/agent-service/main.mjs`、`hosted-collect.mjs` 的 `readCollectConfig` |
| 只给探针的 `PROMPTCUT_AGENT_COLLECT_TEST_ARGS`（把 `-m promptcut_collect` 换成替身脚本）；设了日志里有 `agent.collect.test-runner` | 同上 |
| `GET /healthz` 多回 `collect`（装没装）与 `collectTestRunner`（**生产必须是 false**，部署后的核对看它）；`agent.ready` 的日志同 | `server/agent-service/http.mjs`、`main.mjs` |
| 用量流水的 `service` 多一种 `collect` | `hosted-collect.mjs` |
| 工具表：七个工具从「还没接上」挪到「服务端另有实现」；`collect_search` 进 `CLOUD_SLOW_TOOLS`（单次时限 180 秒） | `cloud-tools.mjs` |
| 系统提示词：「这一版在云端还没有」里去掉网页采集与声音；新增「网页采集」「声音」两条 | `cloud-tools.mjs` 的 `cloudSystemNote` |

### 27.3 验收（本机，Windows；这台机器没有 yt-dlp，也没有为此去装）

- 下载器替身 `scripts/probes/fixtures/cloud-collect/fake-collect.mjs`：说同一份命令行与 JSONL，**只按环境里的代理出网**（没有代理就失败），并把自己看到的工作目录与环境变量的名字报回来（只读、只报告）。
- 单测 `cloud-agent-collect.test.mjs`（CA-COL-01～07；出网闸与代理、工作区与受限子进程是真的）：整条链（查状态 → 探测 → 下载 → 入库，入库的字节与源站相同、作业目录删掉、作业表落盘、四行用量）；回环、`localhost`、`[::1]`、`127.1`、10/8、192.168/16、169.254.169.254 的探测与下载全被代理拒掉，替身服务 0 次被连到；`file:`、`ftp:`、以 `-` 开头的地址不起子进程；体积、时长、墙钟上限与取消；没装时不起子进程；只读成员不起子进程、不连源站；作业表按实例分、重启后回「中断了」、作业目录以外的文件不认。
- `cloud-agent-isolation-probe`：32 条全过（新增 T7，对着真的 Agent 服务进程）：子进程的工作目录是对话的工作目录、环境里没有任何 `PROMPTCUT_*`；九种到同机与内网的地址全被代理拒掉（替身服务 0 次被连到）；下载的 6000 字节入库后别的成员取得到同样的字节、作业目录删掉；指向同机服务的下载作业经代理被拒；只读成员在下载之前被拒（源站 0 次）；另一个项目的对话查不到这边的作业；用量里有 `download:6000bytes`。
- 没有验的：真的 yt-dlp 与 ffmpeg（合并、转码、412 重试、B 站的搜索）；Linux 上子进程的环境与代理变量；子进程不经代理自己去连、往工作目录以外写（代码拦不住，靠部署）。

### 27.4 节点上要装什么（给部署说明）

1. Python 3（建议单独的虚拟环境，属于跑子进程的那个非特权用户）：`python3 -m venv /opt/promptcut/collect-venv && /opt/promptcut/collect-venv/bin/pip install yt-dlp`；
2. ffmpeg 与 ffprobe（`measure_audio`、导入素材读时长、采集的合并与转码共用），`PROMPTCUT_FFMPEG` 指它的绝对路径；
3. Agent 服务的环境里设 `PROMPTCUT_AGENT_COLLECT_PYTHON=/opt/promptcut/collect-venv/bin/python`；**不要**设 `PROMPTCUT_AGENT_COLLECT_TEST_ARGS` 与 `PROMPTCUT_AGENT_EGRESS_TEST_ALLOW`；
4. 部署后核对 `/healthz`：`collect: true`、`collectTestRunner: false`、`egressTestAllow: false`；再用一个测试项目让云端 Agent 调一次 `collect_status`（应当 `ready: true`）与一次真实的 `collect_probe`；
5. 建议（代码不假设）：子进程用独立的非特权用户跑，并在系统层面只许它连本机的代理端口段（出站限制），这样下载器即使不认代理也出不去。

---

## 28. 发起方在线时的反向通道的实现记录（2026-10-07，分支 `claude/cloud-agent-2`）

接着第 27 节，做任务书 J 里「要操作发起人自己界面的工具，发起方在线时要能用」这一块。上文与本节冲突时以本节为准。

### 28.0 进展

- [ ] 服务端：`page.request` 与 `POST …/page-results`
- [ ] 页面：白名单执行与交回
- [ ] 工具接线：`seek`、`play`、`pause`、`get_selection`
- [ ] 隔离探针与界面探针的断言
- [ ] 两处小的（D6 期望值、界面版体验探针的用户卡一步）
