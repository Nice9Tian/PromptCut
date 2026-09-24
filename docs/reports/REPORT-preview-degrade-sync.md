# 报告：预览重卡变透明与时间轴改后预览陈旧

分支 `claude/fix-preview-degrade-sync`（基于 139638f），worktree `.claude/worktrees/fix-preview-degrade-sync`，端口段 5230–5239。
智能体 A（Opus）做 A0～A5；占位组件由智能体 B（`claude/placeholder-plane`，报告见 `REPORT-placeholder-plane.md`）交付；
P3 集成、`unsupported` 状态与 P4 验收由主会话完成（见文末两节）。子 Agent 写不进本文件，正文由主会话按其回报誊录。

## A0 语义文档

`rendering.md` 写入「兜底顺序」与占位符；`platforms.md` 第 34 行改为「显示占位符」；`glossary.md` 加「兜底顺序」「占位符」。

## A1 根因 A、B

- A：推送基线按客户端记（`pushedBy` WeakMap），互换走新增的 `swapStageClients`，`swapRoles` 不再 `markPushed`；`swapAndDress` 末尾补推一次 `syncProject` 增量，两条互换路都覆盖。
- B：`snapshotFeed` 按角色记「暂停态已 settled」集合（暂停态互换后整台记为已 settled），暂停中不再给它们投快照，下一次 setTime / play 清空。
- 两份复现转正为 `stageSwapBaseline.test.mjs`、`snapshotSettled.test.mjs`，先红后绿。

## A2 根因 E、疑点 F

- E：订阅只按 session 做键。真正的元凶是 Preview 里依赖 `project` 的那个 effect 的清理函数每次编辑都 `stopSnapshotFeed()`；拆成两个 effect。
- F 坐实（`server/test/ready-stale-flush.test.mjs`）：`flushSnapshots` 在 `adoptedEntryKey !== entry.key` 时不发布。

## A3 根因 C、D，疑点 G

- `planesWithinBudget` 舞台 `sync()` 与父页共用；超预算的卡当「无流」。
- picks 带档位 none / over / poster；海报 ≥ 15 帧才换；一次投递 ≤ 2 MB 按 none > over > poster 装，装不下的这一拍留上一张。
- `demoteReady` 按当前位置起的覆盖窗口判（流按分段、快照按帧）。
- `coverSnapshot` 覆盖组流成员。
- G 坐实（`streamFallback.test.mjs`：清单只拉一次）：当前段是稀疏段时按节流重拉清单，同键 ranges 变化也重拉。
- `snapshotFeed.test.mjs` 里两条旧断言按新语义改写。

## A4 占位符接入

`placeholderHost.ts`（开关、T1～T4、只切 `hidden` 的显隐、几何：流实体框 → 墨迹框 → 徽标）；`Stage` 每卡挂一个默认 `hidden` 的槽位；
`planeStyle` / `pinAnimations`（含对照单测）/ `createSnapshot` / `contentBox` / `solid` 排除占位节点；`hitTest` 点中占位符算点中所在卡。
墨迹框换算到包裹层局部坐标，转正时补量；退成后台舞台时摘样式表。

## A5 回归与探针

新增 `scripts/probes/preview-fallback-probe.mjs`：起播、跳转、超过 6 路流、编辑后四个场景逐拍记录每张被抑制卡所处的级别。

## 基线（A 的最终一轮）

- `npx tsc -b --force`：退出 0。
- `npm test`：1864 项，1863 通过、1 跳过、0 失败（其间一次 `src/ai/orchestrateReal.test.mjs` 计时偶发失败，单跑 3/3 通过、最终整跑通过）。
- `verify-determinism --url http://127.0.0.1:5230/?export=1`：1800/1800 帧一致。
- `PC_FRAME_TEST_URL=http://127.0.0.1:5230 node scripts/verify-unified-frames.mjs`：PASS。
- 导出像素基线：139638f 与本分支各导 90 帧夹具，`export-baseline-compare` 90/90 逐字节一致。
- `editor-preview-smoke.mjs --stage`：fails []。
- `preview-fallback-probe.mjs`：四场景透明拍数均为 0；分级 dense 503 / snapshot 153 / placeholder 500，120 ms 延迟空档单列 27；
  hitTest 点中占位符回到所在卡；快照里没有占位节点；后台舞台 0 个槽位、无占位样式；7 路流时父页发 6 个平面、建 6 个解码器，第 7 张落到快照。

## 没做成的及原因：每拍主线程耗时 p90

CDP `TaskDuration`（只取可见舞台那一路），按 33 ms 采样；「修复前」为 139638f。

| 场景 | 修复前 p90 | 修复后 p90 | 不含占位符（修复前 → 后） |
|---|---|---|---|
| 起播 | 7.3 | 13.1 | 4.3 → 7.7 |
| 跳转 | 8.1 | 8.0 | 19.4 → 16.6（噪声大） |
| 超过 6 路流 | 14.9 | 35.2 | 14.8 → 24.7 |
| 编辑后 | 9.5 | 18.1 | 4.2 → 8.0 |

p50 与修复前接近。p90 的增量来自：每 15 帧换一次海报快照（粒子卡快照 276 KB，postMessage + 改名 + innerHTML + React 提交）、
同屏的占位符、超过 6 路时第 7 张卡每拍换快照（以前直接透明）。已去掉一项先前就存在的大开销：React 19 每拍重写整张快照 innerHTML（3 秒 257 ms），p50 从约 7 ms 降到约 3.5 ms。

## 对语义或任务书的更正建议（A）

1. `platforms.md` 第 35 行：建议改为显示占位并保留时间轴提示（P3 已按用户协议改为 `unsupported`，见下）。
2. contract 没规定组件根元素的初始显隐，已用槽位托住（P3 已写进 contract）。
3. `stream-editor-e2e.mjs` 的「流覆盖时不投快照（A3c）」断言与新语义冲突，需要改。
4. 与 F 同类未修：`renderLocalSnapshots`、`missingSnapshotFrames` 发布前也不比对 entry key；`cardRender` 对它渲的任意 entry 调 `adoptCardPlan`，可能把页面的索引 reset 掉。
5. 双舞台模式下编辑后没有任何页面代码触发 preload，服务端不会 reset；页面继续显示旧层（属「沿用旧的预渲染结果」）。谁来触发 preload 需要定。
6. 稀疏段到满帧段的替换只能在下一个分段起（P3 已把 rendering.md 改成这样写）。
7. 墨迹框按舞台各量一份；K5 互换后新 front 转正时补量，此刻不可见的卡退到徽标；旋转的包裹层只在等比无斜切时精确解框，接近 45° 退回外接框。

## P3 集成（主会话）

- `--no-ff` 合并 `claude/placeholder-plane`；`Stage.tsx` 换成真组件，删掉桩 `placeholderStub.tsx`。
- 按 contract 修正 B 的产出：根元素去掉 `pointer-events:none`（`hitTest` 用 `elementsFromPoint`，带它会点不中占位符）；静止标记改认槽位。
- contract 补进：`PLACEHOLDER_SLOT_ATTR` / `PLACEHOLDER_FIXED_ATTR`（槽位与常驻槽位）、`PLACEHOLDER_STATIC_ATTR`（同屏超过 `maxAnimated` 时的静止标记，由 `applyPlaceholders` 按顺序加）、`unsupported` 与 `UNSUPPORTED_TEXT`。
- `unsupported`（用户协议第 1 条）：在线浏览器模式下的用户卡、图卡不跑卡片代码，常驻显示「电脑 + 离线」图标和「需要本地 PC 渲染辅助」，不显示沙漏、不铺噪点。
  在线浏览器模式本身尚未实现、没有运行期判据，现在由编辑页地址 `platform=browser` 显式打开（经 `stageSrc` 转给舞台）；模式落地时换成真的判据。
  `rendering.md`（兜底顺序末条）、`platforms.md` 第 35 行、`glossary.md` 同步。
- 新增单测：同屏上限的静止标记、常驻槽位不受显隐调度、`unsupported` 判定、组件不带 `pointer-events:none`、`unsupported` 标记与文字。

## P4 验收（主会话）

见文末追记。
