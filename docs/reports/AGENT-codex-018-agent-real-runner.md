# 真实 Agent runner 用户路径

## 开工边界

- 工作分支 `codex/018-agent-real-runner`，精确起点 `ff51441cc7fa28f8cfae6fa5062af2be706bf575`，开工 tracked/untracked 干净；原物理工作区沿用。
- 目标：复用 `createExistingHostedRunnerFactory`、真实注册实例和同 RAM key 的 run data WSS；在完整在线编辑器发送短任务，看到持久助手文本、工具结果及文档小修改。模型仅本机受控响应；不声称生产模型、节点部署、资源终态或 FIFO 已结算。
- 独占：`server/agent/service/account-runner.mjs` 的 factory/manager 接缝、`server/agent-service/account-executor-assembly.mjs` 及必要 main/start 参数接线；新专属 real-runner tests/fixture/probe 与本报告。page bridge 先设计后报告。原 authority/read-control/SSE/UI/终态协议不改，扩租先报。
- 验证：先提交完整块再精准 npm targets/绝对安装版 tsc；真实浏览器目标固定源码后记录实际 doc TLS/WSS/project revision、首次失败和全 owned 清理。临时业务端口仅 6660–6669，启动前查空；不跑全量、真实模型或节点，不读凭据。

## 当前已核接缝

`createAccountExecutorAssembly` 构造真实 `createRunDataClient/resources` 并注册本进程、启动 readControl 后才挂 service；默认 factory 由 `createAccountRunnerService` 创建。factory 已把 doc-admitted grant 绑定真实 data WebSocket，且等待 welcome + project.state 才允许 executeOnce 和模型/工具。现待核的是实际 SSR host/runner/tool 行为与完整 Editor 的组合，不能用旧 visible fixture 的受控 runnerFactory 替代。

`createAccountRunManager` 在事件 flush 后故意返回 `run-outcome-unavailable`，保留执行不确定和 FIFO；本任务不更改此终态边界。现有 factory 的 `pageCall` 固定 offline；`get_selection` 的账号路径需核真实 selection.query，不透传页面假快照。

## 验证记录

尚未运行目标、类型、业务服务、浏览器或模型。后续各次命令、源码、结果和缺口追加于本报告；旧 executor 可见层及私有代理反例不作为本任务通过证据。
