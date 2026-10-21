# AGENT-output-cache

分支 `claude/output-cache`（从 main `cc716da3` 切出），worktree `.worktrees/output-cache`。

任务：A07（回复被截断：调大单次输出上限、截断后续写、代码块空间）与 A04（云端出错那几句话的对照表）。A07、A04 是用户 2026-10-22 对总审报告第一批条目（A01～A10）的回复编号，原话见 `docs/plan/user-decisions-2026-10-21.md` 第 7 节。

〔裁〕指本会话自己定的细节（用户没逐条定），合入 main 前请用户审，可以推翻。

## 一、做了什么

### A07-1 单次输出上限调大

- 新增 `server/harness/model-limits.mjs`：按模型名查真实的单次输出上限。Claude 当前各型号 128000（Haiku 4.5、Sonnet 4.5、Opus 4.5、Sonnet 4 为 64000，Opus 4 / 4.1 为 32000，数字取 claude-api 技能的模型表）；GPT-5 及以后 128000、o 系 100000、gpt-4.1 32768、gpt-4o 16384；Gemini 2.5 及以后 65536、2.0 / 1.5 为 8192；认不出的给保守值 16384。
- 三家 provider 不再写死 `cfg.maxTokens || 4096`。配置里的 `maxTokens` 改成「上限的上限」：发出去的是它和模型上限里小的那个；没写、写 0、或等于旧缺省 4096 时当作没写，用模型上限〔裁〕。理由：4096 是 `ai-config.mjs`、`set-key.mjs`、`service-keys.mjs` 在用户没填时自动写进配置文件的，不是谁特意定的；照它办就永远调不大。这三个文件不在我的改动范围里，没动。
- OpenAI 兼容口：o 系、GPT-5 及以后发 `max_completion_tokens`，其余发 `max_tokens`，两个不同时带。
- 400 处理：报错说输出上限太大，按报错里写的上限（没写就取下一档）重发一次；OpenAI 兼容口报错说字段名不对，就换另一个字段重发一次。各至多一次，记日志 `[harness.max-output-fallback]`，并以 `diagnostic` 事件（`stage: 'max-output-fallback'`）进运行日志与诊断报告。Gemini 原来「400 就去掉思考档重发」的做法保留，排在降档之后。
- `server/agent/service/model-config.mjs`：读写缺省从 4096 改成 0（= 按模型）。`server/runners/api.mjs` 的输入预算也改按实际的输出上限算。

### A07-2 截断后续写

- provider 在写到上限（OpenAI 兼容口 `length`、Anthropic `max_tokens`）时，把参数 JSON 解不开的那次工具调用交成新事件 `tool_use_partial`（带收到的参数原文），不再整个丢掉；写完的那几次照常执行。原来 `openai.mjs` 在 `length` 时会把半截调用交成带 `inputError` 的调用、执行时报「参数 JSON 不完整」，结尾那行 `partialToolCalls = {}` 实际上不起作用；Anthropic 原来在 `content_block_stop` 就报参数错误。现在两家都按停止原因区分。
- 新增 `server/harness/partial-json.mjs`：从半截 JSON 里取出写到一半的那个字符串字段（最后一个没收引号的；没有就取最长的），以及已经写完的其它字段；转义写到一半的那一截丢掉。
- 新增 `server/harness/truncation.mjs`：把取出的内容存进新代码块 `cut_<工具名>_<序号>`，并写好给模型的话：哪个工具、哪个参数、写到第几行、存在哪个块、结尾三行、其它参数原样、怎么接着写（`code_cache_append` 从断开处接着写，一次几百行以内；写完以 `@code_cache:<块名>` 交给原工具）。半截的调用本身就是 `code_cache_append` / `code_cache_write` 时，写出的那一截直接接进那个块。
- `server/harness/agent.mjs`：截断时调上面这个，状态行写明存进了哪个块；有完整工具调用又有半截调用时，完整的照常执行，接着写的话跟在工具结果后面同一条消息里。次数上限〔裁〕：每次都留下内容的截断一轮最多接着写 6 次（第 7 次停）；什么也没留下的连续 3 次就停（原来的规则）；到轮次上限也停。停下时的错误话写明已经写出的部分存在哪个代码块。
- 模拟 provider（`mock.mjs`）加脚本步骤 `{ "truncate": { "tool", "args", "say" } }`，测试与探针用。

### A07-3 代码块空间

- 新增 `server/tools/code-cache.mjs`：六个工具 `code_cache_write`、`code_cache_append`、`code_cache_read`（整块、按行、按字符，一次最多交回 60000 字并说下一段从哪开始）、`code_cache_replace`（原文须唯一，或 `all: true`）、`code_cache_list`、`code_cache_delete`；上限一块 2 MiB、一个项目 64 块、合计 16 MiB〔裁〕。
- 引用：任何工具的字符串参数整个写成 `@code_cache:<块名>`，`harness/agent.mjs` 在调用前换成内容（嵌套的也换）；块不存在时这次调用报错不执行。历史和事件里留的还是引用。
- 存在哪〔裁〕：用户说「给项目一个代码块空间」，所以按项目放，一个目录一个项目，一块一个 `.txt`，`index.json` 记更新时间和最后写它的对话。
  - 本机：`exports/ai-workspace/code-cache/<项目 id>`（没绑项目时 `local`），由 `instance.mjs` 的本机那条路给。
  - 云端账号模式：共用数据目录 `tenants/<项目 id>/code-cache`，与这个项目的对话目录同级，各代任务进程都看得到（`account-runner.mjs` 给）。查过「项目范围的运行素材存储」（素材服务里的项目素材）：它是给媒体素材的、经素材服务的接口与授权，拿来存频繁追加的文本草稿既慢又会出现在素材库里，不合适。
  - 云端旧托管档：`<数据目录>/tenants/<项目 id>/code-cache`，删项目时随 `tenants/<项目 id>` 一起清（`create-agent-service.mjs` 给）。
  - 宿主没给目录时（测试、别的调用方）：放在这个对话的历史文件旁边，只在这个对话里有效。
- 不进项目文档、不经文档服务、不进撤销历史、不同步给别的成员〔裁〕。理由：它是 Agent 的草稿，不是项目内容；放进项目会让每次追加都成为一次项目提交、进历史、推给所有成员。
- `server/harness/tools/index.mjs` 把六个工具加进交给模型的清单，本机与云端都有，不受托管档开放清单限制（只读写这个项目的代码块目录）。
- 系统提示词：`server/ai-system-prompt.md` 加「代码块」一节（什么时候用、截断后怎么接着写）；`harness/agent.mjs` 的执行规则里加一句。

### A04 出错时的话对照表

`docs/semantics/mechanism/agent.md` 末尾加「出错时的话对照表」一节：通则（气泡、「Agent 操作」面板、云端的话怎么来、排查从哪看）加五张表：云端一轮里出错、账号模式强制结束、发消息被拒、读不了对话、本机模式。来源是 `src/ai/cloud/events.ts`、`session.ts`、`cloudApi.ts`、`chatTexts.ts`、`src/editor/right/chat/ActivityPanel.tsx`、`AgentBubble.tsx`、`UserBubble.tsx`、`src/ai/useAiChat.ts`、`server/agent/service/gate.mjs`、`account-runner.mjs`、`create-agent-service.mjs`、`conversations.mjs`、`instance.mjs`、`server/agent-service/account-master-assembly.mjs`、`server/runners/api.mjs`、`server/harness/**`，以及本次 A07 的截断那几句。只读这些前端与服务端文件，没改它们的文字。

### 语义文档

- `docs/semantics/product/agent.md`「工具」加「回复被截断时接着写，不白写」一条，标 2026-10-22 用户定并引原话；代码块不是项目内容、次数上限两处标〔裁〕。
- `docs/semantics/mechanism/agent.md` 加「单次输出上限、截断续写与代码块空间」一节（全节〔裁〕）和 A04 对照表。

## 二、研究结论

1. **openlux 文档**（主会话已读，记录在 `user-decisions-2026-10-21.md` 第 7 节）：推理模型主要认 `max_completion_tokens`；思考算进输出 token；流式可带 `stream_options.include_usage`（`openai.mjs` 原来就带）。文档没讲续写，也没讲工具参数被截断怎么办。
2. **实测网关（2026-10-22，本机网关 key，共 10 次极小请求）**：
   - `gemini-3.8-flash`：`max_tokens` 65536 → 200；`max_tokens` 1000000 → 200（网关自己压到上游上限，不报错）；`max_completion_tokens` 65536 → 200。回一个「OK」的 `completion_tokens` 是 69～92，就是思考算进了输出。
   - `claude-sonnet-5-5`（走 OpenAI 兼容口）：`max_tokens` 128000、300000 都回 200。
   - `gpt-5`：三次都 429「upstream load is saturated」；`gpt-5.1`：两次都 503。所以「OpenAI 官方对推理模型发 `max_tokens` 会 400」没能在这个网关上实测，做法按 OpenAI 公开文档定，另加了「字段名不对就换字段重发一次」兜底。
   - 结论：这个网关上调大不会让请求失败；直连官方接口时数太大会 400，由降档兜底。
3. **续写到底行不行**：把「没写完的那一段」原样交回模型让它接着往下写，三家都不支持用在工具调用上——历史里的工具调用必须是完整 JSON；Anthropic 的「预填 assistant」在 4.6 以后的型号上直接 400；OpenAI 兼容口没有续写半截 tool_call 参数的写法；Gemini 的工具调用整块到达，截断时连半截都拿不到。所以不走「原样续写」，改成：把写了一半的字段取出来放进代码块，告诉模型写到哪了，让它用 `code_cache_append` 接着写，最后以引用交给原工具。这条路对三家都成立，也不依赖哪家的特殊接口。
4. **为什么用引用而不是让模型再整段重发**：整段重发等于把同样长的内容再写一遍，还会再被截断；引用让最后那次调用只有几十个字。
5. **还没解决的**：
   - Gemini 截断时没有半截工具调用可保（它的工具调用整块到达），这时只能提示模型改用代码块，不能替它保住内容。
   - 模型如果不按提示接着写、每次都从头写一大段，会在 6 次后停下；这是额度保护，不是保证写完。
   - 云端气泡把模型那一路的报错截到 80 字（`events.ts` 的 `REASON_MAX`），截断超限那句话的后半句（「可以把要求拆小一点……」）在云端看不到，本机完整。按任务书只读不改 `events.ts`，见「更正建议」。
   - 经 MCP 接入的命令行 Agent（Claude Code、Codex、agy）用它们自己的输出上限和截断处理，代码块工具和引用写法没有接到 MCP 工具清单（`src/mcp/routes.mjs` 没动）。
   - 同一项目几个对话同时往同一块写不加锁，后写的为准；截断时自动起的块名带序号，不会撞。

## 三、〔裁〕清单

| 编号 | 内容 | 在哪 |
|---|---|---|
| 裁1 | 配置的 `maxTokens` 是上限的上限；没写、0、等于旧缺省 4096 时按模型上限 | `model-limits.mjs`；`mechanism/agent.md` |
| 裁2 | 认不出的模型给 16384；降档档位 128000、100000、65536、64000、32768、32000、16384、8192、4096 | 同上 |
| 裁3 | 400 降档、换字段各至多一次 | provider 三家 |
| 裁4 | 不原样续写，改成存代码块、接着追加、以引用交给原工具 | `truncation.mjs`；`mechanism/agent.md` |
| 裁5 | 有进展的截断一轮最多 6 次；没进展的连续 3 次停 | `harness/agent.mjs` |
| 裁6 | 代码块按项目放；本机、账号模式、旧托管档、兜底四处目录 | `instance.mjs`、`account-runner.mjs`、`create-agent-service.mjs`、`api.mjs` |
| 裁7 | 代码块不是项目内容：不进文档服务、撤销历史、同步 | `product/agent.md` |
| 裁8 | 六个工具的名字、参数与上限（一块 2 MiB、64 块、合计 16 MiB、一次读 60000 字） | `server/tools/code-cache.mjs` |
| 裁9 | 引用只认「整个字符串就是 `@code_cache:<块名>`」 | `code-cache.mjs` 的 `resolveCodeCacheRefs` |

## 四、验证

### 1. 类型检查

`npx tsc -b --force` → EXIT=0，零错误。

### 2. 新增单测与端到端测试（`server/test/output-cache.test.mjs`，假模型，不调真模型）

`npm test -- server/test/output-cache.test.mjs`：18 项全过（结果见下面全量一节的复跑）。覆盖：

- 三家 provider 发出的上限参数（OpenAI 兼容口 `max_tokens` 65536、推理模型只发 `max_completion_tokens` 128000；Anthropic `max_tokens` 128000；Gemini `maxOutputTokens` 65536）。
- 400 降档重发一次、再 400 不再重发；字段名不对换字段重发一次；Anthropic 按报错里的上限降；Gemini 降一档。
- 截断时工具参数片段被保住：OpenAI 兼容口与 Anthropic 都交 `tool_use_partial`（带原文），非截断的坏 JSON 照旧报参数错误。
- 半截 JSON 取字段；截断时存进代码块（新块、直接接进原块、没内容、没有代码块空间四种）。
- 代码块六个工具；`@code_cache:` 引用在调用前被换成内容、历史与事件里留引用、块不存在报错。
- 本机与云端（托管档开放清单）工具清单里都有六个工具。
- 端到端（`startRun` + 模拟 provider 的脚本）：第一轮在 `create_card` 的源码中途被截断 → 存进 `cut_create_card_1` → 第二轮 `code_cache_append` 接着写 → 第三轮 `create_card` 带 `@code_cache:cut_create_card_1` → 交给 `create_card` 的源码与完整源码逐字相同，截断那次没有执行，一轮以 `completed` 收尾，代码块文件在宿主给的目录里。
- 端到端：每次都截断且都留下内容，第 7 次以错误结束，话里写明「已经写出的部分存在代码块 cut_create_card_1…」，`create_card` 一次都没执行；只截断文字、什么也没留下的，连续 3 次以错误结束。

### 3. 相关旧测试

`npm test -- server/test/output-cache.test.mjs server/test/agent-truncated-reply.test.mjs server/test/openai-effort-tools.test.mjs server/test/gemini-provider.test.mjs server/test/api-effort.test.mjs server/test/api-wiring.test.mjs server/test/cloud-agent-service.test.mjs server/test/cloud-agent-runs.test.mjs server/test/cloud-agent-keys.test.mjs server/test/review-loop.test.mjs`：125 项，124 过 1 败。败的是 CA-KEY-01：我先把它对 `set-key.mjs` 写出的 `maxTokens: 4096` 的期望改成了 0，但 `set-key.mjs` 自己就写 4096（不经 `writeModelConfig` 的缺省），改错了，已撤回；撤回后 `cloud-agent-runs.test.mjs` 单独重跑 30 项全过。

### 4. 全量

（全量结果见下一次提交补上。）

### 5. 对照表行号

对照表里每一处「文件:行」都在写表时用 `grep -n` / `sed -n` 对过（`server/runners/api.mjs:428` 原先指到注释，已改成 `:430`）。

## 五、没做到的与原因

- GPT 系推理模型的字段规则没能在本机网关实测（429 / 503），按公开文档定并加了换字段兜底。
- 代码块工具没接到 MCP（桌面 APP、命令行 Agent），它们有自己的输出上限与截断处理；要接的话改 `src/mcp/routes.mjs` 与 MCP 工具清单，另开任务。
- 账号模式删项目时任务进程一侧的 `tenants/<项目 id>` 是否整个清，没核实，也没改删项目流程。
- 云端气泡的 80 字截短没改（任务书要求只读 `events.ts`）。

## 六、对任务书或语义的更正建议

1. `src/ai/cloud/events.ts` 的 `friendlyErrorMessage` 把服务端写好的中文话也截到 80 字，截断超限那句（还有别的长中文话，如「项目太大……」）在云端被截掉后半句。建议中文原话不截，或放宽到 200 字。这是改前端文字的显示，属 AGENT 栏界面那一侧，需要用户同意。
2. `server/ai-config.mjs:81`（本机缺省配置）、`server/agent-service/set-key.mjs:139～140`、`service-keys.mjs:60` 仍在用户没填时写 4096。现在 4096 被当作「没填」，行为上没问题，但建议这三处改成不写或写 0，免得以后有人以为 4096 是特意定的。
3. 任务书说「生产节点的 ai.json 手工设成了 32000」：按新语义它是上限的上限，`gemini-3.8-flash`（65536）会被压到 32000，建议改成 128000（见部署清单）。

## 七、部署清单（主会话去做，本会话不部署、不连节点）

- **变了的 `server/` 文件**：
  - 新增：`server/harness/model-limits.mjs`、`server/harness/partial-json.mjs`、`server/harness/truncation.mjs`、`server/harness/providers/output-fallback.mjs`、`server/tools/code-cache.mjs`
  - 改动：`server/harness/agent.mjs`、`server/harness/loop.mjs`、`server/harness/providers/openai.mjs`、`anthropic.mjs`、`gemini.mjs`、`mock.mjs`、`base.mjs`（只改注释）、`server/harness/tools/index.mjs`、`server/runners/api.mjs`、`server/agent/service/account-runner.mjs`、`instance.mjs`、`create-agent-service.mjs`、`model-config.mjs`、`server/ai-system-prompt.md`
- **生产 `ai.json` 的 `maxTokens`**：改成 `128000`（等于不另加上限，每个模型用自己的上限：`gemini-3.8-flash` 65536、Claude 当前各型号 128000）。写 0 或删掉也行，但 `set-key.mjs` 交互里只收不小于 256 的整数，写 128000 最省事。
- **要不要重启**：
  - Agent 服务要重启：账号模式下任务进程每一代只跑一条任务，新代码对新起的那一代生效，但空闲等任务的那一代已经载好了旧模块；没有正在跑的任务时重启 `promptcut-agent-root.service`（槽重新开代），并重启 `promptcut-agent-master.service`（`model-config.mjs` 在主服务里也被读，虽然 `GET /v1/info` 的行为没变，保持同一提交）。root 入口启动时核代码只有 root 改得了，换文件后保持属主与权限不变。
  - 文档服务不用重启（没改）。渲染服务不用重启（没改）。
  - 部署后要核：节点上 `<共用数据目录>/tenants/` 对任务进程用户可写（代码块目录建在那里，`mkdir -p`，0700）。
