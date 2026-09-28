# AGENT-no-user-videos：测试与探针不写用户的 Videos\PromptCut

分支 `claude/no-user-videos`（从 main `e27fa520` 拉出）。

## 任务
核对自动化测试与探针有没有任何一处会写到 `%USERPROFILE%\Videos\PromptCut`（桌面版的导出目录，帧库已长到 273 GB），有就改到仓库 `out/` 或临时目录，并加守门。

## 进展
- [ ] 静态核对清单
- [ ] 修
- [ ] 守门
- [ ] 验证
