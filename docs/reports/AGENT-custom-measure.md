# AGENT-custom-measure 报告

计划 `docs/plan/agent-workflow-plan.md` 的 A6（「Agent 用 JS 自定义测量」这一段：模型写一段 JS 在沙箱里测音频，只在创造力等级「高」时开放）。

- 分支 `claude/custom-measure`，worktree `.worktrees/custom-measure`，起点 `628b7d42`（`claude/r4-merge`：main 之上已合 A1 创造力等级、A2「用户正在编辑」、查询渲染调度）。
- 代号：A1 = 计划里「创造力等级」那一段（对照表与闸门）；CR-n = `server/test/creativity-gate.test.mjs` 的用例编号；CM-n = 本段新增 `server/test/custom-measure.test.mjs` 的用例编号；M1～M4 = 探针的检查项编号；〔裁〕= 语义没写到、由本会话定下的三级细节。

## 状态

**代码、单测、探针都已写完并提交；需要起 Chrome 的验证在等主会话的「可以跑重活」。** 已跑过的只有轻量项（单个测试文件、不起 Chrome 的用例、代码指纹），见「验证」。

**没有二级语义改动。** 语义文件未改，三级的补充写成 dry run（见文末）。

## 提交表

| 提交 | 内容 |
|---|---|
| `3aee4573` | 文档：建本报告 |
| `39831305` | 功能：`measure_audio_js`（解码 PCM、专用无头 Chrome 沙箱、只回 JSON），对照表登记为「高」，CR-6 加一行、新增 CR-11，放宽超时名单加这一条 |
| `7321d1f6` | 测试：CM-1～CM-14 |
| `22df4968` | 探针：`scripts/probes/custom-measure-probe.mjs` |
| `1a635235` | 功能：沙箱的看门狗与兜底等待不挡进程退出 |

## 做了什么

### 新工具 `measure_audio_js`（`server/tools/audio.mjs`，挨着 `measure_audio`）

- 参数：`code`（必填，async 函数体）、`clipId` / `mediaId` / `scope`（与 `measure_audio` 完全相同）、`start` / `duration`（在那段声音里再截一个窗口，秒）、`sampleRate`（8000～48000，缺省 16000）、`mono`、`timeoutMs`（1000～30000，缺省 10000）。
- `code` 收到 `input = { channels: Float32Array[], sampleRate, duration, frames, numberOfChannels, scope, start, clipId?, mediaId? }`，`return` 可 JSON 序列化的值。
- 结果：成功 `{ ok: true, value, elapsedMs, input: { sampleRate, numberOfChannels, frames, duration, scope, start } }`；代码自己的错回 `{ ok: false, kind, error, input }`，`kind` 是 `syntax | exception | timeout | unserializable | too-large | crashed | hung | busy | too-many-samples | decode | no-media | no-audio | invalid`，`error` 是 Agent 看得懂、能照着改的中文（异常带原报错文字与行号）。
- `side: "agent"`、`timeoutMs: 90000`（桥的缺省 60 秒盖不住「解码 30 秒 + 起 Chrome + 代码 30 秒 + 看门狗余量」；`server/test/tool-schema.test.mjs` 的放宽名单改成四个，并对这一条单独断言大于各段上限之和）。
- 系统提示词 `server/ai-system-prompt.md` 在 `measure_audio` 那条之后追加一行说明（只追加）。

### 调用链

1. 入口 `callToolInternal` 的创造力闸门先判（对照表 `server/agent/creativity-gate.mjs` 加一行 `measure_audio_js: { level: 'high', what: '写自定义测量代码' }`，表头注释里的表格同步），低、中档回 A1 统一格式的越级错误，什么都不执行。
2. 路由表 `src/mcp/routes.mjs` 加一行 → `EditorApi.measureAudioJs`（`src/ai/mcpExecutor.ts` 接口加一行声明）→ `src/mcp/handlers/audio.ts` → `src/mcp/common.ts` 的 `measureAudioJs`。「测谁」与 `measure_audio` 抽成同一个 `audioTargetOf`，`measure_audio` 行为不变（只是改为调用它）。
3. `POST /api/audio/measure-js`（`server/vite-plugin-audio.ts` 挂接，主体在新文件 `server/audio-measure-js.mjs`，不依赖 vite、可直接单测）：找素材文件（与 `measure_audio` 同一个 `mediaFileOf`）→ ffmpeg 解码（`server/audio-pcm.mjs`）→ 沙箱（`server/audio-sandbox.mjs`）→ 只回 JSON。
4. 时间轴档的混音图与测响度共用：`server/audio-measure.mjs` 抽出 `timelineMixParts`，`timelineMeasureArgs` 改为用它拼（输出逐字相同，`audio-measure.test.mjs` 4/4 通过；CM-3 断言两边的图除末尾一步外相同）。

### 沙箱（`server/audio-sandbox.mjs`）

- **专用的 chrome-headless-shell**（与预渲染同一份 puppeteer 浏览器，找不到时退到完整 Chrome 的新无头模式），按需启动，空闲 60 秒自己关掉；每次测量开一个新的无痕浏览器上下文和一页，跑完即关。
- 页面地址是不存在的 `http://sandbox.promptcut.invalid/`，内容由 puppeteer 拦截请求就地给；PCM 按 4 MB 一块、一次性的地址交给页面（每块只给一次）。
- 页面（可信）开 Worker，把代码与 PCM（转移，不拷贝）交进去；Worker 里用 `AsyncFunction` 编译代码、调用、`JSON.stringify`、量字节数；页面到点 `worker.terminate()`（死循环也掐得断，事件循环在 Node 这边不受影响）；Node 另有看门狗，页面本身没反应就杀掉整个 Chrome、下次重开。页面崩溃（内存炸弹把渲染进程拖垮）回 `crashed` 并重开 Chrome。
- **不能联网，四道各自独立**：内容安全策略 `connect-src` 只放行 PCM 地址、`script-src` 不放行任何外部地址（Worker 从 blob 起，继承页面策略）；请求拦截除页面与 PCM 块外一律 abort；这个 Chrome 的启动参数 `--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>`（所有流量连本机回环都走一个没人听的代理，只影响这个 Chrome，不动宿主机网络设置）；Worker 里 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`importScripts`、`Worker` 等沿原型链换成抛「沙箱里不能联网」的函数，`postMessage` 换成抛错（只能 `return`，不能伪造结果）。
- 没有 Node 能力：代码只在 Chrome 的 Worker 里执行，Node 从不 eval 它（CM-13 断言 `process`、`require`、`Buffer`、`module`、`window`、`document` 都是 `undefined`）。
- 排队：同一时间只跑一个，含正在跑的最多排 4 个，再多回 `busy`。

### 在线构建

`measureAudioJs` 挂在 `editorApi` 上，在线构建里整张 `editorApi` 连同各 handler 背后的 `/api` 调用一起被剪掉（`src/mcp/api.ts` 的纯调用标注，M8 遗留 L24 的做法），新路径 `/api/audio/measure-js` 不会进 `dist-online`；`c10a-online-api-paths.json` 与 `c10-api-ratchet-baseline.json` 都不需要改。**待验证**：`c10a-online-build.test.mjs` 要跑 `vite build --mode online`，属于重活，等许可后跑。

## 〔裁〕清单（三级，语义没写到、本会话定下）

1. **另起专用无头 Chrome，不用预渲染的 Chrome**。计划写「在预渲染 Chrome 的隔离页面里跑」。理由：内存上限 `--js-flags=--max-old-space-size` 是整个浏览器进程的启动参数，给预渲染设低会伤渲染、设高又限不住模型写的内存炸弹；预渲染的 Chrome 为逐帧确定性调过整套参数、有常驻备用页，内存炸弹拖垮渲染进程时会把正在预渲染的页面一起带走。专用的 Chrome 只为这件事调参，崩了只丢这一次测量，下次按需重开，空闲自己关。代价是第一次调用多一次冷启动（约 1～3 秒，待实测）。
2. **数字**（`PCM_LIMITS`、`SANDBOX_LIMITS`）：缺省采样率 16 kHz、可调 8～48 kHz；声道最多 2（多声道源混成立体声，`mono` 混成单声道）；所有声道合计最多 1200 万个样本（48 MB，16 kHz 立体声约 6 分钟），能事先算出时长的先判、否则边解码边数，超了回「这个采样率与声道数下最多几秒、怎么缩」；解码时限 30 秒；代码时限缺省 10 秒、最长 30 秒；代码最长 2 万字符；结果 JSON 最多 256 KB；V8 老生代上限 256 MB；看门狗在时限之外再等 5 秒；空闲 60 秒关 Chrome；排队最多 4 个；PCM 每块 4 MB；工具的桥超时 90 秒。
3. **代码的形态**：一个 async 函数体（可以 `await`），参数叫 `input`，用 `return` 返回；`NaN` / `Infinity` 按 JSON 规矩变 `null`，不算错；`undefined`、函数、`BigInt`、循环引用算「不能序列化」。
4. **代码自己的错不当成工具故障**：语法错、抛错、超时、结果太大等回 `ok: false` 的结果（带 `kind` 与报错文字），不抛成工具异常，Agent 据此改代码重试。
5. **工具名与形状**：`measure_audio_js`，「测谁」与 `measure_audio` 完全相同，另加 `start` / `duration` 窗口；片段档测的是那一段用到的素材原声（不含片段音量、淡入淡出、效果），时间轴档含片段音量与淡入淡出、不含音频效果（与 `measure_audio` 一致，挂着效果时标 note）。
6. **崩溃与没回话一律重开整个沙箱 Chrome**，只丢这一次测量。

## 与语义的出入（按任务书要求写明）

- `product/agent.md`「素材与产物」：Agent 经素材服务的接口读素材，绝不直接读素材服务的存储目录。现状：`measure_audio` 的 `/api/audio/measure`（`server/vite-plugin-audio.ts`）在编辑器进程里按 `mediaFileOf` 直接到素材目录（`mediaDir`，即 `out/media` 或 `PROMPTCUT_EXPORT_DIR/media`）找文件交给 ffmpeg，不经素材服务的接口。Agent 的工具实现本身只打 `/api`，没有碰目录；但接住请求的是音频插件而不是素材服务。`measure_audio_js` 按任务书照样跟它走（同一个 `mediaFileOf`），出入与 `measure_audio` 相同。改成「经素材服务的接口取字节再交 ffmpeg」应当两条一起改，不在本段范围。

## 验证

### 已跑（轻量，重活禁令之内）

| 命令 | 结果 |
|---|---|
| `node --test server/test/creativity-gate.test.mjs` | 12 通过 0 失败（含新增 CR-11、CR-6 新行：低 / 中拒、高放行） |
| `node --test server/test/tool-schema.test.mjs` | 21 通过 0 失败 |
| `node --test server/test/mcp-routes.test.mjs` | 8 通过 0 失败 |
| `node --test server/test/audio-measure.test.mjs` | 4 通过 0 失败（`timelineMixParts` 抽出后输出不变） |
| `node --test --test-name-pattern="^CM-(1\|2\|3\|4\|5\|14) " server/test/custom-measure.test.mjs` | 6 通过 0 失败（不起 Chrome 的那几条） |
| `agent-c65*.test.mjs`、`codex-mcp-permissions`、`report-progress`、`user-editing`、`wait-tool`、`src/editor/right/audioFxTools.test.mjs`、`no-user-dirs`、`port-file`、`bakery-deps` | 全部 0 失败 |
| 代码指纹 `snapshotCode` / `captureCode` | `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，与任务书给的相同 |

### 等许可后跑

- `npx tsc -b --force`、`npm test`（含 CM-6～CM-13：起真 ffmpeg 与沙箱 Chrome）、`c10a-online-build.test.mjs`（在线构建）、探针 `node scripts/probes/custom-measure-probe.mjs --port 5860`。

## 没做成的及原因

- 起 Chrome 的单测、类型检查、全量测试、在线构建、探针：受重活禁令，等主会话许可。

## 对计划或语义的更正建议（dry run，未写入语义文件）

### `docs/semantics/mechanism/agent.md`「创造力等级的判定」第一条末句

修改前：

> 以后的自定义测量代码要「高」。

修改后：

> 自定义测量代码（`measure_audio_js`）要「高」。

### `docs/semantics/mechanism/agent.md` 新增一节「自定义测量」（放在「创造力等级的判定」之后）

修改前：（无）

修改后：

> ## 自定义测量
>
> - Agent 写的测量代码只在一个专用的无头 Chrome 里跑：每次一个新的无痕上下文，代码在 Worker 里执行，到点终止；不给 Node 能力，不能联网（内容安全策略、请求拦截、指向无人监听端口的代理、Worker 里换掉联网接口，四道各自独立）。不用预渲染的 Chrome：内存上限是整个浏览器的启动参数，模型写的内存炸弹不能带走正在预渲染的页面。
> - 测谁与内置的响度测量相同（片段用到的素材原声、整个素材、时间轴混音），服务端把那段声音解成 32 位浮点 PCM 交给代码，代码返回可 JSON 序列化的汇总。
> - 数字：缺省 16 kHz（8～48 kHz）、最多 2 声道、所有声道合计最多 1200 万个样本；代码缺省 10 秒、最长 30 秒；结果最多 256 KB；V8 老生代 256 MB；空闲 60 秒关掉 Chrome。
> - 代码自己的错（语法、抛错、超时、结果不能序列化或太大、内存超限）回给 Agent 改代码重试，不当成工具故障；沙箱崩溃或没回话就整个重开，只丢这一次。〔裁：2026-09-30 `claude/custom-measure`，出处 `docs/plan/agent-workflow-plan.md` A6〕

### `docs/plan/agent-workflow-plan.md`

- 第 2 节 A6 行与第 5 节最后一条「在预渲染 Chrome 的隔离页面里跑」建议改为「在专用的无头 Chrome 的隔离页面里跑（不与预渲染共用浏览器）」，理由见〔裁〕1。

## 需要主会话决定的事

1. 发「可以跑重活」后本会话补跑类型检查、全量测试、在线构建与探针，并更新本报告。
2. 〔裁〕1（专用 Chrome 而不是预渲染的 Chrome）是否接受。
3. 越出任务书文件清单的小改动：`src/ai/mcpExecutor.ts`（A3 的目录）加了一行 `EditorApi.measureAudioJs` 声明——`side: "agent"` 的工具必须在 `EditorApi` 上有方法（`mcp-routes.test.mjs` 读这份接口对账），没有别的挂法；`src/mcp/common.ts`、`src/mcp/handlers/audio.ts`、`server/audio-measure.mjs`、`server/vite-plugin-audio.ts`、`server/test/tool-schema.test.mjs` 也有改动。合并时与 A3 若在 `mcpExecutor.ts` 同一处冲突，保留两边即可。
4. 「素材与产物」的出入（见上）是否另开任务，把两条测量改成经素材服务的接口取字节。
