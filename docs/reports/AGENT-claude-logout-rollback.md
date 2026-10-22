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

（见第七节，全量跑完补）

## 六、要你补的语义（不由我改）

1. **「怎样判定在它基础上又改过」**（契约 `account-binding-contract.md` 第 222 行写的待设计）：这一版的判法是第二节第 2 条（同一项、上级、下级；上级的「顺序」项不算）。建议写进 `mechanism/document-service.md`「保存与延迟退出的修改处理」一条：撤回按操作历史的修改项（叶子属性、带 id 数组的元素、数组的顺序）判；区间终点取退出确认证据里的「位置」；补偿操作的写入身份是 `{ accountId, rollbackEventId }`，凭文档服务签的撤回证明由账号服务定序。并把第 52 行「这一版只记不用」改成「0.7.20 起作为撤回区间的终点」。
2. **「N 处」怎么数**：这一版按修改项数（同一样东西的两个属性算两处；新加或删掉一整个片段算一处，它里面的属性不另算；写了同样的值的不算）。网页那一行和气泡都依这个数。语义没写，请定。
3. **私有任务在区间里做的修改撤不撤**：照契约「未满足共有已读例外的操作……改密撤回仍按原区间处理」撤了；已经结束的共有已读任务（不是「当前任务」）在区间里做的修改也照撤。语义第 93 行只说了「当前任务及其修改保留」，没说已结束的那一种，请确认。
4. **撤回结果什么时候出现在网页上**：这一版让撤回办完、结果报给账号服务之后才登记结束见证，所以网页出现「设备已退出」时那一行已经在了；撤回落不了地（例如有序提交不可用）时，网页会和别的确认没到一样，45 秒后显示「退出没有确认完成」。语义「未确认或撤回仍未处理不能假装整个流程已结束」与此一致，但「退出和修改处理进度分别表达」这一句这一版没有单独的进度显示，请定要不要。
5. **撤销按钮的冲突里，同一样东西没被别人改过的属性**：这一版直接撤（一次不进撤销栈的修改，是这次撤销的一部分），只有真冲突的进窗口。所以「撤销」之后再「重做」，直接撤的那几项不会跟着重做回来。语义「要撤的那一步改过的地方之后没有别人再改，直接撤回」按修改项读是这样；若要按「东西」整样进窗口，改 `undoConflict.ts` 一处。
6. **气泡的〈用户名〉**取的是这个账号加入项目时的名字（`accountNameAtJoin`）。账号后来改了名，气泡里是旧名。

## 七、没做成的及原因

（见门槛结果）
