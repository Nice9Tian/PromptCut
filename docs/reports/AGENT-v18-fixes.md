# AGENT-v18-fixes：验收摸底查出的六处小修

分支 `claude/v18-fixes`，起点 main `c2059313`。问题编号取自 `docs/reports/ACCEPT-018-map.md` 第 1 节（「发现的产品问题」表）。
几个词：**todo 测试**是 node 测试运行器里 `test(..., { todo })`，断言现在不成立也不让 `npm test` 变红，修好后去掉 `{ todo }` 就成硬断言；**红**指在没改的代码上这条断言失败。

跑测试的写法（先设两个环境变量）：`PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE` 后 `npm test -- <文件>`。

## 逐条

### 第 6 条 .procp 读包不校验 CRC
- 改：`src/editor/io/procp.ts`。`readZip` 把中央目录里登记的 CRC32 读进条目；`inflate` 变成异步，解出字节后核长度与 CRC，对不上抛 `PROCP_DAMAGED_MESSAGE`（deflate 解压流自己报错也按包损坏）；`unpackProcp` 先把编排条目和所有素材条目逐条核完，再读编排、再向内容库落素材，所以有一条坏就整个包不读、不落任何素材（好的那几份也不落），`loadProcpFile` 抛错时不会走到 `loadProject`，当前项目不动。
- 测试：`server/test/accept-018-files-proc-damage.test.mjs` 的 `ACC018-DMG-7` 去掉 todo（并收紧成必须是这句报错）；新增 `ACC018-DMG-7b`（素材条目被改坏：整包不读、零次落库请求、当前项目与剧本对话不动、没改坏的同类包照常能读）。
- 红的时候：`Missing expected rejection (Error): 改坏的包应报错`，即改坏一个字节的包照常读出。
- 绿：该文件 11 过 / 0 败 / 2 todo（剩下 DMG-5、DMG-6 不归我）；`src/editor/io/procp.test.mjs`（原有 12 条，含别的 zip 工具压的 deflate 条目）全过。
- 报错那句话是界面文字，任务书和设计里没有原文，见「要用户定的事」。

### 第 7 条 草稿保存不原子
- 改：`server/vite-plugin-projects.ts` 新增 `writeFileAtomic`，草稿 PUT 用它：目标已存在且不可写先报错（不靠改名绕过只读）；同目录写 `<草稿>.<pid>-<随机>.tmp`、对临时文件 fsync、再 `renameSync` 盖上去；任何一步失败都把临时文件删掉再抛原错。
- 测试：`ACC018-DMG-11` 去掉 todo，加了「失败后目录里没有 .tmp」；新增 `ACC018-DMG-11b`（成功保存不留临时文件、内容是新的一份）。`ACC018-DMG-9`（只读报错、原草稿一字不动）仍绿。
- 红的时候：`Got unwanted exception: 中断之后草稿文件仍是完整可读的 JSON`（原草稿被截成半份）。
- 绿：该文件 11 过 / 0 败。

### 第 13 条 账号模式 `GET /agent/v1/usage` 回 503
- 改：`server/agent/service/conversation-policy.mjs` 的 `usage(identity, since)`：先过 `identity`（文档服务按账号核对是不是本项目成员，不是、被踢、没登录就抛错，不回数字），再用 `queryUsage` 读 `<数据目录>/usage/` 里本项目的流水，回 `{ project{tokens,calls,input,output}, members[{username,tokens,calls}], models[{model,tokens,calls}], services[…] }`，认 `?since=`；没挂用量目录（没有执行器）仍回 503 `usage-unavailable`，不编造零。`createAccountConversationService` 多一个可选参数 `usageDir`，`server/agent/service/account-runner.mjs` 用 `<dataDir>/usage` 传入；`server/agent-service/http.mjs` 的账号路由把 `since` 传下去。
- 〔裁〕谁能看什么：契约第 6.3 节写「成员用 `GET /v1/usage`（本项目的总量与各成员的量）；托管方用 `admin.mjs usage`（可跨项目）」，账号模式下「成员」按文档服务核对出的账号为准——项目成员（包含只读成员）能看本项目总量、各成员、各模型；非成员不回；只回自己项目的流水（别的项目的人和数不出现）；成员只给显示名，不给账号编号。契约没有分创建者/普通成员，我也没分。
- 测试（新）：`server/test/agent-account-usage.test.mjs` 4 条：成员看到本项目总量/成员/模型且不含别的项目与账号编号、`since` 生效、另一项目成员只看自己的；非成员被拒且响应里没有数字；没有记录回零；没挂目录回 503。
- 红的时候：在没改的三个文件上，成员请求回 503（`actual: 503, expected: 200`）。
- 绿：4 过 / 0 败。

### 第 14 条 不存在的对话的事件流断开连接
- 根因：`accountEvents` 先写 `200` 的流头再结束，而读通道（`server/agent/service/conversation-transports.mjs` 的 `begin`）在还没有任何一次读取被文档服务受理时，把 2xx 的写出当成越权，直接掐连接；404 等 ≥400 的状态才放行。所以注释里写的「200 加 end」这条路在这个入口上永远走不通。
- 改：`server/agent-service/http.mjs` 的 `accountEvents` 只动开头那一小段：去掉 try/catch，文档服务的 404 原样走统一错误回包，和 `GET /v1/conversations/<不存在>` 一致；不区分「不存在」与「没权限」。
- 测试：`server/test/accept-018-auth-agent-path.test.mjs` 的「2.3-4 不存在的对话…事件流」去掉 todo，并断言状态就是 404。
- 红的时候：`Error: socket hang up`（ECONNRESET）。
- 绿：该文件 9 条里 8 过、1 todo（`2.3-3` 共有对话第二条消息排着，不归我）、0 败。

### 第 15 条 账号模式拒绝过期写入「现在是 rev undefined」
- 改：`server/docservice/modules/project.mjs`。把非账号路径里 `stale` 回包的 `expectRev / since / sinceComplete` 抽成 `staleDetail(st, expectRev)`，账号路径（`handle` 里 `project.op` 被拒的 `catch`）在 reason 是 `stale` 时同样带 `currentRev` 和 `staleDetail`。其它拒绝理由（没授权、顺序服务不可用……）不带版本号，不向没通过授权的连接透露项目进度。
- 测试：`server/test/accept-018-conv-endtoend.test.mjs` 的「过期写入被拒时，回给模型的话里要有当前版本号」去掉 todo。
- 红的时候：回给模型的话是「你读到的是 rev 8,现在是 rev undefined」。
- 绿：该文件 4 条里 3 过、1 todo（`停止` 回 503，第 2 条，不归我）、0 败。

### 第 12 条 「谁可以新建、每人能建多少」没有判断口子
- 改：`server/account/authority.mjs`，只在 `createProject` 附近加：新导出 `checkCreateProject(policy, ctx)`，`createAccountAuthority` 多一个选项 `createPolicy`（缺省 `{}`），`createProject` 在重复 requestId 回放之后、重名检查之前调用它。
- 〔裁〕配置的名字与形状：`createPolicy = { maxProjectsPerAccount?: null | 非负整数, canCreate?: (ctx) => true | false | { code } }`。缺省与以前完全一样（登录了的账号都能建、不限数量）；`maxProjectsPerAccount = N` 时一个账号名下已有 N 个就拒绝第 N+1 个，错误码 `project-limit-reached`（403）；`canCreate({ accountId, accountName, ownedCount, requestId })` 是更细的自定义判断，先于数量上限，返回 `false` 拒绝（码 `create-not-allowed`，403），返回 `{ code }` 用自己的码；配置不合法工厂直接报 `create-policy-configuration`（503）。「要登录」不在口子里：没登录的账号过不了 `verify`，到不了这一步。
- 计数从权威账本取：`state.projects` 里创建者是它、状态不是 `deleted` 的个数（pending 和 relocating 也占名额，已删除的不占）；不另建表。同一个 requestId 的重试原样回放，不占新名额。
- 还没做的接线：配置没有接到环境变量或部署文件。`server/docservice/account-hosted.mjs`（第 68 行建 authority 处）和 `server/hosted/combo.mjs` 需要各加一行把 `createPolicy` 传下去（例如读 `PROMPTCUT_MAX_PROJECTS_PER_ACCOUNT`）；这两个不在派活清单里，我没改。口子本身（改配置即可限制，不改调用方）已在 authority 一层成立。
- 测试（新）：`server/test/account-create-policy.test.mjs` 6 条：缺省放行任意多个；没登录被拒；上限 N 时第 N+1 个被拒回 `project-limit-reached`、被拒的不留半个项目、别的账号不受牵连；已删除的不占名额、重试回放不占名额；上限 0 与非法配置；自定义判断。
- 红的时候：在没改的 `authority.mjs` 上，缺省 2 条过，其余 4 条败（第 N+1 个照样建成，没有 `createPolicy` 参数）。
- 绿：6 过 / 0 败。

### 顺手：`Q-ACC-1`
- `server/test/accept-018-rest-queue-account-look.test.mjs`：原 todo 的断言（`main.mjs` 创建行不含 `!accountMode`）现状其实已经成立，但账号版实际改成了显式开关。改成对上现状的硬断言：`Q-ACC-1a` 开关 `PROMPTCUT_AGENT_ACCOUNT_LOOK=1` 时 `resolveAccountLook` 回服务私钥、读的是 `PROMPTCUT_AGENT_SECRETS`（= 接上）；`Q-ACC-1b` 缺省或 `0` 时回 null 且一次也不读私钥，哪怕看画面地址设了（= 不接）；`Q-ACC-2` 自检加上「创建行受 `lookOn` 管、账号模式 `lookOn = !!key`」。
- 3 过 / 0 败 / 0 todo。这条没有「红」可言（原来的 todo 断言本来就过，是被标成了现状不成立）。

## 验证
（交活前补）

## 没做成的与原因
- 第 12 条的配置没接到环境变量/部署（见上，两个文件不在清单里）。

## 要用户定的事
1. **`.procp` 包损坏时给用户看的那句话**（一级文字）。背景：任务书和设计里写了「zip 损坏单独报错、不伪称可恢复」，没有原文。现在用的是沿用读包失败现成句式的草稿：「.procp 包已损坏(里面有条目的内容校验不通过),没有打开它」，集中放在 `src/editor/io/procp.ts` 的常量 `PROCP_DAMAGED_MESSAGE`。选项：照用；或改成你要的字（只改这一个常量）。建议：先照用，验收真实旧文件那一关再看措辞。
2. **新建云端项目被拒时给用户看的话**（一级文字）。我只定了错误码：`project-limit-reached`（已达每人上限）、`create-not-allowed`（自定义判断拒绝）；界面上对应的句子我没写，请你定。缺省不限数量，所以不配置的话用户永远看不到这两句。
3. （非文字，供知悉）每人上限的名字与形状见第 12 条〔裁〕，要不要接环境变量/部署配置，需要你点头后再动 `account-hosted.mjs` 和 `combo.mjs`。

## 对任务书或语义的更正建议
- `ACCEPT-018-map.md` 第 1 节第 14 条的分析写「同入口 GET 干净 404」，根因没写：是读通道把 2xx 写出当越权掐了连接（见上）。`accountEvents` 里原来的注释「回 200 加 end」在这个入口上做不到，已随修改删掉。
- 第 13 条：契约 6.3 节「成员用 `GET /v1/usage`」在账号模式下的含义，建议在 `cloud-agent-contract.md` 补一句「账号模式下以文档服务按账号核对出的项目成员为准」。
