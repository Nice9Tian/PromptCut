# AGENT 报告：018-stage-nginx-map

## 任务与边界

- 工作区：`.worktrees/018-cloud-assets-central-glue`；分支 `codex/018-stage-nginx-map`；起点 `0435ff30`。
- 只允许改 `server/hosted/deploy/nginx-site-promptcut-stages.conf` 与本报告。只修 map 正则与 value 之间缺少的空格；不改 Cookie 字段、票据、舞台源或源隔离。
- G 的登记源码提交 `b851f449` 已单独保留；本任务不修改或合并 G，不连接节点、不推送、不合并、不跑 full。

## 当前进度

- 已阅读仓库入口规则、开发者指南、建议行为、约束、子 Agent 协议，以及 `three-versions-brief.md` 第 11 节的当前小阶段安排。
- 已在 `server/hosted/deploy/nginx-site-promptcut-stages.conf:27` 只补 regex 和 value 之间的一个空格。原文为 `...v1\..+)$""pc_rt=...`，现在为 `...v1\..+)$" "pc_rt=...`；Cookie 属性、票据匹配式、舞台源及源隔离均未改。

## 验证与限制

- `git diff --check` 通过；源码 diff 只有该 map 行的一处必要空格差异；本地 `nginx` 不存在，因此未进行本地 nginx 语法检查。主会话负责从精确 Git 源提取 map block，在真实 Linux nginx 上先复现原配置失败、再验证修正后 `nginx -t` 通过。
- 依据本任务明确边界，未跑 mirrorregex 单测或 full；本报告不把文本检查描述为 nginx 通过。
