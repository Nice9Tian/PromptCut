# 报告：文档服务的 EACCES、10-08 起没办完的退出续办、余下的空转 CPU

- **分支**：`gemini/docservice-eacces-logout`（工作区 `.worktrees/docservice-eacces-logout`）
- **基线提交**：`7c0abadc`（包含 `e4924848`）
- **依据任务书**：`docs/plan/docservice-eacces-logout-task.md`
- **状态**：三项原因均已查清并附实测证据；可由代码直接修复且不改用户可见语义的部分已实现并通过测试；需要用户拍板的部分（10-08 历史脏数据清理、旧 Agent 主进程重启后读取收口规则、是否部署本次修复）已在文末编号列出。

> **术语说明（首次出现）**：
> - **文档服务（`promptcut-doc-v2`）**：生产节点上以系统用户 `promptcut-doc`（UID 996）运行的权威服务，管理项目、操作顺序与账号模式下的授权账本（SQLite 单行 JSON，位于 `/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite`）。
> - **root 调度（`promptcut-agent-root`）**：生产节点上以 `root`（UID 0）运行的进程，管理 6 个隔离任务槽（`slot-a`～`slot-f`），在 `/var/lib/promptcut/agent-root/slot-<x>/` 下写入每一代任务进程的开启、绑定与关闭记录。
> - **发布锁（`.publisher.lock`）**：root 调度在修改某个任务槽记录目录期间创建的互斥锁文件（`/var/lib/promptcut/agent-root/slot-<x>/.publisher.lock`），写完并同步目录后删除。
> - **退出续办器（`logout-confirmer.mjs`）**：文档服务内每秒检查未完成「退出别的设备」事件的后台模块，负责收齐文档、素材、Agent、渲染四项确认后向账号服务（`promptcut-account-v2`，即 VisuHive 账号后端）交回执并申请结束见证（`logout-complete`）。

---

## 1. 第一件：每到任务绑定或结束的那一刻，冒一次 `EACCES`

### 1.1 根因与证据（精确到系统调用与路径）

- **报 `EACCES` 的确切系统调用与路径**：
  - 系统调用：`openat(AT_FDCWD, "/var/lib/promptcut/agent-root/slot-<x>/.publisher.lock", O_RDONLY|O_NOFOLLOW|O_CLOEXEC) = -1 EACCES (Permission denied)`（Node.js `fs.open` 抛出的错误对象为 `{ code: "EACCES", syscall: "open", path: "/var/lib/promptcut/agent-root/slot-<x>/.publisher.lock" }`）。
- **为什么发生（完整调用链）**：
  1. root 调度（以 `root:root` 运行）在执行任务槽的绑定（`bind`）、正常关闭（`close`）、强制关闭（`forced-close`）等事务时，调用 `publishAgentScope`（`server/hosted/deploy/agent-run-scope-publisher.mjs` 第 73 行）获取发布锁 `openPublisherLock(dir)`。
  2. `openPublisherLock`（`server/hosted/deploy/asset-root-registry-publisher.mjs` 第 321 行）原代码以 **`0o600`** 权限创建锁文件：
     ```js
     const filename = path.join(dir, '.publisher.lock'), fd = await fs.open(filename, 'wx', 0o600);
     ```
     因此锁文件在磁盘上的权限是 `-rw------- 1 root root`，在整次发布事务期间（`bind` 约 100～200 毫秒，`close` / `forced-close` 因等待 `systemctl stop` 排空进程组约 200～400 毫秒）一直存在。
  3. 同一时刻，文档服务（以 `promptcut-doc` 用户、UID 996 运行）有两条路径会刷新未结清任务所在槽的 root 记录：
     - root 调度每 0.5 秒调 `master.pending()` → 文档服务 `listPendingRuns` → `runAuthority.reconcileScopeFailures()` 与 `reconcileScopeClosures()` → `scopeAuthority.refresh()`；
     - 文档服务内的退出续办器每秒调 `pass()` → `completeAgent()`（`doc-agent-assembly.mjs` 的 `completeAccessEvents()`）→ `runAuthority.reconcileScopeClosures()` → `scopeAuthority.refresh()`。
  4. `scopeAuthority.refresh()` 调用 `createAgentScopeReader(...).read()` → `inspectAgentScopeSource`（`server/hosted/agent-run-scope-reader.mjs` 第 23、42 行）：
     ```js
     if (await read('.publisher.lock')) failScope('publisher-locked');
     ```
     原设计意图是：若读到 `.publisher.lock` 存在，就抛出 `agent-scope-publisher-locked`；外层 `reconcileScopeFailures()` / `reconcileScopeClosures()`（`server/account/run-authority.mjs` 第 489、533 行）捕获 `/^(agent-scope|run-scope)-/` 后 `continue` 跳过该槽，等下一轮再读。
  5. 但 `createAgentScopeReader` 把所有文件（包括 `.publisher.lock`）都交给了 `rootRead(path.join(registryDir, name), true)`，而 `rootRead` 执行 `fs.open(filename, O_RDONLY | O_NOFOLLOW)`。因为 `.publisher.lock` 是 `root:root` `0600`，`promptcut-doc` 用户调 `openat` 直接被内核拒绝并返回 `EACCES`。`rootRead` 只对 `ENOENT` 返回 `null`，将裸 `EACCES` 原样抛出；`reconcileScopeFailures()` / `reconcileScopeClosures()` 不认裸 `EACCES`，直接向外抛出，导致整次 `listPendingRuns` 或 `completeAccessEvents` 失败。
  6. **为什么只在「绑定」或「关闭」那一刻冒，不在「开启（`start`）」时冒**：因为 `reconcileScopeFailures()` 和 `reconcileScopeClosures()` 只遍历 `runGrantsV2` 里已经有 `scopeBinding` 且尚未 `finished` 的任务授权。任务槽在 `start` 阶段还没有领任务（`admit` 还没发生，账本里没有指向该代的 `scopeBinding`）；只有 `admit` 之后紧接着的 `bind`、以及任务结束时的 `close` / `forced-close` 期间，账本里既有未结清的 `scopeBinding`、磁盘上又正挂着 `0600` 的 `.publisher.lock`。

- **节点实证（日志时刻与磁盘文件落盘时刻逐一吻合，加上 `strace` 复现）**：
  1. 节点上 `/var/lib/promptcut/agent-root/slot-a` 与 `slot-d` 的文件修改时刻（`stat --printf='%n | %y'`）与 2026-10-17 的 6 条 `EACCES` 日志精确对齐：
     - `10:18:10.181Z` `scheduler.tick.failed EACCES`：`slot-a` 第 3 代正在执行 `close`（`terminal-3.json` 写于 `10:18:10.256Z`，`publication-3-closed.json` 写于 `10:18:10.508Z`，解锁于 `.517Z`）。
     - `10:20:23.166Z` `logout.diagnostic EACCES`：`slot-a` 第 4 代正在执行 `bind`（`assignment-4.json` 写于 `10:20:23.257Z`，`publication-4-bound.json` 写于 `10:20:23.265Z`）。
     - `10:21:06.037Z` `scheduler.tick.failed EACCES`：`slot-a` 第 4 代正在执行 `close`（`terminal-4.json` 写于 `10:21:06.050Z`，`publication-4-closed.json` 写于 `10:21:06.310Z`）。
     - `13:48:32.597Z` `scheduler.tick.failed EACCES` 与 `13:48:32.655Z` `logout.diagnostic EACCES`：`slot-a` 第 5 代正在执行 `bind`（`publication-5-bound.json` 写于 `13:48:32.713Z`）。
     - `13:48:59.566Z` `logout.diagnostic EACCES`：`slot-a` 第 5 代正在执行 `forced-close`（`terminal-5.json` 写于 `13:48:59.369Z`，`publication-5-closed.json` 写于 `13:48:59.589Z`）。
     - `14:18:51.016Z` `scheduler.tick.failed EACCES`：`slot-d` 第 2 代正在执行 `close`（`terminal-2.json` 写于 `14:18:51.113Z`，`publication-2-closed.json` 写于 `14:18:51.389Z`）。
  2. 在节点 `/run` 下用 `openPublisherLock`（以 `root`）与 `rootRead`（以 `promptcut-doc` 用户）配合 `strace` 抓到的系统调用：
     ```text
     -rw-------  1 root root   14 Oct 17 14:40 .publisher.lock
     [pid 667765] openat(AT_FDCWD, "/run/pc-eacces-repro.IIzVi7/.publisher.lock", O_RDONLY|O_NOFOLLOW|O_CLOEXEC) = -1 EACCES (Permission denied)
     CAUGHT: {"code":"EACCES","syscall":"open","path":"/run/pc-eacces-repro.IIzVi7/.publisher.lock","message":"EACCES: permission denied, open '/run/pc-eacces-repro.IIzVi7/.publisher.lock'"}
     ```

### 1.2 影响评估

- **不会造成任务永久卡死**，因为 `.publisher.lock` 在 `bind` 或 `close` 完成后（约 100～400 毫秒）即被 `unlink`，下一轮（0.5 秒或 1 秒后）即可正常读到。
- **但会造成同一时刻的跨槽误伤与一轮白跑**：
  1. `reconcileScopeFailures()` 与 `reconcileScopeClosures()` 是顺次遍历所有未结清任务的。当其中一个槽因为正在 `bind` / `close` 抛出裸 `EACCES`（而非预期的 `agent-scope-publisher-locked`）时，循环直接中断，排在它后面的其它槽在这一轮里不会被检查，`listPendingRuns` 直接向调度回 503 `EACCES`，整轮调度 tick 失败。
  2. 退出续办器的 `completeAccessEvents()` 先调 `reconcileScopeClosures()` 再调 `completeReadAccessEvents()`；一旦遇到 `EACCES` 就跳过后面的 `completeReadAccessEvents()`，使正在等待 Agent 确认的退出推迟 1 秒。
  3. 若用户在页面点「停止任务」「转为私有」或「删除对话」（触发 `conversations.onFence` → `reconcileScopeClosures()`）时恰好有**另一个槽**正在 `bind` 或 `close`，`onFence` 会被那个无关槽的 `EACCES` 直接打断报错。

### 1.3 已实施的修复（读写两端同时修，不碰 `run-authority.mjs`）

1. **写端（`server/hosted/deploy/asset-root-registry-publisher.mjs`）**：
   - `openPublisherLock` 创建 `.publisher.lock` 时改用 `0o644` 并显式 `await fd.chmod(0o644)`（`.publisher.lock` 内仅存 `{"pid":...}`，不含任何秘密；属主仍为 `root:root`、权限 `-rw-r--r--`，严格保持「只有 root 能写」的约束）。
   - `writePublisherArtifact` 写临时文件时始终执行 `await fd.chmod(0o644)`，防止受 `umask` 影响产生 `0600` 文件。
2. **读端（`server/hosted/agent-run-scope-reader.mjs`）**：
   - 新增并导出 `readAgentScopeRegistryFile(registryDir, name)`：对 `.publisher.lock` 改用 `fs.lstat` 检查目录项是否存在（存在即回 `{ locked: true }` 触发 `agent-scope-publisher-locked`，`ENOENT` 回 `null`），不再调 `fs.open` 读文件内容（与素材侧 `run-assets-current-registry.mjs` 的 `assertRootAssetPublisherUnlocked` 做法一致）。这样即使磁盘上留有旧代码建的 `0600` 锁文件、或锁文件刚建好还没写完 14 字节，读端也绝不会触发 `EACCES` 或 `publisher-file-untrusted`。
   - 对其它记录文件，若 `rootRead` 在并发改名瞬间检出 `publisher-file-changed`，统一转为 `failScope('source-changed')`（`agent-scope-source-changed`），由外层按并发更新正常跳过。
3. **测试**：在 `server/test/agent-run-scope-core.test.mjs` 新增测试 `publisher lock is world-readable (0o644) and reader checks lock via lstat without opening it or leaking EACCES/publisher-file-changed`，验证通过。

---

## 2. 第二件：一条 10-08 的「退出别的设备」一直没办完，每秒重办一遍

### 2.1 根因与证据（账本与账号库只读核查，已隐去登录号与凭证）

以只读方式（`DatabaseSync(..., { readOnly: true })`）分别在 `promptcut-doc` 与 `visuhive-account` 用户下核查了文档服务账本（`/var/lib/promptcut-v2/doc/docservice/account-v2.sqlite`）和账号服务数据库（`/var/lib/visuhive-account/accounts.db`），这条退出记录的原样结构（登录号已按口径替换为条数）如下：

```json
{
  "barrier": {
    "eventId": "logout_9ca8d423fddcadf9c13d6abf",
    "accountEventSeq": 1,
    "accessEventId": "access:doc-node-20261009-037d8e0d-2c1e-495a-b19d-501ffbf49909:4",
    "accessSeq": 4,
    "loginIds": "<redacted:count=1>",
    "state": "pending",
    "timeout": {
      "since": 1791495105572,
      "at": 1792228977882,
      "waitedMs": 733872309,
      "timeoutMs": 45000,
      "confirmed": ["asset", "render"],
      "pending": ["doc", "agent"],
      "reasons": ["logout-pending:doc,agent"],
      "reported": true
    }
  },
  "accountEvent": {
    "seq": 1,
    "type": "credentials-revoked",
    "eventId": "logout_9ca8d423fddcadf9c13d6abf",
    "accountId": "acc_141f51a33317446926c0f81c",
    "changeSeq": 1,
    "changedAt": 1791495105488
  },
  "serviceAcks": {
    "asset": { "receiptId": "1072a59c-c340-414f-a1cc-3f6494da9482", "cursor": 4, "complete": true },
    "agent": null,
    "render": { "receiptId": "doc-attested:render:access:doc-node-20261009-037d8e0d-2c1e-495a-b19d-501ffbf49909:4", "cursor": 4, "complete": true, "attestedBy": "doc" }
  },
  "readControlsForAccessSeq4": [],
  "readClosureForAccessSeq4": null,
  "runControlsForAccessSeq4": [
    {
      "controlId": "run-control:955b626e72af8287790d995e0228aeaa09928e0e9d0a0afd2c9ae1e551c8f9c6",
      "requestId": "access:access:doc-node-20261009-037d8e0d-2c1e-495a-b19d-501ffbf49909:4",
      "kind": "credential",
      "retained": [],
      "revoked": [],
      "cancelled": [],
      "state": "pending",
      "instances": []
    }
  ]
}
```

这条退出**永远齐不了**有两重直接原因：

1. **第一重（文档服务账本内 `agent` 确认缺失，进而挡住 `doc` 确认）**：
   - 该事件发生在 **2026-10-08 21:31:45 UTC**（`accessSeq: 4`），对应账号 `acc_141f51a33317446926c0f81c`（10-08 上线测试时的测试账号，已在 2026-10-17 清理旧测试账号时从生产库删除）。
   - 2026-10-08 当时节点上还没有挂载 0.7.18 的 `agent-read-control`（`agentReadsV1`）。后来部署 0.7.18 时，`run-authority.mjs` 有 `reconcile(s)` 游标（`runAccessCursorV2`），把历史 `accessEvents`（1～26）补建成了 `runControlsV2`；但 **`agent-read-control.mjs` 没有按 `accessEvents` 补建控制记录的 `reconcile` 逻辑**，因此 `state.agentReadsV1.controls` 里根本没有 `accessSeq === 4` 的记录（只有 `accessSeq: null` 和 `accessSeq: 15` 两条）。
   - 退出续办器每秒调用 `completeReadAccessEvents()`（`server/hosted/doc-agent-assembly.mjs` 第 111～112 行）：
     ```js
     if (runtime.authority.hasAgentReadClosure(event.eventId) ||
         !state.agentReadsV1?.controls.some(c => c.accessSeq === event.seq)) continue;
     ```
     因为 `agentReadsV1.controls` 里没有 `accessSeq === 4`，这里每次都直接 `continue` 跳过，永远不会调 `finalizeAccessEvent` 产生 `agent` 的确认。
   - **为什么 `doc` 也显示在 `pending` 里（`logout-pending:doc,agent`）**：任务书猜测「现在的实例拿不出旧实例的传输证据」，核查代码后确认**不是这个原因**——`account-hosted.mjs` 第 260 行在进程重启后因 `event.seq (4) <= accessHeadAtBind (26)` 会正常返回 `{ kind: 'started-after-revocation', ... }`（且 `docTransportClosuresV2` 里也留有 10-08 旧实例关闭 `conn-4` 的记录）。`doc` 之所以显示未确认，是因为 `authority.mjs` 第 558 行把 `docConfirmed` 定义为「文档服务已将四方汇总回执（`accountAcks['seq:1']`）发给账号服务」，而 `flushAccountAcknowledgements()`（第 606、615 行）在 `agent` 确认到齐之前拒绝生成和发送这份汇总回执。即 **`doc` 只是在等 `agent`**。

2. **第二重（账号服务数据库 `accounts.db` 里的 `password_events` 已无此记录，结束见证 `sealLogout` 也会被拒）**：
   - 在 `/var/lib/visuhive-account/accounts.db` 中，`accounts` 表只剩用户本人 `9tian`（`acc_f17cf0ab2b14547df056b54f`），测试账号 `acc_141f51a33317446926c0f81c` 已被清理：`password_events` 表为 **0 行**，仅 `outbox` 表还留着 `seq = 1, event_id = 'logout_9ca8d423fddcadf9c13d6abf', status = 'pending'`，`logout_reports` 表留着 1 条超时报告。
   - 即便文档服务这边补齐了 `agent` 与 `doc` 的确认，下一步退出续办器调用 `seal(barrier)` 向账号服务请求 `POST /internal/v2/order/logout-complete`（VisuHive `account/password-order.mjs` 第 72～73 行）：
     ```js
     const event = store.passwordEvent(body.eventId);
     if (!event || event.choice !== 'exit') throw orderError('logout-not-selected');
     ```
     因为 `password_events` 里没有 `logout_9ca8d423fddcadf9c13d6abf`，账号服务会一直回 `409 logout-not-selected`。

### 2.2 性质判断：是历史遗留脏数据，还是正常设计下以后还会有？

- **这条 `logout_9ca8d423fddcadf9c13d6abf` 本身属于历史遗留脏数据**：它是 2026-10-08（`agentReadsV1` 上线前）产生的旧测试账号退出事件，且该测试账号在 2026-10-17 清理时已从 `accounts.db` 的 `accounts` 和 `password_events` 中删掉，只剩 `outbox` 和文档服务账本里的半截记录。
- **但正常设计下，还有两种情况也会在未来产生「永远齐不了」的退出**（见文末问题 2）：
  1. **Agent 主服务（`promptcut-agent`，`control-only` 实例）带着打开的读取重启**：当前账本 `agentInstancesV2` 里就有两个 `control-only` 实例（旧实例 `instance_9777a174-...` 与当前实例 `instance_7fb05807-...`，两者的 `hasClosure` 均为 `false`）。如果某个用户正开着对话事件流（SSE，`handle.state === 'open'`）时 `promptcut-agent` 重启，旧 `instanceId` 进程已死、不会再来关那条读取，而 `control-only` 实例又不像任务槽那样有 root 的关闭证明。之后该登录一旦改密退出，`agent-read-control.mjs` 会一直等那个死掉的旧 `instanceId` 回执，永远停在 `read-close-pending`（契约 `docs/plan/account-binding-contract.md` 第 30 行已记此缺口）。
  2. **`agent-read-control.mjs` 缺少对 `accessEvents` 的补建游标**：如果文档服务在未挂载 Agent 组件时收到了作废事件，之后再开启 Agent 组件，`run-authority.mjs` 会补建 `runControlsV2`，但 `agent-read-control.mjs` 不会补建 `agentReadsV1.controls`，导致这类事件在 `completeReadAccessEvents()` 里被永久跳过。

### 2.3 已实施的续办器退避改动

- 在 `server/account/logout-confirmer.mjs` 中新增指数退避（`LOGOUT_CONFIRM_MAX_POLL_MS = 60_000`）：
  - 未超时的退出照常按 `pollMs`（缺省 1 秒）轮询，45 秒超时判定与上报时机分毫不差；
  - 当账本里所有未完成的退出均**已超时且已上报超时**（`barrier.timeout.reported === true`）后，后台定时轮询间隔按 `pollMs * 2^n` 逐次加倍，上限 `maxPollMs`（生产缺省 60 秒，把永久卡住记录的后台空转次数降低 98.3%）；
  - 一旦有新进展调用 `kick()`、直接调 `tick()`，或账本里出现新的未超时退出，退避当场归零，立即恢复每秒轮询。
- 在 `server/test/account-ledger-read-cache.test.mjs` 新增退避与唤醒单元测试，且原集成测试 `account-logout-confirmation.test.mjs`、`account-logout-timeout.test.mjs` 全部通过。

---

## 3. 第三件：修好以后文档服务空闲时仍有约 15% CPU（及新发现的 `nonces` 膨胀泄漏）

### 3.1 实测证据：为什么 14:15 UTC 重启后是 ~15% CPU，而半小时后又涨到了 67%～76% CPU？

遵守「未获授权不开 9229 调试口」的约束，我们在节点上先通过只读核查 `/proc/660480/stat`、`strace -c`、以及对 `account-v2.sqlite` 的只读快照做间隔采样和进程内 `node:inspector` `Profiler` 剖析，抓到了真正的罪魁祸首：

1. **账本在 `e4924848` 部署后仍在以 1.9 MB/小时的速度无限膨胀**：
   - 14:15 UTC 部署 `e4924848` 时，账本从 684 KB 降到了 **432 KB**，CPU 降到约 **15%**。
   - 仅过了 39 分钟（14:54 UTC），生产账本又涨到了 **968,600 字节（968 KB）**，文档服务主线程 CPU 已涨到 **67%～76%**（5 秒内消耗 337 个时钟滴答 = 67% 单核 CPU，5 秒内发生 **12,642 次 `pwrite64`**、**42 次 `fsync`**）。
   - 拆解 968 KB 账本里各字段的大小：
     | 账本字段 | 条目数 | 字节数 | 占比 |
     |---|---:|---:|---:|
     | `agentReadsV1.nonces` | **9,106** | **655,633 B (656 KB)** | **67.7%** |
     | `agentReadsV1.handles` | 112 | 88,088 B | 9.1% |
     | `agentReadsV1.requests` | 112 | 25,985 B | 2.7% |
     | 其余全部字段合计 | — | 198,894 B | 20.5% |
   - **为什么 `agentReadsV1.nonces` 每秒长 7.3 条（每 3 秒净增 22 条、+1,584 字节）**：
     - 用户浏览器开着在线编辑器页面（`visuhive.com/editor/`），页面维持一条对话事件流 `GET /agent/v1/conversations/<id>/events`。
     - `server/agent-service/http.mjs` 第 248 行对该事件流每 **250 毫秒**（每秒 4 次）跑一次 `pollWork()`；每次 `pollWork()` 先在第 197 行调一次 `service.conversation(identity, conversationId, 0)`，紧接着第 198 行 `service.mirrorAccepted(identity, conversationId)` 内部又调一次 `base.conversation(identity, conversationId, 0)`——**一条空闲的 SSE 流每秒向文档服务发 8 次 `POST /internal/v2/conversation-controls/open`**（外加浏览器每 3.5 秒轮询一次 `GET /agent/v1/conversations`）。
     - 每次 `open` 在文档服务 `server/account/agent-read-control.mjs` 第 208 行都会开启一个写事务 `ledger.transaction(...)`，调用 `nonce(state, current, body)` 往 `state.agentReadsV1.nonces` 塞入一条 72 字节的 SHA-256 键。
     - **`e4924848` 的 `pruneClosedReads()` 只修剪了 `t.handles` 和 `t.requests`，漏掉了 `t.nonces`，且 `open()` 路径上也不调修剪**。于是只要浏览器开着一个标签页，每秒就执行约 7.3 次整本账本的 `JSON.parse` + `JSON.stringify` + SQLite 落盘，且每次事务把 `ledger.mjs` 的 `cached` 置为 `null`（让 `e4924848` 加的读缓存每秒失效 7.3 次，下一次 `ledger.read()` 又得重新 `JSON.parse` + `deepFreeze` 整本账本）！

2. **V8 CPU Profiler 采样数据（节点上对生产账本副本做 2 秒剖析）**：
   - 在 968 KB（9,106 条 `nonces`）时：单次 `cached read` 仅需 **0.004 ms**（说明 0.5 秒一次的 `listPendingRuns` 和 1 秒一次的 `logout-confirmer` 纯读账本本身占不到 1% CPU）；但**单次写事务 + 紧随其后的第一次读**耗时高达 **54.98 ms**，按每秒 7.3 次写事务计算仅此一项就占掉 **40.1%～67% CPU**。
   - 按函数自身采样命中占比（Top 5）：
     | 函数 | 位置 | 自身采样占比 | 说明 |
     |---|---|---:|---|
     | `load` | `server/account/ledger.mjs:40` | **49.8%** | `SELECT payload` + 整段 `JSON.parse`（每次事务开头解析一次，事务把 `cached = null` 后下一次 `read()` 又解析一次） |
     | `transaction` | `server/account/ledger.mjs:59` | **24.7%** | 整段 `JSON.stringify(state)` + `structuredClone` |
     | `deepFreeze` | `server/account/ledger.mjs:13` | **11.0%** | 事务后第一次 `read()` 递归冻结整棵对象树 |
     | `exec` / `get` / `run` | `node:sqlite (native)` | **10.9%** | SQLite `BEGIN IMMEDIATE` / `UPDATE` / `COMMIT`（含 WAL 写入与 `fsync`） |
     | `(garbage collector)` | `V8 native` | **2.2%** | 每秒分配与回收十多兆 JSON 字符串与对象树 |
   - 将 `agentReadsV1.nonces` 修剪到 256 条后，账本从 **968 KB** 降回 **331 KB**，单次事务耗时从 **54.98 ms** 降到 **15.95 ms**。

### 3.2 已实施的修复与进一步优化建议

1. **已在本分支实施的两项三级修复（不改变任何外部行为与接口）**：
   - **修剪 `agentReadsV1.nonces`（`server/account/agent-read-control.mjs`）**：导出 `KEEP_READ_CONTROL_NONCES = 256`；在 `pruneClosedReads()` 和 `nonce()` 写入时同步修剪 `t.nonces`，只保留最近 256 条一次性随机数记录，彻底堵住每小时 +1.9 MB 的账本膨胀泄漏。
   - **写事务提交后直接复用内存状态做读缓存（`server/account/ledger.mjs`）**：`transaction(fn)` 在 `db.exec('COMMIT')` 成功后，先 `structuredClone(result)`，再直接将刚提交的 `state` 通过 `cached = deepFreeze(state); cachedVersion = dataVersion.get().data_version;` 设为读缓存，省掉每次写事务后紧跟的那一次全量 `SELECT` + `JSON.parse`（砍掉约一半的 `load()` 开销）。
2. **进一步降低空闲 CPU（从 ~10% 降到 <1%）的可选建议（供用户决定是否做）**：
   - **建议 A（省掉 SSE 每 250ms 的重复 `open` 写事务）**：在 `server/agent-service/http.mjs` 的 `accountEvents`（第 197～198 行）中，`pollWork()` 刚刚拿到了 `view = await service.conversation(identity, conversationId, 0)`，紧接着调 `service.mirrorAccepted(identity, conversationId)` 时可以把刚读到的 `view` 传进去（或只在 `view.messages.length` / `queueRevision` 变化时才镜像），直接砍掉一半的内部请求；更进一步，在 `agent-read-control.mjs` 的 `open()` 中，当同一个长连接 `requestId` 对应的 `readHandle` 已经处于 `open` 状态时，属于长连接内的复核读取，完全无需每秒 8 次重写 SQLite 账本。
   - **建议 B（给 `services.json` 加按毫秒节流的 stat 缓存）**：`doc-agent-assembly.mjs` 第 52 行每次内部请求都调 `serviceRegistry.refresh({ force: true })`，每秒触发十几次同步 `statx("/var/lib/promptcut-v2/doc/secrets/services.json")`。若允许 200～500ms 内复用同一次 `stat`（非强制刷新），可省掉高频同步系统调用。

---

## 4. 基线验证结果

在工作区 `.worktrees/docservice-eacces-logout` 下执行：

1. **类型检查**：
   - 命令：`npx.cmd tsc -b --force`
   - 退出码：`0`（零错误，输出为空）
2. **相关专项测试**：
   - `npm.cmd test -- server/test/agent-run-scope-core.test.mjs server/test/agent-read-control.test.mjs server/test/account-ledger-read-cache.test.mjs server/test/asset-root-registry-publisher.test.mjs`：退出码 `0`；`tests 109, pass 109, fail 0, cancelled 0, skipped 0`（`1425.0306ms`）。
   - `npm.cmd test -- server/test/account-logout-confirmation.test.mjs server/test/account-logout-timeout.test.mjs`：退出码 `0`；`tests 8, pass 8, fail 0, cancelled 0, skipped 0`（`15223.4181ms`）。
3. **全量测试**：
   - 命令：
     ```powershell
     $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
     $env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
     npm.cmd test
     ```
   - 退出码：`0`
   - 汇总输出：
     ```text
     ℹ tests 7045
     ℹ suites 0
     ℹ pass 7031
     ℹ fail 0
     ℹ cancelled 0
     ℹ skipped 14
     ℹ todo 0
     ℹ duration_ms 165646.6134
     ✓ npm test 最终结果：零失败
     NPM_TEST_EXIT_CODE=0
     ```
4. **行尾审计**：
   - 命令：`node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD`
   - 结果：全部修改与新增文件均为 `LF → LF 孤立CR 0`。

---

## 5. 需要用户决定的事项

请对以下 3 件事拍板（详细背景、选项与建议同步列在对话正文中）：

1. **怎么处理生产节点上那条 2026-10-08 遗留的测试账号退出记录（`logout_9ca8d423fddcadf9c13d6abf`）？**
   - **选项 A（推荐）**：作为已删测试账号的历史脏数据做一次性收口清理——先对节点数据库做一致备份并在 `/tmp` 副本演练验证，然后：（1）在文档服务账本 `account-v2.sqlite` 中保留 `revokedLogins` 里的作废记录不动（绝不放回已作废的登录），将 `barriers['event:logout_9ca8d423fddcadf9c13d6abf'].state` 标为 `'complete'`（附注清理原因），并将对应的空任务控制记录 `runControlsV2['run-control:955b626e...'].state` 标为 `'complete'`；（2）在账号服务数据库 `accounts.db` 中将 `outbox` 里 `event_id = 'logout_9ca8d423fddcadf9c13d6abf'` 的 `status` 标为 `'complete'`。
   - **选项 B**：不动生产库里的这条记录，只部署本次「退出续办器指数退避」改动，让它从每秒空转 1 次降为每 60 秒看 1 次。
2. **正常运行时如果 `promptcut-agent`（Agent 主服务）重启、导致它重启前打开的对话读取（SSE 流）没有关闭回执，后续「退出别的设备」怎么收口？**
   - **选项 A（推荐）**：当新的 `control-only`（只做控制的 Agent 主服务）实例登记并连上读取控制流（`subscribe`）时，由于生产节点上 `promptcut-agent.service` 是唯一的 systemd 单例主服务，新主服务实例的启动即代表旧 `control-only` 主服务进程已经退出；文档服务可在确认新主服务实例上线（或加上 systemd 主服务单元的 `MainPID` / `InvocationID` 核对）后，将旧 `control-only` 实例名下悬着的读取标为已随旧进程终结，并补齐历史 `accessEvents` 的读取控制记录，使正常的改密退出不再因主服务重启而永久卡在「正在退出」。
   - **选项 B**：保持现状（旧主服务重启后留下的未关读取继续让该登录的退出在 45 秒后显示超时失败，后台按本次新增的指数退避每 60 秒重试一次）。
3. **是否批准将本分支（`gemini/docservice-eacces-logout`）合入 `main` 并部署到生产节点？**
   - **急迫性说明**：生产节点上由于 `agentReadsV1.nonces` 未修剪，账本在过去 40 分钟内已从 432 KB 涨到近 **1 MB**（每小时 +1.9 MB），文档服务 CPU 已从 15% 升至 **67%～76%**，再过约 15～20 分钟又会顶满 100% CPU 导致云端 Agent 超时。如果批准部署，我们可以立即合入 `main` 并更新节点上的文档服务，把积压的 9,000+ 条 `nonces` 自动修剪回 256 条（账本降回 ~331 KB，CPU 立即回落）。
