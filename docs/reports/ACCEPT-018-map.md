# 0.7.18 逐项验收证据地图（ACCEPT-018-map）

分支 `claude/v18-accept`，起点 `main` 在 `90177e24`（2026-10-13）。`AGENT-018-prep.md` 第 2 节的验收表有 38 行（2.1 的 21 行、2.2 的 RS18 四组、2.3 的 13 条）。本文把每一行拆成子断言，逐条指出 main 上哪条已有的测试或探针能证明、完整命令、看哪一行、实际跑出的结果；没有证据又能在本机验的，补了测试或探针；补不了的写原因。没有改 `src/`、`server/` 下任何产品代码，没有改已有测试和探针。

结构：第 1 节是发现的产品问题（先看）；第 2 节是 38 行总表；第 3 节是新增的测试与探针；第 4 节是发版前主会话照着跑的命令清单；第 5 节是要主会话和用户决定的事；第 6～9 节是各行的子断言明细（按组分，原样来自四个子 Agent 的逐条核对，命令里的 `【前缀】`、`〔PS〕` 等缩写在各组开头有说明）。

几个词：**todo 测试**指 node 测试运行器里的 `test(..., { todo })`：这条断言现在不成立，失败不让 `npm test` 变红，输出里用 `⚠` 标出；它是留着的「红灯」，产品修好后会自己变绿。**块几**指 `AGENT-018-prep.md` 第 5 节十五块拆法的编号。**账号模式**指项目放云端、成员身份由 VisuHive 账号服务核对的路径；**旧模式**指自报用户名加口令的限定进入项目。

"证据新鲜度"：所有"实跑"都是 2026-10-13 在本工作区（main `90177e24` 加本分支新增文件）上跑的，机器上同时有别的子 Agent 在跑。发版前每一行要在最终提交上重跑，旧记录不能顶替。

## 1. 发现的产品问题（按要紧程度）

复现命令都先设两个环境变量 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，再 `npm test -- <文件>`（写法见第 4 节）。凡是 todo 测试，都是这样复现的。

| # | 问题 | 复现 | 期望 | 实际 | 影响的行 |
|---|---|---|---|---|---|
| 1 | **验收运行器的清单里一条新功能都没有** | `node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`（只读） | 账号任务书第 120 行和 prep 第 6.1 节第 2 点：新功能的验收项先加进运行器清单，否则「整套」不含它们 | 退出码 1，`scripts/probes` 下 56 个探针没登记，其中有账号、素材隔离、排队、对话控制、改密退出、新工具的全部探针；`four-stage-manifest.mjs` 里搜不到「账号」；清单仍是 120 项（本地 104、网络 16） | 2.1-15、2.1-18、全部 0.7.18 新功能行 |
| 2 | **页面「停止」在账号模式的进程内执行器组合上回 503，任务既没停也没按时结束** | `npm test -- server/test/accept-018-conv-endtoend.test.mjs` 看 todo「停止：这一轮停下…」 | `product/agent.md`「每个人只能停自己发起的那一轮」；`cloud-agent-task.md` 完成条件 5「停止…都可用」 | `POST /agent/v1/conversations/<id>/abort` 回 503 `agent-fence-pending`（文档服务这边围栏已落账、授权已撤销，Agent 一侧没确认），60 秒内没出 `runner_done` | 2.3-5、2.1-3 |
| 3 | **共有对话里第二位发送者的消息一直排着不开始** | `npm test -- server/test/accept-018-auth-agent-path.test.mjs` 看 todo「共有对话里一个成员的任务结束后…」 | 账号任务书：同一共有对话一次只跑一个任务，别人后发的按到达顺序排队、一轮一轮跑 | A 的任务跑完后 B 在同一对话发的消息 15 秒内没开始；日志 `agent.account.run.pending run-outcome-unavailable`（第一轮的「关闭结算」没接通，prep 第 1 节第 1 项；生产入口还关着）。同项目另一个对话的任务不受影响 | 2.3-3、2.1-3 |
| 4 | **坏关联的文件打不开时，当前项目的剧本和对话已被文件里的换掉** | `npm test -- server/test/accept-018-files-proc-damage.test.mjs` 看 `⚠ ACC018-DMG-5` | 「错误保留原文件，不以空项目覆盖」：打开失败什么都不该动 | `src/editor/io/proc.ts` 第 162 行 `applyProjectAi` 在第 163 行会抛错的 `noteLoadedAssociation` 之前执行；抛错后当前剧本变成文件里的 | 2.1-9 |
| 5 | **未知版本的 .proc 被当 v1 静默读入，再存回会降成 v1 并丢字段** | 同文件 `⚠ ACC018-DMG-6` | 设计「真实旧文件、本地转换与缺失素材」一节：未知版本保留可读原文并显示不支持 | `parseProc` 不看 `version`。分支 `claude/v18-missing` 已改成抛错（读代码判断，合入后实跑确认） | 2.1-9 |
| 6 | **.procp 读包从不校验 CRC** | 同文件 `⚠ ACC018-DMG-7` | 设计的损坏矩阵含「zip 截断/CRC」，报单独错误 | `src/editor/io/procp.ts` 写包算了 CRC、读包不用；条目被改坏照读，素材变成「缺失」，没有「包损坏」提示 | 2.1-9 |
| 7 | **草稿保存不是原子的，落盘中途进程没了，上一份完整草稿被截成半份** | 同文件 `⚠ ACC018-DMG-11` | 设计「落盘中断」；同文件里 `/api/project-backups` 就是先写 `.tmp` 再改名 | `server/vite-plugin-projects.ts` 第 207 行 `fs.writeFileSync` 直接覆盖 | 2.1-9 |
| 8 | **错误节点的「没有此房间」和本机凭证被撤销，恢复协调器都报「已删除」** | `npm test -- server/test/accept-018-files-recovery-states.test.mjs` 看 `⚠ ACC018-STATE-4/5` | 账号任务书：超时、故障、连错节点、认证失败都不叫过期 | `server/recovery/coordinator.mjs` 第 21、51 行直接归 `deleted`；main 上没有转换器所以不会误转，**转换器一接上就会误转**。分支 `claude/v18-missing` 的 `9de16f81` 已改（用 `ACC018_COORDINATOR_FILE` 指到分支副本实测两条转绿） | 2.1-9、2.1-8 |
| 9 | **账号项目保存出来的 .proc 不带云端关联，重开不会连回原云端项目**（功能缺口，**要用户定**） | 读 `src/editor/sync/syncManager.ts` 第 1163 行 `setAssociation(null)`；分支上同一处还在 | `workflow/project.md` 第 23、24 行：保存 .proc 保留房间关联；云端项目仍存在时恢复云端身份 | 账号项目现在只能从网站项目列表点开；文件重开没有"从文件认出是哪个云端项目"这一步，转换器触发条件（带 `where:'hosted'` 关联）也无从成立 | 2.1-7、2.1-8、2.1-19 |
| 10 | **独立入口除载入缝外另有 8 处直接引用 `src/`；已有守门 `CA-SEAM-01` 有洞** | `npm test -- server/test/accept-018-rest-ssr-seam.test.mjs` 看 SEAM-1、SEAM-2（todo） | 完成条件 2 和契约 2.1 节：除 `server/agent/ssr-host.mjs` 外不许 import `src/` | `server/agent/service/perception/subject.mjs:160` 直接载入 `src/kernel/project.ts`（契约点名的目录，CA-SEAM-01 不进子目录所以没拦）；经 `server/agent/*.mjs` 传递闭包还有 `agentScopes.mjs`、`creativity.mjs`、`ai/roles`、`vite-plugin-cards.ts` 引出的三处。棘轮 SEAM-3 把现状 8 处固定为「只许少不许多」 | 2.3-2 |
| 11 | **账号模式下云端 Agent 没接「看画面」，块八的排队在生产路径上用不上**（进度文件已记，这里补可重跑的固定） | `npm test -- server/test/accept-018-rest-queue-account-look.test.mjs` 看 todo `Q-ACC-1` | RS18-queue「Agent see_frames 与预渲染争用」要在云端 Agent 真用的路上成立 | `server/agent-service/main.mjs:343` 只在非账号模式建看画面的客户端 | RS18-queue、RS-common |
| 12 | 在线浏览器第一步「谁可以新建 / 每人能建多少」没有明确的判断口子 | `rg -n "createProject" server/account/authority.mjs`（约 180～215 行）；`rg -in "createPolicy\|maxProjects\|canCreate\|perAccount" server` 无结果 | `online-browser-task.md` 第一步第 4 条：有一个明确的口子，将来改配置就能限制 | 只有「要登录」和 `actor.role !== 'page'`，没有策略函数或配置，也没有按账号数项目。「谁可以新建 = 登录了账号」这半条有并已测。口子的形状没定，没写 todo | 2.1-21 |
| 13 | 账号模式下 HTTP `GET /agent/v1/usage` 回 503 `usage-unavailable` | 起账号模式 Agent 入口后任意成员调该路径（`conversation-policy.mjs` 的 `usage()` 固定抛错） | 完成条件 7：用量记录查得到项目、成员、模型与用量 | 管理命令 `node server/agent-service/admin.mjs usage --project … --json` 能查（已测），HTTP 这一处在账号模式没挂 | 2.3-7 |
| 14 | 不存在的对话的事件流，Agent 入口直接断开连接 | `accept-018-auth-agent-path.test.mjs` 的 todo「不存在的对话…事件流」 | `server/agent-service/http.mjs` 的 `accountEvents` 注释写回 200 加 `{"type":"end","state":"none"}` 或 404 | 直接打是 `socket hang up`，经反向代理是 502；同入口 `GET /v1/conversations/nope` 是干净 404。没泄露内容 | 2.3-4 |
| 15 | 账号模式拒绝过期写入时，回给模型的话是「现在是 rev undefined」，没有期间的改动 | `accept-018-conv-endtoend.test.mjs` 的 todo「过期写入被拒时…」 | 与非账号路径一致（`agent-c65.test.mjs` 第 367 行「现在是 rev 20」） | 写入确实被拒、没覆盖，只是给模型的信息不全；`server/docservice/modules/project.mjs` 第 1042 行那条支路回包缺字段 | 2.3-6 |
| 16 | 旧探针 `cloud-agent-ui-probe.mjs`（运行器 S4-4）在 main 上跑不通 | `node scripts/probes/cloud-agent-ui-probe.mjs --base-port 28580 --doc-port 28587 --asset-port 28588 --agent-port 28589 --phases online --dist <在线构建> --out <临时目录>` | 宽屏 AI 栏、「云端」接入方式、手机占位 | 第 3 项 `等 [data-pc="join-form"] 超时`：它走旧口令加入，在线页面入口现在是账号登录。需按账号模式改写 | 2.3-5、2.3-6 |
| 17 | 运行器 G0-2 的 `skipped ≤ 2` 与全量测试实际跳过数不符 | `scripts/acceptance/four-stage-manifest.mjs:182` | — | 全量 `npm test` 实跑 `ℹ skipped 8`，运行器 G0-2 会判不过，见 4.1 | 2.1-15 |

一级文字（用户看到的字），我没改，请用户定：在线开始页按钮写的是「新建云端项目」（`src/account/AccountProjects.tsx`），语义 `workflow/project.md` 第 13 行写的是「新建项目」；未登录时界面是登录表单加「加入别人的项目」，没有任务书说的「需要登录账号」这句字。

对底稿的更正：
- prep 第 1 节第 5 项「main 上搜不到 `goneProof`」只对一半：文档服务一侧的签发已在 main（`server/account/authority.mjs` 第 340～351 行 `status` 回带 Ed25519 签名的 `state:'gone'`；公开路由 `GET /hosted/shared/account/status`；`account-projects-provider.test.mjs` 17/17）。缺的是客户端核对和转换。
- 「块四尚未派出」不准确：分支 `claude/v18-missing` 里已有 `9de16f81`（旧云端项目凭证明转本地）、`65a991d7`（文档服务墓碑与公开查询、客户端核对）、缺素材的提交；该分支报告目前还是空壳。
- prep 第 8 节第 6 条（`account-projects-provider.test.mjs` 变量名不一致）已过时：现在读 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`，17 条在跑。
- prep 第 2.3 节第 4 行「素材那一条依赖第 2 项的素材隔离」：`asset-account-isolation-probe.mjs`（块六）已在 main，158 项全过，但它明说不含轨道流和渲染工作进程。
- 设计第 26 行说的 `product/agent.md` 运行位置旧段落：核实 main 上已没有「同用户名」「主人独享」「一律停」字样；`mechanism/agent.md` 第 79 行的主人键旧方案和 `cloud-agent-contract.md` 7.2、`CA-CHAT-03` 的自动淘汰在正文里没删（只加了说明）。
- 任务简报里说「受控模型 rehearsal-model」：`rehearsal-model.mjs` 读的是桌面版真实模型配置；受控模型是脚本式 mock 提供方（提示词里放 ```mock-script```），所有端到端都用的它。
- `m8-no-lan.test.mjs` 测的是跨机探针里 netstat 输出解析的小工具，不是局域网回归证据，没算进 2.1-6。
- 运行器 `cloud-queue-*` 的几份测试验的是对话消息排队，不是渲染看画面队列。
- 桌面壳：`git diff --stat release..HEAD -- desktop/` 有 13 个文件（壳 4 个，+215 −6，含新增 `account_vault.rs`；脚本 9 个），所以「不动桌面壳」按字面不成立（也影响 prep 第 6.2 节外壳版本号的判断）。

## 2. 38 行总表

状态三档：**有**＝所有适用子断言都有现成可跑的证据且跑过；**部分**＝一部分有，缺的在"缺什么"里；**没有**＝没有可跑的证据。"不适用"单列。

统计：**有 3 行**（2.1-4、2.1-6、2.3-1）；**部分 26 行**；**没有 7 行**（2.1-16、2.1-17、2.1-18、2.1-19、RS18-local、2.3-12、2.3-13）；**对 0.7.18 不适用 2 行**（2.1-10、2.1-11，归 0.7.19）。合计 38。

| 编号 | 项目 | 状态 | 缺什么 / 在哪验 |
|---|---|---|---|
| 2.1-1 | 云端登录与限次数 | 部分 | 服务端公网路径各条都有；缺真浏览器页面证据（探针要先构建在线版并占固定 63xx 端口） |
| 2.1-2 | 项目权限与两张列表 | 部分 | 服务端各条都有；列表「可点开」只验到地址形状，未真点 |
| 2.1-3 | Agent 共有/私有及发送者 | 部分 | 服务端全有（含「停任务的权限」，补了测试）；界面探针夹具锁端口 6620～6639 未跑；产品问题 2、3 |
| 2.1-4 | Agent 已读消息撤回例外 | **有** | 改密退出、被踢各验；被踢情形下共有已读任务继续只验到授权层，进程层只有改密退出一种；「其修改不撤回」归 0.7.20 |
| 2.1-5 | 设备退出与延迟撤回 | 部分 | 页面与四服务确认一致（真浏览器 47/47）、通知丢失/重复/重启续办都有；页面点「不退出」无探针；撤回范围归 0.7.20 |
| 2.1-6 | 本地项目回归 | **有** | 本机替身层面全有；跨机真实组播（`shared-project-lan.mjs`）要第二台机器，未跑 |
| 2.1-7 | 正常云端文件重开 | 部分 | 「连原项目、用云端最新、不被旧文件覆盖」有真实组合证据；「文件认出云端项目」没有（产品问题 9） |
| 2.1-8 | 过期云端项目转本地 | 部分 | 只有文档服务一侧签发「已删证明」在 main；转换要等 `claude/v18-missing` 合入 |
| 2.1-9 | 非过期与坏文件 | 部分 | 输入矩阵和多数损坏细节有证据；4 个损坏细节与 2 个归类不成立（产品问题 4～8） |
| 2.1-10 | 暂时离线改动与冲突 | 不适用 | 账号任务书归 0.7.19 |
| 2.1-11 | 保存与修改状态检查 | 不适用 | 账号任务书归 0.7.19 |
| 2.1-12 | 缺失视觉/音频素材 | 部分 | main 上只有那段人声文件本身；其余在 `claude/v18-missing`，合入后照 6.7 的清单跑 |
| 2.1-13 | 内部核对口与凭证 | 部分 | 本机能验的都有；同机其他 OS 用户、真 nginx、节点日志要部署后验 |
| 2.1-14 | 备份恢复 | 部分 | 本机在真实数据布局上演练了全流程；仓库没有备份/恢复脚本（10-09 是节点一次性脚本）；部署前要在当时数据上重做 |
| 2.1-15 | 最终产品交互验收 | 部分 | 运行器能列能跑，但新功能没进清单（产品问题 1）；首败复跑记「不稳定」、release-timings 是发版动作 |
| 2.1-16 | 完整安装包 | 没有 | 要安装包 |
| 2.1-17 | 兼容补丁 | 没有 | 要安装包（0.2.0 与 0.2.7 两个隔离副本） |
| 2.1-18 | 真实网络环境验收 | 没有 | 要部署到节点；运行器 16 项网络清单已能列出，一项也没执行 |
| 2.1-19 | 清理后旧文件验收 | 没有 | 要节点上先删旧项目（要用户点头）；本机已造好合成旧文件夹具 |
| 2.1-20 | 第四阶段剩余工具的验收（= 2.3） | 部分 | 指向 2.3 的 13 条 |
| 2.1-21 | 在线浏览器第一步 | 部分 | 服务端各条都有；界面只验了未登录首屏的静态渲染；产品问题 12 |
| RS18-local | 本地取帧优先 | 没有 | 代码没做（块十，等渲染重构）；`git grep` 在 main 上无命中 |
| RS18-queue | 单节点排队 | 部分 | 本机替身上有（含探针 14 条）；缺：账号生产路径（产品问题 11）、预渲染遇 507 时留队列（要等渲染重构）、真实内存/磁盘压力（节点） |
| RS18-chat | 50 个对话 | 部分 | 49→50→第 51、多发送者、另一人/项目、并发 60 个恰好 50 成功都已补测；删除相关等 `claude/v18-chats` 合入 |
| RS-common | 三版本共同回归 | 部分 | RS18-queue、取消、失败兜底、授权有证据；RS18-local 整组、跨版本、度量记录没有 |
| 2.3-1 | 设计与契约先写好 | **有** | 八项都能指到契约章节（grep 核对，不是自动测试） |
| 2.3-2 | 独立入口只经一处载入缝；不动桌面壳 | 部分 | 证据能跑，但前半句现状不成立（产品问题 10），桌面壳按字面也不成立 |
| 2.3-3 | 独立入口、多用户多项目多对话互不干扰 | 部分 | 账号模式真实测试有；同对话多发送者有缺口（产品问题 3）；桌面版「全部测试不变红」靠全量 |
| 2.3-4 | 隔离验收（**核心项**） | 部分 | 账号模式的新断言都过，旧模式探针 29/29，素材隔离探针 158/158；「只读成员」要用户定；素材不含轨道流与渲染工作进程 |
| 2.3-5 | 在线页面 | 部分 | 接口层（发消息、流式、工具过程、重开）有；宽屏 AI 栏、「云端」接入、手机占位无账号模式浏览器证据（产品问题 16）；「停止」不通（产品问题 2） |
| 2.3-6 | 端到端实测 | 部分 | 账号模式下改文案、挪片段、调卡片参数、署名、两成员互不串都补了；撤销只有非账号模式；进程被杀自动拉起要节点；桌面版要安装包 |
| 2.3-7 | G 的接口验收 | 部分 | 账号模式「拒绝」「用量查询」有真实任务证据；「设回不限后恢复」只到闸这一层；产品问题 13 |
| 2.3-8 | 模型 Key 与真实模型三遍 | 部分 | 只有加密分发机制的单测；其余要节点和真实模型 |
| 2.3-9 | 节点资源 | 部分 | 上限在代码与部署模板里有单测；满载前后对比数字只能在节点测 |
| 2.3-10 | 语义按 E～J 改好 | 部分 | E～J 在 `docs/semantics/` 都找得到；契约同步与草稿「步骤 3」出处只核到文件在 |
| 2.3-11 | tsc、npm test、build 全过 | 部分 | tsc 与 npm test 见 4.1；`npm run build` 未跑（见 4.1） |
| 2.3-12 | 合入 main、版本号、部署、release | 没有 | 发版动作；只有「模板与迁移文档补上了 Agent 服务」一句现在能查，已在 |
| 2.3-13 | 写报告含〔裁〕清单 | 没有 | 发版收尾动作 |

## 3. 新增的测试与探针

全部以 `accept-018-` 开头，没有改任何已有文件。`npm test` 扫得到的是 `server/test/accept-018-*.test.mjs`。一起跑：`npm test -- server/test/accept-018-*.test.mjs server/test/windows-hide-silent-spawn.test.mjs`，实跑（2026-10-13）：tests 79，pass 66，fail 0，todo 13，skipped 0，末行「✓ npm test 最终结果：零失败」，约 1 分 42 秒（含窗口守门测试）。

| 文件 | 验什么 | 结果 |
|---|---|---|
| `server/test/fixtures/accept-018-auth-kit.mjs` | 底座：搭账号模式云端 Agent 全链，端口可指定，文档服务时钟可前拨 | （不是测试） |
| `accept-018-auth-credentials.test.mjs` | 2.1-13、2.1-1：内部口无证书/假证书/别的服务身份/明文/自报回环都被拒；公网无内部路由；退出后恢复凭证与令牌撤销；扫数据目录与输出里 8 个秘密值（先放金丝雀）；错误名称与密码同文案；网站与编辑器共用限次数 | 5/5 |
| `accept-018-auth-account-path.test.mjs` | 2.1-2、2.1-21 服务端：新建前必须登录、创建者归账号、换设备仍是创建者、两张列表按账号分、被踢两设备都 403 | 6/6 |
| `accept-018-auth-agent-path.test.mjs` | 2.3-3、2.3-4、2.3-7：五个账号六七个项目的真实 Agent 全链 | 7 过 + 2 todo |
| `accept-018-auth-start-page.test.mjs` | 2.1-21：真实 `AccountProjects.tsx` 服务端渲染未登录首屏 | 1/1 |
| `accept-018-conv-stack.mjs`、`accept-018-conv-runner-fixture.mjs` | 底座（后者复制自 `account-real-runner.mjs`，只改三处） | （不是测试） |
| `accept-018-conv-controls.test.mjs` | 2.1-3 全部服务端子断言 + RS18-chat | 6/6 |
| `accept-018-conv-readexception.test.mjs` | 2.1-4 全部子断言 + 2.1-5 的「选否」 | 9/9 |
| `accept-018-conv-endtoend.test.mjs` | 2.3-6 账号模式端到端、2.3-5 接口层（占 28580～28588） | 2 过 + 2 todo，约 90～170 秒 |
| `scripts/probes/accept-018-conv-password-probe.mjs` | 2.1-5：真浏览器，改密选退出，页面「已退出」与四服务真实确认一致（复制自 `account-password-user-path-probe.mjs`，只把写死端口换成 28580～28589） | 47/47（本次最终复跑 `{"passed":47,"failed":0,"completed":true}`） |
| `accept-018-files-local-regression.test.mjs` | 2.1-6：账号模式云端文档服务与本机局域网主机同进程，局域网上走自由/限定进入、邀请码、主机/成员 | 5/5 |
| `accept-018-files-account-fixture.test.mjs` | 2.1-7、2.1-14：旧文件内容重开不覆盖云端；备份恢复演练（占 28590～28596） | 2/2 |
| `accept-018-files-proc-damage.test.mjs` | 2.1-9 损坏细节 | 7 过 + 4 todo |
| `accept-018-files-recovery-states.test.mjs` | 2.1-9 输入矩阵喂真实恢复协调器；可用 `ACC018_COORDINATOR_FILE` 指向分支副本 | 4 过 + 2 todo |
| `accept-018-files-old-proc-fixtures.mjs` + `.test.mjs` | 2.1-8、2.1-19 用的合成旧文件矩阵（7 份样本，哈希固定）及自检 | 2/2；不能代替真实旧文件 |
| `accept-018-files-missing-voice.test.mjs` | 2.1-12：占位人声文件与契约一致（131,564 字节、PCM16/48kHz/单声道、1.37 秒） | 2/2（第二条只是文本扫描，说服力弱） |
| `accept-018-rest-ssr-seam.test.mjs` | 2.3-2：独立入口对 `src/` 的依赖扫描（含棘轮） | 3 过 + 2 todo |
| `accept-018-rest-queue-account-look.test.mjs` | RS18-queue：账号模式有没有接看画面 | 1 过 + 1 todo |

13 条 todo 对应第 1 节：产品问题 2、3、4、5、6、7、8、10、11、14、15。（`proc-damage` 的 4 条＝问题 4～7，`recovery-states` 的 2 条＝问题 8，`ssr-seam` 的 2 条＝问题 10，`auth-agent-path` 的 2 条＝问题 3、14，`conv-endtoend` 的 2 条＝问题 2、15，`queue-account-look` 的 1 条＝问题 11。）

## 4. 发版前主会话照着跑的命令清单

约定：下面 Bash 写法在 Git Bash 里用；PowerShell 的等价写法是把 `export A=… B=…;` 换成 `$env:A='…'; $env:B='…';`。「两个变量」指

```
PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive
PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs
```

不设这两个变量，用到真实账号后端的测试会整文件**跳过**（不是通过）。单个或一批测试文件必须用 `npm test -- <文件…>`，不裸跑 `node --test`。耗时只是参考（这台 PC，别的子 Agent 同时在跑），不是通过条件。

```
cd /c/Users/admin/Documents/PromptCut/<发版工作区>
export PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive' PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs' PROMPTCUT_NO_PORT_FILE=1
```

### 4.1 基线（先跑，串行）——本次在 `claude/v18-accept` 上的实跑

| 项 | 命令 | 结果（2026-10-13） | 约耗时 |
|---|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 | 19 秒 |
| 窗口守门 | `npm test -- server/test/windows-hide-silent-spawn.test.mjs` | 通过（含在下一行的 79 条里，扫的是 `scripts/` 整棵树，新探针在内） | 数秒 |
| 本分支新增测试 | `npm test -- server/test/accept-018-*.test.mjs server/test/windows-hide-silent-spawn.test.mjs` | tests 79 / pass 66 / fail 0 / todo 13 / skipped 0，末行「零失败」 | 1 分 42 秒 |
| 全量测试，第 1 次 | `npm test` | tests 6223 / pass 6199 / **fail 3** / skipped 8 / todo 13，退出码非 0 | 2 分 48 秒 |
| 全量测试，第 2 次（同一份代码，未改动） | `npm test` | tests 6223 / pass 6202 / **fail 0** / cancelled 0 / skipped 8 / todo 13，末行「✓ npm test 最终结果：零失败」，退出码 0 | 1 分 55 秒 |

第 1 次的 3 个失败，逐个单独重跑：
- `server/test/account-real-runner.test.mjs`「actual hosted factory signs WSS/project.open…」：`listen EADDRINUSE 127.0.0.1:6700`（夹具 `fixtures/account-real-runner.mjs` 写死 6700～6709；`account-task-worker-child.test.mjs`、`agent-worker-session.test.mjs`、`env-fingerprint-keys.test.mjs` 也含 6700）。单独重跑 1/1 通过。
- `server/test/agent-live-selection.test.mjs`「account get_selection uses the active Agent data connection…」：等 `actual model tool route` 超时 8000 ms。是 `018-common.md` 第 25 行点名的已知忙时偶发。与 `hosted-render-queue.test.mjs` 一起单独重跑，10/10 通过。
- `server/test/hosted-render-queue.test.mjs`「RQ7 撤回、没人来问、排队等到头…」：断言「没人问的那个撤了，有人问的还排着」得到空数组。**不在已知偶发名单里**。单独重跑通过（上一行的 10/10），收口前的另一次单跑 9/9 也通过；看起来是计时相关，机器忙时才出现，主会话遇到请再单独重跑并如实记两次。
- 发现一个更大的一批：把 51 个"现有证据"文件（见 4.2.2）放在一条命令里并发跑，第 1 次 451 条里 2 条失败（`account-logout-confirmation`「退出确认…」和 `account-real-runner`），都是 66xx/67xx 写死端口被别的进程占了；紧接着复跑 455/455 全过。**写死 66xx/67xx/58xx 端口的文件不能和别的工作区的同名文件同时跑**。

`skipped 8`：进度文件三处记的是 3（`three-versions-progress.md` 第 35、38 行），运行器 G0-2 的通过条件是 `skipped ≤ 2`（`scripts/acceptance/four-stage-manifest.mjs:182`）。8 条跳过里有 5 条是块七 P2（语音转写）的真实集成测试，本树没有准备依赖时整文件跳过。运行器 G0-2 会因此判不过，发版时要在清单里把上限改成实际数并写明是哪几条（产品问题 17）。

`npm run build` 和 `desktop/` 下的发版构建这次没跑（2.3-11 里属于发版动作）。

### 4.2 可并行的分组

机器内存吃紧时（本次探针曾因此慢到 8 分 40 秒）同时开的重进程不要超过 3 个。下面标「固定端口」的不能与别处同名工作区的同一组并行。

#### 4.2.1 组 A：本分支新增的测试（1～2 分钟，端口自选）

```
npm test -- server/test/accept-018-*.test.mjs
```
期望 tests 78 / pass 66 / fail 0 / todo 13（不含窗口守门那一条）。13 条 todo 是产品问题的红灯，修好一个就会自己变绿（把对应 `{ todo }` 去掉即成为硬断言）。
端口：`auth` 组缺省在 31000～37999 随机挑，手动指定用 `ACCEPT018_AUTH_PORT_BASE=<连续 10 个空端口起点>`；`conv-endtoend` 占 28580～28588；`files-account-fixture` 占 28590～28596。别的工作区同时跑同一组时改这两个起点或错开。

#### 4.2.2 组 B：现有证据文件包（2～3 分钟）

```
npm test -- $(cat docs/reports/ACCEPT-018-evidence-files.txt)
```
清单在 `docs/reports/ACCEPT-018-evidence-files.txt`（51 个文件，一行一个，均在 main 上，逐行证据见第 6～9 节）：
`server/test/` 下的 account-assembly-central、account-assembly-run-internal、account-dual-user-path、account-logout-confirmation、account-member-controls、account-password-user-path、account-projects-provider、account-real-runner-sse、account-real-runner、account-v2-deploy-config、account-v2-install-plan、account-worker-lifecycle、agent-access-conversation、agent-access-http、agent-read-control、auth-create、auth-handshake、auth-members、c10a-invite、c65-undo、c65b-agent、cloud-agent-keys、cloud-agent-look、cloud-agent-runs、cloud-agent-service、cloud-agent-wiring、cloud-queue-http、hosted-render-capacity、hosted-render-isolation、hosted-render-look、hosted-render-memory、hosted-render-queue、hosted-render-usercards、invite-impl、reopen-hosting、reopen-recovery、run-authority-core、run-authority-crash、sp-lan、asset-lan-discover（均加 `.test.mjs`）；`src/account/` 下的 assetTicket、client、desktopVault；`src/ai/cloud/cloud-chat`；`src/editor/sync/` 下的 enterFailure、hostedServices、onlineSync、presence、reconnect；`src/online/` 下的 c10a-api-guard、onlinePrune（均加 `.test.mjs`）。
实跑：455 条全过（第 1 次并发撞端口 451 条里 2 条失败，见 4.1，复跑全过），约 50 秒。其实全量 `npm test` 已包含它们；单列是为了发版时按行取证。

#### 4.2.3 组 C：真浏览器与多服务探针（每支独立，串行或最多并行 2 支）

先构建一份在线版（一次，约 4 秒）：
```
node node_modules/vite/bin/vite.js build --mode online --outDir <临时目录>/dist --emptyOutDir
```
（在发版工作区根目录下；依赖向上解析，`node_modules` 不在工作区里时路径按实际改。）

| 探针 | 命令 | 端口 | 期望 | 约耗时 | 对应行 |
|---|---|---|---|---|---|
| 改密选退出，页面与四服务确认一致 | `node scripts/probes/accept-018-conv-password-probe.mjs --dist <在线构建> --site-root C:\Users\admin\Documents\VisuHive\site --out <临时目录>/pw` | 28580～28589 | `summary.passed 47, failed 0, completed true` | 15～40 秒 | 2.1-5 |
| 素材按项目隔离（账号模式） | `node scripts/probes/asset-account-isolation-probe.mjs --base-port <起点> --out <临时目录>/aiso` | 起点起 5 个（本次 28575） | `passed 158, failed 0` | 95 秒 | 2.3-4 |
| 云端 Agent 隔离（旧模式，对照） | `node scripts/probes/cloud-agent-isolation-probe.mjs --doc-port A --asset-port B --agent-port C --render-port D --no-look` | 4 个（本次 28570～28573） | `{"ok":true,"passed":29,"failed":[]}` | 约 3.5 分钟 | 2.3-4 |
| 云端排队（缩短版） | `node scripts/probes/hosted-render-queue-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568 --idle-ms 20000` | 28560～28568 | 退出码 0，14 条全过，`"fails":[]` | 本次 8 分 40 秒（机器忙；闲时几分钟） | RS18-queue |
| 云端排队（生产五分钟版） | 同上去掉 `--idle-ms 20000` | 同上 | 同上，且 `realIdle:true` | 约 10 分钟以上 | RS18-queue |
| 云端 Agent 进程被杀与重开 | `node scripts/probes/cloud-agent-run-probe.mjs`（固定 8798、5741，先确认空着） | 固定 | C1～C4、17/17 | 数分钟 | 2.3-6 |
| 对话共有/私有的真浏览器 | `node scripts/probes/account-conversation-controls-probe.mjs --dist <在线构建> --site-root C:\Users\admin\Documents\VisuHive\site --out <临时目录>/cc` | **固定 6620～6639**（夹具断言 agentPort 必须在这段内） | 全部检查过 | 本次未跑 | 2.1-3 |
| 改密退出的原始探针（对照） | `node scripts/probes/account-password-user-path-probe.mjs --dist … --site-root … --out …` | 固定 6680～6689 | 47/47 | 约 40 秒 | 2.1-5 |
| 账号网页与项目列表的真浏览器 | `node scripts/probes/account-user-pages-probe.mjs …`（先构建在线版；参数看文件头） | 固定 6340～6342、6388 | 见 6 节 2.1-1、2.1-2 | 本次未跑 | 2.1-1、2.1-2、2.1-21 |

每支探针前后各查一次可见窗口：`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg' }`，有就停掉自己起的那棵进程树。

#### 4.2.4 组 D：运行器（只读列表，数秒）

```
node scripts/acceptance/four-stage-acceptance.mjs --list
node scripts/acceptance/four-stage-acceptance.mjs --matrix
node scripts/acceptance/four-stage-acceptance.mjs --check-coverage     # 现在退出码 1：产品问题 1
node scripts/acceptance/four-stage-acceptance.mjs --list --level network
```
`--list`：120 项（本地 104、网络 16，可选 13）。发版时整套：`node scripts/acceptance/four-stage-acceptance.mjs --out work/four-stage/final/<时间戳> --flaky-rerun 1 --release-timings "0.7.18"`——**在新功能进清单（产品问题 1）之前，跑完全绿也不代表账号、素材隔离、排队、改密退出被验过**。

### 4.3 要等某一块合入后再跑

| 等什么 | 合入后跑什么 | 出处 |
|---|---|---|
| 分支 `claude/v18-missing` | 第 8 节 2.1-12 / 2.1-8 / 2.1-9 末尾「合入后照着跑」清单（`v18-missing-probe.mjs`、`v18-missing-online-probe.mjs`、`accept-018-files-recovery-states` 用 `ACC018_COORDINATOR_FILE` 指分支协调器副本、`accept-018-files-proc-damage` 的 DMG-6 应转绿）；之后把相应 `{ todo }` 去掉 | 第 8 节 |
| 分支 `claude/v18-chats` | RS18-chat 的删除子断言（删后重建/重开、删后立刻让出名额、谁能删、有任务在跑先停再删）；它的报告 `docs/reports/AGENT-v18-chats.md`（在分支上）列了验收 | 第 7 节 RS18-chat |
| 块一的"关闭结算"接生产路径（`claude/v18-runner` 上做） | 产品问题 2、3 的两条 todo 应转绿；`accept-018-conv-endtoend` 的"停止" | 第 1 节 |
| 块十（本地取帧优先，等渲染重构） | RS18-local 整组；目前只能核实 main 上没有 | 第 9 节 |
| 最后的接线包（工具表接线、看画面接账号模式） | 产品问题 11 的 `Q-ACC-1` 转绿 | 第 1 节 |

### 4.4 要安装包或要部署到节点后才能跑

2.1-16 完整安装包、2.1-17 兼容补丁、2.1-18 真实网络 16 项、2.1-19 清理后旧文件、2.3-8 真实模型三遍、2.3-9 节点资源对比、2.3-12 发版动作、2.1-14 在节点当时数据上重做备份恢复、2.1-13 里同机其他 OS 用户与真 nginx：命令和步骤在第 9 节对应行。一项也没执行。

## 5. 要主会话和用户决定的事

给主会话：
1. 运行器清单要把账号、素材隔离、排队、改密退出、对话上限、新工具的探针加进去（产品问题 1）。哪些进"本地一级默认集合"、哪些作可选项，由主会话定；本分支新增的 `accept-018-*` 探针和测试也没登记（`--check-coverage` 会列出）。
2. 运行器 G0-2 的 `skipped ≤ 2`（产品问题 17），全量实测是 8。
3. `account-real-runner` 一族夹具写死 6700～6709、`account-password-user-path` 写死 6680～6689、`account-conversation-controls` 夹具断言 6620～6639：和 v18-ports 那一块的做法（向系统要空闲端口）不一致，机器上同时有多个工作区跑全量时会撞（本次全量就撞了一次）。这一块没动，请决定是否另派一块把它们也改成要空闲端口；没改的话，发版全量只能一个工作区一个工作区地跑。
4. `hosted-render-queue.test.mjs` 的 RQ7 在全量里失败过一次（单跑过），不在已知偶发名单里，请留意。
5. 产品问题 2、3 依赖块一"关闭结算"接到生产路径（`claude/v18-runner` 上正在做），合入后请跑第 4.3 节那一行。
6. 本分支的 todo 测试合入 main 后会让全量里 `ℹ todo` 多出 13；它们不让 `npm test` 变红。修一个产品问题时同时把对应 `{ todo }` 去掉。如果你不想让 main 带着 todo，可以只合报告不合这几个测试文件，或让我把 todo 测试换成放在 `scripts/probes/` 下的独立脚本。

给用户（白话背景、选项、后果、我的建议）：
1. **"只读成员"要不要作为 0.7.18 的承诺。** 背景：`cloud-agent-task.md` 完成条件 4 有一句"只读成员不能操作 Agent，发消息这一步就被拒"，但现行语义里没有"只读成员"这种身份；文档服务里每个成员的权限有读写 `rw` 和只读 `r` 两种，只是界面上没有地方设。选项 A：承诺（要给创建者一个把成员设成只读的入口，属于一级界面，要用户先定样子）。选项 B：这一句改成"不适用"。现状：我按 `r` 权限落了断言，成员设成 `r` 后发消息被拒、改回读写恢复，已通过。后果：A 要多做一块界面；B 不用。建议 B（0.7.18 不加入口），保留已通过的服务端断言。
2. **账号项目保存出来的 .proc 要不要带云端关联。** 背景：现在用户把账号项目"另存为文件"再双击打开，文件里没有"它原来是哪个云端项目"的记号，打开后只是一份没有云端身份的本地内容，没法"连回原项目、采用云端最新版"；过期转本地的触发条件也依赖这个记号（产品问题 9）。选项 A：保存时写入关联（不含密码令牌），重开时先问文档服务该项目还在不在，在则连回，已删（有签名证明）才转本地。选项 B：账号项目只能从网站项目列表打开，文件当作普通本地文件。后果：A 要改 `syncManager.ts` 和文件格式，是二级语义，且 2.1-7、2.1-8、2.1-19 才有得验；B 则这三行里"从文件重开"要改成不适用。建议 A，因为账号任务书的 2.1-7、2.1-8、2.1-19 三行都以它为前提。
3. **创建者能不能停别人私有对话里的任务。** 背景：代码是允许的（创建者能看私有对话、能停任何人的任务），任务书原文没明说创建者能停别人**私有**对话里的任务，只说"创建者能停任何人的"。选项：保持现状 / 禁止。建议保持现状（私有对话创建者本来就能看，停任务是安全阀）。
4. **在线开始页的字**：按钮现在写"新建云端项目"，语义写"新建项目"；未登录时没有"需要登录账号"这句。这是一级文字，请用户定。

## 6. 明细：账号认证与隔离（组 auth）

### 组 auth 的段落（2026-10-13，工作区 `.worktrees/v18-accept`，分支 `claude/v18-accept`，没有 git add / commit）

负责的行：2.1-13、2.3-4、2.3-3、2.3-7、2.1-1、2.1-2、2.1-21。

#### 通用跑法（下文每条「命令」都是这套的缩写）

PowerShell：
```
cd C:\Users\admin\Documents\PromptCut\.worktrees\v18-accept
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive'; $env:PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'
npm test -- <文件…>
```
Bash：
```
cd /c/Users/admin/Documents/PromptCut/.worktrees/v18-accept
export PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive' PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'
npm test -- <文件…>
```
VisuHive 一侧（只读跑它自己的测试命令，不改）：`cd C:\Users\admin\Documents\VisuHive; npm test`（Bash：`cd /c/Users/admin/Documents/VisuHive && npm test`，不要环境变量）。

几次汇总跑的结果，下文按名字引用：

| 代号 | 命令 | 结果 | 约耗时 |
|---|---|---|---|
| R-VH | VisuHive `npm test` | 101 条，通过 91，失败 0，跳过 10，退出码 0。跳过的 10 条：Linux 真 nginx（要 root 窗口）、POSIX 文件权限 4 条（Windows 的权限位不算证据）、「accepted-message provider」6 条（要等账号侧该口接入） | 7.4 秒 |
| R-1 | `npm test -- server/test/account-projects-provider.test.mjs server/test/account-v2-deploy-config.test.mjs server/test/account-assembly-run-internal.test.mjs src/account/desktopVault.test.mjs` | 29 条全过，退出码 0 | 9 秒 |
| R-2 | `npm test -- server/test/agent-access-conversation.test.mjs server/test/agent-access-http.test.mjs server/test/account-real-runner.test.mjs server/test/account-assembly-central.test.mjs server/test/account-dual-user-path.test.mjs` | 11 条全过，退出码 0 | 8 秒 |
| R-3 | `npm test -- server/test/cloud-agent-service.test.mjs server/test/cloud-agent-runs.test.mjs src/account/client.test.mjs src/account/assetTicket.test.mjs server/test/account-member-controls.test.mjs` | 63 条全过，退出码 0。**第一次**和两支探针同时在跑，加上 cloud-agent-scope 一起跑：64 条中 9 条失败（CA-GATE-01 等等对话结束超时 30 秒，CA-CRASH-01、CA-RENDER-01/02、CA-SCOPE-01、CA-MULTI-01，都是机器忙时已知偶发的那批）；单独重跑上面这 5 个文件全过，`cloud-agent-scope.test.mjs` 另外单独跑 1/1 通过（CA-SCOPE-01，12 秒），两次都如实记在这里 | 19 秒 |
| R-4 | `npm test -- server/test/account-v2-install-plan.test.mjs` | 8 条全过，退出码 0 | 19 秒 |
| R-旧探针 | `node scripts/probes/cloud-agent-isolation-probe.mjs --doc-port 28570 --asset-port 28571 --agent-port 28572 --render-port 28573 --no-look`（带 `PROMPTCUT_NO_PORT_FILE=1`） | 汇总 `{"ok":true,"passed":29,"failed":[]}`，退出码 0；撤销到对话停下 57 / 149 / 56 / 347 毫秒（disabled / removed / kicked / deleted）。**这是旧模式（自报用户名的限定进入项目）的探针**，不是账号模式 | 约 3.5 分钟 |
| R-素材 | `node scripts/probes/asset-account-isolation-probe.mjs --base-port 28575 --out <TMP 下新目录>`（带两个环境变量与 `PROMPTCUT_NO_PORT_FILE=1`） | `passed 158, failed 0`，退出码 0。这是账号模式（真账号后端、真文档服务、独立素材进程）的素材按项目隔离探针 | 95 秒 |
| R-新 | `npm test -- server/test/accept-018-auth-credentials.test.mjs server/test/accept-018-auth-account-path.test.mjs server/test/accept-018-auth-agent-path.test.mjs server/test/accept-018-auth-start-page.test.mjs` | 21 条：19 通过、0 失败、2 条 todo（不让 npm test 变红，见「产品问题」），最后一行「npm test 最终结果：零失败」，退出码 0。四个文件并发跑；单跑时约 4 / 6 / 20 / 1 秒 | 并发 114 秒（机器忙，别的子 Agent 同时在跑） |

端口说明（如实披露）：我跑已有的 `agent-access-http.test.mjs`（写死 5790 / 5791）、`account-assembly-central.test.mjs`（写死 5772 等）时用了它们自己写死的端口，不在我的段里（都不在禁用清单里，也是全量基线里本来就跑的）；VisuHive 的 `npm test` 里有几个文件写死 6361、6362、6471、6472。旧探针和素材探针都用了我的段 28570～28573、28575～28579。

R-新 的端口：缺省在 31000～37999 里随机挑空着的连续一段（见新增文件说明），手动跑时设 `ACCEPT018_AUTH_PORT_BASE=28570`（我开发期间都用这个，落在分给 auth 组的段里）。没有设两个环境变量时，需要账号后端的三个文件整体跳过（实测退出码 0、跳过 3）；start-page 那个不需要账号后端，照常跑。

#### 产品问题（没有现成问题挡住 0.7.18 的核心项；下面是实测里看到的缺口，按重要性排）

1. **【中】在线浏览器第一步第 4 条「谁可以新建 / 每人能建多少」的判断口子，在代码里找不到。** 出处：`docs/plan/online-browser-task.md` 第一步第 4 条（「判断要有一个明确的口子，将来改配置或加规则就能限制，不用改调用方」）。复现：`rg -n "createProject" server/account/authority.mjs` 看第 180～215 行，只有 `verify(input)`（要登录）和 `actor.role !== 'page'` 两个判断，没有可注入的策略函数、没有配置项、也没有按账号数项目；`rg -in "createPolicy|maxProjects|canCreate|ownedLimit|perAccount" server` 无结果。设计文档 `three-versions-018-design.md` 第 304 行写「入云 quota 口数量不限」，代码里没有对应的口。期望：有一个明确的位置。实际：没有。（「谁可以新建 = 登录了账号」这半条是有的并已测。）没有为此写 todo 测试，因为口子的形状没有定，我不替它发明接口。
2. **【低】账号模式下成员读不到用量：`GET /v1/usage` 回 503 `usage-unavailable`（"usage authority is not mounted"）。** 复现：账号模式 Agent 入口（例如跑 `npm test -- server/test/accept-018-auth-agent-path.test.mjs` 起的那套）任意成员委托调 `/agent/v1/usage`。出处：`server/agent/service/conversation-policy.mjs` 里 `usage()` 固定抛这个错。期望：`cloud-agent-task.md` 完成条件第 7 条「用量记录里查得到这几次调用的项目、成员、模型与用量」，旧模式探针 `cloud-agent-run-probe.mjs` D4 写的是「管理命令与 /v1/usage 两处一致」。实际：管理命令 `node server/agent-service/admin.mjs usage --project … --json` 能查（已测，见 2.3-7.3），HTTP 的这一处在账号模式没挂。
3. **【低】不存在的对话（含别的项目的对话）的事件流，Agent 入口直接断开连接。** 复现：补的 todo 测试 `server/test/accept-018-auth-agent-path.test.mjs` 的「不存在的对话…事件流」；或账号模式 Agent 入口上 `GET /v1/conversations/does-not-exist/events?after=0` 带有效委托。期望：`server/agent-service/http.mjs` 的 `accountEvents` 注释和代码写的是回 200 加一条 `{"type":"end","state":"none"}`（或 404）。实际：直接打 Agent 入口是 `socket hang up`，经测试里的反向代理是 502；同一个入口上 `GET /v1/conversations/nope` 是干净的 404。没有泄露任何内容，所以不挡隔离验收，只是不是干净的拒绝。我没有再往下查原因。
4. **【中，已知缺口，不是新发现】共有对话里，第二位发送者的消息一直排着不开始。** 复现：todo 测试「共有对话里一个成员的任务结束后，另一个成员后发的消息的任务能按到达顺序开始」。现象：A 在对话里发一条，任务跑完；B 在**同一个对话**里再发一条，15 秒内没有开始。原因（读代码加日志）：第一轮的「关闭结算」还没接通（`agent.account.run.pending run-outcome-unavailable`，底稿第 1 节第 1 项、块一「独立任务进程」未合入）。**同一项目里另一个对话的任务不受影响**（探索时验过：新项目里先后两个不同对话都能跑，这一支没有留成测试；三个用户三个项目同时跑留成了测试）。这条影响「Agent 共有/私有及发送者」和「逐条按到达顺序排队」的验收，不在本组的行里，但跑这一组时碰到了，记在这里。
5. **【观察，不是缺陷】** (a) 账号模式下创建者关开关，正在跑的那一轮在**下一个模型或工具检查点**停下（我测的脚本里有一步 3 秒的 `sleepMs`，3.3 秒后停），停下的事件是 `error`，内容 `run-no-longer-current`，**没有 `runner_done`**；旧模式探针里是 57 毫秒。立刻打断一个正在进行中的模型请求靠块一的「从外面强制停」。(b) 额度用尽时账号模式的事件里只有代码 `quota-exceeded`，没有旧模式那句「额度已用完(已用 N / 上限 M)。请联系托管方。」。界面怎么把代码翻成人话我没验。(c) 在线开始页的按钮文字是「新建云端项目」（`src/account/AccountProjects.tsx`），语义 `docs/semantics/workflow/project.md` 第 13 行写的是「新建项目」；未登录时界面是登录表单加「加入别人的项目」，没有「需要登录账号」这句文字。这几处是一级（用户看到的文字），请用户定，我没改。
6. **【对底稿的更正】** `AGENT-018-prep.md` 第 8 节第 6 条说 `account-projects-provider.test.mjs` 读的是 `ACCOUNT_PROVIDER_DIR`、只设那两个变量会跳过：现在这个文件读的是 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`（第 15 行），R-1 里它实际跑过且全过，这条已过时。第 2.3 节第 4 行说「素材那一条依赖第 2 项的素材隔离」：`scripts/probes/asset-account-isolation-probe.mjs`（块六的素材隔离探针）已经在这份 main 里，158 项全过（R-素材），但它明说不含轨道流和渲染工作进程。

#### 新增文件

- `server/test/fixtures/accept-018-auth-kit.mjs`：下面三个测试共用的底座。`startAgentPath()` 搭账号模式云端 Agent 全链（沿用 `cloud-queue-user-path.mjs` 和 `account-executor-assembly.mjs`，只有模型是脚本替身），端口可指定，并用 `mock.module` 把文档服务的时钟包一层可向前拨，用来验「过期」；`acceptPorts()` 端口分配；没设账号后端环境变量时给 `SKIP_WITHOUT_PROVIDER`。不改任何已有文件。
- `server/test/accept-018-auth-credentials.test.mjs`（5 条）：2.1-13 和 2.1-1 的公网路径证据。真账号后端、文档服务、独立素材进程、公网入口；内部口无证书 / 伪造证书 / 别的服务身份 / 明文 / 自报回环都被拒；公网入口与账号公共端口上没有内部路由；退出登录后恢复凭证与访问令牌被撤销；运行期间截获本进程和素材子进程的全部输出，结束后连同数据目录的 100 个文件一起扫 8 个秘密值（密码、错误密码、访问令牌、恢复凭证、会话 cookie 值…）；先放一个金丝雀文件证明扫描器找得到；错误名称与错误密码同一个回答；网站与编辑器共用限次数。跑：`npm test -- server/test/accept-018-auth-credentials.test.mjs`。结果 5/5 通过，约 4 秒。
- `server/test/accept-018-auth-account-path.test.mjs`（6 条）：2.1-2 和 2.1-21 的服务端部分。新建前必须登录（无凭证 / 乱写凭证 / 只带网站 cookie 都建不成，账号下项目数不变）；创建者归登录的账号，换设备重登仍是创建者；另一账号加入前进不去、加入后两张列表对得上；两张列表按账号分、不越账号；被踢的账号两台设备都 403、加不回来、列表里没了；账号库里没有项目 / 成员 / 禁入类的表。跑：`npm test -- server/test/accept-018-auth-account-path.test.mjs`。结果 6/6 通过，约 6 秒。
- `server/test/accept-018-auth-agent-path.test.mjs`（9 条：7 通过 + 2 条 todo）：2.3-3、2.3-4、2.3-7 在账号模式下的真实 Agent 全链。五个账号、六七个项目，真任务执行器、真工具、真文档写入。跑：`npm test -- server/test/accept-018-auth-agent-path.test.mjs`。结果 7 通过 0 失败 2 todo，退出码 0，单跑约 20 秒。两条 todo 对应「产品问题」第 3、4 条。
- `server/test/accept-018-auth-start-page.test.mjs`（1 条）：2.1-21 的界面首屏。把真实的 `src/account/AccountProjects.tsx` 用服务端渲染出未登录的页面，核对有账号名 / 密码输入框、有「加入别人的项目」的链接输入框、没有新建按钮和项目名输入框。静态首屏，不是真浏览器。跑：`npm test -- server/test/accept-018-auth-start-page.test.mjs`。结果 1/1，约 1 秒。

我在这些测试里没有改任何产品代码、没有放松断言；每个测试都带对照（例如读写成员发消息 202、登记过的文档服务身份能核对、扫描器金丝雀）。临时探索用的测试文件已删。

#### 行 2.1-13：内部核对口与凭证
原文预期：未授权调用均拒绝，不能只靠回环地址；无密码/令牌/会话值泄露；恢复凭证可撤销。环境与输入：公网、在线页面、同机其他用户进程、日志与设备文件。失败挡发布/部署（`docs/plan/account-binding-task.md` 第 178 行，「逐项验收」表）。
行状态：部分有（本机能验的都有且跑过；同机不同操作系统用户、真实 nginx、节点上的日志与文件要部署后验）

- **2.1-13.1 公网上没有内部核对口的路由**
  - 证据：补了 `accept-018-auth-credentials.test.mjs` 的「2.1-13 内部口：没有证书、证书不对、身份没登记都被拒…公网和账号公共端口根本没有这条路」（经公网入口的 `/api/account`、`/hosted`、`/media` 三个前缀各打 8 个内部路由名、GET 和 POST 都 ≥400 且没返回内部数据；账号公共端口直接打 `/internal/v2/credentials/verify` 回 404）。另有 VisuHive `account/test/account-v2-internal.test.mjs`「v2 real HTTPS mTLS verifies doc pinned identity; loopback/no cert/wrong CA/wrong service/public path fail closed」（公共 app 上 POST 内部核对路径回 404）；`server/test/account-projects-provider.test.mjs` 子测试「private internal mTLS account list and asset check/events; certificate method allowlist, no public internal fallback」。
  - 命令：`npm test -- server/test/accept-018-auth-credentials.test.mjs`；VisuHive `npm test`；`npm test -- server/test/account-projects-provider.test.mjs`
  - 看哪一行：「✔ 2.1-13 内部口：…」；VisuHive 的「✔ v2 real HTTPS mTLS verifies doc pinned identity…」
  - 实跑：2026-10-13，新测试 5/5 通过；R-VH 通过；R-1 里该子测试 ✔
  - 约耗时：4 秒 / 7.4 秒 / 9 秒
  - 在哪验：本机现在就能验
  - 说明：这是应用层的「没有这条路由」。真 nginx 选路（VisuHive 的「Linux isolated nginx actually selects account, hosted websocket and media routes」在 Windows 上被跳过，要 root 的 Linux 窗口）归下一条。
- **2.1-13.1b 真实 nginx 反代层不把内部路径转出去**
  - 证据：无。`server/hosted/deploy/nginx-site-promptcut.conf` 里只有 `/hosted`、`/media`、`/editor`、`/catalog`、账号三个路径，没有 `internal` 的 location（读文本得知）；没有测试在真 nginx 上请求内部路径。
  - 命令：无
  - 看哪一行：无
  - 实跑：未跑，本机没有 Linux nginx 窗口
  - 在哪验：要部署到节点后验
  - 说明：部署清单 D0 的真实网络验收里补一条「公网 `/hosted/internal/v2/…`、`/internal/v2/…` 回 404」。
- **2.1-13.2 在线页面调不了内部口**
  - 证据：同 2.1-13.1 的新测试（页面只能走公网入口，入口上没有内部路由；内部口是单独的 TLS 监听，要客户端证书，页面没有也拿不到）。
  - 命令 / 实跑 / 耗时：同上
  - 在哪验：本机现在就能验
  - 说明：没有在真浏览器里发请求试，这一条靠「入口上无路由 + 内部口要客户端证书」两层推出。
- **2.1-13.3 同机其他用户进程调不了（证书层）**
  - 证据：补了同一个新测试：无客户端证书（只带 CA）失败；同一个根签发但没登记的身份被拒；别的服务（素材）的身份调账号核对口被拒；明文 HTTP 连内部口失败；文档服务、素材服务各自的内部口不带证书也失败；对照：登记过的文档服务身份核对通过。另有 `account-assembly-run-internal.test.mjs`「run internal routes pin Agent cert, inject trusted service only…」（错证书 403、自报 `x-forwarded-for: 127.0.0.1` 仍 403）；VisuHive 同上那一条（`wrong CA`、`wrong service` 失败或 403）。
  - 命令：`npm test -- server/test/accept-018-auth-credentials.test.mjs server/test/account-assembly-run-internal.test.mjs`
  - 看哪一行：「✔ 2.1-13 内部口…」「✔ run internal routes pin Agent cert…」
  - 实跑：2026-10-13，通过（R-1、R-新）
  - 约耗时：4 秒 / 9 秒
  - 在哪验：本机现在就能验
- **2.1-13.3b 同机其他用户进程调不了（操作系统层：独立服务用户、私钥 0600、目录 0700）**
  - 证据：部分。`account-v2-install-plan.test.mjs`「account v2 install plan rejects unsafe users, missing old token and shared private directories」和 `account-v2-deploy-config.test.mjs`「…rejects a reused Ed25519 key saved under different paths」「…rejects a CA certificate used as a service leaf」只验安装计划和配置的形状；VisuHive 的「new backup directory is 0700…」「runner refuses an existing non-private directory…」在 Windows 上被跳过。
  - 命令：`npm test -- server/test/account-v2-install-plan.test.mjs server/test/account-v2-deploy-config.test.mjs`
  - 看哪一行：「✔ account v2 install plan rejects unsafe users…」
  - 实跑：2026-10-13，R-4 8/8 通过，R-1 里 deploy-config 9 条通过
  - 约耗时：19 秒 / 9 秒
  - 在哪验：要部署到节点后验
  - 说明：设计文档 `three-versions-018-design.md` 第 92 行说既有服务全以 root 跑的组合不满足这条验收；真正的「别的 OS 用户读不到私钥、连不上」只能在节点上用另一个用户身份试。
- **2.1-13.4 不能只靠回环地址**
  - 证据：新测试里所有被拒的请求都是从 127.0.0.1 发出的，另有一条自报 `x-forwarded-for` / `x-real-ip` 为回环的无证书请求仍失败；`account-assembly-run-internal` 同样；`account-v2-deploy-config.test.mjs`「…rejects non-loopback or colliding internal ports…」（内部口只许回环，但另外要证书）。
  - 命令 / 实跑 / 耗时：同 2.1-13.3
  - 在哪验：本机现在就能验
- **2.1-13.5 无密码 / 令牌 / 会话值泄露**
  - 证据：补了 `accept-018-auth-credentials.test.mjs`「2.1-13 日志与数据目录里没有密码、令牌、会话值」：登录一次桌面、一次网站、一次错误密码、再走一遍文档服务之后，扫数据目录 100 个文件（账号库及其 WAL、文档数据、素材数据、证书目录）和截获的输出（本进程 5356 字符 + 素材子进程 124 字符）里的 8 个秘密值，一个都没有；先放金丝雀证明扫得到。设备文件：`src/account/desktopVault.test.mjs`「native vault script parses and actual Windows DPAPI/ACL/atomic replacement roundtrips only recovery」（真 Windows DPAPI 加密文件里不含恢复凭证 / password / accessToken 明文，目录只授权本人和 SYSTEM）。文档账本：`account-projects-provider.test.mjs`「usable access tokens absent from durable doc ledger」。账号库：VisuHive「v2 desktop recovery rotates once…」断言轮换结果的密文里没有新令牌。旧模式探针 I13（委托票据等原文不落盘不进日志）也过。
  - 命令：`npm test -- server/test/accept-018-auth-credentials.test.mjs src/account/desktopVault.test.mjs server/test/account-projects-provider.test.mjs`
  - 看哪一行：新测试的 `ℹ captured child=124 chars, in-process=5356 chars; scanned 100 files … for 8 secret values` 和「✔ 2.1-13 日志与数据目录…」；「✔ native vault script parses and actual Windows DPAPI…」
  - 实跑：2026-10-13，全部通过
  - 约耗时：4 秒 / 9 秒
  - 在哪验：本机现在就能验
  - 说明：缺的两处：节点上真实服务的日志（pm2 / journald）和节点磁盘；macOS / Linux 桌面保管（桌面版目前只有 Windows 的 DPAPI 实现，`account_vault.rs`）。真节点那份要部署后验。
- **2.1-13.6 恢复凭证可撤销**
  - 证据：补了新测试的「2.1-13 恢复凭证可撤销…」：轮换一次旧的立刻回 `token-reused`；用户退出后最新的恢复凭证回 401 `credential-revoked`、访问令牌被内部核对口回 `credential-revoked`、文档服务也 401。另有 VisuHive `account-v2-foundation.test.mjs`「v2 desktop recovery rotates once, replays same request across restart encrypted, revokes all credential forms」。
  - 命令：`npm test -- server/test/accept-018-auth-credentials.test.mjs`；VisuHive `npm test`
  - 看哪一行：「✔ 2.1-13 恢复凭证可撤销：…」；「✔ v2 desktop recovery rotates once…」
  - 实跑：2026-10-13，通过
  - 约耗时：4 秒 / 7.4 秒
  - 在哪验：本机现在就能验
  - 说明：改密选「退出」后恢复凭证被撤销的那条链归 2.1-5，不在本行。

#### 行 2.3-4：隔离验收用探针断言（核心项，不过不部署）
原文预期：成员甲的对话读不到、改不了成员乙没有权限的项目；一个项目的对话拿不到另一个项目的内容、素材与对话记录；伪造或过期的成员身份证明被拒；只读成员不能操作 Agent，发消息这一步就被拒（2026-10-08 用户更正）；创建者关掉开关后正在进行的对话被停掉（`docs/plan/cloud-agent-task.md` 完成条件第 4 条；底稿 2.3 第 4 行「账号模式下要重跑」）。
**现有探针是旧模式的**：`cloud-agent-isolation-probe.mjs` 起的是 `server/auth/` 的限定进入项目（成员是自报用户名加密码派生的），不是账号模式。我另补了账号模式的版本（`accept-018-auth-agent-path.test.mjs`），旧探针也按我的端口段实跑了一遍作对照（R-旧探针）。
关于「只读成员」：现行语义里没有这种身份（底稿第 8 节第 20 点）。设计 `three-versions-018-design.md` 第 16、170 行写的是「发消息就拒只读」「send 需要当前有效 rw 成员」。账号模式的文档服务里每个成员的权限有 `rw` / `r` 两种（创建者经 `admin` 的 `set-list` 改，`account-assembly-central.test.mjs` 和 `account-projects-provider.test.mjs` 都在用）。下面第 4.8 条按这个落：把成员设成 `r`，他发消息就被拒。**这个「设成只读」是不是 0.7.18 要承诺给用户的能力（有没有界面）语义没写，请主会话 / 用户定，必要时这条改成「对 0.7.18 不适用」。**
行状态：部分有（账号模式的新断言都有且跑过；素材一条有素材隔离探针但它明说不含轨道流和渲染工作进程；「立刻」停下在账号模式是下一个检查点）

- **2.3-4.1 甲读不到乙没有权限的项目**
  - 证据：补了 `accept-018-auth-agent-path.test.mjs` 的「2.3-4 跨项目：不在名单的人和别的项目的创建者进不去…」：不在任何名单的账号和别的项目的创建者去取项目一的会话，都是 403 `not-listed`，回包里没有任何票据；用项目二的页面连接去 `project.open` 项目一，回的不是 `project.state`。另有 `account-projects-provider.test.mjs`「owned/joined unique doc lists; no B access before actual join…」；旧模式探针 I2。
  - 命令：`npm test -- server/test/accept-018-auth-agent-path.test.mjs`（手动加 `ACCEPT018_AUTH_PORT_BASE=28570`）；`npm test -- server/test/account-projects-provider.test.mjs`
  - 看哪一行：「✔ 2.3-4 跨项目：…」
  - 实跑：2026-10-13，通过（R-新；单跑 7 条 + 2 todo 退出码 0）
  - 约耗时：整个文件单跑 20 秒
  - 在哪验：本机现在就能验
- **2.3-4.2 甲改不了乙没有权限的项目**
  - 证据：同一个子测试：用项目二的连接对项目一发 `project.op`，回的不是 `project.ok`；两个项目各自的任务各改各的项目名（`renamed-in-P1`、`renamed-in-P2`），互不串；Agent 的工具没有「指定项目」的入口，项目只由对话委托决定。旧模式探针 I3、I3b。
  - 命令 / 看哪一行 / 实跑 / 耗时 / 在哪验：同 4.1
- **2.3-4.3 跨项目拿不到内容**
  - 证据：同上（项目内容这一层同 4.1、4.2）。
  - 在哪验：本机现在就能验
- **2.3-4.4 跨项目拿不到素材**
  - 证据：`scripts/probes/asset-account-isolation-probe.mjs`（账号模式，同一个内容哈希只在项目一入库时，持项目二票据的人在素材服务每个读写入口都读不到、收不了尾；成员读写照常；踢人 / 退出后正在读的流被掐断）。旧模式探针 I5、T1c。
  - 命令：`node scripts/probes/asset-account-isolation-probe.mjs --base-port 28575 --out <TMP 下新目录>`（先设两个环境变量，加 `PROMPTCUT_NO_PORT_FILE=1`）
  - 看哪一行：末行 `{"out":…,"passed":158,"failed":0,"failedNames":[]}`
  - 实跑：2026-10-13，158 通过 0 失败，退出码 0
  - 约耗时：95 秒
  - 在哪验：本机现在就能验（探针范围内）
  - 说明：该探针明说不含 `server/frame-stream.mjs` 的轨道流和渲染工作进程（`server/hosted-render/worker.mjs`）；这两处的按项目隔离归块十一（等渲染重构做完）。账号任务书第 188 行还写着「跨项目已知哈希可读的残留风险仍待用户裁定」——这个探针证明的是素材服务入口，这条残留风险的裁定不在我这一组。所以素材这一条：入口层有证据，轨道流与渲染进程层 **要等某一块合入（块十一：和渲染有关的工具与隔离，等渲染重构做完）**。
- **2.3-4.5 跨项目拿不到对话记录**
  - 证据：同一个新子测试：两个项目里各有一个同名对话 `same-id`，各自的对话记录、列表、元数据只含自己项目的内容和标记；只在项目一里有的对话，项目二的委托取不到（404）、停不了（404）、列表里没有；事件流里没有项目一的任何内容（见「产品问题」第 3 条，这一支回的是断开连接而不是干净的 404，没有内容泄露）。旧模式探针 I4。
  - 命令 / 看哪一行 / 实跑 / 耗时：同 4.1
  - 在哪验：本机现在就能验
- **2.3-4.6 伪造的成员身份证明被拒**
  - 证据：补了「2.3-4 伪造的、过期的、种类不对的身份证明一律被拒」：乱写、改最后两位、素材票据冒充委托、连接票据冒充委托、空字符串，都是 401 且回包里没有票据；对照：真委托 200。旧模式探针 I6（改一个字符 / 自造密钥签 / 别的项目的密钥签 / 改成员）。
  - 命令：同 4.1
  - 看哪一行：「✔ 2.3-4 伪造的、过期的、种类不对的身份证明一律被拒」
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
- **2.3-4.7 过期的成员身份证明被拒**
  - 证据：同一个子测试：把文档服务的时钟向前拨 6 分钟（委托只有 5 分钟，`server/docservice/account-hosted.mjs` 的 `now() + 5 * 60_000`），用同一个委托调 Agent 入口回 401，拨回来之前不做别的；退出登录（撤销）之后手里的委托也回 401。旧模式探针 I7。
  - 在哪验：本机现在就能验
- **2.3-4.8 只读成员不能操作 Agent，发消息这一步就被拒**
  - 证据：补了「2.3-4 只读成员：发消息这一步就被拒，读照常；改回读写后恢复」：创建者把成员设成 `r`；他读对话仍 200；用新取的委托和设成只读之前取的委托发消息都是 403 `not-listed`；被拒的发送没有留下对话；改回 `rw` 后恢复；对照：设成只读之前他发消息是 202。另有 `agent-access-conversation.test.mjs`「read-only, revoked and consent-absent send fail before queue…」（单元层）；旧模式探针 I8。
  - 命令：同 4.1
  - 看哪一行：「✔ 2.3-4 只读成员：…」
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
  - 说明：见上面关于「只读成员」是否存在的说明，主会话请定。
- **2.3-4.9 创建者关掉开关后正在进行的对话被停掉**
  - 证据：补了「2.3-4 关开关：正在跑的对话在下一个检查点停下，之后发消息和读都被拒；别的项目的任务不受影响」：项目三的任务（脚本：睡 3 秒、改项目名、说一句话）刚开始，创建者关开关；3.3 秒后事件里出现 `error`（`run-no-longer-current`），改项目名那一步没有发生，对话没有再说话；之后发消息回 403、读回 403 `disabled`；同时在跑的项目四的任务照常跑完并写进自己的项目。账号模式还有 `account-assembly-central.test.mjs`（关开关后排队的消息被取消，关了再开也不复活）。旧模式探针 I9、I9b、I10、I11、I12（57～347 毫秒内停下）。
  - 命令：同 4.1；`npm test -- server/test/account-assembly-central.test.mjs`
  - 看哪一行：新测试的诊断行 `switch off -> run stopped in … ms`；「✔ 2.3-4 关开关：…」
  - 实跑：2026-10-13，通过（停下用时 3316 毫秒，只记录）
  - 约耗时：6 秒（子测试）
  - 在哪验：本机现在就能验
  - 说明：账号模式下是在下一个模型 / 工具检查点停（见「产品问题」第 5 条 (a)），不是立刻打断进行中的模型请求；也没有 `runner_done`、关闭结算未接通（块一）。`workflow/project.md` 第 31 行写的是「立刻停掉」，请主会话对一下口径。

#### 行 2.3-3：独立入口
原文预期：独立入口：Agent 服务不带编辑页也能起，带鉴权，多个用户、多个项目、多个对话同时跑互不干扰。桌面版改用同一个入口，用户看到的行为不变：桌面版与 Agent 相关的全部测试与探针不变红（`cloud-agent-task.md` 完成条件第 3 条）。
行状态：部分有（不带编辑页、带鉴权、多用户多项目同时跑都有账号模式的真实测试；同一个对话里多位发送者按序排队有缺口；桌面版「全部测试不变红」要主会话的全量跑）

- **2.3-3.1 Agent 服务不带编辑页也能起**
  - 证据：补了 `accept-018-auth-agent-path.test.mjs`「2.3-3 独立入口：Agent 公共入口只有 /v1 和 /healthz，没有编辑页…」：Agent 入口的 `/`、`/index.html`、`/editor/`、`/api/ai/config`、`/api/media/x` 全部 404，`/healthz` 200。旧模式 `cloud-agent-service.test.mjs`「CA-ENTRY-01 / CA-ENTRY-03 托管档入口：没有 /api/*，没配鉴权一律 401…」和「CA-SEAM-01 新目录里没有指向 src/ 的 import」。
  - 命令：`npm test -- server/test/accept-018-auth-agent-path.test.mjs server/test/cloud-agent-service.test.mjs`
  - 看哪一行：「✔ 2.3-3 独立入口：…」「✔ CA-ENTRY-01 / CA-ENTRY-03 …」
  - 实跑：2026-10-13，通过（R-新、R-3）
  - 约耗时：20 秒 / 19 秒
  - 在哪验：本机现在就能验
  - 说明：这里的「独立」是进程内的独立入口（测试起的是 `createAgentHttp` 单独监听一个端口），真独立进程的起法（`server/agent-service/main.mjs` 命令行入口）在旧模式探针里实起过（R-旧探针）；节点上的进程管理配置要部署后验。
- **2.3-3.2 带鉴权**
  - 证据：同一子测试：`/v1/info`、`/v1/conversations`、`/v1/conversations/x` 不带凭证全回 401；伪造 / 过期 / 撤销的凭证见 2.3-4.6、4.7。
  - 在哪验：本机现在就能验
- **2.3-3.3 多个用户、多个项目、多个对话同时跑互不干扰**
  - 证据：补了同一子测试后半：三个不同的账号在各自的三个项目里同时各开一个对话，各自改自己的项目名，三个都跑完，对话记录里只有自己的话，项目名各是各的；另外 2.3-4 跨项目子测试里两个项目同名对话同时跑、关开关子测试里两个项目同时在跑。旧模式 `CA-MULTI-01 一个进程里两个项目各一个对话同时跑，互不干扰`（1.7 秒）。
  - 命令：同 3.1
  - 看哪一行：「✔ 2.3-3 独立入口：…」「✔ CA-MULTI-01 …」
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
  - 说明：缺的是「同一个共有对话里多位发送者按到达顺序一轮一轮跑」，因为第一轮的关闭结算没接通，第二条一直排着（「产品问题」第 4 条，todo 测试）。**要等某一块合入（块一：独立任务进程）**。
- **2.3-3.4 桌面版行为不变、桌面版 Agent 相关的全部测试与探针不变红**
  - 证据：部分。`cloud-agent-service.test.mjs`「CA-DESK-01 桌面档：Agent 服务登记的路由与搬出插件之前逐条相同，桌面专用接口留在插件里」通过（R-3）。
  - 命令：`npm test -- server/test/cloud-agent-service.test.mjs`；全量 `npm test`
  - 实跑：CA-DESK-01 通过；全量没有跑（红线）
  - 在哪验：本机现在就能验
  - 说明：「全部测试与探针不变红」要主会话统一跑全量 `npm test`；桌面版 Agent 的探针（`agent-*` 系列）我没有逐个跑。

#### 行 2.3-7：G 的接口验收
原文预期：把某个测试项目的额度临时设成一个很小的数，超出后请求被明确拒绝并告诉用户原因；设回不限后恢复；用量记录里查得到这几次调用的项目、成员、模型与用量（`cloud-agent-task.md` 完成条件第 7 条；底稿：账号模式下没有单列证据）。
行状态：部分有（账号模式下「拒绝」和「用量查询」有真实任务的证据；「设回不限后恢复」在账号模式只到闸这一层）

- **2.3-7.1 额度设很小，被明确拒绝**
  - 证据：补了 `accept-018-auth-agent-path.test.mjs`「2.3-7 额度与用量（账号模式的真实任务）…」：用管理命令（`runAdmin(['quota','set',项目,'--tokens','1','--window','total'])`）把项目五的额度设成 1 个 token；账号模式的真任务：第一步 `get_project` 在额度内照做，下一次模型请求被拒，事件 `error`，内容 `quota-exceeded`，项目号对；改项目名那一步没有发生、对话没有再说话。旧模式 `cloud-agent-runs.test.mjs`「CA-GATE-02 额度很小:超出后下一次模型请求不发;设回不限后恢复;不重启」带人话（已用 N / 上限 M）。
  - 命令：`npm test -- server/test/accept-018-auth-agent-path.test.mjs server/test/cloud-agent-runs.test.mjs`
  - 看哪一行：「✔ 2.3-7 额度与用量（账号模式的真实任务）…」「✔ CA-GATE-02 …」
  - 实跑：2026-10-13，通过（R-新、R-3）
  - 约耗时：3 秒（子测试）/ 19 秒
  - 在哪验：本机现在就能验
  - 说明：账号模式事件里只有代码 `quota-exceeded`，没有「已用 N / 上限 M」的话（「产品问题」第 5 条 (b)）。
- **2.3-7.2 设回不限后恢复**
  - 证据：部分。同一个子测试：额度用完后，闸（`createGate`，读同一份 `config/limits.json`）对这个项目回 `quota-exceeded`；`quota clear` 退出码 0 后同一个闸对同一个项目回 `{ ok: true }`，没有重启；旧模式 CA-GATE-02 是完整的「设回不限后再发一条就正常跑完」。
  - 命令：同 7.1
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验（闸层）；账号模式「同一个共有对话里再发一条并跑完」**要等某一块合入（块一：关闭结算接通）**——同一对话的第二条消息现在排着不开始。同项目另一个对话的第二轮其实能跑（探索时验过，没有留成测试），所以也可以另开一个对话来验恢复；我没做，因为额度检查的位置在闸而不在对话，已经用闸层加旧模式的完整流程覆盖，要更强的证据请主会话决定是否值得补一条。
- **2.3-7.3 用量记录查得到项目、成员、模型与用量**
  - 证据：补了同一子测试：一个正常的账号模式任务之后，`runAdmin(['usage','--project',项目,'--json'])` 回的 JSON 里有该项目、成员（账号编号加用户名 `accCreator2`）、模型 `mock/scripted-local-response`、token 数和调用次数（例：`calls 2, tokens 207`）；被额度拒绝的项目里，被拒之前的那次调用记在了成员名下。旧模式 `CA-GATE-03 用量流水、usage()、admin usage 三处一致`。
  - 命令：同 7.1
  - 看哪一行：诊断行 `usage --json: {"calls":2,"tokens":207,"projects":{…"members":{"acc_…":{"username":"accCreator2"…}},"models":{"mock/scripted-local-response":…}}}`
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
  - 说明：账号模式的 `GET /v1/usage` 是 503（「产品问题」第 2 条）；按管理命令查是通的。真实模型下的用量不在本地验（要真实模型，归 2.3-8）。

#### 行 2.1-1：云端登录与限次数
原文预期：正确才进入/创建；错误名称与密码同文案；网站与编辑器共用限次数；结果及页面证据（`account-binding-task.md` 第 166 行）。失败挡本地关卡。
行状态：部分有（服务端公网路径各条都有且跑过；「页面证据」没有）

- **2.1-1.1 正确才进入**
  - 证据：补了 `accept-018-auth-credentials.test.mjs` 前段：正确的名称加密码，桌面（`/editor/login`）和网站（`/login`）都进得去；错误密码 401。VisuHive `app.test.mjs`「ACC-01 注册即登录…」「ACC-03 登录：密码不对和账号不存在回同一句话；库里不存密码原文」。`account-dual-user-path.test.mjs`（两个真实账号登录后各自的会话、列表）。
  - 命令：`npm test -- server/test/accept-018-auth-credentials.test.mjs server/test/account-dual-user-path.test.mjs`；VisuHive `npm test`
  - 看哪一行：「✔ 公网路径：内部口拒绝未授权调用…」整条通过；「✔ ACC-03 …」
  - 实跑：2026-10-13，通过
  - 约耗时：4 秒 / 2 秒 / 7.4 秒
  - 在哪验：本机现在就能验
- **2.1-1.2 正确才创建（未登录建不成）**
  - 证据：补了 `accept-018-auth-account-path.test.mjs`「2.1-21 新建前要先登录…」：无凭证 401 `login-required`、乱写凭证 401、只带网站 cookie 400 `bearer-required`，账号名下项目数不变；退出登录后令牌也建不成。
  - 命令：`npm test -- server/test/accept-018-auth-account-path.test.mjs`
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
- **2.1-1.3 错误名称与错误密码同一个回答**
  - 证据：补了 `accept-018-auth-credentials.test.mjs`「2.1-1 错误的名称与错误的密码同一个回答；网站与编辑器共用限次数」：不存在的名称和名称对密码错，桌面路由与网站路由各自的回包（状态、代码、文案）逐字相同；网站与桌面也是同一句话。VisuHive `ACC-03`。
  - 命令 / 看哪一行 / 实跑：同 2.1-1.1，通过
  - 在哪验：本机现在就能验
- **2.1-1.4 网站与编辑器共用限次数**
  - 证据：补了同一个子测试：对同一个名称，网站错 5 次加编辑器错 5 次（合计 10 次），之后用**正确**密码从编辑器登录回 429 `too-many`，网站登录也回 429。VisuHive `account-v2-foundation.test.mjs`「v2 website and desktop share name/IP guesses, direct spoofed X-Real-IP never evades limits」；`app.test.mjs`「ACC-12 限次数…」。PromptCut 一侧的证据：桌面版的登录操作是 Rust 壳里 `account_vault.rs` 的 `'login' { … Http '/api/account/editor/login' …}`，打的就是账号后端和网站共用限次数的那个路由；`src/account/client.test.mjs`「desktop password and recovery use only native bridge; caller request IDs are stable for retry」（通过）；PromptCut 自己没有限次数逻辑，共用完全在账号后端。
  - 命令：`npm test -- server/test/accept-018-auth-credentials.test.mjs src/account/client.test.mjs`；VisuHive `npm test`
  - 看哪一行：「✔ 2.1-1 错误的名称与错误的密码同一个回答；网站与编辑器共用限次数」；「✔ v2 website and desktop share name/IP guesses…」
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
  - 说明：429 时桌面界面怎么显示（`AccountProjects.tsx` 把服务端的 message 原样放进错误条）我没有在真窗口里看；这属于页面证据。
- **2.1-1.5 页面证据**
  - 证据：无。真浏览器探针 `scripts/probes/account-user-pages-probe.mjs` 需要先构建在线版（`dist-online` 现在不存在）并占用固定的 6340～6342、6388 端口，`account-public-user-pages-probe.mjs --run-public` 要连真实公网并创建测试账号。
  - 命令：无
  - 实跑：未跑。原因：固定端口超出本组端口段，且要先构建；公网那支是部署后的事
  - 在哪验：本机现在就能验（构建在线版、占用 63xx 端口后跑 account-user-pages-probe）；公网路径要部署到节点后验

#### 行 2.1-2：项目权限与两张列表
原文预期：权限只由云端文档服务记录；被踢全设备拒绝；列表准确可点开，不越账号；服务故障报不可用（`account-binding-task.md` 第 167 行）。失败挡本地关卡；部署后复验。
行状态：部分有（服务端各条都有；列表「可点开」只验到地址形状，没有真点）

- **2.1-2.1 权限只由云端文档服务记录**
  - 证据：补了 `accept-018-auth-account-path.test.mjs`「2.1-2 权限只由云端文档服务记录：账号库里没有项目、成员、禁入这类表」（账号库 14 张表：accounts、sessions、codes、logins、login_credentials、password_events、outbox、consumer_acks、rotation_results、account_consents、csrf_nonces、order_witnesses、sqlite_sequence、sequence_counters，没有项目 / 成员 / 禁入 / 邀请类）。VisuHive「v2 account list comes exclusively from a controlled mTLS doc authority and failure is explicit 503」；`account-projects-provider.test.mjs`「creator persisted before initializer, pending hidden, retry reuses id and result」「creator Agent identity never administrator; other account cannot admin」「owned/joined unique doc lists…」。
  - 命令：`npm test -- server/test/accept-018-auth-account-path.test.mjs server/test/account-projects-provider.test.mjs`；VisuHive `npm test`
  - 实跑：2026-10-13，通过
  - 约耗时：6 秒 / 9 秒 / 7.4 秒
  - 在哪验：本机现在就能验
- **2.1-2.2 被踢全设备拒绝**
  - 证据：补了「2.1-2 被踢的账号在全部设备上被拒，也加不回来，列表里没有了」：同一个成员在两台设备上登录并进入项目都 200；创建者踢人后，两台设备取会话都是 403，回包里没有票据；想再加入被拒；成员的「我加入的」列表里没有了，创建者的列表不受影响。`account-projects-provider.test.mjs`「kick persists account ban and closes permissions for both device logins; notification alone does not complete」；R-素材（踢人后正在读的素材流被掐断）；旧模式探针 I11。
  - 命令：`npm test -- server/test/accept-018-auth-account-path.test.mjs server/test/account-projects-provider.test.mjs`
  - 看哪一行：「✔ 2.1-2 被踢的账号在全部设备上被拒…」「✔ kick persists account ban…」
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验；公网另要部署后复验（原文「部署后复验」）→ 要部署到节点后验
- **2.1-2.3 列表准确、不越账号**
  - 证据：补了「2.1-2 两张列表按账号分…」：创建者 `owned` ≥ 2、`joined` 空；成员 `joined` ≥ 2、`owned` 空；没有任何项目的账号两张都是空；列表项里没有票据 / 令牌 / 密码字样。`account-dual-user-path.test.mjs`（`ownerProjects 1`、`memberProjects 1`）。
  - 命令 / 实跑：同 2.1-2.1、`npm test -- server/test/account-dual-user-path.test.mjs`，通过
  - 在哪验：本机现在就能验
- **2.1-2.4 列表可点开**
  - 证据：部分。列表项的地址形状 `/editor/?project=sp_…` 已断言；`AccountProjects.tsx` 点「加入 / 进入」走 `enterAccountProject(...)`（读代码）。没有真浏览器里点开的证据。
  - 命令：无
  - 实跑：未跑。原因：同 2.1-1.5
  - 在哪验：本机现在就能验（真浏览器探针，需构建 + 63xx 端口）；公网要部署到节点后验
- **2.1-2.5 服务故障报不可用（不是假的空列表）**
  - 证据：VisuHive「v2 account list comes exclusively from a controlled mTLS doc authority and failure is explicit 503」（文档服务 503 / 返回形状不对 / 换了证书的调用者，列表接口都回 503 `projects-unavailable`，没有 `owned` 字段）、`ACC-13 项目列表：要登录；权威未接线明确不可用`、`account-v2-site-client.test.mjs`「project 503 is shown as unavailable and never as an empty project list」（网站页面一侧）；PromptCut `src/account/client.test.mjs`「readiness503, membership403 and malformed tickets remain failures; no fallback project or empty list」。
  - 命令：VisuHive `npm test`；`npm test -- src/account/client.test.mjs`
  - 看哪一行：上面几条 ✔
  - 实跑：2026-10-13，通过（R-VH、R-3）
  - 在哪验：本机现在就能验
  - 说明：编辑器里的 `AccountProjects.tsx` 在列表出错时显示「项目列表暂时不可用。」（读代码），没有渲染级测试。我没有在公网入口上真的把文档服务停掉去看（停服务算动环境，且 fixture 里文档服务与账号公共端口同进程组合，不能单独停）。

#### 行 2.1-21：在线浏览器任务书第一步（浏览器新建项目）
原文预期：浏览器开始页能新建云端项目，新建前要先登录（`online-browser-task.md` 第一步 1～5 条、「做完的标准」第 3 条第 1 点；`account-binding-task.md` 第 186 行归 0.7.18）。
行状态：部分有（服务端行为都有；界面只有未登录首屏的静态检查；「每人能建多少」的口子没找到）

- **2.1-21.1 开始页有「新建项目」，与「加入别人的项目」并列（第 1 条）**
  - 证据：部分。补了 `accept-018-auth-start-page.test.mjs`：未登录首屏有账号名 / 密码输入框和「加入别人的项目」的链接输入框，没有新建按钮和项目名输入框。登录后出现新建表单（项目名加「新建云端项目」按钮，`data-pc="cloud-create"`）是读 `AccountProjects.tsx` 得知，没有渲染级验证。
  - 命令：`npm test -- server/test/accept-018-auth-start-page.test.mjs`
  - 看哪一行：「✔ 在线浏览器开始页（未登录）：…」
  - 实跑：2026-10-13，通过
  - 约耗时：1 秒
  - 在哪验：本机现在就能验（静态首屏）；登录后的整页和并列布局要真浏览器，未跑（原因同 2.1-1.5）
  - 说明：按钮文字「新建云端项目」与语义「新建项目」不同字，见「产品问题」第 5 条 (c)。
- **2.1-21.2 新建的是放云端的多用户协作项目，新建的人是创建者（第 2 条前半）**
  - 证据：补了 `accept-018-auth-account-path.test.mjs`「2.1-21 创建者跟着账号走…」：登录的人经 `/hosted/shared/account/create` 建（`allowLinkJoin: true` 即多用户协作），201；项目在创建者的「我创建的」里，不在别的账号的列表里。
  - 命令：`npm test -- server/test/accept-018-auth-account-path.test.mjs`
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
- **2.1-21.3 新建之前要先登录；口子缺省拒绝并提示「需要登录账号」（第 2 条后半）**
  - 证据：服务端：补了「2.1-21 新建前要先登录…」：无凭证 401 `login-required`、乱写 401、只带 cookie 400；账号名下项目数不变（不留半成品）。界面：未登录首屏没有新建入口（start-page 测试）。
  - 命令 / 实跑：同上，通过
  - 在哪验：本机现在就能验
  - 说明：界面上没有「需要登录账号」这句提示文字（未登录时直接是登录表单），一级文字，请用户定。
- **2.1-21.4 创建者身份跟着账号走：清掉浏览器数据或换设备，重新登录就恢复（第 3 条）**
  - 证据：补了同一个子测试：另一台设备（另一个设备编号）重新登录同一个账号，取该项目的会话 200 且 `creator: true`；列表里仍是创建者。`src/account/client.test.mjs`「online account uses cookie+CSRF for website and omit+bearer for exact project; renewal never silently relogs」说明在线版不把凭证存在页面里（通过）。
  - 命令：`npm test -- server/test/accept-018-auth-account-path.test.mjs src/account/client.test.mjs`
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验
  - 说明：「清掉浏览器数据」本身（真浏览器清存储后重开）没有演示。
- **2.1-21.5 托管端留好限制的位置：谁可以新建、每人能建多少（第 4 条）**
  - 证据：「谁可以新建 = 登录了账号」有（见 2.1-21.3）。「每人能建多少」的口子：无，见「产品问题」第 1 条。
  - 命令：无
  - 实跑：未跑，没有可跑的东西
  - 在哪验：要等某一块合入（账号客户端 / 入云限制口那一块，设计里写的 `018-account-client` 的「入云 quota 口」，在 main 上没有找到）
- **2.1-21.6 新建后直接进入编辑界面；邀请链接、二维码、项目设置与桌面版一致（第 5 条）**
  - 证据：无（只读到 `AccountProjects.tsx` 里建完后调 `enter(...)` → `onEnterEditor()`，并把项目链接放进状态里）。
  - 命令：无
  - 实跑：未跑
  - 在哪验：本机现在就能验（真浏览器，需构建 + 63xx 端口）；未跑
- **2.1-21.7 「做完的标准」第 3 条第 1 点：登录后新建，另一个浏览器登录另一个账号后加入，两边看得到彼此的改动；没登录不能新建**
  - 证据：另一账号加入前进不去（403）、加入后会话 200、两张列表对得上：补了 account-path 子测试；两边看得到彼此的改动：`account-assembly-central.test.mjs`「actual provider/order → central doc → independent asset → two pages…: durable op, readonly selection, restart and revoked resume」（两张页面连接，一边写操作，另一边收到广播，操作者的登录身份对；通过 R-2）；没登录不能新建：见 2.1-21.3。真浏览器两个窗口互看：`account-user-pages-probe.mjs`，未跑。
  - 命令：`npm test -- server/test/accept-018-auth-account-path.test.mjs server/test/account-assembly-central.test.mjs`
  - 实跑：2026-10-13，通过
  - 在哪验：本机现在就能验（服务端）；真浏览器两窗口 → 本机现在就能验但未跑；公网 → 要部署到节点后验


## 7. 明细：Agent 对话与撤销（组 conv）

### conv 组段落（Agent 对话与任务权限：2.1-3、2.1-4、2.1-5、2.3-6、2.3-5、RS18-chat）

日期 2026-10-13，工作区 `C:\Users\admin\Documents\PromptCut\.worktrees\v18-accept`（分支 `claude/v18-accept`，内容是 main `90177e24` 之后）。端口只用 28580～28589。

**通用命令写法**（下文每条「命令」里的 `【前缀】` 就是这一行，都要先 `cd` 到上面的工作区）：

- PowerShell：`$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive'; $env:PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'; `
- Bash：`export PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive' PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'; `
- 后面接 `npm test -- server/test/<文件>`（PowerShell 与 Bash 一样）。不设这两个变量，用到真实账号后端的测试会被跳过，不是通过。

**几个词**：「开对话的人」= 对话所属账号（`ownerAccountId`）；「创建者」= 项目创建者；「已读」= Agent 一侧对这条消息确认过「读到了」并在文档服务账本里落了读取回执；「授权层」= 文档服务账本里每一轮任务的授权记录（`runGrantsV2`，状态 active / retained 保留 / revoked 撤销）。

#### 产品问题（没有就写「无」）

共 3 条，都不是语义上的拒绝，都是「写入或停止做对了/没做成，但回给人或模型的东西不对」或「接线缺口」，按要紧程度排：

1. **页面点「停止」在账号模式的进程内执行器组合上回 503，任务既没停也没按时结束。**
   - 复现：`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs`，看 todo 子测试「停止：这一轮停下、停之后才会说的话没有出现」。它让 Agent 跑一个带 6 秒等待的任务，在跑的时候对 `POST /agent/v1/conversations/<id>/abort` 发停止。
   - 期望：`docs/semantics/product/agent.md` 第 10 行「每个人只能停自己发起的那一轮」与 `cloud-agent-task.md` 完成条件第 5 条「停止……都可用」；停止后这一轮停下，停之后才会说的话不出现。
   - 实际：HTTP 503 `agent-fence-pending`（文档服务这边停止围栏已落账、授权已撤销，Agent 一侧没有确认）；之后等了 60 秒这一轮也没有出 `runner_done`。同一个停止，在文档服务对话权威一层是通的（见 2.1-3，`accept-018-conv-controls.test.mjs` 停任务那条，围栏确认用的是测试里放行的受控口）。这和 `AGENT-018-prep.md` 第 1 节第 1 项「执行器还差：终态+资源收干净、调度入口没有业务入口、正常结束和强制停止交错没有端到端」是同一块缺口；`account-worker-lifecycle.test.mjs` 里独立任务进程那一套能关进程，但页面发的「停止」没有接到它上面。已用 `test(..., { todo })` 标出，不会让 `npm test` 变红。
   - 要紧程度：2.3-5 的「停止」一项因此没有可跑通的证据。
2. **账号模式下文档服务拒绝过期写入时，回包不带当前版本号和期间的改动，模型读到「现在是 rev undefined」。**
   - 复现：同一个文件里的另一个 todo 子测试「过期写入被拒时，回给模型的话里要有当前版本号」（两个成员的 Agent 先后改同一个片段，后写的那个被拒）。
   - 期望：与非账号路径一致，`server/agent/agent-exec.mjs` 的 `staleMessage` 要拿到 `currentRev` 和 `since`，话里写「现在是 rev 9」并列出期间谁改了什么（桌面托管路径有测试：`agent-c65.test.mjs` 第 367 行「你读到的是 rev 10,现在是 rev 20」）。
   - 实际：`你读到的是 rev 8,现在是 rev undefined。这次写入没有落地。`，没有「期间的改动」。写入确实被拒、项目没被覆盖，所以只是给模型的信息不全。原因看起来是账号模式的写入走 `server/docservice/modules/project.mjs` 第 1042 行那条支路，回包只有 `{ type, projectId, opId, reason }`。
   - 要紧程度：低。
3. （观察，拿不准是不是问题）`GET /agent/v1/info` 在账号模式真实执行器那套组合里回 `executorMounted: false`，而任务确实在执行。可能只是字段只反映另一个标志。`accept-018-conv-endtoend.test.mjs` 里没有拿它当断言。

另有三条**验收脚手架上的问题**（不是产品功能）：

- 旧探针 `scripts/probes/cloud-agent-ui-probe.mjs`（清单里的 S4-4，管 2.3-5 的宽屏 AI 栏与手机占位、2.3-6 的撤销与署名）在 main 上跑不通：`node scripts/probes/cloud-agent-ui-probe.mjs --base-port 28580 --doc-port 28587 --asset-port 28588 --agent-port 28589 --phases online --dist <在线构建目录> --out <临时目录>` 第 3 项检查 `等 [data-pc="join-form"] 超时` 失败（共 3 项、1 失败，2026-10-13）。它走旧的口令加入流程，在线页面入口现在是账号登录。需要按账号模式改写后，宽屏 AI 栏、「云端」接入方式、手机占位这几条才有真浏览器证据。
- 好几个现成的测试夹具把端口写死在本组之外，且夹具里还有断言限定范围，没法搬到别的端口：`server/test/fixtures/account-conversation-controls-user-path.mjs` 第 132 行断言 `agentPort` 必须在 6620～6639；`server/test/fixtures/account-real-runner.mjs` 写死 6700 段并要 12 个端口（本组只有 10 个）。
- 简报里说「受控模型（rehearsal-model）」不准确：`server/agent-service/rehearsal-model.mjs` 是**读这台电脑桌面版真实模型配置**用的，不是受控模型。受控模型是脚本式模拟提供方（`vendor: 'mock'`，提示词里放 ```mock-script```），本组所有端到端都用的它，没有碰真实模型和密钥。

#### 新增文件

- `server/test/accept-018-conv-stack.mjs`：底座（不是测试文件，不会被 `npm test` 扫到）。起真的 VisuHive 账号库与凭证 + 文档服务的账号权限（建项目、加入、踢人、关 Agent、删项目）+ 对话权威 + 任务授权，同一份 SQLite 账本，支持「重启」（账号库、账本、Agent 实例全关再从同一目录打开）。不占端口。
- `server/test/accept-018-conv-controls.test.mjs`：2.1-3 全部子断言 + RS18-chat 在 main 上能验的部分。`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs`。结果：2026-10-13，6 条全过（tests 6 / pass 6 / fail 0），约 2 秒。
- `server/test/accept-018-conv-readexception.test.mjs`：2.1-4 全部子断言（改密选退出、被踢分别验；已读、未读、伪造已读、重启后、删项目与关 Agent、无关修改）+ 2.1-5 的「选否」。`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs`。结果：9 条全过，约 3～4 秒。
- `server/test/accept-018-conv-runner-fixture.mjs`：复制自 `server/test/fixtures/account-real-runner.mjs`，只改三处（端口由 28580 推出；模型配置可传；页面连接把收到的全部帧记下来），其余逐字相同。真的 VisuHive 后端 + 文档服务组合 + 独立素材进程 + Agent 执行器，只有模型是脚本式模拟提供方。占 28580～28588。
- `server/test/accept-018-conv-endtoend.test.mjs`：2.3-6 账号模式端到端、2.3-5 页面背后的接口。`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs`。结果：2026-10-13 共跑 4 次，退出码都是 0；其中 3 次有完整输出，每次 tests 4 / pass 2 / fail 0 / todo 2（两个 todo 就是上面「产品问题」1、2），耗时 91、135、171 秒（机器忙时差别大，其中 2.3-5 那条里约 60 秒是在等被拒停止后的那一轮自己结束，等不到才放弃）。另一次（57 秒）夹在一串顺序批跑里，日志只留下两行「✖」没有汇总，退出码仍是 0，疑似测试底座对 Node 原生崩溃的重跑吞掉了输出，没能复现；同一条命令再单独跑都是正常的。
- `scripts/probes/accept-018-conv-password-probe.mjs`：机械复制自 `scripts/probes/account-password-user-path-probe.mjs`，只把写死的端口 6680～6689 换成 28580～28589（共换 15 处），并在启动夹具那一行补传 `ports` 与 `agentPort`（原文件靠夹具缺省的 6680 段），其余逐字相同。真浏览器（无头 Chrome）驱动改密选退出的网页，看页面显示「正在退出」与「已退出」是否和四个服务的真实确认一致。跑法：`node scripts/probes/accept-018-conv-password-probe.mjs --dist <在线构建目录> --site-root C:\Users\admin\Documents\VisuHive\site --out <系统临时目录下的子目录>`（要先 `node ../../node_modules/vite/bin/vite.js build --mode online --outDir <目录> --emptyOutDir`；这次构建约 4 秒，产物在 `…\scratchpad\conv-dist\dist`）。结果：2026-10-13，退出码 0，47 项检查 47 过，`completed: true`，端口全部放回，约 40 秒。

没有改任何 `src/`、`server/` 下的产品代码，没有改已有测试和已有探针；没有 `git add`/提交。

---

#### 行 2.1-3：Agent 共有/私有及发送者

原文预期：「新建默认共有，A/B 可读完整历史/回复并发消息且逐条记实际作者；C/未登录拒绝；私有仅所属账号能用，项目创建者能看不能发，别的成员读和发都被拒；只有开对话的人能切换，共有切成私有后别的成员立刻看不到；每个人只能停自己发起的任务，创建者能停任何人的；创建者与参与者发起的 Agent 能做的事相同、创建者操作一律被拒，旧授权撤销不误伤其他成员」。环境与输入：「同项目账号 A/B、项目外账号 C、未登录、被踢成员；同账号换设备；A/B 发送不同消息」。证据要求：「服务端接口与界面证据」。（`docs/plan/account-binding-task.md`「逐项验收」表，第 3 行，约第 165 行）

行状态：**部分有**。服务端这一层所有子断言都有、都实跑过；「界面证据」（真浏览器里切私有后别的成员看不到）现成探针有，但夹具把端口锁死在 6620～6639，本组跑不了，未跑。

- **2.1-3.1 新建默认共有**
  - 证据：补了 `server/test/accept-018-conv-controls.test.mjs` 的「2.1-3 新建默认共有；A/B 读完整历史……」（断言新建对话 `visibility === 'shared'`、所属人是开对话的人）。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs`
  - 看哪一行：`✔ 2.1-3 新建默认共有；A/B 读完整历史、回复、发消息且逐条记实际作者；项目外账号与未登录被拒；同账号换设备可继续`
  - 实跑：2026-10-13，6/6 过。
  - 约耗时：2 秒（整个文件）
  - 在哪验：本机现在就能验
  - 说明：对话权威是真的，账号权限用的是真的 `createAccountAuthority` 加 VisuHive 真实凭证；同意提示与选区快照固定放行（受控）。
- **2.1-3.2 A、B 能读完整历史、回复、发消息**
  - 证据：同上那一条（乙读到甲先发的历史，创建者也读得到共有对话）；另 `server/test/agent-access-conversation.test.mjs` 的「shared conversation persists trusted sender, FIFO and ACK replay across SQLite restart」；`server/test/agent-access-http.test.mjs` 的「real mTLS doc + HTTP Agent: two accounts, private fence, consent, ACK replay, revocation」（真 mTLS 加真 HTTP，Bob、Alice 分别发消息，`GET` 看到 2 条）。
  - 命令：`【前缀】npm test -- server/test/agent-access-conversation.test.mjs server/test/agent-access-http.test.mjs`
  - 看哪一行：两个文件各 `✔` 全部用例
  - 实跑：2026-10-13，agent-access-conversation 5/5，agent-access-http 1/1，退出码 0。
  - 约耗时：0 秒 / 2 秒
  - 在哪验：本机现在就能验
  - 说明：agent-access-http 写死端口 5790、5791（不在 58xx/59xx 禁区，但不在本组段内；跑之前确认空着，跑完释放）。
- **2.1-3.3 逐条记实际作者**
  - 证据：`accept-018-conv-controls.test.mjs` 同一条（消息逐条 `senderAccountId` 与 `senderNameAtSend`，对话所属人甲、乙发的那条记乙）；`agent-access-http.test.mjs` 里 `spoof`（请求体里写别人的 `accountId`）回 400。
  - 命令：同 2.1-3.1 与 2.1-3.2
  - 看哪一行：同上
  - 实跑：同上，全过。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.4 项目外账号 C 被拒**
  - 证据：`accept-018-conv-controls.test.mjs` 第 1 条：项目外账号 `list`、`get`、`send` 都回 403 `not-listed`。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs`
  - 看哪一行：同 2.1-3.1
  - 实跑：同上，全过。
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.5 未登录被拒**
  - 证据：同一条：没有授权引用回 401 `login-required`，授权引用不存在回 401 `authorization-expired`；消息表里没有出现外人的字。
  - 命令、看哪一行、实跑：同上。
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：账号客户端的错误形状按真实 `server/account/client.mjs` 学的（缺令牌 `login-required`、无效令牌 `credential-revoked`）。
- **2.1-3.6 被踢成员被拒**（环境里点了名，原文预期里没有单列）
  - 证据：`server/test/accept-018-conv-readexception.test.mjs` 的「2.1-4 [被踢] 已读的共有当前任务继续……」：被踢账号的两台设备 `list`、`get`、`send`（已有对话和新对话）、`stop` 全部 403 `banned`；`server/test/account-projects-provider.test.mjs` 的「kick persists account ban and closes permissions for both device logins; notification alone does not complete」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/account-projects-provider.test.mjs`
  - 看哪一行：上面两条用例 `✔`
  - 实跑：2026-10-13，readexception 9/9，account-projects-provider 17/17（真实 VisuHive 提供方），退出码 0。
  - 约耗时：4 秒 / 4 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.7 同账号换设备能继续**
  - 证据：`accept-018-conv-controls.test.mjs` 第 1 条：甲的第二台设备读到全部 2 条历史并能继续发，作者仍是甲。
  - 命令、看哪一行、实跑：同 2.1-3.1。
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.8 私有仅所属账号能用**
  - 证据：`accept-018-conv-controls.test.mjs`「2.1-3 私有：仅所属账号能用……」（所属人照常读、发）。
  - 命令、实跑：同 2.1-3.1。
  - 看哪一行：`✔ 2.1-3 私有：仅所属账号能用；创建者能看不能发；别的成员读和发都被拒；只有开对话的人能切换；切私有后别的成员立刻看不到`
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.9 项目创建者能看不能发**
  - 证据：同一条：创建者列表里有这个对话（`creatorReadOnly: true`）、读得到 3 条消息，发消息和切换都回 404 `no-conversation`；另 `agent-access-conversation.test.mjs`「private switch fences other queue and preserves creator read-only」、`agent-access-http.test.mjs`（创建者 `GET` 200、`POST` 404）。
  - 命令：同 2.1-3.1、2.1-3.2。
  - 实跑：同上，全过。
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.10 别的成员读和发都被拒**
  - 证据：同一条：乙在切私有后 `get`、`send` 都回 404，列表里没有这个对话。
  - 命令、实跑：同 2.1-3.1。
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.11 只有开对话的人能切换**
  - 证据：同一条：乙和创建者在共有对话里切私有都回 403 `owner-required`；私有以后乙、创建者想切回共有回 404；所属人切得动、能切回；`agent-access-http.test.mjs` 里 Alice 切 Bob 的对话回 403。
  - 命令、实跑：同上，全过。
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.12 共有切成私有后别的成员立刻看不到（服务端）**
  - 证据：同一条：同一个乙，前一次 `get` 读到 2 条，所属人切私有那一次返回后下一次 `get` 就是 404，排队没轮到的那条作废（`cancelled.length === 1`）；`agent-access-http.test.mjs`：切私有时 Alice 手里那条老的事件流被服务端关掉，之后 `GET` 回 404，且没有收到被禁止的「尾巴」事件。
  - 命令：同 2.1-3.1、2.1-3.2。
  - 实跑：同上，全过。
  - 约耗时：2 秒 / 2 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.12b 界面上也立刻看不到**
  - 证据：`scripts/probes/account-conversation-controls-probe.mjs`（真浏览器，三个账号三页：创建者、所属人、成员；检查项含「所属人切私有被真实服务确认」「成员旧事件流关闭」「成员当前消息清空」「成员历史列表服务端和界面都不含该对话」「创建者只读」）。
  - 命令：`node scripts/probes/account-conversation-controls-probe.mjs --dist <在线构建目录> --site-root C:\Users\admin\Documents\VisuHive\site --out <系统临时目录下的子目录>`（先用上面的构建命令出在线构建）
  - 看哪一行：结果 JSON 里 `completed: true`，`checks` 里 `private-switch-real-fence-confirmed`、`ordinary-member-old-read-closed-after-private`、`ordinary-member-private-history-ui-omits-id` 都是 true。
  - 实跑：**未跑。** 原因：探针和它的夹具把端口写死在 6620～6629（夹具第 132 行还断言 `agentPort` 在 6620～6639），不在本组端口段，不能搬；也不能改已有文件。
  - 约耗时：未测（旧记录是几十秒）
  - 在哪验：本机现在就能验
  - 说明：主会话在 6620～6629 空着的时候直接跑即可；本组已经做好一份在线构建放在 `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin-Documents-PromptCut\0b89263a-865b-4aec-824d-06337ce95565\scratchpad\conv-dist\dist`（内容是本工作区当前的树），可以直接给 `--dist`。
- **2.1-3.13 每个人只能停自己发起的任务**（这是底稿说「没有单列证据」的那条）
  - 证据：补了 `accept-018-conv-controls.test.mjs`「2.1-3 停任务的权限：每个人只能停自己发起的那一轮……」。三步：乙不能停甲发起的那一轮（403 `initiator-required`），项目外账号 403 `not-listed`，未登录 401；被拒之后甲那一轮仍是 active、对话当前轮没变；甲停自己的成功（授权 revoked，原因 `stop`），**乙排着的消息不受影响**；已经停掉的那一轮再停回 404 `no-run`；对话所属人甲**也停不了乙发起的那一轮**（403）；乙停自己的成功。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs`
  - 看哪一行：`✔ 2.1-3 停任务的权限：每个人只能停自己发起的那一轮，创建者能停任何人的（含别人私有对话里的），外人和未登录不能`
  - 实跑：2026-10-13，过。
  - 约耗时：<1 秒（整个文件 2 秒）
  - 在哪验：本机现在就能验
  - 说明：任务是真的授权记录（真的 `admit` 领取、`confirmRead` 确认已读，再停）。这一层不包含 Agent 进程真的收到停止，那一层是产品问题 1。
- **2.1-3.14 创建者能停任何人的任务**
  - 证据：同一条：创建者停乙发起的那一轮成功；乙在**私有**对话里发起的任务，创建者也能停（成功），而另一个成员连这个对话都看不到（404）。
  - 命令、实跑：同上。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：「创建者能停别人私有对话里的任务」原文没明说，按语义「项目创建者能停任何人的任务」读；如果用户的意思是私有对话里创建者只读、连停都不行，这条会和语义不一致，请主会话留意。代码里 `server/account/conversation-authority.mjs` 的 `stop` 就是这样做的。
- **2.1-3.15 创建者与参与者发起的 Agent 能做的事相同、创建者特权一律被拒**
  - 证据：补了 `accept-018-conv-controls.test.mjs`「2.1-3 创建者与参与者发起的 Agent 能做的事相同……」：创建者发起的一轮和甲发起的一轮，Agent 身份里的 `creator` 都是 `false`；`checkAccess` 写权限两者返回同样形状；要管理权限（`admin`）两者一律 403 `run-principal-invalid`；文档服务一侧用 Agent 身份去申请 `admin`，创建者本人和参与者一样被拒（403 `creator-required`）。另 `account-projects-provider.test.mjs`「creator Agent identity never administrator; other account cannot admin」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs server/test/account-projects-provider.test.mjs`
  - 看哪一行：两条用例 `✔`
  - 实跑：2026-10-13，全过（6/6 与 17/17）。
  - 约耗时：2 秒 / 4 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-3.16 旧授权撤销不误伤其他成员**
  - 证据：同一条：甲的手机登录被撤销（真实 `logoutLogin`），手机上再发回 401 `credential-revoked`，该登录排着的消息作废，而甲的电脑登录照常发、乙排着的消息被领到（下一轮是乙的）；`readexception` 里被踢/退出时乙与创建者读发照常、乙排着的消息下一轮被领取；`account-projects-provider.test.mjs`「ordinary real logout consumes exact global account sequence … new login survives」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs server/test/accept-018-conv-readexception.test.mjs server/test/account-projects-provider.test.mjs`
  - 看哪一行：对应用例 `✔`
  - 实跑：2026-10-13，全过。
  - 约耗时：各 2～4 秒
  - 在哪验：本机现在就能验
  - 说明：无

补充（原文没有、语义有）：「切成私有的那一刻别的成员在这个对话里还在跑的任务立刻中止、已落地修改保留」有证据：`server/test/account-worker-lifecycle.test.mjs`「改密选退出：共有对话里已读的当前任务继续做完……；切私有：别人的任务被中断」（真的任务子进程被 root 关掉，2026-10-13 8/8 过，15 秒）与 `server/test/run-authority-core.test.mjs`（20/20，1 秒）。

---

#### 行 2.1-4：Agent 已读消息撤回例外

原文预期：「两种原因下已读消息原文和作者保留；私有任务中止，共有已读当前任务继续且其修改不撤回；未读不取得继续执行授权；被踢账号全设备拒绝查看/发送/启动下一轮，旧登录不能发新消息，其他有效成员不误伤；重启后仍可准确判定；删项目或关闭 Agent 仍中止任务」。环境与输入：「改密选退出、被踢分别验；已发送且 Agent 已读、已发送未读、读状态落盘后重启、客户端伪造已读；共有/私有任务、被踢账号全部设备再读/发/启动下一轮、旧登录再发、其他有效成员、无关修改；另验删项目与关闭 Agent」。（`account-binding-task.md`「逐项验收」第 4 行，约第 166 行；「其修改不撤回」归 0.7.20。）

行状态：**已有可跑的证据**（所有适用子断言都有、都实跑过；「共有已读任务继续」在被踢情形下只验到授权层，进程层只有改密退出那一种，见 2.1-4.4 说明）。

下面「授权层」的每一条都在 `server/test/accept-018-conv-readexception.test.mjs` 里，一个文件跑完全部：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs`，2026-10-13，9/9 过，约 3～4 秒。它用真的 VisuHive 账号库（真改密、真「退出」选择）、真的文档服务踢人/关 Agent/删项目、真的任务授权与读取确认，同一份账本；两种原因共用同一套断言，各跑一遍。

- **2.1-4.1 [改密选退出] 已读消息原文和作者保留**
  - 证据：`readexception` 的「2.1-4 [改密选退出] 已读的共有当前任务继续、私有任务中止、未读作废；原文与作者保留；该账号再读/发/启动下一轮被拒；其他成员不误伤」：已读的共有消息 m1 与私有消息 p1，原文、发送者、读取回执全在，m1 仍是 `running`。
  - 命令：上面那条。
  - 看哪一行：该用例 `✔`
  - 实跑：过。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.2 [被踢] 已读消息原文和作者保留**
  - 证据：同一个文件的「2.1-4 [被踢] 已读的共有当前任务继续……」，同样断言。
  - 命令、实跑：同上。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.3 私有任务中止**（两种原因各一）
  - 证据：两条用例都断言私有对话里已读的那一轮授权变 `revoked`，再向它要 Agent 身份回 `run-no-longer-current`/`run-revoked`；进程层：`server/test/account-worker-lifecycle.test.mjs`「退出确认里 Agent 这一项：私有任务被 root 关掉、文档服务结清之后才算确认……」（真的任务子进程被强制关掉，文档服务读到关闭记录才算确认）。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/account-worker-lifecycle.test.mjs`
  - 看哪一行：对应用例 `✔`
  - 实跑：2026-10-13，9/9 与 8/8 过。
  - 约耗时：4 秒 / 15 秒
  - 在哪验：本机现在就能验
  - 说明：进程层是 Windows 上「子进程真的退出」代替 Linux 的进程组（夹具文件开头写明）；真 Linux 的关进程部分归「要部署到节点后验」。
- **2.1-4.4 共有已读当前任务继续（两种原因各一）**
  - 证据：授权层：两条用例都断言共有对话里已读的当前任务授权是 `retained`（原因 `credential`/`member`），仍能通过 `checkAccess` 拿到 `retainedGrant`（`currentRun: true`），做完 `finish` 后消息变 `done`，下一轮不是该账号发起的。进程层：`account-worker-lifecycle.test.mjs`「改密选退出：共有对话里已读的当前任务继续做完……」（任务进程没被关，做完以 `done` 结清，退出以后文字继续写进对话）与「退出确认里 Agent 这一项……共有已读任务不用等它做完」。
  - 命令、实跑：同 2.1-4.3。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：**被踢**情形下的进程层「继续做完」没有单独的测试，只在授权层验了；是不是需要补，请主会话定（`account-worker-lifecycle` 夹具里只有「退出」触发器）。
- **2.1-4.5 「其修改不撤回」**
  - 证据：无
  - 在哪验：对 0.7.18 不适用（归 0.7.20，依据：任务书「Agent 已读消息撤回例外」归属说明）
  - 说明：本组验的是「保留的任务继续、已落地的消息与回执不删」，没有验修改的撤回范围。
- **2.1-4.6 未读不取得继续执行授权**（两种原因各一）
  - 证据：两条用例：同一个共有对话里该账号另一台设备发的、Agent 还没读的 m2，以及私有对话里排着的 p2，都变 `cancelled`（不领取、不启动下一轮），文字仍在历史里；`account-worker-lifecycle.test.mjs`「改密选退出……旧登录排着的下一条不再执行」（旧登录排着的消息被取消，没有任务授权、没有进程替它干活）。
  - 命令、实跑：同 2.1-4.3。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.7 客户端伪造已读**
  - 证据：`readexception` 的「2.1-4 「已发送」不等于「已读」：伪造已读不取得继续执行授权；客户端自带的已读字段被忽略」：发送时带 `readReceiptId`、`queueState: 'running'`、`runId`、别人的 `senderAccountId`，服务端落下的消息仍是排队、没有回执、作者是真发送者；Agent 领取后「读到了」的确认被篡改内容，被拒（`complete-prompt-unverified`）、没有回执；此时该账号被踢，那一轮授权 `revoked`、消息作废、账本里没有任何读取回执。另 `server/test/run-authority-core.test.mjs`「full durable record is independently checked, including sender/selection/attachments and service identity」。HTTP 一层请求体里夹带身份字段会被拒 400：`agent-access-http.test.mjs` 的 `spoof`。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/run-authority-core.test.mjs server/test/agent-access-http.test.mjs`
  - 看哪一行：对应用例 `✔`
  - 实跑：2026-10-13，9/9、20/20、1/1 过。
  - 约耗时：4 秒 / 1 秒 / 2 秒
  - 在哪验：本机现在就能验
  - 说明：HTTP 一层没有专门用「已读」字段做夹带的用例，只有 `accountId`/`senderAccountId` 那一类身份字段的（`server/agent-service/http.mjs` 的账号路由对 `accountId`、`senderAccountId`、`principal`、`creator` 等字段回 400）。
- **2.1-4.8 被踢账号全设备拒绝查看/发送/启动下一轮**
  - 证据：`readexception` 被踢那条：两台设备都 `list`、`get`、`send`（旧对话和新对话）、`stop` 403 `banned`；项目列表里没有这个项目；该账号排着的消息作废，下一轮领到的是别人；`account-projects-provider.test.mjs`「kick persists account ban and closes permissions for both device logins」。
  - 命令、实跑：同 2.1-3.6。
  - 约耗时：4 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.9 旧登录不能发新消息**
  - 证据：`readexception` 改密选退出那条：旧登录（两台设备）`get`、`send` 都 401 `credential-revoked`，而改密之后新开的登录能读；`run-authority-core.test.mjs`「real async credential gap cannot admit after durable exit」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/run-authority-core.test.mjs`
  - 实跑：过。
  - 约耗时：4 秒 / 1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.10 其他有效成员不误伤**
  - 证据：两条用例里乙与创建者读、发都照常，乙排着的消息在保留任务做完之后被领取；另一条「无关修改」用例：项目入口改动、**另一个账号**（乙）改密选退出，都不影响甲正在跑的共有与私有任务和排队的消息，甲读发照常（乙自己用旧登录排着的那条消息作废，这是乙的退出结果）。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs`
  - 看哪一行：`✔ 2.1-4 无关修改不误伤：……`
  - 实跑：过。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.11 重启后仍可准确判定**（这是任务要重点补的）
  - 证据：`readexception` 的两条「读状态落盘后重启」（被踢、改密选退出各一条），分两个顺序：①已读状态落盘 → 账号库、账本、Agent 实例全部关掉再从同一目录打开（Agent 拿到新的内存密钥）→ 再触发：重启后已读消息的回执还在、未读仍是未读，触发后同样判成「共有已读保留、私有中止、未读作废」，新的 Agent 实例不能顶替旧实例去接这些任务（`run-instance-mismatch`）；②先触发 → 重启：授权状态与消息状态逐项相同，被踢账号仍 403 `banned`、旧登录仍 401 `credential-revoked`。另外现成的：`server/test/run-authority-crash.test.mjs`「actual SQLite child process crashes preserve doc read and Agent intent without replaying an uncertain external effect」（19 个切点各用真子进程在提交前后杀掉再从磁盘恢复）；`server/test/agent-read-control.test.mjs`「disconnect and doc restart preserve open inventory; only original live RAM key can reprove」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/run-authority-crash.test.mjs server/test/agent-read-control.test.mjs`
  - 看哪一行：对应用例 `✔`（crash 那个文件 20 条）
  - 实跑：2026-10-13，9/9、20/20、10/10 过。
  - 约耗时：4 秒 / 3 秒 / 1 秒
  - 在哪验：本机现在就能验
  - 说明：「重启」指文档服务与 Agent 实例的重启；Agent 进程被杀后任务在对话里报中断见 2.3-6。
- **2.1-4.12 删项目仍中止任务**（两种原因各一）
  - 证据：`readexception`「2.1-4 [被踢]/[改密选退出] 例外只保留当前任务授权：之后关闭 Agent、删项目仍然中止保留的任务」中 `delete` 一支：触发后保留的任务是 `retained`，真的管理员删项目后变 `revoked`，原因 `delete`。另 `run-authority-core.test.mjs`「delete terminates retained current run and never revives on reopen」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/run-authority-core.test.mjs`
  - 实跑：过。
  - 约耗时：<1 秒 / 1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-4.13 关闭 Agent 仍中止任务**（两种原因各一）
  - 证据：同一条用例的 `agent-off` 一支（真的 `set-hosted-service agent false`），原因 `agent-disabled`；另 `run-authority-core.test.mjs`「agent-disabled terminates retained current run …」。
  - 命令、实跑：同上。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：无

---

#### 行 2.1-5：设备退出与延迟撤回

原文预期（0.7.18 只含前半）：「动画与真实完成一致；重启后续办」；环境：「选是/否；通知丢失、重复、重启、旧登录在延迟期间写入、新登录及其他账号交织改动」。归属：「选是或否、动画与真实完成一致、通知丢失或重复或重启后续办归 0.7.18；撤回范围与交织改动归 0.7.20」。（`account-binding-task.md`「逐项验收」第 5 行，约第 167 行与第 175 行归属段。）

行状态：**部分有**。选是/否、通知丢失/重复/重启后续办、动画与真实完成一致（页面这一层）都有且跑过；「选否」只有服务端证据，页面上的「选否」按钮路径没有探针。

- **2.1-5.1 选「是」：其他设备全部退出，发起设备保留**
  - 证据：`server/test/account-password-user-path.test.mjs`「改密退出只保留发起网站会话并撤销其它网站与在线编辑器登录」（真 VisuHive 后端 + 文档 + 素材 + Agent 读取控制；也走了邮箱重设密码那条路）；`account-logout-confirmation.test.mjs` 各子测试；我新补的真浏览器探针 `scripts/probes/accept-018-conv-password-probe.mjs`。
  - 命令：`【前缀】npm test -- server/test/account-password-user-path.test.mjs server/test/account-logout-confirmation.test.mjs`；探针命令见「新增文件」。
  - 看哪一行：测试 `✔`；探针的 `exit-choice-awaits-real-service-confirmations`、`reset-exit-choice-awaits-real-service-confirmations`、`online-editor-real-read-body-cleared-after-revocation`、`subsequent-real-history-read-denied-after-revocation`。
  - 实跑：2026-10-13：account-password-user-path 1/1（5 秒，已知忙时偶发，本次一次过），account-logout-confirmation 5/5（17 秒）；探针 47/47、退出码 0、约 40 秒。
  - 约耗时：5 / 17 / 40 秒
  - 在哪验：本机现在就能验
  - 说明：`account-password-user-path.test.mjs` 写死端口 6680～6687，不在本组段内，跑前确认了空着；探针用本组 28580～28589。
- **2.1-5.2 选「否」：旧登录与旧登录的任务都不受影响**
  - 证据：补了 `readexception` 的「2.1-5 改密选「否」(不退出别的设备)：旧登录、正在跑的任务、排队的消息都不受影响」（真的 `store.choose(…, false)`：共有与私有任务都仍是 active，排着的消息仍排队，两台旧登录照常读、发）；`account-projects-provider.test.mjs`「real password success retains old access for choice no; choice yes exact old set preserves new B login and initiator website」；`run-authority-core.test.mjs`「actual account SQLite password choice: no exit keeps run, exit retains exact shared current and fresh login remains independent」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-readexception.test.mjs server/test/account-projects-provider.test.mjs server/test/run-authority-core.test.mjs`
  - 实跑：2026-10-13，9/9、17/17、20/20 过。
  - 约耗时：4 / 4 / 1 秒
  - 在哪验：本机现在就能验
  - 说明：页面上点「不退出」的真浏览器路径没有探针（探针只走选「退出」）；要不要补，请主会话定。
- **2.1-5.3 动画与真实完成一致（页面在四个服务确认之前一直显示「正在退出」，齐了才显示「已退出」）**
  - 证据：`account-logout-confirmation.test.mjs` 第 1、3 条子测试（Agent 没确认 / 素材没确认：反复读页面读的那个接口，每次都是 `revoking` 并列出还差谁，补齐后才 `complete`，文档服务这一项等别的服务齐了才报）；浏览器探针 `accept-018-conv-password-probe.mjs` 的 `ui-never-shows-exited-before-all-service-acks`、`ui-shows-exited-after-all-service-acks`（真页面文字）。
  - 命令：同 2.1-5.1。
  - 实跑：同上，过。
  - 约耗时：17 秒 / 40 秒
  - 在哪验：本机现在就能验
  - 说明：「动画」我理解为页面「正在退出→已退出」的状态显示。
- **2.1-5.4 通知丢失**
  - 证据：`account-logout-confirmation.test.mjs` 第 2 条子测试「通知没送到、回应丢了、同一份确认重复送到：照样办完，而且只办一次」：文档服务取账号事件的请求丢 3 次、确认的回应丢 2 次、结束见证的回应丢 1 次，三种故障 `applied` 都是 3/2/1，仍办完。
  - 命令、实跑：同上，5/5 过。
  - 约耗时：17 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-5.5 通知重复**
  - 证据：同一条子测试：重复的确认没变成两份（每个服务一行，结束位置只有一个，两边记的是同一个）；办完以后再催 3 次不再发任何东西。
  - 命令、实跑：同上。
  - 约耗时：17 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-5.6 重启后续办**
  - 证据：同一个文件第 3 条子测试（素材服务停着、改密选退出：不显示成功，素材服务在同一目录重新起来后接着办完）与第 4 条（文档服务在等确认的时候重启：重启后接着办完，不显示假成功，也不放回旧登录，新密码照常进项目）；`account-projects-provider.test.mjs`「persisted service ACK idempotency and restart do not invent doc close/order evidence」。
  - 命令、实跑：同上。
  - 约耗时：17 秒 / 4 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.1-5.7 撤回范围与交织改动（含「旧登录在延迟期间写入、其他账号与新登录的合法改动不受影响」）**
  - 证据：无
  - 在哪验：对 0.7.18 不适用（归 0.7.20）
  - 说明：「新登录不受影响」本组的 2.1-4 与 2.1-5.2 测试里顺带验了账号级的（改密之后新开的登录照常），但不是文档修改的撤回范围。

---

#### 行 2.3-6：端到端实测

原文预期（`docs/plan/cloud-agent-task.md`「完成条件」第 6 条，约第 82 行）：「桌面版建协作项目放云端；在线浏览器成员在 AI 栏里让云端 Agent 改项目（改文案、挪片段、调卡片参数各一次）；桌面版与另一个在线成员都看到改动，署名正确；撤销语义与本机 Agent 一致；两个成员同时各开一个对话互不串；Agent 服务进程被杀后自动拉起，进行中的对话明确报中断、可以重开」。「真实模型」不做，用受控模型。

行状态：**部分有**。账号模式下的三种修改、署名、两成员互不串都补了真实组合的测试并跑过；撤销、进程被杀后的「中断可重开」只有非账号模式或授权层的证据；「桌面版」「自动拉起」要别的环境。

- **2.3-6.1 桌面版建协作项目放云端**
  - 证据：夹具通过真实站点接口建项目并有两个真账号（创建者与成员）加入；桌面版界面上「放云端」没有证据。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs`
  - 实跑：2026-10-13，项目建好、两个账号的页面连接都连上并读到项目（测试开头）。
  - 约耗时：约 10 秒（夹具起停）
  - 在哪验：要安装包（桌面版界面）；夹具这一步本机现在就能验
  - 说明：无
- **2.3-6.2 在线成员让云端 Agent 改项目：改文案、挪片段、调卡片参数各一次**
  - 证据：补了 `accept-018-conv-endtoend.test.mjs`「2.3-6 账号模式端到端：改文案、挪片段、调卡片参数各一次；署名；两个成员各开一个对话互不串」。甲先让 Agent 加一张文字卡，再各开一个对话做三次修改：`update_clip` 改文案（原文案→新文案）、挪片段（起止 0–4 → 2–6）、调卡片参数（`staggerMs` 100→300）；每次都读回项目确认真的变了；工具结果都是 ok。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs`
  - 看哪一行：`✔ 2.3-6 账号模式端到端……`，诊断行 `改文案 ok`、`挪片段 ok`、`调卡片参数 ok`
  - 实跑：2026-10-13，有完整输出的 3 次都过（另一次见「新增文件」里的说明）。
  - 约耗时：16～59 秒（该条）
  - 在哪验：本机现在就能验
  - 说明：「AI 栏里发」这一步是用页面同样调用的 Agent HTTP 接口加真 WebSocket 页面连接做的，不是点界面；界面上点着发的账号模式探针（`account-real-runner-probe.mjs`）只让 Agent 改项目名，不含这三种修改，且端口占 6700～6711，本组跑不了。
- **2.3-6.3 桌面版与另一个在线成员都看到改动**
  - 证据：同一条：另一位成员（乙）的页面连接收到三次 `project.ops` 广播。桌面版走同一套页面连接协议，没有单独的桌面端测试。
  - 命令、实跑：同上。
  - 约耗时：同上
  - 在哪验：本机现在就能验（桌面版界面部分要安装包）
  - 说明：无
- **2.3-6.4 署名正确**
  - 证据：同一条：乙收到的每次广播里，写入者是甲的账号编号（发起这一轮的人）、身份带 `service: agent`、角色 `agent`，三次一致；两个成员各开对话时，每个对话的事件都只属于自己的发起人。
  - 命令、实跑：同上。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：界面上「Agent 操作记录」里写「你的云端 Agent」这一条只有旧探针 `cloud-agent-ui-probe.mjs` 的 O1，在 main 上跑不通（见产品问题下的脚手架问题）。
- **2.3-6.5 撤销语义与本机 Agent 一致**
  - 证据：同一套项目写入协议下的现成测试：`server/test/c65b-agent.test.mjs`（D2-02 写工具事件带 `opId` 和 `inverse`、D2-03 页面按事件提交 `inverse` 加 `undoOf`、D2-04 撤销也查冲突、D2-05 不是最新的一步也能撤）与 `server/test/c65-undo.test.mjs`（5 条），2026-10-13 共 17/17 过，约 114 秒。
  - 命令：`【前缀】npm test -- server/test/c65-undo.test.mjs server/test/c65b-agent.test.mjs`
  - 看哪一行：`✔ C65B-D2-03 页面按事件提交 inverse + undoOf……` 等
  - 约耗时：114 秒
  - 在哪验：本机现在就能验
  - 说明：这些是文档服务协议一层、非账号模式的；账号模式下点「撤销这步」撤掉 Agent 的修改，没有探针（旧探针 O1 在 main 上跑不通）。所以只算「部分」。
- **2.3-6.6 两个成员同时各开一个对话互不串**
  - 证据：同一条：甲、乙各开一个对话，同时让 Agent 改（乙那一边先等 2.5 秒再读再写，避开同一处的写入冲突），每个对话回复文字、工具调用只有自己的，事件都属于自己的对话和发起人，两个对话的任务授权不同；两处修改都落进同一个项目（标签 与 不透明度 都在）。
  - 命令、实跑：同上。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：如果不错开，后写的那个会被拒（保护是对的，见产品问题 2）。
- **2.3-6.7 Agent 服务进程被杀后，进行中的对话明确报中断、可以重开**
  - 证据：现成探针 `scripts/probes/cloud-agent-run-probe.mjs` 的 C1～C4：真的结束 Agent 服务进程（SIGKILL）、重新起来后状态是 `interrupted` 且原因可读、不自动续跑、可以接着发消息重开；账号模式一侧：`account-worker-lifecycle.test.mjs`「从外面强制停：任务没做完就被 root 强制关掉，结果是「被中断」，后面排队的照常接着跑」与「任务进程中途死掉……结果是「失败」，后面的照常」。
  - 命令：`node scripts/probes/cloud-agent-run-probe.mjs`（要先确认 8798、5741 空着；已设 `PROMPTCUT_NO_PORT_FILE=1`）与 `【前缀】npm test -- server/test/account-worker-lifecycle.test.mjs`
  - 看哪一行：`PASS C1`…`PASS C4` 与最后一行 `共 17 条,通过 17,失败 0`
  - 实跑：2026-10-13，探针 17/17 过（退出码 0）；account-worker-lifecycle 8/8 过（15 秒）。
  - 约耗时：约 1～2 分钟 / 15 秒
  - 在哪验：本机现在就能验
  - 说明：探针是旧的 `Bearer test:` 替身鉴权，不是账号模式；它验的是 Agent 服务本身的中断与重开。
- **2.3-6.8 进程被杀后「自动拉起」**
  - 证据：无（探针里的重新起来是探针自己做的）
  - 在哪验：要部署到节点后验（要有进程守护，如 systemd 重启策略）
  - 说明：无

---

#### 行 2.3-5：在线页面

原文预期（`cloud-agent-task.md`「完成条件」第 5 条，约第 81 行）：「在线页面：宽屏下右侧占位换成可用的 AI 栏，接入方式有「云端」；发消息、流式回复、停止、工具调用的过程显示、对话记录的重开，都可用。手机仿真下仍是占位。守卫与棘轮清单按设计更新，在线构建不带出桌面专用的调用。」

行状态：**部分有**。页面背后的接口（发消息、流式、工具调用过程、重开）在账号模式下补了真实组合的测试并跑过；页面本身（宽屏 AI 栏、「云端」接入方式、手机占位）没有账号模式的真浏览器证据，旧探针在 main 上跑不通；「停止」是产品问题 1。

- **2.3-5.1 宽屏下右侧是可用的 AI 栏，不是占位**
  - 证据：账号模式的真浏览器探针里有面板挂载的检查（`account-conversation-controls-probe.mjs` 的 `cloud-ai-panel-not-mounted` 守卫），但没跑（端口，见 2.1-3.12b）；旧探针 `cloud-agent-ui-probe.mjs` O0 在 main 上跑不通。
  - 命令：见 2.1-3.12b
  - 实跑：旧探针 2026-10-13 跑了一次，3 项检查 1 项失败（等 `join-form` 超时），日志里有失败原文；账号模式探针未跑。
  - 约耗时：旧探针约 40 秒
  - 在哪验：本机现在就能验（要先解决端口，或把旧探针按账号模式改写）
  - 说明：无
- **2.3-5.2 接入方式有「云端」**
  - 证据：页面逻辑单测 `src/ai/cloud/cloud-chat.test.mjs`「CAU-EP-01 「云端」出不出现：放本机的项目没有，文档服务报了才有，开关关了置灰，在线页面地址固定」；`/v1/info` 在账号模式回 `accountMode: true, enabled: true`（`accept-018-conv-endtoend.test.mjs` 2.3-5 那条）。真下拉框没有。
  - 命令：`【前缀】npm test -- src/ai/cloud/cloud-chat.test.mjs server/test/accept-018-conv-endtoend.test.mjs`
  - 实跑：2026-10-13，cloud-chat 单测与 2.3-5.9 的两个守卫文件合跑 24/24 过；endtoend 见上。
  - 约耗时：2 秒（单测）
  - 在哪验：本机现在就能验
  - 说明：部分（单测，不是真下拉框）。
- **2.3-5.3 发消息**
  - 证据：`accept-018-conv-endtoend.test.mjs`「2.3-5 账号模式下 AI 栏背后的接口……」：`POST …/messages` 回 202；`/v1/info`；`account-real-runner.test.mjs`「actual hosted factory signs WSS/project.open, executes real tools and commits doc revision; settlement stays pending」（1/1，9 秒）。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs server/test/account-real-runner.test.mjs`
  - 实跑：2026-10-13，过。
  - 约耗时：约 70 秒 / 9 秒
  - 在哪验：本机现在就能验
  - 说明：接口层。界面点着发的探针 `account-real-runner-probe.mjs` 没跑（端口 6700～6711 共 12 个，本组只有 10 个）。
- **2.3-5.4 流式回复**
  - 证据：同一条：事件流在这一轮结束之前（Agent 还在等的那 5 秒里）就推来了工具调用结果；这一轮结束后收尾的话也到了同一条流里；`account-real-runner-sse.test.mjs`（SSE 轮询与围栏分发，1/1）；页面单测 `cloud-chat.test.mjs` 的 `CAU-SES-04 文字增量攒批后折进去`。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs server/test/account-real-runner-sse.test.mjs src/ai/cloud/cloud-chat.test.mjs`
  - 实跑：过。
  - 约耗时：约 70 秒 / 1 秒 / 1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **2.3-5.5 停止**
  - 证据：对话权威一层的停止是通的（2.1-3.13、2.1-3.14）；页面单测 `CAU-SES-03 关闭只掐流不发停止；停止才发 abort`。但整条链（点停止→Agent 真的停）在账号模式的进程内执行器组合上回 503，见产品问题 1。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-endtoend.test.mjs`（todo 子测试）
  - 实跑：todo 子测试的断言失败（503 `agent-fence-pending`），按设计不让 `npm test` 变红。
  - 约耗时：约 60 秒（该子测试）
  - 在哪验：要等某一块合入（独立任务进程的页面「停止」接线，归最后的接线包；`AGENT-018-prep.md` 第 1 节第 1 项）
  - 说明：这一条目前**没有**可通过的证据。
- **2.3-5.6 工具调用的过程显示**
  - 证据：同一条接口测试：流里有 `get_project` 的工具调用结果；重开时读回的过程里也有；页面单测 `CAU-EV-01 事件折成消息……`。
  - 命令、实跑：同 2.3-5.4。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：界面上看到工具调用的探针（`account-real-runner-probe` 的 `real-tools-visible`）没跑。
- **2.3-5.7 对话记录的重开**
  - 证据：同一条接口测试：任务还在跑时换一条新连接按 `after=0` 读回用户消息与工具调用，对话详情和历史列表里都有；`cloud-chat.test.mjs`「CAU-SES-02 新对话读到「没有」就停下，发消息后接上；服务端把对话丢了就标中断」。
  - 命令、实跑：同上。
  - 约耗时：同上
  - 在哪验：本机现在就能验
  - 说明：无
- **2.3-5.8 手机仿真下仍是占位**
  - 证据：只有旧探针 `cloud-agent-ui-probe.mjs` 的 O6（在 main 上跑不通）。账号模式下没有。
  - 命令：无
  - 实跑：未跑
  - 在哪验：本机现在就能验（要补账号模式探针）
  - 说明：本组没补：要在真浏览器里用手机仿真打开账号模式的在线页面，夹具要 11 个端口，超出本组的 10 个。
- **2.3-5.9 守卫与棘轮清单按设计更新，在线构建不带出桌面专用的调用**
  - 证据：`src/online/c10a-api-guard.test.mjs`（`C10A-API-05` 在线模式 `fetch('/api/…')` 抛错、`account website calls pass only in the top editor…`）、`src/online/onlinePrune.test.mjs`（`PRUNE-01/02`）、`src/ai/cloud/cloud-chat.test.mjs`（`CAU-ATT-03` 云端这条路不引本机附件模块、不带 `/api/chats/attach`；`CAU-ID-02` 没有探针用的全局回退口子）；`server/test/cloud-agent-service.test.mjs`「CA-SEAM-01 新目录里没有指向 src/ 的 import」。
  - 命令：`【前缀】npm test -- src/online/c10a-api-guard.test.mjs src/online/onlinePrune.test.mjs src/ai/cloud/cloud-chat.test.mjs server/test/cloud-agent-service.test.mjs`
  - 看哪一行：对应用例 `✔`
  - 实跑：2026-10-13，前三个文件合跑 24/24 过（2 秒）；cloud-agent-service 18/18 过（17 秒）。
  - 约耗时：2 秒 / 17 秒
  - 在哪验：本机现在就能验
  - 说明：「按设计更新」是文档对照，不是测试。

---

#### 行 RS18-chat：50 个对话（同项目同创建者 49→50→第 51、共享消息多发送者、另一项目/创建者、并发创建、用户删除后重建/重开）

原文（`account-binding-task.md`「新增验收映射」，约第 107 行）：「同项目同创建者 49→50→第 51、共享消息多发送者、另一项目/创建者、并发创建、用户删除后重建/重开」；满额拦新建的代码在 main（`server/account/conversation-authority.mjs` 第 `owned.length >= 50` 一处），删除在分支 `claude/v18-chats`（没合入）。

行状态：**部分有**。main 上能验的都补了测试并跑过；删除相关等 `claude/v18-chats` 合入。

- **RS18-chat.1 同项目同一个人：第 49、50 个放行，第 51 个被拦，不自动删历史**
  - 证据：补了 `accept-018-conv-controls.test.mjs`「RS18-chat 同项目同一个人 49→50→第 51：只拦新建，已有对话照常；……」：甲建到 49 个、第 50 个放行、第 51 个 409 `conversation-limit` 且没建出来，账本里仍是 50 个（没淘汰最早的）；已有对话里继续发消息不算新建。另 `agent-access-conversation.test.mjs`「read-only, revoked and consent-absent send fail before queue, 50 blocks rather than evicts」。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs server/test/agent-access-conversation.test.mjs`
  - 看哪一行：`✔ RS18-chat 同项目同一个人 49→50→第 51……`
  - 实跑：2026-10-13，6/6、5/5 过。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **RS18-chat.2 共享消息多发送者**
  - 证据：同一条：乙在甲开的共有对话里发言，逐条记作者；乙的发言**不占乙自己的名额**也不占甲的（乙自己仍可新建）。
  - 命令、实跑：同上。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：无
- **RS18-chat.3 另一个项目 / 另一个创建者不受影响**
  - 证据：同一条：同一个项目里乙、创建者各自有自己的名额；甲在**另一个项目**里照常新建第 1 个；乙往甲的第 2 个对话里发言是进别人的共有对话，不是新建，所属人仍是甲。
  - 命令、实跑：同上。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：「另一个创建者」我理解为「同项目的另一个开对话的人」与「另一个项目的创建者」两种，都验了。
- **RS18-chat.4 并发创建不超过 50**
  - 证据：补了「RS18-chat 并发新建不超过 50：同一个人一次并发发出 60 个新对话，恰好 50 个成功、10 个被拦；重复请求幂等」：60 个同时发，恰好 50 个成功、10 个 409 `conversation-limit`；账本里恰好 50 个；同一个请求编号并发发两次只落一条消息。
  - 命令：`【前缀】npm test -- server/test/accept-018-conv-controls.test.mjs`
  - 看哪一行：`✔ RS18-chat 并发新建不超过 50：……`
  - 实跑：2026-10-13，过。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
  - 说明：并发在同一个进程里（账本是单写者，事务串行），不是多进程。
- **RS18-chat.5 用户删除后重建 / 重开**
  - 证据：无（main 上没有删除入口：`server/agent-service/http.mjs` 的 `DELETE /v1/conversations/<id>` 固定回 503 `deletion-pending`）。分支 `claude/v18-chats` 的报告 `.worktrees/v18-chats/docs/reports/AGENT-v18-chats.md` 称已做（删除入口、先停再删、删完立刻让出名额、`evictOld` 去掉），本组只读了报告，没有在那条分支上跑。
  - 命令：无
  - 实跑：未跑
  - 约耗时：无
  - 在哪验：要等某一块合入（`claude/v18-chats`）
  - 说明：合入后需补：删到 49 个后能再建、删除后同名 ID 重建/重开、满额时先删再建。

---

#### 对任务书或语义的更正建议

- 简报「受控模型（rehearsal-model）」应改为「脚本式模拟提供方（mock，提示词里的 ```mock-script```）」；`rehearsal-model.mjs` 读的是桌面版真实模型配置。
- 底稿 2.3-6 写「受控模型下的文档工具短任务已验」，实际只验了 `set_project_meta`（`account-real-runner`），三种修改本组才补。
- 底稿 2.1-3 说「停任务的权限没有单列证据」，现在补上了；但「创建者能停别人私有对话里的任务」是否符合用户本意，请确认（见 2.1-3.14）。
- 清单 `four-stage-manifest.mjs` 里 S4-4（`cloud-agent-ui-probe`）在 main 上不再能过，建议在账号模式下改写，或明确标「已过时」。


## 8. 明细：文件重开、坏文件、缺素材、备份（组 files）

#### 本段说明（files 组）

负责六行：2.1-6 本地项目回归、2.1-7 正常云端文件重开、2.1-9 非过期与坏文件、2.1-8 过期云端项目转本地、2.1-19 清理后旧文件验收、2.1-12 缺失视觉/音频素材、2.1-14 备份恢复（编号沿用 `AGENT-018-prep.md` 第 2.1 节验收表的行号）。2026-10-13 在工作区 `.worktrees/v18-accept`（main 的内容）上跑的，机器上同时有别的子 Agent 在跑。

通用写法：下面所有命令里的两个环境变量（VisuHive 仓库路径）没设时，账号相关的测试会整个跳过；写法如下，后文只写 `npm test -- <文件>`。

- PowerShell：`$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive'; $env:PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'; npm test -- <文件>`
- Bash：`export PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive' PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs'; npm test -- <文件>`
- 「看哪一行」里说的「零失败」指输出末尾的 `✓ npm test 最终结果：零失败`；`ℹ pass N / fail 0` 是该文件的通过数。
- 带 `todo` 的测试：node 的测试运行器里「已知现在不成立」的标记。它失败时不让 `npm test` 变红（已实测：6 条 todo 失败，退出码 0，末行仍是「零失败」），输出里用 `⚠` 标出并附原因。它们对应下面「产品问题」。

#### 产品问题（没有就写「无」）

下面 1～6 都是**测出来现在不成立**的，不是我改松的；四条 DMG 与两条 STATE 测试保留在仓库里，用 `todo` 标着。1～4 是 main 上的实现问题，5 在分支 `claude/v18-missing`（块四）上已经改了，6 是功能缺口（main 和那条分支都没有）。

「块四」指 `AGENT-018-prep.md` 第 5 节拆活表里的第四块（旧云端文件转本地、「确认缺失」的来源）。主会话派活时说「块四尚未派出」，**实际它已经在做**：分支 `claude/v18-missing`（工作区 `.worktrees/v18-missing`）里有 `9de16f81`（旧云端项目凭证明转成本地项目）、`65a991d7`（文档服务墓碑与公开查询、客户端核对）、`5159cd71`、`93181b3c`（缺素材），分支报告 `docs/reports/AGENT-v18-missing.md` 目前还是空壳（只有章节标题）。下文凡写「要等块四合入」都指这条分支合入 main。

1. **坏关联的文件打不开时，当前项目的剧本和对话已经被换掉了**
   - 复现：`npm test -- server/test/accept-018-files-proc-damage.test.mjs`，看 `⚠ ACC018-DMG-5`。也可手工：先 `applyProjectAi({script:'CURRENT-SCRIPT',...})`，再 `loadProc` 一份 `collaboration.roomId` 不合法的 .proc。
   - 期望：任务书「错误保留原文件，不以空项目覆盖」；打开失败应该什么都不动。
   - 实际：`src/editor/io/proc.ts` 的 `loadProc` 先 `applyProjectAi(doc.ai)`（第 162 行），后 `noteLoadedAssociation`（第 163 行，房间号不合法时抛 `协作房间关联无效`）。抛错时打开失败，但当前打开着的项目的剧本、对话已被文件里的覆盖（测试里 `CURRENT-SCRIPT` 变成 `FILE-SCRIPT`）。顺带：这样的文件整个读不出来，连能读的内容也打不开。分支 `claude/v18-missing` 没改这一处。
2. **未知版本的 .proc 被当 v1 静默读入，再存回去会降成 v1 并丢掉不认识的字段**
   - 复现：`npm test -- server/test/accept-018-files-proc-damage.test.mjs`，看 `⚠ ACC018-DMG-6`（输出 `silently-downgraded(version=1, futureTopLevel=undefined)`）。
   - 期望：`docs/plan/three-versions-018-design.md`「真实旧文件、本地转换与缺失素材」一节：未知可读版本不能静默升级丢字段，保留可读原文并显示 unsupported。
   - 实际：main 的 `parseProc` 不看 `version`。分支 `claude/v18-missing` 在 `parseProc` 里对版本不在 1～PROC_VERSION 的文件直接抛错（`UNSUPPORTED_PROC_TEXT`，原文件不动），按代码读这条应当转绿，合入后实跑确认。
3. **.procp 包里某个条目的字节被改坏，读包时不报错**
   - 复现：同文件 `⚠ ACC018-DMG-7`（把 store 条目里 `AAAA-original` 的第一个字节改成 B，`loadProcpFile` 照样读成 `BAAA-original`）。
   - 期望：设计同节写的损坏矩阵含「zip 截断/CRC」，`hash 不符/ZIP 损坏单独报错`。
   - 实际：`src/editor/io/procp.ts` 的 `readZip`/`inflate` 从不校验 CRC（写包时算了 CRC，读包不用）。素材条目改坏则落到「自己真正的哈希」下（服务端边落盘边算哈希），编排里原哈希的素材就变成「缺失」，没有「包损坏」提示。截断、空包、没有目录都已正确报错（DMG-8）。
4. **草稿保存不是原子的：落盘中途进程没了，上一份完整的草稿被截成半份**
   - 复现：同文件 `⚠ ACC018-DMG-11`（把 `fs.writeFileSync` 换成只写一半就抛错，再 PUT 草稿；读回是不完整的 JSON）。
   - 期望：设计同节「落盘中断」；同一文件里 `/api/project-backups` 就是先写 `.tmp` 再 `rename` 的。
   - 实际：`server/vite-plugin-projects.ts` 第 207 行 `fs.writeFileSync(file, body)` 直接覆盖草稿，没有临时文件加改名。用户自己「另存为」选的文件走浏览器文件系统接口，那一条本测试没覆盖。
5. **错误节点上的「没有此房间」和本机凭证被撤销，恢复协调器都直接报「已删除」**
   - 复现：`npm test -- server/test/accept-018-files-recovery-states.test.mjs`，看 `⚠ ACC018-STATE-4`、`⚠ ACC018-STATE-5`（状态序列 `recovering,deleted`）。
   - 期望：`account-binding-task.md`「过期云端项目转本地」：超时、故障、连错节点、认证失败都不叫过期；逐项验收「非过期与坏文件」。
   - 实际：`server/recovery/coordinator.mjs` 第 21 行 `saved.revoked` → `deleted`，第 51 行 `no-project` → `deleted`；界面上显示「原房间已删除或取消协作」。main 上没有转换器，所以不会误转本地，只是提示归错了类；**块四的转换器一旦接上这两处就会误转**。分支 `claude/v18-missing` 的 `9de16f81` 已改（改成先问文档服务要证明）。我把同一个测试文件指到从分支 `git show` 出来的协调器副本上（`ACC018_COORDINATOR_FILE=<副本路径> node --test server/test/accept-018-files-recovery-states.test.mjs`），STATE-4、STATE-5 在分支版本上都通过——所以这是「合入后自动转绿」的一对。
6. **（功能缺口）账号项目保存出来的 .proc 不带云端关联，重开不会连回原云端项目**
   - 证据：语义 `docs/semantics/workflow/project.md` 第 23 行「保存 .proc、.procp 和草稿保留非秘密的房间关联」、第 24 行「云端项目仍存在时恢复云端身份」。代码：`src/editor/sync/syncManager.ts` 的 `enterAccountProject` 进入成功后调 `setAssociation(null)`（第 1163 行；分支上同一处在第 1166 行），`serializeProc` 写的 `collaboration` 就是空；`server/recovery/descriptor.mjs` 的关联只认 `where: lan/hosted` 的口令式房间。所以账号模式下用户保存再双击打开的文件，重开后只是一份没有云端关联的本地内容，无从「连原项目、采用云端当前版本」。账号项目现在只能从网站项目列表点开。分支 `claude/v18-missing` 保留了 `setAssociation(null)`，也没补这件事。
   - 影响：2.1-7 的「文件」那半、2.1-8 转换器的触发条件（转换器只认带 `where:'hosted'` 关联的文件）、2.1-19 的真实旧文件复验，都要先回答「账号项目的文件长什么样」。**这一条要用户定**：账号项目的文件要不要带云端关联、关联怎么写（属于一级/二级语义，我没动）。

另有两条不是产品问题的更正，给主会话：
- 任务书/底稿说「main 上搜不到 `goneProof`」只对了一半：**文档服务一侧的签发已在 main 上**（`server/account/authority.mjs` 第 340～351 行 `status` 返回带 Ed25519 签名的 `state:'gone'`；公开路由 `GET /hosted/shared/account/status` 在 `server/docservice/modules/account-projects.mjs` 第 105 行；`account-projects-provider.test.mjs` 有用例，已实跑 17/17）。缺的是客户端一侧：main 上 src 里没有任何地方调用这个路由（`grep` 为 0），也没有核对签名、转换的代码。
- `server/test/m8-no-lan.test.mjs` 测的是 M8 跨机探针里「netstat 输出解析与按对端地址计数」的小工具，**不是局域网功能的回归证据**，没有把它算进 2.1-6。

#### 新增文件

- `server/test/accept-018-files-local-regression.test.mjs`：2.1-6。同一进程里同时开着「账号模式的云端文档服务（账号账本 + `accountRuntime`）」和「本机局域网主机」，在局域网主机上走自由进入、限定进入、邀请码、主机/成员（创建者操作、踢人、解禁）全程不带账号令牌，并核对云端拒收口令式项目与口令式握手、本机不认账号票据。跑：`npm test -- server/test/accept-018-files-local-regression.test.mjs`；结果：5 通过 / 0 失败（约 7 秒）。
- `server/test/accept-018-files-account-fixture.test.mjs`：2.1-7 与 2.1-14。用现成的双账号真实组合（`fixtures/account-dual-user-path.mjs` 的 `startAccountDualUserFixture`：VisuHive 真账号后端 + 文档服务 + 独立素材进程 + 带证书的边缘；端口 28590～28596）。两个场景放同一文件依次跑（组合占 7 个端口，拆成两个文件会在全量测试里撞端口）：`ACC018-REOPEN-1/2` 旧文件内容重开不覆盖云端；`ACC018-BACKUP-1` 备份恢复演练。没设两个环境变量时整文件跳过。跑：`npm test -- server/test/accept-018-files-account-fixture.test.mjs`；结果：2 通过 / 0 失败（约 7 秒；单独 REOPEN 一条约 17 秒是因为含组合启动）。
- `server/test/accept-018-files-proc-damage.test.mjs`：2.1-9 的损坏细节。11 条：7 通过 + 4 条 todo（DMG-5/6/7/11，见产品问题 1～4）。跑：`npm test -- server/test/accept-018-files-proc-damage.test.mjs`。
- `server/test/accept-018-files-recovery-states.test.mjs`：2.1-9 的输入矩阵（超时/错误节点/未登录/密码错/旧凭证/被踢）喂给真的恢复协调器，并核对账号项目进入失败的三类提示。6 条：4 通过 + 2 条 todo（STATE-4/5，见产品问题 5）。可用 `ACC018_COORDINATOR_FILE` 指到别处的 `coordinator.mjs` 做合入前演练。
- `server/test/accept-018-files-old-proc-fixtures.mjs`（夹具，不是测试）与 `server/test/accept-018-files-old-proc-fixtures.test.mjs`（自检）：2.1-8/2.1-19 用的「合成旧文件矩阵」。造 7 份旧文件样本（云端房间关联的 .procp 素材全在/部分缺/全缺，云端与局域网关联的 .proc，无关联的 .proc，更旧的裸 JSON），哈希固定可重复；自检 2 通过 / 0 失败，证明 main 上现有读取代码读得懂它们。**它们不能代替 2.1-19 要的真实旧文件**。
- `server/test/accept-018-files-missing-voice.test.mjs`：2.1-12 里 main 上能验的一小块：占位人声文件本身与契约一致（131,564 字节、SHA-256、PCM16/48kHz/单声道、1.37 秒）。2 通过 / 0 失败（其中第二条只是文本扫描，说服力弱，已在行里注明）。
- 六个新文件合起来跑一次：`npm test -- <六个 .test.mjs>`，28 条：22 通过、6 条 todo、0 失败，零失败，约 6 秒；跑前跑后各查一次可见窗口，均无。
- 清理：我起的组合留在临时目录里的数据，测试结束会自己删（`after` 钩子，只删以 `pc-dual-account-path-` 开头且我自己创建的那份）；开发时手工留下的两份我已逐个确认后删掉。别的子 Agent 留下的同名临时目录我没动。

#### 行 2.1-6：本地项目回归

原文预期：「不要求账号，旧权限/连接不退步」；环境与输入：「本地自由/限定进入、邀请码、主机/成员、局域网及隔离中继」（`docs/plan/account-binding-task.md`「逐项验收」表，约第 171 行；失败处理「失败挡本地关卡」）。
行状态：**已有可跑的证据**（本机替身层面全部有且跑过；跨机真实组播见 6.6 的说明）

「账号模式开着」在这里的含义：本地项目跑在本机局域网主机（`server/vite-plugin-docservice.ts`，`createSharedDocService({ mode: 'lan' })`，不带账号运行时）上；账号运行时只挂在托管组合（`mode: 'hosted'`）上。`shared-service.mjs` 第 204 行起账号模式下 `/shared/*` 回 403 `account-required`。我补的测试把两者放在同一进程里同时开着，证明互不影响。

- **2.1-6.1 本地项目不要求账号（账号模式开着时照旧）**
  - 证据：补了 `server/test/accept-018-files-local-regression.test.mjs` 的「ACC018-LOCAL-1」～「ACC018-LOCAL-5」。LOCAL-1～4 在局域网主机上做进入、邀请码、成员操作，全程不带令牌，且断言连接身份不是账号身份（`principal.realm !== 'account'`）；LOCAL-5 断言云端账号模式拒收口令式项目与握手（403 `account-required`、握手非 101），本地主机不认账号连接票据、不认云端账号项目号（404）。
  - 命令：`npm test -- server/test/accept-018-files-local-regression.test.mjs`
  - 看哪一行：`✔ ACC018-LOCAL-1`…`✔ ACC018-LOCAL-5`，`ℹ pass 5 / fail 0`
  - 实跑：2026-10-13，5 通过 / 0 失败（第一次 LOCAL-3 因我把返回字段名猜错失败，改为 `project.key` 后全过，不是产品问题）
  - 约耗时：6 秒
  - 在哪验：本机现在就能验
- **2.1-6.2 本地自由进入不退步**
  - 证据：`server/test/auth-handshake.test.mjs` 的 AU2 系列（自由进入：证明对→101、创建者口令才是创建者、nonce 复用/过期/绑定不符 401、限速 AU8）和 `server/test/auth-create.test.mjs` 的 AU1（两种模式都建得成、同名 409、局域网主机只许回环建项目 403）；加上 LOCAL-1。已读测试代码确认断言的就是握手与建项目本身。
  - 命令：`npm test -- server/test/auth-handshake.test.mjs`；`npm test -- server/test/auth-create.test.mjs`
  - 看哪一行：`ℹ pass 20 / fail 0`；`ℹ pass 7 / fail 0`
  - 实跑：2026-10-13，20/20 与 7/7，零失败
  - 约耗时：6 秒；2 秒
  - 在哪验：本机现在就能验
- **2.1-6.3 本地限定进入不退步**
  - 证据：`auth-handshake.test.mjs` 的 AU3（名单内口令对才进、创建者自动在名单里、名单外挑战形状相同的伪盐、随后握手 401）；`server/test/auth-members.test.mjs` 的「AU6 set-list 移出某人：…4003 removed 关闭，再握手 401」；LOCAL-2。
  - 命令：同上两个文件（`auth-members` 见 6.5）
  - 看哪一行：`✔ AU3 限定进入…`、`✔ AU6 set-list 移出某人…`、`✔ ACC018-LOCAL-2`
  - 实跑：2026-10-13，全过
  - 约耗时：计入上面几个文件
  - 在哪验：本机现在就能验
- **2.1-6.4 邀请码不退步**
  - 证据：`server/test/c10a-invite.test.mjs`（契约测试 `C10A-IV-01`～`19`，覆盖签发/解析/兑换、限时限量、作废、同设备不重复扣、一个口径 `invite-invalid`、自由进入回 K 与限定进入不回 K、禁入、限速、原文不落盘不进日志、`IV-18` 局域网主机（挂载模式）同一组端点）与 `server/test/invite-impl.test.mjs`（实现自测 `INV-1`～`INV-15`）；LOCAL-3 在局域网主机上又走一遍并凭兑换所得的 K 握手进入。
  - 命令：`npm test -- server/test/c10a-invite.test.mjs`；`npm test -- server/test/invite-impl.test.mjs`
  - 看哪一行：`ℹ pass 20 / fail 0`（skipped 0，没有因接口缺失整组跳过）；`ℹ pass 15 / fail 0`
  - 实跑：2026-10-13，20/20 与 15/15
  - 约耗时：7 秒；5 秒
  - 在哪验：本机现在就能验
- **2.1-6.5 主机/成员（成员列表、创建者操作、踢人/解禁、角色）不退步**
  - 证据：`server/test/auth-members.test.mjs`：AU4（同名两设备显示带设备名）、AU5（创建者操作 set-password/set-list/kick/unban/delete 要证明，不带证明/证明错/非创建者 forbidden 且不生效；创建者与成员对数据面消息结果一致）、AU6（移出名单/踢人立即断开、票据立即 401、同名换设备不受影响、解禁后能进）、AU10（page/agent/render/local 角色）；LOCAL-4。
  - 命令：`npm test -- server/test/auth-members.test.mjs`
  - 看哪一行：`ℹ pass 13 / fail 0`；`✔ ACC018-LOCAL-4`
  - 实跑：2026-10-13，13/13
  - 约耗时：6 秒
  - 在哪验：本机现在就能验
- **2.1-6.6 局域网（发现、素材服务地址发现、局域网来源进入）不退步**
  - 证据：`server/test/sp-lan.test.mjs`（`SPC4-1`～`9`：发现参数、查询/应答包格式与大小、选网卡、45 秒过期与续期、主机收到查询单播回应答、`discoverLan` 5 秒内找到主机、**「发现与进入局域网主机期间托管端的连接数不变」**；用回环网卡注入与 dgram 套接字模拟，端口由系统分配）；`server/test/asset-lan-discover.test.mjs`（`lanCandidates` 挑候选、真 `createLanHost` 通告 + 真 `discoverLan` 找到素材服务地址并试通）；LOCAL-1/2 用 `192.168.1.x` 的局域网来源进入，并核对局域网来源建项目 403。读过代码：这两份是本机替身（回环 + 单播代替组播），不是真实多机组播。
  - 命令：`npm test -- server/test/sp-lan.test.mjs`；`npm test -- server/test/asset-lan-discover.test.mjs`
  - 看哪一行：`ℹ pass 9 / fail 0`；`ℹ pass 5 / fail 0`
  - 实跑：2026-10-13，9/9 与 5/5
  - 约耗时：9 秒；7 秒
  - 在哪验：本机现在就能验（本机替身）。真实两台机器的组播/子网广播：`scripts/probes/shared-project-lan.mjs` 与 `asset-lan-probe.mjs`，运行器清单（`scripts/acceptance/four-stage-manifest.mjs` 第 65～66 行）明写「要第二台机器」，我没跑。它不属于你给的五个「在哪验」值；按 `verification.md`「跨机不再单独成项…网络部分归真实网络验证」，我把它记为「待跨机复核」，由主会话决定归哪一类。
- **2.1-6.7 隔离中继不退步**
  - 证据：`server/test/reopen-hosting.test.mjs` 的「真实中继 free」「真实中继 restricted」两条（真托管目录服务 `createHostingService` + 真托管组合 + 真 TCP 代理）：登记认证、独占租约（另一实例/创建者第二设备不能抢主机）、成员经中继发现并握手、TCP 被掐后用新路由能力接续同一会话（`opens` 仍为 1）、双向编辑、带票据的素材读写（无票据 401、读票据不能写、query 参数不授予写权限）、page/agent/render 三种委托票据、邀请码过期不能再进、踢人 403 banned 与解禁、改口令使旧路由/旧票据失效、创建者改口令、删除后墓碑 410；另有 `中继速率预算…` 一条。已读测试代码，断言就是上述内容。
  - 命令：`npm test -- server/test/reopen-hosting.test.mjs`
  - 看哪一行：`✔ 真实中继 free…`、`✔ 真实中继 restricted…`、`✔ 中继速率预算…`，`ℹ pass 3 / fail 0`
  - 实跑：2026-10-13，3/3
  - 约耗时：12 秒
  - 在哪验：本机现在就能验
- **2.1-6.8 页面一侧的同步/重连逻辑不退步（连接不退步的另一半）**
  - 证据：`src/editor/sync/` 下 `presence.test.mjs`、`reconnect.test.mjs`、`enterFailure.test.mjs`、`onlineSync.test.mjs`、`hostedServices.test.mjs`（同一条命令一起跑；这几份把口令式与账号式两种连接都测了）。
  - 命令：`npm test -- src/editor/sync/presence.test.mjs src/editor/sync/reconnect.test.mjs src/editor/sync/enterFailure.test.mjs src/editor/sync/onlineSync.test.mjs src/editor/sync/hostedServices.test.mjs`
  - 看哪一行：`ℹ pass 48 / fail 0`
  - 实跑：2026-10-13，48/48
  - 约耗时：11 秒
  - 在哪验：本机现在就能验

#### 行 2.1-7：正常云端文件重开

原文预期：「连原项目及最新状态，不能用旧文件覆盖」（`account-binding-task.md` 约第 172 行；输入「原项目存在且账号有权」；契约 `account-binding-contract.md`「过期云端项目转本地与暂时离线」表第一行：「项目存在且有权限：连接原项目，采用云端当前版本；文件不是覆盖云端的依据」）。
行状态：**部分有**（「连上原项目、用云端最新、不被旧文件覆盖」这一半有真实组合的证据；「文件怎么认出这是哪个云端项目」这一半没有，是功能缺口，见产品问题 6）

- **2.1-7.1 原项目存在且账号有权时，从文件重开能连回原项目**
  - 证据：无。口令式（旧托管）房间有：`server/test/reopen-recovery.test.mjs`（25 条，含「凭证分别保存服务、房间及身份，重启后绑定连续，第二设备不得抢主机」「恢复中换项目使旧异步发现失效」「限速…严格等 Retry-After 后自动重入」等）与 `reopen-relocation*.test.mjs`；但**账号项目**保存的文件不带云端关联（`syncManager.ts` 第 1163 行 `setAssociation(null)`），没有「从文件重开→连回账号项目」的代码。
  - 命令：`npm test -- server/test/reopen-recovery.test.mjs`（口令式房间）
  - 看哪一行：`ℹ pass 25 / fail 0`
  - 实跑：2026-10-13，25/25（reopen-relocation 8/8、reopen-relocation-directory 6/6 另跑过，零失败）
  - 约耗时：27 秒（recovery）；3 秒；2 秒
  - 在哪验：要等某一块合入——不是块四：分支 `claude/v18-missing` 没有这件事，需要一块新的「账号项目文件关联」工作（见产品问题 6，待用户定）
  - 说明：口令式房间的重开在 0.7.18 的账号必需节点上不可用（`/shared/*` 回 `account-required`，见 LOCAL-5），所以这些旧用例只证明口令式路径本身没坏，不能顶替账号项目的重开。
- **2.1-7.2 页面里是云端最新状态，不是旧文件内容**
  - 证据：补了 `server/test/accept-018-files-account-fixture.test.mjs` 的「ACC018-REOPEN-1/2」：真实账号组合里，同账号另一台设备把云端项目改了两次；重开的页面用页面一侧真的 `SyncLink`/`DocSync`（`enterAccountProject` 用的那套，`initialize:false`）、手里是改名前的旧文件内容，连上后 `link.ds.project.name` 是云端最新名，不是旧文件里的名字。读过代码确认这就是产品进入账号项目的组装方式。
  - 命令：`npm test -- server/test/accept-018-files-account-fixture.test.mjs`
  - 看哪一行：`✔ ACC018-REOPEN-1/2 …`
  - 实跑：2026-10-13，通过（整文件 2 通过 / 0 失败）
  - 约耗时：约 7 秒（并行全量里）；单独只跑这一条约 17 秒
  - 在哪验：本机现在就能验
- **2.1-7.3 云端内容和版本在重开前后一点没变（旧文件没有被当成根替换提交）**
  - 证据：同一条测试。重开并 `whenSettled` 之后，另一台设备再 `project.open`：名字仍是最新、`rev` 与重开前一样（`baseRev + 2`），随后再编辑一次得到 `rev + 1`，版本号连续。
  - 命令、看哪一行、实跑、耗时：同 2.1-7.2
  - 在哪验：本机现在就能验
- **2.1-7.4 没权限/未登录的账号连不上**
  - 证据：同一条测试末尾：坏令牌拿会话 401；对不存在的项目号拿会话回 403/404。「项目外的真实账号」被拒是别组的行（项目权限与两张列表），这里不重复。
  - 命令、看哪一行、实跑、耗时：同 2.1-7.2
  - 在哪验：本机现在就能验

#### 行 2.1-9：非过期与坏文件

原文预期：「暂时离线/认证/权限分别提示，不转本地；错误保留原文件，不以空项目覆盖」（`account-binding-task.md` 约第 174 行；输入「超时、错误节点、未登录、密码错、旧凭证、被踢；各类损坏细节」；第 158 行：损坏细节至少含「截断、旧格式、未知版本、坏关联、部分可读、缺卡/缺素材、落盘中断及本机存储不可用」；失败处理「失败挡旧文件关卡」）。
行状态：**部分有**（分类与多数损坏细节有证据；有 4 个损坏细节与 2 个输入的归类现在不成立，见产品问题 1～5；「不转本地」的真正检验要等转换器）

- **2.1-9.1 超时/服务故障 → 提示暂时离线并自动重试，不转本地**
  - 证据：补了 `server/test/accept-018-files-recovery-states.test.mjs` 的「ACC018-STATE-1」：把 discover 超时、`unreachable`、`unavailable` 喂给真的恢复协调器，状态是 `recovering → waiting-host`（界面文字「正在等待主机上线，将自动重试。」，`SyncChips.tsx` 第 79 行），不出现 `deleted`/`needs-auth`/`rejected`。已有旁证：`reopen-recovery.test.mjs`「暂时保护存储超时沿统一恢复退避，保留身份；真正损坏停止重试」。账号项目一侧见 2.1-9.7。
  - 命令：`npm test -- server/test/accept-018-files-recovery-states.test.mjs`
  - 看哪一行：`✔ ACC018-STATE-1`
  - 实跑：2026-10-13，通过（整文件 4 通过 + 2 todo + 0 失败）
  - 约耗时：约 1 秒
  - 在哪验：本机现在就能验
- **2.1-9.2 错误节点（连到别的服务说没有这个项目）→ 不当作过期、不转本地**
  - 证据：`ACC018-STATE-4`（todo，main 上不成立：状态是 `recovering,deleted`，界面「原房间已删除或取消协作」）。「不转本地」在 main 上靠「没有转换器」成立（`grep -rE "goneProof|convertedFrom|publishGoneConversion|gone-proof.mjs" src server desktop scripts` 在 main 上 0 处，不含我加的测试）。分支版协调器上这条通过（用副本演练过）。
  - 命令：`npm test -- server/test/accept-018-files-recovery-states.test.mjs`（main：`⚠ ACC018-STATE-4`）；演练：在 Bash 里 `git show claude/v18-missing:server/recovery/coordinator.mjs > <临时路径>/coordinator.mjs`，再 `ACC018_COORDINATOR_FILE=<该路径> node --test server/test/accept-018-files-recovery-states.test.mjs`
  - 看哪一行：main：`⚠ ACC018-STATE-4 … # 产品问题`；分支副本：`✔ ACC018-STATE-4`
  - 实跑：2026-10-13，main 上 todo 失败（如实：不成立）；分支协调器副本上通过
  - 约耗时：1 秒
  - 在哪验：要等某一块合入（块四＝分支 `claude/v18-missing`）
- **2.1-9.3 未登录 → 提示要认证，不重试，不转本地**
  - 证据：`ACC018-STATE-2`：`auth`/`unauthorized`、本机没有任何身份记录，都是 `recovering → needs-auth` 且 `enter` 只调用一次（不重试）。旁证 `reopen-recovery.test.mjs`「终止认证错误不会重试；未知版本不访问身份后端」。
  - 命令：同 2.1-9.1
  - 看哪一行：`✔ ACC018-STATE-2`
  - 实跑：2026-10-13，通过
  - 约耗时：约 1 秒
  - 在哪验：本机现在就能验
- **2.1-9.4 密码错 → 提示认证（不是「房间不存在」），不转本地**
  - 证据：协调器一侧同 9.3（密码错在握手里就是 401，归到 `auth`）；握手一侧 `auth-handshake.test.mjs`「AU2 自由进入：证明错 → 401」。账号项目一侧 `bad-login`→「账号或密码不正确。」。
  - 命令：`npm test -- server/test/auth-handshake.test.mjs`（20/20）
  - 看哪一行：`✔ AU2 自由进入：证明错 → 401`
  - 实跑：2026-10-13，通过
  - 约耗时：6 秒
  - 在哪验：本机现在就能验
- **2.1-9.5 旧凭证（本机恢复凭证被撤销）→ 提示认证，不转本地**
  - 证据：`ACC018-STATE-5`（todo，main 上不成立：`saved.revoked` 直接 `deleted`）。分支协调器副本上通过。
  - 命令、看哪一行、实跑：同 2.1-9.2
  - 约耗时：1 秒
  - 在哪验：要等某一块合入（块四）
- **2.1-9.6 被踢 → 提示没权限（拒绝），不重试，不转本地**
  - 证据：`ACC018-STATE-3`：`kicked`/`banned`/`removed` 都是 `recovering → rejected`，`enter` 只调一次（界面「原身份已被拒绝，请联系创建者。」）。服务端侧 `auth-members.test.mjs` AU6、`account-projects-provider.test.mjs`「kick persists account ban and closes permissions for both device logins」。
  - 命令：`npm test -- server/test/accept-018-files-recovery-states.test.mjs`；`npm test -- server/test/account-projects-provider.test.mjs`（17/17，2026-10-13 已跑）
  - 看哪一行：`✔ ACC018-STATE-3`
  - 实跑：2026-10-13，通过
  - 约耗时：约 1 秒；2 秒
  - 在哪验：本机现在就能验
- **2.1-9.7 三类提示是分开的（暂时离线 / 认证 / 权限）**
  - 证据：协调器的三个状态互不相同（STATE-1/2/3）；界面文字在 `SyncChips.tsx` 第 78～86 行是三句不同的话（我读了，未单独写测试，文字是一级语义，不改）。账号项目进入失败的提示补了 `ACC018-STATE-6`：`accountErrorText` 的离线类（503/0）、认证类（401）、权限类（403）三组互不共用一句，且除了明确的 `project-gone` 之外没有一句说「已不存在」。
  - 命令：同 2.1-9.1
  - 看哪一行：`✔ ACC018-STATE-6`
  - 实跑：2026-10-13，通过
  - 约耗时：约 1 秒
  - 在哪验：本机现在就能验
  - 说明：部分——口令式房间的界面文字没有测试直接断言，只有状态归类的测试。
- **2.1-9.8 「不转本地」（上述任何一种失败都不触发转换）**
  - 证据：main 上没有转换入口（见 9.2 的 grep）。块四合入后这是真正要验的东西：分支的 `server/test/cloud-gone-recovery.test.mjs`（状态机单测，按分支文件头说明覆盖「没过期且连得上原项目」「没有权限」两格）与 `scripts/probes/v18-missing-probe.mjs`（「过期但证明对不上」「服务说没有墓碑」「暂时离线」等格）。
  - 在哪验：要等某一块合入（块四＝分支 `claude/v18-missing`）；合入后的命令见 2.1-12 后面的清单
- **2.1-9.9 出错时保留原文件**
  - 证据：补了 `accept-018-files-proc-damage.test.mjs` 的「ACC018-DMG-10」：按路径打开（双击文件走的 `/api/skill/open-path`）先复制副本再读，原文件字节前后一致；截断的、不是项目的 `.json` 被拒（400）且不产生副本、不把内容回出去。「ACC018-DMG-9」：草稿文件只读时保存报错，原草稿内容一字不动；坏 JSON 不会被写成草稿。
  - 命令：`npm test -- server/test/accept-018-files-proc-damage.test.mjs`
  - 看哪一行：`✔ ACC018-DMG-9`、`✔ ACC018-DMG-10`
  - 实跑：2026-10-13，通过（整文件 11 条：7 通过 + 4 todo）
  - 约耗时：约 3 秒
  - 在哪验：本机现在就能验
  - 说明：用户「另存为」选的文件走浏览器文件系统接口，这里没测。
- **2.1-9.10 出错时不以空项目覆盖（当前项目、剧本、对话不被动）**
  - 证据：「ACC018-DMG-1」截断到 0/1/20/一半/差 2 字符、空串、`null`、`[]`、无 tracks 等 9 种输入，`loadProc` 一律抛错，且当前项目对象、剧本和对话原样；「ACC018-DMG-8」截断的 .procp、空包、空 zip 都报错，且一次素材落库请求都没发。**例外**：坏关联的文件（DMG-5，todo）会先把剧本和对话换掉，见产品问题 1。
  - 命令、看哪一行、实跑：同 2.1-9.9
  - 在哪验：本机现在就能验
  - 说明：部分——DMG-5 不成立。
- **2.1-9.11 损坏细节逐类（任务书第 158 行的八类）**
  - 截断：DMG-1、DMG-8 通过。（用户看到的报错是浏览器原样的英文 `Unexpected end of JSON input`，`src/StartPage.tsx` 第 163 行直接显示 `e.message`；这是界面文字，属一级语义，我只记不改。）
  - 旧格式：DMG-2 通过（裸 Project JSON 能读，旧 id 带上）；另有 `accept-018-files-old-proc-fixtures.test.mjs` 的 OLD-1 用 7 种样本验现有读取代码。
  - 未知版本：协作关联的未知版本 DMG-4 通过（项目内容读出、关联原样保留、协调器报 `unsupported` 且不访问身份后端）；**.proc 文件本身的未知版本 DMG-6 不成立**（产品问题 2，分支已改）。
  - 坏关联：读取会抛 `协作房间关联无效`，但先动了剧本和对话（DMG-5 不成立，产品问题 1）。
  - 部分可读 / 缺卡 / 缺素材：DMG-3 通过（缺素材的项目照样打开，两条素材引用的哈希、名字、地址一条不丢；一个不存在的卡定义没拖垮其余内容）。说明：缺卡我只验了「卡定义没了」，没验「片段引用了不存在的卡」，这一格未覆盖。
  - 落盘中断：DMG-11 不成立（产品问题 4）；恢复身份库一侧 `reopen-recovery.test.mjs`「保存加密记录临时文件后进程真实退出，原记录可读并可回收退出锁后重试」「临时记录已部分写入后出现 ENOSPC，原加密记录保留」通过。
  - 本机存储不可用：DMG-9 通过；`reopen-recovery.test.mjs`「暂时保护存储超时沿统一恢复退避，保留身份」「本机恢复 API 区分暂时读取占用和数据损坏」通过。
  - 另（设计损坏矩阵里的 CRC）：DMG-7 不成立（产品问题 3）。
  - 命令：`npm test -- server/test/accept-018-files-proc-damage.test.mjs server/test/accept-018-files-old-proc-fixtures.test.mjs server/test/reopen-recovery.test.mjs`
  - 看哪一行：`✔ ACC018-DMG-1/2/3/4/8/9/10`、`⚠ ACC018-DMG-5/6/7/11`、`✔ ACC018-OLD-1/2`、reopen-recovery `ℹ pass 25`
  - 实跑：2026-10-13，如上
  - 约耗时：约 3 秒 + 2 秒 + 27 秒
  - 在哪验：本机现在就能验

#### 行 2.1-8：过期云端项目转本地

原文预期：「文件保存内容不丢；协作默认关闭；提示一次；保存后本机状态更新，重开不再连旧云端」（`account-binding-task.md` 约第 173 行；输入「准确项目已删证明；真实旧 .proc，双击和软件内打开」；失败处理「隔离先验，清理后必须用真实旧文件复验」；语义 `workflow/project.md`「过期云端项目转本地」）。
行状态：**部分有**（只有「文档服务签发已删证明」这一小块在 main 上；转换本身要等块四，分支上已有实现但没合入）

main 上核实「没有」的 grep（2026-10-13，工作区 `.worktrees/v18-accept`）：`grep -rEn "goneProof|convertedFrom|publishGoneConversion|onGoneConversion|gone-proof\.mjs|legacyGoneStatus" src server desktop scripts`（排除我加的测试）= 0 处；客户端调用 `shared/account/status` 路由的地方 = 0 处；`server/recovery/coordinator.mjs` 第 21、51 行把本机凭证被撤与「没有此项目」直接当 `deleted`。

- **2.1-8.1 准确项目已删的证明由文档服务签发，错误服务/未知项目/无效登录拿不到「已删」**
  - 证据：`server/test/account-projects-provider.test.mjs` 的子用例「delete idempotency; gone is owner signed exact tombstone, wrong authority/unknown/invalid login never gone」（读过：删项目后 `statusForPrincipal` 返回 `state:'gone'` 且 Ed25519 签名对规范化 JSON 验得过；`wrong-authority` 抛错、未知项目号抛 `no-project`、旧令牌 `credential-revoked`）。该文件用真 VisuHive 账号后端 + 真 mTLS。
  - 命令：`npm test -- server/test/account-projects-provider.test.mjs`
  - 看哪一行：`✔ delete idempotency; gone is owner signed exact tombstone…`，`ℹ pass 17 / fail 0`
  - 实跑：2026-10-13，17/17
  - 约耗时：2 秒
  - 在哪验：本机现在就能验
- **2.1-8.2 打开旧文件时，只凭核对过的证明转成本地项目（新的本地项目号），其它失败不转**
  - 证据：无（main 上没有客户端核对与转换）。
  - 在哪验：要等某一块合入（块四＝分支 `claude/v18-missing`）。分支上看到：`server/recovery/gone-proof.mjs`（信任表与签名核对）、`src/editor/sync/cloudGone.ts`（`convertGoneProject`）、`syncManager.ts` 的 `becomeLocalAfterGone`。
- **2.1-8.3 文件保存的内容不丢（轨道、片段、参数、素材引用、卡源码、剧本）**
  - 证据：无。我造了合成旧文件夹具 `accept-018-files-old-proc-fixtures.mjs`（含 `expect` 表，写明每个样本该有的关联、素材哈希），自检 `ACC018-OLD-1/2` 证明 main 现有读取代码读得出它们；转换器合入后，拿它们当输入，对比转换结果的 `tracks`/`media` 哈希。
  - 命令：`npm test -- server/test/accept-018-files-old-proc-fixtures.test.mjs`
  - 看哪一行：`✔ ACC018-OLD-1`、`✔ ACC018-OLD-2`，`ℹ pass 2 / fail 0`
  - 实跑：2026-10-13，2/2（只证明夹具自洽，不是转换器的证据）
  - 约耗时：约 2 秒
  - 在哪验：要等某一块合入（块四）
- **2.1-8.4 协作默认关闭**
  - 证据：无。要等块四（分支 `becomeLocalAfterGone` 里 `setAssociation(null)` 并清 `shared`/`hosted`）。
  - 在哪验：要等某一块合入（块四）
- **2.1-8.5 提示一次**
  - 证据：无。要等块四（分支 `publishGoneConversion` 与 `takeGoneNotices`「每条只提示一次」，`CloudGoneDialog.tsx`）。提示文字是一级语义，分支里的原文要用户过目。
  - 在哪验：要等某一块合入（块四）
- **2.1-8.6 保存后本机状态更新为本地；原文件在成功另存前保留**
  - 证据：无。要等块四（分支 `convertedFrom` 写进 .proc、`onGoneConversion(() => forgetSaveTarget())`）。
  - 在哪验：要等某一块合入（块四）
- **2.1-8.7 重开不再连旧云端**
  - 证据：无。要等块四。
  - 在哪验：要等某一块合入（块四）
- **2.1-8.8 双击和软件内打开两条入口**
  - 证据：无。main 上这两个入口都进 `loadProc`（`StartPage.openFile`、`TopBar.openProjectFile`、`openProcPath`），入口有；转换在入口之后的协调器里。双击在真实安装包上才能验。
  - 在哪验：要安装包（双击）；软件内打开要等块四
  - 说明：前提还有产品问题 6——转换器只认带 `where:'hosted'` 关联的文件，账号项目的文件没有关联。

#### 行 2.1-19：清理后旧文件验收

原文预期：「云端文档服务明确不存在；关闭协作的本地项目可保存重开；缺素材按占位处理，分别报告内容与素材结果」（`account-binding-task.md` 约第 184 行；输入「实际旧项目删除后，真实旧文件与本机素材」；失败处理「失败停止追加删除，核对备份恢复；原文件不覆盖」；`three-versions-018-design.md` 同名一节写明「不能用合成 fixture 替代真实旧文件这关」）。
行状态：**没有**（真实旧文件这一关依赖节点上先做删除，删除要用户点头；本机只能先备好夹具与流程）

- **2.1-19.1 云端文档服务明确不存在（对删除后的真实旧项目签出「已删」证明）**
  - 证据：签发一侧的机制有（2.1-8.1）；对「节点上真实删除后的旧项目」签出证明没有。
  - 在哪验：要部署到节点后验（清理之后；删除清单要用户点头，见 `AGENT-018-prep.md` 第 7 节）
- **2.1-19.2 关闭协作的本地项目可保存重开**
  - 证据：无。夹具 `hostedAllMedia.procp` 等 7 份可先拿来在转换器合入后演练，但不能代替真实旧文件。
  - 在哪验：要等某一块合入（块四）；真实旧文件那一关要部署到节点后验
- **2.1-19.3 缺素材按占位处理**
  - 证据：无（见 2.1-12）。夹具里 `hostedPartialMedia.procp`（包里少一个素材）、`hostedNoMedia.procp`（包里一个素材都没有）就是为这一格造的。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）
- **2.1-19.4 分别报告内容结果与素材结果**
  - 证据：无。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`；分支探针有「过期且有证明（素材全在/部分缺/全缺）」格）
- **2.1-19.5 失败时停止追加删除、核对备份恢复、原文件不覆盖**
  - 证据：「原文件不覆盖」：本机有——`ACC018-DMG-10`（按路径打开不改原文件）、2.1-9.9。「失败停止追加删除、核对备份恢复」：是操作流程，不是代码；备份恢复演练见 2.1-14。
  - 在哪验：要部署到节点后验
  - 说明：部分。

#### 行 2.1-12：缺失视觉/音频素材

原文预期：「弹窗列项；文字卡“找不到素材xxx”；随软件分发的人声“找不到素材”在桌面版、在线浏览器和导出里都放得出来；位置/编排保留，找回路径可复核」（`account-binding-task.md` 约第 177 行；输入「.proc 无素材、部分素材缺失、素材恢复、暂时读取失败」；失败处理「截图、播放与导出/发布证据；不报全部素材已恢复」）。
行状态：**部分有**（main 上只有那段人声文件本身；其余功能都在分支 `claude/v18-missing` 上，我没在那个工作区里改东西或跑测试）

main 的现状：`src/audio/assets/missing-material.wav` 在，但 src、server、desktop 里没有任何地方使用它（`grep missing-material` 只有两个无关测试），画面占位、弹窗、记录都没有；`parseProc` 里缺素材只 `console.warn`。

- **2.1-12.1 随软件分发的人声文件就是契约写的那一份**
  - 证据：补了 `server/test/accept-018-files-missing-voice.test.mjs` 的「ACC018-VOICE-1」：大小 131,564 字节、SHA-256 `5E615376…CCF4E7`（与契约一致）、PCM16/48 kHz/单声道、时长 1.37 秒。「ACC018-VOICE-2」：项目/素材/打包相关源码不把它登记成项目素材（只是文本扫描，说服力弱，只能说明没有明显的反例）。
  - 命令：`npm test -- server/test/accept-018-files-missing-voice.test.mjs`
  - 看哪一行：`✔ ACC018-VOICE-1`，`ℹ pass 2 / fail 0`
  - 实跑：2026-10-13，2/2
  - 约耗时：约 2 秒
  - 在哪验：本机现在就能验
- **2.1-12.2 确认缺失后弹窗列出具体缺失项**
  - 证据：无。分支：`src/editor/MissingMaterialsDialog.tsx`、`5159cd71`「后台检查认定『确认缺失』并写记录、弹窗列项」；分支探针截图 `docs/reports/assets/v18-missing/03-partial-missing-dialog.png`、`10-all-missing-dialog.png`。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）
- **2.1-12.3 缺失的视觉内容用文字卡「找不到素材xxx」占位**
  - 证据：无。分支：`src/render/MissingMaterial.tsx`＋`MissingMaterial.test.mjs`、`src/editor/preview/missingMaterials.test.mjs`；截图 `04-preview-missing-visual.png`、`11-all-missing-image-placeholder.png`。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）
- **2.1-12.4 人声在桌面版放得出来**
  - 证据：无。分支：`src/audio/missingMaterial.ts`＋测试。真正「听得到」要在桌面版实际播放，属人耳项（按 `verification.md` 的声音验收，需桌面版与在线浏览器各验）。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）；桌面版实际放出来要安装包
- **2.1-12.5 人声在在线浏览器放得出来、画面占位也出**
  - 证据：无。分支探针 `scripts/probes/v18-missing-online-probe.mjs`（预览占位、人声、在线导出，截图 `14`～`16`）。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）；真实节点上的在线页面另要部署到节点后验
- **2.1-12.6 人声在导出里放得出来**
  - 证据：无。分支：`server/bakery/audio-mix.mjs`、`mux-audio.mjs` 及其测试、`server/test/bakery-missing-media.test.mjs`、`src/export/browserExport.missing.test.mjs`；截图 `06`、`07`、`16`。分支报告写过的「真 ffmpeg 合成 30 帧」是 codex 分支的记录，分支报告现在是空壳。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）
- **2.1-12.7 位置/编排保留，找回路径可复核（保存重开不变、找回后清掉）**
  - 证据：无。分支：`src/editor/io/missingProducer.test.mjs`、`missingMaterials.test.mjs`；截图 `08-reopen-placeholder-still-there.png`、`09-recovered-real-material.png`。main 上能验的一半是「读文件时缺素材的引用一条不丢」：`ACC018-DMG-3` 通过（两条素材的哈希、名字、地址原样保留）。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）
- **2.1-12.8 暂时读取失败与确认缺失分开；不报「全部素材已恢复」**
  - 证据：无。分支：`missingProducer` 的认定逻辑（找回先后：内容库、原路径）。
  - 在哪验：要等某一块合入（分支 `claude/v18-missing`）

**合入后主会话照着跑的清单**（分支报告 `docs/reports/AGENT-v18-missing.md` 现在还是空壳没有验证命令，所以下面是我从分支的文件头和新增文件里抄的，命令没有在那个工作区里跑过；全部设好两个环境变量后在合入后的 main 上跑）：

1. 单测（含 2.1-8、2.1-9、2.1-12 的块四部分）：`npm test -- server/test/cloud-gone-recovery.test.mjs server/test/legacy-gone-proof.test.mjs server/test/bakery-missing-media.test.mjs server/test/export-compose.test.mjs server/test/export-media-url.test.mjs src/audio/missingMaterial.test.mjs src/editor/io/mediaPath.test.mjs src/editor/io/missingMaterials.test.mjs src/editor/io/missingProducer.test.mjs src/editor/preview/missingMaterials.test.mjs src/editor/sync/cloudGone.test.mjs src/export/browserExport.missing.test.mjs src/render/MissingMaterial.test.mjs`
2. 分支还改了 `server/bakery/` 下三个测试，它们不在默认测试文件范围里（默认只扫 `server/test/*.test.mjs`、`src/**/*.test.mjs`、`tools/report-worker/*.test.mjs`），要点名：`npm test -- server/bakery/audio-mix.test.mjs server/bakery/export-missing-font.test.mjs server/bakery/mux-audio.test.mjs`
3. 编辑器探针（真浏览器；分支文件头说明：假的云端文档服务入口 + 一台开发服务器；输出最后一行 JSON，退出码 0＝全过）：`node scripts/probes/v18-missing-probe.mjs --port <端口> --doc-port <端口> --out <目录> --shots <截图目录>`。注意它的默认端口是 28460/28470/28479，不在 28560～28599 的约定里，主会话跑时用参数改到自己的段（它还要一个没人听的 `--dead-port`，模拟签发方连不上）。
4. 在线浏览器探针：先 `npx vite build --mode online`，再 `node scripts/probes/v18-missing-online-probe.mjs --dist dist-online --base <端口> --doc-port <端口> --asset-port <端口> --shots <截图目录>`（默认 28484/28481/28482，同样改端口）。
5. 我这边的联动项：把 `ACC018-STATE-4`、`ACC018-STATE-5`、`ACC018-DMG-6` 的 `todo` 去掉再跑，应当转绿（STATE-4/5 已用分支协调器副本演练通过；DMG-6 是读代码判断，未实跑）；`ACC018-DMG-5`、`DMG-7`、`DMG-11` 分支没改，合入后仍会是 todo 失败。
6. 合入后用 `server/test/accept-018-files-old-proc-fixtures.mjs` 的 7 份样本演练转换器：`buildOldProcMatrix(dir)` 造出文件，`expect` 表里写明每份的关联与素材哈希；对 `hostedPartialMedia.procp`、`hostedNoMedia.procp` 要看缺素材占位与弹窗（2.1-19.3）。
7. 另需用户过目：分支里新增的界面提示文字（`src/editor/sync/recoveryTexts.ts`、`CloudGoneDialog.tsx`、`MissingMaterialsDialog.tsx`）是一级语义，没有用户确认过的原文就要把草稿交给用户定。

#### 行 2.1-14：备份恢复

原文预期：「完整清单、校验结果、实际恢复并打开/读取；数据库快照一致，原备份保留」（`account-binding-task.md` 约第 179 行；输入「测试副本中的账号数据库、项目目录、素材及相关持久状态」；失败处理「未证明恢复不得删除旧数据」）。底稿：2026-10-09 在节点上做过，第三轮 5/5，「部署前要在当时的数据上重做」（`docs/archive/three-versions-production-restore-2026-10-09.md` 及其 `three-versions-production-restore-evidence/` 下 7 份 JSON）。
行状态：**部分有**（本机用真实数据布局的演练方法跑通；节点上那次是旧证据，部署前要重做；恢复副本上真的起服务这一步本机没做）

要先说清：仓库里**没有**备份/恢复脚本——10-09 那次是节点上的一次性脚本（文档里写「改为可审读的独立临时脚本」，不在仓库）。`grep -ri "backup\|restore"` 在 `scripts/`、`server/hosted/`、`server/docservice/`、`server/account/` 里只有文档里说的 `account-v2-install-plan.mjs` 注释（「root installer 须先验证可恢复备份」）和 `c10-backup.test.mjs`（那是在线页面离线批次的本机备份，不是服务数据备份）。所以我补的是**方法的演练**，不是对节点脚本的回归。

- **2.1-14.1 完整清单（三个数据库、项目目录、素材、持久状态逐个文件列出，带字节数和 SHA-256）**
  - 证据：补了 `accept-018-files-account-fixture.test.mjs` 的「ACC018-BACKUP-1」：在真实账号组合的数据布局上（`accounts.sqlite`、`doc/docservice/account-v2.sqlite`、`doc/docservice/operation-history-v2.sqlite`、项目日志 `.ndjson` 与 `.state-*.json`、`asset/` 下的素材与游标/实例文件，共 ≥ 8 个文件），先关掉三个服务（停写），再列清单：断言三个数据库、素材文件、项目日志与状态都在清单里。
  - 命令：`npm test -- server/test/accept-018-files-account-fixture.test.mjs`
  - 看哪一行：`✔ ACC018-BACKUP-1 …`
  - 实跑：2026-10-13，通过
  - 约耗时：约 6 秒
  - 在哪验：本机现在就能验（节点当时的数据另算，见 14.7）
- **2.1-14.2 校验结果（备份与清单逐文件一致；被改坏的备份校验会拦住）**
  - 证据：同一条测试：备份逐文件重算与清单一致、没有多出少掉；另拷一份备份改一个字节，校验精确点名被改的那个文件（`sha256` 不符）；用它去恢复会抛 `backup-verify-failed`，且**不创建任何恢复目录**。
  - 命令、看哪一行、实跑、耗时：同 14.1
  - 在哪验：本机现在就能验
- **2.1-14.3 实际恢复（到新目录，目标已存在则拒绝不覆盖）并打开/读取**
  - 证据：同一条测试：恢复到新目录后逐文件与清单一致；第二次恢复到同一目录被拒（`restore-target-exists`）；在恢复副本上用 `node:sqlite` 只读打开三个数据库，`PRAGMA integrity_check` 都是 `ok`，`user_version` 与源相同；操作历史库里能读到该项目，版本号和项目正文与备份前从运行中服务读到的完全相同；项目日志逐行能解析、状态文件能解析；素材文件的字节哈希与文件名相符。
  - 命令、看哪一行、实跑、耗时：同 14.1
  - 在哪验：本机现在就能验
  - 说明：「在恢复副本上真的起账号、文档、素材三个服务并通过健康检查」本机没做（组合夹具不支持换数据目录）；那一步 10-09 在节点上做过（第三轮 5/5），部署前要在节点上重做。
- **2.1-14.4 数据库快照一致**
  - 证据：同一条测试：三个数据库逐表的行数与内容摘要（按 rowid 排序后的整行 JSON 的 SHA-256），停写时的源与恢复副本逐表相同。读数据库（哪怕只读打开）会在目录里生出 `-wal/-shm`，所以摘要取自「停写快照」副本，不在被备份的目录上读（演练中踩到过一次，已修）。
  - 命令、看哪一行、实跑、耗时：同 14.1
  - 在哪验：本机现在就能验
  - 说明：这是停写后的一致，不是运行中热备份；10-09 的做法也是先停写 1.465 秒再备份。
- **2.1-14.5 原备份保留**
  - 证据：同一条测试：恢复完成后备份目录逐文件仍与清单一致，清单文件没变；恢复没有碰源目录。
  - 命令、看哪一行、实跑、耗时：同 14.1
  - 在哪验：本机现在就能验
- **2.1-14.6 未证明恢复不得删除旧数据**
  - 证据：演练里不含任何删除操作；10-09 记录写明「实际数据和备份均未删除」。这是流程约束，不是代码。
  - 在哪验：要部署到节点后验（删除清单要用户点头，见 `AGENT-018-prep.md` 第 7 节）
- **2.1-14.7 在节点当时的数据上重做，且在恢复副本上实际启动三个服务**
  - 证据：10-09 节点证据（三个数据库、18 个文件、三个角色启动，第三轮 5/5，保留前两轮失败原因）是旧记录，按验收规矩不替代最终提交上的复验。
  - 在哪验：要部署到节点后验
  - 建议：把这套方法（清单、校验、拒绝覆盖恢复、逐表摘要）写成仓库里的脚本，部署前在节点上用同一份脚本重做，省得每次靠一次性脚本；我没动产品代码，只在测试里演练。


## 9. 明细：契约、排队、运行器、发版动作（组 rest）

### 组 rest 的段落（2.3-1、2.3-2、2.3-8～2.3-13，RS18-queue、RS18-local、RS-common，2.1-10/11/15～18/20）

工作区 `C:\Users\admin\Documents\PromptCut\.worktrees\v18-accept`（main 内容，加主会话的开工提交 `afaeb75b`）。核对日期 2026-10-13。端口段 28560～28569 只用在 RS18-queue 的探针上。

**命令写法**（下面凡写 `〔PS〕` 或 `〔Bash〕` 的地方，都是把它换成这一整段前缀；单个文件都必须用 `npm test -- <文件>`，不裸跑 `node --test`）：

- `〔PS〕` = `cd C:\Users\admin\Documents\PromptCut\.worktrees\v18-accept; $env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive'; $env:PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs';`
- `〔Bash〕` = `cd /c/Users/admin/Documents/PromptCut/.worktrees/v18-accept && export PROMPTCUT_ACCOUNT_PROVIDER_ROOT='C:\Users\admin\Documents\VisuHive' PROMPTCUT_PASSWORD_ORDER_MODULE='C:\Users\admin\Documents\VisuHive\account\password-order.mjs' &&`
- 探针前后各查可见窗口：`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg' }`，我跑 RS18-queue 探针前后各查一次，都是空。

#### 产品问题（没有就写「无」）

**P0（最前面的发现）：验收运行器的清单里一条账号、素材、新 Agent 工具、排队、对话上限、改密退出的项都没有；`--check-coverage` 当场退出码 1。**
- 复现：`node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`（只读）。
- 期望：账号任务书第 120 行（「具体新探针/运行器纳入由后续实现包完成」）与 `AGENT-018-prep.md` 第 6.1 节第 2 点（出自设计「验收输入、正反探针与集成闸门」）说「新功能的验收项要先加进运行器的清单，否则整套不含它们」；部署清单 A1 的「整套」就是这个运行器。
- 实际：退出码 1，输出「scripts/probes 下 242 个文件，清单没登记也没写排除原因（56）」。这 56 个里就有这次的新功能探针：`account-*-probe`（用户路径、双用户、改密、对话控制、真实执行器、公网网页、接线）、`asset-account-isolation-probe`、`asset-project-isolation-probe`、`cloud-agent-consent-user-path-probe`、`cloud-queue-user-pages-probe`、`cloud-tools-p2/p3/p4/w2-probe`、`hosted-render-queue-probe`、`project-member-controls-probe`、`password-order-probe`、`agent-run-scope-proof`。另外 `grep -ciE "account|账号" scripts/acceptance/four-stage-manifest.mjs` 得 0。清单还是 120 项（本地 104、真实网络 16），`--matrix` 只有任务书一（R1～R25）、任务书二（C1～C13、U1～U6、J1、K1、C4a～c、C8a～c）两份任务书的对应表，没有账号任务书「逐项验收」的任何一行，也没有 RS18。逐项对照表在「行 2.1-15」。
- 后果：现在照部署清单 A1 的写法跑「整套」，跑完全绿也不代表账号、素材隔离、排队、改密退出被验过。

**P1：独立入口除了载入缝，另有 8 处直接引用 `src/`；已有守门 `CA-SEAM-01` 的扫法有洞。**
- 复现：`〔PS〕npm test -- server/test/accept-018-rest-ssr-seam.test.mjs`，看 `SEAM-1`、`SEAM-2` 两条（标了 todo，所以整体退出码 0，但输出里是 `⚠` 加断言差异）。
- 期望：任务书 `cloud-agent-task.md` 完成条件第 2 条「独立入口对前端代码的依赖只经一处载入缝（ssr-host.mjs），不新增别的直接引用」；契约 `cloud-agent-contract.md` 2.1 节「新目录 `server/agent/service/` 与 `server/agent-service/` 里不许出现指向 `src/` 的 import，单测 CA-SEAM-01 守门」。
- 实际：
  1. **`server/agent/service/perception/subject.mjs:160`** 用 `import(new URL('../../../../src/kernel/project.ts', import.meta.url).href)` 直接载入 `src/kernel/project.ts`。这正是契约点名的目录。`CA-SEAM-01` 没拦住：它用 `readdirSync` 只扫目录这一层、不进子目录 `perception/`，而且把每条相对路径都按「目录」而不是「文件所在目录」解析。
  2. 从独立入口目录的文件出发跟着 import 走（传递闭包），还有：`server/agent/agent-board.mjs` → `src/kernel/agentScopes.mjs`（契约只认 `creativity.mjs` 三处是「起点就有的」，这条没列）；`server/agent/agent-sessions.mjs`、`server/agent/creativity-gate.mjs` → `src/kernel/creativity.mjs`（契约认）；`server/agent/agent-roles.mjs` 用 `new URL('../../src/ai/roles/')` 读提示词文件（读文件，不是载入代码，但路径依赖 `src/`）；`server/vite-plugin-cards.ts`（`hosted-tools.mjs:235` 动态载入的那一份卡片检查纯函数）→ `src/render/cardCodeIdentity.mjs`、`src/online/cardRuntime/remotionLock.mjs`，以及一处写在字符串里的 vite 模块 id `/src/audio/cardAudioHost.ts`（在渲染页里求值，严格说不是 Node 的 import，列在这里让主会话判）。
  3. 运行器清单里 `S4-m1` 给的核对命令 `grep -rn "from .*\.\./\.\./src" server/agent-service` 只扫 `server/agent-service/` 一个目录，同样漏。
- 我没有放松断言：强版 `SEAM-1`/`SEAM-2` 保留为 todo；另有棘轮 `SEAM-3` 把现状 8 处固定下来（只许少不许多），它是绿的。

**P2：账号模式下云端 Agent 没有接「看画面」，块八的排队在生产路径上用不上（主会话进度文件已记，这里补一条可重跑的固定）。**
- 复现：`〔PS〕npm test -- server/test/accept-018-rest-queue-account-look.test.mjs`，看 `Q-ACC-1`（todo）。
- 期望：账号任务书 RS18-queue 的「Agent see_frames 与预渲染争用」要在云端 Agent 真用的那条路上成立；生产上云端项目一律走账号模式。
- 实际：`server/agent-service/main.mjs:343` 写的是 `...(!accountMode && lookUrl ? { look: createLookClient(...) } : {})`，账号模式的执行器是用同一份 serviceOptions 展开的（第 190 行），拿不到 `look`；第 379 行状态里也写 `look: !accountMode && !!lookUrl`。所以排队、一分钟乘三次重试都只在非账号的托管档上有人用。

**P3（疑似，没有实跑核实）：运行器 G0-2 的通过条件 `skipped ≤ 2`，而进度文件三处记全量测试「跳过 3」。**
- 出处：`scripts/acceptance/four-stage-manifest.mjs:182`（`limits: { fail: { eq: 0 }, skipped: { max: 2 } }`）；`docs/plan/three-versions-progress.md` 第 35、38 行写「通过 6029、失败 0、跳过 3」「通过 5936、失败 0、跳过 3」。我按要求没跑全量 `npm test`，所以不能确认；主会话跑全量时看 `ℹ skipped` 是不是 3，是的话 G0-2 会被运行器判不过，要在清单里把上限改成实际数并写明是哪几条。

#### 新增文件

- `server/test/accept-018-rest-ssr-seam.test.mjs`：独立入口对 `src/` 的依赖扫描。5 条：SEAM-1（递归扫两个目录，强版，todo）、SEAM-2（传递闭包，强版，todo）、SEAM-3（棘轮，现状 8 处只许少不许多）、SEAM-4（闭包里无人 import `desktop/`）、SEAM-5（扫描器自检 + 载入缝仍在）。跑法：`〔PS〕npm test -- server/test/accept-018-rest-ssr-seam.test.mjs`。结果（2026-10-13）：`ℹ tests 5 / pass 3 / fail 0 / todo 2`，`npm test 最终结果：零失败`，退出码 0，约 1 秒。
- `server/test/accept-018-rest-queue-account-look.test.mjs`：账号模式有没有接看画面（静态读 `main.mjs`）。2 条：Q-ACC-2 自检（绿），Q-ACC-1（todo，现状不成立）。跑法：`〔PS〕npm test -- server/test/accept-018-rest-queue-account-look.test.mjs`。结果（2026-10-13）：`tests 2 / pass 1 / todo 1 / fail 0`，退出码 0，1 秒。

---

#### 行 2.3-2：独立入口对前端代码的依赖只经一处载入缝；不动桌面壳
原文预期（`docs/plan/cloud-agent-task.md`「完成条件」第 2 条，第 81 行）：「与后续工作的约定：独立入口对前端代码的依赖只经一处载入缝（现在是 `server/agent/ssr-host.mjs`），不新增别的直接引用；云节点上照旧跑 Vite 来载入工具实现；不动桌面壳。」（`AGENT-018-prep.md` 2.3 表第 2 行把它缩成前半句加「不动桌面壳」。）
行状态：部分有（证据能跑，但前半句**现状不成立**，见产品问题 P1；「不动桌面壳」按字面也不成立，见 2.3-2.4）

- **2.3-2.1 独立入口对前端代码（`src/`）的依赖只经 `server/agent/ssr-host.mjs` 这一处**
  - 证据：已有 `server/test/cloud-agent-service.test.mjs` 的「CA-SEAM-01 新目录里没有指向 src/ 的 import」（能过，但扫得不全，见 P1）；补了 `server/test/accept-018-rest-ssr-seam.test.mjs` 的 SEAM-1（目录递归）、SEAM-2（传递闭包）、SEAM-3（棘轮）、SEAM-5（自检）。
  - 命令：`〔PS〕npm test -- server/test/accept-018-rest-ssr-seam.test.mjs`（Bash 写法把 `〔PS〕` 换成 `〔Bash〕`）；已有那条：`〔PS〕npm test -- server/test/cloud-agent-service.test.mjs`。
  - 看哪一行：`✔ SEAM-3`、`✔ SEAM-5` 绿；`⚠ SEAM-1`、`⚠ SEAM-2` 带 todo 标注，下面的差异就是违反清单（SEAM-1：`server/agent/service/perception/subject.mjs -> src/kernel/project.ts`；SEAM-2：8 行）。这两条变绿（去掉 todo 后真绿）才算这句成立。
  - 实跑：2026-10-13，SEAM 文件 `tests 5 / pass 3 / todo 2 / fail 0`，退出码 0；SEAM-1 实际差异 1 行、SEAM-2 实际差异 8 行（列表见 P1）。`cloud-agent-service.test.mjs`：18 条全过，11 秒，退出码 0，其中 `✔ CA-SEAM-01 新目录里没有指向 src/ 的 import`（它过，说明这条守门拦不住上面的违反）。
  - 约耗时：SEAM 文件 1 秒；`cloud-agent-service.test.mjs` 11 秒。
  - 在哪验：本机现在就能验
  - 说明：扫描器本身用合成文本自检过（SEAM-5：`from`、`export … from`、`import()`、`import '…'`、`new URL(…, import.meta.url)`、`load('/src/…')` 六种写法都抓得到，注释里的不算）。ssr-host 自己确实在用 `load('/src/…')` 载入 14 个前端模块（SEAM-5 断言 ≥10）。
- **2.3-2.2 不新增别的直接引用（棘轮）**
  - 证据：补了 SEAM-3。
  - 命令：同上。
  - 看哪一行：`✔ SEAM-3 棘轮：指向 src/ 的直接引用只许少、不许多`；若有人新增一处，它会红并打印新增的那一行。
  - 实跑：2026-10-13 通过（现状 KNOWN 表 8 项，与 SEAM-2 的 8 行完全一致）。
  - 约耗时：<1 秒
  - 在哪验：本机现在就能验
- **2.3-2.3 云节点上照旧跑 Vite 来载入工具实现**
  - 证据：`server/agent-service/main.mjs` 第 150～162 行在进程里 `createServer`（vite，middleware 模式、不监听）并把 `vite.ssrLoadModule` 当 `loadModule`；`server/test/cloud-agent-service.test.mjs` 的「CA-ENTRY-01 / CA-ENTRY-03 托管档入口」起这个入口。
  - 命令：`〔PS〕npm test -- server/test/cloud-agent-service.test.mjs`
  - 看哪一行：`✔ CA-ENTRY-01 / CA-ENTRY-03 …`
  - 实跑：2026-10-13，`cloud-agent-service.test.mjs` 18 条全过，11 秒，退出码 0；`✔ CA-ENTRY-01 / CA-ENTRY-03 …`。
  - 在哪验：本机现在就能验（节点上由 S4-r1 验同一份）
- **2.3-2.4 不动桌面壳**
  - 证据：无测试，是 git 范围核对。
  - 命令（怎么核对，只读）：`git diff --stat release..main -- desktop/` 与 `git diff --stat release..main -- desktop/src-tauri/`；要看改了什么：`git diff release..main -- desktop/src-tauri/src/lib.rs`。`release` 在 `073c8cca`（0.7.17），是 main 的祖先；发版时把 `main` 换成最终提交。
  - 看哪一行：「不动桌面壳」要的结果是 `desktop/` 与 `desktop/src-tauri/` 的差异为空（空输出）。
  - 实跑：2026-10-13（在 v18-accept，内容等于 main）`git diff --stat release..HEAD -- desktop/` 得 **13 个文件，+245 −36**，**不为空**：
    - 壳（`desktop/src-tauri/`，4 个，+215 −6）：`build.rs`（+1）、`capabilities/account.json`（新增，+9）、`src/account_vault.rs`（新增，+139，桌面版保存可撤销的恢复凭证）、`src/lib.rs`（+72 −6，含 `account_editor_port`、`account_cloud_binding` 等账号探针与云端绑定）。
    - 发版与冒烟脚本（`desktop/scripts/`，9 个）：`build-release.mjs`、`make-extension.mjs`、`make-patch.mjs`、`prepare-python.mjs`、`prepare-runtime.mjs`、`smoke-all.mjs`、`smoke-boot.mjs`、`smoke-procs.mjs`、`smoke-shutdown.mjs`（多数是 `a098d292` 补 `windowsHide`，零碎块）。
  - 在哪验：本机现在就能验
  - 说明：这一句来自 2026-10-06 的四段任务书，那时账号任务还没有；壳后来被账号任务（凭证保管）动了，是后来的决定，不是 Agent 服务动的。所以要判的不是「差异是否为空」，而是「改动是否只来自账号任务、Agent 服务这条线没碰壳」：`git log --oneline release..main -- desktop/` 列出的提交都是账号路径与零碎块（`cc144c2a 接通账号云端创建…`、`de633822 为主编辑器登记独占账号安全桥权限`、`a098d292 …补 windowsHide` 等）。外壳版本要不要抬、补丁最低壳要不要抬，见「行 2.1-17」。
  - 另有自动守门（SEAM-4）：独立入口的传递闭包里没有文件 import `desktop/` 下的东西，绿。


---

#### 行 RS18-queue：单节点排队（块八「云端排队」，main `0ec8c7cd`）
原文预期（`docs/plan/account-binding-task.md`「新增验收映射」第 114 行）：输入「多个均含自定义卡的项目、Agent see_frames 与预渲染争用、内存/磁盘压力和重启」；「对应原 render capacity、S3 资源/容量、S4 看画面；须证单活跃项目、等待不丢/不静默本机、恢复/隔离；旧 2+1 与 16+1 不能替代，未跑」。
行状态：部分有（本机替身上，除磁盘压力的一半和账号生产路径外都有可跑的证据；真等五分钟的版本我只列命令）

先说明两件事：
1. 文件名里带 `cloud-queue` 的 `server/test/cloud-queue-http.test.mjs`、`cloud-queue-native-admin.test.mjs`、`scripts/probes/cloud-queue-user-pages-probe.mjs` **不是**这一行的证据：它们验的是共有对话里「消息的排队位置」（FIFO、排第几），不是渲染服务的看画面队列。这一行的证据在 `hosted-render-queue*`、`hosted-render-look`、`hosted-render-isolation`。
2. 块八的报告 `docs/reports/AGENT-v18-queue.md` 里单测叫 RQ1～RQ9，探针检查叫 Q1～Q8；下面用它们的编号。

- **RS18-queue.1 多个均含自定义卡的项目：云端一次只装一个，别的排队不被拒、不回「忙/已满」**
  - 证据：`server/test/hosted-render-queue.test.mjs` 的「RQ1 两个都带用户卡的项目先后有活：第二个排队而不是被拒…」；探针 `scripts/probes/hosted-render-queue-probe.mjs` 的 Q1a～Q1d（三个项目都带用户卡，各涂一种颜色，从拿回的图中心颜色判渲的是哪个项目）。
  - 命令：`〔PS〕npm test -- server/test/hosted-render-queue.test.mjs`；探针（端口都在我的段里）：`$env:PROMPTCUT_NO_PORT_FILE='1'; node scripts/probes/hosted-render-queue-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568 --idle-ms 20000`（Bash：`PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/hosted-render-queue-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568 --idle-ms 20000`）
  - 看哪一行：单测 `✔ RQ1 …`；探针输出里 `过  Q1a`、`过  Q1b 甲装着时乙要一帧：不被拒，登记在队列里等着（排着 1 个，原因是隔离工作进程装着别的项目）`、`过  Q1c`、`过  Q1d`。
  - 实跑：2026-10-13。单测 `hosted-render-queue.test.mjs`：9 条全过，7 秒，退出码 0。探针：Q1a～Q1d 全过（见文末「探针实跑」）。读过 RQ1 的代码：两个项目 P1、P2 都带 `src/cards/user/x.tsx`，断言第二个回 202、状态口记原因、没有 busy 字样、乙的内容没被转给装着甲的工作进程，对得上。
  - 约耗时：单测 7 秒；探针（`--idle-ms 20000`）整趟约 8 分 40 秒（这次机器上有别的子 Agent 同时在跑，内存一度吃紧触发背压；块八报告里同参数是几分钟）
  - 在哪验：本机现在就能验
- **RS18-queue.2 Agent `see_frames` 与预渲染任务争用：看画面优先**
  - 证据：「RQ2 云端 Agent 要看画面的请求优先于预渲染任务：下一轮先给要看画面的项目；常驻工作进程先替排着的请求留出名额」；探针 Q2（丙先发预渲染计划，乙后要看画面，甲让位后下一轮装的是乙）、Q6（预渲染任务不丢）。另 `hosted-render-isolation.test.mjs` 的 HR23 ×4（候选排序、轮流）。
  - 命令：同上；`〔PS〕npm test -- server/test/hosted-render-isolation.test.mjs`
  - 看哪一行：`✔ RQ2`；探针 `过  Q2 看画面优先于预渲染任务…`、`过  Q6 预渲染任务不丢…`。
  - 实跑：2026-10-13。`hosted-render-isolation.test.mjs` 7 条全过，1 秒；`hosted-render-look.test.mjs`（HR38～HR43、CA-LOOK-01）7 条全过，8 秒。
  - 在哪验：本机现在就能验
  - 说明：「争用」在这里是本机替身上的调度顺序，不是真实机器上的并发压力。
- **RS18-queue.3 内存压力：背压暂停时排着等，不回忙，过去了接着做**
  - 证据：「RQ6 内存或磁盘吃紧：背压暂停…排着等并记下原因，过去了接着做；登记的到了硬上限时不算没看成」的内存部分；`hosted-render-memory.test.mjs` HR33～HR37（量法与判定）；探针 Q5b（把可用内存线调到够不着，模拟内存吃紧，重启后排着的那条原因记「backpressure」）。
  - 命令：`〔PS〕npm test -- server/test/hosted-render-queue.test.mjs server/test/hosted-render-memory.test.mjs`
  - 看哪一行：`✔ RQ6`；`hosted-render-memory` 10 条；探针 `过  Q5b …背压暂停…原因记的是背压，不回忙、不为它新起隔离工作进程`。
  - 实跑：2026-10-13。`hosted-render-memory.test.mjs` 10 条全过，2 秒；`hosted-render-queue` 9 条全过。探针 Q5b：`paused:true,reasons:["memory"]`、`queue.blocked.backpressure:1`、`isoStarts:0`、调用方只是在等，过。
  - 在哪验：本机现在就能验（真实内存余量与 16 GB 节点上的表现：要部署到节点后验，见 RS-common）
- **RS18-queue.4 磁盘压力：产物到容量上限时排着等**
  - 证据：RQ6 的磁盘部分（产物到容量上限时 `bake_card` 排着、看一帧照常）；`hosted-render-capacity.test.mjs` HR21a～h（产物记账与上限，8 条）。
  - 命令：`〔PS〕npm test -- server/test/hosted-render-queue.test.mjs server/test/hosted-render-capacity.test.mjs`
  - 看哪一行：`✔ RQ6`、`hosted-render-capacity` 8 条全过。
  - 实跑：2026-10-13。`hosted-render-capacity.test.mjs` 8 条全过，6 秒。
  - 在哪验：本机现在就能验（单测部分）；**预渲染任务遇到素材服务 507 时留在队列里等、不记失败**这一半**没有**：`server/render-node/host.mjs` 现在把它记成不可重试的失败并暂停认领 10 分钟（块八报告「没做成的」第 3 条），在渲染那一带，要等渲染重构合入后做。这一半标：要等某一块合入（渲染重构的后续块）。
  - 说明：探针里没有模拟 507 的办法，所以磁盘压力只有单测。该子断言整体算「部分有」。
- **RS18-queue.5 重启：排着的请求跨重启不丢、次序不变、正在做的回到排队**
  - 证据：「RQ4 重启后排着的请求还在…」；探针 Q5a（强行结束整棵树后盘上留着）、Q5b（再起接回）、Q5c（正常收尾后再起，接回，出图）。
  - 命令：同 RS18-queue.1。
  - 看哪一行：`✔ RQ4`；`过  Q5a`、`过  Q5b`、`过  Q5c …调用方拿到了图，中间只是重连`。
  - 实跑：2026-10-13，单测 `hosted-render-queue.test.mjs` 过；探针 Q5a（强行结束整棵树后盘上留 1 条，项目是甲的）、Q5b（再起接回 `restored:1,results:3`）、Q5c（正常收尾后再起接回，41.3 秒后拿到图，`reconnects:1,failedTrips:4`）都过。
  - 在哪验：本机现在就能验
- **RS18-queue.6 单活跃项目：任何时刻隔离工作进程里只装一个项目**
  - 证据：RQ1（编排一次只起一个、另一个记在等的名单里）；探针 Q1b 第二条（每半秒看一次状态口，等待期间装着的始终只有甲，同时装两个项目的拍数 0）。
  - 命令：同 RS18-queue.1。
  - 看哪一行：探针 `过  Q1b 乙等着的整个期间隔离工作进程装着的始终只有甲一个项目（任何一拍都没有同时装两个）`。
  - 实跑：2026-10-13，探针 `过  Q1b 乙等着的整个期间…`：状态口采样 125 拍，装着的始终只有甲，同时装两个项目的拍数 0（块八报告在真五分钟版里是 655 拍、也是 0）。
  - 在哪验：本机现在就能验
- **RS18-queue.7 等待不丢：排着的请求最终出图，预渲染任务也最终做完**
  - 证据：RQ4、RQ5（中途成了就成了；次数到了才回「这次没看成」）；探针 Q4（乙等了数十秒到五分钟级后出图）、Q6（丙的预渲染计划跨三个看画面轮次、两次重启后做完，失败 0）。
  - 命令：同 RS18-queue.1。
  - 实跑：2026-10-13，探针 Q4 乙的那一帧在等了 60.2 秒后出（中心颜色 `[0,255,0]`，隔离工作进程出，重试 0 次，失败 0）；Q6 丙的预渲染计划等了 168.5 秒（跨三个看画面轮次、两次重启），1 个任务做完、失败 0；Q5c 请求跨两次重启后拿到图。
  - 在哪验：本机现在就能验
  - 说明：此处 `--idle-ms 20000` 只验「满了配置的时长才让位」，不是生产的五分钟；生产值的真等版本见 RS18-queue.10。
- **RS18-queue.8 不静默改走本机**
  - 证据：无专门断言。块八这一块的代码里没有「改走本机」的路：请求要么排着、要么明确回「这次没看成」（RQ5、Q7）；探针 Q4、Q5c 的图都标着由隔离工作进程出（`worker: isolated`）。`git grep -nE "本地取帧|localFirst|local-first" -- server src` 无命中。
  - 在哪验：本机现在就能验（云端一侧）；与「本地取帧优先」联动的那一半：要等某一块合入（块十，见行 RS18-local）
  - 说明：「没有这条路」是读代码得来的，不是一条会在有人加了这条路时变红的守门；若要固定，等块十合入后补一条「云端满了也不改走本机」的守门。
- **RS18-queue.9 恢复/隔离：重启后恢复，项目间不串**
  - 证据：Q5c；RQ1（乙的内容没有被转给装着甲的工作进程）；探针每一帧的颜色都是它自己项目的颜色；现成的隔离探针 `scripts/probes/hosted-render-isolation-probe.mjs`（49 项，块八报告称重跑全过）。
  - 命令：`node scripts/probes/hosted-render-isolation-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568`（本行我没有重跑这支，机器上同时有别的子 Agent，列命令）；单测 `hosted-render-isolation.test.mjs` 7 条已跑过。
  - 在哪验：本机现在就能验
- **RS18-queue.10 生产的「空闲满五分钟才让位」版本（真等五分钟）**
  - 证据：同一支探针，不加 `--idle-ms`（缺省就是生产的 300000）。
  - 命令：`node scripts/probes/hosted-render-queue-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568`
  - 约耗时：块八报告：整趟十几分钟（Q3 读数 315.2 秒、乙-1 端到端 335.7 秒、丙的预渲染等了 724 秒），超过 6 分钟，**我没有跑**。块八报告称最终提交上这一遍退出码 0、14 条全过。
  - 在哪验：本机现在就能验（命令在此，约十几分钟）
- **RS18-queue.11 账号模式（生产路径）下云端 Agent 看得了画面、走这条队列**
  - 证据：补了 `server/test/accept-018-rest-queue-account-look.test.mjs`（Q-ACC-1 todo、Q-ACC-2 自检）。
  - 命令：`〔PS〕npm test -- server/test/accept-018-rest-queue-account-look.test.mjs`
  - 看哪一行：`⚠ Q-ACC-1 …现状不成立`（todo）；变绿的条件是 `main.mjs` 里创建看画面客户端的条件不再含 `!accountMode`。
  - 实跑：2026-10-13，`tests 2 / pass 1 / todo 1 / fail 0`，退出码 0，1 秒；`⚠ Q-ACC-1 …现状不成立`。
  - 在哪验：要等某一块合入（把看画面接进账号模式执行器的那一块；块八报告「没做成的」第 2 条、进度文件第 35 行）
  - 说明：产品问题 P2。接上以后还要补一支端到端探针：账号模式的 Agent 服务起来后 `see_frames` 经队列拿到图。
- **RS18-queue.12 「旧 2+1 与 16+1 不能替代」**
  - 原文这一句是约束：证据不能拿旧的 2 任务+1 看画面、16 连接+1 的容量测试来顶。上面所有证据都是块八新增的 RQ1～RQ9 与 Q1～Q8，不是旧项。
  - 在哪验：本机现在就能验（无需额外命令）

---

#### 行 RS18-local：本地取帧优先
原文预期（账号任务书「新增验收映射」第 113 行）：输入「自定义卡项目；本地成功、授权/能力/可用性不满足、全部离线、执行中离线、取消、版本切换/迟到结果；界面播放头不变、云端兜底且单活跃项目」；「cloud-agent-look、hosted-render-isolation 有旧单路径证据，不能证明该完整选择链；新覆盖待实现、未跑」。
行状态：没有（块十「本地取帧优先」没合入 main，代码没做）

核实 main 上确实没有：
- 命令：`git grep -nE "本地取帧|本地优先|localFirst|local-first|preferLocal" -- server src`（Bash 或 PowerShell 同）→ 无命中；`ls server/hosted-render/` 里没有选本地节点的模块（有 `look.mjs`、`render-requests.mjs`、`broker.mjs`、`isolation.mjs`，只有云端一路）；`server/render-node/` 里没有答「看画面」请求的代码。
- 进度文件 `docs/plan/three-versions-progress.md` 第 60 行：「合格本地取帧优先、云端单活跃项目排队：已规划，尚未交付」；`AGENT-018-prep.md` 第 5 节块十：「依赖 八；渲染重构」。
- 2026-10-13 实跑：上面的 `git grep` 无命中。

逐子断言（全部同一个状态：本机替身上都做不了，因为选择链的代码不存在）：
- **RS18-local.1 本地成功**：授权、能力、在线三样都满足的本地节点先答，取到帧。证据：无。在哪验：要等某一块合入（块十）。
- **RS18-local.2 授权不满足**：设备没授权 → 不走本地，进云端队列。证据：无。要等某一块合入（块十）。
- **RS18-local.3 能力不满足**（例如显卡/浏览器能力不够）：同上。无。要等某一块合入（块十）。
- **RS18-local.4 可用性不满足**（节点在线但忙/不可用）：同上。无。要等某一块合入（块十）。
- **RS18-local.5 全部离线**：全部本地节点离线 → 云端单活跃项目兜底，仍得到帧。证据：无（云端那一半即 RS18-queue 的证据）。要等某一块合入（块十）。
- **RS18-local.6 执行中离线**：本地节点取帧到一半掉线 → 转云端，不丢。无。要等某一块合入（块十）。
- **RS18-local.7 取消**：Agent 这一轮被停，本地与云端的请求都撤回。证据：只有云端一半（RQ7、RQ8、探针 Q1d）；本地一半无。要等某一块合入（块十）。
- **RS18-local.8 版本切换/迟到结果**：项目改了版本后，旧版本的本地结果迟到要被隔离、不当作新结果。证据：无专门用例（块八报告「没做成的」第 6 条：「现有的保证」是项目内容随请求带来；换了一轮的结果作废并重试；撤回的结果丢弃）。要等某一块合入（块十）。
- **RS18-local.9 界面播放头不变**：本地取帧不动用户界面上的播放头。证据：无。要等某一块合入（块十），并且是一条要真浏览器的探针。
- **RS18-local.10 云端兜底且单活跃项目**：证据只有云端一半（RS18-queue.1/.6）；「兜底」这个触发条件不存在。要等某一块合入（块十）。

---

#### 行 RS-common：三版本共同回归
原文预期（账号任务书第 118 行）：输入「上述所有输入加跨项目/版本/授权、取消、失败兜底」；「记录机器/设备、帧数、素材/卡复杂度、并发、缓存、内存、最终提交、起止点、分位数和全部 >5 分钟尾部原因；只规划不计通过」。
行状态：部分有（RS18-queue 那部分与取消、失败兜底、授权有可跑的证据；RS18-local 整组、跨版本、度量记录没有）

拆成子断言，每条指到别的行的证据：
- **RS-common.1 RS18-local 的全部输入** → 见行 RS18-local。证据：无。在哪验：要等某一块合入（块十）。
- **RS-common.2 RS18-queue 的全部输入** → 见行 RS18-queue（.1～.12）。证据：有，部分（磁盘 507 一半、账号模式生产路径没有）。在哪验：本机现在就能验。
- **RS-common.3 RS18-chat 的全部输入**（同项目同创建者 49→50→第 51、共享消息多发送者、另一项目/创建者、并发创建、删除后重建/重开）→ 见行 RS18-chat（不是 rest 组的行，我没核；该行状态以负责那一行的组为准）。证据：无（在这一组里）。
- **RS-common.4 跨项目**：项目甲的内容/请求不会落到装着项目乙的工作进程。证据：RQ1；探针 Q1b（655 拍无双装）、每帧颜色对得上项目；`hosted-render-isolation.test.mjs`、`hosted-render-look.test.mjs` HR39（有卡的只走这一轮正是它的隔离工作进程）；探针 `hosted-render-isolation-probe`（越权探测卡，49 项）。命令：`〔PS〕npm test -- server/test/hosted-render-queue.test.mjs server/test/hosted-render-look.test.mjs server/test/hosted-render-isolation.test.mjs`。实跑：2026-10-13，9 + 7 + 7 条全过。在哪验：本机现在就能验；节点上同样的越权探测是 S3-r4（核心项）：要部署到节点后验。
- **RS-common.5 跨版本**：同一项目的两个版本，旧版本的结果迟到不能顶替新版本。证据：无专门用例（同 RS18-local.8）。在哪验：要等某一块合入（块十，本地一路）；云端一路可以补，但目前没有。
- **RS-common.6 跨授权**：看画面的口子只认登记过的 Agent 服务的签名；别的调用方问不到别人的请求。证据：RQ9、HR38、HR42、HR43、CA-LOOK-01；`cloud-agent-look.test.mjs`（CA-LOOK-02～04）。实跑：`hosted-render-look.test.mjs` 7 条全过；`cloud-agent-look.test.mjs` 3 条全过（8 秒）。在哪验：本机现在就能验。**缺口**：块八〔裁〕第 11 条：请求绑的是登记它的 Agent 服务实例，**不是**这一轮的运行授权；账号模式下「失权后排着的请求要撤」还没做（要等 P2 那一块接线时一起定）→ 这一条只算部分。
- **RS-common.7 取消**：一轮被停，排着/正在做的看画面请求撤回；调用方不再来问的撤掉。证据：RQ7、RQ8、探针 Q1d。在哪验：本机现在就能验（云端一路）。
- **RS-common.8 失败兜底**：渲染卡住自动重试三次、隔离工作进程起不来也算次数；都不成回「这次没看成」，不回「忙/已满」。证据：RQ5；探针 Q7（把每次最多等多久调成 1 毫秒）。在哪验：本机现在就能验。
- **RS-common.9 要记录的度量**（机器/设备、帧数、素材/卡复杂度、并发、缓存、内存、最终提交、起止点、分位数、全部 >5 分钟尾部原因）：证据：探针按次记端到端耗时与 >5 分钟那一次的原因（块八报告列了甲-1、甲-2、乙-1 335.7 秒、甲-3、丙）；**没有**分位数（样本只有 6 次，报告自己说没意义）；也不是在最终提交、节点配置上的数。在哪验：要部署到节点后验（最终提交 + 节点 8 核 16 GB 上重跑 RS18 各组并记数）。
- **RS-common.10 「只规划不计通过」**：原文这一句是说：没有在最终提交上跑出结果之前，不把 RS-common 记作通过。所以本行最终要在最终提交上重新给结论。

---

#### 行 2.3-1：设计与契约（`docs/plan/` 下）先写好再动手
原文预期（`cloud-agent-task.md`「完成条件」第 1 条）：「设计与契约（`docs/plan/` 下）先写好再动手，定清：Agent 服务独立入口的形态与对外接口、鉴权；按「用户 × 项目 × 对话」分实例，原来进程级的全局状态（绑定的项目、审查环路锁、额度熔断、登录状态、配置、对话记录）各自怎么改；H 的认证流程与文档服务侧的核验；G 的检查点与用量记录的格式；在线页面到 Agent 服务走哪条通道、凭什么不违反「在线页面不请求编辑器进程的 `/api/*`」这条契约的本意、守卫与棘轮清单怎么改；对话记录存在哪、谁能读；节点上的资源上限。」
行状态：已有可跑的证据（文档在，八项逐项都有对应章节；是读文档的 grep 核对，不是自动测试。与 2026-10-08 以后决定的同步情况见 2.3-1.9）

文件都在：`docs/plan/cloud-agent-contract.md`（259840 字节，下称「契约」）、`docs/plan/three-versions-018-design.md`（106758）、`docs/plan/cloud-agent-tools-implementation.md`（19307，工具拆包）、`docs/plan/hosted-render-contract.md`（165042）、`docs/plan/cloud-agent-tool-coverage.md`。核对命令都是在工作区根目录执行（Bash 与 PowerShell 的 `grep` 换成 `Select-String` 即可；下面写 Bash）。实跑日期 2026-10-13。

- **2.3-1.1 独立入口的形态与对外接口**：契约 2.1「一份实现，两种挂法」（第 66 行）、2.2「托管档的进程与目录」（第 92 行）、2.3「托管档对外接口」（第 125 行）。命令：`grep -nE "^### 2\.[123] " docs/plan/cloud-agent-contract.md`。看哪一行：3 个标题都在。实跑：3 命中。在哪验：本机现在就能验。
- **2.3-1.2 鉴权**：契约 2.5「鉴权（概述）」（第 167 行）与第 4 节「H：认证流程」（第 280 行起，4.1 三样凭证各管什么、4.2 两种身份证明）。命令：`grep -nE "^### 2\.5 |^## 4\. |^### 4\.[12] " docs/plan/cloud-agent-contract.md`。实跑：4 命中。在哪验：本机现在就能验。
- **2.3-1.3 按「用户 × 项目 × 对话」分实例，原来进程级的全局状态各自怎么改**：契约第 3 节（第 175 行）：3.1 实例的边界、3.2 **全局状态清单**（第 200 行，一行一项，含「服务端 store 单例」「工具实现打编辑器接口的地址」等，列「改法」「改后」）、3.3 最难的三处、3.4 实例的生命周期。命令：`grep -nE "^## 3\. |^### 3\.[1-4] " docs/plan/cloud-agent-contract.md`；`grep -c "进程" ` 不用；看 3.2 那张表的行数：`sed -n 200,257p docs/plan/cloud-agent-contract.md | grep -c "^|"`。实跑：标题 5 命中。在哪验：本机现在就能验。说明：原文括号里点名的六样（绑定的项目、审查环路锁、额度熔断、登录状态、配置、对话记录）是否都在 3.2 清单里，我只核到清单存在、逐条分类，没有逐一勾对六个词；主会话要的话再核。
- **2.3-1.4 H 的认证流程与文档服务侧的核验**：契约 4.3「时序」（第 317 行）、4.4「权限不超过成员本人」（第 357 行）、4.5「三种失效怎么传到并停掉对话」（第 375 行）、4.7「对通用『托管方服务身份』的要求」（第 394 行）。命令：`grep -nE "^### 4\.[3-5] |^### 4\.7 " docs/plan/cloud-agent-contract.md`。实跑：4 命中。在哪验：本机现在就能验。说明：2026-10-08 起「只读成员」「失效时一律停」等被账号任务取代，契约第 3～47 行有对齐补记（见 2.3-1.9）。
- **2.3-1.5 G 的检查点与用量记录的格式**：契约 6.1「开关与额度存在哪」（第 426 行）、6.2「闸」（第 450 行，`admitRun`/`admitModelCall`/`record` 三个入口，判定顺序）、6.3「用量记录」（第 466 行，`usage/<yyyy-mm>.jsonl` 的字段 JSON 样例、`totals.json`、查询）。命令：`grep -nE "^### 6\.[1-3] " docs/plan/cloud-agent-contract.md`。实跑：3 命中。在哪验：本机现在就能验（代码侧另有 `server/test/cloud-agent-runs.test.mjs` 的 CA-GATE-04/05 与「用量记录」用例，见 2.3-9）。
- **2.3-1.6 在线页面到 Agent 服务走哪条通道；凭什么不违反「在线页面不请求 `/api/*`」；守卫与棘轮清单怎么改**：契约 10.1「选哪条」（第 769 行）、10.2「凭什么不违反」（第 793 行）、10.3「守卫与棘轮清单怎么改」（第 803 行，`c10a-online-api-paths.json` 一条不加、新增 C10A-API-05/07、CAP-UI-02）。命令：`grep -nE "^### 10\.[1-3] " docs/plan/cloud-agent-contract.md`。实跑：3 命中。在哪验：本机现在就能验。
- **2.3-1.7 对话记录存在哪、谁能读**：契约 7.1「存什么、存在哪」（第 483 行）、7.2「对话归谁、谁能读」（第 500 行）。命令：`grep -nE "^### 7\.[12] " docs/plan/cloud-agent-contract.md`。实跑：2 命中。在哪验：本机现在就能验。说明：7.2 开头自己写了「已被用户新决定取代：下方主人键方案和『只有主人可读』来自旧私有对话模型」，现行规则在 `docs/plan/account-binding-contract.md` 与 `docs/semantics/product/agent.md`「对话记录」一条（共有/私有、创建者可只读、托管方可读全部记录且首次使用前告知）；所以「谁能读」要两处合起来读。
- **2.3-1.8 节点上的资源上限**：契约第 11 节（第 827 行），一张表：V8 老生代 1536 MiB、常驻超 2 GB 重启、全节点 6 轮/每项目 3/每成员 2、存活实例 24、项目副本 ≤16 MiB、一轮 24 次往返/30 分钟、事件记录封顶、请求体、事件流条数、磁盘。命令：`grep -nE "^## 11\. " docs/plan/cloud-agent-contract.md`。实跑：1 命中。在哪验：本机现在就能验。
- **2.3-1.9 和 2026-10-08 以后的决定同步了没有**（`AGENT-018-prep.md` 第 8 节第 11～13 条已列）：契约第 3～47 行有「2026-10-08 补记」逐条写出被取代的部分，所以不会被误读；但 7.2 的主人键方案、`CA-CHAT-03` 的自动淘汰在契约正文里没删，只加了说明。命令：`grep -n "取代\|补记" docs/plan/cloud-agent-contract.md | head`。在哪验：本机现在就能验。判定：设计与契约**在**、八项**都有章节**；同步不完全（见 2.3-10 的语义对不上之处）。
- **2.3-1.10 「先写好再动手」的先后**：这一句是对 2026-10-06 开工顺序的要求，无法事后用命令验；`git log --diff-filter=A --format=%ad -- docs/plan/cloud-agent-contract.md` 看契约首次入库时间早于 `server/agent-service/main.mjs` 的首次入库时间即可（`git log --diff-filter=A --format=%ad -- server/agent-service/main.mjs`）。我没有跑（历史顺序，价值低）。在哪验：本机现在就能验（命令在此）。

---

#### 行 2.3-10：语义按 E～J 改好；受影响的契约同步；草稿「步骤 3」做完的标出处
原文预期（`cloud-agent-task.md` 完成条件第 10 条）：「语义按 E～J 改好；`c10-contract.md`、`c10a-contract.md` 等受影响的契约同步；`draft_cloud-node-and-agent.md`「步骤 3」里做完的部分标明出处，没做的（看画面、页面状态工具、未开放的工具、手机界面、按项目发上限的界面）留在那里写清差什么。」
行状态：部分有（E～J 在 `docs/semantics/` 里都找得到对应段落；契约和草稿那两句我只核了文件在，没有逐条核；语义里仍有一处旧机制没改）

E～J 是任务书「用户定的」里的六条：E 云端 Agent 从愿景变成承诺，F 模型（托管方 Key、服务端直连、加密分发），G 上限（开关、额度、用量），H 身份，I 界面范围，J 工具范围。命令是 `grep -n`，实跑日期 2026-10-13，在 `docs/semantics/` 下执行。

- **2.3-10.1 E 云端 Agent 从愿景变成承诺**：`product/agent.md`「运行位置」第 37 行（「云端 Agent：托管方提供的 Agent 服务，跑在云节点上…」）、第 38 行（发出任务后可以离开）、第 39 行（出错留痕）；`architecture.md` 第 16 行（角色表）、第 46 行、第 54 行（「已做：在线浏览器模式的 AI 栏使用…」）。命令：`grep -n "云端 Agent" product/agent.md architecture.md | cut -c1-120`。看哪一行：`architecture.md:54` 是「已做」。实跑：命中。在哪验：本机现在就能验。
- **2.3-10.2 F 模型：托管方 Key、服务端直连、加密分发**：`product/agent.md` 第 40 行；`mechanism/agent.md`「Key 与模型」（第 89 行）。命令：`grep -n "Key 与模型\|服务端直连" product/agent.md mechanism/agent.md`。实跑：命中。在哪验：本机现在就能验。
- **2.3-10.3 G 上限：开关、额度、用量按项目按成员**：`product/agent.md` 第 42 行（开关与失效）、第 43 行（上限）；`mechanism/agent.md`「闸与上限」（第 71 行）；`product/document-service.md` 第 64 行（项目对托管方服务的开关）。命令：`grep -n "上限\|开关" product/agent.md product/document-service.md | cut -c1-110`。在哪验：本机现在就能验。
- **2.3-10.4 H 身份**：`product/agent.md` 第 41 行（身份）；`mechanism/agent.md`「身份与失效」（第 65 行）；`product/document-service.md` 第 53 行；`glossary.md` 第 23 行（委托票据、对话委托）；`product/hosting.md` 第 26 行（云端 Agent 服务用服务身份加发起成员的身份证明接入）。命令：`grep -n "身份" product/agent.md product/hosting.md | cut -c1-110`。在哪验：本机现在就能验。
- **2.3-10.5 I 界面范围**：`product/platforms.md` 第 48 行（桌面版 AI 栏可选「云端」）、第 76 行（AI 栏接入方式是「云端」；手机窄屏仍占位）；`workflow/production.md` 第 35～41 行（连接状态点、输入队列、「AI 设置」置灰、云端有对话在跑时的提示、开关关了的提示）。命令：`grep -n "云端" product/platforms.md workflow/production.md | cut -c1-110 | head -20`。在哪验：本机现在就能验。
- **2.3-10.6 J 工具范围（与本机一致，节点做不了的明说「云端暂不支持」）**：`product/agent.md` 第 44 行及其下 7 条子项（操作界面的工具、`web_handoff`、素材采集、隔离、花钱的调用、示例句）；明细在契约第 9 节的工具表。命令：`grep -n "工具范围\|云端暂不支持" product/agent.md`。在哪验：本机现在就能验。
- **2.3-10.7 「运行位置」一节里设计第 26 行说的旧段落**（`three-versions-018-design.md` 第 26 行：「`product/agent.md` 运行位置仍有『同用户名』『主人独享』『一律停』等旧段落」）：**核实结果：现在 main 上的 `product/agent.md` 里已经没有这些字样**。命令：`grep -n "同用户名\|主人独享\|一律停\|只有主人" product/agent.md mechanism/agent.md architecture.md product/platforms.md product/hosting.md product/document-service.md glossary.md workflow/production.md` → 无命中。设计第 26 行这句已过时，可以删或改。**仍有一处旧机制**：`mechanism/agent.md` 第 79 行「对话归属的主人键：创建者按「项目 + 创建者」，限定进入的成员按用户名，自由进入的成员按「用户名 + 设备」。（7.2）」——与现行「按网站账号编号归属」（`product/agent.md` 第 53 行）冲突；同文件第 74 行「单次工具 60 秒」对看画面的工具也已不对（块八后由渲染服务的排队与重试定时限，块八报告「对任务书或语义的更正建议」第 5 条）。命令：`grep -n "主人键" docs/semantics/mechanism/agent.md`（命中第 79 行）。在哪验：本机现在就能验。
- **2.3-10.8 受影响的契约同步**（`c10-contract.md`、`c10a-contract.md` 等）：文件都在（`docs/plan/c10-contract.md`、`c10a-contract.md`）。契约 10.3 要求的改动（`c10a-contract.md` 第 2 节加一行「Agent 服务 = 同源的 `/agent/v1/`」；`c10-contract.md` 第 10 节置灰清单）我没有逐条对。命令：`grep -n "agent/v1" docs/plan/c10a-contract.md docs/plan/c10-contract.md`。我没跑。在哪验：本机现在就能验（命令在此）。
- **2.3-10.9 草稿「步骤 3」做完的标明出处**（`docs/plan/draft_cloud-node-and-agent.md`）：命令：`grep -n "步骤 3" docs/plan/draft_cloud-node-and-agent.md`。我没逐条核。草稿本身是临时文件，定稿后要删（用户记忆里有提醒）。在哪验：本机现在就能验（命令在此）。

---

#### 行 2.3-11：tsc、npm test、`npm run build` 全过；只跑这次改动覆盖的探针
原文预期（完成条件第 11 条）：「tsc、npm test、`npm run build` 全过；按 `verification.md`「按改动范围验证」只跑这次改动覆盖的探针，这次不改画面，不跑渲染附加项。」（`AGENT-018-prep.md`：「最终提交上重跑」。）
行状态：部分有（命令都明确；`tsc` 我跑了一遍；`npm test` 全量与 `npm run build` 按要求不跑，只记上次主会话的结果）

- **2.3-11.1 类型检查零错误**
  - 命令：`npx tsc -b --force`（PowerShell/Bash 相同，在工作区根目录；运行器里是 G0-1：`node scripts/acceptance/four-stage-acceptance.mjs --only G0-1`）
  - 看哪一行：退出码 0、无 `error TS`。
  - 实跑：2026-10-13，`npx tsc -b --force` 退出码 0，无任何输出（零错误），约 10 秒（机器上同时有别的子 Agent 在跑）。
  - 在哪验：本机现在就能验
- **2.3-11.2 全量测试零失败**
  - 命令：`〔PS〕npm test`（运行器 G0-2；判据：退出码 0，含「最终结果：零失败」，fail=0，skipped≤2）
  - 看哪一行：末行 `✓ npm test 最终结果：零失败`。
  - 实跑：未跑（按要求不跑全量）。上次主会话在进度文件 `docs/plan/three-versions-progress.md` 记的：块八合入后「全量测试 6032 条，通过 6029、失败 0、跳过 3」（第 35 行）；块六合入后「5939 条，通过 5936、失败 0、跳过 3」（第 38 行）。**跳过 3 与运行器 G0-2 的 `skipped ≤ 2` 对不上**，见产品问题 P3。
  - 约耗时：块八报告：74.8 秒（那台 20 核机）。
  - 在哪验：本机现在就能验（发版时在最终提交上跑）
- **2.3-11.3 `npm run build` 成功**
  - 命令：`npm run build`（运行器 G0-3：`tsc -b && vite build`；G0-4 另有在线构建 `vite build --mode online`）
  - 实跑：未跑（按要求不跑）。上次的结果进度文件没有逐次记；发版时必跑（release 合入条件第二条）。
  - 约耗时：几分钟（不确定，没有记录）。
  - 在哪验：本机现在就能验（发版时做）
- **2.3-11.4 只跑这次改动覆盖的探针（不改画面，不跑渲染附加项）**
  - 命令：`node scripts/acceptance/four-stage-acceptance.mjs --list`（选哪些）；这条是个选择规则，不是一个可跑的断言。**但 P0 说明运行器清单本身漏了新功能探针**，按它选会漏。
  - 在哪验：本机现在就能验

---

#### 行 2.3-12：合入 main、补丁/版本号、部署、release、模板、local.md
原文预期（完成条件第 12 条）：「合入 main，出下一个版本号的补丁；新节点上部署 Agent 服务（独立进程，改动前备份，按「规矩」等写入停止后才重启托管服务），在线页面换成同一版并核验；release 判过并推进；`server/hosted/deploy/` 的模板与 `hosting-migration.md` 补上 Agent 服务这一块；`docs/local.md` 记节点上多出的进程与目录。」（`AGENT-018-prep.md`：没有；「补丁」已被「完整安装包加兼容补丁」取代。）
行状态：没有（都是发版动作；只有「模板与迁移文档补上了 Agent 服务」一句现在就能查，已在）

- **2.3-12.1 合入 main**：要用户授权后做（`suggested_agent_behavior.md` 原则 4）。命令（部署清单 A5）：`git checkout main && git merge --no-ff <分支>` → 改版本号提交 → 推送。在哪验：发版时做（要部署到节点后验的前提）——用的五个值之一：**要部署到节点后验**。
- **2.3-12.2 出下一个版本号的补丁**：被「完整安装包加兼容补丁」取代（账号任务书「两仓库交付、部署与回退」第 4 条、设计第 380 行）；见行 2.1-16、2.1-17。版本号步骤（`AGENT-018-prep.md` 第 6.2 节）：`package.json` 的 `version` 与 `package-lock.json` 顶部和 `packages[""]` 两处 0.7.17 → 0.7.18，照 `073c8cca`；外壳版本要重判（壳动了，见 2.3-2.4）。在哪验：发版时做 → 值：**要部署到节点后验**（发版动作，非本机断言）。
- **2.3-12.3 新节点上部署 Agent 服务**：照部署清单 C5（`docs/plan/four-stage-deploy-checklist.md` 第 168 行起）：`node scripts/remote/docservice.mjs deploy-agent --dry-run`、`deploy-agent --no-start`、`keygen-agent`、托管服务环境加 `PROMPTCUT_AGENT_PUBLIC_URL`（要先等写入停止）、`set-key.mjs --mock`、`deploy-agent`、`status-agent`。注意 `AGENT-018-prep.md` 第 8 节第 1 条：C3 按旧的单进程托管服务写，现在线上是三个独立服务，命令要照 `server/hosted/deploy/account-v2-install-plan.mjs` 重写；第 3 条：Agent 端口缺省 8790，设计裁定说要配 8791（我核了代码：`server/agent-service/main.mjs:109`、`deploy.mjs:33`、`nginx-location-agent.conf:4` 仍是 8790）。在哪验：要部署到节点后验。
- **2.3-12.4 在线页面换成同一版并核验**：部署清单 C2；运行器 S1-r2（三个源主脚本相同、`__PC_CODE_VERSION__` 与 `<SHA>` 一致、无头打开错误 0、失败请求 0）。在哪验：要部署到节点后验。
- **2.3-12.5 release 判过并推进**：三条合入条件（基线全绿、`npm run build` 成功、动了桌面壳所以 `desktop/` 的发版构建也要成功）；然后 `git checkout release && git merge --ff-only <发版提交>` 并推送；快进不了按 `release-fallback.md` 另建 `release_0.7.18` 分支。现在 `release` 在 `073c8cca`，是 main 的祖先，能快进（`git merge-base --is-ancestor release main`，我跑了，退出码 0）。在哪验：要部署到节点后验（发版时做）。
- **2.3-12.6 `server/hosted/deploy/` 的模板与 `hosting-migration.md` 补上 Agent 服务**
  - 证据：`server/hosted/deploy/pm2-promptcut-agent.config.cjs`、`nginx-location-agent.conf` 在；`docs/plan/hosting-migration.md` 第 159 行起「2b. Agent 服务的迁移与重建」；`server/test/cloud-agent-wiring.test.mjs` 的「CA-DEPLOY-01 Agent 服务的部署脚本：没有没填的占位符、不含秘密、参数不对拒绝」。
  - 命令：`〔PS〕npm test -- server/test/cloud-agent-wiring.test.mjs`；`grep -n "2b. Agent" docs/plan/hosting-migration.md`；`ls server/hosted/deploy | grep agent`。
  - 看哪一行：`✔ CA-DEPLOY-01 …`。
  - 实跑：2026-10-13，`cloud-agent-wiring.test.mjs` 7 条全过，1 秒，退出码 0（含 `CA-DEPLOY-01`）。
  - 在哪验：本机现在就能验
  - 说明：模板里端口仍是 8790（见 2.3-12.3）。`account-v2-install-plan.mjs` 里没有 Agent（`grep -c agent` 为 0），三个新服务的安装办法里没有 Agent 这一块。
- **2.3-12.7 `docs/local.md` 记节点上多出的进程与目录**：部署清单 F 节清单。`docs/local.md` 不入库、含密钥，我不读。在哪验：要部署到节点后验（部署后记）。

---

#### 行 2.3-13：写报告，含〔裁〕清单；播报后停下
原文预期（完成条件第 13 条）：「写报告，含〔裁〕清单；播报后停下，列出：每项结果、没过或没做的项与原因、补丁信息、要用户做的事。」（`AGENT-018-prep.md`：没有。）
行状态：没有（发版收尾动作；这次的报告就是 `ACCEPT-018-map.md` 加最后的总报告）

- **2.3-13.1 报告含每项结果、没过/没做的项与原因**：本组段落与 `ACCEPT-018-map.md` 汇总；发版时要在最终提交上重新给每行结论（账号任务书「逐项验收」表头：旧记录不能顶替）。在哪验：要部署到节点后验（发版时做）。
- **2.3-13.2 〔裁〕清单**：`docs/reports/AGENT-*.md` 各块报告里的〔裁〕（例如 `AGENT-v18-queue.md`「裁定〔裁〕」12 条，其中第 1 条二级已播报、第 2 条「三次重试是一共试四次」待用户过目）要汇进总报告。命令：`grep -c "〔裁" docs/reports/AGENT-v18-*.md`。在哪验：发版时做 → **要部署到节点后验**。
- **2.3-13.3 补丁信息**：路径、大小、SHA-256、来源提交（账号任务书第 16、17 行）：`(Get-Item desktop\release\PromptCut-patch-0.7.18.zip).Length`（`build-release.mjs` 实际产物是 `.zip`，部署清单 A4 写的是 `.exe`，不一致，以脚本为准）、`Get-FileHash -Algorithm SHA256 …`。在哪验：要安装包。
- **2.3-13.4 播报后停下，列出要用户做的事**：流程要求，无命令。

---

#### 行 2.3-8：模型 Key 与真实模型三遍
原文预期（完成条件第 8 条）：「模型 Key 按 F 的加密分发办法送到节点：把节点的机器识别码给用户，用户用 `make-api-share.bat` 生成密文交回，会话导入。本机演练与界面版体验探针现在就用这台 PC 已配好的 API 直连跑真实模型，不必等到最后；节点上的那一遍在部署 Agent 服务之后跑。真实模型下把第 6 条、「用户体验验收」和示例句「为我快速创建一个视频告诉我软件都可以做什么。」各走一遍。」（`AGENT-018-prep.md`：密文在节点上验过解密和两个模型各一次真实调用，没导入任何服务；真实模型的三遍没有。）
行状态：部分有（加密分发的机制本身有可跑的单测；送到节点、导入、真实模型三遍都要节点和真实模型，不跑）

- **2.3-8.1 加密分发机制本身：节点报机器识别码 → 用户电脑加密成只有这台机器解得开的密文 → 节点导入并落盘加密；密文给别的机器、被截断、被改、过期都明确拒绝；输出和日志里没有 Key**
  - 证据：`server/test/cloud-agent-keys.test.mjs`（CAU-KEY-01～09，全用假 Key 与临时目录，不读真实 Key）。
  - 命令：`〔PS〕npm test -- server/test/cloud-agent-keys.test.mjs`
  - 看哪一行：`ℹ pass`、`最终结果：零失败`；用例名里 `CAU-KEY-03 整条流程`、`CAU-KEY-04 给别的机器的密文被拒`、`CAU-KEY-05 …各给明确的报错，什么都不写`。
  - 实跑：2026-10-13，`server/test/cloud-agent-keys.test.mjs`：10 条全过（`ℹ tests 10 / pass 10 / fail 0`），1 秒，退出码 0。
  - 在哪验：本机现在就能验
- **2.3-8.2 节点报出自己的机器识别码**（要用跑 Agent 服务的那个系统用户在那台节点上取）
  - 命令（部署清单 C5 第 7 步 1）：`ssh "$PROMPTCUT_REMOTE" 'cd /opt/promptcut-render/current && node -e "import(\"./server/runners/machine-id.mjs\").then(m=>console.log(m.machineCode()))"'`；写进报告只写首组（`redactMachineCode`）。
  - 在哪验：要部署到节点后验（本机的 `machineCode()` 单测已在 CAU-KEY-01）
- **2.3-8.3 用户用 `make-api-share.bat` 生成密文交回**
  - 这是用户在自己电脑上做的一步（明文只经用户的手，会话不要明文）。给用户的原话在部署清单 C5 第 7 步 2。在哪验：要部署到节点后验（用户动作）。
- **2.3-8.4 会话把密文送到节点导入、核对末四位并调通**
  - 命令：`node scripts/remote/docservice.mjs import-key-agent`（走 ssh 标准输入）；节点上对应 `PROMPTCUT_AGENT_DATA=/var/lib/promptcut/agent node server/agent-service/import-key.mjs --file <密文文件>`；导入后 `node scripts/remote/docservice.mjs status-agent` 看「已配模型」；发一条最短云端对话（测试项目，回复 OK）看模型调通、`admin.mjs usage --project <测试项目>` 多一条。密文在节点上的现有位置：`/root/promptcut-pending/agent-model-key.blob`（`three-versions-brief.md` 第 5 节；导入成功、核对过末四位和能调通后才删）。
  - 本机的对应单测：CAU-KEY-09（远程子命令计划：`--dry-run`、脚本里没有 Key、密文只经 ssh 标准输入、写完删临时文件）已在 2.3-8.1 的文件里。
  - 在哪验：要部署到节点后验
- **2.3-8.5 本机演练与界面版体验探针用这台 PC 配好的 API 直连跑真实模型**
  - 命令（先看探针头）：`node scripts/probes/cloud-agent-ux-ui-probe.mjs …`（界面版体验探针；模型换成真实提供方）、`scripts/probes/cloud-agent-first-video-probe.mjs`（示例句）。
  - 说明：本次任务禁止调用真实模型，我没跑，也没读这台 PC 的模型配置。运行器里对应 S4-r4/r5/r6 的第①遍。在哪验：要部署到节点后验（实际是要真实模型；本机上的第①遍同样要真实模型）。
- **2.3-8.6 真实模型：第 6 条端到端（改文案、挪片段、调卡片参数；署名；撤销；两成员互不串）**
  - 命令：运行器 `S4-r4`（`node scripts/acceptance/four-stage-acceptance.mjs --list --level network` 里有它的说明；部署清单 D1 表「C5 导入 Key 之后｜C8、C8a」一行：同 C6 一行，模型是真实提供方，用量记录里查得到）。
  - 在哪验：要部署到节点后验
- **2.3-8.7 真实模型：「用户体验验收」六条（发任务后关掉软件照常运转）**
  - 命令：运行器 `S4-r5`（部署清单 D1「C8b、U1～U6」）。
  - 在哪验：要部署到节点后验
- **2.3-8.8 真实模型：示例句「为我快速创建一个视频告诉我软件都可以做什么。」**
  - 命令：运行器 `S4-r6`（部署清单 D1「C8c」：云端 Agent 对放云端的测试项目发这一句，留对话过程、工具调用清单、成片或项目的样子与用量）。
  - 在哪验：要部署到节点后验

---

#### 行 2.3-9：节点资源
原文预期（完成条件第 9 条）：「节点资源：Agent 服务有并发与内存上限；满载时同机文档服务的响应时间与素材下载速度的前后对比，写明数字。」（`AGENT-018-prep.md`：没有（部署后做）。）
行状态：部分有（上限本身在代码和部署模板里，有单测；「满载前后对比的数字」只能在节点上测）

- **2.3-9.1 Agent 服务有并发上限**（全节点 6 轮、每项目 3、每成员 2）
  - 证据：`server/test/cloud-agent-runs.test.mjs` 的「CA-GATE-04 / CA-GATE-05 闸：三个并发上限各自生效、结束后释放；limits.json 写坏保留上一份」。
  - 命令：`〔PS〕npm test -- server/test/cloud-agent-runs.test.mjs`（整个文件含多个 240 秒量级的用例，已知机器忙时偶发失败，失败先单独重跑）
  - 看哪一行：`✔ CA-GATE-04 / CA-GATE-05 …`。
  - 实跑：2026-10-13，`server/test/cloud-agent-runs.test.mjs`：29 条全过，27 秒，退出码 0；其中 `✔ CA-GATE-04 / CA-GATE-05 闸…`。
  - 在哪验：本机现在就能验
- **2.3-9.2 Agent 服务有内存上限**（V8 老生代 1536 MiB，常驻超 2 GB 由 PM2 重启）
  - 证据：`server/test/cloud-agent-wiring.test.mjs` 的「CA-DEPLOY-01」断言部署模板含 `node_args: '--max-old-space-size=1536'`、`max_memory_restart: '2G'`、`kill_timeout: 8000`。
  - 命令：`〔PS〕npm test -- server/test/cloud-agent-wiring.test.mjs`
  - 实跑：2026-10-13，同 2.3-12.6（`cloud-agent-wiring.test.mjs` 7 条全过，含 CA-DEPLOY-01 的 `max-old-space-size=1536`、`max_memory_restart: '2G'` 断言）。
  - 在哪验：本机现在就能验（模板内容）；「上限在节点上真的生效」要部署到节点后验。
- **2.3-9.3 满载时同机文档服务的响应时间与素材下载速度，前后对比，写明数字**
  - 命令（部署清单 D1 表「C5 之后（模拟模型）｜C9」，与 C4 之后「R23 第 7、8 点」同一量法）：空闲与满载各量一次文档服务 `/healthz` 的往返与固定素材的下载（量法写在 D1 表），Agent 满载用模拟模型的重脚本发满节点级并发（6 轮）；上限生效的判据：`worker.exit` 的 reason `oom`、`render.degraded`（渲染一侧）、Agent 满了回 `busy`；数字写进总报告。
  - 本机预演：契约第 11 节提到的探针 `CAP-RES-01`（本机用隔离的托管组合先测一遍方法）**在仓库里没有**（`grep -rln "CAP-RES" scripts server` 只在文档里出现），所以本机没有预演脚本。
  - 在哪验：要部署到节点后验

---

#### 行 2.1-15：最终产品交互验收
原文预期（账号任务书「逐项验收」第 180 行）：环境「最终提交，隔离角色；两仓库适用基线、在线/声音/渲染/Agent/账号等」；「逐项结论，首次失败后复跑通过仍报告不稳定；耗时、配置记入 release-timings；无笔记本/限四核闸门」。
行状态：部分有（运行器能列、能跑，但**新功能没有进它的清单**，见产品问题 P0；清单自己的 `--check-coverage` 退出码 1）

我真跑了部署清单 A1 要求的三条只读命令，在 `C:\Users\admin\Documents\PromptCut\.worktrees\v18-accept`，2026-10-13：

- **2.1-15.1 运行器能列出全部项**
  - 命令：`node scripts/acceptance/four-stage-acceptance.mjs --list`（另 `--list --level network` 单列真实网络）
  - 实跑：退出码 0。输出末行「共 120 项：本地验证 104，真实网络验证 16」；其中可选项（`optional: true`）13 个，全是 `X-` 开头的补充项（`X-c10-catalog`、`X-c10-cost`、`X-c10a-online`、`X-online-join`、`X-c10a-demo-local`、`X-queue-mode`、`X-procp-roundtrip`、`X-card-sync`、`X-m8-scale-k1`、`X-m8-scale-i1`、`X-small-tier`、`X-lowmem-export-compare`、`X-render-host-local`），缺省不跑，要 `--include-optional` 或 `--only` 点名；缺省本地集合因此是 91 项（其中有命令自动跑的 69 项，其余是人工项）。`--list --level network`：59 行，16 项。
  - 在哪验：本机现在就能验
- **2.1-15.2 对应表**
  - 命令：`node scripts/acceptance/four-stage-acceptance.mjs --matrix`
  - 实跑：退出码 0，60 行。只有两份任务书的对应表（任务书二分三段）：任务书一（`sound-online-render-task.md`）R1～R25、任务书二（`cloud-agent-task.md`）C1～C13 + U1～U6 + J1、K1、C4a～c、C8a～c；**没有账号任务书「逐项验收」的任何一行，也没有 RS18**。
  - 在哪验：本机现在就能验
- **2.1-15.3 清单覆盖检查**
  - 命令：`node scripts/acceptance/four-stage-acceptance.mjs --check-coverage`
  - 实跑：**退出码 1**。输出「scripts/probes 下 242 个文件；清单没登记也没写排除原因（56）」，后面列 56 个文件名（含 `account-*`、`asset-*isolation*`、`cloud-agent-consent-user-path-probe`、`cloud-queue-user-pages-probe`、`cloud-tools-*`、`hosted-render-queue-probe`、`password-order-probe`、`project-member-controls-probe`、`agent-run-scope-proof` 等，完整输出保存在我的草稿目录，主会话要的话可再跑）。
  - 在哪验：本机现在就能验
- **2.1-15.4 新功能验收项 → 运行器清单里有没有对应项**（账号任务书「逐项验收」19 行 + 本次其他新功能；「现有可跑证据」是我知道的探针/测试名，不是我核过的结论，核过的在各自负责的行里）

| 新功能验收项 | 本机上现有的探针/测试（未必已核） | 运行器清单里的对应项 |
|---|---|---|
| 云端登录与限次数（2.1-1） | `account-user-pages-probe`、`account-public-user-pages-probe`、`account-dual-user-path-probe` | **没有** |
| 项目权限与两张列表（2.1-2） | `account-dual-user-path-probe`、`project-member-controls-probe` | **没有** |
| Agent 共有/私有及发送者（2.1-3） | `account-conversation-controls-probe` | **没有** |
| 已读消息撤回例外（2.1-4） | `agent-run-scope-proof`、`account-real-runner-probe` | **没有** |
| 设备退出与延迟撤回/改密退出（2.1-5） | `account-password-user-path-probe`、`password-order-probe` | **没有** |
| 本地项目回归（2.1-6） | 全量测试里的局域网用例 | 只有间接的 `G0-2`（全量）和旧项 `P-tiers`/`P-cross-machine-proc` 等；**没有专项** |
| 正常云端文件重开（2.1-7） | 无专用探针（rest 之外的行补了 `accept-018-files-account-reopen`） | **没有** |
| 过期云端项目转本地、非过期与坏文件（2.1-8、2.1-9） | 代码没做 | **没有**（也无探针） |
| 缺失视觉/音频素材（2.1-12） | 在分支上，main 没有 | **没有** |
| 内部核对口与凭证（2.1-13） | `account-hosted-wiring-probe` 等 | **没有** |
| 备份恢复（2.1-14） | 归档证据 `docs/archive/three-versions-production-restore-2026-10-09.md` | **没有**（部署前在当时数据上重做） |
| 素材按项目隔离（块六） | `asset-account-isolation-probe`、`asset-project-isolation-probe` | **没有**（`P-asset-path`、`P-bake-asset` 是旧的“Agent 读素材走素材服务”，不是账号项目隔离） |
| 云端 Agent 新工具（块七：P2 语音识别、P3 运动、P4 主体、W2 反向通道） | `cloud-tools-p2-stt-probe`、`cloud-tools-p3-probe`、`cloud-tools-p4-subject-probe`、`cloud-tools-w2-probe` | **没有**（`S4-m5` 是人工逐工具核对，写的是旧范围） |
| 云端排队（块八）+ 排队位置 | `hosted-render-queue-probe`、`cloud-queue-user-pages-probe` | **没有**（`S3-1` 是旧的渲染服务整套演练） |
| 首次使用云端 Agent 告知托管方可读 | `cloud-agent-consent-user-path-probe` | **没有** |
| 同项目同创建者最多 50 个对话与删除入口（RS18-chat） | 满额拦新建的代码在 main；删除入口没做 | **没有**（`S4-3`/旧 `CA-CHAT-03` 的自动淘汰断言已被取代） |
| 本地取帧优先（RS18-local） | 代码没做 | **没有** |
| 单测层面 | 全量 `npm test` | 有，`G0-2`（问题见 P3） |

  结论：**新功能验收项没进运行器清单——成立**。
- **2.1-15.5 「首次失败后复跑通过仍报告不稳定」**：运行器的 `--flaky-rerun 1`（判 `flaky`，退出码 1）。命令：`node scripts/acceptance/four-stage-acceptance.mjs --out work/four-stage/final/<时间戳> --flaky-rerun 1 --release-timings "0.7.18"`（部署清单 A1）。我没跑（整套要几十分钟到数小时，且 P0 先要补清单）。运行器的单测：`server/test/four-stage-acceptance*.test.mjs`（我没跑）。在哪验：本机现在就能验（命令在此；补完清单后在最终提交上跑）。
- **2.1-15.6 耗时、配置记入 release-timings；没有笔记本/限四核闸门**：`--release-timings "0.7.18"` 生成 `release-timings-section.md`，贴进 `docs/reports/release-timings.md`（里面现有「0.7.18 候选」一节是四段任务留下的，发版时换成最终提交的）。在哪验：本机现在就能验（发版时做）。

---

#### 行 2.1-16：完整安装包
原文预期（账号任务书第 181 行）：环境「最终版本提交，隔离安装位置/验证设备」；「版本、来源 SHA、文件哈希；安装后启动、账号路径、实际文件关联双击及旧文件转换；不覆盖用户运行副本」。
行状态：没有

- **2.1-16.1 出完整安装包（版本、来源 SHA、文件哈希）**
  - 命令：先 `git rev-parse HEAD` 记来源提交；然后在 `desktop/` 下 `npm run release -- --from-head`（源码取自 HEAD 的临时 worktree；不加 `--patch-only`，完整安装包与兼容补丁一起出；账号任务书「两仓库交付、部署与回退」第 4 条、设计第 380 行）；产物在 `desktop/release/`：`PromptCut-<版本>-setup.exe`（约 1 GB）、`PromptCut-patch-<版本>.zip`、`manifest-<版本>.json`；取大小和哈希：`(Get-Item <文件>).Length`、`Get-FileHash -Algorithm SHA256 <文件>`。
  - 在哪验：要安装包。约耗时：Rust 编译 + 打包，几十分钟（无记录，不执行）。
- **2.1-16.2 安装后启动**：在**隔离的安装位置**装（不覆盖用户在用的那份；`verification.md`「会造成真实损失的操作」）。冒烟脚本：`cd desktop; node scripts/smoke-all.mjs <exe 绝对路径>`（跑 `smoke-boot` 与 `smoke-shutdown`）。在哪验：要安装包。
- **2.1-16.3 账号路径**（登录、新建云端项目、加入）：用安装后的软件走账号任务书各行；探针是壳上的账号探针（`desktop/src-tauri/src/lib.rs` 的 `.account-probe` 标识，端口 6340～6347、6500）。在哪验：要安装包。
- **2.1-16.4 实际文件关联：双击 `.proc`/`.procp` 打开**：在安装后的系统里双击测试文件，看软件打开并进对应项目。在哪验：要安装包。
- **2.1-16.5 旧文件转换**（过期云端项目转本地）：代码没做（行 2.1-8），也要等清理后的真实旧文件（行 2.1-19）。在哪验：要等某一块合入（块四「旧文件转本地」）；且要安装包。
- **2.1-16.6 不覆盖用户运行副本**：安装前后对比用户数据目录与已装副本的哈希（只读）；装在新目录。在哪验：要安装包。
- **2.1-16.7 依赖大小提醒**：依赖比 0.7.17 多了 `sucrase`，补丁会带整份 `node_modules`（部署清单 A4 记的量级约 196 MB），要提前告诉用户。在哪验：要安装包。

---

#### 行 2.1-17：兼容补丁
原文预期（账号任务书第 182 行）：环境「最终提交，当前声明最低壳 0.2.0 与现用壳 0.2.7 的隔离副本」；「补丁清单/哈希/目标版本/壳要求明确；升级启动与必要账号/文件功能通过，回退验证；最低声明若需调整须说明证据」。
行状态：没有

- **2.1-17.1 补丁清单、哈希、目标版本、壳要求明确**：`desktop/release/manifest-0.7.18.json`（`make-patch.mjs` 写）；补丁 `PromptCut-patch-0.7.18.zip`；`desktop/scripts/make-patch.mjs` 顶部 `MIN_SHELL_VERSION = "0.2.0"`（第 43 行）。命令：`cd desktop; npm run release -- --from-head --patch-only` 或随 2.1-16.1 一起出；读清单：`Get-Content desktop\release\manifest-0.7.18.json`；哈希同上。在哪验：要安装包。
- **2.1-17.2 在最低声明壳 0.2.0 的隔离副本上升级、启动、必要账号/文件功能**：做一份 0.2.0 外壳的隔离安装副本（不碰用户那份），装补丁，启动，走一遍账号登录与文件关联。在哪验：要安装包。
- **2.1-17.3 在现用壳 0.2.7 的隔离副本上同样验**：同上，换 0.2.7 副本。在哪验：要安装包。
- **2.1-17.4 回退验证**：补丁装完后回退到上一个版本，再启动。补丁不在有 Agent 会话在跑的安装目录上装（`verification.md`「有 Agent 会话在跑时不装补丁」，会整棵覆盖运行时副本）。在哪验：要安装包。
- **2.1-17.5 最低声明（`MIN_SHELL_VERSION`）要不要抬**：看 17.2 的证据。`AGENT-018-prep.md` 第 6.2 节：从 `release` 到 main，壳新增了 `account_vault.rs`（桌面版保存可撤销的恢复凭证），要判「新的 Node 这一半放到旧壳 0.2.7 上能不能照常跑」——读 `src/account/` 怎么调它（能降级成“登录后不记住”就是第二行，外壳末位加一成 0.2.8；Node 硬依赖就是第四行，两个中间位一起加，只能出完整安装包）。我没读，只给出核对办法。命令：`git diff --stat release..main -- desktop/src-tauri/`（见 2.3-2.4）；`grep -rn "account_vault\|__TAURI__" src/account | head`。在哪验：要安装包。

---

#### 行 2.1-18：真实网络环境验收
原文预期（账号任务书第 183 行）：环境「新节点、测试账号/项目；成对 PromptCut/VisuHive 版本」；「验收清单网络 16 项及账号任务点名体验；证书、反代、重连、同提交服务、实际限权/退出；真实结果而非占位待人工」。
行状态：没有（运行器的 16 项网络清单本身能列出来，已列；一项也没有执行，要在节点上）

- **2.1-18.1 运行器的网络 16 项**
  - 命令：`node scripts/acceptance/four-stage-acceptance.mjs --list --level network`（只读，我跑了，59 行，16 项）；`node scripts/acceptance/four-stage-acceptance.mjs --level network --out work/four-stage/node/<时间戳>`（生成待执行条目，**不等于节点测试已经执行**；账号任务书第 188 行）。16 项：`S1-r2`、`S1-r3`、`S2-r1`、`S3-r1`、`S3-r2`、`S3-r3`、`S3-r4`、`S3-r5`、`S3-r6`、`S3-r7`、`S4-r1`、`S4-r2`、`S4-r4`、`S4-r5`、`S4-r6`、`S4-r7`。其中 `S3-r4`（越权探测卡读不到）和 `S4-r1` 的隔离是核心项，不过就停掉对应服务。照部署清单 D0 逐条做，D1 表写了每项的探针和命令。
  - 实跑：列出来了（见上）；执行：未做。在哪验：要部署到节点后验
- **2.1-18.2 证书、反代**：部署清单 D0 的 `S2-r1`：`curl -sI https://<域名>/editor`；`openssl s_client -connect <域名>:443 -servername <域名> </dev/null 2>/dev/null | openssl x509 -noout -dates`（主站与 s1、s2 各一次）。要部署到节点后验。
- **2.1-18.3 延迟与断线重连**（清单外）：无头 Chrome 以成员身份进测试房间，记加入用时与一次编辑到另一成员看到的用时；在**服务器侧**断那条 TCP（不动宿主机网络，`constraints.md`），看页面顶栏先显示断开、之后自动重连、改动不丢。要部署到节点后验。
- **2.1-18.4 同提交服务**：在线页面、渲染服务、Agent 服务的 `codeVersion` 并排一致；`status-agent`、`status-render` 与页面的 `__PC_CODE_VERSION__` 对 `<SHA>`（部署清单「先决条件」一节）。要部署到节点后验。
- **2.1-18.5 实际限权/退出**（账号任务点名）：两个测试账号：踢人对全设备生效、切私有立刻撤、改密退出与重连、旧票据和内部接口被拒、关掉发起方软件后任务继续并且预渲染入库（`AGENT-018-prep.md` 第 6.5 节第 3 点）。这些没有在运行器的 16 项里（P0），要用账号探针对真实地址跑（`account-public-user-pages-probe` 等，改 `--site`）。要部署到节点后验。
- **2.1-18.6 真实结果而非占位待人工**：运行器里网络项都是「无命令、在节点上做」（`netNoCmd = 16`），生成的条目是占位；通过要靠人在节点上做完后填证据路径。要部署到节点后验。

---

#### 行 2.1-10：暂时离线改动与冲突
原文预期（账号任务书第 175 行）：「提示落后并询问是否发送；可视化选择冲突；不静默覆盖；操作幂等且离线内容不丢」。
行状态：没有（对 0.7.18 不适用）
- **2.1-10.1 全部子断言**（提示落后并问是否发送；可视化选择冲突；不静默覆盖；幂等且离线内容不丢）：对 0.7.18 不适用。依据：账号任务书第 186 行「暂时离线改动与冲突、保存与修改状态检查归 0.7.19」，以及「各版本必须做」表：「保存状态记录、暂时离线改动确认与可视化冲突处理（0.7.19）」。命令：`grep -n "暂时离线改动与冲突" docs/plan/account-binding-task.md`。在哪验：对 0.7.18 不适用。

#### 行 2.1-11：保存与修改状态检查
原文预期（第 176 行）：「暂停前台编辑、等待本机写完、保存哈希+时间+版本/基准；远端固定快照后改动可再合入；失败可恢复编辑且保留旧保存」。
行状态：没有（对 0.7.18 不适用）
- **2.1-11.1 全部子断言**：对 0.7.18 不适用。依据同上（第 186 行归 0.7.19）。注意：账号任务书「行为、数据与契约」第 4、5 条（保存哈希只是状态标识、保存时的“冻结”指固定一份确定快照）是 0.7.19 的设计，不要在 0.7.18 的验收里当必做。命令：同上。在哪验：对 0.7.18 不适用。

#### 行 2.1-20：第四阶段剩余工具的验收，照 `cloud-agent-task.md` 完成条件，归 0.7.18
原文预期（账号任务书第 186 行）：「第四阶段剩余工具的验收照 `cloud-agent-task.md` 的完成条件，归 0.7.18。」
行状态：部分有（它不是一行独立断言，是指向 2.3 的 13 条；汇总如下）
- **2.1-20.1 汇总指向 2.3**：2.3-1～2.3-13（`cloud-agent-task.md` 完成条件 13 条）。本组（rest）负责的几条：2.3-1（设计与契约，有）、2.3-2（载入缝，部分；P1）、2.3-8（模型 Key 与真实模型，部分）、2.3-9（节点资源，部分）、2.3-10（语义，部分）、2.3-11（基线，部分）、2.3-12（发版部署，没有）、2.3-13（报告，没有）。其余 2.3-3～2.3-7 由别的组负责，汇总时以他们的行为准。「剩余工具」本身（23 个待定工具在 main 上仍是 23 个，块七 P2/P3/P4/W2 已合入一部分）的逐工具验收在工具拆包每包的证据里（`docs/plan/cloud-agent-tools-implementation.md`「每包必须提交的证据」），不在本行展开。在哪验：本机现在就能验（汇总，不是新断言）。

---

#### 探针实跑：hosted-render-queue-probe（RS18-queue）
命令（我实跑的是缩短版，`--idle-ms 20000` 验「满了配置的时长才让位」，不是生产的五分钟）：

- PowerShell：`cd C:\Users\admin\Documents\PromptCut\.worktrees\v18-accept; $env:PROMPTCUT_NO_PORT_FILE='1'; node scripts/probes/hosted-render-queue-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568 --idle-ms 20000`
- Bash：`cd /c/Users/admin/Documents/PromptCut/.worktrees/v18-accept && PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/hosted-render-queue-probe.mjs --base-port 28560 --doc-port 28567 --asset-port 28568 --idle-ms 20000`

端口只用了 28560～28568（常驻 28560～28562、隔离 28563～28565、状态口 28566、文档 28567、素材 28568），都在我的段里；跑完 `Get-NetTCPConnection -State Listen` 查 28560～28569 无残留监听；探针前后各查一次可见窗口，都是空。

实跑（2026-10-13，约 02:12～02:21 UTC，整趟约 8 分 40 秒）：**退出码 0，14 条检查全过，`"fails":[]`**。最后一行 JSON：`"pass":14`，`"realIdle":false`（`--idle-ms` 缩短版），`lookStatus` 里 `failed:1`（那是 Q7 故意让它到头的一条）、`retried:3`、`over5min:0`。关键行：

| 检查 | 结果 | 探针输出里的数 |
|---|---|---|
| Q1a 甲要一帧 | 过 | 14.7 秒，中心像素 `[255,0,0]`，由隔离工作进程出 1 帧 |
| Q1b 甲装着时乙要一帧不被拒，排着 | 过 | 排着 1 个，原因 `iso-other-project`，被拒 0、失败 0，调用方未收到错误 |
| Q1b 乙等着期间装着的始终只有甲 | 过 | 125 拍，同时装两个项目的拍数 0 |
| Q1c 乙排着时甲再要一帧照常出 | 过 | 1.18 秒，`[255,0,0]`，乙还排着 |
| Q1d 撤回乙的另一条请求 | 过 | 排着 2 → 1，撤回 1 |
| Q3 让位要满时长 | 过 | 从甲最后一次出图到让位 34.1 秒（`idleMs` 20000，加出完图后保持的 15 秒），原因 `idle`；乙已等 39.3 秒、丙的任务已等 46.2 秒，都没让它提前 |
| Q2 看画面优先于预渲染任务 | 过 | 甲让位后下一轮装的是乙（`startsAfterJia:["乙"]`），丙的预渲染计划比乙的看画面请求早 7.0 秒进来 |
| Q4 轮到了照常出图 | 过 | 乙的那一帧 63.1 秒（排队 60.2 秒），`[0,255,0]`，隔离工作进程出，重试 0 次、失败 0 |
| Q5a 强行结束整棵树后盘上留着排着的请求 | 过 | 1 → 1，项目是甲的，调用方还在等 |
| Q5b 再起接回，内存吃紧时排着 | 过 | `restored:1,results:3`，背压暂停原因 `memory`，`blocked.backpressure:1`，期间 `isoStarts:0` |
| Q5c 正常收尾后再起 | 过 | 盘上 1 条，接回 1 条，先为甲起隔离工作进程，41.3 秒后 `[255,0,0]`，`restored:true`，`reconnects:1`，`failedTrips:4` |
| Q6 预渲染任务不丢 | 过 | 丙的计划等了 168.5 秒，让位后 35.4 秒起隔离工作进程，1 个任务做完、失败 0 |
| Q7 重试到头 | 过 | 试 1 + 3 次（三次都是 `timeout`），收到原话「这次没看成：渲染服务在时限内没有出图。先按项目内容继续，稍后可以再看一次。」，29.2 秒 |
| Q8 收尾 | 过 | 进程都没了，`busyPorts:[]` |

说明：这次探针比我预想的久（约 8 分 40 秒，超过任务书说的 6 分钟上限）：机器上同时有别的子 Agent 在跑，中途内存一度只剩约 190 MB，渲染服务的背压暂停了大约 1 分钟（日志 `render.backpressure`，随后 `backpressure-clear`），Q7 的隔离工作进程冷启动也慢。结果没有受影响，14 条都过；下次主会话在较闲的机器上跑会短一些。**生产的五分钟真等版本（不加 `--idle-ms`）我没有跑**，命令和约耗时见 RS18-queue.10。


#### 补记（实跑结果）
单文件实跑一览（2026-10-13，`〔PS〕npm test -- <文件>`，都在 v18-accept 工作区、带两个账号环境变量；零失败时末行 `✓ npm test 最终结果：零失败`）：

| 文件 | 退出码 | 结果 | 耗时 |
|---|---|---|---|
| `server/test/accept-018-rest-ssr-seam.test.mjs`（新） | 0 | tests 5 / pass 3 / todo 2 / fail 0 | 约 1 秒 |
| `server/test/accept-018-rest-queue-account-look.test.mjs`（新） | 0 | tests 2 / pass 1 / todo 1 / fail 0 | 1 秒 |
| `server/test/cloud-agent-service.test.mjs` | 0 | 18 / 18 | 11 秒 |
| `server/test/cloud-agent-runs.test.mjs` | 0 | 29 / 29 | 27 秒 |
| `server/test/cloud-agent-keys.test.mjs` | 0 | 10 / 10 | 1 秒 |
| `server/test/cloud-agent-wiring.test.mjs` | 0 | 7 / 7 | 1 秒 |
| `server/test/cloud-agent-look.test.mjs` | 0 | 3 / 3 | 8 秒 |
| `server/test/hosted-render-queue.test.mjs` | 0 | 9 / 9 | 7 秒 |
| `server/test/hosted-render-look.test.mjs` | 0 | 7 / 7 | 8 秒 |
| `server/test/hosted-render-isolation.test.mjs` | 0 | 7 / 7 | 1 秒 |
| `server/test/hosted-render-memory.test.mjs` | 0 | 10 / 10 | 2 秒 |
| `server/test/hosted-render-capacity.test.mjs` | 0 | 8 / 8 | 6 秒 |
| `server/test/hosted-render-usercards.test.mjs` | 0 | 10 / 10 | 1 秒 |
| `npx tsc -b --force` | 0 | 无输出 | 约 10 秒 |

这些都是第一遍就过，没有失败重跑的情况。todo 的失败不让 `npm test` 变红：`npm test -- <文件>` 实测末行仍是「零失败」，退出码 0。

运行器三条只读命令（`four-stage-acceptance.mjs`）：`--list` 退出码 0、400 行；`--list --level network` 退出码 0、59 行；`--matrix` 退出码 0、60 行；`--check-coverage` **退出码 1**（见 P0）。

全量测试、`npm run build`、`desktop/` 的发版构建、安装包、补丁、任何 ssh 或节点操作、任何真实模型调用：都没有做。`docs/local.md` 没有读。


