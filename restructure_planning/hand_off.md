# 渲染管线重整——交接文档（hand_off）

交接时间：2026-09-22，main `cfb8a2f` 之后。写给下一个接手的人（人或 Agent）。读这一份就能知道：东西在哪、做到哪、哪些是自报没复核的、哪些明确没做、下一步先做什么、谁要拍板。

---

## 1. 先读什么、按什么顺序

1. `user_pinned_goal.md`（仓库根）——用户钉死的目标。改它只能经弹窗让用户确认原文。
2. `restructure_planning/render_pipeline_restructure.md`——计划总入口，只放计划本身。
3. `restructure_planning/hunman_read.md`——**独立复核的结论**（5 个 Opus 分段对照代码复核，2026-09-22 17:30，main `f69f229`），条目版；证据在 `task_recheck.md`（193 KB）。**它比 `render_pipeline_restructure_check.md` 更可信**：check 是执行方（我）写的，复核方判定它「偏乐观」，R5、R6、R7 标的「已完成」各有几条子项没落实。两份冲突时以复核为准。
4. `restructure_planning/render_pipeline_restructure_check.md`——执行方的核对，章节和计划一一对应；区分了「我验」和「Agent 自报」。
5. 动工某一步时再读分册：`r2-r7-task.md`（已完成，留作查协议）、`r8-streams-task.md`、`r9-webgl-task.md`、`cloud-task.md`。
6. `restructure_planning/reports/`——每一步实现者的原始报告（r1～r7、排查、文档抽取），含「任务书要改的句子」和「留给下一步」。

`restructure_planning/README.md` 是文件夹索引。旧任务书 `AGY-TASK-cloud-doc-and-write-race.md` 已删除，别找。

## 2. 现在的状态（一句话）

R0～R7 的代码已合并进 main，**舞台已露出、缺省已翻成跨源双舞台**（`?preview=legacy` 回滚）；R8 轨道流、R9 共享 WebGL 渲染器、云端那一半未开始。main 上 `npx tsc -b --force` 零错误，`npm test` 1633 / 1632 通过 / 0 失败 / 1 跳过。

**但对照 pinned 目标有 5 处不符**（复核证实，其中前三处主会话抽查过代码）：

| pinned | 缺什么 | 在哪 |
|---|---|---|
| 渲染 9 | 预渲染集合 `prerenderSet` 算出来了，**预渲染进程没用它**，判轻的卡照样产快照（`server/frame-pipeline.mjs:920` 只写不读） | R6-2 |
| 架构 7 | 项目选项里的 fps 下拉（24 / 25 / 30 / 60）**没做**，全 `src` 没有改 fps 的界面 | P-2 |
| 架构 9 | 点时间轴、拖动松开后**不一定发 settle**（`Preview.tsx` 的 settle effect 依赖里没有 `scrubbing`），暂停和跳转按钮会发 | R5-16 |
| 架构 10 | 24 / 25 fps 下一拍 41～50 ms，**超过 40 ms 阈值会误判卡顿、音频反复暂停** | R5-6 |
| 渲染 4 | 长 motion 按播放位置估代价没做，现在统一用整段最差代价 | 复核 pinned 表 |

另有一条**回归**：播放头在末尾时按播放会立即结束、不从头重播（R7-11）。

## 3. 各步状态（以复核为准）

| 步 | 状态 | 要接手的人知道的 |
|---|---|---|
| R0 清账 | 🟡 | `verify-unified-frames.mjs` 最后一条断言仍红：快照重放丢 1/64 px，`blur(32px)` 下差 255 级；修法在 `reports/replay-mismatch-report.md` §6，会作废全部共享快照。冷启动量测没做。 |
| R1 | ✅ | `inherited-props-probe.mjs` 引用的文件不存在，脚本跑不起来（S38-6）。 |
| R1b | ✅ | `effects.mjs:107`、`pixelMapTools.ts:73` 还写着「1080p 每帧 400 毫秒以上」的过期文案，会误导 Agent（S39-8）。 |
| R2 | ✅ | `hostCapabilities.prerender` 恒为 false（R2-14）。 |
| R3 | ✅ 有两条要你确认 | `Date.now` 被固定成 2026-01-01（不是计划的「舞台打开时的真实时间」）；导出页没装虚拟定时器（执行者说会死锁）。靠定时器计时的卡，导出和活渲可能对不上。 |
| R4 | ✅ 有一条要你确认 | 随机访问卡抽 16 帧取 p90，和 pinned 渲染 2「8 帧取最差」字面冲突。页面和预渲染进程取成本记录的规则可能不一致（R4a-12）。`ProbeGate` 只挡页面会话里第一个项目（R4b-3）。探针帧转存预渲染的链路网络错一次就永久停（R4b-14）。 |
| R5 | 🟡 | 见第 2 节的 settle 与音频两条；`vtOk=false` 的卡在暂停 / 跳转 / 拖动下没人补跑（R5-12）；播放态互换两次失败后不降级反而放回活渲（R5-11）；`stageSwap` / `snapshotFeed` / `demote` / 节拍循环没有单测。 |
| R6 | 🟡 | 见第 2 节渲染 9；`cacheable` 放行 `sourceDependent` 没做（R6-3）；就绪索引 `reset()` 没人调用，换项目旧层残留（R6-7）；超限帧每趟重渲再丢（R6-14）；`/yield` 没删、`NO_AGENT_LANE` 没做（R6-19）。 |
| R7 | 🟡 | 开关已翻；`?preview=legacy` 没合并舞台里的同名开关（R7-6）；播到头不重播的回归（R7-11）；桌面壳只 `cargo check`、没真构建没真跑。 |
| R8 | ⏸ | 编码原型 G0-b 已做完（`g0-b-stream-prototype.md`，探针 `scripts/probes/stream-*.mjs`）。分册里 4 处结论只进了汇总段、正文没改，行号整体过期（R8-11）。 |
| R9 | ⏸ | 分册就绪。 |
| 云端 | ⏸ | 分册就绪，文末 6 个问题动工前定。已有雏形：本地内容库、`tiers` 字段、`playbackUrl` 占位、`.procp`、预渲染进程分道。 |

「✅」是复核判定，不是我判定的。「自报未复核」的实测数字（帧间隔、导出逐字节、探针全绿）在 check 文件里都标了「Agent 自报」，复核方也标了「❔」。

## 4. 用户已拍板 / 还等拍板

**2026-09-22 已定**（第一版交接文档列的前 5 条）：
1. `Date.now` 固定纪元，不改（确定性优先）。
2. 导出页不装虚拟定时器，先接受，记进 `future_planning.md` 第 2 条。
3. pinned 渲染 2 改成稳健值口径（抽 16 帧取 p90），已按弹窗确认的原文改。
4. pinned 渲染 4 末尾加了一句：按位置的 t_c 只用于算实际追帧数，分派仍按渲染 3。已按弹窗确认的原文改。
5. 先修第 2 节那 5 条 + 播到头回归，再开 R8——**已派出（R7b）**，回来后见 `reports/r7b-report.md`。

**还等拍板**：
6. R8、R9、云端三份分册动工前要不要派独立审查、派谁。
7. `cloud-task.md` 文末 6 个问题（云端动工前）。
8. R8 / R9 分册的三个细节（各自动工时）。

另：`reply_to_users_goal.md` 第 9 行还是旧的上传顺序；fold-notes 要求把「原片 = 原编码」的 `playable` 读法写进去请用户确认，没做。

## 5. 下一步建议（按顺序）

1. **修第 2 节的 5 条 + 回归**（约一个 R 步的量；**已派出 R7b，2026-09-22**）：
   - 渲染 9：`server/frame-pipeline.mjs` 让 `fillCardControls` 按 `entry.prerenderSet` 挑卡（现在按 `frameMode === 'stateful'`）。
   - 架构 7：`src/editor/ProjectSettingsDialog.tsx` 加 fps 下拉；切 fps 后要重走 `ProbeGate`（成本键含 fps）。
   - 架构 9：`Preview.tsx` settle effect 的依赖补 `scrubbing`，时间轴点击 / 拖动松开发 `setTime(t, { settle: true })`。
   - 架构 10：`mediaStalled` 的阈值按 fps 取（`max(40, 1000/fps + 10)` 之类），或按「连续两拍超时」判。
   - 渲染 4：K3(b) 里按 `t_c = (t − t_start) × fps × t_oc` 取实际要追的帧数（分册 K3 写了，没实现）。
   - 回归：播放头在末尾按播放先 seek 到 0。
2. 顺手清 R5～R7 的零碎：`vtOk=false` 暂停补跑（R5-12）、互换两次失败要降级（R5-11）、就绪索引 `reset()`（R6-7）、`?preview=legacy` 合并舞台开关（R7-6）、给 `stageSwap` / `snapshotFeed` / `demote` 补单测。
3. 再开 R8（分册 `r8-streams-task.md`，先按 R8-11 把 G0-b 结论从汇总段落进正文、刷行号）。
4. R9、云端。

## 6. 怎么干活（约定）

- 我在 main 上统筹；可解耦的子任务派 Opus 进子 worktree（`isolation: worktree`），回来由我审查、重跑 `tsc` / `npm test` 后 `--no-ff` 合并。**用户点名 Opus，别自行换模型**；Opus 529 过载时等一会再试。
- 每个 Agent：一开工建报告并**先提交一次**、每块一个提交、不 push、不合并、不建 junction、不 `npm ci`（worktree 在仓库目录下，`node_modules` 向上解析）。
- **端口**：用户常驻 5190 不碰；R7 之后每个 dev server 占「端口 +1、+2」当舞台端口，所以派 Agent 时按 10 个一段分（5211～、5221～……），`.claude/launch.json` 的 `dev-test` 在 5203。
- **不读写** `%LOCALAPPDATA%\PromptCut\runtime\app`；不杀不是自己起的进程；不装东西；D: 是 USB 机械盘，临时文件放 C:。
- 用词：文档和注释里「预渲染」「生成快照」，不写「烘焙 / 烘」「冻结」（讲 `t` 停住可说「冻住」）；代码标识符不受限。「冻结」在文档里还有 81 处没清（S38-11）。
- 改 `user_pinned_goal.md` 必须弹窗给用户看原文；改交互（pinned 交互 1～3）要问；破坏性操作要问。收尾用 `task-announce`。
- **验收陷阱**（各步报告里踩过的）：无头 Chrome 的 rAF 会退到 10 Hz，帧间隔要带 `--disable-gpu-vsync --disable-frame-rate-limit` 或在有头下量；导出比对每棵树第一趟冷起会因字体预热差 35 帧；React `<Profiler>` 在舞台里恒报 0（舞台的 `performance.now` 被虚拟化，量耗时用 `__pcRealNow`）；`editor-preview-smoke.mjs` 是 order-dependent 的，一探针一台新 server；连续 HMR 很久的 dev server 会让舞台 iframe 停在旧模块上，跑探针前重启。

## 7. 仓库里的杂项

- `.claude/worktrees/agent-af0dae85c12674862`：上一轮被额度打断的 R1 前身，18 个未提交改动，**已被 R1 取代**；留着没删（删要用户点头）。其余 14 个 Agent worktree 和分支已清掉。
- `nul`（仓库根，未跟踪）：Windows 下某次重定向留下的空文件，可删。
- `out/card-costs.json`：R1 / R4 的成本记录，dev 模式；`out/pipeline-tuning.json` 不存在 = 全用缺省系数。
- 桌面壳：`lib.rs` 的端口预检和 `smoke-boot.mjs` 改了但没真构建、没真跑。装构建要在用户机器上做。
- 我的记忆笔记（`~/.claude/projects/C--Users-admin-Documents-PromptCut/memory/`）记了端口、工作方式、文档入口，重开会话会自动带上。

## 8. 关键提交（main，从 `dfef7e8` 起共 115 个）

合并提交按顺序：`e67390e` R1 → `dd58cb5` R1b → `f5f9fbd` / `7114ef9` 分册 → `2802e8b` 用词清理 → `a98d3a5` 流原型探针 → `52eab98` R2 → `62810bb` R4a → `8c566e3` R6 → `2986755` R3 → `945c4ba` 快照冻帧修复 → `ed9a080` R4b → `c76dc95` R5 → `e5a873c` R7（翻开关是其中单独一个提交 `9b88e9b`，摘掉它就回 legacy 缺省）。
