# 默认动画效果卡片：代码类型、依赖与动画求值方式

核对日期：2026-09-13。依据本次提交的预览修复源码；安装包状态以对应版本的构建记录为准。

当前工作区默认注册 **89 张卡片**：MagicUI 6 张、自家功能卡 24 张、Lottie 素材卡 5 张、粒子素材卡 53 张、调试探针 1 张。主分类统一为 **直接求值动画（`direct`） / 状态推进动画（`stateful`）**。按当前调度器和默认参数，字幕 `caption-track` 属于直接求值，其余 88 张按状态推进处理。全部 89 张都有 React 接入外壳，这只说明接入方式，不决定是否需要推帧。

本文逐张列出已注册卡片。代码类型、依赖与帧模式分别记录，供后续设计“Agent 直接编辑源码 / 自定义卡片”接口使用；下文标注为建议的字段尚未实现。

## 1. 统计口径

| 注册来源 | 数量 | 默认展示与边界 |
|---|---:|---|
| MagicUI 主注册数组 | 5 | 第三方组件分组；本地适配后的 TSX 源码 |
| 随仓库提供的 MagicUI 闪光文字 | 1 | 文件在 `user` 目录，实际声明 `source: "magicui"`，也显示在 MagicUI 分组 |
| Native 主注册数组及三个 batch 数组 | 24 | 自家分组，包含组合卡、通用 Lottie / 粒子 / Three.js 卡 |
| Lottie 素材目录生成卡 | 5 | 每份 JSON 生成一张卡，复用同一个播放器 |
| tsParticles 素材目录生成卡 | 53 | 53 份配置均存在；默认展开精选 26 张，另 27 张通过搜索或“全部展开”显示 |
| 探针卡 | 1 | 当前无条件注册，`source: "native"`，会进入自家分组；不是仅开发环境注册 |
| **合计** | **89** | 默认可见性开关开启；首次面板不搜索、不展开粒子时展示其中 62 张，不含部件库 |

严格按主库数组统计是 87 张；本表把仓库中实际参与注册的闪光文字和探针也计入，避免漏项。用户安装目录里的新增卡、源码覆盖层及项目内嵌卡片可能改变实际清单。

另有 **78 份 MagicUI 上游组件源码**存放在素材目录中。这是可供导入的源码目录，其中有些已经适配为上述卡片，不能再额外算作 78 张可直接使用的卡片。组合卡的 `PartDef` 部件也不单独计作 `CardDef` 卡片。用户项目里的纸面纹理 `wa-texture` 不在本次仓库默认卡片清单中。

核对入口：[总注册表][registry]、[Native 注册表][native-index]、[MagicUI 注册表][magic-index]、[用户目录自动注册][user-index]、[素材卡生成器][asset-index]、[面板筛选][cards-tab]。

## 2. 动画求值方式与 React 接入外壳

| 判断维度 | 含义 | 例子 |
|---|---|---|
| React 接入外壳 | 是否由 React 组件挂载到舞台 | 本文全部卡片都是；Lottie JSON 和粒子 JSON 本身不是 React 代码，但它们的播放器外壳是 |
| 直接求值动画：`frameMode: "direct"` | 完整画面可由参数、局部时间 `t` 和舞台上下文直接计算，包括进出场状态，不依赖前面访问过哪些帧 | 当前的常驻双语字幕 |
| 状态推进动画：`frameMode: "stateful"` | 当前调度按需要历史的方式处理；可能有 Motion、CSS、rAF 或粒子模拟，也可能只是尚未声明直接时间模式 | MagicUI、Motion 卡；当前未声明模式的 Lottie 和 Three.js 卡 |

[当前判定代码][frame-mode]先读显式 `frameMode`；未声明时，仅将 `after: "hold"` 且 `settleMs: 0` 的静态卡兼容判为 `direct`，其余保守判为 `stateful`。含非空 `clip.parts` 的组合片段仍判为 `stateful`。下表是默认参数、未额外添加部件时的结果；命中 HTML 或画面缓存后可以跳过实际推进，模式本身不表示每次请求都会重新推帧。

兼容旧项目：原 `frameMode: "react"` 读取为 `"direct"`，原 `"non-react"` 读取为 `"stateful"`；新卡及返回的模式统一使用新名称。旧 `.proc` 中嵌入的源码无需重写。

粒子的随机种子控制初始状态，tsParticles 仍需逐步更新位置等状态；React 负责挂载 Canvas 和管理引擎生命周期。`motion/react` 也确实是 React 接口，但现有卡片的动画依赖内部时钟和状态。因此这两类可以同时是“React 接入外壳＝是”和“状态推进动画”。

**直接访问 `t` 的实现能力和调度声明需要同时满足。** `LottieView` 已使用 `goToAndStop`，`scene-3d` 已直接按 `t` 计算姿态，但它们及 Lottie 素材卡目前没有声明 `frameMode: "direct"`，所以不能写成“当前已启用免推帧”。粒子虽然也接收 `t`，内部仍逐步模拟到目标时刻。

## 3. 依赖说明

所有卡片共享 `react` 和舞台宿主 `react-dom`。逐卡表中的“额外依赖”只列除此之外实际用到的动画库；“无”表示没有额外动画 npm 包，仍使用 React、浏览器 DOM / CSS / SVG API 及项目内部模块。“粒子双库”指 `@tsparticles/engine` + `@tsparticles/slim`。

| 库 / 工具 | 项目声明版本 | 用途 |
|---|---|---|
| `react` | `^19.2.7` | 组件、Hooks、JSX runtime |
| `react-dom` | `^19.2.7` | 舞台统一挂载；通常不由单张卡直接导入 |
| `motion` | `^12.23.0` | 通过 `motion/react` 使用动画组件、MotionValue、弹簧、AnimatePresence |
| `lottie-web` | `^5.13.0` | Lottie JSON 播放，当前采用 SVG renderer |
| `@tsparticles/engine` | `^4.4.0` | Canvas 粒子引擎 |
| `@tsparticles/slim` | `^4.4.0` | 当前加载的粒子功能集合 |
| `three` | `^0.185.1` | WebGL 三维物件；运行时动态导入 |
| `tailwindcss` / `@tailwindcss/vite` | 均为 `^4.1.0` | 构建期生成工具类样式，不是逐帧运行的动画引擎 |
| `typescript` | `~5.9.0` | TS / TSX 类型检查与编译工具链 |
| `vite` / `@vitejs/plugin-react` | `^8.1.1` / `^6.0.3` | 模块加载、打包和热更新 |

以上是 [package.json][package] 中的版本范围，不是锁文件中的精确版本。MagicUI 在这里是本地源码来源，**没有安装名为 `magicui` 的运行时包**。其 `cn` 已替换为本地函数，不额外依赖 `clsx`、`tailwind-merge`；实际使用的是 `motion/react`，不是另装的 `framer-motion`。自家卡普遍复用 [HUD 工具][hud]、[HUD 样式][hud-css]；MagicUI 还共用 [动画样式][magic-css]。

## 4. MagicUI 卡片（6 张）

| 卡片 ID / 入口源码 | 显示名称 | 代码类型 | 额外依赖 | React 接入外壳 | 动画求值分类（当前调度） | 实现说明 |
| --- | --- | --- | --- | --- | --- | --- |
| [mu-number-ticker][magic-number-ticker] | 数字滚动 | MagicUI TSX + Motion 弹簧 | `motion/react` | 是 | 状态推进 | useSpring 和 rAF 驱动数字；[vendor][vendor-number-ticker] |
| [mu-blur-fade][magic-blur-fade] | 模糊浮现 | MagicUI TSX + Motion | `motion/react` | 是 | 状态推进 | Motion 模糊 / 位移进场；[vendor][vendor-blur-fade] |
| [mu-circular-progress][magic-animated-circular-progress-bar] | 环形进度 | MagicUI TSX + rAF / SVG | 无 | 是 | 状态推进 | 包装层 rAF 插值，vendor 绘制 SVG；[vendor][vendor-animated-circular-progress-bar] |
| [mu-typing][magic-typing-animation] | 打字机 | MagicUI TSX + rAF / DOM | 无 | 是 | 状态推进 | rAF 更新已显示字符；[vendor][vendor-typing-animation] |
| [mu-word-rotate][magic-word-rotate] | 文字轮换 | MagicUI TSX + Motion + rAF | `motion/react` | 是 | 状态推进 | rAF 换词，AnimatePresence 负责过渡；[vendor][vendor-word-rotate] |
| [mu-animated-shiny-text][shiny] | 闪光文字 | MagicUI TSX + CSS keyframes | 无 | 是 | 状态推进 | CSS 高光循环；位于 user 目录，声明 source: magicui |

“环形进度”的 vendor 组件仅画 SVG，时间推进逻辑在卡片包装文件里。因此直接编辑时应同时看入口和组件源码，不能只按 vendor 文件的静态外观判断帧模式。

## 5. 自家功能卡（24 张）

| 卡片 ID / 源码 | 显示名称 | 代码类型 | 额外依赖 | React 接入外壳 | 动画求值分类（当前调度） | 判断依据 |
| --- | --- | --- | --- | --- | --- | --- |
| [composite][native-composite] | 组合卡 | React TSX / 部件树 | 由选用部件决定 | 是 | 状态推进 | 独立入口是占位；实际按部件树渲染 |
| [lottie][native-lottie] | Lottie 动画 | React TSX + Lottie JSON / SVG | `lottie-web` | 是 | 状态推进 | 播放器可直接定位；当前未声明直接模式 |
| [particles][native-particles] | 粒子背景 | React TSX + tsParticles 配置 / Canvas | 粒子双库 | 是 | 状态推进 | 逐步累积模拟；倒退需重置并重推 |
| [scene-3d][native-scene-3d] | 三维物件 | React TSX + Three.js / WebGL | `three` | 是 | 状态推进 | 姿态按 t 计算；当前未声明直接模式 |
| [odometer][native-odometer] | 翻牌计数器 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 数字滚轮通过 Motion 位移 |
| [blur-text][native-blur-text] | 模糊浮现 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 逐段模糊、位移与淡入 |
| [ring-metric][native-ring-metric] | 环形指标 | React TSX + Motion / SVG | `motion/react` | 是 | 状态推进 | 环形路径和 MotionValue 数字 |
| [checklist][native-checklist] | 清单打勾 | React TSX + Motion / DOM、SVG | `motion/react` | 是 | 状态推进 | 条目依次进入及勾线动画 |
| [step-timeline][native-step-timeline] | 步骤时间线 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | Motion 按 stepMs 延迟依次进入，节点有循环脉冲 |
| [quote-lockup][native-quote-lockup] | 金句定格 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 引语与装饰的进场动画 |
| [punch-pill][native-punch-pill] | 金句药丸 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 药丸底板及文字进入 |
| [term-card][native-term-card] | 术语解释卡 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 术语和解释进入 |
| [type-shift][native-type-shift] | 排版流 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 文字排版与分段进入 |
| [entity-chips][native-entity-chips] | 实体名牌 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 实体名牌逐项进入 |
| [pin-board][native-pin-board] | 要点钉板 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 要点逐项进入 |
| [rank-bars][native-rank-bars] | 排名条 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 条形伸展和 MotionValue 数字 |
| [stat-proof][native-stat-proof] | 数字实证 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 数值插值和辅助文案进入 |
| [growth-curve][native-growth-curve] | 增长曲线 | React TSX + Motion / SVG | `motion/react` | 是 | 状态推进 | 曲线路径描画与指标变化 |
| [versus-card][native-versus-card] | 对比卡 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 左右对比卡和 VS 标识进入 |
| [ui-callout][native-ui-callout] | 界面标注 | React TSX + Motion / DOM、SVG | `motion/react` | 是 | 状态推进 | 界面标注及引导元素动画 |
| [chapter-bar][native-chapter-bar] | 章节导航 | React TSX + Motion / DOM | `motion/react` | 是 | 状态推进 | 按 t 高亮章节，切换仍用 Motion |
| [caption-track][native-caption-track] | 常驻双语字幕 | React TSX / 时间函数 + DOM | 无 | 是 | 直接求值 | 按局部 t 计算字幕和过渡；显式声明直接模式 |
| [terminal-3d][native-terminal-3d] | 终端3D | React TSX + rAF + CSS 3D | 无 | 是 | 状态推进 | 虚拟时钟打字和 CSS 光标；不是 Three.js |
| [focus-card][native-focus-card] | 人物聚焦 | React TSX + Motion / DOM、视频 | `motion/react` | 是 | 状态推进 | 人物窗口、步骤及进场；读取 t 仍不等于免推帧 |

组合卡实际通过 [PartTree][part-tree] 挂载部件；它的卡片 `Component` 只负责空卡占位。选用部件后，依赖由各部件决定，例如 Motion、MagicUI vendor、Lottie 或 tsParticles。`terminal-3d` 的立体感由 CSS 透视和旋转产生，**没有使用 Three.js**；真正使用 Three.js 的是 `scene-3d`。

## 6. Lottie 素材卡（5 张）

这些卡片的可编辑主体是 Lottie JSON，外加生成的 React `CardDef`，不是五份独立 TSX 播放器。共同入口是 [素材卡生成器][asset-index]，共同渲染实现是 [LottieView][native-lottie]。表中 ID 链接指向对应 JSON。

| 卡片 ID / JSON | 显示名称与内容 | 代码类型 | 额外依赖 | React 接入外壳 | 动画求值分类（当前调度） |
| --- | --- | --- | --- | --- | --- |
| [lottie-adrock][lottie-adrock] | Lottie · adrock：摇滚小人角色动画,竖版 | Lottie JSON + React 播放器 | `lottie-web` | 是（外壳） | 状态推进 |
| [lottie-bodymovin][lottie-bodymovin] | Lottie · bodymovin：Bodymovin 字标动画,横条状,适合当标题 | Lottie JSON + React 播放器 | `lottie-web` | 是（外壳） | 状态推进 |
| [lottie-gatin][lottie-gatin] | Lottie · gatin：小猫角色动画,方形 | Lottie JSON + React 播放器 | `lottie-web` | 是（外壳） | 状态推进 |
| [lottie-happy2016][lottie-happy2016] | Lottie · happy2016：新年贺卡式的 2016 数字动画,全屏 16:9 | Lottie JSON + React 播放器 | `lottie-web` | 是（外壳） | 状态推进 |
| [lottie-navidad][lottie-navidad] | Lottie · navidad：圣诞主题场景动画,全屏 16:9 | Lottie JSON + React 播放器 | `lottie-web` | 是（外壳） | 状态推进 |

## 7. tsParticles 素材卡（53 张）

每行是一份独立粒子配置，通过 [素材卡生成器][asset-index]生成 React 卡片；共用 [ParticlesView][native-particles]和[参数转换器][particle-knobs]。粒子需要累积模拟，JSON 换皮不会使其自动变成免推帧动画。依赖列中的“粒子双库”具体指 `@tsparticles/engine` + `@tsparticles/slim`。

表中名称来自当前素材目录的描述；真实卡片显示名为“粒子 · 配置名”。ID 链接指向对应 JSON。“精选”仅控制左栏初始展示，不影响注册或 Agent 按 ID 使用。

| 卡片 ID / JSON | 内容 | 代码类型 | 额外依赖 | React 接入外壳 | 动画求值分类（当前调度） | 精选 |
| --- | --- | --- | --- | --- | --- | --- |
| [particles-basic][particles-basic] | 经典:漂浮圆点带连线 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-big][particles-big] | 大号半透明圆盘铺满 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-bigBlend][particles-bigBlend] | 大圆盘,混合模式叠色 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-bubble][particles-bubble] | 大气泡缓缓漂浮 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-colorAnimation][particles-colorAnimation] | 颜色循环变化的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-fallingConfetti][particles-fallingConfetti] | 飘落的彩纸 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-gradients][particles-gradients] | 渐变色粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-groups][particles-groups] | 几组不同大小颜色的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-lch][particles-lch] | LCH 色彩空间渐变的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-life][particles-life] | 不断生灭的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-linkTriangles][particles-linkTriangles] | 连线并填成三角网 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-nasa][particles-nasa] | 细小星点的星空 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-orbit][particles-orbit] | 带轨道环的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-parallax][particles-parallax] | 分层视差感 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-plasma][particles-plasma] | 等离子色团 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-poisson][particles-poisson] | 均匀铺开的圆点阵 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-random][particles-random] | 随机形状与颜色混合 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-repulse][particles-repulse] | 常见的连线网 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-slow][particles-slow] | 缓慢漂浮 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-snow][particles-snow] | 雪花飘落 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-spin][particles-spin] | 自转的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-star][particles-star] | 星形粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-strokeAnimation][particles-strokeAnimation] | 描边色循环 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-triangles][particles-triangles] | 三角形连线 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-twinkle][particles-twinkle] | 闪烁的星星 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-vibrate][particles-vibrate] | 微微抖动的粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 是 |
| [particles-backgroundCanvas][particles-backgroundCanvas] | 稀疏小点 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-bigBlendCombo][particles-bigBlendCombo] | 大圆盘,混合模式组合 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-clickPause][particles-clickPause] | 稀疏漂浮点 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-collisionsAbsorb][particles-collisionsAbsorb] | 碰撞吸收 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-collisionsBounce][particles-collisionsBounce] | 碰撞反弹 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-delay][particles-delay] | 延迟出现 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-delayColor][particles-delayColor] | 延迟变色 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-delayOpacity][particles-delayOpacity] | 延迟淡入 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-delaySize][particles-delaySize] | 延迟变大 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-delayStrokeColor][particles-delayStrokeColor] | 延迟描边变色 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-destroy][particles-destroy] | 到边消失 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-destroyExplode][particles-destroyExplode] | 到边爆开 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-effectBubble][particles-effectBubble] | 气泡效果 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-effectFilter][particles-effectFilter] | 滤镜效果 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-effectParticles][particles-effectParticles] | 粒子内嵌粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-effectTrailTransform][particles-effectTrailTransform] | 拖尾变形 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-grabRandomColor][particles-grabRandomColor] | 稀疏漂浮点(随机色) | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-lightHover][particles-lightHover] | 光照感粒子 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-mouseAttract][particles-mouseAttract] | 稀疏漂浮点 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-mouseDestroy][particles-mouseDestroy] | 稀疏漂浮点 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-mouseDrag][particles-mouseDrag] | 密集圆点 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-mouseParticle2][particles-mouseParticle2] | 中等密度圆点 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-moveAngle][particles-moveAngle] | 定向漂移 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-moveDistance][particles-moveDistance] | 限距漂移 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-moveInside][particles-moveInside] | 向内漂移 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-moveOutside][particles-moveOutside] | 向外漂移 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |
| [particles-noClear][particles-noClear] | 不清屏的拖痕 | tsParticles JSON + React / Canvas | 粒子双库 | 是（外壳） | 状态推进 | 否 |

目录明确排除 `shadow`、`nyancat2`、`textMask`、`textMaskMultiline`，未注册为本次默认卡片。排除记录称它们在此前两次渲染比对中存在 Canvas 阴影、尾迹或文字遮罩差异；这是已有目录记录，本次没有重新做这些效果的像素测试。

## 8. 调试卡（1 张）

| 卡片 ID / 源码 | 显示名称 | 代码类型 | 额外依赖 | React 接入外壳 | 动画求值分类（当前调度） | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| [probe][probe] | 探针卡 | React TSX + Motion + rAF | `motion/react` | 是 | 状态推进 | 显示动画和时间，供渲染诊断；当前会进入默认卡库 |

## 9. Agent 直接编辑源码：现有能力与需要调整的地方

目前已经提供“读取源码 → 局部修改 → 看帧”的路径。限制 Agent 优先调参数、复用或组合卡片的是现有编写流程；并非渲染器只能接受那套多层封装。

| 对象 / 操作 | 当前实现 | 对直接编辑方案的意义 |
|---|---|---|
| 已注册 Native / MagicUI / 用户 TSX 卡 | `get_card_source` 返回入口和依赖文件；`edit_card` 支持 `file`、`find`、`replace` | 已可直接改布局、动画实现和本地 vendor 源码 |
| 多张卡共用的文件 | 返回 `sharedBy`；改共用文件会影响多张卡 | 单卡定制应修改其独立入口，或创建独立实现；不能把改播放器当成仅改单份素材 |
| Lottie / 粒子生成卡 | 没有逐卡 TSX 文件；直接按生成卡 ID 读源码会提示读通用 `lottie` / `particles` | 需要区分“编辑这份 JSON”与“编辑所有同类卡的播放器”；现有 `edit_card` 不是通用素材 JSON 编辑口 |
| 新建卡片 | `create_card({ id, source })` 写入 TSX，自动扫描注册并热更新 | 仍需具名导出符合 `CardDef` 的对象；裸组件或裸 JSON 暂不能只靠声明就自动变成卡片 |
| 修改后的运行缓存 | 生效源码及其依赖内容参与代码哈希，并通知渲染 worker | 直接编辑流程需要保留源码变更通知和缓存失效 |
| 安装版内置卡修改 | 通过数据目录中的源码覆盖层加载 | 现有工具可让修改避开补丁覆盖；直接写安装包底版会绕过此机制 |
| 声明依赖 | 源码审查使用导入白名单；项目只安装了固定依赖 | 目前没有“声明任意 npm 库后自动安装 / 打包 / 迁移”的完整机制 |

依据：[源码读写与校验][card-api]、[源码覆盖层][overrides]、[当前编写指南][authoring-guide]。指南中还残留一句“内置卡没有可读回的源码文件”，与同一文档前面的 `edit_card` 说明及当前接口实现矛盾；设计新流程时应清理这条旧说明。本文按实际接口实现判断能力。

## 10. 建议的自定义卡声明（方案，尚未实现）

建议允许 Agent 直接写效果代码，并保留很薄的宿主适配层。**来源、代码格式、渲染引擎、时间访问方式应分别声明**；不能把 `MagicUI` 和 `React` 当成互斥的两类。

| 信息 | 建议内容 | 当前状态 |
|---|---|---|
| 身份 | `id`、`name`、作用域、版本 / 源码哈希 | ID 和名称、作用域、代码哈希已有相应机制；独立卡版本是扩展建议 |
| 代码格式 | `codeType: "react-tsx" / "lottie-json" / "tsparticles-json"` | `codeType` 尚无统一字段；Three.js 或 MagicUI 的 React 卡也属于 `react-tsx` |
| 来源 | `origin: "custom" / "magicui"`，上游地址和许可证 | 现有 `source` 主要用于 UI 分组；独立 `origin` 元数据是建议 |
| 渲染引擎 | `renderer: "dom" / "svg" / "canvas2d" / "webgl"` | 目前由实现决定，没有该统一声明字段 |
| 依赖 | 包名、版本、实际 import 路径，本地代码与 CSS 文件 | `dependencies` 清单及版本校验属于新增机制；只写包名不会让未安装依赖可用 |
| 时间模型 | `frameMode: "direct" / "stateful"`；统一接收片段局部秒数 `t` | 已有字段；直接模式要求进场、正文、退场都可由目标时间计算 |
| 参数和入口 | 默认参数、用户可调 schema、入口导出名 | 当前为 `defaults`、`controls`、`Component`；可让宿主自动生成适配代码 |
| 素材与就绪 | 素材列表、加载状态、错误和卸载清理 | 已有 `beginFrameWork` 机制；统一素材清单是扩展建议 |
| 可复现性 | 随机种子、重置方式；依赖历史时声明从何处推进 | 当前粒子有 seed / 重置逻辑；不能靠将字段改为 `direct` 消除历史依赖 |

例如，一张新建的、直接按时间计算的自定义 TSX 卡可以采用下面的**拟议元数据**。这不是当前 `create_card` 可以直接接受的完整请求：

```json
{
  "id": "custom-title",
  "codeType": "react-tsx",
  "origin": "custom",
  "renderer": "dom",
  "frameMode": "direct",
  "dependencies": { "react": "^19.2.7" },
  "entry": "CustomTitle",
  "assets": []
}
```

落地时可让 Agent 编辑 `Component(params, t)`，由宿主生成注册、挂载和参数适配。Lottie / 粒子则直接编辑 JSON 并选定现有播放器。自定义包依赖需要先核验本地可用版本和导入路径，并纳入构建与项目迁移流程；只靠“代码类型 + 依赖名称”还不足以确定怎样推进、何时截图、怎样重放。

优先改造方向是字幕、纹理、计数、进度、打字等可直接按 `t` 求值的效果；Lottie 和现有三维物件可进一步验证并补齐直接模式声明。Motion 进出场和粒子模拟需要分别判断，不能按“使用 React”一键归类。异步加载应接入 [frameReady][frame-ready]，完成目标帧绘制后再报告就绪。

## 11. 本次核验范围

逐项核对实际注册数组、目录生成条件、默认可见性、卡片入口和关键依赖源码；对照 `frameMode` 判定及当前依赖清单。文档中的注册数量、ID 覆盖和本地链接另做机械校验。本次是源码审计与文档整理，没有逐张执行全部 89 张卡的运行或像素一致性测试。

[native-composite]: <../src/cards/native/composite.tsx>
[native-lottie]: <../src/cards/native/lottie.tsx>
[native-particles]: <../src/cards/native/particles.tsx>
[native-scene-3d]: <../src/cards/native/scene-3d.tsx>
[native-odometer]: <../src/cards/native/odometer.tsx>
[native-blur-text]: <../src/cards/native/blur-text.tsx>
[native-ring-metric]: <../src/cards/native/ring-metric.tsx>
[native-checklist]: <../src/cards/native/checklist.tsx>
[native-step-timeline]: <../src/cards/native/step-timeline.tsx>
[native-quote-lockup]: <../src/cards/native/quote-lockup.tsx>
[native-punch-pill]: <../src/cards/native/punch-pill.tsx>
[native-term-card]: <../src/cards/native/term-card.tsx>
[native-type-shift]: <../src/cards/native/type-shift.tsx>
[native-entity-chips]: <../src/cards/native/entity-chips.tsx>
[native-pin-board]: <../src/cards/native/pin-board.tsx>
[native-rank-bars]: <../src/cards/native/rank-bars.tsx>
[native-stat-proof]: <../src/cards/native/stat-proof.tsx>
[native-growth-curve]: <../src/cards/native/growth-curve.tsx>
[native-versus-card]: <../src/cards/native/versus-card.tsx>
[native-ui-callout]: <../src/cards/native/ui-callout.tsx>
[native-chapter-bar]: <../src/cards/native/chapter-bar.tsx>
[native-caption-track]: <../src/cards/native/caption-track.tsx>
[native-terminal-3d]: <../src/cards/native/terminal-3d.tsx>
[native-focus-card]: <../src/cards/native/focus-card.tsx>
[magic-number-ticker]: <../src/cards/magicui/number-ticker.card.tsx>
[vendor-number-ticker]: <../src/cards/magicui/vendor/number-ticker.tsx>
[magic-blur-fade]: <../src/cards/magicui/blur-fade.card.tsx>
[vendor-blur-fade]: <../src/cards/magicui/vendor/blur-fade.tsx>
[magic-animated-circular-progress-bar]: <../src/cards/magicui/animated-circular-progress-bar.card.tsx>
[vendor-animated-circular-progress-bar]: <../src/cards/magicui/vendor/animated-circular-progress-bar.tsx>
[magic-typing-animation]: <../src/cards/magicui/typing-animation.card.tsx>
[vendor-typing-animation]: <../src/cards/magicui/vendor/typing-animation.tsx>
[magic-word-rotate]: <../src/cards/magicui/word-rotate.card.tsx>
[vendor-word-rotate]: <../src/cards/magicui/vendor/word-rotate.tsx>
[shiny]: <../src/cards/user/mu-animated-shiny-text.tsx>
[lottie-adrock]: <../server/catalog/lottie/adrock.json>
[lottie-bodymovin]: <../server/catalog/lottie/bodymovin.json>
[lottie-gatin]: <../server/catalog/lottie/gatin.json>
[lottie-happy2016]: <../server/catalog/lottie/happy2016.json>
[lottie-navidad]: <../server/catalog/lottie/navidad.json>
[particles-basic]: <../server/catalog/particles/basic.json>
[particles-big]: <../server/catalog/particles/big.json>
[particles-bigBlend]: <../server/catalog/particles/bigBlend.json>
[particles-bubble]: <../server/catalog/particles/bubble.json>
[particles-colorAnimation]: <../server/catalog/particles/colorAnimation.json>
[particles-fallingConfetti]: <../server/catalog/particles/fallingConfetti.json>
[particles-gradients]: <../server/catalog/particles/gradients.json>
[particles-groups]: <../server/catalog/particles/groups.json>
[particles-lch]: <../server/catalog/particles/lch.json>
[particles-life]: <../server/catalog/particles/life.json>
[particles-linkTriangles]: <../server/catalog/particles/linkTriangles.json>
[particles-nasa]: <../server/catalog/particles/nasa.json>
[particles-orbit]: <../server/catalog/particles/orbit.json>
[particles-parallax]: <../server/catalog/particles/parallax.json>
[particles-plasma]: <../server/catalog/particles/plasma.json>
[particles-poisson]: <../server/catalog/particles/poisson.json>
[particles-random]: <../server/catalog/particles/random.json>
[particles-repulse]: <../server/catalog/particles/repulse.json>
[particles-slow]: <../server/catalog/particles/slow.json>
[particles-snow]: <../server/catalog/particles/snow.json>
[particles-spin]: <../server/catalog/particles/spin.json>
[particles-star]: <../server/catalog/particles/star.json>
[particles-strokeAnimation]: <../server/catalog/particles/strokeAnimation.json>
[particles-triangles]: <../server/catalog/particles/triangles.json>
[particles-twinkle]: <../server/catalog/particles/twinkle.json>
[particles-vibrate]: <../server/catalog/particles/vibrate.json>
[particles-backgroundCanvas]: <../server/catalog/particles/backgroundCanvas.json>
[particles-bigBlendCombo]: <../server/catalog/particles/bigBlendCombo.json>
[particles-clickPause]: <../server/catalog/particles/clickPause.json>
[particles-collisionsAbsorb]: <../server/catalog/particles/collisionsAbsorb.json>
[particles-collisionsBounce]: <../server/catalog/particles/collisionsBounce.json>
[particles-delay]: <../server/catalog/particles/delay.json>
[particles-delayColor]: <../server/catalog/particles/delayColor.json>
[particles-delayOpacity]: <../server/catalog/particles/delayOpacity.json>
[particles-delaySize]: <../server/catalog/particles/delaySize.json>
[particles-delayStrokeColor]: <../server/catalog/particles/delayStrokeColor.json>
[particles-destroy]: <../server/catalog/particles/destroy.json>
[particles-destroyExplode]: <../server/catalog/particles/destroyExplode.json>
[particles-effectBubble]: <../server/catalog/particles/effectBubble.json>
[particles-effectFilter]: <../server/catalog/particles/effectFilter.json>
[particles-effectParticles]: <../server/catalog/particles/effectParticles.json>
[particles-effectTrailTransform]: <../server/catalog/particles/effectTrailTransform.json>
[particles-grabRandomColor]: <../server/catalog/particles/grabRandomColor.json>
[particles-lightHover]: <../server/catalog/particles/lightHover.json>
[particles-mouseAttract]: <../server/catalog/particles/mouseAttract.json>
[particles-mouseDestroy]: <../server/catalog/particles/mouseDestroy.json>
[particles-mouseDrag]: <../server/catalog/particles/mouseDrag.json>
[particles-mouseParticle2]: <../server/catalog/particles/mouseParticle2.json>
[particles-moveAngle]: <../server/catalog/particles/moveAngle.json>
[particles-moveDistance]: <../server/catalog/particles/moveDistance.json>
[particles-moveInside]: <../server/catalog/particles/moveInside.json>
[particles-moveOutside]: <../server/catalog/particles/moveOutside.json>
[particles-noClear]: <../server/catalog/particles/noClear.json>
[probe]: <../src/cards/_probe/probe.tsx>
[registry]: <../src/cards/index.ts>
[native-index]: <../src/cards/native/index.ts>
[magic-index]: <../src/cards/magicui/index.ts>
[user-index]: <../src/cards/user/index.ts>
[asset-index]: <../src/cards/assets/index.ts>
[cards-tab]: <../src/editor/left/library/cardGroups.tsx>
[frame-mode]: <../src/kernel/frameMode.mjs>
[package]: <../package.json>
[hud]: <../src/cards/native/hud.ts>
[hud-css]: <../src/cards/native/hud.css>
[magic-css]: <../src/cards/magicui/vendor/magicui-animations.css>
[part-tree]: <../src/kernel/PartTree.tsx>
[particle-knobs]: <../src/cards/assets/particlesKnobs.ts>
[card-api]: <../server/vite-plugin-cards.ts>
[overrides]: <../server/card-overrides.mjs>
[authoring-guide]: <../server/card-authoring-guide.md>
[frame-ready]: <../src/kernel/frameReady.ts>
