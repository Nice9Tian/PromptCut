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

- `verify-unified-frames.mjs` 仍未整条通过 —— 卡在 §6 的毛玻璃亚像素残差上，
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
