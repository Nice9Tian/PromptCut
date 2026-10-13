# AGENT-v18-runner-list:验收运行器补齐 0.7.18 的清单

分支 `claude/v18-runner-list`(从 main `f87e297a` 建,中途 main 前进到 `93fb758d`,只多了计划文档),工作区 `.worktrees/v18-runner-list`,端口段 28990～29049。没改产品代码(`src/`、`server/` 里只动了测试与夹具),没推送、没合并。

几个词:**38 行**指 `ACCEPT-018-map.md` 第 2 节总表(2.1 的 21 行、RS18 的 4 行、2.3 的 13 条)。**清单**指运行器的数据 `scripts/acceptance/four-stage-manifest.mjs`(0.7.18 的项另放 `v18-manifest.mjs`、行号表 `v18-rows.mjs`)。**todo 测试**指 node 测试里标了 `{ todo }` 的断言:现在不成立,失败不让 `npm test` 变红,输出里用 `⚠` 标出。

## 1. 做了什么

1. **38 行全部进清单。** 新增 `V18` 类共 80 多项,每项写 `rows`(它是哪几行的依据)和 `where`(在哪能跑:本机就能跑 / 要安装包 / 要部署到节点以后 / 要真实网络 / 要人工看 / 等分支合入 / 不适用)。老清单里的项补上行号(`OLD_ITEM_ROWS`:G0-1～4 → 2.3-11、S4-1/2 → 2.3-4、S4-3/4 → 2.3-6/5、16 项网络项 → 2.1-18 等)。等分支合入的:`claude/v18-missing`(缺素材与旧云端文件转本地,15 个文件)、`claude/v18-chats`(对话删除,5 个)、`claude/v18-cardsync`(卡片同步,6 个)、`claude/v18-wire`(工具表接线,分支上还没有测试,写成等合入的人工项)、渲染重构(本地取帧优先、预渲染遇 507 留队列)。命令照地图第 4 节与各分支报告抄;那些文件现在不在 main,我没去合它们。合入后文件一出现,这几项自己就会跑(现在记「等分支合入」,不是失败)。
2. **运行器直接出 38 行结论表。** `--rows`:跑完按 38 行出表,打印并写 `<out>/rows-table.md`、`rows-table.json`;`--rows-from <results.json>`:不跑,用已有结果出表;`--rows-map`:不跑,列 38 行各由哪些项覆盖、在哪能跑;`--no-optional`:`--only` 点到类别时也不带 optional 的项;`--v18-port-base`:0.7.18 各项用的端口段起点(缺省 28990)。写进了 `--help`。结论规则:一行里有一项失败(含「不稳定」:首败后复跑才过的)这行就是失败;没失败但有项没跑(人工、安装包、节点、网络、等分支、前置没过、本次没选中)是「未跑」并列出没跑的项;至少一项通过且没有失败和没跑才是「通过」;全不适用才是「不适用」。单测 `server/test/four-stage-acceptance-v18.test.mjs` 固定了这些规则,其中一条:一项都没跑时没有任何一行是通过。
3. **`--check-coverage` 变成真守门**,四类问题任一类出现退出码 1:① `scripts/probes` 下每个文件登记(`covers`)或写明排除原因(原来的 66 个没登记的,有 37 个写了排除原因,其余登记进新项);② 38 行每行至少有一项;③ 清单项引用的测试文件与探针脚本在仓库里(标了等分支合入的单列,按分支分组);④ 全量测试的跳过名单每条写全。现在的输出:`守门:通过`,等分支合入缺的文件单列了 26 个。
4. **问题 17(跳过数)**:不再是「`skipped ≤ 2`」,改成逐条名单(`G0_2_SKIPS`),输出里每条被跳过的测试都得在名单里,多出一条 G0-2 就不过(单测 V18-04)。名单见第 3 节。G0-2 还要求设了账号后端的两个环境变量,没设记「跑不了」,不让用到账号后端的测试悄悄整文件多跳。
5. **问题 16(旧探针)**:`cloud-agent-ui-probe.mjs` 改走账号入口,S4-4 能跑通,见第 4 节。
6. 小改动(都是测试或夹具,默认值不变):`accept-018-conv-password-probe` 的写死端口改成可由 `--base-port` 换(`accept-018-conv-endtoend`、`accept-018-files-account-fixture` 原来也加过环境变量口子,后来 main 把它们改成自取空闲端口〔27160d3b〕,合并时以 main 为准、口子已收掉);`accept-018-auth-kit` 放宽端口基数的范围检查;`account-runner-process.mjs` 夹具多认一个 `publicHandler`;`bakery-deps.test.mjs` 的名单放行新单测;`four-stage-acceptance.test.mjs` 里几处写死的 104/16 项数改成按老清单算。

## 2. 命令

```
node scripts/acceptance/four-stage-acceptance.mjs --rows-map                 # 38 行各由哪些项覆盖、在哪能跑
node scripts/acceptance/four-stage-acceptance.mjs --check-coverage           # 守门,有问题退出码 1
# 本机缺省能跑的全部(先设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE):
node scripts/acceptance/four-stage-acceptance.mjs --only V18,G0-1,G0-2,G0-3,G0-4,G0-6,S4-4 --no-optional --rows --flaky-rerun 1 --dev-port <端口> --out <目录>
node scripts/acceptance/four-stage-acceptance.mjs --rows-from <目录>/results.json   # 用已有结果重出表
```

端口:0.7.18 的项从 28990 起依次用(串行,不同时占),`--v18-port-base` 换段;老清单的项仍用它自己的 5690～5699、8760～8769,我没在这次实跑里用它们。

## 3. 全量测试的跳过名单(问题 17)

全量 `npm test`(设了两个账号环境变量,Windows)实跑:`tests 6455、pass 6436、skipped 12、todo 6`,12 条跳过逐条如下(`kind`:平台不符 / 缺外部依赖 / 本来该跑却被无声跳过):

| # | 测试 | 文件 | 为什么跳过 | 归类 |
|---|---|---|---|---|
| 1 | 恢复遍历遇symlink明确拒绝,不跟随到其它目录 | `server/test/asset-project-publication-durability.test.mjs` | Windows 本轮不请求 symlink 权限,测试自己说「Linux 包装运行实际验证」 | 平台不符(仅 win32) |
| 2 | POSIX database and parent-directory permissions stay private… | `server/test/cloud-tool-jobs.test.mjs` | Windows 的文件权限位不算 POSIX 权限证据 | 平台不符(仅 win32) |
| 3 | 集成:/api/cards/layout 对真实项目返回整数框 | `server/test/cards-layout.test.mjs` | 没设 `PC_STAGE_TEST_URL`(要一台开着的 dev server)就跳过,**而且输出里只写 `# SKIP`,没有原因** | **本来该跑却被无声跳过** |
| 4～8 | real speech / real environment answers / real cancel / real timeout / real install job(5 条) | `server/test/cloud-tools-p2-stt-real.test.mjs` | `out/p2-stt/pylibs` 里没有 faster_whisper(先 `node scripts/probes/cloud-tools-p2-stt-probe.mjs --setup`,复制主工作区已装的依赖);「install job」一条另要 `P2_PIP=1`,联网 pip | 缺外部依赖 |
| 9～12 | real short clip / real chain × 3(4 条) | `server/test/cloud-tools-p5-real.test.mjs` | 转写依赖同上 | 缺外部依赖 |

**不该无声跳过的**:第 3 条。全量测试里没有任何人给它设 `PC_STAGE_TEST_URL`,所以 `/api/cards/layout` 的集成断言一直没被验过。已加清单项 **G0-6**:起共享 dev server、设好变量把这一个文件跑一遍,实跑 `pass`、`skipped 0`(7 秒)。第 4～12 条(9 条)是「要备好 Python 依赖才跑」的真实集成测试,在这台机器上没备依赖,不是无声跳过但等于没验;它们属于 2.1-20(剩余工具),清单项 `V18-tools-tests`、`V18-tools-p2-stt`、`V18-tools-p5-workflow` 写明了备依赖的办法。备依赖那一步我没做(P2_PIP 要联网下载,没得到许可)。

## 4. 问题 16:`cloud-agent-ui-probe.mjs` 改走账号入口

原探针走在线页面开始页的「房间号加口令」加入表单(`[data-pc="join-form"]`)。在线构建的开始页现在只有账号登录(`src/StartPage.tsx` 的 `OnlineStartPage` 只放 `AccountProjects`),所以第 3 项就超时。改写后:

- 起账号模式的真实组合(`server/test/fixtures/account-runner-process.mjs` 的生产主服务装配:VisuHive 真账号后端、文档服务、独立素材进程、带证书的公共入口、任务在真子进程里跑真运行器;模型只有脚本式模拟提供方)。第一版用进程内执行器那套(`account-real-runner`),界面一轮结束后一直停在「等待云端确认关闭与结算」(它没有关闭结算),所以换成了任务进程夹具,并给它加了 `publicHandler`。
- 页面上真登录、「新建云端项目」、点「告知托管方可读」、打开「云端 Agent」开关,再发消息。
- 保留的断言(编号沿用原来的 O 系列):O0(云端 AI 栏、接入方式只有云端、info、委托票据)、O8(示例句、一键配特效置灰)、O1(流式、三处改动、Agent 操作记录、撤销)、O9(诊断报告含「保存为文件」下载、无凭证)、O2(停止)、O4(换浏览器环境登录同一账号,历史里找回对话)、O6(手机仿真仍是占位)。实跑 28 条检查全过,退出码 0,约 5 分钟(机器忙时)。
- **改动的判法(没放松,换成用户看得到的)**:O1 的「请求体带 grant」账号模式没有这个字段,改成只验带了票据;O2 的「回复 outcome 是 aborted」是旧进程内会话的内部字段,账号模式的消息模型没有,改成「停止按钮没了、云端 Agent 的回复里没有停之后才会说的话」;原来的「服务端记下这一轮已停」依赖旧的磁盘对话记录,没搬(账号模式下停止的结清由 `accept-018-conv-endtoend` 的「停止」那一条验)。账号会话签的票据是 43 个字符,公用件 `newPage` 的「Bearer 长度 > 60 算票据」会把它记成 `other`,探针里放宽成「带了 Bearer」。
- **O12 反向通道单独成一段**(`--phases reverse`,清单项 `V18-ui-reverse-channel`):云端 Agent 调 `seek`/`play`/`pause`/`get_selection` 一律回「发起方不在线」,页面没收到要它执行的请求(`page-results` 一次都没有)。这是产品现状(见第 6 节),没改断言,也没让它拖着别的断言一起红。
- **没搬过来的**及原因:O3 事件流掐断后重连(要能掐连接的代理,账号模式的公共入口是夹具自己的 HTTPS 服务,服务端层已有 `account-real-runner-sse` 测)、O5 创建者关开关与出错(服务端层已有 `accept-018-auth-agent-path`、`accept-018-conv-controls`)、O7 成员计数与离线 Agent、O10 关开关的气泡、O11 附件、O9(K) 一键提交到收集端(都靠旧夹具的可注入在场状态与第二个成员的浏览器);整个桌面版阶段 D1～D12(桌面版进云端项目要走 Rust 壳里的账号保管,无头 dev server 页面没有它)。这些原来验的内容,现在没有浏览器层的证据,只有服务端层的;写在探针文件头。

## 5. 老项逐条判(「云端一律走账号」以后必然跑不通的)

(见下面第 5.2 节的实跑记录。)

### 5.1 `c10-browser-probe.mjs`(协调员单独问的)

清单里指向它的项:`P-c10-browser-a4`、`P-c10-browser-full`、`P-c10-user-card`。实跑(用我的端口段,`--only-a4`,330 秒时限):**创建者那一半能走完**——桌面 dev server 页面本机建项目、放重卡、测量、预渲染出层表,第 0 步在 318 秒后输出 `step0.done`(层表 v3、环境指纹对);**成员那一半必然进不去**——第 1512 行等 `[data-pc="join-invite-project"]`(旧邀请加入控件),在线构建的开始页上已经没有它。我没等它超时报错(时限先到),但静态上 60 秒等待必败。

改成走账号入口要多大:不只是「进项目」那一步。后面 A1～A5(成员页首次测完在遮罩下进编辑、L2 成本记录、层表与创建者节点指纹对上、换帧占位、独立渲染主机认领)全靠「创建者的桌面节点把层产到同一个共享项目里,成员页读」。账号项目只能由在线页面本身或 Rust 壳里的账号保管建,无头桌面 dev server 建不了,所以创建者那半也得换成在线页面当创建者,探针的前提(创建者节点指纹 = 层的产出环境)就变了。这等于重写 2100 行探针里的主干,而且它验的是渲染一带的东西(这一带现在不碰,渲染重构还没做完)。**不值得在这一块里做。**

`codex/018-browser-doc-read` 不合:它修的是 10 月 9 日被 `ff4f04cf` 从 main 拿掉的「强化版」探针(`c10-judge.mjs`、`readFixtureProject`、`hostFixture`)回读全文时用错的项目编号,main 里现在的 `c10-browser-probe.mjs` 根本没有那些代码;它自己的报告写着真实浏览器被账号入口挡住、不得整支合并。所以那三个提交对 main 上的探针没有用处。

处理:三项标「旧入口已废,不适用」(原命令留作记录)。**它原来验、现在没人验的**:在线普通档的 A1(播放长任务 0)、A2(首次打开在遮罩下测完、成本记录进 L2)、A3 层表与环境指纹对账、A4(换帧装不下显示占位)、A5(独立渲染主机认领清单计划)、用户卡端到端。顶上它的新探针只有账号路径与对话这一边(`cloud-agent-ui-probe`、`accept-018-conv-password-probe` 等),验的是登录、权限、Agent,不验渲染与换帧。这块等渲染重构合入后,要在账号模式下重新搭一支(创建者用在线页面),请主会话排。

### 5.2 其余在线构建探针

这一步的目的:清单里「云端项目一律走账号」以后必然跑不通的老项,逐条判。判法:在线构建(`vite build --mode online`)的开始页只有账号登录;探针进项目要等旧的加入表单就必败。我用 0.7.18 的端口段把它们各实跑了一遍(中途发现自己的端口平移把同一探针的相邻端口撞了,改成按老端口的相对位置平移后重跑;跑完按进程号收掉了子进程,收尾查 28990～29049 没有残留监听)。

| 项 | 实跑结果 | 判定 |
|---|---|---|
| P-online-user-cards、P-c10-ui、P-online-stage-watch、P-online-stage-handshake、P-online-nav-stress | 日志里都是等 `[data-pc="join-form"]` 超时(nav-stress 在 200 次导航循环里 240 秒时限到) | 旧入口已废,不适用 |
| S1-5(声音 A、B) | 桌面一半 23 条检查过,在线一半等 join-form 超时 | 旧入口已废,不适用(桌面一半的证据另有) |
| S2-1、S2-2、S2-3、S2-4、S2-5(第二段在线用户卡 5 支) | 日志里都是等 join-form 超时 | 旧入口已废,不适用 |
| S1-4(声音预览) | 62 条检查里桌面一半过,唯一失败是等 `join-invite-project` 超时 | 旧入口已废,不适用 |
| S4-6(界面版「关掉软件照常运转」) | 桌面发起那一半的检查过(它跑在已退役的口令式房间本机组合上),200 秒时限内没走到在线那一步;读代码:第 233 行 `joinOnline` 等 join-form | 旧入口已废,不适用(读代码加半段实跑) |
| P-c10-browser-a4 / -full / -user-card | 见 5.1 | 旧入口已废,不适用 |
| X-online-join、X-c10a-demo-local(可选项) | 没实跑,只读代码:前者就是测 join-form,后者 7 处用 join-form | 旧入口已废,不适用(只读代码) |
| P-online-stale-layer | 能进项目(不走 join-form);6 条断言不过(静置后仍贴旧层等),原因没查 | **不是入口问题**,不改,写进「已知」,属渲染一带 |
| P-m7-node、P-desktop-auto-node | 200 秒时限内没跑完(P-m7-node 到了 `node.ready`,P-desktop-auto-node 桌面页面测量完),不走 join-form | 没判结论,不改,写进「已知」 |
| P-m7-browser | 200 秒时限内被我收掉,没判 | 没判结论 |
| P-multi-agent、S3-2、S4-5 等 | 没实跑 | 没判;它们用的是桌面 dev server 加本机口令式房间组合,在已退役模式上也许还能过,但那不是 0.7.18 的依据 |

清单里这些「不适用」项保留原命令(`was` 字段),运行器记 `na`,不再留必然失败的项。能改成账号入口的只改了 S4-4(第 4 节);其余改造等于重搭创建者那一半,不在这一块里做,逐项的「原来验什么、现在没人验什么」:在线页面的舞台握手与看守(stage-watch/handshake/nav-stress)、用户卡与图卡在线执行的安全与功能验收(S2-1～S2-5,含越权探测卡读不到凭证:**这是第二段的核心项,现在没有在线浏览器层的证据**,服务端层的越权探测在 `hosted-render-isolation-probe` 里,要主会话判是否要在账号模式下重搭)、在线声音 A/B 与预览(S1-4、S1-5 的在线一半)、界面版体验探针的在线一半(S4-6)。

## 6. 发现的产品问题

1. **账号模式下云端 Agent 的反向通道不通。** 复现:`node scripts/acceptance/four-stage-acceptance.mjs --only V18-ui-reverse-channel`(或 `node scripts/probes/cloud-agent-ui-probe.mjs --phases reverse …`)。期望:发起方页面在线时,云端 Agent 调 `seek`/`play`/`pause`/`get_selection` 能操作页面。实际:四个工具都回 `{"ok":false,"initiatorOffline":true,"error":"发起方不在线…"}`,页面没收到要它执行的请求。页面这一头已经把 `pageId` 放进发消息请求与事件流查询(`src/ai/cloud/session.ts`),没查任务进程那一侧为什么没接上;很可能就是 `claude/v18-wire`「工具表接线」要接的东西,合入后重跑这一项。
2. 停止之后 AI 栏末尾仍显示「正在思考… 0s」(截图 `O2-online-stopped.png` 里看到,停止按钮已没了,云端 Agent 回复里没有停之后的话)。没查是不是常驻,只是看到。
3. 全量测试里 `cards-layout` 的集成断言一直被无声跳过(第 3 节),现在有 G0-6 单跑。
4. 运行器实跑时 `V18-conv-access`(`account-worker-lifecycle` 的「放弃正常结算」一条)与 `V18-tools-tests`(36 条,28390 等写死端口被占)首次失败、重跑通过,记「不稳定」;全量里的 `subject_install` 一条也在机器忙时失败过一次、单跑 29/29 通过。都是已知的机器忙偶发那一类,没改测试。

## 7. 对任务书或语义的更正建议

- `ACCEPT-018-map.md` 第 1 节问题 17、问题 1、问题 16 现在有了对应的解决;问题 2、3、14、15 等已被 v18-prod 合入修好(全量里 todo 从 13 降到 6:`DMG-5`、`DMG-6`、`STATE-4`、`STATE-5`、`SEAM-2` 还没转绿,`SEAM-1` 已经通过但还带着 todo 标记,没动它)。
- 地图问题 12(「在线浏览器第一步每人能建多少没有口子」)现在 `server/test/account-create-policy.test.mjs` 在了,清单把它归到 `V18-account-core`(2.1-21)。
- `account-hosted-wiring-probe`、`account-public-user-pages-probe` 是要对真实地址(节点、公网)用的,清单记在 2.1-18 的网络项里,没单独跑。
- `four-stage-deploy-checklist.md` 里 A1「整套」的写法要加 `--rows`、`--no-optional`,并说明 V18 类才是 0.7.18 的依据。

## 8. 没做成的

- 38 行里 25 行本机跑不出「通过」,原因逐行在结论表里:安装包、节点、真实网络、人工、等分支合入、渲染重构;这些是这份清单设计上就标「未跑」的,不是遗漏。
- 端口写死、不在我段里的探针(`account-user-pages-probe` 63xx、`account-conversation-controls-probe` 662x、`cloud-queue-user-pages-probe` 652x、`project-member-controls-probe` 656x、`account-real-runner-probe` 67xx、`account-executor-visible-probe` 664x、`cloud-agent-consent-user-path-probe` 665x、`password-order-probe` 5760 段):登记成 optional 项并写明端口,**没跑**,它们提供的页面证据(2.1-1 页面、2.1-2 列表可点开、2.1-3 界面)现在是「未跑」。要补要么另派一块把它们的端口改成可参数,要么主会话在空闲的 63xx～66xx 上手工跑。
- 老清单里端口在 5xxx/87xx 的 S4-1、S4-2、S4-3(`cloud-agent-run-probe` 写死 8798/5741)没通过运行器跑(不在我的端口段里),所以 2.3-4 的旧模式对照项现在记「未跑」。

## 8.5 实跑的 38 行结论表(2026-10-13,本机,提交 `0a0fdb43`)

命令:`node scripts/acceptance/four-stage-acceptance.mjs --only V18,G0-1,G0-2,G0-3,G0-4,G0-6,S4-4 --no-optional --rows --flaky-rerun 1 --dev-port 29040 --out <目录>`(设了两个账号环境变量)。这台机器上同时有别的子 Agent 在跑全量测试和探针,负载很重,所以有 6 项首次失败、重跑通过,按规矩记「不稳定」、算失败:`V18-auth-agent-path`(2.3-3、2.3-4、2.3-7 因它记失败)、`V18-credentials-support`(2.1-13)、`V18-tools-isolation`(2.3-4,15 条因端口被占)、`V18-tools-tests`(2.1-20);前一遍实跑(提交 `627f0e80`,机器闲些)里这几项除 `V18-conv-access`、`V18-tools-tests` 外都是第一遍就过,单跑也过。**这几行的失败是机器忙,不是产品问题**,发版时在空闲机器上重跑。`G0-2` 两遍各有一条不同的测试被机器忙拖垮(`边改写边读…` 与 `subject_install…`),单独重跑都过,见第 9 节。

### 38 行结论(运行器 `--rows` 原样输出)

- 提交:`0a0fdb43814c5dda53c374161adc14df5d3319a0`;机器 DESKTOP-GS40TCK;2026-10-13T08:04:51.327Z → 2026-10-13T08:53:09.310Z
- 合计 38 行:通过 2、失败 10、未跑 24、不适用 2。规则:一行里只要有一项失败就是失败;有项没跑而其余通过是「未跑」并列出没跑的项,**没跑不算通过**。
- 「没跑」包括:本次没选中的项、人工看的项、要安装包、要部署到节点以后、要真实网络、等某条分支合入、前置没过。

| 行 | 项目 | 结论 | 由哪些清单项得出 | 失败原因 / 没跑的原因 |
|---|---|---|---|---|
| 2.1-1 | 云端登录与限次数 | **未跑** | ✓V18-auth-credentials ✓V18-auth-account-path ✓V18-account-core ·V18-account-pages-probe ·V18-net-public-pages | 没跑:V18-account-pages-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-net-public-pages(要真实网络;本次没选真实网络验证(--level network 只生成待办)) |
| 2.1-2 | 项目权限与两张列表 | **未跑** | ✓V18-auth-account-path ✓V18-account-core ·V18-account-pages-probe ·V18-member-controls-probe | 没跑:V18-account-pages-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-member-controls-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名) |
| 2.1-3 | Agent 共有/私有及发送者 | **未跑** | ✓V18-conv-controls ✓V18-conv-access ✓V18-cloud-chat-tests ·V18-conv-controls-probe ✓V18-operation-history ·V18-operation-wiring | 没跑:V18-conv-controls-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-operation-wiring(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名) |
| 2.1-4 | Agent 已读消息撤回例外 | **通过** | ✓V18-conv-readexception ✓V18-conv-access |  |
| 2.1-5 | 设备退出与延迟撤回 | **未跑** | ✓V18-conv-readexception ✓V18-conv-access ✓V18-conv-password-probe ·V18-password-order | 没跑:V18-password-order(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名) |
| 2.1-6 | 本地项目回归 | **未跑** | ✓V18-files-local-regression ✓V18-local-legacy-tests ·V18-lan-real | 没跑:V18-lan-real(要真实网络;本次没选真实网络验证(--level network 只生成待办)) |
| 2.1-7 | 正常云端文件重开 | **未跑** | ✓V18-files-account-fixture ·V18-gap-file-association ✓V18-reopen-recovery | 没跑:V18-gap-file-association(要人工看:要用户定:账号项目另存为文件再打开,文件里没有「它原来是哪个云端项目」的记号(syncManager.ts enterAccountProject 里 setAssociation(null)),所以「从文件…) |
| 2.1-8 | 过期云端项目转本地 | **失败** | ✓V18-account-core ·V18-gap-file-association ✗V18-files-recovery-states ✓V18-files-old-proc-fixtures ·V18-missing-tests ·V18-missing-probe | 失败:V18-files-recovery-states(有 2 条 todo(已知不成立的断言,npm test 不因它变红)没转绿:ACC018-STATE-4 错误节点上的「没有此房间」(HTTP 404 / no-project):不能当作房间已删除;ACC018-STATE-5 本机凭证被撤销(旧凭证):要认证,不能当作房间已删除) / 没跑:V18-gap-file-association(要人工看:要用户定:账号项目另存为文件再打开,文件里没有「它原来是哪个云端项目」的记号(syncManager.ts enterAccountProject 里 setAssociation(null)),所以「从文件…);V18-missing-tests(等 claude/v18-missing 合入:本检出没有 server/test/cloud-gone-recovery.test.mjs、server/test/legacy-gone-proof.test.mjs…);V18-missing-probe(等 claude/v18-missing 合入:本检出没有 scripts/probes/v18-missing-probe.mjs) |
| 2.1-9 | 非过期与坏文件 | **失败** | ✗V18-files-proc-damage ✗V18-files-recovery-states ✓V18-reopen-recovery ·V18-missing-tests ·V18-missing-probe | 失败:V18-files-proc-damage(有 2 条 todo(已知不成立的断言,npm test 不因它变红)没转绿:ACC018-DMG-5 坏关联(房间号不合法):读取失败时不能先把当前项目的剧本和对话换掉;ACC018-DMG-6 未知的 .proc 文件版本:不能当 v1 静默读入再按 v1 存回(会丢掉不认识的字段));V18-files-recovery-states(有 2 条 todo(已知不成立的断言,npm test 不因它变红)没转绿:ACC018-STATE-4 错误节点上的「没有此房间」(HTTP 404 / no-project):不能当作房间已删除;ACC018-STATE-5 本机凭证被撤销(旧凭证):要认证,不能当作房间已删除) / 没跑:V18-missing-tests(等 claude/v18-missing 合入:本检出没有 server/test/cloud-gone-recovery.test.mjs、server/test/legacy-gone-proof.test.mjs…);V18-missing-probe(等 claude/v18-missing 合入:本检出没有 scripts/probes/v18-missing-probe.mjs) |
| 2.1-10 | 暂时离线改动与冲突 | **不适用** | -V18-na-offline-conflict | 账号任务书第 186 行:归 0.7.19 |
| 2.1-11 | 保存与修改状态检查 | **不适用** | -V18-na-save-state | 账号任务书第 186 行:归 0.7.19 |
| 2.1-12 | 缺失视觉/音频素材 | **未跑** | ✓V18-files-missing-voice ·V18-missing-tests ·V18-missing-bakery-tests ·V18-missing-probe ·V18-missing-online-probe | 没跑:V18-missing-tests(等 claude/v18-missing 合入:本检出没有 server/test/cloud-gone-recovery.test.mjs、server/test/legacy-gone-proof.test.mjs…);V18-missing-bakery-tests(等 claude/v18-missing 合入:本检出没有 server/bakery/audio-mix.test.mjs、server/bakery/export-missing-font.test.mjs);V18-missing-probe(等 claude/v18-missing 合入:本检出没有 scripts/probes/v18-missing-probe.mjs);V18-missing-online-probe(等 claude/v18-missing 合入:本检出没有 scripts/probes/v18-missing-online-probe.mjs) |
| 2.1-13 | 内部核对口与凭证 | **失败** | ✓V18-auth-credentials ✗V18-credentials-support ·V18-linux-os-probes ·V18-net-cert-proxy | 失败:V18-credentials-support(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=1,要 0) / 没跑:V18-linux-os-probes(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-net-cert-proxy(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.1-14 | 备份恢复 | **未跑** | ✓V18-files-account-fixture ·V18-backup-node | 没跑:V18-backup-node(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.1-15 | 最终产品交互验收(运行器本身) | **未跑** | ✓V18-runner-coverage ✓V18-runner-tests ·V18-release-timings | 没跑:V18-release-timings(要人工看:发版动作:node scripts/acceptance/four-stage-acceptance.mjs --rows --out work/four-stage/final/<时间戳> --flaky-…) |
| 2.1-16 | 完整安装包 | **未跑** | ·V18-installer-build ·V18-installer-smoke | 没跑:V18-installer-build(要安装包:git rev-parse HEAD 记来源提交;cd desktop && npm run release -- --from-head(完整安装包与兼容补丁一起出);产物在 desktop/release…);V18-installer-smoke(要安装包:在隔离的安装位置装(不覆盖用户在用的那份):cd desktop && node scripts/smoke-all.mjs <exe 绝对路径>(smoke-boot 加 smoke-shutdown);账…) |
| 2.1-17 | 兼容补丁 | **未跑** | ·V18-installer-compat | 没跑:V18-installer-compat(要安装包:读 desktop/release/manifest-0.7.18.json 与 make-patch.mjs 的 MIN_SHELL_VERSION(0.2.0);做 0.2.0 与 0.2.7 外壳的隔离…) |
| 2.1-18 | 真实网络环境验收 | **未跑** | ·S1-r2 ·S1-r3 ·S2-r1 ·S3-r1 ·S3-r2 ·S3-r3 ·S3-r4 ·S3-r5 ·S3-r6 ·S3-r7 ·S4-r1 ·S4-r2 ·S4-r4 ·S4-r5 ·S4-r6 ·S4-r7 ·V18-net-public-pages ·V18-net-cert-proxy ·V18-net-reconnect ·V18-net-account-limits | 没跑:S1-r2(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S1-r3(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S2-r1(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r1(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r2(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r3(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r4(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r5(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r6(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S3-r7(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r1(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r2(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r4(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r5(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r6(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r7(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-net-public-pages(要真实网络;本次没选真实网络验证(--level network 只生成待办));V18-net-cert-proxy(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-net-reconnect(要真实网络;本次没选真实网络验证(--level network 只生成待办));V18-net-account-limits(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.1-19 | 清理后旧文件验收 | **未跑** | ·V18-gap-file-association ✓V18-files-old-proc-fixtures ·V18-old-files-cleanup | 没跑:V18-gap-file-association(要人工看:要用户定:账号项目另存为文件再打开,文件里没有「它原来是哪个云端项目」的记号(syncManager.ts enterAccountProject 里 setAssociation(null)),所以「从文件…);V18-old-files-cleanup(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.1-20 | 第四阶段剩余工具的验收(= 2.3 的 13 条) | **失败** | ·S4-m5 ✗V18-tools-isolation ✗V18-ui-reverse-channel ✗V18-tools-tests ·V18-wire-wait ·V18-cardsync-wait ·V18-cardsync-probe-wait ·V18-tools-p1-shots ·V18-tools-p3-motion ·V18-tools-p4-subject ·V18-tools-w2-reverse ·V18-tools-c1-collect ·V18-tools-p2-stt ·V18-tools-p5-workflow ·V18-tools-w1-browser ✓行 2.3-1 ✗行 2.3-2 ✗行 2.3-3 ✗行 2.3-4 ·行 2.3-5 ✗行 2.3-6 ✗行 2.3-7 ·行 2.3-8 ·行 2.3-9 ·行 2.3-10 ✗行 2.3-11 ·行 2.3-12 ·行 2.3-13 | 失败:V18-tools-isolation(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=15,要 0);V18-ui-reverse-channel(退出码 1(要 0));V18-tools-tests(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=1,要 0);行 2.3-2(失败:V18-ssr-seam);行 2.3-3(失败:V18-auth-agent-path、V18-ssr-seam);行 2.3-4(失败:V18-auth-agent-path、V18-tools-isolation);行 2.3-6(失败:V18-ui-reverse-channel);行 2.3-7(失败:V18-auth-agent-path);行 2.3-11(失败:G0-2) / 没跑:S4-m5(本次没跑(要人工看));V18-wire-wait(等分支合入:分支 claude/v18-wire 还在做(报告只有开工提交);合入后补接线的单测与端到端命令);V18-cardsync-wait(等 claude/v18-cardsync 合入:本检出没有 server/test/account-card-link.test.mjs、server/test/account-card-sync.test.mjs、…);V18-cardsync-probe-wait(等 claude/v18-cardsync 合入:本检出没有 scripts/probes/account-card-sync-probe.mjs);V18-tools-p1-shots(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-p3-motion(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-p4-subject(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-w2-reverse(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-c1-collect(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-p2-stt(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-p5-workflow(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-tools-w1-browser(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);行 2.3-5(未跑:V18-real-runner-probe、V18-executor-visible-probe、V18-queue-pages-probe、V18-newchat-probe、V18-consent-probe);行 2.3-8(未跑:S4-m3、S4-r4、S4-r5、S4-r6);行 2.3-9(未跑:S4-7、S4-r1、V18-linux-os-probes);行 2.3-10(未跑:S4-m2、V18-doc-semantics-judge);行 2.3-12(未跑:S4-r1、S4-m4、V18-linux-os-probes、V18-release-merge、V18-release-docs);行 2.3-13(未跑:V18-report) |
| 2.1-21 | 在线浏览器第一步(浏览器新建项目) | **未跑** | ✓V18-auth-account-path ✓V18-auth-start-page ✓V18-account-core ·V18-account-pages-probe | 没跑:V18-account-pages-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名) |
| RS18-local | 本地取帧优先 | **未跑** | ·V18-local-first | 没跑:V18-local-first(等分支合入:代码没做(块十,等渲染重构),main 上 git grep -nE "本地取帧/本地优先/localFirst/local-first/preferLocal" -- server src 无命中,没有任…) |
| RS18-queue | 单节点排队 | **未跑** | ✓V18-queue-tests ✓V18-queue-probe ·V18-queue-probe-prod ✓V18-queue-isolation-probe ·V18-queue-507-wait ·V18-queue-node-pressure | 没跑:V18-queue-probe-prod(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-queue-507-wait(等分支合入:没有测试:server/render-node/host.mjs 现在把 507 记成不可重试的失败并暂停认领 10 分钟(块八报告「没做成的」第 3 条),在渲染那一带,等渲染重构合入后做;合入后补一条单…);V18-queue-node-pressure(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| RS18-chat | 50 个对话 | **未跑** | ✓V18-conv-controls ·V18-chats-wait ·V18-chats-probe-wait | 没跑:V18-chats-wait(等 claude/v18-chats 合入:本检出没有 server/test/conversation-delete.test.mjs、server/test/conversation-delete-http.tes…);V18-chats-probe-wait(等 claude/v18-chats 合入:本检出没有 scripts/probes/conversation-delete-probe.mjs) |
| RS-common | 三版本共同回归 | **未跑** | ✓V18-queue-tests ✓V18-queue-probe ✓V18-queue-isolation-probe ·V18-queue-node-pressure ·V18-local-first | 没跑:V18-queue-node-pressure(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-local-first(等分支合入:代码没做(块十,等渲染重构),main 上 git grep -nE "本地取帧/本地优先/localFirst/local-first/preferLocal" -- server src 无命中,没有任…) |
| 2.3-1 | 设计与契约先写好 | **通过** | ✓V18-doc-contracts |  |
| 2.3-2 | 独立入口只经一处载入缝;不动桌面壳 | **失败** | ·S4-m1 ✗V18-ssr-seam ·V18-desktop-shell | 失败:V18-ssr-seam(有 1 条 todo(已知不成立的断言,npm test 不因它变红)没转绿:SEAM-2 独立入口的传递闭包里除 ssr-host 外没有任何文件 import src/) / 没跑:S4-m1(本次没跑(要人工看));V18-desktop-shell(要人工看:命令(只读):git log --oneline release..HEAD -- desktop/ 与 git diff --stat release..HEAD -- desktop/src-tauri/…) |
| 2.3-3 | 独立入口、多用户多项目多对话互不干扰 | **失败** | ·S4-7 ✗V18-auth-agent-path ✗V18-ssr-seam | 失败:V18-auth-agent-path(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=2,要 0);V18-ssr-seam(有 1 条 todo(已知不成立的断言,npm test 不因它变红)没转绿:SEAM-2 独立入口的传递闭包里除 ssr-host 外没有任何文件 import src/) / 没跑:S4-7(本次没跑(本机就能跑)) |
| 2.3-4 | 隔离验收(核心项) | **失败** | ·S4-1 ·S4-2 ✗V18-auth-agent-path ✓V18-account-core ✓V18-asset-isolation ✗V18-tools-isolation ·V18-gap-stop-immediate ·V18-linux-os-probes | 失败:V18-auth-agent-path(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=2,要 0);V18-tools-isolation(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=15,要 0) / 没跑:S4-1(本次没跑(本机就能跑));S4-2(本次没跑(本机就能跑));V18-gap-stop-immediate(要人工看:对口径:workflow/project.md 写「立刻停掉」,账号模式在下一个模型或工具检查点停(ACCEPT-018-map 第 6 节 2.3-4.9);主会话看 V18-auth-agent-path…);V18-linux-os-probes(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.3-5 | 在线页面 | **未跑** | ✓S4-4 ✓V18-conv-endtoend ✓V18-cloud-chat-tests ·V18-real-runner-probe ·V18-executor-visible-probe ·V18-queue-pages-probe ·V18-newchat-probe ·V18-consent-probe | 没跑:V18-real-runner-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-executor-visible-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-queue-pages-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-newchat-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-consent-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名) |
| 2.3-6 | 端到端实测 | **失败** | ·S4-3 ✓S4-4 ·S4-r2 ✓V18-conv-endtoend ✓V18-undo-tests ·V18-real-runner-probe ✗V18-ui-reverse-channel ·V18-cardsync-wait ·V18-cardsync-probe-wait | 失败:V18-ui-reverse-channel(退出码 1(要 0)) / 没跑:S4-3(本次没跑(本机就能跑));S4-r2(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-real-runner-probe(补充项,本次没选中(本机就能跑);加 --include-optional 或 --only 点名);V18-cardsync-wait(等 claude/v18-cardsync 合入:本检出没有 server/test/account-card-link.test.mjs、server/test/account-card-sync.test.mjs、…);V18-cardsync-probe-wait(等 claude/v18-cardsync 合入:本检出没有 scripts/probes/account-card-sync-probe.mjs) |
| 2.3-7 | G 的接口验收(开关、额度、用量) | **失败** | ✗V18-auth-agent-path | 失败:V18-auth-agent-path(不稳定(稳定性 1/2):退出码 1(要 0);输出里没有 /最终结果[:：]零失败/;fail=2,要 0) |
| 2.3-8 | 模型 Key 与真实模型三遍 | **未跑** | ·S4-m3 ·S4-r4 ·S4-r5 ·S4-r6 ✓V18-keys-tests | 没跑:S4-m3(本次没跑(要人工看));S4-r4(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r5(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-r6(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.3-9 | 节点资源 | **未跑** | ·S4-7 ·S4-r1 ✓V18-resource-tests ·V18-linux-os-probes | 没跑:S4-7(本次没跑(本机就能跑));S4-r1(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-linux-os-probes(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办)) |
| 2.3-10 | 语义按 E～J 改好 | **未跑** | ·S4-m2 ✓V18-doc-semantics ·V18-doc-semantics-judge | 没跑:S4-m2(本次没跑(要人工看));V18-doc-semantics-judge(要人工看:人工逐句对:product/agent.md、architecture.md、platforms.md、hosting.md 与决定 E～J;c10-contract.md、c10a-contract.md …) |
| 2.3-11 | tsc、npm test、build 全过 | **失败** | ✓G0-1 ✗G0-2 ✓G0-3 ✓G0-4 ✓G0-6 | 失败:G0-2(退出码 1(要 0);输出里没有 /最终结果:零失败/最终结果：零失败/;fail=1,要 0) |
| 2.3-12 | 合入 main、版本号、部署、release | **未跑** | ·S4-r1 ·S4-m4 ✓V18-resource-tests ·V18-linux-os-probes ·V18-release-merge ·V18-release-docs | 没跑:S4-r1(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));S4-m4(本次没跑(要人工看));V18-linux-os-probes(要部署到节点以后;本次没选真实网络验证(--level network 只生成待办));V18-release-merge(要人工看:要用户授权(原则 4);照 git_and_release.md「release 分支」:基线全绿、npm run build 成功、动了桌面壳所以 desktop/ 的发版构建也要成功;git checko…);V18-release-docs(要人工看:ls server/hosted/deploy / grep agent;grep -n "2b. Agent" docs/plan/hosting-migration.md(这两样现在就在);注意 Agen…) |
| 2.3-13 | 写报告含〔裁〕清单 | **未跑** | ·V18-report | 没跑:V18-report(要人工看:各块报告里的〔裁〕汇总(grep -c "〔裁" docs/reports/AGENT-v18-*.md);补丁信息见 V18-installer-build;发版时在最终提交上给每行重新下结论(账号任务书「…) |

依据一栏的记号:✓ 这一项通过;✗ 失败;· 没跑;- 不适用。

## 9. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force`(运行器 G0-1 与合入 main 之后各一遍) | 退出码 0,零错误 |
| 运行器单测 | `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/four-stage-acceptance.test.mjs server/test/four-stage-acceptance-v18.test.mjs` | 38 条全过(老的 29 条加新的 9 条) |
| 覆盖守门 | `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage` | 「守门:通过」,退出码 0(原来:退出码 1,66 个探针没登记) |
| `cloud-agent-ui-probe.mjs`(S4-4) | 单跑 28 条检查全过、退出码 0(截图在 `docs/reports/assets/v18-runner-list/`);经运行器 `--only S4-4` 再跑一遍 `pass`(116 秒) | 通过 |
| G0-6(被无声跳过的 cards-layout 集成) | 运行器里起 dev server 跑 | `pass`,skipped 0 |
| 全量测试 | `npm test`(设了两个账号环境变量) | 合入 main 前一遍:`tests 6446、fail 0、skipped 12、todo 6`,零失败。合入 main 之后几遍在机器被别的 Agent 占满时各有一条不同的测试失败(`边改写边读…`、`subject_install…`、`account-worker-lifecycle` 的一条、`cloud-tools-*` 的写死端口被占),单独重跑都过;`subject_install` 在满载下反复失败,单独跑 29/29,它的断言「不要重复启动」要求第一个安装作业还在跑,是计时相关,不是这一块的改动(我没碰那个文件)。**交活前最后一遍(合入 main 之后,同一份代码):`tests 6470、pass 6452、fail 0、skipped 12、todo 6`,末行「✓ npm test 最终结果:零失败」,退出码 0。**前一遍同代码在别的 Agent 占满机器时 `subject_install` 一条失败,所以如实写两次:一次红一次绿。 |
| 窗口 | 跑探针前后查可见窗口 | 无;28990～29049 收尾无残留监听 |

没有 `git diff --stat main...HEAD` 里整份被换行尾的已有文件(`cloud-agent-ui-probe.mjs` 是整份重写,正常)。

## 10. 合入 main 27160d3b 之后(第二次合并)

两个冲突文件(`accept-018-conv-endtoend.test.mjs`、`accept-018-files-account-fixture.test.mjs`)取 main 的版本;收掉了清单里传给它们的 `ACCEPT018_E2E_BASE`、`ACCEPT018_FILES_BASE`。**还靠 0.7.18 端口段的**:`--v18-port-base` 现在只管这些项——`V18-auth-*` 三个(`ACCEPT018_AUTH_PORT_BASE`,夹具里 main 仍保留这个口子,我把它的范围检查放宽到 20000～65000)、`V18-asset-isolation`、`V18-conv-password-probe`、两支排队探针与隔离探针(都是 `--base-port` 参数)、`S4-4` 与 `V18-ui-reverse-channel`(`cloud-agent-ui-probe` 自己给任务进程夹具传一组连续端口)。这些夹具内部或探针自己仍要连续段,没有改成自取空闲端口。

第二次合并之后的重跑:`npx tsc -b --force` 零错误;`four-stage-acceptance` 两份单测 38/38;`--check-coverage` 「守门:通过」(main 新进的 13 个探针:Lottie 4 个、合并流 8 个记渲染一带排除,`move-guard-probe` 登记为可选项、单测 `move-guard.test.mjs` 进 `V18-local-legacy-tests`);经运行器跑 `V18-conv-endtoend`(44 秒)、`V18-files-account-fixture`、`V18-local-legacy-tests`、`V18-auth-agent-path` 都 `pass`;`npm test` 一遍 `tests 6498、pass 6471、fail 6`——6 条是机器忙时的计时偶发(`c66-integ` 两条、`asset-project-workers`、`MA-X2`、`UE-S7`、`move-guard` 旧模式搬云端),五个文件单独重跑 37/37 全过。

## 11. 合入 main 16d2404b(渲染重构干净版连同 `claude/v18-missing`)之后

- `V18-missing-tests`、`V18-missing-bakery-tests`、`V18-missing-probe`、`V18-missing-online-probe` 四项去掉「等分支合入」,成正式的本机项(2.1-8、2.1-9、2.1-12 靠它们),两支探针登记进清单(`v18-missing-probe` 的 `--out` 要新目录,放 `{item}/o`)。「等分支合入」名单里 v18-missing 一组去掉,剩 `claude/v18-chats`、`claude/v18-cardsync`(照旧);`claude/v18-wire` 仍是人工项。Lottie、合并流探针上一次已记渲染一带排除。
- 地图问题 4、5、8 随合入修好,`DMG-5/6`、`STATE-4/5` 四条 todo 转成硬断言(全量 todo 6 → 2,剩 `SEAM-2` 及已转绿但还带标记的 `SEAM-1`);本报告第 7 节「还没转绿」的说法以此为准。
- **V18-09 不再因为多了一支没登记的探针而红**:单测只验运行器本身(`--rows-map`、`--rows-from`、覆盖检查的第②③④类);第①类「探针有没有登记」留在命令行 `--check-coverage`(判不过退出码 1,发版前由主会话跑),`--help` 里写明。已用临时加一支未登记探针验证:单测仍过、命令行退出码 1。
