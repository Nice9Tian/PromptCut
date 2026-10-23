# AGENT-claude-clip-silent-badge

把时间轴上「已静音 / 无原声」角标的判据改对。分支 `claude/clip-silent-badge`，从 `main`（`b3893261d`，0.7.23）切出，未推送、未合并。

## 问题

0.7.23 放开了两件事（语义 `docs/semantics/product/project-model.md`「声音」那一条，2026-10-23 用户定）：

- **声画一体卡挂在变速段上照常出声**（用户「出声。」，推翻同日早先的〔裁〕V21-28 —— 〔裁〕是会话在语义说不下去时做的临时裁定，要用户事后审）；
- **变速的视频段可以当音频素材效果卡的声音输入**（用户「放开。」）。

但角标还按老判据画：`speedMutesSource()` 一真就标。它判的是「变速段不出原声」，于是一个**明明在出声**的片段被标成没声音。桌面版和手机版三处都这样。

## 改了什么

判据改成「**原声不出，而且没有任何卡片声音挂在它上面**」，放在 kernel 一处：

- `src/kernel/cardAudioRendition.mjs` 新增两个纯函数：
  - `clipHasCardAudio(project, clip, getCard)` —— 挂在这一段上的卡片声音：声画一体卡、音频素材效果卡、已经生成好的那一份。和现成的 `clipHasAudio` 差的就是末尾 `media.kind` 那一截（那一截说的是原声）。
  - `clipGoesSilentBySpeed(project, clip, getCard)` —— `speedMutesSource(...) && !clipHasCardAudio(...)`。
  - 声明同步加进 `cardAudioRendition.d.mts`。
- `src/editor/timeline/clipSilence.ts`（新）：桌面版和手机版共用的薄封装 `clipMakesNoSound(project, clip)`。它在 kernel 那条判据之外只多补一件 kernel 够不着的事 —— **同步来的定制卡**：在线页面上用户卡的定义不在本机卡册里，卡自己声明的内嵌声音只能从 `syncedUserCards()` 问（`MediaLayers.tsx`、`exportSounds.ts` 也是这么补的）。放这一层是因为 `syncedUserCards` 是卡册的运行期状态、不属于项目数据，kernel 那条判据拿去单测才不用起卡册。
- 三个调用点换成它：`src/editor/timeline/ClipMuteBadge.tsx`（桌面）、`src/mobile/FullTimeline.tsx`、`src/mobile/ThumbStrip.tsx`。`clipMuteReason` 的 `project` 形参顺手从一个临时的结构型收紧成 `Pick<Project, "cardNodes" | "media">`。

**判的是「挂在这一段上」**：别处的卡接走这一段的素材当输入时，声音是从那张卡出来的，不算这一段在出声 —— 角标画在这一段上，说的就该是这一段。

没碰点名不许动的那几个（`server/bakery/` 七个文件、`src/render/createSnapshot.ts`、`src/render/snapshot/*`、`src/render/snapshotRename.ts`、`src/render/gl/canvasGrab.ts`）。

## 验证

按 2026-10-23 的规矩只跑受影响的，没跑全量。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 构建 | `npm run build` | `✓ built in 1.41s`，退出码 0（chunk 大小与 dynamic-import 两条警告是原有的，和本次无关） |
| 受影响测试 | `npm test -- src/kernel/cardAudioRendition.test.mjs src/kernel/clipAudioState.test.mjs src/kernel/clipTime.test.mjs src/mobile/mobile.test.mjs src/layering.test.mjs src/online/modeImportGuard.test.mjs src/pageNodeImports.test.mjs src/tailwind-scan.test.mjs` | 37 条，37 过、0 失败、0 跳过 |

怎么算「影响到」：改的两个 kernel 文件自己的测试（`cardAudioRendition`）、用到 `clipMuteReason` 的（`clipAudioState`）、`speedMutesSource` 本家（`clipTime`）、改了的手机版两个文件（`mobile`），加上四道守门 —— 分层（`layering`，手机版新引了 `src/editor/` 下的东西）、在线构建的 import 链（`modeImportGuard`，新引了 `kernel/registry`）、页面节点 import（`pageNodeImports`）、样式扫描（`tailwind-scan`）。

### 新增的四条用例（在 `src/kernel/cardAudioRendition.test.mjs`）

正是任务书点名的四种情形：

1. 变速段 + 声画一体卡 → 不标（另覆盖「卡的声音已生成好」「节点或片段上声明了内嵌声音」两种写法）
2. 变速段 + 音频素材效果卡 → 不标（节点登记成 `adapter:card`+`kind:audio` 的，和只认得卡片定义 `def.audio` 的，两种都测）
3. 变速段什么卡都没挂 → 标（另覆盖「挂了一张不出声的卡」仍然标）
4. 不变速的段行为不变（`speed` 为 `undefined` 和 `1` 两种；另覆盖变速的**声音**素材段、没有素材的纯卡片段都不标）

### 变异检查

把 `clipGoesSilentBySpeed` 退回成只有 `speedMutesSource(clip, project)`（即老判据）重跑：**正好第 1、2 条变红**，第 3、4 条照过（它们本来就不该受影响）。还原后 12 条全过。说明这次的判据是真起作用的，不是测试自说自话。

## 没做到的

- **没有在真界面上截图**。角标这次的变化是「本来会出现的角标不再出现」，要摆出一个「变速段 + 挂着声画一体卡」的真项目才看得到差别；判据是纯函数且有上面的变异检查兜底，所以我用测试代替了看图。要截图的话说一声，我起 dev server 摆一个这样的项目。
- **没跑全量**，按 2026-10-23 的规矩。发版前那一次会覆盖到。

## 顺带修的一件

`my_agent/`（给读不到 `promptcut-dev` 技能的工具准备的简版要求）按技能要求复制进仓库后**被提交了** —— 技能说「正常情况下仓库 `.gitignore` 里带着 `/my_agent/` 这一行」，实际没有。已从索引里移除并补上那一行（提交 `b0d60694`）。这一条和角标无关，要是你不想在这条分支上带它，单独丢掉那个提交即可。
