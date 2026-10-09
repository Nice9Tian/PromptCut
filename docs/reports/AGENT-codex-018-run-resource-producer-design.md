# 运行资源独立关闭证明：最小实现设计

开工点：本叶 d111ada9（正常终态源码 c705c125）保持冻结，产品只读。只新增本报告和系统 TMP 的无监听反例，不运行 npm/full/业务监听/模型/节点。核验对象为 Sol executor 655d796d294d2b67ce46163ef88f5195261b8134（读取时 clean）及主库 root publisher/schema v2 固定 main 4bb2355f85cc26a7e296f5434ad7781dce4f4704。

目标：给 normal finish 一个真实独立的 run 资源关闭 producer，保留同实例签名、完整 read/outcome 绑定和 FIFO；不把整代 asset scope 当作 run scope、不写自由 closed row、不用零计数或 donePromise 代替 OS 证明。先交可执行三级方案与实际反例，根裁定后再分实现租约。

## 当前资源究竟在哪

以下均读固定 Sol 655d796d；不是借 WIP 推断已部署。

| 实际代码 | 当前所有者/关闭边界 |
|---|---|
| account-executor-assembly.mjs:54–81 | 一个服务进程注册一个 RAM 实例；所有对话共用 runClient、dataClient、resources，childTreeWitness 可选且默认缺失；control receiver 也是该进程 |
| account-runner.mjs:25–117 | 每 run 的 createAgentInstance 是 JS 对象，不是新 OS 进程。modelConfig、workspace、egress、hostedTools 都在该 Agent 进程；DataWebSocket 按 grant 划分，但同 PID |
| instance.mjs:1515–1605 | Hosted 明确使用 API runner/localTools=false；模型请求在当前 Node；activeTools 等真实工具 promise，超时不会把底层 work 当结束，drain 等它们退出 |
| runners/api.mjs:243–295 | 模型走配置 fetch/retrying fetch，实际 TCP/连接池仍属于 Agent OS 进程。不存在每 run 独立内核容器 |
| workspace.mjs:spawn / hosted-tools.mjs:145、772 | Python/ffmpeg/采集子进程从当前 Agent 的 workspace.spawn 起，环境白名单和 windowsHide 已有；没有迁移到单 run cgroup，run-resources 也不会自动发现该 spawn |
| run-resources.mjs:43–113 | 只跟踪显式 register 的 socket/stream/child；childTreeWitness 是未实装 Boolean 接缝。零计数不包括没登记的后代，也不能证明旧实例关闭 |
| account-runner.mjs:195–232 | 正常 drain 等 runner、event flush、数据 close，但 closedRuns 仅当前内存 runId 集合；并非完整 root/OS 引用 |

已提交给远端服务的素材、渲染、声音任务不因本地 socket EOF 就自动撤销。它们必须用既有精确 run 控制/持久作业表各自收口；本地 run scope 空只能证明本地执行器和后代退出，不能撤销已接受外部副作用。需要把这些目标库存封口并逐项等待已有服务真实回执；现没有完整登记的远端任务要继续 pending，不能将它们从清单删除来先过 FIFO。

## 真实无监听反例

- 首次 `TEMP/pc-run-resource-owned-child-counter-1.mjs/.log`，exit1：ownerKey 写成 fixture-owner，不符合真实 workspace 的纯字母数字约束，在 spawn 前被 bad-path 拒绝。未启动子进程；原文件保留。
- 改为合法 fixtureowner 的独立 `...counter-2.mjs/.log`，exit0。真实 runFixture SQLite、真实 RAM 签名的 admit/read/checkAccess，受控账号发行；实际 createWorkspaces.spawn 启 hidden Node 子进程，子进程真实打开文件并保持 fd，父 PID 正是当前执行器；另一个真实 ReadStream 经实际 run-resources.register 授权/登记/关闭。
- 原始结果：`pendingRegistrations=0,connectionsOpen=0,streamsOpen=0,childrenOpen=0`，同时 `workspaceChildStillLive=true,actualChildHeldFile=true`。`complete=false,witnessMissing=true` 正确。证明“登记计数归零不能覆盖实际工作区子进程”，没有注入 allow=true 或 childTreeWitness=true。
- 最后只让自己持有 ChildProcess 对象的 stdin 结束，子进程关闭其 fd 并实际 exit0/close；没有按数字 PID 找/杀进程，没有监听器、模型、npm wrapper 或节点操作。TMP 证据保留。

## 三级解法表

卡点：normal finish 的 run 资源需要独立 OS 关闭引用；现在单 run 没有独立内核范围，整共享 Agent 关闭会影响并行对话。尺子是两轮并行 A/B：A 已读后结束，A 主进程先退但子进程仍持 fd/TCP 时拒闭合；A 精确 scope 空+doc/data/event/远端目标实际收口后可结清 A；B 的 PID、scope、数据连接、调用不中断。最后同 conversation 下一条被实际 admit 且仅执行一次。

| # | 层 | 候选 | 因果/实际可执行方式 | g | h | f | 结论 |
|---|---|---|---|---|---|---|---|
| 1 | 三级 | 共享 Agent 保持现状，逐 run 全量 JS 库存+root 扫 FD/子进程 | 可将 workspace.spawn、每个模型 fetch dispatcher、所有工具资源全部注册；root 枚举共享 PID 的 fd/cgroup。但内核不知道哪个 fd/异步工作属于哪个 run，agent 自报映射不是独立证明。只对子进程开 subcgroup仍漏当前 PID 的模型/socket；要独立证明还须每run隔离执行域 | 2 | 5 | 7 | 反例已否定“只加零计数/扫描”的最短方案；作为诊断保留，不能当前落地闭合 |
| 2 | 三级 | 整 Agent 只在全局空闲时 stop 并取根 slice 空证据 | 可以复用整进程 publisher，但 A 的关闭要等 B；强停则取消不相关成员。若禁止并行或为了关 A 停 B，会改变既定语义 | 2 | 5 | 7 | 剪掉直接用于单run。可用于整实例故障恢复，不能作为普通 finish 默认 |
| 3 | 三级 | root allowlist 固定 worker 槽位，每槽每代只一个 run，独占保持 active 的 slice | worker 本身含模型、工具和全部本地后代；关闭 A 的 slice 不涉及 B。复用 publisher 的原始 OS 双tuple、固定 FD、互斥、耐久和历史机制。新 run 用新进程/RAM key；不迁移旧 grant | 3 | 2 | 5 | 建议实现；至少两个槽验证并行。纯设计，尚未执行 Linux run 实验 |
| 4 | 三级 | 共享监督者持原 RAM key，模型/工具全移到每run子 worker | 能隔离工作子树，但模型/工具若通过监督者代理网络/素材会再次逃出子scope；doc数据连接和key在外，需要跨进程完整引用/出网代理关系；当前factory全部在进程内须拆分 | 4 | 3 | 7 | 可行备选，改动及证明面大于3，不优先 |

未扫空三级，不需要修改二级或一级语义。固定槽位数量仅受既有容量/排队约束，不能拿单槽强制全局串行冒称等价。

内核 `cgroup.events populated` 覆盖后代、不是每个 JS run；systemd control-group stop 作用于整个 unit。这里复用的是这些已验证机制，不把它们扩大为远端效果取消。[Linux cgroup v2](https://www.kernel.org/doc/html/v6.14/admin-guide/cgroup-v2.html)、[systemd v249 KillMode 原始文档](https://raw.githubusercontent.com/systemd/systemd/v249/man/systemd.kill.xml)、[v249 资源控制](https://raw.githubusercontent.com/systemd/systemd/v249/man/systemd.resource-control.xml)。

## 建议路径：固定槽位、一代一轮，完整时序

1. **root 配置有限槽位**。固定 service/unit/UID/控制口/pins、root-owned `/run` 记录目录、唯一 own drop-in 路径；外部 root 互斥。每次新代创建独占 slice（无 sibling/helper，root观察者在外），service 为直接子 cgroup。保留 Restart=no、KillMode=control-group、Delegate=no。不能由 Agent 请求任意 unit/path/PID、不能 live set-property Slice。旧scope未证空/未知boot时该槽不重用，其它槽仍可工作。
2. **注册在正确 OS 里发生**。新 worker 在自己 OS 中创建 RAM key并注册现 instanceAuthority；root 通过固定管理端点真实 TLS identity、kernel MainPID/proc birth/UID/unit invocation/cgroup双读，发布 root 当前代与 doc registration ID/generation/publicKeyDigest 的绑定。不能 supervisor 先 admit 再把其 grant交新 key。既有 authority 的 current()检查目标记录 state/精确 generation，不要求它等于全局最大 generation，故多个 active实例可以并行；新注册本身不替旧实例关闭。
3. **doc 显式接受该槽当前链后才 admit/read**。新增 root scope admission gate 将独立 root 实例和唯一 doc instance 精确绑定；登记 `scopeId→至多一个runGrantId`。第一 run 绑定后该代不能再 admit 第二条，即使第一条已完成；下一轮必须新 OS/key/代。全局队首/权限仍由现真实admit核验，root不是项目权限权威。排队时不提前重做模型。
4. **已有正文 read 与 execution-started 不变**。完整消息/readIntent fsync→doc ACK→模型/工具；所有真实本地调用只在该 worker，不能将 model fetch或 workspace.spawn回代理到共享监督进程。素材/渲染远端作业精确目标入持久 operation/resource inventory，登记及outbox连续头封口，缺任何闭合回执不完整。
5. **先签名、后退出**。worker真实terminal event持久、drain模型/工具/文件/数据完成后，以原 RAM key提交finish记录；doc得到finishReceipt/terminal target并关闭数据库存。root 已预留 `resourceScopeId/closureAttemptId`，doc验证该预留确绑定唯一scope/run后给稳定 witness引用（尚未closed）。当前worker在真正 TLS terminal RPC 上签 drain/target/nonce/exporter，doc验签持久。此时仍不得 complete；不能在worker死后要求它重签。
6. **root独立取证**。root先读取doc已接受的closing target与签名回执引用（不信Agent任意body），同自己的单run scope admission记录核完整binding，固定旧slice/eventsFD/ino，停止准确自有worker或观察其按协议退出。必须原slice仍active且同invocation；主PIDbirthgone但子仍持fd/TCP/pop1是负例；只有原对象pop0+全birthgone/实际对端close、scope独占、无迁移/新任务后，才能文件fsync+rename+目录fsync、publication marker+互斥结束。ENOENT/ENODEV、unitinactive或超时不能充空。
7. **doc导入可信链并内部finalize**。doc只读root-owned链（锁前后、configuredAnchorDigest、完整history、双tuple/独占scope/marker、单代单grant），与自己持久target/Agent回执/doc actual-close/远端库存封口匹配，SQLite同事务写独立 resource witness再调用finalizeFinish。worker已死不需要其query；这是必须新增的root证据导入触发器。HTTP监督者只读队列状态；下一条只有真实结清后由新worker admit。
8. **正常关闭不是取消**。不能调用fenceInstance(stop)将正常run改cancelled再“完成”；需要可信 root terminal-close 状态过渡，在normal finalizer核验原实例与grant后同事务标该一次性worker不可再用。中途private/stop/revoke先提交时，最终只能补对应关闭ACK，不能改回done或释放别人的currentRun。无terminal event的突然崩溃保持unknown/interrupted等待确定证据，不重新执行外部效果。

同证书不同槽位允许多个独立 RAM 实例；当前一个 `controlOrigin` 不足以路由多槽。应由已接受root槽位目录解析 target.instanceId/generation→固定endpoint/pin，逐await重核。不能由请求提供url，也不能由共享监督者终止TLS后把exporter转交worker代签。每条原worker签名要来自其真正TLS socket。

### 可以复用什么，不能复用什么

main的 `asset-root-registry-schema-v2.mjs` 明确 active record.serviceId===asset，anchor/reservation/witness也有asset用途域。**不能原样伪装Agent**，更不能拿现整代asset cgroup关闭记录作为run证据。最小复用是抽出/重用原publisher里的 root-owned文件读取、原子耐久、锁、kernel/proc检查、独占slice固定FD和准确unit/drop-in生命周期；asset原导出/shape/行为保持。

G 63bfc0fa 的root链读取和SQLite checkpoint策略可作为公用root-file/历史校验的固定来源，但现仍分支、依赖v1 primitives，不该整包捎入。需要独立提取既有只读原语和显式Agent用途schema，asset旧读端继续原名/语义。root的单scope以及双epoch实际通过是选型依据，**不是本run协议已通过**。

独立run witness必须额外绑定 root slot/root epoch/root instance（与doc instance分开命名）、完整serviceTuple+closureScopeTuple、doc authority/run/grant/read/finish/outcome/targetDigest、已验Agent receipt digest、root scope admission/封口inventory digest、实际远端closure引用。不能只放root摘要字符串后直接造 `runTerminalResourceClosuresV1`。可信导入器核完整来源后才写当前consumer要的投影，并保持原根链可审计。

## 最短分包与精确申请文件

当前阶段只写报告，不申请立刻跨改。建议root按下列顺序切独占包，不再先扩整套调度：

**第一包：可信单run scope生命周期与导入器。**

- 新 `server/hosted/agent-run-scope-schema.mjs`：明确Agent用途、两个instance命名空间、assignment/active/closing/closed协议与完整binding。
- 新 `server/hosted/deploy/agent-run-scope-publisher.mjs`：仅root配置固定槽位，单run单代，实际OS取证与耐久发布。
- 新共享 `server/hosted/deploy/root-scope-io.mjs`，最窄修改既有 `asset-root-registry-publisher.mjs` 将已验原语抽出再原样调用；原asset测试必须全部保留。若root倾向暂不抽出，可以先固定导出准确原语，但不能复制一套逐渐分歧的安全实现。
- 新 `server/hosted/agent-run-scope-reader.mjs`：只读root文件链+显式anchor，独立SQLite checkpoint，拒回退/混配/锁在场。
- `server/account/agent-instance-authority.mjs`：登记root worker scope绑定、同代只一个grant、正常terminal的最终不可再用状态；旧instance关闭不能被新记录覆盖。
- `server/account/run-authority.mjs`、`server/hosted/doc-agent-assembly.mjs`：admit/read root scope gate、精确实例控制端点路由、导入可信closure后内部finalize（允许已签回执来自刚退出的原worker，不能再要求其在线cap）。

**第二包：真正执行器放进该scope。**

- 新 `server/agent-service/run-worker.mjs`：一OS一RAMkey一run；自身模型/工具/数据；startup只收root固定reservation和doc assignment，不收自由代码/任意PID。
- 新 `server/agent-service/run-worker-supervisor.mjs`：固定槽位调度、元数据唤醒、跟踪root结果；不持worker私钥、不代理模型/工具资源，不代旧worker签名。
- Sol当前 `account-executor-assembly.mjs`、`account-runner.mjs`、`main.mjs`、`account-run-events.mjs`：将factory/终态事件和真实drain放到worker、监督者保留HTTP read control；finish ACK不确定仍原tuple。
- `server/agent/service/run-resources.mjs`、`workspace.mjs`、`server/agent-service/run-data-client.mjs`：登记资源绑定/封口；不再用Boolean childTreeWitness；真实scope引用只读。所有模型网络与spawn留在worker，不能逃逸到共享controller。
- 若实际远端工具仍有脱离run的异步作业，需要明确 `tool-jobs.mjs`/实际相关工具producer的精确闭合引用租约后单独补；这不是把整个asset代际当作它们的完成证明。

**专属验证文件（拟新增，尚无执行源码）：** `server/test/agent-run-scope-*.test.mjs`、`scripts/probes/agent-run-scope-proof.mjs`、`scripts/probes/fixtures/agent-run-scope-worker.mjs`。现阶段不修改旧core/central成功FIFO断言；最后用实际producer完成那些原成功承诺。

## 可交root的Linux一次实验脚本草案

这是接口/流程草案，新增probe尚未实现，**当前不可把下列命令当已有可运行产物**。实现首包后root可一次按冻结闭包执行，不部署生产：

```sh
# root创建唯一自有两槽unit和/run目录；内容来自审过的冻结config，不能接受任意unit。
node scripts/probes/agent-run-scope-proof.mjs \
  --config /run/pc-run-proof-<nonce>/root-config.json \
  --out /var/tmp/pc-run-proof-<nonce>/out --once --deadline-ms 30000
```

配置由root写：两个固定测试service（新随机namespace）、两个UID/控制endpoint/临时pins、每槽ownDropInPath/精确初始fragment摘要、独立slice namespace、root目录/anchor配置、doc独立SQLite与源码闭包。可以同一预授权测试UID开始验证生命周期；UID/密钥隔离不从此实验推论，未经root授权不改系统用户/安全策略。所有端口另租，不把6600段自动搬到Linux。

流程：

1. 全端口空、unit不占用、root/observer在两slice之外；创建两个独占scope，运行两个真实worker，doc接受两条独立root scope并以各自RAM注册admit/read。B持续持有一个真实TCP/文件及其独立run，A启动一个真实后代。
2. A提交实际终态并签closing receipt，doc落盘/关数据；root保持两个旧scope FD。按已验证systemd249方式只stop A自有service：A父退出、子SIGTERM幂等延迟持FD/TCP约2s。必须观察 A birthgone/子live/pop1，此时normalfinalizer仍pending，B实际PID/startTicks/连接不变。
3. A子真实close/exit后，原A scope仍active且原FD读pop0；root耐久witness+marker后doc真UID读入独立SQLite、finalize A，close/reopen仍complete。此时才stop自身空slice。
4. B不变；同对话下一条在新的A epoch/新OS/key中admit一次。原A grant不能由新key重放，原execution-started不得再次模型/工具。每次请求只用本地受控driver，首轮不调用真实模型。
5. 强制三个拒绝点：marker未完成/锁存在；A witness与B target混配；scope已空但缺先前Agent terminal签名。全部必须pending。root crash/restart后原记录/inventory不清零。
6. 自有unit/slice按原完整tuple核归属后关闭；日志/SQLite/root链保留；全部自有监听实际关闭；生产四角色PID/NRestarts不变。任何ENODEV/未知或未观察负例按失败，单轮不盲重跑。

先实现并验这个最小本地执行范围，再接真实runner和远端任务闭合。不能用这个OS实验声称模型API服务远端计算已撤销或asset后台任务已结束。

## Linux首包之后的Doc/worker共同接线契约（设计，尚未实现）

根已实际验证fc47062e首包两槽10/10；具体原始证据在producer报告。上面的早期命令/业务联验是当时草案，不是该次实跑范围；当前可信输出必须在`/run/<namespace>/out`，不能放world-writable `/var/tmp`祖先下。以下为根裁定的三级实施接口，非用户逐字段批准。

**准入。** master只选择root配置的slotId及固定端点/证书，不代worker持有或转移grant。worker用每次OS启动独立RAM key登记，Doc从实际持久消息与实时权限准入；同事务形成`assigned-unbound`和现有scope assignment完整target。root核Doc签名并耐久bind后，Doc通过可信reader核同slot/epoch/recordDigest/assignmentDigest/instance/gen/publicKeyDigest，才能confirmRead及执行。此状态只是执行门，不能另复制ACL或覆盖shared-retained例外。不同conversation可用不同槽并行，同conversation下一条仍等原FIFO结清。

**正常终态的三段协议。** c705旧prepare要求resourceWitnessId，而root close先需要Doc terminal与原RAM intent，形成顺序环，必须替换而非伪填引用。原worker在存活时flush真实terminal事件并完成本机drain，签独立`promptcut.agent-run.prepare.v1`域，payload精确绑定`scope:{authorityId,slotId,epoch,recordDigest,assignmentDigest}`、完整assignment target、`readReceiptId/finishReceiptId/outcomeDigest/eventId/eventDigest/drainReceiptId/docControlId/docFenceRevision`。该声明不含closed布尔、不证明OS空。Doc核原RAM签名及当前ledger，把prepare receipt与实际read/data关闭receipt持久化，再签现有scope terminal，其`terminalReceiptDigest`绑定此不可变prepare receipt。worker核terminal后以同RAM签现有scope intent，root耐久存储后才stop。死后Doc只读root完整链、marker/lock/双tuple证据，导入可信投影并同事务核finalizer；不向已死worker求key，不让supervisor重签。Sol已确认可以拆`scopePrepareFor(payload)`与`scopeIntentFor({assignment,terminal})`，不导出自由sign。

**强制终止独立类型。** stop/private/kick/password已持久fence或受信异常退出判据，由Doc从已持久assignment/grant签typed forced terminal，明确fence id/revision/digest与完整target；不得补原RAM intent或记正常done。异常无终态且尚无可信强制授权时仍pending。root固定旧scope FD与bound记录：旧MainPID已消失但子仍在原固定组，可在service Invocation/已加载unit配置/旧scope归属一致、无替代MainPID的前提下stop精确自有unit并等原FD真pop0；新MainPID、cgroup/Invocation改变或归属不明保锁拒绝。Doc只有导入真实forced closed且重核当前fence后才结清原FIFO，保留failed/interrupted实际原因，不把强制中止显示成功。

**未分配退役独立类型。** ready失败且从未admit/bind的槽，由root按不可变ready记录与单槽互斥确认无assignment后执行typed unassigned retire，只记槽生命周期，不创建任务终态或释放别人的FIFO。bind与retire共用root锁，Doc尚未确认bound的grant只能由精确失败对账收口，不能新实例空库存替代旧证据。

**下一包拟租约（待root分配）。** Doc侧`run-authority.mjs`、`agent-instance-authority.mjs`、`run-internal.mjs`、`doc-agent-assembly.mjs`及新`agent-run-scope-doc.mjs`/专属测试：唯一Doc签发与rootreader导入入口；从root指定干净共同基点独立提交，不盲合含c705的本分支。scope schema/publisher/reader及OS probe的forced/unassigned增量须另明确租约，保持normal类型原义。Sol持worker/master、session/run-client的RAM签名消费者和实际事件/drain实现，双方不同时写。实际producer/consumer/Doc SQLite及Linux probe须配对验：A父退子仍持资源时pending/B保持；正常或forced原FD空且marker耐久后才释放A的原FIFO；missing prepare的normal、混target、新实例替代、锁/缺marker与重启回退全拒。当前只完成设计，未更改runtime或启动新实验。
