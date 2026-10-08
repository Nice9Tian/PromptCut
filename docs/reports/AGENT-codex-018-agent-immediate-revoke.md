# Agent HTTP 历史/SSE 即时撤销闭环

开工基线：`037587670cb6c0cd28379d4ee72d6007821a3b02`，分支`codex/018-agent-immediate-revoke`，沿用根已复用的独占工作区。旧producer/worker与只读提案在原分支冻结并已由根推送。本阶段只解决零run的真实HTTP历史/SSE权限撤销、同实例控制、真实连接关闭与持久完成证明；模型执行器继续未挂，不能拿HTTP闭环充模型资源停止。

规则入口已读AGENTS、developer_guide、suggested_agent_behavior、constraints及verification；遵循account-binding-task既定权限：private owner与creator只读例外、非owner任务停止，kick/退出人的权限撤销和shared已读current run保留相互独立。原只读设计见`77df6f62`报告增量。

租约：新`server/account/agent-read-control.mjs`、`server/agent-service/conversation-control-client.mjs`、`server/agent/service/conversation-transports.mjs`及同前缀专属测试/fixture；既有conversation-authority/conversation-internal/agent-instance-authority/doc-agent-assembly/conversation-policy、agent-service http/conversation-client/run-client/main。account/authority、account-projects现由Sol持有，须把精确patch交根排窗口；account-hosted/combo与account-runner/run-control不写。禁止产品其它范围、节点/full/额外Agent。

计划分块：先确定持久库存/控制/精确实例scope，准备真实SQLite+真实RPC首红；再接Agent同步输出门与actualclose；最后接既有生产工厂和真实ACK防旁路。当前只授权无业务listener纯目标/实现；真实服务counter在固定源码后申请根窗口6600–6619。所有结果按源与首次失败保留；没有通过之前不称小阶段完成。过程环境仅当前进程cuda_Vit/models/silent-preload/canonical PSModulePath。

现有断点：account policy onRevoke为空；SSE fresh access RPC之后仍直接write；普通GET/list不在读库存；doc已有fence只保存complete:false并503；零run实例不在普通run control inventory；旧Agent access ACK仍需强制关联真实关闭控制，完成门不能绕过。新机制先持久pending并封新准入，远端同步关输出后等真实close，最后持久receipt才成功，不延长poll/timeout或自报布尔。

本阶段尚未执行测试或服务。
