# 报告：C6.3 文档服务本体最小版

集成分支 `claude/c6-3`。2026-09-25 验收通过，按用户「阶段验收全过即自动合并」的授权合入 main。

- 计划：`docs/plan/Master-Execution-Plan.md` C6 一节 C6.3 行
- 契约：`docs/plan/docservice-contract.md`（第 10 节是定稿后补的 14 条细则）

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | tests 2352、pass 2351、fail 0、skipped 1 |
| 新增测试（测试方只照契约写，没看实现） | `docservice-project`（P）、`docservice-content`（N）、`docservice-attach`（M） | 9 + 10 + 4，合进集成分支后首跑全过 |
| 既有文档服务测试 | `docservice`、`-router`、`-channels`、`-backpressure`、`render-node-deps` | 全过，一字未改 |
| 插件实测（主 Agent） | 5490 起 dev server | `/api/docservice/healthz` 四个模块都在；`ws://…/docservice` 协商到 `promptcut.v1`；`project.open` → rev 0，`announce` → rev 1，广播的 `actor.userId` 是 `local`；日志落在 `out/docservice/projects/`，经 HTTP 取回 403 |
| 升级防崩（实现方复现） | 升级请求被客户端重置 | 修复前三种情形里两种会让 dev server 退出，修复后三种都不退出；HMR 照常 |
| 导出确定性（主 Agent） | `verify-determinism`（5490） | 1800/1800 相同 |
| 导出与快照重放（主 Agent） | `verify-unified-frames` | PASS |

## 2. 刻意的留白与不一致

1. **文档服务还不持有项目内容**（契约第 0 节）。项目版本模块只按页面报来的摘要编号、记日志、广播；页面仍是项目的真身。操作格式、D1 / D2、撤销与重做留给 C6.5，要用户裁决。
2. **修了一个 C6.3 之前就有的崩溃**：vite 的 HMR 监听对不认识路径的升级请求直接放手，不给 socket 挂错误监听。客户端一重置连接，就是未处理的 `ECONNRESET`，整个 dev server 退出。局域网里任何一台设备都能这样打崩编辑器。现在插件给所有升级 socket 挂空的错误监听（契约第 10 节第 14 条）。
3. **无头实例进入停用模式**：Skill 的无头实例和用户的编辑器共用同一个项目根，两边同时发号会冲突。所以无头实例不建文档服务，`/docservice` 的升级请求回 503。
4. **日志路径编码**：stream 名编码成安全的文件名（`a:b` → `a%3Ab.ndjson`），不然在 Windows 上 `:` 会把日志写进一个看不见的备用数据流。
5. **安全**：`fsDeny` 加了 `**/out/docservice/**`，局域网设备读不到日志与卡片源码。`.gitignore` 加了 `/data/`。

## 3. 需要用户知道

- **用户常驻的 5190 编辑器重启后**，会在编辑器进程里自带一份本地文档服务（`/docservice`），日志写在 `out/docservice/`。不重启就还是旧行为。
- **远端控制面已重新部署**，挂上了 `project`、`content` 模块。日志在远端的 `/opt/promptcut-docservice/data`。

## 3a. 过程记录

子 Agent 与分工：
- `claude/c6-3-impl`（`opus-dev-high`），返工两轮：第 10 节第 6～8 条，以及第 10、14 条；
- `claude/c6-3-tests`（`opus-dev`）。

两份报告的内容已并进本文，原文留在各子分支的提交里。
