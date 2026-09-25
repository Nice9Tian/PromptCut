# 报告：渲染任务队列 M5b（队列接真业务、指纹前置过滤、项目快照、真实执行器、跨机渲染）

集成分支 `claude/rq-m5b`。2026-09-25 验收通过，按「阶段验收全过即自动合并」合入 main。

- 计划：`docs/plan/Master-Execution-Plan.md` 第 5.3 节、第 7 节 M5b、第 11 节（权限边界与推迟项）
- 契约：`docs/plan/render-queue-contract.md` I 节（指纹前置过滤，含 I.10）、J 节（M5b 主体，含 J.10～J.13）
- 设计附件：`docs/plan/queue-executor-design.md`

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`，连跑两遍 | 两遍都是 tests 2445、pass 2444、fail 0、skipped 1（照旧需要 5190 的那条） |
| 测试稳定性 | 排障分支 `claude/flaky-fix` 连跑 20 遍 | 0 次失败，见第 3 节 |
| 新增测试（测试方只照契约写，没看实现） | `render-queue-prefilter`（V1～V4、K1～K7）、`project-snapshot`（J1～J4）、`queue-node-wiring`（J5～J7）、`prerender-executor`（J8～J11）、`docservice-pending`（C8、C9）、`safe-port`、`frame-archive-spill`、`bad-ports` | 全过 |
| 防锁风暴（K1，自测与测试同口径） | 两种指纹各 4 个节点，200 个任务 | 过滤开：`card-locked` 拒绝 0 次；过滤关：400 次。不匹配的节点收到已锁卡的 `task.opened` 0 条 |

**G0-R，开关关**（主 Agent 在 5530 上跑）：
- `verify-determinism` 1800/1800；
- `verify-unified-frames` PASS；
- `preview-fallback-probe` 两种、`stream-produce-probe` 两种，全部退出码 0；
- `ready-index-probe` 在同一个 worktree 里连跑两遍，都是 `fails: []`（J.12 第 2 条修正后）。

**G0-R，开关开**（实现方）：
- `verify-determinism` 1800/1800，与 main 0 像素差；
- `verify-unified-frames` PASS；
- `queue-mode-probe` 退出码 0：5 个任务都由本机节点完成。队列模式与普通模式的帧库文件相同、`index.json` 逐字节相同。差异只在 `style` 声明的先后，两趟普通模式之间也一样，见第 2 节第 3 条。

### 跨机 W3、W4（主 PC 192.168.50.96 × 笔记本 192.168.50.247 × 远端控制面 8.219.80.16:8787）

笔记本在 `claude/rq-m5b` @ `58fe54c` 上，以 `PROMPTCUT_QUEUE_NODE=1` 起预渲染进程，只当节点。
- 它的 `frameCode` 是 `3978093a…`，与主 PC 相同；指纹 `258acaaa7c5fe509` 也相同。
- 主 PC 跑 `queue-mode-probe --only queue --lan --docservice-url ws://8.219.80.16:8787`，并登记自己的素材服务。

| 编号 | 结果 | 证据 |
|---|---|---|
| 素材服务按 D7 选 | ✓ | 主 PC 登记之后，笔记本的 `assetBase` 从 `http://127.0.0.1:5540/api/asset` 自动换成 `http://192.168.50.96:5540/api/asset`；主 PC 撤回登记后又换回来 |
| 远端做计划 | ✓ | 笔记本认领 `plan:queue-mode-probe@1`、`@2`，经 `project.snapshot.get` 取项目，`executor.plan` 切出 5 个快照任务（`controls: 3`、`locks: 0`） |
| **W3 换机不重渲** | ✓ | `@1` 的 5 个任务在笔记本上全部走去重（`node.dedup` ×5），从主 PC 的素材服务拉了 240 帧写入本机，0 次渲染 |
| **W4 笔记本真实渲染** | ✓ | `@2`（`--salt`，内容全新）有 3 个任务在笔记本上实际渲染：`5395a355…:60-89`（共享档 `clip-canvas`，12.7 s）、`5395a355…:0-59`（20.4 s）、`e2188925…:0-59`（本地档 `clip-unknown`，5.1 s）。另外 2 个是 `r6-stateful` 卡的，它的内容键不含探针的 params，按设计去重 |
| 主 PC 拉回 | ✓ | 主 PC 本机节点 `localCompleted 0`（全程）。它的帧库里有 `controls-html/5395a355…`（90 帧，`[[0,89]]`）与 `controls-local/402d6b6e…/d2a7169f…`（60 帧）。`402d6b6e…` 与笔记本 `executor.plan` 的 entryKey 完全一致；`readyLayers` 为 3 |
| 零失败 | ✓ | 笔记本 `failed 0`、`lost 0`、`applyErrors 0`；主 PC 探针 `ok: true`、`fails: []` |

**第一次 W4 失败了，原因在主 Agent**：远端控制面没有重新部署，还是 C6.3 那一版，不认 `project.snapshot.put`，`plan` 发布不出去。重新部署后正常。以后每个阶段合并前，先把远端部署到集成分支。

## 2. 与对齐时不一致的地方，以及推迟项

1. **页面不改**：`plan` 由预渲染进程替页面发（J.0）。页面自己发布，推迟到 C6.5。
2. **流不走队列**（J.0），推迟到 M6。
3. **快照 style 声明的顺序跨进程不确定**：同样内容的块哈希不同，会重复上传，不影响正确性。推迟到 M6。
4. **计划第 11.2 节登记的其余推迟项**：`plan` 指纹不过滤认领、闲时门槛、`readSpill` 改异步、远端卡没有 PNG 缓存。都排在 M6。
5. **`queue-mode-probe` 的 `nodes`、`announcedAsset` 两个输出字段在跨机模式下是空的**：这只是探针的汇总问题。节点与登记情况以两台机器的诊断为证据（见上表）。推迟到 M6 的探针整理。

## 3. 过程中修掉的问题（不在 M5b 原范围）

- **测试偶发失败的根因**（`claude/flaky-fix`）：
  - 这台机器的动态端口范围（1024 起）盖住了 Node fetch / WebSocket 直接拒绝的「坏端口」，测试服务器被分到这些端口就连不上；
  - 修法：`npm test` 用全局 setup 在整个运行期间占住这些端口；另修了 `artifact-push` 测试自己的竞态；
  - 修后连跑 20 遍 0 失败。本机端口范围记在 `docs/local.md`。
- **产品 bug：预渲染进程可能拿到坏端口**（浏览器 `ERR_UNSAFE_PORT`）。新增 `server/safe-port.mjs`，`freePort()` 改用它。
- **产品 bug：`LazyFrameStore.readSpill` 把暂时性的读错误当成文件损坏，把文件删掉**。改为退避重试、不删。
- **取回快照触发 1013**：核心新增 `ctx.pendingBytes`，项目模块按积压节流（J.11）。慢到每秒 0.5 MiB 的链路也能完整取回 5 MiB 快照。

## 4. 过程记录

子 Agent 与分工：
- 队列部分：`claude/rq-m5b-queue`（`opus-dev-high`）、`claude/rq-m5b-queue-tests`（`opus-dev`）；
- 主体：`claude/rq-m5b-svc`（`opus-dev`）、`claude/rq-m5b-node`（`opus-dev`）、`claude/rq-m5b-pipeline`（`opus-dev-high`）、`claude/rq-m5b-tests`（`opus-dev`）；
- 排障：`claude/flaky-fix`（`opus-dev-high`）、`claude/m5b-fixes`（`opus-dev`）；
- 设计附件由一个只读的架构子 Agent 起草。

各子报告（`docs/reports/AGENT-*.md`，8 份）这次没有删除：主 Agent 的删除命令被本机的安全钩子拦下。内容已并进本文，那 8 份留作原始记录。
