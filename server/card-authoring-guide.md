# PromptCut 建卡规则

这份规则通过 `card_authoring_guide` 工具取得。**调 `create_card` 之前必须先读它**，不要凭印象写。

## 0. 先别急着建卡

新建卡片是最后手段，理由：

- 现有卡已经调过版式、动效节奏和主题适配，直接用效果更好；
- 每多一张卡，以后选卡就多一分噪音。

所以先走这三步：

1. `list_cards()` —— 拿到所有卡的摘要，重点看每张的 `useWhen`（什么时候该选它）和 `tags`。
2. 找到候选后 `list_cards({ cardId })` —— 拿这张卡的完整 `controls` 和 `defaults`，确认参数够用。
3. 只有确认**没有任何一张卡能通过调参数达成需求**时，才 `create_card`。

「颜色不对」「文案要换」「位置要挪」都是调参数的事，不要为此建新卡。

## 1. CardDef 契约

### 图卡路线

当需求需要现有参数做不到的**滤镜、转场、音频算法或多输入合成**时，写一张**图卡**。图卡不是另一套体系：它就是一张普通的 `CardDef`，源码同样是 `src/cards/user/<id>.tsx` 一个文件，同样用 `create_card` 落盘、`get_card_source` + `edit_card` 修改。区别只在于它不写 React `Component`，而是写 `card()`（视觉）或 `audio()`（音频），由宿主代为渲染。

建卡和应用是**两步**：`create_card({ id, source })` 落盘定义，再 `apply_card({ cardId, clipId, ... })` 建实例。

#### 契约

在普通 `CardDef` 的字段之上，图卡多这几项：

| 字段 | 说明 |
|---|---|
| `kind` | `"animation"` / `"filter"` / `"transition"` / `"emphasis"` / `"audio"`，缺省 `"animation"` |
| `inputs` | `Record<string, { description?: string }>`。`filter` / `emphasis` / `audio` 缺省 `{ source: {} }`，`transition` 缺省 `{ A: {}, B: {} }`，`animation` 缺省无输入 |
| `card` | `(sources, t, params, ctx) => CardGpuValue \| Promise<CardGpuValue>`，视觉图卡的出口 |
| `audio` | `(sources, range, params) => Float32Array \| Promise<Float32Array>`，音频图卡的出口 |
| `Component` | **图卡不写**。`Component` / `card` / `audio` 三者至少有一个，有 `card` 或 `audio` 就不写 `Component` |

- `sources[name]` = `{ nodeId, at(t?), pixels(t?, signal?), block(start, count) }`。
  - `at(t)` 返回一个**惰性引用**（不落像素），直接喂给 GLSL；这是默认、也是最便宜的一条路。
  - `pixels(t)` 才真的解出 `ImageBitmap`，CPU 像素算法才用它，会明显变慢。
  - `block(start, count)` 取音频采样块。
- `t` 是**片段本地秒**（不是时间轴绝对时间）。
- `range` = `{ start, count, sampleRate: 48000 }`，`start` / `count` 是采样位置和采样数；返回的样本数和起点必须和请求**完全一致**。
- `ctx` = `{ fps, width, height, duration, stage }`。
- `params` 是 `defaults` 合并实例参数后的结果，和 TSX 卡里的 `params` 同一口径。

帮助函数在 `src/render/cards/graphValues`：

- `glsl(fragment, inputs, uniforms)` —— GPU 片元着色器。输入纹理依次叫 `u_input0`、`u_input1`…，UV 是 `v_uv`，输出写进 `outColor`；**着色器必须自己声明用到的每一个 uniform**，传值不会自动补声明。
- `draw(commands)` —— 绘制指令。
- `bitmap(image)` —— 把 `ImageBitmap` / `ImageData` / `OffscreenCanvas` 直接当结果交出去，是 CPU 像素算法的出口。

**能力声明只写 `frameMode`**：只用 `at()` + GLSL 的图卡写 `"direct"`；用了 `pixels()` 或自带状态的写 `"stateful"`。**不要在源码里写 `compositing`**（写了会被 `create_card` 拒掉）——它只认人工审阅表 `src/cards/capabilities.json`；卡建出来之前按 `unknown` 走最保守的一条路，由人审阅后再加 `independent`。第一版图卡也**不要**声明 `canvasHeavy`。

#### 例一：GLSL 反色滤镜

```tsx
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { amount: number }

export const invertFilter: CardDef<Params> = {
  id: "invert-filter",
  name: "反色滤镜",
  description: "把输入画面按强度混向它的反色，0 是原样、1 是完全反色",
  source: "user",
  useWhen: "要给一段素材或一张图卡加整体反色 / 负片观感时用。只调色温亮度用调色参数，不要为此建卡。",
  tags: ["滤镜", "反色", "负片"],
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "要处理的画面" } },
  defaults: { amount: 0.5 },
  controls: [
    { key: "amount", label: "强度", type: "number", min: 0, max: 1, step: 0.01 },
  ],
  card: (sources, t, params) => glsl(
    `uniform sampler2D u_input0;
     uniform float amount;
     void main() {
       vec4 c = texture(u_input0, v_uv);
       outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a);
     }`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
```

用 `create_card({ id: "invert-filter", source })` 落盘，再 `apply_card({ cardId: "invert-filter", clipId: "clip-a" })` 套到某一段上。不传 `inputs` 时：那个片段上已经有图卡就自动接它的输出（「先反色再模糊」是自然动作），否则接这一段的原始素材。

#### 例二：双输入 crossfade 转场

```tsx
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { duration: number }

export const crossfade: CardDef<Params> = {
  id: "crossfade",
  name: "交叉溶解",
  description: "A 画面在给定时长内均匀溶解到 B 画面",
  source: "user",
  useWhen: "两段素材之间要一个最朴素的溶解转场时用。要带方向的推拉擦除另建卡。",
  tags: ["转场", "溶解", "crossfade"],
  kind: "transition",
  frameMode: "direct",
  inputs: { A: { description: "转场前的画面" }, B: { description: "转场后的画面" } },
  defaults: { duration: 1 },
  controls: [
    { key: "duration", label: "时长(秒)", type: "number", min: 0.1, max: 5, step: 0.1 },
  ],
  card: (sources, t, params) => glsl(
    `uniform sampler2D u_input0;
     uniform sampler2D u_input1;
     uniform float progress;
     void main() {
       outColor = mix(texture(u_input0, v_uv), texture(u_input1, v_uv), clamp(progress, 0.0, 1.0));
     }`,
    [sources.A.at(t), sources.B.at(t)],
    { progress: t / Math.max(1e-6, params.duration) },
  ),
};
```

钳位写在 GLSL 里。两个输入用 `apply_card` 指名：`apply_card({ cardId: "crossfade", trackId: "main", start: 3, end: 4, inputs: { A: { clipId: "clip-a" }, B: { clipId: "clip-b" } } })`。`inputs` 里的 `{ clipId }` 指素材段就是该素材，指图卡片段就是那张图卡的输出；`{ nodeId }` 直接接另一个节点的输出；`offset`（秒）和 `rate`（倍率）定义该输入的局部时间映射。

#### 例三：增益音频卡

```tsx
import type { CardDef } from "../../kernel/types";

interface Params { gain: number }

export const gainAudio: CardDef<Params> = {
  id: "gain-audio",
  name: "增益",
  description: "把输入音频按倍数放大或衰减，采样范围原样返回",
  source: "user",
  useWhen: "一段声音整体偏轻或偏响，又不想改素材本身时用。",
  tags: ["音频", "增益", "音量"],
  kind: "audio",
  frameMode: "direct",
  inputs: { source: { description: "要处理的声音" } },
  defaults: { gain: 1.5 },
  controls: [
    { key: "gain", label: "增益", type: "number", min: 0, max: 4, step: 0.05 },
  ],
  audio: async (sources, range, params) => {
    const block = await sources.source.block(range.start, range.count);
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;
    return out;
  },
};
```

音频卡 `kind: "audio"`，样本是交错的 `float32`（frames × channels）。**返回的样本数和起点必须和 `range` 完全一致**，非有限样本会被拒绝。音频图卡只写 `clip.nodeId`、不写 `clip.cardId`，所以画面上不会多出一层；同一个片段**不能**同时挂音频图卡和视觉图卡（要两样就先复制片段）。输入边上的 `rate ≠ 1` 第一版不支持。

#### 第一版的边界

- 图卡的输入只接**素材节点**和**别的图卡节点**；接 DOM 卡（普通 TSX 卡）会被 `apply_card` 拒掉。
- 传当前 `clip.nodeId` 给 `apply_card` = 原地改这个实例的参数和输入（不传 `inputs` 时继承旧的），不会接成自指。
- 改源码先 `get_card_source` 再 `edit_card`，不要建重复定义；同一张定义可以有多个参数不同的实例。做完用 `see_frames` 看实际效果。

### DOM 卡路线（普通 TSX 卡）

每张卡是一个文件，导出一个 `CardDef`：

```tsx
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";

/** 这张卡认哪些参数 */
interface Params {
  text: string;
  accent: string;
  size: number;
}

function PriceTagCard({ params }: CardProps<Params>) {
  // 挂载即开始播放。不要写「进入视口才播」这类逻辑。
  return (
    <div className="absolute inset-0 grid place-items-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{ color: params.accent, fontSize: params.size }}
      >
        {params.text}
      </motion.div>
    </div>
  );
}

export const priceTag: CardDef<Params> = {
  id: "price-tag",              // 小写 kebab-case，全局唯一，必须和 create_card 传的 id 一致
  name: "价格标签",              // 界面上显示的名字
  description: "价格数字带弹跳浮现",  // 一句话说清长什么样
  source: "user",               // AI/用户建的卡一律填 "user"
  useWhen: "口播报价格、报价区间时，把价格做成主视觉。只是陈述普通数字用 stat-proof。",
  tags: ["价格", "数字", "标签"],
  defaults: { text: "¥199", accent: "#ffd166", size: 96 },
  controls: [
    { key: "text", label: "文字", type: "text", required: true, hint: "要显示的价格，含货币符号" },
    { key: "accent", label: "主色", type: "color" },
    { key: "size", label: "字号", type: "number", min: 24, max: 240, step: 4 },
  ],
  Component: PriceTagCard,
};
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 小写 kebab-case。不能用 `mu-` 前缀（留给 Magic UI），不能和现有卡重名 |
| `name` | ✓ | 中文短名，显示在卡片库里 |
| `description` | ✓ | 一句话说清**外观和动效** |
| `source` | ✓ | 建新卡固定填 `"user"` |
| `useWhen` | 强烈建议 | **什么时候该选这张卡**，写给以后的 AI 看。写清触发条件，以及和近义卡怎么区分（「XX 情况用这张，YY 情况用另一张」）。不写的话这张卡以后基本不会被选中 |
| `tags` | 建议 | 检索关键词 |
| `defaults` | ✓ | 每个参数的默认值。见下面「默认值规则」 |
| `controls` | ✓ | 参数控件表。界面面板和 AI 都靠它了解 schema |
| `Component` | ✓ | React 组件。**图卡例外**：写了 `card` 或 `audio` 的定义不写它（见上面「图卡路线」） |
| `frameMode` | 建议 | `"direct"`（直接求值动画）：包括过渡在内，画面由 `params` 和局部时间 `t` 直接计算，可随机访问；`"stateful"`（状态推进动画）：依赖 Motion、CSS 动画、rAF 或模拟的历史，需要推进。是否使用 React 与这个分类无关。未填写默认保留历史；旧卡明确声明 `settleMs: 0, after: "hold"` 时自动按静态直接求值处理。 |
| `parts` | 建议 | **部件树**(约定封装的结构):这张卡对外由哪几块组成,每块由哪些参数驱动、什么时候进场、多久落定。代码页和 `get_clip` 按它组织参数。见下面「部件树与生命周期」 |
| `lifecycle` | 建议 | **生命周期**(约定封装的时间):进场多久落定(`settleMs`)、之后 `hold` 停住 / `loop` 循环 / `evolve` 持续变化、支持的退场(`exit`,目前都是 `["fade"]`) |

### 直接访问与异步就绪

字幕、纸纹以及能用 `t` 算出完整样式的卡优先使用 `frameMode: "direct"`，例如 `style={{ opacity: Math.min(1, t / 0.2) }}`。不要依赖挂载时刻、系统时钟或前一次渲染；预览会把它直接放到目标时间，状态推进动画才推演历史。`motion/react` 和粒子播放器的 React 外壳不代表它们能够直接求值。

兼容旧项目：原 `frameMode: "react"` 按 `"direct"` 读取，原 `"non-react"` 按 `"stateful"` 读取，无须重写旧 `.proc` 中的卡片源码。新卡统一使用新名称。

异步初始化（加载配置、构建 Canvas/WebGL 等）必须声明就绪状态，不能只靠 DOM 暂时没有变化判断。使用 `import { beginFrameWork } from "../../kernel/frameReady"`；在 effect 启动时创建 `const ready = beginFrameWork("控件名称")`，数据和画面准备好后调 `ready.ready()`，失败调 `ready.fail(error)`，effect 清理时调 `ready.dispose()`。截图会等待该状态以及字体、图片和视频解码完成；失败会明确报错。

### 部件树与生命周期(约定封装)

Agent 和代码页看到的不是组件源码,而是一份固定形状的**封装**(`get_clip` 返回的对象):card + lifecycle、time、frame、blend、parts、params。
组件源码只在建卡 / 改卡时经过审查门落盘一次,之后**只通过封装操作**。所以一张卡要把自己的结构和时序说清楚:

```ts
  parts: [
    { id: "title", label: "小标题", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "items", label: "要点", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 1100 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
```

- `parts[].params` 里的键必须是 `controls` 里真有的;一个参数只归一个部件;通用的 position / accent 归根部件或不写。
- `enterMs` / `settleMs` 按 motion 的 delay / duration 算(spring 按 +400ms 估),列表按最后一项算。
- `lifecycle.settleMs` 是整张卡最晚落定的时刻。Agent 据此知道「这段 clip 后面几秒是静止的」,该缩短时长还是加淡出。
- 没写这两个字段的卡按「一个根部件、有进场动画、之后停住、只支持淡出」处理,不报错。
- **时序随参数变的卡(条目数、字数、间隔、速度决定落定时刻)再给一个 `timing`**:`timing: (p) => ({ settleMs, parts: { items: { settleMs } }, after? })`,
  封装每次读的时候按 clip 的实际参数重算,和 frame 的 local → world 一样是派生量、不落盘;`parts` / `lifecycle` 里的静态值只当默认参数下的参考。

### 部件库与组合卡(自由组合不用建卡)

要「标题 + 要点 + 一个环形指标」这种现成卡里没有的搭配,**不要 create_card 写新卡**,用组合卡:

- `list_parts` 看部件库(src/parts/lib,每个部件是可独立渲染的最小单元:标题、要点、环形指标、排行条、Lottie……);
- `add_composite({ start, duration, parts: [{ partId, params?, frame?, enterMs? }, …] })` 一次搭好,或先建空的再 `add_part`;
- `set_part` / `remove_part` / `move_part` 改参数、框、进场时机、次序和父子关系;`get_clip` 里 parts 每个实例带 partId、frame.local(相对父框,可写)、frame.world(画面绝对位置,只读)、enterMs、settleMs。
- 有文字的部件都带 `size` 参数,`size` 填 0 = 按框自适应(默认),填正数 = 固定像素;不确定就留 0,只摆框。
- 部件的框相对**父框**:根部件的父框是组合卡的画布(默认整个舞台,set_rect 缩小组合卡整棵跟着缩),子部件的父框是父部件的框。次序靠后的画在上面。

写新部件(给部件库添零件)放 src/parts/lib/<id>.tsx,契约见 src/parts/types.ts:根元素 absolute inset 0、在自己的框里排版、不带整屏定位参数、给 defaultFrame 和 settleMs;有文字就加 `size` 参数(默认 0),用 `fitOr(params.size, { width, height, text })` 算字号。

### 素材封装卡(不要再手写)

素材目录里的 Lottie 动画和粒子配置**已经是卡**:`lottie-<name>`、`particles-<name>`(src/cards/assets,构建时由目录生成)。
它们是「动效素材 → 函数翻译 → 约定封装」的产物:原始文件留在目录里,组件复用 LottieView / ParticlesView,
对外只有翻译出来的旋钮(粒子卡露出配置里真有的数量 / 速度 / 大小 / 颜色 / 不透明度 / 连线)。
想用某个素材就 `add_clip({ cardId: "lottie-adrock" })`,**不要**去读素材 JSON、不要用 create_card 再包一层;
`lottie-` / `particles-` 前缀是保留命名空间。

### 引用素材库里的图片 / 视频

卡片参数里要放素材库的文件(图片卡的图、`scene-3d` 的 `texture`、背景视频……),**填 `list_media` 返回的 `cardUrl`**,
形如 `/@media/<文件名>`。编辑台预览、`see_frames` 的渲染页、导出都和它同源,三处都取得到。

- 不要填 `path`(磁盘路径):浏览器和渲染页读不了磁盘路径。
- 不要填 `blob:` 开头的地址:那是编辑器页面私有的,渲染和导出打不开,画面里那一块会是空的。
- 不要自己拼 `/media/…`、`http://localhost:端口/…`:端口不固定,导出时也不走那个端口。
- 素材库里没有想要的图:找到图片直链后 `import_media({ url, name })` 装进来,返回里就有 `cardUrl`。

### 默认值规则（重要）

`clip.params` 是**稀疏覆盖层**，渲染时才和 `defaults` 合并。所以默认值必须是「不填也说得过去」的东西。

- 能给出合理默认的参数：给一个像样的默认值，让卡片一加上去就有效果。
- **内容只能来自外部、给不出有意义默认值的参数**（比如字幕正文、转写文本）：
  默认值留空 **并且** 在 control 上标 `required: true`。

  别放演示文案当默认值。曾经字幕卡的 `lines` 默认放了三行样例，结果 AI 建卡时漏传 `lines`，
  画面照播那三行与视频无关的文案，看上去像「字幕加好了」——失败被默认值盖住，没有任何一处报错。

标了 `required` 的参数，`add_clip` / `update_clip` 会在写入前校验，为空直接报错。
`hint` 会一起返回给 AI，写清格式和取值范围。

## 2. 控件类型

只有这四种：

```ts
{ key, label, type: "text",   required?, hint? }
{ key, label, type: "number", required?, hint?, min?, max?, step? }
{ key, label, type: "select", required?, hint?, options: [{ value, label }] }
{ key, label, type: "color",  required?, hint? }
```

要一个「列表」参数就用 `text`，自己定一个分隔格式，并在 `hint` 里写清楚
（例如字幕轨的 `lines` 用换行分条、`|` 分列）。

### 会被调的值，一律做成参数

**凡是「换个数字/颜色就是另一种效果」的值，都要放进 `controls` + `defaults`，不要写死在
组件里。** 字号、字重、间距、圆角、颜色、动画时长和延迟、进场方向、缩放系数——这些
都属于这一类。

这不是风格建议，是成本问题：写死的值只能靠改源码来调，而每改一次源码就有把别处改
坏的风险；做成参数之后，「字大一点」就是一次 `update_clip`，改完立刻生效，也不会碰
到卡片其他任何地方。用户提一次「再大点」很正常，提第三次的时候你会庆幸当初把它做成
了参数。

判断标准：写这个字面量的时候如果心里冒出过「差不多这么大吧」，那它就该是参数。
反过来，布局结构（用 flex 还是 grid）、元素层级、动画的类型这些改了就是另一张卡的东西，
写死在源码里是对的。

## 3. 硬性约束

违反前三条的源码 `create_card` 会直接拒绝。

1. **不要用 `Date.now()`**。导出走的是虚拟时间，读真实时间会和画面对不上。
2. **不要用 `setTimeout` / `setInterval` 驱动动画**。同上，它们不受虚拟时钟控制。
   动画交给 `motion/react`，需要按时间推进就读组件收到的 `t`。
3. **不要用 `IntersectionObserver`**。卡片挂载即播放，不存在「滚动进入视口」。
4. **卡片是 1920×1080 舞台上的透明层**，根元素用 `absolute inset-0`，背景保持透明
   （除非这张卡就是要铺满底色）。
5. 字号、间距按 1920×1080 写死像素即可，舞台会整体缩放。

### 可以用的依赖

- `react`
- `motion/react`（`motion`、`AnimatePresence`、`useTransform` 等）
- `lottie-web`（按帧定位用 `goToAndStop(frame, true)`，不要 autoplay；参考 `src/cards/native/lottie.tsx`）
- `@tsparticles/engine` + `@tsparticles/slim`（canvas 粒子；挂载时先 `setRandom(() => Math.random())`，参考 `src/cards/native/particles.tsx`）
- Tailwind class（项目已装 Tailwind）
- `import type { CardDef, CardProps } from "../../kernel/types"`
- 复用 HUD 那套位置/主色约定：`import { hudControls, hudDefaults, getPositionClass, accentOf, easeExpoOut, type HudParams } from "../native/hud"`，
  然后 `interface Params extends HudParams`、`defaults: { ...hudDefaults, ... }`、`controls: [...hudControls, ...]`。
  这样卡片自动获得「位置」和「主色」两个参数，和内置卡保持一致。

别引其他第三方库——没装的会直接编译失败。

### 搬第三方组件（Magic UI 等）

可以把 Magic UI 的组件源码直接交给 `create_card`，它会先过一遍翻译器再审查：

- **自动改掉的**：`"use client"` 去掉；`@/lib/utils` 指到本地的 `../magicui/vendor/cn`。改了什么在返回的 `rewrites` 里。
- **必须你来做的**：把组件包成 `CardDef`——写 `Component`（把 `params` 喂给它、套上 `absolute inset-0` 的 1920×1080 层）、`defaults`、`controls`、`useWhen`。返回的 `suggestedControls` 是从它的 `*Props` 接口推出来、你还没露出来的参数，由你决定要不要提。
- **文件头必须声明来源和许可证**，照 `src/cards/magicui/vendor/word-rotate.tsx` 的写法：`来源: <URL>` 加许可证名。能搬的只有 MIT / Apache-2.0 / BSD / ISC / CC0。React Bits（Commons Clause）、Aceternity（专有）、animate.css（Hippocratic）、GSAP（禁止用于无代码动画工具）**不能搬**。
- 文件头声明了来源是 magicui 的卡可以用 `mu-` 前缀。
- **不用上网找源码**：Magic UI 全部组件的原始源码在本地目录里，本文末尾「附:Magic UI 可搬目录」按档位列了每一个。想用哪个就 `get_card_source({ cardId: "mu-<name>" })` 读它（返回里的 `hint` 会告诉你要先处理什么），包好后用同一个 id `create_card`。

审查会**拒绝**这几类，返回的 `findings` 逐条带档位：

| 档位 | 触发 | 为什么 |
|---|---|---|
| 第二档·管线暂不支持 | `setAnimationLoop` 这类**自带帧循环**、@react-three/fiber、cobe | 按 delta 累积的循环在导出里会多走不确定的步数，往回拖播放头也回不去。`<canvas>`、`Math.random`、**WebGL 和 three 现在都接得住**（three 已装，导出开了软件 WebGL，实测两趟逐字节相同），不再拒 |
| 第三档·交互驱动 | mousemove / scroll 监听、`whileHover` / `whileTap` / `whileInView`、`useScroll` | 导出里没有鼠标和滚动，只会停在初态；改成由 `t` 驱动的参数才能进导出 |
| 依赖 | import 了没装的库 | 装了的:react、motion/react、three、lottie-web、@tsparticles/*、Tailwind class,以及相对路径 |
| 动画 class | `animate-xxx` 没定义 | Tailwind 自带 4 个；MagicUI 的 22 组已在 `magicui-animations.css`；别的要自己写进去 |
| 来源/许可证 | 搬来的没写来源，或许可证不允许 | 不知道能不能随安装包分发 |

机制上已验证能直接搬的 Magic UI 组件（和已过逐字节比对的 5 张同类）：文字类（Text Animate、Typing、Number Ticker、Word Rotate、Shiny / Gradient / Aurora Text、Morphing、Spinning、Text 3D Flip）、Blur Fade、Border Beam、Shine Border、Marquee、Orbiting Circles、Animated List、各按钮、各背景图案、设备框。搬进来后一定 `see_frames` 看一眼。

## 4. 组件收到什么

```ts
interface CardProps<P> {
  params: P;        // defaults 和 clip.params 合并后的完整参数
  playToken: number; // 每次重播 +1；Stage 用它作 key 重新挂载，组件里通常不用读
  t?: number;        // 自 clip 起点起的秒数，逐帧传入
  duration?: number; // clip 总时长（秒）
}
```

**绝大多数卡不需要 `t`**——挂载即播，`motion` 自己会把动画走完。
只有「跟着时间轴走」的卡才读 `t`：字幕轨（按时间切换当前句）、章节导航（按时间高亮当前章节）。
如果你的卡要读 `t`，在 `useWhen` 里说明它需要 clip 覆盖整段时间，而不是一小截。

## 5. 建卡流程

```
card_authoring_guide()                     ← 先读规则（就是这份）
create_card({ id, source })                ← 落盘 + 热更新 + 自动注册
list_cards({ cardId: "price-tag" })        ← 确认注册成功、schema 是你想要的
add_clip({ cardId: "price-tag", start, duration, params })   ← 放上时间轴
see_frames({ source: "timeline", clipId })                    ← 看一眼画面，确认它真的长成你想要的样子
seek({ t: start + 0.5 })                   ← 把播放头挪过去，让用户直接看到效果
```

源码写到 `src/cards/user/<id>.tsx`，**不需要**改任何注册表文件——该目录是自动扫描的。

`create_card` 落盘前会校验：id 合法且不重名、确实导出了 `CardDef`、
源码里的 `id` 和参数里的 `id` 一致、必需字段齐全、没用禁用 API、TypeScript 语法能过。
不合格会返回**具体哪一条不过**，照着改再调一次即可。

## 5.1 改一张已经建好的卡

先想清楚要改的是**参数**还是**源码**——绝大多数「再大一点」「换个颜色」都是参数：

```
list_cards({ cardId })          ← 看这张卡有哪些参数
update_clip({ clipId, params }) ← 改值，立刻生效，不碰源码
see_frames({ source: "timeline", clipId })         ← 看一眼改成什么样了
```

只有参数覆盖不到的（要加一个新参数、改布局、改动画类型）才动源码，走这三步：

```
get_card_source({ cardId })                   ← 读回当前源码，必须先读
edit_card({ cardId, find, replace })          ← 只替换那一段，别处原样不动
see_frames({ source: "timeline", clipId })                       ← 看画面确认，别凭源码想象
```

`find` 要从 `get_card_source` 返回的源码里**逐字照抄**（缩进、空格都要一致），并且在
全文里唯一命中；匹配到多处就把 `find` 写长一点、带上周围几行。

**内置卡也能这样改源码**（不只是 `create_card` 建出来的）。不知道画面上某一块是源码哪一行渲染的，先看它的 DOM 树：

```
inspect_card_dom({ clipId })                  ← 只读：每个节点标出组件和源码行，如 src/cards/native/rank-bars.tsx:49
inspect_card_dom({ clipId, ref: 6 })          ← 从某个节点往下展开（同一时刻有缓存，不重渲）
get_card_source({ cardId, file })             ← 读那个文件（必须在返回的 files 列表里）
edit_card({ cardId, file, find, replace })    ← 改那一行
```

- **只能改源码，不能改 HTML**：DOM 是源码渲染出来的，没有直接改 DOM 的工具，也不该找。
- `files` 里每个文件带 `sharedBy`：大于 1 的是多张卡共用的部件（比如 `hud.ts`），改了它们一起变；只想改这一张，就改它自己的定义文件。
- 标着「同一行源码生成了 N 个兄弟节点」的是列表，改那一行 N 个一起变。
- 内置文件改之前自动备份到 `out/card-edits/`；不许新引入 `Date.now` / `setTimeout` / `setAnimationLoop` 这类不跟帧走的写法。

**不要用 `create_card` + `overwrite: true` 去改卡。** 那是整篇重写：你手上没有当前
版本，就只能凭记忆重建，这次没提到的细节（字号、间距、颜色）会一次比一次漂，用户
会看到自己没要求改的地方莫名其妙变了。`overwrite` 只留给「这张卡整个推倒重来」。

想改内置卡同样是改参数——内置卡没有可读回的源码文件，`get_card_source` 对它们会报错。

## 6. 用转写结果做卡

素材转写完（`transcribe_media` → `get_transcript`）后拿到：

```json
{ "segments": [ { "start": 0.0, "end": 1.6, "text": "大家好，欢迎收看本期节目。" } ] }
```

`start` / `end` 是**素材内**的秒数。

### 铺字幕轨

**用 `fill_captions`，不要自己拼 `lines` 字符串。**

```
add_clip({ cardId: "caption-track", start: 0, duration: 整段时长, params: { lines: "占位" } })
fill_captions({ clipId })
```

`fill_captions` 在本地一次算完时间对齐和裁切，几十上百条字幕不用逐条重打，
既不会错行错时间，也不烧 token。一整段字幕**一张卡**就够，不要每句话建一张。

不给 `trackId` 时它会自己落到「字幕」序列上（没有就新建，建在最上层）。
之后要改某一条，用 `list_captions` 看下标再 `edit_caption`，不要重灌整份。

### 按内容配动效

`auto_workflow` 已经把这条路自动化了（切段 + 选卡 + 铺字幕），用户说「自动做」「一键配特效」
就直接调它，不要自己一张张 `add_clip`。

要手动精修时，顺着文字稿找可视化的点，用每张卡的 `useWhen` 决定选哪张，
在对应 segment 的时间点 `add_clip`。注意同一条轨上的 clip 不能重叠
（store 会自动挪开，但结果多半不是你想要的）；需要并排显示就先 `add_track` 建新的 overlay 轨。
