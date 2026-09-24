# C6.4 预渲染管线侧实现报告（c6-4-pipeline）

- 分支：`claude/c6-4-pipeline`（从 `claude/c6-4` 起）
- 依据：`docs/plan/manifest-contract.md` 第 3、4、5 节；`artifact-transfer-contract.md`（含第 10、11 节）；`docservice-contract.md`；`cloud-task.md` A3b、A5
- 文件：`server/artifact-transfer.mjs`、`server/artifact-push.mjs`（新）、`server/frame-pipeline.mjs`、`server/frame-stream.mjs`、`server/vite-plugin-frames.ts`

## 进度

- [ ] 第 3 节：`createAssetSink` 接 `content`、`resultFor`、`put` 之后写清单
- [ ] 第 4 节：`artifact-push.mjs` 推送队列
- [ ] 第 4 节：`frame-pipeline.mjs` / `frame-stream.mjs` 钩子
- [ ] 第 5 节：`adoptFromManifests` 与调用点
- [ ] 第 4 节末段：`vite-plugin-frames.ts` 接线（方案见下）
- [ ] 验证：tsc、npm test、G0-R、自测

## 接线方案（动手前写定，`vite-plugin-frames.ts`）

只在**预渲染进程**（`isPrerender`）里、`frameService()` 第一次建出 `FramePipeline` 之后异步做一次，不挡 `frameService()` 返回，任何一步出错只打日志、不建队列：

1. **无头实例不建**：`PROMPTCUT_HEADLESS === "1"` 时直接跳过（与 C6.3 第 10 节第 6、14 条同一口径：无头实例是临时副本，不该往共享服务写东西）。
2. **素材服务的基址**：用 `asset-client.ts` 的 `assetServiceOrigin()`（预渲染进程里就是 `PROMPTCUT_EDITOR_URL`，即编辑器进程里挂的本地素材服务），基址 = `<origin>/api/asset`。取不到（null）就不建。客户端 `createAssetClient({ base, token: PROMPTCUT_CLUSTER_TOKEN || null })`。
3. **文档服务**：照契约用 `render-node` 的 `resolveDocservice()`（缺省 env、全局 fetch、每个候选 3 s 探活）。回 `offline` 就不建；回 `remote` / `local` 才用它的 `url` 建 `createWsEndpoint({ url, token })`，再 `createContentClient(endpoint)`。
   - `createContentClient` 在 `claude/c6-4-node` 上，合并前 `render-node/index.mjs` 里没有它：用动态 `import("./render-node/index.mjs")` 取，取不到这个函数就打一行日志、不建队列（合并后自然生效；类型检查不受影响）。
4. 两样都有了才 `createPushQueue({ pipeline: service, client, content, dir: service.root, log, settleMs: 1500 })`，挂到 `service.pushQueue`，`start()`。`settleMs` 是本实现加的可选项（缺省 0）：同一段在最后一次进队后静置这么久再推，免得边渲边推时一段 60 帧被推十几遍；测试不传就是 0，不受影响。
5. **关闭**：`httpServer` 关闭时先 `queue.stop()`，再关 WebSocket 端点。
6. **离线就是不建**：上面任何一个条件不满足，`service.pushQueue` 保持 `null`，所有钩子都是空操作，行为与现在逐路径相同。

默认开发环境下（没设 `PROMPTCUT_DOCSERVICE_URL`，本机 8787 上没有独立文档服务）`resolveDocservice` 回 `offline`，所以 G0-R 自然跑在不推送状态。已查：本机 8787 没有监听，`PROMPTCUT_DOCSERVICE_URL` 未设。

**疑点（按最保守读法处理）**：`resolveDocservice` 的本机候选是独立文档服务 `ws://127.0.0.1:8787`（探 `/healthz`），找不到 C6.3 挂在编辑器进程里的本地文档服务（`ws://<编辑器>/docservice`，健康检查在 `/api/docservice/healthz`）。契约第 4 节只认 `resolveDocservice` 回 `remote` / `local`，所以本实现**不另探**编辑器里挂的那一份；也就是说只开编辑器、不设 `PROMPTCUT_DOCSERVICE_URL` 时不推送。要不要把挂载的本地文档服务也算作「能连上」，请主会话裁定（若要算，需要改 `endpoint.mjs` 或在这里多探一个候选，而且会让默认开发环境也开始推送）。
