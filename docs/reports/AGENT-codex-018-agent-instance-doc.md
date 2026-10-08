# Agent 实例中央消费者：开工记录

工作区018-agent-instance-doc，分支codex/018-agent-instance-doc，固定起点f24017ade64785f9eddf59fe3caf0cb87308be2d（根集成8a6b88cf与Astra固定c0e64ff5组合）。旧018-cloud-doc-assembly/e731冻结，不写旧叶。

已读AGENTS入口、开发索引、suggested_agent_behavior、constraints、新agent-instance-authority/run-authority与Astra报告「已实施接口」「状态与恢复矩阵」。现有中央createRunAuthority缺必填instanceAuthority属于已知装配缺口，先补真实cap链，不赌full或自由stub。

独占server/hosted/doc-agent-assembly.mjs、server/account/run-internal.mjs、新server/account/agent-instance-internal.mjs及专属测试/报告；combo仅必要TLS请求边界。account-hosted run ticket/WS/LP每消息范围另向root提精确扩租，未授前不改。authority/instanceAuthority/registry/read-intent/Agent worker/operation底层/service.mjs不改。所有注册、调用cap仅doc RAM，finally release，内部能力不得响应/日志/持久化；持久登记与grant绑定实例及代际。同证书新OS不接旧grant，不将新实例空资源视作旧实例关闭。

三级机制按已定TLS exporter逐请求签名：真实peer authorized socket＋固定Agent leaf pin＋registry force current→socket RAM认证身份与instanceTlsBinding；签method/path/operation/完整body digest。注册challenge/public key/签名只作为持有证明，不凭body instanceId/gen或proxy headers授权。pending仅metadata，不授read/write。resolve/read签名不能升级write；长期WS/LP必须约精确每消息证明，不消费一次resolve cap作永久会话。

开工时尚未实现/测试。共享固定端口与full由Astra/root持有，不启5730/5760/5770/5790/5820/5860/5920服务；新纯目标只listen(0)，原5770目标待释放。目标/类型/full固定源后执行，首红全部保留；只自有TMP/child真实close，隐藏整进程树，不装依赖/改环境/节点/main/push。实际账号provider用固定VH327，生产密文/值不读。缺完整OS/Agent资源关闭证据继续pending。

## HTTP 实例消费完整块（待定向实测）

新增server/account/agent-instance-internal.mjs：真实Agent mTLS peer pin下POST /internal/v2/instances/challenge（requestId/publicKey）与/register（challenge/signature），共享doc SQLite的持久challenge/登记，不对外回RAM capability。新X-PromptCut-Instance-Proof承载仅实例引用和Ed25519签名；socket exporter、服务当前registry与socket RAM唯一authenticationId从真实req.socket取得。拒Forwarded/x-forwarded-*/x-real-ip，不信代理头。

server/hosted/doc-agent-assembly.mjs构造createAgentInstanceAuthority并挂createRunAuthority。所有runs非pending调用用实际method/path/operation/完整body摘要核签，在完整await期间允许同scope重核；最外层finally release。check从同ledger grant重建actor与不可变实例绑定，不能用resolve读cap升级write；公开check principal采用字段白名单，不传servicePrincipal/instanceSession/authenticationId。pending只返回queued项目/会话/revision，并先真实authority synchronize与当前服务登记核验。

run ticket仍503 run-data-proof-unavailable：一次HTTP resolve证明不能被缓存成WS/LP后续写权限；Agent/OS实际资源关闭callback未装配，control一直pending，partial记录agentState改resource-closure-required。普通LAN/local与页面连接流程不改。

既有两份已获最窄扩租tests保留原权限/路线/完整body/容量/关闭断言，增加真实TLS客户端fixture（内存Ed25519 key、secureConnect后独立取exporter签名）。旧run-internal单测使用真实SQLite instanceAuthority验证路由cap边界，其run业务methods仍为受控fixture，不能冒称生产grant执行；central的实际provider/order+独立asset+两页面才测真实grant admit/read/query/check/finish与同cert新OS拒旧grant，WS ticket仍拒绝。所有HTTP结果禁止内部cap字段。

语法核验六个新/改mjs与git diff --check均exit0。首次只读检索在PowerShell使用了不支持的brace路径展开，ParserError后改显式三路径，未启动服务/写产品；原命令错误保留于工具记录。render supplement全文与solution_table已重读，不扩大未批提前让位/删除细节/补渲故障语义。

WS/LP方案已报root：必须完整router dispatch hook包住gate、module与coordinator，session.receive透传Promise，LP在实际mTLS请求内await；WSS取真实TLS socket逐完整frame签名，nonce绑定connId/seq且一次性；selection.query的authorizeQuery与recovery read分别签，绝不旁路HTTP关闭后复用cap。尚未授权/实施core新hook，因此此块不声称数据连接已可运行。
