# AGENT 报告：cloud-see-frames-fix

## 做了什么

1. **`server/agent/service/account-runner.mjs`**：
   - 提取 `const assignmentDigest = grant.assignmentDigest ?? grant.scopeBinding?.assignmentDigest ?? null;`，修复作用域模式下 `grant` 的绑定摘要位于 `grant.scopeBinding.assignmentDigest` 时 `look` 相关调用丢失摘要的问题。
   - 在 `look.forProject(grant.projectId, ...)` 的顶层选项传入 `assignmentDigest`，同时保持 `run: { runGrantId, runId, conversationId }` 三个键不变以兼容直连 `createLookClient` 的形状校验。
   - 在 `look.heartbeat` 以及全部 5 处 `look.release`（`onAbort`、`drain`、`fence`、`close`、`catch`）中统一传入 `assignmentDigest`。
   - 在 `prerenderPost` 处理 `/api/vision/snapshot` 时，仅当 `typeof toolset?.pageBridge?.call === 'function' && bound?.side?.executor?.request` 时才向文档服务发 `selection.query`，避免没有本地页面桥时每次 `see_frames` 白发一趟必然落入 `no-local-bridge` 的选区查询。

2. **`server/agent-service/account-task-worker-config.mjs`**：
   - 在 `createWorkerMasterLookClient` 的 `forProject` 中接收顶层 `assignmentDigest`（兼容 `assignmentDigest ?? bound?.assignmentDigest` 及调用时的 `opts?.assignmentDigest`），并在 `callMaster` 的请求体顶层 `assignmentDigest` 与 `binding.assignmentDigest` 中同时携带该摘要。

3. **`server/agent-service/account-master-assembly.mjs`**：
   - 将 `lookRoute` 第 342 行的 `req.on('close', () => { ac.abort(new Error('client-closed')); })` 改为 `res.once('close', () => { if (!res.writableEnded) ac.abort(new Error('client-closed')); })`，修复 Node.js（v20/v24）中 `req` 流消费完毕立即触发 `'close'` 事件导致异步 `masterLook` 请求被误触发 `client-closed` 取消的问题。

4. **`server/test/cloud-see-frames-dispatch.test.mjs`**：
   - 新建单测，覆盖：
     - `grant.scopeBinding.assignmentDigest` 经 `account-runner.mjs` -> `createWorkerMasterLookClient` -> `createAccountMasterAssembly`（`lookRoute`）完整传递至 `runClient.workerEventSource`，通过 403 校验并成功返回 `see_frames` 画面；
     - 无本地页面桥时 `prerenderPost` 不向文档服务发 `selection.query`；
     - `lookRoute` 读取完请求体后等待异步 `masterLook` 期间不误触发 `client-closed`，而客户端在 `!res.writableEnded` 提前断开时正常触发 `client-closed` abort；
     - `look.heartbeat` 与 `look.release` 同样携带 `grant.scopeBinding.assignmentDigest`。

## 验证结果

- `node --test server/test/cloud-see-frames-dispatch.test.mjs`：通过（1/1）
- `node --test server/test/cloud-agent-look.test.mjs`：通过（4/4）
- `node --test server/test/account-runner-wiring.test.mjs`：通过（10/10）
- `npx.cmd tsc -b --force`：通过（退出码 0）

## 没做成的及原因

- 无。

## 对任务书或语义的更正建议

- `account-runner.mjs` 中除第 129 行 `heartbeat` 和第 144 行 `onAbort` 的 `release` 外，在 `drain`、`fence`、`close` 与 `catch` 中还有 4 处 `look.release` 调用，本次已一并改为传入提取后的 `assignmentDigest`。
