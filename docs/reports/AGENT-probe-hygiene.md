# AGENT 报告：probe-hygiene

分支 `claude/probe-hygiene`，起点 main `76eee894`（v0.7.2）。端口段 5680～5689。

任务：
1. 探针和测试起的编辑器不再覆盖公共的 `%TEMP%\promptcut\port.json`。
2. `asset-lan-probe` 不给 `--asset` 时按局域网发现取放本机项目的素材服务地址。
3. 探针判法三处弱点（`cloud-untouched`、`--assert-no-lan`、`real:tasks>=50`）。

（进行中）
