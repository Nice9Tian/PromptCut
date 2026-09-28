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
| 放本机 | 同上，`--proxy-target <PC 局域网地址>:<端口>` | 待填 | 同上 | 同上 |

### E3 文档服务重启

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | 同第 7 节 C2（`pm2 restart promptcut-hosted`）；`m8-e-probe.mjs --case e3 --place cloud` | 待填 | 重启前后 `/healthz` 的 epoch；各节点 `stats` | epoch 变了；J-全完、J-恰一（按 epoch 数）；重启前已完成的任务重启后执行器渲染 0 次（`stats.dedup`） |
| 放本机 | 同第 7 节 C4（重启 PC 局域网主机编辑器，裁定 D2 合并） | 待填 | 同上 | 同上 |

### E4 Agent 突发修改

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | `m8-e-probe.mjs --case e4 --burst 50 --gaps 0,200,900`（`agent` 角色连项目、`project.commit` 带期望版本；笔记本另开成员页面只看） | 待填 | 三份 sha256 与 rev；每轮提交与 `stale` 次数；突发期间完成数 | 每轮结束文档服务、PC 页面、笔记本页面三份项目 sha256 相同；`stale` 重读重写、50 次都落地；突发期间至少完成 1 个细任务，结束后 J-全完 |
| 放本机 | 同上，`--place lan` | 待填 | 同上 | 同上 |

### E5 纯浏览器节点只见本人任务

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | M7 交付的探针（`rq-m7-tests` 或 `m7-probe` 分支，文件名待 M7 合入后填）跨机模式；笔记本 Chrome 当成员 B | 待填 | M7 探针结果行 | M7-A1、A2、A3：同项目另一成员的任务收到 0 条、认领 `forbidden`；同名不同设备同样挡住 |
| 放本机 | 同上，`--place lan`；前提是浏览器能进放本机的项目（M8-X4） | 待填（裁定 D6：前提未做时记待跨机复核） | 同上 | 同上 |

### E6 两种指纹

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端（测试开关） | `m8-e-probe.mjs --case e6`；笔记本 `--role host --fake-fingerprint <16 位十六进制>`（设 `PROMPTCUT_TEST_ENV_FINGERPRINT`，开关在 C10 集成分支的 `server/frame-pipeline.mjs`） | 待填 | 各节点认领表；层表逐层指纹 | 指纹 Y 的主机对这一版细任务认领 0；J-全完、J-纯层；反方向（笔记本主机先认领按清单发布的 plan）再一遍 |
| 放云端（纯浏览器节点当第二种指纹，裁定 D12） | M7 合入后 | 待填 | 同上 | 同上 |
| 放本机 | 同上，`--place lan` | 待填 | 同上 | 同上；另记桌面 plan 领不到环境不同的主机的现象（L18） |

## 3. K1、I1 真实多端复测

| 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| K1-X 实验组 | PC：`node scripts/probes/m8-scale-probe.mjs --case k1 --role coord+nodes --fingerprint X --nodes 4 --tasks 200 --lock-half`；笔记本：`--role nodes --fingerprint Y --nodes 4`（探针**要写**，`claude/m8-scale`） | 待填 | 两边拒绝计数、`task.opened` 计数 | 稳态 `card-locked` 拒绝 0，竞态窗口 ≤ 认领总数 1%；不匹配节点收到已锁卡 `task.opened` 0 条；结论与本机一致（M5b：过滤开 0、过滤关 400，`REPORT-render-queue-m5b.md` 第 1 节） |
| K1-X 对照组（过滤关） | 在 PC 本机跑（裁定 D4） | 待填 | 同上 | 数字写进报告作基数 |
| I1-X 先在演练实例 | PC：`m8-scale-probe.mjs --case i1 --role coord+nodes --projects 1-10`；笔记本：`--role nodes --projects 11-20` | 待填 | 每个节点收到的消息计数；阿里云 RSS、CPU、带宽采样 | 非 A 的节点收到 A 的消息 0 条；每条增量投递次数 = 能看见它的连接数（I2 顺带） |
| I1-X 主实例 | 同上 | 待填 | 同上 | 同上 |

## 4. 异地接入托管（替代「笔记本在手机热点下」，裁定 D11 算过）

| 步 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 关掉局域网路径 | 应用层：成员端 `shared-project-probe.mjs --assert-no-lan`（不做局域网发现、候选只留公网地址），`Get-NetTCPConnection` 只读核对没有局域网连接（约束「不动宿主机的网络」（2026-09-28），不改防火墙） | 待填 | 开关设置与连接计数 | — |
| 假任务一轮 | PC：`node scripts/probes/shared-project-probe.mjs --mode internet --role creator …`；笔记本：`--role member --assert-no-lan <PC 局域网地址>`（`--assert-no-lan` 是**要改**的参数，`claude/m8-migrate`） | 待填 | 两个角色的结果行；`Get-NetTCPConnection` 计数 | 笔记本不设集群令牌、凭项目凭证经 443 进入；每个任务恰好一次 `task.done`；产物在阿里云素材服务；全程没有局域网连接 |
| 真实渲染一轮 | `node scripts/probes/render-host-probe.mjs --hosted …` 或 `m8-e-probe.mjs --case e1` | 待填 | 同上 | 同上 |
| 补充：模拟移动网络 | 笔记本经 `render-queue-proxy.mjs --delay-ms 150 --loss 0.05` 连 8787 | 待填 | 代理 `summary` 行 | 只作补充，不替代真热点 |
| 与原文的差异 | — | 同一家宽出口、无移动网络的 NAT、时延与 MTU；真热点记待用户项 | — | — |

## 5. 补做的待跨机复核（M8-X1～X4）

| 编号 | 项 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|---|
| M8-X1 | 放本机版 T9（`REPORT-C6.6.md` 第 10 节） | PC：`node scripts/probes/c66-t9-probe.mjs --role creator --place lan`；笔记本：`--role observer`（`--place lan` **要改**；顺带 L3 确定判重的探针卡） | 待填 | 待填 | C6.6 T9：观察端先小后大、卡片源码自动装上；「改卡后 5 s 内重测」同轮记（第 8 节） |
| M8-X2 | HT9（`REPORT-HT-a.md` 第 1.7、4 节） | C10 部署后，PC 开在线页面发布；笔记本 `c10-browser-probe.mjs --site … --role host`（在 `claude/c10-site`） | 通过（2026-09-28，主会话记录）：主机实际由云端当（Linux、无头 Chromium 141、出站只经代理），run `c10s0928e`：creator ok、`fails: []`；云端主机认领 3、完成 1、失败 0、ws、connectFailed 0；新层指纹 `0326290ea8e62e3d`、就绪 42、播放中 `main-v2`；页面 5 个任务都恰好一次 `task.done`；主机结果 ok、released 1。C10-A5 外网一并通过 | `REPORT-C10.md` 第 7 节；`REPORT-HT-a.md` 第 1.7 节；run `c10s0928b`～`e` 是这四轮的轮号（`b` 中止未跑，`c`、`d` 见 C5-1 行） | 带片段清单的 plan 由独立渲染主机认领并完成；同时算 C10-A5 外网复验；记实际传输与降级原因 |
| M8-X3 | C10 外网复验（`HANDOFF-2026-09-28.md` 第 5 节） | 笔记本 Chrome：`c10-browser-probe.mjs --site https://8-219-80-16.sslip.io` | A5 部分完成（随 M8-X2，run `c10s0928e`；主会话记录）；其余 C10-A1～A10 的外网一遍待填。带耗时门槛的项已在笔记本本机判过（C10-T1） | `REPORT-C10.md` 第 5、7 节 | `c10-contract.md` 第 20 节 C10-A1～A10；性能相关的在笔记本判 |
| M8-X4 | 放本机的项目从浏览器进入（`c10-contract.md` 第 13 节） | 待定（实现归属未定，裁定 D6） | 待填 | 待填 | 手填主机地址或桌面版给的局域网链接能进；E5 放本机那一遍的前提 |

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
| 放云端 | 受害节点（云端独立主机，或笔记本回来后）经 `render-queue-proxy.mjs` 连文档服务，持有任务后（KV `host.holding`）往代理写 `stall`，30 s 后写 `resume`（约束「不动宿主机的网络」（2026-09-28）；`blackout.ps1` 已删） | 待填 | 代理 `control.stall` / `control.resume` 时刻与 `stalledMs`；旁观节点时间线；`resumes` / `opens` / `lost` | 接手 ≤ 37 s 或保留期内接续；旧令牌 `complete` 回 `lease-lost`；60 s 内重连取活；J-全完、J-恰一、J-纯层 |
| 放本机 | 同上，代理指向 PC 局域网主机 | 待填 | 同上 | 同上 |

### C2 `pm2 restart` 阿里云托管组合（兼 E3 放云端）

| 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|
| `ssh <远端> "pm2 restart promptcut-hosted && pm2 describe promptcut-hosted"`，前后各读一次 `/hosted/healthz`；`m8-e-probe.mjs --case e3 --place cloud`；假任务那遍用 `render-queue-e2e.mjs`；另开一个 C10 在线页面当成员 | 待填 | 重启时刻与重启次数；前后 epoch；各节点 `stats`；页面同步状态 | 两端重连后 epoch 变了；旧认领 `lease-lost { reason: 'epoch' }`；重新发布后全部完成；已在素材服务里的直接完成不重渲；在线页面恢复同步、重启前最后一次提交可读；J-恰一按 epoch 数 |

### C3 代理扰动 10%（用户态代理叫「10% 的数据块受扰」，不叫丢包）

| 放法 | 命令 | 结果 | 证据 | 判据 |
|---|---|---|---|---|
| 放云端 | 笔记本 `node scripts/probes/render-queue-proxy.mjs --listen 127.0.0.1:5596 --target 8.219.80.16:8787 --loss 0.1`，主机配置 `url` 指向代理 | 待填 | 代理 `summary` 行；探针结果行 | 任务不因扰动被误判失败（`attempts` 不异常增加）；总耗时与无扰动之比只记录 |
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
| M7-A4 纯浏览器 30 秒内预渲染完锚帧 | M7 探针 | 待填 | 待填 | 页面可见且空闲时 30 s 内完成（`m7-contract.md`） |
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
| 待填 | 待填 | 待填 | 待填 | 待填 |

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

## 13. 与计划不一致、语义冲突、待用户项、遗留

〔待填。已知会写进来的：〕

- 与计划不一致：异地接入用替代做法（第 4 节，裁定 D11）；C4 与 E3 放本机合并（裁定 D2）；「恰好一次」按 epoch 数（裁定 D3，三级口径，不改语义）。
- 待用户项：真热点；真手机扫码与 iOS 导出；PC 局域网主机新端口的防火墙放行（如需要）；「只能出网的节点」一侧是否在团队测试时补（`m8-plan.md` 第 8.3 节）。
- 遗留：L18（桌面 plan 领不到环境不同的主机）按 E6 两个方向记现象。

## 14. 骨架里发现的缺口（M8 部分）

1. **E5 放本机那一遍可能填不了**：它依赖 M8-X4（浏览器进放本机的项目），而 M8-X4 的实现归属未定（裁定 D6 只说记待跨机复核）。主计划第 7 节 M8 要求 E1～E6 放本机一遍，第 10 节不许推迟到 M8 之外，两者目前对不上。
2. **五个探针还不存在**：`m8-e-probe.mjs`、`m8-scale-probe.mjs` 没有任何分支；`claude/m8-e2e`、`claude/m8-scale` 分支也还没开。`m8-migrate-probe.mjs` 与 `scripts/probes/m8/` 公共件已在 `claude/m8-migrate`、`claude/m8-kit` 上，未合入。
3. **「只能出网的节点」替身的代理没有归属分支**：裁定 D5 要笔记本仿一个经 CONNECT 代理出网的节点，`m8-plan.md` 第 4、6 节的探针表里没有这一项。
4. **E5 用的 M7 探针文件名未定**：`m8-plan.md` 写「`rq-m7-tests` 交付」，`claude/m7-probe` 上目前是 `m7-visibility-probe.mjs`、`m7-bake-probe.mjs`，哪一个负责 M7-A1～A3 的跨机模式待 M7 定。
5. **`claude/m8-session-legacy` 改了生产代码**（`server/card-sync.mjs` 等），`m8-plan.md` 第 2.8 节只写了「探针分支不跑 G0-R」，这一支要不要跑 G0-R 没定。
6. **迁移第 2 步的「先 `pm2 delete` 旧演练实例」标着待核**：HT 第 1 版的 `promptcut-drill` 还在跑（`HANDOFF-2026-09-28.md` 第 7 节），删之前要确认没人在用。
7. **端口段 5730～5789 待主会话核对**（`m8-plan.md` 第 1.3 节原注），本骨架第 1.2 节照抄。
