# 报告：第二段块 N（浏览器节点认领用户卡与图卡）与在线探针修复

分支 `claude/online-cards-n`，起点 3820592c（块 T 完成）。执行：sonnet-dev-high（接手上一个被中断的子 Agent，它只留下了建档与 online-user-cards-probe 的一处修改，结论我都自己重跑验证过）。

## 一、探针：起点代码上过不过、根因、怎么修的

### 根因

**在线页面加入没有内容的项目会被拒**。`git log -S"initialize: options.initialize === true" -- src/editor/sync/syncManager.ts` 只命中 `dce4b22b`（2026-10-04「持久保存协作关联和身份并补齐主机登记与流式中继」）：此后在线页面加入共享项目一律 `initialize: false`，服务端没有项目内容就拒绝，不再拿本地那份去盖。这是**产品的既定行为，不是缺陷**（防止成员页把空项目写成项目内容）；探针用 `createSharedProject` 建出来的项目是空的，所以页面等不到 `[data-pc="members-button"]`、显示「连不上服务器」。没有改任何产品代码。

修法：建项目后先替创建者写进一份空项目内容（`project.open` + `project.op` 的 `set` 根），再让页面加入。共用的一份在 `scripts/probes/lib-seed.mjs`（`seedSharedProject`）。

### 每个探针在起点代码上的结果与处理

| 探针 | 起点代码上 | 原因 | 修了什么 | 修后（起点代码 / 本分支新构建） |
|---|---|---|---|---|
| `online-user-cards-probe` | 不过：卡在加入项目 | 上面的根因 | 上一个子 Agent 的提交 `8d1bdfa7`（`seedProject`，我复跑验证） | 起点：`ok:true, fails:[]`，退出码 0；本分支：同 |
| `c10-ui-probe` | 不过：`members-button` 等待超时（我在修之前复跑过，退出码 1） | 同上 | 建项目后 `seedSharedProject` | 起点：`ok:true, fails:[]`；本分支：`ok:true, fails:[]` |
| `m7-node-probe` | 与上一条同一路径（建空项目 → 页面加入），**我没有在未修的代码上单独跑它**，按代码路径判不过 | 同上 | 同上 | 起点：`ok:true, fails:[]`（19 s）；本分支：`ok:true, fails:[]` |
| `c10-browser-probe --user-card` | **本身不受这个问题影响**（创建者是真桌面编辑器，项目有内容）。完整跑：user-card 一步过（层表里有那一层、成员页贴上快照），但 **A5（独立渲染主机认领清单计划并切分）超时**、「认领的节点与页面环境不同」两条失败，`ok:false`；这与用户卡无关，是本机上独立渲染主机一步的起点状态 | A5 与本任务无关，未深究 | 没改 | `--only-a4`（跳过 A2 重开与 A5）：起点 `ok:true, fails:[]`；本分支 `ok:true, fails:[]`。完整版 A5 在起点就挂，**请主会话知道：这一条起点就红，不是我的改动**，我没有在本分支重跑完整版 |
| `m7-browser-probe` | 过：退出码 3（没有 fail、只有 pending），17 项里 M7-A1～A3、A6～A11、D9、D10、D14、D1-D2-D12 pass；A4、A5、A12、W7 是带耗时门槛或要跨机的 pending（「待笔记本复核」，不是失败） | 创建者是真桌面编辑器，不碰空项目这个问题 | 没改 | 起点：同上；本分支：fails 空、逐项状态与起点完全相同 |
| `m7-bake-probe`、`m7-bake-node-probe`、`m7-build-probe`、`m7-upload-probe`、`m7-visibility-probe` | 没跑 | 这几个是 M7 当年在实验分支上的取证脚本，用法里要实验分支的检出目录或帧目录，不是验收探针 | — | — |

### 按第二段新语义要改、这一轮**没改**的断言清单

照契约第 11.3 节原样转列（行号以起点为准），实现舞台一侧接线（块 L/G 合流）时一起改：

- `online-user-cards-probe.mjs`：441～447、465、524、526～527、578、580、595～605、656～657、671～672、476（同步卡能运行后变活组件、徽标与图标挪到故意运行不了的 `probe-broken-card` 上；697、706 低内存档不变）。当前 stage 没接线，这些断言都还过。
- `c10-browser-probe.mjs --user-card`：1757（去掉「页面一律按重卡」标签，预置成重）、1776～1777（前提改成判重且成员页不当节点）。
- `c10-ui-probe.mjs`：A6 不用改，只要把用户卡的成本预置成重。
- `m7-browser-probe.mjs`：1004、1006 不变（替身节点仍报 `userCards:false`）；1247～1248、1262、1927 把 `userCard` / `graphCard` 从「认领 0 次」禁止清单挪到「页面有对应代码身份才认领」两组新断言。
- `m7-node-probe.mjs`：无相关断言。
- 其它单测与探针（`online-stale-layer-probe`、`desktop-auto-node-probe`、`onlineUserCards.test.mjs`、`c10a-l17-lowmem.test.mjs`、`c10-ui-gates.test.mjs`）：本轮 `npm test` 全过，没有因为块 N 要改的。

## 二、块 N 做了什么

### 服务端

| 文件 | 改动 |
|---|---|
| `server/render-node/fingerprint.mjs` | 加 `cardRuntimeOf`、`cardEnvFingerprintOf`、`describeCardEnvironment`。`cardEnvFingerprint = sha256(三项环境值 + "\ncard-runtime:" + 运行时版本)` 前 16 位；原文比 `envFingerprintOf` 多一行带前缀，永远不会相同。`envFingerprint` 与 `resultKeyOf` 一个字没动 |
| `server/docservice/modules/render-queue.mjs` | 只改 `admitNodeHello`（和一行 import）：浏览器节点报的 `cardRuntime` → 服务端算 `cardEnvFingerprint`，自报的不作数；别的 profile、没有 `environment` 的连接一律去掉这一项。**第三段也在改这个文件，请合流时注意只有 `admitNodeHello` 这一处是我的** |
| `server/render-queue/messages.mjs`、`index.mjs` | `node.hello` 解析认 `cardEnvFingerprint`；清单计划的 `input.browser` 规整（`browserCardsOf`：指纹 16 位小写十六进制、卡片 id 升序、各有长度上限、最多 500 张）、签名含它（`browserCardsSig`，`backfillSig` 多一个可选参数，不带时与原来逐字相同）；`clipsPlanTaskOf` 带 `browser` |
| `server/render-queue/queue.mjs` | 节点记录多 `cardEnvFingerprint`（只有 browser 有）、`node.welcome` 带回；`nodeFpFor(node, task)`：浏览器节点对 `requires.userCards/graphCards` 的任务用它，没有它就对不上任何指纹（`NO_CARD_RUNTIME`）；前置过滤、认领的指纹检查、锁闲置判断用它；plan 的认领回包多带 `browserCardEnvFingerprints`（文档服务确认的在线本人浏览器节点）。内置卡的任务与别的 profile 一个字不变 |
| `server/render-node/filter.mjs` | 规则 1：浏览器节点接用户卡、图卡任务时比 `cardEnvFingerprint`；规则 7 加：这类任务 `cardSources` 为空就不接 |
| `server/render-node/split.mjs` | 新增 `browserCards`、`browserCardEnvFingerprints` 参数；`browserEligible` 去掉「不是用户卡图卡」，改为 `cardCodeAllowed`；用户卡、图卡的浏览器那份用页面的 `cardEnvFingerprint` 出键，要页面自报与文档服务确认对得上、能力位和代码身份齐。画布卡、Lottie、本地档、超限、重度等其它条件不动 |
| `server/render-node/local-node.mjs`、`session.mjs`、`task-runner.mjs` | 把清单计划的 `input.browser` 与 `browserCardEnvFingerprints` 带到 `splitPlan` |

### 页面

| 文件 | 改动 |
|---|---|
| `src/online/nodeCardInfo.ts`（新） | 登记处：本页能运行的卡（运行时版本、能力位、卡片 id → 代码身份）、文档服务给的 `cardEnvFingerprint`、图形能力位；换代后 `NODE_CARD_SETTLE_MS`（1500 ms，与桌面 `CARD_CODE_SETTLE_MS` 同值）内不报 |
| `src/editor/nodeCardInfoLive.ts`（新） | 按注册表的运行状态（`ready` 才算）、闸门、同步表，用块 T 的 `codeIdentities()` 现算身份写进登记处；转译器那一块按需载入，桌面构建剪掉（`npm run build` 产物里没有 transpile 块） |
| `src/editor/sync/onlineCardSources.ts` | 只加 `activeCardSourceReader()`（让上面那个模块读到同步来的源码） |
| `src/online/browserNode.ts` | `node.hello` 能执行时多报 `cardRuntime`；记 `node.welcome.cardEnvFingerprint`；能力位与 `cardSourceVersions` 每拍随登记处更新；运行时版本晚到（闸门晚于报到才立起来）就重新报到一次；诊断多 `cardEnvFingerprint`、`cards` |
| `src/online/planPublisher.ts` | 本页有能运行的卡且节点拿到了 `cardEnvFingerprint` 时，清单计划多带 `input.browser`、签名含它；登记变了重发；页面与队列侧两份实现逐字段相同（单测对拍） |
| `src/editor/browserNodeHost.ts` | 把登记处接给 `createBrowserNode`，起 `nodeCardInfoLive`，下线时清掉 `cardEnvFingerprint` |

### 没有动的（别的块）

`src/online/cardRuntime/*`、`src/kernel/registry.ts`、`package.json`、`src/editor/Preview.tsx`、`src/StageView.tsx`、`src/render/stageRpc.ts`、`vite.config.ts`。`render-queue.mjs`（文档服务模块）里没有挪动已有代码块。

## 三、与契约不一致或补充的地方

1. **`input.browser` 之外加了一道确认**：契约第 7 节第 3 条只写「页面发布清单计划时在 `input.browser` 里带 `cardEnvFingerprint` 与 `cardSources`」。页面自报不可信，所以另让队列在 plan 的认领回包里给 `browserCardEnvFingerprints`（文档服务确认的在线本人浏览器节点），切分方两边对得上才出浏览器那一份。契约里「切分方不读 `planTask.input.browser`」那句对指纹仍成立（浏览器的 `envFingerprint` 仍以文档服务为准），只是用户卡、图卡这一路读了页面自报的卡片清单。
2. **没声明运行时版本的浏览器节点，队列侧就看不见用户卡、图卡的任务**（原来是看得见、靠节点侧能力位拒绝）。原因：同一台机器上它的 `envFingerprint` 与桌面那份相同，不挡的话它会看见桌面那份。这是对队列行为的一处收紧，请主会话知道。
3. **「浏览器只收独立卡」的现实后果**（契约第 2 节末的更正建议已经预告）：`cardCapabilities` 只认审阅表里的 `compositing`，没进审阅表的用户卡是 `unknown` → 判重 → 永远不出浏览器那份。所以实际能被浏览器认领的只有**审阅表里标了独立**的用户卡（如 `mu-animated-shiny-text`）。用户在桌面新建的卡要先审阅。建议主会话把「审阅表里用户卡的条目也同步」另立一项（契约第 2 节同一条）。
4. **图卡任务体积**：见下一节。
5. 契约第 7 节第 1 条「节点报 `capabilities.userCards: true`」：实现里只在文档服务回了 `cardEnvFingerprint`、本页有运行时版本时才报，旧队列上不声明能力。
6. 页面一侧的整条接线（登记处 ← 注册表运行状态 ← 舞台报告）要等块 T 的加载器挂到舞台、块 S 的隔离闸门立起来之后才有数据；现在 `cardExecAvailable()` 缺省为假，所以线上行为与起点相同。合流时要确认：舞台报的状态进了 `registry.setCardRunStates`、`setCardExecGate` 被调、块 G 调 `setNodeGraphCapable(true)`（缺省图形能力「不够」，不报 `graphCards`）。

## 四、图卡整屏快照体积

`scripts/probes/lib-graph-snapshot-size.mjs`：真 Chrome 里画 1920×1080 的画布，按快照里 `rasterizeCanvas` 的写法（PNG data 地址 + 标签）量：

| 内容 | 快照大小 |
|---|---|
| 纯色底加几块纯色矩形与文字（下界） | 74 KB |
| 渐变加色块与圆（合成、叠图形一类） | 2204 KB |
| 渐变加大面积细节 | 1997 KB |
| 照片感（多层噪声，接视频输入源的样子） | 6545 KB |

与 M7 的上限比：DOM 卡 300 KB、画布位图 1 MB（`snapshot-store.mjs`）。**除了几乎纯色的图卡，典型图卡整屏快照在 2 MB 以上，既超 300 KB 也超 1 MB**；加上图卡一般按画布卡标 `canvasHeavy`（切分与规则 7 本来就不给浏览器），图卡任务实际上基本不会被浏览器认领。我没改上限，也没放宽 `canvasHeavy` 的排除；要不要为图卡单开上限或改用 WebP/JPEG 等更小的编码，是队列契约的改动，**交主会话定**。

## 五、轻量验收

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| `npm test` | 4461 项（起点 4448 + 新增 13），4460 通过、0 失败、1 跳过（起点同样 1 跳过）。中途一轮有 1 项 `server/test/artifact-push.test.mjs` 的 W4（带耗时的推送续传）在机器同时跑探针时失败，单独重跑 7 项全过。**最终全量（所有提交之后、探针都跑完时）：4461 项、4460 通过、0 失败、0 取消、1 跳过，退出码 0** |
| `npm run build` | 退出码 0；产物里没有转译器那一块（`transpile` 文件 0 个） |
| `npx vite build --mode online` | 退出码 0；`transpile.browser-*.js` 一块 |
| 新增单测 | `server/test/online-card-n.test.mjs` OCN-01～07；`src/online/nodeCards.test.mjs` OCN-08～11（含 OCN-09 三条），共 13 条，全过 |
| 内置卡结果键不变 | OCN-01：十一份切分输出（含锁、接手、补渲、改源码、本地素材、流、同机浏览器指纹等）、**57 个结果键**，任务数、摘要、逐个键与改动之前的字面值（`server/test/online-card-n-golden.json`，在改代码之前用起点代码生成）逐个相同；输出行：`OCN-01 比对了 11 份输出、57 个结果键,全部与改动之前相同` |
| 队列相关既有测试 | `m7-split / m7-node-rules / m7-queue / m7-page-node / env-fingerprint-keys / render-queue-prefilter / render-node-logic / render-node-session / planPublisher / browserNode / browserNodeActive / queue-node-wiring` 共 229 项全过（后又随全量跑） |
| 探针 | 本分支新构建：`online-user-cards-probe` ok；`c10-ui-probe` ok；`m7-node-probe` ok；`c10-browser-probe --user-card --only-a4` ok；`m7-browser-probe` fails 空（与起点逐项相同）；`online-card-node-probe` 见下 |

### 新增单测逐条

- OCN-01 内置卡切分与结果键与改动前逐个相同（57 键）
- OCN-02 `cardEnvFingerprint`：与 `envFingerprint` 永不相同；运行时版本、环境变了都变；不合格版本串没有指纹；同一台机器上桌面与浏览器结果键不同
- OCN-03 文档服务 `node.hello`：服务端算 `cardEnvFingerprint`、welcome 带回；自报的不作数；pc 与没有环境值的连接没有这一项；`describe()` 诊断
- OCN-04 节点侧过滤：只认本人、不要转码、不认流、指纹按 `cardEnvFingerprint`、代码身份与能力位、`cardSources` 为空不接；桌面节点不受影响
- OCN-05 切分：用户卡与图卡的浏览器那份、键与桌面不同；页面没声明能力、身份对不上、文档服务不确认、锁在桌面上、本地档、画布卡、超限等情形不多出一份；内置卡不受影响
- OCN-06 队列：前置过滤、认领、谁先认领谁得锁、桌面那份作废、锁拒绝再发布、plan 回包带 `browserCardEnvFingerprints`、旧页面看不见这类任务、内置卡照旧
- OCN-07 清单计划的 `input.browser`：规整、同内容同签名、变了换计划、不带时逐字相同、入站校验
- OCN-08 登记处：只有 ready 且身份算得出的卡登记、换代后一小段时间不报、到点通知
- OCN-09（三条）`browserNode`：hello 多报运行时版本（不带指纹）、welcome 的 `cardEnvFingerprint`、用户卡任务按它认领（身份对不上、无图形能力、桌面那份指纹、别人的都不认领）、晚到的运行时版本重新报到、旧队列不声明能力
- OCN-10 `planPublisher`：与队列侧两份实现逐字段相同、登记变了重发、不能运行时逐字相同
- OCN-11 整条链路（真文档服务模块 + 真队列 + 真 `createLocalNode` 切分 + 真 `createBrowserNode`，替身渲染结果）：页面发带 `input.browser` 的清单计划 → 同机桌面切分出两份、结果键不同 → 本人的浏览器节点认领、六帧都由它生成、完成 → 桌面那份作废、锁在 `cardEnvFingerprint` 上 → 层表 v 3 候选里有浏览器那份，`layerRefOf` 按「活着」认定就贴它（别的成员贴得上）；代码身份是另一版的页面与别人的页面认领 0 次

## 六、端到端探针 `scripts/probes/online-card-node-probe.mjs`

验收标准写在文件头，对应任务书第 16 条每一句（A-0～A-6）。本机用法 `--dist <在线构建> --base-port 5780`。**★ 标的断言要等舞台一侧接线合流才能过**：块 T 的加载器还没挂到舞台、隔离闸门没立，卡片在本页到不了 `ready`，节点报不出 `cardRuntime`、`cardEnvFingerprint`。

本分支新构建上的运行结果：退出码 0（`ok:true`，`wiringComplete:false`）。不依赖接线的 A-0 全过（页面当节点、报到拿到 `envFingerprint`、`cardEnvFingerprint` 为空、内置卡路径不变；探针里的建项目、写内容库、切分方在同一台机器指纹上起、层表 v 3 的写法都跑通了）；★ 断言 10 条记入 `pendingFails`（卡未 ready、清单计划不带 `input.browser`、认领 0 次、层表候选只有一份、乙贴不上等），带 `--strict` 时它们算失败。

等接线后要核对的：A-1（认领并完成）、A-2（内容库清单、素材服务块、层表候选、乙按层表贴上）、A-3（丙的任务甲不认领）、A-4、A-5（结果键不串）、A-6（图卡）。A-4（转码、流）清单计划不切流，探针里造不出，逐条断言在 OCN-04 与 `m7-browser-probe`。

## 七、没做成的

- 舞台里真正执行用户卡、图卡的接线（别的块），所以第 16 条的端到端只做到 A-0，其余靠单测与「替身渲染结果」的 OCN-11。
- 完整版 `c10-browser-probe`（含 A5）本分支没重跑：起点就红（见第一节）。
- 图卡端到端（块 G）。

## 八、对任务书与契约的更正建议

- 第 17 条点名的探针里，起点就不过的是三个会建空项目的（`online-user-cards-probe`、`c10-ui-probe`、`m7-node-probe`），根因是 `dce4b22b`；`c10-browser-probe` 的 A5 与 `m7-browser-probe` 另说。
- 契约第 7 节第 3 条的 `input.browser`：补上 `browserCardEnvFingerprints` 的确认；清单计划签名带 `input.browser` 的摘要（否则卡换代后同一份清单不会重切）。
- 契约第 2 节末：审阅表不同步使「没审阅的用户卡永远是 unknown → 判重 → 不给浏览器」，用户卡在线认领的实际范围由审阅表决定，建议立项同步。

## 待补

无。队列相关探针（`queue-mode-probe`、`render-queue-e2e`）本轮没跑：队列改动只在浏览器节点与用户卡、图卡任务这一路，既有队列单测（render-queue-*、m7-*、card-lock-*、c10-*）随 `npm test` 全过，M7 的两个浏览器探针过了。
