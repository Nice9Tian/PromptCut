# 开工指令交给 Antigravity 时怎么读

2026-10-15 写。`render-018-kickoff.md`（开工指令）是照 Claude Code 写的。用户 2026-10-15 把这件事交给 Antigravity 里的 Gemini 接着做。Antigravity 也有 `/goal` 和子 Agent，只是模型的名字不同；另有几样是 Claude 专用的（两个调用别家模型的技能、`task-announce` 技能、Claude 账号的周额度、Claude 的本机记忆）。本文写这几处换成什么。开工指令的其余内容（范围、授权、要先问的、不许做的、做到什么算完、什么时候停）照旧有效。

## 1. 授权与 `/goal`

- 开工指令第 5 行写「用户用 `/goal` 指到本文开工时，本文里的授权才生效」。用户在 Antigravity 里用 `/goal` 指到开工指令和本文开工，授权就生效：合进 `main`、发版、部署节点、按决定文件删节点数据等都给你。
- 完成标准就是开工指令「做到什么算完」和 `/goal` 里那五项证据。Antigravity 判定目标的办法不一定和 Claude Code 一样，所以每一条证据（命令、退出码、条数、看过的图）都直接贴在对话里，不要只写在文件里。
- 到了「什么时候停」的某一条、又确实没有别的可做时：写清在等什么，停下等用户回复，不要为了凑条件接着做。

## 2. 分工与模型对照

开工指令「分工与档位」那张表照下面换。规矩不变：主会话拆活、定接口、派活、读每一份差异、自己重跑基线、合并、发版、部署、写进度，**不在主工作区写业务代码**；实现派给子 Agent，互不依赖的同时派，协议照 `guide_files/multi_agent.md`。

2026-10-16 改定：Antigravity 里除了 Gemini 的 **Argon High**、**Flash 3.8 High**，还能调 Claude 的 **Opus 5.5**（medium / High）和 **Sonnet 5.5 High**。用户要两边的额度摊开用。用户对两边的看法，原话：「我觉得OPus5.5和Argon几乎是一样的。Opus可能更工程一点（稍微一点），做UI等前端审美更好一点，Argon在复杂逻辑上更出色（比如修BUG，反编译等边界非常具体的任务上），但是它没那么工程，比如有时候抓不到整体，分不清主次。」

| 活 | 首选 | 首选那边额度紧时 | 为什么 |
|---|---|---|---|
| 主会话：拆活、合并、发版、部署 | 你自己（Argon High） | — | 用的是 Gemini 这边的额度 |
| 边界非常具体的难题：根因不明的缺陷，偶发、时序、跨进程才复现的问题，像素或输出对不上的对拍，读懂没有文档的旧代码 | Argon High | Opus 5.5 High | 边界清楚的复杂逻辑是 Argon 的强项 |
| 要抓整体、分主次的工程活：拆方案、写契约、定接口、跨模块的改动、一整块功能（例如撤快照的服务端一侧、云端 Agent 按轮占用） | Opus 5.5 High | Argon High，派活指令里把主次和取舍写明 | Opus 更工程、更能抓整体 |
| 界面与前端：页面、提示行、交互、样式 | Opus 5.5 medium，复杂的用 High | Argon High | Opus 的前端审美更好 |
| 照契约实现、写测试、探针、工具包 | Opus 5.5 medium；跨进程、要等时序的探针用 High | Argon High | 用户 2026-10-16 改定：这类活 Opus 好一点，尤其是测试和探针（原定首选 Sonnet 5.5 High） |
| 简单、机械的批量活：改名、清单整理、报告归档 | Flash 3.8 High | Sonnet 5.5 High | 省额度 |
| 合入前的独立审查（交接文档第 9 节：大块合入前另派一位不带作者结论的审查） | 换一边审：Gemini 写的派 Opus 5.5 High，Claude 写的派 Argon High；只给代码和契约，不给作者的结论 | 同一边的另一个高档模型 | 换个模型看，盲点不重合，两边额度也自然摊开 |
| 主次检查：每开一块大活之前 | Opus 5.5 High：只给进度文件、任务书和这块活的拆法，问「现在最该做的是不是这个、有没有偏离主线、哪些可以不做」 | — | 补主会话抓整体、分主次的短板；它只提意见，定还是主会话定 |
| GPT（`/subagent-gpt`）、Gemini 顾问（`/subagent-agy`） | 不用（这两个是 Claude Code 那边的技能） | — | 攻坚改由 Argon High 或 Opus 5.5 High；卡住时照 `guide_files/solution_table.md` |

- 选谁、为什么，写在派活指令里。拿不准就往高一档。
- 「首选那边额度紧时」一栏都换到另一边，这样第 3 节的平衡才挪得动。Claude 那边只想省一点、还没到紧的时候，边界很清楚、改动小的实现和改测试断言可以交给 Sonnet 5.5 High。
- Antigravity 里 Opus 最高只到 High，没有开工指令说的 Extra 档（用户 2026-10-16 说明）。开工指令里要 Extra 的活（写契约、根因不明、前一档两轮没过），按上表的性质用 Opus 5.5 High 或 Argon High。
- 升级：Flash 同一处改了两轮不过，换 Sonnet 5.5 High 或 Argon High；Sonnet 两轮不过，换 Opus 5.5 High；Opus 或 Argon 两轮不过，换另一边的高档再试一轮（Opus↔Argon），仍不过照解法表走，做不到就写清楚报给用户。
- 选谁、为什么，写在派活指令里；每个子 Agent 一个工作区（`.worktrees/<名>`）、一条分支（`gemini/<名>`）、一段不重叠的端口，报告写到 `docs/reports/AGENT-<分支名>.md`。
- 同时跑的子 Agent 不超过五路（交接文档第 9 节：六路时 CPU 一直满载，全量测试会偶发失败）。
- 端口避开用户常驻的 5190～5192、5210～5212；起开发服务器一律带 `PROMPTCUT_NO_PORT_FILE=1`。
- **合入前的闸门**照交接文档第 9 节逐项跑，由主会话自己跑；闸门脚本在 `out/main-session-tools/`，说明在 `docs/local.md`「主会话合入前的闸门脚本」。脚本是 bash 写的，用 `C:\Program Files\Git\bin\bash.exe` 跑。

## 3. 额度

开工指令「什么时候停」第 5 条说的是 Claude 账号的周额度到 90%。2026-10-16 起有两边额度，各看各的：Gemini 这边（Argon、Flash，主会话自己也用它）和 Claude 这边（Opus、Sonnet）。每次派活之前看两边的余量，在派活记录里写一笔。

- 平时按第 2 节的首选派。一边用到 70%、另一边还宽裕时，两边都做得了的活改派另一边。
- Claude 这边用到 90%：不再派 Opus、Sonnet 的新活，派出去的做完为止，之后只派 Gemini 这边。
- Gemini 这边用到 90%，或者用户叫停：主会话自己也撑不下去了，照第 5 条收尾，不管 Claude 那边还剩多少：不再派子 Agent，等派出去的收尾，各分支提交并推送，更新交接文档（写成 `handoff-render-018.md` 的新一节，或新开一份交接文档并在 `docs/plan/TODO.md` 里指过去），停下等用户。

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
3. 读交接文档 `handoff-render-018.md`，再读决定文件 `user-decisions-2026-10-13.md`、`user-decisions-2026-10-14.md`、`user-decisions-2026-10-16.md`（冲突时以日期新的为准；10-16 那份给 0.7.18 加了托管渲染服务的暂行调度「云端 Agent 按轮占用」）。
4. 读 `docs/local.md`（不入库的本机说明：节点、测试要设的环境变量、闸门脚本、安卓模拟器）。
5. 照交接文档第 5 节的顺序接着做；第一件事是把交接文档第 2、3 节和两份决定文件补进 `render-refactor-progress.md`、`three-versions-progress.md`。
