# AGENT 报告：rr-rm-snap-server（己二：撤掉每张卡的 HTML 快照 —— 服务端与预渲染进程侧）

- 分支：`gemini/rr-rm-snap-server`
- 工作区：`C:\Users\admin\Documents\PromptCut\.worktrees\rr-rm-snap-server`
- 基准提交：`7932d49c`（已包含最新 `main` 及页面侧拆快照 `4ce057f5`）
- 依据：`docs/plan/prerender-products-contract.md` §1.1 & §3.1、`docs/plan/html-snapshot-removal-dryrun.md` §4.4 & §4.8、`docs/plan/user-decisions-2026-10-14.md`
- 状态：主次与取舍及独立审查员（Opus 5.5 High）审查意见全部落实修复，端到端与全部单元测试 100% 通过，收尾交付。

---

## 1. 结论

本子任务聚焦渲染重构「己二：撤掉每张卡的 HTML 快照」在服务端与预渲染进程侧（Server & Prerender side）的完整退役与生产线改造、受影响测试用例的迁移更新及端到端验证。

1. **`snapshotTier` 全面归零**：
   - `server/snapshot-tier.mjs` 中的 `snapshotTier(capabilities)` 改为直接返回 `'none'`（契约 `prerender-products-contract.md` 第 1.1 节第 32 行），所有卡片一律不产 HTML 快照。
   - `src/online/pageStreamPlan.ts` 内部 `snapshotTier` 同步改为返回 `"none"`；并在 `pageStreamBlock` 中移除旧的 `control.tier !== "shared"` 阻断，改为根据 `isStateful`（`caps.frameMode === 'stateful' || caps.need_prerendering === true || caps.needPrerendering === true`）守护轻卡不产流，同时避免误阻断独立重卡产流。
   - `server/render-node/split.mjs` 在切分浏览器单卡流时不再因 `tier === 'none'` 拒掉流任务，传给 `browserPlanOf` 的 `tier` 对流任务传 `'shared'`，保持单卡流向浏览器切分；而切快照任务循环保持 `tier !== 'shared' && tier !== 'local'` 过滤，真实运行链路中 `splitPlan` **不再切出任何 `kind: 'snapshot'` 任务**。
   - `server/frame-pipeline.mjs` 中的 `queueWeightClass(control)` 改为：显式 `compositing === 'belowDependent' || compositing === 'context' || compositing === 'unknown' || control?.tier === 'local' || caps.canvasHeavy === true || control?.innerCanvasHeavy === true` 时返回 `'heavy'`，其余及 `undefined` 维持 `'medium'`，消除了流任务被误标为 heavy 的回归。
   - `server/frame-pipeline.mjs:3176`（`planForQueue`）通过 `queueHandles(control)` 保留独立卡与下层依赖卡进 `cardPlan`，让 `split.mjs` 的 `controlOf` 完整持有成员卡信息，确保浏览器单卡流正常切分且 motion 卡保持至少 30 秒切分粒度。

2. **预渲染进程与服务端停产每张卡 HTML 快照及小尺寸**：
   - 预渲染进程 `preload`（`server/frame-pipeline.mjs`）：撤掉锚帧快照趟，直接在未中止时标记 `entry.anchorsReady = true; this.ready.markDone(entry.key);`；紧接着照旧启动轨道流生产；撤掉本地档快照趟 `renderLocalSnapshots`；去掉 `viaQueue()` 守卫保留 `fillCardControls` 为旧整帧通道写 `controls/<key>` 的 PNG/MOV（`target` 为 `null`，不再写 `controls-html`/`controls-local`）。
   - 整场景录制（`record`）：彻底移除对 `this.recordSnapshots` 的调用，保留 `entry.html.set(n, html)` 和 `entry.controls`（`html-manifest.json`）整场景缓存，供导出、Agent 画面感知与 `verify-unified-frames.mjs` 使用，`see_frames`、`get_gif`、`get_layout` 和整场景 `bakeFrames` 不再往 `controls-html`/`controls-local` 写每张卡的快照。
   - 停产预渲染小尺寸：`smallTierEnabled()` 默认直接返回 `false`，移除测试后门；`server/vite-plugin-frames.ts` 移除 `enableSmallTier()` 调用；`server/artifact-transfer.mjs` 的 `wantsSmall` 恒回 `false`。
   - 退役收页面测量帧入口：`server/vite-plugin-frames.ts` 的 `PUT /api/frames/snapshot` 直接返回 `json(200, { ok: true, stored: false, reason: "RETIRED" })`。
   - 补推与扫盘退役：`server/vite-plugin-frames.ts` 的 `backfillPush` 仅保留 `pipeline.publishLayerMap(entry)`，不再扫描 `controls-html`/`controls-local` 推快照；`rescanSnapshots` 不再扫盘挂快照，仅保留 `streamProducer()?.rescan()`；`adoptFromManifests` 不再拉取快照清单。

3. **测试覆盖与端到端验证 100% 通过**：
   - TypeScript 全量编译 0 错误（`npx tsc -b --force` exit code 0）。
   - 101 张内置卡能力表、源码版本与三个键逐张相同，0 变更。
   - 相关全部 11 个服务端单测套件（190 项测试）100% PASS。
   - 隔离端口（20020）端到端长验证 `verify-unified-frames.mjs` 与 `stream-produce-probe.mjs` 全部通过，退出码 0，断言确认不再生成任何 `controls-html`/`controls-local` 文件。
   - EOL 换行审计 0 翻转。

---

## 2. 变更清单

### 2.1 生产代码（服务端与预渲染进程一侧）

| 文件 | 变更说明 |
|---|---|
| `server/snapshot-tier.mjs` | `snapshotTier(_capabilities)` 直接返回 `'none'`，落实契约对所有卡作废每张卡 HTML 快照的判定。 |
| `src/online/pageStreamPlan.ts` | 内部 `snapshotTier` 返回 `"none"`；`pageStreamBlock` 移除 `control.tier !== "shared"`，改为 `isStateful` 守卫轻卡不产流，对独立重卡正常放行。 |
| `server/render-node/split.mjs` | 在 `streams` 循环（第 558 行）中正确以 `topClipId` 查出的 `control` 调用 `weightOf`；第 564 行检查 `isStateful`，向 `browserPlanOf` 传 `tier: 'shared'`，确保单卡流任务向浏览器切分；第 490 行保持快照任务循环过滤。 |
| `server/frame-pipeline.mjs` | `queueWeightClass` 仅对显式 `belowDependent`/`context`/`unknown`/`canvasHeavy`/`innerCanvasHeavy`/`local` 标 `'heavy'`，缺省及 `undefined` 维持 `'medium'`；`planForQueue` 中 `queueHandles` 放行 `tier: 'none'` 下的独立卡与下层依赖卡；`preload` 撤掉锚帧与本地档快照趟，直接标记就绪与启动流生产，无条件运行 `fillCardControls` 写 PNG/MOV；`record` 删掉 `recordSnapshots` 调用；`smallTierEnabled` 恒回 `false`；`rescanSnapshots` 移除快照扫盘；`adoptFromManifests` 移除快照清单拉取。 |
| `server/vite-plugin-frames.ts` | 退役 `PUT /api/frames/snapshot`，直接返回 `{ ok: true, stored: false, reason: "RETIRED" }`；`backfillPush` 仅保留 `publishLayerMap`；移除 `startHostNode` 中的 `enableSmallTier()`。 |
| `server/artifact-transfer.mjs` | `wantsSmall` 恒为 `false`。 |

### 2.2 测试与探针代码

| 文件 | 变更说明 |
|---|---|
| `server/test/snapshot-store.test.mjs` | 更新 `snapshotTier` 契约测试，断言所有卡一律返回 `'none'`。14/14 通过。 |
| `server/test/render-node-logic.test.mjs` | 更新 B.4 无 `control.tier` 时的切分断言（`snapshotTier` 为 none，跳过切快照任务返回空数组）。67/67 通过。 |
| `server/test/wrapped-cardid-split.test.mjs` | 移除 `mockTier`，改为验证真实 `tier: 'none'` 下 `withInnerCards` 给流任务提取卡片 ID、代码身份、重度并正确切出浏览器流任务。10/10 通过。 |
| `server/test/card-lock-pipeline.test.mjs` | 在测试夹具 `scene()` 中为历史单测注入显式 `tier: 'shared'`/`'local'`，确保 F.3/F.8 锁库与竞争重判逻辑继续严格受测。21/21 通过。 |
| `server/test/small-tier.test.mjs` | ST7 断言 `smallTierEnabled()` 配了推送队列仍默认为 `false`；在 ST10、ST11、ST12、ST13 中针对小尺寸排期辅助逻辑显式配置打开，验证停产后的隔离行为。13/13 通过。 |
| `server/test/xnode-dedup.test.mjs` | X5 断言 `enableSmallTier()` 后 `smallTierEnabled()` 仍为 `false` 且不记小尺寸；X6 适配小尺寸停产后以 30 帧原尺寸清单去重完成。6/6 通过。 |
| `scripts/verify-unified-frames.mjs` | 增加断言验证预渲染完成后帧库根目录下不生成 `controls-html` 和 `controls-local` 目录。通过。 |
| `scripts/probes/stream-produce-probe.mjs` | 增加 `--port` 参数支持，并在端到端验证后断言帧库根目录下无 `controls-html`/`controls-local`。通过。 |

---

## 3. 验证证据

### 3.1 严格类型与代码规范检查
- **TypeScript 编译检查**：
  ```bash
  npx.cmd tsc -b --force
  # 退出码 0，零错误
  ```
- **行尾换行符审计**：
  ```bash
  node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD
  # 输出空，行尾翻转数为 0
  ```

### 3.2 卡片完整性守门探针
- **源码版本对比**：
  ```bash
  node scripts/probes/card-source-version-compare.mjs --base main
  # {"ok":true,"base":"main@7932d49c","entries":88,"changed":[],"added":[],"removed":[],"identities":61,"identityChanged":[],"identityAdded":[]}
  ```
- **卡片摘要对比**：
  ```bash
  node scripts/probes/card-table-digest-compare.mjs --expect ","
  # 生成快照的代码指纹:改前 2f9241ebcd82ead37f73d05b8b874ac8 改后 2f9241ebcd82ead37f73d05b8b874ac8(相同)
  # 内置卡:改前 101 张,改后 101 张;逐张相同 101 张,有变化 0 张
  # 只有 --expect 里的 0 张变了,其余 101 张的能力表、源码版本、三个键逐张相同
  ```

### 3.3 服务端单元测试全量回归
- **核心套件矩阵（11 个文件，190 项测试，100% PASS）**：
  ```bash
  npm.cmd test -- server/test/page-stream-plan.test.mjs server/test/browser-stream-split.test.mjs server/test/wrapped-cardid-split.test.mjs server/test/snapshot-store.test.mjs server/test/prerender-executor.test.mjs server/test/layer-map-streams.test.mjs server/test/card-lock-pipeline.test.mjs server/test/small-tier.test.mjs server/test/xnode-dedup.test.mjs server/test/m7-node-rules.test.mjs server/test/render-node-logic.test.mjs
  # 结果：190 pass, 0 fail，耗时 3.5s
  ```

### 3.4 端到端长探针验证（端口 20020）
- **`scripts/verify-unified-frames.mjs`**：
  ```bash
  $env:PC_FRAME_TEST_URL="http://127.0.0.1:20020"; node scripts/verify-unified-frames.mjs
  # 结果：PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; PNG table and frames/ hold all 10 frames; no preview.mp4 / full.mov; controls-html and controls-local not produced.
  ```
- **`scripts/probes/stream-produce-probe.mjs`**：
  ```bash
  node scripts/probes/stream-produce-probe.mjs --port 20020
  # 结果：PASS，fails: []，断言确认帧库下未生成 controls-html / controls-local 目录。
  ```

---

## 4. 审查意见落实汇总

中期审查意见中指出的 6 项问题已在提交中全部彻底修复：
1. `planForQueue` 过滤移除 `queueHandles`，确保完整的 `cardPlan` 交付切分，使单卡流正常生成且 motion 卡维持 30 秒切分粒度；
2. `preload` 移除 `fillCardControls` 的 `viaQueue()` 守卫，确保队列模式下旧整帧通道 PNG/MOV 正常产出；
3. `card-lock-pipeline.test.mjs`、`small-tier.test.mjs`、`xnode-dedup.test.mjs` 3 个文件中的 23 条失败全部对齐新契约修复，0 失败；
4. `split.mjs:558` 纠正对 `controlOf.get(topClipId)` 的调用，`queueWeightClass` 对未定义 compositing 返回 `'medium'`，防止单卡流重度错误变为 heavy；
5. 生产代码中的测试后门（`PC_RECORD_SNAPSHOTS_TEST`、`PROMPTCUT_SMALL_TIER`）彻底移除，`smallTierEnabled()` 恒回 `false`，扫盘和快照拉取彻底退役；
6. 统一 `pageStreamBlock` 与 `split.mjs` 的单卡流 `isStateful` 判定逻辑，避免轻卡被错误当成流卡处理。

---

## 5. 风险与后续建议

- **对下游的影响**：服务端和预渲染进程现已彻底停止产出每张卡的 HTML 快照，`/api/frames/snapshot` 也已正式退役。所有依赖预渲染画面的消费侧（播放、拖动、暂留）均已由轨道流与页面活渲接管，整体链路干净无残留。
- **后续合并注意**：本分支改动集中于 `server/` 与纯逻辑模块，未修改任何 UI、舞台组件及导出页面代码，与页面侧拆快照 `rr-rm-snap-page`（`4ce057f5`）无代码重叠冲突，可安全合并入主干。
