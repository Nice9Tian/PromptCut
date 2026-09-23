# 渲染提速计划:省掉准备时间,再试「Chrome 只推开头、后面纯算法」

这份计划整理自 2026-09-11 的一轮讨论。每条判断都带出处,出处分两类:

- **代码**:给出 `文件:行号`;
- **实测**:注明是哪次测的。

写着「估计」的地方没有测过。

---

## 实施结果(2026-09-11)

实验都跑在独立的 dev server 上:端口 5241,`TEMP` 指向 scratch,端口文件写进 scratch。全程没碰 5210 上的真实软件,全局 `%TEMP%\promptcut\port.json` 前后比对未变。

| 项 | 结论 | 实测 |
|---|---|---|
| **E0** 起一趟拆分 | 第 0 节里「每趟 4~5 s」是旧数据:常驻 worker 里 Chrome 已经起好,一趟的准备只剩换页 | worker 冷启动(起 Chrome + 首页就绪)5.6 s,只付一次;之后每趟换页(新 page + 导航 + 加载模块 + 就绪)约 310 ms;把项目灌进已就绪的空页只要 3~4 ms |
| **A2** 预热页面池 | **已做**。`server/bakery/chrome.mjs` 的 bakery 新增 `preload` / `resetWith`;`render-worker.mjs` 每做完一趟就备好下一张空页,来活只灌项目 | 每趟省约 310 ms。备用页和现开的页渲出的同一帧逐字节相同:3 张卡 × 3 次,9/9;经 `/api/vision/snapshot` 端到端同样相同 |
| **A1** see_frames 多时刻合成一趟 | **已做**。`/api/vision/snapshot` 接受 `times`,走 `renderFrames` 一趟推到最晚那个时刻;前端 `seePreview` 一次请求 | 8 个时刻 23.2 s → 11.7 s,快 2.0 倍;和逐张渲逐字节相同,8/8。推帧才是大头,省的主要是重复推帧 |
| **A3** 不同卡串成一趟 | **不做** | 4 张卡:各起一趟 3.08 s,串成一趟 2.29~2.55 s,只快 17~25%(同帧字节 4/4 相同)。但各起一趟会分到渲染池的多个 worker 上并行,串成一趟只能用一个;串得越长推帧越多;一张卡出错整趟失败。旧管线也试过、也没快(`vite-plugin-vision.ts:1358-1361`) |
| **E1** 提问地图 | **「Chrome 只推开头」对 88/89 张卡成立** | 89 张卡:31 张从不问;54 张粒子卡只在片内 -1..1 帧问(粒子库初始化);step-timeline、type-shift、scene-3d 只在挂载那一帧问;**只有 chapter-bar 每帧都问**(Motion 布局动画 `getBoundingClientRect`,204 次,一直问到最后一帧)。导出内核自己也会问(ExportView 静态探针读计算样式),纯算法里由替代代码接管,不算 |
| **E2a** 只看 DOM 能否还原真实画面 | **不能逐字节还原,差在动画中间值,不差结构和时间** | 正常导出(Motion 走 WAAPI)vs 关掉 WAAPI(Motion 走 JS、数值写进内联样式),片内 90 帧:mu-number-ticker 90/90 相同;rank-bars 65/90(最大通道差 17);mu-blur-fade 85/90(31);checklist 48/90(42);stat-proof 61/90(2)。错开 ±1、±2 帧反而对得更少,排除时间偏移。目视四张最差帧:位置、结构完全一致,差的是透明度和模糊的中间值。推测是 WAAPI 由 Chrome 求缓动、弹簧近似成 `linear()`,和 Motion 在 JS 里自己算有细微差别 |
| JS 动画模式的确定性 | **确定** | 关 WAAPI 连跑两遍:rank-bars、checklist 各 90/90 帧逐字节相同 |
| **E2b** 纯算法雏形 | **不问浏览器的卡能对上,但更慢;第三方库按环境分叉的卡,回放了答案也对不上** | 做法:happy-dom + Vite SSR,在 Node 里跑同一份源码,照 `server/bakery/bake.mjs` 的每帧步骤推进。和 Chrome(关 WAAPI)逐帧比 DOM,比之前经 CSSOM 规整样式、属性排序、数值按 1e-4 容差。**不问浏览器的 6 张卡**:mu-number-ticker、mu-blur-fade 逐字节 90/90;stat-proof、type-shift 容差内 90/90;rank-bars 88/90、checklist 89/90,剩下的是科学计数法写法的 1e-9 量级差。**会问的 step-timeline 49/90**:不回放时,CSS 变量解析不了;按 Chrome 录下的计算样式回放(命中 25、缺失 0),仍是 49/90。Motion 在 happy-dom 里对 `transparent` 报「不可动画」,走了和 Chrome 不同的分支,整段颜色动画没跑。**速度**:启动 4.2~4.7 s(Vite SSR 变换整张模块图);每帧 65~83 ms,**比 beginFrame 直出(26.9 ms/帧)慢 2.5~3 倍** |

### 结论

- **方向 A**:A1、A2 已实现并验证,改动还没提交(见交接清单)。A3 实测收益太小,不做。
- **方向 B 暂不进下一版主线。** 按第 3 节 E2 的判定标准(「DOM 逐帧一致,且整体比 beginFrame 快」),两条都没过:
  1. **慢。** 纯算法每帧 65~83 ms,而 beginFrame 直出是 26.9 ms/帧。
  2. **对不齐。** 不问浏览器的卡能对齐。但只要库按运行环境走不同分支(step-timeline 里的 Motion),回放「问浏览器」的答案也补不回来,拦截清单兜不住这一类。
  3. **就算对齐了,也和现在的导出不一样。** 纯算法得到的是「JS 动画」版本的画面,和现在导出用的 WAAPI 版本有细微差别(E2a,最大通道差 2~42)。
- **前提已被证实。** E1 显示,88/89 张卡在片内第 1 帧之后就不再问浏览器。所以「Chrome 只推开头」这个思路本身成立。卡住的是纯 DOM 环境的保真度和速度,不是思路。
- **如果以后重开方向 B,要先解决三件事:**
  1. 把导出切成 JS 动画模式。已测它本身是确定的:2 张卡 × 2 遍,90/90 逐字节相同。这样导出、预览、纯算法三方共用同一条动画路径。
  2. 换一个更接近浏览器语义的无渲染运行环境,比如 Lightpanda,不用 happy-dom;或者把「环境分叉」的检测纳入每张卡的审计。
  3. 去掉每张卡 4 秒多的 SSR 变换启动,排空环节也不要再靠 `setTimeout(0)` 轮询。
- 这一轮踩过的比对陷阱都记在 [`compare-pitfalls.md`](guides/compare-pitfalls.md)。

---

## 0. 现状:慢在哪里

**慢在每开一趟渲染的准备时间,不在出帧本身。**

| 环节 | 耗时 | 出处 |
|---|---|---|
| 单独起一趟渲染(开页面 + 加载导出页 + 挂载 + 预热) | 4.0~5.0 s | `server/vite-plugin-vision.ts:1014` |
| 往后推一帧 | 18~23 ms | 同上 |
| 截一张图 | 约 78 ms(旧管线);beginFrame 直出整体 26.9 ms/帧 | 同上;`docs/render-rebuild-plan.md` 状态表 |

**已经做到的:**

- 同一张卡的多个时刻合成一趟渲染(`renderFrames`)。实测 7 个时刻从 31.0 s 降到 2.7 s,输出逐字节相同(`vite-plugin-vision.ts:1013`)。
- 编辑器预览的预渲染、`get_gif` 都走这条路。

**还在反复付准备时间的地方:**

1. **see_frames 带多个时刻时,一张一张单独起任务**(`src/editor/right/index.tsx:1911-1918`)。每张都从第 0 帧重推,10 个时刻就是 10 次准备时间。
2. **每个任务都新开一个页面、重新加载整个导出页**(`server/bakery/chrome.mjs` 的 `newSession`)。必须开新页面的理由写在 `scripts/render-worker.mjs:75-86`:上一趟跑完,动画起点都已建好,原地再用拿不到第 0 帧的画面。
3. **不同的卡各起一趟。**

**为什么卡片不能直接跳到任意时刻渲染:**

- 卡片是「挂载即播」。`CardProps.t` 是可选参数,绝大多数卡不读它(`src/kernel/types.ts:34-38`)。
- 31 个卡片文件里有 23 个用 Motion,动画从挂载那一刻起算。
- 导出时,`__pcSyncAnims` 把每个动画第一次出现的那一帧记为起点,每帧设「当前时刻 − 起点」(`src/ExportView.tsx`)。
- 所以要看第 t 秒,只能从片段起点推过去。

**「一张大画布同时摆出多个时刻」在现在的页面里行不通:**

- 一个页面只有一个时钟:`exportClock` 把整个窗口的 `performance.now` 钉到同一个值,网页动画的时间线也是整页共用一条。
- 要给每个副本不同的时间,就得各开一个独立子页面,准备时间照付。
- 这个想法在 HTML 快照层(第 2 节)和纯函数化的 React 组件上是成立的。

**「HTML 采样缓存」只做了一半,也没接进正式渲染:**

- 做了:`--dom-cache` 每帧冻结整棵 DOM,gzip 后每帧 8~15 KB;乱序重放 300/300 相同。
- 没做:「变化量 + 数值表」,以及拟合回 React 组件。
- 只有 `server/bakery/bake.mjs` 和 `scripts/replay-frames.mjs` 用到这套缓存;see_frames、预渲染、导出都没接。
- 重放截图和实时截图有边缘差异:rank-bars 60 帧里 35 帧相同、最大通道差 71;growth-curve 最大差 95。
- 重放截图每帧 66~90 ms。
- 出处:`docs/render-rebuild-plan.md:143-154`。

---

## 1. 方向 A:先省准备时间(不改卡片,风险低)

### A1. see_frames 的多个时刻合成一趟

- **做法**:`times` 不再逐个请求 `/api/vision/snapshot`,改成一次请求。服务端走 `renderFrames`,一趟推过去,沿途截图。
- **改动**:`src/editor/right/index.tsx` 的 `seePreview`;`server/vite-plugin-vision.ts` 新增或扩展一个多时刻快照接口。
- **验收**:10 个时刻总耗时 ≈ 一趟准备 + 推到最后一个时刻 + 10 次截图;每张图和逐张渲染逐字节相同。
- **估计**:半天。

### A2. 预热页面池

- **做法**:render worker 空闲时先开好下一个新页面,导航到导出页并等到就绪。任务来了,用现成的「在新页面上原地换项目」接口灌进项目(`server/bakery/chrome.mjs` 的 `loadProject`),不再现开现加载。
- **不破坏确定性的理由**:每个任务用的仍然是一个全新、没跑过的页面,只是提前开好了。
- **验收**:
  - 单任务从派活到第一帧的耗时下降,先测出下降多少;
  - `verify-determinism` 预热池和现开页面两组输出逐字节相同。
- **前置**:先测「起一趟」的耗时拆分(导航 / 加载模块 / 挂载 / 预热各多少),这决定 A2 能省多少。
- **估计**:1~2 天。

### A3. 不同的卡在时间轴上串成一趟

- **做法**:要渲的几张卡按时间前后排开,每张之间留出预热间隔,一趟推完、沿途截图。
- **依据**:推一帧约 20 ms,远小于多开一次页面的 4~5 s。
- **前提**:卡片画面和它在时间轴上的位置无关。89 张里 86 张满足;`mu-word-rotate`、`versus-card`、`lottie-bodymovin` 这 3 张要先修或排除(`scripts/card-audit.mjs` 首跑结果)。
- **估计**:1 天。

---

## 2. 方向 B:Chrome 只推开头,后面纯算法

### 思路

卡片代码真正要浏览器帮忙的,只有它向浏览器「问」的那几个数:尺寸、计算样式、在不在视口里、容器多大。

- **不做判断,遇到了再补。** 不去预测「以后还问不问」,而是在纯算法遇到新问题时再让 Chrome 追上来。「这一帧没在问」不代表「以后都不会问」,比如延迟 2 秒才开始的动画,会在第 60 帧才去量尺寸。
- **Chrome 页面不关,停在原位。**

```
Chrome(真浏览器)                          纯算法(无排版、无绘制的 DOM 环境)
  从第 0 帧推,记下每一次「问浏览器」       ←─ 共用同一份卡片代码、同一个假时钟、同一个随机种子
  的问题和答案,直到第一次安静下来
  停在原地,页面不关                       ──→ 接着往后推;遇到提问就查录下的答案
                                              查不到(出现新问题)
  从原位置接着推到这一帧,问一遍、记下  ←──  暂停,等答案
                                        ──→ 拿到答案继续
```

- 两边是同一份确定的代码,Chrome 追到第 m 帧时的状态和纯算法在第 m 帧时相同,拿到的答案是精确的。
- Chrome 只推到「最后一次提问」那一帧,之后不再推。
- 纯算法每帧导出 DOM,得到 HTML 序列。

### 产出

1. **HTML 序列**:和阶段 4 的冻结快照格式相同,可以直接交给 `replay-frames.mjs` 出像素。
2. **拟合回 React**:结构稳定的卡,存成「一棵树 + 逐帧数值表」,生成一个画面完全由 `t` 决定的组件。这一步没有现成的库,要自己写代码生成。
   - 编辑器预览可以直接在用户浏览器里画任意时刻,不用经过 Chrome;
   - Agent 查看任意时刻立即拿到;
   - 大画布一次摆多个时刻并排截图,在这里才真正成立。

### 拦截清单

**这是整个方案的安全线。** 纯 DOM 环境里没拦住的接口不会报错,只会悄悄返回错的值(jsdom 的尺寸全是 0)。清单里的接口,查不到答案就报「缺失」,绝不给默认值。

- **尺寸**:`getBoundingClientRect`、`getClientRects`、`offset*`、`client*`、`scroll*`
- **样式与媒体查询**:`getComputedStyle`、`matchMedia`
- **SVG**:`getBBox`、`getComputedTextLength`、`getTotalLength`、`getPointAtLength`
- **观察器**:`IntersectionObserver`、`ResizeObserver`
- **字体**:`document.fonts`,以及画布 2D 上下文的 `measureText`
- **命中测试**:`elementFromPoint`

注意:卡片源码里搜不到 `getComputedStyle`,但 Motion 库内部会读。动画起点值没写死、或者前后单位不同(px 和 % 互换)时,Motion 会在动画开始那一刻去量 DOM。

### 适用范围(按能力统计 `src/cards` + `src/parts` 共 80 个文件)

| 类别 | 文件数 | 纯算法下怎么办 |
|---|---|---|
| Motion 动画 | 23 / 31 个卡片文件 | 没有 WAAPI 时,Motion 走 rAF 驱动的 JS 帧循环,直接写内联样式,可以逐帧读出 |
| `useInView` / IntersectionObserver / ResizeObserver | 4 | 走拦截清单,用录下的答案 |
| CSS `@keyframes` / `animation:` | 3 | 需要自己写一个关键帧插值器,或者这几张卡留在 Chrome |
| 读尺寸 | 1 | 走拦截清单 |
| 布局动画(`layout` / `layoutId`) | 3 | 每次变化都要量,Chrome 追赶会很频繁,可能不划算 |
| 画布、three、Lottie、tsparticles | 4 / 2 / 6 / 1(tsparticles 这一个文件撑着 62 张粒子卡) | **不适用**,画面不在 DOM 里,继续由 Chrome 渲染(同计划阶段 6) |

### 候选的纯 DOM 环境

| 候选 | 说明 |
|---|---|
| jsdom | 最成熟。无排版,尺寸全是 0([#1504](https://github.com/jsdom/jsdom/issues/1504));`Element.animate`([#3429](https://github.com/jsdom/jsdom/issues/3429))和 `getAnimations`([#3852](https://github.com/jsdom/jsdom/issues/3852))都没实现 |
| happy-dom / linkedom | 更快;WAAPI 支持情况没查到,要实测 |
| [Lightpanda](https://lightpanda.io/) | Zig 写的无渲染浏览器,V8 跑 JS,提供 CDP,Puppeteer 能直接连;自称冷启动不到 100 ms、比 Chrome 快 9 倍、省 16 倍内存。**Windows 要走 WSL2**。Web API 覆盖程度要实测 |

lynx / w3m 这类文本浏览器不跑 JS,用不上。

---

## 3. 实验(先测再决定,不改仓库)

### 约束

- 真实软件在 5210 上跑(`AppData\Local\PromptCut`),不碰它的端口和 MCP。
- 任何 dev server 启动时都会把自己的端口写进全局的 `%TEMP%\promptcut\port.json`(`server/vite-plugin-ai.ts:152-159`),没指定端口的 MCP 客户端会照这个文件去连(`server/mcp-server.mjs:15-21`)。
  - 实验用的服务器启动时把 `TEMP` 指到 scratch 目录,端口文件写进 scratch;
  - 或者用 Vite 的 middlewareMode,不监听端口,也就不写这个文件。
- 依赖(happy-dom、jsdom)只装在 scratch 目录,不改 `package.json`。

### E0:「起一趟」的耗时拆分(方向 A 的前置)

- **做法**:在 `openBakery` / `reset` / `waitReady` / `warmUp` 各阶段打点,测 10 次取中位数。
- **产出**:导航、加载模块、React 挂载、预热各花多少。
- **判定**:导航加模块加载占大头,A2 就值得做。

### E1:提问地图(方向 B 能不能成立)

- **做法**:在 Chrome 导出页里给拦截清单上的接口套一层记录,逐卡跑一遍,记下每次提问的帧号、问题和答案。
- **产出**:每张卡一行:提问次数、最后一次提问的帧号、问题类型。
- **判定**:
  - 大多数卡的最后一次提问在前十几帧,方向 B 的收益成立;
  - 如果提问分散在整段片段里,方向 B 不划算。
- **估计**:1 天。

### E2:雏形,取 2~3 张卡

- **选卡**:rank-bars(Motion 的 JS 动画)、mu-typing(状态加 effect),再加一张 E1 里提问最少的卡。
- **做法**:用 Vite 的无端口模式把卡片代码加载进 Node,在 happy-dom 和 jsdom 里分别挂上假时钟、固定随机种子和录下的答案,实现「Chrome 停在原位,遇到新问题就追上」,逐帧导出 DOM。
- **对照**:同一张卡用 `export-frames --dom-cache` 冻结的 Chrome 快照,逐帧比对 DOM。
- **产出**:一致率、每帧耗时、启动耗时、Chrome 实际推了多少帧。
- **判定**:DOM 逐帧一致,且整体比现在的 beginFrame 一趟快,才继续做「拟合回 React」。
- **估计**:2 天。

---

## 4. 风险

| 风险 | 后果 | 应对 |
|---|---|---|
| 拦截清单漏了接口 | 纯算法悄悄算错,不报错 | 清单只增不减;查不到答案一律报「缺失」;E2 逐帧对照 Chrome;上线后抽帧比对 |
| 纯 DOM 环境和 Chrome 行为不同(事件顺序、样式解析、Motion 特性检测) | HTML 序列和真渲染对不上 | 以 Chrome 冻结快照为准,逐卡验收;不过的卡留在 Chrome |
| 布局动画、结构会变的卡(`chapter-bar`、`terminal-3d`) | Chrome 追赶频繁,或者拟合不出「一棵树 + 数值表」 | 这些卡继续走 beginFrame |
| 出成片像素仍要浏览器画 | 导出整体未必更快(重放 66~90 ms/帧,直出 26.9 ms/帧) | 方向 B 的主要收益定位在预览、Agent 看画面和任意时刻取帧;导出另算 |
| Lightpanda 在 Windows 上要 WSL2 | 桌面版用户环境不一定有 | 首选能在 Node 里直接跑的 happy-dom / jsdom |

---

## 5. 需要决定

1. 是否先做方向 A:A1 最小、见效最快。
2. 是否开 E0、E1 两个测量。方向 B 做不做,要等 E1 的结果。
3. E2 通过后,「拟合回 React」要不要进下一版的主线。

## 附:同一轮讨论里查到的相关问题

以下几条不在本计划范围内,另行处理:

- **完整导出(`/api/export`)仍然把视频塞进 Chrome 逐帧跳帧截图。**
  - 视频和图片都挂在导出舞台里(`src/ExportView.tsx:336-363`),每帧设 `currentTime` 并等待跳帧完成(`:161-167`)。
  - 画面里有视频的帧,静态跳过不生效(`server/bakery/bake.mjs` 的 `isStatic`)。
  - `/api/export` 没传 `--workers`,命令行默认是 auto,最多 4 个分片(`scripts/export-frames.mjs` 的命令行默认值),每个分片都从第 0 帧推起。
  - 修法和 see_frames 一样:Chrome 只渲卡片,素材交给 ffmpeg 合成(`server/vision-compose.mjs`)。
- **Agent 渲染时,编辑器界面可能卡住但 CPU 很低。**
  - 编辑器和所有接口在同一个 HTTP/1.1 源下,Chrome 对同一个源只给约 6 条连接(`src/editor/preview/useBakePrefetch.ts:362-365`)。
  - 实测挂满 6 条长连接后,一个本来 2 ms 的轻请求等了 7.7 s。
  - 页面发出的渲染请求没有超时,也不能中途取消(`src/editor/right/index.tsx:1748/1893/1924`)。
- **Vite 进程里同步编解码 PNG。** 实测一张复杂的 1080p 帧,解码 54 ms、编码 94 ms;see_frames 每帧约 0.3 s 堵住整个服务(`server/vite-plugin-vision.ts:996-999, 1312-1313`)。
