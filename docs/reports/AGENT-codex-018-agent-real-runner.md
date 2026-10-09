# 真实 Agent runner 用户路径

## 开工边界

- 工作分支 `codex/018-agent-real-runner`，精确起点 `ff51441cc7fa28f8cfae6fa5062af2be706bf575`，开工 tracked/untracked 干净；原物理工作区沿用。
- 目标：复用 `createExistingHostedRunnerFactory`、真实注册实例和同 RAM key 的 run data WSS；在完整在线编辑器发送短任务，看到持久助手文本、工具结果及文档小修改。模型仅本机受控响应；不声称生产模型、节点部署、资源终态或 FIFO 已结算。
- 独占：`server/agent/service/account-runner.mjs` 的 factory/manager 接缝、`server/agent-service/account-executor-assembly.mjs` 及必要 main/start 参数接线；新专属 real-runner tests/fixture/probe 与本报告。page bridge 先设计后报告。原 authority/read-control/SSE/UI/终态协议不改，扩租先报。
- 验证：先提交完整块再精准 npm targets/绝对安装版 tsc；真实浏览器目标固定源码后记录实际 doc TLS/WSS/project revision、首次失败和全 owned 清理。不跑全量、真实生产模型或节点，不读凭据。
- 根纠正端口租约为 6700–6711：site/account/doc/doc-internal/asset/asset-internal/Agent 分别 6700–6706，edge 6708、control 6709、两个舞台 6710/6711，6707 不用。原 6660–69/6670–71 已放弃：发现 global-setup 正常坏端口守门 PID12576 在 6665–69 监听，未终止它，未更改浏览器禁端口或 guard。业务目标每次前后核新段无监听。

## 当前已核接缝

`createAccountExecutorAssembly` 构造真实 `createRunDataClient/resources` 并注册本进程、启动 readControl 后才挂 service；默认 factory 由 `createAccountRunnerService` 创建。factory 已把 doc-admitted grant 绑定真实 data WebSocket，且等待 welcome + project.state 才允许 executeOnce 和模型/工具。现待核的是实际 SSR host/runner/tool 行为与完整 Editor 的组合，不能用旧 visible fixture 的受控 runnerFactory 替代。

`createAccountRunManager` 在事件 flush 后故意返回 `run-outcome-unavailable`，保留执行不确定和 FIFO；本任务不更改此终态边界。现有 factory 的 `pageCall` 固定 offline；`get_selection` 的账号路径需核真实 selection.query，不透传页面假快照。

## 验证记录

所有命令用已装 Node24/npm-cli 调仓库 npm wrapper，绝对 fileURL 静默 preload，唯一 PSModulePath，进程 cuda_Vit/PYTHONDONTWRITEBYTECODE/models，显式真实 VH/account order/conversation module。无全量、生产模型或节点操作。

| 固定源码 | 精确目标/原始日志（均 TEMP） | 结果与因果 |
|---|---|---|
|36739b1d|`npm test -- server/test/account-real-runner.test.mjs` / `pc-real-runner-first.log`|1/0pass/1fail，2430.8317ms。发送503；cleanupErrors空。|
|f74b2f53|同目标 / `pc-real-runner-diagnostic-f74.log`|1/0/1，2333.1436ms。仅新增安全分类，确认 read-control-unavailable。|
|f720611e|同目标 / `pc-real-runner-f720.log`|1/0/1，4490.4723ms。fixture 与 assembly 重复 start 被修；doc subscribe 实际 supersede 旧流，旧 client finally.disconnect 会撤新 transport。queued 默认启动不变。已到真实4工具，report_progress 缺必填 has_done 被真正 schema 拒。|
|12c6f48f|同目标 / `pc-real-runner-12c6.log`|1/0/1，4461.2543ms。进度输入补齐后4工具成功，测试错误读取 state.body；真实响应是 state.project。|
|7d1d4098|同目标 / `pc-real-runner-state-target.log`|1/1pass/0fail/cancel/skip，4604.1604ms。实际 VH/SQLite/doc instance/read control＋独立asset；同RAM签名 WSS/project.open；4真实工具；doc revision 增加/name 改变；实际数据连接0，grant active，settlement pending。所有清理成功。|
|d2ffdb3d|绝对 tsc `-b --force` / `pc-real-runner-type-d2ff.log`；Vite online / `pc-real-runner-build-d2ff.log`|type0，墙6.94s；online build0，墙1.89s。产物仅 TEMP `pc-real-runner-d2ff-dist`。|
|d2ffdb3d|完整 Editor probe / `pc-real-runner-browser-d2ff.log`、同名输出目录|2前置通过，completed=false，4118ms。真实create/join/登录/同意/开关均到；probe 调不存在的 keyboard.insertText，没发POST。截图保留。全部owned闭合/段零监听。|
|be3dc89c|完整 Editor probe同dist / `pc-real-runner-browser-be3d.log`、同名输出目录|退出1，约9.28s；真实ShiftEnter输入后遇 http.mjs 定时 poll 的同步 read-transport-revoked 逃逸，进程退出，JSON未最终形成，已有failure两图保留。实际段零监听；无匹配本输出目录Chrome/stagedasset进程。不得称完整Editor通过。|

〔裁〕受控模型使用现有 mock-script provider，真实 factory/harness/SSR 工具和文档 WSS/操作授权全部复用产品代码；不引入 fake socket/投影或另造 executor。get_selection 已走同grant的真实 selection.query，所以本阶段不需要 page bridge。模型响应受控与真实生产模型明确分开。

当前冻结接缝：完整Editor第二次实际暴露 SSE 定时器 `void poll().catch` 无法捕获 `readTransports.dispatch` 同步抛错。已报根申请仅 http.mjs 的 poll async 接缝及专属目标，未获租前不改。终态仍 run-outcome-unavailable，不从 handle.done 判成功，不释放 FIFO、不生成 root/OS witness。旧 executor 可见层、私有代理及根全量均不冒用为本任务新路径通过。
