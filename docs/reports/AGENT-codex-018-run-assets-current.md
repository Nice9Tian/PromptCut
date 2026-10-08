# 当前主线的云端运行素材闭环

开工基点 `eb8228a4a93d9283f23507a7a826fa7b9fcc0358`，分支 `codex/018-run-assets-current`。本包在当前主线既有的账号严格证书 pin、独立素材服务和关闭屏障之上，移入旧私有包经过验证且仍缺失的文档权威媒体 selector、双 head、私有元数据及独立素材读取接缝。只逐项移植所需语义，不用旧文件覆盖已收主线实现。

租约限于父任务指定的 hosted run-assets 新模块、media-selector、doc/asset assembly、asset-runtime、asset-run-access、files、Agent project-assets、专属测试和本报告。不动账号/运行授权底层、素材既有 handler/lease、combo/main、节点或 release。运行中的服务及用户数据不碰。先核对旧包与当前实现的真实 exports 和安全边界，再分别提交产品与验证。

验收记录待补：定向原始日志、首次失败、强制类型、真实 TLS/子进程关闭及 6440–6449 端口清空；全量/G0/C10 由根会话验。本包不以缺失的 asset OS/UID 关闭见证或静态配置伪造当前实例，也不把旧私有测试算作当前主线已通过。
