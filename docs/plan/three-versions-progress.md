# 三个版本连做：工作进度

主会话维护。**每次往 main 合一个小阶段就更新一次，随那次合并一起进仓库**，让任何人不看对话也知道做到哪了。规矩见 `three-versions-brief.md` 第 11 节。

写法：只写事实和下一步，不写过程。提到的提交写短哈希。「本次做了什么」每次整段换新，换下来的内容并进「已经做了什么」。

## 现在在哪

- 版本：0.7.18，第一个整合小阶段进行中
- 最后更新：2026-10-08，用户已分别确认计划定稿、开始实施
- main：见 `git log`
- 一句话：集成66bf00b9已收回云端子Agent关闭与工具拆包并推送；根旧政策组合full5173项/5171过/0失败/2跳过。新HTTP组合506首目标177项/173过/3失败/1跳过，故未启动full；根277类型0与纯目标30/30，最新修复组合57985002待独立服务目标/full。80长验收58项52过/5败/1人工保留，skill已补验35项、storage诊断过但首败因果未定。3652真实C10自然结束exit1/7失败，新增r6夹具实测轻且未进计划，替换夹具仅纯目标10/10，尚未真实探针。中央074组件38/38，真实完整provider首7506目标3项/2过/1败，拒绝原因待补取；生产runner仍未挂载，不admit/model。尚未合main/发版/部署新服务

## 已经做了什么

- 2026-10-08 开工准备：环境 24 项检查做完。主工作区全量测试 4354 条、集成分支 4928 条，都是 0 失败、跳过 1 条（那条要连一个在跑的舞台，没设环境变量就跳过）。
- 2026-10-08 本机 Python 配好（conda 环境 cuda_Vit，五个感知模块就绪，详情在不入库的 `docs/local.md`）。
- 2026-10-08 云端 Agent 的模型 Key：密文备好并在节点上验过，还没导入。
- 2026-10-08 在线编辑器接到 `https://visuhive.com/editor/`。

### 此前整合与验证记录

- 按本次开工顺序重新核对 cuda_Vit，并在 `301c3092` 的四阶段工作区单独运行 `asset-path-probe`：29 项通过、0 失败、退出码 0，命令耗时 27.185 秒；只运行一次。
- main（`42d50043`）合入的 9 份文档、14 块冲突已由 Sol 对齐并经主会话逐份审查；保留 main 最新账号与在线浏览器规则和四阶段独有内容，没有代码冲突。随后又同步 main（`7c0dd651`）两次用户安排更新，进度文件的一处冲突由主会话解决。
- Sol 提交 `48a04cf0`、Luna 提交 `fd0bf0ca` 均以 `--no-ff` 收回集成。旧〔裁〕清单 48 条，详见下方；报告已归档到 `docs/archive/agent-reports/`。子分支类型检查、全量测试均零失败；主会话仍须在真实集成候选重跑后才采信基线。
- 最新 main 的 `6f85cd78` 已再次合入集成 `7b4b7106`：切私有停止他人在途任务/FIFO 排队/无生产历史对话/四档气泡都按用户原文对齐，三类对应待定项移走。本次新增内容只有文档。
- 候选 `f9bb0745` 的 G0/G0-R 共 17 项已完成：16 通过、1 失败，退出 1，墙钟 1037.034 秒；类型、网页/在线构建和桌面壳测试已过；全量测试 4928 条、4926 通过、1 失败、1 跳过（`CAU-SES-01b` 等待短暂 live 状态 3 秒超时，首次证据保留，无自动重跑）。Sol 已用受控事件流复现测试轮询漏掉短暂状态，未发现产品 session 行为错误，已修测试同步点；渲染 12 项全通过，其中 1800 帧与 main 逐字节相同、两遍确定性 1800/1800 相同，0 差异。
- 0.7.18 迁移设计与接口约定已派独立 Sol 工作区，与基线修复/裁定归类并行；只交方案，不提前往 main 放实施中的功能。
- 测试竞态修复 `ca00691c` 已逐行核对并收回：只改 `CAU-SES-01b` 的同步点与断言、保留 3 秒超时，没有改产品实现。新归类 `484f73a2` 已收回：4 项移到已定区，契约〔裁〕125 个命中行有索引。两个原文档/清单工作区及分支已清理（已入集成、干净、无联接），原来的 8 个工作区均保留。
- `d6ed437c` 最终复验：类型零错误（7.427 秒）；全量 4928 条、4925 通过、2 失败、1 跳过，115964.235 ms（墙钟 116.458 秒），退出 1。前一项会话竞态修复已通过；本次失败为 `CA-REV-10`（两个异步页面答复的全局完成顺序断言）和 `HR30`（父孙存活检查均已判退出，但随后的 Windows 进程表仍列旧 PID）。Sol/Astra 分别受控定位；不降低权限、一次性答复或进程清理标准，不盲目重跑。
- 最新 main `bf6e48e6` 已与远端核同并合入 `5525bdab`，三处文档冲突按用户审定解决：出口护栏本期不做、外链照常；全部在线成员选区；托管方读取告知。实现与契约随相应模块对齐。
- Astra `0cfcfa16` 已收回：Windows 树观测追加无副作用存活与出生身份核对，进程表缺行仍保守检查，生产 killTree/treePids 不改。子分支最后全量 4931/4930/0/1，65733.0104 ms；两次审查触发的复验完整保留，主会话仍须集成复验。
- Sol 迁移方案 `bda2a5b3` 已收回到 [three-versions-018-design.md](three-versions-018-design.md)：19 个独占包，账号/project/ACL/FIFO/read/run/素材/全员选区/容量/工具/恢复接口与验收、部署恢复次序。可信改密时序采用账号持久顺序见证，文档服务离线不阻止改密成功；Astra 后续必须证明 seal/accept/权限屏障故障矩阵，方案不是已过实验。
- 用户本次已授权两个仓库的小阶段 main 合并、提交与推送，以及三个版本的发版、部署、备份恢复后旧测试项目清理；本阶段不改版本号、不推进 release、不部署节点。
- Sol 页面答复修复 `0a74d8c7` 已收回：按 requestId 核验并保留三秒有界等待，不再以并发 HTTP 答复的全局观察顺序判权限；子分支全量 4928/4927/0/1，64588.2746 ms。初次失败、受控反例和审查补验均保留在归档报告，主会话共同候选待验。
- Luna `8817b6ec` 已收回到 `91a8d2db`：50 条去重清单（待事后审 1、已定 21、取代 15、实现记录 13）；旧 P1–P8、P10、R1 均不再待定。预渲染和即时看画面均遵守超容量等待，旧队列满/背压回忙被取代；既定请求 deadline 可保留。主会话审查发现并修正过“看画面除外”的语义缩窄，未以旧探针当新目标实现证据。
- 独立 Sol 正实施卡片出口策略撤销；另一个 Sol 在 PromptCut/VisuHive 各自工作区实施账号基础，已先交 JSON principal/outbox/consent fixture 和内部 mTLS/store adapter；只是接口早交，完整产品和回归尚未过。Astra 获派顺序见证/操作历史，须先证时钟回拨、reserve/seal夹缝和 ACK/fence 反例，再验实际 SQLite/日志故障点。两个 Sol 的模型容量中断已原地续跑，不换模型。

### 上一阶段整合与验证记录（2026-10-08）

- 安全读取 GitHub main 的新增提交 `e0e3afc3`：只取得指定提交对象并完整阅读补充原文，没有 pull/reset 或盲目合入 main；读取时本机 main 为 `bf6e48e6`；后续只读核到本机与远端 main 均为 `e0e3afc3`，本会话未 pull/reset 或合入 main，在途共同候选产品源码保持 `913e6884`。补充原文 11,851 字节，Git blob `720bfd83dac966d20ede71bcdd0996da6ddc4a88` 逐字节保留。
- 纯文档包 `f01171a6`/报告 `dcb93ecd` 已由主会话审查，增量同步计划索引、三版本范围、相关契约、验收覆盖和本文。旧自动淘汰对话与删除入口延期标被取代；旧2任务/16连接数不能替代0.7.18单活跃项目，提前回收及补渲故障策略留待确认。没有改语义正文、部署代码或删除实际数据。
- 新增六组计划验收映射 RS18-local/queue/chat、RS19-memory、RS20-rotation、RS-common：仅已规划，均未由本次文档整合实现/测试/通过，未冒充现有运行器项；既有自动/人工/网络项数量不变。所有生产容量实测需含用户自定义卡片；see_frames 端到端低于5分钟是优先目标，须另记条件、实测和超时边界。
- 主会话在固定 `913e6884` 运行共同候选：关闭自动 flaky 重跑，选择61自动+18人工项。G0 类型/网页/在线构建/桌面壳通过；完整 npm 4931条、4930通过、0失败、1跳过，70388.604 ms。A5 浏览器全链首次失败（1105秒：host已连接但未认领任务）；其余自动探针仍在继续，人工项不计通过。Sol在同源码/原dist独立首跑全过（261821ms，A5 44764ms），属于反证，尚无根因或产品修复；只增强脱敏诊断后有因复验。原失败仍保留，尚未合入main。
- 卡片策略增量由 Sol 在独占工作区提交；主会话核过四类外链截图与JSON、分源和项目素材权限证据。完整第三轮 npm 缺最终总结，真实旧fake CLI子树仍存，已只中止本测试54836树，exit1记中止、不计通过；Astra另包定位生命周期。原events-all.ndjson在原runner退出后已不存在，仅现存spec日志与CIM快照可引用，不补造细项。第三轮hosted探针48过/1失败期间源码变化导致乙任务code-changed，属于执行扰动；原日志保留，固定源码后有因复验，不把48过记全链通过。
- 账号基础 PC `77dc4897` / VisuHive `580bec8` 待收回。主会话独立跑VH全量40/40通过、0失败/跳过，5491.9668 ms；首次NODE_OPTIONS导入使用Windows盘符失败，改为file:///后才运行测试，两份日志保留。部署前仍需处理旧网站请求与新CSRF/requestId接口兼容，以及备份目标无覆盖/父目录权限；未部署新账号代码。
- Astra顺序见证/历史包 PC `ba64e8cc`、VH `7eab553` 已交付待主会话审查：其报告最终PC全量4949/4948/0/1、VH26/26、真实order37/37、history6/6，未挂载生产接口。旧EPERM具体持锁者未被事后证明；受控held-cwd反例和等待本测试child close修复证据保留。报告结论待主会话核实后采信。
- 主会话按新增工具安装与Python升级授权完成新节点 ffmpeg/ffprobe4.4.2、Noto中文字体、Chrome headless-shell152.0.7977.75、独立采集venv内yt-dlp2026.8.19。Python三个系统元包由3.10.6-1~22.04升到3.10.6-1~22.04.1并装venv，实际解释器仍3.10.12；本机cuda_Vit未改。现有nginx/账号/托管进程PID和重启计数前后相同。首次预检因未授权Python隐含升级停止，第二次保守安装及后来授权升级分别留日志。
- 节点实测：H264两帧、中文真实beginFrame PNG9127字节已查看、匿名generic HTTP采集3941字节与源SHA一致、pip check通过；仅工具链受控烟测，不代表公网网站/登录态采集或完整Agent链已验。实际工具路径、版本及私有日志位置只在忽略的docs/local.md记录；未打印密钥/令牌。
- 节点账号一致备份与实际隔离恢复已做，现网旧库为空（accounts/codes/sessions均0），只证明旧库恢复；已用visuhive-account用户重新在线备份并恢复核对。完整托管数据备份及新schema非空恢复仍待做，没有删除任何旧项目或备份。四个本次已完成工作区/分支（迁移设计、页面答复、进程观测、裁定对齐）已在祖先/干净/无联接核对后清理，原8个工作区保留。
- 纯文档包已实际以 --no-ff 收回到 `986ebec6` 并推送 claude/four-stage；共15份计划/契约/验收/报告/进度文件。补充原文SHA256 `1e05b28a907942df4418516dd974dd606b5dc45ec25acb268e683292b8971b1b`，逐字节核同；新增相对链接36、失效0，既有验证报告前缀完整。diff --check 排除原文为0，整包仅原文两处Markdown双空格硬换行退出2，未擅改原文或Git检查配置。六组新增验收仍只是规划，原运行器数量未改。
- 主会话独立收口顺序见证/历史的真实探针：正确固定5760/5761端口后order37/37、history6/6均exit0（history六种操作、25条journal、rev6）；首次指定5970不符合probe固定端口范围退出1，属主会话命令错误，原日志保留。模块尚未中央挂载，生产退出结束见证仍待接。
- 卡片最终源码固定时hosted探针49/49（甲3任务/乙2任务均done、五类外链真加载）；根独立Chrome152规范探针20/20、exit0、墙钟3.4825秒，覆盖真实loader多CSS/六种import/正常HTML/结构分源/管理接口。本包不能证明生产项目素材隔离，另项目hash残余由新素材包处理；Firefox/Safari及真实Linux卡片全链未验。
- 已审auth生命周期修复 `5bd65d27` 只改测试夹具和报告，目标27/27与独立full4932/4931/0/1、94994.2237ms；62spawn/62exit/62close、0强制清理。根卡片+auth联合首次full4933/4931/1失败/1跳过、88041.425ms，唯一缺probe禁止用户目录保护；`bb6ac238`首import修后第二次类型exit0（6.1054秒），full4934/4932/1失败/1跳过、78168.3187ms，唯一C62 collect-plugin teardown的临时目录EPERM。没有跳过或吞清理错误；根首次错用不存在npm types的命令另留证，不算产品类型失败。新Astra包继续受控追踪HTTP/file/tier child实际close，尚未证明原持锁者。
- 旧共同runner `913e6884` 新失败：M7实际877秒、exit1，无pending；仅page-layer-env-browser与page-dual-split-supersede-layermap两断言未过。三重卡anchor完成/服务端层点到browser已过，但页面即时层观察h1/h2仍pc、h3双份未见作废；原因待Astra核观测竞态或真实队列/层错误。asset-path 28过/1失败，Python已找到；已核direct继承主仓库模型而editor使用probe模型的夹具差异，修复只使两边用同一probe模型目录，保留逐字段断言，待复验。不把在途/人工项记通过。
- VisuHive备份发布修复源码 `39e739aa`（报告 `1015ffda`）：根精确归档5文件SHA256 `a2da8129e830653d1981cf9ffbc0049b0aa8b18da65b07e841eb83704eba0e23`，节点新隔离目录、visuhive-account用户真实8/8、0失败/跳过、820.439415ms。非空WAL一致恢复、key伴随、无覆盖竞态/部分发布、既有父目录权限保持、新父目录700/文件600均过，现有account/nginx PID不变。首次Linux旧源码7过1失败（ENOENT）及根PATH包装未找到runuser都保留；未对真实生产库执行新schema迁移。
- 网站兼容 `95a5b545` 已交回并经根看待选择/等待ACK最终图，补GET/me仅发起会话pending摘要、CSRF/requestId、恢复选择与两张项目503。最初图fixture漏event-status显示无法确认，以及加入列表旧占位均保留/修正；最终图只是UI fixture，不能当真实退出完成。根把网站+备份+顺序见证收进VisuHive隔离联合候选 `e974114`，独立full61条、60通过、0失败、1明确Windows POSIX权限跳过、6475.64ms（墙钟6.7689秒）；没有合入网站main或自动上线。
- 文档账号权威固定 `f873d3d1`（产品 `815510cf`）已由根逐源审查，独立目标24/24、0失败/跳过、1616.225ms；真实冻结账号provider、证书固定的mTLS、连续outbox、项目初始化失败关闭、准确gone签名与持久ACK均有模块证据。生产中央尚未挂载，不能以模块通过冒称完整项目交互已完成。
- Astra素材测试生命周期修复固定 `f3f7233c`（源码 `7620aed4`）已审收回：真实HTTP关闭后owned child cwd仍在和Readable结束早于close的受控反例成立；等待本夹具requests/streams/tier manager及queue收口后再删临时目录，不吞EPERM、不碰生产进程。子包首次目标18过/2取消（MP4夹具门控早于目标边界）保留，修MKV后20/20；子包full4936/4935过/0失败/1跳过、77672.7596ms。原collect-plugin失败的具体持锁者仍未知，受控反例不冒认原进程。
- 主会话新的PC隔离联合候选 `f9390dda` 包含已审卡片、auth、账号基础、文档权威、顺序/历史、A5诊断和素材夹具关闭修复，未含新项目素材服务产品包。显式指定真实冻结VisuHive provider/order模块后，首次完整npm4985条、4984通过、0失败/取消、1既有layout跳过、94446.2226ms（墙钟95.0087秒）；实际provider子进程崩溃矩阵33种切点本轮已执行通过，未当未配置时的skip算通过。此前两个联合full失败完整保留；这是修正源码后的有因联验，没有同源盲重跑。
- 网站未知POST结果小修 `01601a91` 已逐差异审查并看中性等待/绿色完成两张fixture图；空值、数组、缺布尔ok、坏JSON、5xx结果未知时保留请求标识并禁用重复提交，明确400可纠正。根收进VH联合候选 `f8106233` 后独立full62条、61通过、0失败/取消、1明确Windows POSIX权限跳过、8923.9601ms（墙钟9.2742秒）；Linux权限证据仍为前述真实8/8，网页未合main或自动上线。旧加入列表占位文案仍待正式产品发布时收口。
- 素材包 `443ec4fe`（产品 `56af4573`）已交回：子包full4955/4954通过/0失败/1跳过、68825.3059ms，目标23/23、isolated真实HTTP26/26，asset-path29/29；最后一项只证明URL/direct在同模板模型目录相同，不是安装模型推理证明。根审查发现finish/close直接release可能先于文件流实际close而漏掉后续撤销ACK，Sol确认边界成立，正在同叶补真实门控反例、收口及发布边界修正；旧包尚未收进最终联合候选。
- 当前独占实施：Sol account-wiring已交回固定 `d96530d5`，根在同一固定源码独立复验；Sol asset-isolation（5780–5789）继续关闭/发布/目录耐久边界，Astra validation-races（5800–5809）继续审查收紧后的M7真浏览器探针。Luna备份timer已从仅开场提交 `9c520a29` 的原叶恢复，限每日runner/unit及专属测试，不操作节点。旧共同runner在S4继续，根GR全渲染项在5900–5905继续，未终结结果不记通过。main、版本和生产账号/组合部署仍未执行。
- 上述 root C10 联合候选真浏览器探针随后完成：固定 `f9390dda`，exit0、ok:true、fails/pending均空、cleanup.listening空；脚本220357ms（墙钟220.4611秒），创建者关掉后独立主机继续接活的A5为45445ms，定位后精确帧A4为6915ms。根已查看定位精确帧与播放缺帧占位两张实际图。原A5未认领的根因仍未证明，诊断不修改认领逻辑；旧失败与新成功分别保留，不能用此声明新增调度或生产账号已全通。
- VisuHive联合候选 `f8106233` 新节点隔离全量：首包漏归档 `user_readme.md`，62条/61通过/1失败/0跳过、12692.951639ms，仅ACC-14的ENOENT；此为主会话验证包遗漏，原日志保留。只补该已跟踪文档后新包SHA256 `0f0ee131510e7b4ba34c7f4d825bc096341f896ac3eb9280166d4d28b7ecb2b5`，作为visuhive-account用户一次复验62/62、0失败/取消/跳过、12061.523095ms（墙钟12.7382秒），真实POSIX权限项执行；账号204715/nginx9395前后不变，未部署产品或触碰生产数据。
- hosted账号接线 `d96530d5` 已逐源审查：新mTLS票据解析、真实账号WS/HTTP逐消息与接续gate、创建后fsync、required缺配置拒启动及暂存依赖；子包full4987/4985通过/0失败/2跳过、97.94秒。生产assetReady仍false，join/session与账号素材请求503；Agent/render消费者、三服务实际关闭ACK、真实resume及初始化crash证据待补，0.7.18发布必须强制并传播required模式。根定向2/2、2159.343ms，内含携真实临时输入的probe4/4；另裸调用probe缺输入导致ERR_ASSERTION并中断包装，属根命令错误，full当时未开始；随后只启动第一次独立完整npm，不重跑type/target赌绿。异步认证后的容量并发边界另待受控审查。
- 素材关闭增量固定 `cf49240a`：子包受控5例及目标28/28、full4960/4959通过/0失败/1跳过、98823.2154ms。根确认release不应先于实际I/O关闭，并指出marker仅文件sync不足以证明Linux目录掉电耐久；Sol在固定源码全量结束后另补目录耐久顺序，旧有模拟重启证明不冒称Linux实测。旧finish先完成1/1失败与异步发布2/4失败均保留，尚未收回产品包。
- 根 `f9390dda` GR首轮在途：与main产品树的1800帧逐字节比对零差异，两遍导出确定性1800/1800相同、快照重放一致均通过（GR1–5）；其它GR项仍待首轮完成，不能据此划掉整组。实际main `e0e3afc3` 的非文档产品树与基准 `bf6e48e6` 相同，未改/重置参考工作区。
- M7旧观测修正 `2a5ae175` 的首轮真浏览器16项/54部分通过、fails/pending空、creator0/node单角色1/all汇总0、墙钟873.6836秒；根发现旧历史作废fallback可能把同ID重开后的普通失败错认作旧superseded，受控反例已证。Astra收紧连续首代/同epoch及publisher最新终态，固定 `59b04d04` full4942/4941通过/0失败/1跳过、76331.4232ms，影响M7第二轮由此源码更正触发，正在进行，旧第一轮不当最终收回证明。
- 旧共同候选913e6884首轮最终完成：79项中58通过、3失败、18人工，墙钟7786.641秒；三失败为A5主机未认领、M7两观测断言、asset-path模型目录差异。S4-6最后35/35通过、843秒；其余18人工仍不计通过。首次失败留TMP/promptcut-three-versions-combined-d66f4db8ef6b4a249cb49536d1bbd97c，后续有因修正不改写首轮结果。
- 根GR首轮固定f9390dda：12项9通过/3失败，墙钟1239.278秒；GR6/11/12仍用manifest默认5690端口，碰到本会话旧共同runner，而非用户端口。根纠正--port-shift210后仅这3项复验，全通过、墙钟107.765秒，TMP/pc-root-gr-port-fixed-b7ebc568ff9d449b8302905254fb6fd2。前9项未重复，原端口失败仍保留；准备核所有权时原GR进程已自然退出，未结束任何进程。1800帧零差异、确定性1800/1800及重放证据属于f939固定源码。
- M7最终固定59b04d04/b885daf3：根直接解析原始TMP/promptcut-validation-races-m7-full-2.log，16项/54子断言全pass、fails/pending空，脚本786831ms、墙钟787.031秒、外层exit0；creator0/node单角色1如实保留。15份缺失PC候选均须首代连续无缺口/同epoch/发布者最新superseded与watcher failed，当前describe优先；已有反例已被拒，未把同ID重开后的普通失败视为作废。A4本轮第一样本已就绪，不宣称复现原现场唯一根因。
- 项目素材最终b363df43（源码c7e94f31）已审收回：子包full4966/4964/0/2、87519.307ms，目标34/33/0/1、HTTP26/26；根Linux精确两文件包装6/6、0跳过、202.546ms，真实目录fsync/正常恢复/symlink拒通过，账号204715/nginx9395不变。Windows目录fsync明确unsupported；正常恢复和故障门控不当物理掉电证明，缺备份或坏marker failclosed需可信运维消歧。
- 根hosted账号初包d96530d5完整npm4987/4986/0/1、84012.734ms，但受控两并发异步鉴权在maxConnections=1时实际接入2连接，独立反例exit1。修正da476e15重新核容量/transport，真实resume/初始化child crash证据补齐；根最终联合74a6b67c同反例接入1/连接1、exit0，未以旧全量全绿掩盖产品容量缺陷。
- doc实时素材就绪增量0e12db21已审收回：每次join/session同步access head、mTLS探针后再同步核head，cursor/head/authority/instance精确一致；join首次不ready不写membership，签票据再核同instance。生产缺可信callback503，setAssetReady仅显式fixture。中央真实asset/status正在接，不能以fixture ready或一次历史true说生产已可用。
- 根隔离联合74a6b67c固定源码：类型exit0（5.25秒）；npm定向47条/46通过/0失败/1Windows符号链接跳过，2214.825ms；首次完整npm5029条/5027通过/0失败/0取消/2跳过，63880.997ms（墙钟64.234秒），native重跑0。两full跳过仅既有未配置真实舞台layout与Windows symlink权限；实际provider崩溃矩阵仍运行。产品树已无冲突合入9131dd43，root进度文档另写，未放入main。
- 根同联合素材HTTP26/26、exit0（0.375秒），真实模块但注入权威fixture、productionMounted:false；asset-path原日志29项通过，P7两边均template且逐字段相同，P11像素相同。根汇总包装在探针结束后误按单行JSON读取多行输出，wrapper exit1；没有重跑探针赌绿，实际子进程exit码未保存，不补造。TMP/pc-root-asset-probes-74a6b67c-*保留；未当真实安装模型推理证明。
- VH备份timer联合030ac9ab：Windows67/64/0/3通过，首次真实Linux67/66/1/0失败，原因backup-schedule.test缺mkdirSync导入（Windows跳过该POSIX项而漏查）。Luna仅补导入971fcb23/报告7306bfe5后，root收回718fc180，新精确包装SHA2560961416041a6daca70e39ca81fe4efee366e1424e445448750fad32fcafcd2d4，真实Linux67/67、0fail/cancel/skip、11857.814ms（墙钟12.575秒），service用户运行，account/nginx PID不变。root新包装首次因utf8-sig编码拼写错误在SSH前退出，纠正包装后才进行此轮真实测试，原错误保留。
- 节点对718fc180的两份backup unit只读systemd-analyze verify exit0；UTC每日02:17 calendar三次计算exit0。诊断仅系统既有snapd RestartMode不识别警告，未改系统unit。没有安装/启用/启动timer或部署新账号；此前非空备份恢复fixture及旧生产空库恢复与新生产完整恢复仍分开记录。
- 联合阶段已审的9份AGENT报告按协议从docs/reports归档到docs/archive/agent-reports，均为100%原文重命名，没有改写首次失败。新素材中央/真实操作/选区各用新报告，旧报告不当后续接线验收；原8个工作区、生产数据和备份均保留。
- 收回后另清理本任务的5个已完成PC叶及本机分支：auth-fixture-lifecycle、c10-host-claim-fix、018-doc-authority、three-versions-card-policy、018-asset-isolation。均已证提交在集成、tracked/untracked干净、reparse为0、无引用该叶的存活进程；使用正常worktree remove/branch -d、未强制删除。C10/card的ignored out证据已先移到TMP/pc-retired-worktree-evidence-b1de19d094be4d0cb4a8061fbc2fec2f，其余原始日志及Git提交保留；原8个工作区和其它会话分支不动。

- 选区初包3fb85f1f经根真实模块受控审查发现三个漏洞：allowed:false对象仍被允许、readonly成员被当写拒绝、成员核验期间runGrant撤销后仍返回（TMP/pc-root-selection-review-3fb85f1f.log，exit1）。Sol最小修正4370101c，新增首尾grant/fence验证、read权限、递增clear及发布重试隔离，type --force零错、target11/11；根固定源码独立6/6、exit0，另验allowed缺失、clear后旧set及生产缺fence均拒。productionMounted:false，中央逐消息selection gate仍需接read，project.op写闸不变。新全量等待串行端口租约，不把首次全绿当权限正确。
- 素材中央包固定4c91f5d2，真实独立stage/provider/doc/asset集成3/3，实际fd关闭前不ACK、ACK响应持续丢失后的同receipt重放和clean restart均有证；部署49文件闭包bare依赖/非literal目标/missing均0。target首次87/86/1/0，fixture删除请求漏expectedAccessRevision，e32f26a6仅补真实status前置条件，单项复验1/1。首次完整npm5028/5010/16失败/2跳过，65818.116ms：11条漏设真实password-order模块，5条PCM旧测试夹具仍引用抽取前index路径；原日志TMP/promptcut-asset-wiring-full-1.log保留，夹具改后仅定向复验，联合候选再有因跑full。
- 根独立审查素材生命周期另发现并发重启锁竞态：两个启动先读同一旧锁，后一方无条件rm可删掉前一方刚建的新锁，两个实例均获准；TMP/pc-root-asset-lock-race-0de62bd5.log，exit1，acceptedInstances为next-a/next-b。暂不收回，本包owner修原子启动/恢复claim、遗留claim failclosed；生产旧资源关闭仍须root在专用cgroup真实为空后作证明，PID死亡及本机fixture不替代该证据。
- 真实project.op接线固定7c4f1f11，子包target58/58、15682.505ms，25个真实子进程切点均exit73且close，含fence提交与ACK夹缝；原33个账号provider故障切点另保留。实际Chromium双context双账号WS探针exit0、519.485ms，unsealed无ok/广播，同值两账号rev2/rev3，重启后真实页读取rev3和两份accepted。是隔离fixture，不是生产UI验收；root源码、历史投影和Linux目录fsync仍待复核。本包正在冻结源完整测试，5823～5829全量fixture端口串行使用，Sol选区full等待，无源码在跑测中修改。

- 根新候选80b5e658以三个固定包06dd5bb1/a5b1da34/d4cb04ca合流；唯一modify/delete冲突为已归档account-wiring报告，两份Git blob同为9c6d5a3b，保留归档正文。新素材5bb5ff37的启动/close均先wx原子claim串行，失败claim不自行清理；根同联合目标含确定性双启动/关闭竞态及真实stage集成全部通过，旧acceptedInstances双实例反例不删除。
- 根80b5e658独立最终复验：tsc -b --force零錯、exit0（7.672秒）；定向68/68、0fail/cancel/skip、14726.416ms；首次完整npm5089/5087通过/0fail/cancel/2skip、75124.744ms（墙钟75.516秒），native重跑0，源码全程固定。两跳过仍为未配置真实舞台layout和Windows符号链接权限。2026-10-08T10:06:56+09:00核5760/5823/5860/5920各测试段零监听。TMP/pc-root-central-80b5e658-*保留；此结果不等于所有新生产模块已经装配或版本交互/公网验收完成。
- 根独立operation两页Chromium probe exit0（脚本602.308ms、墙钟0.875秒）、core/crash46/46、14270.657ms；固定7c4f1f11、真实provider580bec8/order7eab553。节点精确51文件隔离包SHA2562dfa55ebc99fa56de33474c6558dcb9cf6ee7bc5e49107d15c5124ae302c9c59，在visuhive-account用户/TMP/空环境下真实Linux46条中45通过/0失败/1Windows专属跳过、25804.849ms（墙钟27.223秒），native重跑0、前后5760/5761为空、账号204715/nginx9395不变。首次包装全局替换ROOT破坏环境变量名，远端在语法阶段退出未跑测试；修包装后才跑本轮，错误日志保留。
- 根读取上述同一strace原始日志作严格二次解析，没有重跑测试：63组同PID且无同目标中间rename的临时文件fsync→rename→目标文件fsync→父projects目录fsync均返回0；初步宽匹配85组不当最终精确数。证据 /var/tmp/pc-operation-proof-bdbe2de24e3a4c54a0e7dff960168218/trace-strict.result.json；只跟踪fsync/rename、不打印写缓冲区。这是实际Linux系统调用/崩溃切点证据，仍不是物理断电或生产OS隔离证明。
- 新联合已以no-ff收回b7647627，三份新AGENT与渲染文档整合报告均100%原文归档，首次失败保留。下一阶段各新叶从固定80b5e658出发，互斥文件/端口：Sol中央doc装配5770～5779、Sol对话ACL/FIFO5790～5799、Astra可信read/runGrant5730～5739；先交接口再接消费者，全量fixture端口由root串行出租。旧模块通过不冒称这些新项已完成。

- 三个已收回实现叶（018-asset-wiring/018-operation-wiring/018-project-selections）及render-scheduling-doc-sync叶和本机分支已正常清理，未用force。根预核clean/ancestor/zero reparse/zero process references；三个实现叶生成的ignored data/auth身份与tsbuildinfo先移到TMP/pc-retired-second-stage-evidence-8b7a0f68bf1c463d863c9f958080ea1a，内容未打印，retirement.json与Git提交保留。新三个在途叶、根80验证叶、既有用户工作区及生产数据/备份不动。
- 下一授权接口审查：Agent关闭再开启不能复活旧grant，现authority事件缺service/enabled且listener可能略过空accountIds；中央Sol获窄租同ledger事务runHooks/fenceInState与不可变事件字段，Astra提供run权威接口，不双改文件。旧接线通过不替此边界通过。〔裁·三级最小收敛，拟实施〕可信read独立验证完整持久消息record及sender/currentRun/snapshot/附件关联，不要求doc重构模型system/history/tools全部上下文；Agent先从持久record读全并装入runner、fsync readIntent，再取doc持久ACK后才首次model/tool，最终model input digest另作审计。替代为doc复写模型prompt编译器，会额外复制职责且不能可靠推断Agent私有上下文；用户已定的已读消息例外不变，未标新用户批准，真实instance接线尚未完成。

- 中央页接线固定bc6e5a42/324ca429定向2/2，authority同事务撤销hook03ee7fd1定向1/1；缺expectedAccessRevision的首次fixture失败保留。hook错误/thenable整事务回滚，agent关闭事件永久带service/enabled、空accountIds也通知；没有真实资源receipt仍pending。根在中央clean叶no-ff组合对话b25e5de8为eba60f05；capture快照e662aaf7定向5/5仅用服务端在线页与精确四身份，callback数组逐control处理。尚未宣称完整Agent执行挂载。
- Agent对话候选b25e5de8/报告9ba4d8b8：根逐源核对权限/FIFO/50上限、专用mTLS、HTTP/SSE；读原始日志确认首且唯一full5095/5093通过/0fail/cancel/2skip、66071.662ms，native重跑0。该包消息只持久queued，fixture中的selection/run/close ACK不当生产证据，runner/附件/诊断/用量/UI仍需接。
- 根固定ce444052独立反例TMP/pc-root-run-scope-ce444052.mjs/.log、exit1：不同对话合法复用同requestId，第二次切私有因run-request-mismatch409回滚为shared。Astra scoped controlId修正08335387目标40/40，原full5128/5126/0/2与修正后full5129/5127/0/2分别保留（71245.252/75318.156ms，无native重跑）；含真实19个exit73且close的崩溃切点。根固定083源码对应报告af8f1c83独立复验同反例，两对话都private、第二错误null、exit0（TMP/pc-root-run-scope-08335387.log）；生产service身份/runner仍待实际挂载。
- 排队资格另发现短access TTL错接：Astra真实VH SQLite反例TMP/promptcut-run-authority-ttl-counterexample.log、exit1，发送后120001ms普通token已过期、login仍有效，原verifyActorRef却使queued取消。Luna已交严格普通actor-ref mTLS接口4f598506/报告99e31311，定向11/11、full68/65/0/3 Windows权限跳过；该接口本身不能用于长期已接受消息资格，批准独立accepted-message用途核验增量，不放宽普通token/order鉴权。新接口与真实actor/run联验进行中。
- 根固定80b5e658新整套后台验收（TMP/pc-root-baseline-80b5e658-20261008，session89976，进程37696）：已有同源类型/full不重复，新增G0网页/在线构建、桌面壳、全部G0-R与探针类别共58项；main参考固定e0e3afc3，dev5900/5903、清单端口平移210，保留参考叶供安全清理。两构建已过；GR1/2各1800帧、GR3零差异、GR4确定性及GR5重放通过。GR6首次快照HTTP500/磁盘14413字节不符、exit1，交Luna只读诊断；其余GR7～12通过。其它探针仍在跑，未完成和人工不计通过。
- 桌面壳首轮37/36/1/0缺Get-FileHash原失败保留。根受控复现Python继承的PSMODULEPATH与Node加入的PSModulePath在Windows同名不同大小写冲突，使PowerShell5.1读到错误模块路径；单一规范键时Get-FileHash存在。仅在测试进程规范环境键后，同一80源码G0-5单项37/37、0fail/cancel/skip、844.6263ms、exit0（墙钟3.141秒），仓库与系统环境未改。TMP/pc-root-ps-module-inheritance*及pc-root-g05-module-fixed-80b5e658*保存两轮证据。
- accepted-message用途接口固定Luna9c8d9a34/报告623fa1a93，根逐源核对精确actorRef/messageRef、真实登录类型与parent/logout/generation/consumed状态，普通verifyActorRef不放宽access过期。根精确Git隔离包SHA256 c2b76e44e07f9d467b95258708fb73e2fe696d2b3f8fc3fdc5697169c9e03c1f，在节点visuhive-account用户下首次真实Linux69/69、0fail/cancel/skip、11410.753492ms（墙钟12.1005秒），账号204715/nginx9395前后不变；未部署。原T0接口68/65/0/3 Windows结果保留，不冒称长期消息支持。
- 真实active run修改联验新源码PC b5c776b5/VH8ad627d：VH full74/71/0/3 Windows跳过；PC首次target45/40/5/0失败，五个新WS项都在prepare前operation-unavailable。Astra核到service normalize白名单丢失trusted authenticate产出的servicePrincipal/serviceId；中央owner获窄补租，不从消息body重造身份。类型、因果补验及全量待固定源码，原日志TMP/promptcut-run-authority-active-target-1.log保留，不能以原40模块通过判实际WS通过。
- 中央专用关闭ac3bd9a2/报告f9d7456b，新6项与原33项39/39、0fail/cancel/skip、5574.3443ms；实际socket的_destroy门控证明逻辑连接零/旧SID410时回执仍pending，真实close才完成，含WS/LP异步resume窗口。根已读core3文件完整diff；永久账号/project条件改为本次cohort屏障正在补，不将此39项当整组跨服务资源ACK或Agent进程停止完成。

### 最近一轮权限核心验证记录

- 已审完成模块以no-ff收进集成7cce722f：run/read/TTL权限核心6c4cd8d8与对话原报告9ba4d8b8；没有合main、发版或部署新服务。已完成的run与对话AGENT报告100%原文归档，正在接线的中央factory和runner报告留在reports，不把fixture通过说成生产已挂载。
- 根在独立冻结6c4cd8d8（当前对话authority、真实VH327ff674 provider/order）首跑：强制类型exit0/6.968秒，11文件目标71/71、0fail/cancel/skip、10686.2584ms，全量5160/5158通过/0fail/cancel/2skip、69838.2893ms（墙钟70.188秒），native重跑0、源码全程不变。原始TMP/pc-root-runtime-6c4cd8d8-{type,target,full}.log及result.json保留。两个既有skip不计通过；这不覆盖后来7a路由/factory或e546 runner。
- 根补公共对话API作用域反例：旧b25同owner/project/requestId用于两对话，第二send和switch均409，只有第一条落地、第二仍shared，exit1；11b1b8df对send/switch/stop按action+project+conversation+account+request作规范键后，两条均落地、两对话均private、exit0，变正文仍409。TMP/pc-root-conversation-request-scope-{b25,11b1b8df}.mjs/.log保留；不是仅调内部privateFence helper的原control反例。
- Astra权限联验首次45/40/5失败为可信principal归一化丢服务字段，次轮46/44/2失败为owned fixture遗漏真实runHooks；各owner有因修正且加强真实fence/WS close断言后46/46，最终51d77560类型0、相关17/17、full5160/5158/0/2。首次日志完整保留，根独立6c联验另列，未把五个原失败或缺hook提前503当通过。
- 根精确VH327ff674隔离归档SHA256 c36be9e49341f58e666560557a4d60a32852554aafac317202654fdc24fc7e20，节点visuhive-account用户实际79/79、0fail/cancel/skip、12540.122029ms（墙钟13.2452秒），含实际active-seal三次exit73且close。前轮漏显式provider为76/70/0/6skip，保留；第一次更正wrapper的全局ROOT替换损坏环境键，remote Python语法错、测试尚未启动，保留error；改成精确替换并先compile后才得到本次79结果。服务账号204715/nginx9395前后不变，无部署。TMP/vh-backup-timer-joint-linux-5db1eaa944ab4543b48cacc93db28f88.result.json及节点同runid原日志为证。
- 80b5e658的58项长验收仍在后台自然运行，不能把部分summary当最终结果。截至P-online-nav-stress完成，24项已记录21通过/3首次失败；桌面壳G0-5已凭测试进程环境因果修正37/37，原失败保留。GR6快照HTTP500仍未解；P-c10-browser-full首轮1084秒失败（主机plan=1/fine completed=0），原始输出与图保留。A4、用户卡、界面、舞台看守、改参不贴旧层、握手、导航200次均exit0，但不替代失败的普通A5。当前P-desktop-auto-node及后续未完成项不计通过，session89976/完整out目录仍保留。
- C10只读证据不能唯一认定原因；真实队列受控反例确认浏览器可以合法先claim/complete所有双指纹细段，使host切plan但completed=0。Astra诊断fe62c39c保留原hostDidWork、分channel/connection/queueepoch/generation与unversioned ACK证据；首两次手写browser协议缺expectVersion失败保留，修夹具后纯队列目标7/7、551.4549ms及类型0。后续正常r6-canvas重型卡fixture经根审查再加，尚未起服务/新probe，无生产filter或超时修改。
- 中央7a435d3c专用accepted client/routes首目标3/3、2061.2719ms；同ledger factory仍在装配，实例持久registration/generation/recovery未提供时实际run入口503。Sol runner e546首次控制目标两次hang均中止exit1并留原log，仅修测试child signalCode等待后1/1；根审又要求实际exit和close双观察，4f2927e8窄控制1/1、1161.8131ms，真实owned PID/socket/server关闭在回执前，缺witness仍503。root已合6c依赖得9c6fd979；固定4f消费者将首次强制类型/full。全员实时选区、历史实例OS/cgroup证明、生产挂载与恢复仍未完成，不能因当前模块绿给停止完成ACK。

### 上轮中央消费者与选区整合记录

- 中央factory与实际Agent消费者以no-ff收回到集成d001afe5。根固定34e6b7ba首次独立验证：类型exit0/7.110秒，13文件目标74/74、0失败/取消/跳过、10730.1805ms；全量5163项/5161通过/0失败/0取消/2跳过、69106.3348ms（墙钟69.469秒），native重跑0、源码不变。当前实例owned child必须实际exit且close后才接受停止witness；历史OS/cgroup证据缺失仍pending。
- 根固定8b255ab4组合中央e731与runner34e首次独立验证：类型exit0/7.843秒，16文件目标80/80、0失败/取消/跳过、10842.4277ms；全量5169项/5167通过/0失败/0取消/2跳过、79146.9525ms（墙钟79.531秒），native重跑0、源码不变。TMP/pc-root-agent-joint-8b255ab4-{type,target,full}.log及result.json为原始证据。运行授权仍缺真实instance注册/世代绑定时503，不把工厂夹具通过写成生产Agent上线。
- 两份已完成模块报告AGENT-codex-018-cloud-doc-assembly.md及AGENT-codex-018-agent-runner.md逐字节核同后移入docs/archive/agent-reports；未改首次失败、取消、跳过和未挂载边界。新任务另建叶和报告，不在已验源码上继续编辑。
- Sol全员选区消费者固定3f17b10a/报告cd7bd930：实际mock-model→Agent工具→真实doc WS目标1/1，LAN回归18/18、类型0，首次唯一full5164/5162通过/0失败/0取消/2跳过、73908.776ms。前三次目标失败因夹具把instance.callTool的agent字符串误传options对象，纠正夹具后通过，原失败保留。根逐读差异后固定bb0266fa首次独立组合验证：类型exit0/6.875秒，18文件目标99/99、0失败/取消/跳过、10786.277ms；全量5170项/5168通过/0失败/0取消/2跳过、79840.2968ms（墙钟80.250秒），native重跑0、源码不变，固定端口结束零监听。TMP/pc-root-agent-selection-bb0266fa-{type,target,full}.log及result.json为证；以no-ff收回集成edab0f87。真实实例注册、生产TLS链、实际模型和节点部署仍未验。
- Luna静态云端工具覆盖清单2e0d1b0d已读：30个不同工具名/用户可见行为、32能力行，现有20个hosted实现可复用不等于账号版逐工具或生产通过。新独占计划叶拆接口；Luna新独占实施叶对齐spawn_agent三个版本稳定关闭和自限定探针端口，旧叶冻结。
- 80b5e658的58项长验收继续自然运行：新增桌面自动节点、M7浏览器/本机节点、换档、查询渲染、多Agent、自定义测量、素材路径与素材快照均退出0。P-skill-mcp首次退出1，运行器--port-shift210把固定5880改为6090，探针在启动服务前按5880～5899范围拒绝；不是产品服务失败。原始日志保留，修正参数后只补该项，不整套重跑。GR6 HTTP500及A5首次host completed=0仍未通过，未结束或人工项不计通过。
- C10诊断固定9fc8e889/报告3652b04c保留hostDidWork完成标准，并为普通A5加真实r6-canvas重型fixture及精确clip→plan→claim→complete→ready新层校验；只通过纯队列8/8与类型0，尚无实际浏览器/主机探针结果。ready-index诊断0172f813仅加脱敏HTTP错误和保留临时输出，尚无实际补验；不会用诊断通过替代两项原失败。
- Astra新实例authority首块9aa15681真实mTLS/两个独立Agent子进程5/5；同签名换TLS、同cert新OS冒旧实例均拒，活Agent在doc SQLite关闭重开后重新签名可继续，只有实际子进程exit/close才接受受控owned witness。接run API固定9811de71首目标50项/42通过/8失败、1923.3917ms；七个子项是旧crash矩阵要求亡Agent后的新key接管旧grant/ACK及错误码顺序，另一个为父suite。按精确实例语义改旧测试，保留SQLite/receipt/不重放全部断言，并新增doc-only crash且Agent仍活的矩阵；不落盘实例私钥，不降低拒绝标准。此模块尚未完成或生产挂载。

### 云端策略与中央 HTTP 首轮记录

- 根固定e67ca4cf首次政策组合full：5173项、5170通过、1失败、2跳过、75364.0168ms；唯一失败是独立acceptance-port-scope测试从server/test反向导入scripts，触发依赖方向守门。Luna将同两条断言移入已有four-stage-acceptance测试，不改守门/白名单/端口代码；定向32/32。首次直接Start-Process启动npm.cmd失败发生在测试启动前，原日志保留；修隐藏cmd入口后才运行。
- 根固定2c5e942e独立修复组合：强制类型exit0/6.766秒，22文件目标144/144、0fail/cancel/skip、15658.8666ms；full5173项/5171通过/0fail/cancel/2既有skip、69552.7223ms（墙钟69.906秒），native重跑0、源码不变。原始TMP/pc-root-cloud-policy-repair-2c5e942e-{type,target,full}.log及result.json保留。以no-ff收回集成2f6dfd19；云端spawn三个版本稳定回已定文字且不建对话/页面请求，LAN原实现保持；自限探针真实manifest端口断言保留。
- 剩余工具设计92a1289b已审收回：F0持久可信context/asset/job先行，P1镜头+素材拼图最短真实链，其余感知/browser/audio/本人页面/采集/视觉按独占接口派，末尾唯一Glue owner改工具表。23 pending及现有20 hosted仅复用可能，实例TLS、逐工具账号/素材/render全链与节点依赖未验不报通过。RS18单活跃项目、RS19实测双项目、RS20缓存轮转目标及新待确认项保持原文，不将建议接口/内存数当用户批准。
- Astra最终实例authority源码a50f7dcd/报告6e3cad46的实际日志根已核读：类型exit0，最终full5178项/5176通过/0fail/cancel/2skip、74328.686ms；doc-only退出73后活Agent同RAM key恢复、同cert新OS不能接旧grant/ACK、零grant实例也纳入准确关闭清单。此前crash矩阵8失败、WS期待缺seq/ack的1失败及修复分别保留。根尚未对新真实消费者组合独立full，不能把此核心通过说成生产挂载。
- 新中央018-agent-instance-doc从6c3ca23a含最终authority；HTTP固定f45c912b目标3/3、0fail/cancel/skip、5737.7801ms，前后源码不变与5770～5774零监听，日志根已核读。真实VH327/order→同ledger factory→独立asset→两页面/Agent mTLS实例注册与逐调用cap；旧实例403、HTTP ticket仍503。新增RAM能力仅当前调用有效；WS/LP逐帧scope、same-instance resume与真正TLS消费者未完成，交两个Sol独占接线、Astra只读审边界。
- 80b5e658长验收自然结束：58项52pass/5fail/1manual，exit1、墙钟6428.406秒、源码不变、自动重跑0，原完整results.json/log保存。五个首败为G0-5进程模块路径、GR6快照HTTP500、P-c10-browser-full普通A5、P-skill-mcp端口6090越探针范围、P-storage-ui编辑器菜单项缺失；X-render-host-local人工不计通过。G0-5已有同源因果补验37/37，其余分别补查，不整套重跑覆盖首次结果；1800帧仍与main逐字节相同。
- 根新增ready诊断固定e2c02586实际运行56.875秒、exit1、源码干净不变，原500复现且拿到明确错误handleStreamRequest is not defined。frame-stream只export-from，没有为StreamProducer.handle建立模块内绑定；新独占窄修复叶待派，不改route次序/资产权限/探针断言。原始TMP/pc-root-probe-diagnostics-20261008-ready.log及临时ready-index-diagnostic.json保留。根wrapper仅识别单行JSON造成该pretty JSON的ok未提取，不能以空fails报通过；真实退出1为准。storage6340与skill5880诊断按后台顺序运行，未完成不计通过。
- F0 ToolJobs首块ba71bab4经根审发现幂等context漏sender/message，Luna以5c6722a0绑定整份context并保留首块；定向11项/10通过/0失败/1Windows POSIX权限跳过、160.6214ms，类型exit0/7.121秒。尚未根组合full、Linux权限实际验证或生产接线，不将本机SQLite fixture说成工具执行/子进程取消已完成。
- 已完成的10个本任务工作区及本机分支按clean/ancestor/zero-reparse/zero-process-reference核对后正常清理：018-run-authority、018-agent-access-v2、018-runtime-verification、018-runner-verification、018-agent-joint-verification、018-agent-selection-verification、018-cloud-doc-assembly、018-agent-runner、018-agent-live-selection、018-cloud-tool-coverage。ignored文件先逐字节保存TMP/pc-completed-worktree-ignored-8f90bda59482462bb39582fbd2437c94及pc-completed-leaves-ignored-7cf79fc1db3742bd8e4fdb8723df2f0c，proof.json保留，未打印内容。原8个用户工作区、失败叶、备份及生产数据保留。

## 本次做了什么

- 根固定506cd0e0独立实例HTTP组合：强制类型exit0/6.594秒；30文件177项/173pass/3fail/0cancel/1Windows权限skip、15841.5134ms，native重跑0、源码不变。三失败均旧agent-runner-read/control夹具缺强制instanceAuthority，错误run-authority-configuration；因此full未启动。保留失败叶与TMP/pc-root-instance-http-506cd0e0-{type,target}.log/result.json，不放宽产品身份门。
- Worker固定d5d7de67/报告cc1bac0f已根逐diff审：两旧夹具登记真实SQLite实例RAM key并逐作用域签名，原read ACK/撤权/错证书/child exit+close/socket close/缺witness断言保留；同OS未知admit持有原requestId，finish ACK未知仅续原finish，不重执行模型/工具。owner正式npm目标5/5、0fail/cancel/skip、1298.3014ms，types0/8.402秒；另一次误用裸node --test与两次TMP归档导入命令偏差均如实保留，不冒充实际mTLS/model证明。归档入口最终静态import通过；TMP stage删除被自动审批拒绝，目录保留、未绕过。缺模型配置时finish续办被preflight阻断的审查点已交owner，不把cc1作为最终runner完成。
- 快照固定8d49c1f4：StreamProducer.handle原export-from不能建立模块内绑定，仅本地import加handleStreamRequest。Luna修前真实类反例22/21/1、ReferenceError；修后首轮fixture initId不符合16hex失败22/21/1，修fixture后22/22、117.3873ms，types0/6.764秒。根新277136ea组合包含HTTP/ACK修复、快照和C10诊断，强制types0/6.516秒、frame-stream+C10纯目标30/30、0fail/cancel/skip、823.9508ms，源码干净不变、native重跑0。root实际ready探针及服务目标/full尚未运行，等待C10共享租约自然结束。
- 根ToolJobs固定5c6722a0精确9文件Git包SHA256 f66496be28ae11a00bdbc7ba3613607508ed12df01924c316370a3d66ddc6a0b：节点TMP、visuhive-account账号实际npm目标11/11、0fail/cancel/skip、474.366492ms（墙钟1.3406秒），含真实POSIX父700/DB600及既有共享父权限不变。nginx9395/账号204715前后相同，无部署。wrapper初次PowerShell引号错误发生在SSH前；原hosted /proc stat按空白拆列给出0不是合法出生证据，补只读正确解析确认PID24163/startTicks6645844存在，仅作测后证据，不补造测前身份。runid pc-tool-jobs-linux-15cd49ca079543559476e9d541f0d02d日志保留；Windows权限skip不作通过，产品工具执行/取消尚未接线。
- 根旧80源码skill实际单项命令端口5880：exit0、ok:true、35条PASS、fails空、墙钟17秒；已看真实AI栏分组图。storage固定dc51afa4诊断：exit0/ok:true、U1–8及editor菜单入口过、墙钟77.938秒、pageErrors空，根已看菜单截图；仅诊断增加采样，不是产品修复，原80的编辑器菜单首败原因仍未确定。原ready e2 exit1/56.875秒及pretty JSON wrapper提取失败仍保留；空fails不能算通过。
- C10固定3652b04c根独立type0/6.969秒、纯目标8/8/824.8106ms；full5069项/5047pass/0fail/cancel/22skip、64348.4596ms。该根wrapper遗漏VH provider/order环境造成额外skip，明确不当最终完整基线；下一次有配置的新共同候选覆盖，不同源盲重跑。真实Chromium/独立host探针自然结束：exit1/ok:false/7失败/pending0、墙钟1766秒、native重跑0、源码不变；缺目标计划后又等host完成与新层的7条失败保留。cleanup为本次临时项目shared.admin.ok，最终listening为空、根端口6320～6329亦零监听。TMP/pc-root-c10-3652b04c-probe原输出和截图保留。
- Astra夹具修复固定0c1ccf2a/报告70458814经根全diff审：真实持久r6片段成本身份136798c2570ddc对应实际L2 build stepMs=0.2，未进最终预渲染清单；canvasHeavy描述载体，不等于页面实测判重。此因果不扩大为旧80首败唯一原因。正常particles400合法参数替换，启动host前必须同身份完整真实成本、生产clipWeight判重、舞台heavy与当前发布清单含目标，前置缺失保存证据并失败；原精确任务/host指纹/non-dedup完成/新层断言保留。owner纯目标10/10、0fail/cancel/skip、1537.3001ms、type0/7.485秒；真实粒子是否判重及host完成未验。根57985002已收此源码与c377，尚未新full或宽探针。
- Worker c377c248补修finish先于模型preflight：已完成轮ACK丢失期间模型配置暂不可用仍仅续原finishId，后排消息不先admit，模型/工具不重执行。根逐diff与原日志核读，owner正式目标3/3、0fail/cancel/skip、196.495ms；旧cc1/506首失败保留。WS/LP消费者独立叶仍实现中，不能据此把main ready置真。
- 中央074bbe27已根逐diff审：7aac真实部分POST body反例使合法LP send得到409（应200），日志pc-instance-doc-preauth-7aac-counter.log保留；074使Agent recv/close/send先完整验proof/current再登记请求、占发送位或更新lastSeen，普通LAN路径保持。组件相关目标38/38、0fail/cancel/skip、5537.8528ms，实际关闭证据已核。完整真实mTLS实例/逐帧签名provider首7506目标3项/2pass/1fail、4893.7788ms（墙钟5.255秒）、exit1：WS welcome后project.open回type:error而非project.state，后续selection/write/LP尚未跑到。只加安全type/reason的78c8诊断待一次独占窗口，不猜根因、不降低授权标准。
- 新独占018-cloud-tool-context叶从277136ea开始，Luna只租可信8字段context/逐调用授权适配器及专用测试/报告。项目、消息、发送者、实例与世代只能来自已确认读的当前doc grant及注册证明；不从模型参数或缓存用户名构造。ToolJobs仅持久账本已验，asset/provider/控制关闭及生产工具接线仍待完成。
- Astra固定a506454e审查与原session/router纯反例确认M1未await、外围乱序、旧transport回调缺current检查，及worker admit/finish ACK缺恢复；已交owners。中央cc5465a8组件目标2/2、0fail/cancel/skip、2135.1394ms，实际临时WS/LP端口close已核原日志，但cap/auth是受控组件fixture，非完整签名中央通过。独立固定cc546纯反例又证LP超限未验proof即关闭、空batch无proof取ack、旧recv/close跨resume影响新会话，中央按最窄core修；nonce/schema、延迟recv fresh read与同步fence先关仍需完整实际mTLS WS/LP验证。生产runner保持未挂载，不admit/model；OS/cgroup完整关闭回执未齐仍pending。

## 接下来干什么

1. 保留80长验收、506首目标失败、3652真实C10失败与7506中央签名首失败；先取中央安全拒绝原因、收冻结修复后完成根新共同候选types/服务目标/full、快照真实ready探针及带真实前置证据的C10。明确配置VH provider/order，未配置skip、人工项与旧成功不能替代最终候选基线。
2. 调度纯文档已收回并推送，沿用claude/four-stage；不盲合最新main、不打断在途验收。小阶段真正共同基线通过后合入main并推送，进度随提交更新。
3. 两Sol完成中央与worker的真实mTLS WS/LP逐帧、同实例resume/FIFO/ALS/fence/data消费者；Astra按冻结源码复核反例，再给真实服务目标租约。随后依设计接ToolJobs与剩余工具/UI、实际独立OS/cgroup关闭清单，部署前完整备份恢复；已过fixture不当生产已挂载。
4. 新调度包先约本地完整查询资格与云端单活跃项目接口，准备真实自定义卡片容量场景；提前让位、故障A/B和删除细节仅记录/草拟，不依据旧常规裁定授权自行选择。原先已授权且不依赖它们的工作继续。
## 还差什么

按版本列，做完一项划掉一项。范围以 `account-binding-task.md`「三个版本」为准。

本次补充条目的状态分别记“已规划 / 已实现 / 已测试 / 已通过”。以下新增RS条目均仅已规划，后三项未完成；目标不等于已验证能力，实际原始结果与最终提交另行补齐。

### 0.7.18

- [ ] 集成分支合入 main
- [x] 迁移设计与接口约定（19 包与跨仓库接口；产品实现/故障证明尚未完成）
- [ ] 账号接入：桌面版与在线浏览器的新建、加入、搬到云端
- [ ] 云端文档服务记项目的创建者、成员、禁入；网站两张项目列表
- [ ] 踢人对账号的所有设备生效
- [ ] 在线浏览器新建云端项目；和官网共用登录
- [ ] 素材不能跨项目读
- [ ] 旧文件打开转成本地项目；缺失素材占位（文字卡与「找不到素材」人声）
- [ ] 剩余的云端 Agent 工具（不含 `spawn_agent`，它回「云端暂不支持开子 Agent」）
- [ ] 云端素材采集：发起人电脑代下，做不成退回不带登录态
- [ ] Agent 对话共有/私有、逐条记发送者、谁能切换与停任务、创建者只读
- [ ] 合格本地即时取帧优先、完整授权/能力/可用性核验与云端单活跃项目兜底排队（RS18-local/queue；已规划）
- [ ] 同项目同创建者50个不同对话满额阻新建、用户先删旧对话、不自动删历史，补齐删除入口（RS18-chat；已规划，删除细节待确认）
- [ ] Agent 已读记录；被踢或改密退出时的任务处理
- [ ] 改密或重设密码后选是否退出其它设备
- [ ] 产品交互验收
- [ ] 版本提交、完整安装包、兼容补丁、release 推进
- [ ] 部署（先账号后端，再 PromptCut 服务与在线页面，最后依赖新接口的网页）
- [ ] 真实网络环境验收
- [ ] 旧测试项目清理与清理后的真实旧文件验收

### 0.7.19

- [ ] 撤销低内存档；身份
- [ ] 舞台闸门、崩溃记录、护栏、档位气泡
- [ ] 素材闸门、即时渲染闸门、最低一档
- [ ] 在项目级及总体内存预算实测支持的组合中尝试两个项目并行，未通过组合保留限制（RS19-memory；已规划）
- [ ] 保存时固定非本机快照
- [ ] 断网改动保留；重连后的合入面板
- [ ] 验收、发版、部署（同上）

### 0.7.20

- [ ] 磁盘缓存与交替加载，使至少三个含自定义卡片的项目持续轮转推进，验证等待/吞吐/无饥饿，不承诺三个重型常驻（RS20-rotation；已规划）
- [ ] 退出后撤回这段时间的修改（按修改项逐条核对）
- [ ] 撤销按钮遇到冲突时的窗口
- [ ] 申请加入
- [ ] 验收、发版、部署（同上）

## 待用户项

需要用户事后审、或需要用户亲手做的事。旧常规事项按2026-10-08一口气做完授权继续：做到时照 `solution_table.md` 选改动最小的做法、标〔裁〕，写明原因与其它选项，用户事后审、推翻的返工。下方“渲染调度补充仍待确认”的新事项按最新指令保持开放，不自行裁定。

- 撤销按钮冲突窗口里的选项。（先按合理的做出来，截图放在这里，用户事后看。可参考的一种做法：列出冲突的每一项并写明「你改成了什么、之后谁改成了什么」；每项两个选择「仍然撤回」「保留现状」；底部「全部保留」「全部撤回」；直接关窗等于全部保留。这是别的会话的建议，用户没表态）
- 模型 Key：不用找用户。密文已存在节点上：`/root/promptcut-pending/agent-model-key.blob`（只有 root 能读，2026-10-08 放的，和用户给的那段核对过一致），部署 Agent 服务时用 `--file` 导入，成功后删掉它。
- 真机核对：iOS Safari 崩溃后自动重新载入、安卓 Chrome 的进程隔离、各机型落在哪一档。
- 〔裁·拟实施机制〕迁移方案的 14 项机制选择及替代在 `three-versions-018-design.md`「最小裁定解法表」：云端账号 v2/LAN v1、OS 用户与内部 mTLS、可撤销凭证寿命、统一顺序见证、完整操作历史、撤销冲突窗口、可信已读/runGrant、项目物理素材库、本机代下桥、私有视觉权限、准确 gone 证明、缺素材人声时序、Agent 8791、回退不复活旧凭证。已定产品语义不重新标待决；机制实施与实验证据随各包补齐，用户事后审。

### 渲染调度补充仍待确认（e0e3afc3）

用户明确要求保留待确认；这些事项不阻塞本次文档整合。已批准的版本方向、50满额阻新建和必要删除入口不重复询问。只有实施确实依赖它们时集中提问，每轮最多三个核心问题。

- 提前让位：有其他项目等待时，当前项目空闲未满5分钟能否回收驻留。旧60秒/45秒规则仅历史机制，不能替用户决定。
- 补渲故障/持续无进展：A进入失败、用户手动后续；或B保留可恢复待办、有限重试后暂停、用户重试或取消。正常容量等待不属于故障；旧MAX_ATTEMPTS/OOM自动重排不作新批准。
- 删除细节：权限、必要确认、共有归属/计数口径、创建者身份关联、名额释放时机与在途任务处理。已有owner DELETE不是批准依据；本次不删真实数据。

内存7+7+2、5+5+6 GB是未验证示例，不设为默认或阈值。计时起止点、接口及缓存/重试技术建议留设计草案，不能标用户逐项批准。修改前/后与六组验收映射见[账号任务书](account-binding-task.md)及相关契约文首替代补记。

### 四阶段清单对齐（用户已审定项不再待审）

去重清单与原始来源见 [three-versions-rulings.md](three-versions-rulings.md)。用户于 2026-10-08 已审定 P1–P8、P10、R1，下面按新决定记当前依据；只有 P9 仍为界面事后审项。共 50 条：待事后审 1、已定 21、被取代 15、实现记录 13；D17–D21/S13–S15 保留旧 P1–P5/R1 的映射，不将已定内容再次列为待用户。
| 清单号 | 当前采用或待在模块里落定的内容 | 采用原因 / 其它选项 |
|---|---|---|
| P1 | 用户已定：所有浏览器执行用户卡/图卡，不能因不认出口白名单而退回 | 本期撤销这道执行条件；舞台与编辑页面分源、项目素材隔离保留 |
| P2 | 用户已审定：纯浏览器不认领超限图卡任务，交 PC/云节点 | 现有容量边界照旧 |
| P3 | 用户已定：用户卡/图卡外链图片、字体、样式、脚本照常加载 | 出口护栏三版本不做，已列以后待办；已有出口限制不能挡画面与资源 |
| P4（D19） | 用户已审定：数字先沿契约、部署按节点复核；补充明确.18云端单活跃项目与合格本地查询优先；预渲染/即时看画面超容量均等待，Agent优先 | 不因队列满/背压终态报忙或已满，不因云端满静默本机回退；本地优先是已确认显式路径；既定deadline不作任意负载五分钟保证；仅多服务器分配延期 |
| P5 | 用户已定：同时读所有在线成员选区，各标用户名，发起人标（当前用户） | 发起人离线用发消息快照并注明非实时；原只读发起页规则作废 |
| D13（旧 P6） | 用户已定：共有切私有时其它成员在途任务立即停止，已落地修改保留 | `6f85cd78`，不再由主会话裁定；排队的其它成员消息一并作废 |
| D14（旧 P7） | 用户已定：没有生产存量对话，不用做历史对话迁移 | `6f85cd78`；旧契约的数据结构仍须按账号与共有/私有重写 |
| D15（旧 P8） | 用户已定：同对话一次一轮，按服务器到达顺序排队，显示第几 | `6f85cd78`；需并行时另开对话，逐条记录实际发送者 |
| P9 | 撤销按钮冲突窗口的选项 | 0.7.20 先实现并截图，事后审；不改已定逐项冲突语义 |
| D16（旧 P10） | 用户已定：顶配、标准、精简、低配四档都提示，预览窗口上方几秒后消失 | `6f85cd78`；文字逐字按 product/platforms.md，不再由主会话定 |
| M1 | 声音轻重测量及数字沿 mechanism/rendering.md | 既有实现保留；新档位限制在 0.7.19 对齐 |
| M2 | 编辑器只加 frame-src；声音产物键不带在线运行时版本 | 既有机制保留，迁移设计核对安全与产物一致性 |
| M3 | 管理握手仅本机、工作进程专用非 root 用户 | 既有机制保留，节点部署按清单验证 |
| M4 | 内存、文档响应、CPU 负载触发背压与恢复 | 既有机制保留，不把发布耗时恢复成门槛 |
| M5 | 用户卡按项目隔离工作进程和看画面优先保留；旧闲置/轮换参数仅历史机制 | 新版本范围与五分钟驻留/提前让位待协调，不能以实现记录代替批准 |
| M6 | 托管渲染第一版不启轨道流 | 既有范围保留；桌面轨道流仍走基线 |
| M7 | 原10/30分钟放弃仅历史机制，补渲故障/持续无进展A/B仍待确认 | 新补充取代“沿旧机制即采用”解释；正常容量等待不作失败，旧数字不定重试预算 |
| M8 | 服务登记表鉴别 Agent 看画面请求，看画面优先预渲染 | 保留服务身份，迁移时仍须精确核对项目授权 |
| M9 | Agent 计数、诊断空状态、消息错误与离线提示 | 保留用户已定界面和既有实现延迟，迁移后复验 |
| M10 | 看画面模型可见而旧聊天记录无图、排队、开关失败及产物用量 | 原实现记录，交迁移/工具设计逐项核对，不冒称容量统计已验证 |
| M11 | 原发起页刷新后的控制工具与 seek 后播放头；旧选区机制待替换 | 选区按 P5 读取全部在线成员，控制工具仍核实际发起账号；spawn_agent 关闭 |
| M13 | 无 systemd 的看护降级、限流退避与容量停写 | 既有机制保留，实际新节点按 systemd 清单部署 |
| M14 | 读采样音频图卡退回产物、审阅表不随源码同步、先 nginx 后页面 | 保留已记录范围；账号后端仍须先于依赖它的网页 |
| R1 | 用户已定：托管方能读节点全部对话，含私有；首次用云端 Agent 弹框告知 | 0.7.18 做；我知道了/拒绝，按账号记同意，拒绝不发送并于下次再提示 |

## 派出去的活

现在有哪些子智能体在跑：哪个模型（Sol、Luna、Astra）、做什么、在哪个工作区和分支、状态。收回并清理后从这里删掉。

| 模型 | 工作 | 工作区 / 分支 | 状态 |
|---|---|---|---|
| Sol | 中央真实实例HTTP、WS/LP逐调用scope与same-instance resume | .worktrees/018-agent-instance-doc / codex/018-agent-instance-doc | cc5465a8组件目标2/2；Astra残余LP反例已交窄修，真实mTLS WS/LP未验；无fixed/full租约 |
| Sol | Agent启动RAM key、真实TLS签请求、账号main守门与数据消费者 | .worktrees/018-agent-instance-worker / codex/018-agent-instance-worker | cc1bac0f旧夹具/ACK修复目标5/5/type0已交；WS/LP客户端与生产接入在途，无full/部署 |
| Astra | 新数据通道实例/nonce/seq/ack/ALS/fence只读审查 | .worktrees/018-instance-data-review / codex/018-instance-data-review | a506454e首审已交；续审冻结cc546/cc1，LP残余反例成立，早发owners；仅报告/TMP，无fixed/full/节点 |
| Luna | F0可信持久ToolJobs；快照缺模块内绑定窄修复 | .worktrees/018-cloud-tool-jobs / codex/018-cloud-tool-jobs；018-snapshot-stream-fix / codex/018-snapshot-stream-fix | jobs5c根Linux11/11；快照8d49已交/根纯目标过；实际ready/组合full待验，当前idle |

## 没做到的与原因

按 `solution_table.md` 扫空了仍没做到的，写在这里：哪一条、卡在哪、试过什么。
