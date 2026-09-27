# 子 Agent 报告：信箱分支合入准备（claude/coord-mailbox）

状态：完成，等主会话审查。worktree `.worktrees/coord-mailbox`，分支 `claude/coord-mailbox`，未推送、未合并。

## 做了什么

| 提交 | 说明 |
|---|---|
| `e71370a` | 文档：开工建本报告 |
| `08da6eb` | `git merge main`（合并 `3cccb04`，无冲突，未改写历史） |
| `f7eb001` | 探针：`scripts/probes/probe-coord.mjs` 的 `MAIL_DEFAULTS.KINDS` 加 `status`；`createMailbox` 注释里的种类列举同步；文件头补 `--kind` 四种取值，以及「在 Claude Code 里用一条后台运行的 `wait` 等消息，进程内长轮询、收到才退出唤醒会话，不让模型逐次轮询；`--state` 记最后读到的 seq」 |
| `2a915a8` | 测试：`server/test/probe-coord-mail.test.mjs` 加 `MB10`（`kind: status` POST 成功、GET 读回信封与 body）与 `MB11`（`report`、`STATUS`、空串、缺省四种未知 kind 都回 400 `bad-kind`，队列里不留） |

队列（to-cloud / to-local）、信封字段、鉴权都没动。命令行的 `send` 本来就原样透传 `--kind`，不用改代码，只在帮助里列出了取值。

## 验证

- `node --test server/test/probe-coord-mail.test.mjs`：tests 11，pass 11，fail 0。
- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（全量）跑了三次：
  - 第 1 次：退出码 1；tests 2962，pass 2949，fail 1，skipped 12。挂的是 `server/test/proc-lock.test.mjs`「接管权的 claim 文件残留了…不会把项目永久锁死」：杀掉子进程后等 500 ms，该 pid 仍被判为活着。单独跑该文件 9/9 通过。
  - 第 2 次：退出码 1；tests 2962，pass 2949，fail 1，skipped 12。这次挂的是 `src/kernel/diffProject.test.mjs` 的性能用例 V8-1000（差异中位数 5.22 ms，门槛 5 ms）。单独跑该文件 20/20 通过。
  - 第 3 次：**退出码 0；tests 2962，pass 2950，fail 0，cancelled 0，skipped 12，todo 0。**
  - 两次失败各在不同文件，都是全量并行负载下的时序或计时用例，与本分支改动（探针文件与信箱测试）无关。
- 跳过 12 条：11 条因本机没有 ffmpeg（encodeGif、ffmpeg 抽帧、导出链、PCM 取样 8 条），1 条「集成：/api/cards/layout 对真实项目返回整数框」。均为已知环境缺口，与本改动无关。

## 与任务书不一致的地方

- 任务书说用例名「带编号前缀（沿用该文件已有的命名风格）」，但该文件原有 9 条用例都没有编号前缀。我用了 `MB10`、`MB11`（MB 指信箱，接在原有 9 条之后编号），原有用例名没改。

## 对契约或计划的更正建议（我没改，不在文件清单里）

1. `docs/plan/http-transport-contract.md` 第 15 节末尾写「`claude/coord-mailbox` 只补说明，队列与消息种类不变」，与主计划第 6.4b 节（云端报到写 `kind: status`）冲突。本分支按 6.4b 与任务书加了 `status`，建议把那句改为「队列不变，消息种类加 `status`（主计划第 6.4b 节）」。
2. `docs/plan/Master-Execution-Plan.md` 第 6.2 节「信封」下 `kind` 的取值只列了 instruction / receipt / question，建议补一条 `status`：报到与状态（6.4b）。
3. 两条偶发失败的用例（`proc-lock` 的 500 ms 等待、`diffProject` V8-1000 的 5 ms 门槛）在全量并行时不稳，建议另起任务处理，否则会让合并前的基线判定反复。
