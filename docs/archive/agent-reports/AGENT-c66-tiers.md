# AGENT 报告：c66-tiers（C6.6 第 2、3 节：小版生成、原片重封装、上传队列）

分支 `claude/c66-tiers`，worktree `.worktrees/c66-tiers`，基于 main `f866754`。没有推送，没有合并。

状态：实现、单测、探针、基线、G0-R 都做完了，全部一次通过。有几处设计稿没写到、我按最合理的办法定了（第 4 节），另有两件需要集成方接线（第 5 节第 3、4 条）。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `server/media-tiers.mjs`（新） | ISO BMFF 顶层 box 扫描与 faststart 判定；同容器 `-c copy` 重封装，校验通过后再换；小版命令（第 8 节，SDR 与 HDR 两支）；两档管理器 `createTierManager`：导入时处理、后台转码（一次一个、低于正常优先级）、`tiers.json` 登记、交给上传队列、重启后接着转 |
| `server/upload-queue.mjs`（新） | 持久上传队列 `createUploadQueue`：逐个素材、先小后大、分片续传只补缺片、两档都 `complete` 才出队、退避重试、`upload-queue.json` 落盘重启续传、目标是本机素材服务时空操作 |
| `server/bandwidth-gate.mjs`（新） | 带宽闸：产物从不等，素材按片取闸，产物在推、或还有段等着推时素材等着；跨进程探针读 `push-queue.json` |
| `server/artifact-push.mjs` | 接上带宽闸：登记「还有几段等着推」（在推的、等轮到的、静置中的都算，退避中的不算），每段推的时候占着。推送行为本身不变 |
| `server/asset-store/client.mjs` | 新增 `putFile`（从磁盘逐片读，不整件进内存；每片发出前可 `await` 一个闸）与 `chunks` |
| `server/vite-plugin-media.ts` | `?tiers=1` 的导入（`/api/media/upload/`、`/api/media/adopt`）；`GET /api/media/tiers`；`GET /api/media/upload-queue`、`POST /api/media/upload-queue/target`；`mediaTierService`（每个根一份）；编辑器进程（ui、非无头）起来时启动队列、接着转没转完的小版；`forgetMediaIndex` |
| `src/editor/io/mediaUpload.ts` | 导入带 `?tiers=1`；回包的 `tiers` 写进 `project.media[i].tiers`；小版还在转时每 2 s 问一次 `GET /api/media/tiers`，好了补上 `small` |
| `src/kernel/project.ts` | 只改了两处注释（原来写「小版眼下还没人产」） |
| `server/test/media-tiers.test.mjs`（新） | T1-1～T1-8、T2-1、T2-2、T3-1～T3-4，14 条 |
| `src/editor/io/mediaTiers.test.mjs`（新） | T2-page、T1-page，2 条 |
| `scripts/probes/tiers-probe.mjs`（新） | 现场探针（第 3 节） |

提交：`ea20e66` 开工，`ee8ad93` 实现，`5debc88` 单测，`89a433e` 页面侧单测，`71bca1a` 注释，`f729fc1` 探针，`3e1f0d5` 修重封装对应关系落盘，最后一个是本报告。

### 1.1 行为要点

- **只对视频做**：扩展名是视频（mp4、m4v、mov、webm、mkv、avi 等）才走；ffprobe 没有视频流（封面图不算）记 `none`，只有原片一档。图片、音频的回包不带 `tiers`。
- **原片**：只看 mp4 / m4v / mov。box 扫描处理 32 位、`size=1` 的 64 位、`size=0` 的长度；有 `moof` 的分片 MP4、长度不合法、缺 `moov` 或 `mdat` 的一律不动。`mdat` 在 `moov` 前才重封装：`ffmpeg -i 源 -map 0 -c copy -movflags +faststart -f <mp4|mov> 临时文件`，写完校验 box 顺序、各流「类型:编码」逐一相同、时长差 ≤ 0.05 s，过了才按输出文件的哈希入库；任何一步失败删临时文件、源文件原样当原片、记原因。不转码、不删轨。
- **小版**：第 8 节的命令（`select` 丢帧、`scale` 不放大限 800×600 偶数、`reset_sar=1`、`format=yuv420p`、`-map 0:v:0 -map 0:a:0?`、`-fps_mode:v vfr`、libx264 veryfast crf 26、AAC 64k、`+faststart`，`-autorotate` 是缺省）。标签完整的 BT.2020 + PQ 源走 `zscale` + `tonemap=hable` 分支，输出标 BT.709。
- **登记**：`<素材目录>/tiers.json`（本机缓存，不进项目）：原片哈希 → `{ state, small, … }`，另记「重封装前的哈希 → 重封装后的哈希」。
- **项目**：页面只写 `tiers = { original }`，小版好了再写成 `{ original, small }`。同步状态一个字段都不进项目、不进 `.proc`。
- **队列**：小版好了（或确定没有小版）才把这个素材交给上传队列，所以队列的顺序就是导入顺序（转码一次一个）。

## 2. 基线与 G0-R（原始关键行）

端口：本分支 dev server 5560（舞台 5561、5562），main 基线 5563（舞台 5564、5565），都是 `PROMPTCUT_PUSH=0 npx vite --port … --strictPort --host 127.0.0.1` 在各自 worktree 里起。main 基线是临时的 `git worktree add --detach .worktrees/c66tiers-main-baseline main`（`f866754`），删前查过 junction 为 0，用 `git worktree remove --force` 删掉；之后主仓库 `node_modules` 仍有 182 项。两台 dev server 与它们的预渲染进程用 `taskkill /T /F` 按监听端口的进程结束，之后 5560～5569 没有监听。没用 Claude 浏览器面板，没动主工作区的 `.claude/launch.json`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `npm test` | 退出码 0；`tests 2967` `pass 2966` `fail 0` `skipped 1`（跳过的是「集成:/api/cards/layout 对真实项目返回整数框」，要 5190）。同一时段 main 是 `tests 2951` `pass 2950` `skipped 1`，差 16 条 = 本分支新增 14 + 2 |
| 本阶段单测 | `node --test server/test/media-tiers.test.mjs` | `tests 14` `pass 14` `fail 0` `skipped 0`，duration 10.8 s |
| 本阶段单测 | `node --test src/editor/io/mediaTiers.test.mjs` | `pass 2` `fail 0` |
| 导出确定性（本分支） | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5560/?export=1"` | 退出码 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` `All frames are identical. Determinism verified!` |
| 导出确定性（main） | 同上，5563 | 退出码 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` |
| 与 main 逐像素 | scratchpad `cmp-frames.mjs` 比两边 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5560 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5560` | 退出码 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |

没跑的：G0-R 表里的预渲染探针（ready-index、stream-produce、preview-fallback）。任务书只点了上面三项；本分支没动预渲染、帧管线、页面渲染路径，推送队列只多了闸的登记（产物从不等闸）。

单测是第一次跑就全过的；中途只修过测试自己留下的一个 30 s 计时器（`Promise.race` 的超时没清，拖慢进程退出），不是实现的问题。

## 3. 探针 `scripts/probes/tiers-probe.mjs`

`node scripts/probes/tiers-probe.mjs`（缺省 A 5560、R 5563，两台真的 vite 编辑器、临时 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`；A 的 `PROMPTCUT_ASSET_URL` 指向 R）。现场用 ffmpeg 生成三个素材，按页面同一个请求 `POST /api/media/upload/<名字>?tiers=1` 导入。退出码 0，最后一行（原样）：

```
{"ok":true,"ports":{"a":5560,"r":5563},"work":"C:\\Users\\admin\\AppData\\Local\\Temp\\pc-tiers-probe-muhsdmmp","imports":[{"name":"probe-1080p.mp4","src":"65dc9573e9e3","original":"ea164b764c28","small":"830cf20fa316","remux":"remuxed","smallState":"ready","importMs":418,"originalFaststart":"faststart","originalCodecs":["video:h264","audio:aac"],"smallSize":"800x450","smallCodec":"h264","smallFaststart":"faststart"},{"name":"probe-prores.mov","src":"e892192771ff","original":"f458683121c2","small":"c24228a8917a","remux":"remuxed","smallState":"ready","importMs":159,"originalFaststart":"faststart","originalCodecs":["video:prores"],"smallSize":"640x360","smallCodec":"h264","smallFaststart":"faststart"},{"name":"probe-late-moov.mp4","src":"8a0b4e7780a8","original":"3785759e04a9","small":"7180d7621562","remux":"remuxed","smallState":"ready","importMs":131,"originalFaststart":"faststart","originalCodecs":["video:h264"],"smallSize":"640x360","smallCodec":"h264","smallFaststart":"faststart"}],"queueOrder":["tier-start probe-1080p.mp4:small","tier-done probe-1080p.mp4:small","tier-start probe-1080p.mp4:original","tier-done probe-1080p.mp4:original","item-done probe-1080p.mp4:original","tier-start probe-prores.mov:small","tier-done probe-prores.mov:small","tier-start probe-prores.mov:original","tier-done probe-prores.mov:original","item-done probe-prores.mov:original","tier-start probe-late-moov.mp4:small","tier-done probe-late-moov.mp4:small","tier-start probe-late-moov.mp4:original","tier-done probe-late-moov.mp4:original","item-done probe-late-moov.mp4:original"],"remote":{"probe-1080p.mp4:small":{"complete":true,"chunks":1,"shaOk":true},"probe-1080p.mp4:original":{"complete":true,"chunks":3,"shaOk":true},"probe-prores.mov:small":{"complete":true,"chunks":1,"shaOk":true},"probe-prores.mov:original":{"complete":true,"chunks":1,"shaOk":true},"probe-late-moov.mp4:small":{"complete":true,"chunks":1,"shaOk":true},"probe-late-moov.mp4:original":{"complete":true,"chunks":1,"shaOk":true}},"fails":[]}
```

读法：三个都缺 faststart、都重封装了（`original` ≠ `src`）；原片 moov 在前、编码与源文件相同（ProRes 仍是 ProRes）；小版 1080p → 800×450，640×360 的不放大；队列日志是「逐个素材、先小后大」；R 上六个哈希各自 `complete`，取回字节的 sha256 对得上。1080p（约 17 MB、3 片）导入回包 418 ms，含重封装。

## 4. 与设计稿不一致或设计稿没写的地方（我的裁定）

1. **丢帧判据加了 0.2 ms 容差**：第 8 节原文 `gte(t-prev_selected_t,1/60)`，实测 120 fps 的源只剩 44.7 fps（89 帧 / 2 s）—— 间隔正好 1/60 s 的帧按浮点比较被误丢。改成 `1/60-0.0002` 后 120 fps → 正好 120 帧 / 2 s（60 fps），30 fps 的源一帧不丢（T1-6）。
2. **HDR 分支的 `zscale` 要显式给输入参数**：原文 `zscale=t=linear:npl=100` 在我这台 ffmpeg 9.0.1 上报 `no path between colorspaces`。我按 ffprobe 读到的标签给 `tin=smpte2084:pin=bt2020:min=<bt2020nc|bt2020c>:rin=<limited|full>`，输出另加 `-color_primaries/-color_trc/-colorspace bt709`（T1-5 核对小版标 BT.709）。只认 PQ + BT.2020；HLG、无标签照 SDR 走（设计稿第 8 节已裁）。本机 ffmpeg 没有 `zscale` / `tonemap` 时 PQ 源不生成小版（不拿 8 bit 转换冒充）。
3. **重封装在导入请求里同步做，小版在后台**：重封装会改原片的哈希，而页面拿回包里的哈希当素材身份，所以回包要等重封装做完；`-c copy` 只是读写一遍磁盘，不占事件循环。小版是转码，放后台，不挡回包。
4. **重封装前那份文件从库里删掉**：只删这次导入刚写进库的（去重命中的不删，可能有老项目在引用）；同时记「源哈希 → 重封装后的哈希」，同一个文件再导入直接复用（T1-1）。
5. **只有 `?tiers=1` 的导入才做两档**：页面导入（`uploadMediaFile`）和素材收集的补键（`adoptServerMedia`）带它；`.procp` 还原、配音、其它走 `/api/media/upload/` 的不带，行为与原来逐字节相同。理由：`.procp` 里的项目按原哈希引用素材，还原时重封装会让引用断掉。副作用：`.procp` 还原的素材不会在本机再生成小版（语义说小版「可再生、不进包」，但没说还原时要不要再生）——需要的话另开一条。
6. **目标是本机素材服务时**：进队是空操作（不写文件）；队里已有的（连远程时进的）暂停、不丢，换回远程再接着传（T3-2）。
7. **严格按序**：队头失败在退避时后面的素材也等着（语义「两档都传完才轮到下一份」）。队头的某一档本地文件没了就跳过这一档、记 `upload.missing`。
8. **带宽闸跨进程的做法**：推送队列在预渲染进程里，上传队列在编辑器进程里，不是同一个对象。编辑器那一侧读预渲染进程落盘的 `push-queue.json`：120 s 内写过、且有没失败过的段（`attempts === 0`）就算产物还在推。同一个进程里（单测、将来合并进程）直接共用 `sharedBandwidthGate()`。素材按 8 MiB 一片让路。
9. **文件位置**：`upload-queue.json` 放在 `PROMPTCUT_EXPORT_DIR`（缺省 `<根>/out`）下，和本地内容库 `out/media` 同处；`tiers.json` 在 `out/media/` 里。设计稿说「本机数据目录」，我理解为本地内容库所在的这一处；如果要放 `PROMPTCUT_DATA_DIR`，改一行。
10. **转码并发 1、低优先级**（`os.setPriority(BELOW_NORMAL)`）。设计稿只说「后台、不挡编辑」。

## 5. 没做成的、要集成方接的

1. **T4（上传期间主线程无长任务）没有测**：不在本任务的 T1～T3 里。页面这一侧只多了每 2 s 一次的小 `fetch`，上传全在编辑器进程里。
2. **页面关掉时小版还没好**：小版照样在本机生成、照样进上传队列，但这条素材的项目记录里不会有 `tiers.small`（页面不在了没人写）。打开项目时补写（对 `tiers.small` 缺失的视频问一次 `GET /api/media/tiers`）没做：要挂在项目打开的流程里，超出我的文件范围。
3. **共享项目里「当前连接的素材服务」要页面告诉编辑器进程**：现在上传队列的目标只来自 `PROMPTCUT_ASSET_URL`，或 `POST /api/media/upload-queue/target { base, ticket }`。页面（`src/editor/sync/syncManager.ts`，连着共享项目、能在自己的连接上签 `auth.ticket { kind: 'asset', access: 'rw' }`）应在进入共享项目时把远端素材服务的基址和一张 `rw` 素材票据 POST 过来，并在 15 分钟过期前续上；离开共享项目时 POST `{ base: null }`。我没改 `syncManager.ts`（不在清单里）。票据过期而页面没续时：客户端收 401 会再要一次（拿到的还是同一张），失败进退避，页面续上后自动接着传。
4. **只有 `PROMPTCUT_SHARED_CONFIG` 的 Node 进程不自己取票据**：编辑器进程不像预渲染进程那样读 `PROMPTCUT_SHARED_CONFIG` 连文档服务取票据。编辑器有页面，按第 3 条由页面给最直接；如果主会话希望无页面时也能传，可以照 `vite-plugin-frames.ts` 的 `ticketFor` 接一条。

## 6. 给 c66-fetch 的接口说明

- **项目字段**：`project.media[i].tiers = { original, small? }`，只有视频有。`original` 就是 `media.hash`，**可能不等于源文件的 sha256**（重封装过）；老项目不受影响。`small` 可能缺：小版还在转、转失败、没有视频流，或页面在小版好之前关了。缺 `small` 按「还没有小版时直接拉原片」处理。
- **本机小版登记**：`GET /api/media/tiers?hashes=<原片,…>`（最多 200 个）→ `{ ok, items: { [原片]: { state, small?, reason? } } }`，`state` ∈ `pending | ready | failed | none | unknown`。这是本机转码的登记，不是同步状态；判「传没传完」仍只问素材服务的 `GET media/<hash>/chunks`。
- **字节**：小版是 `<小版哈希>.mp4`，在本地内容库里，`/@media/<小版哈希>` 与 `/api/asset/media/<小版哈希>` 都能取，Content-Type `video/mp4`，moov 在前。原片保持原扩展名与编码（ProRes 的 MOV 仍是 ProRes，适合 T6「原片不可播」）。
- **上传顺序**：远端先收到小版、再收到原片（每个素材两档都 `complete` 后才轮到下一个），所以对面按 `chunks.complete` 换档时，小版总是先 `complete`。
- **素材服务客户端**（`server/asset-store/client.mjs`）：新增 `chunks(ns, hash)` → `{ size, chunkSize, received, complete }`（原样回对账结果），`putFile(ns, 文件, { hash, ext, beforeChunk })`。拉取一侧要带宽让路时可以用同一个闸：`sharedBandwidthGate().acquireMedia()` 回 `release`（素材类，同时一片，产物优先）。
- **诊断**：`GET /api/media/upload-queue` → `{ ok, target: { base } | null, queue: { running, working, current, items, done, failures, chunks, skippedLocal, lastError, … } }`。

## 7. 对任务书或语义的更正建议

- 设计稿第 8 节「小版命令」一行建议补上第 4 节第 1、2 条（丢帧容差、`zscale` 的输入参数），否则照抄原文 120 fps 的源会降到 45 fps，HDR 分支在标签不全的帧上会失败。
- 设计稿第 3 节「上传队列」可以写明第 4 节第 6 条（目标是本机时暂停而不是丢）与第 8 条（跨进程闸的判据），并补一句「页面负责把共享项目的素材服务基址与 `rw` 票据交给编辑器进程」（第 5 节第 3 条），否则这条链在共享项目里接不上。
- `asset-storage.md`「本地内容库」说离线交换包「小版可再生、不进包」，但没说 `.procp` 还原后要不要再生小版；本分支不再生（第 4 节第 5 条），请主会话定。

语义文档没有改。
