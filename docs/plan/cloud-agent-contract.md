# 云端 Agent 服务：设计与契约

状态：**设计稿，待主会话审**（2026-10-06，分支 `claude/cloud-agent`，起点 `e7d18340`）。任务书 `cloud-agent-task.md`；用户的决定 E～J 在任务书里，本文不重复，只写怎么做到。

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
| 委托票据 | 文档服务签给成员页面、让云端 Agent 服务代这位成员开对话用的票据（第 4 节）。任务书 H 里的「发起成员的身份证明」就是它 |
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
  pageChannel,       // 桌面档：SSE 页面通道；托管档：null（第 9 节的可选项做了才有）
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
  tenants/<projectId>/users/<userKey>/conversations/<对话 id>/
      transcript.json       给人看的对话记录
      history.json          模型那一侧的消息历史
      run.json              最近一轮的状态（进行中 / 完成 / 中断）
  usage/<yyyy-mm>.jsonl     用量记录（追加写）
  usage/totals.json         各项目、各成员的累计（检查点）
  tmp/                      进程的临时目录（TMPDIR 指到这里）
```

`<userKey>` = `sha256(userId)` 的前 32 个十六进制字符〔裁：`userId` 是「用户名@设备」，用户名可以含任意字符，不直接当目录名〕。

失败即关（打一行 `config.error { reason }`，退出码 1）：`data-dir`、`doc-url`、`public-origin`、`service-identity`（凭证读不到或格式不对）、`listen`、`bind-public`（绑了非回环地址：拒绝启动，这个服务只许经反向代理对外）。没有模型 Key 照常启动，对话请求回 `error { code: 'no-model-key' }`。

### 2.3 托管档对外接口

全部在 `/v1/` 下（经 nginx 是 `/agent/v1/`）。除 `healthz` 外都要 `Authorization: Bearer <委托票据>`（第 4 节）。回包 JSON，`Cache-Control: no-store`。请求带 `Origin` 而不等于公网源的回 403；不答跨源预检（页面同源，用不着）。请求体上限 256 KiB〔裁：第一版不收附件，消息加素材清单远小于此〕。

| 接口 | 请求 | 成功 | 说明 |
|---|---|---|---|
| `GET /healthz` | — | `{ ok, version }` | 不鉴权，不含任何项目信息 |
| `GET /v1/info` | — | `{ ok, enabled, models: [..], defaultModel, limits: { rounds, runMs }, usage: { tokens, limitTokens } }` | 页面进入「云端」接入方式时取一次；`enabled` 是项目开关 |
| `POST /v1/chat` | `{ conversationId, prompt, model?, effort?, creativity?, script?, library?: [素材清单] }` | SSE（第 2.4 节） | 一个对话同时只许一轮：已有进行中的回 409 `busy-conversation` |
| `POST /v1/abort` | `{ runId }` | `{ ok }` | 只能停自己这个实例的；别人的、不存在的都回 `{ ok: true }`，不泄露存在与否 |
| `GET /v1/conversations` | — | `{ ok, items: [{ id, title, updatedAt, messageCount, state }] }` | 只列这位成员在这个项目里的 |
| `GET /v1/conversations/<id>` | — | `{ ok, chat: { id, messages, state } }` | `state`：`idle`、`running`、`interrupted` |
| `PUT /v1/conversations/<id>` | `{ title?, messages }` | `{ ok }` | 页面存给人看的对话记录（与桌面 `/api/chats/save` 同形状），上限 4 MiB |
| `DELETE /v1/conversations/<id>` | — | `{ ok }` | 连模型历史一起删 |
| `GET /v1/usage` | `?since=<毫秒>` | `{ ok, project: { tokens, calls }, members: [{ username, tokens, calls }] }` | 项目内任何成员可查本项目的 |
| `POST /v1/page-result` | `{ runId, reqId, result?, error? }` | `{ ok }` | 只在第 9 节的可选项做了才有 |

请求里**不收**这些桌面字段：`provider`（恒为 API 直连）、`sessionId`（模型历史按对话 id 找，不认页面自报的）、`deepAuto`、`reviewLoop`、`schemaCompat`、`attachments`、`hops`、`projectCreativity`（服务端读副本）。带了也忽略。

错误统一为 `{ ok: false, code, message }`；`code` 取：`unauthorized`（401，不说原因）、`forbidden`（403）、`disabled`（项目关了开关）、`busy`（节点或项目并发已满）、`busy-conversation`、`quota-exceeded`、`no-model-key`、`too-large`、`bad-request`、`unavailable`（文档服务连不上）。

### 2.4 流式格式

`POST /v1/chat` 回 `text/event-stream`，带 `X-Accel-Buffering: no`，每 15 秒一行 `: ping`。每个事件一行 `data: <JSON>`，形状与桌面 `/api/ai/chat` 相同（`run`、`session`、`status`、`text`、`thinking`、`tool_call`、`tool_result`（不带完整 `output`）、`progress`、`diagnostic`、`error`、`done`），页面的解析代码不分叉。两处增补：

- 每个事件带递增的 `seq`（从 1 起）。第一版不做断流接续：流断开即中止这一轮（与桌面 `vite-plugin-ai.ts:1218` 相同），`seq` 只是把格式留好〔裁：宽屏浏览器的网络比手机稳，接续要多一套缓冲与重放，第一版不值；手机界面做的时候再加，不改格式〕。
- `error` 事件带 `code`：除上表外另有 `revoked`（开关关了、成员被移出或踢出、项目删了、口令改了，附 `reason`）、`interrupted`（服务重启前留下的，见第 7.3 节）、`model`（模型接口报错）。

`diagnostic` 事件在托管档只发 `configuration` 与 `request` / `response` 的计数，不带模型接口地址〔裁：地址是托管方的配置，成员不需要知道〕。

### 2.5 鉴权（概述，细节在第 4 节）

每个请求独立核验：取 `Authorization` 里的委托票据 → 问文档服务核验（结果按票据摘要缓存到票据过期或被撤销）→ 得到 `{ projectId, userId, username, access }` → 找到或建出这个「项目 × 成员」的实例 → 只在这个实例里办事。URL 与请求体里**没有** `projectId`、`userId` 字段：身份只来自票据，页面自报不了。

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

〔裁〕**托管档的实例按「项目 × 成员」，不按项目。** 一个实例里的每条文档服务连接都是凭这位成员的委托票据开的，副本里的每个字节都是这位成员有权读到的；撤销某位成员就是关掉他的实例，不用在共享的副本里分辨谁读过什么。代价是同一项目的两位成员各持一份副本（项目 JSON 通常几百 KB 到几 MB），由第 11 节的实例数上限兜住。

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
- 闲置回收：没有进行中的一轮、10 分钟没有请求，关连接、丢副本〔裁，数字进 `mechanism/agent.md`〕。
- 撤销：见第 4.5 节，立即关。
- 进程退出（SIGTERM）：停止接新请求 → 给每个进行中的一轮发 `error { code: 'interrupted' }` 并中止 → 落对话记录 → 关连接 → 5 秒内退出。

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

### 4.2 委托票据

沿用 `auth-contract.md` 第 8 节的票据格式与签名密钥（项目记录的 `ticketKey`），新增一类：

```
{ kid, k: 'dlg', p: projectId, u: userId, dn: 设备名, cr?: true,
  aud: 'agent', acc: 'rw' | 'r', g, ug, exp, iat }
```

- **谁能要**：成员身份、`page` 角色的连接，在自己的连接上发 `auth.ticket { kind: 'delegate', audience: 'agent' }`。`agent`、`render` 角色的连接要不到（Agent 不能给自己续命）；本机 `local` 身份、服务身份要不到。登记表里没有 `agent` 服务、或项目的云端 Agent 开关关着时回 `error { reason: 'service-disabled' }`。
- **`acc`**：由文档服务按这位成员此刻的权限填，页面不能指定更高的。见 4.6。
- **有效期**：2 分钟，与连接票据相同〔裁〕。页面在过期前 30 秒换新的。
- **核对**：与现有票据相同（先验签名再采信字段、30 秒时钟偏差、项目代数与成员代数须与当前一致），另加 `aud` 必须等于来要的那个服务的服务名。
- **防伪造**：签名密钥只在文档服务进程里。
- **防重放**：只在 TLS 里传；有效期 2 分钟；改口令、改名单、踢人使代数变化，票据当场作废；拿它换连接票据要经服务身份的控制连接，而控制连接只认本机发起的，所以票据落到别人手里换不出连接；拿它重放 Agent 服务的 HTTP 接口，至多是在 2 分钟内以这位成员的身份做这位成员本来就能做的事，且受开关、额度管。票据不进地址、不进日志（日志只记它的 SHA-256 前 8 位）。
- **不绑对话**〔裁〕：对话列表、用量这些接口不属于某个对话；同一位成员的两个对话权限相同，绑了也不多挡什么。

### 4.3 时序

```
成员页面                  nginx           Agent 服务                       文档服务
   │  auth.ticket{delegate}（自己的连接上）─────────────────────────────────▶│
   │◀──────────────────────────────────────────── auth.ticket.ok{ticket,exp} │
   │  POST /agent/v1/chat  Bearer <委托票据> ─▶│─▶│                           │
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
   │◀──────────────── SSE: run / text / tool_call … ───│  project.op（以这个身份）─▶│
   │                                          │  │◀ hosted.project（开关变化、删除，随时）
```

- **①核验**：目录模块 `hosted` 加一种消息，只有服务名是 `agent` 的控制连接能发：`hosted.delegate.verify { delegation }` → `hosted.delegate.ok { projectId, userId, username, deviceName, creator, acc, exp }` 或 `error { reason }`（`reason` 只在这条受信的连接上给：`expired`、`generation`、`signature`、`no-project`、`service-disabled`、`banned`、`not-listed`、`audience`）。它不签任何东西，给不需要开连接的接口用（对话列表、用量）。Agent 服务把结果按票据摘要缓存 15 秒〔裁：不缓存到票据过期，被踢的成员最多再读 15 秒自己的对话列表〕。Agent 服务对页面一律回 401 `unauthorized`；只有 `service-disabled` 回 403 `disabled`（页面要据此显示「创建者已关闭」）。
- **③换连接票据**：用第三段在 `hosted.ticket` 上留的两个可选字段。`hosted.ticket { projectId, conversation: <对话号>, delegation: <委托票据> }`，文档服务：
  - 发来的控制连接的服务名必须是 `agent`（登记表里角色是 `agent`）；`render` 服务带了 `delegation` 回 `forbidden`；`agent` 服务**不带** `delegation` 一律回 `forbidden`（它没有「服务自己进项目」这回事）；
  - 委托票据按 4.2 核对，`p` 必须等于 `projectId`；开关开着；名单与禁入表按成员再核一次；
  - 签一张连接票据：`{ kid, k: 'conn', p, u: <成员的 userId>, r: 'agent', c: <对话号>, sv: 'agent', acc, dn, cr?, g, ug: <成员的代数>, exp, iat }`。与渲染服务的票据不同的两处：`u` 是**成员**的 `userId`（不是 `service:…`），`ug` 是成员的代数——所以踢人、移出名单对它和对成员自己的票据一样生效。
- **④握手**：Agent 服务拿这张票据走现有的 `promptcut.ticket.<票据>` 握手，`auth-contract.md` 第 5 节「至多一项鉴权」不用改。握手对 `sv: 'agent'` 的票据：登记表里还有 `agent` 服务、开关开着、名单与禁入表照成员核（`admissionOf`），得到 principal：

```js
{ userId, tenantId: projectId, scope: 'member', username, deviceId, deviceName, creator,
  role: 'agent', conversation, owner: null,
  service: 'agent', access: 'rw' | 'r' }
```

  `scope` 是 `member` 而不是第三段渲染连接的 `service`：它进的是成员的身份，名单、禁入、按 `userId` 的代数都照成员办；`service: 'agent'` 这个字段让消息白名单（4.4）、成员列表与署名认得出它是云端的。会话接续（`resumeGate`）与逐消息的 `gate` 照第三段的办法重新看开关与登记表。
- **续期**：连接票据只在握手时用，握手之后连接一直用到断。会话接续或重连要一张新的连接票据，也就要一张没过期的委托票据：页面每次请求都带当前的委托票据，Agent 服务按实例记住最新的一张；页面另在对话进行中每 60 秒经 `GET /v1/info` 带一次新的。页面关了、委托票据过期后又恰好要重连的，这一轮报 `error { code: 'revoked', reason: 'no-delegation' }` 并停下〔裁：成员不在场又连不上时，不让 Agent 无凭证地继续〕。连接没断的，这一轮照常跑完。
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

- 进行中的一轮手里至少有一条开着的连接（副本的订阅连接），所以「连接被关」这一路对进行中的对话总是到得了，不需要另加按成员的推送。没有进行中对话的闲置实例没有要停的东西，下一次请求时核验不过。
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

- 接线：`admitRun` 在 `chat` 处理的最前面；`admitModelCall` 与 `record` 接在驱动里每次模型请求的前后——给 `server/harness/agent.mjs` 加一个可选的 `onModelCall(phase, info)` 回调（`before` 可以抛错中止，`after` 带这一次的 `usage`），`api.mjs` 透传。模型请求只从这一处发出，审查环路（以后开的话）也经它。单测 CA-GATE-01 断言每次模型请求前都调过闸。
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

## 7. 对话记录

### 7.1 存在哪

Agent 服务的数据目录，按「项目 / 成员 / 对话」分目录（2.2 节）。两份：`transcript.json`（给人看的，页面按 `ChatMessage[]` 存取，形状与桌面相同）与 `history.json`（模型那一侧的消息历史，页面读不到）。

〔裁〕不放文档服务的内容库：对话正文可能很长、带模型的原始输出，文档服务是「只传小消息」的调度中心；放进去还要给内容库加按成员的读权限。也不放浏览器本地：语义规定浏览器本地只放能重新拉回的缓存。

### 7.2 谁能读

- 对话记录只属于**发起它的成员在这个项目里**：`userId`（用户名加设备）与 `projectId` 都对上才读得到。别的项目读不到；同项目的别的成员也读不到〔裁：对话里有成员自己的措辞与没采纳的想法，项目的共同成果是落地的改动与事件，那些所有成员都看得到〕。
- 推论：同一个人换一台设备进入，`userId` 不同，看不到另一台设备上的云端对话〔裁：现行身份就是「用户名 + 设备」，自由进入下用户名可以重名，不能按用户名给〕。
- 托管方能读（数据在它的节点上）。任务书没有要求对托管方保密，写在这里让用户知道。
- 成员被移出、被踢后对话记录留着但他读不到（要不到票据）；项目删除时删掉。
- 容量：每个对话 `transcript.json` 上限 4 MiB、`history.json` 上限 8 MiB（超了按现有的历史截断）；每位成员每个项目最多 50 个对话，超了删最久没动的〔裁，数字进 `mechanism/agent.md`〕。

### 7.3 进程被杀之后

- 一轮开始时写 `run.json { runId, state: 'running', startedAt }`，结束时改成 `done` 或 `aborted`。
- 模型历史**每完成一次工具往返就落一次盘**（临时文件加改名）。现在只在一轮结束或出错时落（`api.mjs:326`），被 `SIGKILL` 时这一轮做过的事全丢，而改动已经进了项目。给 `startRun` 加可选的 `checkpoint: true`，托管档打开，桌面不传。
- 进程起来时扫所有 `run.json`：`running` 的改成 `interrupted`，并在 `transcript.json` 末尾补一条系统消息「云端 Agent 服务中断，这一轮没有做完。已经落地的改动保留在项目里。」
- 页面一侧：流没有收到 `done` 就断了 → 显示同一句话，并提示可以继续；页面重新 `GET /v1/conversations/<id>` 拿到 `state: 'interrupted'`。用户接着发消息即重开：同一个对话 id，模型历史接着上一次落盘处（悬空的工具调用由现有的 `healDanglingToolUse` 补平）。
- PM2 负责拉起（`autorestart`，`exp_backoff_restart_delay: 200`）。

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

进清单的条件（单测 CA-TOOL-01～03 对着 `server/mcp-tools.mjs` 与 `src/mcp/routes.mjs` 核对）：`side` 是 `agent` 或 `server`；走路由表的必须 `awaited: false`；实现不打 `/api/*`、不碰 3.2 第 42 项的作业表、不读页面状态。128 个工具里开放 62 个（9.4 的播放头做了是 65 个）。

### 9.2 逐个工具

| 分组 | 开放 | 回「云端暂不支持」及理由 |
|---|---|---|
| project（7） | `get_project`、`list_media`、`set_project_meta`、`set_theme`、`list_media_effects` | `get_selection`（页面状态）、`import_media`（要读写节点本地文件） |
| clips（8） | 全部：`add_clip`、`update_clip`、`remove_clip`、`duplicate_clip`、`split_clip`、`get_clip`、`set_clip`、`set_emphasis` | — |
| layout（6） | 全部：`set_position`、`set_rect`、`align`、`nudge`、`get_layout`、`set_camera3d`。`get_layout` 只回规定的框，实体框为空并注明「云端没有渲染」 | — |
| tracks（5） | 全部 | — |
| parts（6） | 全部 | — |
| effects（10） | 全部（新建类照常受创造力等级管）。见第 15 节第 3 条的疑问 | — |
| cuts（8） | `list_transitions`、`add_transition`、`remove_transition`、`list_cuts`、`rename_cut` | `switch_cut`、`add_cut`、`remove_cut`：要把页面播放头存回被停放的剪辑（页面状态）。可选项做了就开 |
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

「深度自主」与「审查环路」在云端接入方式下不提供：它们把一轮从最多 24 次模型往返放大到最多 300 次，且审查环路每个角色回合各调一次模型，用的是托管方的 Key、现在又没有上限。界面上这两个开关在「云端」下隐藏。托管档一轮的硬上限：24 次模型往返、15 分钟〔裁〕。

### 9.4 可选项的建议

| 可选项 | 建议 | 判据 |
|---|---|---|
| 看画面（即时渲染） | **这一版不做，记未达成** | 要在节点上再跑一份只做即时渲染的预渲染进程加 Chrome（约 1.5～3 GB 内存），还要给它按需拉素材的本地库与素材票据；节点 16 GB 无 swap，同机已有渲染服务的 Chrome。做的前提是第三段的渲染服务能顺带提供即时渲染接口——那是第三段契约之外的事 |
| 读页面状态（选区、播放头） | **只做播放头，随消息带；选区不做** | 页面发消息时把当前播放头放进 `POST /v1/chat` 的 `pageState: { t }`，执行器的 `playhead()` 用它，`switch_cut`、`add_cut`、`remove_cut` 随之开放。不需要反向通道，成本一小时级。工具执行中途再向页面要状态（`/v1/page-result` 那条反向通道）不做 |

### 9.5 界面（I）

- **在线宽屏**：`DockPages.tsx:46` 的 `AgentPage` 现在在在线构建里恒为占位。改成：在线构建且**不是低内存档**（`src/online/lowMemory.ts` 的现有判定）时挂 `AiPanel`，接入方式只有一项「云端」并且默认选中；低内存档（手机、iPad 浏览器，含 Chrome 的手机仿真）仍是现在的占位，文案不变〔裁：用现成的低内存档判定当「手机」的口径，不另造一套宽度阈值〕。
- **AiPanel 的后端**：新目录 `src/ai/backend/`，一个接口两份实现：

  ```ts
  interface AiBackend { providers(); chat(body, signal); abort(runId); listChats(); getChat(id); saveChat(c); deleteChat(id); capabilities }
  ```

  `desktop.ts`（现在散在 `useAiChat.ts`、`chatStore.ts`、`providerState.ts` 里的 `/api/ai/*`、`/api/chats/*` 调用搬进来）与 `cloud.ts`（打 `/agent/v1/*`，带委托票据）。`index.ts` 用就地常量 `ONLINE_BUILD`（`onlinePrune.test.mjs` 规定的写法）二选一，在线构建里 `desktop.ts` 整个被摇掉。
- **云端下隐藏或置灰的**（`capabilities` 驱动，不在组件里到处写 `if`）：接入方式的安装与登录入口、API 设置窗口、附件按钮、深度自主与审查环路开关、诊断导出、多 Agent 页签的「新开 Agent」之外的拉起入口。置灰的悬停说明沿用 `c10-contract.md` 第 17 节表 A 的句式「在线浏览器模式暂不支持{入口名}，请在电脑上的 PromptCut 里使用。」
- **可用的**：发消息、流式回复、停止、工具调用过程（事件从文档服务来，与桌面同一套）、进度条目、「撤销这一步」、对话列表与重开、创造力等级选择、模型选择（托管方配置了多个模型时）、「引用到 AI」。
- **状态提示**：项目关了开关 →「项目创建者已关闭云端 Agent。」；超额、忙、中断见 6.2、7.3 的文案；放本机的项目（在线页面经中继进入的）→「这个项目放在创建者的电脑上，云端 Agent 只为放在云端的项目服务。」
- **项目设置**里「云端 Agent」开关：只有创建者能改，与第三段的「托管方渲染节点」开关放在一起（同一组、同一种创建者操作）。桌面版与在线页面的项目设置都显示（创建者通常在桌面版）。文件与第三段冲突，见第 14.3 节。
- **桌面版**：AI 栏不加「云端」，`cloud.ts` 不进桌面构建。成员列表里能看到别人的云端 Agent（显示名规则在共用代码里）。

---

## 10. 在线页面到 Agent 服务的通道

### 10.1 选哪条

**经 nginx 的新路径 `/agent/`，HTTP 加 SSE，直达 Agent 服务进程。** 页面打同源的 `https://<主站>/agent/v1/…`。

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
  - C10A-API-06：桌面产物里没有 `/agent/v1/`（这次桌面不加云端）；
  - C10A-API-07：在线产物里没有这些桌面专用的标识：`/api/mcp/events`、`/api/ai/setup`、`/api/chats/`、`PROMPTCUT_AGENT`（由 03 已经覆盖路径类的，这一条补非路径的）。
- 运行期探针 CAP-UI-02：在线页面完整走一遍对话，`window.__pcApiBlocked` 为空，网络记录里没有 `/api/`。
- `c10a-contract.md` 第 2 节「在线模式的替代」那张小表加一行「Agent 服务 = 同源的 `/agent/v1/`，凭委托票据」；`c10-contract.md` 第 10 节置灰清单里的「AI 栏（C10a 已置灰）」改成「AI 栏：普通档可用（云端 Agent），低内存档仍置灰」，并把云端下仍置灰的子入口列进去。

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
| 一轮 | 24 次模型往返、15 分钟、单次工具 60 秒 | 驱动与执行器 |
| 请求体 | 256 KiB（存对话记录 4 MiB） | HTTP 层 |
| 每位成员的 SSE | 同时 4 条 | HTTP 层 |
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
  - Agent 默认在用户本机运行。桌面版的 AI 栏用的是本机 Agent。
  - **云端 Agent**：托管方提供的 Agent 服务，跑在云节点上，只为放在这台节点上的项目服务。在线浏览器模式的用户在 AI 栏里选「云端」，对话与工具调用由它执行，改动经文档服务落地，和本机 Agent 的改动一样排序、记版本、通知、可撤销。
  - **模型**：云端 Agent 用托管方的模型凭证，服务端直连模型接口。凭证只在云节点上。
  - **身份**：云端 Agent 服务用托管方的服务身份接入文档服务；每个对话另须出示发起成员的身份证明，由文档服务核验。它在这个对话里能做的不超过该成员本人的权限，改动署名为「〈成员名〉的云端 Agent」，成员列表里看得到。它不使用任何成员的项目凭证。
  - **开关与失效**：每个项目有「云端 Agent」开关，缺省开，创建者可以关。创建者关掉开关、成员被移出、项目删除后，对应的对话立刻失效，进行中的对话被停掉。
  - **上限**：所有对话与模型调用都经过同一处额度与并发检查；每个项目有一个额度，缺省不限，由托管方按项目发放。用量按项目、按成员记录，可查。
  - **第一版的范围**：云端 Agent 能读项目、改项目（时间轴、片段、卡片参数、效果、素材引用）。暂不支持、会明确回「云端暂不支持」的：读写节点本地文件、网页采集与网页接管、语音识别与配音、新建或修改卡片代码、SKILL 相关。看画面与读页面状态不在第一版的承诺里。
  - **对话记录**存在云节点上，只有发起它的成员在这个项目里能读。

**「工具」的「看」一条末尾加一句**：云端 Agent 第一版没有渲染能力，也不经素材服务拉取产物来看。

### 12.2 `mechanism/agent.md`（新增一节「云端 Agent」，全部〔裁〕，出处写本文节号）

- 一份服务实现两种挂法；托管档按「项目 × 成员」分实例；闲置 10 分钟回收。（第 2、3 节）
- 委托票据：`k: 'dlg'`、`aud: 'agent'`、有效期 2 分钟、由项目的文档服务签；凭它经控制连接换带 `sv: 'agent'` 的连接票据；核验缓存 15 秒；撤销在 2 秒内停掉对话。（第 4 节）
- 写入身份带 `service: 'agent'`。（第 5 节）
- 闸的两个入口、判定顺序、`limits.json` 的字段、用量流水的字段。（第 6 节）
- 对话记录的目录、上限、中断标记、每次工具往返落盘。（第 7 节）
- Key 的封装与录入脚本、模拟提供方的脚本格式。（第 8 节）
- 开放清单的判定规则与数目。（第 9 节）
- 资源上限的数字。（第 11 节）

### 12.3 `architecture.md`

**角色表「Agent」一行**

- 修改前：读项目、发出修改、请求即时渲染。可替换：本地模型、用户自己的服务、项目方的服务，对其它角色是同一种角色；由谁提供决定是否由项目方计费
- 修改后：读项目、发出修改、请求即时渲染。可替换：本地模型、用户自己的服务、托管方的云端 Agent 服务，对其它角色是同一种角色；由谁提供决定用量记在谁名下

**扩展点表第一行**

- 修改前：| Agent | 项目方服务器 | 愿景 |
- 修改后：| Agent | 托管方的云节点（云端 Agent 服务） | 已做：在线浏览器模式的 AI 栏使用；桌面版仍用本机 Agent |

**「数据流」的「Agent 看画面」之后加一条**：云端 Agent 服务与文档服务之间只走文档服务的会话；在线页面与云端 Agent 服务之间只传对话（消息、流式回复、停止），不传项目内容与素材字节。

### 12.4 `product/platforms.md`

**「面向的平台」表后的最后一条**

- 修改前：Agent 端（Agent 服务与预渲染进程的 Agent 模式、Full 模式）面向 Windows、Linux、Ubuntu。
- 修改后：Agent 端（Agent 服务与预渲染进程的 Agent 模式、Full 模式）面向 Windows、Linux、Ubuntu。云端 Agent 服务跑在 Linux 云节点上，不带编辑界面。

**「在线浏览器模式」加一条**（放在「请求不到预渲染进程」一条之前）

- 新增：**AI 栏**：普通档的右侧 AI 栏可用，接入方式是「云端」，由托管方的云端 Agent 服务执行（见 `agent.md` 的「运行位置」）。本机没有进程，所以没有命令行与桌面 APP 这两种接入。低内存档的 AI 栏暂不可用。

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

- 新增：| **云端** | 托管方的云端 Agent | AI 栏（在线浏览器模式） | 传统式 |

并在表后加一句：在线浏览器模式只有「云端」一种接入；桌面版没有这一项。

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

`workflow/production.md`「用户发送指令」加一句：在线浏览器模式下接入方式是「云端」，不能附文件；云端暂不支持的操作 Agent 会直接说明。

`glossary.md`「接入方式」一条改成：Agent 的四种接入：CLI、API（在 AI 栏里对话）、桌面 APP（经 SKILL）、云端（在线浏览器模式的 AI 栏）。

「创建者特权」那一句与第三段的 D 是同一处，两段只能改一次，由主会话统一。

### 12.8 受影响的契约

| 契约 | 改哪里 |
|---|---|
| `auth-contract.md` | 第三段会加托管方服务身份的一整节（握手项、目录模块、`sv` 票据、白名单）；本段在它之上加：第 1 节名词「委托票据」；第 6 节 principal 的 `service: 'agent'`（`scope` 仍是 `member`）与 `access`，写入身份加 `service`；第 7 节 `auth.ticket` 加 `kind: 'delegate'`，创建者操作加 `set-hosted-agent`，成员列表的连接项加 `service`、顶层加 `hostedAgent`；第 8 节票据加 `k: 'dlg'` 与 `aud`、`acc`，连接票据加 `acc`；托管方服务一节里 `hosted.ticket` 的 `conversation`、`delegation` 两个字段、`hosted.delegate.verify`、`agent` 服务的白名单；第 12 节测试编号接着第三段的往后排。第 5 节「至多一项鉴权」不用改 |
| `c10a-contract.md` | 第 2 节「在线模式的替代」加 Agent 服务一行；第 2 节 nginx 清单加 `/agent/`；第 12 节守门加 C10A-API-05～07 |
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
| CA-CHAT-01 | 流式事件的顺序与形状（`run`、`session`、`tool_call`、`tool_result`、`text`、`done`），`seq` 递增；`tool_result` 不带完整输出 | 5 |
| CA-CHAT-02 | 停止：`abort` 后 1 秒内流结束，模型请求被中止，名额释放 | 5 |
| CA-CHAT-03 | 对话记录的存、取、列、删；上限；50 个对话的淘汰 | 5 |
| CA-CRASH-01 | 一轮进行中杀子进程再起：`run.json` 变 `interrupted`、对话记录末尾有中断说明；接着发消息能续上，历史里没有悬空的工具调用 | 6 |
| CA-TOOL-01 | 开放清单 ⊆ 工具表；不在清单里的 66 个逐个调用都回 `cloudUnsupported`，且文档服务没有收到任何提交 | J |
| CA-TOOL-02 | 清单里走路由表的工具都是 `awaited: false` | 3 |
| CA-TOOL-03 | 清单里的工具逐个在托管档跑一遍（最小参数）：没有一次请求打到 `agent-service.invalid`，没有碰作业表 | J |
| CA-TOOL-04 | 交给模型的工具表只有清单里的加 `think` | J |
| CA-KEY-01 | `set-key.mjs`：命令行或环境变量里带 Key 拒绝；标准输入不是终端拒绝；写出的文件是密文、0600；输出里没有 Key | 8 |
| CA-KEY-02 | Key 出现在模型报错里时，流、对话记录、模型历史、日志四处都被替换掉 | 8 |
| CA-LOG-01 | 跑完一整轮，日志全文里没有提示词、回复正文、票据、Key | 规矩 |
| CA-MOCK-01 | 模拟提供方照脚本走；没有脚本块时与现在逐事件相同 | 8 |
| CA-DESK-01 | 桌面档：`/api/ai/*`、`/api/mcp/*`、`/api/agent/*` 的路径清单与抽服务之前逐条相同（对着起点提交生成的清单） | 3 |
| C10A-API-05～07 | 见 10.3 | 5 |
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
| CAP-UI-02 | 全程 `__pcApiBlocked` 为空，网络记录没有 `/api/` | 5 |
| CAP-UI-03 | Chrome 手机仿真（低内存档）：仍是占位，没有任何 `/agent/` 请求 | 5 |
| CAP-E2E-01 | 桌面隔离实例建协作项目放到本机的托管组合；在线成员让云端 Agent 改文案、挪片段、调卡片参数各一次；桌面与另一位在线成员都看到，署名「某某的云端 Agent」；成员列表里看得到 | 6 |
| CAP-E2E-02 | 「撤销这一步」与本机 Agent 同样生效；被别人改过的实体同样报冲突 | 6 |
| CAP-E2E-03 | 两位成员同时各开一个对话，各做 10 次写：互不串，版本连续 | 6 |
| CAP-E2E-04 | 杀 Agent 服务进程（探针自己起的那个）：自动拉起，页面报中断，重开后继续 | 6 |
| CAP-QUOTA-01 | 第 7 条的三步在页面上走一遍，截图 | 7 |
| CAP-TOOL-04 | 含用户卡片段的项目：挪、删可以，改参数回说明 | J |
| CAP-RES-01 | 6 轮并发时 Agent 服务的常驻内存、堆、CPU；文档服务往返时间与素材下载速度的前后对比（方法验证） | 9 |

### 13.3 只能在新节点上验的（留给主会话）

- 完成条件第 6 条用真实模型再跑一遍（用户录入 Key 之后）。
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
| 丙 托管档入口、闸、用量、对话记录、Key | 新增 `server/agent-service/main.mjs`、`http.mjs`、`admin.mjs`、`set-key.mjs`；`server/agent/service/gate.mjs`、`usage.mjs`、`transcripts.mjs`、`cloud-tools.mjs`；改 `server/harness/providers/mock.mjs`、`server/ai-system-prompt.md`（或新增云端那一段的文件） |
| 丁 在线界面 | 新增 `src/ai/backend/{index,desktop,cloud}.ts`；改 `src/ai/useAiChat.ts`、`chatStore.ts`、`providerState.ts`、`src/editor/right/AiPanel.tsx` 及其子组件、`src/editor/dock/DockPages.tsx`、成员列表与显示名所在文件、`src/editor/sync/` 里取委托票据的一处、`src/editor/ProjectSettingsDialog.tsx`（开关） |
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

估计工作量（子 Agent 的净工作时间，不含主会话审查）：甲 5～7 小时，乙 5～7 小时（含与第三段对齐），丙 4～5 小时，丁 5～6 小时，戊 2 小时，己的探针与修问题 4～6 小时。并行后日历时间约一天半。

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
5. 对话记录同项目成员之间互相不可见、换设备看不到（7.2）。
6. 可选项：看画面不做；页面状态只做「随消息带播放头」（9.4）。
7. 与第三段的对齐：共用代码检出目录与 PM2 配置的写法；开关用两个字段两种操作（照第三段现状）还是合成一个（4.7 第 6 条）；4.7 表里其余「还差什么」由哪一段落。
8. 第 11 节的数字。

**可能要问用户的（任务书没列的用户可见行为）**

1. **云端下不提供「深度自主」与「审查环路」**（9.3）。不提供是收窄，理由是费用没有上限；若用户希望云端也有，需要先有额度。
2. **一级文档的改动**（12.7）：`user-workflow.md` 加「云端」接入方式、`workflow/project.md` 给「创建者特权只有三项」补一句说明开关算在哪一项里（第三段为渲染开关提了同一个问题）。E～J 的决定里含了这两件事的实质，但任务书点名的语义文件里没有这两份；草稿 `draft_cloud-node-and-agent.md` 把它们列为一级改动。
3. **云端下不能附文件**（9.5）。它是 J「读写节点本地文件的不开放」的直接后果，列出来让用户知道。
4. **对话记录托管方读得到**（7.2）。

---

## 16. 依据

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
