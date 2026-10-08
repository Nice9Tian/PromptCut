# 0.7.18 项目全员选区独立接线

工作区 `codex/018-project-selections`，起点 `74a6b67c7f11d8ba82c5c9a274de2cfb6dba8617`。此报告只记录独占叶的接口、实现和证据；中央文档服务与云端 Agent 尚未接入前，不把独立模块算作生产完成。

## 对齐与租约

- 已读 `AGENTS.md`、开发指南索引、建议行为、约束。遵守现有产品语义：`get_selection` 汇集项目内全部在线有效成员的每个页面，名字可信来自连接身份；发起账号加“（当前用户）”，发起人离线才使用消息发送时留存的、已验证快照并标非实时。
- 租约限新 `server/docservice/modules/selection.mjs`、`src/editor/sync/selectionPresence.ts`、`src/editor/sync/presence.ts`、`server/tools/project.mjs` 的 get_selection 描述/schema、`src/mcp/handlers/project.ts` 的 getSelection 多选详情、本报告及专属测试/probe。中央挂载、Agent 消息存储、页面反向工具和节点部署由其它 owner 负责。

## 接口与实现

待记录。

## 验证与剩余缺口

待记录。
