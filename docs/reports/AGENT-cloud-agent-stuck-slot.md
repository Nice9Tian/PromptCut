# 报告：云端 Agent 任务槽「领取结果不明」后永久卡死修复（`gemini/cloud-agent-stuck-slot`）

- **日期**：2026-10-18
- **分支**：`gemini/cloud-agent-stuck-slot`（基于 `main` `7c0abadc`，包含 `e4924848`）
- **工作区**：`.worktrees/cloud-agent-stuck-slot`
- **任务书**：[`docs/plan/cloud-agent-stuck-slot-task.md`](../plan/cloud-agent-stuck-slot-task.md)
- **状态**：已完成实现与验证，等待用户审阅决定是否合入 `main` 与部署生产节点

---

## 1. 做了什么

### 1.1 根因复核

当调度器（[`server/agent-service/account-slot-scheduler.mjs`](../../server/agent-service/account-slot-scheduler.mjs)）打开一个任务槽的新一代（epoch）并调用任务进程 `worker.prepare({ projectId, conversationId, requestId: 'dispatch:<slotId>:<epoch>' })` 时：
1. 若 `worker.prepare` 抛错（例如文档服务繁忙或超时返回 `503 run-client-unavailable`），调度器无法单方面判断文档服务是否已在账本里记下这次领取（`runGrantsV2`），因此不能盲目退槽（若盲目退槽而文档服务其实已建出授权，那条任务的 `currentRunId` 将永远无法结清）。
2. 原实现只停掉任务进程主进程并写下失败观察（`failure-N.json`），随后干等文档服务在 `master.pending().scopeControls` 中下发强制终态。但文档服务的 `reconcileScopeFailures()` 与 `listScopeControls()` 只遍历 `runGrantsV2` 中**已有授权**的任务；对于领取请求超时、在文档服务账本中**根本没有建出授权**的那一代（或调度器重启后收养的停在 `phase: "ready"` 且无授权的孤儿槽），文档服务永远不会产生任何 `scopeControls` 条目，导致该槽永久停留在 `failed` / `orphan` 状态。
3. 同时，`tickOnce()` 原先用 `states.filter(s => s.conversation)` 计算正在服务的对话集合 `serving`，把 `failed` 槽上残留的 `conversation` 也算作「正在服务」，导致该对话后续消息永远无法派发到其它空闲槽。

### 1.2 具体改动

1. **文档服务账本与任务范围权威：原子判定「未分配」并封存领取请求号与槽代次**
   - [`server/account/agent-run-scope-doc.mjs`](../../server/account/agent-run-scope-doc.mjs)：
     - 在 `s.agentRunScopesV1` 中维护已作废代次表 `retired`（按 `<rootAuthorityId>:<slotId>:<epoch>` 索引）。
     - 新增 `unassignedControlInState(s, master, input)`：仅允许 `control-only` 主身份调用；核对 `rootScopeRef` 对应的槽代次在 `s.agentRunScopesV1.assignments` 中无分配记录、root 侧已写下失败观察（`p.failure !== null`）且未绑定分配（`p.assignment === null`、阶段为 `ready` 或 `closed`）；在当前账本事务中将该代次记入 `s.agentRunScopesV1.retired`（幂等可重入），并返回 `{ unassigned: true, rootScopeRef, requestId, reason: 'grant-never-admitted' }`。
     - 在 `registrationInState` 与 `assignInState` 中检查 `s.agentRunScopesV1?.retired`：一旦某代次已被封存为 `retired`，任何晚到的实例登记（`challenge` / `register`）或任务分配一律以 `409 run-scope-slot-retired` 拒绝。
   - [`server/account/run-authority.mjs`](../../server/account/run-authority.mjs)：
     - 在账本中维护已作废领取请求表 `s.runAbandonedRequestsV2`。
     - 扩展 `scopeControl(input)` 支持未分配核实入参 `{ rootScopeRef, requestId }`（校验 `requestId === "dispatch:<slotId>:<epoch>"`）：
       - 先调用 `scopeAuthority.refresh(input.rootScopeRef)` 同步 root 侧最新链与 `failure-N.json`。
       - 若账本 `s.runGrantsV2` 中**其实已有**该 `rootScopeRef` 的授权（即边界 1：领取已成功、只是回应丢失），绝不走无授权退槽，而是先经 `reconcileScopeFailures()` 下发 `worker-failed` 强制围栏，再按现有 `controlSourceInState` 路径要求 `docClosed` 完成后才返回控制指令。
       - 若账本 `s.runGrantsV2` 中**确实没有**该 `rootScopeRef` 的授权，则在**同一个 SQLite 账本事务**中调用 `scopeAuthority.unassignedControlInState(s, master, input)` 并把 `requestId` 写入 `s.runAbandonedRequestsV2`，返回 `{ unassigned: true, ... }`。
     - 在 `admit(input)` 事务内外增加 `checkAbandonedInState(s, svc, requestId)`：一旦请求号已被记入 `s.runAbandonedRequestsV2`，任何晚到的 `admit`（包括已在 `verifySender` 异步等待途中、在封存之后才进入账本事务的请求）一律以 `409 run-request-abandoned` 拒绝，绝不在槽退掉后再建出授权或抢走消息。
   - [`server/account/agent-instance-authority.mjs`](../../server/account/agent-instance-authority.mjs)、[`server/account/run-internal.mjs`](../../server/account/run-internal.mjs)、[`server/agent/service/agent-instance-session.mjs`](../../server/agent/service/agent-instance-session.mjs)：
     - 在 `scopeControl`（`/internal/v2/runs/scope/control`）的实例签名（PoP）范围计算与请求体校验中支持 `{ rootScopeRef, requestId }` 形状，与原有的强制终态查询共用同一条受控内部通道（无需改动主服务转发层）。

2. **调度器：释放失败槽挂着的对话占用，并对已写失败观察的未绑定槽向文档服务核实收回**
   - [`server/agent-service/account-slot-scheduler.mjs`](../../server/agent-service/account-slot-scheduler.mjs)：
     - 为每个槽记录 `bound`（是否已在 root 侧完成 `bind(assignment)`；`adopt()` 收养时按 `current.phase === 'bound'` 初始化）。
     - `dispatch()` 中 `worker.prepare` 抛错时：停掉任务进程主进程后将 `slot.phase = 'failed'`、`slot.conversation = null`，并写入失败观察；`stuck()` 时同样清空 `slot.conversation = null`。
     - `tickOnce()` 计算 `serving` 时只统计 `s.conversation && ['opening', 'assigned', 'running'].includes(s.phase)` 的槽，确保失败或卡住的槽不再拦住该对话后续被派往其它空闲槽。
     - `tickOnce()` 在 `master.pending()` 之前快照已完成失败观察的槽集合 `observedBeforePending`；在 `master.pending()` 返回后，对已写下失败观察（`slot.failure === true`）、未绑定分配（`!slot.bound`）且不在 `listed.scopeControls` 中的槽，调用 `closeForced(slot, slot.ref, { rootScopeRef: slot.ref, requestId: "dispatch:<slotId>:<epoch>" }, { backoffKey })` 向文档服务核实。
     - 若文档服务确认 `{ unassigned: true }`，调度器调用 `slot.adapter.retire({ reason: 'assignment-failed' })` 安全收回槽并回到 `idle`；若询问时文档服务不可用（503/超时），不退槽，通过 `rest(backoffKey)` 按指数退避（`pollMs * 2` 起逐次加倍，上限 30 秒）拉长下次询问间隔。

3. **修复 `account-worker-lifecycle.test.mjs` 原有的本机时序竞争**
   - [`server/test/fixtures/account-worker-lifecycle.mjs`](../../server/test/fixtures/account-worker-lifecycle.mjs)、[`server/test/account-worker-lifecycle.test.mjs`](../../server/test/account-worker-lifecycle.test.mjs)：
     - 原测试「已读之后出了暂时性故障……槽让出来」在第 212 行用 `until()`（每 25ms 轮询一次）等待日志出现 `slot.settlement.abandoned`，随后在第 214 行断言此时授权仍为 `active`、`runControlsV2` 为空。但 `slot.settlement.abandoned` 记日志的同时会调用 `kick()` 立即唤醒后台调度器进入下一轮：停进程 → 写 `failure-1.json` → 再 `kick()` → 文档服务 `reconcileScopeFailures()` 将授权改为 `revoked` 并写入 `worker-failed` 控制记录。当机器在 25ms 内跑完这一串动作时，第 214 行就会偶发看到 `revoked`。
     - 在夹具中增加 `holds.observeFailure` 钩子，在该测试等待 `slot.settlement.abandoned` 与 `slot.settlement.abandoned.failing` 期间拉住 `observeFailure` 落盘，验证完第 214 行原样断言（未放宽任何断言条件）后立即放行，彻底消除了 25ms 轮询与后台调度 `kick()` 之间的时序竞争。

---

## 2. 第 3 节每一条边界条件的结论与对应测试

| 编号 | 边界条件 | 结论 | 对应测试 |
|---|---|---|---|
| 1 | **领取其实成功了、只是回应丢了** | 文档服务已有授权（`runGrantsV2`）且对话 `currentRunId` 已指向该任务。无论经 `master.pending()` 的 `reconcileScopeFailures()` 还是经 `scopeControl({ rootScopeRef, requestId })` 询问，文档服务都会识别出已存在的授权，先下 `worker-failed` 强制围栏并要求本侧 `docClosed` 完成（未完成前回 `503 run-scope-doc-closure-pending`，绝不提前退槽），之后才允许 root 退槽/强关并由 `reconcileScopeClosures()` 结清 `currentRunId`。 | 1. `server/test/agent-run-scope-doc.test.mjs`：`领取成功但回应丢失（文档服务已有授权、root 停在 ready）：向 scopeControl 询问未分配时走强制围栏与 docClosed，绝不提前退槽或抹掉 currentRunId`<br>2. `server/test/account-worker-lifecycle.test.mjs`：`领取结果不明：文档服务没有授权时封住请求号并退槽收回、同一条消息在新一代正常做完；已有授权但没拿到分配时走强制围栏结清`<br>3. `server/test/account-slot-scheduler.test.mjs`：`领取的回应不确定、或进程自己没了：不退槽，停主进程、写失败观察，等文档服务的强制终态或未分配确认` |
| 2 | **领取请求还在路上（晚到文档服务）** | 调度器在写下失败观察后调 `scopeControl({ rootScopeRef, requestId })`，文档服务在**同一个 SQLite 账本事务**内确认无授权并将该代次记入 `s.agentRunScopesV1.retired`、将该请求号记入 `s.runAbandonedRequestsV2`。此后才到达或从 `verifySender` 异步等待恢复进入事务的晚到 `admit` 请求，以及晚到的实例登记请求，全部在账本事务中被 `409`（`run-request-abandoned` / `run-scope-slot-retired`）拒绝，不会在退槽后建出孤立授权。 | `server/test/agent-run-scope-doc.test.mjs`：`领取请求还在路上：判定没有授权与封住请求号在同一个账本事务完成，晚到的领取（含已在 verifiedSender 途中）与登记一律 409 拒绝` |
| 3 | **同一个对话被派到别的槽** | 放开 `serving` 后，若旧槽领取其实已成功，文档服务凭 `conversation.currentRunId` 以 `409 run-not-ready` 拒绝新槽领取（新槽走 `noTask` 退槽），保证同一对话同一时刻只有一条任务；若旧槽未成功，新槽顺利领走消息，而旧槽因已写下 `failure-N.json` 及封存请求号，晚到请求被拒，既抢不走当前消息也抢不走后续新消息。 | 1. `server/test/agent-run-scope-doc.test.mjs`：`同一个对话改派新槽（边界 3）：旧槽已成时新槽被 currentRunId 拒 run-not-ready；旧槽未成时新槽领走消息，旧槽晚到请求抢不走当前或后续消息`<br>2. `server/test/account-slot-scheduler.test.mjs`：`领取结果不明且文档服务没有记下授权：写失败观察后向文档服务核实 unassigned 并退槽收回；卡着的槽不再拦住该对话改派别的槽` |
| 4 | **问的时候文档服务不可用（重启中、超时、503）** | `closeForced` 捕获错误后不退槽（槽保持 `failed`，不会变回 `idle` 反复开新进程），并调用 `rest(backoffKey)` 记录槽级退避（从 `pollMs * 2` 起逐次翻倍至 30 秒），退避期内跳过询问，文档服务恢复后正常收回。 | `server/test/account-slot-scheduler.test.mjs`：`领取结果不明且文档服务没有记下授权：写失败观察后向文档服务核实 unassigned 并退槽收回；卡着的槽不再拦住该对话改派别的槽` |
| 5 | **调度重启（`orphan` 槽收回与 `retire` 幂等）** | 调度重启后 `adopt()` 将停在 `ready` 的槽标为 `orphan` 且 `bound = false`；写下失败观察后同样经 `scopeControl` 核实无授权并调用 `retire` 收回（生产节点上 `slot-a` 第 6 代、`slot-b` 第 2 代即走此路径）。root 发布器 `publishAgentScope` 对已 `closed` 的同一代以相同原因重复调用 `retire` 时幂等返回 `{ head, anchorDigest }`；若原因冲突则确定性拒绝（`agent-scope-terminal-conflict`）。 | 1. `server/test/account-slot-scheduler.test.mjs`：`调度重启收养停在 ready 的孤儿槽：写失败观察后向文档服务核实无授权并退槽收回`<br>2. `server/test/account-root-slots.test.mjs`：`孤儿槽（停在 ready、已有 failure-N.json、无 assignment-N）：收养时重复写失败观察完全幂等，核实无授权后安全 retire，对同一代重复 retire 结果确定幂等` |
| 6 | **root 那一侧认不认（`ready` + `failure-N.json` + 无 `assignment-N` 下 `retire`）** | 经核对 [`account-root-slots.mjs`](../../server/agent-service/account-root-slots.mjs)、[`agent-run-scope-publisher.mjs`](../../server/hosted/deploy/agent-run-scope-publisher.mjs) 与 [`agent-run-scope-reader.mjs`](../../server/hosted/agent-run-scope-reader.mjs)：`retire`（`unassigned`）要求 `current.phase === 'ready'` 且 `assignment === null`，并使用 `io.pinRetired`（`allowDeadMain: true`）容许主进程已被 `observeFailure()` 停掉；链校验器允许 `failure-N.json`（`assignmentDigest: null`）与 `unassigned-retirement.v1` 关闭记录并存，无需放松任何发布器安全约束。 | `server/test/account-root-slots.test.mjs`：`孤儿槽（停在 ready、已有 failure-N.json、无 assignment-N）：收养时重复写失败观察完全幂等，核实无授权后安全 retire，对同一代重复 retire 结果确定幂等` |
| 7 | **6 个槽全卡住** | 6 个槽全部因 `prepare` 结果不明进入 `failed`（或全部作为 `ready` 孤儿被收养）时，在下一轮全部经文档服务确认无授权并 `retire` 回到 `idle`，排队的对话随即派发执行，不会死锁。 | 1. `server/test/account-slot-scheduler.test.mjs`：`6 个槽全部因领取结果不明卡住：全部核实无授权后退槽回到 idle，排队任务照常派发执行`<br>2. `server/test/account-worker-lifecycle.test.mjs`：`领取结果不明：文档服务没有授权时封住请求号并退槽收回、同一条消息在新一代正常做完；已有授权但没拿到分配时走强制围栏结清` |
| 8 | **失败观察写过以后再写（幂等性）** | [`agent-run-scope-publisher.mjs`](../../server/hosted/deploy/agent-run-scope-publisher.mjs) 第 135～139 行在 `failure-N.json` 或 `failure-publication-N.json` 已存在时先校验其合法性再直接返回原记录与摘要，不重写文件、不改变时间戳与摘要，文档服务 `refresh` 不会触发 `failure-history-changed`。 | `server/test/account-root-slots.test.mjs`：`孤儿槽（停在 ready、已有 failure-N.json、无 assignment-N）：收养时重复写失败观察完全幂等，核实无授权后安全 retire，对同一代重复 retire 结果确定幂等` |
| 9 | **领取明确失败（`noTask`）的路径不变** | `worker.prepare` 返回 `{ noTask: true }` 时，原样记 `slot.no-task`、对对话做 `rest()` 退避并直接调用 `retire`，不写失败观察。 | 1. `server/test/account-slot-scheduler.test.mjs`：`没领到任务就退掉这一代，同一个对话隔一会儿才再试；文档服务说没绑定的强制终态也按退槽办`<br>2. `server/test/account-worker-lifecycle.test.mjs`：`没领到任务的一代：退掉、槽回收，不占名额；之后的任务照常` |

---

## 3. 基线与验证结果

### 3.1 类型检查与全量测试（`.worktrees/cloud-agent-stuck-slot`）

- **类型检查命令**：
  ```powershell
  npx.cmd tsc -b --force
  ```
  - **退出码**：`0`（零错误）

- **专项测试命令（覆盖全部新增与修改的测试文件，共 5 个文件）**：
  ```powershell
  $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
  $env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
  npm.cmd test -- server/test/account-slot-scheduler.test.mjs server/test/account-root-slots.test.mjs server/test/agent-run-scope-doc.test.mjs server/test/account-assembly-run-internal.test.mjs server/test/account-worker-lifecycle.test.mjs
  ```
  - **退出码**：`0`
  - **条数**：`tests 47`、`pass 47`、`fail 0`、`cancelled 0`、`skipped 0`（耗时 `32836.5851 ms`）

- **全量测试命令**：
  ```powershell
  $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
  $env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
  $env:PROMPTCUT_NO_PORT_FILE="1"
  npm.cmd test
  ```
  - **退出码**：`0`
  - **条数**：`tests 7051`、`pass 7037`、`fail 0`、`cancelled 0`、`skipped 14`、`todo 0`（耗时 `160655.5753 ms`）

- **行尾检查命令**：
  ```powershell
  node C:\Users\admin\Documents\PromptCut\out\main-session-tools\eol-audit.mjs . 7c0abadc HEAD
  ```
  - **结果**：全部分支修改文件均为 `LF → LF 孤立CR 0`（零行尾翻转）

---

## 4. 没做成的与原因

无。任务书第 2 节全部目标与第 3 节全部 9 条边界条件均已完成并覆盖测试。按用户指令，尚未合并 `main`、尚未部署或重启生产节点服务。

---

## 5. 对任务书或语义的更正建议

- [`docs/semantics/mechanism/agent.md`](../semantics/mechanism/agent.md)「账号模式的进程分工」一节目前只写了正常终态与强制终态（用户停止、切私有、踢人、改密退出、进程死了）两条关槽路径，建议在合入 `main` 时顺手补一句：「任务进程在领取阶段失联且文档服务未记下授权时，主服务向文档服务核实并在同一账本事务内作废该次领取请求号后，由 root 按未分配退槽回收。」（属于三级机制描述同步，用户看不出区别。）

---

## 6. 需要用户拍板的事

1. **是否合入 `main` 并部署到生产云节点（`149.88.94.84`）收回两个孤儿槽**
   - **这是什么**：本次修复在分支 `gemini/cloud-agent-stuck-slot` 上完成了代码与测试验证。目前生产节点上 `slot-a`（第 6 代）和 `slot-b`（第 2 代）仍处于未分配孤儿状态占着槽位（6 个槽只剩 4 个可用）。
   - **有哪些选项**：
     - **选项 A（建议）**：同意将 `gemini/cloud-agent-stuck-slot` 合入 `main`，并按任务书第 5 节基于合入后的 `main` 制作新的发布目录，更新文档服务与 Agent 服务（含 root 入口配置与任务槽单元 SHA-256），自动收回 `slot-a` 第 6 代与 `slot-b` 第 2 代，确认 6 个槽全部回到 `idle` 后发一条真实消息验证。
     - **选项 B**：先只合入 `main`，暂不部署节点（等其它分支任务一起打包部署）。
     - **选项 C**：指出需要调整或返工的地方。
