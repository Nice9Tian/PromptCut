# AGENT 报告:perf-encode(1080p 全幅流 15 帧分段编码耗时)

- 分支:`claude/perf-encode`(从 main `2c7cee2`),worktree `.worktrees/perf-encode`;对照用的 main 检出在 `.worktrees/perf-encode-base`(detached,只读用,可删)。
- 任务:`stream-produce-probe`(不带 `--group`)的「1080p 全幅流 15 帧分段编码 ≤ 300 ms」在笔记本(性能基准机)上 355～397 ms;修到笔记本过线。门槛没改。
- 端口:dev server 5670(舞台 5671、5672)。PC 上的数字只作前后对照,**笔记本复核前不算过**(`guide_files/verification.md`「性能基准机」)。

## 1. 探针量的是什么

`scripts/probes/stream-produce-probe.mjs` 第 204～252 行:

- 帧:流全部生产完之后,另租一个预渲染页,用 `bakeStream` 把粒子背景(`clip-bg`,1920×1080 全幅)第 30～44 帧截成 15 张 PNG,**先全部放在内存里**,截图耗时不算在内。
- 计时:`openStreamSegmentEncoder('ffmpeg', { encoder, fps: 30 })` 返回之后起表 → 15 次 `enc.write(png)`(等 stdin 收下)→ `enc.finish()` 返回为止。同一批 PNG 连跑 3 次,排序取中间那次(`p50`)。
- 编码器:`server/bakery/ffmpeg.mjs`。**每段起一个 ffmpeg 进程**:`-f image2pipe -c:v png -i pipe:0`(PNG 经 stdin 送进去,ffmpeg 自己解),`-filter_complex` 做预乘、色 / alpha 上下拼合、转 `yuv420p`(tv 范围、bt709),`libx264 -preset veryfast -crf 16 -g 15 -bf 0`,线程数缺省(auto),fMP4 从 stdout 收回。`finish()` 原来等进程 `close`。
- 送进编码器的画面是 1920×2176(色半区 1080 + 8 行黑边 + alpha 半区 1080 + 8 行黑边)。

## 2. 耗时拆分(PC,修前)

PC 在跑另外两个子 Agent 的 C10 探针,CPU 占用 25%～85% 来回跳;下面每项都是交替轮流跑、取中位数。

| 段 | 怎么量 | 结果 |
|---|---|---|
| 进程启动 | `lavfi` 空输入跑一帧 | 42 ms;时间线上 spawn 后 33～46 ms ffmpeg 才开始收 stdin |
| PNG 解码 | 只解不滤(`-f null`) | 到 86 ms 结束(解码本身约 40 ms,单独一个线程,每帧约 1～3 ms) |
| 像素转换(滤镜链) | 解 + 滤、不编 | 到 219～255 ms 结束,滤镜链约 130～170 ms(15 帧,每帧 7～11 ms) |
| 编码 | 解 + 滤 + x264,输出 `-f null` | 315 ms;x264 在滤镜之后再多 60～80 ms |
| 封装、写出 | 同上换成 fMP4 到 stdout | 330 ms;封装本身可忽略 |
| 进程收尾 | 最后一个输出字节 → stdout 关闭 | 25～35 ms(x264 释放内存、收线程) |

再细一层:

- 滤镜链里真正的浪费:预乘后 `format=rgba` 再转回去、alpha 半区多一次 `format=gray`;去掉这两步(见第 3 节)滤镜段从 212 ms 降到 174 ms(高优先级、9 轮中位数)。
- `-benchmark_all`:x264 每次 `encode_video` 调用 0.6～10.6 ms(15 次合计约 77 ms),最后 `flush` 约 43 ms。60 帧的长跑里全流程每帧边际约 10～13 ms,滤镜单独约 7 ms,**滤镜提速之后瓶颈在 x264**。
- x264 内存:`maxrss` 1.79 GB(PC 的 auto 线程数 42)、1.12 GB(24 线程,即笔记本的 auto)、0.55 GB(8 线程);`stime` 与 `utime` 同量级,大头是新内存的缺页清零。每段都是新进程,这部分每段都要付。
- x264 线程数、lookahead 这类参数在 PC 上都不明显变快(第 5 节)。

## 3. 修法(产出逐字节不变)

提交 `0205722`,只改 `server/bakery/ffmpeg.mjs`(另 `server/frame-stream.mjs` 一行):

1. **滤镜链少两趟整帧转换**。旧:`format=gbrap,premultiply,format=rgba,split → [c]format=rgb24,pad / [a]alphaextract,format=gray,format=rgb24,pad → vstack → scale`。新:`format=gbrap,premultiply,split → [c]format=rgb24,pad / [a]alphaextract,format=rgb24,pad → vstack → scale`。送进编码器的原始 YUV 与旧链**逐字节相同**:clip-bg、clip-pill 真帧,以及覆盖全部 alpha 值与颜色组合的合成帧,`yuv420p` 与 `nv12` 两种尾巴都比过(单测里也比)。
2. **分段签名不动**。`encoderParamsHash` 原来哈希 `streamFilter` 的字面,改链会让盘上所有分段作废、重产一遍。新增 `streamFilterIdentity(pixFmt)` 保留旧链字面当身份,`encoderParamsHash` 改按它算;各编码器的哈希值与 main 相同(单测钉死 `libx264 = de84562fd4660af1` 等)。注释写明:以后改链改了产出,必须同时改身份。
3. **预先拉起编码进程**。每种命令行留一个空等 stdin 的 ffmpeg,`openStreamSegmentEncoder` 领走它并补拉一个。同一个可执行文件、同一条命令行,产出相同。空等进程 `unref`(不拖住 Node 退出),60 s 没人领就收掉,Node 退出时 stdin 断开它自己退出、`exit` 钩子再杀一遍;`probeEncoders` 不预拉;`PROMPTCUT_STREAM_PREWARM=0` 关掉。实测(高优先级、11 轮):现拉 308 ms、同时再拉一个备用 289 ms(补拉不拖慢当前这段)、提前拉好 259 ms。
4. **见到 mfra 就交字节**。`finish()` 在输出恰好以一个完整的 `mfra` 顶层盒子收尾时就返回,不等进程释放内存退出(省 25～35 ms)。没收尾而退出码非零,照旧报错(单测:喂坏数据,冷热两种都报错)。

对产出、画质、确定性的影响:**都没有**。字节逐字节相同(探针 `bytes` 修前修后都是 426118,alpha 平均误差都是 0.0956),同样输入仍逐字节相同。

## 4. 修后(PC,前后对照)

| 量法 | 修前(main) | 修后 |
|---|---|---|
| 照探针量法的小基准(同一批 15 张 PNG,每轮一个新 Node 进程,交替 9 轮) | 中位数 339 ms(285～416) | 239 ms(212～404) |
| 同上,另一次 7 轮 | 343 ms(329～414) | 272 ms(265～289) |
| `stream-produce-probe` 全程(交替各 5 次,负载 12%～77%) | p50 = 301 / 360 / 490 / 319 / 492,中位数 360;**5 次都挂这一条** | p50 = 261 / 285 / 266 / 270 / 280,中位数 270;**5 次全过** |

低负载时(25%～40%)修前 285～299、修后 212～228,约省 25%～30%。按这个比例,笔记本的 355～397 ms 估计落在 265～300 ms,**离线不远,必须以笔记本实测为准**。

## 5. 改产出的选项(没做,列给主会话)

PC、高优先级、9 轮中位数,同一套滤镜链:

| 选项 | 耗时 | 分段字节 | 说明 |
|---|---|---|---|
| 现状(auto 线程) | 306 | 426118 | 基准 |
| `-rc-lookahead 5` | 284 | 418700 | mbtree 看得短,画质理论上略降 |
| `-x264-params mbtree=0` | 313 | 640275 | 更大、不更快 |
| `-tune zerolatency` | 268 | 700889 | **超过 512 KB 分段上限**,不可用 |
| `sliced-threads=1` | 290 | 483669 | 接近上限 |
| `-preset superfast` | 281 | 789747 | **超上限**,不可用 |
| 固定线程 4 / 6 / 8 / 12 / 16 / 24 | 350 / 300 / 317 / 312 / 322 / 332(auto 315) | 各不相同 | PC 上不更快;内存从 1.79 GB 降到 0.4～1.1 GB,笔记本上是否更快没法在 PC 上判断 |

这些都会改字节,确定性上「同一台机器、同样输入逐字节相同」不受影响。没有一项在 PC 上明显划算,所以没做。

## 6. 验证(PC)

- `npx tsc -b --force`:退出码 0。
- `npm test`:tests 3407 / pass 3405 / fail 0 / skipped 2。
- 新单测 `server/test/stream-encode-fast.test.mjs` 7 条 + 改过的 `frame-stream.test.mjs` 命令行一条:28 / 28 过。
- `verify-unified-frames --origin http://127.0.0.1:5670`:PASS。
- `stream-produce-probe --group --origin http://127.0.0.1:5670`:退出码 0,`fails: []`。
- `stream-produce-probe --origin http://127.0.0.1:5670`(不带 `--group`):修后 5 次全过(见第 4 节);修前 5 次都只挂耗时这一条。
- `verify-determinism --url "http://127.0.0.1:5670/?export=1"`:1800 帧,Identical 1800 / Different 0,退出码 0(导出 132.3 s)。
- 导出像素与 PC 基准(`.worktrees/pc-g0r-base/out/verify-a/frames`)逐帧比:total 1800 / identical 1800 / different 0 / missing 0 / extra 0,退出码 0。

## 7. 给笔记本的测法

在笔记本上(它的端口段 5580～5599),worktree 检出 `claude/perf-encode` 之后,PowerShell:

```powershell
# ffmpeg 要在 PATH 上:探针里编码和解码都直接调 'ffmpeg'
$env:PATH = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin;$env:PATH"
# 窗口 1:dev server(占 5580、5581、5582)
npx vite --port 5580 --strictPort --host 127.0.0.1
# 窗口 2:跑探针,只看 bench 里 clip-bg 那一条和 fails
node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5580 --json out/perf-encode-probe.json
node -e "const j=require('./out/perf-encode-probe.json');const b=j.bench.find(x=>x.clipId==='clip-bg');console.log(JSON.stringify({p50:b.p50,encodeMs:b.encodeMs,bytes:b.bytes,alpha:b.alpha.mean,fails:j.fails}))"
```

- 探针没有「只跑这一条」的开关,整支跑完约 1 分钟;这条断言看 `bench` 里 `clipId: 'clip-bg'` 的 `p50`(门槛 300)。
- 建议跑 5 次,和 main 的检出交替跑;别的编码器、探针都停着再跑(断言前提「无别的编码器争 CPU」)。
- `bytes` 应当仍是 **428801**(和修前相同,说明产出没变);不是的话告诉主会话。
- 想拆开看预拉进程的作用:同一个窗口先 `$env:PROMPTCUT_STREAM_PREWARM='0'` 再跑。

## 8. 没做成的、待定的

- 笔记本复核:待做(本报告第 7 节)。
- 需要主会话定的事见回复。

## 进度

- [x] 量法与耗时拆分(PC)
- [x] 修法
- [x] 单测
- [x] 验证(PC;耗时门槛待笔记本复核)
- [x] 给笔记本的测法
