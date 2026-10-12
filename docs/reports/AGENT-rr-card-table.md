# 子 Agent 报告：把卡片的分类登记成一张表（渲染重构「丁」）

分支 `claude/rr-card-table`，工作区 `.worktrees/rr-card-table`，基于 `main`（a556b7bc）。任务见 `docs/plan/render-refactor-task.md` 的「丁」。

「丁」是渲染重构任务书里的一项：把每张内置卡在三个轴上的分类（哪种写法、画在什么上、依不依赖下层）登记进审阅表 `src/cards/capabilities.json`，并用测试守住。

## 做了什么

1. **表里三样登记全。** `src/cards/capabilities.json` 从 42 条变成 50 条，每条都有三个字段：
   - `writing`：哪种写法，`remotion` / `motion`。取自卡的声明（`frameMode` 的 `direct` / `stateful`）。
   - `surface`：画在什么上，`dom` / `canvas2d` / `webgl` / `none`（`none` 是只出声音、没有画面的卡）。
   - `compositing`：依不依赖下层，原来的三个值照旧；另加两个记号 `unknown`（登记了但故意不审）、`fromParts`（组合卡，由部件推导）。
   - 旧字段 `canvasHeavy: true` 留着，画布卡必须同时写（原因见下面「一个要紧的发现」）。
   - 前缀通配照旧：`particles-*` 一条盖 53 张粒子素材封装卡。
2. **补登记。** 任务点名的四张（`av-pulse`、`sound-notification`、`sound-keyboard`、`probe-slow`）补上，分类变了，见下面「补登记的四张」。另有四张原来不在表里但有说明的（`composite`、`r6-unknown`、`probe-css`、`probe-motion-js`）用记号登记，运行时的处理一点没变（摘要比对里它们在「相同」的 97 张里）。
3. **两处读表的地方。**
   - `server/vision-project.mjs`：加了三样的取值表常量和 `reviewedClassification(id)`（把一条登记整理成写法、对应的 `frameMode`、画在什么上、是不是画布卡、轴三）。原来的 `reviewedCapabilities`、`isolateClip` 没动。
   - `src/kernel/frameMode.mjs`：**一个字没改**。它的 `reviewedCard(id)` 本来就把整条原样带出来，新字段读得到（守门测试 CT-05 核对）。不改的原因见下面「一个要紧的发现」。
4. **守门测试** `src/cards/capabilities.test.mjs`（9 条）：枚举注册表里全部内置卡逐张查。
5. **摘要比对脚本** `scripts/probes/card-table-digest-compare.mjs`：对全部内置卡在基准提交和当前工作区各算一遍，逐张比。
6. **`src/cards/capabilities.md` 重写**：字段与取值、101 张的汇总和逐张、两个记号、通配、改表会让哪些键变、新增内置卡时怎么登记。原来写的「默认注册 89 张」「`caption-track` 是唯一的 remotion 式的卡」「表优先，表里没有才读声明」都改掉了。
7. 用户建的卡没有进表。

新增的文件有两个不在任务的文件清单里，属于「守门测试和对应单测」「测试或脚本」的配套，这里写明：`src/testing/loadBuiltinCards.mjs`（在 Node 里借 vite 读出全部内置卡的声明，守门测试和比对脚本共用）、`scripts/probes/card-table-digest-compare.mjs`（硬约束要的比对脚本）。没有碰不许碰的文件，没有改任何卡的源码和声明，没有改 `src/kernel/cardGraph.mjs`。

## 一个要紧的发现：`frameMode.mjs` 改一个字，内置卡的键就全变

任务的硬约束是：除了补登记的四张，别的卡的预渲染结果的键不许变。

卡片的键里除了能力表，还有**源码版本**：`src/render/cardSourceVersion.mjs` 把这张卡的源文件和它一路相对导入到的文件全文拼起来。每张卡都导入 `kernel/types.ts`，`types.ts` 里有一句 `import type { FrameModeInput } from "./frameMode.mjs"`，于是 `src/kernel/frameMode.mjs`（以及它导入的东西）在**每张内置卡的源码闭包里**。`src/kernel/cardGraph.mjs` 也在这个闭包里（脚本 `out/rr-card-table/closure.mjs` 逐个文件走了一遍：`src/cards` 下有 48 个文件走得到这两个文件，各张卡的源文件都在其中）。

实测（在本工作区做的试验，做完已还原）：只在 `src/kernel/frameMode.mjs` 末尾加一行注释，跑比对脚本：

```
内置卡:改前 101 张,改后 101 张;逐张相同 59 张,有变化 42 张
  av-pulse(native): 能力表 同 / 注册表里的定义 同 / 源码版本 变 / 键 变 / 键(定源码) 同
  …（42 张全是「源码版本 变 / 键 变 / 键(定源码) 同」）
✖ 不在 --expect 里却变了的卡 42 张
```

42 张是按 id 找得到自己源文件的卡；另外 59 张（58 张素材封装卡和 `composite`）的源码版本走另一条算法，没变。

所以任务里举的两个做法（「新字段不进摘要」「摘要只取原来那两样」）只要落在 `frameMode.mjs` 或 `cardGraph.mjs` 的改动上，就会从源码版本这一路把 42 张卡的键全换掉，和硬约束相抵。卡片声音的身份（`src/kernel/cardAudioRendition.mjs`）里也有同一个源码版本，`av-pulse` 这类卡已经生成的声音会被判成「已过期，请重新生成」，这是用户看得见的。

因此这次的做法是**这两个文件一个字不动**，代价是表的样子有两处不够干净：

- 表里登记写法的字段叫 `writing`，不叫 `frameMode`。`cardCapabilities` 里有一句旧代码：表里写了 `frameMode` 就拿它盖过卡的声明。如果沿用 `frameMode` 这个名字，用户或 Agent 经改动层改过内置卡的写法之后，表会盖掉新的声明（例如把 `caption-track` 改成有状态，表仍让它按 remotion 式跳帧，画面会错）。换个名字，那句旧代码永远读不到值，写法实际以声明为准。守门测试拦着不许往表里写 `frameMode`。
- `canvasHeavy` 和 `surface` 重复。运行时判画布卡读的还是 `canvasHeavy`，守门测试核对两者一致。

以后有别的改动本来就要动这两个文件、或者本来就要让全部缓存作废时，可以顺手收掉（`capabilities.md` 第 3 节写了怎么收）：`cardCapabilities` 删掉读表里 `frameMode` 的那一句；`canvasHeavy` 由 `surface` 推出，表里的 `canvasHeavy` 删掉。

这件事对渲染重构的其它项也有用：凡是改到 `src/kernel/`、`src/render/` 里被卡片闭包走到的文件（`types.ts`、`frameMode.mjs`、`cardGraph.mjs` 等），内置卡的键都会变，和改没改表无关。

## 补登记的四张：改之前按什么处理，改之后按什么处理

四张都声明成 remotion 式（`frameMode: "direct"`），改前改后写法不变，不产快照这一点也不变（快照档位只给有状态的卡）。变的是轴三：改之前表里没有，按「未知」处理，也就是按下层依赖卡；改之后登记成独立卡。

| 卡 | 是什么 | 改之前 | 改之后 |
|---|---|---|---|
| `av-pulse` | 自家卡：一个随提示音扩散的圆环，同片段有声音 | 轴三未知，按下层依赖卡：不进独立缓存、不进轨道流；Agent 单看这一段时连下层一起渲 | `remotion` / `dom` / 独立卡：判重时可以单独预渲染、可以进独立缓存和轨道流；Agent 单看这一段时只渲它自己 |
| `sound-notification` | 自家卡：只出声音的合成提示音，没有画面 | 同上（它没有画面，这些处理实际碰不到） | `remotion` / `none` / 独立卡 |
| `sound-keyboard` | 自家卡：只出声音的合成键盘声，没有画面 | 同上 | `remotion` / `none` / 独立卡 |
| `probe-slow` | 探针卡：可调成本的色块，只给探针脚本用 | 轴三未知，按下层依赖卡 | `remotion` / `dom` / 独立卡（和它的推帧版 `probe-slow-stepped` 一致，那张本来就登记成独立卡） |

判成独立卡的依据：`av-pulse` 画的是自己的一个带边框的圆环，没有 `backdrop-filter`，不读像素；两张声音卡没有画面；`probe-slow` 和 `probe-slow-stepped` 是同一个组件、同一块色块。

**这四张的键变了**（下面比对结果里列了改前改后的值），原因是能力表里 `compositing` 从 `unknown` 变成 `independent`、`independentCache` 从假变真，能力表整个进摘要。影响的产物：

- 成本记录：`av-pulse`、`probe-slow` 的成本键换了，旧的测量记录不再命中，下次打开会重测一次（一张卡一次）。
- 预渲染结果：这四张是 remotion 式，不产快照；它们原先按下层依赖处理，也没有独立缓存和轨道流。所以没有哪份已经存下的产物因此作废。
- 卡片声音：已经生成的声音不受影响。声音的身份只含卡 id、源码版本、参数和输入，不含能力表（`src/kernel/cardAudioRendition.mjs`），而源码版本没变。
- 开发模式下的运行期兜底（`src/render/capabilityGuard.ts`）现在会看着这四张：量到毛玻璃就降级成下层依赖卡并报警。

## 另外四张用记号登记的（处理没变）

任务说「不在表里又没有说明的四张补上」，剩下四张不在表里但有说明的，验收又要求「全部内置卡在表里三样齐全」。这里把它们也登记进去，用记号表示轴三不是审阅结论：

| 卡 | 登记 | 运行时 |
|---|---|---|
| `composite`（组合卡） | `motion` / `dom` / `fromParts` | 照旧由部件推导（`fromParts` 不是审阅结论，`cardCapabilities` 走原来的推导） |
| `r6-unknown`、`probe-css`、`probe-motion-js`（探针卡） | `motion` / `dom` / `unknown` | 照旧是未知，按下层依赖卡处理 |

守门测试规定 `unknown` 只许这三张写、`fromParts` 只许组合卡写。比对脚本确认这四张的能力表和三个键改前改后逐字相同。

这三张探针卡的源码注释里写着「不进审阅表」（`src/cards/_probe/r6.tsx`、`src/cards/_probe/boolean-probe.tsx`），现在准确的说法是「在表里登记成故意不审」。卡的源码这次不许碰，注释没改。

## 验证结果

### 摘要改前改后的逐张比对

命令：`node scripts/probes/card-table-digest-compare.mjs --json out/rr-card-table/digest.json`，退出码 0。

它对 101 张内置卡各放进一个只有它自己的片段（缺省参数、30 帧每秒、2 秒、1920×1080），走产品里的同一批函数：`projectCardGraph` 摊图，取节点上的能力表，再算节点身份（`cardNodeIdentities`）、共享快照键的内容键（`cardSnapshotIdentity`）、成本键（`cardCostKey`）。源码版本按卡片自己的导入闭包算。「键（定源码）」是把源码版本换成常量再算一遍，只看能力表和节点这一路。

```
基准 main = 31c03966e49d;当前 HEAD = fd834f01373b(src/ 或 server/ 有未提交的改动,算的是工作区)
生成快照的代码指纹:改前 9c3b04430ce0bb2021ee11e8e94c3810 改后 9c3b04430ce0bb2021ee11e8e94c3810(相同)
内置卡:改前 101 张,改后 101 张;逐张相同 97 张,有变化 4 张
  av-pulse(native): 能力表 变 / 注册表里的定义 变 / 源码版本 同 / 键 变 / 键(定源码) 变
      能力表  改前 {"frameMode":"direct","need_prerendering":false,"compositing":"unknown","canvasHeavy":false,"independentCache":false}
              改后 {"frameMode":"direct","need_prerendering":false,"compositing":"independent","canvasHeavy":false,"independentCache":true}
      node     改前 cc2cda87ded1554a  改后 000359398ff9c526
      snapshot 改前 77839422bda1e86e  改后 37aae003004a1617
      cost     改前 8513a7cf02baa  改后 1f4da18f22873e
  probe-slow(probe): 能力表 变 / 注册表里的定义 变 / 源码版本 同 / 键 变 / 键(定源码) 变
      能力表  改前 {"frameMode":"direct","need_prerendering":false,"compositing":"unknown","canvasHeavy":false,"independentCache":false}
              改后 {"frameMode":"direct","need_prerendering":false,"compositing":"independent","canvasHeavy":false,"independentCache":true}
      node     改前 aac5b5bad59bdad5  改后 829d3eff6414c9e1
      snapshot 改前 c6a48164d9366163  改后 3ebe1ab88b015b47
      cost     改前 4d2648dee5fba  改后 18c9ea72ad7a35
  sound-keyboard(native): 能力表 变 / 注册表里的定义 变 / 源码版本 同 / 键 变 / 键(定源码) 变
      能力表  改前 {"frameMode":"direct","need_prerendering":false,"compositing":"unknown","canvasHeavy":false,"independentCache":false}
              改后 {"frameMode":"direct","need_prerendering":false,"compositing":"independent","canvasHeavy":false,"independentCache":true}
      node     改前 b2b3911633172de3  改后 bb8ff9d7952a785b
      snapshot 改前 be770dd3130ec552  改后 3829d2b0ef0396dd
      cost     改前 732ae739dbcf7  改后 1090290ff93983
  sound-notification(native): 能力表 变 / 注册表里的定义 变 / 源码版本 同 / 键 变 / 键(定源码) 变
      能力表  改前 {"frameMode":"direct","need_prerendering":false,"compositing":"unknown","canvasHeavy":false,"independentCache":false}
              改后 {"frameMode":"direct","need_prerendering":false,"compositing":"independent","canvasHeavy":false,"independentCache":true}
      node     改前 9de9370546d5d6e5  改后 9e1e6dea98bff881
      snapshot 改前 b01f32ae0ac62334  改后 45622ebab35e39a7
      cost     改前 de9b0b3f326e4  改后 c42212f9ae687
✔ 只有 --expect 里的 4 张变了,其余 97 张的能力表、源码版本、三个键逐张相同
```

对照：什么都没改时跑（`--expect ""`），101 张逐张相同，退出码 0，说明脚本自己不制造差异。

脚本没有覆盖到的：带部件的组合卡、挂了滤镜或强调的片段、非缺省参数。这些情形下进键的仍是同一个 `cardCapabilities` 的返回，而守门测试 CT-06 看着它对每张内置卡的取值。全工程的代码版本（`server/frame-code.mjs` 的 `frameCode`，把 `src/` 下所有文件一起哈希，整帧缓存和节点分池用）任何提交都会变，不在这次比对里。

### 守门测试

命令：`node --test src/cards/capabilities.test.mjs`，退出码 0，9 条全过。

| 编号 | 查什么 |
|---|---|
| CT-01～04 | 全部内置卡（枚举 `src/cards/index.ts` 注册的四组，101 张）在表里三样齐全；写法和声明一致；画在什么上和卡的声明不打架；表里没有多余的字段、没有 `frameMode`、没有对不上任何卡的键 |
| CT-02 补充 | 声明成 remotion 式的内置卡，表里一张不落 |
| CT-05 | 两处读表的地方查到同一份，新字段都读得到；通配照旧 |
| CT-06 | `cardCapabilities` 的返回仍只有原来五项（新字段不进摘要），取值和登记的一致 |
| CT-07 | `src/cards/index.ts` 注册的还是这四组（多了一组就红，免得枚举不全） |
| CT-08 | 夹具：新增一张内置卡没登记，报出来；登记上就不报 |
| CT-09 | 夹具：表里的写法和声明对不上（改表、改卡两个方向），报出来 |
| CT-10 | 夹具：三样缺一样、取值不认识、只有旧的两样，报出来 |
| CT-11 | 夹具：写了 `frameMode`、画布卡两处不一致、记号用错、对不上任何卡的键，各自报出来 |

**在真表上故意弄错，测试确实变红**（改完当场还原）：

- 把真表里 `caption-track` 的 `writing` 改成 `motion`：退出码 1，报 `[writing] caption-track: 表里登记 motion(stateful),卡的声明是 direct;以声明为准,改表`。
- 把真表里 `av-pulse` 那一条删掉（等于新增了内置卡没登记）：退出码 1，报 `[unregistered] av-pulse: 内置卡没有登记进 src/cards/capabilities.json(同时改 capabilities.md)`。
- 还原后：9 条全过，退出码 0。

### Node 一侧读表的单测

命令：`node --test server/test/vision-project.test.mjs`，退出码 0，4 条全过（原有 2 条，新加 2 条：用真表验证登记成独立卡的单看时不带下层，含补登记的四张；登记成下层依赖、两个记号、表里没有的照旧带下层）。

### 基线

- 类型检查：`npx tsc -b --force`，退出码 0，零错误。
- 全量测试：见文末「全量测试的情况」。

## 没做成的及原因

见文末「全量测试的情况」。其余各项都做了。

## 我做的裁定

都是实现层面的选择（用户看不出区别的那一层），没有改语义文档，列在这里给主会话审。

1. 〔裁〕表里登记写法的字段叫 `writing`、取值 `remotion` / `motion`；画在什么上的字段叫 `surface`、取值 `dom` / `canvas2d` / `webgl` / `none`。字段名和取值是我定的。`writing` 不叫 `frameMode` 的原因见「一个要紧的发现」。
2. 〔裁〕`src/kernel/frameMode.mjs`、`src/kernel/cardGraph.mjs` 不改，接受 `canvasHeavy` 和 `surface` 并存。原因同上。
3. 〔裁〕四张有说明、原来不在表里的卡用记号登记（`unknown`、`fromParts`），不留在表外。这样「全部内置卡在表里三样齐全」对每一张都成立，新增内置卡没有「可以不登记」的口子。另一种做法是测试里留一张豁免名单；要换成那种，删掉表里这四条、在守门测试里加名单即可，运行时没有区别。
4. 〔裁〕补登记的四张的轴三判成独立卡；两张声音卡的 `surface` 登记成 `none`。依据见上表。
5. 〔裁〕表里那条 `mu-animated-shiny-text` 保留。它现在是随仓库带的一张 `src/cards/user/` 下的卡，不在内置四组里；删掉它会让这张卡从独立卡变成未知。守门测试把它列为已知的例外，三样照它的声明填。

## 对任务书或语义的更正建议

1. **`docs/plan/render-refactor-task.md`「丁」的验收**里说键的来源是「卡片的分类会进卡片身份的摘要」。建议补一句：键里还有源码版本，`src/kernel/frameMode.mjs`、`src/kernel/cardGraph.mjs`、`src/kernel/types.ts` 都在每张内置卡的源码闭包里，改这些文件的文字本身就会让内置卡的键变。戊、己、庚的契约写「旧的预渲染结果怎么作废」时用得上。
2. **`docs/semantics/mechanism/cards.md`「分类以审阅表为准」**（任务书「语义文档要跟着改的」第 8 行）：照任务书的「修改后」改即可。建议同时把第二条「审阅表没有覆盖到的卡，一律按下层依赖卡处理」补成「审阅表没有覆盖到的卡，以及表里登记成故意不审的卡，一律按下层依赖卡处理」。画在什么上建议写明四种取值里有「没有画面」（只出声音的卡），现在的轴二只写了 DOM 卡和 canvas 卡。
3. **卡片源码版本把类型导入也算进闭包。** `cardSourceVersion.mjs` 的导入正则不区分 `import type`，所以 `types.ts` 里一句类型导入就把 `frameMode.mjs`、`cardGraph.mjs` 拖进了每张卡的身份。要不要让类型导入不进闭包，可以记进 `docs/plan/TODO.md`；改它本身会让全部内置卡的键变一次。
4. **`src/cards/_probe/r6.tsx`、`src/cards/_probe/boolean-probe.tsx` 的注释**写「不进审阅表」，现在是「在表里登记成故意不审」。这次不许碰卡的源码，留给之后顺手改（改注释同样会让这几张探针卡的键变）。
5. **全量测试里有文件写死了端口 5860～5869**，和分给子 Agent 的端口段撞上，见下一节。

## 全量测试的情况

（进行中）
