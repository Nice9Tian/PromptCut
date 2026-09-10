# 渲染改建计划:从「全卡片采样」到「beginFrame 出帧」

这份计划的每个判断都带出处。出处分三类:**仓库里的文件/提交**、**实测**(2026-09-10,i7-14700KF 28 线程 / 32 GB,Chrome 152,1920×1080 / 30fps)、**一般经验**(没有原文可引,会标出来)。实测脚本在会话 scratchpad 里,落地时挪进 `scripts/`,见「附:验证脚本」。

## 先说四件和直觉相反的事

1. **慢的不是「截图」这个动作,是「为了截图让 Chrome 出一帧」。** 同一状态下截 1×1 的小图 66.7 ms、截 400×400 66.8 ms、截全屏 85 ms —— 截多大几乎不影响耗时。beginFrame 快,是因为它由我们给帧时间、一拍里跑完 rAF + 画 + 截,绕开了「截图时临时放开虚拟时间」那一整套。
2. **HTML 采样本身不便宜。** 采样那一趟必须逼 Chrome 出一帧,否则 rAF 驱动的动画不前进、缓存 60/60 帧全错;逼出一帧就是 51~68 ms。采样缓存的价值是**随机访问**(任意顺序截任意帧、结果确定),不是省总时间。
3. **现在的导出管线偶尔不确定。** demo 时间轴前 20 秒加粒子和 scene-3d,有一次连导两趟 13/600 帧不同(mu-word-rotate 那一段,最大通道差 250);另一次全长连导两趟 1800/1800 相同 —— 是偶发的。beginFrame 四次两两比对全部相同(600/600 ×2、1800/1800)。
4. **两个后端之间剩下的差异,全部来自系统字体回退,不是出帧方式。** 字体栈里没覆盖到的字形,Chrome(new headless)和 chrome-headless-shell 会选不同的回退字体:等宽数字一边 NSimSun、一边 Courier New;`✓` 一边 Noto Sans SC、一边 Segoe UI Symbol。字宽一不同,整行都会平移。

## 假设

- 交付物仍是 ProRes 4444 带 alpha,由 ffmpeg 合成。浏览器内编码不在考虑范围(见「不做的事」)。
- 确定性分两层看:
  - **源码 → HTML:跨机器一致。** 卡片 / 部件 / 内核代码里没有读环境的地方(无 `toLocale*`、`Intl`、`navigator`、`matchMedia`、`measureText`、`getBoundingClientRect`),同一份源码、同一个帧号写出同一份 HTML。
    出处:验证 —— 同一个 t,Chrome new headless 和 chrome-headless-shell 里 terminal-3d、rank-bars、growth-curve、mu-number-ticker 的舞台 `outerHTML` 逐字节相同。
  - **HTML → 像素:只有渲染环境也钉死时才一致。** 同一份 HTML,换一个 Chrome 构建,rank-bars 8/36、growth-curve 5/31 个元素的包围盒变了,terminal-3d 差 9478 个像素、growth-curve 差 2231 个 —— 全部来自字体回退。要跨机器逐字节一致,得同时钉住 Chrome 构建(安装包本来就自带)、光栅化方式(已经是软件光栅化)和**字体(随包分发,不用系统字体)**,见阶段 0。
  - 帧缓存和回归测试目前按「同一台机器导两遍逐字节相同」要求;跨机器像素一致是阶段 0 做完后的目标,要在第二台机器上验证。
- 桌面安装包可以接受增加约 270 MB(headless-shell),或者用它替换导出链路里的完整 Chrome。
- 卡片的唯一真相是 React / Motion 源码,Agent 改的是源码;采样产物是可以随时扔掉重建的缓存,没人手改。

## 目标架构

```
卡片源码(React / Motion / Magic UI …)
   │  sampling(源码, params, themeId, fps, 舞台尺寸)      ← 帧号 n 是整数,不是秒
   ▼
beginFrame 采样器(chrome-headless-shell,我们给帧时间)
   ├─→ 第 n 帧 PNG ──────────────→ ffmpeg → overlay.mov(ProRes 4444)/ preview.mp4
   └─→ 第 n 帧 DOM 快照(可选) ──→ 随机访问重放:分片并行 / 渐进渲染 / 只改合成层时重截
```

- **源码 = 作者期真相**,**采样产物 = 渲染期真相**。预览、导出、3D 视图读同一份,「同一个 t 预览和成片不是同一帧」那类问题在结构上消失。
  出处:"同一个 t,预览和成片画的不是同一帧:35 张卡里 34 张对不上,而且没有一处报错"——提交 `6b93ffb` 标题。
- **帧号是整数**。
  出处:"摆在 17.3 秒处 `17.55 - 17.3 = 0.2500000000000018`。键是拿这个数哈希的,于是「挪一下全作废」会以另一种形式活下来"——提交 `4edf40e`;实现已在 `src/render/frameGrid.ts`。
- **位置不在自变量表里**。
  出处:"一份摆在 0.5 秒处、一份摆在 12 秒处,比 PNG 的 sha1:**34/34 逐字节相同**"——提交 `4edf40e`。

## 阶段

### 阶段 0:字体地基(1 天)

换后端之前必须先做,否则两边永远对不上,而且对不上的原因看起来像渲染 bug。

1. **消除所有依赖系统回退的字形。** 已知两处:
   - rank-bars、growth-curve 的等宽数字,字体栈 `ui-monospace, SFMono-Regular, monospace` 没有 Consolas(这个串只出现在 `src/skins/skins.ts:125`)。
   - terminal-3d 的 `✓`(U+2713)不在 Consolas 里。
   出处:验证 —— `CSS.getPlatformFontsForNode`:数字在 new headless 是 `NSimSun×2`、在 headless-shell 是 `Courier New×2`;`"✓ 构建完成"` 在 new headless 是 `Noto Sans SC×1, Consolas×1, NSimSun×4`、在 headless-shell 是 `Segoe UI Symbol×1, Consolas×1, NSimSun×4`。
   修法:字体栈显式列出覆盖这些字形的字体(等宽数字走主题的 `--pc-font-mono`,符号加 `"Segoe UI Symbol"`),不让任何一个字形落进系统回退。
2. **字体审计脚本。** 对导出页里每个文本节点调 `CSS.getPlatformFontsForNode`,实际用到的字体不在白名单(Consolas、Microsoft YaHei UI、Segoe UI、Segoe UI Symbol 等)里就报错,两个后端各跑一遍。进 `npm test`,以后新卡也过这道门。
3. **字体随包分发(跨机器一致的前提)。** 前两条只能让「这台机器上两个后端」一致;换一台装了不同字体的机器,回退照样变。主题字体栈现在全是系统字体(`system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`、`ui-monospace, Consolas, monospace`,见 `src/themes/index.ts`)。
   做法:用到的字体放进仓库、以 `@font-face` 加载,主题字体栈第一位写它们;导出前等 `document.fonts.ready`;字体审计白名单收窄到只剩随包字体。
   代价:中文字体体积大,要按实际用到的字形做子集(一般经验:完整 CJK 字体单个字重十几 MB);Microsoft YaHei、PingFang 不能随包分发,得换成 OFL 许可的(如 Noto Sans SC / 思源黑体),**成片观感会变,这是设计决定**。
   完成的标志:在第二台机器上用同一个安装包导 demo 全长,和本机逐字节一致。
4. **重建基线。** 字体一改,旧成片全部作废。修完之后用阶段 1 的比对脚本在 demo 全长上各导一次,存为新基线。

完成的标志:字体审计两后端都零告警;两后端 demo 全长逐字节一致。

### 阶段 1:beginFrame 后端进 `scripts/export-frames.mjs`(1~2 天)

作为**可选后端**加进去(`--backend beginframe`),默认仍是现在的虚拟时间后端,两者并存一段时间。

每帧的步骤逐条照抄 `bakeFrames`,只替换时间推进和截图:

| 现在(`bakeFrames`) | beginFrame 后端 |
|---|---|
| `__pcSetT` | 同 |
| `setVirtualTimePolicy(pauseIfNetworkFetchesPending, budget)` | **等网络(事件驱动)** → 排空 → `HeadlessExperimental.beginFrame()` → 等网络 |
| `settle()`:放 0.001ms 虚拟时间 | 页面内 `setTimeout(0)`,直到 `__pcMutationCount` 不再变 |
| `__pcSyncAnims` → `settle()` → 等图片 decode / `__pcFrameReady` | 同(合并成一次页面内调用) |
| `page.screenshot` + 截图时切 `advance` | `beginFrame({ screenshot: { format:'png', optimizeForSpeed:true } })` |
| 预热 3 帧 → `__pcRestartCards` → 再丢 1 帧 | 同 |

**等网络这一步不能省。** 出处:验证 —— 不等网络时 600 帧里第 119 帧对不上:scene-3d 在那一帧提前挂载(`src/kernel/Stage.tsx:21` 的 `LEAD = 0.05`),动态 `import("three")`(`src/cards/native/scene-3d.tsx:56`)还没回来,三维画面晚一帧出现;补上之后 600/600。

**实测**(两边字体对齐:beginFrame 侧把通用等宽字体设成现在成片里的 NSimSun)

| 场景 | 现在的管线 | beginFrame |
|---|---|---|
| 单卡 mu-number-ticker,60 帧 | 83.9 ms/帧 | 29.6 ms/帧,60/60 逐字节相同 |
| 单卡 rank-bars,60 帧 | 101.3 | 42.6,60/60 相同 |
| 单卡 growth-curve,60 帧 | 109.6 | 64.1,60/60 相同 |
| demo 0~20 秒 + 粒子 + scene-3d,600 帧,第一版(等网络是轮询) | 123.5~125.5 | 96.2~96.9,600/600 相同 |
| 同上,第二版(等网络事件驱动 + 合并往返 + optimizeForSpeed) | 同上 | **42.9**,600/600 相同 |
| 同上,第二版但关掉 optimizeForSpeed | 同上 | 69.7,600/600 相同(这一项单独值约 27 ms/帧) |
| demo 全长 60 秒,1800 帧,第二版 | 107.7 / 104.8(193.8 s / 188.6 s) | **26.9 / 27.8**(48.4 s / 50.0 s),约 **4 倍**;两后端各自两趟都是 1800/1800,彼此 1753/1800,差异见下 |

**全长那 47 帧差异**(两后端各自都自洽,所以是系统性的,不是噪声):

| 卡 | 帧数 | 最大通道差 | 原因 |
|---|---|---|---|
| terminal-3d | 39 | 233 | `✓` 的系统回退字体不同(Noto Sans SC vs Segoe UI Symbol),字宽不同,整行平移。阶段 0 修 |
| punch-pill | 4 | 28 | 胶囊边缘的细小光栅差,裁图肉眼无差别;阶段 0 之后重测再定 |
| versus-card | 2 | 4 | 同上量级 |
| pin-board | 2 | 1 | 同上量级 |

完成的标志:阶段 0 之后 demo 全长两后端逐字节一致;beginFrame 自身两趟一致;`npm run verify` 加一个 `--backend beginframe` 的变体。

风险:`HeadlessExperimental` 是实验性 CDP 域,只在 chrome-headless-shell 里可用。**锁死浏览器版本**,升级 Chrome 时先跑一遍两后端比对和字体审计再放行(一般经验,无原文;实测只覆盖了 152 这一个版本)。

### 阶段 2:接进常驻 worker 和打包(1~2 天)

1. `scripts/render-worker.mjs` 的 bakery 换成 beginFrame 版。它现在一个进程守一个 Chrome、按 `MAX_JOBS` 定期重开、闲置自退 —— 这些规矩原样保留。
   出处:"实测 `--frames 0-0`(起进程 + 起 Chrome + 加载页面 + 推第 0 帧 + 截 1 张)4211ms,其中推帧和截图加起来只占约 100ms"——`scripts/render-worker.mjs` 头注释。beginFrame 省的是每帧的钱,开机那 4 秒要靠常驻 worker 省,两件事叠加。
2. 打包带上 headless-shell。现在是专门排除的:
   出处:"Skip headless shell to save ~200 MB"——`desktop/scripts/prepare-runtime.mjs` 拷贝 Chrome 那一段(约 461 行)。实测 headless-shell 152 占 270 MB,完整 Chrome 429 MB。
   两个选项:**(a) 两个都带**,安装包 +270 MB;**(b) 导出/烘焙链路只用 headless-shell**,完整 Chrome 只留给需要真浏览器的采集/网页工具(`server/web/browser.mjs`)。推荐 (a) 先上,确认稳定后再评估 (b)。
3. 3D 视图的预烘(`src/editor/preview/bakePlan.ts` / `bakeTime.ts` / `useBakePrefetch.ts`)走同一个后端。预烘排的是「时刻」,烘一个时刻变快,绿条(`bakeCoverage.ts`)铺得更快,不用改排队逻辑。

### 阶段 3:全卡片适配审计(2 天)

采样和随机访问成立的前提,逐张卡用脚本验,产出一张适配表,之后并进 `npm test` 和审查门(`server/vite-plugin-cards.ts`)。

| 检查 | 判据 | 已知情况 |
|---|---|---|
| 位置无关 | 同一片内帧号,摆在两个不同位置,逐字节相同 | 34/34 已过(`4edf40e`) |
| t 的纯函数 | 换一条起跑线再采一次,两趟逐格相同 | mu-word-rotate 曾不过,已改成 `floor(elapsed / duration)`(`4edf40e`) |
| DOM 结构稳定 | 30 帧内结构只有 1 种 | 已测 7 张全过:rank-bars、mu-typing、mu-word-rotate、mu-number-ticker、mu-blur-fade、mu-animated-shiny-text、growth-curve |
| 字形回退 | 字体审计零告警(阶段 0 的脚本) | rank-bars、growth-curve、terminal-3d 不过 |
| 随机与墙上时钟 | 读不到真随机、读不到系统时间 | 已由 `src/kernel/pinEntropy.ts` 统一钉住(`Math.random` / `Date` / `crypto`,赶在所有库之前装)。改前:带 `wiggle()` / `random()` 表达式的 Lottie 连导两遍 89/90、90/90 帧不同;改后 0/90、0/90 |
| 网络依赖 | 挂载时有没有动态 import / 素材请求 | scene-3d 有(`import("three")`) |
| 画面载体 | DOM / SVG / canvas / WebGL | canvas/WebGL:particles、scene-3d、lottie(canvas 渲染器时) |
| 两后端一致 | 单卡时间轴上两后端逐字节相同 | demo 全长里除上面字体问题外全部一致 |

**随机数卡必须把种子暴露成参数**(审查门可以查:有 `Math.random` 而 `controls` 里没有 `seed` 就拦)。
出处:`src/cards/native/particles.tsx` 的 `Params` 里已有 `seed: number`。

### 阶段 4:HTML 采样缓存(3 天)

在 beginFrame 导出那一趟**顺手**冻结每帧的 DOM,不单独跑采样趟。

| 实测项 | 结果 |
|---|---|
| 冻结(克隆 + 全部计算样式内联)成本 | 10~36 ms/帧 |
| 冻结状态 vs 真导出那一刻的 DOM | 声明排序后逐字节相同 |
| 缓存体积 | gzip 后 8~15 KB/帧 |
| 乱序重放 vs 倒序重放 | 0/60 帧不同(随机访问是确定的) |
| 重放截图 vs 实时截图 | mu-number-ticker 60/60 相同;rank-bars 35/60 相同、最大差 71;growth-curve 最大差 95 |
| 重放截图耗时 | 66~90 ms/帧(不需要虚拟时间、settle、syncAnims) |

规矩:

- **同一次导出只走一条路。** 重放和实时截图有残差,混用就有接缝。基线比对也改成「重放 vs 重放」。
- **重放页必须移除原树,不能只隐藏。** 出处:验证 —— growth-curve 的 `<linearGradient id={gradId}>` 在原树只是 `display:none` 时,`url(#…)` 解析到隐藏原树里的那个,差 >8 的像素 148029 个/帧;移除原树后降到 205 个。更稳的做法是冻结时给克隆里的 id 统一改名。
- **快照里写 `animation:none; transition:none`。** 7 张卡的实测里不写也没漂(0/30),但代价为零,挡掉 CSS 动画在注入后重新起跑那一整类风险。
- **canvas/WebGL 的快照是空的。** 这类卡的「随机访问」要额外存画布位图,或者不走缓存、按阶段 6 单独出帧。

用途:分片并行(阶段 5)、渐进渲染、只改导出格式或合成层时重截。

### 阶段 5:并行与渐进(2 天)

- **分片。** 实测多进程总吞吐(现在的管线):1/2/4/8/12 个进程 → 307/164/92/76/86 ms/帧(墙钟,含各自约 6 秒启动),**拐点在 8**。每个导出 Chrome 约 744 MB / 9 个进程。worker 数按 `os.cpus()` 和 `os.totalmem()` 一起夹,不写死。beginFrame 后端的多进程曲线还没测。
  出处:"一个烘焙任务本来就只吃约 1.9 个核(每帧 8 趟 CDP 往返,是往返延迟绑定不是算力绑定)"——提交 `2dd2cf6`。
- **分片不用从第 0 帧推。** 有了阶段 4 的缓存,分片可以任意切;没有缓存时按 clip 边界切,每个 worker 只从它那批 clip 的起点推。
  出处:"推一个「画面上什么都没有」的空帧和推一个实帧一样贵(约 16ms)"——提交 `4edf40e`。
- **渐进。** 先截每隔 8 帧的一张给预览,再补全;顺序由 `bakePlan.ts` 现有的「先眼前、再两侧、最后从头」决定。

### 阶段 6(可选):canvas 层单独出帧

粒子、scene-3d 这类本来就在画布上的内容,可以不截图,直接 `VideoFrame(canvas).copyTo` 读回 RGBA(实测约 8.4 ms/帧),再由 ffmpeg 按层序合成。

**硬限制:画布层上面不能压着毛玻璃卡。** 出处:"`backdrop-filter` 会坏掉。`hud.css` 的毛玻璃按定义采样它背后的东西,单独烘焙时背后什么都没有"——`docs/3d-layers.md`「为什么默认不烘焙」。19 张卡用了毛玻璃,所以只有画布层在最上面或和毛玻璃卡不重叠的时段才能拆。

## 不做的事(都实测或核实过)

| 路线 | 为什么不做 |
|---|---|
| 2D 卡全部改写成 Three.js | 35 个卡片文件 3721 行;34 个用 Tailwind 排版、19 个毛玻璃、22 个 Motion;中文字体是系统字体栈,仓库里没有字体文件也没有 SDF 文字库 |
| 浏览器内 WebCodecs 编透明视频(含 VP9 + `webm-muxer`) | Chrome 152 / Edge 152 共 30 种 alpha 组合全不支持,`configure` 报 `Alpha encoding is not currently supported.`;`webm-muxer` 已弃用("superseded by Mediabunny");ffmpeg 默认 vp9 解码器还会丢 alpha(必须 `-c:v libvpx-vp9`) |
| MediaRecorder / captureStream | 受实时时钟限制,掉帧补不回来(一般经验) |
| 逐帧 DOM 差分 + 曲线拟合成 DSL | 拟合只对「给 Agent 改采样结果」有意义;Agent 改源码后不需要。`line()` 在约 350 条序列里 0 次胜出 |
| 脏矩形局部截图 | 截多大都约 67 ms,最多省 18 ms,还要算毛玻璃的失效区 |
| CDP pipe 代替 WebSocket | 83.4 vs 85 ms |
| 读 `offsetHeight` 代替截图逼出帧 | 30 帧里 29 帧文字错:强制布局不触发 rAF |
| foreignObject 转画布 | 能用(约 40 ms/帧,毛玻璃生效),但和实时截图有残差;beginFrame 更快且逐字节一致 |

## 优点

- **不改卡片。** beginFrame 后端对 35 张卡零改动,和现有管线逐字节一致(字体问题除外)。
  出处:验证 —— demo 全长 1800 帧,两后端 1753/1800 相同,其余 47 帧全部归因于字体回退和边缘级光栅差。
- **快 4 倍,而且更确定。**
  出处:验证 —— 全长 107.7 → 26.9 ms/帧;beginFrame 四次两两比对全部相同,现有管线有一次 587/600。
- **每一步都可以单独停。** 阶段 0 本身就修了成片的字体错误;阶段 1 做完就有 4 倍;阶段 4、5、6 各自独立。

## 缺点

- **依赖实验性 CDP 域和一个单独的浏览器二进制。** 版本升级有回归风险,安装包 +270 MB。
- **两个后端并存期间要维护两份每帧步骤。** 语义必须逐条对齐,漏一步就是「不报错的错帧」(第 119 帧就是这么来的)。
- **换后端会改变字体回退。** 不先做阶段 0,切换那一刻成片里的数字、符号就会悄悄换字体。
- **采样缓存的重放和实时截图有残差。** 用了缓存,确定性就要改成「重放 vs 重放」来比,不能再和实时截图比。

## 限制

- **canvas / WebGL 进不了 DOM 采样。** 快照里画布是空的。
  出处:验证 —— 重内容时间轴 DOM diff 里画布贡献 0 字节;克隆出来的 canvas 为空。
- **跨机器一致只在 HTML 层成立,像素层要等阶段 0 第 3 条。** 同一份源码写出的 HTML 和机器无关;但同一份 HTML 排出的布局和像素取决于字体,而字体回退随 Chrome 构建和系统装了哪些字体而变。像素层的所有确定性结论目前只在这一台、这一个 Chrome 版本上测过。
  这也意味着阶段 4 的 DOM 快照是**可以跨机器共享的产物**(比如在一台机器上采样、另一台上出帧),前提是出帧那台的渲染环境和采样时一致。
- **单个任务是往返延迟绑定,只吃约 1.9 核。** 再快只能靠多开,多开受内存限制(约 744 MB/worker)。

## 附:验证脚本

会话里用到的几份(在 scratchpad,落地时挪进 `scripts/`):

- `bfexport2.mjs` —— beginFrame 版导出,每帧步骤与 `bakeFrames` 一一对应;`BF_NO_FAST=1` 关掉 optimizeForSpeed。
- `compare.mjs` —— 两个导出目录逐帧比,按 2 秒一段汇总、给出差异包围盒和当时在场的卡。注意分段标签按段中点取卡,片段跨段时会贴错(56~58 秒那段就把 terminal-3d 的差异标成了 focus-card),定位以逐帧清单为准。
- `fontcheck2.mjs` —— 在两种 headless、不同字体钉法下查指定文本的实际字体(`CSS.getPlatformFontsForNode`),阶段 0 的审计脚本从它长出来。
- `verify-tl.json` —— demo 时间轴 + 0~20 秒粒子 + 4~12 秒 scene-3d。

## 第一步

阶段 0 的第 1、2 条:把 rank-bars / growth-curve 的数字改走主题等宽字体,terminal-3d 的字体栈加上 `"Segoe UI Symbol"`,然后把 `fontcheck2.mjs` 改成扫全部文本节点的审计脚本,两个后端各跑一遍确认零告警。半天以内。
