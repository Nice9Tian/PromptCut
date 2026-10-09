# 独立任务 OS worker 交接接口

## 开工边界

工作区沿用 `018-cloud-queue-user-path` / `codex/018-agent-real-runner`，当前固定 `8be334966e721d3ea5d019f1a3307df55d0e1d3c` 干净。根已收回上包到 `a4d22ce3` 并占用 6700–6711 验证，本包不合 main、不改产品、不启动服务或模型，只新增本报告。

目标是把真实 HostedRunnerFactory 放进独立每任务 OS worker，以 Doc 签名 assignment、worker 自有 RAM dataKey 和 root 固定槽生命周期衔接 master 准入、执行、强制中止、关闭证明与 Doc 结算。现有 grant 不 transfer，master key 不发给 worker，supervisor 不代签 worker。

已向 Astra 约 Doc finalizer/provider 边界，后续设计列精确文件租约与未实现接口。所有技术选择标〔裁〕，不冒称用户逐字段批准；端口和两槽只用于实验，不成为生产默认容量。

## 结论与已定语义

采用最小三级机制：master 只接人类 HTTP/SSE、持久事件与调度待办；每个任务使用 root 固定槽中的一个新 OS worker，worker 自己注册 RAM 实例、自己向 Doc admit，不接收 master 已领到的 grant。Doc 是唯一 FIFO、消息、已读、retained 与终态权威。正常任务、强制中止、尚未绑定任务的启动失败分别使用可验证的关闭记录，不共用假 intent。

这不是当前已实现能力。下一实现必须先补身份和关闭接缝，然后才能把原 factory 切到 worker；缺任一接缝时保持等待/503，不能先上线半条运行链。已定的共有同对话一次一轮、服务到达 FIFO、逐消息发送者、改密/被踢时已读共有当前任务 retained、私有切换停止他人当前任务并保留已落地修改、关 Agent/删项目范围优先均沿 `docs/plan/account-binding-task.md`。没有改变用户发送/停止操作、50 对话删除细则、渲染提前让位或补渲故障 A/B，也没有把两槽实验变成生产容量承诺。

本报告的“master”是 Agent 人类入口/调度进程；“worker”是运行原 HostedRunnerFactory 的 OS 进程；“publisher”是独立 root 生命周期操作器。它们的证书、数据目录与权限分别配置。root 能停止固定槽，不能签 worker 的 data proof 或改 Doc 项目/成员状态。

## 固定源码证据与真实缺口

| 已读真实接缝 | 现行为 | 本任务需要的最小变化 |
|---|---|---|
| `server/agent/service/account-runner.mjs:createExistingHostedRunnerFactory`、`createAccountRunManager`，本叶 `8be33496` | 原 factory 已使用 `dataClient.webSocketFor(grant)`、真实 instance/link、`project.open`，每次 model/tool 前 fresh run gate；manager 自己 admit、confirmRead、executeOnce | factory 保持。manager 的 admit/执行搬到 worker，master 不先领 grant 再转交 |
| `server/agent-service/account-executor-assembly.mjs:createAccountExecutorAssembly` | 同一 OS 的 runClient 注册→readControl→dataClient→resources→manager；定时 `resumeQueued`；`completionReady:false` | 分出 master gateway 与单任务 worker entry；只 worker 组装实际 executor，每 worker 不自动领第二个任务 |
| `server/agent/service/agent-instance-session.mjs:createAgentInstanceSession` | 在内部生成不可导出私钥；Doc challenge/register 回实例；Doc 公钥摘要基于 PEM | 增公开 DER 公钥与窄 scope intent signer，仍不导出私钥；root ready 公钥与 Doc 注册须证明同一把 key |
| `server/account/agent-instance-authority.mjs:beginRegistration/register` | Doc 分配随机 instanceId；可并行存在多个 active 实例，代际不是 master→worker transfer | Doc 注册绑定 reader 已核 root ready tuple；root instanceId 与 Doc instanceId 必须精确一致，不从未核 body 自由赋值 |
| `server/account/run-authority.mjs:admit` | 同事务 claim FIFO 消息并不可变绑定当前 serviceKid/instanceId/generation | admit 同事务绑定 root slot/epoch/recordDigest；新 grant 先等待 root assignment 持久发布，不允许此时 confirmRead/write |
| root `a4d22ce3:server/hosted/agent-run-scope-{schema,reader}.mjs` | v1 连续 epoch、anchor/checkpoint、双 head 与锁、同 RAM 公钥/实例验证；reader 不会自己写 Doc ledger | Doc 私有 importer 消费 reader，精确写 assignment/关闭引用；缺 marker、锁、混配、回退均拒 |
| root `a4d22ce3:server/hosted/deploy/agent-run-scope-publisher.mjs` | root 初始化/启动/绑定/正常关闭固定槽；关闭要 Doc terminal + 原 worker intent；scope FD 持有到 closure fsync 后 | 增独立 forced/unassigned 类型，不能伪造 normal intent；固定槽网关只调用白名单操作，不接受 shell/unit/path 自报 |
| `server/agent/service/account-run-events.mjs` | FULL SQLite 单对话 eventSeq，grant+eventId 幂等冲突拒；user 镜像来自可信 Doc；写失败阻止下一 model/tool | master 唯一事件 writer，worker 有独立 source cursor 与签名 append RPC；不让 worker 共享 master 可写目录 |
| 单独冻结 `c705c125:server/account/run-authority.mjs:finish/queryFinish/finalizeFinish`，报告 `d111ada9` | 先记录 exact outcome，保持 finishPending/FIFO；finalize 核 Doc actualclose、签名 Agent drain 与 `runTerminalResourceClosuresV1` | 尚未挂 root reader producer。正常 close 许可与最终资源见证分开；不可仅给闭合表填 row 接绿 |

注意版本边界：root `a4d22ce3` 的 run-authority 仍有旧 `finish` 无条件 done 路径，原本叶 manager 在持久 events 路径保持 `run-outcome-unavailable`，没有调用它。`c705c125` 是单独 Astra 冻结接口，不能以本报告说已合入 root 或已经支持整个闭合。初次只读命令曾误读 `server/agent-service/agent-instance-session.mjs`（不存在）；随后已按真实 `server/agent/service/agent-instance-session.mjs` 核源码，没有猜造新路径。

### 已实测 root OS 证据的范围

读取 TMP `pc-agent-scope-linux-fc47062e-once.result.json`：固定 `fc47062e`，10/10，probe 8357ms，外层 10.061s/exit0。A MainPID 消失而子进程文件/TCP仍存在时原 scope populated=1，reader 因锁拒；最终父子 birth gone/populated=0，closure 持久后才可读。B 在 A 关闭期间保持原身份与资源，随后独立关闭。两实验 unit 最后 inactive/MainPID0、listenersAfter=[]；四生产服务 PID/NRestarts 前后未变。

这是实际 Linux root/systemd/cgroup/文件与 TCP 闭口证据，Doc issuer 受控，productionExecutor=false。它不证明真实业务 Doc assignment、worker registry、factory、终态或 FIFO。Windows 纯回归也不能替代这些 Linux 观测。

## 最小接口约定（均为待实施三级机制）

下面名称是拟新增导出/API；旧源码存在的名称已在上表标明。实现 owner 不能把它们当现有 API。〔裁〕编号只是本报告各卡点的最小机制选择，不是新增用户决定。

### 〔裁1〕先有真实 worker，再由 worker 自己领 FIFO

修改前：master 的 manager admit 得到绑定 master RAM 实例的 grant，再调用同 OS factory。修改后：master 只排程 `{projectId,conversationId,wakeRequestId}`，root start 生成新 reservation/worker；Doc reader 真核 ready，worker register 后自己 admit。替代“transfer master grant”违反不可变实例授权；预先启动永久通用 worker 虽可执行，却不能给每任务独占 OS scope，故不采用。

拟 gateway `createAccountWorkerGateway({schedulerStore,rootSlotClient,docAssignmentClient,eventSink,slots})` 仅暴露 `wake/describe/close`。slots 是可信配置映射，body 不能增加 slot/unit/port/路径。持久 `worker_dispatches_v1`：`dispatchId,wakeRequestId,projectId,conversationId,slotId,epoch,recordDigest,phase,assignmentDigest,lastErrorCode`；唯一 active slot epoch 与同 conversation dispatch。phase 为 `queued→starting→ready→bound→closing→closed`，阶段未知保存 pending。master 定时/重启只重放原 dispatchId，不重新 start 同 epoch。

master 的 pending 查询只得现有 queued metadata，不拿人类 credential 作 worker 凭证。唤醒由服务端同意与项目开关决定；槽满保留等待，不报本机降级。root 专用 IPC（由 root 另授权）输入只为 `requestId,slotId,operation` 加已签 Doc certificate，输出 public record/head digest；配置和 unit 由 root 映射。start/bind/close 幂等结果必须持久，不允许调用者传 ExecStart、PID 或删除旧锁。外部全 root controller 互斥仍是实际部署前提，不能以两个 Node 启动函数代替。

worker entry 在 ready 身份端口就绪后向 Doc 注册。拟 challenge 增 `rootScopeRef:{rootAuthorityId,slotId,epoch,recordDigest}`，Doc importer 读取连续 ready record 后核当前真实 mTLS serviceKid 对应 expected client pin、record.instanceId、公钥；Doc 用 record.instanceId 生成 challenge，再沿现有 PoP 注册。同一底层 Ed25519 key 的 PEM/DER 摘要不能混同：保留旧 Doc `publicKeyDigest` 算法；root `worker.publicKeyDigest=digestOf(DER-base64)` 单独命名为 scopePublicKeyDigest，两者由服务端转换核相同公钥，不能直接比较不同编码的哈希。

实例 session 拟增只读 `scopeIdentity()` 返回 DER publicKey/digest 与注册 public identity；`scopeIntentFor({assignment,terminal})` 必须内部核本实例、已核原 assignment/Doc 签名域，才签 v1 intent。私钥仍 RAM、从不 IPC/export/persist。master 的 readControl RAM key 不交 worker；每 worker 自有 runClient/dataClient/readControl/resources。worker 初始模型配置只读自己受信文件，不经 argv/log 传 key。

### 〔裁2〕assignment 是执行门，而不是第二套 run 权威

Doc admit 原事务仍 claim FIFO、核 accepted-message、run service instance，增加不可变 `rootScopeRef` 与 `assignmentState:'pending'`。Doc 签发当前 schema 的 assignment：

```text
{v,protocol,authorityId,slotId,epoch,recordDigest,docAuthorityId,
 target:{projectId,conversationId,messageId,runId,runGrantId,serviceId:'agent',
         serviceKid,instanceId,instanceGeneration,publicKeyDigest},signature}
```

这里 `authorityId` 是 root 槽 authority，`docAuthorityId` 是 ledger authority；不得混用。Doc 签发持久 outbox，root bind 验原 ready/live OS 并 fsync assignment+bound marker。拟 Doc `observeAssignment({assignmentDigest})` 内部从 reader 读 bound，同事务核 ledger 原 grant/slot/epoch/key，设 bound；worker 才可 confirmRead/模型/工具。pending 响应包含原 grant refs，但不含执行能力；相同 requestId 可查询/重放，同 request 变 scope 409。binding 丢 ACK 不重领第二条消息。

所有 gate 继续原 runProvider，不复制 retained/项目 ACL。当前 grant refs、本次 invocation cap、scope bound 三项都满足才 allow；同 cert 新 OS/newkey、旧 epoch、错槽/assignment、creator role、resolve/read cap 写操作均拒。worker 只一个指定 project/conversation 的一条 admit；不能启原 resume timer 轮询别的对话，也不能 finish 后偷偷领下一条。

### 〔裁3〕持久事件由 master 分配同一条 eventSeq

独立 worker 若各开一个 conversation_events 库会把 eventSeq 从1重来；多个 OS 同写 master SQLite 目录又扩大账号/文件权限。选 master 私有 append sink、worker 受监督 source journal，保持既有 `createAccountRunEvents` 对话 eventSeq/UI契约。拟 `appendRunEvent({sourceSeq,binding,eventId,event,requestId})`：worker 对真实 mTLS exporter/fullbody 签 exact operation，master 核已登记 worker/assignment/grant；持久 sourceSeq 连续且 `(runGrantId,eventId)` 同内容幂等，才由既有 writer 分配 eventSeq 并 ACK。源日志只能写 worker 自己目录，master 不直接打开 worker 私有 SQLite/WAL。

worker emit 仍立即监督 append Promise，`events.beforeCall/flush` 在下一 model/tool/terminal 前必须等 master durable ACK。失败原样阻止下一步，不以 emit 返回或网络200当持久。掉 ACK 重送原 eventId/sourceSeq/full内容，不生成另一 assistant/runId。master user 镜像仍从真实 owned Doc read scope取消息，不能从 worker 或发送请求正文取 user 内容。SSE继续实际 read-control/ACL/游标，不因存档事件存在就对被踢者/切私有成员吐新正文。

worker 死后保留最后已持久事件。未 ACK 源事件不能靠新 OS 冒旧 key 重签；master 已持久记录可按原 eventSeq replay，未知尾部明确 pending。无法证明模型最终结果时仅由 Doc 可信 crash/control 来源记录 interrupted，不补 done。事件 sink 与 worker身份协议是新增窄接缝，原 FULL 表/消息seq与UIparser不重复实现。

### 〔裁4〕正常关闭分“许可停止”与“已经关闭”

当前两块存在实际顺序环：scope publisher 要 Doc terminal+worker intent 才 stop；`c705c125` receiver/manager 又要求独立 resourceWitnessId 才允许完整 terminal drain，而 root witness 要 stop 后才产生。不能先写假 root resource row 来解环。

选独立 prepare receipt：worker 已模型终了、工具 dispatch结清、事件flush、自己的 data/read资源真实close后，RAM签 `{assignmentDigest,finishReceiptId,readReceiptId,outcomeDigest,terminalEventId,terminalEventDigest,drainDigest,instanceId,instanceGeneration}`。它是“可以停止本 worker”的声明，不是 OS closed/complete。Doc 验事件持久来源和 exact target后签 schema terminal；`terminalReceiptDigest`绑定这份 prepare receipt，不能要求尚未发生的 root witness。worker 再签原 intent，root才能 normal close。此拆分需 Astra 明确新 prepare verifier，不能复用目前要求 witness 的成功 receiver。

正常顺序：持久真实 outcome→Doc finishPending/control→Doc 同步读/写 fence、实际数据连接 close→worker prepare/Doc close许可/worker intent→root锁内 terminal+intent fsync→stop精确unit/cgroup→原 scope FD观测空且旧birth gone→closure fsync→释放scope→closed publication→Doc reader核连续chain/checkpoint→持久 `runTerminalResourceClosuresV1`→内部 finalizeFinish。

resource row 按 c705 现 verifier 精确填原 binding、finish/read/outcome、resourceScopeId/witnessId、`source:'root-observed-run-scope-v1'`、rootAuthorityId/rootEpoch/rootInstanceId、publicationDigest/closureWitnessDigest；字段值从 reader 验过的原记录派生，不接受网络 body 自称。Doc实际 read inventory/WS/LP/SSE全关与 root OS闭口是独立证据，二者不能互相替代。

Astra已进一步确认：scope schema 的 terminalReceiptDigest 已是哈希字段，可保持其正常结构；新增的是 Doc 私有 prepare签发/验签明确域，而不是修改worker intent算法。拟 `runTerminalPrepareReceiptsV1` 存 exact binding/read/outcome/rootScopeRef/eventDigest、worker签名与requestDigest；不含closed:Boolean/伪witness。Doc finalizer须增加明确的 prepare+root 路径，分别核这条原签名声明、真实闭合source和Doc库存；不能给prepare补一个后来rootwitness字段后冒充worker原已签closed drain，也不能把现c705 verifier的 `agent.drain.resourceWitnessId` 强塞给尚未closed的记录。root关闭后不向死workerRPC，这正是本接口的收口点。

终态事务才调用 `conversationHooks.finishInState`、释放 currentRun/FIFO并唤醒下一条。HTTP200记录 finishReceipt、model done Promise、进程退出、cgroup空中的任意一项均不是完整完成。若 root已关闭但 Doc导入/ACK失败，reader按原 checkpoint可重放，不能重新执行；finalize同receipt幂等。

### 〔裁5〕强制中止和未绑定代退休使用独立类型

原 v1 normal closure 强制要求 worker intent，deadworker或挂死worker拿不到签名。新增 `forced-terminal.v1` / `forced-closure.v1`，与正常 `terminal/intent/closure` 分型并由 reader 独立验证；不要让 supervisor用自己的key代签、空intent过检或把实例B空scope说成实例A已关。

强制路径由已提交 Doc stop/private/projectoff/delete/instancefence 控制或 root真实异常报告触发。Doc先同步阻断新调用/输出，签 exact `{rootAuthorityId,slotId,epoch,recordDigest,assignmentDigest,controlId,fenceRevision,targetDigest,reason,disposition}` 停止许可；root只停止已绑定该grant原unit/scope，保存同样原FD/OStuple、观察原cgroup空/旧birth gone。Doc importer核 forced许可与原control持久库存，实际读连接close库存齐后才结清原control/FIFO。retain共有的改密/踢人不产生这个强制许可；不因用户凭据撤销就杀被允许继续的当前任务。已经落地修改不回滚。

死亡发生于 readConfirmed之后而没有可信正常outcome，Doc记录 interrupted 的来源为 exact forced control/root观测，不伪造模型terminal；发生于尚未confirmRead的preparing grant时，必须使用单独未执行关闭处置并保留原message/read状态。允许清理该不可再执行的原grant、解它的实例占用，但消息是回队还是显示中断不在本报告默认裁定；先保持该消息pending并记录是否已经execution-started，禁止自动重播可能有副作用的任务。最小第一包可只实现显式stop/private已有政策的结清；非政策型crash的用户呈现/续跑交root按已有任务恢复契约核定，不借渲染故障A/B选择推导。

尚无 assignment 的 ready worker失败：新增 `unassigned-retirement.v1`，root exact OS观测闭口，Doc验证该 epoch没有grant/assignment、registered instance只fence不转移后导入。它不捏造runId/readReceipt/intent，不走 terminal success。旧未知ready不能被新start覆盖。跨boot/丢失 scope FD、锁留存、unknown WAL/marker均保持拒绝；只root在准确停机范围核验后作类型化恢复，不自动删除锁/PID判死。

以上两条必须和 normal 路径一起测试，但新增类型不是当前v1能力；本报告没有改 schema。强制中止能力不能等未来正常 terminal 完整后才补，也不能以“先不上失败场景”交付可运行的worker调度。

## 故障收口与持久边界

| 截断点 | 重启/重放动作 | 禁止的捷径 |
|---|---|---|
| root start后 master掉 ACK | 原dispatchId/query读精确slot/epoch，reader ready；继续注册/绑定或 typed retire | 再start新OS、删除锁、遗弃已有worker |
| Doc admit提交/root尚未bind | 同grant重放 Doc assignment outbox；cap保持不可执行 | 新instance重领旧grant、先模型后bind |
| bound后confirmRead ACK丢 | worker同RAM+FULL read-intent沿原queryRead；死OS按unknown执行边界处理 | 新key恢复execution-started并重放工具 |
| append/terminal prepare落盘失败 | 监督原错误，停下一model/tool，实际drain；不能发normal成功许可 | 忽略异步异常、donePromise推成功 |
| root closure durable但marker/锁未知 | 原reader拒绝，root原identity恢复publication；Doc不释放FIFO | 用服务inactive/statusready替代marker |
| Doc闭合引用已持久但finalize/通知丢 | exactreceipt幂等重放，不再执行；下一个grant由原FIFO事务决定 | worker/master自己shift队列 |
| master死/worker仍活 | master恢复持久dispatch与事件库；查询原worker/root与Doc，已有worker不得凭新master身份换key | master PID死就判全树关/把活workergrant迁移 |

root ledger与Doc账本分开，不跨服务持写锁 await网络。Doc签 assignment/stop outbox在原事务，网络交付后私有observe事务重新核livehead。root锁持有期间只做本slot固定生命周期；业务Doc查询不能反向等正持有的root锁。reader不可读时返回pending，不无限等。每个关闭操作先同步 fence，再并行真实drain/readclose/rootstop并监督全部结果；一项失败不能跳过其它owned资源收口。请求超时是未知结果查询，不是默认为closed或另领任务。

## 可派工小阶段与文件所有权（需 root 实际授租）

| 阶段/owner | 最窄候选源码 | 输出与独立门槛 |
|---|---|---|
| 身份与assignment/Doc：Astra | `server/account/agent-instance-authority.mjs`、`run-authority.mjs`、`run-internal.mjs`、新 `run-scope-wiring.mjs`；中央 `doc-agent-assembly.mjs`仅装配 | 同Docledger reader→registered同key→workeradmit→bound gate；真实mTLS错slot/epoch/key、samecert新OS拒。不给正常finish伪rootrow |
| worker身份/entry：Sol | `server/agent/service/agent-instance-session.mjs`窄公开key/intent、新 `server/agent-service/account-task-worker.mjs`；`account-executor-assembly.mjs`单任务参数；`account-runner.mjs`只一次指定admit接口 | 同RAM key贯穿root identity/Doc registration/read/data/tool；复用原factory。Windows真实WSS/Editor短任务保持strictpending，Linux实际独立worker持FD/child |
| gateway与事件sink：Sol | 新 `server/agent-service/account-worker-gateway.mjs`、`worker-event-internal.mjs`；`account-run-events.mjs`只可信remoteappend入口；`main.mjs`窄master装配 | 持久dispatch、单writer原eventSeq，发送→FIFO→worker→真实工具→双页事件/变更；杀master不杀未知进程，丢ACK不重复执行 |
| root typed close：Astra/root | 既有 `agent-run-scope-schema.mjs`、reader、publisher与专属test/probe；fixedslot部署由root | normal prepare→intent→rootclose；forced死worker、unassigned失败都有独立类型；真实Linux原FD/cgroup/child，不假counts |
| Doc闭合finalizer：Astra | `run-scope-wiring.mjs`、既有finalizer/控制路径；Doc data/readinventory原owner窄hook | 持久exactrootresource引用+actualdocclose+outcome才FIFO释放；控件/retained优先级保持，不收网络closedtrue |
| 唯一最终glue：root指定一Sol | main/Doc中央窄装配与固定依赖closure，部署参数root自己 | 完整在线Editor真实两个消息；第一真终态+资源关→第二才run，无新免费ACL/签名者 |

上述是候选租约，当前没有授权产品实施；需要双方先固定协议，再各自独立分支由root组合，不双改provider/instance/session。Astra已回复其目前仅root scope首包冻结 `fc47062e`/报告 `0e`，尚未改provider；正常terminal仍 `c705/d111`，reader未入 resource table；同意 master只排程/worker自admit、forced与unassigned必须独立类型。接下来可先合“身份+assignment gate”和“worker真实factory但结算pending”两个小阶段，分别有用户可见短链；缺typedclose的生产调度开关保持关闭，不能称生产ready。

## 真实验证计划与本次验证

下一验证先纯 schema/连续历史/SQLite failpoints，再真实临时mTLS与worker子进程，最后root Linux独立两槽。测试各自报告固定源码、首红、实际来源、耗时和真实close。对照完整Editor已实测 `246f72e9` 的四工具短链（get_project/get_selection/report_progress/安全小修改），只替换OS运行位置，不能fakeWebSocket/model结果冒作生产模型。先受控本地模型验证调用因果，随后root配置两生产模型单轮，凭据不输出。

必要反向：错rootanchor/回退checkpoint/缺marker；normal缺intent、换workerkey、parentgone childFD仍活；独立B不能作A见证；samecert新OS不能ACK旧grant；worker尚未bind不能model；readproof不能write；appendfail制止下一工具；prepare→close引用环必须被切断；private/off/delete强制杀原scope且保落地修改；credential/kick retained仍走原task且不能新send；terminal200/pending时第二消息仍queued；close引用齐后第二消息才admit。取消和正常done不能混用旧 `drainControl` 的cancelled=true。

端口方面，本次没有监听。未来 Windows试验可由root另核一个不含浏览器坏端口的独占段（现6700–6711正归root，不承诺复用）；Linux两槽可沿6540–6549既有实验布局但必须先查空并由root授权。两个OS槽只是干扰/并行关闭实验，没有默认名额、内存/GPU参数或两个活跃项目承诺。

本次仅读固定 Git对象、真实现模块/语义与root结果，写这份报告；不调用测试/npm/type/full/业务服务/模型，不把root正在跑的结果套给设计。验证仅报告 diff-check、真实路径/导出检索、协议字段与缺口逐项核对。未实施assignment/worker/gateway/finalizer，未新做Linux/Windows业务实验。报告提交后产品仍保持原 `8be33496` tree；root `a4d22ce3` 及单独 `c705c125`来源没有被合入本活动分支。

root随后通知最新main为 `cc7303611f5de9b79f5680b89c733fc42aad44b0`，其独立type0、177/177目标、full5502/5498pass/0fail/4skip，实际Editor17/17和private29/29、原Linux10/10同blob均已过。这些是上包/runtime的root证据，不是本报告新接口的执行结果。root已释放原实验端口，但本任务仍不申请服务窗口。新接线开工前按root要求同步main，并由root授本表具体文件租约；报告历史若有冲突先报，不盲清产品。
