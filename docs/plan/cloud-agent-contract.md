# 云端 Agent 服务：设计与契约

状态：**设计稿第二稿，待主会话审**（2026-10-06，分支 `claude/cloud-agent`，起点 `e7d18340`，已并入 main `de03c915` 的任务书更新）。第二稿相对第一稿改了哪些见第 17 节。任务书 `cloud-agent-task.md`；用户的决定 E～J 在任务书里，本文不重复，只写怎么做到。

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

- **桌面档**：`vite-plugin-ai.ts` 变成薄壳，只做三件事——用 `server.ssrLoadModule` 当 `loadModule`、把 `/api/ai/*`、`/api/mcp/*`、`/api/agent/*` 的请求原样转给这份服务、保留只属于桌面的接口（安装与登录、诊断、机器码、`port.json`、SKILL 预览）。路径、请求与回包、SSE 事件一个字段都不变。「桌面版改用同一个入口」指的是这一条：同一份 `createAgentService`、同一套实例管理，桌面是只有一个实例的特例。**不新增桌面进程，不动桌面壳。**〔裁：任务书写「不动桌面壳」；桌面另起一个 Agent 进程要改壳的进程管理与补丁判定，而用户看到的行为没有任何变化，不值得〕
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
| `POST /v1/conversations/<id>/messages` | `{ prompt, grant, model?, effort?, creativity?, script?, library?: [素材清单], pageState?: { t, selection } }` | 202 `{ ok, runId, seq }` | 发一条消息、起一轮。**这一轮从此与这个请求的连接无关。** `grant` 是这一轮的对话委托（4.2）。同一个对话已有进行中的回 409 `busy-conversation` |
| `GET /v1/conversations/<id>/events` | `?after=<seq>`，`Accept: text/event-stream` | SSE（第 2.4 节） | 先补发 `seq` 大于 `after` 的全部事件，再接实时的。可以同时开多条（多台设备、多个页签） |
| `POST /v1/conversations/<id>/abort` | — | `{ ok }` | 停这个对话进行中的一轮。对话的主人从任何设备都能停 |
| `GET /v1/conversations` | — | `{ ok, items: [{ id, title, updatedAt, state, lastSeq, startedOn: 设备名 }] }` | 这位成员在这个项目里的云端对话（归属见 7.2） |
| `GET /v1/conversations/<id>` | — | `{ ok, meta: { id, title, state, lastSeq, reason? } }` | `state`：`idle`、`running`、`interrupted`、`failed`、`revoked` |
| `PATCH /v1/conversations/<id>` | `{ title }` | `{ ok }` | 改标题 |
| `DELETE /v1/conversations/<id>` | — | `{ ok }` | 进行中的先停；连模型历史一起删 |
| `GET /v1/usage` | `?since=<毫秒>` | `{ ok, project: { tokens, calls }, members: [{ username, tokens, calls }] }` | 项目内任何成员可查本项目的 |
| `POST /v1/conversations/<id>/page-result` | `{ reqId, result?, error? }` | `{ ok }` | 只在 9.4 的反向通道做了才有 |

请求里**不收**这些桌面字段：`provider`（恒为 API 直连）、`sessionId`（模型历史按对话 id 找，不认页面自报的）、`deepAuto`、`reviewLoop`、`schemaCompat`、`attachments`、`hops`、`projectCreativity`（服务端读副本）。带了也忽略。

错误统一为 `{ ok: false, code, message }`；`code` 取：`unauthorized`（401，不说原因）、`forbidden`（403）、`disabled`（项目关了开关）、`busy`（节点或项目并发已满）、`busy-conversation`、`quota-exceeded`、`no-model-key`、`too-large`、`bad-request`、`bad-grant`（对话委托不对：过期、不是这个对话的、不是这位成员的）、`unavailable`（文档服务连不上）。

### 2.4 事件流：存下来再发

**一轮的每个事件先追加进这个对话的事件记录（磁盘），再发给此刻连着的流。** 没有任何流连着，这一轮照样跑、照样记。流是「看」，不是「跑」的一部分：

- 流断开（关页签、退出桌面版、断网）：这一轮**不停**。只有三件事能停它：主人调 `abort`、撤销（4.5）、出错或到上限。
- 重新打开、换设备：`GET …/events?after=<上次看到的 seq>`，服务端先从事件记录补发，再接上实时的；`after=0` 就是从头看完整过程。补发与实时之间不丢、不重（同一把锁里切换）。
- 页面的对话界面完全由事件重建，页面不向服务端存对话记录。

格式：`text/event-stream`，带 `X-Accel-Buffering: no`，每 15 秒一行 `: ping`。每个事件一行 `data: <JSON>`，带递增的 `seq`（每个对话从 1 起，跨轮连续）。事件类型在桌面 `/api/ai/chat` 的基础上（`run`、`session`、`status`、`text`、`thinking`、`tool_call`、`tool_result`（不带完整 `output`）、`progress`、`diagnostic`、`error`、`done`）加：

- `user`：一条用户消息 `{ runId, prompt, from: 设备名, at }`——别的设备补看时要看得到问的是什么；
- `error` 带 `code`：`revoked`（开关关了、被移出或踢出、项目删了，附 `reason`）、`interrupted`（服务重启留下的）、`model`（模型接口报错）、`quota-exceeded`、`limit`（到了轮数或时间上限）；
- `render`：这一轮的改动引出的补渲的进展 `{ state: 'published' | 'done' | 'failed' | 'unavailable', clips, reason? }`（第 16 节）；
- `end`：一轮收尾 `{ runId, state }`，之后没有这一轮的事件了。

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

运行实例与对话的**归属**是两回事：对话记录按主人（用户名）存（7.2），这样换一台设备能找回；每一轮在发起它的那台设备的 `userId` 的实例里跑，用的是那台设备要来的对话委托。同一个对话先后两轮可以在两个实例里跑，同一时刻只有一轮。

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
| 有效期 | 2 分钟 | 60 分钟〔裁〕 |
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
| 在场状态 | 在场模块的发布与订阅（别的成员「正在编辑」的片段；实现时按在场桥实际发的类型填） |

  明确拒绝、各有单测的：`auth.ticket`（任何种类：要不到连接票据、委托票据、素材票据）、`shared.*`（含创建者操作与成员列表）、`node.hello` 与全部队列消息、`content.put`、`project.snapshot.put`、`service.announce` / `service.withdraw`、成本记录。白名单以实现时在探针里抓到的消息类型为准，多一种就回来改本表。
- `access: 'r'` 的连接发 `project.op`、`project.upload` 回 `forbidden`；事件照发（读工具也有事件）。
- 素材：第一版开放的工具不读写素材字节（只引用素材 id），Agent 服务**不取素材票据**。以后做「看」时再定（留在 `draft_cloud-node-and-agent.md`）。

### 4.5 三种失效怎么传到并停掉对话

| 触发 | 文档服务做什么 | Agent 服务怎么知道 | 流上的 `reason` |
|---|---|---|---|
| 创建者关掉云端 Agent 开关 | 记录落盘；本空间里 `service: 'agent'` 的连接以 4003 `service-disabled` 关闭；之后委托票据的签发与核验、连接票据的签发、握手、接续一律拒；目录推 `hosted.project { projectId, enabled: false }`；给其余连接发 `shared.notice { event: 'hosted-agent-changed', enabled }` | 连接被关，或目录推送，哪个先到算哪个 | `disabled` |
| 成员被移出名单（`set-list`） | 现有：该用户名全部连接以 4003 `removed` 关闭、代数加一。云端 Agent 的连接带同一个用户名，随同被关 | 连接被关 | `removed` |
| 成员被踢（`kick`） | 现有：该 `userId` 的连接以 4003 `kicked` 关闭、进禁入表、成员代数加一。同上 | 连接被关 | `kicked` |
| 项目删除（`delete`） | 现有：全空间连接以 4004 关闭；目录推 `removed` | 连接被关，或目录推送 | `deleted` |
| 改项目口令（`set-password`） | 现有：代数加一，在线连接不断。云端 Agent 的连接也不断（与成员自己的连接一致）；成员下一次要委托票据前得先用新口令进入 | — | — |

- 进行中的一轮手里至少有一条开着的连接（副本的订阅连接），所以「连接被关」这一路对进行中的对话总是到得了，不需要另加按成员的推送。**这条路不经过成员的任何设备**：成员全都离线时，创建者（或别的设备上的他自己）关开关、踢人、删项目，照样在 2 秒内停掉云端的这一轮。停下的原因记进事件记录，主人回来看得到（7.3）。没有进行中对话的闲置实例没有要停的东西，下一次请求时核验不过。
- Agent 服务收到其中任何一种：立刻中止受影响实例里所有进行中的一轮（模型请求的 `AbortController`、等待中的工具），流上发 `error { code: 'revoked', reason }` 后结束；关实例；清掉这个实例的核验缓存。「立刻」的口径：文档服务处理完创建者操作到 Agent 服务停止向模型发新请求与提交新写入，不超过 2 秒〔裁〕；之后就算有漏网的写入，连接已关，文档服务也不收。
- 控制连接断开期间，Agent 服务核验不了票据、换不了连接票据：不接新对话（回 `unavailable`），已有连接的对话照常跑，靠各自连接被关来停。
- 项目删除后，Agent 服务删掉 `tenants/<projectId>/` 下的对话记录与模型历史（用量记录留着，它是托管方的账）。

### 4.6 只读成员

现行语义里没有只读成员：`workflow/project.md` 写「其余操作所有成员一样」。任务书完成条件第 4 条要求「只读成员发起的对话改不了项目」。本设计把**机制**做全：委托票据带 `acc`、连接票据与 principal 带 `access`、文档服务按它拒写（4.4）；`acc` 由文档服务的一个函数 `memberAccess(项目记录, 用户名)` 决定，它读项目记录里一个可选字段 `readonly: [用户名]`，没有这个字段时人人是 `rw`。这一版**不加**设置这个字段的界面与创建者操作〔裁：加了就是一个任务书没列的用户可见功能〕；隔离探针在本机隔离的托管组合里直接写项目记录来造一个只读成员。这一条请主会话确认（第 15 节）。

### 4.7 我对通用「托管方服务身份」的要求（给第三段）

第三段的草稿已经满足大部分，逐条对照：

| # | 要求 | 第三段草稿 | 还差什么 |
|---|---|---|---|
| 1 | 服务身份带服务种类，一种服务的凭证冒充不了另一种 | 满足：登记表里一个服务一把密钥，角色写在登记表里 | `keygen.mjs` 要能给 `--service agent` 生成，私钥目录可指定 |
| 2 | 服务单独握手得到不属于任何项目的控制连接 | 满足（1.2、1.3） | — |
| 3 | 控制连接上能知道项目的开关变化与删除 | 满足（`hosted.watch` 推 `hosted.project`） | `enabled` 要**按发起订阅的服务**取：`agent` 服务看到的是云端 Agent 的开关。`active` 对 Agent 没用，照给即可 |
| 4 | 凭委托换连接票据 | 留了口子：`hosted.ticket` 的 `conversation`、`delegation` | 按 4.3 ③填：只对 `agent` 服务认；`agent` 不带 `delegation` 回 `forbidden`；票据的 `u`、`ug` 取成员的 |
| 5 | 只核验不签的入口 | 没有 | 加 `hosted.delegate.verify`（4.3 ①），只对 `agent` 服务开 |
| 6 | 每个项目对每种服务一个开关，同一种创建者操作与通知 | 渲染的是 `hostedRender: { enabled }`、`set-hosted-render`、`hosted-render-changed`、成员列表顶层 `hostedRender: { available, enabled }` | Agent 照同样的形状加一份：`hostedAgent`、`set-hosted-agent`、`hosted-agent-changed`、`hostedAgent: { available, enabled }`。我更倾向合成一个 `hosted: { render, agent }` 与一个 `set-hosted { service, enabled }`，少一半重复代码；两种写法对用户没有区别，请主会话在两段合流前定一种。本文其余地方按第三段现在的形状写 |
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
| 项目的「云端 Agent」开关 | 项目创建者 | 文档服务的项目记录 `hostedAgent: { enabled }`，创建者操作 `set-hosted-agent`（形状照第三段的 `hostedRender`，见 4.7 第 6 条） | 开 |
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

- **主人**是「项目里的这个用户名」，不是「用户名 + 设备」〔裁〕：用户要在另一台设备上打开同一个对话接着看、接着说，而现行身份 `userId` 带设备，两台设备是两个 `userId`。主人键 = 项目 + 用户名 + 是不是以创建者身份进入的。
  - 创建者以创建者身份（出示创建者口令）进入的，和别人以成员身份自报同一个用户名进入的，是两个主人：冒名的人看不到创建者的云端对话。
  - 限定进入下用户名有各自的口令，主人就是那个人。
  - **自由进入下用户名是自报的**：知道项目口令的人自报同一个用户名，就读得到、停得了、接得上这个用户名名下的云端对话。这和自由进入下「谁都能自报任何用户名」的现状一致，但后果比显示名重名大一点，列在第 15 节请主会话与用户知道。
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
- 上限：一轮最多 24 次模型往返、30 分钟〔裁〕；到了记 `error { code: 'limit' }`，对话可以接着说。

### 7.4 重新打开后怎么找回

- **在线页面**：进入项目、AI 栏挂起来时调 `GET /v1/info` 与 `GET /v1/conversations`。对话列表（现在 AI 栏的历史列表）列出这位成员在这个项目里的云端对话，在跑的带「进行中」标记；`info.running` 不空时自动打开那个对话并接上流（`events?after=0`），不用用户去找。
- **桌面版**：同一套。打开一个放云端的项目、文档服务连上之后，AI 栏的历史列表里本机对话与云端对话分两组；有在跑的云端对话时，AI 栏的页签上出一个「云端对话进行中」的标记，点开即接上。**不自动把接入方式切到「云端」**（本机 Agent 仍是缺省）。
- 另一台设备：同一个用户名进同一个项目，看到的是同一份列表（7.2）；打开在跑的对话即接着看，`abort` 能停，说下一句就是在那台设备上起新的一轮（带那台设备的对话委托）。
- 撤销：Agent 的每次写入在文档服务的事件模块里有完成事件（带 `callId`、`opId`、逆操作，`c65-design.md` 第 7 节）。重新打开后页面照常从文档服务取这些事件，按 `callId` 对上事件记录里的工具调用，「撤销这一步」与本机 Agent 相同，由页面以自己的身份提交逆操作。**待实现时用探针验**：页面在这些事件发生时不在线，重开后取不取得回逆操作；取不回就按 `solution_table.md` 建表（候选：页面进入时向事件模块补拉最近 N 条；逆操作改从内容库的 `event-detail` 取）。

### 7.5 进程被杀之后

- 进程起来时扫所有 `meta.json`：`running` 的改成 `interrupted`，事件记录末尾补一条 `error { code: 'interrupted' }`「云端 Agent 服务中断，这一轮没有做完。已经落地的改动保留在项目里。」与 `end`。
- **不自动续跑**〔裁〕：续跑要凭证，而对话委托只在内存里（4.2），重启后没有了；让它无凭证地继续不行，把委托落盘又是在节点上多存一份能代成员行事的东西。主人回来看到中断，说一句「继续」就是新的一轮：模型历史接着上一次落盘处（悬空的工具调用由现有的 `healDanglingToolUse` 补平）。
- 没渲完的补渲清单（`pending-render.json`）在进程起来后重新发布（第 16 节），不需要成员在场。
- PM2 负责拉起（`autorestart`）。

---

## 8. F：模型 Key

### 8.1 保存

沿用 `server/ai-config.mjs` 与 `server/runners/config-crypt.mjs`：`config/ai.json` 存厂商、接口地址、模型清单（`a|b|c`）、`maxTokens`；Key 的密文在 `config/keys/custom.key`（`PCENC1.` 封装，口令由本机指纹派生，Linux 上取 `/etc/machine-id`，`machine-id.mjs:82`），文件 0600。整个文件拷到别的机器上解不开。Key 的明文只在 Agent 服务进程的内存里；事件、历史、日志里出现时照现有逻辑替换掉（`api.mjs:143`、`:332`）。

这层封装挡的是「明文躺在文件里」，挡不住能以同一个系统用户在节点上跑代码的人（`config-crypt.mjs` 文件头已写明）。节点是托管方自己的，这一条如实写进给用户的说明。

### 8.2 录入办法（由用户在节点上执行）

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

### 9.1 判定规则

一张**开放清单**（`server/agent/service/cloud-tools.mjs`），不在清单里的一律不开放——新加的工具默认关着，要人看过才进清单。两道：

1. 不开放的工具**不交给模型**（省上下文，也免得它去试）。系统提示词里写一段「云端第一版不支持：导入与采集素材、网页操作、语音识别、配音与音效生成、镜头与主体识别、运动追踪、看画面、新建或修改卡片代码、自定义测量、多 Agent 协作、播放控制。用户要这些时直接告诉他『云端暂不支持，请在电脑上的 PromptCut 里使用』，不要找替代办法。」
2. 所有工具调用的总入口（创造力等级闸之前）再判一次：不在清单里的回 `{ ok: false, cloudUnsupported: true, error: '云端暂不支持 <工具名>：<原因>。请在电脑上的 PromptCut 里使用。' }`，什么都不执行。

进清单的条件（单测 CA-TOOL-01～03 对着 `server/mcp-tools.mjs` 与 `src/mcp/routes.mjs` 核对）：`side` 是 `agent` 或 `server`；走路由表的必须 `awaited: false`；实现不打 `/api/*`、不碰 3.2 第 42 项的作业表、不读页面状态。128 个工具里开放 66 个（含 9.4 的四个页面状态工具）。

### 9.2 逐个工具

| 分组 | 开放 | 回「云端暂不支持」及理由 |
|---|---|---|
| project（7） | `get_project`、`list_media`、`set_project_meta`、`set_theme`、`list_media_effects` | `import_media`（要读写节点本地文件）。`get_selection` 开放，规则见 9.4 |
| clips（8） | 全部：`add_clip`、`update_clip`、`remove_clip`、`duplicate_clip`、`split_clip`、`get_clip`、`set_clip`、`set_emphasis` | — |
| layout（6） | 全部：`set_position`、`set_rect`、`align`、`nudge`、`get_layout`、`set_camera3d`。`get_layout` 只回规定的框，实体框为空并注明「云端没有渲染」 | — |
| tracks（5） | 全部 | — |
| parts（6） | 全部 | — |
| effects（10） | 全部（新建类照常受创造力等级管）。见第 15 节第 3 条的疑问 | — |
| cuts（8） | `list_transitions`、`add_transition`、`remove_transition`、`list_cuts`、`rename_cut` | —。`switch_cut`、`add_cut`、`remove_cut` 开放，播放头的规则见 9.4 |
| audio（19） | `set_clip_volume`、`set_clip_muted`、`separate_audio`、`create_audio`、`list_audio_fx`、`create_audio_fx`、`update_audio_fx`、`remove_audio_fx`、`apply_audio_fx` | `measure_audio`、`measure_audio_js`（要节点本地解码与专用 Chrome）；`sound_*` 四个、`render_card_audio`、`cancel_card_audio`、`voice_list`、`voice_generate`（配音与声音生成） |
| ai（19） | `detach_clip_motion`、`get_transcript`、`fill_captions`、`list_captions`、`edit_caption` | 语音识别三个、镜头两个、追踪四个、主体四个；`attach_clip_motion`（要页面内存里的轨迹） |
| cards（8） | `list_cards`（在服务端注册表上执行，只有内置卡） | `card_authoring_guide`、`get_card_source`、`edit_card`、`create_card`、`apply_card`（建卡改卡，J 明确关着；图卡定义同属此类）；`inspect_card_dom`、`bake_card`（看画面） |
| vision（2） | — | `see_frames`、`get_gif`（看画面，可选项） |
| collect（9）、browser（8） | — | 全部（网页采集与网页接管） |
| agent（5） | — | 全部：`spawn_agent` 要页面开页签；其余四个依赖页面的信箱投递。〔裁：第一版一个对话一个 Agent，多 Agent 协作留给以后〕 |
| core（8） | `wait`、`report_progress` | `background_job_status`、`auto_workflow`、`auto_workflow_status`（依赖转写等后台作业）；`seek`、`play`、`pause`（页面状态） |
| 驱动自带 | `think` | `text_editor`（读写节点本地文件）：不提供 |

`list_cards`、`list_parts` 在托管档改由 SSR 宿主的注册表直接答（现在 `list_cards` 是 `side: "page"`）。项目里已有的用户卡片段：云端 Agent 能挪、能删、能改通用属性，改它的卡片参数时拿不到参数表，按「未知卡片」回错并说明「这张卡是用户自定义的，云端暂不支持改它的参数」。探针 CAP-TOOL-04 覆盖这一条。

### 9.3 第一版不提供的两个对话选项（请主会话确认，见第 15 节）

「深度自主」与「审查环路」在云端接入方式下不提供：它们把一轮从最多 24 次模型往返放大到最多 300 次，且审查环路每个角色回合各调一次模型，用的是托管方的 Key、现在又没有上限，而云端的一轮在用户离开后没人看着。界面上这两个开关在「云端」下隐藏。托管档一轮的硬上限见 7.3。

### 9.4 页面状态与看画面

**页面状态的规则**（任务书 J 补的一句）：云端的一轮不依赖任何页面，页面状态只是「有就用」。

- 发消息时页面把当时的播放头与选区随消息带上（`pageState: { t, selection: [片段 id] }`），服务端记在这一轮上。
- 「发起方在线」的判定：此刻有一条来自**发起这一轮的那个 `userId`** 的事件流连着这个对话。
- 读页面状态的工具：

| 工具 | 发起方在线 | 发起方不在线 |
|---|---|---|
| `get_selection` | 回发消息时的选区，注明「这是发消息时的选区」 | 立刻回 `{ ok: false, initiatorOffline: true, error: '发起方不在线，读不到页面的选区。请按项目内容继续，不要等待。' }` |
| `switch_cut`、`add_cut`、`remove_cut`（要播放头） | 用发消息时的播放头 | 照常执行，被停放的剪辑的播放头记 0，结果里注明「发起方不在线，播放头按 0 记」 |
| `attach_clip_motion`（要页面内存里的轨迹） | 云端暂不支持（追踪不开放，轨迹无从来） | 同左 |
| `seek`、`play`、`pause` | 云端暂不支持（它们是操作页面，不是读） | 同左 |

  系统提示词里写一句：「用户可能已经离开。工具回『发起方不在线』时不要等，按项目内容继续，在进度汇报里说明哪一步没用上页面状态。」不在线的回答是立刻给的，不设等待，Agent 不会卡住。
- 所以开放清单比 9.2 的表多 `get_selection` 与三个切剪辑的工具，共 66 个（9.2 表里这四个所在的格子以本节为准）。
- **反向通道**（工具执行中途向在线的页面要此刻的选区与播放头，经事件流发 `page.request`、页面 `POST …/page-result` 回）是可选项，建议这一版**不做**：发消息时的快照已经覆盖「引用我选中的这张卡」这类用法；反向通道要处理多条流、超时与页面中途离开，收益小。做了的话上表「在线」一列换成实时值，离线一列不变。

**看画面（即时渲染）**：建议这一版不做，记未达成。要在节点上再跑一份只做即时渲染的进程加 Chrome（约 1.5～3 GB 内存），还要给它素材票据与按需拉素材的本地库；节点 16 GB 无 swap，同机已有渲染服务的 Chrome。以后做的自然路径是让第三段的渲染服务顺带提供即时渲染接口。云端 Agent 改完后的画面由第 16 节的补渲保证「别人看到的是渲好的」，那不需要 Agent 自己看。

### 9.5 界面（I）

- **在线宽屏**：`DockPages.tsx:46` 的 `AgentPage` 现在在在线构建里恒为占位。改成：在线构建且**不是低内存档**（`src/online/lowMemory.ts` 的现有判定）时挂 `AiPanel`，接入方式只有一项「云端」并且默认选中；低内存档（手机、iPad 浏览器，含 Chrome 的手机仿真）仍是现在的占位，文案不变〔裁：用现成的低内存档判定当「手机」的口径，不另造一套宽度阈值〕。
- **桌面版**：接入方式的列表里，在现有的 CLI、API 之后多一项「云端」。
  - **只在这些条件都成立时出现**：当前项目是放云端的多用户协作项目、文档服务已连上、文档服务报这台节点有云端 Agent 服务（`hostedAgent.available`，第 10.4 节）。放本机的项目、没开协作的项目、本机草稿里看不到这一项。开关被创建者关着时这一项在，但置灰并说明「项目创建者已关闭云端 Agent」。
  - **本机 Agent 仍是缺省**：新开的对话页签用的还是上次选的本机接入方式；「云端」从不被自动选中，也不记成全局缺省（只记在这个页签上）。
  - 选了「云端」的页签是一个云端对话：消息发到云节点，工具在云端执行，**不经过本机的 Agent 服务**（`/api/ai/chat`、`/api/mcp/*`、本机的项目副本绑定都不参与）。同一个 AI 栏里可以一个页签本机、一个页签云端，互不影响。
  - 桌面版退出（连托盘）：云端对话照跑。重新打开见 7.4。
- **AiPanel 的后端**：新目录 `src/ai/backend/`，一个接口两份实现：

  ```ts
  interface AiBackend { info(); send(conversationId, body); events(conversationId, after, onEvent, signal); abort(conversationId); listChats(); deleteChat(id); capabilities }
  ```

  `desktop.ts`（现在散在 `useAiChat.ts`、`chatStore.ts`、`providerState.ts` 里的 `/api/ai/*`、`/api/chats/*` 调用搬进来，行为不变：本机的一轮仍然绑在那条请求上）与 `cloud.ts`（打云节点的 `/agent/v1/*`，带委托票据）。在线构建只带 `cloud.ts`（`index.ts` 里用就地常量 `ONLINE_BUILD` 把 `desktop.ts` 摇掉）；桌面构建两份都带，按页签选的接入方式取。
- **云端下隐藏或置灰的**（`capabilities` 驱动，不在组件里到处写 `if`）：安装与登录入口、API 设置窗口、附件按钮、深度自主与审查环路开关、诊断导出、拉起子 Agent。置灰的悬停说明：在线页面沿用 `c10-contract.md` 第 17 节表 A 的句式；桌面版写「云端 Agent 暂不支持{入口名}，请改用本机接入方式」。
- **可用的**：发消息、流式回复、停止、工具调用过程（事件从文档服务来，与本机同一套）、进度条目、「撤销这一步」、对话列表与重开、创造力等级选择、模型选择（托管方配置了多个模型时）、「引用到 AI」。
- **离开时的提示**：云端对话在跑时关页签或退出桌面版，不拦，也不弹确认；对话页签上常驻一行小字「在云端运行，关闭后继续；重新打开可接着看」〔裁〕。
- **状态提示**：项目关了开关 →「项目创建者已关闭云端 Agent。」；超额、忙、中断、撤销见 6.2、7.3 的文案；补渲见第 16 节。
- **项目设置**里「云端 Agent」开关：只有创建者能改，与第三段的「托管方的渲染节点」开关放在一起。桌面版与在线页面的项目设置都显示。文件与第三段冲突，见第 14.3 节。
- 成员列表与署名的显示名规则在共用代码里，桌面与在线一致。

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

- 地址从哪来：文档服务下发。`shared.members.list` 顶层的 `hostedAgent: { available, enabled, url }`，`url` 是托管组合启动时配的公网地址（环境变量 `PROMPTCUT_AGENT_PUBLIC_URL`，如 `https://149-88-94-84.sslip.io/agent/v1`）。页面不自己拼，放本机的项目没有这个字段，所以「云端」一项出不来。
- 凭证：桌面页面在自己到云端文档服务的连接上要委托票据与对话委托（4.2），与在线页面相同。本机的 Agent 服务、`K`、项目口令都不参与。
- 跨源：桌面页面的源是本机地址，Agent 服务按 2.3 放开跨源、只认票据。请求只从页面发出，不经 `/api/*`，所以本机编辑器进程的同源卡口（`vite-plugin-api-guard`）与它无关。
- 为什么不让本机 Agent 进程转发：转发的话桌面版一退出转发就断，云端的一轮虽然还在跑，但「同一条通道」不成立、还要在本机多维护一套代理与凭证；而用户体验验收的核心正是「退出后与本机无关」。
- 桌面版退出后：页面没了，云端的一轮照跑（7.3）。重新打开见 7.4。
- 对桌面现有行为的影响：只多一个接入方式选项与历史列表里的一组；不选它，所有请求与今天逐条相同。CA-DESK-02 守这一条。

---

## 11. 节点资源上限

节点 8 核、16 GB、无 swap；同机有托管组合（文档与素材，一个 Node 进程）、nginx、渲染服务（带 Chrome，是内存大户，上限由第三段定）。Agent 服务第一版没有 Chrome，是一个单线程的 Node 进程。

| 项 | 数字〔裁〕 | 手段 |
|---|---|---|
| V8 老生代 | 1536 MiB | `node --max-old-space-size=1536` |
| 进程常驻内存 | 超过 2 GB 重启 | PM2 `max_memory_restart: '2G'`。重启前先走 3.4 的收尾（`kill_timeout: 8000`） |
| CPU | 至多占满 1 核，优先级低于文档与素材服务 | 单线程；启动脚本 `nice -n 10` |
| 同时进行的一轮 | 全节点 6，每项目 3，每成员 2 | 闸（6.2）；满了回 `busy`，不排队 |
| 存活实例 | 24 个，超了先回收闲置最久的，回收不动就回 `busy` | 实例登记表 |
| 单个项目副本 | JSON 超过 16 MiB 的项目不服务，回「项目太大」 | 建实例时判 |
| 一轮 | 24 次模型往返、30 分钟、单次工具 60 秒 | 驱动与执行器 |
| 补渲 | 每个计划最多 200 个片段；发布后最多等 30 分钟；每个项目一条发布连接 | 第 16 节 |
| 事件记录 | 每个对话 8 MiB 起降级、12 MiB 封顶 | 7.2 |
| 请求体 | 256 KiB | HTTP 层 |
| 事件流 | 每个主人同时 8 条、全节点 200 条，超了回 `busy` | HTTP 层 |
| 磁盘 | 对话见 7.2；用量流水每月一个文件，不清 | — |

依据的估算（实现时用探针 CAP-RES-01 实测并把数字写进报告，估算不准就调上表）：vite 载入 `src/` 的模块图约 300～500 MB；每个实例一份副本，按 5 MB 的项目、解析后约 3 倍，24 个实例约 360 MB；模型历史在一轮期间驻留内存，每轮上限 8 MiB。合计在 1.5 GB 的堆内有余量。

满载对同机的影响（完成条件第 9 条）由主会话在新节点上测；本机用隔离的托管组合先测一遍方法：6 轮并发的模拟对话（每轮 20 次写工具）跑着时，量文档服务 `project.op` 的往返时间（中位数与 P95）与素材服务下载一个 100 MB 文件的速度，各与空载比。本机的数字只说明方法可行，不当作节点的结论。

---

## 12. 语义改写的逐字稿

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
  - **第一版的范围**：云端 Agent 能读项目、改项目（时间轴、片段、卡片参数、效果、素材引用）。暂不支持、会明确回「云端暂不支持」的：读写节点本地文件、网页采集与网页接管、语音识别与配音、新建或修改卡片代码、SKILL 相关。看画面不在第一版的承诺里。读页面状态的工具用发消息时的选区与播放头；发起方不在线时回明确的「发起方不在线」，Agent 据此继续。
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
- 改动落地后攒 3 秒发布补渲计划、最多 200 个片段、最多等 30 分钟、重启后重发。（第 16 节）
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
- 修改后（照第三段建议稿的写法，不改「三项」的数；第三段若已加了渲染那半句，这里只补「云端 Agent」）：创建者特权只有三项：改项目密码、名单或邀请码，删项目，踢人；其余操作所有成员一样。开关「托管方的渲染节点」与「云端 Agent」算在踢人这一项里：它管的是让不让托管方的服务进这个项目。
- 修改前：Agent 用所属用户的身份，显示为「用户名 · Agent · 第几个对话」，界面用标签区分真人和 Agent。
- 修改后：Agent 用所属用户的身份，显示为「用户名 · Agent · 第几个对话」，界面用标签区分真人和 Agent。云端 Agent 显示为「〈用户名〉的云端 Agent」。

`workflow/project.md`「多用户协作」在第三段加的「托管方的渲染节点」那一条后面加一条：

- 新增：项目放云端时，项目设置里另有一个勾选「云端 Agent」，缺省勾上：在线浏览器模式的成员可以在 AI 栏里用托管方的云端 Agent。项目创建者可以取消，取消后进行中的云端对话立刻停掉；其他成员看得到这一项，不能改。放本机的项目没有这一项。

`workflow/project.md`「项目设置」：

- 修改前：名称、画幅比例与方向、帧率、分辨率、主题、创造力等级；多用户协作的开关、放在本机或云端、进入方式与创建者信息。
- 修改后：名称、画幅比例与方向、帧率、分辨率、主题、创造力等级；多用户协作的开关、放在本机或云端、进入方式与创建者信息；放云端的项目另有托管方服务的开关（渲染节点、云端 Agent）。

`workflow/production.md`「用户发送指令」加一句：接入方式选「云端」时不能附文件；云端暂不支持的操作 Agent 会直接说明；发出后可以离开。

`glossary.md`「接入方式」一条改成：Agent 的四种接入：CLI、API（在 AI 栏里对话）、桌面 APP（经 SKILL）、云端（AI 栏里，对话在云节点上运行；在线浏览器模式只有这一种）。

「创建者特权」那一句与第三段的 D 是同一处，两段只能改一次，由主会话统一。

### 12.8 受影响的契约

| 契约 | 改哪里 |
|---|---|
| `auth-contract.md` | 第三段会加托管方服务身份的一整节（握手项、目录模块、`sv` 票据、白名单）；本段在它之上加：第 1 节名词「委托票据」；第 6 节 principal 的 `service: 'agent'`（`scope` 仍是 `member`）与 `access`，写入身份加 `service`；第 7 节 `auth.ticket` 加 `kind: 'delegate'`，创建者操作加 `set-hosted-agent`，成员列表的连接项加 `service`、顶层加 `hostedAgent`；第 8 节票据加 `k: 'dlg'` 与 `aud`、`acc`，连接票据加 `acc`；托管方服务一节里 `hosted.ticket` 的 `conversation`、`delegation` 两个字段、`hosted.delegate.verify`、`agent` 服务的白名单；第 12 节测试编号接着第三段的往后排。第 5 节「至多一项鉴权」不用改 |
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
| CA-DESK-02 | 桌面版不选「云端」时：打开项目、发消息、工具调用全程没有任何发往 `hostedAgent.url` 的请求（放云端的项目只多一次 `info` 与一次对话列表） | 3、I |
| CA-DESK-03 | 「云端」一项的出现条件：放本机的项目、未协作的项目、草稿里没有；放云端且 `available` 时有；开关关着时置灰；从不被自动选中，新页签的缺省仍是上次的本机接入方式 | I |
| CA-DESK-04 | 桌面版选「云端」发消息：本机的 `/api/ai/chat`、`/api/mcp/*`、`/api/agent/bind` 一次都没被调 | I |
| C10A-API-05、07 | 见 10.3 | 5 |
| AU16 起 | `auth-contract.md` 的新增条目各一条（委托票据的签发与核对、`set-hosted-agent`、关开关时以 4003 `service-disabled` 关连接） | 4 |

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

- 甲、乙必须 `opus-dev`，可以并行（文件不重叠，接口在本文第 2.1、4.3 节）。乙依赖第三段的服务身份骨架（握手、目录模块、`sv` 票据、白名单）：最省事是等第三段的实现合进集成分支后从集成分支出发；要并行就先只做不依赖它的部分（委托票据的签发与核对、`memberAccess`、`access` 拒写、`hostedAgent` 开关与创建者操作），`hosted.ticket` 的委托分支等骨架到了再接。
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
6. 可选项：看画面不做；页面状态用发消息时的快照，反向通道不做（9.4）。
9. 对话委托 60 分钟、一轮 30 分钟、不自动续跑（4.2、7.3、7.5）。
10. 无人在线时的补渲走 16.2（Agent 服务发布）还是让渲染服务自己发；16.3 的 R1～R9 与第三段协调。
11. 「云端对话在跑时关页签或退出，不拦不弹确认」（9.5）。
7. 与第三段的对齐：共用代码检出目录与 PM2 配置的写法；开关用两个字段两种操作（照第三段现状）还是合成一个（4.7 第 6 条）；4.7 表里其余「还差什么」由哪一段落。
8. 第 11 节的数字。

**可能要问用户的（任务书没列的用户可见行为）**

1. **云端下不提供「深度自主」与「审查环路」**（9.3）。不提供是收窄，理由是费用没有上限；若用户希望云端也有，需要先有额度。
2. **一级文档的改动**（12.7）：`user-workflow.md` 加「云端」接入方式、`workflow/project.md` 给「创建者特权只有三项」补一句说明开关算在哪一项里（第三段为渲染开关提了同一个问题）。E～J 的决定里含了这两件事的实质，但任务书点名的语义文件里没有这两份；草稿 `draft_cloud-node-and-agent.md` 把它们列为一级改动。
3. **云端下不能附文件**（9.5）。它是 J「读写节点本地文件的不开放」的直接后果，列出来让用户知道。
5. **自由进入的项目里，云端对话按自报的用户名归属**（7.2）：知道项目口令的人自报同一个用户名，就能看到、停掉、接上那个用户名名下的云端对话。这是「换设备接着看」与现行「身份 = 自报用户名 + 设备」放在一起的直接后果；创建者（凭创建者口令）与限定进入的成员（凭各自口令）不受影响。若用户不接受，替代是「只有创建者与限定进入的成员能换设备找回，自由进入的成员只能在原设备找回」。
6. **含用户卡的片段在没人在线时能不能渲**取决于第三段第 0 节第 1 条选 A 还是 B；选 B 时用户体验验收里「画面是渲好的」对用户卡不成立。
4. **对话记录托管方读得到**（7.2）。

---

## 16. 没有任何成员在线时，重卡怎么渲出来

### 16.1 现状与缺口

预渲染任务现在都是页面发布的：在线页面发带片段清单的计划任务（`src/online/planPublisher.ts`，`c10-contract.md` 第 7 节），桌面版由本机预渲染进程发。队列只在内存里，按发布方的连接记账（`mechanism/document-service.md`「队列只在内存里」）。云端 Agent 改了一张重卡而没有任何页面在线时，没有人发布任务，渲染服务无活可接；等下一位成员进来，看到的是占位，他的页面再发任务、再等渲。这不满足「另一成员进来看到的画面是渲好的」。

### 16.2 方案：Agent 服务在改动落地后发布补渲计划

选「谁改的谁发」：Agent 服务自己知道每次写入动了哪些片段（执行器的 `ctx.write.clipIds`，`agent-exec.mjs:387`），不用任何一方去猜。

- **发布方**：Agent 服务，用**服务身份**（不是成员的委托）在这个项目里开一条只用来发布的连接（下称发布连接）。不用成员身份的理由：补渲要活过这一轮、活过成员被移出，也不该占成员的权限；它只是「请渲染节点把这几个片段渲了」，不读不写项目内容。
- **发什么**：与在线页面同一种清单计划——`kind: 'plan'`、`id: plan:<projectId>@<项目版本>#clips:<清单签名>`、`input.clips` 为片段 id 清单、`requires.codeVersion` 为这份检出的代码版本、不写环境指纹（让渲染服务按自己的环境切）。优先级用补渲那一档（排在成员本机判重的任务之后，`document-service.md`「补渲排在后面」）。计划的形状与签名算法只有一份：从 `src/online/planPublisher.ts` 里把纯函数部分经 `ssr-host.mjs` 载入（仍是那一处载入缝），不在服务端另写一遍。
- **清单里放哪些片段**：这一轮里被写到的、需要预渲染的片段。Agent 服务没有成本记录的判定，按低内存档过渡期的同一条规则办：**全部按重卡处理**（`platforms.md`「轻重判定」）；素材片段（视频、图片、音频）不放。已经有结果的由渲染服务按结果键跳过，不重做。每个计划最多 200 个片段，多了分批〔裁〕。
- **什么时候发**：每次写入落地后攒 3 秒（一连串写入合成一个计划），按当时的项目版本发；新的计划发出后撤回这个对话上一个还没被认领完的旧计划（旧版本的画面没人要了）。一轮结束时再补发一次，保证最后的版本有计划。
- **保持到结果入库**：发布连接与 `pending-render.json` 的寿命跟着计划走，不跟着那一轮、也不跟着实例走。计划完成（收到 `task.done`）→ 记 `render { state: 'done' }` 事件、清掉清单；全部清单清空后关发布连接。上限 30 分钟〔裁〕：到时还没完成就记 `render { state: 'failed', reason: '超时' }` 并撤回，之后由下一个进来的页面按现有规则自己发。
- **失败不悄悄丢**：收到 `task.fail` → 事件记录里记 `render { state: 'failed', clips, reason }`，对话界面在那一轮下面显示「以下片段的预渲染没有完成：…，有渲染节点的成员上线后会自动补上」。项目内容不受影响。渲染服务的项目开关关着、或节点上没有渲染服务 → 不发布，记 `render { state: 'unavailable' }`，显示「托管方的渲染节点没有为这个项目开启，重卡的画面要等有渲染节点的成员上线」。
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
| R8 | 用户卡片段的任务按第三段第 0 节第 1 条的选择办；Agent 服务不区分，清单里照放，由渲染服务按能力认领或留着 | 待主会话选方案 A 或 B | 选 B 的话，含用户卡的片段在没人在线时渲不出来，探针与验收里要写明 |
| R9 | 渲染服务满载或排队时任务等着，不报失败；Agent 服务这边 30 分钟上限到了才记失败 | 草稿第 4 节的并发上限 | 两边的时限要对得上：请第三段给出「一个 200 片段的计划在节点上最坏多久」的估计，我据此调 30 分钟 |

如果主会话更愿意走另一条路（**渲染服务自己盯着项目的变化发布**，Agent 服务什么都不发）：对我这边更省事（16.2 整节不用做，只留 `render` 事件靠订阅队列得到），但渲染服务要自己判断「哪些片段变了、要不要渲」，等于把在线页面的判重搬一份进渲染服务，并且在有页面在线时会与页面发的计划重复。我的建议仍是 16.2。

---

## 17. 第二稿相对第一稿的改动（2026-10-06，任务书更新后）

任务书加了「用户体验验收」、改了 I、补了 J 之后，第一稿（提交 `c3c94fdb`）里这些地方改了：

| 处 | 第一稿 | 第二稿 |
|---|---|---|
| 2.3 接口 | `POST /v1/chat` 直接回流，一轮绑在这条连接上；页面 `PUT` 对话记录 | 发消息回 202，一轮与连接无关；事件流单独一个接口，可补看、可多处同时看；对话记录由服务端写；`abort` 按对话；放开跨源（桌面版要打） |
| 2.4 流 | 断流即中止，`seq` 只留格式 | 事件先存后发；断流不停；按 `seq` 补发再接实时 |
| 3.1 实例 | 「项目 × 成员（`userId`）」一份，对话记录也按它 | 运行实例仍按「项目 × `userId`」；对话的归属改按「项目 × 用户名 × 是否创建者」（7.2），才能换设备找回 |
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
