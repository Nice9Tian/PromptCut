# AGENT 报告：rr-page-plan-parity（在线页面算单卡流与切分方的流计划对齐）

分支 `claude/rr-page-plan-parity`，工作区 `.worktrees/rr-page-plan-parity`，端口段 27540～27579。

## 任务

在线页面 `src/online/pageStreamPlan.ts` 的 `planPageStreams` 调 `groupStreams` 时，`fixed`（不参加合并但占预算的流）只收了单独成流的两类卡，没收依赖下层的流；服务端 `server/frame-stream.mjs` 的 `planStreams` 两样都收。同屏流多到要看像素预算时，两边对「哪几张独立卡并成组流」可能判得不一样。

## 进度

- 开工。
- 复现（提交 29639439）：`server/test/page-stream-plan.test.mjs` 新增 PSP-11、PSP-12，在改之前两条都红。
- 修复（提交 683d3019）。

## 复现到的不一致

PSP-11：4K、60 帧，六张满屏的平面独立卡（`punch-pill`、`focus-card` 交替），最上面一张依赖下层的卡（`terminal-3d`），同屏 0～3 秒。
切分方：七条流超过不看像素的 6 条，4K 满屏像素超预算，并出组流，单卡流只剩 f-1～f-4（预算 3 时只剩 f-1～f-3）。
页面（改前）：只看到六条单卡流，一张都不并，f-1～f-6 全出单卡流。页面产的 f-5、f-6 没人用，层表里同一张卡可能既有单卡流又有组流。
原因：页面的 `fixed` 只收单独成流的两类卡，没收依赖下层的流。单独成流的那一部分原来已经照抄了一份（`serverSoloStream`），判据与服务端相同。

## 改了什么

- 新文件 `src/render/streamPlanRules.mjs`（及 `.d.mts`）：从 `server/frame-stream.mjs` 原样挪来 `frame3d`、`streamEligible`、`cardNodeOf`、`graphCardWithInputs`、`soloStreamKind`、`BELOW_STREAM_RULES`、`belowStreamEligible`、`belowTargets`，只引 `./frameWindow.mjs`。
- `server/frame-stream.mjs`：改为引它；`streamEligible`、`graphCardWithInputs`、`soloStreamKind`、`BELOW_STREAM_RULES`、`belowStreamEligible` 照原名再导出。逻辑一字不变。
- `src/online/pageStreamPlan.ts`：删掉照抄的 `serverSoloStream` 和 `frame3d`；进不进流用共用的 `streamEligible`，单独成流用 `soloStreamKind`，另把 `belowTargets` 的结果按整幅画面的开销加进 `fixed`。依赖下层的流照切分方的缺省（开）算：页面读不到预渲染进程的环境变量 `belowStreamsEnabled`。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 合 main | `git merge main` | Already up to date（main 仍是 0f60d11b） |
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 相关单测 | `npm test -- page-stream-plan frame-stream below-stream source-stream stream-budget browser-stream-split` | 106/106 |
| 全量 | `npm test`（设了两个环境变量） | 退出码 0；6960 条，6944 过，0 失败（余为跳过）。第一次跑时环境变量带反斜杠被 shell 吃掉，账号类 87 条失败，设对后重跑全过 |
| 本页产流 | `page-stream-probe.mjs --only solo --base-port 27540` | 退出码 0，`ok: true`，`fails: []` |
| 预算探针 | `stream-budget-probe.mjs --port 27560 --host-port 27565` | 退出码 0，`ok: true`，`fails: []` |
| 卡的源码版本 | `card-source-version-compare.mjs --base main` | `ok: true`，88 项 0 变，身份 61 项 0 变 |
| 卡表 | `card-table-digest-compare.mjs --expect ,` | 101 张逐张相同 |

探针前后都查过：没有可见窗口；27540～27579 上没有残留监听。

## 键

服务端 `planStreams` 的逻辑没改（只挪了函数）：服务端现有单测全过，流的键不变；卡的键 0 张变。页面一侧只有「同屏超过 6 条、其中有依赖下层的流」的项目会变：页面不再多产那几条单卡流，与切分方一致了。

## 对任务书或语义的更正建议

无语义改动。`docs/reports/AGENT-rr-pixel-budget.md` 待办第 5 条、`AGENT-rr-below-3d.md`「要主会话注意」第 5 条可以标为已办。
