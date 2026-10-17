# AGENT-docservice-run-cpu 报告

## 1. 做了什么

1. **`server/account/run-authority.mjs` 只读快速路径与待结清任务过滤**：
   - 新增纯函数 `needsReconcile(s)`，检查账本快照是否缺少 `tableNames`（`runGrantsV2`、`runRequestsV2`、`runReadRequestsV2`、`runControlsV2`、`runReceiptsV2`、`runFinishRequestsV2`、`runFinishReceiptsV2`、`runAbandonedRequestsV2`）中的任意一张表，或者 `s.accessEvents.some(e => e.seq > (s.runAccessCursorV2 ?? 0))`。
   - 在 `sync(input)` 中：`await synchronize()` 与 `await refreshScope(input)` 之后读取 `const cur = ledger.read()`；当 `!needsReconcile(cur)` 时直接返回 `Object.values(cur.runControlsV2).filter(c => c.state === 'pending').map(copy)`，仅在 `needsReconcile(cur)` 为真时进入 `ledger.transaction`，消除素材服务每 100ms 轮询 `GET /internal/v2/run-assets/events` 时对近 1 MB 账本 JSON 的无条件 `JSON.parse` / `JSON.stringify`。
   - 在 `checkWithScope({ principal, projectId, action }, invocation)` 中：`await refreshScope({ principal })` 之后读取 `const snapshot = ledger.read()`；当 `!needsReconcile(snapshot)` 时直接在只读快照上完成 `checkInState(snapshot)` 校验并返回结果，仅当 `needsReconcile(snapshot)` 为真时进入 `ledger.transaction(s => { reconcile(s); return checkInState(s); })`。
   - 在 `reconcileScopeClosures()` 中：将候选任务过滤条件从 `g => g.scopeBinding && g.state !== 'finished'` 收紧为 `g => g.scopeBinding && g.state !== 'finished' && (Boolean(g.finishReceiptId) || g.state === 'revoked')`，避免正在运行（`preparing` / `active` / `retained` 且尚无 `finishReceiptId`）的任务每次都被拉去调用 `scopeAuthority.refresh` 并在 `ledger.transaction` 内抛 `503 run-forced-closure-pending` 触发回滚。

2. **`server/hosted/run-assets-checkpoint.mjs` 消除重复磁盘读取**：
   - 在 `acceptCurrent()` 中：完成 `const first = read(); const previous = checkpointOf(); assertRunAssetCheckpointTransition(previous, first);` 后，若 `same(previous, first.checkpoint)` 成立，直接返回 `Object.freeze({ ...first.checkpoint, instance: structuredClone(first.record.instance) })`，避免再次调用 `current()` 重复触发 `read()` 同步读取并校验 `/var/lib/promptcut/asset-root/` 下全部 JSON 文件与父目录链。

3. **新增单测 `server/test/run-authority-readonly-fastpath.test.mjs`**：
   - 验证当 `accessHead` 未推进时，多次调用 `runAuthority.synchronize()`、`runAuthority.checkAccess()`、`runAuthority.authorizeQuery()` 与 `runAuthority.resolveRunPrincipal()` 均走只读快速路径，不触发额外的 `ledger.transaction`，且返回值与原先一致；
   - 验证当有新的 `accessEvents` 追加后，`checkAccess()` 与 `synchronize()` 正常触发 `ledger.transaction` 执行 `reconcile`、推进 `runAccessCursorV2` 并生成对应的 `runControlsV2` 围栏，随后再次回到只读快速路径；
   - 验证 `reconcileScopeClosures()` 对 `preparing` 及运行中无 `finishReceiptId` 的 `active` grant 不会触发 `ledger.transaction` 回滚。

## 2. 验证结果

在专用工作区 `.worktrees/docservice-run-cpu`（分支 `gemini/docservice-run-cpu`）下执行：
- `node --test server/test/run-authority-readonly-fastpath.test.mjs`：2/2 通过
- `node --test server/test/cloud-run-assets-current-registry.test.mjs`：5/5 通过
- `node --test server/test/agent-run-scope-doc.test.mjs`：13/13 通过
- `npx.cmd tsc -b --force`：0 错误通过

## 3. 没做成的及原因

无。所有预定修改与单测均已完成并通过验证。

## 4. 对任务书或语义的更正建议

- 在启用 `scopeAuthority`（`createAgentRunScopeDoc`）的场景下，`refreshScope()` 内部调用的 `scopeAuthority.refresh(ref)` 自身仍会在每次刷新时通过 `ledger.transaction` 更新 `s.agentRunScopesV1.checkpoints[key]`。本次优化已消除 `runAuthority.sync()` 与 `checkWithScope()` 自身的冗余事务，以及无 `scopeAuthority` 入参的轮询路径（如 `runAuthority.synchronize()`）上的全部事务开销；若后续带 `principal` 的高频权限检查仍受 `scopeAuthority.refresh()` 的检查点写入影响，可在 `agent-run-scope-doc.mjs` 的 `refreshRead` 中对检查点与故障摘要未变化的场景同样做免写短路。
