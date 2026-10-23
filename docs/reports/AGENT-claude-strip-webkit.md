# iPhone Safari 缩略时间轴横向不可滚与 `scrollLeft` 失效调查报告（WebKit / Blink 差异）

## 一、任务书

### 【背景症状】
PromptCut 手机版（在线浏览器版）传统式编辑器里有一条横向滚动的「缩略时间轴」。在 iPhone Safari 上两个症状同时出现：
- **症状 A**：手指划不动（横向滚不起来）。
- **症状 B**：程序用 JS 设的 `element.scrollLeft` 也不生效 —— 时间码已经走到 5.7 秒，缩略条里表示当前帧的白线还停在 0。

同一份代码在桌面 Chrome 和无头 Chrome（安卓仿真）里一切正常。

### 【现场样式】
文件 `src/mobile/mobile.css` 第 154-159 行（只读，一个字都不许改）：
```css
.pcm .strip-scroll { display: flex; align-items: center; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; padding: 6px 0 10px; min-height: 80px; touch-action: pan-x; overscroll-behavior-x: contain; user-select: none; -webkit-user-select: none; }
.pcm .strip-scroll .mblock.sel { touch-action: none; }
.pcm .strip-scroll::-webkit-scrollbar { display: none; }
.pcm .sp-l { flex: none; width: calc(50% - 46px); }
.pcm .sp-r { flex: none; width: 50%; }
.pcm .mblock { flex: none; width: 80px; height: 64px; border-radius: 10px; position: relative; overflow: hidden; border: 2px solid transparent; }
```
结构（`src/mobile/ThumbStrip.tsx`）：`.strip-scroll` 里依次是一个 `.sp-l` 占位块、若干 `.mblock` 缩略块、一个 `.sp-r` 占位块。
当前帧白线 `.cf-line` 是 `position:absolute; left:50%` 挂在外层包裹上的，自己不动，靠 `.strip-scroll` 滚动把块推到中线下面。
程序滚动在 `ThumbStrip.tsx` 第 68-70 行：`el.scrollLeft = want` 之后立刻回读 `el.scrollLeft` 存起来。
已确认：`.strip-scroll` 的各级祖先在 `mobile.css` 里没有 `transform` / `contain` / `will-change`。

---

## 二、五个问题逐条

### 问题 1：`overflow-x: auto` 配 `overflow-y: hidden` 在 WebKit 上的表现与规范合法性

**一句话结论**：这个组合在 CSS 规范中**完全合法**（不会触发计算值改写），在现代 iOS Safari / WebKit 上**本身不会导致横向不可滚或 `scrollLeft` 赋值失效**；仅在 iOS 12 及更早版本中因缺少 `-webkit-overflow-scrolling: touch` 会退化为无惯性的慢速同步滚动。

#### 1. 规范怎么写的
- **组合合法性与计算值改写规则**：根据 **CSS Overflow Module Level 3 §3.1**，`overflow-x` 和 `overflow-y` 的初始值均为 `visible`。规范规定计算值（Computed value）改写规则如下：
  - 当其中一个轴的指定值为 `visible` 或 `clip`，而另一个轴**既不是 `visible` 也不是 `clip`**（即另一个轴为 `hidden`、`scroll` 或 `auto`）时，`visible` 会被强制改写为 `auto`，`clip` 会被强制改写为 `hidden`。
  - 当两个轴都已经属于滚动容器分组（`hidden`、`scroll`、`auto`）时——例如本题的 `overflow-x: auto` 配 `overflow-y: hidden`——**不触发任何改写**，两轴的计算值原样保持为 `overflow-x: auto` 和 `overflow-y: hidden`。
- **滚动容器语义**：只要任一轴为 `hidden`、`scroll` 或 `auto`，该元素即成为滚动容器（scroll container）并建立独立格式化上下文。`overflow-x: auto` 允许横向用户滚动与编程滚动；`overflow-y: hidden` 禁止纵向用户滚动且不显示纵向滚动条（但按规范仍允许纵向编程滚动，这是 `hidden` 与 `clip` 的区别）。

#### 2. 浏览器实际怎么做的（WebKit vs Blink）
- **现代 iOS Safari（iOS 13+）**：业界普遍共识是从 iOS 13（Safari 13）起，WebKit 默认对所有 `overflow: auto / scroll` 子容器启用异步惯性滚动（Asynchronous Momentum Scrolling，底层对应 ScrollingTree 节点与 `UIScrollView`），不再需要 `-webkit-overflow-scrolling: touch`（注：manager 已用 curl 核实 MDN 原 `-webkit-overflow-scrolling` 页面与 `mdn/browser-compat-data` 的 `css/properties/-webkit-overflow-scrolling.json` 均返回 404 不存在，故该条仅作为业界共识参考，不作权威依据）。单独使用 `overflow-x: auto; overflow-y: hidden` 不会导致容器不可滚，也不会让 `element.scrollLeft = N` 失效（本仓库 `mobile.css` 中 `.subnav`、`.atabs`、`.quicks`、`.seg` 也均使用 `overflow-x: auto`）。
- **旧版 iOS Safari（iOS 5–12）**：未加 `-webkit-overflow-scrolling: touch` 时，子容器走主线程同步慢速滚动，不仅没有惯性，而且当手指起始位移带有微小的纵向分量时，手势极易被外层纵向容器抢走，体感上表现为「很难划动」；但这不会导致 JS 赋值 `element.scrollLeft = N` 失效。
- **单轴隐藏对触摸方向锁的影响**：在 iOS Safari 中，当容器为 `overflow-x: auto; overflow-y: hidden` 时，原生 `UIScrollView` 仅在水平方向可滚；若用户手指起始滑动角度偏纵向，手势可能被判定为纵向手势而未触发水平滚动，但同样不影响 JS 设置 `scrollLeft`。

#### 3. 出处与可信度
- W3C CSS Overflow Module Level 3, §3.1 "Overflow Modes: the `overflow-x`, `overflow-y`, and `overflow` properties" (`https://www.w3.org/TR/css-overflow-3/#overflow-properties`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- W3C CSS 2.1, §11.1.1 "Overflow: the `overflow` property" (`https://www.w3.org/TR/CSS2/visufx.html#overflow`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- 关于「iOS 13+ 默认对 overflow 容器启用惯性滚动、`-webkit-overflow-scrolling` 不再需要」的权威文档出处 —— 〔没查到权威出处〕（manager 已用 curl 核实 MDN 该页与 `mdn/browser-compat-data` 对应条目均返回 404 不存在，故只当业界共识、不当权威依据）。
- 关于「现代 iOS Safari 单独因 `overflow-x: auto; overflow-y: hidden` 组合导致横向彻底不可滚且 `scrollLeft` 失效」的已知缺陷 —— 〔没查到权威出处〕（推断依据：该组合是移动端横向列表最基础的标准写法，探针页第 2 组可做实测排除）。

---

### 问题 2：`::-webkit-scrollbar { display: none }` 与 `scrollbar-width: none` 在 iOS Safari 上的支持与副作用

**一句话结论**：`::-webkit-scrollbar { display: none }` 在 iOS Safari 上**不会影响滚动本身**（不会导致滚不动，也不会关掉惯性滚动或令 `scrollLeft` 失效），而且 `display: none` 恰恰是 Safari 13+ 上 `::-webkit-scrollbar` 唯一仍然生效的用法；标准属性 `scrollbar-width: none` 在 Safari / iOS Safari 从 **18.2** 起支持，此前版本会按 CSS 规范静默忽略。

#### 1. 规范怎么写的
- **`scrollbar-width: none`**：根据 **CSS Scrollbars Styling Module Level 1 §2.2**，`scrollbar-width: none` 的原文定义为：
  > "Implementations must not display a scrollbar, however the element’s scrollability by other means is not affected."
  即实现不得显示滚动条，但**不得影响元素通过其它方式滚动的能力**。
- **`::-webkit-scrollbar`**：属于非标准 WebKit 伪元素扩展（标准替代方案即为 CSS Scrollbars Module Level 1）。
- **未知属性忽略规则**：根据 **CSS Syntax Module Level 3** 与 **CSS Cascading and Inheritance**，不支持 `scrollbar-width` 的浏览器在解析阶段直接丢弃该声明，不会影响同一规则块内的其它属性。

#### 2. 浏览器实际怎么做的（WebKit vs Blink）
- **iOS Safari 对 `::-webkit-scrollbar` 的支持与 `display: none` 的特殊地位**：
  - 根据 `mdn/browser-compat-data` 的 `css/selectors/-webkit-scrollbar.json`，`safari_ios` 从版本 **3** 起即支持 `::-webkit-scrollbar`，并且附有明确说明（原文）：
    > "From Safari 13, only `display: none` works with this pseudo-element. Other styles have no effect."
  - 也就是说，**`display: none` 恰恰是 Safari 13+ 上 `::-webkit-scrollbar` 唯一仍然生效的用法**（现场代码第 157 行写的正是 `.pcm .strip-scroll::-webkit-scrollbar { display: none; }`），用来隐藏滚动指示条，绝不会把滚动能力或 `scrollLeft` 赋值一起关掉。
  - 至于历史上（iOS 12 及更早）开启 `-webkit-overflow-scrolling: touch` 时自定义颜色/宽度的 `::-webkit-scrollbar-thumb` 不显示、是因为原生 `UIScrollView` 绕过了 WebKit 自定义滚动条绘制管线的说法，由于 BCD 的 note 只记载了其它样式无效、未记载内部原因，该原因分析标为〔凭记忆，未核实〕。
- **`scrollbar-width: none` 在 Safari 的支持起始版本**：
  - 根据 `mdn/browser-compat-data` 的 `css/properties/scrollbar-width.json`，`safari` 的 `version_added` 为 **`18.2`**，`safari_ios` 为 **`mirror`**（镜像桌面版，即 **iOS 18.2**），`chrome` 为 **`121`**。
  - 在 18.2 之前的 Safari 中，`scrollbar-width: none` 被解析器安全忽略，由 `.strip-scroll::-webkit-scrollbar { display: none }` 隐藏滚动条；在 18.2+ 中两者均生效且均不影响滚动能力。

#### 3. 出处与可信度
- W3C CSS Scrollbars Styling Module Level 1, §2.2 "Scrollbar Thickness: the `scrollbar-width` property" (`https://www.w3.org/TR/css-scrollbars-1/#scrollbar-width`) —— 〔已核实（manager 用 curl 核过 HTTP 200、锚点及原文，2026-10-24）〕
- MDN Web Docs: `::-webkit-scrollbar` (`https://developer.mozilla.org/en-US/docs/Web/CSS/::-webkit-scrollbar`) —— 〔已核实（manager 用 curl 核过 HTTP 200，2026-10-24）〕
- MDN Web Docs: `scrollbar-width` (`https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-width`) —— 〔已核实（manager 用 curl 核过 HTTP 200，2026-10-24）〕
- `mdn/browser-compat-data` `css/selectors/-webkit-scrollbar.json`（`safari_ios` `version_added: "3"`，note 原文：`From Safari 13, only \`display: none\` works with this pseudo-element. Other styles have no effect.`） —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- `mdn/browser-compat-data` `css/properties/scrollbar-width.json`（`safari` `version_added: "18.2"`，`safari_ios: "mirror"`，`chrome: "121"`） —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- 旧版 WebKit 下 `-webkit-overflow-scrolling: touch` 导致自定义 `::-webkit-scrollbar-thumb` 不生效的内部原因解释 —— 〔凭记忆，未核实〕
- 关于「`::-webkit-scrollbar { display: none }` 或 `scrollbar-width: none` 在 iOS Safari 上导致容器滚不动或 `scrollLeft` 失效」的案例 —— 〔没查到权威出处〕（推断依据：BCD 明确记载 `display: none` 是 Safari 13+ 唯一受支持的用法，且规范规定隐藏滚动条不影响可滚性；由探针页第 3、4 组实测验证）。

---

### 问题 3：可横向滚动 Flex 容器中百分比子项宽度、`scrollWidth` 计算与 `min-width: auto` 差异

**一句话结论**：当 Flex 滚动容器自身具有确定宽度时，WebKit 与 Blink 解析子项百分比宽度（`50%`、`calc(50% - 46px)`）的基准一致（均按容器 **content box 宽度**）；但 **WebKit 主干源码证实 `RenderBox::addLayoutOverflow` 会直接丢弃 `width <= 0 || height <= 0` 的空矩形**，而现场样式里 `.sp-l` 和 `.sp-r` 在 `align-items: center` 下因未设 `height` 导致高度恰为 **`0px`**（Blink 实测仍将零高度 `.sp-r` 计入 `scrollWidth`，而 WebKit 按源码会将其丢弃），在 1～2 段短内容项目下会导致 WebKit 的 `scrollWidth == clientWidth`（可滚距离为 0），从而**同时引发症状 A 和症状 B**！

#### 1. 规范怎么写的
- **百分比宽度的解析基准**：
  - **CSS 2.1 §10.2 (`width` property)** 与 **CSS Box Sizing Module Level 3 §5.2 ("Percentage Sizing")**：百分比 `<percentage>` 宽度相对于生成框的**包含块（containing block）的 content box 宽度**解析。若包含块的宽度依赖于该子项（即计算容器固有尺寸 intrinsic size 阶段），则百分比在固有尺寸阶段视为不可解析（按 `auto` 处理），待包含块宽度确定后在布局阶段按包含块 content box 宽度重新解析。
  - **CSS Flexible Box Layout Module Level 1 §4 & §9.2 Step 3 ("Line Length Determination")**：Flex 容器为其子项建立包含块（即 Flex 容器自身的 content box）。当子项设 `flex: none`（等价于 `flex: 0 0 auto`）且指定 `width: calc(50% - 46px)` 或 `width: 50%` 时，其 `flex-basis: auto` 直接取 `width` 属性值，在容器具有确定宽度 $W$ 时解析为 $0.5W - 46$ 与 $0.5W$，且因 `flex-shrink: 0`（**§9.7 Resolving Flexible Lengths**）绝不收缩。
- **可滚溢出区域（Scrollable Overflow Region）的计算**：
  - **CSS Overflow Module Level 3 §2.2 ("Scrollable Overflow: the scrollable overflow region")**：滚动容器的可滚溢出区域是容器自身 padding box 与其所有子项（及子孙）的盒模型边界（margin box / border box）的几何并集（union），`scrollWidth` 即为该区域在水平方向的宽度。
- **Flex 行方向上子项的 `min-width: auto`**：
  - **CSS Flexible Box Layout Module Level 1 §4.5 ("Implied Minimum Size of Flex Items")**：Flex 子项在**主轴方向**（`flex-direction: row` 时为 `min-width`）的初始值为 `auto`。对于非滚动容器（non-scroll container）的 Flex 子项，`min-width: auto` 解析为基于内容的最小尺寸（content-based minimum size）；而对于本身是滚动容器（`overflow` 不为 `visible`）的 Flex 子项，`min-width: auto` 解析为 `0`。在**交叉轴方向**（如 `flex-direction: column` 下的水平方向），`min-width: auto` 不适用自动内容最小尺寸，始终为 `0`。

#### 2. 浏览器实际怎么做的（WebKit 源码铁证 vs Blink 实测对照）
1. **WebKit 源码证实：高度为 `0px` 的 `.sp-r` 在累计布局溢出（`addLayoutOverflow`）时会被直接丢弃**：
   - 在现场样式中，`.strip-scroll` 设置了 `display: flex; align-items: center;`（不是默认的 `stretch`），而 `<div class="sp-l" />` 和 `<div class="sp-r" />` 是空节点且**没有设置 `height`**。因此 `.sp-l` 和 `.sp-r` 的实际布局高度恒为 **`0px`**。
   - **WebKit 主干源码（`raw.githubusercontent.com/WebKit/WebKit/main/`）直接证实了 WebKit 如何处理高度为 0 的子项溢出**：
     - `Source/WebCore/rendering/RenderBox.cpp` 中 `RenderBox::addLayoutOverflow` 开头原文：
       ```cpp
       auto clientBox = flippedPaddingBoxRect();
       if (clientBox.contains(rect) || rect.isEmpty())
           return;
       ```
     - `Source/WebCore/platform/graphics/LayoutRect.h` 第 85 行原文：
       ```cpp
       bool isEmpty() const { return m_size.isEmpty(); }
       ```
     - `Source/WebCore/platform/graphics/LayoutSize.h` 第 63 行原文：
       ```cpp
       bool isEmpty() const { return m_width.rawValue() <= 0 || m_height.rawValue() <= 0; }
       ```
     - **传播路径**：在同文件 `Source/WebCore/rendering/RenderBox.cpp` 中，`RenderBox::addOverflowWithRendererOffset` 先取子渲染器的 `renderer.layoutOverflowRectForPropagation(writingMode())`，执行 `move(offsetFromThis)` 后调用 `addLayoutOverflow(childLayoutOverflowRect)`，子项的溢出矩形正是从这里进入上面那道 `rect.isEmpty()` 闸门！
     - 此外，`Source/WebCore/platform/graphics/LayoutRect.cpp` 的 `LayoutRect::unite` 也是一上来就判断 `if (other.isEmpty()) return;`，而 WebKit 另行提供了 `uniteEvenIfEmpty` 供需要保留空矩形的调用方使用——这说明**跳过高度或宽度为 0 的空矩形是 WebKit 的有意设计选择，而非疏漏**。
   - **为什么这会直接把短内容项目的可滚距离变成 0**：
     - `.sp-l`（$50\% - 46\text{px}$）加上 `.madd`（$40\text{px} + 6\text{px} = 46\text{px}$）正好等于 $50\%$，把第 1 个 `.mblock` 的左边缘推到正中白线（$50\%$）处。
     - 当项目只有 **1 段 6 秒的视频**（症状 B 描述「时间码已经走到 5.7 秒」正好落在单段 6 秒内！）或 **2 段素材**时，所有 `height: 64px` 的 `.mblock` 右边缘仍在容器右缘之内，**唯一超出容器右缘、用来让最后一段滚到屏幕正中白线下的只有 `.sp-r`（`width: 50%`）**。
     - 因为 `.sp-r` 的 `m_height` 为 `0`，`rect.isEmpty()` 返回 `true`，WebKit 的 `RenderBox::addLayoutOverflow` 直接 `return` 丢弃了 `.sp-r`！于是容器的 `scrollWidth` 等于 `clientWidth`，可滚距离为 `0`！
2. **Blink 侧实测对照证据（同一零高度 `.sp-r` 在 Blink 下仍计入 `scrollWidth`）**：
   - Manager 在**无头 Chrome 152（视口 `390x844`、`DPR 3`、`isMobile`）**中打开本探针页实测 **第 11 组（仅 1 个 `.mblock`）** 量得：
     - 容器读数：`clientWidth = 338`、`scrollWidth = 376`、**`可滚距离 = 38`**（点按钮显示「设 38 → 立刻回读 38 → 下一帧 38」）；
     - 该组 `.sp-r.getBoundingClientRect()` 实测为 `width = 169`、**`height = 0`**、`right = 402`，而容器右缘 `containerRight = 364`、唯一那个 `.mblock` 的右缘 `lastBlockRight = 229`。
   - **WebKit 与 Blink 的分野就在此处**：在 Blink 下，唯一那个 `.mblock` 右缘（`229`）远未超过容器右缘（`364`），但高度为 `0` 的 `.sp-r`（右缘 `402`，超出容器右缘 $402 - 364 = 38\text{px}$）照样把 `scrollWidth` 从 `338` 撑大到了 `376`（产生 `38px` 可滚距离）；而按 WebKit 源码，`height == 0` 的 `.sp-r` 在 `addLayoutOverflow` 入口就被 `rect.isEmpty()` 丢弃，可滚距离直接归零！
   - *注*：源码已严格证明 WebKit `addLayoutOverflow` 会丢弃高度为 0 的空矩形这一机制；用户 iPhone 上实际是否正是这一条导致不可滚，由探针页第 11、13、14 组实测最终确认。
3. **外层 Flex 链条与 `min-width: auto` 在两家的差异**：
   - 在 `mobile.css` 中，`.pcm` → `.editor` → `.pane-default` → `.mainstrip` → `.strip-scroll` 中间多层未显式写 `width: 100%; min-width: 0`。至于横向 Flex 子项本身为滚动容器时 `min-width: auto` 归零修正的落地时间线差异，标为〔凭记忆，未核实〕。

#### 3. 出处与可信度
- WebKit 主干源码 `Source/WebCore/rendering/RenderBox.cpp`（`RenderBox::addLayoutOverflow` 中 `if (clientBox.contains(rect) || rect.isEmpty()) return;` 及 `RenderBox::addOverflowWithRendererOffset` 传播路径）、`Source/WebCore/platform/graphics/LayoutRect.h` 第 85 行（`LayoutRect::isEmpty`）、`Source/WebCore/platform/graphics/LayoutSize.h` 第 63 行（`LayoutSize::isEmpty` 判定 `m_width.rawValue() <= 0 || m_height.rawValue() <= 0`）、`Source/WebCore/platform/graphics/LayoutRect.cpp`（`LayoutRect::unite` 与 `uniteEvenIfEmpty`），均取自 `raw.githubusercontent.com/WebKit/WebKit/main/` —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- 无头 Chrome 152（视口 `390x844`、`DPR 3`、`isMobile`）对探针页第 11 组的实测数据（`clientWidth=338, scrollWidth=376, 可滚距离=38`，`.sp-r` 为 `width=169, height=0, right=402, containerRight=364, lastBlockRight=229`） —— 〔已核实（manager 用 curl / 无头 Chrome 152 核过，2026-10-24）〕
- W3C CSS 2.1, §10.2 "Content width: the `width` property" (`https://www.w3.org/TR/CSS2/visudet.html#the-width-property`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- W3C CSS Box Sizing Module Level 3, §5.2 "Percentage Sizing" (`https://www.w3.org/TR/css-sizing-3/#percentage-sizing`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- W3C CSS Flexible Box Layout Module Level 1, §4.5 "Implied Minimum Size of Flex Items" & §9.2 "Line Length Determination" (`https://www.w3.org/TR/css-flexbox-1/#min-size-auto`, `https://www.w3.org/TR/css-flexbox-1/#line-sizing`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- W3C CSS Overflow Module Level 3, §2.2 "Scrollable Overflow: the scrollable overflow region" (`https://www.w3.org/TR/css-overflow-3/#scrollable`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- WebKit 与 Blink 在横向 Flex 子项为滚动容器时 `min-width: auto` 归零修正时间线的差异 —— 〔凭记忆，未核实〕

---

### 问题 4：`touch-action: pan-x`、`overscroll-behavior-x: contain` 与子元素 `touch-action: none` 在 iOS Safari 的支持与行为

**一句话结论**：iOS Safari 从 **9.3** 起支持 `touch-action` 本体与 `manipulation`、从 **13** 起支持 `none` / `pan-x` / `pan-y`（但至今不支持 `pan-left` / `pan-right` 等单向值，且存在惯性滚动期间不遵守 `touch-action: pan-x/y` 的已确认 WebKit Bug 198708）；`overscroll-behavior-x` 从 **Safari 16** 起仅部分支持（对无溢出的滚动容器完全无效）；WebKit 的 `touch-action` 按命中节点到滚动容器的祖先链求交集，手指按在 `.mblock.sel`（`touch-action: none`）上会直接废掉当次原生横滑。

#### 1. 规范怎么写的
- **`touch-action` 的语义与祖先链求交集规则**：
  - 根据 **W3C Pointer Events Level 3 §"The `touch-action` CSS property"** 与 **§"Determining the effective touch-action"**：
    - `touch-action: pan-x` 允许用户代理在最近的祖先横向滚动容器上启动水平平移滚动（horizontal panning），同时禁止垂直滚动（`pan-y`）和双指缩放（`pinch-zoom`）。
    - `touch-action: none` 禁止用户代理在该点启动任何默认触摸行为（滚动或缩放）。
    - **有效值计算规则（求交集）**：当指针按下时，浏览器对**命中的目标元素（hit-tested target）及其所有祖先元素（直到承载该滚动行为的滚动容器为止）**的 `touch-action` 声明求交集（intersection）。兄弟节点（sibling elements）不在命中祖先链上，按规范不参与求交集。
- **`overscroll-behavior-x: contain`**：
  - 根据 **CSS Overscroll Behavior Module Level 1 §2**：`contain` 保留元素自身的边界回弹效果，但阻止滚动链（scroll chaining）传递到祖先滚动容器，并阻止触发浏览器级的横向滑动手势导航。

#### 2. 浏览器实际怎么做的（WebKit vs Blink）
- **`touch-action` 版本支持详情与已知 WebKit Bug**：
  - 根据 `mdn/browser-compat-data` 的 `css/properties/touch-action.json`：
    - `css.properties.touch-action` 本体：`safari_ios` 为 **`9.3`**（桌面 `safari` 为 **`13`**）；
    - `manipulation`：`safari_ios` 同为 **`9.3`**；
    - `none` / `pan-x` / `pan-y`：`safari` 为 **`13`**，`safari_ios` 为 **`mirror`**（即 **iOS 13**）；
    - `pan-left`、`pan-right`、`pan-up`、`pan-down`：在 `safari` 与 `safari_ios` 上均为 **`false`**（至今不支持，对应 **WebKit Bug 262876** *"Add support for additional touch-action values"*，状态 `NEW`）。
  - **WebKit 下 `touch-action: pan-x` 的真实已知缺陷**：**WebKit Bug 198708**（标题：*"touch-action:pan-x/y is not respected during momentum scrolling"*，状态 `NEW`）记录了在 WebKit 下，当滚动容器处于惯性滚动（momentum scrolling）期间，浏览器不遵守 `touch-action: pan-x/y` 的单轴约束。不过 `touch-action` 只管触摸手势，不会阻止无触摸时 JS 赋值 `element.scrollLeft = N`。
- **`overscroll-behavior-x: contain` 的支持情况、部分实现限制与本案关联**：
  - 根据 `mdn/browser-compat-data` 的 `css/properties/overscroll-behavior.json` 与 `overscroll-behavior-x.json`，`safari`（及 `safari_ios`）的 `version_added` 为 **`16`**，但标有 **`partial_implementation: true`**，附带 note 原文：
    > "The property has no effect on scroll containers that have no scrollable overflow."
    （Chrome 侧在 63–144 版本同样是该 `partial_implementation`，从 Chrome 144 起转为完整支持）。
  - **与本案第 1 名真因的直接呼应**：这条记录与问题 3 的零高度 `.sp-r` 被丢弃是同一个方向——一旦 `.strip-scroll` 因为 `.sp-r` 被丢弃而根本没有可滚溢出（`scrollWidth <= clientWidth`），`overscroll-behavior-x: contain` 在 Safari 上本来就什么都不做（完全不生效），所以**不要指望去掉 `overscroll-behavior-x: contain` 能救回没有溢出的滚动容器**。而在 iOS 15 及更早版本中，不支持的 `overscroll-behavior-x` 会在 CSS 解析阶段被直接忽略，也不会引发额外故障。
- **子元素 `.mblock.sel { touch-action: none }` 在 WebKit 下的影响**：
  1. **手指按在 `.mblock.sel` 上时（规范预期行为）**：当用户手指按在已选中的卡片 `.mblock.sel` 上滑动时，命中链为 `.mblock.sel`（`none`）→ `.strip-scroll`（`pan-x`），交集为 `none`，WebKit 必然禁用原生滚动；若同时叠加症状 B（`el.scrollLeft` 写不进）或长按超过 350ms 进入换序模式，手指按在选中块上就完全滑不动。
  2. **手指按在非选中区域时（WebKit `EventRegion` 合成层命中区域机制）**：WebKit 在绘制合成层时会将非默认 `touch-action` 区域编码进 `EventRegion` 发给 UIProcess（此内部机制标为〔凭记忆，未核实〕）；至于兄弟节点 `.mblock.sel` 的 `touch-action: none` 是否会污染整个 `.strip-scroll` 容器，未查到权威 Bug 记录，标为〔没查到权威出处〕，由探针页第 7 组直接对比验证。

#### 3. 出处与可信度
- W3C Pointer Events Level 3, §"The `touch-action` CSS property" (`https://www.w3.org/TR/pointerevents3/#the-touch-action-css-property`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- W3C CSS Overscroll Behavior Module Level 1, §2 "Overscroll Behavior Properties" (`https://www.w3.org/TR/css-overscroll-1/#overscroll-behavior-properties`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- MDN Web Docs: `touch-action` (`https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action`) & `overscroll-behavior-x` (`https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior-x`) —— 〔已核实（manager 用 curl 核过 HTTP 200，2026-10-24）〕
- `mdn/browser-compat-data` `css/properties/touch-action.json`（本体与 `manipulation` 在 `safari_ios` 为 `9.3`；`none` / `pan-x` / `pan-y` 在 `safari` 为 `13`、`safari_ios` 为 `mirror`；`pan-left` / `pan-right` / `pan-up` / `pan-down` 均为 `false`） —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- WebKit Bug 198708: *"touch-action:pan-x/y is not respected during momentum scrolling"*, Status: `NEW` (`https://bugs.webkit.org/show_bug.cgi?id=198708`) —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- WebKit Bug 262876: *"Add support for additional touch-action values"*, Status: `NEW` (`https://bugs.webkit.org/show_bug.cgi?id=262876`) —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- `mdn/browser-compat-data` `css/properties/overscroll-behavior.json` 与 `overscroll-behavior-x.json`（`safari` `version_added: "16"`, `partial_implementation: true`, note 原文：`The property has no effect on scroll containers that have no scrollable overflow.`；Chrome 63–144 同为 partial、144 起完整支持） —— 〔已核实（manager 用 curl 核过，2026-10-24）〕
- WebKit 通过 `EventRegion` 向 UIProcess 同步 `touch-action` 区域的实现机制 —— 〔凭记忆，未核实〕
- 关于「兄弟节点 `.mblock.sel` 上的 `touch-action: none` 在 WebKit 下把整个容器（含未选中子项）的横向手势连带废掉」的公开 Bug 编号 —— 〔没查到权威出处〕（推断依据：按规范求交集只走命中节点到根的祖先链；由探针页第 7 组直接证伪）。

---

### 问题 5：合成层提升与 WebKit 下 `element.scrollLeft = N` 赋值被静默忽略的全部已知情形

**一句话结论**：在 WebKit 下，会让 `element.scrollLeft = N` 赋值后立刻回读仍为 `0` 的最核心情形是**元素在布局上实际不可滚（`scrollWidth <= clientWidth`，被 CSSOM View 规范强制夹逼回 `0`）**；其余已知情形包括**正在进行触摸惯性滚动、合成层尺寸同步滞后、`-webkit-overflow-scrolling: touch` 旧版内容尺寸未刷新、`scroll-snap` 吸附、`scroll-behavior: smooth` 异步平滑滚动刚启动时立刻回读，以及首次渲染布局未完成时赋值**。

#### 1. 规范怎么写的
- **CSSOM View Module §6.1 (`scrollLeft` attribute)** 与 **`concept: smooth scroll`（`#concept-smooth-scroll` / `#perform-a-scroll` / `#propdef-scroll-behavior`）**：
  1. 若元素没有关联的 CSS 布局框（layout box），或该元素没有滚动框（no scrolling box），则**什么都不做，直接返回**（此时读取 `scrollLeft` 恒为 `0`）。
  2. 将赋入的目标值 $x$ **夹逼（clamp）到元素的有效可滚范围**（LTR 水平方向下即为 $[0,\ \max(0, \text{scrollWidth} - \text{clientWidth})]$）。
  3. 执行滚动（`#perform-a-scroll`）：若不满足平滑滚动条件（`scroll-behavior: auto`），立即同步更新滚动位置；若执行 `concept: smooth scroll`（`#concept-smooth-scroll`），则启动平滑过渡且过渡可被后续滚动打断（`#smooth-scroll-aborted`）或完成（`#smooth-scroll-completed`）。
- **CSS Scroll Snap Module Level 1 §5.2.1 ("Scoping Valid Snap Positions to Visible Boxes", `#snap-scope`)**：
  - 规范定义了有效吸附位置的作用域与可见盒约束；若容器启用了 `scroll-snap-type`，编程设置 `scrollLeft` 后会触发重新吸附到最近的有效 snap 位置（关于编程滚动完成后触发 re-snap 的通用机制描述标为〔凭记忆，未核实〕）。

#### 2. 浏览器实际怎么做的（WebKit 已知让 `scrollLeft = N` 失效或回读为 0 的七种情形）
1. **元素被祖先的 `transform` / `contain` / `will-change` 提升为合成层时的已知案例**：
   - 当滚动容器或其祖先因 `transform`、`will-change`、`contain: paint/layout`、`backdrop-filter` 被提升为合成层，且容器尺寸或子项内容发生动态变化时，WebKit 历史上曾出现 WebContent 进程的 `RenderLayerScrollableArea` 与 UIProcess `ScrollingTreeScrollingNode` 的可滚尺寸未同步，导致设入的 `scrollLeft` 在下一帧被 UIProcess 同步回来的 `(0, 0)` 覆盖。但本题已确认 `.strip-scroll` 各级祖先无 `transform` / `contain` / `will-change`。
2. **元素在布局上「其实不可滚」（`scrollWidth <= clientWidth`）**：
   - **这是唯一能用同一条机制同时解释「症状 A（手指划不动）」和「症状 B（JS 设 `scrollLeft = want` 立刻回读为 0）」的底层原因**。只要 WebKit 算出的 `scrollWidth - clientWidth == 0`（如问题 3 中 WebKit `RenderBox::addLayoutOverflow` 丢弃了 `height: 0` 的 `.sp-r`），`el.scrollLeft = want` 在主线程内部就会被 CSSOM View 的 clamp 步骤直接截断为 `0`，下一行 `el.scrollLeft` 必然同步回读出 `0`。
3. **赋值时正在惯性滚动或手指正按在容器上（Active User Scroll / Momentum Scrolling）**：
   - 在 iOS Safari 中，当用户手指正在拖动或松手后处于原生惯性滚动期间，滚动位置由 UIProcess 的 `UIScrollView` 驱动。此时在主线程执行 `el.scrollLeft = want`，会被正在进行的原生滚动忽略或在下一帧被 UIProcess 发回的滚动帧覆盖。
   - **叠加 `ThumbStrip.tsx` 自身的 `dragging.current` 门卫**：`ThumbStrip.tsx` 第 66 行写有 `if (!el || !el.clientWidth || dragging.current) return;`——只要 `onPointerDown` 把 `dragging.current` 置为 `true` 且尚未复位，`useLayoutEffect` 根本不会执行 `el.scrollLeft = want`。
4. **`-webkit-overflow-scrolling: touch` 的历史怪癖**：
   - 在 iOS 5–12 中，带 `-webkit-overflow-scrolling: touch` 的容器若初始渲染时内容未溢出，随后通过 JS 动态插入子元素使其溢出，WebKit 常出现底层 `UIScrollView.contentSize` 不刷新的问题，导致既滑不动也设不了 `scrollLeft`。
5. **`scroll-snap`（滚动吸附）**：
   - 若容器带有 `scroll-snap-type: x mandatory`，设置 `el.scrollLeft = want` 后浏览器会重新吸附到最近的吸附点；若只有起点一个有效吸附点，滚动位置会跳回 `0`（本现场未用 `scroll-snap`）。
6. **`scroll-behavior: smooth`（`concept: smooth scroll`）与立刻回读的时序冲突**：
   - 若滚动容器带有 `scroll-behavior: smooth`，执行 `el.scrollLeft = want` 只会发起异步平滑过渡，**紧接着下一行同步读取 `el.scrollLeft` 读到的一定是动画刚启动时的旧值 `0`**！在 `ThumbStrip.tsx` 第 69–70 行中，`progSl.current = el.scrollLeft` 会因此把 `0` 存进 `progSl.current`，随后动画过程中触发的 `scroll` 事件会反过来调用 `onScrub` 篡改当前时间（本现场 CSS 未设 `scroll-behavior: smooth`）。
7. **异步滚动线程（Scrolling Thread / UIProcess）与主线程读回的时序**：
   - 在 `scroll-behavior: auto` 且布局已完成、`scrollWidth > clientWidth` 的前提下，WebKit 在主线程执行 `el.scrollLeft = want` 会同步更新主线程 `ScrollableArea` 的偏移量，立刻回读即可读到更新后的值。探针页同时记录「立刻回读」与「下一帧（`requestAnimationFrame`）回读」，直接区分是「当场被 clamp 为 0」还是「下一帧被异步滚动线程回写为 0」。

#### 3. 出处与可信度
- W3C CSSOM View Module, §6.1 "The `scrollLeft` attribute" (`https://www.w3.org/TR/cssom-view-1/#dom-element-scrollleft`) & "concept: smooth scroll" (`https://www.w3.org/TR/cssom-view-1/#concept-smooth-scroll`, `#perform-a-scroll`, `#propdef-scroll-behavior`) —— 〔已核实（manager 用 curl 核过 HTTP 200 且锚点存在，2026-10-24）〕
- W3C CSS Scroll Snap Module Level 1, §5.2.1 "Scoping Valid Snap Positions to Visible Boxes" (`https://www.w3.org/TR/css-scroll-snap-1/#snap-scope`) —— 〔已核实（manager 用 curl 核过 HTTP 200 及锚点对应章节名，2026-10-24）〕；关于编程滚动后触发 re-snap 的通用机制描述 —— 〔凭记忆，未核实〕
- WebKit 合成层 / UIProcess 异步滚动（`UIScrollView` 惯性滚动期间覆盖主线程 `scrollLeft` 赋值、旧版 `-webkit-overflow-scrolling: touch` 动态内容尺寸不刷新） —— 〔凭记忆，未核实〕
- WebKit 在祖先 `transform` / `contain` / `will-change` 合成层下 `scrollLeft` 失效的具体 Bugzilla 编号 —— 〔没查到权威出处〕（推断依据：遵守不编造 Bug 编号的硬性要求；且现场已确认 `.strip-scroll` 祖先无这三个属性）。

---

## 三、最可能的真因排序（从高到低）与探针页证伪方法

> 核心判断准则：**症状 A（手指划不动）和症状 B（JS 设 `el.scrollLeft = want` 也不动，白线停在 0）在 iPhone Safari 上同时发生**。单纯的触摸手势属性（如 `touch-action`）只会影响症状 A，不会阻止无触摸时播放时间推进触发的 JS `el.scrollLeft = want`；唯有**让容器在 WebKit 下 `scrollWidth - clientWidth == 0`（根本没有可滚距离）**或**底层滚动容器状态被锁死**的原因，才能同时制造症状 A 和症状 B。

### 第 1 名（可能性最高，且已有 WebKit 源码铁证支持机制）：短项目下 `.sp-r`（`width: 50%`）因父容器 `align-items: center` 且未设 `height` 导致高度为 `0px`，被 WebKit `RenderBox::addLayoutOverflow` 当作空矩形直接丢弃，使可滚距离为 0
- **机制已由 WebKit 源码与 Blink 实测对照坐实**：
  - `.strip-scroll` 写了 `align-items: center`，而 `<div class="sp-l" />` 和 `<div class="sp-r" />` 都是没有内容的空 `<div>` 且未设 `height`，因此它们的实际高度是 **`0px`**。
  - 当项目只有 1～2 段素材（例如一段 6 秒的视频，播放到 5.7 秒）时，`.mblock` 的右缘（无头 Chrome 152 实测第 11 组 `lastBlockRight = 229`）小于容器右缘（`containerRight = 364`），**唯一超出容器右缘提供可滚距离的是 `height: 0px` 的 `.sp-r`（右缘 `402`）**。
  - 在 **Blink（无头 Chrome 152 实测）** 下，这个 `height: 0` 的 `.sp-r` 照样把 `scrollWidth` 从 `338` 撑大到 `376`（产生 `38px` 可滚距离）；但在 **WebKit** 下，源码 `Source/WebCore/rendering/RenderBox.cpp` 的 `RenderBox::addLayoutOverflow` 一上来就执行 `if (clientBox.contains(rect) || rect.isEmpty()) return;`，而 `LayoutSize::isEmpty()` 判定 `m_width.rawValue() <= 0 || m_height.rawValue() <= 0`，直接把 `height == 0` 的 `.sp-r` 丢弃！
  - 结果：WebKit 下 `scrollWidth == clientWidth`，可滚距离为 `0`——手指自然滑不动（症状 A），JS 设 `el.scrollLeft = want` 也被 CSSOM View 夹逼回 `0`（症状 B），连 `overscroll-behavior-x: contain` 也因没有可滚溢出而失效（V5）！
- **如何用探针页最终确认（第 11、13、14 组三角对照）**：
  - 注意区分两件事：WebKit 源码已证明 `addLayoutOverflow` 会丢弃空矩形这条机制；iPhone 现场实际是否就是这条，看探针页 **第 11 组（1 个块，百分比宽，高度为 0）**、**第 13 组（1 个块，百分比宽，给 `.sp-l`/`.sp-r` 加 `height: 1px`）**、**第 14 组（1 个块，固定 px 宽，高度仍为 0）**：
    - 若 **第 11 组可滚距离为 `0`、第 13 组大于 `0`** → 直接坐实零高度占位块被 WebKit 丢弃就是真因，且给 `.sp-l, .sp-r` 加 `height: 1px` 即可修好！
    - 若 **第 11 组和第 14 组可滚距离都为 `0`、而第 13 组大于 `0`** → 进一步证明与百分比宽度无关，纯粹是 `height: 0` 空矩形被丢弃所致！

### 第 2 名：`.strip-scroll` 处于多层未设 `width: 100%` / `min-width: 0` / `overflow: hidden` 的 Flex 祖先链中，在 WebKit 下容器自身 `clientWidth` 被内容撑大到等于 `scrollWidth`
- **为什么能同时解释 A 和 B**：
  - 在 `mobile.css` 中，`.pcm` → `.editor` → `.pane-default` → `.mainstrip` → `.strip-scroll` 这条链上，`.editor`、`.pane-default`、`.mainstrip`、`.strip-scroll` 全都没有写 `width: 100%`、`max-width: 100%`、`min-width: 0` 或 `overflow: hidden`。如果 WebKit 在计算嵌套 Flex 容器尺寸时让 `.strip-scroll` 的宽度顺着子项总宽撑大，那么 `.strip-scroll` 内部 `scrollWidth - clientWidth == 0`，既滑不动也设不了 `scrollLeft`。
- **如何用探针页证伪**：
  - 如果探针页里第 1 组和第 11 组在 iPhone 上**全都可滚、设 `scrollLeft` 也生效**，而在产品页面里不生效，就说明 `.strip-scroll` 自身样式没问题，直接锁定是**产品页外层 `.pcm` → `.editor` → `.pane-default` → `.mainstrip` 祖先链的布局/状态问题**。

### 第 3 名：`.mblock.sel { touch-action: none }` 拦截了手指在选中块上的横向滑动，叠加 `ThumbStrip.tsx` 的 `dragging.current` / `offsetParent` 逻辑导致程序滚动不跟手
- **为什么能解释现场现象**：
  - 当缩略条里有一张卡处于选中状态（`.mblock.sel`）且正对屏幕中央时，用户手指在缩略条中间去划，命中的正好是带 `touch-action: none` 的 `.mblock.sel`，WebKit 按规范直接禁用原生滚动。
  - 同时在 `ThumbStrip.tsx` 中：若 `dragging.current` 未复位，第 66 行 `if (... || dragging.current) return;` 会跳过 `el.scrollLeft = want`；且 `.strip-scroll` 缺少 `position: relative` 导致 `bl[i].offsetLeft` 的 `offsetParent` 落在了外层 `.mainstrip` 上。
- **如何用探针页证伪**：
  - 对比探针页 **第 1 组（对照组）** 按在第 3 块 `.sel` vs 按在普通块上的滑动表现，以及 **第 7 组（去掉 `.mblock.sel` 的 `touch-action: none`）**。

### 第 4 名：`touch-action: pan-x` 或 `overscroll-behavior-x: contain` 在当前 iOS Safari 版本上的单轴手势兼容问题（如 WebKit Bug 198708）
- **如何用探针页证伪**：
  - 对比 **第 1 组（对照组）** 与 **第 5 组（去掉 `touch-action: pan-x`）**、**第 6 组（去掉 `overscroll-behavior-x: contain`）**。

### 第 5 名（可能性最低）：`overflow-x: auto; overflow-y: hidden`、`::-webkit-scrollbar { display: none }`、`scrollbar-width: none` 或缺少 `-webkit-overflow-scrolling: touch`
- **如何用探针页证伪**：
  - 对比 **第 2 组（去掉 `overflow-y: hidden`）**、**第 3 组（去掉 `::-webkit-scrollbar`）**、**第 4 组（去掉 `scrollbar-width: none`）**、**第 10 组（加 `-webkit-overflow-scrolling: touch`）**。

---

## 四、探针页怎么用（iPhone 实测判读指南）

在 iPhone Safari 上打开 `docs/reports/strip-webkit-probe.html`（共 14 组）后，按以下三步看读数即可一眼锁定真因：

### 第一步：先看第 11、13、14 组与第 1 组的「可滚距离」（`scrollWidth - clientWidth`）
1. **重点看第 11、13、14 组（单段短内容三角对照）**：
   - **若第 11 组可滚距离为 `0`、第 13 组大于 `0`**：直接坐实**零高度占位块 `.sp-r` 被 WebKit `RenderBox::addLayoutOverflow` 丢弃（第 1 名真因）**，且修法就是**给 `.sp-l, .sp-r` 加 `height: 1px`**！
   - **若第 11 组和第 14 组可滚距离都为 `0`、而第 13 组大于 `0`**：更说明**与百分比宽度无关、只和零高度有关**（因为第 14 组已经把百分比换成了固定 `140px` / `186px`，只要高度还是 `0` 就照样被丢弃）！
   - **只有当第 11、13、14 组全都为 `0`（或第 1 组也为 `0` 而第 8 组大于 `0`）时**：才去怀疑 WebKit 对 Flex 子项百分比宽度的解析问题。
2. **如果第 1 组（12 个块）的可滚距离也等于 `0`**：
   - 往下看第 2～12 组哪一组的 `可滚距离` 变成了正数（如第 8 组固定 `px` 或第 9 组 `inline-block`）。

### 第二步：点顶部「一键测试全部 scrollLeft = 200」（或逐组点「点我用 JS 设 scrollLeft」）
观察每组按钮右侧显示的 **「设 N → 立刻回读 X → 下一帧 Y」**：
1. **如果第 11 组显示「设 200 → 立刻回读 0 → 下一帧 0」，而第 13 组显示「设 38 → 立刻回读 38 → 下一帧 38」**：
   - 彻底证明症状 B（JS 设 `scrollLeft` 不生效、白线停在 0）是因为零高度 `.sp-r` 被 WebKit 丢弃导致 `scrollWidth == clientWidth`，加上 `height: 1px` 后 JS 设 `scrollLeft` 立刻恢复正常。
2. **如果第 1 组和第 11 组在探针页里都显示回读成功，而在产品页面里仍不生效**：
   - 说明 `.strip-scroll` 自身样式支持 `scrollLeft`，问题出在产品外层组件（见第六节范围外代码建议）。
3. **如果某组显示「设 200 → 立刻回读 200 → 下一帧 0」**：
   - 说明主线程同步写入成功，但在下一帧被 WebKit 的异步滚动线程（UIProcess ScrollingTree）重置回了 `0`。

### 第三步：用手指在每组的色块条上左右划一下，看「手指滑过之后的 scrollLeft 最大值」
1. **对比第 11 组与第 13 组**：若第 11 组手指划不动（峰值 `0`），第 13 组手指能划动（峰值 `> 0`），说明症状 A 和症状 B 是同一个根因（零高度 `.sp-r` 被丢弃）。
2. **在第 1 组上，先按在普通块（如第 5、6 块）上左右划，再按在第 3 块（青色描边 `.sel`）上左右划，并对比第 7 组**：
   - 若第 1 组按普通块能划动、按第 3 块 `.sel` 划不动，而第 7 组按第 3 块也能划动 → 说明 `.mblock.sel { touch-action: none }` 挡住了选中块上的原生横滑手势。
3. **若第 1 组按普通块也划不动，而第 5 组 / 第 6 组 / 第 10 组能划动**：
   - 则对应组去掉（或加上）的那条属性即为阻断触摸手势的原因。

---

## 五、链接核验结果与没查到权威出处的条目清单

**链接全量核验说明**：manager 已于 2026-10-24 用 curl 逐条核验过初版报告中的全部 18 个链接——除原第 49 行 MDN `-webkit-overflow-scrolling` 链接返回 HTTP 404（已按 E1 删除）、原第 185 行 `www.w3.org/TR/cssom-view-1/#smooth-scrolling` 锚点不存在（已按 E2 改为真实存在的 `#concept-smooth-scroll`）外，其余 **16 条链接全部返回 HTTP 200 且对应锚点均真实存在**；本版新增的 2 条 WebKit Bugzilla 链接与 WebKit 主干源码、BCD 数据也均已由 manager 用 curl 核实。

### 1. 标为〔没查到权威出处〕的条目
1. **问题 1（iOS 13+ 默认启用惯性滚动、不再需要 `-webkit-overflow-scrolling: touch`）**：manager 已用 curl 核实 MDN 原页面 `developer.mozilla.org/en-US/docs/Web/CSS/-webkit-overflow-scrolling` 与 `mdn/browser-compat-data` 的 `css/properties/-webkit-overflow-scrolling.json` 均返回 404 不存在 —— 〔没查到权威出处〕（仅作业界共识，不作权威依据）。
2. **问题 1（`overflow-x: auto; overflow-y: hidden` 组合本身致残）**：现代 iOS Safari 中单独因 `overflow-x: auto; overflow-y: hidden` 组合导致横向彻底不可滚且 `scrollLeft` 赋值失效的公开 WebKit Bug 记录 —— 〔没查到权威出处〕（推断依据：该组合属 CSS Overflow L3 §3.1 合法组合，探针页第 2 组可实测排除）。
3. **问题 2（隐藏滚动条致残）**：`::-webkit-scrollbar { display: none }` 或 `scrollbar-width: none` 在 iOS Safari 上导致滚动容器本身失去滚动能力或使 `scrollLeft` 失效的公开案例 —— 〔没查到权威出处〕（推断依据：BCD 明确记载 `display: none` 是 Safari 13+ 唯一生效用法，且 CSS Scrollbars L1 §2.2 明确规定隐藏滚动条不影响通过其它方式滚动的能力）。
4. **问题 4（兄弟节点的 `touch-action: none` 污染整个容器）**：兄弟节点 `.mblock.sel` 上的 `touch-action: none` 在 WebKit 下因 `EventRegion` 合并缺陷把整个滚动容器（含未选中子项）的横向原生滚动手势一起废掉的公开 WebKit Bug 编号 —— 〔没查到权威出处〕（注：`touch-action: pan-x/y` 在惯性滚动期间不被遵守的副作用已由 manager 核到 **WebKit Bug 198708** 并移入已核实列表；仅「兄弟节点污染整个容器」这半截无权威出处，由探针页第 7 组验证）。
5. **问题 5（合成层提升下 `scrollLeft` 失效的具体 Bug 编号）**：元素被祖先的 `transform` / `contain` / `will-change` 提升成合成层时，WebKit 下 `element.scrollLeft = N` 失效的具体 WebKit Bugzilla 编号 —— 〔没查到权威出处〕（推断依据：为遵守不编造 Bug 编号的硬性要求，不写未核实的编号；且现场已确认 `.strip-scroll` 祖先无这三个属性）。

### 2. 标为〔凭记忆，未核实〕的条目（供交叉核对）
1. **问题 2**：旧版 WebKit 下同时开启 `-webkit-overflow-scrolling: touch` 时自定义 `::-webkit-scrollbar-thumb` 样式不显示是因为原生 `UIScrollView` 绕过了自定义滚动条绘制管线的内部原因解释 —— 〔凭记忆，未核实〕（BCD 的 note 已核实「Safari 13 起除 `display: none` 外其它样式均无效」，但未写内部原因）。
2. **问题 3**：WebKit 与 Blink 在「本身为滚动容器的横向 Flex 子项 `min-width: auto` 自动归零」这一规范修正上的落地时间线差异 —— 〔凭记忆，未核实〕。
3. **问题 4**：WebKit 在合成层绘制阶段将非默认 `touch-action` 区域编码进 `EventRegion` 发送给 UIProcess 进行触摸命中测试的内部机制 —— 〔凭记忆，未核实〕。
4. **问题 5**：CSS Scroll Snap 中编程滚动完成后触发 re-snap 的通用机制描述，以及 iOS WebKit 在 `UIScrollView` 处于手指拖动或惯性滚动期间忽略/覆盖主线程 `element.scrollLeft = N` 赋值、iOS 12 及更早版本 `-webkit-overflow-scrolling: touch` 动态增删子项后 `contentSize` 不刷新的历史现象 —— 〔凭记忆，未核实〕。

---

## 六、对产品代码的修复建议（仅作建议，未修改 `src/` 下任何文件）

1. **给 `.sp-l` 和 `.sp-r` 加上 `height: 1px`（消除 WebKit `RenderBox::addLayoutOverflow` 丢弃零高度空矩形）**：
   - 在 `src/mobile/mobile.css` 第 158–159 行，`.pcm .sp-l` 和 `.pcm .sp-r` 处于 `align-items: center` 的 Flex 容器内且无高度，导致 `m_height == 0` 被 WebKit `addLayoutOverflow` 的 `rect.isEmpty()` 直接丢弃。加上 `height: 1px` 后即可变为非空矩形，使 WebKit 正常计入 `.sp-r` 的右侧可滚溢出。
2. **给 `.pcm .strip-scroll` 加上 `position: relative`（修正 `offsetLeft` 的 `offsetParent` 参照系）**：
   - 在 `src/mobile/ThumbStrip.tsx` 第 48、60 行中，`posFromScroll` 与 `scrollForPos` 依赖 `bl[i].offsetLeft` 计算卡片位置；但目前 `position: relative` 写在外层 `.mainstrip` 上而 `.strip-scroll` 是 `position: static`，导致 `bl[i].offsetParent` 跨过了滚动容器落到外层 `.mainstrip` 上。给 `.strip-scroll` 加上 `position: relative`（并可顺带给 `.mainstrip` / `.strip-scroll` 明确 `width: 100%; min-width: 0`）能让 `offsetLeft` 严格以滚动容器自身为基准。
