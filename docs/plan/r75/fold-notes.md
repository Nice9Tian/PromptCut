# 第 75 轮折叠笔记（主 Agent 自用；全部 13 个任务回来后统一落盘成第 112 版）

规则：任务书在全部 Agent 结束前不动（有人按行号读）。这里只记「采纳 / 不采纳 + 改哪一句」。

## r75-07 第 5 步（A1 上云、A3b、A5、A6）—— 9 阻塞 / 2 非阻塞，manager 已核原句无编造

1. **采纳** `uploaded` 单值 vs 两档：落地类型是 `MediaTiers { small?: string; original: string }`（`src/kernel/project.ts:115-118`，哈希字符串）。不动 `tiers`，把 `uploaded: boolean` 改成 `uploaded?: { small?: boolean; original?: boolean }`（只在云端模式有）；L103 里三处 `uploaded` 口径统一（含「`uploaded` 翻真」的验收 L310）。
2. **采纳** 上传端点：全部走分片（固定 8 MB，小于 8 MB 就是 1 片）`PUT media/<hash>/<n>`；`GET media/<hash>/chunks` → `{ size, chunkSize, received: number[], complete }`；`POST media/<hash>/complete`（服务端校验 sha256，不符 409）；删掉整件 `PUT media/<hash>` 的说法。
3. **采纳（与 7 合并处理）** 内容库没有接口形状：在组件表「内容库」行 + D1/D2 给出 WS 消息形状（等 r75-08 的报告一起定）。
4. **采纳** 不上云的块在清单里的表示：清单 = `{ key, frames: Array<[localFrame, blockHash]>, skipped: Array<[from, to]> }`，`skipped` = 已产但故意不上云（`data:image` 过半）的本地帧闭区间；下载端见 `skipped` 就走本地预渲染、不等。
5. **采纳（轻）** `playbackUrl(media, localHashes, opts?: { cloudBase?: string })`：给了 `cloudBase` 返回绝对地址。
6. **采纳** A3b 下载落盘要更新 `index.json`：落盘走 `snapshot-store.mjs` 的同一个写入函数（写文件 + 更新 `index.json`），C3 才算就绪。
7. **采纳（结构）** 顺序倒置：A6 本地模式、A3b 的清单都要本机文档服务（第 6 步）。改顺序表：第 5 步 = A1 上云部分 + A3b 的块上传 / 下载 + A5；**A6 和 A3b 的清单读写挪到第 6 步**（与本机文档服务、内容库同一步）。F1/F3/F4 与 L 的依赖描述同步。
8. **采纳为澄清（非阻塞）** `.procp` 只打包原片（`tiers.original`），小分辨率版是可再生派生物、不进包。
9. **不改 pinned；采纳一个功能性修正** 原片 `-c copy` 与 pinned 架构 1「H264 流式传输」：我的读法——H264 指先传的小分辨率流式版，「原素材版本」就是原片原编码（转码会破坏「导出只用原片」和像素基线）。但有真问题：原片不是浏览器可放的编码时「换档到原片」会把预览换坏 → L103 加：导入时探一次可放性，`media[i].playable === false` 的素材预览永远停在小分辨率版、不换档。**写进 reply_to_users_goal.md 请用户确认读法**（审查者建议放宽 pinned 架构 1 的措辞）。
- 非阻塞 a **采纳（轻）** `GET /api/media/local?hashes=` 超过 100 个哈希分批问。
- 非阻塞 b **采纳** A5 加一句：块级的「`data:image` 过半不上云」（A3b）与卡级的 A5 是两层，先按 A5 卡级判、再按 A3b 块级判。

## r75-10 第 9 + 10 步（F1 / F3 / F4、L）—— 4 阻塞 / 5 非阻塞，manager 已核原句，更正 1 处证据（K5 三态）

1. **采纳** F3 在浏览器模式没有本地内容库：L206 加范围句——F3 的「离线导入落本地内容库、恢复后补传、`.procp` 交换」只对有本机进程的宿主（桌面版）；在线浏览器模式离线时：操作日志攒 IndexedDB、恢复后同一套重放规则；**素材导入按钮置灰**（提示「离线时不能导入」）；`.procp` 导入 / 导出第一版不支持（进不做清单）。
2. **采纳** 本地内容库的 GC：L204 补——本地模式不自动回收（素材真身，只在用户显式「清理未引用素材」时删）；云端模式按 LRU + 配额（默认 20 GB，可配）只淘汰「两档都已 `uploaded` 且当前打开的项目不引用」的条目，上传队列里的永不淘汰。
3. **采纳** F4 `projectRev` 往返归零：改成——本地 → 云端：文档云端没有这个 projectId 就新建、`projectRev` **沿用本机文档服务的当前值**（不归零）；云端已有同一 projectId 就带 `expectedVersion`（= 上次从云端拉下来时记的 `projectRev`），不等走 B2 备份 + B3 通知，由人决定覆盖还是另存为新项目。（落盘前对一下 L87「三个版本号」的说法。）
4. **采纳，改 L277 不改 L400**：浏览器模式下「canvas 重卡活渲」违背 pinned 渲染 7（重卡播放和拖动只贴死素材、缺就透明）、pinned 平台（无流按拍换快照）和不做 L400。改成：canvas 重卡与 DOM 重卡同一规则——按拍换快照（快照里 canvas 已是 `<img>`），实测换帧成本装不下就透明，暂停照 K5 追到活渲；并说明 M 之后 canvas 卡的主线程成本很小、多数位置判轻，这条只落在 `dom2d` 粒子和没有 Worker 退路的设备上。
- 非阻塞 a **采纳** L279 验收补两条断言（L365 的「该模式暂不支持自定义卡」提示、L366 的「该模式暂不支持素材输入的音频图卡」报错）。
- 非阻塞 b **采纳** L275 IndexedDB 键用数组复合键 `[kind, key, localFrame]`，不拼斜杠。
- 非阻塞 c **采纳** `subscribeReady` 由 L2 的每次写入触发，不管写入来自 L1 的后台 iframe 还是 L3 的云端下载。
- 非阻塞 d **采纳** `DEAD_MS` 标量 vs 每卡实测换帧成本：`planPipelines` 的 `opts.deadMs` 放宽成 `number | ((identityKey) => number)`；浏览器模式传函数，背后是只在本次会话生效的 `swapMs` 表（不进 `costs`）。（落盘前读 L187 / L188 对措辞。）
- 非阻塞 e **采纳** L278 给出 `StreamSource` 的签名（对齐 G5 / G6 的索引与分段命名；落盘前读 L231 / L232）。
- 对 pinned 无建议。

## r75-09 第 7b + 8 步（I、D3 预渲染部分）—— 4 阻塞 / 3 非阻塞，manager 已核

1. **采纳** 第 8 步没有接口面（L141 末句）：补——`captureSnapshot` 的 `afterFonts` 钩子（和 `/api/cards/layout` 同一个）里 `page.evaluate` 调 `window.__pcSolid.rectsWithBounds({ pixels: 'all' })`，根传 `#pc-frame-snapshot [data-pc-scene]`；D3(c) 的 `__pcSolid` 清单补上 `rectsWithBounds`（E0 已写「导出面同样含 `rectsWithBounds`」，落盘前对 `solid.ts:267` 的 `solidApi` 实际导出）；`see_frames` 每帧结果加 `rects: Array<{ clipId, box: [x, y, w, h], solid: [x, y, w, h] | null }>`（舞台像素坐标），工具结果的文字部分按 clipId 一行列出。
2. **采纳** AI 菜单插队在 background 链空闲时没人接（L254 (b2)）：补——`background` 链上没有批在跑时，插队项自己走 `acquire('background')` 直接跑；有批在跑才进插队队列、在批边界交接。
3. **采纳（撞 pinned 架构 5）** 拆分模式下 `/api/ai/visual/gif/*` 被划进 `'agent'` 角色：L254 (c) 加例外——用户点开的 `GET /api/ai/visual/gif/<key>.gif` 走 `'user'` 角色（`lane: 'background'` 插队）；模型的 `get_gif` 工具调用走 `'agent'`。同段把 `/api/cards/layout` 从「用户的路」挪到「Agent 的路」（与 D4、(b2) 末句「只服务 Agent 的 get_layout」一致；r75-08 非阻塞 8 同源）。
4. **采纳** Agent 查询侧的镜像键：L250 / L254 (c) 补——Agent 服务端的查询（`see_frames` / `get_gif` / `inspect_card_dom` / `get_layout`）请求体带 I2 推送时的同一对键 `{ session: agentId, localRev: 刚 ack 的 projectRev }`，先推到 200 再查；`agent` 模式不回拉，键不在回 409 `MIRROR_MISSING`，Agent 服务端重推一次再查。（r75-08 阻塞 1 同解：`/api/cards/layout` 的 body 不改。）
- 非阻塞 1 **采纳** `/api/cards/dom` 借 `agent` bakery 后 10 分钟空闲计时器：干完活调 `release('agent')`，`release('agent')` 由「早退」改成「只重置空闲计时器」。（落盘前读 L248。）
- 非阻塞 2 **只改措辞，不采纳改法**：专用 Chrome 只接单帧任务是刻意的（保证 Agent 等待上界 = 一帧，pinned 架构 4「不打断正在跑的那个」）。把「Agent 没活时预渲染也用得上全部 Chrome」改成「Agent 没活时这个 Chrome 也不空着（接锚帧和 `wanted` 单帧）」。
- 非阻塞 3 **采纳** I0 验收补：`full` 模式在 Ubuntu 22.04 上也跑一遍（pinned 平台末句把 `full` 算进 Agent 端）。
- 对 pinned 无建议。

## r75-08 第 6 + 7 步（D1、D2、D4 服务端侧、B）—— 5 阻塞 / 8 非阻塞（manager 建议非阻塞 8 升阻塞），manager 脚本核 28 组引用全过

1. **采纳为口径，不改端点** `/api/cards/layout` 的 `{ session, localRev }`：Agent 侧用 I2 的那对键（见 r75-09 第 4 条）。
2. **采纳后半条** 项目级的通知未定义：澄清 B4 只约束 **Agent 的写工具**（页面的在线操作不带期望版本、按到达顺序落地；离线重放第一条例外见 F3）；项目级没有「写入者列表」，被拒的一方从拒绝回包拿 `since: Array<{ rev, actor, opSummary }>`（期望版本之后落地的每个操作），Agent 工具把它原样放进工具结果。
3. **采纳** D2 事件推送方：L69 改成「向文档服务提交操作级事件（D2；由文档服务经那条 WebSocket 推给页面）」。
4. **采纳** 「按事件 id 拉」没有接口：走内容库——Agent 服务端把完整参数作为 `kind: 'event-detail'` 的小件 `content.put`，页面展开时 `content.get({ kind: 'event-detail', key: 事件 id })`。**内容库协议一并定义**（r75-07 第 3 条）：同一条 WebSocket 上的 `content.put { kind, key, body }` → `{ ok, hash, rev? }`、`content.get { kind, key }` → `{ body, hash, rev? }`、`content.list { kind, prefix? }` → `Array<{ key, hash, rev? }>`；`kind` ∈ `'card-source'`（按 `cardRev`）| `'snapshot-manifest'`（键 = 共享键）| `'event-detail'`。
5. **采纳** `message_ignore(cardId)` 的归属：Agent 服务端的工具（不进 `MIRRORED_TOOLS`）→ WS 消息 `{ type: 'card.unfollow', cardId }`；人类的「不再提醒」发同一条消息。
- 非阻塞 1 **澄清** 备份路径：备份由接收方客户端在换成新版本前自己做，路径由它自己补进气泡 / 收件箱条目，文档服务的通知不带路径。
- 非阻塞 2 **采纳** 「云端版本」→「文档服务上的最新版本」。
- 非阻塞 3 **采纳（收窄）** B6 被锁方：对这张卡**源码**的写工具（`edit_card`、`create_card` 的 `overwrite`）都拒；定位类工具写的是项目 JSON，不在锁的范围。
- 非阻塞 4 **采纳** L142 首次出现 `MIRRORED_TOOLS` 处加一句定义（`vite-plugin-ai.ts:207` 那张「服务端直接执行、不经页面」的工具表）。
- 非阻塞 5 **采纳** D1「留在页面的工具」给判据：只读页面独有状态、不写项目也不写卡片的那些（选区、播放头交互、面板 UI）。
- 非阻塞 6 **采纳** 锁状态变更也记进操作日志（`type: 'lock'`），崩溃恢复靠重放。
- 非阻塞 7 **采纳** L322 的 v5 / v6 / v7 写明是 `cardRev`。
- 非阻塞 8 **采纳（按阻塞处理）** `/api/cards/layout` 的模式归属：只在 `agent` / `full` 模式（借 `agent` lane），`user` 模式回 `503 NO_AGENT_LANE`；L76 把它从「以上是 `user` 模式」的清单里挪出来；L142「新端点」改成「端点（b5c65dc 已落）」；L254 (c) 同步（见 r75-09 第 3 条）。
- **对 pinned 的建议（转 reply）**：pinned 架构 1「单词操作块」疑为「单次操作块」的错字。

## r75-06 第 4b 步（M1～M6）—— 8 阻塞 / 1 非阻塞 + manager 补 3 条前置接口形状不符；结论「不能直接动工」。manager 核 27 处源码引用

1. **采纳（根本性）** Worker 拿不到函数：契约拆成两半——`CardDef.canvas = { kind, programId }`（主线程，可序列化）+ **独立模块** `<卡文件同目录>/<id>.gl.ts`（不 import React / DOM），导出 `program`（`uniforms` / `build` / `draw` 这些函数在这里）。Worker 用模块 Worker（`new Worker(new URL('./glWorker.ts', import.meta.url), { type: 'module' })`）+ 注册表 `src/render/gl/programs.ts`（`import.meta.glob('../../cards/**/*.gl.ts', { eager: true })`）按 `programId` 取；主线程退路（能力检测不过）import 同一张注册表。用户卡的 `.gl.ts` 在本地模式由 vite 照常服务；在线浏览器模式只有内置卡（L365）。
2. **采纳** three / 2d 没有纹理声明位：`textures?: Array<{ name, mediaId | url }>` 提到三种 kind 共用；Worker 按 `mediaId + tier` 缓存**解码后的 `ImageBitmap`**，`gl` 支再缓存 `WebGLTexture`，`three` 支缓存一份 `THREE.Texture`（同一个 renderer 下多张卡传同一个实例 → 只上传一次），`2d` 支直接给 `ImageBitmap`；`build(THREE, params, { textures })` / `draw(ctx, t, params, { images, reset })`。
3. **采纳并加码** 路线 2 的 FBO 没有多重采样：两条路线统一成同一条画法——上下文 `{ alpha: true, antialias: false, premultipliedAlpha: true }`，每个图集画在**多重采样 FBO**（`renderbufferStorageMultisample`，samples = min(4, MAX_SAMPLES)）上，`blitFramebuffer` 解析到不带抗锯齿的默认帧缓冲再裁位图（WebGL2 不允许往多重采样的绘制缓冲 blit，开了 `antialias` 的默认帧缓冲就是多重采样的）；three 支用 `WebGLRenderTarget({ samples })`。M5 的像素口径改成「与迁移前相比允许抗锯齿边缘差异，非边缘像素 ≤ 1/255」；`gl-atlas-probe.mjs` 第一件事先验「MSAA FBO → blit → `createImageBitmap`」两条路线都成立。
4. **采纳** 「等 `done`」卡在一拍的哪里：M3 / K4 写死一拍的顺序——(1) `clock` 推到下一拍、`flushSync(setT)`、`pinner.sync`（DOM 提交完）→ (2) `glHost.beat(t, cards)` → (3) `await done`（慢帧就等在这里）→ (4) 位图 `transferFromImageBitmap` 到各平面、写 `data-pc-gl-frame` → (5) `await realRaf()` → (6) post `frame`。`settle` 的 `queueMicrotask` 在 (1) 之后、(3) 的 await 恢复之前跑，互不依赖。
5. **采纳** 导出页的 `beat` 触发点：`ExportView` 在 `__pcSetT`（`ExportView.tsx:156`）触发的那次重渲染的 `useLayoutEffect`（依赖导出时间）里调 `glHost.beat`，同一处 `beginFrameWork('gl')` 领票。
6. **采纳** 三张 three.js 用户卡不在仓库：M5 写明它们在用户机运行时副本 `C:\Users\admin\AppData\Local\PromptCut\runtime\app\src\cards\user\`；执行者拷进仓库 `src/cards/user/` 迁移和验收，迁移后的源码放进交付说明、是否入库和放回 runtime 由用户定；**没迁移的旧 canvas 卡（自己建上下文）照旧能跑**（当 `canvasHeavy` 兜底、不进共享渲染器），不因 M 而坏。
7. **采纳** `dom2d` 没有签名：`{ kind: 'dom2d' }` 不带函数——卡的 `Component` 自己渲 `<canvas>` 并在 effect 里按 `t` 同步画（今天粒子卡的做法）；没有 gl 平面、不进 Worker；`beat.cards` 里登记它只为同拍落定（对它 `done` = 主线程画完）；冻快照直接读它自己的 canvas。
8. **采纳** 验收与路线 2 冲突：验收改成——路线 1：每个舞台文档恰好一个上下文、在它的 Worker 里，主线程 0 个；路线 2：舞台文档 0 个、父页 Worker 里 1 个。「20 张 three.js 卡」= 探针脚本生成 20 个不同参数的 `scene-3d` 片段。
- manager 补 ① **采纳** `stageId` 落地口径是 URL 的 `id` 参数、现在传 `front`（`stageRpc.ts:293`、`Preview.tsx:607`），M2 要它互换角色不变：E1 落地时两个 iframe 的 URL 改成 `?stage=1&id=A` / `id=B`，角色只经 `setRole`；`scripts/probes/stage-rpc-probe.mjs:76` 的断言同步改。
- manager 补 ② **采纳** `costs.device` 里的 `glRoute` 只按 `lowMemory` 算（`probe-card-costs.mjs:161`）：改成生效路线 = `project.glRoute ?? (lowMemory ? 'shared' : 'perDocument')`，离线探针加 `--gl-route`，`ProbeGate` 传生效路线。
- manager 补 ③ **核对后处理** `.pc-settling` 的选择器任务书有（K5 L196 给了整条规则，放过三种平面）；E7 第 5 条回指它即可。gl 平面不在放过名单 → 被 `.pc-settling` 藏住，与 M3 一致。
- 非阻塞 **采纳** M2 的 `glRoute` 一句后回指约束 L295。
- **对 pinned 的建议（转 reply，不自行采纳）**：pinned 渲染 10 首句「每个舞台文档只开一个 WebGL 上下文…舞台 iframe 里开的一个 Web Worker」与同段后文路线 2（上下文在父页）行文上对不上。

## Opus-C 补核 A0 两条验收 —— 两条都过（报告正文在 Agent 的最终回复里，原始数据在 opus-accept/）

- 89 张、`unknown` 0、粒子 54 张全 `canvasHeavy`（另有 `scene-3d`）、`independent` 77 / `belowDependent` 12 / `sourceDependent` 0；`cards.test.mjs` 50/50。
- 5 份旧 `.proc`（含没写 `frameMode` 的定制卡、裸 Project、合成的 Python 样本、全部素材无 `hash`）都开得起来，0 未捕获异常。
- **重大口径问题（必须改任务书）**：「`unknown` 为 0」只对仓库默认注册表成立——装上真实项目的 10 张定制卡后 99 张里 10 张 `unknown`；**真实带部件的组合卡片段一律 `unknown`**（`cardGraph.mjs:136` 传的 `clip.parts` 只有 `partId`）。而任务书现在的规则是「`unknown` 每个位置都判重、没有死素材、只能透明」（L55 / L96 / L105 / L132 / L134 / L156 / L189 / L317 / L335）→ 用户所有的定制卡和组合卡在播放和拖动时都会消失，只有暂停才出现。这比今天的行为是大倒退，也违背 pinned 渲染 2「靠实测，不靠声明」。
  **改法：`unknown` 一律按 `belowDependent` 处理**——K1 照测、K2 按实测分派（判轻就活渲）；判重位置用**本地档**快照（整场景路产，键用 `entry.key` 兜底，任何改动都失效）；不进共享档、不上云、不进流（和毛玻璃卡同）。落地代码要跟一处：`snapshot-store.mjs:61-68` 的 `snapshotTier` 对 `unknown` 的 stateful 卡回 `'local'`（今天回 `'none'`）。L365 浏览器模式把用户卡「按 `unknown` 透明」是另一回事（该模式根本加载不了用户卡），改成「这些片段透明」、不借 `unknown` 这个词。
- 顺带：`report.md` 被工具规则挡下没写成，我把 Agent 回复存成 opus-accept/report-from-reply.md。

## r75-04 第 4 步·分派与播放（K1～K6）—— 8 阻塞（agy 6 + manager 补 2）/ 5 非阻塞；manager 抽核约 90 处源码引用无编造；K2 四个算例复算全对

1. **采纳** K6 降级写回与落地的 `costs-store` 冲突（`mergeCosts` 是整条替换 `costs-store.mjs:81`、`validRecord` 要 `identityKey` + `device`、类型里 `frameMs` / `catchUpMs` 是 `number`）：改成——父页收到 `demote { clipId }` 后按 clipId → `identityKey` 查出旧记录，整条 PUT `{ ...旧记录, capped: true, demoted: true }`，`frameMs` / `catchUpMs` 保留旧值（不写 `null`）。
2. **采纳** K1 记录字段在「`probe` 事件 → 父页 → `/api/data/costs`」链上凑不齐：舞台的 `probe` 事件只报测量值；`device`（UA + GPU + `lowMemory` + `offscreenGl` + 生效 `glRoute`）、`measuredAt`、`mode`（`import.meta.env.DEV ? 'dev' : 'build'`）、`demoted: false` 由**父页**补齐后整条 PUT；`CardCostRecord`（`cardCostKey.d.mts`）加 `mode: 'dev' | 'build'`（3b 步）。
3. **采纳** `catchUpMs` 两个定义打架（L180 乘法 vs L182 含冻结的实测总时间）：统一成——**逐帧推进耗时之和、不含冻结**（探针每帧分两段计时：推进、冻结；`stepMs` = 推进段的单帧最差，`frameMs` = 推进 + 冻结的单帧最差，`catchUpMs` = 推进段之和）；第一趟被 B 截断时按「已推帧的推进段平均 × 总帧数」外推。
4. **采纳（简化成一面旗）** `pinnedHeavy`：落地代码把它注释成「人工钉死」（`costs-store.mjs:18-19`），任务书却让 K6 写它、又让 K1 显式清它。改成——**K6 只写 `demoted: true`**；`planPipelines` 见 `demoted` 或 `pinnedHeavy` 都当 `capped`；**K1 写回只显式带 `demoted: false`**，不碰 `pinnedHeavy`；`pinnedHeavy` 留作将来的人工钉死位，本任务没有任何代码写它。预渲染集合「只增不减」靠 `demoted` 在本次会话内一直为真成立（重探针只发生在 `ProbeGate` 遮罩下，不在播放中）。第 110 版折进去的「显式带 `pinnedHeavy: false`」撤回；顺序表第 3 步第 (6) 点同步。
5. **采纳** K4 在 60 Hz 屏上 30 fps 等不满一拍：节拍按绝对时刻排——`nextDue = playStart + n × 1000/fps`，一拍的活干完后循环 `await realRaf()` 直到 `__pcRealNow() ≥ nextDue − 1 ms`；慢帧超时就把时间轴整体后移（`playStart += 超出量`），不追帧。24 / 25 fps 在 60 Hz 上自然是 2 / 3 帧交替。
6. **采纳** `ProbeGate` 拿不到「`back` 就绪」：`stageBridge.ts` 加 `whenStageReady(role): Promise<StageRpcClient>`（`setStageClient` 时 resolve；客户端换了就换一个新的 Promise），`ProbeGate` 用它，不去够 `Preview` 内部的 `stageReady`。
7. **采纳** K5 第一路漏了图卡那一支：L196 改成四支——`Stage.tsx:169` / `:172-173`（图卡）/ `:175` / `:177`。
8. **采纳** 探针直接对 `back` 发 `setProject(缩水)` 绕过 `stageBridge` 的 `pushed` 基线（`stageBridge.ts:70` 会让之后的 `syncProject(backRole(), …)` 短路）：`stageBridge.ts` 加 `pushProject(role, project, { reset: true })`（更新该 role 的 `pushed`），探针、K5 第二路、D4 测量对 `back` 发的 `setProject` 一律走它。
- 非阻塞 1 **采纳** L193 的 `:178-186` / `:164-177` 前补 `StageView.tsx`。
- 非阻塞 2 **采纳** 路径缩写表补卡片文件（落盘前查实际路径：`particles.tsx` / `scene-3d.tsx` / `odometer.tsx` / `checklist.tsx` / `chapter-bar.tsx` / `terminal-3d.tsx` / `growth-curve.tsx`）。
- 非阻塞 4 **采纳** K4 `ended` 的收尾照 E0：写 store（`actions.pause()` + `actions.seek(duration)`）+ `setPlaying(false)` + `pause()` 拿 `stoppedAt` + `setTime(stoppedAt, { settle: true })`；E0 的 `pause()` 补「循环已停时立即回 `{ ok: true, stoppedAt: 最后一拍的 sec }`」。
- 非阻塞 5 **采纳** `setPlaying(on)` 只管素材层（`VideoTrack` / 音频的 `playing`），不碰 K4 循环；循环只由 `play` / `pause` / `setRole('back')` 起停。父页用真实时钟量相邻两条 `frame` 的到达间隔判 40 ms，首拍以 `play()` 回包时刻为起点。
- 对 pinned 无建议。
- 备注：agy 的 pro 配额在这一份跑到第 4 轮时耗尽（约 2 小时后恢复），manager 按约定自己补做、没有降到 flash。

## r75-01 第 3b 步 —— 3 阻塞 / 5 非阻塞（manager 复核 4.1 表 45 行 + 约 60 处表外源码行）。最终写法等 Opus-B 的实现结果回来对齐

**先记一个我自己核实的大前提（改 3b 的口径）**：装出来的桌面版跑的是 **vite dev server**，不读 `dist/`——`desktop/src-tauri/src/lib.rs:434` 用 sidecar 的 node 起 `node_modules/vite/bin/vite.js --port 5210`，`desktop/scripts/prepare-runtime.mjs:257` 注释「装出来的应用根本不读 dist」。所以第 110 版按第 74 轮 Opus 折进去的「K1 以 `vite preview` 构建产物上重跑为准、K2 只认 `'build'`」前提是错的：桌面版的真实运行环境就是 dev 模式。改成——**K2 用「当前运行模式」的记录**（`mode` 拼进 `device` 串，dev 的应用只看 dev 记录、构建出来的在线浏览器模式只看 build 记录）；**第 4 步准入 = A2(8) 之后在 dev server 上把 62 张跑全**；构建产物那一遍降为给在线浏览器模式（第 10 步）用的参考数，`configurePreviewServer` 不再是第 4 步准入。已给 Opus-B 发消息要求两组都跑、dev 优先。
1. **采纳** 探针在构建产物上 `import('/src/...')` 取不到模块：需要从 bundle 露一个探针入口（按 Opus-B 的实际做法写进任务书）。
2. **采纳** `costs` 去重键不含 `mode`：`mode=dev|build` 拼进页面侧算的 `device` 串（`costs-store.mjs:42` 的键代码不用改），记录另留 `mode` 字段。
3. **采纳** `INHERITED_PROPS` 的实测在 `node --test` 里没有 DOM：做成 puppeteer 探针 `scripts/probes/inherited-props-probe.mjs`，不进 `npm test`。
- 非阻塞：三个插件的中间件要先抽成工厂（`mediaMiddleware` 只有 media 一个现成）；`freezeScene(root)` 没有 `themeId` 入参 + 基线元素进 live DOM 会引发强制重排 → 基线在逐元素循环之前一次性量完（一次挂、一次读、一次摘），`themeId` 从场景根的属性读或加可选第二参 `freezeScene(root, { themeId })`；单卡前后位图比对脚本没有现成入口（按 Opus-B 实际新增的脚本名写）；`verify-unified-frames.mjs` 的 `:52` / `:56` 应为 `:50` / `:55`；`replay-frames.mjs:19-21` 应为 `:17-18`。
- 范围外顺带：现状节（L48）写 `device` 没带 `glRoute`，而 `probe-card-costs.mjs:374` 已拼进去 → 现状节补上。
- 对 pinned 无建议。

## r75-02 第 4 步·数据面（C2～C5、D5、J3、F5）—— 3 阻塞 / 6 非阻塞 / 范围外 2；manager 核全部 40 处源码引用，订正 agy 6 处摘录

1. **采纳** C4 的 `wanted` 发不出去：L134「要改三处白名单」补第四处——页面侧 `src/editor/dataMirror.ts` 的播放头路径：`:184` 的 `!s.playing` 闸门（播放中根本不推）、`:149` 的「`t` 没变就早退」（`wanted` 变了也要发）、`:186` 的 400 ms 可重入防抖（改成 100 ms 固定节流）、`:151` / `:76-85` 的 `post`（await + 读 body + 10 秒超时；`wanted` 单开一个 `keepalive: true`、不读响应的发送函数）。
2. **采纳** F5 只扫磁盘重建不出 `readyIndex`（目录名是剥掉 clipId 的共享键）：补——扫盘只得到「键 → ranges」；`clipId` 要等项目到位（`ensureMirror` / `repushMirror`）后重算 card plan，用 `control.clipId` ↔ `control.snapshotKey`（`server/card-cache.mjs:92-93`）反查；项目没到之前不发 `layer`，到了再发 `reset` + 全量 `layer`。
3. **采纳，选 (b)** C3 的 SSE「经编辑器进程代理」不在 D5 的保留清单里：改成**页面直接打预渲染进程的 `GET /api/frames/ready`**（和快照字节同源、同走 `PROMPTCUT_CORS_ORIGINS`，J3 的 `HttpSnapshotSource` 本来就直连预渲染进程），编辑器进程不代理——少一跳、也不用在 D5 的清单里加反向代理。（落盘前确认 J3 / C3 其它句子没有依赖「经编辑器代理」。）
- 非阻塞 1 **采纳** C2 把已落地的 `onSnapshot` / `snapshotFrames`（`frame-pipeline.mjs:829` / `:835` / `:839`，已写 A3a 目录）写成待办：改成现状 + 还差什么（把 `:829` 的 `new Set(localFrames)` 收窄成本卡缺的帧；随 legacy 删的只有 PNG 那一支 `:830`）。
- 非阻塞 2 **采纳（写死一种）** `renderLocalSnapshots` 保持 `snapshotOnly: false`：每帧多截一张丢弃的 PNG 是已知代价，换 `fullFrame` 的帧窗规划（`export-frames.mjs:504`）和 `shoot` 里的 `prepareFrameMedia`；参数清单补 `fullFrame: true`（对照 `frame-pipeline.mjs:571`）。
- 非阻塞 3 **采纳** `hasComplete` 的 HTML 侧判据：`index.json` 的 `count` 是已有帧数（`snapshot-store.mjs:47`），完整 = `index.count === control.count`（`control.count` 从 card plan 取）。
- 非阻塞 4 **采纳** `controls` 项只有 `id`（clipId）/ `frame` / `html`，共享键用 card plan 的 `control.clipId` ↔ `control.snapshotKey` 反查。
- 非阻塞 5 **采纳** `?preview=legacy` 已有旧语义（`StageView.tsx:49-53`：setProject 立刻按跳转重算）：写明 D5 的回滚开关**合并**它——同一个参数，legacy 下两件事都生效。
- 非阻塞 6 **采纳** `mediaMode` 是同一步 E7 给 `FrameScene` 新加的 prop（HEAD 的 `FrameScene.tsx:68` 还没有），L149 写明。
- 范围外 a **采纳** 约束 L299 写「`FrameScene.tsx:76` 的 `placeholder` 分支不动」，`:76` 其实是活跃判据（与 L348 同一行）：L299 改成「`FrameScene.tsx:76` 的活跃判据不动（E7 第 2 条给 live 路另加分支，`placeholder` 路保持这条判据）」。
- 范围外 b **采纳（我已核实）** L146 说热池借还和 `stopPlayback()`「b5c65dc 后已删除」是错的（上一轮 agy 的裸行号对账表判错）：它们在 `frame-pipeline.mjs:1088-1106`（借还）和 `:1107`（`stopPlayback()`）。L146 两处「旧 `:896-914`（…已删除…）」「旧 `:915`（…已删除无替代…）」改回正常引用。**其余 15 处「旧 `:N`（b5c65dc 后…）」行内注也要逐条复核**（落盘时做）。
- 对 pinned 无建议。

## r75-05 第 4 步·轨道流（G0～G7）—— 4 阻塞 / 8 非阻塞；manager 核 13 条任务书原句 + 19 个源码文件 30 余行位

1. **采纳** 奇数宽 + `yuv420p` 会崩：流的画面尺寸 = 裁剪矩形**外扩到偶数宽、偶数高**（在截图的 `clip` 矩形上取整，滤镜链不动）；索引记 `rect: { x, y, w, h }`（舞台像素）。
2. **采纳** 透明区 RGB 渗边：色半区存**预乘**色——滤镜链开头 `format=gbrap,premultiply=inplace=1,format=rgba,split=2[c][a]`；G5 的着色器按预乘输出（`premultipliedAlpha: true`），不再做 `rgb × a`。alpha 误差在 G0-b (5) 里量。
3. **采纳** 单卡流没有像素隔离：每条流的会话加载**该流的隔离工程**（`isolatedCardProject` 的流版本：只留这条流的卡——单卡流一张、组流一组——和 `sourceDependent` 链上的源片段；素材轨和其它卡全部剔掉；**时间不平移**，流按全局帧号分段；背景透明），所以 `frameWindow = null` 全员挂载时页面里也只有这条流的像素；`captureFrame` 加可选 `clip` 矩形只截裁剪矩形。这与不做 L383（`bakeStream` 不带非空 `clipIds`）不冲突——隔离靠工程，不靠 `clipIds`。**裁剪矩形怎么取**（任务书只说「实体框的并集」，没说谁量、何时量）：第一版用包裹层框在整段 motion 下的包围盒 ∩ 画布（从项目数据算、不实测）；是否改成实测实体框并集由 G0-b 原型定稿后写回 G1（加进 G0-b 的交付项）。
4. **采纳** 组流平面的命中与实体框：`[data-pc-group-plane]` 加 `pointer-events: none`，`solid.ts:197` 的平面排除名单加 `data-pc-group-plane`（不参与 `bounds` / `rects`）；组内被抑制的卡没有自己的流平面，`hitTest` / `bounds` 对它们退回包裹层框（`frameCss` 框）。
- 非阻塞 3.1 **采纳** 编码器参数前补 `-c:v`。
- 非阻塞 3.2 **采纳** 各编码器的严格 GOP 参数分列（libx264：`-g 15 -keyint_min 15 -sc_threshold 0 -bf 0`；`h264_nvenc`：`-g 15 -bf 0 -no-scenecut 1 -forced-idr 1 -strict_gop 1`；`h264_qsv`：`-g 15 -bf 0`，其余以 G0-b (7) 实测为准）。
- 非阻塞 3.3 **采纳** `out_color_matrix=bt709` 与容器色彩标注没有原型实测背书：标明由 G0-b (5) 验色差。
- 非阻塞 3.4 **采纳** 谁剥 `init.mp4` / `mfra`：Node 端读 ffmpeg 管道输出、按 MP4 box 切——`ftyp + moov` 写成 `init.mp4`（每条流只写一次，后续分段的必须逐字节相同、否则换流签名），`moof + mdat` 写成分段文件，`mfra` 丢弃。
- 非阻塞 3.5 **采纳** `streamPool` 的会话怎么拿：`FramePipeline` 加 `leaseStreamBakery()` / `returnStreamBakery()`（裸 bakery，不进 `laneChains`，数量 = `streamPool`），`frame-stream.mjs` 只经这两个函数拿。
- 非阻塞 3.6 **采纳** 两处描述不准：`frameWindow` 在 `warmUp` 里也用（`export-frames.mjs:627`），留在调用方闭包里传给 `warmUp`；`installFrameMedia` 是导出页自己装的（`ExportView.tsx:27`）。
- 非阻塞 3.8 **采纳** `VideoFrame` 预算与 80 MB 验收对不上（解码帧是上下拼合后的 1920×2176，NV12 ≈ 6.27 MB / 帧，24 帧 ≈ 150 MB）：预算按字节算——总量 ≤ 80 MB（1080p 全幅流约 12 帧）、每流保底 3 帧；L234 写明分辨率前提。
- 对 pinned 无建议。agy pro 配额在这一份最后一轮返工时耗尽，manager 补做。

## Opus-A G0-a 桌面壳探针 —— 三项全过（真壳 WebView2 153.0.4234.32、RTX 3080），报告 docs/g0-a-webview2-probe.md，原始数据 opus-g0a/

- (1) `VideoDecoder.isConfigSupported(avc1.640028, prefer-hardware)` = true，且真解码：1080p 稳态 1.5 ms / 帧（p50）、首帧 1.9～9.6 ms；1920×2176（1080p 上下拼合）2.4～2.7 ms / 帧、首帧 5.9～7.3 ms；硬解与软解的 `codedSize` 不同（1920×1088 vs 1920×1090），证明真走了硬件。`isConfigSupported` **不校验 level 与分辨率**（L4.0 配 1920×2176 也回 true）；实际 SPS 会写成 `avc1.640033`，G5「codec 从 `avcC` 拼」所以线上不会用错。
- (2) 毛玻璃 9 个用例全过，数字与 Chrome 152 逐位相同；「跨源 OOPIF 里 `<video>` 下的毛玻璃」模糊正确；1280×720 复跑仍正确。附带事实：跨源 OOPIF 里的玻璃能模糊父文档的 canvas 和 video。
- (3) OAC：带 `Origin-Agent-Cluster: ?1` 时 iframe 独立进程，A 死循环 2.5 s 下父页最坏 rAF 间隔 7 ms、B 6 ms。**给 E1 的使用前提（要写进任务书）**：舞台 origin 在同一个 browsing context group 里的**第一次加载**就必须带这个头，之后补加无效（Chromium 按 BrowsingInstance 缓存 origin-keyed 决定；WebView2 只能同页导航，第一轮因此出过假阴性）；`window.originAgentCluster` 恒回 true、不能当判据，验收要看 CDP `Target.getTargets` 里有没有 `type: 'iframe'` 的 target。
- WebView2 上 CDP 的两个坑（写进了探针注释）：`Target.createTarget` 不报错直接挂死、还会把 agent webview 导航成 `about:blank`；连着浏览器时 `server.close()` 不返回，要 `closeAllConnections()`。
- 改动文件：`scripts/probes/probe-connect.mjs`（新）、`videodecoder-probe.mjs`（新）、`backdrop-probe.mjs` / `oac-probe.mjs`（加 `--connect` 等开关，原 Chrome 跑法回归过）、`docs/g0-a-webview2-probe.md`（新）。未提交。
- **任务书要改**：顺序表第 4 步准入「G0-a 通过（未跑）」→「已过（2026-09-19，报告路径）」；G0 段记结论；E1 加 OAC 头的使用前提与验收判据；现状「探针实测」条更新到 WebView2 153 的结果。G0-b 仍未做（与第 4 步并行）。

## r75-03 第 4 步·舞台面（E0～E7、A4、D3 用户命中、D4 单飞队列、F2）—— 3 阻塞 / 15 非阻塞 / 范围外 3；agy 的 4.1 表约七成是假文本、被 manager 整张作废，manager 用脚本按行号直读源码重做 130 行。结论「有条件能」

1. **采纳** E7 第 1 条的搬运范围漏符号：`MediaLayers.tsx:128` 的 `interface Slot` 跟 `:138-150` 三个辅助函数一起进 `src/render/VideoTrack.tsx`；`:106-114` 的 `targetTimeOf`（`AudioLayer` `:319` 也在用）和 `:115-127` 的 `filterOf` 进 `src/render/mediaDrive.ts`，`MediaLayers` 从那里 import。
2. **采纳** `VideoTrack` 还硬依赖 `mediaSync.ts` 的 `planSlots` / `planSync`（`MediaLayers.tsx:10`、`:192`）：`mediaSync.ts`（纯函数 + 单测）随 `VideoTrack` 搬到 `src/render/mediaSync.ts`，`MediaLayers` 改 import；路径缩写表同步。
3. **采纳** `FrameScene` 新 props 清单（L166）比 L174 的 JSX 少 `remountGen` / `settling` / `awaiting`：清单补全。
- 3.1 **采纳** E4 的 `yieldEvery` 已落地（`stageClock.ts:67` / `:177`，`StageView.tsx:425` 已传 8）：改成落地口径，留「K5 补跑传 8、K3 轻卡重推不传」为待办。
- 3.2 **采纳** E4b：`__pcRealNow` / `__pcRealSetTimeout` / `__pcRealRaf` 已有（`stageClock.ts:91` / `:92` / `:100`），只补 `__pcRealDateNow` / `__pcRealSetInterval`。
- 3.3 **采纳** `right/index.tsx:96-98` → `:94`（`syncProject(backRole(), …)`）。（我在第 110 版里写进去的行号，错了。）
- 3.4 **采纳** D4「`getLayout` 现在 `if (c.cardId)` 跳过素材段要改」已不成立（`right/index.tsx:635` 无过滤、`:83` 已有素材段分支）：删掉那句，连同坏掉的反引号。
- 3.5 **采纳** 「四个 `WeakMap`」→ 三个（`MediaLayers.tsx:28` / `:41` / `:42`）。
- 3.6 **采纳** 「`Stage.tsx:187-200` 条件渲染的两个平面」→「`:187-200` 的代理平面、以及 E7 第 4 条新加的快照平面」。
- 3.7 **采纳** E0「合并 `Preview.tsx:323` 的 N+1 往返」已在第 3 步落地：改成「第 4 步只补分档和 GL Worker 的 `measure` 那一路」。
- 3.8 **采纳** A4「用 control 快照替换组件」与不做 L355、E7 第 4 条相反：改成「在包裹层里挂一张 control 快照的兄弟平面、组件照常挂着（E7 第 4 条）」。
- 3.9 **采纳** 「全仓卡片没有内联 `<style>`」不成立（`src/cards/native/terminal-3d.tsx:46`、`src/cards/_probe/probe.tsx:31`）：改成如实描述 + 为什么不影响 id 改名。
- 3.10 **采纳** `Preview.tsx:386-397` → `:387-397`。
- 3.11 **采纳（按我的读法写死）** F2 的「服务端旧调度器」没有落点：= 预渲染进程里保留的 `user` / `playback` lane 旧路径（`acquireUser`、`updatePlayback` `frame-pipeline.mjs:1049` 起）；legacy 页面照今天的方式发这两种 lane 的请求，服务端不另读开关；非 legacy 页面不发这两种 lane，旧路径平时不建会话；`streamPool` 与旧热池不共用会话。
- 3.12 **采纳** 没人负责在非 legacy 下停掉 `Preview.tsx:125-158` 的 rAF 播放循环：E6 补一句——非 legacy 下不启动，播放头由 K4 的 `frame` 事件推进。
- 3.13 **采纳** 验收 L317 的 `drawParticles` 不可观测（只在注释里）：换成「被抑制的粒子卡的 `<canvas>` 像素哈希在抑制期间不变，包裹层 `data-pc-local-frame` 仍随 `t` 变」。
- 3.14 **采纳** `setTime({ probe: true })` 同样没有角色闸门（`StageView.tsx:379` 直接 `freezeScene`）：E1 给它也加——非 `back` 收到回 `{ aborted: true, reason: 'role' }`。
- 3.15 **采纳** D3 第 4 步的「`rects()` 遍历根下所有 `[data-pc-clip]`」已是现状（`solid.ts:223`）：改成「第 4 步只需给 live 素材层补属性 + 删 `mediaRects`」。
- 范围外 a **采纳** 路径缩写表补卡片文件（都在 `src/cards/native/`）：`particles.tsx` / `odometer.tsx` / `checklist.tsx` / `scene-3d.tsx` / `terminal-3d.tsx` / `hud.css`（落盘前逐个 ls 确认）。
- 范围外 b **记给用户** `src/editor/Preview.tsx:605` 的注释里有术语约定禁用的旧词（代码注释，不是任务书；不在我这次的改动范围，最终回复里提一句）。
- 范围外 c **采纳** 顺序表第 3 步第 (7) 点：只有 `probe-card-costs.mjs:16` 过期（`StageView.tsx:183` → `:228`），`:19` 仍对、`:23` 没有行号可改。
- 对 pinned 无建议。
