# AGENT 报告：c65-agent（C6.5 第 5 节：Agent 一侧）

分支 `claude/c65-agent`（基于 `claude/c65` 的 `806503d`），worktree `.worktrees/c65-agent`。
依据 `docs/plan/c65-design.md` 第 5、7、8、13 节，`c65-ops-spec.md`，`cloud-task.md` 的 D1、D2、D4，`auth-contract.md` 第 5、6、8、14 节，`AGENT-c65-integ.md` 第 7 节遗留清单，以及主会话中途的裁定（第 6 节）。

状态：六项都做了；按主会话通知合入了 main（`2e75bec`，M6 含 M6c X1～X5、SP），合并后基线、G0-R、两个探针全绿（第 4 节）。没有推送，没有合并到别处。

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

### 4.1 新增用例（AG-*，`server/test/agent-c65.test.mjs`）

| 用例 | 内容 |
|---|---|
| AG-1 | 握手：回环只带 `promptcut.role.agent.<n>` → `{ ...本机身份, role: 'agent', conversation: n }`；缺对话号、对话号 0、`role.page`、缺 `promptcut.v1`、两个角色项、非回环都拒 |
| AG-2 | 副本：乱序排队、重复丢弃、缺口超时重开、落不下去重开、`waitRev` |
| AG-3 | **V3 端到端**（真 handler 经 vite `ssrLoadModule` + 副本 + 真文档服务 WebSocket）：Agent `get_clip` 读到 rev 1 → 页面改 `c1.label`（rev 2）→ Agent `update_clip` 回 `StaleWriteError`，`since` 恰好一条：rev 2、页面那次的 `opId`、`actor.role 'page'`、`session 'page-1'`、`entities ['/tracks/@t1/clips/@c1']`；文档服务仍是 rev 2、没有 opacity；重读（rev 2）后再写成功（rev 3），页面的 label 保留，副本与真身 `JSON.stringify` 逐字节相同；页面收到的广播 `actor` 为 `{ role: 'agent', conversation: 1, session: 'agent:conv-A' }` |
| AG-4 | 连写三次 rev 2、3、4（写成功视同读到新版本）；`update_clip` 先改参数再因 `trackId` 抛错 → 整次不提交 |
| AG-5 | 事件：四次调用各有创建、完成；读与被拒的写不带 `opId`；成功的写带 `opId`、`rev`、`inverse`，逆操作应用到真身等于写之前；`event-detail` 补写了参数、摘要、`opId`、`inverse`；`events.text` |
| AG-6 | 两个对话交替写 6 次：广播的 `actor` 依次 `[1,'agent:A'] [2,'agent:B'] …`；两路 ok / 广播交错后副本与真身逐字节相同 |
| AG-7 | 页面侧写入归属：期间只有页面报回的提交 → 推进读到的版本、紧接着的写入成功；中间夹了另一个页面的写入 → 不推进、写入 stale |
| AG-8 | 事件模块：完成事件透传 `opId / rev / inverse`、`detailKey`，`events.list` 里也有；带 `inverse` 不带 `opId` 回 `bad-message` |
| AG-9 | stale 报错文字：谁、改了哪些实体；超过 8 次、6 个实体折叠 |
| AG-10 | 工具表：`side` 只有 agent / page / server，`toolGroups` 覆盖全部 119 个，几个代表工具的取值 |
| AG-11 | 预渲染发布方定版本（真项目模块 + 真 `project-client`）：无真身 announce 发号 + 上传；有真身不上传、以真身 rev 发布、`snapshot.get` 取回的是真身、询问不发号；与真身不同回 `body-mismatch` |

全量里的原始行（合并后）：

```
✔ AG-1 握手:回环只带 promptcut.role.agent.<n> 是本机 local 空间的 agent 连接;别的组合照旧拒
✔ AG-2 副本:乱序到达按 rev 排队、重复的丢掉、缺口超时重新打开、应用失败也重新打开
✔ AG-3(V3 端到端)Agent 读后页面改了同一片段:Agent 的写回 stale,since 与实际改动一致,文档服务不变;重读后再写成功
✔ AG-4 写成功后这个对话读到的版本跟着前进:连着写不会被自己挡住;handler 抛错时整次改动作废
✔ AG-5 事件:每个工具调用都有创建 / 完成;只有成功的写带 opId、rev、inverse,完成时补写 event-detail;逆操作能把那一步撤回去
✔ AG-6 两个对话各用各的连接:写入身份的对话号不同;两路广播与 ok 交错时副本仍与真身相同
✔ AG-7 留在页面的工具写了项目:页面报回的 opIds 进了副本、且期间只有它们,就把对话读到的版本推过去;夹了别人的写入就不推
✔ AG-8 事件模块:完成事件透传 opId / rev / inverse,补写 event-detail;带 inverse 不带 opId 回 bad-message
✔ AG-9 stale 的报错文字:谁、改了哪些实体,多了折叠
✔ AG-10 工具表:每个工具都标了 side(agent / page / server),事件的分组覆盖全部工具
✔ AG-11 预渲染发布方定版本:没有真身照老流程发号、传快照;有真身不发号、不上传,以真身的 rev 发布,节点取回的是真身;与真身不同就不交给队列
```

### 4.2 基线（合并 main `2e75bec` 之后，`98dfc65`）

- `npx tsc -b --force`：退出码 0，没有输出。
- `npm test`：退出码 0：

```
ℹ tests 2899
ℹ pass 2898
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
﹣ 集成:/api/cards/layout 对真实项目返回整数框 (0.1355ms) # SKIP
```

唯一跳过的是既有那条（要 5190）。合并前第一次全量败 1 条：`src/mcp/tools/trackTools.test.mjs` 还断言 `side === "browser"`，是我改 side 取值时漏掉的一处断言，改成 `agent` 后全过（不是实现问题）。

### 4.3 本机 dev server 冒烟（5500，合并后）

`PROMPTCUT_PUSH=0 npx vite --port 5500 --strictPort --host 127.0.0.1`（本 worktree），脚本 `agent-smoke.mjs` 在 scratchpad（不入库）：裸 WebSocket 当页面，把项目以根替换写进 `local` 空间 → `POST /api/agent/bind` → 经 `/api/mcp/call`（CLI 那条路）调工具。原始输出：

```
seed project.op.ok
bind {"ok":true,"projectId":"smoke-agent-muhk02hn","mode":"local","url":"ws://127.0.0.1:5500/docservice"}
get_project ok true rev 1 tracks 2
add_clip ok true rev 2 clip c-muhk0571-1
page got project.ops rev 2 actor {"userId":"local","deviceId":null,"role":"agent","conversation":1,"session":"agent:smoke"}
page commit project.op.ok
stale write ok false
项目在你上次读取之后被改过:你读到的是 rev 2,现在是 rev 3。这次写入没有落地。
期间的改动:
  rev 3:页面改了 /tracks/@t-1/clips/@c-muhk0571-1
请先重新读取(get_project、get_clip、get_layout 等)确认现状,再决定怎么改。
reread rev 3
write after reread ok true rev 4
get_layout {"ok":true,"result":{"clipId":"c-muhk0571-1","local":{"x":100,"y":50},"world":{…},"contentBox":{"left":894,"top":532,"width":333,"height":115},"rev":4}}
events create:get_project: | complete::ok | create:add_clip: | complete::ok:opId:inverse | create:set_position: | complete::error | create:get_clip: | complete::ok | create:set_position: | complete::ok:opId:inverse | create:get_layout:
status {…"conversations":[{"key":"smoke","conversation":1,"session":"agent:smoke","lastRead":4}],"stats":{"executed":6,"committed":2,"stale":1,"rejected":0,"noop":1,"events":12,"eventErrors":0},…"replica":{"hasState":true,"hasBody":true,"rev":4,"buffered":0}}
unbind {"ok":true}
```

真实 dev server（带全部插件）里 `ssrLoadModule` 载入卡片注册表与 handlers 没问题；`add_clip`（`punch-pill`）在服务端执行，页面收到的写入身份是 agent + 对话 1；`get_layout` 经预渲染进程量出了实体框。最后那条 `get_layout` 的完成事件在脚本收尾之后才到，没打出来。

### 4.4 G0-R（合并后）

端口：本分支 dev server 5500（舞台 5501、5502），main 基线 5503（舞台 5504、5505），都以 `PROMPTCUT_PUSH=0` 起。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5500/?export=1"` | 退出码 0；`Total Frames: 1800` / `Identical: 1800` / `Different: 0` / `All frames are identical. Determinism verified!` |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5500 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5500` | 退出码 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 导出像素与 main | 临时 `git worktree add --detach .worktrees/c65a-main-baseline main`（`2e75bec`），5503 上跑同一条 `verify-determinism`（main 同样 1800/1800），pngjs 逐帧逐像素比两边的 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |

合并前（main 还是 `b84fee5` 时）完整跑过一遍，结果相同：1800/1800、PASS、与 `b84fee5` 0 差异。两次删基线 worktree 之前都用 PowerShell 查过 `reparse points: 0`，然后 `git worktree remove --force`。

### 4.5 探针（合并后）

**queue-mode-probe**：`node scripts/probes/queue-mode-probe.mjs --queue-port 5503 --normal-port 5506 --docservice-port 5509`，退出码 0：

```
{"ok":true,"tasks":5,"done":5,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":0,"streamDone":0,"streamCompare":null,"x5":{"readyAfterMs":108140,"firstPlanClaim":{"id":"plan:queue-mode-probe@1","afterPreloadMs":265,"preload":["html"]},"firstFineClaim":{"id":"snapshot:67d1fa79…:0-59","afterPreloadMs":2270,"preload":["html"]},"claimedWhileNotReady":5,"fineClaimedBeforeReady":true},"fails":[]}
```

探针自起的文档服务里没有真身，走的是发布方的老流程分支（announce 发号 + 上传），与改动前一致；有真身的分支由 AG-11 覆盖（第 8 节第 1 条）。

**render-host-probe 本机 H1/H2/H3 序列**：编排照 `AGENT-m6-host.md` 第 3 节（creator 5400；r1 host-a 5403、host-b 5406；r2 host-c 5403 `--code-version test-code-version-mismatch --expect-claims none`、host-bad 5406 `--expect-claims none --expect-handshake 401`；check r1 / r2 用 5403；auth-check `--rate-limit`），脚本 `run-rhp.sh` 在 scratchpad。全部角色退出码 0，原始 JSON 行（省略号处是配置细节与 codeVersion 全文）：

```
== creator
{"role":"creator","port":5400,…,"rounds":[{"round":"r1","hosts":["host-a","host-b"],"planId":"plan:render-host-probe@1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":112896},{"round":"r2","hosts":["host-c","host-bad"],"planId":"plan:render-host-probe@2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":107574}],"projectId":"sp_zfml7px4r3odejzxn5itsdncsa","pc":{"mode":"shared","nodeId":"prerender:DESKTOP-GS40TCK:5400","envFingerprint":"258acaaa7c5fe509",…},"ok":true,"fails":[]}
== host-a
{"ok":true,"name":"host-a","round":"r1","port":5403,…,"claimed":1,"completed":1,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,…,"exitCode":0,…,"fails":[]}
== host-b
{"ok":true,"name":"host-b","round":"r1","port":5406,…,"claimed":1,"completed":1,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,…,"exitCode":0,…,"fails":[]}
== host-c
{"ok":true,"name":"host-c","round":"r2","port":5403,…,"claimed":0,"completed":0,"dedup":0,"seen":2,"connected":true,"opens":1,"handshake":101,"codeVersion":"test-code-version-mismatch",…,"exitCode":0,…,"fails":[]}
== host-bad
{"ok":true,"name":"host-bad","round":"r2","port":5406,…,"claimed":0,"completed":0,"dedup":0,"seen":0,"connected":false,"opens":0,"handshake":401,…,"exitCode":0,…,"connectFailed":11,…,"fails":[]}
== check-r1
{"role":"check","round":"r1","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-a":true,"claimed:host-a":1,"hostOk:host-b":true,"claimed:host-b":1,"completedByNode":{"pc":3,"host-a":1,"host-b":1},"sumCompleted":5,"pcPlanClaimed":true,"reused":0,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
== check-r2
{"role":"check","round":"r2","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-c":true,"claimed:host-c":0,"hostOk:host-bad":true,"claimed:host-bad":0,"completedByNode":{"pc":3,"host-c":0,"host-bad":0},"sumCompleted":3,"pcPlanClaimed":true,"reused":2,…,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
== auth-check
{"role":"auth-check","ok":true,"loopback":true,…,"wrongPassword":401,"rightPassword":101,"ticket":true,…,"afterFiveWrong":101,"challengeInCooldown":"ok","fails":[]}
```

- H1：check r1 `duplicateDone 0`、`missingDone 0`，完成数 PC 3 + host-a 1 + host-b 1 = 5，`identicalBytes: true`；
- H2：host-c `seen 2`、`claimed 0`，check r2 `identicalBytes: true`；
- H3：host-bad `handshake 401`、`opens 0`、`connectFailed 11`、`claimed 0`。

合并前也完整跑过一遍这两个探针，同样全过。

收尾：我起的 vite 进程树（5500、5503 各两次）都用 `taskkill /T` 结束，探针的进程随角色退出。结束后 5400～5409、5500～5509 没有监听，也没有命令行带本 worktree 的 node 进程。没碰 5190～5192；5510～5519 上有别人的监听，没动。

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

1. **有真身时的发布流程没有探针级验证**：两个探针都没有页面接线，文档服务里没有真身，只走到老流程分支。有真身的分支只有 AG-11（真项目模块 + 真 `project-client`，不起预渲染进程）。页面接线（c65-editor）合入后，建议在 queue-mode-probe 里加一趟「先以根替换写进真身，再 preload」。
2. **节点晚取旧版本**：有真身时发布方不再上传快照，节点在真身前进之后才来取那一版会拿到 `missing`（第 5 节第 9 条）。若要保证旧版本也取得到，可以在版本匹配时照旧上传一份（摘要与真身相同，文档服务能校验），代价是每次发布传一遍整份项目。
3. **页面侧还没接**：`/api/agent/bind`、`agent.ticket`、回包里的 `opIds`、AI 栏按事件更新与「撤销这一步」、`revertRemote`，都在 c65-editor（第 7 节）。没绑时本分支不改变现有行为。
4. **留在页面的 50 个工具**：第 3 节列了理由；作业类、`set_project_meta`、切剪辑要迁到服务端，得先定下页面作业表、`durationManual`、播放头这些状态的归属，属于后续任务。
5. **Agent 侧的大提交**：超过 256 KiB 的改动直接回错，没接 `project.upload`（第 5 节第 8 条）。
6. **对话号不跨重启**（第 5 节第 2 条）。
7. `list_cards` 留在页面，服务端执行 `create_card` 之后页面的卡片归属表不会自己刷新（第 7 节）。

## 9. 提交

| 提交 | 内容 |
|---|---|
| `8f02adc` | 建报告文件 |
| `9452506` | 工具表逐条标 side；本机 local 空间认 `promptcut.role.agent.<n>`；`doc-link.mjs` |
| `ec27194` | 执行器与副本（D1 / D4）、事件（D2）、`vite-plugin-ai.ts` 接线、events 模块扩展、AG-1～AG-10 |
| `edc00ca` | 预渲染发布方有真身时以真身 rev 发布；AG-11 |
| `c2b4e83` | trackTools 测试的 side 断言 |
| `da38654` | 对话登记时即建连接；报告初稿 |
| `98dfc65` | 合并 main（`2e75bec`）：`vite-plugin-frames.ts` 四处冲突，`publish(session, project, entryKey, raw)` 同时保留 M6c 的 `entryKey`（X1 流的空档）、`preferNode`（X4 就近认领）与本分支的真身定版本；其余文件自动合并 |
| 下一个 | 报告定稿 |
