# 认证测试夹具生命周期

起点 `913e6884`，分支 `codex/auth-fixture-lifecycle`。仅修 `server/test/codex-auth-state.test.mjs` 与本夹具专用辅助；不改 production auth、公共 killTree、其它工作区。按 root 已授权任务实施，不自行合并/推送。

现有 full-3 由 root 中止，exit1 是中止不是通过。旧证据显示测试进程下有较早 case-eepgiZ 的 fake CLI exec 尚在，终段 case-PsZsKk 的 split/descendant 数字 PID 已消失；这些记录不能证明哪个 stdout 句柄持有。不会操作旧 PID、真实 profile 或用户凭据。

先只读日志与 fixture，使用本测试专属临时 profile 和真实 fake CLI 做受控复现，保持 split 输出、descendant 与认证语义断言。尺子为生命周期事件可结清、退出/close 有真实证据、临时资源清理后定向/types/完整npm通过。每次失败与自动retry全部保留；不以加sleep或盲重复全量求绿。所有子孙隐藏启动；日志及复现数据放系统TMP。
