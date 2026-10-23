# 探针总审：与语义相符、是否过时、是否冗余

分支 `claude/probe-audit`，worktree `.worktrees/probe-audit`，基准 `2249179a`（2026-10-23，R01 返工与项目直达地址已在 main）。
任务由用户 2026-10-23 用 `/goal` 下达：审查全部探针是否与语义相符、是否过时、是否冗余；授权用多个 Argon 审核、多个 Opus 交叉审核、分块派出，
**最终取舍由主 Agent 自己判断**。

「探针」指 `scripts/probes/` 下的手工验收脚本（开审时 368 个文件、约 8.6 MB）。它们**不在** `npm test` 里
（`scripts/test-suite.mjs` 只收 `server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`），
但有 68 支被某个单测 import 或 spawn，还有 5 支被 `server/test/probe-timings.test.mjs` 的 PT-05 读源码检查 —— 这些删或改名会让基线变红。

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

`scripts/probes` 下的文件从 **368** 降到 **336**：删 4 支、归档 25 支（另一支 R01 探针在本次开审前已随返工删除）、改 46 支。守门从「不过」转为**通过**。

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
- **删掉一条恒真断言**：`placeholder-probe.mjs` 原有 `check('main_thread_component_script', true, …)` —— 条件写死 `true`，什么也不证；它想说的「占位符自己不排 JS」由同一段的 `steady_trace` 证明。
- **修 33 支的失效指针**：文件头指向的 AGENT 报告按子 Agent 协议搬进了 `docs/archive/agent-reports/`，路径没跟着改。逐条核过目标在归档目录里确实存在、原位置确实没有才改。
- **修一处会卡住整条测试链的失配补丁**：`reopen-native-fixture.mjs` 的边车端口补丁。`lib.rs` 现在写 `"--port", &editor_port.to_string()`，而 `editor_port` 由 `account_editor_port()` 从 `EDITOR_PORT` 推出、上一条补丁已把它改成 5203，这条补丁多余且目标串一次都不命中，会抛「native source isolation patch no longer matches」，把 `reopen-native`、`reopen-native-upgrade`、`reopen-installed --rehearse-fixture` 全卡在夹具构建这一步。核过剩下 7 条补丁串全部命中。
- **清台账**：守门 `coverageReport()` 新增「既被清单项点名、又写在排除表里」的检查并判红（原先这种自相矛盾静默通过）；收掉 `claim-gate-judge.mjs`、`render-host-probe.mjs`、`card-policy-probe.mjs` 三处重复登记；清单里点名的夹具目录 `fixtures/online-card-attacks/` 全仓不存在，改成真名 `fixtures/render-isolation/`。

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
| 我自己交给 B05b/B12a 的框定「渲染重构已合入，现在就是另议的时候」 | **是我说错了** | `TODO.md` 第 27 行写明渲染重构整体「任务书已写，未开工」；只有 R8、R9 两个子项合入。那 40 支挂着「重构合入后另议」的探针继续挂着，读那两份报告时相应打折 |

## 五、还没动、记为待办的（都有具体行号，供用户定先后）

1. **语义与代码冲突：卡片源码同步连接还在定时换会话。** 语义 `mechanism/document-service.md`（2026-10-14 用户定，标题就写「推翻定时换会话机制」）明文「页面不再定时换会话」，Opus 核定这条规矩管得到卡片同步那条连接（出处 `user-decisions-2026-10-14.md` 还把它推到素材服务与云端 Agent 的连接）。但 `server/account-card-link.mjs` 第 92～96 行仍按到期时刻定时换会话，单测 `account-card-link.test.mjs` 的 ACL-02/03 与 `account-card-sync.test.mjs` 的 7b 还在护着它（同一文件的 7c 已经按新语义断言「不换会话」，两条对同一端点说法相反）。按原则 2「语义优先」该改的是代码和单测、探针跟着改 —— 这会改动产品行为，又正逢 0.7.21 在合分支，所以我没动，交用户定。
2. **第四段云端 Agent 的 4～5 支探针还在验 2026-10-08 之前的旧规则**：只读成员 `ding` 能发起对话、到写工具才被拒（现行语义：发消息这一步就被拒，而且「现在没有只读成员这种身份」）；被踢/移出时共有对话立即中止（现行语义：已读那一轮继续跑完）；非账号口令模式底座。涉及 `cloud-agent-auth-probe`（S4-1）、`cloud-agent-isolation-probe`（S4-2）与它调的 `isolation-tools`/`isolation-look`、`cloud-agent-look-probe`、`cloud-agent-sound-probe`、`cloud-agent-ux-probe`（S4-5）。同块的 `cloud-agent-ux-ui-probe`（S4-6）已在 2026-10-21 迁到账号模式，可能该让它接替 S4-5。**这是重写验收断言，不是小修**，且这 5 支里有 5 支被 PT-05 读源码，动它们要同步改单测。
3. **工具改名的覆盖缺口**（不是缺陷）：2026-10-21 定的 `user_interface_*` 前缀，执行层有兼容层，所以旧名探针照旧能过；但没有探针验过「模型按当前开放清单发新名」这一环（`cloud-tools-wire-probe`、`cloud-tools-w2-probe`）。
4. **`reopen-e2e.mjs` 第 154～181 行「member first authentication」在 main 上拿到 `reopen: "rejected"` 就退出**，把挂在它后面的 `--matrix`、`--exit-matrix`（含 2026-10-22 随冲突合并窗口改过的 5 处断言）挡住，至今没实跑合拢。
5. **`stream-canvas-direct-probe` 与产品的落实差**：语义（`product/rendering.md`、`mechanism/rendering.md`，2026-10-14 用户定）写「画布卡产轨道流一律直接从画布取像素，不再每段实测对比」，但 `server/bakery/capture-canvas.mjs` 只把默认模式从 `auto` 改成 `always`，仍保留每段首帧截图对比，探针也还在强断言它。要么改代码和探针，要么修语义表述。
6. **`mechanism/rendering.md`「哪些卡有流」那一段仍有 R02 之前的旧话**「浏览器节点和在线页面本页不产」：R01 退回后前半句又对了，后半句与已做成的 R02 冲突。这一本正被 0.7.21 的发版会话改着，我没去抢改。
7. **`probe-gate-probe.mjs` 第 244 行**仍以 `out.raf.p50 <= 20` 毫秒当通过条件（它在排除表里，所以这次没一起改）。
8. 还有两块（B08a 预渲染队列与跨机、B08b 托管渲染与共享项目）的 Argon 报告没回，这 51 支只过了主 Agent 自己的机械核查（台账、指针、时间断言），没有逐支对语义。

## 六、验证

按 2026-10-23 用户定的「只测改动影响范围」选测，不跑全量：

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | **零错误**（退出码 0，无输出） |
| 守门 `four-stage-acceptance.mjs --check-coverage` | **通过**（开审时是「不过」：3 支未登记） |
| 影响范围测试：`four-stage-acceptance`、`four-stage-acceptance-v18`、`bakery-deps`、`probe-timings` | **48 项全过**（含读探针源码的 PT-05、PT-06） |
| 覆盖它所删探针的单测：`asset-project-http`、`asset-project-entries` | **8 项全过** |
| 每个改过或归档的脚本 | `node --check` 全部通过 |
| 删／归档的 29 个文件名在单测里的引用 | 逐个搜过，只有一处同名字符串（流键），不是文件引用 |

没跑：全量 `npm test`（按上面那条用户决定；合 main 前要不要全量由用户定）、渲染附加项（本次没改画面代码，只改探针与验收台账；唯一碰到的产品文件 `src/render/snapshotRename.ts` 只改了一行注释里的路径）。

## 七、要用户定的事

1. 这条分支合不合入 main（写 main 须授权）。它把 0.7.21 发版要过的守门从「不过」修成了「通过」，发版会话等着这一关。
2. 第五节 1～5 条待办的先后：其中第 1 条是改产品代码（语义优先），第 2 条是重写第四段验收断言，都不小。
3. 归档口径认不认：一次性实测与原型挪进 `scripts/archive/probes/` 而不是删掉。
