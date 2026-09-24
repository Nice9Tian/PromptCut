# C5 素材服务数据层实现报告

- 角色：c5-impl（`claude/c5-impl`，基于 `claude/c5` 的 `fdf8963`）
- 依据：`docs/plan/asset-store-contract.md` 第 2～5 节；语义 `docs/semantics/architecture/asset-storage.md`、`document-service.md`「连接发现」
- 可改文件：新建 `server/asset-store/{index,blob-store,fs-store,memory-store}.mjs`、`server/asset-announce.mjs`；修改 `server/asset-service.ts`、`server/vite-plugin-media.ts`（只改 `mediaPlugin()` 接线）；`server/test/asset-service.test.mjs` 只在 `compile(...)` 替换表里加行
- 端口段：5460～5469（G0-R 基线对照用 5463）

## 进度

- [ ] `server/asset-store/`（接口、fs、memory）
- [ ] HTTP 层改走 `BlobStore`
- [ ] 写入鉴权
- [ ] 地址登记 `asset-announce.mjs`
- [ ] `mediaPlugin()` 接线
- [ ] 基线：tsc、npm test
- [ ] G0-R

（开工占位，后续每块完成时补充。）
