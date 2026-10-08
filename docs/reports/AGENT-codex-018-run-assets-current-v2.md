# 018 Run Assets 当前登记 v2：实施记录

- 工作区：`018-cloud-assets-central-glue`，分支 `codex/018-run-assets-current-v2`，起点 `8c1078f6b8df2087c2852e924826450ed6161167`。
- 本包仅接 doc 侧 root-owned asset 登记读/接受；Astra 冻结的纯 schema 源 `4b7b09dceaad5409fb697163f15500854b5879ed` 只按两份固定文件复制，不合其分支。
- v1 `run-assets-current-registry.mjs` 的现有导出语义保留；v2 明确分派，不把 v1 root 文件或 checkpoint 降级复用。
- root 已在 Linux systemd 249 独占 slice 实际验证父进程退出但子进程持 FD/TCP 时 populated=1 的拒绝、同固定 scope populated=0 与双 birth 消失/双 EOF，以及文件和目录持久化后释放。旧 ENODEV 失败是历史证据，不能记作 v1 通过；本叶不会自己制造 OS 见证。
- 尚未生产启用。缺完整 root-owned history、出版锁前后核验、root 初始 anchor、独立 SQLite v2 checkpoint 或耐久提交，持续返回 503；纯模块测试不代表生产资产已挂载。

## 固定接口与信任边界

- 独立依赖提交 `3621460735e4f19c1224bd7991ace4836c7d0c36` 只复制 Astra 固定 Git 对象 `4b7b09dceaad5409fb697163f15500854b5879ed` 的 `asset-root-registry-schema-v2.mjs` 与其测试；两个本地 blob hash 分别与来源一致：`7528be7a0129f987c84bebcf8ad68daf2773004f`、`d4a570bc8cca363b97047c53a0f52fc267c05f17`。纯契约拒绝混用v1，要求service与独占scope双身份、root witness的populated=0/双birth/独占/停机事实、完整1..head历史。
- 新 `readRootRunAssetCandidateV2({files,expected,configuredAnchorDigest})` 的 `files` 为同一root-owned目录的`current.json/anchor.json/reservation.json/.publisher.lock`。读取每代不可变`epoch-<n>.json/reservation-<n>.json/publication-<n>.json`与n>1的`witness-<n>.json`，逐层root uid/权限/非符号链接和FD核验，要求锁前后均不存在、目录和全部文件复读不变，调用唯一共享schema核完整历史、双tuple、marker/anchor/reservation摘要。`configuredAnchorDigest`必须由root显式给小写64位SHA256并与完整anchor求值一致；不从候选文件自行批准。producer另有transition/runtime-dropin等文件不是doc授权证据，读端不接收。
- 新 `createRunAssetCurrentRegistryV2({ledger,files,expected,configuredAnchorDigest})->{current,acceptCurrent}` 只用同一doc SQLite ledger的独立`runAssetCurrentCheckpointV2`键。`current()`缺checkpoint或root当前head不同立即503；`acceptCurrent()`首次只许epoch1，已有高水位只能从已接受摘要沿已验证完整链前进，事务内复读root证据并提交，返回前再读当前，不能先在RAM放行。若已有v1已接受键，显式报`asset-root-v2-v1-migration-required`，没有自动迁移或回退。
- 新 `readRootAssetReservationV2({reservationFile,expected})` 只核root-owned v2 reservation、closureScope、epoch与完整预期，不接受current。`asset-runtime` 仅显式`runAssets.rootProtocol:'v2'`时改走此入口，缺reservation或未知协议503；原未声明/v1读取语义不变。当前生产`main/combo`尚未传v2 root配置，故v2的doc接受工厂**尚未生产挂载**，资产服务也不会凭这个新只读函数自动获得ready。
- 原任务指出的`server/asset-service/wiring.mjs`在此基底不存在；实际reservation消费是`server/hosted/asset-runtime.mjs:21,42`。根已对这一路径精确扩租，仅修改了显式版本分派。v1 root文件、旧checkpoint、root OS producer与节点均未改。

## 验证与未完成

| 固定源/阶段 | 实际结果 | 原始证据 |
|---|---|---|
| Astra纯schema依赖与本包初版 | 无业务监听的schema＋v2/v1目标34/34，0 fail/cancel/skip；强制类型exit0。仅证明解析、纯转换和Windows拒绝root文件 | `%TEMP%/pc-run-assets-v2-first/target.out.log`、`%TEMP%/pc-run-assets-v2-first/type.log` |
| 本包产品固定`63bfc0fa551b6147414e7ace55f69f446a05ad05` | 加真实SQLite独立v2键关闭重开回归，目标35/35、0 fail/cancel/skip、duration120.3ms，强制类型exit0，diff-check0；未启监听、未跑full | `%TEMP%/pc-run-assets-v2-fixed/target.out.log`、`%TEMP%/pc-run-assets-v2-fixed/type.log` |

上述Windows目标不能建立root-owned Linux目录，故没有证明真实root文件读取、publisher文件/目录fsync、OS旧树关闭或实际v2 `acceptCurrent`的Linux正向。根与Astra的systemd249独占slice实验只证明OS取证机制的一段；新producer runtime adapter、root配置、真正doc `combo`挂载、两代pinned TLS/observer与SQLite联合探针仍需后续独立验证。缺它们不得宣称run-assets生产就绪；本叶不操作节点、不运行全量。
