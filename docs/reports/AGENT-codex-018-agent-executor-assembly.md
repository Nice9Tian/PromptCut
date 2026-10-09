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

### 已实施接口、收口与精确下一接缝

产品源码固定 `a9247fc18a009ed3dfe3da1e659264173d38968b`，之前首实现 `f5b7f4c70b7700de85189c55da406cbfdf779bf6`。只改租内四源码/测试路径及本报告，无main/HTTP/instance/provider/UI变化。

- `createAccountRunEvents({file,authorityId,verifyGrant,failpoint?,now?})`：file为绝对私有SQLite，authorityId是可信配置的doc authorityId；verifyGrant每次register由真实runClient.checkAccess(write)取得允许的runGrant，精确比project/conversation/message/run/grant、instanceId/generation、serviceKid、accountId。缺配置503，错binding403，同grant不同binding409，authority不符503。module是Agent内部证据模块，register/append/after不允许直接挂public body，也不替代doc ACL。
- 返回 `registerRun({grant})`、`append({binding,eventId,event})`、`after({projectId,conversationId,after}) -> {authorityId,projectId,conversationId,head,events}`、`writer({grant})`、`failure()/inspect()/close()`。每row为v1、上述精确binding（accountId转senderAccountId）、eventId/eventSeq/at/event。FULL事务同时写row/head；同grant/eventId相同payload原样幂等，不同409；事件内自报runId/身份会被可信binding覆盖。完整tool_result.output不保存/不外发，存outputOmitted。after仅按项目/对话索引，不能作为授权接口；未来HTTP必须先真read-control。游标负/非法400、超head409、count/max与持久head不符503 gap。原模块不是message acceptance镜像，本小块未实现acceptMessage。
- `writer` 的同步emit在yield前copy，单run serial和全store append队列监督所有Promise；`failed`是只resolve原错误的监督通知，`beforeCall/flush`仍reject原错误。实际SQLite失败latch整个store，后续gate拒、关闭实际db之后close也reject，不能吞失败冒成功。manager收到failed立即abort本run；即使wake race已经拒，也必须等runner.drain，期间activeRuns仍1。运行收口后flush再结算；缺outcome时read-intent停execution-started，手动再wake拒uncertain，不重放工具。并发两个run只有共享事件cursor，不赋予同对话并行执行能力，FIFO仍由doc/manager控制。
- `createAccountRunnerService` 与 `createHostedAgentService` 新增 `runEventsFile/runEventsAuthorityId` 显式参数；真实existing runnerFactory不能缺事件配置，受控runnerFactory未提供事件文件的旧fixture暂保兼容，不能当生产完成。服务暴露私有runEvents供未来HTTP消费，事件模式close先manager.close/idle再关闭event/read-intent db。main未透传这两个参数，生产整体仍未装配；没有改变info/executorMounted或runTicket503。
- `onEvent`实际接到manager writer，下一onModelCall/beforeToolCall在fresh doc write gate前后均flush且查cancel/closed；当前instance同步emit吞宿主同步异常的旧实现未动，宿主callback不给它裸reject Promise。原done事件改记 `runner_done`、settlement pending，仅记录runner观察，不是用户可见完成或doc finish。纯目标捕获到已解决done Promise后仍0 finish；本期没有真实outcome接口，legacy fixture finish回归不代表事件模式已经能推进下一条。

下一独占装配必须具体补：①main传可信doc authorityId与私有event文件、实际registered instance/run-data client；②HTTP accountEvents在Astra真实read-control/输出fence作用域内调用after，以eventSeq为执行游标、arrivalSeq另留FIFO位置，不直接复用旧到达游标，不把runner_done渲染成完成；③原provider owner给精确outcome/idempotent结算与跨event/read-intent/doc finish补偿接口，才解除run-outcome-unavailable；④accepted用户消息按doc messageId幂等镜像/重启补漏；⑤真实模型/工具/双页可见链、资源关闭与Astra交接验证。上述都未做，禁止用本块15目标绿写全链ready。事件模块test位于root明确租的同名 `server/agent/service/*.test.mjs`，现full默认glob不自动含此目录，根共同候选需要显式加本精准target，未改全局测试脚本。

### 固定源码验证原始结果

| 源码/命令 | 结果与范围 | 原始TMP日志 |
| --- | --- | --- |
| 模块不存在首红；npm test -- server/agent/service/account-run-events.test.mjs | 1文件级失败/0已执行用例，exit1，48.933ms，native重跑0；保留设计驱动首红 | pc-account-run-events-red-1.log |
| f5b7，以上同target首实现 | 7/7，0fail/cancel/skip，258.1632ms，exit0，wrapper wall0.4936s；无重跑 | pc-account-run-events-target-1.log |
| f5b7，npm test -- server/test/agent-runner-read.test.mjs server/test/agent-runner-scope.test.mjs server/test/agent-runner-ack-recovery.test.mjs server/test/agent-runner-early-abort-worker.test.mjs | 7/7，367.2762ms，exit0，wall0.5963s，无native重跑；无业务监听 | pc-account-run-events-regression-1.log |
| a924，npm test -- 新同名target + 上述四原runner target | 15/15（新8/旧7），0fail/cancel/skip，370.669ms，exit0，wall0.5965s/native重跑0 | pc-account-run-events-final-target.log |
| a924，绝对本机已装node＋typescript/bin/tsc -b --force | exit0/零错误/日志零输出，wall7.6850s | pc-account-run-events-final-type.log |

f5b7之后有具体代码与验证增量才复验：关闭传播持久错误、旧finished intent在事件模式拒假成功、非法file统一503、callback空event交监督队列；新SQLite触发器RAISE(ABORT)是真db INSERT错误，不仅failpoint，并发writer验证共享cursor。另一manager故障用例仍是SQLite事务before-commit受控throw，准确标为注入失败而非物理掉电/I/O损坏；actual runner是受控对象，done/drain受控gate，不是真模型/工具子进程关闭证明。新7项中增加并发项成8，最终与原7项组合15。

启动全程使用 `C:/Program Files/nodejs/node.exe` + 本机npm-cli.js，不裸node--test/npx/npm exec；NODE_OPTIONS绝对file URL指父仓库silent preload，子孙windowsHide；PSModulePath先移所有大小写变体仅留一个，process-only cuda_Vit/PYTHONDONTWRITEBYTECODE=1/models/provider/order/本叶conversation配置。只自建TMP SQLite，回收同fixture文件，未删真实权重/账号/用户数据。pure用例无业务server/WS/TLS/browser/model/child；npm global setup原坏端口guards例外仍原样执行。server/test/agent-runner-control.test.mjs检查发现会listen5795/5796/5797并spawn，未跑且没有借端口/开服务。两次只读检索命令分别遇PowerShell不支持brace路径语法、rg Windows直接glob参数不展开，改精确文件列表后查明，无测试/产品失败与隐藏监听。

结束diff-check通过，最终只报告提交、产品保持a924；本叶clean后交根冻结。全量npm/真实HTTP控制/browser/模型/节点均未跑，遵根租约由共同候选补验；未写main/push/merge/release，当前0.7.17版本未动。

## 默认全量发现与已接受消息镜像续块

根于9ae之后窄增租 `server/test/account-run-events.test.mjs`。已中文提交 `80ffbcd2008958f2cbe814048acc4a91f74cb2e1`，把同名test从server/agent/service移动到server/test，只调整7处imports，原8条断言未删；未改test-suite/global glob。node --check exit0，新位置原8/8、0fail/cancel/skip、330.602ms/wall0.7322s/native重跑0，TMP `pc-account-run-events-moved-target.log`。上文“默认不含新test”是a924时状态，80ff之后默认全量已经自动发现。

根继续授权runner/create-agent-service范围的accepted镜像私有接口。实现源码固定 `b234fabd02d973104cf850a15a32722b3d7bc604`（其余main/http/provider/instance/UI仍未改）。新增 `runEvents.mirrorAccepted({projectId,conversationId,read})`，read只可由可信内部调用者提供真实doc读取，不能给public body任意函数/消息或将send原文当authority；服务侧 `service.mirrorAccepted(identity,conversationId)` 固定调用既有 `base.conversation(identity,conversationId,0)`，走真实conversationClient.get，不另造身份权威。

持久schema在同一private event SQLite增 `accepted_messages(project_id,conversation_id,message_id,arrival_seq,content,event_seq)`，项目/对话/messageId主键与项目/对话/arrivalSeq唯一。read回包要求v2/projectId/id严格匹配；逐消息核server messageId/requestId/senderAccountId/name/content/contentDigest、正safeInteger arrivalSeq、createdAt与绑定project/account/message的selectionSnapshot及attachments。白名单不可变发送记录进入canonical内容；登录/凭据不存，可变queueState/runId/cancelReason不进冲突键。按doc arrivalSeq排序后单FULL事务写accepted索引、user事件、每对话同一个head；任意一条冲突整批回滚。同messageId相同原文与身份复用原eventSeq，异内容409 accepted-message-conflict；旧索引找不到对应event为503 gap，不凭缓存造新事件。用户事件只有真实messageId/sender/prompt/snapshot/attachments/arrivalSeq，runId/runGrantId/instance字段为null，不伪造读或运行。内部event索引用grant非法字符@作message命名空间，避免与真实grant事件冲突。队列与ACL动态投影仍由doc权威get给出，镜像不承担权限、位置或完成判断。

重要生产装配欠项：Astra冻结45c HTTP只为GET conversations/get/events建立真实readTransports.run；POST /messages尚无scope。此块**没有从send调用镜像，没有让POST自由读**。缺scope原样503，也没有把客户端prompt或doc.send仅messageId/seq的回包当完整可信原文。下一HTTP owner必须为本次POST在真实req/res/socket/pending-dispatch inventory内建立owned read scope后才调用私有镜像，并确定“doc已经接受但镜像失败”的同一requestId重试与补漏；GET重放/启动补漏同样要真实可核doc读取。当前retained执行不续用被撤销人的delegation，不能拿人体读scope做retained grant授权；暂无该无人体历史接口，明确pending。公共HTTP仍没有消费此镜像eventSeq，用户真实执行链未验收。

首红镜像target：接口未实现，原8pass、新2fail，total10、316.926ms/wall0.5541s/exit1，无native重跑；TMP `pc-account-run-events-mirror-red-1.log`，原始TypeError镜像函数不存在保留。实现后增加私有service与commit回滚两条，不重跑旧源码赌绿。固定b234一次精准组合：`npm test -- server/test/account-run-events.test.mjs server/test/agent-runner-read.test.mjs server/test/agent-runner-scope.test.mjs server/test/agent-runner-ack-recovery.test.mjs server/test/agent-runner-early-abort-worker.test.mjs`，**19/19（事件/镜像12，旧runner7）、0fail/cancel/skip、456.0139ms/wall0.6791s/exit0/nativeRetry0**，TMP `pc-account-run-events-mirror-target-1.log`。绝对本机已装tsc -b --force **exit0/零输出、wall7.4758s**，TMP `pc-account-run-events-mirror-type-1.log`。启动隐藏/preload/单PSModulePath/process-only CUDA/models/provider/order/conversation环境沿上一块，原global guard例外不变，无业务listener/TLS/model/browser/child/full/节点操作。

镜像正向source使用真正doc ledger+conversation-authority.get；account身份核验与serviceClient/read-scope是纯测试受控adapter，不代表实际VH/TLS/ALS关闭链已经接通。用例证明无scope拒绝、错项目/伪digest/body消息无可信callback拒、可变queue投影不重复、同ID更改原文409、镜像提交fault下row/head/index回滚；fault是事务before-commit注入，不声称物理掉电或跨进程恢复通过。

Astra并行提供finish方向：五元binding/requestId/readReceiptId/outcome{v:1,status:'done'|'failed'|'interrupted',eventId,eventDigest}，先录不可变outcome、缺doc已核关闭引用仍finishPending/FIFO占用。当前本叶没有实现该调用或摘要；等实际runner drain/事件flush结束以及provider固定精确schema后，下一租约才组真实终态，不把donePromise或录outcome成功当用户complete。HTTP/main/关闭/finalizer由根明确移交后再接，未覆盖Astra路径。

此次交回产品b234、报告后续独立提交，git diff --check0与clean；main/release/push/环境/真实数据均未操作。全部首红与较早绿证据按原source保留，不冒用19目标为完整模型路径通过。

## 同RAM实例执行器中央装配（开始，尚未验证）

根将Astra 21c97 HTTP/read-control收回本叶，固定715c62edb818e7975fbd1b1fe0c955b46800f6c0、开工clean，正式移交 main/http/new account-executor-assembly及专属targets，原runner/service/events仍本叶独占。Astra provider/instance/read-control/data/resources/control均只读；a87 finish尚未组合，本块继续run-outcome-unavailable，不调用旧finish，更不把pending结算当下一条可执行。根全量结束后另告5795–97释放；新增6640–6659许可仅自己的fixture，首次预检这些端口无监听，执行前仍复查。

新增createAccountExecutorAssembly配置必须给真实doc origin/CA+pin+Agent自有TLS、同一个runClient、已经装同readControl.transports的conversationClient、绝对private dataDir/root/loadModule/modelConfig、独立回环controlPort。registerInstance取持久instanceId/generation/authority后启动实际签名readControl，等真实connected，5s缺就503失败，不手动ready；构造同RAM签名dataClient与runResources，再挂真实HostedRunnerFactory/read-intents/event SQLite和mTLS run-control。main生产account路径要求PROMPTCUT_AGENT_CONTROL_PORT与公开口不同；无executor参数的原纯account-policy startAgentService接口保留作既有明确fixture/未挂运行模式，不拿它声称生产装配。账号关闭先收公共HTTP实际连接，再等read inventory/runner/data资源；不拿5s强制exit0证明close。普通LAN主路径保留。

POST /messages事件模式加入真实req/res/socket readTransports.run，doc接受后只通过base.conversation实际owned读取完成mirror提交才wake；失败传播原requestId可重试，不把body或202当可信消息。SSE先真实doc读取及镜像、验证after，再每条fresh ACL/revision+本地同步fence写出eventSeq，queue.state仍doc arrivalSeq/位置独立权威；未挂event-store的既有queued-only路径保留原cursor。启动补漏不借被撤用户delegation：mirrorRunMessage只收doc admit原完整message，逐调用真实checkAccess，比当前grant精确binding与acceptedMessageRef规范digest，才复用同accepted镜像事务；不是新ACL/retained算法。resources.contextFor来自真实read-confirmed grant，下一model/tool加freshauthorize，control先发abortForFence再await runner完成；全量工具资源producer未接，不宣称资源全盘已注册。

闭口缺口明确：run-control的connectionsClosed/childrenClosed与OS-tree producer未提供时仍pending，未以data.openCount=0/空resources或函数true作证明；旧OS unknown不因本次注册消失。真实模型、G资产桥、渲染/采集页面回连、终态outcome/finalizer仍没有本块验收。executor仅configured/mounted与completionReady:false，不能说production ready/任务成功/FIFO释放。

新constructor首红：npm wrapper精准server/test/account-executor-assembly.test.mjs，1/0pass/1fail、63.4236ms、exit1，ERR_MODULE_NOT_FOUND，TMP pc-account-executor-red-1.log保留。未启动业务服务；global-setup原38候选坏端口guards例外仍原样执行。新增mTLS fixture已编写未跑，6640 docHTTPS/6641 AgentHTTP/6642 controlHTTPS，30s测试/5s局部等待，无浏览器/真实模型/VH。真实SQLite、注册RAMkey、exporter与doc run/read-control/HTTP/SSE，sender/registry/selection/driver是受控adapter，同OS证书角色不算生产UID分离。原旧control target5795–97另有真实own child，执行前再核端口。

首次写完node --check（new assembly/main/new TLS test）exit0，diffcheck0。读取过程中3处猜测路径不存在均纠正为真实tool-context/agent/service/agent-instance-session/read-control-fixture，只有只读命令失败，无测试或产品修改效应。以下追加固定source与实际目标结果后才交付。

装配首固定c305423e960dc54fe1db7a62e5ed0a60e003e72c，pure首轮21/21、0fail/cancel/skip、480.1984ms/wall0.6661008s、exit0/nativeRetry0，TMP pc-account-executor-c305-pure-1.log；includes新constructor1、event13、原runner7。随后首次真实TLS测试首红：case1211.9856ms已失败，finally await assembly.close报account-executor-close-pending（内account-runner-pending），跳过docServer后续清理，公开6641与control6642已闭但doc6640遗留。spec最终stack被finally异常替换，不能把“真实首错误已观察为queued断言”说成直接证据；静态核fixture确把doc send不存在的accepted.queued断言true，实际源码只有queuePosition/runId:null，此为确切夹具shape错误候选，修后保真实原shape断言。

真实首次清理核到self-owned pwsh24160→node npm44528→cmd42684→suite1608→node --test37920→case37740；只case37740拥有6640，复核ParentProcessId37920与CommandLine精确test文件后只Stop-Process37740，所有6640–42无监听。原事件保留TMP promptcut-test-BSRAJS/events-all.ndjson，首次原log pc-account-executor-c305-mtls-1.log；最终1/0pass/1fail、87073.0965ms/wall87.2796995s/exit1/nativeRetry0，无cancel/skip。87秒是测试早失败后未收口进程的等待与受控中止，不写实际30秒测试通过；未杀其它进程，源全程c305未变。

根允许最窄有因修夹具：实际queuePosition正safeInteger/runId:null，等待已发生的runner pending诊断与activeRuns0后关闭，不根据done Promise声称成功；finally用allSettled且检查每条错误，真实doc/socket/db清理不能被第一条close拒绝跳过，原primary和cleanupErrors都保留，任何close异常仍失败。产品assembly.close错误未吞/未改绿，不用错误码白名单过滤异常。新固定后只一次目标，后续记录实际结果。

第二固定1b1d534f8a0278e5eb12994cefeb9fecfecb6003，实际TLS第2轮自然exit1：1/0pass/1fail、1468.8796ms/wall1.6590757s，case1359.0328ms，nativeRetry0，无cancel/skip。TMP pc-account-executor-fixed-mtls-2.log保留；主体assert执行到底未出现primary，finally fixture-owned-close-failed中明确conversation-control-client153 ledger.close “database is not open”。这是fixture同时assembly.close与controlClient.close双重owner并发关同SQLite；assembly本身成功关闭，第二直接调用错误，所有6640–42这次实际已清空，无需Stop-Process。窄改只有fixture已建assembly时唯一由assembly关read client，未建才直接关，不过滤/吞任何错误。读取with-agy技能适用条件：有新明确stack和简单修正可先修，本次未启动无目标模型讨论、不切Sol模型；不把两个不同fixture故障伪称相同无证据假设。

第3固定2ea1039db31c924b2cafb3a26c072334b778af5e，实际TLS1/1、0fail/cancel/skip、1091.1905ms/case983.3407ms/wall1.2773302s，exit0/nativeRetry0，TMP pc-account-executor-fixed-mtls-3.log。相对c305后两次仅fixture/report变，产品字节相同。此轮真send202/queuePosition/runId:null，doc完整消息唯一user event、逐run active proof/readReceipt/注册实例一致、受控model/tool driver各1、工具输出省略、runner_done settlement pending。SSE after=1仅补已持久eventSeq；真实grant仍active/currentRunId未清，不调用finish。等待实际driver已drain且manageractive0再关闭，fixture检查所有close结果，实际server/socket set0。监听6640/41/42都是本测试角色；OpenSSL隐藏同步子进程只生成TMP证书，同OS身份不能替代生产分UID/OS-tree proof。

随后已获准原control target在5795–97先零监听再跑：1/1、1122.3359ms/case1018.8786ms/wall1.3149449s/exit0/nativeRetry0，TMP pc-account-executor-2ea-control.log，原真实doc pin/实际socket+child close、错cert和缺witness仍拒断言未改。绝对typescript tsc -b --force零输出exit0/wall7.2542025s，TMP pc-account-executor-2ea-type.log。结束真实6640–59/5795–97零监听，matching owned test Node进程0，源2ea保持clean。

后续只读自查发现同一关闭ownership在main启动失败分支亦需窄保护：assembly启动失败已关闭readControl，外层boot cleanup可能再次close同一个非幂等receipt SQLite。main在创建客户端时仅包一层共享Promise close（包括原拒绝），不改Astra客户端源、不伪成功；listen失败分支finally关Vite。新增真实CLI子进程配置target，TMP独立PKI、无网络服务：正确TLS文件但缺controlPort/与publicPort相同均在登记/业务监听前配置失败，未写read-intents。普通LAN路径与原fixture-only account无executor入口不变。该main窄增量未冒用较早2ea TLS结果；固定后target/type单次补验记录下方。

最终产品源码4689324bf6501ff37726d3f9c5125b32b568cbf3，补验 `npm test -- server/test/account-executor-assembly.test.mjs` 2/2、0fail/cancel/skip、1308.6094ms/wall1.6265864s/exit0/nativeRetry0，TMP pc-account-executor-468-pure-2.log；真实子进程以正确TMP TLS文件但缺/共用控制口在register/listen前失败，未启动业务listener。绝对tsc -b --force零输出exit0/wall9.1179657s，TMP pc-account-executor-468-type-2.log。main变更导致有因补验，没有再跑已经通过且产品不变的TLS/control/21项纯组合，不重复全量。后续本提交只报告，product固定468；所有git diffcheck/nodecheck0，结束clean/no own监听或matching test进程。

本次实施文件边界（相对715基底）：

| 文件 | 真实实现与范围 |
| --- | --- |
| server/agent-service/account-executor-assembly.mjs | 新工厂注册sameRAM、真实read connected、同RAM data/resources、private event/read-intent、mTLS control、queued metadata恢复周期、owned统一关闭；completionReady:false |
| server/agent-service/main.mjs | 生产account窄挂factory/独立控制口，启动失败close唯一归属与Vite finally；account关闭去掉无证明成功强退；旧LAN与显式无executor fixture模式保留 |
| server/agent-service/http.mjs | event模式POST实际read scope与SSE持久eventSeq+fresh ACL；queue仍doc权威；非事件queued-only原行为保留 |
| server/agent/service/create-agent-service.mjs | 仅向既有account工厂传dataClient/resources |
| server/agent/service/account-runner.mjs | doc admitted消息摘要镜像、before model/tool resources fresh授权、POST实际mirror后wake；原strict outcome pending与生产closure缺口保留 |
| server/agent/service/account-run-events.mjs | mirrorRunMessage消费doc消息+fresh grant exact accepted摘要；原镜像/SQLite幂等机制复用 |
| server/test/account-executor-assembly*.test.mjs | 新constructor/真实CLI配置负向及实际mTLS/HTTP/SSE短链；首次两红完整留档 |
| server/test/account-run-events.test.mjs | 新current grant消息恢复正负向，原run事件列表增加真实user，未删原失败断言 |

server/hosted/doc-agent-assembly.mjs、provider/instance/authority/runClient/read-control/data/resources/control、G资产/部署清单、src UI都未改；无main/push/merge/节点/真实cipher/模型Key读取与依赖安装。Agent部署原deploy.mjs共用render完整检出，并不是hosted/files的asset闭包；这次没有部署/stage验证，也不将源码import绿写成节点可用。生产需root明确控制口、Agent自有兼具管理端serverAuth的TLS证书/CA+doc pin、doc服务当前注册策略及private目录，根导入模型密文而非本叶读值。

下一最短接缝明确，尚未完成：

1. Astra terminal control/queryFinish/provider固定后组合；manager.prepareTerminalClosure必须匹配独立completed entry/readReceipt/outcome/instance/gen与resourceWitnessId，不能拿旧closedRuns Set/取消drainControl生成正常完成证据。当前done被映射runner_done/pending，handle.done无权决定成功；缺producer保持503/FIFO占用。
2. src/ai/cloud/events.ts当前账号user只建cq-messageId，run事件未建ca-runId，targetIndex<0导致text/tool被忽略。本叶只读发现已报根：下一最窄events/types/parser目标要让真实run创建一次助手并绑定原messageId，runner_done pending不能当done。本块虽真实SSE可重放，不代表用户已经看到真实模型输出。
3. 真正HostedRunnerFactory＋同RAM数据WS/project.open+工具入口＋两浏览器短链及模型调用还未执行，本次TLS driver是受控对象，不冒称真实模型/图像/素材/生产UID/OS证明。无full/browser/native/model/node，此轮按根授权只做自己的protocol targets与type；根共同候选后再验。

交回时原首红、原17/19/21/2目标和不同source的type按各自索引保留；不把第一次中止删改为成功，不凭报告改动重跑全量。最终状态是“执行器中央装配小块完成，终态与UI/真实模型链待下一块”，不是 .18 全业务终点完成。

### 账号持久运行事件到页面助手气泡（后续窄块，固定源与证据独立）

根在装配468/报告738冻结后授权仅 src/ai/cloud/events.ts、同名新test、cloud专属types及必要parser；CloudAiPanel/useCloud/Luna控制、session/HTTP/provider/instance/control/资源底层都未改。真实服务HTTP accountEvents输出是 `{...row.event, seq:row.eventSeq}`，来自 runEvents.after 的FULL持久row；append覆盖projectId/conversationId/messageId/runId/runGrantId/instanceId/instanceGeneration/serviceKid/senderAccountId九字段。用户原件只来自doc镜像，run字段为空。新页面只在完整正seq v2 run与原cq-messageId的project/conversation/message/sender匹配时建一次ca-runId，插到原用户消息之后；后续事件逐字段核同grant/instance/代际，不使用lastassistant兜底。部分v2 user不回落成旧run气泡，旧合法队列fixture形状与LAN完成行为保持。云端专属CloudAccountMessage交叉类型携带cloudAccepted/cloudRun/cloudAcceptedMessageId，不扩大本地ChatMessage。

runner_done与账号raw done/end仍pending，无outcome/finishedAt；状态与progress.text显示“执行已结束，等待云端确认关闭与结算。”，既有MessageList简洁activity读取这个text，不再伪显示继续思考。模型error可以显示错误但不自动宣布资源关闭/结算完成；Astra新c705终态接口只读收到，未组合到本轮。任何doc已核finalizer事件目前未接，FIFO仍由doc占用。

首纯红：TMP pc-executor-ui-red-1.log，5项2pass/3fail、89.5266ms、exit1；明确run未创建助手，文字与pending目标因没有助手而失败。修9fa后新5+原cloud-chat/account-queue合30/30、1599.858ms、exit0；type9fa零错误（pc-executor-ui-9fa-type.log）。7bb增加真实React夹具与待结算progress，pure30/30、1585.1236ms/wall1768ms；type首红2个TS2322，必需RunProgress.phase遗漏，wall6755ms（pc-executor-ui-7bb-type.log），不能用较早9fa绿掩盖。6f44075e补必需phase字段为settlement-pending，type0/wall6657ms（pc-executor-ui-phase-type.log）。d31d3022886207059be5b36c7e258c2a5e0cdde6再拒缺字段账号user回落，固定纯30/30、1563.8194ms/wall1746ms、type0/wall6588ms（pc-executor-ui-final-target.log与pc-executor-ui-final-type.log）。每轮有代码/断言变化才复验，没有全量或native重跑。

新增可见层真实探针：scripts/probes/account-executor-visible-probe.mjs（第一import no-user-dirs）；scripts/probes/fixtures/account-executor-visible/index.html/page.tsx；server/test/fixtures/account-executor-visible.mjs。实际doc SQLite、同RAM实例注册/exporter proof、read inventory、AgentHTTP、持久SSE，页面真实CloudApi/CloudSession/MessageList；账号核验、registry、selection、model/tool driver是受控adapter。独立Vite configFile:false/no产品server插件、TMP cache与Chrome profile；OpenSSL仅TMP临时CA角色cert。不是完整Editor双页、VH、真实模型、数据WS或OS-tree证明，没有fetch/native/SSE替身，没有手动ready/closure true。

根授d31一次6640(doc mTLS)/6641(AgentHTTP)/6642(control mTLS)/6643(Vite)窗口。首次实际运行exit1、probe wall18069ms/wrapper18313ms，1check/1pass前置空口、completedfalse；真实页面渲染后等待待结算文字15s Timeout。原log pc-executor-visible-d31-first.log/result.json/failure.png完整保留于TMP；Chrome43044，source/sourceAfter均d31，nativeRetry0，没有自动重跑。截图只有实际空MessageList与reconnecting，不能说文本/工具已可见。静态定位夹具createCloudApi只传ticket但未传grant，send实际先调用deps.grant??cloudGrant；未设置CloudIdentity，current()拒，发生在POST之前。这是确切fixture配置遗漏候选，原raw没有记录HTTP数组/子phase，不能事后冒造首次网络详情。

首次清理全完成：result.cleanup browser/vite true、fixture closed:true/socket0/ports6640–42；TCP复核6640–6659零监听，matching private Chrome进程0，源clean。尚待根批准fixture最窄grant回调/安全阶段诊断以及一次修后真实窗口；本报告不把首失败删改或当可见链通过。

第二次真实可见首红与契约更正：固定655d796d294d2b67ce46163ef88f5195261b8134只补fixture grant:async()=>undefined与安全子phase/HTTP status；真实账号opaque delegation仍由ticket给后端，不mock fetch/SSE。第二次自然exit1，17733ms/wrapper17973ms，1前置通过、completedfalse，Timeout在real-submit-and-pending-output；实际网络POST202/SSE200，UI cursor6/user1/assistant0，error false/submit disabled true。Chrome14488和全部服务真实close，6640–6659零监听，source前后655未变，TMP pc-executor-visible-655-second.log/其out/result.json/failure.png完整保留。

更正本节较早契约描述：server/agent/service/account-run-events.mjs accepted user的scope确实保存在FULL row顶层，而row.event在原source不含projectId/conversationId；HTTP原只展开row.event，丢失scope。较早稿把row与event混说为user wire已有完整scope，不准确。此次202/200/cursor6证明发送与持久事件已到，但绑定消费者拒创建助手，绝非首可见链通过。根授权产品HTTP窄修，只有service.runEvents SSE分支将真实row.projectId/conversationId在row.event之后投影，seq最后固定；不让event覆盖可信scope，不改accepted original/eventId/eventSeq/SQLite内容，不从public body补字段，queued-only/LAN原wire保持。

修后固定f55677813bf97b3d901dabc77612a8c4fa245ece，新增server/test/account-executor-visible-wire.test.mjs实际TLS/docSQLite/AgentHTTP/SSE：POST202原runId:null，原存储user.event仍无projectId，真实wire user.projectId/conversationId等于doc绑定、messageId与accepted/run一致、sender与run一致、seq全程1..6、终态pending、grant active。npm wrapper target1/1、1192.7726ms/case1074.1273ms/wall1412ms、exit0/nativeRetry0，pc-executor-visible-scope-wire.log。实际6640–42前后零监听，fixture检查socket0且所有close结果；无mock HTTP。强制绝对tsc -b --force零错误、wall7239ms、pc-executor-visible-scope-type.log。新增src纯30目标仍归d31证据，f556只改HTTP+新wire目标，旧type/assemblyTLS不冒给新source。

第三次真实React探针固定同f556，全程source/sourceAfter一致、repo clean：7/7、0fail、completedtrue，probe3326ms/wrapper3590ms，exit0/nativeRetry0。TMP pc-executor-visible-f556-third.log与out/result.json/visible-first.png/visible-replay.png。POST202、SSE200，原cq用户和关联ca助手各1，Controlled actor/Controlled result/get_project实际DOM可见；重新读取持久记录后cursor6、同气泡计数1/1且文字和工具仍在，无重复发送/新建。受控模型与工具各执行1，doc grant仍active，completionReady:false、pending true，不把runner_done/网络200称为任务结算成功。本人目视visible-first.png实际文字、工具及待结算状态，完整Editor双页/真实模型/生产OS证明仍待根后续联合验。

第三轮owned Chrome4380实际退出，browser/vite close true，fixture closed:true/sockets0，所有6640–6659 TCP复查零监听、matching本TMP Chrome进程0。立即归还窗口，未持有服务等root。探针CLI使用绝对Node24与父仓库fileURL silent preload，标准唯一PSModulePath、CUDA/models/provider/order仅当前进程；临时PKI OpenSSL windowsHide，Vite无产品server插件并用TMP cache，Chrome pipe:true/privateTMPprofile，不读取生产模型/cipher/密钥。原global-setup坏端口guards仅npm target照原仓库执行，不mock；Chrome探针本身没有全量wrapper/native retry。没有full/实际模型/节点/public/browser宽压测。

结束仅按根提醒改main文首说明：5秒退场明确只属旧LAN；账号模式等待真实资源关闭，不改任何新关闭行为。该注释/report在f556实测之后另提交，运行代码无变化，根仍会在自己新共同候选做门禁；不因此自行重复已绿type/目标/browser。Assembly468/报告738证据、UI9fa/7bb/6f/d31、夹具655、HTTPf556证据逐source分别留存；全部首红（纯5/2/3、类型2错、真实可见两红）不清除/改写为成功。

本后续块实际新增/修改边界：events.ts、cloud types.ts、新events.test.mjs；HTTP service.runEvents用户scope投影；新专属真实wire target；new private fixture/React页面/probe；main仅关闭说明注释；本报告。CloudApi parser无需改，session、CloudAiPanel/useCloud、Astra run/instance/provider/control、Luna/UI控制、G资产/中央/部署参数未改。终态c705仅收到schema未合；prepareTerminalClosure/独立resourceWitnessId/实际模型工具/渲染身份等欠项如原报告保留。最短用户可见SSE消息列表接缝本层已经真实验证，不能扩大称 .18整链已就绪。
