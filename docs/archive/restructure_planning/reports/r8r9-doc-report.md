# R8 / R9 文档搬运报告

分支 `worktree-agent-a5a24e53787d763dc`，worktree `C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-a5a24e53787d763dc`。
开工时 `git status` 干净，`git merge --ff-only main` 从 `c98a3cc` 快进到 `048074c`。只新建了两个文件，没有改任何别的文件；没 push、没合并、没动 main、没起 dev server。

## 提交

| 提交 | 文件 | 字节 |
|---|---|---|
| `43381c0` | `docs/plan/r8-streams-task.md` | 32592 |
| `774ef34` | `docs/plan/r9-webgl-task.md` | 38208 |

术语检查：两份文件里「预渲染」「冻结」计数均为 0。

## 折进去的第 75 轮条目

### r75-05「第 4 步·轨道流」→ `r8-streams-task.md`

| 条目 | 落在哪一节 |
|---|---|
| 阻塞 1 偶数宽高 + 索引记 `rect` | G1「裁剪矩形怎么取」；G3 加了「宽高已是 G1 外扩过的偶数，滤镜链不再取整」 |
| 阻塞 2 透明区 RGB 渗边 → 预乘 | G3 公共命令块首句 + 「色半区存预乘色」整段；G5「色半区是预乘色，按 `premultipliedAlpha: true` 输出」 |
| 阻塞 3 单卡流像素隔离 | G4「单卡像素怎么隔离」（隔离工程 + `captureFrame` 加 `clip` 矩形）；裁剪矩形取法在 G1，标了待 G0-b (10) |
| 阻塞 4 组流平面命中与实体框 | G1「组流平面的命中与实体框」 |
| 非阻塞 3.1 补 `-c:v` | G3 的编码器参数表 |
| 非阻塞 3.2 各编码器严格 GOP 分列 | G3 的编码器参数表（四行） |
| 非阻塞 3.3 色彩标注待实测背书 | G3 末条「待 G0-b (5) 验色差」 |
| 非阻塞 3.4 Node 端按 MP4 box 切 | G2「谁来剥 `init.mp4` 和 `mfra`」 |
| 非阻塞 3.5 `leaseStreamBakery` / `returnStreamBakery` | G4「会话从哪来」 |
| 非阻塞 3.6 两处描述不准 | G4 第一步（`frameWindow` 在 `warmUp` 里也用）与「会话从哪来」末句（`installFrameMedia` 是导出页自己装的） |
| 非阻塞 3.8 解码帧预算按字节 | G5「解码帧预算按字节算」+ 验收「解码与播放」那条 |
| 非阻塞 3.7 | 是五条「走查合格」记录，不是修改意见，无可折内容（已在「本文没带走的内容」第 14 条说明） |
| Opus-A G0-a 三项结论 | G0「G0-a 纯探针——已过（2026-09-19）」整节 |

### r75-06「第 4b 步（M1～M6）」→ `r9-webgl-task.md`

| 条目 | 落在哪一节 |
|---|---|
| 阻塞 1 契约拆两半 + 注册表 + 模块 Worker | M1 前三段（`CardDef.canvas` / `<id>.gl.ts` / `programs.ts`）；M2 的能力退路也 import 同一张表 |
| 阻塞 2 三种 kind 共用 `textures`、三层缓存 | M1「`textures` 三种 kind 共用」+ 三种契约表的签名 |
| 阻塞 3 MSAA FBO、上下文属性、M5 像素口径、探针先验 | M2「统一的画法」；M3「Worker 一拍做什么」与末尾探针段；M5 末条 |
| 阻塞 4 一拍顺序写死 | M3「一拍的顺序写死」六步 + `settle` 微任务的位置 |
| 阻塞 5 导出页 `beat` 触发点 | M3「导出页的 `beat` 发在哪」 |
| 阻塞 6 三张用户卡的来源与归属 | M5 第一条（runtime 绝对路径、拷进仓库、是否入库由用户定、没迁移的照旧能跑） |
| 阻塞 7 `dom2d` 签名 | M1「第四种 `dom2d` 不带函数」 |
| 阻塞 8 验收分路线写、20 张卡的来源 | 验收前两条 |
| manager 补 ① `stageId` 与角色脱钩 | M2「`stageId` 必须与角色脱钩」（含今天的三处落地反例与改法） |
| manager 补 ② `glRoute` 取生效路线 | M2「写进 `costs` 的 `device`」 |
| manager 补 ③ `.pc-settling` 回指 K5、gl 平面不在放过名单 | M3「主线程收到 `done` 之后」 |
| 非阻塞（M2 回指约束） | M2「两条路线同时实现」那段的括注 + 约束第 1 条 |
| manager「未采纳、供主 Agent 裁断」的一条（M2 结尾主语缺失的长句） | 拆成两段（`device` 去重 / 图集画布由 `glHost` 建），语义未改；见下面「需要定的问题」第 3 条 |

## 2026-09-22 之后的事实，落在哪

- **生成快照改名拆分**：R9 的 M4 整段改写到 `rasterizeCanvas.ts`；`__bfFreeze` / `freezeScene` / `snapshotFreeze.ts` / `freezeCode` / `FrozenScene` 在两份文件里都不出现。`createSnapshot` 的五步、`window.__pcCreateSnapshot`、`SceneSnapshot` / `ControlSnapshot` 写进 R9 的「读法」。
- **`rasterizeCanvas` 是唯一要改的文件**：写进 M4「位图格式不变」末句。
- **`frameMs` 删除、判重只看 `stepMs`**：R9 的 M4（`stepMs` = 主线程 + `beat → done` 往返 + GPU 的最差值）和 M2 低内存档两处都换了名。R8 的 G4 里 `frameMs` **保留**，因为它是生产侧每帧耗时、与 `planPlaybackBatch` 的同名参数同口径（`server/frame-playback.mjs:3` 核过），已加口径注说明它和成本记录字段不是一回事。
- **像素映射 WebGL2 后端并进共享渲染器**：R9 新增 **M7**，写明契约不变（`drawPixelMap` / `readPixelMap` / `compilePixelMapGlsl` 签名和像素结果都不动）+ 验收用 `pixelmap-gl-probe.mjs` 八个用例对齐。
- **画布位图换 webp 搁置**：M4「位图格式不变」明写「已搁置（用户 2026-09-22），没有新的指示不要做」，「不做」清单也有一条。
- **粒子卡不迁 Worker、长粒子片段走轨道流**：R9 的 M5 第三条（`dom2d`）；R8 的 G1「粒子卡」段（超过约 8 秒按 K2 追帧上界判重、交给轨道流）。
- **G0-b 未定稿**：R8 里逐处标注「待 G0-b 原型定稿」的有 6 处——解码器预算初值 6（G1 两处、三个数的关系一处）、`streamPool`（G1）、`stride` 可取值（G2）、NVENC / QSV / AMF 参数（G3）、色彩标注（G3）、裁剪矩形取法（G1）、解码帧预算数字（G5）、`streams` 默认值（G0 表）。G0-b 的交付项在 G0 做成了一张表。
- **解耦后的路径**：`export-frames.mjs` 全部换成 `server/bakery/bake.mjs` / `chrome.mjs`；`Stage.tsx` 在 `src/render/`；`snapshotFreeze.ts` → `createSnapshot.ts` + `snapshot/`；两份文件各有一张只列本文件用到的路径缩写表。

## 行号核对

**两份文件里的 `文件:行号` 全部是在当前 main（`048074c`）上打开核对过的，没有一处标「b5c65dc 的行号，仅作提示」**（读法一节保留了这个标注约定，以防后续编辑加入未核对的引用）。核过的引用共 **46 处**：

- R8（19 处）：`bake.mjs:28` / `:81-83` / `:90-92` / `:125` / `:175` / `:189-192` / `:200` / `:309`；`capture-frame.mjs:18`；`frame-pipeline.mjs:195` / `:256` / `:855`；`frame-playback.mjs:3` / `:23`；`solid.ts:165` / `:167` / `:197`；`stageRpc.ts:145`；`frameMedia.ts:11` + `ExportView.tsx:27` / `:55-57`；`docs/async-track-playback.md:52` / `:55-71` / `:73-78`。
- R9（27 处）：`createSnapshot.ts:137`；`rasterizeCanvas.ts:33-66` / `:45` / `:49`；`StageView.tsx:73` / `:180` / `:585`；`Stage.tsx:135` / `:175` / `:177`；`solid.ts:102`；`solidMode.ts:138`；`stageRpc.ts:322` / `:329` / `:330`；`frameReady.ts:6`；`bake.mjs:175` / `:269`；`frame-pipeline.mjs:160` / `:229`；`ExportView.tsx:156` / `:168`；`Preview.tsx:607`；`stage-rpc-probe.mjs:76`；`probe-card-costs.mjs:94` / `:191` / `:433`；`project.ts:260`；`pixelMapGl.ts:90` / `:195-199` / `:224`；`src/cards/user/index.ts:14-25`；`particles.tsx:128` / `:169` / `:209` / `:232-236` / `:235`；`scene-3d.tsx:152`。

新建文件（标「新」）：`server/frame-stream.mjs`、`src/render/streamPlayer.ts`、`src/render/gl/{CanvasCardProgram,glWorker,glHost,programs}.ts`、`scripts/probes/gl-atlas-probe.mjs`。已确认它们在当前 main 上都不存在。

**核对中发现的行号漂移**（源文本与第 75 轮报告里的 `b5c65dc` 行号，本文已按当前值写）：`FrameScene.tsx` 的活跃判据 `:76` → `:86`、`legacyTimeline` `:77` → `:87`；`snapshotFreeze.ts:71-94` / `:78` → `rasterizeCanvas.ts:33-66` / `:49`；`export-frames.mjs:610` / `:704` → `bake.mjs:175` / `:269`；`stageRpc.ts:293`（`stageId`）→ `:330`；`Stage.tsx:187-200`（代理平面）→ `:191`。

## 与 pinned 冲突或内部矛盾

1. **pinned 渲染 3 里还写着 `frameMs`**（「优先吸纳单帧最便宜（frameMs 最小）的卡入轻管线」），而 pinned 渲染 5 已按 2026-09-22 的确认改成「判重只看活渲耗时（不含生成快照）」，代码里 `frameMs` 字段已删、只剩 `stepMs`。两条 pinned 自身措辞不一致。本文一律用 `stepMs` 并在 R9 的 M4 加了一句解释；**pinned 渲染 3 的措辞要不要同步，由主会话 / 用户定**。
2. **pinned 渲染 10 首句与路线 2 对不上**（「每个舞台文档只开一个 WebGL 上下文……在交互界面的舞台 iframe 里开的一个 Web Worker」，而同段后文的路线 2 把上下文放在父页）。这是第 75 轮第 6 份已经提给用户的建议（fold-notes 里标「转 reply，不自行采纳」）。本文按 pinned 后文的两条路线写，验收分路线写，**没有改 pinned**。
3. **`stageId` 的落地口径与 M2 直接冲突**（`stageRpc.ts:330` 缺省 `"front"`、`Preview.tsx:607` 写死 `id=front`、`stage-rpc-probe.mjs:76` 断言 `'back'`，都是角色名）。这是 manager 补 ① 的内容，已在 M2 写明改法（E1 落地时改成 `id=A` / `id=B`）——**改的是 R2 的范围，不是 R9**，R9 只依赖它。主会话要确认这条落进 `docs/plan/r2-r7-task.md` 的 E1 了没有（我不改那个文件）。
4. **样板 `docs/plan/r2-r7-task.md` 本身复查过，没有发现残留**：`frameMs` 只出现 1 次（K1 里说明这个字段已删的那一句）、`snapshotFreeze` 只出现 1 次（路径缩写表里的「R1 之前叫」），`__bfFreeze` / `freezeScene` / 「预渲染」/「冻结」计数为 0。R8 / R9 与它的口径一致。

## 需要主会话 / 用户定的问题

1. **`stride` 只能取 15 的因数**。G2 要求「一个分段的样本数必须恰好 15」，稀疏分段又是「每张 PNG 连续喂 `stride` 次」，两条合起来 `stride` 只能是 1 / 3 / 5 / 15。这是 `agy-r75-05` 的「manager 另外注意到、但未立条」（该报告第 F 节），fold-notes 里没有采纳意见。我在 G2 里写成了「注意 + 待 G0-b (8) 定稿」，没有替用户定死。
2. **G4 的 `frameMs` 保留还是改名**。它和成本记录里已删的 `frameMs` 同名但不同物（生产侧每帧耗时，`planPlaybackBatch` 的同名参数）。我选择保留原名并加口径注，另一个选项是改名成 `streamFrameMs` 之类。请定。
3. **M2 结尾那句长句的拆法**。原句「…写进 `costs` 的 `device` 字段一起去重，把一张 `OffscreenCanvas`（图集，…）`transferControlToOffscreen` 过去；Worker 持一个 WebGL2 上下文。」主语缺失、两件事拼在一起（manager 在 `agy-r75-06` 第 4 节末尾记了「供主 Agent 裁断」）。我按「`glHost` 建 Worker 时把图集画布 transfer 过去」拆开，没有加新事实，但这是一次解读，请确认。
4. **R8 / R9 在 `docs/plan/README.md` 和 `render_pipeline_restructure.md` 第 5 节里的索引**没有加（按指令索引由主会话改）。
5. **G0-b 原型回来后要回填的地方**：R8 里 8 处「待 G0-b 原型定稿」标记 + G0 的交付项表 + 验收里「数字以 G0-b 实测为准」那句。
6. **`gl-atlas-probe.mjs` 还没写**，它是 R9 的第一件事；如果探针的 MSAA 那一条不成立，M2 / M3 的画法要重定。
