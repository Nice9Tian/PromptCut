# 任务：云端 Agent 任务槽「领取结果不明」后永久卡死

2026-10-17 写（Claude 主会话）。交给 Antigravity 的 Argon 新会话做。

## 0. 一句话

调度器开了一个任务槽、叫任务进程去文档服务「领取」一条任务，领取请求超时了，而文档服务那边其实**没有**记下这次领取。调度器的现有规则是「不知道文档服务有没有记下，就不退槽，等文档服务签强制终态」；可文档服务没记录，永远不会签，于是这个槽永久卡住。卡住期间它还把对应的对话标成「正在服务」，**这个对话后面的新消息永远派不出去**。

## 1. 背景

### 1.1 涉及的服务（都在生产节点 `root@149.88.94.84`，连法见 `docs/local.md`「新云节点」）

| 服务 | 作用 | 代码 |
|---|---|---|
| `promptcut-doc-v2`（文档服务） | 授权的权威：谁能领哪条任务、授权、终态、强制终态都由它签；账本是 `/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite` | `server/account/run-authority.mjs`、`server/hosted/doc-agent-assembly.mjs` |
| `promptcut-agent`（Agent 主服务，master） | 只做控制、不跑任务的 Agent 身份；替调度器问文档服务「有没有活」（`pending`）和「这个槽该怎么关」（`scopeControl`） | `server/agent-service/` |
| `promptcut-agent-root`（root 调度） | 管 6 个隔离任务槽 `slot-a`～`slot-f`；每一代（epoch）开一个任务进程，一个进程只跑一条任务 | `server/agent-service/account-slot-scheduler.mjs`（调度逻辑）、`account-root-main.mjs`、`account-root-slots.mjs` |
| `promptcut-agent-task-slot-x` | 任务进程（每代一个） | `server/agent-service/account-task-worker*.mjs` |

root 的每个槽的记录在 `/var/lib/promptcut/agent-root/slot-x/`：`epoch-N.json`（开了第 N 代）、`publication-N-ready.json`、`assignment-N.json` + `publication-N-bound.json`（绑定了文档服务签的分配）、`failure-N.json`（主进程没了的失败观察）、`terminal-N.json` / `closure-N.json`（关闭记录）、`current.json`（当前停在哪一代、什么阶段）。

### 1.2 这次是怎么出事的（2026-10-17，时间都是 UTC）

1. 文档服务主线程被账本整段反复解析占满（CPU 100%），所有内部请求都慢到超时。这个根因已由 main `e4924848` 修好并部署（见 `docs/local.md`「新节点 0.7.18 正式部署与清理记录」下的说明）。**本任务不管 CPU 问题。**
2. 13:49:49 调度给对话 `cc-mvcgdjhf-kgjl` 开了 slot-a 第 6 代；13:49:54 任务进程领取（`worker.prepare`）报 `run-client-unavailable`（超时），日志 `slot.prepare.unknown`，随后 `slot.failure-observed`。
3. 13:51:26 给对话 `cc-mvcg81mb-3g9s` 开了 slot-b 第 2 代，同样 `slot.prepare.unknown` → `slot.failure-observed`。
4. 文档服务账本里**没有**这两代的授权（`runGrantsV2` 里查不到，`runGrantsV2` 只在领取成功时才建）。root 的记录里这两代停在 `phase: "ready"`，有 `failure-6.json` / `failure-2.json`，没有 `assignment-*`。
5. 之后调度再也没给这两个对话派过槽：两个槽在调度的内存里是 `failed` 阶段、`conversation` 字段还挂着这两个对话，第 214 行的 `serving` 集合把它们当成「正在服务」跳过了。用户看到的是消息一直「已排队 · 等待执行服务」。
6. 14:18 Claude 主会话重启了 `promptcut-agent-root` 作为应急：重启后 `adopt()` 把两个槽认成 `orphan`（不挂对话），两个对话被派到 slot-c、slot-d，跑起来了。**但 slot-a 第 6 代、slot-b 第 2 代至今仍是孤儿，永久占着，6 个槽里只剩 4 个能用。**

### 1.3 代码里卡在哪

- `server/agent-service/account-slot-scheduler.mjs`
  - `dispatch()` 第 144～155 行：`prepare` 抛错时不退槽（注释写了理由：退了而文档服务其实记下了，那条任务就永远结不清），停主进程、写失败观察，等强制终态。
  - `adopt()` 第 176～183 行：上一个调度进程留下的、没关的一代 → `orphan`，同样只能等强制终态。
  - `tickOnce()` 第 214 行：`serving` 由所有挂着 `conversation` 的槽组成，`failed` 的槽也算。
- `server/account/run-authority.mjs`
  - `reconcileScopeFailures()`（约第 473 行）：只遍历**有授权**（`runGrantsV2` 里有、带 `scopeBinding`）的任务，据失败观察签「进程故障」强制终态。
  - `listScopeControls()`（约第 584 行）：只列 `state === 'revoked'` 的授权。
  - `scopeControl()`（约第 571 行）：要传 `runGrantId`，没有授权就 403。
  - 结论：**没有授权的那一代，文档服务这边没有任何路径会产生「可以关」的指示。**
- 领取请求的请求号是 `dispatch:${slotId}:${epoch}`（`dispatch()` 第 147 行），文档服务那边的领取入口是 `scopeAssignment` / 准备相关的函数（`run-authority.mjs` 约第 539 行起），自己读清楚。

## 2. 要做到什么

1. **能证明「文档服务没有记下这次领取」时，安全地收回这个槽**（退掉这一代、槽回到 idle）。现有的两个孤儿（slot-a 第 6 代、slot-b 第 2 代）也要能走这条路收回。
2. **卡着的槽不再拦住它挂的对话**：领取结果不明期间，这个对话不能永远被当成「正在服务」。
3. 不能引入下面第 3 节任何一种错误。

做法自己定。一个可行的方向（只是参考，先读完代码再判断）：给文档服务加一个由 master 调的口子，按 `rootScopeRef`（或领取请求号 `dispatch:<槽>:<代>`）回答「这一代有没有授权」。没有的话，**在同一个账本事务里**把这个请求号记成「已作废」，之后同一个请求号再到达一律拒绝（409 之类），然后回 `{ unassigned: true }`，调度据此 `retire`。有的话照现有强制终态的路走。

## 3. 边界条件（每一条都要有结论，最好有测试）

1. **领取其实成功了、只是回应丢了**：文档服务有授权、对话的 `currentRunId` 已经指向它。这时绝不能退槽，必须照现有路径等强制终态（这正是原设计不退槽的理由）。
2. **领取请求还在路上**：调度这边超时了，但请求晚到文档服务。调度问「有没有记下」得到「没有」之后，晚到的那个领取必须被拒，不能在槽已经退掉以后又建出一个授权（否则又是一条永远结不清的任务）。「判定没有」和「封住这个请求号」必须是同一个账本事务。
3. **同一个对话被派到别的槽**：放开 `serving` 以后，这个对话可能在旧槽的领取还没定论时又被派到新槽。要保证同一个对话同一时刻只有一条任务（文档服务靠 `currentRunId` 拒 `run-not-ready`，自己确认这一点在新路径下仍然成立），旧槽的晚到领取也不能抢走消息。
4. **问的时候文档服务不可用**（重启中、超时、503）：不退槽，下一轮再问，间隔逐次加长（参考现有 `cooldown` / `rest`），不为它反复开进程。
5. **调度重启**：`orphan` 的槽同样要能问、能收回；重启前后同一代只收一次（root 的 `retire` 对同一代重复调用、或对已关的一代调用，结果要确定）。
6. **root 那一侧认不认**：一代停在 `ready`、已有 `failure-N.json`、没有 `assignment-N` 时，root 的 `retire` 能不能做、会不会因为已有失败观察而拒绝，要读 `account-root-slots.mjs` 确认；需要的话在 root 那边补，但 root 的发布器逐项核对的那些约束（见 `server/hosted/deploy/systemd-promptcut-agent-task.service` 文件头）不能放松。
7. **6 个槽全卡住**：不能让调度永远派不出活；要有测试覆盖。
8. **失败观察写过以后再写**：孤儿被收养时会再写一次失败观察（14:18 日志里有 `slot.failure-observed`），要确认重复写是幂等的。
9. **领取明确失败（`noTask`）的路径不变**：现有 `slot.no-task` → `retire` 的行为不能被改坏。

## 4. 约束

- 规矩照 `AGENTS.md` → `docs/semantics/developer_guide.md` 和 `guide_files/`（`suggested_agent_behavior.md`、`constraints.md`、`multi_agent.md`）。语义优先：先读 `docs/semantics/product/agent.md`、`docs/semantics/mechanism/agent.md`；改动若让用户看得到不同（比如「已排队」多久变「失败」），按二级语义办，先问用户。
- 在 worktree 里做：`.worktrees/<名>`、分支 `gemini/<名>`，早提交勤提交。基于 **main 的最新提交**（至少是 `e4924848`），不要基于 `41b6d335`。
- 基线：`npx tsc -b --force` 零错误；`npm test` 零失败。跑 `npm test` 前要设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`（值在 `docs/local.md`）。
- 已知不稳的测试：`server/test/account-worker-lifecycle.test.mjs` 里「已读之后出了暂时性故障……槽让出来」这一条在改动前的 main 上就会偶发失败（10-17 实测 8 次挂 3 次），断言在第 214 行附近，是测试自己的时序竞争。你的改动碰到调度时序，这条可能更容易或更难挂；**不许为了过而放宽断言**，要改就把时序竞争本身修掉并说明。
- 相关测试从这些看起：`account-slot-scheduler.test.mjs`（受控的槽实现，适合加单元测试）、`account-worker-lifecycle.test.mjs` 和它的 `fixtures/account-worker-lifecycle.mjs`（真进程路径，有 `gates` 可以注入故障）、`agent-run-scope-*.test.mjs`。
- **节点只读**，直到用户同意部署。连节点照 `docs/local.md` 带密钥、`BatchMode=yes`、`ConnectTimeout`，后台命令必须自己会结束。不许动宿主机网络。
- 不合入 main、不部署、不重启节点上的服务，做完先汇报。

## 5. 用户同意部署以后（先汇报，等用户说可以再做）

- 文档服务现在跑的是 `/opt/promptcut-v2/releases/41b6d335-readfix/pc`（`41b6d335` 原样复制、只换了两个文件）。这次如果文档服务和 Agent 两边都要换，就**基于合入后的 main 整体做新的发布目录**，不要再在 `41b6d335-readfix` 上叠文件；Agent 主服务、root、任务槽的单元文件都写死了 `/opt/promptcut-render/releases/41b6d3358438`，任务槽单元文件的 SHA-256 还要抄进 root 的配置（见那份单元模板的文件头），改之前读清楚。
- 部署后把 slot-a 第 6 代、slot-b 第 2 代这两个孤儿收回，确认 6 个槽都可用；再发一条真实消息（用户在 `visuhive.com/editor/` 的项目 `sp_4lcukykm2blylc5lok7za46yu3`，或用户指定的）看它跑完。
- 记得更新 `docs/local.md` 的部署记录。

## 6. 汇报写什么

`docs/reports/AGENT-<分支名>.md`，开工先建、先提交一次。写：做了什么；第 3 节每一条边界的结论和对应的测试名；基线的命令、退出码、条数（直接贴在对话里）；没做成的和原因；对本文或语义的更正建议；需要用户拍板的事（按「白话、带背景、编号列问题、给建议」的写法）。
