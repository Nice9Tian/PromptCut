# Snapshot stream read binding fix

## 开工记录

- 工作区分支：`codex/018-snapshot-stream-fix`。
- 固定起点：`e2c02586f939f10392253b74f0e4146aaacbdab8`。
- 独占范围：`server/frame-stream.mjs` 的必要本地 import、`server/test/frame-stream.test.mjs` 的真实 `StreamProducer.handle` 回归，以及本报告。
- 目标：复现 `StreamProducer.handle` 中调用未绑定的 `handleStreamRequest` 造成的 snapshot 流请求失败，增加本地 import，并用实际 `StreamProducer.handle` 覆盖正常处理与未处理路径。保留 route、安全、等待和探针行为。
- 初始证据：GR-6 snapshot 请求 HTTP 500，报错 `handleStreamRequest is not defined`。root 的两轮失败日志与 JSON 证据保留在系统临时目录；本叶先运行真实类定向回归保存修复前反例，再做最小修复。
- 验证范围：允许的定向测试与 TypeScript 检查；不运行服务、ready probe 或完整测试。
