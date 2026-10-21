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

## 第三轮:在 accept-final3 上复现 E2 崩溃、E1～E5 逐项

分支已在 accept-final3(1f446ce2)之上,`npx vite build --mode online` 后跑 `--steps errors --dist dist-online`。

### 「那一轮一直 running / 发送按钮找不到」的根因(探针 E2 第 971 行崩溃)
- 不是账本里的轮没收尾:额度用尽那一轮在页面和账本里都正常收尾(failed)。
- 探针在 960～966 行发「再发」(`x`)后等"被拒绝并说明",它的退路分支是「最后一条助手消息不在跑、error 含"额度"、用户消息数≥2」。这三条在点击发送的当下就成立:最后一条助手消息还是**上一轮**那条(error 已是带"额度"的话),用户消息数因乐观气泡立刻 +2。所以 `until` 立刻返回,不等真正的拒绝。
- 随后探针 `admin quota clear`,实测点击发送到清额度完成只隔 **61 毫秒**(LAT 量到的 clearDone=61 ms,此刻页面还没收到任何拒绝);`x` 的请求是清额度**之后**才到服务端,额度已清,所以被**合法接受**并开始跑。探针接着 `idleNow` → `sendText`,点击时输入框已因 `x` 这一轮变成"排队/停止",`[data-pc="ai-send"]` 不在,崩溃。
- 上一版(修之前)同样崩,原因同上;之前报告里"账本里那一轮仍 running"是这场竞态的表象,不是账本缺陷。

### 改动(本轮新增)
- `server/agent-service/account-master-assembly.mjs`:`send` 在转给文档服务前用任务进程同一份闸(`gate.mjs` 的 `admitModelCall`,上限读共用数据目录的 `config/limits.json`、用量读 `usage/` 流水,只读)预检额度,用完当场回 429 `quota-exceeded` 和"已用 N / 上限 M"那句,不收下一条注定在第一次调模型时失败的消息;页面显示成 cloud-notice,用户消息标"没有发出去:…"。
- `server/agent-service/http.mjs`:读取被文档服务以 403 `agent-disabled` 拒绝时,`access.revoked` 带 `reason:"agent-disabled"`。
- `src/ai/cloud/session.ts`:
  - 创建者关开关后(`access.revoked` 带 reason;或重连取票据被拒 `disabled`;或读取 403 `agent-disabled`),正文清掉后在对话里留一条出错消息"项目创建者已关闭云端 Agent,这个对话已停止。已经落地的改动保留在项目里;重新打开云端 Agent 后可继续。",提示栏用"已关闭"那句而不是"无权读取";又读得到时(第一个事件到)撤掉这条。被踢、设私有等其它撤销照旧清空。
  - `view.streaming` 在账号模式下把队列里 preparing / running 的一轮也算进去(与输入框按队列算的"排队/停止"一致)。空闲时刚收下、还没轮到的排第一那条仍不算(`account-queue.test.mjs` 钉着的契约)。
- 测试:`private-revoked.test.mjs` 新增 PRIV-9/10/11 与 STREAM-1;`agent-events-denial.test.mjs` 新增 reason 用例。

### E1～E5 探针结果(--steps errors,同一份代码)
- **原版探针**(未改):E1 过;E2 在第 971 行崩溃(上述竞态),后面的 E3～E5 没跑到。多次运行同样结果。
- **验证副本**(只在"再发 `x`"之后插一行 `sleep(5000)` 让拒绝先到,其余断言一字不动;副本是临时文件,已删,未入库):**E1、E2、E3、E4、E5 全过,退出码 0**。E2 里: 第一轮 error 为"这个项目的云端 Agent 额度已用完(已用 721 / 上限 566)。请联系托管方。",再发被拒并出 cloud-notice 同一句,清额度后恢复。
- 结论:产品行为已满足"出错留痕"与 E1～E5;**原版探针 E2 本身有竞态**(退路分支被上一轮助手消息的 error 满足,且 61 毫秒就清了额度),与语义无关。建议把探针第 961～966 行的等待改成"等到 cloud-notice 出现,或等到**新增**的助手消息(数量比点击前多)带额度字样",并在清额度前等拒绝落定。我没有改探针。

## 验证
- `npx tsc -b --force`:退出码 0,输出为空。
- `npm test`(设了 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,后台静默,记退出码):退出码 0;tests 7282,pass 7267,fail 0,skipped 15。
- 单跑:`src/ai/cloud/*.test.mjs` 142 个全过;`server/test/agent-events-denial.test.mjs` 9 个全过。

## 部署清单
- **src/**(`events.ts`、`session.ts`、`ActivityPanel.tsx`、`AgentBubble.tsx`):整份 src 同步进渲染树;先换在线前端(`npx vite build --mode online` 出的 `dist-online`),再重启渲染服务。
- **server/agent-service/account-master-assembly.mjs、server/agent-service/http.mjs**:Agent 主服务那棵树 → 重启 Agent 主服务(`promptcut-agent`)。额度预检读共用数据目录的 `config/limits.json` 与 `usage/`,主服务进程要有读权限(它本来就读 `usage/` 给成员查用量)。
- **server/agent/service/account-runner.mjs**:任务进程用,和主服务一起换树;一条任务一个进程,新任务即生效。
- **server/account/conversation-authority.mjs**:文档服务(账号权威)那棵树 → 重启文档服务(重启前确认没有正在写入的客户端)。不换它,其余照样生效,只是历史列表不标"出错"。
- 测试文件不部署。
