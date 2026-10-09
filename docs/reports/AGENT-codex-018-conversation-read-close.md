# 018 对话读取关闭验证助手报告

## 开工范围（2026-10-09）

- 基线：`codex/018-conversation-read-close`，提交 `71fca9d2`；工作区初始干净。
- 本阶段只改 `server/test/fixtures/account-conversation-controls-user-path.mjs`、`scripts/probes/account-conversation-controls-probe.mjs` 和本报告。目标是让隔离账号 fixture 使用同一真实 Agent 服务进程的运行客户端与读取控制客户端，验证共享对话被切私有后的实际读取关闭；浏览器探针按新服务语义检查服务端确认，并增加第三个普通成员的真实共享读取与关闭路径。
- 不伪造权限、事件、ACK 或 pending，不更改产品服务源码。若无真实资源可维持未决读取反例，将如实记录未验证项。
- 计划验证：先跑目标 TypeScript 检查和账号对话控制专属测试；随后只对本阶段 fixture/probe 执行定向用例与 `node --check`、`git diff --check`。在线 dist 只输出到系统临时目录。禁止 full、节点、真实模型和 main 操作。
