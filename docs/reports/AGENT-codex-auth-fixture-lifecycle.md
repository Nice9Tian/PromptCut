# 认证测试夹具生命周期

起点 `913e6884`，分支 `codex/auth-fixture-lifecycle`。仅修 `server/test/codex-auth-state.test.mjs` 与本夹具专用辅助；不改 production auth、公共 killTree、其它工作区。按 root 已授权任务实施，不自行合并/推送。

现有 full-3 由 root 中止，exit1 是中止不是通过。旧证据显示测试进程下有较早 case-eepgiZ 的 fake CLI exec 尚在，终段 case-PsZsKk 的 split/descendant 数字 PID 已消失；这些记录不能证明哪个 stdout 句柄持有。不会操作旧 PID、真实 profile 或用户凭据。

先只读日志与 fixture，使用本测试专属临时 profile 和真实 fake CLI 做受控复现，保持 split 输出、descendant 与认证语义断言。尺子为生命周期事件可结清、退出/close 有真实证据、临时资源清理后定向/types/完整npm通过。每次失败与自动retry全部保留；不以加sleep或盲重复全量求绿。所有子孙隐藏启动；日志及复现数据放系统TMP。

## 定位与受控证据

原full-3的owned快照只读投影确认：54836→36980测试→39772旧fake exec（case-eepgiZ）→44292 conhost。未操作这些PID。指定 `promptcut-test-jRfyn1/events-all.ndjson` 在本轮读取时已不存在；旧case-eepgiZ的simulation/calls也已缺，终段case-PsZsKk配置仍split+descendant。原始完整spec日志与owned JSON保留。缺少可追溯事件，因此不声称查明原事故具体断言或stdout持有者。

可证明缺口：原多个用例在run/start之后、abort/dispose之前执行等待与断言；任一提前失败都会跳过尾部清理，fake exec故意永久运行直至外部终止。文件只有最终同步目录删除，没有afterEach拥有者结清，后续profile轮换不能终止旧child。新增受控case实际运行hold fake CLI，强制抛断言，先观察reachedAbort=false/child活着，再执行同一settleCase并观察真实close与进程退出；不是以模拟Promise代替进程。

首轮只加生命周期观察，目标26/26pass，9972.5121ms，exit0，日志 `promptcut-auth-lifecycle-observe-first.log`，证据目录`pc-auth-lifecycle-8yJr4h`。该次未复现原事故，不能据绿证明根因。加入拥有者finally后首轮27/27pass，13558.6925ms，exit0，日志`promptcut-auth-lifecycle-finally-first.log`，证据`pc-auth-lifecycle-1GmGDo`，包含上面的主动失败反例。均系统TMP，无自动重试。

## 修复机制与安全边界

仅测试内包装createSetupService/run并观察真实node:child_process返回对象，不改调用的参数、输出、认证逻辑或killTree。每次spawn立即订阅exit/close与stdout/stderr end；JSONL仅记录测试case、命令类别、pid、退出码、事件序号/诊断monotonic时间，不记录真实配置、命令行、stdout内容或凭据。afterEach先取消setup job再dispose，abort已登记run，await其done与全部真实child close后才允许下一个profile；最终也结清后再恢复环境并删自身sandbox。备用强制终止仅用本fixture创建且仍未退出的ChildProcess对象，失败仍向测试报告，不把备用清理当通过。

末例保留“其他任务存活”的原断言，但对该fixture自行创建的unrelated child在创建时订阅close，避免若它已提前退出、finally才订阅close而永远等不到事件。死亡/descendant/split/认证语义断言及原等待时限均保留；无增加sleep。

只读核对root最新986ebec6：调度补充的技术建议/待确认不是新增产品决策或执行授权，提前回收等未决项不在本任务范围；没有合入该文档提交或改产品语义。
