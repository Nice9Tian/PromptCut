# 协作重开：笔记本与双机验收补充

本补充保留每次实际来源、失败和诊断。完整恢复报告见 [REPORT-collaboration-reopen-recovery.md](REPORT-collaboration-reopen-recovery.md)。当前仍未满足所有合入条件，没有合并 main、推进 release、发版或覆盖用户运行副本。旧版通过结果不会标成新源码复跑。

## 已完成的正式验收

这些结果来自固定提交 `20d28fbda9f57e495becfb7f70deb8a610aab77f`，两台物理设备的专用 worktree；没有改判据。

| 项 | 实际命令与结果 | 证据 |
|---|---|---|
| 笔记本普通流 | `node --import=./scripts/lib/test-silent-processes.mjs work/run-laptop-stream.mjs --timing-authoritative --port 5203`；runner 和 probe 均退出 0，fails/跳过为空。1080p 15 帧编码三值 `[237,248,273]` ms，p50 248 ≤ 300 ms；最大分段 442,742 B ≤ 512 KiB；两层 alpha.mean 0.0956/0.069 ≤ 0.5；F5 三流恢复、重产出 0 段。三值由原脚本排序，未保存执行顺序。 | [laptop-stream.json](assets/collaboration-reopen-recovery/laptop-stream.json) |
| 真实双机 M7/W7 | PC creator：`node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-m7.mjs --role creator --config work/w7-device-handoff/task-config.json --base-port 5450`；笔记本 node 同 runner，`--role node --timing-authoritative --base-port 5590`。creator 汇总实际退出 0，17 项/59 parts 全过，fails/pending 为空；笔记本实际执行 26 parts 全过。A4 最大加载 25,530 ≤ 30,000 ms，A5 拖动期间认领/帧/L2 增长均 0，闲置 ≥500 ms 后恢复实测 712 ms，播放及预渲染主文档 longtask 0。 | [laptop-w7.json](assets/collaboration-reopen-recovery/laptop-w7.json) |

W7 的 node 角色**实际退出 3**，五个 creator 专属空项（M7-A8、W7、D9、D14、D1-D2-D12）被现有全项 summary 写成 pending。creator 合并其已执行 parts，再实际执行全部服务端项目，完整汇总为 0。本补充没有改写 node 退出码，也没有将五个空项认作 node 通过；最初派工要求两个角色都退出 0 与现有脚本契约不一致，已根据实际源码更正。A5 的 500 ms 是恢复前必须闲置的下限，不是完成恢复的上限。

实际回传 ZIP 已在 PC 校验并安全解压。普通流 5,282 B，SHA-256 `29b92bba221be9bbc615bd1801dc2a8cb66dd72f97de11655056bed7905d308c`；W7 node 9,019 B，SHA-256 `6a4518af96a3a487a7bcde8b8679938ca5ce1b5b60a436d83cfb502670d8a4b4`。JSON 保留完整原结果及回执；原始日志仍在两端测试目录，仓库记录其 SHA。设备名、地址和本机路径已脱敏，原 ZIP 不入库。

## C6.6 首轮失败与只读诊断

首轮 run `c66w1mutlujmg` 使用同一固定 20d28fb 源码：PC creator；笔记本 observer 与 host。各角色命令为固定 runner `work/run-cross-device-c66.mjs --role <角色> --config work/c66-device-handoff/task-config.json --wave 1 --port <隔离端口>`，外层预加载静默辅助；observer 使用笔记本权威计时。原正式脚本 SHA-256 `47138c1036b9bb05294fdc5d2d383bf77e83890bdb23edc7e6a931fd5e98fe9a`。

| 角色 | 真实结果 |
|---|---|
| observer | probe/runner 均 1；装卡 472 ms、HMR 1,989 ms、新版成本可见 **6,187 ms > 5,000 ms**，唯一失败 `remeasure-over-5s(6187)`。小尺寸先显示帧 75/宽 800，再原尺寸帧 75/宽 1920；覆盖换档的 1,866 次采样黑帧 0。 |
| host | probe/runner 均 0；其认领/完成 2/2，全房间 8 任务恰一 8、清单 8、素材块 480 完整，改卡同步 5 ms，fails 为空。 |
| creator | probe/runner 均 1；准确接收 observer 失败；专用房间实际删除成功。 |

完整结果见 [laptop-c66-first-failure.json](assets/collaboration-reopen-recovery/laptop-c66-first-failure.json)。共享 ZIP 637,590 B，SHA-256 `3b5a0d8cb7f7a5533326881ce4cabfb46d4b15c7d4af000021c1fd6e22f13910`。一份测试浏览器日志还记录 GPU 进程异常退出，尚无证据证明与本次超时存在因果关系。已查看 v2 探针截图，确认编辑器与两条轨道画面；程序断言核验 v2 字符串，不能将视频覆盖下的文字说成截图直接可见。

只读诊断 run `c66diag10041831` 仅复制原脚本、调整复制路径并增加 cards/probe 时间线观察；原断言和阈值未变，产品源码未改。PC creator 退出 0、139,814 ms；笔记本 observer/host 退出 0。observer 装卡 319 ms、HMR 991 ms、成本可见 1,985 ms，测量最后完成的观察点 1,818 ms。诊断时间线实际观察到同一个新版 identity 启动两次（753 ms、1,347 ms），三次 cards-updated 在 516/780/1,002 ms，stage stale 始终为空。故没有支持“4 秒舞台 stale 超时”的证据。

诊断完整结果见 [laptop-c66-diagnostic.json](assets/collaboration-reopen-recovery/laptop-c66-diagnostic.json)。实际回传 ZIP 7,328 B，SHA-256 `5c8d45a8ade6d04bd94da914413b14a1b421334c447288fb1669e399805fd063`。它只用于取证，**不抵消首轮失败，也不计正式第二轮通过**。

## 修复与回归证据

新提交 `113b425c3053f6e9867499f9d305aad975d5846b` 修改 `src/editor/probeRunner.ts`，增加实际执行该模块的 `src/editor/probeRequeue.test.mjs`。同一个项目、同一组卡身份/能力且测量环境和成本后端未变时，重复热更新通知保留正在跑或已完成的工作；真正换版、普通项目对象改变、设备/成本后端变化和失败重试仍重排。帧率变化保留原加载遮罩规则。不新增 UI 阻塞、不改验收阈值或测量口径。

实际专项命令：`node --import=./scripts/lib/test-silent-processes.mjs --experimental-test-module-mocks --test src/editor/probeRequeue.test.mjs`。修复前产品未改，3 例中 1 过/2 失败，552.4107 ms，退出 1；实测重复任务数 2（不是顾问推断的 3）。修复后原 3 例全过；补齐成本后端、舞台设备、RPC 失败重试与 FPS 遮罩，共 7/7、零失败/取消/跳过/todo，1,160.5758 ms，退出 0。

两次先前夹具加载失败分别保留：第一轮把 Uint8Array 用 String 转成数字列表，实际导出不存在；第二轮仅替换注释中的第一个 `import.meta.env.DEV`，代码表达式仍未定义。最终夹具仅在本用例的模块加载钩子里模拟 Vite 编译宏并更正实际导出函数名，没有为测试修改产品编译语句或全局 loader。这些夹具错误不是原 C6.6 超时的原因。

新提交实际 `npx tsc -b --force` 等价 Node 调用退出 0、4,790 ms。`npm test` 等价完整 Node 参数退出 0，4,330/4,330、零失败/取消/跳过/todo，55,678.1462 ms（进程墙钟 55,731 ms）；舞台测试使用隔离服务 5212–5214。桌面独立用例 37/37、退出 0，进程墙钟 883 ms；网页实际 `npm run build` 退出 0、6,762 ms、1,830 模块。完整渲染两遍 1,800 帧相同、0 差异，candidate/main 各 1,800 帧比较 0 不同/缺失，统一帧整条退出 0。全部准确命令、提交和原始日志 SHA 见 [fixed-baselines.json](assets/collaboration-reopen-recovery/fixed-baselines.json)。main 基准保持 `adc3ae2a31857e6edcf868ddc361fbb20e249f88`；没有安装或覆盖运行副本。

### 新提交正式双机结果

原 C6.6 正式探针 SHA 与 5 秒门槛保持不变。命令仍为 `node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-c66-fixed.mjs --role <角色> --config work/c66-fixed-handoff/task-config.json --wave <轮次> --port <隔离端口>`。

| 正式 run / 角色安排 | 实际结果 |
|---|---|
| `c66f11004100005`：PC creator；笔记本 observer 5590（权威计时）和 host 5593 | 三角色 probe/runner 均退出 0、fails 为空。observer 装卡 298 ms、HMR 801 ms、重测 1,723 ms、舞台 1,725 ms；换档帧 75→75、865 个采样黑帧 0、覆盖换档。host 新版同步 12 ms，任务 8/8 恰一、清单 8、素材块 480 无缺失。creator 108,875 ms，专用房间删除通过。 |
| `c66f21004100005`：笔记本 creator；PC observer 5203 和 host 5206 | **失败**。creator 与 observer probe/runner 均退出 1；host 均 0。observer 小尺寸 800 宽与原尺寸 1920 宽均读出帧 75，但采样总数 0，等待足数与覆盖换档失败；不能将空样本的 black:0 认作无黑帧。重测 1,271 ms 是 PC 值，不替代首轮笔记本权威计时。host 5/5、全房间 8/8 恰一、480 块无缺失。 |

完整正式结果与双方回执见 [laptop-c66-fixed.json](assets/collaboration-reopen-recovery/laptop-c66-fixed.json)。第一轮实际回传 ZIP 6,645 B，SHA `dd058fb8c9f7e6e53af1dfd14d21079c831e471c7c688fc47ae141fb3cd92fca`；第二轮 5,767 B，SHA `3b0e05957ef5c54945819fa1140432c492872734859b842bcc4733ec790c8f4d`。两轮属于独立新房间，失败历史没有覆盖。

第二轮时间线为 `none@492 → small@2293 → none@6231 → small@7328 → original@11027` ms；最终上下文媒体日志为空，frontId:A。这不能证明此前没有媒体事件。两位独立顾问均提出注入与读取的 frame/上下文不连续假说；A 将 none 直接当 unmount 的说法证据不足，不采纳。两位 `gemini-3.1-pro-high` 实际调用均 0，独立会话 `bd8295ca-b944-458f-ab4e-64774b42ef79`（42.5007162 秒、23,776 tokens）和 `d24e8835-3e32-4234-bb8d-fe0782846a42`（41.290802 秒、23,272 tokens）；主任务完整阅读两个回答和 metadata，完整原文/流保留 `work/agy/c66-wave2/`。

随后实际运行 `c66frame10041950` 只读诊断：PC observer 命令 `node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-c66-frame.mjs --role observer --config work/c66-frame-handoff/task-config.json --wave 2 --port 5203 --diagnostic`；PC host 同 wrapper 用 `--role host --port 5206`、不加 diagnostic，笔记本 creator 仍用正式 fixed wrapper。observer 退出 1、177,338 ms，host 退出 0、172,875 ms，creator 退出 1。97 次状态记录实证：4,569 ms 时原 A 上 sampler 已推进到 312 个样本；5,777/5,781 ms 两台 iframe 导航，timeOrigin 从 A `1791112199153.6` / B `1791112199154.6` 变为 `1791112205729` / `1791112205729.4`，新上下文没有原采样数组，最终读回 n:0。导航时加载遮罩已经消失、blocking:false；不能简单延后至遮罩消失来解决。该事实证伪“初始 rAF 完全没推进”，但重载的发起者尚未证明；不将一次导航直接断言为用户看到黑帧。

完整只读证据见 [laptop-c66-frame-diagnostic.json](assets/collaboration-reopen-recovery/laptop-c66-frame-diagnostic.json)，正式判据未改，诊断不计正式通过。原采样 nonce 只是 performance.timeOrigin 的字符串，公开字段改名 samplerOrigin，原结果 SHA 保留。笔记本 ZIP 8,409 B，SHA `f09cd8ed0a1e7038ac74dbc813e336afc7eab8261f0f742b491e379e34c67bce`，实际校验安全解压。

两位顾问同会话 r2 复盘实际 CLI 均退出 0，本轮外层耗时 A 27.1972057 s、B 26.9244133 s；metadata 的约 2,780 秒是累计会话字段，不能当本轮耗时。主任务全文阅读两份 r2 回答及 metadata。两者偏向 stageCards 的四秒过期等待，但目前只是待取证假说；A 声称 iframe.src 是唯一重载机制及版本严格相等的说法不符合全部代码，B 建议测量中一律不重载可能隐藏真正过期状态，都未实施。下一诊断仅加父页 iframe.src 调用来源、舞台报到 stamp、stale/watch 状态及 Vite 消息记录，先区别过期重载、心跳故障与 Vite 重载。

普通流新提交正式复跑：`node --import=./scripts/lib/test-silent-processes.mjs work/run-laptop-stream-fixed.mjs --timing-authoritative --port 5203`；probe/runner 0、fails/pending 为空、dev server 重启 0。1080p 编码 `[264,294,307]` ms，p50 **294 ≤300**；两层 alpha.mean 0.0956/0.069、最大分段 442,742 B；三流恢复，重启后产出 0。结果见 [laptop-stream-fixed.json](assets/collaboration-reopen-recovery/laptop-stream-fixed.json)。实际 ZIP 4,483 B，SHA `e3400e40666979e4a05c22c29dd1f5702d69163f37416df7a54745c1f7446bba`。旧来源20的普通流结果也保留。

W7 新提交正式复跑已通过：run `m7rfix10041021`，PC creator 5460–5469、笔记本 node 5590–5599。准确命令 `node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-m7-fixed.mjs --role creator --config work/w7-fixed-handoff/task-config.json --base-port 5460`；笔记本同 runner 使用 `--role node --timing-authoritative --base-port 5590` 和对应私有配置。creator 实际退出 0，17 项/59 parts 全过，fails/pending 为空；笔记本实际退出 3，26 个已执行 parts 全过，五个 creator 专属空项仍记 pending，与上一版本的原脚本契约一致。笔记本 A4 最慢 22,945 ≤30,000 ms；A5 前 500 ms 认领 0、实测 638 ms 恢复；播放及预渲染主文档 longtask 均 0。creator 于 10:32:49.530–10:46:51.968 UTC 执行，node 于 10:33:30.831–10:46:52.713 UTC 执行。完整逐项结果见 [laptop-w7-fixed.json](assets/collaboration-reopen-recovery/laptop-w7-fixed.json)。ZIP 实际 8,210 B，SHA `1ab16ee720b2850fa54763723cc268cd0b8a796cdb69439e114f86559cbe6b80`，已校验安全解压；两侧 tracked 保持干净，笔记本已释放测试端口。

C10 新 work helper 首次 PC prepare 退出 1（对异步浏览器路径调用漏 await），仅修 helper 一行后 PC prepare 0；两端修后 helper SHA `ccb25cb652556fbf341c46a8ef23eb908e90659d28a4b52d04f1a4ecf71c65c8`。PC 仅在本次测试子进程使用已经缓存的实际 Chrome headless-shell 150.0.7871.24，笔记本保持 Chrome 152.0.7977.75；未覆盖指纹、安装浏览器或修改全局环境。

正式 run `c10fix10041021`：PC 实际命令在本测试子进程设置 PUPPETEER_EXECUTABLE_PATH 为已缓存 Chrome150，然后 `node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-c10.mjs --role host --config work/c10-device-handoff/task-config.json`；笔记本同 wrapper 用 creator。PC host 退出 0、642,214 ms，真实指纹 `de57ec1a7cffba6b` 与笔记本 `258acaaa7c5fe509` 不同。反向指纹九条检查全过：Y 认领正确层、X 在线但零认领、14 个 live 任务全部完成且恰一、四个纯层/28 次观察无混层等；X 是原协议 claimer，不扩大成独立 X 渲染主机。

**C10 总体验收失败**：笔记本 creator 退出 1、604,725 ms、pending:[]；两条失败信息同属“跳到卡中间再播，在 t∈[3,3.5) 找到该卡计划”未命中。原 0→10 秒自然播放 startFrame:0/lastFrame:299、breaks:0，自然进入跳过该夹具轻卡的断言通过；chapter-bar 夹具 catchup-b（step 3.5 ms、catchUp 352.7 ms、vtOk:false）。失败结果的 lastPlan/playRun/naturalSkips:null 是 selector 未返回时构造的值，不能推断实际内部字段为空。暂停 seek 到精确完成耗时 7,089 ms，为什么再播放窗口未命中仍待只读时间线。正式脚本 SHA `f40b58a3070bf9340d64976dcc0b9b53d4bb96a48ba55f2c5b33924ebeee5eac` 未改。结果见 [laptop-c10-fixed.json](assets/collaboration-reopen-recovery/laptop-c10-fixed.json)。实际 ZIP 7,000 B，SHA `a0f72224813cb9fadcc2f019858c1d16733c0dade59caa8cca9844b4d1ddba05`；房间已删除、测试端口释放，两端 tracked 干净。后续 `--only-a4` 诊断保留全部原断言，只读记录 seek 前后及每次 selector poll，不替代正式全项通过。

### 解法与顾问调用记录

尺子：原 C6.6 observer 新身份重测 ≤5,000 ms；回归测试重复同身份只启动一个工作。原始 6,187 ms 超时的完整根因仍未确定，已单独证明并修复的重复重排不能冒充唯一原因。

| # | 层 | 候选与机制 | 验证与状态 |
|---|---|---|---|
| 1 | 三级 | 测舞台 stale、reload 时间线，区分 4 秒等待假说 | 诊断 stale 全空；当前证据不支持这一解释，不改舞台超时。 |
| 2 | 三级 | 对同一实际身份及环境的通知幂等，避免 generation 无意义递增 | 实际红测 1/3→绿测 7/7；正式双机第一组笔记本权威重测 1,723 ms，通过；反向一组采样 0 仍失败，不抵消。 |
| 3 | 三级 | 测 GPU 异常与长任务/资源争用，必要时依据原始时间线定位剩余耗时 | 开放；没有把 GPU 退出认作已确定根因。 |
| 4 | 二级 | 放宽 5 秒门槛或改计时口径 | 锁住；未实施，无必要用户语义决定。 |

使用 with-agy 失败复盘，一名 Terra medium manager 管两名独立 `gemini-3.1-pro-high`。A 审查重排机制；B 审查夹具，首轮提出 Windows URL 失配/全局 loader 建议，主任务用实际 replaceAll 红测证伪，B 同会话补证后撤回该建议。A 关于失败不应重试的意见未采纳；RPC 是可能的暂时故障，修复保留重试并实际测试。主任务全文阅读三个公开回答，模型意见未代替实验。

顾问工具启动历史也保留：两边 attempt1 因 Windows 超长参数未启动模型（包装器记录 NO_RESULT/0，不计成功）；attempt2 因 BOM 输入失败/1；attempt3/4 因 stdin 消息结构失败/1、0 tokens、空回答；attempt5 两个真实会话成功/0，B 的一轮同会话补证成功/0。包装器仅写本任务 work/、隐藏后代窗口，不改技能全局文件或共享权限。A/B 首轮互相独立；三份完整公开回答、metadata 和每次 CLI 日志均留于忽略的 `work/agy/c66-remeasure/`，没有向顾问开放原项目读写、运行仓库测试或安装工具。

## 初始化和夹具取证后的提交

提交 `aba4c1f9ce1cc2567fc1f3cc1a43df4e5ccb7140` 只修改两份正式探针。C6.6 打开页面后等待两台舞台实际握手（已有 hostCaps A/B），再进入原成员接入与计时流程；iframe DOM 存在不足以证明 StageView 模块、卡片热更新回调和 RPC 已加载。C10 初始普通 chapter-bar 改在 8–10 秒、typewriter 改在 0–2 秒，目标卡仍在 2–8 秒，主重卡仍覆盖 0–10 秒，额外重卡仍在 0–1 秒；并用舞台实际诊断确认目标在 3 秒判轻后再执行原跳转断言。没有修改性能记录、指纹、5 秒门槛或播放计划 selector。

C6.6 只读 cause、child 和 wire 诊断分别证明：两台舞台的同 src 重载来自 Preview 中等待卡片同步的 4 秒兜底；重载前 child 卡片 registry 仍 known:false/stamp:0/version:0；三条 Vite 连接均收到九次实际更新，独立观察 hot context 的 before/afterUpdate 也执行。wire 诊断虽然退出 0，A 仍两次重载，不算正式修复通过。独立本机启动诊断进一步发现，握手前两台舞台尚没有卡片模块的热更新回调；等实际 StageView 加载后再安装的对照可正常更新并 ACK。没有禁用合法的过期重载，未采用重注 sampler 来掩盖上下文丢失。完整原始结果见 [cause](assets/collaboration-reopen-recovery/laptop-c66-cause-diagnostic.json)、[child](assets/collaboration-reopen-recovery/laptop-c66-child-diagnostic.json)、[wire](assets/collaboration-reopen-recovery/laptop-c66-wire-diagnostic.json)；frame 的失败历史保留。

C10 seek 诊断退出 1：3.033 秒有实际计划但缺目标卡，目标到 6 秒才出现，帧 90→241 连续。plan 只读诊断退出 0，在 3.133 秒实际命中目标；这次诊断提前结束，没有测到 6 秒，不能抵消正式失败。使用失败运行的实测标量做纯函数重放：目标/普通 chapter/typewriter 权重约 10/8.5/3.5，预算 23.333 ms；原叠放下目标在 3 秒判重、6 秒判轻，移开同时叠放后 3 秒判轻。这是夹具候选的依据，不是唯一根因或浏览器验收。完整结果见 [seek](assets/collaboration-reopen-recovery/laptop-c10-seek-diagnostic.json) 和 [plan](assets/collaboration-reopen-recovery/laptop-c10-plan-diagnostic.json)。

| 卡点 / 行 | 层 | 候选与机制 | g | h | f | 状态与实际证据 |
|---|---|---|---|---|---|---|
| 舞台上下文丢失 / 1 | 三级 | 记录 src setter 调用栈、子 registry 和实际 Vite 消息，区分同步兜底与心跳或 Vite 全页重载 | 2 | 2 | 4 | 已试·取证：cause/child 正式断言仍失败；wire 只读诊断过，仍观察 A 重载，未算正式通过 |
| 舞台上下文丢失 / 2 | 三级 | 承接第 1 行取证，初始化等双舞台真实握手，再安装测试卡；不扩大受验 5 秒 | 3 | 1 | 4 | 已试·过：aba两方向正式三角色均0，权威重测2140ms，1249/1062采样覆盖换档且黑帧0；旧失败保留 |
| 舞台上下文丢失 / 3 | 三级 | 导航后重新注 sampler 或只等遮罩消失 | — | — | — | 关闭·剪：首批 312 样本实际存在后被导航清空；遮罩已消失仍导航，重注可能掩盖可见中断 |
| 舞台上下文丢失 / 4 | 二级 | 放宽重测或采样门槛，测量时禁用同步重载 | — | — | — | 关闭·剪：没有必要语义依据；合法过期恢复继续保留 |
| 跳转未命中目标 / 1 | 三级 | 只读记录 seek、每次 selector poll、重层集合与实测成本 | 2 | 2 | 4 | 已试·取证：seek 失败且目标到 6 秒才出现；plan 诊断过，两次来源和历史分别保留 |
| 跳转未命中目标 / 2 | 三级 | 承接第 1 行取证，减少 3 秒轻卡相互竞争，并真实确认目标 light 前提；保留前 1 秒高压与 10 秒重卡 | 3 | 1 | 4 | 已试·过：aba正式全项真实双机两角色0，3秒实际light、3.033秒估时判断、9条E6全过；旧失败保留 |
| 跳转未命中目标 / 3 | 三级 | 固定写入成本、虚构 199.6 ms 上限、修改重轻阈值或 selector | — | — | — | 关闭·剪：199.6 只是某次实测，非语义上限；不覆写真实性能记录或断言 |

这里 g 为已付和要付的代价，子候选累加父候选；h 为按上述正式失败尺子估计的剩余缺口；两者按 1–5 档估计，f=g+h。第二行均承接第一行的取证成本；没有用失败次数或耗时关闭候选。两位独立顾问 A/B 对 C10 夹具作两轮复盘，实际 CLI 四次均退出 0。A 首轮关于固定速率系数及唯一过载原因、B 建议 199.6 ms 硬界限均由主任务核验后拒绝，两位在第二轮更正；两者同意必须用实际舞台判轻前提和正式全项验证。B 提醒移至 8–10 秒可能影响 A5/E6，故本轮保留这些断言并完整重跑。主任务全文阅读四份回答及 metadata；r2 metadata 的累计会话时间未当成单轮时间。完整回答留在忽略目录 work/agy/c10-seek-fixture/，会话为 `2b6f5627-3c2d-4e66-acb4-900c3eabfc0e` 与 `4e474a6d-9ad7-459a-91f0-d6284475b323`。

当前 aba 源码已实际复跑：类型 0/5,023 ms；根全量 **4,330/4,330**、失败/取消/跳过/todo 全 0，55,377.0695 ms（墙钟 55,428 ms）；桌面 **37/37**、失败/取消/跳过/todo 全 0，847.1371 ms（墙钟 885 ms）；提交后实际 npm run build 0/6,290 ms、1,830 模块。准确 Node 参数、原日志摘要见 [aba-baselines.json](assets/collaboration-reopen-recovery/aba-baselines.json)。113 的全长渲染结果保留原来源，没有改标成 aba 重跑。

前面 113 双机的共同托管/协调服务实际于 20d28fb 源码启动，并于 12:14:57.449 UTC 自动关闭；不能因为编辑器切至 113 就说服务进程也是 113。两版本间只变 editor 测量重排逻辑，但来源仍分别登记。新 aba 服务实际校验 HEAD、tracked clean 后启动，使用全新隔离服务目录。服务 helper 初次缺创建 dataDir 退出 1，补目录后重新启动成功；这个工作辅助错误没有改产品或计为验收通过。

### aba 正式 C6.6 两方向结果

两轮均使用 `node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-c66-aba.mjs --role <角色> --config work/aba-handoff/task-config.json --wave <轮次> --port <隔离端口>`，不是只读诊断。共同托管和协调服务、三角色编辑器都来自 aba4c1f9，探针 SHA `d92f6116bd71ddae39aac19a3cbfd17240e3eef0e02215bab2b2efc685d5b0d9`，wrapper SHA `dfd1b0a71ac24440658f8ca040fad9f7cd99d0c675c09248cfdfbe3a6a367fb9`。

| run / 角色 | 正式结果 |
|---|---|
| c66aba1-10042225：PC creator5460；笔记本 observer5460、host5463 | 三角色实际退出 0、fails:[]。权威 observer 安装 640 ms、HMR 1311 ms、重测 **2140≤5000 ms**、舞台 2141 ms；小尺寸 800→原尺寸1920 宽保持帧号75，1249 个采样黑帧0并覆盖换档。host 3/3，全房间8/8恰一、清单8、素材块480齐全。creator probe 136377 ms、实际删除成功。 |
| c66aba2-10042225：笔记本 creator5460；PC observer5203、host5206 | 三角色实际退出0、fails:[]。observer 实际采样1062、黑帧0、覆盖换档，小尺寸和原尺寸帧号75；时间线 none@331→small@621→original@6977 ms。PC 重测1342 ms仅作功能参考，不替代笔记本权威结果。observer probe166896 ms、host171893 ms，creator 删除成功。 |

完整角色结果、回执、实际 Node 命令、两侧原始日志 SHA 与服务来源见 [laptop-c66-aba.json](assets/collaboration-reopen-recovery/laptop-c66-aba.json)。波1 ZIP6979 B，SHA `6fbe1f3445909d182a508a9b02191484cfe140a4773c0b0a5088028d38804310`；波2 ZIP5391 B，SHA `17b4bff4c164eaddb218e1cd0d472da5d030555fcad0f2f0d66901b16b37ec7a`，均在 PC 校验并安全解压。正式两方向均通过；旧113反向失败、首轮6187 ms和所有诊断历史仍保留。初始化候选第2行现在记“已试·过”，未用诊断替代正式结果。

本机初始化对照和纯函数预算重放的实际错误、退出码和原始摘要见 [local-initialization-diagnostics.json](assets/collaboration-reopen-recovery/local-initialization-diagnostics.json)。启动无等待的对照在导航后读取 hot client 抛错，仍记实际1；networkidle0导航30秒超时另列，不认作通过。

### aba 正式 C10 全项结果

run c10aba-10042225，源码aba4c1f9，正式probe SHA 2186d0dfe27697b164084c99962bc39a5b73e4a77a11017c69d54fe70c87b9c7；wrapper仍为ccb25cb652556fbf341c46a8ef23eb908e90659d28a4b52d04f1a4ecf71c65c8。笔记本实际命令 node --import=./scripts/lib/test-silent-processes.mjs work/run-cross-device-c10-aba.mjs --role creator --config work/aba-handoff/c10-task-config.json；PC同wrapper --role host，仅本测试子进程选择已缓存实际Chrome150，笔记本保持Chrome152。未覆盖指纹/成本、未only-a4、无诊断副本。

creator/probe与runner均0、468040 ms；PC host均0、497325 ms，fails/pending均空。真实夹具step1.4 ms、catchUp179.5 ms、vtOk:false、catchup-b，3秒实际管线light；原自然播放0→299、breaks0、241次naturalSkips；原seek在3.033秒命中该卡估时判断，reason:rate、ok:false表示估时决定不交换，不是“交换成功”。命中后原探针立即暂停，seekRun90→91不是整段3→8秒播放测试。暂停seek到精确帧实测7099 ms，播放longtask0，A2重开gateAgain:false、refetched0、L2命中4。

9条E6原检查全过：Y认领正确plan；实际指纹不同；X在线但认领0；live9任务全完成，superseded6；原J-exactly-once断言通过（其detail实际total11、stray1也原样保存，不改计数）；3纯层/18次观察無混层，layer-map全部覆盖。PC独立Yhost真实完成4件snapshot，节点claim计数6含plan统计，失败/丢失/释放均0、WS opens1；不把所有claim计数都当已完成快照。X仍是原协议claimer。

房间实际删除、两端端口释放、tracked clean。ZIP6429 B，SHA3194caacc812c32218d29430391906c6af86476b0f97199ef0a2f87304d2e00d，PC校验安全解压。完整原结果、回执、原始SHA见 [laptop-c10-aba.json](assets/collaboration-reopen-recovery/laptop-c10-aba.json)。旧113正式失败和各诊断仍保留；本轮正式全项通过后才将夹具候选记为已试·过。

## 尚未完成

- C6.6 aba 两方向正式重验均已通过，旧失败与诊断仍保留。
- C10 113 的真实独立 Y host 九条反向指纹断言已过，总体验收仍失败。aba轻卡夹具修正后正式全项真实双机已通过；113的W7与普通S已通过。
- 系统默认文件关联真实双击的隔离验证。现有默认 `.proc` 指向用户运行副本；独立原生壳启动参数及单实例转发已经验证，不能替代默认双击。
- 历史偶发凭证损坏提示仍无当时错误来源，后续通过不能证明其成因。
- 类型/全量、必需G0-R及上述正式双机均已通过，但系统默认关联双击仍未测；main合入、release推进、发版构建及安装包覆盖未执行。安装包目标精确路径仍待此前提问的回复。

全部测试使用隔离数据和专用房间，静默规则已进入 Guide，未修改宿主机网络、用户真实项目/账户、运行副本或终止用户进程。生产托管服务的部署需另行审核，本报告没有把临时测试服务通过说成生产已经上线。
