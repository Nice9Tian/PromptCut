> 2026-09-28 PC 主会话派子智能体起草（分支 `claude/c10-report`，从集成分支 `claude/c10-integ` 的 `24c2c57` 拉出）。数字只从各报告里抄，每处注明出处；拿不准的标「待核」；还在做的两条分支与外网一轮留了占位，格式是【占位 Pn：等什么】，全部占位在第 13 节汇总。

# C10 阶段报告：在线浏览器模式普通档（C10 其余）

契约 `docs/plan/c10-contract.md`（第 1 版发给用户但不等；第 18 节是开工后的裁定，第 9 条在集成分支 `ee00efd`）。

用到的代号（第一次出现时的白话说明）：

- **C10 其余**：主执行计划 `docs/plan/Master-Execution-Plan.md` 第 7 节里「在线浏览器模式」除 C10a demo 之外的全部内容，本报告简称 C10。**C10a** 是它之前的 demo 阶段（`docs/reports/REPORT-C10a.md`）。
- **C10-A1～A10**：契约第 20 节的十条验收。**C10-T**：`claude/c10-tests` 照契约独立写的契约测试（60 条）。**K1～K12**：C10-T 对实现接口的假设（`server/test/c10-kit.mjs` 文件头），与 C10a 契约里的 K 系列无关。
- **L2**：编辑器页里的页面内快照库（IndexedDB，三张表 `costs` / `snapshots` / `ranges`）。**L3**：普通档按清单从素材服务取预渲染原尺寸。**L4**：播放时按拍换快照、换帧成本进预算。**L5**：三条预留接口。这几个编号沿用 `docs/plan/cloud-task.md` 的 L 节。
- **层表 v2**：渲染节点写的 `layers:<项目 id>`，每层多了共享档的内容键 `contentKey` 与产出环境的指纹 `envFingerprint`（契约第 18 节第 3 条）。
- **清单计划 `#clips:`**：页面发布的、带片段清单的 `plan` 任务，结果键形如 `plan:<项目>@<版本>#clips:<签名>`（契约第 18 节第 9 条）。
- **OAC**：响应头 `Origin-Agent-Cluster: ?1`，让同站跨源的舞台进独立进程（契约第 2 节）。
- **M6c X4**：旧队列规则「`plan` 只给 `pc` 档、发布方独占窗口，`host`、`browser` 永不认领」（`docs/plan/m6c-contract.md`）。
- **G0**：通用门槛（类型检查、全量测试、两种构建）；**G0-R**：改到渲染、预渲染、导出时加跑的回归（`docs/semantics/guide_files/verification.md`；主执行计划第 8 节）。
- **HT9**：HT-a 留下的跨机项——在线页面发布带片段清单的 `plan`，独立渲染主机跨机认领并完成（`docs/reports/REPORT-HT-a.md`）。
- **C10-T1**（主会话编号）：C10 里带耗时门槛、要在笔记本（性能基准机）上复核的项。**C10-S1**（主会话编号）：C10 外网复验里要笔记本当独立渲染主机的那一轮，同时算 HT9。
- **M8-X2 / M8-X3、L1～L26**：M8 执行计划（分支 `claude/m8-plan` 的 `docs/plan/m8-plan.md`，下称「M8 计划」）第 3.1 节新增的待跨机复核编号、第 5 节「要在 M8 之内修的遗留」编号。

## 0. 过程

- 开工前：主会话调 codex 查资料（`docs/plan/c10-research.md`）、Gemini 出交互稿（`docs/plan/c10-ux-draft.md`），派 `claude/c10-probe` 做可行性探针（`scripts/probes/c10-stage-probe.mjs`，报告已归档 `docs/archive/agent-reports/AGENT-c10-probe.md`），据此写契约第 1 版（main `b7635ad`，探针分支合入 main `5cae8db`）。用户随后定的语义（在线只加入、不新建、不存草稿；在线本地备份不写浏览器存储；低内存档完整规则）由主会话随改契约（main `4a82441`、`7ff0ea8`、`2a3d763`）。
- C10a、HT-a 合入 main 之后（`d7a6fac`、`e39c0fd`），集成分支 `claude/c10-integ` 从 main `d70fce7` 起，先写派活前的裁定（`e067d0b`，契约第 18 节第 1～8 条），再派四个分支；HT9 跨机实测查出 X4 挡住独立主机后，补第 18 节第 9 条（`ee00efd`）。
- 2026-09-28 笔记本主会话把主会话交回 PC（`docs/reports/HANDOFF-2026-09-28.md`），`c10-browser` 在交接时收口（A4 后半没过）；PC 主会话接手集成，另派 `claude/c10-a4` 查 A4，集成后派两条后续 `claude/pause-precise`、`claude/c10-site`（都还在做，第 10 节）。
- 云端工作节点按用户 2026-09-28 定已归档（main `2c7cee2`），C10 的外网复验与跨机项不经云端，改由笔记本当独立渲染主机。

## 1. 分支与合入顺序

| 分支 | Agent | 起点 | 内容 | 报告 |
|---|---|---|---|---|
| `claude/c10-probe` | `opus-dev` | main | 可行性探针 P1～P4（契约第 15 节） | `docs/archive/agent-reports/AGENT-c10-probe.md` |
| `claude/c10-tests` | `opus-dev` | main `bcb67a0` | C10-T：60 条（桩 7 + 契约 53），实现不在时按门跳过 | `docs/archive/agent-reports/AGENT-c10-tests.md` |
| `claude/c10-ui` | `opus-dev` | 集成 `e067d0b` | 契约第 9、10、11、19 节，第 18 节第 4、6 条 | `docs/archive/agent-reports/AGENT-c10-ui.md` |
| `claude/c10-cost` | `opus-dev-high` | 集成 `e067d0b` | 契约第 3 节低内存档的完整规则（成本记录模块、界限搜索、补渲只对判重缺产物的层） | `docs/archive/agent-reports/AGENT-c10-cost.md` |
| `claude/c10-browser` | `opus-dev-high` | 集成 `e067d0b` | 契约第 2～7、12 节，第 18 节第 1、2、3、5、7、9 条 | `docs/archive/agent-reports/AGENT-c10-browser.md` |
| `claude/c10-a4` | 子智能体（类型待核） | `c10-browser` `9ad7429` | 查修 C10-A4 后半「暂停后追到精确活渲」 | `docs/archive/agent-reports/AGENT-c10-a4.md` |
| `claude/tier-reload-seek` | 子智能体（类型待核） | main `d70fce7` | 跨机 T9（C6.6 的跨机验收）暴露的「暂停中原尺寸到齐后一直停在小尺寸」；已合入 main `d011783`，随 C10 归档（交接文件第 1 节） | `docs/archive/agent-reports/AGENT-tier-reload-seek.md` |
| `claude/c10-integ` | PC 主会话派的集成子智能体 | main `d70fce7` | 合并、kit 对账、接线、C10-A 本机验收 | `docs/archive/agent-reports/AGENT-c10-integ.md` |
| `claude/pause-precise` | 在做 | 集成 `24c2c57` | C10-A4 的两条后续（停下到精确太慢） | 不在本分支，见第 10 节 |
| `claude/c10-site` | 在做 | 集成 `24c2c57` | `c10-browser-probe` 外网模式与独立主机角色 | 不在本分支，见第 10 节 |

集成分支 `claude/c10-integ` 上的合入顺序（`git log --first-parent`）：

1. `e067d0b`、`ee00efd`：契约第 18 节第 1～8 条、第 9 条。
2. `d3f2957`：合 main `d011783`（W-HT-a 断线探针与换档修复，即 `tier-reload-seek`）。
3. `f9adcab` 合 `c10-ui`（`842e50a`）→ `ac28412` 合 `c10-cost`（`238183c`）→ `9cee501` 合 `c10-tests`（`0c4ca6d`）→ `fcbff6c` C10-BK-04 改注释后通过。
4. `9092896` 集成报告开工 → `c69b096` 合 `c10-browser`（`9ad7429`），解五个文件的冲突 → `e2c133e` 合 main（只有文档；集成报告写的是 `cdeaff9`，合并提交的第二个父是它的下一个提交 `2c7cee2`，即「云端工作节点归档」）。
5. `1e74dbc` kit 对账 → `ebd78e3` 接线 → `bc91b10` 报告。
6. `76dab6f` 合 `c10-a4`（`fe00dcc`），无冲突。
7. `ecb8cd2`、`d4d3663` 探针对账 → `b45ddc6` 修 `ProbeGate` → `8bb0cbe` 诊断计数 → `5774a99` 报告。
8. `24c2c57`：合 main `a038948`（带上 `tiers-probe` T4 修复 `claude/perf-t4` 与 M7 契约）。

还没合入 main。之后要合进集成分支的：`claude/pause-precise`、`claude/c10-site`（第 10 节）。

## 2. 各分支做了什么（摘要，证据在各自报告）

- **c10-browser**（`AGENT-c10-browser.md`「做了什么」）：
  - 两个跨源舞台与运行配置 `/editor/runtime-config.json`，20 秒握不上手退回同源单舞台；
  - 后台活由父页判空闲、经 RPC 开停，舞台里 `setTimeout(0)` 逐帧；
  - L2（`src/online/l2.ts`）；层表 v2（`server/artifact-transfer.mjs` 的 `layerMapOf`）；在线来源加原尺寸一档；
  - 按拍换快照 `fitBeatSwaps` 与 `SWAP_MS = 3`；
  - 页面发布清单计划（`src/online/planPublisher.ts`，`codeVersion` 在线构建时嵌入）；
  - 逐帧导出续签（`src/export/ticketRenewal.ts`）；`deploy-hosted --stage-origins`；
  - 对 X4 的修改（队列与渲染节点）；独立渲染主机写层表。
  - G0（笔记本）：tsc 0；npm test 3435 / 3433 / 0 / 2。
- **c10-ui**（`AGENT-c10-ui.md` 第 1～3 节）：用户卡、图卡的选帧投递与预取豁免、时间轴徽标；置灰入口与表 A 文案；五条顶栏措辞、常驻提示、离开确认；内存备份与下载；素材服务 `POST merge/…` 回 501；计划文档勘误；在线原尺寸地址 `originalMediaUrl`。G0：npm test 3402 / 3400 / 0 / 2；`/api` 棘轮 120 = 120。
- **c10-cost**（`AGENT-c10-cost.md`「做了什么」）：文档服务成本记录模块 `server/docservice/modules/costs.mjs`；页面侧 `src/editor/sharedCosts.ts`（含桌面转写 `SharedCostRelay`）；界限搜索 `src/render/boundarySearch.mjs` 与页面驱动 `src/editor/lowMemorySearch.ts`；分派的显示表与判定表；补渲只对判重缺产物的层；低内存档导出只取判重卡的原尺寸。G0：npm test 3433 / 3431 / 0 / 2；新单测 40 条全过。
- **c10-tests**（`AGENT-c10-tests.md`）：60 条，参考实现自检 60/60，27 个变异全判红；实现不在时 `npm test` 3181 / 3126 / 0 / 跳过 55。
- **c10-a4**（`AGENT-c10-a4.md`）：见第 4 节第 3 条。
- **tier-reload-seek**（`AGENT-tier-reload-seek.md`）：可播性探测超时后不再重探、暂停中永远停在小尺寸；修 `playability.ts`、`VideoTrack.tsx`、`mediaSync.ts`、`mediaDrive.ts`；`tier-switch-probe` 加 T5c、T5e，修前挂、修后过。

## 3. G0 与 G0-R

出处都是 `docs/archive/agent-reports/AGENT-c10-integ.md`「验证」与「合 c10-a4 之后补跑的 G0 与 G0-R」，全部在 PC 上跑。

### G0

| 提交 | tsc | npm test（总 / 过 / 败 / 跳过） | 构建 |
|---|---|---|---|
| `ebd78e3` | 退出码 0 | 3551 / 3549 / 0 / 2 | `npm run build` 0；`vite build --mode online` 0，产物里嵌的代码版本与 `frameCode(cwd)` 同值 |
| `8bb0cbe` | 退出码 0 | 3553 / 3551 / 0 / 2 | 待核（集成报告没写这一次的构建） |
| `24c2c57`（合 main `a038948` 之后） | 【占位 P1：主会话在 `24c2c57` 或最终集成提交上的 G0】 | 同左；按主执行计划第 8 节，总条数应不少于合并前 main 的条数加本阶段新增（待核：`a038948` 带进 `storeHold` 3 条、`durationSync` 7 条，`docs/reports/AGENT-perf-t4.md`） | 同左 |

跳过的 2 条是 main 原有、显式开启的两条（`集成:/api/cards/layout 对真实项目返回整数框`、`SKILL 闸门:闸关之后无头实例的工具调用不落地`）。C10-T 的 41 条门在合 `c10-browser` 之后全部打开，C10-T 各文件单跑 60 条、0 失败、0 跳过。

### G0-R（不带耗时门槛的各项）

| 项 | `ebd78e3` | `76dab6f`（合 c10-a4 之后） |
|---|---|---|
| `verify-determinism` | 1800 / 1800 相同 | 1800 / 1800 相同 |
| 与 PC 基准（main `d70fce7`）逐像素 | total 1800、identical 1800、different 0、missing 0、extra 0 | 同左 |
| `verify-unified-frames` | PASS | 没重跑 |
| `ready-index-probe` | fails [] | 没重跑 |
| `stream-produce-probe --group` | PASS、fails [] | 没重跑 |
| `preview-fallback-probe` | fails []；99 / 64 / 64 / 63 拍，透明拍数全 0 | fails []；99 / 64 / 55 / 61 拍，透明拍数全 0 |
| 同上 `--page-preload` | fails []；100 / 68 / 61 / 66 拍，透明拍数全 0 | fails []；99 / 66 / 66 / 62 拍，透明拍数全 0 |

- `76dab6f` 之后的运行时改动只有 `ProbeGate.tsx`（只影响在线低内存档）与 `Preview.tsx` 的在线诊断计数，桌面导出路径没动，没再重跑（集成报告的判断）。三项只在 `ebd78e3` 跑过的，理由是 c10-a4 只改父页的暂停态调度。
- 【占位 P2：合 `pause-precise` 之后的 G0-R。它改了 `stageSwap.ts` 的暂停态让路与播放态估时（桌面与在线共用），按 G0-R 要重跑 `preview-fallback-probe` 两种、`verify-determinism` 与像素比较。】

### 带耗时门槛的项（笔记本判，PC 上不作数）

- `stream-produce-probe`（不带 `--group`）「1080p 全幅流 15 帧分段编码 ≤ 300 ms」：`c10-browser` 在笔记本同一时段 A-B-A 交替，分支 p50 704 / 614 ms、main `2a3d763` 1592 ms，只挂这一条、不比 main 差（`AGENT-c10-browser.md`「G0-R」）；`tier-reload-seek` 同样（`AGENT-tier-reload-seek.md` 第 6.3 节）。这是 main 上早已存在的性能缺陷，在修 `claude/perf-encode`（M8 计划 L20）。**待笔记本复核（C10-T1）**。
- `tiers-probe` T4「后台上传期间页面主线程没有 > 50 ms 的长任务」：main `a038948` 合入 `claude/perf-t4` 时合并信息写「笔记本 T4-2 空闲时 3 轮全过」（证据在 `docs/reports/AGENT-perf-t4.md` 与那次合并，本报告没有原始输出）。集成分支 `24c2c57` 已带上这个修复，但没在集成分支上跑过。**待笔记本复核（C10-T1）**【占位 P3：笔记本在最终集成提交上的 T4 三轮】。

## 4. 集成中查出的缺陷与修法

| # | 提交 | 问题 | 修法 | 出处 |
|---|---|---|---|---|
| 1 | `c69b096` | 合 `c10-browser` 时五个文件冲突：`planDispatch.ts`（低内存档两张表 vs `deadMs`，旧名 `setPlanAllHeavy`）、`snapshotFeed.ts`、`snapshotSource.ts`（`skipLayer` vs `this.layers()`）、`onlineExport.ts`、`Preview.tsx` | 两边并存；旧名不留，统一 `setPlanLowMemory`；循环走 `this.layers()` 并保留 `skipLayer` | 集成报告「冲突怎么解的」 |
| 2 | `1e74dbc` | 合并后 6 条 C10-T 判红：K4 层表是平形（被当作「对不上」），K6 发的是清单计划、结果键不是 `<id>@<rev>` | kit 换成 `layerMapOf` 的真形状、加 `planFactoryDeps` 与 `planKeyBase`；`c10-plan-publish.test.mjs` 动了 5 行（判据不变）；`planPublisher.ts` 挂着的请求落定后、期间到期的那一版马上发（C10-PP-05 在 mock 时钟下判红） | 集成报告「kit 对账」 |
| 3 | `fe00dcc`（`c10-a4` 的 `24c62ea`），合入 `76dab6f` | **C10-A4 后半没过**：播放中一张 (b) 档轻卡发起播放态互换、占着 `running`；播放到头与点到 0.5 秒两次暂停态 settle 只记进 `pendingSettleT` 就返回，播放态收手时不交出，停下那次永远不做 | `runPlayingSwap` 收手时把 `pendingSettleT` 交给 `runSettleSwap`（又在播放了就不补）；两条单测修前挂、修后过 | `AGENT-c10-a4.md`「根因」「修法」 |
| 4 | `b45ddc6` | **低内存档分派表一直是 null**：`c10-browser` 让在线低内存档整个关掉 `ProbeGate`，连 `setPlanProject` 也不调；显示表没有判重层（手机播放中全部活渲），判定表为空（补渲一条不发）。两个实现分支各自没撞上 | `ProbeGate.tsx`：预览是舞台就 `setPlanProject`，测量只在非低内存档排；桌面与普通档逐字不变 | 集成报告「合进 claude/c10-a4 与之后的修正」 |
| 5 | `ecb8cd2` | A10 第一次跑，导出 9 秒被取消：探针进入 A10 时创建者还没补满主重卡的清单 | 探针：导出前核对没过就等 15 秒再导，至多 15 分钟 | 同上 |
| 6 | `d4d3663` | `c10-ui-probe` 的 A6 三条判红：探针写于 `c10-browser` 之前，替身层表 v1、按小尺寸 `px/` 判 | 探针：替身层表写 v2；用户卡那一层 `snap/`、`px/` 都要 0，内置卡那一层 `snap/` > 0；判据的意思不变 | 同上 |
| 7 | `8bb0cbe` | 在线普通档「测完写进文档服务」的接线没有探针证据 | `Preview.tsx` 记次数 `window.__pcCostPublish()`；`c10-browser-probe` 在 A2 之后核 | 同上 |

各分支自己查出并修的（不在集成时）：

- `c10-browser` `5b26993`：A2 重开页面时已在 L2 的块又请求了 83 次 → 在线来源等 L2 打开再取，之后 0 次（`AGENT-c10-browser.md` A2 一行）。
- `c10-cost` `742561d`：C10a 就有的并发——暂停时父页对同一秒发两次「停下追一帧」，后一次把前一次画好的层打回抑制 → `Preview.settleLowMemoryAt` 按「最新 setTime + 秒数」去重（`AGENT-c10-cost.md`「偏离」第 5 条）。
- `c10-ui` `cb6f807`：第一次探针发现「丢弃」离线修改后误报「已全部提交」→ 暂停之后交给 C6.5 的离线对话框、不再报（`AGENT-c10-ui.md` 1.3）。
- `tier-reload-seek`：见第 2 节。

## 5. 验收 C10-A1～A10（本机）

本机环境：托管组合 + 三个源的仿 nginx 前缀代理（编辑器页与两个舞台同主机不同端口，全部带 OAC）、桌面 dev server 当创建者、无头 Chrome 当成员（`AGENT-c10-browser.md`「本机真浏览器验收」）。下表数字取集成分支最后一次通过的那一轮（`AGENT-c10-integ.md`「C10-A 本机验收」），`c10-site` 本机替身一轮作旁证（第 10 节）。外网一轮都还没跑（第 7 节）。

| 编号 | 本机结果（提交） | 证据 | 备注 |
|---|---|---|---|
| A1 | 过（`8bb0cbe`） | 舞台 5421、5422 与编辑器页 5420 同站跨源，三页带 OAC，CDP 里各是独立 iframe 目标；宿主能力 A、B 都是 `measure: true, catchUp: true, prerender: false, lowMemory: false`；播放 10 秒主文档长任务 **0**；主重卡快照换 57 帧、按拍投递 271 次；探针帧 4 帧全以 gzip 字节转移（13948 字节）、字符串 0 | 「主文档长任务 0」带耗时门槛：**待笔记本复核（C10-T1）**。子域舞台只在外网一轮验（第 7 节） |
| A2 | 过（`8bb0cbe`） | 加载遮罩出现又退下；L2 `costs` 4 条、全是 `mode=build`；测完写进文档服务 4 次、4 条、失败 0；重开遮罩不再出现、costs 不变、已在 L2 的块重新请求 **0**、L2 命中 3 | — |
| A3 | 过（`8bb0cbe`） | 成员页 `snap/` 342、`px/` **0**；层表 v2；每层 `envFingerprint` 都是创建者的 `258acaaa7c5fe509`；跨源舞台的 `/media` 都打自己的源 | — |
| A4 | 过（`8bb0cbe`；`--only-a4` 另在 `76dab6f` 过一轮，`c10-a4` 分支上连过两轮） | 0.1 秒处 `fit` 7、`deadMs` 23.33，两层显示占位；播放到头点到 0.5 秒后追到精确活渲、3 秒后仍是活渲。`swapTrace`：点 0.5 秒 20277 → 播放态收手 22116 → 暂停态补跑 → 渲完 28381。看过 `a4-settled-live.png`、`a4-placeholder-while-playing.png` | 点下到精确约 8 秒（`AGENT-c10-a4.md` 记 7～8 秒），由 `pause-precise` 修（第 10 节）。耗时相关：**待笔记本复核（C10-T1）** |
| A5 | 过（`8bb0cbe`） | 创建者关掉后改主重卡：页面发布 `plan:<项目>@2#clips:…`、`open`、无报错；独立渲染主机（host 档、测试指纹 `0c10b0e5f1a9e7d2`）认领 3、完成；新层环境是主机指纹、就绪 60 帧；播放中快照文字 `main-v2` | 外网一轮：**待笔记本当独立主机（C10-S1），同时算 HT9**（M8 计划 M8-X2） |
| A6 | 过（`d4d3663`） | 用户卡那一层快照请求 **0**、内置卡那一层 `snap/` 235；徽标只在用户卡上、悬停「该模式暂不支持自定义卡」；舞台 1 个常驻「需要本地 PC 渲染辅助」。看过 `a6-1-user-card.png` | 命令 `c10-ui-probe`，`ok: true, fails: []` |
| A7 | 过（`d4d3663`） | 置灰入口 `disabled` 带表 A 文案、点后新请求 0、页面错误 0；`/api` 守卫拦截 0、`/api` 请求 0；被覆盖与丢弃的备份都能下载；离线措辞与常驻提示照表 A。看过 `a7-4-doc-down-unsent.png` | `/api` 棘轮 120 = 120（`AGENT-c10-ui.md` 第 3 节） |
| A8 | 过（`d4d3663`） | `POST merge/…` → 501 `{"ok":false,"error":"not-implemented"}` | — |
| A9 | 过（`b45ddc6`） | `small-tier-probe`：S1 60 帧 HTML + 60 张 400×225，S2 bad 0，S4 htmlDiff 0。`lowmem-online-probe`：单舞台低内存档；小尺寸视频 3、原尺寸 0、`px/` 2、`snap/` **0**（在线来源 `tier: small`、`store: true`，L2 只存小尺寸）；暂停后追一帧 105 ms；缺原尺寸提示「等待上传方」、到齐后导出 h264 60 帧 + aac。`c10a-demo-probe --local`：368 s 全过；手机原尺寸 0、`snap/` 0；停下追一帧 81 ms；界限搜索 1 条记录测 1 次、补渲 0；改卡后新键 6.1 s、新小尺寸 136 s、整段重渲 186 s，认领顺序 `NNNNNBB`；低内存档导出 300 帧 10.000 s + aac | 外网 `c10a-demo-probe` 这一阶段没跑【占位 P4：部署后是否复跑外网 `c10a-demo-probe`，主会话定】 |
| A10 | 过（`ecb8cd2`） | 票据时限 20 s（测试开关）；等原尺寸齐 5 次（约 75 s）后导出 300 帧、85.5 s；续签 6 次、失败 0；素材地址换票 12 次 | — |
| 成本（契约第 3 节） | 过（`b45ddc6`） | `c10-cost-probe`：桌面 16 张测完、4.1 s 内 16 条写进文档服务；手机 16 条记录、测 6 次（二分 4）、界限第 9 张（B = 23.33 ms）；9 轻 7 重；补渲清单正好是判重的 7 张；播放中 16 层全抑制 | — |
| 通用 | 见第 3 节 | G0 过（`8bb0cbe`）；G0-R 不带耗时门槛的各项过；桌面导出像素与 PC 基准 1800 帧全同 | 带耗时门槛的两项待笔记本（C10-T1） |

没通过就被后来的提交修好、重跑通过的中间结果：`ebd78e3` 上 A4 两条不过（合 c10-a4 前）；`76dab6f` 上 A10 不过（探针时序）；`ecb8cd2` 上 `c10-ui-probe` A6 三条不过（探针没对账）、`c10-cost-probe` 两轮不过（`ProbeGate` 缺陷）（集成报告同节末段）。

## 6. 〔裁〕清单（供用户审）

共 **25 条**：契约 19 条（第 1～19 行），集成期间 4 条（第 20～23 行），主会话认可的分支偏离 2 组（第 24、25 行）；另有 1 条集成方提请、本报告没查到裁定记录的（第 26 行，占位）。「试过什么」一栏：定计划时的〔裁〕写比较过的做法或依据，执行中卡住才定的写实际试过的路。

| # | 出处 | 定了什么 | 试过什么 / 依据 | 为什么不行（原路） | 改了什么 |
|---|---|---|---|---|---|
| 1 | 契约第 2 节、第 18 节首条（D1） | 普通档两个舞台各用一个源，与编辑器页同站跨源，三方都带 OAC；阿里云用子域 `s1.`、`s2.`，certbot 扩证书（免费，不是待用户项） | 探针 P1：同源、同站跨源不加 OAC、同站跨源加 OAC，90 例 3 轮 | 不加 OAC（含同源）每 6 秒 22～44 个长任务、rAF p95 150～345 ms | 契约定形；`c10-research.md` Q1 第 5 条「L1 的 iframe 最好同源」被推翻 |
| 2 | 契约第 2 节（探针 P2） | 后台舞台 `opacity: 0` 原位叠放；父页判空闲、经 RPC 开停；舞台里 `setTimeout(0)` 逐帧；页面隐藏自己停，父页 rAF 间隔持续超过约 500 ms 也停 | P2：移出视口、`visibility: hidden`、舞台里 `requestIdleCallback` | 前两种被节流到每秒约 0.4 次 rAF；舞台里 rIC 每秒只推 1～4.7 帧；浏览器隐藏时不替你停 | 契约定形，三级数字写进 `mechanism/platforms.md` |
| 3 | 契约第 3 节（D5） | 页面按自己的成本记录判轻重、决定怎么显示；层表只决定能取到什么；两者不互相改写 | 设计时定 | 页面与节点的轻重可能不一致 | — |
| 4 | 契约第 4 节、第 18 节首条（D6） | L2 软上限 256 / 64 MiB、自有 LRU、配额错误时一个事务回收 16～64 MiB 再试一次；不依赖 `persist()` | 查资料 Q1；探针 P3（写到 32 GiB 也造不出 `QuotaExceededError`，`persist()` 一律 false） | 浏览器的 `quota` 恒为「已用 + 10 GiB」，靠不住 | 三级数字写进 `mechanism/platforms.md` |
| 5 | 契约第 5 节 | 页面不算键，按层表找清单；版本不一致的层当没有预渲染结果 | 分布式队列设计 Q1「页面不移植键的计算」 | — | — |
| 6 | 契约第 6 节（D8） | 在线按拍换帧不受 `SNAPSHOT_THROTTLE_MS` 的 33 ms 节流，节流只留给非播放时的投递 | 设计时定 | 60 fps 一拍 16.7 ms，节流会让重层每两拍才换一次 | 写进 `mechanism/rendering.md`「兜底顺序」 |
| 7 | 契约第 1、8 节 | `cloud-task.md` L1（后台舞台自驱预渲染）并入 M7，改为按队列认领；两条验收随之移到 M7 | 对照语义与分布式队列设计 Q1 | L1 自驱要页面算键，与 Q1 冲突；先做自驱、M7 再换认领会整个作废 | 主执行计划第 7 节 C10、M7 的验收同步改（`c10-ui` 勘误） |
| 8 | 契约第 9 节 | 用户卡、图卡不贴别人预渲染好的快照 | 按 `product/rendering.md`「兜底顺序」末条 | — | 不改语义 |
| 9 | 契约第 9 节（S11） | 「素材输入的音频图卡报错」并入「电脑 + 离线」图标，不另报错；验收删这一条 | 语义：图卡一律显示图标 | 另报错与语义不一致 | `c10a-contract.md` 表 C 注明取消 |
| 10 | 契约第 10 节 | 在线本地备份不写浏览器存储：「丢弃」或被覆盖时当场给「下载备份」，只留本页内存 | 第 1 版写进 L2 的 `backups` 表 | 用户 2026-09-27 定语义「浏览器本地只放能重新拉回的缓存」，备份拉不回来 | 契约随用户语义改（`7ff0ea8`） |
| 11 | 契约第 18 节第 1 条 | `deadMs = max(0, B − 已占用)`，`B = 1000 / fps × 0.7`，与 `pipelinePlan.mjs` 同一个预算 | C10-T 提出两种口径（拍长 / 预算） | 契约原文口径不明 | 收紧 BS-02、BS-04 |
| 12 | 同上第 2 条 | 回收：一个删除事务删到腾出 `max(16 MiB, 块大小)`，至多 64 MiB；另开写事务重试一次 | C10-T 待定 2 | 原文「回收 16～64 MiB」有两种读法 | — |
| 13 | 同上第 3 条 | 层表 `v` 升到 2，每层加 `contentKey`、`envFingerprint`，由 `layerMapOf` 一处定形；普通档只认 v2 且两项齐的层，低内存档 v1、v2 都认 | C10-T 待定 3 | 契约只说「对不上当没有」，没有判据 | — |
| 14 | 同上第 4 条 | 备份不自动下载；「丢弃」确认后给按钮；被覆盖给不打断的提示；同步面板列全部 | C10-T 待定 4 | 被覆盖每次弹下载入口太吵 | — |
| 15 | 同上第 5 条 | 续签保留 K12 形状，取票复用 `assetTicketSource` | C10-T 待定 5 | — | — |
| 16 | 同上第 6 条 | 用户卡、图卡的豁免放在 `snapshotFeed.ts` 的选帧与投递 | C10-T 待定 6 | — | `c10-ui` 另加快照来源预取的 `skipLayer`（第 24 行） |
| 17 | 同上第 7 条 | `c10-browser` 与 `c10-cost` 的边界（普通档测量与 L2 `costs` 归前者、留订阅口；成本记录模块、界限搜索、补渲归后者；接线归集成） | 派活时定 | — | — |
| 18 | 同上第 8 条 | 低内存档判轻的卡：播放不活渲、没有产物显示占位，不发补渲，停下画出，导出本机逐帧渲 | 照 `product/platforms.md`「面向的平台」读 | — | 作为**二级的观察**告诉用户：要改成「判轻的也补小尺寸」时再改 |
| 19 | 同上第 9 条（`ee00efd`，HT9 跨机实测查出） | 页面发布的 plan 带片段清单、`requires` 不写 `envFingerprint` 与 `preferNode`；带清单的 plan（页面发的与补渲的）`host` 也能认领、用自己的指纹切分；不带清单的桌面 plan 仍按 X4 | 按 X4 原样跑 HT9：环境不同的独立主机（Linux、Chromium 141 的云端容器）领不到 Windows 桌面发布的任何任务 | X4 与发布方指纹要求让契约第 7 节与 C10-A5 做不到；语义（`mechanism/document-service.md`「渲染任务队列」、`product/platforms.md`「渲染节点」）比 X4 宽 | 最小修改：`server/render-queue/*`、`server/render-node/*` 等（`AGENT-c10-browser.md`「对 M6c X4 的修改」）；原有 X4 单测不改照过。**桌面发布的 plan 仍领不到环境不同的主机，这处与语义的出入留作记录**（M8 计划 L18） |
| 20 | `AGENT-c10-integ.md`「主会话的裁定」 | 清单计划用独立的 `#clips:` 键，不与补渲共用 `#backfill:` | 第 18 节第 9 条允许另起构造函数 | 共用键会破坏 C10a 对补渲「必须标 backfill」的校验 | — |
| 21 | 同上 | 独立渲染主机认领清单计划时写层表（`publishLayerMap` 钩子） | 契约没写 | 主机没有推送队列，不写层表页面找不到新键，A5 做不到 | `server/prerender-executor.mjs`、`server/vite-plugin-frames.ts` |
| 22 | 同上 | 两个只给测试用的环境变量 `PROMPTCUT_TEST_ASSET_TICKET_TTL_MS`（5 秒～15 分钟才认）、`PROMPTCUT_TEST_ENV_FINGERPRINT`，生产不设 | A10 要缩短票据时限、A5 要与页面不同的主机指纹 | — | `server/auth/protocol.mjs`、`server/frame-pipeline.mjs` |
| 23 | 同上「合进 claude/c10-a4」 | A4 的修法按语义「停下就精确」修同一缺陷，不算改变桌面行为；诊断 `swapTrace`（内存里最多 40 条）保留；「停下到精确 7～8 秒」「播放态补跑估时没算同场重卡」记为后续 | `c10-a4` 三项 G0-R 结果不变 | 桌面在同一时序下原来也把停下那次吞掉，同样违背「停下就精确」 | 两条后续由 `pause-precise` 做（第 10 节） |
| 24 | `HANDOFF-2026-09-28.md` 第 2.1 节 | 认可 `c10-ui` 的偏离：快照来源预取也跳过用户卡图卡；`SpeakerPicker` 不改；常驻提示放底部；在线「本地备份…」可点；暂停时只挂离开确认；新增四个三级数字 | `AGENT-c10-ui.md` 第 4 节 | — | 四个数由集成写进 `mechanism/platforms.md`「连接状态与离线提示」（`ebd78e3`） |
| 25 | 同上 | 认可 `c10-cost` 的偏离：桌面转写在页面做（编辑器进程没有共享项目的凭证）；显示表与判定表分开；搜索完才发补渲；测量时单舞台临时当后台舞台。并定：遮罩文案照写；搜索后新卡不重拉记录（没记录按重）；舞台侧不另加重复追帧的防护；900 s 重渲超时不追查 | `AGENT-c10-cost.md`「偏离」「需要主会话定的事」 | 任务书写「编辑器进程转写」做不到（没有凭证） | 三级语义 `8ccdac8`（`mechanism/rendering.md`「低内存档」、`mechanism/document-service.md`「成本记录」） |
| 26 | `AGENT-c10-integ.md`「需要主会话定的事」第 1、2 条 | `ProbeGate` 的修法（`b45ddc6`）；两个探针的对账（`ecb8cd2`、`d4d3663`）与 kit 之外改的 5 行测试 | — | — | 【占位 P5：主会话对这两条的裁定；本报告没查到记录】 |

本阶段的语义改动（全是三级，一级、二级没改；供用户一并审）：

- `docs/semantics/mechanism/platforms.md` 新增「在线浏览器模式」一节：两个舞台、后台节拍、L2 的三级数字（`c10-browser`），连接状态与离线提示四个数（`c10-ui` 定、集成写入）。
- `docs/semantics/mechanism/rendering.md`：低内存档界限搜索的数字与做法、「过渡（C10a）」注明退出（`c10-cost`）；在线普通档按拍换快照与 `swapMs` 缺省 3 ms（`c10-browser`，按卡种实测还没做）。
- `docs/semantics/mechanism/document-service.md`「成本记录」：「最新」口径、指纹由文档服务算、500 / 20000 / 5000 条上限、成员才能读写、持久（`c10-cost`）。

## 7. 待跨机复核项

| 项 | 由谁、怎么跑 | 归到 | 状态 |
|---|---|---|---|
| 部署阿里云：`s1.`、`s2.8-219-80-16.sslip.io` 专用 nginx 站点（只给舞台页与 `/media` 反代，三方带 OAC），`deploy-hosted --stage-origins`；先备份 nginx 与 pm2 配置 | 主会话（`HANDOFF-2026-09-28.md` 第 2.3 节第 3 条） | 外网复验的前提 | 【占位 P6：部署时间、提交、备份名、外网核对（`/editor` 与两个子域的响应头、部署写进的 `/editor/runtime-config.json`）】 |
| C10 外网复验 C10-A1～A10 | 笔记本 Chrome 跑 `c10-browser-probe.mjs --site https://8-219-80-16.sslip.io`；「播放 10 秒主文档长任务 0」在外网模式只报数、记 `pending`，笔记本判 | M8 计划 M8-X3（理应在 C10 内做完） | 【占位 P7：外网一轮的结果行】 |
| A5 外网：页面发布清单计划、笔记本当独立渲染主机认领并完成 | `c10-browser-probe.mjs --site … --role creator` + 笔记本 `--role host --run <id>`，经协调口 KV | **C10-S1，同时算 HT9**（M8 计划 M8-X2）；做完补进 `REPORT-HT-a.md` | 本机两轮已过（第 10 节）；【占位 P8：外网一轮的主机报到、认领方指纹、传输、新层就绪】 |
| W-HT-a 的云端一侧（持有任务时在服务器侧 `ss -K` 切一次） | 交接文件写「同一轮做」；云端节点归档后改由笔记本当主机、主会话在服务器侧切 | M8 计划 C5-1；「只能出网」一侧记待跨机复核 | 待核：是否仍在 C10 这一轮做 |
| 带耗时门槛的项：A1 主文档长任务 0、A4 停下到精确的时长、`tiers-probe` T4、`stream-produce-probe` 1080p 编码 | 笔记本（性能基准机）空闲时段 | **C10-T1**；M8 计划第 2.7 节 | 【占位 P3、P9：笔记本回执】 |
| 放本机的项目从浏览器进入（契约第 13 节） | PC 窗口项，不挡合入 | M8 计划 M8-X4 | 没做 |

## 8. 顾问调用记录

| 阶段 | 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|---|
| C10 写契约前 | 查资料（codex，`gpt-6-sol` / `high`） | Q1～Q5：IndexedDB 配额、明文 http 页面缺的 API、媒体元素鉴权、后台 iframe 节流、WebSocket 子协议带凭证 | `docs/plan/c10-research.md`；摘要在契约第 17 节 | 采纳，Q1 第 5 条被探针 P1 推翻（第 6 节第 1 行）；Q5 归 M7 |
| C10 写契约前 | 交互与文案（Gemini，`gemini-3.1-pro-high`） | 离线提示、置灰、后台预渲染的宣示、放本机等 | `docs/plan/c10-ux-draft.md`；核对结论为契约第 17 节表 A | 核对后部分采纳（不采纳 1.6、第 3～5 节，理由在契约第 17 节） |

- 从派活到交接（笔记本主会话）没有调 codex 或 Gemini，各分支报告里也没有（`HANDOFF-2026-09-28.md` 第 9 节末条）。
- PC 主会话接手之后（`c10-integ`、`c10-a4`）：两份报告里都没有顾问调用。A4 与 `ProbeGate` 两处缺陷都在回退梯次第 1 级内由 Opus 查清修好。【占位 P10：主会话核对 PC 这一段有没有调过】
- 第 6 节第 19 行是执行中改计划契约（X4），没有改语义，所以没有走「codex 与 Gemini 各出一轮」的穷尽步骤；如果用户认为 X4 属于二级语义的一部分，这一处要补说明。

## 9. 待用户项

- 审〔裁〕：第 6 节 25 条，尤其第 18 行（二级观察：低内存档判轻的卡播放时一直占位）、第 19 行（X4 修改与留下的出入）、三级语义的三处补写。
- 沿用 C10a 的：真手机扫码（iPhone 相机、微信各一次）；iOS 逐帧导出的最长时长与体积（`REPORT-C10a.md` 第 5 节，M8 计划第 8.3 节）。
- 性能门槛若在笔记本上仍过不了线，改门槛须用户确认（`verification.md`「性能基准机」）。

## 10. 还在做的两条分支（报告不在本分支）

### `claude/pause-precise`（C10-A4 的两条后续，M8 计划 L21）

- 起点 `24c2c57`，端口段 5640～5649。任务：停下时正在跑的播放态补跑立即让路、暂停态第二路马上开始；播放态互换按整场景估时，追不上不发起。
- 已有提交（`git log claude/pause-precise`）：`a294726` 报告开工、`da84010` 单测（修前失败）、`5b0815b` 修、`3cfad42` 探针报「点停到精确活渲」的时长、`346df2f` 修（整场景推帧速率与积压用同一个单帧数）。
- 报告状态：进行中（代码与单测已提交，探针与 G0-R 在跑）。
- 【占位 P11：修前 / 修后的「点停到精确」时长、`--only-a4` 轮数、G0、G0-R；合进集成分支的提交】

### `claude/c10-site`（外网复验探针）

- 起点 `24c2c57`，端口段 5420～5429；只改 `scripts/probes/c10-browser-probe.mjs` 与报告。加了 `--site`（外网模式）、`--role host --run <id>`（独立主机角色，经协调口 KV 报到）、`--role creator`（A5 等外部主机，没有主机报到记 `pending`、不算失败）。
- 本机两轮（机器上同时有十来个子智能体）：
  - 本机替身 all：退出码 0、`ok: true`、417 s；长任务 0、主重卡不同帧 57、投递 270、`fit` 7 `deadMs` 23.3；`snap/` 338、`px/` 0；L2 costs 4、重开 refetched 0、l2Hits 3；A5 主机 claimed 3 / completed 1、transport ws、新层指纹 `0c10b0e5f1a9e7d2`、ready 31、播放贴着 `main-v2`。
  - 本机 creator + host（经阿里云协调口 KV，run `c10loc0928a`）：两边退出码 0；主机报到 11 s；认领方 host 档、指纹 `0c10b0e5f1a9e7d3`（与页面、创建者都不同）、transport ws、resumes 0；新层 ready 31；主机退出码 0；结果与日志里没有令牌。
- 外网一轮：【占位 P7、P8】

两份报告在主会话把分支合进集成分支时再挪进 `docs/archive/agent-reports/`（第 12 节）。

## 11. 遗留（去向：M8 计划第 5 节）

| 遗留 | 出处 | M8 计划编号 |
|---|---|---|
| 停下到精确活渲 7～8 秒、播放态补跑估时没算同场重卡 | `AGENT-c10-a4.md`「没做成的」第 1、2 条 | L21（`pause-precise` 在修） |
| 1080p 分段编码超门槛 | 第 3 节 | L20（`perf-encode` 待笔记本复核） |
| 桌面发布的 plan 领不到环境不同的独立主机（X4 与 J.3） | 第 6 节第 19 行 | L18（只记录，E6 两个方向都跑） |
| 在线构建按编译期 `ONLINE` 剪掉置灰入口背后的调用，让 `/api` 棘轮清单变短 | `AGENT-c10-ui.md` 第 5 节第 2 条；`docs/plan/TODO.md` | L24 |
| 在线页面仍直接用 `media.url` 的几处：`c10-ui` 已改量尺寸、打包、卡片素材与 `/pcm`，`SpeakerPicker` 认可不改 | `AGENT-c10-ui.md` 1.7 | L15（C10 合入后 grep 核一遍） |
| T9「改卡后 5 s 内重测」只在不限速或 1 MB/s 下判；Windows 上 `card-costs.json.*.tmp` 改名偶发 `EPERM` | `AGENT-tier-reload-seek.md` 第 6.5 节 | 第 2.7 节（重测）；L16（EPERM） |
| 生成快照的样式内联代价 | 契约第 14 节、`AGENT-c10-probe.md`「旁证」 | L13（id 改名的平方复杂度已由 main `bb01107` 修） |
| `SWAP_MS` 按卡种实测没做，仍是缺省 3 ms | `AGENT-c10-browser.md`「没做完的」第 3 条 | 没有对应编号（待核：建议并进 M7 或 M8 维护项） |
| 在线舞台握手成功后又断的处理沿用 iframe 重载，没有另做退回 | 同上第 4 条 | 没有对应编号（待核） |
| L2 的 LRU 是近似的（读命中不落盘） | `AGENT-c10-browser.md`「偏离」 | 不是缺陷，只记录 |
| 界限搜索之后的新卡不重拉记录（桌面后来补测的，这次会话用不上） | `AGENT-c10-cost.md`「需要主会话定的事」第 4 条 | 主会话已定不做（第 6 节第 25 行），只记录 |

## 12. 报告归档

本分支已用 `git mv` 挪进 `docs/archive/agent-reports/` 的（提交 `7069423`）：

- `AGENT-c10-a4.md`、`AGENT-c10-browser.md`、`AGENT-c10-cost.md`、`AGENT-c10-integ.md`、`AGENT-c10-probe.md`、`AGENT-c10-tests.md`、`AGENT-c10-ui.md`、`AGENT-tier-reload-seek.md`。

留给主会话合入时再挪的（不在本分支）：

- `claude/pause-precise` 的 `docs/reports/AGENT-pause-precise.md`；
- `claude/c10-site` 的 `docs/reports/AGENT-c10-site.md`。

没有挪的：`docs/reports/AGENT-perf-t4.md`（`claude/perf-t4` 是 main 上的维护分支，`a038948` 合入，不是 C10 的子智能体，由主会话决定随哪一次归档）。

归档后仍写着旧路径 `docs/reports/AGENT-…` 的地方（本分支只写文档，没改）：`docs/plan/c10-contract.md` 第 142 行；`server/test/c10-kit.mjs` 文件头；`src/render/snapshot/renameSceneIds.ts`、`src/render/playability.ts`、`src/render/mediaDrive.ts`、`src/render/mediaSync.ts` 与两个单测的注释；`scripts/probes/c10-stage-probe.mjs`、`scripts/probes/tier-switch-probe.mjs` 文件头。C10a 归档时代码注释也留着旧路径（例如 `server/test/c10a-kit.mjs`），是否统一改由主会话定。

## 13. 占位清单

| 占位 | 位置 | 等什么 |
|---|---|---|
| P1 | 第 3 节 G0 表 | 主会话在 `24c2c57` 或最终集成提交（合 `pause-precise`、`c10-site` 之后）上的 G0 |
| P2 | 第 3 节 G0-R | 合 `pause-precise` 之后的 G0-R（`preview-fallback-probe` 两种、`verify-determinism`、像素比较） |
| P3 | 第 3 节、第 7 节 | 笔记本在最终集成提交上的 `tiers-probe` T4 三轮（C10-T1） |
| P4 | 第 5 节 A9 | 部署后是否复跑外网 `c10a-demo-probe`（主会话定） |
| P5 | 第 6 节第 26 行 | 主会话对 `ProbeGate` 修法与探针对账的裁定 |
| P6 | 第 7 节 | 阿里云部署的时间、提交、备份名与外网核对 |
| P7 | 第 7、10 节 | 外网 `c10-browser-probe --site` 一轮的结果行（C10-A1～A10，M8-X3） |
| P8 | 第 7、10 节 | 外网 A5：笔记本当独立主机（C10-S1 / HT9 / M8-X2） |
| P9 | 第 7 节 | 笔记本复核 A1 长任务、A4 停下到精确时长、1080p 编码（C10-T1） |
| P10 | 第 8 节 | PC 主会话这一段有没有调 codex / Gemini |
| P11 | 第 10 节 | `pause-precise` 的回执：时长、探针、G0、G0-R、合入提交 |
