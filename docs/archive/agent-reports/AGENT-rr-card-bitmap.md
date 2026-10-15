# AGENT 报告：rr-card-bitmap（单张卡片画面改成当场出位图）

分支 `claude/rr-card-bitmap`，端口段 26900～26939。2026-10-13。

这一项是「渲染重构」里的「单卡画面出位图」（`docs/plan/render-refactor-task.md` 各项一览里的那一行）：Agent 的 `bake_card` 和 3D 视图的贴图不再存每张卡的 HTML，只存位图。依据是用户 2026-10-13 的决定（`docs/plan/user-decisions-2026-10-13.md` 第 1 节第 1 条）。

## 现状（改之前的链路）

先说结论：**这两处最后交出去、按输入哈希缓存、推到远程素材服务的，本来就是 PNG，不是 HTML。** HTML 是经帧库那条路出图时顺带存下的。派活指令里「它们按输入哈希各存各的一份 HTML」这句和代码对不上，见文末「更正建议」。

三条链路，入口都在 `server/vision/routes.ts`，最后都进 `server/vision/bake.ts` 的 `bakeOne`：

| 链路 | 谁发起 | 路由 | 在哪个浏览器实例里渲 | 出图的路 |
|---|---|---|---|---|
| `bake_card` | 本机 Agent（`server/agent/agent-exec.mjs` 的 `bakeCard`、`server/agent/service/instance.mjs`，经 `prerender-client.mjs` 的 `prerenderPost`）；云端 Agent 经 `server/agent-service/look-client.mjs` → 渲染服务管理进程 `server/hosted-render/look.mjs` → 工作进程里的同一条路由 | `POST /api/vision/bake`（预渲染进程），正方形画幅，优先级 1 | 预渲染进程的 Agent 专用实例 | `renderOneFrame` → `FramePipeline.see_frames`（Agent 那条队） |
| 3D 视图的空闲贴图预取（`mechanism/rendering.md`「空闲贴图预取排普通预渲染队尾」说的就是它） | 页面 `src/editor/preview/useBakePrefetch.ts`（`Scene3DView.tsx` 第 317 行挂上） | `POST <预渲染>/api/vision/bake-batch`，按卡片的框出，不带 priority 排普通预渲染队尾（`lane: "prerender"`），带了插队（`lane: "preview"`） | 预渲染进程做队列任务的那个实例（Agent 专用实例空闲时可以接队尾的） | `bakeClip` → `renderFrames` → `FramePipeline.see_frames` |
| 3D 视图前台（用户正看着的那一刻） | 页面 `Scene3DView.tsx` 第 793 行 | `POST /api/ui-render/bake-batch`（编辑器进程） | 编辑器进程的热备渲染器（`ui-renderer.ts`，两台无头 Chrome 轮换） | `bakeClip` → `renderFrames` 的 `runner` 旁路：导出脚本在临时目录 `out/export-vision-*` 里出 PNG，用完整个目录删掉 |

三条链路共用的后半段（没改）：

- 键：`bakeTarget` 把片段摘掉 frame、挪到 0.5 秒的起跑线上，对「片段内容、卡片图、主题、片内第几帧、排版尺寸、画幅档、底色、卡片源码哈希」算 sha1 取前 12 位。
- 存：PNG 经素材服务的接口写进 `px` 命名空间，地址 `/api/asset/px/<sha256>`；「输入哈希 → 内容哈希」记在 `<导出目录>/bake-index/<键>.json`（`server/bake-store.mjs`）。
- 命中：索引里有，且素材服务对账说这一块收全了。
- 推送：写进本机素材服务后再推一份到连着的远程素材服务（`setBakeRemote` 登记的那一台）；没推成的下次命中时再推。
- 读：`bake_card` 把地址回给模型，模型填进 `scene-3d` 的 `texture`；3D 视图把地址当贴图加载。

**哪一步存了这张卡的 HTML**：前两条链路走 `FramePipeline.see_frames`（`server/frame-pipeline.mjs` 的 `readFramesCore` → `renderMovFrames`）。隔离出来的单卡项目在帧库里各建一个条目，截图前先生成一份快照交给 `record()`，于是落下三样：

1. 条目的 HTML 档 `<帧库>/<条目键>/html-manifest.json` 加 `html-blocks/`。存法上是「整场景」条目，但这份项目里只有这一张卡，内容就是这张卡的 HTML；
2. 这张卡自己的快照 `<帧库>/controls-html/<共享键>/<帧>.html`（`recordSnapshots`）；
3. 这张卡的快照推到远程素材服务的 `snap` 命名空间（`enqueueSnapshotPush`）。

另有一份位图副本 `<帧库>/<条目键>/mov/frames/*.png`。同一个条目再被要时，`readFramesCore` 会先查这份 PNG、再查条目里的 HTML 并拿它重放栅格化当画面。

改之前实测（探针 `--save` 那一遍，10 张图）：帧库新建 8 个条目目录，各有 `html-manifest.json`；`controls-html/` 下 4 份 `.html`；远程素材服务收到 14 次 `snap` 写入。第三条链路（热备渲染器）不经帧库，本来就不存 HTML。

## 做了什么

出位图的办法：**把这张卡单独渲一帧，直接截成图片**，和主会话的初步想法一致。具体是不再经 `see_frames`，改由新文件 `server/vision/card-bitmap.ts` 的 `renderCardBitmaps` 直接向管线借预渲染间（Agent 的走 `runAgentTask`，贴图走 `runQueueTask`，插队与队尾的规则、1 倍缩放都和原来一样），调 `bakeFrames`（`fullFrame`、不写帧文件、不带 `onSnapshot`），截图就是结果。理由：

- 原来 `see_frames` 出的这一帧本来也是截图（HTML 只是顺带记的），所以去掉「记」之后像素不变，实测逐字节相同；
- 不建帧库条目，就既不写也不读帧库：旧条目里的 HTML 和 PNG 留在原处按容量上限淘汰，新代码碰不到；
- 连「当场生成、用完就丢的快照」都没有，一份 HTML 都不产；
- 没有改 `server/frame-pipeline.mjs`，只用它已有的两个入队口，不和同时在改管线的别的块冲突。

没有做「有轨道流的卡取流里这一帧」（派活指令说这次不要求）。也不再往页面里注卡片帧缓存里别处预渲染好的 PNG（原来 `see_frames` 的 `cardRender` 会注）：这张卡在这里真渲。

改动的文件：

- `server/vision/card-bitmap.ts`（新）：`renderCardBitmaps`、`cardBitmapScratch`。
- `server/vision/render.ts`：`RenderOpts.bitmapOnly`；`renderFrames` 在进 `see_frames` 之前分出位图那条路；压底色、数透明像素照旧用 `postFrame`，临时文件放在 `<导出目录>/card-bitmap-scratch/`，用完删。
- `server/vision/bake.ts`：`bakeOne`、`bakeClip` 走预渲染进程时带 `bitmapOnly: true`；缓存键加 `store: BAKE_STORE_VERSION`（= 2）。
- `server/bake-store.mjs`：只改文件头注释，写明这里的「卡片快照」是 PNG 位图。
- `server/test/query-render.test.mjs`：新增 QR-G1-7（守住：两处都走位图那条路、键带出法版本、`card-bitmap.ts` 里不出现 `see_frames`、建条目、记快照这些调用，排队规则不变）。
- `server/test/see-frames-rects.test.mjs`：给 `render.ts` 的新依赖补桩，加一条位图那条路的用例。
- `scripts/probes/card-bitmap-probe.mjs`、`scripts/probes/card-bitmap-probe.project.json`（新）。

超出派活指令第 1 步所列文件的只有 `server/vision/render.ts` 和新文件 `card-bitmap.ts`，都在 `server/vision/` 里，是 `bake.ts` 出图必经的一层。`server/tools/cards.mjs`、`server/png-post.mjs`、`server/prerender-client.mjs`、`server/hosted-render/look.mjs`、`server/agent-service/look-client.mjs` 都没改：云端那条路只是把请求转到工作进程里的同一条 `/api/vision/bake`。不许改的十个文件、`server/frame-stream.mjs`、`server/frame-pipeline.mjs`、`src/` 都没动。

### 键怎么换的〔裁〕

`bakeTarget` 算键的那份 JSON 里加了一个字段 `store: 2`（出法版本）。所有旧键从此不命中，新旧两种出法的图不混用。旧键的索引条目会被 3D 视图的盘点当成「这个项目用不到的旧版本」淘汰（原有逻辑），字节留在素材服务里按容量上限淘汰；参数里已经填着的旧地址 `/api/asset/px/<哈希>` 照常能取（地址按内容寻址，和键无关）。

要主会话知道的代价：

- 用户已有的贴图缓存各重渲一次（每张几秒）。旧图本来也是位图，绝大多数和新出法逐字节相同；换键只为排除其中「拿存下来的 HTML 重放栅格化」得到的那一小部分。主会话认为不值得的话，把 `store: BAKE_STORE_VERSION` 这个字段删掉即可恢复旧键，别处不用动。
- 更老的格式（素材目录里的 `bake-<片段>-<键>.png`）的读时迁移 `migrateLegacy` 从此实际上不会命中：文件名里是旧键。代码没删，老地址 `/@media/bake-….png` 照常能取，只是同一张卡再要时重渲而不是迁移。

### 行为对用户、对 Agent 不变

- `bake_card` 返回的字段没变：`clipId`、`url`、`t`、`width`、`height`、`bytes`、`cached`、`transparentRatio`、`hint`、`note`，文字一字未改（探针 A1 逐项核对）。
- 3D 视图贴图的尺寸（按卡片的框）和排队位置没变。

## 验证结果

机器同时有别的子 Agent 在跑，探针期间处理器占用量到过 87%。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0（合并 main 之后） |
| 相关测试 | `npm test -- server/test/query-render.test.mjs server/test/bake-store.test.mjs server/test/vision-modules.test.mjs server/test/tool-schema.test.mjs server/test/windows-hide-silent-spawn.test.mjs` | 59 条全过；`see-frames-rects` 加 `query-render` 两个文件 24 条全过 |
| 探针 | `node scripts/probes/card-bitmap-probe.mjs --port 26900 --compare out/card-bitmap-before` | 通过 86，失败 0（合并 main 之后的 `ca583fe3` 上；其后只改了一个测试文件和本报告） |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:26910/?export=1"` | 1800 帧全部相同，退出码 0 |
| 导出与快照重放 | `PC_FRAME_TEST_URL=http://127.0.0.1:26910 node scripts/verify-unified-frames.mjs` | PASS，退出码 0 |
| 卡的源码版本 | `node scripts/probes/card-source-version-compare.mjs --base main` | 88 条，变化 0 |
| 卡的三个键 | `node scripts/probes/card-table-digest-compare.mjs --expect ,` | 101 张逐张相同，变化 0 |
| 全量测试 | `npm test` | 两遍各 1 条失败，见下「全量测试」 |
| 云端那条路 | `node scripts/probes/cloud-agent-look-probe.mjs … --steps tools` | 退出码 0，见下「云端 Agent 的 `bake_card`」 |

探针的图片比对（改之前在 `4a6273ee` 上用 `--save` 存图，改之后 `--compare`）：**15 张全部逐字节相同**（不同的像素 0）。15 张是：`bake_card` 四张（blur-text 带底色 512、punch-pill 透明底 0.2 秒弹簧还在动、particles 画布卡带底色、用户卡 rs-bar-race 768）；预取队尾三张、插队两张；热备渲染器两张；3D 视图开着时页面收到的四张。没有需要说明的差异。

探针的落盘核对（改之后，第一段不开编辑器页面）：帧库新增文件只有 `.storage/owner.json` 和 `usage.json`，HTML 相关的 0 个，新建条目目录 0 个；本机素材服务产物目录新增 11 个文件全在 `px` 下，按哈希命名的都是 PNG，`snap` 下 0 个；远程素材服务收到 10 张 `px` 的 PNG（这一段用到的 10 个内容哈希都到了）、`snap` 写入 0 次；索引 11 条。同一输入再要一次：`cached: true`、同一个地址（`bake_card` 和预取各验一次）。

看过的图：`out/card-bitmap-before/view3d.png`（改前）和 `view3d-after.png`（改后）是 3D 页的截图，四块板子都贴上了真图，两张看不出区别；`bake-pill.png` 是透明底上的蓝色药丸。

探针跑了四遍改后的代码，其中两遍各有一项没过，都落在没改的地方，重跑通过，如实记下：

- 第一遍：热备渲染器那条路 particles 报「渲染超时(120 秒)」；同一遍里远程素材服务只收到 1 张。后者的原因是预渲染进程的推送目标是它起来之后异步登记的，登记之前入库的图当时不推、下次命中时再推（原有行为）。探针已改成这种情况下各再要一次再等。
- 第三遍：3D 视图四张贴图 240 秒内没到齐（走的是热备渲染器），当时处理器占用 87%。探针的等待时限放到 600 秒并记下用时；最终那一遍用了 4.6 秒。

验证时自己起过的进程：探针每遍自起自停的编辑器进程树、计数服务、无头 Chrome；26910 上一台开发服务器（带 `PROMPTCUT_NO_PORT_FILE=1`），验完按进程号停掉；云端探针自起自停的三个服务（26920～26936）。交活前查过：26900～26939 没有还在监听的端口，没有从这个工作区起的残留进程，没有新冒出来的可见窗口。预渲染进程的端口由编辑器进程向系统要（4843、2990 这类），不在分给我的端口段里，这是 `server/vite-plugin-prerender.ts` 的原有做法，探针管不了。

### 全量测试

`npm test`（带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`）跑了两遍，都不是零失败，如实记：

- 第一遍：6484 条，通过 6465，失败 1，退出码 1。失败的是 `server/test/see-frames-rects.test.mjs`（文件级）：它把 `render.ts` 单独转译、四个依赖换成桩，我给 `render.ts` 加的 `./card-bitmap` 没有桩。这是我漏的。已给它补第五个桩，并加了一条位图那条路的用例（不建帧库条目、不调 `see_frames`、不量实体框、后处理结果照旧带回、临时文件用完就删）。
- 第二遍（补完之后）：6489 条，通过 6470，失败 1，退出码 1。失败的是 `server/test/accept-018-conv-endtoend.test.mjs` 的「2.3-6 账号模式端到端」，报 `timeout: actual asset consumer access head`，属于账号任务进程那一组，和这次改动无关；当时处理器占用 97%。单独重跑这个文件：4 条全过。

没有改松或跳过任何测试。两遍里另有几条带 `⚠` 的是仓库里本来就标成「产品问题」的待办用例，不计失败。

### 云端 Agent 的 `bake_card`

`node scripts/probes/cloud-agent-look-probe.mjs --doc-port 26920 --asset-port 26921 --agent-port 26922 --render-port 26930 --desktop-port 26910 --steps tools --verbose`：退出码 0，两项全过。K0（三个服务起来）；K3（`inspect_card_dom` 回 DOM 树；**`bake_card` 回的贴图地址，成员凭自己的素材票据在项目的素材服务上取得到**；`get_gif` 把拼图交给了模型），工具结果 `update_clip:ok`、`inspect_card_dom:ok`、`bake_card:ok`、`get_gif:ok`。

这支探针第一次没跑起来（退出码 2）：渲染服务的工作进程 240 秒内没就绪（`[render-host] not-ready`），当时处理器占用 97%；第二次照同样的命令跑通过。

## 顺手核的一件事：Agent 看画面读不读每张卡存下来的快照

结论：**四个工具出结果时都不读每张卡存下来的快照（HTML）。** 不改，只报告。

| 工具 | 读的是什么 | 会不会顺带写每张卡的快照 |
|---|---|---|
| `see_frames` | 整场景逐帧 PNG、旧的整场景 PNG、整场景 HTML（`frame-pipeline.mjs` 的 `readFramesCore`、`rasterPrefix` 用 `entry.html.get(frame)`）；卡片帧缓存里每张卡的 **PNG** 地址（`card-cache.mjs` 的 `renderState`）；实体框只用整场景 HTML（`entityRectsNow`） | 会。现渲缺帧时 `record()` 写 `entry.controls`，条件满足时 `recordSnapshots` 写快照库并推 `snap` |
| `get_gif` | 同上那条管线，不量实体框 | 同上 |
| `inspect_card_dom` | 现渲页面上的活 DOM（`vite-plugin-cards.ts` 的 `/api/cards/dom`，只借 Agent 专用实例） | 不写 |
| `get_layout` 的实体框 | 整场景 HTML（`layoutNow`） | 这一帧没有整场景 HTML 时 `record()` 写 `entry.controls`；快照库多半不写 |

云端一侧（`hosted-render/look.mjs`、`agent-service/look-client.mjs`、`agent/service/cloud-tools.mjs`）只转发到工作进程里的同一批路由，自己不读快照。

要留意的两点，归撤快照的那一块：

- `see_frames` 带 `clipId` 和 `get_gif` 渲的是隔离出来的迷你项目，它在帧库里的「整场景 HTML」内容其实只有这一张卡（外加它需要的下方背景）。存法上算整场景条目，不在这次作废的范围里，但和 `bake_card` 改之前是同一种情况。
- 这三个工具现渲时顺带写的每张卡快照（`entry.controls`、快照库、`snap`）没人读来出画面，撤的时候可以一并去掉。

这部分是子 Agent 只读调查的结果，行号核对过；它说明没有逐行通读云端那三个文件，是按关键词搜的。

## 没做成的及原因

- 没有做「有轨道流的卡贴图直接取流里这一帧」：派活指令说这次不要求。
- 3D 视图开着时，页面自己发的空闲预取在探针的观察窗口里没有发出（四张贴图都由前台那条路出了）。预取那条路由探针第一段直接打路由覆盖（队尾三张、插队两张），没有经页面触发。

## 对任务书或语义的更正建议

1. **派活指令、`html-snapshot-removal-dryrun.md` 第 0 节第 1 条和第 61 行**说这两处是「按输入算哈希、各存各的一份每张卡的 HTML」。实际按输入哈希缓存、推送的一直是 PNG；HTML 是经帧库出图时顺带存的（帧库条目的 HTML 档、`controls-html/`、推到 `snap` 的快照）。结论不受影响（这些 HTML 现在都不产了），但描述建议改准。
2. **`mechanism/asset-service.md`** 那句「是当场渲出的位图，不存这张卡的 HTML；位图按输入哈希缓存……」和现在的做法对得上，不用改。可以考虑补半句「不经帧库」，因为「不存 HTML」靠的就是这一点。
3. **`render-refactor-task.md` 各项一览**「单卡画面出位图」那一行的办法写着「有流的卡取流里的这一帧，没有流的……单独渲一帧截成图」。这次做的是全部单独渲一帧，前半句没做，建议照实改。
4. **`server/bake-store.mjs`、`bake.ts`、`bake-cache.ts` 的标识符、报错文字、`bake_card` 的工具说明**里把这张 PNG 叫「卡片快照」「快照」。术语表现在把「快照」定为 HTML。给模型和用户看的文字这次按「返回不变」没有动，只在 `bake-store.mjs` 文件头加了说明。要不要统一改叫法，请主会话定。
5. 预渲染进程的推送目标登记得晚时，登记之前入库的位图不会马上推到远程素材服务，要等下次命中（原有行为，和这次改动无关）。语义写的是「写进本机素材服务后再推一份」，没有说会晚。算不算要修，请主会话定。
