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
