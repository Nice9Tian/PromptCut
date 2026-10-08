# 云端项目素材数据链与 ProjectAssets 实施报告

2026-10-08；分支 `codex/018-cloud-project-assets`；固定基底 `7dab214f8dc521ef908141a06b14b7996520f1dd`。这是 B 功能叶；A 最终报告已在独立叶提交 `4766384b17c81e6dcb68562ccd76764f2cd9435f` 并冻结。

## 目标与边界

按 `docs/plan/cloud-agent-project-assets-implementation.md` 实施独立 asset 数据链与 Agent ProjectAssets。只新增 `server/hosted/asset-run-access.mjs`、`asset-run-client.mjs`，必要的 `server/agent/service/project-assets.mjs`、`run-asset-client.mjs`、`tool-assets-resources.mjs`，专用 `server/test/project-assets-*.test.mjs`、`asset-run-*.test.mjs`、fixtures 与本报告；仅窄改 `server/asset-store/project-access.mjs` 的通用资源 lease／run 暂停接缝、`project-revocations.mjs` 的唯一人类 consumer 参与者 hook。原人类撤销、actual close、持久 receipt 与 ACK 继续保留。

A 协议复用冻结 `909a6b96`，文件 SHA256 `d44879481a93af8c86aa258b5349084e25753c8f93ba814ec28ebe5c2e85d777`。不复制身份或 run 权威、不签通用 proof、不修改 A、instance/run/operation/Jobs/run-resources/store/publication/中央/worker。worker 窄 facade 与实际 run-resources 以其冻结 API 适配；未挂生产 adapter 保持 503。

## 验证约束与当前状态

目前只开工、读规则/已审方案和源码；没有 B 功能验证结果。可做无业务 listener 的精确 `npm.cmd test -- ...` 与类型；保留仓库 wrapper 的 38 个坏端口 guard 候选例外，不 bypass。真实 mTLS／子进程目标仅先编写，固定源码后向 root 申请一次窄窗口。6480～6489 只是建议、未核空也未授权，不启动。full／宽 probe／部署／节点均未做。

所有自有数据、日志、spool、测试密钥在 TMP；子进程 windowsHide、隐藏绝对 preload；Python/cuda/models/provider/order 仅进程环境；不安装依赖、不 junction、不改变系统环境、用户端口或数据、不推送/合并。首红与每次有因修正将逐次补记。

## 阶段源码与首次目标

2026-10-09继续原叶；未重建、回滚或盲合根。0923f62b是开工报告；e36f3854完成新client/access/consumer、ProjectAssets及实际run-resources适配和通用lease两窄处。A复核曾临时回其独立叶，最终56dbee2c交root，本B只读原基底A，协议909/worker/中央不改。

e36目标 `npm.cmd test -- server/test/asset-run-lease.test.mjs server/test/asset-project-stores.test.mjs server/test/asset-project-revocations.test.mjs` 首红13项12pass/1fail、0cancel/skip，129.4722ms，墙422.5495ms，TMP `pc-project-assets-pure-1.log`：暂停决策已拒后assert仍再调check，实际run-revoked，断言要求access-revoked。4a9e650a最小修为await暂停决策后先重新核aborted/released，再决定调用权威，没有降低断言；同三目标13/13/0fail/cancel/skip，131.4356ms，墙418.1566ms，`pc-project-assets-pure-2.log`。

790da014目标 `npm.cmd test -- server/test/project-assets-client.test.mjs server/test/asset-run-lease.test.mjs` 6/6、0fail/cancel/skip，121.4459ms，墙492.6387ms，`pc-project-assets-client-1.log`。真实physical projectStores/完整hash/实际Readable与FileHandle，工具import只返stored、无mediaId/registeredMedia；context/Job/abort反向和handle跨run拒。wire、account、lifecycle与sender adapter受控，不是production crypto或三方mTLS。

原npm wrapper38坏端口候选guards保留；上述fixture无业务listener。所有Node带父仓库绝对silent preload，PSModulePath唯一canonical键，cuda_Vit/PYTHONDONTWRITEBYTECODE/models与显式VH provider/order/conversation只有进程env。没有运行裸node --test、业务TLS、full/C10或节点。最终类型与完整新handler验证尚未做，前两轮pure绿不替代它们。

## 当前接口与可信缺缝

`createAssetRunClient({origin,tls,serverFingerprint256,timeoutMs,maxResponseBytes})` 只持asset自己私钥；openLease独占observer keepalive socket，换socket永久拒continuation，返回check/closeLease/close；eventsSince/acknowledgeEvent独立连续日志通道。`createAssetRunConsumer({client,file,assetInstanceId,serviceIdentity,verifyLifecycle})` 持久cursor/pending receipt/非秘密lease归属，未知重启lease failclosed。人类consumer新增participants，仅原单consumer写access ACK；run participant先同步pause后独立doc核验，合法retained恢复，revoked等owned资源实际close与持久lease receipt后才run ACK，不在recheck里递归锁。

`createAssetRunAccess`只走独立Agent mTLS handler；实际wire重建909 tuple，标准body长度/摘要与peer exporter，不收public tuple/actor或loopback免票据。project目录只来自`projectStores.project(doc已核projectId).root/dirs.media`。root已授权本项目+runGrant+已验proof实例代际+importId摘要的暂存BlobStore，复用hash完整核验；temp文件每read/write fresh assert，实际FileHandle close，最终通过既有publishProjectFile marker/dirsync/回退。GET/HEAD只看projectStores已接受目标，不直接读暂存。cancel不删除其它合法同hash。

Agent `createRunAssetClient`消费worker的隐藏raw票据facade；`createProjectAssets`只收可信8字段context/媒体引用/内容。resources用冻结register(context,{kind,resource})/signalFor等真实接口；spool quota的reserveImport与workspace(context)须真实宿主提供，sourceJob提供时另核同context，不设默认数字。存入字节与doc addMedia仍分开。

G仍须接force current服务registry、真实A observed私有subject与actual closure verifier、asset lifecycle/root旧cgroup witness、双head required状态、真实worker transport/额度与workspace adapter。缺这些生产保持503，HTTP/UID/OS重启未知不借empty Map或计数0完成。当前未正式交付，handler/receipt/发布目标与最终类型仍在本叶补；root共同基线不是本B新源的证据。
