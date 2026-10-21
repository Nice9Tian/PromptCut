# AGENT-agent-undo-cut

分支 `claude/agent-undo-cut`（自 accept-final3 f138644d）。缺陷：线上项目 验收018-复验2，Agent 在最后一轮做了 switch_cut→剪辑2、update_clip（size 3→5）、switch_cut→剪辑1；之后点那张操作卡上的「撤销这步」毫无反应（size 仍是 5，按钮不变成「已撤销」，没有提示）。

## 根因

两件事叠在一起（用 `src/store/docsyncCutUndo.test.mjs` 的第一个用例在修复前复现，结果 `{"done":false,"skipped":[],"failed":["/tracks/@tb/clips/@cb"]}`）：

1. **逆操作的路径是写入当时的位置，之后搬了家就落不下去。** 激活剪辑的序列住在 `/tracks`，停放的住在 `/cuts/@X/tracks`；switch_cut 把序列在两处之间搬。Agent 那次 update_clip 的逆操作是 `/tracks/@tb/clips/@cb/params…`（写的时候剪辑2 是激活的），第二次 switch_cut 之后 tb 已经搬回 `/cuts/@cut2/tracks`，这条路径不存在，`applyOps` 失败，整步记为 failed、一处没撤成。（不是我最初猜的「被后来的 switch_cut 写入挡住」：switch_cut 写的实体是整条序列，与片段实体不相等，没有算作冲突。）
2. **失败几乎是静默的。** docsync 确实发了 `revert-remote` 通知、撤销提示条（`UndoNoticeBar`）会显示「没撤成…已不存在，没法退回」，但只停 8 秒；当结果既没有 skipped 也没有 failed（例如逆操作已经是现状）时，`revertAgentOp` 什么都不弹。线上看到的「没有 toast、没有 dialog」与这两条吻合（我没法在真浏览器里看那条提示条，见「没验证」）。

另外，查「反方向」时发现一个同源的隐患：撤销的冲突表用规范里的实体名（`/cuts/@X/tracks/@T/clips/@C` 与 `/tracks/@T/clips/@C` 是两个不同的字符串），所以别人在那条剪辑停放时改的和激活时改的，互相看不见——撤 Agent 那一步会静默盖掉别人后来的改动。

## 改了什么

- `src/kernel/cutPaths.ts`（新）：
  - `relocatePath` / `relocateOps`：按序列 id 找它**现在**住哪（激活的 `/tracks` 或停放的 `/cuts/@X/tracks`），把逆操作路径改写过去。已经在对的地方、序列真的没了、指到 `/tracks` 数组本身、没有 cuts 的老项目，都原样（真没了的照老规矩落在 failed 里，提示条会说）。纯函数，不改入参。
  - `undoEntity` / `undoEntityOfOp` / `undoEntitiesOf`：撤销冲突口径的实体名，序列 / 片段不分住在哪。规范里的 `entityOfPath` 不动（文档服务同一口径、通知与提交摘要在用；有现成的规范测试钉着它）。
- `src/store/docsync.ts`：`applyRevert`（用户自己的撤销、重做、「撤销这步」三条路共用）套用前先 `relocateOps`；撤销冲突表（别人的写入、自己的写入、还没确认的本地修改、撤销栈的步、逆操作）都改用 `undoEntitiesOf`。落地不切换激活剪辑，提交的是新对象（不原地改）。
- `src/editor/sync/syncManager.ts`：`revertAgentOp` 在「一处没撤成、又没有 skipped / failed 可提示」时弹 toast，不再静默。
- `src/editor/sync/labels.ts`：提示条里按实体取名时，停放剪辑里的片段也取得到名字（`relocatePath` 兜底）。

## 测试（修复前复现用例红，修复后全绿）

- `src/store/docsyncCutUndo.test.mjs`（真 DocSync + MemDocService，8 项）：
  - 复现：Agent switch_cut→改→switch_cut，再撤那次改动，撤成功、`activeCutId` 不变、激活剪辑里的片段不动；
  - 撤销之后再 Ctrl+Z 恢复 Agent 的改动；
  - 反方向：Agent 在停放剪辑里就地改（路径 `/cuts/@cut2/…`），之后 cut2 被激活，再撤；
  - 自己的撤销：在 cut2 激活时改，别人把激活剪辑切走，Ctrl+Z 仍撤得掉；
  - 真冲突两种（别人在停放时改同一片段、别人切过去改了又切回），都不撤、`skipped` 点名实体与是谁、有 `revert-remote` 通知、保留现在的样子（这一项在没有 `undoEntity` 时红，已验证）；
  - 别的片段后来被改过，不挡这一步；
  - 序列真被删了：done=false 且有 failed / skipped。
- `src/kernel/cutPaths.test.mjs`（5 项）：`trackHome`、`relocatePath` 两个方向与原样情形、`relocateOps` 不改入参、`undoEntity*`、`entityOfPath` 规范口径不变。

## 验证

- `npx tsc -b --force`：退出码 0。
- 全量 `npm test`（`PROMPTCUT_ACCOUNT_PROVIDER_ROOT` / `PROMPTCUT_PASSWORD_ORDER_MODULE` 指到 VisuHive 仓库）：**退出码 0，tests 7303，pass 7288，fail 0，skipped 15**，「npm test 最终结果：零失败」。第一次全量跑有一项红：`server/test/codex-auth-state.test.mjs` 的「runtime does not invalidate on network disconnected」（读 JSON 时读到半截），与本任务无关；单独跑该文件 27 项全过，第二次全量跑也过，判为负载下的偶发。
- 没验证：没有在真浏览器里点「撤销这步」，也没看那张提示条的实际样子（本任务不涉及画面；toast 与提示条的逻辑只验到 docsync 产出的 result 与通知）。线上那个项目的实际数据没有碰。

## 与另一个分支的关系

`claude/agent-cut-edit`（问题 2，就地改停放剪辑）会让 Agent 的逆操作路径在 `/cuts/@X/tracks` 下；本分支的 `relocatePath` / `undoEntity` 正好覆盖这个新形态（反方向用例就是它），两个分支互不依赖、可以任意顺序合入。

## 部署清单（均未部署）

全是 `src/`，没有 `server/` 文件：

- `src/kernel/cutPaths.ts`（新）、`src/store/docsync.ts`、`src/editor/sync/syncManager.ts`、`src/editor/sync/labels.ts`。
- 在线前端：需要重新构建发布（这四个文件都在前端包里，撤销全在页面里发生）。
- render 树：`src/` 同步一份即可，渲染服务不执行这些代码，不需要重启。
- 不需要重启 `promptcut-agent`（不改 Agent 服务端的工具、harness、提交逻辑）。

## 语义

没有改语义文件。行为符合现有语义（`workflow/editing.md`：「要撤的那一步改过的地方之后没有别人再改，直接撤回；别人在它基础上又改过，弹出冲突合并窗口」）：此前是实现没有跟上「同一个片段不论所在剪辑是否激活」。撤销冲突仍走现有的撤销提示条，没有新增界面。
