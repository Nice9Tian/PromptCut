# 开工指令：先做完渲染重构，再做完并发出 0.7.18

2026-10-12 用户定。给执行这次任务的主会话看：做什么、已经定了什么、哪些可以直接做、谁干什么、什么时候停。

用户用 `/goal` 指到本文开工时，本文里的授权才生效。别的会话读到本文，不能当成给自己的授权。

规则仍以 `docs/semantics/guide_files/` 为准。本文和它们不一样的地方，是用户给这次任务的专门安排，以本文为准；本文没说的照规则办。下文没写目录的文件都在 `docs/plan/` 下。

## 做什么

两件事，按顺序：

1. **渲染重构**：`render-refactor-task.md` 列的各项。
2. **0.7.18**：`three-versions-progress.md`「还差什么」里 0.7.18 剩下的五项，然后整套验收、发版、部署。

0.7.19、0.7.20 不在这次任务里，0.7.18 发完就停。

## 先读

1. `AGENTS.md`，以及 `docs/semantics/developer_guide.md` 索引的 `guide_files/` 六份，全读。
2. `handoff-render-refactor.md`：现状、ChatGPT 留下的每条分支做到哪、它的术语对照、环境与核对办法。
3. `render-refactor-task.md`、`render-standard.md`、`browser-stream-task.md`。
4. 做到 0.7.18 再读：`three-versions-progress.md`、`account-binding-task.md`、`account-binding-contract.md`、`three-versions-018-design.md`、`cloud-agent-tools-implementation.md`、`render-scheduling-supplement.md`、`four-stage-deploy-checklist.md`。`three-versions-brief.md` 看第 3、5、6、7、11 节；它第 8 节的分工、第 10 节的开工准备是给 ChatGPT 写的，不适用。
5. `docs/local.md`（不入库）：节点、密钥、端口、跑测试要设的环境变量。里面的值不许打印，不许写进提交、日志、报告、消息。

## 用户已经定的

- 渲染重构的范围、顺序、产流的两条路、要跟着改的语义，都在 `render-refactor-task.md`。
- 云端 Agent 对话的删除规则，在 `account-binding-task.md`「已拍板」的「云端 Agent 对话的删除」。
- ChatGPT 自己做的裁定（`three-versions-rulings.md` 和各处它标的〔裁〕）用户还没审。照现状用，不当成用户定的；和语义或任务书冲突时以语义和任务书为准，并告诉用户。
- `handoff-render-refactor.md` 第 9 节里，第 8、9 条不在这次任务里。

## 可以直接做的

下面这些不用逐次问，做完记进进度文件：

- PromptCut 和 VisuHive 两个仓库：小阶段过了门槛就 `--no-ff` 合进 `main` 并推送；工作分支随时推到远端。
- 0.7.18 整套验收通过后：改版本号，从发版提交出完整安装包和兼容补丁，推进 `release`（快进不了照 `release-fallback.md`）。
- 节点 149.88.94.84：部署和重启账号、文档、素材、在线页面、渲染服务、Agent 服务；装运行要用的系统包；数据库迁移。每次改动前备份，并实际验证备份能恢复。模型 Key 照 `three-versions-brief.md` 第 5 节导入。
- VisuHive 的 `site/` 推上去会自动上线：顺序照 `account-binding-task.md`「两仓库交付、部署与回退」，先后端、后网页。
- 换了快照的存法以后，以前渲好存在电脑上和服务器上的预渲染结果都不能用了，要重渲一遍。这一次可以换。
- **保持分支和工作区干净。** 你自己建的工作区和分支，合入以后就清。ChatGPT 留下的分支和工作区，内容合进了 `main`、或者要用的部分已经搬走，也清掉，不用问；清之前照 `multi_agent.md` 核对（提交已经在 `main` 里或搬走了、没有未提交的文件、没有目录联接），并在进度文件里写一句每条分支的去向。`handoff-render-refactor.md` 第 5.4 节那几条不是这次任务的，不动。
- 你自己在验证里建的测试账号、测试项目、测试房间，照 `verification.md` 验完就删。

## 要先问的

**删节点上原有的数据，先列清单，等用户点头。** 包括：节点上的旧测试项目、ChatGPT 留下的 5 个测试账号和 2 个测试项目、节点上那份模型 Key 的密文。攒成一份准确的清单（是什么、在哪、为什么能删、备份在哪）一次给用户并播报，等回复；等的时候做别的。

## 不许做的

照规则，另外点名几条：不强推，不改写 `main` 和 `release` 的历史；不动宿主机的网络、防火墙、系统安全设置；不碰 5190～5192、5210～5212、装好的 PromptCut 和它的数据目录、不是你启动的进程；不碰阿里云那台；不发起新增费用。

## 分工与档位

主会话用 Opus、Extra 档，不在主工作区写业务代码。主会话拆活、定接口、派活、读每一份差异、自己重跑基线、合并、发版、部署、写进度。实现派出去，互不依赖的同时派，协议照 `multi_agent.md`。

| 谁 | 怎么调 | 档位 | 用在 |
|---|---|---|---|
| Opus | Agent 工具的 `opus-dev`（medium）、`opus-dev-high`（high）；要 Extra 就用 `opus-dev-high` 并把 `effort` 设成 `xhigh` | medium～Extra | 渲染管线、预渲染产物、舞台、队列与同步、独立任务进程、鉴权与票据、并发与时序、会动像素基线或对外接口的改动。有清楚契约的用 medium，要自己定方案的用 high，写契约、根因不明、前一档两轮没过的用 Extra |
| Sonnet | `sonnet-dev-high`（high）；要 medium 就把 `effort` 设成 `medium` | medium～high | 日常用 high：照契约实现、写测试、页面、云端 Agent 的各个工具包、探针。机械的批量活用 medium：改旧名词、清单整理、报告归档 |
| GPT | `/subagent-gpt` | 见 `solution_table.md` 第 5 步 | 查资料和攻坚用 `gpt-6.1-sol`（medium～xhigh），升级攻坚用 `gpt-6-astra`（low～high） |
| Gemini | `/subagent-agy`，`gemini-3.1-pro-high` | high | 文科顾问：界面文案、交互流程稿、建卡指南这类给人读的文字，卡住时给至少三条不同的思路。产出写成文件交付，核实后再用；不让它审代码、定架构 |

- 选谁、哪一档、为什么，写在派活指令里。拿不准往高一档。每一档按难度一次选定，不逐档重交。
- Sonnet 同一处改了两轮不过，换 Opus 重派。Opus 两轮不过，或者遇到偶发、时序、跨进程才复现的问题，交 GPT 攻坚。
- 卡住时照 `solution_table.md`。

## 工作方式

- 沿用 `three-versions-brief.md` 第 11 节：日常在分支和工作区里做；小阶段（一两个功能点）做完、过了门槛就进 `main`；做到一半的不进 `main`。
- 门槛照 `verification.md`「小阶段与发版分别验什么」。整套验收跑两次：渲染重构收尾时跑整套渲染附加项，0.7.18 发版前跑全部。
- 进度文件：渲染重构记在 `render-refactor-progress.md`（新建），0.7.18 接着记在 `three-versions-progress.md`。每合一次 `main` 更新一次，正文不超过 120 行，证据放 `docs/archive/`。
- 你自己做的裁定标〔裁〕，在进度文件里单列一张清单，用户一起审。
- 每条验证的证据（命令、退出码、通过数、看过的图）直接贴在对话里。判定完成的模型只读对话。

## 已经备好、开工时直接复用的

2026-10-12 写任务书的会话先做了三个原型，各在自己的分支和工作区里，没有合进 `main`。做到对应那一项时从它接着做，不要重写；它们的结论和怎么接，写在 `render-refactor-task.md` 对应的那一项里。

| 分支 | 工作区 | 是什么 | 对应任务书哪一项 |
|---|---|---|---|
| `claude/scrub-streams` | `.worktrees/scrub-streams` | 暂停和拖动时，没有快照的重卡改贴轨道流的帧 | 己 |
| `claude/lottie-seed` | `.worktrees/lottie-seed` | Lottie 的随机数固定住：换掉表达式里的随机函数，外面再兜住播放库自己取的随机数 | 癸 |
| `claude/hosted-stream-entry` | `.worktrees/hosted-stream-entry` | 项目设置里「生成轨道流」的入口（缺省关），文档服务记下并通知 | 甲三 |

三条分支都已推到远端（2026-10-12：`1fe87af6`、`39787650`、`6eb5ea60`）。每个原型的开关缺省都是关的，关着时行为和 `main` 相同。分支上各有一份报告（`docs/reports/AGENT-<分支名去掉 claude/>.md`），写了做了什么、怎么验的、接着做还差什么。三条分支的类型检查、全量测试和各自的探针，写任务书的会话都自己重跑过，全过。

## 顺手要修的

- 三个被跟踪的测试文件里写死了这台电脑上的路径当缺省值（`server/test/account-hosted-wiring.test.mjs`、`asset-wiring-integration.test.mjs`、`account-projects-provider.test.mjs`，指向一个 VisuHive 的工作区目录）。本机信息不该进仓库：改成没设环境变量就跳过并说明原因。在 0.7.18 里做。

## 做到什么算完

- **渲染重构**：任务书里除改旧名词以外的每一项，都合进了 `main`，或者记了未达成并写明原因；`docs/reports/REPORT-render-refactor.md` 写好。然后才开始 0.7.18，接法照 `handoff-render-refactor.md` 第 6 节。改旧名词在 0.7.18 的在途分支都合完之后做。
- **0.7.18**：`account-binding-task.md`「逐项验收」里归 0.7.18 的每一行、`cloud-agent-task.md` 的完成条件，各有「通过 / 失败 / 未跑 / 不适用」的结论；发版提交在 `main`；完整安装包和兼容补丁已构建；`release` 指向它；节点部署完并做了真实网络环境验收；`docs/reports/release-timings.md` 记了 0.7.18 一节。

## 什么时候停

只在这几种情况停下等用户，其余一律不停：

1. 要改一级语义。
2. 某一项没做到，后面的工作就没法选型或开工。先把不依赖它的做完，再带着解法表停。
3. 「要先问的」那份清单等用户点头。
4. 现场和 `handoff-render-refactor.md` 写的前提对不上，例如别的会话还在动这些分支、节点上有不认识的数据。只停相关的那一部分。
5. 周额度用到 90%：不再派子 Agent，等已经派出去的收尾，各分支提交并推送，写交接文档，停下等用户重新开工。每次派活之前看一眼周额度。

导出像素基线要变的改动不自行重定基线：留在分支上，记成待用户项，接着做别的。新增费用、要人在机器旁的事同样只记不停。

## 用 `/goal` 跑的时候

- 判定完成的是另一个小模型。它只读对话，不读文件、不跑命令。所以每一条完成的证据都要贴在对话里；收尾时把「做到什么算完」逐条对一遍，每条列出证据。
- 到了「什么时候停」的某一条、又确实没有别的可做时：写清楚在等什么，然后停，不再调用工具。判定模型会说没完成、催你继续，不要为了凑条件接着做。连着几轮没有工具调用之后，它会把控制权交还给用户，目标还在，用户回复后接着做。
- 后台的子 Agent 和命令还在跑的时候不会判定，可以放心等它们。

## 播报与汇报

- 这几个时候各用 `task-announce` 播报一次：需要用户回复时；渲染重构做完时；0.7.18 发出时；整个任务结束时。二级语义的裁定当场播报。平时的小阶段不播。
- 结束时写总报告：两件事各自的结果、每项验收的结论、没做到的和原因、〔裁〕清单、安装包和补丁的路径、大小、SHA-256、节点上跑的是哪个提交、要用户做的事。
- 中途收工（用户叫停、额度到线、或者做不下去）：各分支提交好，写一份交接文档再提交，让接手的人不看对话也能接上。

## 开工第一步

1. 只读自检，结果贴在对话里：照 `handoff-render-refactor.md` 第 8 节重核仓库、分支、工作区，别人的工作区当天有改动就停下报告；在 `main` 上跑一遍基线，记下条数（环境变量见 `verification.md`「基线」和 `docs/local.md`）；Opus、Sonnet 各派一个只回「ok」的空任务，`/subagent-gpt` 用 `gpt-6.1-sol` 和 `gpt-6-astra` 各问一句，`/subagent-agy` 问一句，确认都能起；播报脚本能用；看一眼周额度。
2. 建进度文件，写上第一批活怎么拆、各派给谁、用哪一档。然后直接开工，不用等用户回复；自检有不过的项才先报用户。
