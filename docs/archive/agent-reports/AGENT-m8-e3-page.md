# AGENT-m8-e3-page 报告

分支 `claude/m8-e3-page`，worktree `.worktrees/m8-e3-page`，从 main `29e6e837` 建。端口段：本机替身 `--role all` 的 5740～5749（托管组合与协调口用端口 0）。

任务：M8 端到端探针 `scripts/probes/m8-e-probe.mjs` 的 e3 用例原来只判了 C2 判据的前几条，本分支补上 M8 报告第 7 节 C2 判据里的「在线页面恢复同步、重启前最后一次提交可读」。

代号：
- **M8**：分布式预渲染队列任务书的「多端物理联调」阶段。
- **E3**：任务书第 6 节的端到端用例「文档服务重启」。
- **C2 / C4**：C2 是放云端时重启托管组合；C4 是放本机时重启 PC 的局域网主机编辑器。
- **J-恰一**：共用判据「每个任务恰好一次 `task.done`」。
- **G0**：基线，即类型检查加全量测试。

## 1. 做了什么

改了三个文件，都在清单内：`scripts/probes/m8-e-probe.mjs`、`scripts/probes/m8/lib.mjs`、`server/test/m8-kit.test.mjs`。生产代码一行没动。

- **页面副本（`openReplica`，e4 与 e3 共用）**
  - 加了 `history` 选项（e3 用）：每次重读、每应用一版，都记下 `{ rev, digest, session, via, at }`。其中 `session` 是第几个新会话，0 表示最初那个。另外记会话结束的次数与时刻，并把 `ep` 交出去。
  - 新会话建成（`onOpen`）后重读；重读失败就隔 1 s 再试，直到这个会话又断开。原来只试一次，服务刚起、还没就绪时会漏掉。
  - e4 的用法不变：不带 `history`，行为和以前一样。
- **creator（`caseE3`）**
  1. 用例开始时，以创建者、`page` 角色的连接建一份单独的项目真身 `m8e3-<run>`（根设为 `{ page: {} }`），写 KV `signal.e3.doc`。
  2. 重启时机到了以后，先以 `page` 角色写一条无害字段 `/page/lastCommit = <run>-<随机>`，再 `project.open` 读回这一版的 rev 与摘要，组成 `lastCommit: { docId, rev, digest, path, value, opRev }`，放进 `signal.restart.request`。
     - 放云端：原信号加上这个字段。
     - 放本机：结束编辑器进程之前也写这个信号，只是不带远端命令。
  3. 汇总时，对每台主机加两条检查 `page-resync-after-restart-<host>`、`last-commit-readable-<host>`，取的是主机结果里 `e3.page` 的判定，纳入 ok。
- **host（新增 `hostE3Page`，与 `hostE3` 并行）**
  1. 收到 `signal.e3.doc` 就开成员、`page` 角色的副本（带历史）。
  2. 收到 `restart.request` 时，记下副本的 rev（revBefore）与会话序号。
  3. 等到 `signal.restarted`，再最多等 120 s，要求三件事都成立：
     - 副本在新会话里真的完成过 `project.open`；
     - rev ≥ lastCommit.rev；
     - 重启之后见到的那一版，摘要等于 lastCommit.digest。
  4. 判两条：`page-resync-after-restart`、`last-commit-readable`。结果行写 `e3.page { revBefore, revAfter, lastCommitRev, digestMatch, digestAfter, digestWant, reconnectMs, reopens, sessionsAfter, reopenedSessions, closes, applied }`。
  5. `reconnectMs` 从连接层最后一次脱开（取不到就用会话结束）算到新会话重读完成，包括服务停机的那段时间。
- **判定写成纯函数**：`m8/lib.mjs` 新增 `judgeLastCommit(lastCommit, page)`。
  - 重启之后见到了 lastCommit.rev 那一版，就比摘要。
  - 重启后又有写入、没见到那一版时，退回核对那次提交写下的值还在（`via: 'value'`）。本用例重启后没有别的写入，实际走的都是摘要比对。
  - 单测 M8K-20 覆盖：正常、没重读、摘要不符、服务丢了这次提交、重启后又有写入（值对与值不对）、缺信号。
- **文件头**：「用例」e3 一段补了这条判据的说明；KV 键表加了 `signal.e3.doc`，并注明 `restart.request` 带 `lastCommit`。

中途修过一处（提交 `cc733a4e`）：判「重启后重读过」原来数的是新会话建成的次数。故意坏的自检（见 2.3）暴露出一个漏洞：会话建成了、但没重读时，副本还拿着重启前内存里的内容，这条也会过。现在改为只数新会话里真的完成了 `project.open` 的次数（`reopenedSessions`）。

## 2. 验证

### 2.1 本机替身，放云端（C2）

命令：`node scripts/probes/m8-e-probe.mjs --role all --case e3 --place cloud --clips 3 --seconds 10 --timeout-min 25`

最终代码跑的那一次（run `mul9i8qs6b56`）：退出码 0，ok 为真，35 条检查，0 条失败，用时 507 s。与本任务有关的几条：

```
creator:page-last-commit PASS                  rev 2
creator:epoch-changed PASS
creator:J-exactly-once-per-epoch PASS          total 16
creator:no-rerender-of-done PASS               doneBeforeRestart 5, rerendered []
creator:page-resync-after-restart-host-a PASS  {"revBefore":2,"revAfter":2,"lastCommitRev":2,"digestMatch":true,"digestAfter":"9bac86809aa7fdc6","digestWant":"9bac86809aa7fdc6","reconnectMs":1459,"reopens":1,"sessionsAfter":1,"reopenedSessions":1,"closes":1}
creator:last-commit-readable-host-a PASS       （同上）
host-a:page-resync-after-restart PASS          {"sessionsAfter":1,"rev":2,"want":2}
host-a:last-commit-readable PASS               {"via":"digest","rev":2,"digestMatch":true,"seen":1}
```

修正前的代码也跑过一次（run `mul8dyheb5a1`）：ok 为真，35 条检查，0 条失败，reconnectMs 1573。

### 2.2 本机替身，放本机（C4）

命令：`node scripts/probes/m8-e-probe.mjs --role all --case e3 --place lan --clips 3 --seconds 10 --timeout-min 25`

最终代码跑的那一次（run `mul9t3reb8d2`）：退出码 0，ok 为真，37 条检查，0 条失败，用时 604 s。

```
creator:endpoint-reannounced-host-a PASS
creator:page-resync-after-restart-host-a PASS  {"revBefore":2,"revAfter":2,"lastCommitRev":2,"digestMatch":true,"digestAfter":"c4943082d14abf7c","digestWant":"c4943082d14abf7c","reconnectMs":8528,"reopens":1,"sessionsAfter":1,"reopenedSessions":1,"closes":1}
creator:last-commit-readable-host-a PASS       （同上）
creator:cloud-untouched PASS                   before 1, after 1
host-a:page-resync-after-restart PASS / host-a:last-commit-readable PASS (via digest)
```

修正前的代码也跑过一次（run `mul8sjqa3aef`）：ok 为真，37 条检查，0 条失败，reconnectMs 4338。

C4 的 reconnectMs（4～8.5 s）比 C2 的（约 1.5 s）长，因为编辑器进程要整个重起。由此也确认局域网主机编辑器里的文档服务会把项目真身落盘：重启后读回的是同一版、同一摘要。

### 2.3 故意坏的自检（改动没提交，跑完已还原）

- **怎么坏的**：在工作区把 `openReplica` 里新会话建成后的 `tryOpen()` 改成 `if (!process.env.M8E_SELFTEST_NO_REOPEN) tryOpen();`，再带 `M8E_SELFTEST_NO_REOPEN=1` 跑放云端那条命令（run `mul95tqdb2de`）。
- **结果**：退出码 1，ok 为假。失败的正好是新加的四条，其余 31 条（epoch、J-恰一、不重渲、重连）照常通过：

```
creator:page-resync-after-restart-host-a FAIL  {"resync":false,"readable":false,"synced":false,"revBefore":2,"revAfter":2,"digestMatch":null,"reconnectMs":null,"reopens":0,"sessionsAfter":1,"reopenedSessions":0}
creator:last-commit-readable-host-a FAIL
host-a:page-resync-after-restart FAIL          {"sessionsAfter":0,"rev":2,"want":2}
host-a:last-commit-readable FAIL               {"why":"重启后副本没重读或没追到那一版"}
```

  注意 `sessionsAfter: 1`：新会话确实建成了，只是没重读，副本内存里 rev 仍是 2。这正是 2.3 之前那处修正要堵的漏洞。
- **还原**：用 `git checkout -- scripts/probes/m8-e-probe.mjs` 还原，`grep -c SELFTEST` 为 0。
- 「摘要比对用错的值」这一种坏法由单测 M8K-20 覆盖（`digestMatch: false` 判红），没有另跑一轮探针。

### 2.4 G0

- `npx tsc -b --force`：退出码 0。
- `npm test`（PATH 里加了 ffmpeg）：退出码 0。tests 3779，pass 3777，fail 0，skipped 2。

### 2.5 进程与端口

收尾时 5740～5749 没有监听。本分支起的 node 进程（命令行含 `m8-e3-page` 或 `pc-m8e-`）一个也不剩。没碰任何别的端口段，也没结束任何进程。

## 3. 偏离与待定

1. **「项目」用的是单独的一份项目真身 `m8e3-<run>`，没写队列发布的那个项目。**
   - 做法与 e4（`m8e4-<run>`）相同。
   - 原因：编辑器对队列项目 `m8e-e3-<run>` 用的是 `project.announce` 发号加 M5b 快照，按版本登记摘要。一旦往它上面写 `project.op` 建出真身，announce 与快照的摘要口径就改成以真身为准，会干扰 e3 本身要判的重渲与去重。
   - 协议层面，副本走的是和在线页面同一条路：成员、`page` 角色，`project.open` 加 `project.ops`，新会话重读。
2. **放本机也写 `signal.restart.request`（带 `lastCommit`、`how: 'lan-editor'`，不带 `cmd`）。**
   - 跨机跑 C4 时，如果主会话按键名盯这个信号，要按有没有 `cmd` 区分：没有 `cmd` 就不是要在远端执行的步骤。
   - 本机替身的重启器只在放云端时响应这个信号，不受影响。
3. **「重启后 creator 又写过」的分支只在单测里验证过。**
   - 本用例重启后没有写入，探针里走的都是摘要比对。
   - 如果以后在重启后加写入，`judgeLastCommit` 会退回核对写下的值（`via: 'value'`），这时不再比那一版的摘要：副本重读只拿得到当前版，文档服务不提供按 rev 取历史内容。
4. 跨机实测（阿里云 C2、PC 的局域网主机 C4）按任务要求没做，由主会话安排。
