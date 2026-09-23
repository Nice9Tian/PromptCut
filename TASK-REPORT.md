# T1b-2 任务报告:R8 之后收尾第 5 步「预渲染进程与 Agent 进程读素材只经素材服务 HTTP API」

分支 `claude/asset-reads-after-r8`(从 main `787f7d9` 建),worktree `.claude/worktrees/asset-reads-after-r8`。端口只用了 5220～5222。

## 做了什么

提交(按顺序):

1. `d90bb37` 开工,建本报告。
2. `17a638c` `server/bakery/media.mjs` 的 `mediaSourceOf`:
   - 删掉按 `m.path` 读盘、按 `/@media/` 拼本地内容库路径的两支;
   - 保留 `/@export/<id>/media/`(本趟导出自己的产物目录)和「页面同源 HTTP」兜底;
   - `mediaRootDir`、`legacyMediaRoots` 一起删掉,`planMedia` 和 `export.mjs:115` 不再传 `mediaRoot`;
   - 新增单测 `server/test/bakery-media.test.mjs`(4 条)。
3. `286da34` 镜头拼图 `POST /api/vision/sheet`(`server/vision/routes.ts`):
   - 改用 `ffmpeg-frames.ts` 的 `mediaSourceOf`,拿到素材服务上的 HTTP 地址;
   - 缓存键从 `文件路径 + mtimeMs` 换成 `media:<内容哈希> + 区间 + 格数`。哈希取 `m.hash`,或 `/@media/<hash>[.ext]` 里的那段(新函数 `mediaHashOf`)。没有哈希的素材**不进缓存**:按一次性文件名抽,用完就删;
   - 抽之前先用 `GET + Range: bytes=0-0` 探一下素材服务。取不到就回 404,并带上 HTTP 状态;不用 HEAD,是因为老路由 `/api/media/file` 不答 HEAD;
   - ffmpeg 失败时删掉写了一半的 jpg,免得有哈希的那张下次被当成缓存命中;
   - `mediaFileOf` 已经没有引用,删掉;`ffmpeg-frames.ts` 不再 import `mediaDir`、`node:fs`、`isInside`;
   - 顺带修了一处:`asset-client.ts` 的 `mediaHttpUrl` 遇到老 .proc 的 `/api/media/file?path=…` 地址(`src/editor/io/mediaUrls.ts:37` 会产出这种),取「最后一段文件名」会拼成 `/@media/file`。`ffmpeg-frames.ts` 的 `mediaSourceOf` 在没有哈希时把这种地址原样交给素材服务的这条路由,路径由那一侧按白名单判。`asset-client.ts` 不在可改清单里,所以修在调用方;
   - 新增单测 `server/test/vision-media-source.test.mjs`(3 条)。

动工前先确认过:单独跑的脚本(`verify-determinism`、`verify-unified-frames` 直接调 `exportFrames` / `FramePipeline`)从 dev server 加载页面,那里的 `/@media`、`/api/media/*` 就是素材服务本身,所以同源 HTTP 兜底对它们照样成立。下面的实测证明了这一点。

## 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0(最后一次在全部改动之后跑) |
| 全量测试 | `npm test` | 退出码 0;tests 1776,pass 1775,fail 0,skipped 1 |
| 新单测 | `node --test server/test/bakery-media.test.mjs`、`node --test server/test/vision-media-source.test.mjs` | 4/4、3/3 通过(也包含在上面的全量测试里) |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5220/?export=1"` | 退出码 0;Total 1800,Identical 1800,Different 0 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5220 node scripts/verify-unified-frames.mjs` | 退出码 0;`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`(含一段 webm 视频素材) |
| 镜头拼图实测 | scratchpad `sheet-check.mjs` | 见下 |
| 带视频的真导出 | scratchpad `video-export.mjs` | 见下 |

**导出像素基线。** `verify-determinism` 带 `noVideo`,帧是 Chrome 截的,不经过 `mediaSourceOf`:`planMedia` 只在 `media:'ffmpeg'` 且出视频时调用,音轨只在出视频时调用。所以默认导出项目的帧不受这次改动影响;两遍逐像素相同。

**带视频的项目。** 默认导出项目里没有 ffmpeg 读的素材,所以另做了一次真导出:
- 夹具:320×180、2 秒;一段 testsrc2 视频,带 440 Hz 正弦音轨,经 `PUT /api/asset/media/<hash>/0` 和 `complete` 入库;上面叠一张 punch-pill 卡片。素材记录带 `hash`、`url:/@media/<hash>`,以及指向本地内容库真文件的 `path`,和编辑器里的项目一样;
- `media:'chrome'` 和 `media:'ffmpeg'` 各导一遍,新代码和旧代码(临时 `git checkout 787f7d9 --` 这两个文件跑,跑完已恢复,`git status` 干净)各跑一次;
- ffmpeg 的输入:旧代码读 `…\out\media\8b9a…a458.mp4`(读盘),新代码读 `http://127.0.0.1:5220/@media/8b9a…a458`(素材服务);
- 输出的 framemd5(60 个视频帧 + 94 个音频包)新旧完全一致:chrome 模式 `701a537f40529f38`,ffmpeg 模式 `c8907dc01ae5aa38`;
- 看过 `vexp-new2-ffmpeg.png` 和 `vexp-new2-chrome.png`(成片第 1.0 秒):底下是视频第 1.5 秒(mediaOffset 0.5,画面计时器显示 00:00:01.500),上面是卡片「HTTP」,两种模式画面相同。
- 这个脚本用的是 `data:` 时间轴,Chrome 混音会按既有逻辑退回 ffmpeg 直接混(`页面地址里没有 /@export/<id>/project.json`),新旧代码行为一致,和本改动无关。

**镜头拼图**(经编辑器 5220 转给它拉起的预渲染进程):
```
PUT chunk 0 -> 200
complete -> 200 {"ok":true,"hash":"b9d8a5a8…d223",...}
hash-1: HTTP 200 ok=true cached=false frames=[0.55,1.29,2.03,2.76] jpeg=54476B 170ms
hash-2: HTTP 200 ok=true cached=true  frames=[0.55,1.29,2.03,2.76] jpeg=54476B 17ms
same bytes: true
nohash-1: HTTP 200 ok=true cached=false ... 103ms
nohash-2: HTTP 200 ok=true cached=false ... 108ms   ← 没有哈希不进缓存
missing: HTTP 404 ok=false 素材服务上取不到这份素材(HTTP 404),重新导入一次再试
```
- 跑完 `out/sheets/` 里只有有哈希的那一张(`84fa715179e03da7eac4.jpg`),没有留下一次性文件;
- 看过 `sheet-hash-2.jpg`:2×2 的 testsrc2 画面,正确;
- 同一条 ffmpeg 命令分别读本地文件和素材服务的 HTTP 地址,出的 jpg 与接口返回的逐字节相同(sha256 前缀都是 `fd9abf9cc12fad34`)。

dev server(PID 36784 及其子进程,含它拉起的预渲染进程)已按 PID 结束;`out/` 下自己产生的 verify-a/b、vexp-* 已删。

## 剩下的直接读(grep `mediaDir(` / `out/media` / `cardMediaPath` / `allowedMediaRoots` / `Videos…PromptCut`)

**Agent / 预渲染这一侧,素材字节已经没有直接读了;只剩一处读元数据,不在本任务可改清单里:**

1. `server/frame-pipeline.mjs:272-276`(`FramePipeline.entry`,运行在预渲染进程):用 `cardMediaPath(media, root)` 把素材解析成磁盘路径,再 `fs.stat` 取 `size:mtimeMs` 当 `_frameSourceStamp`。读的是元数据,不是字节,但仍然碰了本地内容库目录(也包括 `PROMPTCUT_MEDIA_DIR` 和老 .proc 的绝对路径)。它属于 T5a,本任务不可写。建议:有哈希时直接用哈希当 stamp(内容不可变,不用 stat);没哈希时向素材服务发 `HEAD`(或 Range 1 字节),用 `Content-Length` + `Last-Modified` 当 stamp。
2. `server/card-media-path.mjs`:上一条用的解析器,拼 `out/media`、`PROMPTCUT_MEDIA_DIR`、`/api/media/file?path=` 里的路径。只有 frame-pipeline 在用,跟着上一条一起改。

**预渲染产物(第 6 步 A3b,按任务书不动):**

3. `server/vision/bake.ts:246, 356`:把 `bake-*.png` 写进 `mediaDir`,也从那里读。
4. `server/vision/bake-cache.ts:19, 50`:在 `mediaDir` 里列举、清理预渲染产物。
5. `server/vision/routes.ts:533, 599` 附近:预渲染产物的盘点和清理接口(调用上面两处)。
6. `server/vision/routes.ts` 的 `out/sheets/`(镜头拼图缓存):派生产物,在 `outRoot` 下读写,不是素材。按「预渲染产物一律入库」的语义,它将来也该进 A3b 的推送范围,本次不动。

**编辑器进程自己的插件(不在本步范围,只列出):**

- `server/vite-plugin-audio.ts:29-104`:它自己有一份 `mediaFileOf`,读 `mediaDir` 和 `export-<id>/media`;
- `server/vite-plugin-collect.ts:184, 504`:素材收集下载到 `mediaDir`;
- `server/vite-plugin-voice.ts:113-162`:配音试听和成品写进 `mediaDir`,也读它;
- `server/vite-plugin-export.ts:52-82, 95, 131-151`:导出暂存、`allowedMediaRoots`、`normalizeExportMedia` 的 `fs.access`;
- `server/vite-plugin-media.ts`、`server/asset-service.ts`:素材服务本身,按语义它们本来就该读写这个目录。

**脚本和探针(测试夹具,不是 Agent / 预渲染路径):**

- `scripts/verify-unified-frames.mjs:16-18`、`scripts/probes/stage-content-probe.mjs:57`:把夹具直接写进 `out/media`;
- `scripts/export-e2e.mjs:49-90`:在导出目录建 `media` junction;
- `scripts/probes/export-baseline-compare.mjs:11, 20-22, 92`:注释里还说 `mediaRootDir()`,这个函数这次已经删了。探针靠「两棵树的 out/media 各放一份、按文件名取」,现在 ffmpeg 改从 dev server 的 HTTP 取,探针用法的说明要跟着改。不在可改清单里,没动。

## 没做成的及原因

- `frame-pipeline.mjs` 和 `card-media-path.mjs` 那一处 stat(上面第 1、2 条)不在可改清单(T5a),没改。所以「Agent / 预渲染路径完全不碰 `out/media`」这一条,目前只在「不读素材字节」这个意义上成立。
- `asset-client.ts` 的 `mediaHttpUrl` 对 `/api/media/file?path=` 地址的处理不对,只在调用方 `ffmpeg-frames.ts` 绕开了。

## 对任务书或语义的更正建议

- 任务书说 `mediaSourceOf` 的兜底「找页面源」就等于找素材服务。实际上导出时 `vite-plugin-export.ts:151` 会把带 `path` 的素材改写成 `/api/media/file?path=…`,所以兜底走的常常是这条老路由,不是 `/@media/<hash>`。它也归素材服务管(预渲染进程的 `assetProxyPlugin` 转发 `/api/media/*`),语义不受影响。建议 `cloud-task.md` 的组件表「素材服务」一行把 `/api/media/file` 记为迁移期的读路由,并定好它什么时候退役。
- `cloud-task.md` A1 验收里「Agent 进程和预渲染进程读素材只经 HTTP API」这一条,建议写明包括元数据(stat)在内,并把 `frame-pipeline.mjs` 的 `_frameSourceStamp` 列为要改的点;不然这条留下的读会一直漏在范围外。
- `asset-client.ts` 的 `mediaHttpUrl` 建议直接认 `/api/media/file?` 地址(把现在 `ffmpeg-frames.ts` 里的那段挪过去),再删掉调用方的这段绕行。

## 待用户定

1. 没有哈希的素材,镜头拼图现在每次都现抽、不进缓存(最保守的做法)。要不要改成按「URL + 素材服务回的 `Last-Modified` / `Content-Length`」做缓存键?
2. `frame-pipeline.mjs` 的 `_frameSourceStamp` 改成「有哈希用哈希,没哈希问素材服务」:派给 T5a,还是单开一个任务?
3. `out/sheets` 镜头拼图缓存算不算「预渲染产物」、要不要进 A3b 的推送范围?
4. `scripts/probes/export-baseline-compare.mjs` 的用法说明(按文件名往两棵树的 `out/media` 放夹具)要跟着这次改动改,谁来改?
