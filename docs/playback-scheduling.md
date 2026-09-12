# 播放预览调度

播放继续使用 `FramePipeline.see_frames → readFramesCore → bakeFrames`。
暂停和拖动仍请求精确帧；播放由 `FramePlayback` 预先安排未来的帧，`MovPlayer` 只按编辑器时间轴选取画面，不在请求完成时直接显示结果。

## 预测与资源

`debtMs = (batchSize - 1) × max(0, frameMs - stride × 1000 / (fps × rate))`。
`leadFrames = ceil((firstMs + debtMs + jitterMs + deliveryMs) × rate × fps / 1000)`。
这里是把预计就绪耗时换算成时间轴会前进的帧数，耗时和播放速度不能直接相减。

- `firstMs`：重置页面、推进历史、截图到批次第一张完成的估计；耗时增加立即上调，下降按 EWMA 缓慢调整。
- `frameMs`：同批次后续截图间隔，采用同样的快速上调、缓慢下降策略。
- `jitterMs`：首帧耗时变化的余量。
- `deliveryMs`：客户端 Range 读取及 PNG 解码的实测 EWMA，加心跳/呈现余量。
- `rate`：每个真实秒前进多少时间轴秒。当前编辑器的播放时钟是 1 倍速；接口接受显式速度。

每个 worker 最多接一个 6 帧连续采样批次，所有 worker 共用帧号预留集合。
批内债务补偿后半段截图所需的额外提前量；实测交错条带会增加有状态卡片的重复历史推进，因此使用连续批次。
片尾缩短批次，不为超出时间轴的帧预留债务；缓存孔洞不会把微批次拉长成跨越大段历史的回放。
吞吐充裕时 `stride = 1`，一趟推帧沿途逐帧截图；不足时依据每帧成本、摊销的首帧成本、worker 数及播放速度扩大采样间隔。
远端窗口边缘会积攒成批，避免每露出一帧就重新准备页面。
缓存命中不参加渲染耗时估计，窗口先检查已有全场景 MOV/PNG，再由 `see_frames` 复用 HTML 和累计轨道缓存。

播放开始撤销本地后台 B/MOV 作业，终止其 Chrome 和旧顺序编码器，并保留已完成缓存。
通过 `/api/frames/yield` 对独立预渲染服务做同样处理；确认后将前台热池从 2 个槽扩为 3 个。
原有两个槽可先工作，不等待远端确认。
远端租约每秒续期、5 秒失效；暂停、项目切换、关闭或失联会释放租约，后台重新预烘时复用已有缓存。
Agent 的独立渲染 lane 不受此次撤销影响。

播放请求由 `owner + sequence` 排序；暂停、跳转、速度变化建立新 epoch 并取消旧批次。
心跳携带同机墙钟采样时间，服务端补偿 HTTP 传输及排队耗时，避免把普通播放误判为跳转。
旧回调不能修改新播放会话，旧会话也不能释放新会话的资源。
同一内容标识下已经落盘的真实帧仍可供之后命中。

## 单一播放 MOV

打开项目即在其帧缓存目录创建 `mov/playback-<uuid>.mov`。
`moov` 预置完整时间轴的样本表，全部未就绪样本引用同一个项目尺寸的全透明 PNG，避免物理写入 N 张透明图。
各 worker 通过 `see_frames` 新增的可选 `onFrame(frame, value)` 回调，在整批结束之前逐张交给同一个 `PlaybackMovStore`。

只有一个写入队列：完整追加 PNG 到 `mdat`，更新 `stsz/co64`，最后发布内存中的样本偏移和长度。
样本发布后，其字节区间不再改写；透明占位没有 ready 标记，也不会进入真实帧缓存。
重新启动使用新的播放 MOV，复用原来的 PNG/HTML 缓存，不尝试复用进程意外退出时可能未写完的播放索引。

Chromium 不原生支持 PNG 编码的 MOV，也不会自动刷新已经打开的 MOV 样本表。
因此客户端通过服务端已提交的样本索引，对**这一个 MOV** 发 HTTP Range 请求，用 `createImageBitmap` 解码并在 Canvas 按时间轴显示。
这增加的是 MOV 读取/呈现层，没有新的 Chrome 渲染或视频编码管线。
MOV 同时可由标准工具读取完整时长与已填入的帧。

客户端限制 2 个并发读取/解码，并以 96 MiB 像素预算（最多 24 张，超大单帧至少一张）限制位图缓存。
淘汰、取消、跳转和卸载均显式 `ImageBitmap.close()`。
未来帧不提前展示；低帧率时最多沿用一个采样间隔、且不超过 1 秒，超过时显示透明空位，不无限追赶陈旧帧。
连续播放保留已呈现帧号下限；采样间隔改变或 RAF 停顿清空位图时，晚解码的旧帧不能使画面倒退。主动回跳才重置此下限。
冷启动或算力不足仍可能出现未就绪空位，本改动不承诺重型场景满帧率。

播放批次的 10 秒看门狗按每张已完成帧续期，健康的长批次不会因总耗时被重启。
每个活跃 HTML archive 独占临时展开目录；保存时版本检查保留并发新增帧。
HTML 压缩块同时按时间和 8 MiB 编码字节数切分，避免真实项目中的大画布快照累积超过解码上限。

## 长时间运行的内存边界

冷启动的整帧和新发现的控件从第一张快照开始使用可落盘的 LazyFrameStore；每个展开窗口同时限制 16 帧和 8 MiB 字符存储估算。保存时按序读取暂存帧、逐块合并差分，不一次性展开全部暂存文件。小差分复制为独立字符串，避免 V8 子串保留整张大快照。

本机完整缓存使用 `html-manifest.json` 和 `html-blocks/<sha256>.base64`。manifest 仅保存索引，压缩块按需读盘；不能因为已经 gzip 就把整部影片的所有压缩块常驻内存。后台最多每 16 帧发布一次增量；没有新帧时不重复保存。多进程通过原子 manifest 发布交换缓存，内容寻址的块文件不会被原地修改。

便携 `.proc` 仍可读取原 v1/v2 内嵌归档。压缩块总量超过 16 MiB 时，`/archive` 返回 `snapshots: null, localOnly: true`，完整缓存继续留在本机，不由预览轮询传给 WebView，也不内嵌到 `.proc`。项目编排、素材引用和卡片源码不受影响，其他机器可重新生成缓存。旧版超过 32 MiB 的本机单文件缓存作为可再生数据跳过，避免启动时再次整体读入。

`server/test/frame-memory.test.mjs` 在 192 MiB 堆上验证冷采样、控件、增量保存、难压缩大缓存、重新打开和便携归档的大小检查。

## 验证

- `node --test server/test/frame-playback.test.mjs server/test/frame-user-watchdog.test.mjs server/test/frame-archive.test.mjs`
  检查透明占位、并发写读、重复帧、预测速度、批次去重、缓存、提前回调、过期回调、失联、owner 更替、资源归还及并发快照保存。
- `node scripts/verify-playback.mjs`
  在 `out/` 的隔离应用中，用 ffprobe 检查完整时长，用 ffmpeg 验证透明及乱序补帧；真实 Chrome 一趟截四帧并检查时间对应的像素，再验证 MOV HTTP 206 播放、缺帧、回跳及 HTTP 心跳/暂停。
- `npm test`、`npm run build`。

`node scripts/verify-playback-project.mjs --project <file.proc>` 在隔离目录导入真实项目的卡片和素材引用，运行完整冷/热播放、暂停跳转、独立预渲染进程租约和 MOV 容器检查。JSON、逐帧追踪及截图保存在 `out/real-playback-*`，原始项目通过 SHA256 检查保持不变。
