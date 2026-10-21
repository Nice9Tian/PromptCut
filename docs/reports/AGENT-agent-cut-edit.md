# AGENT-agent-cut-edit

分支 `claude/agent-cut-edit`（自 `claude/accept-final3` @f7d5e6bf）。任务：云端 Agent 的两个工具问题（线上 visuhive.com 2026-10-21 观察到）。

1. `update_clip` 的 `params` 是合并补丁，工具说明没说；模型凭记忆把整份旧参数带回来，把用户刚「撤销这步」撤掉的颜色悄悄写了回去。
2. 片段在没有激活的剪辑里时，`update_clip` 报「找不到 clip」，Agent 只好 `switch_cut`（改共享的 `activeCutId`，所有成员的界面一起翻）、改完再切回来：一次必败的调用加两次多余的写入，线上每轮都有。

## 做了什么

### 问题 1：params 是增量补丁

- `server/tools/clips.mjs`：`update_clip` 说明加一段：params 是增量补丁、不是整份替换；只传这次要改的键，没传的键保持当前值；不要凭记忆把以前读到的整份参数带回来（可能已被用户或别的操作改过，如刚点了「撤销这步」）；要知道现在的值先 `get_clip`。静态 schema 里 `params` 也带同样的一句（`PARAMS_PATCH_DESC`）。`set_clip` 说明里写明它的 `params` 段是整份替换（没写的键回到卡片默认值），与 `update_clip` 区分（这是 set_clip 的既有行为，只是以前没说）。
- `server/card-params-schema.mjs`：按 cardId 注入的真实 schema，`update_clip` 用补丁版（`buildParamsSchema(cards, { patch: true })`）：说明写明补丁语义，且各分支**不带 `required`**（必填键已在 clip 上；以前模型看到 required 和整排字段，容易整份重传）。`add_clip` 的 schema 不变。
- 回包回显（`src/mcp/tools/toolEcho.ts` 的 `paramsEcho`，`src/mcp/handlers/clips.ts` 用）：改 params 时回包多 `changedParams`（每个真正变了的键 from → to，长值截断）和 `params`（改完后的全貌；超过约 2000 字只给键名 `paramKeys`）。带回旧值的那一刻，模型在回包里就能看到自己把哪个键改回去了；下一轮也不必靠记忆。不改 params 的调用不带这两项。
- 合并行为本身没改：`setClipParams` 默认 `merge:true` 一直如此，新测试把它钉住。

### 问题 2：不切换激活剪辑，就地改任意剪辑里的片段

存法：激活剪辑的 tracks / duration / transitions 住在项目本身（`Project.tracks`），停放的各自带在 `cuts[]` 条目里（`kernel/cuts.ts`）。几十个 store 动作都是「`findClip(state.project, id)` + `setProject`」只认激活剪辑，逐个改成能指定剪辑风险大。选了「视图」做法：

- `src/kernel/cuts.ts`：`cutEditView(real, cutId)`——把 `cutId` 那条当激活的项目视图（A 退回条目、带着自己的内容）；`foldCutEdit(real, edited, cutId)`——动作产出的新项目折回真实形状：只有 `cuts[cutId]` 条目的 tracks / duration / transitions 变，`activeCutId` 和激活剪辑的内容用 `real` 的（同一份对象）；停放剪辑的总时长按和激活剪辑同一条规则（`duration.ts`，至少 1 秒）跟着内容走；全是新对象，不原地改 store 里的项目对象；`parkedCutOfClip` 找片段在哪条停放剪辑里。
- `src/store/core.ts`：`runInCutScope(cutId, fn)`。fn 执行期间 `state.project` 换成视图，动作原样工作；这期间 `setProject` 把新项目折回真实形状再提交（撤销栈、文档服务同步看到的 prev / next 都是真实形状，一次工具调用一次提交），`set` 通知监听者前先换回真实项目——任何监听者、同步层都看不到视图。fn 必须同步（包异步函数直接抛错）；嵌套改另一条剪辑抛错。`actions.editInCut(cutId, fn)` 是对外入口（`store/actions/cuts.ts`）。
- `src/mcp/clipCut.ts`（新）：`inClipCut(handler)` 包住按 `clipId` 找片段的 handler：片段不在激活剪辑、在某条停放剪辑里时，在那条剪辑的视图里执行；回包加 `cut: { id, name, active:false }` 和 `cutNote`，`timeline` 是那条剪辑的，去掉 `look`（`see_frames` 只看激活剪辑）。已包的十个工具：`update_clip`、`get_clip`、`set_clip`、`set_position`、`set_rect`、`align`、`nudge`、`set_emphasis`、`set_clip_volume`、`set_clip_muted`（都是同步、只改片段自身属性）。
- 没包的按 clipId 找的工具（`remove_clip`、`duplicate_clip`、`split_clip`、`get_layout`、`set_cut_segment` 等）找不到时，报错改为说清：「它在剪辑「X」(id) 里，这个工具只改激活剪辑里的片段，先 switch_cut」。其中 `remove_clip` 以前对停放剪辑里的片段会静默返回 `ok:true` 而什么都没删，现在抛这个错；`duplicate_clip` / `split_clip` 以前是笼统的「复制失败」「切分失败」。
- `list_cuts` 多收可选的 `cutId`：多返回那条剪辑的 `timeline` 一览（序列和片段 id、起止），Agent 不用切过去就拿得到停放剪辑里的 clipId（路由表 `passArgs` 改为 true，`EditorApi.listCuts(args?)`）。
- `src/kernel/agentScopes.mjs`：`diffScopes` 认停放剪辑被就地改了（记「那条剪辑->序列」），多 Agent 公告板的范围不漏。
- 说明与系统提示词：`list_cuts` / `switch_cut` / `update_clip` 的说明、`server/ai-system-prompt.md` 的「多条剪辑」一条，改为「add_clip、序列、导出、see_frames 这类只作用于激活剪辑；改别的剪辑里已有的片段不用切；激活剪辑是共享状态，切换会让所有成员的界面一起翻，能不切就不切」。

## 验证

见文末「验证结果」。

## 没做 / 已知限制

- 新增 / 删除 / 切分 / 复制片段、加转场、序列类工具、部件树工具、滤镜与音频效果的 apply、`get_layout`、`see_frames` 仍只作用于激活剪辑（它们要么是异步、要么会改结构 / 项目级对象，如 `remove_clip` 里的 `pruneCardNodes` 只看当前剪辑的片段会误剪停放剪辑用到的卡片节点——这是既有行为，切过去删时同样如此）。需要时仍 `switch_cut`。
- 聊天栏的前后对比图（`withVisual`）对停放剪辑里的片段没有验证：它按激活剪辑找片段，找不到时静默不带图（该路径本来就「交不上就算了」）。画面没有看（本任务不涉及渲染）。
- 停放剪辑里片段的画面 Agent 看不了（`see_frames` 只渲染激活剪辑）；回包的 `cutNote` 已写明。
- `set_clip` 的 `params` 段仍是整份替换（既有行为），只补了说明。

## 语义冲突与 dry run（未改语义文件）

`docs/semantics/product/project-model.md` 第 14 行：

- 修改前：「同一时刻只有一条剪辑处于激活状态。编辑、Agent 工具、预览、导出都只作用于激活的那条。」
- 修改后（建议，二级）：「同一时刻只有一条剪辑处于激活状态。编辑界面、预览、导出只作用于激活的那条。Agent 工具里按片段 id 修改片段属性的那几个（改参数、时段、框、强调、音量静音），片段在别的剪辑里时就地修改那条剪辑，不切换激活的剪辑——激活的剪辑是所有成员共享的，切换会让每个人的界面一起翻。」

`docs/semantics/mechanism/project-model.md`「剪辑的存法」后可加一条（三级）：「就地改停放剪辑里的片段：把那条剪辑当激活的视图交给现成动作，提交时折回，只改它条目里的 tracks / duration / transitions（`kernel/cuts.ts` 的 `cutEditView` / `foldCutEdit`，`store/core.ts` 的 `runInCutScope`）。」

用户看到的差别是少翻视图，没有新承诺，我判为三级改动；但第 14 行的字面「Agent 工具……都只作用于激活的那条」与新行为不符，拿不准按高一级办，所以只在这里列 dry run，等用户定要不要改语义文件。

## 部署清单

均未部署（任务要求不部署）。改到的文件：

| 位置 | 文件 |
|---|---|
| Agent 服务（工具定义与提示词，`server/`） | `server/tools/clips.mjs`、`server/tools/cuts.mjs`、`server/card-params-schema.mjs`、`server/ai-system-prompt.md` |
| `src/`（Agent 服务经 ssrLoadModule 载入的页面工具实现与 store；同时是在线前端的一部分） | `src/kernel/cuts.ts`、`src/kernel/agentScopes.mjs`、`src/store/core.ts`、`src/store/actions/cuts.ts`、`src/mcp/clipCut.ts`（新）、`src/mcp/handlers/clips.ts`、`layout.ts`、`audio.ts`、`effects.ts`、`src/mcp/routes.mjs`、`src/mcp/tools/toolEcho.ts`、`src/ai/mcpExecutor.ts`（只改 `listCuts` 的类型） |

- `/opt/promptcut-v2/releases/35f7b2ab/pc`：上面全部（`server/` 与 `src/` 两部分），重启 `promptcut-agent`（工具定义、harness、ssr 载入的 `src/` 都在它里面；改了 `server/tools` 与 `card-params-schema`）。
- `/opt/promptcut-render/releases/35f7b2abb9db`：`src/` 那一批（该树里的 `src/` 要与上面一致，`src/store/core.ts`、`src/kernel/cuts.ts` 是共用代码；渲染服务本身不执行这些工具，不需要为此重启 render 服务，若部署脚本习惯同步整棵 `src` 则一并同步）。
- 在线前端：需要重新构建发布（`src/store/core.ts`、`src/kernel/cuts.ts`、`src/kernel/agentScopes.mjs`、`src/mcp/*` 在前端包里；浏览器侧 Agent 页面执行路径用的是同一份）。只为问题 1 的话前端不用动（说明与 schema 都在 `server/`）。
- 只要 `server/` 那 4 个文件上线，问题 1 就生效；问题 2 需要 `src/` 批和 `server/tools/cuts.mjs`（`list_cuts` 的 `cutId` 参数与路由表 `passArgs`）一起上线，缺一半会出现「说明说不用切，但工具找不到」，所以 `src/mcp/routes.mjs` + `src/mcp/handlers/*` + `server/tools/cuts.mjs` 要同批。

## 验证结果

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（`PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`，`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`）：**退出码 0，tests 7310，pass 7295，fail 0，skipped 15**，「npm test 最终结果：零失败」。
- 第一次全量跑有两项红，已处理：
  - `C10A-API-03`（在线构建产物里不许出现 `/api/` 路径）：我用 `inClipCut(...)` 包 handler 后，对象字面量里的函数调用在摇树时算有副作用，音频与配音的 `/api/audio/measure`、`/api/voice/*` 被带进在线包。改为 `/* @__PURE__ */ inClipCut(...)`（和 `src/mcp/api.ts` 同一个做法），该项复跑通过。
  - `W1-RUN-02`（网页接管的停止用例）：满载并发下超时失败；单独跑该文件 15 项全过，第二次全量跑也过。与本任务无关，判为负载下的偶发。
- 新增测试（全部通过）：
  - `server/test/tool-schema.test.mjs` +5：update_clip 说明的措辞（增量补丁、只传要改的键、没传的保持、别凭记忆整份带回、get_clip、changedParams）、静态 schema 与注入后 schema 的补丁说明和无 required、add_clip 不受影响、set_clip 说明。
  - `src/mcp/handlers/updateClipPatch.test.mjs` 5 项：合并行为（只传 size，其余保持）、用户 undo 之后只传 size 不把撤销的颜色写回、整份旧参数带回时 `changedParams` 点出被写回的键、不改 params 不带回显、`paramsEcho` 的截断。
  - `src/mcp/handlers/parkedCutEdit.test.mjs` 16 项：十个工具改停放剪辑里的片段、activeCutId 与激活剪辑 tracks 同一份对象、监听者从未见过视图形状、同步层 prev/next 为真实形状且一次工具调用一次提交、文档差异只在 `/cuts/@B/…` 下、一步撤销、停放剪辑总时长跟着内容走、出错后还原、嵌套 / 异步被拒、`list_cuts({cutId})`、说明措辞。
  - `server/test/agent-parked-cut-edit.test.mjs` 3 项：真文档服务 + 真执行器（vite ssr 载入工具实现）端到端：停放剪辑里 update_clip 只提交一次、activeCutId 不变、Agent 副本与真身逐项相同；get_clip / set_rect / list_cuts；删除停放剪辑里的片段被明确拒绝且不提交。
  - `src/ai/agentBus.test.mjs` +1：`diffScopes` 认停放剪辑。
- 没看图、没跑探针：本任务不改画面（渲染、舞台、预渲染都未动）。没有在真浏览器里点过编辑界面；用户页面一侧的行为靠「监听者只见真实形状」的单测和同步层 prev/next 断言保证。

## 请用户定的事

1. 是否合并 `claude/agent-cut-edit`（我未合并、未推送、未部署）。
2. 语义文件第 14 行要不要按上面 dry run 改（我没改）。
3. 部署顺序：问题 1 只要 `server/` 四个文件；问题 2 的 `src/` 批与 `server/tools/cuts.mjs` 同批上线。
