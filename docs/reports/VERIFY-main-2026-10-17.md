# main 全量测试核对（2026-10-17）

Claude 主会话 2026-10-17 01:57～02:22（日本时间）做的核对，用户说「再检查一下」。起因：10-16 这一轮的合入记录（进度文件、交接文档第 10 节、`REPORT-render-refactor.md`）里只有探针、挑出来的测试文件和导出像素比对，没有类型检查和全量测试 `npm test` 的结果。开工指令和交接文档第 9 节的合入闸门要求这两项。

怎么跑的：在临时工作区（`.worktrees/verify-*`，跑完已删）里跑，环境变量照 `docs/local.md`「跑全量测试要设的两个环境变量」。只跑测试，没改代码。

## 1. 结果

| 提交 | 是什么 | 类型检查 | 全量测试 |
|---|---|---|---|
| `0e99dd63` | 10-16 18:32 收工时的 main（之后只有文档提交） | 0 错误 | 7011 条：6938 过、**58 失败**、14 跳过（150 秒） |
| `1e4541f3` | 撤快照合入之前（代码与 `dc89b6e3` 相同） | 没跑 | 6997 条：6950 过、**32 失败**、14 跳过 |
| `3ac769fa` | 10-15 接手时 | 没跑 | 只跑了上一行出错的 8 个测试文件：103 条全过 |

所以 main 从 10-16 凌晨起一直是红的，不只是这一轮最后几次合入。

## 2. 每批失败是哪次合入带进来的

前两行用 `git bisect` 在 `3ac769fa`～`1e4541f3` 之间找，后面几行在 main 的各个合入点上单独跑出错的文件。条数以测试运行器的统计为准，个别文件里一条测试会报两处位置，所以按文件数的合计和条数差一两条。

| 合入 | 新增失败 | 出错的测试文件 | 看着像 |
|---|---|---|---|
| `7ec227f6`（`rr-motion-preempt`，合并 `57bab25d`，10-16 凌晨） | 32 | `render-queue-inproc` 13、`card-lock-node` 6、`stream-queue` 5、`pageStreams` 5、`m6c-contract` 1、`account-hosted-wiring` 1、`sp-hosting` 1 | ①切分和抢占改了以后，测试没跟着改。例：X1-split 期望流任务分段 `[[0,7],[8,9]]`，实际 `[[0,9]]`。②任务队列的整链路场景跑不完（「超过 4000 步仍未满足条件」），要查是测试过时还是代码有毛病。③**部署清单漏了 `server/render-node/session.mjs`**：按 `server/hosted/files.mjs` 拼出的部署目录里起不来（SPH-deploy-1、staged hosted account dependencies）。这一条部署到节点时会真出事 |
| `7ec227f6` 之后、`1e4541f3` 之前 | 1 | `accept-018-rest-ssr-seam` | 没再细分 |
| `59b85f09`～`35b0a803`（己二页面一侧） | 14 | `c10-beat-feed` 4、`c10-l3-source` 4、`c10a-swap-gate`、`onlineCardsL`、`m7-alive-source`、`stageLocalOnly`、`streamFallback`、`hosted-render-capacity` 各 1 | 撤快照以后，测快照投递、按拍换快照的老测试还在（例：「播放中每拍都投了:0」）；要逐条判断是测试该改还是代码有毛病 |
| `e13c6bcb`、`3641145e`（己二服务端一侧） | 0 | — | — |
| `52d3d2b5`（G0-R 收尾） | 0 | — | — |
| `611fb04c`（`v18-revoke-logout`） | 9 | `account-assembly-central` 2、`operation-wiring-core` 2、`account-hosted-wiring` 1、`account-card-sync` 1、`account-logout-confirmation` 1、`account-page-link` 1 等 | 撤掉 90 秒换会话以后，测「到期前换会话」的测试还在（例：「丙换了 0 次会话」）；其余要逐条看 |
| `0ba84411`（`v18-move-proc`） | 1 | `gone-trust-source` | 守门测试：页面一侧引用证明模块的地方变了 |
| `301f8a39`（`v18-chat-workflow-jobs`） | 1 | `src/ai/cloud/page-requests` | 守门测试：源码里找不到期望的接线写法 |
| 环境 | 1 | `account-logout-timeout` | 全量跑时端口被占（`EADDRINUSE`）；在各合入点单独跑这个文件都过 |

## 3. 要做的

1. 接着做 0.7.18 之前，先把 main 修回全绿：上表逐条判断是「照用户的新规则改测试」，还是「代码真有毛病」。部署清单漏文件那一条必须修。
2. 以后每次合入的记录里贴类型检查和全量测试的条数（过、失败、跳过），不只贴探针。
3. 合入后不要再跑 `git pull --rebase`。它会把 `--no-ff` 的合并提交拍平、给分支上的提交换号，`guide_files/multi_agent.md` 要求的是 `--no-ff` 合并。10-16 有三次这样被拍平，记录里的号已在 `1bc0ebc5` 更正。
