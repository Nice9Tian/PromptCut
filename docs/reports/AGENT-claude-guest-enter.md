# AGENT-claude-guest-enter

分支 `claude/guest-enter`（从 main `99c574d7` 切出），worktree `.worktrees/guest-enter`。没推送、没合并。

任务：0.7.21 线上实测，游客建好云端项目后点进去报「请先登录账号。」。要让游客能进自己的项目，整条路跑通。

## 一、根因（两处，第二处比任务书说的更深）

**1. 进项目那一步只认网站账号（任务书说的那一处，复核属实）。**
`src/editor/sync/syncManager.ts` 的 `enterAccountProject` 在连接接上之后取 `options.client.account`，为空就抛 401 `login-required`，提示文字就是「请先登录账号。」。
`client.account` 是 `login?.account ?? websiteAccount`。游客模式下 `ensureLogin` 走游客分支，`login` 一直是 null，没有网站账号时 `websiteAccount` 也是 null，所以游客走到这里一定会抛。
用 main 的页面代码跑新探针，复现出线上同一个错：`探针中断:游客进入新建的项目:开始页报「请先登录账号。」`（证据见第四节）。

**2. 修好第 1 处之后，游客进得去，但一步也改不了（任务书没提，线上一定也是这样）。**
导入一张图后提示「有一步修改没被文档服务接受(bad-actor),已撤回。」，图片随即消失。
原因：文档服务把每一步写入交给账号服务（VisuHive）定序，账号服务签一份顺序见证。账号服务的 `account/order-witnesses.mjs` 的 `actor()` 只认 `acc_` 编号，遇到 `gst_` 编号回 400 `bad-actor`。
游客编号是文档服务签发的，账号服务不认识它。语义本来就写着游客身份「不经账号服务」，但写入定序这条路漏掉了游客。

**3. 顺带查出的几处，都会挡游客：**
- `client.ts` 的 `validateMembers` 只认 `acc_` 编号。游客项目的创建者是游客，所以 `members()` 一律回协议错误；账号项目里只要有游客成员，也一样出错。
- 创建者踢游客时，`memberAdmin` 只认 `acc_` 编号，请求在客户端就被挡掉。
- `server/account/project-members.mjs` 把游客的连接滤掉了，成员浮层里看不到游客的设备和在线状态。
- 游客在自己项目的直达地址上刷新，会回到开始页，没有回到项目。这违背 `workflow/project.md` 的「刷新后还在这个项目里」。
- 云端 Agent 的告知读取（`consent.ts`）也看 `client.account`。改成按主体认之后，会走到「网站账号对不上」那一支，报「登录已失效」，这句话会误导用户。

## 二、改了哪一层，为什么

**页面一侧：在账号客户端上收口成一个「主体」**，没有在各处散打 `?? guest` 的补丁。
- `src/account/client.ts` 新增 `get principal()`：游客模式下返回 `{ id: gst_…, name: 游客-XXXX }`，否则返回账号。判断条件和 `ensureLogin` 的游客分支相同。`account` 的含义不变，仍然只表示网站账号。
- 凡是表示「以谁的身份进项目」的地方都改用 `principal`：`syncManager.ts` 的进项目、`isCurrent`、`bind(... account:<id>)`、`setCloudConsentSource`、桌面卡片同步的 `isCurrent`，以及 `consent.ts` 的绑定核对。共 10 行，都是把 `account` 换成 `principal`。
- 凭网站账号做的事还看 `account`：`lists()`、申请加入、搬到云端（`accountMoveFlow.ts`，游客不走这条路，没动）。
- 主体编号：新增 `PRINCIPAL_ID_RE`，`acc_` 和 `gst_` 都认。成员名单的成员、设备、禁入、创建者，以及踢人、解禁都改用它；申请加入仍然只认 `acc_`（服务端只有账号能申请）。游客没有账号名时，按编号显示「游客-XXXX」。
- 云端 Agent 告知：游客模式下 `cloudAgentConsent` / `acceptCloudAgentConsent` 直接抛 403 `guest-agent-unavailable`，提示「游客暂时用不了云端 Agent。要用的话，请登录网站账号。」，不发请求。游客项目的云端 Agent 开关没动，仍然默认开着。
- `src/account/useAccountProjects.ts`：直达地址打开、这台浏览器记着游客身份时，自动以同一个游客身份接着进项目。从直达地址打开后点「以游客身份进入」，也接着进那个项目。

**服务端：游客的写入由文档服务自己定序。** 只有这一层能修：账号服务那边不该认识游客，而且它是另一个仓库，冻结的真实提供方。
- `server/account/password-order.mjs`：写入身份是游客时，文档服务用自己的证明钥（`docAttestationPrivateKey`，已有）签一份形状相同的见证，域是 `promptcut.guest-order`。
  - 四个动作（保留、封口、作废、查询）在本地完成。顺序号取这个项目里游客见证的下一个号，在项目锁里取。
  - 游客域的见证只给游客的操作用；账号的操作仍然只认账号服务的见证。
  - 重启恢复时，游客见证不去账号服务对账，只核签名。
- `server/docservice/modules/operation-history.mjs`：顺序号是否单调，按见证的域分开核，`recordAcceptedOperation` 和 `validate` 都改了；另加 `lastOrderSeq(projectId, domain)`。
  - 账号和游客交替写的时候，不会因为两条序列互相比较而被判成倒退。
  - 没写域的老见证（只在测试里有）按同一条序列算，所以向后兼容。
- `server/account/project-members.mjs`：统计连接时认游客编号；申请列表仍然只认账号。

## 三、验证

### 本机真流程（在线构建 + 本机托管组合，全程游客，端口 6490～6496，`PROMPTCUT_NO_PORT_FILE=1`）

组合用的是 `server/test/fixtures/cloud-queue-user-path.mjs`：真账号后端、带游客密钥的文档服务、独立的素材服务进程、TLS 入口。在线构建由夹具入口在 `/editor/` 下发。命令：

```
PROMPTCUT_NO_PORT_FILE=1 PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs node scripts/probes/guest-enter-e2e-probe.mjs --out out/guest-enter
```

退出码 0。stdout：`{"ok":true,"fails":[],"shots":[G1…G6 共 7 张]}`。每一步看到的：

| 步 | 看到什么 |
|---|---|
| G1 点「以游客身份进入」 | 领到 `gst_…`，开始页显示「游客-E163」，令牌写进本机 |
| G2 新建云端项目 | 进了编辑器，地址栏是 `/editor/p/sp_…`，项目记进本机 |
| G3 成员浮层 | 「游客-DC8F（自己）[创建者]」，设备一行「[编辑中]」（看过截图 `G3-members.png`） |
| G4 导入一张 96×64 的 PNG | 素材库图片组 1 个项；没有「没被文档服务接受」「没有传上云端」的提示。**另开一条连接、用这个游客的令牌直接读文档服务**：`rev 3`，`media: ["guest-probe-….png"]`，写入者 `gst_…` |
| G5 刷新 | 自动回到项目（地址不变、还是同一个游客），图片在，缩略图读的是素材服务里的字节（`drawn: 1`，`src` 指向 `/media`；看过截图 `G5-reloaded.png`，蓝色图块在） |
| G6 回到开始页 → 再点「以游客身份进入」→ 点自己的项目（线上就是这一步报错） | 开始页列出「游客项目-…」，点进去进了编辑器，图片还在（看过截图 `G6-start.png`） |
| G7 | 一路上页面里没出现过「请先登录账号」 |

**对照**（证明探针抓得到这两个 bug）：
- 页面换回 main 的代码（`99c574d7` 的四个文件，另外构建到 `dist-online-base`），退出码 1：`探针中断:游客进入新建的项目:开始页报「请先登录账号。」`，和线上一样。
- 页面用修好的代码、服务端用旧的定序：G4 拿到「有一步修改没被文档服务接受(bad-actor),已撤回。」（探针第一版跑出来的，HTTP 记录里素材上传 200，文档那一步被拒）。

### 受影响的测试（没跑全量）

都带了上面两个环境变量（反斜杠）。

1. `npm test --` 跑 33 个文件，退出码 0，**295 项全过**：
   - 账号与游客：`src/account/guest.test.mjs`、`guestClient`、`guestPrincipal`（新）、`client`、`joinRequest`
   - 服务端游客：`server/test/account-guest-*.test.mjs`（6 个，含新的 `account-guest-order`）、`guest-asset-quota`、`guest-fix-cleanup`、`guest-fix-regression`
   - 定序与成员：`password-order-core`、`password-order-crash`、`account-member-projection`
   - 云端 Agent 告知：`src/ai/cloud/consent.test.mjs`、`consent-once`
   - 分层：`src/layering.test.mjs`
   - 同步：`src/editor/sync/` 下账号、进入、云端、重连、在场、标签相关的 13 个
2. 动了定序和操作历史，另跑了 34 个服务端文件（`account-assembly-*`、`operation-wiring*`、`run-authority*`、`agent-run-scope-doc`、`asset-wiring-integration`、`logout-rollback*`、`account-member*`、`account-logout*`、`password-order*`、`operation-history*`、`account-dual-user-path`、`accept-018-auth*`），退出码 0，**216 项全过**。
3. `npx tsc -b --force`：退出码 0，零错误。
4. `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`：「守门：通过」，新探针已登记。

新加的测试：
- `src/account/guestPrincipal.test.mjs`（5 项）：principal 和 account 的区别、主体编号、成员名单里的游客与「游客-XXXX」、踢游客、游客问告知时一个请求也不发。
- `server/test/account-guest-order.test.mjs`（5 项），账号那一侧用的是真的账号服务定序实现：
  - 游客写入不经账号服务（账号序列不动）；
  - 账号和游客交替写，四步都落地，`validate` 能过；
  - 重启恢复不对账，换了证明钥就核不过；
  - 游客域的见证过不了账号的核对；
  - 修好之前留下、只到 prepared 的游客操作，恢复时作废，之后照常写。

### 验收清单登记

`scripts/acceptance/v21-manifest.mjs` 加了 `V21-guest-enter`。它需要在线构建和账号环境变量，夹具端口缺省 6490～6496。

## 四、〔裁〕（〔裁〕是本分支按规则自行定下、等用户审的改动；都标在 `docs/semantics/` 里）

### 二级（用户看得到；请主会话打印给用户）

1. **游客的修改由云端文档服务定序，不经账号服务**（`product/document-service.md`「游客」那一条末尾加了半句）。
   这涉及「谁签发、谁核对」，按高的一级算作二级。实际上是把已有承诺「游客身份不经账号服务」补全到写入这条路上。
   不这么做，游客在自己的项目里一步也改不了。
2. **游客问云端 Agent 时，明说「游客暂时用不了云端 Agent。要用的话，请登录网站账号。」**（`mechanism/document-service.md` 写了怎么做到）。
   原先游客那里显示「请先登录账号。」，改成主体之后会显示「登录已失效」，两句都不对。
   这只是如实说明现状，**没有关掉游客项目的云端 Agent 开关**。

### 三级（机制，写在 `mechanism/document-service.md`「游客」一节）

3. 页面以主体（账号或游客）进项目；成员名单收 `gst_` 编号，没名字时显示「游客-XXXX」；成员浮层统计游客的连接。
4. 游客在自己项目的直达地址上刷新，以同一身份接着进项目；从直达地址打开后点游客进入，也接着进。
   这是为了兑现一级已有的「刷新后还在这个项目里」，一级的写法没改。
5. 写入定序的具体做法：游客见证的域与签名、顺序号按域分开单调、恢复时不对账、旧的 prepared 作废。

## 五、没做成的与待用户项

- **待用户项：游客能不能用云端 Agent。** 语义里写着游客进别人的项目不能给云端 Agent 发消息，言下之意是在自己的项目里可以。但现在做不到：
  - 告知记在网站账号上（`/api/account/cloud-agent-consent`）；
  - 服务端发消息前也去问账号服务（`doc-agent-assembly.mjs` 的 `/internal/v2/consents?accountId=`）；
  - 游客两边都没有地方记。

  要支持，得定告知记在哪（比如记在文档服务里、跟着游客编号走），还要让云端 Agent 能以游客身份跑任务。这超出本次范围，所以只保证了「不因为没有账号就抛错、乱报原因」。
  另外，夹具里没有起云端 Agent 服务（`/agent/v1/notices` 回 404），所以右栏一直停在「正在读取对话权限…」。这和游客无关，那条提示本机没看到实际效果，只有单测覆盖。
- **上线要换文档服务**，不只是换在线页面：第 2 处根因在服务端（`password-order.mjs`、`operation-history.mjs`、`project-members.mjs`）。只换页面的话，游客能进项目，但改不了内容。
  线上已有游客操作卡在 prepared 的项目，换上新的文档服务后，下次打开时会自动作废那几条（有测试覆盖）。
- **没碰线上**：没跑生产节点，没登生产站点。
- **游客的令牌续期（24 小时）、重连、换会话**：没有专门做 24 小时的实测。
  - 依据是代码：这三条都经过 `client.session` → `ensureLogin` 的游客分支，令牌快到期就先续，编号不变（`guestClient.test.mjs` 已有「过期先续再打」的测试）。
  - `isCurrent` 按主体编号判断，续期前后编号相同，所以不会把自己判成换了人。
  - 探针运行期间看到页面每 15 秒续一次会话（HTTP 记录里 `/account/session` 都是 200）。

## 六、顺带发现（不是游客专有，没改）

- 在线导入图片的那一刻，缩略图先挂上素材服务地址，这时上传还没完成，拿到一次 404，之后不再重取，要刷新才显示。HTTP 记录里 GET `media/<hash>` 的 404 早于 PUT。账号项目应该也一样，没核。
- 游客的设备名没有来源：账号的设备名来自编辑器登录，游客没有，所以成员浮层里设备那行显示两遍设备号。只影响外观。

## 七、改了的文件

- `src/account/client.ts`、`src/account/useAccountProjects.ts`、`src/editor/sync/syncManager.ts`、`src/ai/cloud/consent.ts`、`src/ai/cloud/offline-queue-probe-harness.tsx`（假客户端补上 `principal`，否则那支探针的告知绑定对不上）
- `server/account/password-order.mjs`、`server/docservice/modules/operation-history.mjs`、`server/account/project-members.mjs`
- 新增：`scripts/probes/guest-enter-e2e-probe.mjs`、`src/account/guestPrincipal.test.mjs`、`server/test/account-guest-order.test.mjs`
- `scripts/acceptance/v21-manifest.mjs`
- `docs/semantics/product/document-service.md`、`docs/semantics/mechanism/document-service.md`

任务书只点了页面一侧。服务端那三处是沿着「进项目、改内容」这条链查出来的，不改就验不过，所以越出了任务书点到的范围，在这里说明。

## 八、对任务书的更正

- 任务书说的根因只是第一层。修完它，游客进得去但改不了，线上要两层一起修。
- 「新建云端项目 → 建成功」那一步在线上其实已经进入了 `enterAccountProject`，也报了同样的错（新建之后紧接着就是进项目）。所以线上看到的「点自己的项目报错」，不是只有从列表点进去才会出现。
