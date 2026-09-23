# 遗留分支与工作区审查

审查日期：2026-09-23。基准：`main` = `04eb0af`（与 `origin/main` 一致）。

## 总览

| 分支 | 工作区 | 领先 main | 落后 main | 结论 |
|---|---|---|---|---|
| `evaluate_module_coupling` | `~/.gemini/antigravity/worktrees/PromptCut/evaluate_module_coupling`（干净） | 0 | 212 | 已全部并入 main，**可删** |
| `find_unfinished_plan` | `~/.gemini/antigravity/worktrees/PromptCut/find_unfinished_plan`（干净） | 0 | 216 | 已全部并入 main，**可删** |
| `probe/audio-watchdog` | 无（已拆） | 1 | 44 | 等用户拍板「待定 5b」，**暂留** |
| `worktree-agent-af0dae85c12674862` | 无（已拆） | 1 | 216 | 被 R1 取代的半成品存档，**可删** |

「领先 0」用 `git rev-list main..<分支>` 核对：分支尖端就是它与 main 的合并基点，分支上没有任何 main 里没有的提交。两个 antigravity 工作区 `git status` 为空、无 stash，删掉不会丢东西。

## evaluate_module_coupling

- **目的**：用 agy（Antigravity）评估模块耦合，并按评估结果拆分集中式代码。提交有：`7505362` 把集中的项目状态拆成按领域的 actions；`da38bbe` 把 MCP 工具的大 schema 拆成按领域的模块；`5d390fd` 写架构建议和插件化重构的远景计划。
- **进度**：2026-09-21 经 GitHub PR #1（`e8d36e1`，来自 Nice9Tian/evaluate_module_coupling）合进 main。随后远端分支又补了修复提交 `fba57c3`（拆分时丢了 `get_clip` / `set_camera3d`，补回，并让编译器重新守住 `EditorApi`），这一提交也已在 main 里。本地分支停在 `5d390fd`，比远端落后 1 个，但两者都已并入。
- **建议**：废弃。拆掉工作区、删本地分支；远端 `origin/evaluate_module_coupling` 也可以删（删远端属于对外操作，需要你确认）。

## find_unfinished_plan

- **目的**：从名字和唯一提交看，是在 agy 里「找出没做完的计划并接着做」的会话。分支尖端 `b5c65dc`（2026-09-17）：「解耦：舞台 RPC、镜像插件、快照格式、图卡接替 Python 卡（任务书第 1～3 步）」。
- **进度**：`b5c65dc` 已在 main 的历史里（main 在它之后又走了 216 个提交），工作区没有未提交改动。之后的重构（R0～R7b）都在 main 上完成，未完成的计划现在统一记在 `docs/plan/TODO.md`。
- **建议**：废弃。拆掉工作区、删分支。

## probe/audio-watchdog

- **目的**：试验交接文档的「待定 5b」（架构 10）：舞台停顿**进行中**音频是否应立即停。现有逻辑是事后判：迟到的那一帧到了才置 stalled，所以停顿期间音频照播。见 `docs/archive/restructure_planning/hand_off.md` 第 63 行、`reports/r7b-report.md` 第 314、334 行。
- **改动**（`058699d`，2026-09-22，3 个文件，+583/−2）：
  - `src/editor/Preview.tsx`：加播放中的看门狗。每收到一条 `frame` 就重设一个「一拍 + `MEDIA_STALL_MS`」的定时器，定时器到点还没来新帧就当场暂停音频，下一帧一到就恢复。只有 `window.__pcAudioWatchdog = true` 才启用，默认关。
  - `scripts/probes/audio-stall-probe.mjs`：舞台卡顿时测音频偏差的探针。
  - 实测数据 JSON（4 倍 CPU 降速，每项 3 次）。
- **实测结论**（3 次平均）：

  | 场景 | 停顿期间音频照播 | 最大音画偏差 | 恢复对齐用时 |
  |---|---|---|---|
  | 不加看门狗，停顿 300 ms | 303 ms | 247 ms | 3083 ms |
  | 加看门狗，停顿 300 ms | 49 ms（约 89 ms 内停下） | 80 ms | 1047 ms |
  | 不加看门狗，停顿 1000 ms | 999 ms | 953 ms | 3056 ms |
  | 加看门狗，停顿 1000 ms | 53 ms（约 86 ms 内停下） | 77 ms | 650 ms |

  正常播放（24 / 30 fps）开看门狗后没有误判，`stallCount` 为 0。
- **状态**：
  - 代码可用，但分支落后 main 44 个提交。
  - `git merge-tree` 试合有一处冲突：文档重整时 main 把 `restructure_planning/` 整体挪到了 `docs/archive/restructure_planning/`，分支里新增的 JSON 还在旧路径上。只是文件位置冲突，挪一下即可；`Preview.tsx` 在 main 上自分叉后没被改过。
  - `docs/plan/TODO.md` 第 19 行把它列为「待用户定」。`docs/plan/audio_structure_plan.md` 第 140、260 行指出，音频改成浏览器端 JS 之后，看门狗只是「定时器到点就 `suspend()`」，也要你定加不加。
- **建议**：分支先保留，由你拍板 5b。
  - **要看门狗**：音频整体改写（A0～A7）还没动工，看门狗不必合进现在的 `Preview.tsx`，直接写进新引擎即可。本分支的探针和数据留作验收依据：`audio_structure_plan.md` 第 147 行已经有「停顿开始后 ≤ 80 ms 内停下」这条验收。拍板后把探针脚本和 JSON 挪到 `docs/archive/restructure_planning/reports/` 与 `scripts/probes/` 合进 main，`Preview.tsx` 的改动不合，然后删分支。
  - **不要看门狗**：把结论写进 TODO / 音频计划，探针数据按需归档，然后删分支。

## worktree-agent-af0dae85c12674862

- **目的**：差异样式内联。生成快照时只把与继承值不同的样式内联进去，以缩小快照体积。这是另一个子 Agent 会话的工作区，基于 `b5c65dc`，从没交付。
- **改动**（`e37ba9e`，2026-09-23 为存档才提交，18 个文件，+1172/−180）：`src/render/freezeStyleProps.mjs`（新）、`snapshotFreeze.ts` 大改、若干探针（`freeze-diff-compare`、`inherited-props-probe`、`probe-kit`）、`vite-plugin-*` 与 `costs-store` 的零碎改动、一个新测试、`docs/snapshot-size-audit.md` 的改写。
- **状态**：提交信息明确写了「被 R1 取代，仅留历史」。它落后 main 216 个提交，碰的 `snapshotFreeze.ts`、`vite-plugin-*` 后来都经过 R0～R7b 的大量改动，已经无法直接合并。`docs/snapshot-size-audit.md` 在 main 上也已改名或归档，旧位置不在了。
- **建议**：废弃，删分支。如果以后还想参考思路，记下提交号 `e37ba9e` 即可：删分支后提交会在 reflog 里留一段时间，但不保证永久保留。要永久留存就改成打 tag，例如 `archive/diff-style-inline`。

## 顺带发现（不在点名范围内）

- `git worktree list` 里还有两个仓库外的工作区：`…/Temp/claude/…/47e180dc…/scratchpad/pc-head`（另一个 Claude 会话的 scratchpad，detached `0ba58cb`）和 `Documents/DesignWithAgent/PromptCut-Comparison/runtime/PromptCut`（detached `f204690`）。它们归别的会话或项目所有，本次没碰，也不建议在这里处理。
- 远端 `origin/claude/wonderful-mayer-blc7xr`（2026-09-23）领先 main 0 个提交，已并入，远端分支可删（需你确认）。

## 建议的清理命令（未执行，等你确认）

```bash
git worktree remove C:/Users/admin/.gemini/antigravity/worktrees/PromptCut/evaluate_module_coupling
git worktree remove C:/Users/admin/.gemini/antigravity/worktrees/PromptCut/find_unfinished_plan
git branch -d evaluate_module_coupling find_unfinished_plan
git branch -D worktree-agent-af0dae85c12674862
# 可选，对外操作：
git push origin --delete evaluate_module_coupling claude/wonderful-mayer-blc7xr
```

`evaluate_module_coupling` 和 `find_unfinished_plan` 已并入 main，`-d` 就能删。`worktree-agent-…` 没并入，要用 `-D` 强删。
