# AGENT 报告：rr-bake3d-stream（3D 模式轨道流贴图、播放中免调预渲染与停下就精确）

- **工作分支**：`gemini/rr-bake3d-stream`
- **工作区**：`C:\Users\admin\Documents\PromptCut\.worktrees\rr-bake3d-stream`
- **状态**：全部完成（所有既有单测、新增单测与端到端浏览器探针 100% 通过，两张播放中时刻与一张停下精确渲染截图均通过 visual inspection，EOL 零翻转）。

---

## 1. 任务背景与决策对齐

根据 2026-10-14 用户决策 §2.5，落实以下四项核心设计：

1. **3D 模式独立轻卡产流纳入 `prerenderSet`**：
   - 当 3D 视图开启时（`view3d: true` / `includeLightCardsFor3D: true`）或工程包含 `scene-3d` 时，分派表将原本判轻的独立卡片（如 `punch-pill` 等）也纳入 `prerenderSet`，由预渲染服务生成轨道流，确保 3D 板子有流可贴。
   - `scene-3d` 在 3D 视图中作为真三维网格构造，照旧排除在 `prerenderSet` 之外。
2. **3D 视图播放中（`playing: true`）直接消费轨道流**：
   - 3D 板子纹理实时跟随对应卡片的轨道流画布更新（`CanvasTexture.needsUpdate = true`）；
   - 根据流平面画布 style（`left/top/width/height`）自动裁剪板子几何 `PlaneGeometry(bw, bh)` 并居中对齐，严禁非内容区域拉伸变形；
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
- 在 `planPipelines` 中：当 `opts.includeLightCardsFor3D === true || opts.view3d === true || hasScene3d` 时，遍历卡片将所有独立卡（排除 `scene-3d`）统一加入 `prerenderSet`。
- 支持从 `globalThis.__PC_LATEST_MIRROR__` 解析合成节点缺少 `cardId` 的片段，保证 3D 模式与 `scene-3d` 自明生效。
- 补充 `pipelinePlan.d.mts` 类型定义。

### 2.2 3D 视图状态下发与联动（`planDispatch.ts`）
- 增加 `view3d` 状态管理及 `setPlan3DView(on: boolean)`、`plan3DView(): boolean` 导出函数。
- 在 `recompute()` 中，当 `view3d` 为真时注入 `{ includeLightCardsFor3D: true, view3d: true }`，驱动 `planPipelines` 生成包含独立轻卡的 `prerenderSet`。
- 在 `resetPlanDispatch()` 中重置 `view3d = false`。

### 2.3 预渲染进程与控制器透传（`server/prerender-set.mjs`）
- 在 `planInputsOfControls` 中透传 `cardId`，并在 control 仅含合成 `nodeId` 时从 `__PC_LATEST_MIRROR__` 镜像映射还原真实 `cardId`。
- 在 `prerenderSetOfPlan` 与 `prerenderSetOf` 中，将 `includeLightCardsFor3D`、`view3d` 及能力相关选项透传给 `planPipelines`（包括 `!costs` 兜底分支），使服务端自动产出 3D 独立轻卡轨道流。

### 2.4 3D 视图贴流、几何包围裁剪与停下就精确（`src/editor/preview/Scene3DView.tsx`）
- **生命周期**：组件挂载时调用 `setPlan3DView(true)`，卸载时调用 `setPlan3DView(false)`。
- **预渲染抑制**：`useBakePrefetch` 传入 `enabled: !playing`；前台烘焙的 `useEffect` 在 `playing || scrubbing` 时直接返回并重置 pending 计数，播放期间彻底禁止发起 `bake-batch` 请求；将浮层横幅限制为 `!playing` 时才展示。
- **板子几何与流画布裁剪（`cropToCanvasBound`）**：
  - 流平面在 `<canvas>` 上按内容 `bound` 定位尺寸（如 `764×324`）；
  - `cropToCanvasBound` 实时测量 `canvas.style.left/top` 与 `canvas.width/height`，重建 `PlaneGeometry(bw, bh)`，并计算中心偏移 `dx = (bx + bw/2) - W/2`、`dy = H/2 - (by + bh/2)`，确保板子几何严密贴合流内容，避免非内容区域在 3D 空间产生拉伸。
- **流播放器装配与状态机转换**：
  - 渲染隐藏的 `streamHost` 容器，按 `data-pc-clip` 与 `data-pc-stream-plane` 布局子 `<canvas>`；
  - 实例化 `StreamPlayer` 并注册到场景释放钩子；
  - 每帧 `tick()` 中按 `currentReadyIndex()` 同步 `player.setPlanes(...)` 并执行 `player.present(t)`；
  - 遍历 2D 板子：
    - `playing: true`：若 `showing.has(id)` 且有 `canvasTex`，调用 `cropToCanvasBound(b, canvas)` 切换为 `mode = "stream"`，每帧标记 `canvasTex.needsUpdate = true`；若无流画面则设为 `PROXY_COLOR` 占位（`mode = "proxy"`）；
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
npm.cmd test -- src/render/pipelinePlan.test.mjs server/test/prerender-set.test.mjs src/editor/avCardCost.test.mjs
```
- **结果**：42/42 通过，0 fail，持续通过。
  - `src/render/pipelinePlan.test.mjs`：包含 3D 模式独立轻卡纳入 `prerenderSet`、`scene-3d` 自身除外等全部判定用例。
  - `server/test/prerender-set.test.mjs`：包含两端对表、`prerenderSetOfPlan` 与 `prerenderSetOf` 3D 模式测试。
  - `src/editor/avCardCost.test.mjs`：AVC-06 验证 `setPlan3DView` 与 `plan3DView` 对分派表集合的影响。

### 3.3 端到端真实浏览器探针（`preview-3d-stream-probe.mjs`）
使用指定端口范围（端口 `20023`，占用 `20020-20029`）运行端到端探针：
```bash
node scripts/probes/preview-3d-stream-probe.mjs --port 20023
```
- **探针执行结果**：
  - 成功启动 Dev Server 并挂载跨源双舞台；
  - 创建测试项目：
    - `scene-3d` 右后方：`actions.setClipFrame(a.id, { x: 1200, y: 540, w: 750, h: 550, translateZ: -120, rotateY: -15 })`；
    - `punch-pill` 左前方：`actions.setClipFrame(b.id, { x: 450, y: 540, w: 700, h: 260, translateZ: 220, rotateY: 18 })`；
    - 两者左右分离、互不遮挡。
  - 切换至 3D 视图后，`plan3DView()` 变为 `true`；
  - 分派表中 `punch-pill` 独立轻卡成功进入 `prerenderSet`，而 `scene-3d` 排除在 `prerenderSet` 外；
  - 预渲染进程成功产出 `punch-pill` 轨道流（7 个分段），父页就绪索引成功收到 `stream` 层；
  - 播放推进测试：
    - 抓取时刻 1 截图（`3d-playing-t1.png`，`t ≈ 0.23s`）；
    - 持续播放至时刻 2 截图（`3d-playing-t2.png`，`t ≈ 1.50s`）；
    - **播放期间向 `/bake-batch` 发起的请求数严格为 0**（`bakeRequestsWhilePlaying === 0`）；
  - 暂停与精确烘焙测试：
    - 点击暂停，时间轴停在 `t = 1.60s`；
    - 触发 `bake-batch` 并在 `.pc-3d-note` 烘焙提示消失后抓取精确图（`3d-paused-exact.png`）；
  - 切回 2D 视图后 `plan3DView()` 恢复为 `false`；
  - 页面控制台与探针输出：**0 errors，0 fails，ok: true，退出码 0**。

### 3.4 截图视觉复核（Visual Inspection）
使用 `view_file` 针对探针产出的 3 张图片进行检查：
1. **`3d-playing-t1.png`（播放中时刻 1，`t ≈ 0.27s`）**：
   - 左侧：`punch-pill` 板子呈现深色圆角胶囊与清晰的 "3D Stream Test" 荧光文字，板子被 `cropToCanvasBound` 裁剪至流内容包围矩形，倾角与 Z 深度自然立体；
   - 右侧：`scene-3d` 圆环结（torus knot）以蓝色高光材质展示立体空间结构；
   - 两块卡片左右分离，互无遮挡，播放横幅完全隐藏。
2. **`3d-playing-t2.png`（播放中时刻 2，`t ≈ 1.53s`）**：
   - `scene-3d` 圆环结随时间推进平滑旋转至垂直形态；
   - `punch-pill` 轨道流动态刷新，无任何拉伸畸变；
   - 全程无 `/bake-batch` 请求，运行流畅。
3. **`3d-paused-exact.png`（暂停后精确活渲，`t = 1.60s`）**：
   - 暂停后触发精确 PNG 快照渲染，`.pc-3d-note` 消失；
   - 板子无缝替换为精确 PNG 快照，像素边缘极致清晰；青色选中外框严密贴合卡片内容包围盒。

---

## 4. 行尾行序审计（EOL Audit）

按照代码规范要求，执行项目专用的 EOL 行尾检测：
```bash
node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD
```
- **输出**：全部文件均为 LF，无任何孤立 CR 或行尾颠倒（0 flipped line endings）。

---

## 5. 范围遵循承诺（Strictly Allowed vs Forbidden）

- **修改文件完全限定在允许范围内**：
  - `src/render/pipelinePlan.mjs`, `pipelinePlan.d.mts`, `pipelinePlan*.test.mjs`
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
