# AGENT 报告：ux-probe-account

分支 `claude/ux-probe-account`（起点 main `3267ce84`），工作区 `.worktrees/ux-probe-account`。

任务：把 `scripts/probes/cloud-agent-ux-ui-probe.mjs` 在线一轮（及依赖它的 stop、spaced、usercard、errors 各段）从口令式云端项目改到账号项目，接真实的本机渲染服务，让整支探针全部通过（0.7.18 验收遗留，上一轮见 `docs/archive/agent-reports/AGENT-ux-probe-fix.md` 的选项 A）。

## 进度

- 开工，建报告。
- 读完规则、语义（`product/agent.md`、`product/hosting.md`、`product/rendering.md`、`workflow/production.md`）、上一轮报告与两支探针、账号组合夹具（`server/test/fixtures/account-runner-process.mjs`、`cloud-queue-user-path.mjs`）。
- 改探针之前先核对「在线一轮要断言的产品行为在账号模式下有没有」，查出一处产品缺口（下节），它挡住了在线一轮及 spaced、usercard、errors 的大部分断言。按任务书「查出产品缺陷时停下写进报告，回复主会话」，**停在这里，探针没有改**。

## 发现的产品缺陷：账号模式下云端 Agent 不发预渲染重试

语义 `product/agent.md`「发出任务后可以离开」：发起成员离开后对话跑到结束，「被改动的重卡由云节点上托管方的渲染节点渲出来并入库，全程不需要任何成员的设备在线」；「出错留痕」里也要求「渲染失败」留下原因。实现这一条的是 `server/agent/service/render-request.mjs`（「没有任何成员在线时的预渲染重试」：Agent 服务以服务身份发清单计划，结果记成对话里的 `render` 事件，「云端渲染完成 / 云端渲染失败」就出自这里）。它只在旧的（口令式、非账号）Agent 服务里接了发布通道：

- `server/agent/service/create-agent-service.mjs` 第 197～203 行：`accountMode === true` 时直接 `return createAccountRunnerService({...})`，参数里没有 `publisher`；`publisher` 只在第 218 行旧路径的 `createRenderRequests({ publisher, … })` 用到。
- `server/agent/service/account-runner.mjs`（818 行）里没有 `publisher`、`createRenderRequests`、`render` 事件；与渲染有关的只有「看画面」（`look`、`prerenderPost` 走 `/api/vision/snapshot`）和排队提示。
- `server/agent-service/account-executor-assembly.mjs` 第 115 行装配任务进程的服务：同样没有发布通道；`account-task-worker-config.mjs` 的设置项只有 `look`、`runAssets`、`tools`，没有渲染发布。
- `server/agent-service/render-publisher.mjs`（真的发布通道）只被旧的 `server/agent-service/main.mjs` 用。

结论：账号项目里（现在在线构建只认账号项目，云端项目一律走账号，`product/hosting.md`），云端 Agent 改完重卡、成员都不在线时，**没有人发预渲染计划**，托管渲染服务没有活可认领；对话记录里也不会有「云端渲染完成」「云端渲染失败」。这和 `product/agent.md` 第 41、42 行的承诺冲突。生产节点现在跑的就是账号版 Agent，所以生产上也是这样（没有上节点核实，只是代码推断）。

另外，账号组合（`account-runner-process.mjs`）里的渲染服务只有「看画面」口子加一个回固定图片的替身，还没有和真渲染服务（`server/hosted-render/main.mjs`）接过；文档服务的目录模块已经能把账号项目列给渲染服务（`server/docservice/modules/hosted.mjs` 第 148～170 行，`accountRenderState`），这一块本身看起来不缺。

## 对这支探针的影响（逐段）

| 段 | 断言 | 在账号模式下 |
|---|---|---|
| online | O A1 发起后结束浏览器、断掉的会话保留期满后没有成员连接 | 可迁（登录、新建云端项目、告知、云端 AI 栏就是 `cloud-agent-ui-probe` 的搭法；「没有成员连接」要改从文档服务或账本看，渲染服务目录也能报 `members`） |
| online | O A2 对话跑完、12 次写入落在没有成员连接之后 | 可迁（对话事件改读账号组合的事件库 `fixture.events` / 账本，不再读 Agent 服务盘上的 `tenants/…`） |
| online | **O A3** 重卡由渲染服务渲出、对话记录里有 `published → done`、渲染节点完成数增加、素材文件增加 | **做不到：缺陷** |
| online | O A4 bob 进项目看到改动后的项目 | 可迁（第二个账号经项目链接加入） |
| online | O A5 bob 舞台上两张重卡贴着轨道流、环境指纹是渲染服务的 | 不确定：bob 上线后他自己的页面会发计划，渲染服务（开了「生成轨道流」）可能认领，但这已不是「云端在没人在线时渲好」；断言要改写才可能过，改写就降低了它要验的东西 |
| online | **O A6** 重开后历史里有对话、「云端渲染完成」状态与气泡末尾那一行 | **「云端渲染完成」做不到：缺陷**；其余可迁 |
| online | O A7 「Agent 操作」里撤销这步 | 可迁 |
| stop | S B1 发起后退出、bob 看着项目在变、成员列表里有「〈创建者〉的云端 Agent」 | 发起方原来是桌面版（口令式项目）。账号模式下桌面版要 Rust 壳里的账号保管，无头 dev server 页面进不了账号项目（`cloud-agent-ui-probe` 0.7.18 迁移时就把桌面阶段整个拿掉了）。要改成在线页面发起 |
| stop | S B2 重新打开「AI 栏仍是本机驱动」、出现「云端有一个对话正在进行」、接上、停止 | 「本机驱动」在在线构建里不存在（下拉只有「云端」，`cloud-agent-ui-probe` O0 断言的就是这个）；横幅 `cloud-running-banner` 只在本机驱动的 AI 栏里出（`src/editor/right/AiPanel.tsx` 第 542 行）。要按现行语义改写成「另一台设备的在线页面从历史接上、停止」 |
| stop | S B3 另一台设备接着说一句 | 可迁 |
| spaced | **K1、K2** 中途就按当时的版本发计划、结局是渲染完成、渲染节点没有失败 | **做不到：缺陷**（整段验的就是 Agent 发的预渲染重试） |
| spaced | K3 之后上线的成员看到最后一版的预渲染结果 | 同 A5，不确定 |
| usercard | **UC1** 预渲染重试由隔离工作进程认领并渲完 | **做不到：缺陷** |
| usercard | UC2 后上线的成员舞台上贴用户卡的预渲染结果；断言里还要 `snapshot === true`（快照 2026-10-13 已作废），这一条本来就要按轨道流改写 | 同 A5，不确定 |
| errors | E1 模型调用失败 | 可迁（账号运行器有这一路） |
| errors | E2 额度用尽 | 待查：探针用的是旧 Agent 服务的 `admin.mjs quota`；账号运行器的准入在 `account-runner.mjs` 第 319 行（`fail(429, … 'quota')`），额度由谁设、提示文字是不是「额度已用完(已用 / 上限)」没查 |
| errors | E3 创建者关「云端 Agent」开关 | 可迁（账号模式的 `set-hosted-service`；页面上的开关与「验证创建者身份」弹窗在账号模式下长什么样要另找） |
| errors | **E4** 渲染失败留痕「云端渲染失败」 | **做不到：缺陷** |
| errors | E5 发起成员被移出 | 可迁（账号模式的 `set-list` / `kick`） |

在线一轮里必须过的 A3、A6（及 K1、K2、UC1、E4）都依赖这一处缺口，所以「整支探针全部通过」在不改产品代码的前提下做不到。没有为了变绿去跳过或放宽这些断言。

## 需要主会话 / 用户定

1. 产品缺陷怎么办：
   - 甲：立一个产品任务，把预渲染重试的发布通道接进账号版任务进程（`createAccountRunnerService` 与 `account-executor-assembly.mjs` 接 `publisher`；服务身份发清单计划要经文档服务在账号模式下认可，可能还要过主服务代签，和「看画面」同一种做法）。之后再迁这支探针。
   - 乙：改语义，承认账号模式下云端 Agent 改完的重卡在有成员上线时才产流（`product/agent.md` 第 41、42 行要改，属二级，要用户定），探针里 A3、K1、K2、UC1、E4 按新语义改写或删除。
2. 在缺陷定下之前，要不要先把不依赖它的部分迁过去（A1、A2、A4、A6 的历史部分、A7、B1、B3、E1、E3、E5，以及 B2 按在线页面改写）。这部分工作量大约是重写整支探针的在线部分加给账号组合接真渲染服务，迁完后整支仍过不了。

## 验证

本次没有改代码（只加了这份报告），没有跑 `tsc`、`npm test`、探针：没有可验的改动。

## 第二轮(主会话:缺陷已修入 main 16005ae4,按 A 方案迁探针)

- `git merge --no-ff main`(16005ae4)→ b0501cb6。
- `cloud-agent-ui-lib.mjs` 新增 `startAccountStack`(账号组合夹具 `account-runner-process.mjs` 的生产主服务装配 + 真发布通道 + 真渲染服务 `server/hosted-render/main.mjs`,照 AR-10 的接法;`PROMPTCUT_RENDER_STREAMS=1`、`PROMPTCUT_RENDER_EDITOR_DIR=<在线构建>`、`NODE_EXTRA_CA_CERTS`)、`buildOnline`、`accountLogin`、`acceptConsentIfAsked`、`hostedOption`、`creatorToggleOption`;`creatorToggleService` 的口令改成可选(账号项目没有验证口令那一步)。端口:`--account-port 29003` 起 71 个,舞台与渲染服务沿用这支探针的 `--base-port`+1/+2 与 `--render-port`(桌面版那一遍的旧组合先停干净再起账号组合)。
- `cloud-agent-ux-ui-probe.mjs`:桌面版那一遍不动(口令式旧组合);之后换到账号组合(`setupAccount`,新断言 X1),online / stop / spaced / usercard / errors 都在账号组合上跑。创建者 = 夹具的 dualUser0、bob = dualUser1、carol 现注册经项目链接加入;「生成轨道流」由创建者在在线页面的项目设置里打开(`ACCOUNT_ADMINS` 只设在探针进程里)。对话记录改读主服务事件库与文档服务账本(`diskConversation` 同形状)。

### 查出的产品缺陷(没有改产品代码)

1. **账号项目的页面拿不到「Agent 操作」的撤销记录(A7)**:`src/editor/sync/syncManager.ts` 账号路径两处 `link.send({ type: 'events.list' })`(约第 1247、1358 行)不带 `projectId`,文档服务事件模块 `server/docservice/modules/events.mjs` 的 `list` 先 `checkProjectId(msg.projectId)`,回 `error bad-message「projectId 不合法」`。证据(探针 `PC_PROBE_WSLOG=1` 记的重开页面 WebSocket 帧):`[{"sent":"events.list","projectId":null},{"type":"error","reason":"bad-message","detail":"projectId 不合法"}]`。后果:创建者重新打开(或换设备)后,「Agent 操作」里没有「撤销这步」;只有对话进行时开着的页面靠实时 `events.event` 才有(所以 cloud-agent-ui-probe 的 O1 能过)。建议:两处补 `projectId: options.projectId`(与本机路径第 724 行一致)。
2. **账号项目的成员列表不显示「〈创建者〉的云端 Agent」(B1)**:发起方离线、云端 Agent 在跑时,bob 页面成员按钮是「成员：1 人 · Agent：0 个」,没有「离线，Agent 在跑」(语义 `product/agent.md` 第 59 行、`mechanism/agent.md` 第 93、175 行)。原因(读代码):`server/docservice/account-hosted.mjs` `resolveRun` 给任务连接的身份是 `userId: account:<账号>@run:<runId>`、没有 `username`,`modules/shared.mjs` `devicesOf` 按 `userId` 聚合,于是任务连接单独成一行、对不上创建者那一行,署名也取不到成员名。截图 `S-1-bob-watching.png`。
- 观察(不算缺陷,记下):账号模式点「停止」后,气泡写「云端 Agent 服务中断,这一轮没有做完…」(任务进程被强制结清);历史列表里正在跑的对话标 idle。
3. **账号模式的出错原因没有照语义写进对话(E1、E2、E3)**(`product/agent.md` 第 42 行「出错留痕」):
   - E1 模型调用失败:气泡写「上游接口 500(探针注入)」,没有「模型调用失败」;历史列表这个对话标 `idle`、没有「出错」(账本里这一轮 `terminalOutcome.status: failed`)。
   - E2 额度用尽:气泡只写代号 `quota-exceeded`,没有「额度已用完(已用 N / 上限 M)」;再发一条没有被明确拒绝(没有 `cloud-notice`,也没有带「额度」的回复);那一刻账本里这个对话还是一轮在跑(`grant: active`),有一次因此拖住了紧接着的 E3(「E3:这一轮开始并有写入」等不到)。原因的文字在 `server/agent/service/gate.mjs` 第 143 行有,账号路径(`account-runner.mjs` 第 319 行 `fail(429, code)`)没带出来。
   - E3 创建者关「云端 Agent」:AI 栏横幅写「项目创建者已关闭云端 Agent。」,账本记 `interrupted / agent-disabled`,但对话气泡里没有任何原因(`outcome`、`error` 都是空)。

### 断言改前改后(按现行语义;只改进入方式、找元素与等待的不列)

| 编号 | 改前 | 改后 | 依据 |
|---|---|---|---|
| X0 → X1(在线各步) | 创建者在桌面版页面建口令式云端项目;桌面版 AI 栏多了「云端」、本机驱动仍是缺省 | 账号组合起来、三方代码版本一致;创建者在在线页面打开「生成轨道流」(直接确认,无口令);「云端 Agent」一行勾着、可改;在线页面接入方式只有「云端」且选中;第三个账号经项目链接加入 | `product/hosting.md` 云端项目一律走账号;在线构建只认账号项目 |
| A6(online) | 不变 | 不变(provider === cloud) | — |
| B1 | 桌面版发起后结束桌面版进程 | 在线页面发起后结束浏览器进程;其余(改动一条条出现、成员列表里「〈创建者〉的云端 Agent」、本人不在线)不变 | 无头 dev server 页面进不了账号项目 |
| B2 | 重新打开桌面版:AI 栏仍是本机驱动、出现「云端有一个对话正在进行」横幅,点「接上看看」;记录里 `reason: stopped` | 换一个浏览器进程重新打开在线页面:接入方式是「云端」,从历史里点开这个对话,接上后看得到它还在跑、工具调用接着增加;点「停止」后停下,云端记下这一轮已不在跑,没有说出最后那句,项目不再变 | 在线构建没有本机驱动与那条横幅;账号模式的停止由「结清」收口(任务进程被强制关),没有旧的 `reason: stopped` 字段 |
| B3 | 「是已停止的」看 `outcome === 'aborted'` | 看「不在跑、没有最后那句」;另一台设备是第三个浏览器进程 | 账号模式的界面消息没有 `aborted` 标记(同 cloud-agent-ui-probe O2) |
| K2 | 渲染节点诊断计数 `failed` 增量为 0、`completed + dedup` 增量 > 0 | 工作进程逐任务收尾行里这个项目做完的任务数 > 0,收尾行里没有失败 | 账号组合里工作进程会重起,诊断计数从零开始,前后相减出现负数(实测 -2) |
| UC0(新) | — | 第二个创建者在在线页面新建账号项目:「云端 Agent」缺省勾上,打开渲染节点与「生成轨道流」,渲染服务看到 | 用户卡一步原来由探针直接建口令式项目 |
| UC2 | 舞台上这张用户卡「快照层在」 | 「轨道流画出了帧」(或旧快照层),没有占位 | 2026-10-13 每张卡的快照作废 |
| E3 | 记录 `state revoked / reason disabled` | 账本里这一轮 `terminalOutcome.reason === 'agent-disabled'`;气泡与横幅的原因断言不变 | 账号模式的记录形状 |
| E4 | 渲染服务停掉后重起 Agent 服务把「连续没有进度」缩到 12 秒 | 主服务不重起,整轮用 90 秒(`RENDER_STALL_MS`) | 账号主服务在夹具里装配,不能单独重起 |
| E5 | 发起成员被移出名单:她的对话被停下,云端记录 `revoked / removed`,写入 1～29 次 | 被踢出:她的页面当场写明被踢出;她在共有对话里已被读到的那一轮照常收尾(`done`)、踢出之后还有写入落地,项目完好 | `product/agent.md`「改密退出与被踢的已读消息例外」(2026-10-08 用户定) |

### 验证

- 整支缺省步骤(`node scripts/probes/cloud-agent-ux-ui-probe.mjs --dist dist-online`,桌面版 + 账号各步):45 项 38 过、7 不过(见下),退出码 1。过了的:X0 四项、D A1～A7、换组合、X1 四项、O A1～A6(A3 渲染节点完成 0→10、素材文件 4→50,A5 两张重卡贴流、层表环境指纹是渲染服务的,截图 157 种颜色)、B2、B3、K1～K3、UC0～UC2(隔离工作进程认领并渲完,后上线的成员舞台贴流)、E4(「云端渲染失败:渲染节点 10 分钟没有进展」)、收尾。
- 不过的 7 项全是上面三处产品缺陷:O A7(及它的两条等待)、S B1、E1、E2(及「再发被拒绝」)、E3。E5 在那一轮用的旧断言(要写满 30 次,一轮最多 24 次模型往返写不满)已改;单跑 `--steps errors` 时 E5 的现象:踢出后页面写「你已被创建者踢出该项目…」,那一轮 `done`、写入 21 次、项目完好。
- `cloud-agent-ui-probe.mjs --base-port 29003 --dist dist-online`:`{"summary":{"total":28,"failed":0}}`,退出码 0。
- `npx tsc -b --force`:退出码 0。
- `npm test`(设两个 VisuHive 变量):退出码 0,「npm test 最终结果：零失败」。ℹ tests 7238 ℹ pass 7223 ℹ fail 0 ℹ cancelled 0 ℹ skipped 15 

## 暂停点(主会话因 5 小时额度要求暂停)

- 做到:探针迁移完成并提交;整支缺省跑过一遍(结果见上);cloud-agent-ui-probe 回归 28/0;tsc 0 错;npm test 零失败。
- 没做完:E5 最新断言(踢出后那一轮 done 且有新写入)只在单跑 errors 时看过现象,还没在改断言后复跑;下一步:`--steps errors` 复跑一次确认 E5 过,然后把报告里的结论定稿。
- 整支「全部通过」挡在三处产品缺陷上(A7、B1、E1～E3),要主会话或产品分支修;修好后再整支跑一遍。

## 恢复后(额度刷新)

- 复跑 `node scripts/probes/cloud-agent-ux-ui-probe.mjs --steps errors --dist dist-online`(改写后的 E5 第一次跑):**E5 过**——踢出后她的页面写「你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。」,发送按钮不可用;对话是共有的;那一轮照常收尾(账本 `terminalOutcome.status: done`,事件末尾 `runner_done`),写入从踢出时 1 次到收尾 22 次,版本 8→30,之后 1.5 秒无写入,三张卡都在。E4 过、收尾过;E1～E3 仍不过(产品缺陷 3,与上文同样现象),X1 四项过。退出码 1(只因 E1～E3)。
- 结论定稿:探针迁移完成。整支「全部通过」只差三处产品缺陷——A7 与 B1(另一位子 Agent 在 `claude/sync-member-fix` 修)、E1～E3(`claude/model-error-surface` 在修)。它们合入后在本分支上把整支缺省步骤再跑一遍即可;探针侧不需要再改(断言没有为了变绿而放宽)。
- 上文「暂停点」一节作废,以本节为准。
