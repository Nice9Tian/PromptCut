# AGENT-sync-member-fix

分支 `claude/sync-member-fix`（从 `claude/accept-final3` @6028555c 建出）。worktree 实际路径是 `.worktrees/.worktrees/sync-member-fix`（嵌套了一层，不是本 Agent 建的；依赖照样向上解析到主仓库的 `node_modules`）。

任务：修两处缺陷。
- 缺陷 1（探针检查 A7，即「云端 Agent 跑完后重开页面，看得到工具调用记录与『撤销这步』」）：账号路径上 syncManager 发 `events.list` 不带 projectId，文档服务回「projectId 不合法」。
- 缺陷 2（探针检查 B1，即「发起方离线、云端 Agent 在跑时，别的成员在成员列表里看到他那一行标『离线，Agent 在跑』」）：别的成员看到「成员：1 人 · Agent：0 个」，没有那一行。

## 缺陷 1：events.list 不带项目号

- 原因：`src/editor/sync/syncManager.ts` 账号项目那条路有两处 `link.send({ type: 'events.list' })`（进项目时、断线重连或到期前换会话后），不带 `projectId`；文档服务 `server/docservice/modules/events.mjs` 的 `list` 先核项目号，不带就回 bad-message「projectId 不合法」。本机空间与口令式共享项目那两处一直带着。
- 改法：两处都带上 `projectId: options.projectId`（与这条连接的 `SyncLink` 用的是同一个项目号）。
- 回归测试 `src/editor/sync/eventsListProjectId.test.mjs`：
  - EVL-01 核对 `syncManager.ts` 里每一条 `events.list` 消息都带 `projectId`（syncManager 在 Node 里载不起来，只能核源码）。改前跑这条：失败；改后：通过。
  - EVL-02 用文档服务真实的事件模块确认：不带项目号回 `error`，带了回 `events.listing`。

## 缺陷 2：成员列表数不到云端 Agent

任务书说的原因（`account-hosted.mjs` 的 `resolveRun` 身份不带用户名、`shared.mjs` 的 `devicesOf` 按 userId 聚合）对不上账号路径的实际代码，读代码后的真实原因：

1. 账号项目的成员列表不走 `shared.mjs` 的 `shared.members.list`，走 HTTP `/hosted/shared/account/members`，由 `server/account/project-members.mjs` 从文档服务的连接表投影出来；它要求每条连接带 `deviceId`，没有就跳过。
2. 生产上云端 Agent 的任务连接是 `server/hosted/doc-agent-assembly.mjs` 的 `transportAuthenticate` 鉴权的（实例内部传输、带 `runGrantId`），给的身份是 `{ realm: 'account', role: 'agent', service: 'agent', accountId, runId, … }`，**没有 `deviceId`**，于是整条连接被投影滤掉：Agent 数 0，也没有发起人那一行的任何标记。（`account-hosted.mjs` 的 `resolveRun` 那条路给了 `deviceId: runId`，但现在没有调用方发 run 票据，生产上不走它。）
3. 页面 `src/account/AccountMembersPanel.tsx` 的计数是「有页面连接的账号数」与「所有 agent 连接条数」，没有「离线，Agent 在跑」这一档，也没有「〈成员名〉的云端 Agent」那一行。

改法：

- `server/account/project-members.mjs`：任务连接（`role: 'agent'` 且 `service: 'agent'`）没有设备号时，按任务号归成 `run:<runId>` 一项，仍按 `accountId` 记在发起成员名下；名字照旧取成员名单里的名字。没有设备号也没有任务号的连接照旧不列。
- `server/hosted/doc-agent-assembly.mjs`：任务连接的身份多带发起人名字 `accountName`（取自任务授权的 `initiatorName`）。**不加 `deviceId`**：`actor.mjs` / `project.mjs` 的写入身份比较键 `identityOf` 含 `deviceId`，加了会改变覆盖提示、撤销冲突的判定，所以只在成员列表的投影里补。
- `src/editor/sync/hostedServices.ts`：新增账号项目的计数口径 `accountMemberState` / `accountMemberCounts` / `accountMemberCountLabel`（语义 `product/agent.md`「成员列表怎么数」）：人数只算有页面连接的账号；本机 Agent 逐条算；云端 Agent 每位成员最多算一个；本人没有页面连接、云端 Agent 连着 →「离线，Agent 在跑」，不计人数、计 Agent。账号项目的任务连接只在一轮在跑时连着（一轮结束 `account-runner.mjs` 就关），所以「连着」即「有一轮在跑」，不另看在场状态里的 `cloud-run`。
- `src/account/AccountMembersPanel.tsx`：用上面的口径；成员行在离线且云端 Agent 在跑时标 `[离线，Agent 在跑]`（`data-pc="members-offline-agent"`，代替 `[离线]`），云端 Agent 在跑时标 `[云端 Agent]`（`data-pc="members-cloud-agent"`）并在行下显示「〈成员名〉的云端 Agent」（`data-pc="members-cloud-agent-row"`）；任务连接不再当一台「设备」列出 `run:… · run:…`。成员行多了 class `pc-members-row`（与口令式项目的成员列表同一个类，探针 `membersList` 按它找行；样式只是 flex 列与圆角）。
- `src/mobile/useMembers.ts`：手机版账号项目用同一口径（原来逐条算 agent 连接，离线的人只写「离线」）。

测试：

- `server/test/account-member-projection.test.mjs` 新增一条：创建者页面断开、只剩他的任务连接（无设备号、带 runId 与 service agent）时，投影里他名下有 `run:run_1234` 一项、`conns: [{ role: 'agent', service: 'agent' }]`、名字是成员名单里的名字；不带任务号的连接不列；不泄露 loginId。改前跑：这条失败（3 过 1 败）；改后 4 条全过。
- `src/editor/sync/accountMemberCounts.test.mjs`（ACC-MEM-01～03）：创建者离线 + 云端 Agent 在跑 →「成员：1 人 · Agent：1 个」、他那一行 `offlineAgent`；本机 Agent 逐条算、云端每人最多一个、只有渲染连接不算真人在线；名单外账号的连接不计。

桌面版 / 口令式项目那条路：成员列表走 `LegacyMembersButton` 与 `shared.mjs` 的 `devicesOf`，本次没有改动；它们的测试（`hostedServices.test.mjs` 的 CAU-MEM 等）在全量测试里照常通过。账号项目在桌面版里用的也是 `AccountMembersPanel`，同样受益。

## 验证

- `npx tsc -b --force`：退出码 0（改完缺陷 2 后与全部改完后各跑一次）。
- 新测试单跑：`account-member-projection.test.mjs` 4/4、`accountMemberCounts.test.mjs` 3/3、`eventsListProjectId.test.mjs` 2/2；新加的投影用例与 EVL-01 在改前都失败。
- `npm test`（按 `docs/local.md` 设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`）跑了四次，**四次退出码都是 1，没拿到全绿**：
  | 次 | tests | pass | fail | skipped | 失败的 |
  |---|---|---|---|---|---|
  | 1 | 7256 | 7236 | 1 | 19 | `account-page-link.test.mjs`（第 39 处改动没及时落到服务端） |
  | 2 | 7254 | 7228 | 7 | 19 | `cloud-tools-p1-shots`（临时目录 EPERM）、`media-hash`、`multi-agent-presence` MA-X2、`reopen-hosting`、`user-editing` UE-S7 等 |
  | 3 | 7254 | — | 若干 | 19 | `agent-live-selection`、`asset-project-workers`、`cloud-agent-runs`、`cloud-agent-service` CA-*、`multi-agent-presence`、`reopen-hosting`，多为「test timed out after 30000ms」 |
  | 4 | 7254 | 7212 | 23 | 19 | `cloud-agent-service` CA-*（多为 30 秒超时）、`multi-agent-presence` MA-X2 等 |
  每次失败的都不一样，都是超时或时序类；这些文件都没有被本分支改到（本分支只改了上面列的 7 个源文件与 3 个测试文件），本分支相关的测试在每一次全量里都通过（第 4 次：EVL-01/02、ACC-MEM-01～03、两条投影用例、CAU-MEM-01～04 全过）。把出过错的文件单独重跑：`account-page-link` 1/1；`cloud-tools-p1-shots`、`media-hash`、`multi-agent-presence`、`user-editing` 一起跑全过、`reopen-hosting` 那一次失败 1 条，随后单跑连续 4 次 3/3；第 3 次全量失败的 6 个文件一起跑 69/69。`reopen-hosting` 在基线分支 `claude/accept-final3`（当时已前进到 fe146389）上单跑 3/3。判断：这台机器同时有别的会话在跑测试与探针，全量的并行负载下这些用例超时；不是本分支引起的，但**全量全绿这一项没有达成**，要主会话在机器空闲时重跑确认。

## 探针（可选项，没跑）

`claude/ux-probe-account` 上的 `cloud-agent-ux-ui-probe.mjs --steps online / stop` 要起账号组合：`startAccountStack` 连着占 71 个端口（`ACCOUNT_PORT_COUNT = 71`，缺省从 29003 起），另加站点、两个舞台源、桌面 dev server、渲染服务等约 8 个端口，还要现打在线构建。分给本 Agent 的端口段只有 29100～29109，装不下，所以没跑。A7、B1 的现场验证留给主会话用探针整支跑。

## 部署说明（没部署）

- 文档服务代码树 `/opt/promptcut-v2/releases/35f7b2ab/pc`：换 `server/account/project-members.mjs`、`server/hosted/doc-agent-assembly.mjs` 两个文件，重启 `promptcut-doc-v2`。先 `systemctl show promptcut-doc-v2 -p ExecStart` 确认在用的就是这个目录。
- Agent / 渲染代码树 `/opt/promptcut-render/releases/35f7b2abb9db`：服务端没有要换的文件（`doc-agent-assembly.mjs` 只在文档服务进程里用；要保持两棵树一致可以同样拷一份，不用重启 Agent 服务）。
- 在线编辑器 `/opt/promptcut-hosted/editor`：本分支改了 `syncManager.ts`、`AccountMembersPanel.tsx`、`hostedServices.ts`、`useMembers.ts`，要从本分支（合入后从 main）重新构建在线编辑器换上，保留 `runtime-config.json`。缺陷 1 完全是页面侧的修复，只换服务端不生效。
- 桌面版：账号项目在桌面版里同样用这两处页面代码，随下一次桌面版构建生效。
- 顺序：两边独立，先换哪边都行；只换文档服务时页面会显示 Agent 数，但还没有「离线，Agent 在跑」标记（旧页面把任务连接当成一台设备列出）。

## 对任务书的更正建议

- 缺陷 2 的原因不是 `resolveRun` 的 userId 不带用户名、也不是 `shared.mjs` 的 `devicesOf`（账号项目不走它们），而是 `doc-agent-assembly.mjs` 给任务连接的身份没有设备号，被 `project-members.mjs` 的投影滤掉；加上账号成员面板本身没有「离线，Agent 在跑」这一档。报告 `AGENT-ux-probe-account.md` 第 72 行的原因分析建议照此更正。
