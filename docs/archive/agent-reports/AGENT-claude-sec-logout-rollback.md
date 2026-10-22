# 对抗性安全专审：改密退出撤回（claude/logout-rollback）

分支 `claude/sec-logout-rollback`，从被审分支 `claude/logout-rollback`（PromptCut d91055ae，VisuHive f8cac7c）切出。
被审对象：`git diff main...claude/logout-rollback`（22 文件）、VisuHive `69872ef`（账号后端）与 `f8cac7c`（网页）。

这是对抗性审查：目标是找出实现错在哪。实现者报告 `AGENT-claude-logout-rollback.md` 只当被审材料。

几个词（第一次出现）：**区间** = 改完密码到选退出之间；**补偿操作** = 撤回作为一次新提交落地，写入身份 `{accountId, rollbackEventId}`，不带登录号；**撤回证明** = 文档服务的证明钥签的「这一步是事件 X 的撤回」，账号服务据此定序；**页面提交** = 普通成员页面发的 `project.op`。证据测试在本 worktree `server/test/sec-logout-rollback.test.mjs`（SEC-01~05 全红，提交 b14d66ac）。跑法：两个账号环境变量指向我的 VisuHive worktree `C:\Users\admin\Documents\VisuHive\.worktrees\sec-logout-rollback`。

## 结论清单

| 编号 | 问题 | 结论 | 分级 |
|---|---|---|---|
| SEC-01 | 补偿操作号 `logout-rollback:<事件号>:<第几次>` 与页面提交同一命名空间，页面可先占号 | **成立** | **阻断合入** |
| SEC-02 | plain 数组（`string[]`、原本为空的数组）被误当 id 数组的「顺序项」，区间里的改动既不撤也不记保留，静默漏过 | **成立** | **阻断合入** |
| SEC-03 | `planRollback` 随区间修改项数约平方增长，同步跑、占住整个 Node 事件循环，无条数/字节/耗时上限 | **成立** | 合入后要跟（重点，接近阻断） |
| SEC-04 | 续办器一遍里逐个 `await` 撤回，一个卡住/很慢挡住同实例其它账号退出登记结束见证 | **成立** | 合入后要跟 |
| SEC-05 | 账本里每个项目的撤回/保留路径只限条数（50）不限长度，一次退出可把账本撑大约 1 MB | **成立** | 合入后要跟 |
| Q1 | 伪造/重放撤回证明，以别人名义或在无权项目写入 | **不成立** | — |
| Q2 | 撤回范围被撑大，把别人的工作抹掉 | **不成立**（但 SEC-02 是「撤不够」的反向漏洞） | — |
| Q4 | 页面连接自称 `kind:'logout-rollback'` 走 `executeSystem` 绕校验 | **不成立** | — |
| Q5 | `logoutRollbackEvent` / modifications 内部口 / 气泡泄露 | **不成立**（但 eventId 经 `project.ops` 广播给同项目成员，见 SEC-01） | 只是记录 |
| Q6 | 同一撤回落地两次 / 落到错项目 | **不成立** | — |

**阻断合入两条：SEC-01、SEC-02。** 两处的最小改法都很小，见各条。

---

## SEC-01（阻断）：补偿操作号与页面提交共用命名空间，可被页面占号后永久卡死撤回

**成立。** 补偿操作号 `logout-rollback:<事件号>:<第几次>`（`server/docservice/modules/project.mjs:297`）。页面提交的 `opId` 由客户端自选、只校验 1~128 字符、不限字符集（`server/docservice/modules/project.mjs:138-141` 的 `checkToken`），没有任何地方保留 `logout-rollback:` 前缀。两条路算的 `requestId` 同一公式（`operation-wiring.mjs:137` 与 `:176`：`project-op:digest({docAuthorityId, projectId, opId})`），落进操作历史同一主键 `(project_id, op_id)`（`operation-history.mjs:60`）。

于是：页面先用这个 opId 落了一笔普通提交后，撤回执行器走到这个项目时，`history.get(projectId, opId)` 命中那条页面记录，`executeSystem` 里 `prior.requestIdentity !== requestIdentity` 成立（页面的身份摘要 vs 系统的身份摘要不同，`operation-wiring.mjs:184`）→ 抛 `operation-id-mismatch`（409）。执行器 `run()` 的 catch（`logout-rollback.mjs:291-295`）只把 `operation-fenced`/`project-not-found`/404 当「项目没了，算办完」，其余一律 `pending = true; continue`——**而 `attempt` 只有在 `outcome.state === 'cancelled'` 时才加一（`logout-rollback.mjs:299`）**。`operation-id-mismatch` 不是 `cancelled`，所以第几次永远停在 1，每一轮重算都撞同一条记录，这次退出的这个项目**永远办不完**。续办器因此永不 `seal`（`logout-confirmer.mjs:116` `if (!outcome.done) continue;`），网页 45 秒后显示「退出没有确认完成」，区间里旧登录的修改也从不撤回。历史记录按主键永久存在，无代码改动或人工干预不会自愈。

**攻击路径（具体）：**
1. 攻击者是项目 P2 的当前可写成员，且与受害者同在项目 P1、P2。
2. 受害者的旧登录在 P1、P2 的区间里都改过内容；受害者改密码并选「退出其它设备」。
3. 撤回执行器按 `cursors` 顺序逐个项目办（`logout-rollback.mjs:282` 的 for，`await rollbackProject` 之间事件循环会让出）。P1 的补偿操作落地时，`project.mjs` 的 `rollback` committed 回调广播 `project.ops`，`actor` 带 `rollbackEventId`（`project.mjs:317`，RB-01 测试断言 `ops.actor.rollbackEventId === eventId`）——**攻击者的 P1 页面连接就此拿到受害者的事件号**。
4. 攻击者立刻向 P2 发 `project.op`，`opId = "logout-rollback:<事件号>:1"`，随便改一处；它作为普通页面提交落地。
5. 执行器办到 P2 时撞 `operation-id-mismatch`，P2 这步永远不 done → 整个事件的结束见证永不登记。

事件只覆盖单个项目时，攻击者在该项目撤回落地前无从得知事件号（事件号 `pw_`+24 hex，96 位，猜不到；网站 `/me` 只回自己发起的事件），所以实际利用需要「与受害者同在 ≥2 个项目」加一个时序竞争。但撇开利用难度，这仍是明确的健壮性缺陷：系统操作号的命名空间对完全由客户端自选的页面操作号不设防，一旦相撞就永久卡死且不自愈——正是任务书 Q6 点名要查的「`logout-rollback:<事件号>:<第几次>` 会不会和页面提交的操作号撞上」。

**证据：** `server/test/sec-logout-rollback.test.mjs` 的 SEC-01（真账号后端）。页面用该 opId 落地后，执行器跑 4 轮仍 `done=false`、诊断 `logout-rollback-operation-id-mismatch`、`/extra` 未撤回。

**最小改法（二选一，建议都做）：**
- 页面提交路保留系统命名空间：`project.mjs` 的 `submit`/`submitAccount` 里，`opId` 以 `logout-rollback:` 开头的一律 `forbidden` 拒掉（系统操作号不该由页面发）。这一条就堵死了整个问题。
- 兜底健壮性：`executeSystem` 命中非本系统来源的 `prior`（`requestIdentity` 不符）时，不要抛死，让执行器把它当「这个号被占」→ 换下一个 `attempt` 重算（等同 `cancelled` 的处理）。

---

## SEC-02（阻断）：plain 数组被误判为 id 数组的「顺序项」，区间里的改动被静默漏过

**成立。** `planRollback` 判断一个 `structure` 修改项是不是「带 id 数组的顺序项」用的是 `isIdList`（`logout-rollback.mjs:175-178`）：它只看 `before/after` 的值「是不是一个全由字符串组成的数组」。但 `operation-history.mjs` 的 `recordChanges`（`:34-43`）对**任何** plain 数组（不是 stable-id 数组）在该路径记一条 `kind:'structure'`、`before/after` 就是数组内容本身。于是：

- 卡片参数里的词表 `string[]`（如 `word-rotate` 的 `words`、字幕行等 `role:"list"` 参数）、`project.ts` 的 `thumbs?: string[]` 这类 plain 字符串数组，被 `isIdList` 判成 true，落进「顺序项」分支（`logout-rollback.mjs:136-138`）：只要公共元素的相对顺序没变（改的是某个元素的值、或增删了元素但剩下的没换位），`reordered(...)` 为 false → `continue`，**整条改动既不进 `reverted` 也不进 `kept`，静默丢弃**。
- 原本为空的 plain 数组 `[]` 被旧登录在区间里塞进内容（`[] → [{...}]`）：`isIdList([])` 为 true（空数组 `every` 真空成立），`reordered([], [{...}])` 公共集为空、false → 同样静默丢弃。

后果：旧登录（= 被改密踢出的那个会话）在区间里对这些字段做的改动，撤回**不会撤、也不记为保留**，悄悄留在项目里；网页那一行的「N 处已撤回」还会少算这些项。这违背实现者自己的安全论证 2「每个修改项要么撤回、要么记保留」，也直接违背「改密退出撤回会抹掉被踢会话在区间里的改动」这条承诺——对一整类用户内容失效，且无任何痕迹。

这是「撤不够」（under-reach），与 Q2 的「撤过头」相反，但同属撤回正确性被破坏，安全相关（攻击者的篡改在本该被撤的字段上存活）。

**证据：** `server/test/sec-logout-rollback.test.mjs` 的 SEC-02（纯函数，不需账号后端）：旧登录在区间里改 `words` 与清空数组各一处，`planRollback` 回 `reverted=[] kept=[]`——两处都没被算到。

**最小改法：** `planRollback` 里判「顺序项」不能只看「值是不是字符串数组」。改成看**真实数组是不是 stable-id 数组**：用 `json-ops` 的 `isIdArray` 对该路径在 `current.value`（或 op 的 `before`）上的实际数组判定；只有真的 id 数组才走顺序项分支，其余 plain 数组按普通值项撤（整数组 `set` 回 `first.c.before.value`）。`isIdList` 当前的字符串判据应当删掉。

---

## SEC-03（合入后要跟，重点）：planRollback 约平方增长、同步占住事件循环、无上限

**成立。** `planRollback`（`logout-rollback.mjs:120-173`）判「之后被别人改过上级/下级」的那段（`:150-151`）：

```
const clash = entries.some((e) => !e.cand && e.i > first.i && e.c.itemKey !== key && related(first.c.path, e.c.path) && ...)
```

`entries` 是**所有**被接受操作的全部修改项（O(总项数)），这个 `.some` 对**每一条要撤的链**都跑一遍（O(链数)）。区间里有 n 个相互独立的修改时，整体 O(n²)。实测（本 worktree，纯函数）：2000 项 772 ms、16000 项 27 979 ms——规模 8 倍、耗时 36 倍（线性应约 8 倍，平方约 64 倍），明确超线性。

它同步跑（`plan()` 在 `executeSystem` 的 `prepare` 回调里同步执行，`operation-wiring.mjs:187`），期间没有 `await`，**整个 Node 事件循环冻住**——不只是该项目的锁，是这台文档服务实例上所有项目、所有人。16000 项时冻约 28 秒。区间里的修改项数完全由旧登录在被踢前的编辑量决定（一个 Agent 任务轻易刷出上万次改动）。对撤回的候选操作数 / 修改项数 / 字节数 / 耗时，没有任何上限。

这正是任务书点名的「重点」，与你让我别重报、但要查是否重现的 `authority.mjs` `verify` 里 `refs` 无上限增长同属一类（任何登录刷接口拖垮整机）。这里是「一次恶意改密退出冻结整实例几十秒」，可重复性低于那条，故列**合入后要跟**，但接近阻断。

**证据：** SEC-03（见上，倍数 36.2）。

**最小改法：** 对一次撤回的候选操作数或修改项数设上限，超限按有界、可记录的「太大」处理（不能静默、不能挂死）；或给 `clash` 判定建路径索引把 O(n²) 降到近线性；或把撤回分块、让出事件循环。

---

## SEC-04（合入后要跟）：一个事件的撤回卡住/很慢，挡住同实例其它账号的退出

**成立。** `logout-confirmer.mjs` 的 `pass()`（`:106-119`）对每个 barrier 顺序 `await rollback.run(barrier, proof)`，一个不 done 才 `continue`。若某个事件的 `rollback.run` 长时间不返回（项目锁被一笔大操作占住、`planRollback` 跑 SEC-03 的 28 秒、或账号服务连不上导致 `rollbackProject` 反复 15 秒超时后退避重试），**排在它后面的其它账号的退出都登记不了结束见证**。`tick()` 单飞（`:159`），确认器整体被拖住。没有对单个事件的 `rollback.run` 设超时、也没有把各事件隔离。

与 SEC-03 叠加：一个受害者的大撤回会把同实例所有人的退出确认拖后几十秒。真正无限挂死需项目锁永不释放；更常见是「很慢/反复超时」造成的串行阻塞。故列合入后要跟。

**证据：** SEC-04（不需账号后端）：两个事件，`pw_stuck` 的 `rollback.run` 永不 resolve、`pw_other` 立即 done；结果 `pw_other` 也从未 `completeLogoutBarrier`（`sealed=[]`）。

**最小改法：** 各事件的撤回互不阻塞（一个卡住不挡别人 `seal`），或给单次 `rollback.run` 设超时并记录后继续下一个 barrier。

---

## SEC-05（合入后要跟）：账本里撤回/保留路径只限条数不限长度

**成立。** 执行器把每个项目的撤回/保留路径存进账本 `logoutRollbacksV1`，`revertedPaths`/`keptPaths` 只 `slice(0, ROLLBACK_PATHS_KEPT=50)`（`logout-rollback.mjs:27, 304-305`），**限条数、不限单条长度**。路径里的键来自项目内容，旧登录可设任意长的键（单笔页面提交可达 256 KiB）。账号账本是单行 JSON、每次事务整段重写、每次读整段解析（`server/account/ledger.mjs:51-85`，且 `:46` 的注释记着 684 KB 账本就把文档服务主线程占满）。一次退出、一个项目就能往账本塞约 1 MB 诊断数据，此后每次账本读写都背着它。

**证据：** SEC-05（不需账号后端）：50 个 2 万字符长键的区间改动，一次 run 后 `logoutRollbacksV1` 该事件约 1 001 046 字节。

**最小改法：** `revertedPaths`/`keptPaths` 限总字节数（不只条数），或截断每条路径。

---

## 判「不成立」的几条（逐条给出处）

**Q1 伪造/重放撤回证明 —— 不成立。** 撤回证明由文档服务证明钥签（`password-order.mjs:46` `signDocProof(..., docAttestationPrivateKey)`），攻击者（任意登录、旧票据持有者、前成员）没有这把钥。VisuHive `rollbackAuthorization`（`order-witnesses.mjs:69-74`）验签名 + `proof.witnessId===row.witnessId` + `proof.eventId===row.actorRef.rollbackEventId` + `checkBinding`（`:54-56`，比对 requestId/docAuthorityId/projectId/opId/payloadDigest/preparedDigest/actorRef 全量规范化）——证明死绑一个项目、一个 opId、一份内容摘要，换项目/换 opId 均 `digest-mismatch`。VisuHive `password-order.mjs seal`（`:33-39`）对撤回写入身份不带证明一律 401、带了再查库核对「事件在、同账号、choice=exit、clock.kind≠logout」，否则 `rollback-not-allowed`；`actor()`（`order-witnesses.mjs:34-36`）只许 `{accountId, rollbackEventId}` 两个键。文档服务侧只有 `executeSystem`→`checkGate`（`operation-wiring.mjs:97`）在 `principal.kind==='logout-rollback'` 且 `checkRollback` 通过（账本里是真 password-exit 事件、accountId 一致）时才请求签证明；`rollbackOperationProof`（`password-order.mjs:41-48`）再强制 actor 无任何登录字段。重放同一份证明：见证按 witnessId 只能 sealed 一次，幂等。各处 accountId 均从账本事件派生、非攻击者输入。未发现伪造或跨项目/跨操作重放路径。RB-03 也从行为层证明了「非改密退出事件、写入身份对不上」被拒。

**Q2 撤回范围被撑大 —— 不成立。** `candidateOf`（`logout-rollback.mjs:62-74`）第一条就是 `logins.has(actor.loginId)`——候选必须是**这次作废的那些旧登录自己**的操作；别人的 loginId 不同，进不了候选（只作「别人」参与冲突判定）。`loginIds`/`changeSeq` 来自账本事件（`rollbackEventOf`→barrier，非攻击者可控），`endSeq` 来自 0.7.18 证据的 `projectCursors.lastAcceptedOrderSeq`（`logout-confirmer.mjs getDocBarrier` 由文档服务 `settleLogins` 算，非攻击者可控），执行器还过滤 `endSeq > changeSeq`（`:273`）。攻击者没有任何端点可触发别人的撤回。操作历史不裁剪已接受操作（`operation-history.mjs` `accepted()` 返回全量；`maxBytes` 满时 `prepareOperation` 抛 507 而非丢历史），`planRollback` 看得到完整历史，不会因裁剪误撤。唯一的反向问题是 SEC-02 的「撤不够」。（注：历史到容量上限时补偿操作自身 `prepare` 会抛 507 → 撤回办不成 → 退出挂起，归 SEC-04 可用性。）

**Q4 两条路串台 —— 不成立。** `executeSystem` 只被 `project.mjs` 绑定适配器 `rollback()` 经 `doc-assembly rollbackProject` 在进程内调用；页面消息走 `submit`/`submitAccount`→`coordinator.execute`，没有任何线路消息路由到 `executeSystem`。`checkGate` 认 `kind:'logout-rollback'` 的前提是 `active.get(requestId)` 被设成该 principal，而这只有 `executeSystem` 会做（`operation-wiring.mjs:190`），`active` 按 requestId 存取、调用后即删。`checkRollback`（`:86-91`）又独立回账本核对。页面注入不了这个 kind。撤回路与页面提交共用项目锁、有序提交、操作历史；它按设计不走成员/票据校验，改由「账本里是真 password-exit 事件、accountId 一致」授权（补偿操作以账号身份、不借登录写入，是预期设计）。

**Q5 泄露 —— 不成立（一处信息经广播到达同项目成员，记录）。** `authority.logoutRollbackEvent`（`authority.mjs:861`）只在进程内被 `operation-wiring checkRollback` 调用，未接任何对外路由（`account-projects.mjs` 的内部分发是白名单具体方法，无动态派发）。VisuHive `POST /internal/v2/events/:id/modifications`：`createInternalApp` 要求 mTLS 客户端证书命中已注册服务指纹**且** `serviceId==='doc'`（`internal.mjs:8-13, 28`），不是 IP/共享密钥，外部伪造不了；`reportModifications` 入口即 `serviceId!=='doc'→403`（`events.mjs` 对应段），409/404 的差别外部探测不到。气泡 `content-rolled-back` 在 `project.mjs` committed 回调里过滤 `role!=='page' || scope==='service' || typeof service==='string'`、且 `principal.projectId!==projectId` 跳过（`:315`），渲染节点/Agent 服务/托管方连接和别项目连接都收不到；`name` 是本项目成员名、发给本项目成员，合理。**唯一一处**：补偿操作的 `project.ops` 广播带 `actor.rollbackEventId`（`project.mjs:317`），把事件号送到同项目所有在线成员页面——事件号本身不算敏感，但它是 SEC-01 卡死攻击的凭据来源，也进了每个成员的本地历史。建议广播时从 actor 里去掉 `rollbackEventId`（或换成不可反推的标记），既收敛信息、又削弱 SEC-01。

**Q6 幂等反面 —— 不成立。** 补偿操作号按 `(projectId, opId)` 去重：重来命中 materialized→`duplicate`（不再应用、不补气泡，`project.mjs:314`），命中 cancelled→执行器换 attempt 重算（RB-02/02b 证明）；attempt 只在 cancelled 时加一，落不了两次。opId 不含 projectId，但 `history.get` 按项目、`requestId=digest({...,projectId,opId})` 含 projectId，同号在两项目是两条独立记录，不会落到错项目。补偿操作自身 actor 无 loginId，`candidateOf` 的 `logins.has(undefined)` 恒 false，所以补偿操作永不会成为后续撤回的候选（不存在「撤回的撤回」把别人改动带走）。

---

## 验证

- 反例测试 `server/test/sec-logout-rollback.test.mjs`：SEC-01（真账号后端）、SEC-02/03/04/05（纯逻辑/内存账本），改后在被审实现上**全红**，每条红的信息即对应结论。退出码 1、fail 5。
- 账号后端环境变量指向本审查自建的 VisuHive worktree `claude/sec-logout-rollback`（从被审分支 `claude/logout-rollback` 切，未改其代码）。
- 复跑被审者的 RB-01~03、LP-01~09：13/13 过——即被审实现对它**想到的**情况是对的；SEC-01~05 是它没想到的。
- 未改被审仓库任何源码；未推送、未合并、未连节点、未碰宿主机网络；端口段 5990~5999 未使用（本审查只跑进程内测试，未起 dev server）。

## 给用户的决定

- **SEC-01、SEC-02 建议阻断合入**，两处改法都很小（SEC-01：页面提交拒 `logout-rollback:` 前缀；SEC-02：`planRollback` 用 `isIdArray` 区分真 id 数组）。
- SEC-03/04/05 建议作为「合入后要跟」的跟进项（可用性，非提权）；SEC-03 接近阻断，请权衡。
- Q5 的 eventId 广播建议随 SEC-01 一并收敛。
