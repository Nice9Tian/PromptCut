# AGENT 报告：〔裁〕R01 被推翻后的返工

分支 `claude/revert-r01`，工作区 `.worktrees/revert-r01`，基于 main `0e98a96a`（已含 `claude/cut-stream` 的合并 `6bebd67f`，随 0.7.20 发出）。端口段 5900～5919。没有推送、没有合并、没有改 `docs/semantics/**`。

上一轮报告：`docs/archive/agent-reports/AGENT-claude-cut-stream.md`。

〔裁〕R01 是 2026-10-22 用户对「剪辑段里毛玻璃这类卡产不产流」的裁定；上一轮为了把它做通，给剪辑段的嵌套场景挂了 `clip-path: inset(0)`（一条二级〔裁〕，用户看得出：剪辑段里的毛玻璃不再透过剪辑段去模糊段外的层）。用户 2026-10-23 原话：「那条裁定我推翻，把 clip-path 那一行拿掉，R01 按做不通处理并返工。」

## 结论

- **R01 退回到 0.7.20 之前的样子**：`clip-path` 拿掉了，剪辑段里的毛玻璃恢复成透过段去模糊段外的层；剪辑段里依赖下层、没审阅过的卡回到「没有流、不抑制、在嵌套场景里活渲」。退回的那些文件和开工提交 `b362e254` 逐字节相同（只有 `streamPlanRules.mjs` 是手改的，见下）。
- **R02 保住了**：拿掉 `clip-path` 后重跑 R02 端到端探针，全过，读数和上一轮一模一样（剪辑段里的卡 0.383/255、顶层对照卡 0.565/255）。R02 的场景里没有毛玻璃，跟 `clip-path` 本来就无关，实测也证实了。
- **截图代码指纹不变，线上不会再全量重产**：`server/bakery/capture-below.mjs` 一字没动，`captureCode` 仍是 `0d5cb32d3eb92a1f34d79a80acf5b50d`（与 main 相同）；生成快照的指纹 `snapshotCode` 也不变（`f8b0e1bc137b03c4d779488ff9040c10`）。流的代码版本 = `STREAM_CODE_VERSION:captureCode`，两样都没变，所以已有的轨道流键都不变，部署后不重产。
- **缺省的键与 main 逐字相同**：没有剪辑段的项目整张流表、顶层的流、剪辑段里原有的独立卡的流，和 main、和 `b362e254` 都逐字相同；有剪辑段的项目整张流表与 `b362e254` 逐字相同（比 main 少了那两条剪辑段里依赖下层的流）。
- **像素基线没变**：与 `5f4523d0` 的全长导出逐字节相同 1800/1800。
- **门槛全过**：类型检查 0 错误；全量 `npm test` 7684 条 0 失败；两种构建通过；导出确定性 1800/1800；快照重放 PASS。

## 拿掉了什么、R01 退到什么程度

目标是「这类卡回到原来没有流的状态」，不是撤整个分支。R01 专用的改动全部退回；R02 和那个独立的缺陷修复保留。

| 文件 | 处理 | 说明 |
|---|---|---|
| `src/render/CutSegmentScene.tsx` | 退回 `b362e254` | 拿掉 `clipPath: "inset(0)"` 和讲采样边界的那段注释 |
| `src/kernel/cutFlatten.mjs`、`.d.mts` | 退回 `b362e254` | 删掉 `flatScenePrefix`、`isolatedFlatBelowProject`（只给 R01 用） |
| `src/render/streamInputSig.mjs` | 退回 `b362e254` | `belowLayersOf` 不再按嵌套场景筛下层 |
| `server/card-identity.mjs` | 退回 `b362e254` | 依赖下层的流的键不再收 `within` |
| `server/frame-stream.mjs` | 退回 `b362e254` | `belowStreamSpecs` 不再算 `within`；`isolatedStreamProject` 不再有剪辑段依赖下层那一支；`queueStreamOf` 不带 `within`；`mountClipOf` 回到本文件里那一份 |
| `src/editor/snapshotFeed.ts`、`src/editor/stageSwap.ts` | 退回 `b362e254` | 剪辑段里只有独立卡判重、抑制、贴流；依赖下层的卡照旧活渲 |
| `src/render/streamPlanRules.mjs`、`.d.mts` | 手改 | `belowStreamEligible` 恢复「剪辑段里的卡不出依赖下层的流」；`belowTargets` 恢复原来的挂载帧算法；删 `flatClipStreamKind`。保留 R02 的两样：`soloStreamKind` 的注释（浏览器也产外框平面的 `'flat'`）和导出的 `mountClipOf`（在线页面算预算要用，和 `frame-stream.mjs` 里那一份一字不差） |
| `server/test/cut-flatten-streams.test.mjs`、`src/editor/snapshotFeedBelow.test.mjs` | 退回 `b362e254` | 上一轮为 R01 改的断言、加的用例退掉 |
| `server/test/cut-below-streams.test.mjs` | 改 | 删 R01 的 CB-plan、CB-key、CB-iso、CB-mount；CB-golden 改成「两份场景的整张流表都与 `b362e254` 逐字相同、剪辑段里两张卡的签名也回到开工提交的算法」；加 CB-r01（剪辑段里依赖下层的卡没有流、没有带 `within` 的流、嵌套场景不挂 `clip-path`）；R02 的 CB-split、CB-page、CB-bake 不动 |
| `scripts/probes/cut-below-stream-probe.mjs` | 删除 | R01 的端到端探针，退回后它必然红；上一轮的读数和截图留在 `docs/archive/agent-reports/assets/cut-stream/r01/` |

**保留不动的**：

- R02：`server/render-node/split.mjs`、`src/online/pageStreamPlan.ts`、`src/online/bakeTask.ts`、`src/editor/stageBake.ts`、`src/StageView.tsx`、`src/render/stageRpc.ts`、`src/render/createSnapshot.ts`、`src/editor/stageBakeFlat.test.mjs`、`scripts/probes/cut-online-browser-probe.mjs`、`scripts/probes/cut-online-e2e-probe.mjs`（断言 B）。
- 缺陷修复：`src/render/snapshot/inlineStyles.ts`（浏览器给嵌套卡生成快照时继承属性一律内联，不然字偏约 4 像素）。

**一处故意没退：`server/bakery/capture-below.mjs`**。上一轮为 R01 在里面加了两样：藏目标卡时也认嵌套包裹层 `[data-pc-flat-clip]`；找毛玻璃外框时祖先查到 `[data-pc-cut-scene]` 为止。R01 退回以后，这两样都走不到了：剪辑段里的卡不再出依赖下层的流，差分取层的目标只会是顶层的卡；顶层的卡不会在嵌套场景里，查祖先也碰不到 `[data-pc-cut-scene]`。所以它对画面没有任何影响。

不退是为了指纹：这个文件在截图代码指纹 `captureCode` 的文件表里，改它哪怕一个字（包括注释），所有轨道流的键都会再换一次、线上全量重产一轮。代价是它的文件头里留着一句已经不成立的说明：「嵌套场景是毛玻璃的采样边界（`CutSegmentScene` 的 `clip-path`）」。建议等下一次本来就要改截图代码时顺手删掉这两样和这句注释，到时只重产那一次。要现在就清干净也行，告诉我就改，代价是部署后全量重产一次。

## 指纹与身份键（核对办法同上一轮）

用同一份场景（`server/test/cut-below-fixtures.mjs`）在三棵树上算：main `0e98a96a`、本分支、`git archive b362e254` 解出来的树。流的每一项原样哈希，只是控件里只留和流有关的键（`streamMemberKey`、`cacheContentKey`、采样窗口、帧数）。

| 项 | `b362e254` | main `0e98a96a` | 本分支 |
|---|---|---|---|
| `captureCode`（截图代码指纹，进流的代码版本） | `4acb6675…` | `0d5cb32d…` | `0d5cb32d…`（同 main） |
| `snapshotCode`（生成快照的指纹，不进流的键） | `3df63948…` | `f8b0e1bc…` | `f8b0e1bc…`（同 main） |
| 没有剪辑段的项目，整张流表 | `d433e1b11d0af435` | `d433e1b11d0af435` | `d433e1b11d0af435` |
| 有剪辑段的项目，整张流表 | `72c7b90197564be3` | `aaaeb12ce2c4c68e`（多两条剪辑段里依赖下层的流） | `72c7b90197564be3` |
| 其中原有的 5 条流（顶层独立卡、剪辑段里三张独立卡、顶层毛玻璃） | 逐条相同 | 逐条相同 | 逐条相同 |
| 顶层两条依赖下层的流的签名 | `s1-c03e47ff075c67d9`、`s1-b008c155a4d05838` | 同左 | 同左 |
| 剪辑段里那两张卡的依赖下层签名 | `s1-eb0a1cc7f47115fc`、`s1-be41e3749588320b` | `s1-0b19e647…`、`s1-f95e6cf4…` | 同 `b362e254` |

这些写成了单测 CB-golden，全量里过。

对线上的影响：

- 已有的流（顶层的、剪辑段里独立卡的）键全不变，不重产。
- 0.7.20 在线上为剪辑段里毛玻璃产过的流（带 `within` 的那种），退回以后没人再引用，成了无害的孤儿，不用删。
- 页面不会把它们贴上去：剪辑段里依赖下层的卡不再判重，父页不给它发流平面；就算就绪索引里还挂着这一层，也不进抑制集合。

## R02 实测（拿掉 clip-path 之后）

`node scripts/probes/cut-online-browser-probe.mjs --dist dist-online --base-port 5910 --out out/probe-b`（在线构建是本分支 `npx vite build --mode online` 出的）：退出码 0，`fails: []`。结果 JSON 存在 `docs/reports/assets/revert-r01/r02-probe-result.json`。

| 条 | 读数 |
|---|---|
| A 产 | 层表里 V 一行普通单卡流，候选第一个是页面的指纹 `ec313bc687208b5c`，编码器 `["webcodecs-avc"]`，满密度 |
| B 谁产的 | 页面节点 `streamTasks: 1`、`failed: 0`；切分方（只切分）自己那一份清单一个分段都没有 |
| C 播放 | 33 个样本里 32 个在画，键对、父页推的字节、0 报错 |
| D 像素 | 剪辑段里的卡：与同一帧精确活渲，3×3 模糊后 0.383/255、差得多的像素 0.002%（不模糊 0.505）；对照帧 4.71。顶层同一张卡：0.565（对照 5.24） |

回归：`node scripts/probes/cut-online-e2e-probe.mjs --dist dist-online --base-port 5910 --out out/probe-cut-online` 退出码 0，`fails: []`。

## 门槛

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `npm test`（命令里设两个账号变量，反斜杠写法） | 汇总行原文：`ℹ tests 7684`、`ℹ pass 7669`、`ℹ fail 0`、`ℹ cancelled 0`、`ℹ skipped 15`、`ℹ duration_ms 195785.2854`；`✓ npm test 最终结果：零失败`；日志 924,888 字节。CB-golden、CB-r01、CB-split、CB-page、CB-bake、QM-FLAT-01、QM-FLAT-02 都打了 ✔。条数比上一轮少 4：删了 R01 的 4 条单测和 1 条父页用例，加了 CB-r01 |
| 桌面构建 | `npm run build` | 退出码 0 |
| 在线构建 | `npx vite build --mode online` | 退出码 0 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url http://127.0.0.1:5900/?export=1`（本工作区起的开发服务器，带 `PROMPTCUT_NO_PORT_FILE=1`） | `Identical: 1800`、`Different: 0`、`All frames are identical. Determinism verified!` |
| 快照重放 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5900` | `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; PNG table and frames/ hold all 10 frames; no preview.mp4 / full.mov.` |
| 与 `5f4523d0` 的像素比对 | `git archive 5f4523d0` 解到 `out/baseline-5f45`，两棵树各用自己的 `scripts/export-frames.mjs --url …/?export=1 --fps 30 --workers 1 --no-video`（5900，先后跑），再 `node scripts/probes/export-baseline-compare.mjs --baseline … --candidate …` | `逐字节:相同 1800/1800`、`✅ 全长导出逐字节相同` |

## 没做的、要知道的

- `capture-below.mjs` 里那两样走不到的代码和一句过时注释，为了不让指纹变故意留着，见上。
- 语义：`docs/semantics/` 我没碰。合并时 main 上如果已经按 R01 做通改写过 `mechanism/rendering.md`「哪些卡有流」，要改回「剪辑段里依赖下层、源依赖、没审阅过的卡不产流、不抑制，照旧在嵌套场景里活渲」，并写明 R01 于 2026-10-23 被推翻。R02 那半句（剪辑段里外框平面的独立卡浏览器节点和在线页面本页也产）保留。`product/rendering.md` 第 15 行里用户 2026-10-22 那句原话（「毛玻璃卡带着下层一起产轨道流」）现在和代码对不上，要不要加一句「2026-10-23 推翻」请主会话定。
