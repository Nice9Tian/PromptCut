# 子 Agent 报告：云端 Agent 服务（分支 `claude/cloud-agent`）

任务书：`docs/plan/cloud-agent-task.md`（四段连做的第四段）。起点 `e7d18340`。

## 第一轮：设计与契约（2026-10-06，已交主会话审）

这一轮只写设计，不改代码、不起常驻进程、不连远端机器；语义文档不改，逐字稿在契约第 12 节。

### 做了什么

- 写了 `docs/plan/cloud-agent-contract.md`（16 节）：独立入口的形态与接口、按「项目 × 成员 × 对话」分实例与 42 项进程级状态的逐项改法、H 的认证流程、G 的闸与用量记录、对话记录、Key 的保存与录入、工具开放清单与界面、通道与守卫、资源上限、语义逐字稿、测试与探针计划、文件清单与分工。
- 读了规则六份、任务书、草稿步骤 3、七份语义、`auth-contract.md` 全文、`c10a-contract.md` 与 `c10-contract.md` 的守卫与置灰部分、`c65-design.md` 的身份与撤销部分；代码读了 `server/vite-plugin-ai.ts` 全文、`server/agent/` 的载入缝、执行器、连接、会话登记、`server/runners/api.mjs`、`ai-config.mjs`、`config-crypt.mjs`、`server/auth/` 的握手与票据、`server/docservice/` 的共享组装与成员模块、`server/hosted/` 的入口与部署模板、`src/online/apiGuard.ts`、棘轮测试与清单、`DockPages.tsx`、`vite.config.ts`。
- 与第三段对齐：开工时 `hosted-render-contract.md` 还不存在；写第 4 节前再看已有（`claude/render-service` 的 `acbb2993`，草稿），第 4 节按它的服务身份、目录模块、`sv` 票据、白名单重写，第 4.7 节逐条列了还差什么。
- 外部事实查了三处（nginx 代理的超时与缓冲、PM2 的内存上限与重启、Node 的堆上限），依据在契约第 18 节。

### 验证结果

这一轮没有代码改动，没跑基线。只读地跑过两条 `node -e`（列工具表 128 个工具各组的数目与 `side`、抽几个工具的说明），用来写开放清单；没有起服务。

### 过程中的一次失误

提交本报告时，一条 Bash 命令里的报告正文带反引号，被 shell 当成命令替换执行了一遍。被执行的都是文件名与单词（如 `seq`、`sv`、`side`），全部以「找不到命令」或缺参数结束，没有改动任何文件、没有起进程；后果只是那一次写出的报告缺了反引号里的字（提交 `c3c94fdb` 里的本文件），随即用写文件的方式重写并补提交。契约文件不受影响。

### 第二稿（任务书更新后，同日）

主会话通知任务书有更新（main `de03c915`：新增「用户体验验收」、I 改为桌面版也能选「云端」、J 补「发起方不在线」）。已 `git merge main`（只带进文档），契约改成第二稿，改动对照表在契约第 17 节。要点：

- 一轮与发起它的连接脱钩：发消息回 202；事件先存后发，按 `seq` 补看再接实时流；对话记录由服务端写（契约 2.3、2.4、第 7 节）。
- 身份证明分两种：2 分钟的委托票据（页面的每个请求）与 60 分钟、绑成员 × 项目 × 对话的对话委托（成员离线后仍有效，撤销靠文档服务关连接，2 秒内停）（4.2、4.3、4.5）。
- 对话按「项目里的用户名」归属，换设备能找回；桌面版与在线页面怎么列出与自动接上（7.2、7.4）。
- 页面状态用发消息时的快照；发起方不在线时立刻回「发起方不在线」（9.4）。
- 桌面版 AI 栏的「云端」：只在项目放云端时出现、本机仍是缺省、页面直连云节点不经本机 Agent（9.5、10.4）。
- 新增第 16 节：没有成员在线时由 Agent 服务用服务身份发布补渲计划并保持到入库；对第三段的九条要求（16.3）。
- 探针计划加了真实结束发起方进程的端到端探针 CAP-UX-01～07（13.2）。

### 没做成的及原因

- 看画面（即时渲染）建议这一版不做，理由与判据在契约 9.4。
- 完成条件第 9 条的正式数字、真实模型的端到端、nginx 与 PM2 的实际表现只能在新节点上验，留给主会话（契约 13.3）。

### 对任务书或语义的更正建议

1. 任务书完成条件第 4 条的「只读成员」在现行语义里不存在（`workflow/project.md`：「其余操作所有成员一样」）。契约 4.6 只做机制，不加界面；要不要有只读成员这个功能请用户另定。
2. 任务书点名要改的语义文件里没有 `user-workflow.md` 与 `workflow/project.md`（一级），而 I 与 G 的实质落在这两份上（接入方式多一项、项目设置多一个开关）。逐字稿在契约 12.7，请主会话确认授权范围后由主会话落。
3. `workflow/project.md` 与 `product/document-service.md` 的「创建者特权只有三项」与开关矛盾，第三段提了同一个问题；契约 12.7 照第三段建议稿的写法补一句，不改数。
4. 现状里的一个串台口子（桌面单用户下无害）：模型历史文件按请求里的 `sessionId` 找（`server/runners/api.mjs:196`），放到多用户下知道别人的 `sessionId` 就能接着别人的历史说。托管档改成按票据定的实例加对话 id 找（契约 3.2 第 32 项）。

### 〔裁〕清单（都在契约里，写了理由）

桌面档不另起进程（2.1）；托管档启动时删换驱动的环境变量（2.1）；目录名用 `userId` 的摘要（2.2）；请求体上限与不收附件（2.3）；断流即中止、`seq` 先留格式（2.4）；实例按「项目 × 成员」（3.1）；闲置 10 分钟回收（3.4）；委托票据 2 分钟、不绑对话（4.2）；核验缓存 15 秒、单进程持私钥、无委托不续跑（4.3）；撤销 2 秒内停（4.5）；只读只做机制（4.6）；云端 Agent 归在成员那一行（第 5 节）；额度放 Agent 服务自己的配置里（6.1）；对话记录的存放、可见范围与上限（7.1、7.2）；工具不开放的不交给模型、多 Agent 五个工具不开（9.1、9.2）；一轮 24 次往返与 15 分钟（9.3）；低内存档判定当「手机」的口径（9.5）；资源上限的全部数字（第 11 节）。

## 第二轮：甲块（抽服务与多实例，2026-10-06）

主会话审过契约第二稿后的十三条裁定已写进契约对应处，待用户审的汇在契约第 19 节（提交 `229f72cb`）。之后又按主会话转来的第三段估计，把补渲的「最多等 30 分钟」改成「连续 10 分钟没有进度放弃、绝对上限 12 小时、只发受影响的片段」（契约 16.2）。

### 做了什么

分两步，各一个提交。

1. **只搬不改**（`2ccb03ee`）：`server/vite-plugin-ai.ts` 里的页面通道、项目副本绑定、工具调用总入口、对话、多 Agent 与桌面会话的接口，原样搬进 `server/agent/service/instance.mjs`。办法是用 Node 的类型剥离把原文件的四段（原第 54～80、117～668、986～1254、1275～1538 行）逐字搬过去，只改相对路径与缩进；搬过去的代码里仍叫 `server` 的那个对象换成宿主给的一小块（`httpServer`、`ssrLoadModule`、`config.root`、`middlewares.use`）。插件里留下 `port.json`、驱动清单、安装与登录、诊断、机器码、配置、额度面板。这一步之后跑了全量测试：4432 项、4431 通过、0 失败、1 跳过，与基线相同。
2. **加实例**（`065877ef`）：
   - `server/agent/service/create-agent-service.mjs`：托管档的实例登记表，按「项目 × 成员」各一个实例；进程级的串行锁；对话在内存里的事件记录（带 `seq`，可补看）；一轮与发起它的连接无关；闲置回收、实例数上限、撤销的入口；闸留了接口位（缺省永远放行）；主人键按裁定第 8 条。
   - `server/agent/service/cloud-tools.mjs`：开放清单 66 个工具与「云端暂不支持」的理由。
   - `server/agent-service/main.mjs`、`http.mjs`：托管档入口。进程内起无插件的 vite 只用 `ssrLoadModule`；只许绑回环；没有任何 `/api/*`；接口有 `/healthz`、发消息（202）、事件流、停止、对话列表、`info`。鉴权是接口位：命令行入口没有凭证，除 `/healthz` 外一律 401。
   - `instance.mjs` 加托管档的分支：凭证与文档服务地址由宿主给、工具过开放清单、不经 SKILL 闸、`get_selection` 按发消息时的快照答、`startHostedRun`。
   - `server/agent/ssr-host.mjs` 加 `resetStore`、`clearProject`；`agent-exec.mjs` 的串行锁可由调用方给、可进锁清场；`agent-side.mjs` 透传。
   - `server/runners/api.mjs` 加 `historyFile`、`localTools`、`toolFilter`；`server/harness/tools/index.mjs` 加 `only`、`localTools`；`server/harness/providers/mock.mjs` 加按脚本走的模式（没有脚本时与原来逐事件相同）。

改到的现有测试只有一处：`server/test/skill-mcp.test.mjs` 的 SM-12 读源码核对 SKILL 闸那一行，文件路径从 `vite-plugin-ai.ts` 改成 `instance.mjs`，断言不变。

### 42 项状态的落点与契约不一致的地方

逐项对过契约 3.2 的表，一致的不列，不一致的四处：

| # | 契约写的 | 实际 | 为什么 |
|---|---|---|---|
| 4 `activeRuns` | 进程级，每条带所属实例 | 桌面：留在实例里，`runId` 仍是原来的 7 位（行为不变）。托管：没有按 `runId` 找的全局表，进行中的一轮挂在「实例 → 对话」上，停止按对话（第二稿的接口本来就按对话停） | 少一张以页面给的 id 为键的全局表 |
| 5、17、18、25、26 桌面专用的状态（配对表、桌面会话分组、多 Agent 的等待表等） | 托管档不建 | 托管档的实例里也建了这些对象，但没有任何路径用得到它们（路由不挂、工具不开放） | 第一步是逐字搬的，实例就是那个闭包；逐个加 `if` 去掉它们只省几个空的 Map，不值得在桌面路径上多开分支 |
| 39、40 串行锁 | 锁在 SSR 宿主对象上 | 锁在登记表里（进程一把），经 `execSerial` 交给各执行器 | 一个进程只有一个 SSR 宿主，等价；执行器在载入宿主之前就要有锁 |
| 42 作业表 | 单测 CA-TOOL-03 核对 | 这条单测还没写；现在靠开放清单里没有用到作业表的工具保证 | 留给丙块，与逐个工具的冒烟一起做 |

另外两点说明：
- 页面状态按对话存，但切剪辑的三个工具向「页面」要播放头时拿不到对话 id（现有的 `agent-side.mjs` 就是这么调的），用的是这个实例最近一条消息带来的播放头。同一位成员同时开两个对话、都切剪辑时可能用到另一个对话的播放头。丙块里给页面状态的请求带上对话 id 即可。
- `server/agent/agent-sessions.mjs` 多了一行转出（创造力等级的四个名字）：新目录不许直接引用 `src/`，而这个文件本来就引同一个模块。

### 验证结果

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| `npm test`（只搬不改之后） | 4432 项、4431 通过、0 失败、0 取消、1 跳过 |
| `npm test`（加实例之后） | 4449 项、4448 通过、0 失败、0 取消、1 跳过（多的 17 项是新增的） |
| `npm run build` | 成功 |
| 新增单测 `server/test/cloud-agent-service.test.mjs` | 18 项全过（最后加的 CA-DESK-01 在全量之后，单独跑过） |

新增单测逐条：CA-SEAM-01、CA-OWNER-01、CA-MOCK-01、CA-TOOL-02、CA-TOOL-04、CA-ENTRY-02、CA-ENTRY-01/03、CA-MULTI-01、CA-RUN-01、CA-HIST-01、CA-ISO-02、CA-CHAT-02、CA-TOOL-01、CA-PAGE-01、CA-ISO-01、日志不含正文、CA-DESK-01。

两项目互不干扰的断言输出：

```
CA-MULTI-01 {"甲":{"name":"甲","end":5,"label":"甲方","tracks":["序列 1","甲方 加的序列"],"结束":"idle","事件数":35,"只有自己的runId":true,"最后一句":"甲方 完成"},"乙":{"name":"乙","end":7,"label":"乙方","tracks":["序列 1","乙方 加的序列"],"结束":"idle","事件数":35,"只有自己的runId":true,"最后一句":"乙方 完成"},"实例数":2}
CA-ISO-01 {"甲写成":60,"乙写成":60,"被拒":0,"甲最后":"AAA-60","乙最后":"BBB-60"}
```

这两条有没有牙：把进程级的锁去掉（只留各执行器自己的锁）再跑，CA-MULTI-01 与 CA-ISO-01 都变红；恢复后变绿。

### 与 Agent 相关的现有探针

全部在临时目录里跑（数据、导出、对话、`ai.json` 都指到会话的临时目录，不写公共的 `port.json`），进程静默，跑完端口都已释放。

| 探针 | 结果 |
|---|---|
| `skill-mcp-probe`（端口 5880） | 通过，35 项 |
| `creativity-probe`（编辑器 5740） | 通过，15 项 |
| `user-editing-probe`（编辑器 5740） | 通过，18 项 |
| `chat-window-probe`（端口 5743） | 通过，19 项，0 失败 |
| `multi-agent-probe`（它自己的 5840～5859） | 24 项通过、6 项失败。第一阶段（单台编辑器上的多 Agent）全过；第二阶段在第一步 X0「成员的页面进入共享项目」就回 `host-data-missing`，后面 5 项是连带。**在没有本次改动的 `.worktrees/four-stage`（`de03c915`）上用同一套环境跑，结果逐条相同（24 过、同样 6 项失败）**，所以不是这次改动引入的。`host-data-missing` 出自 `server/recovery/`（协作重开恢复），本次没碰。原因没有查：可能是探针落后于 main 的协作恢复改动，也可能是我给探针设的临时环境所致，两边同样失败所以分不出来 |
| `codex-auth-state-probe` | 没跑成：它用相对路径 `node_modules/vite/bin/vite.js` 起编辑器，worktree 里没有 `node_modules`（规矩不许建 junction），编辑器起不来，探针超时。与改动无关；对应的单测 `server/test/codex-auth-state.test.mjs` 在全量测试里通过。要跑得在主工作区跑 |
| `c65-editor-probe` | 没跑：它要一套托管组合加多个角色的参数，这一轮没搭 |

### 没做成的及原因（甲块）

- `multi-agent-probe` 第二阶段、`codex-auth-state-probe`、`c65-editor-probe` 见上表。
- 契约的 CA-TOOL-03、CA-LOG-01 的完整版、CA-GATE、CA-REVOKE、CA-CRASH、CA-RENDER 等属于乙、丙块，没写。
- 事件与对话状态现在只在内存里；落盘、进程重启后的中断标记、用量记录、补渲发布是丙块。

### 乙、丙、丁块开工前还缺什么

- **乙（Agent 服务一侧）**：等主会话把 `claude/cloud-agent-auth` 与第三段合进本分支。要它交付的客户端小模块给出：`authenticate(req)` 能用的「核验委托票据 → 身份」（含 `creator`、`mode`、`username`、`userId`、`access`）、「凭对话委托换连接票据」。接入点已留好：`startAgentService({ authenticate, credentials })` 与 `credentials.protocolsFor(identity, 对话号)`；撤销接到 `service.revoke({ projectId, userId?, reason })`。还缺的一处：对话委托要随「发消息」进来并按对话存在实例里，`protocolsFor` 现在拿不到对话 id，只拿到对话号，接真身份时要把签名改成带对话 id。
- **丙**：不缺外部条件，可以在乙之前或并行做（事件与状态落盘、`runs` 的中断与上限、闸与用量、`set-key`、`admin`）。补渲发布依赖第三段的 R1～R5 落地。`onModelCall` 要改 `server/harness/agent.mjs`。
- **丁**：依赖 `hosted.agent: { available, enabled, url }` 出现在成员列表回包里（第三段与乙的服务端一侧）；界面可以先对着本轮的 HTTP 接口做（发消息、事件流、停止、列表都已可用，鉴权用测试替身）。

## 第三轮：丙块（一轮的生命周期、对话落盘、闸与用量、Key、补渲发布，2026-10-06）

接手时工作区干净，HEAD `3935042a`。做的过程中主会话知会乙块在文档服务一侧已做完（`claude/cloud-agent-auth` 的 `4556aac8`），接口位照它交付的形状对齐了（见「乙块 Agent 服务一侧接线前还缺什么」）。这一轮鉴权、凭证、补渲的发布通道仍是接口位加测试替身，没有连任何远端，语义文档没有改。

### 做了什么

新增的模块都在 `server/agent/service/` 与 `server/agent-service/`，不引用 `src/`（CA-SEAM-01 仍过）。

| 文件 | 管什么 |
|---|---|
| `server/agent/service/conversations.mjs` | 对话存储：`meta.json` 与 `events.jsonl`。事件先追加进文件再发给连着的流；补发与接上实时在同一拍里做；一轮结束时把 `text`、`thinking` 的增量并成整段，补发时按记下的切分拆回原来的一个个增量；进程起来时把没收尾的对话标「中断」；记录 8 MiB 降级、12 MiB 封顶；每个主人每个项目 50 个对话的淘汰 |
| `server/agent/service/create-agent-service.mjs`（重写） | 一轮的生命周期。对话按主人键归属，与运行实例分开；各种收尾各留原因；撤销；进程退出时的收尾；闸的两处入口；补渲的接线；实例连文档服务的凭证 |
| `server/agent/service/gate.mjs` | 闸：`admitRun`、`admitModelCall`、`record`；`limits.json` 改文件即生效；写坏保留上一份 |
| `server/agent/service/usage.mjs` | 用量：每次模型请求一行 JSONL，`totals.json` 检查点，按项目、成员、模型汇总 |
| `server/agent/service/model-config.mjs` | 数据目录里的模型配置与 Key 的密文（沿用 `config-crypt.mjs` 的封装） |
| `server/agent/service/render-request.mjs` | 补渲发布：攒 3 秒、只算被写到且要预渲染的片段、每个计划至多 200 个、新计划发出后撤回旧的、按连续无进度放弃、`pending-render.json` 重启后重发、结果与失败记进对话 |
| `server/agent-service/set-key.mjs`、`admin.mjs` | Key 的录入；额度与用量的管理命令 |
| `server/agent-service/http.mjs`、`main.mjs` | 追加的接口；缺省的模型配置改读数据目录 |

改到的现有文件：

- `server/harness/agent.mjs`：可选的 `onModelCall(phase, info)`（每次模型请求前后各一次）。`server/runners/api.mjs`：透传它；可选的 `checkpoint`（每完成一次工具往返落一次模型历史）；错误事件带上 `runErrorCode`。桌面都不传，行为不变。
- `server/agent/agent-exec.mjs`、`agent-side.mjs`：向页面要页面状态时把「是哪个对话要的」带上（桌面的页面通道仍按原来的空对话 id 分发，另放在 `ctx.pageStateFor` 里）；可选的 `onWrite`（一次写入落地后告诉宿主写到了哪些片段）。
- `server/agent/doc-link.mjs`：可选的 `onFinalClose`。给了它，文档服务以 4003、4004 关掉连接时报给宿主并且不再重连；不给时与原来相同。
- `server/agent/service/instance.mjs`：托管档的分支——凭证接口带对话 id；页面状态按对话找；发起方在线的判定；切剪辑的三个工具离线时的注明；单个项目副本 16 MiB 的上限。
- `server/harness/providers/mock.mjs`：`fail` 认 `{{apiKey}}`、`{{baseUrl}}` 两个占位（测「报错里带着 Key」时不用把 Key 写进提示词）。
- `server/test/cloud-agent-service.test.mjs`：共用的搭法搬到 `cloud-agent-kit.mjs`；两条断言改了——CA-CHAT-02 的列表项只比原有四个字段（现在多了 `title`、`updatedAt`、`startedOn`）；CA-PAGE-01 按契约 9.4 改成「发起方连着看才回选区」。

逐项对着主会话给的清单：

1. **一轮与事件**：发消息回 202 之后这一轮与任何连接无关。事件按 `seq` 先存后发；`GET …/events?after=N` 先补发再接实时，无缺无重（单测与探针都拿「分两段看到的」与「一口气看完的」逐事件对比）。
2. **每种收尾各留原因**（`meta.json` 与事件记录同步）：

   | 怎么结束 | `end.state` | `meta.reason` | 事件记录里那句话 |
   |---|---|---|---|
   | 说完 | `idle` | — | — |
   | 主人停掉 | `idle` | `stopped` | 状态事件「已停止」 |
   | 模型调用失败 | `failed` | `model` | 「模型调用失败:〈接口给的原因，去掉 Key 与地址〉」 |
   | 额度用尽 | `failed` | `quota-exceeded` | 「这个项目的云端 Agent 额度已用完(已用 X / 上限 Y)。请联系托管方。」 |
   | 到上限（24 次往返或 30 分钟） | `failed` | `limit` | 「这一轮超过了 30 分钟的上限…」或「这一轮到了 24 次模型往返的上限…」 |
   | 撤销 | `revoked` | `disabled`、`removed`、`kicked`、`deleted`、`expired`、`generation`、`bad-grant` | 各一句，如「项目创建者已关闭云端 Agent,这一轮已停下。已经落地的改动保留在项目里。」 |
   | 服务进程退出或被杀 | `interrupted` | `interrupted` | 「云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。」 |

   渲染失败不是一轮的收尾，记成这个对话的 `render` 事件（`failed`，带片段与原因）。每次工具写入是文档服务的一次原子提交，所以一轮在任何时刻被停，项目都停在最后一次成功提交之后；单测逐种断言「之后没有新的写入」。
3. **进程被杀之后**：起来时扫 `meta.json`，`running` 的改成 `interrupted` 并在事件记录末尾补说明与 `end`；不自动续跑；接着发消息就是新的一轮，模型历史接着上一次落盘处（每完成一次工具往返落一次），没有悬空的工具调用。
4. **停掉与换设备**：对话按主人键找，主人从任何设备都能看、能停、能接着说；归属键用身份一侧给的 `ownerKey`，没给（测试替身）时按同一条规则从 `creator`、`mode`、`username`、`userId` 推。
5. **G 的闸**：两处入口都接上；`limits.json` 每次过闸前看修改时间；用量每次模型请求一行；管理命令 `admin.mjs`。并发与资源上限见下表。
6. **F**：`set-key.mjs` 与 `--mock`、`--clear`。
7. **J**：发起方在线的口径是「此刻有一条来自发起这一轮的那个 `userId` 的事件流连着这个对话」。`get_selection` 不在线时立刻回「发起方不在线」；切剪辑的三个工具不在线时照常执行、播放头按 0 记、结果里带 `initiatorOffline: true` 与 `note`。甲块留的串对话已修：播放头按要它的那个对话找。
8. **CA-TOOL-03** 已写。
9. **补渲发布**：逻辑做全，发布通道是接口位（形状写在 `render-request.mjs` 文件头）。不给发布通道时这个模块什么都不做、什么事件都不发。

契约第 11 节的上限，做了的与没做的：

| 项 | 状态 |
|---|---|
| 同时进行的一轮：全节点 6、每项目 3、每成员 2 | 做了（闸；满了回 `busy`，不排队） |
| 存活实例 24 | 做了（数字跟 `limits.json` 的 `node.maxInstances`） |
| 单个项目副本 16 MiB | 做了（一轮开始时判，回 `too-large`） |
| 一轮 24 次往返、30 分钟 | 做了 |
| 单次工具 60 秒 | **没做**：开放的工具除 `wait`（至多 30 秒）外都是同步实现，目前不会超；没有另加计时器 |
| 补渲 200 个、10 分钟无进度、12 小时 | 做了 |
| 事件记录 8 MiB 降级、12 MiB 封顶 | 做了 |
| 请求体 256 KiB | 甲块已有 |
| 事件流每个主人 8 条、全节点 200 条 | 做了 |
| `history.json` 8 MiB | **没做**：仍靠驱动按 token 数截断 |
| V8 堆、PM2 内存、`nice` | 部署项，不在这一块 |

### 与契约不一致的地方

| 处 | 契约写的 | 实际 | 为什么 |
|---|---|---|---|
| 8.2 `SIGHUP` | 录入后给服务发 `SIGHUP` 重读配置 | 不发信号：服务每一轮开始时现读配置文件 | 更简单，Windows 上也没有 `SIGHUP`；效果相同（不用重启） |
| 8.1 配置位置 | 沿用 `server/ai-config.mjs`，用 `PROMPTCUT_AI_CONFIG` 指到数据目录 | 另写了 `model-config.mjs`，路径只由数据目录定，不读环境变量 | 甲块的缺省实现在没设环境变量时会读到这台机器上用户自己的 `ai.json`；封装仍是同一套 |
| 16.2 优先级 | 「优先级用补渲那一档」 | `normal`（与在线页面发的清单计划逐字段相同） | 同一节又要求形状与在线页面的相同，CA-RENDER-01 也按后者断言；队列的校验里清单计划必须是 `normal` 档 |
| 16.2 撤回 | 新计划发出后撤回旧的 | 撤回之外，旧计划里还没渲完的片段并进新计划 | 否则先改的片段在新版本上没有计划 |
| 2.4 `render` 事件 | `{ state, clips, done?, total?, reason? }` | `published` 多带一个 `plans`（这一批分成了几个计划） | 追加字段 |
| 3.1 实例键 | 项目 × `userId` | 项目 × `userId` × 主人键 | 同一台设备先后以创建者与普通成员身份进来时不共用实例里以对话 id 为键的状态 |
| 7.3 进程退出 | — | `end` 先进事件记录、`meta.json` 后改；两步之间被杀的话，起来时会在已有的 `end` 后面再补一条中断 | 窗口极小，没有专门处理 |

### 给丁块：HTTP 接口有没有改

已有的路径、方法、事件流格式、`seq` 语义**都没改**。只追加：

- `GET /v1/conversations/<id>` → `{ ok, meta: { id, title, updatedAt, state, reason, lastSeq, startedOn, message, runId } }`；`PATCH`（`{ title }`）；`DELETE`。不存在的与别人的一律 404 `not-found`。
- `GET /v1/usage?since=<毫秒>` → `{ ok, project: { tokens, calls }, members: [{ username, tokens, calls }] }`。
- `GET /v1/info` 多了 `render: { enabled }`、`models`、`defaultModel`、`configured`、`mock?`、`usage: { tokens, limitTokens, window }`；原有的 `enabled`、`limits`、`running` 还在。`running` 现在按主人算（换设备也看得到在跑的对话）。
- `GET /v1/conversations` 的列表项在 `id`、`state`、`reason`、`lastSeq` 之外多了 `title`、`updatedAt`、`startedOn`，按最近动过的在前。
- 发消息的请求体多收 `grant`（对话委托）。
- 新的错误：`no-model-key`（503）、`too-large`（413，对话记录封顶）、事件流超上限时 `busy`（429）。
- 事件：`error` 都带 `code`（`model`、`quota-exceeded`、`limit`、`revoked`、`interrupted`、`unavailable`、`too-large`）；多了 `render` 事件，它出现在一轮的 `end` **之后**（补渲的进展晚于这一轮）；`diagnostic` 只剩 `configuration`、`request`、`response` 三种。
- 需要丁块注意的一条行为：`get_selection` 只有在发起方的事件流连着时才回选区。页面发完消息要尽快接上事件流（真实模型的第一次请求要一两秒，来得及）。

### set-key 的用法（将来写给用户照着做）

```
1. 用 SSH 登录到节点（不要用  ssh 主机 "命令"  的形式，Key 不要出现在任何命令里）。
2. 运行：
     cd <部署目录> && PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/set-key.mjs
3. 按提示依次输入：
     厂商（anthropic / openai / gemini）
     接口地址（用厂商官方地址就直接回车）
     模型清单（多个用 | 分隔，第一个是缺省）
     单次回复的 token 上限（直接回车是 4096）
     Key（输入时屏幕上不显示，输完回车）
4. 看到「已保存,末四位 ××××。运行中的服务下一轮对话起就用它,不用重启。」就是成了。

换 Key：再运行一次。
删掉 Key：加 --clear。
切到模拟模型（验收与排查用，不调用任何真实模型）：加 --mock；换回真实模型就不带参数再运行一次。

不要把 Key 发到任何对话里。脚本不接受命令行参数或环境变量里的 Key，标准输入不是终端（管道、重定向）时也拒绝录入。
Key 的密文存在 <数据目录>/config/keys/custom.key，口令由这台机器的指纹派生：节点重装系统或换机器后要重新录入。
这层封装挡的是「明文躺在文件里」，挡不住能以同一个系统用户在节点上运行程序的人。
```

额度与用量（托管方在节点上运行，改了即生效，不用重启）：

```
PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/admin.mjs quota set <projectId> --tokens <N> [--window total|month|day] [--runs <N>]
PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/admin.mjs quota clear <projectId>
PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/admin.mjs quota show [<projectId>]
PROMPTCUT_AGENT_DATA=<数据目录> node server/agent-service/admin.mjs usage [--project <projectId>] [--since 2026-10-01] [--json]
```

### 乙块 Agent 服务一侧接线前还缺什么

接口位已按乙块交付的形状（`server/auth/service-client.mjs`）对齐，合流时在 `server/agent-service/main.mjs` 的命令行入口里把它们接上即可：

| 接口位 | 现在的替身 | 接真的 |
|---|---|---|
| `authenticate(req)` | 测试里从 `Bearer test:…` 取 | `client.verifyDelegation(委托票据)`，结果原样当身份（它回的 `ownerKey` 直接用）；按票据摘要缓存 15 秒；`service-disabled` 回 403 `disabled`，其余 401 |
| `credentials.protocolsFor(identity, 对话号, { conversationId, grant })` | 回环的 agent 角色项 | `client.memberTicket({ projectId, conversation, conversationId, delegation: grant })` 加 `client.dataProtocols(ticket)`；失败时抛带 `reason` 的错（`expired`、`generation`、`service-disabled`、`banned`、`not-listed`、`no-project` 等会让这一轮按原因收尾；`unavailable`、`timeout` 当暂时性故障） |
| `credentials.admitGrant(identity, conversationId, grant)`（可选） | 没有 | 发消息时先 `client.verifyDelegation(grant)`，核对它是这个对话的、这位成员的；不对回 `bad-grant` |
| `projectState.agentEnabled(projectId)`、`renderEnabled(projectId)` | 恒为开 | `client.watch` 推来的各项目开关 |
| `service.revoke({ projectId, userId?, reason })` | 测试里直接调 | 数据连接被 4003、4004 关掉时实例已经会自己调；`client.watch` 推来「开关关了」「项目没了」时再调一次（没有进行中对话的闲置实例也关掉） |
| `publisher`（补渲） | 测试替身 | `availability` 读渲染的开关；`open` 用 `client.publishTicket(projectId)` 开发布连接、发 `publisher.hello`，期间用 `client.demand(projectId)` 让项目保持活跃；`publish` 发 `task.publish`；`withdraw` 用 `task.unsubscribe`（乙块说明队列现在没有 `task.withdraw`）；`codeVersion` 用 `server/frame-code.mjs` 的 `frameCode` |

还要知道的三点：

1. **实例自己的那条连接**（执行器里没有对话 id 的那一个，兼做项目副本的订阅）没有自己的对话委托。现在的做法是借这个实例里一个有委托的对话的 id 与委托去换票据。后果：那个对话的委托过期（60 分钟）之后，这条连接若断了、而实例里别的对话没有更新的委托，就换不出票据，要等这位成员的下一条消息。一轮的上限是 30 分钟，正常用不到；写在这里备查。
2. 探针与单测现在用的文档服务是内存里的 `lan` 模式；4003、4004 关连接那条路只有 `doc-link.mjs` 的代码与 `revokeReasonOfClose` 的单测，**没有对着真的文档服务跑过**，合流后要用乙块的隔离探针补上（契约的 CA-REVOKE-01、CA-GRANT-02、CA-GRANT-03）。
3. 命令行入口 `main.mjs` 现在仍然没有凭证（除 `/healthz` 外一律 401），也没有读 `PROMPTCUT_AGENT_PUBLIC_ORIGIN`、`PROMPTCUT_AGENT_SECRETS`；这两项跟着接线一起做。

### 没做成的及原因

- 契约第 11 节的「单次工具 60 秒」与 `history.json` 8 MiB：见上表。
- 契约里要合流之后才能写的单测：CA-AUTH 全部、CA-REVOKE-01 的「对着真的文档服务」、CA-GRANT-01～03、CA-RENDER-04、CA-ISO-03、CA-ISO-04 的完整版。
- 补渲发布没有对着真的队列跑过（依赖第三段的队列改动）。
- `multi-agent-probe` 第二阶段与 `codex-auth-state-probe`：主会话说明不归这一轮。

### 改动若碰到任务书没列的用户可见行为

没有新增的。有一条口径请主会话知道：云端下 `get_selection` 要求发起方此刻连着看，页面发完消息到接上事件流之间若模型已经调了它，会得到「发起方不在线」。这是契约 9.4 的字面规定，不是这一轮加的。

### 验证结果

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| `npm test` | 4479 项、4478 通过、0 失败、0 取消、1 跳过（甲块后是 4449 项；多的 30 项是新增的）。第一遍卡在 `codex-auth-state.test.mjs`（已知的偶发卡死，日志 13 分钟没有输出），只结束了这一遍自己起的四个进程后重跑，第二遍一次通过 |
| `npm run build` | 退出码 0 |
| `server/test/cloud-agent-service.test.mjs`（甲块的 18 条） | 18 项全过 |
| `server/test/cloud-agent-runs.test.mjs`（新增） | 29 项全过 |
| `scripts/probes/cloud-agent-run-probe.mjs`（新增） | 17 条断言全过，退出码 0，跑了两遍都是 17 条全过（下面贴的是第一遍的原文） |

新增单测逐条（编号是契约 13.1 的）：事件记录的合并与补发；CA-GATE-04 / CA-GATE-05；用量记录的检查点与重建；CA-KEY-01；CA-CHAT-01；CA-RUN-02 / CA-RUN-03；CA-RUN-04；CA-RUN-05（内含 CA-KEY-02、CA-REVOKE-03）；CA-GRANT-04 / CA-LOG-01；CA-CHAT-03（两条）；CA-REVOKE-02；CA-GATE-01；CA-GATE-02；CA-GATE-03；CA-CRASH-01；CA-PAGE-01；CA-TOOL-03；CA-RENDER-01；CA-RENDER-02（三条）；CA-RENDER-03；追加的 HTTP 接口。

CA-TOOL-03 的输出：66 个开放的工具逐个跑一遍，没有任何 HTTP 请求发出去，作业表与结果表没有被碰；其中 22 个用最小参数跑通，44 个各自报了参数或对象不存在的错（按名字顺序跑，`add_cut` 之后当前剪辑是空的，后面点名片段与序列的都报「找不到」）。

小探针逐条断言的结果原文：

```
环境:Agent 服务 http://127.0.0.1:5741(子进程 26812),文档服务 ws://127.0.0.1:8798/docservice,模型 模拟提供方 mock-1,数据目录在系统临时目录下
PASS A1 发消息回 202,带 runId 与 seq —— runId 40c6aaa3…,seq 1
PASS A2 看到第 2 个工具结果后断开事件流;没有任何流连着,这一轮照跑到结束 —— 断开时看到 seq 16、状态 running;之后无人连接,结束时 lastSeq 47、状态 idle
PASS A3 6 次写入全部落进文档服务,版本连续加 6 —— 版本 1 → 7,片段文案「第 6 次改」
PASS B1 按 after=<最后看到的 seq> 重连:补到 end —— 补发 31 条(seq 17～47)
PASS B2 断开前看到的加补发的,与 after=0 一口气看完的逐事件相同;seq 连续,无缺无重 —— 共 47 条,seq 1～47
PASS B3 一轮还在跑时重连:先补发、再接实时直到 end;与事后 after=0 看到的逐事件相同 —— 第一段看到 seq 57 断开,换设备从 58 接到 88(含实时部分),与整段 41 条相同
PASS C1 一轮进行中结束 Agent 服务进程;进程确实没了 —— 结束了进程 26812(SIGKILL),端口 5741 连不上
PASS C2 重新起来后:状态 interrupted,原因可读;事件记录末尾是中断说明与 end —— 新进程 38620;状态 interrupted;原因原文「云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。」
PASS C3 不自动续跑:info.running 为空;项目停在被杀前最后一次成功写入的版本上 —— running=[];版本仍是 13,文案「被杀前落地的」
PASS C4 可以重开:接着发一条消息,新的一轮正常跑完,seq 接着往后 —— 新一轮从 seq 21 起,结束状态 idle
PASS D1 额度设成很小的数:发消息被明确拒绝,话里带已用与上限 —— HTTP 429 {"ok":false,"code":"quota-exceeded","message":"这个项目的云端 Agent 额度已用完(已用 17456 / 上限 10)。请联系托管方。"}
PASS D2 一轮中途超额:当前这次模型请求不发,事件里有原因,已落地的改动保留 —— 事件原文 {"code":"quota-exceeded","message":"这个项目的云端 Agent 额度已用完(已用 17561 / 上限 17457)。请联系托管方。"};模型请求只多了 1 次;片段停在「额度内的一步」
PASS D3 设回不限:不重启服务,再发消息恢复正常 —— HTTP 202,结束状态 idle,服务进程仍是 38620
PASS D4 用量记录里查得到项目、成员、模型与用量(管理命令与 /v1/usage 一致) —— 管理命令:项目 p-probe 20 次 18510 token,成员 {"alice@dev1":{"username":"alice","tokens":18510,"calls":20}},模型 {"mock/mock-1":{"tokens":18510,"calls":20}};流水最后一行 {"t":1791286261645,"projectId":"p-probe","userId":"alice@dev1","username":"alice","conversationId":"c-quota","runId":"41e39193-5549-49bd-991a-4218987ca983","vendor":"mock","model":"mock-1","input":547,"output":3,"cacheRead":0,"ok":true,"ms":0}
PASS E1 发起方没有连着看时,读选区的工具立刻回「发起方不在线」 —— 工具结果原文 {"ok":false,"initiatorOffline":true,"error":"发起方不在线,读不到页面的选区。请按项目内容继续,不要等待。"}(耗时 1 ms)
PASS E2 这一轮不卡住,继续跑完 —— end 状态 idle;之后的写入落地,文案「发起方不在也照做」
PASS E3 发起方连着看时,同一个工具回发消息时的选区 —— 工具结果开头 {"ok":true,"ids":["c1"],"clips":[{"id":"c1","cardId":"title"…

共 17 条,通过 17,失败 0
```

探针里的 Agent 服务是另一个真实进程，「进程被杀」是真的结束它；鉴权与凭证是测试替身，文档服务是本进程里内存的那一个。

桌面版的 Agent 行为不退步，四个探针在本分支上重跑（数据、导出、对话、`ai.json` 都指到临时目录，不写公共的 `port.json`；跑完端口都已释放）：

| 探针 | 结果 |
|---|---|
| `skill-mcp-probe`（端口 5880，它自己限定只许用 5880～5899） | 通过，35 项，0 失败 |
| `creativity-probe`（编辑器 5740） | 通过，15 项 |
| `user-editing-probe`（编辑器 5740） | 通过，18 项 |
| `chat-window-probe`（端口 5743） | 通过，19 项，0 失败 |

这一轮没有改画面，没有看图。
