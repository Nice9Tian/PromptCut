# 账号协议实施报告

分支 codex/018-account-foundation，仅新增 server/account/protocol.mjs 与专属协议测试。开工已读 developer_guide、suggested_agent_behavior、constraints、multi_agent、verification、git_and_release 及 three-versions-018-design 的身份、公开/内部接口、会话、同意与退出时序。实现已获根任务授权，本包不操作 main、push、release 或节点。

## 实际交付与边界

协议源码最终提交 `e661dbf07e153d34cc964479678f0ad57dab2e8e`。新增 `server/account/protocol.mjs` 和 `server/test/account-protocol.test.mjs`，不改中央文档/授权/素材/Agent 模块，不改版本、main、release、节点或网站。最早可依赖的字段协议提交为 `30b0a265`，已交根协调者。

统一账号身份字段为 `identityVersion:2,realm:'account',accountId,accountName,loginId,loginGeneration,credentialId,kind,expiresAt,accountEventSeq`。校验返回值剥离项目创建者和成员等权威字段，账号认证不能自行授权项目。

持久事件支持改密、普通网站退出和普通编辑器退出。`oldLoginIds` 是受影响旧登录的精确集合；改密时不含发起网站，`revokedLoginIds` 若出现必须是该集合的去重子集。普通 `credentials-revoked` 可以没有网站发起者，`password-changed` 必须有。序号必须正整数，事件页从 `after+1` 开始连续；拒绝 head 回退、缺号、重复和 head 尚未追平却返回空页。**这只证明一页格式，文档消费者仍必须持久逐项处理并循环拉到 head，拉齐前禁止开放业务。**

导出 `ACCOUNT_PROTOCOL_VERSION/ACCOUNT_SCHEMA_VERSION/NOTICE_VERSION`、`INTERNAL_PATHS`、`REVOCATION_SERVICES`、`ACCOUNT_PRINCIPAL_FIELDS`、`AccountProtocolError`、`requireRequestId/requireAccountId/requireSequence`、`validateAccountPrincipal/validateAccountEvent/validateEventBatch/validateConsent/validateProjectList`。项目列表必须带文档 authorityId/revision；不把缺权威的空数组当成功。

最终 protocol SHA256：`6A0F40FD89DF3A8AE75A76A53627927F71B4AEBB5FC4EE0B992D4793587A5ECC`。

## 真实验证记录

所有测试按根指定 Python、禁止 bytecode、绝对静默 Node 预载环境运行；没有安装依赖、建立 junction、碰用户常驻端口或读取真实秘密。原始日志留在系统临时目录，下表只记 basename。类型检查退出码均为 0，日志为空表示零错误；命令未单独测量类型检查耗时，不补造数字。

| 命令/阶段 | tests | pass | fail | skipped | duration_ms | 原始日志 |
|---|---:|---:|---:|---:|---:|---|
| `npm test -- server/test/account-protocol.test.mjs`，首次 fixture | 3 | 3 | 0 | 0 | 80.499 | pc-account-protocol-target.log |
| `npx tsc -b --force`，首次 | — | 零错误 | 0 | — | 未单独计时 | pc-account-foundation-type.log |
| `npm test`，首次 | 4934 | 4933 | 0 | 1 | 79822.6878 | pc-account-foundation-full.log |
| `npx tsc -b --force`，最终 e661dbf0 | — | 零错误 | 0 | — | 未单独计时 | pc-account-foundation-type-final.log |
| `npm test`，最终 e661dbf0 | 4935 | 4934 | 0 | 1 | 128434.0935 | pc-account-foundation-full-final.log |
| `npm test -- server/test/account-protocol.test.mjs`，最终 | 4 | 4 | 0 | 0 | 78.2019 | pc-account-protocol-target-final.log |

两次全量均无原生异常重跑、取消或待办项。唯一跳过来自已有 `server/test/cards-layout.test.mjs` 的真实舞台集成例，未提供 `PC_STAGE_TEST_URL` 自动跳过；本包只改非画面协议，不能把它说成已跑画面验收。

跨仓库最终 provider 核对在 VisuHive 源码 `055f41a` 与本协议 e661dbf0 上执行：真实 store 产生普通网站退出、普通 editor 退出、改密成功、选择退出四条事件，经本 validator 全部通过；输出为 `types=[credentials-revoked,credentials-revoked,password-changed,credentials-revoked],seq=[1,2,3,4],synchronous=FULL,passed=4`。原始日志 `vhpc-account-provider-compat-final.log`。没有伪造固定事件替代真实 provider，也没有打印 token/密码/密钥。

## 未接线与根后续工作

本 PC 分支只交协议，尚未由文档权威模块消费，不能称云项目创建、列表、成员授权或关闭连接已经可用。VisuHive 已交账号后端、内部 mTLS 与备份 API；其专属报告记录全部账号回归和失败尝试。顺序见证/历史与 retained 精确 run 授权由 Astra 的独占包实现；本包不宣称 seal/accepted/fence 时序已证明。节点 OS 用户隔离、反代实际来源、同域站点、真网络组合和部署恢复仍由根与对应包负责。基线结果供根复核、合并决策；本包未合并或推送。

报告提交前工作区干净，范围 diff 仅本报告与两个新协议文件，`git diff --check` 无错误。一次早期临时 fixture 清理由工具自动审批拒绝，理由仅为 `blocked by policy`；删除没有执行，原始日志及早期临时 fixture 目录保留，只读最终协议核对已单独完成。
