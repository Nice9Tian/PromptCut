# 发版耗时记录

规则见 `docs/semantics/guide_files/verification.md`「耗时只记录，不当闸门」（2026-10-07 用户改定）：验收项里的时间数字不决定过不过，跟着发版记在这里。一个版本一节，新的写在最上面。

## 怎么出一节

在发版提交上跑一遍本地验证，带 `--release-timings`：

```
node scripts/acceptance/four-stage-acceptance.mjs --out <输出目录> --release-timings "<版本号>"
```

跑完后这一节的文本在 `<输出目录>/release-timings-section.md`（同时打印在终端），整段贴到本文件「怎么读」一节的后面、已有各版本的最上面(每个版本是一个二级标题)。机器配置（哪台、处理器、核数、内存、显卡、系统）由运行器起跑时自动采集，不含任何凭证；`--machine-name <名字>` 可以把「哪台」写成更好认的名字。已经跑过、只想重出这一节：

```
node scripts/acceptance/four-stage-acceptance.mjs --timings-from <输出目录>/results.json --release-timings "<版本号>"
```

在哪台机器上跑都行，写明是哪台。机器有降频的时段时，可以配 `scripts/acceptance/sample-cpu-performance.ps1` 把采样期间的频率读数一起记下。

## 怎么读

- 「各项整项用时」是验收运行器里每一项从开始到结束的秒数，含起服务、建项目、等待。
- 「探针量的耗时」是探针自己量的数字。最后一列是这个数字原来的门槛，现在只作对照，不作通过条件。
- 相邻两版之间某项明显变差，在发版汇报里指出来，由用户决定要不要查；不挡发版。
- 不同机器之间的数字不能直接比，先看「机器」一行。


## 0.7.18 候选

- 提交:`382a877a611db24cf4e5feb66ff1322d40a14817`
- 跑的时间:2026-10-07T12:21:48.263Z → 2026-10-07T14:36:15.709Z
- 机器:DESKTOP-GS40TCK;处理器 Intel(R) Core(TM) i7-14700KF;核数 20 物理 / 20 逻辑;内存 31.8 GB;显卡 NVIDIA GeForce RTX 3080;系统 Microsoft Windows 11 Pro 10.0.26200 x64;Node v24.19.0
- 范围:73 项(验收运行器跑过的;人工项与真实网络验证的项不在内)。合计机器耗时 130 分钟
- 这些数字只记录,不决定过不过。相邻两版之间某项明显变差,在发版汇报里指出来,由用户决定要不要查。
- 说明：这一遍跑在 `382a877a` 上。其中 `G0-2`（全量测试）不过，原因是这次新加的单测 `probe-timings.test.mjs` 没登记进「server 下的文件引用 scripts/」的守门名单；在 `0310dfc7` 上补了登记后单独重跑 `G0-1`、`G0-2`：都过，`npm test` 4928 条、通过 4927、失败 0、跳过 1，用时 64 秒。`P-asset-path` 不过是这台机器缺带 numpy 的 Python（环境问题）。`P-c10-browser-full` 第一遍在 A5「独立渲染主机认领清单计划」上等满 15 分钟没等到（表里的 1069 秒是这一遍），重跑一遍 178 秒通过，记为不稳定。

### 各项整项用时

| 编号 | 项 | 判定 | 整项用时(秒) |
|---|---|---|---|
| G0-1 | 类型检查 tsc -b --force | 过 | 5 |
| G0-2 | 全量测试 npm test | 不过 | 62 |
| G0-3 | 网页构建 npm run build(tsc -b 与 vite build) | 过 | 7 |
| G0-4 | 在线构建 vite build --mode online | 过 | 2 |
| G0-5 | 桌面壳脚本测试 node --test desktop/test | 过 | 1 |
| GR-1 | main 基准树全长导出(1800 帧,单进程) | 过 | 117 |
| GR-2 | 候选全长导出(与 main 同参数) | 过 | 116 |
| GR-3 | 与 main 的像素比对:0 不同、0 缺失 | 过 | 0 |
| GR-4 | 导出确定性:同一段导两遍逐像素相同(1800/1800) | 过 | 314 |
| GR-5 | 导出与快照重放一致 verify-unified-frames | 过 | 10 |
| GR-6 | ready-index-probe(就绪索引的端到端) | 过 | 48 |
| GR-7 | stream-produce-probe(轨道流生产,含全幅编码 p50 ≤ 300 ms) | 过 | 37 |
| GR-8 | stream-produce-probe --group(组流) | 过 | 26 |
| GR-9 | preview-fallback-probe(普通预览兜底顺序) | 过 | 37 |
| GR-10 | preview-fallback-probe --page-preload | 过 | 38 |
| GR-11 | video-source-cadence-probe(视频取帧节奏) | 过 | 12 |
| GR-12 | video-seek-race-probe 三实例并行(取帧竞态,各 300 轮) | 过 | 43 |
| P-c10-browser-a4 | C10 在线普通档 A1～A4(不导视频) | 过 | 125 |
| P-c10-browser-full | C10 在线普通档完整版 A1～A5 | 不稳定 | 1069 |
| P-c10-user-card | C10 用户卡端到端 --user-card | 过 | 120 |
| P-online-user-cards | 在线用户卡探针 | 过 | 39 |
| P-c10-ui | C10 界面探针(徽标、断线重连、用户卡贴层) | 过 | 165 |
| P-online-stage-watch | 在线舞台看守(握手后又断) | 过 | 142 |
| P-online-stale-layer | 在线改参数后不再贴旧层 | 过 | 41 |
| P-online-stage-handshake | 在线舞台首次握手计时(慢网络退单舞台) | 过 | 172 |
| P-online-nav-stress | 在线页导航压测 200 次 | 过 | 214 |
| P-desktop-auto-node | 桌面应用自动成为渲染节点 | 过 | 295 |
| P-m7-browser | M7 纯浏览器节点验收(本机替身,A1～A12;「跨机」不再单独成项) | 过 | 796 |
| P-m7-node | M7 纯浏览器节点本机端到端 | 过 | 20 |
| P-tier-switch | 两档素材换档(黑帧、帧误差、超时) | 过 | 75 |
| P-creativity | 创造力等级界面 | 过 | 8 |
| P-user-editing | 「用户正在编辑」 | 过 | 3 |
| P-query-render | 查询渲染调度 | 过 | 92 |
| P-multi-agent | 多 Agent(阶段一与阶段二) | 过 | 32 |
| P-custom-measure | 自定义测量 measure_audio_js | 过 | 13 |
| P-skill-mcp | SKILL 经 MCP 直连 | 过 | 16 |
| P-codex-auth-state | Codex 登录状态的界面探针 | 过 | 15 |
| P-asset-path | Agent 读素材走素材服务 | 不过 | 12 |
| P-bake-asset | bake_card 快照经素材服务存取 | 过 | 78 |
| P-claim-gate | 队列模式认领闸 | 过 | 203 |
| P-tiers | 两档素材与上传队列 | 过 | 22 |
| P-storage-cap | 帧库上限与淘汰 | 过 | 17 |
| P-storage-ui | 开始页「存储」界面 | 过 | 77 |
| P-cross-machine-proc | 跨机器直接打开 .proc | 过 | 51 |
| P-shared-import-upload | 共享项目新导入素材到达其它成员 | 过 | 17 |
| P-push-race-shard | 素材推送竞态(分片布局 30 轮) | 过 | 12 |
| P-push-race-flat | 素材推送竞态(平铺布局 30 轮) | 过 | 41 |
| S1-1 | 声音探针完整版(真实浏览器) | 过 | 18 |
| S1-2 | 声音探针完整版 --av(导出 MP4 与音轨量测) | 过 | 14 |
| S1-3 | 声音探针便携版 --node-only --av | 过 | 4 |
| S1-4 | 声音预览(桌面、在线、重开、在线合成) | 过 | 117 |
| S1-5 | 声音 A、B:导出自动生成与在线合成(桌面、在线普通档、低内存档) | 过 | 48 |
| S1-6 | 声音样本导出(提示音、键盘声、有声动效卡各一段 MP4) | 过 | 20 |
| S1-7 | 打字动画卡改前改后逐帧比对(核心项) | 过 | 104 |
| S2-1 | 安全验收:越权探测卡读不到凭证与票据、带不走数据(核心项) | 过 | 184 |
| S2-2 | 功能验收:五张卡(用户画面卡、有声卡、相对导入、视频输入源图卡、音频图卡) | 过 | 40 |
| S2-3 | 图卡在线执行(GPU 执行、素材取帧、图形能力不够的退回) | 过 | 14 |
| S2-4 | 声音线程:在线执行用户卡、图卡的 audio() | 过 | 11 |
| S2-5 | 纯浏览器节点认领用户卡与图卡任务 | 过 | 29 |
| S2-6 | 有声动效卡的成本身份与轻重判定(判轻、测量不出声) | 过 | 15 |
| S2-7 | 不含声音的项目导出与 main 的成片一致(核心项) | 过 | 25 |
| S2-8 | 隔离可行性探针(WebRTC 缺口、构造器加固回归) | 过 | 128 |
| S2-9 | 第二段新增的单测与守门(在线卡运行时、舞台策略头、nginx 模板) | 过 | 1 |
| S3-1 | 渲染服务本机整套演练(接活、迟到成员、Agent 补渲、越权被拒、开关、杀进程、上限、负载、删项目) | 过 | 624 |
| S3-2 | 项目设置里「托管方的渲染节点」开关与成员列表一行(界面) | 过 | 23 |
| S3-3 | 第三段的单测(身份、权限、容量、隔离、进程、部署模板) | 过 | 5 |
| S4-1 | 云端 Agent 隔离(文档服务与素材服务一侧,假 Agent 服务) | 过 | 3 |
| S4-2 | 云端 Agent 隔离(整条链,真的 Agent 服务进程) | 过 | 90 |
| S4-3 | 云端 Agent 一轮的生命周期(断流不停、按 seq 补发、进程被杀、额度、发起方不在线) | 过 | 9 |
| S4-4 | 云端 AI 栏(在线宽屏、桌面云端项目、手机占位) | 过 | 295 |
| S4-5 | 关掉软件照常运转(无界面版,真的结束发起方进程) | 过 | 325 |
| S4-6 | 关掉软件照常运转(带界面版:桌面发起、在线发起、另一位成员看画面) | 过 | 794 |
| S4-7 | 第四段的单测(服务、鉴权、运行、补渲、接线守门) | 过 | 16 |

### 探针量的耗时

| 编号 | 量的是什么 | 数值 | 原来的门槛(已不作通过条件) |
|---|---|---|---|
| GR-6 | 等到:编辑器进程起来 | 1040 ms |  |
| GR-6 | 等到:预渲染进程就绪 | 1523 ms |  |
| GR-6 | 等到:预渲染进程手里有这一版项目 | 323 ms |  |
| GR-6 | 等到:SSE 连上并收到第一条 | 310 ms |  |
| GR-6 | 等到:收到 done(锚帧全部就绪) | 2794 ms |  |
| GR-6 | 等到:wanted 让某一批插队 | 32160 ms |  |
| GR-6 | 等到:某一层的区间长过锚帧 | 501 ms |  |
| GR-6 | 等到:预渲染进程自动拉起来 | 2640 ms |  |
| GR-6 | 等到:重启后的 SSE 收到第一条 | 310 ms |  |
| GR-6 | 等到:索引按键重建、重新发出 layer(没有人发 preload) | 1541 ms |  |
| GR-6 | 等到:⑨ 预渲染进程地址 | 2 ms |  |
| GR-6 | 等到:预渲染进程读得到这几条成本记录 | 14 ms |  |
| GR-6 | 等到:第二版的 SSE 连上 | 310 ms |  |
| GR-6 | 等到:预渲染进程手里有第二版 | 16 ms |  |
| GR-6 | 等到:按新 costs 重算出的预渲染集合 | 13 ms |  |
| GR-6 | 等到:第二版里判重的卡开始就绪 | 0 ms |  |
| GR-6 | 等到:预渲染进程手里有第三版 | 339 ms |  |
| GR-6 | 等到:删掉之后又跑了一趟(索引重新发了层) | 309 ms |  |
| GR-7 | 全部分段满密度(从 preload 起) | 18068 ms |  |
| GR-7 | clip-bg 15 帧分段编码 p50 | 149 ms | 1080p 全幅流 ≤ 300 ms |
| GR-7 | clip-bg 15 帧出帧 | 571 ms |  |
| GR-7 | clip-pill 15 帧分段编码 p50 | 26 ms |  |
| GR-7 | clip-pill 15 帧出帧 | 190 ms |  |
| GR-7 | G6 替换后旧分段文件删掉 | 0 ms | 固定等 6 秒后看盘(设计值 5 秒内删) |
| GR-8 | 全部分段满密度(从 preload 起) | 14559 ms |  |
| GR-9 | 起播:每拍主线程耗时 p90(CDP TaskDuration) | 13.974 ms |  |
| GR-9 | 起播:舞台一拍干活时长 p90 | 3.3 ms |  |
| GR-9 | 跳转:每拍主线程耗时 p90(CDP TaskDuration) | 9.773 ms |  |
| GR-9 | 跳转:舞台一拍干活时长 p90 | 2.4 ms |  |
| GR-9 | 超过6路流:每拍主线程耗时 p90(CDP TaskDuration) | 35.8 ms |  |
| GR-9 | 超过6路流:舞台一拍干活时长 p90 | 11.3 ms |  |
| GR-9 | 编辑后:每拍主线程耗时 p90(CDP TaskDuration) | 16.917 ms |  |
| GR-9 | 编辑后:舞台一拍干活时长 p90 | 4 ms |  |
| GR-10 | 起播:每拍主线程耗时 p90(CDP TaskDuration) | 12.992 ms |  |
| GR-10 | 起播:舞台一拍干活时长 p90 | 2.9 ms |  |
| GR-10 | 跳转:每拍主线程耗时 p90(CDP TaskDuration) | 9.218 ms |  |
| GR-10 | 跳转:舞台一拍干活时长 p90 | 2.4 ms |  |
| GR-10 | 超过6路流:每拍主线程耗时 p90(CDP TaskDuration) | 35.717 ms |  |
| GR-10 | 超过6路流:舞台一拍干活时长 p90 | 10.6 ms |  |
| GR-10 | 编辑后:每拍主线程耗时 p90(CDP TaskDuration) | 14.451 ms |  |
| GR-10 | 编辑后:舞台一拍干活时长 p90 | 4.2 ms |  |
| P-c10-browser-a4 | 创建者建项目、放云端 | 76580 ms |  |
| P-c10-browser-a4 | 成员加入到两个舞台就绪 | 46254 ms |  |
| P-c10-browser-a4 | A1 播放 10 秒这一步 | 21675 ms |  |
| P-c10-browser-a4 | A4 定位到换上精确帧 | 6911 ms |  |
| P-c10-browser-a4 | 整支探针 | 124900 ms |  |
| P-c10-browser-full | 创建者建项目、放云端 | 74889 ms |  |
| P-c10-browser-full | 成员加入到两个舞台就绪 | 46302 ms |  |
| P-c10-browser-full | A1 播放 10 秒这一步 | 21738 ms |  |
| P-c10-browser-full | A2 关掉再开 | 21439 ms |  |
| P-c10-browser-full | A5 独立渲染主机一步 | 924389 ms |  |
| P-c10-browser-full | A4 定位到换上精确帧 | 6966 ms |  |
| P-c10-browser-full | 整支探针 | 1068987 ms |  |
| P-c10-user-card | 创建者建项目、放云端 | 70687 ms |  |
| P-c10-user-card | 成员加入到两个舞台就绪 | 47345 ms |  |
| P-c10-user-card | A1 播放 10 秒这一步 | 22313 ms |  |
| P-c10-user-card | 用户卡一步 | 276 ms |  |
| P-c10-user-card | A4 定位到换上精确帧 | 7276 ms |  |
| P-c10-user-card | 整支探针 | 120179 ms |  |
| P-online-user-cards | 乙 u 测完到最后一拍还停在快照 | 0 ms | ≤ 3 秒 |
| P-online-stage-watch | W2 弄崩 B 到页面重载它 | 19352 ms | 等待上限 60 秒(断开判定 15 秒 + 心跳 5 秒) |
| P-online-stage-watch | W2 弄崩 B 到重新握手 | 19862 ms | 等待上限 60 秒 |
| P-online-stage-watch | W3 弄崩 A 到退回单舞台 | 34797 ms | 等待上限 120 秒(断开判定 15 秒 + 心跳 5 秒 + 重载时限 20 秒) |
| P-online-stage-watch | W3 弄崩 A 到单舞台画回片段 | 34798 ms | 等待上限 60 秒 |
| P-online-stage-handshake | S1 挂上到进过渡期并画出片段 | 20287 ms | 固定在挂上 25 秒时看 |
| P-online-stage-handshake | S1 挂上到第一次画出 | 20111 ms | ≤ 24 秒 |
| P-online-stage-handshake | S1 挂上到两台都握上手 | 80571 ms |  |
| P-online-stage-handshake | S1 握上手到换回双舞台 | 3 ms | 等待上限 30 秒 |
| P-online-stage-handshake | S1 出画面之后可见舞台最长空白 | 115 ms |  |
| P-online-stage-handshake | S4 挂上到进过渡期并画出片段 | 20320 ms | 固定在挂上 25 秒时看 |
| P-online-stage-handshake | S4 挂上到第一次画出 | 20113 ms | ≤ 24 秒 |
| P-online-stage-handshake | S4 挂上到两台都握上手 | 40509 ms |  |
| P-online-stage-handshake | S4 握上手到换回双舞台 | 2 ms | 等待上限 30 秒 |
| P-online-stage-handshake | S4 出画面之后可见舞台最长空白 | 115 ms |  |
| P-online-stage-handshake | S2 挂上到退回单舞台 | 20312 ms | 19～30 秒(上界不再作通过条件) |
| P-online-stage-handshake | S2 挂上到单舞台画出片段 | 20313 ms | 等待上限 60 秒 |
| P-online-stage-handshake | S3 挂上到退回单舞台 | 20335 ms | 19～35 秒(上界不再作通过条件) |
| P-online-stage-handshake | S3 挂上到单舞台画出片段 | 20336 ms | 等待上限 60 秒 |
| P-m7-browser | M7-A10 加卡到 w1、w2 都切出细任务 | 9197 ms | 等待上限 90 秒 |
| P-m7-browser | M7-A10 加卡到两张卡各做完一段 | 27328 ms | 等待上限 180 秒 |
| P-m7-browser | M7-A4 遮罩撤下到最慢的锚帧段做完 | 20869 ms | ≤ 30 秒 |
| P-m7-browser | M7-A5 拖动结束到恢复认领 | 627 ms | 等待上限 30 秒 |
| P-m7-browser | M7-A10 抢卡判完到 z1 那一层换到 pc 环境 | 1 ms | 等待上限 240 秒 |
| P-tier-switch | T5a complete 翻真到页面轮询看到素材原尺寸 | 1807 ms | ≤ 2600 ms(轮询 2 s + 余量) |
| P-tier-switch | T5a 素材原尺寸到齐到换到素材原尺寸(暂停中) | 2028 ms | 等待上限 20 秒 |
| P-tier-switch | T5b 素材原尺寸到齐到换到素材原尺寸(播放中) | 4069 ms | 等待上限 15 秒 |
| P-tier-switch | T5c 素材原尺寸报齐到换到素材原尺寸 | 16339 ms | 等待上限 46 秒 |
| P-tier-switch | T5e 素材原尺寸报齐到换到素材原尺寸 | 1603 ms | 等待上限 20 秒 |
| P-custom-measure | M4 死循环脚本从调用到被终止 | 2192 ms | < 17 秒(脚本时限 2 秒 + 15 秒余量) |
| P-storage-ui | U8 打开开始页到占用数字变成真实值 | 4316 ms | < 20 秒 |
| S1-4 | desktop:P2 暂停到所有声音元素停下、能量落到阈值以下 | 50.8 ms | ≤ 300 ms |
| S1-4 | online:P2 暂停到所有声音元素停下、能量落到阈值以下 | 40.2 ms | ≤ 300 ms |
| S1-4 | online-live:P2 暂停到所有声音元素停下、能量落到阈值以下 | 48.4 ms | ≤ 300 ms |
| S2-2 | E8 写进新源码到舞台里的画面换成新版 | 2125 ms | ≤ 10 秒 |
| S2-4 | S6 死循环的声音代码从求这一块到被掐断 | 1016 ms | 950 ms ～ 8 秒(上界不再作通过条件) |
| S3-1 | work 新建项目到渲染服务连进来 | 1587 ms | ≤ 5 秒 |
| S3-1 | agent 声明有活到渲染服务连回来 | 1970 ms | ≤ 5 秒 |
| S3-1 | switch 关开关到渲染服务断开 | 940 ms | ≤ 5 秒 |
| S3-1 | load 空闲时文档服务 /healthz 往返 p50 | 16 ms |  |
| S3-1 | load 空闲时文档服务 /healthz 往返 p95 | 16.5 ms |  |
| S3-1 | load 渲染进行时文档服务 /healthz 往返 p50 | 16 ms |  |
| S3-1 | load 渲染进行时文档服务 /healthz 往返 p95 | 16.6 ms | < 500 ms(背压线) |
| S3-1 | load 这一批任务渲完 | 119999 ms |  |
| S3-1 | delete 删项目到渲染服务断开 | 837 ms | ≤ 5 秒 |
| S3-1 | work 单任务耗时(含冷启动) | 10278 ms |  |
| S4-2 | 撤销(disabled)到进行中的对话停下 | 16 ms | ≤ 2 秒 |
| S4-2 | 撤销(removed)到进行中的对话停下 | 16 ms | ≤ 2 秒 |
| S4-2 | 撤销(kicked)到进行中的对话停下 | 19 ms | ≤ 2 秒 |
| S4-2 | 撤销(deleted)到进行中的对话停下 | 17 ms | ≤ 2 秒 |
| S4-3 | E1 发起方不在线时读选区的工具回话 | 1 ms | < 500 ms |
| S4-4 | O2 点「停止」到这一轮停下 | 77 ms | < 5 秒 |
| S4-4 | O7 一轮结束到 dave 那一行的云端 Agent 标记消失 | 11 ms | < 20 秒 |
| S4-4 | D6 一轮结束到自己那一行的云端 Agent 标记消失 | 30 ms | < 25 秒 |
| S4-5 | U9 另一台设备停掉对话到收尾 | 4 ms | ≤ 2 秒 |
| S4-5 | U16 满载时文档服务 /healthz 往返 p95 | 16.5 ms | < 500 ms |
| S4-5 | U16 满载时打开项目 p95 | 0.4 ms | < 1000 ms |
| S4-5 | U16 空闲时文档服务 /healthz 往返 p95 | 16.6 ms |  |
| S4-5 | U16 满载时素材下载最慢一次 | 324 MiB/s | ≥ max(5, 空闲中位数 × 0.2) |
| S4-5 | U16 空闲时素材下载中位数 | 358 MiB/s |  |
| S4-5 | acceptedMs | 4453 ms |  |
| S4-5 | runMs | 16543 ms |  |
| S4-5 | renderedMs | 57533 ms |  |
| S4-5 | usercardRenderedMs | 22081 ms |  |
| S4-6 | S 点「停止」到这一轮停下 | 78 ms | < 5 秒 |
| S4-6 | D.acceptedMs | 5233 ms |  |
| S4-6 | D.membersGoneAfterMs | 60079 ms |  |
| S4-6 | D.runMs | 36667 ms |  |
| S4-6 | D.renderedMs | 85372 ms |  |
| S4-6 | O.acceptedMs | 2952 ms |  |
| S4-6 | O.membersGoneAfterMs | 60259 ms |  |
| S4-6 | O.runMs | 37738 ms |  |
| S4-6 | O.renderedMs | 56206 ms |  |
| S4-6 | usercardRenderedMs | 39251 ms |  |
