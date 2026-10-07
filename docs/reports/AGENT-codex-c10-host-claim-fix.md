# C10 独立渲染主机认领修复报告

2026-10-08。独立包 `codex/c10-host-claim-fix`，基点 `913e6884`。A5 指 C10 在线普通档完整版中由独立渲染主机认领清单计划、切分并完成新版本，而不是页面自己完成。

## 范围与初始证据

先只读定位，允许初始源码为 `scripts/probes/c10-browser-probe.mjs`、`scripts/render-host.mjs` 及专属主机测试。真实缺口如在其它文件，先向协调者给证据和精准范围申请，不擅改。不得降低 A5 功能断言，不做新调度/故障策略。原账号基础与调度文档工作区保留；不合并、推送、main、部署或清理其它进程。

已完整读取根原始 `P-c10-browser-full.log`：候选 `913e6884`，A1～A4通过，A5等待923588毫秒，整项1105203毫秒退出1。主机ready=true且连接会话open，计划@2为open；无主机claimant/cut/external，页面自身新层120帧。因此不能把页面可见新画面算主机成功，也不能仅凭本轮新代码判定回归。日志主机capabilities包含userCards=true、graphCards/transcode/streams=false；真实ffmpeg PATH存在。

已读入口规则；独占worktree没有docs/local.md，检索该文件报不存在，将按主会话已提供环境与只读主工作区文档核对。后续补实际根因、最小修改、复现/验证原始尝试和证据。

## 只读定位与反证

原 host、原在线 dist、本工作区的 frameCode 都为 `33c0e27f47d929f009cb321f5149137ab6bf80807daefeb09eab5c68a14f410b`。禁流能力不阻清单 plan。相同真实 queue/JSON 环回 + 清单计划 + laneOf/laneBusy 对照 claimed=1/plans=1。临时调试脚本前两次分别因脚本括号错误、错写导出名在执行功能前退出1，第三次修正后通过；不当成功测试，也不当产品失败。第三次 full 完成后的诊断读取遇已正常清理端口 ECONNREFUSED；没有打断探针。

原源码与原 dist 独立完整 C10：`node scripts/probes/c10-browser-probe.mjs --base-port 5950 --dist <根原 dist-online> --keep-temp`，exit0，总261821ms，A5 44764ms，claimed=3/completed=1，host新层ready31，main-v2，cleanup listening=[]。原日志保留在系统 TMP/c10-host-claim-baseline.log，夹具 TMP/pc-c10-browser-sOS4VN。此反证不能叫修复、不能推定根因；候选是节点侧过滤、在飞/闲时闸或隐藏周期错误，原日志无法区分。

## 经授权诊断增量

协调者明确授权仅既定两脚本及专属目标测试。保持原断言、900000ms A5等待及整体deadline不变；不改queue/plugin/认领机制。render-host每5秒原有状态检查增加有限计数与watch/held/running、能力/代码/环境指纹和queue.tick-error分类/摘要；原始错误文本只计算SHA256，不吐任意内容。重复状态不刷屏，异步状态检查防重叠。

探针A5使用只收不认领的旁观连接，记录实际TaskView；按真实静态filter记录eligible与原因。该静态诊断不证明host lane/在飞/闲时闸已通过；缺host私有card-source视图的细任务标unknown；没有观察数据标null。最多保留100次变化样本，首样本不被滚出，输出为shots/host-claim-diagnostics.json与结果行；任务正文、URL、token/password、错误原文不进投影。未增加任何功能成功条件。

新增目标回归3项：可接清单plan/版本拒接区分；私密字段排除、未知卡身份及错误分类；实际queue/provider、串行lane闲时与禁流能力的认领切分对照。连同原RH/RHC目标集34/34通过，fail/cancel/skip均0，11469.3931ms（TMP/c10-host-claim-target.log）；原主机测试无削弱。语法检查两脚本通过，git diff --check通过。下一阶段固定源码做一次具名full、types与完整npm；尚未称产品缺陷已修复。
