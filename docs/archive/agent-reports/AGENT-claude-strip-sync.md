# AGENT-claude-strip-sync

分支 `claude/strip-sync`。只查一件事：手机版缩略时间轴（`src/mobile/ThumbStrip.tsx`）**同步逻辑本身**
为什么在「1 段、6 秒、卡片段」的项目上不跟着当前时间走。

本路只读分析为主，可改的文件只有 `src/mobile/ThumbStrip.tsx` 和为它新建的测试文件；CSS 和别的组件由另两路负责，本路不碰。

---

## 1. 五个问题的逐条真实读数

### 问题 1：`cardPosAtTime(clips, t)` 在 1 段 `{start: 0, end: 6}` 下的返回值与连续性

直接调用 `src/mobile/mainContent.ts` 第 202~210 行的 `cardPosAtTime(clips, t)`（`clips = [{ id: 'c1', cardId: 'card-1', start: 0, end: 6, params: {} }]`）：

| `t`（秒） | 走哪条分支（`mainContent.ts:206-209`） | `pos = cardPosAtTime(clips, t)` 精确值 |
|---|---|---|
| `0` | `t < c.end - 1e-9` → `0 + (0 - 0) / 6` | `0` |
| `1` | `t < c.end - 1e-9` → `0 + (1 - 0) / 6` | `0.16666666666666666`（即 `1/6`） |
| `3` | `t < c.end - 1e-9` → `0 + (3 - 0) / 6` | `0.5` |
| `5.7` | `t < c.end - 1e-9` → `0 + (5.7 - 0) / 6` | `0.9500000000000001`（即 `19/20`） |
| `6` | 循环结束返回 `clips.length` | `1` |

- **是否从 0 连续走到 1**：是。在 `t ∈ [0, 6 - 1e-9)` 上，`pos(t) = t / 6` 严格线性单调递增；在 `t ∈ [6 - 1e-9, 6]` 上返回 `clips.length = 1`。
- **`t = 6` 端点是否有跳变**：没有跳变。
  - 左极限采样 `t = 6 - 2e-9` 时，`pos = 0.9999999996666666`；
  - 阈值点 `t = 6 - 1e-9` 时，`pos = 1`；
  - 端点 `t = 6` 时，`pos = 1`；
  - 跨越 `6 - 1e-9` 时的差值仅为 `(1e-9) / 6 ≈ 1.6667e-10`（实测 `pos(6) - pos(6 - 2e-9) = 3.33333360913457e-10`），两端完全衔接在 `1`。

---

### 问题 2：`scrollForPos(pos)` 与 `posFromScroll()` 在只有 1 张 `.mblock` 时的几何与返回值（`W = 390`）

按给定的 `.strip-scroll` 子元素几何参数（容器宽 `W = clientWidth`，左右内边距 `0`，`box-sizing: border-box`）：

1. **各子元素水平布局与容器滚动范围（1 段，无 `.mark`）**：
   - `.sp-l`：宽 `W/2 - 46`，占 `[0, W/2 - 46)`；当 `W = 390` 时宽 **`149` px**，占 `[0, 149)`。
   - `.madd`：宽 `40` px + `margin-right: 6` px = **`46` px**，占 `[W/2 - 46, W/2)`；当 `W = 390` 时占 `[149, 195)`。
   - `bl[0]`（唯一的 `.mblock`）：
     - **`bl[0].offsetLeft = (W/2 - 46) + 40 + 6 = W / 2`**；当 `W = 390` 时 **`offsetLeft = 195` px**。
     - **`bl[0].offsetWidth = 80` px**（占 `[195, 275)`）。
   - `.sp-r`：宽 `W/2`；当 `W = 390` 时宽 **`195` px**，占 `[275, 470)`。
   - **`scrollWidth`** = `(W/2 - 46) + 46 + 80 + W/2 = W + 80`；当 `W = 390` 时 **`scrollWidth = 470` px**。
   - **`scrollLeft` 最大值（`maxScrollLeft = scrollWidth - clientWidth`）** = `(W + 80) - W = 80` px；当 `W = 390` 时 **`maxScrollLeft = 80` px**（与 `W` 无关，恒为 `80` px）。

2. **`want(pos) = scrollForPos(pos)`（`ThumbStrip.tsx:54-61`）的表达式与端点值**：
   - 当 `bl.length === 1` 且 `pos ∈ [0, 1]` 时：
     - `i = Math.min(Math.floor(pos), 0) = 0`
     - `f = pos >= 1 ? 1 : pos - 0 = pos`
     - `want(pos) = bl[0].offsetLeft + pos * bl[0].offsetWidth - el.clientWidth / 2 = (W / 2) + 80 * pos - (W / 2) = 80 * pos`
   - 代入 `W = 390` 时，`195 + 80 * pos - 195 = 80 * pos`，各采样时刻读数：
     - `t = 0`（`pos = 0`）：**`want = 0` px**
     - `t = 1`（`pos = 1/6`）：**`want = 13.333333333333343` px**（`80 / 6`）
     - `t = 3`（`pos = 0.5`）：**`want = 40` px**
     - `t = 5.7`（`pos = 0.95`）：**`want = 76` px**
     - `t = 6`（`pos = 1`）：**`want = 80` px**
   - **`pos` 从 `0` 走到 `1` 的总行程**：**`80` px**（从 `0` px 走到 `80` px，恰好等于 `maxScrollLeft = 80` px，全程不会撞到浏览器滚动上下限）。

3. **`posFromScroll()`（`ThumbStrip.tsx:43-53`）的表达式与来回一致性**：
   - `x = el.scrollLeft + W / 2`，`l = bl[0].offsetLeft = W / 2`，`r = l + 80 = W / 2 + 80`：
     - 当 `scrollLeft < 0`（`x < l`）时返回 **`0`**；
     - 当 `0 <= scrollLeft < 80`（`l <= x < r`）时返回 **`0 + (x - l) / 80 = scrollLeft / 80`**；
     - 当 `scrollLeft >= 80`（`x >= r`）时循环结束返回 `bl.length =` **`1`**。
   - **来回一致性**：对任意 `pos ∈ [0, 1]`，令 `el.scrollLeft = scrollForPos(pos) = 80 * pos`，再算 `posFromScroll()` 得 `(80 * pos) / 80 = pos`（`pos = 1` 时返回 `1`），往返误差 `< 1e-15`（完全互逆）。

---

### 问题 3：播放时 `useLayoutEffect`（`ThumbStrip.tsx:64-71`）到底跑没跑，以及 `if (Math.abs(el.scrollLeft - want) < 1) return;` 在真实 tick 频率下的读数

1. **播放时 `props.t` 的推进链路与 `useLayoutEffect` 是否真跑了（逐级核查）**：
   - **`ThumbStrip` 的 `props.t` 来源**：
     - `src/mobile/MobileEditor.tsx:66`：`const t = useStore((s) => s.t);` 从全局单例 store 订阅 `s.t`。
     - `src/mobile/MobileEditor.tsx:356-374`：当 `page === "preview"`（默认首页）时渲染 `<ThumbStrip project={project} clips={main} t={t} playing={playing} ... />`（`t` 在第 361 行传入）。
     - 同时，`src/mobile/MobileEditor.tsx:349` 的时间码 `<b data-pcm="tc-now">{fmtTc(t)}</b>` 渲染的是**同一个局部变量 `t`**。用户实测现象中「时间显示已经走到 `00:05.7 / 00:06.0`」，直接证明 `MobileEditor` 的 `t` 在播放期间持续更新并触发了重渲染。
   - **手机版 `page === "preview"` 时驱动时钟的 `<Preview>` 是否挂载**：
     - **确认已挂载**。`src/mobile/MobileEditor.tsx:328-334` 在组件顶层无条件渲染 `<div className="preview-area">...<Preview variant="mobile" />...</div>`（第 332 行）；即使切到 `page === "agent"` 也只是用 `opacity: 0; pointerEvents: "none"` 隐藏而不卸载（第 325~329 行注释与样式），在 `page === "preview"` 下更是直接可见挂载。
   - **store 里的 `s.t` 由谁推进、真实更新频率是多少**：
     - 用户点播放按钮（`src/mobile/MobileEditor.tsx:348`）调用 `actions.togglePlay()`（`src/store/actions/playback.ts:20-22`），将 `state.playing` 置为 `true`。
     - 在 `src/editor/Preview.tsx` 中，播放时钟有两条路径（按 `live = liveStage()`，`Preview.tsx:283`）：
       1. **墙钟 rAF 循环（`!live`，`src/editor/Preview.tsx:659-697`）**：第 666 行取 `const fps = Math.max(1, project.fps || 30)`；每次 `requestAnimationFrame` 回调 `tick`（第 675~692 行）累加连续墙钟时间 `acc += (now - last) / 1000`（第 682 行），然后经第 689 行 `wrote = atFrameGrid(acc, fps)`（定义于 `src/render/frameGrid.ts:25-29`：`Math.floor(sec * f + 1e-6) / f`）**按项目 `fps` 对齐到帧网格**，再在第 690 行调 `actions.tick(wrote)`（`src/store/actions/playback.ts:12-14`：`set({ t })` → `src/store/core.ts:80-84`）。虽然 rAF 按屏幕刷新率（60 Hz）跑，但在同一个帧格 `[k/fps, (k+1)/fps)` 内的多次 `actions.tick(wrote)` 写入的是**同一个数值**；`useStore` 底层的 `useSyncExternalStore`（`src/store/core.ts:429-437`）按 `Object.is` 比对快照，值没变不触发 React 重渲染。
       2. **可见舞台 K4 `frame` 事件（`live`，`src/editor/Preview.tsx:2037-2048`）**：可见舞台按项目 `fps` 节拍每渲染完一帧发一次 `frame` 事件，第 2047 行调 `actions.tick(e.sec)`。
     - 因此，无论走哪条路径，**`props.t` 的真实更新频率（即 `ThumbStrip` 重渲染并执行无依赖 `useLayoutEffect` 的频率）都是项目的 `fps`（默认 `30` fps，见 `src/kernel/project.ts`），而不是固定 60 Hz**。

2. **速度、分辨率与三档 `fps`（`60` / `30` / `24`）下的逐 tick 模拟读数（1 段 6 秒，总行程 `80` px）**：
   - **每秒移动像素**：`80 / 6 = 40 / 3 =` **`13.333333333333334` px/s**。
   - **1 像素对应的时间误差**：`6 / 80 = 3 / 40 =` **`0.075` 秒**（**`75` ms**）。
   - **为什么 `< 1` px 死区不会让它停在 0**：
     `ThumbStrip.tsx:68-70` 判断的是 `Math.abs(el.scrollLeft - want) < 1`。当某一个 tick 的增量不足 `1` px 而提前 `return` 时，**`el.scrollLeft` 保持上一次写入的值不变**，而 `want` 随 `props.t` 每个 tick 累加，几个 tick 后差值必然跨过 `1` px 触发写入：

| 档位 | 6 秒总 tick 数 | 每 tick 位移 `pxPerTick` | 跨过 `1` px 死区所需 tick 数 `ceil(1 / pxPerTick)` | 每次跳过死区的步长 `jumpPx` | 浮点 `scrollLeft`：6 秒写入次数 / 最终 `scrollLeft` | 整数 `scrollLeft`（`Math.round`）：6 秒写入次数 / 最终 `scrollLeft` |
|---|---|---|---|---|---|---|
| **`fps = 60`** | `360` | `2/9 ≈ 0.2222222222222222` px | 每 **`5`** 个 tick | `10/9 ≈ 1.1111111111111112` px | 写入 **`72`** 次 / 最终 **`80` px** | 写入 **`80`** 次 / 最终 **`80` px** |
| **`fps = 30`**（项目默认） | `180` | `4/9 ≈ 0.4444444444444444` px | 每 **`3`** 个 tick | `4/3 ≈ 1.3333333333333333` px | 写入 **`60`** 次 / 最终 **`80` px** | 写入 **`80`** 次 / 最终 **`80` px** |
| **`fps = 24`** | `144` | `5/9 ≈ 0.5555555555555556` px | 每 **`2`** 个 tick | `10/9 ≈ 1.1111111111111112` px | 写入 **`72`** 次 / 最终 **`80` px** | 写入 **`80`** 次 / 最终 **`80` px** |

   - 以项目默认的 **`fps = 30`** 为例：
     - Tick 1（`t = 1/30` s）：`want = 4/9 ≈ 0.4444` px，`|0 - 0.4444| < 1` → return，`scrollLeft = 0`；
     - Tick 2（`t = 2/30` s）：`want = 8/9 ≈ 0.8889` px，`|0 - 0.8889| < 1` → return，`scrollLeft = 0`；
     - **Tick 3（`t = 3/30 = 0.1` s）**：`want = 12/9 = 4/3 ≈ 1.3333` px，`|0 - 1.3333| >= 1` → **写入 `el.scrollLeft = 1.3333` px**；
     - 此后每 3 个 tick（每 `0.1` 秒）写入一次，180 个 tick 共写入 **`60` 次**，在第 180 个 tick（`t = 6.0` s）从第 177 个 tick 的 `78.6667` px 跳到 **`80` px**。
   - **对照组（3 段各 2 秒，中间 2 个 `.mark`，`W = 390`）**：
     - 3 张 `.mblock` 的 `offsetLeft` 依次为 **`[195, 305, 415]` px**，`scrollWidth = 690` px，`maxScrollLeft = 300` px，`want` 总行程 = **`300` px**。
     - 在 `fps = 60` 下每段每 tick 走 `2/3` px（每 2 tick 跳一次），360 ticks 共更新 **`180` 次**，最终 `scrollLeft =` **`300` px**；
     - 在 `fps = 30` 下每段每 tick 走 `4/3 ≈ 1.3333 >= 1` px（每个 tick 都跨过 `1` px 门限），180 ticks 共更新 **`180` 次**，最终 `scrollLeft =` **`300` px**。

---

### 问题 4：`dragging.current` 从 `onPointerDown`（第 85 行起）到 `end`（第 110 行起）的路径穷举与「`target` 节点中途被摘除」可达性核查

1. **常规事件路径检查（`src/mobile/ThumbStrip.tsx:85-139`）**：
   - 未触碰缩略条直接播放时，`dragging` 初值为 `useRef(false)`（`ThumbStrip.tsx:39`），`onPointerDown` 不触发，`dragging.current` 恒为 `false`。
   - `onPointerDown` 在第 100 行设置 `dragging.current = true` 后，第 101~135 行无任何提前 `return` 或可能抛错的调用，第 136~138 行无条件在 `window` 上注册 `pointermove`、`pointerup`、`pointercancel`。
   - `end`（第 110~135 行）在第 115 行无条件执行 `dragging.current = false;`（位于第 117~134 行一切 DOM 读取和 `onReorder` / `onSelect` 回调之前）。
   - 只来 `pointercancel` 没来 `pointerup`（如浏览器 `touch-action: pan-x` 接管原生横滑）：第 138 行挂了 `window.addEventListener("pointercancel", end)`，`end` 照常把 `dragging.current` 清为 `false`。
   - 多根手指同时按：因为 `end` 未按 `pointerId` 过滤，第一根手指抬起或取消时就会把所有已挂在 `window` 上的 `end` 一次性触发并卸载，只会让 `dragging.current` **提前变回 `false`**，不会卡在 `true`。

2. **重点核查：「`pointerdown` 的 `target` 元素在 `pointerup` 之前被从 DOM 树摘掉，导致 `pointerup` / `pointercancel` 不冒泡到 `window`、`end` 永不执行」在本组件里是否可达？**

   逐项核对 `ThumbStrip.tsx` 与 `MobileEditor.tsx` 的每一处 DOM 生成与状态变更：

   - **核查 A：`.mblock` 的 React `key`（`` `${c.id}@${c.start}` ``，`ThumbStrip.tsx:160`）在播放、拖动、seek、暂停期间会不会变？**
     - `ThumbStrip` 的 `clips` prop 来自 `MobileEditor.tsx:86`：`const main = useMemo(() => mainClipsOf(project), [project]);`（在第 360 行传给 `<ThumbStrip clips={main} />`）。
     - 播放推进（`actions.tick`，`src/store/actions/playback.ts:12-14`）、拖动时间轴跳转（`actions.seek`，`playback.ts:7-10`）、暂停/播放切换（`actions.pause` / `actions.togglePlay`，`playback.ts:17-22`）、点选片段（`actions.select`，`playback.ts:57-59`）都只改 `state.t`、`state.playing`、`state.playToken` 或 `state.selection`，**完全不改 `state.project` 引用**（`src/store/core.ts:80-84`）。因此 `MobileEditor.tsx:86` 的 `useMemo` 在播放和拖动期间连重算都不会发生，`clips` 始终是同一个数组引用。
     - 退一步看，即便 `mainClipsOf(project)`（`src/mobile/mainContent.ts:78-117`）重跑：它是只依赖 `project` 的纯函数，根本不读当前时间 `t`。对于「1 段 6 秒卡片段（`start: 0, end: 6`）」，第 1 步 `mainTrackClips(p)`（`mainContent.ts:52-68`）返回空数组 `[]`（卡片不是 `video | image | cut`，见第 32~35 行），第 2 步空档为 `gaps = [[0, 6]]`（第 91~97 行），补空档循环（第 99~115 行）调 `trimTo(best.c, 0, 6)`（第 71~76 行），因 `Math.abs(0 - c.start) < EPS && Math.abs(6 - c.end) < EPS`（第 72 行）原样返回 `c`，其 `c.start` 恒为 `0`。
     - 所以在播放、seek、暂停、单指滑动全过程中，`` `${c.id}@${c.start}` `` **绝对不变**，React 不会因 `key` 变化而摘除重建 `.mblock`。

   - **核查 B：选中/取消选中、内部子节点、打开面板（Sheet）、换顺序、删段会不会在手按着时摘掉被按住的元素？**
     - **选中 / 取消选中（`onSelect` → `selectClip`）**：
       1. 时机上：`ThumbStrip.tsx:127-133` 只在 `end` 内部（即 `pointerup` 已经到达 `window`、且第 115 行 `dragging.current = false` 已经执行完之后）才调 `props.onSelect(...)`；`pointerdown` 到 `pointerup` 之间根本不会触发 `onSelect`。
       2. 节点复用上：就算 `selected` 变化，`ThumbStrip.tsx:164`（`className={selected === c.id ? "mblock sel" : "mblock"}`）和 `ThumbStrip.tsx:176`（`className={selected === tr.id ? "mark has sel" : "mark has"}`）都只是在同一 `<div key={key}>` / `<button key={`m-${key}`}>` 上切换 `className` 字符串，React 仅原地改 DOM 的 `class` 属性，不卸载元素。
     - **`.mblock` 与 `.strip-scroll` 内部的所有子节点（`ThumbStrip.tsx:153-181, 194-202`）**：
       - `.sp-l`（第 153 行）、`.madd`（第 154 行）、`.sp-r`（第 181 行）均无条件渲染；
       - `BlockThumb`（第 194~202 行）：卡片段 `clip.cardId` 非空，第 195 行 `media` 恒为 `undefined`，永远只渲染 `<span className="kic"><Icon name="card" /></span>`（即便对视频/图片段，`src/mobile/Thumb.tsx:69-72` 的 `ThumbImg` 也始终渲染同一个 `<img>` 节点，仅用 `style={{ opacity: 0 }}` 控制显隐，不挂载/卸载节点）；
       - `<span className="no">`（第 171 行）与 `<span className="du">`（第 172 行）对卡片段恒定渲染。
     - **点 `＋`（`.madd`）或打开各类底部面板（Sheet）**：
       - `.madd` 的 `onClick={props.onAddMedia}`（`ThumbStrip.tsx:154`）和无转场 `.mark` 的 `onClick`（第 177 行）都是 `click` 事件，只在 `pointerup` 之后才触发；
       - 打开任何 Sheet（`MobileEditor.tsx:371-372, 410-420`）只改 `MobileEditor` 的 `sheet` state，各个 Sheet 作为兄弟节点挂在 `MobileEditor` 末尾（第 410~420 行），`page` 仍为 `"preview"`（第 356 行），`ThumbStrip` 及其内部节点完全不卸载、不重挂。
     - **换顺序 / 分割 / 删除片段**：
       - 换顺序 `props.onReorder(order)`（`ThumbStrip.tsx:126`）同样只在 `end` 内部（第 115 行 `dragging.current = false` 之后）调用；
       - 在 `page === "preview"` 页，子导航栏 `previewItems`（`MobileEditor.tsx:279`）只放 `[引用, 视频, 图片, 音频, 剪辑, 卡片, 文字]`，**根本没有「分割」「删除」按钮**（`clipTools` 里的分割/复制/删除只在 `page === "timeline"` 的 `timelineItems` 里渲染，见 `MobileEditor.tsx:261-280`）。

   - **核查 C：如果手按着 `ThumbStrip` 时切换分页（`page` 变）导致 `ThumbStrip` 自身卸载，第 136~138 行的三个 `window` 监听器怎么处理？**
     - `ThumbStrip.tsx:136-138` 在 `onPointerDown` 里直接调 `window.addEventListener("pointermove", mv)` / `pointerup` / `pointercancel`，**没有在 `useEffect` 卸载清理函数里移除它们**（第 102 行的 `timer` 也没有卸载清理）。
     - 如果用户在按住 `.strip-scroll` 的同时用另一根手指点底栏 `.pager`（`MobileEditor.tsx:404-408`）切走 `page`，`ThumbStrip` 卸载（`MobileEditor.tsx:356`），被按住的 DOM 节点脱离文档树。但这实际上**不会导致下次回到预览页时卡住 `dragging.current`**：
       1. 因为 `window` 上的 `end` 不按 `pointerId` 过滤，点 `.pager` 的那根手指抬起时的 `pointerup`（或页面上后续任何一次点击的 `pointerup`）冒泡到 `window` 时，就会当场触发残留的 `end`，执行 `window.removeEventListener` 把这三个监听器自己摘掉（在此之前属于短暂的监听器泄漏，记入第 5 节范围外发现）；
       2. 更关键的是：当用户切回 `page === "preview"` 时，React 挂载的是**全新的 `ThumbStrip` 实例**，第 39 行 `const dragging = useRef(false)` 创建的是全新的 ref 对象（初值 `false`），旧实例闭包里的 `dragging` 跟新实例完全隔离，绝不可能把新实例卡在 `true`。

   **结论（二选一）：「`target` 在 `pointerup` 前被摘除导致 `dragging.current` 永久卡在 `true`」这条路径在本组件单人播放与滑动场景下<u>不可达</u>**。加上第 1 条常规路径穷举，**在 `ThumbStrip.tsx` 中找不到任何会让 `dragging.current` 停在 `true` 再也不被清掉的可达路径**。

---

### 问题 5：`onScroll`（第 76~80 行）里的 `Math.abs(el.scrollLeft - progSl.current) < 1.5`

1. **1 段 6 秒时的滚动行程与手指滑动分辨率**：
   - 全程滚动行程：**`80` px**（`scrollLeft` 从 `0` 到 `80`）。
   - 手指滑动分辨率：**`1` px = `0.075` 秒（`75` ms）**，反过来 **`1` 秒 = `13.3333` px**。
   - `1.5` px 门限对应的时间跨度：**`1.5 × 0.075 = 0.1125` 秒（`112.5` ms）**，占 6 秒总长的 **`1.875%`**。

2. **什么条件下 `< 1.5` 的门会吞掉用户的真实滚动**：
   - 注意第 77~78 行：当 `Math.abs(el.scrollLeft - progSl.current) < 1.5` 提前 `return` 时，**`progSl.current` 不会被更新**，仍停留在上一次同步或上一次通过门限时的位置。
   - **会被吞掉的条件**：
     1. **整次极短点划的总位移 `< 1.5` px（`< 0.1125` 秒）**：如果手指全程只让 `el.scrollLeft` 变了例如 `1.0` px，则 `onScroll` 直接 return，不触发 `onScrub`；松手后若偏差在 `[1, 1.5)` px 之间，下一次渲染 `useLayoutEffect` 还会把 `el.scrollLeft` 拉回 `want`。
     2. **正常滑动开头的前 `1.5` px 与末尾不足 `1.5` px 的余量**：在连续滑动中，`scrollLeft` 从 `0` 变到 `1.0` px 的那次 `scroll` 事件会被吞掉；但紧接着滑到 `>= 1.5` px 时，因 `progSl.current` 仍为 `0`，`|el.scrollLeft - 0| >= 1.5` 立即放行，调用 `props.onScrub(...)` 并更新 `progSl.current`。

3. **能不能解释「手指划也不动」**：
   - **不能**。原因有二：
     1. 视觉上卡片跟不跟手指走，是由浏览器原生横滑（未选中时 `.strip-scroll` 的 `touch-action: pan-x`）或 `mv` 里的 `el.scrollLeft = sl0 - dx`（选中时/鼠标）直接改 `el.scrollLeft` 决定的；`onScroll` 只是在 `el.scrollLeft` **已经改变之后**再去反推时间调 `onScrub`。只要手指按着（`dragging.current === true`，`useLayoutEffect` 不插手），哪怕把 `onScroll` 整个删掉，只要容器本身能滚，缩略条在手指下照样会动。
     2. 数值上，一次正常手指横划动辄几十像素，远大于 `1.5` px 门限。

---

## 2. 结论：为什么同步不动？

### 本路结论：**本路没找到确凿的逻辑错误**

因此按照任务边界要求，**未修改 `src/mobile/ThumbStrip.tsx` 的任何一行代码**。

本路通过代码链路核查、纯函数算术推导与单元测试，**确凿排除了以下所有怀疑**：

1. **排除了「播放时 `<Preview>` 没挂载或 `useLayoutEffect` 没跑」的怀疑**：`MobileEditor.tsx:332` 常驻挂载 `<Preview variant="mobile" />`，播放时 `Preview.tsx` 按项目帧率 `fps`（默认 `30` fps）对齐帧格推进 `store.t`（`Preview.tsx:689-690, 2047`），`MobileEditor.tsx:66` 的 `t` 同时驱动 `00:05.7 / 00:06.0` 时间码（第 349 行）与 `ThumbStrip` 的 `props.t`（第 361 行），每次 `t` 变化 `ThumbStrip.tsx:64-71` 的无依赖 `useLayoutEffect` 必跑。
2. **排除了 `cardPosAtTime` / `timeAtCardPos` 在「1 段 6 秒卡片段」下的换算错误**：`pos` 从 `0` 严格线性走到 `1`，`t = 6` 端点平滑衔接无跳变。
3. **排除了 `scrollForPos` / `posFromScroll` 在「只有 1 张 `.mblock`」时的公式错误**：在标准几何（`offsetLeft = W/2 = 195`，`offsetWidth = 80`，`clientWidth = 390`）下，`want(pos) = 80 * pos`，从 `0` px 走到 `80` px，与 `maxScrollLeft = 80` px 严丝合缝，且往返反解完全一致。
4. **排除了 `useLayoutEffect` 中 `< 1` px 死区在 `60` / `30` / `24` fps 下把滚动卡死在 `0` 的怀疑**：因为提前 return 时 `el.scrollLeft` 不变而 `want` 随时间累加，`60` fps 下每 5 tick 跳 `1.111` px（共写 72 次）、项目默认 `30` fps 下每 3 tick 跳 `1.333` px（共写 60 次）、`24` fps 下每 2 tick 跳 `1.111` px（共写 72 次），三档最终 `scrollLeft` 全部精确走到 `80` px。
5. **排除了 `dragging.current` 卡死在 `true`（含 `target` 节点中途被从 DOM 摘掉）的怀疑**：播放与拖动期间 `project` 引用不变、`.mblock` 的 `key`（`${c.id}@${c.start}`）恒定不变，选中只改 `className`，打开 Sheet 不卸载 `ThumbStrip`，单人操作下不存在 `pointerdown` 与 `pointerup` 之间摘除 `target` 的可达路径。
6. **排除了 `onScroll` 中 `< 1.5` px 门限吞掉整次手指滑动的怀疑**：该门限仅滤除 `< 1.5` px（`0.1125` s）的微动，且不影响 `.strip-scroll` 自身的原生滚动位移。

---

### 猜测（标明是猜测，供跨路汇总验证）

既然同步算术与状态机本身无误，且无头 Chrome 同步正常、唯独 iOS Safari 同时出现「播放时停在 0」和「手指划也不动」两个现象，两个现象指向同一个底层事实：**在 iOS Safari 上，`.strip-scroll` 的实际可滚动行程 `maxScrollLeft = scrollWidth - clientWidth` 很可能等于 `0`（或 `el.scrollLeft` 写入被 WebKit 拒绝/归零），或者 `.mblock` 的 `offsetLeft` 在 WebKit 下读数异常**。

具体猜测如下：

1. **猜测 A（CSS / WebKit Flex 容器内百分比子项或容器宽度塌缩/撑开，导致 `scrollWidth <= clientWidth`）**：
   - 在 1 段项目中，`.strip-scroll` 之所以能有 `80` px 的滚动行程，完全依赖左右两个垫片 `.sp-l`（`width: calc(50% - 46px); flex-shrink: 0`）和 `.sp-r`（`width: 50%; flex-shrink: 0`）把 `scrollWidth` 撑到 `W + 80`。
   - 如果在 iOS Safari 下：
     - 要么 `.strip-scroll` 的父级 flex/grid 链条没有限制住宽度（缺 `min-width: 0` 或 `width: 100%`），导致 `.strip-scroll` 被子元素直接撑宽到 `clientWidth === scrollWidth`；
     - 要么 WebKit 对 `overflow-x: auto` flex 容器内的 `width: 50%` / `calc(50% - 46px)` 解析出与 Chrome 不同的尺寸；
   - 一旦 `scrollWidth <= clientWidth`（即 `maxScrollLeft === 0`），浏览器会把任何 `el.scrollLeft = want` 强制钳制回 `0`，同时用户手指横划也因为没有溢出内容而完全划不动——**这一个原因能同时解释「播放停在 0」和「手指划不动」**。
   - **怎么验证**：在 iOS Safari（或 WebKit 探针）里读取 `const el = document.querySelector('.strip-scroll')`，打印 `{ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, spL: el.querySelector('.sp-l').offsetWidth, spR: el.querySelector('.sp-r').offsetWidth, mblockLeft: el.querySelector('.mblock').offsetLeft }`。看 `scrollWidth - clientWidth` 是不是 `80`，以及 `mblockLeft` 是不是 `clientWidth / 2`。

2. **猜测 B（`.strip-scroll` 未设 `position: relative`，导致 `bl[0].offsetLeft` 的 `offsetParent` 外溢）**：
   - `scrollForPos` 与 `posFromScroll` 用的是 `bl[i].offsetLeft`。DOM 规范中 `offsetLeft` 相对于最近的定位祖先（`offsetParent`）。如果 `.strip-scroll` 没有 `position: relative`，`offsetParent` 会落到外层的 `.mainstrip` 甚至更外层。虽然这单独不会让手指原生横滑失效，但若外层有偏移会影响计算。
   - **怎么验证**：在浏览器里看 `document.querySelector('.mblock').offsetParent === document.querySelector('.strip-scroll')` 是否为 `true`。

---

## 3. `npm test -- src/mobile/stripSync.test.mjs` 的完整输出

```text
> promptcut@0.7.26 test
> node scripts/test-suite.mjs src/mobile/stripSync.test.mjs

[SS1] 1段6秒 (W=390) 几何与采样读数: {
  offsetLeft: 195,
  offsetWidth: 80,
  scrollWidth: 470,
  maxScrollLeft: 80,
  readings: [
    { t: 0, pos: 0, want: 0 },
    { t: 1, pos: 0.16666666666666666, want: 13.333333333333343 },
    { t: 3, pos: 0.5, want: 40 },
    { t: 5.7, pos: 0.9500000000000001, want: 76 },
    { t: 6, pos: 1, want: 80 }
  ]
}
[SS1] t=6 端点左极限与端点值: {
  't=6-2e-9': 0.9999999996666666,
  't=6-1e-9': 1,
  't=6': 1,
  diff: 3.33333360913457e-10
}
[SS2] 1段6秒 速度与分辨率读数: {
  totalTravelPx: 80,
  pxPerSec: 13.333333333333334,
  pxPerTick60: 0.2222222222222222,
  pxPerTick30: 0.4444444444444444,
  pxPerTick24: 0.5555555555555556,
  secPerPx: 0.075,
  secPer1_5Px: 0.1125
}
[SS3] 1段6秒 三档 fps (60 / 30 / 24) 模拟结果: {
  r60: {
    fps: 60,
    totalTicks: 360,
    pxPerTick: 0.2222222222222222,
    ticksPerJump: 5,
    jumpPx: 1.1111111111111112,
    floatScrollLeft: {
      finalScrollLeft: 80,
      updateCount: 72,
      firstUpdates: 'tick=5(t=0.0833s)->sl=1.1111, tick=10(t=0.1667s)->sl=2.2222, tick=15(t=0.2500s)->sl=3.3333, tick=20(t=0.3333s)->sl=4.4444'
    },
    intScrollLeft: { finalScrollLeft: 80, updateCount: 80 }
  },
  r30: {
    fps: 30,
    totalTicks: 180,
    pxPerTick: 0.4444444444444444,
    ticksPerJump: 3,
    jumpPx: 1.3333333333333333,
    floatScrollLeft: {
      finalScrollLeft: 80,
      updateCount: 60,
      firstUpdates: 'tick=3(t=0.1000s)->sl=1.3333, tick=6(t=0.2000s)->sl=2.6667, tick=9(t=0.3000s)->sl=4.0000, tick=12(t=0.4000s)->sl=5.3333'
    },
    intScrollLeft: { finalScrollLeft: 80, updateCount: 80 }
  },
  r24: {
    fps: 24,
    totalTicks: 144,
    pxPerTick: 0.5555555555555556,
    ticksPerJump: 2,
    jumpPx: 1.1111111111111112,
    floatScrollLeft: {
      finalScrollLeft: 80,
      updateCount: 72,
      firstUpdates: 'tick=2(t=0.0833s)->sl=1.1111, tick=4(t=0.1667s)->sl=2.2222, tick=6(t=0.2500s)->sl=3.3333, tick=8(t=0.3333s)->sl=4.4444'
    },
    intScrollLeft: { finalScrollLeft: 80, updateCount: 80 }
  }
}
[SS4] 3段各2秒对照组 (W=390) 模拟结果: {
  blockOffsets: [ 195, 305, 415 ],
  scrollWidth: 690,
  maxScrollLeft: 300,
  totalTravelPx: 300,
  fps60: { finalScrollLeft: 300, updateCount: 180 },
  fps30: { finalScrollLeft: 300, updateCount: 180 }
}
[SS5] 1段6秒 scrollForPos <-> posFromScroll 往返读数: [
  { pos: 0, want: 0, posBack: 0, tFromPos: 0, tBack: 0 },
  {
    pos: 0.01,
    want: 0.8000000000000114,
    posBack: 0.010000000000000142,
    tFromPos: 0.06,
    tBack: 0.06000000000000086
  },
  {
    pos: 0.16666666666666666,
    want: 13.333333333333343,
    posBack: 0.1666666666666668,
    tFromPos: 1,
    tBack: 1.0000000000000009
  },
  { pos: 0.25, want: 20, posBack: 0.25, tFromPos: 1.5, tBack: 1.5 },
  { pos: 0.5, want: 40, posBack: 0.5, tFromPos: 3, tBack: 3 },
  { pos: 0.75, want: 60, posBack: 0.75, tFromPos: 4.5, tBack: 4.5 },
  {
    pos: 0.95,
    want: 76,
    posBack: 0.95,
    tFromPos: 5.699999999999999,
    tBack: 5.699999999999999
  },
  { pos: 1, want: 80, posBack: 1, tFromPos: 6, tBack: 6 }
]
[SS5] onScroll 1.5px 门限验证: { progSlAfter1_5px: 1.5, scrubbedTimeAt1_5px: 0.11249999999999999 }
✔ SS1 1 段 6 秒卡片：t = 0 / 1 / 3 / 5.7 / 6 的 pos 与 want（W = 390）及端点连续性 (1.3855ms)
✔ SS2 want 总行程、每秒速度、60/30/24 fps 每 tick 位移与 1px 时间误差（1 段 6 秒） (0.1978ms)
✔ SS3 播放模拟循环（1 段 6 秒，fps = 60 / 30 / 24 三档）：验证 < 1 死区下每档最终 scrollLeft (0.8219ms)
✔ SS4 对照组：3 段各 2 秒（中间两个 .mark）在 60fps 与 30fps 下跑满 6 秒 (0.6617ms)
✔ SS5 posFromScroll 与 scrollForPos 来回一致性（1 段 6 秒）与 onScroll 1.5px 门限验证 (0.4051ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 120.7653
✓ npm test 最终结果：零失败
```

---

## 4. `ThumbStrip.tsx` 修改前后对照

本路未发现 `ThumbStrip.tsx` 存在导致「1 段 6 秒卡片不滚」的确凿逻辑错误，按规则**未修改 `src/mobile/ThumbStrip.tsx`**（无改前/改后差异）。

---

## 5. 范围外发现（看到但没动的问题）

1. **多段项目（`clips.length >= 2`）在段间 `.mark`（30 px 宽）处的跳变与死区（`ThumbStrip.tsx:48-50, 58-60`）**：
   - `scrollForPos(pos)` 在 `pos` 从 `1 - ε` 跨到 `1`（第 1 段末尾到第 2 段开头）时，`want` 从 `bl[0].offsetLeft + 80 - W/2`（`80` px）直接跳到 `bl[1].offsetLeft - W/2`（`110` px），中间跨过 `.mark` 的 `30` px（播放到段边界时缩略条会瞬移跳过 `.mark`）。
   - 反过来用户手动滚过 `.mark` 的这 `30` px 区间（`scrollLeft ∈ [80, 110)`）时，`posFromScroll()` 因 `x < bl[1].offsetLeft` 恒返回整数 `1`，即这 `30` px 内时间停在下一段开头不动。
2. **`ThumbStrip.tsx:73-83` 挂 `scroll` 事件的 `useEffect` 没有依赖数组**：
   - 播放时组件按项目 `fps`（如 30 次/秒）重渲染，每次渲染都会执行 `removeEventListener("scroll", onScroll)` 再 `addEventListener("scroll", onScroll)`。虽然不影响功能，但产生无谓的监听器拆装。
3. **`ThumbStrip.tsx:102, 136-138` 的 `pointermove` / `pointerup` / `pointercancel` 与长按 `timer` 未按 `pointerId` 过滤，且无组件卸载清理**：
   - 多根手指先后按下时，任意一根手指抬起就会把所有监听器卸掉并把 `dragging.current` 设为 `false`，在单指操作下无碍，但多指触控下会提前打断当前手势。
   - 如果手指按住 `.strip-scroll` 期间组件被卸载（例如另一根手指点底栏切到别的分页），`window` 上的 `mv`、`end` 和 `timer` 不会在卸载时立即清理，要等到下一次任意 `pointerup` / `pointercancel` 冒泡到 `window` 时才自清理（但新挂载的 `ThumbStrip` 拥有全新的 `useRef(false)`，不会被旧实例污染）。
4. **多人协作 / 后台 Agent 并发改项目时的理论极端竞态（`ThumbStrip.tsx:100-138, 160`）**：
   - 若用户手指正按在某张 `.mblock` 上尚未抬起，恰在同一时刻远端协作者或后台 Agent 通过同步改了该段的 `start`（使 `key = ${c.id}@${c.start}` 改变）或删掉了该段，React 会摘掉被按住的旧 DOM 节点；此时该手指抬起不会冒泡到 `window`，`dragging.current` 会停在 `true` 直到用户下一次触屏点击触发 `window` 上的 `end` 为止。在单人播放/拖动场景下不可达。
