# Agent 实例权威：开工记录

- 工作区：`018-agent-instance-authority`；分支：`codex/018-agent-instance-authority`；基底：`6c4cd8d8bb74e9cfb817ea83657436fa9d26ec9d`。
- 独占范围：`server/account/run-authority.mjs`、新增 `server/account/agent-instance-authority.mjs`、实例专属测试/子进程夹具及本报告。中央接线、Agent runner、部署与旧工作区不改。
- 已读 AGENTS 入口、开发索引、行为/约束、验证/多 Agent 协议、任务 brief 5/8/9/11 及可信 read/run 语义。

## 已知问题与证据边界

现有 runGrant 只绑定 serviceId/serviceKid。同一证书只能证明服务身份，不能区分旧进程和新进程；旧模块测试通过不证明旧 OS 实例及其资源已经关闭。中央当前以 `run-instance-unavailable` 关闭生产授权，不能在本包证据未接入时解除。

## 三级机制拟修改

保持用户队列、已读、退出、切私有和禁止自动重放外部副作用的语义。拟增加每次进程启动的内存 Ed25519 持有证明、doc 持久注册及单调代际；握手挑战绑定 doc authority、当前服务证书、具体传输认证会话及实例。仅 doc 验证成功后生成服务器内部实例会话，客户端提交的 instanceId/generation 只是查找引用。每个 grant 固定绑定实例，逐调用查持久状态与当前证书；同进程重连重新证明持有，同证书新启动不得继承旧 grant。doc 重启保留注册但清空会话，必须重新挑战。

进程私钥不能落盘、加入 readIntent 或日志。该持有证明不声称能阻止受信服务主动泄露私钥，也不代替 root 部署侧 OS/cgroup 资源关闭见证；没有完整关闭证据仍 pending。恢复只查同实例及其本机 readIntent，execution-started 不自动重做。

## 预定故障矩阵与状态

注册前后真实 SQLite crash/ACK 丢失、重复请求与改变公钥冲突、同证书新实例、伪造/旧代际/撤销、同实例重连、doc 重启、证书撤销夹缝、各 run API 精确绑定、旧实例资源仍存活与真实关闭、缺部署 witness、已启动执行不重放。首失败及原始日志保留。

当前仅完成只读审阅；实现、定向、类型、full 均未跑。没有服务/固定端口/probe 租约；full 待 root 单独授权。不会把拟机制或受控 OS 夹具称为已完成生产实例关闭证明。
