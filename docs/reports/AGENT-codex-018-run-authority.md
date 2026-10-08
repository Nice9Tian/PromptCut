# 018 run authority — 开工报告

基底：80b5e658e0c56a756003a94cab4c5e4992e76fc3。独占工作区 `018-run-authority`；旧 operation 工作区冻结。

范围：新增 `server/account/run-authority.mjs`、`server/agent/service/read-intents.mjs`、本包专用测试/子进程夹具与本报告。端口 5730–5739；不改中央挂载、既有 authority/ledger/history/password-order/project、VH 或其它 owner 文件。首次端口核查无监听。

已读 AGENTS、developer_guide、suggested_agent_behavior、constraints、multi_agent、verification、solution_table、任务 brief 5/8/9/11 与设计的可信已读/退出/切私有/FIFO/选区约定。

目标：完整 prompt 的本机持久 read intent → doc 同账本 currentRun/readReceipt/runGrant 原子确认 → 明确 ACK 才首次执行。ACK 不确定只查同 request，不再次调用模型。退出先则未读取消；read 先且 shared current 才 retained；private/stop/delete/Agent off/service revoke 优先阻断，重新开放不复活。账号旧登录始终撤销，不保存可用用户令牌。

三级机制：复用现有 SQLite WAL/FULL ledger，以同步事务组合 conversation owner 的 claim/read/finish helpers 与本包 grant 状态。完整 prompt 哈希须由 doc 持久内容独立重建，不能把 Agent 声称 hash 当证明。控制事件、grant 状态、消息取消与 revision 在同事务提交；外部停止/撤流 ACK 独立记录，未齐不报告完成。所有运行 gate 每次核当前账本与可信 service 身份，缺生产 provider 失败关闭。

接口协调：conversation owner 持 conversationsV2/FIFO；本包持 runGrantsV2/read requests/receipts/单调 runClockV2。对外统一 runGrantId 与非负 safeInteger fenceRevision。普通页面仍由真实 account authority 当前凭据校验。中央负责认证服务主体与注入实际 sender 凭据核验；body service 字段不授予权限。

待证明：真实 SQLite 子进程 crash、read/exit/private 顺序、ACK 丢失与重启幂等、身份/项目混用拒绝、retained 精确当前轮、完整 prompt 绑定。当前仅开工与接口设计，没有宣称运行语义已经通过。首次失败/原始日志与全部验证结果将逐项补入。

未决产品项：删除权限/确认/数量释放及调度的上位待确认项不由本包裁定；只实现已授权停止/撤销机制。
