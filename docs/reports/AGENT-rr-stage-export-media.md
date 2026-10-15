# 子代理工作报告：rr-stage-export-media

- **分支**: `gemini/rr-stage-export-media`
- **工作区**: `C:\Users\admin\Documents\PromptCut\.worktrees\rr-stage-export-media`
- **调用方**: `32b55312-a68c-43e2-bf68-7e27e2ac959c`
- **状态**: 紧急暂停已收尾，代码已提交至分支，未合并 main。

---

## 1. 范围调整说明

在收到主会话指令后，原任务「任务 2：在线隔离舞台导出」已被从本分支完全剔除（严禁触碰 `src/export/**`, `src/ExportView.tsx`, `src/render/FrameScene.tsx`, `src/editor/ExportDialog.tsx` 等），留待 `rr-frame-bake3d` 合并后再做。

本分支仅负责：
1. **任务 1：舞台隔离与桌面版舞台锁死**
   - 桌面端：在预渲染 HTTP 入口处拦截来自舞台源或带 stage 头的请求；跨源请求无内部 token 一律拦截。
   - 桌面端：舞台端口访问 `/@media/<hash>` 时，校验哈希必须存在于当前项目的 `project.media` 中，否则 403 拒绝。
   - 在线端：去除同源单舞台回退，舞台未配置或不可用时拒绝挂载；严禁退回同源执行或通过 RPC `?t=` 传递票据。
2. **任务 3：在线素材导入与前端小档转码**
   - 界面解除禁用，图片/音频直传，视频通过 WebCodecs 转码小档优先上传，然后上传原档。

---

## 2. 已经完成的工作

### 2.1 桌面端预渲染防护入口与跨源内部 Token (`server/prerender-gate.mjs`)
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
  - 新增 `setStageMediaHashesGetter` 与针对 `/@media/<hash>`、`/@media/<hash>.<ext>`、`/@media/<hash>/pcm` 的白名单校验逻辑：若请求来自舞台端口且 hash 不在当前项目 media 列表中，直接拒绝（403 Forbidden）。
- `server/vite-plugin-stage-ports.ts`：
  - 通过 `setStageMediaHashesGetter` 接入从最新 mirror 获取 `project.media` 哈希列表，并在代理与中间件层执行过滤。

### 2.3 在线舞台隔离安全性与票据保护 (`src/online/stageIsolation.ts`, `src/online/stageIsolation.test.mjs`)
- `src/online/stageIsolation.ts`：
  - 在 `plan(id, ctx)` 中增加严格校验：若 `!ctx.stageOrigin`，直接抛出 `[stageIsolation] 跨源隔离舞台未配置或不可用，禁止同源退回: stage ${id}`，杜绝同源降级。
  - 移除了向舞台退回 legacy RPC 票据的逻辑，在降级/未隔离/失败情况下永远返回 `ticket: null` 与 `mode: "cookie"`，严禁通过 URL 或 RPC 泄露票据。
- `src/online/stageIsolation.test.mjs`：
  - 对应更新了 OCS-S-05 至 OCS-S-09 的测试断言，确保断言与「永不泄露票据」和「禁止同源退回」行为一致。

---

## 3. 停在哪一步，还剩什么未做

### 停顿位置
在完成 `stageIsolation.ts` 和 `stageIsolation.test.mjs` 测试全部通过后，准备修改 `src/editor/previewMode.ts` 与实现在线素材前端小档转码时收到紧急暂停指令。

### 剩余未完成工作
1. **在线舞台挂载抛错收尾 (`src/editor/previewMode.ts`)**:
   - `singleLiveStage()` 改为 `return false;`。
   - `stageSrc(id, opts)` 中，当 `ONLINE` 且 `!origins || !origins[id]` 时，抛错拒绝同源挂载。
2. **在线素材转码与小档优先上传 (`src/online/mediaTranscode.ts`, `src/editor/io/mediaUpload.ts`)**:
   - 实现 `src/online/mediaTranscode.ts`：基于 WebCodecs / Canvas 将视频压缩为小档 MP4，支持多文件上传队列按「所有小档优先上传、原档随后上传」的策略。
   - 更新 `src/editor/io/mediaUpload.ts`：在线模式调用该模块进行素材上传。
   - 恢复 `src/editor/left/LibrarySection.tsx`、`GroupBox.tsx`、`SpeakerPicker.tsx` 中被禁用的导入媒体按钮。
3. **编写对应单元测试并最终全量验证**:
   - `src/online/mediaTranscode.test.mjs`
   - `npx.cmd tsc -b --force`

---

## 4. 测试与探针运行结果

| 测试项 | 状态 | 备注 |
|---|---|---|
| `server/test/prerender-gate.test.mjs` | **通过** (2/2) | 验证拦截舞台端口请求与跨源 token 验证 |
| `server/test/stage-gate.test.mjs` | **通过** (8/8) | 验证舞台白名单与跨项目 media hash 403 拦截 |
| `src/online/stageIsolation.test.mjs` | **通过** (13/13) | 验证跨源隔离自检、票据交接、禁止同源退回与不泄露票据 |
| `eol-audit.mjs . main HEAD` | **通过** (0 处翻转) | 行尾 LF 完好，无 CRLF 污染 |
| 整体类型检查 `tsc -b --force` | 未运行 | 紧急停机未触发 |
| 转码相关测试 | 尚未实现 | 下次继续时实现 |
