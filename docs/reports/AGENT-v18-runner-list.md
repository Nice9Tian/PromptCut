# AGENT-v18-runner-list:验收运行器补齐 0.7.18 的清单

分支 `claude/v18-runner-list`(从 main `f87e297a` 建),工作区 `.worktrees/v18-runner-list`,端口段 28990～29049。

## 任务

1. 把 `ACCEPT-018-map.md` 的 38 行全部进运行器清单,每项标明在哪能跑。
2. 运行器直接出 38 行的结论表(通过/失败/未跑/不适用),并写 Markdown 文件。
3. `--check-coverage` 变成真守门。
4. 问题 17:G0-2 的跳过数改成「跳过的只能是名单里的」。
5. 问题 16:`cloud-agent-ui-probe.mjs` 改走账号入口;其它必然跑不通的旧项逐条判。
6. 本机能跑的项实跑一遍。

## 进展

(开工,待填)
