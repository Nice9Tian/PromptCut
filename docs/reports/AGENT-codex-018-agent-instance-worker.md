# Agent 实例 worker 接线记录

工作树 `codex/018-agent-instance-worker`，起点 `6c3ca23a306eca526c5888d096c0f2645cd00830`。本叶只实现 Agent 侧 RAM Ed25519 实例注册与真实 TLS exporter 绑定的 HTTP 请求证明，并在获准的实例消费入口接线。WS/LP 的逐帧证明要等 doc 核心窄协议和租约；未完成时仍拒绝，不把旧 read capability 当写权限。

开工先核 AGENTS 索引、开发规则、产品/机制 Agent 与云端文档、实例权威及中央 HTTP 接口。源改、失败切点、类型/目标/全量与未挂载边界在固定提交后补记。
