# 任务：文档服务的 EACCES、10-08 起没办完的退出续办、余下的空转 CPU

2026-10-17 写（Claude 主会话）。交给 Antigravity 的 Argon 新会话做。先查清原因，再决定改不改；改动要用户同意才合入、部署。

## 0. 背景

生产节点 `root@149.88.94.84`（连法见 `docs/local.md`「新云节点」）上的文档服务 `promptcut-doc-v2` 是账号模式下的授权权威，账本是一整段 JSON，存在 `/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite` 的 `account_authority_state` 表里（读写见 `server/account/ledger.mjs`）。

2026-10-17 它的主线程被「每次读账本都整段解析」占满（CPU 100%），云端 Agent 的任务一开就超时失败。main `e4924848` 修了：账本读缓存 + 修剪已关的 Agent 读取。已部署，文档服务现在跑的是 `/opt/promptcut-v2/releases/41b6d335-readfix/pc`（`41b6d335` 原样复制、只换了 `ledger.mjs`、`agent-read-control.mjs`），CPU 降到约 15%，Agent 能跑了。查的过程中还剩三件没弄清的事，就是本任务。

## 1. 第一件：每到任务绑定或结束的那一刻，冒一次 EACCES

### 现象（时间都是 2026-10-17 UTC）

| 时刻 | root 调度的日志 | 文档服务的日志 | 同一时刻 root 那边发生的事 |
|---|---|---|---|
| 10:18:10 | `scheduler.tick.failed` `EACCES` | — | slot-a 第 3 代关闭（`closure-3.json`、`publication-3-closed.json`） |
| 10:21:06 | 同上 | — | slot-a 第 4 代关闭 |
| 13:48:32 | 同上 | `logout.diagnostic` `EACCES` | slot-a 第 5 代绑定（`assignment-5.json`、`publication-5-bound.json`） |
| 13:48:59 | — | `logout.diagnostic` `EACCES` | slot-a 第 5 代强制关闭 |
| 14:18:51 | `scheduler.tick.failed` `EACCES` | — | slot-d 第 2 代正常关闭 |

root 那条是调度这一轮问 master `pending`、master 问文档服务 `listPendingRuns` 时拿到的错误码；文档服务那条来自退出续办（`server/account/logout-confirmer.mjs` 的 `pass()` → `completeAgent` → `doc-agent-assembly.mjs` 的 `completeAccessEvents` → `run-authority.mjs` 的 `reconcileScopeClosures` → `scopeAuthority.refresh`）。两条路都会去读 root 的记录目录 `/var/lib/promptcut/agent-root/slot-x/`（读的代码从 `server/hosted/agent-run-scope-reader.mjs` 看起）。

### 已知

- 记录目录和里面的文件都是 `root:root`、目录 `0755`、文件 `0644`，文档服务以 `promptcut-doc` 用户跑，平时读得到。
- 文档服务的单元有 `ProtectSystem=strict`，`/var/lib/promptcut/agent-root` 在 `ReadOnlyPaths` 里（`systemctl cat promptcut-doc-v2`）。
- 只在 root **写记录**的那一刻冒，冒一次，下一轮就好了。

### 待验证的猜测（不保证对）

root 写记录用「同目录先写临时文件、落盘、再改名」。如果临时文件刚建出来时权限比 `0644` 紧（`fs.open(tmp, 'wx', mode)` 受 umask 影响，之后才 chmod），而文档服务这时恰好列目录读到了这个临时文件，就会 EACCES。`account-root-main.mjs` 第 83～92 行的 `writeSettings` 是一个写法的例子；槽记录本身由谁写、怎么写，要自己找（`account-root-slots.mjs`、`server/hosted/deploy/agent-run-scope-publisher.mjs` 等）。也可能是别的：比如读的是某个只有 root 能读的锁文件或运行期文件。

### 要做到

1. 拿到证据：确切是哪个系统调用、哪个路径报的 EACCES（节点上 `strace -f -e trace=openat,open,access,statx -p <文档服务 pid>`，在任务绑定或结束的那一刻抓；或者在测试里复现）。
2. 判断影响：只是一轮白跑，还是会让某条任务的结清、某次退出确认被耽误或卡住。
3. 修：让文档服务读记录时不被写到一半的东西绊倒（例如读的一方跳过临时文件，或者写的一方让临时文件从创建起就是最终权限，或者两者都做）；不能放松 root 记录目录「只有 root 能写」的约束。

## 2. 第二件：一条 10-08 的「退出别的设备」一直没办完，每秒重办一遍

### 现象

账本 `barriers` 里有一条一直是 `pending` 的退出：

- `eventId`：`logout_9ca8d423fddcadf9c13d6abf`
- `accessEventId`：`access:doc-node-20261009-037d8e0d-2c1e-495a-b19d-501ffbf49909:4`
- 开始于 2026-10-08 21:31:45 UTC（`timeout.since` = `1791495105572`）
- 已超时并已报给账号服务（`timeout.reported: true`），还差 `doc`、`agent` 两样确认
- 文档服务每次启动都会打一条 `logout.diagnostic` `logout-pending:doc,agent`

退出续办器（`server/account/logout-confirmer.mjs`）每秒跑一遍 `pass()`，这一条永远不齐，所以永远每秒跑一遍。10-17 的 CPU 剖析里退出续办占了约三成（当时主要是因为每次都整段解析账本；修好以后单次便宜了，但仍然每秒在做）。

### 待验证的猜测

- 文档服务那一项要 `transportEvidence(accessEventId)`（`accountRuntime.docTransportEvidence`）。这条访问事件号里带的是 `doc-node-20261009-…` 这个文档服务实例；如果现在的实例拿不出那个旧实例的传输证据，`doc` 这一项就永远齐不了。
- Agent 那一项要「读取都关了、要中止的任务都凭 root 的关闭记录结清了」（`doc-agent-assembly.mjs` 的 `completeReadAccessEvents`、`agent-read-control.mjs` 的 `finalizeAccessEvent`）；10-08 时 Agent 可能还没部署成现在这个样子，所需的控制记录可能根本不存在。
- 这条退出对应的是哪个账号、哪次改密：10-17 已经清理过旧测试账号，生产库只剩用户本人 `9tian`（见 `docs/local.md`）。它可能属于一个已经删掉的测试账号。

### 要做到

1. 查清为什么永远齐不了，给出证据（账本里这条退出、对应访问事件、各服务确认的原样内容，**不要**把登录号、令牌、票据贴进对话或报告，照 `logout-confirmer.mjs` 里调试信息的口径只写事件号、服务名、原因码）。
2. 判断这是「正常设计下就会出现的情况」（以后还会再有）还是「历史遗留的一条脏数据」。
3. **怎么收尾要先问用户**：退出别的设备是用户看得到的功能（网页上显示「正在退出」/失败），改它的判定规则属于二级语义；语义见 `docs/semantics/product/document-service.md`、`docs/semantics/mechanism/document-service.md` 第 51 行附近和 `docs/plan/account-binding-contract.md`「改密、退出动画与延迟撤回」。硬约束：**无论怎么收尾，绝不能把已经作废的登录放回来**（`logout-confirmer.mjs` 文件头写了这一条）。
4. 不论怎么收尾，续办器对「永远齐不了」的那类退出不该每秒重办一辈子：给出间隔逐次加长或别的办法，作为可选改动一起报给用户。
5. 动生产账本（删除或改写这条记录）一律先问用户；要动的话先做备份（照 `docs/local.md` 里 0.7.18 部署时的一致备份做法），在隔离的副本上演练过再动。

## 3. 第三件（可选）：修好以后文档服务空闲时仍有约 15% CPU

- 用 CPU 剖析看剩下的是什么：`kill -USR1 <文档服务 pid>` 会在 `127.0.0.1:9229` 打开调试口（只在本机能连；之后一直开着，直到这个进程下次重启），再用 Chrome DevTools 协议的 `Profiler` 采样几秒。10-17 用过的采样脚本在 Claude 会话的临时目录里，不保证还在；可以自己写一个（连 `http://127.0.0.1:9229/json/list` 拿 WebSocket 地址，`Profiler.enable` → `start` → 等几秒 → `stop`，按函数汇总自身时间和包含时间）。
- 打开调试口之前先跟用户说一声。
- 预期大头是：退出续办每秒一遍（第二件）、调度每 0.5 秒问一次 `listPendingRuns`、每个账本事务仍要整段解析加整段写回（账本现在约 432 KB）。给出数字和建议，不一定要改。

## 4. 约束

- 规矩照 `AGENTS.md` → `docs/semantics/developer_guide.md` 和 `guide_files/`（`suggested_agent_behavior.md`、`constraints.md`、`multi_agent.md`）。语义与代码冲突以语义为准；拿不准属于哪一级按高的办。
- 在 worktree 里做：`.worktrees/<名>`、分支 `gemini/<名>`，基于 **main 的最新提交**（至少是 `e4924848`）。
- 基线：`npx tsc -b --force` 零错误；`npm test` 零失败（先设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，值在 `docs/local.md`）。相关测试从 `account-logout-confirmation.test.mjs`、`account-logout-timeout.test.mjs`、`agent-run-scope-*.test.mjs` 看起。
- **节点上只读**：看日志、查账本（用只读方式打开，例如 `node:sqlite` 的 `{ readOnly: true }`，并以 `promptcut-doc` 用户执行，免得改了文件属主）、`strace` 附着观察都可以；**重启服务、改账本、改单元文件、部署，都先问用户**。连节点照 `docs/local.md` 带密钥、`BatchMode=yes`、`ConnectTimeout`，后台命令必须自己会结束。不许动宿主机网络。
- 和另一个任务「云端 Agent 任务槽卡死」（`docs/plan/cloud-agent-stuck-slot-task.md`）可能同时在做，它会改 `account-slot-scheduler.mjs` 和 `run-authority.mjs` 的领取、强制终态那一块。你改 `run-authority.mjs` 时只动 `reconcileScopeClosures` / 读 root 记录相关的部分，开工前看一眼 `git worktree list` 和对方的分支，避免两边改同一处。
- 不合入 main、不部署，做完先汇报。

## 5. 汇报写什么

`docs/reports/AGENT-<分支名>.md`，开工先建、先提交一次。每一件写：原因（附证据）、影响、改了什么或建议怎么改、对应测试；基线的命令、退出码、条数直接贴在对话里；需要用户拍板的事按「白话、带背景、编号列问题、每条给选项和建议」写。
