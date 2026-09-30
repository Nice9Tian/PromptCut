# TODO

还没做完的工作。未开始的计划和它们的协议全文都在本目录 `docs/plan/` 里；已做完步骤的记录归档在 `docs/archive/`。计划与 `docs/semantics/` 冲突时，以 semantics 为准。

## 未开始的计划

| 事项 | 计划文件 | 状态 |
|---|---|---|
| 轨道流：重卡在播放时贴的 alpha 视频流 | `docs/plan/r8-streams-task.md`；编码原型报告 `docs/plan/g0-b-stream-prototype.md` | 已合入 main（`787f7d9`，R8 G1～G7）；遗留见下文「已做步骤的遗留」的性能缺陷一条（2026-09-27 勘误，C10 契约第 19 节） |
| 共享 WebGL 渲染器：canvas 卡共用一个 WebGL 上下文 | `docs/plan/r9-webgl-task.md` | 已合入 main（`eff2011`，R9 M1～M5）（2026-09-27 勘误，C10 契约第 19 节） |
| 素材服务与文档服务（本地或远程，可任意组合部署）、产物入库、改动竞态、Agent 的查询进程、在线浏览器模式 | `docs/plan/cloud-task.md`；动工前的问题已定，见文末「已定的决议」。2026-09-24 按路线 B 改写，尚未独立审查 | 未开始 |
| 分布式预渲染：文档服务托管的拉取式渲染任务队列，本机 PC、独立渲染主机、纯浏览器认领任务 | `docs/plan/distributed-prerender-queue.md`；前置：上一行的文档服务与产物入库（A3b）；背景评估 `docs/reports/REPORT-architecture-agent-prerender.md` | 设计已审核（2026-09-24）；落地任务书 `docs/plan/TASK-distributed-prerender-queue.md`（M0～M8，M1 纯内存队列本体可先于前置动工）；M1、M2 已合入 main（报告 `docs/reports/REPORT-render-queue-m1.md`）；M3 进程内集成已合入 main（报告 `docs/reports/REPORT-render-queue-m3.md`），接真实预渲染执行器挪到 M5；M4 环境指纹进结果键已合入 main（报告 `docs/reports/REPORT-render-queue-m4.md`），补充的卡片级指纹锁同样已合入（报告 `docs/reports/REPORT-render-queue-card-lock.md`）；M5～M8 的主执行计划 `docs/plan/Master-Execution-Plan.md`（2026-09-25 定稿；M5 拆成 M5a、C5、C6、M5b）；**M5a 已合入 main**（网络层、集群令牌、服务地址登记、文档服务通用化，报告 `docs/reports/REPORT-render-queue-m5a.md`）；**C5 已合入 main**（素材服务数据层、写入鉴权、局域网地址登记，报告 `docs/reports/REPORT-c5.md`）；C6 按独立审查拆成 C6.1～C6.6（见主执行计划），**C6.1 频道与背压已合入**（报告 `docs/reports/REPORT-c6-1.md`）；**C6.2 产物推拉已合入**（报告 `docs/reports/REPORT-c6-2.md`）；**C6.3 文档服务本体最小版已合入**（报告 `docs/reports/REPORT-c6-3.md`）；**C6.4 清单、去重与无条件推送已合入**（报告 `docs/reports/REPORT-c6-4.md`）；**M5b 已合入**（指纹前置过滤、项目快照、真实执行器、队列模式；W3 / W4 跨机通过，报告 `docs/reports/REPORT-render-queue-m5b.md`）。**M5 已全部合入 main**（总报告 `docs/reports/REPORT-M5.md`）；C6.5、C6.6 等推迟项见主执行计划第 11.2 节。2026-09-26 主执行计划增补并于同日修订：D9 定稿（用户、共享项目与权限，第 12 节）；新增 SP 阶段（放云端即托管在阿里云、放本机即本机当主机、托管可整体迁移，迁移步骤 `docs/plan/hosting-migration.md`）；共享项目的两项界面排进 C6.5；后续顺序改为 M6 → SP → C6.5 → C6.6 → C10 → M7 → M8；牵线与三种直连另立为下面的「直连」计划。由此引出的语义改动（S5）已确认并写入 `docs/semantics/`；三个模型的分工重定（Opus 写代码与测试，GPT / codex 查资料与攻坚，Gemini 管交互、文案与发散）；**M6 已合入 main**（ac551a8，M6a 凭证与票据、M6b 独立渲染主机、M6c 推迟项；W5 跨机 H1～H10 通过，报告 `docs/reports/REPORT-M6.md`）；**SP 已合入 main**（685756a，阿里云托管组合已部署到 8.219.80.16、局域网发现；W6 跨机两种模式通过，报告 `docs/reports/REPORT-SP.md`）；**C6.5 已合入 main**（2ffaa45，项目真身进文档服务、路径操作与撤销语义、Agent 直接写文档服务、D11 共享项目界面；U2 跨机两种模式通过，报告 `docs/reports/REPORT-C6.5.md`）；C6.6 进行中（四个子分支已推送、未集成）；**2026-09-26 因本周额度达 91% 按用量闸暂停**，进度与恢复步骤见 `docs/reports/PAUSE-2026-09-26.md` |
| 直连：云端托管服务的牵线与中继，本机项目成员的三条连接路径（局域网直连、公网直连、中继）；端口映射、IPv6 直连、打洞，逐种测、逐条报原因 | `docs/plan/direct-connect-plan.md`（2026-09-26 从主执行计划的 NET 阶段搬出） | 未开始，不在 M5～M8 之内 |
| HT-b：文档服务的 HTTP 长轮询传输（会话层之下的第二种传输） | `docs/plan/http-transport-contract.md` 第 2 版的 HTTP 部分；第 1 版代码在 `claude/http-transport`，HT-a 后保留不接线 | 2026-09-27 从 HT 拆出，未开始；触发条件：出现被代理挡住 WebSocket 的成员（2026-09-27 实测云端容器的 Node 不被挡）。**后续项**（HT-a 集成时记下，契约第 17 节）：① 仍用旧 `createWsEndpoint`、没接会话层的调用方——`server/card-sync.mjs`（编辑器进程与主机的卡片源码同步）、`scripts/probes/shared-project-lan.mjs`、`render-host-probe.mjs`、`c66-t9-probe.mjs` 的页面连接——对新服务端是旧客户端，行为不变、断一次就断线，接会话层时一并做——**已在 M8 计划 D9 做完**（分支 `claude/m8-session-legacy`，2026-09-28，待合入）：卡片源码同步、素材地址登记（含托管组合的管理连接）、`shared-project-lan.mjs`、`render-host-probe.mjs`、`c10a-demo-probe.mjs` 改用 `createDocEndpoint`；`c66-t9-probe.mjs`（归 `claude/m8-e2e`）与 `shared-project-probe.mjs` 的令牌连接（归 `claude/m8-migrate`）留给各自分支，理由见契约第 17.6 节；② 节点端第 1 版 HTTP 客户端 `server/render-node/http-transport.mjs` 按第 2 版协议与第 14 节的错误归类改写、重写测试；③ 第 6 节补 409 `superseded` / `busy` 与 `bad-ack` 的回法（第 17.3 节第 9 条） |
| 音频整体改成浏览器端 JS | `docs/plan/audio_structure_plan.md`（A0～A7）；判重测试计划 `docs/plan/audio_determine_plan.md` | 计划已写，未动工 |
| 以后再做：桌面版给只有素材原尺寸的云端素材补转素材小尺寸；导出页装虚拟定时器 | `docs/plan/future_planning.md` | 暂缓 |
| Agent 与工作方式：创造力等级、「用户正在编辑」、多 Agent、SKILL 经 MCP 直连、后台运行（托盘与悬浮窗）、Agent 用 JS 自定义测量 | `docs/plan/agent-workflow-plan.md`（2026-09-30 写，A1～A6） | 2026-09-30 开工：A1 起；A5 改 Rust 外壳，完整安装包要在 PC 上打 |
| 存储占用（二级功能项）：桌面版帧库设上限、按项目最近使用淘汰、给「清理缓存」入口；导出产物目录有列表、大小与删除 | `docs/plan/storage-plan.md`（2026-09-29 写，含语义 dry run 与接口约定）；排在 M8 之后、团队测试之前（主计划第 4 节） | 2026-09-29 用户加：帧库 `Videos\PromptCut\frame-library` 已长到 273 GB，没有上限也没有淘汰；导出产物每次一整份，连导三次就三份，没有清理入口。计划已写，按用户 2026-09-29 的 goal 不等确认开工（〔裁〕见计划第 3 节）。**已合入 main**（`fe62c17f`，2026-09-30，`docs/reports/REPORT-post-M8.md` 第 2 轮），随 0.7.3 发布（`/editor` 已部署，桌面补丁待 PC 上线） |

**路线 B**（2026-09-24 用户定）：素材服务是字节的唯一读写出口，素材服务在本机时也经它，Agent 进程和预渲染进程同样只走它的 HTTP API；预渲染产物（HTML 快照、PNG、MOV、轨道流）生成后一律推送到素材服务；两个服务部署不设限、可任意组合，素材服务允许局域网跨源访问，文档服务预留连接发现 / 信令接口；第 5 步只建素材服务空壳与底层 API 契约，A1 的其余部分、A5、A3b 在第 6 步；`uploaded` 字段废除，同步状态只问素材服务；原第 8 步移交 R 系列。

## 已做步骤的遗留

- **R0**（2026-09-30 查清并修大半，`claude/watch-ignore`，报告 `docs/archive/agent-reports/AGENT-watch-ignore.md`）：帧库落在 Vite 根下时冷启动慢，原因是依赖扫描把帧库里的快照 .html 当入口、worktree 路径下 glob 监听忽略失效、Tailwind 遍历整棵树；修了前两处（15 万文件时编辑器可用 222 s → 20.6 s；帧库在根外——桌面版就是这样——本来就不慢）。剩下 Tailwind 那约 10 s 要改 `src/index.css` 的扫描源（进 frameCode），随下一批换代码版本的改动做。原文：仓库根 dev server 的冷启动量测没做。（`scripts/verify-unified-frames.mjs` 已整条通过；快照重放和整帧导出的残差查到只剩三处快照这一侧修不了的，见 `docs/archive/restructure_planning/reports/replay-mismatch-report.md` §12、§13。）
- **R7b 没做成的**：只预渲染重卡集合那一条只停了快照、没停 PNG；R7b 报告第 4 节的 8 条更正没折回 `docs/archive/restructure_planning/r2-r7-task.md`。
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
- **查询渲染**：2026-09-30 合入 `claude/query-render`：用户点开的操作预览不占 Agent 专用实例、插到普通预渲染待办之前；Agent 专用实例开着且空闲时接普通预渲染（队列里的一项，或后台那一趟的一批卡）。还没做：预渲染进程的三种模式（Agent / User / Full，`mechanism/rendering.md`），现在总是三条 lane 都建，相当于一直是 Full；队列模式的认领闸（节点在专用实例空着时多认领一项）；后台那一趟的锚帧、整场景、MOV 绑死在后台实例上，专用实例借不到。出处 `docs/archive/agent-reports/AGENT-query-render.md` 第 7 节。
- **会话与传输**：会话模型（双向序号与确认、中断后在保留期内接续）已随 HT-a 合入；HTTP 长轮询传输（HT-b）按触发条件再做，见上文「未开始的计划」。只能经 TLS 中间人代理出网的浏览器连不上 WebSocket（加入不了项目、当不了节点），同归 HT-b。
- **只记录、或要用户定的出入**：桌面发布的 plan 领不到环境不同的独立主机（X4）；`claude/join-error`（加入时连接没建成就断被报成「用户名或密码不对」，修复待审）；低内存档判轻的卡播放时一直占位（要不要改成判轻的也补小尺寸）；刷新后回到刷新前打开的共享项目（代码已做，建议补一级语义）；纯浏览器节点只收独立卡（D4）。出处与现状见 `REPORT-M5-M8.md` 第 6.3 节。
- **已做、从本节删去的**（2026-09-30）：共享项目（M6、SP、C6.5）；多用户协作（C10a）；在线浏览器模式（C10a、C10）；文档服务持有项目真身、Agent 直接写文档服务（C6.5）；素材服务的两档素材与产物入库（C5、C6.2、C6.4、C6.6）；本机按真正的发起方判断（HT-a）；渲染任务队列与渲染节点（M5b～M8）；加入共享项目的桌面应用自动成为渲染节点（0.7.2）；手动截短总时长的入口（项目设置对话框的「总时长（秒）」，走 `setDurationManual` 的截断规则，`8936e9af`；原先这里与 `REPORT-M5-M8.md` 第 6.3 节都误记为没有）；在线舞台握手后又断的退回（0.7.4）。

## 文档

- `desktop/README.md` 的 SKILL 悬浮窗几节描述的是现在的代码，和 `user-workflow.md` 的托盘方案不同。代码改完后跟着改。
- 被忽略、不入库的 `AGY-TASK-*.md` 留在原处不处理。
