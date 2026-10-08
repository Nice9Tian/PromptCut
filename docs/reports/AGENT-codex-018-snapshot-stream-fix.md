# Snapshot stream read binding fix

## 开工记录

- 工作区分支：`codex/018-snapshot-stream-fix`。
- 固定起点：`e2c02586f939f10392253b74f0e4146aaacbdab8`。
- 独占范围：`server/frame-stream.mjs` 的必要本地 import、`server/test/frame-stream.test.mjs` 的真实 `StreamProducer.handle` 回归，以及本报告。
- 目标：复现 `StreamProducer.handle` 中调用未绑定的 `handleStreamRequest` 造成的 snapshot 流请求失败，增加本地 import，并用实际 `StreamProducer.handle` 覆盖正常处理与未处理路径。保留 route、安全、等待和探针行为。
- 初始证据：GR-6 snapshot 请求 HTTP 500，报错 `handleStreamRequest is not defined`。root 的两轮失败日志与 JSON 证据保留在系统临时目录；本叶先运行真实类定向回归保存修复前反例，再做最小修复。
- 验证范围：允许的定向测试与 TypeScript 检查；不运行服务、ready probe 或完整测试。

## 实施与验证

- 修复前新增的真实 `StreamProducer.handle` 回归以 `StreamProducer` 自己构造的 `StreamStore` 写入临时 manifest、init 与 segment，然后实际调用 `handle`。请求覆盖 manifest、init、分段、HEAD，以及不匹配路径和 POST 未处理分支。修复前运行 22 项，21 过、1 失败、0 跳过；失败明确为 `ReferenceError: handleStreamRequest is not defined`，栈在 `StreamProducer.handle` 的真实调用处。原输出：`%TEMP%\pc-snapshot-stream-fix-before.out.log`，退出 1，外层耗时 403.57 ms。
- 最小源码修复仅给 `server/frame-stream.mjs` 的既有本地 `asset-store/stream-store.mjs` import 增加 `handleStreamRequest` 绑定。既有再导出、路由顺序、授权、安全和等待代码均未改。
- 添加 import 后首次重跑因测试 fixture 的 init ID 不符合既有 16 位小写 hex 路由格式而失败：21 过、1 失败，断言看到该请求未处理、状态码未定义。原输出：`%TEMP%\pc-snapshot-stream-fix-after.out.log`，退出 1，外层 398.83 ms。fixture 改为真实格式后最终定向通过 22/22、0 失败、0 跳过；测试耗时 117.3873 ms，外层耗时 467.73 ms。输出：`%TEMP%\pc-snapshot-stream-fix-after-retry.out.log` 与 `%TEMP%\pc-snapshot-stream-fix-after-retry.err.log`。
- 新回归确认 manifest 为 `no-store`、内容寻址 init/segment 的 GET 与 HEAD 为 immutable 行为、字节内容正确，非流路径和 POST 仍返回未处理；原有直接 `handleStreamRequest` 测试继续覆盖 manifest、安全边界和 immutable 读取。
- TypeScript 检查使用共享父工作区的 `C:\Users\admin\Documents\PromptCut\node_modules\.bin\tsc.cmd -b --force`，退出 0，耗时 6763.79 ms。原始输出/错误文件：`%TEMP%\pc-snapshot-stream-fix-tsc.out.log`、`%TEMP%\pc-snapshot-stream-fix-tsc.err.log`。`node --check` 和 `git diff --check` 也通过。
- root 的 GR-6 原探针两轮失败证据仍保留：80 长轮 61 秒退出 1；e2 诊断轮 56.875 秒退出 1，脱敏错误体为同一个未绑定标识符错误。证据位于 `%TEMP%\pc-root-probe-diagnostics-20261008-ready.log` 与 `%TEMP%\pc-root-probe-diagnostics-20261008-ready\ready-index-diagnostic.json`。本叶没有启动服务、运行 ready probe 或完整测试；应由 root 在固定提交上进行组合验证。
