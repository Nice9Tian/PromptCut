# 子 Agent 交付报告：rr-mobile-node-wire

**分支**：`gemini/rr-mobile-node-wire`  
**工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\rr-mobile-node-wire`  
**时间**：2026-10-16  

---

## 一、任务目标与做了什么

本任务目标为完成低内存（手机、平板）设备在本页产出稀疏轨道流的完整接线（只为本页产稀疏流，绝不替任务队列认领跨项目任务），并在单舞台架构下实现烘焙角色的临时切换与安全复原。

### 1. `src/editor/Preview.tsx`
- **放开低内存档挂载浏览器节点宿主**：移除 `startBrowserNodeHost` 处的 `lowMem` 限制（保留 `if (!online) return;`）。
- **测量落定驱动**：向宿主注入 `measured: lowMemRef.current ? lowMemoryJudged() : probeSettledFor(getState().project)`，低内存模式由界限搜索判定结果驱动测量落定。
- **合成低内存 pagePlan 与跳过切分方等待**：
  - 低内存模式下 `pagePlan` 构造合成单卡计划：`id: 'lowmem:${projectId}@${ds.rev}'`，`at: 0`，片段集合对应 `judgedPlan()?.prerenderSet`。
  - `planState` 在低内存模式下直接返回 `Promise.resolve("open")`，无需等待队列切分方。
- **状态恢复机制（`restore`）**：单舞台临时切换烘焙结束后，重置 `suppressedRef.current = ""`、`streamPlanesRef.current = "[]"`、`markBaselineReset("front")`，并调用 `setStageReady((n) => n + 1)` 唤醒图层投递与舞台时间轴。
- **确认版本保留**：在 `lowMemSearchRef` 中界限搜索 settle 时调用 `keepConfirmedProject(ds.rev, ds.confirmedProject)`，确保本页产流能准确获取已确认工程。

### 2. `src/editor/stageBridge.ts`
- **单舞台事件透传**：更新事件过滤逻辑，当 `backRole() === "front"` 时允许来自 `front` 舞台的 `bake-frame` 事件通过（`if (stageEventRole(e.type) !== role && !(role === "front" && backRole() === "front")) return;`）。
- **单舞台角色映射**：在 `send`、`pushedProject`、`markPushed` 中将 `role === "back" && backRole() === "front"` 自动映射至 `"front"` 客户端。

### 3. `src/editor/stageJobs.ts`
- **单舞台烘焙角色下发**：在单舞台模式（`backRole() === "front"`）下允许 `setRole("back", { job: "bake" })` 正常下发（不缓存入 `lastSent`），以便为提取像素临时切换上下文。

### 4. `src/editor/browserNodeHost.ts`
- **引入 Chromium 判定与恢复回调**：从 `../online/browserNode` 导入 `isChromiumUserAgent`，在 `BrowserNodeHostDeps` 中补充 `restore?: () => void;`。
- **单舞台烘焙生命周期管理**：
  - 在 `streamBaker` 的 `runBackJob` 前，针对单舞台切换 `stage.setRole("back", { job: "bake" })`；
  - 在 `finally` 和 `closeStreamLease` 中调用 `restoreFrontFromBake`：切换回 `stage.setRole("front")`、重新将最新项目全量推送给前台（`pushProject("front", getState().project, { reset: true })`），并调用 `deps.restore?.()` 重置抑制集合与流平面。
- **低内存产流配置**：向 `createPageStreams` 传入 `lowMemory: () => deps.eligibility().lowMemory === true`，并在低内存档设置 `waitMs: 0`。
- **绝不认领队列任务**：将 `node` 的 `isIdle` 设定为 `() => !deps.eligibility().lowMemory && settled && isIdle() && !pages.running()`，确保低内存设备 `claims === 0`。
- **连接与落定判定**：在主循环中支持低内存档在 `raw.lowMemory && raw.measured` 时标记 `settled` 并维持连接。

### 5. `scripts/probes/page-stream-probe.mjs`
- **`sceneLowmem` 第 6 节**：适配断言，兼容低内存页面为自身新加重卡产稀疏流的情况，严格断言 `nodeDiag.counters.claims === 0`。
- **`sceneMobile`**：
  - 将 5 卡同屏（`STACK`）与单卡（`clipA`）解耦：`STACK` 由页面甲预制，`clipA` 在甲下线后由模拟手机（`psp-shouji`）自己通过 `isConfigSupported` 并产出稀疏流、推上素材服务、写进层表并挂载播放。
  - 断言 `pageStreams.counters.produced >= 1`、流分段 `stride === 15`（无满密度版）、`claims === 0`（不认领队列任务）。
  - 在 390×844 视口下添加侧栏折叠逻辑（注入 localStorage 并在截图前点击折叠按钮）。
  - 修复 `clipA` 确认逻辑，避免在已有 5 张卡的项目中因 `length === 1` 假超时。

---

## 二、跑过的验证

1. **TypeScript 编译检查**：
   - `npx.cmd tsc -b --force`：0 错误，退出码 0。
2. **单元测试集**：
   - 命令：`node --test src/online/lowMemory.test.mjs src/editor/stageBridge.test.mjs src/editor/stageJobs.test.mjs src/editor/stageBake.test.mjs`
   - 结果：40 个测试全部通过（40 pass, 0 fail）。
3. **在线探针测试**：
   - 构建命令：`npx.cmd vite build --mode online --outDir out/rr-mobile-node-wire/dist --emptyOutDir`
   - 实跑命令：`node scripts/probes/page-stream-probe.mjs --dist out/rr-mobile-node-wire/dist --base-port 20010 --out out/rr-mobile-node-wire/probe --only mobile`
   - 结果：退出码 0，`fails: []`。
     - `mobile.prepared`：5 条流预制稀疏版完成；
     - `mobile.sparse`：单卡稀疏流播放 39 个样本，首帧检验通过，无寻帧错误；
     - `mobile.stack`：同屏 5 张重卡，解码器上限 4 个，第 5 张显示占位符；
     - `mobile.heap`：JS 堆增量峰值 0.2 MB（<= 25 MB）；
     - `mobile.beats`：节拍 p95 0.8 ms（< 33 ms）；
     - 截图生成成功。
4. **截图亲眼核验**：
   - 通过 `view_file` 查阅 `out/rr-mobile-node-wire/probe/mobile/mobile-play-5stack.png` 与 `mobile-paused-5stack.png`：
     - 预览舞台未受左右侧栏遮挡；
     - 播放中清晰显示 4 张画面与 1 张占位符；
     - 暂停后活组件精确画面落定。
5. **行尾与产物清理**：
   - `node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD`：行尾翻转数为 0。
   - 临时构建目录 `out/rr-mobile-node-wire/dist` 已彻底清理。

---

## 三、裁定

1. **〔裁，二级〕单舞台低内存设备的临时切角色与复原安全**：低内存设备仅有一个舞台实例（`front`），当本页执行提取位图任务时，需临时发送 `setRole("back", { job: "bake" })` 让舞台执行提取像素；提取收尾必须有且仅有一次全流程复原（切回 `front`、全量重推项目、重置抑制/流平面缓存、触发 `stageReady` 刷新），防止可见舞台画面丢失。
2. **〔裁，二级〕低内存设备节点能力与队列任务隔离**：低内存设备通过 `isConfigSupported` 允许启用 WebCodecs 为自身合成稀疏流，但 `node.isIdle` 必须恒为 `false`，彻底杜绝从队列认领远程切分任务。
