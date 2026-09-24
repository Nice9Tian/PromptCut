# M5a 小修：队列节点不依赖 npm 包

分支 `claude/rq-m5a-deps`（从 `claude/rq-m5a` 的 `e4dfb2c` 拉出），worktree `.worktrees/rq-m5a-deps`。

## 问题

`scripts/probes/render-queue-e2e.mjs --role node` 在没有 `node_modules` 的笔记本上启动即报
`ERR_MODULE_NOT_FOUND: Cannot find package 'pngjs' imported from server/frame-mov.mjs`。
引用链：`render-node/local-node.mjs` → `./split.mjs` → `../snapshot-store.mjs`（只为纯函数 `snapshotTier`）→ `./frame-mov.mjs`（`atomic`）→ `pngjs`。

## 做了什么

| 提交 | 内容 |
|---|---|
| `f593255` | 建报告 |
| `acc3c49` | 新模块 `server/snapshot-tier.mjs`：`snapshotTier` 原样搬入（连同注释），不引任何模块。`server/snapshot-store.mjs` 改为 `export { snapshotTier } from './snapshot-tier.mjs'`；`server/render-node/split.mjs` 改从 `../snapshot-tier.mjs` 引入。 |
| `77f5ac3` | 守门测试 `server/test/render-node-deps.test.mjs`：D0 解析器自检；D1 从 `server/render-node/` 每个文件出发静态递归遍历；D2 同样检查 `server/docservice/` 与 `server/render-queue/`。 |

- `snapshotTier` 本身不依赖同文件里的其它东西，只搬了这一个函数；`snapshot-store.mjs` 内部也没有调用它，转出即可。
- `git grep snapshotTier` 核对的调用方：`server/card-cache.mjs`、`server/frame-pipeline.mjs`、`server/vite-plugin-frames.ts`、`server/test/snapshot-store.test.mjs` 仍从 `snapshot-store.mjs` 引，均未改动；只有 `render-node/split.mjs` 改了引入路径。
- 守门测试解析五种写法：`import … from '…'`（含多行）、`export … from '…'`（`{…}` / `*` / `* as x`）、`import '…'`、`import('…')`、`require('…')`（`docservice/ecosystem.config.cjs` 用 `require`）。只放行 `node:` 前缀与仓库内相对路径，裸包名（包括不带 `node:` 的 `path`、`fs/promises`）一律报出；相对路径指到仓库外也报。D1 另断言依赖树里不含 `server/snapshot-store.mjs`、含 `server/snapshot-tier.mjs`。

## 验证

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`：退出码 0；tests 2250、pass 2249、fail 0、skipped 1（`集成:/api/cards/layout 对真实项目返回整数框`，需要 5190 的那条）。
- `node --test server/test/render-node-deps.test.mjs`：3 条全过（D0、D1、D2）。
- 反向核对守门测试有效：把 `split.mjs` 临时改回 `'../snapshot-store.mjs'` 再跑，D1 失败，报出 `server/frame-mov.mjs: 'pngjs'`、`server/bakery/chrome.mjs: 'puppeteer'`、`'three'`、`'@puppeteer/browsers'` 以及 bakery 里一批不带 `node:` 前缀的内置模块；随后 `git checkout` 还原。
- **无 node_modules 实测**（不提交）：在 scratchpad 下建临时目录，只拷 `server/render-node/`、`server/render-queue/`、`server/docservice/`、`server/test/fake-*.mjs`、`server/snapshot-tier.mjs`（没有拷 `snapshot-store.mjs`），确认该目录及所有上级目录都没有 `node_modules`，`NODE_PATH=` 置空：
  - `import('./server/render-node/local-node.mjs')`、`index.mjs`、`docservice/service.mjs`：退出码 0，导出 `createLocalNode`，`index.mjs` 19 个导出；
  - 7 个 `fake-*.mjs` 逐个 import，无 `ERR_MODULE_NOT_FOUND`；
  - 再把探针 `scripts/probes/render-queue-e2e.mjs` 拷进去，`--url ws://127.0.0.1:1 --role node --timeout-ms 3000`：模块全部加载，走到连接阶段，按预期「3000 ms 内没连上」退出码 2（没有起服务端，任务未分配端口段）；
  - 对照：同一目录换回 `claude/rq-m5a` 的 `split.mjs`、`snapshot-store.mjs`、`frame-mov.mjs`，import `local-node.mjs` 退出码 1，`Cannot find package 'pngjs' imported from …\server\frame-mov.mjs`，与笔记本上的报错一致。
- **G0-R（导出确定性、快照重放一致）没跑**：这次只是把一个纯函数原样换文件，函数体逐字不变，`snapshot-store.mjs` 的对外导出不变，渲染、快照、导出路径的行为不可能变化；`snapshot-store.test.mjs` 里 `snapshotTier` 的档位断言照常通过。

## 没做成的

无。

## 对任务书或语义的更正建议

- `docs/plan/render-queue-contract.md` B 节第一段写「只可以引 Node 内置模块、`server/render-queue/index.mjs`（常量与 `taskIdOf`）和 `server/snapshot-store.mjs` 的 `snapshotTier`」。按这次改动应改为 `server/snapshot-tier.mjs` 的 `snapshotTier`，并注明守门测试 `render-node-deps.test.mjs`（D1 / D2）。该文件不在本任务的可改清单里，未改。
- 同一句只提到 `render-queue/index.mjs`；实际 `split.mjs` 还从 `index.mjs` 引 `lockKeyOf`（卡片级指纹锁加的），建议一并写上。
