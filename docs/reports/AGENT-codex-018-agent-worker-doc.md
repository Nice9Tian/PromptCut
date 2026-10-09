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
