# Agent HTTP 历史/SSE 即时撤销闭环

开工基线：`037587670cb6c0cd28379d4ee72d6007821a3b02`，分支`codex/018-agent-immediate-revoke`，沿用根已复用的独占工作区。旧producer/worker与只读提案在原分支冻结并已由根推送。本阶段只解决零run的真实HTTP历史/SSE权限撤销、同实例控制、真实连接关闭与持久完成证明；模型执行器继续未挂，不能拿HTTP闭环充模型资源停止。

规则入口已读AGENTS、developer_guide、suggested_agent_behavior、constraints及verification；遵循account-binding-task既定权限：private owner与creator只读例外、非owner任务停止，kick/退出人的权限撤销和shared已读current run保留相互独立。原只读设计见`77df6f62`报告增量。

租约：新`server/account/agent-read-control.mjs`、`server/agent-service/conversation-control-client.mjs`、`server/agent/service/conversation-transports.mjs`及同前缀专属测试/fixture；既有conversation-authority/conversation-internal/agent-instance-authority/doc-agent-assembly/conversation-policy、agent-service http/conversation-client/run-client/main。account/authority、account-projects现由Sol持有，须把精确patch交根排窗口；account-hosted/combo与account-runner/run-control不写。禁止产品其它范围、节点/full/额外Agent。

计划分块：先确定持久库存/控制/精确实例scope，准备真实SQLite+真实RPC首红；再接Agent同步输出门与actualclose；最后接既有生产工厂和真实ACK防旁路。当前只授权无业务listener纯目标/实现；真实服务counter在固定源码后申请根窗口6600–6619。所有结果按源与首次失败保留；没有通过之前不称小阶段完成。过程环境仅当前进程cuda_Vit/models/silent-preload/canonical PSModulePath。

现有断点：account policy onRevoke为空；SSE fresh access RPC之后仍直接write；普通GET/list不在读库存；doc已有fence只保存complete:false并503；零run实例不在普通run control inventory；旧Agent access ACK仍需强制关联真实关闭控制，完成门不能绕过。新机制先持久pending并封新准入，远端同步关输出后等真实close，最后持久receipt才成功，不延长poll/timeout或自报布尔。

## 已实施的三级机制与范围交接

开工报告提交 `f3b40767`；真实首红夹具固定 `3fa5fcd8263032549ca70c5f2daa6113043e4206`；控制协议与纯模块提交 `7376cd7083c236427c8b62dd7f38657e8c3434d1`；工厂接线及旧 ACK 首红 `4f910cc7`；当前产品和测试固定点 `b11d8f1dee6a7c7d72857d5819c9407af9a314b2`。以下验证不套用至任何后续源码。

根后续明确交接两处窄范围：`authority.mjs` 仅在原 `ackAccessEvent` 同一事务中、cursor 核验后写 ACK 前增加 Agent 持久关闭摘要门；`account-projects.mjs` 仅拒绝 Agent 输入缺少摘要，不能替调用方填 complete。另扩 `agent-instance-session.mjs` 四条精确 conversation control 签名，不导出自由签名函数，不生成第二套 RAM 身份。account-hosted/combo、account-runner/run-control 均未编辑。

| 断点 | 修改前 | 本次最小机制 | 保留边界 |
|---|---|---|---|
| RPC 到输出之间的夹缝 | 真 access RPC 返回 allowed 后，SSE 可继续写已取正文 | 同一实际 HTTP transport 的 ALS 覆盖认证、doc 调用、SSE poll 和 dispatch；写入前同步核本地 fence；收到 control 先同步封输出、abort 和 destroy，再 await | 跨进程通知到达需要传输；private 已落库但资源未收口时仍 pending，不能把其当“切私成功” |
| 零 run 没有库存 | 只有 run grant，正在读历史的 HTTP 不在控制目标中 | doc 同 SQLite 事务重核实际 ACL 与完整 get/list/access，并持久登记 exact instance read handle | 无 run 不等于无 HTTP；旧未知实例不能当空实例 |
| 只有证书不能证明同一 OS | 服务证书可由新 OS 进程复用 | 与现有 runClient 共用 RAM Ed25519 key、登记 instanceId/generation，每个请求签实际 TLS exporter、完整 body、path、独立 operation 和 nonce | 新 OS key 不能关闭旧实例资源；缺旧资源证明继续 pending |
| close 请求被当完成 | destroy/布尔回调不足以证明真实关闭 | 同时观测 response close、socket close、所有 pending dispatch 结束；本机持久 close 记录后，精确签名 close 和 control ACK | 套接字已关、旧 dispatch 尚未结束时禁止 ACK |
| 旧通用 Agent ACK 绕过 | 调用旧 ACK 接口可直接写 complete | 持久 `agentReadControlRequired=true`；内部 finalize 产生固定摘要；原 ACK 事务必须核此摘要 | 其它 service 与未启用该模块的基础夹具保持原形状；有 run 库存而无真实 runner closure 必须 pending |

doc 新模块为 `server/account/agent-read-control.mjs`。同 ledger 持久保存 handles、controls、instances、nonce 与请求幂等关系；四条入口是 `/internal/v2/conversation-controls/{subscribe,open,close,ack}`，分别使用 `conversationControlSubscribe`、`conversationReadOpen`、`conversationReadClose`、`conversationControlAck`。open 原始 delegation 只用于真实账号核验，不写入 SQLite；客户端不能提交自己的 instance 主体。subscribe 连续序号覆盖全局控制历史，掉线封本地输出，重连完整重放。ready 不能把新 OS 变成旧 OS，也不能把未知历史 read handle 变成已关闭。

`conversationReadInState` 在 doc 原提交事务中复核项目、登录和会话权限。列表属于项目级 read，切私控制也能关闭可能含该会话的旧列表响应；owner 和 creator 的既有私有只读规则保持。shared 当前已读 run 的 retained 例外不授予旧人类 HTTP 读取权。

`doc-agent-assembly.mjs` 将 read fence 与原 run fence 组合于同一事务；先发控制、同步安装已有 doc fence，再等待实际收口。只在控制确有关闭回执且 run 库存为空时完成零 run 阶段。若原 run control 中存在 instances/revoked/retained，内部 finalize 明确返回 `agent-run-closure-pending`；本包没有把它们算 closed。生产 `main.mjs` 接同一 runClient 与新的控制客户端，但现有模型执行器依旧未挂；运行日志与测试都保持 `executorMounted:false`。

## 首次反例、修后结果与原始记录

所有日志在系统 TEMP，以本报告所列 basename 保留；未覆盖首红。每次命令都仅在子进程环境使用约定 Python、模型目录、silent preload 与规范 PSModulePath，没有安装或改全局环境。npm 使用既有 test-suite wrapper，包含原 guard setup/teardown，不能称 npm 全过程无监听。

| 源码 | 命令/证据 | 首次结果 |
|---|---|---|
| `3fa5fcd8` | `npm test -- server/test/agent-read-control-transport.test.mjs`；`pc-agent-read-control-race-red-1.log`、`.exit.json` | 1 test / 0 pass / 1 fail / 0 skip / 0 cancelled；1111.7525 ms；wall 2161 ms；exit 1；native retry 0 |
| `7376cd70` | `npm test -- server/test/agent-read-control.test.mjs`；`pc-agent-read-control-pure-1.log` | 6 / 6 pass / 0 fail / 0 skip / 0 cancelled；163.4585 ms；exit 0 |
| `4f910cc7` | 同纯目标；`pc-agent-read-control-ack-red-1.log` | 7 / 6 pass / 1 fail / 0 skip / 0 cancelled；184.794 ms；exit 1；native retry 0 |
| `b11d8f1d` | 同纯目标；`pc-agent-read-control-pure-2.log` | 8 / 8 pass / 0 fail / 0 skip / 0 cancelled；202.6126 ms；exit 0 |
| `b11d8f1d` | `tsc -b --force`；`pc-agent-read-control-types-1.log` | 0 错误；wall 7709 ms；exit 0 |
| `b11d8f1d` | 获根单次 6600/6601 窗口后，真实 transport 同目标；`pc-agent-read-control-transport-green-1.log`、`.exit.json` | 1 / 1 pass / 0 fail / 0 skip / 0 cancelled；1057.3271 ms；wall 1323 ms；exit 0；native retry 0 |

真实首红不是 mock allow：测试通过实际 doc pinned mTLS RPC 和真实 SQLite conversation ACL 取得 allowed，然后暂停返回后续处理；另一真实动作把会话改为 private，旧 onFence 仍返回 503/pending。放行旧回调后正文 sentinel 泄漏，原诊断为 `actualDocRpc:true,realSqlitePrivate:true,actualAllowed:true,leakedSentinel:true,executorMounted:false`。它证明 pending 期间的旧结果输出夹缝，不声称 private 成功响应后才开始泄漏，也不声称真实 VH 签发器已联验。

第二个首红使用真实 authority/SQLite：required 已持久，但旧 Agent ACK 在没有内部关闭摘要时被接受，断言报告 Missing expected exception。守门补丁只在原 ACK 事务加入检查，没有更改其它 service 的权限；纯修后测试还打开第二个 SQLite 连接、缺 read 模块时重新调用旧 ACK，仍拒绝。

修后真实 transport 诊断为 `actualDocRpc:true,realSqlitePrivate:true,actualAllowed:true,leakedSentinel:false,complete:true,actualCloseBeforeAck:true,executorMounted:false`。保留原 sentinel、真实授权及 private 落库断言，额外故意保留未结束的旧 dispatch：客户端已观察连接 close 时 private Promise 仍不得完成；放行旧 dispatch 后才得到关闭回执和完成。这个结果包含真实 TLS/socket/exporter、实际注册 RAM key、真实持久 read inventory 与 HTTP socket 生命周期；账号发行器是受控夹具，没有冒称完整 VH/公网/实际模型执行。

8 条纯目标覆盖：零 run 关闭顺序；owner/creator 与项目列表；同证书新 RAM key 不能旧 ACK；断线和 doc 模块重开保库存；完整 body/operation nonce 重放及 changed-request 拒绝；控制幂等/事务 rollback；旧 ACK 与 required 重开；实际非空 run 库存保持 pending。纯签名夹具使用真实 SQLite/Ed25519，但 transport context 是受控注入，与上述真实 mTLS 证据分列。

修后真实目标前后 6600/6601 均零 LISTEN。测试释放 held gate，关闭其实际 HTTP 请求、控制流、run/conversation clients、两台自有 server 与 SQLite 后清自己的 TEMP 目录；测试进程自然 exit 0，没有使用旧数字 PID 或全局 kill。证书生成子进程采用 windowsHide。未运行 full、业务浏览器探针、节点部署或用户服务。本产品源码运行期间不变，结束 `git status --short` 为空、`git diff --check` 通过。该端口窗口已向根释放。

## 受影响消费者：只读交接，尚未迁移或运行

根要求先列清单、逐文件再分配租约，本报告不修改下表文件。

| 文件 | 已核接缝 | 必需最小迁移 |
|---|---|---|
| `server/test/fixtures/cloud-queue-user-path.mjs:271` | 真实 combo 与 Agent HTTP，只建 conversationClient | 同现 pinned TLS 建一个 runClient 与控制客户端，attach 后真实注册/订阅 ready；用 own TEMP receiptFile；清理先 await control.close |
| `server/test/fixtures/account-conversation-controls-user-path.mjs:273`（Luna 固定 `303c7abadeb38301e88d5dacda1404379d400038`） | 同上，新 UI 夹具仍缺控制消费者 | 相同接法；不提前修改其在途小阶段或源 |
| `server/test/account-assembly-central.test.mjs:247` | 真实 assembly 直接调用旧 `conversations/get` | 保留正文断言，改由同已注册实例的实际 owned HTTP read/control 路径读取；不能关闭 requireReadControl |
| `server/test/agent-access-http.test.mjs:84` | standalone doc 虽无 assembly，公开端仍是 accountMode HTTP | doc 同 ledger 配实际 instance 注册/control handler；Agent 同一 RAM key 控制客户端；原自由 onFence ACK 换真实关闭；保留双账号/只读/重放断言 |
| `server/test/cloud-queue-http.test.mjs` | 原纯 Readable/Writable 与受控 doc RPC 没有真实 socket 身份 | 不添加 fake readTransports；安全缺失应 503。原 queue snapshot/去重/撤销断言迁到真实安全夹具或受租独立目标，不能删除 |

最小消费者代码形状（配置值取夹具现有证书与 pin，不新增身份）：

```js
const options = { origin: existingDocInternalOrigin, tls: existingAgentTls,
  serverFingerprint256: existingDocPin };
const runClient = createRunClient(options); // 若已有执行器，必须复用它
const readControl = createConversationControlClient({ ...options, runClient,
  receiptFile: path.join(ownTemporaryDirectory, 'agent-read.sqlite') });
conversationClient.useReadControl(readControl);
await runClient.registerInstance();
await readControl.start();
// 等真实 subscribe ready（describe().connected），然后才发普通页面读取。
// 清理：await readControl.close()，再关闭 HTTP/doc 和其它自有 clients。
```

单独使用 conversationAuthority 的 `agent-access-conversation.test.mjs`、只做 run/instance 的 runner scope/read/control 夹具，不经过新 accountMode 历史 HTTP 与 requireReadControl assembly，可以保留原 foundation 形状；它们不提供本次关闭证据。原 LAN 不变。本文清单是静态兼容性审读，没有用未跑测试的结果宣称这些消费者已通过。

## 待根裁定的旧库存读取边界

本次 ACK 门验证的是 required 持久之后的新写入。只读复核发现：`authority.mjs` 的 `revocationStatus` 仍直接返回已存在的 accessAcks，`flushAccountAcknowledgements` 消费该结果，assembly 的 `completeReadAccessEvents` 遇已有 Agent ACK 即跳过。因此若启用 required 之前数据库已有未完成 barrier 的 legacy ACK，该旧行尚未通过新摘要门重新核验。当前没有执行这个迁移场景的反例，也没有声称生产已发生；已向根提出精确范围建议：在读取/向 account 发最终回执前重用同一内部闭包判定，或把旧无摘要行保留为历史证据但不当新 complete。当前租约只允许 ackAccessEvent 的窄改，未擅改 status/flush。

本阶段交回独立固定源码与真实首红/首绿；受影响旧消费者迁移、历史 ACK 升级边界、根独立全量和真实 runner 资源关闭仍未完成。本地阶段结果不等于已合 main 或已部署生产。

## 后续授权：旧 ACK 消费门和四个消费者

上述第一阶段报告固定为 `e042f93ceb189316bc712d2fb02fb09fbf5547f0`。根随后准确授权四个旧消费者文件，以及 `authority.mjs` 的 revocationStatus/flush 和 assembly 旧 ACK skip 的窄修；Luna controls 夹具仍归其 owner，本叶未改。原旧行读取风险现在有真实反例与修复，以下增量取代上节“未执行迁移反例”的当前状态，但保留原发现记录。

真实预存 ACK 反例固定 `f6826017`：先通过原 authority API 为实际 account credentials-revoked 事件写入三种服务 ACK；两个分支分别不建 outbox、或真实运行 flush 生成 outbox 后注入账号 ACK 响应丢失。然后初始化真实 readControl 持久 required，关闭 SQLite，再以缺 read 模块的 authority 重开。原源码两分支均返回 `agentPending:false,forwardedAfterRequired:1,pendingEvents:0`。这里 doc/page barrier 是明确无页面、无 operation 的受控依赖；反例没有替 Agent 注入任何关闭证明。

修复 `d2fa8e6f` 抽出唯一同步 `agentReadClosureComplete`，供原 ACK 事务、revocationStatus、flush 创建持久回执与最后网络发送前使用；assembly 通过 `hasAgentReadClosure` 判断已完成，不能遇任意旧行就跳过。旧 accessAcks 原行保留，缺摘要在状态查询中作为 pending；已有 unsent legacy account outbox 也原样保留，不在升级时重写成新证明。只有本次生成且绑定实际内部 closure digest 的 account outbox 可以发送；历史目标证据缺失仍需独立收口/对账，不能由新实例空表自动迁移。已经在升级前发送成功的历史回执不会被本模块伪装为“可撤回”。asset/render 原有 ACK 未变。

消费者先在未迁移源上实际保留首红；没有先放宽 requireReadControl。新的共享夹具 `server/test/agent-read-control-fixture.mjs` 固定 `93ca2bc0`，通过真实 pinned TLS/exporter 注册 RAM key，使用同一实际 SQLite 控制库存。它只把调用测试明确提供的账号/consent 依赖当受控输入，不能作为 VH 生产证明。

最终产品/消费者固定 **`45c47cd51b839daa54469db5c764bd47f2367e09`**：

- cloud-queue-user-path 复用现有 Agent pinned TLS，建唯一生产 runClient，attach 控制客户端、等待实际 ready；清理先实际关闭控制流/HTTP dispatch，再关 clients。此次只完成源码接线，没有运行它的浏览器 probe。
- account-assembly-central 保留原真实注册 RAM 私钥，四路径签名 adapter 仅使用这个既有实例及实际 socket exporter，正文改经自有 5775 HTTP/ALS read；额外证明旧 raw get 被拒。原 WS/LP、run 数据通道、持久历史与重启断言全部保留，未给尚未实现的 run/OS closure 自由 ACK。没有为了读正文注册替代实例。
- agent-access-http 使用真实新控制协议；原双账号、consent、幂等、伪造主体、creator 私有只读与撤销检查保留。切私后的旧 SSE 现在断言真实 transport 终止，不强求安装输出 fence 后再发送一个友好 `access.revoked` 尾事件。
- cloud-queue-http 原纯 Readable/Writable 路径改为明确缺安全 transport 先 503 的负例；原 queue snapshot、独立 revision、位置、去重与 fetched-plaintext 拒绝断言迁到真实 SQLite/doc mTLS/Agent HTTP。真实私有操作取消成员队列，owner 仍可读更新；再真实 kick owner，故意暂停已经取得新增正文的 get 回调，实际关闭后放行也不输出 `must-not-publish`。没有 mock readTransports 或 mock allowed。

assembly 首红还准确暴露一个等待顺序：当真实 run/retained/历史实例库存已经明确本阶段不能完成时，先 await read 的 5 秒边界会撞既有 RPC 5 秒截止，客户端只见 transport unavailable。经根批准，仍先实际 deliver 所有 fence，然后非空 run 库存立即返回原 `agent-fence-pending`；仅零 run 分支等待实际 read close 后成功。没有延长任何超时，也没有把非空库存放行。

| 固定源码 | 原始日志 basename | 结果 |
|---|---|---|
| `f6826017` | `pc-agent-read-legacy-consumer-red-1.log` | 11 / 8 pass / 3 fail / 0 skip/cancel；3138.3 ms；exit 1；native 0。两旧 ACK 消费反例及旧纯 HTTP consumer 分别失败 |
| `d2fa8e6f` | `pc-agent-read-legacy-green-1.log` | 10 / 10 pass / 0 fail/skip/cancel；224.0914 ms；exit 0。两分支均 pending=true、转发 0、pendingEvents=1 |
| `93ca2bc0` | `pc-agent-read-http-consumer-red-1.log` | 1 / 0 pass / 1 fail / 0 skip/cancel；963.3667 ms；exit 1。旧 accountMode HTTP 拒绝后没有 meta，原断言失败 |
| `93ca2bc0` | `pc-agent-read-assembly-consumer-red-1.log` | 3 / 2 pass / 1 fail / 0 skip/cancel；9567.8096 ms；exit 1。真实非空 run 库存等待 read 控制，客户端先超时；尚未到旧 get |
| `45c47cd5` | `pc-agent-read-consumer-types-1.log` | `tsc -b --force`，零错误/exit 0 |
| `45c47cd5` | `pc-agent-read-consumers-green-1.log`、`.exit.json` | 四文件 target：16 / 16 pass / 0 fail/skip/cancel；6464.1351 ms；wall 6726 ms；exit 0；native 0 |

最后四文件命令为 `npm test -- server/test/agent-read-control.test.mjs server/test/cloud-queue-http.test.mjs server/test/agent-access-http.test.mjs server/test/account-assembly-central.test.mjs`。实际 provider/order 显式使用根确认的 VisuHive main **`1b3b0029eddf951225a8a2912597dc46854e9041`**，运行前后 SHA 一致；没有以缺 provider skip 掩盖目标。测试前后 5770–5779、5790/5791、6600–6619 均零 LISTEN。真实 asset 子进程由原 fixture 对自己创建的 ChildProcess 等待 close；新控制与 HTTP 生命周期在清理完成后测试进程自然退出。源码在 target 期间不变，结束 clean，diff-check 通过。

本阶段没有 full、浏览器 UI probe、节点或生产部署。原 b11 的 1/1 实际 race 首绿证据仍独立保留；本轮真实 queue kick 补充了已抓取正文的关闭反例，不能将旧源码结果冒用于新源码。Luna 的新 controls fixture 后续需其 owner 接同协议，根将独立完整验证。真实 runner finish/outcome/resource closure 属根后续独立任务，本叶没有提前接入或把它算完成。

## 下一窄阶段开工：finish outcome provider

根在 `21c97ce0` 之后单独交接 finish provider；实际路径为 `server/account/run-internal.mjs`。租约仅 run-authority、run-internal、agent-instance-session/run-client 的 finish 必要增量、新 run-finish 专属目标；追加 agent-instance-authority 的 finish scope 窄分支。account-runner/create-agent-service/events 由 Sol 独占，不在本叶编辑。

已核旧 provider 的 finish 无条件调用 `finishInState(...state:'done')`，仅有 requestId；instance cap 的 finish scope 也未包含 outcome。根同意本块先持久绑定真实终态报告，关闭未证时继续 pending/FIFO 占用，不能 resolve(donePromise) 就成功。

冻结前协议提案：body 为原 projectId/conversationId/messageId/runId/runGrantId/requestId，加 readReceiptId 与 exact `outcome:{v:1,status:'done'|'failed'|'interrupted',eventId,eventDigest}`。eventDigest 应由执行者从其实际持久终态 row 的规范摘要导出；doc 验证的是精确实例签名绑定与已有 read receipt，不冒称 doc 自己运行模型。未知或 legacy 无 outcome 为安全拒绝；相同 tuple/request/outcome 幂等，异 outcome 冲突。无可信关闭引用先记录 outcome，禁止继续工具/数据写，但不释放 FIFO，不写完成。

下一 finalizer 必须读取同一 doc 权威已核的 exact instance/generation/runGrant 控制回执，以及 doc 实际数据连接关闭证明，绑定本块不可变 finish receipt；本块不提供调用方可传 closed:Boolean 的入口，不另建 OS 权威，也不因 manager.closedRuns 或本机 drain 回调推断旧历史实例已空。真实关闭 producer 尚缺，明确保留 pending。根将 provider 与 Sol 的真实 consumer 配套后验证，不把只有严格新 provider、旧 caller 尚未迁移的中间点独立并入 main。

### finish provider 固定交付

开场约定提交 `2a38ec32`；首红固定 `6e294100`；实现/专属目标固定 **`a87f2a3a75e47cd4fb7a0766c35990d2092e89be`**。本增量产品只动五个文件：run-authority、run-internal、agent-instance-authority 的 finish scope、agent-instance-session 的 finish 签名校验、run-client 的 finish 前置校验；另新增 `server/test/run-finish-outcome.test.mjs`。已转租 Sol 的 main/http 未再改。

HTTP `POST /internal/v2/runs/finish` 的 exact body 为：

```json
{
  "projectId": "原项目", "conversationId": "原对话", "messageId": "原消息",
  "runId": "原run", "runGrantId": "原grant", "requestId": "原幂等请求",
  "readReceiptId": "doc确认读取时的receipt.receiptId",
  "outcome": { "v": 1, "status": "done或failed或interrupted",
    "eventId": "实际持久终态事件ID", "eventDigest": "实际终态row的64位小写hex规范摘要" }
}
```

示例中文值仅说明字段来源；实际引用限 `[A-Za-z0-9_.:-]`、1–256 字符。outcome 四字段精确，不接受 completed/closed/自由附加字段。缺 outcome/readReceiptId 返回 `503 run-outcome-required`；未知 status 返回 `503 run-outcome-unknown`；错误格式 400。共享 `validateRunFinishInput` 同时用于 provider、HTTP、生产客户端和签名端。签名完整请求摘要与 doc RAM invocation scope 都绑定 outcome/readReceiptId，不能只靠外围 HTTP 签名忽略内部 capability。

provider 在实际事务中匹配当前 grant、同 service/kid/instance/generation、完整五元组及原 `runReceiptsV2`；普通 preparing/已 revoked 的 grant 不能借 finish 变成功。当前 read receipt 的 promptDigest 和实例/五元组必须完全一致。记录位于原 account ledger 的 `runFinishReceiptsV2` 和 `runFinishRequestsV2`，没有第二权威数据库。幂等键绑定 instance/generation/runGrant/request；同请求同完整内容返回原结果，变更 outcome 或读取引用为 409，新 request 覆盖已记录终态也 409。

返回保留原 grant 顶层字段，新增 `finishPending:true` 与 `finishReceipt`。receipt 精确包含 v、finishReceiptId、authorityId、五元组、serviceId/serviceKid/instanceId/instanceGeneration、requestId、readReceiptId、outcome、outcomeDigest、requestDigest、recordedAt、authoritySeq、`closureState:'pending'`、`complete:false`。这是**终态报告已记录**，不是成功完成。grant 获得 finishReceiptId 后真实 checkAccess(read/write) 拒绝 `run-finishing`；没有调用 conversation finish hook、没有清 currentRunId、没有释放 FIFO。HTTP 200 的调用方仍必须观察 finishPending，不能当结算成功。

doc 本块验证的是已认证真实实例对终态报告的签名绑定及既有读取证据，不声称 doc 自己重建模型结果。Sol 已说明实际事件是持久 row（含完整 grant/实例绑定及 event）。consumer 应先 await 真 drain/resource/data close，从该 row 导出 eventId/eventDigest 再上报；`handle.done` resolve、旧 readIntent.finished 或 manager.closedRuns 不能生成成功终态。缺真实 terminal 或关闭引用继续 pending。

### finish 首红与验证边界

首红 `pc-run-finish-outcome-red-1.log`：**3 / 0 pass / 3 fail / 0 skip/cancel，148.6914 ms，exit 1，native 0**。三条分别证明旧无 outcome finish 会释放成功；受控 error 事件且 donePromise resolve 仍被旧 provider 写成 done；仅更换已授权 capability 的 outcome，旧内部 scope 未拒绝。事件发射器是明确受控 counter，没有调用模型。真实 provider、SQLite、RAM Ed25519 与 scope 核验均使用产品模块，未以自由 allow 替代。

修后 `pc-run-finish-outcome-green-1.log`：**9 / 9 pass / 0 fail/skip/cancel，289.3673 ms，exit 0，native 0**。覆盖三个显式终态、同请求精确重放/异内容拒绝、缺证据拒绝、错误 read/full binding/新 RAM 实例拒绝、读写封口但 FIFO 不释放、commit 后 ACK 丢失精确重放、原 live RAM key 经新 provider/SQLite 连接读取同持久记录、precommit 事务回滚。

最后两项的故障是有名 failpoint 抛错和 SQLite 新连接，不是实际 OS crash 或真实 TLS；本轮按根限制没有运行 listener/服务。`pc-run-finish-outcome-types-1.log` 类型零错误，exit 0，wall **12104 ms**。所有测试经原 npm wrapper，仍有其固定 guard setup/teardown，未绕开守门。源码在测试期间固定不变，结束 clean/diff-check 通过；未运行 full。

### 下一真实 consumer/finalizer 的精确交接

尚未迁移的真实调用处：`account-runner.mjs` 的两处 slot.finish；`run-authority-core.test.mjs:131` 原无证据 finish 后释放 FIFO；`account-assembly-central.test.mjs:247` 原 signed finish 后 admit 下一轮；`account-assembly-run-internal.test.mjs:85` 原 finish body；agent-runner read/control/ack-recovery 和 agent-instance-data-worker 目标转发旧 manager 协议。这些旧成功预期需要真实终态及后续关闭 producer 配套，不能直接补字面量 done。本叶没有运行它们以制造已知红，也没有删弱原断言；共同 baseline 此刻不宣称通过。

建议后续**仅内部** `finalizeFinishInState(state,{finishReceiptId,controlId,controlReceiptDigest,docClosureDigest})` 接口：引用必须从已有 doc ledger 内重建并验全量绑定，不接受网络 body 的 closed:Boolean；核已确认的同实例/generation/runGrant control receipt、doc 数据连接真实关闭、原 outcome/readReceipt 以及 currentRun/message 未被替换，再在单事务准确映射 done/failed/interrupted 并释放 FIFO。此入口本块没有实现或开放。现有 stop/private control 会取消会话，不能拿它伪装普通成功结算；仍缺正常终态 closing control 的实际 producer、真实 Agent 资源 drain 的可信回执接线以及与 `docRunClosuresV2` 的同目标汇总。根会另给此小块租约。未知旧实例资源仍 pending，不能以新实例零库存或 timeout 补全。

## 正常终态关闭阶段（开工，75ea 后续）

三级机制修改前：finish 只持久记录 outcome/read receipt 并阻止继续读写，既无正常 closing control，也无最终释放 FIFO 的关闭证明；现 stop/private drain 会取消任务，不能替代正常结束。

修改后拟定：finish 同事务建立 kind=terminal 的精确关闭目标，保留原当前 run 和消息 running 状态。目标绑定 authorityId、finishReceiptId、readReceiptId、outcomeDigest、project/conversation/message/run/grant、serviceId/kid、instanceId/generation。独立 queryFinish 使用原 finish 请求全部字段（包括 outcome）和单独签名 scope，幂等查询不得创建新终态或改变原请求。

Doc delivery 先同步阻断目标 grant 的后续数据访问，等待实际连接与正在分派消息退出后，将 docRunClosuresV2 精确库存持久化；在首次 await 之前记录本 docInstanceId 的待关闭库存，重启时新实例空清单不能消除旧实例 pending。正常 terminal 不提交 stop/private operation fence，不将消息标 cancelled。

Agent receiver 独立 prepareTerminalClosure 只查询已真实 drain 的同一运行实例，不能 abort/cancel。回执使用原 RAM Ed25519 key，独立固定域，实际 doc→Agent TLS exporter、当次 nonce、完整 target 和 drain evidence digest 绑定。管理端点仅显式配置回环 HTTPS 和证书 pin；缺配置/资源证明保留 pending。签名证明当前实例回执来源，不自动证明历史 OS 资源已空。

权威内部 finalizer 只能从同账本读取目标、read/outcome、已验实例回执和实际 doc 关闭库存；同事务重核 grant/instance/currentRun，private/stop 先提交不得被终态复活或释放另一个 run。网络无 closed 布尔入口。manager 真实资源/OS 引用尚须与 Sol 消费者协商；未知历史始终 pending，不以 donePromise 或新实例空库存放行。

本轮额外窄租：run-control.mjs 的正常 terminal 分支、agent-instance-session.mjs 的固定域 terminalControlProofFor。原撤销路径保留。可选配置 account.agent.controlOrigin/controlServerFingerprint256；root 管理端点显式配置，生产尚未挂。

### 正常终态阶段冻结结果与接口（源码 c705c12533abad6d7de565912e90c4cd9947ceed）

本块实现正常 terminal 控制、真实 doc 数据关闭、同实例 RAM 签名回执、finish/query 与只读同账本证据的 finalizer。没有挂独立运行资源/OS scope witness producer，因此没有宣称真实 FIFO 已恢复，也没有改旧 FIFO 成功测试为永久 pending。

1. `run-authority.finish` 在记录 outcome 的同一 SQLite 事务写 `runControlsV2`：`kind:'terminal'`，`closing:[runGrantId]`，`revoked/retained/cancelled/operationFences` 为空；target 精确为 `{authorityId,finishReceiptId,projectId,conversationId,messageId,runId,runGrantId,serviceId,serviceKid,instanceId,instanceGeneration,readReceiptId,outcomeDigest}`。`controlId=terminal-control:<target规范摘要>`；`fenceRevision` 为 finish 的权威序号。正常终态不调用取消 hook。
2. 每次真实 Agent 数据握手接受前，同账本 `runDocInstancesV1[runGrantId][docInstanceId]` 登记该 doc 实例；finish 锁定全部既有实例加当前 doc 的 `docInstanceIds`。delivery 首次 await 前持久 closing 库存，真实 `service.fencePrincipals` 的实际 close 结果才变 closed。新 doc 空库存不能填掉旧实例的空缺或 pending。
3. `POST /internal/v2/runs/finish/query` 使用原 finish 完整 body（原 requestId、readReceipt、outcome 和五个目标 ID），独立 `queryFinish` scope；未记录返回 `{recorded:false}`，已记录返回 `{recorded:true,...runGrant,finishPending,finishReceipt}`。原请求重放读取现持久状态；改变 outcome 为 409。不存在网络 finalizer/closed Boolean 路由。
4. Agent 新入口 `POST /internal/v2/agent/terminal-control` 精确 body `{control,nonce}`。必须 doc 证书 pin，receiver 参数增加 `instanceGeneration` 和 `instanceSession:{identity,terminalControlProofFor}`。原 stop/private `drainControl` 保留；terminal 只调用 `manager.prepareTerminalClosure(control)`，不能 abort/cancel。真实 client 转发同一个 RAM session，不创建第二身份。
5. manager 返回精确 drain：`{v:1,drainReceiptId,resourceScopeId,resourceWitnessId,eventId,eventDigest,dispatchesOpen:0,connectionsOpen:0,streamsOpen:0,childrenOpen:0,pendingRegistrations:0,oldInstanceUnknown:false}`。这些字段必须来自其实际终态/资源库存；缺独立引用必须 503。固定签名域 `promptcut.agent-terminal-closure.v1` 绑定 POST/固定路径、authority、完整 target、controlId/fenceRevision、当次 nonce、实际 TLS exporter 的摘要、完整 drain 的规范摘要。只在当前实例公钥与同一 generation 下验；跨 TLS、nonce 或新 OS key 不可复用。
6. doc 可选配置 `account.agent.controlOrigin`（仅显式回环 HTTPS，127.0.0.1 或 ::1）和 `controlServerFingerprint256`；每请求独立 TLS1.3、pin，等待 request/socket 实际 close，回包后再核当前服务 registry。缺配置保持 pending。验过回执仅写 `runTerminalAgentReceiptsV1`，不会产生独立资源证明。

### 独立资源引用交接：只定义消费者，当前无 producer

finalizer 唯一资源来源为同 doc ledger 的 `runTerminalResourceClosuresV1[witnessId]`。网络 terminal receipt 只能引用其 ID，不能写此表；本块没有创建此表的产品路径或测试成功 row。拟由后续真实 root scope observer 经已核验的 publisher/current 注册链写入，必须包含：

- `v:1, source:'root-observed-run-scope-v1', state:'closed', authorityId, witnessId, targetDigest, resourceScopeId`；
- 完整 `projectId,conversationId,messageId,runId,runGrantId,serviceId,serviceKid,instanceId,instanceGeneration,finishReceiptId,readReceiptId,outcomeDigest`；
- `rootAuthorityId,rootEpoch(正整数),rootInstanceId,publicationDigest,closureWitnessDigest`。

`targetDigest` 等于持久 terminal target 摘要；resourceScopeId/witnessId 必须等于当前已验 Agent drain 引用。root publication/closure 引用的实际完整 OS tuple、历史和 marker/lock 验证须由独立 producer 完成，不能只把这些摘要从请求复制入表。当前基底没有 G v2 reader，既有 agentInstancesV2.closure 是整 OS 实例关闭，不是可随意复用的单 run 资源收口；run-resources 的 Boolean childTreeWitness 也不够。本块不造第二个 root 权威、不将签名 counts=0 升级为 OS 证明。

finalizer 同事务重核 grant/read/outcome/instance/currentRun/private、全部 required doc 库存、已验 Agent 回执和上述独立引用；普通 `acknowledgeControl` 拒 terminal，即使其调用方给自由 true verifier 也不能旁路。关闭证明未来齐备后 queueState=done 只表示排队条目结清，同时写消息及 grant 的 `terminalOutcome` 保留真实 done/failed/interrupted。当前无可信 producer，成功完成分支尚未实际联验；UI/事件消费者必须按 outcome.status 展示，不能把 queueState=done 当模型成功。

### 本轮首败、因果验证与实际范围

全部原始文件在系统 TEMP；每次命令使用 process-only cuda_Vit Python、主库 models、绝对 silent preload 与 canonical PSModulePath。npm 使用原 wrapper，未绕 global setup/guards；不能把全过程称为零监听。

| 固定源码/步骤 | 原始日志 | 实际结果 |
|---|---|---|
| e8deeb36 首红 | pc-run-finish-closure-red-1.log | 2 tests，0 pass，2 fail，124.4903 ms，exit1/native0；真实 SQLite/provider，分别缺持久 terminal 控制及内部 finalizer。非实际 TLS 首红 |
| b32dd994 首修后 | pc-run-finish-closure-target-1.log | 14/14，0 fail/skip/cancel/native，1105.4844 ms，exit0；包含真实 TLS/WS/文件 close |
| b369a65c 新重放反例后 | pc-run-finish-closure-target-2.log | 14/14，0 fail/skip/cancel/native，1091.5357 ms，exit0；追加真实跨连接/nonce/新实例拒绝 |
| b369a65c 类型首次尝试 | pc-run-finish-closure-types-not-started.log | 叶内 node_modules/.bin/tsc.cmd 不存在，CommandNotFoundException，编译未启动、无编译退出码；不是类型通过 |
| b369a65c 类型实际运行 | pc-run-finish-closure-types-2.log | 主库绝对 tsc 对本叶配置 `-b --force`，0 错、exit0，7046 ms |
| c705c125 自审补持久 read/旧 doc 库存 | pc-run-finish-closure-target-3.log | 15/15，0 fail/skip/cancel/native，1035.209 ms，exit0 |
| c705c125 最终类型 | pc-run-finish-closure-types-3.log | 0 错、exit0，7541 ms |

目标命令：`npm test -- server/test/run-finish-closure.test.mjs server/test/run-finish-outcome.test.mjs server/test/run-finish-closure-transport.test.mjs`。最终真实 TLS 项 941.4921 ms：真实 doc factory/SQLite/实例注册/admit/read/finish/query；真实产品 DocService 关闭精确一条 WS；正常 terminal 从不调用 cancelling drainControl；实际文件 close 后同 RAM key 签名可核并持久，但刻意不存在独立 root witness，仍 pending/FIFO 占用。新 doc 的实际空 service.close 库存不能证明旧 doc 仍活 WS 已关闭；没有手造 closed row 或 true 回调。账号发行/registry 与 Agent 无子进程 driver 是受控组件，不是 VH 联验、模型调用、生产跨进程/root OS 证明。

测试还保留原 outcome 的 9 项断言（模型 error+donePromise resolve、read/instance/body 绑定、三种终态、ACK 丢失/SQLite 重开、提交前失败），新 generic ACK 绕过、private 竞态、持久 read 消失、query scope/原请求冲突均拒绝。资源 witness 不足没有改成绿色“完成”。

6600/6601 为本轮实际监听；每次 fixture 等 own server/socket close，文件句柄关闭后清本 TMP。最终 Get-NetTCPConnection 检查 6600–6619 零 LISTEN。无 full、浏览器、模型、节点或部署；未改 Sol 的 runner/events/main/http、run-resources/data-client，也未改 core/central 的旧成功 FIFO 断言。那些调用者仍需真实 outcome + 独立资源 producer 配套后迁移，由 root 另授权，不能将本目标代替共同基线。
