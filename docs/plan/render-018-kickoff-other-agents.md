# 开工指令交给 Antigravity 时怎么读

2026-10-15 写。`render-018-kickoff.md`（开工指令）是照 Claude Code 写的。用户 2026-10-15 把这件事交给 Antigravity 里的 Gemini 接着做。Antigravity 也有 `/goal` 和子 Agent，只是模型的名字不同；另有几样是 Claude 专用的（两个调用别家模型的技能、`task-announce` 技能、Claude 账号的周额度、Claude 的本机记忆）。本文写这几处换成什么。开工指令的其余内容（范围、授权、要先问的、不许做的、做到什么算完、什么时候停）照旧有效。

## 1. 授权与 `/goal`

- 开工指令第 5 行写「用户用 `/goal` 指到本文开工时，本文里的授权才生效」。用户在 Antigravity 里用 `/goal` 指到开工指令和本文开工，授权就生效：合进 `main`、发版、部署节点、按决定文件删节点数据等都给你。
- 完成标准就是开工指令「做到什么算完」和 `/goal` 里那五项证据。Antigravity 判定目标的办法不一定和 Claude Code 一样，所以每一条证据（命令、退出码、条数、看过的图）都直接贴在对话里，不要只写在文件里。
- 到了「什么时候停」的某一条、又确实没有别的可做时：写清在等什么，停下等用户回复，不要为了凑条件接着做。

## 2. 分工与模型对照

开工指令「分工与档位」那张表照下面换。规矩不变：主会话拆活、定接口、派活、读每一份差异、自己重跑基线、合并、发版、部署、写进度，**不在主工作区写业务代码**；实现派给子 Agent，互不依赖的同时派，协议照 `guide_files/multi_agent.md`。

| 开工指令里写的 | 用在 | 换成 |
|---|---|---|
| 主会话：Opus、Extra 档 | 拆活、合并、发版、部署 | 你自己，**Argon High** |
| Opus（`opus-dev`、`opus-dev-high`） | 渲染管线、预渲染产物、舞台、队列与同步、任务进程、鉴权与票据、并发与时序、会动像素基线或对外接口的改动、写契约、根因不明的问题 | 子 Agent 用 **Argon High** |
| Sonnet（`sonnet-dev-high`） | 照契约实现、写测试、页面、工具包、探针、机械的批量活 | **简单、边界清晰的**用 **Flash 3.8 High**；不够清楚的用 Argon High |
| 独立审查（交接文档第 9 节：大块合入前另派一位不带作者结论的审查） | 合入前查改动 | 子 Agent 用 **Argon High**，只给它代码和契约，不给作者的结论 |
| GPT（`/subagent-gpt`）、Gemini 顾问（`/subagent-agy`） | 攻坚、文字顾问 | 这两个是 Claude 那边的技能，不用。攻坚改由 Argon High；卡住时照 `guide_files/solution_table.md` |

- 拿不准用哪个，往高一档（用 Argon High）。Flash 同一处改了两轮不过，换 Argon High 重派；Argon High 两轮不过，照解法表走，仍做不到就写清楚报给用户。
- 选谁、为什么，写在派活指令里；每个子 Agent 一个工作区（`.worktrees/<名>`）、一条分支（`gemini/<名>`）、一段不重叠的端口，报告写到 `docs/reports/AGENT-<分支名>.md`。
- 同时跑的子 Agent 不超过五路（交接文档第 9 节：六路时 CPU 一直满载，全量测试会偶发失败）。
- 端口避开用户常驻的 5190～5192、5210～5212；起开发服务器一律带 `PROMPTCUT_NO_PORT_FILE=1`。
- **合入前的闸门**照交接文档第 9 节逐项跑，由主会话自己跑；闸门脚本在 `out/main-session-tools/`，说明在 `docs/local.md`「主会话合入前的闸门脚本」。脚本是 bash 写的，用 `C:\Program Files\Git\bin\bash.exe` 跑。

## 3. 额度

开工指令「什么时候停」第 5 条说的是 Claude 账号的周额度到 90%。换成：**你这边账号的额度用到 90%**（或者用户叫停），照第 5 条的收尾办：不再派子 Agent，等派出去的收尾，各分支提交并推送，更新交接文档（写成 `handoff-render-018.md` 的新一节，或新开一份交接文档并在 `docs/plan/TODO.md` 里指过去），停下等用户。每次派活之前看一眼额度。

## 4. 播报

开工指令里的「用 `task-announce` 播报」，在这台 PC 上是一个本地脚本，不是 Claude 会话也能用。用法在 `docs/local.md`「任务播报脚本（不是 Claude 的会话也能用）」：先把内容写成 UTF-8 的 JSON 文件，再用那条 `Start-Process` 命令后台启动。什么时候播照开工指令「播报与汇报」。

## 5. 只记在 Claude 记忆里、没进仓库的用户习惯

下面几条是用户在和 Claude 的对话里定的，原来存在 Claude 的本机记忆里，你读不到，这里抄过来：

- **要用户拍板时在聊天里直接问**：正文里编号列出问题，每条写清这是什么、现在怎么样、有哪些选项、各自的后果、你的建议；不要弹选择题。
- **说白话、带背景**：术语第一次出现当场解释；代号（阶段号、裁定编号、分支名）第一次出现时用一句白话说明它指什么；不要把进度文件里的简写原样转给用户。用户看不懂会逐条追问，宁可每条讲透。
- **提到文档写文件名**，不写编号简称（这条仓库规则里也有）。
- **文档改动可以直接提交并推 `main`**，不用逐次问；代码照开工指令过闸门后合入。

## 6. 你会在文档里看到、但不用管的 Claude 专用东西

`CLAUDE.md` 里的 `@` 引用（你直接读 `AGENTS.md` 指的那三份文件）；`preview_start`、`mcp__…` 这类工具名；`opus-dev`、`sonnet-dev-high` 等子 Agent 名（按第 2 节换）；`~/.claude/` 下的记忆和技能（播报脚本除外，见第 4 节）；提交说明末尾的 `Co-Authored-By: Claude …`（你的提交不用加这一行）。

## 7. 开工顺序

1. 读 `AGENTS.md`，再读它指的 `docs/semantics/developer_guide.md`、`guide_files/suggested_agent_behavior.md`、`guide_files/constraints.md`。
2. 读开工指令 `render-018-kickoff.md` 和本文。
3. 读交接文档 `handoff-render-018.md`，再读两份决定文件 `user-decisions-2026-10-13.md`、`user-decisions-2026-10-14.md`（冲突时以 10-14 为准）。
4. 读 `docs/local.md`（不入库的本机说明：节点、测试要设的环境变量、闸门脚本、安卓模拟器）。
5. 照交接文档第 5 节的顺序接着做；第一件事是把交接文档第 2、3 节和两份决定文件补进 `render-refactor-progress.md`、`three-versions-progress.md`。
