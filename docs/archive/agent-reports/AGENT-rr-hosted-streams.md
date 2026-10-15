# 子 Agent 报告：渲染重构「甲三」——云端的渲染服务能产轨道流，界面上给一个入口

分支 `claude/rr-hosted-streams`，工作区 `.worktrees/rr-hosted-streams`，端口段 27620～27659。2026-10-13。

文中的叫法：「甲三」是任务书 `docs/plan/render-refactor-task.md` 里「云端的渲染服务能产轨道流，项目设置里给一个『生成轨道流』的入口（缺省关）」那一项；「清单计划」是在线页面发布的、带片段清单的计划任务；「切分方」是认领计划任务、把它切成细任务的节点（桌面应用、独立渲染主机、托管方的渲染节点）；「切分方自己的那一份」是切分方按自己的环境指纹出键、自己能认领的那份流任务（另一份是给浏览器节点的）；「这一项」指项目设置里的「生成轨道流」；「管理进程」「工作进程」是托管方渲染服务的两层进程（`server/hosted-render/main.mjs` 与它起的 `scripts/render-host.mjs`）；「账号项目」是走中心账号那条路的云端项目，「口令项目」是凭项目密码进入的共享项目。

## 状态

五件都做了；主会话读过第一版报告后又派了两处返工（直接接线、打开后当场生效），也做了，见紧接着的「第二轮」一节。验收探针、入口的单测与界面探针、「甲一」的三支探针、基线两条的结果见「验证结果」。要主会话注意的：

1. ~~打开这一项以后要等项目下一次改动才开始产流~~ **第二轮已做成当场生效**。
2. **账号项目里这两项现在只是能改、能看**：托管方的渲染服务看不到账号项目（目录模块只列旧凭证存储里的项目），改了也没有渲染节点来干活。见「没做成的」。
3. ~~「每个项目产不产」是绕着文件范围接的~~ **第二轮已换成直接接线**，绕路删了。
4. **有几个文件不在派活指令的文件清单里，我改了**，理由是指令点名要做的事落在它们身上、清单里没有别的路。请主会话审这一条：
   - 账号项目那条路（指令第 4 条）：`server/account/authority.mjs`（账本的创建者操作，+13 行）、`server/docservice/account-hosted.mjs`（会话里多一项，+8 行）、`src/account/client.ts`（页面的账号客户端，+30 行）和它的单测。指令写的入口是 `syncManager.ts` 的 `setHostedService`，但账号项目的记录、会话、页面发请求的那一层都在这三个文件里，不改它们创建者改不了、成员也看不到。都在提交 `754cee05` 里。0.7.18 的在途分支也在改账号这一带，合并时留意。
   - 部署清单（指令第 2 条「部署清单和脚本里写明」）：模板 `server/hosted/deploy/pm2-promptcut-render.config.cjs`（+3 行）、说明 `server/hosted/deploy/README.md`（表里加一行）、`scripts/remote/docservice.mjs`（只改了文件头注释里的环境变量清单）。部署脚本 `server/hosted-render/deploy.mjs` 读的就是这份模板。在提交 `63fd1af6` 里。
   - `server/test/m6c-integ.test.mjs`：一条钉执行器方法清单的旧用例，补上新方法的名字。
   - 第二轮主会话把 `server/render-node/host.mjs`、`server/vite-plugin-frames.ts`、`src/online/planPublisher.ts`、`server/render-queue/messages.mjs`、`src/editor/Preview.tsx` 划给了我，并认可了上面三个账号文件。

## 第二轮（2026-10-13，主会话的返工指令）

先把 `main`（`35f757f3`）合进了分支，无冲突。之后 `main` 又进了一块（跑键的比对时它已是 `30cbcb69`），没有再合：再合会让下面这些探针不是在最终代码上跑的。

### 第一处：换成直接接线

| 处 | 改了什么 | 文件 |
|---|---|---|
| 清单进主机 | 代理口清单每一项的 `streams` 随配置项进 `host.add`（一律给布尔，清单里没有这一项按不产） | `server/vite-plugin-frames.ts` 的 `startHostNode` |
| 主机按项目记 | 每个项目一个 `streams`（布尔才按项目管，配置项不带就是 null、不管）；`setStreams(projectId, bool)`；已经在的项目 `add` 时跟着更新，所以 `reconcileHostProjects` 每次对账（每秒）都带到；诊断 `nodes()` 多一项 `streams` | `server/render-node/host.mjs` |
| 认领闸 | `canClaim` 先过「这个项目产不产」再过原来的 lane 闸：不产的项目不认领流任务，快照、计划照常 | 同上 |
| 等着的任务数 | `pendingOf` 对不产的项目不数流任务（`pending`、`claimable`、`pendingKey` 都不含） | 同上 |
| 执行器 | `connect(entry, index, live)` 多给第三个参数，`live.streams()` 现读；`startHostNode` 把它作为 `streamsEnabled` 交给 `createPrerenderExecutor`，执行器切清单计划时看它 | `host.mjs`、`vite-plugin-frames.ts`、`server/prerender-executor.mjs` |

删掉的：`server/hosted-render/project-streams.mjs`（工作进程自己向代理口问）、执行器的 `accepts` 方法与 `projectStreams` 选项、`local-node.mjs` 认领前问执行器的那几行、它们的单测（`HRS-02` 原来两条、`HRS-05`、`HRS-06` 的 `accepts` 一条）、`m6c-integ.test.mjs` 里加过的 `accepts`。全仓搜 `project-streams`、`projectStreams`、`workerProjectStreams` 只剩本报告里的叙述。**只有一条路。**

原来写的三条代价，各自怎么验的：

1. **多一路请求**：没有了。那个模块删了；工作进程向代理口取清单的只剩 `startHostNode` 原有的每秒一次对账。
2. **按任务的 `source.projectId` 认项目**：改成按连接所属的项目。单测 `HRS-02` 第一条：任务里写的是别的项目文档 id，开着的项目照认领、关着的项目不认领。验收探针里项目二故意用了与共享项目不同的项目文档 id（第一版探针第 2 遍就是栽在这上面），第 7、8 遍它的流任务都做完了。
3. **隔离工作进程空转**：`pendingOf` 不数没人做的流任务。单测 `HRS-02` 第三条：关着、只有流任务时 `pending`、`claimable` 都是 0、`pendingKey` 为空（管理进程据这三项决定起不起隔离工作进程、它算不算闲）；关着、流任务与快照任务都在时只数快照；开着时都数。没有起真的隔离工作进程验。

跟着变的：关掉之后多久生效，从「约 0.5 秒」变成「工作进程下一次对账，一秒以内」（验收探针里渲染服务的清单 70～84 毫秒跟上，工作进程再晚不到一秒）。原来的〔裁〕第 6 条「清单过期按不产算」随那个模块一起没有了：现在对账是独立的每秒一拍，不靠有人来问才更新。

### 第二处：打开「生成轨道流」后当场生效

| 处 | 改了什么 | 文件 |
|---|---|---|
| 计划的身份 | `clipsPlanTaskOf` / `clipsPlanTask` 多一个参数 `streams`。为 true 时 `input.streams: true`、结果键的签名里多一段（`streams=1`）：同一版项目、同一份清单，这一项开着是另一个计划。不是 true 时结果键与 `input` 和没有这个参数时**逐字相同** | `server/render-queue/messages.mjs`、`src/online/planPublisher.ts`（两边单测对拍） |
| 入站校验 | 清单计划的 `input.streams` 只认布尔 true，别的值去掉，任务照收 | `messages.mjs` |
| 页面重发 | 发布器多一个依赖 `streams()`（本页此刻看到这一项是不是在起作用）与方法 `streamsOn()`（马上重发，不防抖）。`Preview.tsx` 每秒的检查里，这一项从关变开就调它；从开变关不调 | `planPublisher.ts`、`src/editor/Preview.tsx`、`src/editor/sync/hostedServices.ts` 的 `hostedStreamsOn` |
| 渲染节点等一等 | 计划写着开着、渲染节点自己手里还是关着（它的清单晚一拍）时，切分前最多等 4 秒到自己也看到开着。产不产仍只看它从目录来的那一项 | `server/prerender-executor.mjs` 的 `streamsSettled` |

逐条对主会话的要求：

- **从关变开重发、从开变关不重发**：做了。关掉靠认领闸当场生效。
- **一直关着的项目结果键不变**：做到了。单测 `C10-PP-ST-01` 钉了两样：不给、给 false 与别的假值时任务对象与原来逐字相同；没有附加内容时结果键就是 `项目@版本#clips:<清单的签名>` 这条原来的公式。带浏览器卡片登记的情形同样不变。
- **新旧互连**：
  - 旧页面连新文档服务：旧页面发的计划不带这一项，入站校验照收、形状不变（`C10-PP-ST-02` 末段）；它不会在打开时重发，退回下一次改动起生效。
  - 新页面连旧文档服务：旧文档服务不报 `streams`，`hostedStreamsOn` 一直是 false（`HS14`），页面不带这一项、不重发，计划与原来逐字相同。
  - 新页面连「报这一项、但队列是旧的」文档服务：带这一项的结果键仍是 1～32 位小写字母与数字，旧的入站校验只看这个字符集与任务 id 的形状，`input` 里多出的字段原样留着（`C10-PP-ST-02` 断言了字符集）。
- **几个成员同时在线只多切一次**：照清单计划原来的去重办——结果键相同就是同一个任务。打开时每个成员的页面各自重发，发的是同一个任务 id（同一版、同一份清单、都带这一项），队列只留一个，只切一次（`C10-PP-ST-04`：两个发布器发出的任务 id 逐个相同，合起来只有两个不同的任务）。原来就有的例外没有变：两个成员判重的片段不一样、或本页能运行的用户卡不一样时，他们的清单计划本来就是两个；这时细任务的 id 相同，仍然并成一份，不会重复渲。
- **验收探针**：去掉了「打开后让页面改一次项目名」，改成断言只打开、不动项目，流任务也出现并做完；另断言页面只多发了一份清单计划、项目的版本号与项目名都没变。

### 第二轮的验证（都在最终代码上；先重出了在线构建）

| 项 | 命令 | 结果 |
|---|---|---|
| 验收探针，第 7 遍 | `hosted-render-streams-probe.mjs --dist out/rr-hosted-streams/dist-online --base-port 27620` | **退出码 1**，只有一条不过：「甲不当渲染节点」读到的原因是 `single-stage` 而不是 `not-chromium`。探针取早了（页面判资格时先看舞台布局、后看浏览器内核，双舞台刚握上手那一下读到的还是前一条）。别的各条都过，包括新加的三条。产品代码没有为此改 |
| 验收探针，第 8 遍（探针改成等到原因落定） | 同上 | **退出码 0，`ok: true`，`fails: []`，80 秒** |
| `browser-stream-e2e-probe.mjs` | `--base-port 27640` | 退出码 0，`fails: []`（关着的一轮候选 1 个；开着的一轮「浏览器、切分方」；像素差得多的像素 0.063%） |
| `browser-stream-node-probe.mjs` | `--base-port 27640` | 退出码 0，`fails: []` |
| `online-stream-play-probe.mjs` | `--base-port 27650` | 退出码 0，`fails: []`（平均差 0.184、差得多的像素 0.124%）。这次是在最终代码上跑的 |
| `hosted-stream-entry-probe.mjs` | `--desktop-port 27640 --doc-port 27643 --asset-port 27644` | 退出码 0，`{"summary":{"ok":true,"total":20,"fails":[]}}`，一遍过 |
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test`（两个环境变量照设） | **退出码 0：5738 条，过 5734，失败 0，取消 0，跳过 4**，83 秒，一遍过 |
| 键的比对 | `card-source-version-compare.mjs --base main`；`card-table-digest-compare.mjs --expect ,` | 都是退出码 0：`changed: []`；101 张逐张相同、有变化 0 张（基准是当时的 `main@30cbcb69`） |

验收探针第 8 遍的关键数：

- **只打开、不动项目**：创建者打开后 838 毫秒，队列里出现渲染服务自己的 3 个流任务（第 7 遍 1259 毫秒）；这期间页面只多发了一份清单计划（结果键从 `…@4#clips:13ye28nin4skn` 变成 `…@4#clips:1afhgr8c12cg4`，同是第 4 版）；项目的版本号与项目名都没变。
- 其余同第一轮：手里有一个流任务时关掉，那个 2.1 秒后做完、没有放回，另两个 23 秒里一直 open；同时项目二（项目文档 id 与共享项目 id 不同）的流任务做完；再打开后剩下两个 4.8 秒做完；页面播放 44 帧是流在画、快照平面只变动 3 次；像素差得多的像素 0.105%（线是 0.2%）；页面错误 0、失败任务 0。

单测：`server/test/hosted-render-streams.test.mjs` 现在 11 条（`HRS-02` 换成主机的四条，`HRS-06` 两条，其中一条是「等一等」）；`src/online/planPublisher.test.mjs` 加 4 条（`C10-PP-ST-01`～`04`）；`src/editor/sync/hostedServices.test.mjs` 加 `HS14`。

窗口：第二轮跑探针前、全部跑完后各查一次，都是空的；27620～27659 上没有监听；公共的 `port.json` 修改时间仍是 03:10，所有进程都带了 `PROMPTCUT_NO_PORT_FILE=1`。`verify-determinism`、`verify-unified-frames` 照指令没跑。

### 第二轮没做成的

1. **「打开后当场生效」在账号项目上没有端到端验过。** 页面读这一项的地方是同一个（`view.hosted`），账号项目靠每 3 秒续会话更新它，所以打开后最多晚 3 秒重发；但渲染服务本来就还看不到账号项目（第一轮「没做成的」第 2 条），整条路要等 0.7.18 接入之后才验得了。
2. **`Preview.tsx` 里新加的那几行只有验收探针覆盖**（它在 Node 里载不起来，没有单测）；从关变开的边沿判断是三行，发布器那一半有单测。
3. **云端 Agent 服务发的清单计划不带这一项**（`server/agent/service/render-request.mjs` 不在我的范围里）。它每次文档改动都会发新的计划，所以只是「下一次改动起生效」，没有别的后果。
4. 隔离工作进程在这一项关着时不空转，只有单测，没有起真的隔离工作进程验。

### 第二轮新的裁定〔裁〕

- 〔裁〕**这一项开着的清单计划是另一个结果键**（签名里多一段 `streams=1`，`input.streams: true`）。后果：这一项开着的项目，每一版项目的清单计划的键与关着时不同；关着的项目一个字不变。
- 〔裁〕**页面写的 `input.streams` 不作数，只决定渲染节点切分前要不要等**；等的上限 4 秒（`STREAMS_SETTLE_MS`，三级数字）。页面乱写的最坏结果是它自己的计划晚 4 秒被切。
- 〔裁〕**从关变开时马上重发，不走防抖**（创建者正等着）；从开变关不重发。
- 〔裁〕**主机上「产不产」只认布尔**：配置项不带 `streams` 的主机（普通的独立渲染主机）不按项目管，行为与原来相同；代理模式下清单里没有这一项按不产算。
- 第一轮〔裁〕第 1 条（绕着接）与第 6 条（清单过期按不产）作废，下面原文留着、标了记号。


## 做了什么

### 一、合入原型

`git merge --no-ff claude/hosted-stream-entry`，没有冲突。界面上的八句文案（`src/editor/sync/hostedServices.ts` 的 `HOSTED_OPTION_TEXT`）一个字没动。

### 二、渲染服务那一半

| 处 | 改了什么 | 文件 |
|---|---|---|
| 以能产流的方式起 | 部署模板写 `PROMPTCUT_RENDER_STREAMS: '{{STREAMS}}'`，部署参数 `streams` 缺省 `'1'`（显式给 `0` 才整台不产，别的值报用法错误）；管理进程把 `--streams` 同样交给隔离工作进程（带用户卡的项目整个归它做，它不能产的话这种项目打开了也没人产）；`/status` 多一项 `streams` | `server/hosted/deploy/pm2-promptcut-render.config.cjs`、`server/hosted-render/deploy.mjs`、`server/hosted-render/main.mjs`、`server/hosted/deploy/README.md`、`scripts/render-host.mjs` 与 `scripts/remote/docservice.mjs` 的说明 |
| 管理进程读目录条目 | 给工作进程的清单（代理口 `GET /projects`）每一项多带 `streams`：**渲染节点开着并且 `hosted.render.streams` 是 true**（`streamsOn`）。只关这一项的项目照样列、照样连。隔离工作进程的那份清单照目录条目补上同一项 | `server/hosted-render/broker.mjs`、`main.mjs` |
| ~~工作进程问「这个项目产不产」~~ | 第一轮的做法（新模块 `project-streams.mjs` 向代理口问），**第二轮删了**，换成清单经 `startHostNode` 进主机，见上一节 | — |
| 认领闸 | 第一轮是执行器的 `accepts(task)` 加 `createLocalNode` 认领前问它；**第二轮改成主机的 `canClaim`**（`host.mjs`），那两处删了。行为不变：流任务要这个项目此刻产流才认领，快照任务、计划任务照常；**只挡认领**，手里的流任务照做完，不放回 | `server/render-node/host.mjs` |

关这一项与关渲染节点的区别照任务书：不断开服务的连接、不放回手里的认领、已经产出的流保留。

### 三、清单计划连切分方自己的那一份流一起出

| 处 | 改了什么 | 文件 |
|---|---|---|
| 切分的输入 | `planForQueue` 的上下文多一项 `ownListStreams`：本机此刻能不能产流（有生产者、开关开着、探到了编码器，就是 `streamCapable()`，与节点报的 `capabilities.streams` 同一个判据）。`browserStreamsFor` 没改 | `server/frame-pipeline.mjs` 的 `planForQueue` |
| 托管方按项目收一道 | 执行器 `plan()` 对清单计划：这个项目此刻不产流就把 `ownListStreams` 改成 false（每次切分现问，不进按版本的缓存） | `server/prerender-executor.mjs` |
| 出哪几份 | `listPlanOverrides`：`ownListStreams` 为真时，**单卡流**不再标 `browserOnly`，于是 `splitPlan` 照它现成的规矩出两份（切分方自己的、浏览器的，成对，谁先认领谁得）；不为真照旧只给浏览器。**组流任何时候都只标 `browserOnly`**（等于不出） | `server/render-node/local-node.mjs` |
| 把任务对回这一版 | `matchStream`：清单计划切出的流任务在本机这一版的流里找不到时，按任务的片段现算它的单卡流再对（`pipeline.listStreamSpecs(entry, [片段])`）。内容键、结果键、分段范围照核，对不上照旧 `plan-mismatch`；不是清单计划切出的任务不走这条回退 | `server/prerender-executor.mjs` |
| 层表 | 没改写法：切分方自己的指纹随流任务进切分候选记录，`issuedStreamSpecs` 照记录列，候选是「切分方、浏览器」（照发布顺序）。另加一处：这一版所属的项目此刻不产流时（执行器在 entry 上记 `ownStreamsOff`），层表不列本机自己这一版的流，免得页面去取没人产的清单；已经派过的照记录列 | `server/frame-pipeline.mjs` 的 `layerMapStreamOptions` |

**没有改 `streamPicked`**。任务书说「`FramePipeline.streamPicked` 现在只认本机判重的卡」，我的读法是它管的是「本机自己这一版要产哪些流」（自动生产、本机流计划），清单里的片段是发布方判的，本机没判重也要产。所以没有把清单并进它，而是让执行器在任务回来时按片段现算：这样不用记着当时的清单，换一个进程、重启之后照样对得回（做法同「甲一」集成时层表那一环的理由）。`produceRange` 拿到流的形状就能产，不过 `streamPicked` 这道闸。`preload`、`fillAnchorSnapshots`、`fillCardControls`、`recordSnapshots` 没有碰。

### 四、账号项目那条路

账号项目的记录在账本里（`server/account/authority.mjs`），页面凭登录令牌走 `/hosted/shared/account/admin`，与口令项目是两套接口。

| 处 | 改了什么 | 文件 |
|---|---|---|
| 账本 | 新的创建者操作 `set-hosted-option { service: 'render', option: 'streams', enabled }`：记在 `hostedOptions.render.streams`（没有算关）；与原有的 `set-hosted-service` 互不冲掉；记一条访问事件（不带受影响的成员，不停任何任务）；不是创建者 403，参数不对 400 `invalid-option`，版本号对不上 409 | `server/account/authority.mjs` |
| 会话 | `hosted` 多一项 `render: { available, enabled, streams }`（`available` 看登记表里有没有渲染服务的公钥） | `server/docservice/account-hosted.mjs` |
| 页面的账号客户端 | `setHostedService(projectId, service, …)`、`setHostedOption(…)`；会话里的 `hosted.render` 形状对才收，旧文档服务不报就没有 | `src/account/client.ts` |
| 同步管理 | `setHostedService` 对账号项目不再只认云端 Agent；`setHostedOption` 对账号项目不再回「不允许」。改完续一次会话。成员靠每 3 秒续会话读到的状态看到变化；账号项目没有口令项目那两种通知，按前后两次读到的状态给提示，规矩与文案同口令项目（只在关闭时） | `src/editor/sync/syncManager.ts`、`hostedServices.ts` |
| 界面 | 账号项目点这两行的勾选，不弹「验证创建者身份」（账号项目没有创建者密码，原来这一步对账号项目一定过不去），直接到确认弹窗；成员照旧只读 | `src/editor/sync/MembersPanel.tsx` |

**VisuHive 仓库不用改。** 这两项的读写都在 PromptCut 的文档服务与页面之间；账号服务那边只调 PromptCut 的 `/internal/v2/projects`（列项目），不读这些字段。

### 五、新旧兼容

原型的单测（`hosted-stream-option.test.mjs`、`hostedServices.test.mjs` 的 HS10～HS12）原样通过。新加的两处同样兼容：旧文档服务的会话没有 `hosted.render`，新页面不显示那两行；旧文档服务的目录条目不带 `streams`，渲染服务按不产算。

### 六、文档

`docs/plan/hosted-render-contract.md` 第 3.1 节补了「渲染服务怎么用它」「账号项目」两条，第 7.2 节改了 `PROMPTCUT_RENDER_STREAMS` 一行；`docs/plan/browser-stream-task.md` 两处「留给甲三」改成已做。`docs/semantics/` 没有动。

## 验证结果

机器：这台 PC，同时有别的子 Agent 在跑。

### 验收探针 `scripts/probes/hosted-render-streams-probe.mjs`（新）

隔离的托管组合：进程内的文档服务与素材服务（本机信任关着、带集群令牌，与云节点同样的配置）、本机托管代理的三个同站跨源的源、真的渲染服务管理进程与工作进程（`PROMPTCUT_RENDER_STREAMS=1`，并发 1，测试指纹）、在线构建的页面。创建者是本进程里的一条连接，发的是页面同一个创建者操作。

命令：`node scripts/probes/hosted-render-streams-probe.mjs --dist out/rr-hosted-streams/dist-online --base-port 27620 --out out/rr-hosted-streams/run4`

**第 4 遍：退出码 0，`ok: true`，`fails: []`，174 秒。** 逐条：

| 验收 | 结果 |
|---|---|
| 新建的项目这一项是关的 | 成员列表 `hosted.render` 是 `{ available: true, enabled: true, streams: false }`；管理进程的清单里这个项目 `streams: false` |
| 关着：不认领流任务、快照任务照常 | 页面发的清单计划由渲染服务切分（`plans: 2`），4 个快照任务全部 done，失败 0；队列里这个项目 0 条流任务；层表有这张卡的快照层、没有流；页面的在线来源里没有这张卡的流 |
| 创建者打开 | `shared.admin` 回 ok；成员列表变成 `streams: true`；管理进程的清单 69 毫秒后跟着变。只打开、没有新的清单计划时仍是 0 条流任务（见「没做成的」第 1 条）；页面改一次项目名后 2.9 秒切出 3 个流任务（分段 0～7、8～15、16～16） |
| 再关掉（手里正有一个流任务） | 渲染服务认领一个流任务后 71 毫秒关掉。手里的那个 4.5 秒后 done（`attempts` ≤ 1，没有放回，`released` 不变）；之后 39 秒里另外两个一直 `open`、`attempts: 0`、没有认领；渲染服务与这个项目的连接没断；这期间这个项目新发的清单计划照常被认领、切分，没有再切出流任务；已经产出的那一段的流清单在内容库里，层表里这条流的那一行还在（候选是渲染服务的指纹） |
| 别的项目不受影响 | 同一段时间里项目二（这一项开着）的清单计划被认领，1 个流任务、1 个快照任务都 done（36 秒） |
| 再打开 | 剩下的两个流任务 8.9 秒后都 done；3 份流清单都过 `manifestMatches`；素材服务 `px` 里 18 块（1 个开头文件加 17 个分段，147 KB，编码器 `libx264`）都 complete、哈希对 |
| 在线页面播放时贴上 | 页面的在线来源选中的是渲染服务产的那一份（6 段就绪，没有过期的）。播 45 帧：流播放器 `drawn` 从 1 到 53、`lastDrawn` 从 32 到 77，跟着播放头；字节是父页推的；包裹层一直被抑制；0 错误；快照平面只变动 3 次（不是每拍换）；舞台在 `http://s1.pc.localhost:27621`（跨源、隔离的那一种） |
| 像素（638×359，满分 255） | 流在画第 44～47 帧时截图，与第 46 帧的精确活渲比：平均差 0.117、差得多的像素 0.088%；对照（往后 2 秒）平均差 1.003、差得多的像素 1.108% |
| 页面错误、失败任务 | 0；渲染服务两个项目的节点 `failed: 0`、`released: 0`、`lost: 0`；代码版本与在线构建相同 |

**看过的图**（`docs/reports/assets/rr-hosted-streams/`）：`e-jia-stream.png` 是棋盘格背景上、画面下方正中一块橙色圆角块（流在画的那一帧）；`e-jia-live-same.png` 肉眼看不出差别；`e-jia-live-far.png` 里橙块往右挪了约 10 个像素。

**前三遍没过，原因都在探针，产品代码没有为此改动：**

| 遍 | 退出码 | 不过的 | 原因 |
|---|---|---|---|
| 1 | 1 | 等不到页面把卡列进清单计划 | 我先用了画布卡 `r6-canvas`（想让浏览器节点做不了它）。页面测出来它是轻卡，不进清单。改成 `probe-slow-stepped`（每帧烧 40 毫秒，页面判重），并让页面报非 Chromium 内核的浏览器标识，于是它不当渲染节点 |
| 2 | 1 | 项目二的流任务没出现 | 探针给项目二用了一个与共享项目 id 不同的项目文档 id。渲染服务按任务的 `source.projectId` 认「哪个项目」，查不到就按不产算。页面与云端 Agent 服务发的任务里它就是共享项目的 id，探针改成一样。这条约束见「裁定」第 1 条 |
| 3 | 1 | 一条计数断言 | 工作进程每秒交一次诊断，任务做完那一刻读到的完成数还是上一拍的（3，队列里已是 4 个 done）。改成等它跟上。同一遍里像素那条「差得多的像素」是 0.19%，贴着 0.2% 的线：块上的字在流里是灰度抗锯齿、活渲是子像素抗锯齿（「甲一」集成报告记过）。第 4 遍把字去掉，是 0.088% |

第 2、3 遍里别的各条都过；第 2 遍因为等项目二等满了 300 秒，「再关之后剩下的两个流任务一直没被认领」实际看了 310 秒。

**之后又跑了两遍，都过**（产品代码在第 4 遍之后还改了两处，见下一小节，所以重跑）：第 5 遍退出码 0、`fails: []`、117 秒；第 6 遍（最终提交的代码与探针）退出码 0、`fails: []`、96 秒。三遍通过的里面，像素那一条「差得多的像素」分别是 0.088%、0.147%、0.152%，通过线是 0.2%（照「甲一」两支探针的线没有放宽）：余量不大。差在橙块的边上，渲染服务用 libx264 压的流比浏览器自己压的边缘误差大一点；「甲一」的 e2e 探针同一张卡是 0.05% 上下。主会话重跑时如果这一条贴线不过，先看 `same.bad` 是多少。

**为什么页面不当渲染节点。** 在线页面（Chromium 内核、身份为电脑）自己也是浏览器节点，做得了这张卡的流；渲染服务也出自己的那一份时两份成对，谁先认领谁得。探针要验的是渲染服务这一份，所以让页面报非 Chromium 的标识（页面自己据此不开节点连接，同 Firefox、Safari、手机身份的成员）。两边都能做时的那条路是「甲一」的三支探针验的。

### 单测

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `server/test/hosted-render-streams.test.mjs`（新） | 10 | 清单的 `streams`；工作进程问「产不产」（没问到过、过期、问不到、晚一拍生效、口令不进诊断）；`listPlanOverrides`；local-node 切清单计划出两份；认领闸；执行器 `accepts` 与 `plan`；把清单计划的流任务对回这一版；管理进程的配置 |
| `server/test/layer-map-streams.test.mjs` | 14 → 16 | 新增：清单计划连切分方自己的那一份一起出时层表的候选是「切分方、浏览器」，关着时只有浏览器；这一项关着的项目不列本机自己这一版的流、派过的照列 |
| `server/test/account-hosted-option.test.mjs`（新） | 5 | 账号项目：会话里的 `hosted.render`；创建者改、落账、访问事件、重放；校验；成员 403 但读得到；公开路由走通 |
| `src/account/client.test.mjs` | +1 | 会话里的渲染节点一项（旧文档服务没有、形状不对的丢掉）；两个新调用的请求体 |
| `src/editor/sync/hostedServices.test.mjs` | 22 → 25 | 账号项目的三条（会话形状出这几行、创建者能改成员只读；前后两次状态给提示；不走创建者密码） |
| `server/test/hosted-render-deploy.test.mjs` | 改 | PM2 配置里有 `PROMPTCUT_RENDER_STREAMS: '1'`；`0` 与非法值 |

`hosted-render-streams.test.mjs` 里 local-node 切出的流任务，名次只断言「不是 backfill 档」，没有钉具体的数（「稀疏一」要把流任务的名次改成 5）。

### 「甲一」的三支探针与入口的界面探针

先重新出了在线构建（`vite build --mode online`，6 秒），跑的时候没有再动 `src/` 与 `server/frame-pipeline.mjs`（各探针开头核对过在线构建嵌的代码版本与源码一致）。都带 `PROMPTCUT_NO_PORT_FILE=1`。

| 探针 | 命令（`--dist out/rr-hosted-streams/dist-online`） | 遍 | 结果 |
|---|---|---|---|
| `browser-stream-e2e-probe.mjs` | `--base-port 27640` | 1 | **退出码 1**：「开着流开关」那一轮 8 条不过，「关着」那一轮全过。是我的改动引出来的，见下 |
| 同上 | 同上 | 2（改了之后） | 退出码 0，`fails: []`。关着的一轮层表候选只有浏览器；开着的一轮是「浏览器、切分方」；像素平均差 0.135 / 0.118，差得多的像素 0.048% / 0.051% |
| `browser-stream-node-probe.mjs` | `--base-port 27640` | 1、2（最终代码） | 两遍都是退出码 0，`fails: []` |
| `online-stream-play-probe.mjs` | `--base-port 27650` | 1 | 退出码 0，`fails: []`（像素平均差 0.192、差得多的像素 0.137%）。这一遍在最后两处改动之前跑的；它由管线自己产流、自己推，不经过执行器与切分，之后没有重跑 |
| `hosted-stream-entry-probe.mjs` | `--desktop-port 27640 --doc-port 27643 --asset-port 27644` | 1 | **退出码 1**：等「多用户协作已开启」40 秒超时，没有走到任何一条断言（紧跟在前三支探针后面跑的，编辑器的开发服务器第一次起） |
| 同上 | 同上 | 2（单独重跑） | 退出码 0，`{"summary":{"ok":true,"total":20,"fails":[]}}` |

**`browser-stream-e2e-probe.mjs` 第 1 遍不过的原因，和为它改的两处产品代码。** 那一轮的切分方是开着流开关、但只切分不认领细任务的桌面预渲染进程（测试开关 `PROMPTCUT_TEST_PLAN_ONLY=1`）。照我的改动它能产流，于是连自己的那一份流也切了出来，层表里这条流的候选成了「切分方、浏览器」；它自己不做，浏览器做完；之后才进来的页面取第一个候选（切分方的），找不到流。这暴露的是一个真问题，不只是测试开关的问题：**两份成对时，层表里候选的先后要对着实际是谁产的**，之后才进来的页面（每次重新打开项目都是）没收到过完成通知，只认第一个。改了两处：

1. 只切分、不认领细任务的节点（`planOnly`）不出自己的那一份流（`local-node.mjs`）：它不会去做。
2. 成对的流在候选记录里的先后（`prerender-executor.mjs`）：切分完成时自己的排在别人后面；本机真产出了这条流的一段，才把自己的提到最前、把层表重写一次（`promoteOwnStream`）。别人先认领的话本机那一份被队列作废，走不到这一步，顺序不动。记录落盘，重启后照旧；已经是自己在前的，之后再切不往后挪。

这样两种结局下之后进来的页面都取得到实际产出的那一份。单测加在 `layer-map-streams.test.mjs`（切分完成时浏览器在前；本机产出一段后自己在前、层表重写一次；再做一段不重写；重启后顺序照旧）。改完之后 e2e 探针、节点探针、验收探针都重跑过。

### 基线

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（最后一次改 `src/` 之后跑的） |
| 全量测试，第 1 遍 | `npm test`（同一条命令里设了两个环境变量） | **退出码 1**：5730 条，过 5718，失败 7，取消 1，跳过 4。失败的 8 个文件见下 |
| 那 8 个文件各自单独重跑 | `npm test -- server/test/<文件>` | 8 个都是退出码 0、失败 0 |
| 全量测试，第 2 遍 | `npm test` | **退出码 0：5730 条，过 5726，失败 0，取消 0，跳过 4**，79 秒；末行「npm test 最终结果：零失败」 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27650/?export=1"` | 退出码 0：1800 帧，逐像素相同 1800，不同 0 |
| 导出与快照重放一致 | `node scripts/verify-unified-frames.mjs`（`PC_FRAME_TEST_URL` 指到同一个开发服务器） | 第 1 次退出码 1，是我搭的环境不对（把测试视频放在了开发服务器的素材目录之外，页面取不到）；把目录对上之后退出码 0，末行 `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; …` |

第 1 遍全量测试失败的 8 个文件：

| 文件 | 现场 | 归因 |
|---|---|---|
| `m6c-integ.test.mjs` | 执行器的方法清单多了 `accepts` | **我的改动**。这条用例钉的是「执行器没有 `isIdle`」，清单里补上 `accepts`，没有放松别的 |
| `account-assembly-central`、`account-real-runner`、`asset-doc-client` | `listen EADDRINUSE` 127.0.0.1:5770、6701、5865 | 写死的端口被别的进程占着 |
| `asset-wiring-integration` | 文件级失败，退出码 134 | 通用规矩里列着的偶发项 |
| `agent-live-selection` | 等 8 秒超时 | 通用规矩里列着的偶发项 |
| `asset-project-workers` | 真 ffmpeg 转码那一条 20 秒超时 | 机器忙（同时有别的子 Agent 在跑） |
| `account-v2-install-plan` 第 238 行 | 断言 `false !== true` | 起真的入口进程核对它拒绝错误的服务身份；单独重跑 8 条全过，我没有再查它在忙的机器上为什么会不过 |

导出确定性与快照重放这两条：我改的 `server/frame-pipeline.mjs` 两处（队列计划的上下文多一项、层表的流那一步多一个判断）都不出画面，照 `verification.md`「按改动范围验证」可以不跑；通用规矩写的是改到这个文件就跑，所以跑了。起的开发服务器是本工作区的（端口 27650，隐藏窗口，带 `PROMPTCUT_NO_PORT_FILE=1`，数据目录在 `out/` 下），验完按进程号收掉了。

### 键的核对

| 命令 | 结果 |
|---|---|
| `node scripts/probes/card-source-version-compare.mjs --base main` | 退出码 0：`{"ok":true,"base":"main@35f757f3","entries":88,"changed":[],"added":[],"removed":[],"identities":61,"identityChanged":[],"identityAdded":[]}` |
| `node scripts/probes/card-table-digest-compare.mjs --expect ,` | 退出码 0：「内置卡:改前 101 张,改后 101 张;逐张相同 101 张,有变化 0 张」；生成快照的代码指纹改前改后相同 |

**没有卡的键变。** 那十个不许改的文件一个没碰，也没有让它们引新模块。

### 窗口与端口

- 起探针前后都查了可见窗口（`Get-Process` 里 `MainWindowHandle` 不为 0 的终端、node、chrome、ffmpeg）：开工前一次、渲染服务那条进程链头三遍开跑后 8 秒各一次、第一遍跑完一次、四支旧探针开跑后一次、全部跑完一次，共 7 次，都是空的。
- 端口只用了 27620～27659。全部跑完后查过这一段上没有监听，也没有我起的 node、Chrome、ffmpeg 留着（当时机器上有一个无头 Chrome 是别的会话的 `verify-determinism`，端口 27596，没有动）。
- **开发服务器与公共的 `port.json`（主会话中途通知的）：** 收到通知之前，我只跑过验收探针的头两遍，没有显式带 `PROMPTCUT_NO_PORT_FILE=1`。那两遍里起的编辑器是渲染服务的工作进程起的，`scripts/render-host.mjs` 本来就把它的临时目录指到自己的数据目录下，不写公共的那一份。核对过：`%TEMP%\promptcut\port.json` 的修改时间是当天 03:10，早于我第一次起任何进程（03:24），全部跑完后仍是 03:10，**我没有写过它**。收到通知之后，所有探针、全量测试、验证用的开发服务器都带了这个变量，验收探针也在给渲染服务的环境里写明了。

## 没做成的及原因

1. ~~打开这一项以后不会当场开始产流。~~ **第二轮做了**，见「第二轮」一节。
2. **账号项目里这两项还没有渲染节点来执行。** 托管方的渲染服务看不到账号项目：目录模块（`server/docservice/modules/hosted.mjs`）只列旧凭证存储里的项目，服务的连接票据也从那里签。任务书说这是 0.7.18「把托管方的渲染节点接进账号项目」的事。到时候目录条目按账本出 `enabled`（`hosted.render`）与 `hosted.render.streams`（`hostedOptions.render.streams`），`authority.mjs` 导出的 `accountRenderState` 就是这两项的读法。另外注意：账号项目新建时渲染节点是**关**的（账本里原来就是 `hosted: { render: false, agent: false }`），与口令项目「没有算开」相反，我没有动它。
   - 在那之前这两行会不会露出来：看登记表里有没有渲染服务的公钥。现在生产上没有部署渲染服务，所以不会出现；部署渲染服务而没有接账号项目的话，这两行会出现、能改、但不起作用。
3. **账号项目这条路没有浏览器端的走查。** 服务端、客户端、界面逻辑各有单测；整条路（账号登录、进项目、点勾选）要起账号服务，现有的账号探针都靠 VisuHive 仓库的源码，我没有另搭。`syncManager.ts` 在 Node 里载不起来，它里面新加的那几行只过了类型检查。
4. **清单计划里的组流不出。** 清单里同时活跃的重卡超过解码器预算（6 条）时，被并成组流的那几张卡，渲染服务不为它们产流（浏览器本来也画不了组流）。原因：组流的内容键跟着「清单里还有哪些片段」变，流任务回来时对不回这一版，层表也只认单卡流。这几张卡照旧贴快照。
5. **「两边都能做、渲染服务先认领」的结局没有端到端验过**，只有单测（候选的先后）。见「部署时要做什么」末尾。
6. **渲染服务的隔离工作进程产流没有验**（探针里关着用户卡隔离）。它与常驻工作进程走的是同一段代码，多的只是启动参数里带 `--streams`。
7. **真实网络环境的验收**不是这次的活，见下一节。

## 部署时要做什么、怎么验

跟着 0.7.18 的部署做。

**要做的：**

1. 文档服务、在线编辑器、渲染服务三样用**同一个提交**重新部署（渲染服务与在线页面的代码版本不同时，它一个任务也认领不了）。这次文档服务有改动（口令项目的 `set-hosted-option`、目录条目的 `streams` 是原型带来的；账号项目的会话多了 `hosted.render`；清单计划的入站校验认 `input.streams`）。
2. 渲染服务：`deploy-render` 生成的 PM2 配置里现在有 `PROMPTCUT_RENDER_STREAMS: '1'`，不用另外给参数。要整台不产流时部署前设 `PROMPTCUT_RENDER_STREAMS=0`。
3. 节点上的 ffmpeg 要有 H.264 编码器（`install-render` 装的 `ffmpeg` 包带 libx264）。没有的话自检只告警 `no-h264`，渲染服务照常做快照、一条流也不产。
4. 已有项目不用迁移：记录里没有这一项按关算。

**怎么验（在节点上，用测试项目）：**

1. `status-render`（或节点上 `curl http://127.0.0.1:5399/status`）：顶层 `streams: true`；`queue.capabilities.streams` 与 `transcode` 都是 true；`codeVersion.match` 不是 false；自检告警里没有 `no-h264`。
2. 新建一个测试项目，只开在线页面、不开桌面应用。`/status` 的 `projects[]` 里这个项目 `streams: false`。加一张重卡，等快照做完：渲染节点那一行的成员列表里有「渲染中」，播放时重卡在换快照。
3. 创建者在项目设置里勾上「生成轨道流」并确认。`/status` 里这个项目变成 `streams: true`。**不用动项目**，一两秒后 `/status` 的 `queue.nodes[]` 里这个项目的 `held` / `running` 出现 `stream:` 开头的任务，随后 `completed` 增加。（旧版本的页面要等项目下一次改动。）
4. 页面播放这张卡：是流在画（画面连续，不是隔一阵跳一张）。要看数字的话，页面控制台 `__pcOnlineSnapshots().streams` 里有这张卡、`ready` 大于 0。
5. 再取消勾选：`/status` 里变回 `streams: false`，之后新加的重卡只有快照；已经有流的那张卡照旧播流。
6. 另开一个没勾这一项的测试项目，确认它一条流都没有。
7. 任务书点名的那一条：只开在线页面、没有桌面应用在线，重卡的流由云端的渲染服务产出并能播放——就是第 3、4 步。用 Firefox 或手机身份的页面再看一遍更直接（这种页面自己产不了流）。
8. 验完删掉测试项目。

**部署时可能遇到的：** 用 Chromium 内核的电脑页面时，页面自己也是浏览器节点，同一张卡的流两边都能做，谁先认领谁得；所以 `/status` 里渲染服务没有做这张卡的流、而页面照样播流，是正常的（流是页面自己产的）。要确认渲染服务在产，用第 7 步的页面，或者用浏览器做不了的卡（Lottie；画布卡要页面测出来判重才进清单）。两边都能做的这条路，本机只验了「浏览器先认领」的结局（e2e 探针）和「只有渲染服务能做」的结局（验收探针）；「两边都在、渲染服务先认领、之后才进来的页面取到它那一份」只有单测，建议部署时顺手看一眼：产完后刷新页面，重卡仍然是流在画。

## 裁定〔裁〕

没有改语义文档。下面是实现里自己定的。

1. ~~〔裁〕「每个项目产不产」由工作进程自己向管理进程的代理口问~~ **作废**：第二轮照主会话的指令换成直接接线，那三条代价各自怎么没有的见「第二轮」一节。
2. 〔裁〕**桌面应用认领清单计划时出不出自己的那一份：照它自己能不能产流。** 有轨道流生产者、流开关开着、探到了编码器（`streamCapable()`）就出，否则只给浏览器出。这一项不管桌面应用、普通的独立渲染主机。行为上的变化：以前桌面替在线页面的清单计划只切快照与给浏览器的流，现在能产流的桌面会多切出自己的那一份流任务，并去做它们。
3. 〔裁〕**清单计划里切分方自己的那一份只出单卡流**，组流不出。理由见「没做成的」第 4 条。
4. 〔裁〕**没有改 `streamPicked`**，改由执行器按任务的片段把流任务对回这一版。理由见「做了什么」第三节。
5. 〔裁〕**隔离工作进程同样以能产流的方式起。** 不然带用户卡的项目打开这一项也没人产。
6. ~~〔裁〕清单过期按不产算~~ **作废**：随 `project-streams.mjs` 一起删了。现在工作进程每秒对一次账，不靠有人来问才更新。
7. 〔裁〕**这一项关着的项目，层表不列渲染服务自己这一版的流**（`entry.ownStreamsOff`）。渲染服务整台以能产流的方式起之后，不加这一处的话每个没打开的项目的层表都会列出没人产的流，页面白取清单。已经派过的流照候选记录列，产出的保留。
8. 〔裁〕**成对的流，层表里候选的先后对着实际是谁产的**：切分完成时自己的排在后面，本机产出一段后提到最前并重写一次层表（`prerender-executor.mjs` 的 `promoteOwnStream`）。原因与验证见「验证结果」里 e2e 探针那一段。这改了「甲一」留下的一个顺序：桌面的普通计划里本机判重、浏览器也做得了的单卡流，候选原来是「切分方、浏览器」（照发布顺序），现在切分完成时是「浏览器、切分方」，桌面产出之后才是「切分方、浏览器」。只影响之后才进来的页面取哪一个，在场的页面照完成通知认。快照层的候选没有动（它有同一个毛病，「甲一」集成报告「发现的问题」第 1 条，要页面一侧按清单认定才根治）。
9. 〔裁〕**只切分、不认领细任务的节点不出自己的那一份流**（`planOnly`，仅供测试的开关）。
10. 〔裁〕**部署参数缺省是开**（`deploy.mjs` 的 `streams` 缺省 `'1'`），管理进程自己的缺省仍是不产（不设 `PROMPTCUT_RENDER_STREAMS` 时与原来相同）。这样手工起管理进程、现有的探针与测试行为不变。
11. 〔裁〕**账号项目的子选项记在 `hostedOptions.render.streams`**，不改 `hosted.render` 的形状（它在账本里是布尔，别处按布尔读）。会话里对页面给的是合起来的 `hosted.render: { available, enabled, streams }`，与口令项目成员列表里的形状相同，界面那两行不用分两种读法。
12. 〔裁〕**账号项目改这两项不弹「验证创建者身份」。** 账号项目没有创建者密码；服务端按登录与创建者身份把关。确认弹窗照旧。
13. 〔裁〕**账号项目里别的成员的提示靠比前后两次会话**（页面每 3 秒续一次），不新增通知。规矩与文案同口令项目：只在关闭时提示。创建者自己那一页不提示。

## 对任务书或语义的更正建议

1. 语义表第 10 行（`workflow/project.md`「项目设置」）照任务书原文即可，不用再补「从项目下一次改动起生效」那半句（第二轮做成当场生效了）。
2. `product/hosting.md`（二级）里托管方渲染节点的开关那一段，建议补：渲染节点下面有一项「生成轨道流」，缺省关；关这一项不断开渲染节点、不放回它手里的任务，已经产出的保留。
3. `mechanism/hosting.md`（三级）建议补：渲染服务以能产流的方式起；管理进程把「渲染节点开着并且这一项开着」放进给工作进程的清单，工作进程每秒对账时记到每个项目上；没打开的项目不认领流任务、切分清单计划时不出自己的那一份；在线页面看到这一项从关变开时重发一份结果键带这一项的清单计划，渲染节点据此当场切出流任务；渲染节点切分时如果计划写着开着而自己还没看到，最多等 4 秒。
4. `mechanism/rendering.md` 写层表的地方（「甲一」集成报告已经建议过补一句）：清单计划的流，切分方能产时连自己的那一份一起出，候选里切分方的指纹在前。
5. 任务书「甲三」说「账号项目那条路……要在 0.7.18 把托管方的渲染节点接进账号项目时一并接上」。这次接的是「能改、能看」；「接进账号项目」本身还没做，见「没做成的」第 2 条。
6. （第一轮写的「验收要加一句『项目有下一次改动之后』」作废：第二轮做成当场生效了。）
7. `hosted-render-contract.md` 第 3.1 节已照实际改好。
8. 契约 `prerender-products-contract.md` 第 16 节末尾第一件说「让本机只为清单里的片段产流（`FramePipeline.streamPicked` 现在只认本机判重的卡）」：实际不用改 `streamPicked`，见「裁定」第 4 条。

## 提交

见最终回复里的列表。
