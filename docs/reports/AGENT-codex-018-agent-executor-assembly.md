# 云端 Agent 真实执行器装配：只读接口方案

## 开工边界

本叶分支 `codex/018-agent-executor-assembly`，起点 `d59bb464c1a10ebacdc66ba05795885e31cf8afe`，沿根已安全复用的物理工作区。当前授权只新增本报告、只读现有源码及固定 Git 对象，不实施、不启动服务/监听/模型、不跑 type/full/build，不改其它报告、产品或部署，不读取真实模型凭据。

目标是给出最短用户可走的 send→服务端 FIFO→可信 run/已读→工具→持久事件→完成装配包，以及 G `b851f449`/`63bfc0fa` 素材登记的真实前置。已有公网账号58条、排队和成员路径不替代模型执行证据。Astra 正拥有 doc-agent-assembly/account authority/conversation/internal/session 的即时 HTTP 读关闭边界；Luna 对话 UI/Composer 独立冻结，方案不授权覆盖这些文件。

已重读本叶 AGENTS 入口、developer_guide、suggested_agent_behavior、constraints。后续结论按真实模块与接口逐项记录，技术装配选择标为提案，不写成用户特别批准。成员阶段两次首红及第三次14/14真实通过属于根已归档的前一阶段，不在本报告重复冒称执行器可用。

## 只读结论：先交可见执行，素材链并行收口

〔裁-执行接线1，三级提案〕下一用户可见小阶段选**无素材依赖的真实短任务**：同一共有对话两账号发送→真实FIFO→持久读确认→真实模型调用 `get_project/get_selection/add_clip/report_progress`→文档修改与可见进度→持久完成→第二轮。并行收 G 素材模块，随后立即接一个真实 import/read 工具。替代方案是等待全部资产/23项工具/渲染后再挂执行器；它会推迟用户可见闭环，且非素材工具不需要root asset登记。此选择只限定当前验收输入，不能将素材、看画面、感知/附件从0.7.18终点删除。账号素材工具不能沿旧auth.ticket跑；未挂时明确未就绪，不把无素材短链称全工具完成。

依据已读 `docs/plan/account-binding-task.md` 的已拍板/版本/行为/验收、`three-versions-018-design.md` 的Agent/FIFO/已读/素材/拆包、`cloud-agent-tools-implementation.md` 全文、product/agent、mechanism/agent、workflow/production和render-scheduling-supplement。旧机制里的username/device归属、15秒缓存、泛停任务与旧单页get_selection不能盖过新产品规则。删除/50会话释放细节、提前让位与补渲故障A/B不在本包选择范围。

## 当前main的实际路径与缺口（d59固定源码）

| 路径/真实接口 | 已有行为 | 必须装配或修正的最小接缝 |
|---|---|---|
| `server/agent-service/main.mjs` 的 main/startAgentService | 创建conversationClient、runClient及注册重试；startAgentService只把accountMode/conversationClient交给工厂，日志明确runAuthorityMounted/runDataProofReady=false | 不再让runClient只用于注册。startAgentService增加可信runner依赖的参数透传，在同一注册RAM key下创建dataClient/resources/control；保留未配置拒绝，不让public设置ready |
| `server/agent/service/create-agent-service.mjs:createHostedAgentService` | 已有 `requireAccountRunner/runClient/readIntentsFile/runnerFactory/serviceKid/instanceId/connectionsClosed/childrenClosed` 分支；缺runClient当前返回conversation-policy | 消费现有分支，不新建第二执行器。serviceKid/instanceId来自registerInstance真实回包，非env伪造；同OS RAM key签每请求/每数据帧 |
| `server/agent/service/account-runner.mjs:createExistingHostedRunnerFactory/createAccountRunManager/createAccountRunnerService` | factory已接实际Vite SSR、createAgentInstance、api直连；manager prepare→confirm→executeOnce，send持久成功后wake，同会话串行finish后再admit，pending用于恢复queued | main尚不传dataClient，factory必需它；启动注册+读control就绪后resumeQueued。preflight保modelReady；不能用测试runnerFactory绕真实model/key闸 |
| `server/agent-service/run-client.mjs` + `run-data-client.mjs:createRunDataClient` | 独立pinned mTLS请求，registerInstance/instanceIdentity及RAM签名；dataClient返回webSocketFor/longPollFor/wsUrl/openCount/close，每类WS有closeOwned | 用doc内部HTTPS的同Agent证书/pin注入dataClient；这是已实现真实逐帧连接，**不需要开放runTicket**。`doc-agent-assembly.issueRunTicket`当前503照留，旧用户delegation不能拿去扮run |
| account-runner `processGrant`→factory | factory支持onEvent，startHostedRun会emit run/tool/text/error/done；processGrant未传onEvent，默认noop | 真实可见事件现在丢弃。补可信run绑定的持久eventSink，并把完整Promise失败纳入本轮，不能log-only或直接广播RAM |
| `server/agent-service/http.mjs:accountEvents` | 从doc读取messages，发user及queue.state；cursor只用arrivalSeq，250ms轮询且逐条fresh access | 不能把模型seq直接混入arrivalSeq。接持久执行事件游标与补发，所有写出继续通过Astra同步读fence；轮询不能成为撤销依据 |
| `server/agent/service/conversation-policy.mjs:info` | 恒executorMounted=false；createAccountRunnerService仅覆describe，未覆info | 仅完整工厂/控制/读链实际安装后覆info；configured模型状态与available/正在执行分别展示，不拿函数存在当ready |
| `server/account/run-authority.mjs:finish` | 当前固定finished→finishInState(done)，manager handle.done后调用finish；instance中的error常通过事件输出，done Promise可正常结束 | 需真实结果outcome接缝，模型错误/额度/中断不得写成成功。由provider原owner窄扩精确finish结果/幂等摘要；runner和eventSink保原错误，不自行改当前provider |
| `server/agent/service/instance.mjs:startHostedRun` | 真实api.startRun；每model/工具闸；activeTools完整drain；全员get_selection已有doc路径；修改走同tenant项目连接 | 沿用这条实现。factory当前onFinalClose空、initiatorOnline恒false/pageCall恒offline，实际本人播放/页面工具另留明确缺口，不能称全工具/页面桥完成 |

另发现 `server/agent/service/conversations.mjs:emit` 是旧owner目录event store，写文件失败仍推进RAM seq/广播，不能原样复用作新账号持久成功证据。新事件出口只放项目×对话，不以ownerKey决定ACL；doc依然唯一对话权限权威。此次多次只读历史猜测路径（agent-service/account-runner、doc-run-assets、read-control-client等）不存在，已用git ls-tree/rg核真实文件；不存在模块不列已实现或待装配接口。

配额还须补同一个既有gate的运行容量入口：account factory目前只在每模型调用执行admitModelCall，manager新轮preflight只是modelReady，没有调用admitRun/release。装配时复用gate现有配置，容量未获准仍保留已接受消息排队，不把它写为failed、不本机降级，也不把默认数字另作产品批准。v2素材未挂时不传可触发旧auth.ticket的assetBase，账号素材分支返回准确未配置原因；不能恢复旧票据以让模型工具“成功”。

## 最小接口选择与真实完成标准

〔裁-执行接线2，三级提案〕新增账号执行事件存储 `server/agent/service/account-run-events.mjs`，使用Agent自己的SQLite/私有目录；不复制doc成员/对话/retained权威。建议工厂 `createAccountRunEvents({file,authorityId})`，方法 `acceptMessage({trustedMessage})/append({binding,eventId,event})/after({projectId,conversationId,after})/terminal({binding,outcome})/close()`。binding从doc grant完整投影 project/conversation/message/run/runGrant/instance/generation/sender；工具或网页不收这个对象。数据库每对话独立连续eventSeq；accepted user用doc messageId幂等，run/tool/result/progress/terminal按本run本地递增eventId幂等，同ID异内容409；落盘事务完成才交SSE，不因persist失败虚构complete。选择本地事件存储替代“模型增量逐块另走doc新公共写API”，减少跨repo接口；doc messages/queue/currentRun/读记录仍权威，events仅执行过程。

发送后doc已经accepted而Agent事件写失败时，保原requestId/result并重试镜像同message，不重复send。启动/首次读取从**已授权**doc完整持久messages同步缺失accepted记录，不自报sender或runId；run开始前补齐用户记录。HTTP读取先真实doc get/read-control授权，再取本服务对应project/conversation事件；既有队列revision保独立。一个持续eventSeq覆盖user/运行事件，arrivalSeq仅队列顺序字段；UI当前 `src/ai/cloud/events.ts/types.ts/session.ts` 已识别runId及tool/error/end，但与messageId关联、after游标须由Luna移交后单一owner窄接，不与其4文件租约交叉写。公开原始模型text不能替代产品的结构化 `report_progress`；工具完整output照现instance省略，诊断继续脱敏。

必须有有界append队列：instance.emit目前吞onEvent异常且不await，不能仅传async callback就声称durable。拟在runner宿主监督全部append Promise、持久失败同步终止此run并保pending；终态/finish前await本轮所有append收口，失败不启动下一轮。替代是改instance emit全链异步；影响较大，优先宿主队列但必须受控测试证明fail后没有后续model/tool提交和event写。finish的outcome由真实事件及handle状态归纳成功/失败/停止/中断，不能让客户端提供；provider具体允许状态由原owner给精确schema后接，不新造权限。eventTerminal与doc finish不是跨SQLite原子：先持久本地finalize-intent，再幂等doc finish，ACK不确定查询/重试原binding，confirmed后terminal可见；重启execution-started不可自动重跑外部副作用，明确interrupted/pending reconciliation。

可信工具上下文直接复用 `createToolRunContextAccess({runClient}).fromGrant({projectId,runGrantId})` 与 `createRunResources({contextAccess,...})`；八字段是 projectId/conversationId/runId/runGrantId/instanceId/instanceGeneration/senderAccountId/messageId。每call authorize按真实doc current active/retained，不从旧token/creator升权。现有工具闸/配额/创造力/用量保持。resource登记用实际stream/socket/child EventEmitter，child须exit+close，信号和verifyFence从resources取；Jobs只有持久状态，不能拿它证明执行退出。

## Astra HTTP读关闭接线：先收源码，不抢其租约

Astra已提供固定 `b11d8f1dee6a7c7d72857d5819c9407af9a314b2`：`server/account/agent-read-control.mjs` 同doc ledger handles/controls/instances；`server/agent-service/conversation-control-client.mjs:createConversationControlClient({origin,tls,serverFingerprint256,runClient,receiptFile,...})` 返回start/transports/read/close/describe；conversationClient.useReadControl(control)与readTransports，get/list/access走受控open。subscribe/open/close/ack各签完整body/nonce/真实exporter与同RAM instance key，不能另注册工具实例。

`server/agent/service/conversation-transports.mjs:createConversationTransports` 的ALS覆盖实际req/res/socket及未完dispatch，写出同步检查local fence。控制先同步revoke/abort/destroy，等resclose+socketclose+pending全结束，再持久close与ACK；Connection close/finish或0计数不是证据。断控制链立即关输出，旧实例资源unknown保持pending。doc hooks同事务写read fence+run fence，onFence waitCompletion；required ACK只接durable finalizeAccessEvent摘要。Astra实际目标1/1仅SQLite+doc mTLS+HTTP，不是VH/生产executor；本轮只git show，没有运行它。

**不能把HTTP读完等同run停完。** 当前Astra未挂account-runner/drainControl；run-control `createRunControlServer({tls,docFingerprint256,serviceKid,instanceId,manager})` 也未在main监听。由Astra先交统一handoff：doc deliver建立read/data同步屏障→等待operation fences→pinned doc→Agent控制→manager取消+handle.drain+resources和signed data实际close→验证doc已观察的connection及精确instance/gen/控制receipt→persist ACK。retained已读共有run不被human HTTP失权误杀，旧真人HTTP照关；private/stop/off/delete仍终止。instance inventory含零grant旧实例，不能operationFences=[]空ACK。

executor owner只在Astra冻结后接main/control client、实际registry callback与connectionsClosed/childrenClosed。`dataClient.openCount()===0`是本进程现存inventory辅证，不能证明历史OS空；child witness必须来源真实owned登记/可信OS证明，不注入()=>true。新Agent进程不得复用旧instance/grant/关闭收据；重启恢复queued与execution-started区别保持。

## G素材必须收回的模块与可分块边界

G `b851f449` 是报告提交，产品主块 `63bfc0fa551b6147414e7ace55f69f446a05ad05`；其父 `3621460735e4f19c1224bd7991ace4836c7d0c36` 精确复制schema源4b7。main d59仅有早期asset-runtime，没有下列中央run资产登记模块；G父树是旧来源，不能整树覆盖main的新members/consent/Astra变更。

| 可收的小块 | 精确文件与依赖 | 真实门槛/现状 |
|---|---|---|
| 纯v2契约与reader先收 | `asset-root-registry-schema-v2.mjs`/test；`run-assets-current-registry.mjs` root文件原语；新 `run-assets-current-registry-v2.mjs`/test；asset-runtime的显式reservation v2分派 | G报告35/35/type0只Windows解析/SQLite与拒root目录。readRootRunAssetCandidateV2({files,expected,configuredAnchorDigest})要求同root目录current/anchor/reservation/.publisher.lock及完整epoch/reservation/publication/witness历史；独立checkpointV2与v1不可自动混用 |
| 资产private metadata/closure及observer模块 | `media-selector.mjs`、`run-assets-metadata{,-rpc,-client}.mjs`、`run-assets-closure.mjs`、`run-assets-instance-adapter.mjs`、`run-assets-observer-{authority,binding}.mjs`、`run-assets-head-client.mjs`；A internal与B consumer相应精确增量 | metadata只从physical projectStore可信stat取small size/ext，不拿original.size；identity/proveObserver不调用status同步避免head回等。observer证明原incoming socket exporter+当前epoch RAM公钥签名，不以另一private.identity请求标记旧socket |
| 最后唯一中央glue | G的doc-assembly媒体selector/resolveTierAssetRef、doc-agent-assembly.mountRunAssets、combo、main、asset-main、asset-runtime、files精确闭包 | 这些与Astra在途doc中央相交，由根先收其冻结后给一个owner。G当前combo仍createRunAssetCheckpoint(v1)，63没有自动换成V2；须明确rootProtocol:v2＋createRunAssetCurrentRegistryV2({ledger,files,expected,configuredAnchorDigest})注入checkpoint相同current/acceptCurrent接口，缺配置503，不能用v1默认值通过 |

v2 current每门核root文件+doc持久checkpoint，acceptCurrent只epoch1首次anchor、已接受高水位沿完整验证链推进；v1 checkpoint存在报migration-required，不偷偷重命名。root必须实际Linux验证root所有目录/文件/不可写祖先、单publisher锁前后无锁、file+dirsync、可信初始anchor显式配置、两代同cert OS与旧独占cgroup包括子进程FD/TCP全部空、双birth/EOF、两代pinned observer签名及SQLite耐久接受。纯模型/Windows35条、此前systemd249单段实验都不能替代它。producer/dropin/publish配置只根实施，本叶不碰节点。

worker用已实现 `createRunAssetTransport({runClient,assetOrigin,assetTls,assetFingerprint256,resources,...})`→`createRunAssetClient({transport,maxResponseBytes})`→`createProjectAssets({contextAccess,runAssetClient,workspace,resources,...})`。实际facade issue仅返回assetHandleId/ref，不给工具opaque票据；每HTTP Buffer/full raw body+TLS证明。挂进hosted-tools需独立账号branch：原 forConversation.assetClient/ensureCanWrite/ingest目前仍请求auth.ticket，账号模式必须替换为context授权ProjectAssets，local/LAN旧分支保留。导入stored与doc addMedia registered分别持久，late/cancel不绑定、同hash项目物理隔离。此块不能只有G registry“ready”就宣称工具完成。

## 可立即派工顺序与候选租约（不是本叶实施授权）

1. **Astra先交即时读/执行关闭handoff**：沿其现租doc-agent-assembly、account authority/conversation/internal/session，补精确run control instance/gen与真实receipt验证；其它owner不同时改。独立真实HTTP/SSE延迟读、private/kick/off与retained负向，固定source给根组合。
2. **Sol执行器＋可见事件一个小阶段**：候选 `server/agent-service/main.mjs`（配置/生命周期）、新 `account-executor-assembly.mjs`（真实工厂装配）、`server/agent/service/create-agent-service.mjs/account-runner.mjs`（已有分支透传、wake/drain/onEvent/info）、新account-run-events/test/probe。run-control/run-data/resources只消费，确需改再精确报租。Astra先给finish outcome的provider窄接口；Luna冻结f1309e4a UI之后仅移交cloud事件/after消费，不重写Composer。两个提交块：可信工厂+持久事件→真实双页模型短链；前块即使单测绿也不把executorMounted标生产完成。
3. **G资产v2＋一个实际素材工具**：上述纯契约/reader先独立收，中央glue在Astra交接后唯一owner串行；root Linux publisher证据是前置。另一个Sol独占hosted-tools/instance窄context传递、project-assets注入与新own target，复用已交facade，先实际import_media（临时已授权小公开fixture）stored+registered→list_media→受权读；保其它pending工具欠账，不修改23项mode凑可用。无素材短链的实现可与G纯模块回收并行。

先复用root已验真实VH/doc/独立asset/Agent HTTP/browser组合并把真实runner挂上，不再建模拟ready服务。启动仅由根核新端口段、冻结源后授权；本报告不占端口，建议未来业务使用根另租的10口段，own TLS模块目标listen0也须获窗口。成本仅既有已配置模型的小量真实调用，不新增外部服务/安装/机型；凭据仅由根按已有导入步骤处理。两模型核验由根使用已配置选择分别运行，不打印key、地址、prompt秘密；本叶未读配置实际值。

## 最短实际探针门槛

- 两真实账号从已main入口登录/创建/加入，告知同意真实持久；A发一条指定读取全员选区与添加一个内置文字片段、report_progress的短指令，B在同对话排一条读项目确认结果。每条保实际sender/messageId/arrivalSeq→grant runId/readReceipt→accepted-message witness/order ops→持久eventSeq/end；同convo首轮finish前第二轮没有模型调用。不能拿202、mock runner或纯HTTP queued当执行。
- 真模型调用实际tool_call/get_project/get_selection/add_clip/report_progress与文档op落地；B页面实际看到同片段和进度/完成，刷新与换页重放不丢不重，真实共享成员选区带可信名字/发起人标注。A离线后短轮继续，重连恢复；只验少量内置无素材修改，不声称用户卡渲染/所有工具通过。
- 单独协议fixture验模型失败/无配置/额度、event写盘失败/重复ACK/restart、old instance、读proof写拒、两个convo不串。真实private/off中断等handle.done+activeTools+signedWS+HTTP实际close，kick后旧用户零新bytes但shared已读精确current grant可继续，private停止；未知旧OS/child始终pending。对未确定效果不自动重放工具。
- G资产门槛另列同hash双项目隔离/retained旧token拒但本run素材可读/撤销实际fd流close后ACK/late产物拒；root Linux v2两代证明及真实模型一次import/登记/读通过后才称该工具可用。看画面/render、23 pending、附件/本人page bridge/用量UI、生产安装与节点公网仍各自欠项，不能用本小阶段抹掉。
- 根对最终固定联合候选跑type/必要targets/full/build和实际两页，保首红；涉及add_clip内置画面截图复核，未经渲染代码变更不为纯main装配启动全套历史C10。所有owned进程、socket、FD、子进程close证据和端口归零写原始日志，不用finally吞错当全关闭。

## 本报告验证与交回状态

本轮只有read-only文件读取、Git对象检索、报告写入及diff-check，没有模型/业务监听/Chrome/npm/type/full/build/native/Linux/节点操作；技术方案均未实现、未验收。实际产品仍d59来源字节，Astra b11是其提供的冻结部分证据，G b851/63亦只按原报告范围引用。新的模块名/接口/事件格式是三级最小建议，须根按租约分派和provider精确handoff后实施；不能把建议或历史绿色测试称用户新增批准或生产ready。

## 已授权执行事件核心小块（2026-10-09，方案后续实施）

根于db7方案之后授权新增 `server/agent/service/account-run-events.mjs` 与同名test，修改account-runner/create-agent-service及本报告；未授权main/http/instance/provider/Astra所有在途路径。以下结果与上一节只读阶段分别记录。本块执行真实SQLite持久事件及受监督emit队列，下一模型/工具先flush再fresh doc gate，commit失败同步latch并abort，实际drain之前不能结束wake。事件模式仅记录 `runner_done`/settlement pending；缺真实outcome provider时 `run-outcome-unavailable`，不能doc.finish或推进下一轮，也不把executorMounted标ready。未配置事件文件的既有受控runnerFactory fixture保留旧路径；生产existing factory必须显式提供runEventsFile/authority，否则503。

首红：npm wrapper运行同名新target，模块尚未实现，ERR_MODULE_NOT_FOUND；tests1/pass0/fail1，48.933ms，exit1，无native retry，原始TMP `pc-account-run-events-red-1.log`。测试不启动业务HTTP/WS/TLS/模型；原global-setup坏端口guards保留，不mock/scrub绕过。后续固定源码后只跑该纯target与已确认无监听的runner回归/类型，不跑full/浏览器/模型。fixtures用真实doc SQLite、RAM实例签名cap、runProvider与FULL read-intents；account sender/服务登记是受控adapter，不能称真实VH/TLS/生产执行器已通。
