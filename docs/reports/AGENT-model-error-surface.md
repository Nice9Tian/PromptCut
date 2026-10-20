# AGENT-model-error-surface

分支 claude/model-error-surface(从 claude/accept-final3 @3fe1b146 切出)。任务:云端 Agent 一轮里模型请求失败(如额度不足 403),页面气泡空、「Agent 操作」写「这一轮没有操作」,看不出失败与原因;语义 product/agent.md「出错留痕」。

## 根因(读节点真实事件 + 本地用同形状事件重放)
- 节点事件记录(master-run-events.sqlite,对话 cc-mvfw3j7c-eqwh,run_8b0457ac,seq 211～218):user → run → session → diagnostic → progress("第 1/24 轮:正在等待模型响应…") → diagnostic → `error`(只有 `message`:`openai HTTP 403: token quota is not enough, token remain quota: ＄0.124114, need quota: ＄0.127928 (request id: …)`,没有 `code`)→ `runner_done{outcome:'failed'}`。第一个事件(user/run)之前并没有失败,所以「第一个事件之前就失败」的补位不适用。
- 把这 8 行用页面事件流同样的拼法(`{...row.event, projectId, conversationId, seq}`)喂 `applyCloudEvents` + `settleFromQueue`:`error` 事件**会**折进 `m.error`,结清后 `outcome:'error'`。也就是说原文英文报错(带金额、请求号)会以一行 12px 红字出现在气泡里,没有「人话」,且「Agent 操作」面板在 `!segs.length` 时无条件写「这一轮没有操作」,不看这一轮是否失败。用户看到的「空」是:没有文字回复 + 只有小号英文红字 + 面板说没有操作。**我没能在本地复现出 `m.error` 完全丢失**;若线上确有 `error` 事件到了页面却没显示,需要在线上浏览器里取 `[data-pc=agent-error]` 复核(本次给错误行加了这个标记)。
- 另:队列里失败终态没有 `error` 事件、也没有 `worker-failed` 原因时,`settledPatch` 兜底写的是「云端 Agent 服务中断」(误导),已改为「这一轮执行失败了」。

## 改法
- `src/ai/cloud/events.ts`:`cloudErrorMessage` 对服务端给的 `message` 过 `friendlyErrorMessage`:额度不足(402/403/429 + quota/balance 字样)→「模型服务的额度不够,这一轮没有执行(需要托管方充值)。已经落地的改动保留在项目里。」;凭证被拒、429 太忙、404 模型找不到、5xx、网络超时各一句人话;其它英文报错压成一句短原因(`shortReason`:去掉请求号、Bearer、sk-/token 样串、32 位以上长串、网址,截 80 字)。已经是中文的服务端话原样放过。`settledPatch` 的失败兜底改文案。
- `src/editor/right/chat/ActivityPanel.tsx`:空的一轮若 `m.error` 或 `outcome==='error'`,写「这一轮失败了,没有执行任何操作:<原因>」。
- `src/editor/right/chat/AgentBubble.tsx`:错误行加 `data-pc="agent-error"`、`role="alert"`。
- 服务端没改(原因由页面从已有的 `error.message` 翻译,不外露原文)。

## 文件清单
src/ai/cloud/events.ts、src/ai/cloud/events.test.mjs、src/editor/right/chat/ActivityPanel.tsx、src/editor/right/chat/AgentBubble.tsx、src/editor/right/chat/activity-failed.test.mjs、本报告。

## 部署
只改了 `src/`:整份 src 同步进渲染树,先换在线前端、再重启渲染服务。服务端(server/)没改,agent 服务不用动。

## 验证(5 小时额度暂停时的状态)
- 通过:`node --test src/ai/cloud/events.test.mjs` 14 个全过(含 5 个新增:真实事件行额度不足、重放幂等、无 error 事件的失败终态、friendlyErrorMessage 各类、已有行为不变);`node --test src/editor/right/chat/activity-failed.test.mjs` 2 个全过。
- 通过:`npx tsc -b --force` 退出码 0,零错误。
- 未完成:`npm test`(设了 PROMPTCUT_ACCOUNT_PROVIDER_ROOT / PROMPTCUT_PASSWORD_ORDER_MODULE,静默后台)在额度暂停时还没跑完,输出停在 /tmp/npmtest.out(账号相关用例已过到 RS18-chat),没有拿到总数。恢复后需:确认该进程是否还在(没在就重跑),取 `ℹ pass / fail` 总数;有失败的单独重跑给证据。
- 未做:没有在浏览器里看真页面(没起 dev server);「Agent 操作」面板与气泡只做了源码级断言。恢复后若有余量,可起 5450 段 dev server 看一眼失败轮的样子。
- 提交:fa61d73c(修)、e5bc9b6b(开工报告);本报告更新另提交。
