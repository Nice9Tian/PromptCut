# C10 独立渲染主机认领修复报告

2026-10-08。独立包 `codex/c10-host-claim-fix`，基点 `913e6884`。A5 指 C10 在线普通档完整版中由独立渲染主机认领清单计划、切分并完成新版本，而不是页面自己完成。

## 范围与初始证据

先只读定位，允许初始源码为 `scripts/probes/c10-browser-probe.mjs`、`scripts/render-host.mjs` 及专属主机测试。真实缺口如在其它文件，先向协调者给证据和精准范围申请，不擅改。不得降低 A5 功能断言，不做新调度/故障策略。原账号基础与调度文档工作区保留；不合并、推送、main、部署或清理其它进程。

已完整读取根原始 `P-c10-browser-full.log`：候选 `913e6884`，A1～A4通过，A5等待923588毫秒，整项1105203毫秒退出1。主机ready=true且连接会话open，计划@2为open；无主机claimant/cut/external，页面自身新层120帧。因此不能把页面可见新画面算主机成功，也不能仅凭本轮新代码判定回归。日志主机capabilities包含userCards=true、graphCards/transcode/streams=false；真实ffmpeg PATH存在。

已读入口规则；独占worktree没有docs/local.md，检索该文件报不存在，将按主会话已提供环境与只读主工作区文档核对。后续补实际根因、最小修改、复现/验证原始尝试和证据。

## 只读定位与反证

原 host、原在线 dist、本工作区的 frameCode 都为 `33c0e27f47d929f009cb321f5149137ab6bf80807daefeb09eab5c68a14f410b`。禁流能力不阻清单 plan。相同真实 queue/JSON 环回 + 清单计划 + laneOf/laneBusy 对照 claimed=1/plans=1。临时调试脚本前两次分别因脚本括号错误、错写导出名在执行功能前退出1，第三次修正后通过；不当成功测试，也不当产品失败。完整 C10 完成后的诊断读取遇已正常清理端口 ECONNREFUSED；没有打断探针。

原源码与原 dist 独立完整 C10：`node scripts/probes/c10-browser-probe.mjs --base-port 5950 --dist <根原 dist-online> --keep-temp`，exit0，总261821ms，A5 44764ms，claimed=3/completed=1，host新层ready31，main-v2，cleanup listening=[]。原日志保留在系统 TMP/c10-host-claim-baseline.log，夹具 TMP/pc-c10-browser-sOS4VN。此反证不能叫修复、不能推定根因；候选是节点侧过滤、在飞/闲时闸或隐藏周期错误，原日志无法区分。

## 经授权诊断增量

协调者明确授权仅既定两脚本及专属目标测试。保持原断言、900000ms A5等待及整体deadline不变；不改queue/plugin/认领机制。render-host每5秒原有状态检查增加有限计数与watch/held/running、能力/代码/环境指纹和queue.tick-error分类/摘要；原始错误文本只计算SHA256，不吐任意内容。重复状态不刷屏，异步状态检查防重叠。

探针A5使用只收不认领的旁观连接，记录实际TaskView；按真实静态filter记录eligible与原因。该静态诊断不证明host lane/在飞/闲时闸已通过；缺host私有card-source视图的细任务标unknown；没有观察数据标null。最多保留100次变化样本，首样本不被滚出，输出为shots/host-claim-diagnostics.json与结果行；任务正文、URL、token/password、错误原文不进投影。未增加任何功能成功条件。

新增目标回归3项：可接清单plan/版本拒接区分；私密字段排除、未知卡身份及错误分类；实际queue/provider、串行lane闲时与禁流能力的认领切分对照。连同原RH/RHC目标集34/34通过，fail/cancel/skip均0，11469.3931ms（TMP/c10-host-claim-target.log）；原主机测试无削弱。语法检查两脚本通过，git diff --check通过。下一阶段固定源码做一次具名full、types与完整npm；尚未称产品缺陷已修复。

## 基线首次失败与最小修正

类型检查使用主工作区现成 TypeScript bin（与tsc -b --force相同），exit0，16830ms，无安装或junction。完整npm首次：4934 tests，4932pass、1fail、1skip、0cancel，76358.8203ms。唯一失败为已有依赖方向守门 `server/** 不 import scripts/ 下的模块`，指出本包新测试的直接脚本import；原日志TMP/c10-host-claim-npm-full.log保留，不当绿。修正仅新测试：独立Node子进程调用脚本诊断导出，server本身不反向import脚本，原守门规则不改。两个诊断脚本未变，在途full C10源码继续固定。需要再跑目标含该守门与完整npm；类型检查无需因.mjs测试组织变化重复。

## 固定诊断源码最终复验与交回

修正目标集（含原RH/RHC、分层守门及新增3项）37/37pass，0fail/cancel/skip，11263.4968ms，exit0，TMP/c10-host-claim-target-repair.log。完整npm修正后4934 tests，4933pass、0fail、1skip、0cancel，101488.7742ms，exit0，TMP/c10-host-claim-npm-repair-full.log；唯一skip是既有“集成:/api/cards/layout 对真实项目返回整数框”（原日志857行 # SKIP），未改它。原全量失败不被覆盖。未发生测试文件原生崩溃重跑。

固定两诊断脚本完整C10复验使用与未改源码首跑同一命令、原dist、5950端口，exit0，ok=true/fails=[]，总286175ms，A5 113679ms：host claimed3/plans1/completed1，新host指纹层ready60，main-v2；cleanup shared.admin.ok/listening=[]。TMP/c10-host-claim-diagnostic-full.log，夹具TMP/pc-c10-browser-GYZru7/shots。真实诊断记录4次变化：初次尚未连上、静态eligible1；连上后seen6/claimed1/plans1；之后held/running真实快照段，最后completed1。tickErrors均空，fingerprint过滤有真实计数。ready可以先于连接，不代表已能认领，但原失败已连接，不能据此定原根因。

完整C10与types运行时两个诊断脚本为576eae05；测试组织修正在45d299ed，未改任何types输入/产品源码或frameCode；修正目标与全量npm验45d299ed。最终只补此报告，无源码再变。两个目标集、两个全量npm、未改源码full及诊断源码full均保留真实结果；未跑全套探针/G0-R/网络/部署，依据本包无产品画面、渲染管线或网络连接实现变化及协调者点名范围，不算通过。

此次完成的是诊断增强及复验，**原A5 15分钟不认领根因未确认，未声称修好产品缺陷**。暂时没有精准扩queue/plugin的证据。静态observer不读取host私有card-source或真实lane/在飞内部状态，不是时序证明；旁观连接仅探针夹具、只收不认领，随项目删除和进程清理，不是新生产调度能力。后续若再现可据新的有限诊断定位，不能以本次绿覆盖原失败。

依赖向上解析，未npm ci/安装/联接；Node所有测试/构建/probe显式静默preload为file:///绝对URI，PROMPTCUT_TEST_PYTHON为cuda_Vit Python，PYTHONDONTWRITEBYTECODE=1；新测试子进程windowsHide=true。只处理本探针owned清理，根5690端口段和用户端口未碰。未动其它worktree、main、version、部署或推送。最终git diff --check通过，工作区干净；协调者可从报告提交收回这4个允许文件。
