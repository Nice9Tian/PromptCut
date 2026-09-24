# C6.4 预渲染管线侧实现报告（c6-4-pipeline）

- 分支：`claude/c6-4-pipeline`（从 `claude/c6-4` 起）
- 依据：`docs/plan/manifest-contract.md` 第 3、4、5 节；`artifact-transfer-contract.md`（含第 10、11 节）；`docservice-contract.md`；`cloud-task.md` A3b、A5
- 文件：`server/artifact-transfer.mjs`、`server/artifact-push.mjs`（新）、`server/frame-pipeline.mjs`、`server/frame-stream.mjs`、`server/vite-plugin-frames.ts`

## 进度

- [ ] 第 3 节：`createAssetSink` 接 `content`、`resultFor`、`put` 之后写清单
- [ ] 第 4 节：`artifact-push.mjs` 推送队列
- [ ] 第 4 节：`frame-pipeline.mjs` / `frame-stream.mjs` 钩子
- [ ] 第 5 节：`adoptFromManifests` 与调用点
- [ ] 第 4 节末段：`vite-plugin-frames.ts` 接线（方案先写在下面）
- [ ] 验证：tsc、npm test、G0-R、自测
