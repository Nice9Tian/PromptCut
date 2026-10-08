# 项目素材隔离实施报告

任务分支 `codex/018-asset-isolation`，起点 `986ebec6ba36900a1944188b02b4399fb815de7a`。Sol 独占本工作区的素材服务、物理 store、媒体队列/转码/流接线及专用测试。卡片包冻结；不改中央组合、票据、账号、doc 权威或其它已租文件。不合并、推送、部署、升级依赖或碰真实用户数据。

## 已授权目标与边界

素材按项目物理隔离；知道 hash 不能跨读。A/B 合法分别上传同字节各自可读，B 未入库拒绝；删 A 不影响 B。持续流失权立即关闭，异项目、旧授权与迟到产物不能入库。GET/HEAD/Range/chunks/upload/complete、绑定、PCM、tier、thumb、stream 及队列缓存覆盖。中央 owner 后续挂载，本包不宣称生产组合已接通。

已读 AGENTS、developer_guide、suggested_agent_behavior、constraints、solution_table、verification、multi_agent、git_and_release；素材 product/mechanism、materials 工作流、asset-store-contract、three-versions-018-design 的素材包与接口、render-scheduling-supplement 全文。旧契约任意有效项目票据可读所有 hash 的条款与 2026-10-08 已定产品冲突，本包按已定隔离收紧；本地默认兼容。调度的内存/磁盘阶段不授权提前回收、故障 A/B 或删除策略。

## 接口与验证计划

先交 `createProjectAssetStores/authorizeAsset/openProjectStream` schema，与 doc-authority 的唯一身份/项目授权核验及撤销流协商，不复制权限账本。后做可独立运行的真实 HTTP 素材服务和队列/流负向测试。5780～5789 为独占端口；只用 TMP 合成数据与进程级环境，Node 绝对预载主仓库静默 helper，所有子进程隐藏并等 close。Python 如使用设 cuda_Vit、PYTHONDONTWRITEBYTECODE=1，models 仅进程指主 out/models。

定向测试、真实 HTTP 探针、强制类型检查、一次完整 npm test；所有失败与耗时照实保留，有代码/证据变化才必要复验。中央接线与 Linux/真网络由根后续验证。

## 开工记录

- 起点与工作区干净已核；初次只读搜索误用 Bash 花括号展开于 PowerShell，ParserError、未执行读取/变更；改明确文件清单后读取成功，不算测试。
- 状态：开工，未实现、未验证，不以计划替代通过。

## 第一块：物理库与授权接口

- `server/asset-store/project-stores.mjs`：`createProjectAssetStores({dir,kind='fs'|'memory',contentTypeForExt?,chunkSize?})` 返回 `{v:2,project(projectId),store(projectId,ns),removeProject(projectId)}`。project 返回 `{v:2,projectId,root,dir,dirs:{media,snap,px},stores}`；目录 `dir/projects/sha256(projectId)/out/...`，没有全球 hash bind，projectId 不作路径片段。内部删除机制需中央先授权、停任务/流，不新增用户删除策略。
- `project-access.mjs`：`authorizeAsset({authority,principal,projectId,action,resource})` 必须 project 匹配并每次委托 `authority.checkAccess`；`openProjectStream` 先同步登记 `authority.subscribeRevocations(context,callback)` 再核验，回 `{signal,assert,track,release,closed}`。撤销回调同步 abort/destroy，再等真实 close；持久消费/ACK由权威 adapter 实现。`createProjectAssetAccess({authority,resolvePrincipal(req)})` 不认 HTTP body 自报身份。
- doc owner 已确认 opaque `authorizationId` RAM 绑定原凭证、逐次问 account.verify；公开 account/login/credential 字段不构成授权。当前 adapter shape 已发对方，待其实际 schema 校准，runGrant 必须由 doc 授权，不能仅 body 自报。
- `node --test server/test/asset-project-stores.test.mjs`：6/6，0失败/跳过，113.7763ms；TMP/promptcut-asset-project-stores-1.log。覆盖 fs/memory 三 namespace 同hash独立入库、B未入库不命中、删除A不影响B、路径编码、逐次权威核验、持续流close及check等待中撤销竞态。

## 第二块：真实 HTTP 路由与项目归属贯穿接线

- project factory v2 把 media/snap/px 分到 projects/sha256(projectId) 下的独立物理目录；同内容分别上传分别落库，移除 A 的内部 store 不动 B。retired scope 的旧引用也拒绝继续用。纯本地无 factory/options 调用保持原目录和接口。
- asset-service 按注入 projectAccess 从可信 principal 选 store，每次核 doc checkAccess，云端回环不放行；GET/HEAD/Range/chunks/complete/upload 三命名空间及旧 /@media 接线经过授权。云端响应 no-store；持续读 stream 注册撤销，先同步 abort/destroy 再等 close。principal 的 opaque authorizationId 必须由 doc 提供，公开 accountId/loginId/runGrantId 自报不能替代。
- media 插件用项目 root + ALS 请求 context，legacy 路径/PCM/file/adopt/local/tier 查询只能看本项目；全局 EXPORT_DIR 不能覆盖项目目录。remote/pull 和 queue target 需中央注入 verifyRemoteTarget，返回 projectId 不同拒绝。/api/media/adopt 已在当前包；缩略 /api/shots/thumb 新授权、项目 shotsDir 和 GET/HEAD 实路由测试已获根扩租。shots 检测、安装、任务状态等仍待 perception owner 接权威，不声称全 shots 授权已挂载。
- 后台 tier、upload queue、media stamp/ingest、frame stream、usage ledger 增加 projectId/ownership 注入和发布前重核；待下一块专用 worker/队列/持久化负向测试。这次提交只是接口接线的可审暂停点，不把这些尚未覆盖的分支算验收通过。
- 与 doc owner 实现 ba10c8d2 实际字段对齐：resource.ns 为 media/snap/px；subscribe context 传精确 accountId/loginId/credentialId，跨项目/其它账号登录事件不关错人；project-created/member-joined/unban 不作撤销。doc 回调仅唤醒，不能自动 ACK；持久 eventsSince 连续追齐及 ackAccessEvent 重启协议仍需可信资产 adapter，下一块落实，当前不声称持久 ACK 已完成。
- 首 HTTP 尝试因 fixture ROOT 多上一级导致 ENOENT .worktrees/server/asset-service.ts，4/4 失败、232.1264ms，尚未开 HTTP；修正精确路径后 HTTP-2 4/4、899.565ms；加入已授权 shots 后 HTTP-3 5/5、1749.6626ms。完整日志均留 TMP/promptcut-asset-project-http-{1,2,3}.log，没有抹掉首次失败。
- HTTP-4 + store 定向 11/11、零失败/跳过，933.7245ms，TMP/promptcut-asset-project-http-4.log。真实端口5780每项关后复用；覆盖三 namespace A/B、B未知hash拒、B独立入库同hash可读、A删除B可读、回环无证401、PCM/旧URL/私路径/adopt/remote错项目拒、实际上传不污染全局目录、撤销持续流close、缩略filename隔离。合成 principal/provider 是测试夹具，不冒称真实 account 服务或生产中央已挂载。
- type-1 --force 已零错，TMP/promptcut-asset-type-1.log；属于此前源码，新块提交后仍要最终 type/full。未启动服务/节点、未合并其它分支/推送/装依赖/改用户数据。
- 本次一次文本编辑用绝对 cuda_Vit Python -B，未显式加该命令 PROMPTCUT_TEST_PYTHON/PYTHONDONTWRITEBYTECODE 环境；这是进程配置漏项。仅运行 stdin 文本编辑，没有 import 产品包/生成 pyc/安装/用户目录写入。后续命令已显式设置，两项不再省略。

## 素材入口旧探针模型一致性补丁与暂停点

- 根的基底 asset-path 首轮28过/1失败，P7 URL 为 template 而 direct 起末点略有差异；只读核 pyEnv 继承根 PROMPTCUT_MODELS，editor 明确覆盖自己的空 MODELS，证实输入模型目录不一致。
- 按根扩租仅给 pyEnv 加 PROMPTCUT_MODELS: MODELS，与 editor 同一探针临时目录；保留模板逐字段比较、其它断言及全部已安装真实 weights。同一探针一次验收待根收 auth 测试生命周期修复后执行。
- 本次提交后干净暂停，根将在本工作区收回独立 auth fixture 修复5bd65d27，通知后继续专用负向、type及一次完整 npm；此暂停不代替最终验收。

## 第三块：后台产物与持久撤销消费者

- 新 createAssetRevocationConsumer({authority,file,serviceId:'asset'}) 直接适配 doc authority 源码815510cf：subscribe只即时fence和唤醒，eventsSince逐页连续追齐head；启动未齐/缺口/损坏文件/停服务拒开放请求。每次checkAccess前后追齐、原始401/403保留。无TTL权限缓存、不生成账号或项目权限、不保存token/authorizationId。
- 通知回调同步abort/destroy，等待stream实际close及owned child close；完成后先写file、fsync、rename（Linux还fsync目录），再ackAccessEvent complete:true。只存v1 cursor/pending exactreceipt；ACK丢失/重启重发同receipt。receipt未成功落盘绝不先ACK；通知重复/乱序不能跳序ACK，已追齐旧seq只唤醒、不重新撤当前流。持久provider/channel或追齐失败关闭活动流，停服务同样关资源。可信serviceId来自构造接线，不作为外部HTTP body授权。
- 消费者是可注入服务模块，尚未接中央mTLS transport、生产持续事件通道与完成barrier；中央owner必须先await start，再createProjectAssetAccess，res/worker/queue关闭完成与receipt由该可信实例负责。runGrant权限仍由未来doc run authority核验，本包没有自报runGrant绕过。
- factory在putChunk/complete发布钩子加assertActive，px维护必须store.projectDir与px namespace精确匹配，不能配到另一个project。云端默认不启用旧本机自动px eviction，没有实现新调度/提前回收政策。v2 service ledger独立render-v2.ndjson，A/B同hash计两份实存，disown/dropA不摘B，旧v1不误回放。
- tier后台独立lease可追踪真实ffmpeg子进程；input/cache/queue/target带projectId，每项发布前重核，失权临时.small/.remux清理。真实自建公开32×32视频分别验证合法转码登记与编码后lib.hashFile期间撤销：迟到小尺寸未登记、未入队、未留下完整新文件。源码输入和已有原件保留。
- StreamStore按projects/hash(projectId)物理分开，manifest含projectId，读取HTTP需projectAccess；producer result归属不一致及失权save/adopt拒。中央frames插件尚未租/挂载，这里实际isolated清单/init/segment HTTP已验，不能冒称生产frames全部接通。
- worker-1 11/11、535.971ms；补真实ffmpeg及缓存检查后的worker-2 12/12、719.5836ms。TMP/promptcut-asset-project-workers-{1,2}.log。此前缓存测试误写.tiers.json、未触发实际tiers.json加载，后精确修正真实文件名后再覆盖，不把旧证据算缓存验证。
- 合并定向target-1共23项22过/1失败，1146.1415ms：HTTP与worker两个测试文件并行都起5780，真实EADDRINUSE，是本包测试端口布局失误。没有终止别人的进程；worker独立fixture改5782，stream5781，HTTP5780，均在独占段内；target-2 23/23零失败/跳过944.5352ms。完整首轮失败和修正日志均留TMP/promptcut-asset-project-target-{1,2}.log。
- type-2 --force零错，TMP/promptcut-asset-type-2.log；待固定块后的最终检查。新增isolated资产probe直接实际服务模块，明确productionMounted:false，重放旧hosted residual已知hash反例，正反向结果JSON写TMP。
- asset-path按根授权pyEnv模型目录一致；另Chrome改pipe仅消除随机调试TCP，浏览器行为/模板断言不变。独占5780～5782舞台及5785计数服务，真实探针随后在固定源码跑；没有改已有真实weights/全局环境。

## 固定源码前最后关闭缝与实证

- asset-path固定29d0f60e完成29/29、退出0，TMP/promptcut-asset-path-project-1.log；P7真实URL/direct均template逐字段完全相同，P10旧包临时路径同结果且删除，P11地址/本地BGR像素逐字节一致。默认MODELS继承差异已消除；这只证明模板fallback，不宣称安装模型真实推理已验。browser用pipe，舞台5780～5782/计数5785已全部自然关闭，未碰他人树。
- isolated资产probe固定29d0f60e 26/26、退出0，TMP/pc-asset-project-isolation-final/result.json与promptcut-asset-isolation-probe-1.log；该probe不连接真实account/中央、不冒称Linux生产全链，重放了旧hosted hash残余反例已被本isolated服务拒。
- 只读复核发现分片写fd/complete哈希读fd此前只靠请求体destroy及发布前核验，ACK没有显式等这些实际文件流close。新增guard.track登记fs output/input并将lease AbortSignal交pipeline，media上传也登记真实write stream；收到撤销会abort pipeline，完成回执等文件流真实close。此改动在旧probe完成后实施，没有边运行Vite边改受监视源文件。
- 新增关闭追踪后target-3 23/23、零失败/跳过1475.522ms，TMP/promptcut-asset-project-target-3.log；type-4 --force零错，TMP/promptcut-asset-type-4.log。target-2和旧probe证据不冒称覆盖这条最新产品增量；完整npm及isolated probe会在新提交固定源码再验一次。

## 完成状态、最终验收与中央接线表

当前状态：本包已完成独占模块、真实 isolated 服务和测试，停止实现；不再是开工状态。最终产品源码56af4573，随后仅本报告更新。根收回的认证测试生命周期修复434eece9（来自5bd65d27）只含其测试/报告，归根授权，不是本包擅改。

| 提供方文件 | 实际接口/持久结构 | 中央或下游必须接什么 |
| --- | --- | --- |
| asset-store/index + project-stores | createProjectAssetStores({dir,kind:'fs'或'memory',contentTypeForExt?,chunkSize?})；v2 project(id) -> projectId/root/dirs/stores/assertActive；store(id,ns)；removeProject内部机制 | doc核准确项目存在/归属后选库；删除前终止全部项目任务/流，不能由HTTP自报ID调用removeProject；无旧生产数据自动迁移 |
| project-access + project-revocations | authorizeAsset/openProjectStream；createAssetRevocationConsumer({authority,file,serviceId:'asset'})；await start()；createProjectAssetAccess({authority:consumer,resolvePrincipal})；v1 cursor/pending exactreceipt | provider注入doc checkAccess/subscribe/eventsSince/ack；每次principal opaque authorizationId重新核真实账号与doc成员；中央mTLS身份/事件持续通道/服务掉线close/完成barrier仍需挂载 |
| asset-service.ts | assetServiceMiddleware(root,{projectStores,projectAccess,serviceUsage?})；serviceUsage必须projectScoped:true | 同时传双对象才启用云模式；无双对象纯本地兼容，不能把云中央默认当已保护；旧GET/HEAD/Range/chunks/complete/upload均按req principal选store |
| vite-plugin-media.ts | mediaMiddleware(root,{projectStores,projectAccess,verifyRemoteTarget})；scoped root用于mediaDir/storeMediaStream/adoptMediaFile/mediaTierService；remote target校验返回projectId/base | verifyRemoteTarget须可信核远端项目票据/注册服务，不能只回body.claim；/api/media/adopt按物理root；中央媒体导入/worker必须传播scope，不能直接用全局root绕过去 |
| vite-plugin-shots.ts | shotsThumbMiddleware(root,{projectStores,projectAccess})；shotsDir(scopedRoot) | 只覆盖/api/shots/thumb读口及目录hook。perception owner补其它detect/jobs/install/status权限与生成thumb时scope传播；本包没有改这些其它路由 |
| frame-stream.mjs | StreamStore(root,{ownership,projectAccess})；StreamProducer(pipeline,{ownership,projectAccess})；result.projectId；清单projectId | 中央frames owner传doc核ownership和projectAccess，生产者close及队列/worker终止完成纳入中央完成barrier；当前未改vite-plugin-frames/pipeline挂载，不声称生产所有stream已切库 |
| media-tiers/upload-queue/media-pull/media-stamp/media-ingest/queue-local-media | ownership {projectId,assert,acquire?}；queue item.projectId/target.projectId；tiers.json含projectId；每项目remote state；入库回包需同projectId | 持久队列只存归属和内容，重启重取当前授权；每项目独立queue/tiers目录；旧runtime authorizationId仅RAM引用，不能落token。Agent collect/工具端传播由其owner完成 |
| service-usage/px-evict | projectScoped账本render-v2.ndjson；project/namespace/hash独立键；px store.projectDir精确验证 | 容量硬保护507保留，超容量任务排队/Agent优先由render调度owner接内部背压，不在本包实现新回收/调度业务 |

- 最终固定源码56af4573的 isolated probe-2 26/26、0失败，退出0，TMP/pc-asset-project-isolation-final-2/result.json、promptcut-asset-isolation-probe-2.log。真实HTTP断言列表保留完整输入/输出status；没有依赖浏览器工具入口，旧hash跨项目残余在服务层变为404。
- 一次完整 `npm.cmd test`（Node绝对静默预载、cuda_Vit/PYTHONDONTWRITEBYTECODE配置）4955总、4954过、0失败、1既有跳过、0取消，68825.3059ms，退出0；TMP/promptcut-asset-full-1.log。未出现旧fake CLI悬挂或本次C62 EPERM，不等于证明其它分支竞态不存在。没有同源盲重跑full；root另租Astra竞态修复没有合入本包。
- 最终type-4 `tsc -b --force` 零错误；针对性target-3 23/23。类型/全量只对当前资产分支源码，不冒称卡片/账号/doc/真实节点组合候选已经联验。
- 5780～5789验收后零监听，所有本任务服务/browser自然关；仓库无生成artifact、无secret/cipher读取、无dependency/environment/用户数据/节点/merge/push/main/version/release操作。最后diff --check通过，报告提交后git status应为空。
- 相对base986ebec6，排除根收auth的两文件，本包25个文件、此前原始统计1136新增/90删除（本末段报告会增加文档行数）；实际最终raw git diff --stat由交回消息提供，不以这条预估冒称最终diff。

一级风险/未做成原因：没有新增待用户决定。生产组合仍需中央接线、真实account/doc/mTLS撤销事件、权限票据重签、runGrant核验、Agent/perception传播及Linux真网络权限探针；这些文件由其它owner租用，本包按授权不能代改。当前provider fixture使用opaque引用和连续事件模拟，不把它说成真实跨服务部署完成；根整合应重新验真实hash跨读原反例、改密/kick持续流关闭与各服务完成barrier。调度50对话/阶段容量、未来提前回收/故障A-B/删除权限并非本包实现授权，未借此扩大018业务。

## 根复核后继续：真实关闭与异步发布边界修正

- 根审443/56发现HTTP finish先于源stream actualclose，明确授权本叶继续最小修复；旧443/56的所有通过仍是旧证据，不能冒用本增量。未触中央/wire/票据/doc/账号/进度租文件。
- close-boundary-1真实HTTP与Readable _destroy callback gate：客户端已收完整body、source.closed=false，旧release解除订阅，持久事件却已complete ACK；1/1失败564.1137ms，TMP/promptcut-asset-close-boundary-1.log。明确证明缺陷，未把finish当close。
- lease.release现在禁止新动作，但等待所有tracked close并保留撤销订阅；track记录晚返回的实际资源，wait动态追齐直到全部actualclose，不用exitCode/HTTPfinish代替。hold/run登记异步I/O/发布/回退整段，trackHandle跟踪真实FileHandle close。资源收口失败failClose保留barrier拒complete ACK。
- frame读口改为显式open+readFile(signal)+finally close，租约覆盖open/read/实际close；异步fd读gate后res.destroy也不能提前完成闭流回调。media/shot open/stat的在途I/O也加hold与FileHandle追踪；BlobStore stat/read/chunks/putChunk/complete全段run，防请求finish解除尚在IO中的资源。
- close-boundary-2（旧发布代码）4项2过2失败791.4096ms：media rename在途撤销仍先完成闭流，StreamStore.save失权后晚落新manifest/cache。原始日志保留；同轮真实HTTP finish gate与fd gate已通过。close-boundary-3修正后4/4、856.0047ms，随后补pending可见性/重启5/5、795.8659ms（-4.log）。
- 〔裁〕对项目发布增加按target串行的小事务、持久意图与回退，替代仅前后assert（已实证会晚发布）或直接删除目标（会误删已有同hash/旧清单）。新目标在最后权威重核接受前带project-publication.json，实际asset GET、/@media、file与frame读口不可见；失败删除本次新目标、或备份恢复旧manifest；旧全件/dedupe及原输入保留，cache仅成功后更新且项目cache拷贝防caller提前改它。意图只含本目录路径，无账号/凭证。factory首次打开本项目目录恢复未完成意图，路径不在本目录/跨B拒，坏记录fail closed；没有改用户删除政策/其它项目或历史文件。
- 接受点是发布和索引完成后最后权威/lease fence核验成功；之后撤销保留这份已接受内容，仍等待意图清理收口。之前撤销必须回退且ACK等回退结束。回退失败留意图使目标不可读、failClose拒完成ACK；重启本项目目录恢复，不能把进程退出/HTTPfinish说成产物已正确接受。
- 新project-io为独占模块。媒体upload/adopt/pull finalize、tier发布和frame init/segment/save接同一guarded publish；原本地调用保留既有atomic/目录行为。frame项目cache与caller分离，新manifest未接受不覆盖已接受cache。
- target合跑-1共28项27过/1失败5416.6129ms，原因是本包旧单测假设release同步unsubscribe；按新合同改为await release后保留原false断言。-2 28/28、1226.9154ms；最后补tier/segment等实际同helper后-3 28/28、3001.9382ms，TMP/promptcut-asset-close-target-{1,2,3}.log。close-type-{1,2}均零错，最新完整块固定后仍需一次type/npm；不盲重跑旧full。
- 三次apply_patch因同一文件hunk非升序而找不到前段，均未落部分修改；拆成升序/精确片段后修正。不算测试，不归咎产品。所有尝试如实留工具记录。

## 目录耐久复核与本轮证据边界

- 固定cf49240a期间没有修改源码：close-type-3零错；close-probe-1为26/26（TMP/pc-asset-project-close-final/result.json）；close-full-1为4960总、4959通过、0失败、1既有跳过，98823.2154ms，退出0。cf的意图仅文件sync，没有父目录fsync，前段“持久意图”在cf上只证明正常进程/重启恢复，不能作为Linux崩溃完整证明。根指出这条实际缺口后再修，未冒用cf全量作后续源码证据。
- 〔裁〕补最小目录耐久顺序：temp和备份文件sync；新建项目/分片目录连同祖先目录sync；marker内容sync且父目录sync先于target rename；rename后目录sync；最后权限fence成功再移marker开放读口，父目录sync完成才能正常收口。故障时先耐久回退目标再清marker；清marker后的目录sync故障保留已经开放的接受目标并failClose拒complete ACK，不能再回滚已开放内容。替代仅文件sync/仅最深目录sync均不能保证文件名和新目录在Linux崩溃后存在；验证尺子为真实文件syscall加可注入目录故障的严格顺序断言。
- 接受权限fence和对读口可见是相邻但不同点：fence以后移marker才开放，移marker后的目录sync是耐久完成点；撤销不会回滚已接受内容，ACK仍等待实际IO及耐久完成。索引是可重建查找辅助，读口仍核实际文件和marker，索引残留不能开放不存在或未接受目标；本包不提供数据库/文件跨介质原子事务。
- Windows的Node目录句柄不支持这里所需fsync，projectDirectoryDurability明确返回unsupported；不捕获Linux目录sync错误冒称成功，不把Windows顺序seam当Linux真实目录syscall。portable server/test/asset-project-publication-durability.test.mjs仅标准库，可在固定源码Linux临时目录用node --test运行；没有本叶节点操作或安装依赖。正常重启/故障seam不等价于物理掉电，后者仍未做。
- durability-target-1为27总/19过/8失败，2290.6459ms（TMP/promptcut-asset-durability-target-1.log）：Windows只读文件句柄sync返回EPERM，尚未走到目录同步；改为本次拥有temp/backup的r+文件句柄。target-2为27/27、988.2186ms。两轮命令误写不存在的asset-project-isolation.test.mjs，未包含真实stores测试；最终target-3明确列全6份真实test：34总/33过/0失败/1跳过，1080.0894ms。跳过仅Windows未请求symlink权限，Linux同文件会真实执行；原日志全部保留，没有降低原断言。
- recoverProjectPublications遇任何symlink即拒，不跟随；坏JSON/路径或backup尚未存在时同样failclosed并保留marker。恢复中已经还原backup、但marker未清即崩溃再次遇缺backup也会failclosed，需可信运维消歧；这是安全停用限制而非“任意崩溃自动恢复完整”。真实缺backup测试确认目标仍不可读，B项目不被触及。成功恢复先目录sync再清marker，杜绝先开放尚未耐久回退的目标。
- asset-service文首旧“票据可读任何项目”注释限定为旧LAN/v1历史机制；账号v2由doc权威及物理项目库取代，不更改未授权的旧LAN产品语义。类型durability-type-1使用npx --no-install tsc -b --force零错；后续固定本块再跑一次必要完整npm及实际HTTP probe，不盲重跑cf。
