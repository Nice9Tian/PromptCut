# 0.7.18 云端 Agent 剩余工具：可派工接口与依赖

2026-10-08；工程拆包建议，**不是**新增产品决定、已实现声明或验收记录。基底 `bb0266fa`。语义来源为 [账号任务书](account-binding-task.md)、[云端 Agent 任务书](cloud-agent-task.md)、[三版本设计](three-versions-018-design.md)、[工具缺口清单](cloud-agent-tool-coverage.md)与[渲染补充](render-scheduling-supplement.md)；同名旧契约与源码的历史说明不能覆盖这些新决定。以下拟议模块名、字段、失败码、分包是实施接口，接线者可在不改语义的前提下细化。

## 当前真实起点和不可跨越的边界

`cloud-tools.mjs` 仍将感知／工作流 15 项、浏览器 7 项和 `measure_audio_js` 共 23 项列为 `pending`。已有 Hosted 工具 20 项与 timeline 看画面的代码路径只说明复用可能；旧 Hosted 测试、桌面 Python 测试都不是账号版逐工具端到端证明。全员选区叶 `3f17b10a` 已用真实 doc 通道与模拟模型运行实际 Agent 工具路径；生产实例注册、mTLS 全链和真实模型仍须中央组合验证。`account-runner.mjs` 已有逐模型／工具 `beforeToolCall` 闸，`run-client.mjs` 有 doc mTLS run API；本计划不能以模型自报的项目、发送者、页面或票据替代 doc grant。

已定范围：云端工具原则上与本机一致；仅操作发起人本人界面的能力在其离线时明确返回 offline。`spawn_agent` 在 .18、.19、.20 均固定回「云端暂不支持开子 Agent」，另由已有 owner 对齐；不列为本批可实现工具。用户卡、图卡及其外链资源正常加载，不把下文**Agent 浏览器**防内网规则套在卡片资源上。账号授权、对话共有／私有、当前轮保留、stop／Agent 关闭的优先级，沿用 doc/run authority，不由工具层创造新例外。删除权限和名额释放细节、未满五分钟提前让位、补渲故障 A/B 仍待确认，不放进本批默认行为。

RS18 云端**单活跃项目**且合格本地即时查询帧优先；RS19 只有项目级与总体预算实测满足才尝试双项目；RS20 用磁盘缓存和交替加载争取至少三个项目持续推进，不承诺三个重型项目常驻。每个生产容量场景都含用户自定义卡片。`see_frames` 端到端低于五分钟是优先目标，尚非保证或通过项；从接收请求到调用方可读完整所需帧的计时口径是技术建议，待接入契约时定稿并记录排队、素材、加载、渲染和返回各段。

## 所有工具复用的窄接口（先实现，不先翻工具表）

下列接口是**拟议的内部 API**。`ToolRunContext` 只能从 doc 已确认读消息后的当前 run grant 和 Agent 实例注册证明构造，不能从工具参数、页面 POST 或缓存的 username 构造：

```ts
type ToolRunContext = Readonly<{
  projectId: string; conversationId: string; runId: string;
  runGrantId: string; instanceId: string; instanceGeneration: number;
  senderAccountId: string; messageId: string;
}>;

interface RunAccess {
  authorize(context: ToolRunContext, action: 'read'|'write'): Promise<{
    allowed: true; fenceRevision: number; grantState: 'active'|'retained';
  }>;
  signalFor(context: ToolRunContext): AbortSignal;
}

interface ProjectAssets {
  openRead(context: ToolRunContext, mediaId: string): Promise<{stream: ReadableStream; mediaRev: string; kind: string}>;
  import(context: ToolRunContext, bytes: ReadableStream, meta: {name: string; kind: string; sourceJobId?: string}):
    Promise<{projectId: string; mediaId: string; hash: string; size: number; mediaRev: string}>;
  verifyRef(context: ToolRunContext, ref: {projectId: string; hash: string; size: number}): Promise<{mediaId: string; mediaRev: string}>;
}

interface ToolJobs {
  start(context: ToolRunContext, kind: string, inputDigest: string, requestId: string): Promise<{jobId: string; state: 'queued'|'running'|'done'|'error'|'cancelled'|'interrupted'}>;
  update(context: ToolRunContext, jobId: string, revision: number, patch: object): Promise<void>;
  get(context: ToolRunContext, jobId: string): Promise<object>;
  cancelForFence(context: ToolRunContext, fenceRevision: number): Promise<void>;
}

interface CloudToolProvider {
  handles: ReadonlySet<string>;
  call(name: string, args: unknown, context: ToolRunContext): Promise<unknown>;
  close(reason: string): Promise<{childrenClosed: boolean; streamsClosed: boolean; workPending: number}>;
}
```

建议工厂统一 `createXTools({context, assets, workspace, jobs, runAccess, ...serviceDependencies}) -> CloudToolProvider`。服务配置、mTLS 身份和实例注册由宿主可信注入，工具参数里不收 `projectId`、`runGrantId`、`instanceId` 或本地绝对路径。**每次**读取受权素材、提交项目修改、跨进程返回产物、读 job/visual/page 答案前，以 doc 当前 grant/fence 和项目 ACL 重验；“已读后共有轮可保留”的决定只按 run authority 返回的精确 current grant 执行，private/stop/Agent off 优先撤销。授权/上游不可达 fail closed，不能退回旧 LAN 用户名或未经核验缓存。`read` 可由只读成员用，项目变更和资产导入需 `write`，不借项目创建者身份赋 Agent 特权。`close()` 对本实例持有的子进程、socket、流、计时器、未完成 dispatch 要等实际退出／close 证据；旧实例资源未知则控制 ACK 保持 pending。

`jobId` 用服务随机值；持久记录至少有 `{jobId,kind,projectId,conversationId,runId,runGrantId,instanceId,requestId,inputDigest,revision,state,stage,progress,outputRefs,error,createdAt,updatedAt}`。重试同一 request/input 要幂等；旧 revision 不能盖新结果。重启后无法安全续跑的 `running` 写成 `interrupted` 并说明可否重试，不能凭 RAM Map 消失成 404。下游 job 查询按精确 project/conversation/current read ACL 核查；新轮访问旧 job 是否可读由 doc 当前对话权限决定，**不能**凭旧 run token 授权。每个阶段提交前都核 fence，取消传播到实际进程与导入流水线，迟到产物不绑定项目。

跨模块最小 HTTP/RPC 边界建议：`asset.openRead`/`import` 只经项目素材服务票据；doc 项目写入只经现有版本预期与 operation fence；render `queryFrames({projectId,projectRev,sourceRev,runGrantId,requestId,...})` 返回 queued 或 frame refs，并在授权、版本和取消变动时拒旧结果；页面反向请求只用已验证消息发起页与本轮 `runId`。不要把 Python/Vite 桌面 `/api/*` 直接暴露给 Agent 服务。各 owner 在第一份变更中用类型／伪实现确认这四个 seam，中央接线缺一返回 503，而不是把 pending 改为 hosted。

## 依赖顺序与可独占交付包

表中的路径为**建议租约**，创建者只改本行文件与专用 `server/test/cloud-tools-<包名>*.test.mjs`、`scripts/probes/cloud-tools-<包名>*.mjs`、自己的报告；同名中央文件一律由末尾 Glue 包串行接入。Python 与桌面插件先读复用，需改时由专门抽薄壳包独占；不能让云端实现者和桌面 owner 同改。

| 包／最早启动 | 独占文件与交付接口 | 依赖、验收和留待集成的点 |
|---|---|---|
| **F0 grant／asset／job 基础**：首个最小包 | 新 `server/agent/service/tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`；导出上节工厂／`ToolJobs`。不碰 `instance.mjs`、`account-runner.mjs`、doc authority/ledger 原文件。 | 依赖中央现有 run-client、asset ticket；真实 SQLite／持久文件 fsync + mTLS asset fixture。两个账号/项目/对话隔离、只读 vs 写、撤销与上游断开、重启中断、同 request 幂等、取消 child exit+close；无真实 provider 503。它是所有后续包的先行件。 |
| **P1 shots + 素材拼图**：F0 后最短真实能力链 | 新 `server/agent/service/perception/{runner,shots}.mjs`、`server/agent/service/hosted-media-frames.mjs`；可选新 `server/vision/media-sheet.mjs` 由此包独占；输出 `createShotsTools` 与 `createMediaFramesTools`。 | `detect_shots`、既有 `list_shots`、`see_frames({source:'media'})` 成对完成。项目 assetRef→授权读取→ffprobe/ffmpeg `scdet` 真 hard-cut，TransNetV2 有实际依赖时再验；镜头结果持久，拼图取帧/分页遵本机 `visionTools` schema（默认6、最多12，grid4/9）。图片直接看、音频拒、镜头失败时显式按契约 fallback，不假称模型识别。实际视频 fixture 验镜头/帧/字幕/主体关联、跨项目拒及导入；经真实 render 队列和自定义卡项目测计时。render 队列挂载归 render owner，本包只交 adapter。 |
| **P2 STT**：F0 后可与 P1 并行 | 新 `server/agent/service/perception/stt.mjs`；仅需改 Python 时独占 `python/promptcut_stt/`，桌面 `server/vite-plugin-stt.ts` 由后述 D 包串行处理。 | `stt_status`、`stt_install`、`transcribe_media` 与现有 `get_transcript`。当前 Python CLI status/install/transcribe 可复用，但云端 install 只准锁定依赖／权重的受控 job，不允许模型给 pip/shell 任意参数；缺依赖如实报告。实际短语音文本和时间戳、文档项目转写持久化、重启取消、跨项目与只读写入拒。部署者提供 Linux 依赖/模型证明，不能把本机有包当节点有包。 |
| **P3 track + clip motion**：F0 后可并行；motion 在 track 后 | 新 `server/agent/service/perception/track.mjs`、`server/agent/service/hosted-motion.mjs`；仅需改 Python 时独占 `python/promptcut_track/`。 | `track_status/install/points/get_track` 加 `attach_clip_motion`。模板匹配 CPU 兜底须真跑，BootsTAPIR 有权重才算对应档 ready；轨迹按项目/素材版本持久，不用全局 mediaId map。motion 用现有项目副本工具对 clip 类型、时间重叠、pointIndex/whenHidden 校验，doc 版本提交绑定 run/op，真实画面复核移动轨迹。无 track 时不得伪造 motion。 |
| **P4 subject**：F0 后可并行 | 新 `server/agent/service/perception/subject.mjs`；仅需改 Python 时独占 `python/promptcut_subject/`。 | `subject_status/install/detect_subjects` 与 `list_subjects`。light/full 实测分开；light 不假称 prompt 生效，full 缺权重仍标未达成。结果写项目素材/镜头的当前版本，含失败采样与 fallback 标记；实际有人像短片、错误 mediaId、跨项目、重启取消。 |
| **P5 unified job + workflow**：P2/P1/P4 接口就绪后 | 新 `server/agent/service/hosted-workflow.mjs`；F0 的 `tool-jobs.mjs` 仅 F0 owner 修改，P5 只调用其 API。 | `background_job_status`、`auto_workflow`、`auto_workflow_status`。分阶段 STT→shots→subject→卡片/字幕→补渲，确实提交项目变更，失败/取消不越过失败阶段。真实短片和重启后阶段进度；不调用关闭的 spawn。依赖感知未达成时明示未达成，不用占位 job 完成。 |
| **P6 audio JS**：F0 + render 签名路由约定后 | 新 `server/agent/service/hosted-audio-js.mjs`、`server/hosted-render/audio-js.mjs`；`server/vision/routes.ts` 等 render 中央入口由 render owner独占挂载；不与其同改 `look.mjs`。 | `measure_audio_js` 读取受权 PCM，脚本只在隔离 worker/无头浏览器中运行，无 Node/文件/网络；复用本机时间、内存、256KiB 输出限制，普通 `measure_audio` 保持原路。纯正弦数值、语法行列、超时/内存/联网尝试拒、另项目PCM拒、失权取消与真实 worker close。handler 存在但未挂 signed render route 时仍 pending。 |
| **W1 isolated web 7**：F0 后独立 | 新 `server/agent/service/hosted-browser.mjs`、`server/web/hosted/{session,network,view,hit}.mjs`；不改本机 `server/web/browser.mjs`，现有 `egress.mjs` 若需接口由单独 egress owner 串行扩展。 | `web_open/view/click/type/scroll/read/close`：每 project×conversation 隔离 profile/浏览器，动作也绑定当前 run/fence，旧 clickable revision 不可点击，页面文字是不可信数据；禁止代填密码/验证码。Agent browser 出网代理核 DNS/redirect/IPv4+IPv6、内网/loopback/metadata、file/下载/WebRTC，网络重绑定也拦。两对话同站 session 不串、取消/进程关后 profile 生命周期、真实受控公网与本机假站拒；卡片外链不经过此闸。 |
| **W2 本人页面反向通道**：F0 + Agent UI 事件/票据 | 新 `server/agent/service/hosted-handoff.mjs`、`server/agent/service/page-bridge.mjs`；页面 `src/ai/cloud/pageRequests.ts` 只由本包在 UI owner 移交后串行改；`web_handoff/seek/play/pause` 共用 `requestPage({run,initiatorAccountId,pageId,tool,args,requestId,deadline})`。 | doc 当前消息发送者与实际在线页双向绑定，不让模型/body 指定页；同账号其他页不是自动发起页；断连明确 offline。页面 POST 结果重核当前 grant、page、request、revision/nonce，超时/取消/私有/踢人后晚答拒；真实两账号多页浏览器，用户播放头实际变化，其余成员不变。旧 `get_selection` 新全员 doc 路径不退回页面旧单人快照。 |
| **C1 本机采集代下**：F0 + W2 + asset import | `server/agent/service/hosted-collect.mjs`、新 `server/agent/service/collect-bridge.mjs`、新 `src/ai/cloud/collectBridge.ts`；本机 `server/vite-plugin-collect.ts`／`src/ai/collectLoginStore.ts` 如需扩展，由本包在相关 UI owner 移交后独占。 | `collect_login/check` 只在本人电脑操作；`collect_download` 默认匿名云端，需登录且本人在线才委托本机下载并**直接**上传本项目 asset，云端只接 `{requestId,jobId,assetRef:{projectId,hash,size},result}` 再由 asset/doc 验入库与当前 run。不给云端 cookie/header/profile/path；失败、离线、超时回匿名并注明原因/画质；私有/stop/踢人后迟到 ref 不登记。真实本机登录 fixture、云匿名 fixture、浏览器非电脑发起匿名、cancel/重启/跨项目拒；旧 collect 工具可达不算此路径通过。 |
| **V1 用户可视记录**：F0 + Agent conversation ACL + render/asset | 新 `server/agent/service/hosted-visuals.mjs`、新 `server/agent-service/visual-routes.mjs`；`server/ai-visual.mjs` 和渲染内部 `/api/ai/visual` 的挂载由 render owner串行，`src/editor/right/ToolVisual.tsx` 由 UI owner 串行；工具表 `cloudLookResult` 只由 Glue owner 改。 | `get_gif` 的 8 帧模型拼图之外，保存 `visualId/spec/sourceRev/projectId/conversationId/aclRevision` 与用户可读 GIF/截图/前后对比。Agent 记录 Spec，GIF 像素按已有角色分工由 user 渲染路径按需生成，不把它塞进 Agent 专用 Chrome；离线后打开记录的授权与生成也要实测。private bytes 由 Agent 授权端点返回，即使底层用 asset 存，也不能凭已知 hash 直取；SSE/历史/文件每次当前 conversation ACL，visibility 变更废缓存。模型、同会话其他成员、创建者只读 private、跨会话/项目、撤销、重启、真实 UI 展示都测；生成 spec 不算用户已看见 GIF。 |
| **D 桌面薄壳与部署依赖**：P1–P4 接口固定后串行 | `server/perception-source.mjs`、`server/vite-plugin-{stt,shots,track,subject}.ts`（本包独占）；节点部署依赖清单只读交 ops owner，不安装。 | 当前桌面插件的 jobs 在 RAM、写回靠页面；抽可复用 adapter 时保留 LAN/local 路径不退步，不能把 Vite `/api/*` 当 Hosted RPC。Windows/Linux 真 Python/ffmpeg/权重版本和缺失状态逐项记录。此包只在确需改共享实现时启动，避免 P 包多头写同文件。 |
| **G 最后中央接线**：所有 provider 回归后，一个 owner 串行 | `server/agent/service/{instance,hosted-tools,cloud-tools}.mjs`、`server/agent-service/{main,hosted-wiring}.mjs`、必要的 `server/agent/ssr-host.mjs`；由根精确租约，不能各 leaf 提前改。 | 同一可信 `ToolRunContext` 构造和工具 name→provider 路由；23 pending 逐项在真实 provider 挂载并验后改 mode/提示词，`see_frames(media)`、get_gif visual、offline 页面模式分别关闸；spawn 固定不支持。工具总表、schema、错误、真实 model→tool→doc/asset/render/UI 全链，复用测试不能代替 account-v2 E2E。无生产实例注册、mTLS 或节点依赖仍 503/待验，不因单项 fixture 把产品报完成。 |

最小先行交付是 **F0**，随后 **P1 的 scdet + 媒体拼图**，它能最早验证 asset→持久 job→真实 Python/ffmpeg→可读帧→当前 run fence 的整条生产形状；P2/P3/P4/W1/P6 可在 F0 接口固定后并行但各守文件租约。W2 与 C1 共用一个页面可信返回协议，先完成 W2 才接本机代下。V1 与 render owner、UI owner只交换接口，不竞争中央文件。G 是唯一修改工具表和真实实例入口的时点。

## 每包必须提交的证据与最终关门

每个实现包在专属临时项目、两账号/两项目/两对话和**真实 doc/asset mTLS** 下验证；模型可用明确标注的假 runner 测协议，但至少一个最终组合用真实模型直接 API 路径和实际 tool call，不能拿模拟模型冒称。测试分别证明成功产物真实可读、401/403/503、只读写拒、错项目、失权与 private/stop/Agent off 逐消息 fence、取消实际子进程 exit+close、重启后持久 job/视觉/页面请求状态、ACK 丢失幂等和旧实例不能复活。服务进程、browser、Python worker、代理、页面监听都要实际关闭与查无残留。安装/部署包另提供 Linux 的 ffmpeg/Python/Chrome/模型文件与版本、节点隔离、无凭据日志实证；本计划没有核验这些环境。

渲染组合单列 RS18 受控队列：合格本地优先，失败或不具备能力进入云单活跃项目；本地全离线仍云继续；既有自定义卡项目至少两项目竞争，请求从接收到可读帧计时，列出超过五分钟的尾部原因。RS19 预算实测通过才双项目，RS20 至少三项目交替持续推进；不要自拟内存数字或以提前回收绕过尚未拍板的五分钟驻留规则。补渲故障 A/B 未定时只记录故障状态与两方案实验，不确定默认恢复策略。

工具适配器本身、真实 Agent 实例注册/mTLS、中央组合、UI 视觉、节点依赖/权重、生产渲染容量、真实 Key 的最终部署分别报告状态。只有源码、协议、测试、节点实测都对应同一固定提交和配置，才把一项从“规划”推进到“通过”；未达项目保持明确 pending/503 与缺口说明。
