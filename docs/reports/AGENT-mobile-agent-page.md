# AGENT-mobile-agent-page：手机版 Agent 分页照演示稿重画

分支 `claude/mobile-agent-page`（从 main `13c89af6` 切出），worktree `.worktrees/mobile-agent-page`，端口段 5980～5989。

## 任务

照 `prototypes/mobile-ui-demo/` 重画手机版（`src/mobile/`）的 Agent 分页：对话标签、消息气泡、操作卡片、输入框、输入框上方的引用标记条；没有会话时显示开始页（和桌面共用 `src/ai/agentTabs.ts` 的逻辑）。桌面界面不受影响。出处：`docs/plan/mobile-online-task.md` 文末「待用户项」第 3 条（用户 2026-10-21 定另开一项先做，2026-10-22 定派子 Agent 做）。

## 进度

- [ ] 摸底、读规则与演示稿
- [ ] 视图模型（消息 → 气泡 / 操作卡片）与引用文字的纯函数 + 单测
- [ ] Agent 分页组件、样式
- [ ] 开始页（预设、引导动画、清空后不放动画）
- [ ] 引用标记条（点「引用」后出现、发送带上引用）
- [ ] 语义写进 `workflow/editing.md`「手机版界面」
- [ ] 探针（尺寸对演示稿、引用标记条、开始页）与旧探针的断言改动
- [ ] 并排截图
- [ ] tsc、全量 npm test

## 做了什么

（边做边补）

## 〔裁〕清单

（边做边补）

## 验证结果

（边做边补）

## 没做到的与原因

（边做边补）

## 部署清单

（边做边补）
