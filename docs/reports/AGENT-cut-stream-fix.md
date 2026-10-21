# AGENT 报告：剪辑段逐卡流的线上缺陷修复

分支 `claude/cut-stream-fix`，工作区 `.worktrees/cut-stream-fix`，基于 `claude/accept-final3` `6028555c`。

## 状态

进行中。

## 任务

线上（visuhive.com，项目「验收018-复验2」，构建 ef991d8c）发现的五条缺陷：
1. / 2. 父剪辑里摊平出来的重卡（`k-mvfskg83-2~c-mvhdf6ef-2`）没判重、没对上云端的流，在嵌套场景里活渲。
3. 跳进剪辑段里面主线程长任务约 17 秒。
4. 渲染服务同一结果键的稀疏版与满密度版并发，稀疏版推流 ENOENT。
5. Agent 的 switch_cut 报 project.op 15 秒没回包，页面其实切过去了。
