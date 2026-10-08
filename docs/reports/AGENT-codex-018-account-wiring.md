# 0.7.18 账号与 hosted 文档服务接线

工作区 `codex/018-account-wiring`，起点 `f9390ddae50c357c28662030ec137e1e14eda656`。本报告只记录此分支实作和验证；文档设计中的“拟实现”不算产品已接线。

## 范围与当前状态

- 接线范围：真实 hosted 组合的账号项目权威、账号凭证核验、项目授权、文档服务 WebSocket 与 HTTP 入口、事件收口。LAN 用户名路径保留。
- 已阅读开发指南及必读约束、账号绑定任务与契约、三版本设计及渲染调度补充。渲染补充的未决提前回收、故障重试语义与会话删除细节不由此包裁定。
- 当前状态：文档服务的账号入口和 hosted 组合接线已写入源码；素材服务的账号消费者、Agent/render 消费者与三个服务的关闭回执尚未挂载。生产组合的 `assetReady` 保持 `false`，所以账号 `/join`、`/session` 为 503，账号模式素材请求为 503；不得把这段算作 0.7.18 产品完成。

## 接口与实作记录

- `server/docservice/account-hosted.mjs` 使用既有 account client、ledger、authority，启动先追 account 事件 head；每次 WS 建连、HTTP long-poll 建连、逐消息、接续和素材票据解析都通过 authority 做真实账号凭证核验与 head 追齐。连接与素材票据为短期随机 opaque 值，服务端映射到 `authorizationId`，不落持久库；项目和 audience 绑定，错票据、过期与远端不可达拒绝。项目创建初始化写项目快照和操作日志后 fsync，才允许 authority 把项目从 pending 转 active。
- `router/session/service/http-transport` 接入异步 gate，在同一连接上串行等待权限检查后再执行消息处理；HTTP 与 WS 接续等待权限检查。凭证验证不可达返回 503，不回退 LAN 口令。`shared-service` 在 account 模式拒绝旧 username 数据入口，账号项目公共接口单独挂在 `/hosted/shared/account`；LAN 的旧路径保持原样。
- `modules/account-projects.mjs` 给内部 mTLS `/internal/v2/access/check` 增加可选 `assetTicket` 解析钩子，调用方证书 fingerprint 映射固定 serviceId，body 不能声明 serviceId 或用假 principal 与票据混用。asset owner 的接线接口是 `POST /internal/v2/access/check`，body `{assetTicket,projectId,action,resource}`；通过为 200 `{allowed:true,...}`，无证或错证为 TLS/403，错票据 401，错项目 403，authority/head 不可达 503。正确的既有内部 principal 调用仍经过 authority 本身核验。
- `hosted/combo.mjs` 用显式 account 配置组装独立 loopback mTLS 内部监听；账号模式旧素材中间件目前 503，直到素材 owner 真正挂 consumer、head catch-up、project store、关闭与 receipt，再由可信组合内部设 `assetReady=true`。public HTTP 没有设置 ready 的路由。`hosted/main.mjs` 加 `PROMPTCUT_ACCOUNT_V2_REQUIRED=1` 守卫；必需账号模式却没有完整配置时启动失败。文档与素材 health 在 account 模式公开非秘密 `accountMode`、`accountRequired`、`assetReady`。hosted staging 清单增加 `server/account`，新 doc adapter 随原目录复制。
- 生产启用至少需要 `PROMPTCUT_ACCOUNT_V2=1`、`PROMPTCUT_ACCOUNT_V2_REQUIRED=1`、账户 HTTPS origin/authorityId/authorityUrl/固定服务端指纹、签名 keyId 与私钥文件、doc 客户端 key/cert/CA、内部监听 key/cert/CA、内部 service 指纹映射文件与端口。配置缺失、证书错或 account head 不可达会拒绝启动/入口。当前 0.7.17 的兼容默认未改；0.7.18 发布流程必须强制 required，并由部署 owner 在节点配置传播与实际多 OS 用户隔离验收，不能仅据此源码发版。

## 验证与剩余缺口

- 独立 fixture 使用冻结的 VisuHive account provider 和临时签发 mTLS 证书，端口 5823–5825；定向 `npm test -- server/test/account-hosted-wiring.test.mjs` 最终 2/2，通过创建与状态、真实 WS `project.state`、跨项目拒绝、HTTP LP open、内部素材票据、错误/无证书、假 principal、双登录被踢两条真实 WS 关闭、账号登出后逐消息与素材票据拒绝。独立 probe 4/4，输出只含检查结果，不含 raw token。fixture 的 `setAssetReady(true)` 仅模拟素材服务已挂载，不能证明生产 ready。暂存包导入账号依赖且 required 缺配置 exit 1；已有 legacy staged 完整测试也通过。
- 最后 `npx tsc -b --force` exit 0。完整 `npm test` exit 0，4987 项中 4985 pass、0 fail、2 skip，97.94 s；首次全量失败曾因 staging 未复制 `server/account`，已补清单，不能隐去。provider 固定 HEAD `580bec81325e09a92a805f8d33bb7353a45503d8`；此叶未改冻结 provider 与 password-order。
- 修复过程的首次失败尝试：Windows 只读 fd fsync `EPERM`，改为 `r+`；异步 gate 的 Promise 在 service wrapper 被丢弃，导致跨项目错消息放行，已转发 Promise；principal 规整漏 `projectId`，导致项目错拒绝缺失，已加入；5820–5822 与 5826 有别的进程占用，未触碰，fixture 改用 5823–5825；provider 登出事件检查早于同步得到 `no-event`，测试改为先真实 `synchronize()` 再读 barrier；首次全量 staging 缺 `server/account` 为 `ERR_MODULE_NOT_FOUND`，已加部署清单并复测。
- 未覆盖或未挂载：真实生产组合启用账号配置的端到端启动、素材 consumer 实际追齐与接口、Agent/render 消费者及三方 closed ACK、掉线后的真实 resume 证明、项目初始化中途 crash/restart 证明、独立 OS 用户的私钥隔离、0.7.18 公共节点 required 配置传播。登出后的 `logoutComplete=false`、pending services 是准确状态。渲染调度补充未决项保持未决。此叶不推送、不部署、不裁定发布。
