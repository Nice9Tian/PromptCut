# AGENT-m5b-fixes 报告

分支 `claude/m5b-fixes`（基于 `claude/rq-m5b`），worktree `.worktrees/m5b-fixes`，端口段 5520～5529。

## 状态

三件都做完，验证全过（见文末「验证」）。

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

## 3. queue-mode-probe 的局域网模式

- `server/vite-plugin-frames.ts`（队列节点接线）：诊断原来只有计数（`stats.completed` 等）和最近 80 条事件，没有「本机完成了哪些任务」。新增诊断 `queue.local = { nodeId, claimed, completed, dedup, failed }`：`claimed` 取自发给本连接的 `task.claimed`，其余取自 local-node `onEvent` 的 `completed` / `dedup` / `failed`。每类最多留 5000 个 id。只加字段，别的行为不变。
- `scripts/probes/queue-mode-probe.mjs`：
  - `--lan`：队列模式那一趟的编辑器绑 `0.0.0.0`，探针的检查仍走 `127.0.0.1`。普通模式那一趟不变（仍绑回环）。
  - 令牌：确认现状是只有 `!DOC_URL`（探针自起、绑回环、匿名的文档服务）时才删 `PROMPTCUT_CLUSTER_TOKEN`；给 `--docservice-url` 时原样保留。`--lan` 不改这一条，已写进文件头。
  - `announcedAsset`：从编辑器输出的 `[asset-announce] asset-announce.announced {…}` 行解析 `urls`；`skip` / `error` 行放进 `runs.queue.announceIssues`。
  - `--hold-min N`：队列那一趟不在 `runOnce` 里关进程，返回 `release()`；比较做完之后保持 N 分钟，每 30 秒打一行 `[hold] {tasks, done, readyLayers, localCompleted, connected, leftSec}`，每次刷新 `nodes`；结束后（包括出错）关进程。
  - 输出新增 `nodes`（取自诊断 `queue.local`，外加 `stats`）、`announcedAsset`，以及 `lan`、`editorHost`、`holdMin`。
  - 给了 `--docservice-url` 时，不再要求「细任务都由本机节点完成」（跨机时别的机器也在取活，这条检查会误报）。这是任务书没写、我加的调整。

- 本机跑：`node scripts/probes/queue-mode-probe.mjs --only queue --lan --hold-min 1 --queue-port 5520 --normal-port 5523 --docservice-port 5526`，**退出码 0**。
  - 末行：`{"ok":true,"tasks":5,"done":5,"identical":null,"differentFrames":0,…,"fails":[]}`（`--only queue` 不做比较，`identical` 为 null 是预期）。
  - 保持期三行进度：`[hold] {"tasks":5,"done":5,"readyLayers":3,"localCompleted":5,"connected":true,"leftSec":60}`，之后 `leftSec` 30、0。
  - `announcedAsset`：`["http://192.168.50.96:5520/api/asset"]`。
  - `nodes`：`nodeId` `prerender:DESKTOP-GS40TCK:5520`，`claimed` 6 个（1 个 `plan:queue-mode-probe@1` + 5 个 `snapshot:…`），`completed` 5 个，`dedup` / `failed` 空；`stats.applyErrors` 0。

## 验证

- `npx tsc -b --force`：退出码 0，零错误。注意 `tsconfig.json` 只含 `src`，改到的 `server/*.ts` 不在它的检查范围；另外用 `npx tsc --noEmit --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --types node --allowImportingTsExtensions server/vite-plugin-prerender.ts server/vite-plugin-frames.ts` 单查了一遍，这两个文件没有报错。
- `npm test` 连跑 3 遍：每遍退出码 0，`tests 2445 / pass 2444 / fail 0 / cancelled 0 / skipped 1`。唯一的跳过是 `cards-layout.test.mjs` 的「集成:/api/cards/layout 对真实项目返回整数框」（没设 `PC_STAGE_TEST_URL`，也就是要 5190 的那一条）。
- `queue-mode-probe --only queue --lan --hold-min 1`（端口 5520/5526）：退出码 0，数据见第 3 节。
- G0-R，dev server 用 `node …/vite/bin/vite.js --port 5520 --strictPort --host 127.0.0.1`，工作目录是本 worktree；预渲染进程拿到 `http://127.0.0.1:3854`（经 `listenSafe`）：
  - `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5520/?export=1"`：退出码 0，1800 帧全部相同。
  - `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5520`：退出码 0，整条 PASS。
  - 跑完关掉了自己起的 dev server，5520～5529 与 3854 上没有残留监听。全量测试与导出类验证是分开跑的。

## 没做成的

无。

## 对任务书的更正建议

- 任务书写「`git grep -n "listen(0"` 与 `listen({ port: 0`」：生产代码里只有预渲染进程一处；`scripts/headless.mjs` 早已用 20000 以上随机端口绕开。
- `readSpill` 是同步函数，退避只能同步阻塞（最坏约 0.5 s）；若日后要避免阻塞事件循环，需要把 `LazyFrameStore.get` 改成异步，影响面较大，另立任务。
- `--docservice-url` 模式下我去掉了「细任务都由本机节点完成」这条检查（跨机时会误报），请主会话确认这个取舍。
