# AGENT 报告：剪辑段逐卡流的线上缺陷修复

分支 `claude/cut-stream-fix`，工作区 `.worktrees/cut-stream-fix`，基于 `claude/accept-final3` `6028555c`。没有推送、合并、部署。

## 状态

缺陷 4、5 已修并有回归测试；缺陷 1/2 查清，结论是「那张卡在这台机器上测出来是轻卡，判轻、活渲是对的」，页面一侧不用改，Agent 一侧的漏发由缺陷 5 的修法一并补上；缺陷 3 在本机三种环境下都没复现出来，没改代码（见下）。

## 取证来源

- 线上只读（ssh，只读文件和日志，没改任何东西）：文档服务里这个项目的真身 `…/tenants/sp_pqqwrqehp6yw34mextkkc24vwv/projects/*.state-*.json`（rev 41）、共享成本记录 `costs/*.ndjson`、Agent 对话 `cc-mvfw3j7c-eqwh` 的 `history.json`、`/var/log/syslog`、渲染服务 `/root/.pm2/logs/promptcut-render-out-6.log`。
- 项目真身拷到本机做复现：`docs/archive/agent-reports/assets/cut-stream-fix/project41.json`（剪辑1 激活；剪辑段 `k-mvfskg83-2` 0–3 秒引用剪辑2；剪辑2 里组合卡 `c-mvfsjn5m-1` 和粒子卡 `c-mvhdf6ef-2`；剪辑1 里 `particles-parallax` `c-mvgz82ix-2` 4–7 秒）。
- 复现脚本（放在 `out/cut-stream-fix/` 下跑，`out/` 不入库；入库的副本在 `docs/archive/agent-reports/assets/cut-stream-fix/`，路径按 `out/cut-stream-fix/` 写的）：
  - `repro.mjs`：dev server（29300，舞台 29301/29302）+ 编辑器，载入项目，等测量完，打印分派表、身份、成本记录，再跳到 1.5 / 5.5 / 2.5 秒，各录 10 秒长任务；`--browser` 打开在线浏览器模式（`platform=browser`）。
  - `repro-online.mjs`：在线构建（`vite build --mode online`）+ 本机托管组合（文档服务 29303、素材服务 29304）+ 跨源双舞台（`s1/s2.pc.localhost:29301/29302`），成员页面进项目后同上。
  - `repro-online2.mjs --desk`：再加一台桌面预渲染进程当切分方（29305～29307），先切到剪辑2、把粒子卡钉重让它按原始 id 产出流，再取消钉重、切回剪辑1 —— 照线上那一刻的状态（就绪索引里有原始 id 的流、剪辑段里的虚拟卡判轻）。

## 缺陷 1、2：父剪辑里摊平出来的粒子卡没判重、没贴流

**结论：不是缺陷。那张卡测出来是轻卡，判轻、活渲符合语义（`product/rendering.md`：剪辑段里的轻卡照常活渲）。**

证据：
1. 线上共享成本记录里有虚拟卡的成本键 `1fbf0198c5c366`：`stepMs 2.3`，`measuredAt` 2026-10-21T00:25:37Z。那时剪辑2 正激活，测的是原始片段；成本键剥掉了 `flat`，所以剪辑1 里的虚拟片段 `k-mvfskg83-2~c-mvhdf6ef-2` 用的是同一条记录，这和设计一致。
2. 本机载入同一份项目（`repro.mjs`），身份表和线上逐字相同：`c-mvfr1yvi-1 → 1555c66fcea3f3`、`k-mvfskg83-2~c-mvfsjn5m-1 → bd7b1294d7720`、`k-mvfskg83-2~c-mvhdf6ef-2 → 1fbf0198c5c366`、`c-mvgz82ix-2 → c2f64141acfd8`。本机测出的完整记录：粒子卡 `stepMs 1.9, catchUpMs 71.5, seekOk true, vtOk true`，按 `clipWeight` 算是 `catchup-b` 档（追帧几拍内补得上），判轻。分派表：0–3 秒 `heavy: []`，三张卡都在 `light`；4–7 秒的 `particles-parallax`（`stepMs 2.9, catchUpMs 104.8`）也判轻。打开在线浏览器模式（`--browser`）、用在线构建（`repro-online*.mjs`）时，`heavy` 同样为 `[]`。所以线上 t=1.5 / 2.5 秒看到 `heavy:[]`、`streams:[]` 是对的。
3. 虚拟 id 没有被 `dropLocalOnly` / `dropUnknown` 丢掉：在线浏览器模式下身份表里照样有它，也测了它（成本记录在）。判重的虚拟卡怎么走（钉重 → 判重 → 进清单计划 → 切分方产 `solo: 'flat'` 流 → 父页发流平面 → 嵌套包裹层贴流），上一轮的 `cut-online-e2e-probe` A～G 已经端到端验过。这次 `repro-online2` 里钉重时原始 id 判重、产流、在线来源认出这条流，34 秒内就绪（`raw stream ready 34163 {"ready":true,"heavy":["c-mvhdf6ef-2"]}`）。
4. 为什么有一条原始 id 的流：云端 Agent 没有成本记录，把写到的卡一律当重卡发布（`render-request.mjs` 文件头）。rev 40 `add_clip` 落地时激活的是剪辑2，摊平视图里没有剪辑段，所以发的是原始 id `c-mvhdf6ef-2`（`agent.render.published rev:40 clips:1`），渲染服务产了 `22e171dd…`。切回剪辑1 的那次写入（rev 41）在 Agent 那边报了超时（见缺陷 5），`ctx.write` 没记上，`render-clips.mjs` 的挑选也就没跑。所以虚拟 id 一直没发布。

**页面要不要把虚拟 id 映射到原始 id 的流键：不做。** 虚拟片段的流键里带着截头 `lead`、剪辑段链 `chain` 和 `mount`，产流的隔离工程是带着剪辑段链的嵌套场景。两者像素只在「段 1:1、不截头、`cutOffset` 0」这种特例里相同，页面判不出这种等价；按键找流是这套机制的前提，在页面上加映射等于绕开它。正确的路是 Agent 切回剪辑1 之后按虚拟 id 再发一次。`render-clips.mjs` 已经支持：它按摊平视图的签名比对，切换激活剪辑以后虚拟片段是新出现的，会被收进去；单测 `render-clips-flat` 和真实任务进程的 AR-11 都覆盖了。缺的只是那次写入在 Agent 侧被当成了失败，由缺陷 5 的修法补上。这条卡判轻，所以就算发了，页面也不会贴（轻卡活渲）。

## 缺陷 3：跳进剪辑段时主线程长任务约 17 秒

**没复现，代码没改。** 同一份项目在三种环境下跳到 1.5 / 5.5 / 2.5 秒，每次录 10 秒（`PerformanceObserver` 的 `longtask`，主文档）：

| 环境 | 1.5 秒 | 5.5 秒 | 2.5 秒 |
|---|---|---|---|
| dev server 桌面模式（`repro.mjs`） | 0 个 | 0 | 0 |
| dev server + 在线浏览器模式（`--browser`） | 0 | 0 | 0 |
| 在线构建 + 本机托管组合 + 跨源双舞台（`repro-online.mjs`） | 0 | 0 | 0 |
| 同上 + 切分方 + 就绪索引里有原始 id 的流（`repro-online2.mjs --desk`） | 0 | 0 | 0 |

- 用 Chrome trace 看了全部三个渲染进程（`longtask-stacks.mjs`）：在线那一组，跳到 1.5 秒后的 10 秒里，编辑器页主线程最长一个任务 109 ms，两个舞台进程最长分别是 75 ms 和 92 ms。dev 那一组最长的是舞台 B 里一次 357 ms 的 `onGlPort`（`StageView.tsx:560`，共享 WebGL 的端口初始化，只在第一次出现）。
- 跳进段里确实会走「整场景后台补跑后互换」（`statefulSegmentsAt`；`swapLog` 里 1.5 秒、2.5 秒各互换一次，`stale: 2`，`ready: true`），每次跳转只换一次，没有反复互换。
- 线上节点 nginx 给 `s1/s2.visuhive.com` 加了 `Origin-Agent-Cluster: ?1`（`curl -sI` 核过），舞台本该在独立进程里。

没复现出来，可能是因为下面几处和线上不同，按可能性排：
1. 用户那台 Chrome 进程数到了上限，同站跨源的舞台被并进了编辑器进程。那样舞台里补跑、活渲粒子的工作就会记在编辑器主线程上。本机探针用的是 `--site-per-process`。
2. 线上那一刻 Agent 正在写（远端改动进来要 `setProject`、重新互换）。
3. 测长任务的工具本身。经扩展、CDP 反复调 `__pcPreviewDiag` 是有开销的，不过它只是读状态。

建议下一步：在线上那台浏览器里用 DevTools Performance 录一段「跳到 1.5 秒」，导出 trace，用 `node scripts/probes/longtask-stacks.mjs <trace> --url-part editor` 看长任务的调用栈；或者在 `chrome://process-internals` 核一下舞台是不是单独的进程。拿到调用栈之后才能对症改。

## 缺陷 4：同一结果键的稀疏版与满密度版并发，稀疏那个推流 ENOENT

**根因**：两个任务 `stream:22e171dd…:0-5:sparse` 和 `…:0-5` 落在同一个流目录 `<库根>/streams/<streamKey>/`（`server/frame-stream.mjs` 的 `StreamStore`）。满密度那一趟写好某一段以后，被它换掉的旧稀疏分段文件过 `REPLACED_DELETE_MS`（5 秒）就删（`storeSegment`）。稀疏任务的推送分两步，先列清单（`collectStreamResult` 读文件、算哈希，只记下「哈希 → 路径」），再推块（`pushResult` → `blobReader` 按路径重读）。列完清单以后推得比 5 秒慢，就读不到第 4 段了。

线上日志对得上：`sink.incomplete … reason push-failed:ENOENT, blocks 7, pushed 6, ms 10070`，满密度任务 0.3 秒后完成（`pushed 7/7`）。

**改法**（`server/artifact-transfer.mjs`）：`collectStreamResult` 读文件算哈希时，把字节一并留在内存里（`files` 存 Buffer），`blobReader` 遇到 Buffer 直接返回，不再按路径重读。推上去的就是列清单那一刻的字节，清单和块始终一致，之后分段被替换、被删都不影响。代价是这一任务范围里的分段和开头文件在推完之前留在内存里（线上这次 7 块共 1.25 MB），这些字节本来就要读一遍来算哈希。快照那一支不变。

**回归测试** `server/test/stream-push-replaced.test.mjs`：
- SPR1：列完清单后删掉一个分段文件，照样推齐 7 块。
- SPR2：列完清单后分段文件换了内容，推的仍是清单里那份。

修之前两条都失败，报错正是线上那两种：`ENOENT … 4-<hash>.m4s`，以及「本机文件在清单之后被改过」。修之后 2/2 通过。

## 缺陷 5：Agent 的 switch_cut 报「project.op 在 15000 ms 内没有回包」，页面上其实切过去了

**查到的**：
- 回包不是页面给的。`project.op` 是 Agent 发给文档服务的提交，回包由文档服务在提交落地后发（`server/docservice/modules/project.mjs` 的 `submitAccount`）；页面只经另一条通道回播放头 `t`，那一步的时限是 10 秒，和这条报错无关。
- 线上项目真身的历史里，rev 41（切回剪辑1）的落地时刻是 00:27:29.002。Agent 发出这次提交大约在 00:26:28 到 00:26:40 之间（上一个工具 `see_frames` 00:26:27 结束，之后还要向页面要播放头），所以从发出到落地大约 50～60 秒，远超 15 秒。
- 同一时段里，渲染服务在为这个项目跑两个流任务（00:26:03 认领，00:27:13～21 收尾），机器负载 `load1 10.32`（8 核）。看画面 `see_frames` 在 00:25:59～00:26:27 也在跑。
- 账号项目的提交要按项目排进有序提交（`password-order.mjs` 的 `locked`），排队前后都要做授权核对，还要找账号服务做见证。日志里没有分阶段的时间，所以说不清这 50 秒卡在排队、授权核对还是见证上。**根因只查到这一步：提交在文档服务里排了约 50 秒；为什么排这么久，现有日志定不了。**

**改法**：
1. Agent 侧（`server/agent/agent-exec.mjs`）：提交等回包超时后，用同一个 opId、同一批 ops 原样重发，最多 4 次，加上第一次一共大约 75 秒。文档服务按 opId 去重：已经落地的回 `project.op.ok`，带 `duplicate: true`；还在排队的，重发的那条排在它后面一起回。所以重发不会落两次（已有测试 `account-op-resend.test.mjs` 覆盖账号项目的重复提交）。重发打日志 `agent.op-resend`，最后成功了打 `agent.op-slow`（带次数和总耗时）。stale 这类拒绝不重发。这样 switch_cut 不再误报失败，`ctx.write` 能记上，`render-clips.mjs` 会按虚拟 id 发布剪辑段里的卡（缺陷 2 的后半）。
2. 文档服务（`server/docservice/modules/project.mjs`）：账号项目的提交从收到到回包超过 5 秒（`SLOW_OP_MS`），记一行 `project.op.slow`，分开记排队多久（进有序提交、调到准备步骤之前，`queuedMs`）和落地多久（`landMs`）。下次再慢，能看出卡在哪一段。这一处只是诊断，不改行为。

**回归测试** `server/test/agent-op-resend.test.mjs`：
- AOR1：头两次超时、第三次回 ok（duplicate），工具成功，三次发的是同一个 opId、同一批 ops，打了 `agent.op-slow`。
- AOR2：一直超时，重发 4 次后照旧报 timeout，一共发 5 次。
- AOR3：stale 不重发。

结果 3/3 通过。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `node scripts/test-suite.mjs`（命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 见下方「全量测试结果」 |
| 相关测试先单跑 | `node scripts/test-suite.mjs server/test/account-op-resend.test.mjs server/test/docservice-project.test.mjs server/test/docservice-project-ops.test.mjs server/test/agent-c65-pagestate.test.mjs server/test/agent-c65.test.mjs server/test/agent-op-resend.test.mjs` | 46 过、0 败，「最终结果：零失败」 |
| 新增单测 | `node --test server/test/stream-push-replaced.test.mjs`、`node --test server/test/agent-op-resend.test.mjs` | 2/2、3/3（也在全量里） |
| 复现（缺陷 3） | 上面四个环境 | 长任务都是 0 个，见缺陷 3 的表 |
| 导出确定性、像素比对 | 没跑 | 不适用：这次没改画面。改的是推送的字节来源（推的字节和清单一致，内容不变）、Agent 提交重发、文档服务诊断日志；没有改舞台、卡片、取帧（`verification.md`「按改动范围验证」） |

端口只用了 29300～29307；没碰 5190～5192；只结束过自己起的进程（探针结束后核过 29300～29320 没有残留的监听）。

### 全量测试结果

`node scripts/test-suite.mjs`（在提交 `1e07ec16` 的代码上跑；之后只改了本报告）：7255 条，7240 过、0 败、0 取消、15 跳过，退出码 0，最后一行「npm test 最终结果：零失败」。

## 部署清单

- **在线前端**：不用换（这次没改 `src/`）。
- **渲染树** `/opt/promptcut-render/releases/<当前>`：换 `server/artifact-transfer.mjs`（缺陷 4），重启 `pm2 promptcut-render`（连同工作进程）。还要换 `server/agent/agent-exec.mjs`（缺陷 5，Agent 主服务和任务槽从这棵树载入）：重启 `promptcut-agent`；任务槽进程每代新开，不用单独重启，但要确认 6 个槽都是 idle 时再换。
- **文档服务树** `/opt/promptcut-v2/releases/<当前>/pc`：换 `server/docservice/modules/project.mjs`（慢提交诊断），重启 `promptcut-doc-v2`，之后按 local.md 的说明对素材服务做一次 `--rotate`。渲染树里的同名文件也一起换，保持两棵树一致。
- **素材服务、账号服务、nginx**：不动。
- 换文件前先 `systemctl show <单元> -p ExecStart` 确认在用的目录；换前备份；重启前确认没有正在写入的客户端，任务槽全部 idle。

## 没做成的与原因

1. 缺陷 3 没复现，没改代码，所以也给不出修前修后的长任务数字。四个本机环境都是 0 个长任务，下一步要线上那台浏览器的 trace（见缺陷 3）。
2. 缺陷 5 只查到「提交在文档服务里排了约 50 秒」，排在哪一段没法从现有日志判断。加了 `project.op.slow` 诊断，下次复现时就能看出来；Agent 侧的重发已经让用户看不到这条误报。

## 对任务书或语义的更正建议

- 任务书说「父剪辑里的重卡」：线上那张 `particles` 卡（数量 100、大小 3）在这台机器上测出来是轻卡（`stepMs` 约 2 ms，追帧约 72 ms，属于 `catchup-b` 档），`particles-parallax` 也是轻卡。验收「剪辑段里的重卡贴流」要换一张真正判重的卡（或者用钉重），不然测的其实是轻卡活渲。
- 任务书第 5 条推测「页面对 switch_cut 的 project.op 回包」：`project.op` 的回包由文档服务发，页面只回播放头（另一条通道，时限 10 秒）。
- 云端 Agent 发布预渲染时把写到的卡一律当重卡（`render-request.mjs`），所以轻卡也会产流，渲染服务白干一些活。这次没改，留给用户决定要不要让 Agent 侧也看成本记录。
