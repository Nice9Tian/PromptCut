# 云 Agent 素材权限只读复核

基底 `7dab214f8dc521ef908141a06b14b7996520f1dd`，分支 `codex/018-run-assets-review`。独占仅本报告；所有产品、测试及其它工作区只读。先开工提交。

复核 createRunAssets/protocol/internal 三角色信任、epoch/nonce/scope、连续 outbox/ACK，与唯一 run provider/instance cap、worker run-resources/ToolJobs 调用链。区分具体源码缺陷与尚未挂生产 seam，不把模拟放行或未部署证明当已通过。

根保留的反例：A837 9/7/2（实例控制过宽、outbox gap）；909 wire UTF8 14/13/1；693 epoch旧工厂；worker3efa sequential retained 反例和 d462 因果修复。原始 `%TEMP%/pc-root-retained-sequential-{3efa,d462}.mjs/.log` 与 `pc-run-assets-mtls-1.log` 不覆盖。

当前仅允许 TMP 无监听纯 Node 反例，可使用真实模块/SQLite/注册 RAM key；不运行 npm wrapper、target/full、listen(0)、服务、探针、节点，不修改实现。进程环境遵守 cuda_Vit/模型路径/静默预加载约定，子进程隐藏；不输出秘密值。开工后读规则、设计与固定代码，再记录首个真实反例或明确通过/未测边界。
