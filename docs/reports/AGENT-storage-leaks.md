# AGENT 报告：storage-leaks

分支 `claude/storage-leaks`，起点 main `e3a5726a`。任务：`docs/plan/storage-plan.md` 的 A 部分（泄漏修复，三级缺陷，不改语义）。

## 进度

- [ ] 1 `mov\playback-<uuid>.mov` 用完即删、启动清
- [ ] 2 `mov\full-<pid>.tmp.mov` 中止即删、启动清
- [ ] 3 `html-cache\live-<pid>-*` 启动清
- [ ] 4 `tracks\<键>\preview-*.tmp.mp4` 中止即删、启动清
- [ ] 5 导出中间文件
- [ ] 6 `export-vision-*`
- [ ] 7 导出对话框文案
- [ ] 验证
