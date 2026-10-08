# C10 host 渲染夹具修复记录

工作叶 `018-c10-host-fixture-repair`，分支 `codex/018-c10-host-fixture-repair`，起点 `3652b04cd5e061b8b96cbdf056f801d114915ae7`。

先只读核对 root 旧80首失败与3652当前 A5 真实证据，确认新增 r6-canvas 片段是否进入实际最后计划、测量与缓存集合。只拥有本报告、c10-browser-probe.mjs、c10-judge.mjs、c10-host-claim.test.mjs；最小修法先报 root，再实施。保留 main-v2 browser 竞争与同 clip/host 指纹/新 layer 键的真实完成判据，不改产品 capabilities/filter、不伪造测量、不加 sleep 赌时序。

已读 AGENTS 入口、开发索引、行为与约束；遵守先前 verification/multi_agent 租约要求。root 探针仍自然运行，不修改其冻结叶/进程，不启动新宽探针/full/固定服务。参考的其它用户分支仅 Git 对象只读，不合入/清理/修改。必要纯模块反例、日志置 TMP，所有进程隐藏，Python 只用 process 环境 cuda_Vit，输出仅安全字段。

当前尚无新测试或根因结论。

## 首轮只读因果证据

当前 root 的 3652 真探针自然运行，未触碰其进程或文件。只读其系统 TMP 持久项目日志：新增片段在 rev3 写入，`clipId=c-muyzk3iy-5`、`cardId=r6-canvas`、start=11、end=12.009805290468549、params={}；rev4 把项目 duration 写为同一 end。因此不是新增动作/项目时长丢失。

读取真实 `projectCardGraph`、`clipCostIndex`、`cardSourceVersion` 及3652源码闭包，按持久原片段重建成本身份：`136798c2570ddc`，恰好匹配 doc costs 的两条真实页面 build 测量，stepMs 均0.2，页面 fingerprint=258acaaa7c5fe509。这里只为 graph 提供原卡静态 id/defaults/frameMode/source；capabilities 来自真实仓库审阅表，没有手写能力或成本。脚本未渲染、未创建服务，实际测量由 root 原探针完成。

脚本/原始结果：`%TEMP%/pc-c10-fixture-repair-evidence/identity.mjs` / `identity.log`；纯 `node <TMP>/identity.mjs <本叶> <root原TMP运行目录>`，exit0。进程显式 cuda_Vit/PYTHONDONTWRITEBYTECODE/静默 preload。输出仅该临时项目clip、身份与白名单成本字段，无账号/密钥信息。

当前 a5-task-evidence 无该clip；记录是两个同ID plan世代、旧chapter-bar removed、main-v2两指纹细任务。最后 plan@4 的 clips 签名 `14v5de8wsmjb4` 与 A1@1 一致，A1清单为10个旧重片段。这与 fixture 没进入实际最后清单一致。host渲染事件文件为空。此证据仅定位新3652夹具链断点，不宣称旧80首失败只有同一原因，也不把在途结果当最终失败统计。

上一报告将“frame-pipeline 对canvas任务的weight分类是heavy”误当“页面一定把canvas选进预渲染集合”。二者不同：`capabilities.md` 明确 canvasHeavy 指载体，不是轻重；页面先按真实成本分派，r6只是48个圆。旧单测手造已选control并给heavy weight，只验证split及排除浏览器规则，未验证前置测量/集合。另 until 超时后 check(false) 仅记fail，仍继续启动host并等15分钟，因此前置失败被长等待掩盖。root已接受此因果并说明此前批准前提不成立。

## 最小提案（待 root 审后写）

优先尝试真实原生 `particles` 卡，使用其现有控件合法参数 quantity=400、links=yes、speed=1.2、size=3、config空、seed在1..99999；时长3到3+1/FPS之间，start=SECONDS+1。它有真实逐步粒子模拟、现有independent/canvasHeavy审阅能力，不改src或能力表。仍必须从页面实际probe身份/L2完整成本及最后成功plan证明确实已测并入集合，没进入就立即明确失败、保存证据，不以canvas标志或默认weight代替。该候选尚未真实渲染，不能承诺400粒子必重；只有获租实测才能裁定，轻则按原语义另选机制，不调成本JSON/产品预算。

主main-v2浏览器竞争、同clip/hostFP/细任务node.completed非dedup/新ready键全部保留。其它用户91857分支仅Git对象只读，看到其按精确目标细任务诊断无任务的思路；不采纳其修改main竞争或计时门槛，不合并其源码。
