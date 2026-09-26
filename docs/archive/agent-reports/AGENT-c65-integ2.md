# AGENT 报告：c65-integ2（C6.5 第二批集成对账与收尾实现）

分支 `claude/c65-integ2`（起点 `claude/c65` 的 `806503d`），worktree `.worktrees/c65-integ2`。依据 `c65-design.md`（全文，含第 13 节）、`c65-ops-spec.md`、`c65-ux-draft.md`、`c65-undo-draft.md`、`auth-contract.md` 第 7 节，四份报告 `AGENT-c65-agent.md`、`AGENT-c65-editor.md`、`AGENT-c65-tests2.md`、`AGENT-c65-integ.md`，以及主会话的裁定。

状态：合并、裁定落实、测试对账、验证都做完了。类型检查 0、全量 2946 条 0 失败 1 跳过；G0-R 里 `ready-index-probe` 第 ⑨ 项不过，但在 main（`2e75bec`）上同条件一样不过，是 main 上既有的问题（第 5.4 节）。`preview-fallback-probe --page-preload` 在合并后的代码上连跑 3 次都通过，同时段 main 1 次也通过。没有推送，没有合并到别处。

## 1. 合并

依次 `--no-ff` 合并，四次都**没有冲突**：c65-agent、c65-editor 都已先合过 main `2e75bec`；c65-tests2 只新增 `server/test/c65b-*` 与报告；c65-agent 与 c65-editor 改的实现文件不相交（两边都动过的只有来自 main 与第一批的共同祖先部分）。

| 提交 | 内容 |
|---|---|
| `8bf9c37` | 建报告文件 |
| `991caa5` | 合并 main `2e75bec`（M6c X1～X5、SP 最终版、各报告） |
| `f7f9074` | 合并 `claude/c65-agent`（`2ac36b0`） |
| `65bcf24` | 合并 `claude/c65-editor`（`b6eb78b`） |
| `7da54b6` | 合并 `claude/c65-tests2`（`7d9e0ac`） |
| `28f7d30` | Agent 服务端分派收进 `agent-side.mjs`；5 个工具改在服务端；`project.upload`；事件带 `callId` |
| `2e99743` | 页面真接线、远端改动后的页面状态、AI 栏操作记录、快捷键与提示条纯函数、`c65b-kit.mjs` 胶水 |
| `6815383` | 单测 AP-1～AP-10 |
| `4dd5d7d` | 设计稿第 14 节、auth-contract 第 15 节；`__page_state` 改用常量 |
| `6cc55cf` | 单测 MCP-CALLID |
| 下一个 | 本报告 |

语义上没有两边冲突需要解：合并后 `c65-agent` 的 `/api/agent/bind`、`agent.ticket`、回包 `opIds` 在页面一侧都没人调（c65-editor 报告第 4 节自己也写了），这是第 2 节「页面真接线」要补的，不是合并冲突。

## 2. 裁定落实

逐条写进了 `c65-design.md` 第 14 节（「裁定：理由」）；与 auth 有关的写进 `auth-contract.md` 第 15 节。

### 2.1 接受 c65-agent

代码不动，写进第 14 节：每个对话一条连接；对话号本进程内发、`session` 记 `agent:<对话 id>`；页面经 `/api/agent/bind` 告诉服务端项目与文档服务；发布方有真身时 `project.announce` 只作查询；handler 抛错时整次不提交；期望版本取这个对话最后读到的版本、写成功后更新为新 `rev`。

### 2.2 5 个既读页面状态又写项目的工具（D1 判据）

- **工具表**：`set_project_meta`、`switch_cut`、`add_cut`、`remove_cut`、`attach_clip_motion` 由 `side: "page"` 改为 `"agent"`（`server/tools/project.mjs`、`cuts.mjs`、`ai.mjs`）。现在 agent 72、page 45、server 2。
- **页面状态只要一次**（`server/agent/agent-exec.mjs` 的 `PAGE_STATE_TOOLS`）：切剪辑三个要页面播放头 `t`；`attach_clip_motion` 要页面内存里那段素材的轨迹（`trackResults` / `trackJobs`）；`set_project_meta` 什么都不要。执行器在跑 handler 之前经 `pageState(tool, args, keys)` 要一次，放进服务端 store（`ssr-host.mjs` 的 `setPageState`，跑完收拾掉轨迹），再在副本上跑 handler、以 agent 身份带期望版本提交。
- **通道**：内部工具 `__page_state`，走现有的 SSE 页面通道（`vite-plugin-ai.ts` 的 `callEditorPage`，页面 `src/ai/mcpExecutor.ts` 回 `{ t, track }`），只读，不在工具表里、Agent 看不到。页面通道不通时播放头退回服务端记着的页面播放头；轨迹没有替代，回「编辑台没有打开…读不到页面里的追踪结果」。
- **页面状态的「写」**由页面看到远端改动时自己推（`src/store/remotePageState.ts`，`bindStore` 在 `cause === "remote"` 时调）：激活剪辑变了 → 播放头取切之前那一版里目标剪辑停放的值、停播、清选区、清总时长手动值；总时长变了 → 手动值按 `manualDurationFor(新总时长, 内容末尾)`；选区里被删的片段摘掉。
- **单测**：`server/test/agent-c65-pagestate.test.mjs` AP-1～AP-5、AP-9（第 4 节）。

### 2.3 Agent 侧单次写 > 256 KiB 走 project.upload

`agent-exec.mjs` 的 `uploadRoot`：差异序列化后超过 256 KiB，就把「跑完的整份项目」按 128 Ki 字符一片经 `project.upload` 传上去（每片等 `project.uploaded`），提交里只放 `{ op: 'set', path: '', upload }`；副本按同一份内容落地；逆操作仍用差异算的那份。片数超过 64 才回 `too-large`。单测 AP-6。

### 2.4 页面真接线

| 项 | 落实 |
|---|---|
| 挂上 DocSync 后调 `/api/agent/bind` | `syncManager.ts` 的 `bindAgentSide`：`bind()` 里调，本机 `{ mode: 'local' }`，共享 `{ mode: 'ticket', url }`；同样的绑定不重发 |
| `agent.ticket` | `mcpExecutor.ts` 收到 SSE `agent.ticket` → `syncManager.issueAgentTicket`：在本页面的共享连接上签 `auth.ticket { kind: 'conn', role: 'agent', conversation }`，交回 `/api/agent/ticket` |
| 回包带 `opIds` | `DocSync.opMark()` / `opIdsSince()`；`mcpExecutor.ts` 在页面工具执行前后取，放进 `/api/mcp/result` |
| 完成事件带 `opId`、`callId`、`inverse`、`rev`、`actor` | `opId` / `inverse` / `rev` / `actor` c65-agent 已有；新增 `callId`：`mcp-server.mjs` 转 Claude Code 的 `_meta["claudecode/toolUseId"]`（在本机 `claude.exe` 里查到这个键），API 直连由 `harness/tools/index.mjs` 传 `context.callId`，`/api/mcp/call` 收 `callId`，`events.mjs` 的创建、完成两条都透传 |
| AI 栏按事件 id 更新记录、列表虚拟化 | `syncManager` 的 `eventRecords`（按 `eventId` 合成创建 / 完成 / 文字，留最近 1000 条，连上后 `events.list` 补一次）；AI 栏新增「Agent 操作记录」`src/editor/sync/AgentEventLog.tsx`，行高固定、只渲染可见行 ± 4 行 |
| 「撤销这一步」真实出现并可用 | 操作记录里写进了项目的那一条带按钮（聊天操作卡上的 `AgentUndoButton` 也按 `callId` 对上）；截图与点击验证见第 5.6 节 |

为了让 vite 插件与测试用同一份分派规则，把 `vite-plugin-ai.ts` 里「按 side 分派 + 事件」收成 `server/agent/agent-side.mjs`（`createAgentSide`）；`vite-plugin-ai.ts` 的没绑时的老路不变，SSE 那段抽成 `callEditorPage`，`wait` / `report_progress` 抽成 `runServerTool`。`doc-link.mjs` 的 `url` 可以按对话号给（测试按查询串给写入身份用）。

### 2.5 接受 c65-editor 的增补与偏差

- `shared.mjs` 的 `list-bans`、`set-list` 的 `keep`、`shared.notice`，以及 `set-creator-password`（不作废票据）：代码不动，写进 `auth-contract.md` 第 15 节。
- 稿件没写的文案、对稿件的偏差（报告第 3 节）：原样记进 `c65-design.md` 第 14 节。
- 局域网模式一键重启：记为遗留，留给 C10 / 桌面壳。

### 2.6 测试方 c65-tests2 的歧义

按主会话先前的裁定写进第 14 节末尾；实现与之一致（`opId` / `inverse` 在完成事件；写成功后期望版本 = 新 `rev`；读工具也发事件；AI 栏撤销的冲突按「不同于原写入身份」；改创建者密码不作废票据）。

### 2.7 为了测试对账抽出来的纯函数（行为不变）

- `src/editor/undoKeys.ts` 的 `undoRedoKey`（`Editor.tsx` 的 keydown 改用它）；
- `src/editor/undoNotice.ts` 的 `undoNotice` / `undoNoticeTitle` / `foldLine`（`SyncOverlays.tsx` 的标题与折叠行改用它）；
- `core.ts` 的同步挂钩加可选的 `whenSettled`，`bindStore` 装上 `ds.whenSettled`。

## 3. 测试对账

### 3.1 胶水（只改 `server/test/c65b-kit.mjs`，断言一条没改）

| 假设 | 实际 | 对账 |
|---|---|---|
| B1 项目副本工厂 `{ projectId, url(conv), loadModule, callPage, now }` → `{ open, callTool, close }` | `server/agent/agent-side.mjs` 的 `createAgentSide`（连接 + 执行器 + 分派） | `agentSideReplica` 包成 B1 的形状：handler 用 vite `ssrLoadModule` 载入（与 AG-3 相同；卡片注册表在裸 Node 下载不进来，测试给的 `loadModule` 不用）；执行器按对话 id 发对话号 1、2、3，胶水把「发出的号 → 测试的对话号 7、3、5」对上，连接地址按测试的号给（B9 查询串） |
| B2 `side` 取值 | `agent` / `page` / `server` | 不用改 |
| B3 事件里的 `opId` / `inverse` | 完成事件带 | 不用改 |
| B4 AI 栏撤销的方法名 | `DocSync.revertRemote({ opId, inverse?, rev?, by? })` | 候选名加 `revertRemote` |
| B5 快捷键纯函数 | 原来写在 `Editor.tsx` 里 | 抽成 `src/editor/undoKeys.ts` 的 `undoRedoKey`，正好是候选名 |
| B6 `set-creator-password` | 一致 | 不用改 |
| B7 等确认后序列化 | 原来挂钩上没有 `whenSettled` | 挂钩加 `whenSettled`，正好是退路 |
| B8 提示条文案纯函数 | 原来写在 `SyncOverlays.tsx` 里 | 抽成 `src/editor/undoNotice.ts` 的 `undoNotice`，正好是候选名 |
| B9 身份按查询串 | 一致 | 不用改 |

### 3.2 失败归类

合并后第一次 `node --test server/test/c65b-*.test.mjs`：22 条，过 6、败 16。

| 类 | 用例 | 原因 | 处理 |
|---|---|---|---|
| A（接口名或形状不同） | D1-01～05、D1-07、D2-01～05（11 条） | B1 工厂的形状 | 胶水 → 全过 |
| A | U-04、U-05、U-06、V7-01（4 条） | B5 / B8 / B7 的纯函数、挂钩没有 | 抽出纯函数、挂钩加 `whenSettled`（2.7 节，行为不变）→ 全过 |
| C（实现与裁定不一致） | D1-06 | `set_project_meta` 在页面侧，违反本次 D1 裁定 | 按裁定改到 Agent 服务端（2.2 节）→ 过 |
| C | 全量里 `tool-schema.test.mjs`「执行器分发的每个工具名，mcp-tools 里都真的有声明」 | 我在 `mcpExecutor.ts` 里写了字面的 `tool === "__page_state"`，被守门测试当成没声明的工具 | 改用常量 `PAGE_STATE_TOOL`（内部通道，不该进工具表）→ 过 |
| D（测试或环境的问题，只报告） | D2-04 一次 | 第一次三文件连跑时 D2-04 在 1.97 ms 处 `Error: 连接失败`（`fake-ws-kit.mjs` 的 WebSocket 连接 error，发生在 setup 里） | 没查。之后单跑 2 次、本文件 3 次、三文件 3 次、全量 2 次都过（第 4 节） |

B 类（裁定改了语义、要改断言）：0 条。

## 4. 单测与全量（原始关键行）

**类型检查**：`npx tsc -b --force`，退出码 0，没有输出（每次提交前都跑过，最后一次在 `6cc55cf`）。

**c65b 第一次连跑**（胶水之后）：

```
✖ C65B-D2-04 撤销这一步也查冲突（V5 同理）：Agent 改了 name 与 fps，别的成员随后改了 fps；只撤 name，告诉用户 fps 因谁改过没撤 (1.9742ms)
ℹ tests 22
ℹ pass 21
ℹ fail 1
  Error: 连接失败
```

其后：`--test-name-pattern="D2-04"` 单跑 2 次都 `✔ … (1362.3397ms)` / `(1370.6351ms)`；`c65b-agent.test.mjs` 连跑 3 次都 `ℹ pass 12` `ℹ fail 0`；三个 c65b 文件连跑 3 次都 `ℹ pass 22` `ℹ fail 0`。

**相关子集**：`node --test server/test/c65*.test.mjs server/test/agent-c65*.test.mjs server/test/auth-*.test.mjs server/test/sp-*.test.mjs src/store/docsync*.test.mjs`，退出码 0：

```
ℹ tests 333
ℹ pass 333
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

**全量**：`npm test`，退出码 0（`6cc55cf`）：

```
﹣ 集成:/api/cards/layout 对真实项目返回整数框 (0.0561ms) # SKIP
ℹ tests 2946
ℹ pass 2945
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```

唯一跳过的是既有那条（要 5190）。全量第一次（`4dd5d7d` 之前）是 `ℹ fail 1`，就是 3.2 节 C 类那条守门测试；改后第二次 `ℹ tests 2945` `ℹ pass 2944` `ℹ fail 0` `ℹ skipped 1`；加了 MCP-CALLID 后第三次即上面的结果。

**新增单测**（全量里都过）：

```
✔ AP-1 工具表:五个工具都在 Agent 服务端(side agent);要页面状态的只有切剪辑三个(播放头)与 attach_clip_motion(轨迹)
✔ AP-2 switch_cut:向页面要一次播放头;写入以 agent 身份进文档服务;离开的剪辑停放着页面的播放头;不经页面执行
✔ AP-3 add_cut(缺省切过去)与 remove_cut(删当前剪辑):各向页面要一次播放头;页面通道不通时退回服务端记着的播放头,照样写成
✔ AP-4 set_project_meta:不读页面状态,直接在服务端执行;duration 比内容末尾短就截断写进项目
✔ AP-5 attach_clip_motion:向页面要一次那段素材的轨迹;逐帧坐标在服务端算、写进片段;没追过、页面不在时回错且不提交
✔ AP-6 Agent 一次写入超过 256 KiB:改成根替换经 project.upload 分片上传;文档服务落地、别的页面收到 resync;副本与真身相同;完成事件照样带 opId
✔ AP-7 事件带 callId:模型那一侧这次工具调用的 id 原样进创建、完成两条事件,events.list 里也有
✔ AP-8 留在页面的工具:页面回包带 opIds(wrapped)时推进这个对话读到的版本,紧接着的写入不被自己让页面做的改动挡住
✔ AP-9 页面侧 pageStateAfterRemote:别人切了剪辑 → 播放头取停放值、停播、清选区、清手动时长;别人截断总时长 → 记手动值;选区里被删的片段摘掉
✔ AP-10 页面侧 DocSync.opMark / opIdsSince:取某个位置之后本页面发出的提交(含载入)
✔ MCP-CALLID tools/call 的 _meta["claudecode/toolUseId"] 原样转成 /api/mcp/call 的 callId;没带就不带
```

c65-agent 的 AG-1～AG-11 一条没改，合并与改动后全过。

## 5. G0-R 与探针（原始关键行）

端口：本分支 dev server 5500（舞台 5501、5502），main 基线 5503（舞台 5504、5505），都以 `PROMPTCUT_PUSH=0 npx vite --port … --strictPort --host 127.0.0.1` 在各自 worktree 里起；ready-index-probe 自起 5520 / 5523；queue-mode-probe 用 5506 / 5509 / 5512；render-host-probe 用 5400～5409；局域网主机编辑器 5513（`PROMPTCUT_LAN_HOST=1`）；托管组合 5518 / 5519（数据目录在 scratchpad `hosted-i2`）。main 基线是临时的 `git worktree add --detach .worktrees/c65i2-main-baseline main`（`2e75bec`）。没用 Claude 浏览器面板，所以没动主工作区的 `.claude/launch.json`。

### 5.1 导出确定性与像素

| 项 | 命令 | 结果 |
|---|---|---|
| 本分支 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5500/?export=1"` | 退出码 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` `All frames are identical. Determinism verified!` |
| main | 同上，5503 | 退出码 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` `All frames are identical. Determinism verified!` |
| 与 main 逐像素 | pngjs 逐帧比两边 `out/verify-a/frames`（scratchpad `cmp-frames.mjs`） | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5500 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5500` | 退出码 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |

### 5.2 preview-fallback-probe

| 次 | 命令 | 结果 |
|---|---|---|
| 本分支，不带 `--page-preload` | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5500 --out out/pf-probe --json out/pf-probe/plain.json` | `PASS`；`beats 268`、`transparentBeats 0`、`taskP90 26.959`、`pageErrors []`、`fails []` |
| 本分支 `--page-preload` 第 1 次 | `… --origin http://127.0.0.1:5500 --page-preload --out out/pf-probe --json out/pf-probe/pp1.json` | `PASS`；`{"beats":282,"transparentBeats":0,"taskP90":10.687,"pageErrors":[],"fails":[],"readyLayers":{"html":4,"stream":1}}` |
| main `--page-preload`（同时段，夹在第 1、2 次之间） | `… --origin http://127.0.0.1:5503 --page-preload …` | `PASS`；`{"beats":276,"transparentBeats":0,"taskP90":14.021,"pageErrors":[],"fails":[],"readyLayers":{"html":1,"stream":1}}` |
| 本分支 `--page-preload` 第 2 次 | 同第 1 次 | `PASS`；`{"beats":274,"transparentBeats":0,"taskP90":16.876,"pageErrors":[],"fails":[],"readyLayers":{"html":2,"stream":1}}` |
| 本分支 `--page-preload` 第 3 次 | 同第 1 次 | `PASS`；`{"beats":282,"transparentBeats":0,"taskP90":11.678,"pageErrors":[],"fails":[],"readyLayers":{"html":2,"stream":1}}` |

三次都没有「等粒子卡轨道流」超时。`taskP90` 只有带 `--baseline` 时才判；三次 `--page-preload` 是 10.7 / 16.9 / 11.7 ms，main 14.0 ms。不带 `--page-preload` 那一次是 26.96 ms，只跑了一次、没有 main 的同条件对照，我没法判断是不是回归，照录。

### 5.3 stream-produce-probe

| 命令 | 结果 |
|---|---|
| `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5500 --json out/spp.json` | 退出码 0；`PASS`；`{"group":false,"produceMs":21065,"streams":3,"layers":3,"fails":[]}` |
| 同上加 `--group`（`out/spp-group.json`） | 退出码 0；`PASS`；`{"group":true,"produceMs":18072,"streams":1,"layers":1,"fails":[]}` |

### 5.4 ready-index-probe（main 上同样不过）

| 命令 | 结果 |
|---|---|
| 本分支 `node scripts/probes/ready-index-probe.mjs --port 5520` | 退出码 1，`fails` 6 条，都在第 ⑨ 步 |
| main `2e75bec` `node scripts/probes/ready-index-probe.mjs --port 5523` | 退出码 1，`fails` 同样 6 条、同样在第 ⑨ 步 |

两边的 `fails` 原文相同（只有计划 key 不同）：

```
"超时:按新 costs 重算出的预渲染集合",
"⑨ 按新 costs 重算出了预渲染集合 :: [{\"key\":\"…\",\"set\":[\"clip-canvas\",\"clip-huge\",\"clip-stateful\",\"clip-unknown\"]}]",
"⑨ 判轻的卡不在预渲染集合里 :: null",
"⑨ 判重的卡还在集合里 :: null",
"⑨ 判轻的卡不进就绪索引 :: [\"clip-canvas/html\",\"clip-canvas/stream\",\"clip-huge/stream\",\"clip-stateful/html\",\"clip-stateful/stream\",\"clip-unknown/local\"]",
"⑨ 同一趟里判重的卡照样有快照目录 :: false"
```

第 ⑨ 步是「写一条便宜的成本记录后，判轻的卡从预渲染集合里掉出去」。main 上同样超时，所以不是本分支引入的；按回退规则我没往下查。前三批报告（c65-agent、c65-editor、c65-integ）的 G0-R 里都没跑这个探针，不知道它从哪一次合并起不过。

### 5.5 queue-mode-probe、render-host-probe

**queue-mode-probe**：`node scripts/probes/queue-mode-probe.mjs --queue-port 5506 --normal-port 5509 --docservice-port 5512`，退出码 0：

```
{"ok":true,"tasks":5,"done":5,"identical":true,"differentFrames":0,"identicalIgnoringStyleOrder":true,"differenceSummary":{},"streamTasks":0,"streamDone":0,"streamCompare":null,"x5":{"readyAfterMs":106531,"firstPlanClaim":{"id":"plan:queue-mode-probe@1","afterPreloadMs":838,"preload":["html"]},"firstFineClaim":{"id":"snapshot:5cfc864e…:60-89","afterPreloadMs":2840,"preload":["html"]},"claimedWhileNotReady":5,"fineClaimedBeforeReady":true},"fails":[]}
```

**render-host-probe 本机 H1/H2/H3 序列**：编排照 `AGENT-m6-host.md` 第 3 节（scratchpad `run-rhp-i2.sh`，由 c65-agent 用过的 `run-rhp.sh` 改 worktree 与 state 目录），所有角色退出码 0，关键字段：

```
creator {"ok":true,"fails":[],"rounds":[{"round":"r1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":2,"pcPlanClaimed":true,"preloadMs":112401},{"round":"r2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcPlanClaimed":true,"preloadMs":104951}]}
host-a {"ok":true,"claimed":1,"completed":1,"seen":4,"connected":true,"handshake":101,"connectFailed":0,"exitCode":0,"fails":[]}
host-b {"ok":true,"claimed":2,"completed":2,"seen":4,"connected":true,"handshake":101,"connectFailed":0,"exitCode":0,"fails":[]}
host-c {"ok":true,"claimed":0,"completed":0,"seen":2,"connected":true,"handshake":101,"connectFailed":0,"exitCode":0,"fails":[]}
host-bad {"ok":true,"claimed":0,"completed":0,"seen":0,"connected":false,"handshake":401,"connectFailed":12,"exitCode":0,"fails":[]}
check-r1 {"ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"completedByNode":{"pc":2,"host-a":1,"host-b":2},"sumCompleted":5,"reused":0,"differentFrames":0,"identicalBytes":true,"identical":true,"styleOrderOnly":0,"fails":[]}
check-r2 {"ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"completedByNode":{"pc":3,"host-c":0,"host-bad":0},"sumCompleted":3,"reused":2,"differentFrames":0,"identicalBytes":true,"identical":true,"styleOrderOnly":0,"fails":[]}
auth-check {"ok":true,"wrongPassword":401,"rightPassword":101,"ticket":true,"afterFiveWrong":101,"challengeInCooldown":"ok","fails":[]}
```

- H1：check r1 `duplicateDone 0`、`missingDone 0`，PC 2 + host-a 1 + host-b 2 = 5，`identicalBytes: true`；
- H2：host-c `seen 2`、`claimed 0`，check r2 `identicalBytes: true`；
- H3：host-bad `handshake 401`、`connectFailed 12`、`claimed 0`。

### 5.6 c65-editor-probe 三个阶段与「撤销这一步」

**本机 + 共享**：`node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5500 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots --phases local,shared`，退出码 0，34 项全过（本机 20、共享 14）：

```
{"check":"V2-page-real","ok":true,"edits":[100,100],"a":{"sha256":"3abf7e55…3fc8","rev":147,"status":"online"},"b":{"sha256":"3abf7e55…3fc8","rev":147,"status":"online"},…}
{"check":"undo-partial-notice","ok":true,"notice":"撤销了，但这几处被后续的新修改覆盖，未做退回：\n×\n片段「模糊浮现 @2.0s」 (由 你在另一个页面 修改)",…}
{"check":"undo-none-notice","ok":true,"notice":"没撤成。这几处后来都被改过了，保留了现在的样子：\n×\n片段「环形进度 @4.0s」 (由 你在另一个页面 修改)\n你可以 [点击这里] 查看被修改处的现状，或直接手…}
{"check":"undo-buttons","ok":true,"undoTitle":"撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的","redoTitle":"重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）","undoDisabled":false,"redoDisabled":true}
{"check":"ctrl-y-redo","ok":true,…}
{"check":"offline-replay","ok":true,"c5":"重放2","c7":"B7-重放"}
{"check":"agent-undo-step","ok":true,"reverted":{"found":true,"done":true,"state":"done"},…}
{"check":"agent-undo-in-user-stack","ok":true}
{"check":"new-shared-hosted","ok":true,"created":"创建成功，已进入项目。",…}
{"check":"members-list","ok":true,"pop":"alice (自己)\n[创建者]\n[编辑中]\nbob (MacBook)\n[编辑中]\n踢出\nbob (DESKTOP-GS40TCK-vqxC)\n[编辑中]\n[Agent ×1]\n踢出\nbob · Agent · 第 2 个对话\n项目管理（仅创建者可见）\n改项…}
{"check":"kicked-blocking-dialog","ok":true,"blocked":"你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。\n开始页"}
{"check":"delete-project","ok":true,"aAfter":"local"}
{"summary":{"total":34,"passed":34,"failed":[]}}
```

（完整 34 行在 scratchpad `c65ep-ls.log`。）

**局域网**：另起 `PROMPTCUT_LAN_HOST=1 PROMPTCUT_PUSH=0 npx vite --port 5513 --strictPort`，`… --origin http://127.0.0.1:5513 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots --phases lan`，退出码 0：

```
{"check":"lan-host-editor","ok":true,"device":{"deviceId":"pc-vqxCRm0vQRfjWbzscI-4fc","deviceName":"DESKTOP-GS40TCK-vqxC","lanHost":true,"localEditor":true}}
{"check":"new-shared-lan","ok":true,"created":"创建成功。让成员在同一个网段下查项目名就能进。记住本机要保持开着。"}
{"check":"open-shared-two-candidates","ok":true,"cands":"[局域网模式] 主机：DESKTOP-GS40TCK-vqxC\nc65-lan-muhoa2mc\n[互联网模式] 托管在阿里云\nc65-lan-muhoa2mc","title":"找到两个同名项目，你要进哪一个？"}
{"summary":{"total":3,"passed":3,"failed":[]}}
```

验完以创建者身份删掉了这个局域网项目（`out/c65-integ2/lan-cleanup.mjs`：`{"enter":{"ok":true},"del":{"ok":true,"op":"delete"}}`，之后查找 `{"lookupAfter":404,"body":"{\"ok\":false,\"error\":\"no-project\"}"}`）。

**AI 栏「撤销这一步」（真实 Agent 调用）**：`node out/c65-integ2/agent-undo-shot.mjs --origin http://127.0.0.1:5500 --out out/c65-integ2-shots`（脚本在 worktree 的 `out/` 下，不入库）。真浏览器开编辑器 → 等 `/api/agent/status` 绑上这个项目 → `POST /api/mcp/call`（命令行那条路）调 `get_project`、`update_clip` → AI 栏出现按钮 → 点 → 核对。13 项全过：

```
{"check":"agent-bound","ok":true,"projectId":"p-muho6g01-84caf1a5","mode":"local"}
{"check":"agent-read","ok":true,"rev":1,"clipId":"c-muho6g46-5"}
{"check":"agent-write","ok":true,"rev":2}
{"check":"undo-button-appears","ok":true,"text":"✓update_clipc-muho6g46-5Agent「第 1 个对话」撤销这步","button":"撤销这步","disabled":false,"rows":2}
{"check":"undo-button-done","ok":true,"button":"已撤销","disabled":true}
{"check":"agent-stale-after-page-undo","ok":true,"error":"项目在你上次读取之后被改过:你读到的是 rev 2,现在是 rev 3。这次写入没有落地。 / 期间的改动: /   rev 3:页面(撤销)改了 /tracks/@t-1/clips/@c-muho6g46-5"}
{"check":"undo-reverted-in-docservice","ok":true,"label":null,"before":null}
{"check":"undo-in-user-stack","ok":true,"canUndo":true}
{"check":"cuts-listed","ok":true,"first":"cut-1","second":"cut-2"}
{"check":"switch-cut-on-server","ok":true}
{"check":"switch-cut-back","ok":true}
{"check":"page-playhead-follows-remote-cut-switch","ok":true,"tAfterSwitch":0,"tBack":3.5}
{"check":"page-state-asked","ok":true,"pageStates":2,"committed":3}
{"summary":{"total":13,"passed":13,"failed":[]}}
```

后五行是页面状态通道的真实页面验证：页面播放头挪到 3.5 s，Agent 经服务端 `switch_cut` 切到剪辑 2、再切回剪辑 1，页面的播放头回到 3.5（停放值来自那一次向页面要的播放头），执行器记了 2 次页面状态请求。

**共享项目里的 ticket 模式**（`out/c65-integ2/agent-ticket-check.mjs`，托管组合 5518 代替阿里云）：页面以创建者进入共享项目 → Agent 服务端按 `ticket` 模式绑上 → 开对话连接时经 SSE 向页面要票据、页面签好交回 → 写入落在托管端，身份是这个成员 + agent + 对话号。7 项全过：

```
{"check":"agent-bound-ticket","ok":true,"mode":"ticket","url":"ws://127.0.0.1:5518"}
{"check":"agent-read-via-ticket","ok":true,"rev":1}
{"check":"agent-write-via-ticket","ok":true,"rev":2}
{"check":"agent-actor-in-shared","ok":true,"actor":{"userId":"zed@pc-vqxCRm0vQRfjWbzscI-4fc","deviceId":"pc-vqxCRm0vQRfjWbzscI-4fc","role":"agent","conversation":1,"session":"agent:tk"}}
{"check":"agent-conversation-connected","ok":true,"conversations":[{"conversation":1,"state":"open"}],"stats":{"executed":2,"committed":1,"stale":0,"rejected":0,"noop":0,"events":4,"eventErrors":0,"pageStates":0,"uploads":0}}
{"summary":{"total":7,"passed":7,"failed":[]}}
```

### 5.7 截图清单（1440×900，未入库）

| 内容 | 文件 |
|---|---|
| 真实 Agent 调用之后，AI 栏「Agent 操作记录」里 `update_clip` 那一行带「撤销这步」（整页） | `C:\Users\admin\Documents\PromptCut\.worktrees\c65-integ2\out\c65-integ2-shots\agent-undo-before.png` |
| 同上，只截 AI 栏 | `…\out\c65-integ2-shots\agent-undo-before-panel.png` |
| 点了之后按钮变灰「已撤销」；Agent 随后拿旧版本写回错那一次记成红叉 | `…\out\c65-integ2-shots\agent-undo-after.png`、`agent-undo-after-panel.png` |
| c65-editor-probe 三个阶段的截图（与 c65-editor 报告第 2.4 节同名） | `…\out\c65-editor-shots\` |

四张 `agent-undo-*` 我都看过：整页里时间轴、画面正常，右侧 AI 栏输入框上方是「Agent 操作记录 · 2 条」（点之后 5 条），`update_clip c-… Agent「第 1 个对话」` 一行右侧是「撤销这步」，点后变成灰的「已撤销」。第一次截整页时被首次打开的「正在测量卡片」遮罩和「选择 AI 助手」对话框挡住，脚本改成等遮罩退下、关掉对话框之后再截（上面四张是改后的）。

### 5.8 收尾

- 我起的进程：vite 5500（根 24624）、5503（42840）、5513（47160），对应的 npx 父进程 54920、54248、37284，托管组合 45508，都用 `taskkill /T /F` 结束；ready-index-probe、queue-mode-probe、render-host-probe 各角色自起的进程随角色退出。结束后 5400～5409、5500～5529 没有监听，命令行带 `c65-integ2`、`c65i2-main` 或 `hosted/main` 的 node 进程 0 个。没碰 5190～5192，没结束别人的进程。
- 临时 worktree `.worktrees/c65i2-main-baseline`：删之前 PowerShell 查 `reparse points: 0`，然后 `git worktree remove --force`。
- 主工作区没动（`git status` 干净，`.claude/launch.json` 没改）。
- 托管组合的数据目录在 scratchpad `hosted-i2`；本 worktree 的 `out/`（截图、一次性脚本、`out/docservice`、草稿目录）未入库。

## 6. 与任务书、设计稿不一致之处，以及更正建议

1. **聊天列表没有另做窗口化**。「AI 栏按事件 id 更新记录、列表虚拟化」我做在新增的「Agent 操作记录」上（按 `eventId` 合成、固定行高虚拟化）；聊天记录本身沿用已有的 `.ai-row` `content-visibility: auto` 与逐条 memo（`chat.css` 注释里实测 1200 次工具调用下每片段 13 ms），没改成事件驱动。理由：聊天记录还承载流式文字、思考、报告卡、回退，整体换成事件驱动风险大；「别处发起的调用也要在 AI 栏看得到、撤得了」由操作记录满足。写进了设计稿第 14 节，请主会话确认。
2. **`callId` 只有 Claude Code 与 API 直连两路有**。codex、agy 的 MCP 调用不带模型那一侧的调用 id，聊天操作卡上的「撤销这步」对不上，只能在操作记录里撤。
3. **页面状态的「写」由页面推**（`remotePageState.ts`）是我对「只把所需的页面状态向页面要一次」的延伸：切剪辑后换播放头、截断后记手动值原来是 handler 顺手写的页面状态，服务端执行后只能由页面看到远端改动时补上。它同时改变了多页面、多成员下的行为（别人截断总时长，本页面不再被时间轴改回去），请主会话确认。
4. **`set_project_meta` 不向页面要任何状态**：它不读页面状态，只写（`durationManual`），这一写改由第 3 条推出来。
5. **本机 `local` 空间的绑定是「最后 bind 的页面赢」**：同一编辑器上开了两个不同项目的页面时，Agent 服务端绑的是后打开（或后换项目）的那个。c65-agent 的设计就是单绑定，我没改。

## 7. 遗留

- **局域网模式一键重启**：桌面壳没有重启编辑器的接口，留给 C10 / 桌面壳（裁定）。
- **`ready-index-probe` 第 ⑨ 步**在 main `2e75bec` 上同样超时（5.4 节），需要另立任务查。
- **Agent 在服务端加的卡超出内容末尾时，总时长由页面补写**：`addCardClip` 不改 `duration`，原来靠页面时间轴的 effect 按内容末尾同步；服务端执行之后，页面收到远端改动再同步一次，这一次是页面身份的写入，会让这个 Agent 对话紧接着的下一次写入回一次 `stale`（重读即可）。我没有在真实页面里复现，是读代码得出的；建议在 Agent 服务端跑完 handler 后按同一条总时长规则补齐（`effectiveDuration(内容末尾, duration, manualDurationFor(改前 duration, 改前内容末尾))`），不在本次清单里，没做。
- **留在页面的 45 个工具**：作业类、`import_media`、`web_*`、`collect_*` 等（c65-agent 报告第 3 节），要迁到服务端得先定页面作业表的归属。
- **对话号不跨重启**、**票据每次重连再要一张**（c65-agent 报告第 5 节第 2 条、第 7 节）。
- **c65b D2-04 的一次 `连接失败`**（3.2 节 D 类）：之后 10 次都过，没查。
- 不带 `--page-preload` 的 preview-fallback-probe 那一次 `taskP90 26.959`，没有 main 同条件对照（5.2 节）。

## 8. 需要主会话决定

- 合并、返工还是放弃。
- 第 6 节第 1、3 条（聊天列表不另做窗口化；页面状态的「写」由页面推）是否接受。
- `ready-index-probe` 第 ⑨ 步（main 上既有）与「服务端加卡后页面补写总时长」两项是否另立任务。
