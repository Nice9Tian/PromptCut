# AGENT 报告：HT-a 客户端（`claude/ht-client`）

HT-a 是「文档服务的会话模型 + 序号确认 + WebSocket 传输接会话层 + 本机信任开关」这一阶段（契约 `docs/plan/http-transport-contract.md` 文件头「2026-09-27 拆分」）。本分支只做其中的客户端：`server/render-node/session-link.mjs` 的 `createDocEndpoint` 及其接入。服务端会话层、信任开关、部署脚本归 `claude/http-transport`。

分支从 `claude/c10a-integ` 的 `aa9a85b` 建出。

状态：开工。
