# AGENT-undo-refresh 报告

分支 `claude/undo-refresh`，worktree `.worktrees/undo-refresh`，基于 main a038948。

任务：修「点『撤销这步』后文档服务里那条轨道已删，页面时间轴要等下一次改动才刷新」（来历：`REPORT-C6.6.md` 第 11 节第 1 条）。「撤销这步」指 AI 栏操作卡上撤掉 Agent 某次写入的按钮（`c65-design.md` 第 8 节）。

## 根因

不在 `src/editor/sync/`，在 `src/store/docsync.ts`：

- `AgentUndoButton` → `revertAgentOp` → `DocSync.revertRemote` → `applyRevert` → `commitInternal(..., kind = undefined)`，最后 `setLocal(r.value, target ?? "commit")`，以 `commit` 为因发 `project` 事件。
- `bindStore` 的 `project` 监听对 `commit`、`load` 直接返回：这两种本该是 store 自己的 `setProject` / `loadProject` 发起的，由调用方拿返回值写 state。
- 但「撤销这步」不经 `setProject`，是 `syncManager` 直接调 DocSync。于是 DocSync 的本地副本已撤、提交也发给了文档服务（所以服务端轨道已删），store 里的项目对象却没换，页面不刷新；等下一次改动（任何 `setProject` 或远端 `project.ops`）才把 DocSync 的本地副本带进 state。
- 普通撤销（Ctrl+Z）走 `revert(step, "undo")`，以 `undo` 为因，`bindStore` 会写 state，所以没这个问题。与远端操作的订阅、store 换对象都无关。

## 修法

- `project` 事件的因多一个 `revert-remote`；`commitInternal` 多一个 `cause` 参数（缺省仍是 `target ?? "commit"`，其它调用不变）；`applyRevert` 撤别人那一步时传 `revert-remote`。
- `bindStore` 不用改：非 `commit` / `load` 的因一律 `set({ project, dirty: true })`，与撤销、重做同一条路。写进 state 的是 DocSync 新算出的对象，不原地改（测试钉了撤之前那份对象没变）。

## 提交

- 9ddcea3 文档：报告（开工）
- 0fb57d4 测试：修前失败的单测（`src/store/docsyncStore.test.mjs` 末条：Agent 加轨道 → 页面 `revertRemote` → 断言 store 当场就是撤后的对象、换了新对象、旧对象没被改、Ctrl+Z 能恢复且 store 跟上、最后与服务端一致）。修前在「store 里就是 DocSync 撤后的那一份」处失败（store 里仍有 3 条轨道，DocSync 里 2 条）。
- ceab9e4 修：`src/store/docsync.ts`

## 验证

- `node --test src/store/docsyncStore.test.mjs src/store/docsyncEditor.test.mjs src/store/docsync.test.mjs`：45 过 0 失败（修前新测试失败）。
- `npx tsc -b --force`：退出码 0，零输出。
- `npm test`（未设 `PROMPTCUT_BASE`）：退出码 0；tests 3411、pass 3409、fail 0、skipped 2（`/api/cards/layout` 集成、SKILL 闸门集成，均为需显式开启的集成测试）。
- 没改预览路径，没跑 preview-fallback-probe / `--page-preload`；没起 dev server、没做页面级复现（单测已经经过真实 store 与 `bindStore`）。

## 更正建议

- `REPORT-C6.6.md` 第 11 节把位置写成 `src/editor/sync/`，实际在 `src/store/docsync.ts`（`applyRevert` 发出的因）。
