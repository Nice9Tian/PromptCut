# 实例 WS/LP 数据通道独立审查

- 工作区/分支：`018-instance-data-review` / `codex/018-instance-data-review`。
- 起点：`2f6dfd1953a5d723a9483704de9fae24f3abc145`。
- 独占仅本报告；其它源码只读，特别是已验证实例权威及中央、worker 消费者均不改。
- 审查范围：真实 mTLS exporter、握手与逐帧能力范围、same-instance recovery、nonce/seq/ack、ALS 队列生命周期、缓存帧回放、失权屏障与真实关闭证据。
- 已读 AGENTS 入口及开发索引、约束、行为规则；适用已定可信 read/run、恢复与停止语义，不另造产品行为。

当前阶段只读审查，尚无新测试结论。共享 full/固定服务/宽探针无租约，不启动；必要纯反例仅写系统 TMP。报告将区分必须修复、待实证与可后验证，记录实际读取的源码点，未固定的在途代码不作冻结通过结论。
