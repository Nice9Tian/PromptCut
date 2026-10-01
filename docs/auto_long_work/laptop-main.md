# 笔记本主会话：PromptCut M5～M8 开发交接

笔记本没有 task-announce，goal 里不写播报。

## 准备（第一次在新机器上开：先装东西）

```text
把〔路径〕\promptcut-subagents.zip 解开，按里面 README.txt 放进 ~/.claude/skills/ 和 ~/.claude/agents/；检查 codex 和 agy 在 PATH 里能直接调用且已登录，不在就告诉我要装哪个。
把〔路径〕\promptcut-laptop-credentials.zip 按 README.txt 把三个文件放好、写进 docs/local.md，再删掉压缩包。令牌、密钥的值任何时候都不打印、不写进提交、日志或消息。
```

## 准备（开场或接手）

```text
你是 PromptCut 的主会话，运行在笔记本上。先用 get_session self 报出你的会话标题和 ID。
按 docs/plan/Master-Execution-Plan.md 第 0.4 节开工：先读、自检（第一项先验子 Agent 技能与四个定义）、接手动作、第一件事。接手时从 docs/reports/HANDOFF-〔日期〕.md 记的那一步继续。
跨机会话在 ListAgents 里以标题出现，句柄和它自己报的 local_ ID 不同；给别的会话发消息一律按标题找、用列表里的句柄发。
等辅助节点报到后回执。自检结果和报到贴给我，我再钉 goal。
```

## goal

```text
目标：按 docs/plan/Master-Execution-Plan.md 推进到 M8 全案验收总报告完成，顺序照 docs/reports/PAUSE-2026-09-26.md 第 3 节〔接手时加：从 docs/reports/HANDOFF-〔日期〕.md 记的那一步接着做〕；每项验收都有对话内可见的证据；每次合入 main 后 release 分支按 git_and_release.md 判过并推进。

会话：主会话是本会话「PromptCut M5～M8 开发交接」（本机 ID 〔ID〕，跨机以标题为准）；PC 辅助节点「PromptCut M5～M8 PC 辅助测试节点」（〔ID〕）经跨会话消息，间歇在线；云端「PromptCut M5～M8 云端工作节点」经阿里云信箱（to-cloud / to-local）；「PromptCut 主会话（PC）」「PromptCut 笔记本辅助测试节点」待命，不派活。用户已把对辅助节点的完全指挥权让渡给本会话（主计划 6.4b 节）。派活顺序按 6.4 节：PC 在线优先给 PC，其次本机，云端最后；对端不在线按 6.8 节用本机替身，不等。

规矩：全程遵守 docs/semantics/guide_files/ 与主计划第 0.4、6、10 节。具体到停点：
- 只在两种情况停下问用户：某一项按 guide_files/solution_table.md 扫空仍未达成、且它挡住后面的选型或开工（先把不依赖它的项做完再停）；必须真跨机而 PC 与云端都不在线。
- 必须绕过、不得以此为由停下的：新增费用（换机型、加带宽、租外部服务）和需要人在机器旁的物理操作。先找不花钱、不需人在场的路；实在绕不过就记为「待用户项」写进报告，继续其它工作，不停、不等。
- 以下一律不停：二级、三级语义（解法表先三级后二级、最小修改、标〔裁〕、二级在对话里明确说明）；某一项扫空仍未达成但不挡后续（记未达成与待用户项，做下一项）；设计稿、契约、非语义拍板（发给用户但不等）；对端不在线（本机替身、登记不等）；暂时性故障（重试加退避）；失败次数或耗时（只看思路穷尽）；阶段合入（验收全过自动合并）。
- 令牌、密钥的值不打印、不进提交、日志或消息。
- 每阶段写报告，含顾问调用记录、待跨机复核项、待用户项；阶段完成或真要问用户时在对话里明确说明（本机没有 task-announce）。
```
