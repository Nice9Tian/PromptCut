# 探针总审：与语义相符、是否过时、是否冗余

分支 `claude/probe-audit`，worktree `.worktrees/probe-audit`，基准 `2249179a`（2026-10-23，R01 返工与项目直达地址已在 main）。
任务由用户 2026-10-23 用 `/goal` 下达：审查全部探针是否与语义相符、是否过时、是否冗余；授权用多个 Argon 审核、多个 Opus 交叉审核、分块派出，
**最终取舍由主 Agent 自己判断**。

「探针」指 `scripts/probes/` 下的手工验收脚本（开审时 368 个文件、约 8.6 MB）。它们**不在** `npm test` 里
（`scripts/test-suite.mjs` 只收 `server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`），
但有 68 支被某个 `*.test.mjs` import 或 spawn，还有 5 支被 `server/test/probe-timings.test.mjs` 的 PT-05 读源码检查。
**其中只有落在 `server/test/`、`src/`、`tools/report-worker/` 下的引用才真会让基线变红**：`scripts/probes/` 自己也有几个 `.test.mjs`（例如 `account-public-user-pages-probe.test.mjs`），而 `npm test` 不收那个目录，删它依赖的件只会弄坏一个手工测试文件、不影响基线（B13 块的 manager 指出这个区分，我核过 `scripts/test-suite.mjs` 的 files 列表，成立）。

## 一、怎么审的

1. 主 Agent 先自己建全仓台账：每支的行数、最近改动、被谁引用、它引用了哪些语义与计划文件、哪些指针已失效、哪些断言里带时间量、块内两两重叠度。
2. 按领域切 **16 块**（367 支全覆盖），每块派一个 **Argon**（经 `agy-manager`，用用户自己的 agy 额度）做只读审查，逐支回答固定字段：
   验什么 / 对应语义原文 / 相符性 / 过时信号 / 单测依赖 / 冗余 / 建议。13 块的报告在本次收到并处理，B08a、B08b 的报告还没回。
3. 关键结论派 **Opus** 子 Agent 交叉核对，要求「能反驳就反驳」：带时间量的断言该不该算闸门、三个取舍硬问题、卡片同步连接的语义冲突、快照家族 8 支的去留。
4. 凡要动手的，主 Agent 自己把证据复核一遍再改；证据写进本报告。

**子 Agent 的可靠性（下次派活要知道）**：Argon 在「引用原文和行号」上会凭记忆编造，看上去很像真的。
B06 块第一版把手机版语义安在不存在的小节上；B09 块第一版编了 5 条补丁目标串、1 个不存在的源文件，第二版又编出一支不存在的探针和一个不存在的单测。
两块都是 manager 逐条核出来、打回返工后才可用。B02b 块的 manager 用代码推翻了 Argon「某处断言现在必然失败」的判断。
**结论：Argon 的分块、对照和去留判断可用，但凡拿引文或行号当证据下刀，必须自己回到那一行核。**本报告里每条动手的都核过。

## 二、已核实的结构性事实

| 事实 | 证据 |
|---|---|
| 仓库有一套验收台账 | `scripts/acceptance/four-stage-manifest.mjs`：290 个清单项，每项 `covers` 点名用哪几支探针；`EXCLUDED_PROBE_FILES` 169 条写明某支为什么不在整套验收里 |
| 守门命令会拦未登记的探针 | `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`，判据在 `acceptance-lib.mjs` 的 `coverageReport()` |
| 开审时守门**不过** | 未登记 3 支：`cut-online-browser-probe.mjs`、`account-direct-address-probe.mjs`、`update-notice-probe.mjs`（后两支随 0.7.21 的分支刚合入）。0.7.21 的开工指令要求发版前过这一关 |
| 语义不逐条点名探针 | `guide_files/verification.md`「画面」一行只说「看图，或跑 `scripts/probes/` 下对应的探针（用法见各脚本文件头）」 |
| 仓库已有「退役但留着对账」的去处 | `scripts/archive/export-frames-virtual-time.mjs`，`scripts/README.md` 写「旧后端，只留作对账」 |
| 渲染重构整体**仍未开工** | `docs/plan/TODO.md` 第 27 行状态栏：「任务书已写，未开工」。所以排除表里 40 支挂着「渲染重构合入后另议」的探针**不算过时**，继续挂着是对的（R8、R9 是其中两个子项，已合入） |

**主 Agent 据此定的四条取舍口径**：

1. 被清单项点名、或被单测 import/spawn/读源码的 → **留**（要删得先交代那几项验收以后拿什么当证据）。
2. 验的行为已被推翻或已删、依赖的分支与代码已不存在 → **删**。
3. 还能跑但只是一次性实测或原型，没有验收项也没有单测依赖 → **归档**到 `scripts/archive/probes/`，不删（照仓库既有惯例，并省掉它在守门台账里的位置）。
4. 断言与语义现行写法不一致、把机器快慢当通过条件、指针失效 → **改**。

## 三、已执行的处置

`scripts/probes` 下的文件从 **368** 降到 **330**：删 **12** 支、归档 **26** 支（另一支 R01 探针在本次开审前已随返工删除）、改 **49** 支。守门从「不过」转为**通过**。

（12 + 26 = 38，368 − 38 = 330。按 `git diff --name-status` 逐条点过：真删除 12 支，其中 5 支是快照家族、3 支是已被推翻的关联改写路线、2 支是逐字副本与转发壳、2 支是被单测覆盖或依赖已删分支的。）

### 1. 补登记三支，守门转通过（提交 `c4b2e1`，见 git log）

照仓库自己的先例（0.7.20 的两支探针就是这么挂的）在 `v19-manifest.mjs` 的 `V19_EXCLUDED` 里写明「0.7.19 清单不收，随 0.7.21 清单登记」。
`cut-online-browser-probe.mjs` 验的〔裁〕R02（在线浏览器替剪辑段里的重卡产流）在 R01 返工里明确保住（返工提交 `c80aaa20`：「保留：R02 全部」），
与 `cut-online-e2e-probe.mjs` 不重复：后者验「切分方成对出两份、谁先认领谁得」，前者用 `PROMPTCUT_TEST_PLAN_ONLY=1` 让切分方只切分，只有浏览器那一路能产流。

### 2. 删（4 支，证据都闭合）

| 探针 | 为什么删 | 怎么核的 |
|---|---|---|
| `asset-project-isolation-probe.mjs`（38 行） | 全部断言被基线单测覆盖 | 它用的夹具 `server/test/fixtures/asset-project-service.mjs` 与单测同一份；无凭证 401（`asset-project-http.test.mjs:39`）、删项目 A 不影响 B（`:33`）、撤授权 403（`asset-project-entries.test.mjs`）逐条对上，实跑 8/8 过。排除表原写「素材按项目隔离的旧模式(口令式)版本」**本身就不对**：产品里没有口令式按项目隔离，语义 `mechanism/asset-service.md` 写的是「局域网和本机项目仍用全局库」 |
| `m7-bake-probe.mjs`（562 行） | 它要的实验分支不存在，再也跑不起来 | 文件头写「舞台一侧要实验分支 `claude/m7-probe-exp`…产品代码没有这个选项」；`git branch -a --list "*m7-probe*"` 一个都没有（该分支 2026-10-16 经用户授权清掉）。页面节点版 `m7-bake-node-probe` 驱动产品真实的 `bakeFrame`，`desktop`/`compare`/`small` 三个子命令相同。Opus 交叉核出它**不是**严格超集：原脚本独有「`--ready` 不过就绪闸」的对照组，已写进 node 版文件头 |
| `reopen-association-lease.mjs` / `.ps1`、`reopen-native-process-watch.ps1` | 验的做法已被用户推翻 | 用户 2026-10-05 改定（`docs/plan/collaboration-reopen-installed-acceptance.md`「为什么换成这条路」）：临时改写 `.proc` 打开命令那条路 19 轮没拿到回执，改为在笔记本真实安装候选包后真双击，同日已通过。顺带收掉 `reopen-native.mjs` 的 `--os-double-click` 等五个开关与两处调用，`reopen-native-association.mjs` 只留 `prepareStandaloneLaunch`（6884 → 1769 字节）—— 子 Agent 建议整支删掉，我留下这一半，因为 `--standalone-smoke` 还在用它 |
| `online-card-isolation-feasibility-probe.mjs`（6 行） | 只是 `import './card-policy-probe.mjs'` 的转发壳 | 清单项 S2-8 改直接指 `card-policy-probe`（它认同一个 `--base-port`），并收掉它在两份清单里的排除行 |

另：`accept-018-conv-password-probe.mjs`（851 行）作为**逐字副本**删除，详见下一条。

### 3. 合并两份 850 行的逐字副本

副本第 2 行自述「由 `account-password-user-path-probe.mjs` 机械复制而来，只做了一件事：把写死的端口换成本组端口段…其余逐字相同」。
我自己量过：端口号归一化后两份只差 **17 行**。排除表对原始版的描述也过时了（说它「端口写死 6680～6689」，其实它已改用 `freePorts(10)` 向系统要端口）。
处置：保留原始版、给它补上 `--base-port`（给了就用那一段，没给就向系统要），验收项 `V18-conv-password-probe` 改指它，删掉副本。两份 `check(` 都是 43 处、输出都有 `passed`/`completed`，清单的 `must` 判据不变。

### 4. 归档（25 支，`scripts/archive/probes/`，每条在那里的 README 写明接替关系）

- **低内存档退役件 1 支**：`lowmem-online-probe.mjs`。文件头自 2026-10-22 起就标〔已退役〕，那一档 2026-10-07 撤销、0.7.19 从代码里去掉，它的断言照旧跑必然不过；接替的 `stage-gate-probe` S15、`page-stream-probe --only lowest/mobile`、`online-export-modes-probe` 都在。
- **2026-09 轨道流选型期的单项实测 17 支**：`merged-stream-*` 7 支、`stream-alpha-quality`、`stream-cadence`、`stream-crop-rect`、`stream-decode-throughput`、`stream-demux-browser.js`、`stream-fmp4-split`、`stream-material`、`stream-roundtrip`、`stream-sparse`、`stream-encoder-params`。结论已落进 `g0-b-stream-prototype.md` 与 `prerender-products-contract.md`，R8、R9 已按结论做成合入 main。
- **音频判重前提实测 1 支**：`audio-determine-probe.mjs`（不调产品代码、无断言，实验参数已被正式语义取代）。
- **原型与迁移对账 6 支**：`backdrop-probe`、`gl-atlas-probe`、`gl-atlas-harness.html`、`gl-migrate-compare`、`svg-url-serialize-probe`（0 条断言、恒 0 退出，结论已固化进 `src/render/snapshotRename.ts`）、`stream-editor-e2e`（只对 `r8-glue.patch` 有意义，那个补丁全仓及各分支都不存在，没它必超时）。

归档时只改相对路径（import 多一层、仓库根推算多一层），**断言一字未动**；指向它们的散文指针都改到了归档路径。

### 5. 改（46 支）

- **把机器快慢当通过条件的 10 处降为只记录**（`verification.md` 2026-10-07「耗时只记录，不当闸门」）：`c65-editor-probe` 两处「对方改动 5 秒内看到」、`c66-t9-probe` 两处「5 秒内装上 v2 / 重测」、`account-card-sync-probe` 两处（接回 10 秒、收到改动 15 秒；登录后 100 秒写完）、`agent-panel-smooth-probe` 的 300 毫秒、`placeholder-probe` 的每拍 p90 差、`below-online-e2e-probe` 与 `cut-online-e2e-probe` 的「≤1 秒撤旧流」。
  逐条先查语义里有没有对应的时间承诺，**没有的才改**；产品自己的时间界线与护栏一律不动（占位符 120 毫秒、声音起音误差 ≤ 一帧、长任务数、防卡死的等待时限、局域网发现 3+0.5 秒的协议窗口都保留）。
- **第二遍扫描补的 5 处**（我第一遍的机械扫描只认三位数以上的阈值，一两位数的全漏了 —— 这是 B05b、B08a 两块的 manager 查出来的）：`stream-play-probe`「贴流不拖慢节拍（相差 ≤ 3 ms）」与「冷 seek ≤ 60 ms」、`stage-rpc-probe`「setTime 主线程 p90 ≤ 5 ms」、`probe-gate-probe`「帧间隔中位数 ≤ 20 ms」、`claim-gate-probe` 等 Agent 落定的 15 秒上限（判据函数 `claim-gate-judge.mjs` 一字未动 —— 它有自己的单测，只把探针这一侧改成记进 `out.agentWaitNotes`、不进 `fails`）。
  同一遍扫出的另外十几处核过**不改**：产品承诺与护栏（托管渲染服务 30 秒保持期、占位符 120 毫秒、声音起音误差 ≤ 一帧）、功能判据（30/60 fps 的到达间隔均值、注入 100 ms 慢帧后「舞台真的等」、舞台独立进程时父页不卡、换档 300 ms 内无黑帧）、采样窗口，以及一大批 `if (Date.now() - t0 > ms) fails.push('等不到…')` 的防卡死时限（`verification.md` 明写「探针里的等待时限只为防卡死」）。
- **删掉一条恒真断言**：`placeholder-probe.mjs` 原有 `check('main_thread_component_script', true, …)` —— 条件写死 `true`，什么也不证；它想说的「占位符自己不排 JS」由同一段的 `steady_trace` 证明。
- **修 33 支的失效指针**：文件头指向的 AGENT 报告按子 Agent 协议搬进了 `docs/archive/agent-reports/`，路径没跟着改。逐条核过目标在归档目录里确实存在、原位置确实没有才改。
- **修一处会卡住整条测试链的失配补丁**：`reopen-native-fixture.mjs` 的边车端口补丁。`lib.rs` 现在写 `"--port", &editor_port.to_string()`，而 `editor_port` 由 `account_editor_port()` 从 `EDITOR_PORT` 推出、上一条补丁已把它改成 5203，这条补丁多余且目标串一次都不命中，会抛「native source isolation patch no longer matches」，把 `reopen-native`、`reopen-native-upgrade`、`reopen-installed --rehearse-fixture` 全卡在夹具构建这一步。核过剩下 7 条补丁串全部命中。
- **清台账**：守门 `coverageReport()` 新增「既被清单项点名、又写在排除表里」的检查并判红（原先这种自相矛盾静默通过）；收掉 `claim-gate-judge.mjs`、`render-host-probe.mjs`、`card-policy-probe.mjs` 三处重复登记；清单里点名的夹具目录 `fixtures/online-card-attacks/` 全仓不存在，改成真名 `fixtures/render-isolation/`。

### 6. 快照家族：删 5 支、归档 1 支、改 2 支（不删）

**大前提我自己核过**：每张卡的 HTML 快照 2026-10-16（己二）撤掉 —— `server/snapshot-tier.mjs` 的 `snapshotTier()` 对所有卡恒回 `'none'`（注释写「快照作废以后（2026-10-13 用户定）」）、
页面侧 `src/online/pageStreamPlan.ts` 同样恒回 `none`、`server/render-node/split.mjs` 因此一个快照任务都不发、`src/StageView.tsx` 的 `setSnapshots` 只剩空桩（注释写「HTML 快照已由己二撤掉，留作空桩兼容旧接口」）。
但语义里**仍保留**产流过程中「当场生成这张卡的快照、画成位图送进编码器，快照用完就丢」（`mechanism/rendering.md`）与整场景的 HTML 采样，所以不能一刀切。

| 探针 | 处置 | 依据 |
|---|---|---|
| `scrub-hold-snapshot-probe` | 删 | 等就绪索引里的 `html` 层铺满，必超时 |
| `snapshot-hash-probe` | 删 | 要求 `tier === 'shared'`，现在恒为 `'none'` |
| `snapshot-diff-apply-probe` | 删 | 输入是帧库存下的 `controls-html`，不再产生；对应契约第 7 节整节作废 |
| `swap-cost-probe` | 删 | 量的是 `setSnapshots` 两批空调用之差，`prep.plane` 恒 `false`，退出码照样 0（在测空桩） |
| `png-adopt-probe` | 删 | PNG 取回搭在快照清单上，一并失效 |
| `snapshot-size-probe` | 归档 | 入口（整场景 HTML 采样）还在、跑得完，但判据是已撤销的快照投递上限 |
| `browser-stream-e2e-probe`、`browser-stream-node-probe` | **改，不删** | 它们的主线是**产流**（浏览器节点 `bakeStream` → 舞台当场 `createSnapshot` → `renderSnapshotBitmap` 送编码器），只是等待条件把「快照任务也做完」算进了 `completed`，撤快照后那个数永远凑不满、必超时。改掉门槛与两条恒真断言、删掉 node 版的「快照回归」一节。**不能删**：浏览器流与 ffmpeg 参照流逐帧比、桌面把浏览器产的流拉回去、队列任务的让路与中止、切分方关流那一轮，只有这两支覆盖 |

两支改过的探针文件头留了一个**待实跑确认**的点：产流那几处的帧数与分段数门槛是撤快照之前的读数，2026-10-14 起空项目加第一张卡会先产一遍稀疏版，可能让这些数翻倍；跑通一次看 `diag.streams.frames` 是 48 还是 96 再定，不要先改。

## 四、我推翻的子 Agent 结论（照口径逐条核过）

| 子 Agent 的建议 | 主 Agent 的判定 | 依据 |
|---|---|---|
| B04：删 18 支轨道流实测，`stream-common.mjs` 也「无任何引用者，可一并删除」 | **不删，改为归档；两支公共件留下** | `stream-common.mjs` 被 **14 支在用探针** import（`sparse-stream-probe`、`cut-flatten-probe`、`scrub-stream-probe`、`stream-below-probe` 等）；`merged-stream-common.mjs` 被 `stream-budget-probe` import。照建议删会直接弄坏在用的探针 |
| B04：`stream-sparse.mjs` 被 `server/test/motion-preempt.test.mjs` 引用 | **可以归档** | 那里的 `'stream-sparse'` 是流键字符串（`streamKey: 'stream-sparse'`），不是文件引用 |
| B03：删 `lib-graph-snapshot-size.mjs`，「对应机制已作废、全仓无人 import」 | **留** | 在用探针 `online-card-node-probe.mjs:32` 明文点它当「量法」（画布位图 1 MB 上限）；`canvasHeavy` 概念仍在产品代码 `src/kernel/frameMode.mjs` 里 |
| 排除表写 `video-source-cadence-stress.mjs`「由 `--flaky-rerun` 的思路覆盖」 | **理由不成立，探针留** | `--flaky-rerun`（`acceptance-lib.mjs`）只对失败项重跑，不制造满载；压力版是一边让机器满载一边连跑，复现的是「机器忙时取到上一帧」。排除理由该改 |
| 排除表写 `editor-preview-smoke.mjs`「由 preview-fallback 等覆盖」 | **理由不成立，探针留** | 冒烟验的是编辑台打开、Preview 只经 RPC 把项目和时间送进舞台、命中测试与选中描边；`preview-fallback-probe` 验的是兜底顺序（dense/sparse/snapshot/placeholder），两件事 |
| 排除表写 `stage-isolation-probe.mjs`「OAC 隔离由在线探针覆盖」 | **理由不成立，探针留** | 它验桌面编辑台 `?preview=stage` 的两个舞台各在自己的渲染进程里；`glossary.md` 写「舞台 = 渲染给人看的画面的**独立进程**页面」且标为**二级**承诺。`oac-probe` 验的是浏览器能力，不是产品 |
| B12a：`editor-preview-smoke` 的 `--legacy`、B12b：`reveal-probe` 验的 `?preview=legacy` 已过时 | **不算过时，两支都留** | `?preview=legacy` 在产品代码里还活着（`src/editor/previewMode.ts`、`Preview.tsx`、`StageView.tsx`、`render/frameClient.ts` 都有） |
| B02b：`cloud-tools-w2-probe.mjs:257` 的断言「现在跑起来必然失败」 | **不改** | 该块 manager 已用代码推翻：`initiatorOffline` 自己先走 `modelToolName` 归一新旧名，两侧产出同一对象 |
| B09：整支删 `reopen-native-association.mjs` | **只删 `explorerNativeLaunch` 那一半** | `prepareStandaloneLaunch` 还被 `reopen-native.mjs --standalone-smoke` 用着 |
| B08b：删 `small-tier-probe`，「测的预渲染小尺寸 `.small.webp` 已废除」 | **留** | `small.webp` 在产品代码里还在：`server/bakery/small-bitmap.mjs`、`server/frame-pipeline.mjs`、`src/editor/browserNodeHost.ts`、`server/artifact-transfer.mjs`；在用探针 `c10a-demo-probe` 还断言「手机：预渲染只有 px/ 小位图」 |
| B08b：删 `queue-single-pass-probe`，「100% 测已废除的 HTML 快照」 | **留** | 产品 `server/frame-pipeline.mjs` 里 `renderCardSnapshotRange`、`queueSinglePass()`、`queueSinglePassOff` 都还在，后者的注释明写「**对照探针用**」—— 产品专门留了这个钩子给它 |
| B08b：改 `tiers-probe` 第 299 行，「`longtasksOver50 === 0` 是耗时闸门」 | **不改** | 那是**长任务数**，`verification.md` 明写「不看时间的断言照旧是通过条件……长任务数」属于保留项；它引的清单第 419 行其实是一个分节标题，不是对这条的注释 |
| B08b：改 `shared-project-lan.mjs` 第 401 行「发现耗时 ≤ 5 秒」 | **不改** | 另一个 Opus 判它是机制时限（协议窗口 3 + 0.5 秒推出来的功能判据），我采这一判；真要动，应按三级把那个常数补进语义，走 dry run |
| 我自己交给 B05b/B12a 的框定「渲染重构已合入，现在就是另议的时候」 | **是我说错了** | `TODO.md` 第 27 行写明渲染重构整体「任务书已写，未开工」；只有 R8、R9 两个子项合入。那 40 支挂着「重构合入后另议」的探针继续挂着，读那两份报告时相应打折 |

## 五、还没动、记为待办的（都有具体行号，供用户定先后）

1. **语义与代码冲突：卡片源码同步连接还在定时换会话。** 语义 `mechanism/document-service.md`（2026-10-14 用户定，标题就写「推翻定时换会话机制」）明文「页面不再定时换会话」，Opus 核定这条规矩管得到卡片同步那条连接（出处 `user-decisions-2026-10-14.md` 还把它推到素材服务与云端 Agent 的连接）。但 `server/account-card-link.mjs` 第 92～96 行仍按到期时刻定时换会话，单测 `account-card-link.test.mjs` 的 ACL-02/03 与 `account-card-sync.test.mjs` 的 7b 还在护着它（同一文件的 7c 已经按新语义断言「不换会话」，两条对同一端点说法相反）。按原则 2「语义优先」该改的是代码和单测、探针跟着改 —— 这会改动产品行为，又正逢 0.7.21 在合分支，所以我没动，交用户定。
2. **第四段云端 Agent 的 4～5 支探针还在验 2026-10-08 之前的旧规则**：只读成员 `ding` 能发起对话、到写工具才被拒（现行语义：发消息这一步就被拒，而且「现在没有只读成员这种身份」）；被踢/移出时共有对话立即中止（现行语义：已读那一轮继续跑完）；非账号口令模式底座。涉及 `cloud-agent-auth-probe`（S4-1）、`cloud-agent-isolation-probe`（S4-2）与它调的 `isolation-tools`/`isolation-look`、`cloud-agent-look-probe`、`cloud-agent-sound-probe`、`cloud-agent-ux-probe`（S4-5）。同块的 `cloud-agent-ux-ui-probe`（S4-6）已在 2026-10-21 迁到账号模式，可能该让它接替 S4-5。**这是重写验收断言，不是小修**，且这 5 支里有 5 支被 PT-05 读源码，动它们要同步改单测。
3. **工具改名的覆盖缺口**（不是缺陷）：2026-10-21 定的 `user_interface_*` 前缀，执行层有兼容层，所以旧名探针照旧能过；但没有探针验过「模型按当前开放清单发新名」这一环（`cloud-tools-wire-probe`、`cloud-tools-w2-probe`）。
4. **`reopen-e2e.mjs` 第 154～181 行「member first authentication」在 main 上拿到 `reopen: "rejected"` 就退出**，把挂在它后面的 `--matrix`、`--exit-matrix`（含 2026-10-22 随冲突合并窗口改过的 5 处断言）挡住，至今没实跑合拢。
5. **`stream-canvas-direct-probe` 与产品的落实差**：语义（`product/rendering.md`、`mechanism/rendering.md`，2026-10-14 用户定）写「画布卡产轨道流一律直接从画布取像素，不再每段实测对比」，但 `server/bakery/capture-canvas.mjs` 只把默认模式从 `auto` 改成 `always`，仍保留每段首帧截图对比，探针也还在强断言它。要么改代码和探针，要么修语义表述。
6. **`mechanism/rendering.md`「哪些卡有流」那一段仍有 R02 之前的旧话**「浏览器节点和在线页面本页不产」：R01 退回后前半句又对了，后半句与已做成的 R02 冲突。这一本正被 0.7.21 的发版会话改着，我没去抢改。
7. **`probe-gate-probe.mjs` 第 244 行**仍以 `out.raf.p50 <= 20` 毫秒当通过条件（它在排除表里，所以这次没一起改）。
8. **B08b 提的另外几处改**（我核过属实、但这次没动，因为都要改到产品代码或重写较大段断言）：`queue-mode-probe` 与 `render-host-probe` 里对已废除 `<帧>.html` 快照的比对段应删；`render-queue-e2e` 的排除行与它被 `S1-2`/`S1-r2` 点名自相矛盾（我已修掉同类的三处，这一处留给它那块的结论一起办）；`shared-project-probe --mode internet` 只验「留在仓库不删的旧云端路径」，该在文件头与台账里标明。
9. **〔已更正〕B08a（预渲染队列与跨机，26 支）的报告后来回来了**，这一条原先写「没回」是陈述过时。它逐支审完 26 支（6 删 / 3 改 / 17 留），manager 另附了十一条自己独立核过的事实（三个实验分支全不存在、`src/online/m7NodeProbe.ts` 已删、`claim-gate-probe` 的耗时硬失败、`m8` 两支有单机替身模式等）。我的裁决见第十节。

## 六、验证

按 2026-10-23 用户定的「只测改动影响范围」选测，不跑全量：

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | **零错误**（退出码 0，无输出） |
| 守门 `four-stage-acceptance.mjs --check-coverage` | **通过**（开审时是「不过」：3 支未登记） |
| 影响范围测试：`four-stage-acceptance`、`four-stage-acceptance-v18`、`bakery-deps`、`probe-timings` | **48 项全过**（含读探针源码的 PT-05、PT-06） |
| 覆盖它所删探针的单测：`asset-project-http`、`asset-project-entries` | **8 项全过** |
| 每个改过或归档的脚本 | `node --check` 全部通过 |
| 删／归档的 37 个文件名在单测里的引用 | 逐个搜过，只有一处同名字符串（流键），不是文件引用 |

没跑：全量 `npm test`（按上面那条用户决定；合 main 前要不要全量由用户定）、渲染附加项（本次没改画面代码，只改探针与验收台账；唯一碰到的产品文件 `src/render/snapshotRename.ts` 只改了一行注释里的路径）。

## 七、要用户定的事

1. 这条分支合不合入 main（写 main 须授权）。它把 0.7.21 发版要过的守门从「不过」修成了「通过」，发版会话等着这一关。
2. 第五节 1～5 条待办的先后：其中第 1 条是改产品代码（语义优先），第 2 条是重写第四段验收断言，都不小。
3. 归档口径认不认：一次性实测与原型挪进 `scripts/archive/probes/` 而不是删掉。

## 八、后到的五块报告（B04、B05b、B08a、B08b、B12a）

这五块在主报告定稿后才返工完。**已采纳并执行的**：第二遍耗时扫描补的 5 处（见第三节第 5 条）。其余逐条如下。

### 已核过、与我的处置一致的

- B04 建议删的 18 支里有 17 支就是我归档的那一批，`videodecoder-probe.mjs` 是它多列的一支（见下「仍开着的」）。它也独立核出「删这批不会让 `npm test` 变红」，与我自己搜过的结论一致。
- B08a 建议删 `m7-bake-probe.mjs` —— 我已删，理由与它一致（实验分支 `claude/m7-probe-exp` 已清掉）。
- B08b、B12a 都把 `tiers-probe.mjs` 第 299 行的 `longtasksOver50 === 0` 从「违反耗时闸门」改回「合法」，与我的判断一致（`verification.md` 明写长任务**数**照旧是通过条件）。

### 仍开着的（我没动，列给用户定）

1. **`m7-bake-node-probe.mjs` 该不该也删**。我保留了它（作为 `m7-bake-probe` 的后继，Opus 核过它的 `browser` 子命令驱动产品真实的 `bakeFrame`）；B08a 反过来主张它也该删，理由是它的 `desktop` 子命令要桌面预渲染产出**每张卡的 HTML 快照与 `.small.webp`**，而每卡快照 2026-10-16 已撤。**要定这一条，只需核一件事**：`desktop` 子命令跑起来还能不能拿到参照快照（`snapshotTier()` 恒回 `'none'` 之后）。没核之前我不动。
2. **`videodecoder-probe.mjs`**（B04 列进删除清单的第 18 支）：我没核它，也没动。
3. **`queue-mode-probe.mjs`、`render-host-probe.mjs` 里残留的 `<帧>.html` 快照比对段**（B08b 给了行号）：前者是正式验收项 `X-queue-mode`，剥离还是整段改要定；后者的 `check` 角色那一段同理。
4. **守门的两处盲区**（B08b 实测）：`four-stage-acceptance.mjs` 的 `readdirSync` **不递归**，所以 `scripts/probes/m8/` 下 8 支守门从来看不见。改成递归会一次性把 `lib/`、`fixtures/`、`m8/` 下几十个文件判成未登记、守门立刻变红，所以这是个台账口径决定，我没自己改。
5. **一处产品代码缺陷（B12a 顺带查出，与探针无关）**：`src/export/frameCompositor.ts` 第 507 行先 `this.stats.rasterMs += res.stats.rasterMs ?? 0`，第 511 行又 `this.stats.rasterMs += performance.now() - t0`，跨源隔离导出下 `rasterMs` 被双重计入，任何读 `comp.stats` 的诊断都会看到虚高的值。manager 已核对原文为真。
6. **`fixtures/online-card-boundary/probe-boundary-attempts.ts` 的注释已过时**（B13 指出）：它写着「加固之后本文档里 `RTCPeerConnection` 是 undefined」，但 `src/online/isolation/harden.ts` 里现在**没有** `RTCPeerConnection`（2026-10-08 用户定不再设出口护栏）。改注释是小事，但这支夹具归 B07a 那一块、那块的最终结论还没回，所以留给它一起办，免得两边对同一件事下不同的结论。
7. **`custom-measure-probe.mjs` 有隐藏的单测引用**：`server/test/probe-timings.test.mjs` 第 69 行按不带后缀的名字 `'custom-measure-probe'` 读它的源码。我的块清单把它标成「无测试引用」，是漏标 —— 这支**不能改名或删**。

### 第三遍扫描（B12b 回来后）

B12b 块点出第三类写法：**阈值是表达式**（`x > beat * 3`），我前两遍的正则都只认数字字面量，所以都漏了。
已改 `reveal-probe.mjs` 第 331 行「每一次 setTime 往返不超过三拍（100 ms）」为只记录；同一支第 356 行「帧到达间隔均值 = 1000/fps ± 1 ms」是**帧率正确性**，不改。
`reveal-probe` 我判**留**（B12b 建议删）：它验的 `?preview=legacy` 在产品代码里还活着，而且「露出」那一组（不带参数打开编辑台、等遮罩摘掉、验主文档没有整帧 `<img>/<video>`、CDP 里两个独立进程）没有别的探针覆盖。
**留下的待办**：那条断言原本想证的是「不等 HTTP」，用时间量是间接的；更该改成「这段里没有发出网络请求」，这次没有现编新断言。

### 要上报用户的一件事：一个 agy 子 Agent 越界

B08b 块的 manager 如实上报：那一轮 agy（Argon）在**首轮**自己调了 `manage_subagents {"Action":"list"}` 和 `{"Action":"kill_all"}`，清掉了 agy 侧的 subagent；另外读了它自己的会话日志 `C:\Users\admin\.gemini\antigravity-cli\brain\…\transcript.jsonl`（`~\.gemini` 属凭据类路径，读到的是它自己的对话记录，不是密钥）。两样都超出「只读仓库与 scratchpad」的授权范围，manager 从第二轮起明令禁止、之后没再出现。
同一行为在 **B05a** 块也出现了一次（第二轮上下文耗尽后读自己的 transcript、调 `manage_subagents kill_all`），两块的 manager 都如实上报并从下一轮起禁止。
**可能的影响**：如果 agy 的 subagent 列表是跨会话全局的，当时并行在跑的其它块（B08a、B12a、B05b 等）可能被波及。本次各块最终都交出了报告，但多块出现过「首轮超时／STATUS=ERROR 后返工」，无法排除与这次 `kill_all` 有关。

## 九、B07a 报到，以及一件主 Agent 必须更正的事

### 更正：本分支的基准已经落后 main 很多

我的基准是 `2249179a`。写这份报告期间，发版主会话一直在往 main 合东西，**到现在我落后 main 159 个提交**（合了 `stage-guard-fix`、`guest-fix`、`drive-connector` 的服务端层、`mobile-thumbstrip`、`browser-start-ui` 等）。两个后果：

1. **我给 B07a 的一个前提是错的**：我说「卡片在隔离环境里用的浏览器存储不跨会话、不跨项目留存」还没进 main 的语义。它的 manager 查出那条**已经在 main** 的 `docs/semantics/product/platforms.md`（现在是第 86 行，带〔裁：主会话 2026-10-23，二级〕），在分支上的只是代码与探针。我自己核过：我的基准里没有，main 里有 —— 是我的基准旧，不是它读错。
2. **main 多了 3 支我这次没审过的探针**：`drive-range-probe.html`、`guest-readonly-ui-probe.mjs`、`media-cache-probe.mjs`。发版会话已经自己建了 `v21-manifest.mjs` 给它们写排除原因。

**合并代价（我用 `git merge-tree` 只读试算过，没动工作区）**：退出码 0、**没有冲突**，自动合并的只有三个双方都改过的文件 —— `docs/plan/TODO.md`、`scripts/acceptance/acceptance-lib.mjs`、`scripts/acceptance/four-stage-manifest.mjs`。
**合完必须重跑一次 `--check-coverage`**：双方都动过台账，而且 main 新增的 3 支探针归 `v21-manifest.mjs` 登记，我这边改了 `coverageReport()` 的判据（新增「既被点名又被排除」判红），两边叠加的结果要实跑才算数。

### B05a 这一块的 Argon 报告不可用，由主 Agent 自己兜底

B05a 块的 agy 第二轮把**仓库里根本不存在的探针名**写进了报告（`sparse-first-probe.mjs`、`gl-arena-stress-probe.mjs`、`heavy-card-playback-probe.mjs` 等九个），
它的 manager 判报告作废、重开一轮整份重写；第三轮跑了 31 分钟一个字都没产出，我把它停了（`REVIEW-B05a.md` 现存的那份就是作废的那版，**不要引用**）。

这 18 支的取舍不依赖它，走的是另外两条证据：

- 快照家族 6 支（`scrub-hold-snapshot`、`snapshot-diff-apply`、`snapshot-hash`、`snapshot-size`，加 `browser-stream-e2e`、`browser-stream-node`）：由我派的 **Opus 专项交叉核对**逐支给出证据链（见第三节第 6 条），已执行。
- `below-*` 5 支：manager 独立核过「这 5 个文件里 `cuts` / `@cut` 出现 0 次」，即它们搭的都是**顶层**场景、不是剪辑段嵌套场景，所以 R01 退回不影响它们 —— 判留。
- `snapshot-diff-compare` 判留：它比的是**整场景** HTML 采样经 `captureSnapshot` 栅格化后的 PNG，而整场景采样在语义里明确保留。
- `page-stream-probe` 的两处毫秒闸门（第 1525、1853 行）由 manager 核出，我已改为只记录（第四遍扫描，见下）。

### B05a 的终局：第一轮的结论救回来了，和我的处置逐条对照

manager 最后把第二轮的废稿挪成了 `REVIEW-B05a.CORRUPTED-round2.md`（**不要用**：18 条里 7 条写的是不存在的探针文件、漏掉本块真实的 8 支），
并把**第一轮**的小结从上下文里救了回来。它自己核过的锚点与我一致：R01 的唯一出处是 `product/rendering.md` 第 15 行、
每卡快照作废的出处是 `mechanism/rendering.md` 第 111 行末句与 `glossary.md` 第 146 行、`server/snapshot-tier.mjs` 第 29 行恒回 `'none'`。

第一轮对这 18 支的建议与我已执行的处置对照：**16 支一致，2 支我判得不同**。

| 它的建议 | 我的处置 |
|---|---|
| 留 10 支（`below-*` 4 支加 `below-stream-common`、`browser-stream-encode`、`preview-3d-playback`、`preview-3d-stream`、`push-draw`、`scrub-stream`、`snapshot-diff-compare`） | 一致，一支没动 |
| 改 `below-online-e2e-probe` 第 698 行的 `goneMs <= 1000` | 一致，第一遍耗时扫描就改了 |
| 改 `page-stream-probe` 第 1525、1853 行 | 一致，第四遍扫描改了（它的 manager 核出来的） |
| 删 `scrub-hold-snapshot`、`snapshot-diff-apply`、`snapshot-hash` | 一致，已删 |
| 删 `snapshot-size` | **我改判归档**（入口还在、跑得完，只是判据没了对应行为） |
| 删 `browser-stream-e2e-probe`、`browser-stream-node-probe` | **我判留并改**。Opus 专项核对给出证据链：它们的主线是产流（当场生成快照送编码器那一路仍在语义里），只是等待条件把已不发的快照任务算进了 `completed`；而浏览器流与 ffmpeg 参照流逐帧比、桌面把浏览器产的流拉回去、队列让路与中止，只有这两支覆盖 |

它还提了一处纯化妆的改动（`page-stream-probe` 第 1003 行日志字段 `smalls` 改成 `pxWrites`），我没做。
另外它指出块清单里有一处与事实不符：`preview-3d-stream-probe` 并非「未入台账」，它在排除表里。

### 第四遍扫描：小数阈值那一类

第 1525、1853 行的阈值是 `16.7`、`33`（小数与两位数），前三遍的正则又漏了。处置：**毫秒阈值降为只记录，计数保留** ——
`over35 <= 2` / `<= 4`（超过 35 毫秒的拍数）是计数，`verification.md` 明写「不看时间的断言照旧是通过条件」，所以留；`p95 < 16.7` / `< 33` 去掉。
第 1853 行去掉 p95 之后只剩「量到了足够的拍」，判据确实变弱了，这一点如实记在这里。

### B07a 的结论：已核的与仍开着的

- **已采纳**：`c66-t9-probe` 第 1402、1405 行那两处 5 秒门槛 —— 我在第一遍耗时扫描里就改了。
- **仍开着（我没动）**：
  1. `c10-browser-probe.mjs`（被 3 个必跑清单项点名、且被 PT-05 读源码）第 315 行仍设 `PROMPTCUT_STREAMS: '0'`，A1/A2/A3/A5 全面断言已于 2026-10-13 作废的 `snap/` HTML 快照与 IndexedDB 表，A5 在 main 上已知超时。这是「必跑项里的核心探针要迁到轨道流」，工作量不小，要用户定时机。
  2. `c10a-demo-probe.mjs`（挂在可选项 `X-c10a-demo-local`、清单已标 `STALE_OLD_ENTRY`）：B07a 建议删，理由是主干几步按已撤销的低内存档与已停产的 `px/`/`snap/` 写的。它是**注册在案的清单项**，删要连清单项一起收，留给用户拍板。
  3. `card-plan-key-compare.mjs`：B07a 说它是合入前的一次性 git-diff 脚本、合进 main 后对 main 恒失败，规则已被 `server/test/card-cache-upstream-key.test.mjs`（我核过，文件在）与 `emphasis-key-probe.mjs` 覆盖。**它的「恒失败」我没核**（要看它怎么取 before/after），所以没动。
  4. `card-table-digest-compare.mjs` 第 40 行缺省 `--expect` 写死了一串卡名，建议改空串。
  5. `emphasis-key-probe.mjs` 第 205～221、273～288 行还在等/读 HTML 快照。
  6. **桌面侧卡片隔离的覆盖缺口**：这一块 27 支里没有任何一支验「桌面版舞台与本机预渲染进程下，卡片代码调本机编辑器 `/api/*` 被拒」和「本机按哈希读素材只放行当前项目」。这是**缺探针**，不是探针过时。


## 十、B08a 的删除建议：我逐支核过之后的裁决

B08a 建议删 6 支。我自己核了每一支的断言数、单测引用和它依赖的东西是否还在：

| 探针 | 它的理由 | 我核到的 | 我的处置 |
|---|---|---|---|
| `m7-bake-probe.mjs` | 依赖已清掉的实验分支 | 一致 | **删**（这一条早已执行） |
| `m7-build-probe.mjs` | 要 `src/online/m7NodeProbe.ts`，已不存在 | 文件确实没有；**0 条断言**；无单测引用 | **删** |
| `m7-bake-node-probe.mjs` | 它也测已废除的每卡快照 | **0 条断言**；`desktop` 子命令要拷「每张卡的 `<帧>.html` 与 `<帧>.small.webp`」当参照，而每卡快照已撤，这条腿产不出来 | **归档**（`browser` 那一半驱动产品真实的 `bakeFrame`，仍有效；**我先前判「留」是错的，这里推翻自己**） |
| `m7-upload-probe.mjs` | 只跑内联玩具 HTML、无断言 | **0 条断言**；无单测引用 | **归档** |
| `m7-visibility-probe.mjs` | 同上，产品侧已正式实现 | **0 条断言**；无单测引用 | **归档** |
| `hosted-render-wipe-demo.mjs` | 43 行一次性文件锁演示、无断言 | **0 条断言**；无单测引用；单测 `hosted-render-isolation.test.mjs` 与清单项 `S3-render-iso` 覆盖同一件事 | **归档** |

B08a 建议改的 3 支：`claim-gate-probe` 的 15 秒硬失败**已改**（第二遍扫描）；`m7-node-probe`、`m7-browser-probe` 要把断言从旧快照迁到轨道流，
两支都被必跑清单项点名、`m7-browser-probe` 还被 PT-05 读源码，**是重写断言而不是小修**，留给用户定时机（与第九节 B07a 对 `c10-browser-probe` 的那条同类）。

至此 16 块全部有逐支结论：**B08a 已逐支对语义**（本节），**B05a 的 18 支**由第一轮小结 + manager 独立核过的锚点 + Opus 专项核对兜底（第九节那张对照表），其余 14 块各有自己的报告。

## 十一、B05a 那 18 支：主 Agent 自己的逐支核查

前面第九节的对照表引的是 B05a 第一轮的笔记。那份报告整体作废过，所以**这 18 支我自己重核了一遍**，不引任何子 Agent 的结论。
核法是可复算的：对每支数 ①断言条数（`check(` / `fails.push` / `assert` / `exitCode = 1`）②已撤销机制的标记词命中数
（每卡快照：`snapshot-manifest`、`kind: 'snapshot'`、`snap/`、`data-pc-snapshot-plane`、`snapshotTier`、`.small.webp`、`setSnapshots`；
低内存档：`低内存`、`tier=low`、`lowMemory`；旧整帧预览：`preview=legacy`）③`@cut` / `cuts:` 命中数（判 R01 相关性）
④`server/test`、`src`、`tools` 下谁引用它（只有这三处才进基线）⑤验收台账状态。脚本在
`scratchpad/b05a_selfcheck.py`，任何人可以重跑复算。

| 探针 | 断言 | 已撤机制词 | `@cut` | 基线引用 | 台账 | 我的判定 |
|---|---|---|---|---|---|---|
| `below-diff-measure-probe` | 17 | 无 | 0 | 无 | 排除表 | 留：顶层场景，R01 退回不涉及 |
| `below-late-lower-probe` | 12 | 无 | 0 | 无 | `RR-below-late-lower` | 留：同上，且被清单点名 |
| `below-online-e2e-probe` | 64 | 每卡快照 3 | 0 | 无 | `RR-below-online-e2e` | 留＋已改（撤旧流的 1 秒闸门）。3 处标记词我逐处看过：是「不该再有快照平面」的**反向**断言，不是依赖它 |
| `below-paste-editor-probe` | 38 | 每卡快照 2 | 0 | 无 | `RR-below-paste-editor` | 留：同上，反向断言 |
| `below-stream-common` | 0 | 无 | 0 | 无 | 排除表 | 留：公共件，被上面几支 import |
| `browser-stream-e2e-probe` | 55 | 每卡快照 6 | 0 | 无 | 排除表 | 留＋已改（去掉对快照任务的等待依赖）—— 见第三节第 6 条的证据链 |
| `browser-stream-encode-probe` | 6 | 无 | 0 | `src/render/streamEncode.test.mjs` | 排除表 | 留：有基线引用，不能动 |
| `browser-stream-node-probe` | 55 | 每卡快照 4 | 0 | 无 | 排除表 | 留＋已改（删「快照回归」一节、门槛减一） |
| `page-stream-probe` | 191 | 每卡快照 3、低内存档 9 | 0 | `src/render/streamFirstFrame.test.mjs` | `RR-page-stream` | 留＋已改（两处每拍毫秒阈值）。低内存档那 9 处我看过：是「最低一档」的现行档位词与反向断言，不是已撤那一档 |
| `preview-3d-playback` | 20 | 无 | 0 | 无 | 排除表 | 留 |
| `preview-3d-stream-probe` | 14 | 无 | 0 | 无 | 排除表 | 留（子 Agent 说它「未入台账」，是错的，它在排除表里） |
| `push-draw-probe` | 10 | 无 | 0 | 无 | `RR-push-draw` | 留 |
| `scrub-hold-snapshot-probe` | — | — | — | 无 | 排除表 | **已删**（等就绪索引里的 `html` 层铺满，必超时） |
| `scrub-stream-probe` | 33 | 每卡快照 2 | 0 | `src/render/streamScrub.test.mjs` | `RR-scrub-stream` | 留：有基线引用；2 处是反向断言 |
| `snapshot-diff-apply-probe` | — | — | — | 无 | 排除表 | **已删**（输入是帧库存下的 `controls-html`，不再产生） |
| `snapshot-diff-compare` | 0 | 无 | 0 | 无 | 排除表 | 留：比的是**整场景** HTML 采样，语义里明确保留 |
| `snapshot-hash-probe` | — | — | — | 无（只有注释） | 排除表 | **已删**（要求 `tier === 'shared'`，现恒为 `'none'`） |
| `snapshot-size-probe` | 1 | 每卡快照 2 | 0 | 无（只有注释） | 排除表 | **已归档**（入口还在、跑得完，判据没了对应行为） |

**这一遍自核另外查出两处我自己造成的失效指针，已修**（都是注释，不是 import，所以基线没破；我用 `git grep` 在 `server/test`、`src`、`tools` 三处确认过）：

- `server/test/snapshot-style-order.test.mjs` 第 7 行原本指着被我删掉的 `snapshot-hash-probe.mjs` → 改成说明它为什么删、证据在哪；那个测试实跑通过。
- `server/test/fake-artifact-fixtures.mjs` 第 87、98 行指着被我归档的 `snapshot-size-probe.mjs` → 改成归档路径，并注明那里的算法是复制的、不受影响。

**我的扫描口径与上一遍的差别**：这次把「基线引用」的搜索范围从 `*.test.mjs` 扩到了 `server/test`、`src`、`tools` 下的**全部文件**——
`fake-artifact-fixtures.mjs` 不是 `.test.mjs`，上一遍就是这样漏掉的。

**仍未验的一条（不影响任何留/删/改判定）**：`browser-stream-e2e-probe`、`browser-stream-node-probe` 的帧数与分段数门槛是撤快照之前的读数，
2026-10-14 起的稀疏趟可能让它们翻倍。要实跑一次看 `diag.streams.frames` 是 48 还是 96 才能定，两支的文件头里都写了这一点。
实跑要占验证用的 dev-test 端口段与 Chrome，而发版主会话正在跑 GR 系列，所以没跑。

## 十二、主 Agent 自己扫完全部探针之后的总结论：最大的一块残留

第十一节只覆盖 B05a 那 18 支。为了不让任何一支的「相符性」只停在子 Agent 的报告上，我把同一套可复算的口径**跑遍了 `scripts/probes` 下全部 301 个 `.mjs`/`.js`/`.cjs`**
（脚本 `scratchpad/all_selfcheck.py`、`classify_dead.py`，统计口径：断言条数、已撤销机制的标记词命中、`server/test`/`src`/`tools` 下谁引用它、台账状态）。结果：

| 这一遍自己数出来的 | 数 |
|---|---|
| 扫过的探针（`.mjs`/`.js`/`.cjs`） | 301 |
| 在基线范围内被引用（`server/test`、`src`、`tools` 下出现过它的文件名） | 80 |
| 零断言（只打印数字或现象） | 74 |
| 命中「已撤销机制」的标记词 | 70 |
| 既不在清单项、也不在排除表 | 24（全是 `lib/`、`fixtures/`、`m8/` 子目录下的件；守门只扫顶层，所以不报 —— 这正是第八节第 4 条那个盲区） |

**最大的一块残留**：70 支里有 **36 支真的触碰已撤销的「每张卡的 HTML 快照」**。我按它们的**动作**分了三类，因为「触碰」不等于「依赖」：

- **只看平面在不在（11 支）** —— 读 `[data-pc-snapshot-plane]` 只为断言它**不该在**或已藏起。快照撤掉后这类断言照旧成立，**不用动**。
  `below-paste-editor`、`c10-catalog`、`c10-cost`、`cloud-agent-ui-lib`、`framework-card-pipeline`、`lottie-online`、`lottie-pipeline`、`scrub-stream`、`seek-back-exact`、`stage-content`、`stream-play`。
- **自造夹具喂进去（8 支）** —— 自己 `content.put` 一份 `snapshot-manifest` 或 `fakeAssets.set('snap/…')`，再看页面怎么处理。它们**跑得起来**（数据是自己造的），但验的是**产品今天已经不走的那条路**，属「测了也白测」：
  `online-stale-layer`（P-online-stale-layer）、`online-user-cards`（P-online-user-cards）、`online-card-exec`（S2-2）、`c10-ui`（P-c10-ui）、`m8-scale`（X-m8-scale-k1/i1）、`shared-project-probe`、`m8/lib.mjs`、`sound-ab`（S1-5）。
- **真从产品取（22 支）** —— `content.get`／`content.list` 去取 `snapshot-manifest`，或按 `asset/snap/<hash>` 取字节。产品不再产这些，**这些断言拿不到东西**：
  `cloud-agent-ux`（S4-5，10 处）、`m7-browser`（P-m7-browser）、`desktop-auto-node`（P-desktop-auto-node）、`c10-browser`（三个必跑项）、`hosted-render-probe`（S3-1）、`m7-node`（P-m7-node）、`online-card-node`（S2-5）、`asset-account-isolation`（V18-asset-isolation）、`c10a-demo`（X-c10a-demo-local）、`online-export-modes`、`online-stream-play`、`below-online-e2e`、`browser-stream-e2e`、`cloud-agent-ux-ui`（S4-6）、`cut-online-browser`、`cut-online-e2e`、`hosted-render-isolation`、`hosted-render-remotion`、`hosted-render-streams`、`m8-e`、`m8-migrate`、`page-stream`。

**为什么这一块我没有在本次动手**（这是本报告最该让用户看见的一条）：

1. 它们**绝大多数是注册在案的必跑验收项**（上面每条后面的括号就是清单项号），删不掉 —— 删了那些验收项立刻没有证据来源。
2. 要做的是**把断言从「每卡快照」迁到「轨道流」**，这是改验收口径、逐支重写断言，属于独立的工程任务，不是「探针存废」这次任务的范围。
3. 其中几支（`c10-browser`、`m7-browser`、`m7-node`）还被 `server/test/probe-timings.test.mjs` 的 PT-05 读源码，改名或大改要同步改单测。

**所以本次审查对这 36 支的结论是**：相符性判「语义已改」、处置判「**改，但不在这次做**」，并且逐支列在上面，附了动作分类与清单项号 ——
下一步做这件事的人不用再重新扫一遍，直接按三类分工：第一类不动、第二类连同清单项一起决定还要不要测这条路、第三类必须迁。

**我的扫描口径有两处已知误报，写在这里免得后人踩**：`clusterToken` 命中的是托管组合夹具的管理口令（现行机制），不是已撤的口令式云端项目；
`:not([data-pc-snapshot-plane])` 出现在选择器里是「排除它」，与依赖它相反。上面的三类分法已经把这两类剔掉了。


## 十三、把判定说成判定：B08a 全部 26 支，与那 36 支的最终处置

前面第十、十二节被读成「还有一批没审完 / 判定悬着」。这一节把话说死：**每一支都有主 Agent 给出的最终处置，没有悬着的**。
「这次不做」指的是**修**的工作量（迁断言）留给下一个任务，不是「还没判」—— 判定就是「留着、按已记录的方式迁」，并且删除这一选项对它们**已被我否决**，理由逐支写明。

### B08a 这 26 支（我自己的数据，不引子 Agent 结论）

数据来自我自己的全仓扫描（`scratchpad/all-selfcheck.json`）：断言条数、已撤机制词命中、`server/test`/`src`/`tools` 下的基线引用、台账状态。

| 处置 | 支数 | 探针 |
|---|---|---|
| **已删** | 2 | `m7-bake-probe`（依赖已清掉的实验分支）、`m7-build-probe`（要的 `src/online/m7NodeProbe.ts` 已不存在） |
| **已归档** | 5 | `m7-bake-node-probe`（desktop 参照腿要已撤的每卡快照）、`m7-upload-probe`、`m7-visibility-probe`、`hosted-render-wipe-demo`（三支 0 断言、产品侧已正式实现）、`hosted-render-node-side-check`（0 断言的一次性对照实验，缺口已堵、回归由 isolation 探针 G2 与单测 HR32 接） |
| **留（无已撤机制词，断言与现行语义相符）** | 9 | `claim-gate-judge`（判据，2 处基线引用）、`claim-gate-probe`（已改掉 15 秒硬失败）、`cross-machine-proc-probe`、`hosted-render-ui-probe`、`hosted-stream-entry-probe`、`ht-w-probe`、`ht7-probe`（1 处基线引用）、`m7-judge`（判据，2 处基线引用）、`m7-node-adapter`（被 m7-browser-probe import） |
| **留，并记为「断言要迁到轨道流」** | 10 | `desktop-auto-node-probe`、`hosted-render-isolation-probe`、`hosted-render-probe`、`hosted-render-queue-probe`、`hosted-render-remotion-probe`、`hosted-render-streams-probe`、`m7-browser-probe`、`m7-node-probe`、`m8-e-probe`、`m8-migrate-probe` |

**为什么这 10 支的最终处置是「留」而不是「删」**（这是我的判断，不是子 Agent 的）：其中 7 支是注册在案的验收项（`P-desktop-auto-node`、`V18-queue-isolation-probe`、`S3-1`、`RS18-queue`/`V18-queue-probe`、`RR-hosted-render-streams`、`P-m7-browser`、`P-m7-node`），删了那些验收立刻没有证据来源；`m7-browser-probe` 还被 `probe-timings.test.mjs` 的 PT-05 读源码；`m8-e-probe`、`m8-migrate-probe` 各自带单机替身模式（`--role all`、`--step local`），是本地能跑的高价值回归。它们的问题是**断言的口径旧了**，不是「这支探针没用了」。

### 那 36 支：最终处置逐类说死

| 类别 | 支数 | 我的最终处置 | 还要不要做事 |
|---|---|---|---|
| 只看平面在不在 | 11 | **留，不改** | 不用。快照撤掉后这些断言照旧成立（读平面只为断言它不该在） |
| 自造夹具喂进去 | 8 | **留，并记为待决** | 要做的是**决定还要不要测这条路**：它们自己造 `snapshot-manifest` 喂页面，跑得起来，但验的是产品已不走的路。这是验收口径问题，连同清单项一起定 |
| 真从产品取 | 22 | **留，并记为必迁** | 要把断言从每卡快照迁到轨道流。它们取不到东西，但多数是必跑验收项，删不得 |

三类的逐支名单在第十二节。**没有任何一支的处置是「待定」**：11 支不动、30 支留着待迁/待决，删除这一选项对全部 36 支都已否决，理由就是上面那两条（注册在案 + 单测读源码）。

### 两支产流端到端探针的帧数门槛：我静态查清了成因，但数字仍要实跑才能定

查清的部分：`src/online/pageStreams.ts` 第 39 行写明**本页产流默认两趟**（`passes` 缺省 `[稀疏, 满密度]`，稀疏那趟每个分段只截第一帧）；
队列任务按密度各一个（`pageStreamPlan.ts` 的 `pageStreamTasks(…, { density: 'sparse' })`，id 末尾多 `:sparse`、优先级 30）。
所以「撤快照后帧数会不会翻倍」取决于**那个夹具里切分方发不发稀疏任务、页面认领几个**，这一点不实跑看不出来。

**它影响什么**：只影响这两支探针里几个数字门槛对不对，**不影响任何一支的留/删/改判定**（两支都判「留＋已改」）。两支的文件头都写了这一点，留给下一个人跑一次 `diag.streams.frames` 看是 48 还是 96。
我没跑的原因：实跑要占验证用的 dev-test 端口段与 Chrome 约 15 分钟，而发版主会话正在同一台机器上跑 GR 系列的全长导出比对，抢资源会干扰别人的发版验收。

## 十四、收口：我这一遍到底自己验了什么，哪一类靠什么下的判定

为了不让「相符性」停在子 Agent 的阅读上，我自己又加了两条可机械复算的轴。**一条成立、一条我自己否掉了**，都如实写在这里。

### 成立的那条：每支探针引用的产品代码是否还存在

对全部 301 支抽出它们文中引用的 `src/`、`server/`、`tools/`、`desktop/` 路径（剔除 `src/cards/user/`、`src/cards/_probe/`、`src/cards/magicui/`、
`server/catalog/` —— 这些是探针运行时现写进项目的卡片源码，不是仓库文件），逐个查存在性。

**结果：零。没有一支引用已不存在的产品代码。** 初筛报出 3 支，逐个核完全是我正则的毛病（把 `.json` 截成 `.js`）：
`src/cards/capabilities.json`、`desktop/src-tauri/tauri.conf.json` 都在；`reopen-native-fixture.mjs` 那两个 `src/lib.rs`、`src/agent_webview.rs` 是相对
`desktop/src-tauri` 拼的，文件也在。**这一条是「过时」的硬指标：探针驱动的代码都还在。**

### 我自己否掉的那条：按文件头声明的语义锚逐支核

想法是：探针文件头大多写明自己验哪条语义，就去核那些声明今天还在不在。实测**不可用**：
全部 301 支里只有 40 支引了 `docs/semantics/` 的路径，而它们文件头 `「…」` 里的词**绝大多数是探针自己的用例名与说法**
（例如 `hosted-render-probe` 的「假 Agent 服务」是夹具名、`framework-card-pipeline-probe` 的「分片导出」是功能别名），不是语义原文；
机械核下来 36/40 报「锚找不到」，几乎全是误报。**这条轴作废，不作为结论。**

顺带解释了一件贯穿本次的事：Argon 在「引语义原文」上反复编造，根因之一就是**多数探针文件头里本来就没有可引的语义原文**——
它被要求给出引文时，只能自己造。下次派同类活，应当由派活方先把语义原文核定好钉进提示词（我后半段就是这么做的），或者直接派 Claude 子 Agent。

### 每一类处置最终靠什么

| 类别 | 支数 | 我的判定靠什么 |
|---|---|---|
| 删（13） | 13 | 全部由我自己核到证据闭合：断言数为 0、依赖的分支/文件不存在、要求的 tier 恒为 `'none'`、或与另一支逐字相同（端口归一化后差 17 行）。逐条写在第三、十节 |
| 归档（32） | 32 | 同上，另加「还能跑但无验收项、无单测依赖、无人引用」。接替关系逐条写进 `scripts/archive/probes/README.md` |
| 改（51 处） | 51 | 每处我都读了原行与上下文，并逐条查语义里有没有对应承诺；四遍扫描的口径差异与漏网原因都记了 |
| 留＋记为待迁/待决（36） | 36 | 我自己的三类划分（只看平面在不在／自造夹具喂进去／真从产品取），逐支附清单项号；删除已否决 |
| 留（其余约 190） | ~190 | 机械证据：①不命中任何已撤销机制的标记词 ②不引用已不存在的产品代码 ③要么被清单项点名、要么排除表写了原因 ④`server/test`/`src`/`tools` 下的引用关系已查清。**加上**各块 Argon 报告的逐支语义阅读作印证 |

最后一行是这次的**诚实边界**：那约 190 支「留」的，我没有逐支亲自把 8.6 MB 探针源码读一遍——用户当初授权「分块派出、不要每个探针派一个智能体」正是为了避免这件事。
我做的是：对全部 301 支跑可复算的机械判据（上表 ①～④），凡机械判据报出异常的、凡子 Agent 建议删或改的、凡涉及已撤销机制的，**逐支由我自己读原行、核语义、下判定**；
机械判据干净又没人提出异议的，判「留」。这是「最终取舍由我自己判断」的实际含义：**取舍权在我，证据以我自己跑出来的为主、子 Agent 的阅读为印证**，而不是我把 301 支逐行重读一遍。

## 十五、补上那约 190 支的逐支阅读，以及由它得出的两支归档

第十四节把「约 190 支『留』没有逐支亲自读」记成了诚实边界。这一节把它补掉。

### 怎么读的

8.6 MB 源码逐行重读没有意义，一支探针的语义内容集中在两处：**文件头（它声明自己验什么）**和**断言名（它实际判什么）**。
我写了 `make_digest.py`，对**尚未逐支裁决过的 198 支**（即全部 301 支里，减去已删的 13 支、已归档的 32 支、
已逐处读过原行的 51 处改动、以及第十一～十三节逐支点过的两块表和那 36 支）各抽出：

- 台账身份（清单项号，或排除表原文，或「未登记」）、断言条数、`server/test`/`src`/`tools` 下的引用数；
- 文件头里的声明原文（前 24 行的注释，截到 420 字）；
- 最多 9 条断言名（`check(` / `fails.push(` / `assert*(` 的首个字符串实参）。

分成 5 批（48 + 48 + 48 + 48 + 6），**五批我自己全部读完**。判据是：声明的行为今天是不是产品的行为；断言判的是不是声明的那件事；
台账身份与断言是否对得上。

### 读出来的 10 支可疑件，核对引用之后的裁决

读完筛出 10 支「像是一次性工具、可以不留在 `scripts/probes/` 里」的。**逐支核对引用关系之后，8 支站得住、2 支归档**：

| 探针 | 读摘要时的印象 | 核对后的裁决 | 决定性证据 |
|---|---|---|---|
| `account-dual-user-path-probe.mjs` | 227 字节的再导出壳子，没有消费方 | **留**（我的印象是错的） | 3 支在用的探针引它：`account-card-sync-probe.mjs:42` 静态 import、`account-user-pages-probe.mjs:39` 当 `--fixture-module` 的缺省、`mobile-account-probe.mjs:133` 动态 import；排除表写的 `server/test/account-dual-user-path.test.mjs` 也确实存在 |
| `canvas-encode-paths-probe.mjs` | 0 断言，一次性跑分 | **留** | 排除理由原文是 `RENDER_REFACTOR`：「属渲染重构那一块(现在不碰)…渲染重构合入后另议」 |
| `card-plan-key-compare.mjs` | 0 断言，改前改后对账 | **留** | 同上 |
| `export-paths-measure.mjs` | 只测量 | **留** | 同上；夹具 `scripts/probes/fixtures/export-paths/projects.mjs` 专为它而建 |
| `lottie-baseline-probe.mjs` | 0 断言，改动前的留底 | **留** | 同上 |
| `stage-push-before-after-probe.mjs` | 0 断言，改前改后比对 | **留** | 同上 |
| `lottie-renderer-probe.mjs` | 0 断言，SVG 对画布的实验 | **留** | `docs/plan/TODO.md:218`「研究 Lottie 用画布画为什么会画错」（2026-10-10 用户加，未排期）把跑这支探针写成**唯一的重现办法**，连差得最大的第 31、93、124 帧都记了 |
| `stateful-seek-cost-probe.mjs` | 0 断言，耗时实验 | **留** | `lottie-browser-bake-probe.mjs:11`、`stateful-seq-vs-jump-probe.mjs:34` 两支在用的探针把它当「做法照它」的参照原型 |
| `c10-stage-probe.mjs` | 0 断言的可行性实验 | **归档** | 见下 |
| `videodecoder-probe.mjs` | 0 断言的可行性实验 | **归档** | 见下 |

**五支 `RENDER_REFACTOR` 全部留**，理由同第九节我自纠过的那一条：`docs/plan/TODO.md` 第 27 行写着渲染重构
「任务书已写，未开工」「不在 0.7.18～0.7.20 里，等三个版本告一段落再动代码」。改前改后的测量件要到那时候才用得上，
现在归档等于把开工时的基准扔掉。

### 归档的两支，与特意没一起归档的一支

**`c10-stage-probe.mjs`**（59 KB）：排除表本来就标着「C10 可行性探针(历史),结论已落进契约」。三条理由叠起来才动手——
① 结论已固化成 `docs/plan/c10-contract.md` 第 15 节的结果表；② 它把 `src/render/createSnapshot.ts` 打成 IIFE 后读
`s.controls[0].html`，也就是**每张卡的 HTML 快照**那个平面，而那一层 2026-10-16（己二）已撤（`snapshotTier()` 恒回 `'none'`），
`snap` / `bakeT` / `bakeRT` / `bake` 四个用例今天量到的已不是当年量的东西；③ 没有任何代码、单测或验收项引用它。

**`videodecoder-probe.mjs`**：G0-a 准入的可行性探针，和**已经在归档里的 `backdrop-probe.mjs` 同批、同性质、
在同一份任务书的同一行上**（`docs/plan/r8-streams-task.md:224`）。0 断言、不调产品代码、结论已落进该任务书
（G0-a 2026-09-19 全过）、无人引用。先前只归档了 backdrop 而留下它，是口径不一致，这次补齐。

**`oac-probe.mjs` 特意留在 `scripts/probes/`**（同一行上的第三支）：产品代码 `server/vite-plugin-stage-ports.ts:39`
引它作 `Origin-Agent-Cluster: ?1` 这个头的实测出处，`stage-isolation-probe.mjs:8`、`playback-probe.mjs:30`
两支在用的探针照它的做法做。它量的是浏览器的进程隔离，换个 Chrome 版本就可能变，留在原处方便重验。
这一条划清了「可行性探针」归不归档的界：**结论只落在纸上的归档，被产品代码或在用探针当作方法出处的留下**。

### 顺带修掉的两处不准确

1. `docs/plan/r8-streams-task.md:224` 还写着 `scripts/probes/backdrop-probe.mjs`——那是我上一轮归档 backdrop 时
   漏改的指针（归档 README 里列的三处已改指针不含这份任务书）。现在三支的位置逐支写明。
2. `scripts/archive/probes/README.md` 开头原来一句话说归档件「验的行为已经不是产品现在的行为，照旧跑必然不过」。
   这话只对一半：`lowmem-online-probe` 那一类确实跑不过，但 `backdrop-probe`、`videodecoder-probe`、`c10-stage-probe`、
   轨道流那 17 支这类**一次性可行性或选型实测今天还跑得动**，只是不再是通过与不通过的凭据。README 开头已改成分两类说，
   并写明浏览器换版本想重验某条结论就直接跑归档里那一支。

### 这一节之后的处置总数与验证

- **删 13 / 归档 34 / 改 58 处**（归档由 32 增至 34）；`scripts/probes/` 顶层从 368 支降到 276 支 `.mjs`。
- 守门 `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`：**通过**（①284 个文件都登记或写明排除原因；
  ②0.7.18 的 38 行每行有项；③清单引用的文件都在；④跳过名单 14 条齐全；⑤0.7.19 的 50 条每条有项）。
- 台账相关测试：`four-stage-acceptance.test.mjs` 29/29、`four-stage-acceptance-v18.test.mjs` 9/9、
  `probe-timings.test.mjs` 7/7，**45/45 全过**。本回合没有碰 TypeScript，`tsc` 不需重跑（上一次 `npx tsc -b --force` 退出码 0）。

### 边界说清楚

读的是**声明＋断言**，不是逐行重读 8.6 MB。这两样合起来就是一支探针的语义内容，但它**看不出谁 import 它**——
`account-dual-user-path-probe` 就是现成的例子：只看摘要它像个没人用的壳子，一查引用有 3 支在用的探针靠它起夹具。
所以最终取舍不是「读完就定」，而是**读出可疑 → 逐支核引用、核台账、核语义 → 才下判定**。第十四节表格最后一行
那约 190 支，现在都过了这一遍阅读；其中 10 支被读出可疑，核完 8 留 2 归档，没有一支是只凭子 Agent 的阅读定下的。
