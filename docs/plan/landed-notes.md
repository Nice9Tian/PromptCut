# 已落地部分留下来的验收口径和「不做」条目

旧任务书（`AGY-TASK-cloud-doc-and-write-race.md`，第 111 版）在 2026-09-22 按用户的决定整体舍弃：还没做的工作分别搬进了 `r2-r7-task.md`、`r8-streams-task.md`、`r9-webgl-task.md`、`cloud-task.md`。这一份收的是**已经落地的那几步**（能力审计、素材按哈希寻址、快照格式、镜像插件、挂载算式、舞台 RPC、JS 图卡）在旧任务书里留下的验收口径和「不做」条目——代码已经在了，细节以代码为准；这些句子留着，是为了以后改到这些地方时知道当初的验收线和明确不走的路。原文照录，只换了已经改名的标识符和用词；`文件:行号` 是提交 `b5c65dc` 的，仅作提示；「第 N 步」是旧任务书的步骤号（第 1 / 2 / 2b / 3 步 = 已落地，3b = R1，第 4 步 = R2～R9，第 5～10 步 = `cloud-task.md`）。

## 验收口径

- A0（第 1 步已落地；`unknown` 计数与旧 `.proc` 项开工前重跑）：89 张里 `unknown` 为 0；粒子卡全部 `canvasHeavy`；打开旧 `.proc` 不被拦；Agent 经 `edit_card` 改内置卡或用户卡新增 `independent` 被拒、只改文案不被拒；`create_card` 带 `independent` 被拒；高频清单审完。
- A2（第 2 步部分——已落地，含 A2(4)；A2(8) 的验收在 A2 正文）：含素材项目和含图片卡项目都走 HTML 重放，像素逐字节相同；**control 快照的 `html` 是包裹层的 innerHTML，不含 `data-pc-clip`、不含 `[data-pc-proxy-plane]`、不含素材层，id 保持原样**；**消费侧改名函数（A2(7)，独立模块 `src/render/snapshotRename.ts`，导出 `renameSnapshotIds(html, clipId)`）的单测**：同一份 control `html` 用两个 clipId 各改一次，两份结果的 `[id]` 和 `url(#…)` / `href="#…"` 引用各自带各自的后缀、互不相同，`growth-curve` 的渐变 id 也在内；挂到舞台上的表现（两片段不串、快照与活组件位置一致）在第 4 步验（见 D5 + E + E7 那条）。
- A3（键与目录形状已落地；求交与 `cacheable` 放行在第 4 步）：共享键对 x / y、不透明度、motion、**clipId** 不敏感（同一张卡两个片段、同参数同框宽高，键相同），对参数、源码版本、时长、相位、**框宽高（两个片段框宽高不同 ⇒ 键必须不同，因为快照内联的是使用值）**、画幅、`camera3dFov`、parts、生成快照的代码、审阅表内容敏感；同一共享快照挂到两个不同位置的片段上，各自画在自己的框里，三维卡透视正确；毛玻璃卡有本地快照且不上云；B 机首次打开 A 机预渲染过的项目不起历史推进即显示 `independent` 卡。A3c 三条上限写进本节并对高频清单实测过。
- A7（第 2 步——已落地）：请求体不含 `project`；没有 Agent 连接时编辑页预览正常、只读页不推镜像；两个编辑页标签互不覆盖；杀掉预渲染进程再拖，它按键从编辑器拉回；改主题、换素材、改画幅、改素材段 `mediaOffset`、切轨道 `hidden` 后立刻要帧得到改后画面；暂停时拖播放头后 Agent `see_frames` 看到新播放头；拖动片段 2 秒期间推送次数 ≈ 取帧往返次数、每次 ≤ 8 KB、409 为 0；拖一个片段时哈希只重算 1 个 clip + 1 条轨道，每次 ≤ 2 ms。
- C1（已落地）：`grep` 排除注释后 `CARD_MOUNT_LEAD` 只剩 `frameWindow.mjs` 和 `frameWindow.d.mts` 两处（`FrameScene.tsx:76` 本来就没有它，`:76` 不动）；`frameWindow.d.mts` 有 `mountFrameOf` 的声明、`npm run build` 通过；`onFrameGrid` 不存在；改后全长导出逐字节相同。
- 第 3 步（E0 + `data-pc-scene` + `solid.ts` + A2(4) + D4 页面侧——已落地，`scripts/probes/stage-rpc-probe.mjs` 与 `editor-preview-smoke.mjs` 全过）：RPC 全部正常（此时仍同源；跨源在第 4 步 E1 之后复验同一组用例），所有时间参数是秒；**暂停时拖播放头 60 次（含往回拖和跳 60 秒），可见舞台的 `playToken` 不变、卡片组件实例不变、每次 `setTime` 主线程 ≤ 5 ms（回包 `path: 'set'` 的那些；向前不到 `CONTINUOUS_MAX` 的 `path: 'continuous'` 例外走同步 `advanceTo` ≤ 30 步，不计）**；**`render` 在第 3 步只验方法本身**（第 3 步单舞台是 `front`、`Preview` 不发 `render`，用测试页对它 `setRole('back')` 后直接调）：Promise 在推帧完成后才 resolve、回包带 `remounted`、`caughtUpAtSec` 和 `elapsedMs`，两次连发第一次回 `{ aborted: true, reason: 'superseded' }`；打断后的重发策略在第 4 步验；播放中定时器的 `rectsWithBounds({ pixels: 'selected' })` 在 17 轨 × 10 卡下 ≤ 5 ms、只对选中的卡调 `getImageData`，选中的三维卡描边框在悬停和点击后不跳；canvas 换成的 `<img>` 带 `data-pc-painted-box` 且坐标是画布像素坐标；`grep -rn "__pcPreviewStage" src` 无结果；`grep -n "pc-stage\|document.querySelector" src/StageView.tsx src/render/solid.ts` 排除 `StageView.tsx:568` 那条解释性注释（HEAD 上唯一命中，`document.querySelector` 出现在注释文字里）后无结果；第 3 步结束时（舞台仍渲 `Stage`）`hitTest` / `rectsWithBounds` 照常工作，一次刷新选框只有一次往返；点画布后立刻拖动不丢起点；`contentBox` 是数字；**经 `/api/cards/layout`（快照里 canvas 已换成带 `data-pc-painted-box` 的 `<img>`）三维卡和粒子卡的 `contentBox` 不是整块画布**；`get_layout` 30 个片段只发一次请求、只触发一次预渲染渲染；MOV 已命中的帧调 `get_layout` 仍能返回；`set_position` 端到端 ≤ 150 ms、不触发任何渲染、返回值没有 `contentBox`；五条工具描述已改；素材段的 `contentBox` 等于其 `frameCss` 框；`mcpExecutor` 里只有 `get_layout` 是 `await`，四个写工具仍同步；`window.__pcSolid` 在预渲染页可调；`checkCardSource` 三个调用点都显式传 `mode`；第 2 步已验过 `url(#id)` 的序列化形式并据此定了正则。

## 不做

- 字体随包分发、像素缓存（PNG / MOV / 轨道流）上云。
- 毛玻璃卡进流、场景流。
- 全量 `stableJson` 每次推送都算一遍。
- 保留 Python 卡运行时的任何一部分（`promptcut_cards`、LPAC runner、`/api/card-runtime`、`PythonCard`、`cardAudio.ts` 的 fetch 路）；把它们改成「可选」而不是归档。
- 图卡源码存进项目 JSON（图卡和 TSX 用户卡一样是 `src/cards/user/<id>.tsx` 文件，走内容库同步）。
- 图卡输入接 DOM 卡（第一版只接素材节点和图卡节点；`apply_card` 对 DOM 卡输入报错）。
- 图卡的 GLSL 里写符号时间表达式（`card()` 每帧在页面里跑，直接算成数字；`Expr` 类型保留但不推广）。
- 音频图卡输入边上的播放速率 `playbackRate ≠ 1`（第一版报错；重采样另开任务）。
- 向前兼容 Python 卡（滤镜、转场、音效在内）：旧 `.proc` 的 python 定义和节点加载时丢弃，不做占位卡、不做 `list_cards` 提示、不自动翻译。
- 同一片段同时挂音频图卡和视觉图卡（`apply_card` 报错「先复制片段」）。
- 在浏览器里 `decodeAudioData` 整份素材给 `sources.block()`（走 `/@media/<hash>/pcm` 的 ffmpeg 裁）。
- 图卡在源码里声明 `compositing`（只认审阅表，A0.2）或 `canvasHeavy`（第一版不给）。
- 图卡定义存进 `project.cardDefinitions`（从注册表 `getCard` 取）。
- `apply_card` 建的片段不带 `cardId`（`flattenOverlay` 会跳过它）。
- 把 Node `Buffer` 版的 `wavFloat32` 搬进 `src/`（用 `cardAudio.ts` 已有的 `wavOf`）。
- 归档测试文件（`cardGraph` / `cardAuthoring` / `cardAudio` / `card-identity` / `vision-project` / `frame-playback` 的用例改写成图卡，不归档）。
