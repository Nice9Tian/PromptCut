# AGENT 报告：在线浏览器模式的用户卡（claude/online-user-cards）

分支 `claude/online-user-cards`，worktree `.worktrees/online-user-cards`，起点 `3b08160d`（语义与 `c10-contract.md` 第 9 节已按 2026-09-29 用户定的新语义改好）。端口段 5740～5749。

代号说明：「C10-A6」是 C10 契约第 20 节验收表里「用户卡、图卡」那一条；「A7」「A8」是同表的置灰 / 离线提示、`POST merge` 回 501 两条；「〔裁〕」是开发会话按规则自行裁定、待用户审的改动。

## 状态

实现、单测、在线探针、真端到端都已完成并通过（见「验证」）。等主会话审查、在 PC 上跑导出像素基线。

## 缺陷与根因（复述）

在线包的卡片表是构建时从 `src/cards/user` 生成的；用户桌面卡片库里的卡、经内容库同步的卡都不在表里，在线构建又关掉了页面侧的卡片同步。`needsLocalPc` 查不到 id，判成「不是用户卡」，舞台不画（`Stage` 取不到定义就 `return null`），时间轴只写「未知卡片」，两条提示都不出。

## 做了什么（按任务书 1～10 条）

1. **注册表「已知但本机不能运行」**（`src/kernel/registry.ts`）：另建同步表 `setSyncedUserCards / syncedUserCards / syncedUserCardsGen / onSyncedUserCardsChanged`，条目 `{ id, name, source }`；不进主注册表，`allCards()`、`getCard()` 看不到。`isUserCardId(id)` = 构建时的 `fileOf` 或同步表；`knownCardName(id)` = 构建时定义的名字 → 同步表的名字 → null。和构建时卡片 id 撞车的同步条目在查询时忽略（内置赢）。各处就地的 `isUserCard` lambda 全部换掉：`Stage.tsx`、`Preview.tsx` 三处、`snapshotFeed.ts`、`ClipView.tsx`，另有 `StageView.tsx` 的 `settleLowMemory` 一处（任务书没列，grep 出来的）。`needsLocalPc` / `unsupportedHere` 的第三参改成可选、缺省 `isUserCardId`。
2. **在线页面读卡片源码**：`src/editor/sync/onlineCardSources.ts`。经页面已有的 `docRequest`（在线来源同一条连接，不走 `/api`）`content.list({ kind: 'card-source', prefix: 'src/cards/user/' })`，只认 `src/cards/user/<名>.tsx`（与 `user/index.ts` 的 glob 同形），哈希变了的逐条 `content.get`，`parseCardSource` 解析后写进同步表。跟变化选**定时重取**（5 秒一列，哈希没变不取正文）：内容库的 `content.watch` 按连接只认最后一次那一组，同一条连接上别的订阅方会互相顶掉；会话接续时也不用补订阅。连接换了（重连、换项目、离开共享项目）清表重取；取不到时表不动。表变了经新 RPC `setSyncedUserCards` 发给两个舞台（握手时也发一次）。
   - 解析器 `src/kernel/cardSourceParse.mjs`（纯函数，不执行源码）：带一个够用的 TSX 词法器（字符串、模板含 `${}` 嵌套、注释、正则、JSX 文字里的撇号、TS 泛型），判据照 `isCardDef`（具名导出 / 默认导出 / `export { a as b }` 的对象字面量，字符串 `id`、`name`，有 `defaults`、`controls` 与 `Component` / `card` / `audio`），认同文件顶层字符串常量与同文件对象的展开。
3. **时间轴**（`ClipView.tsx` + 纯函数 `src/editor/timeline/localPcBadge.ts`）：标签 `clipCardLabel(knownCardName(id))`；徽标 `showLocalPcBadge({ online, localOnly, coverage })`，三者同时成立才出。覆盖来自在线来源新加的 `OnlineSnapshotSource.coverage(clipId)`（`none` / `partial` / `full`，按清单里这一档的帧判：普通档 `frames`、低内存档 `small`），经 `src/editor/onlineCoverage.ts` 订阅，覆盖变了重绘。为了判整段，`coverageLayer` 点名的层（本机跑不了的卡）窗口外的段清单也取（5 秒一轮、一轮至多 16 份）。两边都没有的 id 只标「未知卡片」。
   - **徽标文字**按主会话转达的用户新定（2026-09-29）改为「需要本地 PC 渲染辅助」：`pageFlag.ts` 的 `ONLINE_CUSTOM_CARD_TEXT` 直接引用 `placeholder/contract.ts` 的 `UNSUPPORTED_TEXT`，不另写一份。
4. **舞台**（`Stage.tsx`、`StageView.tsx`、`placeholderHost.ts`）：`localOnly = onlineBrowserMode() && unsupportedHere(cardId, def)`（同步卡没有定义也认）。这些片段不挂组件、不挂 gl 平面，包裹层照挂快照平面、流平面、占位槽位。槽位不再带 `PLACEHOLDER_FIXED_ATTR`，默认 `hidden`，进显隐调度：`placeholderWanted` 新增 `unsupported` 集合（`StageView` 按「本项目里本机跑不了的片段」记忆化、按当前时刻筛在场的），这些片段贴着快照或流就不显示，否则一律 `unsupported`（no-data / awaiting / catching-up 都换成它），`Stage` 给这些槽位的组件 `reason="unsupported"`（图标，不是沙漏）。`applyPlaceholders` 去掉对常驻槽位的跳过。两边都没有的 id 照旧不画。停下时 `routeSettle` 跳过它们（没有组件可追）。
5. **普通档投递**（`snapshotFeed.ts`）：删 `exemptOnline`，改为 `localOnlyOf(project)`：这些片段不管分派表怎么判都按重卡（播放中抑制、选帧、报缺口、取字节）；暂停态的「已精确」（`settled` / `settledAll`）对它们不成立，所以停下不追、快照照挂。K5 第二路暂停态互换（整台精确）之后，`stageSwap.ts` 在有这种片段时补一次带 reset 的投递，把它们的快照重新挂上（桌面没有这种片段，这一步不发，原来的 `setSnapshots({}, { reset })` 照旧）。快照来源的 `skipLayer` 删掉。
6. **普通档清单计划**（`Preview.tsx` 的 `clips()`）：不再去掉这些片段。`costIdentity.ts` 的 `clipIdentityOf` 在线时**不给这些片段身份**（`identityKeys` / `frameModes` / `capabilities` 都去掉；记忆化键加上模式与同步表代数），于是：测量不测它们；分派表查不到成本记录、查不到声明的帧模式，一律 `declared-heavy` 进 `prerenderSet`（L2 里以前在后台舞台上测过的判轻旧记录也不认）；舞台拿不到身份、`needsBackCatchUp` 查不到记录，停下不追；共享成本转写不转它们。同步表变了 `planDispatch` 重算重发。没有定义的同步卡沿线（图、身份、界限搜索）都不崩（单测与探针核过）。
7. **低内存档**：`missingLayers` 去掉 `unsupported` 参数与跳过（判重、没产物就进补渲清单）；`Preview.tsx` 里对应参数删掉。`lowMemorySettle.ts` 的 `unsupported` 种类照旧不追，注释改成「有小尺寸就贴，没有才出图标」（显隐由舞台占位调度管）。`lowMemorySearch` 的 `forcedHeavy` 保留（`unsupported` 回调改用缺省判法）。
8. **测试**：改写 `server/test/c10-kit.mjs`（表 A 文案换成新徽标文字、旧文字进「不再出现」）、`server/test/c10-ui-gates.test.mjs`（C10-UI-03/04 按新语义，含同步卡）、`src/editor/snapshotFeed.test.mjs`、`src/render/onlineSnapshotSource.test.mjs`（skipLayer → coverage）、`src/render/placeholderHost.test.mjs`、`src/render/c10a-l17-lowmem.test.mjs`、`src/editor/c10a-l17-backfill.test.mjs`、`src/render/c10-cost-plan.test.mjs`。`src/render/placeholder/placeholder.test.mjs` 不用改（组件长相没变，全过）。新增：`src/kernel/cardSourceParse.test.mjs`、`src/kernel/registrySynced.test.mjs`、`src/editor/onlineUserCards.test.mjs`（身份、计划清单、标签与徽标判定、卡片源码同步）、`src/render/stageLocalOnly.test.mjs`（舞台服务端渲染核 HTML）。
9. **在线探针**：新建 `scripts/probes/online-user-cards-probe.mjs`（新 A6 的完整断言，见「验证」），`c10-ui-probe.mjs` 的 A6 改成新语义下仍成立的那部分（照取清单与字节、清单覆盖齐不挂徽标、片段照常可选中改参数移动），`TEXT.custom` 换新文字。`c10-cost-probe.mjs`、`c10a-demo-probe.mjs` 里认 `data-pc-placeholder-fixed` 的判法改成「显示着、原因是 unsupported 的槽位」（没跑这两个探针，只改判法）。`src/online/planPublisher.ts` 的 `debug()` 加 `lastClips`（上一次发成的片段清单，探针核用）。
10. **真端到端**：给 `c10-browser-probe.mjs` 加了 `--user-card`（另放仓库用户卡，核成员页清单计划含它、桌面节点渲出后成员页贴上、图标与徽标撤掉）。结果见「验证」。

## 桌面路径不变怎么保证

- `Stage.tsx` 的改动全部挂在 `localOnly = onlineBrowserMode() && …` 上；它为 false 时每一支的条件与以前等价（原 `unsupported = placeholders && unsupportedHere(...)` 在模式关着时也恒为 false），DOM 逐字相同。`onlineBrowserMode()` 只由 `StageView`（`ONLINE` 或舞台地址 `platform=browser`）和 `Preview` 打开；导出页（`ExportView`，含在线导出）、预渲染、Agent 的查询渲染从不打开。
- 实验核对（不入库）：把 `3b08160d` 的 `Stage.tsx` 暂放成 `Stage.old-experiment.tsx`，同一份时间轴（30 张卡：全部内置卡、仓库用户卡、一张图卡，外加同步卡与未知 id）在「导出（不传平面）/ 预览（快照、抑制、流、等快照）」× 「占位开 / 关」× 三个时刻下服务端渲染，新旧 HTML 比对：**模式关着 12/12 逐字节相同**，模式开着 12/12 不同（预期）。实验文件已删。
- 父页一侧：`localOnlyOf`、`localOnlyClipIds`、`clipIdentityOf` 的去身份、`stageSwap` 的补投都在模式关着时是空集合 / 原路；`setSyncedUserCards` 只在 `ONLINE` 时发；同步表桌面不设。
- 没改生成快照的输入：`createSnapshot.ts`、`snapshot/*`、`snapshotRename.ts`、`server/bakery/*`、`frame-pipeline.mjs`、`frame-identity.mjs`、`frame-code.mjs` 的 `CAPTURE_FILES` 都没动（`git diff 3b08160d --stat` 可查）。

## 验证

命令都在 worktree 根目录跑（笔记本，2026-09-29）。在线构建输出到本会话的临时目录 `<tmp>/dist-online`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（PATH 补上 ffmpeg，见 `docs/local.md`） | 3809 条：通过 3807、失败 0、跳过 2（其一是要 5190 的 `/api/cards/layout` 集成那条，原来就跳过），退出码 0 |
| 改到与新增的单测 | `node --experimental-test-module-mocks --test <文件>` | `cardSourceParse` 6/6、`registrySynced` 1/1、`onlineUserCards` 5/5、`stageLocalOnly` 2/2、`placeholderHost` 11/11、`onlineSnapshotSource` 11/11、`c10-ui-gates` 5/5、`snapshotFeed` + `c10a-l17-lowmem` + `c10a-l17-backfill` + `c10-cost-plan` 37/37，全过 |
| 在线构建 | `npx vite build --mode online --outDir <tmp>/dist-online` | 退出码 0 |
| 新 A6 探针 | `node scripts/probes/online-user-cards-probe.mjs --dist <tmp>/dist-online --out <tmp>/ouc-shots`（端口 5744～5748） | 退出码 0，`ok: true`，`fails: []` |
| A6（改写）/ A7 / A8 | `node scripts/probes/c10-ui-probe.mjs --dist <tmp>/dist-online --proxy-port 5740 --proxy2-port 5741 --doc-port 5742 --asset-port 5743` | 退出码 0，`ok: true`，`fails: []`；A6 `snapUser 224、pxUser 0、snapBuiltin 223、badges {user:false, builtin:false, label:"闪光文字"}`；A8 `status 501` |
| 真端到端 | `node scripts/probes/c10-browser-probe.mjs --base-port 5740 --no-video --only-a4 --user-card --dist <tmp>/dist-online` | 退出码 0，`ok: true`，`fails: []`（A1～A4 照旧全过，外加用户卡一项），总耗时 1250 s |

新 A6 探针最后一行 JSON（节选，全文在探针输出）：

```
{"ok":true,"fails":[],"normal":{"timeline":{…"ouc-s1":{"label":"探针同步卡"…},"ouc-x":{"label":"未知卡片","badge":false…}},
 "requests":{"snapU":1,"snapS1":1,"snapB":1,"pxAny":0},"planClips":["ouc-s1","ouc-s2","ouc-s3","ouc-u"],
 "after":{"stage":{"snapshot":true,"snapText":"SNAP ouc-s2","placeholderShown":false,…},"timeline":{"label":"探针同步卡","badge":false},"ms":1581}},
 "lowmem":{"backfill":{"waiting":["ouc-s3"],"log":[{…"#backfill:…","clips":["ouc-s3"],"created":true}]},"requests":{"pxU":1,"pxS1":1}},
 "assetRequests":{"snap":4,"px":4}}
```

（JSON 里 `timeline` 是第一次读到真名时的快照，那时 u、s1 的整段清单还没取齐、徽标还挂着；探针随后等到「u、s1 撤掉、s2、s3 还在」才过，见断言清单。）

新 A6 探针核的断言（全过）：同步卡标签「探针同步卡」、未知 id「未知卡片」；u、s1 舞台贴出快照（`SNAP ouc-u` / `SNAP ouc-s1`）、没有图标、没有常驻槽位、`snap/` 请求 > 0、普通档 `px/` 请求 0、清单就绪帧 > 0；s2 舞台是 `unsupported` 图标（种类 `unsupported-badge`，文字「需要本地 PC 渲染辅助」，不是沙漏）；徽标只在 s2、s3 上、悬停文案对，u、s1、b、x 没有；未知 id 不画；页面清单计划 `lastClips` 含 u、s1、s2、s3、不含 x；给 s2 补层后 1.6 s 图标换成快照、徽标撤掉；两个页面都没有页面错误；低内存档 `__pcBackfill` 的缺口只有 s3、u 与 s1 贴小尺寸（`px/` 请求各 1）、s3 是图标、x 不画，停下追一帧（5 秒）之后 u、s1 照旧贴着。

真端到端的用户卡一项（`user-card.done`）：成员页刚进来时用户卡片段舞台是 `unsupported` 图标、时间轴有徽标；成员页发布的清单计划含它（桌面判它轻、桌面自己的计划不渲它）；创建者的桌面渲染节点（与在线构建同一代码版本）认领、渲出、写进层表（`envFingerprint` = 创建者节点的指纹，层 `kind: html`，就绪 91 帧），约 707 s 后成员页贴上快照、图标与徽标撤掉。

看过的图：`normal-1-stage.png`（u、s1 贴着绿 / 橙快照；s2、s3 位置是小图标——片段缩到 1/3、预览又缩到 27%，图标很小）、`normal-1-before-s2-layer.png`（时间轴 s2 片段右上有徽标，u、s1 没有）、`normal-2-after-s2-layer.png`、`user-card-e2e.png`（成员页贴着桌面节点渲的「PromptCut」闪光文字快照，片段上没有徽标）。低内存档仿手机的布局里预览面板不在屏内，舞台截图是空的，低内存档只靠 DOM 断言（舞台 iframe 里查包裹层、快照平面、槽位）。

导出像素基线（`verify-determinism`、`verify-unified-frames`）没跑：主会话另在 PC 上跑（任务书约定）。桌面不变的依据见上一节。

## 主会话补充核实：真实桌面版给用户卡写的层，在线普通档能不能用上

结论：**能用上，层表形状不用改**。

1. **档位与 contentKey**：档位由 `server/snapshot-tier.mjs` 的 `snapshotTier(capabilities)` 定：推帧（stateful）且合成方式 `independent` / `sourceDependent` → 共享档（`shared`），其余 → 本地档（`local`）。合成方式的权威是审阅表 `src/cards/capabilities.json`；没进审阅表的用户卡（Agent 刚建的那种）是 `unknown` → **本地档**；仓库里的 `mu-animated-shiny-text` 在审阅表里是 `independent` → 共享档。`contentKey` 由 `server/card-cache.mjs` 的 `plan()` 对**每一个** control 都算（`cardSnapshotIdentity`），与档位无关；`layerMapOf` 的 `contentKey` 取 `control.contentKey`，本地档另要求有指纹（没有指纹整层跳过），`resultKey` 用 `contentKey ?? snapshotKey`。
2. **内置卡落在本地档时**：同一条路，同样带 `contentKey` 与 `envFingerprint`，在线普通档同样认——不是用户卡特有的问题，也不是已有的缺口。
3. **实验**（不入库，vite 服务端载入真卡片 + 真 `CardFrameCache.plan` + 真 `layerMapOf` + 真 `parseLayerMap` / `usableLayer`）：

   | 卡 | 档位 | 合成方式 | 层 kind | contentKey | 普通档可用 | 低内存档可用 |
   |---|---|---|---|---|---|---|
   | 没进审阅表的新用户卡 | local | unknown | local | 有 | 是 | 是 |
   | 声明 context 的用户卡 | local | context | local | 有 | 是 | 是 |
   | `mu-animated-shiny-text`（仓库用户卡） | shared | independent | html | 有 | 是 | 是 |
   | `punch-pill`、`particles`、`mu-number-ticker`（内置） | shared | independent | html | 有 | 是 | 是 |

   页面一侧 `snapshotFeed` 的选帧按 `html`、`local` 两种都认，在线来源按层表的 `resultKey` 取清单，本地档的层照样贴。真端到端（桌面节点渲、成员页贴）见「验证」里 `--user-card` 那一项。

## 没做成的及原因

- 导出像素基线没跑（任务书约定由主会话在 PC 上跑）。
- `c10-cost-probe.mjs`、`c10a-demo-probe.mjs` 只改了认 `unsupported` 的判法，没跑（前者要成本记录那一套，后者要手机 + 创建者全流程；新 A6 探针已覆盖低内存档里用户卡的显示）。
- 真端到端只验了仓库用户卡（在线构建里有定义）。「只在桌面卡片库里、在线构建里没有」的同步卡端到端没跑：要在创建者的桌面上临时建一张卡（写进本 worktree 的 `src/cards/user/` 或数据目录的改动层），而在线构建必须在那之前打好；同步卡的识别、贴图、补层换上已由新 A6 探针用内容库 + 替身层表核过。
- 已知的小缺口（没改，记在这里）：在线页面在卡片源码表到达之前（进入后最多约 5 秒），同步卡被当成未知 id，后台舞台可能测它一次（渲不出东西、记一条很便宜的成本记录）；表到了之后它没有身份，这条记录不再起作用，身份键里的源码版本是 null，与桌面算的键不同，不会串到别处。要彻底避开，可以让页面测量等卡片源码第一次同步完再开始，涉及测量的门控，本次没动。
- 舞台上 `unsupported` 图标的「徽标」形态（量不到实体框时）随包裹层缩放，片段缩得很小时图标跟着很小；这是占位组件原有的几何规则，不在本次范围。

## 对任务书或契约的更正建议

- 契约第 9 节「时间轴」写的徽标文字「该模式暂不支持自定义卡」已按用户新定改成「需要本地 PC 渲染辅助」（代码里引用占位符那句）；文档由主会话改。
- 第 9 节「识别」没说「跟变化」的办法。本分支选定时重取（理由见第 2 条），建议契约补一句「页面定时重取卡片源码列表（哈希没变不取正文），连接换了清表重取」，免得后人改成 `content.watch` 顶掉同一连接上的别的订阅。
- 第 9 节「时间轴」的「覆盖整段」建议写明按**清单**判（结果在素材服务里就算），不按「字节已取到本页」判：后者要把整段字节都拉进本页，普通档的 L2 与低内存档的内存都扛不住；舞台上字节在途的那一小会儿显示图标，是「这一帧还没有可贴的结果」的正常读法。
- `PLACEHOLDER_FIXED_ATTR` 已不再使用，常量留在 `contract.ts` 只为旧脚本认得名字；下次动 contract 时可删。
- 任务书第 1 条列的替换点漏了 `StageView.tsx` 的 `settleLowMemory` 一处，已一并换。

## 和 0.7.0 桌面版混用

- **页面发的清单计划 0.7.0 节点不认领**：页面发布的计划带 `requires.codeVersion`（在线构建按 `frame-code.mjs` 的 `frameCode` 算出注入），本分支动了 `src/` 下的源码，代码版本与 0.7.0 不同，0.7.0 的桌面节点不认领新页面发的计划（包括含用户卡的片段）；低内存档的补渲计划不带 `codeVersion`（`backfillPlanTask` 的 `requires: {}`），0.7.0 节点能认领，切出的细任务照 M7 规则按认领方自己的代码版本出键。
- **贴 0.7.0 已产的层不受影响**：页面不算键，只按层表（v 2 / v 3）与清单取；层表是渲染节点按自己那份项目写的，页面不核代码版本。本分支没改生成快照的任何输入，也没改层表 / 清单的读法（`parseLayerMap`、`usableLayer`、`layerRefOf` 原样），所以 0.7.0 桌面版给共享项目写的层（含用户卡的层）新页面照贴。核对依据：`git diff 3b08160d -- src/render/snapshotSource.ts` 只加了 `coverage` / `subscribeCoverage` / `coverageLayer` 与删掉 `skipLayer`，层表解析与可用性判断没动。
- **0.7.0 的页面**（旧在线构建）看同一个项目时照旧：用户卡常驻图标、不贴（旧语义）；它不读卡片源码，同步卡照旧是「未知卡片」。
- **L2 里的旧成本记录**：旧页面在后台舞台上测过用户卡（后台舞台当年会跑用户卡代码），L2 里可能留着判轻的记录；新页面在线时不给这些片段身份，旧记录不起作用，不会把用户卡判轻而不贴。

## 主会话审查（2026-09-29）

- 逐文件读过 diff：注册表的同步表、卡片源码解析与在线页定时重取、舞台（在线时不挂组件、照挂快照与流平面、`unsupported` 进显隐调度）、投递与快照来源去掉豁免、测量不给这些片段身份、补渲与清单计划不再去掉它们、时间轴真名与徽标。没发现问题。
- 「进入后最多约 5 秒」那条小缺口按遗留处理，不改：最坏多测一次、多记一条很便宜的成本记录，键与桌面不同、不串，表到了之后不再起作用。
- 用户当天另定：徽标文字改成「需要本地 PC 渲染辅助」、出现条件同图标（代码已由本分支直接引用占位符那句）；语义 `product/platforms.md` 与 `c10-contract.md` 第 9 节、文案表、`c10a-contract.md` 由主会话改。报告里建议的两句（定时重取不用 `content.watch`、覆盖按清单判）已写进 `c10-contract.md` 第 9 节。
- 本报告随合并归档到 `docs/archive/agent-reports/`。
