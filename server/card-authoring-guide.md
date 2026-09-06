# PromptCut 自定义卡片开发指南 (Card Authoring Guide)

PromptCut 基于 React 架构和 Motion 动画库。你可以为项目编写自定义的动效卡片。

## 卡片契约 (CardDef)

每个卡片都是一个独立的 React 组件,并导出一个实现了 `CardDef` 接口的定义对象。

```typescript
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";

// 定义卡片的参数结构
interface Params { 
  text: string; 
  accent: string;
}

// 卡片组件
function MyCard({ params, playToken }: CardProps<Params>) {
  // 组件挂载即播放开始。不要用 IntersectionObserver。
  // playToken 变化时,Stage 会重新挂载本组件,所以它总是能从头播放。
  return (
    <div className="absolute inset-0 grid place-items-center">
      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        style={{ color: params.accent }}
      >
        {params.text}
      </motion.div>
    </div>
  );
}

// 导出卡片定义
export const myCard: CardDef<Params> = {
  id: "my-card", 
  name: "我的标题卡", 
  description: "一段简单的渐显文字动效", 
  source: "native",
  defaults: { text: "Hello", accent: "#ffffff" },
  // 必须在此定义控件,AI 和界面面板会据此生成参数 schema:
  controls: [
    { key: "text", label: "文字", type: "text" }, 
    { key: "accent", label: "主色", type: "color" }
  ],
  Component: MyCard,
};
```

## UI 控件类型
`CardDef.controls` 支持四种类型的属性控件:
- `text`: `{ type: "text" }`
- `number`: `{ type: "number", min?: 0, max?: 100, step?: 1 }`
- `select`: `{ type: "select", options: [{ value: "v1", label: "Option 1" }] }`
- `color`: `{ type: "color" }`

## 约束与建议
1. 你的卡片将作为透明层绝对定位(absolute inset-0)放置在 1920x1080 舞台上。
2. 动画应依赖于 `motion/react` 或纯 CSS。
3. 请使用项目的 `--pc-*` CSS 变量来适配主题(如 `--pc-accent`, `--pc-fg`)。
4. **绝对不要**使用 setTimeout 驱动动画,也不要读 `Date.now()`,因为导出时使用的是虚拟时间,须用 `performance.now()`(由内核的 clock 代理)。

## 用转写结果生成卡片

素材转写完之后(`transcribe_media` → `get_transcript`),你会拿到:

```json
{
  "engine": "faster-whisper", "model": "small", "language": "zh",
  "segments": [
    { "start": 0.0, "end": 1.6, "text": "大家好，欢迎收看本期节目。" },
    { "start": 1.6, "end": 3.2, "text": "今天我们聊聊视频剪辑。" }
  ]
}
```

`start` / `end` 是**素材内**的秒数。

### 路子一:铺一条字幕轨

`caption-track` 卡的 `lines` 是一段文本,一行一条,格式 `起|止|中文|英文`(英文可省)。
时间是**相对这张 clip 起点**的秒数,所以要减去 clip 的 `start`:

```js
const clipStart = 0;
const lines = transcript.segments
  .map(s => `${(s.start - clipStart).toFixed(2)}|${(s.end - clipStart).toFixed(2)}|${s.text}|`)
  .join("\n");

await add_clip({
  cardId: "caption-track",
  start: clipStart,
  duration: transcript.segments.at(-1).end - clipStart,
  params: { lines, showEn: "false" }
});
```

一整段字幕用**一张**卡就够,不要每句话建一张。

### 路子二:按段落配动效

顺着文字稿找可视化的点,在对应时间点插卡。先 `list_cards` 确认参数 schema,再:

```js
for (const s of transcript.segments) {
  if (/\d+%|增长|涨/.test(s.text)) {
    await add_clip({ cardId: "growth-curve", start: s.start, duration: s.end - s.start, params: { /* ... */ } });
  } else if (/第一|第二|首先|其次/.test(s.text)) {
    await add_clip({ cardId: "checklist", start: s.start, duration: s.end - s.start, params: { /* ... */ } });
  }
}
```

注意别让同一条轨上的 clip 重叠(store 会自动挪开,但结果可能不是你想要的);
需要并排显示就先 `add_track` 建新的 overlay 轨。

## 注册卡片
将写好的卡片文件保存在 `src/cards/native/` 下,并在 `src/cards/native/index.ts` 中汇总导出即可。注册表会自动加载它,AI 也会通过 `list_cards` 工具立刻知道新卡片的存在。
