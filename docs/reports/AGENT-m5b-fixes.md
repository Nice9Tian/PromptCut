# AGENT-m5b-fixes 报告

分支 `claude/m5b-fixes`（基于 `claude/rq-m5b`），worktree `.worktrees/m5b-fixes`，端口段 5520～5529。

## 状态

进行中。

## 1. 预渲染进程的端口避开坏端口

- 新建 `server/safe-port.mjs`：`UNSAFE_PORTS`（WHATWG fetch「bad port」全表，含 0 和 1～1023 那些，共 83 项）、`isUnsafePort`、`listenSafe(server, host)`（`listen(0)` 拿到坏端口就关掉重来，最多 20 次，试满抛错；成功时 server 保持监听）。
  - 抄表后在本机用 Node 24.19 的 `fetch` 扫了 1～11000 号，报 `bad port` 的端口与本表除 0 外逐个相同（0 在规范表里，`listen(0)` 不会返回它）。
- `server/vite-plugin-prerender.ts` 的 `freePort()` 改用 `listenSafe`。
- 生产代码里 `listen(0` / `listen({ port: 0` 的排查（`git grep -n "\.listen("`，范围 `server/`、`scripts/`、`desktop/`，不含 `server/test/`）：
  - `server/vite-plugin-prerender.ts` `freePort()`：唯一一处 `listen(0)`，已改。
  - `scripts/headless.mjs` `freePort()`：已经不用 `listen(0)`，从 20000 以上随机挑号再试绑（文件里写着就是为了避开 6000），比 10080 大，不会碰坏端口。不改。
  - `scripts/lib/dev-server.mjs`、`scripts/probes/cold-start-probe.mjs`、`placeholder-probe.mjs`、`queue-mode-probe.mjs`：`listen(port)` 只是探测给定端口空不空，端口由调用方给。不改。
  - `scripts/probes/probe-connect.mjs`、`render-queue-proxy.mjs`、`server/vite-plugin-stage-ports.ts`：端口来自参数或编辑器端口 +1/+2。不改。
  - `server/docservice/main.mjs` → `service.listen(port, host)`：端口来自 `PROMPTCUT_DOCSERVICE_PORT`（缺省 8787），显式给定。不改。
  - `scripts/verify-*.mjs` 里的 `await server.listen()`：是 Vite 的 `createServer().listen()`，端口来自 Vite 配置，不是 0。不改。
- 测试 `server/test/safe-port.test.mjs`（6 条）：global-setup 的 `FETCH_BAD_PORTS` 正是 `UNSAFE_PORTS` 里 ≥ 1024 的部分（子集且等于那一段）；`isUnsafePort` 表内/邻号；假 server 前三次发 6000、6665、10080，第四次 5523，断言返回 5523、listen 4 次、close 3 次；一直发坏端口时试满 20 次抛错；listen 出错原样抛；真 `net.Server` 拿到的端口可连。

## 2. `LazyFrameStore.readSpill` 不再把暂时性读错误当成文件坏了

- `server/frame-archive.mjs`：
  - `readFileSync` 抛 `EBUSY`、`EPERM`、`EACCES`、`EMFILE` 时退避重试，最多 5 次（间隔 20、40、80、160、200 ms），不删文件；试满仍失败返回 `undefined`，文件保留。
  - `ENOENT`：返回 `undefined`（原逻辑里的 `rmSync` 对不存在的文件本来就是空操作）。
  - 读到了但 gunzip 失败（内容损坏）：照原逻辑删文件、返回 `undefined`。
  - 其它读错误（如 `EISDIR`）：不重试、不删，返回 `undefined`。按任务书「只有确认损坏或 ENOENT 才照原逻辑」处理。
  - `readSpill` 是同步的（`get()` 同步调用它），退避用 `Atomics.wait` 同步睡；最坏阻塞约 0.5 s，只在文件真被占着时发生。改成异步会牵动 `get()` 的所有调用方，超出范围。
  - 导出 `SPILL_READ_RETRIES`、`spillBackoffMs` 供测试。
- 测试 `server/test/frame-archive-spill.test.mjs`（8 条）：用 `node:test` 的 `mock.method(fs, 'readFileSync')` 让前两次读抛 `EBUSY`，断言读到内容、读了 3 次、文件还在；再经 `get()` 走一遍 `EPERM`；`EPERM`/`EACCES`/`EMFILE` 一直不消失时读 6 次、返回 `undefined`、文件还在、解除后能读到；退避间隔在 20～200 ms；内容坏了删文件且不重试；`ENOENT` 不重试；`EISDIR` 不重试不删。
  - 把新测试套在旧版 `readSpill` 上跑：8 条里 5 条失败（旧版删文件），证明测试确实咬住了这个 bug。

