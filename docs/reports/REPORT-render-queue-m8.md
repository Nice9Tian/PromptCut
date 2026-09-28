# M8 阶段报告：多端物理联调

状态：**骨架**（2026-09-28，由 PC 主会话「PromptCut 主会话（PC）」派出的子智能体起草，只写文档）。每项留「命令 / 结果 / 证据 / 判据」四栏：命令写的是 `m8-plan.md` 里的命令形状（端口、地址以跑时为准，令牌只从环境变量取、不进命令行与输出），判据照 `m8-plan.md` 与主计划第 7 节 M8 抄录，结果与证据待填。全案总账见 `REPORT-M5-M8.md`（主会话裁定 D8：两份报告）。

- **依据**：主计划 `Master-Execution-Plan.md` 第 6.5 节 W8、第 6.8 节、第 7 节 M8、第 8 节；M8 执行计划 `m8-plan.md`（分支 `claude/m8-plan` `9f13055`，含主会话对 D1～D12 的裁定与预检结果）；任务书 `TASK-distributed-prerender-queue.md` 第 6 节；`hosting-migration.md`；`http-transport-contract.md` 第 11 节；`m7-contract.md` 第 10 节；`c10-contract.md` 第 13、18、20 节。
- **代号**：E1～E6、K1、I1、G0 / G0-R、W8、待跨机复核、待用户项的白话说明见 `REPORT-M5-M8.md` 的代号表；本文新出现的：
  - **J-全完 / J-恰一 / J-纯层**：所有多端项共用的三条判据——发布的任务全部完成；每个任务恰好一次 `task.done`（按 epoch 数，裁定 D3）；没有一层混了两种指纹（`m8-plan.md` 第 2 节开头）。
  - **K1-X / I1-X**：K1、I1 在真实多端环境下的复测。
  - **M8-X1～X4**：各阶段留下、归进 M8 补做的跨机项（`m8-plan.md` 第 2.4、3.1 节）。
  - **C1～C5**：M8 的五个混沌项（`m8-plan.md` 第 2.6 节）。
  - **P-C1 / P-C3**：两项预检（`m8-plan.md` 第 4 节）。

## 0. 结论

〔待填：M8 验收是否全过；没过的项、原因、按回退梯次走到哪一级；哪些仍待跨机复核或待用户。〕

## 1. 前置、环境与握手

### 1.1 前置核对（主计划第 6.5 节 W8：「M6～M7 全部合入之后」）

| 前置 | 现状（main `c718be6`，2026-09-28） | 合入提交 | 证据 |
|---|---|---|---|
| C10 其余合入 main 并部署阿里云 | 未合入（`claude/c10-integ` `24c2c57`） | 待填 | 待填 |
| M7 合入 main 并部署 | 未合入（`claude/rq-m7-node`、`claude/rq-m7-queue`、`claude/rq-m7-tests`、`claude/m7-probe` 在做） | 待填 | 待填 |
| 1080p 分段编码在笔记本过线（L20） | `claude/perf-encode` `7cbf70a`，合入 main `211695d` | 过：笔记本 ENC-1 修复版 p50 中位数 290 ms（main 403）、ENC-2 合入后 283 ms，五轮 fails []、字节不变 | 笔记本回执（主会话记录，2026-09-28） |
| 进跨机前必须合入的遗留：L10、L16（`claude/eol-eperm`）、L17（已合 `96e69cb`）、L1（已合 `ceab9e4`）、L4、L5（`claude/card-overlay`） | 见左 | 待填 | 待填 |
| L14 `server/card-sync.mjs` 接会话层（裁定 D9） | `claude/m8-session-legacy` 在做 | 待填 | 待填 |
| 探针分支 `claude/m8-kit`、`claude/m8-e2e`、`claude/m8-scale`、`claude/m8-migrate` | `m8-kit`、`m8-migrate` 已开；`m8-e2e`、`m8-scale` 未见分支 | 待填 | 待填 |

### 1.2 参与方与代码同步

| 机器 | 角色 | 提交（`git rev-parse HEAD`） | node / Chrome / 指纹 | 端口 |
|---|---|---|---|---|
| PC（主会话） | 创建者、发布方、PC 节点、放本机的项目的局域网主机、阿里云管理员 | 待填 | 待填 | 5780～5789（`m8-plan.md` 第 1.3 节，待主会话核对） |
| 笔记本（辅助测试节点，性能基准机） | 独立渲染主机、第二成员、纯浏览器节点、断网受害方、耗时项 | 待填 | 待填 | 5580～5599 |
| 阿里云 `8.219.80.16` | 托管组合 `promptcut-hosted`；信箱与协调口 `probe-coord`；演练实例 `promptcut-drill` | 部署提交待填 | — | 8787 / 8788；演练 8777 / 8778 |

### 1.3 握手

〔待填：笔记本报到（能力、权限模式、提交）与主会话回执，主计划第 6.4 节。〕

## 2. E1～E6（放云端一遍、放本机经局域网直连一遍）

- 放云端：项目建在阿里云主实例；PC 起编辑器（队列模式，以创建者、`role: 'render'` 进入）当发布方与 PC 节点；笔记本起 1～2 个独立渲染主机与旁观节点。
- 放本机：PC 以局域网主机起编辑器（`PROMPTCUT_LAN_HOST=1`），笔记本经组播发现后凭项目凭证进入。另加一条判据：托管端 `/healthz` 连接计数前后不变。**必须 PC**，笔记本不在线时本项停住等（主计划第 6.8 节例外条）。
- E2、E3 与混沌项共用场景：跑一次，两处引同一份证据。

### E1 抢活

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端（真实任务） | PC：`node scripts/probes/m8-e-probe.mjs --role creator --place cloud --case e1 --hosted <托管地址> --coord <协调口> --port 5780 --timeout-min 120`；笔记本：`--role host --name host-a --port 5583`、`--name host-b --port 5586` | **过**（run `m8e1c2`，2026-09-28 07:05Z 起，用时 57.7 min）：真实细任务 50 个全完，认领 PC 6、host-a 22、host-b 22；三方代码版本 `ddf69b5e184c`、指纹 `258acaaa7c5fe509` 一致 | 创建者结果行 `ok true fails []`：`real:J-all-done` 50/50；`real:J-exactly-once` total 51（含 `plan`）、dup []、missing []、stray 0，单一 epoch；`real:J-pure-layers` 10 层、观测 100、mixed []；`real:artifacts` 清单 50、数据块 3600、206 826 100 字节、badBlocks []（逐块 sha256 相符）；`real:identical-to-single` 3000 帧 differentFrames 0、`identicalBytes true`；`kv-no-401`。项目保留 `sp_2zepiwyualirjjkb3eq2zumiwu`（`m8e-e1-m8e1c2`，迁移演练用） | J-全完、J-恰一、J-纯层；三方各认领 ≥ 1；产物在阿里云 `/media` 按清单逐段取回、sha256 相符；与同指纹单机重渲逐字节相同（`identicalBytes`） |
| 放云端（假任务 50 个） | 同一次运行里 `m8-e-probe` 的假任务一轮（`signal.fake.start`，与 `render-queue-e2e.mjs` 同一种假任务） | **过**（同上 `m8e1c2`） | `fake:J-all-done` 50/50；`fake:J-exactly-once` total 50、dup []；`fake:J-pure-layers` 10 层 mixed []；`fake:each-worked` 三个节点都领到、合计 50 | `completed 50`、`duplicateDone 0` |
| 放本机 | 同上，`--place lan` | 待填 | 待填 | 同上；产物在 PC 的素材服务；托管端连接计数不变 |

### E2 断网接手（半开）

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | 笔记本：`m8-e-probe.mjs --role host --case e2 --via-proxy 5596 --proxy-target 8.219.80.16:8787`；持有任务后往代理写 `stall`（`render-queue-proxy.mjs` 的 `stall`、`resume` 在 `claude/m8-kit`）；PC 同上 `--role creator --case e2` | **过**（run `m8e2c`，08:03Z 起，15.7 min）：host-a 第一次持有任务即 stall，被扣住的任务 **33.9 s 放回**、**44.1 s 被别的节点认领**；30 个细任务认领 PC 3、host-a 12、host-b 15 | 结果行 `ok true fails []`：`stall-signal`；`reopened<=37s` reopenMs 33 872；`taken-over` 44 095 ms；`victim-old-claim-void`（旧认领作废）、`victim-no-double-done`；`e2:J-all-done` 30/30；`e2:J-exactly-once` total 31、dup []；`e2:J-pure-layers` 6 层 mixed []；受害方会话 `kind: unchanged`（stall 不断 TCP，靠租约到期回收）。认领晚于放回约 10 s，是因为另外两个节点的槽位都在做 60 帧的长任务；按计划字面「≤ 37 s 被认领」在别的节点有空时的轻负载复跑见下一行 | 被扣住的任务 ≤ 37 s 被另一节点认领；笔记本恢复后旧令牌 `complete` 回 `lease-lost`；J-全完、J-恰一、J-纯层。探针把它拆成「放回 ≤ 37 s（判）」与「被认领（记）」两条（`AGENT-m8-e2e.md` 第 5 节第 2 条），本报告两条都给 |
| 放云端（轻负载复跑，按字面判「≤ 37 s 被认领」） | 同上，PC 加 `--clips 1 --seconds 10`（5 个任务）；笔记本 host-b 加 `--host-concurrency 4`，让任务被放回时别的节点有空槽 | **过**（run `m8e2d`，09:24:29Z 起，2.6 min；main `5649236`，代码版本 `21c62981…`）：被扣住的任务 **34.0 s 放回、34.2 s 被 host-b 认领** | 结果行 `ok true fails []`：`reopened<=37s` reopenMs 33 986、`taken-over` 34 177 ms；`e2:J-all-done` 5/5、`J-exactly-once` total 6（含 `plan`）dup []、`J-pure-layers` 1 层 mixed []；`victim-old-claim-void`、`victim-no-double-done`（completedHeld []）；host-a 认领 1、失败 1（扣留期间取项目快照 30 s 超时，按预期不算）、resumes 1；host-b 认领 4、完成 4；PC 1 | 同上 |
| 放本机 | 同上，`--proxy-target <PC 局域网地址>:<端口>` | 待填 | 同上 | 同上 |

### E3 文档服务重启

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | 同第 7 节 C2（`pm2 restart promptcut-hosted`）；`m8-e-probe.mjs --case e3 --place cloud` | 待填 | 重启前后 `/healthz` 的 epoch；各节点 `stats` | epoch 变了；J-全完、J-恰一（按 epoch 数）；重启前已完成的任务重启后执行器渲染 0 次（`stats.dedup`） |
| 放本机 | 同第 7 节 C4（重启 PC 局域网主机编辑器，裁定 D2 合并） | 待填 | 同上 | 同上 |

### E4 Agent 突发修改

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | `m8-e-probe.mjs --case e4 --burst 50 --gaps 0,200,900`（`agent` 角色连项目、`project.commit` 带期望版本；笔记本另开成员页面只看）；PC `--role creator --case e4 --hosts host-a`，笔记本 `--role host --name host-a --case e4` | **过**（run `m8e4c`，08:36:55Z 起，20.3 min）：三轮各 50 次全落地；每轮三份摘要相同；后台 50 个细任务全完成，认领 PC 7、host-a 43 | 结果行 `ok true fails []`：间隔 0 / 200 / 900 ms 三轮 `all-landed` 50/50，`three-digests-equal` 文档服务、PC 副本、笔记本副本 = `93f7e51c…` rev 249 / `d5345714…` rev 546 / `59f267a1…` rev 986；`stale-exercised` 196 / 191 / 138 次（每次重读后重写）；`background-not-starved` 突发期间完成 2 / 3 / 6 个；`background:J-all-done` 50/50、`J-exactly-once` dup []、`J-pure-layers` 10 层 mixed []；host-a stats：认领 43、完成 41、去重 2、失败 0、丢认领 0。「页面」是按页面同一条协议维持的 Node 副本（`project.open` + 逐版应用 `project.ops`，同一个 `applyOps`、同一摘要算法），不是浏览器页面（`AGENT-m8-e2e.md` 第 5 节第 6 条） | 每轮结束文档服务、PC 页面、笔记本页面三份项目 sha256 相同；`stale` 重读重写、50 次都落地；突发期间至少完成 1 个细任务，结束后 J-全完 |
| 放本机 | 同上，`--place lan` | 待填 | 同上 | 同上 |

### E5 纯浏览器节点只见本人任务

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | `scripts/probes/m7-browser-probe.mjs` 的站点模式（W7 同法）：PC `--role creator --site https://8-219-80-16.sslip.io --run <id> --node-wait-s 2400`；笔记本 `--role node --site … --run <id> --timing-authoritative`（笔记本 Chrome 当成员 B 的纯浏览器节点） | **A1、A2 过；A3 服务端那半在外网模式看不到认领者，由节点侧 `page-forbidden-claimed-0` 判**：M7 阶段的 W7（run `m7w0928e`，旧代码 `ddf69b5e…`）跨机过；部署推送提速之后复测（run `m7w0928f`，09:36Z，代码 `21c62981…`）：A1、A2、A5（笔记本计时）、A7、A8、A9、A10、A12（笔记本计时）、D1-D2-D12、D9、D10、D14 过，A3、A11 按外网模式记待定（看不到托管端的认领者与日志）；A4 与 A6 见下。**站点复测第 2 轮**（run `m7w0928L`，2026-09-28T12:03:14Z～12:26:11Z，第五次修订后 PC 待命：创建者 `--role creator --site … --node-wait-s 2400 --base-port 5780` 与成员 B 的节点 `--role node --site … --timing-authoritative --base-port 5760` 都在笔记本上，main `29e6e837`）：A1、A2、A3（节点侧 `page-forbidden-claimed-0`）、A5、**A6**（上一轮挂在探针时序、修后这轮过）、A7、A8、A9、A12、D9、D10、D14、D1-D2-D12 过；A10 的「空闲接手」过（锁移到 PC 指纹、页面层换过去、ready 61，用时 218 s）；**没过的两处都是慢**：① A4 最慢锚点段 33.3 s（经公网，笔记本判；上一轮 37.4 s），另 3 层到判的那一刻还没有浏览器产的帧（`page-layer-env-browser`：h1 ready 60、h2 / h3 / light 仍是 PC 指纹的主候选 ready 0）；② A10「两份任务谁先谁得卡、每张卡只出自一种环境」：加的两张卡 w2 由浏览器节点做完（`258acaaa…`），w1 在探针等的 300 s 里谁都没做完，于是记失败——同一台笔记本上同时跑创建者的 PC 节点（刚接手重渲整张 z1）与浏览器节点，软件渲染排不开；**没有一张卡混两种环境**。〔裁〕A4 照 M7 验收口径记经公网的观察项（30 s 门槛以笔记本本机 M7-T1c 27.6 s 为准）；A10 的站点通过证据以 `m7w0928f`（PC 创建者、笔记本节点，过）为准，这一轮的超时记单机负载下的现象；W7 的真跨机（D17）仍待复核：云端的无头 Chromium 过不了它的代理的 WebSocket 升级（W7-4），当不了成员 B 的浏览器 | 创建者结果行（`items` 逐项）；笔记本 M8-B3a 回执（待填）。**A6「更急的活在帧边界让路」这一轮没过**（`framesAfter 60`、没有释放）：查明是探针时序——节点认领一到手先报一条 done 0，探针见到就触发，而这时后台舞台上还没在生成，测量直接做完、没有东西可让；同一代码在本机替身（含压 76 ms）与旧代码的站点首轮都过。探针改为等这一段真的出过帧（done ≥ 1）再触发（`claude/m7-a6-race`），复跑待填。**A4** 最慢锚点段 37.4 s（旧代码同法 63 s）：首段从闸门放开到完成 23.7 s，其后两段各约 7 s（每帧 p50 95 ms），剩下的超出在首段开工前约 17 s（经公网取卡片代码、素材、票据与舞台预热），按 M7 验收口径（30 s 门槛在笔记本本机判，M7-T1c 27.6 s 过）记为经公网的观察项 | M7-A1、A2、A3：同项目另一成员的任务收到 0 条、认领 `forbidden`；同名不同设备同样挡住 |
| 放本机 | 同上，`--place lan`；前提是浏览器能进放本机的项目（M8-X4） | **按语义不做**（2026-09-28 主会话更正裁定 D6）：`product/platforms.md`「在线浏览器模式」（用户 2026-09-27 定）写明「只加入……项目只能是放云端的多用户协作项目」，浏览器进放本机的项目不是一期承诺的能力，纯浏览器节点也就不会出现在放本机的项目里。原裁定 D6「记待跨机复核」等于推到 M8 之外，与主计划第 10 节「不得缩小范围」对不上；按「语义优先」改为不做，见第 13 节 | — | — |

### E6 两种指纹

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端（测试开关） | `m8-e-probe.mjs --case e6`；笔记本 `--role host --fake-fingerprint <16 位十六进制>`（设 `PROMPTCUT_TEST_ENV_FINGERPRINT`，开关在 C10 集成分支的 `server/frame-pipeline.mjs`）；实际 PC `--role creator --case e6 --hosts host-a`，笔记本 `--fake-fingerprint e6f00d00e6f00d00` | **核心判据过、J-全完差一个**（run `m8e6c`，08:57:33Z 起，19.2 min）：指纹 `e6f00d00e6f00d00` 的主机认领 0（`other-fingerprint-claimed-0-host-a` claimed 0、ids []，主机侧 `fingerprint.applied true`）；`e6:J-pure-layers` 4 层、观测 39、mixed []；但唯一能做这一版的 PC 节点有 1 个任务 `32c612…:120-179` 满 3 次尝试后永久失败，`e6:J-all-done` 19/20、`J-exactly-once` missing 1。PC 节点一次只认领 1 个（不排队），那段时间 PC 上另有两个子智能体在跑测试与本机替身；与 C1 同一类（停滞误判，`claude/stall-phases`）。**修复后复跑全过**（run `m8e6d`，10:38Z，main `0cabcfb0`，11.7 min）：`other-fingerprint-claimed-0-host-a` claimed 0（`e6f00d00e6f00d00`）；`e6:J-all-done` 20/20（全部由 PC 节点完成）、`J-exactly-once` total 21 dup []、`J-pure-layers` 4 层 mixed [] | 创建者结果行（`fails` 2 条）；笔记本 M8-B1 回执（host-a stats 全 0、`envFingerprint e6f00d00e6f00d00`） | 指纹 Y 的主机对这一版细任务认领 0；J-全完、J-纯层；反方向（笔记本主机先认领按清单发布的 plan）再一遍 |
| 放云端（反方向：Y 先认领页面发布的清单 plan；**真不同环境**，云端当 Y） | 笔记本：`c10-browser-probe.mjs --site https://8-219-80-16.sslip.io --e6-reverse --run e6r0928L --base-port 5780 --host-wait-min 30`（页面、创建者桌面版，X 的两种节点：协议层 claimer 与真独立渲染主机，都是笔记本的真实指纹 `258acaaa7c5fe509`）；云端（指令 E6R-1，`to-cloud` 第 26 条）：`c10-browser-probe.mjs --role host --run e6r0928L --port 5425`，不用测试开关，真实环境 Linux、Chromium 141，指纹 `0326290ea8e62e3d` | **过**（run `e6r0928L`，11:42:58Z～11:58:19Z，15.4 min，main `29e6e837`，代码版本 `21c62981…`）：Y 在 X 上线前认领了页面这一版的清单 plan（`plan:…@11#clips:…`），按自己的指纹切分；X 的协议层节点对要求 Y 指纹的细任务试认领 9 次，9 次都被拒（`fingerprint-mismatch`）、认领 0；X 的真主机同时在线，同样 0 | 页面结果行 `ok true fails []`，`steps.e6r` 九条全过：`Y-claimed-plan`（Y 的持有记录里有这个 plan，认领早于 X 上线）；`derived-fingerprints` 17 个细任务 = Y 自己那份 5 个 + M7 D1 双份 Y/dual 6 个 + 页面/dual 6 个，没有别的；`X-online-while-work`（X 上线后还有 11 个完成）；`X-claimed-0`（claimer 9 次尝试全是 `fingerprint-mismatch`）；`J-all-done` 11/11（作废的 6 个全是 dual）；`J-exactly-once` total 12、dup []、missing []、单一 epoch；`J-pure-layers` 3 层、mixed []（Y 做 10、页面 1）；`layer-map-covers-done` v 3、3 张卡全覆盖、主指纹全是 Y；`X-differs-from-Y`。L18：桌面发布的 plan 对 host 档回 `plan-profile`（只记录）。云端回执（`to-local` 第 30 条）：HEAD `29e6e837`、退出码 0、`ok true fails []`，认领 11（plan + 10）、完成 10、丢认领 0、失败 0、传输 ws、opens 1、resumes 0、代码版本 `21c62981…`，主机环境没有 ffmpeg 照常做完 | 同上（〔裁〕E6 反方向判据，见第 13 节）。这一轮补上了「真不同环境指纹的两台机器之间」这一项（原先只有测试开关与纯浏览器节点两种替代） |
| 放云端（纯浏览器节点当第二种指纹，裁定 D12） | M7 合入后 | 待填 | 同上 | 同上 |
| 放本机 | 同上，`--place lan` | 待填 | 同上 | 同上；另记桌面 plan 领不到环境不同的主机的现象（L18） |

## 3. K1、I1 真实多端复测

| 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| K1-X 实验组 | PC：`node scripts/probes/m8-scale-probe.mjs --role coord+nodes --place cloud --case k1 --workers pc,laptop --fingerprint X --nodes 4 --tasks 200 --order join-first\|lock-first`；笔记本：`--role worker --place cloud --case k1 --name laptop --fingerprint Y --nodes 4`（经阿里云主实例） | **过**，两种顺序各一轮（main `5649236`）：`join-first`（run `m8k1a`，09:20:41Z）稳态拒绝 **0**、竞态 8（上限 8）、窗口最长 252 ms；`lock-first`（run `m8k1b`，09:22:09Z）稳态 **0**、竞态 **0** | 结果行 `ok true fails []`：两种指纹 PC `a631efc4…` ×4、笔记本 `9d4b6e87…` ×4；`K1-card-locked` join-first `{steady 0, race 8, raceLimit 8, claims 154, raceWindowMsMax 252}`、lock-first `{steady 0, race 0, raceLimit 0, claims 146}`；`K2-opened-mismatch` 0（两轮）；`K1-dead-never-claimed` 0；`J-all-done` 100/100、`J-exactly-once` dup []、`J-pure-layers` 20 层 mixed []（两轮） | 〔裁〕（`m8-plan.md` 第 2.2 节，2026-09-28 主会话改）：稳态 `card-locked` 拒绝 0（硬）；竞态窗口内的拒绝 ≤ 本轮节点总数（硬，每个节点同时只有一条认领在路上）；`lock-first` 稳态 0、竞态 0；不匹配节点收到已锁卡 `task.opened` 0 条；结论与本机一致（M5b：过滤开 0、过滤关 400，`REPORT-render-queue-m5b.md` 第 1 节）。原文「竞态 ≤ 认领总数 1%」来自 M5b 时钟不推进的单进程场景，跨机有天然的传播窗口，200 个任务时只容 1 次 |
| K1-X 对照组（过滤关） | 在 PC 本机跑（裁定 D4）：`node scripts/probes/m8-scale-probe.mjs --role all --case k1 --prefilter off` | **有基数**（09:27Z 后，本机替身）：`card-locked` 拒绝 **400**（稳态 398、竞态 2）、认领 506 次；不匹配节点收到已锁卡 `task.opened` **400** 条；关过滤的钩子生效（`prefilter-off-hook-applied`） | 结果行 `ok true fails []`；与 M5b 本机「过滤关 400」一致 | 数字写进报告作基数 |
| I1-X 先在演练实例 | PC：`m8-scale-probe.mjs --role coord+nodes --place cloud --case i1 --workers pc,laptop --hosted http://8.219.80.16:8777 --projects 1-10 --sample`；笔记本：`--role worker --place cloud --case i1 --name laptop --projects 11-20` | **过**（run `m8i1d`，09:22:41Z，演练实例 = 当前 main 的服务端代码） | 结果行 `ok true fails []`：节点 PC 100、笔记本 100，20 个项目全覆盖；`I1-no-cross-project` 非 A 节点 190 个收到 A 的消息 0、任务消息 0；`I2-delivery-equals-watchers` 500 个任务 × 10 条 watch A 的连接，`task.closed(done)` 实际投递 5000 = 应投递 5000，没有少投、没有合并掉；`J-all-done` 500/500、`J-exactly-once` dup []。资源（每 15 s 采一次，运行十几秒只采到 2 个样本）：`promptcut-drill` 内存峰值 120 MB、CPU 峰值 12.8%、重启 0；eth0 17 s 里出 4.9 MB、进 1.0 MB；可用内存最低 900 MiB，负载 0.08 | 非 A 的节点收到 A 的消息 0 条；每条增量投递次数 = 能看见它的连接数（I2 顺带） |
| I1-X 主实例 | 同上，不带 `--hosted`（run `m8i1m`，09:23:36Z） | **过** | 同上各项相同（节点 100 + 100、跨项目 0、投递 5000 = 5000、500/500）；`promptcut-hosted` 内存峰值 119 MB（采样峰值 124.8 MB 含其它时刻）、CPU 峰值 16.6%、重启次数不变（14）；eth0 18 s 里出 5.8 MB、进 1.1 MB | 同上 |

## 4. 异地接入托管（替代「笔记本在手机热点下」，裁定 D11 算过）

| 步 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 关掉局域网路径 | 应用层：成员端 `--assert-no-lan 192.168.50.96`（main `f550b02` 新加，公共件 `scripts/probes/m8/no-lan.mjs`：每 2 s 只读地跑 `netstat -an` 数本机到 PC 局域网地址的 TCP 连接，收尾前 3 s 局域网发现，`tcpOk`、`discoveryOk` 分开判；单测 `server/test/m8-no-lan.test.mjs`）；另让笔记本收尾时只读地跑 `Get-NetTCPConnection` 计数（约束「不动宿主机的网络」，不改防火墙） | **做到**：两轮成员 `noLan` 都是到 PC 局域网地址的 TCP 连接 0（采样 4 次 / 5 次）、局域网发现 0 条（1 块网卡、发 6 次查询）。PC 上对照：同一个函数对阿里云地址数到 46 条连接，计数确实看得到真连接 | 结果行 `noLan` 原样见下两行；笔记本只读的 `Get-NetTCPConnection -RemoteAddress 192.168.50.96` 计数：第一轮跑前 0、跑后 0，第二轮跑后 0（M8-B3a 回执） | — |
| 假任务一轮 | PC：`node scripts/probes/shared-project-probe.mjs --mode internet --role creator --hosted https://8-219-80-16.sslip.io/hosted --coord https://8-219-80-16.sslip.io/coord --tasks 6`；笔记本：`--mode internet --role member --hosted https://8-219-80-16.sslip.io/hosted --coord … --expect-tasks 1 --assert-no-lan 192.168.50.96` | 首轮（09:33:30Z，PC 创建者、笔记本成员）**没过判据，原因在探针时序**：成员进入、读取、只走公网都过——不设集群令牌、凭项目凭证 443 ms 进入、读快照（rev 1）、内容库、带票据读素材（Bearer 与查询串都行、不带票据 401、`loopbackTrusted false`）、`noLan` tcp 0 / 发现 0；但成员认领 0，6 个任务全被创建者自己的节点做完（成员是 `host` 身份，按 M6c X3 只靠每 5 s 至多推一次的 `queue.summary` 发现新项目的任务，创建者节点只晚 1 s 开领）。**补跑过**（2026-09-28T12:00:29Z～12:00:54Z，第五次修订后：笔记本创建者 `--tasks 6 --creator-delay-ms 12000`；成员由云端当——真在另一张网上、只能经代理出网，指令 RMT-1，`to-cloud` 第 27 条；补跑前在阿里云 `pm2 restart probe-coord` 清掉上一轮的全局键，信箱落盘不受影响）：成员 `clusterToken unset`，凭项目凭证 1464 ms 进入；读快照（rev 1）、内容库、带票据读素材都过（不带票据 401、`loopbackTrusted false`）；认领 6、完成 6，6 个任务各恰好一次（`duplicateDone 0`、创建者节点 0）；会话 ws、opens 1、resumes 0 | 补跑的创建者结果行 `ok true fails []`：`tasks {published 6, completed 6, duplicateDone 0, byCreatorNode 0}`；成员结果（云端回执 `to-local` 第 31 条，HEAD `29e6e837`、退出码 0）`ok true fails []`、`claims 6`、`taskDone 6`、`media {bearer true, query true, noTicket 401, loopbackTrusted false}`、`ticket {rw true, r true}`。`artifactsWritten 0`：这几段的产物按内容寻址早已在阿里云素材服务里（探针的结果键固定为 `sp-probe-project@1`，历次运行同键），成员的产物库先问素材服务 `has` 为真、走去重完成，没有重推——产物确实落在阿里云素材服务上。首轮结果行 `fails ["成员结果 ok :: 完成至少 1 个任务（实际 0）"]`。云端没有到笔记本局域网的路（不同的网），`--assert-no-lan` 不适用、没加 | 笔记本不设集群令牌、凭项目凭证经 443 进入；每个任务恰好一次 `task.done`；产物在阿里云素材服务；全程没有局域网连接 |
| 真实渲染一轮 | `node scripts/probes/render-host-probe.mjs --hosted …` 或 `m8-e-probe.mjs --case e1` | **过（由云端当远程成员）**〔裁：原命令要笔记本当远程成员、PC 当创建者；PC 待命，第二台机器只有云端。桌面发布的 plan 按 X4 与指纹要求领不到环境不同的主机（L18），所以远程成员认领真实渲染任务只能走在线页面发布的带清单 plan（C10 契约第 18 节第 9 条）〕：云端（只能出网、不设集群令牌、凭项目成员凭证经 443 进入）三轮认领并完成了真实的预渲染细任务，产物推到阿里云素材服务、页面从那里取回换上：M8-X2（run `c10s0928e`，认领 3、完成 1）、E6 反方向（run `e6r0928L`，认领 11、完成 10、丢认领 0、失败 0，页面换上它产的新层 ready 55） | 各轮结果行见第 2 节 E6 反方向与第 5 节 M8-X2、M8-X3；云端回执 `to-local` 第 30 条（E6R-1）：`ok true fails []`、传输 ws、opens 1、resumes 0、`assetBase https://8-219-80-16.sslip.io/media/api/asset` | 同上 |
| 补充：模拟移动网络 | 笔记本经 `render-queue-proxy.mjs --listen 127.0.0.1:5598 --target 8.219.80.16:8787 --delay-ms 150 --stall-prob 0.05` 连文档服务（素材服务仍走登记的 443 地址）；成员 `--hosted http://127.0.0.1:5598 … --assert-no-lan 192.168.50.96`；PC 在两轮之间重启协调口进程清掉全局键（协调口的键只在内存里；写 null 清不掉：值为 null 时带等待的读立刻返回，`take` 会空转），再写放行键 `m8x.remote.r2.go` | **过**（09:35:38Z）：成员经代理 908 ms 进入，认领 1、完成 1；6 个任务各恰好一次（创建者节点 5）；读取各项同第一轮；`noLan` 采样 5 次 tcp 0、发现 0 | 创建者结果行 `ok true fails []`、`tasks {published 6, completed 6, duplicateDone 0, byCreatorNode 5}`；成员 `session {transport ws, resumes 0, opens 1}`；代理 `summary`：conns 1、chunks 43、held 1、stallProb 0.05（M8-B3a 回执） | 只作补充，不替代真热点 |
| 与原文的差异 | — | 同一家宽出口、无移动网络的 NAT、时延与 MTU；真热点记待用户项 | — | — |

## 5. 补做的待跨机复核（M8-X1～X4）

| 编号 | 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|---|
| M8-X1 | 放本机版 T9（`REPORT-C6.6.md` 第 10 节） | PC：`node scripts/probes/c66-t9-probe.mjs --role creator --place lan`；笔记本：`--role observer`（`--place lan` **要改**；顺带 L3 确定判重的探针卡） | 待填 | 待填 | C6.6 T9：观察端先小后大、卡片源码自动装上；「改卡后 5 s 内重测」同轮记（第 8 节） |
| M8-X2 | HT9（`REPORT-HT-a.md` 第 1.7、4 节） | C10 部署后，PC 开在线页面发布；笔记本 `c10-browser-probe.mjs --site … --role host`（在 `claude/c10-site`） | 通过（2026-09-28，主会话记录）：主机实际由云端当（Linux、无头 Chromium 141、出站只经代理），run `c10s0928e`：creator ok、`fails: []`；云端主机认领 3、完成 1、失败 0、ws、connectFailed 0；新层指纹 `0326290ea8e62e3d`、就绪 42、播放中 `main-v2`；页面 5 个任务都恰好一次 `task.done`；主机结果 ok、released 1。C10-A5 外网一并通过 | `REPORT-C10.md` 第 7 节；`REPORT-HT-a.md` 第 1.7 节；run `c10s0928b`～`e` 是这四轮的轮号（`b` 中止未跑，`c`、`d` 见 C5-1 行） | 带片段清单的 plan 由独立渲染主机认领并完成；同时算 C10-A5 外网复验；记实际传输与降级原因 |
| M8-X3 | C10 外网复验（`HANDOFF-2026-09-28.md` 第 5 节：站点模式那一轮，含 A5 由外部独立渲染主机认领） | 笔记本（性能基准机）：`c10-browser-probe.mjs --site https://8-219-80-16.sslip.io --run <id> --base-port 5590 --host-wait-min 20`（页面在笔记本 Chrome，本机桌面版创建者）；PC：`--role host --run <id> --port 5783`（A5 的外部独立渲染主机） | **过**（笔记本重跑，PC 待命，A5 的外部独立渲染主机由云端当）：站点模式 A1～A4 与 A5 在 run `e6r0928L`（11:42:58Z，`c10-browser-probe --site --e6-reverse`，这一模式照跑 A1～A5，只把 A5 的改动扩到全部重卡并把 Y 的并发压到 1）里全过：A1 播放 10 s 主文档长任务 **0**（笔记本本机判，探针在外网模式把它记「待笔记本复核」，这一轮就在笔记本上跑）、重层 55 个不同帧、228 次按拍投递、装不下的层占位（10 层装下 7 层，deadMs 23.3）；A2 重开 `gateAgain false`、重取 0、L2 命中 3；A3 成员页 `snap/` 330 次、`px/` 0 次，层表 v 3，舞台从自己的源读 `/media`（s1 4 次、s2 4 次）；A4 停下后 6.9 s 追到精确活渲、`stillLive`；A5 云端主机（指纹 `0326290ea8e62e3d`）认领、完成，页面换上它产的新层（ready 55）。A5 的原样做法另在 M8-X2（run `c10s0928e`）里由云端当主机过、画面出现 `main-v2`。上一批 `c10x0928a` 挂的 3 条都出自旧探针「层表必须是 v 2」，新探针下不再出现。A8 对站点核过（501）；A9 的手机低内存档路径另用 `c10a-demo-probe.mjs --site` 跑（待填）；A6、A7、A10 以 C10 阶段本机替身为准 | `REPORT-C10.md` 第 5、7、10a 节；笔记本 M8-B3a 回执（`fails` 原文、各步骤数） | `c10-contract.md` 第 20 节 C10-A1～A10；性能相关的在笔记本判 |
| M8-X4 | 放本机的项目从浏览器进入（`c10-contract.md` 第 13 节） | — | **按语义不做**：`product/platforms.md`「在线浏览器模式」（用户 2026-09-27 定，同一决定也记在 `c10-contract.md` 第 14 节）只让浏览器进放云端的项目；契约第 13 节写于这条决定之前，被它取代 | `product/platforms.md` 第 57 行 | 手填主机地址或桌面版给的局域网链接能进；E5 放本机那一遍的前提 |

另：「只能出网的节点」一侧（裁定 D5）——笔记本仿一个经 CONNECT 代理出网的节点当替身跑一遍：

| 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|
| 笔记本入站全挡、出站只经本机 HTTP CONNECT 代理，主机设 `NODE_USE_ENV_PROXY=1`（代理与做法待写） | 通过（主会话记录）：本机 CONNECT 代理替身 `m8-outbound-probe` 四轮通过（main `8f92683`）；原记「待跨机复核」改为「云端已复核（run `c10s0928c` / `d` / `e`）」——云端容器本身只能经代理出网，这几轮它经代理认领并完成。查到的真云端代理怪癖：出站有多个出口地址，按出口地址掐线可能掐不中（见 C5-1 行） | `docs/reports/AGENT-m8-connect-proxy.md`；`REPORT-C10.md` 第 7 节 | 经代理出网时会话接续与认领正常；真云端代理的怪癖仍待跨机复核 |

## 6. 换机迁移演练（同一台阿里云上的第二份实例 8777 / 8778）

照 `hosting-migration.md` 第 2 节；源 `promptcut-hosted`，目标 `promptcut-drill`；裁定 D7：UFW 临时放行 8777 / 8778，演练完收回，旧实例保留 7 天。动 nginx、pm2 配置前各备份一份（`.bak-2026MMDD-m8`）。

| 步 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 0 准备数据 | E1 放云端那一遍 `--keep` 留下项目；另留一个 C10 在线页面建过的项目 | 待填 | 两个项目的 id | 有素材、有已就绪的层 |
| 1 基线库存 | `shared-project-probe.mjs --role inventory --hosted <主实例> --out <文件>`（**要改**，`claude/m8-migrate`） | 待填 | 库存文件 | 记下项目数、各 `projectRev`、快照数、内容库条目数、三个命名空间的哈希集合与字节数 |
| 2 部署目标 | `node scripts/remote/docservice.mjs deploy-hosted --instance drill --doc-public-url ws://8.219.80.16:8777 --asset-public-url http://8.219.80.16:8778/api/asset`（已存在的 HT 第 1 版 `promptcut-drill` 先 `pm2 delete`，待核） | 待填 | 部署输出 | 部署退出码 0 |
| 3 停写 | `pm2 stop promptcut-hosted` | 待填 | 时刻；当时在线的成员 | 报告写时间与影响 |
| 4 拷数据 | `rsync -a /var/lib/promptcut/hosted/ /var/lib/promptcut/drill/`；两边 `find … \| wc -l`、`du -sb` | 待填 | 文件数、字节数、耗时 | 两边一致 |
| 5 拷环境 | 部署脚本写两个公网地址；集群令牌随数据目录走 | 待填 | — | — |
| 6 启动自检 | `pm2 start promptcut-drill`；`status-hosted --instance drill`；`shared-project-probe.mjs --role migrate-check --from-inventory <第 1 步文件> --to http://127.0.0.1:8777`（**要改**） | 待填 | 结果行 | 两个 `/healthz` 正常；素材服务已登记新地址；项目数与各 `projectRev` 与第 1 步一致 |
| 7 抽查字节 | 同上 `--sample all` | 待填 | 相符比例 | 按哈希全部取回，校验通过 100% |
| 8 切客户端 | PC 桌面版在开始页加入表单改托管地址（截图）；笔记本 `PROMPTCUT_HOSTED_URL` 覆盖；`m8-migrate-probe.mjs` 的 client 一段（`claude/m8-migrate`） | 待填 | 截图；进入耗时 | 两台都进得去 |
| 9 核不重新预渲染 | `m8-migrate-probe.mjs --role member` | 待填 | 两台的 `stats`、层表 sha256、rev | 已就绪的层 0 次重渲；层表不变；再改一处 `projectRev` = 迁移前 + 1（连续、不归零） |
| 10 收尾 | 主实例 `pm2 start`；演练实例 `pm2 stop`；UFW 删 8777 / 8778；数据目录到本报告写完再删 | 待填 | 时刻 | — |

- 迁移完成后把真实命令补进 `hosting-migration.md` 第 2 节，第 9 步保留期写 7 天（待填提交）。

## 7. 混沌项

每一项都在「有任务在跑」的负载下做，放云端与放本机能做的各做一遍；判据都含 J-全完、J-恰一、J-纯层。

### 7.0 预检

| 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| P-C1 〔作废〕 | 约束「不动宿主机的网络」（2026-09-28）后不再改防火墙，不做 | — | — | — |
| P-C3 `ss -K` 与 netem | SSH 只读 | **已做**：内核 6.8.0-63，`ss -K` 可用，`sch_netem` 模块在（`m8-plan.md` 第 4 节「预检结果」） | 同左 | — |

### C1 节点断网 30 s（应用层）

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | 受害节点（云端独立主机，或笔记本回来后）经 `render-queue-proxy.mjs` 连文档服务，持有任务后（KV `host.holding`）往代理写 `stall`，30 s 后写 `resume`（约束「不动宿主机的网络」（2026-09-28）；`blackout.ps1` 已删）。实际：笔记本 host-a `--via-proxy 5596 --stall --stall-s 30`、host-b 直连；PC `--role creator --case e2` | **首轮没过**（run `m8c1c`，08:19～08:36Z）：`c1-outcome`（被扣的任务恢复后 154 s、stall 起 184 s 才被放回）、`e2:J-all-done` 29/30（`408754…:0-59` 满 3 次尝试后永久失败）、`J-exactly-once` missing 1、`victim-no-double-done`（受害方做完了被收回的那一段，完成报告按令牌作废，没有第二次 `task.done`）。**修复后复跑过**（run `m8c1d`，10:29Z，main `0cabcfb0`，9.1 min）：结局 `resumed-done`（受害方会话 `unchanged`，被扣的任务恢复后照常由它自己完成，属判据里「会话保留期内接续」那一种）；`e2:J-all-done` 30/30、`J-exactly-once` total 31 dup []、`J-pure-layers` 6 层 mixed []、`victim-no-double-done`；两台主机**丢认领 0、失败 0**（host-a 认领 12 / 完成 11 / 去重 1，host-b 15 / 13 / 2），PC 3 | 创建者结果行（`fails` 4 条原文见主会话记录）；代理：stall 08:19:42.375Z、resume 08:20:12.538Z（`stalledMs` 30162，积压上行 4、下行 5 块）；08:24:24.178Z 上游（8787）关了连接（`upstream-closed`，托管端记 `session.detach` 1006），630 ms 后会话接续、重发 7 条；两台主机：host-a 认领 21 / 完成 9 / 去重 5 / 失败 1 / **丢认领 6**，host-b（全程没断线）认领 19 / 完成 6 / 去重 4 / 失败 2 / **丢认领 7**；3 次 `sink-incomplete`（host-b `408754…:0-59` 08:22:58.856Z、host-a `0f1040…:240-299` 08:29:52.999Z、host-b `184ecf…:240-299` 08:30:15.646Z）。对照：E1 两台丢认领 0、E4 host-a 认领 43 丢 0、E2 两台各丢 1。**推断**：08:20:12～08:24:24 受害方连接正常、续约照发，host-b 全程没断线，所以这些收回只能是队列的「停滞」规则（帧数 120 s 没变就收回，契约 A.8 第 2 项）；节点在预渲染间里排队、渲完补小尺寸、推产物这几段帧数都不变，慢了就被误判。现有日志不记每次收回的原因（队列对节点一律报 `expired`、主机逐任务事件不进日志），诊断与修复在 `claude/stall-phases`（第 12a 节） | 接手 ≤ 37 s 或保留期内接续；旧令牌 `complete` 回 `lease-lost`；60 s 内重连取活；J-全完、J-恰一、J-纯层 |
| 放本机 | 同上，代理指向 PC 局域网主机 | 待填 | 同上 | 同上 |

### C2 `pm2 restart` 阿里云托管组合（兼 E3 放云端）

| 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|
| `ssh <远端> "pm2 restart promptcut-hosted && pm2 describe promptcut-hosted"`，前后各读一次 `/hosted/healthz`；`m8-e-probe.mjs --case e3 --place cloud`；假任务那遍用 `render-queue-e2e.mjs`；另开一个 C10 在线页面当成员 | 待填 | 重启时刻与重启次数；前后 epoch；各节点 `stats`；页面同步状态 | 两端重连后 epoch 变了；旧认领 `lease-lost { reason: 'epoch' }`；重新发布后全部完成；已在素材服务里的直接完成不重渲；在线页面恢复同步、重启前最后一次提交可读；J-恰一按 epoch 数 |

### C3 代理扰动 10%（用户态代理叫「10% 的数据块受扰」，不叫丢包）

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | 笔记本 `node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:5596 --target 8.219.80.16:8787 --loss 0.1`，主机配置 `url` 指向代理。实际（重跑，2026-09-28 第五次修订后 PC 待命）：笔记本同时当创建者 `m8-e-probe.mjs --role creator --case e1 --place cloud --no-identical --fake-tasks 0 --clips 4 --seconds 10 --port 5780` 与两台主机 `--role host --case e1 --via-proxy 5596 / 5597 --proxy-target 8.219.80.16:8787 --stall-prob 0.1 --port 5590 / 5593` | **过**（run `m8c3e`，11:26:50Z～11:41:58Z，14.8 min；main `29e6e837`，三方代码版本 `21c62981…`、指纹 `258acaaa7c5fe509`）：20 个真实细任务全完、0 失败；认领创建者节点 2、host-a 9、host-b 9；两台主机丢认领 0、失败 0、放回 0，会话没断（opens 1、resumes 0）；plan 587 s 落定。首轮 `m8c3c`（PC 当创建者）中止，见证据栏 | 创建者结果行 `ok true fails []`：`real:J-all-done` 20/20；`real:J-exactly-once` total 21（含 plan）、dup []、missing []、stray 0、单一 epoch；`real:J-pure-layers` 4 层、观测 40、mixed []；`real:artifacts` 清单 20、数据块 1620、89 686 810 字节、badBlocks []；`real:each-worked` 三方都做了、合计 20。两个代理的 `summary`：host-a 707 块里扣住 75 块（10.6%）、host-b 708 块里扣住 68 块（9.6%），随机断开 0。首轮 `m8c3c`（10:50Z 起，PC 创建者）中止：交接时笔记本辅助节点按用户的收口命令于 11:08Z 结束了两台主机与代理，此前 17 分钟两台主机没领到任务、原因未查；这次同样的扰动下两台主机 18 s 内报到、照常认领，没有复现。探针项目 `m8e-e1-m8c3c` 留在主实例上待清理 | 任务不因扰动被误判失败（`attempts` 不异常增加）；总耗时与无扰动之比只记录（同参数无扰动对照：待填） |
| 放本机 | 同上，`--target <PC 局域网地址>:<端口>` | 待填 | 同上 | 同上 |
| 〔作废〕内核层真丢包 | 约束「不动宿主机的网络」（2026-09-28）：不做 netem，只用代理的数据块受扰 | — | — | — |

### C4 放本机的项目的主机素材服务重启（必须 PC；兼 E3 放本机，裁定 D2）

| 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|
| `m8-e-probe.mjs --place lan --case c4`：PC 在笔记本持有任务时结束自己起的编辑器进程树、同端口再起；笔记本订阅 `service.endpoints`；重启后跑 `node scripts/probes/asset-lan-probe.mjs` | 待填 | 重启时刻；笔记本收到的 `service.endpoints` 事件与时刻；`asset-lan-probe` 结果行 | 笔记本 10 s 内收到素材服务地址的重新下发；没传完的上传续传完成 |

### C5 传输中断后会话在保留期内接续（HT-a）

| 遍 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| C5-1 放云端，服务器侧切 | 笔记本 `node scripts/probes/ht-w-probe.mjs --role host --cut external --hosted http://8.219.80.16:8787`；PC `--role creator`；PC 主会话在阿里云上 `ss -K` 切笔记本那一条（跑法模板 `docs/archive/agent-reports/AGENT-ht-w-probe.md` 第 5 节） | 通过（2026-09-28，主会话记录）：实际由云端当主机（`c10-browser-probe --role host`，不是笔记本 `ht-w-probe`），PC 当 creator。run `c10s0928c` 按主机报到时的出口 160.79.106.23 在服务器侧 `ss -K` 没掐中主机的 WebSocket（主机会话 opens 1、resumes 0）：云端出站代理有多个出口地址（后来在 443 上看到 160.79.106.129 / .133 / .134 / .137 / .141）；`d`、`e` 改掐阿里云上 nginx 到文档服务的上游连接（`ss -K dport 8787`）。`e`：01:26:02Z 持有 `snapshot:3e9b9605…:180-239`，01:26:06Z 在阿里云上掐 nginx 到文档服务的上游连接（`ss -K dport 8787`）5 条、1 秒内重连 4 条；主机 `resumes` 0→1、`opens` 1→1、6494 ms 接续原会话；托管端 `sessions.resumed` 3→8（掐线后 20 s）、legacy 0；持有的那段 taken 1 / reopened 0 / closed [done] / taskDone 1；旁观节点被一起掐断后接续（newSessions 0、resumes 1）、漏看 0；页面 5 个任务恰好一次 `task.done` | 探针 14 条检查；服务端 `session.detach` / `session.resume` 与 gap；`ss -K` 命令与时刻；主机诊断 `session`（`96e69cb` 起有） | `resumes` 加一、`opens` 不变；持有的任务不被放回、不被别人认领、没有 `lease-lost`；消息不丢不重（序号连续） |
| C5-2 放本机，代理侧切 | `ht-w-probe.mjs --cut proxy --proxy-target <PC 局域网地址>:<端口> --place lan`（`--place lan` **要改**） | 待填 | 同上，`sessions.resumed` 读 PC 局域网主机的 `/healthz` | 同上 |

- 已有的跨机证据（PC 当主机、代理侧切，PC-4，`REPORT-HT-a.md` 第 1.6 节）不重复算；M8 做的是角色对调后的两遍。

## 8. 带耗时门槛的项（笔记本判，`verification.md`「性能基准机」）

| 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 1080p 全幅流 15 帧分段编码 | 笔记本空闲时段与 main 交替跑 `node scripts/probes/stream-produce-probe.mjs`（不带 `--group`） | 待填（`claude/perf-encode` 待复核） | 每轮 p50 与机器负载 | p50 ≤ 300 ms；改门槛须用户确认 |
| 后台上传期间主线程无 > 50 ms 长任务 | `node scripts/probes/tiers-probe.mjs --port-a 5580 --port-r 5583` ×3 | 已过一次（`a038948`，`AGENT-perf-t4.md`）；最终基线再跑，待填 | 每轮 `t4.longtasksOver50` | 空闲时段 3 轮全过 |
| M7-A4 纯浏览器 30 秒内预渲染完锚帧 | M7 探针：笔记本本机 `m7-browser-probe --role all --timing-authoritative`（M7-T1c）；站点模式的数只作观察 | **过**（M7 合入时笔记本本机 M7-T1c，`88e70e3`：最慢锚点段 27.6 s）。经公网观察：站点首轮 63 s（`m7w0928e`，旧代码）→ 部署推送提速后 37.4 s（`m7w0928f`，首段开工前约 17 s、其后每段约 7 s）；PC 本机参考 21.1 s（合并后的代码，run `mukz7q6d6b84`） | `REPORT-M7.md`；本报告第 2 节 E5 与第 12a 节 | 页面可见且空闲时 30 s 内完成（`m7-contract.md`） |
| C6.6 T9「改卡后 5 s 内重测」 | 随 M8-X1 | 待填 | 待填 | 1 MB/s 与不限速下判 |
| C10a 第 3 步「新的小尺寸到手机」（L22） | `c10a-demo-probe.mjs`，放云端那遍记时刻分解 | 待填 | 补渲计划发布、认领、产出、推送、手机拉取各段时刻 | 只记录，不设门槛 |

## 9. G0 与 G0-R

| 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| G0 类型检查（`claude/rq-m8` 集成） | `npx tsc -b --force` | 待填 | 待填 | 零错误 |
| G0 全量测试 | `npm test` | 待填 | 待填 | 失败 0、跳过 ≤ 2、总条数不少于合并前 main 加新增 |
| G0-R | — | 探针分支只改 `scripts/probes/` 与文档，不跑，写明；`claude/m8-session-legacy` 改生产代码，按它的改动面定（待填） | — | — |
| 全案最终基线 | 见 `REPORT-M5-M8.md` 第 4 节 | 待填 | 待填 | — |
| 主工作区 | `git status` | 待填 | 待填 | 干净 |

## 10. 远端操作记录（`8.219.80.16`）

〔待填：每次部署、重启、nginx / UFW 改动、迁移演练：时刻、命令、退出码、备份文件名、断开了哪些连接。〕

| 时刻 | 操作 | 命令 | 退出码 | 影响 |
|---|---|---|---|---|
| 2026-09-28 04:59Z 前后 | 部署 M7 合入后的在线构建（主实例） | `node scripts/remote/docservice.mjs deploy-hosted --save --editor <dist-online> --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset --stage-origins https://s1.8-219-80-16.sslip.io,https://s2.8-219-80-16.sslip.io` | 0 | 托管组合重启一次（此后 `promptcut-hosted` 起于 04:59:20Z），在线连接全部重连 |
| 同日（C10 部署时） | nginx 主站点与 `promptcut-stages` 加 `/catalog/` 路由 | 手工改 `/etc/nginx/sites-available/promptcut`、`promptcut-stages`，`nginx -t` 后 reload | 0 | 备份 `promptcut.bak-20260928-catalog`、`promptcut-stages.bak-20260928-catalog`；reload 不断连接 |
| 09:18Z 前后 | 部署纯浏览器节点推送提速后的在线构建（main `5649236`，代码版本 `21c62981…`） | 同上一行的 `deploy-hosted --save …`（从 `.worktrees/merge-test2` 跑） | 0 | 托管组合重启（epoch `5dcf9833…` → `d535ee3a…`，`restarts` 13 → 14）；当时没有用例在跑。核对：`/editor/` 给 `assets/index-Cp2h7djI.js`、内含代码版本 `21c62981…`；`runtime-config.json` 的两个舞台源在；`s1` 子域 `/editor/` 200 |
| 09:19:28Z | 迁移演练准备（`m8-migrate-probe.mjs --step remote-plan` 清单 A、B 步）：备份、删旧的 HT 第 1 版演练进程、挪开旧数据 | `cp -a` 两份 `pm2.config.cjs` 与 `~/.pm2/dump.pm2` 为 `*.bak-20260928-m8`；`pm2 delete promptcut-drill`；`mv /var/lib/promptcut/drill /var/lib/promptcut/drill.old-20260928-m8`；建空的 `drill/secrets`（0700），在服务器上把主实例的 `secrets/cluster-token` 拷过去（令牌不经 PC、不打印） | 0 | 只动演练实例；主实例不受影响 |
| 09:20Z 前后 | 部署演练实例（当前 main 的服务端代码）并临时放行端口 | `deploy-hosted --instance drill --doc-public-url ws://8.219.80.16:8777 --asset-public-url http://8.219.80.16:8778/api/asset`（不加 `--save`）；`ufw allow 8777/tcp`、`ufw allow 8778/tcp`（注释 `m8-drill 20260928`，裁定 D7，演练完收回） | 0 / 0 | `promptcut-drill` online、重启 0；PC 读两个端口的 `/healthz` 都 ok |
| 10:28Z 前后 | 重新部署服务端（main `0cabcfb0`：停滞修复的 `step` 要队列一起更新、产物库修复），编辑器页不换 | `deploy-hosted --save --doc-public-url wss://8-219-80-16.sslip.io/hosted/ --asset-public-url https://8-219-80-16.sslip.io/media/api/asset`（不给 `--editor`，编辑器目录保留）；`deploy-hosted --instance drill --doc-public-url ws://8.219.80.16:8777 --asset-public-url http://8.219.80.16:8778/api/asset` | 0 / 0 | 主实例重启（epoch `d535ee3a…` → `f34a127c…`，`restarts` 15）、演练实例重启；当时没有用例在跑。核对：部署后的 `server/render-queue/queue.mjs` 含 `step` 与 `lastError`；`/editor/` 仍给 `index-Cp2h7djI.js` |

## 11. 跨机指令与回执

〔待填：发给笔记本的每条指令（编号、分支与提交、环境变量名、命令、期望输出）与回执原文；先在对话里列出再发（主计划第 6.3 节）。〕

| 编号 | 指令 | 回执 | 核对的提交 |
|---|---|---|---|
| 待填 | 待填 | 待填 | 待填 |

## 12. 顾问调用记录

| 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|
| 查资料（codex，`gpt-6-sol` / `high`，只读联网） | Windows 新阻止规则对已建立 TCP 连接是否立刻生效 | 下一个包触发重新授权，长连接在一个心跳内生效，空闲连接不保证；只加入站规则不够（`m8-plan.md` 第 4 节「预检结果」） | 采纳，笔记本仍要实测（P-C1） |
| 攻坚（codex worktree） | 待填 | 待填 | 待填 |
| 发散（Gemini） | 待填（M8 没有新的用户侧界面，按计划不调，卡死时按回退梯次第 3 级调） | — | — |

## 12a. M8 期间合入的修复

| 修复 | 起因 | 分支与合入 | 验证 | 影响的 M8 项 |
|---|---|---|---|---|
| 纯浏览器节点推送提速：原尺寸与小尺寸两次推送改为并行；推这一帧时把下一帧先交给后台舞台做（让路时多做的那一帧照旧在帧边界取消、不产出） | W7 真跨机（run `m7w0928e`）锚点段 63 s，远慢于本机 27.6 s。子智能体查明每帧多出的是两次串行推送各自的一趟 `GET chunks` 往返（PC 到阿里云约 76 ms），舞台本身两种模式下都是每帧 87 ms（`docs/archive/agent-reports/AGENT-site-bake-slow.md`） | `claude/site-bake`，main `5649236`（release 同步前进）；改 `src/editor/browserNodeHost.ts`、`src/online/snapUploader.ts`，代码版本由 `ddf69b5e…` 变为 `21c62981…` | G0：`tsc -b --force` 0 错误；`npm test` 3758 / 3756 / 0 失败 / 2 跳过；`npm run build`、`vite build --mode online` 成功。合并后的代码跑 `m7-browser-probe --role all --no-a10 --no-twin`（run `mukz7q6d6b84`）：`fails []`，A1、A2、A3、A6、A7、A8、A9、A11、D1-D2-D12、D9、D10、D14 过；计时项待笔记本复核，PC 参考判定都过（A4 最慢锚点段 21.1 s、A5 602 ms、A12 长任务 0）；每帧 bakeMs p50 89 ms、p95 133 ms，推送段 p50 13.4 ms。本机素材服务压 76 ms 时每帧 653 → 280 ms（子智能体数，PC 参考） | 之后的 M8 各项都在新代码版本上跑（第 1.2 节）；E1、E2（`m8e1c2`、`m8e2c`）与第一批 C1、E4、E6 在旧版本 `ddf69b5e…` 上跑，这次改动只动纯浏览器节点，不影响它们的结论。站点上的锚点段耗时部署后由笔记本复测（第 8 节） |

| 活着、在干活的节点不再被判停滞：`task.progress` 可带工作计数 `step`（换阶段、出一批帧、推完一块时加一，单纯续约不加），队列在帧数或工作计数变化时都重新计时；独立渲染主机只在串行预渲染间空着时认领快照与 `plan`；收回原因如实下发（`lease-expired` / `stalled` / `disconnected`），任务视图带 `lastError`，节点逐任务日志 `[queue-node] node.task-*` 带所处阶段与各段用时 | C1 放云端首轮（`m8c1c`）两台主机丢认领 6 / 7、3 次 `sink-incomplete`、1 个任务满 3 次永久失败；E6 放云端（`m8e6c`）PC 节点 1 个任务永久失败。队列的停滞规则只认帧数，推产物与在串行预渲染间里排队时帧数不变，超过 120 s 就被当成卡死收回（比语义「既没报进度也没报完成才收回」严） | `claude/stall-phases`（`opus-dev-high` 子智能体，报告已归档 `docs/archive/agent-reports/AGENT-stall-phases.md`）；契约 `render-queue-contract.md` A.12、`render-host-contract.md` 第 3 节〔裁〕（主会话审过、同意）；只动 `server/`，代码版本不变 | 子智能体：新用例改前复现（推到 48/60 块时 `stalled`、排队 `lane ahead 1` 时 `stalled`），改后通过；真实时间替身每段推送约 150 s：改前丢认领 6、永久失败，改后 0、全部完成；卡死的执行器仍在 120 s 后收回（I8 两条与新用例 S4）。主会话合并后 G0：`tsc` 0；`npm test` 3774 / 3772 / 0 / 2；构建成功。G0-R（`c15d693`）：导出确定性 1800/1800；与 PC 基准逐像素 1800 相同；快照重放一致 PASS；`ready-index-probe` `fails []`；`stream-produce-probe --group` PASS；`preview-fallback-probe` 两种透明拍 0（288、289 拍） | 这一版之后的 C1、E6 复跑、C3、E3/C2 都在它上面跑；托管端要一起部署（`step` 由队列读） |
| 产物库核对素材服务：本机帧库覆盖整段时，逐块问素材服务（并发 4），缺的块用本机字节补推（不重渲）、推齐才回「已有」；块齐时只问不推；补推失败回「没有」照常执行 | 停滞修复时查出的遗留：推到一半丢认领、又被自己重新认领时以去重完成，素材服务上缺块，别的成员按清单取不到，违反语义「节点先把产物推送到素材服务，再向文档服务报完成」 | `claude/sink-has`（同一子智能体，报告已归档 `docs/archive/agent-reports/AGENT-sink-has.md`）；契约 `artifact-transfer-contract.md` 第 4 节 `has` 与 `manifest-contract.md`〔裁〕（主会话审过、同意）；PC 节点用同一个产物库，一并修好 | 子智能体：新用例 H1～H4 改前 3 条失败、改后 4 条连跑 3 遍过；本机替身「推到 30/60 块丢认领、自己重新认领」：改前去重完成后素材服务缺 30 块，改后 0 缺；`npm test` 3773 / 3771 / 0 / 2。主会话把停滞修复、A6 探针修正与本项叠在一起合并（`0cabcfb0`，main 与 release 同步前进）后：G0 `tsc` 0、`npm test` 3778 / 3776 / 0 / 2、构建成功；G0-R 导出确定性 1800/1800、与 PC 基准逐像素 1800 相同、快照重放一致 PASS、`ready-index-probe` `fails []`、`stream-produce-probe --group` PASS、`preview-fallback-probe` 两种透明拍 0（286、285 拍）。随后重新部署阿里云主实例与演练实例的服务端（主实例 epoch `d535ee3a…` → `f34a127c…`，编辑器页不变） | E3（重启后已完成的任务走去重、渲染 0 次）不受影响：块齐时一块不推 |
| 探针：`m8-e-probe` 主机结果行加 `idsDetail`，异地接入的 `--assert-no-lan`（`scripts/probes/m8/no-lan.mjs`） | C1 查因时缺逐次丢认领的时刻；异地接入要证「全程没有局域网连接」 | main `f550b02`（`claude/m8-nolan`） | 单测 5 条过；守门测试名单加 `m8-no-lan.test.mjs`；`npm test` 3763 / 3761 / 0 / 2；PC 实跑对照（阿里云地址数到 46 条连接） | 异地接入两轮 |
| 探针：`c10-browser-probe --e6-reverse`，并按 M7 D1 更新两处过时判法（层表认 v 3；A5 的新快照也认页面自己出的层） | E6 反方向没有探针能做 | main `42e691c`（`claude/m8-e6r`，报告已归档 `docs/archive/agent-reports/AGENT-m8-e6r.md`） | 本机替身 E6 反方向 `ok true`；原模式不带新开关 `ok true`；合并后 `npm test` 3763 / 3761 / 0 / 2（首轮 `sp-store.test.mjs` 整份加载失败一次，单独 9/9、全量重跑全绿，另开任务查） | E6 反方向跨机、C10 外网复验重跑 |
| 探针：`m7-browser-probe` 的 A6「更急的活在帧边界让路」等这一段出过帧（done ≥ 1）再触发 | 站点复测 `m7w0928f` 触发时这一段一帧未出，测量在空闲的后台舞台上直接做完、没有东西可让，A6 判失败 | `claude/m7-a6-race` | 本机替身：A6 urgent 34 ms 让路、之后 1 帧，`fails []` | 站点复测重跑 |

## 13. 与计划不一致、语义冲突、待用户项、遗留

〔待填。已知会写进来的：〕

- 与计划不一致：异地接入用替代做法（第 4 节，裁定 D11）；C4 与 E3 放本机合并（裁定 D2）；「恰好一次」按 epoch 数（裁定 D3，三级口径，不改语义）。
- 〔裁〕E6 反方向的判据（2026-09-28 主会话，非语义拍板，发给用户不等）：计划写「笔记本主机先认领按清单发布的 plan」后「指纹 Y 的主机……层表逐层指纹」，按字面要求这一版每层都出自 Y。但页面是发布方、在线时按 M7 的双份键规则（`m7-contract.md` D1）切分方也给页面发一份它自己环境的任务，页面可以用自己的指纹做出某张卡（本机替身 run 2 里页面做出了主卡那一层，层表的主候选仍是 Y、页面的指纹只在候选里）。改判为：X（另一种指纹）对 Y 指纹的细任务认领 0；每张卡只来自一种指纹（不混）；J-全完、J-恰一（被双份键作废的任务不计）。依据：`m7-contract.md` D1 与 `mechanism/rendering.md`「不同环境的结果不混用」。探针 `c10-browser-probe.mjs --e6-reverse`（`claude/m8-e6r`，报告已归档 `docs/archive/agent-reports/AGENT-m8-e6r.md`）。
- 计划与语义冲突（按语义办）：主计划第 7 节 M8 要 E1～E6 放本机各一遍，其中 E5 放本机要浏览器进放本机的项目（M8-X4）；语义 `product/platforms.md`「在线浏览器模式」（用户 2026-09-27 定）只让浏览器进放云端的项目。两项记「按语义不做」，原裁定 D6「记待跨机复核」作废（它等于推到 M8 之外）。语义没改。
- E2 判据的口径：计划写「≤ 37 s 被另一节点认领」，探针拆成「放回 ≤ 37 s（判）」「被认领（记）」两条（`AGENT-m8-e2e.md` 第 5 节第 2 条）。放云端那遍放回 33.9 s、认领 44.1 s（另两个节点槽位都满）；按字面的「≤ 37 s 被认领」另在别的节点有空时轻负载复跑（第 2 节 E2）。
- 待用户项：真热点；真手机扫码与 iOS 导出；PC 局域网主机新端口的防火墙放行（如需要）；「只能出网的节点」一侧是否在团队测试时补（`m8-plan.md` 第 8.3 节）。
- 遗留：L18（桌面 plan 领不到环境不同的主机）按 E6 两个方向记现象。

## 14. 骨架里发现的缺口（M8 部分）

1. **E5 放本机那一遍可能填不了**：它依赖 M8-X4（浏览器进放本机的项目），而 M8-X4 的实现归属未定（裁定 D6 只说记待跨机复核）。主计划第 7 节 M8 要求 E1～E6 放本机一遍，第 10 节不许推迟到 M8 之外，两者目前对不上。——2026-09-28 主会话查明：语义 `product/platforms.md`「在线浏览器模式」（用户 2026-09-27 定）只让浏览器进放云端的项目，M8-X4 与 E5 放本机都不是一期承诺的能力，按「语义优先」记「按语义不做」（第 2 节 E5、第 5 节 M8-X4、第 13 节）。
2. **五个探针还不存在**：`m8-e-probe.mjs`、`m8-scale-probe.mjs` 没有任何分支；`claude/m8-e2e`、`claude/m8-scale` 分支也还没开。`m8-migrate-probe.mjs` 与 `scripts/probes/m8/` 公共件已在 `claude/m8-migrate`、`claude/m8-kit` 上，未合入。
3. **「只能出网的节点」替身的代理没有归属分支**：裁定 D5 要笔记本仿一个经 CONNECT 代理出网的节点，`m8-plan.md` 第 4、6 节的探针表里没有这一项。
4. **E5 用的 M7 探针文件名未定**：`m8-plan.md` 写「`rq-m7-tests` 交付」，`claude/m7-probe` 上目前是 `m7-visibility-probe.mjs`、`m7-bake-probe.mjs`，哪一个负责 M7-A1～A3 的跨机模式待 M7 定。
5. **`claude/m8-session-legacy` 改了生产代码**（`server/card-sync.mjs` 等），`m8-plan.md` 第 2.8 节只写了「探针分支不跑 G0-R」，这一支要不要跑 G0-R 没定。
6. **迁移第 2 步的「先 `pm2 delete` 旧演练实例」标着待核**：HT 第 1 版的 `promptcut-drill` 还在跑（`HANDOFF-2026-09-28.md` 第 7 节），删之前要确认没人在用。
7. **端口段 5730～5789 待主会话核对**（`m8-plan.md` 第 1.3 节原注），本骨架第 1.2 节照抄。
