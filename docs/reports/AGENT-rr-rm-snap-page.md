# AGENT 报告：rr-rm-snap-page（己二：撤掉每张卡的 HTML 快照 —— 页面与舞台侧）

- 分支：`gemini/rr-rm-snap-page`
- 工作区：`C:\Users\admin\Documents\PromptCut\.worktrees\rr-rm-snap-page`
- 基准提交：`dc89b6e3`（合入 `rr-online-export-stage`）
- 依据：`docs/plan/AGENT-scrub.md` §5、`docs/plan/html-snapshot-removal-dryrun.md` §4.4 & §4.8、`docs/plan/prerender-products-contract.md` §3.1
- 状态：响应主会话【紧急暂停指令】收尾封存提交。

---

## 1. 结论

本子任务聚焦「己二：撤掉每张卡的 HTML 快照」在页面与舞台侧（Page & Stage side）的代码改造、类型系统与单元测试修复。

1. **快照逻辑全量下线**：
   - 父页侧（`snapshotFeed.ts`、`Preview.tsx`、`stageSwap.ts`、`probeRunner.ts`）：彻底移除了每张卡选帧、取字节（`have`/`flying`/`fetchMissing`）、报缺口（`wanted`）、按拍换快照（`beatSwap`）、2MB 切包投递（`deliverSnapshots`）及探针快照趟逻辑。
   - 舞台侧（`Stage.tsx`、`StageView.tsx`、`streamPlayer.ts`）：彻底移除了 `<div data-pc-snapshot-plane="">` DOM 节点、`snapshotPropByClip` 缓存、`.pc-snapshot` 类名、`setSnapshots` 内部应用及 `coverSnapshot` 盖住/露出快照逻辑。
2. **兜底链顺畅衔接**：重卡全面由轨道流承接；流未就绪、缺失或超解码器预算时，在暂停/拖动态进入 `scrub` 挂占位符（120ms 延时显现），可活渲的直接活渲，彻底摆脱垫在下层的「海报快照」。
3. **接口契约向后兼容**：保留了 `pickForSetTime`、`deliverSnapshots`、`topDownOrder`、`markBaselineReset`、`setBeatSwap`、`beatSwapDebug` 等函数的导出签名及舞台 RPC `setSnapshots` 桩，防止上游调用破坏。
4. **验证全绿**：TypeScript 编译零错误（`npx tsc -b --force` exit code 0），受影响的 13 个测试套件 119 项测试 100% 通过；换行审计无翻转；卡片指纹与代码身份完全对齐基线预期。

---

## 2. 变更清单

### 2.1 生产代码（页面与舞台侧）

| 文件 | 变更说明 |
|---|---|
| `src/editor/snapshotFeed.ts` | 移除 `KIND_ORDER`、`Pick`、`PickTier`、选帧主循环、缺口上报 `wanted`、字节缓存/在途拉取 `have`/`flying`/`fetchMissing`、投递基线中的 `mounted`、`diffAgainst`/`packChanges` 投递打包及 `beatSwap` 逻辑。`picks` 恒回空表、`wanted` 恒回空数组、`deliverSnapshots` 退役为返回 0 的空操作。`demoteReady` 仅判流覆盖。在 `resetSnapshotFeed` 中补充 `pendingDemote.clear()` 保证模块单测隔离。 |
| `src/editor/Preview.tsx` | 移除 `deliverSnapshots` 的异步投递微任务循环及相关快照 patch 状态；`syncPlanes` 仅下发 `setStreamPlanes` 与 `setSuppressed`。 |
| `src/editor/stageSwap.ts` | 角色互换流程 `swapAndDress` 中移除对 `deliverSnapshots` 和 `next.setSnapshots` 的调用；非播放态在 `markAllSettled("front")` 后同步派发 `setStreamPlanes` 与 `setSuppressed`。 |
| `src/editor/probeRunner.ts` | 移除 K1 探针中的快照趟（`probe: "snapshot"`、`snapshot` 三段耗时测量及 `probe-frame` 事件转发至 `/api/frames/snapshot`）。仅保留活渲耗时与布尔探针。 |
| `src/StageView.tsx` | 移除 `snapshots` 状态与快照平面更新流；RPC `setSnapshots` 桩退役为空操作返回 `{ ok: true, bytes: 0 }`；移除探针循环中的快照三段计时与帧生成调用；清理快照相关定时器与等待标记。 |
| `src/render/Stage.tsx` | 移除 `<div data-pc-snapshot-plane="">` 节点挂载、`.pc-snapshot` 类名、`snapshotPropByClip` 缓存及 `renameSnapshotIds` 引用；GL 平面跳过判据仅看 `supNow.has(clip.id)`。 |
| `src/render/streamPlayer.ts` | 彻底移除 `coverSnapshot(on: boolean)` 方法及在 `updateShown`、`redraw`、`close`、`setPlane`、`dispose` 各处调用，播放器无需再主动掩盖快照。 |

### 2.2 测试用例同步更新（全部 100% 通过）

| 测试文件 | 适配修改说明 |
|---|---|
| `src/editor/snapshotFallback.test.mjs` | 更新 5 处过时的 HTML 快照断言：`picks` 恒为空表、超出预算/无流重卡暂停态断言进入 `scrub` 待占位符、断言 `deliverSnapshots` 返回 0 且不发起任何快照取包与 RPC。7/7 通过。 |
| `src/editor/snapshotFeedScrub.test.mjs` | 验证有流不读快照、无流进 scrub、settled 解除抑制、超预算/低内存档行为。11/11 通过。 |
| `src/editor/snapshotSettled.test.mjs` | 验证 `noteSettled`、`clearSettled` 及 `markAllSettled` 对抑制与贴流状态的控制。4/4 通过。 |
| `src/editor/snapshotFeed.test.mjs` | 适配快照完全退役后的空表返回与向后兼容接口。17/17 通过。 |
| `src/editor/stageSwap.test.mjs` | 移除对 `setSnapshots` 调用的断言，改为断言 `setStreamPlanes`、`setSuppressed` 并确认未调用快照投递。31/31 通过。 |
| `src/editor/stageSwapBaseline.test.mjs` | 验证角色互换基线传递。通过。 |
| `src/editor/snapshotSubscription.test.mjs` | 验证 SSE 就绪索引订阅与 reset 处理。通过。 |
| `src/editor/snapshotFeedBelow.test.mjs` | 验证依赖下层的流输入签名比对。通过。 |
| `src/editor/snapshotFeedBelowOnline.test.mjs` | 验证在线模式下层流行为。通过。 |
| `server/test/c10-beat-swap.test.mjs` | 适配 beatSwap 退役后接口与流播放稳定性。7/7 通过。 |
| `server/test/c10-ui-gates.test.mjs` | 验证降级与 UI 闸口。7/7 通过。 |
| `src/render/streamPlayer.test.mjs` | 验证流播放器各时钟、预算、画布复用逻辑无回归。通过。 |
| `src/render/staleLayer.test.mjs` | 验证输入签名变更时旧流撤销。通过。 |

---

## 3. 验证证据

### 3.1 类型检查与单元测试
- **TypeScript 严格类型检查**：
  ```bash
  npx.cmd tsc -b --force
  # 退出码 0，零错误
  ```
- **核心单测集全量回归**：
  ```bash
  node scripts/test-suite.mjs src/editor/snapshotFeed.test.mjs src/editor/snapshotFeedScrub.test.mjs src/editor/snapshotSettled.test.mjs src/editor/snapshotFallback.test.mjs src/editor/snapshotSubscription.test.mjs src/editor/snapshotFeedBelow.test.mjs src/editor/snapshotFeedBelowOnline.test.mjs src/editor/stageSwap.test.mjs src/editor/stageSwapBaseline.test.mjs server/test/c10-beat-swap.test.mjs server/test/c10-ui-gates.test.mjs src/render/streamPlayer.test.mjs src/render/staleLayer.test.mjs
  # 结果：119 pass, 0 fail，耗时 5.5s
  ```

### 3.2 换行符与代码纯净度审计
- **EOL 换行符审计**：
  ```bash
  node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD
  # 输出空，0 处换行符翻转
  ```
- **分层与循环依赖检查**：
  ```bash
  node scripts/test-suite.mjs src/layering.test.mjs
  # 结果：3 pass, 0 fail
  ```

### 3.3 卡片身份与指纹比对
- **内置卡身份比对**：
  ```bash
  node scripts/probes/card-table-digest-compare.mjs --expect focus-card,lottie,probe-slow,probe-slow-stepped,terminal-3d,particles
  # 结果：退出码 0。其余 95 张内置卡能力表、源码版本、三个键逐张完全相同；6 张变化卡均属经 kernel/clock 间接依赖 streamPlayer.ts 的预期范畴（与 AGENT-rr-scrub.md §10.1 完全对齐）。
  ```
- **源码版本比对**：
  ```bash
  node scripts/probes/card-source-version-compare.mjs --base main
  # 结果：61 个身份变 0；88 个入口中仅上述 10 个关联入口变动，符合预期。
  ```

---

## 4. 当前停在哪一步与待跑项

1. **当前状态**：
   - 生产代码改动已全部完成；
   - 所有 13 个相关测试套件 119 项测试全部 100% 通过；
   - `tsc` 类型检查零错误；
   - 换行符审计 0 翻转。
2. **待跑的长探针**：
   - 端到端长探针 `scripts/probes/scrub-stream-probe.mjs`：收到主会话紧急暂停指令后已终止其后台运行。该探针主要测试点选跳帧、按住标尺拖动等浏览器 E2E 交互。在单元测试层面（`snapshotFeedScrub`、`snapshotFallback`、`stageSwap`、`streamPlayer`），相关兜底与流平面逻辑已全数覆盖并通过。
3. **已知的未通过测试**：
   - 无。所有属于本子任务 scope 的单元测试与集成测试均通过，零失败。

---

## 5. 遗留与后续协同

1. **子任务工作区提交**：已按指令将工作区全部修改及本报告 `git commit` 保存于分支 `gemini/rr-rm-snap-page`。
2. **后续协同**：等待主会话协调与服务端子任务（`rr-rm-snap-node`）的联合验收与合并。
