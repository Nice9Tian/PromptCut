# AGENT-cut-look-ui

分支 `claude/cut-look-ui`，从 main `2f4c694a` 切出；子 Agent 只在 worktree `.worktrees/cut-look-ui` 里改，没推送、没合并、没部署。任务：用户 2026-10-21 定的三件事（`docs/plan/user-decisions-2026-10-21.md` 第 2.2 节、第 3 节）。

1. `see_frames` 加可选 `cutId`，看没激活的剪辑不用切换。
2. 会动用户界面的工具名字前加 `user_interface_`。
3. 剪辑段引用哪条剪辑不能改（属性面板与 Agent）。

本报告里的代号：〔裁〕＝实现者自己定、等用户审的细节；A1/B2/K4b 这类是探针里的断言编号；CL-1 这类是新单测的用例编号。

## 一、see_frames 能看没激活的剪辑

- 工具说明（`server/tools/vision.mjs`）：新增 `cutId`（[timeline]），不传＝当前激活的剪辑；说明里写明不切换、不改项目、不动任何人的界面，不要为看画面去切剪辑。
- 做法：出图前用 `src/kernel/agentScopes.mjs` 新加的 `cutLookView(project, cutId)` 得到「那条剪辑当激活」的项目视图（与 `kernel/cuts.ts` 的 `cutEditView` 同形状；放在 `agentScopes.mjs` 是因为它已经是服务端经 `ssr-host.mjs` 转出、随 Agent 服务一起部署的纯 JS，不加新的部署路径，也不碰 SEAM 棘轮）。视图只交给这一次出图，不进 store、不进文档同步、不改 `activeCutId`。
- **请求体里只放视图、不放 `cutId`**：渲染端（本机预渲染进程、托管渲染服务的工作进程）看到的就是一份普通项目，只认 `project` 的旧版渲染进程也出得对图，不用改渲染管线。
- 不给 `t`、也不给 `clipId` 时，取那条剪辑停放时存的播放头 `t`（没有就 0），不用页面播放头（页面播放头是激活剪辑的）。〔裁〕
- cutId 不存在：抛「找不到剪辑 "x";现有的:剪辑1(cut-1)、剪辑2(cut-2)。cutId 从 list_cuts 里拿,不传就看当前激活的剪辑。」，不去渲。
- 回包一律带 `cut: { id, name }`（带不带 cutId 都写明看的是哪条）。
- 就地改停放剪辑里的片段时（`src/mcp/clipCut.ts`），回包原来去掉的 `look` 现在保留并补上 `cutId`，`cutNote` 改成「看它的画面用 see_frames 传 cutId」。〔裁〕
- `list_cuts`、`user_interface_switch_cut`、`get_project` 的说明，`agentScopes.mjs` 的 `PARKED_EDIT_NOTE` / `otherCutsHint`，`effects.ts` 里 switchCut 的 note，`server/ai-system-prompt.md` 的多剪辑一节：凡写「看画面才切」的都改成「看画面用 see_frames 的 cutId」。

### 每条出图路是否支持 cutId

| 出图路 | 入口 | 拿到的项目从哪来 | 支持 | 证据 |
|---|---|---|---|---|
| 本机，绑了项目副本（桌面版平时这条） | `agent-exec.mjs` 的 `seeFrames` | 项目副本（文档服务） | 是 | 探针 B1～B3；单测 CL-2 |
| 本机，没绑副本、有数据镜像 | `instance.mjs` 的 `runMirroredTool` | 数据镜像 | 是 | 探针 A1～A4；单测 CL-3 |
| 本机兜底：经编辑器页面 | `src/mcp/handlers/vision.ts` 的 `seePreview` | 页面 store | 是 | 单测 `src/mcp/handlers/seeFramesCut.test.mjs` |
| 云端托管档 → 托管渲染服务 | `agent-exec.mjs` → `look-client.mjs` → `hosted-render/look.mjs` | 项目副本；请求体原样转给工作进程 | 是 | `cloud-agent-look-probe.mjs --steps cutlook`（K4b，真进程） |
| 账号模式 → 托管渲染服务 | `account-runner.mjs` 的 `prerenderPost` → `dispatchFrameSnapshot` → 托管渲染 | 同上（视图在 agent-exec 里换好） | 是（单测级） | 单测 CL-2、CL-4；没在真账号组合里跑（见「没做到的」） |
| 账号模式 → 成员设备（桌面版 / 在线浏览器替云端出图） | `dispatchFrameSnapshot` 的 `callLocal` | 成员页面自己的 store | **带 cutId 时不走** | `opts.cutLook` 为真时成员节点表留空，直接交托管渲染（单测 CL-4）。说明见下 |

- 成员设备那条路：页面收到的 `see_frames` 用的是它自己 store 里的项目（`seePreview` 读 `getState().project`，不读请求体里的 `project`），0.7.18 的页面更不认 `cutId`，交给它会出成激活剪辑的图。所以带 cutId 时服务端在发给成员设备之前就不选它，交给托管渲染服务。另外核代码时发现：这条路眼下其实没接通——`account-runner.mjs` 判的是 `toolset.pageBridge.call`，而 `account-tools.mjs` 交出来的 toolset 上没有 `pageBridge`，所以 `memberNodes` 恒为空、一直走托管渲染。这是现状，本次没改（不在任务范围），记为更正建议。
- 旧版本页面：本机桌面版的页面与服务端同版本；云端不把 `see_frames` 发给页面（反向通道白名单只有 seek/play/pause/web_handoff）；成员设备那条路带 cutId 时不选。旧页面收不到带 cutId 的出图请求，不会出错图。

## 二、会动用户界面的工具改名

### 改名对照表

| 旧名 | 新名 | 理由 |
|---|---|---|
| `switch_cut` | `user_interface_switch_cut` | 激活剪辑是全项目共享的，切换让所有成员的时间轴一起翻（用户点名） |
| `seek` | `user_interface_seek` | 移动用户编辑台上的播放头（用户点名「时间轴操作」） |
| `play` | `user_interface_play` | 在用户编辑台上开始播放 |
| `pause` | `user_interface_pause` | 暂停用户编辑台上的播放 |
| `web_handoff` | `user_interface_web_handoff` | 主要效果就是把浏览器窗口挪到用户面前交给他操作〔裁〕 |
| `collect_login` | `user_interface_collect_login` | 主要效果是在编辑台里弹出登录框 / 扫码框让用户操作〔裁〕 |

### 判断过、不改名的

| 工具 | 理由 |
|---|---|
| `add_cut` | 改成**只建不切**（去掉 `switch` 参数），不再动界面，所以不加前缀；要切另调 `user_interface_switch_cut` |
| `remove_cut` | 主要效果是删剪辑（改项目）；删的恰好是激活那条时顺带切到相邻的一条，是删除的连带后果 |
| `collect_login_check` | 主要效果是读登录态、存盘；「把窗口藏回去」是收尾，窗口本来就是 collect_login 弹的 |
| `get_selection` | 只读选区，不改界面 |
| `spawn_agent` | 主要效果是拉起子 Agent；AI 栏多出一个页签是连带 |
| `web_open` / `web_view` / `web_click` / `web_type` / `web_scroll` / `web_read` / `web_close` | Agent 用的浏览器平时在屏幕外，用户看不到；交到用户面前的只有 handoff |
| `background_job_status`、`auto_workflow`、`auto_workflow_status`、感知类、采集类其余、`import_media`、声音与配音 | `side: "page"` 是因为要页面里的作业表或浏览器能力，不改用户眼前的界面状态（选中、播放头、激活剪辑、面板、窗口） |
| `wait`、`report_progress`、多 Agent 的公告板几个 | 服务端就地执行，不碰界面 |

### 兼容做法

- 对照表在 `server/tools/ui-names.mjs`（`modelToolName` 旧→新、`pageToolName` 新→旧），不引用 `src/`；页面一侧直接 import 它（`mcpExecutor.ts` 原本就 import `server/mcp-tools.mjs`）。
- **交给模型的清单只有新名**（单测 CL-5、探针 B4）。
- **入口新旧都认**：`instance.mjs` 的 `callToolInternal`、`agent-side.mjs` 的 `callTool`、`agent-exec.mjs` 的 `execute`、API 直连的 `harness/agent.mjs`（工具表里找不到时按新名再找一次）、云端工具表的 `checkCloudTool` / `initiatorOffline` / `initiatorUnreachable`。老对话的历史里还是旧名，模型照着调旧名时照常执行（`cloud-agent-page.test.mjs` 的 CA-REV-09 脚本仍用旧名、照常通过）。
- **发给页面的内部操作名保持旧名**：SSE `call`（`instance.mjs` 的 `callEditorPage`、`agent-side.mjs` 的 `viaPage`）、本地 / 局域网托管档的反向通道（`hostedPageTool`）、账号模式反向通道（`page-bridge.mjs` 的 `PAGE_BRIDGE_TOOLS` 没动，提供方 `createPageControlTools`、`hosted-handoff.mjs` 认新名、发旧名）、采集代下（`collect-bridge.mjs` 的 `COLLECT_PAGE_TOOLS` 没动）。0.7.18 桌面版当发起人页面时照常认。
- **页面两种都认**：`mcpExecutor.ts` 进门 `modelToolName` 再查路由表（路由表键改成新名）；网页接管新名落到 `runWebTool(pageToolName(tool))`；`src/ai/cloud/pageRequests.ts`（旧通道与账号模式两处）、`collectBridge.ts` 进门 `pageToolName`。
- 显示：聊天栏图标分类（`src/editor/right/chat/iconRuns.ts`）新名一律「界面操作」，旧名照旧；桌面悬浮窗（`desktop/ui/overlay-summary.js`）新旧名都有中文名。`toolEcho.ts` 里没有按工具名显示的表，只改了注释里的指路文字。
- 系统提示词（`server/ai-system-prompt.md`）加一段：名字带 `user_interface_` 的工具会动用户的界面，能不用就不用；云端提示词（`cloud-tools.mjs`）、建卡指南（`server/card-authoring-guide.md`，建卡流程最后一步改成「可选」）、`server/tools/README.md`、采集角色提示词（`src/ai/roles/collector.md`）、给模型看的报错与提示（`collect-cookies.mjs`、`server/web/*.mjs`、`vite-plugin-collect.ts`、collect-bridge / hosted-collect / hosted-handoff 的话）里的旧名一起换成新名。
- `add_cut` 只建不切：handler 固定 `switchTo: false`，回包 note 说明没切过去；`PAGE_STATE_TOOLS`、`CLOUD_PLAYHEAD_TOOLS` 去掉 `add_cut`（不再要播放头）。

## 三、剪辑段引用哪条剪辑不能改

- 属性面板（`src/editor/left/CutSegmentForm.tsx`）拿掉「引用」下拉框；「打开被引用剪辑」按钮、双击剪辑段、右键「打开剪辑」都保留（后两样没动）。
- store 动作 `setCutSegment(clipId, { cutOffset })` 只收偏移，带 `cutId` 就抛（别处也换不了引用）。
- Agent 的 `set_cut_segment`：说明里去掉 `cutId` / `name`；带了就报原话「剪辑段引用的剪辑不能改，要换就删掉这段，用 add_cut_segment 放一段新的」（`src/kernel/cutSegments.ts` 的 `CUT_SEGMENT_REF_FIXED`），项目一个字不写。
- `docs/semantics/workflow/editing.md`：用户批准的原句一字不改加进去。**位置与任务书不同**：任务书说「第 33 行后」，第 33 行是「剪辑标签」那条下面的子条目，插在它后面会把第 34 行（「打开了哪几个标签……」）变成新条目的子条目；所以放在「剪辑标签」整组之后（第 35 行），仍是顶层条目、紧挨着剪辑相关的几条。请主会话核对。
- 探针 `scripts/probes/cut-segment-panel-probe.mjs` 原 P3 测的就是换引用下拉框，按新规矩改成「面板里没有下拉框、按钮还在」（任务没点这个文件，不改它会挂，所以改了）。

## 语义文档

- 用户已定、标「2026-10-21 用户定」：`product/project-model.md`（看画面可指定剪辑、不切换；剪辑段放好后不能换引用）、`product/agent.md`（看画面能指定剪辑；会动用户界面的操作名字带 `user_interface_`，引了用户两句原话）、`workflow/editing.md`（批准的原句）。
- 机制（三级）：`mechanism/project-model.md`（`cutLookView` 的做法、剪辑段不能换引用的实现）、`mechanism/agent.md`（改名对照与新旧名的三处规矩、add_cut 只建不切、各出图路怎么认 cutId）。
- `workflow/production.md` 里没有提到这些工具，没改。

## 〔裁〕清单

1. 网页接管 `web_handoff`、站点登录 `collect_login` 也按「会动用户眼前的界面」改名（`product/agent.md`、本报告对照表）。
2. 不改名的工具及理由（本报告「判断过、不改名的」）。
3. `add_cut` 只建不切（任务书写了，但用户原话里没有这一句，所以按〔裁〕标在 `product/agent.md`）。
4. see_frames 带 cutId、不给 t 时取那条剪辑停放的播放头（没有就 0）。
5. 账号模式带 cutId 时不交给成员设备，只交托管渲染服务。
6. 就地改停放剪辑的回包里 `look` 调用带上 cutId。
7. 入口兜底认旧名（执行器、agent-side、harness、云端工具表的话都按新名写）。
8. `workflow/editing.md` 那一句的位置（见上）。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次在 `b5697b83` 之前、代码已定稿时跑） |
| 全量测试 | `$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT=…; $env:PROMPTCUT_PASSWORD_ORDER_MODULE=…; npm test`（在 `b6f4e467` 上） | tests 7370、pass 7354、fail 1、skipped 15。唯一失败 `server/test/reopen-hosting.test.mjs`（真实中继 free 那条，`Cannot read properties of null (reading 'expiresAt')`，与本改动无关，机器占满时的偶发）；单独重跑 `npm test -- server/test/reopen-hosting.test.mjs`：pass 3、fail 0 |
| 第一次全量 | 同上（改名之后、修旧测试之前） | fail 47，全是旧测试里写死的旧工具名 / add_cut 会切过去；逐个改完单独重跑全过，再跑上一行的全量 |
| 新单测 | `npm test -- server/test/cut-look-ui.test.mjs` | CL-1～CL-6 共 6 条全过 |
| 新单测 | `npm test -- src/mcp/handlers/seeFramesCut.test.mjs` | 3 条全过（页面 seePreview 带 / 不带 / 错 cutId；add_cut 只建不切；页面执行器两种名字） |
| 改过的单测 | `src/mcp/handlers/cutSegments.test.mjs`（5 条，含「set_cut_segment 带 cutId / name 被拒、store 动作换不了」）、`src/ai/cloud/page-requests.test.mjs`（新增 CAU-REV-05b 页面新旧名都认）等 | 全过 |
| 探针：本机出图 | `node scripts/probes/cut-look-probe.mjs --port 5970 --out <scratchpad>/cut-look-probe` | 退出码 0，A0～A4、B0～B4 共 10 条全过。A1：镜像那条路带剪辑2 的 cutId，中心像素 (0,0,255)；A2：镜像版本号 1→1、activeCutId 仍 cut-1；A3：不带 cutId (255,0,0)；A4：错 id 明确报错；B1：副本那条路 (0,0,255)、回包 rev 1；B2：页面 store 同一个对象、激活剪辑 cut-1、播放头 0.5 没动、副本 rev 1→1、committed 0→0；B3：(255,0,0) |
| 探针：托管渲染服务 | `node scripts/probes/cloud-agent-look-probe.mjs --steps cutlook --doc-port 5970 --asset-port 5971 --agent-port 5972 --render-port 5973 --out <scratchpad>/cloud-cut-look` | 退出码 0，K0、K4b 两条过：中心像素 [0,0,255]、[255,0,0]；项目 rev 2→2，activeCutId cut-1；端口全部放掉 |
| 界面探针 | `node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5973 --out …`（自起 dev server，`PROMPTCUT_NO_PORT_FILE=1`，跑完结束） | 退出码 0，A1～A10 全过；新加的 A10：面板里没有「引用」下拉框（也没有任何 select）、「打开被引用剪辑」按钮和起点偏移还在；页面零报错 |
| 界面探针 | `node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5973 --out …` | 退出码 0，P1～P9、L1、E0 全过（P3 已改成「没有下拉框」） |
| 渲染附加项（导出确定性、像素比对） | 没跑 | 没改渲染管线（`src/render/`、`server/frame-pipeline.mjs`、取帧代码一行没动），只是换了交给渲染的项目视图；视图是一份普通项目 |

看过的图（都在 scratchpad，主会话请亲自看）：

- `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin--claude-spares-spare-RfiPK2\a0159534-16d4-4402-bb42-2fff71266bf6\scratchpad\cut-look-probe\A1-cut2.png`（蓝）、`A3-cut1.png`（红）、`B1-cut2.png`（蓝）、`B3-cut1.png`（红）
- `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin--claude-spares-spare-RfiPK2\a0159534-16d4-4402-bb42-2fff71266bf6\scratchpad\cloud-cut-look\K4b-cut2.png`（蓝）、`K4b-cut1.png`（红）
- `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin--claude-spares-spare-RfiPK2\a0159534-16d4-4402-bb42-2fff71266bf6\scratchpad\cut-nesting-ui\05b-cut-segment-panel.png`（剪辑段面板：「剪辑段 · 剪辑2」「打开被引用剪辑」、起点偏移、开始结束，没有「引用」一行；图里的「找不到素材」弹框是探针夹具自带的，与本改动无关）

## 没做到的与原因

- 账号模式（任务进程 + 主服务）的真组合里没跑 cutId：`cloud-agent-look-probe` 起的是旧托管档。账号模式出图前换视图的是同一个 `agent-exec.mjs` 的 `seeFrames`，出图那一侧原样转请求体，单测 CL-2（视图）+ CL-4（cutLook 时只交托管渲染）覆盖；真组合留到部署后的真实网络验证。
- 成员设备替云端出图那条路没接通（现状，见第一节），本次只保证带 cutId 时不选它。

## 对任务书或语义的更正建议

1. `workflow/editing.md` 那一句的位置（见第三节），请主会话定。
2. 成员设备出图：`account-runner.mjs` 判 `toolset.pageBridge.call`，toolset 上没有这个字段，四级先后里的前两级（桌面版、电脑浏览器）实际从没用上。要么接上，要么在 `product/agent.md`「看」那一条注明现状。
3. 页面一侧 `src/ai/cloud/pageRequests.ts` 里网页接管的几句报错还写 `web_handoff`（内部操作名）；这些话只在服务端的参数检查放过之后才可能出现，没改。要统一可以下次改。
4. 建卡指南里「放上时间轴后 seek 让用户看效果」改成了可选；如果用户希望这一步保留为默认，请推翻。

## 部署清单

`server/` 变了的文件：

- **Agent 主服务 / 任务进程树**（`server/agent-service/main.mjs` 这一棵）要换：`server/tools/ui-names.mjs`（新文件，`.d.mts` 可不放）、`server/tools/{browser,clips,collect,core,cuts,project,vision}.mjs`、`server/agent/{agent-exec,agent-side,ssr-host}.mjs`、`server/agent/service/{account-runner,cloud-tools,collect-bridge,hosted-collect,hosted-handoff,hosted-tools,instance,page-bridge}.mjs`、`server/harness/agent.mjs`、`server/ai-system-prompt.md`、`server/card-authoring-guide.md`、`server/collect-cookies.mjs`、`server/web/session.mjs`、`server/web/hosted/{hit,view}.mjs`。Agent 服务经 `ssr-host.mjs` 载入的 `src/`（`src/kernel/agentScopes.mjs`、`src/kernel/cutSegments.ts`、`src/mcp/**`、`src/store/actions/cuts.ts`、`src/ai/roles/collector.md`）也要同步。
- **文档服务树**：没有它载入的文件变了（`server/docservice/**`、`server/hosted/**`、`server/auth/**` 都没动）；若节点上两棵树整份同步，换进去也无妨，不用重启文档服务。
- **渲染服务树**：渲染管线没动，功能上不需要换；按规矩 `src/` 变了要把整份 `src/` 同步进渲染树。渲染服务不必为本次重启（同步后下次重启生效即可）。
- 只在桌面 / 开发服务器上用的：`server/vite-plugin-collect.ts`、`desktop/ui/overlay-summary.js`（随桌面版发版）。

重启：Agent 主服务（连同任务进程）要重启；文档服务不用；渲染服务不用（同步 `src/` 后可择机）。
前端：`src/` 变了（`CutSegmentForm.tsx`、`mcpExecutor.ts`、`ai/cloud/pageRequests.ts`、`ai/cloud/collectBridge.ts`、`iconRuns.ts` 等），要重新构建在线前端，并把整份 `src/` 同步进渲染树。

顺序建议：先换 Agent 树并重启（新服务端对旧页面发的仍是旧的内部操作名，旧页面照常），再发在线前端。
