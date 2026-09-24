# 报告：C6.2 预渲染产物推拉

集成分支 `claude/c6-2`。2026-09-25 验收通过，按用户「阶段验收全过即自动合并」的授权合入 main。

- 计划：`docs/plan/Master-Execution-Plan.md` C6 一节 C6.2 行
- 契约：`docs/plan/artifact-transfer-contract.md`（第 10、11 节是定稿后按实现方、测试方的疑点补的细则）
- 勘察：派了一个只读的探查子 Agent，把产物落盘、就绪索引和标识符的全部路径摸清之后才写契约。结论写在契约第 0 节和第 3～6 节里

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（连跑两遍） | 两遍都是 tests 2329、pass 2328、fail 0、skipped 1 |
| 新增测试（测试方只照契约写，没看实现） | `asset-namespaces`（S）、`asset-client`（L1～L6）、`artifact-transfer`（T1～T8） | 6 + 6 + 8。合进集成分支后只有 S2b 一条失败：契约第 10 节第 6 条没写全候选扩展名，是契约的问题，测试方按补充的第 10 条改了 S2b，之后全过 |
| 既有素材服务测试 | `asset-service`、`asset-store-http`、`blob-store-conformance` | 11 + 6 + 33，一字未改，全过 |
| 导出确定性（主 Agent 重跑） | `verify-determinism`（5480） | 1800/1800 相同 |
| 导出与快照重放（主 Agent 重跑） | `verify-unified-frames` | PASS |
| 导出像素基线（实现方跑） | 对 main（`cc60741`）逐像素比较 | 1800 帧 0 不同 |
| 预渲染探针（实现方跑） | `ready-index-probe`；`stream-produce-probe`，带和不带 `--group`；`preview-fallback-probe`，带和不带 `--page-preload` | 全部退出码 0 |

**一个现象**：主 Agent 第一次跑全量时，同时开着 dev server 并在跑 `verify-determinism`。这次有 10 条失败：`docservice-backpressure` 的 I3，以及音频图卡 `/pcm` 的几条。关掉 dev server 后连跑两遍全过，判定为 CPU 高负载下的时序偶发，不是回归。以后跑全量测试，不要同时跑导出类验证。

## 2. 与计划不一致的地方

1. **挪到 C6.4 的两块**：跨节点的「开工前查素材服务去重」，以及 A5 推送优先级和任务之外的无条件推送。这两块都要有按结果键查清单的地方（内容库的清单），才有意义（契约第 0 节）。本阶段 sink 的 `has` 只看本机帧库。
2. **任务清单随 `task.done` 传**：清单放进 `task.complete` 的 `result`，队列原样带给订阅方，不经内容库。一段 60 帧快照的清单约 5 KB。
3. **拉取来、但不属于本机任何一版项目的流，只登记键、不推层**：要是按当前那一版推层，会串到别的版本上去（Item 4）。这样的流由会话认领的时候再推。
4. **M5b 必须做的一件事**：切分节点要把 `canvasHeavy` 写进 `task.input`。不写的话，canvas 卡在拉取端会按 300 KB 的上限重新判超限，两边的 `index.json` 就会对不上（契约第 11 节第 2 条）。

## 3. 过程记录

子 Agent 与分工：
- `claude/c6-2-asset`（`opus-dev`）：素材服务命名空间、客户端；
- `claude/c6-2-pipeline`（`opus-dev-high`）：推拉与管线接入；
- `claude/c6-2-tests`（`opus-dev`）。

三份报告的内容已并进本文，原文留在各子分支的提交里。
