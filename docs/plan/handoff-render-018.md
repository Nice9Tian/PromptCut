# 交接：渲染重构与 0.7.18 做到哪了（2026-10-14 收工）

给接手的会话看。不看对话也能接上。开工指令仍是 `render-018-kickoff.md`，用户的决定仍以 `user-decisions-2026-10-13.md` 为准；本文只写现场。更早的现场在 `handoff-render-refactor.md`。

## 1. 为什么停、现在在哪

- **停的原因**：周额度到线（开工指令「什么时候停」第 5 条：用到 90% 不再派子 Agent、各分支提交并推送、写交接文档、停下等用户重新开工）。2026-10-14 11:30 是 90% 上下，额度 2026-10-19 10:00（日本时间）重置。
- **`main`**：`e2d46f53`（之后只有本文和两份进度文件的文档提交），已推送，主工作区干净。`release` 仍指向 0.7.17（`073c8cca`），0.7.18 没有发。
- **没有在跑的子 Agent**，没有残留的后台进程。节点上没有留下临时东西，生产服务没动过（上一次核对主进程号是 279515、279516、279517）。VisuHive 仓库在 `main`、干净；本机分支 `claude/v18-logout-text`（`25ecb2e`）没推送，部署时用。
- 两份进度文件（`render-refactor-progress.md`、`three-versions-progress.md`）记到今天 06:00 的合入；之后合入的六块只记在本文第 2、3 节，接手后第一件事是把它们补进进度文件。

## 2. 渲染重构：任务书逐项

任务书是 `render-refactor-task.md`；用户 2026-10-13 对「每张卡的 HTML 快照作废」那 17 条的决定带出的块也列在这里。

| 项 | 状态 | 提交或原因 |
|---|---|---|
| 甲一：在线浏览器经任务队列生成并播放轨道流 | 已合入 | `5cb386ef`，推帧一致性 `34fcee57` |
| 甲二：本页产流 | 已合入 | `a4e26487`；先稀疏后满密度、测量时就产在 `b808cfe5` |
| 甲三：云端渲染服务按「生成轨道流」产流 | 已合入 | `c51ae4ae`。节点部署后的真实网络环境验收没做，随 0.7.18 的部署 |
| 乙：remotion 式的框架 | 已合入 | `cd907bb2`；「干净版」统一换键 `16d2404b` |
| 丙：改建卡指南 | 已合入 | `3e8953c4` |
| 丁：分类登记表 | 已合入 | `393b0b2a` |
| 戊：不回放 | 已合入 | `f007ed86`、`34fcee57` |
| 戊二：依赖下层的卡也产轨道流 | 已合入 | 下层一 `d9185eed`、下层二 `3a22ab8d`、下层三 `21807232`、下层四 `b41dd99b` |
| 戊二里的一小项：依赖下层、又带三维外框的卡 | 已合入 | `c06e7f3e`。用户一直没回选哪种，主会话按建议的甲定（二级〔裁〕，已播报，可以推翻）：产带着三维变形的舞台坐标流，贴的时候不再做变形；改三维角度流要重产 |
| 己零、己一：画布取像素 | 已合入 | `c276d926`、`d90c709b` |
| 己三：暂停和拖动也贴轨道流 | 已合入 | `6d114b4e` |
| 己二，改成「撤快照」：每张卡的 HTML 快照的生成、存放、推送、取用全撤 | **未达成** | 它排在「各类卡都有流、在线导出有新来源、低内存档能贴稀疏流」之后。三样今天才齐（低内存档那一样真手机还没量），额度到线，没开工。要撤的东西列在 `html-snapshot-removal-dryrun.md` 第 4.8 节；分界是 `src/editor/snapshotFeed.ts` 的 `planFeed` 里 `if (covered.has(clip.id)) continue;` |
| 己三乙：预算从数个数改成数像素、流层共用一个 WebGL 上下文、占位符用位置矩形 | 已合入 | `d92bcab8`。同屏不超过 6 条照旧一律放行，第 7 条起看像素预算（约 15 亿像素每秒，等于原来「6 条满屏 1080p、60 帧」的量），条数上限 32；页面与服务端共用 `src/render/streamBudget.mjs`。独立审查后返工过一轮（第一版会让大于 1080p 或高于 60 帧的项目退化）。用户还没回「合并流先不做」这个做法认不认 |
| 庚 | 取消 | 用户 2026-10-13 定 |
| 辛：两条导出路各量一遍 | 已合入 | `defe591d` |
| 癸：Lottie 改成 remotion 式 | 已合入 | 癸一 `5ad05da7`、癸二 `da959433`（浏览器节点放开产 Lottie 的流，主会话的三级〔裁〕） |
| 稀疏流一、二：分段起点、每段只截第一帧、位置矩形进清单、队列里的稀疏流任务 | 已合入 | `993492fe`、`f3e7d5e7` |
| 稀疏流三：在线页面测量时就产稀疏版、遮罩 50 秒、播放保活 | 已合入 | `b808cfe5`，机制文档 `aa5ee127` |
| 第 7 条的两类卡：转场和套在视频上的素材效果卡连同视频产一条流；三维外框的卡产变形之前的流 | 已合入 | `162a72be` |
| `bake_card` 和 3D 视图贴图不再存每张卡的 HTML | 已合入 | `2fb3cfa5` |
| 合并流 | 评估已合入，本身没做 | `9ab76ebf`。结论和做法在 `render-refactor-progress.md` 待用户项 1.5 |
| 在线浏览器导出分「快速导出」「完整导出」 | 已合入 | `31c4a314`，独立审查后的返工 `2bccf3aa`（失败后再点导出、渲染节点中途消失或页面断线不再无限等：3 分钟没有进展就判失败）。本页不执行的卡由渲染节点为这次导出逐帧渲成无损图片；用一张每帧都在动的卡量过，贴进成片不差一帧。**发版前还要做两样**：导出位图用完不清理、只为导出的计划没有限流。快速导出里组流不取，依赖下层的流那一支贴法没有真跑过 |
| 低内存档（手机、平板）贴稀疏流 | 已合入，真手机没量 | `653a11bf`。低内存档里判重的卡播放、暂停、拖动时贴轨道流每个分段的第一帧（那一段是满密度也只解这一张）；同屏最多 4 个解码器、画幅之和不超过两张 1080p 满屏卡，超出的显示占位符；没有流的照旧贴预渲染小尺寸（过渡用，撤快照时删）。这台 PC 强制低内存档量到：单条流每秒解约 1.8 帧，解码帧内存峰值约 20 MB。**真手机上要用户配合量一次**，量什么、多少算过在 `docs/reports/AGENT-rr-lowmem-streams.md` 第 7 节 |
| 素材上传先传小尺寸、再传原尺寸 | 已合入（在线浏览器导入没做） | `afff3cd8`。上传队列从「逐个素材先小后大」改成所有素材的小尺寸先传完、再传原尺寸；桌面导入、进云端项目后的补传、搬到云端、成员补传都走这个队列。在线页面的「导入媒体」本来就是置灰的，这条路径在代码里不存在，所以现在没有「云端只有原尺寸」的窗口；要做在线导入得新做页面上传和浏览器里转视频小尺寸，评估和建议在 `docs/reports/AGENT-rr-small-first.md` 第 3 节。云端 Agent 采集的视频只有原尺寸一档，没改 |
| 桌面版播放保活（对照文档第 1 节第 6 件） | 已合入 | `dadb6812` |
| 推帧补画（今天查出来的老毛病，不在任务书里） | 已合入 | `366c2f91`。全部轨道流的键、全部 101 张内置卡的预渲染键各变一次，已有的预渲染结果要重渲 |
| 壬：改旧名词 | 没做 | 照开工指令放在 0.7.18 的在途分支都合完之后 |
| 收尾：`main` 上跑整套渲染附加项、写 `docs/reports/REPORT-render-refactor.md`、子 Agent 报告归档 | **未达成** | 要等上面几项做完。`REPORT-render-refactor.md` 还没写 |

## 3. 0.7.18：各块

已合入的各块和提交号在 `three-versions-progress.md`「本次做了什么」的表里。今天另外合入两块，还没记进那张表：

- **舞台端口来的请求只放行白名单，外加两处小修**：`02e286a8`。白名单只写在 `server/stage-gate.mjs`。
- **账号办法的「本地项目搬到云端」**：`087efab4`。独立审查后返工过一轮；界面文字全是草稿，表在 `docs/reports/AGENT-v18-move.md`。
- **语义与契约跟上（第二轮）**：`1f2bb0a3`，只改文档。22 份子 Agent 报告里的更正建议逐条对代码核过，三级机制文档和 `docs/plan/` 下的契约、任务书、部署清单改了约 85 处。二级 7 条、一级 4 条没改，「修改前 / 修改后」在 `docs/reports/AGENT-v18-semsync2.md` 第三、四节，等用户定。所以上面「还没做的」第 1 条里三级的部分已经做了。

还没做的：

1. 语义文档里 Agent 机制几处跟上（`mechanism/agent.md` 的「已实现，还没挂载」「播放头恒为 0」「page-results 回 503」、删除对话的机制、工具表接线第一期的进程分工；建议的原文在 `AGENT-v18-wire.md`、`AGENT-v18-chats.md`）。
2. 验收清单登记后合入的探针：2026-10-14 已做一轮（`1acf25c4`），27 项登记进清单，`node scripts/acceptance/four-stage-acceptance.mjs --check-coverage` 退出码 0；新登记的探针没有实跑，整套验收时跑。之后再合入的探针仍要登记。三支探针的端口写死在 286xx～289xx，不随运行器的端口基数走（`docs/reports/AGENT-v18-accept-reg.md`）。
3. 在线浏览器层的隔离探针改走账号入口。
4. 等渲染重构做完才能做的：本地取帧优先（块十）、渲染服务接账号项目与素材拼图、`get_gif`、音频测量脚本（块十一）、工具表接线第二期。
5. 改旧名词。
6. 整套验收（38 行结论表）、改版本号、出完整安装包和兼容补丁、推进 `release`、节点部署、真实网络环境验收、删节点上的旧数据。**这些一样都没开始。**

## 4. 还留着的分支和工作区

这次任务自己建的分支和工作区都已合入并清掉，没有留着的。`.worktrees/_export-baseline/` 不是工作区，是导出像素比对用的脚本和基线帧，留着。

`codex/018-browser-doc-read`（只修了一支已拿掉的探针）和交接计划书 `handoff-render-refactor.md` 第 5.4 节那几条不属于这次任务，没动。

## 5. 接手后按什么顺序做

1. 读本文和两份进度文件，查周额度，把第 2、3 节里今天合入的几块补进进度文件。
2. 在线导出发版前还差两样（建议的做法在 `docs/reports/AGENT-rr-online-export.md` 第 10.4 节）：为导出渲的无损图片和清单用完不清理，会一直占素材服务的配额；项目里任何能发布任务的成员都能发只为导出的计划（名次压过所有预渲染）、没有限流。另外页面断线那一种只有单测，没进端到端探针。
3. 撤快照之前还差一样：低内存档贴稀疏流已经合入，但要用户拿真手机量一次（量什么、多少算过在 `docs/reports/AGENT-rr-lowmem-streams.md` 第 7 节），量过了再撤。撤快照分服务端一半、页面一半；撤的同时把测量里原有的「快照趟」、`see_frames` / `get_gif` / `get_layout` 顺手写每张卡快照的那一步、「暂停和拖动贴流」里只对有流的卡生效的判断放宽到全部重卡。
4. （看用户要不要）在线浏览器导入素材、云端 Agent 采集的视频补小尺寸：评估在 `docs/reports/AGENT-rr-small-first.md` 第 3 节。
5. 渲染收尾：`main` 上跑整套渲染附加项，写 `REPORT-render-refactor.md`，报告归档。
6. 0.7.18 剩下的（第 3 节），然后验收、发版、部署。

## 6. 今天新增、要用户定的

完整清单在两份进度文件的「待用户项」。今天新增、还没写进去的：

- **搬到云端的几条做法**（二级，已播报，可以推翻）：协作房间只有以创建者身份进入的人能搬，不再认当初开房间的那台设备；搬上去的是新项目，版本从头计（和语义里「版本号连续」不同，语义要改）；限定进入的房间搬上去后，知道链接并登录了就能加入，原来被踢的人也能进（旧的禁入名单对不上账号）；失败后云端已经建好的项目留着不删，再点一次接着用；搬完自动存一次本机；同一台电脑另一个窗口在搬时直接拒。另有：界面文字表；两台设备的创建者同时搬要不要做「正在被搬」的标记；关房间后页面在存本机之前就没了的那几十毫秒要不要堵。
- **账号项目的设置里还显示着旧办法的按钮**（「作废并重新生成邀请码」「改项目密码」「改创建者密码」「已禁入的设备」和一句「这台设备上没有邀请链接」）。截图 `docs/reports/assets/v18-move/room-4-done.png`。建议收起来；属于界面取舍，没动。
- **在线导出的几条做法**（二级）：在线导出不再因为重卡没预渲染好而等，只有导出页不执行的卡才等渲染节点；等待的话挪进导出进度窗口；节点渲不了、任务失败、等的时候项目被改，直接失败并说明；快速导出里组流不取。新加的界面文字表在 `docs/reports/AGENT-rr-online-export.md`。
- **Agent 抽帧整体早一帧**（见第 7 节第 1 条）修不修。
- **在线导出等渲染节点时，3 分钟没有进展就判失败**（二级，返工时加的，原来这一步不设时限）。提示是草稿：「渲染节点已经 3 分钟没有进展（可能已经离线），这次没导出来。请确认渲染节点在线后重新导出。」
- **依赖下层、又带三维外框的卡按甲做了**（二级，已播报）：流里直接画进三维变形后的画面，改三维角度要重产。另一种选法是不给它产流、播放和拖动时显示占位符。
- **己三乙的三个数**（三级，可以改）：像素预算约 15 亿像素每秒、同屏 6 条以内不看像素、条数上限 32。同屏最多 32 条流以后，解码出来的画面占的内存保底上界从约 113 MB 变成最多约 225 MB。
- **低内存档的两条做法**（二级，已播报，可以推翻）：手机、平板上同屏第 5 条流起、或各条流画幅之和超过两张 1080p 满屏卡时，超出的层不贴流（撤快照以后这些层就是占位符）；起播和跳转时不等流的第一帧，这一层会空一下（等的话四张卡同屏起播头三拍每拍要 160 毫秒）。另有一句给用户看的字没改：进入低内存档时的提示还写着「播放时只看预渲染小尺寸」。
- **11 条已经做出来、但和语义文字对不上的行为**（二级 7 条、一级 4 条），要用户点头才能改文字：`docs/reports/AGENT-v18-semsync2.md` 第三、四节。

## 7. 今天查到、没修的

1. **抽帧拿到的第 f 帧等于整段导出的第 f+1 帧**（`see_frames`、只取几帧的导出；老问题）。原因：窗口规划按提前量挂卡，整段导出的 `FrameScene` 在片段起点才挂。修它要动 `src/render/FrameScene.tsx`。出处 `AGENT-rr-push-draw.md`。
2. **同一份代码导两次，头 36 帧会落在两种结果之一**（老问题）。在线导出里同样量到：导出页自己逐帧渲的 motion 式内置卡在入场动画那一段，七遍里一遍不同（第 23 帧药丸卡 173 个像素，第 36 帧章节条 11184 个像素）。根因没查；`AGENT-rr-push-draw.md` 留了一个没验证的推断（预热那几拍不带截图）。
3. **`stream-below-stage-probe` 在 `main` 上偶发一两帧对不上**（丙场景整幅、甲场景上面的活卡；机器占满时更容易）。没查清是探针的等待还是贴流一侧的事。
4. **流和预览里活渲的毛玻璃同一帧差 4.5～5.4**，不是编码误差的量级；入场动画里的帧，流比页面活渲慢约一帧。哪一边对着导出页没查。出处 `AGENT-rr-below-online.md`、`AGENT-rr-below-paste.md` 第 7 节。
5. **舞台端口那道闸管不到的三处**：舞台里的卡仍能跨源调预渲染进程的接口；退回同源单舞台或低内存模式时没有这道闸；卡片能按哈希读本机素材库里任何素材。
6. **部署前要验**：舞台端口的白名单只放行路径里带 `/node_modules/` 的依赖。托管渲染服务把开发服务器的预构建缓存目录另设了（`PROMPTCUT_VITE_CACHE_DIR`，`server/hosted-render/main.mjs`）；它的工作进程要是经舞台端口取依赖，舞台会空白。桌面版不设这个变量，不受影响。跑一遍 `hosted-render-streams-probe` 和 `render-host-probe` 就知道。
7. **满密度流任务偶尔卡在最后一个短分段**（做完 75 帧后 120 秒无进度被收回，机器占满时见到三次）。没查清是机器忙还是产流一侧的事。出处 `AGENT-rr-below-online.md`。
8. `BELOW_DISCARD_SHOT`（下层三的局部修法）在推帧补画合入以后多余了，留着没删，两处不打架。`AGENT-rr-below-paste.md` 第 11.2 节说的根因（「上面压着别的卡」）不对，以 `AGENT-rr-push-draw.md` 为准。
9. `online-stream-play-probe` 的 S6（组流起播后约 170 毫秒里，流已经在画，占位符却还盖在上面）已修：`6474b669`。原因是「这一帧快照没到」的判据不看流在不在画；改成这张卡的流这一拍在画就不显示占位符。这支探针在 `main` 上现在全过。
10. 机器占满时偶发失败的测试，今天又见到的：`cloud-tools-p4-subject`（`subject_install` 一条，`main` 上三遍过两遍）、`asset-project-workers`、`c66-integ`、`cloud-agent-scope`、`multi-agent-presence`、`move-guard`、`codex-auth-state`、`account-page-link`、`account-worker-lifecycle`、`account-op-resend`、`account-runner-process`。每次都单独重跑确认过。
11. **`hosted-render-streams-probe` 在 `main` 上退出码 1，是探针的判据过时了**：它等「暂停后流的轨道撤掉」才截参照图，而「暂停和拖动也贴流」合入以后轨道本来就留着（`page-stream-probe` 已经改过同一处，改成看包裹层没被抑制）。2026-10-14 在 `main` 上跑过：渲染服务起得来、产得出流、页面看得到，所以舞台端口的白名单没有碰坏托管渲染那条路（第 6 条的担心在本机验过了，节点上部署后再看一眼）。
12. 在线页面和切分方算同屏流预算时判得不一样（在线页面没把依赖下层的流算进去）：已修，`e2d46f53`。认定「依赖下层的流」「单独成流的卡」的规则挪到两边共用的 `src/render/streamPlanRules.mjs`，服务端的计划逐字不变；加了对拍单测。页面不读服务端「依赖下层的流」的开关，按缺省开算。
13. 己三乙留下的：条数超过 32 且没有可并的一对时，那一帧的像素没再检查（页面占位符兜底）；预算以内的流的占位符仍用整条流的矩形，没改成分段的；真编辑器加真预渲染进程下同屏 30 张卡没跑，笔记本和核显没量。`server/frame-pipeline.mjs` 约 3292 行的注释还拿「依赖下层又带三维外框的卡」当没有流的例子，已过时（改它会动代码版本，留给下一次动这个文件时顺手改）。
14. 低内存档贴稀疏流留下的：在线来源没读流清单里每段的位置矩形，所以在线页面（普通档也一样）超预算层的占位符位置还是老办法；流的字节整段取（按哈希存取，取不了半块）；解码中途连着报错时落到占位符而不是小尺寸；「有小尺寸就贴小尺寸」和组流、依赖下层的流、源依赖卡的流在低内存档只有单测；起播头一拍、卡入场那一拍仍有约 40 毫秒乘在场卡数的活渲（父页的抑制晚到一步，没在 `main` 上对照量过）。
15. `product/asset-service.md` 写着「在线浏览器导入素材时在页面里转出素材小尺寸」，但代码里没有这个功能（在线页面的「导入媒体」是置灰的）；是二级文字，没改，要用户定是补功能还是注明未实现。另有一个小窗口：本机转码登记里没有的老视频进上传队列时只带原尺寸，通常由打开项目时的补转补上，没改。
16. 第 11 条说的 `hosted-render-streams-probe` 判据已修（`1acf25c4`），在 `main` 上退出码 0；`online-stream-play-probe` 的 S5 是同一处判据，也修了。

## 8. 发版与部署要记住的

- 发版前：填 `server/recovery/gone-proof.mjs` 的 `TRUSTED_GONE_AUTHORITIES`（签发者编号和公钥从节点的文档服务取；旧文件里的服务地址至少有三种写法，见 `three-versions-progress.md`「三、四」那一行）；验收用运行器出 38 行结论表，要在 VisuHive 新后端上、机器空闲时串行跑；在线导出的导出位图清理和限流要先做。
- 部署顺序：先账号后端（VisuHive 本机分支 `claude/v18-logout-text`，`site/` 一推就上线）→ PromptCut 各服务 → 网页。线上舞台站点的 nginx 要换两行（先 `nginx -t`）。Agent 服务账号版照 `server/hosted/deploy/README.md` 的九步；`node_modules` 要带 `puppeteer-core`；`PROMPTCUT_AGENT_COLLECT_DELEGATE=1` 先不开。第 0 步是一致备份加恢复演练（仓库里没有脚本，上一次手工做的记录在 `docs/archive/three-versions-production-restore-2026-10-09.md`）。
- 在线编辑器和渲染节点要重新构建部署，今天合入的在线页面改动（测量时产稀疏版、读依赖下层的流、导出两种方式）才生效。预渲染结果的键今天又换了一次，部署后旧的流全部重产。
- 删节点上的旧数据：用户已按类别定（`three-versions-progress.md` 里有表）。删之前一致备份并实际验证能恢复；删掉的每一样在节点上留着验证过的备份；精确清单里不属于任何一类的条目再问用户。

## 9. 做法备忘

- **合入前的闸门**（主会话自己跑）：分支工作区先并 `main` → 查有没有文件被整份换了行尾 → `npx tsc -b --force` → `npm test` → 这一块自己的探针 → 导出像素比对（240 帧要和 `89c15177` 的两种结果之一逐字节相同）→ 两支键的比对（`card-source-version-compare`、`card-table-digest-compare`）。全量里失败的文件单独用 `npm test -- <文件>` 重跑（直接 `node --test` 会因为缺开关假失败）。闸门脚本和导出比对的脚本不入库，位置记在 `docs/local.md`。
- 跑全量测试要设的两个环境变量在 `docs/local.md` 文末；起开发服务器一律带 `PROMPTCUT_NO_PORT_FILE=1`。
- 同时跑的子 Agent 不要超过五路：六路时 CPU 一直 100%，全量测试每遍都有两三条偶发失败。
- 大块合入前另派一位不带作者结论的独立审查，今天「搬到云端」那一块又查出两处必须改的。

---

## 10. 2026-10-16 交接：渲染重构 100% 完成，0.7.18 合入三块后因周额度 `< 10%` 收工

### 10.1 为什么停、现在在哪

- **停的原因**：触发 `agy-usage` Quota Guard 周额度保护线（`< 10%`）与 `render-018-kickoff-other-agents.md` 第 3 节规定（用到 90% 停止开新内容、在途子 Agent 收尾合入并写交接文档）。2026-10-16 18:28（JST）实测 `agy -p "/usage"`：
  - `Gemini Models`：周额度剩余 **`9%`**（重置时间 `2026-10-22T11:04:28Z`），5 小时额度剩余 `28%`（重置时间 `2026-10-16T12:07:47Z`）；
  - `Claude and GPT models`：周额度剩余 **`0%`**（重置时间 `2026-10-22T21:13:58Z`），5 小时额度 `disabled`。
- **仓库与工作区状态**：
  - PromptCut 主工作区（`C:\Users\admin\Documents\PromptCut`）：在 `main`、干净，最新代码合入提交 `301f8a39`（连同本交接与进度更新提交已推送 `origin/main`）。
  - VisuHive 主工作区（`C:\Users\admin\Documents\VisuHive`）：在 `main`、干净，最新本地提交 `0e64fbe`（已在 `main` 合入 `gemini/vh-stream-perm` 权限分组后台与无默认管理员修正，以及 `gemini/vh-revoke-logout` 主动撤权通知、45 秒超时、折叠详情与不退出文案更新；领先 `origin/main` 7 个提交，照部署顺序在部署节点时推送）。
  - **无未合入分支、无残留 `.worktrees/*` 工作区**（仅保留 `.worktrees/_export-baseline/` 像素基线目录）、**无在跑子 Agent 或残留后台进程**。

### 10.2 本轮（2026-10-15～2026-10-16）已完成并合入 `main` 的全部内容

1. **渲染重构（Phase 1）全部完成并合入 `main`（至 `0d6dec22`）**：
   - `08fb7cd9`（`rr-sem-1014`）：同步 `user-decisions-2026-10-14.md` 全部一级、二级、三级语义与契约文档。
   - `16fe6882`（`rr-mobile-lowmem`）+ `5b947ca8`（`rr-mobile-node-wire`）：低内存提示文案更新、手机/平板打开项目也为本页产稀疏流（先过 `VideoEncoder.isConfigSupported`，连错 3 次停产，不认领队列任务 `claims === 0`）、`page-stream-probe.mjs` 本机模拟手机自动化闸门。
   - `69d791ed`（`rr-frame-bake3d`）+ `61600a5b`（`rr-bake3d-stream`）：修复 Agent `see_frames` 抽帧早一帧、修复导出开头 36 帧偶发差一帧、画布卡产流缺省改为 `'always'` 直取像素、3D 视图板子贴图在播放时取轨道流随时间动态更新且打开 3D 模式时轻卡也产流、更新 `bake_card` 工具说明区分 HTML 快照与 PNG 快照。
   - `f83500d2` / `987de00c`（`rr-stage-export-media`）：在线舞台一律跨源隔离（撤掉同源单舞台退路）、桌面版舞台锁死（禁调预渲染接口、按哈希读素材只许读当前项目）。
   - `8a41fcd3`（`rr-stream-sched` + VisuHive `47be5d4`）：「生成轨道流」关闭时托管渲染节点稀疏与满密度都不产；增加 `render_streams` 权限分组与 VisuHive 管理员后台，去掉 `ACCOUNT_ADMINS` 默认管理员。
   - `cf8f3e1c`（`rr-media-import`）：放开在线浏览器导入本地媒体，浏览器内用 WebCodecs + `mp4Mux` 先转视频小尺寸，严格按「所有小尺寸先传、再传原尺寸」上传到素材服务。
   - `57bab25d`（`rr-motion-preempt`）：`motion` 式卡产流任务按至少 30 秒切分（`remotion` 式保持 8 段 4 秒）；强设备（桌面 > 托管 > 浏览器）可抢弱设备在途流任务并保留已传分段；时间轴拖动保活（S2）。
   - `576ad0a3`（`rr-online-export-stage`）：在线浏览器导出在跨源隔离舞台内整帧活渲本页可运行的同步用户卡与素材效果卡，保留「快速导出 / 完整导出」，补齐 `export-frames` 24 小时 TTL 清理与限流。
   - `59b85f09`～`35b0a803`（`rr-rm-snap-page`）+ `e13c6bcb`、`3641145e`（`rr-rm-snap-server`）：己二彻底撤掉页面、舞台、服务端与预渲染进程中每张卡的 HTML 快照及 `.small.webp` 预渲染小尺寸；放宽暂停/拖动下 `scrub` 的抑制范围至无流非 `remotion` 重卡；在 `server/stage-gate.mjs` 放行 `/@id/__x00__vite/dynamic-import-helper.js`。
   - `52d3d2b5` / `0d6dec22`（`rr-g0r-probes`）：更新 `preview-fallback-probe.mjs` 与 `ready-index-probe.mjs`，在 `main` 上实跑通过 G0-R 全套收尾验证（240 帧确定性 `240/240`，导出像素基线比对 `A-89c15177` `240/240` 逐字节相同），提交 `docs/reports/REPORT-render-refactor.md`，并将 59 份 `AGENT-rr-*.md` 归档至 `docs/archive/agent-reports/`。

2. **0.7.18（Phase 2）已完成并合入 `main` 的三块（至 `301f8a39`）**：
   - `611fb04c`（`v18-revoke-logout` + VisuHive `fbe86bb`、`9f40aaa`、`0e64fbe`）：落实 10-14 第 3.0.1 节与第 3.2 节（撤掉 90 秒连接轮换与轮询，账号服务主动通知文档服务撤权并带握手确认与 15 次指数退避重试、重连按 `sinceSeq` 补齐；改密退出超时改为 45 秒、调试信息缺省折叠、「不退出」文案更新）。
   - `0ba84411`（`v18-move-proc`）：落实 10-14 第 3.3 节与第 3.4 节（本地项目/协作房间搬到云端保持原 `projectId`、连续历史序号 `rev` 与操作历史；`<= 0.7.17` 旧版拒绝并提示「当前软件版本已过期，无法搬到云端」；「版本号」改称「历史序号」；协作房间搬完提示「原来的禁入名单没有带过去」；项目设置提供「作废并重新生成项目链接」「项目二级密码」并收起旧按钮；另存 `.proc`/`.procp` 带 `cloudAssociation` 与实时 `savedRev`，重开按四条规则处理并由 `DocSync.mergeOffline` 增量合并离线修改）。
   - `301f8a39`（`v18-chat-workflow-jobs`）：落实 10-14 第 3.1 节（后台作业排队等待提示与 1 小时超时中断说明、`auto_workflow` 主体识别缺省可选且按 `commitKey` 防重复叠放）与第 5 节（共有对话设为私有时成员端刷新仍记撤销、停止重连、禁用输入框、顶栏改为「已无读取权限」）。

### 10.3 下次接手后的顺序（直接从 `0.7.18` 剩余四块开始，无需重跑渲染重构）

0. **2026-10-17 核对与修复（已完成并合入 `main` 至 `a6011825`）：main 全量测试已修回 100% 全绿。**
   - `0e99dd63` 上 `npm test` 7011 条里 58 条失败（见 `docs/reports/VERIFY-main-2026-10-17.md`）。
   - 经三路分支修复并独立审查后以 `--no-ff` 合入 `main`：
     - `3e890c91`（合入 `6e379784`，报告 `docs/reports/AGENT-v18-fix-queue-streams.md`）：在 `server/hosted/files.mjs` 补齐 `server/render-node/session.mjs`、`filter.mjs`、`pick.mjs`；新增 `src/render/streamBuckets.mjs` 解决 60 段 `motion` 任务与整卡稀疏任务跨全局 8 段桶边界（如 `56-63`）读写对齐及浏览器 `putStreamManifest` 分桶写入；在 `session.mjs` 与 `render-queue.mjs` 补齐抢占前置资格预检（含 `throttled`、`!planOnly`、`streamsPass`）与拦截回 `task.claim-rejected`；更新队列与流测试切分断言。
     - `a08d1c72`（合入 `469a03f5`，报告 `docs/reports/AGENT-v18-fix-snap-tests.md`）：核实 `beatSwapDebug().last` 无生产空指针隐患，将撤快照页面侧 8 个测试文件（14 条）对齐到撤除每张卡 HTML 快照后的新契约。
     - `a6011825`（合入 `f63fd975`，报告 `docs/reports/AGENT-v18-fix-account-tests.md`）：在 `server/account/authority.mjs` 恢复带 `authorizationId` 请求对账号权威的实时 `accountClient.verify` 与 `synchronize` 重核（`operation-wiring-core.test.mjs` 与 `account-assembly-central.test.mjs` 零改动原样通过），同时保持已建长连接不按本地 120 秒时钟断开，并更新其余账号与守门测试。
   - **合并后 `a6011825` 上的类型检查与全量测试结果**：
     - `npx tsc -b --force`：**0 错误**（退出码 0）
     - `npm test`：**共 `7020` 条：`7005` 通过、`0` 失败、`14` 跳过、`1` todo**（耗时 161.8 秒，退出码 0）。

1. **分支 A（`v18-collect-reboot`，已完成并合入 `main` `d202052c`，分支提交 `e632ac0e`，报告 `docs/reports/AGENT-v18-collect-reboot.md`）**：
   - 打开采集代下（在 `server/upload-queue.mjs`、`server/vite-plugin-media.ts` 补撤回并删除在途文件接口并接入 `src/ai/cloud/collectBridge.ts`，已传完文件不误删；将 `PROMPTCUT_AGENT_COLLECT_DELEGATE` 改为缺省开启；桌面版代下时显示 `「云端 Agent 正在用这台电脑上的登录下载：〈网址〉」`）与 `web_handoff`（让发起人自己电脑浏览器打开同一网址）；
   - 节点重启后自动恢复任务槽（支持跨 `boot_id` 见证 `kind: 'boot-transition'` 与 `/run` tmpfs drop-in 重建，涵盖在途卡住槽与空闲已关闭槽），并把重启那一刻在跑的任务自动记为 `failed`（`worker-failed`）并释放（10-14 第 3.1 节）。
   - **合并后 `d202052c` 上的类型检查与全量测试结果**：`npx tsc -b --force` **0 错误**；`npm test` **共 `7025` 条：`7010` 通过、`0` 失败、`14` 跳过、`1` todo**（耗时 160.8 秒，退出码 0）。
2. **分支 B（`v18-block10-turn-lock`，已完成并合入 `main` `23f078b3`，分支提交 `742490e4`，报告 `docs/reports/AGENT-v18-block10-turn-lock.md`）**：
   - 块十 + `user-decisions-2026-10-16.md` 第 3 节「0.7.18 暂行：云端 Agent 按轮占用」+ `look` 私钥只由主服务持有并代签：
     - 云端 Agent `see_frames` 出图先后：`成员的桌面版 > 身份为电脑的在线浏览器 > 托管方的渲染服务 > 身份为手机的在线浏览器`；
     - 托管方的渲染服务接进账号项目（`hosted.watch`、`hosted.ticket`、数据连接 `auth.ticket` 素材票据）；
     - 无成员设备辅助的项目按轮占用云端渲染服务（首次向云端要画面起占，本轮收尾含后台作业或被叫停才放开；30 秒心跳、2 分钟超时；别的项目排队并在对话里显示 `「云端渲染正在给别的项目用，排在第 N 位，轮到了会接着做。」`；排队不计时，真正开始渲染起算 **3 分钟** 超时、一次不重试、超时回 `「渲染超时」` 与调试信息；队列 10 分钟不动回 `「排队异常」`；有 Agent 排队时产流做完当前任务让出；流产满且 5 分钟无修改时关掉装着的项目；多个有真人在线的项目要产流时每 5 分钟轮换）；
     - 在 `docs/reports/ACCEPT-018-map.md` 与 `scripts/acceptance/four-stage-manifest.mjs` 补齐 `RS18-local`、`RS18-queue` 验收命令，实跑 `hosted-render-queue-probe.mjs` 14/14 全过（一轮结束 1.066 秒即让位）。
   - **合并后 `23f078b3` 上的类型检查与全量测试结果**：`npx tsc -b --force` **0 错误**；`npm test` **共 `7026` 条：`7011` 通过、`0` 失败、`14` 跳过、`1` todo**（耗时 152.7 秒，退出码 0）。
3. **分支 C（`v18-block11-tools`，已完成并合入 `main` `3ce7f600`，分支提交 `f8fc2663`，报告 `docs/reports/AGENT-v18-block11-providers.md`）**：
   - 块十一（P1 `see_frames({source:'media'})` 素材拼图 `hosted-media-frames.mjs` / `media-sheet.mjs`、P6 `measure_audio_js` 隔离音频测量脚本 `hosted-audio-js.mjs` / `hosted-render/audio-js.mjs`、V1 `get_gif` 用户可视记录与受权路由 `hosted-visuals.mjs` / `visual-routes.mjs` / `ToolVisual.tsx`）+ 工具表接线第二期（挂载至 `account-tools.mjs`、`cloud-tools.mjs`、`instance.mjs`、`http.mjs`、`look.mjs`）+ `server/frame-stream.mjs` 与 `server/hosted-render/worker.mjs` 按项目素材隔离加固 + `accept-018-rest-ssr-seam.test.mjs` 的 `SEAM-2` 载入缝收口（全部 7 处对 `src/` 的引用统一收归 `server/agent/ssr-host.mjs`，去掉 `{ todo }` 转为硬断言）。
   - **合并后 `3ce7f600` 上的类型检查与全量测试结果**：`npx tsc -b --force` **0 错误**；`npm test` **共 `7039` 条：`7025` 通过、`0` 失败、`14` 跳过、`0` todo**（耗时 157.9 秒，退出码 0）。
4. **分支 D（`v18-online-probes` 与 `v18-terms`，均已完成并合入 `main`）**：
   - **第一半（`v18-online-probes`，已完成并合入 `main` `8b09add4`，分支提交 `f6f0fb4a`，报告 `docs/reports/AGENT-v18-online-probes.md`）**：十七支在线探针改走会话恢复入口（`lib/online-resume-entry.mjs`），对齐 10-14「在线舞台一律跨源隔离、撤掉同源单舞台退路」与撤快照后的断言，实跑 S2-1（116/116）～S2-5、`online-stage-watch`、`online-stage-handshake`、`c10-ui`、`online-user-cards`、`sound-ab`、`sound-preview` 等 14 支探针 100% 通过。合并后 `8b09add4` 上 `npx tsc -b --force` **0 错误**，全量 `npm test` **共 `7025` 条：`7010` 通过、`0` 失败、`14` 跳过、`1` todo**（耗时 160.8 秒，退出码 0）。
   - **第二半（`v18-terms` + `v18-terms-fix` + `v18-manifest-sync` + `v18-fix-moved-id`，已完成并合入 `main` `4c1e7f85`、`efe13072`、`024b3c3f`、`de70db1f`，分支提交 `b38f1cd4`、`efa7d46d`、`1e878821`、`9086d14f`，报告 `docs/reports/AGENT-v18-terms.md`）**：完成「壬：代码里的旧名词」（「图卡」→「素材效果卡」，保留「地图卡」「示意图卡」3 处及 `audioCardSourceVersion.test.mjs` 钉住的 5 个有声卡闭包文件注释；「补渲」→「预渲染重试」282 处，含界面 17 处改前改后共 34 张对比图 `docs/reports/assets/v18-terms/`）、`server/recovery/gone-proof.mjs` 生产 `TRUSTED_GONE_AUTHORITIES` 签发者公钥配置填入（使用 `DEFAULT_HOSTED_URL`）、本地项目搬上云端保留原 `p-...` 项目号在文档服务与渲染服务的全链识别（实跑通过 `account-card-sync-probe`、`account-move-probe`、`cloud-tools-wire-probe` 40/40），以及 `four-stage-acceptance.mjs --check-coverage` 守门通过。合并后 `de70db1f` 上 `npx tsc -b --force` **0 错误**，全量 `npm test` **共 `7039` 条：`7025` 通过、`0` 失败、`14` 跳过、`0` todo**。
5. **块十五（38 行全套验收、打包 `0.7.18`、推进 `release`、节点备份与部署、删旧测试数据、真实旧文件转本地、真实网络环境验收，已完成）**：
   - 发版提交 `41b6d33584384cb2e2442295125625cd7219cae8`（应用 `0.7.18`、外壳 `0.2.8`；包含 `bb360375` 版本号与 Vite 扫描忽略优化、`151d0273` 隔离探针轨道流开启、`41b6d335` `S4-2` `conv-look-down` 420 秒超时更新），`release` 已快进指向 `41b6d33584384cb2e2442295125625cd7219cae8` 并推送 `origin`。
   - 发版提交上 `npx tsc -b --force` **0 错误**，全量 `npm test` **共 `7039` 条：`7025` 通过、`0` 失败、`14` 跳过、`0` todo**；运行器 59 项本机自动项 **59 过、0 失败**（已写入 `docs/reports/release-timings.md` `## 0.7.18`）。
   - 已产出 `PromptCut-0.7.18-setup.exe`、`PromptCut-patch-0.7.18.exe`、`PromptCut-patch-0.7.18.zip` 与 `manifest-0.7.18.json`。
   - 生产节点 `149.88.94.84` 完成一致备份与隔离恢复验证（`/root/promptcut-v2-consistent-20261017-0718-7314b190`）、部署全部六个生产服务与在线页面/官网、导入生产模型 Key、清理旧测试数据、实测真实旧文件 `9tianver7.proc` 转本地、完成真实网络环境验收。完整总结见 `docs/reports/REPORT-018.md`。

