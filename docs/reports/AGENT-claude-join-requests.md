# AGENT 报告：claude/join-requests（进入方式的勾选、账号名单、申请加入）

- 分支：`claude/join-requests`（从 main `e27d36b4` 切）；worktree：`.worktrees/join-requests`
- 端口：编辑器 5940（舞台 5941、5942），本机隔离的托管组合（夹具）5943～5949（入口 5949）。夹具里云端 Agent 的入口探针用不到，给 0 由系统挑临时端口（见「端口」一节）。
- 任务：补云端项目的「任何知道链接的人都可加入」勾选和账号名单界面，做通「申请加入」。语义：`docs/semantics/workflow/project.md` 第 26、27、44 行一带（2026-10-22 用户定），照做，语义文档一字未动。
- 代号：JR-1～JR-14 是服务端测试 `server/test/account-join-requests.test.mjs` 的用例号；JRC-1～JRC-6 是页面侧测试 `src/account/joinRequest.test.mjs` 的用例号；RJR-1～RJR-4 是重开文件那条提示的测试 `src/account/reopenJoinRequest.test.mjs` 的用例号。〔裁〕表示执行中我定、主会话认可、待用户合入前审的三级做法。

## 一、做了什么（逐文件）

### 服务端

| 文件 | 改了什么 |
|---|---|
| `server/account/authority.mjs` | 新增 `joinRequest`（申请人：`send` 发申请、`status` 查自己那一条）与 `decideJoinRequest`（创建者：`approve-join` 通过、`reject-join` 拒绝）；上限 `JOIN_REQUEST_LIMITS`；纯函数 `joinRequestView`。`joinProject` 进来后清掉他的申请记录；`set-list` 把名单里有了的账号的申请清掉；`kick` 清掉被踢者的申请；`delete` 不在墓碑里留申请；账号删除事件（`account-deleted`）到达时清掉他在各项目的申请。`set-entry` 本身没改（0.7.18 已有，只认创建者，按访问版本号防并发）。 |
| `server/account/project-members.mjs` | 创建者的成员投影里多一项 `requests`（挂着的申请，按申请时间排；每条只有账号号、申请时的账号名、申请号、申请时间）。普通成员的投影里没有这一项。 |
| `server/docservice/modules/account-projects.mjs`（不在清单、不在禁区） | 申请走现有路由：`/join` 带 `joinRequest` 字段时转给 `authority.joinRequest`（不进项目、不发票据）；`/admin` 的 `approve-join` / `reject-join` 转给 `authority.decideJoinRequest`。理由见「二、设计决定」。 |
| `server/test/account-join-requests.test.mjs`（新） | JR-1～JR-14，真的 SQLite 账本、真的权威与成员投影、真的公开路由；账号服务换成可控替身。 |

### 页面

| 文件 | 改了什么 |
|---|---|
| `src/account/client.ts` | `joinRequestStatus` / `sendJoinRequest`（都走 `/hosted/shared/account/join`）；`memberAdmin` 支持 `set-entry`、`approve-join`、`reject-join`（请求体按白名单拼、本地先核形状、回包逐项核）；成员投影里 `requests` 的严格核对（只收创建者的、一个账号一条、不能同时是成员或已禁入）；新 code 的人话（见「五」）；常量 `JOIN_REQUEST_POLL_MS`。 |
| `src/account/joinRequestText.ts`（新） | 各处共用的话（语义原文几句逐字）、`joinRequestNotice`（被挡住那一块说什么、给不给按钮）、`reopenNotice`（重开文件那条提示）、`retryAtText` / `requestedAtText`、`autoJoinKey`（何时自动再走一次加入）。 |
| `src/account/AccountEntryOption.tsx`（新） | 「任何知道链接的人都可加入」勾选。改之前重读成员投影拿当前访问版本号；中间有人进来回 409 时再读一次再改（只重来一次）。勾着／取消各一句说明。 |
| `src/editor/sync/CollabSection.tsx`（主会话授权） | 两处：① 在「作废并重新生成项目链接」「项目二级密码」两个按钮（以及按了「项目二级密码」展开的那一段）下面挂 `AccountEntryOption`，只在创建者那一段、只对账号项目，外加一行 import；② 「放在」那一行账号云端项目只写「云端」（〔裁〕，见「九」第 2 条）。 |
| `src/account/useAccountProjects.ts` | `join` 被名单挡住时回 `not-listed` 并读自己那一条申请；`sendRequest`（没收到回包再点沿用原请求号）；等创建者时每 10 秒问一次（页面看不见时不问，回前台马上问）；`clearRequest`。 |
| `src/account/AccountProjects.tsx` | 桌面与在线的开始页：被挡住时那一块（「你不在这个项目的成员名单中。」+「发送申请」→「已发送，等创建者通过」/「创建者没有通过你的申请」，次数用完说几点之后能再申请）；被通过或项目改回知道链接就能进时自动再走一次加入（设了二级密码的接着问密码）。 |
| `src/account/AccountMembersPanel.tsx` | 成员按钮上的数字角标（创建者有挂着的申请时）；成员浮层顶上「申请加入（N）」列表，每条「通过」「拒绝」；没收到回包再点沿用原请求号。 |
| `src/account/account.css`（新） | 上面两处的样式，只用已有的颜色变量，几何照已有同类控件。 |
| `src/editor/sync/recoveryAssociation.ts`（主会话授权） | 重开文件「这个账号不是这个云端项目的成员」：被账号名单挡住（`not-listed`）且项目只放账号名单时，提示里另有「发送申请」按钮；在等的、次数用完的不给按钮、把现状接在后面说；被踢的、问不到的照旧只有那一句。`syncManager.ts` 没动（它传的 `pushToast` 本来就收按钮）。 |
| `src/mobile/MobileStart.tsx`、`src/mobile/useMembers.ts`、`src/mobile/sheets.tsx`、`src/mobile/MobileEditor.tsx`、`src/mobile/mobile.css`（主会话授权） | 手机：加入面板里被挡住那一块与「发送申请」、自动再走一次加入；成员面板顶上「申请加入（N）」与「通过」「拒绝」；成员按钮上的数字角标（外观照页签上已有的 `.badge-n`）。 |
| `src/account/joinRequest.test.mjs`（新）、`src/account/reopenJoinRequest.test.mjs`（新） | JRC-1～6、RJR-1～4。 |
| `scripts/probes/account-join-request-probe.mjs`（新，不在清单） | 验收要的界面证据：本机隔离的托管组合 + 桌面（开发服务器 + 外壳账号桥替身）+ 在线（在线构建由夹具入口同源下发）+ 手机（同一份在线构建、`?layout=mobile`），三处走一遍并截图。 |

## 二、设计决定：申请只走现有的五条路由，不给外壳加路由

桌面外壳的账号桥（`desktop/src-tauri/src/account_vault.rs` 第 89 行）把能转发的项目路由写死成五条：`/hosted/shared/account/create`、`/join`、`/session`、`/admin`、`/members`，其余 `throw 'bad-path'`。加一条新路由就要发新外壳，而外壳换不了补丁，用户得装完整安装包——这与刚合进 main 的「0.2.8 以前的外壳打补丁后账号入口只给一句说明」反方向。所以：

- 发申请、查自己那一条：`POST /hosted/shared/account/join`，请求体带 `joinRequest: 'send' | 'status'`；
- 通过、拒绝：`POST /hosted/shared/account/admin`，`op: 'approve-join' | 'reject-join'`；
- 创建者看申请列表：`POST /hosted/shared/account/members` 的投影里（只给创建者）；
- 勾选：`POST /hosted/shared/account/admin` 的 `set-entry`（0.7.18 已有）。

外壳失败时只带回 `status` 和 `code`（`@{ok=$false;status=...;code=...}`），成功时整段回包透传。所以失败一律用闭集的短 `code`，人话由页面按对照表给（见「五」）；要额外信息（项目是不是只放名单、还能不能再发、几点之后能再发）都放在成功回包里（查状态那一次）。

**0.2.8 外壳不用换就能用申请加入**：v0.7.18 发版提交 `d767698e`（shell 0.2.8）里的 `account_vault.rs` 与 HEAD 逐字相同（`git diff d767698e HEAD -- desktop/src-tauri/src/account_vault.rs` 为空；主会话另比了 `41b6d335`，也相同），放行清单正是上面五条。0.2.8 之前的外壳没有账号桥，本来就只给一句说明。

**守门测试**：JRC-2 直接读 `account_vault.rs`，抽出放行清单，断言它仍是这五条，并让外壳替身对清单外的路由报错——页面侧申请加入用到的每条路由都在清单里；以后谁给申请加入加新路由，这条当场变红。端到端探针里的外壳替身同样只放行这五条（另有一项核对「账号桥只用到外壳放行的路由」）。

## 三、名单快照规则（第 4 问）

- **名单就是项目成员。** 取消勾选（`set-entry` 落账）那一刻 `members` 里的人都在名单里；之后的新人只能申请。没有「输入账号名加人」（页面没有这一项；服务端 `set-list` 仍在，见「七」）。
- **以账本里落账的先后为准，不以请求先到为准。** 账本写入是串行的（SQLite `BEGIN IMMEDIATE`，事务函数同步执行），加入（`joinProject`）与取消勾选（`set-entry`）是两笔各自的写入，必有先后：加入那一笔先落账的，算在名单里；取消勾选先落账的，之后到的加入在它自己的事务里读到「只放名单」，回 403 `not-listed`，只能发申请。加入在核对登录（异步）时卡住、期间取消勾选落账，也按落账时判（JR-2 (a)）。
- **创建者拿旧版本号取消勾选回 409。** `set-entry` 带页面读到的访问版本号；那之后有人凭链接进来了（版本号 +1），取消勾选被拒（`access-revision-mismatch`），什么都不改；页面重读后再取消，名单里含刚进来的人（JR-2 (b)(c)）。页面这一侧自动重读重来一次（`AccountEntryOption`），名单照落账那一刻算，取消后勾选下面写明「现在的 N 位成员」。

测试：JR-1（取消那一刻的成员照旧能进、之后的新人 not-listed、只有创建者能改）、JR-2（三种交错）。

## 四、安全论证（六问）

### 1. 申请本身能不能被滥用

| 问 | 答 | 测试 |
|---|---|---|
| 没登录的人能发吗 | 不能。公开路由先要 `Bearer` 登录令牌（没有回 401 `login-required`，带网站 cookie 的回 400 `bearer-required`）；权威层再经账号服务核登录（不认的令牌 401、作废的 401 `credential-revoked`）。查状态同样要登录。 | JR-4 |
| 被踢的账号能绕过「先解除禁入」吗 | 不能。发申请、查状态在同一笔事务里先查禁入名单，回 403 `banned`；被踢时他挂着的申请一并清掉；创建者解除禁入后他也不是直接回名单，要重新申请。页面上被踢的人只看到「你已被禁止加入这个项目。」，没有「发送申请」。 | JR-5、JR-7、JR-14 |
| 同一个账号能刷多少条 | 同一个项目同一时刻只有一条（已在等时再点回原来那一条，不另起、不算次数）；同一个账号对同一个项目滚动 24 小时里最多起 3 条新申请，跨项目滚动 24 小时里最多 20 条；一个项目同时最多挂 50 条。都是时间窗或会被创建者处理掉，不会把人永久卡死（〔裁〕，见「六」）。 | JR-3、JR-9、JR-11 |
| 别的项目的人能往这个项目发申请吗 | 能发（知道项目号、登录了、没被这个项目踢，就是本功能本身），但只落在这个项目里：申请号按项目各是各的，别的项目的创建者通过不了（403 `creator-required`），把那边的申请号拿到这边用回 404 `no-join-request`，那边的通过进不了这边（403 `not-listed`）；项目里的票据（连接票据、素材票据）当登录令牌用回 401。 | JR-6 |
| 能伪造成别人发的吗 | 不能。申请人的账号号和名字只取自账号服务核过的登录；公开路由不收请求体里的 `accountId`、`role`、`principal`、`loginId`、`credentialId`、`authorizationId`、`creator`（400 `invalid-authority-claim`）；权威层即使收到请求体里的 `accountId`/`accountName` 也不用。云端 Agent 等非页面身份发不了（403 `invalid-role`）。 | JR-6、JR-7 |

### 2. 「通过」只有创建者能点（服务端核）

`decideJoinRequest` 在账本事务里第一件事核「这是创建者本人的页面」（`actor.role === 'page' && actor.accountId === creatorAccountId`，与踢人同一个判据），之后才看重放、权限与申请。普通成员、被踢的人、申请人自己、另一个申请人、项目外的人，「通过」「拒绝」都回 403 `creator-required`，账本一个字节不变；创建者本人的云端 Agent 身份也回 403（创建者特权 Agent 一律做不了）；公开路由不能自报角色。界面上只有创建者看得到申请列表（投影里只给创建者），但这不是防线，防线在服务端。测试：JR-7（逐一身份）、JR-6（别的项目的创建者）、JR-3（普通成员的投影里没有申请）。

### 3. 通过之后的进入仍走全部关卡

通过只是把账号放进成员名单（可写，`joinedAt` 记通过时刻，成员记录留申请号）；进项目仍走原来的 `/join`、`/session`：核申请人的登录（作废的 401）、禁入（通过后被踢的 403 `banned`）、二级密码（设了的要输一次，没输 403 `secondary-password-required`、输错 403 `bad-secondary-password`，输过一次后不再问）、项目还在（删了 404）。唯一的放宽：被通过的人不核「作废并重新生成」后的链接口令——他是创建者点名放进来的，与「已经进来的成员不受影响」同理；没被通过的人拿着最新口令在只放名单时也进不来。

**通过那一刻现核，不凭页面那一眼。** 通过这一笔在同一笔账本事务里现核四样：项目还在、创建者本人登录有效（`verify` 走账号服务）、申请还挂着、申请人不在禁入名单里。申请人在创建者看到申请之后被踢：踢人时申请已清掉，停在旧页面上点「通过」回 404 `no-join-request`；账本里万一人被禁入而申请还在，回 409 `join-request-banned`；账号删了，账号事件到达时申请清掉，再点回 404。测试：JR-8、JR-14。

### 4. 名单快照

见「三」。

### 5. 申请记录存在哪、谁能读

- 存在云端文档服务的账本里（与成员、禁入同一本，`projects[项目号].joinRequests[账号号]`）。每条只有：申请号（`jr_` + 24 位十六进制随机数）、申请时的账号名、申请时间、状态（挂着／被拒）、拒绝时间、时间窗里的几次发起时刻。**不存**邮箱、登录号、凭证号、设备号、令牌（账号服务回的登录里有邮箱，JR-12 专门放了一个，账本和所有回包里都找不到）。
- 申请人只读得到自己那一条的状态（`state`、`entry`、`canApply`，次数用完时另带 `retryAt`），读不到别人的申请、成员名单、申请号。
- 创建者在成员投影里读到挂着的申请：每条只有账号号、申请时的账号名、申请号、申请时间。普通成员读不到。
- 通过后申请记录删掉（成员记录上留申请号作幂等凭据）；被拒的留着给申请人看（每项目最多 200 条，满了丢最旧的）；被踢、账号删除、删项目都清掉；访问事件里不写申请（各服务都读得到访问事件）。
- 测试：JR-3、JR-12。

### 6. 通过、拒绝是不是幂等

- 同一个请求号重放：原样回，不再改账（JR-10）；同一个请求号换了内容：409 `request-mismatch`。
- 换了请求号再做同样的决定（另一台设备也点了、网络重试换了号）：照样成功，不再改账、访问版本号不变（JR-10）。
- 相反的决定（通过后再拒、拒后再通过）：409 `join-request-decided`（JR-10）。
- 对面已经处理过、申请不在了（被踢、账号删、拿错项目的号）：404 `no-join-request`（JR-6、JR-14）。
- 页面：「通过」「拒绝」没收到回包（网络断）时再点沿用原请求号；收到明确结论就丢掉（JRC-3 核重发的请求体一字不差）。
- 发申请：回包丢了用同一个请求号重试，不算又发了一次；这期间被拒了，重试回「被拒」（JR-10）。

## 五、code 与三端显示的话

失败时外壳只带回 `status` 和 `code`；`code` 是下表的闭集，人话由 `src/account/client.ts` 的 `accountErrorText` 给，三端用同一张表（JRC-5 核每个 code 都有人话、不落到「请求失败（code）」兜底；JRC-2 核外壳替身只回 `status`、`code` 时人话照样出来）。表里「界面上」一栏写的是三端一样的显示位置：桌面与在线是开始页的错误条（`sp-error`）或成员浮层的错误行，手机是加入面板里的 `.err` 或成员面板的提示气泡。

| code | HTTP | 什么时候 | 界面上显示的话 |
|---|---|---|---|
| `not-listed` | 403 | 被账号名单挡住（`/join`、`/session`） | 开始页、手机加入面板：**不弹错误条**，换成申请那一块「你不在这个项目的成员名单中。」+「发送申请」；其余地方（如成员浮层里自己被移出）照旧「你不在这个项目的成员名单中。」 |
| `banned` | 403 | 被踢的人加入、发申请、查状态 | 「你已被禁止加入这个项目。」（没有「发送申请」） |
| `entry-open` | 409 | 发申请时项目已改回知道链接就能进 | 页面不显示，读状态后自动再走一次加入；兜底「这个项目现在知道链接就能加入，请直接加入。」 |
| `join-request-limit` | 429 | 同一项目滚动 24 小时里第 4 次 | 「这个项目你最近申请得太多了，请过一段时间再申请。」（申请那一块另按 `retryAt` 写「10月23日 09:05 之后可以再申请。」） |
| `join-request-full` | 429 | 项目挂着 50 条 | 「这个项目等待处理的申请太多了，请稍后再申请。」 |
| `join-request-account-limit` | 429 | 账号滚动 24 小时里第 21 条 | 「你最近发出的申请太多了，请过一段时间再申请。」 |
| `no-join-request` | 404 | 通过／拒绝的那条已不在 | 「这条申请已经不在了，请刷新。」 |
| `join-request-decided` | 409 | 通过后再拒、拒后再通过 | 「这条申请已经处理过了，请刷新。」 |
| `join-request-banned` | 409 | 通过时申请人在禁入名单里 | 「这个账号已被禁入，要先在「已禁入的账号」里解除。」 |
| `already-member` | 409 | 申请人已是成员 | 「这个账号已经是项目成员。」 |
| `creator-required` | 403 | 非创建者改勾选、通过、拒绝 | 「只有项目创建者可以管理成员。」 |
| `access-revision-mismatch` | 409 | 改勾选时名单变了（页面自动重来一次后仍变） | 「成员状态已变化，请刷新并重新选择操作。」 |
| `invalid-entry` | 400 | 勾选值不对 | 「进入方式的设置没有保存成功，请刷新后重试。」 |
| `invalid-join-request` | 400 | 申请请求形状不对 | 「申请信息不完整，请刷新后重试。」 |
| `invalid-member` | 400 | 成员操作形状不对 | 「成员信息不完整，请刷新后重试。」 |
| `request-mismatch` | 409 | 同一请求号换了内容 | 「这次操作和之前的记录对不上，请刷新后重试。」 |
| `no-project` | 404 | 项目已删 | 「这个云端项目已不存在。」 |
| `relocating` | 409 | 项目在搬 | 「这个项目正在搬迁，请稍后再试。」 |
| `login-required` | 401 | 没登录 | 「请先登录账号。」 |
| `credential-revoked` | 401 | 登录作废 | 「登录已失效，请重新登录。」 |
| `bad-request-id`、`invalid-authority-claim` | 400 | 页面正常用不会碰到 | 「请求不完整，请刷新后重试。」 |
| `invalid-project` | 400 | 项目号形状不对 | 「请输入有效的云端项目链接。」 |
| `invalid-role` | 403 | 非页面身份 | 「没有访问这个项目的权限。」 |
| `invalid-device` | 400 | 设备号形状不对（页面正常用不会碰到，设备号恒为 ASCII） | 「这台设备的身份信息不对，请重新打开软件后再试。」 |

`no-project`、`relocating`、`invalid-project`、`invalid-role`、`invalid-device`、`bad-request-id`、`invalid-authority-claim`、`request-mismatch`、`invalid-member` 这几条原来没有对照，落到「请求失败（code）」兜底；这次一并补了人话，影响到所有用 `accountErrorText` 的地方（只是把兜底换成人话）。

## 六、三级数字

| 数 | 值 | 放在哪 | 说明 |
|---|---|---|---|
| 一个项目同时挂着的申请上限 | 50 | `JOIN_REQUEST_LIMITS.projectPending` | 满了回 429 `join-request-full`；创建者处理掉一条就又能收 |
| 同一账号对同一项目的发起次数 | 滚动 24 小时 3 次 | `accountProjectSends`、`windowMs` | 〔裁〕主会话 2026-10-22：按时间窗，不是终身额度（「不提供输入账号名加人」，终身额度会让误拒几次的人永远进不来）。数「起了一条新申请」：已在等时再点、同一请求号重试都不算；创建者处理掉不退还 |
| 同一账号跨项目的发起次数 | 滚动 24 小时 20 次 | `accountSends`、`windowMs` | 〔裁〕原先定的是「同时挂着 20 条」，没人理的项目会把申请人卡死，一并改成时间窗 |
| 每项目留的被拒记录 | 200 条，满了丢最旧的 | `rejectedKept` | 被拒记录只是给人看的，不是凭据；被丢的人看到「没申请过」、可以再发 |
| 申请人等创建者时问的间隔 | 10 秒（页面看不见时不问，回前台马上问） | `src/account/client.ts` 的 `JOIN_REQUEST_POLL_MS` | 被通过后最多约 10 秒自动进 |
| 创建者那边角标的刷新 | 沿用成员列表的 3 秒（展开）/ 15 秒（收着） | `MEMBERS_POLL_OPEN_MS` / `MEMBERS_POLL_CLOSED_MS`（已有） | 有新申请后最多约 15 秒出角标 |
| 重开文件那条带「发送申请」的提示 | 不自己消失（用户关） | `recoveryAssociation.ts` | 与别的带按钮的提示一样；不带按钮的照旧 10 秒 |
| 申请号 | `jr_` + 24 位十六进制（96 位随机） | `authority.mjs` | |

## 七、语义里说不通或缺的地方（交给主会话）

1. **被拒后能不能再申请**：语义只说被拒显示「创建者没有通过你的申请」。我做成能再申请，按「三级数字」的时间窗限次（主会话已认可）；次数用完时界面说几点之后能再申请。
2. **「有新申请时」的数字角标数什么**：我数的是挂着的申请条数（处理掉就少），不是「没看过的」条数。
3. **普通成员看不看得到那个勾选**：语义说「只有创建者能改」，勾选在两个只给创建者的按钮下面，所以我只给创建者显示；普通成员看不到（若要像「云端 Agent」那样让成员看得到、不能改，需要另挂一处）。
4. **作废并重新生成项目链接之后，旧链接能不能发申请**：能。重开文件那一条（第 44 行）要求在提示里给「发送申请」，而文件里只有项目号、没有链接口令；作废链接管的是「凭链接直接进」。被通过的人进来时也不核链接口令。
5. **服务端的 `set-list`（按账号号整份设名单）还在**：只有创建者能调，页面没有入口，所以「不提供输入账号名加人」在界面上成立；要在接口层也成立，需要删掉这个操作（删接口按规则要用户定）。
6. **被通过的人马上出现在「我加入的」里**：通过时记 `joinedAt`，网站「我加入的」与开始页列表立刻看得到；进项目时仍过二级密码等全部关卡。
7. **重开文件 + 二级密码**：被通过的人重开另存的文件时，若项目设了二级密码，`/session` 回 403 `secondary-password-required`，`recoveryAssociation.ts` 原有的分支把所有 403 都说成「这个账号不是这个云端项目的成员」（老问题，改密码后的老成员同样会碰到）。主会话只授权我在那条提示里加按钮，这个没改，建议另开一项：重开时遇到 `secondary-password-required` 要问密码。
8. **界面上新加的、语义里没有原文的几句**：「创建者已通过你的申请。」「知道项目链接的人登录网站账号后就能加入。」「只允许账号名单（现在的 N 位成员）。新人要发申请，由你在顶栏「成员」里通过。」「申请加入（N）」「…之后可以再申请。」「…申请」（时间）、重开文件发出后「已发送，等创建者通过。通过以后重新打开这个文件，就能连回云端项目。」、创建者点了之后的气泡「已通过 X 的申请。」「已拒绝 X 的申请。」，以及「五」里新补的人话。请审文字。
9. **挂着的申请不过期**：创建者一直不处理，申请人一直看到「已发送，等创建者通过」；因为跨项目的数也是时间窗，他不会因此被卡住、仍能申请别的项目。

## 八、端口

主会话给的段是 5940～5949。编辑器 5940 占 5940～5942（舞台 +1、+2），夹具七个固定端口 5943～5949（入口 5949），都在段内。夹具还有一个云端 Agent 的入口端口，探针用不到它，段里也放不下第 11 个，所以给 0、由系统挑一个空闲的临时端口（Windows 的临时端口在 49152 以上，不会落在任何人分到的段里）。没碰 5190～5192、5203、5210～5212、5870～5939。

## 九、〔裁〕清单（三级，待用户合入前审）

| # | 改了什么 | 修改前 | 修改后 | 理由 |
|---|---|---|---|---|
| 1 | 申请次数的上限按时间窗数 | 同一账号对同一项目一共 3 次（终身）；同一账号跨项目同时挂着 20 条 | 同一账号对同一项目滚动 24 小时 3 次；同一账号跨项目滚动 24 小时 20 次 | 主会话 2026-10-22：「不提供输入账号名加人」，终身额度会让被误拒几次的人永远进不来，创建者也无法补救；「同时挂着 20 条」在没人理的项目里同样会把申请人卡死 |
| 2 | 项目设置「多用户协作」里「放在」那一行：账号云端项目只写「云端」（`src/editor/sync/CollabSection.tsx`，主会话授权的第二处） | 「云端 · 自由进入」（账号项目恒为这句） | 「云端」 | 主会话 2026-10-22：这不是新增功能，是现有文案在新功能下暴露的错。「自由进入／限定进入」本是本地项目的说法（本地自报身份和进入方式不变），云端项目的进入方式只有「知道链接且登录了就能进」和「只放账号名单」两种。`syncManager` 进账号项目时把 `mode` 写死成 `'free'`，那一行就永远写「自由进入」，取消勾选后与紧下面没勾的「任何知道链接的人都可加入」直接矛盾。显示错的东西比最小改动更要紧；只写「云端」、不把进入方式也写进那一行，进入方式只由勾选说明，免得两处日后又不一致。本地项目那一行照旧。端到端探针核了取消勾选、再勾回去两种状态（`desktop-2-entry-list.png`、`desktop-2b-entry-rechecked.png`） |

## 十、验证

全在本 worktree 上跑；跑 `npm test` 前按任务书设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`（本机值，没写进任何文件）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次：@@TSC@@） |
| 新的服务端测试 | `node --test server/test/account-join-requests.test.mjs` | `tests 14 / pass 14 / fail 0` |
| 新的页面侧测试 | `node --test src/account/joinRequest.test.mjs src/account/reopenJoinRequest.test.mjs` | JRC `tests 6 / pass 6`；RJR `tests 4 / pass 4` |
| 相关旧测试（改动后先跑的一遍） | 服务端 `account-member-*`、`account-hosted-option`、`account-projects-*`、`account-create-policy`、`accept-018-auth-*`、`accept-018-conv-*`、`account-move`；页面 `src/account/*.test.mjs`、`src/editor/sync/accountMove.test.mjs`、`src/mobile/*.test.mjs` | 服务端 `tests 93 / pass 93 / fail 0`；页面 `tests 136 / pass 136 / fail 0` |
| 全量测试 | `npm test` | @@NPM@@ |
| 构建 | `npm run build` | @@BUILD@@ |
| 在线构建（探针用） | `npx vite build --mode online` | 退出码 0 |
| 端到端（桌面、在线、手机） | `node scripts/probes/account-join-request-probe.mjs --out out/join-requests/final2` | @@PROBE@@ |

端到端探针用本机隔离的托管组合（`server/test/fixtures/cloud-queue-user-path.mjs`：真的账号后端、文档服务、独立的素材服务进程、TLS 入口），没碰节点。三处：

- **桌面**：本工作区起的开发服务器（桌面那一份）；页面里的外壳账号桥由探针照外壳接口代答，同样只放行那五条路由、失败时同样只带回 `status` 与 `code`。不是真的外壳进程（见「十二」）。
- **在线**：`dist-online/` 由夹具的入口在 `/editor/` 下发，与 `/api/account`、`/hosted` 同源（与生产的摆法一样），页面凭网站登录（cookie）走，没有替身。
- **手机**：同一份在线构建，`?layout=mobile`、390×844 视口、触屏、手机 UA。
- 在线页面进了云端项目会弹「使用云端 Agent 前请先了解」，与本任务无关：探针截图前点的是**「拒绝」**（不同意、不发任何对话）。截图里看不到这个弹窗，不代表那几个项目同意过这份告知。
- 网站每个 IP 一小时只许注册 5 个账号（`RATES.registerPerIp`），夹具已注册 2 个，探针只再注册 3 个，三处轮着用（在线那一遍的申请人是桌面那一遍的丙、丁，申请的是另一个项目；手机那一遍是 K 和乙）。

### 设备名带中文（主会话追问）

探针早先几遍里「乙凭链接进项目」回 400 `invalid-device`：被拒的是**设备号**（`deviceId`，内部标识），不是设备名。那是探针自己拼的设备号 `probe-乙` 带了中文。文档服务 `/join`、`/session` 只核设备号（`server/docservice/modules/account-projects.mjs` 第 58 行，`/^[A-Za-z0-9_.:-]{1,128}$/`）；产品里的设备号由 `server/auth/device.mjs` 生成（`pc-` + 22 位 base64url），恒为 ASCII，所以设备号限 ASCII 合理，改探针是对的，不是绕过。

设备名（`deviceName`，给人看的）不经 `/join`、`/session`，只在编辑器登录时交给账号服务（VisuHive `account/credentials.mjs` 第 100 行只限长度不超过 128，不限字符；本仓库 `server/auth/protocol.mjs` 的 `isDeviceName` 也收中文）。实测：探针把桌面编辑器的设备名设成中文 `申请加入探针的电脑`、设备号保持 ASCII，创建者、两个申请人、被踢的人都用它登录：@@DEVNAME@@。云端项目里的用户名是账号名，不取设备名；「创建者用户名取设备名」是本地项目勾上「多用户协作」时的缺省，本地项目这次没动、没测。另给 `invalid-device` 补了人话（页面正常用不会碰到）。

### 看过的截图（`out/join-requests/final2/`，逐张看过；`final/` 是设备名改中文之前那一遍，内容相同）

| 截图 | 内容 |
|---|---|
| `desktop-1-entry-checked.png` | 桌面创建者的项目设置：「任何知道链接的人都可加入」在「作废并重新生成项目链接」「项目二级密码」下面，缺省勾着，下面一句「知道项目链接的人登录网站账号后就能加入。」；「放在」只写「云端」 |
| `desktop-2-entry-list.png` | 取消勾选后：「只允许账号名单（现在的 3 位成员）。新人要发申请，由你在顶栏「成员」里通过。」；「放在」仍是「云端」 |
| `desktop-2b-entry-rechecked.png` | 再勾回去：勾着，「放在」仍是「云端」，两边不打架 |
| `desktop-3-blocked.png` | 申请人凭链接加入被挡住：「你不在这个项目的成员名单中。」+「发送申请」，不另弹错误条 |
| `desktop-4-sent.png` | 点了以后：「已发送，等创建者通过」 |
| `desktop-5-badge.png` | 创建者顶栏「成员」按钮上的数字角标 2 |
| `desktop-6-requests.png` | 成员浮层顶上「申请加入（2）」，每条账号名、账号号、申请时间、「通过」「拒绝」 |
| `desktop-7-approved-creator.png` | 通过丙之后：申请剩 1 条、角标 1，丙出现在成员里，气泡「已通过 … 的申请。」 |
| `desktop-8-approved-password.png` | 丙那边自动再走一次加入：「创建者已通过你的申请。」；项目设了二级密码，出现密码框和「该项目设置了项目二级密码，请输入二级密码。」 |
| `desktop-9-approved-entered.png` | 丙输了二级密码，进了项目（成员 2 人） |
| `desktop-10-rejected.png` | 丁被拒：「创建者没有通过你的申请」+「发送申请」 |
| `desktop-11-banned.png` | 被踢的 K 再加入：「你已被禁止加入这个项目。」，没有「发送申请」 |
| `online-1-entry-checked.png`、`online-2-entry-list.png` | 在线：同样的勾选与取消（现在的 1 位成员），「放在」只写「云端」 |
| `online-3-blocked.png`、`online-4-sent.png` | 在线申请人：被挡住 +「发送申请」→「已发送，等创建者通过」 |
| `online-5-badge.png`、`online-6-requests.png` | 在线创建者：角标 2、浮层里的申请列表 |
| `online-7-after-decisions.png` | 通过一个、拒绝一个之后：申请列表空了 |
| `online-8-approved-entered.png` | 被通过的人自己进来了（没设二级密码，不用输） |
| `online-9-rejected.png` | 被拒的人：「创建者没有通过你的申请」+「发送申请」 |
| `mobile-1-blocked.png`、`mobile-2-sent.png` | 手机「加入别人的项目」面板：被挡住那句 +「发送申请」→「已发送，等创建者通过」 |
| `mobile-3-badge.png` | 手机创建者：预览右上角成员按钮上的数字角标 2（照页签角标的样子） |
| `mobile-4-requests.png` | 手机成员面板：「申请加入（2）」，每条「通过」「拒绝」，下面「项目成员」 |
| `mobile-5-after-decisions.png` | 处理完以后面板里只剩成员 |
| `mobile-6-approved-entered.png` | 被通过的人在手机上自己进来了（2 人） |
| `mobile-7-rejected.png` | 被拒的人：「创建者没有通过你的申请」+「发送申请」 |

证据：`out/join-requests/final2/evidence.json`（每项核对、截图清单、外壳替身实际用到的路由 `bridgeRoutes`、勾选与两个按钮的先后 `order`、设备名登录结果 `loginDeviceNames`），过程日志 `out/join-requests/final2.err`。`out/` 不入库。

探针跑过的几遍（都在 `out/join-requests/` 下）：`run1`、`run2` 桌面那一遍没进项目——夹具自带的项目内容只有 `{ tracks: [] }`，编辑器一打开就报 `Cannot read properties of undefined (reading 'toFixed')`、整页空白（`run2/debug-fail-0.png`），改成在开始页新建云端项目；`run3`、`run4` 只剩「乙先凭链接进来」一项不过（探针拼的设备号带中文，见上）；`final`、`final2` 全过。

## 十一、不在原清单里改过的文件

| 文件 | 为什么 |
|---|---|
| `server/docservice/modules/account-projects.mjs` | 申请要走现有的 `/join`、`/admin`（见「二」），路由分发在这里。主会话已认可 |
| `src/editor/sync/CollabSection.tsx` | 主会话授权两处：挂勾选（语义要它在那两个按钮下面）；「放在」那一行（〔裁〕2） |
| `src/editor/sync/recoveryAssociation.ts` | 主会话授权：重开文件那条提示补「发送申请」 |
| `src/mobile/MobileStart.tsx`、`useMembers.ts`、`sheets.tsx`、`MobileEditor.tsx`、`mobile.css` | 主会话授权：手机也做 |
| `scripts/probes/account-join-request-probe.mjs` | 验收要的界面证据（三处走一遍并截图） |

没动：`server/account/agent-read-control.mjs`、`server/agent-service/**`、`server/agent/**`、`src/online/**`、低内存档与三道闸门相关的文件、`src/editor/sync/syncManager.ts`、`docs/semantics/**`、`docs/plan/**`。

## 十二、没做成的、没测到的

- **真的桌面外壳没跑。** 桌面那一遍用外壳账号桥的替身（同样的五条白名单、同样的失败形状）；`account_vault.rs` 本身由 JRC-2 读源码守门。「0.2.8 外壳能用」来自源码比对（「二」），没有装真外壳实测。
- **重开文件那条提示的「发送申请」没进端到端探针**，只有 RJR-1～4 单测（按钮的请求号重用、在等与次数用完时不给按钮、被踢与问不到时照旧）。
- **真实网络验证没跑**：没往节点部署，按 `verification.md` 不是合入前提。
- **两轮审查**（Argon 交叉审核、Opus 对抗性安全专审）由主会话安排，不在本分支里做。

## 十三、发现的问题（不在本任务范围，没改）

1. `server/account/authority.mjs` 的 `verify`：每次凭登录令牌的调用（页面的 `/session`、`/members`、`/join` 都是）都往 `refs` 里加一项、从不清理，而且每次都把整张表扫一遍。文档服务长跑时内存与 CPU 会慢慢涨。这次申请人等创建者时每 10 秒问一次，会让它涨得快一点（与成员列表每 3～15 秒一次同一量级）。建议另开一项按到期或数量清理。
2. 夹具 `cloud-queue-user-path.mjs` 自带的项目内容是 `{ tracks: [] }`，编辑器打开会崩（见「十」）。拿它做界面验收的探针要自己新建项目。
3. 刚凭链接进来的那一次 `/join`，紧接着发会话偶尔回 503 `asset-unavailable`（发会话要等素材服务追上全局访问事件，刚落账的加入本身就是一条新事件）。页面用户一般重试就过去；脚本要同请求号重试。
4. 重开另存的文件时，项目设了二级密码而这个账号还没输过，`/session` 回 403 `secondary-password-required`，`recoveryAssociation.ts` 原有分支把所有 403 都说成「这个账号不是这个云端项目的成员」（改过二级密码后的老成员同样碰到）。见「七」第 7 条。

## 十四、结论

- 语义第 26、27、44 行的各条都做了，桌面、在线、手机三处走通；安全六问每问有服务端测试；名单快照规则写清并有交错测试；申请全走外壳已放行的五条路由，0.2.8 外壳不用换。
- 合入前要做的：主会话安排的两轮审查；用户审「七」里的语义缺口与新增文字、「九」里的两条〔裁〕、「六」里的三级数字。
- 分支 `claude/join-requests` 上的提交见 `git log e27d36b4..claude/join-requests`；没有推送、没有合并。
