# 0.7.18 云端 Agent 剩余工具：可派工接口与依赖

2026-10-08；工程拆包建议，**不是**新增产品决定或验收记录；各包的“状态”只写代码是否已在 main、是否已挂载，不代表通过验收。基底 `bb0266fa`；状态按 2026-10-13 的 main `f18e33ef` 核对。〔裁〕：见 AGENT-v18-tools-p5.md。语义来源为 [账号任务书](account-binding-task.md)、[云端 Agent 任务书](cloud-agent-task.md)、[三版本设计](three-versions-018-design.md)、[工具缺口清单](cloud-agent-tool-coverage.md)与[渲染补充](render-scheduling-supplement.md)；同名旧契约与源码的历史说明不能覆盖这些新决定。以下拟议模块名、字段、失败码、分包是实施接口，接线者可在不改语义的前提下细化。

## 当前真实起点和不可跨越的边界

2026-10-13 增量（按 main `f18e33ef` 核对）：F0（`tool-context.mjs`、`run-resources.mjs`、`tool-jobs.mjs`、`project-assets.mjs`）和 P1（只有镜头识别一半）、P2、P3、P4、P5、W1、W2、C1 的工具包都已在 main，各包的做法与验证见 `docs/reports/AGENT-v18-tools-*.md`。`ProjectAssets` 已由账号模式的任务运行器（`account-runner.mjs`）建出，经 `instance.mjs` 的 `runAssets` 交给任务实例；project-assets 的设计见[素材基础实施设计](cloud-agent-project-assets-implementation.md)。`ToolJobs` 和各工具包的工厂在 main 上没有生产调用方，只有测试与探针在用；G 包的接线在 `claude/v18-wire` 分支进行，尚未合入 main，工具表仍是 pending。进度见[工作进度](three-versions-progress.md)。三个〔裁-F0〕是三级技术选型，未把建议当用户新增批准。〔裁〕：见 AGENT-v18-tools-p4.md、AGENT-v18-tools-p5.md。

`cloud-tools.mjs` 仍将感知／工作流 15 项、浏览器 7 项和 `measure_audio_js` 共 23 项列为 `pending`。已有 Hosted 工具 20 项与 timeline 看画面的代码路径只说明复用可能；旧 Hosted 测试、桌面 Python 测试都不是账号版逐工具端到端证明。全员选区叶 `3f17b10a` 已用真实 doc 通道与模拟模型运行实际 Agent 工具路径；生产实例注册、mTLS 全链和真实模型仍须中央组合验证。`account-runner.mjs` 已有逐模型／工具 `beforeToolCall` 闸，`run-client.mjs` 有 doc mTLS run API；本计划不能以模型自报的项目、发送者、页面或票据替代 doc grant。

已定范围：云端工具原则上与本机一致；仅操作发起人本人界面的能力在其离线时明确返回 offline。`spawn_agent` 在 .18、.19、.20 均固定回「云端暂不支持开子 Agent」，另由已有 owner 对齐；不列为本批可实现工具。用户卡、素材效果卡及其外链资源正常加载，不把下文**Agent 浏览器**防内网规则套在卡片资源上。账号授权、对话共有／私有、当前轮保留、stop／Agent 关闭的优先级，沿用 doc/run authority，不由工具层创造新例外。删除权限和名额释放细节、未满五分钟提前让位、预渲染任务故障 A/B 仍待确认，不放进本批默认行为。

RS18 云端**单活跃项目**且合格本地即时查询帧优先；RS19 只有项目级与总体预算实测满足才尝试双项目；RS20 用磁盘缓存和交替加载争取至少三个项目持续推进，不承诺三个重型项目常驻。每个生产容量场景都含用户自定义卡片。`see_frames` 端到端低于五分钟是优先目标，尚非保证或通过项；从接收请求到调用方可读完整所需帧的计时口径是技术建议，待接入契约时定稿并记录排队、素材、加载、渲染和返回各段。

## 所有工具复用的窄接口（F0，已在 main）

下列接口已在 `server/agent/service/` 下落地，签名以代码为准。`ToolRunContext` 只能由 `contextAccess.fromGrant` 从 doc 已确认读消息后的当前 run grant 和 Agent 实例注册证明构造，不能从工具参数、页面 POST 或缓存的 username 构造。取消信号由运行资源登记器给（`signalFor`），`contextAccess` 上没有它；素材读取回的是 Node 的 `Readable`。〔裁〕：见 AGENT-v18-tools-p3.md、AGENT-v18-tools-p4.md。

```ts
// tool-context.mjs：createToolRunContextAccess({ runClient }) -> ContextAccess
type ToolRunContext = Readonly<{        // 恰好这八个字段，多一个少一个都拒
  projectId: string; conversationId: string; runId: string;
  runGrantId: string; instanceId: string; instanceGeneration: number;
  senderAccountId: string; messageId: string;
}>;
interface ContextAccess {
  fromGrant(locator: { projectId: string; runGrantId: string }): Promise<ToolRunContext>;
  authorize(context: ToolRunContext, action: 'read'|'write'): Promise<{
    allowed: true; fenceRevision: number; grantState: 'active'|'retained';
  }>;                                    // 每次都重核 doc 的当前 grant 和本实例的注册
}

// run-resources.mjs：createRunResources({ contextAccess?, runClient, childTreeWitness? }) -> RunResources
interface RunResources {
  contextAccess: ContextAccess;
  contextFor(locator): Promise<ToolRunContext>;      // 同 contextAccess.fromGrant
  authorize(context, action): Promise<...>;           // 同 contextAccess.authorize
  verifyFence(context, revision: number): Promise<boolean>;
  register(context, { kind: 'socket'|'stream'|'child', resource }): Promise<{ signal: AbortSignal; closed: Promise<void> }>;
  signalFor(context): AbortSignal;                    // 这一轮没登记过资源时抛 run-resource-unregistered
  abortForFence(context, reason?): Promise<{ complete: boolean; witnessMissing: boolean; pendingRegistrations: number;
    connectionsOpen: number; streamsOpen: number; childrenOpen: number; reason: string }>;
  close(): Promise<...>;
}

// project-assets.mjs：createProjectAssets({ contextAccess, runAssetClient, workspace, resources, reserveImport, maxImportBytes, verifySourceJob? })
interface ProjectAssets {
  openRead(context, mediaId: string, options?: { tier?: 'original'|'small'; range? }): Promise<{
    stream: Readable;                    // Node Readable；整份读时边读边核大小和哈希，对不上流以错误结束
    assetRef; mediaRev: string; projectRev; kind: string;
    closed: Promise<void>;               // 输入端、输出端和线路都关了才解决
  }>;
  import(context, source: AsyncIterable | Uint8Array, meta: { name: string; kind: 'audio'|'image'|'video'; requestId: string; sourceJobId?: string }): Promise<{
    importId: string; assetRef; state: 'stored'; resourceRev: string;   // 只表示字节已存进项目素材库；登记成项目里的素材（addMedia）由 doc 一侧另做
  }>;
  verifyRef(context, ref: { projectId: string; hash: string; size: number }): Promise<{ assetRef; resourceRev: string; assetRefId: string }>;
  close(): Promise<{ streamsClosed: true; dispatchesOpen: 0; pending: false }>;
}

// tool-jobs.mjs：createToolJobs({ databasePath, authorize, verifyFence, now? }) -> ToolJobs（SQLite，WAL，synchronous FULL）
type JobState = 'queued'|'running'|'done'|'error'|'cancelled'|'interrupted';
interface ToolJobs {
  start(context, kind: string, inputDigest: string, requestId: string): Promise<{ jobId: string; state: JobState }>;   // 要 write
  update(context, jobId: string, expectedRevision: number, patch: {
    state?: JobState; stage?: string; progress?: number; outputRefs?: { kind: string; id: string }[]; errorCode?: string | null;
  }): Promise<void>;                     // 要 write；旧 revision 抛 stale-revision
  checkpointRetained(context, jobId: string, expectedRevision: number): Promise<{ revision: number; fenceRevision: number; grantState: 'retained' }>;
  get(context, jobId: string): Promise<JobRecord>;      // 要 read；只按 project + conversation 找，找不到抛 job-not-found
  cancelForFence(context, fenceRevision: number): Promise<void>;   // 把该上下文、该 fence 下 queued 和 running 的作业写成 cancelled
  close(): Promise<void>;
}

// 每个工具包导出的提供方（perception/*.mjs、hosted-*.mjs）
interface CloudToolProvider {
  handles: ReadonlySet<string>;
  call(name: string, args: unknown, context: ToolRunContext, options?: { requestId?: string }): Promise<unknown>;   // requestId 是宿主的工具调用号，重试不开第二个作业
  close(reason?: string): Promise<{ childrenClosed: boolean; streamsClosed: boolean; workPending: number }>;
}
```

各包的工厂没有统一成一个签名，参数以各包文件头的说明为准。共同点：运行资源登记器、`ProjectAssets`、`ToolJobs`、对话工作区（`workspace(context)`）、部署配置（Python、ffmpeg、权重、浏览器路径）、服务配置、mTLS 身份和实例注册都由宿主可信注入，工具参数里不收 `projectId`、`runGrantId`、`instanceId` 或本地绝对路径；配置缺了，调用时如实回「这台节点没配」（`cloudUnavailable: true`），不假装成功。**每次**读取受权素材、提交项目修改、跨进程返回产物、读 job/visual/page 答案前，以 doc 当前 grant/fence 和项目 ACL 重验；“已读后共有轮可保留”的决定只按 run authority 返回的精确 current grant 执行，private/stop/Agent off 优先撤销。授权/上游不可达 fail closed，不能退回旧 LAN 用户名或未经核验缓存。`read` 可由只读成员用，项目变更和资产导入需 `write`，不借项目创建者身份赋 Agent 特权。`close()` 对本实例持有的子进程、socket、流、计时器、未完成 dispatch 要等实际退出／close 证据；旧实例资源未知则控制 ACK 保持 pending。`abortForFence` 回执的 `complete` 要宿主给运行资源登记器一个 `childTreeWitness`（证明这棵进程树确实没了）才可能为 true；`account-executor-assembly.mjs` 留了这个口子，main 上没有调用方给。〔裁〕：见 AGENT-v18-tools-p3.md、AGENT-v18-spawn.md。

`jobId` 是服务随机值（`job_` 加 UUID）。账本记录是 `{jobId,kind,projectId,conversationId,runId,runGrantId,instanceId,instanceGeneration,senderAccountId,messageId,inputDigest,fenceRevision,revision,state,stage,progress,outputRefs,errorCode,createdAt,updatedAt}`：没有 `requestId`（账本只存它的哈希，作幂等键的一部分），没有自由文字的原因字段，也没有“按入参找作业”的查询。各包把中文失败原因和“素材 → 作业号”的索引放在对话工作区自己的 `<包名>/jobs.json`（`shots/`、`subject/`、`workflow/` 等），`background_job_status` 与各包的 `list_*` 读这些索引。重试同一上下文、同一 kind、同一 `requestId` 幂等；`inputDigest` 变了抛 `idempotency-conflict`；旧 revision 抛 `stale-revision`，不能盖新结果。账本打开时把 `running` 写成 `interrupted`（`errorCode` 为 `INTERRUPTED_ON_RESTART`），`queued` 的保持原样；P3、P5 在读取一侧把“比本提供方起得早、又不在本进程里跑”的非终态作业按中断说，不写账本。共有对话里已读的一轮在发消息的人被踢或退出后仍可跑完（retained）：账本更新撞上 `job-scope-mismatch` 时，包用 `checkpointRetained` 补一次检查点再继续。`get` 按精确 project/conversation 和当前 read 授权核查，新轮访问旧 job 是否可读由 doc 当前对话权限决定，**不能**凭旧 run token 授权。每个阶段提交前都核 fence，取消传播到实际进程与导入流水线（`resources.abortForFence` 杀进程树，`jobs.cancelForFence` 写 `cancelled`），迟到产物不绑定项目。〔裁〕：见 AGENT-v18-tools-p1.md、AGENT-v18-tools-p4.md、AGENT-v18-tools-p5.md。

跨模块最小 HTTP/RPC 边界：素材读写经 `ProjectAssets`，凭这一轮的 run grant 向素材服务取受限句柄（`run-asset-client.mjs`），不借成员的票据；doc 项目写入只经现有版本预期与 operation fence；render `queryFrames({projectId,projectRev,sourceRev,runGrantId,requestId,...})`（拟议，main 上没有）返回 queued 或 frame refs，并在授权、版本和取消变动时拒旧结果；页面反向请求只用已验证消息发起页与本轮 `runId`。不要把 Python/Vite 桌面 `/api/*` 直接暴露给 Agent 服务。项目一侧的写入缝由各包以工厂参数给出，由 G 包接到 doc 的版本预期与操作栅栏：P1 `project.{getMedia,setMediaShots,getStage}`，P4 `project.{getMedia,setMediaSubjects}`，P2 `commitTranscript`，P3 `readProject` 与 `createMotionTools` 的 `commit`，P5 `project.{getMedia,getTimeline,applyEdits}` 与 `prerender.publish`。P1、P4、P5 还要宿主经 `server/agent/ssr-host.mjs` 的载入缝从前端代码取内核函数注入 `kernel`，独立入口不许直接 import `src/`。中央接线缺一返回 503，而不是把 pending 改为 hosted。〔裁〕：见 AGENT-v18-tools-p1.md、AGENT-v18-tools-p5.md。

## 依赖顺序与可独占交付包

表中的路径为**建议租约**，创建者只改本行文件与专用 `server/test/cloud-tools-<包名>*.test.mjs`、`scripts/probes/cloud-tools-<包名>*.mjs`、自己的报告；同名中央文件一律由末尾 Glue 包串行接入。Python 与桌面插件先读复用，需改时由专门抽薄壳包独占；不能让云端实现者和桌面 owner 同改。

| 包／最早启动 | 独占文件与交付接口 | 依赖、验收和留待集成的点 |
|---|---|---|
| **F0 grant／asset／job 基础**：首个最小包 | 已落地：`server/agent/service/{tool-context,run-resources,tool-jobs,project-assets}.mjs`，素材一侧经 `tool-assets-resources.mjs`、`run-asset-client.mjs` 接素材服务；接口见上节。不碰 `instance.mjs`、`account-runner.mjs`、doc authority/ledger 原文件。 | 依赖中央现有 run-client、运行素材的受限句柄（`run-asset-client.mjs`）；真实 SQLite／持久文件 fsync + mTLS asset fixture。两个账号/项目/对话隔离、只读 vs 写、撤销与上游断开、重启中断、同 request 幂等、取消 child exit+close；无真实 provider 503。它是所有后续包的先行件。 状态（main `f18e33ef`）：`ProjectAssets` 已由 `account-runner.mjs` 建出并交给任务实例，`ToolJobs` 在 main 上没有生产调用方。〔裁〕：见 AGENT-v18-tools-p3.md、AGENT-v18-tools-p4.md。 |
| **P1 shots + 素材拼图**：F0 后最短真实能力链 | 已做：新 `server/agent/service/perception/shots.mjs`，输出 `createShotsTools`。`perception/runner.mjs` 由 spawn 包做成云端起子进程的公共实现（`spawnTree`、`killTree`、`superviseChild`、Python 隔离模式命令行），`workspace.mjs`、`hosted-collect.mjs`、`perception/{stt,subject,track}.mjs` 和 W1 的浏览器进程都用它，不归 P1 独占。未做：`server/agent/service/hosted-media-frames.mjs`、可选 `server/vision/media-sheet.mjs`、`createMediaFramesTools`（素材拼图那一半）。 | `detect_shots`、`list_shots` 已完成，`see_frames({source:'media'})` 未做，素材拼图要经 render 队列，随渲染重构那一批。`detect_shots` 的引擎：模型档（TransNetV2，硬切和溶解）就绪就用，否则 ffmpeg `scdet`（只认硬切），记在结果的 `engine`；两档都真跑过；模型档中途出错退到 `scdet` 并标 `fellBackFrom`，超时和取消不退档；两档都用不了（ffmpeg 起不来）时回 `cloudUnavailable` 并指向 `see_frames`，不起作业。`list_shots` 由本包自己答（桌面版读的作业状态是进程内全局 Map），在跑、被中断、失败、被取消都说清。项目 assetRef→授权读取→ffprobe/ffmpeg 整条链、跨项目拒、镜头结果持久（写项目素材的 `shots`）、图片直接看、音频拒，都有真素材测试；转场缩略图云端不做。素材拼图做时仍遵本机 `visionTools` schema（默认6、最多12，grid4/9）。Linux 节点的依赖证明、真实 render 队列计时留待集成。状态（main `f18e33ef`）：已合入，未挂载。〔裁〕：见 AGENT-v18-tools-p1.md。 |
| **P2 STT**：F0 后可与 P1 并行 | 新 `server/agent/service/perception/stt.mjs`；`python/promptcut_stt/` 已改（只加不改旧行为）；桌面 `server/vite-plugin-stt.ts` 由后述 D 包串行处理。 | `stt_status`、`stt_install`、`transcribe_media` 已完成，读结果用现有的 `get_transcript`。Python CLI 加了 `transcribe --offline`（ffmpeg 抽音限本地文件）、`status` 的 `available_models`（权重放齐的模型名）、`install --requirements <锁定依赖文件>`。云端 install 只装节点配置里给的锁定依赖文件（`runtime.requirements[引擎]`），没配就回“这台节点不开放自助安装”，不允许模型给 pip/shell 任意参数；缺依赖或权重如实报告，不开作业、不取素材字节。转写结果经宿主给的 `commitTranscript` 写进项目。实际短语音文本和时间戳、重启取消、跨项目与只读写入拒都有测试（含真 faster-whisper）。部署者提供 Linux 依赖/模型证明，不能把本机有包当节点有包。状态（main `f18e33ef`）：已合入，未挂载。〔裁〕：见 AGENT-v18-tools-p2.md。 |
| **P3 track + clip motion**：F0 后可并行；motion 在 track 后 | 新 `server/agent/service/perception/track.mjs`、`server/agent/service/hosted-motion.mjs`；`python/promptcut_track/` 已改（部署参数 `--pylibs/--models/--ffmpeg/--requirements`、`track --max-frames`）。 | `track_status/install/points/get_track` 加 `attach_clip_motion` 已完成。模板匹配 CPU 兜底真跑过（探针逐帧误差 0.67 像素）。BootsTAPIR 档另需 torch≥2.2,<3、`einshape`、`dm-tree` 和权重 `bootstapir_v2.pt`；Python 的 `ready` 只检查 torch 和权重，权重在而 `einshape`、`dm-tree` 缺时状态说就绪、真追会如实失败，这一档没有在依赖齐全的机器上正向验过。云端 `track_install` 默认不开放，部署者开了（`install.enabled`）并给出网闸才装。轨迹结果存在 `track.mjs` 自己的 SQLite 表里，键是项目×对话×素材×素材版本（`mediaRev` 加哈希），同项目另一个对话读不到，素材换版后标过期要 `force:true` 重追；不用全局 mediaId map。motion 在项目副本上调现成的 `attachClipMotion`，校验 clip 类型、时间重叠、pointIndex/whenHidden，提交走宿主给的 `commit`；`commit` 收到的 `fenceRevision` 要与 run authority 当前 fence 对账，`agent-exec.mjs` 的 `mutate` 现在不带这个检查，是 G 包要补的。无轨迹、还在跑、追失败、过期时拒绝，不伪造 motion。超长视频直接拒绝（`--max-frames`，缺省 1800 帧）。卡片在舞台上跟着走的实际画面经渲染进程复核，留待集成。状态（main `f18e33ef`）：已合入，未挂载。〔裁〕：见 AGENT-v18-tools-p3.md。 |
| **P4 subject**：F0 后可并行 | 新 `server/agent/service/perception/subject.mjs`；`python/promptcut_subject/` 已改（`--models-dir`、`--pylibs`、`--local-only`、`install --requirements`）。 | `subject_status/install/detect_subjects` 与 `list_subjects` 已完成。light/full 两档都用真权重跑过，分开记录；引擎由 Python 侧 `pick_engine` 定，`engine` 记实际跑的一档，light 档的 `engineNote` 明说提示词不生效、只认 person 和 face；依赖或权重没装好时 `detect_subjects` 回 `cloudUnavailable` 并指向 `see_frames`，不起作业。结果写项目素材的 `subjects`（含失败采样与 fallback 标记）；镜头级的折叠由 `list_shots` 读 `media.subjects` 时做，不写镜头。`subject_install` 不收参数，只有节点配了 `PYLIBS` 与锁定版本的 `REQUIREMENTS` 才允许，装的永远是 light 档；full 档（torch 加约 690 MB 权重）随部署送达。有人像的短片、错误 mediaId、跨项目、重启取消都有测试。状态（main `f18e33ef`）：已合入，未挂载。〔裁〕：见 AGENT-v18-tools-p4.md。 |
| **P5 unified job + workflow**：P2/P1/P4 接口就绪后 | 新 `server/agent/service/hosted-workflow.mjs`；F0 的 `tool-jobs.mjs` 仅 F0 owner 修改，P5 只调用其 API。 | `background_job_status`、`auto_workflow`、`auto_workflow_status` 已完成。`auto_workflow` 分五个阶段：转写、镜头识别、主体识别、生成字幕与卡片、发布预渲染任务；第 4 段的配卡规则与桌面版 `autoWorkflow.ts` 逐条相同，前后多出的阶段是云端的。字幕与卡片一次提交进项目（带期望的项目版本，整份全进或全不进）；任何阶段失败、被取消、被中断就停在那里，后面的阶段不做；依赖的感知能力没就绪时该阶段标“用不了”并带原因，不起占位作业。缺省下镜头、主体也是必需阶段（宿主可用 `optionalStages` 放宽，是否放宽、同一份文字稿重复点是否去重，待用户定）。各阶段状态记在对话工作区 `workflow/jobs.json`，整体状态在账本，重启后说得清做到哪一阶段。`background_job_status` 查账本里所有种类的作业，找不到、别项目、别对话的作业号回同一句“找不到该作业”。不调用关闭的 spawn。真短片（真转写、真 scdet、真 light 主体识别）验过。状态（main `f18e33ef`）：已合入，未挂载；发布预渲染任务的接缝（`prerender.publish`）和项目一侧接缝要 G 包接。〔裁〕：见 AGENT-v18-tools-p5.md。 |
| **P6 audio JS**：F0 + render 签名路由约定后 | 新 `server/agent/service/hosted-audio-js.mjs`、`server/hosted-render/audio-js.mjs`；`server/vision/routes.ts` 等 render 中央入口由 render owner独占挂载；不与其同改 `look.mjs`。 | `measure_audio_js` 读取受权 PCM，脚本只在隔离 worker/无头浏览器中运行，无 Node/文件/网络；复用本机时间、内存、256KiB 输出限制，普通 `measure_audio` 保持原路。纯正弦数值、语法行列、超时/内存/联网尝试拒、另项目PCM拒、失权取消与真实 worker close。handler 存在但未挂 signed render route 时仍 pending。 状态（main `f18e33ef`）：未做。 |
| **W1 isolated web 7**：F0 后独立 | 新 `server/agent/service/hosted-browser.mjs`、`server/web/hosted/{session,network,view,hit}.mjs`；不改本机 `server/web/browser.mjs`，也没有改 `egress.mjs`（只用出网闸已有的 `admit`／`admitUrl`）。 | `web_open/view/click/type/scroll/read/close`：每 project×conversation 隔离 profile/浏览器，动作也绑定当前 run/fence，旧 clickable revision 不可点击，页面文字是不可信数据；禁止代填密码/验证码。Agent browser 出网代理核 DNS/redirect/IPv4+IPv6、内网/loopback/metadata、file/下载/WebRTC，网络重绑定也拦。两对话同站 session 不串、取消/进程关后 profile 生命周期、真实受控公网与本机假站拒；卡片外链不经过此闸。 状态（main `f18e33ef`）：已合入，未挂载。〔裁〕：见 AGENT-v18-tools-w1.md。 |
| **W2 本人页面反向通道**：F0 + Agent UI 事件/票据 | 新 `server/agent/service/hosted-handoff.mjs`、`server/agent/service/page-bridge.mjs`；页面 `src/ai/cloud/pageRequests.ts` 只由本包在 UI owner 移交后串行改；`web_handoff/seek/play/pause` 共用 `requestPage({run,initiatorAccountId,pageId,tool,args,requestId,deadline})`。 | doc 当前消息发送者与实际在线页双向绑定，不让模型/body 指定页；同账号其他页不是自动发起页；断连明确 offline。页面 POST 结果重核当前 grant、page、request、revision 与 nonce，超时/取消/私有/踢人后晚答拒；真实两账号多页浏览器，用户播放头实际变化，其余成员不变。旧 `get_selection` 新全员 doc 路径不退回页面旧单人快照。 账号模式下一条任务一个任务进程（`account-task-worker.mjs`）：调用 `requestPage` 的是任务进程，接页面事件流（`attach`）和页面交回（`acceptResult`）的是主服务，两边不在同一进程；main 上只有任务进程到主服务的单向事件口（`worker-event-internal.mjs`），没有主服务到任务进程的通道。反向通道放哪个进程由 G 包接线时定，W2 的建议是放主服务（任务进程经内部请求调它，主服务用 `runAuthority` 口子取文档服务对这一轮的核对，任务进程收到结果后自己再核一遍栅栏版本）。`web_handoff` 要 W1 的 `hosted-browser.mjs` 提供 `browser.handoffTarget(context)`，main 上还没有，没传这个口子时 `web_handoff` 回 `cloudUnavailable`。状态（main `f18e33ef`）：已合入，未挂载。〔裁〕：见 AGENT-v18-tools-w2.md 第 5.0 节与第 5.3 节。 |
| **C1 本机采集代下**：F0 + W2 + asset import | `server/agent/service/hosted-collect.mjs`（已改：`collect_download` 分流，新增 `collect_login`、`collect_login_check`）、新 `server/agent/service/collect-bridge.mjs`、新 `src/ai/cloud/collectBridge.ts`；`page-bridge.mjs` 加了可选参数 `extraTools`。本机 `server/vite-plugin-collect.ts`、`src/ai/collectLoginStore.ts` 这次没有扩展。 | `collect_login/check` 只在本人电脑操作；`collect_download` 默认匿名云端，需登录且本人在线才委托本机下载并**直接**上传本项目 asset，云端只接 `{requestId,jobId,assetRef:{projectId,hash,size},result}`，`result` 是 `{ items: [{ assetRef, name, kind, title?, duration?, width?, height?, vcodec? }], cookiesUsed? }`，再由 asset/doc 验入库与当前 run。回执是反向通道一次请求的答案；下载过程用开始、轮询、取消三种短请求（`collect_delegate_start`、`collect_delegate_poll`、`collect_delegate_cancel`，每 2 秒问一次进度，整次委托最多 15 分钟）。有登录支持的站点现在只有哔哩哔哩（`server/collect-cookies.mjs`）。不给云端 cookie/header/profile/path；失败、离线、超时回匿名并注明原因/画质；私有/stop/踢人后迟到 ref 不登记。真实本机登录 fixture、云匿名 fixture、浏览器非电脑发起匿名、cancel/重启/跨项目拒；旧 collect 工具可达不算此路径通过。 状态（main `f18e33ef`）：已合入，未挂载（宿主没有给 `collect_download` 委托口子）。〔裁〕：见 AGENT-v18-tools-c1.md。 |
| **V1 用户可视记录**：F0 + Agent conversation ACL + render/asset | 新 `server/agent/service/hosted-visuals.mjs`、新 `server/agent-service/visual-routes.mjs`；`server/ai-visual.mjs` 和渲染内部 `/api/ai/visual` 的挂载由 render owner串行，`src/editor/right/ToolVisual.tsx` 由 UI owner 串行；工具表 `cloudLookResult` 只由 Glue owner 改。 | `get_gif` 的 8 帧模型拼图之外，保存 `visualId/spec/sourceRev/projectId/conversationId/aclRevision` 与用户可读 GIF/截图/前后对比。Agent 记录 Spec，GIF 像素按已有角色分工由 user 渲染路径按需生成，不把它塞进 Agent 专用 Chrome；离线后打开记录的授权与生成也要实测。private bytes 由 Agent 授权端点返回，即使底层用 asset 存，也不能凭已知 hash 直取；SSE/历史/文件每次当前 conversation ACL，visibility 变更废缓存。模型、同会话其他成员、创建者只读 private、跨会话/项目、撤销、重启、真实 UI 展示都测；生成 spec 不算用户已看见 GIF。 状态（main `f18e33ef`）：未做。 |
| **D 桌面薄壳与部署依赖**：P1–P4 接口固定后串行 | `server/perception-source.mjs`、`server/vite-plugin-{stt,shots,track,subject}.ts`（本包独占）；节点部署依赖清单只读交 ops owner，不安装。 | 当前桌面插件的 jobs 在 RAM、写回靠页面；抽可复用 adapter 时保留 LAN/local 路径不退步，不能把 Vite `/api/*` 当 Hosted RPC。Windows/Linux 真 Python/ffmpeg/权重版本和缺失状态逐项记录。此包只在确需改共享实现时启动，避免 P 包多头写同文件。 状态（main `f18e33ef`）：未做。 |
| **G 最后中央接线**：所有 provider 回归后，一个 owner 串行 | `server/agent/service/{instance,hosted-tools,cloud-tools}.mjs`、`server/agent-service/{main,hosted-wiring}.mjs`、必要的 `server/agent/ssr-host.mjs`；由根精确租约，不能各 leaf 提前改。 | 同一可信 `ToolRunContext` 构造和工具 name→provider 路由；23 pending 逐项在真实 provider 挂载并验后改 mode/提示词，`see_frames(media)`、get_gif visual、offline 页面模式分别关闸；spawn 固定不支持。工具总表、schema、错误、真实 model→tool→doc/asset/render/UI 全链，复用测试不能代替 account-v2 E2E。无生产实例注册、mTLS 或节点依赖仍 503/待验，不因单项 fixture 把产品报完成。 状态（main `f18e33ef`）：main 上没有；接线在 `claude/v18-wire` 分支进行，尚未合入。`cloud-tools.mjs` 仍有 23 项 `pending`。接线时 `attach_clip_motion` 要在到达 `agent-exec` 路由表之前就分给 motion 提供方（它在 `PAGE_STATE_TOOLS` 里要向页面要轨迹，云端没有页面）；各包要填的接缝见对应报告“G 包接线时要填什么”一节和上文接口一节末尾的清单。〔裁〕：见 AGENT-v18-tools-p3.md。 |

最小先行交付是 **F0**，随后 **P1 的 scdet + 媒体拼图**，它能最早验证 asset→持久 job→真实 Python/ffmpeg→可读帧→当前 run fence 的整条生产形状；P2/P3/P4/W1/P6 可在 F0 接口固定后并行但各守文件租约。W2 与 C1 共用一个页面可信返回协议，先完成 W2 才接本机代下。V1 与 render owner、UI owner只交换接口，不竞争中央文件。G 是唯一修改工具表和真实实例入口的时点。

## 每包必须提交的证据与最终关门

每个实现包在专属临时项目、两账号/两项目/两对话和**真实 doc/asset mTLS** 下验证；模型可用明确标注的假 runner 测协议，但至少一个最终组合用真实模型直接 API 路径和实际 tool call，不能拿模拟模型冒称。测试分别证明成功产物真实可读、401/403/503、只读写拒、错项目、失权与 private/stop/Agent off 逐消息 fence、取消实际子进程 exit+close、重启后持久 job/视觉/页面请求状态、ACK 丢失幂等和旧实例不能复活。服务进程、browser、Python worker、代理、页面监听都要实际关闭与查无残留。安装/部署包另提供 Linux 的 ffmpeg/Python/Chrome/模型文件与版本、节点隔离、无凭据日志实证；本计划没有核验这些环境。

渲染组合单列 RS18 受控队列：合格本地优先，失败或不具备能力进入云单活跃项目；本地全离线仍云继续；既有自定义卡项目至少两项目竞争，请求从接收到可读帧计时，列出超过五分钟的尾部原因。RS19 预算实测通过才双项目，RS20 至少三项目交替持续推进；不要自拟内存数字或以提前回收绕过尚未拍板的五分钟驻留规则。预渲染任务故障 A/B 未定时只记录故障状态与两方案实验，不确定默认恢复策略。

工具适配器本身、真实 Agent 实例注册/mTLS、中央组合、UI 视觉、节点依赖/权重、生产渲染容量、真实 Key 的最终部署分别报告状态。只有源码、协议、测试、节点实测都对应同一固定提交和配置，才把一项从“规划”推进到“通过”；未达项目保持明确 pending/503 与缺口说明。
