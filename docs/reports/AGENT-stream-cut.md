# AGENT-stream-cut

分支 `claude/stream-cut`（从 main `0c65a3c6` 切出），worktree `.worktrees/stream-cut`。

任务（用户 2026-10-22 定，原话）：「现在修：中途被网关掐断按截断处理（保住半截参数、走代码块续写），按实测速度给单次输出设上限；顺带把合并窗口放宽到 1 秒。」

〔裁〕指本会话自己定的细节（用户没逐条定），合入 main 前请用户审，可以推翻。A07 指上一轮「回复被截断时接着写、代码块空间」那项（报告 `docs/archive/agent-reports/AGENT-output-cache.md`）。

## 一、做了什么

### 1. 中途被网关掐断按截断处理

- `server/harness/providers/base.mjs`：新停止原因 `stream_cut`（常量 `STREAM_CUT`）；`isCutReadError` 判读流时的错能不能当掐断；`streamCutNotice` 交给运行日志的提示；provider 契约里补 `response_open` 事件（带最后一次真正发出请求的时刻，给速度记录用）。
- 三家 provider（`openai.mjs`、`anthropic.mjs`、`gemini.mjs`）：流**已经出过数据**（文字、思考、工具调用）之后、**正常收尾**（`finish_reason` / `message_stop` / `finishReason`）之前结束的三种情况——流里来了 error 事件、读流时连接被断、流读完却没有收尾标志——都以 `stream_cut` 收尾：
  - 已经收到的文字照常交出；写完的工具调用照常交 `tool_use`；参数 JSON 解不开的（以及 OpenAI 兼容口参数一个字还没来的）交成 `tool_use_partial`（带收到的参数原文）。
  - Gemini 的工具调用整块到达，没有半截可保；它另把 `thoughtsTokenCount` 报成 usage 的 `thoughts`（只给速度记录用，用量照旧只记 `output`）。
  - 每次掐断交一条 `notice`（`stage: 'stream-cut'`，`how` 是 `error-event` / `connection` / `no-finish`，带网关原话），`agent.mjs` 把它转成 `diagnostic` 事件。
  - **还没出数据就失败的照旧抛错**；正常收尾之后再来的错不再影响这次回复（原来会把已经收尾的回复也报成错）〔裁〕。
  - 我们自己的闲置超时（120 秒不出字，`idle-timeout.mjs`，错名 `TimeoutError`）和用户点停止**不算**掐断，照旧〔裁〕：那是上游不出字，原来就有可续跑。
- `server/harness/agent.mjs`：`stream_cut` 并进按截断处理的停止原因，存代码块、让模型接着写、次数上限（有进展 6 次、没进展连续 3 次）都和写到上限相同；`truncated` 诊断带 `cause: 'cut' | 'length'`。停下时的话分三种：全是掐断——「模型的回复[连续 N 次]被网关中途掐断（网关对单次请求有时长上限），这一轮没能完成。[已经写出的部分存在代码块 …]可以把要求拆小一点再发。」（**不叫人调大上限**，调大只会更容易撞网关）；全是写到上限——原话不变；混着来——「…被截断（超过单次输出上限或被网关中途掐断）…」〔裁〕。
- `server/harness/truncation.mjs`：`salvageTruncation(partials, store, { cause })`，`cause: 'cut'` 时给模型的话开头是「你上一条回复写到一半，连接被网关中途掐断了（网关对单次请求约有 300 秒的时长上限，和单次输出上限无关：一次写得越长越容易撞上）」，每条写「…被网关掐断，这次调用没有执行」；状态行是「模型这次回复写到一半被网关中途掐断了（网关对单次请求有时长上限）；写了一半的 X（N 字） 已存进代码块 B，已让它接着写。」
- `server/runners/api.mjs` 的超时续跑：**出过数据之后的掐断不会走到这里**（harness 里已经按截断接着写了），所以不需要为它改续跑。还没出数据就被断开的，先走原有的 `retry-fetch.mjs` 首块预读重试（它本来就认 `upstream` 这类可重试的 SSE error）；重试用完抛到 `api.mjs` 时，新增 `STREAM_DROPPED`（`upstream stream ended`、`before the response was complete`、`响应流提前结束`、`terminated`、`other side closed`、`socket hang up`）也标成 `retryable`，本机自动接着说一次〔裁〕。
- 模拟 provider（`mock.mjs`）加脚本步骤 `{ "cut": { tool, args, say } }`，以 `stream_cut` 收尾（测试与探针用）。
- `server/ai-system-prompt.md`「代码块」一节补一句：网关对单次请求有时长上限（约 5 分钟），写得太久也会在中途被掐断，结果和截断一样。

### 2. 按实测速度给单次输出设上限

新增 `server/harness/output-speed.mjs`。单次上限 = min(模型上限, 配置上限, 速度 × 250 秒)，速度那一项不低于 4096。`model-limits.mjs` 的 `resolveMaxOutput` 认新参数 `cfg.outputCap`（回数字的函数），没给时与原来相同；三家 provider 每次请求都调它，所以同一轮里速度记录更新后，下一次请求就用新上限。`api.mjs` 建 provider 时给 `outputCap`，并把 provider 包一层 `withOutputSpeed` 记样本（模拟 provider 不包）。

数字与做法全部〔裁〕：

| 项 | 取值 | 理由 |
|---|---|---|
| 网关上限 `GATEWAY_REQUEST_LIMIT_S` | 300 秒 | 2026-10-22 实测 openlux：流式请求在 300.7 秒收到 error |
| 预算 `OUTPUT_TIME_BUDGET_S` | 250 秒 | 留 50 秒给速度波动（实测约 3 倍）、首字前的等待和网络；任务书建议值 |
| 样本 | 输出 token（含思考）÷ 从**发出请求**到结束的用时 | 网关的钟从发出就开始走；有的上游不把思考流出来，从第一个字算会把速度算高。这样算偏低，即偏保守 |
| 不记的样本 | 输出不到 2000 token | 短回复的用时几乎全是首字前的等待 |
| 被掐断、用量没回来 | 收到的字数 ÷ 4 当 token 数 | 中文常常一字一 token，按 4 字一个只会估低 |
| 取哪个 | 每模型留最近 10 个、14 天内；从慢到快排取四分之一处（不到 5 个取最慢） | 偏保守，又不让一个特别慢的样本压住 10 次 |
| 没有样本 | 40 token/s → 10000 token | 实测 Gemini 最慢 50 再留两成；Claude 没测，大模型常见每秒几十个 token |
| 下限 | 4096 | 太小连普通工具调用都装不下 |
| 键 | 模型名小写 | 同一模型走不同网关不分（现在只有一个网关） |

速度记录存哪〔裁〕（查过三处进程的生命周期）：

- 本机编辑器（`instance.mjs` 本机那条路传 `outputSpeedFile: 'local'`）：`ai.json` 同目录的 `output-speed.json`（与审查环路的教训同目录；不放系统临时目录，那里会被清）。
- 云端账号模式（`account-runner.mjs`）：任务进程每轮新开一代，进程内存留不住，所以放共用数据目录 `usage/model-speed.json`。`usage/` 本来就是任务进程写用量、主服务读的目录（`usage.mjs`，它只认 `yyyy-mm.jsonl`，不会误读这个文件）；systemd 单元的 `ReadWritePaths` 是整个数据目录。
- 云端旧托管档（`create-agent-service.mjs`）：`<数据目录>/usage/model-speed.json`。
- 主服务进程内存不选：账号模式下模型请求都在任务进程里发，主服务看不到用量与用时。
- 宿主没给（测试、别的调用方）：只记在内存里。
- 同一进程按文件路径共用一份；写的时候先读一次合并再写临时文件、改名，几个进程同时写不加锁，最多丢一两个样本；文件坏了或写不进当没有记录。
- 上限变了时进一条 `diagnostic`（`stage: 'output-speed'`：速度、样本数、上限）；没变不重复报（账号模式下每条事件都要写进文档服务）。`configuration` 诊断里加了 `speedCap`。

### 3. 合并窗口放宽到 1 秒

`server/agent/service/coalesce-run-events.mjs` 的 `COALESCE_WINDOW_MS` 250 → 1000。字数阈值 `COALESCE_MAX_CHARS` 4000 不调〔裁〕：实测最快约 190 token/s，1 秒里攒不到 4000 字，正常流下它碰不到；它只管网关一次吐出一大段时单条事件别太大，调大调小都不改变正常长回复的条数。桌面本机那一路（`instance.mjs` 每个增量直接写给页面）没改。

### 4. 语义文档

- `docs/semantics/mechanism/agent.md`「单次输出上限、截断续写与代码块空间」一节：改正「三家本来都是流式请求，大数不会撞 HTTP 超时」（流式也撞网关的时长上限）；新增「网关单次请求的时长上限」「中途被掐断按截断处理」「按实测速度设单次上限」「云端事件合并窗口」四条，用户定的标 2026-10-22 并引原话，细节标〔裁：stream-cut 2026-10-22〕。
- 同文件「出错时的话对照表」：云端表加「回复被网关中途掐断、次数超限」「回复被网关中途掐断、已让它接着写（不是出错）」「网关在回复开始前就断开」三行，本机表加一行；我改动影响到的行号（`agent.mjs`、`truncation.mjs`、`openai.mjs`、`gemini.mjs`、`api.mjs`、`account-runner.mjs`、`instance.mjs`、`create-agent-service.mjs`）都按本分支重新对过，表头改成以 `claude/stream-cut` 为准。
- `docs/semantics/product/agent.md`「回复被截断时接着写，不白写」一条下补「被网关中途掐断也一样」（标 2026-10-22 用户定、引原话）。

## 二、〔裁〕清单

| 编号 | 内容 | 在哪 |
|---|---|---|
| 裁1 | 「出过数据」= 收到过文字、思考或工具调用（OpenAI 兼容口只有 `role` 的首块不算） | 三家 provider |
| 裁2 | 闲置超时、用户停止不算掐断；正常收尾后再来的错忽略 | `base.mjs` 的 `isCutReadError`；三家 provider |
| 裁3 | 掐断时参数一个字没来的工具调用交成空的 `tool_use_partial`，不当 `{}` 执行 | `openai.mjs` |
| 裁4 | 掐断和写到上限共用一套次数上限；停下的话按三种情况说，全是掐断时不叫人调大上限 | `agent.mjs` |
| 裁5 | 回复开始前就断开的标成可续跑（`STREAM_DROPPED`） | `api.mjs` |
| 裁6 | 速度的算法与全部数字（见上表） | `output-speed.mjs` |
| 裁7 | 速度记录存放：本机 `ai.json` 同目录、云端 `usage/model-speed.json` | `output-speed.mjs`、`api.mjs`、`instance.mjs`、`account-runner.mjs`、`create-agent-service.mjs` |
| 裁8 | 合并窗口的字数阈值不调 | `coalesce-run-events.mjs` |

## 三、验证

### 1. 类型检查

`npx tsc -b --force` → `TSC_EXIT=0`，零错误。

### 2. 新增单测与端到端（`server/test/stream-cut.test.mjs`，不调真模型）

`npm test -- server/test/stream-cut.test.mjs`：pass 21、fail 0。覆盖：

- OpenAI 兼容口：流中途来 error 事件（用实测那句原文）、连接被断（`TypeError: terminated`）、没有 `finish_reason` 就结束——文字保留、写完的 `add_clip` 照常交、半截 `create_card` 交成 `tool_use_partial`（原文一字不差）、以 `stream_cut` 收尾、交 `stream-cut` 提示；参数一个字没来的也交成 partial。还没出数据就失败的（error 事件、断连接、空流）照旧抛错。正常收尾后再来的错不影响；闲置超时（`TimeoutError`）照旧抛。
- Anthropic：error 事件（`overloaded_error`）、断连接、没有 `message_stop`——同上；还没出内容的三种照旧抛错。
- Gemini：error 事件、断连接、没有 `finishReason`——文字和整块到达的工具调用保留、没有 partial、以 `stream_cut` 收尾，usage 带 `thoughts`；还没出内容的照旧抛错；正常 `STOP` 照旧。
- 给模型的话与状态行说「被网关中途掐断」「和单次输出上限无关」，不出现「单次输出上限」；写到上限那种原话不变。
- Agent：`stream_cut` 存代码块、让它接着写 6 次，第 7 次报「模型的回复连续 7 次被网关中途掐断（网关对单次请求有时长上限），这一轮没能完成。已经写出的部分存在代码块 cut_create_card_1…」，不含「调大单次输出上限」；掐断与写到上限混着来时话里两样都说。
- 速度：常量（300、250）；没记录时 40 × 250 = 10000；太短不记；不到 5 个取最慢、多了取四分之一处；下限 4096；14 天前的不算；上限 = min：没记录 10000、有记录（120 token/s）30000、配置更小（20000）用配置、模型上限更小（500 token/s 时 Gemini 停在 65536）、没给 `outputCap` 与原来相同；记录存文件后新建的一份（相当于下一代任务进程）读得到，两份各记一笔合并不丢，文件坏了当没有记录；包一层 provider 按 usage（含思考）记样本、掐断时按字数 ÷ 4 估（60000 字 / 300 秒 → 50 token/s → 上限 12500）。
- **端到端（本机假网关，5990～5999 里起的 HTTP 服务，真 fetch）**，两种掐法各一遍：「网关」在第一次请求里写出「我来建这张卡。」和半截 `create_card` 参数后，① 发 `The upstream stream ended before the response was complete.` 的 error 事件并结束、② 直接断 TCP 连接。之后「模型」按提示 `code_cache_append` 接着写、再以 `@code_cache:cut_create_card_1` 交给 `create_card`、说一句收尾。断言：一共 4 次请求；第一次请求的 `max_tokens` 是 10000（没有速度记录，按缺省）；第二次请求里交给模型的话含「连接被网关中途掐断了」和块名；掐断那次的文字留在历史里；`create_card` 只执行一次、源码与完整源码逐字相同；状态行是「…被网关中途掐断了（网关对单次请求有时长上限）；写了一半的 create_card（N 字） 已存进代码块 cut_create_card_1…」，没有一行说「超过单次输出上限」；`stream-cut` 诊断的 `how` 分别是 `error-event` / `connection`；一轮以 `completed` 收尾；Key 不进事件。
- 端到端：回复开始前就被网关断开——先按原有重试重发一次（假网关收到 2 次），然后报错、`retryable: true`、没有 `truncated` 诊断、`create_card` 没执行。
- 模拟 provider 的 `cut` 步骤走通同一条路。

### 3. 改动的旧测试

- `server/test/coalesce-run-events.test.mjs`：加一项「窗口缺省 1000、阈值 4000、计时器按 1000 毫秒起」，6 项全过。
- `server/test/api-retry-wiring.test.mjs` 第 c 项原来断言「流已经吐出一半后收到 error 或断流 → 直接报错」，和本次用户定的语义相反，按新语义改：同一请求仍绝不重发（三次请求内容各不相同，后一次带掐断提示），不再直接报错；同一处连掐 3 次、什么也没留下时报「连续 3 次被网关中途掐断」。改后该文件 7 项全过。

### 4. 全量

（见下一节补记。）

## 四、没做到的与原因

- 掐断那次的用量：OpenAI 兼容口的 usage 只在流尾，被掐断时拿不到，这次请求在用量流水里记成输出 0（网关那边多半照样计费）。速度记录按字数估了，用量流水没估：用量是计费依据，估出来的数不该进去。
- 速度没在真网关上验证（任务书要求不调真模型）。缺省 40 token/s 对 Claude 是否合适没有实测。
- 闲置超时（120 秒不出字）后已经写出的半截参数仍然丢（它照旧报超时、可续跑），本次按任务范围没改。

## 五、对任务书或语义的更正建议

1. 任务书说「`api.mjs` 的超时续跑也要认这种情况」：出过数据之后的掐断在 harness 里已经按截断接着写，不会再以错误到 `api.mjs`；需要认的只剩「回复开始前就断开」那种，已加（见裁5）。
2. 云端用量流水对被掐断的请求记 0 输出，建议以后按网关账单对账时留意；要不要估，需用户定（计费口径，属二级）。

## 六、部署清单（主会话去做，本会话不部署、不连节点）

- **变了的 `server/` 文件**：
  - 新增：`server/harness/output-speed.mjs`
  - 改动：`server/harness/agent.mjs`、`server/harness/model-limits.mjs`、`server/harness/truncation.mjs`、`server/harness/providers/base.mjs`、`openai.mjs`、`anthropic.mjs`、`gemini.mjs`、`mock.mjs`、`server/runners/api.mjs`、`server/agent/service/coalesce-run-events.mjs`、`account-runner.mjs`、`create-agent-service.mjs`、`instance.mjs`、`server/ai-system-prompt.md`
  - 测试：`server/test/stream-cut.test.mjs`（新）、`coalesce-run-events.test.mjs`、`api-retry-wiring.test.mjs`
- **`src/` 没有变。** 页面不用重新构建。
- **要不要重启**：
  - Agent 服务要重启：合并窗口在任务进程里生效（`coalesce-run-events.mjs` 只被 `account-runner.mjs` 引用），harness 与 `api.mjs` 也在任务进程里；空闲等任务的那一代已经载好旧模块。没有正在跑的任务时重启 `promptcut-agent-root.service`（槽重新开代）；`promptcut-agent-master.service` 建议一起重启，保持各进程同一提交（本次改动不靠主服务生效）。旧托管档（`create-agent-service.mjs`）若还在用，重启它所在的服务。
  - 文档服务、素材服务、渲染服务不用重启（没改）。
  - 本机桌面版：随下一版安装包或补丁生效。
- **部署后核**：节点上 `<共用数据目录>/usage/` 对任务进程用户可写（原本就写用量流水）；跑一轮长回复后看 `usage/model-speed.json` 有没有生成、诊断里 `output-speed` 的上限是多少。
