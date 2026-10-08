# 强化浏览器探针的文档全文回读

## 开工范围

- 独占分支 `codex/018-browser-doc-read`，起点 `0b1454df96fa8586712e9cea07d4b57b36964b62`。
- 仅修改本报告、`scripts/probes/c10-browser-probe.mjs`、`scripts/probes/c10-judge.mjs`、`server/test/c10-host-claim.test.mjs`。产品源码只读；不合并、不推送。
- 目标是定位强化探针“文档服务接受当前全文”前置超时，先读首次证据并做有界诊断，不能延长等待、模拟就绪或弱化同目标主机完成/来源/项目隔离标准。端口仅 6460–6469。
- 已读 AGENTS、developer_guide、suggested_agent_behavior、constraints、verification、multi_agent，以及 main 上的 `docs/archive/ordinary-browser-before-work-2026-10-09.md`。

## 保留的首次证据

- `cbe8398d` 强化候选：系统临时目录 `pc-root-c10-assets-cbe8398d` 前缀，200.313 秒，exit 1、2 个失败，当前全文新增前置超时，主机未启动。
- 开工前原始 `301c3092`：原普通档探针单次 1075.843 秒、3 个失败，在原 A5 主机完成等待及其后续断言；不能当成上述前置同根因。
- 旧 `f9390dda` 原夹具曾真实通过，220357 ms、1800 帧；强化新夹具不是旧基线。

## 三级解法表

| 卡点 | 修改前 | 候选最小机制 | 证据/状态 |
|---|---|---|---|
| 当前全文前置 | 已通过成本/成功计划后反复读当前 head/snapshot，最终只有超时 | 先还原真实协议及原始失败字段；对请求、版本、摘要和比较失败原因保留白名单诊断，再修确证的探针机制问题 | 调查中；尚未运行新探针 |

## 验证与边界

尚未运行新测试、类型检查、真实浏览器或主机。所有后续输出放系统 TMP，子进程隐藏并只清理本次归属资源。若需要修改产品，先提交精确因果和范围给主会话。

## 首次根因与窄修

原 `a5-fixture-project.json` 一直返回 `p-muzrks7j-a14e38ef@1` 的 accepted-snapshot，目标 clip 不存在；同轮 prerequisite 的真实 publisher 已为 `sp_minbc6gbwwrc65h52guson5lhr@4`，包含新目标，CPU step176.9ms、pipeline heavy、readiness全部成立。不是卡片又被测轻，也不是 snapshot 传输没回来。

`Preview.tsx` 的 publisher 以 `currentDocProjectId()` 与 shared DocSync.rev 发计划；`syncManager.ts` 的 join/bind 以共享 sp_ 项目键提交真实 project.op。内容 Project.id 仍为 p_，并用于层表索引。旧探针却用 p_ 读取 project.open，碰巧那里留有创建者旧发布的合法快照，读到了错误的流。此前单ID legacy测试没有覆盖真实双ID，因此未发现该夹具错误。

首无监听实际反例 `%TEMP%/pc-browser-doc-read-dual-id-counter.mjs` / `.log` exit0：真实 DocSync、bindStore、editCardProject、projectModule 和 TMP file store（只 transport 内存投递），旧内容键 rev1 无目标，共享权威键 rev2 有目标，正文仍保留旧内容ID且逐字等于已确认项目/真实store。没有运行浏览器、HTTP或TLS；未写成本、ready或capability。

三级解法表第1行收敛为：请求路由使用同一实际共享 projectId；helper 另收 expected contentProjectId，对 inline/chunked body 和 accepted-snapshot 都核正文身份；保留回复路由键、head版本/摘要、完整片序和回核。源hash/rev、目标clip/card/完整params/起止/总长与版本增加全部保留。诊断逐项保存比较结果，不能用一个 false 隐去原因。产品无改动。

新增 `--stop-after-doc-read` 明确是部分诊断，保留前序真实页面流程、成本与成功计划前置，完整当前全文成立后立即进入原finally清理，不启动host，不声称完整C10通过。默认运行不变，主机完成/同clip/hostFP/non-dedup/newresultKey原尺子不动。本次先此有界诊断；通过后才单次完整强化probe。
