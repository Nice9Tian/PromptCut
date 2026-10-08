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
