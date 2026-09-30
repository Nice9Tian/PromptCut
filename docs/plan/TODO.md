# TODO

还没做完的工作。未开始的计划和它们的协议全文都在本目录 `docs/plan/` 里；已做完步骤的记录归档在 `docs/archive/`。计划与 `docs/semantics/` 冲突时，以 semantics 为准。

## 未开始的计划

| 事项 | 计划文件 | 状态 |
|---|---|---|
| 轨道流：重卡在播放时贴的 alpha 视频流 | `docs/plan/r8-streams-task.md`；编码原型报告 `docs/plan/g0-b-stream-prototype.md` | 已合入 main（`787f7d9`，R8 G1～G7）；遗留见下文「已做步骤的遗留」的性能缺陷一条（2026-09-27 勘误，C10 契约第 19 节） |
| 共享 WebGL 渲染器：canvas 卡共用一个 WebGL 上下文 | `docs/plan/r9-webgl-task.md` | 已合入 main（`eff2011`，R9 M1～M5）（2026-09-27 勘误，C10 契约第 19 节） |
| 素材服务与文档服务（本地或远程，可任意组合部署）、产物入库、改动竞态、Agent 的查询进程、在线浏览器模式 | `docs/plan/cloud-task.md`；动工前的问题已定，见文末「已定的决议」 | 大部分已随 M5～M8 与 C5～C10 做完（素材服务、文档服务、产物入库、Agent 直接写文档服务、在线浏览器模式；见下文「语义与代码的差距」末条）。还没做的是 I 节：预渲染进程的三种模式与 Agent 查询进程（见「语义与代码的差距」的「查询渲染」一条；I4 的实现注写在 `cloud-task.md` 里） |
| 分布式预渲染：文档服务托管的拉取式渲染任务队列，本机 PC、独立渲染主机、纯浏览器认领任务 | `docs/plan/distributed-prerender-queue.md`；落地任务书 `docs/plan/TASK-distributed-prerender-queue.md`；主执行计划 `docs/plan/Master-Execution-Plan.md` | **M0～M8 已全部合入 main**（总报告 `docs/reports/REPORT-M5-M8.md`，各阶段报告在 `docs/reports/`），之后的交接收尾与遗留见 `docs/reports/REPORT-post-M8.md`。只剩真跨机的 W7 复核（PC 当创建者、笔记本当纯浏览器节点，经阿里云），等 PC 上线 |
| 直连：云端托管服务的牵线与中继，本机项目成员的三条连接路径（局域网直连、公网直连、中继）；端口映射、IPv6 直连、打洞，逐种测、逐条报原因 | `docs/plan/direct-connect-plan.md`（2026-09-26 从主执行计划的 NET 阶段搬出） | 未开始，不在 M5～M8 之内 |
| HT-b：文档服务的 HTTP 长轮询传输（会话层之下的第二种传输） | `docs/plan/http-transport-contract.md` 第 2 版的 HTTP 部分；第 1 版代码在 `claude/http-transport`，HT-a 后保留不接线 | 2026-09-27 从 HT 拆出，未开始；触发条件：出现被代理挡住 WebSocket 的成员（2026-09-27 实测云端容器的 Node 不被挡）。**后续项**（HT-a 集成时记下，契约第 17 节）：① 仍用旧 `createWsEndpoint`、没接会话层的调用方——`server/card-sync.mjs`（编辑器进程与主机的卡片源码同步）、`scripts/probes/shared-project-lan.mjs`、`render-host-probe.mjs`、`c66-t9-probe.mjs` 的页面连接——对新服务端是旧客户端，行为不变、断一次就断线，接会话层时一并做——**已在 M8 计划 D9 做完**（分支 `claude/m8-session-legacy`，2026-09-28，待合入）：卡片源码同步、素材地址登记（含托管组合的管理连接）、`shared-project-lan.mjs`、`render-host-probe.mjs`、`c10a-demo-probe.mjs` 改用 `createDocEndpoint`；`c66-t9-probe.mjs`（归 `claude/m8-e2e`）与 `shared-project-probe.mjs` 的令牌连接（归 `claude/m8-migrate`）留给各自分支，理由见契约第 17.6 节；② 节点端第 1 版 HTTP 客户端 `server/render-node/http-transport.mjs` 按第 2 版协议与第 14 节的错误归类改写、重写测试；③ 第 6 节补 409 `superseded` / `busy` 与 `bad-ack` 的回法（第 17.3 节第 9 条） |
| 音频整体改成浏览器端 JS | `docs/plan/audio_structure_plan.md`（A0～A7）；判重测试计划 `docs/plan/audio_determine_plan.md` | 计划已写，未动工 |
| 以后再做：桌面版给只有素材原尺寸的云端素材补转素材小尺寸；导出页装虚拟定时器 | `docs/plan/future_planning.md` | 暂缓 |
| Agent 与工作方式：创造力等级、「用户正在编辑」、多 Agent、SKILL 经 MCP 直连、后台运行（托盘与悬浮窗）、Agent 用 JS 自定义测量 | `docs/plan/agent-workflow-plan.md`（2026-09-30 写，A1～A6） | A1、A2、A3、A6 已合入 main（2026-09-30，`REPORT-post-M8.md` 第 5、6 轮）；A4（SKILL 经 MCP 直连，含去掉对话式布局）在 `claude/skill-mcp` 上做完待验证；A5 改 Rust 外壳，完整安装包要在 PC 上打——A4、A5 做完先留在分支上，PC 上线出包实测后一起合入 |
| 存储占用（二级功能项）：桌面版帧库设上限、按项目最近使用淘汰、给「清理缓存」入口；导出产物目录有列表、大小与删除 | `docs/plan/storage-plan.md`（2026-09-29 写，含语义 dry run 与接口约定）；排在 M8 之后、团队测试之前（主计划第 4 节） | 2026-09-29 用户加：帧库 `Videos\PromptCut\frame-library` 已长到 273 GB，没有上限也没有淘汰；导出产物每次一整份，连导三次就三份，没有清理入口。计划已写，按用户 2026-09-29 的 goal 不等确认开工（〔裁〕见计划第 3 节）。**已合入 main**（`fe62c17f`，2026-09-30，`docs/reports/REPORT-post-M8.md` 第 2 轮），随 0.7.3 发布（`/editor` 已部署，桌面补丁待 PC 上线） |

**路线 B**（2026-09-24 用户定）：素材服务是字节的唯一读写出口，素材服务在本机时也经它，Agent 进程和预渲染进程同样只走它的 HTTP API；预渲染产物（HTML 快照、PNG、MOV、轨道流）生成后一律推送到素材服务；两个服务部署不设限、可任意组合，素材服务允许局域网跨源访问，文档服务预留连接发现 / 信令接口；第 5 步只建素材服务空壳与底层 API 契约，A1 的其余部分、A5、A3b 在第 6 步；`uploaded` 字段废除，同步状态只问素材服务；原第 8 步移交 R 系列。

## 已做步骤的遗留

- **用户真机缺陷，排在第二批遗留之前、当前一轮（r3-merge 与 0.7.4）出完就做**（2026-09-30，用户项目 `9tian666.proc`，PC 桌面 `C:\Users\admin\Desktop\`，同名 `.mp4` 是成片；原素材 30 fps、项目 30 fps）：**图卡的视频输入源在 0.5 倍慢放导出时节奏不均**。成片相邻帧差异实测：1 倍速段与原素材逐帧对得上；0.5 倍段本该「新、重、新、重」两两重复，实际是「新、新、重、新、重、重」六帧一循环（一帧停 3 拍、一帧停 1 拍、一帧停 2 拍），看起来一顿一顿。
  - **根因**：`src/render/cards/mediaSource.ts` 的 `frame()` 把「偏移 + 速率 × 时间」原样设给隐藏视频元素的 `currentTime`，收到 `seeked` 就取图。0.5 倍速下每隔一帧目标时刻正好落在素材的帧边界上（如 12.600000 s），浏览器把时刻转成微秒时截断，目标比那一帧的时间戳早不到一微秒就取到前一帧，取前一帧还是本帧随浮点误差摆，节奏就乱了。按「取时间戳 ≤ 目标的最后一帧 + 微秒截断」模拟，算出的节奏与成片一致；按「边界归本帧」模拟就是两两重复。不是帧率换算（没有 30→25），也不是滤镜。
  - **修法**：seek 目标统一加一个小于一帧的正偏移——素材帧率已知时对齐到帧中心，未知时 +2 ms（与 `src/render/frameMedia.ts` 出画判断里的 2 ms 容差同一个数）。只改 `mediaSource.ts` 这一处；`frameMedia.ts`（时间轴视频片段的导出取帧）是同类写法但目标同样原样 seek，用下面的节奏探针一并覆盖，探针不过再用同款修法。
  - **三级语义**（写进 `docs/semantics/mechanism/cards.md`，标〔裁〕，用户合入前审）：「图卡的视频输入源在时刻 t 取素材里时间戳不超过 t 的最后一帧；t 正好落在帧边界时取边界上这一帧。变速与偏移先算出 t 再取帧。实现上 seek 目标加 2 ms，不依赖素材帧率。」时间轴视频片段的导出取帧按同一句理解。
  - **基线怎么定（2026-09-30 用户定，由「大哥」会话写死）**：
    1. **导出像素基线预期 0 不同、0 缺失**，照常比。若出现差异：差异帧必须全部是含图卡视频源的帧，且这些帧新取到的源帧符合上面那句规则（用第 2 条的解法核）——两条都成立才允许重定，重定就是把 PC 的 `.worktrees/pc-g0r-base` 与笔记本的 `.worktrees/main-g0r` 都换到合入修复后的 main 提交，报告里写明换到哪个提交、差异帧数、原因；不满足两条的任何差异都算修错，不得重定。
    2. **新增节奏探针 `scripts/probes/video-source-cadence-probe.mjs`，就是这条行为此后的回归基线**，纳入 G0-R「预渲染探针」一行，改到取帧、解码、图卡视频源、`frameMedia.ts` 时必跑。做法：ffmpeg 合成 30 fps、2 s、64×64 的素材，第 n 帧整幅亮度 = 16 × (n mod 16)、色度中性（阶梯 16，扛有损编码）；再合成一份 25 fps 的验非整数比。项目 30 fps，用例：①图卡节点（原样输出上游的图卡）输入源 rate 0.5、offset 0 与 0.35（10.5 帧，非整帧）；②rate 1、offset 0；③时间轴普通视频片段 mediaOffset 0 与 0.35（覆盖 `frameMedia.ts`）；④25 fps 素材 rate 1。各导 60 帧，读每帧视频区域平均亮度，四舍五入到 16 的倍数、按单调性还原成源帧号 m(n)。**断言 m(n) = floor((offset + rate × n / 30) × 源帧率 + 1e-6)**：rate 0.5 是 0,0,1,1,2,2…；rate 1 是 n；offset 0.35 是 10,11,12…；25 fps 素材是 floor(n × 25 / 30)。退出码 0、`fails: []`。
    3. **真机验收**：用 `9tian666.proc` 重新导出，对成片 0.5 倍段（17.87～26.37、32.37～40.43、46.43～54.97、60.97～69.97、75.97～83.47、83.47～97.12 s）算相邻帧差异（`ffmpeg -vf tblend=all_mode=difference,signalstats`），去掉每段开头 0.42 s 的转场覆盖后必须严格「新、重」交替；1 倍速段仍与原素材逐帧对得上。项目与素材由用户打成 `.procp`（顶栏「打包保存…」，编排 + 素材）直接发给笔记本主会话，验收在笔记本做，不用 PC 辅助；导入到会话自己的 dev-test 数据目录，不进用户的 `Videos\PromptCut`；音频素材缺了就去掉音轨导出，验收只看画面。
    4. G0 与 G0-R 其余项照跑；单测补 `mediaSource` 的边界用例（目标正好等于 k/30 时取第 k 帧）。
  - 修好随下一个补丁版本发；通知用户时写明「慢放段的画面会变，是修正」。
- **〔已做〕R0**（2026-09-30 修完：`claude/watch-ignore` 修依赖扫描入口与监听忽略，Tailwind 扫描源随 `claude/query-render` 改；树内帧库 15 万个文件时冷启动 3.0 s / 10.0 s，与空帧库相同，0.7.4 是 17 s / 180 s；报告 `docs/archive/agent-reports/AGENT-watch-ignore.md`、`REPORT-post-M8.md` 第 5 轮）原文：帧库落在 Vite 根下时仓库根 dev server 冷启动慢。
- **R7b 没做成的**：R7b 报告第 4 节的 8 条更正已折回 `docs/archive/restructure_planning/r2-r7-task.md` 文末（2026-09-30，`claude/query-render-2`）；「只停了快照、没停 PNG」见「语义与代码的差距」的「legacy 整帧通道」一条。
- **〔已做〕see_frames 回包附实体矩形**（2026-09-24，`8124996d`：预渲染在 `captureSnapshot` 的 `afterFonts` 钩子里量 `rectsWithBounds(pixels: "all")`，每帧结果带 `rects: [{ clipId, box, solid }]`，工具结果的文字部分按 clipId 一行；2026-09-30 核对时补记）原文：原云端计划第 8 步，协议在 `docs/archive/restructure_planning/r2-r7-task.md` 的 D3，归 R 系列，可与云端计划并行推进。
- **待用户定**：播放停顿期间要不要加音频看门狗，让音频立刻停。
- **〔已修〕**（2026-09-28，`claude/perf-encode-2`，main `501a7dd7`：只改 `server/bakery/ffmpeg.mjs` 的编码参数装配，产出逐字节不变；全案最终基线笔记本 p50 207～224 ms；2026-09-30 最终合流 G0-R 笔记本 p50 261 ms，仍过线，见 `REPORT-M5-M8.md` 第 7.5 节、`REPORT-post-M8.md` 第 2 轮）原文：- **性能缺陷，M8 之前必修**（2026-09-27）：1080p 全幅流 15 帧分段编码在笔记本上 355～397 ms，门槛 300 ms（`stream-produce-probe`，C10a 报告第 2.13 节）。笔记本是性能基准机（`guide_files/verification.md`），在笔记本上修到过线，或经用户确认改门槛。
- **维护项：在线构建剪掉置灰入口背后的调用**（C10 集成，2026-09-28）：在线页面上置灰的入口（导入媒体、语音识别、配音、改卡等，`docs/plan/c10-contract.md` 第 10 节）点了不发请求，但调用代码仍在在线构建的产物里，`/api` 棘轮清单（`server/test/c10a-online-api-paths.json`，120 条）因此一条没少。按编译期常量把这些调用剪掉，让清单变短；清单只许减不许增。
  - **已做**（2026-09-28，`claude/online-prune`，M8 遗留 L24；报告 `docs/archive/agent-reports/AGENT-online-prune.md`）：清单 120 → 19 条，在线构建 `assets/` 少约 38 万字节；C10A-API-03 改成清单与产物逐条一致。做法更正：**不是照 `collab.ts`**（引 `mode.ts` 的 `ONLINE` 只剪得掉就地的函数字面量，剪不掉模块——rolldown 摇树时不认引进来的常量），而是每个要剪的模块自己就地写一行 `ONLINE_BUILD` 常量（标准写法见 `src/online/pageFlag.ts` 的「在线构建剪枝」，守门 `src/online/onlinePrune.test.mjs`），有副作用的顶层语句（展开写法、`React.memo(…)`）标 `/* @__PURE__ */`。剩下的 19 条是渲染、快照、素材分档、导出等与桌面共用、运行期按宿主能力分支的调用。

各步的详细状态见 `docs/archive/restructure_planning/hand_off.md`；独立复核的结论见 `docs/archive/restructure_planning/hunman_read.md`。

## 语义与代码的差距

`docs/semantics/` 已经定下、代码还没跟上的地方。按 `suggested_agent_behavior.md` 原则 2，这些都算代码要改。2026-09-30 按 M5～M8 与之后的合入更新（笔记本主会话）；M8 收尾时的逐条对照见 `docs/reports/REPORT-M5-M8.md` 第 6.3 节。

- **工作方式**：去掉对话式布局；SKILL 改为桌面 APP 经 MCP 直接接入同一个项目（现在是把项目快照进独立任务目录、由无头实例改副本、最后三方合并）；关闭编辑界面转为托盘和悬浮窗后台运行。
- **Agent**：计划 `docs/plan/agent-workflow-plan.md` 的 A1（三档创造力等级）、A2（本机的「用户正在编辑」与覆盖提示）、A3（主 Agent 拉起子 Agent 并附加角色、分工模式归档、公告板搬到本机服务、双方都知道覆盖、跨设备的在场状态）、A6（Agent 用 JS 自定义测量）都已合入（2026-09-30）。剩下的 SKILL 经 MCP 直连（A4）与后台运行（A5）见上一条「工作方式」。
- **查询渲染**：2026-09-30 合入 `claude/query-render`（操作预览插队、Agent 专用实例空闲时接普通预渲染）与 `claude/query-render-2`（预渲染进程三种模式，缺省 Full；队列模式的认领闸）与 `claude/maint-3`（认领闸的端到端探针；专用实例上的队列任务按批给 Agent 让路，Agent 等待从 38 s 降到 1.2 s）。还没做：后台那一趟的锚帧、整场景、MOV 绑死在后台实例上，专用实例借不到；独立渲染主机的多认领（现有部署下用不上）；Agent 模式真正独立运行要等 `cloud-task.md` I2、I3。出处 `docs/archive/agent-reports/AGENT-query-render.md` 第 7 节、`AGENT-query-render-2.md`。
- **Agent 读素材的路径**：2026-09-30 做完——`measure_audio` 与 `measure_audio_js`（`claude/asset-path`）、三个感知工具与两个写入工具、试听落缓存、提示词措辞（`claude/asset-path-2`）、`bake_card` 的卡片快照（`claude/bake-asset`）、配音复刻的源文件（`claude/maint-3`）都已改为经素材服务的接口读写。剩下：**托管部署下**（`PROMPTCUT_TRUST_LOOPBACK=0`，编辑器进程请求自己的素材服务也要票据）这些读写会回写明原因的 401 / 502，还没有给编辑器进程配票据；其中 `voice_generate` 失败时服务商那边已经合成计费、只是字节没进素材库。
- **托管端与远程素材服务的产物容量**：本机素材服务的 `px` 命名空间随 `claude/bake-asset` 加了按容量、按最近使用的淘汰；托管端与远程素材服务里的产物（`px`、`snap`）还没有容量管理，会一直涨。要按托管端的成本与迁移计划（`docs/plan/hosting-migration.md`）另定。
- **偶发：探针里新开的页面打不开在线页**：新开的页面打开 `<站点>/editor` 等不到 DOMContentLoaded（r4 合流 M7 本机第一跑 180 s 一次；r5 合流在线用户卡探针 120 s 三次；r7 合流 C10 界面探针 120 s 一次，带网络日志重跑 3 遍都过），同一份构建随后连过 6 次，找不到与代码、版本号、负载相关的规律（二分见 `REPORT-post-M8.md` 第 6 轮）。通过的几次里同一主机的 6 个连接会用满、请求排队（Chrome 网络日志 `SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP` 约 30 次），疑为运气不好时 6 个连接都被长连接占住。再出现时给探针的 Chrome 加 `--log-net-log` 抓失败那一次。三个探针（在线用户卡、桌面自动节点、C10 界面）已可用 `PC_CHROME_ARGS=--log-net-log=<文件>` 取证（`claude/query-render-2`）。 目前看到的共同点：都出在长验证链的后段、新开页面的导航上。
- **legacy 整帧通道要不要删**（R7b 遗留「只停了快照、没停 PNG」）：查清了，它不是只服务 `?preview=legacy` 的死代码——Agent 看帧、`get_layout`、草稿与 .proc 的快照、转场卡的快照都还依赖它，舞台端口被占时页面也会退回它。五个方案的 dry run 见 `docs/archive/agent-reports/AGENT-query-render-2.md` 第 8 节：B（只删没人用的 `preview.mp4`、整场景 `full.mov` 产物）已随 `claude/maint-3` 做完；C（停判轻卡的 PNG）、D（删整帧预览老路）牵涉用户看得见的行为，要用户定；E（整条删）不做。
- **会话与传输**：会话模型（双向序号与确认、中断后在保留期内接续）已随 HT-a 合入；HTTP 长轮询传输（HT-b）按触发条件再做，见上文「未开始的计划」。只能经 TLS 中间人代理出网的浏览器连不上 WebSocket（加入不了项目、当不了节点），同归 HT-b。
- **只记录、或要用户定的出入**：桌面发布的 plan 领不到环境不同的独立主机（X4）；`claude/join-error`（加入时连接没建成就断被报成「用户名或密码不对」，修复待审）；低内存档判轻的卡播放时一直占位（要不要改成判轻的也补小尺寸）；刷新后回到刷新前打开的共享项目（代码已做，建议补一级语义）；纯浏览器节点只收独立卡（D4）。出处与现状见 `REPORT-M5-M8.md` 第 6.3 节。
- **已做、从本节删去的**（2026-09-30）：共享项目（M6、SP、C6.5）；多用户协作（C10a）；在线浏览器模式（C10a、C10）；文档服务持有项目真身、Agent 直接写文档服务（C6.5）；素材服务的两档素材与产物入库（C5、C6.2、C6.4、C6.6）；本机按真正的发起方判断（HT-a）；渲染任务队列与渲染节点（M5b～M8）；加入共享项目的桌面应用自动成为渲染节点（0.7.2）；手动截短总时长的入口（项目设置对话框的「总时长（秒）」，走 `setDurationManual` 的截断规则，`8936e9af`；原先这里与 `REPORT-M5-M8.md` 第 6.3 节都误记为没有）；在线舞台握手后又断的退回（0.7.4）。

## 文档

- `desktop/README.md` 的 SKILL 悬浮窗几节描述的是现在的代码，和 `user-workflow.md` 的托盘方案不同。代码改完后跟着改。
- 被忽略、不入库的 `AGY-TASK-*.md` 留在原处不处理。
