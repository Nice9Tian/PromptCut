# AGENT 报告：HT-a 服务端（`claude/http-transport` 按契约返工）

状态：进行中。

HT-a 是 `docs/plan/http-transport-contract.md` 文件头「2026-09-27 拆分」的前一段：会话模型、序号确认、WebSocket 传输接会话层、本机信任开关；HTTP 长轮询（HT-b）保留代码、不接线。本报告只管服务端；客户端会话层 `server/render-node/session-link.mjs` 与各处接入在 `claude/ht-client`。

## 1. 合并与冲突

- `git merge --no-ff claude/c10a-integ`（`e0515c4`）。两处冲突：
  - `docs/plan/http-transport-contract.md`：取 C10a 集成分支一侧（第 2 版加第 16 节）。
  - `server/vite-plugin-frames.ts` 独立渲染主机的 `connect`：本分支按 `entry.transport` 选端点，C10a 给 `rec` 加了 `cards: null`。按两边意图合：保留按 `entry.transport` 选端点（这一处归 `claude/ht-client` 改成 `createDocEndpoint`，HT-a 不动），`rec` 加上 `cards: null`。

## 2. 返工项的落实

（待写）

## 3. 与测试方假设（`ht-kit.mjs` H1～H14）的对齐

（待写）

## 4. 验证

（待写）

## 5. 没做成的及原因

（待写）

## 6. 对契约的更正建议

（待写）
