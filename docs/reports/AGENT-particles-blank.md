# AGENT 报告：粒子卡暂停时画面全透明

分支 `claude/particles-blank`，worktree `.worktrees/particles-blank`，端口 5860～5862（dev server 与它的两个舞台端口）。

## 任务

粒子素材卡（`src/cards/native/particles.tsx`，tsParticles）在编辑器预览里暂停时画面全透明。找根因，按卡片硬约束修，使暂停与导出时粒子画面按时间确定地画出来。

## 根因

预览舞台（`?stage=1`，`src/render/stageClock.ts`）把 `setTimeout` 换成了挂在虚拟时钟上的定时器，只在舞台时钟 tick 时触发；暂停时舞台不 tick。

tsParticles 4.4 的 `Container.start()` 在 `init()`（粒子已排好）之后还要 `await new Promise(r => setTimeout(r, delay))`（delay 缺省 0）才返回。于是在暂停的舞台上：

- `tsParticles.load()` 一直不返回，卡片等在它后面的 `c.pause(); stepTo(...)` 一次都没跑。画布停在初始化时清空的状态：canvas 在、80 个粒子都排好了，但一个像素也没画。
- 往前拖时舞台会 tick，那个定时器被触发，load() 返回，画面出来了。所以现象是「往前拖有画面，停住或往回拖全透明」。往回拖走 `container.refresh()`，也要等这个定时器，同样卡住。

取证：在舞台 iframe 里读容器，count=80、粒子位置和不透明度都正常；手动调一次 `drawParticles` 就有 24707 个不透明像素；在前台舞台里 `stepTo` 的调用次数是 0（后台舞台在做 K1 测量，会 tick，所以它那边画出来了）。

另一个问题是修的过程中发现的：往回拖用 `refresh()` 重新排布，排出来的粒子和第一次 `load()` 不一样。停在 3 s、跳到 5 s、再跳回 3 s，两次像素哈希不同。原因是两条路消耗的随机数不同：load() 在建容器前要取一个随机数给容器起名（refresh 不取），粒子编号、对象池也不归零。只补上起名用的那一个随机数，两次仍然不同。

## 改法（只改 `src/cards/native/particles.tsx`）

1. 不再等 `load()` / `refresh()` 返回。改为监听引擎在 `init()` 末尾发出的 `particlesSetup` 事件（`whenSetUp`，按画布的父元素认出自己那个容器），粒子排好就开始按 t 推进。
2. `forceOurs` 加上 `autoPlay: false`。这样那个定时器不管什么时候触发，后面的 `play()` 都在首次启动时直接返回，引擎自己的帧循环永远不会启动；插件的 start 只挂交互监听，而交互已经关掉，对画面没有影响。
3. 往回拖不再用 `refresh()`，改为销毁容器，按首次挂载的同一条路重新装载（`st.reload`）。重新装载期间来的 t 记在 `pendingT`，装好后一次推到位。

符合卡片硬约束：没有新增 `Date.now` / `setTimeout` / `IntersectionObserver`。画面仍然只由 seed 和 t 决定，按 1/60 s 的整格步长逐步推进（原有设计不变）。

## 验证

### 探针 `scripts/probes/particles-paused-probe.mjs`（新增）

编辑器 `?editor&nosetup=1&preview=stage`，放一张粒子卡，停在 t=3 s（不播放），读前台舞台 canvas 的 2d 像素；再跳到 5 s，然后跳回 3 s。

| 情况 | t=3 首次（不透明像素 / 哈希） | t=5 | 跳回 t=3 | 结果 |
|---|---|---|---|---|
| 修前（main 的 particles.tsx），默认参数 | 0 / 43fc5b89… | 24923 | 0 / 43fc5b89… | exit 1（空帧） |
| 修后，默认参数 | 26345 / 9894b997… | 24520 / 14e433b2… | 26345 / 9894b997… | exit 0 |
| 修前，config=/catalog/particles/bubble.json | 0 | 145930 | 0 | exit 1 |
| 修后，bubble | 189454 / 3cd2ea54… | 145930 / 991fe876… | 189454 / 3cd2ea54… | exit 0 |

中间一版只改了 1、2 两条、往回拖仍用 refresh，这一版跳回 t=3 的哈希与首次不同（ec1f23de… 对 9894b997…）；加了第 3 条之后两次逐像素相同。

看过的图（scratchpad `pp-before/`、`pp-after/`）：修前 `t3-first-stage.png` 舞台里只有透明棋盘格；修后 `t3-first-stage.png` 与 `t3-again-stage.png` 都是满屏浅蓝粒子加连线，两张一模一样。早先截的图被编辑器的「正在测量卡片」遮罩盖住了，所以探针改成等遮罩退掉再截。

### 基线

- `npx tsc -b --force`：exit 0（合并 main 之前和之后各跑一次）。
- `npm test`（合并 main 之前）：tests 3467，pass 3465，fail 0，skipped 2，exit 0。
- 导出确定性与像素基线比对：见下节。

## 导出确定性与像素基线

（待补）

## 没做的及原因

- `scripts/verify-preview-window.mjs` 里有一条 `particles-ready` 用例（比较预览窗口和导出是否一致），但这个脚本会在 `out/` 下建 `node_modules` 的 junction，违反子 Agent 规矩，所以没跑。
- 演示时间轴（`src/demo.ts`）里没有粒子卡，所以 1800 帧的像素基线覆盖不到这次改动。它只能证明这次改动没有波及别的卡。

## 对任务书或语义的更正建议

- `server/card-authoring-guide.md`「可以用的依赖」里写「挂载时先 `setRandom(() => Math.random())`」，与现在的实现（按 seed 播种的 PRNG）不一致，建议改成「参考 particles.tsx 的 seededRandom」。本任务没改这份文档。
