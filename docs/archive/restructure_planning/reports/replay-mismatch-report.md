# 整帧导出 vs HTML 快照重放 保真度调查

分支：`worktree-agent-a86dc5e354f604912`
起点：`eec7a08`（已 `git merge --ff-only main`，无冲突；期间 main 又走到 `1e71401`，只改了一个 md，代码等同）
提交：`b3596f9`（空的占位提交）、`7d623f4`（修复）
dev server：`npx vite --port 5271 --strictPort --host 127.0.0.1`（舞台端口 5272 / 5273）

---

## 1. 复现

`PC_FRAME_TEST_URL=http://127.0.0.1:5271 node scripts/verify-unified-frames.mjs`
→ 前面全过，最后一条 `export must exactly match see_frames` 断言失败。与任务书一致。

## 2. 根因（已证实）

**不是帧窗规划、不是挂载提前量、不是热身帧。是 Motion 的 JS 帧循环在快照那条路上根本没被推动。**

### 2.1 这张卡的两种动画，定住的办法不一样

`punch-pill` 的药丸上有两条动画：

| 属性 | 由谁驱动 | 导出里怎么定住 |
|---|---|---|
| `opacity` 0→1 | Motion 交给 WAAPI（`document.getAnimations()` 里看得见，`endTime` 750） | `__pcSyncAnims()` 每帧显式钉 `currentTime`，`getComputedStyle` 立刻反映 |
| `scale` 0.6→1（spring 300 / 15 / 0.8） | Motion **自己的 JS 帧循环**，每拍把 `style.transform = scale(x)` 写进 inline style | **没有任何东西钉它** |

实测 `a.effect.getKeyframes()`：药丸那条 WAAPI 动画的关键帧里只有 `opacity`，没有 `transform`。光晕（`absolute inset-0`）也一样：WAAPI 只管 opacity，`scale 0.8→1.5` 走 JS 帧循环。

### 2.2 两条路推帧时药丸的 inline transform（10 fps，修复前）

用 `bakeFrames` 的 `onProgress` 钩子在每帧 `step()` 之后读（两条路跑同一个导出页）：

```
帧 0 ms=  0  scale(0.6)
帧 1 ms=100  scale(0.933311)
帧 2 ms=200  scale(0.933311)   ← 弹簧解析解 1.06778
帧 3 ms=300  scale(0.933311)   ← 解析解 1.00368
…
帧 9 ms=900  scale(0.933311)
```

**两条路一模一样** —— `step()` 跑完之后 DOM 里的 transform 从第 1 帧起就再也不动。

### 2.3 分歧发生在 `step()` 之后：只有「真的画一帧」才推得动 Motion

`server/bakery/bake.mjs` 的 `renderPass` 里一帧的顺序是：

```
step(i)                   推时间、排空、__pcSyncAnims 钉 WAAPI 动画
  ↓
__pcCreateSnapshot()      HTML 快照在这里生成  ← 拿到的是上面那份陈旧 DOM
  ↓
shoot() → captureFrame()  整帧路在这里截图（beginFrame({ screenshot })）
```

实测（帧 3，ms=300）：

```
读 DOM 之后                      inline = scale(0.933311)
captureFrame(prime:false) 画出来 = 320x180   inline = scale(0.933311)
captureFrame(prime:true)  画出来 = 316x144   inline = scale(1.00368)   ← 变了
```

再从页面里直接读 Motion 自己的 `frameData`（`http://127.0.0.1:5271/node_modules/.vite/deps/motion_react.js?v=…`，
和页面同一个模块实例）：

```
帧1 step 后            frameData.timestamp=100  performance.now()=100  inline=scale(0.933311)
      +普通 beginFrame  frameData.timestamp=100  performance.now()=100  inline=scale(0.933311)
帧2 step 后            frameData.timestamp=100  performance.now()=200  inline=scale(0.933311)
      +普通 beginFrame  frameData.timestamp=100  performance.now()=200  inline=scale(0.933311)
      +手动跑一拍批处理  frameData.timestamp=200                          inline=scale(1.06778)  ← 正确值
```

**不是 rAF 没跑**：自己在页面里挂一个 `__pcRealRaf` 死循环，普通 `beginFrame` 一样让它计数 +1（3 次 → +3）。
是 Motion 的批处理没被调度到。能推动它的只有**带截图的 beginFrame**：

```
什么都不做                                2.3 ms/帧   冻住
beginFrame()                              2.7 ms/帧   冻住
beginFrame() x3                           3.7 ms/帧   冻住
beginFrame({noDisplayUpdates})            3.2 ms/帧   冻住
先制造 DOM damage 再 beginFrame()          3.4 ms/帧   冻住
beginFrame({screenshot jpeg q0})         18.5 ms/帧   ✅ 每帧都是正确弹簧值
beginFrame({noDisplayUpdates,screenshot}) 20.7 ms/帧   ✅
```
（1920×1080，含读值的 CDP 往返。）

Motion 的批处理用的是被 `exportClock` 钉住的 `performance.now()`（= `__pcExportMs`），
所以**跑一拍就落在这一帧的正确相位上**，多跑几拍也是同一个值（幂等）。30 fps 下量到的逐帧值
`0.66498 0.80288 0.93331 1.02319 1.06536 1.06778 1.04914 1.02392 1.00368 0.99169 0.98766 0.98925`
正是 stiffness 300 / damping 15 / mass 0.8 的弹簧曲线。

### 2.4 于是

- **整帧路**每帧都截图 → 每帧推一拍 → DOM 始终是当前帧 → 画面正确；
- **快照路**在截图**之前**生成快照 → 拿到上一次画帧时写下的旧值；
  纯采样的 `snapshotOnly` 一趟里一张图都不截 → **整段冻在第 1 帧的相位上**。

影响面比这张卡大得多：**整条快照路线上，任何由 Motion 的 JS 帧循环驱动的动画
（spring、MotionValue）都是冻住的**。WAAPI 那部分（opacity、tween 的 transform）因为
`__pcSyncAnims` 显式钉住，一直是对的，所以这条一直没被发现。

### 2.5 肉眼核对（两张图都存出来看过）

10 fps 第 8 帧（不带视频、透明底），不透明包围盒：

| | 包围盒 | 含义 |
|---|---|---|
| 顺序整帧导出 | 314×144 | scale ≈ 1.0（弹簧已收） |
| HTML 快照重放 | 294×134 | scale = 0.933311（第 1 帧的相位） |

第 2 帧更明显：导出 320×154（overshoot 1.0675，正确），快照仍是 294×134。
图在 `scratchpad/pix-out/`（`live-02/08.png`、`snap-02/08.png`）。

### 2.6 30 fps 下的量级（用户的真实项目）

修复前，30 fps 的药丸 inline transform 冻在**第 1 帧 = ms 33.3 的值 `scale(0.66498)`**，
之后整段不动；真值应当走到 `0.80288 → 0.93331 → 1.02319 → 1.06536 → 1.06778 → … → 1.0`。
也就是说 30 fps 下这张卡在快照路上**整段小了约 33%**（10 fps 是 7%，帧率越高冻得越早、错得越狠）。
60 fps 会冻在 ms 16.7 上，更靠前。

修复后，30 fps 逐帧 DOM 值和解析解完全吻合（§2.3 的 12 帧数列就是 30 fps 量的）。

## 3. 哪条路是对的

**整帧顺序导出是对的。** 它画出来的每一帧都精确落在弹簧解析解上（2.3 的数列），
也和编辑台里活渲一致（那边是真 rAF，Motion 正常跑）。HTML 快照路是错的。

## 4. 修法（已落地，`7d623f4`）

`server/bakery/bake.mjs`，+22 行，只改一个文件：

```js
const FLUSH_SHOT = { format: 'jpeg', quality: 0 };
const flushFrameLoop = () => beginFrame({ screenshot: FLUSH_SHOT });
```

在**两处** `window.__pcCreateSnapshot()` 调用之前各加一句 `await flushFrameLoop();`：
`renderPass` 里的快照分支，和 `shoot()` 的 HTML 分支。图立刻丢掉，只为让 Motion 跑一拍。

**为什么这样改不动导出基线**：整帧导出（`fullFrame`，无 `onSnapshot` / `domCache`）
根本不走 `__pcCreateSnapshot`，所以一步也不多走 —— 这一点由代码结构保证，也由 4.1 的逐字节对账验证。

## 5. 验收结果

| 项 | 结果 |
|---|---|
| **导出像素基线逐字节** | ✅ **60/60 逐字节相同** |
| `scripts/verify-unified-frames.mjs` | ❌ 仍在最后一条断言（**但原因已换成另一件事**，见 §6） |
| `scripts/verify-bake-protocol.mjs` | ✅ PASS（25 个 `window.__*` 全在文档两栏里） |
| `scripts/verify-export-frame-content.mjs` | ✅ PASS（GPU canvas 保留、六帧整场景视频、稀疏红/蓝 seek） |
| `npx tsc -b --force` | ✅ 0 错误 |
| `npm test` | ✅ 1572 / pass 1571 / fail 0 / skipped 1（和 main 基线一致） |

### 5.1 导出基线对账怎么跑的

照 `scripts/probes/export-baseline-compare.mjs` 的做法：

- 基线树：`git worktree add --detach <...>/.claude/worktrees/baseline-a86dc5e35 main`。
  **没建 junction、没 npm ci** —— worktree 放在 `PromptCut/.claude/worktrees/` 下面，
  Node 解析 `node_modules` 时自己往上走就找到 `PromptCut/node_modules`。
  （先试过放 scratchpad，那里往上走不到仓库，`Cannot find package 'puppeteer'`，已改正。）
- 素材：ffmpeg `testsrc2=s=640x360:r=30:d=3`，两棵树的 `out/media` 各一份。
- 项目：640×360 / 30 fps / 2 s / 60 帧，punch-pill（弹簧+毛玻璃）+ checklist + 一段视频。
- 两趟都打同一个 dev server 5271（我只改了 `server/bakery/bake.mjs` 这一个 Node 侧文件，
  页面 bundle 两边完全相同，`git diff --stat` 可证）。
- 结果：`逐字节:相同 60/60` → `✅ 全长导出逐字节相同`。
- 跑完 `git worktree remove --force`，目录和 `git worktree list` 都确认删干净了。

### 5.2 verify-unified-frames 最后一条断言：从「错成另一张图」缩到「抗锯齿量级」

把断言换成打印差值（临时脚本，没留在仓库里）：

```
修复前（任务书里的数）   不同通道 65607   >2 级 63070   （药丸整个大小不同）
修复后                  不同通道 27080   >2 级    15   最大 7
```

修复后 >2 级的 15 个通道分布：差 3 的 8 个、差 4 的 1 个、差 5 的 3 个、差 7 的 3 个，
全部落在光晕（`filter: blur(32px)`）的软边上，坐标 `(27,34) (26,35) (302,44) (2,83) (2,87) (2,88) (15,132) (17,135) (302,135)`。

## 6. 还剩一件事：毛玻璃的亚像素残差（**另一个根因，按任务书第 5 条停手**）

> **2026-09-23 更正**：本节把残差归到「重放丢 1/64 px」，第二轮重查发现**主因是合成层**——活渲时光晕挂着
> current 的透明度动画、被 Chrome 单独提层，快照写死 `animation:none` 后这一层没了；1/64 px 是真的，但排第二。
> 修法已落地，见 §12。下面 6.1 / 6.2 保留原文。

### 6.1 证据

同一个 bakery、同一趟里，整帧截图 vs 同一帧快照重放（10 fps，无视频）：

| 卡片 | 最大通道差 |
|---|---|
| `checklist`（没有 `filter`） | **3**（纯抗锯齿） |
| `punch-pill`（`filter: blur(32px)`） | 18 ~ 255 |

排除的可能：
- **不是快照容器**。给 `#pc-frame-snapshot` 分别加固定尺寸 / `overflow:hidden` / `contain:paint` /
  `isolation:isolate`，四种都和现状**逐字节完全一样**（不同通道 64164，一个数都没动）。
- **是重放时重新排版掉了 1/64 px**。把光晕元素的计算样式逐条对比（活渲 vs 快照挂回去之后），
  只有这几条不同：

```
width:       活渲=316.156px | 快照=316.141px
inline-size: 活渲=316.156px | 快照=316.141px
perspective-origin: 158.078px | 158.062px
__rect(宽):  252.92498779296875 | 252.91250610351562
app-region / transition-property（无关）
```

`getComputedStyle().width` 只给 3 位小数（`316.156px`），而真实布局是 `316.15625px`（= 20234/64）。
回灌 `316.156px` 后 Chrome 落到 1/64 网格的下一格 `316.140625px`，**差 1/64 px**。
`snapshotStyleProps.mjs` 的 `LAYOUT_USED_VALUE_PROPS` 明确把 `width/height` 按使用值内联，
这是设计如此。

这 1/64 px 对硬边元素是看不见的（checklist 最大差 3），但 `blur(32px)` 对它**极其敏感**：
反向实验——在**活渲页**里把药丸宽度钉成 `316.141px`（其余不动），画出来和原活渲差
**50995 个通道、最大 177**。也就是说 1/64 px 的几何漂移能让这块毛玻璃差出上百级。
（我另试过在快照里把宽度改回 `316.15625px`，结果一个数都没变，这个反证还没做实；
如实记在这里，**不要把「改宽度就能修好」当成已验证的结论**。）

### 6.2 三个修法和代价

1. **几何按全精度内联**（改 `src/render/snapshot/inlineStyles.ts`）：
   `width/height/top/left/...` 不用 `getComputedStyle` 的 3 位小数，改用
   `getBoundingClientRect()`（双精度）或把值对齐到 1/64 网格再写。
   - 代价：**改的是快照的生产方式**。`inlineStyles.ts` 在 `SNAPSHOT_FILES` 里，
     指纹一变**全世界的共享快照作废**；而且 rect 是**变换后的边框盒**，
     和 `width` 的盒模型口径不是一回事，要逐个属性重新对账，牵连很大。
2. **让毛玻璃别这么敏感**：只是回避，不是修（比如把 blur 元素的尺寸吸附到整数像素）。
   - 代价：会改变活渲的画面，等于改产品外观，不可取。
3. **放宽这条断言**：`verify-unified-frames.mjs` 最后一条从「逐字节相同」改成
   「最大通道差 ≤ N」，并在脚本里写明这条残差的出处。
   - 代价：以后真出现小幅相位错位就抓不到了。可以折中成「>2 级的通道数 ≤ 20」这种
     既能挡住相位错位、又放过抗锯齿的口径。

**没动手**：1 属于任务书第 5 条点名的「要改快照的生产方式」，3 是验收口径的事，都该由你定。

## 7. 会不会让已有的共享快照失效

**会，而且是应该的。** `server/bakery/bake.mjs` 在 `server/frame-code.mjs` 的
`BAKERY_FILES` 里，`SNAPSHOT_FILES = [...BAKERY_FILES, …]`，所以 `snapshotCode()` 指纹变了
→ 共享快照键变了 → 旧快照自然失效、不会被错误复用。这正是这次要的效果：
**旧快照里所有 JS 帧循环驱动的动画都冻在第一帧，本来就不能再用。**

## 8. 代价：快照路变慢

1920×1080、60 帧（punch-pill + checklist），同一台机、同一个 dev server：

| 路径 | 修复前 | 修复后 |
|---|---|---|
| 纯采样 `snapshotOnly` | 23.6 ms/帧 | 44.2 ms/帧（+87%） |
| 预渲染式 `fullFrame` + `onSnapshot` | 43.8 ms/帧 | 73.9 ms/帧（+69%） |

整帧导出（不生成快照）一分不多付，已由 §5.1 的逐字节对账证实。

两条还没做的省法，供你取舍：

- **`fullFrame` + `onSnapshot` 这条路本来每帧就画一次**（`shoot()`）。把快照挪到 `shoot()`
  **之后**、再调一次 `__pcHideFrameMedia()` 补回「素材已隐藏」这个前提，就能白拿那一拍，
  省掉这条路上全部额外开销。风险：`prepareFrameMedia` 在中间把 `<video>` 装回来过，
  要确认 `__pcHideFrameMedia` 幂等、且快照内容和现在逐字节相同。
- **页面里同步跑一拍 Motion 的批处理**（`motion` 公开导出的 `frameData` / `frameSteps`），
  几乎 0 开销，实测能算出正确值。风险：绕开 `processBatch` 会把 `runNextFrame` 这个闭包
  变量永久置真，Motion 自己的 rAF 自调度从此不再启动 —— 导出页全程由我们驱动没问题，
  但活渲舞台页共用同一份代码，得分开装。属于「动确定性的根基」，没敢在这一轮动。

## 9. 没做成的事

- （2026-09-23：已在 §12 修完、整条通过。）`verify-unified-frames.mjs` 仍未整条通过 —— 卡在 §6 的毛玻璃亚像素残差上，
  和本次根因无关，按任务书第 5 条停手待你定夺。
- §6.1 里「把快照的宽度改回 316.15625px」那个正向验证没做成（改了之后像素一个都没变，
  怀疑是我的注入没生效），所以「1/64 px 就是全部原因」只到「强相关」，没到「已证实」。
- 30 fps 的整帧 vs 快照逐像素对账**跑了**（同一 bakery、320×180、无视频、punch-pill、30 帧），
  修复后仍有毛玻璃残差，且早几帧（画面上只有光晕、药丸还是全透明）最大通道差到 255；
  中后段回到 12 ~ 64。这就是 §6 那一件事在 30 fps 下的样子，不是相位错位
  （DOM 逐帧值已对上解析解）。这张卡是 `blur(32px)` 盖满透明底的极端例子，
  verify 脚本里垫上视频之后同一帧只剩最大 7。

## 10. main 的位置

开工时 `git merge --ff-only main` 拿到 `eec7a08`。这期间 main 又往前走了（R3 那一批：
`586fd02 / 1e71401 / 7194834 / 7bda056 / 52952da / 2986755`，动的是 `StageView` /
`FrameScene` / `Stage` / `pinAnimations` / 素材层搬家）。
**`server/bakery/bake.mjs` 在那几个提交里一个字都没动**（`git log eec7a08..main -- server/bakery/bake.mjs` 为空），
所以这次的修复合并进去不会冲突。本分支的验收都是在 `eec7a08` 这条线上跑的。

## 11. 边界

只改了 `server/bakery/bake.mjs`。`src/StageView.tsx`、`src/render/FrameScene.tsx`、
`src/render/Stage.tsx`、`src/render/stageClock.ts`、`src/render/pinAnimations.ts`、`src/editor/**`
一个字都没动。

---

## 12. 第二轮（2026-09-23）：根因二重查、两处修法落地，脚本整条通过

分支：`claude/wonderful-mayer-blc7xr`；起点 `d2fdafe`。
环境：云端 Linux 容器（4 核）、puppeteer 自带的 chrome-headless-shell、dev server 5203（`.claude/launch.json` 的 dev-test，
舞台端口 5204 / 5205）。容器里是 root，Chrome 要带 `PC_CHROME_ARGS="--no-sandbox"` 才起得来。
用户选的修法：**补合成层 + 对齐 1/64**，根因一没修全的那条路**这次一起修**。

### 12.1 §6 的判断要改：主因是合成层，1/64 px 排第二

复现：`verify-unified-frames.mjs` 最后一条断言红。这台机器的字体下药丸（`Unified`）宽 **352.125px** ——
在 1/64 网格上、6 位有效数字能原样写回，**1/64 px 的丢失在这里根本不存在**，快照重放照样对不上
（无视频、透明底：第 8 帧 30626 个通道不同、最大 14；第 2 / 5 帧最大 30 / 33）。

同一个 bakery、同一拍：活渲整帧 vs 快照重放，逐项替换快照里的值看像素（第 8 帧）：

| 改法 | 不同通道 / 最大差 |
|---|---|
| 原样 | 30626 / 14 |
| transform 换成全精度（Typed OM `toMatrix()`） | 不变 |
| opacity、transform-origin 换成全精度 | 不变 |
| 光晕加 `will-change: transform` | 3055 / 14 |
| 光晕和药丸都加 `will-change: transform, opacity` | 3630 / 59 |
| **光晕加 `will-change: opacity`** | **0（逐字节相同）** |

CDP `LayerTree.compositingReasons` 读活渲页：光晕那一层的合成原因是 **`ActiveOpacityAnimation`**。
Motion 把透明度交给 WAAPI，`__pcSyncAnims` 把它钉住（暂停），**暂停的动画仍然是 current**，
Blink 照样给它单独提一层，`blur(32px)` 在这一层上栅格化。快照写死了 `animation:none`，
重放页里没有动画，这一层就没了，模糊改画进父层、走另一条路径 —— 差出上百级的是这个。
第 8 帧药丸的动画已经放完，它那一层的原因只是 `Overlap`（压在光晕层上面），
光晕层回来了它自己就回来，所以**只补「动画造成的」那一种**才对，两个都补反而差 59。

1/64 px 是真的，但只在合成层对上之后才看得出来（同样只给光晕补 `will-change: opacity`，换几段文字）：

| 文字（药丸宽） | 只补合成层 | 只对齐 1/64 | 两个都做 |
|---|---|---|---|
| `Unified!`（381.3125） | 逐字节相同 | 最大 14 | 逐字节相同 |
| `PromptCut`（484.65625） | 826 / 58 | 最大 14 | **逐字节相同** |
| `Hello`（280.8125） | 10 / 18 | 最大 25 | 10 / 18（剩下的全是 alpha < 25 的像素，见 12.5） |

§6.1 里「把快照宽度改回 316.15625px，一个数都没变」这条反证因此也说得通了：
合成层不对的时候，1/64 px 的那点差别被上百级的差盖住了。

### 12.2 修法一：生成快照时补合成层、几何对齐 1/64（`inlineStyles.ts`、`snapshotStyleProps.mjs`）

1. **补合成层**：`animatedProps` 读 `getAnimations({ subtree: true })` 时，顺手记下「**current** 的动画改写了
   `COMPOSITED_ANIMATION_PROPS`（opacity / transform / translate / rotate / scale / filter / backdrop-filter）」
   的元素，`buildStyle` 给它补一条 `will-change: <这些属性>`；元素自己本来写了 `will-change` 的合并成一条。
   current 的判断是纯函数 `isCurrentAnimation`（照 Web Animations 的段划分：活跃段里且没放完——暂停的也算；
   或正向播放、还在 delay 里），在 `.mjs` 里好单测。伪元素上的动画不补（内联样式够不着伪元素）。
   改完 CDP 再读：活渲的 `ActiveOpacityAnimation` 对面是重放的 `WillChangeOpacity`，层数、层的变换逐项相同。
2. **对齐 1/64**：`LAYOUT_UNIT_PROPS`（width / height / 四边 / margin / padding / grid 轨道，含逻辑属性写法）
   里的 px 数写之前对齐回最近的 1/64 格（`snapLayoutUnits`）。6 位有效数字在 10000 px 以内的误差 ≤ 0.005 px，
   小于半格，对齐回去的一定是原值（单测把 0～10000 px 每隔 997 格验了一遍）。
   SVG 内部元素（`width` / `height` 是浮点几何）和 `zoom` 不为 1 的子树不对齐，保持原样。

两条都只改快照里写什么；整帧导出不生成快照，一步也不多走。

### 12.3 修法二：根因一没修全 —— 不连续取帧时推一拍不够（`bake.mjs`）

`fullFrame + onSnapshot` 且目标帧不连续（MOV 通道的 `renderMovFrames`）：中间那些帧只推时间、不截图，
到目标帧只推一拍，Motion 的值还停在上一次画帧时的相位。实测 punch-pill 只取第 8 帧：
快照里药丸 `scale(0.933311)`（第 1 帧的值）、光晕 0.894，活渲已经是 `none` / 1.39082。
非整帧那条路（`shoot()` 里「生成快照 → 塞回去截图」，`--media ffmpeg` 和 `vite-plugin-cards` 的卡片预览在用）同理。

判据和 `captureFrame` 的 `prime` 是同一件事：**紧挨着的上一帧画过才能只推一拍**，否则推两拍。
`flushFrameLoop(prime)`；`renderPass` 记一个 `lastDrawnFrame`（真截和生成快照前推的那一拍都算）。
改完只取第 8 帧，快照和活渲逐元素相同。代价：只在「上一帧没画过」的快照帧上多一张 jpeg q0 截图。
顺序生成快照（纯采样那一趟）除第一帧外每帧仍只推一拍，和原来一样。

### 12.4 验收

| 项 | 结果 |
|---|---|
| `scripts/verify-unified-frames.mjs`（5203） | ✅ **整条通过**，连跑 3 次都过 |
| `scripts/verify-bake-protocol.mjs` | ✅ PASS |
| `scripts/verify-export-frame-content.mjs` | ✅ PASS（脚本写死 5196，在禁用段里；复制一份到 `out/` 改成 5206 跑的，没改仓库里的脚本） |
| 28 张卡「活渲 vs 快照重放」（640×360、10 fps，每张 4 个时间点） | 没有一张变差；多数从几万～几十万个通道降到 0，见下 |
| 导出逐字节（基线对账，`docs/export-baseline-compare.md` 的 fixture） | 新旧代码在同一状态下 **240 / 240 逐字节相同**，见 12.6 |
| `npx tsc -b --force` | ✅ 0 错误 |
| `npm test` | 新加 7 条全过；**这台容器上有 14 条失败**（Node 24；Node 22 下 19 条 + 9 条取消），改动前后是同一组，全是环境：Windows 路径（`C:/work/...`）、Python 采集插件、拓展安装器的 Windows 进程。要在 Windows 开发机上再跑一遍确认全过 |

28 张卡的对照（四个时间点里「不同通道数」和「最大差」各取最差的一个；只列改动前后不全为 0 的）：

| 卡 | 改动前 | 改动后 |
|---|---|---|
| focus-card | 834618 / 13 | 695 / 2 |
| growth-curve | 372132 / 124 | 626 / 69 |
| blur-text | 158002 / 3 | 0 |
| rank-bars | 157252 / 71 | 0 |
| punch-pill | 63180 / 255 | 376 / 255（几乎全是 alpha < 32 的像素，见 12.5） |
| mu-blur-fade | 58479 / 11 | 0 |
| entity-chips | 55770 / 255 | 0 |
| checklist | 44973 / 41 | 0 |
| pin-board | 36074 / 9 | 35 / 9 |
| term-card | 36008 / 3 | 0 |
| quote-lockup | 13015 / 1 | 0 |
| ui-callout | 6603 / 255 | 12 / 3 |
| stat-proof | 5464 / 2 | 0 |
| step-timeline | 11 / 2 | 0 |
| odometer | 2782 / 233 | 同左，逐项相同 |
| mu-circular-progress | 2595 / 26 | 同左，逐项相同 |
| ring-metric | 240 / 10 | 同左，逐项相同 |
| lottie-bodymovin | 168 / 7 | 同左，逐项相同 |
| versus-card | 77 / 5 | 同左，逐项相同 |
| terminal-3d | 32 / 3 | 同左，逐项相同 |

其余 8 张（chapter-bar、mu-animated-shiny-text、mu-number-ticker、mu-typing、mu-word-rotate、particles、
scene-3d、type-shift）改动前后都是 0。

### 12.5 还剩的残差（没修，原因）

> **2026-09-23 更正（第三轮，§13）**：这一节三条都要改。① punch-pill 的 376 / 255 不是预乘舍入，是变换只写了
> 6 位有效数字，§13 的修法下 30 帧全部归零。② 「弹簧停下的那一帧」的时序说反了：`transform: none` 是在这一帧
> **画之前**写进 DOM 的，合成器里这一层的变换也已经是新值；导出画出旧样子，是因为这个合成层之前按非 1 的缩放
> 画过、文字的栅格结果带着历史，见 §13.4。③ 最后一行那几张卡已查完，见 §13。下面保留原文。

- **透明底上的低 alpha 像素**：punch-pill 的光晕边缘 alpha 只有十几、二十几，预乘值差 1，反预乘后 RGB 被放大成几十级。
  垫上不透明的东西（verify 脚本里垫着视频）就没了。
- **弹簧停下的那一帧**（verify 那个项目的第 6、7 帧，约 410 个通道、最大 57，只在一个字形上）：
  导出在这一帧截到的是**上一帧**的药丸（第 6 帧文字区域和第 5 帧逐字节相同），因为 Motion 判定弹簧已静止后，
  终值 `transform: none` 是在这一帧画完**之后**才写进 DOM 的；快照在推完一拍、页面排空之后生成，
  记的是写进去之后的 DOM。这是导出那一侧的时序；要对齐只能改导出（不允许）或改成在画帧那一刻生成快照，
  这轮没动。
- 上表最后一行那几张卡：改动前后数字一样，是别的原因，没查。

### 12.6 导出逐字节：这台容器上导出本身有抖动

照 `docs/export-baseline-compare.md` 的 fixture（1280×720、30 fps、240 帧、`--workers 1 --no-video`），
基线树（HEAD 的 worktree）和候选树（HEAD + 本次改动的 worktree）各起一台 dev server（5215 / 5218），
另外也拿主树的 5203 跑过。每趟给 240 帧算一个签名：

| 运行 | Node 侧代码（导出脚本、`bake.mjs`） | 页面 bundle（哪台服务器） | 240 帧签名 |
|---|---|---|---|
| head-on-5203 | HEAD | 主树 5203（当时暂存了改动，内容 = HEAD） | `732c470b2e` |
| head-on-5218 | HEAD | 候选树 5218（本次改动） | `732c470b2e` |
| cand-on-5215 | 本次改动 | 基线树 5215（HEAD） | `732c470b2e` |
| candidate-clean2 | 本次改动 | 候选树 5218（本次改动） | `732c470b2e` |
| head-5215-r3 / candidate-clean | HEAD / 本次改动 | 5215 / 5218 | 和上面各差 1 帧（分别是第 152、66 帧，都是整帧一半像素不同、从 (0,0) 起 —— 典型的截图时序抖动，旧代码也有） |
| baseline / baseline2 | HEAD | 基线树 5215（新起的服务器的头两趟） | 前 36 帧（光晕动画那 1.2 秒 + 压在上面的毛玻璃条）是另一种状态，两趟彼此相同 |

结论：**新旧代码在同一状态下 240 / 240 逐字节相同**（四趟、交叉换树换服务器），导出没有被这次改动碰到；
这和代码结构一致（整帧导出不调 `__pcCreateSnapshot`，默认导出也不带 `domCache`）。
但这台 4 核容器上导出**本身**不是每趟都逐字节相同（偶发整帧抖动；新服务器头两趟光晕段是另一种状态），
改动前就这样，这轮没查根因。以前在 Windows 开发机上是 60 / 60、240 / 240 相同，建议在那边按
`docs/export-baseline-compare.md` 再对一次账。

### 12.7 「导出页 60 秒没就绪」（R7 报告 5.1）

**原因：目标端口上没有 dev server。** `verify-unified-frames.mjs` 不带 `PC_FRAME_TEST_URL` 时打 5192；
R7 报告自己写了「跑的时候 5188～5200 没有任何监听者」。CDP 的 `Page.navigate` 连不上时**不抛错**，
只在返回值里带 `errorText`，`chrome.mjs` 的 `newSession` 没看它，页面停在 Chrome 的错误页上，
`waitReady` 一直等不到 `__pcReady`，满 60 秒报这一句。退回 main 复跑「挂在同一行」也正是因为端口上照样没人。
复现：把 `PC_FRAME_TEST_URL` 指到一个空端口，61 秒后报一模一样的错。现在指向真在跑的 5203，二十多趟一次都没出现。
**这不是代码回归。** 可以顺手做但这轮没做的两件：`newSession` 看 `errorText` 立刻报「连不上 <url>」；
脚本的缺省端口 5192 落在 5190～5199 禁用段里，改个缺省或者要求必须给 `PC_FRAME_TEST_URL`。

### 12.8 作废范围

- `snapshotCode` 变了（`inlineStyles.ts`、`snapshotStyleProps.mjs`、`bake.mjs` 都在 `SNAPSHOT_FILES` 里）→
  **全部共享快照作废一次**，这是要的效果：旧快照里毛玻璃卡和不连续取帧的 Motion 值本来就是错的。
- `bake.mjs` 也在 `CAPTURE_FILES` 里 → `captureCode` / `frameCode` 也变，MOV 帧缓存和卡片缓存跟着作废一次
  （`frameCode` 哈希整个 `src/`，只改 `inlineStyles.ts` 也会作废它）。
- 快照变大一点：每个被补合成层的元素多一条 `will-change:opacity;`（二十来个字节），对齐后的数多几位小数。
- 快照挂回去时（重放页、舞台里贴快照）合成层数和活渲一样多了：以前这些元素没有动画、不提层，现在按 `will-change` 提层。
  一张卡逐字做透明度动画的话，层数跟着字数走 —— 活渲时本来就是这么多层，这里只是对齐。

### 12.9 改了哪些文件

`src/render/snapshot/inlineStyles.ts`、`src/render/snapshot/snapshotStyleProps.mjs`（及 `.d.mts`）、
`server/bakery/bake.mjs`、`server/test/snapshot-style-props.test.mjs`（新增 7 条）。
探针都放在 `out/probe/`（不进仓库）。

## 13. 第三轮（2026-09-23）：§12.4 表尾那几张卡查清，四处修法落地

分支：`claude/charming-hofstadter-f8fb05`（先合进 `claude/wonderful-mayer-blc7xr`，即 §12 的两个提交）。
环境：Windows 开发机、puppeteer 自带的 chrome-headless-shell 152、dev server 5203（`.claude/launch.json` 的 dev-test）。
探针都在 `out/probe/`（不进仓库）：`residual.mjs`（逐卡逐帧对账）、`exp.mjs` + `v-*.mjs`（同一拍里改写快照再重放）、
`pp-*.mjs`（punch-pill 的时序、层、历史）、`anim-boundary.mjs`（提层判据）、`tri.mjs`（三联图）。

### 13.1 口径

每张卡一条 640×360 / 10 fps / 3 秒的片段、参数取默认值，**30 帧全比**（§12 是 4 个时间点，所以这次多查出几张）。
每张卡三趟，各开一个新的 bakery：

- **A**：纯整帧导出（`fullFrame`，不生成快照）—— 和导出同一条路，是对账的标准答案；
- **B**：`fullFrame` + `onSnapshot`，拿同一拍的截图和快照；S = B 那一趟的快照用 `captureSnapshot` 重放；
- **C**：纯采样（`snapshotOnly`）那一趟的快照重放 —— 生产里 HTML 采样走的就是这条。

两条先验结论：**B 和 A 在 28 张卡 × 30 帧上全部逐字节相同**（生成快照前推的那一拍不改活渲）；
**C 和 S 在每一帧上的差异都一模一样**（纯采样那一趟生成的快照和整帧那一趟的等价）。下文的「差异」都是 S 对 A。

### 13.2 四个根因（每条都在同一拍的替换实验里修到逐字节相同）

做法照 §12.1：顺推到出问题的那一帧，在生成快照的同一拍里按变体改写快照（页面内做，拿得到 live 元素），逐个重放比像素。

**① 变换只写了 6 位有效数字。** `getComputedStyle` 把整串变换折成一个矩阵，数按 6 位有效数字写：

| 卡 / 帧 | 快照里写的 | 真实值（Typed OM） | 原样 → 换成全精度 |
|---|---|---|---|
| odometer 第 9 帧 | `matrix(1, 0, 0, 1, 0, -2156.5)` | `translate(0px, -2156.501953125px)` | 3139 / 233 → **0** |
| terminal-3d 第 20 帧 | `matrix3d(0.990268, 0, 0.139173, …)` | `rotateY(-8deg)` | 34 / 2 → **0** |
| versus-card 第 8 帧 | `matrix(1.00414, …)`、`matrix(1.04, …)` | `scale(1.00414…)`、`scale(1.04)` | 3065 / 4 → **0** |
| punch-pill（verify 项目）第 5 帧 | `matrix(1.00047, …)` | `scale(1.0004741…)` | 1427 / 12 → **0** |

odometer 那一格最典型：四位数的位移只剩两位小数，`-2156.5` 正好落在像素取整边界的另一侧，整个「8」上下错一格。
修法：`inlineStyles.ts` 的 `exactTransform` 用 `computedStyleMap().get('transform')` 读分量，
`snapshotStyleProps.mjs` 的 `serializeTransformList` **按函数形式、全精度**写回（`translate(…)`、`rotateY(…)`、`scale(…)`，
百分比原样留着），认不出的分量（`calc()` 之类）才退回矩阵。实测写成全精度矩阵和写成函数形式在这几格上都是 0；
选函数形式是设计上的理由（没有单独测像素）：`rotate(-90deg)` 折成矩阵是 `matrix(6.12323e-17, -1, 1, 6.12323e-17, 0, 0)`，
残下的 1e-17 让它不再轴对齐；`translateZ(0)` 折成 2D 单位阵会丢掉那一层合成层（目录里有几张卡这样写）。

**② SVG 表现属性被 6 位的内联值盖掉。** `d` / `cx` / `stroke-dasharray` 这类写在 SVG 属性上的值，
克隆体上带着全精度的原文，可快照又把 6 位有效数字的计算值写进内联样式，而**内联样式的优先级高于属性**：

| 卡 / 帧 | 属性原文 | 快照内联的 | 原样 → 不内联 |
|---|---|---|---|
| growth-curve 第 15 帧 | `d="M 40,234.2857142857143 C 96.66666666666666,…"` | `d:path("M 40 234.286 C 96.6667 …")` | 626 / 11 → **0** |
| ring-metric 第 4 帧 | `stroke-dasharray="1407.4335088082273"`、`stroke-dashoffset="515.6416080223909"` | `1407.43px`、`515.642px` | 200 / 52 → **0** |
| lottie-bodymovin 第 19 帧 | `transform` / `d` 属性（lottie 每帧改写属性） | 6 位的矩阵和路径 | 253 / 14 → **0**（只修变换是 12 / 14） |

Typed OM 对 `d` 给的也是 6 位的字符串，帮不上。修法：SVG 内部元素上**由它自己的属性给出、又没被内联样式和动画改写**的属性
不内联（`presentationProps`），重放时照样由克隆下来的属性给出；继承属性照样记进给子元素比对的那一份。
这是「布局解析值一律内联」唯一的例外：SVG 内部元素的 `width` / `height` 不是排版值。

**③ 相邻文本节点被合并。** mu-circular-progress 的中心文字是 React 渲的 `{75}%`，DOM 里是「75」「%」两个文本节点；
HTML 序列化再解析会把它们并成一个「75%」。差异落在「5」的右半边、正是「%」模糊阴影（`text-shadow: 0 4px 24px`）
能够到的地方：两段文字各自先画阴影再画字，「%」的阴影压在「5」上；并成一段后阴影全在字底下（这条机理是按差异的位置推的）。
在相邻文本节点之间插一个空注释（`<!---->`，不产生排版对象）：第 15 帧 1541 / 10 → **0**。
修法在 `createSnapshot.ts` 的 `keepTextBoundaries`，HTML 原始文本元素（`style`、`textarea` 等）里不插。

**④ 合成层的判据是 relevant，不只是 current。** stat-proof 第 12 帧：活渲有一层 `312x48 ActiveOpacityAnimation`，重放里没有。
那条透明度动画 `delay 0.4 s + duration 0.8 s`，`__pcSyncAnims` 把它钉在 1200 ms——JS 里 `1200 < endTime = 1200.0000000000002`，
所以没 `finish()`——可 `getComputedTiming().localTime` 读回来等于 `endTime`，按规范已在结束后，§12 的 `isCurrentAnimation` 判它不是 current。
受控实验（13.5）表明 Blink 给**放完了、靠 `fill` 停在终态**的动画照样提层，判据是 Web Animations 的 relevant（current 或 in effect）。
改成 `isRelevantAnimation`（in effect 就是 `getComputedTiming().progress` 不为 null）：3 / 2 → **0**，
重放里的 `WillChangeOpacity` 层对上活渲的 `ActiveOpacityAnimation`。

### 13.3 修改后 28 张卡全量

「不同通道 / 最大差」两列各取 30 帧里最大的一个（不一定是同一帧）；快照体积是整场景 HTML 30 帧里最大的一份。

| 卡 | 修改前：有差异的帧 | 修改前：通道 / 最大差 | 修改后：有差异的帧 | 修改后：通道 / 最大差 | 快照体积（字节） |
|---|---|---|---|---|---|
| focus-card | 5 / 30 | 1066 / 2 | 0 | 0 | 40143 → 40143 |
| growth-curve | 28 / 30 | 645 / 69 | 0 | 0 | 56472 → 55697 |
| punch-pill | 11 / 30 | 376 / 255 | 0 | 0 | 27988 → 28002 |
| checklist | 1 / 30 | 8 / 10 | 0 | 0 | 62155 → 61868 |
| pin-board | 6 / 30 | 35 / 9 | 0 | 0 | 35703 → 35765 |
| ui-callout | 3 / 30 | 201 / 255 | 0 | 0 | 30579 → 30456 |
| stat-proof | 1 / 30 | 3 / 2 | 0 | 0 | 39164 → 39170 |
| step-timeline | 2 / 30 | 43 / 11 | 0 | 0 | 64259 → 64217 |
| odometer | 1 / 30 | 3139 / 233 | 0 | 0 | 161024 → 161052 |
| mu-circular-progress | 30 / 30 | 2151 / 255 | 3 / 30 | 34 / 7 | 31822 → 31633 |
| ring-metric | 13 / 30 | 246 / 52 | 0 | 0 | 36242 → 35983 |
| lottie-bodymovin | 29 / 30 | 253 / 15 | 0 | 0 | 1038501 → 873328 |
| versus-card | 5 / 30 | 3065 / 5 | 0 | 0 | 38499 → 38588 |
| terminal-3d | 30 / 30 | 34 / 3 | 0 | 0 | 41963 → 41892 |
| chapter-bar | 4 / 30 | 39240 / 17 | 3 / 30 | 2 / 2 | 39171 → 39183 |

其余 13 张（blur-text、rank-bars、mu-blur-fade、entity-chips、term-card、quote-lockup、mu-animated-shiny-text、mu-number-ticker、
mu-typing、mu-word-rotate、particles、scene-3d、type-shift）修改前后 30 帧都是 0。
修改前的数是这台机器上量的，和 §12.4（云端容器、4 个时间点）不完全一样，比如 mu-circular-progress 那边是 2595 / 26。
focus-card、checklist、pin-board、ui-callout、step-timeline 是 30 帧比对新查出来的，同一批修法下归零，没有逐张归因。

verify 那个项目（punch-pill、320×180、10 fps、`Unified`、无视频）：修改前第 2～7 帧有差异（第 5 帧 1427 / 12 最多），
修改后只剩第 6、7 帧（819 / 64、819 / 65），见 13.4。

### 13.4 不修的三处

**punch-pill「弹簧停下的那一帧」（verify 项目第 6、7 帧，819 个通道、最大 65，只在「f」「e」两个字形上）。
根因在导出那一侧：合成层的栅格结果带着历史。**

- **不是写进 DOM 晚了**（更正 §12.5）。给药丸挂 MutationObserver、配一个自己的 rAF 计数：`transform: none` 在第 6 帧推时间那一步
  写进去（rAF 计数 34），截图前读是 `none`，截图后读也是 `none`。
- **合成器里这一层的变换也已经是新值**。每帧截图后读 CDP LayerTree（开着它导出的 10 帧和不开时逐字节相同）：
  第 5 帧药丸层缩放 1.000474，第 6、7 帧缩放 1、平移 (2, 18)，合成原因一直是 `ActiveOpacityAnimation`；
  第 8 帧透明度动画收尾、原因变成 `Overlap`，这一层重建。
- **可画出来的文字还是旧样子**：文字区域（154,68 – 229,116）导出的第 5、6 帧逐字节相同，第 8 帧才跳到「新层」的样子；
  拿第 5 帧的快照（`scale(1.00047)`）重放，文字区域和导出第 6 帧逐字节相同。
- **在重放页里复现出了这段历史**：先把药丸按某个变换画一拍，再原地改成 `none` 画一拍，比文字区域：

| 之前画过的 | 药丸是合成层（`will-change: opacity`） | 药丸不是合成层 |
|---|---|---|
| `scale(1.00047)` / `1.01` / `1.1` / `0.9` | 等于导出第 6 帧（0 / 0），不等于新挂的 `none`（819 / 64） | 等于新挂的 `none` |
| `translate(0.3px, 0.3px)` | 等于新挂的 `none` | 等于新挂的 `none` |

  结果和之前缩放多少无关，所以不是「沿用旧缩放的栅格」；加 `--disable-lcd-text` 结果完全一样，也不是 LCD 文字。
  能说的是：**一个合成层只要按非 1 的缩放画过，回到缩放 1 之后文字的栅格结果就和新建的层不同，直到这一层重建**。
  Chrome 内部是哪条机制没查。
- **为什么不修**：快照是一份静态 DOM，重放时这一层是新建的，带不了「之前缩放过」这段历史；改导出不允许；
  §12.5 提的「在画帧那一刻生成快照」也没用——那一刻 DOM 已经是 `none` 了。要对齐只能在快照里编码合成器的历史，
  依赖 Chrome 内部行为，又只影响「缩放动画停下后、这一层重建前」那一两帧，不值得。

**mu-circular-progress 第 1～3 帧（最多 34 个通道、最大 7）。根因：卡片把全精度的数写进了自己的内联样式，DOM 里读不到原值。**
进度环的 `stroke-dasharray` 是 React 写的 `2π·45 = 282.7433388230814`；换成这个精确值重放：34 / 4 → **0**。
可元素自己的 `style` 属性已经被 Chrome 序列化成 `stroke-dasharray: 282.743;`，`getComputedStyle` 是 `282.743px`，
Typed OM 不把这种列表值转成数值（给的是同样 6 位的 `CSSStyleValue`）。快照这一侧能读到的每一种形式都是 6 位。

**chapter-bar 第 21～23 帧（1～2 个通道、最大 2，一个像素）。根因同上。** 高亮块用 `layoutId` 做共享布局动画，
Motion 缩放时把 `borderRadius: 9999px` 改写成相对盒子的百分比做校正：精确值是 `9999 / 160 = 6249.375%`、
`9999 / 104 = 9614.4230769…%`，读出来是 `6249.38% 9614.42%`（Typed OM 同样）。换成精确值重放：2 / 1 → **0**。

**这两处为什么不修**：原值只在 JS 写样式的那一刻出现过。要拿到它就得在页面里拦下所有写样式的入口
（`CSSStyleDeclaration` 上几百个属性的 setter 和 `setProperty`），每张卡每次写样式都多一层开销，改动面和风险都远大于这几个像素。

### 13.5 合成层判据实测（Chrome 152）

一条透明度动画 `delay 400 / duration 800` 暂停在各个时刻，画两拍后读 `LayerTree.compositingReasons`：

| fill | 100（delay 里） | 800（活跃段） | 1200（结尾） | 1500（结尾之后） |
|---|---|---|---|---|
| `both` | 提层 | 提层 | 提层 | 提层 |
| `none` | 提层 | 提层 | 不提 | 不提 |
| `forwards` | 提层 | — | — | 提层 |
| `backwards` | 提层 | — | — | 不提 |

另外：`fill: both` 在 `finish()` 之后仍提层；反向播放停在结尾提层。14 格全部符合「current 或 in effect」。
顺带记一个怪现象：`delay 400 + duration 800` 的动画 `currentTime` 设成 1200，`localTime` 读回来是 `1200.0000000000002`
（`0.4 + 0.8` 在双精度下的值）；`delay 0 + duration 500` 设 499.999，`localTime` 读回来是 500。

### 13.6 验收

| 项 | 结果 |
|---|---|
| 28 张卡「活渲 vs 快照重放」（30 帧，13.3） | 26 张 30 帧全部逐字节相同；剩 mu-circular-progress、chapter-bar 各 3 帧，根因见 13.4 |
| verify 项目的 punch-pill | 只剩第 6、7 帧，根因见 13.4 |
| `scripts/verify-unified-frames.mjs`（5203） | ✅ PASS，退出码 0 |
| 导出逐字节（`docs/archive/topics/export-baseline-compare.md` 的 fixture） | ✅ **240 / 240 逐字节相同**，见下 |
| `scripts/verify-determinism.mjs`（同一个 fixture，5203） | ✅ 240 / 240 相同 |
| `scripts/verify-bake-protocol.mjs` | ✅ PASS |
| `npx tsc -b --force` | ✅ 0 错误 |
| `npm test` | ✅ 1660 条：1659 过、0 失败、1 跳过；新增 5 条（`serializeTransformList` 4 条、`isRelevantAnimation` 1 条） |

导出对账的做法：这次只改了页面侧的三个文件（Node 侧的导出脚本一字未动），所以只用 5203 一台服务器——
先用改后的代码导 240 帧（候选），再把 `createSnapshot.ts` / `inlineStyles.ts` / `snapshotStyleProps.mjs(.d.mts)` 临时换回
改动前（合并提交 `2a4d363`）的版本导 240 帧（基线；导出前确认服务器发的确实是旧模块），导完立刻换回，工作区确认干净。
fixture 按那份文档第 1 节的表自己生成（1280×720、30 fps、8 秒；punch-pill / odometer / mu-word-rotate、chapter-bar、growth-curve、
scene-3d、particles、一段 testsrc2 视频），`--workers 1 --no-video`。`export-baseline-compare.mjs` 报「逐字节:相同 240/240」、退出码 0。
这也和代码结构一致：默认导出（媒体模式 `chrome`）走 `exportUnified` → `fullFrame`，不调 `__pcCreateSnapshot`。

### 13.7 影响面

- **作废**：三个文件都在 `SNAPSHOT_FILES` 里 → `snapshotCode` 变，**全部共享快照作废一次**；`createSnapshot.ts` 等在 `src/` 下 →
  `frameCode` 变，MOV 帧缓存和卡片缓存跟着作废一次。`server/bakery/` 一字未动，`captureCode` 不变。
- **像素会变的路径**：「生成快照 → 重放截图」出图的地方——`--media ffmpeg` 的兜底导出、`vite-plugin-cards` 的卡片预览、
  舞台里贴快照的重卡——画面会变，方向是更接近活渲。默认导出不变（13.6）。
- **快照体积**：lottie 这类 SVG 卡变小（整场景 HTML 1038501 → 873328 字节，属性不再在内联样式里重复一份）；
  其余卡增减几十到几百字节（变换写全精度多几位数，相邻文本节点多一个 `<!---->`）。
- **两趟布尔探针**（`StageView` 的 `vtOk` / `seekOk`，`snapshotCompare.mjs`）：两边序列化的是同一种结构，插的注释逐字相同；
  变换里的数仍在 `style` 属性里，照旧按 1e-6 相对容差比。

### 13.8 改了哪些文件

`src/render/snapshot/inlineStyles.ts`、`src/render/snapshot/snapshotStyleProps.mjs`（及 `.d.mts`）、`src/render/createSnapshot.ts`、
`server/test/snapshot-style-props.test.mjs`（新增 5 条）。
