# AGENT 报告：claude/logout-rollback（0.7.20 退出后的逐项撤回 + 撤销冲突接进冲突合并窗口）

分支：PromptCut `claude/logout-rollback`（从 main `31de9fae` 切，worktree `.worktrees/logout-rollback`）；
VisuHive `claude/logout-rollback`（从 main `58146dd` 切，worktree `VisuHive/.worktrees/logout-rollback`，`.worktrees/` 在 VisuHive 的 `.git/info/exclude` 里）。
端口段 5980～5989（探针用了 5980～5988）。没推送、没合并、没连节点、没碰 5190～5192 / 5203 / 5210～5212 / 5870～5879。语义文档与 `docs/plan/**` 一字未改。

语义出处：`product/document-service.md`「冲突」「保存与延迟退出的修改处理」（第 92、93 行）、`workflow/editing.md`「撤销、重做」。

几个词：

- **区间**：改完密码到选「退出」之间。账号服务给改密事件一个顺序号 `changeSeq`，给每一次被接受的操作一个顺序号 `orderSeq`，两者是同一条序列（VisuHive `account/store.mjs` 的 `nextOrderSeq`）。
- **位置**：0.7.18 退出确认里记下的「旧登录在各项目里最后一条被接受的操作的顺序号」。核实过：在文档服务账本 `docLogoutBarriersV1[事件号].proof.projectCursors`，形状 `[{ projectId, projectRev, lastAcceptedOrderSeq }]`（`server/account/logout-confirmer.mjs` 的 `getDocBarrier`，来自 `server/hosted/doc-assembly.mjs` 的 `settleLogins`）。这一版拿它当区间的终点。
- **修改项**：文档服务的操作历史（`server/docservice/modules/operation-history.mjs` 的 `recordChanges`）给每次提交记了它改到的每一个叶子属性（带 id 的数组按元素记增删，另记一条「顺序」项），带改前改后的值和版本。撤回按这个逐项判。
- **补偿操作**：撤回作为一次新的、可审计的提交落地，走和页面提交同一条有序提交与同一份操作历史；写入身份是 `{ accountId, rollbackEventId }`，不借任何登录。

## 一、做了什么

### PromptCut（逐文件）

| 文件 | 改了什么 |
|---|---|
| `server/account/logout-rollback.mjs`（新） | 撤回的全部逻辑。`rollbackEventOf`（只认「改密后选了退出」：账本里同一事件号先有 `password-changed` 后有 `credentials-revoked`，旧登录都在作废名单里）；`retainedRunsOf`（这次退出保留下来的共有已读任务）；`candidateOf`（区间里旧登录的、不属于保留任务的操作）；`planRollback`（逐项算撤回，纯函数）；`rollbackThrough`（在项目锁里按同一份操作历史算并交给项目模块落地）；`createLogoutRollback`（续办器用的执行器：账本 `logoutRollbacksV1[事件号]` 记每个项目做到哪、第几次、撤了几处留了几处、气泡发没发；全部办完再把结果报给账号服务）。 |
| `server/account/password-order.mjs` | `operationBinding` 认 `rollbackEventId`；新 `rollbackOperationProof`（文档服务证明钥签「这一步是事件 X 的撤回」）；定序时有 `rollbackGrant` 就带上 `rollbackProof`。原有写入身份的绑定不变（字段为空时不进绑定）。 |
| `server/account/authority.mjs` | 加只读的 `logoutRollbackEvent(事件号)`（有序提交每一步回账本核对用）。 |
| `server/account/client.mjs` | 加 `logoutModifications`：`POST /internal/v2/events/<事件号>/modifications`。 |
| `server/account/logout-confirmer.mjs` | 四样确认齐了以后、登记结束见证之前，先让撤回执行器办完并报给账号服务；没办完不登记（下一轮接着办）。文档证据里 `modifications` 的说法改成 `{ state: 'rollback', version: '0.7.20' }`（没配撤回时仍是 0.7.18 的 retained）。 |
| `server/docservice/operation-wiring.mjs` | 加 `executeSystem`：文档服务自己发起的补偿操作，走同一把项目锁、同一条有序提交；每一步 `checkRollback` 回账本核对事件和写入身份；同一个操作号重来认出已落地（duplicate）或已作废（cancelled）。加 `rollback` 转给绑定的项目模块。`checkGate` 认 `kind: 'logout-rollback'`。 |
| `server/docservice/modules/project.mjs` | 绑定适配器加 `rollback`：在锁里调 `plan(当前内容)`，有要撤的就照页面提交同一形状造投影、落地；落地后广播 `project.ops`，并给这个项目此刻在线的成员页面（`role: 'page'`、非服务连接）各发 `shared.notice { event: 'content-rolled-back', projectId, name }`。重启后认出的同一次不再发。 |
| `src/store/docsync.ts` | 每一步记「落地后的本地副本」（`Step.after`，存引用不复制）；本页面收到的别人提交也记落地后的那份；撤销被挡住时 `UndoResult.conflict = { landed, reverted }`；加 `commitAside`（不进撤销栈的提交）。 |
| `src/editor/sync/undoConflict.ts`（新） | 撤销冲突按修改项细分：云端仍是落地后的值的直接撤；已经是撤回后的值的不管；别人改过的进待合并表（来源 `undo`）。 |
| `src/editor/sync/syncManager.ts` | 撤销 / AI 栏「撤销这一步」遇到冲突：走 `undoConflict`，没冲突的直接撤（`commitAside`），真冲突的进待合并表并打开「冲突合并」窗口；提示条只留「已不存在、没法退回」的。收到 `shared.notice content-rolled-back` 弹气泡。 |
| `src/editor/sync/labels.ts` | 加 `rolledBackText`：「〈用户名〉撤回了内容」，名字取不到时「有成员撤回了内容」。 |
| 测试 | `server/test/logout-rollback-plan.test.mjs`（LP-01～09，算法）、`server/test/logout-rollback.test.mjs`（RB-01～03，真的有序提交 + 真的 VisuHive password-order）、`server/test/account-logout-rollback.test.mjs`（LR-E1、LR-E2，整条链路：真的 VisuHive 网站接口与内部口、真的文档服务组合、素材服务进程、wss 编辑页）、`src/editor/sync/undoConflict.test.mjs`（UC-01～04）。 |
| 测试夹具 | `server/test/password-order-fixture.mjs`：协议模拟器认撤回证明（写入身份是撤回的必须带证明，带了才定序）。`server/test/operation-wiring-fixture.mjs`：把文档服务证明钥交给有序提交（页面提交用不到，原有用例不受影响）。 |
| 探针 | `scripts/probes/logout-rollback-probe.mjs`（新，三张截图，见第四节）。 |

**越界（清单外）改的文件，及原因：**

- `src/store/docsync.ts`（`src/store/`，不在「你的」清单里）：撤销冲突的「那一步落地后是什么样」只有 DocSync 知道，不改它窗口拿不到基准。改动全是加法（`Step.after`、`UndoResult.conflict`、`commitAside`），原有撤销 / 重做 / 撤别人那一步的结果不变（`src/store/*.test.mjs` 全过）。
- `server/hosted/doc-assembly.mjs`、`server/hosted/combo.mjs`（`server/hosted/`）：执行器要经文档服务组合拿到有序提交和账号服务客户端，接线只能在这里。前者加 4 行 `rollbackProject`，后者加 4 行把执行器交给续办器。
- `server/test/password-order-fixture.mjs`、`server/test/operation-wiring-fixture.mjs`：测试夹具，见上表。
- `scripts/probes/lib/mobile-env.mjs`：多给出 `combo` 与可选的 `log`（探针要拿页面连接号往上发消息），原有调用不受影响。
- 没碰：`src/online/**`、`lowMemory*`、`LowMemoryGate.tsx`、`measureGate.ts`、`previewMode.ts`、`planDispatch.ts`、`browserNodeHost.ts`、`ProbeGate.tsx`、`Preview.tsx`、`scripts/probes/stage-gate-probe.mjs`、`docs/semantics/**`、`docs/plan/**`。

### VisuHive（逐文件，两个提交分开：先后端、后网页）

提交 `69872ef`（账号后端，向后兼容）：

| 文件 | 改了什么 |
|---|---|
| `account/order-witnesses.mjs` | `actor()` 认撤回的写入身份 `{ accountId, rollbackEventId }`（只许这两个键）；新 `rollbackAuthorization` 核文档服务签的撤回证明（签名、绑定、事件号与写入身份一致）。 |
| `account/password-order.mjs` | 定序：写入身份是撤回的、不带撤回证明一律 401；带了证明再查库：事件存在、是这个账号的、选的是「退出」、不是网站上直接退出登录（`clock.kind === 'logout'`），否则 `rollback-not-allowed`。三种证明同时给多于一种拒。 |
| `account/store.mjs` | 新表 `modification_reports`（只加表，不改已有表、不动版本号）；`modificationReport` / `putModificationReport`（同一报告号同内容幂等，换内容 409）。 |
| `account/events.mjs` | `reportModifications`（只收 `reverted`、`kept`、`projects` 三个非负整数和版本号）；`eventStatus` 的 `modifications` 有报告时是 `{ state: 'rolled-back', version, reverted, kept, candidateRange }`，没有时照旧 `retained`。 |
| `account/internal.mjs` | 路由 `POST /internal/v2/events/:id/modifications`（只认文档服务）。 |
| `account/test/logout-rollback-order.test.mjs`（新） | 三条：能定序的、不能定序的六种、结果上报。 |

提交 `f8cac7c`（网页，依赖上一个提交的新字段；没有该字段时什么都不显示）：

| 文件 | 改了什么 |
|---|---|
| `site/account.html` | 「设备已退出」那一行下面加 `#password-event-modifications`（缺省隐藏）。重设密码完成后也是回到这个页面的同一块（`site/assets/account.js` 的 `reset` → `/account`），所以改密码、重设密码共用这一处。 |
| `site/assets/account.js` | `modificationsText`：选了退出、退出办完、有撤回结果、两数之和大于 0 才显示「旧设备在改密码后做的 N 处修改已撤回；M 处已被别人接着改过，保留。」 |
| `account/test/account-v2-site-client.test.mjs` | 加一条：有结果才显示、0/0 不显示、旧版状态不显示、还在退出时不显示。 |

**交付顺序**（照 `docs/plan/account-binding-task.md`「两仓库交付、部署与回退」）：先手动装 VisuHive 账号后端（`69872ef`）并核对 → 再上 PromptCut 文档服务 → 最后推 VisuHive `site/`（`f8cac7c`，推上去会自动上线）。**PromptCut 文档服务不能早于 VisuHive 后端上线**：旧后端不认撤回的写入身份，区间里真有要撤的修改时，撤回落不了地，续办器就不登记结束见证，网页 45 秒后显示「退出没有确认完成」（区间里没有修改时不受影响：不提交补偿操作，也不报结果）。

## 二、安全论证（六处，逐一指向测试）

1. **撤回只能撤该撤的。** 候选操作同时满足：写入身份的登录号在这次作废的旧登录里；账号服务给的顺序号大于改密的 `changeSeq`、不大于 0.7.18 记下的那个项目的终点；不是凭「共有已读、当前任务」保留证明定序的，也不是这次退出保留下来的任务（授权号、任务号、消息号、对话号、账号、登录逐字段对上）。别人的、同一账号新登录的、旧登录改密之前的修改都不是候选，只当「别人」参与判冲突。补偿操作自己的写入身份不带登录号，账号服务凭证明再核一遍是「改密后选退出」、同一账号。测试：LP-01（改密前、别人、新登录、终点之后各一处都不动）、RB-01（真的有序提交里同样四类）、RB-03（不是改密退出的事件、选了「不退出」的事件、拿别的账号号去撤，有序提交都拒）、VisuHive「不能定序的六种」（选不退出、网站直接退出登录、别人的账号、别的钥签的、证明对不上事件、写入身份夹登录号）。
2. **判冲突逐项，不整份回退。** 每个修改项看它最后一段连续的改动是不是都是候选：是，而且那一段开始之后没人改过它本身、它的上级（别人删了这个片段）或下级（别人改了我新加的片段里的属性），就退回那一段之前的值；否则保留现状。上级的「顺序」项不算（别人往同一个数组加了别的元素不碍事，元素自己那一项会记增删）。补偿操作只写这些路径。测试：LP-02（同一片段里长度撤、透明度留）、LP-03（新加的撤、别人改过的新元素留；删掉的放回原位、删之前改的属性一起退回）、LP-04（上级被别人删了：不改活）、LP-05（旧→别人→旧：只撤最后一段，退回到别人的值）、LP-07（换顺序与之后别人动过数组）、LR-E1（整条链路：撤 1 处、留 1 处，项目内容核对）。
3. **Agent 已读消息例外。** 撤回只动项目内容，不碰对话与消息（消息在账本 `conversationsV2` 里，不在项目 JSON 里）。保留下来继续跑的共有已读任务做的修改不是候选；凭保留证明定序的也不是。被中止的私有任务在区间里做的修改照区间规则撤（契约：「未满足共有已读例外的操作不获得任务授权豁免；改密撤回仍按原区间处理」）。关联要逐字段对上，换了消息号的不算。测试：LP-06。
4. **两条路不混。** 改密退出触发的撤回在服务器上做：补偿操作直接落地，不写任何人的待合并表、不发 `merge.*` 消息，页面收到的只是一次普通的远端修改加一条气泡，不产生撤销提示、不打开窗口；只有用户按撤销按钮（含 AI 栏「撤销这一步」）遇到冲突才进待合并表、打开窗口，而且没冲突的修改项直接撤。测试：RB-01、LR-E1（在线页面一条 `merge.*` 都没收到）、UC-04（撤回的广播到达页面只有 `remote` 一种提示）、UC-01～03（按撤销才给窗口材料；没被改过的直接撤、不进撤销栈；合并照撤回后的值写），探针 U1（真页面：窗口里只有真冲突的那一项，没冲突的名称直接撤回、对方看得到，不再弹撤销提示条）。
5. **气泡发给谁。** 只在补偿操作真的落了地（撤了至少一处）时发；在落地那一刻，发给这个项目里在线的成员页面连接（`role: 'page'`，渲染节点、Agent 服务、托管方服务的连接不发）；〈用户名〉取账本里这个账号在该项目的成员名（`accountNameAtJoin`，被踢的取禁入记录里的）。之后才连上的不补；重启后认出的同一次不补。测试：RB-01（两位在线成员各一条、名字对、之后连上的没有）、LR-E1（真的 wss 编辑页：创建者、另一成员各一条，之后打开的页面没有；没有要撤的那次退出一条都没有）、RB-02b（重启后不补发）、UC-04（字），探针 U2（真页面的气泡）。
6. **幂等与重启。**
   - 撤回做了一半：每个项目各自记在账本里，办完的不再办；补偿操作号是 `logout-rollback:<事件号>:<第几次>`。
   - 定序的请求丢了（没定序）：下一轮有序提交恢复时把那一次作废，执行器看到「已作废」就换下一个号、按当时的内容重算。RB-02：只落了一次、是第二个号，第一次是 cancelled。
   - 账号服务定了序但回应丢了、进程随即重启：恢复时向账号服务查到已定序就落地；执行器重来认出已落地的同一次，不落第二次、不补气泡。RB-02b。
   - 进程重启（办完以后）：账本说办完了，什么都不做。RB-02 第三段。
   - 结果报给账号服务：报告号 `logout-rollback:<事件号>`，同号同内容重发得到同一份、换内容 409；办完以后再跑不再报。RB-02（只报一次）、VisuHive「撤回结果上报」。报不出去（账号服务暂时连不上）就不登记结束见证，下一轮再报，所以网页出现「设备已退出」时那一行一定已经在了。
   - 通知（气泡）丢了：不补（语义「不在线的不补弹」）；账本里记 `notice: sent / nobody-online / not-resent`。
   - 重复收到作废事件：0.7.18 的续办器已认得出（账号事件按序号去重），撤回执行器按事件号只建一条记录。

## 三、改前红、改后绿

改前的两种跑法都在本 worktree 里做：把实现文件换回 main `31de9fae` 的版本、新文件拿掉（测试和夹具留着），账号后端指向 VisuHive main；跑完换回。

**改前一：实现全是 main 的**（`server/test/logout-rollback-plan.test.mjs`、`server/test/logout-rollback.test.mjs`、`server/test/account-logout-rollback.test.mjs`、`src/editor/sync/undoConflict.test.mjs`）：

```
  ✖ LR-E1 撤一处、留一处;网页状态带结果;在线成员各一条气泡;不进待合并表 (709.2498ms)
  ✔ LR-E2 改密后旧设备什么都没改:状态不带撤回结果,没有气泡 (1041.4727ms)
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\server\account\logout-rollback.mjs' imported from …\server\test\logout-rollback-plan.test.mjs
✖ server\test\logout-rollback-plan.test.mjs
✖ server\test\logout-rollback.test.mjs
✖ src\editor\sync\undoConflict.test.mjs
ℹ tests 6  ℹ pass 1  ℹ fail 5
  AssertionError [ERR_ASSERTION]: 「设备已退出」时撤回结果已经在状态里:{"state":"retained","version":"0.7.18","candidateRange":{"changeSeq":2,"endOrderSeq":6}}
```

**改前二：两个纯模块（算法、撤销细分）放回来，接线仍是 main 的**——看行为层面的红：

```
✖ RB-01 … ✖ RB-02 … ✖ RB-02b …（AssertionError：撤回没办成）
✖ RB-03 …  TypeError: f.coordinator.rollback is not a function
✖ UC-01 …  AssertionError: 给了窗口要的材料
✔ UC-02 没有冲突:直接撤,不给窗口材料
✖ UC-03 …  AssertionError（没有 conflict）
✖ UC-04 …  TypeError: rolledBackText is not a function
ℹ tests 8  ℹ pass 1  ℹ fail 7
```

UC-02（没冲突照旧直接撤）、LR-E2（没有要撤的不带结果）在 main 上本来就过：它们守的是「不该变的没变」。UC-04 的前半（撤回的广播到达页面不产生撤销提示）在 main 上也成立，红在气泡的字。

VisuHive 改前（实现换回 main，测试留着）：

```
SyntaxError: The requested module '../events.mjs' does not provide an export named 'reportModifications'
✖ account\test\logout-rollback-order.test.mjs   ℹ pass 0  ℹ fail 1
✖ 设备已退出下面那一行:…   actual: ''   expected: '旧设备在改密码后做的 3 处修改已撤回；1 处已被别人接着改过，保留。'
```

**改后**（账号后端指向 VisuHive 的 `claude/logout-rollback` worktree）：

```
LP-01～09   ℹ tests 9  ℹ pass 9  ℹ fail 0
RB-01、RB-02、RB-02b、RB-03   ℹ pass 4  ℹ fail 0
LR-E1、LR-E2   ℹ tests 3  ℹ pass 3  ℹ fail 0
  {"e1":{"modifications":{"state":"rolled-back","version":"0.7.20","reverted":1,"kept":1,"candidateRange":{"changeSeq":2,"endOrderSeq":7}},"notices":[1,1,0]},"e2":{"modifications":"retained"}}
UC-01～04   ℹ tests 4  ℹ pass 4  ℹ fail 0
VisuHive 全量 node --test account/test/*.test.mjs   ℹ tests 118  ℹ pass 108  ℹ fail 0（10 条原本就跳过）
```

相关回归（改后）：`account-logout-confirmation`、`account-logout-timeout`、`account-logout-agent-restart`、`operation-wiring-core`、`operation-wiring-crash`、`password-order-core`、`password-order-counterexamples`、`password-order-crash`：76/76 过。`src/editor/sync/*.test.mjs src/store/*.test.mjs src/mobile/*.test.mjs`：294/294 过。

## 四、截图

探针 `PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/logout-rollback-probe.mjs --status <LR-E1 的状态>`，退出码 0，`fails: []`，两页 `pageerror` 都是 0。

| 截图 | 内容 |
|---|---|
| `out/logout-rollback/undo-merge-window.png` | 撤销按钮走出来的冲突合并窗口：甲一步改了 c1 的透明度和名称，乙随后改了透明度；甲按撤销 → 窗口里只有「透明度 0.8 → 0.4（云端现在是 0.6）冲突」一项；名称直接撤回（乙那边是「开场」）；没有撤销提示条。 |
| `out/logout-rollback/undo-merge-applied.png` | 勾上、点「合并」以后：「已合并 1 项。」，乙那边透明度变成 0.4。 |
| `out/logout-rollback/rollback-bubble.png` | 项目里那条气泡「小王撤回了内容」（右上角第三条）。 |
| `out/logout-rollback/website-line.png` | 官网账号页：「设备已退出」下面「旧设备在改密码后做的 1 处修改已撤回；1 处已被别人接着改过，保留。」 |

两点要说明：

- 气泡那张：本机托管组合跑的是口令共享项目（截图环境与 0.7.19 的冲突合并探针同一套），它没有「改密后选退出」这条路，所以那条 `shared.notice` 由探针直接发给两位成员的页面连接；消息格式与账号云端项目里文档服务发的一字不差。「谁收得到」由 LR-E1 在真的账号云端项目里证明（在线的两位各一条、之后打开的没有）。
- 官网那张：页面文件是 VisuHive worktree 里 `site/` 原样，由本机静态服务给出；`/api/account` 回放的是 LR-E1 那次真跑出来的事件状态（`reverted: 1, kept: 1`），不是手写的。顺带看到甲那边还有两条「被别人覆盖」的气泡，那是乙改 c1 时原有的覆盖通知，不是本次加的。

## 五、门槛

门槛按协调方转达的用户新定（2026-10-22）：合入前只跑改动影响到的测试，全量挪到 0.7.20 发版前一次做。账号后端两个环境变量指向 VisuHive 的 `claude/logout-rollback` worktree（新测试依赖它的撤回证明与上报口；指向 VisuHive main 时 RB、LR-E1 会红，见第三节）。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出为空（最终代码上） |
| 受影响测试 | `npm test -- <105 个文件>`（清单见下） | 退出码 0；日志 103,520 字节；**750 条，750 过、0 失败、0 取消、0 跳过** |
| 构建 | `npm run build` | 退出码 0（`✓ built`） |
| 在线构建 | `npx vite build --mode online` | 退出码 0（探针用） |
| 探针 | `PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/logout-rollback-probe.mjs --status …` | 退出码 0，`ok: true`、`fails: []`（第四节） |
| VisuHive | `node --test account/test/*.test.mjs` | 118 条，108 过、0 失败、10 跳过（原本就跳过） |

受影响测试的选法：引用了我改过的模块（`server/account/{authority,client,logout-confirmer,password-order,logout-rollback}.mjs`、`server/docservice/operation-wiring.mjs`、`server/docservice/modules/project.mjs`、`server/hosted/{doc-assembly,combo}.mjs`、`src/store/docsync.ts`、`src/editor/sync/{labels,syncManager,undoConflict}.ts`）或改过的夹具（`password-order-fixture`、`operation-wiring-fixture`、`fixtures/account-password-user-path`）的全部测试文件，加上 `src/editor/sync/*.test.mjs`、`src/mobile/*.test.mjs`、`password-order-counterexamples`、`pending-merge`。105 个文件：

`accept-018-files-account-fixture` `account-assembly-accepted-client` `account-assembly-central` `account-assembly-fence-transaction` `account-create-policy` `account-executor-assembly-mtls` `account-hosted-option` `account-hosted-wiring` `account-join-requests` `account-ledger-read-cache` `account-logout-agent-restart` `account-logout-confirmation` `account-logout-rollback` `account-logout-timeout` `account-member-projection` `account-op-resend` `account-password-user-path` `account-projects-ledger` `account-projects-provider` `account-revocation-notification` `account-runner-wiring` `account-task-worker-child` `account-v2-deploy-config` `account-worker-control-https` `agent-c65-duration` `agent-c65-pagestate` `agent-live-selection` `agent-read-closed-prune` `agent-read-control-transport` `agent-read-control` `agent-run-scope-doc` `agent-runner-ack-recovery` `agent-worker-registration-mtls` `agent-worker-settlement-client` `asset-doc-client` `asset-run-mtls` `asset-wiring-integration` `c65b-undo` `cloud-queue-http` `cloud-run-assets-central-history` `cloud-run-assets-central-mount` `cloud-run-assets-central-private-tls` `cloud-run-assets-central-tls` `cloud-run-assets-current-vertical-tls` `conversation-delete-http` `docservice-events` `docservice-pending` `docservice-project-ops` `gone-trust-source` `hosted-render-capacity` `hosted-render-identity` `ht3-equivalence` `invite-impl` `legacy-gone-proof` `local-origin` `logout-rollback-plan` `logout-rollback` `move-guard` `multi-agent-presence` `operation-wiring-core` `operation-wiring-crash` `password-order-core` `password-order-counterexamples` `password-order-crash` `pending-merge` `reopen-hosting` `reopen-relocation-files` `reopen-relocation-transfer` `reopen-relocation` `run-asset-transport-tls-worker` `run-assets-observer` `run-authority-core` `run-authority-operation` `sp-hosting`（以上在 `server/test/`）；`src/editor/fields/fields` `src/editor/io/localWrites` `src/editor/io/mediaSharedSync` `src/editor/sync/` 下全部 24 个 `src/mobile/` 下 3 个 `src/store/{docsync,docsyncCutUndo,docsyncEditor,docsyncStore,reopenRecovery}`。

**这一组没覆盖到、发版前全量要特别看的范围**：
- 通过 `server/hosted/combo.mjs` 间接起整套托管组合、但不在上面清单里的测试（按文件名 grep 只认直接引用；经别的夹具间接起组合的，例如部分 `accept-018-*`、`c10-*`、`render-*` 端到端用例）。
- 只经 `src/store/project`（不直接引用 `docsync.ts`）走到撤销栈的编辑器测试（`src/editor/**` 其余部分、`src/store/actions` 相关）。
- `scripts/probes/` 里用 `lib/mobile-env.mjs` 的其它探针（`mobile-ui-probe`、`mobile-business-probe`、`conflict-merge-probe`）：改动只是多给出两个字段，没跑。

**改之前跑过的两遍全量**（新门槛之前，留作记录，不再追究）：两遍都是 7655 条、日志约 92.2 万字节、有汇总行；各有 1 条失败，都不在我改到的范围里，单跑都过：

| 遍 | 满载失败 | 单跑复核 |
|---|---|---|
| 第一遍 | `server/test/reopen-hosting.test.mjs`「真实中继 restricted」：`TypeError: Cannot read properties of null (reading 'expiresAt')` | 单跑两次：3/3 过、3/3 过 |
| 第二遍 | `server/test/cloud-agent-egress.test.mjs` CA-EGRESS-08：`http://127.0.0.1:8443/` 期望 `port` 实得 `blocked-address` | 单跑两次：14/14 过、14/14 过 |

第三遍按协调方要求中途停掉，停掉后清理了它留下的、命令行在本 worktree 下的测试子进程（只动了本 worktree 路径下的）。

## 六、要你补的语义（不由我改）

1. **「怎样判定在它基础上又改过」**（契约 `account-binding-contract.md` 第 222 行写的待设计）：这一版的判法是第二节第 2 条（同一项、上级、下级；上级的「顺序」项不算）。建议写进 `mechanism/document-service.md`「保存与延迟退出的修改处理」一条：撤回按操作历史的修改项（叶子属性、带 id 数组的元素、数组的顺序）判；区间终点取退出确认证据里的「位置」；补偿操作的写入身份是 `{ accountId, rollbackEventId }`，凭文档服务签的撤回证明由账号服务定序。并把第 52 行「这一版只记不用」改成「0.7.20 起作为撤回区间的终点」。
2. **「N 处」怎么数**：这一版按修改项数（同一样东西的两个属性算两处；新加或删掉一整个片段算一处，它里面的属性不另算；写了同样的值的不算）。网页那一行和气泡都依这个数。语义没写，请定。
3. **私有任务在区间里做的修改撤不撤**：照契约「未满足共有已读例外的操作……改密撤回仍按原区间处理」撤了；已经结束的共有已读任务（不是「当前任务」）在区间里做的修改也照撤。语义第 93 行只说了「当前任务及其修改保留」，没说已结束的那一种，请确认。
4. **撤回结果什么时候出现在网页上**：这一版让撤回办完、结果报给账号服务之后才登记结束见证，所以网页出现「设备已退出」时那一行已经在了；撤回落不了地（例如有序提交不可用）时，网页会和别的确认没到一样，45 秒后显示「退出没有确认完成」。语义「未确认或撤回仍未处理不能假装整个流程已结束」与此一致，但「退出和修改处理进度分别表达」这一句这一版没有单独的进度显示，请定要不要。
5. **撤销按钮的冲突里，同一样东西没被别人改过的属性**：这一版直接撤（一次不进撤销栈的修改，是这次撤销的一部分），只有真冲突的进窗口。所以「撤销」之后再「重做」，直接撤的那几项不会跟着重做回来。语义「要撤的那一步改过的地方之后没有别人再改，直接撤回」按修改项读是这样；若要按「东西」整样进窗口，改 `undoConflict.ts` 一处。
6. **气泡的〈用户名〉**取的是这个账号加入项目时的名字（`accountNameAtJoin`）。账号后来改了名，气泡里是旧名。

## 七、没做成的及原因

- **全量 `npm test`**：按用户新定挪到发版前，没有一遍干净的全量（见第五节）。
- **气泡截图不是从真的改密退出触发的**：截图环境的口令共享项目没有这条路，原因与替代证据见第四节。
- **「退出和修改处理进度分别表达」**：没有单独的撤回进度显示（撤回结果随「设备已退出」一起出现），见第六节第 4 条。
- **部署顺序是硬约束**：PromptCut 文档服务不能早于 VisuHive 账号后端上线，见第一节末。没有做「旧账号后端时跳过撤回」的降级，因为那样会把该撤的修改静默留下。
- 真实网络环境验收没做（不部署就不跑，`verification.md`）。

## 八、安全专审返工（2026-10-22）

专审报告与反例测试在 `.worktrees/sec-logout-rollback`（`docs/reports/AGENT-claude-sec-logout-rollback.md`、`server/test/sec-logout-rollback.test.mjs`）。按协调方要求把那份测试原样复制到本 worktree 的 `server/test/sec-logout-rollback.test.mjs` 作为验收；SEC-01～05 五条全修（SEC-04 按协调方更正后的「五条全绿为准」也修了）。账号后端两个环境变量仍指本人的 VisuHive worktree（VisuHive 这次一行没改）。

### 怎么修的

| 条目 | 改法 | 文件 |
|---|---|---|
| SEC-01 补偿操作号被页面占号 | 前缀常量 `ROLLBACK_OP_PREFIX = 'logout-rollback:'` 和拼法 `rollbackOpId()` 写在一起（`logout-rollback.mjs`），项目模块用它拼号；有序提交的 `execute`（页面与 Agent 提交都经过它）遇到这个前缀直接拒 `reserved-op-id`；`executeSystem` 反过来只收这个前缀。执行器另外兜底：真撞上 `operation-id-mismatch`（前缀保留之前留下的老数据）就换下一个号，不卡住。顺带收敛专审 Q5：发给页面的 `project.ops`、`project.state` 的最近写入者、`stale` 回包里的写入身份和操作号都不再带事件号（写入身份换成 `rollback: true`，操作号换成不可反推的散列）；存储里照旧是全的。 | `server/account/logout-rollback.mjs`、`server/docservice/operation-wiring.mjs`、`server/docservice/modules/project.mjs` |
| SEC-02 普通数组被当成带 id 数组的顺序项 | 删掉按值形状猜的 `isIdList`，改成 `isIdStructure`：看那次操作前后真实的数组（操作历史里每次操作都带前后快照；没有快照时看项目现在的值），用 `json-ops.mjs` 的 `isIdArray` 判；两边都是空数组时看同一次操作有没有记它的元素项。普通数组按整个数组 `set` 回退，和叶子属性一样判冲突、该进保留的进保留。 | `server/account/logout-rollback.mjs` |
| SEC-03 判冲突两两比、同步占住事件循环 | 走**第①条（降到 O(n log n)）**，另加第②条的上限与分批作纵深防御，见下。 | `server/account/logout-rollback.mjs`、`server/docservice/modules/project.mjs` |
| SEC-04 一个退出的撤回挡住别的退出 | 续办器里每个退出的撤回各自在后台跑（同一个事件同时只办一份，记在 `rollbacks` 里），一遍里最多等 `LOGOUT_ROLLBACK_WAIT_MS`（1 秒）；没办完记「撤回还在办」、先办别的退出；各退出并发「撤回 → 登记结束见证」。办成了叫醒续办器。「没办完就不登记结束见证」不变。 | `server/account/logout-confirmer.mjs` |
| SEC-05 账本里的路径不限长 | 每条路径最多 300 个字符，超了截断并标「…〔截断〕」；每个项目 50 条的上限保留。 | `server/account/logout-rollback.mjs` |

### SEC-03 走哪条、为什么

选**第①条**：判「之后别人改没改过它本身、上级、下级」不再两两比。别人的修改记录按路径建两个索引：同一路径上各种类的最晚一次（查本身和上级，上级沿路径往上走，次数等于深度）；按路径排序的数组加区间最大值稀疏表（查下级：路径以 `p/` 开头的在排序后是连续一段，一次二分加一次 O(1) 查询）。带 id 数组按 id 找元素也改成按数组建一次索引。实测（同一台机器，单独跑，`planRollback` 本身）：

| 区间里的修改项 | 改前 | 改后 |
|---|---|---|
| 2000（对象下新加键） | 777 ms | 13 ms |
| 16000 | 28 328 ms（倍数 36.5，平方增长） | 82 ms（倍数约 6，接近线性） |
| 64000 | 没测（按平方约 7 分钟） | 191 ms |

又加了第②条作纵深防御，原因是另一处平方：`json-ops.mjs` 在**长的带 id 数组**上按 id 找元素和 `splice` 是线性的，一批里对同一个长数组做几千次增删就是平方（实测 16000 个片段的数组、一次撤 16000 处：11.7 秒）。这是 json-ops 原有的性质，页面提交同样受它影响（一笔 256 KiB 的页面提交往 6 万个元素的数组里插几千个也要几秒），不是撤回引入的，但撤回不该比页面提交更糟：
- **分批**：一批最多 1000 个修改项、序列化后最多 256 KiB（和页面一次提交的上限相同），所以落地一批的开销不超过一笔最大的页面提交。每批是一次单独的补偿操作（自己的号、自己的项目锁），批与批之间 `setImmediate` 让出事件循环，别的项目、别的连接不被冻住。下一批按当时的内容重算：前几批这次撤回自己落地的算「已撤」、它们删掉的东西底下的项跟着没了，也不算「别人后来改过」。气泡只在第一批发。
- **上限**：一个项目一次撤回最多处理 5 万个修改项（`ROLLBACK_ITEM_LIMIT`）。超出的**不撤、逐条记进保留**（原因 `over-limit`），网页那一行的「保留」数和账本 `overLimit` 都算上，诊断日志里记一条 `logout-rollback-over-limit`；不会「超了就不撤」而不留痕迹。一批里有剩下的却一笔都落不了地（全落不下）时，不空转，剩下的数目同样记进保留和 `overLimit`。
- 记成待办（不在本次范围）：`json-ops.mjs` 在长数组上按 id 找元素的线性开销，页面提交也有，建议另开一项给 `applyOps` 加按 id 的索引。

### 改前红、改后绿

改前（被审实现，`server/test/sec-logout-rollback.test.mjs`）：

```
✖ SEC-02 …  AssertionError: 词表的修改既没撤也没记保留:reverted=[] kept=[]
✖ SEC-03 …  AssertionError: 2000 项 777 ms,16000 项 28328 ms,倍数 36.5:按平方增长,且全程同步占住主线程(整个 Node 事件循环冻住)
✖ SEC-05 …  AssertionError: 一次退出、一个项目就在账本里留了 1001046 字节(账本每次落盘整段重写)
✖ SEC-04 …  AssertionError: 别的账号的退出被 pw_stuck 的撤回挡住了:sealed=[]
✖ SEC-01 …  AssertionError: 页面提交(project.op.ok)占住了补偿操作号;执行器跑了 4 轮仍未办完(第 1 次、诊断 logout-rollback-operation-id-mismatch);… /extra="a-window" 也没撤
ℹ tests 5  ℹ pass 0  ℹ fail 5
```

本次新加的四条自己的测试，在被审实现上（实现文件换回 `d91055ae`，测试留着）：

```
✖ LP-10 普通数组按整个数组撤…(SEC-02)   AssertionError: 词表整个退回
✖ LP-11 上限与分批…(SEC-03)
✖ RB-04 补偿操作号的前缀留给文档服务…(SEC-01)
✖ RB-05 要撤的很多:分批落地…(SEC-03)   AssertionError: 450 项按 120 一批:4 批
```

同一遍里 RB-01、RB-02 也红：这两条的断言这次有意改了（RB-01 现在断言广播里**不带**事件号；RB-02 改看 `lastOpId`，因为账本里的 `attempt` 现在是「下一个要用的号」），它们在新断言下对旧实现红是预期的。

改后（最终代码，五个文件一起跑）：

```
✔ LR-E1 … ✔ LR-E2 …
✔ LP-01 … LP-11（11 条）
✔ RB-01 ✔ RB-02 ✔ RB-02b ✔ RB-03 ✔ RB-04 ✔ RB-05
✔ SEC-02 ✔ SEC-03 (659 ms) ✔ SEC-05 ✔ SEC-04 ✔ SEC-01
✔ UC-01 … UC-04
ℹ tests 29  ℹ pass 29  ℹ fail 0
```

### 门槛（返工后）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 受影响测试 | `npm test -- <106 个文件>`：第五节那 105 个，加 `server/test/sec-logout-rollback.test.mjs`（引用 `logout-confirmer.mjs` 的测试已在清单里） | 退出码 0；日志 104,839 字节；**759 条，759 过、0 失败、0 取消、0 跳过** |
| 构建 | `npm run build` | 退出码 0 |
| 探针 | `PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/logout-rollback-probe.mjs --status …` | 退出码 0，`ok: true`、`fails: []`，三步结果与第四节一致（这次只改了服务器一侧，在线构建沿用） |

没覆盖的范围同第五节；另加一条：`json-ops.mjs` 本身没改，它的测试没另跑。

### 返工里改到的文件

`server/account/logout-rollback.mjs`、`server/account/logout-confirmer.mjs`、`server/docservice/operation-wiring.mjs`、`server/docservice/modules/project.mjs`；测试：`server/test/sec-logout-rollback.test.mjs`（原样复制）、`server/test/logout-rollback-plan.test.mjs`（加 LP-10、LP-11）、`server/test/logout-rollback.test.mjs`（加 RB-04、RB-05，RB-01/02 两处断言按上面改）。VisuHive 没改。

### 要你补的语义（追加）

7. 撤回的上限与分批是三级数字，建议写进 `mechanism/document-service.md`：一批最多 1000 个修改项、256 KiB；一个项目一次最多 5 万个修改项，超出的记进保留；账本每条路径 300 字符、每个项目 50 条；续办器每个退出的撤回一遍最多等 1 秒。
8. 「超过上限的不撤、算保留」会让网页那一行的「M 处已被别人接着改过，保留」把上限之外的也算进去，字面上不准。要不要给超限另一句话，请定（这一版没改网页的字）。

## 九、超过上限的那几处单独说（协调方核返工后提出）

问题：第八节的上限把「超过上限没撤的」算进了网页上「M 处已被别人接着改过，保留」。那几处没人碰过，是系统自己放弃的，这句话对用户不实。

### 改法（加字段、不改已有字段的含义）

- **PromptCut**（`server/account/logout-rollback.mjs`）：每个项目的 `kept` 只算「真的被别人接着改过所以保留」（以及落不下去的 `cannot-apply`），不再含 `over-limit`；超限的与「一批全落不下、剩下的」一起单独记 `overLimit`。上报给账号服务的那份多一个非负整数 `overLimit`（取账本 `totals.overLimit`），三个数分开。三个数都是 0 时照旧不报。
- **VisuHive 后端**（提交 `e1940c3`，`account/events.mjs`、`account/store.mjs`）：`reportModifications` 多收 `overLimit`，缺省 0、必须是非负整数；`eventStatus` 的 `modifications` 带出 `overLimit`（旧报告没有这个数按 0）；同一报告号重发时也核这个数。
- **VisuHive 网页**（提交 `8851416`，`site/assets/account.js`）：`overLimit > 0` 才在原句后面多一句，三个数都为 0 时整行照旧不显示。整行现在是：

  > 旧设备在改密码后做的 450 处修改已撤回；0 处已被别人接着改过，保留。另有 50 处这次没有撤回：一次能处理的修改数量到了上限，不是别人改过；这些内容仍在项目里，没有丢。

  没有超限时一字不变：「旧设备在改密码后做的 N 处修改已撤回；M 处已被别人接着改过，保留。」
- 交付顺序不变：先装 VisuHive 后端（`69872ef`、`e1940c3`），再上 PromptCut 文档服务，最后推 `site/`（`f8cac7c`、`8851416`）。新网页配旧后端：没有 `overLimit` 按 0，和原来一样；新文档服务配旧后端：多出的字段旧后端会照旧收下前三个数（`reportModifications` 只挑认识的字段）——但按第一节，文档服务本来就不能早于后端上线。

### 改前红、改后绿

改前（测试先写，实现没动）：

```
PromptCut  RB-05:
✖ RB-05 要撤的很多:分批落地、批与批之间让出事件循环;…
  AssertionError: 超过上限的 50 项单独记账,不悄悄丢、也不冒充别人改过
    actual: [ 450, 50, 50, 4 ],
    expected: [ 450, 0, 50, 4 ],
VisuHive:
✖ 设备已退出下面那一行:超过上限没撤的单独一句,说清不是别人改过、内容还在;三个数分开
    actual: '旧设备在改密码后做的 450 处修改已撤回；2 处已被别人接着改过，保留。',
    expected: '旧设备在改密码后做的 450 处修改已撤回；2 处已被别人接着改过，保留。另有 50 处这次没有撤回：一次能处理的修改数量到了上限，不是别人改过；这些内容仍在项目里，没有丢。',
✖ 撤回结果上报:超过上限没撤的单独一个数(overLimit),缺省 0;不并进「保留」;重发同一份照旧
  AssertionError: Missing expected exception.
ℹ tests 14  ℹ pass 12  ℹ fail 2
```

改后：

```
PromptCut（专审 5 条 + 自己的 29 条里的 24 条 + LR-E 2 条 + UC 4 条，五个文件一起跑）  ℹ tests 29  ℹ pass 29  ℹ fail 0
  ✔ RB-05 …（[reverted, kept, overLimit, parts] = [450, 0, 50, 4]；报给账号服务的是 [450, 0, 50]）
VisuHive 全量 node --test account/test/*.test.mjs  ℹ tests 120  ℹ pass 110  ℹ fail 0（10 条原本就跳过）
探针 U3b：网页那一行与上面引文一字不差；截图 out/logout-rollback/website-line-over-limit.png
```

（「29 条」是这五个文件的总条数：LR-E 外层 1 + 子项 2、LP 11、RB 6、SEC 5、UC 4。）

### 门槛

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | 退出码 0 |
| 受影响的 106 个测试文件（`npm test -- …`，清单同第八节） | 退出码 0；日志 104,875 字节；759 条，759 过、0 失败、0 取消、0 跳过 |
| `npm run build` | 退出码 0 |
| 探针 | 退出码 0，`ok: true`，多了 U3b 一步与一张截图 |
| VisuHive 全量 | 120 条，110 过、0 失败、10 跳过 |
