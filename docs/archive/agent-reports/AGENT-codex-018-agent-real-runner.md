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

## 最小产品修复及完整 Editor 收口

根授 `http.mjs` 窄租后，只将 accountEvents 的 poll 改成 async，先拒 released/destroyed，再 await 原 dispatch；同步/异步失败进入原 entry.close。没有放宽 read fence、current instance、实际 res/socket close，也没有无限重连或假 ACK。新 `server/test/account-real-runner-sse.test.mjs` 真实 HTTP/SSE/ALS/TCP，投影受控：前三个正常 poll 保持流，随后真实 transports.disconnect，再原 dispatch 同步抛错；旧源 cd684136 首红 1/0/1、905.7498ms (`pc-real-runner-sse-red.log`)。修复源 80618a3b 的四并行目标 4/4、0fail/cancel/skip、4400.6508ms (`pc-real-runner-sse-green.log`)，包括真实短链与原两 assembly/wire 目标。type0 墙6.81s (`pc-real-runner-type-8061.log`)，online build0 墙1.81s (`pc-real-runner-build-8061.log`)。

后续实际浏览器全部使用同一 `pc-real-runner-8061-dist`，产品字节不随 probe 改动重建；均 before/after 固定同 SHA、无 wrapper native retry。没有全量或真实生产模型。

| probe 源/输出目录与日志 | 原结果（未删除） | 精确修正理由 |
|---|---|---|
|80618a3b / `pc-real-runner-browser-8061`|6检查5过1败、9134ms，completedfalse；失败 real-tools-visible-0|探针错查详细视图 `.ai-tool-name`，产品默认简洁视图工具为 `data-pc-op.is-ok` 图标/title。不是 B 历史失败；phase 当时未再细分。|
|f07ed0e2 / `pc-real-runner-browser-icons`|8检查7过1败、9646ms，completedfalse；A真实全部可见+版本1→2过，B pendingfalse|B 等整体 text 会先命中用户 mock-script 内同句，早于可信助手重放。这个早期整体文本检查不作为助手已可见证据。|
|92f06e5f / `pc-real-runner-browser-replay`|2前置过、34859ms，actual-output-a timeout|严格 ca 助手文本暴露产品既有默认隐藏原文规则：AgentBubble simple 默认不铺模型文字，showThinking 时才有 RawLog。|
|ddd4956c / `pc-real-runner-browser-rawlog`|2前置过、39359ms，actual-output-a timeout|已正常点击显示思考，截图有 RawLog 但仍 collapsed；未核其正常点击中心命中/aria展开。不能把点击调用等同操作成功。|
|246f72e9 / `pc-real-runner-browser-hit`|**17/17、0失败，completedtrue，10492ms**|通过真实 `scrollIntoView`、只读 elementFromPoint 中心命中、正常 button.click、aria-expanded=true 再核 ca 助手文本；不写DOM/preferences、不force。|

最终真实路径：两隔离 Chrome context 登录真实 VH→A创建201/同意/creator开启→B加入200/同意→A正常 ShiftEnter 多行输入+Enter发送202→doc持久 FIFO/admit/read→现有真实 HostedRunnerFactory＋同RAM实例签名 WSS→实际 get_project/get_selection/report_progress/set_project_meta→project.op 被真 account order/coordinator 接受，A/B收到 project.state rev1 + project.ops rev2并改名→真实 SSE FULL 事件→完整 MessageList 显示原 cq 用户/唯一 ca 助手、成功工具图标、真实进度与展开的原文。B真实打开同 conversation 的历史，持久 eventSeq 1–34 重放，无重复消息。

`pc-real-runner-browser-hit/result.json` 记录源前后 `246f72e91fbe03cad8dcea666e3b0b26400c2b11` 相等。实际 Agent 数据连接0、grant active、completionReadyfalse、pending结算，两页均不显示成功。截图 `00-actual-editor.png`、`01-actual-editor.png` 已实际查看，助手句子“真实文档短任务已执行；关闭结算仍在等待。”可见，项目名已修改，操作日志有成功结果。

最后清理：独立 asset PID23188 的 childClose 已await；fixture closed/childClosed、browser/stages/contextsClosed 均true，主会话租段 6700–6711 实查零监听，无删除用户进程/数据。be3d原异常退出没有生成resultJSON，不能把后补清理检查写成该轮completed或完整回执。

最终可消费：`startAccountRealRunnerFixture({publicHandler,diagnostic})` 复用真实组合，返回真实 connectActor/rows/checkRun/describe/close；`cloud-queue-user-path` 默认 queued 行为保留，hook 由实际 assembly 独占 read start；`account-real-runner-probe --dist <TEMP编译目录> --site-root <VH/site> --out <TEMP私有目录>` 用完整静态 Editor与真实 stagePolicy/双分源。前端/backend都未注入假ready、正文镜像、WebSocket或文档状态。

仍未完成：真实生产两模型调用/节点部署、素材工具、独立 OS/cgroup 关闭 producer、terminal finalizer/FIFO释放。本包不修改 outcome 接口，保持 run-outcome-unavailable，不从 handle.done 判成功，不生成 root/OS witness。只有现有 factory真实使用及 SSE异常窄修，不新造 page bridge、executor或权威。旧 executor 可见层、私有代理及根全量均不冒用为本任务通过；下一整合由根给 fresh 候选全量和生产模型窗口。
