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
| `Component` | ✓ | React 组件 |
| `parts` | 建议 | **部件树**(约定封装的结构):这张卡对外由哪几块组成,每块由哪些参数驱动、什么时候进场、多久落定。代码页和 `get_clip` 按它组织参数。见下面「部件树与生命周期」 |
| `lifecycle` | 建议 | **生命周期**(约定封装的时间):进场多久落定(`settleMs`)、之后 `hold` 停住 / `loop` 循环 / `evolve` 持续变化、支持的退场(`exit`,目前都是 `["fade"]`) |

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

### 素材封装卡(不要再手写)

素材目录里的 Lottie 动画和粒子配置**已经是卡**:`lottie-<name>`、`particles-<name>`(src/cards/assets,构建时由目录生成)。
它们是「动效素材 → 函数翻译 → 约定封装」的产物:原始文件留在目录里,组件复用 LottieView / ParticlesView,
对外只有翻译出来的旋钮(粒子卡露出配置里真有的数量 / 速度 / 大小 / 颜色 / 不透明度 / 连线)。
想用某个素材就 `add_clip({ cardId: "lottie-adrock" })`,**不要**去读素材 JSON、不要用 create_card 再包一层;
`lottie-` / `particles-` 前缀是保留命名空间。

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
| 第二档·管线暂不支持 | WebGL、three / cobe 三维库 | 走 GPU 光栅化，导出用软件光栅化对不上。`<canvas>` 和 `Math.random` **现在接得住**（随机钉成带种子的、截图期间关脚本），不再拒 |
| 第三档·交互驱动 | mousemove / scroll 监听、`whileHover` / `whileTap` / `whileInView`、`useScroll` | 导出里没有鼠标和滚动，只会停在初态；改成由 `t` 驱动的参数才能进导出 |
| 依赖 | import 了没装的库 | 只有 react、motion/react、Tailwind、相对路径 |
| 动画 class | `animate-xxx` 没定义 | Tailwind 自带 4 个；MagicUI 的 22 组已在 `magicui-animations.css`；别的要自己写进去 |
| 来源/许可证 | 搬来的没写来源，或许可证不允许 | 不知道能不能随安装包分发 |

机制上已验证能直接搬的 Magic UI 组件（和已过逐字节比对的 5 张同类）：文字类（Text Animate、Typing、Number Ticker、Word Rotate、Shiny / Gradient / Aurora Text、Morphing、Spinning、Text 3D Flip）、Blur Fade、Border Beam、Shine Border、Marquee、Orbiting Circles、Animated List、各按钮、各背景图案、设备框。搬进来后一定 `see_preview` 看一眼。

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
see_preview({ clipId })                    ← 看一眼画面，确认它真的长成你想要的样子
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
see_preview({ clipId })         ← 看一眼改成什么样了
```

只有参数覆盖不到的（要加一个新参数、改布局、改动画类型）才动源码，走这三步：

```
get_card_source({ cardId })                   ← 读回当前源码，必须先读
edit_card({ cardId, find, replace })          ← 只替换那一段，别处原样不动
see_preview({ clipId })                       ← 看画面确认，别凭源码想象
```

`find` 要从 `get_card_source` 返回的源码里**逐字照抄**（缩进、空格都要一致），并且在
全文里唯一命中；匹配到多处就把 `find` 写长一点、带上周围几行。

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

### 按内容配动效

`auto_workflow` 已经把这条路自动化了（切段 + 选卡 + 铺字幕），用户说「自动做」「一键配特效」
就直接调它，不要自己一张张 `add_clip`。

要手动精修时，顺着文字稿找可视化的点，用每张卡的 `useWhen` 决定选哪张，
在对应 segment 的时间点 `add_clip`。注意同一条轨上的 clip 不能重叠
（store 会自动挪开，但结果多半不是你想要的）；需要并排显示就先 `add_track` 建新的 overlay 轨。
