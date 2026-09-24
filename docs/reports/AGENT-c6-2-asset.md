# C6.2 素材服务侧（c6-2-asset）报告

- 角色：c6-2-asset；分支 `claude/c6-2-asset`（自 `claude/c6-2` 的 71236d0 起）；worktree `.worktrees/c6-2-asset`
- 依据：`docs/plan/artifact-transfer-contract.md` 第 1、2、8 节；`docs/plan/asset-store-contract.md`
- 文件：`server/asset-service.ts`、`server/http-guard.mjs`（只改 `isAssetServicePath`）、`server/asset-store/client.mjs`（新）、`server/asset-store/index.mjs`

## 进度

- [ ] 命名空间 `snap` / `px`（asset-service.ts、http-guard.mjs）
- [ ] 客户端 `client.mjs`
- [ ] 验证与自测
