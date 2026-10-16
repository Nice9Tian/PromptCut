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

用户 2026-10-17 定：修基线交给 Antigravity 的 Argon 做，Claude 这边不修。

## 4. 逐条的第一行错误与初步判断（没验证）

只读了失败的输出，没读代码。下面是给接手的人的起点，不是结论。

### 4.1 队列与产流（`7ec227f6` 带进来，约 30 条）

- `render-queue-inproc` I1～I11（13 条）：全部报「超过 4000 步仍未满足条件」，队列的整链路场景跑不完。所有场景一起坏，像是同一处改动（切分、认领或抢占）让任务走不到完成。要先查清，是测试里节点的设定过时了（例如设备等级、能力位），还是队列逻辑真坏了。
- `card-lock-node` N5、N6（6 条）：同样是「超过 3000 步仍未满足条件」；N6 的最后一条报「derived 只含最终发布成功的」。
- `stream-queue` X1-split、X1-plan、X1-render、X1-render-skip、X1-sparse（5 条）：
  - X1-split 期望分段 `[[0,7],[8,9]]`，实际是 `[[0,9]]`。这和「motion 式的卡切分至少 30 秒，不足 30 秒整张一口气做完」一致，像是测试过时。
  - X1-render-skip 报「不认识的任务 kind:undefined」，要查。
- `pageStreams` PS-01、03、04、13、14（5 条）：报「任务 id 与切分方给浏览器出的那一份同一个式子」等，像是任务 id 或切分的算法改了，测试没跟上。
- `m6c-contract` MC-X1-queue-claims（1 条）：`streams:false` 的节点认领流任务的次数不对，可能和抢占有关。
- 部署清单（2 条）：`sp-hosting` 的 SPH-deploy-1 和 `account-hosted-wiring` 的 staged hosted account dependencies，都是按 `server/hosted/files.mjs` 拼出来的部署目录里找不到 `server/render-node/session.mjs`。这是真问题，要把它补进清单。

### 4.2 撤快照的页面一侧（14 条）

多数在测已经撤掉的快照功能（`user-decisions-2026-10-13.md` 第 1 条：每张卡的 HTML 快照作废）：

- `c10-beat-feed`（4 条）：报「播放中每拍都投了:0」，或读 `fit`、`swap` 时碰到 null。按拍换快照、装箱都已经撤掉了。
- `c10-l3-source`（4 条）：报「预取了播放头附近的原尺寸:0」等。在线来源已经不再预取快照和小尺寸。
- `m7-alive-source`（1 条）：报「按活着那一份的清单取块」。
- `stageLocalOnly` SL-01、`streamFallback`（各 1 条）：还在找「快照平面」。
- `onlineCardsL` OCE-L-06（1 条）：守门测试，报「editor/stageSwap.ts 走同一个判法」。
- `c10a-swap-gate`：整个文件失败，一条用例都没跑就退出了，多半是引用了已经撤掉的导出。
- `hosted-render-capacity` HR21h（1 条）：报「页面在取块，而且取不到」。

这些要逐条判断：测试是该删、该改成测新的行为，还是代码真有毛病。读到 null 的那两条，要确认页面在实际运行中不会也读到 null。

### 4.3 账号（`611fb04c` 起，约 12 条）

- `account-page-link`（「丙换了 0 次会话」）和 `account-card-sync`（「到期的连接被闸拒，端点换会话」）：在测已经撤掉的「按钟点换会话」（`user-decisions-2026-10-14.md` 第 3.0.1 节），像是测试过时，要改成测主动撤权。
- **`operation-wiring-core` 两条要小心**：「entry and both commit phases recheck real credential」和「credential revoked in reserve/seal gap is rejected despite cached creator principal」测的是安全性质：每次提交都要向权威重核凭证，撤权以后要拒。不能为了让它们过就放松。先查是不是撤权那次改动把这道重核弄丢了，弄丢了就修代码。
- `account-assembly-central`（2 条，「Missing expected rejection」）：本该被拒的请求没被拒，同样先当成可能的安全回退去查。
- `account-logout-confirmation`（「三种故障都真的发生过」）和 `account-hosted-wiring` 的 hosted account v2（值不相等）：要看新的确认链路下，注入的故障还会不会真的发生。
- `gone-trust-source`（`0ba84411` 带进来）和 `page-requests` 的 CAU-REV-06（`301f8a39` 带进来）：都是守门测试。前者是页面一侧引用证明模块的地方变了，后者是账号模式下页面请求的接线写法变了。先判断新写法安不安全：安全就改守门测试，不安全就改代码。
- `accept-018-rest-ssr-seam`（1 条，`1e4541f3` 之前就有）：没看。
- `account-logout-timeout`：全量跑时端口被占（`EADDRINUSE`），单独跑都过，不用改。
