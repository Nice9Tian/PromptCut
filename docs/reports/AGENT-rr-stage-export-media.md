# 子代理工作报告：rr-stage-export-media

- **分支**: `gemini/rr-stage-export-media`
- **工作区**: `C:\Users\admin\Documents\PromptCut\.worktrees\rr-stage-export-media`
- **调用方**: `32b55312-a68c-43e2-bf68-7e27e2ac959c`
- **状态**: 单功能任务「所有舞台一律跨源隔离与桌面版舞台锁死」全部完成，类型检查与单测通过，行尾 LF 审计 0 翻转。

---

## 1. 范围与单功能限缩说明

按照用户「每路只做一两样功能」的架构演进原则，本分支已严格限缩为交付单项功能：
- **只做**：任务 1「所有舞台一律跨源隔离与桌面版舞台锁死」。
- **不做**：
  - 在线浏览器导入媒体与转小尺寸（拆分至后续独立分支 `rr-media-import`）。
  - 在线隔离舞台导出（拆分至后续独立分支 `rr-online-export-stage`）。
- **未改动受保护目录**：未触碰 `src/export/**`、`src/editor/io/**`、`src/editor/left/**`。

---

## 2. 交付内容与具体实现

### 2.1 桌面端预渲染防护入口与跨源内部 Token (`server/prerender-gate.mjs`, `server/vite-plugin-prerender.ts`, `server/vite-plugin-mirror.ts`)
- 新增 `server/prerender-gate.mjs` 中间件并挂载至 `vite.prerender.config.ts` 插件顶部：
  - 检查请求头 `x-pc-stage-client`、`Origin` 与 `Referer`，若匹配舞台端口（`PROMPTCUT_STAGE_PORTS`）则直接 403 拦截。
  - 拦截未携带合法 `x-pc-internal-token` 的跨源请求。
- `server/vite-plugin-prerender.ts`：
  - 将舞台源从 `PROMPTCUT_CORS_ORIGINS` 排除，保证舞台源永远不在预渲染 CORS 白名单内。
  - 生成 `PROMPTCUT_INTERNAL_TOKEN` 传递给预渲染子进程，并在 `rnForward` 中携带该 token。
- `server/vite-plugin-mirror.ts`：
  - 在 `postJson` 向预渲染服务同步镜像时传递 `x-pc-internal-token`。
  - 挂载 `__PC_LATEST_MIRROR__` 全局引用，避免跨模块相对导入在测试 mock 环境中破坏模块解析。

### 2.2 舞台端口只放行当前项目素材 (`server/stage-gate.mjs`, `server/vite-plugin-stage-ports.ts`)
- `server/stage-gate.mjs`：
  - 从 `STAGE_ALLOW` 中移除 `/api/prerender/info`（舞台卡不可探测预渲染状态）。
  - 新增 `setStageMediaHashesGetter` 与针对 `/@media/<hash>`、`/@media/<hash>.<ext>`、`/@media/<hash>/pcm` 的白名单校验逻辑：若请求来自舞台端口且 hash 不在当前项目 media 列表中，直接 403 拒绝（素材不能跨项目读取）。
- `server/vite-plugin-stage-ports.ts`：
  - 通过 `setStageMediaHashesGetter` 接入从最新 mirror 获取 `project.media` 哈希列表，并在代理与中间件层执行过滤。

### 2.3 在线舞台隔离安全性与票据保护 (`src/online/stageIsolation.ts`, `src/online/stageIsolation.test.mjs`)
- `src/online/stageIsolation.ts`：
  - 在 `plan(id, ctx)` 中增加严格校验：若 `!ctx.stageOrigin`，直接抛出 `[stageIsolation] 跨源隔离舞台未配置或不可用，禁止同源退回: stage ${id}`，杜绝同源降级。
  - 移除了向舞台退回 legacy RPC 票据的逻辑，在降级/未隔离/失败情况下永远返回 `ticket: null` 与 `mode: "cookie"`，严禁通过 URL 或 RPC 泄露票据。
- `src/online/stageIsolation.test.mjs`：
  - 覆盖 OCS-S-01 至 OCS-S-13 全部 13 条单测。

### 2.4 在线舞台一律跨源隔离、禁止退回同源舞台收尾 (`src/editor/previewMode.ts`, `src/online/stageOrigins.ts`, `src/editor/Preview.tsx`)
- **`src/editor/previewMode.ts`**：
  - `singleLiveStage()` 保持 `return ONLINE;`，确保在线编辑页总开关正常。
  - `interimStage()` 直接返回 `false`，彻底撤除 20 秒退回同源单舞台的过渡期。
  - `stageSrc(id, opts)` 与 `stageTargetOrigin(id)`：在 `ONLINE` 模式下一律取 `const origins = stageOrigins();`；若 `ONLINE && (!origins || !origins[id])`，直接抛出明确错误 `[previewMode] 在线舞台未配置跨源隔离源，禁止退回同源舞台: stage ${id}`，绝不退回同源地址。
- **`src/online/stageOrigins.ts`**：
  - 更新架构语义与注释，明确所有舞台一律跨源隔离、撤掉退回同源单舞台的路。
  - `stageLayout` 中 `lowMemory === true` 时返回 `"single"`，仅挂载舞台 A，且该舞台依然从跨源 `stageOrigins().A` 加载 `/editor/stage.html`，绝不退回同源。
- **`src/editor/Preview.tsx`**：
  - 挂载舞台 iframe 时增加条件：`!(ONLINE && (!stageOrigins() || onlineStages.handshake === "failed"))`，在未配置源或握手失败时不挂载同源舞台 iframe。
  - `key="single"` 舞台 iframe 增加 `sandbox={ONLINE ? STAGE_SANDBOX : undefined}` 与 `onLoad={() => onStageFrameLoad("A")}`。
  - 消息监听处增加 `originOk(id, e.origin, dualRef.current || ONLINE)`，并将 `untrusted` 调整为 `ONLINE && targetOrigin !== location.origin`，确保单舞台（低内存档）跨源通信依然严格受控。
- **单测同步**：
  - 更新 `src/online/stageOrigins.test.mjs`（断言 `handshake: "interim"` 返回 single、说明更新）。
  - 更新 `src/editor/c10a-single-stage.test.mjs`（断言在线模式下未配置源抛错拒绝同源退回、配置后从跨源 `stage.html` 加载）。

---

## 3. 测试与验证结果

| 测试项 | 状态 | 备注 |
|---|---|---|
| `server/test/prerender-gate.test.mjs` | **通过** (2/2) | 验证拦截舞台端口请求与跨源 token 验证 |
| `server/test/stage-gate.test.mjs` | **通过** (8/8) | 验证舞台白名单与跨项目 media hash 403 拦截 |
| `src/online/stageIsolation.test.mjs` | **通过** (13/13) | 验证跨源隔离自检、票据交接、禁止同源退回与不泄露票据 |
| `src/online/stageOrigins.test.mjs` | **通过** (7/7) | 验证运行配置解析、布局判定与握手状态机 |
| `src/editor/c10a-single-stage.test.mjs` | **通过** (1/1) | 验证在线模式下禁止同源退回并强制跨源 stage.html |
| `npx.cmd tsc -b --force` | **通过** (0 错误) | 全量 TypeScript 严格类型检查通过 |
| `eol-audit.mjs . main HEAD` | **通过** (0 处翻转) | 行尾全部为 LF，无 CRLF 污染 |
