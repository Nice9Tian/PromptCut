# AGENT-join-error 报告

分支 `claude/join-error`，worktree `.worktrees/join-error`。

## 任务

加入共享项目时，`enterShared` 把「连接在打开之前就关闭」一律判成 auth，页面显示「用户名或密码不对」；实际多是 WebSocket 没建成。要分清：服务器明确回认证失败 → 保留原文案；连接没建成 → 报连不上；其它照旧。

## 进展

（进行中）
