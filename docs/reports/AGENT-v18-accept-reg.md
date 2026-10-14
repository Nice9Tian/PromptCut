# AGENT-v18-accept-reg:验收清单登记后合入的探针、修两支过时探针

分支 `claude/v18-accept-reg`(端口段 27460～27499)。只动 `scripts/acceptance/`、`scripts/probes/`、报告;没改产品代码。

## 第一件:登记
- 渲染附加项(类别 G0-R,编号 `RR-*`,22 项,全部 optional,`--only 'RR-*'` 或 `--include-optional` 才跑),端口挂在 0.7.18 的端口段(`P(n)=V+n`,串行用)。
- 0.7.18 的 5 项:`V18-wire-probe`(替掉等分支合入的人工项)、`V18-cardsync-probe-wait`(命令改成 `--dist`)、`V18-logout-text-probe`、`V18-move-probe`、`V18-account-tools-perms-linux`(要 Linux root,记 node)。`V18-cardsync-wait` 的 wait 标记去掉(分支已合入)。
- 从 `V18_EXCLUDED` 里摘出 `page-stream-probe`、`hosted-render-streams-probe`、`online-stream-play-probe`,改为登记项。
- 用 `--dry-run --include-optional --only` 看过 26 项命令行;`--check-coverage` 退出码 0。
- 拿不准:`account-move-probe` 的行号(2.1-6、2.1-7)是按内容归的;`cloud-tools-wire-probe`、`account-card-sync-probe`、`account-move-probe` 端口写死在 286xx～289xx,不随 `--v18-port-base`;`account-logout-text-probe` 要指向带退出确认时限的那版 VisuHive;没有实跑这些新登记的探针(额度)。

## 第二件
- `hosted-render-streams-probe`:liveShot 不再等 `!tracks.length`,看包裹层没被抑制、露精确活渲(同 page-stream-probe)。修前 main 上退出码 1,修后 `--base-port 27460` 退出码 0,`fails: []`。
- `online-stream-play-probe`:同样的改法;S5 修后通过。S6「没有显示占位符」仍不过(退出码 1,两遍都只有它)。
- S6 结论:产品问题,不是探针期望过时。组流在画(21 个样本,两张卡都被抑制、画布整幅、字节父页推来),但起播后头约 170 毫秒(t=0.833～1.0,每次 5 个样本)两张卡的占位符槽都没隐藏,且没有快照。这就是 `AGENT-rr-a1-integ.md` 第 203 行记过的:`placeholderHost.ts` 的「这一帧快照没到」(`.pc-awaiting`)判据不看流在不在画,兜底 500 毫秒内沙漏盖在流上。`mechanism/rendering.md` 的兜底顺序是流在画就不该再显示占位符。怀疑位置:`src/render/placeholderHost.ts` 的 T2。没改产品。探针断言未放松,只在失败详情里带上出现占位符的样本。

## 验证
`git merge main` 已是最新;`npx tsc -b --force` 0;`npm test`(设好两个账号环境变量)退出码 0:6957 条,过 6941,失败 0,跳过 15,待办 1(第一遍我把环境变量取错,失败 87 条全是账号测试缺变量,改正后一遍过);`--check-coverage` 0。
