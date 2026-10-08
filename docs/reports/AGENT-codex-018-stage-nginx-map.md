# AGENT 报告：018-stage-nginx-map

## 任务与边界

- 工作区：`.worktrees/018-cloud-assets-central-glue`；分支 `codex/018-stage-nginx-map`；起点 `0435ff30`。
- 只允许改 `server/hosted/deploy/nginx-site-promptcut-stages.conf` 与本报告。只修 map 正则与 value 之间缺少的空格；不改 Cookie 字段、票据、舞台源或源隔离。
- G 的登记源码提交 `b851f449` 已单独保留；本任务不修改或合并 G，不连接节点、不推送、不合并、不跑 full。

## 当前进度

- 已阅读仓库入口规则、开发者指南、建议行为、约束、子 Agent 协议，以及 `three-versions-brief.md` 第 11 节的当前小阶段安排。
- 源码模板待做单字符分隔修正；随后仅做文本差异与 `git diff --check` 检查。

## 验证与限制

- 主会话负责从精确 Git 源提取 map block，在真实 Linux nginx 上先复现原配置失败、再验证修正后 `nginx -t` 通过。本地不连接节点；除非本机确有 nginx，否则不把文本检查描述为 nginx 验证。
- 依据本任务明确边界，不跑 mirrorregex 单测或 full。最终报告补上源码证据、检查摘要和实际验证范围。
