# AGENT-rr-sem：把「每张卡的 HTML 快照作废」落到语义文档、契约、任务书

分支 `claude/rr-sem`，工作区 `.worktrees/rr-sem`，从 `main` 18acee56 建，交活前合入了 main 8163c6cb。只改 `docs/`，没有改代码和测试。依据是 `docs/plan/html-snapshot-removal-dryrun.md`（对照文档）第 2 节和第 10 节，冲突处以第 10 节为准；快速导出那一条读法用户已在对话里确认（回「是的」），按协调者后来的补充写成「（2026-10-13 用户定）」，不标〔裁〕。

## 做了什么（每个文件的改动处数，按 diff 的块数）

| 文件 | 处 | 要点 |
|---|---|---|
| `docs/semantics/glossary.md` | 5 | 快照、生成快照、轨道流与组流（稀疏版从这条流自己的第一帧起每 15 帧一张）、兜底顺序（去掉旧快照）、卡片级指纹锁、预渲染与预渲染结果（含快速导出也取它）、预渲染小尺寸（停产的说明，原释义保留）。没有加「合并流」词条 |
| `docs/semantics/product/rendering.md` | 5 | 用到的词里「快照」换成「轨道流」；测量（到时限先进编辑）；「两档」换成一档加「先稀疏后满密度」；占位符的「快照还没到」；更好的结果到货那一条 |
| `docs/semantics/mechanism/rendering.md` | 9 | 后台舞台、测量两条、低内存档说明、重管线第二条、指纹锁、形态四条（只有轨道流、两版、怎么产含转场与三维外框、占位符位置）、复用、兜底顺序第 1/3/4 条、旧输入的流不贴（两段并成一段）、在线浏览器的重层、专用实例那一条 |
| `docs/semantics/product/platforms.md` | 6 | 渲染节点表两行、「预渲染结果只有轨道流一档」、播放、渲染任务、取别人的轨道流、导出（快速导出与完整导出） |
| `docs/semantics/product/asset-service.md` | 3 | 去掉「HTML 快照」、删两档那一条、在线浏览器先传小尺寸 |
| `docs/semantics/mechanism/platforms.md` | 3 | 素材效果卡不认领的理由重写、页面内快照库（保留原句加过渡说明）、使用记录去掉本地档与共享档快照 |
| `docs/semantics/mechanism/asset-service.md` | 3 | `bake_card` 与 3D 贴图改成当场渲出的位图（〔裁〕）、在线浏览器先传小尺寸 |
| `docs/semantics/workflow/project.md`（一级） | 2 | 「生成轨道流」没打开时的句子（用户第 13 条认可）、「导出视频」后加快速导出与完整导出一句 |
| `docs/plan/prerender-products-contract.md` | 29 | 序言；第 1 节照表改；第 2、7 节节首标整节作废、原文留下；第 3、4.1、6.4、9.3、11、12、13、16 节逐条标读法或改字；第 14、15 节在序言里一句带过 |
| `docs/plan/render-refactor-task.md` | 17 | 用户的决定第 12 条后加一段并新增 13～22 条；共用契约五条；甲三两处；戊、己、庚、戊二；各项一览改三行、加八行；「语义文档要跟着改的」表；待用户项 |
| `docs/plan/render-standard.md` | 2 | 「预渲染的产物」表最后一行；另外四条的第 2、4 条作废、第 3 条留着 |

`docs/plan/html-snapshot-removal-dryrun.md` 没动（协调者说他已在主仓库改字，合并 main 时已带来）。`mechanism/agent.md`、`document-service.md`、`hosting.md` 没碰。`mechanism/cards.md` 没改。

## 和对照文档「修改前」对不上、我在新原文上改的地方

1. `mechanism/rendering.md`「后台舞台」一句：现在原文后面多了一句 `rr-push-exact` 的〔裁〕。我只改了前半（快照任务那一句），后一句原样保留；把原来的〔裁〕出处和「2026-10-13 随快照作废改写」并成一个括号（原文的「同上」没有所指了）。
2. `mechanism/rendering.md`「旧输入的层不贴」：现在的原文是两段，第二段（轨道流另有自己的输入签名）里还带着「流按全局帧号分段」，且多了甲一、甲三的两条〔裁〕。我照对照文档并成一段只讲流，把「流按全局帧号分段」改成「片段在时间轴上挪了，旧流每一帧都对不上时刻」（分段起点已改成流自己的第一帧，输入签名仍带时间轴位置），甲一、甲三的〔裁〕原样放在下一级子条里。另外加了「画面上的」三个字，区分「单卡流不带画面上的位置」和「片段在时间轴上的位置」。
3. `mechanism/rendering.md` 指纹锁那一句：对照文档只说把「快照、」删掉，删完「各算一种结果」不通，我改成「一张卡的轨道流只出自一种环境……最先为这张卡产出轨道流的环境锁定它」，和术语表那一条对齐。
4. `mechanism/rendering.md`「复用」：对照文档说锁定与接手那半句补之前不写，我照做（删掉了「测量帧存成快照、锁到页面环境、本机接手」那一段和它的〔裁〕）。我查了一下代码：`server/card-lock.mjs` 的注释写明本机的卡片锁只锁「共享档快照」，「本地档、轨道流……本机只有预渲染进程一个产出者，不加锁」；队列一侧 `server/render-queue/queue.mjs` 另有一套按任务的锁，我没有查到流这边的细节。所以接手那一段确实该删，轨道流之间怎么锁怎么接手没有写，留给实现时核对。
5. `product/platforms.md`「渲染任务」：现在原文已有甲二的一句（线上没有能切分任务的节点时自己产单卡流、先查再产）。我保留它，只把「快照任务和」删掉，并按对照文档在后面加「打开项目测量时……先查素材服务，没有才自己产一套稀疏版」。
6. `mechanism/rendering.md` 低内存档说明那一节：对照文档说「有预渲染小尺寸就是它」按「没有」读，现在原文的「停下追一帧」里有两处这个词，我写成「里面的两处」。
7. `product/platforms.md` 纯浏览器一行末尾的「（整屏画面超过体积上限）」：对照文档没点这一处，但体积上限没有了，我改成「（整屏画面太大）」。
8. `workflow/project.md` 项目设置的句子：对照文档的「修改前」是「……只为这个项目生成快照」，现在的原文就是这个，直接换成第 13 条认可的草稿。

## 〔裁〕标注的句子

- 「主会话 2026-10-13 的读法，用户事后审」：`mechanism/rendering.md` 占位符位置（每个分段量一个收紧的框）；`mechanism/asset-service.md` 的 `bake_card` 与 3D 贴图是当场渲出的位图、缓存位图；契约第 1.1 节位置矩形一栏与流清单一行（每个分段一个）；任务书「单卡画面出位图」一行。
- `product/platforms.md` 导出里「只取满密度的轨道流……」带「（2026-10-13 用户定）」，没标〔裁〕（协调者补充）。
- 其余〔裁〕都是被改的句子里原有的，我保留或改写其中的措辞，没有新增。

## 保留没改、留给实现时定的句子（含我加的过渡说明）

- `mechanism/rendering.md`「专用实例多认领一项快照任务」那一条：对照文档写「删掉，还是改成让专用实例帮着产稀疏流，实现时定」。我保留原句，在后面加了一段〔2026-10-13 起没有快照任务……实现时定〕。
- `mechanism/platforms.md`「页面内快照库」：同样保留原句加过渡说明（删表还是改存稀疏流）。
- `mechanism/platforms.md` 素材效果卡不认领的理由：对照文档说措辞实现时定，我按它给的意思写了一版（浏览器里拿像素要先生成这张卡的快照，整屏画面 74 KB～6.5 MB，太大），后面标了「措辞实现时定」，请审。
- `mechanism/rendering.md`「在线浏览器的重层」最后一句：原来「固定成本取卡种成本」，卡种成本那组算式删了，我写成「贴流以后取多少还没有量，实现时量了再写」。
- 兜底顺序第 4 条里的两个时长（500 毫秒等）没有写，对照文档说量过再写。
- 稀疏版收紧矩形的量法（对照文档第 5 节表里「三选一」）、遮罩上限之外的数字，都没有写。

## 其他需要你知道的

- `src/editor/sync/hostedServices.ts` 里「生成轨道流」没打开时的界面文案（第 2.6 节第 1 条，用户第 13 条认可）仍是旧句，我不改代码；**等产稀疏流的那一块（任务书里的「稀疏流二」，托管方认领稀疏任务）改行为时一起换成**：「没有打开：托管方的渲染节点只为这个项目生成隔一段一张的稀疏轨道流。打开后还会补成每帧都有的轨道流，重卡在在线浏览器里播放更流畅，会多用云端的渲染时间。」
- 同一类界面文字：`src/online/lowMemory.ts` 进入低内存档的提示「播放时只看预渲染小尺寸和素材小尺寸」，低内存档改贴稀疏流以后要改（任务书「低内存档贴稀疏流」一行）。快速导出、完整导出两个选项的说明文字是一级的草稿（对照文档第 10.2 节），没写进语义文档，实现时随界面一起用。
- 契约的 13.2 块表、14 节、15 节我没有逐行改，只在节首写了重排说明和「以对照文档为准」，原文留作记录。需要的话可以再细改。
- `mechanism/platforms.md` 第 73 行「导出页……一律用预渲染原尺寸，缺的由导出前的核对拦下并等渲染节点补上」没有被对照文档点名，和新的「完整导出」基本一致，没动；是否要改成「按原尺寸逐帧渲好」请审。`mechanism/platforms.md` 帧库「使用记录」之外，「淘汰」里「整场景目录和它的本地档一起删」的「本地档」也没动（对照文档没点）。
- `mechanism/asset-service.md` 第 10 行（semsync 新加的）说「素材、快照、像素三类各有自己的库」，指素材服务的快照类库，整场景的快照仍会用到，我没改。
- 共用的 scratchpad 目录是各会话共享的，我早先用了 `ed.py`、`gl.py`、`pl.py`、`mr1.py`、`mr2.py` 这几个通用名字写临时脚本，可能覆盖过别人的同名文件（我没有核实原来有什么）；后来改用专属子目录 `rrsem-tmp/`。这些都是临时文件，不影响仓库。

## 搜索核对（`docs/semantics/` 里搜「快照」「小尺寸」「每 3 帧」「1/3」「帧率为项目帧率」）

「每 3 帧」「1/3」「帧率为项目帧率」：0 处命中。「快照」「小尺寸」剩下的命中，分类如下，都是判断应该留着的：

- 整场景的快照或当场生成、画成位图就丢的：`glossary.md` 快照与生成快照两条；`mechanism/rendering.md` 后台舞台一句、测量里生成快照的三段耗时、界限搜索里「不生成快照」；`mechanism/cards.md` 可定位的判法；`guide_files/` 里的用词约定、验证表（「导出与快照重放一致」指整场景）。
- 与渲染无关的别的「快照」：全局修改状态检查与保存时固定非本机的确定快照（`glossary.md`、`mechanism/document-service.md`、`hosting.md`、`product/document-service.md`、`workflow/project.md`）；Agent 的选中内容与播放头的消息快照（`product/agent.md`、`mechanism/agent.md`、`workflow/production.md`）；本机对话报告里的环境快照。
- 素材小尺寸（素材的缩小副本，不是预渲染小尺寸）：`product/platforms.md` 素材闸门与最低一档、`mechanism/platforms.md` 素材闸门、`mechanism/hosting.md`。
- 带着过渡说明保留：`glossary.md` 预渲染小尺寸（停产说明加原释义）；`mechanism/rendering.md` 低内存档那一节里「预渲染小尺寸」的两处（节首已写按「没有」读）；`product/rendering.md` 那条「原来的预渲染小尺寸……停产」；专用实例那条；`mechanism/platforms.md` 页面内快照库；`mechanism/rendering.md` 声音记录存在「页面内快照库的成本表」（库名，成本表还在）。
- `mechanism/asset-service.md` 第 10 行（素材服务里的快照类库），见上。

## 验证

- `npx tsc -b --force`：退出码 0，无输出。
- `npm test`：见下面「基线结果」。
- 行尾：本机 `core.autocrlf=true`，工作区文件是 CRLF，我写回时用 LF，提交的内容是 LF；`git diff --stat` 里没有哪个已有文件的增删行数接近整份文件。

## 基线结果

- `npx tsc -b --force`：退出码 0。
- `npm test` 全量（设了那两个环境变量）：6479 条，通过 6447，失败 12，取消 2，退出码 1。失败的 12 条分布在 14 个文件里，全是进程、端口、超时、真 ffmpeg 一类（机器当时 CPU 100%、66 个 node 进程，别的子 Agent 在跑）：accept-018-auth-agent-path、accept-018-files-proc-damage、accept-018-files-recovery-states、accept-018-rest-ssr-seam、account-master-production、account-runner-process、artifact-push、asset-project-workers、c66-integ、card-lock-pipeline、cloud-agent-page、cloud-tools-p1-shots、docservice-http-transport、user-editing。没有一个读文档用词。
- 单独重跑这 14 个文件：143 条通过 135，失败 2（account-runner-process 的「真实运行器在任务进程里」、artifact-push 的 W1，仍是忙时超时）；再各自单独重跑这两个文件：artifact-push 7 条全过（退出码 0），account-runner-process 1 条过（退出码 0）。所以 14 个文件单独跑都是绿的，没有改松或跳过任何测试，本分支没有改任何代码和测试。
