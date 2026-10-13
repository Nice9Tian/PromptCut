# AGENT-v18-tools-p5：0.7.18 云端 Agent 工具包 P5「后台作业状态与一键流程」

分支 `claude/v18-tools-p5`（从 main `a11c9a15` 分出），工作区 `.worktrees/v18-tools-p5`，端口段 28770～28809（这个包没起任何服务端口）。不推送、不合并。

本文里的代号：

- **P5**：`docs/plan/cloud-agent-tools-implementation.md` 拆包表里的一个包，管 `background_job_status`、`auto_workflow`、`auto_workflow_status` 三个工具在 Agent 服务一侧的实现。
- **P1 / P2 / P4**：同一张表里已合入的三个感知包（镜头识别、语音转写、主体识别），P3 是运动追踪。P5 把它们的提供方串成一键流程，不重写它们的逻辑。
- **F0**：表里先行的公共地基（`tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`、`run-resources.mjs`），已在 main，这个包只调用不修改。
- **G 包**：表里最后一个包，唯一能改工具总表（`cloud-tools.mjs`）和实例入口的人。
- **一键流程**：`auto_workflow`，桌面版叫「一键配特效」。
- **提供方（provider）**：每个工具包导出的 `{ handles, call(name, args, context, options), close() }`。
- **替身**：测试里的项目一侧（文档服务那一段，G 包才接真的）。
- **〔裁〕**：文档没写到、我自己定的地方，等主会话和用户审。

## 做了什么

只做表里 P5 一行，没碰别的包的文件，也没碰渲染那一带和那十个不许改的文件，`src/` 一个字没动。

| 文件 | 内容 |
|---|---|
| `server/agent/service/hosted-workflow.mjs`（新） | 三个工具的云端实现：`createWorkflowTools(...)` 返回 `{ handles, call(name,args,context,{requestId}), cancel, close }`；`planAutoWorkflowEdits`（配卡规则，桌面版的搬运）；`WORKFLOW_ERROR_TEXT`、`WORKFLOW_STAGES` 等常量 |
| `server/test/cloud-tools-p5-workflow.test.mjs`（新） | 36 条单测（假的感知提供方，可控） |
| `server/test/cloud-tools-p5-real.test.mjs`（新） | 4 条真链路测试（真转写、真 scdet、真 light 主体识别） |
| `server/test/cloud-tools-p5-fixture.mjs`、`cloud-tools-p5-real-lib.mjs`（新） | 测试底座（单测与探针共用）；造真短片、造真提供方 |
| `scripts/probes/cloud-tools-p5-workflow-probe.mjs`（新） | 把上面两个测试文件按「不接受跳过」的方式跑一遍，前后各数一次可见窗口和残留进程，日志写进 `docs/reports/assets/v18-tools-p5/probe.log` |

`cloud-tools.mjs`（总表）、`hosted-tools.mjs`、`instance.mjs`、`server/agent-service/` 下的文件、`tool-jobs.mjs` 一个字没动。

### 实现的样子

- **上下文只来自 F0**：每次调用带可信八字段，先过 `resources.authorize`：`background_job_status`、`auto_workflow_status` 要读，`auto_workflow`（改项目）与 `cancel` 要写。参数里的 `projectId`、路径之类一律不收（多余参数直接拒）。文档服务联系不上回 503，没权限回 403，不起任何作业。
- **作业状态（`background_job_status`）**：查 F0 的账本，种类有 `stt.transcribe`、`stt.install`、`shots.detect`、`subject.detect`、`subject.install`、`track.points`、`track.install`、`workflow.auto`。只查本项目本对话的；别的项目的、别的对话的、不存在的、格式不对的作业号回**同一句**「找不到该作业」（单测断言 7 种输入只有一种回答）。返回里 `done` / `ok` / `error` 与桌面版同义（`ok` 是作业成功），另有 `kind`、`label`、`state`、`stage`、`progress`、`outputRefs`。失败原因：宿主注入的表 → 转写的 `STT_ERROR_TEXT` → 镜头、主体写在工作区索引里的 `message` → 通用说法。
- **重启后的「被中断」**：F0 账本打开时只把 `running` 改成 `interrupted`，`queued` 的会一直排着。所以我另外加了一条：非终态、比这个提供方起来得早、又不是本进程在跑的作业，一律按「被中断」说（见「对 F0 的建议」）。
- **一键流程（`auto_workflow`）分五个阶段**：语音转写 → 镜头识别 → 主体识别 → 生成字幕与卡片 → 发布预渲染任务。
  - 前三个阶段先看项目里有没有现成结果（有文字稿、镜头、主体就标「复用」）、是不是不适用（音频没有画面：镜头、主体标「跳过」并写原因），否则**调用对应工具包的提供方**（工厂参数 `providers.stt / shots / subject`，只传 `mediaId`，请求号由本作业号派生），然后在账本里等它的作业走完（轮询，进度映射到本流程的进度条）。作业走完后还要核对项目里确实有结果，没有就不算完成。
  - 「生成字幕与卡片」：读文字稿和时间轴，用桌面版 `autoWorkflow.ts` 的配卡规则（按 5～15 秒分组、关键词选九种卡之一、最多 `maxCards` 张、整条文字稿一张 caption-track）算出方案，**一次**经宿主给的 `project.applyEdits` 提交，带期望的项目版本。整份要么全进要么全不进。版本对不上（别人改了项目）就重读、重算、再提交，最多三次，仍不行就停，项目里没有半截提交。
  - 「发布预渲染任务」：云端没有页面，这一步由宿主经 `prerender.publish` 接缝交给 Agent 服务的预渲染发布（`render-request.mjs`）。渲染那一带的文件我一个没碰。
  - **失败不越过**：任何一个阶段失败、被取消、被中断就停在那里，后面的阶段不做（状态是 `pending`，不是 `done`），错误里点明停在哪一阶段、后面哪些没做。依赖的感知能力没就绪（提供方没配，或回 `cloudUnavailable`）：这一阶段标「用不了」并带原因，同样停在那里，**不起占位作业**（单测与真链路都断言账本里没有那种作业）。宿主可以用 `optionalStages` 指定哪些阶段允许没就绪时跳过，缺省只有「发布预渲染任务」。
  - **阶段状态持久**：账本记整体的状态、当前阶段、进度、已完成阶段的产物引用；各阶段的状态、子作业号、原因、方案摘要记在对话工作区 `workflow/jobs.json`（先写临时文件再改名）。重启后 `auto_workflow_status` 说得清做到哪一阶段、哪一阶段被中断。索引丢了也还有账本的整体状态与当前阶段。
  - **控制路径**：一键流程登记成这一轮的一个流资源（`run-resources`）。这一轮被停、转私有、Agent 关闭时宿主调 `resources.abortForFence`，我这边收到中止信号：正在等的阶段停下、不再往下一个阶段走、不再提交；每次提交与发布前也重核写权限。底下的子进程由各包自己的登记杀。`cancel(context, jobId)` 是给宿主和单测的显式取消（会请正在等的子作业的提供方取消），`close(reason)` 让在跑的流程停下并把账本记成「被中断」。
  - **返回形状与桌面版一致**：等 50 秒（桌面版同一个数，单次工具调用的 60 秒上限留 10 秒余量），跑完直接回 `{mediaId, style, transcribed, segments, groups, captionClipId, clips, skipped, jobId, running:false}`，没跑完回 `{jobId, running:true, started:true, mediaId, phase, hint}`；`auto_workflow_status` 回 `{jobId, done, ok, phase, elapsedMs, error, result}`，外加 `state`、`stage`、`progress`、`stages`（每个阶段的状态与原因）。`server/harness/tools/index.mjs` 的自动轮询（`running === true` 时轮询 `auto_workflow_status`，`done` 且 `ok === false` 抛 `error`）不用改。
- **不调用 `spawn_agent`**：`handles` 只有那三个工具，调用别的工具名回 `unknown-tool`。

## 验证结果

机器：Windows 11，Node 24.19，ffmpeg 9.0.1；转写用 P2 备好的内置 Python 加 faster-whisper small（`cloud-tools-p2-stt-probe.mjs --setup` 复制到本工作区 `out/p2-stt/`，不入库）；主体识别用 anaconda 的 `cuda_Vit` 环境（onnxruntime）加主工作区 `out/models` 里的 light 权重。耗时只记录。

### 基线

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test`（带两个环境变量，代码定下之后跑了三遍） | 前两遍 1，最后一遍 0 | 每遍 6353 条。最后一遍：**6341 过、0 失败、4 跳过（原有）、8 待办（原有），退出码 0**，耗时约 2.5 分钟。前两遍各有 1 条别的文件的失败，都不是本包：`account-worker-lifecycle`「交错二」（actual 3 expected 2，不在偶发名单里；单独重跑两次 8/8 过）、`artifact-push` 的 W4（在偶发名单里；单独重跑 7/7 过）。本包 40 条（36 + 4）三遍都全过 |
| `npm test -- server/test/windows-hide-silent-spawn.test.mjs server/test/accept-018-rest-ssr-seam.test.mjs` | 0 | 9 条：7 过、2 待办（原有）、0 失败；SEAM-3 棘轮过：`hosted-workflow.mjs` 只 import 同目录的 `stt.mjs`，不引用 `src/`；测试底座取内核函数的写法与 P1、P4 相同（测试文件不在棘轮范围内） |
| `node scripts/probes/cloud-tools-p5-workflow-probe.mjs` | 0 | 40 条（36 + 4）全过、0 跳过；开始前与结束后可见窗口都是 1（本来就有的）、残留的转写/镜头/主体进程都是 0。日志：`docs/reports/assets/v18-tools-p5/probe.log` |

### 验收逐条（对上 `AGENT-018-prep.md` 第 2 节的「隔离验收」「基线」两项，以及派活指令的验收段）

底座说明：运行授权（SQLite 里的 doc 一侧运行权限，真的 admit / confirmRead / 私有栅栏）、`run-resources`、`tool-jobs`（SQLite）、`project-assets` 加项目素材物理库（真字节、哈希）、工作区都是**真的**；三个感知提供方在单测里是「假」的（按真提供方的回执形状和账本约定写，可由测试控制何时完成、失败、卡住），在真链路里是真的 stt / shots / subject。**没有**的是：Agent→素材服务→文档服务那一段 TLS 线路，以及项目一侧（文档服务）：用内存替身，接缝见下节。

| 验收项 | 结果 | 出处 |
|---|---|---|
| 真短片整条走通 | **过**。短片：Windows 自带的中文合成语音念「去年我们的用户增长了三百倍…所谓留存率，指的是…第一步…第二步…」，画面三个硬切的场景（测试图案 / 公有领域人像照片 / 彩条），20.02 秒，切点 6.68、13.36 秒。真转写出文字稿「去年我们的用户增长了三百倍,这是一个了不起的结果。所谓流存率,指的是用户回来的比例。第一步,打开软件…」；真 scdet 切出 3 个镜头 `[0,6.68] [6.68,13.36] [13.36,20.02]`，与已知切点误差 0；真 light 档主体识别 9 个采样、标签 `face, person`；项目里多了 3 张卡（odometer 0～6 秒 / term-card 6～11 秒 / step-timeline 11～20 秒）加 1 张字幕（3 行），一次提交，提交次序 `transcript → shots → subjects → edits`；预渲染接缝收到的片段号与项目里新增的 4 个片段一致；`auto_workflow_status` 五个阶段都是 `done`；`background_job_status` 对三个真作业逐个查得到 `done / ok / progress=1` | 真链路测试第 1 条；探针日志 `[p5] final / transcript / shots / subject labels / cards` 行 |
| 中途失败：依赖没就绪 | **过**。主体识别换成没装 onnxruntime 的 Python：转写、镜头都做完（`done`），主体识别标 `unavailable`，错误是「一键流程在『主体识别』阶段失败了：…两档都用不了…没有兜底档…后面的阶段(生成字幕与卡片、发布预渲染任务)没有做」；账本里没有 `subject.detect` 作业（没起占位）；项目里 0 张卡、0 次提交、预渲染 0 次发布 | 真链路测试第 2 条 |
| 中途失败：作业失败 / 感知包拒绝 / 提交失败 / 版本一直对不上 | **过**。镜头作业失败（带包自己写的原因）：停在镜头阶段、主体与后面都不做、项目无半截提交；转写失败码 `MODEL_NOT_INSTALLED` 用转写表里的话；感知包抛 `shots-busy` 用它自己的话；提交失败 → `COMMIT_FAILED` 项目 0 张卡；版本三次都被抢先 → `PROJECT_CHANGED` 项目 0 张卡；提交前别人改过一次 → 重读重算后提交成功（提交调用 2 次、项目 4 张）；阶段等太久 → `STAGE_TIMEOUT`，子作业被请求停 | 单测 |
| 取消 | **过**。显式取消：阶段停、不再往下、项目 0 次提交、子作业被请求停（账本 `cancelled`），之后重新发起可接着做（转写不重做）。宿主路径（私有栅栏 → `abortForFence` → `cancelForFence`）：假链路上流资源释放、下一阶段不开、不提交、账本 `cancelled`，权限收回后再问状态 403；真链路上转写进行中被停：Python 进程在几百毫秒内真的退光（按测试目录数残留进程为 0）、账本 `workflow.auto` 与 `stt.transcribe` 都是 `cancelled`、镜头与主体作业一个都没起、项目 0 次提交。只收回授权、宿主没杀任何东西：下一次账本检查发现，流程安静地停 | 单测、真链路测试第 3 条 |
| 重启 / 关闭 | **过**。`close()` 在阶段进行中：回执 `childrenClosed/streamsClosed true, workPending 0`、账本 `interrupted`；重开后 `auto_workflow_status` 回「被中断」、当前阶段、每个阶段的状态（`transcribe: done, shots: interrupted, 其余 pending`），错误里写「在『镜头识别』阶段被中断了…重新调用可以接着做」；重新发起：转写不重做（文字稿复用）。真链路：转写进行中关服务，Python 进程退净，重开后 `interrupted`、`stage=transcribe`，再发起一次整条走通；进程死掉没来得及 close 的现场（造一个上个进程留下的 `running`）：重开账本后是 `interrupted`，索引里的阶段状态说得出做到 `subjects` | 单测、真链路测试第 4 条 |
| 只读成员 | **过**。能查两个状态工具；`auto_workflow` 与 `cancel` 回 403，没起任何作业 | 单测 |
| 伪造上下文 | **过**。改 runId、改 projectId、改发送者、缺字段、多字段、`null`、字符串、`undefined`：三个工具全回 403，账本 0 条作业，感知提供方 0 次调用 | 单测 |
| 别的项目、别的对话的作业号 | **过**。另一个项目的、同项目另一个对话的、编造的、格式不对的、空的、数字、`null` 的作业号：两个状态工具都回同一句「找不到该作业」；用 `auto_workflow_status` 查别种作业（转写）也是同一句；别的项目的素材 id 回「找不到该素材」，与不存在的素材同一句 | 单测 |
| 401/403/503 | **过**。权限被拒回 403；文档服务联系不上回 503 `authority-unavailable`，不起作业，恢复后可用 | 单测 |
| 不调用 spawn | **过**。`handles` 里没有；调用 `spawn_agent` 回 `unknown-tool` | 单测 |
| 配卡规则与桌面版一致 | **过**。手算的一份文字稿：分组、选卡、参数、字幕行逐项断言；再加一条「漂移守门」：从 `src/mcp/tools/autoWorkflow.ts` 里抽出分组、选卡、填参数那一段的全部正则字面量，与本文件按顺序逐个比，再比数字阈值（15 秒、5 秒、0.6 秒、18 秒）；桌面版改了规则这条会红 | 单测前 4 条 |
| 服务进程、子进程实际关闭与无残留 | **过**。探针前后各数一次（0 / 0）；真链路各条结束时按测试目录数的残留进程为 0 | 探针、真链路测试 |

## 没做成的与原因

1. **Agent→素材服务→文档服务的真 mTLS 全链**：底座用 F0 同款受控线路适配器，字节、哈希都是真的，没有 TLS。要在 G 包的中央组合里再跑一遍。
2. **项目一侧的真文档服务**：`project.getTimeline` / `applyEdits` / `getMedia`、`prerender.publish` 是我定的窄接口，测试里是内存替身；`applyEdits` 的「整份全进或全不进」「版本预期」「`commitKey` 去重」、`prerender.publish` 接到 `render-request.mjs`，都没有对着真东西验过，G 包接线时要验（见下节）。
3. **Linux 没验**：本机 Windows。本文件自己不起任何子进程；子进程都是各感知包起的，它们各自的 Linux 状况见 P1、P2、P4 报告。
4. **镜头识别只验了 scdet 一档**：派活指令要求的就是 scdet；节点上配了 TransNetV2 时一键流程调用的是同一个 `detect_shots`，提供方自己选档，P1 已验。
5. **`background_job_status` 不认素材收集的作业**：桌面版里 `collect_install` 的作业号也能用它查，云端的 `hosted-collect.mjs` 有自己的作业表和 `collect_job` 工具，不在 F0 账本里。我没改它。要不要让 `background_job_status` 也认，G 包或收集包的 owner 定。
6. **全量测试里别的文件的偶发失败**：见上表，前两遍各 1 条，都不是本包，单独重跑都过，第三遍全绿。本包加了约 1 分钟的真链路测试，机器忙时可能让别的时间敏感用例更容易红；如果主会话觉得值得，可以把 `cloud-tools-p5-real.test.mjs` 挪到只在探针里跑（探针本来就会跑它）。

## 我做的裁定（〔裁〕，三级，都不改用户操作的界面）

- 〔裁〕1 **阶段按计划表写五段，比桌面版多三段**：桌面版 `autoWorkflow.ts` 只做「转写 → 配卡 → 铺字幕 → 撑时长」，没有镜头识别、主体识别、发布预渲染（桌面的预渲染由页面在改动后自己发）。拆包表和 `three-versions-018-design.md` 第 245 行写的是 STT→shots→subject→卡片→字幕→预渲染任务，派活指令也这样要求，所以云端按五段做；配卡本身（第 4 段）与桌面版逐条相同。
- 〔裁〕2 **缺省下，镜头、主体识别也是必需阶段**：按验收原文「某一阶段的依赖没就绪：停在那一阶段、后面的不做」。后果见「要用户定的事」。`optionalStages` 可由宿主放宽。
- 〔裁〕3 **「重新发起可以接着或重来」定为：开一个新作业，复用项目里已经有的结果**。桌面版重启后作业表就没了，重新调用就是从头来，但文字稿已经在项目里所以转写会跳过。云端同理，被中断的旧作业不会自己续（它是终态），新作业对已有文字稿、镜头、主体直接标「复用」。
- 〔裁〕4 **发布预渲染任务没有接缝，或接缝说没有渲染节点：这一阶段标「用不了」，不算失败**，整个作业 `done`、`ok:true`、`complete:false`、`notDone:['发布预渲染任务']`。理由：字幕与卡片已经真的写进了项目，后面云端 Agent 服务的预渲染发布（`render-request.mjs`，写入落地后攒 3 秒）本来就会发；这一阶段是在流程里显式再确认一次。接缝抛错：作业 `error`，但带 `committed:true`，错误里写「字幕和卡片已经写进项目，但发布预渲染任务没有成功」。
- 〔裁〕5 **失败时 `auto_workflow` 回对象 `{ok:false, jobId, running:false, done:true, error, stages}`，不抛错**（桌面版是抛错）。理由：要把「停在哪一阶段、哪些阶段做完了」一并交给模型；harness 只对 `running === true` 自动等，`ok:false` 的结果原样交给模型，模型读得到 `error`。
- 〔裁〕6 **同一素材的字幕与卡片用 `commitKey`（素材 + 文字稿 + maxCards 的哈希）去重**：第二次对同一份文字稿跑一键流程，宿主发现这些片段还在项目里就回 `alreadyApplied`，不重复放，阶段标「复用」。桌面版重复调用会重复放卡。如果宿主不实现去重，行为就退回桌面版（重复放）。这是接缝契约里的一个可选行为，用户可见的差别是「重复点一键配特效不会叠出两份字幕」，所以也请用户过目。
- 〔裁〕7 **只有一个流程同时跑同一条素材**，进程内最多 2 个并发（桌面版不限）；同一对话重复调用回 `alreadyRunning`，别的对话回 `workflow-busy`。数字在 `WORKFLOW_DEFAULTS`。
- 〔裁〕8 **一个阶段最长等 45 分钟**（`stageWaitMs`，防卡死的兜底；各感知包自己有时限，转写 30 分钟），超时记 `STAGE_TIMEOUT` 并请对应提供方取消那个子作业。桌面版是「转写超过 10 分钟」就报错，云端不照搬：云端转写自己的时限是 30 分钟。
- 〔裁〕9 **`background_job_status` 的范围比桌面版大**：桌面版只认转写与几种安装的作业号；云端认账本里所有种类（镜头、主体、追踪、一键流程也认）。查一键流程的作业号时会附上各阶段状态。

## G 包接线时要填什么

1. **工具表（`cloud-tools.mjs`）**：`background_job_status`、`auto_workflow`、`auto_workflow_status` 三项现在是 `{mode: P, why: …}`，改成由本包的提供方执行（`handles` 就是这三个名字）。`auto_workflow` 最多等 50 秒，在 60 秒的单次调用上限内，不必进 `CLOUD_SLOW_TOOLS`。云端「一键配特效」按钮在契约里是置灰的（K6），三个工具接上之后要不要放开，G 包与界面 owner 定。
2. **工厂**：
   ```
   createWorkflowTools({
     resources,   // createRunResources(...)，与 tool-jobs、project-assets 同一个
     jobs,        // createToolJobs(...)
     workspace: (context) => workspaces.open({ projectId, ownerKey, conversationId }),   // 与三个感知包同一个
     providers: { stt, shots, subject },    // createSttTools / createShotsTools / createSubjectTools 的返回值；节点没接的给 null
     project: { getMedia, getTimeline, applyEdits },
     prerender: { publish },                // 可选；没给这一阶段标「用不了」
     kernel: { getCard },                   // 必需，没有就在构造时抛
     errorTexts: { 'track.': … },           // 可选，见第 6 条
     limits: {},                            // 覆盖 WORKFLOW_DEFAULTS，optionalStages 在这里
   })
   ```
3. **`project` 接口**（G 接到文档服务）：
   - `getMedia(context, mediaId)`：与三个感知包用的是**同一个**，只实现一次；这里还要用到 `kind`、`transcript`、`shots`、`subjects`、`pending`。
   - `getTimeline(context)` → `{ projectRev, tracks: [{ clips: [{ mediaId, start, end, mediaOffset }] }] }`。
   - `applyEdits(context, { jobId, mediaId, commitKey, expectedProjectRev, fenceRevision, cards: [{cardId,start,duration,params,text}], caption: {start,duration,params} | null })` → `{ projectRev, clips: Array<{clipId,start,end} | null>（与 cards 同序，放不下的是 null）, captionClipId, alreadyApplied? }`。在文档服务的一次 mutate 里做完（建字幕轨、放卡、放 caption-track、把项目时长撑到最晚的片段结尾，与桌面版 `actions.addCardClip` / `ensureCaptionTrack` / `setProjectMeta` 同一套），整份全进或全不进；版本对不上抛 `{code:'project-changed'}`；`fenceRevision` 是本包刚核过的，**宿主提交时要与 run authority 当前的 fence 对账**；同一 `commitKey` 的片段还在就回 `alreadyApplied`。
4. **`prerender.publish(context, { jobId, mediaId, projectRev, clipIds, fenceRevision })`** → `{ published: boolean, reason?, planned? }`：接到 `createRenderRequests(...).noteWrite(ref, { clipIds, rev, project, runId, userCards })`（`render-request.mjs`），`published:false` 带人话原因（例如这个项目现在没有可用的渲染节点）。
5. **`kernel.getCard`**：用 `registry.getCard`。`ssr-host.mjs` 的 `loadSsrHost` 已经载入了 `/src/kernel/registry.ts`（变量 `registry`），把 `getCard` 暴露出来即可；`ssr-host.mjs` 归 G。
6. **`errorTexts`**：追踪的中文失败原因在 `track.mjs` 里没导出（`JOB_ERROR_MESSAGE` 是模块内常量），所以 `background_job_status` 对 `track.*` 作业的失败缺省只能说「作业没有成功(码)」。请 P3 的 owner 或 G 把它导出，接线时传 `errorTexts: { 'track.': JOB_ERROR_MESSAGE }`。镜头、主体不用注入（它们的话写在工作区索引里，我直接读），转写用的是 `STT_ERROR_TEXT`。
7. **调用约定**：`provider.call(name, args, context, { requestId })`，`requestId` 用宿主的工具调用号（8～128 个 `[A-Za-z0-9_-]`），同一个请求号重试不会开第二个流程；`context` 必须是 F0 发的。
8. **控制路径与关闭顺序**：这一轮停止 / 转私有 / Agent 关闭时宿主照旧调 `resources.abortForFence`（它会释放本包登记的流资源、杀各感知包登记的子进程树）与 `jobs.cancelForFence`。服务关闭时**先关本提供方（`close()`），再关三个感知包**，最后关 `assets / resources / jobs`：这样不会有流程在感知包关了之后还想往下走；`close()` 的回执并进实例关闭的 ACK。
9. **工具说明与系统提示词**：`server/tools/core.mjs` 里 `auto_workflow` 的说明写的是桌面版的流程（转写 → 配卡 → 字幕）；云端还会做镜头识别、主体识别、发布预渲染，`background_job_status` 的说明也只提转写与安装。需要在云端的工具说明或系统提示词里补一句，别让模型以为失败了是转写的问题。这是模型看的文字，不是界面上给用户看的字。
10. **节点依赖**：本包自己没有；一键流程需要的是 P2（转写：Python + faster-whisper + 权重 + ffmpeg）、P1（ffmpeg，可选 TransNetV2）、P4（onnxruntime + light 权重）都在节点上就绪，缺哪个，对应阶段就如实报「用不了」。

## 对 F0、任务书或语义的更正建议

- **F0 `tool-jobs.mjs`**：打开账本时只把 `running` 改成 `interrupted`，`queued` 的作业会一直排着（没有任何东西会去做它）。P5 在读取一侧补了（按「比提供方起得早又不是本进程在跑」判），但根治要 F0 的 owner 在打开时一并把 `queued` 也标成 `interrupted`。
- **F0 `tool-jobs.mjs`** 仍然没有「按入参找作业」与放文字原因的字段（P1、P2、P4 报告都提过）：我读的是各包的工作区索引。建议补 `message` 字段后，`background_job_status` 的人话就不用靠各包各写一份索引了。
- **拆包表 P5 一行**：写的是 STT→shots→subject→卡片/字幕→预渲染任务，与桌面版实际流程（只有转写和配卡）不同，见〔裁〕1。建议在表里注明「配卡规则与桌面版逐条相同，前后多出的阶段是云端的」。
- **`cloud-agent-tool-coverage.md`** 里这三行「还差」栏，在 G 包接线并验过之后才能改；现在的状态是「本包实现与测试完成，未挂载」。
- 语义文档（`docs/semantics/`）本包不需要改。

## 要用户定的事

1. **云端一键配特效，镜头识别、主体识别要不要必需？** 背景：桌面版的「一键配特效」只靠文字稿：转写，按关键词配卡，铺字幕，不需要镜头识别和主体识别。云端按验收要求做成五个阶段，并且缺省下「某一阶段的能力在这台节点上没就绪就停在那里」。后果：如果一台云节点没装主体识别（需要 onnxruntime 和权重），云端的一键配特效就整个做不出来，即使字幕和卡片本来只要文字稿。选项：A 保持现状（必需，停下并说明）；B 镜头识别、主体识别设为可选，没就绪时跳过、继续配字幕和卡片，最后告诉用户「镜头识别、主体识别没做成」（宿主配 `optionalStages: ['shots','subjects','prerender']` 就行，不用改代码）。我的建议：先用 B，因为用户要的是字幕和卡片，镜头和主体只是锦上添花；但这一条和验收原文（「停在那一阶段、后面的不做」）不一致，所以没自作主张，等你定。
2. **重复点一键配特效，要不要叠出第二份字幕和卡片？** 背景：桌面版重复调用会再放一遍；我在接口里加了去重（〔裁〕6），宿主实现了的话，对同一份文字稿再跑一次，不会重复放，阶段标「复用」。选项：A 去重（我的建议，叠两份字幕只会难看）；B 与桌面版一致，不去重。去重靠宿主接缝，不实现去重就自然是 B。
3. 失败时给模型看的几句话（「一键流程在『…』阶段失败了：…后面的阶段(…)没有做。重新调用 auto_workflow 可以接着做…」等）是我写的草稿，经模型转述给用户。如果用户想自己定措辞，在 `hosted-workflow.mjs` 的 `workflowError` 与 `WORKFLOW_ERROR_TEXT`。
