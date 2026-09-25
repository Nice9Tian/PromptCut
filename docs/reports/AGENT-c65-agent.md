# AGENT 报告：c65-agent（C6.5 第 5 节：Agent 一侧）

分支 `claude/c65-agent`（基于 `claude/c65` 的 `806503d`），worktree `.worktrees/c65-agent`。
依据 `docs/plan/c65-design.md` 第 5、7、8、13 节，`c65-ops-spec.md`，`cloud-task.md` 的 D1、D2、D4，`auth-contract.md` 第 5、6、8、14 节，`AGENT-c65-integ.md` 第 7 节遗留清单，以及主会话中途的裁定（第 6 节）。

状态：六项都做了，基线、G0-R、两个探针的结果见第 4 节。没有推送，没有合并。

## 1. 做了什么

| 文件 | 改动 |
|---|---|
| `server/agent/doc-link.mjs`（新） | Agent 服务端到文档服务的连接与项目副本。**一个对话一条 `agent` 连接**（理由见第 5 节第 1 条）；第一条兼做订阅（`project.open`，收 `project.state` 与别人的 `project.ops`）；副本按 `rev` 排队、连续才应用、重复丢掉、缺口超过 2 s 或应用失败就重新 `project.open`；应用用文档服务同一份 `json-ops.mjs`，副本与真身逐字节相同。凭证按对话号由调用方给 |
| `server/agent/agent-exec.mjs`（新） | 工具执行器：`side: "agent"` 的工具在副本上跑 `src/mcp/handlers`，`diffProject` 算操作，以对话连接、带 `expectRev` 提交；`stale` 回错附 `since` 摘要；读工具读副本、回包带 `rev`；每个调用发创建 / 完成事件，成功的写带 `opId`、`rev`、`inverse`；页面侧工具的写入归属（`notePageWrites`）；聊天栏可视化记录（原页面 `withVisual` 的服务端版） |
| `server/agent/ssr-host.mjs`（新） | 用 `ssrLoadModule` 载入卡片与部件注册表、`src/store/core.ts`、`src/mcp/api.ts`、`routes.mjs`、`diffProject.ts`、`common.ts`，给执行器一个 `setProject / getProject / callRoute / diffProject / frameLayoutOf / stageSize` 的壳 |
| `server/vite-plugin-ai.ts` | 新接口 `/api/agent/bind`、`/api/agent/unbind`、`/api/agent/ticket`、`/api/agent/status`；`callToolInternal` 绑了副本时经 `executor.track` 包一层事件，按 `side` 分派（`dispatchTool`）；页面回包带 `opIds` 时调 `notePageWrites`；文字回复在下一次工具调用或本轮结束时推 `events.text` |
| `server/tools/*.mjs`、`server/mcp-tools.mjs` | 117 个原 `side: "browser"` 的工具逐条改标 `agent`（67）或 `page`（50），`wait`、`report_progress` 仍是 `server`；`mcp-tools.mjs` 写明三种取值，新增 `toolGroups`（工具名 → 分组，事件的 icon） |
| `server/auth/handshake.mjs` | 回环来源只带 `promptcut.role.agent.<n>`（不带本机声明）→ `{ ...本机身份, role: 'agent', conversation: n }`：本机 `local` 空间里 Agent 的写入身份记成「agent + 对话号」（integ 报告第 7 节遗留） |
| `server/docservice/modules/events.mjs` | `events.complete` 透传 `opId`、`rev`、`inverse`（逆操作上限 256 KiB，带 `inverse` 必须带 `opId`），可带 `detail` 把 `event-detail` 按同一个键补写一次（主会话裁定第 1 条） |
| `src/mcp/apiUrl.ts`（新）、`src/mcp/common.ts`、`src/mcp/handlers/cards.ts`、`src/mcp/handlers/vision.ts` | 服务端执行的 handler 里打 `/api/...` 的相对地址换成 `apiUrl(...)`：页面里原样相对，服务端载入后 `setApiBase("http://127.0.0.1:<端口>")`。涉及 `measure_audio`、`create_card`、`get_card_source`、`edit_card`、`card_authoring_guide` |
| `server/queue-publish.mjs`（新）、`server/vite-plugin-frames.ts`、`server/render-node/project-client.mjs` | 预渲染发布方定版本：无真身照老流程（announce 发号 + 上传快照）；有真身不发号、不上传，以真身的 `rev` 发布 `plan`，页面推来的与真身不同就不交给队列（本机自己产）。`project-client` 的 `announce` 回包透传 `authoritative / digest / matches` |
| `server/test/agent-c65.test.mjs`（新） | AG-1～AG-11 |
| 测试里 `side === 'browser'` 的断言 | `mcp-routes.test.mjs`、`tool-schema.test.mjs`（改成 `page` 或 `agent`）；`filterTools.test.mjs`、`audioFxTools.test.mjs`、`trackTools.test.mjs`（改成 `agent`）。只改了 `side` 的取值，别的断言一条没动 |

## 2. 工具 side 全表

`agent`：绑了项目副本时在 Agent 服务端执行（写入经文档服务，带期望版本）；没绑（页面没接文档服务、无头实例停用了文档服务）时照旧经页面。`page`：只在页面执行。`server`：服务端就地执行，不碰项目。

| 分组 | agent | page | server |
|---|---|---|---|
| project | get_project（读副本）、list_media、set_theme、list_media_effects | get_selection、set_project_meta、import_media | |
| clips | add_clip、update_clip、remove_clip、duplicate_clip、split_clip、get_clip、set_clip、set_emphasis | | |
| layout | set_position、set_rect、align、nudge、get_layout（读副本 + 预渲染量实体框）、set_camera3d | | |
| tracks | add_track、list_tracks、remove_track、update_track、move_track | | |
| parts | list_parts、add_composite、add_part、set_part、remove_part、move_part | | |
| effects | list_filters、create_filter、update_filter、remove_filter、apply_filter、list_pixel_maps、create_pixel_map、update_pixel_map、remove_pixel_map、apply_pixel_map | | |
| cuts | list_transitions、add_transition、remove_transition、list_cuts、rename_cut | switch_cut、add_cut、remove_cut | |
| audio | set_clip_volume、separate_audio、measure_audio、create_audio、list_audio_fx、create_audio_fx、update_audio_fx、remove_audio_fx、apply_audio_fx | voice_list、voice_generate | |
| ai | detach_clip_motion、get_transcript、fill_captions、list_captions、edit_caption | detect_shots、list_shots、track_points、get_track、track_status、track_install、detect_subjects、list_subjects、subject_status、subject_install、attach_clip_motion、stt_status、stt_install、transcribe_media | |
| cards | card_authoring_guide、get_card_source、edit_card、inspect_card_dom（读副本）、create_card、apply_card、bake_card（读副本） | list_cards | |
| vision | see_frames（成片读副本；`source: "media"` 交页面）、get_gif（读副本） | | |
| collect | | collect_status、collect_install、collect_search、collect_probe、collect_download、collect_job、collect_login、collect_login_check、collect_logout | |
| browser | | web_open、web_view、web_click、web_type、web_scroll、web_read、web_handoff、web_close | |
| agent | | declare_scope、list_agents、send_message、check_messages | |
| core | | background_job_status、auto_workflow、auto_workflow_status、seek、play、pause | wait、report_progress |

合计 agent 67、page 50、server 2，共 119。AG-10 钉住这张表的取值范围与几个代表。

## 3. 留在页面的工具与理由

按 `cloud-task.md` D1 的判据（只读页面独有状态、既不写项目也不写卡片的留在页面），加上设计稿第 12 节「个别依赖页面状态的 handler 需要改成只读页面状态、或者留在页面」。逐个：

**只读页面独有状态**（判据本身）

| 工具 | 页面状态 |
|---|---|
| get_selection | 选区 |
| seek、play、pause | 播放头交互 |
| web_*（8 个，含 web_handoff） | Agent 浏览器面板（页面里的子 webview、顶栏页签） |
| declare_scope、list_agents、send_message、check_messages | 多 Agent 公告板在页面内存里（`src/ai/agentBus.ts`） |
| list_cards | 卡库对 Agent 露多少由页面的可见性设置决定（`editor/cardScope.ts` 的 `readVisibility` 读 localStorage）与页面缓存的归属表 |
| background_job_status、auto_workflow_status、list_shots、list_subjects、get_track | 查的是页面内存里的作业表（`sttJobs`、`shotJobs`、`trackResults` 等），服务端没有这些表 |

**依赖页面状态又会写项目的**（留在页面，没改成只读）

| 工具 | 为什么不搬 |
|---|---|
| set_project_meta | 设 `duration` 要同时写页面状态 `durationManual`（手动截断），只写项目的话页面时间轴会按内容末尾把总时长改回去（handler 注释原话的情形） |
| switch_cut、add_cut（缺省会切过去）、remove_cut（删当前剪辑时会切） | 切剪辑要把页面播放头写进被停放那条剪辑（`kernel/cuts.ts` 的 `switchCut(p, cutId, t)`），并把页面的播放头、选区、`durationManual` 重置 |
| attach_clip_motion | 读页面内存里 `track_points` 跑出来的轨迹（`trackResults`）再写项目 |

**后台作业完成时才写项目，或要用浏览器能力**

| 工具 | 为什么不搬 |
|---|---|
| detect_shots、detect_subjects、track_points、transcribe_media | 立即回 jobId，作业跑完时才在页面里 `setMediaShots / setMediaSubjects / 写文字稿`。服务端的一次写入只覆盖一次工具调用，后到的写入没有地方提交；这些后到的写入在页面接上文档服务后以页面会话的身份落地 |
| import_media、voice_generate | 要浏览器能力（`File` / `Blob`、`<video>` / `<audio>` 探测时长宽高、blob 地址），且上传是异步的 |
| collect_*（9 个） | 下载作业表在页面内存里，下完在页面里登记素材；`collect_login` 在编辑台里弹登录框 |
| stt_status、stt_install、track_status、track_install、subject_status、subject_install、auto_workflow | 安装 / 编排作业登记在页面的作业表里，和上面的 `background_job_status` 是一套；`auto_workflow` 是一段长编排，途中多次写项目 |
| voice_list | 不写也不读项目，只转发配音配置接口；实现（`src/ai/voice.ts`）用相对地址，留在页面不影响写入一致性 |

`see_frames` 的 `source: "media"`（素材镜头拼图）会跑镜头识别并写回项目，执行器对它回 `undefined`，照旧交页面。

建议（不在本任务范围）：把页面的作业表与后台写入迁到服务端之后，上面第三类可以整体搬过来；那时 `set_project_meta` 的 `durationManual` 需要先进项目或另立字段。

## 4. 验证

### 4.1 新增用例（AG-*）

`node --test server/test/agent-c65.test.mjs`：

（待填）

### 4.2 基线

（待填）

### 4.3 本机 dev server 冒烟（5500）

（待填）

### 4.4 G0-R

（待填）

### 4.5 探针

（待填）

## 5. 与设计稿、任务书不一致之处，以及歧义的处理

1. **「一条 agent 角色连接」→ 一个对话一条连接**。设计稿第 5 节「Agent 服务端作为一条 `agent` 角色的连接接入文档服务，每个对话一个对话号」，第 13 节又说「Agent 服务端一条连接上跑多个对话」。但写入身份 `actor` 只取连接的 principal（`auth-contract.md` 第 6 节、`actor.mjs`），对话号是握手时定死的；一条连接上跑多个对话，所有对话的写入都会记成同一个对话号，达不到任务书「写入 actor 必须带 role:'agent' 与 conversation」。所以每个对话各开一条连接（用到时才连），第一条兼做订阅；共享项目下每个对话各要一张 `c` 不同的连接票据，这与票据形状 `{ k: 'conn', r: 'agent', c: 对话号 }` 一致。覆盖通知 `project.overwritten` 按写入身份投递，一对话一连接时天然分到对的对话。
2. **对话号怎么来**：页面的对话 id 是字符串（`conversationId`），票据与握手要正整数。Agent 服务端按对话 id 首次出现的顺序在本进程内发号（1、2、3……），`session` 记 `agent:<对话 id>`（没带 id 的调用是 `agent:default`）。编辑器重启后号码重发，同一对话前后两次启动的号码可能不同；`session` 保持不变，可以据此认同一个对话。
3. **绑定由页面发起**：Agent 服务端要知道页面在编辑哪个项目、连的是哪个文档服务，设计稿没写这一步。我加了 `POST /api/agent/bind`（第 7 节），没绑时一切照旧（写工具经页面），所以本分支单独合进去时不改变现有行为，页面接线（c65-editor）之后才生效。
4. **期望版本取「这个对话最后读到的版本」**：任何在副本上执行的工具（读工具、没产生改动的写工具）把它推到当时的副本版本；写入落地推到新版本（主会话裁定第 2 条）；被拒不推。从没读过的对话第一次写入用当时副本的版本。这意味着页面在对话读后改了**任何**地方，对话的下一次写入都会被拒一次 —— 这是语义「和当前版本不符就拒绝……由它重读后再改」的原样，不是按实体判。
5. **被拒之后等副本追上**：`stale` 回包里有 `currentRev`，执行器先等副本到这一版（最多 2 s）再回错，Agent 紧接着重读就能读到期间落地的改动，重读后的写入不会因为副本还没追上而再被拒一次。
6. **handler 抛错时整次作废**：页面上 handler 抛错时，抛错之前已经做的 store 修改会留下（例如 `update_clip` 先改了参数、后面才发现 `trackId` 不对）；服务端执行时整次不提交（AG-4）。行为比以前更干净，但与页面上的老行为不同。
7. **读工具回包的 `rev`**：对象形状的回包加一个 `rev` 字段（已有同名字段的不动）；数组形状的回包（`list_media`、`list_tracks`、`list_parts`、`list_filters` 等）不改形状、不加 `rev`，执行器照样记下这次读到的版本。
8. **一次写入太大**：`diffProject` 超过 500 条会变成根替换，序列化后超过 256 KiB 的提交文档服务会拒；Agent 侧在发出去之前就拦下回错（发出去的话会超过连接的单条上限、把连接断掉）。页面那边这种情况走 `project.upload`，Agent 这边没接（一次工具调用改出 256 KiB 的差异很少见）。
9. **预渲染发布方**：任务书说「不再 announce + 上传快照」。我保留了一次 `project.announce`，但只当询问用：有真身时文档服务对它不发号、不改状态，回真身的版本号与摘要（c65-docservice 就是这样设计的），这是拿到真身 `rev` 最轻的办法（`project.open` 要把整份项目传一遍）。快照不再上传。页面推来的那一份与真身不同时不交给队列（本机自己产）：队列产的是真身那一份，本机那一版等不到结果。节点在真身又前进之后才来取旧版本时，文档服务回 `missing`，那个任务按 `no-snapshot`（可重试）失败；页面随即会为新版本再 preload 一次，旧版本本来也不需要了。
10. **读工具之外的「看」**：`see_frames` 没给时刻时用页面推来的播放头（`latestPlayhead`），`get_layout` 同样按页面播放头量实体框，与原来页面上的行为一致。
11. 加卡等 action 原来会顺手把页面选区设成新卡（`set({ selection })`）；服务端执行时这个副作用落在服务端的 store 上，页面选区不再跟着 Agent 跳。我认为这样更对（Agent 不该抢用户的选区），但与以前不同。

## 6. 主会话中途的裁定与落实

| 裁定 | 落实 |
|---|---|
| 1. `opId` 与 `inverse` 放在完成事件里（扩展 events 模块透传），完成时补写一次 event-detail（含 `opId`、`inverse`、结果摘要） | `events.mjs` 的 `complete` 透传 `opId`、`rev`、`inverse`，`detail` 补写同一个键；执行器的完成事件带 `detail: { tool, args, summary, opId, rev, inverse }`，超过内容库上限时依次去掉逆操作、参数（标 `inverseOmitted` / `argsOmitted`）。AG-5、AG-8 |
| 2. 写成功后期望版本更新为这次写入后的 rev | `markRead(conv, reply.rev)`。AG-4 连写三次版本号 2、3、4 |
| 3. 每个工具调用（读也算）都发创建 / 完成；只有成功的写带 `opId` 与 `inverse` | `track` 包住所有工具（不论哪一侧）；被拒的写、读工具的完成事件不带这些字段。AG-5 |
| 4. 撤销冲突按「不同于原写入身份」判 | 页面侧的事（c65-editor）。Agent 这边的写入身份是 `{ userId, deviceId, role: 'agent', conversation, session }`，事件的 `actor` 与 `project.ops` 的 `actor` 相同，页面可以直接比 |
| 5. `set-creator-password` 不作废票据 | 不在本分支 |

## 7. 给 c65-editor 的接口说明

**绑定**（页面接上文档服务、打开项目之后）：

```
POST /api/agent/bind   { projectId, mode?: "local" | "lan-host" | "ticket", url? }
  → 200 { ok: true, projectId, mode, url } | 400 { ok: false, error }
POST /api/agent/unbind {}          换项目、断开文档服务时
GET  /api/agent/status             诊断:bound、mode、各对话 lastRead、副本 rev、统计
```

- `local`：本机未共享的项目（`local` 空间）。Agent 服务端连本编辑器的 `ws://127.0.0.1:<端口>/docservice`，子协议 `promptcut.v1` + `promptcut.role.agent.<n>`。
- `lan-host`：局域网主机上、创建者自己的共享项目（页面以本机声明进入的那种）。子协议再加 `promptcut.tenant.<projectId>`。
- `ticket`：共享项目（托管端、局域网成员），`url` 给文档服务的 `ws(s)://` 地址。Agent 服务端每开一条对话连接，都经 `/api/mcp/events` 的 SSE 发一条 `{ type: "agent.ticket", reqId, projectId, role: "agent", conversation }`，页面在自己的文档服务连接上发 `auth.ticket { kind: "conn", role: "agent", conversation }`，把拿到的票据 `POST /api/agent/ticket { reqId, ticket }` 交回（要不到就 `{ reqId, error }`）。10 秒内没交回，这次工具调用回错。票据只用于握手，连接断了重连时会再要一张。
- 同一个 `projectId + mode + url` 重复 bind 是空操作；换了就先解绑旧的。无头实例（文档服务停用）不要 bind。

**页面执行器（`src/ai/mcpExecutor.ts`）要做的**：

1. 留在页面的写工具（第 3 节），执行完在 `POST /api/mcp/result` 的回包里多带 `opIds: string[]` —— 这次调用期间 DocSync 提交的 `opId`（等 `whenSettled` 之后取）。Agent 服务端据此把对话读到的版本推过去；不带也能用，只是 Agent 紧接着的写入会被自己让页面做的改动挡一次（stale，重读即可）。
2. SSE 里认 `agent.ticket`（见上）。
3. 绑定之后，`side: "agent"` 的工具不会再经 SSE 到页面；页面原来在这些工具之后做的附带动作搬到了服务端或需要页面自己从事件里补：
   - 聊天栏可视化记录（`withVisual`）：服务端已做，回包里带 `visualId`；
   - SKILL 悬浮窗的「上一步画面」（`reportLastAction`）：只在无头实例里做，无头实例不绑，不受影响；
   - 公告板的「谁改了哪儿」（`agentBus.noteToolChange`）：需要页面从 `project.ops` 的 `actor`（`role: 'agent'`、`session: 'agent:<对话 id>'`）与操作的实体自己记；
   - `create_card` 之后刷新卡片归属表（`refreshScopes`）：服务端执行时刷的是服务端那份，页面要在看到 `create_card` 的完成事件后自己调一次。
4. 远端改动落到页面后，页面自己的选区里可能留着已被删的片段 id；Agent 加卡也不再改页面选区（第 5 节第 11 条）。

**事件（D2，频道即项目频道，`project.open` 之后就收）**：

- `events.event { phase: "create", eventId, tool, icon, target, args, detailKey, actor, at }`：`icon` 是工具分组（`clips`、`layout`……，`server/mcp-tools.mjs` 的 `toolGroups`），`target` 形如 `clipId:c1`，`args` 是截到 2048 字符的参数 JSON；
- `events.event { phase: "complete", eventId, status: "ok" | "error", summary, durationMs, actor, at, detailKey, opId?, rev?, inverse? }`：只有成功落地的写带 `opId`、`rev`、`inverse`；逆操作超过 256 KiB 时不带（那一步撤不了）；
- `events.event { phase: "text", eventId, text }`：文字回复，在下一次工具调用或本轮结束时整段发；
- `content.get { kind: "event-detail", key: detailKey }` → `{ tool, args, summary, opId?, rev?, inverse? }`（完成时补写过）。
- `eventId` 形如 `agent:<对话 id>.<启动号>.<序号>`；`actor.conversation` 是对话号。
- **AI 栏「撤销这一步」**：拿完成事件的 `inverse` 与 `opId`，以页面自己的身份提交逆操作、`undoOf: opId`（设计稿第 8 节裁定：算页面会话的写入，进用户自己的撤销栈）。冲突按主会话裁定第 4 条：这一步（`rev`）之后被不同于这次写入身份（事件的 `actor`）的任何写入改过的实体不撤。DocSync 里还没有 `revertRemote({ opId, inverse })`（integ 报告第 7 节），要补。

**Agent 侧工具的报错**：被拒时工具回错的文字形如：

```
项目在你上次读取之后被改过:你读到的是 rev 2,现在是 rev 3。这次写入没有落地。
期间的改动:
  rev 3:页面改了 /tracks/@t-1/clips/@c-…
请先重新读取(get_project、get_clip、get_layout 等)确认现状,再决定怎么改。
```

## 8. 没做的、遗留

（待填）
