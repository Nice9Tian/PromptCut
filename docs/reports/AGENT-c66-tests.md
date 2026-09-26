# AGENT-c66-tests：C6.6 契约测试（测试方）

分支 `claude/c66-tests`（起点 main `f866754`），测试方，对抗式：只照 `docs/plan/c66-design.md`（第 2～5 节、第 6 节 T1～T8、第 8 节）与 `docs/plan/cloud-task.md` A1 验收写，冲突判定另引语义 `document-service.md`「冲突」。没读 `claude/c66-tiers`、`c66-fetch`、`c66-cards` 的实现。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/c66-kit.mjs` | 公共件：被测模块载入（**设计稿没写死的名字全在这里**，假设 K1～K5）、ffmpeg 现场生成样本、自写的 ISO BMFF 顶层 box 解析、按流包数据 md5、记录与断网用的 `fetch`、假 DOM（给 `playability.ts`）、假内容库与假本机卡片环境 |
| `server/test/c66-tiers.test.mjs` | 两档生成：小版参数、faststart 判定、原片只重封装、重封装失败、只对视频做、ProRes |
| `server/test/c66-upload.test.mjs` | 上传队列：顺序、断网重启续传只补缺片、已 complete 不重传、项目类型里没有同步字段 |
| `server/test/c66-fetch.test.mjs` | 可播性（缓存键、超时、MIME、停在小版）、导出拦截 |
| `server/test/c66-cards.test.mjs` | 卡片源码同步的写、读、订阅、冲突、范围 |

素材服务用现有的 `fake-asset-service.mjs`（真 HTTP、memory 实现）。样本全用 ffmpeg 现场生成，检查一律用测试自己的办法（ffprobe、自写 box 解析、`-f streamhash`），不用被测模块的判定。

## 编号对应

| 编号 | 用例 | 依据 |
|---|---|---|
| C66-T1-01 | 1080p → 小版 ≤ 800×600、偶数、H.264、yuv420p、mp4、faststart、等比贴边、帧率跟原片、AAC ≤ 80 kbps | 第 2 节「小版」、T1 |
| C66-T1-02 | 120 fps 源 → 小版 ≤ 60 fps（1 s 抽到 50～62 帧）；无音轨也能生成 | 第 2 节「上限 60」、第 8 节 `-map 0:a:0?` |
| C66-T1-03 | 640×360 源不放大 | 第 8 节「scale 不放大」 |
| C66-T1-04 | 1001×777 yuv444p → 偶数尺寸、yuv420p | 第 8 节「偶数尺寸」 |
| C66-T1-05 | 显示旋转 90° → 小版竖画面、不再带旋转 | 第 8 节 `-autorotate` |
| C66-T1-06 | faststart 判定：前置 true、晚置 false、ProRes MOV false、MKV null | 第 8 节「faststart 判定」 |
| C66-T1-07 | 构造的 box：64 位 largesize、size 0、mdat 负载里夹「moov」字样，都按跳读判对 | 同上「按顶层 box 逐个跳读」 |
| C66-T1-08 | 已 faststart 不动；晚置 moov 重封装成新文件，包数据一致、源文件不变；MKV 不处理 | 第 2 节「原片」 |
| C66-T1-09 | 重封装失败（ffmpeg 出错 / 不存在）不抛，原片 = 源文件 | 第 8 节「重封装失败就保留源文件」 |
| C66-T1-10 | `prepareTiers`：已 faststart 的原片字节 = 源文件；两个哈希都是文件 sha256；回包只有两档 | T1「tiers 两个哈希都在」 |
| C66-T1-11 | 晚置 moov：原片 = 重封装结果、按它的哈希；codec / profile / 尺寸 / pix_fmt 与源相同 | 第 2 节「按它的哈希入库」 |
| C66-T1-12 | 图片、音频没有小版 | 第 2 节「只对视频做」 |
| C66-T2-01 | 断网（A 原片传 3 片后）→ 进程换新实例、同一个 `upload-queue.json` 续传：A 小版不重传、A 原片只补缺片（每片一次）、B / C 之前一片没传；五个哈希 `chunks` 各自 `complete`；再起实例不发写请求 | T2、第 3 节「重启后续传」「两档都 complete 才出队」 |
| C66-T2-02 | 素材服务上已 complete 的档一片不传 | 第 3 节 |
| C66-T2-03 | `MediaTiers` 只有 `small` / `original`；`MediaAsset` 没有上传、同步、可播性字段（静态读 `src/kernel/project.ts`） | T2「项目文档和 .proc 没有同步状态」、第 2 节 |
| C66-T3-01 | 写请求按「A 小、A 原、B 小、B 原、C 原」成段、不交错，每段以 complete 收尾、分片传齐 | T3、第 3 节「逐个素材、先小后大」 |
| C66-T6-01 | ProRes MOV：原片仍是 ProRes、包数据相同，另有 H.264 小版 | T6（生成一侧） |
| C66-T6-02 | `canPlayType` 回空 → 判放不了、落缓存、不挂 src；mov 用 `video/quicktime` 问 | 第 4 节「可播性」、第 8 节 |
| C66-T6-03 | 试放首帧到了 → 能放；error → 放不了；都能从 localStorage 读回 | 同上 |
| C66-T6-04 | 试放超时 → 回「未知」（undefined / null），不落「放不了」，下次再探会重新试放 | 第 8 节「超时记未知、稍后重试」 |
| C66-T6-05 | 存结论的键里有哈希与浏览器主版本（152）；不带版本的旧键 `pc.playable.<hash>` 不认 | 第 8 节「缓存键加浏览器主版本」 |
| C66-T6-06 | 超时时限：本地地址 5000 ms、远端地址 10000 ms | 第 8 节「本地 5 s、远端 10 s」 |
| C66-T6-07 | 本机判放不了 → 两档都 complete 时 `playbackUrl` 停在小版；项目里写 `playable` 不算；`media.url` 仍是原片 | T6、第 4 节 |
| C66-T7-01 | 原片都 complete、小版一个没有 → 放行；`has` 只问原片 | 第 4 节「导出只用原片」 |
| C66-T7-02 | 缺一个原片（小版在也不算）→ 不放行、提示含「等待上传方」、列出缺的（带 `mediaId`） | T7 |
| C66-T7-03 | 缺多个（含只有原片的图片）→ 全部列出 | T7「列出缺的素材」 |
| C66-T8-01 | 保存用户卡 → `content.put('card-source', 仓库相对路径, 源码)`，rev 逐次加一 | 第 5 节「写」 |
| C66-T8-02 | 用户卡、改过的内置卡同步；未改的内置卡不同步 | 第 5 节「范围」 |
| C66-T8-03 | 打开项目：本机没有的卡 → 装上（带 rev），不备份不提示 | 第 5 节「读」 |
| C66-T8-04 | 本机没改、服务上更新 → 装新版不备份；状态文件跨实例有效，已最新不重装 | 第 5 节「读」「本机记下」 |
| C66-T8-05 | 本机改过没同步、服务上也改过 → 先备份本机那份、再装服务上的、给提示 | 第 5 节、语义「冲突」 |
| C66-T8-06 | 订阅：A 改卡，B 5 s 内装上 | 第 5 节「订阅」、T8 |
| C66-T8-07 | 两端同时改：B 先写、A 后写 → B 先备份自己那份再换成 A 的、收到提示；服务上与两端最后都是 A 的 | T8、语义「冲突」 |
| C66-T8-08 | 本机改过、服务上没更新 → 不装不备份 | 第 5 节「读」 |

没覆盖（要浏览器或两台机器，不是单进程能验的）：T4（主线程长任务）、T5（双缓冲换档、抓帧）、T9（跨机）；另外第 4 节的按需拉取、预取顺序、页面每 2 秒轮询换档，任务书没列，设计稿也没给出可单测的接口，没写。第 3 节「和产物推送共用带宽闸、素材排在产物后」也没写（接口未定）。

## 假设的接口（集成时对账，只改 `c66-kit.mjs`）

| 编号 | 假设 |
|---|---|
| K1 | `server/media-tiers.mjs` 导出 `makeSmallTier({ ffmpeg, input, output })`、`hasFaststart(file) → true / false / null`（非 ISO BMFF 为 null）、`ensureFaststart({ ffmpeg, input, workDir }) → { path, remuxed }`（失败不抛、回源文件）、`prepareTiers({ ffmpeg, input, kind, workDir }) → { original: { path, hash }, small?: { path, hash } }`。允许几个别名（见 kit 里的 `pick`） |
| K2 | `server/upload-queue.mjs` 导出 `createUploadQueue({ file, base, fetch, ticket, chunkSize })`；实例有 `enqueue({ id, tiers: { small?, original: { hash, path, ext } } })`、`drain()`、`close()` / `stop()`；请求全经注入的 `fetch`，走现有分片协议 |
| K3 | `server/export-gate.mjs` 导出 `checkExportOriginals({ project, has }) → { ok: true } \| { ok: false, message, missing: [{ mediaId, hash }] }`，`has(hash)` 是「当前素材服务 complete 没有」；只看被片段引用的素材的原片 |
| K4 | `src/render/playability.ts` 沿用现有导出名；主版本取 `navigator.userAgent`；超时经 `window.__pcRealSetTimeout`；「远端」= 绝对 http(s) 地址 |
| K5 | `server/card-sync.mjs` 导出 `createCardSync({ content, readLocal, install, backup, notify, scopeOf, stateFile })`，实例有 `saved({ key, body })`、`open()`、`close()`；`content` 形状同 `server/render-node/content-client.mjs` 另加 `watch(kind, cb)`；`scopeOf` 回 `'user' / 'builtin-modified' / 'builtin'`；源码 `body` 是字符串 |

## 验证

- `node --check` 五个文件全过。
- 在本分支（没有实现）跑 `node --experimental-test-module-mocks --test server/test/c66-*.test.mjs`：34 条，过 4 条（C66-T2-03、T6-02、T6-03、T6-07，都是现有代码已满足的），失败 30 条，全是「载不进被测模块」或现有 `playability.ts` 不满足第 8 节（超时判 false、键不带主版本、超时 8 s）——符合预期。
- 为了确认测试本身没写错，我在 scratchpad 写了四个一次性参考实现（`media-tiers`、`upload-queue`、`export-gate`、`card-sync`），并临时改了 `playability.ts`（缓存键带主版本、超时 5 s / 10 s 且回 undefined）。放进 worktree 跑同一条命令：**34 条全过，退出码 0**；跑完参考文件已删除，`playability.ts` 已用 `git checkout` 还原，没有提交（`git status` 干净）。这轮顺带修了测试自己的两处毛病：VFR 小版的平均帧率按时间戳算会是 60.5，门槛改为 ≤ 61、以包数为主；假本机环境的覆盖提示事件被 `type` 字段覆盖，改名为 `notifyType`。
- 用时：五个文件合计约 12 s（样本生成约 0.3 s，最慢的是各段 ffmpeg 转码）。依赖本机 ffmpeg（经 `findFfmpeg`），需要 libx264、prores_ks、aac。

## 歧义与更正建议

1. **「本机改过」与「被覆盖」（第 5 节 vs T8、语义「冲突」）**：第 5 节的读规则只说「本机文件没改过而服务上的 cardRev 更新了 → 直接装」。按字面，B 先写（同步状态记下 B 自己的 rev 与哈希）、A 后写时，B 本机「没改过」，会直接装、不备份；但 T8 与语义要求先写方有备份与提示。C66-T8-07 按 T8 与语义写：**被别人覆盖了自己写的那一版，也要先备份再装**。建议第 5 节补一句「服务上的新版覆盖的是本机写的那一版时，同样先备份再装」。
2. **超时的「未知」**：第 8 节说「超时记『未知、稍后重试』」，没说回什么值、隔多久重试。测试只要求回 undefined 或 null、不落「放不了」、下一次调用会重新试放。
3. **「远端」怎么认**：第 8 节「本地 5 s、远端 10 s」没说判据。测试按「绝对 http(s) 地址 = 远端，`/@media/...` = 本地」（K4），这条最可能要对账。
4. **导出拦截的范围**：「列出缺的素材」没说是项目里全部素材还是被片段引用的。测试里三个素材都被引用，两种实现都过；没有 `hash` 的老素材怎么算也没写，没测。
5. **音频的 faststart**：第 2 节只说重封装针对原片、小版只对视频做，没说音频（m4a 也是 ISO BMFF、常见晚置 moov）要不要重封装。C66-T1-12 只要求音频没有小版、哈希对得上，不管它有没有被重封装。
6. **小版的 `-preset veryfast -crf 26`**：从产物里读不出来，没测；只测了能测的（尺寸、编码、像素格式、帧率、音频码率、faststart）。
7. **HDR 分支**（第 8 节 zscale + tonemap）没测：现场生成带正确 BT.2020/PQ 标签的样本要 zimg，且判定标准（色调映射后的像素）设计稿没给。

## 需要主会话决定

- 集成时按实际模块名改 `c66-kit.mjs` 的 K1～K5；用例本身尽量不动。
- 第 5 节是否按歧义 1 补一句。
