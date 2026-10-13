# AGENT-v18-cardsync：账号云端项目里的用户卡源码同步、卡片声音上传、Agent 一侧旧绑定

分支 `claude/v18-cardsync`，从 main `5c286289` 起。派活指令共五条（第 6 条渲染节点不做也没碰）。

名词：**账号项目** = 走网站账号的云端项目；**编辑器进程** = 桌面版里跑 vite 的那个 Node 进程（卡片文件、改动层、卡片源码同步都在它里面）；**票据** = 文档服务给一条连接用的一次性短凭证；**访问令牌** = 账号服务发给一次登录的短凭证（寿命 120 秒，到期前客户端自己续）。

## 结论

| 条 | 结果 |
|---|---|
| 1 卡片源码同步在账号项目里通（桌面） | 做成。上传、订阅、热更新与旧共享项目一致；到期会续；退出登录、被踢、项目被删后停 |
| 2 账号闸对内容库写入的放行 | 闸没改。原来就是 `content.put` 按「写」判、读类按「读」判；可写成员能写、只读成员回 `not-listed`、点名别的项目回 `project-mismatch`，都有真服务测试 |
| 3 云端 Agent 建的卡桌面拿得到 | 成立（用另一条账号连接直接写内容库来模拟，没有起真的云端 Agent） |
| 4 卡片声音上传 | 做成。账号项目里用账号会话签发的素材票据；乙凭自己的票据取到同样的字节并解码出声音 |
| 5 Agent 一侧旧绑定 | 做成。进账号项目时解绑；真编辑器进程上「进之前绑着本机项目、进之后没绑」 |

验收里**有一项没按原样达成**：在线页面拿得到源码，但**画不出来**。原因不在卡片同步，在舞台取素材票据的那一步只认旧票据的形状（见「发现的三个现状问题」第 2 条），那个文件连着线上的 nginx 配置，不在我的清单里，没改。把探针自己的舞台源放宽成也认账号票据之后，在线页面画得出来、改卡后也跟着换。

## 开工核对（读代码，和派活指令里的描述对照）

- 三处 `!account` 挡掉绑定、`auth.ticket` 在账号连接上被拒、`generatedAudioUpload.ts` 签旧票据、进账号项目不解 Agent 绑定：都属实。
- 账号闸（`server/docservice/account-hosted.mjs` 的 `gate`）对内容库本来就放行：`instanceMessageAction` 把 `content.put` 归「写」、`content.list/get/watch` 归「读」，再问成员权限。所以第 2 条不需要改闸。
- 桌面外壳的账号桥路径白名单（`desktop/src-tauri/src/account_vault.rs`）本来就放行 `/hosted/shared/account/session`，「页面多取一份会话」不需要改外壳。
- 派活指令没提到、做的时候才撞上的两件事：
  - **接续不能带票据**。文档服务规定接续项旁边不能有鉴权项（`server/docservice/session.mjs` 的 `parseSessionItem`），带了握手回 400。所以卡片同步只在建新会话时出示票据。
  - **账号连接有寿命**。连接上每条消息都过闸，闸拿建连时那张票据背后的访问令牌去问账号服务；令牌 120 秒到期后，这条连接还开着，但每条消息都回 `credential-revoked`（再晚是 `authorization-expired`），续令牌也救不回这条连接。实验（真服务）：建连 100 秒时读写正常，130 秒、145 秒读写都被拒。「票据到期要续」因此不是「接续时带新票据」，而是「到期前换一个会话」。

## 做了什么

### 1、2、3 卡片源码同步

路：照建议的走，页面凭自己的登录向 `/hosted/shared/account/session` 另取一份会话，把其中的连接票据交给编辑器进程。角色仍是 page，没有新角色，没有放宽「不许自报角色」，`account-hosted.mjs` 一行没动。

- `server/account-card-link.mjs`（新）：账号项目用的端点 `accountCardEndpoint`。只在建新会话时出示票据；按票据的到期时刻提前 8 秒结束这个会话、凭新票据建下一个；万一没赶上，收到 `credential-revoked` / `authorization-expired` 的回包也当场换。换的那一下对同步规则来说就是一次断线重连：在途的上传留在待上传里，新会话建成后重新订阅、重新对账。`cardSyncConnect` 按绑定选端点：账号项目用它，本机项目和旧共享项目与原来的缺省端点一模一样。
- `server/vite-plugin-cards.ts`：`/api/cards/sync/bind` 多认一种 `mode: 'account'`；页面交回票据时可以带 `expiresAt`；`createCardSync` 的 `connect` 换成 `cardSyncConnect`。
- `src/editor/sync/accountCardSync.ts`（新）：页面答票据请求。已经不在这个项目里（换了项目、换了账号）就不取并解绑；会话接口回 401 / 403 / 404 解绑；断网、503 只抛，编辑器进程退避后再要。
- `src/editor/sync/cardSync.ts`：绑定多一个 `account` 标记；票据可以带到期时刻。
- `src/editor/sync/syncManager.ts`：见下面「改了哪几行」。
- `server/card-sync.mjs`、`server/render-node/session-link.mjs` 没动（都在不许碰的那一带）：换会话是在它们外面包了一层端点做的。

停：服务端在退出登录、被踢、项目被删时会把这个登录或这个项目的连接全关掉（原有行为）；之后编辑器进程建新会话要票据，页面取不到，解绑，编辑器进程回本机空间，不再重试。页面自己判出失效（`enterAccountProject` 的 `fail`）时也直接解绑。

### 4 卡片声音上传

`src/editor/io/generatedAudioUpload.ts`：账号项目里写票据改用 `remoteAssetTicketInfo`（进项目时已经接好的那套，401 时强制换一张），不再发 `auth.ticket`；请求带 `credentials: 'omit'`（素材服务见到网站 Cookie 就拒）；上传途中换了账号项目也取消。`src/editor/media/assetTiers.ts` 加了一个只读的 `remoteAccountProjectId()`。旧共享项目和本机项目的路没变。这个改动对在线页面同样生效。

### 5 Agent 一侧旧绑定

`src/editor/sync/agentSideBinding.ts`（新）：原来写在 `syncManager.ts` 里的 `bindAgentSide` 原样搬出来，加 `releaseAgentSide`。进账号项目时不管页面记不记得绑过都发解绑（服务端的绑定是编辑器进程里的状态，页面整页重载后自己不记得）；绑与解排同一条队，解绑不会被一条还在路上的旧绑定盖回去。账号项目里本机 Agent 仍走「页面代做」，正式绑定没做。

### `syncManager.ts` 改了哪几行（对 `5c286289`）

| 位置（新文件行号） | 改动 |
|---|---|
| 34～35 | 引入 `accountCardTicket`、`bindAgentSide`、`releaseAgentSide` |
| 486（原 484～511） | `bindAgentSide` 连同它的两个变量搬到 `agentSideBinding.ts`，这里只留一行注释 |
| 624～625 | `bind()` 末尾：账号项目且是桌面版时调 `bindAccountEditorSide` |
| 629～646 | 新函数 `bindAccountEditorSide`（解 Agent 绑定、凭账号票据绑卡片同步） |
| 660～662（原 665～667） | `detach()`：账号项目离开时也解卡片同步；Agent 解绑改调 `releaseAgentSide` |
| 1144～1145 | `enterAccountProject` 的 `fail`：登录失效、被踢时解卡片同步 |

`bind()` 里原来那段 `if (!account && …) { … }`（含渲染节点三行）一个字没动。

## 验证结果

### 真服务测试 `server/test/account-card-sync.test.mjs`

真的账号服务、文档服务、独立的素材服务进程（`fixtures/account-dual-user-path.mjs`，两个账号），两边各起一份编辑器进程里的那套同步（规则是真的 `card-sync.mjs`，端点选择是 `vite-plugin-cards.ts` 用的同一个，文件用内存替身）。命令 `npm test -- server/test/account-card-sync.test.mjs`，退出码 0，1 条用例 13 步全过（131 秒，其中 109 秒是等访问令牌真的到期）：

```
1 甲上传 rev 1,乙装上
2 甲改成 v2,乙装上 rev 2,写入身份是甲的账号、角色 page
3 直接写进内容库的卡,甲、乙都装上
4 auth.ticket、service.watch 在账号连接上回 forbidden
5 只读成员:读可以,写回 not-listed,内容库停在 rev 2;改回可写后补传成 rev 3
6 别的项目:会话 403 not-listed,点名别的项目写回 project-mismatch,那个项目内容库为空
7 传输断一次:接续 +1、会话数不变、没有再取票据,之后照常同步
7b 按票据到期换会话 2 次(取票据 3 次),换过之后收发照常
7c 访问令牌到期后:没按时换的连接被闸拒(authorization-expired)并当场换会话补传;按时换的连接换了 1 次、没被拒过
8 乙被踢:连接被关,取票据回 403 banned(1 次都被拒),甲的 v5 乙没拿到
9 项目被删:连接被关,取票据回 {"status":404,"code":"no-project"}
10 甲退出登录:连接被关,取票据回 {"status":401,"code":"credential-revoked"},旧票据握手被拒
```

### 单元测试

- `server/test/account-card-link.test.mjs`：7 条（端点：只在建新会话时出示票据、按到期换、被拒当场换、关闭后不再换、端点选择）。
- `src/editor/sync/accountCardSync.test.mjs`：6 条。其中 **ASB-01 是复现原问题的那条**：服务端还绑着上一个本机项目、页面是一份全新的模块状态（等于整页重载过），进账号项目必须发解绑；ASB-02：绑定还在路上时解绑不会被盖回去。
- `src/editor/io/generatedAudioUpload.test.mjs`：原有 2 条照过，新增 2 条（账号项目用账号素材票据、不发 `auth.ticket`、401 强制换、不带 Cookie、票据不进地址；途中换项目取消）。

### 端到端探针 `scripts/probes/account-card-sync-probe.mjs`

同一套真服务，外加两个桌面编辑器进程（本工作区起的开发服务器，端口 28640、28645，各带 `PROMPTCUT_NO_PORT_FILE=1`、各自的卡片改动层与数据目录）和一个在线页面（在线构建，无头浏览器）。命令 `node scripts/probes/account-card-sync-probe.mjs --dist out/v18-cardsync/dist-online`，退出码 0，47 项核对全过，`fails: []`。

**探针里不是真的两处**（如实写）：没有真的桌面外壳，页面不点登录表单，直接调 `createAccountClient` 与 `enterAccountProject`；外壳的账号桥由探针在 Node 一侧照它的接口和路径白名单代答。在线页面走的是真的登录表单和「凭链接加入」。

关键结果：

| 验收项 | 结果 |
|---|---|
| 甲用一张用户卡 → 乙的桌面拿到源码、舞台画出来 | 卡只在甲的改动层里（仓库底版没有）；乙的改动层 1.4 秒装上，注册表认得，舞台画出 `…-V1`。图 `1-a-desktop-v1.png`、`2-b-desktop-v1.png` |
| 在线页面也画得出来 | **现状画不出来**：源码拿到了，舞台票据交接被拒（400），执行闸门 `grant-failed`；探针的舞台源放宽后画出 v1。图 `2-c-online-as-is.png`、`2-c-online-v1.png` |
| 甲改卡 → 乙热更新 | 乙的改动层 202 毫秒换成 v2，页面 243 毫秒热更新，舞台画出 `…-V2`，没有整页刷新，仍在项目里；乙记下「rev 2 是甲写的、角色 page」。在线页面（放宽后）也换成 v2。图 `3-b-desktop-v2.png`、`3-c-online-v2.png` |
| 模拟云端 Agent 写一张卡 → 两个桌面都拿得到 | 甲、乙的改动层都装上，两个页面注册表认得，乙的舞台画出来。图 `4-b-desktop-agent-card.png` |
| 只读成员上传被拒 | 乙改卡后上传回 `not-listed`（先撞上一次权限变化引起的断线），内容库仍是甲的版本；改回可写后补传，甲装上乙的 v3 |
| 乙被踢后同步停 | 乙的编辑器进程回本机空间、没再连回项目；乙再取会话回 403 banned；甲之后的 v4 乙拿不到；乙的页面弹出被踢的提示。图 `7-b-desktop-kicked.png` |
| 甲退出登录后连接失效 | 编辑器进程的同步连接被关、回本机空间；再取会话回 401；退出前取的没过期票据用不了。图 `8-a-desktop-logged-out.png` |
| 卡片声音 | 甲生成并上传成功（768,044 字节）；乙凭自己的素材票据取到，哈希相同，解码出 2 秒、48 kHz、峰值 0.207 的音频 |
| 旧绑定残留 | 甲进账号项目前 `/api/agent/status` 是 `bound: true, mode: local`，进之后 `bound: false` |
| 连接寿命 | 甲登录 150 秒之后改卡，乙照常装上；两边的同步连接各按到期换过一次会话（`ticket-expiring`），没被闸拒过 |

九张图我都看过：桌面的几张舞台上是对应版本的记号（V1、V2、被踢时的 V3、退出登录时的 V4），在线的 `2-c-online-v1.png`、`3-c-online-v2.png` 舞台上分别是 V1、V2；`2-c-online-as-is.png` 是现状下的测量遮罩（见「没做成的」）。数字取自最后一次整跑。

### 基线

- `npx tsc -b --force`：退出码 0，零错误。
- `npm test`（设了那两个环境变量）：退出码 0，6190 条里 6182 通过、0 失败、8 跳过（跳过的是原有的），一遍过，没有遇到偶发名单里的失败，没有重跑。
- windows-hide 守门测试（`server/test/windows-hide-silent-spawn.test.mjs`）在全量里通过，探针起子进程都带 `windowsHide: true`。
- 现有的卡片同步测试（`card-sync.test.mjs`、`card-sync-session.test.mjs`、`c66-cards.test.mjs`、`renderNodeHandoff.test.mjs`）全过：旧共享项目与本机项目走的仍是原来的缺省端点。
- 探针前后各查过一次可见窗口（`Get-Process` 那条），都没有新冒出来的；收尾时 28640～28679 没有监听，没有命令行里带本工作区路径的 node / chrome 进程留下。

## 发现的三个现状问题（都不在这次清单里，没改，要主会话决定）

1. **账号项目里，页面自己那条连接进项目约两分钟后写不进云端。** 和上面「账号连接有寿命」是同一个原因，但页面的连接没有换会话这一步。探针实测：甲登录 161 秒后在页面里放一个片段，服务端的项目版本没动（10 → 10），乙看不到；甲的页面仍显示在线、未确认数是 0、片段还在本地、没有任何提示。裸连接实验同样：130 秒起读写都回 `credential-revoked`。用户看到的就是「改了半天，别人那边没有，自己也不知道」。我的探针因此把甲页面写项目的几步都排在登录后 100 秒内。
2. **账号项目里，在线页面不执行用户卡。** 编辑器页把素材票据交给舞台源那一步（`src/online/stagePolicy.mjs` 的 `TICKET_PATTERN`，线上 nginx 的 `nginx-site-promptcut-stages.conf` 第 17 行由它生成）只认旧票据的形状 `v1.<…>.<…>`；账号会话签发的素材票据是 43 个字符的随机串，交接回 400。结果：`cardExec` 是 `grant-failed`，用户卡显示「需要本地 PC 渲染辅助」。这和语义 `product/platforms.md`「在线浏览器执行经文档服务同步来的用户卡」对不上。要改的是那个正则加上 nginx 重新部署。
3. **页面的账号连接断一次传输后，接续会一直失败。** `enterAccountProject` 给接续也配了带票据的子协议，文档服务对「接续项旁边有鉴权项」回 400。这条是读代码加端点一级的实测（我的同步端点最初也这么写，日志里是连续的 `Unexpected server response: 400`，直到 60 秒保留期过完才重建会话），没有在页面上单独测。

另有两处小的、看到了没查：账号项目里提示气泡把写入者显示成 `account:acc_…@设备号`（成员名单在账号项目里是空的，`writerLabel` 对不上名字）；乙进项目时甲的页面弹过一次「你的近期修改已被 … 覆盖」。

## 没做成的及原因

- 在线页面画出用户卡：见上第 2 条，没改产品代码。
- `2-c-online-as-is.png`（现状）拍到的是「正在测量卡片」遮罩：现状下这个遮罩等了 60 秒没退，没查原因。
- 真的桌面外壳没参与验证；云端 Agent 是模拟的。
- 提交没有严格做到「每条一个提交」：第 1、2、5 条的代码在同一个提交里。

## 裁定〔裁〕

- 〔裁一〕接续不带票据。原因：文档服务的现有规定（带了回 400），不是我选的；接续时服务端按会话里的身份重新核对（`resumeGate`）。用户看不出区别，三级。
- 〔裁二〕账号连接到期前 8 秒换会话，而不是等被拒。8 秒是为了比页面续访问令牌的提前量（10 秒）小，这样要票据时页面已经续过令牌，拿到的是满寿命的票据。三级。
- 〔裁三〕换会话用「先关旧的再建新的」，中间有几百毫秒没有连接；期间的上传留在待上传里、别人的版本靠新会话的对账补上。没做「先建新的再关旧的」，因为要改 `card-sync.mjs`。三级。

## 对任务书或语义的更正建议

- 派活指令写「票据到期要续」。实际是「访问令牌到期后连接作废」，页面那条连接同样受影响，建议单列一项修。
- `docs/semantics/product/platforms.md`「在线浏览器执行经文档服务同步来的用户卡」在账号项目里目前不成立，建议在修好之前记进待办。
- `docs/reports/AGENT-018-prep.md` 没有这三个现状问题的记录。

## 要主会话注意

- 我的分支上有一次改写：最初一轮探针的截图里有「选择 AI 助手的驱动方式」对话框，上面显示了本机某个配置项的后四位（带掩码）。那几张图进过提交 `67101c36`，我用 `--amend` 换成了干净的图（现在是 `bffc6dcc`），旧提交只剩在这个仓库的 reflog 里，没有推送过。要不要清 reflog 由主会话定。探针现在截图前会关掉这个对话框，关不掉就不截。
- 探针和测试用的端口：探针 28640～28658，测试 28670～28676。
- `out/v18-cardsync/` 下是在线构建和日志（已被忽略，不入库）。
