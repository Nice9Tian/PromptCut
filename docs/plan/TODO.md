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
| 下一个大版本支持 macOS：桌面壳从 Tauri 迁到 Electron，只换「壳」这一层（编辑器 UI、Agent 子窗口、托盘），预渲染与导出的 chrome-headless-shell + beginFrame 一字不动；砍掉整套 Chrome for Testing；像素基线按平台各一份 | `docs/plan/electron-mac-plan.md`（2026-10-01 评估与步骤，含被推翻的两个前提：paint 替代不了 beginFrame、支持 Mac 不必换壳） | 用户 2026-10-01 定方向与顺序：先在 PC 上证明 Electron 离屏 paint 取帧可行（确定性 1800/1800、运行期帧标记零失败、与 headless-shell 产物逐帧可解释、耗时不慢），再换壳；未排期、未动工 |
| 音频整体改成浏览器端 JS | `docs/plan/audio_structure_plan.md`（A0～A7）；判重测试计划 `docs/plan/audio_determine_plan.md` | 计划已写，未动工 |
| 以后再做：桌面版给只有素材原尺寸的云端素材补转素材小尺寸；导出页装虚拟定时器 | `docs/plan/future_planning.md` | 暂缓 |
| Agent 与工作方式：创造力等级、「用户正在编辑」、多 Agent、SKILL 经 MCP 直连、后台运行（托盘与悬浮窗）、Agent 用 JS 自定义测量 | `docs/plan/agent-workflow-plan.md`（2026-09-30 写，A1～A6） | A1、A2、A3、A6 已合入 main（2026-09-30，`REPORT-post-M8.md` 第 5、6 轮）；A4（SKILL 经 MCP 直连，含去掉对话式布局）在 `claude/skill-mcp` 上做完待验证；A5 改 Rust 外壳，完整安装包要在 PC 上打——A4、A5 做完先留在分支上，PC 上线出包实测后一起合入 |
| 存储占用（二级功能项）：桌面版帧库设上限、按项目最近使用淘汰、给「清理缓存」入口；导出产物目录有列表、大小与删除 | `docs/plan/storage-plan.md`（2026-09-29 写，含语义 dry run 与接口约定）；排在 M8 之后、团队测试之前（主计划第 4 节） | 2026-09-29 用户加：帧库 `Videos\PromptCut\frame-library` 已长到 273 GB，没有上限也没有淘汰；导出产物每次一整份，连导三次就三份，没有清理入口。计划已写，按用户 2026-09-29 的 goal 不等确认开工（〔裁〕见计划第 3 节）。**已合入 main**（`fe62c17f`，2026-09-30，`docs/reports/REPORT-post-M8.md` 第 2 轮），随 0.7.3 发布（`/editor` 已部署，桌面补丁待 PC 上线） |

**路线 B**（2026-09-24 用户定）：素材服务是字节的唯一读写出口，素材服务在本机时也经它，Agent 进程和预渲染进程同样只走它的 HTTP API；预渲染产物（HTML 快照、PNG、MOV、轨道流）生成后一律推送到素材服务；两个服务部署不设限、可任意组合，素材服务允许局域网跨源访问，文档服务预留连接发现 / 信令接口；第 5 步只建素材服务空壳与底层 API 契约，A1 的其余部分、A5、A3b 在第 6 步；`uploaded` 字段废除，同步状态只问素材服务；原第 8 步移交 R 系列。

## 已做步骤的遗留

- **〔已修，随 0.7.9 发，`claude/pack-hash`〕用户真机缺陷，随下一个发布的版本修（0.7.8 之后的那一版，按现在的编号是 0.7.9），与下一条慢放缺陷同批**（2026-09-30 用户定）：**「打包保存…」把没有哈希的素材悄悄跳过，配音没进 `.procp`。** 复现：用户项目 `9tian666.proc` 有 9 条素材，1 条视频带哈希，8 条配音（桌面版 0.7.0 / 0.7.1 时生成）只有 `path`、地址是 `/api/media/file?path=…`、没有 `hash`；打出来的包里只有视频，界面没有任何提示。
  - **根因**：`src/editor/io/procp.ts` 的 `mediaEntries()` 写着 `if (!m.hash || …) continue`，没有哈希的条目直接不进包，只在控制台留一行。配音直到 `6df39fb2`（2026-09-30，随 0.7.7）才经入库接口进内容库、条目带哈希；此前生成的配音，以及其它只有 `path` 的迁移期条目（`src/editor/io/mediaUrls.ts` 的 `restoreMediaUrls` 第二支），在老项目里至今没有哈希。**同一个根因还有第二处**：开启多用户协作「放云端」时，`src/editor/media/assetTiers.ts` 的 `existingMediaItems()` 同样只收带哈希的，没哈希的素材不会传到云端素材服务，别的成员拿不到这些配音。
  - **语义已有、不改**：`workflow/project.md`「打包保存 `.procp`（连素材一起，换机器直接打开）」；`product/asset-service.md`「入库这一步不能省」。是代码没跟上，按语义改（`suggested_agent_behavior.md` 原则 2）。
  - **修法**：加一个统一的「补入库」步骤（放 `src/editor/io/mediaUpload.ts`）：素材表里没有合法哈希、但本机还取得到字节的条目（有 `path`，或地址是 `/api/media/file?path=…`、`/@media/<文件名>`），文件在素材目录内的走现成的 `adoptServerMedia`（`POST /api/media/adopt`，就地算哈希、硬链接进内容库），在素材目录外的经现有读接口取字节再走 `/api/media/upload/<名字>` 入库；结果用 `applyUploadedMedia` 写回（换新对象，不原地改，见 `constraints.md`）。三处调用：① 打包前——包里的 `project.proc` 因此也带哈希，对面按哈希还原；② 开启多用户协作「放云端」、把已有素材交给上传队列之前；③ 桌面版打开项目后在后台做一遍（与 `backfillSmallTiers` 同一时机），老项目自己愈合。只读页面与在线构建不做（没有本机内容库、不改项目）。
  - **不许再静默**：补入库之后仍进不了包的（文件真的不在了），打包结束时用现有的提示方式把这些素材的名字列给用户，说明包里缺它们；控制台那一行不算告知。「放云端」那一处同理，传不上去的列出来。
  - **验收**：
    1. 单测（`src/editor/io/procp.test.mjs`）：项目含一条带哈希的视频、一条只有 `path` 的音频、一条地址为 `/api/media/file?path=…` 的音频 → 装包后三份字节都在包里、包内 `project.proc` 三条都带哈希；拆到空库后 `restoreMediaUrls` 的 `missing` 为空。另一条：文件不存在的条目 → 装包的返回值里列出它，调用方据此提示。
    2. 守门：按哈希挑素材的两处（`mediaEntries()`、`existingMediaItems()`）不得再出现「没哈希就跳过且不报告」——各加单测，断言被跳过的条目出现在返回的清单里。
    3. 往返探针 `scripts/probes/procp-roundtrip-probe.mjs`：一个实例里建项目（一条视频、一条老形态只有 `path` 的音频、一条经入库接口进来的音频），打包；在数据目录为空的第二个实例里打开 → 素材表没有「(缺失)」、每条素材的 `/@media/<hash>` 取得到、导出成片的音轨非静音。退出码 0、`fails: []`。
    4. 真机验收（用户做）：用带修复的版本打开 `9tian666` 再「打包保存…」，包里应有 9 份素材（1 条视频 + 8 条配音）；拿到另一台机器打开，配音能播、导出有声。
    5. G0 照跑；这一项不动渲染，G0-R 只在改动碰到导出取素材的路径时跑。
  - 发版通知里写明：老项目里以前生成的配音，从这一版起打包和放云端时会一并带上。
- **〔已修，随 0.7.9 发，`claude/video-cadence`；真机验收在笔记本用用户发来的 `.procp` 做过：0.5 倍段改前每段 40～61 处违反、改后 0，另修好两个起点落在帧边界的 1 倍速段〕用户真机缺陷，排在第二批遗留之前、当前一轮（r3-merge 与 0.7.4）出完就做**（2026-09-30，用户项目 `9tian666.proc`，PC 桌面 `C:\Users\admin\Desktop\`，同名 `.mp4` 是成片；原素材 30 fps、项目 30 fps）：**图卡的视频输入源在 0.5 倍慢放导出时节奏不均**。成片相邻帧差异实测：1 倍速段与原素材逐帧对得上；0.5 倍段本该「新、重、新、重」两两重复，实际是「新、新、重、新、重、重」六帧一循环（一帧停 3 拍、一帧停 1 拍、一帧停 2 拍），看起来一顿一顿。
  - **根因**：`src/render/cards/mediaSource.ts` 的 `frame()` 把「偏移 + 速率 × 时间」原样设给隐藏视频元素的 `currentTime`，收到 `seeked` 就取图。0.5 倍速下每隔一帧目标时刻正好落在素材的帧边界上（如 12.600000 s），浏览器把时刻转成微秒时截断，目标比那一帧的时间戳早不到一微秒就取到前一帧，取前一帧还是本帧随浮点误差摆，节奏就乱了。按「取时间戳 ≤ 目标的最后一帧 + 微秒截断」模拟，算出的节奏与成片一致；按「边界归本帧」模拟就是两两重复。不是帧率换算（没有 30→25），也不是滤镜。
  - **修法**：seek 目标统一加一个小于一帧的正偏移——素材帧率已知时对齐到帧中心，未知时 +2 ms（与 `src/render/frameMedia.ts` 出画判断里的 2 ms 容差同一个数）。只改 `mediaSource.ts` 这一处；`frameMedia.ts`（时间轴视频片段的导出取帧）是同类写法但目标同样原样 seek，用下面的节奏探针一并覆盖，探针不过再用同款修法。
  - **三级语义**（写进 `docs/semantics/mechanism/cards.md`，标〔裁〕，用户合入前审）：「图卡的视频输入源在时刻 t 取素材里时间戳不超过 t 的最后一帧；t 正好落在帧边界时取边界上这一帧。变速与偏移先算出 t 再取帧。实现上 seek 目标加 2 ms，不依赖素材帧率。」时间轴视频片段的导出取帧按同一句理解。
  - **基线怎么定（2026-09-30 用户定，由「大哥」会话写死）**：
    1. **导出像素基线预期 0 不同、0 缺失**，照常比。若出现差异：差异帧必须全部是含图卡视频源的帧，且这些帧新取到的源帧符合上面那句规则（用第 2 条的解法核）——两条都成立才允许重定，重定就是把 PC 的 `.worktrees/pc-g0r-base` 与笔记本的 `.worktrees/main-g0r` 都换到合入修复后的 main 提交，报告里写明换到哪个提交、差异帧数、原因；不满足两条的任何差异都算修错，不得重定。
    2. **新增节奏探针 `scripts/probes/video-source-cadence-probe.mjs`，就是这条行为此后的回归基线**，纳入 G0-R「预渲染探针」一行，改到取帧、解码、图卡视频源、`frameMedia.ts` 时必跑。做法：ffmpeg 合成 30 fps、2 s、64×64 的素材，第 n 帧整幅亮度 = 16 × (n mod 16)、色度中性（阶梯 16，扛有损编码）；再合成一份 25 fps 的验非整数比。项目 30 fps，用例：①图卡节点（原样输出上游的图卡）输入源 rate 0.5、offset 0 与 0.35（10.5 帧，非整帧）；②rate 1、offset 0；③时间轴普通视频片段 mediaOffset 0 与 0.35（覆盖 `frameMedia.ts`）；④25 fps 素材 rate 1。各导 60 帧，读每帧视频区域平均亮度，四舍五入到 16 的倍数、按单调性还原成源帧号 m(n)。**断言 m(n) = floor((offset + rate × n / 30) × 源帧率 + 1e-6)**：rate 0.5 是 0,0,1,1,2,2…；rate 1 是 n；offset 0.35 是 10,11,12…；25 fps 素材是 floor(n × 25 / 30)。退出码 0、`fails: []`。
    3. **真机验收**：用 `9tian666.proc` 重新导出，对成片 0.5 倍段（17.87～26.37、32.37～40.43、46.43～54.97、60.97～69.97、75.97～83.47、83.47～97.12 s）算相邻帧差异（`ffmpeg -vf tblend=all_mode=difference,signalstats`），去掉每段开头 0.42 s 的转场覆盖后必须严格「新、重」交替；1 倍速段仍与原素材逐帧对得上。项目与素材由用户打成 `.procp`（顶栏「打包保存…」，编排 + 素材）直接发给笔记本主会话，验收在笔记本做，不用 PC 辅助；导入到会话自己的 dev-test 数据目录，不进用户的 `Videos\PromptCut`；音频素材缺了就去掉音轨导出，验收只看画面。
    4. G0 与 G0-R 其余项照跑；单测补 `mediaSource` 的边界用例（目标正好等于 k/30 时取第 k 帧）。
  - 修好随下一个补丁版本发；通知用户时写明「慢放段的画面会变，是修正」。
- **〔已修，随 0.7.12 发，`claude/cadence-race`〕偶发：导出时图卡的视频源取到上一帧**（2026-10-01，集成分支 `claude/r11-merge` 的整套里 `video-source-cadence-probe` 挂一次：用例①rate 0.5 offset 0.35 第 51 帧取到源帧 35、应为 36——目标 1.2 s 正落在帧边界，seek 目标已加 2 ms；其余约 420 帧全对。改前 0.7.10 与改后在空闲机器上交替各单跑 5 遍都过，是原有的偶发；那次紧接在最忙的认领闸探针之后）。疑为 `seeked` 发出时视频元素的当前帧还没换成新帧就取图的时序竞争，时间轴视频片段的 `src/render/frameMedia.ts` 是同类写法。根因坐实：Chrome 把新帧送进帧槽与通知主线程 seek 完成走两条线程，机器忙时 `seeked` 先到。改为 `seeked` 后用 `VideoFrame` 核对帧时间戳覆盖目标再取图，`frameMedia.ts` 的呈现窗口按帧时长收窄。最小复现探针 `scripts/probes/video-seek-race-probe.mjs` 改前 312 000 次 seek 错 22 次、改后 504 000 次 0 错，纳入 G0-R。出处 `docs/archive/agent-reports/AGENT-cadence-race.md`。
- **〔已修，随 0.7.13 发，`claude/m7-race`〕偶发：M7 本机探针 A10「抢卡」一步卡在等待上限上**（2026-10-01，集成分支 `claude/r12-merge` 的整套里挂一次；随后在 `claude/cadence-race`、`claude/codex-test-env` 两个子分支与 r12 上各单跑一次，运行时代码同 main 的 codex-test-env 也挂、另两次过，与本轮改动无关）：加两张新卡 w1、w2 后等各自做完，每张卡 300 s 等待上限，这一步实测 214 / 270 / 311 / 306 / 301 / 256 s——本机节点要先渲完约 20 段重卡（每段 11～13 s），w1 排在后面。探针把「等超时」和「一张卡出自两种环境」判成同一种失败（`{"w1":[],…}`）。查明是调度缺口：pc 挑活把计划（`priority: 'normal'`，记名次 0）排在整数名次的细任务后面，新卡的计划要等积压做完才切分，不会切分的纯浏览器节点没活可接。改为同一档里计划先于细任务（`server/render-node/pick.mjs`），切分从 224～295 s 降到约 15 s，这一步 33～40 s；探针分开判切分及时、做完及时与一卡一环境。出处 `docs/archive/agent-reports/AGENT-m7-race.md`。
- **〔已修，随 0.7.13 发，`claude/push-incomplete`〕推预渲染产物偶发 400 incomplete**（2026-10-01 `claude/m7-race` 查 M7 日志时发现，每遍 1～4 段，每次白费一次认领约 13 s）：节点自己的推送与本机后台推送队列同时推同一段，素材服务存储层再传已收到的片时先撤标记再重写，另一路已答过「收到」、正要收尾就撞上 `incomplete`。存储层改为已收到的片不重写、不撤标记，另一路先收尾入库时回 `complete`；客户端 complete 回 incomplete 时重问 `chunks`、补传再收尾（兜住老服务端）。复现探针 `scripts/probes/push-race-probe.mjs` 分片布局改前 60 次推送挂 38 次、改后 0。随 0.7.13 托管端重部署。**后续（未排期）**：两路仍各推一遍每一段，是重复劳动（不再出错）；要省得让推送队列跳过节点正在推的段。出处 `docs/archive/agent-reports/AGENT-push-incomplete.md`。
- **〔已做〕R0**（2026-09-30 修完：`claude/watch-ignore` 修依赖扫描入口与监听忽略，Tailwind 扫描源随 `claude/query-render` 改；树内帧库 15 万个文件时冷启动 3.0 s / 10.0 s，与空帧库相同，0.7.4 是 17 s / 180 s；报告 `docs/archive/agent-reports/AGENT-watch-ignore.md`、`REPORT-post-M8.md` 第 5 轮）原文：帧库落在 Vite 根下时仓库根 dev server 冷启动慢。
- **R7b 没做成的**：R7b 报告第 4 节的 8 条更正已折回 `docs/archive/restructure_planning/r2-r7-task.md` 文末（2026-09-30，`claude/query-render-2`）；「只停了快照、没停 PNG」见「语义与代码的差距」的「legacy 整帧通道」一条。
- **〔已做〕see_frames 回包附实体矩形**（2026-09-24，`8124996d`：预渲染在 `captureSnapshot` 的 `afterFonts` 钩子里量 `rectsWithBounds(pixels: "all")`，每帧结果带 `rects: [{ clipId, box, solid }]`，工具结果的文字部分按 clipId 一行；2026-09-30 核对时补记）原文：原云端计划第 8 步，协议在 `docs/archive/restructure_planning/r2-r7-task.md` 的 D3，归 R 系列，可与云端计划并行推进。
- **待用户定**：播放停顿期间要不要加音频看门狗，让音频立刻停。
- **〔已修〕**（2026-09-28，`claude/perf-encode-2`，main `501a7dd7`：只改 `server/bakery/ffmpeg.mjs` 的编码参数装配，产出逐字节不变；全案最终基线笔记本 p50 207～224 ms；2026-09-30 最终合流 G0-R 笔记本 p50 261 ms，仍过线，见 `REPORT-M5-M8.md` 第 7.5 节、`REPORT-post-M8.md` 第 2 轮）原文：- **性能缺陷，M8 之前必修**（2026-09-27）：1080p 全幅流 15 帧分段编码在笔记本上 355～397 ms，门槛 300 ms（`stream-produce-probe`，C10a 报告第 2.13 节）。笔记本是性能基准机（`guide_files/verification.md`），在笔记本上修到过线，或经用户确认改门槛。
- **维护项：在线构建剪掉置灰入口背后的调用**（C10 集成，2026-09-28）：在线页面上置灰的入口（导入媒体、语音识别、配音、改卡等，`docs/plan/c10-contract.md` 第 10 节）点了不发请求，但调用代码仍在在线构建的产物里，`/api` 棘轮清单（`server/test/c10a-online-api-paths.json`，120 条）因此一条没少。按编译期常量把这些调用剪掉，让清单变短；清单只许减不许增。
  - **已做**（2026-09-28，`claude/online-prune`，M8 遗留 L24；报告 `docs/archive/agent-reports/AGENT-online-prune.md`）：清单 120 → 19 条，在线构建 `assets/` 少约 38 万字节；C10A-API-03 改成清单与产物逐条一致。做法更正：**不是照 `collab.ts`**（引 `mode.ts` 的 `ONLINE` 只剪得掉就地的函数字面量，剪不掉模块——rolldown 摇树时不认引进来的常量），而是每个要剪的模块自己就地写一行 `ONLINE_BUILD` 常量（标准写法见 `src/online/pageFlag.ts` 的「在线构建剪枝」，守门 `src/online/onlinePrune.test.mjs`），有副作用的顶层语句（展开写法、`React.memo(…)`）标 `/* @__PURE__ */`。剩下的 19 条是渲染、快照、素材分档、导出等与桌面共用、运行期按宿主能力分支的调用。

各步的详细状态见 `docs/archive/restructure_planning/hand_off.md`；独立复核的结论见 `docs/archive/restructure_planning/hunman_read.md`。

## 性能方向（未排期）

- **canvas 卡的预渲染产物经 WebCodecs 直出，不再经截图与三次 PNG 往返**（2026-10-01 用户加，档位未定）。现状：canvas 卡的像素先在生成快照时读回 CPU、`toDataURL()` 压成 PNG、把 canvas 换成 `<img>` 写进快照（`src/render/snapshot/rasterizeCanvas.ts`）；预渲染进程再把快照在 Chrome 里重放、整帧截图成 PNG，管道给 ffmpeg 编成 ProRes MOV 或 H.264 轨道流（`server/bakery/ffmpeg.mjs`）。一张 canvas 卡的像素因此走了「GPU 画布 → 读回 → PNG → HTML → Chrome 重渲 → 截图 → PNG → ffmpeg 解 PNG → 编码」，中间三次 PNG 编解码是纯开销，画布越大越慢。方向：canvas 卡的画面本来就在画布里，可以 `new VideoFrame(canvas)` 直接送 `VideoEncoder`（在线导出 `src/export/frameCompositor.ts` 已经这样用），共享 WebGL 渲染器（R9）落地后画布卡的像素来自 Worker 交回的位图，改造点集中在 `rasterizeCanvas.ts` 与产物那一侧。留意两处：① 轨道流要带 alpha，WebCodecs 编 H.264 不带 alpha，上下拼合那一步得在画布里自己做（做法同现在）；② 快照仍要生成，DOM 卡与判重靠它，canvas 卡改直出只是产物不再经截图，快照里那张 PNG 缩略可留作占位。验收：同一张 canvas 卡两条路的产物逐像素比对（允许编码器差异时先比 PNG 阶段）、预渲染耗时前后对比在笔记本量（`guide_files/verification.md`「性能基准机」）、G0-R 全过、像素基线不变（导出整帧仍走截图，不在本项范围）。
## 语义与代码的差距

`docs/semantics/` 已经定下、代码还没跟上的地方。按 `suggested_agent_behavior.md` 原则 2，这些都算代码要改。2026-09-30 按 M5～M8 与之后的合入更新（笔记本主会话）；M8 收尾时的逐条对照见 `docs/reports/REPORT-M5-M8.md` 第 6.3 节。

- **工作方式**：去掉对话式布局；SKILL 改为桌面 APP 经 MCP 直接接入同一个项目（现在是把项目快照进独立任务目录、由无头实例改副本、最后三方合并）；关闭编辑界面转为托盘和悬浮窗后台运行。
- **Agent**：计划 `docs/plan/agent-workflow-plan.md` 的 A1（三档创造力等级）、A2（本机的「用户正在编辑」与覆盖提示）、A3（主 Agent 拉起子 Agent 并附加角色、分工模式归档、公告板搬到本机服务、双方都知道覆盖、跨设备的在场状态）、A6（Agent 用 JS 自定义测量）都已合入（2026-09-30）。剩下的 SKILL 经 MCP 直连（A4）与后台运行（A5）见上一条「工作方式」。
- **查询渲染**：2026-09-30 合入 `claude/query-render`（操作预览插队、Agent 专用实例空闲时接普通预渲染）与 `claude/query-render-2`（预渲染进程三种模式，缺省 Full；队列模式的认领闸）与 `claude/maint-3`（认领闸的端到端探针；专用实例上的队列任务按批给 Agent 让路，Agent 等待从 38 s 降到 1.2 s）。还没做：后台那一趟的锚帧、整场景、MOV 绑死在后台实例上，专用实例借不到；独立渲染主机的多认领（现有部署下用不上）；Agent 模式真正独立运行要等 `cloud-task.md` I2、I3。出处 `docs/archive/agent-reports/AGENT-query-render.md` 第 7 节、`AGENT-query-render-2.md`。
- **跨机器打开项目时的素材路径**：2026-10-01 做完——导出有哈希就按哈希取素材（`claude/media-path`）；只有路径又取不到、或带哈希但本机没有字节的素材打开后标「(缺失)」，导出时跳过引用它的片段并在完成时列出（`claude/media-path`、`claude/maint-4`）；放云端后补上哈希的老素材与新导入的图片、音频进上传队列。打开云端项目后、上传目标设好之前导入的素材也补上了：页面记下，就绪后按哈希补交给上传队列（`claude/upload-timing`，随 0.7.11）。另：「打开项目时素材找不到标『(缺失)』、导出跳过并列出」要不要写进二级语义，dry run 见 `docs/archive/agent-reports/AGENT-media-path.md`、`AGENT-maint-4.md`，待用户定。
- **Agent 读素材的路径**：2026-09-30 做完——`measure_audio` 与 `measure_audio_js`（`claude/asset-path`）、三个感知工具与两个写入工具、试听落缓存、提示词措辞（`claude/asset-path-2`）、`bake_card` 的卡片快照（`claude/bake-asset`）、配音复刻的源文件（`claude/maint-3`）都已改为经素材服务的接口读写。剩下：**托管部署下**（`PROMPTCUT_TRUST_LOOPBACK=0`，编辑器进程请求自己的素材服务也要票据）这些读写会回写明原因的 401 / 502，还没有给编辑器进程配票据；其中 `voice_generate` 失败时服务商那边已经合成计费、只是字节没进素材库。
- **托管端与远程素材服务的产物容量**：本机素材服务的 `px` 命名空间随 `claude/bake-asset` 加了按容量、按最近使用的淘汰；托管端与远程素材服务里的产物（`px`、`snap`）还没有容量管理，会一直涨。要按托管端的成本与迁移计划（`docs/plan/hosting-migration.md`）另定。
- **〔已查明并修好，2026-10-01 `claude/nav-hang`〕偶发：探针里新开的页面打不开在线页**：根因是 puppeteer 的测试版 Chrome 缺省套用 Chromium 的实验配置，入口脚本分块传输时约 1～3% 的页面卡死（网络层收完、渲染进程不收下）；在线探针的 Chrome 统一加 `--disable-field-trial-config`，修后压测 900 次 0 卡死；0.7.11 起 `scripts/probes/` 下所有起 Chrome 的探针都以 `PROBE_CHROME_ARGS` 打头（`claude/upload-timing`）。正式版 Chrome 300 次 0 次、gzip + 分块 300 次 0 次；线上 `/editor/assets/` 另改为 `gzip_static` 带 `Content-Length` 发。页面里「入口卡住自动刷新一次」的看门狗没做（用户看得见的行为）。出处 `docs/archive/agent-reports/AGENT-nav-hang.md`。
- **legacy 整帧通道要不要删**（R7b 遗留「只停了快照、没停 PNG」）：查清了，它不是只服务 `?preview=legacy` 的死代码——Agent 看帧、`get_layout`、草稿与 .proc 的快照、转场卡的快照都还依赖它，舞台端口被占时页面也会退回它。五个方案的 dry run 见 `docs/archive/agent-reports/AGENT-query-render-2.md` 第 8 节：B（只删没人用的 `preview.mp4`、整场景 `full.mov` 产物）已随 `claude/maint-3` 做完；C（停判轻卡的 PNG）、D（删整帧预览老路）牵涉用户看得见的行为，要用户定；E（整条删）不做。
- **会话与传输**：会话模型（双向序号与确认、中断后在保留期内接续）已随 HT-a 合入；HTTP 长轮询传输（HT-b）按触发条件再做，见上文「未开始的计划」。只能经 TLS 中间人代理出网的浏览器连不上 WebSocket（加入不了项目、当不了节点），同归 HT-b。
- **只记录、或要用户定的出入**：桌面发布的 plan 领不到环境不同的独立主机（X4）；`claude/join-error`（加入时连接没建成就断被报成「用户名或密码不对」，修复待审）；低内存档判轻的卡播放时一直占位（要不要改成判轻的也补小尺寸）；刷新后回到刷新前打开的共享项目（代码已做，建议补一级语义）；纯浏览器节点只收独立卡（D4）。出处与现状见 `REPORT-M5-M8.md` 第 6.3 节。
- **已做、从本节删去的**（2026-09-30）：共享项目（M6、SP、C6.5）；多用户协作（C10a）；在线浏览器模式（C10a、C10）；文档服务持有项目真身、Agent 直接写文档服务（C6.5）；素材服务的两档素材与产物入库（C5、C6.2、C6.4、C6.6）；本机按真正的发起方判断（HT-a）；渲染任务队列与渲染节点（M5b～M8）；加入共享项目的桌面应用自动成为渲染节点（0.7.2）；手动截短总时长的入口（项目设置对话框的「总时长（秒）」，走 `setDurationManual` 的截断规则，`8936e9af`；原先这里与 `REPORT-M5-M8.md` 第 6.3 节都误记为没有）；在线舞台握手后又断的退回（0.7.4）。

## 文档

- `desktop/README.md` 的 SKILL 悬浮窗几节描述的是现在的代码，和 `user-workflow.md` 的托盘方案不同。代码改完后跟着改。
- 被忽略、不入库的 `AGY-TASK-*.md` 留在原处不处理。
