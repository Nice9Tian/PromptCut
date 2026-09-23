# R1b 报告：像素映射的主动分流与 WebGL 后端

- worktree：`C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-a0446299d2540c004`
- 分支：`worktree-agent-a0446299d2540c004`（**未 push、未合并、未动 main、未动别的 worktree**）
- 起点：worktree 原本停在 `c98a3cc`，比任务书说的 `7f10ebe` 落后 4 个提交、缺 `curves` / `matrix`。
  工作区干净、无自有提交，已 `git merge --ff-only main` 快进到 **`7f10ebe`** 再开工。

## 提交列表（`7f10ebe` 之后）

| SHA | 说明 |
|---|---|
| `8ff6564` | 滤镜：表达式解析器产出语法树（`parseExpr` / `astToFn`），并补一份查表/矩阵的数值参考实现（`sampleTable` / `applyTableOp` / `applyTableOps`） |
| `c35da6e` | 像素映射：分类器 `classifyPixelMap` + GLSL 翻译 `compilePixelMapGlsl` |
| `5e3cca6` | 像素映射工具：整帧调色当场拒绝并回等价的 `create_filter` ops；三个工具描述同步改 |
| `1886247` | 像素映射：改走 WebGL2 片元着色器，逐像素的 CPU 循环整体删除 |
| `4943519` | 探针：GPU / CPU 逐像素对照与 1080p 单帧成本；顺带修 `colorSequence` 的并列取色 |
| `37015c1` | 探针：跑完把 vite 的整棵进程树收掉（Windows 上 `kill()` 打不到真正占端口的那个 node） |

改动文件：`src/kernel/filters.mjs`、`filters.d.mts`、`src/kernel/pixelMap.mjs`、`pixelMap.d.mts`、
`pixelMap.test.mjs`、`src/mcp/tools/pixelMapTools.ts`（新测 `pixelMapTools.test.mjs`）、
`server/tools/effects.mjs`、`src/render/FrameScene.tsx`、新 `src/render/pixelMapGl.ts`、
新 `scripts/probes/pixelmap-gl-probe.mjs` + `pixelmap-gl-harness.html`。
**任务书点名不许碰的 10 个文件一个都没碰。**

---

## 1. 验收结果

### 1.1 `npx tsc -b --force` / `npm test`

- `tsc -b --force`：**零错误**（退出码 0，无输出）。
- `npm test`：**tests 1475 / pass 1474 / fail 0 / skipped 1**（基线是 1466 / 1465 / 0 / 1；新增 9 条：
  `pixelMap.test.mjs` 8 条、`pixelMapTools.test.mjs` 1 条聚合用例）。

### 1.2 单测

`src/kernel/pixelMap.test.mjs`
- **A 类 7 例**：通道曲线（gamma）、单通道曲线、线性混色、按亮度去色、通道对调、
  常数 `where=0.5` 折进系数、整帧纯色。每例都断言 `kind === 'A'`、`diff ≤ 1`、出的是
  `curves` 还是 `matrix`、并且 **ops 能直接过 `normalizeFilterDef`**。
- **A 类逐值**：`r^1.6` / `g^0.8` / `b*0.9+0.05` 在 256 级上逐级比 `mapRgba`，最大差 ≤ 1；
  3×3 线性混色 `pixelMapOpsDiff === 0`。
- **B 类 11 例**：含任务点名的那条抠色表达式
  `smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))`（→ B ✓）、抠色到纯色、按 `x`、按 `y`、
  按 `t`、整帧透明、目标是另一段素材（`usesTarget === true`）、阶跃函数、改 alpha、
  `colorSequence` 的 continuous 与 discrete。
- **C 类**：`(r-g)^0.5`、`pow(r-g, luma)` 判 C；`abs(r-g)^0.5`、`(r-g)^2` 判 B。
- **GLSL 关键片段**：版本行、`uTex`、luma 系数、`pc01v(texture(...))`、`where` 的完整翻译、
  `if (!(w > 0.0)) { fragColor = src; return; }`、`fragColor = src*(1.0-w)+target*w`、
  `target = vec4(src.rgb, 0.0)`、`row = uSize.y - gl_FragCoord.y - 0.5`（y 从上往下）、
  顶点用 `gl_VertexID`；函数逐个对应（`lerp→mix`、`^→pow`、`round→floor(x+0.5)`、
  `t→uT`、`mod`、`min` 折叠、`clamp`、`step`、负底数整指数 `sign()*pow(abs())`），
  并**遍历解析器的整份白名单函数表**确认一个都翻译得出来；颜色序列的 `PC_FROM` / `PC_SEQ_EPS` /
  `dot(dv,dv)` / discrete 与 continuous 两支；同定义同 `key`、异定义异 `key`。

`src/mcp/tools/pixelMapTools.test.mjs`：A 拒绝（不落库）+ 从错误正文里抠出 ops、过
`normalizeFilterDef`、再和原定义在 256 级上逐值比（≤1）；B 接单回 `backend:'webgl'` 且挂到片段上；
C 拒绝并说明哪一处；`update_pixel_map` 改成 A 类也被拒且库里那条不变。

### 1.3 GPU 对 CPU 的画面对照（1080p）

`node scripts/probes/pixelmap-gl-probe.mjs`，**真 GPU**：
`UNMASKED_RENDERER_WEBGL = ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)`，
`WebGL 2.0 (OpenGL ES 3.0 Chromium)` —— 不是软件渲染。
源图 `testsrc2` 1920×1080，node 用 pngjs 解出原始字节灌进页面，参考图在 node 用保留下来的
`mapRgba` 逐像素算；GPU 侧用 `readPixels` 直接取着色器输出（绕开画布转移，量的是着色器本身）。
8 294 400 个通道值（1920×1080×4）。

| 用例 | 类 | 最大差 | >1 级 | >2 级 | 均差 |
|---|---|---|---|---|---|
| 抠色到透明 | B | **1** | 0 | 0 | 0.00002 |
| 抠色到纯色 | B | **1** | 0 | 0 | 0.00006 |
| 按位置（`x`·`y`）渐变选区 | B | **1** | 0 | 0 | 0.01824 |
| 按时间闪烁（`t`） | B | **1** | 0 | 0 | 0.00093 |
| 颜色序列 continuous | B | 255 | 39 | 39 | 0.00083 |
| 颜色序列 discrete | B | **0** | 0 | 0 | 0 |
| 目标是另一段素材 | B | **1** | 0 | 0 | 0.00004 |
| 通道非线性表达式 | B | **1** | 0 | 0 | 0.00013 |

**7 / 8 达标（≤1 级，远好于 ≤2 的门槛）。超标的那一条说明如下。**

#### 颜色序列 continuous 为什么会出 255 级（39 个通道值 = 13 个像素 / 2 073 600，占 0.00063%）

不是翻译错了，是**精确并列点**。`sequenceTarget` 取色靠 RGB 欧氏最近邻；
`from = [#000000, #808080, #ffffff]` 时，到前两个 from 色的平方距离差是 `2·v₁·S − 3·v₁²`
（`S = r+g+b`、`v₁ = 128/255`），令它为 0 解出 `S × 255 = 192.0` —— 也就是
**`r+g+b` 恰好等于 192 的像素在数学上精确等距**。我逐个核过这 13 个像素，源色全是
`(0,51,141)` / `(0,49,143)` 这类和为 192 的。

并列时 `sequenceTarget` 用的是严格小于，本意是**取靠前那个**。着色器按这个本意办
（`dd < best - PC_SEQ_EPS`，`PC_SEQ_EPS = 1e-6`：比 float32 在这个量级的噪声大约三个数量级，
比 8 位输入能产生的相邻非并列距离差 `2·v₁/255 ≈ 4e-3` 小约三个数量级，不会误伤）。
而 `mapRgba` 在 float64 上把这件事交给了 `Math.hypot` 的末位舍入 —— 我实测这 8 个并列色里
`Math.hypot` 有 5 个判成"并列"、2 个判成 idx1、1 个判成 idx0；改成比平方距离也一样不稳
（`s0-s1` 是 `±5.55e-17` 这种量级）。**所以这几个像素上着色器才是守规矩的那一个。**

逐像素取色本来就是离散映射，等距点上必然跳变；这类差异只可能出现在 `colorSequence` 上，
且只出现在恰好等距的像素上，`discrete` 那一条（from 是 4 个灰阶，没有整数解）实测 **0 级差**。

### 1.4 性能（1080p 视频，抠色到透明）

| 量 | 值 |
|---|---|
| 预热（编 program + 建纹理，第一帧） | 0.40 ms |
| **主线程提交 p50 / max**（`texImage2D` + `drawArrays` + `transferToImageBitmap`，含一次同步） | **0.200 ms / 0.300 ms** |
| **GPU 真实耗时 p50 / max** | **0.017 ms / 0.018 ms** |
| 计时口径 | `EXT_disjoint_timer_query_webgl2`（本机 Chrome 给了这个扩展，不用退回墙钟），查询包住整段「上传纹理 + 绘制」，`GPU_DISJOINT_EXT` 为真的样本丢弃 |
| 对照：CPU 逐像素实现（2.1(b) 实测） | **416～483 ms** |

- 主线程成本从 416～483 ms 降到 ≤0.3 ms，**约 1500～2400 倍**；30 fps 的每拍预算 23.3 ms 里只占 **1.3%**，
  60 fps 的 11.67 ms 里占 2.6%。
- 注意 `performance.now()` 在非跨源隔离页面上被粗化到 0.1 ms，所以 24 个提交样本只取到
  0.100 / 0.200 / 0.300 三个值 ——「p50 = 0.2 ms」的精度就是 ±0.05 ms，只能说"亚毫秒"。
- GPU 侧 17 µs 这个数偏小得可疑：视频帧解码后本来就在 GPU 纹理里，`texImage2D(video)` 在
  ANGLE 上多半是 GPU 到 GPU 的拷贝甚至零拷贝，计时查询量不到 CPU 侧的准备工作。
  **要给预算表用的数请取主线程那一列（≤0.3 ms）**，GPU 那一列只说明着色器本身不是瓶颈。

### 1.5 带像素映射的素材段真实导出

`out/export-check2.mjs`（脚本副本在 `r1b-data/export-check2.mjs`）：起 vite 5199，把整份工程塞进
`?export=1&timeline=`，用 `scripts/export-frames.mjs`（`npm run export` 的同一条路）出帧。
工程 960×540 / 30 fps，一段图片素材挂 `抠绿填紫`（`where` 是那条抠色表达式，`to = #6633cc`，分类 **B**）。

- `npm run export` 路径**不报错**：`Export finished in 0.2s (4 frames)` → `overlay.mov` → `preview.mp4`，
  `Video synthesis complete.`，退出码 0。产物 `frames/ overlay.mov preview.mp4` 齐全。
- 画面正确：导出帧与 `mapRgba` 在同一张源图上逐像素比，**1 555 200 个通道值最大差 = 0 级**
  （直方图 `0级:1555200`，其余全 0）。也就是说 **WebGL 后端在真实导出链路上和 CPU 参考实现完全一致**。
- 对照图：`r1b-data/export-src-green-still.png`（源）、`export-frame-000000.png`（导出帧）。

> 顺带一条量法陷阱：我一开始用**视频**当源，导出帧对 `mapRgba` 差到 8 级。原因不在像素映射，
> 在于**同一段没标色彩矩阵的 H.264 在 Chrome 和 ffmpeg 里解出来的 RGB 不一样**
> （`export-compose` 的 `untaggedMatrix` 就是为这件事留的口子）：同一点 Chrome 解出 ≈(0,200,60)、
> ffmpeg 解出 (0,192,64)，`where` 因此从 0.72 变成 0.56。**验收像素映射要用图片当源**，
> 拿视频量的是解码差异。（视频那一趟也跑通了，导出无报错、绿区确实变成了紫色。）

---

## 2. 导出的像素基线怎么变

1. **会变，但幅度极小。** 不涉及 `colorSequence` 的定义：1080p `testsrc2` 上最大差 1 级、
   超过 1 级的通道值 0 个；540p 图片素材的真实导出上 **0 级**。
2. **`colorSequence` 的定义**：只在「到两个 `from` 色精确等距」的像素上会整块换色
   （实测 13 / 2 073 600 像素 = 0.00063%，且换过去的才是 `sequenceTarget` 本意要的那个）。
3. **逐字节基线必然变**（PNG 内容变了）。凡是钉死导出字节的基线都要重录一次。
4. **帧缓存 / 共享快照会自动失效，不用手动清**：`server/frame-code.mjs` 的 `frameCode()` 会整树
   walk `src/**` 下的 `.ts/.tsx/.mjs/.css/.json`，我改的 `src/kernel/pixelMap.mjs`、
   `src/render/FrameScene.tsx` 和新增的 `src/render/pixelMapGl.ts` 都在里面。
   `captureCode` / `freezeCode` 只哈希服务端的截图与冻结文件，不受影响，也不需要受影响
   （像素映射在素材层上，不是卡片，不进共享快照的键）。
5. **预览侧的基线也一起变了**：今天的编辑器预览（`MediaLayers`）根本不画像素映射，只有导出页和
   `see_frames` 画；R3 把素材层搬进舞台之后三处共用 `pixelMapGl`，天然一致。

---

## 3. 任务书要改的句子（逐条）

### 3.1 `render_pipeline_restructure.md` 3.9 的分类表，A 类那一行

> 现文：`colorSequence 只按 luma 取色` → 判 A，等价物是「一步取亮度的 matrix + 一步 curves」。

**两处不对，建议整条删掉或改写：**

1. **不是 luma，是算术平均。** `sequenceTarget` 用的是 **RGB 欧氏最近邻**，不是按亮度查表。
   对灰阶 `from` 序列而言，点 `(r,g,b)` 到灰点 `(v,v,v)` 的距离在 `v = (r+g+b)/3` 时最小 ——
   决定取哪个色的是**算术平均**，不是 `0.2126/0.7152/0.0722` 那套亮度权重。
   等价物里那一步 matrix 的系数应该是 `1/3` 九个，不是亮度系数。
2. **更要紧的是：这条判据在现有语义下几乎永远不成立。** 最近邻取色的输出是**阶梯函数**
   （`from` 有 n 个色就只有 n 档），33 点的取样表线性插值表示不了台阶。实测
   `from=[#000,#808080,#fff]`、`to=[#001133,#ffcc88,#ffffff]` 取样成 matrix+curves 之后
   逐值差到 **215 级**；`discrete` 的那条差 **239 级**。
   
   建议改成：**「`colorSequence` 一律判 B」**，并在括号里写明理由（最近邻是阶梯函数，取样表表示不了）。
   我的实现仍然照任务书把 A 路走了一遍（灰阶 `from` → 1/3 矩阵 + 曲线），只是让逐值核对把它挡了回来，
   代码和注释都在，将来如果 `sequenceTarget` 改成真的按标量查表，这条路立刻就能通。

### 3.2 3.9 A 类判据要补一句「取样完还要核对」

> 现文：A 类「都能从已编译的表达式里静态看出来」。

**光看形状不够。** 形状对上、取样成 33 点表之后，**等价物不一定等价**：
- `step()` / `round()` 这类阶跃函数：形状是「每通道只依赖自己」，但取样成表之后实测差 **9 级**；
- 带 `offset` 的矩阵：`mapRgba` 算的是 `clamp01(M·rgb + d)`，而 `matrix` 那一步是
  `clamp01(clamp01(M·rgb) + d)` —— **截断顺序不同**，撞到边界就对不上。

建议补一句：**「静态判完形状，还要拿等价 ops 和 `mapRgba` 在 0～255 全值域上逐值核对一遍，
差 > 1 级就退回 B」**。我就是这么实现的（`pixelMapOpsDiff`，取样 256 级灰阶 + 每通道 256 级
（另两通道 0/½/1）+ 33³ 网格，约 3.9 万点，A 类定义上耗时 20～30 ms）。
这样「判了 A 就一定能换」是有保证的，不靠人肉推演。

### 3.3 3.9 A 类判据要写清楚 alpha 的口径

任务书没提 alpha。`curves` / `matrix` 都**改不了 alpha**，而像素映射会：
`out_a = a·(1−w) + target_a·w`。我的口径（建议写进 3.9）：
- `to` 是 `expr` 且 `to.a` 恒等（默认就是 `"a"`）→ alpha 对所有 `a` 都不变，可判 A；
- `to` 是**不透明**颜色 / 颜色序列 → 不透明素材上等价（`a=1 → out_a=1`），可判 A，
  但回包要带一句「半透明像素上原定义还会把 alpha 一并推向目标色」；
- `to.a` 会改 alpha、`to` 是 `transparent`、`to` 是半透明颜色 → 一律 B。

### 3.4 3.9「C 类：出现 GLSL 没有对应物的写法」几乎是空集

解析器的白名单函数 `sin cos tan abs sqrt exp log floor ceil round sign min max pow mod
clamp lerp step smoothstep` **在 GLSL ES 3.00 里一个不缺**（`lerp→mix`；`mod` 的定义
`x - y*floor(x/y)` 两边逐字相同；`round` 要写成 `floor(x+0.5)` —— GLSL 的 `round()` 在正好 `.5`
时往哪边取**由实现决定**，`Math.round` 恒为向上）。所以按字面判据 C 永远不会发生。

我把 C 落在一条真实存在的语义差上：**底数可能为负、指数又不是整数常量的乘方**。
`Math.pow(-2, 3) = -8` 有定义，GLSL 的 `pow` 在底数为负时**无定义**。
（底数能静态证明非负 → 直接 `pow`；指数是整数常量 → 偶数 `pow(abs(x),n)`、奇数
`sign(x)*pow(abs(x),n)`，都和 JS 逐值一致；其余判 C，错误里直接告诉模型「把底数包进 `abs()`
或把指数写成整数常量」。）建议把 3.9 的 C 行改成这一条，别留一个永不触发的判据。

### 3.5 3.9「画完 `drawImage` 到素材层自己的 `<canvas>`」

**别用 `drawImage`，用 `transferToImageBitmap` + `bitmaprenderer`。** 理由：
1. `drawImage` 走 2D 合成，源画布是直通 alpha（`premultipliedAlpha:false`），目标 2D 画布内部是
   预乘存储 —— 每来回一趟低 alpha 的像素就掉一两级，而**抠色正是大量产生低 alpha 像素的活**；
2. `transferToImageBitmap` 是整块位图的转移，像素逐个原样落地，目标画布尺寸也跟着走；
3. 离屏画布用 `OffscreenCanvas`，不进 DOM，也就不会多出一个要被 HTML 快照序列化的 canvas。

代价要一并写进任务书：**素材层那张画布因此不能再有 2D 上下文**（一个画布只能有一种）。
已核过两个消费方都不受影响 —— `snapshotFreeze` 的 `toDataURL` 照常工作，
`contentBox.canvasPixels` 本来就是 `drawImage` 到一张离屏 2D 画布再读（它的注释写明了
"不能用 `el.getContext('2d')`，WebGL 画布上返回 null"）。

### 3.6 3.9「变量 `r g b a luma x y t` 对应 uniform / 纹理取样」要写死 x/y 的口径

CPU 循环里 `x = 列 / 宽`、`y = 行 / 宽高`，**且行是从上往下数**（`ImageData` 的行序），
用的是**整数列行**而不是像素中心。着色器要写成
`col = gl_FragCoord.x - 0.5`、`row = uSize.y - gl_FragCoord.y - 0.5`，再除以画面宽高 ——
直接用插值出来的 uv 会差半个像素（1080p 上 4.6e-4），碰上 `step(0.5, x)` 这种硬边界就会整列偏一格。

### 3.7 R1b 那一行的验收「1080p 播放 0 长任务」

这一条**这一步量不了**：今天的编辑器预览（`MediaLayers`）根本不画像素映射，导出页是逐帧推进、
没有播放循环。我量的是等价的、更直接的数：**1080p 单帧主线程 ≤0.3 ms**（见 1.4），
远在 50 ms 的长任务门槛之下。建议把这一句改成「1080p 单帧主线程耗时 < 1 ms」，
「0 长任务」留到 R3 把素材层搬进舞台之后再验。

### 3.8 一个和 R1b 无关、但顺手发现的口径问题

`normalizePixelMapDef` **忽略 `colorSequence.mode`**：存下来的 `colorSequence.mode` 直接抄的是
**顶层 `mode`**，而 `mapRgba` / 着色器用的也是顶层 `def.mode`。可是
`create_pixel_map` 的工具描述写的是
"colorSequence:{from:[...],to:[...],mode:'continuous'}" —— 模型照着写 `colorSequence.mode`
是不生效的。我在工具描述里补了一句「顶层 mode 说了算，colorSequence 里的 mode 只是回显」，
**没有改 normalize 的行为**（那会动到已有工程的语义，超出 R1b 范围）。
建议单开一条：要么让 `colorSequence.mode` 生效，要么在 schema 里把它删掉。

---

## 4. 实现上的几个决定（备查）

1. **表达式解析器产出语法树。** 原来的 `compileExpr` 边解析边搭闭包，外面看不到形状；
   分类器要静态判断「引用了哪些变量、是不是每通道只依赖自己」，GLSL 翻译要按形状走，
   所以拆成 `parseExpr`（产树）+ `astToFn`（树→闭包），`compileExpr` 仍是两者的合成。
   **节点计数、报错文案、报错位置一律不变**，滤镜那边 18 条老单测原样通过。
2. **`applyTableOp` 放在 `filters.mjs`。** 它是「一步 curves / matrix 在数值上做什么」的唯一定义
   （预览的 SVG 和导出的 `lutrgb` / `colorchannelmixer` 是同一个口径：每步各自截到 0～1，
   矩阵的 `offset` 在混色**截断之后**再加），分类器拿它核对等价性。
3. **矩阵系数用基向量探出来，准不准交给逐值核对。** 不做符号求解，代码短、覆盖面反而更广
   （`luma` 是线性的，自动就被吃进去了）。
4. **`stage=after_filters` 仍走一张中转 2D 画布**（`ctx.filter = cssFilter(ops)` 再 `drawImage`），
   然后把这张画布当纹理上传 —— 滤镜由合成器在 GPU 上做，**不读回像素**。
   `stage=origin` 直接上传素材元素，比原先少一次重采样。
5. **纹理上传关掉色彩空间转换**（`UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`）、
   关掉预乘，要的是素材原样的数值。
6. **上下文丢失**：`webglcontextlost` 里 `preventDefault()` 并把上下文、program 缓存、纹理整套丢掉；
   每次画之前查 `gl.isContextLost()`，下一次画时重建。
7. **画不出来时该层空着**并写 `data-pc-pixel-error`，不拖垮整棵场景树（着色器编译失败、
   没有 `OffscreenCanvas` 这类）。
8. **`mapRgba` 保留但不再进任何渲染路径**，只给单测和 GPU/CPU 对照用；`window.__pcMapRgba`
   这个桥也留着（注释写明了新身份）。

---

## 5. 遗留问题

1. **`colorSequence` 的精确并列点**（1.3）：13 / 2 073 600 像素（0.00063%）。不打算再改 —— 要对上只能在 GPU 上
   复刻 float64 的 `Math.hypot`，做不到；而且着色器这边才是守 `sequenceTarget` 本意的那个。
   如果以后想彻底去掉这个不确定性，正路是把 `sequenceTarget` 的距离比较改成**整数**
   （输入本来就是 8 位），两边都精确、并列规则也就精确了 —— 那会动到 `mapRgba` 的既有语义，
   我没做。
2. **`colorSequence.mode` 被忽略**（3.8）：没改行为，只在工具描述里说清楚了。
3. **A 类的 `to` 是不透明纯色时**，等价滤镜只在不透明素材上成立（半透明像素上原定义会把 alpha
   一并推向不透明）。工具回包里带了这句提醒（`alphaNote`），但没有办法在落库前知道素材透不透明。
4. **性能数字的精度**：`performance.now()` 粗化到 0.1 ms（页面不是跨源隔离的）；GPU 计时查询
   量到的 17 µs 偏小，见 1.4 的说明。要更准得开 `--enable-features=SharedArrayBuffer` 那一套，
   这一步没必要。
5. **`out/pixelmap-gl/`** 里留了跑分用的 1080p 视频和源图（`out/` 已被 gitignore）。
   探针会自己重新生成，可以随时删。
6. **`npm test` 里没有 GPU 用例**：GPU/CPU 对照是探针（要起 vite + 真 GPU），不进 `npm test`。
   合并前建议由审查方再跑一次 `node scripts/probes/pixelmap-gl-probe.mjs` 确认本机也是 ✓。

---

## 6. 数据与对照图

全部在同目录 `r1b-data/`：

- `pixelmap-gl-probe.json` —— 探针的完整原始数据（WebGL 串、8 个用例的最大差/超标数/均差/直方图/最差点坐标、
  每个用例用的定义、24 个提交耗时样本与 GPU 计时样本）
- `probe-run.log` —— 探针那一趟的控制台输出
- `<用例名>-gpu.png` / `-cpu.png` / `-diff32x.png` —— 8 组对照图（差值图放大 32 倍才看得见）
- `src-testsrc2.png` / `src-target.png` / `clip-1080p.mp4` —— 源素材
- `export-src-green-still.png` / `export-frame-000000.png` —— 真实导出那一趟的源图与导出帧
- `export-check2.mjs` —— 真实导出验收脚本的副本（原件跑在 `out/` 里，已删）
