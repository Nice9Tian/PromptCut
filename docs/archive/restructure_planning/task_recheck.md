# 任务复核（task_recheck）

复核对象：`restructure_planning/` 下的全部计划任务（总览 `render_pipeline_restructure.md` + 分册 `r2-r7-task.md` / `r8-streams-task.md` / `r9-webgl-task.md` / `cloud-task.md` + `landed-notes.md` / `future_planning.md`），对照执行者自报的 `render_pipeline_restructure_check.md`。
复核时间：2026-09-22，main `f69f229`。前提文档：`user_pinned_goal.md`（每位审查员都先读）。

## 做法

- 5 个 Opus 子智能体各管一段，只读代码和 git 历史、可跑单个单测文件，不起 dev server、不跑浏览器探针、不改仓库：
  - A：第 1 节查收、3.8、3.9、R0、R1、R1b、landed-notes
  - B：R2、R3
  - C：R4a、R4b、R6
  - D：R5、R7 + pinned 里的播放行为（fps、音频、暂停活渲）
  - E：R8、R9、云端、路径表、第 7 节决策、pinned 全条目对照
- 主会话（我）亲自跑的：`tsc -b --force` 零错误；`npm test` 1633 / 1632 通过 / 0 失败 / 1 跳过（与 check 文档一致）。
- 主会话抽查复核的三条重大结论（都成立）：
  1. `src/editor/ProjectSettingsDialog.tsx` 里没有任何 fps 项，全 `src` 没有改 fps 的界面（D / E 结论）。
  2. `src/editor/Preview.tsx:659-667` 的 settle effect 依赖里没有 `scrubbing`，拖动松开在原位时不会再发 `settle: true`（D 结论）。
  3. `entry.prerenderSet`（`server/frame-pipeline.mjs:920`）只写不读，全仓没有消费方（C 结论）。

## 审查员之间的冲突与仲裁

E 做的是 pinned 全局粗判，把「架构 9 暂停活渲」「架构 10 音频 40 ms」「渲染 9 预渲染只做重卡并集」标成「已实现」；C、D 逐行核后判为部分完成 / 未完成，并且主会话抽查证实。**以 C、D 为准**：
- pinned 架构 9 → 部分完成（时间轴点击 / 拖动松开大概率不发 settle，见 D 的 R5-16、P-3）
- pinned 架构 10 → 部分完成（24 / 25 fps 下 50 ms 拍间隔会误触发 40 ms 阈值，见 D 的 R5-6、P-1）
- pinned 渲染 9 → 未完成（预渲染集合算了没用，见 C 的 R6-2）

## 总计数（各审查员原始结论）

| 段 | 条数 | 已完成 | 部分完成 | 未完成 | 未开始 | 无法独立验证 | 按决定不做 |
|---|---|---|---|---|---|---|---|
| A 第1节/3.8/3.9/R0/R1/R1b | 54 | 39 | 4 | 2 | – | 5 | 4 |
| B R2/R3 | 40 | 31 | 2 | 1 | – | 4 | 2 |
| C R4a/R4b/R6 | 55 | 37 | 10 | 2 | – | 5 | 1 |
| D R5/R7/播放行为 | 35 | 21 | 10 | 3 | – | 1 | – |
| E R8/R9/云端/文档/决策 | 49 | 约 8 | 约 3 | 1 | 27 | – | 4 |
| E pinned 全条目对照 | 27 | 12 | 13 | 2 | – | – | – |

（E 的决策类条目还有「已写进分册、实现未开始」「未定」等状态，详见下文 E 段。pinned 对照以上面「仲裁」为准修正。）

## 最该先看的问题（按严重度）

1. **pinned 渲染 9 未落地**：服务端算出预渲染集合却不用，判轻的卡照样产快照、进就绪索引；「两张大 lottie 根本不生成快照」不成立。（C）
2. **pinned 架构 7：fps 下拉没做**，check 文档未记。（D、E，主会话证实）
3. **pinned 架构 9：时间轴点击 / 拖动松开大概率不发精确 settle**。（D，主会话证实代码路径）
4. **pinned 架构 10：24 / 25 fps 下音频反复暂停**（33 / 50 ms 交替拍 vs 40 ms 阈值）。（D）
5. **R7 回归：播放头在末尾按播放立即 ended、不重播**。（D）
6. **导出页 / 预渲染页没装虚拟定时器；`Date.now` 固定纪元 2026-01-01**——执行者替用户做的取舍，未进待定项。（B）
7. **页面与预渲染进程选 costs 记录的口径不同**，两端表可能不一致；超限快照帧每趟重渲；只有页面会话里第一个项目挡遮罩；`COST_SCALE` 只能往上调。（C）
8. **K3 / K5 缺口**：判轻 (b) 档 `vtOk=false` 卡暂停后无人补跑；(a) 档不分 `vtOk`；`runSettleSwap` 运行中丢新请求（「连点 10 次」证据不成立）；互换两次失败不降级。R5 核心模块零单测。（D）
9. **R1 的首条验收 `verify-unified-frames.mjs` 仍未通过**，check 前后说法矛盾。（A）
10. **pinned 渲染 4（长 motion 按播放位置估代价）未实现**，计划里也没说明被渲染 3 取代。（E）
11. 文档层：路径表缺 32 个新文件；R3 / R4b 更正没折回分册；「冻结」旧词还有 81 处；R8 分册 G0-b 回填不完整、行号漂移；`reply_to_users_goal.md` 仍写旧上传顺序。（A、B、E）
12. pinned 渲染 2 与渲染 5 字面冲突（8 帧取最差 vs p90 + 最少采样），代码按渲染 5 做，需用户确认。（C）

---

以下是五位审查员的逐项原文（每条：计划要求 / check 声称 / 核查证据 / 结论 / 差异）。


---

# 审查员 A 逐项

## 复核 A：第 1 节、3.8、3.9、R0、R1、R1b、landed-notes

复核对象：main `f69f229`。前提：`user_pinned_goal.md`（渲染 5：生成快照拆成样式内联 / 画布栅格化 / 序列化三个数，判重只看活渲耗时；渲染 10 等）。
计划 = `restructure_planning/render_pipeline_restructure.md`（下称「计划」），执行核对 = `restructure_planning/render_pipeline_restructure_check.md`（下称「check」）。
方法：只读代码、`git show` / `git log`、单独跑单测文件（`node --experimental-test-module-mocks --test <file>`，仓库的 `npm test` 就是这个 runner，不是 vitest）。没起服务、没跑探针、没跑全量测试和 tsc。

本次单独跑过、全部通过的单测文件：
`src/store/importGraph.test.mjs`（2/2）、`server/test/mcp-routes.test.mjs`（8/8）、`server/test/bakery-deps.test.mjs`（3/3）、`src/layering.test.mjs`（3/3）、`server/test/vision-modules.test.mjs`（3/3）、`server/test/card-snapshot-identity.test.mjs`（8/8）、`server/test/costs.test.mjs`（18/18）、`server/test/snapshot-style-props.test.mjs`（5/5）、`server/test/bake-protocol.test.mjs`（2/2）、`src/render/snapshotRename.test.mjs`（8/8）、`src/kernel/pixelMap.test.mjs`（11/11）、`src/mcp/tools/pixelMapTools.test.mjs`（1/1）、`src/kernel/filters.test.mjs`（13/13）、`src/editor/right/filterTools.test.mjs`（2/2）。

---

## 第 1 节 `result_decouple.md` 逐项查收

计划第 1 节的核对做在 `30917d2`，这里在 HEAD 上重核一遍。

### S1-1 store 解环
- 计划要求：`actions/*` 不 import `../project`；`project.ts` 只转出门面（计划:23）
- check 文档声称：全部核过（check:13）
- 核查证据：`grep "../project" src/store/actions` 零命中；`src/store/project.ts:6-7,21` 的 export 只有 `EditorState` / `getState` / `subscribe` / `useStore` / `planPlacement` / `actions`；`src/store/importGraph.test.mjs` 2/2 过
- 结论：已完成
- 差异或问题：无

### S1-2 MCP 路由表
- 计划要求：路由 103 条进 `src/mcp/routes.mjs`；`mcpExecutor.ts` 只剩 5 条特殊分支；`src/mcp/tools/` 四个模块与单测（计划:24）
- check 文档声称：属实
- 核查证据：`grep -c "method:" src/mcp/routes.mjs` = 103；`src/ai/mcpExecutor.ts` 里 `else if (tool ===` 共 5 条（:415-437）；`src/mcp/tools/` 有 autoWorkflow / pixelMapTools / toolEcho / trackTools 四个模块；`server/test/mcp-routes.test.mjs` 8/8 过
- 结论：已完成
- 差异或问题：无（`mcpExecutor.ts` 实际在 `src/ai/` 下，计划没写路径，不算错）

### S1-3 渲染引擎搬家
- 计划要求：`scripts/export-frames.mjs` 42 行；`server/bakery/` 19 个文件；`server/**`（测试除外）不 import `scripts/`（计划:25）
- check 文档声称：属实
- 核查证据：`wc -l scripts/export-frames.mjs` = 42；`ls server/bakery | wc -l` = 19；正则 `(from|import\()\s*['"](\.\./)+scripts/` 在 `server/`（排除测试）零命中；`server/test/bakery-deps.test.mjs` 3/3 过
- 结论：已完成
- 差异或问题：无

### S1-4 分层（9 个文件移动）
- 计划要求：9 个新路径在、6 个旧路径不在（计划:26）
- check 文档声称：属实
- 核查证据：`src/render/{Stage.tsx,PartTree.tsx,prerender.ts,dataMirror.ts,contentBox.ts}`、`src/kernel/{frameMode.mjs,partTypes.ts,partRegistry.ts,cardGpu.ts}` 都在；`src/kernel/Stage.tsx`、`src/kernel/PartTree.tsx`、`src/render/frameMode.mjs`、`src/editor/{prerender,dataMirror}.ts`、`src/editor/left/contentBox.ts`、`src/parts/{types,registry}.ts` 都不在；`src/layering.test.mjs` 3/3 过
- 结论：已完成
- 差异或问题：无

### S1-5 vision 拆分
- 计划要求：外壳 56 行 + `server/vision/` 九个模块，行数 56/387/118/82/142/153/618/163/369（计划:27）
- check 文档声称：属实
- 核查证据：`server/vite-plugin-vision.ts` 56 行；`server/vision/` 九个文件行数依次为 bake-cache 56、bake 387、ffmpeg-frames 118、http 82、render-queue 142、render 153、routes 618、ui-renderer 163、worker-pool 369，逐个对上；`server/test/vision-modules.test.mjs` 3/3 过
- 结论：已完成
- 差异或问题：无

### S1-6 #10 指纹清单
- 计划要求：`frame-code.mjs` 的 `CAPTURE_FILES` / `FREEZE_FILES` 指向 `server/bakery/*`（计划:28）
- check 文档声称：属实
- 核查证据：`server/frame-code.mjs:17-20`（`BAKERY_FILES` / `CAPTURE_FILES` 全是 `server/bakery/*`）；`FREEZE_FILES` 在 R1 里已按 3.8 改名为 `SNAPSHOT_FILES`（`:71-74`）
- 结论：已完成
- 差异或问题：无（R1 改名后计划:28 和 :201 里的 `FREEZE_FILES` 已过时，只是文字）

### S1-7 守门测试 5 个文件
- 计划要求：5 个新测试文件都在（计划:29）
- check 文档声称：5 个都在
- 核查证据：`result_decouple.md:126-130` 列的 5 个文件都在，本次逐个跑：共 19 条，19 过（和报告「+19 为新增守门测试」对得上）
- 结论：已完成
- 差异或问题：无

### S1-8 验证数字（tsc 零错误、`npm test` 1462 / 1461 / 0 / 1）
- 计划要求：主会话在 main 上重跑（计划:30）
- check 文档声称：完全一致
- 核查证据：这是 `30917d2` 时的数，现在 HEAD 的用例数已经是 1633；按任务约束我不跑全量测试，也回不到那个提交
- 结论：无法独立验证
- 差异或问题：无

### S1-9 别的会话的 worktree（6.5）
- 计划要求：`.claude/worktrees/agent-af0dae85c12674862` 有 18 个未提交改动，没动过（计划:31）
- check 文档声称：属实
- 核查证据：`git worktree list` 里它还在 `b5c65dc` 上，`git -C … status --short | wc -l` = 18
- 结论：已完成（说法属实）
- 差异或问题：R1 已经在 main 上重做并合并（`e67390e`），这个 worktree 以及另外 13 个 agent worktree（`git status` 里那个 `?? .claude/worktrees/`）都还没清理。按 memory「worktree junction 会清空 node_modules」，清理前要先拆 junction，不在本次范围

### S1-10 要记住的两件事（快照失效一次；`out/**` 已在忽略名单）
- 计划要求：`vite.config.ts:76-80` 已有 `**/out/**`，冷启动慢的原因交给 R0 去量（计划:35-38）
- check 文档声称：（交给 R0-3）
- 核查证据：`vite.config.ts:78-81` 的 `ignored` 里有 `"**/out/**"`（因为上面加了注释，行号往下挪了约 2 行）
- 结论：已完成（说法属实；后续量测见 R0-3）
- 差异或问题：无

---

## 3.8 生成快照：命名与指标拆开

### S38-1 `snapshotFreeze.ts` → `createSnapshot.ts`，里面五个函数按顺序调
- 计划要求：导出 `createSnapshot(root)`，依次调 `cloneScene` → `inlineDOMStyles` → `rasterizeCanvas` → `stripMedia` → `serializeScene`（计划:159）
- check 文档声称：R1 已实现（check:21、:38）
- 核查证据：`src/render/createSnapshot.ts:85`（cloneScene）、`:99`（stripMedia）、`:111`（serializeScene）、`:137-155` `createSnapshot` 按计划顺序调五个函数；`src/render/snapshotFreeze.ts` 已经不在（`e67390e` 里 -119 行）
- 结论：已完成
- 差异或问题：无

### S38-2 两个独立文件互不 import，差异内联逻辑放进 `inlineStyles.ts`
- 计划要求：`src/render/snapshot/inlineStyles.ts`、`src/render/snapshot/rasterizeCanvas.ts` 互不 import；`ensureBaselines` / `animatedProps` / `forcedProps` / `buildStyle` 放进 `inlineStyles.ts`（计划:159）
- check 文档声称：已实现
- 核查证据：`inlineStyles.ts:42` 只 import `./snapshotStyleProps.mjs`；`rasterizeCanvas.ts:19` 只 import `../solid`；四个函数分别在 `inlineStyles.ts:78 / :136 / :160 / :178`
- 结论：已完成
- 差异或问题：`rasterizeCanvas.ts` 靠 `solid.ts` 的 `canvasPaintedBox` 写 `data-pc-painted-box`，而 `solid.ts` 不在 `SNAPSHOT_FILES`（`frame-code.mjs:71-74`），check:42 说这是有意的（「solid.ts 照旧不进」）。风险：以后改 `solid.ts` 的实体框算法会改变快照内容，但共享键不变，旧的共享快照会被继续复用

### S38-3 页面协议 `window.__bfFreeze` → `window.__pcCreateSnapshot`
- 计划要求：`StageView.tsx`、`ExportView.tsx`、`kernel/clock.ts` 类型、`bake.mjs` 两处 `page.evaluate`、`docs/bake-page-protocol.md`、`scripts/verify-bake-protocol.mjs` 及其测试都要改（计划:160）
- check 文档声称：已实现
- 核查证据：`src/StageView.tsx:1668`、`src/ExportView.tsx:150`、`src/kernel/clock.ts:84`、`server/bakery/bake.mjs:136`、`:290`、`docs/bake-page-protocol.md:11,38`、`scripts/verify-bake-protocol.mjs:97`、`server/test/bake-protocol.test.mjs:19`（2/2 过）；代码里 `__bfFreeze` 零命中（只剩在 md 里）
- 结论：已完成
- 差异或问题：无

### S38-4 `freezeCode` → `snapshotCode`，清单同步，共享键字段改名
- 计划要求：`frame-code.mjs`、`card-identity.mjs`、`card-cache.mjs`、`card-snapshot-identity.test.mjs` 都改；清单加入新文件；共享键里的字段名一起换（计划:160）
- check 文档声称：已实现，`SNAPSHOT_FILES` 随三个新模块一起加（check:42）
- 核查证据：`server/frame-code.mjs:75`、`server/card-identity.mjs:103,119`（键里的字段已是 `snapshotCode`）、`server/card-cache.mjs:5,91`；`SNAPSHOT_FILES` 含 `createSnapshot.ts` / `inlineStyles.ts` / `rasterizeCanvas.ts` / `snapshotStyleProps.mjs` / `snapshotRename.ts`；`card-snapshot-identity.test.mjs` 8/8 过；代码里 `freezeCode` / `FREEZE_FILES` 零命中
- 结论：已完成
- 差异或问题：见 S38-2 关于 `solid.ts` 的风险

### S38-5 类型 `FrozenScene` / `FrozenControl` → `SceneSnapshot` / `ControlSnapshot`
- 计划要求：同上（计划:160）
- check 文档声称：已实现
- 核查证据：`createSnapshot.ts:55`、`:74`；代码里旧名零命中
- 结论：已完成
- 差异或问题：无

### S38-6 四个探针脚本跟着改名
- 计划要求：四个探针脚本改用新名字（计划:160）
- check 文档声称：已实现
- 核查证据：`snapshot-size-probe.mjs:206`、`stage-rpc-probe.mjs:244`、`svg-url-serialize-probe.mjs`、`probe-card-costs.mjs` 都已改。**但** R1 新增的 `scripts/probes/inherited-props-probe.mjs:27` 是 `import … from '../../src/render/freezeStyleProps.mjs'`，这个文件从来没进过仓库（R1 的 `4692f00` 直接建的是 `src/render/snapshot/snapshotStyleProps.mjs`），`ls` 确认不存在
- 结论：部分完成
- 差异或问题：`inherited-props-probe.mjs` 一加载就会因 import 失败而退出，是一个坏掉的探针（`4692f00` 加进来时就这样）

### S38-7 成本记录拆成四个数，`frameMs` 删掉不留兼容
- 计划要求：`stepMs`（唯一进判重的数）/ `inlineMs` / `rasterMs` / `serializeMs`；`frameMs` 删掉；舞台的 `probe` 事件、`CardCostRecord`、`docs/snapshot-size-audit.md` 一起拆（计划:161）
- check 文档声称：已实现（check:41-42）
- 核查证据：`src/render/cardCostKey.d.mts` 的 `CardCostRecord` 有 `stepMs` / `inlineMs` / `rasterMs` / `serializeMs` / `mode` / `demoted`，没有 `frameMs`；`src/render/stageRpc.ts:254` 的 probe 事件有四个数；`src/editor/probeRunner.ts:400` `capped = stepMs × COST_SCALE > B`；`docs/snapshot-size-audit.md` 已按 DOM / canvas 分开列，也写明「不进判重」。仓库里剩下的 `frameMs` 都在 `server/frame-playback.mjs`（播放批次调度的另一个概念）和 `stream-cadence.mjs`，跟成本记录无关；`costs.test.mjs` 18/18 过
- 结论：已完成
- 差异或问题：计划:161 写的三个快照数是「单帧最差」，实现里取的是稳健值（第 p 百分位）：`probe-card-costs.mjs:54-56`、`probeRunner.ts:399` `summarizeProbe`。可 `cardCostKey.d.mts` 的注释还写着 "Worst single frame"，注释和实现对不上。只影响产能估算，不影响判重

### S38-8 rAF 等待不计入任何一个数
- 计划要求：带 `probe: true` 的 `setTime` 不能把那次真实 rAF 算进去（计划:162）
- check 文档声称：direct 卡的 `stepMs` 在等 rAF 之前取（check:42）
- 核查证据：`src/StageView.tsx:1260-1271` 先取 `stepMs = realNow() - started`，再 `await realRaf()`，三个快照数由 `createSnapshot` 自己计时
- 结论：已完成
- 差异或问题：回包里的 `elapsedMs` 仍然包含 rAF，但它不进记录，没问题

### S38-9 画布位图换 webp 先放着
- 计划要求：用户定了继续用 PNG，没有新指示不做（计划:163）
- check 文档声称：—
- 核查证据：`rasterizeCanvas.ts:45` 用的是 `toDataURL("image/png")`，没有 `convertToBlob`
- 结论：按决定不做
- 差异或问题：`docs/snapshot-size-audit.md` 第 1 节表里的上限口径还写着 `toDataURL('image/webp', 0.9)`，同一文档第 7 节注明了现在是 PNG，不算矛盾

### S38-10 用这三个数排产能（「整段推完要多久」超过遮罩能接受的时长就只测不存）
- 计划要求：探针阶段按 `stepMs + inlineMs + rasterMs + serializeMs` 估，超了就只测不存（计划:164）
- check 文档声称：没提
- 核查证据：`inlineMs` 等在 `src/editor` / `server` 里只被记录、汇总（`probeRunner.ts:357,384,412`），找不到任何按四个数之和决定「只测不存」的代码
- 结论：未完成
- 差异或问题：计划这一条写的是「怎么用」的指引，没有列成 R1 的验收项；check 也没把它标成「没做」。三个数现在只落了盘，没人读

### S38-11 文档里不再用「冻结」
- 计划要求：文档改叫「生成快照」（计划:157）
- check 文档声称：—
- 核查证据：现行文档里还有：`docs/bake-page-protocol.md:77`、`docs/compare-pitfalls.md:108,112,125`、`server/bakery/bake.mjs:232-262`、`server/frame-pipeline.mjs:49,1113,1206,1246`（注释和一条报错文案），另外 `docs/*-plan.md` 这类历史文档里也有
- 结论：部分完成
- 差异或问题：程度很轻。和「烘焙」那条不同，用户没有下明令，只是计划自己的约定

---

## 3.9 像素映射：工具主动分流

### S39-1 滤镜的两种新 op（`curves` / `matrix`）
- 计划要求：`filters.mjs` 加这两种；预览走 SVG、导出走 `lutrgb` / `colorchannelmixer`；最多 4 步 curves；滤镜图超过 12000 字符改用 `-/filter_complex`（计划:176）
- check 文档声称：`7f10ebe` 已落地
- 核查证据：`src/kernel/filters.mjs:63-64`（`MAX_CURVES_OPS = 4`）、`:420`；`server/export-compose.mjs:435-440`（`LONG_GRAPH = 12000`，`-/filter_complex`）；`filters.test.mjs` 13/13、`filterTools.test.mjs` 2/2 过
- 结论：已完成
- 差异或问题：「预览和导出最大差 1～5 级」是实测数据，我没法复现

### S39-2 `classifyPixelMap(def)` 分三类，放在 `src/kernel/pixelMap.mjs`
- 计划要求：纯函数，浏览器和 Node 共用，可以单测（计划:168-174）
- check 文档声称：已实现；另有 ①～④ 四条更正（check:51）
- 核查证据：`src/kernel/pixelMap.mjs:342`；A 类要在 0～255 全值域上逐值核对，差超过 1 级就退回 B（`pixelMapOpsDiff :283`，测试「差 ≤ 1 级」）；C 类 = 负底数配非整数常量的指数（测试 `pixelMap.test.mjs:100`）；`colorSequence` 一律判 B（`:154` 的测试）
- 结论：已完成（按 check 的更正）
- 差异或问题：更正 ①（`colorSequence` 一律判 B）改了计划表里 A 类的一条判据，check 记下了，计划正文 3.9 的表没改

### S39-3 A 类当场拒绝，回一份等价的 `ops`
- 计划要求：`create_pixel_map` / `update_pixel_map` 对 A 类抛错，错误里带一份能直接给 `create_filter` 用的 `ops`（计划:172）
- check 文档声称：已实现
- 核查证据：`src/mcp/tools/pixelMapTools.ts:61-77`（`gate`），create 在 `:88`、update 在 `:98`；`pixelMap.test.mjs:32`「等价 ops 能过 normalizeFilterDef」；`pixelMapTools.test.mjs` 1/1 过（这一条用例同时覆盖 A / B / C 三类）
- 结论：已完成
- 差异或问题：无

### S39-4 B 类走 WebGL：`compilePixelMapGlsl` + `src/render/pixelMapGl.ts`
- 计划要求：每个文档一个 WebGL2 上下文，program 按哈希缓存，第二张纹理放目标素材，预览 / 导出 / see_frames 共用一份（计划:177）
- check 文档声称：已实现；另有 ⑤ 用 `transferToImageBitmap` + `bitmaprenderer`、⑥ x / y 从 `gl_FragCoord` 算
- 核查证据：`pixelMap.mjs:500`（`compilePixelMapGlsl`）、`:536-537`（`gl_FragCoord`）；`pixelMapGl.ts:49-53`（模块级单例上下文、`programs` Map）、`:197-199`（`bitmaprenderer` + `transferFromImageBitmap`）；`FrameScene.tsx:9,22,256,267` 调 `drawPixelMap`；B 类回包 `backend: 'webgl'`（`pixelMapTools.ts` create / update）；GLSL 的 `mod` 与解析器的 floor-mod 语义一致（`filters.mjs:162`）
- 结论：已完成
- 差异或问题：无

### S39-5 删掉 CPU 逐像素循环，不留退路；`mapRgba` 只留作参考实现
- 计划要求：同上（计划:177）
- check 文档声称：已删
- 核查证据：`src/` 和 `server/` 里（排除测试）只有 `kernel/pixelMap.mjs` 自己引用 `mapRgba`；`FrameScene.tsx:19` 注释写明已删；渲染路径上没有针对像素映射的 `getImageData` / `putImageData`（剩下的命中是 contentBox、alphaBox、magicui 这类无关代码）
- 结论：已完成
- 差异或问题：无

### S39-6 验收：GPU 和 CPU 逐像素差 ≤ 2 级；1080p 播放 0 长任务
- 计划要求：计划:177、:228
- check 文档声称：主会话自己跑过 `pixelmap-gl-probe`，8 个用例里 7 个差 ≤ 1 级，1080p 单帧主线程 p50 0.2 ms；一条已知超标（continuous 颜色序列 13 / 207 万像素差 255 级）；「0 长任务」改成「单帧主线程 < 1 ms」（check:48-51）
- 核查证据：探针 `scripts/probes/pixelmap-gl-probe.mjs` 在（要真 GPU + 起 vite，本次禁止跑）
- 结论：无法独立验证
- 差异或问题：按 check 自己的说法，有一个用例不满足计划的「≤ 2 级」（13 个像素差 255 级），决定是不改；「0 长任务」这条验收被换成了另一种判据。A 类「调色定义被拒、`ops` 画面逐像素差 ≤ 2」只在数值值域上用参考实现核过（`pixelMapOpsDiff`），没有把 SVG / ffmpeg 真画出来比

### S39-7 C 类拒绝并说明哪一处翻译不了
- 计划要求：计划:174
- check 文档声称：已实现（更正 ④）
- 核查证据：`pixelMapTools.ts:75`；`pixelMap.test.mjs:100`
- 结论：已完成
- 差异或问题：无

### S39-8 工具描述同步
- 计划要求：`create_pixel_map` 描述开头写明「整帧调色请用 create_filter 的 curves / matrix」（计划:179）
- check 文档声称：已实现
- 核查证据：`server/tools/effects.mjs:107` 开头就是这句；`update_pixel_map`（`:126`）和 `create_filter`（`:10`）也同步了
- 结论：已完成
- 差异或问题：`effects.mjs:107` 的描述和 `pixelMapTools.ts:73` 的错误正文里还写着「像素映射要逐像素算，1080p 每帧 400 毫秒以上」。这是 CPU 时代的数，GPU 后端现在单帧约 0.2 ms（check:48），这句话已经不对了，会误导 Agent

### S39-9 R1b 在 R3 之前完成
- 计划要求：计划:178
- check 文档声称：前置先做（check:117）
- 核查证据：`dd58cb5`（R1b 合并，04:06）早于 `2986755`（合并 R3）
- 结论：已完成
- 差异或问题：无

---

## R0 清账

### R0-1 提交探针改动和 `g0-a-webview2-probe.md`
- 计划要求：计划:212
- check 文档声称：已做（`5157f91`）
- 核查证据：`git show --stat 5157f91`：`docs/g0-a-webview2-probe.md`（后来挪到了 `restructure_planning/`）、`backdrop-probe.mjs`、`oac-probe.mjs`、`probe-connect.mjs`、`videodecoder-probe.mjs`，共 5 个文件
- 结论：已完成
- 差异或问题：无

### R0-2 `verify-unified-frames.mjs` 整条通过
- 计划要求：先改两处过期写法；还不一致就查根因，一直修到「整帧导出」和「HTML 快照重放」逐字节相同（计划:213）
- check 文档声称：做了一半。两处写法已改（`eec7a08`），根因一已修（`bake.mjs` +22），根因二没修，最后一条断言仍然红（check:34）
- 核查证据：`eec7a08` 的提交信息写明最后一条断言仍然不过；`7d623f4` 的 diff 是 `bake.mjs` 加了 `flushFrameLoop`（带截图的 `beginFrame`），调用点在 `:137` 和 `:289`，只在生成快照那一侧；根因二（`getComputedStyle().width` 只给三位小数）没有改动代码的提交
- 结论：部分完成
- 差异或问题：① check 在 R7 那一节（check:104）又说这个脚本现在「挂在导出页 60 秒没就绪」，连最后一条断言都跑不到。R0 那一行还写着「最后一条断言仍以红为已知状态」，两处对不上，R0 行已经过时。② 根因二的排查报告 `replay-mismatch-report.md` 只存在某次会话的 scratchpad 里，没进仓库，三个修法和代价有丢失的风险。③ 「导出 60 / 60 帧逐字节不变」「65607 → 27080 个通道」是 Agent 自报，我没法复现

### R0-3 仓库根 dev server 冷启动量测
- 计划要求：先量再改，兜底办法是给 frame-library 加 GC（计划:214）
- check 文档声称：没做
- 核查证据：找不到量测记录，也找不到 frame-library 的 GC 代码
- 结论：未完成
- 差异或问题：无（check 如实报了）

### R0-4 旧任务书文首加一句说明
- 计划要求：计划:215
- check 文档声称：已做，随后旧任务书整体删除
- 核查证据：`.gitignore:6` 忽略了 `AGY-TASK-*.md`，这个文件从来没进过 git（`git log --all` 查不到），现在工作区里也没有了
- 结论：无法独立验证（而且已经没有意义：旧任务书按用户的决定整体舍弃了）
- 差异或问题：无

---

## R1 差异样式内联收尾

### R1-1 把 worktree 里的改动搬到 main 上重做
- 计划要求：计划:218
- check 文档声称：已合并（`e67390e`）
- 核查证据：`e67390e`（合并 `4692f00` / `4108b55` / `778ed62` / `688ead5`），38 个文件，+1495 / -398
- 结论：已完成
- 差异或问题：原来的 worktree `agent-af0dae85…` 没清理（见 S1-9）；原计划说 `freezeStyleProps.mjs` 可以原样拿过来，实际改名成了 `snapshot/snapshotStyleProps.mjs`，结果 `inherited-props-probe.mjs` 引用的还是旧路径，见 S38-6

### R1-2 先按 3.8 改名、拆文件
- 计划要求：计划:219
- check 文档声称：已实现
- 核查证据：见 S38-1 到 S38-5
- 结论：已完成
- 差异或问题：见 S38-6

### R1-3 探针和成本记录拆成四个数，判重只看 `stepMs`
- 计划要求：计划:220
- check 文档声称：已实现
- 核查证据：见 S38-7；`probe-card-costs.mjs:510-526`
- 结论：已完成
- 差异或问题：三个快照数取的是稳健值而不是计划写的「最差」，注释和实现对不上（见 S38-7）

### R1-4 比对口径（A2(8)）
- 计划要求：继承属性和父元素的计算值比；布局解析值属性一律内联；其余属性和同标签基线比；基线按 `namespaceURI + tagName + themeId` 缓存；SVG 用 `createElementNS` 造；canvas 换成的 `<img>` 按 IMG 的基线另算（计划:221）
- check 文档声称：已实现
- 核查证据：`inlineStyles.ts:199-209`（①继承属性比父元素 / ②`LAYOUT_USED_VALUE_PROPS` 全内联 / ③其余比基线）；`:78-128` `ensureBaselines` 按 (ns, tag) 取基线，SVG 用 `createElementNS` 并塞进一个真 `<svg>`；`createSnapshot.ts:143,147` 预热 IMG 基线，再用 `styleAs(el,"IMG")` 算；`snapshot-style-props.test.mjs` 5/5 过
- 结论：已完成
- 差异或问题：基线缓存的主题维度不是 `themeId`，而是「场景根元素的 `style` 属性串」（`inlineStyles.ts:79-83`，缓存键是场景根元素的 WeakMap）。主题如果不是通过场景根的 inline style 生效，缓存不会失效。这是和计划的一处偏差，是否真有问题没法独立验证

### R1-5 成本记录：`mode` 拼进 `device`；探针显式写 `demoted: false`；类型补 `mode`
- 计划要求：计划:222
- check 文档声称：已实现
- 核查证据：`src/render/costDevice.mjs:68`（`mode=dev|build`）；`scripts/probe-card-costs.mjs:526`、`src/editor/probeRunner.ts:29`（`demoted: false`）；`cardCostKey.d.mts` 里有 `mode?` 和 `demoted: boolean`；`costs.test.mjs` 18/18 过
- 结论：已完成
- 差异或问题：无

### R1-6 验收
- 计划要求：`verify-unified-frames.mjs` 通过；四张卡（lottie-bodymovin / growth-curve / odometer / scene-3d）内联前后逐像素比对；导出逐字节基线不变；DOM 卡 p90 ≤ 300 KB、canvas 位图 ≤ 1 MB；`npm test`、`tsc`（计划:223）
- check 文档声称：R1「已完成」；8 / 8 相同、240 / 240 逐字节相同、DOM p90 185.8 KB、canvas max 628 KB（check:38-41）
- 核查证据：`scripts/probes/snapshot-diff-compare.mjs:45` 默认就是这四张卡；`docs/snapshot-size-audit.md` 第 2、3 节的数（max 915.3 KB，超 300 KB 的 DOM 卡 2 张，DOM p90 185.8，canvas 超 1 MB 的 0 张）和 check 一致；**`verify-unified-frames.mjs` 没通过**（见 R0-2）
- 结论：部分完成
- 差异或问题：计划列的第一条验收（`verify-unified-frames.mjs` 通过）没达成，check 的标题却写「R1 差异样式内联收尾——已完成」，没在 R1 节里交代这一条欠着（只在 R0-2 里有）。逐像素 8 / 8、导出 240 / 240 是 Agent 自报，我没法复现

### R1-7 两张超 300 KB 的 `lottie-*`
- 计划要求：不做专门处理（计划:224、:277）
- check 文档声称：不处理
- 核查证据：审计文档里 lottie-bodymovin 915 KB、lottie-navidad 855 KB；A3c 兜底属于 R6 的范围
- 结论：按决定不做
- 差异或问题：无

### R1-8 `configurePreviewServer`
- 计划要求：降级，不再是后续步骤的前提（计划:225）
- check 文档声称：没做（check:43）
- 核查证据：`server/` 和 `vite.config.ts` 里查不到 `configurePreviewServer`
- 结论：按决定不做
- 差异或问题：无

---

## R1b 像素映射分流与 GPU 后端

### R1b-1 两种新 op 和 SVG 注入
- 计划要求：计划:228
- check 文档声称：`7f10ebe`
- 核查证据：见 S39-1
- 结论：已完成
- 差异或问题：无

### R1b-2 `classifyPixelMap`，以及 create / update 对 A 类的拒绝和等价 `ops` 回包
- 计划要求：计划:228
- check 文档声称：已完成（`dd58cb5`）
- 核查证据：见 S39-2、S39-3；提交 `c35da6e`、`5e3cca6`
- 结论：已完成
- 差异或问题：无

### R1b-3 `compilePixelMapGlsl` + `src/render/pixelMapGl.ts`
- 计划要求：计划:228
- check 文档声称：已完成
- 核查证据：见 S39-4；提交 `1886247`
- 结论：已完成
- 差异或问题：无

### R1b-4 删掉 CPU 逐像素循环
- 计划要求：计划:228
- check 文档声称：已完成
- 核查证据：见 S39-5
- 结论：已完成
- 差异或问题：无

### R1b-5 工具描述
- 计划要求：计划:228
- check 文档声称：已完成
- 核查证据：见 S39-8
- 结论：已完成
- 差异或问题：「1080p 每帧 400 毫秒以上」已经过时（见 S39-8）

### R1b-6 验收（`ops` 差 ≤ 2 / 255；1080p 播放 0 长任务；抠色按 3.9 处理）
- 计划要求：计划:228
- check 文档声称：见 S39-6
- 核查证据：单测层面：A 类在数值值域上差 ≤ 1 级（`pixelMap.test.mjs:52`）；B 类的 GLSL 翻译口径有 4 条单测；探针没跑
- 结论：无法独立验证（真 GPU 和长任务那两条），单测部分通过
- 差异或问题：有一个已知超标用例（13 个像素差 255 级），「0 长任务」被换成了别的判据（见 S39-6）；check 记下的遗留：`normalizePixelMapDef` 不理 `colorSequence.mode`，已确认（`pixelMap.mjs:91,104` 只用顶层 `mode`，再写回 `colorSequence.mode`）

---

## landed-notes.md 的验收口径和「不做」条目，在 HEAD 上还守着吗

### LN-1 C1：`CARD_MOUNT_LEAD` 只在 `frameWindow.mjs` / `.d.mts` 里；`frameWindow.d.mts` 有 `mountFrameOf` 声明；`onFrameGrid` 不存在
- 计划要求：`landed-notes.md` C1
- check 文档声称：—
- 核查证据：非测试代码里只在 `src/render/frameWindow.mjs:5-13` 和 `frameWindow.d.mts:1`；`d.mts:3` 声明了 `mountFrameOf`；`onFrameGrid` 零命中
- 结论：已完成（仍然守着）
- 差异或问题：无

### LN-2 第 3 步的几条 grep 类口径
- 计划要求：`__pcPreviewStage` 在 `src` 里零命中；`StageView.tsx` / `solid.ts` 里除了那条注释，没有 `pc-stage` 或 `document.querySelector`；只有 `get_layout` await、四个写工具同步；`window.__pcSolid` 可调；`checkCardSource` 三处调用都显式传 `mode`
- 核查证据：`__pcPreviewStage` 零命中；`querySelector` 只命中 `StageView.tsx:1667` 那条注释（从 568 挪了行号，内容就是那条解释性注释）；`routes.mjs:35` `set_position` 是 `awaited:false`，`:39` `get_layout` 是 `awaited:true`（另外还有一批非布局工具也是 awaited，那不属于这条口径）；`ExportView.tsx:152` 挂了 `__pcSolid`；`vite-plugin-cards.ts:897,1192,1456` 三处都传了 `mode`
- 结论：已完成（仍然守着）
- 差异或问题：无

### LN-3 A2(7)：`renameSnapshotIds(html, clipId)`；control 快照的 `html` 不含 `data-pc-clip`、`[data-pc-proxy-plane]` 和素材层
- 核查证据：`snapshotRename.test.mjs` 8/8 过；`createSnapshot.ts:127-134` 取包裹层的 `innerHTML` 并删掉 proxy-plane，`:127` 的选择器排除了 `[data-pc-media]`
- 结论：已完成（仍然守着）
- 差异或问题：无

### LN-4 A3：共享键对哪些东西敏感、对哪些不敏感
- 核查证据：`card-snapshot-identity.test.mjs` 8/8 过（包含对 clipId 不敏感、对 `snapshotCode` 敏感）
- 结论：已完成（单测层面）；「B 机首次打开」那一条要在真环境里才能验，无法独立验证
- 差异或问题：S38-2 说的 `solid.ts` 不进 `snapshotCode` 的风险落在这一条上

### LN-5 A0、A7、第 3 步里的性能 / 端到端数字（`unknown` 为 0、≤ 8 KB、≤ 2 ms、≤ 150 ms 等）
- 结论：无法独立验证（要跑探针或起服务）
- 差异或问题：无

### LN-6 「不做」条目
- 核查证据：
  - Python 卡运行时：`promptcut_cards` / `/api/card-runtime` / `PythonCard` / `LPAC` 在 `src` 和 `server` 里零命中；`python/` 下只有 collect / shots / stt / subject / track 这些非卡片的包；`src/audio/cardAudio.ts` 里没有 `fetch(`。守着。
  - 画布位图 webp、像素缓存上云、毛玻璃卡进流、场景流：R8、R9 和云端都还没动，`rasterizeCanvas` 仍是 PNG。守着。
  - 粒子卡不迁（计划:278）：R9 没开始。守着。
  - 其余「不做」（图卡输入接 DOM 卡、`playbackRate ≠ 1`、同一片段挂两种图卡等）这次没有涉及的代码改动，没逐条跑用例
- 结论：按决定不做（在我查过的范围内仍然守着）
- 差异或问题：无

---

## 发现的问题汇总

1. **check 把 R1 标成「已完成」，但计划 R1 的第一条验收没达成**：`verify-unified-frames.mjs` 通过（计划:223）。R1 节里没交代这一条，只在 R0-2 里有。
2. **check 里自相矛盾**：R0-2 说 `verify-unified-frames` 「最后一条断言仍以红为已知状态」；R7 节（check:104）又说它现在挂在「导出页 60 秒没就绪」，根本跑不到最后一条断言。R0 行已经过时，这个脚本目前的真实状态不清楚。
3. **一个坏掉的探针**：`scripts/probes/inherited-props-probe.mjs:27` import 的 `src/render/freezeStyleProps.mjs` 不存在（真实路径是 `src/render/snapshot/snapshotStyleProps.mjs`），`4692f00` 加进来时就是坏的。
4. **工具文案过时**：`server/tools/effects.mjs:107`（`create_pixel_map` 描述）和 `src/mcp/tools/pixelMapTools.ts:73`（A 类拒绝的错误正文）还写着「像素映射要逐像素算，1080p 每帧 400 毫秒以上」，R1b 之后单帧约 0.2 ms，会误导 Agent。
5. **共享键可能漏失效（回归风险）**：`rasterizeCanvas.ts` 靠 `solid.ts` 的 `canvasPaintedBox` 写 `data-pc-painted-box`，而 `solid.ts` 不在 `SNAPSHOT_FILES`，改它不会作废旧的共享快照。
6. **三个快照数的口径和计划不同**：计划:161 写「单帧最差」，实现取稳健百分位；`cardCostKey.d.mts` 的注释还写着 "Worst single frame"，注释和实现对不上。
7. **3.8 最后一条「用三个数排产能 / 只测不存」没实现**：三个数只落盘没人读。check 没把它列进「没做」。
8. **基线缓存的主题维度和计划不同**：用的是场景根的 `style` 串，不是 `themeId`（`inlineStyles.ts:79`）。
9. **R1b 的验收打了折扣**：有一个用例 13 个像素差 255 级（决定不改）；「0 长任务」换成了「单帧主线程 < 1 ms」；A 类 `ops` 的「画面逐像素对比」只在数值值域上核过。check 如实写了，但计划正文 3.9 / R1b 没同步。
10. **排查材料不在仓库里**：R0-2 根因二的排查报告 `replay-mismatch-report.md` 只存在某次会话的 scratchpad 里。
11. **worktree 残留**：`agent-af0dae85…`（`b5c65dc`，18 个未提交改动）等 14 个 agent worktree 都没清理。清理时要注意 node_modules junction 的坑。
12. **「冻结」一词还有残留**：`docs/bake-page-protocol.md:77`、`docs/compare-pitfalls.md`、`server/bakery/bake.mjs:232-262`、`server/frame-pipeline.mjs:1246`（报错文案）。程度很轻。
13. **R0-4 已无从核对**：旧任务书被 gitignore，从来没进过 git，现在已删除。

---

# 审查员 B 逐项

## 复核 B：R2 双舞台与协议补齐、R3 舞台内容

审查员：独立子 Agent（只读）。基线 main `f69f229`。
前提：已读 `user_pinned_goal.md`、`restructure_planning/README.md`、`render_pipeline_restructure.md`（3.2、第 5 节 R2 / R3）、`render_pipeline_restructure_check.md`、`r2-r7-task.md`（读法、实现后的更正、六步表、E0 / E1 / E2～E7 / J4 / D4 单飞段 / D3 第 4 步 / A4 / A3c 投递段）。
相关提交：R2 = `74f3539`（RPC 协议）、`58f0a8f`（stageBridge / stageJobs）、`2d73576`（端口与第二个 iframe）、`bde8439`（隔离探针），合并 `52eab98`；R3 = `586fd02`（素材层搬家）、`7194834`（pinAnimations + 定时器虚拟化）、`7bda056`（Stage 六个 prop / FrameScene live）、`52952da`（E4b 探针卡 + stage-content-probe）、`8c2778a`（分隔符，`-w` 下只改 4 行），合并 `2986755`。R1b（`dd58cb5`）确认是 R3 第一个提交的祖先（R1b → R3 的先后要求满足）。

单测（我跑的，`node --experimental-test-module-mocks --test`；仓库是 node:test 而非 vitest）：`src/render/stageRpc.test.mjs`、`src/editor/stageBridge.test.mjs`、`src/editor/stageJobs.test.mjs`、`src/render/mediaSync.test.mjs`、`src/render/virtualTimers.test.mjs`、`src/render/pinAnimations.test.mjs` 共 68 条，68 过 / 0 失败。

---

## R2 双舞台与协议补齐

### R2-1 第二个舞台 iframe
- 计划要求：主文档挂两个舞台 iframe，后台那个用 `opacity:0; pointer-events:none` 藏，不用 display / visibility（r2-r7-task.md:48 六步表；E1 在 sections「E1」条）。
- check 文档声称：已完成（check.md:54-60）。
- 核查证据：`src/editor/Preview.tsx:954-1011` 两个 `<iframe>`（`stageSrc("A")` / `stageSrc("B")`），不是 front 的那一个是 `opacity: 0` + `pointerEvents: "none"`；`src/editor/Preview.tsx:406` 注释说明为什么不用 display / visibility。
- 结论：已完成
- 差异或问题：无

### R2-2 两个舞台端口（编辑器端口 +1 / +2 的反向代理）与 `STAGE_PORTS` 常量
- 计划要求：编辑器进程起两个反向代理端口（+1、+2）转发到 vite；端口数取自常量 `STAGE_PORTS = 2`，代理、`PROMPTCUT_CORS_ORIGINS`、port.json 三处共用（E1、J4）。
- check 文档声称：舞台端口 = 编辑器端口 +1 / +2；端口被占就不起那个代理、页面退回同源单舞台（check.md:59；r2-r7-task.md:20）。
- 核查证据：`server/stage-ports.mjs:15`（`STAGE_PORTS = 2`）、`:18-20`（`stagePortsOf`）、`:27-29`（`stageOriginsOf`）；`server/vite-plugin-stage-ports.ts:51-90`（代理）、`:106-118`（按 vite 实际端口起代理，起不来就跳过并打警告）、`:131-138`（把真起来的端口表注入 `window.__PC_STAGE_PORTS__`）；`vite.config.ts:27,55` 注册插件；`src/editor/previewMode.ts:55-69`（两个端口都在才开双舞台）。
- 结论：已完成
- 差异或问题：代理只监听 vite 自己的监听地址（`::` / `0.0.0.0` 时换成 `127.0.0.1`，`vite-plugin-stage-ports.ts:109`），而 iframe 地址按 `location.hostname` 拼（`previewMode.ts:59`）。用户用 `localhost` 打开、而 localhost 优先解析成 `::1` 时，靠浏览器退回 IPv4 才能连上。属于小风险，没实测。

### R2-3 `Origin-Agent-Cluster: ?1` 头（第一次加载就要带）、Range / 206、HMR upgrade
- 计划要求：对舞台文档加这个头，而且第一次加载就要带；透传 Range / 206；转发 `upgrade`（E1；3.2 第 3 条）。
- check 文档声称：已完成。
- 核查证据：`server/vite-plugin-stage-ports.ts:62`，每个响应都加 `origin-agent-cluster: ?1`（不挑文档，所以第一次加载必然带上）；状态码和响应头原样抄回，Range / 206 因此透传；`:70-87` 转发 upgrade。
- 结论：已完成
- 差异或问题：无

### R2-4 `PROMPTCUT_CORS_ORIGINS` 加两个舞台源；port.json 写舞台端口
- 计划要求：`PROMPTCUT_CORS_ORIGINS` 加上这两个源；桌面版写进 port.json（E1、J4）。
- check 文档声称：`desktop/` 下没有写 port.json 的代码，`stagePorts` 写在 `server/vite-plugin-ai.ts`（check.md:58；r2-r7-task.md:22）。
- 核查证据：`server/vite-plugin-prerender.ts:49`（`...stageOriginsOf(port)`）和 `:110`；`server/vite-plugin-ai.ts:163-175`（`stagePorts: stagePortsOf(port)` 写进 `%TEMP%/promptcut/port.json`）。在 `desktop/src-tauri/src/*.rs` 里 grep port.json 零命中（只在 runtime 副本的脚本里有），桌面壳的端口预检在 `desktop/src-tauri/src/lib.rs:212`（`occupied_stage_ports`，R7 加的）。
- 结论：已完成
- 差异或问题：无（和任务书的偏差已折进「实现后的更正」）

### R2-5 `stageId` A / B，与角色脱钩
- 计划要求：两个 iframe 地址分别是 `?stage=1&id=A` / `id=B`；stageId 只是实例名，角色只经 `setRole` 定（原来传的 `id=front` 要改）（E1；3.2 第 2 条）。
- check 文档声称：已完成。
- 核查证据：`src/editor/previewMode.ts:20-25`（`StageId = "A" | "B"`，`INITIAL_ROLE_OF`）、`:78-82`（`stageSrc`）；`src/render/stageRpc.ts:437-439`（缺省 `"A"`，不再是 `front`）；`src/editor/Preview.tsx:312-323`，握手后角色按 `frontIdRef` 判（互换之后不按初始表走），立即发 `setRole`。
- 结论：已完成
- 差异或问题：无

### R2-6 角色闸门（`render`、`setTime({ probe })`）
- 计划要求：两者在舞台侧查角色，不是 `back` 就回 `{ aborted: true, reason: 'role' }`（E1；3.2 第 1 条）。
- check 文档声称：已完成；`stage-rpc-probe` 验了。
- 核查证据：`src/StageView.tsx:1220`（`setTime` 只挡 probe）、`:1296`（`render`）；`src/render/stageRpc.ts:174-178`（`SetTimeAborted`）；`scripts/probes/stage-rpc-probe.mjs:131-143` 有对应断言。另外 `play` 也有闸门（`StageView.tsx:1528`，只有 front 能跑）。
- 结论：已完成（代码）；探针全过是 Agent 自报，无法独立验证
- 差异或问题：无

### R2-7 `RenderAborted` 补 `'role'`；`detached` 由客户端自己造
- 计划要求：reason 全集为 `superseded | project | timeout | role | detached`（3.2 第 1 条；E0）。
- check 文档声称：已完成。
- 核查证据：`src/render/stageRpc.ts:131-142`；`:335`、`:362`（dispose 时 render 回 `detached`，其余方法 reject）。
- 结论：已完成
- 差异或问题：无

### R2-8 `stageBridge` 的 `whenStageReady(role)` / `pushProject(role, project, { reset })`
- 计划要求：`whenStageReady` 在 `setStageClient` 时 resolve，客户端换了就换一个新的 Promise；探针、整场景补跑、页面侧测量对后台舞台换项目一律走 `pushProject`，并同步更新基线（3.2 第 4 条；E0；E1）。
- check 文档声称：已完成。
- 核查证据：`src/editor/stageBridge.ts:61-90`（换客户端时换一个新的 ready Promise）、`:130-132`、`:147-182`（`send` 串行化，并维护 `pushed` 基线）；调用方 `src/editor/probeRunner.ts:324`、`src/editor/stageSwap.ts:190` 用的是 `pushProject(..., { reset: true })`；单测 `stageBridge.test.mjs` 通过。
- 结论：已完成
- 差异或问题：D4 的页面侧测量（`src/mcp/common.ts:71`）用的是 `syncProject(backRole(), st.project)`（增量），没按 E0 / D4 写的 `pushProject(..., { reset: true })` / `setProject(全量, { reset: true })`。基线由 `pushProject` 维护，所以增量在功能上等价、不会留在缩水项目上，属于和任务书字面不一致的小偏差，check 文档没有提。

### R2-9 父页按 `event.source` 过滤事件来源
- 计划要求：`frame` / `ended` / `settled` / `demote` 只认当前 front；`mediaReady` / `probe` / `probe-frame` 只认当前 back（E0 末条）。
- check 文档声称：已完成。
- 核查证据：`src/render/stageRpc.ts:271-276`（`stageEventRole`）、`:319`（按 `e.source` 挡）；`src/editor/stageBridge.ts:75-85`（按角色过滤，并丢弃已被换掉的客户端的事件）。
- 结论：已完成
- 差异或问题：无

### R2-10 `PlayReply` 统一
- 计划要求：统一成 `{ ok: true, stoppedAt }` / `{ ok: true, passed: true }` / `{ ok: false, reason }`，`ok` 不可选（3.2 第 6 条；E0）。
- check 文档声称：已完成。
- 核查证据：`src/render/stageRpc.ts:213-216`；实现在 `src/StageView.tsx:1527-1586`（R5 补齐：循环已停时立即回最后一拍 `:1561`；武装停用 `>=`、等号算「已过」`:1564`；武装超时用真定时器 `:1574`）。
- 结论：已完成
- 差异或问题：`stageRpc.ts:210-211`、`:230` 的注释还写着「R2 的舞台一律回 `unsupported`」，R5 之后已经不对，是过期注释。`src/editor/stageBridge.ts:95-97` 同理。

### R2-11 `play` / `pause` 与六种事件的真实实现
- 计划要求：R2 行写「`play` / `pause` / 六种事件的真实实现」（render_pipeline_restructure.md:231）。
- check 文档声称：R2 回 `unsupported`，七种事件一条都不会来，留给 R5（check.md:60）。
- 核查证据：现在的 main 上 `src/StageView.tsx` post 了 `mediaReady:310`、`settled:583`、`demote:1000`、`ended:1123`、`frame:1126`、`probe-frame:1402`；**`probe` 事件从来不 post**（R4b 定为父页按 `render` 回包自己合成记录，check.md:81）。
- 结论：按决定不做（R2 里不做，移到 R5 / R4b；在 main 上已补齐，`probe` 事件除外）
- 差异或问题：计划正文 R2 那一行和实际分工不一致，但 check 文档有交代。`probe` 事件被取消这件事只写在 check 文档的 R4b 一节，`r2-r7-task.md` E0 的「七种消息」没有更正。

### R2-12 `setRole` 的工作项与 `bake`
- 计划要求：`back` 的工作项取 `'probe' | 'catchup' | 'bake'`；本地模式下 `bake` 回 `{ ok: false, reason: 'unsupported' }`，不抛；收到 `setRole('back')` 就停循环、清空集合、去掉平面、中止追帧，组件不重挂载（J4；E0 `setRole` 条）。
- check 文档声称：RPC 上是三个值，父页队列分三档，测量映射成 `catchup`（check.md:58）。
- 核查证据：`src/render/stageRpc.ts:19-20`；`src/StageView.tsx:1473-1504`（bake 回 unsupported；转 back 时 `stopBeat`、清空 snapshots / suppressed / streamPlanes / settling / catchUps、`catchUpGen++`、`commitPlanes()`）；`src/editor/stageJobs.ts:45`。
- 结论：已完成
- 差异或问题：无

### R2-13 单飞队列（补跑 > 页面侧测量 > 探针）与「掐断后不重发」按工作项判
- 计划要求：父页维护单飞队列；`job: 'catchup'` 期间收到的 `'project'` 一律丢弃；队列空了交还 `'probe'`（3.2 第 5 条；E0；D4）。
- check 文档声称：已完成。
- 核查证据：`src/editor/stageJobs.ts:32-34`（优先级）、`:67-88`（`renderAbortAction`）、`:157-168`（按 `{ client, job }` 判断是否已经发过，R7 修的）、`:170-202`（pump，空了就交还 probe）；单测 `stageJobs.test.mjs` 通过。
- 结论：已完成
- 差异或问题：更急的活只发 abort 信号、不强杀（`:214`），测量要等正在跑的探针收摊。这和「只是通知」的设计一致。另附一条观察（属于 R4b，不在本范围）：`src/editor/probeRunner.ts:318` 把 `drop`（`superseded`）也当成 `retry`，和 E0 的「superseded 直接丢弃」字面不符；有 `MAX_ATTEMPTS` 封顶，影响有限。

### R2-14 `pc-stage-ready` 握手带宿主能力表（J4）
- 计划要求：`hostCapabilities: { prerender, offscreenGl, lowMemory, stageId }`；`prerender` 和 `stageId` 由父页写在 src 查询串里（J4）。
- check 文档声称：未单列。
- 核查证据：`src/render/stageRpc.ts:421-440`，`prerender: q.get("prerender") === "1"`；但 `src/editor/previewMode.ts:78-82` 的 `stageSrc` 从不带 `prerender=1`，全仓 grep `prerender=1` 零命中。
- 结论：部分完成
- 差异或问题：`hostCapabilities.prerender` 恒为 false。眼下没有消费方依赖它，但 J4 要的「父页据此决定走 L 还是本地模式」这一口子实际上是断的。

### R2-15 验收：`stage-rpc-probe.mjs` 跨源复跑全过
- 计划要求：render_pipeline_restructure.md:231；r2-r7-task.md:48。
- check 文档声称：跨源与 `--legacy` 各 3 次全过（Agent 自报）。
- 核查证据：脚本 `scripts/probes/stage-rpc-probe.mjs` 已改成跨源（`2d73576`、`bde8439`），闸门断言在 `:131-143`、`:272`、`:338`。按规定不跑 puppeteer。
- 结论：无法独立验证
- 差异或问题：无

### R2-16 验收：A 舞台死循环 2.5 秒时父页最坏帧间隔 < 20 ms；CDP 里有两个 `type:'iframe'` target
- 计划要求：render_pipeline_restructure.md:231；r2-r7-task.md:48。
- check 文档声称：3 轮全过，最坏间隔中位数 6.1～6.6 ms；要带 `--disable-gpu-vsync --disable-frame-rate-limit`（check.md:57-58）。
- 核查证据：`scripts/probes/stage-isolation-probe.mjs:58-60`（两个 iframe target）、`:105`：**判据是三轮最坏值的中位数 < 20 ms**，不是每一轮最坏值 < 20 ms。
- 结论：无法独立验证（脚本在，没跑）
- 差异或问题：判据被放宽，三轮里有一轮超过 20 ms 仍然算过。check 文档写的是「中位数」，但没点明这比计划的「最坏帧间隔」宽。

### R2-17 端口挪位的连带改动
- 计划要求：（实现产生的）不要撞用户常驻 5190；验证用 dev-test。
- check 文档声称：`npm run preview` 5191 → 5195；dev-test 5197 → 5203；5190 的舞台端口 5191 / 5192 是否空闲没确认（check.md:59）。
- 核查证据：`package.json:10`（`--port 5195`）；`.claude/launch.json:19,24`（5203）、`:32,37`（dev-2d 5198 → 舞台 5199 / 5200）。
- 结论：已完成
- 差异或问题：`r2-r7-task.md:55`（「验证改动用 5197」）和用户记忆里的「5197 = dev-test」「舞台 RPC 探针打 5197」都已过期，文档没跟着改。

---

## R3 舞台内容（E7 + E4b）

### R3-1 `VideoTrack` + `interface Slot` + 三个辅助函数搬到 `src/render/VideoTrack.tsx`
- 计划要求：3.2 搬家清单；E7 第 1 条：`VideoTrack.tsx` 不 import `src/audio/previewAudio` 和 `useScrub`，`routePreviewAudio` 两行删掉，舞台恒 muted。
- check 文档声称：已完成。
- 核查证据：`src/render/VideoTrack.tsx:1-7`（import 里没有 previewAudio / useScrub；`cardAudio` 只 import kernel / render），`:34`（`interface Slot`），`:57`；全文件 grep `routePreviewAudio` 零命中；`src/render/FrameScene.tsx:243`（`muted`）。`src/editor/preview/MediaLayers.tsx` 从 448 行缩到 141 行，改从 `../../render/VideoTrack`、`mediaDrive` import（`:7-8`），音频路由留在 `MediaLayers`（`:3`）。
- 结论：已完成
- 差异或问题：无

### R3-2 `driveMedia` 一族 + 三个 WeakMap + `targetTimeOf` / `filterOf` 进 `src/render/mediaDrive.ts`
- 计划要求：3.2 搬家清单；E7 第 1 条。
- check 文档声称：已完成。
- 核查证据：`src/render/mediaDrive.ts:21`（`lastSeekAt`）、`:34`（`wants`）、`:35`（`retryTimers`）、`:48`（`syncMediaEl`）、`:82`（`driveMedia`）、`:101`（`releaseMedia`）、`:108`（`targetTimeOf`）、`:117`（`filterOf`）；`:45` 的重试定时器用真 `setTimeout`（E4b）。
- 结论：已完成
- 差异或问题：无

### R3-3 `mediaSync.ts` 搬到 `src/render/mediaSync.ts`
- 计划要求：3.2 搬家清单。
- check 文档声称：已完成。
- 核查证据：`586fd02` 用 rename 把 `src/{editor/preview => render}/mediaSync.ts` 和它的 `.test.mjs` 一起搬走；`src/editor/preview/` 下已经没有这个文件；单测 `src/render/mediaSync.test.mjs` 通过。
- 结论：已完成
- 差异或问题：无

### R3-4 素材段按图卡 / 像素映射滤掉，过滤下推进 `nextVideoLayerAfter`
- 计划要求：`cur` / `next` 用 `!graphVisualNode` 滤；给 `nextVideoLayerAfter` 加可选谓词 `skip`；带像素映射的素材段在 live 路走 `PixelMappedMedia`（WebGL，R1b 之后）（E7 第 1 条）。
- check 文档声称：已完成；图卡接管素材段「只验了一半」。
- 核查证据：`src/kernel/project.ts:455-470`（`skip?` 参数，`:470` 带上 `skip?.(c)`）；`src/render/FrameScene.tsx:206-208`（`takenByOther` = 图卡接管，或带像素映射）、`:226`、`:249-258`（live 下像素映射段走 `PixelMappedMedia live`）；`stage-content-probe.mjs:226`、`:244` 有断言。
- 结论：已完成（图卡接管那一路只有探针断言，没有真实图卡样本，check 文档已如实写）
- 差异或问题：无

### R3-5 显示着的视频槽位和图片层写 `data-pc-clip`，隐藏槽位不写
- 计划要求：E7 第 1 条；D3 第 4 步。
- check 文档声称：已完成。
- 核查证据：`src/render/VideoTrack.tsx:209-211`（只有 `shown` 的槽位写）、`:225`（图片层）；像素映射层 `FrameScene.tsx:255`。
- 结论：已完成
- 差异或问题：无

### R3-6 `FrameScene` 的 live 变体与全部新 props
- 计划要求：加 `mediaMode`、`mediaT`、`scrubbing`、`playing`、`proxy`、`suppressed`、`streamPlanes`、`snapshots`、`remountGen`、`settling`、`awaiting`、`localHashes`、`graph`；live 下卡片活跃判据用 `cardMountedAt`；`proxy` 透传；placeholder 分支 DOM 不变（E7 导言、第 2、3 条；3.2 末条）。
- check 文档声称：已完成。
- 核查证据：`src/render/FrameScene.tsx:150-183`（签名里 props 齐全，平面那六个经 `StagePlaneProps`）、`:198-200`（live 用 `cardMountedAt`，placeholder 保持原判据）、`:297-300`（透传）。`git diff 2986755^1 2986755 -- src/render/FrameScene.tsx` 显示 placeholder 分支只多了 `legacyTimeline` 的 memo，和传给 `Stage` 的一组 `undefined` prop。
- 结论：已完成
- 差异或问题：`localHashes` 只收下、不消费（`:185 void localHashes`），这是计划允许的占位（A1 / L 才用）。`:170-182` 的 `onCardCost` 注释还说用 `<Profiler>`，实际实现是 `CostMark`（`:128-134`），注释过期。

### R3-7 `legacyTimeline` 按 `(project, tr, clip)` 引用 memo
- 计划要求：E7 第 7 条。
- check 文档声称：已完成。
- 核查证据：`src/render/FrameScene.tsx:215-223`（以 clip 为键的 WeakMap，校验 project / tr / graph 引用）。
- 结论：已完成
- 差异或问题：无

### R3-8 `Stage` 的六个可选 prop；按片段重挂载的 key
- 计划要求：`snapshots` / `suppressed` / `streamPlanes` / `remountGen` / `settling` / `awaiting`；key 用 `${clip.id}:${remountGen?.get(clip.id) ?? playToken}`；六个都不传时行为逐字不变（E7 导言）。
- check 文档声称：已完成。
- 核查证据：`src/render/Stage.tsx:47-60`、`:68`、`:210`、`:230`；`:234` 在没有类名时 `className` 为 undefined（和旧 DOM 一致）；`src/ExportView.tsx:295-296` 一个平面 prop 都不传。
- 结论：已完成
- 差异或问题：无

### R3-9 四支传 `t` 的地方（组合卡、图卡、`DirectCard`、普通卡）接上追帧与抑制
- 计划要求：3.2「子树虚拟时间追帧要改四支，含图卡」；E7 第 5 条要求冻结只作用在传给组件的那个 `t` 上。
- check 文档声称：已完成。
- 核查证据：`src/render/Stage.tsx:109-115`（`localTOf`：settling 优先，其次冻结值，最后实时值）、`:266`（PartTree）、`:270`（GraphCard）、`:272`（DirectCard）、`:274`（普通卡）；活跃判据、轨迹、不透明度、`data-pc-local-frame` 仍用 `cardT`（`:70`、`:196`、`:202`、`:232`）。
- 结论：已完成
- 差异或问题：无

### R3-10 快照平面：兄弟平面、显式 `position:absolute; inset:0`、按 clipId 改名
- 计划要求：E7 第 4 条；A4；3.2「快照是兄弟平面」。
- check 文档声称：已完成；实例不变由探针验了。
- 核查证据：`src/render/Stage.tsx:309-312`（`renameSnapshotIds(snapshotHtml, clip.id)`）；`stage-content-probe.mjs:319-328` 用 DOM 标记检查挂上、换帧、摘掉三步里组件节点保持同一个。
- 结论：已完成（代码）；探针结果是 Agent 自报
- 差异或问题：无

### R3-11 抑制：子树藏起来、`t` 冻住、`pinner.sync` 跳过
- 计划要求：E7 第 5 条。
- check 文档声称：已完成。
- 核查证据：`src/render/Stage.tsx:93-100`（从不在抑制集到在的那一刻记下值，离开时删掉）；`src/StageView.tsx:290-301`（`skipWrappers` 覆盖 settling + suppressed）；`stage-content-probe.mjs:361-365`。
- 结论：已完成
- 差异或问题：无

### R3-12 流平面（单卡流在包裹层里，组流在舞台根下）
- 计划要求：E7 第 5 条；E0 `setStreamPlanes`。
- check 文档声称：R8 之前恒空，位置已就位。
- 核查证据：`src/render/Stage.tsx:227`、`:318-321`、`:331-336`；`src/StageView.tsx:1621-1625`。
- 结论：已完成（占位，按计划 R8 才有内容）
- 差异或问题：无

### R3-13 `.pc-awaiting` / `.pc-settling`：互斥规则与 500 ms 真定时器兜底
- 计划要求：E0 `setTime` 条（awaiting 由父页点名，两条退出路：快照到达或 500 ms 兜底，兜底用真定时器）；E7 第 4 条（settling 与 snapshot / suppressed 互斥）。
- check 文档声称：已完成。
- 核查证据：`src/render/Stage.tsx:219-225`（settling 时不加 `pc-snapshot` / `pc-suppressed`）；`src/StageView.tsx:375-394`（快照到达就摘掉 awaiting）、`:402-411`（`realSetTimeout` 兜底）、`:1227-1229`（和 `t` 在同一次提交前写入）、`:1608-1616`（setSuppressed 先从 settling 里删）；`stage-content-probe.mjs:379-409`。
- 结论：已完成
- 差异或问题：无

### R3-14 四种类的样式表
- 计划要求：`.pc-snapshot` / `.pc-suppressed` 用 `display:none`，`.pc-awaiting` / `.pc-settling` 用 `visibility:hidden`，都放过三种平面；导出页不注入（E7 第 4、5 条；E0）。
- check 文档声称：已完成。
- 核查证据：`src/render/planeStyle.ts:31-38`（选择器和计划原文逐字一致）、`:43-50`；`src/render/Stage.tsx:76-79`（只有传了 prop 才注入）。
- 结论：已完成
- 差异或问题：无

### R3-15 `StageView` 渲 `FrameScene` live 版并带全部 prop；场景根带 `data-pc-scene`
- 计划要求：E7 末段、第 6 条。
- check 文档声称：已完成。
- 核查证据：`src/StageView.tsx:1723-1772`（`data-pc-scene`；`LIVE` 时传 `graph` 和全部 prop，否则走旧的 `<Stage>`）；`:71`（`LIVE` = iframe 地址带 `preview=stage`，由 `stageSrc` 只在双舞台时加，`previewMode.ts:81`）。
- 结论：已完成
- 差异或问题：无

### R3-16 E4b：`setTimeout` / `setInterval` / `clear*` 虚拟化；跳转不结算；补 `__pcRealSetInterval` / `__pcRealDateNow`
- 计划要求：E4b；3.2 末条。
- check 文档声称：已完成（舞台侧）。
- 核查证据：`src/render/stageClock.ts:118-122`（存下真实的那几个口子）、`:150-161`（`jumpTo` 用 `shift` 保持剩余时间；虚拟 id 从 1e9 起，真 id 转交真实的 clear）、`:163-166`（每个 tick 先结算定时器）、`:182-185`、`:198`、`:218`；`src/render/virtualTimers.ts`；`virtualTimers.test.mjs` 通过。舞台自己的墙钟定时器都走真实的（`StageView.tsx:142-143`、`:1574`；`mediaDrive.ts:45`），grep 舞台相关文件没有漏用虚拟 `setTimeout` 的地方。
- 结论：已完成
- 差异或问题：无

### R3-17 E4b：`Date.now = epochAtStart + now`（epochAtStart 取舞台打开那一刻的真实时间）
- 计划要求：E4b（要让显示日期的卡仍是正常日期）。
- check 文档声称：沿用已有的固定纪元，不换成真实时刻，否则预览和导出的日期卡不一致（check.md:66）。
- 核查证据：`src/kernel/pinEntropy.ts:43`（`PINNED_EPOCH_MS = Date.UTC(2026,0,1)`）、`:79-82`（读 `__pcStageClock.now()`）；`src/render/stageClockEntry.ts:22-24`，舞台先装时钟、再装 pinEntropy。
- 结论：按决定不做（执行者自己定的偏差）
- 差异或问题：不违背 pinned goal（让预览和导出一致，更贴近「精确的活渲染」）。但计划原文的理由（日期卡显示正常日期）被推翻，这属于用户可见的行为：舞台上的日期卡永远显示 2026-01-01。这是执行者替用户做的决定，**没折进 `r2-r7-task.md`「实现后的更正」**（那一节只有 R2 / R4a / R7 三批），E4b 原文仍然写 `epochAtStart`。

### R3-18 E4b：「导出页同一份 `stageClock`，导出的确定性同样受益」
- 计划要求：E4b 末句。
- check 文档声称：假定时器只装在舞台，不装导出页（导出页三处墙钟定时器会死锁，和「导出逐字节不变」冲突）（check.md:66）。
- 核查证据：`src/render/stageClockEntry.ts:22-27`：`?export` 只装 `installPinnedEntropy`，不装虚拟定时器；预渲染 / 导出的 bakery 页面是 `?export=1`（`server/bakery/chrome.mjs:290`）。「三处会死锁」我没能定位到具体代码，无法独立验证。
- 结论：未完成（执行者定的偏差）
- 差异或问题：**回归风险**：靠 `setTimeout` / `setInterval` 计时的卡（E4b 的打字机、倒计时这一类），在舞台里按虚拟时间走，在预渲染进程 / 导出页里却按墙钟走。它们一旦判重（`vtOk=false`、长片段靠追帧上界判重），播放和拖动时贴的死素材（导出页产）和暂停后的精确活渲（舞台产）会对不上，导出结果也不确定。这不直接违背 pinned 某一条，但和 pinned 渲染 7「死素材」、渲染 9 的前提（死素材 = 该卡的正确画面）有张力。建议列为待定项交用户。

### R3-19 E4b 验收：打字机卡 30 格、倒计时卡少 10000 ms；探针第一趟 `vtOk: false`
- 计划要求：E4b 末段；r2-r7-task.md:49。
- check 文档声称：两条判例都中（Agent 自报）。
- 核查证据：探针卡 `src/cards/_probe/timers.tsx`（`52952da`）；`scripts/probes/stage-content-probe.mjs:428-450` 断言 30 格和 10000 ms；**「探针第一趟能推动、`vtOk: false`」没有断言**（`probe-gate-probe` 的布尔判例是 `probe-css` / `particles-snow` / `probe-motion-js`，不含打字机卡，check.md:79）。
- 结论：部分完成（前两条有探针，是 Agent 自报；第三条没验）
- 差异或问题：打字机卡的 `vtOk:false` 没有任何验收覆盖。

### R3-20 `pinAnimations` 的 `resetIn` / `syncIn` / `sync(skip)`
- 计划要求：E7 第 4、5 条（`pinner.sync` 用 skip 集合跳过）；K5 第一路的前提。
- check 文档声称：已完成（合并提交标题）。
- 核查证据：`7194834`；`src/render/pinAnimations.test.mjs` 通过。
- 结论：已完成
- 差异或问题：无

### R3-21 E6：舞台没有墙钟模式、非 legacy 下不跑 `Preview` 的 rAF 循环、effect 拆两半、播放中 rects 每 500 ms 轮询、`pause()` 时清空 `lastRenderKey`
- 计划要求：E6（六步表里 R3 要读 E6；落地多在 R5 / R7）。
- check 文档声称：散在 R5 / R7 里。
- 核查证据：`src/editor/Preview.tsx:149`（`if (dual) return;`）、`:346`、`:672`（setInterval 500 ms）、`:703-704`（清空 `lastRenderKey`）；`stageClock.ts` 没有 `setMode` / `clockSec`。
- 结论：已完成
- 差异或问题：无

### R3-22 验收：`placeholder` 模式全长导出逐字节不变
- 计划要求：render_pipeline_restructure.md:234；r2-r7-task.md:49。
- check 文档声称：90 / 90 相同（去掉冷起趟之后）（Agent 自报）。
- 核查证据：读代码看，placeholder 分支 DOM 没变（见 R3-6、R3-8），样式表不注入，导出页没有虚拟定时器。不能跑导出。
- 结论：无法独立验证
- 差异或问题：「冷起第一趟差 35 帧」这件事被当成比对陷阱排除了，没有给出第一趟差异的根因证据。

### R3-23 验收：快照挂上、摘掉、换帧时卡片组件实例不变
- 计划要求：render_pipeline_restructure.md:234。
- check 文档声称：`stage-content-probe` 21 条断言 3 次全过（Agent 自报）。
- 核查证据：`stage-content-probe.mjs:319-328` 用 DOM 标记（`marked`）代替 React DevTools 的实例判断。机制上成立：key 不变、不换子节点类型（`Stage.tsx:230`）。
- 结论：无法独立验证（没跑）；判据是等价替代
- 差异或问题：无

---

## 发现的问题汇总

1. **导出页 / 预渲染页没有虚拟定时器（R3-18）**：靠定时器计时的卡在舞台里按虚拟时间走，在预渲染进程和导出里按墙钟走。判重后死素材和活渲对不上，导出也不确定。这是执行者自定的偏差，check 文档写了理由（「死锁」），但我没能定位到那三处代码，没核实；也没列为待用户定的事项。属于回归风险。
2. **`Date.now` 用固定纪元，不用舞台打开那一刻的真实时间（R3-17）**：推翻了 E4b 的原意，日期卡在预览里永远显示 2026-01-01，是用户可见行为。执行者替用户做了决定，没折进 `r2-r7-task.md`（「实现后的更正」没有 R3 那一批）。
3. **R3 的更正整体没折回分册**：`r2-r7-task.md` 的「实现后的更正」只有 R2 / R4a / R7。R3 的两条偏差、R4b 的「舞台不 post `probe` 事件」都只写在 check 文档里；E0 仍写「七种消息」，E4b 仍写 `epochAtStart`、「导出页同一份」。
4. **进程隔离验收判据被放宽（R2-16）**：计划是「最坏帧间隔 < 20 ms」，探针实际判「三轮最坏值的中位数 < 20 ms」；check 文档只写了中位数，没说明这是放宽。
5. **`hostCapabilities.prerender` 恒为 false（R2-14）**：`stageSrc` 从不带 `prerender=1`，J4 的这个口子是断的；目前没有消费方依赖它，check 文档没提。
6. **D4 页面侧测量用 `syncProject`（增量），不是 `pushProject(..., { reset: true })`（R2-8）**：功能上等价（基线有人维护），但和任务书字面不一致，check 文档没提。
7. **过期注释**：`src/render/stageRpc.ts:210-211`、`:230` 和 `src/editor/stageBridge.ts:95-97` 仍说 `play` / `pause` 回 `unsupported`；`src/render/FrameScene.tsx:170-182` 仍说 `onCardCost` 用 `<Profiler>`，实际是 `CostMark`。
8. **端口文档过期**：`r2-r7-task.md:55` 仍写「验证改动用 5197」，用户记忆里的 dev-test 5197、舞台探针打 5197 也都过期（现在是 5203，舞台 5204 / 5205）。check 文档自己也承认 5190 的舞台端口 5191 / 5192 是否空闲没确认。
9. **E4b 验收缺一条（R3-19）**：打字机卡「探针第一趟 `vtOk: false`」没有任何探针断言。
10. **`setSnapshots` 回包的 `bytes` 是 UTF-16 字符数，不是字节**（`src/StageView.tsx:383`）：A3c「一次投递 ≤ 2 MB」按它判的话，中文内容会低估。风险小。
11. **本范围外的观察**：`src/editor/probeRunner.ts:318` 把 `superseded`（drop）当 retry，和 E0 字面不符（R4b 的事，有次数封顶）；`StageView` 里的 `LEGACY` 只认 iframe 自己地址上的 `preview=legacy`，而 `stageSrc` 从不传它，所以 3.4 / D5 说的「合并同名开关」实际没合并（R7 的事，也没造成回归）。
12. **没有发现违背 `user_pinned_goal.md` 的实现**。第 1、2 条是执行者替用户做的取舍，建议补进 check 文档第 7 节的待定项，由用户确认。

---

# 审查员 C 逐项

## 复核 C：R4a / R4b / R6 数据面（main `f69f229`）

核查方式：只读代码 + `git log/show` + 逐个跑单测文件（`node --experimental-test-module-mocks --test <file>`，仓库的 test 脚本用 node:test，不是 vitest）+ 手算 K 节算例。没起 dev server，没跑浏览器探针，所以凡是「实跑数字」都只能标「无法独立验证」。

相关合并提交：R4a `62810bb`（分支提交 `a9fc8ca` `1e986ce` `6d302b8` 等）；R4b `ed9a080`（`5ba405a` `df8f1d1` `357fae5` `9c983eb` `15fa9e2` `42a6a9a` `74d3db6`）；R6 `8c566e3`（`2b48d03` `b79ee86` `3f3f6c0` `66402dc` `2c91eef`）；R5 里把预渲染侧接上 planPipelines 的 `bfbf59d`。

单测（逐文件跑，全过）：`src/render/pipelinePlan.test.mjs` 29/29、`pipelineTuning.test.mjs` 9/9、`probeSummary.test.mjs` 8/8、`costDevice.test.mjs` 8/8、`snapshotCompare.test.mjs` 13/13、`wirePlan.test.mjs` 5/5、`snapshotPick.test.mjs` 6/6、`snapshotSource.test.mjs` 4/4、`cardCostKey.test.mjs` 2/2、`server/test/costs.test.mjs` 18/18、`prerender-set.test.mjs` 5/5、`ready-index.test.mjs` 7/7、`mirror-store.test.mjs` 14/14、`prerender-schedule.test.mjs` 5/5、`snapshot-store.test.mjs` 10/10。

---

## R4a：分派纯函数、可调系数、离线探针两趟

### R4a-1 `planPipelines` / `pipelineAt` 纯函数，两端同一份
- 计划要求：`src/render/pipelinePlan.mjs` 导出 `planPipelines(project, costs, fps, opts)` → `{ segments, prerenderSet }` 和 `pipelineAt`，两端同一份代码、逐字段相同（r2-r7-task.md:148、:155；计划 5 节 R4 :237）。
- check 文档声称：已完成，K 节算例逐条覆盖（check.md:71-75）。
- 核查证据：`src/render/pipelinePlan.mjs:143-201`（不读文件、不用 Date/random，集合按 clipId 排序后建 :181 :197 :200）；`pipelineAt` :207-214；`clipCostIndex` 拆出 :227-246（与「实现后的更正」r2-r7-task.md:26 一致）。单测「同一输入两次调用序列化后逐字节相同」「不改入参」通过。
- 结论：已完成
- 差异或问题：纯函数本身没问题；但两端喂进去的 `costs` 不是同一份（见 R4a-12）。

### R4a-2 分段边界 = 所有卡入点 / 出点的并集（pinned 渲染 8）
- 计划要求：边界 = 所有卡片入点出点并集，每个相邻区间各算一次（r2-r7-task.md:148；pinned 渲染 8）。
- check 文档声称：已完成。
- 核查证据：`pipelinePlan.mjs:168`（`new Set(clips.flatMap(start,end))` 升序）、:172-176（中点判活跃）；素材段不参与 :49 :58；单测「分段边界恰好是所有卡入点/出点去重后的并集」「素材段不参与」通过。
- 结论：已完成
- 差异或问题：无。

### R4a-3 预算 B = 1000/fps × 70%，DEAD_MS = 0.3
- 计划要求：pinned 渲染 2/3/5 的门槛；DEAD_MS 0.3，仅 L4 用 `opts.deadMs`（r2-r7-task.md:151）。
- check 文档声称：已完成。
- 核查证据：`pipelinePlan.mjs:46` `budgetOf = (1000/fps)*0.7`；:39 `DEAD_MS = 0.3`；:147 `opts.deadMs`；`COST_SCALE` 不进 B（:45 注释、:102 只乘实测值）。
- 结论：已完成
- 差异或问题：无。

### R4a-4 贪心按 w 升序，停止条件 Σw + 重卡数 × DEAD_MS > B
- 计划要求：按每拍权重 `w` 升序加入轻管线，Σ 里是 `w` 不是裸 `stepMs`（r2-r7-task.md:153；pinned 渲染 3「优先吸纳单帧最便宜」「按每拍实际成本算」）。
- check 文档声称：已完成。
- 核查证据：`pipelinePlan.mjs:179-192`（`heavyCount = pinned + 剩余候选`，`next + heavyCount*deadMs > B` 即停）。手算 K 节算例：①10 张 direct（1,1,2,2,3,5,8,13,21,34，B=23.333）：加第 7 张后 Σ=22、剩 3 张重 → 22.9 ≤ 23.333，第 8 张 Σ=35 超 → 轻 7 张 ✓；②全 30 ms：30 > B 直接 capped → 轻管线空 ✓；③5 张 (b) 档 w=5：依次 6.2 / 10.9 / 15.6 / 20.3 ≤ B，第 5 张 25 > B → 装 4 张 ✓（按裸 stepMs=1 会装 5 张）。三条都有对应单测且通过。
- 结论：已完成
- 差异或问题：无。

### R4a-5 每卡权重分档：direct / (a′) seek / (a) / (b) / 超追帧上界
- 计划要求：`direct` w=stepMs；`seekOk` 且 `seekMs ≤ B` → w=stepMs；推帧卡 `catchUpMs ≤ B` → w=stepMs，`catchUpMs/(4×stepMs) ≤ 2×fps` → w=5×stepMs，超出 → 各位置判重、整段进集合；`seekMs: null` 按推帧卡（r2-r7-task.md:153；pinned 渲染 3 末句「追帧代价按从第 0 帧冲到最后一帧的总代价、在追帧预算内才能进轻管线」）。
- check 文档声称：已完成。
- 核查证据：`pipelinePlan.mjs:86-132`（:112 random、:121-123 seek、:126-131 (a)/(b)/over-catchup，常量 :42-43）。手算：6 秒 stepMs=1 → catchUp 180 > B，180/4=45 ≤ 60 → (b) w=5、不在 prerenderSet ✓；10 秒 → 300/4=75 > 60 → 重、在集合 ✓；60 秒粒子 `seekOk:true, seekMs:null` → 按推帧卡、各位置重 ✓；60 秒纯 CSS `seekMs ≤ B` → 轻、不在集合 ✓。均有单测。
- 结论：已完成
- 差异或问题：无（与 pinned 渲染 3 一致）。pinned 渲染 4 的 `t_c=(t−t_start)×FPS×t_oc` 按计划只用于 K3(b) 实际追帧数、不参与分类，这是计划层的解读，代码照计划。

### R4a-6 `capped` / `demoted` / `pinnedHeavy` 各位置判重
- 计划要求：三者都当 `capped`，每个位置都判重、必在 prerenderSet（r2-r7-task.md:152、:162；3.3 第 2 条）。
- check 文档声称：已完成。
- 核查证据：`pipelinePlan.mjs:108-109`；单测 :75-90 对三面旗各一条。
- 结论：已完成
- 差异或问题：**`capped` 是写死在记录里的**：探针写 `capped = stepMs × COST_SCALE > B`（`src/editor/probeRunner.ts:401`、`scripts/probe-card-costs.mjs:497`），而 `COST_SCALE` 不进 `device` 串、改它不会触发重测。结果是把 `COST_SCALE` 调大立刻生效（:109 当场重算），**调小却撤不掉已经写进记录的 `capped: true`**（:108 先认记录那一位），只能手删记录或 `--force` 重测。pinned 渲染 5「可调系数……不改代码就能调」只成立了一个方向。

### R4a-7 预渲染集合 = 各位置重卡的并集（pinned 渲染 8 / 9）
- 计划要求：`prerenderSet = ∪H(位置)`，集合里的卡整段预渲染；热舞台按位置用 H/L（r2-r7-task.md:154）。
- check 文档声称：已完成；R5 称「`prerenderSetOf` 已接上真的 `planPipelines`」（check.md:89、:97）。
- 核查证据：页面侧 `pipelinePlan.mjs:194-200` 正确求并集；单测「第 2 段判重、第 3 段判轻的卡在 prerenderSet 里，第 3 段热舞台当轻卡」通过。预渲染侧 `server/prerender-set.mjs:74-88` 也算出了同一种集合，存进 `entry.prerenderSet`（`server/frame-pipeline.mjs:920`）。
- 结论：部分完成（计算完成；消费见 R6-2，**服务端从来没用这个集合**）
- 差异或问题：见 R6-2。

### R4a-8 `unknown` 卡照常参加贪心；没有记录的按声明兜底
- 计划要求：`unknown` 照常贪心（r2-r7-task.md:152）；无记录时 `direct` 视为轻、其余视为重（:147 末）。
- check 文档声称：已完成。
- 核查证据：`clipWeight` 不看 `compositing`（`pipelinePlan.mjs:86-132`）；无记录分支 :96-100；单测「unknown 卡照常参加贪心」「判轻就活渲」「按声明兜底」通过。
- 结论：已完成
- 差异或问题：无。

### R4a-9 三个可调系数的缺省值与夹取范围
- 计划要求：`src/render/pipelineTuning.mjs` 缺省 `{COST_SCALE:1, STEP_PERCENTILE:0.9, STEP_MIN_SAMPLES:16}`，夹取 0.25～4 / 0.5～1 / 8～120，`resolveTuning`（r2-r7-task.md:149；3.3 第 3 条；pinned 渲染 5「成本倍率、取第几百分位、最少采样帧数」）。
- check 文档声称：已完成。
- 核查证据：`src/render/pipelineTuning.mjs:16-28`（缺省）、:31-35（范围）、:64-75（`resolveTuning` 夹取、坏值退缺省）；单测 3 条通过。
- 结论：已完成
- 差异或问题：无。

### R4a-10 `stepMs` 取第 90 百分位、样本不足兜底
- 计划要求：`stepMs` = 至少 `STEP_MIN_SAMPLES` 帧样本的第 `STEP_PERCENTILE` 百分位，单次最大另记 `stepMaxMs` 只作诊断（r2-r7-task.md:141；pinned 渲染 5「缺省第 90 百分位，不取单次最大」）。
- check 文档声称：已完成；样本不足取最大（r2-r7-task.md:27 更正）。
- 核查证据：`pipelineTuning.mjs:91-98`（最近秩 `ceil(p·n)`，:95 样本不足取最大）；`src/render/probeSummary.mjs:52-79`（`stepMs = robustStep`，`stepMaxMs = maxOf`，三段生成快照耗时同样取稳健值）；单测「16 个样本的 0.9 分位是第 15 个」「STEP_PERCENTILE 取 1 就是单次最大」通过。
- 结论：已完成
- 差异或问题：无。

### R4a-11 覆盖值文件 `out/pipeline-tuning.json`，随 `GET /api/data/costs` 回；两项拼进 device 串
- 计划要求：覆盖值存本机 `out/pipeline-tuning.json`，随 GET 一起回、两进程都挂；`STEP_PERCENTILE` / `STEP_MIN_SAMPLES` 拼进 `device`，`COST_SCALE` 不拼（r2-r7-task.md:149、:24）。
- check 文档声称：已完成；GET 回 `{ ok, device, mode, costs, tuning }`（加字段没改名）。
- 核查证据：`server/costs-store.mjs` `loadTuning` / `saveTuning`；`server/vite-plugin-costs.ts:142-149`（GET 带 `tuning`）；`src/render/costDevice.mjs:58` 起的 `costDeviceString`（含 `stepP=` / `stepN=`，不含 COST_SCALE）；单测 `costs.test.mjs`「没有文件就全用缺省」「按范围夹取」、`costDevice.test.mjs`「量法的两个系数进串，COST_SCALE 不进」通过。
- 结论：已完成
- 差异或问题：无。

### R4a-12 两端用同一份系数、同一份 costs，算出同一张表
- 计划要求：「两端不交换分派表，只同步 costs」；`GET /api/data/costs` 按当前 `device` 过滤返回，K1 只认同一 `device` 的记录；分派用当前运行模式的记录（r2-r7-task.md:147、:149、:155；计划 3.1 第 1 条）。
- check 文档声称：已完成（`prerender-set.test.mjs` 两端同表）。
- 核查证据：
  - 页面侧 `src/editor/probeRunner.ts:210` 的 `fetch("/api/data/costs")` **不带 `device` / `mode` 参数**，服务端于是回全部记录（`vite-plugin-costs.ts:143-146` → `costs-store.mjs:176-181` 不给就不筛）；这一整份原样进 `setPlanCosts`（probeRunner.ts:467 → `planDispatch.ts:105-109`）再进 `planPipelines`。`pipelinePlan.mjs:138` 的注释写「已按当前 device / mode 过滤」，调用方其实没过滤。
  - 同一 `identityKey` 有多条（不同 device：离线探针的 HeadlessChrome UA、另一个 `mode`、改过 `STEP_PERCENTILE` 前后）时：页面侧 `planPipelines` 取**数组里最后一条**（`pipelinePlan.mjs:154-157`；数组顺序是 `mergeCosts` 的 Map 首次插入顺序，更新不挪位，`costs-store.mjs` `mergeCosts`）；预渲染侧取 **`measuredAt` 最新的一条**（`server/prerender-set.mjs:40-48`）。两条规则在「先有 A 记录、后有 B 记录、再重测 A」时选出不同的记录。
  - 现有单测只在单一 device 下验「两端同表」。
- 结论：部分完成
- 差异或问题：违背 K2「两端逐字段相同」、3.1「dev 的应用只看 dev 记录」。离线探针（`scripts/probe-card-costs.mjs`）写的记录没有 `vtOk` / `seekOk`，一旦被页面或预渲染侧选中，(a′) 和 K5 第一路都会退化成保守路径。

### R4a-13 离线探针分两趟（计时趟 / 快照趟）
- 计划要求：计时趟只推进、不生成快照，量 `stepMs`、`catchUpMs`；快照趟才生成快照，量三段；`catchUpMs` = 已推帧之和 + 除首帧外的中位数 × 未推帧数（r2-r7-task.md:141、:143、:27；pinned 渲染 5「探针分两趟」）。
- check 文档声称：已完成。
- 核查证据：`scripts/probe-card-costs.mjs:296-326`（`probe: 'time'`，`maxFrames: PROBE_MAX_FRAMES`；随后复位再逐帧 `probe: 'snapshot'`）；舞台侧 `src/StageView.tsx:1304-1307`、:1367-1403（计时趟只 push `steps`，:1389-1391 不生成快照、不 post）；外推 `probeSummary.mjs:57-65`；单测「计时趟被封顶：剩下的帧按除首帧外的中位数补」通过。提交 `1e986ce`、`6d302b8`。
- 结论：已完成
- 差异或问题：离线探针不跑布尔趟（不产 `vtOk` / `seekOk`），R4a 范围本来如此；它写进的记录会被常驻探针「已有记录就跳过」认下（device 串不同时不会），影响见 R4a-12。

### R4a-14 计时趟：不按累计墙钟截断，只按 300 帧 / 500 ms 封顶；单帧稳健值越过 B 就停
- 计划要求：「计时趟里单帧活渲耗时的稳健值一越过 B 就停、记 capped；不按整趟累计墙钟截断；封顶只为长片段留：300 帧或 500 ms」（r2-r7-task.md:141；3.3 第 4 条；pinned 渲染 5「可以贪心搜索，一个卡太慢了直接就抛弃算为重卡」「太慢按单帧判」）。
- check 文档声称：已完成。
- 核查证据：`StageView.tsx:1367-1372` 只判 `frames >= maxFrames || realNow()-started > PROBE_MAX_MS`；没有「稳健值越过 B 就停」这一支（`capped` 事后由父页算，probeRunner.ts:401）。
- 结论：部分完成
- 差异或问题：「越过 B 就停」没做，重卡也会一直测到封顶（最多 500 ms/张），只是慢一点、结果不受影响；pinned 原文是「可以」，不算违背。另：300 帧 / 500 ms 封顶后按中位数外推 `catchUpMs`，而 pinned 渲染 2 原文是「从第 0 帧推到最后一帧，记录最慢一帧」、渲染 3 是「从第 0 帧冲到最后一帧的总代价」。封顶是计划 3.3 自己定的，pinned 原文里没有，属计划层决定，建议让用户知情。

### R4a-15 判重只看 `stepMs`：`capped = stepMs × COST_SCALE > B`
- 计划要求：`capped` 只由活渲耗时 `stepMs` 决定，生成快照三段不进判重，截断 ≠ capped（pinned 渲染 5「判重只看活渲耗时」；3.1 第 3 条）。
- check 文档声称：已完成。
- 核查证据：`probeRunner.ts:401`、`probe-card-costs.mjs:497`；`StageView.tsx:1347` 的 `stepOf` 扣掉三段；`clipWeight` 只看 `stepMs` / `catchUpMs` / `seekMs`（`pipelinePlan.mjs:102-131`），`inlineMs` 等不出现。
- 结论：已完成
- 差异或问题：无。

### R4a-16 随机访问卡抽样：固定随机、8 帧不够补抽到 `STEP_MIN_SAMPLES`
- 计划要求：K1「`direct` 卡的 8 次抽样不够就补抽」、取百分位（r2-r7-task.md:141）；pinned 渲染 2 原文「固定随机抽 8 帧，找最差的一次作为 t_c」。
- check 文档声称：已完成。
- 核查证据：`probe-card-costs.mjs:271-275`、`probeRunner.ts:346-349`：抽 `max(8, min(STEP_MIN_SAMPLES, 帧数))` 帧（缺省 16），按 cardId 播种（固定）；`stepMs` 取 p90（16 个样本时是第 15 个，不是最大）。
- 结论：已完成（按计划）
- 差异或问题：**与 pinned 渲染 2 字面不一致**（「8 帧」「最差的一次」），但和 pinned 渲染 5（「稳健统计值、缺省 p90、不取单次最大、最少采样帧数」）一致。两条 pinned 字面冲突，代码取了渲染 5。任务书自己也不一致：K1 :141 末段还写着 direct 卡「四个数各取 8 次里的最大」。建议请用户确认渲染 2 是否以渲染 5 为准。

### R4a-17 实测结论（新口径 0 张因单帧太慢判重、两趟名单一致等）
- 计划要求：R4 验收里要有 K 节算例和实测。
- check 文档声称：62 张卡两种配置各两趟，0 张判重、名单一致；追帧上界换算 p50 约 12 秒（check.md:73）。
- 核查证据：只能看到报告文字，没有重跑（禁止起服务）。
- 结论：无法独立验证
- 差异或问题：无。

### R4a-18 `--mode build` 那一趟
- 计划要求：3.1 第 1 条的 build 记录。
- check 文档声称：没做（dist 供不起宿主页，check.md:75）。
- 核查证据：`probe-card-costs.mjs:120`、:355-358 只有自动判定和 `--mode` 强制，没有 build 宿主。
- 结论：按决定不做
- 差异或问题：无。

---

## R4b：ProbeGate、常驻探针、布尔探针、setPlan

### R4b-1 `ProbeGate` 加载遮罩的落点和样式
- 计划要求：`src/editor/ProbeGate.tsx`，在 `Editor.tsx` 渲 `<Preview />` 的那一层同时渲，盖住整个编辑器，文案「正在测量卡片 k / N」，只用已有主题变量，不另起 iframe（r2-r7-task.md:141；pinned 渲染 5、交互 2/3）。
- check 文档声称：已完成。
- 核查证据：`src/Editor.tsx:243`；`ProbeGate.tsx:45-66`；`ProbeGate.css` 只用 `--ui-*` 变量（grep 不到十六进制色和 rgba）；遮罩不建 iframe。
- 结论：已完成
- 差异或问题：无。

### R4b-2 顺序：whenStageReady('back') → setRole probe → 逐张测 → 全部回包后摘遮罩；全命中时一帧不出现
- 计划要求：r2-r7-task.md:141 的落点顺序。
- check 文档声称：已完成；probe-gate-probe 三趟通过。
- 核查证据：`probeRunner.ts:458`（`await whenStageReady("back")`）、:464-489（逐张、每张 PUT）、`runBackJob("probe", …)` :521；遮罩只在 `running && blocking` 时显示（ProbeGate.tsx:45），`jobs.length === 0` 时 `running` 不会翻成 true（probeRunner.ts:471）。
- 结论：已完成（代码层）；实跑数字无法独立验证
- 差异或问题：`enabled = previewMode() === "stage"`（ProbeGate.tsx:26），而 R7 的更正写明露出舞台的判据是 `dualStage()`（r2-r7-task.md:33）。舞台端口被占、退回同源单舞台时没有 B iframe（`Preview.tsx:987`），`whenStageReady('back')` 永远不 resolve：探针一张都不测、全部走声明兜底，而且没有任何提示。

### R4b-3 「每次打开项目」都在遮罩下测完
- 计划要求：pinned 渲染 5「每次打开项目，在加载（转圈页面）的时候测所有卡片……全部测完才进」。
- check 文档声称：已完成（「第二次打开遮罩一帧不出现」指的是记录全命中）。
- 核查证据：`probeRunner.ts:438` 的 `firstPassDone` 是模块级变量，第一个有卡的项目测完后置 true（:494），此后只有 `resetProbeRunner()`（测试用，:537-544）会清它；打开项目走 `actions.loadProject`，是单页内换项目、不刷新页面（`src/editor/TopBar.tsx:436/444`、`src/editor/io/*.ts`）。
- 结论：部分完成
- 差异或问题：**同一次页面会话里打开第二个项目时，没测过的卡在后台补测，不挡界面**（`blocking: !firstPassDone` = false），期间这些卡按声明兜底分派。这违背 pinned 渲染 5「每次打开项目……全部测完才进」。

### R4b-4 遮罩期间编辑操作被挡
- 计划要求：遮罩盖住整个编辑器界面，编辑操作被挡（r2-r7-task.md:141）。
- check 文档声称：已完成。
- 核查证据：`ProbeGate.tsx:55-57` 只在遮罩元素上 `stopPropagation` pointerdown / keydown；遮罩不可聚焦，挂在 `window` / `document` 上的全局快捷键（比如 `railDrag.ts:80` 这类 `window.addEventListener("keydown")`）不经过它。
- 结论：部分完成（鼠标被挡；键盘全局快捷键是否被挡，无法独立验证）
- 差异或问题：可能有键盘快捷键穿过遮罩（播放、删除等）。没实跑，列为风险。

### R4b-5 一次只测一个片段（缩水项目，经 `pushProject`）
- 计划要求：`pushProject('back', 缩水项目, { reset: true })` 再 `render`；`'project'` 重发前先重发缩水项目（r2-r7-task.md:146）。
- check 文档声称：已完成。
- 核查证据：`probeRunner.ts:158-167`（一条轨道一个 clip、start 平移到 0、剥掉媒体和 cardNodes）、:324（每次尝试先 `pushProject`）、:313-321 中止回包按 `renderAbortAction` 翻译，:517-529 最多 `MAX_PROJECT_RESENDS + 1` 次。
- 结论：已完成
- 差异或问题：缩水项目剥掉了 `cardNodes`，组合卡 / 图卡片段的测量环境与真实项目不同。计划本来就这样写，不算偏差。

### R4b-6 已测跳过；同一张卡多个片段只测一次
- 计划要求：同 `(identityKey, device)` 已有记录且 `demoted !== true` 的跳过（r2-r7-task.md:141；pinned 渲染 5 末句）。
- check 文档声称：已完成。
- 核查证据：`probeRunner.ts:175`、:185。
- 结论：已完成
- 差异或问题：`cardCostKey` 剥掉了 `inputs`（`src/render/cardCostKey.mjs:23`），依赖卡的上游变了不会重测；pinned 渲染 5 写的是「卡**和依赖**的身份都没变时才复用」。探针本来就在缩水项目上测（没有上游），所以数值上影响有限，但和 pinned 字面不一致，列为小偏差。

### R4b-7 之后新添加 / 键变了的卡在后台补测，不挡界面
- 计划要求：r2-r7-task.md:141。
- check 文档声称：已完成。
- 核查证据：`ProbeGate.tsx:38-43` 项目引用一变就调 `syncProbeRun`；`probeRunner.ts:447-452` 递增代数、重排。
- 结论：已完成
- 差异或问题：无（和 R4b-3 同一机制：第二个项目也被当成「新添加」处理了）。

### R4b-8 常驻探针三趟（计时 / 快照 / 布尔），快照三段取稳健值
- 计划要求：计时趟 → 复位 → 快照趟 → 两趟布尔（r2-r7-task.md:143）。
- check 文档声称：已完成；舞台不 post `probe` 事件，父页按三次 `render` 回包合成记录（check.md:81，属已说明的偏差）。
- 核查证据：`probeRunner.ts:368`（`probe:'time', maxFrames: PROBE_MAX_FRAMES`）、:378（`probe:'snapshot'`，回包带 `snapshotSteps`）、:391（`probe:'booleans'`）；统计走同一份 `summarizeProbe`（:400）；舞台快照趟受一拍预算约束 `StageView.tsx:1374`。
- 结论：已完成
- 差异或问题：快照趟只推得了几帧（一拍预算 23 ms，而单帧生成快照 6～23 ms），样本少于 16 时 `robustStep` 取最大，所以 `inlineMs` 等实际是「几帧里的最大」。它们不进判重，影响只在产能估计上。

### R4b-9 两趟布尔探针 `vtOk` / `seekOk` / `seekMs`
- 计划要求：两趟各先走「重挂载定位配方」复位；基线 = 全局时钟推 8 帧的控件 HTML（留在舞台内存）；`vtOk`：只 `syncIn` 子树 + 组件 t 推 8 帧再比；`seekOk`：一步钉到第 8 帧再比；标签、属性、文本逐字比，数值 1e-6 相对误差；`lossy>0` 或第 8 帧前截断记 false；各 8 帧 / 200 ms 封顶；`seekMs` 从第 0 帧直接钉到最后一帧，超限记 null；不 post `probe-frame`（r2-r7-task.md:143；pinned 划分 轴一「如何区分 SeekOK」）。
- check 文档声称：已完成；判例 `probe-css` vtOk+seekOk、`particles-snow` vtOk、`probe-motion-js` vtOk:false。
- 核查证据：`StageView.tsx:829-844`（复位配方：`resetIn` → 重挂载 → `tick` 两次 → `syncIn(mountMs)`）、:882-957（四趟）、:858（`lossy>0` → null → false）、:907（不足 8 帧无基线）、:921 / :941 / :956（200 ms 封顶、seekMs 超限记 null）；比对 `src/render/snapshotCompare.mjs:44`（1e-6）、:160-165（`|a−b| ≤ 1e-6·max`）；单测 13/13 通过；四趟都不 post。
- 结论：已完成（代码层与 pinned 划分 轴一逐条对上）；三张判例卡的实跑结果无法独立验证
- 差异或问题：无。

### R4b-10 成本记录由父页补齐后整条 PUT，显式 `demoted:false`，不写 `pinnedHeavy`
- 计划要求：3.3 第 1、2 条；r2-r7-task.md:147。
- check 文档声称：已完成。
- 核查证据：`probeRunner.ts:404-427`（`mode` / `demoted:false` / `measuredAt` / `device`，没有 `pinnedHeavy`）；`costs-store.mjs` `STICKY_FLAGS` 与 `mergeCosts`；单测「demoted / pinnedHeavy 在复测时粘住，显式带值才覆盖」通过。
- 结论：已完成
- 差异或问题：无。

### R4b-11 device 串共享（离线探针与常驻探针逐字节相同）
- 计划要求：UA + WebGL `UNMASKED_RENDERER_WEBGL` + `lowMemory` / `offscreenGl` / `glRoute` + mode（J4、r2-r7-task.md:147）。
- check 文档声称：已完成，逐字节相同。
- 核查证据：`src/render/costDevice.mjs:58` 起八段；`probeRunner.ts:125-137` 取舞台握手报的 `lowMemory` / `offscreenGl`；单测「两条路拼出来逐字节相同」通过。提交 `9c983eb`。
- 结论：已完成
- 差异或问题：无。

### R4b-12 `setPlan` 下发
- 计划要求：`costs`、项目、系数变了就对 `front` 发 `setPlan({ plan, costs })`；舞台用同一份 `pipelineAt`（r2-r7-task.md:119 `setPlan` 一段；r2-r7-task.md:149）。
- check 文档声称：已完成。
- 核查证据：`src/editor/planDispatch.ts:54-122`（项目 / costs / 单条合并都 `schedule` 重算，微任务合批，没变不重发 :75，转正补发 `force`）；线上形状 `src/render/wirePlan.ts:189-233`（集合转数组，捎带 `identityKeys` / `frameModes` / `tuning`）；单测 5/5 通过。提交 `5ba405a`。
- 结论：已完成
- 差异或问题：下发的 `costs` 是没按 device 过滤的全集（见 R4a-12），舞台侧 `reviveStagePlan` 也按 `identityKey` 最后一条去重（wirePlan.ts:205-211）。

### R4b-13 系数写入口 `PUT /api/data/costs/tuning`，转发预渲染进程
- 计划要求：R4a 缺的写入口（check.md:75）；两端同一份系数（r2-r7-task.md:149）。
- check 文档声称：R4b 已补。
- 核查证据：`server/vite-plugin-costs.ts:121-139`（夹取后落盘、`null` 清覆盖、`forwardToPrerender`）；`costs.test.mjs` 里 `saveTuning` 的 4 条单测通过。
- 结论：已完成
- 差异或问题：无（验收里「改成 2 后下一次打开项目改判」只做了纯函数层的单测）。

### R4b-14 探针帧转发 `probe-frame` → `PUT /api/frames/snapshot`（只转 independent）
- 计划要求：快照趟 post 的 `probe-frame` 由父页转发，只有 `independent` 卡存（r2-r7-task.md:144；pinned 渲染 5）。
- check 文档声称：转发写好、未验收（check.md:82）。
- 核查证据：`probeRunner.ts:252-266`、:513-515；编辑器进程转发 `server/vite-plugin-frames.ts:259-265`；预渲染进程只存 `compositing === "independent"` 且档位是 shared 的卡（:278-280）。
- 结论：部分完成（链路在；没有端到端验收）
- 差异或问题：① probeRunner.ts:236-243 的注释还写着「TODO(R6)：端点还没合进来」，已经过期；② 404 **或任何网络异常**都会把 `snapshotEndpointMissing` 永久置 true（:262-264），本次页面会话以后不再转发；③ 预渲染侧要求 `entry.cardPlan` 已算出，否则回 `202 PLAN_PENDING`、丢帧（vite-plugin-frames.ts:276-277）。项目刚打开、探针跑在遮罩下时，后台预渲染多半还没算出 card plan，所以探针帧大概率存不进去。

### R4b-15 实测验收（20 张卡 8.5 秒、帧间隔 ≤ 20 ms、换项目重排）
- 计划要求：K 节验收（r2-r7-task.md:163）。
- check 文档声称：`probe-gate-probe` 三趟通过；帧间隔 p50 17.1 ms，并说明 vsync 没关掉、量到的是上界。
- 核查证据：只有报告文字。
- 结论：无法独立验证
- 差异或问题：无。

---

## R6：数据面

### R6-1 C2 先预渲染锚帧，锚帧全部就绪前不开始其余预渲染
- 计划要求：锚帧 = 每片段 `mountFrameOf`、`clipFrameSpan.last+1`、第 0 帧；「预渲染进程的全部 Chrome 一起上」；锚帧就绪前不开始其余后台预渲染；锚帧队列也在批次边界读 `wanted`（r2-r7-task.md:95、:97）。
- check 文档声称：已完成；ready-index-probe「锚帧先就绪」。
- 核查证据：`src/render/snapshotPick.mjs:45-55`（锚帧集合）；`server/frame-pipeline.mjs:805-807`（先 `fillAnchorSnapshots` 再 `fillCardControls`）、:1046-1060（整场景一趟、`markDone`）。
- 结论：部分完成
- 差异或问题：锚帧只用后台那**一个** bakery 串行跑，不是「全部 Chrome 一起上」；锚帧那一趟是一次 `bakeFrames`，中途不读 `wanted`。

### R6-2 预渲染只做预渲染集合（A3a 与 K2 求交；pinned 渲染 9）
- 计划要求：「只预渲染 `plan.prerenderSet` 里的卡，整段预渲染」；`fillCardControls` 进循环前把不在并集里的 control 剔掉（r2-r7-task.md:88）；C2「不在集合里的卡什么都不产」（:95）；pinned 渲染 9「在所有位置都判轻的不产快照、不产流、不进就绪索引」。
- check 文档声称：R6「`prerenderSetOf` 当时按声明兜底，R5 接上了真的」（check.md:97、:89）。
- 核查证据：`entry.prerenderSet` 只在 `frame-pipeline.mjs:920` 赋值，全仓库 server 侧**没有任何地方读它**（grep `prerenderSet` 只命中赋值、注释和 prerender-set.mjs 本身）。后台预渲染在 :807 和 :813 两次调 `fillCardControls`，按 `needPrerendering` 分两批，合起来是**全部** `cacheable` control；:809 的本地档、:1051 的锚帧都遍历全部有快照档的 control（`missingSnapshotFrames` :1022-1035）；`adoptCardPlan` 给全部 control 认领就绪层（:921-928）。
- 结论：未完成
- 差异或问题：**违背 pinned 渲染 9**：判轻的 stateful 卡照样产快照、进就绪索引。连带问题：① 用户定过的「两张超 300 KB 的 lottie 卡不进预渲染集合、根本不生成快照」（计划 7 节、A3c）实际上并不成立，它们照样逐帧生成快照；② K6 降级→预渲染→就绪的闭环（「costs 变了在 4 帧批边界重算 prerenderSet、把新增的卡排进队尾」，r2-r7-task.md:147）没有实现，只是因为所有卡本来都在产，才看不出来。check 文档说「R5 接上了真的 planPipelines」，只对了「算」这一半。

### R6-3 C2 `cacheable` 放行 `sourceDependent`
- 计划要求：`card-cache.mjs:65` 的 `cacheable` 改成 `independent || sourceDependent`（r2-r7-task.md:88、:95）。
- check 文档声称：没提。
- 核查证据：`server/card-cache.mjs:66` 仍是 `compositing === 'independent'`；:56-65 的注释说明要等隔离工程接上依赖链（`isolatedCardProject` 的 `graph` 参数、`−phase − target.start` 位移）才能放行，这两样也没做。
- 结论：未完成
- 差异或问题：转场卡的共享档只能靠锚帧 / 整场景那条路产（`recordSnapshots`），隔离单卡路不产。check 文档没列出这一条。

### R6-4 C2 共享档：`snapshotFrames` 收窄到缺帧，HTML 另立完整性判据
- 计划要求：`new Set(localFrames)` 收窄成本卡缺的帧；完整 = `index.count === control.count`；保持 `snapshotOnly: false`（r2-r7-task.md:95、:127）。
- check 文档声称：已完成（HTML 判据和 PNG 的 `hasComplete` 取并）。
- 核查证据：`frame-pipeline.mjs:1081-1084`、:1102、:1106-1108。
- 结论：已完成
- 差异或问题：见 R6-14（超限帧永远算「缺」）。

### R6-5 C2 本地档：`renderLocalSnapshots` 一趟整场景服务全部本地档卡
- 计划要求：`targetFrames: frames`、`fullFrame: true`、`snapshotOnly: false`、`writeFrames: false`、`snapshotFrames: new Set(frames)`；按 `control.clipId ↔ snapshotKey` 反查写 `controls-local/<entry.key>/<共享键>/`（r2-r7-task.md:95）。
- check 文档声称：已完成。
- 核查证据：`frame-pipeline.mjs:977-1008`（参数逐项对上）、:1016-1037（缺帧并集）。
- 结论：已完成
- 差异或问题：和 R6-2 一样，没按预渲染集合过滤。

### R6-6 C3 就绪索引 SSE：端点、三种消息、全量 layer、页面直连预渲染进程
- 计划要求：`GET /api/frames/ready?session=&localRev=`，消息 `reset` / `layer`（全量） / `done`，页面直连预渲染进程、编辑器进程不代理（r2-r7-task.md:96）。
- check 文档声称：已完成；SSE 首条 `reset`。
- 核查证据：`server/ready-index.mjs:60-175`（三种消息、全量 layer、订阅先灌 backlog）；`server/vite-plugin-frames.ts:161-178`（SSE、15 秒心跳注释）；页面侧 `src/render/snapshotSource.ts:115-165` 用 `prerenderBase()` 拼地址；单测 7/7 通过。
- 结论：已完成（格式与直连）
- 差异或问题：`/ready` 分支没有 `isPrerender` 判断，编辑器进程自己也会用它那份空索引回一条 SSE。页面不连它，所以不致命，但注释「编辑器进程对不认识的路径一律 next()」和代码不符。

### R6-7 C3 按项目版本 `reset`；按 `{session, localRev}` 算；`done` 每一版各发一次
- 计划要求：`reset` =「项目版本换了，页面清表」；期望哈希按 `{session, localRev}` 那版算（r2-r7-task.md:96）。
- check 文档声称：已完成。
- 核查证据：`ready-index.mjs:74-79` 的 `reset()` 全仓库**没有调用方**（grep `readyIndex.` 只有 stageByKey / claim / setLayer / markDone / subscribe）；SSE 端点忽略 `session` / `localRev` 查询参数（vite-plugin-frames.ts:161-170），索引是每个 FramePipeline 一份的全局表；`localRev` 从不更新（只在 `claim` 里原样回填）；`markDone` 只发一次（:108-112），之后只有 `claim` 会清。
- 结论：部分完成
- 差异或问题：项目换版本 / 换项目时页面收不到 `reset`，已删片段的旧层留在表里；第二个项目的锚帧就绪信号 `done` 不会再发。只有 F5 的 `claim` 路径会 reset。

### R6-8 页面侧就绪索引与取快照字节
- 计划要求：`readyIndex: Map<clipId, Map<kind,{key,ranges}>>`，`stream` 表和 `html` 表并存；URL 按段 `encodeURIComponent`；LRU 64；`immutable` 缓存（r2-r7-task.md:96、:172）。
- check 文档声称：已完成；取回的 HTML 与磁盘逐字节相同。
- 核查证据：`snapshotSource.ts:37`（64）、:39（1/2/4/8 s）、:46-48（按段编码）、:58-65（`applyReadyMessage`）、:177；服务端 `vite-plugin-frames.ts:192-207`（`text/html; charset=utf-8` + `immutable`）。
- 结论：已完成
- 差异或问题：无。

### R6-9 C4 `wanted` 四处
- 计划要求：`mirror-store.mjs` 的 `setPlayhead` 加第四参；`vite-plugin-mirror.ts` 的调用与转发体带上；页面侧另开 100 ms 固定节流、`keepalive`、不读响应的发送函数，播放中和拖动中都发；最多 8 条（r2-r7-task.md:97；计划 3.4）。
- check 文档声称：已完成；`wanted` 促成批次提前。
- 核查证据：`server/mirror-store.mjs:150-160`；`server/vite-plugin-mirror.ts:240-242`；`src/render/dataMirror.ts:191-226`（节流、`keepalive: true`、不 await）；调用点 `src/editor/snapshotFeed.ts:339`、:369；单测 `mirror-store.test.mjs` 14/14 通过。
- 结论：已完成
- 差异或问题：`mirror-store.mjs:158` 的 `wanted: list ?? previous?.wanted` 让最后一份 `wanted` 一直留着，页面不再缺料时也不清（`pushWanted` 对空数组不发）。预渲染侧会继续按旧提示插队，只是批做完后自然失效，影响小。

### R6-10 C4 预渲染进程在 4 帧批边界消费 `wanted`
- 计划要求：`fillCardControls` 每批开始前读 `latestPlayhead().wanted`，先跑含它的那一批，再回到顺序批；不打断正在跑的批（r2-r7-task.md:97）。
- check 文档声称：已完成（批次插队诊断）。
- 核查证据：`frame-pipeline.mjs:944-959`（`nextBatchStart`）、:1093-1098；诊断口 `/api/frames/diagnostics`（vite-plugin-frames.ts:183-185）；`prerender-schedule.test.mjs` 5/5 通过。提交 `2c91eef`。
- 结论：已完成（共享档批）
- 差异或问题：只有共享档的隔离单卡循环读它；锚帧和本地档那两趟都是一次性 `bakeFrames`，不读（见 R6-1）。

### R6-11 C4 回溯选帧（按层、同区间不跨、不等待）
- 计划要求：对每层 `ranges` 二分找 ≤ 目标本地帧的最大就绪帧，且不小于目标所在锚帧区间的起点（r2-r7-task.md:96-97）。
- check 文档声称：已完成；第 45 帧选中段起点 29。
- 核查证据：`src/render/snapshotPick.mjs:24-36`（二分）、:57-79（不跨段）；单测 6/6 通过。
- 结论：已完成
- 差异或问题：无。

### R6-12 C4 换 DOM 的 33 ms 节流、投递基线（父页排程）
- 计划要求：每 rAF 至多一次、间隔 ≥ 33 ms；按 iframe 维护投递基线（r2-r7-task.md:89、:97）。
- check 文档声称：R6 表里没单列，R5 的「父页的快照 / 抑制投递」提交 `215b771` 里做。
- 核查证据：`src/editor/snapshotFeed.ts` 存在、调了 `pushWanted`；本次没有逐行审它的节流和基线。
- 结论：无法独立验证（不在本次重点，没逐行核）
- 差异或问题：无。

### R6-13 C5 播放态按层、不等
- 计划要求：r2-r7-task.md:98。
- check 文档声称：R5 实现。
- 核查证据：属 K4/K5 的父页与舞台逻辑，本次没核。
- 结论：无法独立验证
- 差异或问题：无。

### R6-14 A3c 超限帧不进就绪索引、不投递、记诊断
- 计划要求：DOM 卡 300 KB、canvas 1 MB；超限照常落盘，不进索引、不投递，记诊断；K1 探针帧超限同样不存（r2-r7-task.md:89；计划 7 节）。
- check 文档声称：已完成；1 438 949 字节的帧盘上有、层不存在。
- 核查证据：`server/snapshot-store.mjs:82-94`（两档上限，按 `canvasHeavy` 选）、:132-140（诊断环形缓冲）；调用点 `frame-pipeline.mjs:1119-1121`、:997、:715 附近、`vite-plugin-frames.ts:283-285`；单测通过。
- 结论：已完成（行为层）
- 差异或问题：**注释写的「照常落盘（下一次不用重渲）」不成立**（`snapshot-store.mjs:74`、`frame-pipeline.mjs:715`）。缺帧是按 `index.json` 算的（`frame-pipeline.mjs:1102`、:1028-1033），超限帧不进 index，所以永远算「缺」，`htmlComplete` 永远为 false（:1083）。每一趟后台预渲染都会把这些帧重新渲一遍、再判超限、再丢掉。和 R6-2 叠在一起，两张大 lottie 卡每一趟都会被整段重渲。这是回归风险。

### R6-15 J3 快照来源接口
- 计划要求：`src/render/snapshotSource.ts` 的 `SnapshotSource` 接口 + `HttpSnapshotSource`；重连按 1/2/4/8 s 退避；`StageView` / `Preview` 不直接 fetch、不直接 `new EventSource`；`IdbSnapshotSource` 属 L2（r2-r7-task.md:172）。
- check 文档声称：已完成。
- 核查证据：`snapshotSource.ts:29-33`、:107-190；grep `new EventSource` 在 `StageView` / `Preview` 里零命中；拿不到预渲染源就退避、不连同源（:120-127）。提交 `b79ee86`。
- 结论：已完成（`IdbSnapshotSource` 按范围不做）
- 差异或问题：无。

### R6-16 F5 预渲染进程重启后重建就绪索引
- 计划要求：起来先扫两档 `index.json`，只得「键 → ranges」；等项目到位、重算 card plan，用 `clipId ↔ snapshotKey` 反查，然后先 `reset` 再逐层发全量 `layer`；项目没到之前不发 `layer`；`costs` 从盘重读（r2-r7-task.md:168；计划 3.4 第 3 条）。
- check 文档声称：已完成；杀进程后重连首条 `reset`、项目到位后三层重建。
- 核查证据：`vite-plugin-frames.ts:52`（起服务即 `rescanSnapshots`）；`frame-pipeline.mjs:882-908`（`stageByKey`，不发 layer）、:917-929（`adoptCardPlan` → `claim`）；`ready-index.mjs:130-148`（`claim` = reset + 全量 layer）；`costs` 每次 `adoptCardPlan` 都 `loadCosts`（prerender-set.mjs:78）。单测 `ready-index.test.mjs` 通过。
- 结论：已完成（索引重建这一半）；实跑无法独立验证
- 差异或问题：`staged` 认领后不清，之后每次 `adoptCardPlan` 只要命中 staged 键都会再发一次 `reset` + 全量层。语义上无害，但会让页面清一次表。

### R6-17 F5 其余条目
- 计划要求：`streamPool` 租约作废、预渲染批次按 C2 优先级重排、Agent 队列未回包的请求由编辑器进程原样重发一次（r2-r7-task.md:168）。
- check 文档声称：没单列。
- 核查证据：`server/prerender-client.mjs` / `vite-plugin-prerender.ts` 里只有 `retryable: true` 标记和 `MAX_RESTARTS` 重启（`vite-plugin-prerender.ts:26`、:137），没找到「编辑器进程重发一次」的实现；`streamPool` 租约属 R8。
- 结论：部分完成（Agent 重发未见实现；流租约 R8 才有）
- 差异或问题：check 文档没提 Agent 重发这一条。

### R6-18 D5 `FramePipeline` 的 `interactive` 参数
- 计划要求：编辑器进程 `interactive:false`（`user` / `playback` lane 立即 `USE_PRERENDER`，不进 `acquireUser`，不 `prewarmUser`）；预渲染进程 `true`（r2-r7-task.md:107）。
- check 文档声称：R6 加参数，R7 把编辑器侧翻成 false。
- 核查证据：`frame-pipeline.mjs:101-106`、:140-144、:285-286、:439-441；`vite-plugin-frames.ts:43` `interactive: isPrerender`。
- 结论：已完成
- 差异或问题：`frame-pipeline.mjs:93-95` 的注释还写着「两个进程都 `true`、R7 才切」，已经过期。

### R6-19 D5 `streamPool` 与相关清理
- 计划要求：热池改名 `streamPool`、只给 G 分段和 C2 锚帧用；借还改成池内调节；`/api/frames/yield` 删除；`/api/cards/layout` 不借 `streamPool`，`user` 模式回 `503 NO_AGENT_LANE`（r2-r7-task.md:107；计划 3.4 末条订正：借还和 `stopPlayback()` 还在）。
- check 文档声称：已完成（「`interactive` 参数与 `streamPool`」）。
- 核查证据：`frame-pipeline.mjs:136-138` 只是 `userPool` 的 getter 别名；锚帧用的是 `'background'` lane 的 bakery（:799、:1053），不是 `streamPool`；`/api/frames/yield` 仍在（vite-plugin-frames.ts:302-307，编辑器侧的 `borrow` / `release` :88-105 也还在调）；`layout` 借 `agent` lane（frame-pipeline.mjs:1214-1234），但全仓库找不到 `NO_AGENT_LANE`。
- 结论：部分完成
- 差异或问题：`streamPool` 只是换了个名字；`/yield` 没删；`user` 模式下 layout 的 503 没做（计划 3.3 自己也写了「`user` 模式回 503 未核」）。借还保留符合 3.4 的订正。

### R6-20 K1 探针帧入库端点 `PUT /api/frames/snapshot`
- 计划要求：编辑器进程转发、预渲染进程按镜像里的项目用 A3a 规则算 `kind` / `key`；只有 `independent` 的卡存；写进同一目录、进 C3 索引；超限不存（r2-r7-task.md:144）。
- check 文档声称：R6 做了「探针帧入库」（提交 `2b48d03`）。
- 核查证据：`vite-plugin-frames.ts:252-294`。
- 结论：已完成（服务端这一半）
- 差异或问题：依赖 `entry.cardPlan` 已算出，否则 202 丢帧（见 R4b-14）。

### R6-21 `unknown` 卡走本地档
- 计划要求：`snapshotTier` 对 `unknown` 的 stateful 卡回 `'local'`（计划 3.1 第 2 条）。
- check 文档声称：已完成。
- 核查证据：`server/snapshot-store.mjs:65-71`（`compositing || 'unknown'` → 非 independent / sourceDependent 一律 `'local'`）；单测通过。
- 结论：已完成
- 差异或问题：档位按**声明的** `frameMode === 'stateful'` 判（:66）。按 pinned 渲染 2，随机访问（direct）卡 `t_c > B` 也可能判重，但 direct 卡 `snapshotTier` 回 `'none'`，永远没有死素材，判重后那一层只能透明。这是计划 A3a 本身的口径（「共享快照：… 且 stateful」），不算执行偏差，但和 pinned 渲染 2/7 之间有缺口。

### R6-22 R6 验收（冷缓存拖到第 1000 帧贴区间起点；杀预渲染进程后按键重建）
- 计划要求：计划 5 节 R6 :243；r2-r7-task.md:52。
- check 文档声称：`ready-index-probe.mjs` 冷缓存 8 条全过。
- 核查证据：探针脚本在（提交 `3f3f6c0`），没有重跑。
- 结论：无法独立验证
- 差异或问题：无。

---

## 发现的问题汇总

1. **违背 pinned 渲染 9（最重要）**：服务端算出了 `entry.prerenderSet`（`server/frame-pipeline.mjs:920`），但没有任何代码读它。后台预渲染（锚帧 :806、共享档 :807/:813、本地档 :809）和就绪索引认领（:921-928）都覆盖全部有快照档的卡。结果是判轻的卡照样产快照、进就绪索引；用户定下的「两张大 lottie 卡根本不生成快照」不成立；K6 的「costs 变了在 4 帧批边界重算集合、新增卡排进队尾」也没实现。check 文档（R5 / R6 节）写「接上了真的 planPipelines」，容易让人以为已经在用。
2. **两端对表可能不一致**：页面拉 `costs` 时不带 `device` / `mode`（`src/editor/probeRunner.ts:210`），全集进 `planPipelines`，同键取数组最后一条；预渲染侧取 `measuredAt` 最新的一条（`server/prerender-set.mjs:40-48`）。有多台 device 或多种 mode 的记录时（离线探针的 HeadlessChrome UA、build 记录、改过百分位前后），两端可能选中不同的记录。这违背 K2「两端逐字段相同」和 3.1「dev 只看 dev 记录」。`pipelinePlan.mjs:138` 的注释「已按当前 device / mode 过滤」与实际不符。
3. **A3c 超限帧每趟重渲**：超限帧不进 `index.json`，缺帧又是按 index 算的，所以它们永远算「缺」，每一趟后台预渲染都重渲、再丢。`snapshot-store.mjs:74` 和 `frame-pipeline.mjs:715` 注释里的「下一次不用重渲」是错的。这是回归风险（CPU 浪费，和第 1 条叠加后更明显）。
4. **「每次打开项目」的遮罩只在页面会话里的第一个项目生效**（`probeRunner.ts:438`、:494 的模块级 `firstPassDone`）。之后在同一页面里 `loadProject` 打开的项目不挡界面、在后台补测，违背 pinned 渲染 5。
5. **`COST_SCALE` 只能往上调**：`capped: true` 写进了记录，而 `COST_SCALE` 不进 device 串、改它不会重测。调小系数撤不掉已经写下的 `capped`（`pipelinePlan.mjs:108`）。pinned 渲染 5 的「不改代码就能调」只成立一半。
6. **pinned 渲染 2 与渲染 5 字面冲突，代码取了渲染 5**：direct 卡抽 16 帧（不是 8 帧）取 p90（不是最差）；推帧卡的计时趟 300 帧 / 500 ms 封顶后外推（pinned 原文是「推到最后一帧」「总代价」）。计划层有依据，建议请用户明确确认。任务书 K1 :141 末段还写着 direct「各取 8 次里的最大」，和同节的补抽规则自相矛盾。
7. **C3 的 `reset` / `localRev` / `session` 没有落实**：`readyIndex.reset()` 零调用方；SSE 忽略 `session` / `localRev`；`done` 每个进程只发一次。换项目或改版本时页面收不到 `reset`，旧层会残留。
8. **`cacheable` 没有放行 `sourceDependent`**（`server/card-cache.mjs:66`），隔离工程的依赖链也没做；check 文档没列这一条。
9. **D5 服务端的零碎项没做完**：`streamPool` 只是别名；`/api/frames/yield` 没删；`/api/cards/layout` 的 `503 NO_AGENT_LANE` 没做；锚帧不是「全部 Chrome 一起上」，锚帧 / 本地档两趟不读 `wanted`；F5 的「Agent 未回包请求重发一次」没见到实现。check 文档写的是「已完成」。
10. **R4b-14 探针帧转发**：注释里的 TODO(R6) 已过期；任何一次网络异常都会永久停掉转发；项目刚打开时预渲染侧大概率还没算出 card plan，会回 `202 PLAN_PENDING` 丢帧。探针帧当预渲染存这条实际很可能不生效，check 文档已经标了「未验收」。
11. **单舞台退回时探针静默不跑**：`ProbeGate` 用 `previewMode()` 而不是 `dualStage()` 判断；没有 B iframe 时 `whenStageReady('back')` 永不 resolve，全部卡走声明兜底且没有提示。
12. **小项**：计时趟没有「稳健值越过 B 就停」；`cardCostKey` 剥掉了 `inputs`，依赖变了不重测（pinned 渲染 5 写的是「卡和依赖的身份」）；`wanted` 在 mirror-store 里不会清空；遮罩不挡 window 级键盘快捷键（未实跑）；`frame-pipeline.mjs:93-95` 的 interactive 注释过期；编辑器进程也会应答 `/api/frames/ready`，与注释不符；check.md:78（以及 r2-r7-task.md:39）在写「换成 `` 转义」的地方，字面里本身就是一个 NUL 字符。

---

# 审查员 D 逐项

## 复核 D：R5 播放与追帧、R7 露出舞台、pinned 播放行为（main `f69f229`）

核查方式：只读代码 + `git show` / `git diff`；跑了 9 个单测文件（`server/test/prerender-set.test.mjs`、`server/test/costs.test.mjs`、`src/render/{wirePlan,pipelinePlan,stageRpc,mediaSync,pinAnimations}.test.mjs`、`src/editor/{stageJobs,stageBridge}.test.mjs`），**115 / 115 通过**。没跑探针、没起 dev server、没跑 cargo。
**单测覆盖缺口**：`src/editor/stageSwap.ts`、`src/editor/snapshotFeed.ts`、`src/editor/demote.ts`、`StageView.tsx` 的节拍循环 / K3 / K6、`src/editor/previewMode.ts` 都**没有任何单测**；R5 的行为只有 `scripts/probes/playback-probe.mjs`（探针，我没跑）兜着。

---

## R5 播放与追帧

### R5-1 K4 节拍器：`play` 起循环、每拍 `advanceTo(step = 1000/fps)`、真 rAF、补一拍落定、post `frame`
- 计划要求：r2-r7-task.md:157（K4）；render_pipeline_restructure.md:107
- check 文档声称：已完成；24/25/30/60 fps 各播 10 秒 frame 间隔均值 ±0.04 ms（Agent 自报）
- 核查证据：`src/StageView.tsx:1071-1150` `runBeatLoop`：`clock.advanceTo(sec*1000,{step: period})`（:1098）→ `realRafOrAfter`（:1107）→ `clock.tick`+`pinner.sync`（:1114-1115）→ post 前再查角色（:1119）→ `postStageEvent frame`（:1126）；`play()` 只对 `front` 起、立即回 `{ok,stoppedAt}`（:1527-1548）。提交 `d42746f`、`9d1490d`（被节流 iframe 不再挂死：`realRafOrAfter` 超时 + `RAF_MISS_GIVEUP`，:125-135）。
- 结论：已完成（代码）；间隔数值无法独立验证
- 差异或问题：「被节流 iframe」兜底会让拍长按 4 ms 宏任务跑，属于计划外补丁，记录即可。

### R5-2 K4 绝对时刻排程、慢帧整体后移不跳帧
- 计划要求：r2-r7-task.md:157；render_pipeline_restructure.md:107
- check 文档声称：已完成；「慢帧后移」按这一拍的活超时判
- 核查证据：`src/StageView.tsx:1133-1143`：`nextDue = playStart + n*period`，`workEnd > nextDue` 时 `playStart += workEnd - nextDue`，否则循环 `await realRafOrAfter` 直到 `nextDue − 1 ms`（`BEAT_SLACK_MS`=1，:80）；拍序号按帧格算 `sec = (fromFrame+n)/fps`（:1082、:1089），sec 差恒为 1/fps。
- 结论：已完成
- 差异或问题：无

### R5-3 K4 播放到头 `ended` 与收尾（写 store → setPlaying(false) → pause() 拿 stoppedAt → setTime(settle)）
- 计划要求：r2-r7-task.md:157、:119（ended）；render_pipeline_restructure.md:108
- check 文档声称：已完成；`ended.sec = 2`、`store.t = duration`、循环自停
- 核查证据：舞台 `src/StageView.tsx:1090-1091`、`:1122-1125`（到头 sec = duration、post `ended`、break）；父页 `src/editor/Preview.tsx:500-509`（`actions.pause()` + `seek(e.sec)`），后续三步由 `Preview.tsx:684-716` 的 `playing` effect 统一做（`s.pause()` → `setTime(stoppedAt,{settle:true})`）。
- 结论：已完成
- 差异或问题：同 R5-4——`playing` 翻 false 时 `Preview.tsx:659-667` 那个 effect 也会先按 `store.t` 发一次 `setTime(settle)`，到头场景下两次都是 duration，无害但重复启动 K5。

### R5-4 K4 暂停：以舞台 `stoppedAt` 为准发 `setTime(stoppedAt,{settle:true})`，不用 `store.t`；发 pause 处同步清 `lastRenderKey`
- 计划要求：r2-r7-task.md:119（「不用 store.t……会走向后跳路径、全场 stateful 卡重挂载」）、:126（E6 清 lastRenderKey）、:158
- check 文档声称：已完成
- 核查证据：`Preview.tsx:701-715` 确实用 `pause()` 回包的 `stoppedAt` 发 settle 并清 `lastRenderKey`。**但** `Preview.tsx:659-667` 的 `setTime` effect 依赖含 `playing`：暂停那一次提交里它先于 :684 的 effect 运行，`lastRenderKey` 仍是播放前的旧值（播放中该 effect 直接 return、从不更新 key），于是先按 **`store.t`** 发一次 `sendSetTime(t,{settle:true})`；:704 的「同步清空」发生在它之后，不起作用。
- 结论：部分完成
- 差异或问题：违反 E0「不用 store.t」。`store.t` 若比舞台落后一拍，这次 setTime 走向后跳路径（`routeJump` backwards → 重挂载 (a′)/(a) 卡、`.pc-settling` 隐身一瞬），随后 `stoppedAt` 那次再前进一帧；两次都带 settle，K5 追帧 / `runSettleSwap` 被启动两次（第二次被 `running` 挡掉）。另外 `setTime` 可能在节拍循环还在走本拍时到达（pause 的回包要等本拍结束）。需实测确认是否可见，但与计划原文不符是确定的。

### R5-5 `PlayReply` 统一与武装停 `pause({atSec})`（passed / 等号算过 / 循环已停立即回）
- 计划要求：r2-r7-task.md:119（play/pause 条）、render_pipeline_restructure.md:106
- check 文档声称：已完成
- 核查证据：`src/StageView.tsx:1558-1586`：循环已停立即回 `stoppedAt`（:1561）；`beatLastFrame >= frame` 回 `{passed:true}`（:1564，按帧号比）；只保留最后一次武装（:1566-1571）；真 setTimeout 5 s 兜底（:1574-1578）；循环里 `beatLastFrame >= armed.frame` 就 break（:1130-1131）；`settleBeatWaiters` 保证所有挂着的 RPC 必回包（:1034-1045）。`src/render/stageRpc.test.mjs` 通过。
- 结论：已完成
- 差异或问题：无

### R5-6 K4 `mediaStalled`：相邻 `frame` 到达间隔 > 40 ms 暂停音频与 `<video>`，恢复时对齐（pinned 架构 10）
- 计划要求：r2-r7-task.md:157；pinned 架构 10
- check 文档声称：未单列，R5 报告只报了拍间隔
- 核查证据：`Preview.tsx:344`（`MEDIA_STALL_MS = 40`）、`:472-498`（**收到下一条 frame 时**才算 `now - prev > 40`）、`:742` / `:953`（舞台素材层与主文档音频都用 `playing && !mediaStalled`）。`playback-probe.mjs` / `reveal-probe.mjs` 里 grep 不到任何对 `mediaStalled` 的断言。
- 结论：部分完成（通道接好了，判据有两处问题）
- 差异或问题：
  1. **24 / 25 fps 下会每隔一拍误判卡顿**。K4 在 60 Hz 屏上把 24 / 25 fps 排成 33.3 / 50 ms 交替（`StageView.tsx:1063-1064` 的注释自己也这么说），50 ms > 40 ms ⇒ `mediaStalled` 每拍翻一次，音频与视频每 ~80 ms 暂停 / 恢复一次并触发 `planSync` 的暂停分支 seek。按 pinned「阈值固定 40 ms」照做，这是结构性冲突，没有任何探针覆盖。30 fps 下偶发丢一次 vsync（50 ms）也会触发。
  2. **判据是事后的**：只有迟到的那条 `frame` 到了才置 stalled，停顿进行中音频照播；置位后下一拍准时就恢复。实际效果是「停顿结束后再停一拍」，不是 pinned 说的「停顿超过约 40 ms 就暂停音频」。计划 K4 原文也是这么写的，属于计划本身没落实 pinned 的意图，需要用户定：要不要加一个播放中 40 ms 看门狗定时器、24/25 fps 怎么办。

### R5-7 E6：非 legacy 下 `Preview` 的 rAF 播放循环不启动；`refreshRects` 播放中改 500 ms 定时器
- 计划要求：r2-r7-task.md:126；render_pipeline_restructure.md:109
- check 文档声称：已完成（R7 验了 store.t 3 秒推进 3.000 秒）
- 核查证据：`Preview.tsx:149`（`if (dual) return;`）、`:662`（播放中不发 setTime）、`:670-674`（500 ms `setInterval`）、`refreshRects` 用 `rectsGen` 丢过期回包（:547-564）。
- 结论：已完成
- 差异或问题：判据是 `dual` 不是 `previewMode()`，R7 更正已写明，一致。

### R5-8 K3(a′)：`seekOk` 且 `seekMs ≤ B` 直接定位；向后跳先走重挂载定位配方
- 计划要求：r2-r7-task.md:156
- check 文档声称：已完成；跳 50 s 不重挂载、55→20 s 重挂载恰好 1 次（Agent 自报）
- 核查证据：`StageView.tsx:754-763`（向前什么都不做——全局 `setTime` 已 `clock.set`+`pinner.sync`；向后 `remountClipRecipe` → `syncIn(wrap, targetMs)`）；配方 `:544-558`（`resetIn` → remountGen++ → flushSync → `tick(clock.now())` 两次 → `syncIn(mountMs)`）；档位由 `clipWeight` 共享纯函数给（:698-702）。提交 `7f48d23`。
- 结论：已完成（代码）；探针结果无法独立验证
- 差异或问题：无

### R5-9 K3(a)：`catchUpMs ≤ B` 的卡，连续路 / 向后或远跳按片段重推（帧间只让微任务，墙钟兜底改走 (b)，拖动中 100 ms 节流）
- 计划要求：r2-r7-task.md:156（(a) 段）、:122（E3 节流）
- check 文档声称：已完成
- 核查证据：连续路 `StageView.tsx:1239-1247`；远跳 / 向后 `:764-769` → `startCatchUp` + `runCatchUpSync(task, 1000/fps)`（:631-642，微任务让出、超预算转 `runCatchUpAsync`）；节流 `repushAllowed`（:705-711，只在 scrubbing 时）。
- 结论：部分完成
- 差异或问题：
  1. **(a) 的重推用的是子树虚拟时间（`syncIn` + `settling` 表），不看 `vtOk`**。计划 (a) 写的是「按片段重挂载并从 mountFrameOf 用 `advanceToAsync` 推到目标」，K3 只在 (b) 才按 `vtOk` 分两路。对 `vtOk = false`、`catchUpMs ≤ B` 的短 Motion JS 卡（读全局帧时间戳），子树时间推不动它，向后跳 / 远跳之后停在初始态，也没人把它交给第二路 —— 暂停态不是精确活渲（违背 pinned 架构 9），需实测确认。
  2. 计划要求推完「再调 settle 补一拍落定」；`advanceCatchUp` / `endCatchUp`（:573-612）没有补这一拍。

### R5-10 K3(b) `vtOk` 轻卡：跳转 / 拖动在可见舞台里追；播放中进入时每拍多推 4 步
- 计划要求：r2-r7-task.md:156（(b) 前半）
- check 文档声称：已完成
- 核查证据：跳转 `StageView.tsx:770-775`（`runCatchUpAsync`，每 8 步让宏任务，:618-624）；播放 `enterCatchUps`（:783-796，只对「刚进入」的 `catchup-b` + `vtOk` 轻卡）+ `stepCatchUps`（:669-678，`CATCHUP_STEPS_PER_BEAT`，目标跟播放头走）；追帧期间包裹层 `.pc-settling`（`src/render/Stage.tsx:211-224`）。
- 结论：已完成
- 差异或问题：无

### R5-11 K3(b) `vtOk = false` 轻卡的播放态互换（目标拍 T、武装停、passed 重取 T′、两次不行改判重）
- 计划要求：r2-r7-task.md:156（(b) 后半）
- check 文档声称：已完成
- 核查证据：`src/editor/stageSwap.ts:272-316` `runPlayingSwap`：T 取整到拍格（:283）、`catchUpBack` 做 (1)(2)(3)（:185-202）、武装后 `passed` 重取 T′ 并续推不带 jump（:291-303）、等 `frame(T)` 再 `swapAndDress(target, true)`（先 setPlan/setSuppressed/setSnapshots(reset)… 再 `play(T)`，:222-231）；等待期间进 `suppressed`（`setExtraSuppressed`，:278）。触发点 `Preview.tsx:484-490`。
- 结论：部分完成
- 差异或问题：
  1. **两次都追不上时既不降级、也不留在 suppressed**：`:293` 直接 `return false`，`finally` 里 `setExtraSuppressed([])`（:314）把它放回活渲（状态是错的），`swapTriedRef` 又让这一轮播放不再重试。计划明写「两次仍追不上就改判为重（K6）……死素材就绪前它留在 suppressed（透明），不回到活渲」。
  2. **补跑完成到互换之间，后台舞台不再被补跑占住**：`catchUpBack` 是一个 `runBackJob('catchup')`，返回后 `stageJobs.pump` 立即 `setRole('back',{job:'probe'})` 并可能跑下一个探针（`src/editor/stageJobs.ts:174-198`），探针会 `pushProject` 缩水项目 + `render`，把刚补好的场景冲掉；播放态要等 `frame(T)`，窗口可达几百毫秒。T′ 的续推（`stageSwap.ts:298`）也在队列之外直接发 `render`。
  3. `Preview.tsx:745-752` 每拍对**两个**舞台都发 `setMediaT(store.t)`，会把后台舞台已设的 `mediaT = T` 冲回 `store.t`，与计划「实参都是 T、不是 store.t」相悖（互换时 store.t≈T，偏差不大，但后台视频会在等待期间反复 seek）。

### R5-12 K3(b) `vtOk = false` 轻卡在**暂停 / 跳转 / 拖动**下的处理
- 计划要求：r2-r7-task.md:156（(b)：「按 vtOk 分两路……vtOk = false 的卡：后台舞台整场景补跑后互换（K5 第二路）」）
- check 文档声称：未单列
- 核查证据：舞台 `routeJump` 对它 `continue`（`StageView.tsx:771`，注释「第二路由父页发起」）；父页暂停态只走 `runSettleSwap` → `needsBackCatchUp`，而它只收 **`pipelineAt === 'heavy'`** 的卡（`stageSwap.ts:105-124`）。判轻的 (b) 档 `vtOk=false` 卡在暂停 / 点时间轴后没有任何一方去补。
- 结论：未完成
- 差异或问题：跳转后它停在全局 `clock.set` 给出的错误状态，违背 pinned 架构 9（暂停时精确活渲）。

### R5-13 K3 片段粒度重挂载：`remountGen` 作 key 与传给组件的 `playToken`、`resetIn` 只清本片段锚点
- 计划要求：r2-r7-task.md:156（末段）
- check 文档声称：已完成
- 核查证据：`src/render/Stage.tsx:206-210`、`:266-274`（四支 `playToken={gen}`、`t={localTOf(...)}`）；`src/render/pinAnimations.ts:75`（`resetIn`）、`:79-91`（`sync(skip)`）、`:92`（`syncIn`）；`pinAnimations.test.mjs` 通过。
- 结论：已完成
- 差异或问题：无

### R5-14 K5 第一路：`vtOk` 重卡在可见舞台用子树虚拟时间追，全局 sync 跳过，追完摘平面 post `settled(clipId)`
- 计划要求：r2-r7-task.md:159
- check 文档声称：已完成；`settled` 带 clipId、追完摘类摘快照
- 核查证据：`routeSettle`（`StageView.tsx:718-727`，只挑 heavy + `vtOk === true`）；`skipWrappers`（:290-301）喂 `pinner.sync(…, skip)`；`endCatchUp`（:573-584）追上后从 `snapshots` 删、post `settled`；父页 `noteSettled`（`Preview.tsx:510-513` → `snapshotFeed.ts:132-135`）。
- 结论：已完成
- 差异或问题：能否起跑取决于父页有没有发 `settle: true`，见 R5-16。

### R5-15 K5 第二路：暂停态整场景后台补跑 + 角色互换（(1)～(6) 顺序）
- 计划要求：r2-r7-task.md:160
- check 文档声称：已完成；front A→B、新 front post `settled([])`、连点 10 次恰好互换 1 次
- 核查证据：`stageSwap.ts:185-202`（(1) `runBackJob('catchup')` + `pushProject(reset)`，(2) `render(t,{jump,maxCatchUp:Infinity})`，(3) `setMediaT` + 等 `mediaReady` ≤ 300 ms）、`:205-242`（(4) 先 `swapRoles` 对调 opacity → `oldFront.setRole('back')` → `next.setRole('front')`；(5) `sendPlanTo` / `setLocalHashes` / `setSnapshots({}, reset)` / `setPlaying(false)` / `setScrubbing(false)` / `setProxy`）；(6) 舞台侧 `StageView.tsx:1483-1502`。`Preview.tsx:413-434` 的 `swapRoles` 在一次 flushSync 里换 `frontId` 并重登记两个角色。
- 结论：部分完成
- 差异或问题：
  1. **连点时后面的点击被丢**：`runSettleSwap` 在 `running` 时直接 `return false`（`stageSwap.ts:249`），不排队；进行中那次补完发现 `t` 变了也放弃（:257）。真实地连点（间隔小于一次补跑的几百毫秒），**最后一次点击的位置永远不互换**，判重的 `vtOk=false` 卡停在快照上。探针的「连点 10 次」是在一个 `page.evaluate` 里同步 `seek` 10 次（`playback-probe.mjs:410-412`），React 批成一次提交、实际只发了一次 `setTime`，没有测到这条路。
  2. 同 R5-11 第 2 条：补跑 job 结束到互换之间，队列可能已把后台交还给探针（暂停态窗口较短，但存在）。

### R5-16 暂停 / 点时间轴 / 拖动松开后发 `setTime(t,{settle:true})`（E3：拖动结束先发最后一次 settle 再 `setScrubbing(false)`）
- 计划要求：r2-r7-task.md:122（E3）、:158；pinned 架构 9
- check 文档声称：已完成（未单列）
- 核查证据：唯一发 settle 的地方是 `Preview.tsx:659-667`（依赖 `t` / `playToken` / `playing`，settle 取决于渲染时的 `scrubbingRef`）和暂停收尾 `:714`。`scrubbing` 不在该 effect 依赖里，也没有别处在 scrub 结束时补发。`src/editor/timeline/useScrub.ts:101`（按下时先 `seek` 再 `beginScrub`，同一个 React 事件里批处理）、`:137-138`（松手时位置没变就不 `seek`，然后 `endScrub`）。
- 结论：部分完成（按暂停 / ControlBar 的跳转按钮会发 settle；时间轴上的点击和拖动松开大概率不发）
- 差异或问题：
  1. **拖动松开**：松手坐标通常等于最后一次 flush 的位置 ⇒ `final === getState().t` ⇒ 不 seek ⇒ `t` 不变 ⇒ effect 不重跑 ⇒ **没有 settle**。
  2. **点击标尺 / RenderBar / 播放头**：`seek` 和 `beginScrub` 在同一个 `onPointerDown` 里，React 18 批成一次渲染，此时 `scrubbing = true` ⇒ 发出的是不带 settle 的 setTime；松手位置不变 ⇒ 不再补发。
  两种情况下判重卡停在快照 / `.pc-awaiting`，K5 两路都不启动，违背 pinned 架构 9（「用户点击时间轴某时间 / 拖动后松开，所有组件都是精确的活渲染」）。批处理结论基于 `src/store/core.ts:263-264` 的 `useSyncExternalStore` 与 React 18 自动批处理推断，**需实测确认**；没有探针覆盖这条交互（playback-probe 全用 `actions.seek`）。

### R5-17 追帧中止：`catchUpGen` 由 setTime / play / setProject / setRole / 含追帧片段的 setSuppressed 递增
- 计划要求：r2-r7-task.md:161
- check 文档声称：已完成
- 核查证据：`StageView.tsx:1185-1187`（setProject）、`:1234-1236`（setTime）、`:1543-1545`（play）、`:1496`（setRole back）、`:1608-1616`（setSuppressed 只在含追帧片段时递增）；`advanceCatchUp` 每步比对（:594-597）。独立的 `settleGen` 未被复用（:253）。
- 结论：已完成
- 差异或问题：无

### R5-18 K6 舞台侧：1 秒窗口累计超时 > 1/fps 降本窗口实测最贵的轻卡；`pendingDemote` 不计入窗口、不当候选
- 计划要求：r2-r7-task.md:162；pinned 卡片渲染 6
- check 文档声称：已完成；修了「Profiler 恒报 0」「K6 连着降」
- 核查证据：`StageView.tsx:972-1001`（`checkDemote`，只降 `pipelineAt === 'light'`，同分按 clipId 定序）、`:1010-1026`（`noteBeat` 把 pending 那份耗时从本拍超时里扣掉）；每卡耗时改用 `__pcRealNow` 的 `CostMark`（`src/render/FrameScene.tsx:117-132`、`:303-312`）。
- 结论：已完成
- 差异或问题：`StageView.tsx:237` / `:1702` 的注释仍写「`<Profiler>` 报的」，已过期（只是注释）。

### R5-19 K6 父页：整条 PUT `{...旧记录, capped, demoted}`、只用 `demoted`、就绪判据、就绪后下一拍切进 suppressed/snapshots、只降不升
- 计划要求：r2-r7-task.md:162；render_pipeline_restructure.md:117-118
- check 文档声称：已完成；「costs 与落盘各恰好 1 条 capped+demoted」；三条闭环（33 ms 换快照、就绪后切换、重测写回 demoted:false）没验到
- 核查证据：`src/editor/demote.ts:41-64`；就绪判据 `src/editor/snapshotFeed.ts:184-193`（stream 至少一段，或 html/local 从当前本地帧起覆盖 `min(fps, 剩余)` 帧）、`:238-242`（未就绪不进 heavy）；舞台侧 `setSuppressed` 把就绪卡移出 pending（`StageView.tsx:1603-1607`）；分派 `src/render/pipelinePlan.mjs:108`（`demoted` 当 capped）；重开探针只跳过 `demoted !== true`（`src/editor/probeRunner.ts:175`），写回 `demoted: false`（:424）。
- 结论：已完成（代码）；预渲染进程侧闭环无法独立验证（check 文档也承认没验）
- 差异或问题：无

### R5-20 预渲染进程的 `prerenderSetOf` 接上真 `planPipelines`（两端同一份纯函数与 costs/tuning）
- 计划要求：r2-r7-task.md:155、:147（通知路）
- check 文档声称：已完成，两端同表有单测
- 核查证据：`server/frame-pipeline.mjs:13`、`:919-920`；`server/prerender-set.mjs`；`server/test/prerender-set.test.mjs`、`src/render/wirePlan.test.mjs` 本次通过。提交 `bfbf59d`。
- 结论：已完成
- 差异或问题：无

### R5-21 `setRole('back')` 清理全集与转正 post `settled([])`
- 计划要求：r2-r7-task.md:119（setRole 条）、:160 (6)
- check 文档声称：已完成
- 核查证据：`StageView.tsx:1473-1504`（停节拍、清 snapshots/suppressed/streamPlanes/settling/catchUps/awaiting、catchUpGen++、一次提交；`wasBack` 判据转正时 post `settled`）。
- 结论：已完成
- 差异或问题：streamPlayer 那条是 R8，按计划跳过。

---

## R7 露出舞台

### R7-1 摘掉 `front` 的 `opacity: 0`，`back` 仍 `opacity:0; pointer-events:none`
- 计划要求：r2-r7-task.md:105；R7 更正 :33
- check 文档声称：已完成（提交 `1bc1fd4`）
- 核查证据：`src/editor/Preview.tsx:981`（`opacity: dual && frontId === "A" ? 1 : 0`）、`:1010`（B 同理），后台 `pointerEvents: none`；没有 `display:none` / `visibility:hidden`。
- 结论：已完成
- 差异或问题：无

### R7-2 整帧 `<img>` / `MovPlayer` 只留 legacy 分支
- 计划要求：r2-r7-task.md:105
- check 文档声称：已完成
- 核查证据：`Preview.tsx:1022`（`{!dual && <UnifiedPreview … />}`）；主文档 `MediaLayers` 只 `audioOnly`（:953）。
- 结论：已完成
- 差异或问题：无

### R7-3 删主文档 `mediaRects`（连 legacy 一起）
- 计划要求：r2-r7-task.md:102（D3 第 4 步）、R7 更正 :34
- check 文档声称：已完成；已知代价 legacy 下点素材段选不中
- 核查证据：`git diff e5a873c^1 e5a873c -- src/editor/Preview.tsx` 删掉整个 `useCallback` 及两处调用；现 `Preview.tsx:532-539` 只剩注释，`refreshRects` / `hitAt`（:548-592）只走舞台。
- 结论：已完成
- 差异或问题：legacy 回滚路因此丢了素材段命中，check 文档已如实写。

### R7-4 非 legacy 下不启动 `Preview` 的 rAF 播放循环
- 计划要求：render_pipeline_restructure.md:246；r2-r7-task.md:126
- check 文档声称：已完成
- 核查证据：`Preview.tsx:149`。
- 结论：已完成
- 差异或问题：无

### R7-5 开关翻转：`previewMode()` 缺省 stage，只有 `?preview=legacy` 回老路
- 计划要求：render_pipeline_restructure.md:246；r2-r7-task.md:53
- check 文档声称：已完成，单独提交 `9b88e9b`
- 核查证据：`src/editor/previewMode.ts:37-39`；`git log` 有 `9b88e9b 翻开关:previewMode() 的缺省从 legacy 改成 stage`。
- 结论：已完成
- 差异或问题：无

### R7-6 `?preview=legacy` 回滚（合并 StageView 的同名 `LEGACY` 开关、前端整帧 + 服务端旧调度器、舞台 opacity:0 / placeholder / 不投快照）
- 计划要求：r2-r7-task.md:110、:167（F2）
- check 文档声称：已完成；回滚路只验了结构等价
- 核查证据：legacy 时 `dualStage()` 为 false ⇒ 单舞台 opacity 0、`UnifiedPreview`、rAF 循环、`pumpFeed` 不投（`Preview.tsx:372`）。但 `stageSrc`（`previewMode.ts:81-85`）**从不把 `preview=legacy` 传进 iframe**，所以 `StageView.tsx:63` 的 `LEGACY`（setProject 立即按跳转重算）在编辑器里永远不生效 —— `previewMode.ts:13-16` 的注释明说这是有意的。
- 结论：部分完成
- 差异或问题：D5 要求「合并已有的同名开关……legacy 下两件事都生效」，实际没合并。legacy 下舞台只作命中 / 实体框用，改项目后在下一次 `setTime` 前舞台 DOM 是旧状态；影响小，但与计划不符、check 文档没提。

### R7-7 D5 的其余原子项：同源退回删除、`frameClient` 缺省 `target:"prerender"`、编辑器进程 `interactive:false`、`/api/frames/yield` 删除、`MAX_RESTARTS` 超限界面明示
- 计划要求：r2-r7-task.md:107-108
- check 文档声称：已完成（D5 同源退回删除、不养热 Chrome）
- 核查证据：`src/render/prerender.ts`（抛 `PRERENDER_UNAVAILABLE`，`usePrerenderBase(): string | null`）、`src/render/frameClient.ts:95`、`server/vite-plugin-frames.ts:43`（`interactive: isPrerender`）、`src/render/snapshotSource.ts:128`（拿不到源就退避不连）、`ToolVisual.tsx` / `OpDetailPreview.tsx` 明示。提交 `d191bc5`。**`/api/frames/yield` 仍在**：`server/vite-plugin-frames.ts:93`、`:103`（`borrow`/`release` 仍打它）、`:302`（路由）。**`MAX_RESTARTS` 超限没有任何界面提示**：只在 `server/vite-plugin-prerender.ts:26`、`:135-137`，`src/` 里 grep 不到。
- 结论：部分完成
- 差异或问题：`/yield` 删除、重启超限界面明示两条没做，check 文档没列为「没做」。

### R7-8 桌面壳：端口预检加查 5211 / 5212（只警告不拦）、`smoke-boot` 等两个舞台端口
- 计划要求：r2-r7-task.md:22、R7 更正 :37
- check 文档声称：已完成；`cargo check` 通过；没真构建、没真跑
- 核查证据：`desktop/src-tauri/src/lib.rs:35`（`STAGE_PORTS`）、`:175-217`（`probe_port_at` / `occupied_stage_ports`）、`:318-345`（非已有实例时查，Warning 弹窗、不 `exit`）；`desktop/scripts/smoke-boot.mjs:114-147`（Step 2b，查 200 + `origin-agent-cluster: ?1`）。提交 `d923330`。
- 结论：已完成（代码）；编译与实跑无法独立验证
- 差异或问题：无

### R7-9 `setRole` 的「不重发」按 `{client, job}` 判
- 计划要求：R7 更正 r2-r7-task.md:38
- check 文档声称：已完成（提交 `d09982d`）
- 核查证据：`src/editor/stageJobs.ts:157-168`；`src/editor/stageJobs.test.mjs` 本次通过。
- 结论：已完成
- 差异或问题：无

### R7-10 总验收（D5 + E + K 合验）+ 零卡顿；探针 `reveal-probe.mjs`
- 计划要求：r2-r7-task.md:53、:181-185
- check 文档声称：12 趟无头全绿，有头 24/30/60 fps 间隔达标、主文档长任务 0；拖动 frame/contentBox 跨模式比对、K6 三条、回滚截图比对、「同时」零卡顿均未验到
- 核查证据：`scripts/probes/reveal-probe.mjs` 存在（提交 `3cd1749`、`36a53ed`），断言覆盖露出 / 两个 iframe target / 无整帧 img / 24·30·60 fps 拍间隔 / 长任务 / hitTest / legacy 回滚（:252-425）。播放只测 `[24, 30, 60]`（:335），25 fps 只在 R5 的 playback-probe 里（:277）。
- 结论：无法独立验证（按要求没跑探针）
- 差异或问题：合验里「拖动松开 / 点时间轴后暂停态精确活渲」「mediaStalled 暂停音频」两条没有探针断言，正是 R5-6 / R5-16 的缺口所在。

### R7-11 翻开关后的播放入口回归：播放头在末尾（或第一张卡之前）按播放
- 计划要求：legacy 循环的行为（`Preview.tsx:155-158`：到头或在内容前按播放 → 从 `contentStart` 开始）；计划只说把 `:145-149`（到头收尾）搬进 K4
- check 文档声称：未提
- 核查证据：非 legacy 下 `Preview.tsx:696` 直接 `s.play(tRef.current)`；舞台 `runBeatLoop` 第一拍 `rawSec >= duration` 就 post `ended` 退出（`StageView.tsx:1089-1091`、`:1122-1125`）。`src/store/actions/playback.ts:15-17` 的 `play()` 不回卷。
- 结论：未完成（回归）
- 差异或问题：R7 把缺省翻成舞台之后，播完再按播放**什么都不播**（立即 ended）；legacy 下会从最早的卡重播。`replay()` 不受影响。

---

## pinned 播放行为

### P-1 音频跟着 t，停顿超过约 40 ms 暂停、恢复时对齐（pinned 架构 10）
- 计划要求：pinned 架构 10；r2-r7-task.md:157
- check 文档声称：未单列
- 核查证据：见 R5-6。主文档音频 `MediaLayers t={t}`（`Preview.tsx:953`），t 来自 `frame` 事件的 `actions.tick`（:477）——「跟着 t」成立；40 ms 判据在 `:492`。
- 结论：部分完成
- 差异或问题：24 / 25 fps 结构性误判（每隔一拍 50 ms）；判据事后生效、停顿期间音频不停。

### P-2 项目选项面板 fps 下拉 24 / 25 / 30 / 60、新项目默认 30（pinned 架构 7）
- 计划要求：pinned 架构 7；r2-r7-task.md:177（约束：`ProjectSettingsDialog.tsx` 加 fps 下拉、同面板加 `glRoute` 下拉、切换后重走 ProbeGate）
- check 文档声称：未提（R4b 写「切 fps 后重走遮罩（R5 做）」，R5 节没再提）
- 核查证据：`src/editor/ProjectSettingsDialog.tsx` 只有项目名 / 画幅比例 / 方向 / 分辨率（:123-177），grep `fps` 零命中；整个 `src/` 没有 fps 下拉（只有 `ToolBar.tsx:51` 显示 fps）；`setProjectMeta` 类型允许 `fps`（`src/store/actions/projectMeta.ts:6`），但没有任何 UI 调它改 fps。默认 30 成立（`src/kernel/project.ts:334`）。`glRoute` 下拉同样没有。探针都是用 `BUILD` 直接写 `fps`。
- 结论：未完成
- 差异或问题：违背 pinned 架构 7；「切 fps 后重走 ProbeGate 遮罩」也就无从验证。这条不归 R5 / R7 的步骤表，但计划「约束」节明写，check 文档没有任何一处记为「没做」。

### P-3 暂停 / 点击时间轴 / 拖动松开后精确活渲（pinned 架构 9）
- 计划要求：pinned 架构 9；r2-r7-task.md:158
- check 文档声称：已完成（「暂停后重卡追到活渲」「播放到头后最后一帧是活渲」）
- 核查证据：按暂停、播放到头、ControlBar 的跳转按钮会发 settle（`Preview.tsx:714`、`:666`）；时间轴点击和拖动松开见 R5-16；判轻 `vtOk=false` 卡见 R5-12、(a) 档 `vtOk=false` 卡见 R5-9；连点丢最后一次见 R5-15。
- 结论：部分完成
- 差异或问题：见上述四条。

---

## 发现的问题汇总

**违背 pinned goal**
1. **fps 下拉没做**（pinned 架构 7）：`ProjectSettingsDialog.tsx` 没有 fps（也没有 `glRoute`），全仓没有改 fps 的 UI。check 文档没记。
2. **24 / 25 fps 下 `mediaStalled` 每隔一拍误触发**（pinned 架构 10 与 K4 排拍冲突）：60 Hz 屏上拍间隔 33 / 50 ms 交替，50 > 40，音频与视频反复暂停 / seek。没有探针覆盖。另外判据是「迟到的帧到了才停」，停顿进行中音频照播。
3. **时间轴点击、拖动松开大概率不发 `settle: true`**（pinned 架构 9）：`Preview.tsx:659-667` 只在 `t` 变时发、settle 取决于渲染时的 scrubbing；`useScrub` 按下时 `seek` 与 `beginScrub` 同批、松手位置不变就不 `seek`。判重卡停在快照上、K5 两路都不启动。需实测确认，但没有探针覆盖。
4. **判轻的 (b) 档 `vtOk=false` 卡在暂停 / 跳转后没人补**（`stageSwap.ts:109` 只收 heavy，舞台 `StageView.tsx:771` 跳过）。
5. **(a) 档不分 `vtOk`**，一律用子树虚拟时间重推（`StageView.tsx:764-769`），短 Motion JS 卡向后 / 远跳后停在初始态。

**代码与计划不符**
6. 暂停时先按 `store.t` 发了一次 `setTime(settle)`（`Preview.tsx:659-667` 先于 :684 运行），违反 E0「用 stoppedAt、不用 store.t」，还让 K5 起两次。
7. K3(b) 播放态互换两次失败后不降级、还把卡放回活渲（`stageSwap.ts:293`、`:314`）。
8. `runSettleSwap` 运行中直接丢弃新请求（`stageSwap.ts:249`），真实连点时最后一次点击不互换；探针的「连点 10 次」在一次 evaluate 里同步 seek，没测到这条路。
9. 补跑 job 结束到互换之间，`stageJobs` 可能把后台交还给探针（`stageJobs.ts:174-198`），缩水项目冲掉补好的场景；T′ 续推在队列外直发 `render`。
10. `setMediaT(store.t)` 每拍广播给两个舞台（`Preview.tsx:745-752`），冲掉后台舞台的 `mediaT = T`。
11. legacy 回滚没合并 StageView 的同名 `LEGACY` 开关（`previewMode.ts:81-85` 不传参数）。
12. D5 的 `/api/frames/yield` 没删（`vite-plugin-frames.ts:93/103/302`），`MAX_RESTARTS` 超限没有界面提示。
13. (a) 重推完没补计划要的「settle 补一拍落定」。

**check 文档说错 / 漏记**
14. R5 写「已完成」，但 R5-9/11/12/15/16 都有未落实的子条；R7 的「D5 同源退回删除」把 `/yield` 删除、重启超限提示两条漏在「没做」之外。
15. fps 下拉（约束节）和 R4b 留给 R5 的「切 fps 后重走遮罩」在 check 文档里无人认领。
16. 「连点 10 次恰好互换 1 次」这条的证据不成立（见第 8 条）。

**回归风险**
17. 翻开关后播放头在末尾按播放立即 `ended`、不重播（legacy 会从 `contentStart` 播），`Preview.tsx:696` + `StageView.tsx:1089-1091`。
18. R5 的核心新模块（`stageSwap.ts`、`snapshotFeed.ts`、`demote.ts`、节拍循环、`previewMode.ts`）零单测，行为只靠没进 CI 的探针；本次跑的 9 个相关单测文件 115/115 通过，但都不覆盖上面这些问题。
19. 注释过期：`StageView.tsx:237`、`:1702` 仍说每卡耗时来自 `<Profiler>`（实际是 `CostMark`）。

---

# 审查员 E 逐项

## 复核报告 E：R8 / R9 / 云端 / 路径表 / 第 7 节决策 / pinned 全局对照

- 仓库：`C:\Users\admin\Documents\PromptCut`，main，HEAD `f69f229`。只读核查，未改任何仓库文件、未起服务、未跑测试。
- 前提：已完整读 `user_pinned_goal.md`（88 行）。计划 = `restructure_planning/render_pipeline_restructure.md`（下称「计划」），自报 = `restructure_planning/render_pipeline_restructure_check.md`（下称「check」）。
- 下文「现在行号」都是 HEAD `f69f229` 上 grep 到的。

---

## 一、R8 轨道流

### R8-0 总判定：R8「未开始」是否属实
- 计划要求：先 G0-b 编码原型，再按 3.5 实现，挂 `streams` 开关（计划:248-249；`r8-streams-task.md` 全文）。
- check 文档声称：R8 未开始；G0-b 已做完，探针 `scripts/probes/stream-*.mjs` 已合并，报告在 `g0-b-stream-prototype.md`，结论已回填分册（check:107-109）。
- 核查证据：
  - 分册里标「新」的文件都不存在：`server/frame-stream.mjs`、`src/render/streamPlayer.ts`（`ls` 报不存在）。
  - 全仓（src/server/desktop）grep `bakeStream|leaseStreamBakery|createStepper|probeEncoders|planStreamSegments|VideoDecoder` 零命中；没有任何名叫 `streams` 的开关或项目 / 设置字段。
  - **R2～R6 已经为 R8 留好的骨架**（不是 R8 本身的实现）：`Stage.tsx:226-227` / `:318-321` 单卡流平面 `<canvas data-pc-stream-plane>`，`:331-335` 组流平面 `[data-pc-group-plane]`（注释写着「R8 之前 `streamPlanes` 恒空」）；RPC `setStreamPlanes`（`stageRpc.ts:234`、`StageView.tsx:1621`）；就绪索引有 `'stream'` 类（`server/ready-index.mjs:44`）；`snapshotFeed.ts:24-25` / `:44` / `:185` 按 stream→html→local 选层；`FramePipeline` 的 `streamPool` 只是 `userPool` 的别名 getter（`frame-pipeline.mjs:136-138`），注释写「那两个方法是 R8 的，这里只留位」（`:130-135`）。
  - G0-b 探针合并：`a98d3a5 合并:轨道流编码原型的探针(G0-b;只新增 scripts/probes/stream-*)`；`scripts/probes/` 下有 `stream-alpha-quality / cadence / common / crop-rect / decode-throughput / demux-browser.js / encoder-params / fmp4-split / material / roundtrip / sparse` 共 11 个。报告进仓：`19557ce`；回填：`345885d 文档:R8 分册回填轨道流编码原型(G0-b)的结论`。
- 结论：**未开始**（属实；只有前序步骤留的接口位）。G0-b 原型：**已完成**（五项子测里 nvenc 二选一、壳内复测、motion 卡裁剪对比、组流、clip 截图省时 5 项没做成，报告 `g0-b-stream-prototype.md:476-484` 如实列出）。
- 差异或问题：回填**不完全**，见 R8-11。

下面逐条列 R8 分册的子任务（出处都是 `restructure_planning/r8-streams-task.md`）。

### R8-1 G0-a 桌面壳准入探针
- 计划要求：WebView2 硬解、毛玻璃、OAC 隔离三项（:37-41）。
- check 文档声称：R0 第 1 条已做（`5157f91`）。
- 核查证据：`git show --stat 5157f91` 含 `videodecoder-probe.mjs` / `probe-connect.mjs`（新）、`backdrop-probe.mjs` / `oac-probe.mjs`（改）和报告；报告 `g0-a-webview2-probe.md:5` / `:164`「三项全过」。
- 结论：已完成（报告数据无法独立复验，本次不跑探针）。
- 差异或问题：无。

### R8-2 G0-b 编码原型（(4)(5)(6)(7)(8)(9)(10)）
- 计划要求：(4) 解码吞吐、(5) 编码耗时 / alpha 误差 / 色差、(6) 出帧节奏、(7) 编码器参数、(8) 稀疏码率、(10) 裁剪矩形（:43-52）。
- check 文档声称：已做完；没做成 nvenc 二选一、壳内复测、motion 卡裁剪对比、组流（check:109）。
- 核查证据：报告进度表 `g0-b-stream-prototype.md:9-19` 七项 done；「没做成的项」`:476-484` 列 5 条（比 check 多一条：`captureFrame` 带 `clip` 的实际省时没单独量）。探针见 R8-0。
- 结论：已完成（带 5 项留白）。
- 差异或问题：check 漏记第 5 条留白（`clip` 截图省时未量）。原始数据 JSON 未进仓（报告 `:3` 自述）。

### R8-3 G1 流的划分、裁剪矩形（实测实体框并集、外扩偶数）、组流与组流平面命中
- 计划要求：一流一卡、实体框并集、偶数外扩、超预算合并组流；组流平面 `pointer-events:none`，`solid.ts` 平面排除名单加 `data-pc-group-plane`（:67-85）。
- check 文档声称：R8 未开始。
- 核查证据：组流平面已由 R3 渲出（`Stage.tsx:331-335`），但**没有** `pointer-events: none`（style 只有 position/inset/size/zIndex）；`solid.ts:197` 排除名单仍只有 `data-pc-proxy-plane` / `data-pc-snapshot-plane` / `data-pc-stream-plane` 三条；`planeStyle.ts:28` 同样没有 group-plane。无任何矩形计算 / 组流合并代码。
- 结论：未开始（骨架有，命中 / 实体框这两处 R8 要改的点都还没改）。
- 差异或问题：无（与「未开始」一致）；提醒实现者 `planeStyle.ts:28` 也要加，分册只点了 `solid.ts:197`。

### R8-4 G2 分段（15 帧 fMP4、Node 端切 init / moof+mdat、丢 mfra、稀疏 stride）
- 计划要求：:87-95。
- check 文档声称：未开始。
- 核查证据：产品代码无 fMP4 切分；只在探针 `scripts/probes/stream-fmp4-split.mjs` 里有原型。
- 结论：未开始。
- 差异或问题：`stride` 可取值（15 的因数）仍是计划第 7 节「未定」第 3 条。

### R8-5 G3 编码（公共命令、编码器参数表、`probeEncoders()`）
- 计划要求：:97-130。
- 核查证据：`server/bakery/ffmpeg.mjs` 只有 `findFfmpeg`；无 `probeEncoders`。
- 结论：未开始。
- 差异或问题：参数表（:123-128）没有 G0-b 建议新增的 `h264_mf` 行（见 R8-11）。

### R8-6 G4 调度（`frame-stream.mjs`、`createStepper`、`bakeStream`、`leaseStreamBakery` / `returnStreamBakery`、隔离工程流版本、`captureFrame` 加 `clip`、`planStreamSegments`）
- 计划要求：:132-152。
- 核查证据：`bake.mjs` 里 `step` 仍是 `bakeFrames` 内部闭包（现在 `:146`）、`warmUp` 在 `:210`；`capture-frame.mjs:18` 的 `captureFrame(bakery, screenshot, signal, { prime })` 无 `clip`；`isolatedCardProject` 只有单卡版（`frame-pipeline.mjs:1138`）。
- 结论：未开始。
- 差异或问题：分册的行号已漂移（分册写 `step :125` / `warmUp :189` / `onFrame :309` / `acquireUser :256` / `acquire :195` / `isolatedCardProject :855`，现在分别是 `:146` / `:210` / `:331` / `:311` / `:248` / `:1138`）。分册自称「在 `048074c` 上逐条核过」，R2～R7 合并后已过期，动工时以符号为准。

### R8-7 G5 浏览器端解码与合成（`streamPlayer.ts`、`VideoDecoder`、着色器钳位、≤8 帧 / ≤80 MB）
- 计划要求：:154-162。
- 核查证据：`src/render/streamPlayer.ts` 不存在；src 下无 `VideoDecoder` 使用。
- 结论：未开始。
- 差异或问题：无。

### R8-8 G6 校验与替换（分段签名、`localRev` 变化重产、旧文件 5 秒后删）
- 计划要求：:164-166。
- 结论：未开始（无代码）。
- 差异或问题：无。

### R8-9 G7 不做 MSE / `<video>` 回退
- 结论：按决定不做。
- 差异或问题：无。

### R8-10 `streams` 开关默认开 + 生产限速 + 「预渲染中」提示
- 计划要求：计划第 7 节已定第 8 条（计划:281）；分册 G0-b 结论 1（:56）：默认开、空闲才产、`streamPool=1`（最多 2）、先稀疏后补密、界面有「预渲染中」状态。
- check 文档声称：已定事项「全部已落地或已写进分册」（check:125）。
- 核查证据：已写进分册；代码里无开关、无提示。另：`frame-pipeline.mjs:89-90` 注释仍写 `streamPool`「大小是 G0-b 的输出参数，初值 2」，`userPoolSize = 2`（`:126`），与 G0-b 定的「建议 1、最多 2」不一致。
- 结论：未开始（已写进分册）。
- 差异或问题：`frame-pipeline.mjs:89` 注释与 G0-b 结论矛盾（小问题，R8 动工时改）。

### R8-11 G0-b 结论回填分册的完整度
- 计划要求：报告 `g0-b-stream-prototype.md:454-474` 列了 15 条「任务书 G 节要按实测改的句子」。
- check 文档声称：结论已回填 `r8-streams-task.md`（check:109）。
- 核查证据（逐条对照分册）：
  - 已回填到正文：1 `out_range=tv`（:108 / :119）、2 着色器钳位（:160）、3 单解码器 ≤8 帧（:162）、4 N=6（:73 / :85）、7 实测实体框并集（:71）、10 stride 不省编码墙钟（:93）、11 ≤1.0 倍（:186）、12 只看平均值（:186）、13 ≤512 KB（:186）、14 带前提的 300 ms（:186）。
  - **只进了「G0-b 结论」汇总段、正文没改**：5 `h264_mf` 行与「只收 nv12」——G3 参数表 :123-128 没有这一行（只在 :59 提到）；8 `firstMs` 加约 80 ms 固定开销——G4 公式 :146 没改（只在 :62）；9 可行性条件必须用「有编码器在跑时」的 `frameMs`——G4 :150 没写（只在 :62）；15 `codec` 串都是举例——G5 :156 仍写「真实 SPS 会是 `avc1.640033`」（:63 写了是举例）。
  - 另有过期句：分册 :24「G0-b 编码原型（另一个 worktree 在跑）。原型没定稿不动工」——原型已完成。
- 结论：部分完成。
- 差异或问题：汇总段与正文不一致 4 处 + 1 处过期状态句；实现者若只读 G3 / G4 / G5 正文会拿到旧口径。

### R8-12 计划正文里指向 R8 的交叉引用
- 计划要求：计划:249「是否现在做，见第 7 节第 1 条」。
- 核查证据：计划第 7 节「还没定的」第 1 条（:268）是「四份分册要不要独立审查」，与 R8 是否现在做无关；「轨道流原型现在就做」在「已定的」第 6 条（:279）。
- 结论：——（文档问题）
- 差异或问题：交叉引用指错条目。

---

## 二、R9 共享 WebGL 渲染器

### R9-0 总判定
- 计划要求：先 `gl-atlas-probe.mjs`，再按 3.6 做两条路线，迁移 `scene-3d` 和三张用户卡（计划:251-252）。
- check 文档声称：未开始；分册就绪（含 M7）；`gl-atlas-probe.mjs` 未写（check:111-113）。
- 核查证据：`scripts/probes/gl-atlas-probe.mjs` 不存在；`src/render/gl/` 目录不存在；全仓 grep `data-pc-gl-plane` 只在 `server/snapshot-store.mjs:56` 一处注释；`createGlHost` / `glWorker` / `.gl.ts` / `fragmentOnly` 零命中；`scene-3d.tsx:152` 仍自建 `new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true })`；`pixelMapGl.ts:90` 仍自己 `getContext("webgl2")`。
- 已有的前置（R2 / R4 留的）：宿主能力 `offscreenGl` / `lowMemory` 探测（`stageRpc.ts:426-436`）；`resolveGlRoute` + `device` 串含 `glRoute`（`src/render/costDevice.mjs:41-67`，单测 `costDevice.test.mjs:50-57`）；离线探针 `--gl-route`（`scripts/probe-card-costs.mjs:116` / `:430`）；`stageId` 已是 `A` / `B`（`previewMode.ts:81`、`stageRpc.ts:439` 缺省 `"A"`）。
- 结论：**未开始**（属实）。
- 差异或问题：分册 M2 仍写「今天的落地口径不满足这一条……`stageRpc.ts:330` 的 `q.get("id") || "front"`，`Preview.tsx:607` 写死 `id=front`」（r9:71），R2 已把它做掉，这段是过期描述；行号 `stageRpc.ts:322/:329/:330`、`StageView.tsx:585` 已漂到 `:426-439` / `:1668`。

### R9-1 `gl-atlas-probe.mjs`（MSAA FBO → blit → createImageBitmap 两路线、20 卡每拍主线程耗时）
- 计划要求：r9:25 / :127 / :180。
- 核查证据：文件不存在。
- 结论：未开始。
- 差异或问题：无。

### R9-2 M1 契约（`CardDef.canvas` + `<id>.gl.ts` + `programs.ts` 注册表；gl / three / 2d / dom2d）
- 核查证据：`src/kernel` 无 `canvas?:` 字段；无 `.gl.ts`、无 `src/render/gl/programs.ts`。
- 结论：未开始。

### R9-3 M2 共享 Worker / 上下文、路线 1（perDocument）、路线 2（shared，MessageChannel 转端口）、图集打包、并行编译缓存、纹理一次上传、能力退路、低内存档
- 核查证据：无 `glHost.ts` / `glWorker.ts`；无 `gl-port` 消息；只有能力判据（见 R9-0）。
- 结论：未开始。

### R9-4 项目选项 `glRoute` 切换
- 计划要求：`Project` 加 `glRoute?`，项目选项面板加下拉，切换重建 `glHost` 并重走 `ProbeGate`（r9:163；r2-r7「约束」第 1 条）。
- 核查证据：`src/kernel/project.ts` 无 `glRoute`；`ProjectSettingsDialog.tsx` 只有项目名 / 画幅比例 / 画幅方向 / 分辨率；`probeRunner.ts:133` 和 `probe-card-costs.mjs:204` 都是 `resolveGlRoute(null, lowMemory)`（不读项目值）。
- 结论：未开始（`device` 串一侧的准备已做）。

### R9-5 M3 节拍协议（beat / done、六步顺序、导出页 useLayoutEffect 领帧票）
- 核查证据：无 `beat` / `done` 的 GL 消息；`beginFrameWork('gl')` 未出现。
- 结论：未开始。

### R9-6 M4 探针与分派（`beat→done` 往返 + GPU 时间计入 `stepMs`、`data-pc-gl-frame` 与 `rasterizeCanvas` 的 lossy 判据）
- 结论：未开始。

### R9-7 M5 迁移 `scene-3d` 与三张 runtime 用户卡；粒子卡走 `dom2d` 不迁
- 核查证据：`scene-3d.tsx:152` 未改；`src/cards/user/` 下没有 `logo-3d-9tian` 等三张卡（本次未进 `%LOCALAPPDATA%` 看）。
- 结论：未开始；粒子卡「不迁」按决定不做。

### R9-8 M6 uber-shader
- 结论：按决定不做（只留 `fragmentOnly` 声明位——声明位本身也还没留）。

### R9-9 M7 像素映射上下文并进共享渲染器
- 核查证据：`pixelMapGl.ts:90` 自持 WebGL2 上下文、`:197` `bitmaprenderer`——即 R1b 的现状。
- 结论：未开始（依赖 R9 本体）。

---

## 三、云端那一半（`cloud-task.md`）

### CLOUD-0 总判定：「未开始」是否属实、已有什么
- 计划要求：旧第 5～10 步（cloud-task.md:20-33 分步表）。
- check 文档声称：未开始，分册就绪，文末 6 问动工前定（check:119-121）。
- 核查证据：src/server/desktop 全仓 grep `WebSocket|docservice|projectRev|cardRev|PROMPTCUT_PRERENDER_MODE|PROMPTCUT_PRERENDER_SPLIT|uploaded|content.put|message_ignore|NO_AGENT_LANE|IndexedDB` —— 命中的只有 vite HMR 的 WebSocket 代理（`vite-plugin-stage-ports.ts:30/:69`）、bakery 里 mock 掉的 WebSocket（`chrome.mjs:88-93`）、Chrome 进程崩溃信息里的 DevTools WebSocket，**没有一条是文档服务 / 云端的实现**。`server/vite-plugin-docservice.ts` 不存在。
- **已经有的（早先各步做的，与云端相关）**：
  - 本地内容库按 sha256 寻址：`storeMediaStream`（`vite-plugin-media.ts:235`，边落盘边算哈希）、`/@media/<hash>` 路由含 Range/206（`:417-430`）、`GET /api/media/local?hashes=`（`:485`）。
  - 素材字段：`MediaAsset.hash / ext / size / pending / tiers`（`src/kernel/project.ts:115-151`），`tiers` 注释明写「眼下不产、不换档」（`:150`）。
  - `playbackUrl` 占位（`src/render/mediaTier.ts:18-23`，参数形状已定，`localHashes` 被 `void` 掉，带 `TODO(A1 第 5 步)`）。
  - `.procp` 离线交换包（`src/editor/io/procp.ts`，`:239` 调 `/api/media/local`）。
  - 镜像插件 `vite-plugin-mirror.ts` + `mirror-store.mjs`（A7）；快照两档目录 `snapshot-store.mjs`（A3a）；超限帧兜底（`snapshot-store.mjs:82` 起）。
  - 预渲染进程（第二个 vite，`PROMPTCUT_ROLE=prerender`，`server/render-role.mjs`、`vite-plugin-prerender.ts:109-117`），里面有 `user` / `agent` / `background` 三条 lane（`frame-pipeline.mjs` 的 `laneChains`）——但**没有** `user / agent / full` 三种进程模式。
  - 舞台 RPC 的 `setLocalHashes`（`stageSwap.ts:221`），但主文档**没有**每 2 秒轮询 `/api/media/local` 的代码（src 里除 `procp.ts:239` 外无调用），`host.localHashes()` 的来源未见。
  - SKILL 模式的 `.proc` 文件锁（`src/editor/io/procLock.ts`，`/api/skill-lock`）——是「两边别同时写」的粗粒度锁，不是 B6 的卡级熔断锁。
- 结论：**未开始**（属实）。
- 差异或问题：无（check 的「未开始」不含「已有雏形」的说明，建议补一句已有的本地内容库 / tiers 字段 / playbackUrl 占位 / .procp / 镜像插件，免得动工时重复造）。

### CLOUD-1 第 5 步 A1 素材上云（`uploaded` 两档、8 MB 分片 PUT、`GET chunks` 断点续传、`POST complete` 校验、逐个素材先小后原、800×600 小版本机转码、原片 faststart 重封装、`playable` 探测）
- 计划要求：cloud-task.md:70-100。
- 核查证据：`project.ts` 无 `uploaded` / `playable`；`uploadMediaFile`（`mediaUpload.ts`）是整件 `POST /api/media/upload/<name>` 到**本机**内容库，没有分片、没有断点续传、没有小版转码。
- 结论：未开始。

### CLOUD-2 A1 拉取与换档（按需拉取、预取队列、`playbackUrl` 按最高已落盘档、槽位级换段、`vite-plugin-frames.ts` / `vision/http.ts` 两处改写）
- 计划要求：cloud-task.md:102-116。
- 核查证据：`mediaTier.ts:18-23` 只回原片；`/@media` 缺文件直接 404，无向云端回源。
- 结论：未开始（占位与端点在）。

### CLOUD-3 A3b 快照块上云 / 下载 + 清单；A5 不上云的卡；A6 卡片源码同步
- 核查证据：无 `snap/<hash>` 上传、无 `snapshot-manifest`、无 `cardRev`。
- 结论：未开始。

### CLOUD-4 第 6 步 文档服务（WebSocket、`out/docservice/<projectId>.ndjson`、`projectRev`、内容库三条消息、`.proc` ack 后写）+ D1 Agent 直写 + D2 按操作收增量 + D4 服务端侧
- 核查证据：无 docservice；Agent 写工具仍经页面 `mcpExecutor.ts` 执行；`MIRRORED_TOOLS` 仍在 `vite-plugin-ai.ts:215`（5 个：`get_project / see_frames / get_gif / bake_card / inspect_card_dom`，`get_layout` 未进表）。
- 结论：未开始。

### CLOUD-5 第 7 步 改动竞态 B0～B6（WebSocket 传输、写入身份、覆盖前备份、最近参与者通知、期望版本、Agent 间消息、互换熔断）
- 核查证据：无相关代码（`agentBus.ts` 有 `agentId` 与改动记录，是页面内的，不是 B1 身份）。
- 结论：未开始。

### CLOUD-6 第 7b 步 Agent 只查询进程 I0～I4（`PROMPTCUT_PRERENDER_MODE=user|agent|full`、`SPLIT=1`、跨平台、Agent 优先的专用 Chrome）
- 核查证据：`vite-plugin-prerender.ts` 只传 `PROMPTCUT_ROLE / CORS_ORIGINS / EDITOR_URL`（`:109-117`）；`worker-pool.ts:6-8` 注释「将来做 Agent 专用 Chrome 优先通道，改的是 `pickWorker` / `spawnWorker`」——未做。
- 结论：未开始。

### CLOUD-7 第 8 步 D3 预渲染部分（`see_frames` 回包附实体矩形）
- 结论：未核到实现，按「未开始」记；归属仍是待定问题 6。

### CLOUD-8 第 9 步 F1 哈希迁移与 GC、F3 离线攒日志、F4 模式切换
- 核查证据：无离线日志、无模式切换；帧缓存 GC（原 F1）也没做（R0 第 3 条冷启动量测未做，check:35）。
- 结论：未开始。

### CLOUD-9 第 10 步 在线浏览器模式 L1～L5（后台 iframe 当预渲染者、IndexedDB 快照库、云端快照进热舞台、无流按拍换快照、merge 回 501 / StreamSource 接口）
- 核查证据：舞台侧对 `job: 'bake'` 明确回 `{ ok:false, reason:'unsupported' }`（`StageView.tsx:1474`）；无 `IdbSnapshotSource`；`snapshotSource.ts` 只有本地 HTTP 实现（R6）。
- 结论：未开始（J3 接口、J4 能力表这类前置已有）。

### CLOUD-10 文末 6 个待定问题（cloud-task.md:458-465，原样列出）
1. A3b 块上传在第 5 步、清单在第 6 步，要不要把整个 A3b 挪到第 6 步。
2. `media[i].playable` 怎么探（`canPlayType` 还是真试放）、探不出默认哪边；以及「原素材（保持原编码）」这一读法要不要写进 `reply_to_users_goal.md` 请用户确认。
3. `uploaded` 改成 `{ small?, original? }`：本地模式下字段不存在还是恒 `undefined`；存 `.proc` 时带不带。
4. `StreamSource` 的 `streamKey` 拼法和索引消息字段要和 R8 定下的命名对齐。
5. L5「在线重型控件渲染服务」的鉴权、计费、并发上限，要不要现在把形状写死。
6. 第 8 步（D3 预渲染部分）归哪一半。
- check 文档声称：未定（check:127）。
- 核查证据：计划 :269 的六问摘要与分册一致。第 2 问里 fold-notes（`r75/fold-notes.md:15`）要求「写进 `reply_to_users_goal.md` 请用户确认读法」——`reply_to_users_goal.md` 最后一次提交是 `b5c65dc`，全文无 `playable` / 「原编码」相关条目，**这件事没做**。另 `reply_to_users_goal.md:9` 还写着旧顺序「小分辨率版先传、原片后传」，和 2026-09-22 改过的 pinned 架构 1「逐个素材先小后原」不一致。
- 结论：未定（属实）。
- 差异或问题：fold-notes 交代的「请用户确认」动作没落到 reply 文件；reply 文件第 1 条已过期。

---

## 四、计划第 4 节路径对照表

### DOC-1 R2～R7 新建文件是否存在、表里是否缺
- 计划要求：第 4 节「解耦之后的路径表」（计划:183-205）。
- check 文档声称：21 个新文件没回填，待补（check:25）。
- 核查证据（`git ls-files` + 在计划:183-206 里 grep 文件名）：
  - check 点名的 21 个**全部存在**、**全部不在表里**：`src/editor/{previewMode,stageJobs,planDispatch,probeRunner,snapshotFeed,stageSwap,demote}.ts`、`src/render/{VideoTrack.tsx,mediaDrive.ts,virtualTimers.ts,pipelinePlan.mjs,pipelineTuning.mjs,wirePlan.ts,snapshotSource.ts,snapshotPick.mjs,costDevice.mjs,snapshotCompare.mjs}`、`server/{ready-index,prerender-set,stage-ports}.mjs`、`server/vite-plugin-stage-ports.ts`。
  - `git diff --name-status 30917d2 HEAD`（src/server，去掉测试）另有 **check 名单也漏掉的**新增 / 改名：`src/editor/ProbeGate.tsx`（+ `.css`）、`src/editor/costIdentity.ts`、`src/render/createSnapshot.ts`、`src/render/snapshot/inlineStyles.ts`、`src/render/snapshot/rasterizeCanvas.ts`、`src/render/snapshot/snapshotStyleProps.mjs`、`src/render/pixelMapGl.ts`、`src/render/planeStyle.ts`、`src/render/probeSummary.mjs`、`src/cards/_probe/{boolean-probe,r6,slow,timers}.tsx`；改名 `src/editor/preview/mediaSync.ts → src/render/mediaSync.ts`；删除 `src/render/snapshotFreeze.ts`。
  - 表下方「没动的」一段（计划:203）仍列 `snapshotFreeze`（R1 已删）和 `frame-pipeline.mjs` 行号 `acquireUser:256 / fillCardControls:799 / isolatedCardProject:855 / rasterPrefix:893 / layout:931 / updatePlayback:1049`、「1155 行」——现在是 `:311 / :1061 / :1138 / :1176 / :1214 / :1332`、1438 行；表中 `src/mcp/common.ts:90 / :97 / :42` 现在是 `frameLayoutOf :103`、`measureContentBoxes :48`。
- 结论：未完成（check 自报属实，且缺口比 check 列的更大）。
- 差异或问题：check 名单漏 11 个新文件 + 1 次搬家 + 1 次删除；表内与「没动的」段落行号已整体过期。

---

## 五、计划第 7 节决策、`future_planning.md`、`g0-a-webview2-probe.md`

### DEC-1 判重只看活渲耗时，生成快照三段单独上报
- 计划要求：计划:274。
- 核查证据：`src/render/pipelinePlan.mjs:101-109`（`stepMs × scale > B` 判重）；`pipelineTuning.mjs:19-27`（`COST_SCALE / STEP_PERCENTILE=0.9 / STEP_MIN_SAMPLES=16`）。
- 结论：已完成（代码层面）。
- 差异或问题：无。

### DEC-2 素材两档（本机转码、逐个素材先小后原、拉取换档）
- 核查证据：已写入 `cloud-task.md:70-100`；代码未做（见 CLOUD-1/2）。
- 结论：已写进分册；实现未开始（属云端那一半）。

### DEC-3 同舞台 canvas 卡共用一个 WebGL 上下文和 Worker，两条路线
- 结论：已写进 r9 分册；实现未开始（R9-0）。

### DEC-4 两张 lottie 不专门处理，超限帧通用兜底
- 核查证据：`server/snapshot-store.mjs:78-124`（DOM 300 KB / canvas 1 MB、`oversize` 诊断环）。
- 结论：已完成（R6）。

### DEC-5 粒子卡不迁 Worker
- 结论：按决定不做（已写进 r8 G1 / r9 M5）。

### DEC-6 G0-b 原型现在做
- 结论：已完成（R8-2）。

### DEC-7 代码注释和文档里的禁用旧词全仓清理
- 计划要求：计划:280「做一次全仓清理（只动注释和文档，字符串字面量只列不改），单独合并」；3.8（计划:157）另定「冻结」这个词以后不用，改叫「生成快照」；memory 规则「用『预渲染』不用『烘焙』」。
- check 文档声称：第 7 节「已定的」全部已落地（check:125）。
- 核查证据：
  - 「烘 / 烘焙」清理已做且单独合并：`57bc227`（src）、`864cc67`（server）、`3307db4`（scripts / desktop/scripts）、`9d00979`（docs），合并 `2802e8b`（63 个文件、471 行）。
  - 用 node 扫 `git ls-files` 的文本文件（md/ts/tsx/mjs/js/rs/css/json/html/txt/py），**只统计不改**：
    - 「烘焙」残留 **8 处 / 4 个文件**：`scripts/archive/export-frames-virtual-time.mjs` 5、`docs/decoupling-plan.md` 1（:245，引号里的用户原话）、`docs/render-rebuild-plan.md` 1（:168，引用的提交说明原文）、`docs/vision-plugin-refactoring-plan.md` 1（:10，正是「不用烘焙」的规则句）。
    - 「烘」单字（不含烘焙）**23 处 / 8 个文件**：`scripts/archive/export-frames-virtual-time.mjs` 16；`docs/decoupling-plan.md` 1（:246「烘培」，用户原话）；`restructure_planning/r75/agy-r75-01/06/07/08/09/10.md` 各 1（审查报告里的原句摘录）。
    - 「冻结」残留 **81 处 / 28 个文件**：restructure_planning 22、docs 15、`reply_to_users_goal.md` 11、src 12、server 10、scripts 10、`EDITOR-DESIGN.md` 1。其中代码注释里当「生成快照」用的有：`src/render/capabilityGuard.ts:15/:85`、`src/render/contentBox.ts:107-108`、`src/render/snapshot/inlineStyles.ts:31`、`src/render/snapshotRename.ts:15-16`、`src/render/solid.ts:10/:60`、`src/StageView.tsx:423`、`server/bakery/bake.mjs:232/:234/:262`、`server/frame-pipeline.mjs:49/:1113/:1206/:1246`（`:1246` 在抛出的错误字符串里）、`scripts/replay-frames.mjs:6`、`scripts/probes/svg-url-serialize-probe.mjs` 7 处。
- 结论：部分完成——「烘 / 烘焙」基本清完（残留几乎都在归档脚本、引号原话、审查原件里，可视为合理保留；唯一值得处理的是 `scripts/archive/` 那 21 处，是否算「全仓」由用户定）；**3.8 规定弃用的「冻结」没有进这次清理**，代码注释里仍有约 20 处当「生成快照」用。
- 差异或问题：check 说「全部已落地」不准确；「禁用旧词」的范围在计划里没写清（只做了烘 / 烘焙）。

### DEC-8 `streams` 默认开、生产限速
- 结论：已写进分册；实现未开始（R8-10）。

### DEC-9 旧任务书整体舍弃
- 核查证据：`git ls-files | grep AGY-TASK` 无结果。
- 结论：已完成。

### DEC-10 像素映射工具主动分流 + WebGL 后端（R1b 做完）
- 核查证据：`src/kernel/pixelMap.mjs:342` `classifyPixelMap`、`:500` `compilePixelMapGlsl`；`src/render/pixelMapGl.ts` 存在。
- 结论：已完成（像素级验收数据是 Agent / 主会话自报，本次未复跑）。

### DEC-11 `future_planning.md` 第 1 条（桌面版给只有原片的云端素材补转小版）
- 核查证据：文件只有这一条，写明「先不管」、动手时要定的四个细节。
- 结论：按决定不做（以后做）。
- 差异或问题：无。

### DEC-12 `g0-a-webview2-probe.md` 的已定事项
- 核查证据：OAC 头已由 `server/vite-plugin-stage-ports.ts:9/:116` 在舞台端口首载就加；桌面壳端口预检 `desktop/src-tauri/src/lib.rs:32` 提到；「codec 串从 avcC 拼」「isConfigSupported 不当能力判据」已写进 r8 G5（:156），实现待 R8。
- 结论：舞台隔离部分已完成；解码侧结论待 R8。

### DEC-13 计划第 7 节「还没定的」三条
- 1 独立审查没派（check:126，自报属实：分册文首都写「未经独立审查」）；2 云端 6 问未定；3 R8 / R9 三细节未定。
- 结论：未定（属实）。

---

## 六、对照 `user_pinned_goal.md` 全部条目（粗判）

### GOAL-交互1 传统 / SKILL 双模式、右上角悬浮窗、迷你时间轴、展开后的 Agent 修改预览、图钉 / 放大、桌面端 Agent 识别码与两侧菜单显示、「回到 Claude（ChatGPT）对话」按钮
- 证据：SKILL 模式存在——`src/skill/skillMode`、`SkillDialog.tsx:15/:161`（进 SKILL 主窗收成悬浮窗）、壳 `desktop/src-tauri/src/skill_shell.rs:4`（「收起来变成右上角一枚悬浮图标，双击才重新展开」）、`:211-243`（右上角、`always_on_top(true)`）；悬浮窗 `desktop/ui/overlay.html` 有「上一步动作」预览图（`:125-127`、`mcpExecutor.ts:250-271`）。**没有**迷你时间轴 / 播放、图钉按钮、放大按钮、展开按钮；右侧 AI 面板在 SKILL 模式下是整块锁住（`src/editor/right/SkillLock.tsx`：「这里的 AI 面板暂时锁住」+「关闭 SKILL 模式」按钮），不是「显示桌面端 Agent 的操作 / 修改预览 + 居中『回到 Claude』按钮」；src 里 grep「回到 Claude / ChatGPT」零命中。
- 结论：部分实现（不在本渲染计划范围；cloud-task.md 约束一节明写「交互设计不在本任务范围，另开任务书」）。

### GOAL-交互2 圆角、Fluent 深色生产力风格
- 证据：皮肤系统 `src/skins/skins.ts`，默认 `studio-dark`（`:195`），圆角 token `ui-radius-sm/…/xl` = 4/6/8/10 px（`:135-138`）；palettes `studio`「深邃的现代生产力工具底色」（`palettes.ts:41-47`）。是否「典型 Fluent」属主观，无法独立判定。
- 结论：部分实现（有圆角深色默认主题；Fluent 规范符合度无法独立验证）。

### GOAL-交互3 高饱和青蓝 + 低饱和酱紫
- 证据：默认 studio 强调色沿用青蓝（`palettes.ts:44` 注释）；第二色 `ui-accent-2 = color-mix(var(--ui-accent) 10%, #7b5cff)`（`skins.ts:109`）——`#7b5cff` 是较高饱和的蓝紫，不是「低饱和酱紫」；悬浮窗里写死 `#00DBDB`（`overlay.html:106`）。
- 结论：部分实现（青蓝有；酱紫的饱和度与 pinned 不符，建议交互任务核一下）。

### GOAL-平台 六个平台、在线浏览器模式共用机制、Agent 端 Windows / Linux / Ubuntu
- 证据：只有桌面版（Tauri 壳跑 vite dev server）与本机浏览器打开 dev server 两种；在线浏览器模式不存在（CLOUD-9）；页面按能力表分支的判据已在（`stageRpc.ts:426-436` 的 `offscreenGl` / `lowMemory`）；Agent 端跨平台 I0 未做。
- 结论：部分实现（只有平台 1；2～6 依赖云端第 10 步）。

### GOAL-架构1 云端拆两块（文档云端 WebSocket + 素材云端两档分片续传、逐个先小后原、拉取换档）
- 证据：CLOUD-0～CLOUD-2。
- 结论：未实现（本地内容库 / tiers 字段 / playbackUrl 占位是雏形）。

### GOAL-架构2 本地 / 云端两种素材管理模式，本地模式文档服务仍在本机
- 证据：本地模式（直接读本地内容库）已是现状；文档服务不存在（CLOUD-4）。
- 结论：部分实现。

### GOAL-架构3 在线浏览器模式 vs 本地模式；后台 iframe 预渲染角色本任务就实现；给云端合并、在线重型控件服务留接口
- 证据：本地模式可请求预渲染进程（R6 就绪索引 / SSE）；后台 iframe 的 `bake` 角色回 `unsupported`（`StageView.tsx:1474`）；L5 接口未留。
- 结论：部分实现（本地模式那半在；后台 iframe 预渲染角色、在线模式、两处接口未做）。

### GOAL-架构4 预渲染进程 Agent / User / Full 三模式，Agent 专用 Chrome 插队不独占
- 证据：只有 `PROMPTCUT_ROLE=prerender` 与进程内三条 lane；无三模式环境变量（CLOUD-6）；`worker-pool.ts:6-8` 注释专用 Chrome 是「将来做」。
- 结论：未实现（lane 分离是雏形）。

### GOAL-架构5 AI 菜单操作预览在普通 Chrome 队列里插到最前、不打断、不占 Agent 专用 Chrome
- 证据：`server/vision/render-queue.ts:115` `enqueue(job, priority)`，`:138` 按 priority 插队，`:57-78` 后台最多用 `max-1` 留一个槽给前台；`routes.ts:198-214` `ensureGif(key, priority)` 以 priority>0 入队。但 Agent 的 `bake_card` 也走 priority 1（`routes.ts:608`），没有「Agent 专用 Chrome」可以不占。
- 结论：部分实现。

### GOAL-架构6 播放按帧走、慢帧等、不冲，舞台每渲完一帧报一次 t，随机访问看不到推帧过程
- 证据：R5 K4 节拍器（`d42746f`）；check:87 的节拍实测（Agent 自报）；K3 三条跳转路（`7f48d23`）。
- 结论：已实现（数字为自报，本次未复跑）。

### GOAL-架构7 最高 60 fps，项目选项面板加 fps 下拉（24/25/30/60），步长 1/fps，默认 30
- 证据：全链路按 `project.fps` 取 1/fps 步长（`StageView.tsx:484` 等）、默认 30（`project.ts:334`）；**`src/editor/ProjectSettingsDialog.tsx` 没有 fps 下拉**（只有项目名、比例、方向、分辨率；最近一次改动 `ecbe267`，早于 R2），全 src 也没有别处能改 fps。r2-r7-task.md「约束」第 1 条（第 177 行）把这个下拉排进了 R2～R7，cloud-task.md:391 也写「今天那里没有 fps 项」。
- 结论：部分实现——**下拉没做，而 check 称 R2～R7 完成、没提这条缺口**。

### GOAL-架构8 store 跟随 t，拖动 / 点击 / 播放不卡顿
- 证据：R7 总验收（check:101-102：主文档长任务 0、拖动往返均值 7.9 ms，Agent 自报 + 主会话看过）。
- 结论：已实现（无法独立验证，本次按只读约束未跑探针）。

### GOAL-架构9 暂停 / 点击 / 松手后精确活渲
- 证据：R5 K5 两路追帧与角色互换（`f3e2c7b`）、播放到头后 settle（check:87）。
- 结论：已实现（自报；check:90 列了 K6 三条闭环没验）。

### GOAL-架构10 音频跟 t，停顿 > 40 ms 暂停、恢复对齐，阈值固定 40 ms
- 证据：`src/editor/Preview.tsx:344` `MEDIA_STALL_MS = 40`、`:492` 判定、`:952` 通道。
- 结论：已实现。

### GOAL-划分轴一 direct / 可定位推帧卡（seekOk）/ 只能逐帧推的卡；seekOk 判据（推 8 帧 vs 一步钉到第 8 帧，1e-6 相对误差）
- 证据：`src/kernel/frameMode.mjs`；布尔探针 `StageView.tsx:865-906`；`snapshotCompare.mjs:5` / `:44` `NUMBER_RELATIVE_TOLERANCE = 1e-6`；`pipelineTuning.mjs:54` `PROBE_BOOL_FRAMES = 8`。
- 结论：已实现。

### GOAL-划分轴二 DOM 卡 / canvas 卡
- 证据：能力审阅表 `canvasHeavy`（计划:48 的 54 张粒子卡）；共享 WebGL 那一路未做。
- 结论：已实现（分类层面）。

### GOAL-划分轴三 独立卡 / 后处理卡（SourceDependent、BDdependent）
- 证据：`src/cards/capabilities.json`（`independent` 29 次、`belowDependent` 12 次；`sourceDependent` 在 `src/kernel/frameMode.mjs`、`server/card-identity.mjs` 等处定义，审阅表里当前 0 张）；共享键按依赖链算（`card-identity.mjs:99`）。
- 结论：已实现。

### GOAL-渲染1 用户交互无卡顿，舞台与交互异步
- 证据：跨源双舞台 + OAC 独立进程（R2 / R7，`vite-plugin-stage-ports.ts`）；check:104 自认「零卡顿只量到『预渲染在跑 + 后台舞台空闲』」。
- 结论：部分实现（机制在，「同时跑预渲染」下的零卡顿未验）。

### GOAL-渲染2 轻 / 重靠实测：推帧卡全程最慢一帧、随机访问卡固定抽 8 帧，超 1000/FPS×70% 判重
- 证据：`pipelinePlan.mjs:46` `budgetOf = 1000/fps×0.7`、`:109` 判重；`pipelineTuning.mjs:84-87` 说明 direct 卡 8 次抽样不够 `STEP_MIN_SAMPLES`(16) 会补抽。
- 结论：已实现（「固定 8 帧」实际会补抽到 16，属 pinned 渲染 5 允许的可调采样数，不算违背，但字面不同）。

### GOAL-渲染3 代价优化贪心，追帧卡按整段最差追帧代价
- 证据：`pipelinePlan.mjs:110-127`（`catchup-a/b`、`over-catchup`）、`planPipelines` `:140` 起。
- 结论：已实现。

### GOAL-渲染4 长 motion 按播放位置算 t_c = (t − t_start) × FPS × t_oc
- 证据：`pipelinePlan.mjs:121` 注释「推帧卡：按整段最差代价判，各位置统一」——权重各位置相同（`:157` 起「每张卡的权重算一次（各位置相同）」），没有按 `(t − start)` 随位置变化的项。
- 结论：部分实现（按渲染 3 的最差情况实现，渲染 4 的位置相关估算没做；是否有意取代需计划里说明，目前未见说明）。

### GOAL-渲染5 加载时测全部卡（遮罩）、新卡离屏测、p90 稳健值、可调系数、两趟探针、快照耗时三段、探针帧当预渲染、记录复用
- 证据：`ProbeGate.tsx`、`probeRunner.ts`、`pipelineTuning.mjs`（R4a / R4b，`62810bb` / `ed9a080`）；`probe-frame → PUT /api/frames/snapshot` 转发「写好但未验收」（check:82）。
- 结论：已实现（其中「探针帧直接存成预渲染」一条未验收）。

### GOAL-渲染6 实时加载管线 + 一秒窗口降级、降级先进队列、就绪才切、预渲染集合只增不减
- 证据：`src/editor/demote.ts`、K6（`73ea969`）；check:90 自认「要预渲染进程才验得了的三条 K6 闭环」没验。
- 结论：部分实现（父页一半在，闭环未验）。

### GOAL-渲染7 预渲染管线：重卡异步离屏渲成死素材，播放 / 拖动只贴死素材，缺失透明、播放头不停
- 证据：R6 就绪索引 / SSE、`snapshotFeed.ts`（C4 选帧）；播放中贴的是 HTML 快照（R8 流未做）。
- 结论：部分实现（死素材只有 HTML 快照这一种形态）。

### GOAL-渲染8 轻 / 重按位置动态算（分段边界 = 入出点并集）
- 证据：`pipelinePlan.mjs:167`「分段边界 = 所有卡片入点出点的并集」。
- 结论：已实现。

### GOAL-渲染9 预渲染只做重卡并集
- 证据：`server/prerender-set.mjs` 的 `prerenderSetOf` 接 `planPipelines`（`bfbf59d`）。
- 结论：已实现。

### GOAL-渲染10 两种形态（播放用 alpha H.264 流 + 组流退路；暂停 / 拖动用每控件 HTML 快照）+ 共享 WebGL 渲染器两条路线、项目选项可切
- 证据：HTML 快照已在（R1 / R6）；流（R8）、共享 WebGL（R9）、`glRoute` 选项都未开始。
- 结论：部分实现（只有快照那一半）。

---

## 发现的问题汇总

1. **fps 下拉没做（pinned 架构 7）**：`ProjectSettingsDialog.tsx` 无 fps 项，全 src 无改 fps 的入口；r2-r7「约束」第 1 条把它排在 R2～R7 内，check 却称 R2～R7 完成且未列这条缺口。
2. **R8 分册的 G0-b 回填不完整**：`h264_mf` 行（G3 表）、`firstMs` +80 ms（G4 :146）、可行性条件用「有编码器在跑时」的 `frameMs`（G4 :150）、codec 串是举例（G5 :156）只进了汇总段，正文未改；:24 仍写「原型在另一个 worktree 在跑」。
3. **R8 / R9 分册行号整体漂移**：自称在 `048074c` 核过，R2～R7 合并后 `bake.mjs`、`frame-pipeline.mjs`、`stageRpc.ts`、`StageView.tsx` 等引用已过期；R9 M2（:71）对 `stageId` 的「今天不满足」描述已被 R2 做掉，是过期内容。
4. **禁用旧词清理只做了「烘 / 烘焙」**：3.8 规定弃用的「冻结」仍有 81 处 / 28 个文件，其中代码注释约 20 处当「生成快照」用；check「已定的全部落地」不准确。「烘 / 烘焙」残留 31 处，21 处在 `scripts/archive/`，其余是引号原话 / 审查原件 / 规则句本身。
5. **路径表缺口比 check 列的更大**：check 点名的 21 个文件都存在、都不在表里；另有 11 个新文件（`ProbeGate.tsx`、`costIdentity.ts`、`createSnapshot.ts`、`snapshot/*` 三个、`pixelMapGl.ts`、`planeStyle.ts`、`probeSummary.mjs`、`_probe/*`）、`mediaSync.ts` 搬家、`snapshotFreeze.ts` 删除 check 没提；表下「没动的」段仍列已删的 `snapshotFreeze`，`frame-pipeline.mjs` 行号与行数（1155→1438）过期。
6. **计划:249 交叉引用指错**：「是否现在做，见第 7 节第 1 条」，第 1 条讲的是独立审查。
7. **`frame-pipeline.mjs:89-90` 注释 / `userPoolSize = 2`** 与 G0-b 定的 `streamPool` 建议 1、最多 2 不一致（R8 动工时顺手改）。
8. **组流平面**（R3 已渲出）没有 `pointer-events: none`，`solid.ts:197`、`planeStyle.ts:28` 的排除名单也没加 `data-pc-group-plane`——R8 之前 `streamPlanes` 恒空所以无害，R8 分册只点了 `solid.ts`，漏了 `planeStyle.ts`。
9. **云端「未开始」属实，但 check 没写已有雏形**：本地内容库按哈希寻址 + Range、`/api/media/local`、`MediaTiers` 字段、`playbackUrl` 占位、`.procp`、镜像插件、预渲染进程 lane、`setLocalHashes` RPC 都已在；主文档每 2 秒轮询 `/api/media/local` 的代码不存在。
10. **fold-notes 交代的「playable / 原编码读法写进 `reply_to_users_goal.md` 请用户确认」没做**；`reply_to_users_goal.md:9` 还写着过期的「小版全部先传、原片后传」顺序（该文件最后提交 `b5c65dc`）。
11. **pinned 渲染 4（长 motion 按播放位置估 t_c）没实现**：`pipelinePlan.mjs` 对推帧卡用整段最差代价、各位置统一，计划里未见「用渲染 3 取代渲染 4」的说明。
12. **交互条目与 pinned 差距大（不在本计划范围）**：SKILL 悬浮窗没有迷你时间轴 / 图钉 / 放大 / 展开，右侧 AI 面板整块锁住而非显示桌面 Agent 操作，无「回到 Claude（ChatGPT）对话」按钮；第二主题色 `#7b5cff` 不是低饱和酱紫。
13. 小事：`restructure_planning/r2-r7-task.md` 第 39 行含一个 NUL 字符（git / grep 当二进制处理，和 check:78 修过的 `costs-store.mjs` 同类问题）；`src/render/snapshotRename.test.mjs` 同样被 grep 判为二进制。
14. G0-b 报告「没做成」有 5 条，check 只列了 4 条（漏「`captureFrame` 带 `clip` 的截图省时没量」）。
