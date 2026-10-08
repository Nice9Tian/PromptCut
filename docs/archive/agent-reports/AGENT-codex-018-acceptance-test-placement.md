# 018 acceptance test placement

## 开工记录

- 基线：`e67ca4cffec228fcb031e1e3c797f532631d728a`，分支 `codex/018-acceptance-test-placement`。
- 范围：把端口平移的两个断言从独立测试文件移入既有 `server/test/four-stage-acceptance.test.mjs`，并删除造成 bakery-deps 分层守门失败的独立测试文件。保留断言内容与真实 manifest 命令检查，不改端口实现、测试白名单或产品代码。
- 验证：仅运行获准的定向 npm 测试；不运行完整测试、不启动服务。

## 实施与验证

- 将两个端口平移测试原样放入 `server/test/four-stage-acceptance.test.mjs`。它们仍直接核对真实 manifest 中 `P-multi-agent` 与 `P-skill-mcp` 命令、自留端口范围、一般 5xxx 参数、8xxx 与非端口参数。删除独立的 `server/test/acceptance-port-scope.test.mjs`，因此 bakery-deps 分层守门无需放宽。
- 根组合在本修复前的 full 首轮是 5173 通过、5170 通过、1 失败、2 跳过；唯一失败为新增测试文件导入 scripts 模块，触发 bakery-deps 守门。原日志：`%TEMP%\pc-root-cloud-policy-e67ca4cf-full.log`。本叶没有重跑 full。
- 首次启动定向测试时直接以 `Start-Process` 执行 `npm` 的 `.cmd` 入口，Windows 报 `%1 is not a valid Win32 application`，未进入测试。日志保存在 `%TEMP%\pc-acceptance-test-placement-target.err.log`。改用隐藏 `cmd.exe` 执行同一 npm 命令后通过；原始输出与错误日志分别保存在 `%TEMP%\pc-acceptance-test-placement-target-retry.out.log`、`%TEMP%\pc-acceptance-test-placement-target-retry.err.log`。
- 定向命令：`npm test -- server/test/bakery-deps.test.mjs server/test/four-stage-acceptance.test.mjs`；32 项，32 通过、0 失败、0 跳过，测试报告耗时 16528.2185 ms，外层耗时 16909.23 ms。`git diff --check` 通过。
- 未运行完整测试、未启动服务；完整基线仍待根组合复验。
