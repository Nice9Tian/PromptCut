# AGENT-user-editing：A2「用户正在编辑」本机版

分支 `claude/user-editing`，起点 main `7e3c27e3`。任务是 `docs/plan/agent-workflow-plan.md` 的 A2（该计划第 2 节分段表的第二段：页面把编辑状态推给服务端，Agent 读或写到这些实体时工具结果带 `userEditing` 提示；文档服务的 `overwrote` 放进返回给 Agent 的结果）。

## 状态

代码、单测、探针都已完成，基线全绿。没推送、没合并。

| 哈希 | 内容 |
|---|---|
| `0de93473` | 建报告 |
| `8e3b00f6` | 功能：页面汇总与推送、服务端记下、工具结果带 `userEditing`、`overwrote` 进结果 |
| `846a0035` | 测试 UE-P1～P8、UE-W1～W2、UE-S1～S10 |
| `01c90e01` | 在线构建剪掉推送；探针 `scripts/probes/user-editing-probe.mjs` |
| （本次） | agent-side 的参数说明；报告 |

## 做了什么

### 1. 页面：编辑状态的汇总与推送

- **汇总与节流**（`src/editor/userEditingCore.ts`，纯逻辑、无依赖）：每个片段（卡片也是片段）一条，种类 `drag`（拖动中）、`text`（文字编辑中）、`recent`（选中后 30 秒内动过，带剩余毫秒数）；同一片段几种都有时取拖动 > 文字编辑 > 刚动过。只选中不动不算；取消选中后「动过」的记录作废，重新选中也不恢复。
- **推送节奏**：状态一变就推（前沿立即发，之后两次至少隔 250 ms，窗口到点发最新一份）；状态没变不重发（拖动中位置在变、状态没变，不发）；非空时每 5 秒心跳一次；「刚动过」到 30 秒自动发一份去掉它的；空了不再心跳、不挂定时器。
- **接线**（`src/editor/userEditing.ts`）：
  - 拖动 / 文字编辑由组件报：`useUserEditing(slot, clipId | null, kind)`。接了四处：时间轴片段的拖动与改时长（`ClipView.tsx`，真的动起来才算，只点一下不算）、字幕条拖动与双击改字（`CaptionLines.tsx`）、舞台上的移动工具拖动与改字（`Preview.tsx` 的 `dragPreview` / `editingText`）。
  - 「选中后动过」：旁听 store 的选区，以及本页面自己的修改。为此在 `src/store/core.ts` 加了 `onLocalCommit(fn)`：只在 `setProject`（本页面的修改）落地后回调，远端来的改动（包括 Agent 在服务端的写入）走 `set`，不触发。选中着的片段换了对象就记一笔。
  - Agent 让页面执行的工具（`side: "page"`，以及没绑副本时的所有写工具）期间的修改不算用户动过：`src/ai/mcpExecutor.ts` 在执行前后调 `beginAgentTool` / `endAgentTool`。
  - 推到 `POST /api/agent/editing { session, entities }`，不等回包、`keepalive`。在编辑台挂上时开始（`src/editor/right/index.tsx`，与 Agent 工具通道同一时机）。在线构建按 `src/online/pageFlag.ts` 的写法就地放 `ONLINE_BUILD`，连同这条 `/api` 路径一起剪掉（在线页面没有编辑器进程，也没有本机 Agent 可提示）。
- 没有走播放头那条路（`/api/data/playhead`）：那条路由镜像插件在两个进程都挂、还转发给预渲染进程，编辑状态只有编辑器进程的 Agent 用得上；另开一条也避开了 `dataMirror.ts`。

### 2. 服务端：记下、判碰到、放进结果

- `server/agent/user-editing.mjs`（新）：
  - `createUserEditingBoard`：按页面会话整份替换；拖动 / 文字编辑 15 秒没续期就过期（页面关了或卡住），「刚动过」按页面报的剩余毫秒到期（最多 30 秒）；几个页面报同一片段取最强的那种。
  - 这次调用碰到哪些片段：参数点名的（`clipId`、`otherClipId`）＋实际写到的（这次提交的 ops 路径 `/tracks/@t/clips/@id/…`，`insert` 取新片段的 id）＋读整个项目的（`get_project`、不带 `clipId` 的 `get_layout`，算碰到全部正在编辑的）。
  - `annotateResult`：对象结果加 `userEditing` / `overwrote` 字段，`notice` 放在最前（模型先看到）；数组、标量包成 `{ notice, …, result }`；没东西可提示原样返回。工具抛错（比如 stale）时 `annotateError` 把「用户正在编辑」那句接在报错后面。
- 接线：
  - `vite-plugin-ai.ts`：建一个 board，`POST / GET /api/agent/editing`；绑了副本时把 `userEditing: () => board.current()` 和 `agentLabel`（对话 id → A1 登记表里的厂商）交给 `createAgentSide`；没绑副本时在 `callToolInternal` 里按参数点名的片段提示（写经页面执行，写到哪儿服务端不知道）。
  - `agent-side.mjs`：`callTool` 执行完按「参数 ∪ 实际写到的」算 `userEditing`，放进结果；抛错时接一句。
  - `agent-exec.mjs`：写入落地后，文档服务回的 `overwrote` 不再只记在 `ctx.write` 里，同时放进返回给 Agent 的结果；`ctx.write` 多记一项 `clipIds`（这次写到的片段）。

### 3. `overwrote` 的标法

每条：`{ entity, clipId?, by: 'user' | 'agent' | 'render' | 'unknown', who, label, rev, agoMs }`。

- 写入方是页面：本机页面 `label = '用户刚改过'`；共享项目里别的成员的页面 `'用户 <userId>刚改过'`。
- 写入方是别的 Agent：`'Agent <对话 id>刚改过'`，登记表里有厂商时 `'Agent <对话 id>(<厂商>)刚改过'`；身份取文档服务写入身份里的 `session`（`agent:<对话 id>`）。
- 提示句按有没有用户写的分两种说法：用户的要确认是不是用户要的、不是就改回并告诉用户；别的 Agent 的要确认没在抢同一处。

示例（探针 U4 实际拿到的）：

```
用户正在编辑片段 c-munespnm-v(刚动过)。这是提示不是禁止:用户可能正是在这里给你下指令;要改之前先确认不会覆盖用户手上的修改,拿不准就停下问用户。
这次写入覆盖了别人刚写的内容:片段 c-munespnm-v(用户刚改过,rev 2,1 秒前)。用户刚改过的地方被你这次写入盖掉了:确认这是用户要的,不是的话撤回或改回用户的版本,并告诉用户。
```

## 口径与数字〔裁〕

以下是语义没写到、按语义的意思定的三级细节，合入前请审：

1. **〔裁〕「正在编辑」的实体是片段**（卡片在时间轴上就是片段；字幕条属于它所在的字幕片段）。卡片定义的源码（`edit_card` 改的那一份）不在本段：页面的代码页编辑状态没有接进来。
2. **〔裁〕口径**按计划第 4 节第 1 条：拖动中、文字编辑中、选中后 30 秒内动过；只选中不动不算。补的细节：「动过」只认本页面经 `setProject` 落地的修改，且当时片段选中着；取消选中即作废；Agent 让页面执行的工具期间的修改不算；撤销 / 重做不算（它们不经 `setProject`）。
3. **〔裁〕拖动**以「真的动起来」为准（时间轴 `dragState`、舞台 `dragPreview`、字幕条 `drag` 有值时），按下没动不算。参数表单里拖数字、打字不单独报，靠「选中后动过」覆盖。
4. **〔裁〕数字**：「刚动过」30 秒；推送节流 250 ms（前沿立即发、窗口到点发最后一份）；非空心跳 5 秒；服务端对拖动 / 文字编辑的过期 15 秒（心跳的 3 倍）；「刚动过」服务端最多记 30 秒；每个页面最多 64 个片段、最多 16 个页面会话；提示里最多列 8 个片段。
5. **〔裁〕读整个项目算碰到全部正在编辑的片段**（`get_project`、不带 `clipId` 的 `get_layout`）；其余读工具按参数点名的片段判。`see_frames` 按时刻看画面不算（它不指名片段时看到的是画面，不是某一段的内容）。
6. **〔裁〕提示放在结果里**：`notice` 字段（在 JSON 的最前面）＋结构化的 `userEditing` / `overwrote`；工具报错时接在报错文字后面。只提示，不拦截、不改变写入是否落地。
7. **〔裁〕没绑副本时**（页面没接文档服务）只按参数点名的片段提示，且没有 `overwrote`（写入以页面身份提交，文档服务不会回给 Agent）。
8. **〔裁〕推送单开一条路** `/api/agent/editing`，不并进播放头那条（理由见上文第 1 节末条）。

## 验证

- **单测**（用例名带编号，UE = user editing；P = 页面汇总，W = 页面接线，S = 服务端）：
  - `node --test src/editor/userEditingCore.test.mjs` → 8 条全过：UE-P1 数字；UE-P2 拖动 / 文字编辑算、取最强、结束就撤；UE-P3 只选中不算、选中后动过算 30 秒、29.999 秒还算、满 30 秒不算；UE-P4 没选中的被改不算、取消选中作废、从最后一次动起算；UE-P5 前沿立即发、1 秒抖动至多 5 次、间隔 ≥ 250 ms、最后一份是最新的；UE-P6 状态没变不重发；UE-P7 5 秒心跳、剩余毫秒递减、30 秒到期发空的、空了不再发不挂定时器；UE-P8 关着不发、打开补发。
  - `node --test src/editor/userEditing.test.mjs` → 2 条全过：UE-W1 选中片段被本页面改了算、只选中与改没选中的不算、推送体形状（`/api/agent/editing`、`session`、`remainingMs`）、取消选中就撤；UE-W2 Agent 让页面执行的工具期间的修改不算。
  - `node --test server/test/user-editing.test.mjs` → 11 条全过：UE-S1 数字；UE-S2 整份替换、15 秒没续期清掉、续期留、「刚动过」按剩余毫秒到期、格式不对跳过；UE-S3 多页面取最强、30 秒截；UE-S4 碰到哪些片段（点名、ops 路径含 insert 与转义、读整个项目）；UE-S5 提示的放法；UE-S6 写入方的标法；端到端（真的文档服务 + 真的 `src/mcp/handlers` + `createAgentSide`）UE-S7 **读工具** `get_clip` 带 `userEditing(drag)`、读别的不带、`get_project` 也带；UE-S8 **写工具** `update_clip` 照常落地并带 `userEditing(recent)`；UE-S9 **overwrote 页面写入**标「用户刚改过」、同一对话再写不再提示；UE-S10 **overwrote 别的 Agent 写入**标「Agent conv-B(claude)刚改过」。
- **类型检查**：`npx tsc -b --force` → 退出码 0，0 错误。
- **全量测试**：`npm test` → `tests 4067 / pass 4065 / fail 0 / skipped 2`，退出码 0（main 上 4046 条，多出的 21 条是本段新加的）。第一轮跑时 `C10A-API-03`（在线构建的 `/api` 棘轮清单）红了一条：在线产物里出现了 `/api/agent/editing`；按 `pageFlag.ts` 的剪枝写法改后，`c10a-online-build`、`onlinePrune`、`modeImportGuard` 14 条全过，第二轮全量全绿。
- **代码指纹**：`snapshotCode` = `00a5264bf8a062ff6e0b5ed0516cccd1`，`captureCode` = `86e443cb6fa838aef64788af6822fd68`，都没变。
- **探针**：起 dev server（`PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5770 --strictPort --host 127.0.0.1`），`node scripts/probes/user-editing-probe.mjs --origin http://127.0.0.1:5770 --shots <目录>` → 18 项全过，退出码 0：
  - U1 Agent 服务端绑上项目副本（local）、读得到新放的卡；
  - U2 无头页面在时间轴上按住一张卡拖动（不松手）：服务端记着 `drag`；经 `/api/mcp/call` 以 Agent 身份 `get_clip` 读它，结果带 `userEditing: [{ kind: 'drag' }]` 和「用户正在编辑片段 …(拖动中)」；读另一张不带；
  - U3 松手：拖动落地（start 1 → 1.6），状态变成 `recent`；
  - U4 Agent `update_clip` 写它：照常落地，结果带 `overwrote`（`by: 'user'`、`label: '用户刚改过'`、rev 2）与覆盖提示、`userEditing(recent)`；页面收到了写入；Agent 的写入不算「用户动过」；
  - U5 取消选中：状态清空，再读不带提示；页面无未捕获异常。
  - 看过截图 `dragging.png`：拖动中的那张卡选中、已被拖离原位。
  - dev server 已停（只停了自己起的 5770 那个进程）。

## 没做成的 / 不在本段

- **跨设备**（共享项目里别的成员正在编辑）没做：它要文档服务加一条「编辑状态」协议（页面经文档服务广播、成员页面与 Agent 服务端订阅），托管端要重新部署。按计划与 A3 的公告板进文档服务一起做，只部署一次。本段服务端的 board 以页面会话为键，届时加一个来源（文档服务推来的成员状态）即可；`writerOf` 已能标「用户 <userId>刚改过」。
- 卡片源码的代码页编辑状态、参数表单的「正在输入」没有单独上报（见〔裁〕1、3）。
- `overwrote` 只在绑了副本、Agent 在服务端写入时有；经页面执行的写工具以页面身份提交，没有。
- 被覆盖方（例如别的 Agent）收到的 `project.overwritten` 仍只在文档服务连接层，没有转进那个 Agent 的下一次工具结果（语义「双方都要知道」的被覆盖一方）。这一侧要按对话把 `overwritten` 记下、在它下一次调用时带出，属于 A3（多 Agent 协调）的范围，本段没做。

## 语义 dry run（`docs/semantics/mechanism/agent.md`，三级；没有改文件）

修改前（`## 创造力等级的判定` 之后没有这一节）。

修改后（在文末加一节）：

> ## 用户正在编辑与覆盖提示
>
> - 编辑页把「正在编辑」的片段推给编辑器进程：拖动中、文字编辑中，以及选中后 30 秒内被用户动过的；只选中不动不算，取消选中即作废，Agent 让页面执行的修改不算用户动过。状态一变就推，两次至少隔 250 ms；非空时每 5 秒续一次，服务端 15 秒收不到续期就清掉。
> - Agent 的工具调用读到（参数点名，或读整个项目）或写到（这次提交实际改到的）这些片段时，结果带 `userEditing` 与一句给模型看的提示；只提示，不拦截。
> - 文档服务对一次提交回的覆盖（10 分钟内覆盖了别的写入身份写的实体）放进这次工具结果：写入方是页面的标「用户刚改过」，是别的 Agent 的标「Agent <身份> 刚改过」。
> - 共享项目里别的成员正在编辑（跨设备）要经文档服务传，尚未实现。〔裁：2026-09-30 `claude/user-editing`，出处 `docs/plan/agent-workflow-plan.md` A2〕

## 需要主会话 / 用户决定

- 审上面 8 条〔裁〕与 dry run，决定是否写进 `mechanism/agent.md`。
- 合并 `claude/user-editing`（`--no-ff`），或返工。
