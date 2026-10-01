# 补丁关闭段的单进程计数修复

本轮 A4 + A5 R4 镜像退出复验发现：Windows PowerShell 5.1 中函数只输出一个 PSCustomObject 时，接收变量变成标量，其 `.Count` 为 null。镜像脚本把一个 Codex 自己启动的 MCP 客户端记成空数量；真实 apply-patch.ps1 同样直接读标量 Count，只有一个进程时可能跳过干净退出请求，强杀后若仍剩一个也可能误报「已关闭」并继续覆盖。

专用分支 claude/ps1-process-count；从已集成分支分出，修复提交 f8cfbb53。调用方统一用 `@(Get-TargetProcesses)` 收集，不改变识别范围、退出时限或兜底顺序。属于实现修复，无语义变更、无〔裁〕。本机忽略的 R4 镜像同步同样计数修正，仍不替换安装文件、不冒充真实补丁。

新增测试执行真实补丁的关闭代码段，进程、时间与系统动作由假对象隔离，避免碰实际运行进程。覆盖零进程、一个/两个进程干净退出，以及强杀后只剩一个仍拒绝覆盖。Windows 上用 powershell.exe（5.1）执行，其它平台明确跳过，不能把跳过算本机验收。

验证待定位探针结束后串行运行：`npx tsc -b --force`、`npm test`、`node --test desktop/test/*.test.mjs`、新回归测试、Windows PowerShell 5.1 ParseFile 与 R4 镜像现场复验。先提交、后验证；结果未齐前不合流。

没有调用顾问或子 Agent。
