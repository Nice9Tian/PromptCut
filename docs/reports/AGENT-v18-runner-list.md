# AGENT-v18-runner-list:验收运行器补齐 0.7.18 的清单

分支 `claude/v18-runner-list`(从 main `f87e297a` 建,中途 main 前进到 `93fb758d`,只多了计划文档),工作区 `.worktrees/v18-runner-list`,端口段 28990～29049。没改产品代码(`src/`、`server/` 里只动了测试与夹具),没推送、没合并。

几个词:**38 行**指 `ACCEPT-018-map.md` 第 2 节总表(2.1 的 21 行、RS18 的 4 行、2.3 的 13 条)。**清单**指运行器的数据 `scripts/acceptance/four-stage-manifest.mjs`(0.7.18 的项另放 `v18-manifest.mjs`、行号表 `v18-rows.mjs`)。**todo 测试**指 node 测试里标了 `{ todo }` 的断言:现在不成立,失败不让 `npm test` 变红,输出里用 `⚠` 标出。

## 1. 做了什么

1. **38 行全部进清单。** 新增 `V18` 类共 80 多项,每项写 `rows`(它是哪几行的依据)和 `where`(在哪能跑:本机就能跑 / 要安装包 / 要部署到节点以后 / 要真实网络 / 要人工看 / 等分支合入 / 不适用)。老清单里的项补上行号(`OLD_ITEM_ROWS`:G0-1～4 → 2.3-11、S4-1/2 → 2.3-4、S4-3/4 → 2.3-6/5、16 项网络项 → 2.1-18 等)。等分支合入的:`claude/v18-missing`(缺素材与旧云端文件转本地,15 个文件)、`claude/v18-chats`(对话删除,5 个)、`claude/v18-cardsync`(卡片同步,6 个)、`claude/v18-wire`(工具表接线,分支上还没有测试,写成等合入的人工项)、渲染重构(本地取帧优先、预渲染遇 507 留队列)。命令照地图第 4 节与各分支报告抄;那些文件现在不在 main,我没去合它们。合入后文件一出现,这几项自己就会跑(现在记「等分支合入」,不是失败)。
2. **运行器直接出 38 行结论表。** `--rows`:跑完按 38 行出表,打印并写 `<out>/rows-table.md`、`rows-table.json`;`--rows-from <results.json>`:不跑,用已有结果出表;`--rows-map`:不跑,列 38 行各由哪些项覆盖、在哪能跑;`--no-optional`:`--only` 点到类别时也不带 optional 的项;`--v18-port-base`:0.7.18 各项用的端口段起点(缺省 28990)。写进了 `--help`。结论规则:一行里有一项失败(含「不稳定」:首败后复跑才过的)这行就是失败;没失败但有项没跑(人工、安装包、节点、网络、等分支、前置没过、本次没选中)是「未跑」并列出没跑的项;至少一项通过且没有失败和没跑才是「通过」;全不适用才是「不适用」。单测 `server/test/four-stage-acceptance-v18.test.mjs` 固定了这些规则,其中一条:一项都没跑时没有任何一行是通过。
3. **`--check-coverage` 变成真守门**,四类问题任一类出现退出码 1:① `scripts/probes` 下每个文件登记(`covers`)或写明排除原因(原来的 66 个没登记的,有 37 个写了排除原因,其余登记进新项);② 38 行每行至少有一项;③ 清单项引用的测试文件与探针脚本在仓库里(标了等分支合入的单列,按分支分组);④ 全量测试的跳过名单每条写全。现在的输出:`守门:通过`,等分支合入缺的文件单列了 26 个。
4. **问题 17(跳过数)**:不再是「`skipped ≤ 2`」,改成逐条名单(`G0_2_SKIPS`),输出里每条被跳过的测试都得在名单里,多出一条 G0-2 就不过(单测 V18-04)。名单见第 3 节。G0-2 还要求设了账号后端的两个环境变量,没设记「跑不了」,不让用到账号后端的测试悄悄整文件多跳。
5. **问题 16(旧探针)**:`cloud-agent-ui-probe.mjs` 改走账号入口,S4-4 能跑通,见第 4 节。
6. 小改动(都是测试或夹具,默认值不变):`accept-018-conv-endtoend`、`accept-018-files-account-fixture`、`accept-018-conv-password-probe` 的写死端口改成可由环境变量或 `--base-port` 换;`accept-018-auth-kit` 放宽端口基数的范围检查;`account-runner-process.mjs` 夹具多认一个 `publicHandler`;`bakery-deps.test.mjs` 的名单放行新单测;`four-stage-acceptance.test.mjs` 里几处写死的 104/16 项数改成按老清单算。

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

(实跑结果见下一节,待填。)

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

## 9. 验证

(基线与实跑结果见下,待填。)
