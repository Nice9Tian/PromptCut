# 合成统一计划:预览 / 导出 / see_frames 收成一个合成器

## 实施状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 0 真实链路复测 | 完成(2026-09-11,并行分支 `local_4881d18b`) | beginFrame 下整屏素材 52.3 ms/帧,卡片层 24.5;估计整次导出只慢 1.1~1.2 倍,闸门通过(还差真实素材复核) |
| 1 共用画面组件 | 没做 | |
| 2 导出 `--media img` | 没做 | |
| 3 see_frames 换同一个页面 | 没做 | |
| 4 删旧合成 | 没做 | |
| 5 group(Agent 写代码做转场) | 没做 | 这份计划的起因 |

这份计划的每个判断都带出处。出处分三类:**仓库里的文件 / 提交**、**实测**(2026-09-11,这台 28 线程 / 32 GB,1920×1080;第一轮用 puppeteer 25.10.0 自带的 Chrome,阶段 0 用 chrome-headless-shell 152)、**一般经验**(没有原文可引,会标出来)。实测脚本见「附:验证脚本」。

## 起因

用户想让 Agent 自己写代码扩展转场(推入、滑动、缩放穿梭这类要动素材画面的):

> "我觉得可以加一个group功能把一组空间都打包在一个DOM树里面,然后让Agent写卡片一样操作DOM树。"

顺着查下去发现,素材画面现在有**三套各自实现的合成**,group 要三处都认才算数。于是:

> "看起来我们要先把预览,导出都统一成 see_frames。这样才可以继续拓展,不然永远要同时维护三条管线。"

目标(只维护一处合成规则)是对的;但统一的方向不能是 see_frames,理由见下。

## 先说几件和直觉相反的事

1. **see_frames 是三条里最慢的,不能当统一的目标。** 它每一帧的每一层素材都要单独起一次 ffmpeg 抽帧,再在 Node 里用 pngjs 叠。
   出处:"see_frames 3 个时刻 2.3~3.8 s"——`docs/decoupling-plan.md` 各阶段验收表。按这个速度,1800 帧的片子是半小时量级;预览要实时 30 帧,更不可能。
2. **Chrome 画整屏素材,多出来的钱换图解码和 PNG 编码差不多各占一半。**
   出处:验证(beginFrame,阶段 0)——导出步骤下整屏素材 52.3 ms/帧、稀疏卡片层 24.5 ms/帧;多出的 27.8 ms 里换图 + decode 约 12.4、PNG 编码多约 14.6、绘制约 2。
   第一轮用 `page.screenshot` 测时以为「贵的是编码不是换图」(不换图的对照组也要 146.5 ms/帧):那是 page.screenshot 的 PNG 编码慢,放大了编码那一半;beginFrame + `optimizeForSpeed` 下两者相当。
   这和 `docs/render-rebuild-plan.md` 的 "截多大几乎不影响耗时" 不矛盾:那条比的是截图**区域大小**,这里差的是**画面内容**(透明稀疏 vs 满屏细节)。
3. **"Chrome 阶段每帧的钱全省在 seek 上" 只说对了一半。**
   出处:"Chrome 阶段每帧的钱全省在 seek 上"——`docs/decoupling-plan.md`「阶段 6 实测」。阶段 0 在 beginFrame 链路上核实:卡片层每帧 24.5 ms 里,截图 + PNG 编码约 18 ms 是大头,只出帧不截图 3.2 ms;画面从稀疏变满屏,编码再多约 14.6 ms。所以阶段 6 省下的时间里有一部分来自「卡片层稀疏、PNG 好压」,不全是 seek。
4. **导出里不能用 `<video>` 取帧,要用 ffmpeg 解码好的图。**
   出处:"一个 B 帧很多的 B 站 mp4……上旧导出比这条规则晚 1~2 帧 —— 是 Chrome 那边偏了"——`server/export-compose.mjs` 文件头「取素材的哪一帧」一条。

## 现状:三套合成,规则各写一遍

| 路径 | 谁画素材 | 规则写在哪 |
|---|---|---|
| 预览 | DOM `<video>` / `<img>` | `src/editor/preview/MediaLayers.tsx` |
| 导出 | ffmpeg filter graph;Chrome 只渲卡片透明层 | `server/export-compose.mjs` |
| see_frames | 每层 ffmpeg 抽一帧,pngjs 叠 | `server/vision-compose.mjs` |

同一条规则抄了三遍:

- 出处:"和 src/kernel/project.ts 的 opacityAt 同一套:整体不透明度 × 淡入 × 淡出"——`server/vision-compose.mjs` 的 `opacityAt`。
- 出处:"和 kernel/project.ts 的 videoLayersAt 同一个判定,只是多算了 mediaTime。"——`server/vision-compose.mjs` 的 `mediaLayersAt`。
- 出处:"素材层按 ExportView / 预览 MediaLayers 同一套规则拼成一张 filter graph"——`server/export-compose.mjs` 文件头。

抄的代价已经出现过:"旧的导出页不认 frame(一律铺满全屏),导出和预览对不上"——`server/export-compose.mjs` 文件头「摆位」一条。

## 假设

- 交付物仍是 ffmpeg 编码的成片;Chrome 负责出每一帧的画面。
- 预览必须实时播放,所以预览的素材帧来源只能是 `<video>`;这是唯一去不掉的差别,但它只是**帧来源**,不是合成规则。
- 可以接受导出变慢一些来换「一处规则」,具体能接受多少由阶段 0 的数字决定。

## 推荐方案:Chrome 页面是唯一的合成器

```
            同一棵组件树(素材层 + 卡片 + 以后的 group)
            摆位 / 淡化 / 强调 / 毛玻璃 / 叠放顺序只在这里写一次
                 │                     │                      │
          预览(编辑器)            导出(export-frames)       see_frames
       素材帧 = <video>        素材帧 = ffmpeg 解码的图     素材帧 = ffmpeg 解码的图
         实时播放                  beginFrame 逐帧截            只截要看的那几帧
```

- 素材槽位在导出 / 看图里是 `<img>`,每帧 `await img.decode()` 之后才算这一帧就绪。
- 可以删掉的:
  - `export-compose.mjs` 里手拼的素材滤镜图(摆位、cover、淡化、强调、交叉溶解);
  - `vision-compose.mjs` 的 pngjs 叠图;
  - 毛玻璃的「多截一张玻璃遮罩、ffmpeg 按遮罩模糊素材层」—— Chrome 里素材就在 `backdrop-filter` 底下,原生就能画。
    出处:"卡片毛玻璃:底下有素材的帧多截一张玻璃遮罩(页面临时只留玻璃涂白),ffmpeg 按遮罩把素材层模糊后混回去"——commit `a19db18` 说明。
- group 不用再单独设计合成:它本来就在同一棵 DOM 树里。

### 没选的路线

| 路线 | 为什么不选 |
|---|---|
| 字面意义的「统一成 see_frames」 | 最慢,见上文第 1 条 |
| ffmpeg 当合成器,三处共用一份「合成计划」函数 | 预览为了实时仍要在 DOM 里把每条规则再实现一遍,还是两套;Agent 写的 DOM 代码翻译不成 ffmpeg 滤镜,group 走不通 |
| Agent 写 GLSL,ffmpeg `gltransition` 合成 | 验证:本机 ffmpeg 9.0.1 full_build 的 `-filters` 里没有 `gltransition`,要自编 ffmpeg 并随包分发 |
| `xfade` 的 `transition=custom` + `expr` | 本机有,但预览要在浏览器里 1:1 复刻 ffmpeg 的逐像素算法;和 Gemini 讨论第 2 轮一致放弃 |
| 只在 group 那几秒走 Chrome,其余照旧 ffmpeg | 导出几乎不变慢(10 处 1 秒转场约多 11 s),但合成规则仍是两套,不满足「只维护一处」。**如果阶段 0 的代价太大,这是退路** |

## 实测

### 阶段 0:beginFrame(导出同款链路)

chrome-headless-shell 152、1920×1080,每项 120 帧、预热 10 帧,单位 ms/帧。测试脚本在并行分支 `local_4881d18b` 的 scratchpad(`bench-bf.mjs`)。

| | 稀疏卡片层 | 整屏素材(两张 1080p 推入,每帧换图) |
|---|---|---|
| 不绘制(`noDisplayUpdates`) | 0.6 | 1.7 |
| 只出帧不截图 | 3.2 | 18.1(其中换图 + decode 13.0) |
| 出帧 + PNG `optimizeForSpeed` | 21.4 | 48.0 |
| PNG 默认 | 48.8 | 133.3 |
| JPEG q92 | 16.8 | 32.7 |
| **导出实际步骤**(空拍 + 截 PNG 快速) | **24.5** | **52.3** |

- 卡片层 24.5 和 `docs/render-rebuild-plan.md` 的 26.9 对得上,测法可信。
- 坑:headless-shell 里 `Target.createTarget` 传的 width / height 不生效,截出来是 800×600,必须再调一次 `page.setViewport`(`server/bakery/bake.mjs` 的 `bakeFrames` 已经这样做)。

### 第一轮(`page.screenshot` 测法,已被上表取代)

页面上两张 1080p 图做推入(一张往左推出、一张从右推入),每帧换两张图、等 decode、截图,各测 60 帧:

| 截法 | 每帧 | p95 |
|---|---|---|
| 页面透明空白(≈ 现在只有卡片层) | 49.4 ms | — |
| 整屏素材,PNG 默认 | 168.4 ms | 264.6 ms |
| 整屏素材,PNG `optimizeForSpeed`(导出同款) | **70.2 ms** | 88.9 ms |
| 整屏素材,JPEG q92 | 53.4 ms | 73.8 ms |
| 整屏素材,WebP 无损 | 145.7 ms | 206.7 ms |
| 其中「换图 + 等 decode」 | 16.1 ms | 19.6 ms |
| 抓到上一帧的图 | **0 / 60** | |

### 粗算对导出的影响(估计)

拿阶段 6 的 60 秒测试项目算:

- 现在:Chrome 阶段 62.8 s(每帧 35.0 ms,含 1084 张毛玻璃遮罩)+ overlay 12.4 s + 素材合成 21.1 s,墙钟 95.8 s。
  出处:`docs/decoupling-plan.md`「阶段 6 实测」表。
- 统一后:Chrome 阶段约 1800 × 52.3 ms ≈ 94 s;不再有素材合成(21.1 s)和 1084 张遮罩;成片编码另算,按现在 overlay 那一步的量级 12~21 s。估计墙钟 105~115 s,约为现在的 1.1~1.2 倍。
- 第一轮按 `page.screenshot` 的 70.2 ms/帧估的是 130~140 s(1.4~1.5 倍),偏悲观,作废。
- 仍在的偏差:测试图是 testsrc2 / mandelbrot,细节比真实素材多、PNG 更难压;真实项目也不是每一帧都满屏素材。要用真实素材复核一次(阶段 2 的对账会顺带给出)。

## 阶段

### 0. 真实链路复测(闸门)—— 已完成
- 做了:chrome-headless-shell + `beginFrame`,按导出的实际步骤各测「稀疏卡片层」和「整屏素材」,数字见「实测」。
- 结果:整屏素材 52.3 ms/帧,比卡片层多 27.8 ms,低于判定线 35 ms;估计整次导出只慢 1.1~1.2 倍。**闸门通过**。
- 还欠:真实 1080p 素材抽的帧没测(用的是合成测试图),阶段 2 对账时用真实项目补上。
- 原判定标准:增量明显低于 35 ms → 往下走;35 ms 左右或更高 → 由人决定,或者走「只在 group 范围走 Chrome」的退路。

### 1. 抽出共用的画面组件
- 做什么:把 `MediaLayers` 的摆位 / 淡化 / 强调 / 叠放拆成一个与帧来源无关的组件,槽位由调用方决定是 `<video>` 还是 `<img>`;`ExportView` 改用它。
- 产出:预览和导出页挂同一份组件。
- 预计:2~3 天。
- 完成的标志:预览行为不变(`scripts/preview-boxes.mjs` 这类现有检查照过)。

### 2. 导出加 `--media img`
- 做什么:ffmpeg 按现有取帧规则(`fps=round=up`)边解码边供帧(不先全部落盘),页面槽位按帧号取图;帧就绪条件并入现有的 `__pcFrameReady`。
- 产出:`export-frames --media img`。
- 预计:2~3 天。
- 完成的标志:60 秒测试项目上和现在的导出逐帧对账,均差量级和阶段 6 一致(1~2/255);墙钟时间记进本文。对账方法照 `docs/guides/compare-pitfalls.md`。

### 3. see_frames 换同一个页面
- 做什么:看第 t 秒 = 导出页只截那几帧,素材帧同样由 ffmpeg 抽好喂进去。
- 预计:1 天。
- 完成的标志:see_frames 出图和导出同一帧逐像素一致;耗时不比现在的 2.3~3.8 s 差太多。

### 4. 删旧合成
- 做什么:删 `export-compose.mjs` 的素材滤镜图和毛玻璃遮罩流程、`vision-compose.mjs` 的叠图;保留 `--media ffmpeg` 一个版本周期作回退。
- 预计:1 天。
- 完成的标志:`server/test/` 里相关单测改写或删除,全部通过。

### 5. group
- 数据:项目里新增 `groups[]`(`{ id, members, start, end, cardId, params }`);成员时间关系照搬转场的锁定规则(`timingLock`)。
- 组件合约:和卡片同一套(读 `t`、禁 `Date.now`),宿主提供 `<Slot id="a"/>`,Agent 只改槽位外层的 transform / clip-path / opacity / filter,也可以把槽位画进 WebGL 做着色器转场。
  出处:"`<canvas>`、`Math.random`、**WebGL 和 three 现在都接得住**"——`server/card-authoring-guide.md` 审查档位表。
- Agent 工具:`create_group_card`、`add_group`,写作指南补一节,先示范一个推入转场。
- 命名要换:代码里「组」已经被交叉溶解占了。
  出处:"这个片段所在的组:靠交叉溶解一路串下去的所有片段"——`src/kernel/transitions.ts` 的 `groupOf`。
- 预计:3~4 天(阶段 1~4 做完之后)。

## 优点 / 缺点 / 限制

- **优点:合成规则只有一份。** 取帧以外的每条规则只写一次,预览和导出天然一致,「导出和预览对不上」这类问题从根上没了。
- **优点:取帧比 Chrome `<video>` 准。** 由 ffmpeg 决定取哪一帧,出处见「先说几件事」第 4 条;实测喂帧 0/60 抓错。
- **优点:毛玻璃不再需要遮罩特技,group 不再需要单独设计合成。**
- **缺点:导出变慢,估计 1.1~1.2 倍。** 出处见「粗算」(阶段 0 的 beginFrame 实测);0.5.0 省下的时间(148.9 → 95.8 s)只吐回去一小部分。
- **缺点:有视频的帧永远判不了静止,跳帧优化对这些帧无效。**
  出处:"画面里有视频的帧也永远判不了静止"——`server/export-compose.mjs` 文件头。
- **缺点:中间帧量大。** 验证:1080p JPEG q3 每张约 200 KB(120 张 24 MB);整片多层是几百 MB,必须边解码边喂。
- **风险(部分核实):图片没解码完就截,抓到上一帧;高频换大图内存上涨。** 来自 Gemini 讨论第 2 轮("截图就会抓到白屏或上一帧残像",它标的是猜测)。60 帧短测 0/60 抓错;长片的内存没测,阶段 2 要盯。
- **限制:预览 `<video>` 和导出 `<img>` 仍是两种帧来源,颜色转换可能有细微差别。** 旧导出(Chrome 画视频)和新导出比均差 1.43/255,可接受。
  出处:"全屏视频 + 毛玻璃卡(第 300 帧)均差 1.43/255"——`docs/decoupling-plan.md`「阶段 6 实测」。
- **限制:这是部分推翻 0.5.0 的方向(commit `a19db18`),需要明确接受导出变慢。**

## 第一步

阶段 0 已做完。下一步是阶段 1 的起点,约半小时:通读 `src/editor/preview/MediaLayers.tsx` 和 `src/ExportView.tsx` 的素材渲染,列出两边摆位 / 淡化 / 强调 / 叠放各自怎么写、哪里不一致,定下共用组件的接口(槽位由调用方给 `<video>` 还是 `<img>`)。

## 附:验证脚本

测试帧(放在脚本旁边的 `frames/`):

```bash
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=30 -frames:v 60 -q:v 3 frames/a_%03d.jpg
ffmpeg -hide_banner -loglevel error -y -f lavfi -i mandelbrot=size=1920x1080:rate=30 -frames:v 60 -q:v 3 frames/b_%03d.jpg
```

`frames/page.html`:两层 `.slot`(`position:absolute; inset:0; overflow:hidden`),里面 `<img>` `object-fit:cover`;`window.setFrame(i, n, withImages)` 换 `a_/b_` 第 i 张、`await decode()`、按进度设 `translateX`,再等两次 rAF。

`bench-img2.mjs`(截法对比那张表):

```js
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire('C:/Users/admin/Documents/PromptCut/package.json');
const puppeteer = require('puppeteer');

const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'frames');
const N = 60;
const browser = await puppeteer.launch({ headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(dir, 'page.html')).href);
const cdp = await page.createCDPSession();

const modes = {
  'png 透明(同导出卡片层)': () => page.screenshot({ omitBackground: true }),
  'png optimizeForSpeed': () => page.screenshot({ omitBackground: true, optimizeForSpeed: true }),
  'jpeg q92': () => page.screenshot({ type: 'jpeg', quality: 92 }),
  'jpeg q92 optimizeForSpeed': () => page.screenshot({ type: 'jpeg', quality: 92, optimizeForSpeed: true }),
  'webp 无损': () => cdp.send('Page.captureScreenshot', { format: 'webp', quality: 100 }),
};
for (const [label, shot] of Object.entries(modes)) {
  for (let i = 0; i < 5; i++) { await page.evaluate((i, n) => window.setFrame(i, n, true), i, N); await shot(); }
  const ts = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await page.evaluate((i, n) => window.setFrame(i, n, true), i, N);
    await shot();
    ts.push(performance.now() - t0);
  }
  const avg = ts.reduce((x, y) => x + y, 0) / N;
  const p95 = [...ts].sort((x, y) => x - y)[Math.floor(N * 0.95)];
  console.log(`${label}: ${avg.toFixed(1)} ms/帧 (p95 ${p95.toFixed(1)})`);
}
await browser.close();
```

`bench-img.mjs`(换图 vs 截图拆开计时、帧号核对)结构相同:每帧分别计 `setFrame` 和 `page.screenshot({ omitBackground: true })` 的耗时,并核对 `currentSrc` 是否是第 i 张;先跑一轮不换图的对照,再跑换图,再跑一轮对照。
