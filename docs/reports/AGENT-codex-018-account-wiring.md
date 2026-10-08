# 0.7.18 账号与 hosted 文档服务接线

工作区 `codex/018-account-wiring`，起点 `f9390ddae50c357c28662030ec137e1e14eda656`。本报告只记录此分支实作和验证；文档设计中的“拟实现”不算产品已接线。

## 范围与当前状态

- 接线范围：真实 hosted 组合的账号项目权威、账号凭证核验、项目授权、文档服务 WebSocket 与 HTTP 入口、事件收口。LAN 用户名路径保留。
- 已阅读开发指南及必读约束、账号绑定任务与契约、三版本设计及渲染调度补充。渲染补充的未决提前回收、故障重试语义与会话删除细节不由此包裁定。
- 当前状态：文档服务的账号入口和 hosted 组合接线已写入源码；素材服务的账号消费者、Agent/render 消费者与三个服务的关闭回执尚未挂载。当前组合尚未注入可信素材实时探针，故账号 `/join`、`/session` 为 503，账号模式素材请求为 503；不得把这段算作 0.7.18 产品完成。

## 接口与实作记录

- `server/docservice/account-hosted.mjs` 使用既有 account client、ledger、authority，启动先追 account 事件 head；每次 WS 建连、HTTP long-poll 建连、逐消息、接续和素材票据解析都通过 authority 做真实账号凭证核验与 head 追齐。连接与素材票据为短期随机 opaque 值，服务端映射到 `authorizationId`，不落持久库；项目和 audience 绑定，错票据、过期与远端不可达拒绝。项目创建初始化写项目快照和操作日志后 fsync，才允许 authority 把项目从 pending 转 active。
- `router/session/service/http-transport` 接入异步 gate，在同一连接上串行等待权限检查后再执行消息处理；HTTP 与 WS 接续等待权限检查。凭证验证不可达返回 503，不回退 LAN 口令。`shared-service` 在 account 模式拒绝旧 username 数据入口，账号项目公共接口单独挂在 `/hosted/shared/account`；LAN 的旧路径保持原样。
- `d96530d5` 审查闭口：根的受控双鉴权反例在 `maxConnections=1` 下实际接入两条 WS（2/2，exit 1）。WS 和 LP 都在异步鉴权返回后、没有其它 await 的同步开会话前重查关停、容量和传输状态；异步接续 gate 返回后也检查新传输仍可用，断开的新传输不能替换旧会话。相同反例修后为 1/2 接入、连接数 1、exit 0，不更改容量数字。
- `modules/account-projects.mjs` 给内部 mTLS `/internal/v2/access/check` 增加可选 `assetTicket` 解析钩子，调用方证书 fingerprint 映射固定 serviceId，body 不能声明 serviceId 或用假 principal 与票据混用。asset owner 的接线接口是 `POST /internal/v2/access/check`，body `{assetTicket,projectId,action,resource}`；通过为 200 `{allowed:true,...}`，无证或错证为 TLS/403，错票据 401，错项目 403，authority/head 不可达 503。正确的既有内部 principal 调用仍经过 authority 本身核验。
- 后续最小接口增量：素材 `assetTicket` check 的 body 可省 `projectId`，doc 由真实票据解析出的 `principal.projectId` 取项目；显式给项目仍须相等。素材无权从 HTTP body 另选项目。账号 runtime 增 `assetReadyProbe({authorityId,requiredAccessHead})`，可信组合须以 doc 自己的 mTLS 证书向独立 asset 内部 `GET /internal/v2/asset/status` 查询，回包 `{ok:true,ready:true,authorityId,instanceId,accessCursor,accessHead}`。每次 join/session 前 doc 先同步 account 事件并读取持久 accessHead，探针返回后再同步，只有 doc 两次 head 不变、asset cursor/head 均精确等于该 head、authorityId 与配置/本请求的 instanceId 匹配才放行；所有缺失、断联、错代或新 head 竞争返回 503。join 前探针失败不得落 membership，issueSession 在 membership 变化后再实时探测一次且核同一 instance。`sessionReady` getter只是上次探测状态的健康字段，不作授权凭证；无 callback 的生产 runtime 恒拒，手动 `setAssetReady` 只在显式 `allowFixtureAssetReady` 的测试模式可用。中央组合注入与真实 asset consumer 由另一 owner 接线，本叶没有伪造其挂载。
- `hosted/combo.mjs` 用显式 account 配置组装独立 loopback mTLS 内部监听；账号模式旧素材中间件目前 503，直到素材 owner 真正挂 consumer、head catch-up、project store、关闭与 receipt，再由可信组合内部设 `assetReady=true`。public HTTP 没有设置 ready 的路由。`hosted/main.mjs` 加 `PROMPTCUT_ACCOUNT_V2_REQUIRED=1` 守卫；必需账号模式却没有完整配置时启动失败。文档与素材 health 在 account 模式公开非秘密 `accountMode`、`accountRequired`、`assetReady`。hosted staging 清单增加 `server/account`，新 doc adapter 随原目录复制。
- 生产启用至少需要 `PROMPTCUT_ACCOUNT_V2=1`、`PROMPTCUT_ACCOUNT_V2_REQUIRED=1`、账户 HTTPS origin/authorityId/authorityUrl/固定服务端指纹、签名 keyId 与私钥文件、doc 客户端 key/cert/CA、内部监听 key/cert/CA、内部 service 指纹映射文件与端口。配置缺失、证书错或 account head 不可达会拒绝启动/入口。当前 0.7.17 的兼容默认未改；0.7.18 发布流程必须强制 required，并由部署 owner 在节点配置传播与实际多 OS 用户隔离验收，不能仅据此源码发版。

## 验证与剩余缺口

- 独立 fixture 使用冻结的 VisuHive account provider 和临时签发 mTLS 证书，端口 5823–5825、容量夹具 5827–5828；定向 `npm test -- server/test/account-hosted-wiring.test.mjs` 本轮 4/4，通过创建与状态、真实 WS `project.state`、跨项目拒绝、HTTP LP、内部素材票据、错误/无证书、假 principal、双登录被踢两条真实 WS 关闭、账号登出后逐消息与素材票据拒绝。账号真实 WS 接续用未确认 seq 1 验证 welcome 先于原序号补发、旧传输 4009 与 connId 不变；LP 接续也验证原 seq 1 的补发；被踢 LP 接续 410，上游断开 LP 接续 503、WS 接续 1012。独立 probe 4/4，输出只含检查结果，不含 raw token。fixture 的 `setAssetReady(true)` 仅模拟素材服务已挂载，不能证明生产 ready。暂存包导入账号依赖且 required 缺配置 exit 1；已有 legacy staged 完整测试也通过。
- 初始化故障用测试专属子进程拦截真实 `fs.fsyncSync`：项目快照和日志落盘、最后一个 snapshot fsync 返回后立刻 exit 86，authority 尚未执行 active 提交。父进程重开持久 ledger 看到唯一 pending 项目与快照、日志各一份；同请求重试把同 projectId 转 active，第二次幂等重试返回同结果且日志仍仅一份。故障开关只在临时测试子进程，不在产品入口。
- 素材探针新测试在 5829 建独立 HTTPS mTLS status listener，doc 使用自己的客户端证书与 server fingerprint 核验；状态落后时 `/join` 返回 503 且 membership 仍为 0，consumer 追齐后同服务不重启即可 join，join 导致新 accessHead 时 issueSession 的第二次探针再核。探针回包到 doc 二次同步之间主动创建真实项目事件，head 增长时拒绝；错 instance、断联、生产手动置 ready 也拒绝。此 status listener 是 doc 接口测试夹具，不替代素材 owner 的真实消费者与流关闭证据。
- 该接口增量最终 `npx tsc -b --force` exit 0，定向 `npm test -- server/test/account-hosted-wiring.test.mjs` 4/4（包含真输入 probe 4/4），完整 `npm test` 一次 exit 0：4989 项、4987 pass、0 fail、2 skip、64.40 s。5823–5829 结束后无监听。中央 combo 尚未传入探针，故当前源码生产 join/session 仍 503；素材 owner 会在独立叶验证真实 consumer 与 status，再由根按固定提交集成。
- 闭口后的 `npx tsc -b --force` exit 0；完整 `npm test` 一次 exit 0，4989 项中 4987 pass、0 fail、2 skip，66.96 s。前一提交 `d96530d5` 的本叶完整测试是 4987/4985 pass/0 fail/2 skip，根独立复验相同源码则为 4987/4986 pass/0 fail/1 skip；环境可选项 skip 数不同，均不把 skip 当 pass。首次全量失败曾因 staging 未复制 `server/account`，已补清单，不能隐去。provider 固定 HEAD `580bec81325e09a92a805f8d33bb7353a45503d8`；此叶未改冻结 provider 与 password-order。
- 修复过程的首次失败尝试：Windows 只读 fd fsync `EPERM`，改为 `r+`；异步 gate 的 Promise 在 service wrapper 被丢弃，导致跨项目错消息放行，已转发 Promise；principal 规整漏 `projectId`，导致项目错拒绝缺失，已加入；5820–5822 与 5826 有别的进程占用，未触碰，fixture 改用 5823–5825；provider 登出事件检查早于同步得到 `no-event`，测试改为先真实 `synchronize()` 再读 barrier；首次全量 staging 缺 `server/account` 为 `ERR_MODULE_NOT_FOUND`，已加部署清单并复测。
- 本轮首次失败尝试：新增 crash 夹具的第一次定向测试中 Windows 临时目录清理 `EPERM`，因为 recovery ledger 在外层 cleanup 之后才关闭；已改外层先关 recovery，再删该轮临时目录，随后定向 4/4。一次直接以 PowerShell 清理那份失败轮残留临时目录的命令，在已核对绝对路径与临时目录父目录的情况下仍被工具拒绝，返回原文 `CreateProcess ... rejected: blocked by policy`，没有提供更细的理由；未绕过。按根要求保留 `C:\Users\admin\AppData\Local\Temp\pc-account-wiring-NNgUu9` 作为首次失败证据。根先前裸运行 probe 缺输入而 exit 1，是命令调用缺必需 URL/输出路径/凭证；本轮 fixture 内带真输入的 probe 4/4。
- 未覆盖或未挂载：真实生产组合启用账号配置的端到端启动、素材 consumer 实际追齐与接口、Agent/render 消费者及三方 closed ACK、独立 OS 用户的私钥隔离、0.7.18 公共节点 required 配置传播。登出后的 `logoutComplete=false`、pending services 是准确状态。渲染调度补充未决项保持未决。此叶不推送、不部署、不裁定发布。
