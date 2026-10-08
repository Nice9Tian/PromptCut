# Cloud Agent 工具缺口与复用清单

本清单是给 0.7.18 分包派活的静态源代码和契约核对，不是实施承诺或验收报告。工具入口以当前固定源码 `8b255ab4d0f261415664c3822aff25ad24ac1e79` 为准；文中“代码可达”只说明存在调用路径，不代表账号版真实闭环、节点部署或生产能力已通过。

## 范围与判定规则

用户已定 0.7.18 完成旧第四阶段剩余云端 Agent 工具。云端工具范围仍按本机工具一致；只有实际操作发起人界面的能力可在发起人离线时回清楚的 offline 结果。下表合并旧契约 `CLOUD_TOOL_PLAN` 的 23 个 pending、4 个旧 initiator 页面能力中账号版尚未满足的行为，以及旧 HANDOFF 指出的 `get_gif` 用户可见结果缺口。清单覆盖 30 个待实现或待重新实现的工具/用户可见行为；32 行是因为 `see_frames(source: "media")` 和 `get_gif` 用户可见记录分别单列为既有工具的模式/结果缺口。`spawn_agent` 单列为明确延后项，不计入这批。

“实际 hosted 路由”分三层看：

1. `cloud-tools.mjs` 将能力纳入/排除模型工具清单；
2. Hosted Agent 的实例入口路由至项目副本、反向页面通道或 `hosted-tools.mjs`；
3. `account-runner.mjs` 可按 doc 发的 run grant 创建现有 Hosted 实例、注入 `createHostedTools`，并调用 `startHostedRun`。因此已实现 Hosted 工具在账号版代码里有复用路径；但账号版 runner 测试主要使用模拟 `runnerFactory`，没有逐个工具的账号版真实端到端运行证据。任何旧云端测试/探针结果都不能替代账号版产品验收或 Linux 节点验收。

## 已有 hosted 实现的复用面

| 工具范围 | 入口/复用代码（源码:行） | 现有直接测试/探针 | 对账号版的判断与未验边界 |
|---|---|---|---|
| 已有的 `hosted` 工具 20 个：`import_media`、`voice_list`、`voice_generate`、`sound_generate`、`sound_status`、`sound_cancel`、`measure_audio`、`render_card_audio`、`cancel_card_audio`、`card_authoring_guide`、`get_card_source`、`create_card`、`edit_card`、`collect_status`、`collect_install`、`collect_search`、`collect_probe`、`collect_download`、`collect_job`、`collect_logout` | `server/agent/service/cloud-tools.mjs:33-101` 分类；`server/agent/service/hosted-tools.mjs:208-214, 790-824` 聚合；各实现 `hosted-audio.mjs`、`hosted-card-audio.mjs`、`hosted-collect.mjs`、`hosted-sound.mjs` | `server/test/cloud-agent-service.test.mjs` CA-TOOL-02 hosted 名称对账；`cloud-agent-collect.test.mjs`、`cloud-agent-audio.test.mjs`、`cloud-agent-card-audio.test.mjs`、`cloud-agent-sound.test.mjs`；`scripts/probes/cloud-agent-sound-probe.mjs` | `server/agent/service/account-runner.mjs:24-38, 57-75` 同样创建 hosted tool factory 并通过 `createAgentInstance` 运行；非 account 模式实际覆盖不能据此写成 account-v2 已验。账号版具体真实服务票据、账号授权、工具调用和结果呈现仍需新版集成证据。采集当前测试使用 downloader 替身；Linux 实际 Python/yt-dlp/ffmpeg 与托管配置未核。 |
| 已有 `route` / `look` 工具：其余本机工具经服务端项目副本执行；画面四工具为 `see_frames`（timeline）、`get_gif`、`bake_card`、`inspect_card_dom`，`get_layout` 可选渲染量框；`render_card_audio` 两工具另走 look | `server/agent/service/instance.mjs:505-535, 1480-1495`；`server/agent/agent-exec.mjs:448-522, 578-602`；`server/agent-service/look-client.mjs`；渲染白名单 `server/hosted-render/look.mjs:74-86` | `server/test/cloud-agent-look.test.mjs`、`cloud-agent-card-audio.test.mjs`；`scripts/probes/cloud-agent-look-probe.mjs`、`cloud-agent-isolation-look.mjs`、`cloud-agent-isolation-probe.mjs` | account runner 创建现有 hosted Agent instance 并传 `look` 参数，源代码支持复用；account-v2 生产 look URL/渲染身份、跨服务权限、部署配置、渲染故障和真实成员可见结果仍需独立核。历史探针不是本叶运行结果。 |

已存在的本机工具实现不是 hosted 服务端实现。入口汇总见 `src/mcp/routes.mjs`、`src/mcp/handlers/ai.ts`、`src/mcp/handlers/collect.ts`、`server/web/` 与 `server/vite-plugin-web.ts`；只有下表明确标为 hosted 时才算已有云端服务端路由。

## 缺口逐项清单

| 工具 / 能力 | 当前 cloud 入口（源码:行）与现状 | 可复用实现 | 直接相关测试或探针及真实覆盖 | 生产/账号版未验边界 | 依赖 |
|---|---|---|---|---|---|
| `stt_status` | `cloud-tools.mjs:69`，`pending`，不会交给云端模型 | `src/mcp/handlers/ai.ts` 的本机作业状态与模型状态查询 | `server/test/stt-install.test.mjs` 只涉及安装展示/状态显示；`server/test/cloud-agent-service.test.mjs` CA-TOOL-01 只证明云端明确拒绝，不证明识别可用 | 无 hosted 识别服务/账号版 job；本机状态测试不是节点安装/状态证据 | Python 运行时、语音识别引擎/权重、持久作业表、实例/对话授权 |
| `stt_install` | `cloud-tools.mjs:69`，`pending` | `src/mcp/handlers/ai.ts` 本机扩展包安装与进度处理 | `server/test/stt-install.test.mjs` 为本机安装状态/界面反馈；没有云端隔离安装验收 | 云端不能把包安装动作委托给用户界面或本机；节点依赖和权限未验 | Python 环境、下载/安装策略、扩展包存储、持久作业/进度 |
| `transcribe_media` | `cloud-tools.mjs:69`，`pending` | `src/mcp/handlers/ai.ts` 本机语音识别；已有通用素材访问/音频辅助代码 | `server/test/perception-asset-path.test.mjs`、`server/test/stt-install.test.mjs`；`scripts/probes/stt-smoke.mjs` 是本机 MCP 冒烟，不是 hosted | 没有云端模型结果/字幕写回的账号版端到端证据，也没有 Linux 权重/时限证据 | 项目素材服务读票据、隔离临时素材、Python/模型权重、后台作业与 cancel/restart 状态 |
| `detect_shots` | `cloud-tools.mjs:70`，`pending`；`see_frames(source:"media")` 也依赖此识别 | `src/mcp/handlers/ai.ts` 镜头分析与 `src/mcp/handlers/vision.ts` 镜头拼图 | `server/test/perception-asset-path.test.mjs` 仅本机路径/素材；cloud CA-TOOL-01 是拒绝断言 | 无 hosted 镜头作业；输出、素材访问、模型和节点部署均未证明 | Python/模型、项目素材授权、作业表；下游见 `see_frames(source:"media")` |
| `track_points` | `cloud-tools.mjs:71`，`pending` | `src/mcp/handlers/ai.ts`、`src/mcp/tools/trackTools.ts` 本机追踪 API | `src/mcp/tools/trackTools.test.mjs`、`server/test/perception-asset-path.test.mjs` 本机单元/资产路径；不证明 hosted | 云端未启动隔离追踪作业，也无真实云端输出 | Python/模型（基础/扩展）、素材服务、实例级 job/进度/取消 |
| `get_track` | `cloud-tools.mjs:71`，`pending`；依赖 `track_points` 作业结果 | `src/mcp/handlers/tracks.ts`、`src/mcp/tools/trackTools.ts` 本机读作业/结果 | `src/mcp/tools/trackTools.test.mjs` 和本机工具测试；无 account-v2 追踪结果 | 云端重启后恢复、跨实例隔离与完整结果状态未验 | 持久 job store、对话/项目隔离、追踪产物 |
| `track_status` | `cloud-tools.mjs:72`，`pending` | `src/mcp/handlers/ai.ts` 本机引擎/后台状态 | `server/test/perception-asset-path.test.mjs` 本机状态路径；`cloud-agent-service.test.mjs` 只测拒绝 | 云端引擎与 job 状态无真实服务证据 | Python/权重状态、实例授权与后台作业 |
| `track_install` | `cloud-tools.mjs:72`，`pending` | `src/mcp/handlers/ai.ts` 本机扩展安装 | 本机测试有安装状态显示；cloud 侧仍被 CA-TOOL-01 明确拒绝 | 云端下载、安装隔离/权限/容量未验 | 可配置 Python、模型/包分发、后台作业与资源限制 |
| `detect_subjects` | `cloud-tools.mjs:73`，`pending` | `src/mcp/handlers/ai.ts` 本机主体识别 | `server/test/perception-asset-path.test.mjs` 仅本机素材路径/handler；无 cloud 实现测试 | hosted 模型/权重、真实浏览器/渲染结果未验 | Python/模型、素材授权、持久作业与输出核验 |
| `subject_status` | `cloud-tools.mjs:73`，`pending` | `src/mcp/handlers/ai.ts` 本机引擎状态 | `server/test/perception-asset-path.test.mjs` 本机状态；云端拒绝只由 CA-TOOL-01 覆盖 | 云节点安装和 account-v2 运行时状态未验 | Python/模型状态、授权作业表 |
| `subject_install` | `cloud-tools.mjs:73`，`pending` | `src/mcp/handlers/ai.ts` 本机安装流程 | 本机 handler/界面测试；云端没有相应 hosted 路由测试 | 不知道生产节点权重/包安装状态；不能把本机扩展包安装视为云端安装 | Python、主体模型权重、安装隔离、作业进度/资源限制 |
| `attach_clip_motion` | `cloud-tools.mjs:74`，`pending`，明确依赖追踪结果 | `src/mcp/handlers/ai.ts` 从已有 track 结果绑定卡片参数的逻辑 | `server/test/perception-asset-path.test.mjs` 可覆盖本机追踪数据读取；无 hosted 输出和写回证据 | 依赖的追踪产物云端不存在；账号版写权限/提交也未测 | `track_points`/`get_track` hosted job、项目写 grant、写入提交与冲突处理 |
| `measure_audio_js` | `cloud-tools.mjs:65`，`pending`；普通 `measure_audio` 已 hosted，但此工具不在 hosted 集合 | `src/mcp/common.ts:186-223`、`src/mcp/handlers/audio.ts`、`server/vision/` 自定义 JS 运行；重用现有受限 WAV/PCM 输入和看护设计 | `server/test/custom-measure.test.mjs`、`server/test/creativity-gate.test.mjs`；`scripts/probes/custom-measure-probe.mjs` 本机进程/沙箱探针，不是账号 hosted | 服务端无此 tool route；没有按 account run grant、离线浏览器、不联网隔离的生产证据 | 素材服务只读 ticket、临时 PCM、断网无头浏览器或渲染 worker 跑脚本、超时/内存配额、项目/对话边界 |
| `see_frames` (`source:"media"`) | 工具已有 route/look；`cloud-tools.mjs:139-143` 明确拒绝素材拼图，只支持 timeline | `src/mcp/handlers/vision.ts` 本机 `seeSequences`/素材拼图；`server/vision/routes.ts` 有 `/api/vision/sheet` 本机 endpoint | `server/test/cloud-agent-look.test.mjs`、`scripts/probes/cloud-agent-look-probe.mjs` 覆盖已有 timeline 看画面；本机素材拼图测试不证明 cloud media mode | 账号 runner 的 look 仅可服务端向渲染服务取帧；该路由没有接入 media-source 模式/识别 | project media id 与素材服务授权、镜头识别/时间点、渲染或拼图 endpoint、隔离 worker |
| `web_open` | `cloud-tools.mjs:89`，`pending`；当前 web 工具走本机编辑器 API | `src/ai/web.ts:59`、`server/web/browser.mjs`、`server/vite-plugin-web.ts` | `server/test/web-module.test.mjs` 是本机浏览器交互；没有 cloud browser route/账号服务端测试 | 不能把本机 persistent browser 复用成云端每对话会话；公网节点出口、隔离和真实浏览器尚未验 | 每对话独立浏览器/user-data-dir、无头浏览器、出网闸、防内网/同机访问 |
| `web_view` | `cloud-tools.mjs:89`，`pending` | `src/ai/web.ts:60` 与 `server/web/view.mjs` | `server/test/web-module.test.mjs` 覆盖本机截图/页面显示；非 hosted | 无 account-v2 中保存会话的隔离浏览器状态 | `web_open` 浏览器会话、截图/文本结果格式、资源限额 |
| `web_click` | `cloud-tools.mjs:89`，`pending` | `src/ai/web.ts:61`、`server/web/hit.mjs` 本机坐标/元素点击 | `server/test/web-module.test.mjs` 本机校验/点击；不覆盖云端代理、项目授权 | hosted route 不存在；未实测云端浏览器站点交互 | 同一隔离浏览器会话、selector坐标失效处理、出网策略 |
| `web_type` | `cloud-tools.mjs:89`，`pending` | `src/ai/web.ts:62`、`server/web/hit.mjs` 本机文本录入 | `server/test/web-module.test.mjs` 本机输入/校验 | hosted route 不存在；未在服务端验证敏感字段拒绝与账号隔离 | 隔离浏览器会话、敏感凭据禁止输入、调用限时 |
| `web_scroll` | `cloud-tools.mjs:90`，`pending` | `src/ai/web.ts:63`、`server/web/view.mjs` 本机滚动实现 | `server/test/web-module.test.mjs` 本机交互 | 无服务端调用/运行环境证明 | 同一隔离浏览器会话、页面脚本不当成指令 |
| `web_read` | `cloud-tools.mjs:90`，`pending` | `src/ai/web.ts:64`、`server/web/view.mjs` 本机页面读取 | `server/test/web-module.test.mjs` 本机文本读取 | 无 hosted 网页读取结果/多对话隔离测试 | 隔离浏览器会话、输出长度限制、站点内容视为不可信数据 |
| `web_close` | `cloud-tools.mjs:90`，`pending` | `src/ai/web.ts:66`、`server/web/browser.mjs` 本机关闭浏览器 | `server/test/web-module.test.mjs` 本机生命周期 | 未验云端对话结束/重启时浏览器和目录实际清理 | 单会话浏览器生命周期、子进程关闭确认、profile 私有临时目录 |
| `web_handoff` | `cloud-tools.mjs:91`，标旧 `initiator`；云端现在无 hosted page bridge | `src/ai/web.ts:65`、`server/web/session.mjs` 本机把窗口交给用户 | `server/test/web-module.test.mjs` 本机 handoff；`cloud-agent-page.test.mjs` 只证明旧 page-tools 四个白名单 | 账号 runner 对所有发起页面一律 offline，尚无 account-v2 在线 handoff；不得误复用一个云端 headless 浏览器窗口冒充发起人自己的界面 | 在线 PC 页面反向请求与安全授权、交接/恢复UI、发起人离线时明确 offline |
| `collect_login` | `cloud-tools.mjs:87`，旧模式 `initiator`，仅告知“登录窗口”且实际不支持 cloud flow | `src/mcp/handlers/collect.ts` 本机 login dialog 流程；现有 `hosted-collect.mjs` 只负责 anonymous cloud downloader | `server/test/cloud-agent-collect.test.mjs` 只核 anonymous/不保存cookie；本机 `collect` 插件测试覆盖本地登录窗口 | 当前错误文案是旧实现状态；不能上传cookie或站点登录信息给云端，account-v2 尚无 PC 代下 bridge | 发起PC在线 local sidecar 下载/本地浏览器登录、只传下载字节/附件到云端素材导入、无登录回退匿名 |
| `collect_login_check` | `cloud-tools.mjs:87`，旧模式 `initiator`；无本机代下状态检查桥 | `src/mcp/handlers/collect.ts` 本机登录检查/状态流程 | 同上；无 hosted / account-v2 跨端验证 | 需要 PC 本地保存/查询登录态但绝不把 cookie/凭证传节点；代下失败须切匿名 | 发起PC在线桥接、local-only auth state、任务状态/错误结果回发、匿名回退 |
| `get_selection` | `cloud-tools.mjs:36,160` 与 `instance.mjs:1368-1390` 是旧的单发起页/消息快照行为；新决定要求同项目所有在线成员选区并标用户名 | 本机 `src/mcp/handlers/project.ts` 选区读取；旧云端页面通道 `instance.mjs:1310-1390` | `server/test/cloud-agent-page.test.mjs` CA-REV-02/旧快照测试；`server/test/account-assembly-selection-capture.test.mjs` 测账号版已验证发送时快照的可信性，不覆盖所有在线成员实时选区 | account runner 当前只能回从持久消息核验的发起人快照；他在线时仍无 all-member live selection 汇集；不能把旧 CA-REV 测试算新语义验过 | 项目内在线页面 presence/选区上报、账号/项目授权、按用户标名、发起者 snapshot 和非实时标记 |
| `seek` | `cloud-tools.mjs:96` 是旧 cloud page tool；账号 runner `account-runner.mjs:61-62` 显式 `initiatorOnline: false` 与 offline `pageCall` | `instance.mjs:1310-1365` 旧 page bridge；`src/ai/cloud/pageRequests.ts` 本机白名单 | `cloud-agent-page.test.mjs`、UI `scripts/probes/cloud-agent-ui-probe.mjs` 覆盖旧 hosted online 反向通道 | account-v2 任何当前消息都被当离线，没证明在线页面能 seek；旧探针属非 account-v2 | 在线 PC 页面通道、经验证发送者与当前 run/message 绑定、超时/页面离线处理 |
| `play` | `cloud-tools.mjs:96` 旧 cloud page tool；account runner 默认 offline 同上 | 旧 `instance.mjs` reverse page channel、`src/ai/cloud/pageRequests.ts` | `cloud-agent-page.test.mjs`、`cloud-agent-ui-probe.mjs` 旧 Hosted UI | account-v2 live page request 未接/未验 | 同 `seek`；明确离线继续 |
| `pause` | `cloud-tools.mjs:96` 旧 cloud page tool；account runner 默认 offline 同上 | 旧 `instance.mjs` reverse page channel、`src/ai/cloud/pageRequests.ts` | `cloud-agent-page.test.mjs`、`cloud-agent-ui-probe.mjs` 旧 Hosted UI | account-v2 live page request 未接/未验 | 同 `seek`；明确离线继续 |
| `background_job_status` | `cloud-tools.mjs:98`，`pending`，但 desktop 端已有跨作业查询 | `src/mcp/handlers/system.ts` 本机多作业状态；依赖 stt/track/subject job 模块 | 旧 tool schema/本地作业测试；`cloud-agent-service.test.mjs` 仅拒绝 | hosted 没有账号隔离的统一 job registry；只做 status 而不迁移作业不是可用闭环 | 所有 hosted perception job 的持久 store、project/conversation scope、授权读 |
| `auto_workflow` | `cloud-tools.mjs:99`，`pending`；本机组合式任务 | `src/mcp/tools/autoWorkflow.ts`，本机调用识别、卡片/片段工具的顺序编排 | 没有 cloud auto workflow 测试；本机流程实现，不是服务端实现 | hosted 系统缺相关识别作业及多次项目变更；账号版 run grant 是否跨工作流安全复核未验 | `transcribe_media`、多步业务/事务与失败补偿、项目写 grant、job 状态 |
| `auto_workflow_status` | `cloud-tools.mjs:100`，`pending` | `src/mcp/tools/autoWorkflow.ts` 的本机 job polling | 无 account-v2 或 hosted job status 测试 | 本机作业表不在云端进程；无重启/隔离证据 | hosted `auto_workflow` job registry、持久结果与授权查询 |
| `get_gif` 用户可见图像记录 | 工具已有 cloud look route，但 `cloud-tools.mjs:132-136` 目前主动剥掉 `visualId` 与 `gif`，并注明聊天栏看不到动图 | `server/agent/agent-exec.mjs:499-502` 取得图片、`server/hosted-render/look.mjs:74-82` 允许渲染；HANDOFF-four-stage 第 10 节收工方案仅供参考 | `cloud-agent-look.test.mjs`、`cloud-agent-look-probe.mjs` 只覆盖模型取图/渲染路由；旧 `cloud-agent-ui-probe` 未证明用户能打开 cloud visual 记录 | 聊天事件与图片/对比视觉记录存储、账号权限读取和 UI 展示没有合并方案实现；HANDOFF 的未合并草案不能算已交付 | 渲染产物推素材服务或账号授权的可视化存储、cloud visual id、事件/UI加载、跨用户权限 |

### 明确不计入“剩余约 25 个”的用户决定

| 工具 | 已定行为 | 代码现状和处理含义 |
|---|---|---|
| `spawn_agent` | 0.7.18、0.7.19、0.7.20 都关闭，放 0.7.20 之后；调用必须明确回「云端暂不支持开子 Agent」。 | 当前 planner `cloud-tools.mjs:94` 仍把它列成 `initiator`，并在在线时给旧的“新对话委托未接”原因；这与明确决定不符。它是需要对齐的旧代码行为，不是 0.7.18 补工具工作。不得将其实现成新的云端工作流。 |
| `collect_login` / `collect_login_check` 的含义 | 云端素材采集默认匿名；需登录态时发起人的电脑代下，登录信息不离开电脑；代下失败或离线退回匿名。不上传 cookie。 | 上表作为“本机代下桥接仍缺”列入当前任务能力，但历史 `login` 窗口不等于已选方案。 |
| `get_selection` 的语义 | 同项目所有在线成员的选区都要读到并标用户名；本轮发起人标“当前用户”；发起人离线时使用发送时快照并说明非实时。 | 旧“只读发起页、无页面时退回同成员快照”规则已作废。 |
| 用户卡与图卡外链 | 在线浏览器的用户卡/图卡和引用外链资源在所有浏览器正常加载；这三个版本不做旧的卡片出网护栏。 | 不得把 web browser agent 的独立出网风险/防内网要求套到卡片资源上；两者不是同一调用路径。素材仍不能跨项目读取。 |

## 分工时需要保留的验收边界

- 0.7.18 的工具目标来自 `docs/plan/account-binding-task.md`“三个版本”与 `docs/plan/cloud-agent-task.md` J；新增任务不能把 `cloud-agent-contract.md` 历史 105 工具/旧探针通过改写为本期已验收。
- 账号版运行结构复用已存在：`account-runner.mjs:24-75` 取得持久 run grant 后复用 `createHostedTools`、现有 `createAgentInstance` 和 `startHostedRun`。实际工具调用证据缺口是明确的：`server/test/agent-runner-read.test.mjs` 的 runnerFactory 是 mock，只数模型/工具回调；未逐个调用 Hosted tool；同样不代表主服务的 Linux/生产部署。
- 新用户决定要求不能只改工具提示词：登录素材采集必须实装 PC 本地代下桥；选区要汇总所有在线成员；spawn_agent 要停在稳定文案；所有工具授权/实例绑定仍需 account-v2 的有效项目与消息/run grant。
- 本次只做静态审查；没有运行服务、probe、测试、安装依赖、访问节点或读取生产凭证。具体分块、接口/验收的新实现设计由 root/Sol 单独定夺；本文的技术建议只是为分包标注依赖，不是用户批准的新产品语义。

