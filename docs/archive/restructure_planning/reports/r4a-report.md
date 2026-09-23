# R4a 报告：轻重分派的纯函数、可调系数、离线探针两趟

分支 `worktree-agent-a75a453a93791f02d`（worktree `C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-a75a453a93791f02d`）。
开工时 `git merge --ff-only main` 到 `6876dd7`。

## 提交

| 提交 | 内容 |
|---|---|
| `eb114d2` | 渲染：K2 可调系数模块 `pipelineTuning`（`COST_SCALE` / `STEP_PERCENTILE` / `STEP_MIN_SAMPLES`） |
| `eb2c20d` | 渲染：K2 分派纯函数 `planPipelines` / `pipelineAt`（两端同一份） |
| `a9fc8ca` | 服务端：K2 可调系数存 `out/pipeline-tuning.json`，随 `GET /api/data/costs` 一起回 |
| `1e986ce` | 舞台：`render` 的探针分两趟（`probe: 'time' \| 'snapshot'`） |
| `6d302b8` | 探针：`probe-card-costs` 改两趟，`stepMs` 取稳健值、单次最大另记 `stepMaxMs` |

改了哪些文件：

- 新增 `src/render/pipelineTuning.mjs` / `.d.mts` / `.test.mjs`
- 新增 `src/render/pipelinePlan.mjs` / `.d.mts` / `.test.mjs`
- 改 `server/costs-store.mjs`（加 `tuningPath` / `loadTuning`）、`server/vite-plugin-costs.ts`（GET 回包加 `tuning`）、`server/test/costs.test.mjs`（+5 条）
- 改 `scripts/probe-card-costs.mjs`（两趟、稳健值、外推、档位统计）
- 改 `src/render/cardCostKey.d.mts`（`CardCostRecord` 加 `stepMaxMs?`）
- 改 `src/StageView.tsx`、`src/render/stageRpc.ts`（**见下面「给合并的人」**）

## 环境

这个 worktree **没有 `node_modules`**，任务书不许 `npm ci`、不许建 junction。实测 Node 和 tsc 的模块解析都会沿目录往上找、命中主仓库的 `C:\Users\admin\Documents\PromptCut\node_modules`，所以 `npx tsc -b --force`、`npm test`、`npx vite` 在 worktree 根目录下直接可跑，什么都不用装。

- main 基线：`npx tsc -b --force` 零错误；`npm test` = 1481 / 1480 通过 / 0 失败 / 1 跳过。
- 收尾：`npx tsc -b --force` 零错误；`npm test` = **1523 / 1522 通过 / 0 失败 / 1 跳过**（新增 42 条：`pipelineTuning` 9 + `pipelinePlan` 28 + `costs` 5）。

---

## 1. `src/render/pipelineTuning.mjs`

缺省 `{ COST_SCALE: 1, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 }`；`resolveTuning(overrides)` 按 `COST_SCALE` 0.25～4、`STEP_PERCENTILE` 0.5～1、`STEP_MIN_SAMPLES` 8～120 夹取，坏值退回缺省，返回冻住的新对象，**幂等**（已解析过的一份再进来一次不变，所以 `planPipelines` 可以无脑再调一次）。探针封顶常量 `PROBE_MAX_FRAMES = 300` / `PROBE_MAX_MS = 500` 也在这里。

`robustStep(samples, tuning)`：

- **最近秩**百分位，不插值 —— 升序排好取第 `ceil(p × n)` 个（1 起数）。`p = 1` 正好是最大值，「`STEP_PERCENTILE` 取 1 = 旧的单次最大口径」自动成立。不插值是因为两端要逐字段相同，插值会把浮点末位差带进判重。
- **样本不足 `STEP_MIN_SAMPLES` 时取最大值。** 任务书把这一条留给实现者。理由写在代码注释里：样本少的时候百分位挑出来的那一个纯属运气（8 个样本取 0.9 分位 = 第 8 个 = 最大值，再少就开始挑到中间的数了），而少测一半就判轻的代价是播放掉帧。取最大值是保守的一侧，和 `catchUpMs` 截断时「按中位数外推、不按平均」同一个方向。探针那一侧对应有一条：`direct` 卡的 8 次抽样补抽到 `STEP_MIN_SAMPLES`，所以正常跑完的卡都走百分位，这条兜底只在探针被掐断时生效（实测 62 张卡全部走百分位）。
- 非有限数丢掉；空表回 0。

## 2. `src/render/pipelinePlan.mjs`

`planPipelines(project, costs, fps, opts)` / `pipelineAt(plan, clipId, tSec)`，外加两个导出：

- `clipWeight(record, frameMode, fps, tuning) → { pinned, w, tier }`：一张卡的每拍权重和档位。导出是为了单测能直接断言 K 节里「`w` = 5 ms、走 (b)」这种说法，探针脚本也拿它打诊断。
- `clipCostIndex(project, graph, sourceVersionOf) → { identityKeys, frameModes }`：「片段 → 节点 → `cardCostKey`」这一段。

档位（`tier`）与权重：

| tier | 条件 | w |
|---|---|---|
| `declared-light` | 没有成本记录、声明是 `direct` | 0（排在贪心最前、不占预算） |
| `declared-heavy` | 没有成本记录、声明不是 `direct` | ∞（每个位置都判重） |
| `capped` | `capped` / `demoted` / `pinnedHeavy`，或 `stepMs × COST_SCALE > B` | ∞ |
| `direct` | `kind: 'random'` | `stepMs` |
| `seek` | `seekOk === true` 且 `seekMs` 有值且 `≤ B` | `stepMs` |
| `catchup-a` | `catchUpMs ≤ B` | `stepMs` |
| `catchup-b` | `catchUpMs / (4 × stepMs) ≤ 2 × fps` | `5 × stepMs` |
| `over-catchup` | 超出追帧上界 | ∞ |

贪心：按 `w` 升序（同权重按 clipId 定序），逐个加入，`Σ w + 重卡数 × DEAD_MS > B` 就停。`重卡数` = 钉死的那些 + 还没装进轻管线的候选。`DEAD_MS = 0.3`，只有 `opts.deadMs`（L4）能换。

**两端逐字段相同**怎么保证：不读文件、不看环境变量、不用 `Date` / `Math.random`；卡片段先按 clipId 排序再遍历；候选表排序带 clipId 的 tie-break；输出的 `Set` 一律从排好序的数组建（`new Set([...].sort())`），迭代顺序不依赖插入顺序。单测里有一条「同一输入两次调用序列化后逐字节相同」，而且把轨道顺序倒过来再算一次、结果同样逐字节相同。

## 3. 单测

**42 条**（`node --test`，随 `npm test` 跑）：

- `src/render/pipelineTuning.test.mjs`：**9 条** —— 缺省值、夹取、坏值退回、最近秩百分位、`STEP_PERCENTILE = 1` 退回单次最大、样本不足取最大、非有限数、裸覆盖值、封顶常量。
- `src/render/pipelinePlan.test.mjs`：**28 条** —— K 节验收的算例逐条：10 张 direct 卡恰好前 7 张、全 30 ms 时轻管线为空、5 张 (b) 档只装 4 张、`capped` / `demoted` / `pinnedHeavy` 各一条、6 秒 Motion 卡（`w` = 5、走 (b)、不在 `prerenderSet`）、同卡 10 秒各位置都重、(a) 档、60 秒粒子卡（`seekOk: true` + `seekMs: null` → `over-catchup`）、60 秒纯 CSS 卡（`seekOk` + `seekMs ≤ B` → 各位置都轻）、`seekMs > B` / 缺 `seekOk` 退回推帧规则、分段边界 = 入出点并集、素材段不参与、第 2 段判重第 3 段判轻、`pipelineAt` 边界、`COST_SCALE` 1→2 改判重、`COST_SCALE` 乘在权重上、追帧上界是比值不随 `COST_SCALE` 变、`opts.deadMs`、`unknown` 卡参加贪心且判重计 `DEAD_MS`、`unknown` 判轻照常活渲、声明兜底、`identityKeys` 收 Map、**序列化两次逐字节相同**、不改入参、空项目、`clipCostIndex`、`resolveTuning` 幂等。
- `server/test/costs.test.mjs`：**+5 条** —— 没有 `out/pipeline-tuning.json` 用缺省、覆盖值读得出来且夹取、坏文件不抛、和成本记录同目录互不干扰（原有 9 条不动）。

## 4. `GET /api/data/costs` 的回包形状 —— 怎么处理的

**加字段，不改名。** 回包从 `{ ok, device, mode, costs }` 变成 `{ ok, device, mode, costs, tuning }`。

- 任务书 K2 写的是 `{ records, tuning }`。照那么改要把 `costs` 改名成 `records`，连带改掉 `scripts/probe-card-costs.mjs`（`data.costs`）、`server/test/costs.test.mjs`、以及将来的页面侧全部调用方，而且和 `PUT` 的 body（那一边本来就叫 `records`）会更容易混。
- 加一个字段能达到完全一样的效果：两端本来就都要拉 `costs`，`tuning` 搭这趟车就不会出现「一端拿到新系数、另一端还是旧的」的窗口。现有调用方读的四项一个都没动。

`loadTuning(root)` 回的是**夹取之后**的一份，不是文件里的原话 —— 夹取规则住在 `pipelineTuning.mjs` 里，两端各夹一次结果当然一样，但先夹好再发能少一层「某一端忘了夹」的可能。文件不存在 / 坏了 / 不是对象都当「没有覆盖」，回缺省，不抛。

**量法拼进 `device`**：`STEP_PERCENTILE` / `STEP_MIN_SAMPLES` 决定 `stepMs` 怎么从样本里取，改了它们等于换了量法，所以探针把 `stepP=0.9 | stepN=16` 拼进 `device` 串（和 `mode` 同一个办法），旧记录自然不命中、会被重测，两套量法的成绩各占一条。`COST_SCALE` **不拼** —— 它只影响怎么用这些数，不影响量出来的数本身。（`ProbeGate` 那一侧要照做，不在本任务范围。）

## 5. 探针两趟

**舞台侧**（`StageView.tsx` 的 `render`，`stageRpc.ts` 的类型）：`RenderOptions.probe` 从 `true` 变成 `true | 'time' | 'snapshot'`，`true` 等于 `'snapshot'`（旧调用方不动）。

- `'time'` 计时趟：`onFrame` 起表、`afterFrame` 收表，每帧一个数推进 `steps`；**不生成快照、不 post `probe-frame`**；`abort` 走单独一支，按 `PROBE_MAX_FRAMES` / `PROBE_MAX_MS` 封顶，**不按一拍预算截断**；回包（正常和截断两条路）都带 `steps`。
- `'snapshot'` 快照趟：和今天完全一样。

**脚本侧**（`scripts/probe-card-costs.mjs`）：

- 计时趟一次 `render(最后一帧, { jump: true, probe: 'time', maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES })`，拿回逐帧数组。`stepMs = robustStep(steps)`、`stepMaxMs = max(steps)`、`catchUpMs = Σ steps`；封顶没推完的按「除首帧外的中位数 × 剩余帧数」补上。
- 快照趟先 `render(0, { jump: true })` 走重挂载定位配方复位，再逐帧 `render(k / fps, { probe: 'snapshot' })`，三段耗时各取稳健值。逐帧单独发是因为整趟 `render` 的回包只报累计。
- `direct` 卡抽满 `STEP_MIN_SAMPLES` 帧（8 不够就补抽），实测 62 张里那 1 张 `direct` 卡拿到 16 个样本。
- 统计全挪到 Node 一侧，`--json` 里留的是**原始样本**：换系数重算、两次跑比差异都不用重测。旧口径的 `catchUpMs`（已推帧平均 × 总帧数）一并算出来放在 `oldCatchUp` 列做对照。

**自检**（三份数据都查过）：计时趟 `probe-frame` 事件总数 = **0**（确实一帧快照都没生成）；快照趟每卡 40～47 条（40 帧，组合卡有多个控件）。

---

## 6. 实测数字

dev server 在本 worktree 根目录的 **5221** 端口（用完已关，无残留 Chrome）。62 张高频卡，4 秒片段。原始 JSON 在 `scratchpad\r4a-data\`：`fps30-run1.json` / `fps30-run2.json` / `2core-fps60-run1.json` / `2core-fps60-run2.json` / `long20s-fps30.json`（前四份各带 `.log`）。同目录的 `analysis.txt` 是下面这几张表的出处，`analyze.mjs` 是生成它的脚本（不进仓库）—— JSON 里留的是逐帧原始样本，换个系数重算不用重测。

限 2 核那一组：dev server 和探针都由 `cmd /c start /affinity 3` 起，**跑到一半查过 Chrome 进程的 `ProcessorAffinity` 确认是 3**（用户自己那些 Chrome 是 `268435455`，两者分得开）。

### 6.1 `stepMs` 分位数与判重

| | 28 核 30 fps（B = 23.33 ms） | 限 2 核 60 fps（B = 11.67 ms） |
|---|---|---|
| `stepMs`（p90 稳健值）p50 / p90 / max | 1.00 / 1.70 / 3.00 ms（第 2 趟 1.00 / 1.80 / 2.80） | 1.30 / 2.20 / 3.70 ms（第 2 趟 1.30 / 2.20 / 3.90） |
| `stepMaxMs`（单次最大，仅诊断）p50 / p90 / max | 1.90 / 3.10 / 19.90 ms（第 2 趟 1.80 / 3.30 / 17.50） | 3.30 / 36.70 / 93.10 ms（第 2 趟 3.30 / 16.50 / 79.20） |
| **判重张数（新口径 `stepMs > B`）** | **0 张**（两趟都是） | **0 张**（两趟都是） |
| 判重张数（旧口径 单次最大 > B） | 0 张 | **11 张 / 9 张，两趟不一样** |
| 计时趟被封顶的 | 0 张 | 6 张 |

### 6.2 同一配置连跑两次，判重名单是否一致 —— **这是改百分位要解决的问题**

- **新口径（`stepMs` 取 p90）：两种配置、两趟，判重名单都是空集，完全一致。**
- 旧口径（单次最大）在 28 核 30 fps 下也是空集一致；**在限 2 核 60 fps 下不一致**：
  - 第 1 趟 11 张：`mu-blur-fade, scene-3d, odometer, blur-text, checklist, entity-chips, versus-card, focus-card, lottie-bodymovin, lottie-navidad, probe`
  - 第 2 趟 9 张：`scene-3d, odometer, blur-text, entity-chips, rank-bars, focus-card, lottie-navidad, particles-colorAnimation, particles-nasa`
  - 交集只有 6 张，各自有 5 张 / 3 张是对方没有的。
- 逐卡两趟波动（最大/最小倍率），限 2 核 60 fps：
  - `stepMs`（p90）：中位 **1.15×**，最差 2.00×（`lottie-adrock` 0.90 对 1.80）
  - 单次最大：中位 **1.45×**，最差 **13.90×**（`checklist` 93.10 对 6.70）
- 28 核 30 fps：`stepMs` 中位 1.07×、最差 2.43×；单次最大中位 1.09×、最差 2.60×。

结论：`render_pipeline_restructure.md` 2.1(a) 里「张数可信、卡名不可复现」的那三张卡，换成百分位之后连张数都归零了 —— 越线的确实全是偶发的一帧卡顿。

### 6.3 `catchUpMs` 和旧外推值的对比

4 秒片段在两种配置下：

- 28 核 30 fps：没有一张被封顶，新旧值本来就该相等（差 0.99× 是「旧值用已推帧的平均 × 总帧数、总帧数比已推帧数多 1」造成的舍入，不是外推差异）。
- 限 2 核 60 fps：6 张被封顶，新值 / 旧值 —— `lottie-bodymovin` 576.1 对 594.5（旧值高 3%）、`particles-parallax` 450.0 对 460.2、`lottie-navidad` 373.5 对 382.0、`particles-vibrate` 445.5 对 454.6、`probe` 398.5 对 402.0、`focus-card` 374.3 对 375.1。4 秒片段只推了一半上下，差距还不大。

**20 秒片段（fps 30，600 帧，计时趟必被 300 帧 / 500 ms 封顶）**才看得出差别（`long20s-fps30.json`）：

| 卡 | 推了几帧 | 新 `catchUpMs` | 旧外推 | 差 |
|---|---|---|---|---|
| `scene-3d` | 300/600 | 161 ms | 202 ms | 旧值高 **25%**（首帧 16.5 ms 的挂载成本被算进了平均） |
| `lottie-navidad` | 300/600 | 232 ms | 284 ms | 旧值高 **22%** |
| `checklist` | 300/600 | 335 ms | 371 ms | 旧值高 11% |
| `mu-word-rotate` | 300/600 | 257 ms | 273 ms | 旧值高 6% |
| `particles-snow` | 216/600（撞 `PROBE_MAX_MS`） | 964 ms | 865 ms | 新值高 11%（首帧 0.7 ms 反而比其余帧便宜，旧平均被它拉低） |

也就是：旧口径在「首帧贵」的卡上系统性偏大，在「首帧便宜」的卡上偏小；中位数外推两边都纠正了。R1 报告里 1.7～3.6 倍的偏差量不出来了 —— 那是**旧截断判据**（一拍预算、还含生成快照，只推得了 1～10 帧）造成的，现在计时趟起码推 216 帧，外推的那一段占比小得多。

### 6.4 按 K2 三档分出来各多少张

4 秒片段（这个长度谁都追得上）：

| 配置 | `direct` | `catchup-a` | `catchup-b` | `over-catchup` | `capped` |
|---|---|---|---|---|---|
| 28 核 30 fps | 1 | 3（`mu-typing`、`composite`、`mu-animated-shiny-text`） | 58 | 0 | 0 |
| 限 2 核 60 fps | 1 | 0 | 61 | 0 | 0 |

**注意这三档是片段长度的函数，不是卡的属性。** 离线探针不测 `seekOk`，所以纯 CSS / WAAPI 的长卡在这张表里也落在推帧那几档（和 K2 对 `seekOk` 缺席时的兜底一致，是保守的）。

### 6.5 哪些卡被追帧上界判重

4 秒片段下 **0 张**。追帧上界换算成片段长度是 `8 × stepMs / 每帧均值` 秒，实测：

| 配置 | 临界长度 p50 / p90 | 最短的几张 |
|---|---|---|
| 28 核 30 fps | 12.07 s / 13.74 s | `scene-3d` 7.99 s、`odometer` 9.61 s、`mu-blur-fade` 10.09 s、`blur-text` 10.31 s、`particles-gradients` 10.40 s、`particles-orbit` 10.42 s |
| 限 2 核 60 fps | 11.77 s / 14.09 s | `lottie-bodymovin` 6.99 s、`blur-text` 8.11 s、`odometer` 8.18 s、`mu-blur-fade` 8.57 s、`checklist` 8.73 s、`scene-3d` 8.87 s |

和任务书 K2 的「片段长度约 8 秒」对得上（略偏长，因为 `stepMs` 取 p90 比每帧均值大一点）。

**20 秒片段实测验证**（8 张卡，fps 30）：6 张 `over-catchup` —— `particles-orbit`、`particles-snow`、`mu-word-rotate`、`odometer`、`scene-3d`、`checklist`；`lottie-navidad` 恰好卡在界内（232 / (4 × 1.0) = 58 拍 ≤ 60）留在 `catchup-b`；`caption-track` 是 `direct`。**一张 `capped` 都没有** —— 判重全部来自追帧上界，正好是任务书 2.1(a) 结论 (2) 说的「重管线的主要用户是长的、有状态的卡，不是慢的卡」。

### 6.6 落数据

`out/card-costs.json` 有 **124 条**（30 fps 62 条 + 60 fps 62 条，`identityKey` 含 fps 所以两套并存），每条都带 `stepMaxMs`，`device` 串里带 `mode=dev | stepP=0.9 | stepN=16`。`out/` 在 `.gitignore` 里，没有进提交。

---

## 7. 给合并的人：`StageView.tsx` / `stageRpc.ts` 动了哪几行

另一位 Agent（R2）同时在改这两个文件，所以改动**只在 `render` 的探针分支和相关类型里**，没有顺手重排或改格式。按 `6876dd7` 的行号：

**`src/StageView.tsx`**（`git diff` 六个 hunk，合计 +39 / −8）

| 原行 | 改了什么 |
|---|---|
| `:24` 之后 | 加一行 `import { PROBE_MAX_FRAMES, PROBE_MAX_MS } from "./render/pipelineTuning.mjs";` |
| `:392-396` | `render` 的 JSDoc 补两趟的说明 |
| `:406-408` | `const probe = !!opts.probe` 拆成 `probeMode` / `probe` / `timing` 三个；`maxFrames` 的缺省在计时趟变成 `PROBE_MAX_FRAMES` |
| `:430` 之后 | 加 `const steps: number[] = []` 和 `let frameStarted = 0` |
| `:439-446` | `abort` 里加一支 `if (timing) { … PROBE_MAX_MS … }`，原来那一支原样留着 |
| `:446` | `onFrame` 从单表达式改成块，开头加 `if (timing) frameStarted = realNow();` |
| `:450` 之后 | `afterFrame` 里 `frames++` 之后加三行 `if (timing) { steps.push(…); return; }` |
| `:467` | 截断回包加 `...(timing ? { steps } : {})` |
| `:476-477` | 正常回包加 `...(timing ? { steps } : {})` |

**`src/render/stageRpc.ts`**（四个 hunk，+24 / −2）

| 原行 | 改了什么 |
|---|---|
| `:50` 之后（`SnapshotCost` 和 `RenderResult` 之间） | 新增 `export type ProbeMode = "time" \| "snapshot"` 和它的 13 行说明 |
| `:60-61` | `frames?` 的注释「probe 第一趟」改成「探针第一趟…被上限截断」 |
| `:64` 之后 | `RenderResult` 加 `steps?: number[]` + 注释 |
| `:73` 之后 | `RenderAborted` 加 `steps?: number[]` |
| `:106-108` | `RenderOptions.probe` 从 `true` 改成 `true \| ProbeMode`，`maxFrames` 加一行注释 |

R2 那一侧如果在 `RenderAborted.reason` 上加 `'role'`、在 `render` 开头加角色闸门，都不会和上面任何一处重叠。

---

## 8. 对任务书的更正建议（原句 → 怎么做的 → 为什么）

1. **原句**（K2 可调系数）：「由 `vite-plugin-costs.ts` 随 `GET /api/data/costs` 一起回（`{ records, tuning }`）」。
   **怎么做的**：回包改成 `{ ok, device, mode, costs, tuning }`，`costs` 不改名。
   **为什么**：今天的回包就是 `{ ok, device, mode, costs }`，改名要连带改 `probe-card-costs.mjs`、`costs.test.mjs` 和将来的页面侧；而且 `PUT` 的 body 本来就叫 `records`，两个 `records` 含义不同更容易混。加字段效果完全一样。

2. **原句**（K2）：`planPipelines(project, costs, fps, opts?: { deadMs?: number })`，加 `tuning`。
   **怎么做的**：`opts` 再加 `identityKeys` / `frameModes`（clipId → 身份键 / 声明的帧模式，Map 和普通对象都收），并导出 `clipCostIndex(project, graph, sourceVersionOf)` 把「片段 → 节点 → `cardCostKey`」这一段单独封一个函数。
   **为什么**：「成本记录怎么从片段找到」需要**卡片注册表**（`projectCardGraph` 的 `getCard`）和**源码版本**（`ExportView.tsx:108-118` 那套），两样都不是项目数据的一部分。塞进 `planPipelines` 会让它不再是纯函数、Node 和浏览器两端还得各自解决注册表怎么拿。拆出来之后 `planPipelines` 收的全是可结构化克隆的值，两端各自把索引算好喂进去；页面侧在 `ProbeGate` 里本来就要算同一份（探针的「已测过就跳过」用它），预渲染进程侧在 4 帧批边界算一次。**接线是 R5 / R6 的事**，本任务只保证函数在 Node 下可用。

3. **原句**（K1）：「`stepMs` = 这些样本的第 `STEP_PERCENTILE` 百分位」，样本不足怎么办没写。
   **怎么做的**：不足 `STEP_MIN_SAMPLES` 时取最大值。
   **为什么**：见 §1。实测 62 张卡全部达到样本数，这条只在探针被掐断时生效。

4. **原句**（K1）：「到 `PROBE_MAX_FRAMES` / `PROBE_MAX_MS` 封顶没推完的按『首帧实测 + 其余帧中位数 × 剩余帧数』外推」。
   **怎么做的**：`catchUpMs = Σ(已推的每一帧) + 中位数(除首帧外的已推帧) × 未推帧数`。
   **为什么**：字面读「首帧实测 + 其余帧中位数 × 剩余帧数」会把**已经实测到的**那 299 帧也换成中位数，白丢掉已有的数据；而同一条 K1 前半句明写 `catchUpMs` = 各帧之和。两种读法在「已推很多帧」时结果几乎一样，取实测那一种更准。

5. **原句**（K2）：「判重的比较式是 `stepMs × COST_SCALE > B`，K2 贪心里的权重同样乘 `COST_SCALE`」。
   **怎么做的**：`COST_SCALE` 乘在**每一项实测成本**上 —— `stepMs`、`catchUpMs`、`seekMs`。
   **为什么**：3.3 说「`COST_SCALE` 乘在每张卡的实测成本上」，`catchUpMs` 和 `seekMs` 也是实测成本，只乘 `stepMs` 会让「调大 = 更保守」在 (a′) / (a) / (b) 的分界上失效。追帧上界那一步是 `catchUpMs / (4 × stepMs)` 的比值，分子分母同乘、天然不受影响，所以这么做不会改变「8 秒」那条线。单测里有一条专门钉这件事。

6. **原句**（K 节验收）：「6 秒、`stepMs` 1 ms 的 Motion 卡…`w` = 5 ms、走 (b)」。
   **怎么做的**：导出 `clipWeight`，单测直接断言 `tier === 'catchup-b'` 且 `w === 5`。
   **为什么**：`w` 和档位是纯内部量，不导出就只能靠「5 张只装 4 张」这种间接观察去推，验收条目对不上代码。

7. **原句**（K1）：`CardCostRecord` 的字段清单里没有 `stepMaxMs`，但同一节又要求「单次最大另记成 `stepMaxMs`」。
   **怎么做的**：按任务书第 5 条加进类型和记录。
   **为什么**：清单是漏了，两处对不上。

8. **原句**（K1）：`render(…, { probe: 'time' })` 的截断语义没说。
   **怎么做的**：沿用现有的 `{ aborted: true, reason: 'timeout', frames, truncated: true, steps }`。
   **为什么**：不想为此改 `RenderReply` 的形状（R2 也在动这个类型）。**但调用方要知道：计时趟撞到 `PROBE_MAX_*` 是长片段的正常路径，不是错误**，`ProbeGate` 别把 `aborted` 当失败丢掉。建议在 K1 里写明这一条。

9. **原句**（`render_pipeline_restructure.md` 3.3 / 2.1(a)）：「限 2 核、60 fps 时 3 张粒子卡判重」。
   **怎么做的**：按新口径重测，**两趟都是 0 张**。
   **为什么**：那三张是按单次最大判的，而单次最大两趟差 13.9 倍（见 §6.2）。建议把 2.1(a) 那张表和 3.3 的这句话按本报告 §6.1 更新：**现在的卡库里没有一张卡会因为「单帧太慢」判重，判重全部来自追帧上界（片段长度）**。

10. **原句**（K2「可调系数」）：「`STEP_PERCENTILE` / `STEP_MIN_SAMPLES` 变了还要重测（把它们拼进 `device` 串）」。
    **怎么做的**：探针脚本拼了 `stepP=… | stepN=…`。
    **为什么**：没问题，照做。但要提醒：**`ProbeGate` 那一侧（R4 常驻半）必须拼同一串、同样的顺序和写法**，否则两条路测出来的记录互相看不见。建议把 `device` 串的拼法抽成一个共享函数，别让两处各写一遍 —— 本任务没有做（`ProbeGate` 不在范围内）。

11. **一条口径说明**（不算更正）：`planPipelines` 的分段只看**卡片段**（有 `cardId` 或 `nodeId`），纯素材段（只有 `mediaId`）不参与分段也不参与分派。任务书说「所有卡片入点出点」，素材层本来就不被探针测、不进轻重分派（2.1(b) 的缺口另有 3.9 / R1b 处理），这么读是自洽的，但值得写明。

## 9. 没做成的事 / 留给后面的

- **`vtOk` / `seekOk` / `seekMs` 离线仍然不测**（任务书本来就把两趟布尔探针的页面侧划出了范围）。后果是本报告 §6.4 的档位分布对「可定位的长 CSS / WAAPI 卡」偏保守：它们实际应该走 (a′)、各位置都轻、不进预渲染集合，现在被算成推帧卡。等 R4 的常驻探针补上两个布尔之后要重跑一次这张表。
- **`ProbeGate`、后台舞台常驻探针、`setPlan` 下发、K3～K6 的执行**：不在范围，没动。
- **预渲染进程侧调用 `planPipelines` 的接线**（R5 / R6）：没做，只保证函数在 Node 下可用（单测就是在 Node 下跑的）。
- **`out/pipeline-tuning.json` 的写入口**：只做了读（任务书只要求「覆盖值存本机 `out/pipeline-tuning.json`」，改系数是人手编辑这个文件）。没有加 `PUT` 端点，也没有界面。
- **快照趟的「累计墙钟超过 B 就停」在离线脚本里没有实现**：脚本是逐帧单独发 `render`（为了拿逐帧数），一拍预算对它不成立，改成按 `--worst-frames`（缺省 40 帧）封顶。舞台侧 `'snapshot'` 那一支的预算截断照旧，常驻探针整趟推时会生效。
- **构建产物（`--mode build`）上没跑**：宿主页的卡片注册表是 `import('/src/cards/index.ts')` 拿的，只有 dev server 供得起（R1 就有这条，没变）。
