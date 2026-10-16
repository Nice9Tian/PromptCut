# 0.7.18 撤快照后 8 个测试文件（14 条失败）修复报告

分支：`gemini/v18-fix-snap-tests`（基于基线 `e40065cc`）
日期：2026-10-17

---

## 一、背景与问题根因

在 `VERIFY-main-2026-10-17.md` 全量测试核对第 4.2 节中，记录了因「己二：撤除每张卡的 HTML 快照（页面与舞台侧，`59b85f09`～`35b0a803`）」引入的 8 个测试文件（共 14 条测试失败）。
依据用户 2026-10-13 决策第 1 条（每张卡的 HTML 快照作废）及 2026-10-14 决策第 2.1 节（预渲染小尺寸随撤快照删掉），每张卡的 HTML 快照平面、快照打包投递、按拍换快照、快照预取与小尺寸缩略图已全面退役，重卡与在线不能运行的卡全面由轨道流（`stream`）及抑制占位（`suppressed` / 沙漏与徽标）接管。

本任务逐条核实了失败项背后的代码是否存在空指针、回归隐患，并在核实无隐患后，将过时的旧快照测试全面更新至契约新行为。

---

## 二、逐条核实与修改明细

### 1. `c10-beat-feed`（4 条失败）
- **涉及文件**：`src/editor/c10-beat-feed.test.mjs`
- **核实结果**：
  1. 旧测试在 `C10-BF-02`、`ST-A-08` 中访问 `beatSwapDebug().last.fit` / `beatSwapDebug().last.swap` 时报 `Cannot read properties of null`。经全代码库审计，生产代码中仅 `src/editor/Preview.tsx:1745` 引用了 `beatSwapDebug()` 并直接挂入页面诊断对象 `window.__pcDiag`，无任何下游代码解构 `.last` 属性，`snapshotFeed.ts` 返回的兼容桩对象 `{ on, swapMs: 0, perLayer: false, knownSizes: 0, last: null, ... }` 安全可靠，无运行期空指针风险。
  2. `deliverSnapshots` 在撤快照后退役为安全空操作：在播放中清理 settled 标记，返回 0，不派发任何快照 RPC 到舞台。
- **修改方式**：
  - `C10-BF-01`：断言 `deliverSnapshots` 在播放中清空 settled，返回 0，不向舞台派发快照 RPC；播放中重卡全量进入 `suppressedAt`；保留 33ms 节流常量与 `setBeatSwap` 开关兼容验证。
  - `C10-BF-02`：保留 `topDownOrder` 层序计算验证；验证撤快照后重卡全部进入 `suppressedAt` 抑制集合，`deliverSnapshots` 返回 0，`beatSwapDebug()` 返回安全桩对象无空指针。
  - `ST-A-08`：验证 `setBeatSwap` 接收 `costOf` 参数保持接口签名兼容；撤快照后播放中重卡全量抑制，`deliverSnapshots` 返回 0。
  - `ST-A-09`：验证撤快照后不再按快照大小记录与装箱（`knownSizes: 0`），换帧成本模型纯函数保持兼容，`beatSwapDebug()` 兼容且无空指针。

### 2. `c10-l3-source`（4 条失败）、`m7-alive-source`（1 条失败）、`hosted-render-capacity` HR21h（1 条失败）
- **涉及文件**：
  - `src/render/c10-l3-source.test.mjs`
  - `src/render/m7-alive-source.test.mjs`
  - `server/test/hosted-render-capacity.test.mjs`
- **核实结果**：
  - 己二撤掉每张卡的 HTML 快照和预渲染小尺寸（`.small.webp`）后，`OnlineSnapshotSource` 在 `tickOnce()` 中彻底移除了旧快照自动预取 `this.prefetchWindow()`（commit `daa226d2`）。
  - `OnlineSnapshotSource` 不再主动拉取已废弃的每张卡 HTML 快照块（`snap/<hash>`）和小尺寸块（`px/<hash>`），仅保留轨道流（`stream`）清单预取与分段拉取。
  - 主动调用 `fetchSnapshot(kind, key, localFrame)` 仍保留按需拉取单帧快照的能力。
- **修改方式**：
  - `c10-l3-source.test.mjs`：
    - `C10-L3-2`：断言撤快照后不自动预取原尺寸快照块（`snap/`）和小尺寸块（`px/`）；按需调用 `fetchSnapshot` 凭只读票据拉取并写进 L2 缓存；环境指纹正常读取。
    - `C10-L3-3`：首次运行按需获取块并记录 ranges 存入 L2，第二次以相同 L2 启动，断言重开后不发多余网络请求，直接命中 L2 缓存就绪。
    - `C10-L3-4`：断言撤快照后不自动预取原尺寸快照块；保留 v1 层表普通档不认且零请求的断言。
    - `C10-L3-5`：断言撤快照后不自动预取小尺寸块；按需获取单块存入 L2，重开后命中缓存零网络请求。
  - `m7-alive-source.test.mjs`：
    - `M7-AS-01`：验证收到队列 `task.done` 事件后整层正确换键为 `R-page` 且环境指纹切换为 `fp-page`；断言不自动预取快照块；通过按需调用 `fetchSnapshot` 验证确实按活着那一份的清单取块（`snap/${H(5000)}`）。
  - `hosted-render-capacity.test.mjs`：
    - `HR21h`：验证撤快照后页面不自动发废弃的快照块预取；清单还列着时页面正确认为该层整段有产物且不误触发补渲；主动按需拉取被淘汰的块时触发 404 并记录错误（`src.stats.errors > 0`）。

### 3. `c10a-swap-gate`（整文件失败）与 `onlineCardsL` 的 `OCE-L-06`（1 条失败）
- **涉及文件**：
  - `src/editor/c10a-swap-gate.test.mjs`
  - `src/editor/onlineCardsL.test.mjs`
- **核实结果**：
  - `c10a-swap-gate.test.mjs`：在 commit `59b85f09` 中，`stageSwap.ts` 引入了从 `snapshotFeed.ts` 导入的 `clearSettled`，而测试用例的 `mock.module` 漏掉了 `clearSettled` 导出，导致整文件在 ESM 实例化阶段报 `SyntaxError`。
  - `onlineCardsL.test.mjs`（`OCE-L-06`）：该守门测试断言 6 个文件必须使用统一的判法函数 `localOnlyClipIds`。撤快照前 `stageSwap.ts` 仅在 `swapAndDress` 暂停态为 localOnly 卡补投快照时调用了 `localOnlyClipIds`；撤快照后快照投递已移除，流平面与抑制统一由 `snapshotFeed`（`streamPlanesAt` / `suppressedAt`）接管，`stageSwap.ts` 无需也不应重复判断 `localOnly`。
- **修改方式**：
  - `c10a-swap-gate.test.mjs`：在 `snapshotFeed.ts` 的 mock exports 中补齐 `clearSettled: () => {}`，两项低内存闸门测试顺利执行并通过。
  - `onlineCardsL.test.mjs`（`OCE-L-06`）：活跃模块（`costIdentity.ts`、`snapshotFeed.ts`、`StageView.tsx`、`Stage.tsx`、`ClipView.tsx`）继续断言走统一判法；对 `stageSwap.ts` 断言其不自行使用 `isUserCardId`，与当前生产代码架构完全对齐。

### 4. `stageLocalOnly` SL-01（1 条失败）与 `streamFallback`（1 条失败）
- **涉及文件**：
  - `src/render/stageLocalOnly.test.mjs`
  - `src/render/streamFallback.test.mjs`
- **核实结果**：
  - `Stage.tsx` 中的 `<div data-pc-snapshot-plane="">` 节点已在 `59b85f09` 彻底删除；
  - `streamPlayer.ts` 中的 `coverSnapshot` 盖住/露出快照方法也已彻底删除。
- **修改方式**：
  - `stageLocalOnly.test.mjs`（`SL-01`）：无流的同步卡在暂停态由 `pc-suppressed` 遮罩与占位槽位接管，不再挂快照平面，断言 `assert.doesNotMatch(s, /data-pc-snapshot-plane/)` 与 `assert.match(s, /class="pc-suppressed"/)`。
  - `streamFallback.test.mjs`：更新用例为「组流清空时，流画面清空；撤快照后不操作快照平面，由流平面与占位接管」，断言 `assert.deepEqual([...player.showingClips()], [])`。

---

## 三、验证结果

1. **TypeScript 严格类型检查**：
   ```bash
   npx.cmd tsc -b --force
   ```
   结果：退出码 0，零错误。

2. **本组 8 个测试文件及关联快照/流测试（共 12 个文件，70 项测试）**：
   ```bash
   npm.cmd test -- src/editor/c10-beat-feed.test.mjs src/render/c10-l3-source.test.mjs src/editor/c10a-swap-gate.test.mjs src/editor/onlineCardsL.test.mjs src/render/m7-alive-source.test.mjs src/render/stageLocalOnly.test.mjs src/render/streamFallback.test.mjs server/test/hosted-render-capacity.test.mjs src/editor/snapshotFeed.test.mjs src/render/staleLayer.test.mjs server/test/c10-beat-swap.test.mjs server/test/c10-ui-gates.test.mjs
   ```
   结果：**70 tests, 70 passed, 0 failed**，全量 100% 通过。

3. **换行符审计**：
   ```bash
   node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . e40065cc HEAD
   ```
   结果：输出为空，0 处换行符翻转。

4. **变更文件范围核实**：
   仅修改了允许的 8 个测试文件，严禁修改的生产目录与模块 0 触碰。

---

## 四、Opus 审查优化项（已同步落地）

1. **`c10-l3-source.test.mjs`（L3-3）**：删去多余手工 `putRange`，验证由 `fetchSnapshot` 内部写进 L2 的 range 区间被重开实例真实读回并包含对应帧。
2. **`c10-beat-feed.test.mjs`**：更新文件头 1-6 行过时说明，彻底清理未使用的 `warm()` 与 `streamPlanesAt` 导入。
3. **用例名与死代码清理**：
   - `onlineCardsL.test.mjs`（`OCE-L-06`）：标题由「六处」修正为「五处」。
   - `stageLocalOnly.test.mjs`（`SL-01`）：文件头与用例名同步修正为「流平面与抑制占位」。
   - `streamFallback.test.mjs`：清理未使用的 `fakeSnap` 及快照 DOM 选择器，更新文件头说明。
