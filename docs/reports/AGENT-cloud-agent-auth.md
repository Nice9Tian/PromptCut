# 子 Agent 报告：云端 Agent 的身份与隔离（文档服务与素材服务一侧）

分支 `claude/cloud-agent-auth`，起点 `abdbbff7`（第三段第 1 批 `7b7b1fd8` 加云端 Agent 契约）。任务书 `docs/plan/cloud-agent-task.md`，契约 `docs/plan/cloud-agent-contract.md` 第 4、5、7.2、16 节。这一块在任务分工里叫「乙块」。

状态：做完，待主会话审。**隔离验收（任务书完成条件第 4 条）全部通过，没有不过的项。**

本报告由两个子 Agent 先后写成：第一个做到 `33ad3cb1` 被中断，第二个接手复核并补完。

## 做了什么

### 接手时已有的（`3eb3aad9`～`33ad3cb1`，接手后逐个文件读过、单测与探针重跑过）

- `server/auth/delegation.mjs`（新）：委托票据与对话委托的签发、核对（`signDelegation`、`verifyDelegation`、`checkDelegation`）、成员权限 `memberAccess`、归属键 `ownerKeyOf`、日志用的摘要 `delegationDigest`。
- `server/docservice/modules/shared.mjs`：`auth.ticket { kind: 'delegate' }`；成员列表里代成员的连接归在成员行、连接项带 `service: 'agent'`；发布连接不列出；顶层 `hosted.agent.url`；改名单不再关以服务自己身份进来的连接。
- `server/docservice/modules/hosted.mjs`：`hosted.delegate.verify`；`hosted.ticket` 的对话委托分支与 `purpose: 'publish'` 分支。
- `server/docservice/service-gate.mjs`：`SERVICE_ALLOW.agent`、`SERVICE_PUBLISH_ALLOW.agent`、只读拒写、发布连接只许带片段清单的计划。
- `server/auth/handshake.mjs`、`tickets.mjs`、`protocol.mjs`、`asset-tickets.mjs`、`server/docservice/service.mjs`、`shared-service.mjs`、`modules/actor.mjs`、`modules/project.mjs`：连接票据的 `acc`、`pu` 字段，principal 的 `access`、`purpose`，写入身份的 `service`，逐消息与接续前按名单、禁入表、此刻的只读再看一次。
- `server/auth/service-client.mjs`（新）：服务一侧的客户端小模块。
- `server/test/cloud-agent-auth.test.mjs`（20 条）、`scripts/probes/cloud-agent-auth-probe.mjs`（P1～P15）、`docs/plan/auth-contract.md` 第 17 节。
- 第 1 批的三份 `hosted-render-*` 单测随分发点填上而改了断言（`unsupported` → `forbidden`；白名单「全拒」→「表外全拒」）。

### 接手后补的（``12108cd4``）

- **Agent 服务对外地址的配置入口没接**：`createSharedDocService` 认 `hostedServiceUrls`，但托管组合没人传。补上 `server/hosted/main.mjs` 读 `PROMPTCUT_AGENT_PUBLIC_URL`（契约 10.4 节定的名字；设了却不是 http(s) 地址时失败即关，`config.error agent-public-url`）、`server/hosted/combo.mjs` 的 `agentPublicUrl` 选项。单测 CA-URL-02，探针 P17（真的托管组合进程读环境变量，成员列表里拿到）。
- **探针缺「离线后继续有效」一条**：加 P16——项目一的成员页面连接全部断开、他原有的 Agent 连接也关掉之后，凭手里那张对话委托换票据、连上、提交编辑；断言版本号加一、广播里的署名是这位成员加 `service: 'agent'`、成员列表里归在他那一行。
- **一处偶发失败**：`auth-kit.mjs` 的 `flipSignature` 改的是签名的最后一个字符；32 字节签名的最后一个字符只有 16 种合规取值，原来恰好是 `A` 时改成的 `B` 不合规，文档服务回的原因是 `format` 而不是 `signature`。断言原因码的两条单测（CA-AUTH-03、CA-CLIENT-01）与探针 P6 因此有十六分之一的机会失败（接手后第二次跑就撞上了）。单测与探针各自改用「改签名段第一个字符」；`auth-kit.mjs` 没动（别的用例只断言 401，不受影响）。
- `hosted.delegate.ok` 多带一个 `access`（与 `acc` 同值），与 `hosted.ticket.ok` 的字段名对齐，Agent 服务一侧接线不用换名。
- `auth-contract.md` 第 17 节补 17.7（地址下发）与编号。

## 给 Agent 服务一侧接线用的确切形状

成员的页面连接上（`scope: 'member'`、`role: 'page'` 才要得到）：

```
auth.ticket { kind: 'delegate', audience: 'agent' }                          → 委托票据（2 分钟）
auth.ticket { kind: 'delegate', audience: 'agent', conversation: <对话 id> }  → 对话委托（60 分钟）
  → auth.ticket.ok { ticket, exp }
  → error { reason: 'service-disabled' | 'forbidden' | 'bad-message' }
```

负载（`v1.<base64url(JSON)>.<base64url(HMAC-SHA256(项目的 ticketKey, "v1." + 负载段))>`）：`{ kid, k: 'dlg', p, u, aud: 'agent', acc: 'rw' | 'r', g, ug, exp, iat, dn?, cr?: true }`，对话委托另有 `cid: <对话 id>`、`run: true`。

Agent 服务的控制连接上：

```
hosted.delegate.verify { delegation }
  → hosted.delegate.ok { projectId, userId, username, deviceId, deviceName, creator, mode, acc, access, exp, ownerKey, grant, conversationId? }
  → error { reason }

hosted.ticket { projectId, conversation: <对话号，正整数>, conversationId: <对话 id>, delegation: <对话委托> }
  → hosted.ticket.ok { ticket, exp, userId, username, access, ownerKey, conversation, conversationId }
  → error { reason }

hosted.ticket { projectId, purpose: 'publish' }
  → hosted.ticket.ok { ticket, exp }
```

- `reason`：`format`、`signature`、`expired`、`generation`、`audience`、`no-project`、`relocating` / `relocated`、`service-disabled`、`service-revoked`、`banned`、`not-listed`；`hosted.ticket` 另有 `not-grant`、`project`、`conversation`、`forbidden`、`bad-message`。
- `ownerKey`：以创建者身份进入的 `creator`；限定进入的名单成员 `user:<用户名>`；自由进入的成员 `device:<userId>`。键里不含项目。
- 连接票据（2 分钟，握手用 `promptcut.ticket.<票据>`）：代成员的 `{ kid, k: 'conn', p, u: <成员 userId>, r: 'agent', c: <对话号>, sv: 'agent', sk, acc, dn?, cr?, g, ug, exp, iat }`；发布用的 `{ …, u: 'service:agent@<instanceId>', r: 'agent', sv, sk, pu: 'publish' }`。
- 握手得到的 principal：代成员的是成员的（`scope: 'member'`）加 `service: 'agent'`、`serviceKid`、`access`；写入身份 `{ userId, deviceId, role: 'agent', conversation, session, service: 'agent' }`。

`SERVICE_ALLOW.agent`（代成员的连接，十种）：`project.open`、`project.close`、`project.op`、`project.upload`、`events.create`、`events.complete`、`events.text`、`presence.set`、`presence.clear`、`presence.list`。`access` 不是 `rw` 的另拒 `project.op`、`project.upload`。

`SERVICE_PUBLISH_ALLOW.agent`（发布连接，三种）：`publisher.hello`、`task.publish`（每个任务都必须是 `kind: 'plan'`、结果键带 `#clips:` 或 `#backfill:`、`input.clips` 非空）、`task.unsubscribe`。

控制连接：`hosted.watch`、`hosted.ticket`、`hosted.demand`、`hosted.delegate.verify`。

客户端小模块 `server/auth/service-client.mjs`：

```js
createServiceClient({ base, key?, keyFile?, WebSocketImpl?, fetch?, log?, requestTimeoutMs?, connectTimeoutMs?, reconnectMs?, autoReconnect? })
  .service / .instanceId / .connected
  .ready(): Promise<void>
  .onState(fn('up' | 'down', { code?, reason? })): () => void
  .watch({ onProjects?, onProject? }): Promise<{ ok: true, projects } | { ok: false, reason }>
  .verifyDelegation(delegation): Promise<{ ok: true, …hosted.delegate.ok 的字段 } | { ok: false, reason }>
  .memberTicket({ projectId, conversation, conversationId, delegation }): Promise<{ ok: true, ticket, exp, userId, username, access, ownerKey, conversation, conversationId } | { ok: false, reason }>
  .publishTicket(projectId): Promise<{ ok: true, ticket, exp } | { ok: false, reason }>
  .serviceTicket(projectId)            // actsFor: 'self' 的服务用
  .demand(projectId, holdMs?)
  .dataProtocols(ticket): string[]      // 同导出的 ticketProtocols
  .protocolsForConversation({ projectId, conversationId, delegation: string | (() => string) }): (conversation: number) => Promise<string[]>
  .close()
```

控制连接断开期间的请求立刻回 `{ ok: false, reason: 'unavailable' }`，不排队；超时回 `timeout`。

## 验证结果

- `npx tsc -b --force`：退出码 0。
- `npm test`：退出码 0，4477 项、4476 通过、0 失败、1 跳过（第 1 批后是 4456 / 4455 / 1，多出的 21 项是 `cloud-agent-auth.test.mjs`）。这是第二遍的结果；第一遍有 1 项失败——`artifact-push.test.mjs` 的 W4（推到一半停下再续推，带时间的用例，本分支没有碰过这份文件与它测的代码），当时机器上同时有多个子 Agent 在跑；单独重跑两遍都是 7 / 0，全量重跑零失败。
- `node scripts/test-suite.mjs server/test/cloud-agent-auth.test.mjs`：21 项、21 通过、0 失败（改完偶发那一处后连跑三遍都是 21 / 0）。
- 隔离探针 `node scripts/probes/cloud-agent-auth-probe.mjs`：退出码 0，18 条全过（P1～P17 加 P10b）。

单测逐条：CA-AUTH-01（AU16）、CA-AUTH-02（AU17）、CA-AUTH-03（AU18）、CA-AUTH-04（AU19）、CA-AUTH-05、CA-AUTH-06、CA-GRANT-01、CA-GRANT-02 / CA-SIGN-01、CA-REVOKE-01（AU20）、CA-REVOKE-02a、02b、02c、CA-REVOKE-03、CA-RENDER-04、CA-OWNER-01、CA-URL-01、CA-URL-02、CA-ASSET-01（AU21）、CA-LOG-01、CA-CLIENT-01、CA-CLIENT-02。

撤销到 Agent 的连接被关的实测时延（本机）：

| 触发 | 单测（进程内） | 探针（真进程，含取挑战与派生创建者证明） | 关闭码 |
|---|---|---|---|
| 创建者关云端 Agent 开关 | 2.7 ms | 19.2 ms | 4003 `service-disabled` |
| 成员被移出名单 | 2.3 ms | 17.0 ms | 4003 `removed` |
| 成员被踢 | 2.1 ms | 17.4 ms | 4003 `kicked` |
| 项目删除 | 1.4 ms | 16.4 ms | 4004 `deleted` |

探针 P10 里对话正在连续写入：关开关前落地 10 次，最后一次成功写入在连接被关前 18.6 ms，关闭后半秒版本号不变。

## 没做成的及原因

没有没做成的项。下面三处是照契约办、与任务消息字面不同的：

1. **素材票据**：任务消息第 3、7 条写「素材票据的只读」。契约 4.4 节写的是第一版 Agent 服务不取素材票据、`auth.ticket` 任何种类都拒。按契约办：云端 Agent 的两种连接都要不到素材票据。素材服务一侧把「`sv` 且 `actsFor: 'member'` 的素材票据只认只读、名单与禁入表照成员查、开关与登记表当场看」先钉死了（CA-ASSET-01 用直接签出来的票据测），以后放开签发时这条已经成立。
2. **`task.withdraw`**：契约 16.3 节 R2 的发布连接白名单里有它，队列现在没有这种消息（撤订是 `task.unsubscribe`，已放）。第三段若加 `task.withdraw`，在 `SERVICE_PUBLISH_ALLOW.agent` 里加一项即可。
3. **`hosted.ticket` 多一个 `conversationId`**：契约 4.3 节③只写了 `conversation`（对话号）。核对对话委托的 `cid` 需要对话 id，两样是两回事，所以两个都要给。已写进 `auth-contract.md` 17.2。

## 与契约不一致的地方、更正建议

- **关开关再开回来，没过期的旧对话委托又能用**（探针 P10b 断言的就是这个）。委托是无状态的票据，撤销靠开关本身；契约 4.2 节的核对清单也是这样写的。关着的时候核验、换票据、握手、接续都拒，所以「关掉后立刻失效」成立。若想要「关过一次就永久作废」，办法是开关记录里加一个计数、写进委托负载，改动很小；这会多一个负载字段，没有自行加。
- **改名单会让本项目全部成员手里的对话委托作废**（项目代数加一，现有票据也是这个规矩）。留在名单里的成员的 Agent 连接不断，但这一轮里连接若断了就换不出新票据，要等成员下一句带新的对话委托。改口令同理。契约 4.5 节的表只写了改口令这一行，建议把改名单对留下的成员的影响也写上。
- `set-list` 不再关以服务自己身份进来的连接（渲染服务、发布连接）：第 1 批的实现会把它们一并以 4003 `removed` 关掉，第一个子 Agent 改了（`shared.mjs` 里一处判断加了 `p.scope !== 'service'`），已写进 `auth-contract.md` 17.4 并标〔裁〕。这一处碰到了渲染服务的行为，请第三段第 2 批知道。
- 只读成员：照契约 4.6 节，机制做全（项目记录的可选字段 `readonly: [用户名]`），没有设置它的界面与创建者操作；探针停进程直接写项目记录造出来。

## 改动若碰到任务书没列的用户可见行为

没有。新增的环境变量 `PROMPTCUT_AGENT_PUBLIC_URL` 不设时行为与之前相同（成员列表里没有 `hosted.agent.url`，页面不出「云端」一项）。部署模板里要加这一个变量，归 `claude/render-service-ops` 或主会话。
