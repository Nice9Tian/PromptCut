# 0.7.18 项目全员选区独立接线

工作区 `codex/018-project-selections`，起点 `74a6b67c7f11d8ba82c5c9a274de2cfb6dba8617`。此报告只记录独占叶的接口、实现和证据；中央文档服务与云端 Agent 尚未接入前，不把独立模块算作生产完成。

## 对齐与租约

- 已读 `AGENTS.md`、开发指南索引、建议行为、约束。遵守现有产品语义：`get_selection` 汇集项目内全部在线有效成员的每个页面，名字可信来自连接身份；发起账号加“（当前用户）”，发起人离线才使用消息发送时留存的、已验证快照并标非实时。
- 租约限新 `server/docservice/modules/selection.mjs`、`src/editor/sync/selectionPresence.ts`、`src/editor/sync/presence.ts`、`server/tools/project.mjs` 的 get_selection 描述/schema、`src/mcp/handlers/project.ts` 的 getSelection 多选详情、本报告及专属测试/probe。中央挂载、Agent 消息存储、页面反向工具和节点部署由其它 owner 负责。

## 接口与实现

- `mountSelection({ project: {bodyOf,revOf}, checkAccess, authorizeQuery, now? })`（同名别名 `createSelectionModule`）返回标准 doc 模块 `{name:'selection',types:['selection.'],connect,disconnect,handle,dropSpace}`，另有内部 `querySelections({principal,projectId,runGrantId})` 和 `revoke({projectId,accountId?,loginId?})`。**两个鉴权回调缺一即构造失败**。`checkAccess` 必须实时追账号/项目授权 head，不能凭旧连接缓存；返回 false/403 时清掉该在线记录，上游不可用时报 503 并整次拒绝。`authorizeQuery` 必须核 Agent 服务身份、项目作用域内当前或留存的 runGrant、真实发起账号及已持久消息的 selectionSnapshot。普通页面、没有真实 grant 的服务连接不得 query。
- 页面发送 `selection.set {projectId,pageId,revision,selection:{clipIds,range?},reqId}` 或 `selection.clear {projectId,pageId,reqId}`。服务端只从已认证连接取 accountId/accountName/loginId；消息自报用户名、账号都不能覆盖。查询 `selection.query {projectId,runGrantId,reqId}` 返回 `selection.state {projectId,projectRev,presenceRevision,members,queriedAt}`。每位成员按账号归组，每个在线页面单列；发起账号 displayName 加“（当前用户）”。每个 clip ID 按当前项目内容解引用，已删 ID 返回 `{id,missing:true}`。发起人全部页面离线时，只用 `authorizeQuery` 从已验证持久消息取回的快照，标 `live:false` 与“发消息时的选区，非实时”。其他离线成员不列。
- 同连接的 revoke 设置本地阻断，防止鉴权中途撤销后旧异步 set 重新插入；disconnect/dropSpace 同步清理。query 在每条异步授权返回后再次确认记录仍在，再形成响应。这里提供的是模块与回调接缝，不能代替中央 authority/gate 对授权事件的实际接入。
- `setSelectionLink(link,projectId,selectionSource?)` 发布页面空选区与后续多选，带稳定页面 ID 和递增 revision。`setPresenceLink(link,projectId,me,accountSelections=false)` 增加显式账号模式开关；现有 LAN/local 调用不打开它，也不发送新的选区消息。云端 glue 需在真实账号连接上显式传 `true`。本机 `getSelection` 返回全部选中 ID 与逐项详情，缺失 ID 明示，不再只拿第一个；工具输入 schema 保持 `{}`，`side:'page'` 的生产路由仍待 tools-glue 改接 doc 查询。

## 验证与剩余缺口

- 独立端口检查：运行前与关闭后 `5920–5929` 无监听。服务探针在 `5920` 起真实文档服务 WebSocket（测试专用鉴权回调，非真实账号 authority/mTLS），验证两个账号、同账号两页、空在线成员、可信用户名、冒名、跨项目、缺 grant、clear、断线、显式 revoke、无显式 revoke 的失权重查、上游不可用 503、被撤连接不能重插、离线发起人持久快照；连接与服务在 `t.after` 关闭。页面发布器经 Vite SSR 和真实 store 路径验证，LAN presence 既有测试未变；本机详情经 Vite SSR 验证多选和 missing。
- 首次类型检查命令 `./node_modules/.bin/tsc.cmd` 因本叶无本地 node_modules 以 exit 1 失败，改用仓库根 `../../node_modules/.bin/tsc.cmd` 后 exit 0，最终类型检查 exit 0。首次页面发布器定向测试因 Node 直接导入 TS store 的无扩展名路径以 exit 1 失败；改为可注入 selectionSource 并用 Vite SSR 验证真实 store。下一次定向因 presence.ts 对新 TS 模块无扩展名导入以 exit 1 失败；改 `.ts` 后定向 7/7、扩充至最终 9/9。
- 首次全量 `npm test` exit 1：5033 tests，5026 pass、4 fail、0 cancelled；本叶 WS 用例失败源于我在检查断连竞态时对复制记录做对象身份比较，误滤 Bob/Carol，已修正为保留原记录引用。另 `cloud-agent-runs` 的 CA-RENDER-01/02 攒批断言在该次并行全量失败；该文件随后单独 29/29 通过。完整首次日志保留在 `%TEMP%/pc-018-project-selections-full-first.log`，没有抹去失败或降低断言。
- 修正后的最终 `tsc -b --pretty false` exit 0；定向 `npm test -- server/test/project-selections.test.mjs src/editor/sync/selectionPresence.test.mjs src/editor/sync/presence.test.mjs src/mcp/handlers/project-selection.test.mjs` 为 9/9；必要的第二次全量 `npm test` 为 **5033 tests、5030 pass、0 fail、0 cancelled、3 skip，exit 0**，日志 `%TEMP%/pc-018-project-selections-full-final.log`。没有原生崩溃自动重跑。
- 中央 doc/Agent 的 selection 模块挂载、真实账号 authority/head 回调、runGrant 与消息快照持久关联、`get_selection` 云端工具路由和页面账号模式启用均由别的 owner 接入。本叶的模拟鉴权 WebSocket 探针不能宣称这些生产路径已通；发布版仍须真实端到端验证。没有修改节点、main、部署或未决删除/调度语义。
