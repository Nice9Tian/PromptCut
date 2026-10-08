# 账号云端对话控制界面

## 开工记录

- 分支：`codex/018-account-conversation-controls`，基线 `037587670cb6c0cd28379d4ee72d6007821a3b02`。
- 工作边界：只改 `src/ai/CloudAiPanel.tsx`、`src/ai/CloudAiPanel.css`、`src/ai/cloud/cloudApi.ts`、`src/ai/cloud/useCloud.ts`，以及本任务的 API 测试、UI 探针和本报告。不改成员面板、同步管理器、服务端、产品语义或进度文件。
- 目标：用真实的账号云端对话接口呈现共有/私有状态；只有对话所有者能切换；创建者查看他人私有对话时只读；仅当前轮发起者和项目创建者可以停止，并且停止请求必须携带服务端报告的 `currentRunId`。
- 可靠性约束：等待执行服务的消息不显示成运行中的任务。权限切换或停止遇到 503、fence pending 时不报成功；保留同一个 `requestId` 供重试并在成功或冲突后重读元数据。若切私有已先行禁止新访问但相关服务 fencing 尚未确认，界面说明“已禁止新访问，相关服务关闭待确认”，不以新请求号重复提交。
- 服务端执行确认由独立服务块负责；本任务不伪造确认，也不把前端状态当作实际任务停止。

## 验收与证据

### 实现

- `CloudAiPanel.tsx` 与样式新增当前云端对话的共有/私有状态、所有者切换按钮、创建者只读提示，以及基于队列当前 `runId` 和发送者账号显示停止操作。等待执行服务的队列行不会当成运行中的一轮；创建者只读私有对话不渲染输入区和附件入口。
- `cloudApi.ts` 新增账号模式 visibility POST 与带 `runId`、稳定 `requestId` 的停止 POST。两个接口都省略 Cookie；成功回包严格核对。旧 LAN/hosted abort 仍发原来的空 JSON body。
- `useCloud.ts` 暴露上述对话控制，并让历史刷新返回是否成功，以便页面在权限元数据读取成功前隐藏发送区。
- 503/fence pending 后刷新历史元数据并保留原 `requestId` 供重试；`agent-fence-pending` 明示“已禁止新访问，相关服务关闭待确认”。不会把 pending 当作已切换或已停止。
- 新增 `src/ai/cloud/account-conversation-controls.test.mjs` 与 `scripts/probes/account-conversation-controls-probe.mjs`。探针读取真实页面上的 `data-pc` 控件；需 root 提供已登录窗口后才可做实际 UI 验收。

### 验证

- `node scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs src/ai/cloud/cloud-chat.test.mjs src/ai/cloud/account-queue.test.mjs`：28 项通过，0 失败。新增控制测试覆盖角色门控、排队不作运行、无 Cookie 的请求形状、严格确认和同 request ID 重试；回归覆盖云端会话与旧 abort 行为。
- `npx tsc -p tsconfig.json --pretty false`：通过。
- `node --check scripts/probes/account-conversation-controls-probe.mjs` 与 `git diff --check`：通过。
- 未启动 listener、浏览器、服务或节点；因此真实页面截图及后端 fencing ACK 不在本阶段验收范围。当前账号服务若返回 503，UI 会显示待确认状态，不声称任务已关闭。

### 工作区误写记录

实施中我有两次 `apply_patch` 路径漏掉 `.worktrees/018-member-native-route` 前缀，短暂把 `CloudAiPanel.tsx` handler 写入主工作区。核实时主工作区只有该文件被我改动；我仅撤销了这个由我造成的单文件差异，并确认主工作区 `git status --short` 为空，随后已向 root 报告该经过。root 表示会另行核对 main 文件与 HEAD 字节一致。本报告不把该事件记作“未发生”。

本分支开工报告已先独立提交；实现与本报告的最终 SHA、干净状态由交接消息报告。未完成项：待 root 提供真实窗口后运行页面控件探针；账号 fencing 的实际执行确认由独立服务块验收。


## 异步身份隔离补丁（2026-10-09）

- root 审查指出，原 `applyCloudControl` 在 `await` 后只比较 render 闭包中的 conversation ID；账号或项目切换后若 conversation ID 相同，迟到结果可能清理新 scope 的 pending、显示旧操作成功，或在旧停止请求重试时误用新身份。
- `CloudAiPanel.tsx` 现在把账号、项目、云端地址与身份版本、consent account/binding/accepted 状态及 conversation ID 绑定到单调 epoch。作用域变化时即时隐藏/清空旧 pending 与 in-flight；每次控制请求开始、接口 await 后、历史刷新 await 后、catch/finally 都校验原 epoch。旧请求不刷新、不写状态、不清新请求的 in-flight，也不能带旧 request ID 重试。
- `useCloud.ts` 的权限切换在 consent promise 返回后重新核验同一 epoch、key、session 和 conversation，再提交 API；历史读取和错误提示也只允许原 scope 更新状态。账号模式 abort 必须有当前 run ID 与 request ID，否则拒绝，绝不回落到 session 的 legacy 空请求。
- 回归测试不是源码字符串断言：以真实 deferred promise 模拟同一 conversation 的 A→B→A。保留首红输出：首次 4 项中 3 项通过、1 项失败，ABA 旧 token 被误判 current（`true !== false`）；单调 epoch 修复及 consent-迟到提交用例后，控制测试 6 项通过。测试还检查旧操作不能清除新 request pending，迟到 consent 后 API 提交次数为 0，账号 abort 缺任一编号会拒绝。
- 浏览器探针补了实际签入页面的可调用操作 `requestAccountVisibility` / `retryAccountStop`，读取真实控件、点击真实按钮并区分 `confirmed`、`pending`、`error`。它不模拟服务端成功；仍需 root 提供的真实签入窗口做角色、private/fence-pending 页面验收和截图。
- 本补丁验证：`node scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs src/ai/cloud/cloud-chat.test.mjs src/ai/cloud/account-queue.test.mjs`（31 项通过，0 失败）、`npx tsc -p tsconfig.json --pretty false`、`node --check scripts/probes/account-conversation-controls-probe.mjs`、`git diff --check`。未启动浏览器、服务或节点；实际账号 fence ACK 仍由独立服务块验收。


## Puppeteer 用户路径 CLI 补充（2026-10-09）

- 把先前只暴露页面操作函数的探针扩展为 Puppeteer CLI：`node scripts/probes/account-conversation-controls-probe.mjs --dist <online-dist> --site-root <site-root> --out <os-temp-child>`。脚本启动自有 Puppeteer 浏览器、静态页面和新 fixture，按真实 UI 流程创建两账号会话、由项目成员发送共享对话、项目创建者核对无切换按钮、成员切私有遇 HTTP 503 fence pending 后重试并核同一 request ID；创建者打开私有对话核对可读只读状态。页面只通过 DOM 检查和点击操作，不注入状态或伪造接口响应。
- 原 cloud queue fixture 的 Agent HTTP 端口固定在 6526，超出本阶段 6620–6639 租用段，所以新增独立 fixture 文件副本 `server/test/fixtures/account-conversation-controls-user-path.mjs`，只将其 Agent 端口配置为调用者传入的 6627，close 后保留失败现场目录供核查；没有修改既有 queue fixture。探针使用 6620–6629，并在 finally 后验证这些端口全部可重新绑定。输出只留安全路径/status/method、重试 request ID 相同的布尔值、截图与检查结果；不写凭证、请求 body 或原始 request ID，并保留已关闭的 Chrome profile 与 fixture 临时目录，供 root 检查真实失败现场；临时数据位于当前用户 temp 下，fixture 在非 Windows 系统使用 0700 权限。
- 可见性检查现在核对目标元素实际矩形和从元素到根节点的所有祖先样式、`hidden` 与 `aria-hidden`，避免隐藏 panel 内的按钮被误报可见。CLI 的结果分类纯测试覆盖 confirmed/pending/error 三种状态。
- 代码检查只做 `node --check` 和 `git diff --check`；纯分类测试三种情况通过。本轮没有运行真实 CLI、浏览器或 fixture，也没有运行完整服务；因此尚无页面截图、真实 HTTP 503 或端口关闭实测结果。已有服务代码路径显示私有切换执行 `onFence` 并在 ACK 未完成时返回 `agent-fence-pending`，conversation authority 的 `get` 为创建者私有只读返回标志；这只是源码证据，不替代真实页面验收。
- root 另审到 `Composer` 的 running 分支始终显示停止按钮，账号成员无权停止别人运行时 `handleStop` 只会静默返回。此为可见权限缺口，和对话 `streaming` 状态无关；本次在 CLI 中没有伪造 running 状态。root 已单独授权窄修 `src/editor/right/chat/Composer.tsx`，后续以独立提交修正并验证按钮的权限说明，同时保留真实运行态待 executor 验收。


## 停止按钮权限显示补丁（2026-10-09）

- root 复核发现 `Composer` 在 `streaming` 时总显示可点击的“停止”，普通成员虽无权停止别人的运行，点击只会被 `handleStop` 静默忽略。
- `Composer` 新增可选 `canStop` 与 `stopDisabledReason`；不传时 `canStop` 默认为真，维持本机旧行为。账号模式由 `CloudAiPanel` 传入 `canStopCurrentRun`，无权限时按钮禁用，并用 title 与 aria-label 说明“只能停止自己发起的任务”。`streaming` 仍按真实当前运行状态传递，没有通过隐藏运行状态规避权限。
- 先保留真实组件 SSR 首红：用 TypeScript transpileModule 编译实际 `Composer.tsx`，ReactDOMServer 渲染非所有者、所有者与省略新 prop 的本机默认场景；旧实现 6 项通过、权限按钮用例 1 项失败（停止按钮没有 disabled）。修复后 7 项通过；实际 CloudAiPanel 的账号策略仍由既有角色策略测试覆盖。SSR 仅 mock 了 Composer 的旁支图标、弹层、尺寸 hook 与 CSS，按钮 DOM 来自真实 Composer 组件。
- 验证：`node scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs`（7 项通过）、`npx tsc -p tsconfig.json --pretty false`、`git diff --check`。没有伪造 `running` 服务状态或 executor ACK；真实运行中的普通成员按钮显示仍需 root 的真实 executor 阶段确认。

## 真实 Puppeteer 探针窄修（2026-10-09）

- root 在首次真实窗口运行前审阅时发现三处探针风险：历史记录通过 `$$eval` 内的 DOM `.click()` 绕过 Puppeteer 用户点击路径；控制操作只等待短暂“正在”文本，真实 503 若先返回会导致探针漏掉本次操作；打开项目后立即同步查询 consent 弹窗，可能早于异步读取结果或弹窗出现。
- `chooseHistory` 现在等待历史入口可见、可用且中心点击点未被遮挡，并等待目标记录可见；记录滚入可见区域后再复核中心无遮挡，随后通过 Puppeteer `ElementHandle.click()` 操作真实记录。移除了页面内直接调用 DOM `.click()` 的路径。
- 共有/私有切换及停止重试在按钮点击前，按当前 conversation ID 注册精确路径与 POST 方法的真实 `waitForResponse`。每次调用都创建自己的响应等待；收到该次响应后才等待非加载状态并分类。返回中仅保留真实 HTTP 状态码，现有网络记录仍只写路径、状态、方法和 request ID 是否一致，不写 body 或 ID；没有伪造响应。
- 项目打开前为账号 consent GET 注册真实响应监听；等待实际服务器 `accepted` 结果或真实可见弹窗。弹窗存在时以真实按钮确认，并等待同一路径的 POST 响应确认 `accepted` 后才继续。页面未注入 consent 状态。
- 本次只改该 Puppeteer 探针和本报告；产品、测试、fixture 均保持冻结。没有启动浏览器、服务或节点，也未运行 SSR、类型检查、完整测试或真实 CLI，因此真实窗口结果和 fence 关闭 ACK 仍待 root 后续验证；本记录不将 private fence pending 说成跨服务撤销完成。没有新增首红，因为本次修复发生在首次真实探针运行之前。

## 后续真实 read-control fixture 迁移计划（2026-10-09；尚未实施）

- 本分支当前 fixture 的 Agent 只构造一个旧 `createConversationClient`：见 `server/test/fixtures/account-conversation-controls-user-path.mjs` 第 273 行附近；随后立即把它交给 `createHostedWiring` 和 `createHostedAgentService`（约第 275–276 行）。没有 read-control client，也没有 Agent 实例注册/连接等待。Astra b11d 安全 stage 改为拒绝 doc assembly 的旧 conversation read，因此这条旧路径的历史读取会以 503 失败；不能把缺失的 `readTransports` 当成期望的 fence pending。
- 等 root 将新 protocol 同步到该工作区后，计划在 fixture 用与现有 pinned doc TLS 相同的配置建立单独 `runClient`；再以同一配置和 `runClient`、位于 fixture 自有 temp dir 的 receipt 文件建立 `createConversationControlClient`，将其接到 `conversationClient.useReadControl(controlClient)`。随后先真实 `registerInstance()`，启动 control consumer，并轮询其 `describe().connected` 到真连接后才开放 Agent HTTP 场景。不会伪造 access grant、read transport 或 ACK。需要按同步后的导出和真实方法签名实施，当前代码还没有这些导出，故本轮不提前写代码。
- fixture 关闭顺序计划为先停 control consumer，再关闭 Agent HTTP/service 与 conversation client，再关闭 doc、run client 和其余自有资源；close 仍须等待所有自有 socket、子进程和端口释放。新增 receipt 只落在本 fixture 的独立临时目录，保留现有 fixture 失败证据目录策略。
- 迁移后，浏览器主路径应改为断言真实 read-control 支持下的历史读取及真实私有切换结果；如果服务返回实际 ACK，就报告为 confirmed，不能继续把现有“缺 read transport 导致 503”称为 pending。需要另保留一个有真实在途消费/dispatch 尚未完成的 pending 反例，不能 stub control client、伪造 response、临时返回成功或把旧 `onFence` 缺项算作 pending。具体可控的真实在途路径必须等同步的 protocol/服务接口核实后再选；本报告不假定 API 或伪定实现方法。若接口不提供可复现且真实的未完成消费场景，应把 pending 反例列为阻塞的验收缺口并报告 root，不以模拟补齐。
- 此计划阶段只做了只读检查，未启动 service、浏览器、fixture，未修改 fixture/探针或任何生产代码；当前唯一允许变更是本报告。后续实施待 root 同步 Astra protocol 并明确新 fixture 租约后再开始。

## Puppeteer 首轮失败的安全诊断补充（2026-10-09）

- root 提供的真实运行摘要显示：端口前置检查 10 项全部通过；creator 页面点击项目后一直未进入项目视图，超时于 `project-open`，creator 截图为空黑页，owner 仍停在云端项目列表。这与串行流程一致：creator 的 `openProject` 未完成前不会打开 owner 项目。只核对了 result 中的阶段/检查/网络状态及两张截图，没有读取 fixture 凭证或密钥；6620–6629 在 root 的结果中全部释放。
- 为定位 blank React 页面的异常，本次仅给 Puppeteer 探针补诊断：监听 `pageerror`，输出仅限白名单错误名、固定错误类别，以及经过筛选的脚本 basename/行列和 `editor`/`stage`/`other` 来源类别；不输出原始 message、stack、console、URL query、headers、body、cookie、密码或 token。页面快照只记 pathname、readyState、节点是否存在及计数，不读取任意页面文本或输入值。
- `openProject` 增加等待项目行、实际点击前、点击后等待项目视图、项目视图已出现、consent 弹窗/接受等步骤快照；超时时记录最后一个受控步骤和两个页面的安全快照。result 仍留在调用者指定的临时输出目录，console 摘要只增加受控步骤名和 pageerror 数量。探针不收集一般 console 消息。
- 顺带只读检查了 stop 权限显示：当时 `CloudAiPanel.css` 的 `.pc-cloud-panel[data-cloud-can-stop="0"] [data-pc="ai-stop"] { display: none; }` 会隐藏 Composer 中以 `disabled`、`title` 和 `aria-label` 说明无权停止的按钮，因此这份权限说明在普通成员账号运行态下不可见。当时 Composer 默认行为与禁用实现仍在且未改；后续授权修复见下一节。
- 当时的窄租约仅包含探针与本报告；没有重跑 browser、服务、类型或全量。该阶段用 `node --check`、`git diff --check` 与改动路径核对后提交供 root 复跑诊断。

## 项目 fixture 首红修复与停止说明可见性（2026-10-09）

- root 复核真实首红日志：前置检查 10/10 通过，随后 creator 在打开项目时超时；白名单页面诊断给出 `TypeError` / `missing-value`，安全 frame 为 `assets/index-wyXE3Vt3.js:33734:72685`。root 依据精确构建列映射到 `ControlBar` 对 `duration.toFixed(2)` 的调用。fixture 之前只传 `initialProject: { tracks: [] }`，缺少正常编辑器项目字段；正常产品 `AccountProjects` 通过 `createEmptyProject(label)` 创建完整初始项目。
- fixture 现在直接导入 `src/kernel/project.ts` 的 `createEmptyProject`，并以同一项目名构造 `initialProject`，让浏览器流程使用真实完整项目形状。没有改 `ControlBar`、默认项目加载路径或渲染策略来掩盖 fixture 错误。
- 删除 `CloudAiPanel.css` 中依据 `data-cloud-can-stop="0"` 隐藏 `ai-stop` 的单条规则。Composer 原有的 disabled 状态、title 与 aria-label 权限说明因此能在账号模式无停止权限时展示；没有改 Composer 或其它产品文件。
- 只读 package 为 ES module；纯 Node 24 导入 `src/kernel/project.ts` 成功，生成对象检查为项目名正确、version 1、duration 30、两条轨道、media 数组。fixture 的 `node --check` 通过；`tsc -p tsconfig.json --pretty false` 通过；`node --import=./scripts/lib/test-silent-processes.mjs scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs` 7 项通过、0 失败，包含 Composer 真实 SSR 权限呈现回归。`git diff --check` 通过。未运行完整测试、listener、浏览器、节点或 fixture 服务。

## Agent 服务重启后的对话权限重读（2026-10-09）

- root 第三次真实窗口构建无 TypeScript/type/full 回归（type 0；full 5417 项、0 失败、4 skipped），浏览器通过 10 项端口前置检查，两个账号的编辑器打开和 consent 均完成，随后 owner 在创建共享对话阶段超时；result 无 pageerror。安全网络摘要显示 Agent 关闭期间 `info`、对话列表和 events 返回 403；creator 开启后 `info` 与 events 返回 200，但权限读取流程没有发起新的对话列表请求，面板一直停在“正在读取对话权限”。没有将 fixture 凭证写入或读取到报告。
- 原 `metadataKey` 只由 qKey 和 conversation ID 组成，刷新 effect 也只依赖账号模式、consent、conversation、refresh 函数和该 key。Agent 开启状态变化时 key 不变，因此先前失败的历史/权限读取不会重做，发送区也继续正确保持关闭。
- `CloudAiPanel.tsx` 将 `cloud.enabled` 和 `chat.info?.enabled` 的可用状态位纳入 `metadataKey`。项目开关或服务 `info.enabled` 状态恢复时，既有 metadata refresh effect 会重新读取当前对话权限；key 在 render 中同步变化，使 `metadataReady` 先转为 false，成功刷新前仍禁发。流程只重读原 conversation，不创建新对话；creator 私有只读仍由已读取的 conversation metadata 决定，异步控制请求 epoch/身份隔离没有变化。此次无需改 `useCloud.ts`。
- 本修复验证：`node --check`、`tsc -p tsconfig.json --pretty false`、账号控制目标测试（7 项通过、0 失败）、`git diff --check`。没有重跑 browser、服务或 full；root 将用固定源码重新构建并实际复测。
