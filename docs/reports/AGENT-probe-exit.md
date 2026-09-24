# 子 Agent 报告：探针退出时的 libuv 断言

分支 `claude/probe-exit`（从 main 2180491 拉出），worktree `.worktrees/probe-exit`。未推送、未合并、未建 junction、未跑 npm ci。

## 任务

`scripts/probes/ws-client-test.mjs` 对远端跑完后 `ws.close()` 紧接 `process.exit()`，关闭握手没完成就退出，Windows 上 Node 报 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94`。改成先等 `close` 事件（最多 3 秒）再退出；检查 `render-queue-e2e.mjs`、`asset-lan-probe.mjs` 有没有同样的写法。

## 做了什么

### `scripts/probes/ws-client-test.mjs`（提交 7b0ce54）

- 新增 `closeAndWait(ws, code, reason)`：已经 CLOSED 直接返回；否则挂 `close` 监听（once），不在 CLOSING 时调 `ws.close()`，最多等 `CLOSE_WAIT_MS = 3000`（等待用的计时器 `unref`）。
- 主流程收进 `async function run()`，返回退出码：
  - 连不上：`connect()` 把 socket 记在模块变量 `socket` 里，失败时 `await closeAndWait(socket)` 后返回 2（原来是立即 `process.exit(2)`）；
  - 正常：`await closeAndWait(ws, 1000, 'probe done')` 后返回 0 或 1。
- 出口不再直接 `process.exit`：`process.exitCode = code`，让事件循环自然结束；再挂 `setTimeout(() => process.exit(code), 0).unref()` 兜底（没句柄挡着时它不会触发）。
- 文件头注释补了一句为什么要等 close。

断言内容和顺序没动（body 只是缩进了一层）。

### `scripts/probes/render-queue-e2e.mjs`（提交 9c27af0）

有同样的写法：`finish()` 里 `ep.close()` 之后立即 `process.stdout.write(..., () => process.exit(code))`。改为：

- `finish()` 先设 `process.exitCode = code`，再 `closeEndpoints().then(写结果行并 process.exit(code))`；
- `closeEndpoints()`：对 `ep.connected` 为真的端点先挂 `ep.onClose`，再 `ep.close()`；全部 onClose 到了或 3 秒到了就 resolve。没连上的端点（连接中或等重连）`ws-transport` 不会为它发 onClose，不等。

保留了 `process.exit`：这里写完结果行后就要退出，而且 node 角色的本地节点可能还有句柄；到这一步连接已经关干净，不会再触发断言。

### `scripts/probes/asset-lan-probe.mjs`（提交 9c27af0）

`discover()` 的 `finally` 里 `ws.close()`，之后若地址都不通会抛 `Unreachable`，紧接着 `finish(2)` → `process.exit`，同一类写法。改成 `await closeAndWait(ws)`（同上，最多 3 秒）。其余 `process.exit(2)` 都在用法错误路径上，那时还没开任何连接，不动。

实测原版在「控制面等 service.endpoints 超时」这条路径上没有崩（见下），这处改动是预防性的。

## 验证

令牌从主仓库 `.env.cluster` 读进当前 shell 的环境变量，没有打印；输出里用 `grep -cF -- "$TOKEN"` 查过为 0。

### 修复前复现（原版 ws-client-test，Node v24.19.0）

```
$ node scripts/probes/ws-client-test.mjs ws://8.219.80.16:8787 | tail -3
14/14 passed
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
exit=127        # Git Bash 里显示为 127；任务书里 PowerShell 看到的是 -1073740791
```

### ws-client-test 对远端连跑 5 次

```
ws-client-test run 1: exit=0  14/14 passed  assertion-lines=0
ws-client-test run 2: exit=0  14/14 passed  assertion-lines=0
ws-client-test run 3: exit=0  14/14 passed  assertion-lines=0
ws-client-test run 4: exit=0  14/14 passed  assertion-lines=0
ws-client-test run 5: exit=0  14/14 passed  assertion-lines=0
```

单次耗时约 770 ms。

### render-queue-e2e 对远端 2 次（`--role both --tasks 10 --task-ms 100`）

```
render-queue-e2e run 1: exit=0 assertion-lines=0
"ok":true,"role":"both" "completed":10 "duplicateDone":0 "doneLatencyMs":{"p50":853,"p95":1475} "fails":[]
render-queue-e2e run 2: exit=0 assertion-lines=0
"ok":true,"role":"both" "completed":10 "duplicateDone":0 "doneLatencyMs":{"p50":895,"p95":1519} "fails":[]
```

第 2 次的日志里，结果行之前能看到两条连接都真正关上了（`ws.close` 是 socket 的 close 事件，不是本端发起的 `ws.closed`）：

```
"event":"publisher.ws.closed", ...
"event":"node.ws.closed", ...
"event":"node.ws.close", ..., "code":1000, "reason":"closed"
"event":"publisher.ws.close", ..., "code":1000, "reason":"closed"
```

### 不带令牌跑 ws-client-test

```
$ env -u PROMPTCUT_CLUSTER_TOKEN node scripts/probes/ws-client-test.mjs ws://8.219.80.16:8787
target ws://8.219.80.16:8787  token none
FAIL  WebSocket 握手
exit=2
```

没有断言崩溃。另测了连接被拒（`ws://127.0.0.1:1`）：同样 `FAIL  WebSocket 握手`，exit=2。

### asset-lan-probe（附带）

```
$ node scripts/probes/asset-lan-probe.mjs --docservice ws://8.219.80.16:8787 --mb 1 --timeout-ms 30000
{"ok":false,"assetUrl":null,"source":"docservice","bytes":0,"steps":[],"fails":[{"step":"connect","detail":"等控制面的 service.endpoints 超时"}]}
asset-lan exit=2 assertion-lines=0 token-hits=0
```

远端目前没有登记素材服务，所以走的是「连上控制面 → 等 15 秒超时 → 关连接 → 退出码 2」这条路径，正好覆盖改动处。原版（`git show main:...`）同一条路径跑 2 次也是 exit=2、没有崩溃，所以这里只算预防。完整的上传路径没法在这台服务上验证。

### 基线

```
$ npx tsc -b --force
tsc exit=0

$ npm test
npm test exit=0
ℹ tests 2309
ℹ pass 2308
ℹ fail 0
ℹ skipped 1
```

唯一的跳过：`集成:/api/cards/layout 对真实项目返回整数框`，原因「http://127.0.0.1:5190 上没有 dev server」，符合任务书允许的那一条。

## 没做成的

无。

## 对任务书的更正建议

- Git Bash 里崩溃的退出码显示为 127，不是 -1073740791（后者是 PowerShell / cmd 里看到的 0xC0000409）。复现时别用退出码判断，用输出里的 `Assertion failed` 行判断更稳。
- 查令牌泄漏时写 `grep -F -- "$TOKEN"`：令牌字符集里有 `-`，不加 `--` 可能被 grep 当成选项。
