# 报告：C6.4 产物清单、跨节点去重与无条件推送

集成分支 `claude/c6-4`。2026-09-25 本机验收通过，按「阶段验收全过即自动合并」合入 main。跨机的 W3 并入 M5b 的 W4 一起做，理由见第 2 节。

- 计划：`docs/plan/Master-Execution-Plan.md` C6 一节 C6.4 行
- 契约：`docs/plan/manifest-contract.md`（第 9 节是定稿后补的细则）

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | tests 2376、pass 2375、fail 0、skipped 1 |
| 新增测试（测试方只照契约写，没看实现） | `content-client`（Q）、`artifact-dedup`（U）、`artifact-push`（W）、`artifact-adopt`（A） | 7 + 7 + 7 + 3，全过；W4 经一轮返工（契约第 9 节第 1 条） |
| 导出确定性（主 Agent 重跑） | `verify-determinism`（5500） | 1800/1800 相同 |
| 导出与快照重放（主 Agent 重跑） | `verify-unified-frames` | PASS |
| 导出像素基线与预渲染探针（实现方跑，没配推送队列） | 对 main（`4665995`）逐像素比较；`ready-index-probe`、`stream-produce-probe`（含 `--group`）、`preview-fallback-probe`（含 `--page-preload`） | 1800 帧 0 不同；各探针退出码 0；诊断里没有 `push` 键，没写 `push-queue.json` |

## 2. 与对齐时不一致的地方

1. **决议 11 没有改**：清单按段拆键（`<resultKey>:<from>-<to>`），不同节点产的不同段写的是不同的键。独立审查担心的「并发产同一张卡的不同段、后写的清单覆盖前者」因此不会发生。
2. **W3 并入 M5b 的 W4**：换机取用要求笔记本从主 PC 的素材服务拉块，而预渲染进程的素材客户端现在只认本机编辑器的素材服务。「按服务地址登记回退到别处的素材服务」在契约 J.6，属于 M5b。两个跨机验证用同一次笔记本会话做。
3. **只开编辑器时不推送**：发现编辑器里挂的文档服务在契约 J.3，属于 M5b。现在只有设了 `PROMPTCUT_DOCSERVICE_URL`、或者回环 8787 上有独立文档服务时，才建推送队列。
4. **优先级取三者最低**：推送队列把调用方给的级别、按卡能看出的下限（流、本地档、`canvasHeavy`）、块级（`data:image` 比例、超体积）三者取最低，比契约第 9 节第 2 条「调用方给的就是最终级别」更保守。经钩子进队时，结果与第 4 节的表相同。主 Agent 裁定保留。
5. **`stop()` 不等在飞的推送**：只停止开新段、写回队列文件就返回。在飞的推送自己落定：成功就出队，失败就留在文件里。这是为了避免关闭时互相等待。

## 3. 过程记录

子 Agent 与分工：
- `claude/c6-4-node`（`opus-dev`）：内容库客户端；
- `claude/c6-4-pipeline`（`opus-dev-high`）：去重、推送队列、换机取用、接线；
- `claude/c6-4-tests`（`opus-dev`）。

三份报告的内容已并进本文，原文留在各子分支的提交里。
