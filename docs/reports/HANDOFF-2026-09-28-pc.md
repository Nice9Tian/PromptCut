# 主会话交接（2026-09-28 第四次，PC →「PromptCut M5～M8 开发交接」）

用户要求主会话从这台 PC 交接给笔记本上的「PromptCut M5～M8 开发交接」会话（下称「新主会话」），PC 主会话随后待命。交接时的处理：
- 交接时正在跑的是第三批后半的 C3（run `m8c3c`）：笔记本辅助节点按用户的收口命令先停了它的主机，C3 没跑完、要整轮重跑（第 2.2 节）；PC 侧随即停了批次脚本、结束了自己起的全部进程，没有再发下一项；第三批后半第 4～9 项已撤回（指令【M8-B3b 改】）。
- 子 Agent 全部做完、结果已收进来；所有 worktree 分支都已推到 origin（`claude/c10a-integ`、`claude/ht-integ` 两个本地副本只落后、不领先 origin，没有要推的）。
- 本文不含令牌、口令；本机信息（SSH 私钥位置等）在各机自己的 `docs/local.md`。
- 代号第一次出现时的白话说明：**E1～E6** 是任务书第 6 节的端到端用例（抢活、断网接手、文档服务重启、Agent 突发修改、纯浏览器节点只见本人任务、两种指纹）；**C1～C5** 是 M8 的五个混沌项；**K1-X / I1-X** 是防锁风暴与频道隔离在真实多端下的复测；**M8-X1～X4** 是各阶段留给 M8 补做的跨机项；**J-全完 / J-恰一 / J-纯层** 是多端项共用的三条判据（全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹）；**G0 / G0-R** 是通用门槛与改到渲染时加跑的渲染附加项。

## 1. 今天已完成并合入 main（main = release = 下方交接提交之前的 `0cabcfb0`）

| 内容 | main 提交 | 报告 / 证据 |
|---|---|---|
| C10 其余 | `51f01c4` | `docs/reports/REPORT-C10.md` |
| M7 纯浏览器节点 | `a52344a` | `docs/reports/REPORT-M7.md` |
| 纯浏览器节点推送提速（两档并行推、推这一帧时先做下一帧） | `5649236` | `docs/archive/agent-reports/AGENT-site-bake-slow.md`；`REPORT-render-queue-m8.md` 第 12a 节 |
| 探针：异地接入的 `--assert-no-lan`、`m8-e-probe` 主机结果行 `idsDetail` | `f550b02` | 同上第 12a 节 |
| 探针：`c10-browser-probe --e6-reverse`（E6 反方向），按 M7 D1 更新两处过时判法 | `42e691c` | `docs/archive/agent-reports/AGENT-m8-e6r.md` |
| 活着、在干活的节点不再被判停滞（进度带工作计数 `step`；主机只在预渲染间空着时认领；收回原因如实下发；逐任务诊断）+ A6 探针时序修正 + 产物库核对素材服务、缺块补推 | `0cabcfb0` | `docs/archive/agent-reports/AGENT-stall-phases.md`、`AGENT-sink-has.md`；契约〔裁〕：`render-queue-contract.md` A.12、`render-host-contract.md` 第 3 节、`artifact-transfer-contract.md` 第 4 节 `has`、`manifest-contract.md` |

`0cabcfb0` 的 G0 与 G0-R（PC）：`tsc` 0；`npm test` 3778 / 3776 / 0 失败 / 2 跳过；`npm run build` 成功；导出确定性 1800/1800；与 PC 基准（`.worktrees/pc-g0r-base`）逐像素 1800 相同；快照重放一致 PASS；`ready-index-probe` `fails []`；`stream-produce-probe --group` PASS；`preview-fallback-probe` 两种透明拍 0。代码版本（`src/` 的 frameCode）自 `5649236` 起是 `21c62981…`，之后只动了 `server/`、探针与文档。

## 2. 进行到一半：M8 多端联调

- **M8 阶段报告**：分支 `claude/m8-report` @ `4d229c3e`（**未合入 main**，只有文档）：`docs/reports/REPORT-render-queue-m8.md` 逐项写了命令、结果、证据、判据，另有第 12a 节「M8 期间合入的修复」、第 10 节远端操作记录、第 13 节〔裁〕与计划/语义冲突。接手后在这个分支上继续填、M8 收尾时合入。
- **全案总报告**：分支 `claude/total-report` @ `fd739f1b`（**未合入 main**，只改 `docs/reports/REPORT-M5-M8.md`）：C10、M7 两节与各汇总表已按两份阶段报告填好（C10〔裁〕29 条、M7 30 条，都待用户审；待用户项 29 条）；M8 部分留了占位（第 0 节、2.10、3.1、3.3、第 4 节、5.1 的 M8 行、5.2 峰值、5.3、6.1～9 与附录 A 的 M8 行、第 10 节、附录 B 的 M8 报告）。起草时查出旧报告十处与现状对不上（例如 `REPORT-C10.md`、`REPORT-M7.md` 文件头仍写「还没合入 main」），记在总报告「骨架里发现的缺口」第四部分，收尾时一并更正。

### 2.1 M8 各项现状（证据位置：`REPORT-render-queue-m8.md` 对应小节）

| 项 | 放法 | 现状 | run |
|---|---|---|---|
| E1 抢活（真实 50 + 假 50） | 云端 | **过**（与同指纹单机重渲 3000 帧逐字节相同；3600 块 sha256 全对） | `m8e1c2` |
| E2 半开接手 | 云端 | **过**（放回 33.9 s、认领 44.1 s）；按字面「≤ 37 s 被认领」的轻负载复跑**过**（放回 34.0 s、认领 34.2 s） | `m8e2c`、`m8e2d` |
| E3 / C2 文档服务重启 | 云端 | **待跑**（留到产物库修复之后，现已合入）：PC 创建者 `--case e3`，收到 KV `m8e.<run>.signal.restart.request` 后在阿里云 `pm2 restart promptcut-hosted`、前后读 `/hosted/healthz`、再 `m8-e-probe --role signal --name restart.done`；笔记本 host-a / host-b `--case e3` | `m8e3c`（预定） |
| E4 Agent 突发 | 云端 | **过**（三轮各 50 次落地、三份摘要逐轮相同） | `m8e4c` |
| E5 纯浏览器节点只见本人任务 | 云端 | M7 阶段的 W7 **过**（`m7w0928e`）；部署提速后站点复测（`m7w0928f`）A1、A2、A5、A7～A10、A12 过，A4 37.4 s（经公网观察项，30 s 门槛以笔记本本机 M7-T1c 27.6 s 为准），A6 失败查明为探针时序（已修）→ **待重跑** | `m7w0928g`（预定） |
| E5 放本机 / M8-X4 浏览器进放本机的项目 | 本机 | **按语义不做**：`product/platforms.md`「在线浏览器模式」只让浏览器进放云端的项目（用户 2026-09-27 定）；原裁定 D6「记待跨机复核」作废（报告第 13 节） | — |
| E6 两种指纹 | 云端 | 首轮核心过、J-全完 19/20；修复后复跑**过** | `m8e6c`、`m8e6d` |
| E6 反方向 | 云端 | **待跑**（本机替身过）：PC `c10-browser-probe --site https://8-219-80-16.sslip.io --e6-reverse --run <id> --base-port 5780`；笔记本 `--role host --run <id> --test-fingerprint 0c10b0e5f1a9e7d2 --port 5583`；判据按〔裁〕：X 对 Y 指纹的细任务认领 0、每张卡只来自一种指纹、J-全完 J-恰一（不计双份键作废的） | `e6r0928a`（预定） |
| C1 断网 30 s（应用层） | 云端 | 首轮**没过**（停滞误判，已修）→ 修复后复跑**过**（`resumed-done`，两台丢认领 0） | `m8c1c`、`m8c1d` |
| C3 数据块受扰 10% | 云端 | **中止、待整轮重跑**（第 2.2 节） | `m8c3c` |
| C5-1 服务器侧切 | 云端 | **过**（云端当主机，掐 nginx 上游，会话接续） | `c10s0928e` |
| K1-X | 云端 | **过**（先报到后锁：稳态 0、竞态 8 ≤ 8；先锁后报到：0 / 0）；过滤关对照（本机）400 | `m8k1a`、`m8k1b` |
| I1-X | 演练实例、主实例 | **过**（跨项目消息 0，投递 5000 = 5000） | `m8i1d`、`m8i1m` |
| 异地接入·假任务 | 云端 | 第一轮成员 0 认领（探针时序：`host` 身份靠 5 s 一次的项目摘要发现任务，创建者节点只晚 1 s）→ **待补跑**，创建者加 `--creator-delay-ms 12000`；第二轮模拟移动网络**过**；两轮 `--assert-no-lan` 都是 0 连接 | `m8xr1b`（预定） |
| 异地接入·真实渲染一轮 | 云端 | **待跑**：`m8-e-probe --case e1 --clips 2 --seconds 10 --no-identical --fake-tasks 0`，笔记本主机加 `--assert-no-lan 192.168.50.96` | `m8xreal`（预定） |
| M8-X2 HT9 | 云端 | **过** | `c10s0928e` |
| M8-X3 C10 外网复验 | 站点 | `c10x0928a` 挂 3 条，都出自旧探针「层表必须是 v 2」（`42e691c` 已改）→ **待重跑**（页面在笔记本 `--site … --base-port 5590`，A5 外部主机另一台 `--role host --port 5783`）；A8 对站点核过（501）；A9 手机路径 `c10a-demo-probe --site` **待跑**；A6、A7、A10 以 C10 阶段本机替身为准 | `c10x0928b`（预定） |
| 换机迁移演练 | 同一台阿里云第二份实例 | **待跑**：命令清单 `node scripts/probes/m8-migrate-probe.mjs --step remote-plan --public-host 8.219.80.16 --stamp 20260928`；A、B 步已做（见第 5 节）；第 9 步用种子项目的 `--step client` 代替「真实编辑器进 E1 项目」，报告里写明 | — |
| 放本机 E1、E2、E4、E6、C3、C1、C5-2、C4（兼 E3）、M8-X1（放本机版 T9） | 本机 | **全部待跑**。**必须 PC 当局域网主机**（PC 局域网地址 192.168.50.96；Node.js 入站在 PC 的公用网络配置下已放行，不用改防火墙）；PC 上起协调口 `probe-coord.mjs serve --host 0.0.0.0 --port 5789`；各探针 `--place lan --lan-ip 192.168.50.96 --coord http://192.168.50.96:5789`，笔记本主机 `--lan-host 192.168.50.96:5780` 兜底，代理 `--proxy-target 192.168.50.96:5780` | — |
| 耗时项（笔记本判） | — | 1080p 分段编码**过**（ENC-1 290 ms、ENC-2 283 ms）；M7-A4 **过**（M7-T1c 27.6 s）；`tiers-probe` T4 三轮**待跑**（笔记本空闲时）；C6.6 T9「改卡后 5 s 内重测」随 M8-X1；C10a L22「新的小尺寸到手机」随 `c10a-demo-probe --site` | — |
| 最终 G0 / G0-R | PC | `0cabcfb0` 全绿（第 1 节）；此后若再改代码要重跑 | — |

### 2.2 交接时在跑的那一项

C3（run `m8c3c`，10:50:38Z 起，PC 创建者 `--case e1 --no-identical --fake-tasks 0`，笔记本两台主机各经代理 `--stall-prob 0.1`）：**中止，没有结果，要整轮重跑**。笔记本辅助节点按用户约 11:05Z 的收口命令，于 11:08Z 强制结束了两台主机与两个代理；PC 侧随后停了批次脚本并结束 C3 创建者的进程树（它起的编辑器 5780～5782、预渲染进程、两个渲染工人），5780～5789 已空出。
- 中止前的现象（接手后复跑时要留意）：两台主机 10:51:02Z 报到（都经代理、指纹 `258acaaa…`），到 11:08Z 一个任务都没领到（主机日志没有 `node.task-*` 行）；PC 创建者日志只有三行——10:50:45 建项目、开旁观连接，11:02:44 开检查连接，之后再无进展。同一版代码的 C1 复跑、E6 复跑里主机都正常认领（C1 复跑 host-a 12、host-b 15），所以要看是 C3 这一例特有（两台主机都经扰动代理，与主机「只在预渲染间空着时认领」的新闸门、项目摘要节拍的相互作用），还是创建者这一侧在发布前卡住。复跑时先看创建者是否发布了 `plan`、PC 节点是否切分，再看主机的 `queue.summary` 与认领。
- 创建者被中止前没来得及删它在阿里云主实例上建的探针项目 `sp_mkprvbql4fc2y4wt47pxb7p4ih`（`m8e-e1-m8c3c`），并进第 5 节的待清理清单。

## 3. 接手后按顺序要做的事

1. 笔记本辅助节点已下线待命，要用它先经用户叫它（它这样要求）。C1 复跑、E6 复跑已写进 `REPORT-render-queue-m8.md`（`claude/m8-report`）；C3 整轮重跑。
2. 放云端余下各项：E6 反方向、异地接入真实渲染一轮与假任务补跑（补跑前重启阿里云上的 `probe-coord` 清掉全局键：它的 KV 只在内存里；**不要**用写 null 的办法清键——值为 null 时带等待的读立刻返回，`take` 会空转）、站点复测 W7（`m7w0928g`）、C10 外网复验重跑、`c10a-demo-probe --site`、E3/C2。命令形状见第 2.1 节与 `REPORT-render-queue-m8.md`。
3. 换机迁移演练（会 `pm2 stop promptcut-hosted`，断开所有在线连接，所以放在放云端各项之后）；做完收回 UFW 8777/8778、`pm2 save`，把真实命令补进 `hosting-migration.md` 第 2 节。
4. 放本机那一串（必须 PC）。
5. 笔记本空闲时段的 `tiers-probe` T4 三轮。
6. 收尾：`REPORT-render-queue-m8.md` 第 0、1、9、11、13 节；合入 `claude/total-report` 并填 M8 部分；更正旧报告十处；把仍在 `docs/reports/` 的 `AGENT-*` 归档到 `docs/archive/agent-reports/`；清理阿里云上留下的探针项目（第 5 节）；最终基线；release 判；播报。

## 4. 待跨机复核、待用户项、待修的性能缺陷

- **待跨机复核**：第 2.1 节里标「待跑」的跨机项；真不同环境指纹的两台机器之间（E6 用的是测试开关与纯浏览器节点两种替代）。
- **待用户项**（总报告第 8 节有全表）：审各阶段〔裁〕（M8 新增：E6 反方向判据、K1 判据改写、E5 放本机与 M8-X4 按语义不做、`render-queue-contract.md` A.12、`render-host-contract.md` 第 3 节、`artifact-transfer-contract.md` 第 4 节 `has`）；`claude/join-error`（`a500c1b9`，新增服务端 `shared/verify` 端点，改了鉴权面，**未合入**，等用户审）；真手机热点（异地接入用替代做法）；真手机扫码与 iOS 导出；D18 语义改动的用户确认记录；另有用户开的独立会话「查 sp-store 测试负载下加载失败」（`server/test/sp-store.test.mjs` 在负载下整份加载失败过一次，我答应它在 PC 空闲时通知它做并发复现）。
- **待修的性能缺陷 / 观察项**：`tiers-probe` T4（「后台上传期间主线程无 > 50 ms 长任务」）要在笔记本空闲时复核，还挂就按性能缺陷修；纯浏览器节点经公网的锚点段 37.4 s（剩下的主要在首段开工前约 17 s：经公网取卡片代码、素材、票据与舞台预热），子智能体另提过两条再提速的路（跨帧流水推送；素材服务单请求推小块——后者改对外接口）。

## 5. 环境现状

- **PC**：main 工作区干净。验收工作区 `.worktrees/merge-test`、`.worktrees/merge-test2` 都在 `0cabcfb0`（分离头）；像素基准 `.worktrees/pc-g0r-base`（`d70fce7`）保留，别删。本会话起的开发服务器、协调口都已停；交接后 PC 主会话待命，不再起进程。
- **笔记本辅助节点**「PromptCut 笔记本辅助测试节点」：**已下线待命**（用户约 11:05Z 下令收口）：不接指令、不跑任何东西、不碰仓库，直到用户明确说恢复；它请新主会话**先经用户再叫它**。检出 `.worktrees/lt-M8` @ `0cabcfb0`（无本地改动，保留）；它那边的主工作区 main 停在 `ddfb766`（干净，未跟上）；它起的进程已全部结束，5580～5599 无监听。结果文件都在笔记本本机它的 scratchpad 下（`m8b3b\{c1d,e6d,c3c}` 与之前各批 `m8b1`、`m8b2`、`m8b3a`、`m8e1c`、`m8e1c2`、`w7l1`、`m7t1*`、`c10t1`、`enc1`、`enc2`、`t41`、`t42`、`t9x1～t9x3`、`v1`）。
- **指令与回执**：M8-B3b 的回执已收到（第 1 项 C1 复跑、第 2 项 E6 复跑两台都 `ok true`，C1 受害方被扣的任务由它自己在恢复后完成、会话未断、两台 `node.task-*` 行里没有丢认领与失败；第 3 项 C3 中止；第 4～9 项没起、已由【M8-B3b 改】撤回）。**没有已发未回执的指令**（笔记本、云端都没有）。
- **云端**「PromptCut M5～M8 云端工作节点」：空闲；最后一条指令 W7-4（to-cloud 第 23 条）已回执（to-local 第 27 条：退出、失败——云端出站代理不支持 WebSocket 升级，当不了纯浏览器节点，早已知的限制，HT-b 的理由）；没有未回执的指令。交接时另发一条通知（to-cloud 第 24 条，见文末）。
- **信箱**：to-local 已处理到第 27 条；to-cloud 最后一条是本次交接通知。
- **阿里云 `8.219.80.16`**：
  - `promptcut-hosted` online，服务端 `0cabcfb0`（10:28Z 部署，epoch `f34a127c…`，重启计数 15），编辑器 `/editor/` 给 `index-Cp2h7djI.js`（代码版本 `21c62981…`），两个舞台子域照旧；
  - `promptcut-drill`（演练实例，8777 / 8778）online，服务端 `0cabcfb0`，**数据目录是空的**（只有从主实例拷来的集群令牌文件）；旧的 HT 第 1 版演练数据挪到了 `/var/lib/promptcut/drill.old-20260928-m8`；**UFW 临时放行了 8777 / 8778**（注释 `m8-drill 20260928`），迁移演练做完要删；
  - 备份：两份 `pm2.config.cjs.bak-20260928-m8`、`~/.pm2/dump.pm2.bak-20260928-m8`；nginx 今天只加过 `/catalog/`（备份 `*.bak-20260928-catalog`）；
  - `probe-coord` online（今天没重启过；KV 只在内存里）；
  - 主实例上留着的探针项目：`sp_2zepiwyualirjjkb3eq2zumiwu`（`m8e-e1-m8e1c2`，迁移演练用）、`sp_psdnztznqf4t6nnlsz5ljqikcu`（`m8e-e1-m8e1c`）、`sp_mkprvbql4fc2y4wt47pxb7p4ih`（`m8e-e1-m8c3c`，C3 中止时留下）、`m7ap-m7w0928a`、`m7ap-m7w0928b`、`m7ap-m7wlocal1`，演练后清理。
- **在途分支**（都已推 origin；已合入 main 的不再列）：`claude/m8-report` @ `4d229c3e`（M8 报告）、`claude/total-report` @ `fd739f1b`（总报告）、`claude/join-error` @ `a500c1b9`（待用户审）。已合入、可以收起的：`claude/site-bake`、`claude/m8-nolan`、`claude/m8-e6r`、`claude/stall-phases`、`claude/sink-has`、`claude/m7-a6-race`。
