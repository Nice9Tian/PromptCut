# Agent 实例中央消费者：开工记录

工作区018-agent-instance-doc，分支codex/018-agent-instance-doc，固定起点f24017ade64785f9eddf59fe3caf0cb87308be2d（根集成8a6b88cf与Astra固定c0e64ff5组合）。旧018-cloud-doc-assembly/e731冻结，不写旧叶。

已读AGENTS入口、开发索引、suggested_agent_behavior、constraints、新agent-instance-authority/run-authority与Astra报告「已实施接口」「状态与恢复矩阵」。现有中央createRunAuthority缺必填instanceAuthority属于已知装配缺口，先补真实cap链，不赌full或自由stub。

独占server/hosted/doc-agent-assembly.mjs、server/account/run-internal.mjs、新server/account/agent-instance-internal.mjs及专属测试/报告；combo仅必要TLS请求边界。account-hosted run ticket/WS/LP每消息范围另向root提精确扩租，未授前不改。authority/instanceAuthority/registry/read-intent/Agent worker/operation底层/service.mjs不改。所有注册、调用cap仅doc RAM，finally release，内部能力不得响应/日志/持久化；持久登记与grant绑定实例及代际。同证书新OS不接旧grant，不将新实例空资源视作旧实例关闭。

三级机制按已定TLS exporter逐请求签名：真实peer authorized socket＋固定Agent leaf pin＋registry force current→socket RAM认证身份与instanceTlsBinding；签method/path/operation/完整body digest。注册challenge/public key/签名只作为持有证明，不凭body instanceId/gen或proxy headers授权。pending仅metadata，不授read/write。resolve/read签名不能升级write；长期WS/LP必须约精确每消息证明，不消费一次resolve cap作永久会话。

当前尚未实现/测试。共享固定端口与full由Astra持有，不启5730/5760/5770/5790/5820/5860/5920服务；新纯目标只listen(0)，原5770目标待释放。目标/类型/full固定源后执行，首红全部保留；只自有TMP/child真实close，隐藏整进程树，不装依赖/改环境/节点/main/push。实际账号provider用固定VH327，生产密文/值不读。缺完整OS/Agent资源关闭证据继续pending。
