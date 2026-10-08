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
