# 018 acceptance test placement

## 开工记录

- 基线：`e67ca4cffec228fcb031e1e3c797f532631d728a`，分支 `codex/018-acceptance-test-placement`。
- 范围：把端口平移的两个断言从独立测试文件移入既有 `server/test/four-stage-acceptance.test.mjs`，并删除造成 bakery-deps 分层守门失败的独立测试文件。保留断言内容与真实 manifest 命令检查，不改端口实现、测试白名单或产品代码。
- 验证：仅运行获准的定向 npm 测试；不运行完整测试、不启动服务。
