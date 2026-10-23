# AGENT-claude-strip-webkit：缩略时间轴在 iPhone Safari 上滑不动 —— WebKit 已知差异调查

分支 `claude/strip-webkit`。本路**只查 WebKit / iOS Safari 的已知差异**，不改 `src/` 下的产品代码（另两路在改）。

## 任务书（派活方给的，照抄）

症状：PromptCut 手机版（在线浏览器）传统式编辑器里的横向滚动条「缩略时间轴」，在 iPhone Safari 上
1. 手指划不动；
2. 程序设的 `scrollLeft` 也不生效（时间码走到 5.7 秒，缩略条的当前帧白线还停在 0）。

同一份代码在桌面 Chrome 和无头 Chrome（安卓仿真）里一切正常。

现场样式（`src/mobile/mobile.css` 第 154-159 行，只读）：

```css
.pcm .strip-scroll { display: flex; align-items: center; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none; padding: 6px 0 10px; min-height: 80px;
  touch-action: pan-x; overscroll-behavior-x: contain; user-select: none; -webkit-user-select: none; }
.pcm .strip-scroll .mblock.sel { touch-action: none; }
.pcm .strip-scroll::-webkit-scrollbar { display: none; }
.pcm .sp-l { flex: none; width: calc(50% - 46px); }
.pcm .sp-r { flex: none; width: 50%; }
.pcm .mblock { flex: none; width: 80px; height: 64px; ... }
```

结构（`src/mobile/ThumbStrip.tsx`）：`.strip-scroll` 里依次是 `.sp-l`、若干 `.mblock`、`.sp-r`；
程序滚动在 `ThumbStrip.tsx` 第 68-70 行：`el.scrollLeft = want` 之后立刻回读 `el.scrollLeft`。

要查清并给出处的五个问题：

1. `overflow-x: auto` 配 `overflow-y: hidden` 在 WebKit 上有没有已知的「不可滚」毛病？
2. `::-webkit-scrollbar { display: none }` 在 iOS Safari 上会不会连带影响滚动本身？
3. 可横向滚动的 **flex** 容器里，子项用百分比宽度（`calc(50% - 46px)`、`50%`）时 WebKit 解析的基准和 Blink 一样吗？会不会导致 `scrollWidth === clientWidth`？
4. `touch-action: pan-x` 与 `overscroll-behavior-x: contain` 在 iOS Safari 的支持情况与副作用。
5. 祖先的 `transform` / `contain` / `will-change` 把元素提升成合成层时，WebKit 下 `element.scrollLeft = N` 失效的已知案例。

## 交付

- 本文件：逐条结论与出处；拿不准的明确标「没查到权威出处」，不编造链接。
- `docs/reports/strip-webkit-probe.html`：单文件、零依赖的变体对照探针页，用户在 iPhone 上打开一眼看出是哪条属性把滚动弄没了。

## 调查结果

（待填）

## 最可能的真因排序

（待填）

## 探针页怎么用

（待填）
