# AGENT-card-overlay 报告

分支 `claude/card-overlay`（从 main a038948 拉出），worktree `.worktrees/card-overlay`，端口 5610～5619。

## 任务

修用户卡与改动层的两处 M8 之前遗留：

1. `create_card` 带 overwrite 时新内容被改动层旧版盖住（PAUSE-2026-09-26.md 第 4 节、REPORT-C6.6.md 第 11 节）。
2. 主机本来没有的用户卡写进检出目录 `src/cards/user/`（REPORT-C6.6.md 第 5 节〔裁〕、第 11 节）：要求主机完全不写检出目录，用户卡加载器也扫改动层。

## 进展

（进行中）
