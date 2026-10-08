# 云端项目成员控制：开工与接口核对

本任务复用已完成队列阶段的物理工作区，分支 `codex/018-project-member-controls`，起点 `53b7246c265d56d49d7ec12a55096602f3fb0cc3`。主会话已收回此前产品与证据；本任务不把其 type/full/真实队列或原生 IPC 结果算作成员控制通过。

开工时 HEAD 与分支符合租约、tracked/untracked 均干净。初始授权仅新增本报告，所有产品源码只读；不开服务、浏览器、全量或节点，不操作 main/推送/删除数据。建议端口6560–6589尚未申请启动，6566属于 fetch 坏端口，绝不选用。实际端口预检与自有进程/收口布局将在真实夹具方案批准后另报。

目标为用户可见成员及踢人/禁入/退出真实控制路。先完整核已拍板账号任务、项目/协作语义、现 MembersPanel 与 doc authority/admin HTTP 接口，再交最小字段与文件租约。删除项目、50对话细则、0.7.20加入申请及其它未决语义不提前实现；不按旧用户名或deviceId自设账号角色权力。

已重新读 AGENTS 入口与 developer_guide/suggested_agent_behavior/constraints。当前首次只读确认：`MembersPanel.tsx` 存在；`server/account/authority.mjs.adminProject` 已有 set-list/kick/unban 等操作，kick 当前对账号全部设备禁入；`server/docservice/modules/account-projects.mjs` 暴露真实 admin POST。权限、字段与目前缺失接口仍需下一节逐条核查，不把源码已有 op 当新的产品授权。

状态：仅开工报告，未修改产品、未运行成员控制测试、未启动监听。待提交精确接口与独占文件请求后实施。
