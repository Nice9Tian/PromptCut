# 0.7.18 云端 Agent 全员选区实际工具接线

工作树 `codex/018-agent-live-selection`，起点 `34e6b7ba422f2d673ed333d3a8c1fa85a7c0a3b4`。本叶只改 accountMode 下 `get_selection` 从 Agent 的实际 doc data connection 查询 doc 权威全员选区；不改 LAN/local、doc 选区权威、run 授权、UI 或正式部署。

## 接口与目标

已拍板语义：返回项目内所有在线有效成员的每页选区和可信用户名，发起成员名后标「（当前用户）」；发起成员全部页面离线时只补该条持久消息的发送时快照，明示「非实时」。doc `selection.query` 已按 runGrant、项目和前后 fence 核验，本叶消费者不接收工具参数或页面自报身份/快照。doc 拒绝、超时或上下文不匹配时必须显式失败，不回退旧单人页面/快照结果。

验证与未完成项待固定源码后填写。真实实例注册、模型执行与生产部署由其它叶负责，不以本叶夹具冒称上线。
