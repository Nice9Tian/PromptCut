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

## 真实中央 HTTP 首次目标与新增 core 完整块

root将最终Astra实例inventory/报告6e3cad46 no-ff组合为6c3ca23a，已在f85之前进入本叶祖先；没有自行merge/cherry-pick。最终实例零grant关闭清单照样pending，不把没有operationFences等同旧OS空。

固定f45c912b首次中央npm target：3 tests / 3 pass / 0 fail/cancel/skip，duration5737.7801ms、wall6023.8063ms，exit0，前后同SHA。日志TMP/pc-instance-doc-central-target-1.log及-exit.json；独立asset子进程日志pc-doc-assembly-child-1791429762928.log、pc-doc-assembly-child-1791429764910.log，均等到child真实close。5770～5774前后零LISTEN，跑完已向root释放。验证包含真实provider/order、独立asset、两个页面、真实实例注册与grant/read/checkwrite/finish；同cert另OS旧grant拒；原readonly/选区伪名/op actor/重启/旧resume与required缺配置断言保留。此轮没有WS/LP逐帧证明，不冒称那条链已通过。

root随后批准service/session/http-transport窄lease，以及仅可信Agent welcome公开connId、LP openReply透传可选字段。当前core新块待测试，未借上述HTTP绿或任何根full：

- session仅三处router.dispatch Promise透传及Agent connId；原seq/ack/重复过滤不改。
- service在现有admission注册内调用transportAuthenticate；额外内部HTTPS server真正socket标记与挂载/移除；普通页面/LAN走原fallback。带实例proof/公开run引用而非真正internal mTLS时拒绝，不掉回旧认证。WS保留实际升级req/socket；Agent invocation FIFO串行，进入与await后receive前均核当前t；同conn新旧transport不以身份相同替代。
- LP只对Agent逐frame await（普通page仍原即时ACK）；签实际原bodyText/protocol/query。recv在清旧waiter、改ack前核read proof，能力保留到response finish/close；timer/wake真正pull前再次同cap核live grant/socket与current transport，绝不先release后读缓存。req/res/socket actualclose仍由原fence ownership tracking收据核验，finish不等actual资源关闭。
- factory以ALS只在完整dispatch内替换当前scope对应servicePrincipal，原principal白名单不改；selection.query同时核独立authorizeQuery与read cap，read/resolve不能write。初次resolve结束即删除cap，cached principal只留可信actor/grant/实例和base socket主体；resume签cached同实例/grant+actual sid/ack item，验证后才回放。
- 签名公共builders位于agent-instance-internal.mjs：instanceConnectionRequest、instanceDataRequest、instanceProtocolHeaders。协议头保存原actual {websocket,http,fallback}（LP合成sec-websocket头前保留原头），完整URL/原bodyText入签；header独立proof避免body自签循环。nonce正safeInteger，perconn一次，Set允许LP在途请求网络乱序；初握手nonce先按actual socket消费，再通过同步transportConnected仅关联server分配connId，不改actor/权限；新socket重签不能继承旧cap。HTTPticket仍503。
- deliver先同步启动service.fencePrincipals读/入场/socket屏障，再await操作fence与实际close；conversation onFence先从已提交ledger控制发起barrier，再异步synchronize。所有closure记录仍complete:false，缺Agent/OS证据不ACK。

只读Astra复核反例来自旧固定f45：session return缺口、异步seq乱序、被替换transport与LP waiter过早release；不是已上线故障。当前按确切接缝修正，不改router或常规close/tail契约。新增account-instance-dispatch-core.test.mjs为明确组件fixture：真实WS/HTTP/TLS/actualclose与ALS生命周期，不以它代替生产密码、grant或签名链；真正全中央数据负向/正向仍待后续目标。静态node --check、实际mjs import与diff --check通过。只读一次猜测旧test路径不存在，已rg找到真实docservice-http-transport.test.mjs，未执行不存在测试/未改其它文件；记录命令错误，非产品失败。

## cc546组件首测与7aac复审修正

固定cc5465a8组件首测2/2、0失败/取消/跳过，2135.1394ms，TMP/pc-instance-doc-core-target-1.log；WS OS端口4148、TLS LP5820均实际关闭。仅传输fixture认证/能力，不是生产密码或实例签名链。Astra固定Git真实session/http/router受控反例指出超body/超frame未验proof直接close、empty batch直接ACK，以及旧recv/close授权await后被resume替换仍副作用。原counter.log保留于TMP/pc-instance-data-review-cc5465-013c5e31640a4187b58731c991591dd8，exit0、零listener；没有删除或写成测试通过。此前f45三个反例也原保留。

7aac35a4最小修正：Agent超限只回413、不凭SID结束会话；empty batch400且不取ACK；recv/close的next入口在ACK/clearWaiter/end前核fenced/dead/superseded/isCurrent，send末ACK也核，fresh read后再次核旧传输。普通LAN/page超限close与普通尾帧契约保持。另真实internal transport、实例proof头或runGrant尝试即使cached主体为page也进入factory明确拒，不能因cached role回落legacy；普通public页面原路径不变。已升级的WS拒绝用真正WS close4003，不能在upgrade后再写HTTP错误。

固定7aac35a457cb03734fdb58f71f859bcf6b4cc936，组件加原HT1/session ACK/LP回归首测37/37、0失败/取消/跳过，5534.3693ms，exit0；TMP/pc-instance-doc-core-related-1.log。新真实HTTPS组件把未验proof超body/frame/empty与合法请求并列；旧recv/close持gate后真实resume再放行409，缓存仍1帧、新会话活；internal LP与带runGrant的普通page SID尝试拒，普通页面welcome无connId与合法public resume仍通过。测试私有能力fixture不能作为生产crypto证据。new owned端口逐项actualclose记录：WS6338、LP2922、LP boundary2538、普通WS6541/TLS6542；OS listen(0)由系统原子分配，不占已监听固定口。强制tsc -b --force零错误、exit0、wall6.8881s，TMP/pc-instance-doc-type-2.log。未运行577x/full或宽浏览器探针，前后源码不变且Git干净。

生产factory+instanceAuthority的真实mTLS WS/LP签名目标仍待独立运行，不能借root全量或上面的组件绿声明生产数据连接完成。公共helper真实export/schema已同步Agent owner：instanceConnectionRequest/instanceDataRequest/instanceProtocolHeaders与INSTANCE_DATA_PROOF_HEADER，所有actual URL、原协议头tuple、原bodyText、connId、seq/ack、nonce、operation/action绑定；空batch请用签名recv取得ACK，不新增旁路。

## LP请求认证前会话副作用：反例与修正

root静态疑问经固定7aac HTTP实现实证：新真实HTTPS组件发送仅SID的未完成body，合法send实际409而非200。TMP测试进程registerHooks只将http-transport精确解析为git show 7aac的TMP版本，session/service保持真实模块；原body仅替换import路径以可达同源session，不改变函数体。node目标exit1，1失败/0取消，1404.2367ms，TMP/pc-instance-doc-preauth-7aac-counter.log，未知请求和owned server/socket在after实际关闭。此为旧源反例，不当作新源码失败或通过。首次两次apply_patch因重复上下文定位失败，没有部分修改；随后按完整onSend函数准确替换，原工具错误保留，不伪记运行结果。

固定product074bbe27：Agent读取未完成body时只持本请求，完整首proof/current-run检查通过才track、lastSeen、sending；首invocation cap保持整个batch，之后每frame再独立proof/current检查，finally释放所有cap。未授权recv/close也不进入会话resource ownership，验权及current检查后才track。普通LAN/page原busy/超限/ACK路径保留，原语义断言未删。新增真实partial body证明合法发送不再busy，拨测试进程时钟后的真实heartbeat idle sweep仍脱开该会话（未验请求不能用sending阻止空闲），不修改主机时间或全局环境。

074固定相关npm 38/38、0失败/取消/跳过，5537.8528ms、exit0，TMP/pc-instance-doc-core-related-2.log。五个新组件owned OS端口4619、1310、8882、3793/3794、9414都actualclose，原HTTP/session回归用其原listen(0)形态。此重复相关有因：认证前会话副作用代码及新反例改变，不盲跑旧源码。

真实data测试块1c9db1e4与71ed0905（后一份仅补同cert新OS旧SID负向）尚未运行，product仍074。新增fixtures agent-instance-data.mjs / agent-instance-data-target.mjs只Node内置TLS/HTTPS/掩码WS编解码/内存Ed25519，从客户端socket独立计算exporter；不拿服务器cap或callback做授权。中央既有原title/readonly/history/restart断言保留；新增真正Agent写入agentVerified字段，单独核accepted actor/grant并把该配置分支预期rev由2改3、history由1改2。selection.query双独立proof、FIFO、same-instance新TLSresume、跨TLS/nonce重复、body/query/protocol/seq/ack/action变更、pageSID与newOS旧SID负向均已写定；private中止另一个成员实际run时，pending LP/WS实close与partial receipt核验，仍不得ACK Agent/OS完整关闭。

固定1c9强制types --force exit0、零错误、wall6.7377s，TMP/pc-instance-doc-type-3.log；71ed只改测试断言不当作已通过data目标。当前真实中央5端口仍等待5770～5774租约，不为纯listen0要求改未租asset内部entry或重映射旧中央，未跑full。
