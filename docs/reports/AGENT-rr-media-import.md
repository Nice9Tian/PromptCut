# AGENT-rr-media-import: 在线浏览器素材导入全链路实现报告

依据 `docs/plan/user-decisions-2026-10-14.md` 第 2.5 节以及 `docs/reports/AGENT-rr-small-first.md` 第 3 节规范，在独立工作树 `C:\Users\admin\Documents\PromptCut\.worktrees\rr-media-import`（分支 `gemini/rr-media-import`）完成在线浏览器素材导入全链路开发与验收。

---

## 1. 任务背景与现状

在本次改动前：
- 在线浏览器环境中的「导入媒体」按钮处于禁用置灰状态（`LibrarySection.tsx`、`GroupBox.tsx` 显式判断 `onlinePage()` 禁用并标记 `onlineUnsupported`）。
- `src/editor/io/mediaUpload.ts` 中的 `uploadMediaFile` 在在线构建分支中直接返回 `null`，且未连接任何素材上传链路。
- 浏览器端缺少针对视频文件的前端转码能力，无法在客户端产出 `tiers.small`（800×600 偶数分辨率、H.264 编码的微缩预览视频）。
- 浏览器端缺少直接向远端素材服务（`media` 命名空间）分片上传、对账、断点续传并遵循「所有视频小尺寸先传、再传原尺寸」铁律的上传队列机制。

---

## 2. 核心改动与实现

### 2.1 浏览器端轻量视频转码与流式哈希 (`src/online/mediaTranscode.ts`)
- **`smallVideoDimensions(w, h)`**: 计算保持宽高比缩放至 800×600 以内的偶数分辨率，小于该尺寸不放大；奇数尺寸下取偶数。
- **`Sha256` & `sha256Blob(blob)`**: 纯 TypeScript 实现的流式分块 SHA-256（固定 2 MiB 内存窗口，不依赖 `node:crypto`），与 `node:crypto` 逐位一致，适合浏览器端多 GB 大文件哈希计算。
- **`transcodeVideoSmall(blob, opts)`**:
  - 基于浏览器 WebCodecs API（`VideoEncoder`、`VideoFrame`）结合现有的 `src/export/mp4Mux.ts` 进行快速 H.264 MP4 转码与封装。
  - 使用 `<video>` + 离屏 `<canvas>` 进行帧步进，生成符合 800×600 规范的 `tiers.small` 视频（不带音频轨）。
  - **优雅降级**：当浏览器不支持 WebCodecs、格式无法解码或元数据解析失败时，静默捕获异常并返回 `null`，确保只传原尺寸一档，流程不崩溃。

### 2.2 在线素材上传队列 (`src/online/mediaUploadQueue.ts`)
- 与桌面端 `server/upload-queue.mjs` 保持完全一致的调度与重试逻辑：
  - **小尺寸铁律优先**：队里只要有任何素材的 `small` 档位未传完，优先按进队先后派发 `small`；所有小尺寸在素材服务上确认 `complete` 后，才按入队 FIFO 派发 `original` 档位。
  - **动态抢占**：在原尺寸派发期间若有新素材入队（或后补上小尺寸），其小尺寸排在剩余原尺寸之前，在当前正在传输的档位完成后立即派发。
  - **退避阻塞**：小尺寸档位重试退避期间，任何原尺寸均被阻塞，不提前偷传。
  - **分片对账与完工确认**：每档向素材服务 `GET /api/asset/media/<hash>/chunks` 对账，只补缺片（`PUT /<hash>/<n>`，每片 8 MiB，带 `X-Media-Size` 与 `X-Media-Ext` 头），最后 `POST /<hash>/complete`，且在所有档位均报 `complete: true` 后才出队。
  - **`holdOriginals()`**：提供批次挂起句柄，批量导入多文件时在所有文件的 `small` 档入队完成前挂起 `original` 派发。
  - **单例与鉴权**：`getOnlineMediaUploadQueue()` 自动解析协作与账号模式素材票据（`Authorization: Bearer <ticket>`），支持 401 票据过期自动换票重试。

### 2.3 编辑器 UI 入口与导入管线接线
- **`src/editor/left/LibrarySection.tsx` & `src/editor/left/library/GroupBox.tsx`**:
  - 解除「导入媒体」按钮及空分组导入按钮在在线环境下的 `disabled` 置灰，移除 `onlineUnsupported`。
- **`src/editor/io/mediaUpload.ts`**:
  - 实现 `uploadOnlineMediaFile(file)`，在 `ONLINE_BUILD || onlinePage()` 时激活：流式计算原文件 SHA-256，尝试转码 `small` 档，构建 `{ tiers: { small, original } }`（或 `{ original }`），入库素材表并推入上传队列。
  - 桌面端专用路径 `watchSmallTier`、`backfillSmallTiers` 增加 `|| onlinePage()` 防御守卫，避免在线环境触发本地进程轮询。
- **`src/editor/left/importAssets.ts` & `src/editor/io/index.ts`**:
  - `importMediaFiles` 与 `importVideoFiles` 在导入批次前调用 `holdOnlineQueueOriginals()`，批次结束安全释放，确保同批选中的所有文件的小尺寸全部排入队列后才允许派发原尺寸。

---

## 3. 关键设计决策与约束核对

1. **工作树与分支隔离**：
   - 全程在 `C:\Users\admin\Documents\PromptCut\.worktrees\rr-media-import`（分支 `gemini/rr-media-import`）操作，绝对未碰触主工作树及其他工作树。
2. **严禁修改的文件**：
   - `src/editor/Preview.tsx`、`src/editor/preview/**`、`src/export/**`、`server/render-node/**`、`docs/plan/*-progress.md`、`docs/plan/TODO.md` 均未做任何改动。
3. **在线构建无 `/api/` 泄漏与死代码消除**：
   - 采用 `if (ONLINE_BUILD || onlinePage()) return uploadOnlineMediaFile(file);` 模式，在 `vite build --mode online` 时将桌面端原有的 `/api/media/upload/...` 彻底剪枝消除。
   - `c10a-online-api-paths.json` 棘轮校验保持 0 泄漏，测试通过。
4. **端口规范**：
   - 测试中 HTTP 素材服务绑定在专用端口 `20035`（严格处于 `20030-20039` 范围内）。
5. **换行符规范**：
   - `node eol-audit.mjs . main HEAD` 返回 0，无任何颠倒换行符。

---

## 4. 验证与测试结果

### 4.1 新增测试套件
1. **`src/online/mediaTranscode.test.mjs`** (5 项全过):
   - `smallVideoDimensions`: 验证 1080p、竖屏 9:16、4:3、小尺寸不放大、奇数尺寸偶数化及异常尺寸回退。
   - `Sha256 & sha256Blob`: 验证文本、随机二进制及多兆大文件与 `node:crypto` 逐位一致。
   - `transcodeVideoSmall`: 验证无 `VideoEncoder` 环境优雅返回 `null`；视频元数据解析失败优雅返回 `null`；标准 WebCodecs 模拟下产出合法 H.264 MP4。
2. **`src/online/mediaUploadQueue.test.mjs`** (7 项全过):
   - 基础校验与非法项处理（缺少 original、非法哈希、同 ID 合并）。
   - 派发顺序铁律：3 素材先小后大（A 小 -> B 小 -> A 原 -> B 原 -> C 原）。
   - 原尺寸派发期间新素材进队插队抢占。
   - 退避机制：小尺寸在退避期间，任何原尺寸都不传。
   - `holdOriginals()` 批量导入挂起与释放。
   - 401 票据过期自动换票重试。
   - **真 HTTP 素材服务（端口 20035）全链路验收**：在专用端口启动真实 HTTP 素材服务（`assetServiceMiddleware`），上传真实二进制视频/图片数据，验证物理请求段序严格为 `[A.small, B.small, A.original, B.original, C.original]`，分片与 complete 齐备，素材服务全件 SHA-256 和字节一致。

### 4.2 回归与编译检查
- `npx.cmd tsc -b --force`: 退出码 0，全项目无任何 TypeScript 类型错误。
- `src/online/onlinePrune.test.mjs`: 2 项全部通过（ONLINE_BUILD 语法无歧义）。
- `server/test/c10a-online-build.test.mjs`: 11 项全部通过（在线产物打包成功，棘轮清单完全吻合）。
- `server/test/media-tiers.test.mjs`、`server/test/c66-upload.test.mjs`、`src/editor/media/assetTiers.test.mjs`: 37 项全部通过。
- `node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . main HEAD`: 退出码 0，换行符审计完全通过。

---

## 5. 提交变更清单

- `src/online/mediaTranscode.ts`: 纯 TS 视频转码与流式 SHA-256。
- `src/online/mediaTranscode.test.mjs`: 转码与哈希单元测试。
- `src/online/mediaUploadQueue.ts`: 在线素材上传队列与调度器。
- `src/online/mediaUploadQueue.test.mjs`: 上传队列单元测试与真 HTTP 集成测试。
- `src/editor/io/mediaUpload.ts`: 在线上传适配器及剪枝分支。
- `src/editor/io/index.ts`: 批量视频导入包裹 holdOriginals。
- `src/editor/left/importAssets.ts`: 批量素材导入包裹 holdOriginals。
- `src/editor/left/LibrarySection.tsx`: 解除在线「导入媒体」禁用。
- `src/editor/left/library/GroupBox.tsx`: 解除在线空分组导入禁用。
- `docs/reports/AGENT-rr-media-import.md`: 本验收报告。
