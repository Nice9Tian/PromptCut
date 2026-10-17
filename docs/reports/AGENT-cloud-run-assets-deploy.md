# 报告：在生产节点上部署云端 Agent 的「运行素材」（`gemini/cloud-run-assets-deploy`）

- **日期**：2026-10-18
- **分支**：`gemini/cloud-run-assets-deploy`
- **工作区**：`.worktrees/cloud-run-assets-deploy`
- **任务书**：[`docs/plan/cloud-run-assets-deploy-task.md`](../plan/cloud-run-assets-deploy-task.md)
- **状态**：进行中

---

## 1. 背景与现状核实

1. **节点初始状态核实**：
   - 文档服务 `promptcut-doc-v2` 运行于 `/opt/promptcut-v2/releases/35f7b2ab/pc`；
   - 素材服务 `promptcut-asset-v2` 运行于 `/opt/promptcut-v2/releases/41b6d335/pc`；
   - Agent 主服务 `promptcut-agent`、root 调度 `promptcut-agent-root` 及 6 个任务槽 `promptcut-agent-task-slot-a..f` 运行于 `/opt/promptcut-render/releases/35f7b2abb9db`。
   - `/etc/promptcut/agent-root/agent-root.json` 的 `worker` 中**已配好** `runAssets`（`origin: "https://127.0.0.1:8794/"`，`fingerprint256: "ccd5b8a1ffcf9b08d463639de21e9c3d1186424c072e8652fe7c7ed54bca60ff"`，`maxResponseBytes: 16777216`，`maxImportBytes: 536870912`）与 `tools`；缺失的是文档服务 `PROMPTCUT_DOC_RUN_ASSETS_ENABLED` 一组环境变量、素材服务 `PROMPTCUT_ASSET_RUN_ENABLED` 一组环境变量，以及素材 root 登记目录 `/var/lib/promptcut/asset-root`。

2. **权限自检探针（`account-tools-perms-linux.mjs`）**：
   - 节点实测结果：`PASS 26/26`（退出码 `0`）。

3. **开启运行素材后的性能瓶颈与修复**：
   - 节点开启两侧运行素材并完成 epoch 1 登记后，`promptcut-asset-v2` 每 100ms 轮询 `GET /internal/v2/run-assets/events`，触发：
     1. `server/account/run-assets.mjs` 的 `mirror()` 每次轮询无条件执行 `ledger.transaction(...)`；
     2. `server/account/ledger.mjs` 的 `transaction(fn)` 在状态未发生任何变化时仍无条件执行 850 KB 账本 JSON 的 `UPDATE` + `PRAGMA synchronous=FULL` 磁盘 `fsync` + 全图 `deepFreeze`（耗时约 80ms/次，10 次/秒即占满文档服务单线程 80%+ CPU）；
     3. `server/hosted/run-assets-observer-authority.mjs` 的 `resolveObserver` 对已在 `WeakMap` 绑定且 `epoch`/`recordDigest`/`instance` 未变的同一条长连接每次重复发起 `POST /internal/v2/asset/run/observer/verify` mTLS 请求（20 次/秒）。
   - 修复方案：
     1. `server/account/ledger.mjs`：`transaction(fn)` 复用已缓存的原始 JSON 并在 `rawAfter === rawBefore`（状态无改动）时直接 `COMMIT` 跳过冗余写盘、`fsync` 与 `deepFreeze`，同时保留所有 `failpoint` 顺序与锁语义；
     2. `server/account/run-assets.mjs`：`mirror()` 在 `ledger.read()` 引用未变时直接返回上次已验证的头序号，有变化时先在只读快照上核验，仅当存在未镜像的新控制记录或表缺失时才开启写事务；
     3. `server/hosted/run-assets-observer-authority.mjs`：`resolveObserver` 对已在 `WeakMap` 中完成通道证明且当前根登记 `epoch`/`recordDigest`/`instance` 未变的同一条存活 TLS 连接直接复用绑定，换代或新连接照旧重验。
