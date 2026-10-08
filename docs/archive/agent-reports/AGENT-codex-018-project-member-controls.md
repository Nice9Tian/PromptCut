# 云端项目成员控制：开工与接口核对

本任务复用已完成队列阶段的物理工作区，分支 `codex/018-project-member-controls`，起点 `53b7246c265d56d49d7ec12a55096602f3fb0cc3`。主会话已收回此前产品与证据；本任务不把其 type/full/真实队列或原生 IPC 结果算作成员控制通过。

开工时 HEAD 与分支符合租约、tracked/untracked 均干净。初始授权仅新增本报告，所有产品源码只读；不开服务、浏览器、全量或节点，不操作 main/推送/删除数据。建议端口6560–6589尚未申请启动，6566属于 fetch 坏端口，绝不选用。实际端口预检与自有进程/收口布局将在真实夹具方案批准后另报。

目标为用户可见成员及踢人/禁入/退出真实控制路。先完整核已拍板账号任务、项目/协作语义、现 MembersPanel 与 doc authority/admin HTTP 接口，再交最小字段与文件租约。删除项目、50对话细则、0.7.20加入申请及其它未决语义不提前实现；不按旧用户名或deviceId自设账号角色权力。

已重新读 AGENTS 入口与 developer_guide/suggested_agent_behavior/constraints。当前首次只读确认：`MembersPanel.tsx` 存在；`server/account/authority.mjs.adminProject` 已有 set-list/kick/unban 等操作，kick 当前对账号全部设备禁入；`server/docservice/modules/account-projects.mjs` 暴露真实 admin POST。权限、字段与目前缺失接口仍需下一节逐条核查，不把源码已有 op 当新的产品授权。

状态：仅开工报告，未修改产品、未运行成员控制测试、未启动监听。待提交精确接口与独占文件请求后实施。

## 已定规则与本阶段边界

已读 `docs/plan/account-binding-task.md` 已拍板、三个版本与待决定，`account-binding-contract.md` 权威/跨服务操作与任务例外，`docs/semantics/workflow/project.md` 开始与多用户协作，`product/document-service.md` 角色与权限。账号 ID 是云端身份；本机 LAN 的用户名/密码/设备禁入不迁改。云端 creator 管进入设置/名单/踢人，Agent 不取得管理特权；kick 对账号全部设备生效，已读共有当前任务例外仍由既有 run authority 决定，不在 UI 复制 retained 判据。申请加入在0.7.20，不提前做。删除项目、50对话删除细则、提前让位和故障A/B不在本阶段。

“退出”先按最小已有用户操作提案：退出当前页面的项目＝撤此页绑定、停止重连、离开编辑器回开始页；账号仍登录、joined关系保留，可合法再入。退出登录＝已有网站/native logout，作用范围保留原实现。源码没有 leaveProject/自愿删除成员关系接口，语义也没有规定退出当前页自动退名单或禁止另一设备，因此不自创永久 leave/ban。如果本阶段要的是永久退出成员关系，必须由主会话明确范围后另补，不能混同回首页、退出账号、被踢或改密退出。

## 当前产品冲突与真实接缝

| 当前位置 | 真实行为 | 账号模式最小改法提案 |
|---|---|---|
| `syncManager.ts.enterAccountProject/onOpen` | shared.accountId 已有，但 members 始终先设空；仅 LAN 进入发 shared.watch | 单独账号 snapshot provider；不开放旧 shared.watch |
| `account-hosted.mjs.gate` | 所有 shared.* / auth.ticket 被明确拒绝 | 保留拒绝；走新窄只读账号 HTTP 路由 |
| `modules/shared.mjs.devicesOf` | userId/用户名+设备聚合、legacy hostedOf 读 LAN store | 不把此结果直接当账号 ACL。在线行用实际 doc session principal，项目关系/禁入用唯一账号 ledger |
| `MembersPanel.tsx.isMe/iAmCreator` | 以用户名+deviceId找本人，shared.creator或行creator算管理者 | 账号本人以 accountId+deviceId；当前账号所有设备均不出现踢自己的入口，creator由 fresh成员快照决定；后端仍逐请求重新核 |
| `CreatorFlow/VerifyDialog/ListDialog` | 要创建者密码、deriveKey、list-bans challenge、用户名密码名单 | 账号独立组件，不索要或保存项目/创建者密码，不走旧 adminOp；本阶段名单可展示，先不增加申请或按名字写名单 |
| `KickDialog` | 发 username/deviceId；自由进入成功提示“改项目密码才能彻底挡住” | 发严格 accountId；明示该账号全部设备禁入，取消旧云端错误文案；LAN保留原行为 |
| `BansDialog` | “已禁入的设备”，按username+deviceId撤销 | 账号禁入列表/解除禁入按 accountId；unban不自动恢复成员或旧票据，只有新join按当前入口规则重新核 |
| 顶栏回首页/Shell | pc-go-home只换页面，不能当所有owned连接已关闭的证据 | 账号入口增加显式离开本项目绑定与停止重连后回首页；测试核本页真实WS/SSE关闭，不声称全账号设备退出 |
| account admin HTTP | `/hosted/shared/account/admin` 已有set-entry/set-list/kick/unban/delete/set-hosted-service | 本阶段仅消费kick/unban（进入开关与名单另包可复用），delete不挂账号界面 |

真实 `server/account/authority.mjs.adminProject` 先 verify，creator必须role page且等于creatorAccountId，按 expectedAccessRevision拒409，requestId/digest持久幂等。kick删除 members[accountId]并写bans[accountId]，unban只删ban。set-list降权/移除和kick在同ledger事务挂既有runHooks，事务throw回滚，提交后原通知/实际doc fence仍原实现。返回 `{eventId,accessRevision,completed:false,state:'pending-services'}`，不是所有服务结束的证明。

`server/docservice/modules/account-projects.mjs.mountAccountProjects` 目前只有create/join/admin/session POST及status GET，没有 members/bans公开读口。`service.describe().conns` 内含真实normalized principal/transport/detached，不能整对象返public（其中有authorizationId及其它内部字段）。成员读口必须白名单投影，剔除脱开的session和不属于当前项目的连接，不能从页面正文带principal、用户名、creator或设备身份。`server/account/ledger.mjs.appendAccessEvent` 不创建项目admin完成barrier；`authority.revocationStatus` 当前只接改密barriers。因此本阶段不能编造一个admin完成状态或拿conn数量0当全服务receipt。

## 可立即实施的最小接口提案

以下均为〔裁〕三级接线提案，待主会话确认租约后写。选择窄 HTTP snapshot 的原因：账号模式当前禁止旧 shared.*，现有 bearer/native request 路径已验证；不新增第二套项目权威、不把legacy用户名名单拿来迁就界面。替代为放开shared.watch会继续输出LAN权限/名字，也无法正确取持久ban；因此不用。snapshot轮询只更新可见状态，不承担或放宽即时撤销。

### 只读成员/禁入快照

新增 POST `/hosted/shared/account/members`，JSON `{projectId}`，原bearer/credentials omit、不带Cookie；拒principal/role/creator/accountId等自报身份字段。每次真 `authority.authorizePrincipal(actor,{projectId,action:'read'})`，当前read成员可看在线行/合法成员；只有本次fresh creator能收到bans。身份服务不可达503；未登录401、被踢403 banned、名单外403 not-listed、项目错误404/400，故障不回空数组。页面连续revision不回退、错project/authority拒，不以旧snapshot授admin。

```ts
type AccountMembersSnapshot = {
  v: 2; authorityId: string; projectId: string; accessRevision: number;
  self: {accountId: string; creator: boolean; access: 'r'|'rw'};
  creatorAccountId: string; allowLinkJoin: boolean;
  members: Array<{accountId: string; accountName: string|null; access:'r'|'rw'; joinedAt:number|null}>;
  devices: Array<{accountId:string; accountName:string|null; deviceId:string; deviceName:string;
    creator:boolean; conns:Array<{role:'page'|'agent'|'render'; service?:string; conversation?:string|number}>}>;
  bans?: Array<{accountId:string; accountName:string|null; reason:'kick'}>; // only fresh creator
};
```

成员关系从同一ledger projects[projectId]取；devices只从该doc service真实连接取。名称来自已核principal.accountName或可信加入时名称快照，不靠页面输入/同名查角色。为离线名单和禁入名称可选最窄持久显示字段：create/join保存 `members[id].accountNameAtJoin`（只取verify actor），kick保留该名称到ban，缺旧字段显示公共accountId；此字段不参与permission、不改账号名、不迁历史、不创造找不到的用户名称。current live名字仍以实际认证principal为准。若不扩authority这三窄处，本阶段可先诚实显示离线公共ID，不影响按ID踢人/解禁。

创建者与名单显示按账号聚合；在线设备展开保持真实deviceId，不把display设备行等同device-only ban。人数/Agent数及服务行继续既定规则，不把未挂runner的queued消息算Agent连接；真实run行不能从页面捏造。如需计入retained的offline当前Agent，必须复用已持久真实grant/实际运行连接，缺值不声称在跑。本阶段无生产runner，用实际page连接正反验，保留此缺口而不造run。

最小服务装配：新 `server/account/project-members.mjs` 仅白名单快照；`account-hosted.mjs` 从私有ledger/authority和bind后的service接它；`mountAccountProjects` 加单route/callback；`server/hosted/combo.mjs` 仅public mount传可信回调一处。真实位置是docservice/account-hosted，仓库不存在account/hosted-runtime.mjs。不改变gate、内部mTLS、ready探针或legacy模块。

### 管理写操作

账号client `members(projectId)` 和 `memberAdmin(projectId,{op:'kick'|'unban',accountId,expectedAccessRevision,requestId})`，后者只消费既有admin路径。页内每次开确认流程取fresh snapshot并确认creator；请求仍由后端再核。同一已提交操作重试保留完整原body/requestId，失ACK不生成第二次写；409明确刷新并让用户重选，不默默覆盖。严格公共acc_24hex，禁止target=username/deviceId/creator自报或Agent扮creator。

返回仍是pending-services，UI说“账号已禁入，正在确认相关服务关闭”，不说所有任务已停/设备全部关闭；解除禁入表示不再ban，不承诺旧token/queued任务复活。真实doc WS关闭、B新session/join拒与asset读拒是各自可验事实，跨服务Agent SSE即时fence/多服务ACK仍是已报告依赖，不以此UI补口伪完成。不能为了让踢人成功把runHooks、retained或asset消费者换noop。

### 请求独占路径

| 所有者 | 精确路径/必要窄处 |
|---|---|
| 本Sol界面与接线 | `src/editor/sync/MembersPanel.tsx` 只账号分流；新增 `src/account/AccountMembersPanel.tsx` 与必要样式；`src/account/client.ts`/.test；`src/editor/sync/syncManager.ts` 账号snapshot/admin/离开binding；`src/editor/sync/sync.css` 仅共用账号弹层样式 |
| 本Sol后端快照 | 新 `server/account/project-members.mjs`；`server/docservice/account-hosted.mjs` 实际projection；`server/docservice/modules/account-projects.mjs` 新members route；`server/hosted/combo.mjs` publiccallback一行；`server/account/authority.mjs` **仅可选可信名称快照三处，不改ACL/ops/fence** |
| 本Sol桌面路径 | `desktop/src-tauri/src/account_vault.rs` 仅projectRoute精确members POST白名单；不动lib测试origin、DPAPI、bridge权限或token规则 |
| 专属验证 | 新`server/test/account-member-controls.test.mjs`、`account-member-projection.test.mjs`、`account-member-native-route.test.mjs`；`scripts/probes/project-member-controls-probe.mjs`；复用已验 `server/test/fixtures/cloud-queue-user-path.mjs`，只allow ports/Agent port配置支持本任务独占段，不改生产service/ready；本报告 |

当前只读，以上没有得到产品写租约、没有改文件。可以将同一归属解析窄模块交Luna（下节），本Sol不同时改它；后端/关键UI由Sol贯通，不让root承担常规界面实现。

## 实际验证路径与有界窗口

只读首次预检6560–6589无监听，未启动任何服务。建议默认十个业务端口：site6560/account-internal6561/doc6562/doc-internal6563/asset6564/asset-internal6565/Agent6567/edge6568/stages6570/6571；**6566不用**。用真实VH provider/order、doc同SQLite、独立asset子进程及pinned mTLS，compiled online真实Members UI。三个隔离Chrome context：A创建者、B账号设备1、B同账号设备2；可加C跨项目负向仅临时账号，凭据RAM、截图密码隐藏。

最短正向：A/B真实登录/创建/加入→成员按钮显示名字与account身份/设备→B无管理按钮→A点B踢出账号确认→B两页真实WS关闭/阻断→同账号两设备重新session/join403 banned→A禁入列表准确B→unban→B从真实项目链接重新join成功且list更新→B显式离开本页/回首页，真实本页WS/SSE关且账号/成员关系保留→合法再入。记录原项目ID、eventId、accessRevision（公共标识），不保存票据、Cookie或URLquery。多阶段每wait30s、真实HTTP5s、fixture启动20s；首败立刻owned teardown，不重复到绿。root实际窗口前固定source、完整命令及最大监听/子树明细另报，不自己运行。

后端独立真provider负向：非creator/创建者Agent拒admin、同名不同account不升权、自己creator不可kick、错project/旧revision/重复request篡改拒、同账号不同device同时失权、不同project unaffected、unban旧票据仍须当前权限、停机重启持久ban不丢；成员读口不泄露bans给普通成员或内部principal secrets、断账号服务明确503不假空。真实retained/private run与actualclose多服务receipt若没有运行链不能造fixture宣称通过，沿既有provider测试但单独写未整合。

纯验证先做：实际client响应/错误/凭据omit、投影输入边界和SCRIPT路由；再root审固定source安排真实browser与必要native构建。type/full仅root统一候选跑，既有全量不能借给未写模块。

## 两个可独立派Luna的窄块建议

1. **严格账号成员响应协议**：独占新 `src/account/memberProtocol.ts`/`memberProtocol.test.mjs`，实现上面snapshot白名单解析和admin pending结果校验，拒错project/重复account设备/非法revision/非creator bans/未知role；不改UI、client或服务器权限。先固定export `parseAccountMembers(raw,{projectId,accountId})` 与 `parseMemberAdminResult(raw)`，Sol随后消费。此是已定按账号/真实creator/不伪完成的三级解析，不选择角色策略。
2. **桌面members路由守门与实际SCRIPT目标**：独占account_vault.rs仅新增精确members路径＋新 `server/test/account-member-native-route.test.mjs`，复用实际SCRIPT提取执行；无token/body/未知路径拒，原admin/create/session保留。不扩port/origin/bridge capability；纯HTTP可受控不监听但需明确不能算IPC，root另编实际壳。Sol不同时编辑vault。若根更希望Luna只测，可让其写这个专属目标，本Sol后改唯一route行。

两包都不阻后台快照及关键可见界面先实现；申请加入、删除项目、50对话细则不派成“补齐”伪范围。当前仅方案与报告，所有拟export均未实现，仍待租约。

## 2026-10-09 已批准实施范围（41e5 提案后）

主会话采用本提案，授权真实账号成员快照、按 accountId 踢出/解禁与“回项目首页”。后者只断当前页连接，保留账号登录和 joined 关系；删除、申请加入、名单管理、改密仍另拆。本节记录新的实施租约，不覆盖前面的只读提案历史。

本 Sol 独占前端 client/private parser、syncManager、MembersPanel 账号分流、新 AccountMembersPanel 和必要 sync.css；后端新 project-members、account-hosted projection、modules/account-projects members、combo 回调与 authority 三处可信显示名快照。authority 的 ACL/fence/事务语义不改。桌面 vault 和 account-member-native-route 目标改由 Luna 独占，本 Sol 不写。

bootApiGuard 的真实文件为 src/online/apiGuard.ts；新 members 是精确 POST /hosted/shared/account/members，不是 /api/account 的新别名。守门与棘轮只登记这一实际路径，不开放 shared.*、未知 account 路径或舞台能力。专属测试/探针/fixture 在上表基础上获租，旧 fixture 只允许注入 AgentPort（默认仍6526）与 ports，不改变 ready/ACL/关闭行为。

快照必须 fresh 授权后同步投影当前 ledger/真实连接，只白名单返回可信名字；admin 仍 pending200，不宣称多服务关闭完成。409 丢弃选择、刷新后让用户重选；丢 ACK 保留同一原 body/requestId 重试。轮询仅展示，不当撤销依据。未启动服务、未运行本阶段目标/type/full。先完成固定源码再申请主会话真实窗口，6566 明确禁用。

## 已实施源码与验证（等待真实窗口）

已固定核心 `63e43f07`：新增 project-members 白名单快照；runtime 的 `membersSnapshot(actor,{projectId})` 在 public mount 消费；账号 client 私有严格解析与 exact bearer/omit 请求；MembersButton 按账号分流，旧 LAN 密码界面完整保留。新 AccountMembersPanel 按 accountId 显示成员及设备，fresh creator 才有踢出/已禁入账号/解禁。authority 只有 create/join 的 actor.accountName 快照与 kick 从旧可信成员记录保存禁入显示名三处变化，未改原 ACL、runHooks、事件顺序或 pending-services 结果。

客户端 admin 未知响应保留同一原 body/requestId/revision；409 丢掉操作选择、刷新后重选。快照失败显示不可用，不用空名单冒充成功。回项目首页仅作用于当前绑定，先等本页未确认编辑收口（5 秒，失败仍留页显示错误），然后 stop/detach/清账号项目素材连接，保留 account client 登录和 joined；不写 unjoin、logout 或本地转换。旧主体登录撤销/ban 的连接关闭仍由现有权威 fence 执行，轮询不是撤销机制。

`d5421baa` 为纯夹具修正；`e98949b9` 为专属真实浏览器探针及准确按钮文案；`e13968b7` 再加重入必须等真实编辑器成员控件出现，防止残留复制链接气泡被错当进入。当前真实 Agent 未挂，验证预期 Agent=0；queued 不计数。被撤登录/踢出后共有已读 retained Agent 的实际运行投影仍欠真实 run-provider presence 接缝，按主会话确认另段接入，不借此改变 retained 权限或复制 run ACL。

| 尝试 | 精确范围与结果 | 原始证据 |
|---|---|---|
| pure 首轮，固定核心63e43f07 | npm wrapper 六文件，34 tests /33 pass/1文件级fail/0skip，391.4937ms；新 XHR 断言本体通过，但 Node 无 ProgressEvent 导致结束后异步异常，非产品授权失败；未原码盲重跑 | `%TEMP%/pc-member-controls-63e43f07-pure-first.log` |
| 修后守门d5421baa | 仅受影响 c10a-api-guard，3/3、143.8379ms，npm exit0；补测试浏览器事件类并等 timer 收口，不改产品权限 | `%TEMP%/pc-member-controls-d5421baa-guard-fixed.log` |
| client 显式409加强e98949b9 | client target 12/12、110.1616ms、npm exit0。该文件字节对应e989；执行时另有不参与target的 probe 两行真实编辑器等待改动，随后已e139提交，不称整树固定验证 | `%TEMP%/pc-member-controls-e98949b9-client-conflict.log` |
| 语法/diff | project-members/account-hosted/account-projects/newprobe Node --check exit0；git diff --check零错误 | 实时工具流 |

上述 pure 使用仓库 npm wrapper/global setup，没有业务监听；仅既有38坏端口 guard 例外。子进程隐藏 preload 为父仓库绝对 file URL，环境使用唯一 PSModulePath 与仅进程 cuda_Vit/PYTHONDONTWRITEBYTECODE/models。无 full/type/build/Chrome/native/节点/公网，纯受控 account transport 与连接 inventory + 真 SQLite/authority 不等于真多浏览器。部署目录规则已核：HOSTED_DEPLOY_DIRS 包含 server/account 与 server/docservice，新增模块自然在现有目录闭包，不需要改 files.mjs。

### 提交后申请的唯一真实窗口

新 `scripts/probes/project-member-controls-probe.mjs` 只用实际 compiled online、真实 VH account/order + doc 同 SQLite + 独立 asset 子进程 + 实际 Agent account HTTP（executor未挂），不模拟 ready、ACL、队列、密码表单或用户卡。复用原 queue fixture 仅加 agentPort 配置（缺省6526不变）。三 Chrome 隔离 contexts 为 A、B设备1、B设备2，名字/密码只RAM，截图有密码input时不取；CDP只记录文档 WS created/closed 数，响应日志仅pathname/method/status及严格公共项目/账号ID，不输出认证协议、Cookie、票据、query或帧正文。

请求业务监听十个：site6560/account-internal6561/doc6562/doc-internal6563/asset6564/asset-internal6565/Agent6567/edge6568/stages6570/6571；6566禁用。一个独立asset Node child与一个自有Chrome进程树，TMP output/profile/SQLite/PKI/日志；teardown contexts/browser、舞台owned sockets/server、fixture全部服务与asset child实际close。root启动前再核这些口，occupied不能杀。各UIwait30秒、fixture20秒、HTTP5秒；root wrapper建议总上限240秒，首败teardown不重跑。

root命令（先在共同固定候选编译 dist-online）：`node scripts/probes/project-member-controls-probe.mjs --dist <固定候选dist-online> --site-root C:/Users/admin/Documents/VisuHive/site --out <TMP独立目录>`；同前process-only silent preload、真实 PROMPTCUT_ACCOUNT_PROVIDER_ROOT=VH主根与 PROMPTCUT_PASSWORD_ORDER_MODULE=该根account/password-order.mjs、明确现装Chrome。验证真实A创建/B两设备join、名字/account/device、B无admin、踢出后两实际WS close与两当前join403、creator bans、unban后真join、回首页登录/joined保留并从同一真实列表行重入（不重建）。admin200只证明持久禁入/解禁，不证明多服务complete。Luna桌面092f路径由root另组合/实际编译IPC，本叶不借其结果冒称完成。

## 根候选ab0首次真实浏览器与本次probe-only修正

根独立候选 `ab0d1028` 已报告 type0/6.984s、目标27/27/3180.2215ms、full5410/5406pass/0fail/4skip/72.106s、online build0/1.890s；新Rust实际编译19.219s及真实members IPC35/35/12.136s。这些是根提供的候选证据，不冒用为本叶所有浏览器路径已完成。

首次浏览器固定ab0源：34.741s（wrapper wall35.266s），仅 real-project-created 1/1 前置通过、completed=false，phase join-two-devices、TimeoutError。实际create201与两个join200，members/session反复200；没有kick/admin。own服务全部关闭、asset27836实际close。证据保留 `%TEMP%/pc-members-browser-ab0d1028-once/result.json` 与failure-0/1/2图、`pc-members-root-ab0d1028-browser-browser.log`。

只读检查发现 phase 混合join(b)、join(b2)、B开浮层/两成员行、A开浮层/B两设备；下一个 ordinary-member-has-no-admin-controls 没有通过，故A设备断言未到。三图已进编辑器、无consent dialog/无成员pop，按钮显示2真人（实际devices投影非零，不能据此声称B两设备完整）。分享常驻气泡覆成员按钮中心区域，toast z960>pop900，原probe中心page.click可能命中气泡；这是遮挡候选，原raw没有elementFromPoint，须修后真实点击才确认因果。“创建者关闭Agent”不是成员入口失败的依据，未改开关或要求启Agent。

主会话授权此次仅probe+报告。openMembers通过真实分享气泡×逐个关闭，并等真实消失；只在确需打开pop时用只读elementFromPoint确认按钮中心命中后正常page.click，已开的pop不重复点击。未JS改DOM、未强改disabled/forceclick、未假响应。子phase精确拆出B两次join、每页button-visible/dismiss-share-toast/button-center-hit/click-and-popup、B两账号行及A两B设备；memberDiagnostics只记页索引、固定阶段、布尔UI存在/中心命中及成员/设备/page设备/账号/单账号最大page设备数量。响应原principal、名字、token、完整URL/query和输入不记录。

本次只Node --check新probe exit0与git diff --check零错；没有真实browser/native、监听、type/full/cargo重跑。产品和tests相对eeab完全无改，根可沿同ab0 compiled产品有因单次复验；初次红不覆盖、遮挡仍候选。

## 根ff874第二次真实浏览器与精确旧WS捕获修正

根固定 `ff874e5b20660947929a3416235418fbb8406b72` 沿同ab0 compiled产品运行：35.198s，5 checks /4 pass/1 fail，completed=false，phase kick，失败为 affected-page-actual-websocket-closed。原 `%TEMP%/pc-members-browser-ff874e5b-once/result.json`、failure图与根原日志保留。真实×关闭前buttonCenter=false/shareToasts=1，关闭后toast=0/center=true且弹层两账号行；A的可信快照3个page设备、同账号最多2个，已证明原遮挡候选。本轮admin200，B/B2的session403及被踢提示出现，但原探针统计docSockets.closed=0，不能把这些HTTP/UI现象替代实际WS关闭。两设备禁入、unban、回首页后半路径尚未验证。

只读实际接缝明确：`src/editor/sync/syncManager.ts:1106` 的账号入口构造 `${origin}/hosted/`；`src/online/invite.ts:79` 的 hostedWsUrlOf 只改protocol并保留pathname；`server/test/fixtures/cloud-queue-user-path.mjs:92` 的真实WSS辅助也连 `/hosted/`，edge upgrade将其strip到doc `/`。原probe只筛 `/hosted/ws`，确定漏掉当前账号真实连接，而非证明产品连接没关。只读检索时两次使用不存在的route通配路径产生rg路径错误，随后直接读invite和实际syncManager核定，没有把错误检索当证据。

主会话授权此次仅probe+本报告，执行器计划暂缓。新过滤限定精确 `wss://127.0.0.1:6568` 与 `/hosted/`；CDP created和握手响应101分别记录，requestID与关联记录只RAM。踢人前两页各必须created>=1且至少一条已101、仍live的旧连接；快照这些旧记录之后才执行原真实kick。踢人后等待每条快照旧记录各收到对应webSocketClosed，新连接关闭不能满足旧连接屏障，DOM弹框也不能替代。新增两条 established-old-websocket-before-kick 检查；保留原 affected-page-actual-websocket-closed 名称但加强为全部旧连接实际关闭。输出仅页索引、固定阶段、安全origin/path/status101或null、created/handshaken/旧live/旧closed计数及布尔，不持久requestID、query、子协议、票据或帧。

本次使用本机绝对Node路径及父仓库绝对file URL静默预载，仅 `--check scripts/probes/project-member-controls-probe.mjs` 与 git diff --check；未启动监听、Chrome、fixture、native，也未重跑type/full/cargo。产品/tests相对 `eeab9e3b193f3e548be333ebad38abf447819954` 字节不变。该修正尚未真实运行，不能记为“连接关闭通过”；由根沿同ab0产品dist有因单次验证。


## 根实际第三轮与小阶段收回

最终探针集成666431be沿同一ab0编译产品运行：14/14、completed=true、5922ms（npm墙6.437秒）、exit0、自动重跑0。两页各created1/handshake101/旧live1，踢人后各旧closed1/allOldClosed=true；真实两个join403、解禁admin200、重新join200、回首页实际关闭页面连接、保留账号与原joined列表、重开同项目、不重复create均通过。截图由根实际看过，禁入提示仍是“账号已禁入，正在确认相关服务关闭”，不宣称全服务ACK完成。根再核全部自用6560–6579、原生6340/6348/6378/6381–6388/6526无监听。asset21188及Chrome/contexts/stages/fixture均正常收口。

ab0→最终src/server/desktop/package.json/package-lock.json逐字一致（git diff exit0），只有probe和报告增量，沿用已实际验证的type0、目标27/27、full5410/5406pass/0fail/4skip/0cancel/72106.8852ms、online build0、真实Rust原生35/35/12136ms；没有无因重跑全量/cargo。原生scope是临时空页面真实Rust IPC，完整React桌面成员界面尚未独立运行，不把原生桥接等同完整桌面UI。原始三次result及根基线/原生摘要归档到 docs/archive/three-versions-member-controls-evidence/；详细过程在 docs/archive/three-versions-main-stages-2026-10-09.md。

本阶段交付成员/设备白名单展示、按账号踢人与解禁、回项目首页，以及原生精确members路由。真正Agent任务关闭、改密退出、共有/私有完整跨服务即时撤销仍在独立分支，执行器和生产Agent尚未部署。本报告收回归档；工作区准备安全复用。
