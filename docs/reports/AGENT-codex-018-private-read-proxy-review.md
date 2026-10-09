# 私有读取代理关闭诊断

- 任务：只读复核私有切换后的浏览器 SSE 闭口，仅写本报告；未改产品或 Luna 的夹具。
- 审查基准：本工作区 `1eafffa98f9b38b6a98bda6c6dfd29382fc1db1b`；夹具读取冻结 `8759557e`；原浏览器首败 `fb89029ba90f8e274cc718f6ab672fec6bfaf764`。未引入新 terminal provider。

## 已定位机制与最小修补位置

`server/test/fixtures/account-conversation-controls-user-path.mjs` 的 edge HTTP 代理（冻结源约 239–244 行）只有 `response.pipe(res)` 和 ClientRequest 的 `upstream.on('error')`。后者不代替 IncomingMessage 在响应已开始后的 `aborted/error/close`。上游 Agent 主动销毁 SSE 时，异常响应未结束下游；也缺下游取消向上游的收口。

`server/agent/service/conversation-transports.mjs` 已同步 revoke 并销毁其 owned `res/req.socket`，等待 Agent-facing response/socket 实际 close 和 pending dispatch 完成。该库存不包含 edge→Chrome 这一段。`conversation-control-client.mjs`、`agent-read-control.mjs` 与 `doc-agent-assembly.mjs` 的签名关闭及同事务 fence 路径静态核对未发现需要放宽 ACL 的依据。`src/ai/cloud/session.ts` 在账号 EOF/error 后清缓存；代理保持流 open 时，这个真实退出条件尚未发生。

Luna 的最小补丁应在该代理处：上游响应 `aborted/error` 或 `close && !response.complete` 时销毁下游；下游取消时销毁对应 upstream request/response；正常 complete 保留 pipe/end。关闭监听须从响应建立时登记、可重复且仅作用本请求，不能用 DOM 清空或 read-control 自由 ACK 替代。root 已将此夹具修改交原 owner。

## 实际短 HTTP 反例

root 授权的一次随机回环诊断使用真实 Node HTTP 上游、代理和客户端，无账号、密码、TLS、Chrome、模型或业务服务。200 SSE 首块到达后，上游 ServerResponse 实际 `destroy()`，观察 200ms。临时文件均保留：

- `%TEMP%/pc-private-proxy-review-counter.mjs` / `.log`：首次 exit 0。首次输出中的 downstream 对象被 finally 清理晚到的 close 改写，不能把该最终字段误读为观察期已关闭；断言是在清理前执行。
- `%TEMP%/pc-private-proxy-review-counter-2.mjs` / `.log`：只补观察期快照，exit 0，工具墙时约 0.535s。原代理 ports 11590/11591：上游 `aborted=true, errorCode=ECONNRESET, closed=true, complete=false`；清理前 `observedDownstream={}`、edge `destroyed=false/writableEnded=false`。候选双向收口 ports 4968/4969：相同上游异常，下游观察期已有 aborted/ECONNRESET/close，edge destroyed=true。

诊断上游另装观察用 error listener，避免未处理异常干扰取证；原版本不转发该关闭。两次 finally 都仅销毁 owned sockets，并等待全部 server/socket close；各输出 sockets=0、serversClosed=true。首次 ports 3656/3657/3661/3662 和第二次四口最终实际查询均无监听。未重复反例或运行浏览器。

## 证据界限与后续门槛

原 `%TEMP%/pc-conversation-read-close-fb89029b-once/result.json` 38324ms 仍是失败：私有 POST200、服务器 list200 且确实不列 private，但 member 原200 SSE open、正文未清；后半历史 UI 未通过。反例证明同一代理机制可丢失异常收口，尚不能代替修后真实浏览器验证。

`server/hosted/deploy/nginx-location-agent.conf` 的真实 nginx 非本夹具；本任务未运行 nginx，不能把预期异常 upstream 结束对应下游请求的机制写成生产通过。root/Luna 后续应以原私有确认→旧 member SSE 实际结束→正文及历史清除复验，并保正常共享 SSE 与正常 complete 路径。本报告只做差异检查；没有 full、业务探针、节点、凭据读取或产品变更。
