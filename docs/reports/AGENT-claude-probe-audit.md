# 探针总审：与语义相符、是否过时、是否冗余

分支 `claude/probe-audit`，worktree `.worktrees/probe-audit`，基准 `2249179a`（2026-10-23，R01 返工与直达地址已在 main）。
任务由用户 2026-10-23 用 `/goal` 下达：审查全部探针是否与语义相符、是否过时、是否冗余；授权用多个 Argon 审核、多个 Opus 交叉审核，分块派出，**最终取舍由主 Agent 自己判断**。

「探针」指 `scripts/probes/` 下的手工验收脚本（368 个文件，约 8.6 MB），它们**不在** `npm test` 里（`scripts/test-suite.mjs` 只收 `server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`），但有 68 支被某个单测 import 或 spawn。

## 怎么审的

1. 主 Agent 先自己建全仓台账：每支的行数、最近改动、引用关系、它引用的语义与计划文件、失效指针（脚本在 scratchpad，结论见下）。
2. 按领域切 16 块，每块派一个 **Argon**（经 `agy-manager`，用用户自己的 agy 额度）做只读审查，逐支回答「验什么 / 对应语义原文 / 相符性 / 过时信号 / 单测依赖 / 冗余 / 建议」。
3. 关键结论派 **Opus** 子 Agent 交叉核对，要求能反驳就反驳。
4. 主 Agent 自己复核每一条要动的，证据写进本报告；子 Agent 的结论不直接采纳。

## 已核实的结构性事实

| 事实 | 证据 |
|---|---|
| 仓库有一套验收台账 | `scripts/acceptance/four-stage-manifest.mjs`：290 个清单项，每项 `covers` 点名用哪几支探针；`EXCLUDED_PROBE_FILES` 169 条写明某支为什么不在整套验收里 |
| 守门命令会拦未登记的探针 | `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`，判据在 `acceptance-lib.mjs:641` 的 `coverageReport()` |
| 守门现在**不过** | 基准提交上实跑：未登记 3 支 —— `cut-online-browser-probe.mjs`、`account-direct-address-probe.mjs`、`update-notice-probe.mjs`（后两支随 0.7.21 的分支刚合入） |
| 语义不逐条点名探针 | `guide_files/verification.md`「画面」一行只说「看图，或跑 `scripts/probes/` 下对应的探针（用法见各脚本文件头）」 |
| 仓库已有「退役但留着对账」的去处 | `scripts/archive/export-frames-virtual-time.mjs`，`scripts/README.md` 写「旧后端，只留作对账」 |

**主 Agent 据此定的取舍口径**：

1. 被清单项点名、或被单测 import/spawn 的 → **留**（要删得先交代那几项验收以后拿什么当证据）。
2. 验的行为已被推翻或已删、依赖的分支与代码已不存在 → **删**。
3. 还能跑但只是一次性实测、无验收项也无单测依赖 → **归档**到 `scripts/archive/probes/`，不删。
4. 断言与语义现行写法不一致、把机器快慢当通过条件、指针失效 → **改**。

## 处置清单

（逐条填写，每条带证据与自核结论；进行中）

## 验证

（按影响范围选测试，2026-10-23 用户定；逐项记录）
