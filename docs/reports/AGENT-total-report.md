# AGENT-total-report

主会话「PromptCut M5～M8 开发交接」派出的子智能体报告。分支 `claude/total-report`（起点 `fd739f1b`，基于 main `0cabcfb0`），只改 `.md`；没起服务、没跑测试（主会话合并前在另一台机器上跑基线）。

## 任务

1. 照现状更正 `REPORT-M5-M8.md` 末节「骨架里发现的缺口」第四部分列出的旧报告出入（第 1～8 条、第 10 条；第 9 条是待用户项，不改）。
2. 把 `docs/reports/` 下的 AGENT 报告归档到 `docs/archive/agent-reports/`，更新 `.md` 里的旧路径引用，重数 `REPORT-M5-M8.md` 附录 B。

## 一、第四部分十条改了哪里

事实全用 `git log`、`git log --first-parent`、`git merge-base --is-ancestor <提交> origin/main` 核过（`origin/main` 当时是 `9cf43f1f`）。

| 条 | 改的文件与小节 | 怎么改 |
|---|---|---|
| 1 | `REPORT-C10.md` 第 0 节第 3 条、第 1 节表的 `pause-precise` / `c10-site` 两行与合入顺序、第 11 节 L21 行 | 「都还在做」改成后来都并入集成分支；两行的 Agent 栏写「子智能体（类型待核）」、内容栏写并入提交（`pause-precise` `2f7f821`；`c10-site` 第一轮 `3a04aef`～`a0f353a` 在集成分支的 first-parent 上、第二轮 `fb3aaa7`）、报告栏指向归档位置；「还没合入 main……」删掉，合入顺序按 `git log --first-parent 24c2c57..51f01c4` 补第 9～12 步，末句写「C10 已合入 main：快进，main 指到 `51f01c4`」；L21 行改成已并入 `2f7f821`、随 C10 合入 |
| 2 | `REPORT-C10.md` 第 5 节开头 | 删「外网一轮都还没跑」，改写成云端跑了外网四轮（`c10s0928b`～`e`）、`e` 全过、A5 外网通过、其余归 M8-X3 |
| 3 | `REPORT-C10.md` 第 3 节 G0 表、第 13 节末句 | 「合入提交 `62850af`」改成「报告定稿 `62850af`（C10 快进进 main，main 停在 `51f01c4`，之后只多两次改本报告的提交）」；第 13 节的「『合入提交』一行」同步改称 |
| 4 | `REPORT-C10.md` 第 5 节 A9 行备注 | 补句号，拆成两句 |
| 5 | `REPORT-C10.md` 第 6 节第 29 行末栏、第 11 节 `SWAP_MS` 与「握手后又断」两行 | 核过 `m8-plan.md` 第 5 节 L1～L26 没有这三条，改成「没有 M8 计划编号，记在 `REPORT-M5-M8.md` 第 7.4 节」；`REPORT-M5-M8.md` 第 7.4 节对应三行同步 |
| 6 | `REPORT-M7.md` 第 1 节末 | 「还没合入 main」改成已快进进 main、main 指到 `a52344a`，列出 `88e70e3` 之后 main 上的 `e86a754`、`8cd21c1` 两次合并与 `4540315`、`76d6c02`、`a52344a` 三次文档提交 |
| 7 | `REPORT-M7.md` 第 1 节表 `m7-probe` 行、第 12 节 | 改成四个探针脚本没并进集成分支，M7 快进进 main 后由 main `e86a754` 合入；`REPORT-M5-M8.md` 第 7.4 节该行同步 |
| 8 | `REPORT-M7.md` 第 0 节第 1 条 | 核清：契约（`m7-contract.md` 第 12、13 节）定的是「C10 合入 main 之后」开工；实际各分支起点是 C10 集成分支 `24c2c57`（09-28 05:15，已合 `c10-browser`、`c10-a4` 与带 M7 契约的 main `a038948`），`m7-probe`、`rq-m7-tests`、`rq-m7-queue` 首个提交都在 05:31～05:32，C10 快进进 main（`51f01c4`）是 08:06。照此写成「C10 合入 main 之前开工，集成分支到 `313b27c` 合 main `3ab63cf` 才带上已合入 main 的 C10」 |
| 9 | 不改 | 待用户项（D18 语义 dry run 没有用户确认记录） |
| 10 | `docs/plan/m8-plan.md` 第 1.1 节前置表与表下一句 | 表头注明首版按 `a038948`、合入状态 2026-09-29 按 git 核过改写；C10 行：已合入（main `51f01c4`）、已部署（`2f7f821`、`d29a7ba`），缺的只剩 M8-X3；M7 行：已合入（main `a52344a`，`m7-probe` 脚本 `e86a754`），W7 时部署 `4047133`，合入后的部署提交待核；性能行：1080p 编码已合入 `211695d`；遗留行：补 L10/L16 `2fa0c1a6`、L4/L5 `2e957270`、L14 `278eeb9d`、L20 `211695d`、L21 随 C10；表下一句补探针分支 m8-kit `fdf515e3`、m8-migrate `6d516f32`、m8-scale `b18256e1`、m8-e2e `4538ec42`。`REPORT-render-queue-m8.md` 没动 |

`REPORT-M5-M8.md` 第四部分的标题说明改成「2026-09-29 由分支 `claude/total-report` 照现状改了……」，十条每条前面标【已更正】加一句改了哪里（第 9 条标「待用户项，不改」），原记内容保留在「原记：」之后。

核对用到的关键事实：

- `51f01c4`、`62850af`、`82d1a33`、`2f7f821`、`fb3aaa7`、`97bda2b`、`cc1d137`、`24c2c57`、`a52344a`、`313b27c`、`3ab63cf`、`e86a754`、`2fa0c1a6`、`2e957270`、`278eeb9d`、`fdf515e3`、`6d516f32`、`b18256e1`、`4538ec42`、`211695d` 都存在且是 `origin/main` 的祖先。
- `51f01c4` 不是 `24c2c57` 的祖先，是 `3ab63cf` 的祖先；`211695d` 的第一个父是 `51f01c4`（C10 进 main 后 main 在它上面合了 `perf-encode`）。
- `a52344a` 在 `origin/main` 的 first-parent 链上，链往下经 `88e70e3`、`313b27c` 到 `24c2c57`（M7 集成分支快进进 main）。

## 二、归档

- `git mv` 18 份，`docs/archive/agent-reports/` 里原先没有同名文件（逐个查过，没有要 diff 的）：`AGENT-card-overlay.md`、`AGENT-eol-eperm.md`、`AGENT-evidence-audit.md`、`AGENT-host-diag.md`、`AGENT-hygiene.md`、`AGENT-lan-asset.md`、`AGENT-lowmem-latency.md`、`AGENT-m8-connect-proxy.md`、`AGENT-m8-e2e.md`、`AGENT-m8-kit.md`、`AGENT-m8-migrate.md`、`AGENT-m8-scale.md`、`AGENT-m8-session-legacy.md`、`AGENT-particles-blank.md`、`AGENT-perf-encode.md`、`AGENT-perf-t4.md`、`AGENT-tailwind-guard.md`、`AGENT-undo-refresh.md`。
- 归档目录 87 → **105 份**。`docs/reports/` 里只剩本报告。
- `REPORT-M5-M8.md` 附录 B 按 105 份重写第一条，原「待 M8 收尾时归档」那条改成本次归档清单。
- **注意**：`origin/main` 在本分支起点之后进来了 `docs/reports/AGENT-m8-e3-page.md`（main `9cf43f1f`），不在本分支上；本分支合入后它仍在 `docs/reports/`，要主会话另行归档。

### `.md` 里旧路径引用的处理

改成 `docs/archive/agent-reports/…` 的（都是指向现已归档文件的引用）：`docs/plan/TODO.md`、`artifact-transfer-contract.md`、`c10-contract.md`、`http-transport-contract.md`（5 处）、`render-queue-contract.md`（2 处）、`HANDOFF-2026-09-28.md`、`HANDOFF-2026-09-27.md`（第 139、172 行直接改；第 161、202 行是派活指令，改成「当时约定写在 `docs/reports/`，现归档在……」）、`REPORT-C10.md`（第 114、205、303 行；第 303 行「没有挪的 perf-t4」补上已由本分支归档）、`REPORT-HT-a.md`、`REPORT-M5-M8.md` 第 679 行，以及归档目录里 `AGENT-m6-host.md`、`AGENT-m6-integ2.md`、`AGENT-m6c-snapshot.md`、`AGENT-rq-m7-node.md`、`AGENT-sink-has.md`、`AGENT-snapshot-ids.md`、`AGENT-tailwind-scan.md` 各 1 处。另把几处描述「旧路径」这一模式的句子改写成「`docs/reports/` 下的 `AGENT-…`」（`REPORT-C10.md` 第 12 节、`REPORT-M7.md` 第 12 节、`REPORT-M5-M8.md` 第 7.4 节）。

**故意没改、仍含 `docs/reports/AGENT-` 的**（改了反而不对）：

| 文件:行 | 为什么不改 |
|---|---|
| `docs/reports/REPORT-render-queue-m8.md:124` | 任务要求不动（主会话在别的分支改） |
| `docs/reports/AGENT-total-report.md:8` | 本报告，描述任务 |
| `docs/semantics/guide_files/multi_agent.md:12` | 规则里约定的新报告路径 `docs/reports/AGENT-<分支名>.md`，不是指向某份已归档文件；改规则不在本任务范围 |
| `docs/reports/HANDOFF-2026-09-27-pc.md:120` | 派活模板里的约定路径 `AGENT-<分支>.md`，同上 |
| `docs/reports/EVIDENCE-M5-M8.md:40、41、42、61（2 处）、75、82、93、111、121、140` | 写法是 `<提交>:docs/reports/AGENT-…`，是 `git show` 能取的那个提交里的路径；这些子报告（M5a、C5、C6.1、C6.3）没有单独归档文件，改路径反而取不到 |
| `docs/reports/REPORT-M5.md:42`、`docs/reports/REPORT-render-queue-m5b.md:73` | 历史叙述「当时 8 份还留在 `docs/reports/`」 |
| `docs/reports/REPORT-M7.md:42、253` | `AGENT-join-error.md` 在未合入的 `claude/join-error` 分支的 `docs/reports/` 下，还没归档 |
| `docs/archive/agent-reports/AGENT-c10a-r2.md:93、96` | 历史事件：当时改写 `docs/reports/` 下那份文件触发了整页重载，路径本身是事实的一部分 |
| `docs/archive/agent-reports/AGENT-hygiene.md:42` | 叙述代码里原来那个不存在的路径 `AGENT-c6-4-pipeline.md` |

## 三、代码文件里仍指向旧路径的引用（没改，留给以后）

共 41 处，全是注释或文件头（`git grep -n -o "docs/reports/AGENT-…" -- ':!*.md'`）。改 `src/` 连注释都会变代码版本 frameCode，所以一处没动。

- `scripts/probes/c10-stage-probe.mjs:1:docs/reports/AGENT-c10-probe.md`
- `scripts/probes/c10-stage-probe.mjs:374:docs/reports/AGENT-snapshot-ids.md`
- `scripts/probes/card-overlay-probe.mjs:2:docs/reports/AGENT-card-overlay.md`
- `scripts/probes/m7-bake-probe.mjs:3:docs/reports/AGENT-m7-probe.md`
- `scripts/probes/m7-build-probe.mjs:3:docs/reports/AGENT-m7-probe.md`
- `scripts/probes/m7-upload-probe.mjs:4:docs/reports/AGENT-m7-probe.md`
- `scripts/probes/m7-visibility-probe.mjs:4:docs/reports/AGENT-m7-probe.md`
- `scripts/probes/m8-e-probe.mjs:3:docs/reports/AGENT-m8-kit.md`
- `scripts/probes/m8-migrate-probe.mjs:46:docs/reports/AGENT-m8-migrate.md`
- `scripts/probes/tier-switch-probe.mjs:21:docs/reports/AGENT-tier-reload-seek.md`
- `scripts/probes/tiers-probe.mjs:158:docs/reports/AGENT-perf-t4.md`
- `server/artifact-transfer.mjs:615:docs/reports/AGENT-sink-has.md`
- `server/bakery/ffmpeg.mjs:174:docs/reports/AGENT-perf-encode.md`
- `server/bakery/ffmpeg.mjs:215:docs/reports/AGENT-perf-encode.md`
- `server/prerender-executor.mjs:24:docs/reports/AGENT-stall-phases.md`
- `server/render-node/session-diag.mjs:2:docs/reports/AGENT-host-diag.md`
- `server/render-node/session-diag.mjs:126:docs/reports/AGENT-stall-phases.md`
- `server/render-node/session-link.mjs:33:docs/reports/AGENT-ht-client.md`
- `server/render-node/task-runner.mjs:25:docs/reports/AGENT-stall-phases.md`
- `server/test/c10-kit.mjs:8:docs/reports/AGENT-c10-tests.md`
- `server/test/c10a-kit.mjs:9:docs/reports/AGENT-c10a-tests.md`
- `server/test/c10a-kit.mjs:58:docs/reports/AGENT-c10a-integ.md`
- `server/test/card-overlay.test.mjs:2:docs/reports/AGENT-card-overlay.md`
- `server/test/ht-kit.mjs:10:docs/reports/AGENT-ht-tests.md`
- `server/test/m7-kit.mjs:9:docs/reports/AGENT-rq-m7-tests.md`
- `server/test/session-diag.test.mjs:2:docs/reports/AGENT-host-diag.md`
- `server/test/sink-has.test.mjs:2:docs/reports/AGENT-sink-has.md`
- `server/test/stall-phases-diag.test.mjs:2:docs/reports/AGENT-stall-phases.md`
- `server/test/stall-phases.test.mjs:2:docs/reports/AGENT-stall-phases.md`
- `server/test/stream-encode-fast.test.mjs:2:docs/reports/AGENT-perf-encode.md`
- `server/vite-plugin-frames.ts:250:docs/reports/AGENT-stall-phases.md`
- `src/editor/sync/link.ts:80:docs/reports/AGENT-ht-client.md`
- `src/editor/timeline/durationSync.test.mjs:5:docs/reports/AGENT-perf-t4.md`
- `src/editor/timeline/durationSync.ts:5:docs/reports/AGENT-perf-t4.md`
- `src/render/mediaDrive.test.mjs:3:docs/reports/AGENT-tier-reload-seek.md`
- `src/render/mediaDrive.ts:99:docs/reports/AGENT-tier-reload-seek.md`
- `src/render/mediaSync.ts:238:docs/reports/AGENT-tier-reload-seek.md`
- `src/render/playability.ts:193:docs/reports/AGENT-tier-reload-seek.md`
- `src/render/snapshot/renameSceneIds.ts:6:docs/reports/AGENT-c10-probe.md`
- `src/store/core.ts:322:docs/reports/AGENT-perf-t4.md`
- `src/store/storeHold.test.mjs:5:docs/reports/AGENT-perf-t4.md`

其中指向的文件现在都在 `docs/archive/agent-reports/` 下（`AGENT-snapshot-ids.md`、`AGENT-c10a-tests.md`、`AGENT-c10a-integ.md`、`AGENT-ht-tests.md`、`AGENT-ht-client.md` 等以前就已归档）。

## 四、验证

- 只改 `.md` 与 `git mv`；`git status` 干净，结果见主会话收到的回复。
- `git grep -n "docs/reports/AGENT-" -- "*.md"` 剩下的都在上面「故意没改」表里。

## 五、没做成的与建议

- 验收写的是 grep 只剩 `REPORT-render-queue-m8.md` 与本报告；实际还剩上表那些，我判断改了会让叙述失真或让 `<提交>:路径` 引用失效，所以没改，请主会话定。若一定要清零，最省事的是把它们改写成「`docs/reports/` 下的 `AGENT-…`」这类不带完整路径的说法（意思不变）；`multi_agent.md` 那条是规则，要改须按规则变更办。
- `AGENT-m8-e3-page.md` 不在本分支，合入后要另归档（见第二部分）。
- `REPORT-C10.md` 第 1 节表里 `pause-precise`、`c10-site` 的 Agent 类型各报告都没写，填了「子智能体（类型待核）」。
- `m8-plan.md` 第 1.1 节 M7 行「合入后的部署提交」查不到记录，写了待核。
- `REPORT-C10.md` 第 12 节原写「`c10-contract.md` 第 142 行」，实际在第 144 行（本分支已改成新路径，没回改行号）。

## 第二轮：填 M8 部分

2026-09-29 主会话再派本分支（起点 `0b8590ac`），把 `REPORT-M5-M8.md` 里 M8 的占位按 M8 阶段报告填上。只改 `.md`，不起服务、不跑测试。

- **事实来源（只读）**：`.worktrees/m8-report` 的 `docs/reports/REPORT-render-queue-m8.md`（任务写的是 `claude/m8-report` @ `3715a072`；开工时该分支已到 `1c268ee9`，只多一次提交，改的是那份报告第 14 节「骨架缺口」逐条标已解决，不影响本轮填的内容）；`m8-plan.md`、`hosting-migration.md` 以那边的为准。
- **留占位的**（结果还没定）：1080p 分段编码（`claude/perf-encode-2` 修复中）；全案最终基线；阿里云探针项目清理结果；第 0 节最后的结论句。

进度（每完成一块提交一次）：

| 提交 | 改了 `REPORT-M5-M8.md` 的哪里 |
|---|---|
| `8032ba02` | 状态行与开头第 7 条；第 0 节（最后结论句留占位）；代号表加 M8 新代号（K1-X / I1-X、C1～C5、J 三条、P-C1 / P-C3、本机替身 / 真跨机、第五次修订、run 号、PC-M8-0～5 / E6R-1 / RMT-1）；第 2.10 节（总表加 M8 期间合入 main 的分支清单与部署） |
| `2e885e4d` | 第 3.1 节 M8 验收逐条（42 行，一行一项）；第 3.2 节第 1～5、8、9、12～15、18 条的当前状态；第 3.3 节仍未能真跨机的项（表） |
| `db5ddeab` | 第 4 节分 4.1「M8 期间每次合入的 G0 / G0-R」与 4.2「全案最终基线」（各行留占位） |
| `17b9a1d9` | 第 5.1 节 M8 远端操作索引（探针项目清理结果留占位）；第 5.2 节 I1-X 资源峰值；第 5.3 节迁移演练 |
| `7ee78db5` | 第 6.1 节 M8 一行；第 6.2 节 M8 一行（没改语义、契约级三条）；第 6.3 节更新两行已修、加按语义不做一行、M8 已修的三处、新旧混跑一行 |
| `4fa70b5b` | 第 7.1 节加 M8 修掉的遗留与缺陷、其余各条按 M8 报告更新；第 7.3 节指向新增的第 7.5 节「M8 新留下的」 |
| `1d53883a` | 第 8 节并进 M8 第 13.4 节 10 条：重复的 5 条并进原条，新编第 30～35 条；第 21 条（1080p）改「又有效」、第 22 条逐项改状态；删掉第 22、23 行之间把表断成两截的空行 |
| `b8be1368` | 第 9 节（M8 执行期没调，并进「没调顾问的阶段与理由」）；第 10 节需要用户决定的事（12 条，1080p 留占位）；附录 A 的 M8 指令与回执；附录 B 收尾时再归档的 4 份 |
| `5c344e83` | 第 7.1 节又一处把表断成两截的空行；L20 行注明 M8 又贴线没过 |

### 验证

- `grep -n "占位\|待填" docs/reports/REPORT-M5-M8.md` 剩下的：
  - 第 3 行（状态行）、第 7 行（开头说明）：描述「只剩四处占位」的文字，不是占位；
  - 第 21 行：第 0 节最后的结论句（等 1080p 修复合入、全案最终基线跑完）；
  - 第 402 行：第 3.1 节 1080p 一行（等 `claude/perf-encode-2`）；
  - 第 470 行：第 4.2 节全案最终基线（下表各行写「〔待 M8 收尾：1080p 编码修复合入后跑〕」，不含「占位」二字，只在表头这一句标占位）；
  - 第 517 行：第 5.1 节阿里云探针项目清理结果；
  - 第 687、695 行：第 7.5 节 1080p 一行、探针项目一行；
  - 第 724 行：第 8 节第 21 条（1080p）；第 737 行：第 34 条（探针项目清理）；
  - 第 786 行：第 10 节第 1 条（1080p）；
  - 第 577、593、657、722 行的「一直占位」是低内存档的产品行为（占位画面），不是待填。
- 表格：用脚本逐表数单元格（去掉反引号里的内容与转义的竖线后数 `|`），43 张表每行列数都与表头一致、每张表都有分隔行；顺手修了原来就有的两处空行断表（第 7.1 节、第 8 节）。
- 用词：没有「烘焙」「冻结」；没有剩下「收尾时填」「由 M8 填」。
- 只改了 `docs/reports/REPORT-M5-M8.md` 与本报告；没改 `REPORT-render-queue-m8.md`，没改代码。

### M8 报告与总报告之间对不上的地方（没去改 M8 报告）

1. `REPORT-render-queue-m8.md` 第 13.4 节第 9 条写探针项目「见第 14 节清理记录」，那份报告第 14 节是「骨架里发现的缺口」，没有清理记录。总报告第 8 节第 34 条、第 5.1、7.5 节照此留占位。
2. 任务说 PC 辅助节点指令是 PC-M8-0～PC-M8-6，M8 报告第 11 节只有 PC-M8-0～5；附录 A 只写到 PC-M8-5。
3. 任务写 `claude/m8-report` @ `3715a072`，开工时分支已到 `1c268ee9`（只改了第 14 节逐条标已解决），不影响本轮。
4. 总报告骨架第 2.10 节预想集成分支 `claude/rq-m8`；M8 报告里没有这个分支，M8 是逐条合入 main 的。已在第 2.10 节写明。
5. M8 报告第 8 节 1080p 一行说「全案最终基线时没过」，但同报告第 9 节「全案最终基线」一行还是待填，且那次测在 `9cf43f1f` 上，之后 main 又到了 `e27fa520`（改了进代码版本的 `server/frame-pipeline.mjs`）。总报告把那次记成「此前在 main `9cf43f1f` 上跑过一次」，全案最终基线仍留占位。
6. M8 报告第 13.2 节把第 9～11 条〔裁〕标「三级（机制）」，但改的是契约文件，`docs/semantics/mechanism/` 没动；总报告第 6.1、6.2 节写成「契约级（M8 报告标三级（机制））」。
7. M7-A6 探针修正：M8 报告第 2 节 E5 写 main `21eaeb8f`（`git log` 看是单独一次合并 `claude/m7-a6-race`），第 12a 节停滞修复一行写「停滞修复、A6 探针修正与本项叠在一起合并（`0cabcfb0`）」。两处都没错（`21eaeb8f` 是 `0cabcfb0` 的祖先），但读起来像两次说法。
8. M8 报告自己还有没回填的：状态行仍写「骨架」、第 0 节结论待填、第 9 节「全案最终基线」「主工作区」两行待填、第 7 节 C3 放云端判据栏「同参数无扰动对照：待填」（第 13.1 节已写没跑）。
9. `HANDOFF-2026-09-28-pc.md` 在 main 上、不在本分支（本分支起点 `0cabcfb0` 早于它）；总报告附录 A 引了它，合入后才对得上。
10. `REPORT-M5-M8.md` 原第 7.4 节 `claude/particles-blank` 一行写「结果由 M8 填」，M8 报告没提这个分支；改成「M8 报告没写，待核」。L3、L19 的结果 M8 报告也没写，同样标待核。
