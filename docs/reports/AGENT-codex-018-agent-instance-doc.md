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

## 固定源码与已完成核验

- 4ecbd1a5：HTTP注册/签名消费与首次fixtures完整块；routes首轮npm 1/1，0失败/取消/跳过，1156.8545ms（测试1079.8428ms），实际OS端口4455关闭。日志TMP/pc-instance-doc-routes-target-1.log。业务run methods仍为受控fixture，证据只覆盖真实instanceAuthority/TLS/route能力。
- f85ecb9a：combo无Agent配置的instances入口也明确503；fixture等待客户端真实socket close；新增隔离部署import专测。routes/deploy第二轮npm 2/2，0失败/取消/跳过，1307.8812ms（routes1228.7045ms、stage112.585ms），实际OS端口12672关闭。日志TMP/pc-instance-doc-routes-deploy-target-2.log。重复routes有因：fixture实close生命周期变化；不是无变更重跑。
- 隔离部署使用stageHostedFiles原递归清单，117个文件，TMP目录真子进程import新doc-agent-assembly，退出码0且等到child close。files.mjs无需改；只证明模块闭包/真实import，不当作服务部署或OS隔离验收。
- b08bf5d3：中央既有direct raw provider调用的403预期与无Agent配置注册503负向；未配置run provider仍原503。源码冻结后强制tsc -b --force exit0，零错误，命令墙7.6168s，TMP/pc-instance-doc-type-1.log。等待端口期间继续实际代码审查，确认该direct调用传的是editor delegation，checkWithScope首先role拒绝run-principal-invalid，而非后续service校验run-service-forbidden；未跑中央目标前修正为真实较早的403，权限断言不降。这是预期定位修正，不写成运行失败或已通过。

中央account-assembly-central.test.mjs已写真实VH327 provider/order→combo→独立asset→两页面的签名注册/admit/read/query/check/finish与同证书另一OS旧grant拒绝、cap字段不泄漏；尚未运行。共享固定5770～5774未获释放前不启动，不能把旧中央/根full借作本新源码结果。此叶尚未full，原LAN与transport宽回归待新完整装配冻结后按root租约执行。

## WS/LP待授权接线精确方案

现有调用位置：service.mjs watchPending的ws.on(message)→session.receive；http-transport.mjs onSend逐frames→session.receive。session.receive三条业务分支未return router.dispatch，router内部dispatch才包住async gate与module.handle/coordinator。因此不能在gate返回后release，也不能在LP立即200后宣称调用已经完成。

更窄方案已补报root：service新增完整dispatchInvocation({connId,principal,text,transport},next)，真实WSS socket由升级时关联；session仅return既有dispatch Promise，LP逐帧await同hook，ALS上下文贯穿router排队then与业务await。普通页面/LAN保持直接next；Agent必须真正mTLS且exporter可取。另需同service在内部TLS server挂真实transport入口，否则现公共HTTP WS没有受信exporter就继续拒绝。

签名envelope拟exact{nonce,frame,proofs}，frame包含完整普通seq/ack/type/reqId/业务字段；nonce在本conn一次性且绑定seq。每份proof exact{operation,action（仅checkAccess）,instanceId,instanceGeneration,signature}，签名request={projectId,runGrantId,connId,nonce,frame,action（仅checkAccess）}，完整frame摘要与真实TLS exporter/method/path绑定。project/grant/实例/账号从已认证连接+doc ledger核，不从frame升级。project.op及现account-hosted写类映射checkAccess(write)；open/read与selection.set/clear映射checkAccess(read)；selection.query额外独立authorizeQuery，恢复projection时的checkAccess(read)另签，不能derive或把metadata/resolve当write。

所有cap只在当前完整dispatch ALS内，provider按精确operation/action/project/grant选当前cap，outer finally release。LP从同一真实POST req取得socket并一直await业务，禁止先结束旁路HTTP再沿旧cap处理WS。resume/connect须各自真实proof，不凭sid或一次ticket复用；exact协议/core窄lease尚待root确认。生产data ticket仍503，控制关闭仍pending，未知历史实例没有默认closed。
