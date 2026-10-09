# 单任务worker的Doc分配与真实关闭接线

开工基线：cc7303611f5de9b79f5680b89c733fc42aad44b0，分支codex/018-agent-worker-doc。旧c705/2d分支只读，不整包合入。根已实测scope首包Linux10/10；本包仍需真实Doc签发、实际worker消费者和root关闭链配对，不能套用该结果为业务完成。

范围按根精确租约：Doc run/instance authority及internal、必要doc-agent assembly、新agent-run-scope-doc；scope schema/reader/publisher的typed forced/unassigned增量及专属测试/既有scope增量。Sol独占session/run-client/runner/executor/events/main；不改UI/Asset publisher。若runtime原语确需扩展先列精确缺口交根。

首阶段：显式证明Doc规范PEM与scope规范DER来自同一Ed25519公钥，保留两种原摘要域；root ready记录与实际worker注册绑定，assigned-unbound只能取得Doc assignment，不得read/execute，真实root bound之后才放行。controller身份RPC的TLS证书与worker→Doc出站证书是两个角色，不能混用。

第二阶段：normal before-death prepare签名→Doc实际read/data关闭→Doc terminal→原RAM intent→root原FD实空→Doc可信reader导入与FIFO finalizer。forced和unassigned独立类型，不补死worker签名、不把未知资源算空。保留retained政策、并行conversation和完整原grant/currentRun绑定。

所有首次失败保存TMP。仅授权专属目标/类型及6712–6721自有mTLS窗口；不开full/浏览器/模型/节点。生产尚未挂载，报告逐项区分纯schema/SQLite/受控TLS/实际root Linux证据。

## 第一块：公钥映射与assignment执行门

服务端`agentScopeKeyMapping`从实际Ed25519公钥规范导出PEM/DER，Doc原publicKeyDigest仍digestOf(PEM)，另scopePublicKeyDigest=digestOf(DER base64)，仅同公钥字节相等才关联。challenge可选rootScopeRef exact4；启用scope模式时缺ref拒绝。root控制面identity RPC的clientFingerprint256不充worker Doc客户端pin，slot另配workerServiceKid/workerFingerprint256且逐次核trusted transport。

注册从完整root链ready取instanceId，同request同key可幂等；admit在同SQLite事务生成assignment并占原currentRun，root真正bound以前confirmRead拒绝且无receipt，query/check同闸。独立`scopeAssignment`operation及`/internal/v2/runs/assignment`只返回原tuple签名记录/执行门状态。持久required重启后缺模块拒绝；root锁/失败refresh清旧缓存。第一块normalfinish暂明确503，不能沿旧main finish直接done释放FIFO；后续同本包接三段终态，不以此pending当整体完成。

验证首轮原始日志：TMP `pc-worker-doc-assignment-target-1.log`，3/3、0fail/skip、153.5352ms；为真实SQLite/签名/完整root链校验器，rootOS与transport是明确受控模型，非TLS/OS证明。首回归TMP `pc-worker-doc-assignment-regression-1.log`，78项/77pass/0fail/1skip、627.0225ms；唯一skip未配置actual VH provider，保留该首次结果，后续显式配置再验。未业务监听/full/模型/节点。

## 第二块接口与首个有因失败

根窄扩已交接：master采用独立实际mTLS pin/kid，登记purpose=control-only，只允许conversationControlSubscribe/conversationReadOpen/conversationReadClose/conversationControlAck及pendingRuns；worker mandatory rootScopeRef且purpose=run-worker。不能用缺ref推master，scope配置同pin或同kid拒绝。pending在新模式需原RAM签名；未启scope旧模式保持。

typed forced-terminal需Doc签名完整assignment+持久fence引用，intent必须null；unassigned-retirement只可ready且无assignment，root可信文件记录不表示任务完成。两类closed有独立protocol，完整历史允许无bound阶段的retirement；normal原结构/签名不变。共享Asset原语仅固定Agent endpoint允许显式allowDeadMain，Asset默认及Asset用途传true均拒；死主分支核boot/scope/原service inode/Invocation/MainPID0/旧birth消失及loaded drop-in前后相同，随后复用原固定eventsFD空证据。实际Linux尚未跑，纯模型不能替代该证据。

首typed/兼容回归TMP `pc-worker-doc-lifecycle-target-1.log`：163项/162pass/1fail/0skip、651.2879ms。唯一失败为actual account fixture要求两条显式路径，我仅配置provider未配PROMPTCUT_PASSWORD_ORDER_MODULE，尚未进入该项业务；原失败保留，补真实order绝对路径后有因复验。eca3类型首轮exit0（8.10秒，TMP pc-worker-doc-assignment-type-1.log）；本增量需固定后重验类型。没有full/真实TLS/节点。

补正确actual VH provider/order配置后，同源码目标163/163、0fail/skip、686.9127ms（TMP pc-worker-doc-lifecycle-target-2.log）；类型0、7.84秒（TMP pc-worker-doc-lifecycle-type-1.log）。根另在集成点56a运行208/208、7217ms、类型0；这不包含本叶后续未提交正常三段，不能据此认定scope revoke已保FIFO或Linux forced通过。

## 独立forced OS实验增量（仅交根执行）

既有agent-run-scope-proof显式增加`--forced`，原无flag正常入口不变。命令为`node scripts/probes/agent-run-scope-proof.mjs --config /run/<fresh>/probe.json --out /run/<fresh>/out --forced`；沿用原两槽固定配置与新root命名空间，不能复用旧实验目录/锁。两槽仅实验数量，不是生产并发默认。输出祖先必须root可信，不能用world-writable的/var/tmp作发布证据目录。

A先经原真实pinned mTLS向隔离worker专用probe-parent-exit提交受控Doc签名private forced-terminal，worker核真实root assignment、原record、完整签名后仅自行退出父进程；不签normal intent、不向任意PID发kill。子进程保留既有SIGTERM幂等handler及2秒FD/TCP窗口。root先实际观察原父birthgone、原子birthlive/持真实FD/TCP、固定scope FD populated1及active invocation，再调用真实pinRetired→allowDeadMain→stopAndObserve。未观察该负例、原service对象被回收/替换或未知均失败，不能用更长sleep或ENODEV算空。原scope固定FD真实pop0、父子birthgone/双EOFclose、durable closure/marker完成后reader才closed。同期B原tuple、子资源与TCP必须不变；之后按原normal路径关闭B。

替换反例从真实已启动B记录取得OS tuple，代入A的pinRetired，必须publisher-previous-instance-mismatch且A/B原birth仍在；不改真实unit/record，不stop替代PID。其余实际文件缺marker/有锁/混代/新空实例拒绝仍保留。测试采用受控Doc issuer，只证明root OS adapter，不证明真实Doc worker-failed授权或业务模型完成。worker-failed自动证书producer尚未接：master getter只能读取已存在证书，不能请求生成；缺真实Doc fence时保持FIFO pending。

本机只做两脚本node --check与diff --check（均0）；Windows CLI一次自然exit1、精确probe-linux-root-required，按预期断言通过，原始TMP pc-agent-forced-proof-cli-1.log。未启动listener/服务/模型、未操作节点。首次Linux原normal10/10保持原历史，不能移作本forced增量结果；由root导出固定blob后单轮实测。

根实际9e9854ab第一次Linux forced已通过11/11、proof exit0、wrapper13.562秒，10份固定blob hash一致。A4109ms原父birthgone、子live/FD/TCP仍持有、原scope pop1，随后才pinRetired；6108ms同固定FD pop0、父子gone、双EOFclose。B6284ms仍原tuple/资源，8480ms才正常closed。实际B tuple代A拒且不stop，缺marker/lock/mixed/new-empty均拒。四生产PID/NRestarts零变化，两owned units inactive/MainPID0，6540–49零监听、retainedUnits[]。原证据TMP pc-agent-scope-linux-forced-9e9854ab-once.result.json/meta。仍为受控Doc issuer的OS增量，不等于Doc业务/crash授权通过。

## 正常三段和独立只读getter

〔裁：三级实施机制〕旧scope revoke会沿finishInState提前释放FIFO，本增量保留原currentRun，立即拒新read/write、取消匹配queued；只有root可信closed链和Doc实际关闭库存双齐全后，内部reconcileScopeClosures同事务结清该原run。shared已读credential/member仍保retained，private覆盖；六类fence的未读/已读分别回归。失去reader、原父未知、缺历史Doc库存不能释放。

normal接口：`finish`在scope模式精确原五绑定+requestId+readReceiptId+outcome={v:1,status:done|failed|interrupted,eventId,eventDigest}，仅持久finishReceipt/terminal control，不完成。`finish/query`同全body独立queryFinish operation，冲突outcome409。旧未启scope调用形状保留；新scope缺outcome拒绝，不从donePromise补done。

`scope/prepare`精确五绑定+requestId+finishReceiptId+prepare（原RAM签名完整promptcut.agent-run.prepare.v1，含rootref/assignment/完整target/read/outcome/event/drain/control）。Doc核同key和持久receipt，保存原签名对象。`scope/terminal`精确五绑定+requestId+finishReceiptId，在原Doc transport真实fence完成、所有相关operation fence持久committed后签normal terminal，terminalReceiptDigest=digestOf(完整signed prepare)。worker据此签intent后交root；闭口后只读完整root历史导入runScopeClosuresV1，离线finalizer无需向死worker取key。queueState done表示结清，terminalOutcome保存真实failed/interrupted，不能显示为成功。

master新两项均独立只读operation/PoP fullbody，旧五项不泛化：`POST /internal/v2/runs/worker-event-source` body={projectId,runGrantId,assignmentDigest}，workerEventSource核当前rootbound、readreceipt/currentRun、真实account资格或精确retained及fence；返回DER公钥/worker Doc pin/安全业务message字段（含requestId/arrivalSeq/createdAt），不返回login/credential/cap。`POST /internal/v2/runs/scope/control` body={projectId,controlId,runGrantId,assignmentDigest,rootScopeRef}，scopeControl只读同ledger既有forced证书，核配置master、worker slot/kid、原revoked grant/closureControlId/control inventory及Doc实际关闭；当前fence不阻这项关闭证据读取，但不能执行。root尚未bound仅返明确unassigned，不冒任务terminal。未知/跨control/ref/worker角色/签名body错拒。两接口都不会根据网络body新建forced control。

worker-failed/crash自动授权仍缺可信producer：当前scopeControl不能凭master自报死亡生成Doc fence。最小后续入口应仅让Doc读取固定root槽下root-owned失败观测（authority/slot/epoch/recordDigest、原service/scope双tuple、actual boot/startTicks/Invocation及失败原因），核现grant/rootbound/配置同源后在原ledger事务写typed worker-failed fence；root尚未证空仍pending，闭口仍必须原FD链。不得补RAM normal intent或新实例空库存，本块不把此入口声称已实现。

新增TLS/SQLite目标首两红保留：TMP pc-worker-doc-control-tls-target-1.log 为6/5/1、1188.2458ms，真实operation history夹具没建项目genesis导致needs-reconciliation；第2.log为6/5/1、1606.1081ms，显式受控root模型缺pinRetired接口而拒forced-close。补正常createProject与明确模型接口后第3.log为6/6、0fail/skip/cancel、1255.3245ms。所有TLS实际socket0/server不监听后清理，6712端口自有；未改生产拒绝标准。测试的Doc库存/SQLite fence为实际产品函数（零数据连接），root关闭部分仍受控模型；真实Linux证明由上节独立结果承担，未声称这一项把两者合为生产执行器验收。冻结后另跑相关目标/类型，不跑full。

固定正常三段source `8d869ae966de033a4764e71ed7bfd94d58d7f088` 首相关回归：8文件166项/166pass/0fail/cancel/skip，1716.5763ms（TMP pc-worker-doc-completion-target-1.log），显式真实VH provider/order。类型首轮0/7492ms（TMP pc-worker-doc-completion-type-1.log）。含原Asset完整专属、旧instance/run core成功断言，未把旧成功改pending。scope-doc文件现在7个顶级case，实际TLS为第2项，专用6712；第7项覆盖六类fence各未读/已读共12分支。结束原TLS socket inventory=0/listening=false，端口段6712–6721读查无LISTEN，源码测中不变、diff-check通过。根随后收此固定source独立验证；本Agent未跑full/浏览器/模型/节点。

根回传Linux9e forced精确probe duration为8703ms、外层13.562秒；前文samples/11项/PID与清理结论不变。该次实际验证已封存，不更改其源码或复跑。

### 后续crash证据最小接缝（提案，未实现）

由root槽控制器在已有互斥/root-owned目录下发布独立typed失败观测，必须绑定authority/slot/epoch/recordDigest/assignmentDigest和完整原service+closureScope双tuple、boot/startTicks/Invocation及实际MainPID0/旧birth消失；读取原scope FD的populated可为1，它仅授权精确强制收口，绝不是closed证据。文件/目录fsync与完成marker后才可读；master只能提示Doc重新读取固定槽，不能上传观测字段或写root文件。Doc核完整既有root链与当前ledger同grant/instance/key和assigned/bound状态，事务创建worker-failed typed control及立即访问fence，再用现scopeControl只读证书；真实root空链完成后仍由同内部finalizer释放。新MainPID、错boot、变Invocation、混scope或过期epoch拒绝/保锁，不向死worker索normal intent。

未bound的root retirement与任务结清必须另核：当前代码只允许已revoked的原scope grant消费unassigned-retirement；没有真实Doc控制时，assigned-unbound遇root ready失败仍pending，不会自行冒称失败已结清。后包需由同root可信失败观测驱动Doc准确撤销该未执行assignment，或证明本epoch根本没有Doc assignment后仅回收槽，不写任务done。它与已bound worker crash是不同类型，不能靠新实例空清单替旧库存。本段是后续精确实施提案，不把尚无producer说成已完成。

### 终态开始后的真实TLS授权补证

根提出check/ticket可能缺finish闸的审查疑点，经固定8d源码核实checkWithScope已在同事务拒g.finishReceiptId，resolveRunPrincipal调用此门；疑点未成立，不改产品。独立测试提交6c11caeedfdef58e867b9b1421bb961fbf6b1400补真实TLS前后对照：read/write在finish前200，scope finishReceipt落库后都403 run-revoked；ticket在finish前实际resolve成功抵达未配置issuer的503 run-ticket-unavailable，之后先被provider403拒，未加入伪ticket issuer。workerEventSource同拒；queryFinish仍200/pending，原RAM prepare仍200，terminal因Doc尚未关实际返回503 doc-closure-pending。随后private与原finish竞态仍只在forced rootclosed后结清，结果interrupted、不恢复成功。

该固定测试source首次7/7、0fail/cancel/skip、5541.3325ms，TLS case3780.8672ms，TMP pc-worker-doc-finish-gates-tls-1.log。原7项均保留；6712实际socket0/server不监听、6712–6721结束零LISTEN。仅测试增量，产品类型结果仍8d的0，未因纯测试变更无因重跑所有目标/full。根独立集成继续负责共同基线。

## crash失败观测首包：明确接口与机制〔裁〕

新实现基线b8ca9070fd7fef552105977c42fe11b68a2ba44b，根已合正常三段及Sol消费者。〔三级机制〕修改前：已有root原FD关闭证明，但死worker没有normal intent、master也不能凭body生成forced control，故保持pending。修改后：仅root固定槽CLI新增observe-failure，复用精确Agent用途pinRetired及原OS双tuple核验，要求实际MainPID0/旧birth消失/同boot/Invocation/原cgroup，原scope仍active/exclusive。发布failure-<epoch>.json及failure-publication-<epoch>.json，完整绑定recordDigest/assignmentDigest与root观察；file+dir fsync、完成marker和锁释放俱全才接受。populated=1允许记录失败，绝不叫closed或释放FIFO；正常closed链仍另行完成。

Doc只从配置好的root目录/anchor重读完整历史及失败文件链，不接网络上传证据。bound原grant按真实失败摘要在同ledger写worker-failed fence/forced证书；assigned-unbound按同原ref明确撤销执行门，再走root unassigned-retirement，不伪造已bound任务证书。无Doc assignment只回收槽，不造任务done。任何混scope、替换key/newPID、回退、缺marker/锁或文件未知都保pending。master只能通过既有受认证control通道提示重新核对，不自由指定路径/unit/URL/authority字段。该字段方案是根裁定下的技术实施接口，不称用户逐字段批准。

本块仍只专属纯/SQLite/mTLS6712–6721验证，不跑full/浏览器/模型/节点；真实Linux由根单轮执行。旧Linux11项不是本新增失败观测producer的实测，必须分开记录。

实现精确文件：failure-<epoch>.json协议promptcut.agent-run-scope.failure.v1，字段v/protocol/authorityId/slotId/epoch/recordDigest/assignmentDigest/observed；observed为kind=main-birth-gone、at、bootId、完整serviceInstance/closureScope、scopeActive/scopeExclusive=true、mainPid=0、mainBirthGone=true、populated=0|1，禁止closed字段。failure-publication-<epoch>.json完整绑定anchorDigest/failureDigest及authority/slot/epoch。root observe-failure不会stop、释放scope或改变head phase。首次import后Doc另存failure摘要，删除/换写历史拒绝；reader对原先不存在的failure文件也前后双读，防“head未变”的发布竞态。原Asset默认用途不提供可用失败观测，Agent allowDeadMain用途才可调用，继续原OS/config双核。

〔裁：发现接口窄扩〕修改前master pending只有conversations，无法定位新产生的关闭control。修改后仅scope模式且configured control-only master以原pendingRuns PoP调用时返回{conversations,scopeControls}；scopeControls每项exact {projectId,controlId,runGrantId,assignmentDigest,rootScopeRef}，全部从现ledger revoked grant+原assignment+实例generation/slot/kid核出。旧非scope仍原shape。没有terminal/登录/cap/closed，必须再调用原独立scopeControl；请求body仍必须{}，不能上传failed布尔/证据。根已裁此三级接口，Sol拥有run-client/gateway消费者，不在本叶代改。

Doc内部reconcileScopeFailures只读配置槽、同事务验证原grant/assignment后才能使用私有内部门生成worker-failed control；对外trusted fence普通调用也拒worker-failed，网络没有mint路由。bound原实例失败与assigned-unbound分别消费forced-close/retire，Doc实际transport/operation fence和原rootclosed前都不释放。未知service cgroup已被systemd移除且不能完整核原对象时，当前root adapter仍失败保锁；不把ENOENT或只有主PID消失算完成，这是本窄包明确未自动处理的安全边界。

首目标15/15、0fail/cancel/skip、2178.1115ms（TMP pc-worker-doc-failure-target-1.log），包含实际SQLite importer及原真实TLS，OS失败观察/文件写故障使用明确受控模型。新增marker可见后fsync故障保锁、缺marker/混record/伪closed/live-main拒绝；bound和unbound都在原root关闭模型后才释放，状态failed、其它queued保持。没有拿模型证据替真实Linux。

为根准备同原两槽CLI新增--crash-observation：实际父gone/子FD+TCP/pop1后，真实root observe-failure耐久发布并由实际reader保持bound/notclosed；再走原forced收口、B不中断。原--forced和normal保持，仍受控Doc issuer，无节点执行；需要根另一次固定blob Linux取证，旧11项不能套新producer。所有输出仍/run可信目录。

主体675b2a10d6a0d263d66cb0543a779b9c7c4c3898，收紧完整forced terminal与同ledger原签名对象相等后固定0bf3b7e0。该source首9文件相关175/175、0fail/cancel/skip、2118.8672ms（TMP pc-worker-doc-crash-complete-target-1.log）；类型0/8137ms（TMP pc-worker-doc-crash-type-1.log），probe node --check 0。保留全部Asset专属/旧run成功回归；未跑full。专属scope-doc现9个顶级项，其中2项新增bound crash/unbound retirement，实际TLS仍1个case，包含pending发现：master真实PoP返回完整既有control引用，worker同入口403、body failed:true被strict parser400拒。受控模型中pop1失败只生成Doc fence，原rootclosed前FIFO保持；真实rootclosed后worker-failed结算failed，private竞态继续interrupted。没有修改已过Linux9e原日志，也没有把此新源码称Linux已过。

根收回0bf固定点后独立运行6712窗口；本Agent目标已结束，TLS实际owned socket0/serverfalse，窗口已明确释放。工作区最终仅本报告追加，无source测中改动。后续真实root OS或业务配对的首次结果由根补入，不同层证据分别归档。

## 根实际crash-observation首轮与消费者只读复核

根在联合固定source `ab217f05ad0fc09be354426bb577af4ed952b899` 导出10份Git blob并核hash，首次真实Linux `--crash-observation` 12/12、proof/SSH exit0、proof8502ms；根外层计时12.047秒，result内部wallSec为9.98，计时层不同不混用。原始TMP `pc-agent-scope-linux-crash-ab217f05-once.result.json` / `.metadata.json` 已只读核验；namespace `pcagentrunproofd5ec146ad6ea40b7`，节点证据保留在对应/run目录。本Agent没有节点操作或复跑。

A3854ms原parent gone、child live、真实FD/TCP仍持有、原scope pop1；实际failure文件和完成marker可读，reader仍bound/notclosed。5859ms同原FD pop0、父子gone/双连接close后才closed。B6083ms原tuple/资源保持，8254ms虽文件/TCP已关但子live/pop1仍不完成，8275ms才pop0/closed。真实B tuple代A、缺marker、存在lock、混配与新空实例均拒。两owned units实际inactive/MainPID0，retainedUnits为空，6540–49无listener；四生产PID279515/279516/279517/9395及NRestarts=0前后不变，实际数据未删。该证据明确actualLinux=true、controlledDocIssuer=true、productionExecutor=false；它证明root失败观测与原OS范围闭口，不证明业务Doc签发、真实模型或gateway完整闭环。

本轮只读审固定Sol `6869e304`（产品`f11bf044`、`66e7d165`）的journal/sink及其原消费者，未读入Sol后续WIP、未改产品、未运行目标或listener。没有发现可据现有代码直接成立的提前成功/自由关闭授权缺陷；当前最短用户路径仍有明确未接接口，不能因219共同目标全过声称正常FIFO已经完成。

已核边界：worker-event-journal的packet和ACK分别FULL事务持久，ACK核完整packet/row摘要及连续序号；worker-event-sink发送实际TLS exporter签名，成功/错误均等待request/socket/response实际close，再持久ACK。master appendWorker在串行写队列内fresh Doc getter后同步事务追加原message、event、receipt。该master receipt是事件持久收据，绝非Doc任务完成收据。固定实际TLS测试覆盖master已commit而响应丢失：同OS原RAM session重开sink/journal，只重发原packet，master不重复追加；新writer被execution-replay-pending拒。该测试Doc getter/注册为受控组件，不替代真实业务Doc或Linux隔离。fatal sink不能原对象重启继续执行是安全关闭边界；自动创建同OS packet-only恢复消费者尚未装配，不把新OS读旧journal当执行恢复。

最小尚缺接缝（由消费者owner实现，保持现Doc权威）：

1. `server/agent/service/account-runner.mjs:233` 仍在真实done/flush后明确抛run-outcome-unavailable，259行onTaskDrained仅给local-drained/durable和原绑定；没有终态状态推导/不可变drain记录。应从已持久真实终态事件及journal.receipt(eventId)核master原row/eventDigest，实际runner/data drain后最后flush，才形成原RAM scopePrepareSource可精确重读的记录。donePromise resolve、closedRuns Set或零计数都不能替代它。
2. `server/agent-service/run-client.mjs:7` 与 `server/agent/service/agent-instance-session.mjs:15` 尚缺finish/query、scope/prepare、scope/terminal、scopeControl的精确transport/operation消费。已有scopePrepareFor（91行私有source门）和scopeIntentFor（103行）绑定同原RAM/key/assignment，但没有正常消费者调用；应只补现Doc已冻结的exact body/op，保留不同角色与失权后的独立只读关闭域。master pending发现control不等于取得terminal，仍需独立scopeControl验证。
3. root独立进程需从固定槽/allowlist接收已持久Doc terminal和原worker intent，执行现publisher原FD真实关闭，然后由Doc重读可信文件链/finalizer；worker在取得prepare/intent前不能close其runClient丢RAM身份。当前account-task-worker.close会关闭session，这是正确销毁行为，不能把它提前当正常结算入口。缺root业务调度入口时保持pending，不向已死worker补签、不由master重签。
4. 正常/forced交错必须串起现有门：全部终态event ACK先于finish（finish后workerEventSource拒新事件）；finish只是recorded/pending，不能据HTTP200释放。若先被private/crash撤销，消费者只能发现既有typed control并走forced，不补normal prepare；若normal terminal后发生fence，Doc最终从当前ledger控制与原root闭口链对账，不能用旧normal成功响应覆盖interrupted/failed。未知ACK只查询/重传原tuple，execution-started不再跑模型。当前provider已具这些拒绝/最终对账门，本轮未发现消费者绕过；下一消费块须实际并发验证，不能只用顺序正例。

以上是可执行接线缺口与后续验证要求，不是新用户语义或新的关闭权威。唯一文档提交不改正在根Linux验收的任何source；原所有首红与分层结果保留。
