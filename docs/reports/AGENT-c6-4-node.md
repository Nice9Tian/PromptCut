# AGENT-c6-4-node 报告

角色：C6.4 节点侧实现方。分支 `claude/c6-4-node`，基于 `claude/c6-4`（dc1addc）。
依据：`docs/plan/manifest-contract.md` 第 2 节；服务端协议 `docs/plan/docservice-contract.md` 第 2、10 节；端点 `server/render-node/ws-transport.mjs`（G.7、G.11）。

## 做了什么

只改了归属清单里的两个文件：

- `server/render-node/content-client.mjs`（新）：`createContentClient(endpoint, { timeoutMs = 10_000 })`，另导出 `CONTENT_CLIENT_DEFAULTS`。
  - `put(kind, key, body) → { hash, rev? }`，`get(kind, key) → { body, hash, rev? } | null`（`missing` → `null`），`list(kind, prefix?) → { items, truncated }`。`rev` 只在回包里有时才带。
  - **配对**：`reqId` 为 `content#<实例号 8 位>-<序号>`，实例号取 `node:crypto` 的 `randomUUID`。和 local-node 的 `<publisherId>#publish-<n>` 不会撞，同一端点上挂几个客户端也不串。别人的 `reqId` 一律不理。
  - **错误**：同一 `reqId` 回 `error` 时拒绝，错误对象带 `reason`、`detail`，`code` 与 `reason` 相同。回包类型不对（例如 `get` 收到 `content.stored`）时 `code: 'bad-reply'`。消息无法序列化时 `code: 'bad-message'`，不发出。
  - **超时**：`code: 'timeout'`，迟到的回包丢弃。计时器 `unref`，不拖住进程退出。
  - **断线**：端点 `onClose` 时，所有在途请求立即以 `code: 'disconnected'` 失败。`send` 回 `false`（未连上）时也立即以 `disconnected` 失败。都不重放。
  - 另有 `pending()`，返回在途请求数，诊断用。`setTimeout` / `clearTimeout` 可注入。这两项是契约之外的附加，不影响契约里的形状。
  - 只引 `node:crypto`（D1 通过，见下）。
- `server/render-node/index.mjs`：加出 `createContentClient`、`CONTENT_CLIENT_DEFAULTS`，文件头的模块表和「例外」说明各加一句。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 退出码 0；tests 2352，pass 2351，fail 0，skipped 1。跳过的一条是「集成:/api/cards/layout 对真实项目返回整数框」，要 5190 上的 dev server，属于允许的那一条 |
| D1 守门 | 在 `npm test` 里 | `✔ D1 server/render-node/ 的整棵依赖树只有 node: 内置模块和仓库内相对路径` |

渲染相关的项（determinism、unified-frames、探针）没跑：本分支没碰渲染、导出和卡片。

### 自测（scratch 脚本，不提交）

脚本：`<scratchpad>/content-client-selftest.mjs`。用真文档服务：`createDocService({ modules: [contentModule({ store: createMemoryStore() })] })`，`listen(0, '127.0.0.1')`，客户端经 `createWsEndpoint` 连上。

命令：`node <scratchpad>/content-client-selftest.mjs`，退出码 0，输出：

```
PASS defaults
PASS bad args throw TypeError
PASS Q1 put/get/missing/list
PASS server error carries reason (bad-message / too-large)
PASS Q2 20 concurrent, paired by reqId; two clients on same endpoint
   timeout after 214 ms
PASS Q3a timeout -> code timeout, late-free
   disconnected after 1 ms
PASS Q3b disconnect -> in-flight reject disconnected immediately; not-connected send rejects
ALL 7 PASS
```

各条断言的内容：

- **Q1**：
  - `put` 回 64 位十六进制的 `hash`，不带 `rev`；
  - `get` 取回的等于 `{ body, hash }`，`missing` 回 `null`；
  - `list('snapshot-manifest', 'rk1:')` 只回两条 `rk1:` 键，按升序，`truncated: false`；
  - `card-source` 连写两次，`rev` 是 1、2，`get` 回 `rev: 2`。
- **服务端错误**：不认识的 `kind` 回 `reason/code = 'bad-message'`；300 KiB 的正文回 `too-large`。完了 `pending() === 0`。
- **Q2**：两个客户端共用一条端点，交错发 20 个 `put`，再交错发 20 个 `get`，每条取回的都是自己的 `{ i }`。随后 `get`、`list`、`missing`、`put` 混着并发，结果各自正确。
- **Q3a 超时**：包一层端点，把 `content.get` 吞掉（服务端收不到，也就不回），`timeoutMs: 200`。等了 214 ms 后以 `timeout` 拒绝，`pending()` 归零，同一客户端之后的 `put` 照常成功。
- **Q3b 断线**：两个 `get` 被吞、在途，`timeoutMs` 设为 60 s。`service.close()` 之后 1 ms 内两个都以 `disconnected` 拒绝。之后在未连上的端点上 `put`，立即以 `disconnected` 拒绝。

## 没做成的

无。

## 契约疑点与更正建议

1. **session 会把内容库的 `error` 当成认领失败**（不在本分支的文件范围内，没改）：
   - 现状：`session.mjs` 第 158 行收到任何 `type: 'error'` 都会清掉在飞的认领，不看 `reqId`，因为 `task.claim` 不带 `reqId`（B.5 补充细则）。内容库客户端和节点共用端点，内容库回的 `error`（`too-large`、`bad-message`）也会进 `session.receive`。
   - 后果：如果恰好有认领在飞，它会被当作失败清掉。之后 `task.claimed` 照常回来，按会话的现有逻辑仍会加入持有，所以应该只是多一次认领的节奏抖动，不会丢任务。这一点我没有实测。
   - 建议二选一：
     - session 只在 `error` 不带 `reqId`（或 `reqId` 不是本会话发的）时才清在飞；
     - 或者在 B.5 里写明「带 `reqId` 的 `error` 不是认领的回包」。
   - 这一处归 M5b / local-node 的属主改。
2. **错误对象的形状**：契约只说「错误带 `reason`」「超时抛 `code: 'timeout'`」。我统一成 `code === reason`，服务端来的错误另带 `detail`。建议测试方按 `reason` 或 `code` 断言都行，契约里可以补一句「服务端错误的 `code` 等于 `reason`」。
3. **`content.put` 的 `session` 字段**：`docservice-contract.md` 补充细则第 4 条允许 `content.put` 带可选的 `session`，但第 2 节的签名 `put(kind, key, body)` 没留位置。本实现不发 `session`，所以 `actor.session` 恒为 `null`。如果以后要让被覆盖方的 `previousActor` 能区分同一用户的不同会话，需要在签名里加上。
4. **没有注销**：`WsEndpoint` 没有 `offMessage` / `offClose`，客户端挂上的处理器跟端点同生命周期。当前的用法是一个节点一个客户端，没有问题；以后要在同一条端点上反复建客户端的话，需要端点提供注销。
