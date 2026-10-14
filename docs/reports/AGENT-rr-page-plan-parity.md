# AGENT 报告：rr-page-plan-parity（在线页面算单卡流与切分方的流计划对齐）

分支 `claude/rr-page-plan-parity`，工作区 `.worktrees/rr-page-plan-parity`，端口段 27540～27579。

## 任务

在线页面 `src/online/pageStreamPlan.ts` 的 `planPageStreams` 调 `groupStreams` 时，`fixed`（不参加合并但占预算的流）只收了单独成流的两类卡，没收依赖下层的流；服务端 `server/frame-stream.mjs` 的 `planStreams` 两样都收。同屏流多到要看像素预算时，两边对「哪几张独立卡并成组流」可能判得不一样。

## 进度

- 开工。
