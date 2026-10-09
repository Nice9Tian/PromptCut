# 018 改密后会话保留用户路径报告

## 开工范围（2026-10-09）

- 基线：分支 `codex/018-password-user-route`，提交 `ff51441c`；工作区初始干净。
- 验收目标：用隔离的真实 VisuHive provider 与网站页面建立三个登录会话和一个在线编辑器登录；在首个网站会话执行真实改密并选择退出其它设备后，验证发起网站会话保留、第二网站旧会话失效、编辑器退出并清除已读正文、旧密码不能登录且新密码可登录。全程不得输出密码、cookie、令牌、签名密钥或完整敏感响应。
- 先核对账号任务书的已定语义、VisuHive 真实账号与密码排序接口、PromptCut 网站与在线编辑器登录桥接，再搭隔离 fixture 和真实 Puppeteer 页面探针。fixture 不启用 Agent 执行器、不制造活动任务、不伪造 authority、fence、ACK 或 epoch。
- 文件租约仅为：`server/test/fixtures/account-password-user-path.mjs`、`scripts/probes/account-password-user-path-probe.mjs`、专属 `server/test/account-password-user-path*.test.mjs` 与本报告。PC 产品或 VisuHive 只读源若显出缺口，先提供证据与最小修复路径，等待 root 扩大租约后再动。
- 邮箱重设只有在可用的真实安全凭据/短信路径可无费用、安全地实测时才纳入。若凭据签发要求外部服务或不具备可用凭据，将明确标记未验证，不绕过重设凭据。桌面登录桥接如需跨租约产品改动，也单独界定阶段。
- 验证采用专属 `npm test -- <target>` wrapper、必要类型检查、探针语法与 diff 检查，以及固定源码后的隔离真实浏览器路径。端口仅 6680–6689；不得启动 full、使用生产账号/短信/收费服务、碰其他占用端口/节点、安装依赖、清理他人文件、合并或推送。

## 进度

- 已核对入口 `developer_guide.md`、`suggested_agent_behavior.md` 与 `constraints.md`；产品语义以账号任务书与 VisuHive 真实 provider 为准。
- 已用独立隔离 fixture 调用真实 VisuHive provider 的注册、登录、编辑器子会话、改密、事件选择、邮箱绑定、重设码签发与重设确认接口。邮件回调只在进程内接住 provider 随机签发的验证码；没有使用真实邮箱投递或生产账号。
- 专属 `npm test -- server/test/account-password-user-path.test.mjs` 在显式指向只读 VisuHive provider、密码排序模块和本地 authority 模块后通过：1/1；验证发起网站会话保留、另两网站会话及编辑器 bearer 失效、旧密码拒绝、新密码可登录；重设也验证旧会话撤销与新密码登录。provider 对改密和重设退出均返回 `logoutState=revoking`，这是服务确认仍待处理的真实状态；未声称退出已完成、未验证互联网邮件投递。
- 测试首轮在未显式提供外部 provider 路径时红于 `real v2 account provider root is required`，这属于环境入口缺失；加进程级路径后同一目标通过。探针和 fixture 另已通过 `node --check` 与 `git diff --check`。
- 固定在线构建 `npm run build -- --mode online --outDir <TEMP>` 通过。产物 `index.html` 引用 `/editor/assets/index-C3woiw05.js` 等在线资源；`stage.html` 使用同一编辑器入口资源，探针 runtime config 为两个独立 origin `s1.pc.localhost:6688`、`s2.pc.localhost:6689`。普通构建没有被当作在线资源验收。
- 独立 `--site-form-only` 浏览器 smoke（不算 Editor 完整路径通过）记录到：VisuHive `/assets/site.css` 为 `200 text/css`，样式表可读 49 条规则；表单有效、三项密码值存在且新密码重复匹配、按钮已启用，滚入视口后也确认为 visible/unobscured。但实际点击后 35 秒内未观察到 `/api/account/password` 请求，故站点表单仍为失败，截图和安全结果在 `%TEMP%\pc-password-user-path-site-form-smoke-9`。同一轮在线 Editor 的 JS chunks 为 200，但 `/editor/assets/index-C-Dl6M5S.css` 是无 HTTP response 的 failed request；document stylesheet 未加载且规则不可读，截图表现为无样式原生控件。这说明此前 toast 无法进入可视范围的轮次受在线 CSS 加载失败影响；不再将其归为产品权限结果。
- 后续 site-form-only 诊断结果 10–12 保留在 `%TEMP%\pc-password-user-path-site-form-diagnostic-10`、`-11`、`-12`。10/11 在真实点击前开启 CDP pause-on-exceptions，改变了被测路径；这两轮不作产品结论。12 撤去暂停调试器，但探针误传 `ElementHandle.click({timeout})` 选项且没有保留安全化堆栈帧，不能据此判断网站表单行为。12 轮记录的 Editor CSS 失败为 `net::ERR_TOO_MANY_RETRIES`，因此为独立 Chrome 配齐已通过探针使用的自签证书和 stage resolver 参数，并修正点击调用、被动事件前后快照、点击异常类型/源码帧与提示枚举后，再执行一次固定源码 site-form-only。
- 固定探针源码 `aa8b4089b59c79ccd571e0c70360ccf9b0c605a4` 的 site-form-only 结果保留在 `%TEMP%\pc-password-user-path-site-form-diagnostic-13`：20 项前置通过，在线 CSS failed-request 计数为 0；密码表单 valid、三项字段存在且重复匹配，提交按钮 visible/unobscured，`isSecureContext=true`、`crypto.randomUUID` 类型为 function。真实 `ElementHandle.click()` 抛 `ProtocolError`，安全化首个错误栈位置在 Puppeteer `CallbackRegistry.js:108`，后续栈经过 `Connection.js:125`、`CdpSession.js:72`；探针同时保存点击调用的被动事件前后快照，均为 click/submit/invalid 计数 0，提示枚举为 `empty`，未观察到改密 POST。因为调用在 Puppeteer CDP 层失败，不能据此判断 VisuHive 表单提交处理；没有再启动浏览器轮次。结果显示 `sourceBefore=sourceAfter=aa8b4089…`，browser、stage、fixture、asset child 均已关闭，6680–6689 端口全空闲。
- root 进一步核对本机 Puppeteer 调用栈后确认，13 轮的协议失败发生在 `ExecutionContext.evaluate` / `IsolatedWorld.evaluate`，未到 `Input.dispatchMouseEvent`；当时密码表单标签页位于后台，后开的 Editor 标签页在前。为验证前台焦点是否影响 `ElementHandle.click()` 的滚动可见性检查，下一固定探针仅在该独立标签页调用 `bringToFront()`，记录调用前后的 `document.visibilityState` 与 `document.hasFocus()`，并继续使用普通真实 `click()`。若失败，只保存协议方法、预定义原因类别和去掉错误首行后的安全栈位置，不保存原始错误消息。
- 固定探针源码 `0eda72c970905e65ecf09e01d05f7ad322ec79e5` 的下一轮结果在 `%TEMP%\pc-password-user-path-site-form-diagnostic-14`。表单页调用 `bringToFront()` 前 `visibilityState=hidden`、`hasFocus=true`，调用后为 `visible`、`hasFocus=true`；真实点击为 trusted click，真实 submit 使用目标按钮且 `defaultPrevented=false`，没有 invalid 事件。站点 `/api/account/password` POST 返回 200；site-only 检查共 27 项全过：发起网站会话保留、另两网站会话失效、旧密码拒绝、新密码登录成功，退出选项仍真实返回 pending。CSS failed-request 为 0；sourceBefore/sourceAfter 均为 `0eda72c9…`，浏览器、阶段、fixture、asset 子进程关闭，6680–6689 端口空闲。此前 smoke9/13 的“没有改密 POST”结论由此轮真实路径结果更新。此轮没有验证 Editor 中读取正文关闭；完整 Editor 用户路径仍需单独续验，不能由网站会话撤销推断服务端 read-fence 已确认。
- 最新 main 对齐后重新生成 online build 到 `%TEMP%\pc-password-user-path-dist-main-64944f0b`，`npm run build -- --mode online`（含 `tsc -b`）通过；`index.html` 与 `stage.html` 引用同一 `/editor/assets/index-C3woiw05.js` 和 `/editor/assets/index-C-Dl6M5S.css` 在线资源。provider 专属 `npm test -- server/test/account-password-user-path.test.mjs`：1/1 通过，测试输出的改密/重设 `logoutState` 均为 `revoking`，仍不是完整服务屏障确认。
- 完整 Editor 路径冻结探针 `2619bac96ec84e5e4714613c1a82dfc95fd2d04c` 后仅运行一轮，结果在 `%TEMP%\pc-password-user-path-full-main-2619`。24 项前置/登录/共享项目/consent/Agent 开启检查通过；read-control 已连接且实例已登记，`executorMounted=false`。CSS 与 JS 静态资源均成功，pageErrors 为空。开启 Agent 后 info/list GET 为 200，但 SSE 请求随后出现 13 个 HTTP 502，真实附件上传 POST 返回 503，未到附件回包、消息排队、改密或重设步骤；这轮不能代表完整路径通过。首次失败截图、result 与失败请求分类均保留；sourceBefore/sourceAfter 一致，browser、stage、fixture、asset child 关闭，6680–6689 端口空闲。没有重试。
- 真实浏览器尚未完成改密闭环。最初 403 轮 consent GET/POST 成功，但探针在 consent dialog/Agent 开启间停滞；脱敏业务码证实 `/agent/v1/info`、对话列表和事件请求返回 `403 disabled`。后来一轮真实路径完成：真实 project-agent admin POST 为 200，项目 ID只作相等比较并匹配当前项目；read-control 为 connected、实例已登记、`executorMounted=false`；Agent info/history 后续回到 200，网站 `/api/account/me` 为 200，实际发送消息 POST 为 202，界面显示等待执行服务。没有运行 Agent executor。
- 上述成功轮次之后进入改密 UI，但没有观察到 `/api/account/password` 请求，故没有把它记作改密通过。后续两轮复验未发 Agent admin 请求：探针在分享 toast 的真实关闭步骤卡住；Dom 计数显示 consent 对话框不存在、Agent 开启按钮和关闭状态可见、权限仍在读取。toast 截图/安全结果与之前的成功路径均保存在 `%TEMP%\pc-password-user-path-once-*`；每轮 browser、stage servers、fixture、asset 子进程均关闭，6680–6689 全部空闲。未用 API 绕过实际按钮。
- 桌面原生登录桥接不在本阶段范围。改密后真实在线编辑器正文自然清空、服务器读取关闭的浏览器断言尚未到达；必须等真实界面闭环再判定，不能由仅 provider session 撤销结果推断。

## 纯文本真实读取路径修正（2026-10-09）

- 按最新服务接线审查，account 模式尚未挂载对话附件 authority；`attach` 返回 503 是现有边界，不能用 fixture 数据目录补出授权能力。因此完整 Editor 路径调整为真实纯文本消息，附件上传单独列为未验，不绕过权限或直接写历史。
- 删除附件步骤时同时修正了探针 TDZ：旧附件响应 matcher 在 `conversationId` 声明之前读取它，异常会被 Puppeteer matcher 捕获并吞掉，造成永不匹配的等待。现在先执行真实纯文本消息 POST，收到 202 和 SSE 可见正文后，再只读页面取得 conversation ID 用于流匹配。
- `editorStep` 会在发送纯文本、网站改密、等待读权撤销、检查已读正文清空、后续历史读取和 provider 重设前更新，使失败结果指向当时实际操作。
- fixture 的诊断仅记录 Agent HTTP 路由类别、状态、有限白名单业务码、是否已发送 headers 与是否正常结束；Edge 只记录路由类别、网络错误枚举、上游是否完整及下游 headers 状态；read-control 只记录有限错误码及 transport `describe()` 状态。错误响应体仅在内存中短暂解析其 `code` 并随即丢弃，结果不含原始响应、凭证、header 或完整 URL。列表上限为每种 250 条。
- 本轮 `node --check`（probe 与 fixture）及 `git diff --check` 通过；显式提供只读 VisuHive provider、密码排序模块、本地 authority 模块、CUDA Python 后，`npm test -- server/test/account-password-user-path.test.mjs` 通过 1/1，清理诊断为 child 已关闭、closeFailureCount 为 0。provider 的改密/重设退出状态仍为 `revoking`，不作为服务屏障确认。
- 下一轮固定源码的真实浏览器只跑一次纯文本路径；Agent SSE 若仍失败，将用上述受限诊断区分 Agent HTTP/read-control 与 Edge 流生命周期。保留既有真实失败记录，不自动重跑。附件能力、桌面桥接、互联网邮件投递和 logout `revoking` 到最终确认仍是独立未完成事项。

## 固定纯文本路径的真实浏览器结果（2026-10-09）

- 固定源码 `b84737433001306c9870e23f78b1cbb871f30091` 后只运行一轮；`result.json` 与截图保存在 `%TEMP%\pc-password-user-path-full-plaintext-b8473743`。探针总结 34 项通过、0 个显式断言失败，但 `completed=false`；源前后相同，浏览器、stage、fixture、asset child 都关闭，6680–6689 全部空闲。首次 preload 命令错误地写成 `--import scripts/...`，Node 未启动探针；随后改用 `--import ./scripts/...`，只产生这一轮浏览器运行。
- 共享项目、真实 consent、Agent 启用均完成；read-control 起始为 connected、open=0、closed=0、executor 未挂载。启用前 Agent `info`、列表和 events 为 403 `disabled`。启用后，消息前一个 events 请求被 Edge 记为 502；Agent HTTP 侧没有对应的 completed 502 记录，代理侧有 `ECONNRESET`/abort/incomplete-close 记录。消息真实 POST 为 202，UI 显示一个等待执行的队列项，发送后的真实 events 为 200 长流，随后页面能显示用户纯文本 SSE 消息。这个结果支持“首次消息前新对话与发送后已有 durable 事件”行为不同，但没有通过模拟状态或读取原始响应体作结论。
- 网站改密 POST 返回 200、退出其它设备选择返回 202；另外两个网站会话退出断言通过。探针在 `editor-wait-for-real-read-revocation` 等待旧正文自然消失时超时；截图中的在线编辑器仍有权限读取加载状态，因此正文清除没有通过。其后真实 events 出现 401 `unauthorized`，read-control 最终仍 connected、open=0、closed=8，并报告 `read-control-disconnected`。没有到达正文清除检查完成、退出事件状态检查、后续历史读取拒绝或 reset UI；不得把 34 个已过检查等同完整路径通过。
- 当前证据将 early events 502 与其余服务侧状态区分开，但仍无法仅凭路由类别建立同一请求级因果。下一步应由 root 审阅首次失败截图与安全 JSON；本分支不改产品或绕过 read fence，也不再次启动浏览器。附件路径没有尝试，仍待真实服务 authority 单独接通和验收。

## 前台撤权与真实历史拒绝复验（2026-10-09）

- 对 `b8473743` 的后台轮询失败，只修了探针和报告。只读源码确认账号 Cloud ticket 每次来自当前内存 `ProjectSession.agentDelegationTicket`；project session 过期时才由当前账号客户端续期，失权会清除 `CloudIdentity`。探针只记录项目 session 响应是否含合法票据，票据仅在进程内存保留供必要的拒权 fallback，不写入 JSON 或日志。
- 固定 probe `c8e61862f4247aa5f9b2b18d8e0d7aff404b580f` 后只复验一次。撤权清除等待前 Editor 的焦点为 `hidden/false`；调用 `bringToFront()` 后为 `visible/true`。只读快照显示 expected message 不残留、用户消息 0、排队项 0、权限加载 0；改成 100ms polling 的真实 DOM predicate 通过，随后消息/队列最终计数仍为 0。真实可见的历史按钮被实际点击，Agent history 返回 401；`deniedHistoryRead` 记录 endpoint 类别与状态，不包含票据。此轮因此完成了旧正文消失、队列清空、真实历史拒绝三项读取撤权验证，不需要直接旧票 fallback。
- 改密 POST 200、退出选择 202、两条其他网站会话退出断言通过；旧 SSE 关闭断言通过。在线 editor 发生真实 events 401，之后真实 project-session renew POST 401。read-control 最终 connected=true、open=0、closed=9；无 executor。
- 本轮总计 39 项检查通过、0 项断言失败，但 `completed=false`：运行在 `website-provider-issued-reset` 阶段、reset 操作尚未开始时退出；完整日志的当前 phase 仍为 password-change-and-exit。截图和安全 JSON 保存在 `%TEMP%\pc-password-user-path-front-recheck-c8e61862`。Editor 被置前后，initiator 网站 tab 转为后台；退出发生在 password-pending 截图准备处，结果未留下更细的内部异常分类。因此不得把 reset 记为本轮验收通过，也不能确定截图准备是唯一失败根因。下一步若要继续，应先只为该 probe 步骤补当前焦点/安全异常分类，再由 root 决定是否授权新的单轮运行。
- 真实浏览器、stage、fixture、asset child 全部关闭，6680–6689 空闲。未修改产品，没有重跑或清理首轮与本轮证据。

## 前台截图步骤与完整纯文本/重设闭环（2026-10-09）

- 按 root 对 `c8e61862` 结果的审阅，只改探针和本报告：`safeShot` 先记录目标页面切前台前后的 `visibilityState/hasFocus`，再由真实可见输入框点击清理密码和验证码；填表及其余真实页面点击也统一先将对应页面带到前台。没有使用 DOM click、脚本注入状态或截图明文。
- `password-pending` 截图准备现在单独标为 phase `password-change-pending-screenshot` / step `website-password-pending-screenshot`，只有截图成功后才进入 `password-reset-with-provider-issued-code`。catch 安全结果只保存动作分类、异常类型、协议方法与原因枚举、去掉原错误首行后的最多 16 个栈帧，并移除 URL query；不保存原始 error message、局部变量、口令或验证码。
- provider 专属 `npm test -- server/test/account-password-user-path.test.mjs` 通过 1/1；`node --check` 与 `git diff --check` 通过。探针固定源码为 `cf82a519a9c3a307490fced7c4b8fe9c9bdb446f` 后只执行一轮真实路径，结果 `%TEMP%\pc-password-user-path-final-cf82a519`：46 项检查通过、0 失败、completed=true、sourceUnchanged=true。
- 撤权部分再次实测：Editor 后台切到前台后显示 `visible/true`；DOM 只读计数为旧正文不残留、用户消息 0、队列 0；100ms polling 的正文消失检查、旧事件流关闭、消息/队列最终清空均通过。真实 UI 历史按钮点击后 Agent history 返回 401。真实项目 session 中合法票据仅在进程 RAM 暂存，实际历史拒绝来自按钮发起的请求，因此没有使用直接旧票 fallback。events 与 project-session renewal 的撤权响应按安全网络记录可见。
- 主路径中的真实网站改密和选择退出后，随后实际绑定隔离邮箱、通过真实 provider 生成并校验的 reset code 完成网页重设，再选择退出其他会话。provider 邮件回调只在本机 fixture 私有内存接收随机码，没有外部邮箱投递；改密和重设退出选择均为真实 202/pending 状态，没有把 `revoking` 说成已完成，也没有伪造 service ACK。provider 目标测试另已验证旧密码拒绝、新密码可登录与另两网站会话/Editor 登录失效。
- 浏览器、stage、fixture、asset child 均关闭，6680–6689 端口空闲。之前 `b8473743` 的后台等待失败、`c8e61862` 的 reset 截图准备失败及其原始证据均保留，没有覆盖或清理。
