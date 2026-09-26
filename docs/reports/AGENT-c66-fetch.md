# C6.6 c66-fetch 报告

分支 `claude/c66-fetch`(起点 main `f866754`),worktree `.worktrees/c66-fetch`。
任务:`docs/plan/c66-design.md` 第 4 节(按需拉取、预取队列、页面换档、可播性、导出拦截),依据第 8 节查资料结论。

## 1. 做了什么

### 1.1 本地素材服务:按需拉取、预取、原片检查(`server/media-pull.mjs`,新)

- `/@media/<hash>` 在本地内容库没找到时,交给 `pullThrough`:向**当前连接的远程素材服务** `GET <base>/media/<hash>` 流式拉取,
  **边落盘边按 Range 服务**(回包头在远程回头之后立刻给,读到还没落盘的位置就等);同一哈希只有一个拉取任务,读请求挂在它上面;
  Range 起点比已落盘位置超前 8 MiB 以上(moov 在尾部的老文件)时这一段直接从远程透传;拉完按 sha256 校验,
  不符丢弃,相符改名进本地内容库并写索引(之后是普通本地命中)。远程也 404 才回 404;没连远程就和原来一样直接 404。
- 当前连接的远程素材服务由页面告诉编辑器进程:`POST /api/media/remote { base, ticket }`、`DELETE` 清掉、`GET` 看状态
  (不回票据)。票据只进 `Authorization` 头,不进地址、日志、回包。
- 预取队列:`POST /api/media/prefetch { items }`,一次拉一个、按需拉取在跑时让路、本地已有的跳过;换远程或清掉时作废。
- `POST /api/media/originals { hashes }`:这些哈希在当前素材服务上哪些没 `complete`(连远程问它的 `chunks`,本机缓存不算数;
  没连远程看本地内容库)。页面目前没用它(页面自己问 `chunks`),留给服务端一侧的拦截(见第 4 节)。
- `server/vite-plugin-media.ts` 只加了接线:`extForContentType`、`pullStore`(本地内容库的落盘入库操作)、上述几条路由、
  读路由未命中那一支。拉取模块按原来的惯例**惰性 import**(几个单测把插件单独转译到临时目录)。

### 1.2 换档判据与可播性(`src/render/mediaTier.ts`、`src/render/playability.ts`)

- `chooseTier(media, list)` 回 `{ url, tier, awaiting }`,`playbackUrl` 是它的 `url`。集合里带标记
  `@known:local` / `@known:remote`,「问过了、一个都没到齐」和「还没问过」分得开:
  还没问过 → 有小版给小版(第一帧不直接拉原片);问过了 → 原片到齐且本机放得了给原片,放不了 / 未知且小版到齐给小版,
  只有小版到齐给小版,两档都没到齐给原片并标 `awaiting`(那一层透明,角上「等待上传方」)。
- 可播性:缓存键 = **浏览器主版本 + 原片哈希**(`pc.playable.<主版本>:<hash>`);`canPlayType` 回空串即判放不了;
  否则离屏 `<video muted>` 挂进文档,等 `loadeddata` 再等 `requestVideoFrameCallback` 真交一帧才判放得了;`error` 判放不了;
  超时(本地 5 s、远程 10 s)记「未知」,不进缓存,30 s 后再探;探出结论时通知订阅方,暂停中的画面层当场重渲换档。
- 新增预取顺序 `prefetchOrder`(先全部小版、再全部原片,各按片段在时间轴上的先后,没用到的素材排最后)、
  导出拦截 `missingOriginals` / `awaitingUploaderMessage`。

### 1.3 双缓冲换档(`src/render/mediaSync.ts`、`src/render/VideoTrack.tsx`、`src/StageView.tsx`)

- `planSlots` 新增**预热槽位** `warm`:显示着的槽位装的正是这一段的上一档、且出过画时,上一档**接着当 active**
  (播放中继续走、暂停中停在原地),新档装进另一个槽位静音预热、跟着播放头走;新档交出的帧与画面上那一档此刻的时刻
  (播放中是显示着那个元素的 `currentTime`,暂停中是目标时刻)**差不超过一帧**(`tierAligned`,按项目帧率)才标 ready,
  下一次规划在一次提交里对调,上一档退下。不用 `fastSeek`。
- 同时预热的层数上限 `MAX_WARMING = 2`(按序列计),没名额的上一档接着放、等下一次渲染。
- 帧回调在回调时才看这个槽位是不是预热槽位:一个槽位可能先按普通段装上(等待上传方时挂失败了)、后来才成了预热槽位,
  这时重新按对齐判;之前挂失败(404)的元素在它那一档到齐时 `load()` 一次并重挂帧回调。
- 「等待上传方」角标(`data-pc-media-awaiting`),只在 live 路(舞台预览);图片层在等待状态翻转时重挂。
- `StageView.setLocalHashes`:集合变了才存并当场重渲(原来只存不渲)。
- 探针观察口 `window.__pcTierTrace`(数组时才记,和 `__pcFallbackTrace` 同一做法)。

### 1.4 页面(`src/editor/media/assetTiers.ts`,新;`Preview.tsx`、`MediaLayers.tsx`、`syncManager.ts`、`io/index.ts`、`TopBar.tsx`)

- 预览挂着时每 2 秒问当前素材服务的 `GET media/<hash>/chunks`(本地 `/api/asset`,共享项目时是远程基址 + 只读素材票据),
  只问还没到顶档的那一档,原片到齐的素材不再问;集合变了下发给两个舞台,主文档声音层直接读。
- 进入共享项目:`service.watch { kinds: ['asset'] }` 取服务地址登记,优先和文档服务同主机的那个,指向本页面自己的不算;
  票据按 `auth.ticket kind:'asset' access:'r'` 取,剩 1/3 有效期续签,续签后再推给编辑器进程。回到本机空间(载入别的项目)即清掉。
- 素材表变了且连着远程时把 `prefetchOrder` 交给编辑器进程。
- 声音层「先留在小版」:播放中换了档,声音先接着用上一档,停下再换(上一档本来就挂失败了则当场换)。
- 导出:顶栏点导出时先按轮询到的集合判一次(不发请求,不耽误「另存为」的用户手势),原片没到齐就不弹另存为、直接提示;
  `exportVideo` 开头再问一遍素材服务,没到齐抛 `code: 'awaiting-uploader'`,提示「等待上传方:…」并列出素材名,不发任何导出请求。

## 2. 验证

**状态:基线与 G0-R 全过;换档探针跑了 4 次,前 3 次全过,最后一次 T5b(播放中换档)的帧误差一项没过。按回退规则(偶发 / 时序)停手,交回主会话。**

端口:本分支 dev server 5570(舞台 5571 / 5572),main 基线 5576(舞台 5577 / 5578),「远程素材服务」由探针自己在 5575 起。
两台都用 `PROMPTCUT_PUSH=0 npx vite <worktree> --port … --strictPort --host 127.0.0.1` 起。main 基线是临时的
`git worktree add --detach .worktrees/c66f-main-baseline f866754`,用完已删(删前查过:reparse points 0)。
两台 dev server 的进程树都是我起的,已结束;结束后 5570～5579 上没有监听。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,零错误(最终代码) |
| 全量测试 | `npm test` | 退出码 0;`tests 2989` `pass 2988` `fail 0` `cancelled 0` `skipped 1`(最终代码) |
| 新增 / 改动的单测 | `node --test server/test/media-pull.test.mjs src/render/tierSwitch.test.mjs src/editor/media/assetTiers.test.mjs src/render/mediaSync.test.mjs src/render/mediaTier.test.mjs` | `pass 77` `fail 0`;`media-pull.test.mjs` 连跑 3 次都是 `pass 11 fail 0` |
| 导出确定性(本分支) | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5570/?export=1"` | 退出码 0;`Total Frames: 1800` `Identical: 1800` `Different: 0` `All frames are identical. Determinism verified!` |
| 导出确定性(main 基线) | 同上,`--url "http://127.0.0.1:5576/?export=1"`,在基线 worktree 里跑 | 退出码 0;`Identical: 1800` `Different: 0` |
| 导出像素与 main | pngjs 逐帧逐像素比两边 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5570 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5570` | 退出码 0;`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 预览兜底(页面自己触发预渲染) | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5570 --page-preload --out out/pf-probe --json out/pf-probe/after.json` | 退出码 0,`PASS`;`beats 282`、`transparentBeats 0`、`taskP90 13.598`、`pageErrors []`、`fails []` |

单测用例名:`T5-pull-1～6`、`T5-prefetch-1/2`、`T5-remote-1`、`T7-originals-1/2`(`server/test/media-pull.test.mjs`);
`T5-tier-1～5`、`T5-align-1`、`T5-warm-1～4`、`T5-prefetch-order`、`T6-probe-1～6`、`T7-gate-1`(`src/render/tierSwitch.test.mjs`);
`T5-poll-1～4`、`T5-shared-1～3`、`T7-gate-2/3`(`src/editor/media/assetTiers.test.mjs`)。

### 2.1 换档探针 `scripts/probes/tier-switch-probe.mjs`

`node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5570 --out <dir>`,真 Chrome 152(headless)。
素材现场用 ffmpeg 生成:1280×720、30 fps、6 秒,顶上 10 格黑白条按二进制编码帧号;小版按设计稿第 8 节的命令转(800×450);
T6 的原片是同一画面转 `prores_ks`。帧号在可见舞台里对显示着的 `<video>` 做 `drawImage` 后读格子。

前三次(代码与最终版只差角标字号)全过:

| 次 | ok | T5a 轮询看到 / 换档 ms | T5a 换档前后帧号 | T5a 黑帧 | T5b 换档 ms | T5b 采样帧误差 | T5b 对齐那一帧(帧) | T5b 换档后 300 ms 黑帧 | T6 | T7 导出请求数 |
|---|---|---|---|---|---|---|---|---|---|---|
| probe5 | true | 1086 / 1306 | 75 → 75 | 0 | 2768 | 1 | -0.6 | 0 | 一直小版,缓存 `0` | 0 |
| probe6 | true | 1112 / 1342 | 75 → 75 | 0 | 2741 | -1 | 0.39 | 0 | 同上 | 0 |
| probe7 | true | 1488 / 1724 | 75 → 75 | 0 | 3763 | 1 | -0.21 | 0 | 同上 | 0 |

第四次(最终代码,`probe-final`)原始 JSON 关键行:

```
{"ok":false,
 "T5a":{"transparent":{"awaiting":true,"shown":true,"rs":0},"smallMs":262,"small":{"idx":75,"expect":75,"awaiting":false},"pollMs":1476,"switchMs":1695,
        "trace":[{"mediaTime":2.5,"ref":2.5,"errFrames":0,"playing":false}],"original":{"idx":75,"expect":75},"samples":20,"black":0,"idxSeen":[75]},
 "T5b":{"switchMs":1783,"trace":[{"mediaTime":2,"ref":1.9661,"errFrames":1.02,"playing":true}],
        "swap":{"before":{"idx":62,"t":2.233,"err":-5},"after":{"idx":68,"t":2.333,"err":-2},"frameError":3},"afterSwapBlack":0,"lumaBlack":0},
 "T6":{"cache":{"key":"pc.playable.152:<hash>","value":"0"},"stay":["small"],"idx":75,"exportGate":[]},
 "T7":{"exportVideo":{"message":"等待上传方:这些素材的原片还没传完,导出只用原片,传完后再导出 —— tier-d-muht6e83ff7b30.mp4","code":"awaiting-uploader","missing":1},
       "dialog":"等待上传方:…—— tier-d-muht6e83ff7b30.mp4","exportRequests":0},
 "remoteAuthSeen":true,"pageErrors":[],
 "fails":["T5b:播放中换档那一刻帧误差不超过一帧 :: {\"before\":{\"idx\":62,\"t\":2.233,\"err\":-5},\"after\":{\"idx\":68,\"t\":2.333,\"err\":-2},\"frameError\":3}"]}
```

截图(都看过;目录是本会话的 scratchpad `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin-Documents-PromptCut\b27266f2-12b6-470f-ae3c-baab02fc8037\scratchpad\`):
- `probe5\t5a-1-transparent.png`:素材层透明(棋盘格),左下「等待上传方」角标;
- `probe5\t5a-2-small.png` / `probe5\t5a-3-original.png`:同一帧(帧号 75 的黑白条一样),小版略糊、原片清楚;
- `probe5\t7-export-blocked.png`:导出对话框「导出失败 / 等待上传方:…—— tier-d-….mp4」,没弹另存为;
- `probe-final\t6-prores-stays-small.png`:ProRes 那一项停在小版;
- 另有各目录的 `t5b-after-switch.png`。

### 2.2 T5b 那一次失败(按回退规则停手,未修)

- 代码自己的对齐判据那一帧是过的:帧回调 `mediaTime 2.0`,比较对象(显示着那一档元素的 `currentTime`)`1.9661`,差 1.02 帧(容差 1 帧 + 1 ms)。
- 探针按「画面帧号相对舞台时钟的偏差」看:换档前一次采样 -5 帧(小版在播放中落后舞台 5 帧,`driveMedia` 在 0.5 s 内只变速追),
  换档后一次 -2 帧,跳了 3 帧。两次采样相隔约 100 ms(headless 下这一页真 rAF 约 10 Hz),换档那一刻本身没采到。
- 我的判断(未验证):播放中拿**前台元素的 `currentTime`** 当比较对象不够准,它和前台真正交给合成器的那一帧不是一回事,两个元素又各自在变速追舞台时钟;
  前三次恰好落在容差里。更稳的做法:记下前台每一帧的帧回调 `{ mediaTime, expectedDisplayTime }`,预热档那一帧按
  `frontMediaTime + (warmExpectedDisplayTime - frontExpectedDisplayTime) / 1000` 外推到同一显示时刻再比;对调前把预热档的播放速率和前台对齐。
  探针这一侧也该在舞台里用帧回调逐帧记(而不是 10 Hz 的 rAF 采样),才量得到换档那一刻本身。都没动,留给主会话定。
- 暂停中换档(T5a)4 次都是帧号 75 → 75、帧回调误差 0。

## 3. 与设计稿 / 任务书不一致之处(都按最合理方案做了)

1. **MOV 的 `canPlayType` 按 `video/mp4` 问,不按 `video/quicktime`**。Chrome 152 实测 `canPlayType('video/quicktime') === ''`
   (同环境 `video/mp4` 回 `maybe`、`video/mp4; codecs="avc1.42E01E"` 回 `probably`),而 Chrome 用同一个 ISO BMFF 解复用器照样放 H.264 的 MOV。
   照字面做,手机拍的 H.264 MOV 原片会全被判放不了、永远停在小版。放不了的 MOV(ProRes)由试放判出(T6 探针:缓存记 `0`)。
   其余容器照查资料结论(`mxf`、`avi` 回空串即否)。codecs 串没有拼(查资料结论:拿不全就交给试放)。
2. **「集合为空 → 原片」改成「还没问过 → 有小版给小版」**,按 cloud-task A1 `playbackUrl` 规则原文;原有单测 `src/render/mediaTier.test.mjs`
   第一条随之改了。为了区分「问过、一个都没到齐」,集合里加 `@known:local` / `@known:remote` 标记,`setLocalHashes` 的形状(字符串数组)没变。
3. **预取顺序是「先全部小版、再全部原片」**(各按片段在时间轴上的先后),不是上传队列那种「逐个素材先小后大」。设计稿写「先小后大地拉」,
   我理解为先让所有片段都能出画。
4. **音频是「播放中先留在上一档、停下再换」**,没做「对齐后切」或 20～50 ms 交叉淡变:声音层在主文档经 `routePreviewAudio` 接 WebAudio,
   加一路交叉淡变牵扯面大,先取最稳的一种(查资料结论「画面换档后暂由小版持续出声」)。
5. **「等待上传方」加了角标**(左下小字,不盖画面):A1 写「那一层透明并提示」,rendering.md 要求「预览里任何一层都不无提示地透明」;
   T5「先透明」仍成立(视频区域透明,见截图)。
6. **导出拦截在页面两处**:顶栏点导出时按轮询到的集合先判(不发请求,不耽误「另存为」要的用户手势),`exportVideo` 开头再问一遍素材服务。
   服务端 `/api/export` 没拦(见第 4 节)。
7. **载入别的项目会清掉当前远程素材服务**:跟 `syncManager` 的「在共享项目里载入别的项目 = 离开共享项目、回到本机空间」同一口径。
8. 可播性探测的离屏 `<video>` 要**挂进文档**(2×2、几乎透明、不挡点击),不挂进去帧回调不来;`loadeddata` 后轻推一次 `currentTime` 让暂停的元素交一帧。

## 4. 没做成的 / 留给集成

- **T5b 播放中换档的帧误差**:见 2.2,偶发,未修。
- **服务端导出拦截**:`POST /api/media/originals` 已有、单测过(`T7-originals-1/2`),但预渲染进程的 `/api/export` 没调它;
  Agent 或脚本直接打 `/api/export` 时不会被拦。接法:`handleExportStart` 里按 `assetServiceOrigin()` 问编辑器进程这条,缺就回 409 `awaiting-uploader`。
- **在线浏览器模式**(没有本机编辑器):页面轮询与导出拦截能直连远程素材服务,但 `playbackUrl` 的 `cloudBase` 没接(C10)。
- **与 c66-tiers 的接口**:读取侧按 `project.media[i].tiers = { small?, original }` 实现,`original` 缺省取 `media.hash`;
  拉进来的文件扩展名按远程 `Content-Type` 反查(`extForContentType`)。
- **票据续签推给编辑器进程**只在轮询循环里做(每 2 秒看一次),预览没挂着时不续。
- 项目文档 / `.proc` 里不写同步状态或可播性字段(T6 探针核对了 `JSON.stringify(project)` 里没有 `playable`)。

## 5. 文件

- 新:`server/media-pull.mjs`、`server/test/media-pull.test.mjs`、`src/editor/media/assetTiers.ts`、`src/editor/media/assetTiers.test.mjs`、
  `src/render/tierSwitch.test.mjs`、`scripts/probes/tier-switch-probe.mjs`
- 改:`server/vite-plugin-media.ts`、`src/render/mediaTier.ts`、`src/render/playability.ts`、`src/render/mediaSync.ts`、`src/render/VideoTrack.tsx`、
  `src/StageView.tsx`、`src/editor/Preview.tsx`、`src/editor/preview/MediaLayers.tsx`、`src/editor/sync/syncManager.ts`、`src/editor/io/index.ts`、
  `src/editor/TopBar.tsx`;单测 `src/render/mediaSync.test.mjs`(换档两条改成预热语义)、`src/render/mediaTier.test.mjs`(集合为空、MOV 的 MIME)
- 语义文档没改。

## 6. 需要主会话决定

- T5b 那次失败怎么认定;要不要按 2.2 改对齐判据(前台帧回调外推)并把探针改成逐帧记。
- 第 3 节第 1～4 条的取舍是否认可。
- 服务端导出拦截由谁接(第 4 节第 2 条)。
