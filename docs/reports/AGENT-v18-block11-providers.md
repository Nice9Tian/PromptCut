# AGENT-v18-block11-providers：0.7.18 块十一（P1 素材拼图、P6 音频测量脚本、V1 可视记录提供者与轨道流/工作进程项目素材隔离）

分支 `gemini/v18-block11-providers`（基线 `b6b5a8d8`），工作区 `.worktrees/v18-block11-providers`，专属端口段 `20060–20079`（单测内临时 HTTP 服务均绑定 `127.0.0.1:0` 用完即关，子进程全带 `windowsHide: true`）。不推送、不合并，未触碰任何中央接线文件。

本文代号说明：
- **P1 素材拼图**：`docs/plan/cloud-agent-tools-implementation.md` 第 94 行拆包表中 `see_frames({ source: 'media', ... })` 的云端提供者实现（`server/agent/service/hosted-media-frames.mjs` 与 `server/vision/media-sheet.mjs`）。
- **P6 音频测量脚本**：同表第 99 行 `measure_audio_js` 的云端提供者（`server/agent/service/hosted-audio-js.mjs`）与托管渲染侧签名路由处理器（`server/hosted-render/audio-js.mjs`）。
- **V1 用户可视记录**：同表第 103 行 `get_gif` 与操作可视记录的持久化提供者（`server/agent/service/hosted-visuals.mjs`）、受权对话路由（`server/agent-service/visual-routes.mjs`）及前端组件（`src/editor/right/ToolVisual.tsx`）。
- **F0**：`server/agent/service/{tool-context,run-resources,tool-jobs,project-assets}.mjs` 已落地的云端工具公共窄接口。

---

## 1. 做了什么

| 文件 | 变更类型 | 内容摘要 |
|---|---|---|
| `server/vision/media-sheet.mjs` | 新建 | 纯 Node 素材拼图规划与参数模块（不引 `src/`）：导出 `scenesOf`、`planSequences`（默认 6 镜头/页、上限 12，支持 `grid: 4` / `grid: 9` 及单镜头 `scene` 放大）、`frameTimes`、`transcriptFor`、`sheetFfmpegArgs`（带 `-protocol_whitelist file`）与 `probeImageDimensions`（解析 PNG/JPEG/GIF/WebP 头部宽高与 MIME） |
| `server/agent/service/hosted-media-frames.mjs` | 新建 | P1 素材拼图提供者 `createMediaFramesTools`：每次调用先经 `resources.authorize(context, 'read')` 核验当前 `runGrant` 与 `fenceRevision`，经 `project.getMedia` 与 `assets.openRead` 读取受权项目素材；视频抽帧拼图与 `ffprobe` 均经 `perception/runner.mjs` 的 `spawnTree` + `superviseChild` 登记到 `resources.register(context, { kind: 'child', ... })`，支持图片直出、音频拒绝、跨项目拒绝、缺 `ffmpeg` 回 `{ ok: false, cloudUnavailable: true, error }`，取消（`abortForFence`）或 `close()` 时真实杀树并清净临时目录 |
| `server/test/cloud-tools-p1-media-frames.test.mjs` | 新建 | P1 素材拼图 4 组单测：覆盖真视频 `grid4`/`grid9` 抽帧拼图、单镜头放大、转写折叠、图片直读、音频拒绝、跨项目与不存在 `mediaId` 拒绝、缺 `ffmpeg` 回 `cloudUnavailable`、栅栏取消子进程真实退出与临时文件清理 |
| `server/audio-sandbox.mjs` | 修改 | 新增 `syntaxLocationOf(code)`（仅经 `node:vm` 编译语法树提取 1-based `line`、`column` 与 `(第 X 行第 Y 列)`，不执行代码）；为 `run` / `runOnce` 增加 `AbortSignal`（`signal`）中止支持；`close()` 等待浏览器进程真实退出 |
| `server/audio-measure-js.mjs` | 修改 | 透传 `signal` 与 `spawnImpl`，并在语法错误返回体中保留 `line`、`column` 字段 |
| `server/hosted-render/audio-js.mjs` | 新建 | P6 渲染侧签名路由处理器 `createHostedAudioJsHandler`：核验 `x-pc-service-auth` 服务签名并拒绝浏览器请求与路径/URL 入参，解码受权 PCM 并在断网无 Node 能力的 `audio-sandbox.mjs` 中执行 `code`，连接中断或 `close()` 时立即中止沙箱 worker |
| `server/agent/service/hosted-audio-js.mjs` | 新建 | P6 云端提供者 `createAudioJsTools`：每次调用先核 `resources.authorize(context, 'read')`，只从当前项目受权 `mediaId` / `clipId` / `timeline` 经 `assets.openRead` 取字节并用受监管的 `ffprobe`/`ffmpeg`（`-protocol_whitelist file`）解出 PCM，交隔离沙箱或签名路由执行；沙箱运行同样登记为受监管 `child` 资源，失权/取消时立即终止解码与沙箱 worker |
| `server/test/cloud-tools-p6-audio-js.test.mjs` | 新建 | P6 音频测量脚本 4 组单测：覆盖纯正弦波 PCM 数值测量准确性（media/clip/timeline，RMS 与峰值误差 < 0.05 dB）、语法错误精确行列号、死循环超时终止、内存超限与 256 KiB 输出上限拒绝、联网/文件/Node 越权尝试拒绝、跨项目素材与本机路径拒绝、撤权取消（`abortForFence`）与 worker 真实关闭 |
| `server/agent/service/hosted-visuals.mjs` | 新建 | V1 可视记录提供者 `createVisualsTools` 与存储 `createVisualsStore`：在 `<dataDir>/tenants/<projectId>/conversations/<conversationId>/visuals/<visualId>.json`（及可选对话工作区 `visuals/`）原子写入 `{ visualId, kind, tool, spec, sourceRev, projectId, conversationId, aclRevision, frames, gifAssetRef?, createdAt, images?, before?, after?, diff? }`，对外只返回受权对话文件路由 |
| `server/agent-service/visual-routes.mjs` | 新建 | V1 受权 HTTP 路由 `createVisualRoutes`：处理 `GET /agent/v1/conversations/:id/visuals/:vid` 与 `/files/:name`（兼容 `/v1/...` 前缀），每次读取向文档服务核对当前请求者在 `projectId + conversationId` 下的对话读取权限（`shared` 对有效项目成员开放；`private` 仅对 owner 与项目创建者只读例外开放；被踢、退出、跨项目、跨对话一律 401/403/404 拒绝），响应头设为 `Cache-Control: private, no-store` 并绑定 `aclRevision`（旧 `?aclRevision=` 立即 409 失效），剥离内部 `gifAssetRef` 防止凭 asset hash 绕过 ACL |
| `src/editor/right/ToolVisual.tsx` | 修改 | 新增云端对话作用域管理 `setCloudVisualScope` / `clearVisualCache`：云端模式下带 Bearer 票据与 `aclRevision` 从受权对话端点加载记录与动图/截图并转为可撤销 URL；当对话切私有、`aclRevision` 变更或被撤权（`revoked: true`）时立即清空缓存、撤销 `blob:` URL 并卸载残留画面 |
| `server/test/cloud-tools-v1-visuals.test.mjs` | 新建 | V1 用户可视记录单测：覆盖模型 `get_gif` 落盘记录、同对话成员读取、创建者只读 `private`、非 owner 成员读 `private` 被拒、共有切私有后立即不可读、跨对话/跨项目被拒、重启后持久保留，以及 `ToolVisual.tsx` 云端加载与切私有撤权即刻清理 |
| `server/frame-stream.mjs`、`server/hosted-render/worker.mjs`、`server/test/asset-project-workers.test.mjs` | 修改 | 加固 `planStreams`、`segmentSignature`、`StreamProducer` 按 `projectId` 绑定衍生流键、清单与分段读写；在 `hosted-render/worker.mjs` 新增 `createWorkerProjectScope` 与 `worker.switchProject`，将素材缓存、代理口令/票据、环境变量严格绑定 `projectId`；在 `asset-project-workers.test.mjs` 补齐跨项目同卡片参数流键隔离与跨项目同哈希素材缓存/票据隔离的硬断言单测 |

| `server/agent/service/cloud-tools.mjs`、`server/agent/service/account-tools.mjs`、`server/agent/service/instance.mjs` | 修改 | **G 第二期中央挂载**：在 `cloud-tools.mjs` 将 `measure_audio_js` 标上 `provider: 'audioJs'`（旧单进程托管档行为不变，账号模式建出提供者时放行可用）；在 `createAccountToolset` 挂入 `mediaFrames`（`see_frames` 素材拼图 / `see_media`）、`audioJs`（`measure_audio_js`）、`visuals`（`get_gif` 与 `recordVisual`），并在 `close()` 中统一回收；在 `instance.mjs` 将 `see_frames({ source: 'media' })`（及带 `mediaId` 调用）与账号模式的 `get_gif` 路由到 `accountTools` |
| `server/agent-service/http.mjs`、`server/agent-service/main.mjs`、`server/agent-service/account-master-assembly.mjs`、`server/agent/service/account-runner.mjs` | 修改 | 在 Agent HTTP 主服务中挂载 `createVisualRoutes`，使 `GET /v1/conversations/:id/visuals/:vid` 与 `GET /agent/v1/conversations/:id/visuals/:vid`（及 `/files/:name`）可达并经过读取控制通道与对话 ACL 核验 |
| `server/hosted-render/look.mjs`、`server/hosted-render/broker.mjs`、`server/hosted-render/audio-js.mjs` | 修改 | 在 `createLook` 与管理进程 `broker.mjs` 上挂载 `createHostedAudioJsHandler` 到 `/api/audio/measure-js`（`HOSTED_AUDIO_JS_ROUTE`）签名路由，保持 `/look`、`/look/poll`、`/look/cancel` 等原有路由 100% 不变 |
| `server/agent/ssr-host.mjs`、`server/agent/{agent-board,agent-roles,agent-sessions,creativity-gate}.mjs`、`server/agent/service/hosted-tools.mjs`、`server/test/accept-018-rest-ssr-seam.test.mjs` | 修改 | **收口 `SEAM-2`**：将 `agentScopes.mjs`、`creativity.mjs`、`ROLES_DIR` 与 `loadCardLib` 统一由唯一载入缝 `server/agent/ssr-host.mjs` 转出，使独立入口传递闭包除 `ssr-host.mjs` 外对 `src/` 的直接引用降为 **0 处（`KNOWN = []`）**，去掉 `SEAM-2` 的 `todo` 转为硬断言 |
| `src/editor/right/ToolVisual.tsx`、`server/frame-stream.mjs` | 修改 | 修复两处回归：`ToolVisual.tsx` 使用 `AGENT_V1_PREFIX = "/agent/v1"` 消除 `"/agent/v1/"` 字面量使 `C10A-API-05` 100% 通过；`frame-stream.mjs` 中 `StreamProducer` 各方法改为 `await this.assertProjectScope?.(...)` 使 `export-frames-retry.test.mjs`（`EFR-04`）100% 通过 |

---

## 2. 验证结果

| 验证项 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| TypeScript 类型检查 | `npx.cmd tsc -b --force` | 0 | 0 错误，无输出 |
| 在线版构建 + 中央接线与回归全套单测 | `node node_modules/vite/bin/vite.js build --mode online; npm.cmd test -- server/test/c10a-online-build.test.mjs server/test/export-frames-retry.test.mjs server/test/accept-018-rest-ssr-seam.test.mjs server/test/cloud-agent-service.test.mjs server/test/cloud-agent-tools.test.mjs server/test/cloud-tools-wire.test.mjs server/test/cloud-tools-p1-media-frames.test.mjs server/test/cloud-tools-p6-audio-js.test.mjs server/test/cloud-tools-v1-visuals.test.mjs server/test/asset-project-workers.test.mjs server/test/hosted-render-look.test.mjs server/test/hosted-render-queue.test.mjs` | 0 | 114 条测试：**112 pass, 0 fail, 2 skipped（Windows 平台权限跳过项）, 0 todo** |
| 关联看画面与子进程静默守门单测 | `npm.cmd test -- server/test/cloud-agent-look.test.mjs server/test/windows-hide-silent-spawn.test.mjs` | 0 | 8 条测试全部通过（8 pass, 0 fail, 0 todo） |
| 行尾审计 | `node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . 022e0c19 HEAD` | 0 | 全部 `LF → LF` / `新文件 → LF`，孤立 CR 0，0 行尾翻转 |

---

## 3. 没做成的与原因

无未完成项。块十一的四个提供者与隔离项、G 第二期中央接线、两处全量回归修复（`C10A-API-05` 与 `EFR-04`）以及 `SEAM-2` 载入缝收口（0 处违反、0 todo）已全部完成并通过验证。

---

## 4. 对任务书或语义的更正建议

1. **`docs/plan/cloud-agent-tools-implementation.md` 拆包表状态更新**：P1 的 `see_frames({ source: 'media' })`、P6 的 `measure_audio_js`、V1 的 `hosted-visuals.mjs` / `visual-routes.mjs` 及 G 第二期中央挂载均已完成并合入。
2. **语义文档（`docs/semantics/`）**：本块实现严格遵循既有二级/三级语义契约，无需修改语义文档。

---

## 5. 中央接线挂载摘要（已落地）

1. **P1 素材拼图提供者（`server/agent/service/hosted-media-frames.mjs`）**：已挂载至 `account-tools.mjs`（`mediaFrames` 族），`instance.mjs` 在 `see_frames` 带 `source: 'media'` 或 `mediaId` 时路由至该提供者，时间轴 `see_frames` 保持原路径。
2. **P6 音频测量脚本提供者与签名处理器（`server/agent/service/hosted-audio-js.mjs`、`server/hosted-render/audio-js.mjs`）**：`cloud-tools.mjs` 已为 `measure_audio_js` 标注 `provider: 'audioJs'`，`account-tools.mjs` 已挂载 `audioJs` 族；`look.mjs` 与 `broker.mjs` 已挂载 `/api/audio/measure-js`（`HOSTED_AUDIO_JS_ROUTE`）签名路由。
3. **V1 用户可视记录提供者与受权路由（`server/agent/service/hosted-visuals.mjs`、`server/agent-service/visual-routes.mjs`）**：`account-tools.mjs` 已挂载 `visuals` 族并暴露 `recordVisual`；`agent-service/http.mjs` 已挂载 `createVisualRoutes` 处理 `/v1/conversations/:id/visuals/:vid` 与 `/agent/v1/conversations/:id/visuals/:vid`（含 `/files/:name`）。
4. **载入缝 `SEAM-2` 收口（`server/agent/ssr-host.mjs`）**：`agent-board.mjs`、`agent-roles.mjs`、`agent-sessions.mjs`、`creativity-gate.mjs` 及 `hosted-tools.mjs` 统一经 `ssr-host.mjs` 载入缝引用前端模块与卡片辅助库，`accept-018-rest-ssr-seam.test.mjs` 中 `KNOWN = []` 且 `SEAM-2` 转为硬断言通过。

