# C10 主机认领诊断 — 开工报告

基底 `80b5e658e0c56a756003a94cab4c5e4992e76fc3`，专用分支 `codex/018-c10-claim-diagnostic`。独占 `scripts/probes/c10-browser-probe.mjs`、新增 `scripts/probes/c10-judge.mjs`、既有 `server/test/c10-host-claim.test.mjs` 与本报告。旧 run-authority/VH 工作区保持冻结。

已读入口 AGENTS 与 developer_guide、suggested_agent_behavior、constraints、verification、multi_agent、solution_table，以及范围相关真实队列、split/host/session/task-runner 与 C10-A5 契约。先补受控真实队列反例及逐代证据，不修改生产队列/worker/capabilities，不把 plans 当细任务完成，不放宽完成断言，不加 sleep 赌时序。

原始首失败来自 root `TMP/pc-root-baseline-80b5e658-20261008/logs/P-c10-browser-full.log`，exit 1，1084 秒，A5 等待 923577 ms。真实 OUT 为 `TMP/pc-c10-browser-1EyZIX/shots`。已证主机 claimed1/plans1/held0/running0/completed0；观察到的 open 候选全部因环境指纹不符，4→0；observedTasks11 是包括 closed 的历史 Map 长度。最后页面 main-v2 新层由页面指纹产出且 ready120。尚无逐任务代次/dual/明确 superseded/winner/派生 ACK，不能认定本次全部主机副本被浏览器作废，更不能称 held 渲染卡死。

本阶段通过标准：真实 queue/host/loopback 控制浏览器先认领全部新增候选，证明计划完成并不保证主机有细任务完成；诊断只输出安全白名单字段，按每次真实 opened/snapshot 与断线边界保存代次，缺完整关联不得推断作废原因或 winner；保留全部旧断言。类型与定向 npm 可跑，full/probe 待 root 租约。候选服务端口 6320–6329 尚未获运行租约，当前不开监听，不触碰其他 owner 或用户进程。

下一步稳定主机渲染 fixture 须先给具体产品规则与代码依据，由 root 审查后实施；仅采集日志不等于 A5 整体修复。任何首失败及反例原始日志均留系统 TMP；测试链隐藏启动，不输出密码/令牌，不安装、不 push/merge/main/deploy。

## 首小块实施与反例

源码 `fe62c39cbed8901fda48109b4c4ad992f13dc9aa`，多旁观连接隔离窄修 `4df70eec`。`hostDidWork` 抽到 c10-judge，表达式逐字保留：必须有 completed > 0，plans 不代替。createC10Trace 仅诊断，不改变队列/认领/完成/渲染逻辑。白名单保存项目/任务/内容键、段、dual、代码版本/指纹、能力布尔值、cardSources 数量与哈希、每连接 epoch/seq、每次 opened/snapshot 的代次、taken/claimed 胜出证据和 closed 状态；未知错误仅分类与哈希，不输出原文、任意 payload 或凭据。主机派生 publish ACK 在受控模块测试中直接记录；真实浏览器诊断可记录发布页收到的 plan done ACK 及其 derived ID 列表，不能声称已监听主机内部 socket 的 task.published。

同一 ID 重建 version1 新开代次；新连接、resume 或 queue epoch 改变切断完整观察链。首 snapshot 不冒称见过首次 opened；不连续 version 不推断 winner。多个旁观连接各自 channel，不能互相补观察。publisher 的 task.failed/task.done 没有 task version，跨 socket 不存在共同交付顺序，因此保留为 `unversioned-not-correlated` 独立事件，不拿历史 superseded 给新一轮普通 failed 贴标签；closed 无原因时明示 unknown。保守记录不等于补足原现场缺失证据。

真实受控队列反例使用生产 createRenderQueue、createRenderHost、splitPlan 路径和已有 FIFO loopback，只注入渲染 executor 的计划及可控浏览器协议端点。主机按真实 plan 派生同卡 2 段 × 双指纹，浏览器按 expectVersion 先认领并完成两段，队列明确作废主机两份：`claimed:1, plans:1, completed:0, browserDone:2, hostSuperseded:2, originalCompletion:false`。主机 held/running 为空，没有执行 render 或 sink.put。断言同时核原4个派生 ID 的 publish ACK 与 plan done ACK，保留旧完成条件。该反例证明合法机制可使主机只切计划，**不是**真实 Chromium/产物渲染，也不能证明原现场唯一由此原因造成。

## 验证原始记录

均使用 `npm test -- server/test/c10-host-claim.test.mjs`，保留原3项测试，再增加4项；类型用 `npx --no-install tsc -b --force`。显式设置指定 cuda_Vit Python、PYTHONDONTWRITEBYTECODE 与静默 Node preload；spawnSync 子进程 windowsHide，目标不监听端口。

所有日志在系统 TMP，前缀 `pc-c10-claim-diagnostic-`：

| 项目 | 源码状态 | 结果 |
|---|---|---|
| target-1.log / -exit.json | 开工203ba4e4后在制 | 6 tests /5 pass /1 fail，445.9593 ms，exit1；手写browser claim遗漏必填expectVersion，实际bad-message，host继续认领细任务 |
| target-2.log | 同上，仅增加安全帧诊断 | 6/5/1，474.1678 ms，exit1；精确确认两个bad-message。该诊断运行未保存wall JSON，不能补造耗时 |
| target-3.log / -exit.json | 加入协议要求的expectVersion | 6/6/0，516.8323 ms，exit0；真实browser-wins-all反例成立 |
| target-final.log / -exit.json | fe62c39c | 7/7/0，551.4549 ms，wall855.8916，exit0 |
| types-final.log / -exit.json | fe62c39c | 零错误，wall8927.929 ms，exit0 |
| target-fixed.log / -exit.json | 4df70eec | 7/7/0，571.2382 ms，exit0；独立observer channel与onClose边界窄修后复验 |
| types-fixed.log / -exit.json | 4df70eec | 零错误，exit0；实际wall见JSON |

没有 native 自动重跑、没有 skip。第一次 fixture 失败与仅为确认其因果的第二次诊断保留，未放宽断言。最后自审发现多个 startWatcher 共用 channel 会混淆代次，故单独提交窄修再做目标/类型检查；没有重复宽测试。完整 npm 与真实 C10 probe **未跑**，当前无租约且 root 基线仍在运行；这不是可交整体修复的最终验收。

## 下一阶段 fixture 提案（未实施）

保持 main-v2 原浏览器竞争用例，另在 A5 creator 关闭后经真实 store.actions 加一张既有 `r6-canvas` 短片段，放在原10秒之后，不影响之前A1/A4压力。审阅表 `src/cards/capabilities.json` 已固定 independent/canvasHeavy=true；`src/cards/_probe/r6.tsx` 的 CanvasCard 实际绘制随时间变化的48个圆；frame-pipeline 的真实权重分类归 heavy，split.browserEligible 明确排除 canvasHeavy。因此不造 requires、不改卡/生产capabilities，可由正常产品规则给主机独有任务。仍须证明新内容没有复用旧产物（不能拿dedup当render）、主机确切完成该clip的细任务及其host指纹层就绪，并保留原main竞争。已将具体选法发root；获准前不写fixture、不起服务。端口6320–6329仅候选登记，尚未使用。
