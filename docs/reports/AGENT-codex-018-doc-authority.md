# 0.7.18 文档服务账号项目唯一权威实施报告

2026-10-08。独立包 `codex/018-doc-authority`，工作区 `.worktrees/018-doc-authority`；起点986ebec6，已审账号协议前置合入HEAD278e08df。先读入口规则、方案与产品语义，再按已授权19包设计实现，不另裁调度补充的待确认产品决定。

## 范围

唯一源码范围为 `server/account/{client,authority,ledger}.mjs`、`server/docservice/modules/account-projects.mjs`、专属 `server/test/account-projects-*.test.mjs`；按需要新增 `scripts/probes/account-projects-probe.mjs`与专用fixtures。先交稳定mount/authorize/applyRevocation/list接口与夹具，再真实account provider/mTLS、隔离A/B账号、幂等/禁入/踢全设备/重启事件缺口等验证。账号provider580bec8只读引用，旧foundation与C10工作区保留。

不改中央接线、order、素材、Agent/UI、LAN规则，不安装/junction、不merge/push/main/version/部署/真实数据/清理工作区。5750～5759独占；Node子进程windowsHide与file:///绝对静默preload，Python需要时显式cuda_Vit及禁止pycache。最终记录每次真实失败/修正、types/目标/完整npm结果和未挂载边界；模块通过不能冒称生产云项目已通。
