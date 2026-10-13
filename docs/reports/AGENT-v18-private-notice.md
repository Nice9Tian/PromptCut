# AGENT-v18-private-notice：共有对话被设为私有时，别的成员正开着的页面当场提示并停止读

分支 `claude/v18-private-notice`，起点 main `ca8ded81`。端口段 28850～28889（实际用 28850～28861）。

几个词：**围栏**是文档服务通知 Agent 服务"这些读取马上关掉"的机制（`server/account/agent-read-control.mjs` 的 `fenceInState`，种类有 credential/member/private/stop/delete/agent-disabled 等）：Agent 服务一收到就把对应那条 HTTP 读取的输出锁死并立刻掐掉连接（`conversation-transports.mjs` 的 `revoke`），掐之前来不及再写任何字节。**事件流**是页面读一个对话的 `GET /agent/v1/conversations/<id>/events`。**边缘代理**是探针夹具里站在浏览器前面的反向代理。

## 先更正我上一份报告里的一处

上一份（`AGENT-v18-newchat.md`）写"创建者设私有后成员页面不会断也不会提示，原因是 `http.mjs` 轮询里权限变了就静默 `return`"。这个判断有两处不对：
1. 轮询里那几个 `return` 只是"这一轮跳过"（轮询每 250 毫秒跑一次，下一轮照常），不是卡住；真正拒绝时文档服务是抛错，走的是 `catch`。
2. 我当时看到的"一直在线、20 秒内没动静"是**探针夹具的边缘代理不忠实**造成的：夹具里 `cloud-queue-user-path.mjs` 的代理用 `response.pipe(res)`，上游被围栏掐断后下游那条连接永远不收尾，页面只能等 45 秒的"一直没有字节"判定。生产的反向代理会把断掉的连接转给浏览器。我已把这个夹具改成和 `conversation-controls` 那份夹具一样用 `pipeHttpProxyResponse`（上游中途断了就把下游也关掉）。改了以后"改前"看到的才是真实情况：围栏掐流 → 页面清空正文 → 重连 → 404 → **一直显示「正在重新连接」、永远不告诉用户没权限**（改前 E2：20 秒里横幅 20/20、重试 4 次、正文被清空）。

## 「权限变了」在轮询里到底有几种来历

先说明两条路：(a) **围栏路**：设为私有、被踢、退出登录、Agent 被关这类，文档服务会发围栏，Agent 服务掐掉那条流，写不出任何事件；页面看到流断了，重连时事件流请求会被文档服务拒绝（见下表"重连时得到"）。(b) **轮询路**：轮询正好在围栏到达之前读到了拒绝（`service.conversation` 或 `service.access` 抛错），或没有围栏的拒绝；这时服务端还能写事件。

| 来历 | 文档服务的回应（出处） | 围栏 | 重连时得到 | 该怎么对页面说 | 现在的处理 |
|---|---|---|---|---|---|
| 创建者把共有对话设为私有（对非主人、非创建者的成员） | 404 `no-conversation`（`conversation-authority.mjs` 第 38 行） | private | 404 `no-conversation` | 当场「已无法读取」，停止读 | 轮询路：写 `access.revoked`、关流；围栏路：页面读到过它又遇到 404 `no-conversation` → 清正文、显示那一句、停止读 |
| 对话被删除 | 同上（主线上删除接口还是 503 `deletion-pending`，`claude/v18-chats` 合入后走这条） | delete | 同上 | 同上 | 同上（同一条路径，不用再改） |
| 成员被踢出项目 | 403 `banned` / `not-listed` | member | 403（同左） | 当场「已无法读取」，停止读 | 轮询路：写事件、关流；重连 403：原来显示的是裸错误码（`not-listed`），现在显示那一句 |
| 账号退出登录、改密退出 | 401 `credential-revoked` / `principal-mismatch` | credential | 401 | 身份句子「身份验证没有通过……」，停止读 | 轮询路：写事件、关流；重连 401：原有的身份句子并停止读（本来就是） |
| Agent 被创建者关掉 | 403 `agent-disabled` | agent-disabled | 403 | 「项目创建者已关闭云端 Agent。」，停止读 | 轮询路：写事件；重连 403：原来显示裸错误码，现在用这句已有的句子 |
| 项目被删 | 404 `no-project` | service-revoked 等 | 404 `no-project` | 「已无法读取」，停止读 | 读到过之后遇到 → 那一句、停止读（新增，本来会一直重连）；没读到过就 404 仍按故障重连 |
| 文档服务一时连不上、超时、读取通道正被围栏关 | 503（`conversation-client-unavailable`、`read-control-unavailable`、`read-transport-revoked` 等；没有状态码的网络错误也算） | — | 502/503/网络错误 | **不是没权限**，页面照常重连 | **改前轮询的 `catch` 对任何错误都写 `access.revoked` 再关流，暂时故障会被说成没权限且页面再也不读；现在只有 401/403/404 才写事件，其余只关流，页面照常重连** |
| 轮询里读到的 ACL 版本比刚读到的新（`aclRevision` 不一致） | 不是错误 | — | — | 不用说，下一轮重新读 | 保持现状（那些 `return` 是跳过一轮，不是静默失败） |

判定"明确拒绝"的依据是状态码 401/403/404：这是文档服务按账号核对后的权威答复（`conversation-client.mjs` 只把 400/401/403/404/409/413 原样往上传，其余全部变成 503）。

## 做了什么

- `server/agent-service/http.mjs`（+10/−2）：`accountEvents` 的轮询 `catch` 只对 `DENIAL_STATUS = {401,403,404}` 写 `access.revoked`，其余错误只关流；新增常量 `DENIAL_STATUS` 和注释。没动读取通道（`conversation-transports.mjs`）。
- `src/ai/cloud/session.ts`（约 +25/−6）：
  - 新增常量 `REVOKED_TEXT`（就是原来写在两处的那句，抽成一处，用词一字未改）和 `deniedText`：账号模式下 403 `not-listed`/`banned` → 这一句，403 `agent-disabled` → 已有的 `cloudErrorText("disabled")`，其余原样。**没有新增任何给用户看的文字。**
  - 新增 `seenLive`（这次打开后读到过它的事件，不含"发消息被收下"）。账号模式下 `seenLive` 且遇到 404 `no-conversation`/`no-project` → 清正文、显示 `REVOKED_TEXT`、连接 idle、停止读。没读到过的 404 保持原样（E3、新对话、刚发完消息读不到都不受影响）。
- 测试夹具 `server/test/fixtures/cloud-queue-user-path.mjs`（+7/−2）：边缘代理改用 `pipeHttpProxyResponse`（见上）。
- 探针 `scripts/probes/newchat-events-probe.mjs`：E2 加"从创建者点下设为私有起算到提示出现的毫秒数"、创建者页面状态与截图；新增 E4（成员自己的别的对话）。
- 新增测试：`server/test/agent-events-denial.test.mjs`（服务端轮询各来历）、`src/ai/cloud/private-revoked.test.mjs`（页面状态机）；`src/ai/cloud/newchat-absent.test.mjs` 的 NEWCHAT-4 按新规则改了账号模式那一半（原来断言"读到过再 404 就一直重连"，那正是这次要改掉的行为；本机模式那一半不变）。

## 改前改后（同一支探针，改前用 main `ca8ded81` 加同一个夹具修正构建，改后用本分支构建；完整跑，E2 看 20 秒）

| 场景 | 改前 | 改后 |
|---|---|---|
| E2 成员正看着，创建者设为私有 | 事件流重连 404×4，横幅「和云端 Agent 的连接断了,正在重新连接……」20/20 次采样，连接 reconnecting，正文被清空，**没有任何提示** | **点下后 559 毫秒**页面出现「当前账号已无法读取这个对话，请重新选择有权限的对话。」，连接 idle，无横幅，之后 20 秒内 0 次请求，正文清掉 |
| 创建者自己的页面（同一时刻） | live，1 条用户消息 1 条回复 | 同（live，内容在） |
| E4 成员自己的别的（新）对话 | 404×1，安静 | 同 |
| E3 成员刷新后落在已变私有的对话上 | 404×7，横幅 15/15 | 同（见下「要用户定的事」） |
| F1 Agent 服务停掉，正看着的对话 | 502×10，横幅 54/55（夹具修正后立刻断，不再等 45 秒） | 同 |
| F2 Agent 服务停掉时新开对话 | 502×6，横幅 14/15，另弹「云端 Agent 暂时连不上文档服务,请稍后再试。」 | 同 |
| A、B、D1～D6、E0、E1 新对话与正常读 | 新对话安静，正常对话 live | 同（逐条一致，见两份 JSON） |

结果与截图：`docs/reports/assets/v18-private-notice/`（`probe-result-before.json`、`probe-result-after.json`；`before/after-E2-member-after-creator-set-private-end.png`、`after-E2-creator-page-after-private.png`、E3、E4、F1、F2 等）。我看过：改前成员页上方是重连横幅、正文空；改后是空对话加那一句提示；创建者页面正常。

## 验证

- 服务端 `server/test/agent-events-denial.test.mjs` 8 条：401/403/404 各写 `access.revoked` 再关流；503、502、500、无状态的网络错误都只关流不写事件；正常时先发队列快照、不写事件、流保持打开。红的时候（把 `http.mjs` 改回 main）：4 条"暂时故障"失败（写了不该写的事件），其余本来就过。
- 页面 `src/ai/cloud/private-revoked.test.mjs` 10 条：设为私有/删除（流被关或被掐后重连 404 → 清正文、那一句、只重连一次、不再请求）、被踢（`not-listed`、`banned`）、Agent 被关、退出登录 401、项目被删、暂时故障（连不上、502、503）照常重连且不出现那一句、流里直接来的 `access.revoked`、没读到过的 404 不算撤销、本机模式不走这条、撤销后换对话照常。`newchat-absent.test.mjs`（15 条）和原有 `account-read-revocation.test.mjs`、`account-queue.test.mjs` 保持绿。
- `npx tsc -b --force`：退出码 0，无输出。
- 全量 `npm test`：见下。

## 要用户定的事

1. **刷新后落在已变私有的对话上，一直重连（E3，改前改后相同，按派活要求没动）。** 背景：成员被当场告知"已无法读取"后，如果刷新页面，页面记着那个对话 id，重新打开时只收到 404 `no-conversation`，既可能是"对话还没发过消息"，也可能是"被设为私有/删了"，页面分不出，现在按"可能是网络问题"一直显示重连横幅。选项：(a) 保持现状；(b) 页面把"已被告知无法读取"的对话 id 记在浏览器里，刷新后直接显示那一句、不再重连（不动服务端，只加一个 localStorage 记号，代价是对话后来又改回共有时要点一下别的对话再点回来才会重新读）；(c) 服务端对"存在但你没权限"另给一个错误码（会让任何持有对话 id 的成员能探测它存在，和现在"不区分不存在与没权限"的有意设计冲突）。我的建议：(b)。
2. **被撤销后空对话上输入框还在**：用户可以继续打字发送，发送会得到文档服务的拒绝并显示拒绝的话。语义里没写这时输入框是否禁用，也没写要不要自动换到新对话，我没定，代码保持现状（清正文、显示那一句、停止读）。
3. **旧内容怎么办（派活第 2 点）**：`product/agent.md`、`workflow/production.md`、`mechanism/agent.md` 都写"共有切成私有后，别的成员立刻看不到它""读接口与历史订阅立刻被拒"，所以页面清掉正文与语义一致，我没改。"已读消息保留原文及发送者"（`product/agent.md` 第 14 条）说的是改密/被踢后服务端存档与已读任务的处理，不是页面是否继续显示，因此不适用于这里。
4. 对话被删除这条路径主线上还没有（删除接口 503 `deletion-pending`，要等 `claude/v18-chats` 合入）；合入后它应走和设为私有同一条 404 路径，没有另外的页面改动。我没法在这里实测，只有单测覆盖。

## 没做成的 / 要注意

- 只实测了"设为私有"的浏览器路径；被踢、退出登录、Agent 被关、项目被删在浏览器里没跑（需要成员管理、改密这些界面），靠服务端和页面两层单测覆盖，状态码按 `conversation-authority.mjs`、`agent-read-control.mjs` 的代码核对。
- 另一个分支（工具表接线）也会动 `http.mjs`：我只动了 `accountEvents` 里 `catch` 一处和前面加的一个常量；`conversation-transports.mjs` 没碰。
- 别的项目不受影响：围栏按 `fence.projectId`、`conversationId` 筛读取（`agent-read-control.mjs` 第 220～221 行），页面按每次 `open` 重算状态；没有为它单做浏览器实测。

## 对任务书或语义的更正建议

- `docs/semantics/mechanism/agent.md`（三级）可补一句：围栏掐断的流写不出事件，页面靠"读到过的对话重连得到 404"识别撤销；暂时故障（503 一类）不说成没权限。
- 上一份 `AGENT-v18-newchat.md` 的"没做成"第一条按上面更正。

## 全量结果

命令 `npm test`（设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`）共跑了四遍，最后一遍零失败：

- 第一遍：6479 条，2 败（`cloud-tools-w1-restart.test.mjs` 的 W1-RESTART-01/02，`EADDRINUSE 127.0.0.1:28400`）。单独重跑该文件 2/2 过。
- 第二遍：33 败，全部是端口被占（`EADDRINUSE`，28221、28380、28390、28681 等别人的端口段，当时 28380 被一个不是我起的 node 进程占着，随后消失），外加几条 `accept-018-files-*`、`account-*` 单独重跑后全过（它们那时和上面一起被端口冲突与机器忙拖累）。把所有失败文件挑出来单独重跑：`cloud-tools-w1-browser/egress/restart` 31/31 过，其余过。
- 第三遍：1 败，`cloud-tools-p4-subject.test.mjs` 的 `subject_install`（断言「不要重复启动」，一个时序竞争）；单独重跑两次 29/29 过。
- 第四遍：6479 条，6461 过，0 败，0 取消，6 todo，退出码 0，「npm test 最终结果：零失败」。

结论：这四处失败都落在别的分支的测试（工具表接线那一块，端口段 28380～28400 和 `subject_install`），不是我的改动引起；它们在机器上同时有别的会话跑测试时会撞端口，建议主会话把 `cloud-tools-w1-*` 写死的端口（28380、28390、28400）改成系统分配，并把 `subject_install` 加进偶发名单。我没有改这些测试。

行尾：`git diff --stat main...HEAD` 看过，每个文件的增删行数都只是本任务的改动，没有整份被改（`session.ts` 25/5、`http.mjs` 10/2、夹具 7/2、探针 13/1，新增两个测试文件）。收工检查：端口 28850～28861 全部释放，无遗留 Chrome、探针、素材子进程。
