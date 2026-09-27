# AGENT 报告：粒子卡暂停时画面全透明

分支 `claude/particles-blank`，worktree `.worktrees/particles-blank`，端口 5860～5869。

## 任务

粒子素材卡（`src/cards/native/particles.tsx`，tsParticles）在编辑器预览里暂停时画面全透明。找根因，按卡片硬约束修，使暂停与导出时粒子画面按时间确定地画出来。

## 进度

- 开工，建报告。
