# AGENT-v18-semsync：把 0.7.18 各块报告里的语义更正建议核对并落到文档

分支 `claude/v18-semsync`，基底 main `f18e33ef`。只改文档，没改代码和测试，没推送。

做法：先把 19 份报告里「对任务书或语义的更正建议」一节逐条摘出（ports 那份没有这一节），再分五路对着 main 上的代码核对和落文档：Agent 的机制与产品（A1）、云端 Agent 契约（B）、渲染契约与设计与账号契约（C）、工具拆包表与覆盖表（D1）、部署清单（D2），其余由我自己核。每路都读了代码，依据（文件:行）写在第二节表里。

〔裁〕的意思：执行中由会话改的语义，按 `suggested_agent_behavior.md`「对齐」一节要用户合入前审。本次所有改动句末都标了〔裁〕和来源报告。

## 一、结果概览

- 建议共 **71 条**（按「报告名＋第几条」编号；有的条目拆成 a、b 小项，表里分行）。报告里写「本包不需要改」的 4 句不算建议。
- 核对结论：**成立 62 条**（其中 13 条改的是报告、进度或交接文档，3 条改的是通用规矩，9 条是代码或测试问题，这 25 条不属本次修改对象，表里注明；其余 46 条已落到文档或进了对照表）、**部分成立 5 条**（fixes-2、logout-5、runner-4、runner-6、tools-c1-3：现状对一半，另一半被后来合入的块改了）、**已过时 4 条**（assets-4、prod-6、runner-7 的端口名单，v18-ports 合入后写死端口已没有；worker-4 的进度句，真实运行器和 root 入口都已合入）。
- 三级和 `docs/plan/` 下的契约、设计、任务书、部署清单：**直接改了 12 个文件**（见第五节，共约 150 处，每处都标〔裁〕）。
- 二级对照表 **12 条**（第三节），其中明确要用户定的 3 条（A、F1、F2）；另有 7 条二级成分已随契约写进 `docs/plan/`，在第三节末列出，请用户一并审；一级对照表 **3 条**（第四节），都要用户定。
- 顺带查：语义和计划文档里被代码推翻、没有报告提过的句子 **40 条**（已改 18 条）；用词违规 **语义文档 0 处、`docs/plan/` 里 2 处带引号的「冻结」、部署 README 里 5 处**；`glossary.md` 缺的术语 **16 组**（第六节）。
- 基线：`npx tsc -b --force` 退出码 0，零错误；`npm test` 见第八节。

最要紧的几件事：

1. G 包（把八个工具包挂进云端工具表）**没有合进 main**（在 `claude/v18-wire`）。所以网页操作、页面反向通道、采集代下、追踪、一键流程、镜头与主体识别、语音转文字，文档里一律写成「已实现、未挂载」，没有一项写成「已接」。G 合入后，覆盖表整段统一状态和 `mechanism/agent.md` 四处「还没挂载」要回头改。
2. runner-4 说的账号版环境变量（`PROMPTCUT_AGENT_RUN_ASSET_*`、`PROMPTCUT_AGENT_ACCOUNT_LOOK=1`、`PROMPTCUT_AGENT_CONTROL_PORT`）被后来合入的 prod 块推翻：账号版命令行入口设了就拒绝启动，运行素材和看画面改写在 root 入口配置的 `worker.runAssets`、`worker.look`。契约和部署清单按代码写，没照 runner-4。
3. fixes 报告说账号模式 `/v1/usage` 已通，prod 报告说仍回 503。代码上生产主服务没挂用量目录（`server/agent-service/account-master-assembly.mjs` 第 144 行），所以生产上回 503。契约按代码写。要不要让主服务传 `usageDir` 是代码问题，交主会话。
4. 停止最多等 15 秒、任务进程出故障记「失败」这两条 prod 报告自己标了二级〔裁〕，又说产品承诺不用改，说法有出入；已按「用户看得到」放进二级对照表（F1、F2）。

## 二、汇总表（71 条，拆成 86 行）

结论列的「报告类」指建议改的是 `docs/reports/`、`docs/plan/three-versions-progress.md`、`docs/plan/handoff-render-refactor.md` 或通用规矩，不是本次的修改对象，只核对不改。


| 编号 | 原建议一句话 | 级别 | 结论 | 核对依据 | 处置 |
|---|---|---|---|---|---|
| assets-1 | AGENT-018-prep.md 第 1 节「素材隔离」一行改成「成员路径已隔离，还差运行素材的生产接线和渲染两处」 | 报告类 | 成立 | `server/asset-store/project-stores.mjs` 文件头与第 22～31 行（每项目独立库，不从请求体选库）；`server/asset-store/project-{access,revocations,io}.mjs` 存在 | 报告类，不改 |
| assets-2 | three-versions-018-design「素材协议」开头 `storeOf(ns)` 在 admit 之前选全局 store 那句已过时，标成已做 | 计划设计 | 成立 | `server/asset-service.ts:631`（projectStores/projectAccess 必须同时给）、`:690-700`（admit 里 `projectAccess.resolve`→`setAssetContext`）、`:735-737`（`assetContextOf(req)` 取项目库，无上下文才 `storeOf(ns)`）、`server/asset-store/project-stores.mjs:34-40`（目录 `<dir>/projects/<sha256(projectId)>/out/...`） | 已改 该节标题与第一段：写成「已做」并写明现状；同时更正原句里的目录名（原拟 `tenants/<projectId>/assets/…`，实际是 `projects/<sha256>/out/…`，见顺带发现 a-3）；运行素材未接，指到 assets 报告 5.1 |
| assets-3 | mechanism/asset-service.md 补「账号模式每项目一个物理库，同哈希不跨项目去重」 | 三级 | 成立 | `project-stores.mjs` 第 15～22、29 行：`<dir>/projects/<sha256(projectId)>/out/{media,asset-store/snap,asset-store/px}`，注释「同 hash 不跨库复用」 | 已改 `mechanism/asset-service.md`「职责」1 处 |
| assets-4 | 合入的测试写死 6440～6449，偶发名单加这一组 | 通用规矩，不在仓库文档里 | 已过时 | `git grep -n "644[0-9]" server/test` 无命中；v18-ports 已合入（`6ebf017d`，`server/test/free-ports.mjs` 在） | 不改 |
| chores-1 | verification.md「Windows 验证静默运行」补一句守门范围含 scripts/ 全树和 desktop/scripts/ | 开发规则（`guide_files/`，不在三级里） | 成立 | `server/test/windows-hide-silent-spawn.test.mjs` 第 9、38、39 行：范围 server/（不含 server/test）、scripts/ 整树、desktop/scripts/ | 进二级对照表（规则文件由用户把关） |
| fixes-1 | `ACCEPT-018-map.md` 第 1 节第 14 条「同入口 GET 干净 404」的根因没写（读通道把 2xx 当越权掐了连接）；`accountEvents` 里「回 200 加 end」的旧注释已删 | 报告类 | 报告类不改。核对：`server/agent-service/http.mjs:142-150` 现在先 `service.conversation()`，读不到就走统一错误回包（404），不先写 200 流头，注释也讲了这一点 | http.mjs:142-150 | 不改（不属契约）。契约侧的结果落在 newchat-2 |
| fixes-2 | 契约 6.3「成员用 `GET /v1/usage`」账号模式含义补「以文档服务按账号核对出的项目成员为准」 | 三级（`docs/plan`） | **部分成立**。成员含义成立：`conversation-policy.mjs:54-70`（先 `call('identity')`，非成员抛错，只回本项目流水，成员只给显示名，认 `?since=`）；`server/test/agent-account-usage.test.mjs`。**但生产装配里它现在仍回 503**：生产的主服务 `account-master-assembly.mjs:144` 建服务对象时没传 `usageDir`；只有进程内装配执行器那一路（`account-runner.mjs:539-540`）传了。`AGENT-v18-prod.md` 更正建议第 4 条也写「第 13 条（`/v1/usage` 回 503）没变」，fixes 与 prod 的结论合起来才对 | 上列文件行 | 已改 契约 6.3 新增一条；第 29.4 节再指一次 |
| logout-1 | AGENT-018-prep.md 第 1 节第 6 条「各服务逐个确认没接」改为「文档服务把它们串起来的那一段缺，渲染没有确认方」 | 报告类 | 成立，且缺口已补 | `server/account/logout-confirmer.mjs`、`server/hosted/combo.mjs` 第 366～380 行 | 报告类，不改 |
| logout-2 | 补退出确认机制；产品里补「全部确认以后才显示已退出」 | 三级 + 二级 | 机制部分成立；承诺部分 `product/` 里没有 | `logout-confirmer.mjs` 全文；`agent-read-control.mjs` 第 24 行 `accessEventRunClosure`；`combo.mjs` 第 371～380 行（`attestedServices`、`pollMs: account.logoutConfirmPollMs ?? 1000`）。在 `docs/semantics` 里搜「已退出」「正在退出」，product/ 无命中 | 机制已改 `mechanism/document-service.md`（1 处新增、1 处改一句）；承诺进二级对照表。VisuHive 一侧的显示条件（`logout.state === 'complete'`）在另一个仓库，本次没核 |
| logout-3 | three-versions-progress.md「退出仍等全部服务确认」改成确认链已在本机跑通 | 进度文档（主会话维护） | 成立 | 同 logout-2；该文件第 20 行仍写「退出仍等全部服务确认」 | 报告类，不改，交主会话 |
| logout-4 | 真实网络验收里「改密退出」一条要写明网页从「正在退出」变成「已退出」，且素材服务停着时不变 | 三级（plan）；页面上的字是一级、见下 | 成立（核对过：素材服务停着时确实不变成已退出）；原清单里没有「改密退出」这一条，是新增 | 代码：`server/account/logout-confirmer.mjs` 第 96～97 行，`pendingServices` 非空就只记诊断、不 `seal`；素材一项由素材服务自己读事件后确认（该文件头第 6 行）；`combo.mjs` 第 376～378 行：渲染一项由文档服务代登记，Agent 一项在没配 Agent 时代登记、配了就必须等真收口。测试：`AGENT-v18-logout.md` 第 87 行与第 95 行的集成测试「素材服务没确认」（停着时 10 次读状态都是进行中；重起后办完）。VisuHive 一侧的代码不在本仓库，未读；以 logout 报告与 PromptCut 这一半代码为准。网页只在 `logout.state === 'complete'` 时显示已退出（报告第 20 行附近、接口 `GET /api/account/password-events/<事件号>` 在两支探针里用到） | 已改：D0 的 C3 之后新增一条，C5 之后新增一条（Agent 配上后再做一遍）。写的是接口 `logout.state` 为 `revoking`→`complete`，页面字样只写「一类的字」，因为字没定稿（一级，见下）；加了「用 `systemctl stop` 正常停、不要 `kill -9`」（硬结束后能否重起没在 Linux 上验过，logout 报告「没做成的」第 3 条）；加了部署次序（先部署文档服务并核对，再推 VisuHive 网页改字）和第一次集中补办旧退出的提示（logout 报告「要主会话注意的」第 2、3 条） |
| logout-5 | account-binding-contract「跨服务操作」里「隔离通道及进程身份方案尚待选定」之类已经定下来的地方，要逐句核 | 计划契约 | 部分成立，逐句结论见下 | 见下「logout-5 逐句」 | 已改 3 处 + 顺带 2 处 |
| newchat-1 | 一级 `workflow/production.md` 与二级 `product/agent.md` 可补一句：新开、还没发过消息的云端对话是安静的空对话，不显示断线提示、不后台重试；发出第一条消息后才连事件流。（同一条报告里的第 2 点「契约补 404 `no-conversation`」不归我） | 一级 + 二级；机制三级 | 成立 | `src/ai/cloud/session.ts:58-62,79-83`（`isAbsent`、`fresh`、`known`）、`useCloud.ts:72-73,272-273,297,384,434-440`（`pc.cloudFresh:` 键、`open(id, { fresh })`）；`server/account/conversation-authority.mjs:38`（`fail(404, 'no-conversation')`） | 机制已改：新增块「新对话的空对话」（3 条）。承诺进二级对照表 E，一级进一级对照表 1 |
| newchat-2 | 契约补：账号模式下事件流对不存在或不可读的对话回 404 `no-conversation`（不是 200 加结束事件），页面按「是不是页面刚建的新对话」分辨 | 三级 | 成立。错误码已核：`conversation-authority.mjs:35,38,76` 抛 404 `no-conversation`，经 `conversation-policy.mjs` 的 `translated()` 与 `http.mjs:142-146` 原样回包 `{ ok:false, code:'no-conversation' }`；`src/ai/cloud/session.ts:58-62` 的 `isAbsent` 按 `fresh && !known` 分辨。注意 `http.mjs:146` 还有一行 `if (!view) return … 'not-found'`，读通道正常时走不到 | 同上 | 已改 契约 2.4 新增一条 |
| newchat-3 | AGENT-v18-chats.md 第 140、144 行的待办可以关 | 报告类 | 成立 | `src/ai/cloud/session.ts` 第 58～62 行 | 报告类，不改 |
| prod-1a | C5 现在全是旧模式（PM2、服务私钥、`deploy-agent`），账号版另起一节，照 README 新加那一节的九步 | 三级（plan 部署清单） | 成立 | 清单原 C5 全部是 `deploy-agent`/`keygen-agent`/`status-agent`（PM2）；README `server/hosted/deploy/README.md` 第 236～315 行有九步；`scripts/remote/docservice.mjs` 的 `deploy-agent` 是旧模式（prod 报告「没做成的」第 9 条）。九步里的脚本名、参数、日志词、环境变量名、路径逐个对过：`account-task-unit.mjs` 参数表（该文件 `parseTaskUnitArguments`）、`account-root-main.mjs` 的 `--config/--bootstrap/--status`（第 51～53 行）与 `root.slot.bootstrap`（第 144 行）、`root.ready`（第 165 行）、`agent.master.pending/registered`（`account-master-assembly.mjs` 第 82、86 行）、`agent.ready` 的 `taskProcesses`（`main.mjs` 第 444 行）、`/healthz` 的 `taskProcesses/scheduler`（`http.mjs` 第 288 行）、`config.error account-task-processes`（`main.mjs` 第 374 行）、`agent-run-scopes`（`server/hosted/main.mjs` 第 212 行）、`root-code-untrusted`（`account-root-code-trust.mjs`）、三张 example 文件的键名 | 已改：新增 C5b（账号版）；C5 标题标「旧模式」并加一句指向 C5b；文首加 2026-10-13 补记；先决条件第 4 条加账号版核对办法（`/healthz` 的 `codeVersion`，因为 `status-agent` 看 PM2） |
| prod-1b | B 节加「节点重启后任务槽要重新初始化」 | 三级 | 成立 | `server/hosted/deploy/agent-run-scope-publisher.mjs` 第 109 行 `failScope('boot-transition')`，`agent-run-scope-schema.mjs` 第 7 行拼成 `agent-scope-boot-transition`；README 第 314 行；prod 报告「没做成的」第 4 条与「要用户定的事」第 3 条（要不要改成自动接上，用户待定，已写进条文） | 已改：新增 B6；C4 第 6 步（真重启节点）加一句指向 B6；F 节已知坑加一句 |
| prod-1c | E 节加回退办法：停 root 入口、文档服务去掉任务槽配置 | 三级 | 成立 | README 第 315 行；`server/hosted/main.mjs` 第 205～212 行（不设 `PROMPTCUT_DOC_AGENT_RUN_SCOPES_FILE` 就是不开此模式） | 已改：E 表新增「账号版 Agent 服务（C5b）」一行，原 C5 行标「旧模式」 |
| prod-1d | 第 5 步「先用模拟模型验」的 `set-key.mjs --mock` 要把数据目录指到共用目录 | 三级 | 成立 | README 第 282、298 行；任务进程读模型配置是 `readModelConfig(settings.modelConfigDir ?? settings.dataDir)`（`account-task-worker-config.mjs` 第 118 行附近），`dataDir` 是共用数据目录；`set-key.mjs` 读 `PROMPTCUT_AGENT_DATA`（第 107 行） | 已改：C5b 第 9 步写共用数据目录；旧 C5 第 5 步不动（旧模式数据目录仍是 `/var/lib/promptcut/agent`）；D1 的 C7 额度一行和 E 表的 `--clear` 同步写共用目录 |
| prod-2 | 环境变量表加账号版三样、去掉账号版的 `PROMPTCUT_AGENT_CONTROL_PORT`；内部口两条调度接口、任务进程指令口四条；`/healthz` 两个新字段；`POST …/attachments` 账号模式可用 | 三级 | 成立（逐项已核）。三样：`main.mjs:131-150`（`accountTaskProcessConfig`）。旧路变量拒绝：`main.mjs:137-141`（CONTROL_PORT、RUN_ASSET_*、ACCOUNT_LOOK=1）。内部口路径：`account-master-scheduler-client.mjs:12-13`、`worker-event-internal.mjs:5`、`account-master-assembly.mjs:151-180`（403 `master-scheduler-forbidden`、64 KiB 413）。指令口四条与三个请求头：`account-worker-control-client.mjs:5-8,32`。healthz：`http.mjs:281-288`（`taskProcesses`、`scheduler`）；`service.look` 在主服务恒 false（`account-master-assembly.mjs:150-152`）。附件：`account-master-assembly.mjs:191-214`、`http.mjs:262-268`。**契约原来根本没有 `PROMPTCUT_AGENT_CONTROL_PORT`，所以「去掉」无处可去**，改成在 29.1 写明账号版不再接它 | 同上 | 已改 契约 2.2（SECRETS 行加账号模式说明，新增一行三样）、2.3（healthz 行、`attachments` 字段行、请求体上限行）、9.4（账号模式附件）、20（第一条加「旧模式」限定）、新增 29.1、29.2、29.4 |
| prod-3 | `mechanism/agent.md` 补「主服务只做控制、任务在任务槽进程里跑、root 入口开关进程」和「放弃结算而没人来强制关的任务记失败」；`product/agent.md` 承诺不用改 | 三级（机制）；其中「停止最多等 15 秒」「放弃结算记失败」报告自己标了二级〔裁〕 | 成立 | `server/agent-service/main.mjs:20-33,129-153`（三样环境变量、旧路变量拒绝、`config.error` 的 `account-task-processes`）；`account-master-assembly.mjs:53`（`stopWaitMs = 15_000`、`schedulerStaleMs = 15_000`）、`:180-190`（`abort` 等到期限）、`:216-217`（`executorMounted`、`taskProcesses`）；`account-slot-scheduler.mjs:18-30,203-206`（放弃分两种，`slot.settlement.abandoned.failing`）；`account-root-main.mjs:19-22,49-59`（`--bootstrap`/`--status`、仅 Linux root）；`account-root-code-trust.mjs:11`（`root-code-untrusted`）；`http.mjs:288`（`/healthz` 的 `taskProcesses`、`scheduler`）；`server/hosted/deploy/systemd-promptcut-agent-root.service:27`（`Restart=always`） | 已改 `mechanism/agent.md`「云端 Agent」节新增块「账号模式的进程分工」（12 条）。承诺层面（停止的等待、失败结果）进二级对照表 F1、F2，标「进度文件待用户项」 |
| prod-4 | ACCEPT-018-map.md 第 1 节第 2、3、11 条的判据改 | 报告类 | 成立（提交 `3bb3d164`、`93aee316` 已把那条静态检查和两条 todo 改了） | `git log` 两个提交 | 报告类，不改 |
| prod-5 | worker、runner 报告「没做成的」里 root 入口、主服务装配、放弃结算几条改成指向 prod 报告 | 报告类 | 成立 | 同上；`server/agent-service/account-root-main.mjs`、`account-master-assembly.mjs` 在 main | 报告类，不改 |
| prod-6 | 偶发名单加 ai-visual-shared，注明 account-runner-process 端口写死 2822x | 通用规矩 | 已过时（端口部分） | `grep -n "2822" server/test/account-runner-process.test.mjs` 无命中，用夹具；v18-ports 已合入 | 不改 |
| queue-1a | `hosted-render-contract.md` 第 4 节「争用并发」那一段和引文：排满回忙、背压回忙、每请求 60 秒 → 排着等、渲染每次一分钟重试三次、排队上限 30 分钟 | 计划契约（三级内容） | 成立 | `look.mjs:35-97`（`LOOK_DEFAULTS`：attemptMs 60000、retries 3、maxQueueMs 30*60000）、`look.mjs:276-300`（`routeOnce` 的 wait 原因）、`render-requests.mjs:33`（maxQueued 64） | 已改 hosted-render-contract 第 4 节（表里「看画面」行、2026-10-08 对齐段的末两句、争用一条、引文）；把时限、重试、排队上限的细节集中写进第 8a 节新增的「排队、重试、时限」，第 4 节只留指向 |
| queue-1b | 第 7.5 节：60 秒闲置回收 → 五分钟；看画面「保持 90 秒」→ 15 秒；「45 秒就轮换」→ 取消；原〔历史机制/待协调〕标记可改成已落实 | 同上 | 成立 | `isolation.mjs:27-41`（IDLE_MS 5 分钟、SLICE_MS 5 分钟）、`isolation.mjs:207-216`（空闲满才让位；有人等着看画面不缩短）、`look.mjs:89`（holdMs 15000） | 已改 第 7.5 节两条 bullet（去掉〔历史机制/待协调〕，写成现状）；文首映射表里该行同步改；「实现记录」里 2026-10-07 那一节加一行说明「45 秒轮换」等已被取代，节内原文不动 |
| queue-1c | 第 8a 节：接口加 `requestId`、`POST /look/poll`、`POST /look/cancel`、202 回包 | 同上 | 成立，另有两处与报告不同（见下） | `look.mjs:440-527`（`handle`/`poll`/`cancel`）、`look.mjs:205-208`（202 回包字段：`requestId, state, queuePosition, attempts, blockedReason?`） | 已改 第 8a 节「接口」块与其下 bullet |
| queue-1d | 原因码表：`busy` 只在登记到硬上限；`iso-busy`/`not-ready` 只在排队等到头；加 `cancelled` | 同上 | 成立，补一处 | `look.mjs:483`（`added.full` → 503 `busy`）、`look.mjs:328-333`（`waitedOut`：iso-other-project→`iso-busy`，not-ready→`not-ready`，其余→`timeout`）、`look.mjs:196`、`look.mjs:380`（499 `cancelled`） | 已改 第 8a 节原因码表：`busy` 改成 64 个硬上限；`not-ready`、`iso-busy` 拆行；`timeout` 补「排到头而最后在等别的原因也回它」；加 `cancelled` 行 |
| queue-1e | 环境变量表：`PROMPTCUT_RENDER_ISO_IDLE_MS` 缺省 60000→300000；加 `PROMPTCUT_RENDER_LOOK_QUEUE` 和四个测试用时限变量 | 同上 | 成立 | `main.mjs:104-105`（isoIdleMs 缺省 `ISOLATION_DEFAULTS.IDLE_MS`=300000）、`main.mjs:125-130`（lookQueueDir 与四个时限变量）、`main.mjs:475`（`config.look==='on'` 才落盘） | 已改 第 7.2 节表：改一行、加两行 |
| queue-1f | 状态口 `look` 多了 `queue`、`retried`、`over5min` | 同上 | 成立 | `look.mjs:231,534-540`（`status()`）、`render-requests.mjs:270-281`（`stats()`：persistent、queued、running、kept、oldestWaitMs、blocked、累计计数） | 已改 第 7.1 节诊断段 `look` 条后追加 |
| queue-2 | 第 25 节实现记录里看画面工具单次时限 180 秒 → 35 分钟兜底 `LOOK_QUEUE_TOOL_MS`，`lookToolMs` 只剩 `collect_search` | 三级 | 成立。`instance.mjs:35`（`LOOK_QUEUE_TOOL_MS = 35 * 60_000`）、`1570-1574`（`isQueuedLook` 用它，`isLook` 非排队的才用 `lookToolMs`）、`cloud-tools.mjs:118`（`CLOUD_SLOW_TOOLS = render_card_audio, collect_search`，前者属排队类）、`create-agent-service.mjs:53,626`。渲染服务一侧数字：`look.mjs:78-92`（重试 3、排队上限 30 分钟、`holdMs` 15 秒）、`isolation.mjs:32`（`IDLE_MS` 五分钟） | 同上 | 已改 契约 25.3 一行；**同一件事在 9.8「时限与没看成」也写着 180 秒，一并改了**；25.6 第 2、3 条（90 秒、「约三分钟/一分钟」）、25.3「45 秒轮换」一行、25.7 一条（45 秒轮换）也是被排队块推翻的旧数，顺手改了（标〔裁〕，仅限与 queue 条目直接相关） |
| queue-3 | three-versions-018-design「渲染容量排队与Agent优先」：拟接口按〔裁〕第 11 条改（POST 三条而不是 GET /requests/<id> 加事件；绑登记它的 Agent 服务实例而不是某轮授权）；「look-client 支持此 202 握手」已做 | 计划设计 | 成立 | `look.mjs:440-527`、`render-requests.mjs:150-170`（`owner` = 签名里的 `d`）、`server/agent-service/look-client.mjs:41-49,125,163`（poll 20 秒、退避、五分钟放弃、202 握手） | 已改 该节标题与第一段；文首「调度补充的设计边界」表里 202 行与 10-09 一句；实施包表里 `018-render-capacity` 行加注 |
| queue-4（我的一半） | `product/agent.md` 第 22 行「整个过程低于五分钟的目标不变」和「空闲满五分钟才让位」在跨项目时对不上（任务书那一半归别人） | 二级 | 成立，且是用户还没定的事 | `server/hosted-render/isolation.mjs`/`main.mjs:29,104`（`PROMPTCUT_RENDER_ISO_IDLE_MS` 缺省 300000）；`look.mjs:69-94`（`attemptMs 60000`、`retries 3`、`maxQueueMs 30*60000`、`holdMs 15000`）；报告探针实测乙 5 分 36 秒；`three-versions-progress.md:91` 把它列为待用户项（建议「五分钟内」只指同一项目内） | 不改。进二级对照表 A，标「要用户定」，给出按建议（a）写的措辞 |
| queue-4（任务书半） | `account-binding-task.md`「即时渲染卡住」一行写「低于五分钟的目标」，与「空闲满五分钟才让位」跨项目对不上 → 任务书里把真实情形写准 | 计划任务书 | 成立 | 报告探针数字：甲-2 0.98 秒（同项目）、甲-1 12.8 秒与丙 10.8 秒（冷启动首帧）、乙-1 335.7 秒、另一遍 353.1 秒；用户段记 5 分 36 秒与 5 分 53 秒；代码 `isolation.mjs:207-208` | 已改 account-binding-task 该行，在「整个过程低于五分钟的目标不变」之后加一段〔裁〕：同项目内约 1 秒、冷启动首帧十几秒，跨项目 5 分 36 秒与 5 分 53 秒，前面排着两个项目十分钟以上，排队上限 30 分钟；跨项目这一段与「空闲满五分钟才让位」不能同时成立，选项指到报告「要用户定的事」第 1 条。该行用户原话没动 |
| queue-4（agent.md 半） | `product/agent.md` 第 22 行同上 | 二级 | 归 A1 | 见下「二级对照表」第 1 行（供 A1 对齐，不是我的修改对象） | 不改 |
| queue-5 | `mechanism/agent.md` 「单次工具 60 秒」：看画面的工具不再是 60 秒，补一句「向渲染服务要画面的工具由渲染服务的排队与重试决定时限」 | 三级 | 成立，报告的数字要更正：不是 180 秒也不是只剩 `collect_search` 用 `lookToolMs`——看画面类现在是 35 分钟兜底，`lookToolMs`（180 秒）仍是 `collect_search` 的时限 | `instance.mjs:35`（`LOOK_QUEUE_TOOL_MS = 35*60_000`）、`:1568-1574`（`isQueuedLook` = `CLOUD_LOOK_TOOLS` + `get_layout` + `render_card_audio`）；`cloud-tools.mjs:112,118`（`CLOUD_LOOK_TOOLS` 是四个 `look: true`：`bake_card`、`inspect_card_dom`、`see_frames`、`get_gif`；`CLOUD_SLOW_TOOLS = render_card_audio, collect_search`）；`create-agent-service.mjs:51,53` | 已改 `mechanism/agent.md`「闸与上限」资源上限那一条：补看画面类工具的时限、`collect_search` 的 180 秒、账号模式下的并发与内存口径 |
| runner-1 | three-versions-progress.md 记「块一的结算链此前没走过生产装配」 | 进度文档 | 成立（历史事实） | AGENT-v18-runner.md 上文 A | 报告类，不改，交主会话 |
| runner-2 | AGENT-v18-assets.md 5.1 补三处 | 报告类 | 不属文档 | — | 不改 |
| runner-3 | queue 报告「账号模式没接看画面」：Agent 侧已接，渲染服务侧还没有 | 报告类 | 成立 | `server/agent-service/main.mjs` 文件头第 27、41 行（账号版看画面配置改由 root 入口配置下发）；`server/hosted-render/look.mjs` 第 464～472 行只校验请求体里 `run` 的形状（三个字段）并带进日志、排队记录（`render-requests.mjs` 第 140 行），不向文档服务核授权 | 报告类，不改 |
| runner-4（契约一半） | `POST /look` 请求体加可选 `run`；账号模式环境变量表加 `PROMPTCUT_AGENT_RUN_ASSET_ORIGIN / _FINGERPRINT256 / _MAX_IMPORT_BYTES`、`PROMPTCUT_AGENT_ACCOUNT_LOOK`；`PROMPTCUT_AGENT_LOOK_URL` 与 `PROMPTCUT_AGENT_SECRETS` 在账号模式的含义；任务进程设置文件 | 三级 | **部分已过时**，与 prod-2 互相矛盾，并在一起写。`run`、设置文件成立：`look.mjs:464-472`、`look-client.mjs:242`、`account-task-worker-config.mjs:1-110`。**但四个环境变量 RUN_ASSET_*、ACCOUNT_LOOK=1 在账号版命令行入口已被 prod 块禁掉（设了就拒绝启动）**，全仓库只剩拒绝它们的那段代码在读；运行素材改写进设置文件的 `runAssets`，看画面写进 `look`，由 root 入口配置的 `worker.look` / `worker.runAssets` 下发（`account-root-slots.mjs:34-45`）。`ACCOUNT_LOOK` 现在只认 0（1 被拒），`resolveAccountLook()`（`main.mjs:112-123`）只留给进程内装配的调用方。`PROMPTCUT_AGENT_LOOK_URL` 账号版仍会解析（不合法回 `look-url`）但被忽略（`main.mjs:337,407`）；`PROMPTCUT_AGENT_SECRETS` 命令行入口不读，看画面私钥由任务进程按 `look.keyDir` 读 | 同上 | 已改 契约 9.8（`/look` 请求体多 `requestId?`、`run?`）、9.9 看画面行、9.1（账号模式看任务进程设置的 `look`）、新增 29.1、29.3、29.5。**没有照 runner-4 把四个环境变量加进表里** |
| runner-4（渲染半） | 第 8a 节 `POST /look` 请求体加可选 `run` | 计划契约 | 成立 | `look.mjs:462-473`（形状：恰好 `conversationId,runGrantId,runId`，各 1～128 位，`RUN_REF_RE` 在 `:123`）、`render-requests.mjs:155-166`（记在请求上，不核）、`look-client.mjs:117-125,233-239` | 已改 第 8a 节接口 bullet 加 `run`；同时写明渲染服务不向文档服务核它、渲染服务一侧核任务授权没做 |
| runner-4（cloud-agent-contract 半） | 同上，环境变量表等 | — | 归 B | — | 不改 |
| runner-5 | 机制说明里加「对话的模型历史和工作目录放在各代共用的数据目录里」「素材几个工具在账号模式凭任务授权读写、不借成员票据」；产品那一本不用改 | 三级 | 成立 | `account-task-worker-config.mjs:15-30,62-70`（`dataDir` 各代共用、`stateDir` 每代自己、`look`、`runAssets` 形状）；`account-root-slots.mjs:34-45`（root 配置的 `worker.dataDir/stateRoot/look/runAssets`）；`account-executor-assembly.mjs:21,43-49,108`（`runAssets` 配置与传输）；`hosted-tools.mjs:345`（导入遇 503 最多三次）；`run-asset-transport.mjs:53`（缺省 5000 毫秒）；`look-client.mjs:53,138-147,230-242`（授权闸、问三次、`run` 随请求） | 已改 `mechanism/agent.md`：同一块里「数据目录两份」「素材工具凭任务授权」「看画面凭运行授权」三条；「Key 与模型」补一条账号模式下模型配置放共用数据目录（依据 `server/hosted/deploy/README.md` 第 282 行） |
| runner-6a | Agent 服务那一步加任务进程的设置文件 | 三级 | 成立 | `account-task-worker-config.mjs` 文件头与 `validateWorkerSettings`；`account-root-slots.mjs` 的 `workerSettingsFor`（第 85～98 行）；README 第 272 行 | 已改：C5b「可选」一段写明设置文件位置、谁写、权限、形状在哪看 |
| runner-6b | 加共用数据目录与每代状态目录 | 三级 | 成立 | README 第 276～277 行；`workerSettingsFor` 里 `stateDir=<stateRoot>/<槽>/epoch-<n>/state`、`journalFile`；`account-task-worker-config.mjs` 对 `dataDir`/`stateDir` `mkdirSync(…0o700)` 并核可写 | 已改：C5b 第 1 步（目录与属主权限）、第 4 步（`worker.dataDir` 要与主服务的 `PROMPTCUT_AGENT_SHARED_DATA` 同一个）、「要留意的」（状态目录不自动清）；C5 第 7 步导入 Key 加共用数据目录与任务用户读得到 `config/` |
| runner-6c | 看画面的私钥谁读得到 | 三级（私钥归属是否收紧是用户待定，不改文档的承诺） | 成立，且有两处与报告写法不同 | `account-task-worker-config.mjs` 第 98～102 行（`look = {url,keyDir}`，`readServiceKeyFile`，服务名必须 `agent`，读不到就拒绝启动 `account-worker-settings-look-key`）；`server/auth/service-identity.mjs` 第 317 行（权限宽于 0600 就拒）→ 只能属主读 → 属主只能是任务用户，每个任务进程都读得到；`main.mjs` 第 137～138 行：账号版主服务设了 `PROMPTCUT_AGENT_ACCOUNT_LOOK=1` 直接拒绝启动；渲染服务一侧 `git grep -i account -- server/hosted-render` 无账号相关命中，runner 报告「没做成的」一半仍成立 | 已改：C5b「可选」写明 `worker.look` 的形状、权限要求、谁读得到、用户待定的甲乙选项指向；C5 第 8 步表第 2 行（看画面）整行重写：渲染服务才有浏览器，Agent 一侧只要回环地址和一把私钥（原来写「复用 C4 的 chrome-headless-shell 缓存目录」已被 README 第 147 行与 `look-client.mjs` 推翻） |
| runner-6d | 运行素材的两个环境变量 | 三级 | 已过时（改写） | 报告说的是 `main.mjs` 账号模式的 `PROMPTCUT_AGENT_RUN_ASSET_ORIGIN/_FINGERPRINT256`；prod 合入后命令行入口不再接，设了拒绝启动（`main.mjs` 第 137～138 行 `legacy` 列表）；现在运行素材写在 root 入口配置的 `worker.runAssets`（`account-root-slots.mjs` 文件头、`account-task-worker-config.mjs` 第 61～66 行），两侧另有开关：文档服务 `PROMPTCUT_DOC_RUN_ASSETS_ENABLED` 一组（`server/hosted/main.mjs` 第 216～231 行）、素材服务 `PROMPTCUT_ASSET_RUN_ENABLED` 一组（`server/hosted/asset-main.mjs` 第 22～47 行）；`account-v2-install-plan.mjs`/`account-v2-config.mjs` 里 `git grep` 不到这些变量；根登记第二版 `rootProtocol: 'v2'` 无人传入（`git grep rootProtocol -- server/hosted` 只有 `asset-runtime.mjs` 内部判断） | 已改：C5b「可选」写明 `worker.runAssets` 形状、两侧开关的变量名、旧变量不再认；取值和 root 登记目录初始化写「待部署时核对」，并写明账号版安装计划不生成、节点上还没有部署办法 |
| runner-7 | 偶发名单加 account-runner-process.test.mjs 及端口 | 通用规矩 | 已过时 | 同 prod-6 | 不改 |
| spawn-语义 | 语义文档没有要改的；建议在 `mechanism/agent.md` 补一句「云端 Agent 服务起的子进程是进程树，取消按树杀并等到 exit + close；Python 一律隔离模式起，包目录只来自部署配置」 | 三级 | 成立 | `server/agent/service/perception/runner.mjs:44,83,112,136,228,234,241,250`（`spawnTree`、`killTree`、`whenClosed`、`PYTHON_ISOLATED_FLAGS = ['-I','-X','utf8','-u','-B']`、`PYTHON_BOOTSTRAP`、`isolatedPythonArgs`、`splitRoots`）；`git grep isolatedPythonArgs` 命中 `hosted-collect.mjs:84`、`perception/shots.mjs:205`、`stt.mjs:163`、`subject.mjs`；配置来源 `stt` 的 `runtime.sourceRoot` 等与报告第 1.3 节一致 | 已改 `mechanism/agent.md`：新增块「云端子进程」（3 条，写得比建议的一句话细：Windows/Linux 的杀法、扫组、登记被拒的处理、命令行形状、包目录来源、pip 带 `-I`） |
| spawn-拆包表 | 拆包表里 `perception/runner.mjs` 那一格现在有了实物，把说明对上 | 三级（plan） | 成立，并更正：runner.mjs 不属于 P1 独占 | `server/agent/service/perception/runner.mjs` 导出 `spawnTree/killTree/whenClosed/treeResource/superviseChild/groupAlive/isolatedPythonArgs/splitRoots`；被 `workspace.mjs:27`、`hosted-collect.mjs:32`、`web/hosted/session.mjs:29` 和 stt/subject/track 使用（`git grep` 命中） | 已改拆包表 P1 行第 2 列（写成公共实现，列出使用者）〔裁〕 |
| tools-c1-1 | C1 行补：回执是反向通道一次请求的答案，下载过程用开始、轮询、取消三种短请求；注明 `result` 的形状；本机 `vite-plugin-collect.ts`／`collectLoginStore.ts` 这次没有扩展 | 三级（plan） | 成立 | `collect-bridge.mjs:36`（`COLLECT_PAGE_TOOLS` 含 `collect_delegate_start/poll/cancel`）、`:38-52`（`pollMs` 2000、`delegateMs` 15 分钟）、`:97-115`（`result` 校验：`items[]` 键 `assetRef,name,kind,title?,duration?,width?,height?,vcodec?`，`cookiesUsed?`）；`git log` 查 `server/vite-plugin-collect.ts`、`src/ai/collectLoginStore.ts` 最近的提交都早于 C1 的提交，没有被 C1 改动 | 已改拆包表 C1 行第 2、3 列〔裁〕。附带写明“有登录支持的站点现在只有哔哩哔哩”（`server/collect-cookies.mjs:24`）、状态“已合入，未挂载（宿主没有给 `collect_download` 委托口子）”（`hosted-tools.mjs` 无 `delegate`） |
| tools-c1-2 | 9.4d「登录态」那一条与 28.3 `collect_login` 两行写的是「用不到它」「尚未桥接」，接线后改成 2.1 节的做法；作业表补 `route` 字段 | 三级 | **成立，但接线没有做**：`git grep` 显示 `createCollectBridge` 在 `server/`、`src/` 下只被它自己的文件和测试引用；`hosted-tools.mjs`、`instance.mjs`、`create-agent-service.mjs`、`account-runner.mjs` 都没有 `delegate`、`collect_login`（grep 无命中）。`hosted-collect.mjs:164,382-406` 的 `route` 是真的 | 同上 | 已改 契约 9.2 collect 行与 9.4d（新增「发起人电脑代下」一条，开头写明「已实现、未挂载」；作业表补 `route`）、28.3 两行、首部「发起人本机工具口径更正」一句、新增 28.8 末条 |
| tools-c1-3 | 接线后在 `product/agent.md`「工具范围」补一句：素材采集遇到要登录的站点，发起人在线且用桌面版时由他的电脑代下并直接传进项目素材库，登录信息不离开电脑；否则按未登录画质 | 二级 | 部分成立 | 这句承诺的大半已经在 `product/agent.md` 第 46 行（「需要登录态时由发起人的电脑代下……代下失败或发起人离线时退回匿名，不上传登录信息」）。该行末尾「上述登录态代下目标尚未桥接到现有实现」已过时：`collect-bridge.mjs`、`src/ai/cloud/collectBridge.ts`、`hosted-collect.mjs` 的委托分流都在 main，只是没挂载（见开头第一条事实） | 进二级对照表 B（改的是第 46 行那一句的现状部分，并补「只有桌面版在线发起人能代下、网页版发起人退回匿名」）。机制侧写进新增块「本机采集代下」 |
| tools-c1-4 | `mechanism/agent.md` 反向通道那一条补「别的工具包可以经 `extraTools` 在这条通道上加请求，绑定与重核不变」 | 三级 | 成立 | `server/agent/service/page-bridge.mjs:128-138`（`checkedExtraTools`：名字格式、不得与 `PAGE_BRIDGE_TOOLS` 重、`args` 必须是函数、`answer` 可选）、`:244,597`（参数与返回的 `extraTools`）、`:31`（`PAGE_BRIDGE_TOOLS = ['seek','play','pause','web_handoff']`）；`collect-bridge.mjs:25,35-36,119` | 已改 `mechanism/agent.md`「对话的状态」里反向通道后新增一条（`extraTools`） |
| tools-c1-5 | W2 的 page-requests.test.mjs CAU-ACC-07 按名字搜引用，G 包接线时改成只认 import | 测试问题 | 未核（接线未做） | — | 不改，交主会话 |
| tools-p1-1 | P1 行把 scdet 写成主线、TransNetV2 写成“有依赖再验”，与桌面现行顺序相反；改成“模型档就绪用模型，否则 scdet”，两档都要真跑 | 三级（plan） | 成立 | `perception/shots.mjs`（`engine`、`fellBackFrom`、`SHOTS_DEFAULTS.maxModelFrames`）；`server/tools/ai.mjs:3` 描述：装了拓展用 TransNetV2、没装退 ffmpeg scdet；报告里两档真跑的值（scdet 0.000 秒，TransNetV2 0.040 秒） | 已改拆包表 P1 行第 3 列。同时更正同一行里另三处与代码不符的写法：`createMediaFramesTools`、`hosted-media-frames.mjs`、`media-sheet.mjs` 没做（`ls` 无这些文件），素材拼图那一半留待渲染重构；转场缩略图云端不做；`list_shots` 由本包自己答 |
| tools-p1-2 | `ToolJobs` 没有放文字原因的字段，也没有按入参找作业的接口，建议 F0 补 `latest(context, kind, key)` 与受限长度的 `message` 字段 | 三级（代码建议） | 代码问题不是文档问题；建议所指现状仍成立 | `tool-jobs.mjs`：`decodeRow` 无 `message`，`checkedPatch` 允许键仅 `state,stage,progress,outputRefs,errorCode`（第 79 行附近）；公开 API 只有 `start/update/checkpointRetained/get/cancelForFence/close`，无 `latest`；`git grep "latest("` 在 `tool-jobs.mjs` 无命中 | 不改代码。拆包表按现状描述了账本字段与“没有自由文字原因字段、没有按入参找作业的查询”，并写明各包把中文原因和索引放在对话工作区 `<包名>/jobs.json`（见接口一节“jobId”段）〔裁〕 |
| tools-p1-3 | 覆盖表 `detect_shots`、`list_shots` 的“还差”栏，在 G 包接线并验过后才能改；现在的状态是“实现与测试完成，未挂载” | 三级（plan） | 成立；G 包未合入，不能写成已接 | 上面“统一的事实底座”；`cloud-tools.mjs:70` 仍 `pending`，`list_shots` 仍 `route` | 已改覆盖表 `detect_shots` 行：写“已实现、未挂载”，列云端实现、测试、未验边界；`list_shots` 无独立行，并入该行说明 |
| tools-p2-1 | P2 行写“Python CLI 可复用”，实际 status/transcribe 要加离线与权重清单、install 要加 `--requirements` 才满足“云端不联网下载、只装锁定依赖”，已做了，表里可补一句 | 三级（plan） | 成立 | `python/promptcut_stt/__main__.py`（`available_models`、`--requirements`、`--offline`，grep 命中）；`stt.mjs:34-57` `STT_DEFAULTS`、`:339-360` 安装分支；`cloud-tools-p2-stt*.test.mjs` | 已改拆包表 P2 行第 3 列；覆盖表 `stt_status`／`stt_install`／`transcribe_media` 三行同步〔裁〕 |
| tools-p2-2 | `server/tools/ai.mjs` 里这三个工具的 `side` 是 `page`；G 包翻开关时注意描述里“写入项目 store”“用 stt_status 轮询”的措辞在云端依然成立（`installed` 字段保留） | 三级（G 接线时的注意事项） | 成立（措辞仍在，字段仍在），不是文档问题 | `server/tools/ai.mjs:139-170`：`stt_status`、`stt_install`、`transcribe_media` 均 `side: "page"`，描述含“结果写入项目 store”“用 stt_status 轮询，直到 installed=true”；`stt.mjs:248,265,344,360` 云端 `installed`、`installRunning`、提示文字保留 | 不改文档（这是 G 接线时对工具定义的注意事项，不属于这两份文档的任何一格）。附带的代码侧小差：`transcribe_media` 描述说引擎枚举含 `whisper`，云端 `STT_DEFAULTS.engines` 缺省只有 `faster-whisper`（部署者可调），模型传 `whisper` 会被云端按节点配置拒；见“拿不准”第 3 条 |
| tools-p2-3 | 桌面 `--language` 缺省 `zh` 与工具描述「不填则自动检测」不一致 | 代码/产品问题，不是文档 | 现状仍成立 | `python/promptcut_stt/__main__.py` 第 521～523 行 `default=DEFAULT_LANGUAGE`（help 写「默认 zh」）；`server/tools/ai.mjs` 第 158、165 行「自动」 | 不改，交主会话（桌面是改默认值还是改描述） |
| tools-p3-1 | 拆包表 F0 一节写 `ToolRunContext`／`RunAccess.signalFor`，实际取消信号在 `run-resources.mjs`（`register`／`signalFor`／`abortForFence`）；P3 行写“BootsTAPIR 有权重才算对应档 ready”，实际还需 `einshape`、`dm-tree`，Python `ready` 要么也查这两个包，要么部署清单写明 | 三级（plan）+ 代码问题 | 前半成立；后半“Python `ready` 不查这两个包”仍成立，是代码问题 | `run-resources.mjs:43-133`（`signalFor`、`register`、`abortForFence`）；`tool-context.mjs:98-148` 只有 `fromGrant`、`authorize`；`python/promptcut_track/__main__.py:92` `ready = bool(runtime["installed"] and model["exists"])`；`python/promptcut_track/requirements-track.txt:5-7` 列 `einshape`、`dm-tree` | 已改拆包表：F0 接口一节整节按现状重写（代码块换成 `ContextAccess`／`RunResources`／`ProjectAssets`／`ToolJobs`／`CloudToolProvider`）；P3 行写明 BootsTAPIR 档另需 torch≥2.2,<3、`einshape`、`dm-tree`、`bootstapir_v2.pt`，`ready` 只查 torch 与权重。`ready` 的判据不改（会影响桌面状态语义），列“代码问题” |
| tools-p3-2 | 覆盖表 `track_*`、`attach_clip_motion` 几行，待 G 接线后改“现状” | 三级（plan） | 成立；G 未合入 | `track.mjs`、`hosted-motion.mjs` 存在；`cloud-tools.mjs:71-72,74` 仍 `pending` | 已改覆盖表 `track_points`／`get_track`／`track_status`／`track_install`／`attach_clip_motion` 五行为“已实现、未挂载”。同一行里与代码不符的三处一并改：轨迹结果是项目×对话×素材×素材版本为键（原拆包表 P3 行写“按项目/素材版本持久”，同项目换对话读不到；〔裁-P3-1〕），`track_install` 云端默认不开放，`attach_clip_motion` 要在到 `agent-exec` 路由表之前分给 motion 提供方（`PAGE_STATE_TOOLS`） |
| tools-p3-3 | 同上，系统提示词里「运动追踪云端还没有」接线时去掉 | 代码，G 包接线 | 同上 | — | 不改 |
| tools-p3-4 | 若 `product/agent.md` 要写云端追踪的差别，只写一句：追踪结果按对话保存、素材换版后标过期；云端不替用户安装拓展 | 二级（那一句）；机制部分三级 | 成立 | `perception/track.mjs:35-57`（`TRACK_DEFAULTS`）、`:622-`（`install.enabled` 才装）、`:688-700`（`force:true`）、`:743-749`（`stale`）、`:757`（`found:false`）；`python/promptcut_track/__main__.py:92-95`（`ready` 只看 torch 与权重，`engine` 才是能追到哪一档） | 机制已改：新增块「云端运动追踪」（6 条，含数字与 `ready` 的缺口）。承诺那一句进二级对照表 C |
| tools-p4-1 | 拆包表接口草案（`ToolRunContext`／`RunAccess.signalFor`／`ProjectAssets.openRead` 返回 `ReadableStream`）与已落地的 F0 不一样：真实是 `run-resources.mjs` 的 `register`／`signalFor`，`openRead` 返回 Node `Readable` 加 `closed` | 三级（plan） | 成立，且比报告说的差得更多 | `project-assets.mjs:15-137`：`openRead(context, mediaId, {tier,range}) -> {stream(PassThrough), assetRef, mediaRev, projectRev, kind, closed}`；`import(context, source, {name,kind,requestId,sourceJobId?}) -> {importId, assetRef, state:'stored', resourceRev}`（不含 mediaId、不登记项目）；`verifyRef(context, ref) -> {assetRef, resourceRev, assetRefId}`；`close() -> {streamsClosed, dispatchesOpen, pending}`；`tool-jobs.mjs` 无 `requestId`／`error` 字段，有 `errorCode`、`instanceGeneration`、`fenceRevision`，另有 `checkpointRetained` | 已改拆包表接口一节整节（见 tools-p3-1）：签名、返回形状、工厂参数都以代码为准 |
| tools-p4-2 | `ToolJobs` 没有按入参找作业的接口，也没有文字原因字段，建议 F0 补 `latest` 或 `message` | 三级（代码建议） | 代码问题不是文档问题；仍成立 | 同 tools-p1-2 | 不改代码；拆包表已按现状描述 |
| tools-p4-3 | 覆盖表 `detect_subjects`、`subject_status`、`subject_install` 三行，G 包接线并验过后才能改；现在是“实现与测试完成，未挂载” | 三级（plan） | 成立；G 未合入 | `subject.mjs` 存在；`cloud-tools.mjs:73` 仍 `pending` | 已改覆盖表三行为“已实现、未挂载”，写明 `subject_install` 受控（不收参数、需 `PYLIBS` 与锁定 `REQUIREMENTS`、只装 light 档） |
| tools-p5-1 | F0 `tool-jobs.mjs` 打开账本时只把 `running` 改成 `interrupted`，`queued` 会一直排着；根治要 F0 在打开时一并标 `queued` | 三级（代码建议） | 代码问题不是文档问题；仍成立 | `tool-jobs.mjs` 约 190～200 行：`UPDATE tool_jobs SET state='interrupted' … WHERE state='running'`，无 `queued` 分支；`track.mjs`（P3-09）、`hosted-workflow.mjs` 各自在读取一侧补判 | 不改代码；拆包表接口一节“jobId”段按现状写“`running` 写成 `interrupted`，`queued` 的保持原样；P3、P5 在读取一侧按中断说”〔裁〕 |
| tools-p5-2 | `tool-jobs.mjs` 仍没有按入参找作业与放文字原因的字段，建议补 `message` | 三级（代码建议） | 代码问题不是文档问题；仍成立 | 同 tools-p1-2 | 不改代码；拆包表已按现状描述 |
| tools-p5-3 | 拆包表 P5 行写 STT→shots→subject→卡片/字幕→预渲染任务，与桌面版实际流程不同；建议注明“配卡规则与桌面版逐条相同，前后多出的阶段是云端的” | 三级（plan） | 成立 | `hosted-workflow.mjs:34` `WORKFLOW_STAGES = ['transcribe','shots','subjects','compose','prerender']`；`planAutoWorkflowEdits`（:206，桌面版搬运） | 已改拆包表 P5 行第 3 列：五个阶段名、配卡规则同桌面版、失败不越过、缺省镜头与主体为必需阶段（放宽与去重待用户定，两条是报告“要用户定的事”第 1、2 条，我只写了现状，没替用户定） |
| tools-p5-4 | 覆盖表 `background_job_status`、`auto_workflow`、`auto_workflow_status` 三行，G 接线并验过后才能改；现在是“实现与测试完成，未挂载” | 三级（plan） | 成立；G 未合入 | `cloud-tools.mjs:98-100` 仍 `pending`；`hosted-workflow.mjs` 无调用方 | 已改覆盖表三行为“已实现、未挂载”；`auto_workflow` 行写明项目一侧接缝（`applyEdits`）与 `prerender.publish` 在 main 上都还没接 |
| tools-w1-1 | 9.2 browser 行与 9.9「网页接管……无头浏览器｜没接上」，接线后改成「网页操作：chrome-headless-shell 的绝对路径……没配时回『这台节点没有配置浏览器』」 | 三级 | 成立，**未接线**：`cloud-tools.mjs:89-91` 七个 `web_*` 仍是 `P`（还没接上）；`hosted-browser.mjs`、`hosted-handoff.mjs` 没有被 Agent 服务建；环境变量名没有代码在读（`git grep PROMPTCUT_AGENT_BROWSER` 在 server/ 下无命中），只有报告建议名 | 同上 | 已改 契约 9.2 browser 行、9.9 把「网页接管、measure_audio_js」拆成两行 |
| tools-w1-2 | 9.5 补浏览器用户数据目录 `<数据目录>/web/<项目>/<对话>/` 与去留规则 | 三级 | 成立。`hosted-browser.mjs:102-118`（目录函数、`removeProfileFor`、`removeAllFor`），报告第二轮改成「设私有时删到只剩版本计数」；上限 512 MiB（`:75`）。目录名两段是清洗后的 id 加原文哈希（报告 1 节） | 同上 | 已改 契约 9.5 新增一条（标已实现、未挂载） |
| tools-w1-3 | 9.6 补浏览器要额外堵的几条，指向 `server/web/hosted/network.mjs` 文件头 | 三级 | 成立。`network.mjs:1-30` 的表与报告第 3 节一致；第二轮后启动参数改成整条相等的白名单（`ALLOWED_EXTRA_ARGS`） | 同上 | 已改 契约 9.6 新增一条 |
| tools-w1-4 | 拆包表 W1 行写“现有 `egress.mjs` 若需接口由单独 egress owner 串行扩展”，没有用到，可以划掉这半句 | 三级（plan） | 成立 | `git log -- server/agent/service/egress.mjs` 最近一次是 F0 整理那次（`f41c5ff9`），没有 W1 的提交；`server/web/hosted/network.mjs` 只用 `gate.admit`／`admitUrl` | 已改拆包表 W1 行第 2 列：该半句换成“也没有改 `egress.mjs`（只用出网闸已有的 `admit`／`admitUrl`）”〔裁〕 |
| tools-w1-5 | 云端网页操作的条目合入时按二级写三句承诺（按对话隔离、不代填凭据、只能访问公网），数字放三级 | 二级（三句）；机制三级 | 成立 | `server/agent/service/hosted-browser.mjs:42-76`（`HOSTED_BROWSER_DEFAULTS` 全部数字）、`:102-109`（目录）、`:367,382`（`BROWSER_MISSING`）；`server/web/hosted/network.mjs:114-119`（启动参数）；`server/web/hosted/hit.mjs:24`（`MOVE_TOLERANCE_PX = 6`） | 机制已改：新增块「云端网页操作」（9 条）。三句承诺进二级对照表 D |
| tools-w2-1 | 第 28 节旧通道；账号模式新形状追加一小节，写明旧通道只用于本地与局域网 | 三级 | 成立，**未接线**：`account-runner.mjs:153-155` 仍写死 `initiatorOnline: () => false`、`pageCall: async () => ({ offline: true, … })`；`createPageBridge` 只被 `collect-bridge.mjs`、`hosted-handoff.mjs`、测试引用 | 同上 | 已改 契约 28 开头加说明、新增 28.8 |
| tools-w2-2 | 反向通道那一条同样只写了旧形状，接线后补「账号模式下发起页取自文档服务记在消息上的在场页面号、交回时重核授权、请求状态落盘」 | 三级 | 成立；「接线后」那一半：接线没做，所以写成「已实现，还没挂载」 | `page-bridge.mjs:37-45`（`pageMs 15000`、`attachMs 3000`、`maxPageMs 60000`、`maxResultBytes 64 KiB`、`retainMs 7 天`）、`:153,181`（`page_requests` 表、重启标 `interrupted`/`agent-restart`）、`:347,413`（`page-binding-mismatch`）、`:474`（`page-request-gone` 410）、`:478`（`duplicate: true`）、`:529`（422）；`conversation-policy.mjs:69`；`http.mjs:270`；`instance.mjs:564-566`（账号模式 `get_selection` 走 `hostedAccountSelection`，其余页面工具走「发起方不在线」） | 已改 `mechanism/agent.md`「对话的状态」：旧反向通道那一条首句标明只适用于本地与局域网；其后新增「账号模式」一条（含现状）。另改了同一小节里「切剪辑要的播放头」一条：账号模式 `initiatorOnline` 恒为假，播放头一律按 0 记（依据 `account-runner.mjs:153`），标〔裁〕；`入口与实例`的接口清单后补了账号模式下 `page-results` 回 503、`DELETE` 回 503 的事实 |
| tools-w2-3 | 拆包表 W2 行“revision/nonce”的“/”改成“与”；补一句工作进程与主服务不在同一进程 | 三级（plan） | 成立 | `page-bridge.mjs`（栅栏版本、对话权限版本、一次性 nonce）；`server/agent-service/worker-event-internal.mjs:5` 只有任务进程到主服务的单向事件口 `/internal/v2/worker/events/append`，`git grep` 无主服务到任务进程的页面请求通道 | 已改拆包表 W2 行第 3 列：“revision 与 nonce”；补“账号模式下一条任务一个任务进程，`requestPage` 在任务进程、`attach`／`acceptResult` 在主服务，main 上没有主服务到任务进程的通道，放哪个进程由 G 定，W2 建议放主服务”。报告用词“工作进程”，我按 `docs/reports/AGENT-v18-prod.md` 的统一叫法写“任务进程” |
| tools-w2-4 | `cloud-tools.mjs` 里 web_handoff 的说明和系统提示词的旧话，接线时改 | 代码，G 包接线 | 取决于接线是否已做，见 D1 的核对 | — | 不改 |
| worker-1 | AGENT-018-prep.md 第 1、5 节的 175/219 项验收改成按文件列 | 报告类 | 不属文档 | — | 不改 |
| worker-2 | handoff-render-refactor.md 第 5.2 节第 1 条补「全量没跑过，有 4 条红，已在 claude/v18-worker 修」 | 交接文档（历史） | 成立（历史事实；该 4 条已修，在 main 上） | AGENT-v18-worker.md 第 1 节表 | 报告类，不改，交主会话 |
| worker-3 | `mechanism/agent.md` 写托管档「按项目×成员分实例」；一条任务一个进程接进生产时补一段机制（一个槽一个进程、一个进程一条任务、root 关、文档服务结清）；产品那一本的「多人同时发言」承诺不用改 | 三级 | 成立，且接进生产这件事现在已经做完 | 同 prod-3；`account-worker-control-client.mjs:5-8`（四条指令的路径）；`account-slot-scheduler.mjs:1-30`（调度只做四件事）；`run-authority.mjs:136-173`（围栏）；`worker-event-internal.mjs:5`、`account-master-scheduler-client.mjs:12-13`（内部口路径） | 已改：与 prod-3 合并写进同一块「账号模式的进程分工」；`入口与实例`第一条末尾加了指向这一块的一句，因为那一条说的「按项目×成员分实例」只适用于非账号模式 |
| worker-4 | three-versions-progress.md「接下来干什么」第 1 条改成差真实运行器和 root 入口 | 进度文档 | 已过时 | 真实运行器进任务进程（runner 块）与 root 入口（prod 块）都已合入 main（`git log` f87e297a、0de9061d）；进度文档该条仍写「打通独立任务进程和队列结算…补齐退出确认」 | 报告类，不改，交主会话 |
| worker-5 | C5 补 root 调度进程和任务槽：槽的初始化、文档服务配置里的槽与锚点摘要、主身份与任务进程两套证书 | 三级 | 成立；「等第 2 条补上」的前提已满足 | root 入口已由 prod 块做出（`account-root-main.mjs`、`account-root-slots.mjs`），README 九步与示例配置齐；`agent-root.example.json`、`doc-agent-run-scopes.example.json` 的键 | 已改：C5b 第 1（证书与钥匙）、3（任务槽单元）、4（root 配置）、5（初始化）、6（文档服务的槽与锚点摘要）步 |


## 三、二级对照表（`product/` 与总纲；不改文档，主会话逐条定）

「修改前」是现在文件里的逐字原文。A 到 G 来自 A1，M1 到 M4 是我自己核出来的。


**A. 看画面的五分钟目标（queue-4，要用户定）**

- 文件、节：`product/agent.md`，「工具」节，第 22 行「**看画面卡住：每次等一分钟，重试三次**」。
- 修改前原文（该条最后一句）：`一分钟只算渲染本身，不含排队等服务器和把项目装进内存的时间；整个过程低于五分钟的目标不变。`
- 建议修改后（按报告的选项 a，用户可改成 b 或 c）：`一分钟只算渲染本身，不含排队等服务器和把项目装进内存的时间。同一个项目连着看画面，整个过程低于五分钟；别的项目占着隔离工作进程时，要等它空闲满五分钟才让位，那一次必然超过五分钟，排队最多等 30 分钟，到了如实告诉 Agent 这次没看成。`
- 为什么：云端一次只装一个带自定义卡的项目；探针实测乙项目的第一帧在甲项目占着时要 5 分 36 秒、5 分 53 秒。「低于五分钟」和「空闲满五分钟才让位」在跨项目时不能同时成立。
- 来源：`AGENT-v18-queue.md`「要用户定的事」第 1 条；`three-versions-progress.md` 第 91 行。
- 核对依据：见逐条表 queue-4。
- 要用户定。（选项 b：有人等着看画面时允许提前让位，要改 2026-10-09 的决定；c：等 0.7.19 的两个项目并行。）

**B. 采集代下的现状（tools-c1-3）**

- 文件、节：`product/agent.md`，「工具」节「工具范围」下 `web_handoff` 那一条（第 46 行）的后半。
- 修改前原文：`素材采集默认匿名；需要登录态时由发起人的电脑代下，登录信息留在发起人电脑，代下失败或发起人离线时退回匿名，不上传登录信息。上述登录态代下目标尚未桥接到现有实现，契约中的 \`collect_login\`/\`collect_login_check\` 缺口是实现状态记录，不是产品规则禁用。`
- 建议修改后：`素材采集默认匿名；需要登录态时由发起人的电脑代下，登录信息留在发起人电脑，代下失败或发起人离线时退回匿名，不上传登录信息。只有发起人在线、用的是桌面版、链接属于有登录支持的站点（现在只有哔哩哔哩）、他电脑上有没过期的登录态，才委托他的电脑代下并直接传进项目素材库；发起人用网页版时没有本机采集，同样退回匿名。登录态代下的云端一侧和页面一侧已经写好，还没挂进云端工具表，所以现在云端的素材采集只按匿名下载；契约中的 \`collect_login\`/\`collect_login_check\` 缺口是实现状态记录，不是产品规则禁用。`
- 为什么：原句「尚未桥接到现有实现」已不准——实现在 main 里，缺的是挂载。条件列清了用户才知道什么时候会用他的电脑。
- 来源：`AGENT-v18-tools-c1.md` 第 10 节第 3 条、第 2.1 节；进度文件「待用户项」C1 五条（其中代下时桌面要不要提示、给模型的话还在等用户）。
- 核对依据：`collect-bridge.mjs`、`collectBridge.ts:233,294`（`unsupported`）、`server/collect-cookies.mjs:24`（只有 bilibili）、`cloud-tools.mjs:87`。

**C. 追踪的差别（tools-p3-4）**

- 文件、节：`product/agent.md`，「工具」节「工具范围」下，放在「**花钱的外部调用**」那条（第 50 行）之后，新增一条。
- 修改前原文：无（新增）。
- 建议修改后：`- **运动追踪**：云端的追踪结果按对话保存，同一个项目换一个对话要重追；素材换版后标「过期」，要重追才更新。没有神经网络权重时用模板匹配兜底。云端不替用户安装追踪拓展。`
- 为什么：这是用户会看到的差别（换对话要重追、没装拓展时的行为）。报告建议只写一句；我多写了两短句让三个差别分开，只要一句的话保留第一句与最后一句。
- 来源：`AGENT-v18-tools-p3.md` 第 5 节第 4 条、第 4 节〔裁-P3-1、P3-2〕；进度文件「待用户项」P3 两条（建议保持）。
- 核对依据：见逐条表 tools-p3-4。工具表还没挂载，措辞按「云端 Agent 的工具与本机一致」这一承诺写，不提挂载状态。

**D. 云端网页操作的三句承诺（tools-w1-5）**

- 文件、节：`product/agent.md`，「工具」节「工具范围」下，紧接 C 之后，新增一条。
- 修改前原文：无（新增）。
- 建议修改后：`- **网页操作**：云端 Agent 的网页操作（打开、看、点、输入、滚动、读、关）按对话隔离，一个对话里的登录状态不会带到别的对话。它不替用户填口令、验证码和卡号。它只能访问公网，访问不了节点自己和内网的地址。`
- 为什么：报告建议按二级写这三句，数字放三级（已放在 `mechanism/agent.md`「云端网页操作」）。
- 来源：`AGENT-v18-tools-w1.md` 第 10 节第 5 条；进度文件「待用户项」W1 四条（只读成员能不能用、设私有清不清登录状态、同时开几个、记不记用量，现在都按报告建议的缺省做）。
- 核对依据：见逐条表 tools-w1-5。

**E. 新开的空对话（newchat-1 的二级半）**

- 文件、节：`product/agent.md`，「运行位置」节，「**出错留痕**」那条（第 39 行）之后，新增一条。
- 修改前原文：无（新增）。
- 建议修改后：`- **新对话是安静的空对话**：页面刚建、还没发过消息的云端对话，不显示断线提示，也不在后台反复重连；发出第一条消息后照常接上。别的情形（对话被设为私有或删除后再打开、连不上服务）仍然提示。`
- 为什么：修之前新对话一直显示「和云端 Agent 的连接断了，正在重新连接」。
- 来源：`AGENT-v18-newchat.md`「对任务书或语义的更正建议」第 1 条；已合入 main `ca8ded81`。
- 核对依据：见逐条表 newchat-1。

**F1. 任务进程出故障记「失败」（prod-3 的承诺面，进度文件待用户项 ②）**

- 文件、节：`product/agent.md`，「运行位置」节，「**出错留痕**」那条（第 39 行）。
- 修改前原文：`模型调用失败、额度用尽、渲染失败、对话被停掉或失效时，对话记录里留下明确的原因，项目停在最后一次成功的改动之后。`
- 建议修改后：在句末加：`任务进程出了故障、没法正常收尾时（包括承接它的服务重启），这一条任务记「失败」，同一对话里排着的下一条接着开始；其中一部分修改可能已经生效。`
- 为什么：报告把这条标成二级〔裁 3〕，用户看得到「失败」的任务。原先没有这个结局，任务会一直占着名额等人按停止。报告说「`product/agent.md` 的承诺不用改」，但它自己同一份报告里把这三条标了二级，两处说法有出入，请用户定。
- 来源：`AGENT-v18-prod.md`「我做的裁定」第 3 条、「要用户定的事」；进度文件「待用户项」生产装配 ②（建议保持）。
- 要用户定。

**F2. 停止在服务器上最多等 15 秒（prod-3 的承诺面，进度文件待用户项 ①）**

- 文件、节：`product/agent.md`，「接入」节，「**谁能管对话和任务**」那条（第 10 行）。
- 修改前原文（其中一句）：`停任务：每个人只能停自己发起的那一轮，项目创建者能停任何人的任务。`
- 建议修改后：在这句后加：`点停止后，页面最多等 15 秒才回结果，多数情况点一下就显示已停；超过 15 秒仍没办完，回「还在办」，再点一次沿用原请求。`
- 为什么：这是用户看得到的停止行为（原先第一下多半显示「关闭待确认」要再点）。
- 来源：`AGENT-v18-prod.md`「我做的裁定」第 2 条；`AGENT-v18-worker.md`「要用户定的事」第 2 条；进度文件「待用户项」生产装配 ①（建议保持）。
- 核对依据：`account-master-assembly.mjs:53,180-190`。
- 要用户定。

**G. `get_selection` 的多成员读取已实现（顺带发现，没有报告提）**

- 文件、节：`product/agent.md`，「工具范围」下第一个子条目（第 45 行）末尾。
- 修改前原文：`具体接口和多成员读取机制待设计落实。`
- 建议修改后：`多成员选区读取已经实现：Agent 服务向文档服务发选区查询，答案按成员列出各页面的选区，每份标用户名，发起人标「（当前用户）」；发起人不在线时回发消息时的快照，标「发消息时的选区，非实时」。`
- 为什么：`instance.mjs:564` 账号模式的 `get_selection` 走 `hostedAccountSelection`，`server/docservice/modules/selection.mjs:208,220-222` 产出上述标注；`AGENT-v18-tools-w2.md` 第 4 节也核过。
- 来源：顺带发现。
- 核对依据：同上。


**M1. 退出确认完成之前网页显示什么（logout-2 的二级半）**

- 文件、节：`product/document-service.md`，「保存与延迟退出的修改处理」，第二条（改密后用户可选择是否退出已登录设备）。
- 修改前原文：`- 改密后用户可选择是否退出已登录设备（发起改密或重设的这个网站会话保留，其余网站会话和所有编辑器登录一起退出，2026-10-08 用户定）；选否保留现有云端登录和写入权限，选是撤销旧用户凭证、中止私有 Agent 任务，共有已读当前任务按下述例外继续。`
- 建议修改后：在句末加：`选了退出的，网页要等文档、素材、Agent、渲染四个服务都确认收口、文档服务签出结束见证之后，才显示已退出，之前显示正在退出；旧登录的权限在选定当场撤掉，不等这些确认。`
- 为什么：`product/` 里没有「全部确认以后才显示已退出」的承诺（在 `docs/semantics` 里搜「已退出」「正在退出」只命中 `mechanism/agent.md` 和 `mechanism/hosting.md` 里不相干的句子）。这一条决定退出能不能办完，是二级。
- 来源：`AGENT-v18-logout.md`「对任务书或语义的更正建议」第 2 条。
- 核对依据：`server/account/logout-confirmer.mjs` 第 96～97 行（还有一样没确认就不封口）、`server/hosted/combo.mjs` 第 366～380 行。网页只在 `logout.state === 'complete'` 时显示已退出，这一半在 VisuHive 仓库，本次没读，只信 logout 报告。页面上的字另见一级对照表 3，要用户定。

**M2. 「待实施」的标注已部分过时（顺带发现）**

- 文件、节：`product/document-service.md`，「保存与延迟退出的修改处理（2026-10-08 用户定，待实施）」，标题与末条。
- 修改前原文：标题 `## 保存与延迟退出的修改处理（2026-10-08 用户定，待实施）`；末条 `- 这是对齐后的产品要求，确切跨服务时间映射、历史保留、撤回机制及失败补偿仍待设计，见 \`../../plan/account-binding-contract.md\`，不以现有摘要字段声称已实现。`
- 建议修改后：标题改 `## 保存与延迟退出的修改处理（2026-10-08 用户定；退出确认已在 0.7.18 实现，撤回与历史保留待实施）`；末条前加一句 `退出确认的机制见 \`../mechanism/document-service.md\`「账号事件与延迟撤回」。`
- 为什么：退出确认链已在 main 上跑通（M1 的依据）；撤回只在结束见证里记下区间，`logout-confirmer.mjs` 里写明「撤回是 0.7.20 的事」。
- 来源：顺带发现（`mechanism/document-service.md` 同节标题我没改，等这一条定了再对齐）。

**M3. 守门测试的范围（chores-1，开发规则文件）**

- 文件、节：`docs/semantics/guide_files/verification.md`，「Windows 验证静默运行」（第 68 行）。`guide_files/` 是开发规则，不在三级里，按「拿不准按高的一级」放在这里。
- 修改前原文：`……检查整条子进程链，不能只隐藏最外层。用户明确要求查看的交互窗口除外。`
- 建议修改后：句末加 `守门测试 \`server/test/windows-hide-silent-spawn.test.mjs\` 扫 \`server/\`（不含 \`server/test/\`）、\`scripts/\` 整个目录树和 \`desktop/scripts/\` 里启动子进程的地方。`
- 为什么：chores 块把扫描范围从探针扩到了这三处，规则文件没写。
- 来源：`AGENT-v18-chores.md`「对任务书或语义的更正建议」。核对依据：该测试文件第 9、38、39 行。

**M4. 全量测试的看门与不写死端口（顺带发现，开发规则文件）**

- 文件、节：`docs/semantics/guide_files/verification.md`，「验证环境」。
- 修改前原文：无（新增）。
- 建议修改后：加一条 `全量测试由 \`scripts/test-suite.mjs\` 启动，带看门：某个测试文件的进程超过 15 分钟（\`PROMPTCUT_TEST_FILE_LIMIT_MS\` 可改）还没结束，就杀掉它的进程树并记为失败。测试里要监听的端口一律向系统要（\`server/test/free-ports.mjs\`），不写死。`
- 为什么：v18-ports 合入后这是跑基线的人要知道的事；没有这句，别人会再写死端口。
- 来源：`AGENT-v18-ports.md`。核对依据：`scripts/test-suite.mjs` 第 27～30、62～64 行；`server/test/free-ports.mjs` 存在，`server/test/` 下已搜不到 6440、2822x、5770、5782 这几组写死端口。

### 已随 `docs/plan/` 写进去、含二级成分、请用户一并审的 7 处

这些我名下的人按分工直接改了（契约里已标〔裁〕），列在这里是因为它们的承诺面在二级：

1. 契约 29.4（`docs/plan/cloud-agent-contract.md`）：停止在服务器上最多等 15 秒。来源 prod〔裁 2〕。
2. 契约 29.4：放弃结算又没人强制关的任务记「失败」。来源 prod〔裁 3〕。
3. 契约 29.5：每个任务进程读得到看画面的服务私钥，渲染服务不核任务授权。来源 runner「要用户定的事」第 1 条，用户还没定。
4. 契约 9.4：账号模式的附件，项目里可写的成员才能传，创建者只读看别人私有对话时不能传。来源 prod〔裁 7〕。
5. 契约 9.5：浏览器用户数据目录的去留（设私有时删到只剩版本计数）。来源 w1〔裁 2〕。
6. `docs/plan/hosted-render-contract.md` 第 7.5 节：一直有活的项目连续做满五分钟就让位，轮一圈再回来。来源 queue〔裁 1〕，用户还没定。第 8a 节「第一次之外再重试三次」共四次，来源 queue〔裁 2〕，待用户过目。
7. `docs/plan/account-binding-contract.md`「跨服务操作」：把 logout「没做成的」第 1、7 条的三处缺口写进了契约（Agent 带旧读取被结束后退出会停在「正在退出」等）。C 提醒：不想把缺口写进契约，可删这三句。


## 四、一级对照表（`workflow/`、`user-workflow.md` 和界面文字；不改文档，每条都要用户定）

A1 给出前两条，第三条来自 D2 与 logout 报告。


**1. 新开的空对话（newchat-1 的一级半，要用户定）**

- 文件、节：`workflow/production.md`，「云端对话」节，第 35 行（连接状态点与断线提示）那一条之后，新增一条。
- 修改前原文：无（新增）。
- 建议修改后：`- 新开的、还没发过消息的云端对话是一个安静的空对话：不出「和云端 Agent 的连接断了」那条提示，也不在后台反复重连；发出第一条消息后照常接上。`
- 为什么：同二级 E。界面文字没有新增，只是原来这种情形下会出现的那条提示不再出现。
- 来源：`AGENT-v18-newchat.md` 更正建议第 1 条。
- 核对依据：`session.ts`、`useCloud.ts`；报告里的改前改后探针（`docs/reports/assets/v18-newchat/`）。
- 要用户定。

**2. 云端小字的另一句（顺带发现，要用户定）**

- 文件、节：`workflow/production.md`，「云端对话」节，第 34 行。
- 修改前原文：`对话页签下常驻一行小字「在云端运行，关闭后继续；重新打开可接着看」。发出消息后关页面、退出软件都不拦、不弹确认。`
- 建议修改后：在第一句后加：`账号模式下，云端任务进程还没有在跑（Agent 服务没有执行服务在问）时，这行小字改成「消息会持久排队，等待执行服务；重新打开可接着看。」`
- 为什么：`src/editor/right/CloudAiPanel.tsx:562` 在 `cloud.accountMode && chat.info?.executorMounted !== true` 时显示后一句；`AGENT-v18-prod.md` 只说那句话「已有」，文档没写。
- 来源：顺带发现。
- 要用户定。


**3. 改密退出后网页上的字（logout 报告「要用户定的事」第 1 条）**

- 文件、节：VisuHive 仓库 `site/assets/account.js`（不在本仓库）；`docs/plan/account-binding-task.md`「改密界面」已有用户确认的三个短语。
- 修改前：网页现在显示 ChatGPT 写的长句（「正在退出其它网站会话和编辑器登录……」「其它网站会话和编辑器登录已退出……」）。
- 建议修改后：用户确认过的原文只有「密码已修改」「正在退出已登录设备」「设备已退出」三个短语。问要不要退出的那一句和两个按钮上的字没有原文。logout 报告的草稿：问句「要退出已登录的其它设备吗？」，按钮「退出」「不退出」，留一句「本网站保持登录」。
- 为什么：字没定稿。部署清单（`four-stage-deploy-checklist.md`）里的验收条目因此只写「一类的字」，判的是接口 `logout.state`，没写死原文。
- 来源：`AGENT-v18-logout.md`「要用户定的事」第 1 条。要用户定。


## 五、改了的文件

共 12 个文件，约 150 处，每处都标〔裁〕和来源报告。行尾：`git diff --stat main...HEAD` 逐个看过，增删行数与改动处数相当，没有整份被换行尾。

| 文件 | 级别 | 处数 | 谁改的 |
|---|---|---|---|
| `docs/semantics/mechanism/agent.md` | 三级 | 21 | A1 |
| `docs/semantics/mechanism/asset-service.md` | 三级 | 1 | 我 |
| `docs/semantics/mechanism/document-service.md` | 三级 | 2 | 我 |
| `docs/semantics/mechanism/hosting.md` | 三级 | 3 | 我 |
| `docs/plan/cloud-agent-contract.md` | 契约 | 25 | B |
| `docs/plan/hosted-render-contract.md` | 契约 | 约 21 | C |
| `docs/plan/three-versions-018-design.md` | 设计 | 5 | C |
| `docs/plan/account-binding-contract.md` | 契约 | 5 | C |
| `docs/plan/account-binding-task.md` | 任务书 | 3 | C |
| `docs/plan/cloud-agent-tools-implementation.md` | 任务书 | 17 | D1 |
| `docs/plan/cloud-agent-tool-coverage.md` | 任务书 | 31 | D1 |
| `docs/plan/four-stage-deploy-checklist.md` | 部署清单 | 17 | D2 |

没有新建 `mechanism/` 文件，所以不需要在 `developer_guide.md` 的表里登记新行。渲染服务排队这一套（隔离工作进程、闲置回收、看画面排队）在 `docs/semantics/` 里至今没有条目，细节只在 `hosted-render-contract.md`；我没有为它新建 `mechanism/` 一本，理由是同一个意思只在一处写。主会话若想把它升进语义，建议叫 `mechanism/hosted-render.md`，在 `developer_guide.md` 「按任务读哪些语义」表里「渲染」一行后加一行「渲染服务排队与让位（`server/hosted-render/`）｜`mechanism/hosted-render.md`」。

我自己改的六处：

1. `mechanism/asset-service.md`「职责」：账号模式每项目一个物理库，同一哈希各存一份，不跨项目去重。
2. `mechanism/document-service.md`「账号事件与延迟撤回」：新增「退出确认（已实现）」一条（四样确认的来源、续办器每秒一遍）。
3. 同一节：「跨服务完成点」一句改成指向上一条。
4. `mechanism/hosting.md`「云端 Agent 服务的部署」：新增「账号模式（一条任务一个进程）的部署」一条（root 入口、任务槽、两个用户一个共用组、`PROMPTCUT_DOC_AGENT_RUN_SCOPES_FILE`、节点重启后任务槽要重新初始化）。
5、6. 同一节「进程与目录」「服务身份」两条前加「（非账号模式）」。

各核对员改的逐处清单：


#### A1

只有 `docs/semantics/mechanism/agent.md`（`git diff --stat`：73 行增、12 行删；行尾没被换）。共 21 处：

1. 「云端对话权限与发送者」节标题与小引：把「待实施」改成「0.7.18 已在账号模式下实现，只读成员那一条除外」，写明实现在 `conversation-authority.mjs`、`run-authority.mjs`〔裁〕。
2. 同节第 1 条：补 `aclRevision`、`queueRevision`。
3. 同节第 2 条：补 `senderAccountId`。
4. 同节第 3 条：把「待契约落清」改成真实机制——`confirmRead` 带提示词摘要、已读收据 `readReceiptId`、`preparing`→`active`、`credential`/`member` 围栏下 `retained` 与 `revoked` 的条件。
5. 同节第 5 条：删「具体数据版本待契约落清。本节不声称现有按主人隔离的实现已支持共有对话」，换成队列在账本里的真实形状。
6. 「云端 Agent / 入口与实例」第 1 条末尾：指向新块。
7. 同节第 2 条末尾：账号模式下 `DELETE` 回 503 `deletion-pending`、`page-results` 回 503 `run-unavailable`。
8. 新块「账号模式的进程分工」（12 条）。
9. 「闸与上限」资源上限：看画面类工具的时限、`collect_search` 的 180 秒、账号模式并发与内存口径、「常驻超过 2 GB 重启」只属旧模式。
10. 「对话的状态」：主人键那条标明只适用非账号模式，补账号模式的归属与工作目录取名。
11. 同节：「切剪辑要的播放头」那条补账号模式下恒按 0 记〔裁〕。
12. 同节：旧反向通道那条首句标明只适用本地与局域网。
13. 同节：新增「反向通道，账号模式」一条（含「已实现，还没挂载」）。
14. 同节：新增 `extraTools` 一条。
15. 同节：「隔离」括号里「现在管的是 Agent 服务进程自己发出的请求；以后接上会起子进程的工具时……」改成现状（采集下载器的子进程已经只经出网闸的代理）。
16. 新块「云端子进程」。
17. 新块「本机采集代下」。
18. 新块「云端网页操作」。
19. 新块「云端运动追踪」。
20. 新块「新对话的空对话」。
21. 「Key 与模型」：补账号模式下模型配置放共用数据目录。

#### B

只有 `docs/plan/cloud-agent-contract.md`，共 25 处：

1. 首部「发起人本机工具口径更正」一句：桥接已实现、未挂载（tools-c1-2/w2-1）。
2. 2.2 表 SECRETS 行：账号模式不读（prod-2/runner-4）。
3. 2.2 表新增一行：账号模式三样环境变量（prod-2）。
4. 2.3 开头：JSON 请求体上限与附件字节上限分开写（顺带，附件）。
5. 2.3 healthz 行：补全字段，账号模式 `taskProcesses`、`scheduler`（prod-2）。
6. 2.3 桌面字段忽略清单：删掉 `attachments`，写明只认 `[{ url }]`（顺带，附件）。
7. 2.4 新增账号模式事件流 404 `no-conversation`（newchat-2）。
8. 6.3 新增账号模式 `/v1/usage` 含义与生产 503（fixes-2）。
9. 9.1 看画面口子的条件加账号模式说明（runner-4）。
10. 9.2 collect 行：登录桥接已实现、未挂载（tools-c1-2）。
11. 9.2 browser 行：`web_handoff` 与七个 `web_*` 的真实状态（tools-w1-1）。
12. 9.4 附件下新增账号模式附件（prod-2）。
13. 9.4d 新增「发起人电脑代下」一条（tools-c1-2）。
14. 9.4d 作业表补 `route`（tools-c1-2）。
15. 9.5 新增浏览器目录与去留（tools-w1-2）。
16. 9.6 新增浏览器要额外堵的几条（tools-w1-3）。
17. 9.8「怎么要」：请求体 `requestId?`、`run?`（runner-4）。
18. 9.8「时限与没看成」：排队与 35 分钟兜底（queue-2）。
19. 9.9：网页操作行、`measure_audio_js` 行（tools-w1-1）；看画面行补账号模式（runner-4）。
20. 20 第一条：加「旧模式」限定（prod-2）。
21. 25.3 两行：时限（queue-2）、隔离工作进程轮换（queue 顺手）。
22. 25.6 第 2、3 条：排队后的真实数字（queue 顺手）。
23. 25.7 一条：45 秒轮换已取消（queue 顺手）。
24. 28 开头一段，28.3 三行，新增 28.8（tools-w2-1、c1-2）。
25. 文末新增第 29 节（29.1 主服务环境变量、29.2 内部口与指令口、29.3 任务进程设置文件、29.4 页面接口的差别、29.5 看画面在账号模式下）。

#### C

| 文件 | 处数 | 每处一句话 |
|---|---|---|
| `docs/plan/hosted-render-contract.md` | 约 21 | 文首映射表两行（排队已实现、空闲回收已改）；第 4 节表里「看画面」行；第 4 节 2026-10-08 对齐段的末两句；第 4 节争用一条；第 4 节引文；第 7.1 节状态口 `look.queue`、`retried`、`over5min`；第 7.2 节 `ISO_IDLE_MS` 缺省改 300000；第 7.2 节加 `LOOK_QUEUE` 一行；第 7.2 节加四个测试用时限变量一行；第 7.5 节让位一条；第 7.5 节看画面一条；第 8a 节接口块加 `requestId`/`run`/`poll`/`cancel`，bullet 逐项写；第 8a 节原因码表重写；第 8a 节新增「排队、重试、时限」；第 8a 节 `path` 由六条改七条（卡片声音）；第 10.1/10.2 节加 RQ1～RQ9 与队列探针；实现记录里 HR38～HR43 一行改 HR40/HR41 描述，2026-10-07 条目加说明与「45 秒轮换，该规矩已取消」 |
| `docs/plan/three-versions-018-design.md` | 5 | 文首设计边界表 202 行加实现现状；同节 10-09 一句标已改；「素材协议」标题与第一段改成已做并更正目录；「渲染容量排队与Agent优先」标题与第一段改成已实现的接口；实施包表 `018-render-capacity` 行加注 |
| `docs/plan/account-binding-task.md` | 3 | 「即时渲染卡住」一行加同项目与跨项目的真实时间；「提前让位」一行标已改；`RS18-queue` 一行补已跑的证据 |
| `docs/plan/account-binding-contract.md` | 5 | 「隔离通道……尚待选定」改成已定与代码现状；退出确认一条加续办器现状与三处缺口；「实施前必须落清」一句指到设计文档；已读确认点由「待机制落清」改成已定并已实现；「待设计」一句去掉已读确认点 |

#### D1

### `docs/plan/cloud-agent-tools-implementation.md`（拆包表）

- 头部说明（第 3 行）：“不是已实现声明”改成“各包的状态只写代码是否在 main、是否已挂载，不代表通过验收”，并写明状态核对基底。〔裁〕
- “当前真实起点”第一段（原第 7 行 2026-10-08 增量）：换成 2026-10-13 增量。写明 F0 与 P1（半）、P2～P5、W1、W2、C1 已在 main，`ProjectAssets` 已由 `account-runner.mjs` 建出，`ToolJobs` 与各包工厂在 main 上没有生产调用方，G 包在 `claude/v18-wire` 分支未合入。去掉了已过时的“尚缺 project-assets”。〔裁〕
- “所有工具复用的窄接口”整节（原第 15～58 行）重写：代码块换成 `ContextAccess`／`RunResources`／`ProjectAssets`／`ToolJobs`／`CloudToolProvider` 的真实签名；工厂段改成“没有统一签名”并补 `childTreeWitness` 现状；`jobId` 段改成真实记录字段、幂等规则、重启规则（`queued` 不转）、`checkpointRetained`；边界段把素材读写改成 run grant 的受限句柄，标 `queryFrames` 为拟议（main 上没有），并列出每个包要 G 包接的项目一侧接缝和 `kernel` 载入缝。〔裁〕
- F0 行：文件清单按实际写（含 `run-resources.mjs`、`tool-assets-resources.mjs`、`run-asset-client.mjs`），依赖里的“asset ticket”改成运行素材的受限句柄，加状态。〔裁〕
- P1 行：写明已做（`shots.mjs`）与未做（素材拼图一半）；`runner.mjs` 改成公共实现；引擎顺序按桌面版；退档、`list_shots` 自答、缩略图不做；状态。〔裁〕
- P2 行：Python 三处改动；云端 install 的限制；`commitTranscript` 缝；状态。〔裁〕
- P3 行：BootsTAPIR 需要的依赖和 `ready` 的判据；`track_install` 默认不开放；结果的键（项目×对话×素材×版本）；`commit` 要与 fence 对账而 `mutate` 现在不带；`--max-frames`；状态。〔裁〕
- P4 行：light／full、`subjects` 落点、`subject_install` 受控；状态。〔裁〕
- P5 行：五个阶段、配卡规则与桌面同；失败不越过；缺省必需阶段（放宽与去重待用户定）；`background_job_status` 查所有种类；状态。〔裁〕
- P6、V1、D 三行末尾各加“状态：未做”。
- W1 行：划掉没用到的半句，换成事实；状态。〔裁〕
- W2 行：“/”改“与”；补任务进程与主服务不在同一进程；补 `web_handoff` 缺 W1 的 `handoffTarget`；状态。〔裁〕
- C1 行：文件清单按实际；回执与三种短请求、`result` 形状、哔哩哔哩；状态。〔裁〕
- G 行：末尾加状态（main 上没有，分支在做）和 `attach_clip_motion` 的路由先后。〔裁〕

### `docs/plan/cloud-agent-tool-coverage.md`（覆盖表）

- 新增一段“2026-10-13 实现状态”（在“范围与判定规则”三层说明之后）：28 行的统一状态与理由、没实现的三项、源码行号仍是 `8b255ab4` 的行号。〔裁〕
- 缺口逐项清单 28 行逐行改（第 2 列加“已实现、未挂载”与云端实现位置，第 3、4 列补云端实现与测试，第 5 列换成真实的未验边界，部分第 6 列补“接线归 G 包”）：`stt_status`、`stt_install`、`transcribe_media`、`detect_shots`、`track_points`、`get_track`、`track_status`、`track_install`、`detect_subjects`、`subject_status`、`subject_install`、`attach_clip_motion`、`web_open`、`web_view`、`web_click`、`web_type`、`web_scroll`、`web_read`、`web_close`、`web_handoff`、`collect_login`、`collect_login_check`、`seek`、`play`、`pause`、`background_job_status`、`auto_workflow`、`auto_workflow_status`。〔裁〕
- `see_frames`（`source:"media"`）行：补“P1 镜头识别已完成但未挂载，素材拼图那一半没做”。〔裁〕
- “明确不计入”表里 `collect_login`／`collect_login_check` 的含义一行：“本机代下桥接仍缺”改成“C1 已实现、未挂载”。〔裁〕
- 没动的行：`measure_audio_js`、`get_selection`、`get_gif`（都没有新实现，或早已接）。

#### D2

`docs/plan/four-stage-deploy-checklist.md`，约 20 处（git 统计本文件 +75/-13；行尾仍是统一的 CRLF，没被整体换掉）：

1. 文首：新增「2026-10-13 补记」一段（账号版 Agent 看 C5b；账号版三个服务是 systemd 单元，B1/C3 的 PM2 写法不适用，账号版文档服务的备份与重启待部署时核对）。
2. B 节：新增 B6（节点重启后任务槽要重新初始化，重启前先等各槽 `closed`）。
3. C4 第 6 步：加一句，账号版 Agent 已装上时真重启后按 B6 重做。
4. C5：标题标「旧模式」，加一句指向 C5b。
5. C5 第 7 步第 1 小步：识别码「要用跑 Agent 服务的那个系统用户取」改成与用户名无关（`machine-id.mjs` 文件头：不掺主机名、IP、用户名），并补 `machine-id-agent`。
6. C5 第 7 步第 3 小步：「导入命令〔待第四段补命令〕」换成 `import-key-agent`（命令、参数、数据目录取值规则、账号版用共用目录）。
7. C5 第 8 步表第 2 行（看画面）整行重写。
8. C5 第 8 步表后加「现状」一条：语音转文字、镜头、主体、追踪、网页接管、一键流程已实现但未挂载（`cloud-tools.mjs` 的 `CLOUD_TOOL_PLAN` 仍标 `pending`，共 25 个工具名里含这些），任务进程设置文件没有 Python/模型/采集配置项，现在不用装；配音已挂。
9. 新增 C5b 整节（先决条件、九步、同一个提交的核对、可选的看画面与运行素材、要留意的、备份、不过怎么退）。
10. 先决条件第 4 条：账号版核对办法。
11. D0：S4-r1 一行加「账号版是 C5b 第 1～9 步」。
12. D0：C3 之后新增「改密退出的确认链」一条（含素材服务停着时不变）。
13. D0：C5 之后「同一个提交」一行加账号版办法；新增「改密退出（Agent 配上之后再做一遍）」一条。
14. D1 表 C7 额度一行：账号版数据目录指共用目录。
15. E 表：新增账号版 Agent 回退行；原 C5 行标「旧模式」。
16. F 节：新增账号版单元与目录一条；环境变量名一条补账号版；已知坑补 B6。
17. G 节：新增第 4 条（账号版文档服务环境文件由安装计划生成，三个手工变量会不会被冲掉，待部署时核对），原第 4 条顺延为第 5 条。


## 六、顺带查三样（只报告）

### (a) 语义和计划文档里被代码推翻、没有任何报告提过的句子

共 40 条，已改 18 条（文件:行是改之前的位置，行号可能已漂移，按原句找）。我自己碰到的三条：

| 文件 | 原句 | 现状 | 处置 |
|---|---|---|---|
| `mechanism/hosting.md`「云端 Agent 服务的部署」 | 「进程与目录」写 PM2 的 `promptcut-agent` 单进程，「服务身份」写凭 `service-key.json` 连文档服务 | 账号模式下不是这样：主服务、root 入口、任务槽三样，主身份与任务证书（`server/hosted/deploy/README.md` 第 236～315 行；`server/agent-service/main.mjs` 文件头） | 已改（标「非账号模式」，加账号模式一条） |
| `product/document-service.md`「保存与延迟退出的修改处理」标题与末条 | 「待实施」「不以现有摘要字段声称已实现」 | 退出确认已实现，撤回未做 | 二级对照表 M2 |
| `guide_files/verification.md` | 没写全量测试有看门，没写测试端口不写死 | `scripts/test-suite.mjs`、`server/test/free-ports.mjs` | 二级对照表 M4 |

以下是各核对员报告的，原样附上。

#### A1（Agent 三个文件）


| 文件:行 | 原句 | 现状与依据 | 处置 |
|---|---|---|---|
| `product/agent.md:45` | `具体接口和多成员读取机制待设计落实。` | 已实现（`instance.mjs:564`、`selection.mjs:208,220-222`） | 二级对照表 G |
| `workflow/production.md:34` | 小字只有「在云端运行，关闭后继续；重新打开可接着看」 | 账号模式下调度没在问时是另一句（`CloudAiPanel.tsx:562`） | 一级对照表 2 |
| `mechanism/agent.md` 原「对话的状态」主人键条 | `对话归属的主人键：创建者按「项目 + 创建者」，限定进入的成员按用户名，自由进入的成员按「用户名 + 设备」。` | 账号模式按所属账号编号归属（`conversation-authority.mjs:228`） | 已改（上面第 4 节第 10 处） |
| `mechanism/agent.md` 原「对话的状态」播放头条 | `这里「发起方在线」的判定是此刻有一条来自发起这一轮的那个 userId 的事件流连着……` | 账号模式 `initiatorOnline: () => false`（`account-runner.mjs:153`） | 已改（第 11 处） |
| `mechanism/agent.md` 原「隔离」括号 | `这道核对现在管的是 Agent 服务进程自己发出的请求；以后接上会起子进程的工具时……` | 采集下载器的子进程早已经只经出网闸的代理（`hosted-collect.mjs:12-13,92-97`） | 已改（第 15 处） |
| `mechanism/agent.md` 原「云端对话权限与发送者」节 | 标题「待实施」；「本节不声称现有按主人隔离的实现已支持共有对话」「具体数据版本待契约落清」 | 对话账本 `v: 2`、`visibility`、`aclRevision`、`arrivalSeq`、`confirmRead`、`retained`（逐项见第 4 节第 1～5 处）；唯一没有的是「只读成员」这种身份，原文那一句本来就是这个意思，保留 | 已改 |
| `mechanism/agent.md`「闸与上限」原句 | `常驻超过 2 GB 重启` | 那是旧模式 PM2 配置（`server/agent-service/deploy.mjs:53`、`pm2-promptcut-agent.config.cjs`）；账号模式的单元没有这一项（`systemd-promptcut-agent-task.service`、`-master.service`、`-root.service` 里都没有 `MemoryMax`） | 已改（第 9 处） |


#### B

| 文件、行（我改动后的行号可能偏移，按原文找） | 原句 | 现状 | 依据 |
|---|---|---|---|
| 契约首部表（「2026-10-08 调度与 50 对话增量」，约第 11 行） | 「第 25 节云端单一路 look 和旧时限 → 设计本地授权/能力/可用性与完整端到端路径、版本一致/取消/迟到隔离；具体接口/超时/重试未批准；RS18-local/queue 待实现/未跑」 | 排队、取消、登记、轮询、重试、35 分钟兜底都已合入 main；「待实现」已过时。我没改：这一行写的是待确认草案，且按用户批准状态，不好由我改措辞 | `look-client.mjs` 文件头、`look.mjs:78-92`、`instance.mjs:35` |
| 契约 2.3 表 `DELETE /v1/conversations/<id>` 行 | 「`{ ok }`，进行中的先停；连模型历史一起删」 | 账号模式下这个接口回 503 `deletion-pending`（`http.mjs` accountRoute 的 DELETE、`conversation-policy.mjs:79` 的 `remove` 直接抛）；旧模式没变。首部已说「删除入口待做」，所以算旧模式描述，没改 | `http.mjs:218-219`、`conversation-policy.mjs:78-79` |
| 契约 2.3 表 `GET /v1/info` 行、`GET /v1/conversations` 行 | 回包字段 `{ ok, enabled, render, models, … }`、`startedOn` 等 | 账号模式下 `info` 回 `{ enabled, accountMode, executorMounted, running }`（`conversation-policy.mjs:53`，主服务覆写 `executorMounted`）；列表回文档服务给的行。我没改，原句对旧模式仍成立 | `conversation-policy.mjs:53`、`account-master-assembly.mjs:215` |
| 契约 11 节（节点资源上限）、7.5 节（进程被杀之后） | 描述的是单进程；账号模式「root 入口或主服务重启，正在跑的任务记失败」（prod 没做成的第 5 条） | 7.5 的「服务重启留下的 `interrupted`」在账号模式下不是这个行为。我没逐句核 7 节，列在这里提醒 | `AGENT-v18-prod.md` 没做成的第 5 条 |


#### C

| 编号 | 文件:行（改前） | 原句 | 现状 | 依据 | 处置 |
|---|---|---|---|---|---|
| a-1 | `hosted-render-contract.md` 第 8a 节「接口」 | 「`path` 只许六条」 | 七条，第七条 `/api/cards/audio`（卡片声音） | `look.mjs:111-115`（`LOOK_ROUTES`），提交 `da982203` | 已改并标〔裁〕 |
| a-2 | `hosted-render-contract.md` 第 4 节 | 「`timeoutMs` 缺省 60 秒，上限 170 秒」作为每个请求的时限 | 现在只管不带 `requestId` 的同步等，和卡片声音这一条 | `look.mjs:466,477-478` | 已改 |
| a-3 | `three-versions-018-design.md`「素材协议」 | 「托管目录拟 `tenants/<projectId>/assets/{media,snap,px}/`」 | 实际 `<素材目录>/projects/<projectId 的 sha256>/out/{media,asset-store/snap,asset-store/px}` | `project-stores.mjs:34` | 已改 |
| a-4 | `three-versions-018-design.md` 实施包表 `018-render-capacity` 行 | 「拟 `render-requests,agent-priority`」「不改…look-client」 | `render-requests.mjs` 已建；`agent-priority.mjs` 没建；look-client 的 202 握手是这一包改的 | `git log` 34526acc 等 | 已改 |
| a-5 | `account-binding-task.md`「新增验收映射（已规划，尚无新增运行结果）」小节标题 | 「尚无新增运行结果」 | RS18-queue 已有本机探针与单测结果 | queue 报告 | 只改了 `RS18-queue` 那一格，没动标题；建议主 Agent 把标题改成「已规划，部分已有运行结果」 |
| a-6 | `account-binding-contract.md`「改密、退出动画」两处「尚待设计」：区间的完成点怎样定义、账号服务和文档服务时钟怎样映射到操作次序 | 「尚待设计」 | 设计文档「可信区间」一节已定（order reserve/seal、`logout-complete` 结束见证、`endOrderSeq`），logout 报告里的结束见证就是完成点；是否全部实现没有逐项核 | 设计 `three-versions-018-design.md` 内部 API 表；`logout-confirmer.mjs:seal` | 没改（拿不准实现完整度），列给主 Agent |
| a-7 | `isolation.mjs` 文件头注释 | 「现状：本文件只有编排的状态机与目录操作……还没有接进管理进程」 | 已接进管理进程（`main.mjs` 引用并装配） | `main.mjs` 的 `isoIdleMs/isoSliceMs` 与 `ISOLATION_DEFAULTS` 引用 | 代码注释问题，不是文档问题，没改 |
| a-8 | `hosted-render-contract.md` 第 4 节引文、第 6 节 | 「预渲染任务遇到 507 记成失败并暂停认领」 | 仍然如此，queue 报告「没做成的」第 3 条也认；已把这一半留成「尚待对齐」，把看画面那一半写成已对齐 | `server/render-node/host.mjs:57-58,406` | 已按此改，未发现新冲突 |


#### D1

1. 拆包表原第 7 行：“尚缺 project-assets 按素材基础实施设计的 A/B/唯一G……”。现状：`project-assets.mjs` 已在 main 且被 `account-runner.mjs:133` 建出、经 `instance.mjs:1336` 交给任务实例。已改〔裁〕，依据同上；来源报告：`AGENT-v18-assets.md`、`AGENT-v18-prod.md`（只讲运行素材，没点这一句）。
2. 拆包表原第 56 行：job 记录含 `requestId`、`error`。现状：账本只存 `requestId` 的哈希作幂等键，有 `errorCode` 无自由文字。已改〔裁〕。
3. 拆包表原第 58 行：“`asset.openRead`／`import` 只经项目素材服务票据”。现状：任务凭自己的 run grant 向素材服务取受限句柄，不借成员票据（`AGENT-v18-assets.md`：运行素材；`run-asset-client.mjs:7`）。已改〔裁〕。
4. 拆包表 P3 行“轨迹按项目／素材版本持久”：现状按对话隔离（P3〔裁-P3-1〕），而 `three-versions-progress.md` 把它列成待用户定的事（改成项目内共享）。已按现状改，用户若定改共享，只改 `track.mjs` 的 `lookup` 的 `conversationId` 条件一处。
5. 拆包表末段（原第 80 行）“最小先行交付是 F0，随后 P1 的 scdet＋媒体拼图，它能最早验证……整条生产形状”：P1 实际只做了镜头那一半，媒体拼图没做。**没改**（它是排序建议，不是事实陈述），请主 Agent 决定是否改成“P1 的镜头识别一半”。
6. 覆盖表和拆包表里指向 `account-runner.mjs`、`instance.mjs`、`cloud-tools.mjs` 的行号已漂移，例如覆盖表 `seek` 行的 `account-runner.mjs:61-62`（`initiatorOnline: false`、offline `pageCall`）现在在 `account-runner.mjs:153,155`；`cloud-tools.mjs` 的 `seek/play/pause` 在 98 行（表里写 96），`background_job_status` 99、`auto_workflow` 100、`auto_workflow_status` 101（表里 98、99、100），`get_gif` 的 `visualId` 剥离在 133-137（表里 132-136），`see_frames` 素材拒绝在 142-143（表里 139-143）。覆盖表开头已写明行号是固定源码 `8b255ab4` 的，没有逐个重新对号；行为没变。
7. 覆盖表“明确不计入”表 `spawn_agent` 行：核对成立（`cloud-tools.mjs` 里 `spawn_agent: { mode: I, disabled: true }`；`server/test/cloud-agent-spawn-disabled.test.mjs` 存在），没有发现被推翻的句子。
8. 代码里（不是我的文件）仍在的旧话，G 接线时会碰到，列在这里供主 Agent 转给 G：`cloud-tools.mjs` 的 `NEED_LOGIN`（“云端的采集用不到它”）、`web_handoff` 的 `online` 说明（“云端的网页操作还没接上”）、系统提示词里“网页接管……在云端做不了”“运动追踪还没有”，以及 `NEED_PY`、`NEED_WEB` 两条文案；这些在 C1／W1／W2／P3 报告里都点过。


#### D2

| 文件:行 | 原句 | 现状 | 依据 | 处置 |
|---|---|---|---|---|
| 清单 C5 第 7 步第 1 小步（改前约第 183 行） | 「注意要用跑 Agent 服务的那个系统用户在那台节点上取」 | 识别码不掺用户名，用哪个用户取都一样 | `server/agent-service/machine-id.mjs` 文件头；README 第 188 行 | 已改，标〔裁〕 |
| 清单 C5 第 7 步第 3 小步 | 「导入命令〔待第四段补命令〕」 | 命令已有：`import-key-agent` | `scripts/remote/docservice.mjs` 文件头与 case；`server/agent-service/key-deploy.mjs` | 已改，标〔裁〕 |
| 清单 C5 第 8 步表第 2 行 | 看画面要 chrome-headless-shell，「Agent 服务用户能不能读它要核」 | Agent 服务自己不开 Chrome，向渲染服务要一帧 | README 第 147 行；`look-client.mjs`；`main.mjs` 第 37～41 行注释 | 已改，标〔裁〕 |
| 清单 C5 第 8 步表第 9 行（出网限制） | 「待第四段实现」「实现方式〔待第四段补〕」 | 出网闸已有 | `server/agent/service/egress.mjs`；README 第 153 行「出网闸」；`/healthz` 的 `egressTestAllow` | 没改（不在我的四条里，也没核对账号版任务进程里出网闸挂在哪）。请主 Agent 决定 |
| 清单第 20 行、C3 的〔待合流核对〕、C4/C5 开头的「第三段/第四段分支上；〔待合流核对〕」 | 命令名与参数要等分支合流后核对 | 分支已合流。`install-render`、`deploy-render`、`status-render`、`stop-render`、`rollback-render`、`keygen-render`、`deploy-agent`、`status-agent`、`stop-agent`、`keygen-agent`、`machine-id-agent`、`import-key-agent` 都在 `scripts/remote/docservice.mjs` 文件头与第 464～494 行的 case 里，参数（`--dry-run/--no-start/--save/--commit/--keep/--with-build-tools/--delete/--list/--retire/--to/--file/--service`）与清单写法一致。C3 那一条「`deploy-hosted` 增加对应参数」仍没有：`git grep AGENT_PUBLIC_URL -- server/hosted/deploy.mjs scripts/remote` 无命中 | `scripts/remote/docservice.mjs` | 没改（标记可以删，但不在我的四条里）；请主 Agent 决定 |
| 清单 D1 表 C6 一行 | 「进程被杀自动拉起、进行中的对话明确报中断可重开」 | 账号版：任务进程被杀，那条任务记「失败」；root 入口或主服务重启时正在跑的任务也记「失败」 | AGENT-v18-worker.md「对上摸底报告第 2 节里归这一块的验收行」2.3 第 6 条；AGENT-v18-prod.md「没做成的」第 5 条 | 没改（验收标准文字，拿不准要不要改验收口径），见第 5 节 |
| 清单 D1 表 C9 一行 | 「Agent 服务有并发与内存上限……节点级并发（6 轮）」 | 账号版任务槽单元模板没有 `MemoryMax`/`CPUQuota`，只有 V8 堆上限；同时跑几条由槽的个数决定 | `server/hosted/deploy/systemd-promptcut-agent-task.service`；README 第 246 行 | 只在 C5b「要留意的」里提示，没改 D1 的验收文字 |
| 清单 B1、C3 | 托管服务是 PM2 `promptcut-hosted`，用 `deploy-hosted` 重部署 | 账号版三个服务是 systemd 单元 `promptcut-account-v2`、`promptcut-doc-v2`、`promptcut-asset-v2`，环境文件 `<安装目录>/<单元名>.env` | `server/hosted/deploy/account-v2-install-plan.mjs` 第 6 行与第 138 行；AGENT-v18-assets.md 第 8 节第 2 条（用旧的 `deploy-hosted` 会起成旧模式） | 只在文首补记里点明，没有改写 B1、C3（缺账号版的备份与重启办法，我不能编） |
| `server/hosted/deploy/README.md`（不是我的文件）第 254 行 | 「三张叶证书」 | 表里列的是 master、task、identity、controller 四套，示例路径也是四对 | README 第 254～260 行；`agent-root.example.json`；`agent-account.env.example` | 没改（不是我的文件），清单里已写成「四套，以表为准」；请主 Agent 转给 README 的负责人 |
| `server/hosted/deploy/README.md` 第 16、31、33 行 | 舞台片段含 `Connection-Allowlist`、核对 curl 要有 `Connection-Allowlist`、「WebRTC 由 `Connection-Allowlist` 拦下」 | 2026-10-08 用户已定本期不做卡片出口限制，清单 C1 已写「不要求 `Connection-Allowlist`」 | 清单第 11 行（对齐补记）与 C1 核对一条 | 没改（不是我的文件），与清单互相矛盾，请主 Agent 转交 |


### (b) 用词

- **`docs/semantics/`**：「烘焙」「冻结」「图卡」「补渲」除 `glossary.md` 和 `constraints.md` 讲规矩本身的句子外，一处都没有。用编号简称指文档的，没有发现。`mechanism/agent.md` 里有 A1～A6（`agent-workflow-plan.md` 的条目号）、「卡点 1 第 1 行」、「第 15.8 节」、守门号 `C10A-API-05`，是计划、报告、测试的内部编号，没有白话说明（`suggested_agent_behavior.md`「汇报」要求代号第一次出现时说明）。不算违反「用词」，没改。
- **`docs/plan/`**：违规 2 处，都是带引号的「冻结」，指「固定一份确定快照」：`account-binding-contract.md` 第 73 行（「冻结当前状态」）、`account-binding-task.md` 第 155 行（「保存时“冻结”指固定非本机内容的一份确定快照」）。拿不准是不是保留用户原话，没改。按用词规矩应写「生成快照」。
- **`docs/plan/` 里别的「冻结」「图卡」「补渲」命中不是违规**：`render-refactor-task.md`、`render-standard.md`、`handoff-render-refactor.md`、`TODO.md` 是在讲「图卡改叫素材效果卡」这件事本身；`m7-contract.md` 第 380 行是页面的 `freeze` 生命周期事件；`hosting-migration.md` 第 127 行是版本「冻结在 2」；`cloud-agent-project-assets-implementation.md` 第 175、181 行是「协议冻结」「冻结 exports」，意思是不再改，不是生成快照。
- **`server/hosted/deploy/README.md`**（不在 `docs/` 下，不是本次的修改对象，没改）：「图卡」第 22、24、30、32 行，「补渲计划」第 145 行，共 5 处，应改「素材效果卡」「预渲染重试」。同一个文件还有两处与现状不符：第 254 行「三张叶证书」实际表里列了 master、task、identity、controller 四套；第 16、31、33 行写了 `Connection-Allowlist`，而 2026-10-08 用户已定本期不做卡片出口限制，部署清单 C1 也已写「不要求」。

### (c) `glossary.md` 里缺的新术语

下面在 `docs/semantics/glossary.md` 里搜都是 0 命中（「委托」命中 1 次，含义不同）。级别栏是我的建议，由主会话定。

| 术语 | 含义一句话 | 建议级别 | 出现的报告 |
|---|---|---|---|
| 任务进程（一条任务一个进程） | 账号模式下云端 Agent 的每条任务放进一个单独的操作系统进程里跑，一个进程只跑一条 | 二（决定架构形状） | worker、runner、prod、logout、queue、w2 |
| 任务槽、一代 | 一个槽是一个 systemd 单元；槽上先后开过的每个进程算一代，一代只绑一条任务 | 三 | worker、prod |
| 主服务、主身份 | 对页面开接口、只做控制、自己领不到任务的 Agent 进程，及它连文档服务用的身份 | 三 | worker、runner、prod、logout |
| root 入口、槽调度、发布器 | 节点上以 root 跑、开关任务进程并写关闭记录的进程；它里面决定哪个槽给哪个对话开一代的循环；它写记录用的那段代码 | 三 | worker、prod、logout |
| 终态、强制终态、意向、结清、收尾记录、关闭记录、放弃结算、失败观察 | 任务结束与关闭的一串东西：文档服务签的「这条任务可以关了」；停止、撤销、进程死掉时签的强制终态；任务进程签的意向；文档服务读到关闭记录后让出名额；任务进程自己形成的收尾记录；root 写的关闭记录；任务进程判断没法正常结算；root 对「主进程不在了」写的观察 | 三 | worker、runner、prod、logout |
| 运行授权（任务授权）、围栏（栅栏）、已读收据 | 一条任务的授权；因私有、停止、踢人、改密、关开关而让授权失效的动作与版本号；Agent 读完整条消息后文档服务写的收据 | 三 | worker、logout、runner、queue、assets、tools-* |
| 运行素材 | 一条任务凭这条任务的授权读写所在项目的素材，不借成员票据 | 三 | assets、runner、prod、tools-* |
| 反向通道、在场页面号（发起页） | Agent 服务经事件流让发起人那张页面执行一次操作再交回答案；页面连文档服务时自己起的随机号 | 三 | tools-w2、tools-c1、prod |
| 采集代下（委托代下） | 需要登录的素材采集由发起人的电脑下载并直接传进项目素材库，登录信息不离开他的电脑 | 三（承诺在 `product/agent.md` 已有） | tools-c1 |
| 看画面、登记了再来问 | Agent 的 `see_frames` 等工具向渲染服务要一帧；其中带 `requestId` 先登记回 202、再一趟趟 `poll`、可 `cancel` 的调用法 | 二（看画面）、三（调用法） | queue、runner |
| 隔离工作进程、常驻工作进程 | 渲染服务里专渲带用户卡项目、同一时刻只装一个项目的进程；渲不带用户卡项目的进程 | 三 | queue、runner、prod |
| 退出确认、四样确认、访问事件、结束见证、续办器 | 改密选退出后账号服务发「旧登录作废」事件；收齐文档、素材、Agent、渲染四样确认并收下文档服务签的结束见证才记办完；文档服务里每秒往下办没办完的退出的那一段 | 三（对用户的承诺见二级对照表 M1） | logout |
| 出网闸 | `egress.mjs`，云端 Agent 子进程与浏览器一切出网都要先过它 | 三 | w1、spawn、p3、p4 |
| 工具包（提供方）、工具作业 | 每个云端工具包导出的 `{handles, call, close}`，G 包把工具名分给它们；`ToolJobs` 账本里的后台作业 | 三 | p1～p5、w1、w2、c1 |
| 一键流程、后台作业状态 | `auto_workflow` 分转写、镜头、主体、配字幕与卡片、发布预渲染五段；`background_job_status` 查所有种类的作业 | 二（一键流程）、三 | p5 |
| 新对话（fresh）、项目物理库、根登记、锚点摘要、共用数据目录 | 页面刚建、还没发过消息的云端对话；账号模式每项目一个素材库；节点上由 root 写的证明现在活着的素材服务进程是哪个的文件；初始化槽后得到、钉住这个槽记录链的摘要；各代任务进程共用的数据目录 | 三 | newchat、assets、prod、runner |


## 七、拿不准的，以及要主会话决定的

### 要用户定（已写在对照表里）

1. 二级 A：看画面「五分钟内」在跨项目时做不到（等装着的项目空闲满五分钟才让位，实测 5 分 36 秒、5 分 53 秒）。选项见 A。
2. 二级 F1、F2：任务进程出故障记「失败」；停止在服务器上最多等 15 秒。
3. 一级 1、2、3：新对话安静空对话、云端小字、改密退出后网页上的字。
4. 契约里已经写了的：每个任务进程读得到看画面的服务私钥（甲保持、乙改主服务代签，runner 建议乙）；一直有活的项目五分钟轮换；「允许三次重试」是共四次还是三次。

### 代码问题，不是文档问题（我没改代码）

1. `/v1/usage` 在账号模式生产主服务回 503：`server/agent-service/account-master-assembly.mjs` 第 144 行没传 `usageDir`，只有进程内装配那一路传了。要不要传，主会话定。
2. `web_handoff` 没人负责：W2 的 `hosted-handoff.mjs` 要 `browser.handoffTarget(context)`，W1 的 `hosted-browser.mjs` 没有这个函数，W1 报告写「不在本包」。
3. 桌面 `transcribe_media` 不填 `language` 时 Python 缺省 `zh`（`python/promptcut_stt/__main__.py` 第 521～523 行），工具描述写「不填则自动检测」。云端传 `auto`。桌面是改缺省还是改描述，主会话定。
4. 云端 `STT_DEFAULTS.engines` 缺省只有 `faster-whisper`，而 `server/tools/ai.mjs` 的枚举含 `whisper`。
5. `python/promptcut_track/__main__.py` 第 92 行 `ready` 只查 torch 与权重，不查 BootsTAPIR 需要的 `einshape`、`dm-tree`。
6. `ToolJobs`（`tool-jobs.mjs`）打开账本时只把 `running` 改成 `interrupted`，`queued` 的一直排着；没有按入参找作业的 `latest(context, kind, key)`，没有文字原因字段 `message`。P3、P5 在读取一侧各补了判断。
7. 代码里的旧话，G 接线时一并改：`cloud-tools.mjs` 的 `NEED_LOGIN`（「云端的采集用不到它」）、`web_handoff` 的 `online` 说明、系统提示词里「网页接管……在云端做不了」「运动追踪还没有」；`server/hosted-render/isolation.mjs` 文件头注释「还没有接进管理进程」。
8. W2 的 `page-requests.test.mjs` CAU-ACC-07 按名字在 `src/` 里搜引用，G 包接线时改成只认 import。

### 合入 G 包（`claude/v18-wire`）后要回头改的文档

- `docs/plan/cloud-agent-tool-coverage.md` 开头那一段统一状态和 28 行逐行状态；
- `docs/plan/cloud-agent-tools-implementation.md` 各包状态行和 G 行；
- `docs/plan/cloud-agent-contract.md` 9.2、9.4d、9.5、9.6、28.8；
- `docs/semantics/mechanism/agent.md` 四处「已实现，还没挂载」（采集代下、云端网页操作、云端运动追踪、反向通道账号模式）。

### 我没改、请主会话定的文档

- `docs/plan/three-versions-progress.md` 第 20 行「退出仍等全部服务确认」、「接下来干什么」第 1 条（logout-3、worker-4），以及 `account-binding-task.md` 里「新增验收映射（已规划，尚无新增运行结果）」小节标题（RS18-queue 已有运行结果，C 的 a-5）。这是你维护的进度文档。
- `docs/plan/handoff-render-refactor.md` 第 5.2 节第 1 条补一句「全量没跑过，有 4 条红，已在 claude/v18-worker 修」（worker-2，历史事实）。
- `docs/plan/four-stage-deploy-checklist.md` 的 B1、C3 仍是 PM2 与 `deploy-hosted` 写法，账号版三个服务是 systemd 单元（`account-v2-install-plan.mjs`），账号版的备份与重启办法没人写（D2 拿不准第 1 条，assets 报告早提过）。
- `docs/plan/account-binding-contract.md` 两处「时钟映射、区间完成点尚待设计」：设计文档「可信区间」一节已定，logout 的结束见证就是完成点，但全部实现与否我没逐项核（C 的 a-6）。
- `docs/plan/cloud-agent-tools-implementation.md` 末段「最小先行交付是 F0，随后 P1 的 scdet 加媒体拼图」，P1 实际只做了镜头那一半（D1 顺带发现 5）。
- `mechanism/agent.md`「身份与失效」前两条和「成员列表的计数」第 2 条写的可能是非账号模式（A1 拿不准第 1 条）。
- 通用规矩里的偶发名单：v18-ports 合入后写死端口那一批已不适用；新近遇到的偶发有 `account-worker-lifecycle.test.mjs` 第 204 行起一条（newchat 报告）、`multi-agent-presence.test.mjs` 的 MA-X2（w1 报告）、`asset-project-workers.test.mjs`（本次全量里也超时一次，单独重跑过）。

### 部署清单里标了「待部署时核对」的（D2）

`worker.runAssets.origin` 的取值；`PROMPTCUT_ASSET_AGENT_FINGERPRINT256` 填哪张证书的指纹；`worker.look.keyDir` 放哪一把 agent 钥匙；账号版文档服务重新生成环境文件会不会冲掉手工加的三个变量（`PROMPTCUT_DOC_AGENT_SERVICE_KID`、`PROMPTCUT_DOC_AGENT_RUN_SCOPES_FILE`、`PROMPTCUT_AGENT_PUBLIC_URL`）；`import-key-agent` 导入后 `config/` 的属主任务用户读不读得到；自检第二遍通过的记录没找到。清单里这些都只写了「待部署时核对」，没有编数值。


## 八、基线与提交

### 基线

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（同一条命令里设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`、`PROMPTCUT_NO_PORT_FILE=1`）一共跑了四遍，如实记：
  1. 第一遍（核对员改完文档之后）：6461 条，通过 6442，失败 0，取消 1，跳过 12，todo 6，退出码 1。取消的是 `asset-project-workers.test.mjs` 的「真实ffmpeg项目worker……」（机器忙，撞了 20 秒时限）。单独重跑 `npm test -- server/test/asset-project-workers.test.mjs`：9 条全过，退出码 0。
  2. 第二遍：日志在 2111 行处中断（没有汇总行），工具却回了退出码 0，不可靠，不算数。
  3. 第三遍（〔裁〕署名改完之后）：6461 条，通过 6442，失败 1，退出码 1。失败的是 `proc-lock.test.mjs` 的「并发接管同一个死锁」。单独重跑两次，9 条全过。
  4. 第四遍（最终代码上）：**6461 条，通过 6443，失败 0，取消 0，跳过 12，todo 6，退出码 0，末行「npm test 最终结果：零失败」。**
- 本次只改文档，没有碰任何代码和测试。

### 提交

| 提交 | 内容 |
|---|---|
| `134c62d5` | 报告占位 |
| `4d527988` | 机制三份（素材服务、文档服务、托管）：每项目一个素材库、退出确认的四样来源、账号版 Agent 服务的部署 |
| `b4d9e338` | `mechanism/agent.md`：账号模式进程分工、云端子进程、采集代下、网页操作、追踪、新对话、反向通道，「待实施」一节改成已实现 |
| `3a4efd35` | `cloud-agent-contract.md`：账号模式环境变量与内部口、看画面、浏览器与反向通道的真实状态、404 `no-conversation`、新增第 29 节 |
| `7973877c` | 渲染契约、三版本设计、账号契约与任务书：看画面排队与重试、素材协议、隔离通道、退出确认 |
| `6b8a96ac` | 工具拆包表与覆盖表：F0 接口按现状重写，各包写成已实现未挂载 |
| `14723329` | 部署清单：账号版 Agent 服务 C5b、任务槽重新初始化、回退、改密退出验收 |
| `8116b19f` | 本报告 |
| `1f6d4de6` | 〔裁〕署名改为本分支 |
| 本提交 | 报告补基线与提交列表 |
