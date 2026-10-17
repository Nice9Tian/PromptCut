# 报告：文档服务的 EACCES、10-08 起没办完的退出续办、余下的空转 CPU

- 分支：`gemini/docservice-eacces-logout`
- 工作区：`.worktrees/docservice-eacces-logout`
- 基线提交：`7c0abadc`（包含 `e4924848`）
- 依据任务书：`docs/plan/docservice-eacces-logout-task.md`
- 状态：排查中

## 1. 第一件：每到任务绑定或结束的那一刻，冒一次 EACCES

（待写入排查证据、影响分析、修复方案与测试）

## 2. 第二件：一条 10-08 的「退出别的设备」一直没办完，每秒重办一遍

（待写入排查证据、性质判断、收尾与退避建议及测试）

## 3. 第三件：修好以后文档服务空闲时仍有约 15% CPU

（待写入排查数据与优化建议）

## 4. 基线验证结果

（待写入 `npx tsc -b --force` 与 `npm test` 输出）

## 5. 需要用户决定的事项

（待汇总）
