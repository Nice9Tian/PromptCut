# C10 真实重型夹具候选

工作分支 `codex/018-c10-heavy-user-fixture`，起点 `022c326b1c238c38f2692030d92acbf72ae0133f`。独占本报告、c10-browser-probe.mjs 的 A5夹具/必要前置、c10-judge.mjs 相应判断、c10-host-claim.test.mjs 纯目标。生产卡片、选型/渲染/阈值/语义/core不修改。

根022真实C10首次自然结束exit1，okfalse/1fail/pending0，wall164.969s；particles400/links=yes真实build成本step0.2/stepMax0.4/raster22.3、90samples、vtOktrue，pipeline light、w0.2/tierseek。正确前置在host启动前失败。保留 `%TEMP%/pc-root-c10-joint-022c326b` 原脚本、log、result.json及-out/a5-fixture-prerequisite.json。原365 r6-canvas轻卡反证与旧80唯一根因未知均保留。

按AGENTS、开发索引/行为/约束/verification/multi_agent/solution_table执行。先审当前实际脚本已有真实CPU负载与用户卡路径，列三级解法表，再以实际注册/同步/编译/host证据协议选最小候选。不能把合法参数本身当实测重、不能写fake cost/weight/强制pinned、不能取消main-v2竞争或放宽同clip/hostFP/non-dedup completed/新ready键。当前只允许纯无监听反例、npm窄目标与type；不启动任何服务/真实probe/full/节点。

## 卡点 1：真实 host 必须完成本目标

尺子仍是完整 C10 A5：本目标真实 build 测量重、最新成功清单包含目标，host 正常能力认领，同 clip/host 指纹/non-dedup `node.completed`、新 resultKey 且 ready>0；原 main-v2 浏览器竞争保留。将来由根分配窗口运行 `node scripts/probes/c10-browser-probe.mjs --role all --base-port 6320 --out <TMP新目录>`，本叶当前不运行。不能拿 claimed/plans 计数替代 completed。

| # | 层 | 父 | 候选 | 改善机制 | g | h | f | 状态/结果 |
|---|---|---|---|---|---|---|---|---|
| 1 | 三级 | — | r6-canvas | 已审 canvasHeavy 只在入预渲集合后影响切分 | 2 | 5 | 7 | 关闭·无改善：365 实测轻、目标未进计划，自然 exit1/7fail/1766秒 |
| 2 | 三级 | 1 | particles400/links=yes | 合法控件增加实际绘制 | 3 | 5 | 8 | 关闭·无改善：022 的 step0.2、raster22.3；rAF/GPU贵不等于被测 CPU step 贵；前置正确失败 |
| 3 | 三级 | — | 原 probe-slow-stepped 40ms | 既有真 CPU 慢测量 | 2 | 4 | 6 | 关闭·剪：independent 仍可 browser 双份竞争，不保证 host 真实完成；其专用 real-clock/export 捷径不能复制成普通用户卡 |
| 4 | 三级 | — | 普通用户递归纹理卡 | 每个 t 真计算决定128格颜色；CSS 动画使 stateful；新ID正常 unknown/local；必须实测 step>budget 才继续 | 3 | 2 | 5 | 开放：本次实现，纯路径/类型待验，浏览器/host未执行 |
| 5 | 三级 | — | 写 cost/强制 pinned/屏蔽 main 竞争 | 无合规改善机制 | — | — | — | 关闭·剪（禁止） |
| 6 | 二级 | — | 改能力表/新内置 cap/默认规则 | 改产品行为迁就夹具 | — | — | — | 锁住，不参与；本包无此授权 |

根批准第4行，属于三级夹具机制收敛，不改变用户语义。源码由 `heavyUserCardSource` 生成，只放本轮临时项目内容库：React useMemo 每 t 对128格各做32768次相依 sin/cos 递推，所得值直接生成 hsl；无计时循环、无 `__pcRealNow`、无 export/测量模式捷径、无网络、无自报 compositing/canvasHeavy。CSS opacity 动画是实际 stateful 内容。0.25到0.25+1/FPS秒短片段限制 host 工作量；ID/seed/时长每轮新值使源码/内容身份变化，entryKey仍由正常项目图生成。

正常路径依据：`cardCapabilities` 对未审新ID给 unknown；`snapshotTier` 对 stateful unknown 给 local；frame-pipeline 的 queueWeightClass 对 local 给 heavy；split 的 browserEligible 要 shared+independent，因此本目标不会生成 browser 双份。没有改生产规则、没有声明独立能力。`snapshotSource.ts` 接受 local 层；实际发布、host 编译/消费与跨指纹就绪仍须下一次真实探针证明，静态规则不是这些环节已通过的证据。

前置协议：现有 creator 协议连接执行真实 `content.put/get card-source`，校验完整 body、JSON正文 SHA256 和同一正 rev；成员在线页面正常 `__pcCardSourcesSync`，必须入口 bundle成功、编辑运行状态及两个舞台该卡均 ready，再通过真实 store.actions 添加片段。输出 `a5-fixture-source.json` 只含源码键/哈希/rev/ready枚举，不带源码或凭据。随后仍读取完整白名单 L2 build成本、probe settled、精确 identity/FPS/时间、stage heavy、当前 rev 的最后成功plan含目标。新增 `requireStepOverBudget` 明确要求 stepMs>budget；即使 pinned/capped/demoted/over-catchup 也不能代替 CPU 测量。失败仍保存 `a5-fixture-prerequisite.json`，在 host 前抛出，不追加长等待。

纯测试使用真实源码静态识别、生产 bundleCard/Sucrase/包解析、React SSR确定性计算和生产能力/档位/切分函数；SSR耗时仅诊断，不作为 Chromium build测量或host完成证据。保留原10条及既有反例断言，新增一条源路径测试。无服务 fixture 监听；npm 仍经既有 wrapper/global-setup 临时19坏端口×2地址 guard，未绕过它，不能说 npm 全程无监听。

## 固定源码与本轮结果

开工报告 `9093e5a3`；实现固定 `b1562e8e`，测中源码未改。首轮 `npm test -- server/test/c10-host-claim.test.mjs`：exit0、11/11 pass、0fail/cancel/skip，duration2113.1854ms、wall2.3942299s，无 native retry。原始 `%TEMP%/pc-c10-heavy-user-b156-target-1.log` 和 `-exit.json`。源纯验证真实 bundle成功、128个计算输出、同输入同HTML/变seed+t不同HTML，正常 caps unknown/canvasHeavyfalse、tierlocal，生产split在已选择前提下仅一份host/userCards细任务。三次SSR合计259.8024ms只作诊断，明确 `browserMeasurement:false`。

首轮 `npx --no-install tsc -b --force`：exit0、零错误、wall7.1000937s，原始 `%TEMP%/pc-c10-heavy-user-b156-types-1.log` 和 `-exit.json`。两脚本 `node --check` exit0。全部命令 process-only Python=cuda_Vit、PYTHONDONTWRITEBYTECODE、静默预加载；测试子进程 windowsHide，spawnSync 返回实际结束，不新建持久子树。git diff --check通过。本轮没有新测试失败；旧022/365真实失败未删、未覆盖。

未跑：完整 npm、实际 C10、HTTP/TLS/listen(0) fixture、G0-R、节点。根限定此轮纯/type窗口，下一次真实宽窗口由根统一租约；本包不改生产渲染/卡片/阈值。当前结论是候选实现与纯路径验证通过，**尚未证明 Chromium 实测超预算、真实当前plan包含它、host编译执行和最终ready**，不能称 C10 修好。下一次必须先读 `a5-fixture-source.json` 与 `a5-fixture-prerequisite.json`，不满足即保留反例结束，不改成本/能力或同源盲重跑。实际通过还须 `a5-task-evidence.json`、`a5-host-render-evidence.json` 内同clip/hostFP/non-dedup完成和新键；主main原竞争同时照验。

变更清单仅本报告、`scripts/probes/c10-browser-probe.mjs`、`scripts/probes/c10-judge.mjs`、`server/test/c10-host-claim.test.mjs`。旧审查和C10失败工作区保持冻结。没有merge/push/main/部署/依赖/用户项目或用户进程操作。

## 根7dab首次实际结果与错误入口修正

根固定联合 `7dab214f` 实际 C10 首次自然结束 exit1/okfalse/1fail/pending0，wall158.188s、native0、源码clean不变。原 `%TEMP%/pc-root-c10-assets-7dab214f.log`、`.result.json`、`-out` 保留；cleanup仅本TMP项目，listening[]，根核6320–29空。真实卡 `c10-cpu-field-882b297535591416` 的 put/get哈希均为 `6276c66c7e0a31ba64698039c7dd9eaf180a3a5a5ca5f5d48dd38d6c63195d03`，rev1/sameBody=true，bundleok、runready、A/B ready。之后旧夹具1898附近的 `addClipOnNewTrack` 返回null，读取clip.id抛TypeError。**未到成本测量、未启动host，不能据此判新卡轻或host失败。**

首无监听原反例 `%TEMP%/pc-c10-user-card-store-cd068-counter.mjs` / `.log` exit0。使用本固定源真实 OnlineCardSources→生产bundleCard/Sucrase→实际registry与store actions，内容回包为受控内存文本（没有冒充新的真实doc）；生成源hash与根实际完全一致。syncedCardView存在、bundle成功，但getCard undefined；addClipOnNewTrack/addCardClip都null，project不变。未mock store/registry、未灌Component、未模拟stage ready（后者只引用根真实证据）。

原因：registry.ts86 getCard只查静态map/runtimeCards；同步视图不进这两个表，运行时定义只在舞台/声音线程，编辑页runtimeCards按契约为空。OnlineCardSources.sync正常写synced元数据；clips.ts97只接受getCard，因而多等同步不能解决。online-card-exec-contract第2节明确这个隔离。结论是**本夹具错用现有准入入口，不泛化为生产catalog缺陷**。

解法表第4行派生：4a（三级，父4，g4/h1/f5）保留同普通用户源码与所有测量尺子，改用既有代码页 `editCardProject` 的正常项目编辑入口；根已核 projectMeta.ts10及 online-user-cards-probe.mjs361并批准。4b“灌定义进编辑页registry”关闭·禁止（破坏隔离）；4c“只多等ready”关闭·无机制。原4的实际结果记部分：源同步和舞台就绪通过，错误调用在新增片段前阻断，重型/host结论仍未验证。

新 helper只读取真实同步元数据的sourceKey/cardId/defaults，合并完整params；以正常唯一随机clip/track ID及冲突检查创建新对象，经本页 store.actions.editCardProject、setDurationManual产生修改，原tracks对象与main-v2内容保留。不改生产catalog/能力/动作，不调用unsafe项目写接口；共享DocSync依旧以该页身份走原权限提交。源码计算内容不变。

新增真实探针前置：动作前从doc project.open读取版本，动作后再经独立已有凭证连接回读doc真身（支持分片并核完整SHA256与rev）；必须rev增加、同clip/cardId、参数/起止/总时长准确，同时再次content.get核同sourceHash/body/rev。保存白名单 `a5-fixture-project.json`；回读不成立就在host前失败。本地构造只证明本地动作，不冒称doc已接受。之后原L2 CPU step>budget、当前成功plan含目标与host同clip/指纹/non-dedup/newready全部保留。

新实现 `4ffcf88f` 首纯目标13/12pass/1fail，duration2305.5967ms/wall2.5899972s/exit1，日志 `%TEMP%/pc-c10-user-edit-4ffcf88f-target-1.log`、`-exit.json` 保留。失败在新增测试：动态import后解构 `export let state` 并闭包返回它，实际core.set替换state后测试仍返回旧对象，误报fixture-edit-not-applied。改测试为实际 `core.getState`，其它纯断言和真实helper不放宽；这是有因复验，不重复到绿。分片/摘要回读纯目标首轮已通过。

修正后的固定源码 `e8a02e701b99516edddd02b8b193165a85afa7ea`：定向第二次 exit0，13/13pass、0fail/cancel/skip/todo，duration2399.2842ms、wall2.6776006s，无 native retry。原始 `%TEMP%/pc-c10-user-edit-e8a02e70-target-2.log` 与 `-exit.json`。保留原11项，再加实际store正常编辑/隔离和完整project回读两项；旧失败没有删除或覆盖。真实store目标证明旧入口仍null、新入口产生不可变项目且保留全部旧track对象、默认params与手动时长，始终没有编辑页Component注册；该目标明确 `actualDocCommit:false`。回读目标只证明协议聚合器，不冒充本轮真实doc提交。

同一源码首次 `npx --no-install tsc -b --force` exit0、零错误、wall7.6963756s；原始 `%TEMP%/pc-c10-user-edit-e8a02e70-types-1.log` 与 `-exit.json`。两个脚本 `node --check` exit0，git diff --check通过。命令均为process-only规定Python/models/preload与去重PSModulePath；没有业务fixture监听、HTTP/TLS/listen(0)、完整npm或C10运行，npm窄目标仍走既有临时guard。测中源码未变，之后仅补本报告。

相对根已收 `cd068fe7` 的增量仅4个获租文件：browser probe替换错误片段入口并加入真实doc提交证据；judge新增正常编辑和只读回包聚合helper；host-claim测试新增两项；本报告保留首败、三级收敛和验证边界。自审核对实际project模块的inline/parts/end形状、reqId/rev/digest与endpoint布尔send接口，未修改任何生产文件。

本次可交付结论：**片段入口错误有因修正，纯路径和类型通过；实际共享doc接受、新卡浏览器CPU成本、当前成功plan与host完成仍未执行，C10尚未判通过。** 根下一次统一窗口应先取得新增 `a5-fixture-project.json`（rev增加、同ID/params/时间与sourceHash一致），随后才核 `a5-fixture-prerequisite.json` 的真实step超budget和当前成功plan；最后仍按同clip/hostFP/non-dedup completed/新ready键及原main竞争完整验收。任何前置失败保存原始证据并结束，不同源重跑赌绿。

## 根 f7b 首次实际结果：合法 metadata-only 与已接受快照

根联合 `f7b77a1a` 实际首次自然结束 exit1/okfalse/1fail/pending0/wall142.750s、native0，源码clean不变。原 `%TEMP%/pc-root-c10-assets-f7b77a1a.py`、`.log`、`.result.json`、`-out` 全保留。白名单读取 `a5-fixture-source.json`：卡 `c10-cpu-field-949a7a398ad9265a`，源码正文哈希 `1c1cea9f8941c5b7991b8f103fd0c2628e125a224e09bc26e2bf20f5d566f880`，真实put/get rev1/sameBody、bundleok/runready、根已核两stage ready；没有project/prerequisite文件，host未启。失败是旧helper在beforeProject处把合法 `project:null` 误报 `fixture-project-missing`，不是成本或host结果。

实际链路：`server/vite-plugin-frames.ts` 的publish（625–673）调用 `server/queue-publish.mjs:resolvePublishVersion`；没有C6.5真身时，真实 `project.announce` 登记rev/digest，再由 `createProjectClient.putSnapshot` 上传完整项目JSON。`project.mjs:450–479` 的open只在hasBody时给正文；`845–898` 的snapshotPut核登记rev/摘要并持久保存全文blob，但不把它转换为C6.5 body；`939–976` 的snapshotGet按精确版本提供该全文。`renderProject` 只正常化media地址，保留clip/params/时长。这是合法共享旧路径。此前报告“必经DocSync真身”措辞过强，本次修正为正常共享同步/发布；不把render层产物当项目正文，也不假称所有页面都已接C6.5。

首无监听counter `%TEMP%/pc-c10-f7b-metadata-counter.mjs/.log` exit1：实验ctx漏now，在真实announce之前报TypeError；保留。补齐context的新名 `pc-c10-f7b-metadata-counter-2.mjs/.log` exit0：真实projectModule+memoryStore+createProjectClient+resolvePublishVersion，普通v1 principal，只有内存transport投递，无listener。实际publish viaannounce/rev1，服务端读回完整同项目；head hasBodyfalse/projectnull/digest正确/no parts；旧helper明确拒绝合法metadata。它证明模块链路，不冒称新浏览器运行。

三级解法表派生4a1（父4a，g5/h1/f6）：承认合法metadata，按真实head精确rev/digest读取服务端已接受的**完整项目快照**，核片序/总数/项目ID/全文摘要，结束再读head仍同版本才提供正文；缺快照或head前进仅返回project:null与未就绪原因。初始rev0可作版本基线，不作正文证据。4a2“用本地项目填null”关闭·禁止；4a3“强发project.op转换真身”关闭·无必要且会改变被测提交链。根批准4a1及取证顺序调整，未改生产/二级语义。

同一顺序收敛：先记真实beforeRev、正常editCardProject；等待既有L2 CPU超budget/当前成功plan前置；随后再核完整服务端项目，最后才启动host。旧顺序在测量前要求publisher先上传快照存在依赖倒置。后置仍要求remoteRev>beforeRev、同clip/cardId/完整params/起止/总时长精确一致、source正文/hash/rev完全一致；保存via=body或accepted-snapshot及未就绪reason，不删任何回读尺子。原main-v2、当前plan含目标、hostFP/非dedup completed/新ready键不变；无新增sleep/延长时限/强上传/假成本。

本轮新增两纯目标：实际queue-publish/project-client/project模块配真实TMP文件store，确认合法null、完整快照、重开模块与文件store后全文仍可读、announce后尚无快照不放行；独立受控回包拒错版本/错项目/缺片/乱序/坏摘要，并在完整旧快照结束后head已前进时不返回正文。原13条全部保留。当前待本固定实现的npm窄目标与type，实际C10/全文接受/browser成本/host仍由根下一窗口验证。

固定源码 `ad62ccd040e4cdb0420d3a4028ecb3f80111794b` 首轮定向 `npm test -- server/test/c10-host-claim.test.mjs` exit0、15/15通过、0fail/cancel/skip/todo，duration2331.6372ms、wall2.5980862s；无native retry，原始 `%TEMP%/pc-c10-snapshot-ad62ccd0-target-1.log` / `-exit.json`。首轮 `tsc -b --force` exit0、零错误、wall8.4809284s，原始 `pc-c10-snapshot-ad62ccd0-types-1.log` / `-exit.json`。两脚本node--check与diff--check通过，测中源码未变。本轮npm/type无失败；早先counter缺ctx.now的首失败完整保留。SSR260.8761ms仍仅Node诊断，browserMeasurement=false。

相对 `95cc8e76` 增量仅原4文件；无生产源码、成本阈值、能力、host判据或CPU卡源码改动。测试实际调用文件store（每次同步文件描述符由原store闭合），独占TMP目录在模块disconnect后删除，子进程spawnSync/windowsHide等实际退出；本轮无业务listener、HTTP/TLS/listen(0)、完整npm、真实probe或节点操作。npm窄目标仍使用原wrapper/global-setup临时guard，不冒称npm全程零监听。

交回结论：合法metadata-only的误拒已在真实模块链路与持久文件回读上有因修正，纯目标/type通过；没有证明下一实际页面已新增/同步/发布该目标，也没有证明其CPU成本和host完成。根下一实际窗口按固定源自然运行一次，先成本与当前成功plan，再读取当前完整accepted项目/精确目标/source证据，最后保留原host完整标准。旧365/022/7dab/f7b首败及所有实际结果继续保留。
