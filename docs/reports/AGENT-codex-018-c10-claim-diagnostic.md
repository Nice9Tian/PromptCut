# C10 主机认领诊断 — 开工报告

基底 `80b5e658e0c56a756003a94cab4c5e4992e76fc3`，专用分支 `codex/018-c10-claim-diagnostic`。独占 `scripts/probes/c10-browser-probe.mjs`、新增 `scripts/probes/c10-judge.mjs`、既有 `server/test/c10-host-claim.test.mjs` 与本报告。旧 run-authority/VH 工作区保持冻结。

已读入口 AGENTS 与 developer_guide、suggested_agent_behavior、constraints、verification、multi_agent、solution_table，以及范围相关真实队列、split/host/session/task-runner 与 C10-A5 契约。先补受控真实队列反例及逐代证据，不修改生产队列/worker/capabilities，不把 plans 当细任务完成，不放宽完成断言，不加 sleep 赌时序。

原始首失败来自 root `TMP/pc-root-baseline-80b5e658-20261008/logs/P-c10-browser-full.log`，exit 1，1084 秒，A5 等待 923577 ms。真实 OUT 为 `TMP/pc-c10-browser-1EyZIX/shots`。已证主机 claimed1/plans1/held0/running0/completed0；观察到的 open 候选全部因环境指纹不符，4→0；observedTasks11 是包括 closed 的历史 Map 长度。最后页面 main-v2 新层由页面指纹产出且 ready120。尚无逐任务代次/dual/明确 superseded/winner/派生 ACK，不能认定本次全部主机副本被浏览器作废，更不能称 held 渲染卡死。

本阶段通过标准：真实 queue/host/loopback 控制浏览器先认领全部新增候选，证明计划完成并不保证主机有细任务完成；诊断只输出安全白名单字段，按每次真实 opened/snapshot 与断线边界保存代次，缺完整关联不得推断作废原因或 winner；保留全部旧断言。类型与定向 npm 可跑，full/probe 待 root 租约。候选服务端口 6320–6329 尚未获运行租约，当前不开监听，不触碰其他 owner 或用户进程。

下一步稳定主机渲染 fixture 须先给具体产品规则与代码依据，由 root 审查后实施；仅采集日志不等于 A5 整体修复。任何首失败及反例原始日志均留系统 TMP；测试链隐藏启动，不输出密码/令牌，不安装、不 push/merge/main/deploy。
