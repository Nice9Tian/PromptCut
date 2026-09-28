# AGENT 报告:perf-encode-2(1080p 全幅流 15 帧分段编码,笔记本上留出余量)

- 分支:`claude/perf-encode-2`(从 main `e27fa520`),worktree `.worktrees/perf-enc2`;对照用的 main 检出在 `.worktrees/perf-enc2-base`(detached)。
- 任务:`stream-produce-probe`(不带 `--group`)的「1080p 全幅流 15 帧分段编码 ≤ 300 ms」在笔记本(性能基准机)上 main `9cf43f1f` 的 5 轮 p50 是 300 / 332 / 283 / 311 / 302(中位数 302)。目标:候选 5 轮每轮 ≤ 300、中位数 ≤ 270;优先找产出逐字节不变的路。门槛不改。
- 端口:dev server 5750(舞台 5751、5752);main 对照 5755(5756、5757)。
- 机器:笔记本(AMD Ryzen 7 6800H、16 线程、交流电、Balanced),ffmpeg 9.0.1。

## 进度

- [ ] 在笔记本上拆耗时
- [ ] 逐条试逐字节不变的路
- [ ] 采用的改法与单测
- [ ] main / 候选交替实测
- [ ] 验证(相关单测、tsc)

## 1. 量法与工具

- 帧:从探针里抽出那 15 张 1080p 粒子背景 PNG(`clip-bg` 第 30～44 帧,每张约 270 KB;临时改一份探针副本把 `pngs` 落盘,副本没入库),另有 15 张药丸(`clip-pill`,560×374)和单测同款的合成帧(随机 RGBA、渐变、全透明 / 全不透明块;256×64、330×190、1920×1080 各 3 张)。
- 逐字节比较:同一批 PNG 过两条命令行,比 ffmpeg 输出(滤镜链比 `-f rawvideo` 的原始 YUV,整条命令行比 fMP4)的 md5。
- 小基准:同一批 15 张 PNG,命令行交替跑;进程先拉起等 400 ms(相当于预拉),起表 → 逐张写 stdin → 输出以 mfra 收尾为止,和探针的口径一样。
- 空闲门:每轮开跑前 5 s 平均 CPU(`os.cpus()` 时间差)< 15%,过不了每 15 s 再测。今天笔记本上另有别的会话的批次(`lt-M8` 的 vite、puppeteer 的 Chrome)和屏保,空闲时约 8%～12%,忙时 30%～90%;下面凡是没注明「过门」的数都是在 25%～35% 负载下的**相对**对比。

## 2. 耗时拆在哪儿(笔记本)

- 解码 15 张 PNG 只要约 33 ms、CPU 0.03 s(截图大半透明,PNG 很小)。
- 滤镜链(main 的写法)单线程 30 帧约 580 ms,即每帧约 19 ms;按步拆(单线程、30 帧增量):`rgba→gbrap` 23、预乘 24、`→rgb24` 44、**`alphaextract` 128**、`gray→rgb24` 48、两次 `pad` 与 `vstack` 约 30、最后 `rgb24→yuv420p`(1920×2176)约 250。
- `alphaextract` 贵得离谱,查 `-loglevel debug`:ffmpeg 8 起帧上带 alpha 模式,`premultiply=inplace=1` 出来的帧标成「已预乘」,而 `alphaextract` 只收「未预乘」,滤镜图于是在它前面**自动插了 `auto_premultiply_dynamic`,把整帧反预乘一遍**,结果随后被 `alphaextract` 丢掉(alpha 平面本来就没变)。
- x264 单独编同一批已转好的 YUV(`-f rawvideo` 读文件):rtime 142～170 ms,utime 约 0.5 s、**stime 0.23～0.47 s**、maxrss 1.12 GB(auto 线程 24)——每段一个新进程,x264 分配的内存每段都要缺页清零,这部分只随线程数变(改线程数就改字节)。
- 整条(解 + 滤 + 编):CPU 合计约 1.2～2.0 s(utime 0.73～0.88、stime 0.39～1.23),16 线程的机器上本来就接近吃满;所以滤镜多线程、滤镜分段并行这类「换个方式排活」的办法都没用,只有**少干活**有用。
- **ffmpeg 开输入时要先读够 5 MB(或 5 s)才开工**(`avformat_find_stream_info` 的缺省 `probesize` / `analyzeduration`):一张 PNG 两三百 KB,一段 15 帧凑不够,所以**不管帧来得多早,stdin 关掉之前 ffmpeg 什么都不做**;再加上 PNG 帧级多线程解码要先攒够「线程数 − 1」(16 线程的机器上是 15)个包才出第一帧。按出帧节奏喂(每张间隔 60 ms)时实测:第一个输出字节在关 stdin 之后才出现(约 1000 ms,喂完是 950 ms),喂完到出完字节 256～289 ms。
