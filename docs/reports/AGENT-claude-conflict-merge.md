# AGENT 报告：claude/conflict-merge（0.7.19 冲突合并窗口）

分支 `claude/conflict-merge`，从 main `ca4fc432` 切出；worktree `.worktrees/conflict-merge`；端口段 5890～5899。

任务：固定非本机快照、断网保留（在线浏览器落盘至浏览器本地缓存）、重连后逐项合入面板——做出共用的「冲突合并」窗口。
语义出处：`workflow/editing.md`「撤销、重做」、`workflow/project.md`「暂时离线项目与保存」、`product/document-service.md`「冲突」「离线」、`mechanism/document-service.md`「保存基准与修改状态检查」。

## 进度（逐块）

1. 逐项引擎 `src/editor/sync/mergeItems.ts` + `mergeItems.test.mjs`（MI-01～12 全过）— 提交 d647d7b7
2. 文档服务待合并表模块 `server/docservice/modules/pending-merge.mjs` + `server/test/pending-merge.test.mjs`（PM-01～07 全过）— 提交 3afb170e
3. 页面侧待合并表与离线批次转表 `mergeTable.ts`、`offlineCache.ts`、`offlineTransfer.ts` + `offlineMerge.test.mjs`（OM-01～06 全过）— 提交 b35281fa
4. 同步层接入、桌面窗口与导航栏按钮、手机版面板、断网导入置灰 — 提交 d960e341
5. 界面截图与全量门槛 — 进行中
