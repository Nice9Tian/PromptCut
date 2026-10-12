# 0.7.18 开工前的只读摸底

分支 `claude/rr-018-prep`，2026-10-13，`main` 在 `008ff668`。只读：没跑测试、没起服务、没连节点、没读 `docs/local.md`。看别人的分支只用了 `git log / diff / show / rev-parse / merge-tree --write-tree / rev-list / status`，以及 `handoff-render-refactor.md` 第 8 节写的 `git fetch --prune origin`。

下文「进度文件」指 `three-versions-progress.md`，「账号任务书」指 `account-binding-task.md`，「交接计划书」指 `handoff-render-refactor.md`，「开工指令」指 `render-018-kickoff.md`，「部署清单」指 `four-stage-deploy-checklist.md`，「设计」指 `three-versions-018-design.md`，「工具拆包」指 `cloud-agent-tools-implementation.md`。

几个反复出现的词：

- **独立任务进程**：云端 Agent 的每条任务放进一个单独的操作系统进程里跑，跑完由文档服务和队列一起「结算」（确认这条任务确实结束、名额让出来），第二条才开始；也能从外面强制停掉。ChatGPT 的报告里叫 worker。
- **待定的 23 个工具**：云端 Agent 的工具表（`server/agent/service/cloud-tools.mjs`）里标着「这一版在云节点上还没接上」的那些。任务书里说的「约 25 个」是同一批加上另外几项收尾。
- **渲染重构的那一带**：主会话给的文件范围，`src/render/`、`src/StageView.tsx`、`src/editor/snapshotFeed.ts`、`src/editor/Preview.tsx`、`src/online/`、`server/frame-*.mjs`、`server/bakery/`、`server/render-node/`、`server/prerender-executor.mjs`、`server/snapshot-*.mjs`、`server/artifact-*.mjs`、`server/card-*.mjs`。
- **RS18-local / RS18-queue / RS18-chat / RS-common**：账号任务书「新增验收映射」给 0.7.18 加的四组验收（本地取帧优先、单节点排队、50 个对话、共同回归）的编号。

## 1. 还剩的五项

### 第 1 项：改密码后的退出、正在跑的任务停下、已读记录这一整条链

- **做到哪**：网站改密和邮箱重设、别的登录失效、在线编辑器清正文和拒绝历史，已在 `main`（阶段合并 `cf56aa13`，进度文件记的是全量 5503 条零失败、浏览器 46 项全过）。「所有服务都确认退出」和「正在跑的任务停下」没接。后者的地基是独立任务进程，在分支 `codex/018-account-path-main`（`e0e69215`，比 `main` 多 58 个提交，最后提交 10 月 9 日 11:29，没进 `main`）。
- **分支上验过的**（它自己的报告 `docs/reports/AGENT-codex-018-agent-worker-doc.md`，在那条分支上；本次没重跑）：分块测试 175/175、联合 219 项；在真实 Linux 上做过三轮进程关闭实验（正常 10/10、强制 11/11、崩溃观测 12/12），用的是受控的假文档服务签发方，不是生产接线。
- **还差**（报告末尾自己列的四处，加上进度文件的两处）：
  1. 执行器 `server/agent/service/account-runner.mjs` 在任务真做完以后仍然有意抛 `run-outcome-unavailable`，没有形成「任务终态 + 资源已收干净」的不可变记录。
  2. `server/agent-service/run-client.mjs` 和 `server/agent/service/agent-instance-session.mjs` 消费「结束 / 准备 / 终态 / 控制」四个接口的那一半，报告写了已补四个方法（`070579f5`），正常路径上还没有调用方。
  3. 节点上以 root 身份跑的那个调度入口（收到文档服务的终态和任务进程的意向后，真的去关进程、再让文档服务结清）没有业务入口。
  4. 正常结束和强制停止交错时的顺序，只有拒绝的门，没有端到端跑过。
  5. 完整的一条独立进程任务没跑通；生产入口有意关着，缺配置一律拒绝。
  6. 改密选「退出」后，账号、文档、素材、Agent 各服务逐个确认退出，全部确认后网页才显示「设备已退出」；真实附件链。
- **要改的目录**：`server/account/`、`server/agent-service/`、`server/agent/service/`、`server/hosted/`（含 `deploy/`）、`server/test/`、`scripts/probes/`；网页那半在 VisuHive 仓库的 `site/` 和 `account/`。

### 第 2 项：素材隔离、缺失素材占位、待定的 23 个工具、素材采集

四件事，各在各的地方：

| 子项 | 做到哪 | 还差 | 要改的目录 |
|---|---|---|---|
| 素材隔离（知道别的项目素材的哈希也读不到） | 任务运行时素材的登记与读取在 `codex/018-run-assets-current-v2`（`b851f449`，多 20 个提交，41 个文件里 28 个 `main` 没有）；`main` 上的 `server/asset-service.ts` 里按项目取库只在带了可信上下文时走（第 736 行），别的入口还是全局库（第 635 行 `storeOf(ns)`） | 生产登记和传输没接齐；设计「素材协议」那张表列的九类入口逐个按项目核 | `server/asset-service.ts`、`server/asset-store/`、`server/media-{tiers,pull,stamp,ingest}.mjs`、`server/upload-queue.mjs`、`server/frame-stream.mjs`、`server/queue-local-media.mjs`、`server/vite-plugin-media.ts`、`server/hosted/` |
| 缺失素材占位 | `codex/018-missing-material-user-path`（`01ff6ba5`，多 3 个提交，已推远端）。画面显示「找不到素材」加文件名、声音放一次随软件分发的人声，接了预览、浏览器导出、服务器导出三处。它记的验证：31 条测试过、类型检查过、真 ffmpeg 合成过 30 帧并看过截图 | 没在真的应用和真的项目上跑过；**谁把一个素材认定为「确认缺失」这一半没有**（它只读这个标记）；在线浏览器里放不放得出人声没验；Linux 上没跑 | 已改：`src/render/{FrameScene,VideoTrack,MissingMaterial}.tsx`、`server/bakery/{export,media,mux-audio,audio-mix}.mjs`、`server/export-compose.mjs`、`src/audio/`、`src/editor/io/`、`src/editor/preview/MediaLayers.tsx`、`src/export/browserExport.ts`、`src/kernel/project.ts` |
| 待定的 23 个工具 | `main` 上的工具表里还是 23 个待定：语音识别 3、镜头识别 1、运动追踪 4、主体识别 3、把运动贴到片段 1、后台作业与一键流程 3、网页操作 7、音频测量脚本 1。公共地基（`tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`）已在 `main`。各工具的实现一个都没有（`server/agent/service/perception/`、`server/web/hosted/` 不存在） | 工具拆包那张表的 P1～P6、W1、W2、C1、V1、D、G 十二个包；另有 `web_handoff`、`collect_login`、`collect_login_check` 三个「操作发起人自己界面」的；节点上的 Python 库和模型权重 | `server/agent/service/`、`server/agent-service/`、`server/web/hosted/`（新）、`server/hosted-render/`（音频测量脚本的口子）、`server/vision/`、`server/ai-visual.mjs`、`server/vite-plugin-{stt,shots,track,subject,collect}.ts`、`python/`、`src/ai/cloud/`、`src/editor/right/ToolVisual.tsx` |
| 素材采集 | `server/agent/service/hosted-collect.mjs` 已有（不带登录态在云端下载） | 需要登录态时让发起人的电脑代下、直接传进本项目素材库；做不成或他不在线退回不带登录态 | `server/agent/service/hosted-collect.mjs`、新的 `collect-bridge.mjs`、`src/ai/cloud/collectBridge.ts`、`server/vite-plugin-collect.ts` |

### 第 3 项：合格的本地取帧优先、云端一次只有一个活跃项目并排队

- **做到哪**：只有规划（`render-scheduling-supplement.md`、账号任务书「渲染调度与对话上限补充」、设计「渲染容量排队与 Agent 优先」）。`main` 上没有持久的请求队列（`server/hosted-render/` 下没有 `render-requests.mjs`），看画面的请求在忙时仍回「忙」。
- **还差**：全部。具体是：Agent 要看画面时，先找一台授权、能力、在线三样都满足的本地节点取帧；不满足就进云端队列；云端同一时间只装一个项目，别的等着，不提示「已满」，也不因为云端满了悄悄改让用户的电脑渲；看画面每次最多等一分钟、自动重试三次（2026-10-09 用户定）；装在云端的项目空闲满五分钟才让位（同日用户定）。
- **顺带**：`server/hosted-render/isolation.mjs` 里还是 60 秒闲置回收（第 26 行）、45 秒看画面切换（第 30 行），和「满五分钟才让位」不符。
- **要改的目录**：`server/hosted-render/{main,broker,limits,isolation,look}.mjs` 加新的队列模块，`server/agent-service/look-client.mjs`、`server/agent/service/render-request.mjs`；本地取帧那一半要动桌面和浏览器的渲染节点（`server/render-node/`、`src/editor/browserNodeHost.ts` 一带）。

### 第 4 项：同一个项目同一个人最多 50 个对话、删除入口

- **做到哪**：账号模式下「满 50 个不让新建」已在 `main`（`server/account/conversation-authority.mjs` 第 219 行，回 409 `conversation-limit`）。删除没做：账号模式的删除接口现在固定回 503 `deletion-pending`（`server/agent-service/http.mjs` 第 236 行），云端 AI 栏的历史抽屉把删除按钮接成了空函数（`src/editor/right/CloudAiPanel.tsx` 第 623 行）。细则用户 2026-10-12 已定，在账号任务书「已拍板」的「云端 Agent 对话的删除」。
- **还差**：谁能删（开对话的人删自己的；创建者删任何人的，含私有）、删前确认、有任务在跑先停再删且已落地的修改保留、删完立刻让出名额、给相关成员弹气泡（不在线的下次打开补弹）、界面上「满了」的提示；语义 `docs/semantics/product/agent.md`「谁能管对话和任务」和 `workflow/production.md` 云端历史列表那一条要跟着改（后一份是一级，现在写着「这一版没有删除与重命名入口」）。
- **要改的目录**：`server/account/conversation-*.mjs`、`server/agent-service/http.mjs`、`server/agent/service/conversations.mjs`、`src/ai/cloud/`、`src/editor/right/{CloudAiPanel,ChatHistoryDrawer}.tsx`。

### 第 5 项：旧测试项目清理、真实旧文件转成本地项目

- **做到哪**：备份和恢复验过两次（旧托管数据一份、当前生产一份，见 `docs/archive/three-versions-production-restore-2026-10-09.md`）。删除清单没写、没执行。「过期云端项目转本地」的代码没有：`main` 上搜不到设计里的 `goneProof`（文档服务签发的「这个项目确实不在了」的证明），`server/recovery/coordinator.mjs` 仍把「本机凭证被撤」「连到的服务说没有这个项目」直接当成已删除（第 21、51 行），照账号任务书这两种都不能触发转换。
- **还差**：文档服务签发并核对准确的「已不存在」证明；打开旧文件时只凭它转成本地项目（新的本地项目号、协作缺省关、提示一次、原文件保留）；各种坏文件的处理；素材找回的先后顺序；然后才是节点上的删除（要用户点头，见第 7 节）和删除后的真实旧文件验收。
- **要改的目录**：`server/recovery/`、`server/docservice/modules/`、`src/editor/io/{proc,procp}.ts` 加新文件、`src/editor/sync/`。

### 五项之外、也归 0.7.18 的

这几件不在进度文件的五项里，但文档写明要在 0.7.18 做，拆活时别漏：

1. 本地项目搬到云端（进度文件第 43 行：「本地项目搬云端还没做完」）。
2. 托管方的渲染服务看不到账号项目，要接进去（`render-refactor-progress.md`「没做到的与原因」）。
3. 二十来支在线探针还在等旧的加入表单，进不了项目（同上）。
4. 探针和 `desktop/scripts` 里起子进程没带隐藏窗口参数的（同上记约 70 处；本次按文件粗数，`scripts/probes` 和 `desktop/scripts` 里有 16 个文件起了子进程而全文没有 `windowsHide`）。
5. 三个测试文件写死本机路径（开工指令「顺手要修的」）。
6. 改旧名词（「图卡」改「素材效果卡」等），放在在途分支都合完之后、发版验收之前（开工指令「做到什么算完」）。
7. 甲三（云端渲染服务按项目产轨道流）部署后的真实网络环境验收，随 0.7.18 部署一起。
8. 普通档浏览器探针开工前就失败的三处，记录在 `docs/archive/ordinary-browser-before-work-2026-10-09.md`；分支 `codex/018-browser-doc-read` 上有一处相关修正没合。

## 2. 逐项验收的底稿

「现在已有的证据」一栏都是文档里记的，本次一条都没重跑。发版前每一行要在最终提交上重新给结论，旧记录不能顶替（账号任务书「逐项验收」表头、`verification.md`「证据」）。

### 2.1 账号任务书「逐项验收」

| # | 项目（原文） | 预期（原文摘一句） | 归哪版 | 现在已有的证据 |
|---|---|---|---|---|
| 1 | 云端登录与限次数 | 正确才进入/创建；错误名称与密码同文案；网站与编辑器共用限次数 | 0.7.18 | 进度文件：登录、新建、加入在桌面和在线页面的真实公网走通。限次数、同文案没有单列证据 |
| 2 | 项目权限与两张列表 | 权限只由云端文档服务记录；被踢全设备拒绝；列表准确可点开；服务故障报不可用 | 0.7.18 | 进度文件：双方网站项目列表、成员两设备展示、禁入和解禁已进 `main`；截图在 `docs/archive/three-versions-user-path/`。「服务故障报不可用」没有单列证据 |
| 3 | Agent 共有/私有及发送者 | 新建默认共有…只有开对话的人能切换，共有切成私有后别的成员立刻看不到；每个人只能停自己发起的任务，创建者能停任何人的 | 0.7.18 | 进度文件：切私有 29 项全过，正文和附件清除、创建者私有只读已验；截图在 `docs/archive/three-versions-real-runner-scope-evidence/`。停任务的权限没有单列证据 |
| 4 | Agent 已读消息撤回例外 | 已读消息原文和作者保留；私有任务中止，共有已读当前任务继续；被踢账号全设备拒绝；重启后仍可准确判定；删项目或关闭 Agent 仍中止任务 | 0.7.18（「其修改不撤回」归 0.7.20） | 没有整条的证据。依赖第 1 项的独立任务进程；分支上有分块测试（六类停止原因各分未读、已读共 12 个分支） |
| 5 | 设备退出与延迟撤回 | 动画与真实完成一致；重启后续办 | 选是或否、动画与真实完成一致、通知丢失或重启后续办归 0.7.18；撤回范围与交织改动归 0.7.20 | 进度文件：改密和重设的文字路径 46 项已过。「全部服务确认」「重启后续办」没有 |
| 6 | 本地项目回归 | 不要求账号，旧权限/连接不退步 | 0.7.18 | 没有单列证据（全量测试里有局域网那一路的回归，不等于这一行） |
| 7 | 正常云端文件重开 | 连原项目及最新状态，不能用旧文件覆盖 | 0.7.18 | 没有 |
| 8 | 过期云端项目转本地 | 文件保存内容不丢；协作默认关闭；提示一次；保存后本机状态更新，重开不再连旧云端 | 0.7.18 | 没有，代码没做（第 5 项） |
| 9 | 非过期与坏文件 | 暂时离线/认证/权限分别提示，不转本地；错误保留原文件，不以空项目覆盖 | 0.7.18 | 没有 |
| 10 | 暂时离线改动与冲突 | 提示落后并询问是否发送；可视化选择冲突 | 0.7.19 | 对 0.7.18 不适用 |
| 11 | 保存与修改状态检查 | 暂停前台编辑、等待本机写完、保存哈希+时间+版本/基准 | 0.7.19 | 对 0.7.18 不适用 |
| 12 | 缺失视觉/音频素材 | 弹窗列项；文字卡“找不到素材xxx”；随软件分发的人声“找不到素材”在桌面版、在线浏览器和导出里都放得出来；位置/编排保留 | 0.7.18 | 分支上：31 条测试、真 ffmpeg 合成 30 帧并看过截图。弹窗、在线浏览器、真实项目、保存重开都没有 |
| 13 | 内部核对口与凭证 | 未授权调用均拒绝，不能只靠回环地址；无密码/令牌/会话值泄露；恢复凭证可撤销 | 0.7.18 | 没有单列证据 |
| 14 | 备份恢复 | 完整清单、校验结果、实际恢复并打开/读取；数据库快照一致，原备份保留 | 0.7.18 | 有，2026-10-09：三个数据库、18 个文件、三个角色启动，第三轮 5/5（前两轮失败原因留档），见 `docs/archive/three-versions-production-restore-2026-10-09.md`。部署前要在当时的数据上重做 |
| 15 | 最终产品交互验收 | 逐项结论，首次失败后复跑通过仍报告不稳定；耗时、配置记入 release-timings | 每版 | 没有（发版前跑） |
| 16 | 完整安装包 | 版本、来源 SHA、文件哈希；安装后启动、账号路径、实际文件关联双击及旧文件转换；不覆盖用户运行副本 | 每版 | 没有 |
| 17 | 兼容补丁 | 补丁清单/哈希/目标版本/壳要求明确；升级启动与必要账号/文件功能通过，回退验证 | 每版 | 没有 |
| 18 | 真实网络环境验收 | 验收清单网络 16 项及账号任务点名体验；证书、反代、重连、同提交服务、实际限权/退出 | 每版 | 没有（部署后跑）。账号那几条公网路径 10 月 9 日走通过，不是在最终提交上 |
| 19 | 清理后旧文件验收 | 云端文档服务明确不存在；关闭协作的本地项目可保存重开；缺素材按占位处理 | 0.7.18 | 没有 |

同一节后面还点了两处：

| # | 出处 | 内容 | 现在已有的证据 |
|---|---|---|---|
| 20 | 「第四阶段剩余工具的验收照 `cloud-agent-task.md` 的完成条件，归 0.7.18」 | 见 2.3 | 见 2.3 |
| 21 | 「在线浏览器的验收照 `online-browser-task.md`，第一步归 0.7.18」 | 浏览器开始页能新建云端项目，新建前要先登录 | 进度文件：在线页面新建、另一账号凭链接加入在公网走通。要对着 `online-browser-task.md` 第一步的验收条目逐条核，本次没读那一节的验收 |

### 2.2 账号任务书「新增验收映射」里归 0.7.18 的

| 编号 | 输入与要记的结果（原文摘一句） | 现在已有的证据 |
|---|---|---|
| RS18-local | 本地成功、授权/能力/可用性不满足、全部离线、执行中离线、取消、版本切换/迟到结果；界面播放头不变、云端兜底且单活跃项目 | 没有，代码没做 |
| RS18-queue | 多个均含自定义卡的项目、Agent see_frames 与预渲染争用、内存/磁盘压力和重启 | 没有，代码没做 |
| RS18-chat | 同项目同创建者 49→50→第51、共享消息多发送者、另一项目/创建者、并发创建、用户删除后重建/重开 | 满额拦新建的代码在 `main`；删除没做；这组验收没跑 |
| RS-common | 上述所有输入加跨项目/版本/授权、取消、失败兜底 | 没有 |

### 2.3 `cloud-agent-task.md` 的完成条件

| # | 原文一句话 | 现在已有的证据 |
|---|---|---|
| 1 | 设计与契约（`docs/plan/` 下）先写好再动手 | 有：`cloud-agent-contract.md`、设计、工具拆包。和 2026-10-08 以后的决定有几处没同步（第 8 节） |
| 2 | 独立入口对前端代码的依赖只经一处载入缝（`server/agent/ssr-host.mjs`）；不动桌面壳 | 四段任务的记录（`docs/reports/REPORT-four-stage.md`）；要在最终提交上重核。注意桌面壳这期间动过（第 6 节） |
| 3 | 独立入口：Agent 服务不带编辑页也能起，带鉴权，多个用户、多个项目、多个对话同时跑互不干扰；桌面版行为不变 | 四段任务的记录；进度文件「完整编辑器实际执行文档工具」17 项 |
| 4 | 隔离验收用探针断言（甲读不到乙没权限的项目；跨项目拿不到内容、素材、对话记录；伪造或过期的身份证明被拒；只读成员不能操作 Agent；关开关后对话被停） | 四段任务的探针记录；账号模式下要重跑。素材那一条依赖第 2 项的素材隔离。**核心项，不过不部署** |
| 5 | 在线页面：宽屏下右侧 AI 栏可用，接入方式有「云端」；发消息、流式回复、停止、工具调用过程、重开；手机仿真下仍是占位 | 进度文件：双方消息、排队位置、重开原对话已进 `main` |
| 6 | 端到端实测（改文案、挪片段、调卡片参数各一次；署名正确；撤销；两成员各开一个对话互不串；进程被杀后自动拉起、对话明确报中断可重开） | 进度文件：受控模型下的文档工具短任务已验。「进程被杀自动拉起」没有 |
| 7 | G 的接口验收（额度设很小被明确拒绝；设回不限恢复；用量记录查得到） | 四段任务的记录；账号模式下没有单列证据 |
| 8 | 模型 Key 按加密分发办法送到节点；真实模型下把第 6 条、「用户体验验收」和示例句各走一遍 | 密文在节点上验过解密和两个模型各一次真实调用（`three-versions-brief.md` 第 5 节），没导入任何服务。真实模型的三遍没有 |
| 9 | 节点资源：Agent 服务有并发与内存上限；满载时同机文档服务的响应时间与素材下载速度的前后对比，写明数字 | 没有（部署后做） |
| 10 | 语义按 E～J 改好；受影响的契约同步；草稿「步骤 3」里做完的标明出处 | 部分；设计第 26 行自己指出 `product/agent.md` 运行位置一节仍有旧段落 |
| 11 | tsc、npm test、`npm run build` 全过；只跑这次改动覆盖的探针 | 最终提交上重跑 |
| 12 | 合入 main，出下一个版本号的补丁；新节点上部署 Agent 服务；在线页面换成同一版并核验；release 判过并推进；部署模板与 `hosting-migration.md` 补上；`docs/local.md` 记多出的进程与目录 | 没有。「补丁」已被「完整安装包加兼容补丁」取代 |
| 13 | 写报告，含〔裁〕清单；播报后停下 | 没有 |

同一份任务书的「完成条件追加」（第 25 行）把 RS18-local、RS18-queue、RS18-chat、RS-common 也算进来，见 2.2。「用户体验验收」六条（发任务后关掉软件照常运转）用一个端到端探针固定，部署清单里是 S4-r2、S4-r5 两行。

## 3. 分支现状

2026-10-13 08:20 核的。**交接计划书第 5 节列的 `codex/018-*`、`claude/c10-*`、`claude/cloud-agent-3`、`claude/four-stage`、`claude/m7-probe-exp`、`claude/peaceful-meitner-ef78de`、`codex/c10-a5-timing` 当天都没有新提交**，最晚的是 10 月 12 日 19:13 那次保全提交。十个相关工作区都没有未提交的文件。

「落后 / 领先」是和现在的 `main` 比的提交数。「试合并」是 `git merge-tree --write-tree <分支> main`，没有真合。

### 做到一半、内容不在 `main` 里的（交接计划书第 5.2 节）

| 分支 | 头 | 落后 / 领先 | 最后提交 | 试合并 | 改过的文件和 `main` 比 |
|---|---|---|---|---|---|
| `codex/018-account-path-main`（独立任务进程） | `e0e69215` | 276 / 58 | 10-09 11:29 | **不冲突** | 39 个：21 个 `main` 没有，18 个内容不同；`main` 从分叉点以后一个都没动过这 39 个文件 |
| `codex/018-agent-worker-doc`、`codex/018-agent-worker-runtime` | `e0e69215` | 同上 | 同上 | 不冲突 | 和上一条是同一个提交 |
| `codex/018-missing-material-user-path`（缺素材提示） | `01ff6ba5` | 278 / 3 | 10-12 19:13 | **不冲突** | 24 个：12 个 `main` 没有，12 个内容不同；两边都改过的只有 `server/bakery/export.mjs`，git 能自动并 |
| `codex/018-run-assets-current-v2` | `b851f449` | 547 / 20 | 10-09 07:16 | 冲突 1 个：`server/hosted/doc-agent-assembly.mjs` | 41 个：4 个相同，28 个没有，9 个不同 |
| `codex/018-run-assets-current` | `8c1078f6` | 547 / 16 | 10-09 06:05 | 冲突 1 个（同上） | 内容被上一条包含 |
| `codex/018-agent-immediate-revoke` | `2d063550` | 453 / 21 | 10-09 10:13 | 不冲突 | 27 个：13 个相同，7 个没有，7 个不同 |
| `codex/018-cloud-assets-central-glue` | `ea298821` | 661 / 21 | 10-09 04:48 | 冲突 4 个：`server/hosted/deploy/account-v2-install-plan.mjs`、`server/hosted/doc-agent-assembly.mjs`、`server/test/account-v2-install-plan.test.mjs`、`server/test/fixtures/account-dual-user-path.mjs` | 41 个：11 个相同，21 个没有，9 个不同 |
| `codex/018-browser-doc-read` | `dcc51bc0` | 568 / 3 | 10-09 04:59 | 冲突 3 个：`scripts/probes/c10-browser-probe.mjs`、`scripts/probes/c10-judge.mjs`、`server/test/c10-host-claim.test.mjs` | 4 个：2 个没有，2 个不同 |
| `codex/018-agent-real-runner`（一份设计文档） | `554f2d82` | 317 / 3 | 10-09 10:12 | 不冲突 | 1 个，`main` 没有 |

重点两条的结论：

- **独立任务进程那条**：把现在的 `main` 合进去不冲突，它改的文件 `main` 这四天一个都没碰，也没有一个落在渲染重构的那一带。交接计划书第 6 节第 2 步「冲突应该很少」成立，实际是零。
- **缺素材提示那条**：把现在的 `main` 合进去也不冲突。交接计划书第 6 节第 3 步预计的「要在 `src/render/` 和 `server/bakery/` 解冲突」，到目前为止没有发生。但它有 11 个文件在渲染重构的那一带（`src/render/` 4 个、`server/bakery/` 7 个），渲染重构剩下的块一开工就可能撞上，见第 4 节。
- 试合并不冲突只说明文字上并得起来，不说明并完能过基线。两条都要合完以后跑类型检查和全量测试；缺素材那条改了导出和画面，还要跑渲染附加项。

### 内容已经在 `main` 里的（交接计划书第 5.3 节）

| 分支 | 头 | 落后 / 领先 | 说明 |
|---|---|---|---|
| `codex/018-instance-http-repair-verification` | `0b1454df` | 568 / 0 | 本机和远端都有 |
| `origin/codex/018-account-public-path`、`018-asset-root-publisher`、`018-cloud-consent-user-path`、`018-member-native-route`、`018-root-registry-stage`、`origin/codex/render-scheduling-doc-sync`、`origin/claude/render-service` | — | 领先都是 0 | 只剩远端 |
| `claude/four-stage` | `bea0d881` | 536 / 3 | 改过的文件和 `main` 逐个比，没有内容差异 |
| `claude/cloud-agent-3` | `8fb6df79` | 1093 / 1 | 同上，没有内容差异 |

照开工指令「可以直接做的」，这些可以清，清之前照 `multi_agent.md` 核三件事。本次没清。

### 不属于这次任务的（交接计划书第 5.4 节）

`origin/claude/peaceful-meitner-ef78de`（1482 / 2）、`claude/c10-accept`（2341 / 2）、`claude/c10-integ`（2318 / 1）、`claude/m7-probe-exp`（2462 / 6）、`codex/c10-a5-timing`（896 / 5）、`check_frontend_backend_separation`（1491 / 0）、`origin/Doger`（1469 / 0）、工作区 `m7-integ`（没挂分支，`f3a617b8`）。都没动，都在原处。

### VisuHive 仓库

`main` 在 `1b3b002`，和远端一致，工作区干净，本机只有 `main` 一条分支；远端还留着五条 `codex/018-*`（交接计划书说都已合入）。

## 4. 和渲染重构没做完的块有没有抢文件

渲染重构剩下的块（`render-refactor-progress.md`「接下来」第 2 条）会动的文件，除了主会话给的那一带，`html-snapshot-removal-dryrun.md` 里还点到了 `server/queue-idle.mjs`、`src/editor/browserNodeHost.ts`、`src/editor/sync/hostedServices.ts`、`src/export/originals.ts`、`src/kernel/frameMode.mjs`，并在第 9 节留了一个没查清的问题：云端 Agent 看画面读不读每张卡的快照。

| 项 | 判定 | 理由 |
|---|---|---|
| 第 1 项：独立任务进程、改密退出链 | **现在就能动手** | 全在 `server/account/`、`server/agent-service/`、`server/agent/service/`、`server/hosted/` 和 VisuHive 仓库，一个文件都不在那一带；试合并零冲突 |
| 第 2 项·缺素材占位 | **拆两半** | 已做的那一半有 11 个文件在那一带（`src/render/FrameScene.tsx`、`VideoTrack.tsx`、`server/bakery/export.mjs`、`media.mjs` 等）：要么趁现在试合并还不冲突、渲染重构剩下的块还没派出去，先把它合进 `main`；要么等渲染重构做完再合并解冲突。没做的那一半（谁来认定「确认缺失」、弹窗、保存重开）在 `server/recovery/`、`src/editor/io/`、`src/editor/sync/`，不在那一带，现在就能做 |
| 第 2 项·素材隔离 | **拆两半** | 大部分在 `server/asset-service.ts`、`server/asset-store/`、`server/media-*.mjs`、`server/hosted/`，现在能做。`server/frame-stream.mjs` 在那一带（那份「修改前 / 修改后」文档点了它三次），按项目隔离轨道流的那一处等渲染重构做完。渲染工作进程按项目绑素材键（`server/hosted-render/worker.mjs`）名义上不在那一带，但甲三刚改过它、稀疏流还会改，也放后一半 |
| 第 2 项·待定的 23 个工具、素材采集 | **大部分现在就能动手** | 语音识别、镜头、追踪、主体、一键流程、网页操作、采集代下都在 `server/agent/service/`、`python/`、`server/web/hosted/`、`src/ai/cloud/`。三处要等或者先对接口：「看素材的拼图」和 `get_gif` 的可视记录要动 `server/vision/`、`server/ai-visual.mjs` 并走看画面那条路；音频测量脚本要在 `server/hosted-render/look.mjs` 开口子；最后把工具表改成「已接上」的那一步（工具拆包的 G 包）要等前面都回来 |
| 第 3 项：本地取帧优先、云端排队 | **拆两半** | 云端排队这一半在 `server/hosted-render/{broker,limits,isolation,look}.mjs` 和 `server/agent-service/look-client.mjs`，不在那一带，能先做；但要先确认渲染重构剩下的块不碰这四个文件（甲三改的是 `worker.mjs` 一侧，文档没点这四个）。本地取帧优先这一半要让桌面或浏览器的渲染节点答看画面的请求，会进 `server/render-node/`、`src/online/`、`src/editor/browserNodeHost.ts`，**等渲染重构做完**。另外「看画面到底读哪种预渲染产物」正是那份文档第 9 节没查清的，快照作废以后可能要改，这一半更该后做 |
| 第 4 项：50 个对话与删除 | **现在就能动手** | 全在 `server/account/`、`server/agent-service/`、`server/agent/service/`、`src/ai/cloud/`、`src/editor/right/`。和第 1 项共用 `server/agent-service/` 和 `server/account/`，但具体文件不重叠（第 1 项不碰 `http.mjs`、`conversation-authority.mjs`、`conversations.mjs`）；「有任务在跑先停再删」要用第 1 项的停止，接口先约好。它要改一处一级语义（`workflow/production.md`），用户已逐条认可，动手前照规矩把「修改前 / 修改后」贴给用户 |
| 第 5 项：旧项目清理、旧文件转本地 | **代码现在就能动手；删除等用户点头、等部署** | 代码在 `server/recovery/`、`server/docservice/modules/`、`src/editor/io/`、`src/editor/sync/`，不在那一带。设计里 `018-file-recovery` 那个包把缺素材的渲染接线也算在内，那部分照「缺素材占位」那一行办 |
| 五项之外：写死路径的三个测试、起子进程的隐藏窗口 | 现在就能动手 | `server/test/`、`scripts/probes/`、`desktop/scripts/` |
| 五项之外：二十来支在线探针换账号入口 | 等渲染重构做完 | 文件在 `scripts/probes/`，不在那一带，但这些探针测的就是在线舞台和预渲染，渲染重构剩下的块还要改它们的断言，现在换了要再换一次 |
| 五项之外：托管渲染服务接进账号项目 | 等渲染重构做完 | 在 `server/hosted-render/directory.mjs` 一带，和甲三留的尾巴是同一处 |
| 五项之外：改旧名词 | 最后 | 约 180 个文件，开工指令已定放在在途分支都合完之后 |

## 5. 建议的拆法和先后

先后的理由：独立任务进程是第 1 项的地基，也是第 4 项「先停再删」和账号任务书第 4 行验收的前提，而且它完全不碰渲染，所以排第一；缺素材那条趁现在不冲突先定去留；其余不碰渲染的并行铺开；碰渲染的排在渲染重构之后。

档位照开工指令「分工与档位」那张表。每块一个工作区、一条分支，从 `main` 新拉 `claude/` 开头的分支；要用 ChatGPT 分支上的成果时，把那条分支合进新分支，不在它的工作区里干活。

| 块 | 做什么 | 依赖 | 派给谁、哪一档 | 验收看什么 |
|---|---|---|---|---|
| 一、接回独立任务进程 | 交接计划书第 6 节第 2 步：从 `main` 拉新分支，把 `codex/018-account-path-main` 合进来，跑基线；补第 1 节列的四处接线，把一条完整的独立进程任务跑通（第一条真结束、第二条才开始；能从外面强制停）；生产入口仍缺省关 | 无 | Opus high（`opus-dev-high`）：独立任务进程、鉴权与票据、并发与时序，要自己定接法。两轮不过或遇到跨进程才复现的问题交 GPT | 基线；分支上原有的 175 项和联合 219 项仍过；新增一支端到端探针：两条任务排队、正常结束、强制停、任务进程被杀各一遍。真实 Linux 那一段在节点上自己的临时目录里验 |
| 二、改密退出的确认链 | 选「退出」后各服务逐个确认，全部确认才显示「设备已退出」；通知丢了、重复、服务重启后续办；私有任务中止、共有已读任务继续 | 一 | Opus medium（契约清楚）；VisuHive 的网页一侧 Sonnet high | 账号任务书第 4、5 行里归 0.7.18 的部分；浏览器探针 |
| 三、缺素材占位的去留 | 主会话读差异，决定现在合还是等。现在合：从 `main` 拉分支合进 `codex/018-missing-material-user-path`，跑基线和渲染附加项（它改了导出和画面），导出像素基线不变才进 `main` | 无；要在渲染重构剩下的块派出去之前做完 | 主会话自己读差异；补验派 Sonnet high | 类型检查、全量测试、它自己的 31 条；导出确定性；240 帧和基线两种结果之一逐字节相同（没有缺失素材的项目画面不该变） |
| 四、旧文件转本地与「确认缺失」的来源 | 文档服务签发「已不存在」的证明；只凭它转本地；坏文件各情形；素材找回先后；认定缺失并弹窗；保存重开 | 三（要它的标记格式） | Opus medium 做证明与恢复协调（对外数据格式）；界面和探针 Sonnet high | 账号任务书第 7、8、9、12 行；合成的旧文件矩阵。真实旧文件那一关在部署后 |
| 五、50 个对话与删除 | 删除接口、权限、确认、停任务、让名额、气泡与补弹、满额提示；语义两处 | 「先停再删」用一的停止，接口先约 | Sonnet high；气泡和确认的文案先让 Gemini 出稿 | RS18-chat；两个账号的浏览器探针截图 |
| 六、素材隔离（不含轨道流） | 设计「素材协议」表里除 `server/frame-stream.mjs` 和渲染工作进程以外的各入口；把 `codex/018-run-assets-current-v2` 能用的搬过来（它有 1 个冲突文件） | 无 | Opus medium（鉴权与票据，契约在设计里） | 同一个哈希、两个项目，各入口互相读不到；撤销后正在读的流被关 |
| 七、工具包（并行几路） | 工具拆包的 P1～P5（感知与一键流程）、W1（网页操作）、W2（发起人页面反向通道）、C1（采集代下）各一路；文件清单照那张表 | 公共地基已在 `main`；W2 先于 C1 | 各 Sonnet high（开工指令点名「云端 Agent 的各个工具包」用 Sonnet）；网页操作的出网限制 Opus medium | 每包照工具拆包「每包必须提交的证据」；真实的短素材出真实结果，不只是状态 |
| 八、云端排队 | 持久的看画面请求队列、一次一个活跃项目、Agent 优先、满了排队不报「已满」、五分钟才让位、一分钟乘三次 | 无（先确认渲染重构不碰那四个文件） | Opus medium 或 high（队列与同步） | RS18-queue 里不依赖本地节点的部分 |
| 九、零碎 | 三个测试文件写死路径改成没设变量就跳过；探针和 `desktop/scripts` 的隐藏窗口 | 无 | Sonnet medium（机械活） | 全量测试条数不变；不设变量时是跳过不是失败 |
| —— 以下等渲染重构做完 —— | | | | |
| 十、本地取帧优先 | 授权、能力、在线三样都核过的本地节点先答看画面；不合格、离线、执行中掉线转云端；取消和迟到的结果隔离；不动用户的播放头 | 八；渲染重构 | Opus high | RS18-local |
| 十一、和渲染有关的工具与隔离 | 看素材的拼图、`get_gif` 可视记录、音频测量脚本；轨道流和渲染工作进程按项目隔离；托管渲染服务接进账号项目 | 六、七；渲染重构 | Opus medium | 工具拆包 P1 的拼图部分、P6、V1 |
| 十二、工具表接线 | 工具拆包的 G 包：一个人串行把 23 个逐个从「没接上」改成已接上，子 Agent 固定回「云端暂不支持」 | 七、十一 | Opus medium | 工具总表没有未归类的；真实模型走一条完整链 |
| 十三、在线探针换入口、本地项目搬云端 | 二十来支探针改走账号入口；搬云端补完 | 渲染重构 | Sonnet high | 各探针过；账号任务书第 1、2 行 |
| 十四、改旧名词 | 「图卡」改「素材效果卡」、「补渲」改「预渲染重试」 | 所有在途分支合完 | Sonnet medium | 基线；导出像素基线不变 |
| 十五、整套验收、发版、部署 | 第 6 节 | 全部 | 主会话 | 第 2 节每一行有结论 |

接手的第一步照交接计划书第 6 节：先读进度文件，照第 8 节重核分支（本报告第 3 节是 10 月 13 日的结果，动手那天再核一次），然后做块一。块一、三、五、六、七、八、九互不抢文件，可以同时派；注意全量测试里有几个文件把端口写死在 58xx，几个工作区同时跑会撞（`render-refactor-progress.md` 记的）。

## 6. 发版和部署要做的事

只列步骤和出处，没有执行。

### 6.1 发版前

1. 整套验收在最终提交上跑一次：`node scripts/acceptance/four-stage-acceptance.mjs --out … --flaky-rerun 1 --release-timings "0.7.18"`，先 `--list`、`--matrix`、`--check-coverage`（部署清单 A1；`verification.md`「小阶段与发版分别验什么」）。清单 120 项（本地 104、真实网络 16），缺省只跑本地一级，另有 13 项可选项不在缺省集合里，要单列（账号任务书第 188 行）。运行器现在在 `main` 的 `scripts/acceptance/` 下。
2. 账号、素材、Agent、旧文件这些新功能的验收项要先加进运行器的清单，否则「整套」不含它们（设计「验收输入、正反探针与集成闸门」）。
3. 把运行器生成的耗时那一节贴进 `docs/reports/release-timings.md`（`verification.md`「耗时只记录，不当闸门」）。那份文件里现在已有一节叫「0.7.18 候选」，是四段任务留下的，发版时换成最终提交的。

### 6.2 版本号

1. 应用版本 0.7.17 改 0.7.18：`package.json` 的 `version`，`package-lock.json` 顶部和 `packages[""]` 两处（部署清单 A3，照上一次的发版提交 `073c8cca`）。
2. **外壳版本要重新判，不能照部署清单 A3 写的「0.2.7 不动」。** 从 `release` 到现在的 `main`，`desktop/src-tauri/` 下动了四个文件共 215 行，新增了 `account_vault.rs`（桌面版保存可撤销的恢复凭证）和一份权限声明。照 `git_and_release.md`「版本号」那张表问一句：新的 Node 这一半放到旧外壳 0.2.7 上，还能不能照常跑？能降级跑（比如登录后不记住、每次要重输）就是第二行，外壳末位加一成 0.2.8，老用户还能用补丁；Node 硬依赖它就是第四行，两个中间位一起加，只能出完整安装包。这要读 `src/account/` 怎么调它才能定，本次没读。
3. `desktop/scripts/make-patch.mjs` 顶部的 `MIN_SHELL_VERSION` 现在是 `"0.2.0"`。账号任务书第 17 行要求补丁在「声明的最低外壳 0.2.0」和「现用外壳 0.2.7」两个隔离副本上都验过升级和回退，再凭证据决定这个常量要不要抬。
4. 版本号只在发版时改；先提交，再构建（`git_and_release.md`「构建」）。

### 6.3 安装包、补丁、release

1. 在 `desktop/` 下 `npm run release -- --from-head`，出完整安装包和兼容补丁，不能只出补丁（账号任务书「两仓库交付、部署与回退」第 4 条；设计第 380 行）。
2. 依赖比 0.7.17 多了 `sucrase`，补丁会带上整份 `node_modules`，比上一次的 17.9 MB 大得多（部署清单 A4 记的量级是约 196 MB）。要提前告诉用户。
3. 产物记路径、大小、SHA-256、来源提交（账号任务书第 16、17 行）。
4. 完整安装包在隔离的安装位置验：启动、账号路径、双击文件关联、旧文件转换；不覆盖用户在用的那份。补丁不在有 Agent 会话在跑的安装目录上装（`verification.md`「会造成真实损失的操作」）。
5. `release` 的三条合入条件（`git_and_release.md`「release 分支」）：基线全绿；`npm run build` 成功；这次动了桌面壳，所以 `desktop/` 下的发版构建也要成功。然后 `git checkout release && git merge --ff-only <发版提交>` 并推送。快进不了照 `release-fallback.md`：另建 `release_0.7.18` 并推送，不强推、不停。`release` 现在在 `073c8cca`，是 `main` 的祖先，正常能快进。

### 6.4 节点部署的顺序

两个仓库的先后（账号任务书「两仓库交付、部署与回退」第 1 条，设计「两仓库部署、备份、恢复与可撤销回退」第 4～7 步）：**账号后端先装并核对 → PromptCut 的服务和在线页面 → 依赖新接口的网页最后推**。VisuHive 的 `site/` 一推到 `main`，五分钟内自动上线并且会删文件。

PromptCut 这一侧照部署清单 C 节，三样东西必须出自同一个提交（清单 A6 和「先决条件」）：

| 步 | 做什么 | 之前备份什么 | 出处 |
|---|---|---|---|
| 0 | 一致的备份并实际恢复一遍：账号库用数据库自己的在线备份办法，不直接拷正在写的文件；文档、素材、对话、任务、服务登记表停写后做；配置、代码、nginx、在线页面、进程管理配置单列 | —— | 设计第 367、368 行；账号任务书第 204～206 行 |
| C1 | 先改 nginx：舞台的策略头、`/media-s/`、`/agent/`；`nginx -t` 过了再重载 | `/etc/nginx` 整份 | 部署清单 C1 |
| C2 | 换在线页面，只换静态文件 | 旧的 `editor/` 整份，保留 `runtime-config.json` | C2 |
| C3 | 重新部署账号、文档、素材三个服务 | 应用目录、进程管理配置；重启前后各做一次项目版本盘点 | C3、B3。**清单这一步是按旧的单进程托管服务写的，现在线上是三个独立服务，命令要照 `server/hosted/deploy/account-v2-install-plan.mjs` 重写，见第 8 节** |
| C4 | 部署渲染服务：装系统包、传代码、生成服务密钥、自检过了才启动 | 不用（新进程新目录） | C4 |
| C5 | 部署 Agent 服务：建目录、生成密钥、给文档服务加上 Agent 的公开地址、先用模拟模型验、再导入模型 Key | 进程管理配置 | C5。Key 的密文已在节点上，照 `three-versions-brief.md` 第 5 节用 `server/agent-service/import-key.mjs --file` 导入，核对末四位和能调通以后删掉那个文件 |
| C5 第 8 步 | Agent 工具要的运行条件逐项查：Python 库、模型权重、yt-dlp、配音配置、出网限制 | —— | C5 第 8 步那张九行的表 |
| 最后 | 推 VisuHive 的网页 | 记下网页的提交，回退时要推一个兼容的修复提交，不能只手改节点上的文件 | 设计第 373、378 行 |

每部署一样做那一样的实测，哪一样不过只退那一样（部署清单 E 节的回退表）。部署后把清单 F 节那几类信息记进 `docs/local.md`。

重启服务之前「等写入停止」那一条（清单 B4）这三个版本不当停点（`verification.md` 的临时例外），但备份和恢复验证不能省。

### 6.5 真实网络环境验收

这台 PC 经公网连节点，只用测试账号和测试项目，验完删（`verification.md`「产品交互验收与真实网络环境验收」）。

1. 运行器清单里的 16 项：先 `--list --level network` 打出来，逐条照部署清单 D0 做。D0 里的编号是 S1-r2、S1-r3、S2-r1、S3-r1～S3-r7、S4-r1、S4-r2、S4-r4～S4-r7（S 后面的数字是四段任务的第几段，r 是那一段在节点上实测的第几条）。其中 S3-r4（越权探测卡读不到）和 S4-r1 里的隔离是核心项，不过就停掉对应的服务。
2. 清单外的五条：延迟与断线重连、重启的中断时长与版本号前后不变、三样服务同一个提交（两次）、节点环境缺不缺东西。
3. 账号任务点名的：证书、同域的登录 cookie、两个舞台握手、新建、加入、两张列表、同账号换设备、踢人对全设备生效、旧票据和内部接口被拒、切私有立刻撤、改密退出与重连、真实工具、关掉发起方的软件以后任务继续并且预渲染入库（设计第 373 行）。
4. 甲三部署后的验收（`render-refactor-progress.md`）。
5. RS18 各组在真实网络下的复核（部署清单第 34 行）。
6. 真实模型的三遍：端到端、「关掉软件照常运转」六条、示例句（`cloud-agent-task.md` 完成条件第 8 条）。
7. 旧测试项目删除以后，用真实旧文件验转本地（账号任务书第 19 行）。

## 7. 要用户点头才能做的：删节点数据的清单

开工指令「要先问的」点了三类。清单每一条要写清：是什么、在哪、为什么能删、备份在哪。

| 类 | 文档里怎么写的 | 主会话要到节点上查什么（只查，不改） |
|---|---|---|
| 节点上的旧测试项目 | 账号任务书第 16 行：旧记录曾有 4 个云端项目，「数量不能当成当前删除清单」；第 206 行：「实施时列准确项目 ID、来源、目录、将删对象及明确保留对象；不按历史“4 个”直接删除」。交接计划书 4.3：旧的托管进程（pm2 里的 `promptcut-hosted`）已停。归档 `three-versions-main-stages-2026-10-09.md` 第 115 行：旧托管数据的完整备份在节点 `/root/promptcut-full-backup-20261009-account-cutover`，58,307 个文件、约 3.2 GB | 旧托管数据目录现在还在不在、在哪（设计第 361 行 10 月 8 日记的是 `/var/lib/promptcut/hosted`，切换以后是否仍是这个要核）；里面每个项目的标识、目录、引用的素材、持久任务；旧进程确实停着、没有别的东西在读这个目录；那份备份还在、大小和校验值对得上；备份能恢复是 10 月 9 日验的，删之前要不要再验一次由主会话定；哪些东西明确保留（删除记录、撤销记录不能删） |
| ChatGPT 留下的 5 个测试账号、2 个测试项目 | 进度文件第 90 行：「累计 5 个自建测试账号、两个项目还待准确清理」。交接计划书 4.5：「清之前要有准确清单，并且要用户确认」。归档 `three-versions-production-restore-2026-10-09.md`：10 月 9 日那份备份里是「6 个账号、两个项目」 | 账号库里现在一共几个账号、哪 5 个是它建的、第 6 个是谁的（很可能是用户自己的，**不能删**）；两个项目的标识、创建者、成员、对话、素材目录；这些账号在网站上有没有还有效的登录；10 月 9 日以后有没有新增的账号或项目（开工指令「什么时候停」第 4 条：有不认识的数据就停相关的那部分）；当前生产的备份 `/root/promptcut-v2-consistent-20261009-b9fb4c8d8e5c` 还在。另外：主会话这次自己建的测试账号和项目不进这份清单，照 `verification.md` 验完就删 |
| 模型 Key 的密文 | `three-versions-brief.md` 第 5 节：在节点 `/root/promptcut-pending/agent-model-key.blob`，「导入成功、核对过末四位和能调通之后，把这个文件删掉」。设计第 372 行：只有 root 能读、289 字节；「失败留 cipher 并停对应调用路径，不盲删」 | 文件还在、权限和大小没变（不读内容）；Agent 服务部署以后导入成功、末四位和 `docs/local.md` 记的一致、两个模型各真实调通一次，这三样都有了才把它列进清单。它的「备份」是用户手里的原 Key 和导入后落盘的那份，清单里照实写 |

几点要一并告诉用户的：

- 备份本身不在删除范围里（账号任务书第 206 行「备份删除不在此授权中」；设计第 369 行）。
- 删旧项目以后，文档服务要留下「这个项目已不存在」的记录，旧文件转本地靠它（设计第 374 行「权威 tombstone 保留」）。所以第 5 项的代码要先于删除做完，否则删完验不了。
- 一步验不过就停，不接着删（账号任务书第 19 行「失败停止追加删除，核对备份恢复」）。
- 阿里云那台不碰，上面的旧数据用户自己处理。

## 8. 读文档时发现的对不上的地方

### 文档和现在的 `main` 对不上

1. **部署清单的 C3、B1、B3 是按旧的单进程托管服务写的。** 清单用 `deploy-hosted` 换应用目录并重载 pm2 的 `promptcut-hosted`；交接计划书 4.3 写的线上现状是三个独立服务 `promptcut-account-v2`、`promptcut-doc-v2`、`promptcut-asset-v2` 在跑，pm2 的 `promptcut-hosted` 已停。`scripts/remote/docservice.mjs` 里现有的命令还是 `deploy-hosted` 那一套加渲染和 Agent 的，没有对应三个新服务的；新的安装办法在 `server/hosted/deploy/account-v2-install-plan.mjs`。部署前这一段要重写。清单文首 2026-10-08 的补记没有提这件事。
2. **部署清单 A3 写「外壳版本 0.2.7 不动」，现在不成立**：`release` 到 `main` 之间桌面壳的 Rust 代码动了（第 6.2 节）。清单的依据是四段任务当时的差异。
3. **Agent 服务的端口**：设计的裁定第 13 条说节点上 8790 已被账号服务占着，Agent 要明确配 8791；`server/agent-service/main.mjs`、`deploy.mjs` 的缺省和 `nginx-location-agent.conf` 的注释仍是 8790，部署清单 C1 第 4 步和 F 节也写 8790。照缺省部署会起不来。
4. **「满五分钟才让位」没落到代码**：2026-10-09 用户定的；`server/hosted-render/isolation.mjs` 还是 60 秒闲置回收、45 秒看画面切换（第 3 项）。
5. **对话满了自动删最旧的那段代码还在**：`server/agent/service/conversations.mjs` 的 `evictOld`（第 168～179 行，新建对话时在第 216 行调用）。用户定的是不自动删。账号模式另有一处在前面拦了（`conversation-authority.mjs` 第 219 行），所以云端项目大概走不到 `evictOld`；它在哪些路径上还生效，本次没有追到底，做第 4 项时要核。
6. **写死路径的三个测试文件里有一个用的是另一个变量名**：`server/test/account-projects-provider.test.mjs` 读的是 `ACCOUNT_PROVIDER_DIR`，另两个读 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`。照 `verification.md`「基线」只设那两个变量时，这个文件仍然退回写死的路径 `…/VisuHive/.worktrees/018-account-foundation`，而这个目录现在已经不存在（VisuHive 的工作区清过了），于是它判成「没有账号后端」而跳过相关用例。也就是说现在的全量测试里这一组很可能一直是跳过的。修的时候把变量名统一。
7. **交接计划书第 6 节第 3 步**预计合缺素材分支「要在 `src/render/` 和 `server/bakery/` 解冲突」：对现在的 `main` 试合并是零冲突（第 3 节）。渲染重构剩下的块做完以后会不会冲突是另一回事。
8. **交接计划书第 5.2 节**写缺素材分支「`fcb2e204`，领先 2，远端没有」「工作区里还有 6 个文件没提交」，现在是 `01ff6ba5`、领先 3、已推远端、工作区干净。这一条它自己的第 9 节已经更正，正文没改，读的时候以第 9 节为准。
9. **`three-versions-brief.md` 第 4 节**写 `claude/four-stage` 在 `301c3092`、比 `main` 多约 270 个提交，是 10 月 8 日的现场；现在在 `bea0d881`，内容已全部在 `main` 里。同一节「运行器只在集成分支上」也过时了，`main` 上已有 `scripts/acceptance/`。
10. **`release-timings.md` 里已有「0.7.18 候选」一节**，是四段任务时生成的，不是这次要发的 0.7.18。

### 文档之间对不上

11. **对话删除的细则**，账号任务书已写「2026-10-12 用户已定」，但下面几处还写着「待确认」：`cloud-agent-task.md` 第 17 行、`account-binding-contract.md`「50 个不同对话与删除入口」整节、`render-scheduling-supplement.md` 第 5.1 节末条、设计第 37 行、工具拆包第 11 行、部署清单第 31、38 行。
12. **「有人排队时能不能未满五分钟提前让位」和「预渲染卡住以后怎么办」**，账号任务书和补充文档第 5.2 节已写 2026-10-09 用户定了，但 `cloud-agent-task.md` 第 22、23 行、`render-scheduling-supplement.md` 第 3.4 节、设计第 35、270、272 行、工具拆包第 11、86 行、部署清单第 38 行还把它们当待确认。
13. **`cloud-agent-task.md` 完成条件第 12 条**写「出下一个版本号的补丁」，账号任务书和设计第 380 行要求完整安装包加兼容补丁。部署清单 A4 文首已标被取代，任务书这一条没标。
14. **`cloud-agent-task.md` 第 9 行**写「合入、出 0.7.18、部署…都在最后那一次完整验收里做」，是四段连做时的节奏；现在照 `three-versions-brief.md` 第 11 节，小阶段过了门槛就进 `main`。
15. **账号任务书开头**仍写「计划未定稿，功能未实施」「本轮用户只授权更新计划和相关文档」，是 10 月 8 日的状态。任务书第 69 行自己说明了这一点，但开头那句没改，容易被读成现在不许动手。
16. **进度文件「现在在哪」和「派出去的活」**是 10 月 9 日 ChatGPT 最后一次更新的：写着 Sol、Luna、Astra 各占一个工作区在做。这些会话都停了。开工指令要求 0.7.18 接着在这份文件里记，接手时先把这两节改成现状。
17. **「约 25 个工具」和「23 个」**：账号任务书、`cloud-agent-task.md` 说约 25 个；设计和工具表是 23 个待定，另加三个要发起人在线的和可视化收尾。验收时以工具表的 128 个逐个有归类为准，不要按 25 这个数对。
18. **测试账号的数目**：开工指令和进度文件说 5 个测试账号，恢复归档说备份里有 6 个账号。多出的一个要在节点上认清（第 7 节）。
19. **设计的分包表**（19 个包、`codex/` 分支名、Sol/Luna/Astra、端口段 5740～5929）是给 ChatGPT 写的。文件清单和依赖顺序仍可参考，分支名、模型、谁建工作区都不适用；其中已经做完进了 `main` 的包和没做的包，表里没有标。
20. **`cloud-agent-task.md` 第 4 条完成条件**里「只读成员」一句已照 2026-10-08 的更正改过，但现行语义里没有只读成员这种身份；这一条的探针怎么断言要先定（设计第 16 行的说法是「发消息就拒只读」）。

### 没查清、要主会话留意的

- 桌面壳新增的凭证保管，旧外壳上能不能降级跑（第 6.2 节）。
- 云端 Agent 看画面读的是哪种预渲染产物；快照作废以后要不要跟着改（`html-snapshot-removal-dryrun.md` 第 9 节也留了这个问题）。这关系到第 3 项后一半怎么做。
- `codex/018-run-assets-current-v2`、`018-agent-immediate-revoke`、`018-cloud-assets-central-glue` 三条分支上「`main` 没有」的文件（分别 28、7、21 个），哪些是还要的、哪些已经用别的写法进了 `main`，交接计划书说没有逐文件核过，本次也没核。做块六之前要核，核完才谈得上清这三条分支。
- 节点上的一切：本次没连。第 7 节和第 6.4 节里凡是「现在线上是什么样」的说法都出自 10 月 8 日到 10 日的文档。
