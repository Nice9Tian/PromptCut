# AGENT-v18-semsync2：把 2026-10-13 下午到 10-14 合进 main 的各块攒下的语义更正建议落到文档

分支 `claude/v18-semsync2`，基底 main `44f824ca`。只改文档，没改代码和测试，没推送。上一次同样的活是 `595fcdbd`（报告 `AGENT-v18-semsync.md`），这次沿用它的做法：每条建议先对着 main 上现在的代码核实，再改；三级（`mechanism/`）和 `docs/plan/` 下的契约、任务书、对照文档、部署清单直接改，每处标〔裁：主会话 2026-10-14，<块名>〕；二级、一级一个字没改，在第三、四节列成「修改前 / 修改后」等用户定。

〔裁〕：执行中由会话改的语义，按 `suggested_agent_behavior.md`「对齐」一节要用户合入前审，可以推翻。

## 一、结果概览

- 范围内报告 22 份，全在 `docs/reports/`，没有跳过的。
- 建议约 95 条（按报告和段落点数；有的一句话拆成几处，表里合并）。
- 三级和 `docs/plan/` 直接改了 **20 个文件、约 85 处**（`mechanism/` 6 个、`docs/plan/` 14 个；分布见第五节）。
- 二级 **7 条**、一级 **4 条**留给用户定，写在第三、四节；另有 **5 件事**是待用户或待主会话定的，第六节。
- 核实后不成立或已被后来的块改掉的约 10 条，表里注明；没能核实的 3 条（都在 VisuHive 仓库里），表里注明。
- 基线：没改代码，`tsc` 没跑；`npm test` 见第七节。

最要紧的几件事：

1. **0.7.18 工具表接线（G 包）已经合入 main**（`53f15c6e`）。上一次文档里「已实现、未挂载」「还没挂载」「播放头恒为 0」「`page-results` 回 503」都成了过时句，这次统一改成已挂载，并按接线报告写了新机制（工具提供者、反向通道的进程分工、等后台作业收尾、浏览器数据与对话目录的清理）。代下那条路接上了但**缺省关着**（`PROMPTCUT_AGENT_COLLECT_DELEGATE`），文档里没有写成已开。
2. 删除云端对话（块五）的机制此前完全没有写进 `mechanism/agent.md`；这次补了一条（墓碑、待清单子、对账回执、50 个上限）。`product/agent.md` 的「对话的上限与删除」和 `workflow/production.md` 的删除入口主会话已经写过了，不用再改。
3. 渲染一侧改了 `mechanism/rendering.md` 的 9 处：分段起点从流自己的第一帧起、末段可不满 15 帧、兜底顺序的等待时长（真实时间、500 毫秒）、暂停和拖动也贴流、源依赖卡与依赖下层的流怎么产怎么贴、推帧补画、导出位图、播放保活、Lottie 放开。
4. `AGENT-rr-below-paste.md` 第 11.2 节的根因（「上面压着别的卡」）以 `AGENT-rr-push-draw.md` 为准；这次没有任何文档引用 11.2 的旧说法，所以没有要改的。
5. `AGENT-rr-sparse-streams.md` 的 `particles` 第六个键变化：契约第 9.2 节只写了五个 id，已补一句（实测 + 代码行 `src/cards/assets/index.ts` 第 94 行仍在），没有重跑比对脚本。

## 二、汇总表

处置栏：**三级已改** = 改在 `mechanism/` 或 `docs/plan/`；**二级/一级只列** = 见第三、四节；**不成立** = 核实后建议不再成立；**没能核实**；**报告类** = 建议改的是报告或代码，不属本次修改对象。

### 渲染一侧

| 编号 | 出自 | 建议一句话 | 处置 | 落在哪 |
|---|---|---|---|---|
| cb-1 | rr-card-bitmap 1 | dryrun 第 0 节第 1 条和第 61 行「按输入算哈希各存一份 HTML」描述不准 | 三级已改 | `html-snapshot-removal-dryrun.md` 该句末加更正 |
| cb-2 | rr-card-bitmap 2 | `mechanism/asset-service.md` 补「不经帧库」 | 三级已改 | `asset-service.md` 第 21 行 |
| cb-3 | rr-card-bitmap 3 | 任务书「单卡画面出位图」一行「有流的卡取流里的这一帧」没做 | 三级已改 | `render-refactor-task.md` 各项一览该行 |
| cb-4 | rr-card-bitmap 4 | 代码和 `bake_card` 说明里的「快照」叫法要不要统一成位图 | 没改（待主会话定） | 第六节 |
| cb-5 | rr-card-bitmap 5 | 推送目标登记晚时，登记之前入库的位图不会马上推 | 没改（算不算要修，待主会话定） | 第六节 |
| ss-1 | rr-sparse-streams 1 | 「流按全局帧号分段」的理由过时 | 三级已改（核了 `TODO.md` 第 107 行：挪动后流不失效仍是待办） | `mechanism/rendering.md` 兜底顺序「旧输入的层不贴」；`browser-stream-task.md` 的 `inputSig` 条 |
| ss-2 | rr-sparse-streams 2 | 最后一个分段可不满 15 帧 | 三级已改（核了 `src/render/streamSegments.mjs` 文件头） | `mechanism/rendering.md` 预渲染一节 |
| ss-3 | rr-sparse-streams 3 | dryrun 4.7 第 6 条「流键不用换」只在只改间隔时成立 | 三级已改（`STREAM_CODE_VERSION` 现为 4） | `html-snapshot-removal-dryrun.md` 4.7 第 6 条 |
| ss-4 | rr-sparse-streams 4 | dryrun 第 5 节「片段开头空 14 帧」和 4.5 组流的锚帧不再需要 | 三级已改 | `html-snapshot-removal-dryrun.md` 第 5 节表、4.5 表 |
| ss-5 | rr-sparse-streams 5 | 契约 9.2「五个 id」变成六个 | 三级已改（加一句，原表里的「五个」没逐处改） | `prerender-products-contract.md` 第 9.2 节 |
| ss-6 | rr-sparse-streams 6 | 层表行、`StreamResult` 头、`input.stream` 的字段跟着改 | 三级已改两处；`hosted-render-contract.md` 里没有写分段范围，**不成立** | `prerender-products-contract.md` 层表行、`browser-stream-task.md` 层表行、`artifact-transfer-contract.md` 的 `StreamResult` |
| ss-7 | rr-sparse-streams 7 | 派活指令写的 `snapshotGrid.mjs` 位置不对 | 不成立（契约里写的本来就是 `src/render/snapshotGrid.mjs`） | — |
| ss-8 | rr-sparse-streams 8 | `SPARSE_STRIDE = 3` 等代码注释第二期要改 | 报告类（代码）；`SPARSE_STRIDE` 现为 `STREAM_SEGMENT_FRAMES`（15），已过时 | — |
| s2-2 | rr-sparse-streams-2 10.2 | 部署次序：文档服务先于渲染节点、桌面升级 | 三级已改 | `four-stage-deploy-checklist.md` 先决条件一节末 |
| s2-3 | rr-sparse-streams-2 10.3 | 6 张卡的键变了 | 三级已改（并入 ss-5） | 契约 9.2 |
| s2-x | rr-sparse-streams-2 10.1、4、5、6 | 读法过目；暂停 3 处没有测试盖着；界面三句话；四支在线探针重跑 | 待主会话/用户 | 第六节 |
| sc-1 | rr-scrub 1 | 兜底顺序补「按真实时间算」「最多等 500 毫秒」 | 三级已改（核了 `HOLD_FRAMES`、`StageView.tsx` 的 `STREAM_FIRST_WAIT_MS = 500`） | `mechanism/rendering.md` 兜底顺序 |
| sc-2 | rr-scrub 2 | 暂停和拖动超出解码器预算没做排队；契约 3.2、16 第 11 条改 | 三级已改（`SCRUB_HOLD_MS` 已不存在，核了 grep） | 契约 3.2 节、16 节第 11 行 |
| sc-3 | rr-scrub 3 | `product/rendering.md`「到货后在下一个分段起换上」补「暂停着时原地换上」 | **二级只列** | 第三节 S1 |
| sc-4 | rr-scrub 4 | 暂停着时已回到精确活渲的重卡，流平面藏着照样解这一帧 | 三级已改（核了 `Stage.tsx` 的 `display: none`、`snapshotFeed.ts` 的 `planesWithinBudget`） | `mechanism/rendering.md` 兜底顺序 |
| sc-5 | rr-scrub 5 | 契约 3.3「先取好不建解码器」过时 | 三级已改 | 契约 3.3 节 |
| sc-6 | rr-scrub 6 | 契约 3.1「没有流盖着显示占位符」没做 | 三级已改 | 契约 3.1 节 |
| sc-7 | rr-scrub 7 | `stageSwap.ts` 不在任何一道的文件清单里 | 三级已改 | 契约 13.1 节道三 |
| sc-9 | rr-scrub 9.1～8 | 活渲多走一帧、在线页面没验、互换后头一小段空着等 | 报告类/代码（9.3 的先发流平面后发抑制已在 `a3b5353f` 做了，写进契约 5.4） | — |
| so-1 | rr-source-streams 1、2、3 | 「怎么产，按卡分」转场与素材效果卡、三维外框、不并组流、只由桌面和渲染主机产 | 三级已改 | `mechanism/rendering.md` 预渲染一节；契约 5.1 节 |
| so-4 | rr-source-streams 4 | 被接片段挪了：签名变、流键不变 | 三级已改 | `mechanism/rendering.md`「旧输入的层不贴」 |
| so-5 | rr-source-streams 5 | 契约 5.1「源依赖卡未定缺省不进」「三维外框不进」过时；16 第 14 条仍成立 | 三级已改 | 契约 5.1 节、16 节第 14 行 |
| so-6 | rr-source-streams 6 | dryrun 4.5 表「现在不进流」 | 三级已改 | `html-snapshot-removal-dryrun.md` 4.5 表 |
| so-7 | rr-source-streams 7（代码注释） | `card-cache.mjs` 注释撤快照时清 | 报告类（代码） | — |
| so-x | rr-source-streams 7.1 | 依赖下层又带三维的卡仍没有流 | 写进文档为现状（`BELOW_STREAM_RULES.frame3d` 为 `false`）；是否打开待用户 | 第六节 |
| os-1 | rr-online-sparse 6 第一条 | 50 秒从第一次等稀疏版起算 | 主会话已在 `aa5ee127` 改，不重复 | — |
| os-2 | rr-online-sparse 6 第二条 | 在线页面还有「快照趟」 | 三级已改 | `mechanism/rendering.md`「测量」 |
| os-3 | rr-online-sparse 6 第三条 | `product/platforms.md` 补播放保活 | **二级只列** | 第三节 S2 |
| os-4 | rr-online-sparse 5.4 | 连接在测量落定前就开 | 主会话已在 `aa5ee127` 改，不重复 | — |
| os-5 | rr-online-sparse 〔裁〕五 | 成本记录命中的重卡不在遮罩下产 | 三级已改（并入 os-2） | `mechanism/rendering.md`「测量」 |
| bp-1 | rr-below-paste 9.1 | 依赖下层的流贴回舞台的平面、签名 | 三级已改 | `mechanism/rendering.md` 预渲染一节 |
| bp-2 | rr-below-paste 9.2 | 契约 5.4 就绪索引带 `streamKind`、`inputSig`；`parseLayerStreams` 还没认 `below` | 前半三级已改；后半**已过时**（`snapshotSource.ts` 现在认） | 契约 5.4 节、第 13 节「下层四」行 |
| bp-3 | rr-below-paste 9.3 | `stageSwap.ts` 不在道里 | 并入 sc-7 | 契约 13.1 节 |
| bp-4 | rr-below-paste 9.4 | 戊二验收受 7.1 那件事限制 | **不成立**：7.1（`upper-changed`）的根因是「这张卡挂载那一拍没有 rAF」，`rr-push-draw` 已修 | — |
| bp-7 | rr-below-paste 7.2～6 | 差分取层自检判死、重卡活渲多走一帧、视频颜色矩阵等 | 报告类（7.1 见 bp-4） | — |
| bo-1 | rr-below-online 8.1 | 在线页面清单计划里依赖下层的卡由切分方产 | 三级已改 | `mechanism/rendering.md`「预渲染结果的复用」 |
| bo-2 | rr-below-online 8.2、8.3 | 契约 16 另外三件第一件；`streamPicked` 没改 | 三级已改 | 契约 16 节 |
| pa-1 | rr-play-alive 9 | 「页面按 100 ms 节流报上来」改成「每 2 秒保活」 | 这句话在语义文档里**不存在**（grep 全无）；改成往 `mechanism/rendering.md` 预渲染一节补一句事实（核了 `PLAYHEAD_KEEPALIVE_MS`、`PLAYING_STALE_MS`） | `mechanism/rendering.md` |
| pd-1 | rr-push-draw 7 第一条 | rr-below-paste 11.2 三处照 push-draw 更正 | 报告类 | — |
| pd-2 | rr-push-draw 7 第二条 | `mechanism/rendering.md` 加推帧补画 | 三级已改（核了 `bake.mjs` 文件头与 `pushDrawNeeded` 说明） | `mechanism/rendering.md` 预渲染一节 |
| l2-1 | rr-lottie-2 2 | 任务书「癸」「缺省不放开」；`m7-contract.md` 第 13 节第 6 条 | 三级已改（核了 `split.mjs`、`pageStreamPlan.ts` 已无排除常量，提交 `fb3a6c94`） | `render-refactor-task.md` 癸、第 121 行；`m7-contract.md` 第 103 行与第 6 条；契约第 8 节；dryrun 4.5 表；`mechanism/rendering.md` |
| l2-x | rr-lottie-2 1、3 | 合不合放开提交；在线页面贴流没验 | 待用户 | 第六节 |
| oe-1 | rr-online-export 8 第一条 | `mechanism/platforms.md`「导出页」一条 | 三级已改 | `platforms.md`「在线执行用户卡与素材效果卡」 |
| oe-2 | rr-online-export 8 第二条 | 导出位图写进 `mechanism/`（键、沿用流任务、不进层表、清单、节点本机不留） | 三级已改 | `mechanism/rendering.md` 预渲染一节 |
| oe-3 | rr-online-export 8 第三、四条 | `product/platforms.md` 渲染节点表补导出位图；「导出」点明导出页不执行 | **二级只列** | 第三节 S3 |
| oe-x | rr-online-export 8 后两条 | 探针用的节点、`batch3-common.md` 过时 | 报告类 | — |

### 0.7.18 一侧

| 编号 | 出自 | 建议一句话 | 处置 | 落在哪 |
|---|---|---|---|---|
| w-1 | v18-wire 更正建议 1 | 「还没挂载」改为任务进程按配置建提供者 | 三级已改（核了 `account-runner.mjs` 的 `toolset`、`account-tools.mjs`） | `mechanism/agent.md` 新条「账号模式的工具提供者」；任务书/契约 9.2 提示 |
| w-2 | v18-wire 2 | 「播放头恒为 0」改成 `seek` 记下播放头，切剪辑三个仍按 0 | 三级已改（核了 `account-runner.mjs` 的 `latestPlayhead: () => null`） | `mechanism/agent.md` 第 97 行 |
| w-3 | v18-wire 3 | `page-results` 回 503 改成挂了登记表 | 三级已改（核了 `http.mjs`、`conversation-policy.mjs`） | `mechanism/agent.md` 第 65、99 行 |
| w-4 | v18-wire 4 | 等后台作业才收尾（最多一小时，每 2 秒数账本、每 30 秒核一次） | 三级已改（核了 `ACCOUNT_TOOL_DEFAULTS`） | `mechanism/agent.md` 新条；用户看得到的部分见 S5 |
| w-5 | v18-wire 5 | 浏览器数据与对话目录的清理、记号、单子 | 三级已改，按「节点自检之后的第二轮返工」写（主服务只清自己的库，目录交给任务用户一侧） | `mechanism/agent.md` 新条 |
| w-6 | v18-wire product/agent.md 四句 | 后台作业排队；网页操作隔离不代填；采集未登录画质；转私有清浏览器状态 | **二级只列**（第三、四句按返工后的形式写） | 第三节 S5 |
| w-7 | v18-wire 任务书 | 账号模式不读环境变量，改 `worker.tools`；拆包表 G 行不是改 mode；窄接口签名 | 三级已改 | `cloud-agent-tools-implementation.md`；`four-stage-deploy-checklist.md` C5b |
| w-8 | v18-wire 契约 9.2、9.4d、9.7、28 | 工具表、采集登录态、系统提示词、反向通道是旧形状 | 三级已改（9.2 加总说明，不逐格改；9.4d、28.8、各「未挂载」处逐处改；9.7 加更新注） | `cloud-agent-contract.md` |
| w-9 | v18-wire 覆盖表 | 状态改为已挂载，没真跑的不写成通过 | 三级已改（统一替换 28 处并加总注） | `cloud-agent-tool-coverage.md` |
| w-10 | v18-wire ACCEPT-018-map 产品问题 10 | 前半已修、SEAM-1 硬断言了 | **没改**：`docs/plan/` 下没有这个文件（`ls` 无匹配） | 第六节 |
| w-11 | v18-wire 用户待定三条 | 代下提示；等后台作业时页面显示；一小时到了的结果 | 待用户 | 第三节 S4、S5；第四节 F4 |
| ch-1 | v18-chats 1（一级） | `workflow/production.md` 删除入口那一句 | **不成立**：主会话已写（第 38 行「云端对话可以删除，删之前确认…」） | — |
| ch-2 | v18-chats 2（二级） | `product/agent.md` 删除的权限、通知、补弹、先停再删 | **不成立**：已写（第 11 行「对话的上限与删除」） | — |
| ch-3 | v18-chats 3 | 契约、`cloud-agent-task.md`、补充文档、设计、拆包表、部署清单仍写「待确认」 | 三级已改（五处加更新注；契约补三个内部接口、三个页面接口、错误码） | `account-binding-contract.md`、`cloud-agent-task.md`、`three-versions-018-design.md`、`render-scheduling-supplement.md`、`four-stage-deploy-checklist.md` |
| ch-4 | v18-chats 机制（墓碑、待清单子、对账回执） | 删除对话机制此前没有写 | 三级已改 | `mechanism/agent.md` 新条「删除对话」 |
| ch-x | v18-chats 4、5 | 摸底报告疑问关闭；新对话 502 待办 | 报告类 / newchat 已处理 | — |
| cs-1 | v18-cardsync 1 | 票据到期要续的实际是「访问令牌到期连接作废」；加「账号云端项目的连接寿命」一条 | 三级已改（核了 `accountLinkLife.ts`、`link.ts`、`account-card-link.mjs` 的常量） | `mechanism/document-service.md`「会话与传输」 |
| cs-2 | v18-cardsync 2 | 「版本与身份」加提交身份不含凭证号 | 三级已改（核了 `operation-wiring.mjs` 注释） | `mechanism/document-service.md`「版本与身份」 |
| cs-3 | v18-cardsync 3 | `product/platforms.md`「桌面」记待办：舞台里卡片能调本机接口 | **不成立**：`v18-guard` 已修；这条待办在 `product/platforms.md` 里本来也没写 | — |
| cs-4 | v18-cardsync 同块 | `product/platforms.md`「在线浏览器执行同步来的用户卡」账号项目里不成立 | **不成立**：同块已修（`accountCardSync.ts`） | — |
| lo-1 | v18-logout2 1 | product 里讲改密退出的地方补「等超时显示失败」；时限的数放 mechanism | 时限三级已改（核了 `LOGOUT_CONFIRM_TIMEOUT_MS = 120_000`）；用户看得到的部分 **二级只列** | `mechanism/document-service.md` 退出确认；第三节 S6 |
| lo-2 | v18-logout2 2 | `account-binding-contract.md`「退出失败的展示」改已定 | 三级已改 | `account-binding-contract.md` |
| lo-3 | v18-logout2 3 | 部署清单加 `ACCOUNT_LOGOUT_CONFIRM_TIMEOUT_MS` | 三级已改（环境变量在 VisuHive 仓库，**没能核实**；文档服务一侧 `account.logoutConfirmTimeoutMs` 核了） | `four-stage-deploy-checklist.md` |
| lo-4 | v18-logout2 4 | VisuHive `docs/accounts.md` | 报告类（另一个仓库） | — |
| gd-1 | v18-guard 1 | `mechanism/platforms.md`「桌面」加舞台端口白名单；闸管不到的三处照实写 | 三级已改（核了 `stage-gate.mjs`；三处按报告第 66 行起的 1、2、3 条） | `mechanism/platforms.md` |
| gd-2 | v18-guard 2 | 销掉 cardsync 记的待办 | 并入 cs-3 | — |
| gd-3 | v18-guard 3 | `querySelections` 不问页面、问账号权威；401/403 这一位不算 | 三级已改（核了 `selection.mjs` 注释） | `mechanism/agent.md` 新条「选区查询」 |
| mv-1 | v18-move 机制（请求号、核对、关协作后先存本机等） | 搬到云端的机制此前没有写 | 三级已改 | `mechanism/hosting.md`「显式搬迁与恢复位置」 |
| mv-2 | v18-move 1（`workflow/project.md`） | 「项目设置里另有搬到云端、搬回本机」 | **一级只列** | 第四节 F1 |
| mv-3 | v18-move 2、3（`product/document-service.md`） | 「随时搬」「版本号连续」「迁入」在账号办法下不成立 | **二级只列** | 第三节 S7 |
| mv-4 | v18-move 4、5 | 任务书「超过 1 MiB 时才…」「素材单件大小限制没查」 | 报告类（任务书这句已体现在 `hosting.md`：一律先建再写） | — |
| mv-x | v18-move 要用户定 6 条 | 界面文字、限定进入的房间、被踢过的人、失败后残留项目、搬完自动存、旧按钮 | 待用户 | 第六节 |
| mg-1 | v18-move-guard 1 | 契约已补预检段；`workflow/project.md` 补一句 | 契约已有；预检写进 `hosting.md`；`workflow/project.md` **一级只列** | 第四节 F1 |
| mg-2 | v18-move-guard 2、3 | 失败提示句子；已被旧版本封锁的房间 | 待用户 | 第六节 |
| rl-1 | v18-runner-list 1～4 | `ACCEPT-018-map.md` 问题编号；`four-stage-deploy-checklist.md` A1 加 `--rows`、`--no-optional` | A1 三级已改（核了 `acceptance-lib.mjs`）；`ACCEPT-018-map.md` 同 w-10，没改 | `four-stage-deploy-checklist.md` A1 |
| pn-1 | v18-private-notice | 围栏掐断的流写不出事件，页面靠「读到过的对话重连得到 404」识别撤销 | 三级已改 | `mechanism/agent.md`「新对话的空对话」一节 |
| pn-2 | v18-private-notice | 上一份报告第一条按本份更正 | 报告类 | — |
| nc-1 | v18-newchat（三级） | 契约 `accountEvents` 回 404 | **已有**（契约第 157、1955 行）；`mechanism/agent.md` 第 141～144 行也已有 | — |
| nc-2 | v18-newchat（一级、二级） | 新开、还没发过消息的云端对话是安静的空对话 | **一级、二级只列** | 第四节 F2 |

## 三、二级对照表（`product/`；不改文档，主会话逐条报用户）

「修改前」是现在文件里的原文。

**S1. 暂停着时「更好的结果」原地换上（sc-3，〔裁 8〕）**
- `product/rendering.md` 第 54 行。
- 修改前：`- 更好的结果到货后自动替换，不等用户操作：稀疏段换成满帧段在下一个分段起换上（两种编码的差分帧不能接续）。`
- 修改后：在句末补一句「暂停着的时候原地换上」。
- 白话：播放时稀疏画面要等到下一个分段才换成清楚的；暂停时没有下一个分段可等，所以暂停着就地换，用户看得到暂停时画面变清楚而不是一直糊着。

**S2. 播放、拖动时节点报「还在」（os-3）**
- `product/platforms.md` 第 31 行。
- 修改前：`- 节点只在闲时认领：本机 PC 和纯浏览器在用户播放、拖动时不认领新任务，手里在做的那一批做完为止。`
- 修改后：补「播放、拖动时在线页面的节点每隔一段时间向队列报『还在』，它锁着的卡不因此被别的环境接手」。
- 白话：用户一边拖时间轴，一边是自己这台浏览器在替某张卡产画面，别的机器不会趁这时把这张卡抢过去重做一遍。
- 备注：机制已经在 `mechanism/rendering.md`（主会话 `aa5ee127`）。

**S3. 导出页不执行同步来的卡；导出位图由谁做（oe-3）**
- `product/platforms.md` 第 75 行「导出」、第 25～27 行渲染节点表。
- 修改前（导出）：`……本页不执行的同步用户卡、素材效果卡，导出开始时请渲染节点按原尺寸逐帧渲好再用，没到齐时提示等待。`
- 修改后：改为「导出页本身不执行同步来的用户卡和素材效果卡（和这些卡在预览里能不能运行无关）；它们的画面由渲染节点为这一次导出逐帧渲好；没到齐时在导出进度窗口里等；节点渲不了、任务失败、等的时候项目被改，导出直接失败并说明原因」。节点表里两种节点补「导出位图任务由本机 PC 和独立渲染主机做，纯浏览器不做」。
- 白话：用户点完整导出，如果项目里有同步来的别人写的卡，导出得等一台电脑或渲染主机替它出图；这时只有纯浏览器的用户没有别的机器就会一直等，直到失败。等待的提示在进度窗口里，不再单独一条。

**S4. 云端采集代下现在是什么状态（w-11，要用户定）**
- `product/agent.md` 第 47 行。
- 修改前：`……上述登录态代下目标尚未桥接到现有实现，契约中的 collect_login/collect_login_check 缺口是实现状态记录，不是产品规则禁用。……`
- 修改后：「登录态代下的桥接已经做好并接入工具表，但缺省关着，云端采集一律按未登录的画质下载；桌面版代下时给不给提示、提示什么，用户定了以后才开」。
- 白话：有的视频站登录后才给高画质，登录信息只在用户自己的电脑上，所以做了「云端让你的电脑用你的登录去下」这条路。现在这条路做好了、关着，因为桌面版会在用户不知道时用他的电脑和带宽干活。**要用户定**：（甲）一直关着；（乙）打开，桌面版显示一行提示，字要用户给（报告建议乙）；（丙）每次弹确认框。开之前还要先补「撤回已经在传的文件」的接口。

**S5. 云端 Agent 工具范围里补四句（w-6、w-11）**
- `product/agent.md` 第 45～49 行「工具范围」。
- 现在没有这几句，建议加（第三、四句按返工后的形式，原来的两句撤回）：
  1. 云端的后台作业（转写、镜头识别、主体识别、追踪、一键流程）做完之前，这个对话的下一条消息排在后面，最多等一小时；到时没做完的作业被中断，这一轮仍记完成，不另外通知用户，之后查作业看到「被中断」。（〔裁〕1，二级，要用户定；还有三个待定：这段时间页面显示什么字；等满一小时是否另行通知；排队还是不等。）
  2. 网页操作按对话隔离，不代填口令、验证码、卡号，只访问公网。
  3. 采集遇到要登录的站点时，云端按未登录的画质下载。
  4. 对话转成私有时，这个对话在云端浏览器里攒下的状态清掉；创建者关掉云端 Agent 时不清（用户看不到区别的部分在 `mechanism/agent.md`）。
- 白话：Agent 说完话以后，转写这类后台活可能还在做，用户在同一个对话里发的下一条要等它们做完才开始，最长一小时；这是用户看得出的区别。

**S6. 改密选「退出」后等确认超时（lo-1）**
- `product/` 里目前没有写「设备已退出」的位置，建议加在 `product/document-service.md` 第 74 行「改密码或重设密码选了退出而触发的撤回」附近。
- 修改后：「改密选了退出之后，网页等各服务确认最多 120 秒；超过了，网页显示『退出没有确认完成』和调试信息，不显示『设备已退出』；旧设备在选退出的那一刻就已不能用，权限不受影响；之后确认到齐，网页照实改成已退出」。
- 白话：用户改密选了退出，如果某个服务一直没回话，网页不会假装退出成功，也不会一直转圈，两分钟后说没确认完并给出排查信息，但他的旧登录早就作废了。时限数字和处理已经写进 `mechanism/document-service.md`。

**S7. 账号办法的「搬到云端」与文档服务产品文档不一致（mv-3）**
- `product/document-service.md` 第 34 行、第 44 行、第 60 行。
- 修改前：`两种之间可以随时搬`；`切换前后版本号连续，不归零`；`云端新建、迁入和加入都核对网站账号`。
- 修改后：账号办法下，「搬到云端」是在云端新建一个属于登录账号的项目、内容与本机一致，搬上去的是新项目，版本从头计；「迁入」就是凭账号新建并写入内容，没有单独的迁入接口；「搬回本机」这一版收起（旧办法的房间仍可搬）。
- 白话：用旧的协作房间办法，可以来回搬、版本号不断；现在账号办法搬到云端是新建一个项目、版本从 1 开始，这和现有写的「版本号连续」对不上。

另有〔裁〕类二级决定（已播报，用户可推翻），文档里还没有对应的句子，写在 `AGENT-v18-move.md` 的「裁定」一到九：只有以创建者身份进入的人能搬；限定进入的房间搬上去后凭链接登录就能进；禁入表不带；失败后云端已建的项目留着；搬完自动存一次本机；同一台电脑另一个窗口正在搬时直接拒。

## 四、一级对照表（`workflow/`、`user-workflow.md`；会话不许改，每条用户定）

**F1. 搬到云端（mv-2、mg-1）**
- `workflow/project.md` 第 18、22 行。
- 修改前：第 22 行 `- 项目设置里另有「搬到云端」「搬回本机」。`；第 18 行 `等待完成后显示邀请链接与二维码（里面是邀请码），并提醒……可在设置里搬到云端。`
- 修改后：「搬到云端」是在云端新建一个属于登录账号的项目、内容与本机一致，搬完本机协作关闭、旧邀请码作废，界面提示把新的项目链接发给原来的成员，旧成员用新链接登录自己的账号加入；「搬回本机」这一版收起；「等待完成后显示邀请链接与二维码」只对放在本机的项目成立。搬到云端之前先确认目标云端接受旧办法，不接受则不改动本机房间。
- 白话：用户点「搬到云端」之后，会得到云端上一个新项目，别人需要新链接；点之前，如果目标云端只认网站账号而用户填的是旧办法，会先被拦下而不是把本机房间弄坏。

**F2. 新开云端对话（nc-2）**
- `workflow/production.md`。现在没有这条，建议在第 35 行（连接状态点说明）附近补。
- 修改后：「新开、还没发过消息的云端对话是一个安静的空对话，不显示断线提示、不后台重试；发出第一条消息后才连事件流。」
- 白话：以前开一个新对话，页面会一直显示「连接断了，正在重新连接」，现在是干净的空对话。

**F3. 退出失败的提示句子（lo-1，用户事后改）**
- 报告 `AGENT-v18-logout2.md`「要用户事后改的」：失败时那句话（「退出没有确认完成。旧设备已经不能再使用；需要帮助时，请把下面的信息发给我们。」）、调试信息要不要直接显示在网页上、「选不退出」之后那句还是旧说法。

**F4. 两处界面文字要用户给字（w-11）**
- 代下时桌面版的提示行（见 S4 乙）；Agent 说完话后台作业还在做时页面显示的那一句（现在显示「执行已结束，等待云端确认关闭与结算。」，没说在等后台作业）。

## 五、改了的文件

提交（本分支，没推送）：

| 提交 | 内容 |
|---|---|
| `d2000425` | 渲染重构各块：`mechanism/rendering.md`、`platforms.md`、`asset-service.md`；契约 `prerender-products-contract.md`、`m7-contract.md`、`browser-stream-task.md`、`artifact-transfer-contract.md`、任务书 `render-refactor-task.md`、`html-snapshot-removal-dryrun.md`、`four-stage-deploy-checklist.md` |
| 第二笔 | 0.7.18 各块：`mechanism/agent.md`、`document-service.md`、`platforms.md`、`hosting.md`；`cloud-agent-contract.md`、`cloud-agent-tools-implementation.md`、`cloud-agent-tool-coverage.md`、`account-binding-contract.md`、`cloud-agent-task.md`、`three-versions-018-design.md`、`render-scheduling-supplement.md`、`four-stage-deploy-checklist.md` |
| 第三笔 | 本报告，以及契约「下层四」一行的补记 |

分布（`git diff --stat main...HEAD` 看过，20 个文件共 122 行增、99 行删，没有整份被改的文件，行尾没有被换）：`mechanism/` 6 个文件（`rendering.md` 9 处、`agent.md` 15 处、`document-service.md` 3 处、`platforms.md` 2 处、`hosting.md` 1 大段、`asset-service.md` 1 处），`docs/plan/` 14 个文件（`prerender-products-contract.md` 约 16 处、`cloud-agent-contract.md` 约 14 处、`cloud-agent-tool-coverage.md` 28 处统一替换加总注、`four-stage-deploy-checklist.md` 7 处，其余各 1～6 处）。`document-service.md`、`hosting.md`、`account-binding-contract.md`、`four-stage-deploy-checklist.md` 在工作区是 CRLF，用脚本按各自行尾写的。

## 六、没做成的、待用户或主会话定的

1. **cb-4 术语**：`bake-store.mjs`、`bake.ts` 的标识符和报错文字、`bake_card` 的工具说明里还把这张 PNG 叫「卡片快照」；术语表把「快照」定为 HTML。给模型和用户看的文字要不要统一改叫法，主会话定。
2. **cb-5**：预渲染进程的推送目标登记得晚时，登记之前入库的位图要等下次命中才推到远程素材服务；算不算要修，主会话定。
3. **source-streams 7.1**：依赖下层（或没审阅过又没接输入）而外框又带三维的卡仍没有流，判重时播放中是占位符。选项：甲，打开 `BELOW_STREAM_RULES.frame3d`，产带三维的、舞台坐标的流，画面对但和「产变形之前的流」字面不同；乙，接受占位符。报告建议甲，等「依赖下层的流贴回舞台」之后做。撤快照之前要先定。文档已按现状写。
4. **Lottie 放开**（`fb3a6c94`）：已在 main，文档按放开写；报告原话是请主会话定合不合。在线页面贴流那一路没验。
5. **sparse-streams-2 第 10 节**：〔裁〕一的读法要用户过目；暂停时三处没有测试盖着（留着补一条「播放途中重问清单」的测试，还是先拿掉）；界面另外三句话；合并后四支在线探针重跑。
6. **move 的六条**：界面文字、限定进入的房间搬上去后谁能进、被踢过的人、失败后云端残留项目要不要自动删、搬完自动存是否合适、账号项目设置里旧办法按钮要不要收起（账号项目里「搬回本机」已收起，其余旧按钮还在）；**move-guard 的两条**：失败提示句子、已被旧版本封锁的房间要不要解封或转换。
7. **没能核实的三件**：VisuHive 仓库里的账号服务判超时（`ACCOUNT_LOGOUT_CONFIRM_TIMEOUT_MS` 的名字与缺省 120 秒，文档服务一侧的 `LOGOUT_CONFIRM_TIMEOUT_MS = 120_000` 核了）；`ACCEPT-018-map.md`（`docs/plan/` 下没有，另外两条建议——v18-wire 的产品问题 10、v18-runner-list 的问题编号——没改）；上次报告里另一半没动：契约 `cloud-agent-contract.md` 第 9.2 节各格里分散的「已实现」「差什么」字样我只加了总说明，没有逐格重写（格子太多，改一格不改另一格会更乱）。
8. **v18-wire 里 Linux 上的两用户权限自检**要主会话在节点上跑，文档里写了期望末行 `PASS 26/26`，我没有跑也没能核实它现在还是 26 项。

## 七、基线与验证

- 没改代码和测试，未跑 `npx tsc -b --force`。
- `npm test`：设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`（值取自主工作区 `docs/local.md` 文末两行，未打印、未读其它内容）和 `PROMPTCUT_NO_PORT_FILE=1`；全量 6895 条：通过 6878、失败 1、跳过 15。失败的一条是 `server/test/account-worker-lifecycle.test.mjs` 的「退出确认里 Agent 这一项…」，机器忙时的偶发（别的块的报告里也出现过）；单独重跑该文件 9 条全过，「npm test 最终结果：零失败」。文档用词和链接的守门测试全过。
