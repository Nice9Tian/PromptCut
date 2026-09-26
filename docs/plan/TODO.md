# TODO

还没做完的工作。未开始的计划和它们的协议全文都在本目录 `docs/plan/` 里；已做完步骤的记录归档在 `docs/archive/`。计划与 `docs/semantics/` 冲突时，以 semantics 为准。

## 未开始的计划

| 事项 | 计划文件 | 状态 |
|---|---|---|
| 轨道流：重卡在播放时贴的 alpha 视频流 | `docs/plan/r8-streams-task.md`；编码原型报告 `docs/plan/g0-b-stream-prototype.md` | 未开始，编码原型已做完 |
| 共享 WebGL 渲染器：canvas 卡共用一个 WebGL 上下文 | `docs/plan/r9-webgl-task.md` | 未开始 |
| 素材服务与文档服务（本地或远程，可任意组合部署）、产物入库、改动竞态、Agent 的查询进程、在线浏览器模式 | `docs/plan/cloud-task.md`；动工前的问题已定，见文末「已定的决议」。2026-09-24 按路线 B 改写，尚未独立审查 | 未开始 |
| 分布式预渲染：文档服务托管的拉取式渲染任务队列，本机 PC、独立渲染主机、纯浏览器认领任务 | `docs/plan/distributed-prerender-queue.md`；前置：上一行的文档服务与产物入库（A3b）；背景评估 `docs/reports/REPORT-architecture-agent-prerender.md` | 设计已审核（2026-09-24）；落地任务书 `docs/plan/TASK-distributed-prerender-queue.md`（M0～M8，M1 纯内存队列本体可先于前置动工）；M1、M2 已合入 main（报告 `docs/reports/REPORT-render-queue-m1.md`）；M3 进程内集成已合入 main（报告 `docs/reports/REPORT-render-queue-m3.md`），接真实预渲染执行器挪到 M5；M4 环境指纹进结果键已合入 main（报告 `docs/reports/REPORT-render-queue-m4.md`），补充的卡片级指纹锁同样已合入（报告 `docs/reports/REPORT-render-queue-card-lock.md`）；M5～M8 的主执行计划 `docs/plan/Master-Execution-Plan.md`（2026-09-25 定稿；M5 拆成 M5a、C5、C6、M5b）；**M5a 已合入 main**（网络层、集群令牌、服务地址登记、文档服务通用化，报告 `docs/reports/REPORT-render-queue-m5a.md`）；**C5 已合入 main**（素材服务数据层、写入鉴权、局域网地址登记，报告 `docs/reports/REPORT-c5.md`）；C6 按独立审查拆成 C6.1～C6.6（见主执行计划），**C6.1 频道与背压已合入**（报告 `docs/reports/REPORT-c6-1.md`）；**C6.2 产物推拉已合入**（报告 `docs/reports/REPORT-c6-2.md`）；**C6.3 文档服务本体最小版已合入**（报告 `docs/reports/REPORT-c6-3.md`）；**C6.4 清单、去重与无条件推送已合入**（报告 `docs/reports/REPORT-c6-4.md`）；**M5b 已合入**（指纹前置过滤、项目快照、真实执行器、队列模式；W3 / W4 跨机通过，报告 `docs/reports/REPORT-render-queue-m5b.md`）。**M5 已全部合入 main**（总报告 `docs/reports/REPORT-M5.md`）；C6.5、C6.6 等推迟项见主执行计划第 11.2 节。2026-09-26 主执行计划增补并于同日修订：D9 定稿（用户、共享项目与权限，第 12 节）；新增 SP 阶段（放云端即托管在阿里云、放本机即本机当主机、托管可整体迁移，迁移步骤 `docs/plan/hosting-migration.md`）；共享项目的两项界面排进 C6.5；后续顺序改为 M6 → SP → C6.5 → C6.6 → C10 → M7 → M8；牵线与三种直连另立为下面的「直连」计划。由此引出的语义改动（S5）已确认并写入 `docs/semantics/`；三个模型的分工重定（Opus 写代码与测试，GPT / codex 查资料与攻坚，Gemini 管交互、文案与发散）；**M6 已合入 main**（ac551a8，M6a 凭证与票据、M6b 独立渲染主机、M6c 推迟项；W5 跨机 H1～H10 通过，报告 `docs/reports/REPORT-M6.md`）；**SP 已合入 main**（685756a，阿里云托管组合已部署到 8.219.80.16、局域网发现；W6 跨机两种模式通过，报告 `docs/reports/REPORT-SP.md`）；**C6.5 已合入 main**（2ffaa45，项目真身进文档服务、路径操作与撤销语义、Agent 直接写文档服务、D11 共享项目界面；U2 跨机两种模式通过，报告 `docs/reports/REPORT-C6.5.md`）；C6.6 进行中（四个子分支已推送、未集成）；**2026-09-26 因本周额度达 91% 按用量闸暂停**，进度与恢复步骤见 `docs/reports/PAUSE-2026-09-26.md` |
| 直连：云端托管服务的牵线与中继，本机项目成员的三条连接路径（局域网直连、公网直连、中继）；端口映射、IPv6 直连、打洞，逐种测、逐条报原因 | `docs/plan/direct-connect-plan.md`（2026-09-26 从主执行计划的 NET 阶段搬出） | 未开始，不在 M5～M8 之内 |
| HT-b：文档服务的 HTTP 长轮询传输（会话层之下的第二种传输） | `docs/plan/http-transport-contract.md` 第 2 版的 HTTP 部分；第 1 版代码在 `claude/http-transport`，HT-a 后保留不接线 | 2026-09-27 从 HT 拆出，未开始；触发条件：出现被代理挡住 WebSocket 的成员（2026-09-27 实测云端容器的 Node 不被挡） |
| 音频整体改成浏览器端 JS | `docs/plan/audio_structure_plan.md`（A0～A7）；判重测试计划 `docs/plan/audio_determine_plan.md` | 计划已写，未动工 |
| 以后再做：桌面版给只有素材原尺寸的云端素材补转素材小尺寸；导出页装虚拟定时器 | `docs/plan/future_planning.md` | 暂缓 |

**路线 B**（2026-09-24 用户定）：素材服务是字节的唯一读写出口，素材服务在本机时也经它，Agent 进程和预渲染进程同样只走它的 HTTP API；预渲染产物（HTML 快照、PNG、MOV、轨道流）生成后一律推送到素材服务；两个服务部署不设限、可任意组合，素材服务允许局域网跨源访问，文档服务预留连接发现 / 信令接口；第 5 步只建素材服务空壳与底层 API 契约，A1 的其余部分、A5、A3b 在第 6 步；`uploaded` 字段废除，同步状态只问素材服务；原第 8 步移交 R 系列。

## 已做步骤的遗留

- **R0**：仓库根 dev server 的冷启动量测没做。（`scripts/verify-unified-frames.mjs` 已整条通过；快照重放和整帧导出的残差查到只剩三处快照这一侧修不了的，见 `docs/archive/restructure_planning/reports/replay-mismatch-report.md` §12、§13。）
- **R7b 没做成的**：只预渲染重卡集合那一条只停了快照、没停 PNG；R7b 报告第 4 节的 8 条更正没折回 `docs/archive/restructure_planning/r2-r7-task.md`。
- **see_frames 回包附实体矩形**：原云端计划第 8 步，协议在 `docs/archive/restructure_planning/r2-r7-task.md` 的 D3，归 R 系列，可与云端计划并行推进。
- **待用户定**：播放停顿期间要不要加音频看门狗，让音频立刻停。

各步的详细状态见 `docs/archive/restructure_planning/hand_off.md`；独立复核的结论见 `docs/archive/restructure_planning/hunman_read.md`。

## 语义与代码的差距

`docs/semantics/` 已经定下、代码还没跟上的地方。按 `suggested_agent_behavior.md` 原则 2，这些都算代码要改。

- **工作方式**：去掉对话式布局；SKILL 改为桌面 APP 经 MCP 直接接入同一个项目（现在是把项目快照进独立任务目录、由无头实例改副本、最后三方合并）；关闭编辑界面转为托盘和悬浮窗后台运行。
- **Agent**：三档创造力等级（项目默认、对话可改）；主 Agent 拉起子 Agent 并附加角色，现有的分工模式归档；Agent 用 JS 自定义测量；看或改用户正在编辑的内容时返回「用户正在编辑」。
- **文档服务**：C6.3 起有了本体最小版（项目版本号、版本日志、内容库、本地插件），但还不持有项目内容，项目的真身仍在页面里（D1 在 C6.5）；Agent 的写操作现在经页面执行，没有经文档服务；覆盖通知覆盖方和被覆盖方都要知道。
- **素材服务**：第 5 步空壳已落地（分片上传、对账、按哈希取回、跨源），C5 起经数据层 `BlobStore`（`server/asset-store/`），非本机写入要集群令牌，局域网地址登记到控制面；两档素材的字段只是占位；预渲染产物还没有入库，只留在本机。
- **查询渲染**：Agent 专用渲染实例的优先通道、AI 栏操作预览的插队只有雏形。
- **共享项目**（2026-09-26 写入语义）：
  - 语义要求的部分：两种部署（托管在公网云端 / 本机当主机）、局域网发现、自由进入与限定进入、创建者三项特权、素材服务读写凭票据；
  - 代码现状：都还没有；鉴权仍是 M5 的单一集群令牌，素材服务的读仍是匿名的；
  - 按主执行计划落在 M6（凭证、票据）、SP（托管与局域网）、C6.5（界面）。
- **多用户协作**（2026-09-26 改定）：语义是项目设置里勾选「多用户协作」、开始页加入（项目名、项目密码、用户名；或凭邀请码令牌只填用户名）、搬到云端 / 搬回本机、取消后拉回本机并注销；代码现状是 C6.5 做的两个旧入口（界面文字「新建共享项目」「打开共享项目」），新建时二选一放云端 / 放本机；改造排在 C10a。
- **在线浏览器模式**：还不存在。2026-09-26 第二轮定了入口（托管端 `/editor`）、开始页的加入表单、低内存档与预渲染小尺寸，落在 C10a。
- **会话与传输**（2026-09-26 第二轮写入语义）：语义是文档服务与每一方之间一个会话（双向序号与确认、传输中断在保留期内接续），WebSocket 与 HTTP 长轮询自动选择；代码现状只有 WebSocket，断开即断线；HTTP 长轮询在 `claude/http-transport`（第 1 版，按 `docs/plan/http-transport-contract.md` 第 2 版返工）。落在 HT。
- **本机按真正的发起方判断**（2026-09-26 第二轮写入语义）：语义要求经反向代理转进来的连接和请求按远端对待；代码的开关 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST` 只接到了素材服务与管理接口，文档服务的握手与共享端点仍按套接字对端信任回环；阿里云眼下靠 nginx 的 `proxy_bind` 堵住。落在 HT（`PROMPTCUT_TRUST_LOOPBACK`）。
- **加入共享项目的桌面应用自动成为渲染节点**（`product/platforms.md`「渲染节点」）：代码靠启动时的 `PROMPTCUT_QUEUE_NODE=1` 与 `PROMPTCUT_SHARED_CONFIG`，没做到「自动」。落地时要给观察端（C6.6 T9）留一个开发者开关关掉它。
- **渲染任务队列与渲染节点**：还不存在；预渲染现在只由本机预渲染进程按页面的 preload 做（本机的结果键已在 M4 乘上环境指纹）。页面测量时推过的帧按卡片级指纹锁入库：页面上报自己的环境，帧存在页面指纹的键下，这张卡随之锁给页面的环境（`render-queue-contract.md` F 节，报告 `docs/reports/REPORT-render-queue-card-lock.md`）。设计见 `docs/plan/distributed-prerender-queue.md`。
- **手动截短总时长的入口**：语义允许用户手动缩短总时长（`product/project-model.md`「总时长」），但编辑界面没有入口，现在只有 Agent 能经 `set_project_meta` 截断。UI 层要补手动截短总时长的操作入口，规则用 `src/kernel/duration.ts` 现成的那套。

## 文档

- `desktop/README.md` 的 SKILL 悬浮窗几节描述的是现在的代码，和 `user-workflow.md` 的托盘方案不同。代码改完后跟着改。
- 被忽略、不入库的 `AGY-TASK-*.md` 留在原处不处理。
