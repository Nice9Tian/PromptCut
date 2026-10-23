# AGENT 报告：剪辑段里的卡做通产流

分支 `claude/cut-stream`，工作区 `.worktrees/cut-stream`，基于 main `b362e254`。端口段 5900～5919（没碰 5190～5192、5203、5210～5212、5690～5699、5770～5790、8760～8790）。没有推送、没有合并、没有改 `docs/semantics/**`。

〔裁〕R01、R02 是 2026-10-22 用户对「剪辑段里的卡产流」两条待审裁定的回复。原文（`docs/plan/user-decisions-2026-10-22.md` 第 2 节第 4 条；选项在 `wait_to_judge_html/source/items/R.md`）：

- R01：主会话原写「剪辑段里毛玻璃这类卡不走轨道流」。用户原话「毛玻璃卡带着下层一起产轨道流。不是不产轨道流。」读法「R01 选丙」——丙是「真的做通（解法表行 1 或 2）」。
- R02：主会话原写「在线浏览器也不替剪辑段里的重卡产流」。用户原话「产。根据要求，剪辑卡就是在时间轴中的卡片。所以重卡也产流。」读法「R02 选乙」——乙是「让浏览器本页也能产剪辑段里的卡的流」。

任务转述与原文一致，没有出入。和开工指令 `docs/plan/release-019-020-kickoff.md` 第 25 行有一处不一致：那里写「会动导出像素基线」，实际没动（演示项目里没有剪辑段，见「验证」）。

## 结论

- **R01 做通了**：剪辑段里依赖下层的卡（毛玻璃、没审阅过的卡）带着它在剪辑段里的下层产「依赖下层的流」，舞台在嵌套场景里贴它。真 Chrome 端到端：贴流的舞台和整个项目的整帧活渲导出逐帧比，每一帧最像的都是它自己那一帧，段的框里平均差 0.47～1.11/255（不贴这条流时 5.35～6.35）。
- **R02 做通了**：切分方给浏览器出剪辑段里平面独立卡的那一份流任务，在线页面本页产流的计划也算它们，浏览器的后台舞台能在嵌套场景里取这张卡的像素。端到端：切分方只切分、不认领时，在线页面认领并产出流（编码器 `webcodecs-avc`），播放时贴的就是它；与同一帧精确活渲比 0.38/255（顶层同一张卡由浏览器产的流是 0.57/255）。
- **像素基线没变**：与开工提交 `5f4523d0` 的全长导出逐字节相同 1800/1800。
- **门槛全过**：类型检查 0 错误；全量 `npm test` 7688 条 0 失败；两种构建通过；导出确定性 1800/1800、快照重放 PASS。

有一处用户看得到的变化要请主会话定（不是像素基线里的东西，演示项目没有剪辑段）：**剪辑段里的毛玻璃不再透过剪辑段去滤段外面的层**。理由与取舍见下面「设计」第 1 条和「语义建议」第 1 条。

## 设计

### 1. 嵌套场景是毛玻璃的采样边界（`src/render/CutSegmentScene.tsx`）

上一轮的解法表（`docs/archive/agent-reports/AGENT-cut-flatten.md`「没做成的与原因」第 1 条）里两行都卡住：行 1「在嵌套场景自己的坐标系里产、只算段里的下层」卡在「`backdrop-filter` 会透过嵌套场景采样到段外面的层，`isolation` 挡不住」；行 2「按顶层舞台坐标产、贴在顶层」卡在「段里比它高的层会被这张平面盖住」，而且段的不透明度会被乘两次。

这一轮先做了实验（Chrome 152，`out/probe/backdrop-root.mjs`，软件光栅的 headless-shell 与带 GPU 的 Chrome 各跑一遍，平移、缩放 0.75、旋转 7° 三种框）：

| 场景层上的属性 | 毛玻璃底下段外色带 | 不带毛玻璃时的像素（对照「无」） |
|---|---|---|
| 无（现状） | 被模糊（同一行标准差 0～2） | — |
| `clip-path: inset(0)` | 锐利（标准差 109） | 三种框、两种浏览器都逐字节相同 |
| `filter: opacity(1)`、`mask-image`、`will-change: filter` | 锐利 | 变了 |
| `isolation: isolate`、`contain: paint` | 被模糊 | 相同 |

所以给嵌套场景那一层挂 `clip-path: inset(0)`：它让场景成为毛玻璃的采样根（Backdrop Root），裁的框和已有的 `overflow: hidden` 一样，别的像素逐字节不变。这样行 1 就走得通：毛玻璃只滤这条被引用剪辑里排在它下面的层。

这与二级语义一致：`product/project-model.md` 第 31 行「画面是被引用剪辑在对应时刻的整帧合成」，`mechanism/rendering.md` 第 136 行「先在项目画幅里合成，再整块缩放进段的框」。原来的活渲其实和这两句冲突：段不透明度为 1 时毛玻璃透过段去滤段外的层，段在淡入淡出、不透明度小于 1 的那几帧又不滤（不透明度本来就让它成为采样根），同一个段在淡入结束那一帧画面会跳。改后每一帧一致。

**用户看得到**：剪辑段里的毛玻璃底下如果段里没有东西，原来看到的是段外层的模糊，改后是透过半透明玻璃看到段外层原样（不模糊）。按语义优先原则这是代码向语义靠，但用户会看出区别，所以在「语义建议」第 1 条请主会话转给用户定；要推翻只需拿掉这一行 `clipPath`，R01 就退回做不通。

### 2. R01：剪辑段里依赖下层的卡的流

| 环节 | 做法 | 文件 |
|---|---|---|
| 哪些卡出 | `belowStreamEligible` 不再排除剪辑段里的卡（依赖下层、`unknown`、`context`；外框三维照 `BELOW_STREAM_RULES.frame3d`）；源依赖的照旧不出 | `src/render/streamPlanRules.mjs` |
| 下层是谁 | `belowLayersOf` 对剪辑段里的目标卡只收同一个嵌套场景里的层（id 以 `flatScenePrefix` 打头，含更深一层剪辑段里的）；段外的层、上一层场景里的层不算。服务端算键、建隔离工程和页面算输入签名用的是这同一个函数 | `src/render/streamInputSig.mjs`、`src/kernel/cutFlatten.mjs` |
| 键 | 照顶层依赖下层的流（目标卡与每个下层的缓存内容键、采样窗口），另带 `within`（场景前缀，进摘要） | `server/frame-stream.mjs`、`server/card-identity.mjs` |
| 回放 | 从嵌套场景最早挂上的那一帧起（`mountClipOf` 挪进 `streamPlanRules.mjs`，`belowTargets` 也用它） | 同上 |
| 隔离工程 | `isolatedFlatBelowProject`：链上的剪辑段去掉外观、1:1 铺满画面（截图坐标就是嵌套场景坐标）；最里面那条剪辑里留目标卡和它下面的层，上面的藏成 `sourceOnly`；目标卡外观原样 | `src/kernel/cutFlatten.mjs` |
| 取像素 | 差分取层照旧；藏目标卡也认嵌套包裹层 `[data-pc-flat-clip]`；找毛玻璃外框时祖先查到嵌套场景为止 | `server/bakery/capture-below.mjs` |
| 贴 | 流平面 `plane: "stage"`，舞台本来就会在嵌套舞台里挂（`Stage.tsx` 按「前缀 + 片段 id」找宿主），坐标是嵌套场景的，段的框、不透明度、淡入淡出由外面那几层照常加。父页：剪辑段里有流的卡（独立卡与依赖下层的卡）都判重、抑制、发平面；停下时按历史推进的那些走整场景补跑互换 | `src/editor/snapshotFeed.ts`、`src/editor/stageSwap.ts`（`flatClipStreamKind`） |

### 3. R02：浏览器替剪辑段里的重卡产流

| 环节 | 做法 | 文件 |
|---|---|---|
| 切分 | `browserStreamInputOf` 给 `solo: 'flat'` 里外框平面的那些出浏览器那一份（外框三维的照旧不给，同顶层 `'spatial'`；依赖下层的流本来就不给浏览器） | `server/render-node/split.mjs` |
| 本页产流计划 | `planPageStreams` 给剪辑段里外框平面、能过 `pageStreamBlock` 的独立卡出单卡流 spec（键、范围、矩形与切分方逐字段相同；预算照旧按切分方的算法） | `src/online/pageStreamPlan.ts` |
| 隔离工程 | `isolatedBakeProject`：顶层的卡照旧是隔离单卡工程；剪辑段里的卡用 `isolatedFlatProject`（与桌面产 `'flat'` 流同一份），去掉卡自己的外观，时间不平移；`bakeFrameBase` 给出本地帧 0 对应的项目帧 | `src/online/bakeTask.ts`、`src/editor/stageBake.ts` |
| 后台舞台 | `bakeFrame` 认虚拟片段：按 `frameBase + n` 推到项目帧（一律从挂载帧逐帧推），快照多收嵌套包裹层（`createSnapshot` 的 `flatControls`），包裹层本地帧的核对按卡自己的起点算、容一帧 | `src/StageView.tsx`、`src/render/stageRpc.ts`、`src/render/createSnapshot.ts` |
| 快照的样式内联 | 嵌套包裹层的直接子节点也算 control 快照的顶层，继承属性一律内联（只在 `flatControls` 时；缺省不变）。不加这一条，重放时字体退回缺省、字整体高了约 4 像素（端到端探针第一次就是这样红的，见「验证」） | `src/render/snapshot/inlineStyles.ts` |

## 身份键怎么改的、为什么安全

1. **顶层的键一个字不变**：`within` 只在剪辑段里的目标卡上带，摘要里写成 `...(within ? { within } : {})`，顶层的摘要没有这一项。单测 `CB-golden` 用开工提交解出来的树（`git archive b362e254`）算的金样核对：没有剪辑段的项目整张流表逐字相同；有剪辑段的项目里原来就有的五条流（顶层独立卡、三张剪辑段里的独立卡、顶层毛玻璃）逐字相同；顶层两条依赖下层的流的输入签名相同。
2. **「带下层」和「不带下层」分得开**：剪辑段里依赖下层的卡原来根本没有流，不存在可以命中的旧快照；新流的键是 `kind: 'below'`（和单卡流 `kind: 'card'` 不同），另带 `within`。`CB-key` 断言：同样的成员和下层，带 `within` 与不带的键不同；与这张卡的单卡流的键也不同。
3. **键跟着该跟的东西变**：段里的下层改了参数、目标卡自己改了、段在时间轴上的偏移变了，键和输入签名都变；段外的层改了、段外多一层、段的框和不透明度改了、段里上面的层改了，键和签名都不变（流在嵌套场景坐标里、场景是采样边界，这些都不进流的像素）。页面一侧判「旧流不贴」用的是同一个 `belowLayersOf`，计划里记的签名就是页面算的那一个（`CB-key`）。
4. **R02 的键**：浏览器产的剪辑段里的卡的流，内容键与切分方给浏览器那一份逐字段相同，结果键 = 内容键 × 浏览器指纹（`CB-page`、端到端 A）。

两处代码指纹会变（不是键算法变了，是指纹覆盖的文件改了）：

- `server/bakery/capture-below.mjs` 在截图代码指纹 `captureCode` 的文件表里，所以**所有轨道流的代码版本都会变**，部署后已有的流全部按新键重产一次（在线构建里嵌的 `__PC_STREAM_CODES__` 同步变，页面与切分方仍对得上）。这是指纹的本意（截图代码改了流跟着作废），但一次性的重产成本请知悉。
- `src/render/createSnapshot.ts`、`src/render/snapshot/inlineStyles.ts` 在生成快照的代码指纹 `snapshotCode` 里，控件的 `contentKey`、`snapshotKey` 跟着变；它们不进任何流的键（单卡流用 `streamMemberKey`，组流和依赖下层的流用 `cacheContentKey`），HTML 快照又已全量下线，所以只影响诊断里看到的键。

## 逐文件

| 文件 | 改了什么 |
|---|---|
| `src/render/CutSegmentScene.tsx` | 场景层加 `clipPath: "inset(0)"`（采样边界），文件头写明 |
| `src/kernel/cutFlatten.mjs`、`.d.mts` | 新增 `flatScenePrefix`、`isolatedFlatBelowProject`（及内部的 `belowTracks`） |
| `src/render/streamPlanRules.mjs`、`.d.mts` | `belowStreamEligible` 收剪辑段里的卡；`mountClipOf` 从 `frame-stream.mjs` 挪来，`belowTargets` 用它；新增 `flatClipStreamKind`；注释改写 |
| `src/render/streamInputSig.mjs` | `belowLayersOf` 对剪辑段里的卡按场景前缀筛 |
| `server/card-identity.mjs` | `belowStreamIdentity` 收 `below.within` |
| `server/frame-stream.mjs` | `belowStreamSpecs` 给剪辑段里的目标卡算 `within`、带进 spec；`isolatedStreamProject` 遇 `within` 走 `isolatedFlatBelowProject`；`queueStreamOf` 带 `within` |
| `server/bakery/capture-below.mjs` | `pageHideTarget` 认 `[data-pc-flat-clip]`；毛玻璃外框的祖先检查查到 `[data-pc-cut-scene]` 为止 |
| `server/render-node/split.mjs` | `browserStreamInputOf` 放行外框平面的 `'flat'` |
| `src/online/pageStreamPlan.ts` | 剪辑段里外框平面的独立卡出单卡流 spec（`emit` 抽出来两处共用） |
| `src/online/bakeTask.ts` | 新增 `isolatedBakeProject`、`bakeFrameBase` |
| `src/editor/stageBake.ts` | 用 `isolatedBakeProject`；每帧请求带 `frameBase` |
| `src/render/stageRpc.ts` | `BakeFrameRequest.frameBase` |
| `src/StageView.tsx` | `bakeFrame` 认虚拟片段（上表） |
| `src/render/createSnapshot.ts`、`src/render/snapshot/inlineStyles.ts` | `flatControls` / `flatWrappers` 选项，缺省关 |
| `src/editor/snapshotFeed.ts`、`src/editor/stageSwap.ts` | 剪辑段里有流的卡按 `flatClipStreamKind` 判 |
| `server/test/cut-below-streams.test.mjs`、`cut-below-fixtures.mjs`（新） | CB-golden、CB-plan、CB-key、CB-iso、CB-mount、CB-split、CB-page、CB-bake |
| `src/editor/stageBakeFlat.test.mjs`（新） | QM-FLAT-01、02 |
| `src/editor/snapshotFeedBelow.test.mjs` | 加一条：剪辑段里依赖下层的卡判重、贴流、旧签名不贴 |
| `server/test/cut-flatten-streams.test.mjs` | 原来断言「依赖下层的卡不出流」（v1 限制），按 R01 改成「出依赖下层的流、`within` 是 `S~`、下层只有段里的 L」 |
| `scripts/probes/cut-below-stream-probe.mjs`（新） | R01 端到端探针 |
| `scripts/probes/cut-online-browser-probe.mjs`（新） | R02 端到端探针 |
| `scripts/probes/cut-online-e2e-probe.mjs` | 断言 B 按 R02 改：在线来源选层表候选里实际产出来的那一份（原来写死切分方那一份），文件头同步 |
| `docs/reports/assets/cut-stream/**` | 探针的截图与结果 JSON |

## 验证

### 门槛

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 测试 | `npm test`（全量；命令里设两个账号变量，反斜杠写法） | 汇总行原文：`ℹ tests 7688`、`ℹ pass 7673`、`ℹ fail 0`、`ℹ cancelled 0`、`ℹ skipped 15`、`ℹ duration_ms 198174.7093`；`✓ npm test 最终结果：零失败`；日志 925,186 字节。新加的 12 条都在日志里打了 ✔ |
| 桌面构建 | `npm run build` | 退出码 0 |
| 在线构建 | `npx vite build --mode online` | 退出码 0 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url http://127.0.0.1:5900/?export=1`（本工作区起的开发服务器，带 `PROMPTCUT_NO_PORT_FILE=1`） | `Identical: 1800`、`Different: 0`、`All frames are identical. Determinism verified!`，退出码 0 |
| 快照重放 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5900` | `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; PNG table and frames/ hold all 10 frames; no preview.mp4 / full.mov.`，退出码 0 |
| 与 `5f4523d0` 的像素比对 | `git archive 5f4523d0` 解到 `out/baseline-5f45`，两棵树各用自己的 `scripts/export-frames.mjs --url …/?export=1 --fps 30 --workers 1 --no-video`（都在 5900 起自己的开发服务器，先后跑），再 `node scripts/probes/export-baseline-compare.mjs --baseline … --candidate …` | `逐字节:相同 1800/1800`、`✅ 全长导出逐字节相同`，退出码 0 |

测试范围：跑的是全量，所以改动影响到的文件（按文件名找出 83 个引用改动模块的测试，外加管线、切分、页面产流、舞台相关的）全在里面。没有被测试直接覆盖的：`StageView.tsx` 的 `bakeFrame` 新分支、`createSnapshot` 的 `flatControls`、`inlineStyles` 的 `flatWrappers`、`CutSegmentScene` 的 `clip-path` —— 这四处要真浏览器，由下面两支端到端探针覆盖。

### 改前红、改后绿（单测）

改前：先提交测试（`c797742d`）在开工提交的代码上跑，`ℹ tests 8`、`ℹ pass 1`、`ℹ fail 7`（日志 7,064 字节），红的是 CB-plan、CB-key、CB-iso、CB-mount、CB-split、CB-page、CB-bake，过的是 CB-golden（金样本来就取自开工提交）。最终版本的新测试拷进 `git archive b362e254` 解出来的树里再跑一遍：

```
✔ CB-golden 顶层的流与开工提交 b362e254 逐字相同
✖ CB-plan … ✖ CB-key … ✖ CB-iso … ✖ CB-mount … ✖ CB-split … ✖ CB-page … ✖ CB-bake …
✖ 剪辑段里依赖下层(没审阅过)的卡(〔裁〕R01):和顶层一样判重、抑制、发它的流平面(plane: stage,舞台挂在嵌套舞台里)
✖ QM-FLAT-01 剪辑段里的卡:灌带剪辑段链的隔离工程,请求带 frameBase
✔ QM-FLAT-02 顶层的卡:隔离单卡工程,请求不带 frameBase
ℹ tests 25 / ℹ pass 16 / ℹ fail 9
✖ npm test 最终结果：仍有失败
```

改后：同样这些在本分支全量里全过（上表）。

### R01 端到端：`scripts/probes/cut-below-stream-probe.mjs`

`node scripts/probes/cut-below-stream-probe.mjs --port 5900 --out out/probe-a-final`（开发服务器 5900～5902，宿主小服务 5905）。场景（1280×720、30 fps）：剪辑段 S 缩到 0.8、偏移 0.3 秒、淡入 0.4 秒；段外是一张六色竖条图；段里从上到下是一枚药丸、毛玻璃里程表（目标）、R6 推帧卡（色块匀速滑动，从毛玻璃底下滑过）、一枚半透明带阴影的大药丸。R6 自己也判重、贴它的 `'flat'` 单卡流。

本分支（最终提交上重跑）：`PASS`，退出码 0。

| 条 | 读数 |
|---|---|
| 1 计划 | 毛玻璃一条 `kind: below`、`plane: stage`、`within: "seg-s~"`，`belowClipIds` 只有段里的半透明药丸和 R6（段外色带图、段里上面的药丸都不在），第 0～104 帧，回放从第 0 帧起 |
| 2 产 | 稀疏、满密度齐；差分取层 112 帧、毛玻璃掩码 112 帧、14 次实测、0 次失败、0 次越界 |
| 3 隔离工程 | 顶层只留 S（框、淡入都去掉），「玻璃」里上面的药丸藏起来 |
| 4 贴流 | 停在第 4、10（淡入里）、31、47、75、100 帧，与整帧活渲导出比：每一帧最像的都是它自己那一帧，段的框里平均差 0.47、0.93、1.11、0.96、0.74、0.95（/255）；流平面挂在 `[data-pc-cut-scene]` 里、毛玻璃的嵌套包裹层被抑制；场景层 `clip-path: inset(0px)` |
| 5 对照 | 只拿掉毛玻璃的流（R6 照贴）：第 10、47 帧差 5.35、6.35 |
| 6 采样边界 | 毛玻璃面板底下段外色带的分界：一步跳完的比例 1.00（导出里），边缘强度 42.15（没有段外图时 3.38） |

改前（同一支探针拷进开工提交的树跑）：`FAIL 3`。`超时:毛玻璃 V 有流`（只有 R6 一条流 `[["card","seg-s~cg-r6"]]`）；第 6 条一步跳完的比例 **0.07**（段外色带在毛玻璃底下被模糊，就是改前「透过段去滤段外的层」）。

看过的图：`docs/reports/assets/cut-stream/r01/stage-stream-47.png`（贴流的舞台）与 `export-47.png`（整帧活渲导出）看不出差别；`stage-nostream-47.png`（拿掉毛玻璃的流）毛玻璃那块没了、露出段里的药丸；`export-47-glass-crop.png` 毛玻璃底下绿黄分界是一条直边。

### R02 端到端：`scripts/probes/cut-online-browser-probe.mjs`

`node scripts/probes/cut-online-browser-probe.mjs --dist out/dist-online --base-port 5910 --out out/probe-b7`（整段 5910～5919）。骨架照 `cut-online-e2e-probe.mjs`：本机托管组合 + 在线构建；切分方是真的桌面预渲染进程，但 `PROMPTCUT_TEST_PLAN_ONLY=1` 只切分、不认领；场景是两层嵌套的剪辑段里一张 `punch-pill`（虚拟片段 V，钉重）；另加顶层同一张卡 T 作对照（同参数、同长度，改动之前就有的路）。

本分支：退出码 0，`fails: []`。

| 条 | 读数 |
|---|---|
| A 产 | 层表里 V 一行普通单卡流（`kind: card`、`plane: local`、没有 `streamKind`、带 `s1-` 签名），候选第一个是页面的指纹 `ec313bc687208b5c`，结果键 = 内容键 × 页面指纹；第一帧 6、分段 0～3，满密度；编码器 `["webcodecs-avc"]` |
| B 谁产的 | 页面节点 `streamTasks: 1`、`completed: 1`、`failed: 0`、`streamFrames: 60`；切分方自己那一份候选的清单一个分段都没有 |
| C 播放 | 在线来源选中页面那一份、整段就绪、没有过期；播放 32 个样本里流在画，键对、父页推的字节、0 报错；V 的嵌套包裹层一直被抑制、流平面在包裹层里 |
| D 像素 | V：播放中截的流与同一帧精确活渲，3×3 模糊后平均差 **0.383**、差得多的像素 0.002%（不模糊 0.505）；与刚入场那一帧比 4.71（对照）。T：0.565、0.002%（对照 5.24） |
| E | 页面没有未捕获的错误 |

改前（开工提交的树、它自己的在线构建）：`超时:A:层表里出现 V 的流,候选里有页面的指纹`，层表里 V 那一行只有切分方的候选 `52534eea54045f44`（它只切分、不产），15 分钟里页面一帧都没产。

这支探针调了四轮才过，过程如实记：

1. 第一轮「对照」那一帧取在往后 2 秒，已经出了 S（S 只有 2 秒），探针改取 S 里药丸刚入场那一帧；
2. 第二、三轮截到的是沙漏：从 S 中间开始播放时 S 自己在做段级的后台补跑互换，整段被抑制、露的是 S 的占位，V 的流被 S 盖着（播放 32 个样本里 21 个这样）。这是剪辑段原有的「停下就精确」那一路，不是这次改的；探针改成等 S 换回来再截。见「没做成的」第 3 条；
3. 第四轮流的画面和活渲差 1.37、字整体高约 4 像素，而顶层对照卡 T 只差 0.57 —— 浏览器生成快照时嵌套包裹层里的继承属性没内联，重放退回缺省字体。修在 `inlineStyles.ts`（`78cd20e1`），重建在线构建后过。

看过的图：`docs/reports/assets/cut-stream/r02/cut-stream.png`（播放中贴着页面产的流）与 `cut-live-same.png`（同一帧精确活渲）看不出差别；`top-stream.png` 与 `top-live-same.png` 同样。

### 回归：`cut-online-e2e-probe.mjs`（上一轮剪辑段逐卡的在线端到端，切分方认领细任务）

`node scripts/probes/cut-online-e2e-probe.mjs --dist dist-online --base-port 5910 --out out/probe-cut-online3`：第一次跑只红一条 —— 「B:在线来源选中切分方那一份」：在线来源选的是页面的指纹 `ec313bc687208b5c`。这条断言写的是 v1 的规矩（剪辑段里的卡只能由桌面产）；R02 以后切分方成对出两份（自己的、浏览器的），谁先认领谁得，这一次是页面先产出来。按 R02 改成「在线来源选层表候选里实际产出来的那一份（切分方的或页面的），键对、没有过期」，别的断言一个没动。改后重跑：退出码 0，`fails: []`；A 层表、C 播放（33 个样本 32 个在画）、D 改被引用剪辑后 6 毫秒不再发旧流平面、1543 毫秒不再判重、E 新流 1004 毫秒换上、G 长剪辑段开播 1.1 秒贴流、F 没有页面错误，都过。

## 没做成的与原因

1. **剪辑段里的源依赖卡、挂素材效果卡节点的片段、转场**：摊平视图里本来就没有它们（节点的输入按原片段 id 引用），照旧在嵌套场景里活渲、不抑制。R01 原文说的是「毛玻璃这类依赖下层的卡」，不含它们；R01 待审条目里列过它们（「转场、套在视频上的素材效果卡」），要做得给每个实例复制一份节点并改写输入，记待办。
2. **没有端到端覆盖的组合**：剪辑段里外框三维、依赖下层的卡（规则照顶层放行，单测有，没跑真 Chrome）；两层以上嵌套里的毛玻璃（单测 `CB-plan` 有更深一层剪辑段当下层，没有毛玻璃本身在第二层的端到端）；在线页面播放剪辑段里依赖下层的流（R01 探针是在宿主页里直接驱动舞台，没走在线页面；依赖下层的流本来就只由桌面应用和渲染主机产）。
3. **从剪辑段中间开始播放时，整段先被抑制**：剪辑段里有要按历史推进的卡时，S 自己走整场景后台补跑互换，补跑好之前整段露 S 的占位，段里已经贴着流的卡也被盖住（R02 探针里约 0.3～0.7 秒）。这是剪辑段原有的口径（`mechanism/rendering.md` 第 140 行），这次没改。段里的卡都有流时其实不必整段补跑，建议另开一条跟进。
4. **摊平视图的画家顺序是近似**：同一条序列里剪辑段和别的片段在时间上重叠时，摊平视图把段里的层整体放在这条序列上面。依赖下层的流的下层认定沿用它，极端情况下多算或少算一层（多算只是多作废）。原有近似，没动。

## 语义建议（只写建议，没有改）

1. 二级，`product/project-model.md` 第 31 行「剪辑段」那一条，「画面是被引用剪辑在对应时刻的整帧合成，声音是它的混音。」之后：
   - 修改前：「画面是被引用剪辑在对应时刻的整帧合成，声音是它的混音。」
   - 修改后：「画面是被引用剪辑在对应时刻的整帧合成，声音是它的混音；剪辑段里的毛玻璃这类卡只滤这条剪辑里在它下面的层，不透过剪辑段去滤段外面的层。」
   - 要用户定（用户看得出）。推翻的话：拿掉 `CutSegmentScene.tsx` 的 `clipPath`，R01 退回做不通。
2. 三级，`mechanism/rendering.md` 第 136 行「画面走嵌套场景」句末加：「嵌套场景那一层挂 `clip-path: inset(0)`，是毛玻璃的采样边界（Backdrop Root；`isolation`、`overflow` 挡不住）：裁的框与 `overflow: hidden` 相同，别的像素逐字节不变（Chrome 152 实测）。」
3. 三级，`mechanism/rendering.md` 第 144 行「哪些卡有流」整条：
   - 修改前：「〔2026-10-22 用户定要做通……下面是还没做通时的现状。〕剪辑段里的独立卡（平面的和外框三维的）各产一条单卡流，`soloStreamKind` 回 `'flat'`：不并进组流，浏览器节点和在线页面本页不产，由桌面应用、托管方的渲染服务和渲染主机产。剪辑段里依赖下层、源依赖、没审阅过的卡，以及挂着素材效果卡节点的片段，暂时不产流、不抑制，照旧在嵌套场景里活渲（v1）。」
   - 修改后：「剪辑段里的独立卡（平面的和外框三维的）各产一条单卡流，`soloStreamKind` 回 `'flat'`，不并进组流；外框平面的那些浏览器节点和在线页面本页也产（〔裁〕R02），外框三维的只由桌面应用、托管方的渲染服务和渲染主机产。剪辑段里依赖下层、没审阅过的卡带着同一个嵌套场景里的下层产依赖下层的流（〔裁〕R01）：下层只算 id 以它所在场景的前缀打头的层，按嵌套场景的坐标产（隔离工程里链上的段去掉外观、1:1 铺满画面），键另带这个前缀（`within`），贴的时候平面挂在嵌套舞台里、层序取这张卡那一层，只由桌面应用和渲染主机产。源依赖的卡和挂着素材效果卡节点的片段不产流、不抑制，照旧在嵌套场景里活渲。」
4. 三级，`mechanism/rendering.md` 第 145 行「产流」句末加：「浏览器节点产剪辑段里的卡的流时用同一个隔离工程，后台舞台按『本地帧 + 卡的第一帧』推到项目帧，在嵌套场景里取这张卡的包裹层生成快照（包裹层的直接子节点一律内联继承属性）。」
5. 三级，`mechanism/rendering.md` 第 117 行「在线页面测量时自己产的稀疏流，只给本页能单独产流的独立卡产」后补「（剪辑段里外框平面的独立卡也算）」。
6. `docs/plan/release-019-020-kickoff.md` 第 25 行「会动导出像素基线」与实际不符（演示项目没有剪辑段，逐字节相同），建议改成「不动导出像素基线（演示项目里没有剪辑段）；改到剪辑段里毛玻璃的画面，见本报告」。

## 部署要换什么

改了 `src/`、`server/`：整份 `src/` 同步进渲染树（预渲染进程、托管方的渲染服务及工作进程、渲染主机都按 `src/` 加载）；在线前端重建（父页、舞台、后台舞台生成快照、本页产流都在里面）；`server/frame-stream.mjs`、`server/card-identity.mjs`、`server/bakery/capture-below.mjs`、`server/render-node/split.mjs` 随渲染服务与桌面补丁。先换在线前端，再重启渲染服务。截图代码指纹变了，部署后所有轨道流按新键重产一次（见「身份键」）。文档服务、素材服务、Agent 服务不用换。
