# 计划：see_frames 边渲边交 + 用户插话

整理自 2026-09-11 的一轮规划(还没动代码)。出处写法:代码给 `文件:行号` 和原文;「验证」是跑过的算式;「Gemini 第 N 轮」是 agy 讨论原话。

---

## 先说三件和原先认知不一样的事

**1. 「一张一张渲」已经有人在改,而且快改完了。**
工作区里(未提交)`see_frames` 的多个时刻已经合成一次请求、一趟渲完:
- 出处:"**一次请求、服务端一趟渲完**(从第 0 帧顺推,沿途截这几帧)"——`src/editor/right/index.tsx:1908`(工作区版本)
- 出处:"准备一趟(常驻 worker 里换页)只要约 0.3 秒"——`server/vite-plugin-vision.ts:1303`
- 正在跑的会话「执行中:实施渲染提速计划」在改 `vite-plugin-vision.ts`、`index.tsx`、`scripts/render-worker.mjs`、`scripts/export-frames.mjs`。**本计划排在它提交之后**,不和它同时碰这几个文件。

**2. 「流式插入上下文」对三个 CLI 后端做不到,只能做成「分批」。**
- 一次 MCP `tools/call` 只回一次结果;我们的 MCP 服务器没有 `notifications/progress`(`server/mcp-server.mjs`,全文无 progressToken)。
- 出处:"Progress notifications from the server do not extend the wall-clock timeout—they're informational only."——Claude Code 文档 mcp.md(经文档助手摘录,原页未亲自打开)。
- 所以通用的做法是:**先把已经渲好的交回去,剩下的让模型再调一次取**。真正「推进上下文」只有自研 API 循环能做(它的历史在我们手里)。

**3. 合成一趟之后,长时间轴仍然会超时。** 没传 `clipId` 时渲的是整条时间轴,要看靠后的时刻必须从第 0 帧推过去:
- 出处:"所以要看第 t 秒,只能从片段起点推过去。"——`docs/hybrid-sampling-plan.md`「为什么卡片不能直接跳到任意时刻渲染」
- 验证(`est2.mjs`,参数取自 `vite-plugin-vision.ts:1303/1014/1314` 和 `mcp-tools.mjs:983`):

| 整条时长 | 一趟耗时 | 再加满 25 秒排队 |
|---|---|---|
| 60 s | 33~42 s | 58~67 s |
| 180 s | 98~125 s | 123~150 s |
| 300 s | 163~207 s | 188~232 s,**超过 180 秒上限** |

- 而一超时,已经渲好的全丢:出处 `pendingCalls.delete(id); resolve({ ok: false, error: \`${tool} 超过 ${…} 秒没有返回,已放弃等待。\` })`——`server/vite-plugin-ai.ts:260-261`。晚到的结果找不到 pending 项,静默丢弃。

---

## 假设

- 「看很多帧」主要指 `see_frames` 的 `times` 模式(最多 10 个时刻)和素材模式翻页。
- 四个后端都要能用;允许 API 后端体验更好一些。
- 插话不打断正在跑的那个工具,等它返回后再插。

## 推荐方案和候选

| 路线 | 结论 |
|---|---|
| 只靠提速,不做分批(Gemini 第 1 轮路线 2) | 不够:300 秒时间轴一趟就要 163~207 秒(见上表);超时丢帧的缺陷也还在。Gemini 第 2 轮看过数字后改口:"不是过度设计 [有把握]"。 |
| 纯异步:see_frames 立刻只回 jobId(Gemini 第 1 轮路线 1) | 短活退步:现在几秒就能看到画面,改成永远先空手回来、多一次往返。把它作为「软截止时一张都没出」的退路。 |
| 插话时中止进程、带着插话重开回合(Gemini 第 1 轮路线 3) | 就是现在「忙时发送 = 打断」(`src/ai/useAiChat.ts:461` `abort();`),正在跑的工具结果会丢。 |
| **推荐:软截止分批 + 服务端插话队列,每个后端用它能做到的最强送达方式** | 下面展开。 |

### 第一部分:see_frames 分批返回

1. **边渲边收。** 导出脚本本来就是截一帧写一帧:出处 `writes.push(fs.writeFile(path.join(framesDir, \`${name}.${ext}\`), buf));`——`scripts/export-frames.mjs:540`。给 `renderFrames` 加 `onFrame` 回调:目标帧的 PNG 一落盘,就合成素材层、缩到 768,放进作业表。写盘是异步的,读到的文件可能不完整,解析失败就等下一次再读(或者改成 worker 显式通知,那要动 render-worker,排在提速会话之后)。
2. **软截止先交。** snapshot 变成作业:`{ jobId, 已完成帧, 总数, 已推到第几秒, done }`。到软截止(先定 40 秒,远低于 180 秒硬上限)时:
   - 有帧就把已完成的交回,附一行"还有 N 张在渲,已推到 X 秒;用 `see_frames({ jobId })` 取剩下的";
   - 一张没有也不报错,回"仍在渲,已推到 X 秒",带 jobId。**这一条单独就能消灭超时**。
3. **续取用长轮询。** `see_frames({ jobId })`:有新帧立即回,最多等 25 秒,不重复发已经给过的。复用 `see_frames` 这个名字、不新增工具,`tool-schema.test.mjs` 固定的「放宽超时的工具」清单不用动。
4. **模型可以只看一半就停。** 作业没人取超过 N 分钟就取消,释放 worker。
5. **(可选,第二阶段)API 后端真推。** 在自研循环里,续批不用模型开口要,每一轮之间自动并进 user 消息。等 CLI 的做法跑顺了再说,免得两套行为。

### 第二部分:用户插话

1. **前端**:忙时回车 = 插话(`POST /api/ai/interject {runId, text}`),■ 按钮照旧是停止。气泡显示三个状态:排队中 → 已送达 → 回合结束还没送达的,自动当下一条消息正常发出(和 agentBus 已有的「正忙就攒着,跑完再送」一个路子,`src/ai/agentBus.ts:13-14`)。
2. **服务端**:常驻的 Vite 服务端给 `activeRuns[runId]` 挂一个收件箱。不放在 MCP 进程里——MCP 进程只是薄转发(这一点回应 Gemini 第 1 轮"插话就会丢失"的担心)。
3. **送达方式按后端分**:

| 后端 | 送达方式 | 现状出处 |
|---|---|---|
| 自研 API | 每个工具跑完、下一轮开始前取收件箱,`history.appendUserText` 并进 tool_result 那条 user 消息,前缀「[用户在你工作时补充]」 | 历史"**不许出现两条连着的 user 消息**"——`server/test/history-consecutive-user.test.mjs:4`;并进同一条就不违反 |
| Claude CLI | 先做实验:`--input-format stream-json` 保持 stdin 打开,中途写 user 消息;收到 result 再关 stdin。行为是「立即插进」还是「排到回合末尾」,文档没写 | 现在 `child.stdin.write(opts.prompt); child.stdin.end();`——`server/runners/claude.mjs:223-224` |
| agy | 实验:已经是 stream-json 输入,试试不 `end()` 再写一条 | `...write(JSON.stringify({ event: 'user', ... }) + '\n'); childController.child.stdin.end();`——`server/runners/agy.mjs:251-252` |
| Codex(exec) | 通知模式(下一行) | 中途插入只有 app-server 有:"Use `turn/steer` to append more user input to the active in-flight turn."——learn.chatgpt.com/docs/app-server;我们用的是 `exec` |
| **所有 CLI 的兜底:通知模式** | 我们任何工具的结果末尾附一行固定格式"用户有新消息,调用 check_messages 读取";正文只由 check_messages 返回;系统提示词写明这个约定 | `check_messages` 已存在(`server/mcp-tools.mjs:1166`) |

通知模式是 Gemini 第 1 轮挑出"搭便车语义污染"之后改的:原来打算把插话正文直接塞进工具结果。

---

## 步骤

0. **等提速会话提交**。按「先提交再构建」,基于它的提交开分支。
1. **三个实验**(半天)。产出三个是/否:
   - (a) `renderFrames` 期间 frames 目录里的 PNG 是不是逐张出现;
   - (b) Claude CLI stream-json 在工具调用途中写 user 消息,是马上生效还是排到回合末尾;
   - (c) agy 同上。
2. **see_frames 分批**(1~1.5 天)。改 `vite-plugin-vision.ts`(作业表、onFrame、软截止)、`index.tsx` 的 seePreview、`mcp-tools.mjs` 的描述。测试用假 runExport 慢速出帧。
   - 完成的标志:300 秒项目 10 个时刻,首批 ≤ 45 秒回来;续取之后 10 张齐全,和一次性渲出的逐字节相同;硬上限到了也不丢已完成的帧。
3. **插话:服务端 + API 后端 + 前端**(1 天)。
   - 完成的标志:`history-consecutive-user` 测试仍然通过;插话出现在下一轮的同一条 user 消息里;回合结束还没送达的,自动作为下一条发出。
4. **插话:CLI 后端**(按实验结果 0.5~2 天)。先给三个 CLI 都上通知模式;Claude / agy 实验成功的,换成真插入。
5. **真实环路验证**。puppeteer 自己开编辑台跑一次长时间轴审查,改了 harness 要重启 dev server。

## 优点

- **超时不再等于白干。** 软截止回的是进度和 jobId,不是报错。
  出处:现在超时是 `resolve({ ok: false, error: … 已放弃等待。 })`——`server/vite-plugin-ai.ts:261`。
- **渲染和模型看图重叠。** 模型看首批时后面还在渲,看够了可以不取剩下的。
  出处:导出沿途逐帧写盘——`scripts/export-frames.mjs:540`。
- **分批对四个后端通用。** 它只是普通的工具调用,不依赖 CLI 支持 progress。
  出处:"informational only"——Claude Code 文档 mcp.md(文档助手摘录)。
- **插话和分批互相成全。** 工具返回得越早,插话送达的点就越早。
  出处:工具是串行执行的,`for (const call of calls) {`——`server/harness/agent.mjs:119`。

## 缺点

- **首批是时间最早的那几帧,不一定是模型最关心的。**
  出处:`.sort((a, b) => a - b)`——`server/vite-plugin-vision.ts:1024`。只推一趟决定了只能按时间顺序出。
- **多一次往返,模型可能忘了取剩下的。** 描述里要写清楚;作业超时自动取消兜住资源。(一般经验,无原文)
- **插话最快也要等当前工具返回。** 分批之后最坏约等于软截止的 40 秒。
  出处:同上,`agent.mjs:119` 工具串行。
- **通知模式可能被模型无视,而且回合里再也不调工具时就触发不了。**
  出处:"模型可能认为当前推理链更重要,看到提示也不立刻调 `check_messages`"、"零工具死角"——Gemini 第 2 轮,「有把握」,未核实;已经用「回合结束自动当下一条发」兜底。
- **Claude 系模型对工具结果里自称"用户说"的内容有防注入倾向。** 通知只放一行固定格式、正文走 check_messages,可以缓解,但要实测。(一般经验,无原文)

## 限制

- **CLI 后端里,一个工具的结果只能一次性交回。** 所谓流式,只能做成分批。
  出处:"informational only"(同上);`mcp-server.mjs` 没有 progress 的实现。
- **一个靠后的时刻,等待时间省不掉。** 看 300 秒时间轴的最后一秒,单这一张就要推 163~207 秒;分批只能让前面的先交,软截止只能保证不超时。
  出处:"只能从片段起点推过去"——`docs/hybrid-sampling-plan.md`;验证见上表。
- **Codex exec 没有中途输入的通道。** 要真插入就得把 codex runner 换成 app-server,那是另一件大事。
  出处:turn/steer 文档(learn.chatgpt.com/docs/app-server);`codex.mjs` 用的是 `exec`。
- **历史里的截图只保留最近 10 张。** 分批不会让模型一次看到更多。
  出处:`pruneImages(keep = 10)`——`server/harness/history.mjs:75`(探查时读到)。

## 第一步

等提速会话提交后(半小时内):用一个 3 分钟的项目调一次 `times`(给 10 个时刻,最后一个放在片尾),渲染期间每秒列一次 `out/export-vision-*/frames/`,确认 PNG 是逐张出现的,并记下第一张出现的时刻。这一条决定了分批取帧能不能不动 render-worker。
