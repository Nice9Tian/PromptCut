# AGENT 报告：rr-bake3d-stream（3D 模式轨道流贴图、播放中免调预渲染与停下就精确）

- **工作分支**：`gemini/rr-bake3d-stream`
- **工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\rr-bake3d-stream`
- **状态**：全部完成（所有既有单测、新增单测与端到端浏览器探针 100% 通过，EOL 零翻转）。

---

## 1. 任务背景与决策对齐

根据 2026-10-14 用户决策 §2.5，落实以下四项核心设计：

1. **3D 模式独立轻卡产流纳入 `prerenderSet`**：
   - 当 3D 视图开启时（`view3d: true` / `includeLightCardsFor3D: true`），分派表将原本判轻的独立卡片（如 `punch-pill` 等）也纳入 `prerenderSet`，由预渲染服务生成轨道流，确保 3D 板子有流可贴。
   - `scene-3d` 在 3D 视图中作为真三维网格构造，照旧排除在 `prerenderSet` 之外。
2. **3D 视图播放中（`playing: true`）直接消费轨道流**：
   - 3D 板子纹理实时跟随对应卡片的轨道流画布更新（`CanvasTexture.needsUpdate = true`）；
   - 流未就绪时显示半透明 `PROXY_COLOR` 占位色块；
   - **播放中严禁调用** `/api/ui-render/bake-batch` 或 `/api/vision/bake-batch`，杜绝后台密集起 Chrome 挤占计算资源；同时隐藏「正在渲染...」的横幅提示。
3. **暂停态（`!playing`）坚持「停下就精确」**：
   - 暂停时触发当前播放头时刻的精确单帧渲染（`/api/ui-render/bake-batch`）；
   - 在精确图返回前，若轨道流已有画面，保持当前流画面过渡，不闪退回灰色色块；精确 PNG 快照返回后，无缝切入精确图并根据 alpha 盒裁剪居中；
   - 成片导出走逐帧 HD 渲染，保持原有设计不变。
4. **术语全量标准化**：
   - 将所有接口描述、返回值（`hint` / `note`）、错误信息与代码注释中的「卡片快照」/「它是一张快照，不是活的」统一规范为「PNG 快照」/「它是一张 PNG 快照，不是活的」，并同步更新单测断言。

---

## 2. 修改文件与核心实现细节

### 2.1 分派表与预渲染集合支持 3D 模式轻卡（`pipelinePlan.mjs` & `pipelinePlan.d.mts`）
- 在 `cardClipsOf` 中保留卡片的 `cardId` 与 `nodeId`。
- 实现 `isIndependentCard(clip, opts)`，根据 `isIndependent`、`compositing` 及 `capabilities` 正确判定独立卡片。
- 在 `planPipelines` 中：当 `opts.includeLightCardsFor3D === true || opts.view3d === true` 时，遍历卡片将所有独立卡（排除 `scene-3d`）统一加入 `prerenderSet`。
- 补充 `pipelinePlan.d.mts` 类型定义。

### 2.2 3D 视图状态下发与联动（`planDispatch.ts`）
- 增加 `view3d` 状态管理及 `setPlan3DView(on: boolean)`、`plan3DView(): boolean` 导出函数。
- 在 `recompute()` 中，当 `view3d` 为真时注入 `{ includeLightCardsFor3D: true, view3d: true }`，驱动 `planPipelines` 生成包含独立轻卡的 `prerenderSet`。
- 在 `resetPlanDispatch()` 中重置 `view3d = false`。

### 2.3 预渲染进程与控制器透传（`server/prerender-set.mjs`）
- 在 `planInputsOfControls` 中保留 `cardId`。
- 在 `prerenderSetOfPlan` 与 `prerenderSetOf` 中，将 `includeLightCardsFor3D`、`view3d` 及能力相关选项透传给 `planPipelines`（包括 `!costs` 兜底分支）。

### 2.4 3D 视图贴流与停下就精确（`src/editor/preview/Scene3DView.tsx`）
- **生命周期**：组件挂载时调用 `setPlan3DView(true)`，卸载时调用 `setPlan3DView(false)`。
- **预渲染抑制**：`useBakePrefetch` 传入 `enabled: !playing`；前台烘焙的 `useEffect` 在 `playing || scrubbing` 时直接返回并重置 pending 计数，播放期间彻底禁止发起 `bake-batch` 请求；将浮层横幅限制为 `!playing` 时才展示。
- **流播放器装配**：
  - 渲染隐藏的 `streamHost` 容器，按 `data-pc-clip` 与 `data-pc-stream-plane` 布局子 `<canvas>`；
  - 实例化 `StreamPlayer` 并注册到场景释放钩子；
  - 每帧 `tick()` 中按 `currentReadyIndex()` 同步 `player.setPlanes(...)` 并执行 `player.present(t)`；
  - 遍历 2D 板子：
    - `playing: true`：若 `showing.has(id)` 且有 `canvasTex`，切换为 `mode = "stream"`（若此前裁剪过则恢复完整几何尺寸），并每帧标记 `canvasTex.needsUpdate = true`；若无流画面则设为 `PROXY_COLOR` 占位（`mode = "proxy"`）；
    - `!playing`：若已是 `exact` 精确快照则保持；若有流画面则继续保持流画面作为过渡；两者皆无才显示色块占位；
    - 精确快照返回（`apply`）后，更新材质贴图、执行 `cropToContent` 并切换为 `mode = "exact"`。

### 2.5 术语标准化（「PNG 快照」）
- `server/tools/cards.mjs`：`bake_card` 工具描述更新为 `"**它是一张 PNG 快照,不是活的**..."`，并在说明中补充 3D 视图与导出中纹理随播放推进的机制。
- `server/vision/bake.ts`：返回值中的 `note` 更新为 `"这是一张**PNG 快照**:..."`，注释同步更新。
- `server/bake-store.mjs`：抛错提示与注释更新为「PNG 快照」。
- `server/vision/bake-cache.ts` & `server/vision/routes.ts`：注释更新为「PNG 快照」。
- `scripts/probes/card-bitmap-probe.mjs`：断言正则同步改为 `/PNG 快照/.test(r.note)`。

---

## 3. 验证与测试结果

### 3.1 静态类型检查
```bash
npx.cmd tsc -b --force
```
- **结果**：退出码 0，完全通过，无任何类型错误。

### 3.2 单元测试套件
```bash
npm.cmd test -- src/render/pipelinePlan.test.mjs
npm.cmd test -- server/test/prerender-set.test.mjs
npm.cmd test -- src/editor/avCardCost.test.mjs
npm.cmd test -- server/test/tool-schema.test.mjs server/test/query-render.test.mjs server/test/bake-store.test.mjs
```
- `src/render/pipelinePlan.test.mjs`：30/30 通过（包含新增的 3D 模式轻卡测试用例）。
- `server/test/prerender-set.test.mjs`：6/6 通过（包含新增的 `prerenderSetOfPlan` 与 `prerenderSetOf` 3D 模式测试）。
- `src/editor/avCardCost.test.mjs`：6/6 通过（包含新增的 `AVC-06` 验证 `setPlan3DView` 与 `plan3DView` 对分派表集合的影响）。
- `server/test/tool-schema.test.mjs` 等：52/52 通过，校验工具 schema 与快照术语一致性。

### 3.3 端到端真实浏览器探针（`preview-3d-stream-probe.mjs`）
使用指定端口范围（端口 `20020`，占用 `20020-20022`）运行端到端探针：
```bash
node scripts/probes/preview-3d-stream-probe.mjs --port 20020
```
- **探针执行结果**：
  - 成功启动 Dev Server 并挂载跨源双舞台；
  - 切换至 3D 视图后，`plan3DView()` 变为 `true`；
  - 分派表中 `punch-pill` 独立轻卡成功进入 `prerenderSet`，而 `scene-3d` 排除在 `prerenderSet` 外；
  - 点击播放推进 2 秒：
    - `playing` 为 `true`，时间轴前进（`t = 1.97s`）；
    - **播放期间向 `/bake-batch` 发起的请求数严格为 0**（`bakeRequestsWhilePlaying === 0`）；
    - 界面渲染平稳，成功抓取 `3d-playing.png`，横幅提示完全隐藏；
  - 点击暂停：
    - `playing` 变为 `false`，停止后触发精确渲染（`/api/ui-render/bake-batch`）；
    - 抓取 `3d-paused-exact.png`，状态显示正常；
  - 切回 2D 视图后 `plan3DView()` 恢复为 `false`；
  - 页面控制台与探针输出：**0 page errors，0 fails，ok: true**。

---

## 4. 行尾行序审计（EOL Audit）

按照代码规范要求，执行项目专用的 EOL 行尾检测：
```bash
node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD
```
- **输出**：无任何行尾颠倒（0 flipped line endings）。

---

## 5. 范围遵循承诺（Strictly Allowed vs Forbidden）

- **修改文件完全限定在允许范围内**：
  - `src/render/pipelinePlan.mjs`, `pipelinePlan.d.mts`, `pipelinePlan.test.mjs`
  - `src/editor/preview/Scene3DView.tsx`
  - `src/editor/planDispatch.ts`, `src/editor/avCardCost.test.mjs`
  - `server/prerender-set.mjs`, `server/test/prerender-set.test.mjs`
  - `server/vision/**`, `server/tools/**`, `server/bake-store.mjs`
  - `scripts/probes/card-bitmap-probe.mjs`, `scripts/probes/preview-3d-stream-probe.mjs`
  - `docs/reports/AGENT-rr-bake3d-stream.md`
- **严禁修改的文件零触碰**：
  - 未修改 `src/editor/Preview.tsx`、`src/editor/snapshotFeed.ts`；
  - 未修改 `src/online/**`、`src/export/**`、`server/render-node/**`；
  - 未修改 `docs/plan/*-progress.md`、`docs/plan/TODO.md`；
  - 所有后台进程严格在分配端口 `20020-20029` 内运行，且进程均带 `windowsHide: true`。
