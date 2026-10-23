# AGENT-claude-strip-css

分支 `claude/strip-css`，worktree `.worktrees/strip-css`。执行者：agy（Antigravity CLI，模型 gemini-4-argon-high）+ manager。

## 任务

查手机版（在线浏览器窄屏）传统式编辑器「缩略预览」页里那条横向滚动的缩略时间轴（`.strip-scroll`）
在 iPhone Safari 上**整条不可滚**的布局/CSS 原因。用户报的现象两条：

1. 手指在条上左右划，完全不动；
2. 播放时（时间码已走到 00:05.7 / 00:06.0）条里「当前帧」白线仍停在 0 —— 即程序自己设的 `scrollLeft` 也没生效。

无头 Chrome（安卓仿真 375x812）复现不出来：那里量到 `clientWidth 375 / scrollWidth 455`，滚得动。

## 本路的边界

- 只读分析 + 写最小复现页来验；**不改 `src/` 下的产品代码**（另有两路在改）。
- 可新建文件。交付两件：本报告 + `docs/reports/strip-css-repro.html`。
- 不推送、不合并、不动 `main`。

## 状态

布局与 CSS 链条静态分析已完成，最小复现页 `docs/reports/strip-css-repro.html` 已生成；因本地无 iPhone 真机且受禁跑浏览器约束，WebKit 分支结论待真机打开复现页读数最终钉死。

## 结构与 CSS 链条

### 1. 完整祖先链逐环属性表（以 375×812 视口为例）

DOM 挂载链条见 `index.html:9-10`、`src/index.css:32`、`src/mobile/MobileApp.tsx:12-18`（`ToastHost` 与 `ConfirmHost` 仅包 Context Provider，不产生额外包裹 DOM 节点）、`src/mobile/MobileEditor.tsx:289,357`、`src/mobile/ThumbStrip.tsx:145-183`；样式规则见 `src/mobile/mobile.css`。

| 节点 | 代码与 CSS 位置 | `display` | `width`（是否 definite 及决定机制） | `overflow` | `padding` | `min-width` | `position` | `contain` / `transform` |
|---|---|---|---|---|---|---|---|---|
| `html` / `body` / `#root` | `src/index.css:32` | `block`（初始值） | `auto`（**definite = 375px**，由初始包含块 ICB 视口宽度决定） | `visible` | `0` | `auto` | `static` | `none` / `none` |
| `.pcm` | `MobileApp.tsx:12`<br>`mobile.css:37-42` | `flex`（`flex-direction: column`） | `auto` + `inset: 0`（**definite = 375px**，由 `position: fixed; left: 0; right: 0` 锁死在布局视口宽度） | `hidden`（`x/y` 均为 `hidden`） | `0` | `auto`（非 flex 子项） | `fixed`（`inset: 0`） | `none` / `none` |
| `.editor` | `MobileEditor.tsx:289`<br>`mobile.css:103` | `flex`（`flex-direction: column`，`flex: 1`） | `auto`（**按规范 definite = 375px**，作为 `.pcm` 竖向主轴 flex 容器的子项，在交叉轴水平方向受默认 `align-items: normal (stretch)` 拉伸至父容器内宽 375px） | `visible` | `0` | `auto`（交叉轴上解析为 `0`；仅显式设了 `min-height: 0`） | `static` | `none` / `none` |
| `.pane-default` | `MobileEditor.tsx:357`<br>`mobile.css:136` | `flex`（`flex-direction: column`，`flex: none`） | `auto`（**按规范 definite = 375px**，作为 `.editor` 竖向 flex 容器的子项，在水平交叉轴被 `stretch` 拉伸至 375px） | `visible` | `0` | `auto`（水平方向为交叉轴，按规范为 `0`） | `static` | `none` / `none` |
| `.mainstrip` | `ThumbStrip.tsx:145`<br>`mobile.css:140` | `block`（`div` 初始值，作为父 flex 子项 `flex: none`） | `auto`（**按规范 definite = 375px**，作为 `.pane-default` 竖向 flex 容器的子项，在水平交叉轴被 `stretch` 拉伸至 375px） | `visible` | `0` | `auto`（水平方向为交叉轴，按规范为 `0`） | `relative`（作为 `.cf-line` 的绝对定位包含块） | `none` / `none` |
| `.strip-scroll` | `ThumbStrip.tsx:149`<br>`mobile.css:154` | `flex`（默认 `flex-direction: row`，`align-items: center`） | `auto`（**按规范 definite = 375px**，作为 `display: block` 的 `.mainstrip` 下的块级 flex 容器，`width: auto` 自动填满父块内容宽 375px） | `overflow-x: auto`<br>`overflow-y: hidden` | `6px 0 10px`（左右为 `0`） | `auto`（父 `.mainstrip` 是 `block` 而非 `flex`，故 `.strip-scroll` 不是 flex 子项） | `static`（未设 `relative`） | `none` / `none` |

### 2. 每一环的宽度到底是不是确定的？主轴方向与横向约束分析

- **主轴与交叉轴方向**：`.pcm`（`mobile.css:37`）、`.editor`（`mobile.css:103`）、`.pane-default`（`mobile.css:136`）三层全部是 `display: flex; flex-direction: column`，它们的**主轴是竖向（vertical）**，**水平方向（宽度）是交叉轴（cross axis）**。
- **横向上起作用的是 `align-items: stretch` 而不是 `min-width: auto`**：
  - 按 CSS Flexible Box Layout Module Level 1 §4.5（Automatic Minimum Size of Flex Items），`min-width: auto` / `min-height: auto` 的内容最小尺寸（`min-content`）**只在主轴方向生效**。在 `flex-direction: column` 容器里，主轴是竖向（对应 `min-height: auto`，因此 `.editor` 写了 `min-height: 0`），而水平交叉轴上的 `min-width: auto` 退化为 `0`。
  - 同时，这三层均未覆盖 `align-items`，默认 `align-items: normal`（即 `stretch`）。按 CSS Flexbox §9.4 与 §9.8（Definite and Indefinite Sizes）：单行 flex 容器若具有确定的交叉轴尺寸（`.pcm` 由 `position: fixed; inset: 0` 确定为 375px），则被 `stretch` 拉伸的 flex 子项的交叉轴尺寸（水平宽度）**也是确定的（definite = 375px）**。
  - 再往下，`.mainstrip` 是 `display: block`（确定宽 375px），`.strip-scroll` 是块级 `display: flex`（`width: auto`），按 CSS 2.1 §10.3.3 填满包含块宽度 375px，且本身具有 `overflow-x: auto`（滚动容器不向父级传递内部溢出的 `min-content` 宽度）。
- **风险点**：整条链条中，`.editor`、`.pane-default`、`.mainstrip`、`.strip-scroll` **没有任何一环显式写 `width: 100%` 或 `max-width: 100%`**，且 `.editor`、`.pane-default`、`.mainstrip` 的 `overflow` 全是 `visible`，只有最顶层 `.pcm` 写了 `overflow: hidden`。一旦 WebKit 在多层 `column flex → block → row flex` 嵌套中把某一环的 `width: auto` 当成由内容决定（`max-content`），`.strip-scroll` 的 `clientWidth` 就会被撑成内容总宽（例如 N=1 时为 `455px`），超出的 `80px` 被顶层 `.pcm` 的 `overflow: hidden` 静默裁掉，页面上看不出横条越界，但此时 `clientWidth == scrollWidth == 455`，可滚距离为 `0`。

### 3. `.strip-scroll` 内容总宽公式与 N=1 / 2 / 5 核算

`.strip-scroll`（`ThumbStrip.tsx:153-181`，全树继承 `mobile.css:42` 的 `.pcm * { box-sizing: border-box }`）内部直接子项按 DOM 顺序依次为：

1. `.sp-l`（`mobile.css:158`）：`flex: none; width: calc(50% - 46px); margin: 0`
2. `.madd`（`mobile.css:161`）：`flex: none; width: 40px; height: 64px; margin-right: 6px` → 占主轴总宽 $40 + 6 = 46\text{px}$
3. $N$ 张 `.mblock`（`mobile.css:163`）：`flex: none; width: 80px; height: 64px; border: 2px solid transparent; margin: 0`（`border-box` 下外宽即 $80\text{px}$）→ 共占 $80N\text{px}$
4. $(N - 1)$ 个 `.mark`（`mobile.css:171`，当 $N \ge 1$ 时）：`flex: none; width: 24px; height: 24px; margin: 0 3px` → 每个占主轴总宽 $24 + 3 + 3 = 30\text{px}$，共占 $30(N - 1)\text{px}$
5. `.sp-r`（`mobile.css:159`）：`flex: none; width: 50%; margin: 0`

因此，设 `.strip-scroll` 内容盒宽度为 $W$（当视口宽为 $375\text{px}$ 且左右 `padding` 为 `0` 时，$W = 375\text{px}$），内容总宽通式为：

$$\text{TotalWidth}(N) = W_{\text{sp-l}} + 46 + 80N + 30(N - 1) + W_{\text{sp-r}} = W_{\text{sp-l}} + W_{\text{sp-r}} + 110N + 16 \quad (N \ge 1)$$

### 4. 百分比两种解析方式各自的算数结果与现象对照

在既是 flex 容器又是滚动容器的 `.strip-scroll` 中，`.sp-l`（`width: calc(50% - 46px)`）和 `.sp-r`（`width: 50%`）的百分比按规范（CSS Flexbox §9.2 / §9.8 及 CSS Box Sizing 3 §5.2）应相对于 flex 容器自身的内容盒主轴宽度 $W = 375\text{px}$ 解析；若浏览器在计算可滚动 flex 容器子项尺寸时将容器宽度视为不确定（indefinite），百分比会回退为 `auto`（空 `<div />` 下即为 `0px`）。两种解析结果对比如下：

#### 解析方式一：按 `clientWidth = 375px` 正常解析（规范与无头 Chrome 行为）
- $W_{\text{sp-l}} = 0.5 \times 375 - 46 = 187.5 - 46 = 141.5\text{px}$（使得 `.sp-l` + `.madd` = $141.5 + 46 = 187.5\text{px} = 50\%$，当 `scrollLeft = 0` 时第 1 张 `.mblock` 左边缘恰好对准 `left: 50%` 的 `.cf-line` 白线）
- $W_{\text{sp-r}} = 0.5 \times 375 = 187.5\text{px}$
- 内容总宽公式：
  $$\text{Total}_{\text{正常}}(N) = 141.5 + 46 + 80N + 30(N - 1) + 187.5 = 375 + 110N - 30 = 345 + 110N$$
- 可滚距离 $\text{scrollWidth} - \text{clientWidth} = (375 + 110N - 30) - 375 = 110N - 30$：
  - **$N = 1$**：$141.5 + 46 + 80\times 1 + 30\times 0 + 187.5 = \mathbf{455\text{px}}$，与 `clientWidth = 375` 比较得可滚距离 $455 - 375 = \mathbf{80\text{px}}$（恰好等于无头 Chrome 实测的 `clientWidth 375 / scrollWidth 455`）。
  - **$N = 2$**：$141.5 + 46 + 80\times 2 + 30\times 1 + 187.5 = \mathbf{565\text{px}}$，可滚距离 $565 - 375 = \mathbf{190\text{px}}$。
  - **$N = 5$**：$141.5 + 46 + 80\times 5 + 30\times 4 + 187.5 = \mathbf{895\text{px}}$，可滚距离 $895 - 375 = \mathbf{520\text{px}}$。

#### 解析方式二：百分比被当成不确定而塌缩为 `0`（或尾随 `.sp-r` 未计入 `scrollWidth`）
- **子情形 2A（`.sp-l` 与 `.sp-r` 均塌成 `0px`）**：
  - $W_{\text{sp-l}} = 0\text{px}$，$W_{\text{sp-r}} = 0\text{px}$
  - 内容总宽公式：
    $$\text{Total}_{\text{塌缩}}(N) = 0 + 46 + 80N + 30(N - 1) + 0 = 110N + 16$$
  - 与 `clientWidth = 375px` 比较：
    - **$N = 1$**：$0 + 46 + 80\times 1 + 0 + 0 = \mathbf{126\text{px}} < 375\text{px}$ → `scrollWidth = 375px`，可滚距离为 **$0\text{px}$（完全不可滚）**。
    - **$N = 2$**：$0 + 46 + 80\times 2 + 30\times 1 + 0 = \mathbf{236\text{px}} < 375\text{px}$ → `scrollWidth = 375px`，可滚距离为 **$0\text{px}$（完全不可滚）**。
    - **$N = 3$**：$0 + 46 + 80\times 3 + 30\times 2 + 0 = \mathbf{346\text{px}} < 375\text{px}$ → `scrollWidth = 375px`，可滚距离为 **$0\text{px}$（完全不可滚）**。
    - **$N = 5$**：$0 + 46 + 80\times 5 + 30\times 4 + 0 = \mathbf{566\text{px}} > 375\text{px}$ → `scrollWidth = 566px`，可滚距离缩水为 $191\text{px}$（比正常 $520\text{px}$ 少了 $329\text{px}$）。
  - **更重要的是，在 `ThumbStrip.tsx:60` 的 `scrollForPos` 中**：
    ```ts
    return bl[i].offsetLeft + f * bl[i].offsetWidth - el.clientWidth / 2;
    ```
    一旦 `.sp-l` 塌成 `0px`，第 1 张卡片 `bl[0].offsetLeft` 从正常的 `187.5px` 变成 `46px`（仅剩 `.madd` 的 `40 + 6`）。在整个第 1 段播放期间（$i = 0, 0 \le f \le 1$，例如从 `00:00.0` 播到 `00:05.7 / 00:06.0`），算出的目标滚动值 `want = 46 + 80 * f - 187.5` 恒在 `[-141.5, -61.5]` 之间（**恒为负数**）！即便 $N \ge 4$ 使容器有可滚距离，赋给 `el.scrollLeft = want` 的负数也会被浏览器直接钳制回 `0`，表现就是「播放到 00:05.7 / 00:06.0 时内容完全不动，`scrollLeft` 永远停在 0」。
  - **主 Agent 当场判别证据（看截图或问用户即可验证）**：如果 `.sp-l` 塌成了 `0px`，还会伴随一个极其明显的视觉特征——**「＋添加素材」按钮和第 1 张缩略卡会紧贴屏幕最左侧（`x = 0..126px`），而正中央 `left: 50%`（`187.5px`）那条 `.cf-line` 白线在初始静止时根本对不上第 1 张卡的左边缘**（N=1 时白线悬在卡片右侧的空白处；N≥2 时白线初始就压在第 2 张卡上）。
- **子情形 2B（`.sp-l` 正常占 `141.5px`，但尾随的 `.sp-r` 未计入 `scrollWidth`）**：
  - 此时第 1 张卡左边缘仍在 `141.5 + 46 = 187.5px`（**初始静止时白线正对第 1 张卡起点 0，视觉完全正常**），但内容右边缘停在最后一张 `.mblock` 的右端：$187.5 + 110N - 30 = 157.5 + 110N$。
  - **$N = 1$**：右边缘为 $187.5 + 80 = \mathbf{267.5\text{px}} < 375\text{px}$ → `scrollWidth = 375px == clientWidth`，**可滚距离为 `0px`，手指划不动、`el.scrollLeft = want` 也被钳回 `0`**！
  - **$N = 2$**：右边缘为 $0.5W + 190\text{px}$。在 $W = 375\text{px}$ 上为 $377.5\text{px}$（仅 `2.5px` 可滚，肉眼不动）；在 iPhone 12/13/14（$W = 390\text{px}$）、iPhone 15/16（$W = 393\text{px}$）、Pro Max（$W = 430\text{px}$）上，因 $0.5W \ge 195\text{px} > 190\text{px}$，右边缘 $\le W$，**可滚距离同样是严格的 `0px`**！

---

## 嫌疑属性与依据

按「**证实** / **高度怀疑但未证实** / **已排除**」三档逐条归类如下：

### 1. `.sp-l` / `.sp-r` 的百分比宽度在「既是 flex 容器又是滚动容器」里的解析（`mobile.css:158-159`）
- **档位**：**高度怀疑但未证实（头号嫌疑 A）**
- **依据**：
  - `src/mobile/mobile.css:158-159` 写的是：
    ```css
    .pcm .sp-l { flex: none; width: calc(50% - 46px); }
    .pcm .sp-r { flex: none; width: 50%; }
    ```
  - `flex: none` 等价于 `flex: 0 0 auto`，即 `flex-basis: auto`，主轴基准尺寸回退去读 `width`。`.strip-scroll` 同时是 `display: flex` 和 `overflow-x: auto`，且自身未写显式 `width: 100%`。在 WebKit 历史上，可滚动 flex 容器在固有尺寸（intrinsic size）阶段对子项百分比 `width`（尤其含 `calc(50% - 46px)`）的解析曾出现回退为 `auto`（空盒即 `0px`）的缺陷。如上一节算数所示，只要 `.sp-l` / `.sp-r` 解析为 `0`，N=1/2/3 时内容总宽（126 / 236 / 346px）均小于 375px，`scrollWidth == clientWidth == 375`，且第 1 段内 `scrollForPos` 算出的 `want < 0`，手势与程序赋值同时锁死在 `0`。
- **具体改法（前后对照）**：将百分比换成不依赖父滚动容器内容盒二阶段解析的 `50vw`（因为 `.strip-scroll` 横向占满全屏视口，`50%` 恒等于 `50vw`），并显式写进 `flex-basis`：
  ```css
  /* 现在（src/mobile/mobile.css:158-159） */
  .pcm .sp-l { flex: none; width: calc(50% - 46px); }
  .pcm .sp-r { flex: none; width: 50%; }

  /* 改成 */
  .pcm .sp-l { flex: 0 0 calc(50vw - 46px); width: calc(50vw - 46px); height: 1px; }
  .pcm .sp-r { flex: 0 0 50vw; width: 50vw; height: 1px; }
  ```

### 2. `.sp-l` / `.sp-r` 是无 `height` 的空盒，且 `.strip-scroll` 设了 `align-items: center` 导致其高度为 `0`（`mobile.css:154,158-159`）
- **档位**：**高度怀疑但未证实（头号嫌疑 B，与用户现象「白线初始在 0 但滚不动」完美吻合）**
- **依据**：
  - `src/mobile/ThumbStrip.tsx:153,181` 中 `<div className="sp-l" />` 和 `<div className="sp-r" />` 是完全空的标签，且 `mobile.css:158-159` 没写 `height`。
  - 父容器 `.strip-scroll`（`mobile.css:154`）写了 `align-items: center`（覆盖了默认的 `stretch`）。因此在交叉轴（竖向）上，`.sp-l` 和 `.sp-r` 不会被拉伸，它们的计算高度是 **`height: 0px`**。
  - 在 WebKit 的滚动溢出矩形合并逻辑中（`LayoutRect::unite` 对 `isEmpty()` 即 `width <= 0 || height <= 0` 的矩形直接早退忽略），位于 flex 行首的 `.sp-l` 虽然高为 `0`，但因它把后续高 `64px` 的 `.madd` 和 `.mblock` 推到了 `x = 187.5px`，所以首卡左边缘依然对准 `left: 50%` 的白线；然而位于 flex **最末尾**的 `.sp-r`（`x = 267.5..455px`，`height = 0px`）后面再无任何非空元素，一旦 WebKit 因 `height == 0`（或 flex 尾随空盒怪癖）未将 `.sp-r` 并入 `scrollWidth`，则 N=1 时内容右边界停在首卡右缘 `267.5px < 375px`，N=2 在主流 iPhone（390/393/430px 屏宽）上右缘 `0.5W + 190 <= W`，导致 `scrollWidth == clientWidth`、可滚距离为 `0`！
- **具体改法（前后对照）**：给 `.sp-l` 和 `.sp-r` 补上 `height: 1px`（或 `align-self: stretch`），消除 `0` 高度空矩形：
  ```css
  /* 现在（src/mobile/mobile.css:158-159） */
  .pcm .sp-l { flex: none; width: calc(50% - 46px); }
  .pcm .sp-r { flex: none; width: 50%; }

  /* 改成 */
  .pcm .sp-l { flex: 0 0 calc(50vw - 46px); width: calc(50vw - 46px); height: 1px; }
  .pcm .sp-r { flex: 0 0 50vw; width: 50vw; height: 1px; }
  ```

### 3. `overflow-x: auto` 配 `overflow-y: hidden` 在 WebKit 上的行为（`mobile.css:154`）
- **档位**：**高度怀疑但未证实（手势与滚动层嫌疑）**
- **依据**：
  - `src/mobile/mobile.css:154` 写了：
    ```css
    .pcm .strip-scroll { display: flex; align-items: center; overflow-x: auto; overflow-y: hidden; ... padding: 6px 0 10px; min-height: 80px; ... }
    ```
  - `.strip-scroll` 只设了 `min-height: 80px`（无明确 `height: 80px`），而子项 `.madd` / `.mblock` 高度为 `64px`，加上上下 `padding` `6px + 10px = 16px` 恰好等于 `80px`，本来就没有竖向溢出。在 iOS Safari / WebKit 上，`overflow-x: auto` 搭配 `overflow-y: hidden`（尤其容器仅有 `min-height` 而无确定 `height`）曾多次触发原生横滑手势识别锁死或滚动层创建异常。
  - 不过单靠手势识别异常解释不了「播放时程序设 `el.scrollLeft = want` 也不动」，除非 WebKit 在该组合下同时影响了滚动范围计算；因此通过复现页变体 B 单独验证。
- **具体改法（前后对照）**：去掉不必要的 `overflow-y: hidden`，并将 `min-height: 80px` 明确为 `height: 80px; position: relative`（同时修正 `ThumbStrip.tsx:48,60` 中 `.mblock.offsetLeft` 的 `offsetParent` 指向 `.strip-scroll` 自身而非外层 `.mainstrip`）：
  ```css
  /* 现在（src/mobile/mobile.css:154） */
  .pcm .strip-scroll { display: flex; align-items: center; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; padding: 6px 0 10px; min-height: 80px; touch-action: pan-x; overscroll-behavior-x: contain; user-select: none; -webkit-user-select: none; }

  /* 改成 */
  .pcm .strip-scroll { position: relative; width: 100%; height: 80px; display: flex; align-items: center; overflow-x: auto; scrollbar-width: none; padding: 6px 0 10px; touch-action: pan-x; overscroll-behavior-x: contain; user-select: none; -webkit-user-select: none; }
  ```

### 4. flex 子项默认 `min-width: auto` 让容器被内容撑开（`mobile.css:103,136,140,154`）
- **档位**：**按规范已排除，但作为 WebKit 跨层宽度传递的防御项列入变体 D 候验**
- **依据**：
  - 如「结构与 CSS 链条」第 2 小节所证，`.pcm`（`mobile.css:37`）、`.editor`（`mobile.css:103`）、`.pane-default`（`mobile.css:136`）的 **`flex-direction` 全是 `column`（主轴竖向）**。CSS Flexbox §4.5 的 `min-width: auto` 仅对 `row` 主轴生效；在 `column` 主轴下，水平方向是交叉轴，受 `align-items: stretch` 约束为父容器宽度 375px。
  - 同时 `.mainstrip`（`mobile.css:140`）是 `display: block`，`.strip-scroll` 不是 flex 子项，且 `.strip-scroll` 自身有 `overflow-x: auto`（按规范滚动容器自动最小尺寸为 `0`）。因此在标准规范与 Chromium 下，这条**不成立**。
  - 但由于 `.pane-default`、`.mainstrip`、`.strip-scroll` 均未写显式 `width: 100%; min-width: 0`，为彻底排除 WebKit 在多层嵌套下把某一环退化为 `max-content`（撑成 455px），可在 CSS 中显式收口。
- **具体改法（前后对照）**：
  ```css
  /* 现在（src/mobile/mobile.css:136,140） */
  .pcm .pane-default { flex: none; display: flex; flex-direction: column; }
  .pcm .mainstrip { flex: none; position: relative; }

  /* 改成 */
  .pcm .pane-default { flex: none; width: 100%; min-width: 0; display: flex; flex-direction: column; }
  .pcm .mainstrip { flex: none; width: 100%; min-width: 0; position: relative; }
  ```

### 5. 祖先上的 `contain` / `transform` 造成滚动容器或白线包含块错位
- **档位**：**已排除（证实排除）**
- **依据**：
  - 逐行核查 `src/index.css`、`src/skins/skins.css` 与 `src/mobile/mobile.css`，从 `html` → `body` → `#root` → `.pcm` → `.editor` → `.pane-default` → `.mainstrip` → `.strip-scroll` 整条祖先链上，**没有任何节点设置 `contain`、`transform`、`perspective`、`filter`、`backdrop-filter` 或 `will-change`**（`mobile.css` 里的 `transform` / `backdrop-filter` 仅出现在兄弟分支 `.sbtn`、`.ruler span`、`.sheet`、`.toast` 上）。
  - 而且 `.cf-line`（`mobile.css:160`）是 `position: absolute; left: 50%`（不是 `fixed`），其包含块就是紧邻的父元素 `.mainstrip`（`mobile.css:140` `position: relative`），包含块关系完全正确。
- **具体改法**：无需改动。

### 6. `.pcm` 的 `position: fixed; inset: 0` 与 `overscroll-behavior: none` 在 iOS 上（`mobile.css:37,40`）
- **档位**：**已排除（不是 `.strip-scroll` 不可滚的直接原因，但 `overflow: hidden` 会掩盖子容器横向撑宽）**
- **依据**：
  - `src/mobile/mobile.css:37,40` 在 `.pcm` 上设了 `position: fixed; inset: 0; overflow: hidden; overscroll-behavior: none;`。
  - 在 iOS Safari 上，`position: fixed; inset: 0` 将 `.pcm` 锁死在布局视口尺寸，同处 `.pcm` 内的 `.subnav`（`mobile.css:176`）和 `.tl-scroll`（`mobile.css:202`）说明 `fixed` 祖先并不会禁止内部子滚动容器的 `scrollLeft` 编程赋值。
  - `overscroll-behavior: none`（Safari 16+ 支持）只抑制滚动到边界后的橡皮筋/滚动链传递，绝不会影响 `scrollWidth` 几何尺寸或阻断 JS 设置 `el.scrollLeft = want`。
  - 唯一要注意的副作用是：`.pcm` 的 `overflow: hidden` 会在子容器意外撑宽到 455px 时把超出视口的 80px 静默裁掉，使肉眼看不出越界。
- **具体改法**：无需改动 `.pcm` 根规则。

### 7. `.strip-scroll` 上的 `touch-action: pan-x` 与 `overscroll-behavior-x: contain`（`mobile.css:154`）
- **档位**：**已排除（不是整条不可滚的原因）**
- **依据**：
  - `src/mobile/mobile.css:154` 在 `.strip-scroll` 上设置了 `touch-action: pan-x; overscroll-behavior-x: contain;`。
  - 这两个 CSS 属性**只作用于触屏手势阶段**（告知浏览器允许水平原生平移手势、禁止滑到头触发 Safari 侧滑返回），**完全不参与盒模型宽高布局计算，更不可能阻止 JS 在 `useLayoutEffect`（`ThumbStrip.tsx:69`）中执行 `el.scrollLeft = want`**。
  - 用户报的第 2 条现象明确指出「播放时时间码走到 00:05.7 / 00:06.0，条里内容仍停在 0」，证明连纯 JS 赋值 `el.scrollLeft = want` 都没生效，因此根因必然是几何上 `scrollWidth <= clientWidth`（或滚动层未建立），而非 `touch-action: pan-x` 或 `overscroll-behavior-x: contain`。
- **具体改法**：无需删除 `touch-action: pan-x; overscroll-behavior-x: contain`。

---

## 复现页

### 1. 文件路径与打开方式
- **路径**：`docs/reports/strip-css-repro.html`（单文件、零外部依赖、无任何网络请求或外部字体/脚本）。
- **怎么用**：把该 `.html` 文件通过 AirDrop / 文件 App / 局域网静态地址发到 **iPhone 真机**，直接用 **Safari** 打开即可运行（不需要起后端服务）。
- **重点看哪几个数字**：
  1. 每个变体上方的 **`clientWidth`**、**`scrollWidth`**、**`可滚距离 (scrollWidth - clientWidth)`**（大于 0 标绿，小于等于 0 标红）；
  2. **`sp-l(宽×高)`** 与 **`sp-r(宽×高)`** 的实测值，以及 **`首卡offsetLeft`**（375 屏宽下正常应为 `141.5×0`、`187.5×0`、`首卡offsetLeft: 188`；若宽变成 `0` 或首卡 `offsetLeft` 变成 `46`，直接坐实百分比塌缩）；
  3. 点击每个变体的 **「程序推 scrollLeft」** 按钮（或顶部 **「一键测试全部 scrollLeft」**），看右侧黄/绿/红字显示的 **「设入: X → 同步读回: Y / 下一帧读回: Z」** 是否弹回 `0`，再用手在条上左右划测试惯性滑动。
  4. 顶部可切换 **片段数 `N=1 (默认 455)` / `N=2 (565)` / `N=5 (895)`**。

### 2. 六个变体 A～F 对照说明
- **变体 A（原样基线）**：未改任何 CSS，原样照搬 `mobile.css`；用于确认在 iPhone Safari 上复现「不可滚 / 推不动」，并直接读出此时 `clientWidth`、`scrollWidth`、`sp-l`、`sp-r` 的真机数值。
- **变体 B（去掉 `overflow-y: hidden`，只留 `overflow-x: auto`）**：将 `.strip-scroll` 的 `overflow-y: hidden` 改为 `visible`；若 A 不能滚而 B 能滚，说明元凶是 WebKit 下 `overflow-x: auto` 配 `overflow-y: hidden` 锁死了横向滚动层。
- **变体 C（`.sp-l` / `.sp-r` 百分比换成固定 `px` 并加 `height: 1px`）**：把 `.sp-l` / `.sp-r` 的百分比换成按视口算出的固定像素值并设 `height: 1px`；若 A 的 `scrollWidth <= clientWidth` 而 C 能滚，说明元凶是 `.sp-l` / `.sp-r` 的百分比或 0 高度空盒在 WebKit 下未生效。
- **变体 D（给 `.pane-default` / `.mainstrip` / `.strip-scroll` 加 `width: 100%; min-width: 0; max-width: 100%`，子项加 `min-width: 0; flex-shrink: 0`）**：显式锁死祖先链宽度；若 A 的 `clientWidth` 被撑成 `455` 而 D 的 `clientWidth` 回到视口宽（如 `375`）且能滚，说明元凶是祖先链缺少显式宽度收口被内容撑开。
- **变体 E（保留 `50%` 百分比，但改用 `flex: 0 0 calc(50% - 46px)` / `flex: 0 0 50%` 并给 `.sp-l` / `.sp-r` 加 `height: 1px`）**：保留百分比但消除 `align-items: center` 下的 `0px` 高度空矩形；若 E 能滚而 A 不能滚，说明元凶正是 `.sp-l` / `.sp-r` 因无 `height` 变成 `0` 高度空盒（或 `width` vs `flex-basis`）被 WebKit 忽略了尾随滚动溢出。
- **变体 F（综合修复：`width: 100%; min-width: 0` + 去 `overflow-y: hidden` + `height: 80px; position: relative` + `.sp-l` / `.sp-r` 用 `50vw` 与 `height: 1px`）**：合并全部修复项；用于验证最终推荐改法在真机上手势与程序 `scrollLeft` 均 100% 正常。

### 3. 复现页与真实界面的两处不一致（真机测试必读）
1. **默认开启了整页竖向滚动（`.pcm.allow-page-scroll`）**：为了让一屏能上下滑动看完全部 6 个变体，复现页初始给 `.pcm` 挂了 `allow-page-scroll` 类，把真实的 `overflow: hidden` 改成了 `overflow-y: auto; overflow-x: hidden`，同时把 `.editor` 从 `flex: 1` 改成了 `flex: none`。这与真实产品的 `.pcm { overflow: hidden }` 和 `.editor { flex: 1 }` 不一致。**因此在真机上打开后，必须按一下页顶的「切为严格 .pcm overflow:hidden」按钮，在严格原样模式下再读一次变体 A/B/C 的数字**。
2. **未抄入 `.topbar` / `.preview-area`（舞台） / `.transport` 等兄弟节点**：复现页在 `.editor` 里只放了 `.pane-default`，没有放顶栏、预览舞台（带 `aspect-ratio` 和 `flex: 1; min-height: 0`）和播放控制条。因此，**凡是涉及「iOS Safari 动态视口把可用高度压扁、兄弟节点挤压 `.pane-default` 竖向高度」这一类和高度相关的假设，这个复现页无法验证**。

---

## 没能证实的部分

### 1. 受环境限制未能证实的部分
本轮排查在 Windows 环境下进行，手头没有 iPhone 真机，且按任务边界不得启动任何浏览器或本地服务。因此：
- 以上分析只能从 CSS 规范与 WebKit 已知行为推导出导致 `scrollWidth <= clientWidth` 的具体几何路径，**无法在本地断定 iPhone Safari 真机上实际发生的是「`.sp-l`/`.sp-r` 百分比塌成 0」、「`.sp-r` 因 `height: 0` 尾随空盒未被计入 `scrollWidth`」、「祖先链 `clientWidth` 被撑成 455」还是「`overflow-y: hidden` 锁死滚动层」中的哪唯一一条**。

### 2. 真机唯一钉死元凶的判别流程
在真机 iPhone Safari 上打开 `docs/reports/strip-css-repro.html`，先点顶部 **「切为严格 .pcm overflow:hidden」**，再按以下决策树看 **变体 A** 的数字即可唯一锁定：

1. **第一步：看变体 A 的 `可滚距离 (scrollWidth - clientWidth)`**
   - **情况 1：变体 A 的 `可滚距离 <= 0`（几何上不可滚）** → 进入**第二步**看具体数字：
     - **分支 1a**：若 `clientWidth` 等于视口宽（如 `375` / `390`），且 **`sp-l` / `sp-r` 的宽为 `0`**（同时 `首卡offsetLeft` 为 `46`）
       → **钉死元凶：可滚动 flex 容器内 `.sp-l` / `.sp-r` 百分比宽度解析塌缩为 0**。看变体 C 和 F 必然可滚，按「嫌疑 1」将百分比改为 `calc(50vw - 46px)` / `50vw` 即可修复。
     - **分支 1b**：若 `clientWidth` 等于视口宽（如 `375` / `390`），**`sp-l` 的宽正常（如 `141.5`）、`首卡offsetLeft` 正常（如 `188`），但 `scrollWidth` 仍等于 `clientWidth`**，且 **变体 E（补了 `height: 1px` + `flex-basis`）的可滚距离恢复为 `80` 且能滚**
       → **钉死元凶：`align-items: center` 下 `.sp-r` 高度为 `0px`，被 WebKit 忽略了尾随空盒的滚动溢出**。按「嫌疑 2」给 `.sp-l` / `.sp-r` 加 `height: 1px` 和显式 `flex-basis` 即可修复。
     - **分支 1c**：若变体 A 的 **`clientWidth` 被撑大到了 `455`（`clientWidth == scrollWidth == 455`）**，而 **变体 D 的 `clientWidth` 回到视口宽 `375` 且能滚**
       → **钉死元凶：祖先链（`.pane-default` / `.mainstrip` / `.strip-scroll`）缺少显式 `width: 100%; min-width: 0` 被内容撑成 `max-content`**。按「嫌疑 4」给祖先链补 `width: 100%; min-width: 0` 即可修复。
   - **情况 2：变体 A 的 `可滚距离 > 0`（如 `clientWidth: 375, scrollWidth: 455, 可滚距离: 80`）** → 进入**第三步**：
     - 点变体 A 的 **「程序推 scrollLeft」**：
       - **分支 2a**：若变体 A 读回值弹回 `0`，而 **变体 B（去掉 `overflow-y: hidden`）读回成功且手指能划**
         → **钉死元凶：WebKit 下 `overflow-x: auto` 配 `overflow-y: hidden` 锁死滚动层**。按「嫌疑 3」去掉 `overflow-y: hidden` 并设 `height: 80px` 即可修复。
       - **分支 2b**：若变体 A 在复现页里点「程序推 scrollLeft」和手指横划**全都正常能动**
         → **说明纯 CSS/盒模型在 iPhone Safari 上本来就是可滚的**，真实产品里「手指划不动 + 播放时停在 0」的根因不在静态 CSS 布局，而在另外两路排查的 **React 生命周期 / `onScroll` 与 `useLayoutEffect` 循环写回 `onScrub(0)` / 指针事件拦截**（或是本复现页未包含的舞台兄弟节点高度挤压）。

### 3. 顺带发现的细节问题（仅记录，未动手改代码）
- **`ThumbStrip.tsx:48,60` 中 `bl[i].offsetLeft` 的参照系（`offsetParent`）隐式依赖外层 `.mainstrip`**：
  `.strip-scroll`（`mobile.css:154`）没有设置 `position: relative`，而它的父元素 `.mainstrip`（`mobile.css:140`）设置了 `position: relative`。因此 `.mblock` 的 `offsetParent` 实际上是外层的 `.mainstrip` 而不是滚动容器 `.strip-scroll` 自身。虽然目前 `.strip-scroll` 左起于 `.mainstrip` 的 `0` 点，建议在修 `.strip-scroll` 时顺手加上 `position: relative`，使 `bl[i].offsetLeft` 的参照系严格绑定在滚动容器自身上。
