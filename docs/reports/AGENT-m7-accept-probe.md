# AGENT-m7-accept-probe 报告

分支 `claude/m7-accept-probe`，起点 `claude/rq-m7-queue` `fdbeb60`（C10 集成 + M7 服务端一侧 + 契约单测）。端口段 5450～5459。

任务：照 `docs/plan/m7-contract.md`（M7 = 纯浏览器节点；第 13 节主会话裁定为定论）写浏览器验收探针 `scripts/probes/m7-browser-probe.mjs`，第 10 节 M7-A1～A12 各一个检查、W7 跨机分 creator / node 两个角色。不看页面节点分支（`claude/rq-m7-node`）的实现。

状态：开工。
