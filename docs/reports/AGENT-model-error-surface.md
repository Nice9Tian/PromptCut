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

## 第二轮:探针 E1～E3(ux-probe-account 报告)

探针期望(scripts/probes/cloud-agent-ux-ui-probe.mjs 的 E1～E3)与现状、改法:

| 项 | 现状 | 根因 | 改法 |
|---|---|---|---|
| E1 模型调用失败 | 气泡只有「上游接口 500」;历史列表标 idle | 账号运行器的模型错误事件没有 code,页面原样显示原文;文档服务的对话列表行没有 state(账本里已有 terminalOutcome.status=failed) | 页面:没带 code 的 error 视为模型调用失败,写「模型调用失败:原因」(中文原因保留,英文网关报错仍走分类句;已以「模型」开头的不叠前缀)。服务端:列表行带 state(最近一轮终态为失败/中断时给 failed / interrupted),历史列表原有的「出错」「已中断」标签即生效 |
| E2 额度用尽 | 气泡只有代号 quota-exceeded | server/agent/service/account-runner.mjs 的闸门拒绝只抛 fail(429, code),message 就是代号;gate.mjs 写好的「已用 N / 上限 M」没带出来 | 抛带 message 的错并设 runErrorCode(旧 Agent 服务 create-agent-service.mjs 第 649 行早就是这个写法),api 运行器据此发 error{code,message}。页面对带 code 的话原样显示,不加前缀。网关额度不足(英文 HTTP 403 quota)仍是「模型服务的额度不够…需要托管方充值」 |
| E2 再发被拒绝 | 没有明确拒绝 | 账号模式没有发消息时的准入,新一轮起来后第一次调模型才被闸门拒 | 同上:第二轮的气泡 error 就是带「额度已用完(已用 N / 上限 M)」的那句(探针接受「对话里:error 含额度」);没有另加发送前的拒绝(发送前拒要在文档服务/Agent 服务加准入,影响面更大,记为待用户项) |
| E2 账本里那一轮仍 running | 拖住下一轮 | 没能复现(没跑探针,见下) | 未改;如仍出现需在带探针的环境里复核 |
| E3 创建者关开关 | 横幅有、气泡无原因 | 进行中的那一轮被账本强制终态 interrupted/agent-disabled,没有 error 事件;页面兜底写的是「服务中断」 | 页面 settledPatch 按终态原因写话:agent-disabled「项目创建者已关闭云端 Agent,这一轮已停止…」、member-revoked、credential-revoked、private、worker-failed;模型下一次调用时撞上闸门(disabled)则 gate 的话「项目创建者已关闭云端 Agent。」随 error 事件带 code=disabled 显示 |

### 第二轮文件
- src/ai/cloud/events.ts:cloudErrorMessage 判模型错误、friendlyErrorMessage(message, model)、forcedStopReason
- src/ai/cloud/events.test.mjs:E1/E2/E3 三个新用例
- server/agent/service/account-runner.mjs:闸门拒绝带 message 与 runErrorCode
- server/account/conversation-authority.mjs:列表行 state(导出 lastRunState)
- server/test/conversation-list-run-state.test.mjs(新增)
- server/test/accept-018-auth-agent-path.test.mjs:额度用完的断言从 message===代号改为 code===quota-exceeded 且 message 含「已用 N / 上限 M」

### 探针没跑
`--steps errors` 的账号组合要 71 个连续端口(ACCOUNT_PORT_COUNT=71)加舞台、渲染等十几个,协调方给的 29200–29209 只有 10 个,放不下;并且探针的服务端代码取自它自己所在 worktree,要指向本 worktree 得把探针文件复制进来。没有越出端口段去跑。E1～E5 的探针结论因此没有;请主会话在给足端口段后,把本分支合到 ux-probe-account 的工作区(或相反)再跑 `--steps errors`。E4(渲染失败)、E5(被移出)不在本次范围,没动。

## 验证
- `npx tsc -b --force`:退出码 0,输出为空。
- `npm test`(设了 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,静默后台,记退出码):退出码 0;tests 7263,pass 7248,fail 0,skipped 15。
- 新增/改的用例单独跑:events.test.mjs 20 个全过(含第一轮 5 个、第二轮 3 个);activity-failed.test.mjs 2 个;conversation-list-run-state.test.mjs 3 个。
- 没起 dev server、没看真页面;没跑 UX 探针(见上)。

## 部署
- src/ 改动(events.ts、ActivityPanel.tsx、AgentBubble.tsx):整份 src 同步进渲染树,先换在线前端,再重启渲染服务。
- server/agent/service/account-runner.mjs:Agent 服务的任务进程用,换到 Agent 服务那棵树;任务进程是一条任务一个进程,新任务即生效,主服务建议一并重启 agent 服务。
- server/account/conversation-authority.mjs:文档服务(账号权威)用,换到文档服务那棵树后重启文档服务(重启前确认没有正在写入的客户端)。历史列表的「出错」标签要这一项才出来;不换它,其余改动照样生效,只是列表不标。
- 其余(测试文件)不部署。
