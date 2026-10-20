# AGENT 报告：stream-toggle-feedback

分支 `claude/stream-toggle-feedback`（起点 main `82ab4933`）。

任务：账号云端项目的「项目设置」里，「生成轨道流」开关在创建者不在 `render_streams` 权限分组时没有置灰、没有提示；保存被 403 拒绝后界面静默。查根因、修好、补测试、验证。

## 进度

- [ ] 查清 403 原因与 `streamsAllowed` 为什么没生效
- [ ] 修复
- [ ] 测试
- [ ] 验证（tsc、npm test、浏览器实测）
- [ ] 部署清单
