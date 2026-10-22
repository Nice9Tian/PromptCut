# AGENT 报告：claude/join-requests（进入方式的勾选、账号名单、申请加入）

- 分支：`claude/join-requests`（从 main `e27d36b4` 切）
- worktree：`.worktrees/join-requests`
- 端口段：5940～5949
- 任务：补云端项目的「任何知道链接的人都可加入」勾选和账号名单界面，做通「申请加入」。语义见 `docs/semantics/workflow/project.md` 第 26、27、44 行一带（2026-10-22 用户定）。

## 进度

- [ ] 读规则、语义与现有代码
- [ ] 服务端：名单快照规则、申请的发送 / 查询 / 通过 / 拒绝
- [ ] 服务端测试（安全论证六问每问都有测试）
- [ ] 页面：勾选框、被挡住时的「发送申请」、成员浮层里的申请列表与角标
- [ ] 看界面并截图
- [ ] 门槛：`npx tsc -b --force`、`npm test`、`npm run build`

（下面各节随做随补。）
