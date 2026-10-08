# 云端项目素材数据链与 ProjectAssets 实施报告

2026-10-08；分支 `codex/018-cloud-project-assets`；固定基底 `7dab214f8dc521ef908141a06b14b7996520f1dd`。这是 B 功能叶；A 最终报告已在独立叶提交 `4766384b17c81e6dcb68562ccd76764f2cd9435f` 并冻结。

## 目标与边界

按 `docs/plan/cloud-agent-project-assets-implementation.md` 实施独立 asset 数据链与 Agent ProjectAssets。只新增 `server/hosted/asset-run-access.mjs`、`asset-run-client.mjs`，必要的 `server/agent/service/project-assets.mjs`、`run-asset-client.mjs`、`tool-assets-resources.mjs`，专用 `server/test/project-assets-*.test.mjs`、`asset-run-*.test.mjs`、fixtures 与本报告；仅窄改 `server/asset-store/project-access.mjs` 的通用资源 lease／run 暂停接缝、`project-revocations.mjs` 的唯一人类 consumer 参与者 hook。原人类撤销、actual close、持久 receipt 与 ACK 继续保留。

A 协议复用冻结 `909a6b96`，文件 SHA256 `d44879481a93af8c86aa258b5349084e25753c8f93ba814ec28ebe5c2e85d777`。不复制身份或 run 权威、不签通用 proof、不修改 A、instance/run/operation/Jobs/run-resources/store/publication/中央/worker。worker 窄 facade 与实际 run-resources 以其冻结 API 适配；未挂生产 adapter 保持 503。

## 验证约束与当前状态

目前只开工、读规则/已审方案和源码；没有 B 功能验证结果。可做无业务 listener 的精确 `npm.cmd test -- ...` 与类型；保留仓库 wrapper 的 38 个坏端口 guard 候选例外，不 bypass。真实 mTLS／子进程目标仅先编写，固定源码后向 root 申请一次窄窗口。6480～6489 只是建议、未核空也未授权，不启动。full／宽 probe／部署／节点均未做。

所有自有数据、日志、spool、测试密钥在 TMP；子进程 windowsHide、隐藏绝对 preload；Python/cuda/models/provider/order 仅进程环境；不安装依赖、不 junction、不改变系统环境、用户端口或数据、不推送/合并。首红与每次有因修正将逐次补记。
