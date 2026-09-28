# M5～M8 旧阶段验收证据补录

2026-09-28，分支 `claude/evidence-audit`（从 main `2fa0c1a` 起），由 PC 主会话派出的子智能体整理。给 `REPORT-M5-M8.md`（分支 `claude/m8-report`）末尾「骨架里发现的缺口」第一部分的 9 处补证据：每处先去归档报告、提交说明、测试文件里找；有现成测试或探针能直接跑出来的，在本分支的 worktree 里补跑一遍。旧阶段报告本身一字未改。

## 读法

- **出处**写文件名加小节，或提交号。子 Agent 报告在 M5 期间没有单独归档，原文只留在 git 历史里，写成 `<提交>:<路径>`，用 `git show <提交>:<路径>` 读。
- **补跑**都在本分支 worktree（`.worktrees/evidence-audit`）里做，机器是 PC（Windows 11，Node v24.19.0）。端口只用 5820～5829 或 0，起的进程跑完都已结束。补跑用的三个小脚本放在 `docs/reports/evidence-M5-M8/`，不在 `npm test` 的范围里：
  - `h4-h8-rerun.test.mjs`：H4 每行 20 次、H8 抓握手；
  - `make-i3-plan.mjs`：把 `docservice-backpressure.test.mjs` 复制一份，只把门槛改成计划口径，断言一条不删；
  - `px-compare.mjs`：两个导出目录逐像素比较，另报 PNG 逐字节相同的帧数。
- **测试条数**按 `node --test` 的输出，写成「条数 / 通过 / 失败」。
- **结论**分三档：补齐（计划要求的证据齐了）、部分（有证据，但口径或覆盖面不全）、仍缺（找不到，本次也补不出来）。
- **代号**：H4、H8 是 M6 的验收编号，AU 是 M6a 契约 `auth-contract.md` 第 12 节的用例编号；I3、I5 是 C6.1 的背压压测编号；E1～E6 是任务书第 6 节的端到端用例；K1～K4 是 M5b 的防锁风暴压测编号；Q、N、L、W 是契约 `render-queue-contract.md` F 节（卡片级指纹锁）的测试编号；O1 是 M5b 的离线回落用例；G0-R 是改到渲染时加跑的渲染附加项。

## 总表

| # | 缺口 | 结论 | 本次补跑 |
|---|---|---|---|
| 1 | M5a：没有令牌拒绝启动、离线回落 | 部分 | A6、T6 在 M5a 合并提交与当前 HEAD 各跑一遍；命令行失败即关两种条件各演示一次；离线回落的「本机 `ready-index-probe` 退出码 0」只做到远端不可达的一半 |
| 2 | C5：`memory-store` 的 HTTP 端到端、文件系统零引用守门 | 补齐 | H1、H2 与只经 HTTP 读素材的三组测试 |
| 3 | C6.1：I3 按缩小门槛；I5 只写「全过」 | 补齐 | I3、I5 按计划口径（1 MB、RSS）连跑 4 遍 |
| 4 | C6.3：G0-R 缺像素基线与预渲染探针 | 补齐（编码耗时一条待笔记本） | 在 C6.3 合并提交与它的前一个 main 上各导出 1800 帧逐像素比较；四个预渲染探针 |
| 5 | C6：`cloud-task.md` 第 6 步没有逐条对账 | 部分 | 只对账，没有补跑 |
| 6 | M5b：E1～E4/E6、O1、F 节契约测试、K3/K4 对照组数字 | 部分 | F 节 73 条、K 系列 18 条带原始数字；假任务版 E1；O1 同第 1 处 |
| 7 | 六份报告没有顾问调用记录一节 | 补齐（写明未调用及依据） | — |
| 8 | M6：H4、H8 没逐行对到 AU 编号 | 补齐 | AU 64 条；H4 五行各 20 次、H8 抓握手 |
| 9 | C10a：手机仿真算不算替代证据 | 只列事实与建议，由主会话定 | — |

---

## 1. M5a：没有令牌拒绝启动、离线回落

**缺口**：主计划第 7 节 M5a 验收表有两行，`REPORT-render-queue-m5a.md` 第 1 节没给结果：
- 失败即关：非回环绑定且没设令牌时，进程退出码非 0，并打出原因；
- 离线回落：端点不可达时节点报「回落」，本机 `ready-index-probe` 退出码 0。

**找到的证据**
- 失败即关：
  - 测试方写了 A6（非回环没令牌、令牌格式错），见 `fdf8963:docs/reports/AGENT-m5a-tests.md` 用例表 A6 两行；
  - 实现方直接跑 `main.mjs` 的结果：`token-required` 与 `bad-token-format` 都是退出码 1；部署脚本没令牌时在 ssh 之前就退出。见 `206043a:docs/reports/AGENT-m5a-svc.md`「失败即关与部署拒绝」。
- 离线回落：测试 T6 覆盖「都不可用 → `offline`」，见 `fdf8963:docs/reports/AGENT-m5a-tests.md` 用例表 T6。M5a 时预渲染进程还不连队列（M5b 才接），所以 M5a 阶段的 `ready-index-probe` 与端点无关；报告里没有这一项的运行记录。
- 条件后来改了：M6a 起失败即关的条件改成「绑非回环而没加载项目凭证存储」，集群令牌只守管理接口（主计划第 12.2 节；测试改动在 `369cc53`）。

**本次补跑**
- M5a 合并提交 `8c0cc08` 的代码（`git archive` 取出 `server/`，放在 scratchpad）：
  - `node --test server/test/docservice-auth.test.mjs server/test/render-node-ws.test.mjs` → 退出码 0，26 / 26 / 0；
  - 其中 A6 四条都过：非回环没令牌 → 退出码 1 且含 `token-required`；令牌格式错 → 退出码 1，不回显令牌；回环没令牌 → 能起来；合法令牌 → 令牌模式；
  - T6 三条都过：环境变量地址可用回 `remote`，不可用而回环可用回 `local`，都不可用回 `offline`。
- 同一份代码直接起进程：`PROMPTCUT_DOCSERVICE_HOST=127.0.0.2 PROMPTCUT_DOCSERVICE_PORT=0`，不设令牌 → `{"event":"config.error","reason":"token-required"}`，退出码 1。
- 当前 HEAD（M6 起的新条件）：
  - 同两份测试 → 退出码 0，28 / 28 / 0；A6 五条是新条件（凭证存储不可用 → 退出码 1、含 `auth-store`；没设令牌但凭证存储可用 → 照常启动）；
  - `node --test server/test/auth-main.test.mjs …`：AU12 三条都过（见第 8 节那一批）；
  - 直接起进程：`PROMPTCUT_DOCSERVICE_DATA=<一个文件>`、HOST 127.0.0.2、不设令牌 → `{"event":"config.error","reason":"auth-store","message":"ENOTDIR"}`，退出码 1。
- 离线回落的探针那一半（当前 HEAD）：
  - 条件：`PROMPTCUT_QUEUE_NODE=1`（队列开关开），`PROMPTCUT_DOCSERVICE_URL=ws://127.0.0.1:5829`（没有服务在听），`PROMPTCUT_DOCSERVICE_PORT=5828`（回环也没有）；
  - `node scripts/probes/ready-index-probe.mjs --port 5820` → 退出码 0，`fails: []`；
  - 另起 dev server 于 5823，`node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5823` → 退出码 0，`PASS`，透明拍数 0；
  - 但 dev server 日志显示预渲染进程的节点连上了**编辑器里挂的文档服务**：`[queue-node] docservice.session.open {"url":"ws://127.0.0.1:5823/docservice"}`。M5b 起端点顺序多了「编辑器」一项（契约 J.3），只要编辑器在，节点就走不到 `offline`。所以这次测到的是「远端不可达时回落到编辑器里的文档服务、探针照过」，不是「所有文档服务都断开」。

**出处**：`Master-Execution-Plan.md` 第 7 节 M5a 验收表；`fdf8963:docs/reports/AGENT-m5a-tests.md`；`206043a:docs/reports/AGENT-m5a-svc.md`；`server/test/docservice-auth.test.mjs` A6；`server/test/render-node-ws.test.mjs` T6；`server/render-node/endpoint.mjs` 的 `resolveDocservice`；`server/vite-plugin-frames.ts` 的 `startQueueNode`（`docservice-offline` 分支）。

**还缺什么**：「所有文档服务都不可达、节点报 `queue.skip { reason: 'docservice-offline' }`、探针照过」这一条，在不改产品代码的前提下做不出来：编辑器进程总会挂自己的文档服务，预渲染进程总会拿到它的地址。要补，得给编辑器加一个关掉内置文档服务的开发者开关，或者在探针里起一个没有文档服务插件的编辑器；两条都要改代码，本次没做。

---

## 2. C5：`memory-store` 的 HTTP 端到端、文件系统零引用守门

**缺口**：主计划 C5 验收要求「HTTP 端到端换成 `memory-store` 全过」「守门测试：HTTP 层 0 处文件系统引用」；`REPORT-c5.md` 只写了新增测试的条数。另一条「Agent 与预渲染进程读素材只经 HTTP」报告只说早已在 main。

**找到的证据**
- `server/test/asset-store-http.test.mjs`：
  - H1「注入 memory 实现后：断点续传、409 校验、Range 206 / 416、HEAD、跨源头与 fs 实现逐字段相同」：同一个 40 步剧本在 fs 与 memory 两台服务上各跑一遍，逐字段比较；
  - H2「守门：asset-service.ts 源码里没有文件系统引用、没有 .chunks 目录名」：禁 `from "fs"`、`from "fs/promises"`、`from "node:fs"`、`createReadStream`、`createWriteStream`，并查换引号、动态 import、require 的写法。
- 测试方的说明见 `c53df97:docs/reports/AGENT-c5-tests.md` 用例表 H1、H2；H2 起初被方法名 `chunks` 误判，改成按行判（同文件疑点 2）。
- 只经 HTTP 读素材：来自 `cloud-task.md` 第 5 步的两次合并 `8b8ad2c`、`2944743`，测试在 `server/test/asset-service.test.mjs`（预渲染进程的转发、ffmpeg 经 HTTP 抽帧）、`server/test/bakery-media.test.mjs`（导出不再按磁盘路径读）、`server/test/vision-media-source.test.mjs`（拼图、抽帧只给素材服务的 HTTP 地址）。

**本次补跑**（当前 HEAD）
- `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/asset-store-http.test.mjs server/test/blob-store-conformance.test.mjs` → 退出码 0，53 / 53 / 0；H1、H2 都过。
- 同样的前缀跑 `server/test/bakery-media.test.mjs server/test/vision-media-source.test.mjs server/test/asset-service.test.mjs` → 退出码 0，18 / 18 / 0。

**出处**：`server/test/asset-store-http.test.mjs` H1、H2；`c53df97:docs/reports/AGENT-c5-tests.md`；`8b8ad2c`、`2944743`。

**还缺什么**：无。说明一点：H3、H4、H6 在 M6a 按新规则改过（集群令牌退出数据面，`369cc53`），H1、H2 没动。

---

## 3. C6.1：I3 按缩小门槛跑；I5 只写「全过」

**缺口**：主计划 I 表的 I3 是「慢连接超过 1 MB 待发后被 1013 关闭；文档服务 RSS 增长 < 50 MB」，`REPORT-c6-1.md` 按 8 KiB / 64 KiB、`heapUsed` 跑；I5 只写全过。

**找到的证据**
- 测试方为什么缩小门槛：`f99224d:docs/reports/AGENT-c6-1-tests.md` I3 一节（8 KiB / 64 KiB，慢连接用原始 TCP 客户端）与疑点 7（`heapUsed` 门槛偏弱，建议改成 `heapUsed + arrayBuffers`）。
- 当时的实测：发到第 105 个任务时慢连接被关，正常节点 5970 次投递，p95 约 2.2 ms（同文件「用参考实现自检」）。

**本次补跑**（当前 HEAD）
- 原测试照旧：`node … --test server/test/docservice-backpressure.test.mjs server/test/docservice-channels.test.mjs` → 退出码 0，15 / 15 / 0。诊断：
  - I3：发布 600 个任务，第 105 个时慢连接被关；正常投递 5970 条，p95 4.5 ms；关闭帧 `{"code":1013,"reason":"backpressure"}`；`heapUsed` 增长 1.7 MB；
  - I5：灌了 110 个任务后慢节点被关，重连 `resume` 后认领接续，`queue.snapshot` 与服务端 `describe()` 一致。
- 按计划口径：`node docs/reports/evidence-M5-M8/make-i3-plan.mjs <输出>`，再 `node --experimental-test-module-mocks --test --test-name-pattern="^I3|^I5" <输出>`。高水位用核心缺省 64 KiB，上限用缺省 1 MiB，另加 RSS 断言。

  | 轮 | 退出码 | 慢连接被关时 `pendingBytes` | 正常节点 p95 | RSS 增长 | `heapUsed` 增长 | 其它 |
  |---|---|---|---|---|---|---|
  | 1 | 0 | 1,050,480 | 9.9 ms | 23.8 MB | 2.4 MB | 发布 690 个，第 490 个时关，关闭帧 1013 |
  | 2 | 0 | 1,050,480 | 13.2 ms | 23.0 MB | 2.4 MB | 同上 |
  | 3 | 0 | 1,050,480 | 14.2 ms | 24.6 MB | 2.4 MB | 同上 |
  | 4（连同 I5） | 0 | 1,050,480 | 9.6 ms | 22.1 MB | 2.4 MB | I5：灌 490 个后慢节点被关，重连后认领接续、快照一致 |

  RSS 是整个测试进程的：文档服务和 200 个客户端在同一进程里，所以 22～25 MB 是文档服务 RSS 增长的上界，低于 50 MB。

**出处**：`server/test/docservice-backpressure.test.mjs` I3、I5；`server/docservice/router.mjs` 的 `CORE_DEFAULTS`（64 KiB / 1 MiB）；`f99224d:docs/reports/AGENT-c6-1-tests.md`；`docs/reports/evidence-M5-M8/make-i3-plan.mjs`。

**还缺什么**：无。p95 是本机回环，与计划口径相同。

---

## 4. C6.3：G0-R 没列像素基线与预渲染探针

**缺口**：`REPORT-c6-3.md` 第 1 节只有导出确定性（1800/1800）与快照重放（PASS）。

**找到的证据**：实现方报告 `8d5f9a1:docs/reports/AGENT-c6-3-impl.md`「G0-R（5490）」也只跑了这两项，没有与 main 的逐像素比较，也没有跑预渲染探针。

**本次补跑**：用 `git archive` 把 C6.3 合并提交 `4665995` 和它的第一个父提交 `cc135d6`（C6.3 之前的 main）各取一份完整代码，放进 worktree 下的临时目录（依赖沿用仓库的 `node_modules`，两边 `package.json` 的依赖与现在逐字相同），跑完已删。
- 起 dev server：`cc135d6` 在 5824，`4665995` 在 5827。
- 逐像素基线：
  - 两边各用自己那份代码的导出器：`node scripts/export-frames.mjs --url "http://127.0.0.1:<端口>/?export=1" --out <目录> --no-video`，退出码都是 0，各 1800 帧，各约 224 s；
  - `node docs/reports/evidence-M5-M8/px-compare.mjs <cc135d6 那份> <4665995 那份>` → 退出码 0：`{"frames":1800,"pixelIdentical":1800,"different":0,"pngBytesIdentical":1800}`。
- 预渲染探针，都在 `4665995` 那份代码里跑：

  | 探针 | 命令 | 结果 |
  |---|---|---|
  | `ready-index-probe` | `--port 5824`（自己起编辑器） | 退出码 0，`fails: []` |
  | `stream-produce-probe --group` | `--origin http://127.0.0.1:5827 --group` | 退出码 0，`fails: []` |
  | `stream-produce-probe` | `--origin http://127.0.0.1:5827` | 退出码 1，两遍都只挂一条「1080p 全幅流 15 帧分段编码 ≤ 300 ms」，p50 分别是 849 ms、563 ms；其余断言全过 |
  | `preview-fallback-probe` | `--origin http://127.0.0.1:5827` | 退出码 0，`PASS` |
  | `preview-fallback-probe --page-preload` | 同上加 `--page-preload` | 退出码 0，`PASS` |

- 那条编码耗时是带耗时门槛的项，按 `guide_files/verification.md`「性能基准机」只在笔记本上算数。跑的时候这台 PC 的 CPU 占用是 100%（别的会话在跑），在 PC 上挂、在 PC 上过都不作数。另外，同一条在笔记本上早已判为性能缺陷，与 C6.3 无关（`REPORT-C10a.md` 第 2.13 节，用户 2026-09-27 定为 M8 之前必修）。

**出处**：`8d5f9a1:docs/reports/AGENT-c6-3-impl.md`；合并提交 `4665995`、父提交 `cc135d6`；`docs/reports/evidence-M5-M8/px-compare.mjs`。

**还缺什么**：编码耗时那一条要在笔记本上跑；它已经作为既有缺陷登记，不是 C6.3 的欠账。

---

## 5. C6：`cloud-task.md` 第 6 步没有逐条对账

**缺口**：主计划 C6 验收要求「`cloud-task.md` 第 6 步的单步验收：D 的条目、A1『第 6 步后』、A5、A3、端到端换机」，C6.1～C6.4 与 M5b 的报告都没有逐条对。

**逐条对账**（第 6 步的验收写在 `cloud-task.md`「六步各做什么」表第 6 步一行与文末「验收（合验）」的 A1、A3、D 条目；C6 拆成六段后，D1、D2、D4 进了 C6.5，A1 两档与 A6 进了 C6.6）

| 条目 | 落在哪一段 | 证据 | 结论 |
|---|---|---|---|
| D：Agent 连续 30 次 `add_clip` / `set_position`，播放头在 60 秒处，编辑器主线程长任务合计 < 300 ms | C6.5 | 没找到。`REPORT-C6.5.md` 第 3 节的 V8 是另一件事（1000 个片段单次差异计算中位数约 2 ms，另一页面看到改动远低于 300 ms） | 仍缺 |
| D：100 个工具调用，每条事件更新 < 10 ms，只重渲对应记录 | C6.5 | 没找到 | 仍缺 |
| D：展开一条事件时经内容库 `content.get` 拿到完整参数 | C6.5 | `docs/archive/agent-reports/AGENT-c65-agent.md` 的 AG-5、AG-8：完成事件补写 `event-detail`，`content.get { kind: "event-detail" }` 取回参数、摘要、`opId`、`inverse` | 补齐 |
| D：`.proc` 仍由页面在 ack 之后写 | C6.5 | `REPORT-C6.5.md` 第 3 节 V7 | 补齐 |
| A1 第 6 步后：断网导入再联网只补缺的分片；两档 `chunks` 分别 `complete`；项目与 `.proc` 无同步状态 | C6.6 | `REPORT-C6.6.md` 第 3 节 T2（契约测试 C66-T2，`c66-upload.test.mjs`） | 补齐 |
| A1：素材小尺寸先于素材原尺寸到达另一台机器 | C6.6 | `REPORT-C6.6.md` T9 与第 7、9 节的 T9-X2、T9-X3 真跨机：首帧小尺寸，原尺寸约 109 s 后换上，帧号误差 0、黑帧 0 | 补齐 |
| A1：换档 `currentTime` 不跳、原尺寸没到时导出提示「等待上传方」、不可播编码停在小尺寸 | C6.6 | `REPORT-C6.6.md` T5、T6、T7（`tier-switch-probe`、契约测试 C66-I3） | 补齐 |
| A1：后台上传期间时间轴可编辑、主线程无长任务 | C6.6 | `tiers-probe.mjs` 的 T4（后台导入、转码、上传期间没有超过 50 ms 的长任务）：C6.6 集成时加，笔记本上一度 3 轮挂 2 轮，修复合入 main `a038948`，笔记本空闲时 3 轮全过（`AGENT-perf-t4.md`；`m8-plan.md` 第 2.7 节） | 补齐 |
| A1：导入两小时 4 GB 素材，小尺寸先到、上传队列逐个素材先小后大 | C6.6 | 先小后大有 T9-X2、T9-X3（见上），但素材约 44 MB；4 GB、两小时的规模没找到测量 | 部分 |
| A5：卡级推送优先级与审阅表**逐卡**一致 | C6.4 | `server/test/artifact-push.test.mjs` W2、W3 验证三档顺序与 `data:image` 占比判法；`manifest-contract.md` 第 4 节的优先级表。没有拿审阅表逐卡对的测试或探针 | 部分 |
| A3：共享键敏感性、本地档与 `unknown` 卡照样推送、超上限帧标 `oversize`、`px/<hash>` 与 `render-manifest` 可查 | C6.2、C6.4 | `REPORT-c6-2.md` 第 1 节（`artifact-transfer` T1～T8、`asset-namespaces` S）、`REPORT-c6-4.md` 第 1 节（`artifact-dedup` U、`artifact-push` W、`artifact-adopt` A）；键的敏感性早在 R 系列（`server/test/card-snapshot-identity.test.mjs`） | 部分：各测试覆盖分散，没有逐条表 |
| 端到端换机不重渲（产物推送 → 清单写内容库 → 另一端取清单 → 按哈希拉块 → 就绪） | C6.4 并入 M5b | `REPORT-render-queue-m5b.md` 第 1 节跨机表 W3：笔记本 5 个任务全走去重、拉 240 帧、0 次渲染 | 补齐 |

**本次补跑**：没有。D 的两条性能口径要编辑器页面加 puppeteer 计长任务，现有探针里没有现成的；A1 的 4 GB 规模要真素材与跨机。

**还缺什么**：D 的两条性能口径、A1 的 4 GB 规模、A5 的逐卡对照。M8 的计划（`m8-plan.md`，分支 `claude/m8-plan`）没有列这几条，建议主会话决定是补测还是在总报告里记为未验。

---

## 6. M5b：E1～E4/E6、离线回落 O1、F 节契约测试、K3/K4 对照组

**缺口**：主计划 M5b 验收要求任务书 E1～E4、E6，离线回落 O1，契约 F 节 Q/N/L/W 测试一条不改、全过，K1～K4 各跑过滤开、关两组并贴原始数字。`REPORT-render-queue-m5b.md` 只有 K1 数字与 W3、W4。

### 6.1 E1～E4、E6

契约 `render-queue-contract.md` J.9 把 E 用例在 M5b 的口径改写过（真实任务、笔记本参与），下表按 J.9 的口径对。

| 用例 | 找到的证据 | 结论 |
|---|---|---|
| E1 两个本机节点加笔记本抢同一批快照任务，恰好一次，产物在素材服务 | W4 只有笔记本一个节点在做（主 PC 本机节点 `localCompleted 0`），不是抢同一批（`REPORT-render-queue-m5b.md` 跨机表）。假任务版有：M5a 的 X3（主 PC 与笔记本各认领 25、`duplicateDone 0`）、T9（两节点抢 50 个）。真实任务、多台主机抢同一批的是后来 M6 的 W5 H1（PC 2、host-a 1、host-b 2，`identicalBytes true`，`REPORT-M6.md` 第 2 节） | 部分 |
| E2 认领中途断网，宽限期后被接手（真实任务） | 只在网络层用假任务验过：M5a X5 15.07 s、X6 34.00 s；测试 T4（重连后 `resume`）。M5b 没有真实任务的这一遍 | 部分 |
| E3 文档服务重启后重新发布，已在素材服务里的直接去重完成 | M5a X7（`pm2 restart` 后 60/60、dup 0，重新发布的任务在笔记本上走去重）是假任务；T5（新 epoch 下 `lease-lost { reason: 'epoch' }`）。真实任务的去重完成见 W3，但那一遍不是重启后 | 部分 |
| E4 连续改 50 次，版本号与文档服务一致，最后一版全部就绪 | M5b 没有。后来 C6.5 的 V2（两页各改 100 次，两页与文档服务 sha256 相同，rev 150）覆盖了版本一致，没有覆盖「后台任务不饥饿、最后一版全部就绪」 | 仍缺 |
| E6 两种指纹的细任务只被同指纹节点认领 | J.9 明写由 I 节的 K 系列覆盖（两台真机指纹相同）。K1、K2、V4 见 6.3 | 补齐（按 J.9 口径） |

本次补跑（当前 HEAD，假任务，只作 E1 的网络层旁证）：
- 自己起文档服务：`PROMPTCUT_DOCSERVICE_HOST=127.0.0.1 PROMPTCUT_DOCSERVICE_PORT=5829 node server/docservice/main.mjs`（回环、匿名）；
- 两个独立节点进程：`node scripts/probes/render-queue-e2e.mjs --url ws://127.0.0.1:5829 --role node --node-id e1-node-a`（另一个 `e1-node-b`）；
- 发布方加进程内第三节点：`--role both --tasks 50 --node-id e1-node-c` → 退出码 0，`published 50`、`completed 50`、`duplicateDone 0`、`fails: []`，done 延迟 p50 1636 ms、p95 2620 ms；
- 三个节点认领 20 + 15 + 15 = 50，每个 id 恰好一次。

真实任务的 E1～E4 都排进了 M8：`m8-plan.md` 第 2.1 节，由计划新写的探针 m8-e-probe 编排（还不存在，分支 `claude/m8-e2e`），放云端、放本机各一遍。

### 6.2 离线回落 O1

- 没找到 M5b 时的运行记录。报告里的 G0-R「开关关」跑了 `ready-index-probe` 与 `preview-fallback-probe`，但那是开关关，不是开关开而文档服务断开。
- 本次补跑同第 1 节：开关开、远端不可达时两个探针都退出码 0，但节点实际连的是编辑器里挂的文档服务，没有走到 `offline`。
- 结论：部分。还缺的与第 1 节相同。

### 6.3 契约 F 节测试、K1～K4

**F 节**（卡片级指纹锁：Q 队列、N 节点、L 预渲染进程、W 页面）
- 当前 HEAD：`node … --test server/test/card-lock-queue.test.mjs server/test/card-lock-node.test.mjs server/test/card-lock-pipeline.test.mjs src/editor/pageEnvironment.test.mjs` → 退出码 0，73 / 73 / 0。按编号：Q0～Q11 共 27 条、N1～N6 共 19 条、L1～L10 共 21 条、W1～W2 共 6 条。
- **「一条不改」不成立**：M5b 期间改过 `card-lock-queue.test.mjs` 的四条，提交 `1bdce9e`「P14、Q4、Q11、Q8 按裁定调整」：
  - Q4 两条与 Q11：场景显式传 `constants: { PREFILTER: false }`，期望不变；
  - Q8 后半段：新 epoch 的队列同样传 `PREFILTER: false`；
  - 依据是主 Agent 的裁定，契约 I.10 第 3 条（Q4、Q11）与 `docs/archive/agent-reports/AGENT-m5b-queue.md`「第二轮」里的 Q8 裁决请求。改法是给测 F.1 本身的用例关掉新加的过滤，断言没放宽。
- N、L、W 三个文件在 M5b 期间没有改动（`git log` 最后一次改动都在 2026-09-24）。Q 系列后来在 M6c 又改过一次（`18264c6`）。

**K1～K4**（当前 HEAD，`node … --test server/test/render-queue-prefilter.test.mjs` → 退出码 0，18 / 18 / 0）。实验组是过滤开，对照组是过滤关，数字取自测试的诊断输出：

| 编号 | 对照组（过滤关） | 实验组（过滤开） |
|---|---|---|
| K1 | 认领 526 次，`card-locked` 400 次，活任务完成 100/100 | 认领 120 次，`card-locked` 0 次，活任务完成 100/100 |
| K2 | 锁定后 `task.opened` 共 800 条，给不匹配节点的 400 条；锁定时 `hidden` 撤回 0 条 | 锁定后 `task.opened` 共 400 条，给不匹配节点的 0 条；锁定时 `hidden` 撤回 400 条 |
| K3 | 接手那一步：X 节点 160 条、Y 节点 160 条、Z 节点 80 条，全是 `task.closed:failed`；跑完 `task.done` 100、`task.failed` 40 | 接手那一步：X 节点 160 条 `task.closed:hidden`、Y 节点 160 条 `task.opened`、Z 节点 0 条；跑完 `task.done` 100、`task.failed` 40 |
| K4 | 无视过滤的节点认领 30 次，全部 `card-locked`；`cardLockedRejects=30`、`throttled=false` | 前 21 次 `card-locked`，之后 9 次 `throttled`；`cardLockedRejects=21`、`throttled=true` |

- 这组数字与测试方当初在参考实现上的自检逐项相同，见 `docs/archive/agent-reports/AGENT-m5b-queue-tests.md`「验证」；实现方另用 scratch 脚本跑过规模不同的一组（50 张卡，K1 过滤开 0 次、过滤关 400 次），见 `docs/archive/agent-reports/AGENT-m5b-queue.md`「自测」。
- K3 的计数单位是消息条数：20 张卡 × 2 段 = 40 个任务，X、Y 各 4 个节点，所以是 160 条。

**还缺什么**
- K4 的第二条判据「其它节点的认领延迟 p95 与无干扰时相差 < 20%」没有测量。现有 K4 用假时钟的进程内测试，只断言其它节点照常认领、各自计数；延迟要在真 WebSocket 上另写压测，本次没做。
- E2～E4 的真实任务版本、O1 的完全离线版本，见上。

**出处**：`render-queue-contract.md` I.10、J.9；`server/test/render-queue-prefilter.test.mjs`；`server/test/card-lock-queue.test.mjs`；提交 `1bdce9e`、`18264c6`；`docs/archive/agent-reports/AGENT-m5b-queue-tests.md`、`AGENT-m5b-queue.md`；`REPORT-render-queue-m5b.md`、`REPORT-render-queue-m5a.md`、`REPORT-M6.md`。

---

## 7. 顾问调用记录（M5a、C5、C6.1～C6.4、M5b）

**缺口**：主计划要求每个阶段的报告都有「顾问调用记录」一节，一次都没调的要写明为什么；这六份报告与 `REPORT-M5.md` 都没有，C5 只在过程记录里带了一句 agy 审查。

**依据**
- **这条要求晚于 M5**：`Master-Execution-Plan.md` 里「顾问调用记录」这几个字最早出现在提交 `4772b71`（2026-09-26 02:09 +0900，「模型分工重定」）。M5 的七次合并都在它之前：M5a `8c0cc08`（09-25 01:46）、C5 `cc60741`（02:18）、C6.1 `2180491`（02:37）、C6.2 `cc135d6`（03:21）、C6.3 `4665995`（03:29）、C6.4 `c7bfe5b`（13:41）、M5b `f9660d3`（20:41）。当时计划里的顾问条款只有一句：遇到难以突破的工程门槛调 GPT 查资料，要在几个架构方案里选一个时调 Gemini（`4772b71` 删掉的旧文）。
- **报告与子报告里的痕迹**：在七份阶段报告、`git show` 取出的 16 份子 Agent 报告（M5a 4 份、C5 2 份、C6.1～C6.4 共 10 份）、归档的 7 份 M5b 子报告和 `AGENT-flaky-fix.md`、`AGENT-bad-ports-concurrency.md` 里搜 codex、GPT、agy、Gemini、顾问，只有 `REPORT-c5.md` 两处命中，指同一次审查。
- **提交记录**：`git log --all -i --grep="codex\|agy\|gemini\|gpt"`，时间限在 2026-09-24 到 2026-09-26 06:00，M5 期间只有 `b166f1e`（2026-09-25 01:10，「第 6 步独立审查(agy gemini-3.1-pro-high)」）。之后的 `061da9e`（M6a 契约）、`2bc4edf`（SP 契约）、`1c94e22`、`4130a5f`（C6.5 设计稿）都在 M5 合并完以后。

**各阶段的记录**（可直接并进总报告）

| 阶段 | 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|---|
| M5a | — | — | 本阶段未调用：没有撞上工程门槛，也不涉及方案选型；W1 的 X6 首测没触发，是多发任务、晚一点卡住后重测解决的（`REPORT-render-queue-m5a.md` 第 1 节），属第 1 级的自行处理 | — |
| C5 | 审查（agy，`gemini-3.1-pro-high`） | `cloud-task.md` 第 6 步的独立审查（原任务书开头就写着第 5 步动工前应请没参与折叠的审查者过一遍） | `docs/reports/REVIEW-c6-agy.md`：C6 拆成 C6.1～C6.6，C6.4 决议 11 与 C6.5 的操作格式、撤销语义交用户定 | 采纳，主会话核过引用后写进主计划 C6 一节（提交 `b166f1e`） |
| C6.1～C6.4 | — | — | 本阶段未调用：四段都照 `REVIEW-c6-agy.md` 的拆分与各自契约推进，疑点由主 Agent 裁定写进契约的补充细则（H.7、第 10、11 节、第 10 节、第 9 节）；C6.4 的决议 11 靠按段拆键解决，不必改决议（`REPORT-c6-4.md` 第 2 节第 1 条） | — |
| M5b | — | — | 本阶段未调用：测试偶发失败由 `claude/flaky-fix`（`opus-dev-high`）查到坏端口根因并修掉（`REPORT-render-queue-m5b.md` 第 3 节），没有升到 codex 或 Gemini；架构附件由只读的架构子 Agent 起草 | — |

**还缺什么**：无。说明一点：现在的主计划写 Gemini「不做架构审查」（第 11.1 节第 2 条，2026-09-26 重定）；C5 期间那次审查发生在改规则之前，当时的条款允许 Gemini 给架构建议。

---

## 8. M6：H4、H8 没逐行对到 AU 编号

**缺口**：主计划 H4 要求五种进入方式「各测 20 次」，H8 要求「抓握手的全部消息，里面不出现任何密码的明文」和「同一来源 1 分钟内错 5 次后冷却 60 s」。`REPORT-M6.md` 第 2 节只写「AU 64/64」和一行跨机结果。

**逐行对到 AU 编号**（当前 HEAD：`node … --test server/test/auth-handshake.test.mjs server/test/auth-members.test.mjs server/test/auth-main.test.mjs server/test/auth-tickets.test.mjs server/test/auth-spaces.test.mjs server/test/auth-create.test.mjs` → 退出码 0，64 / 64 / 0）

| H 行 | 对应的 AU 用例（测试文件） | 契约测试每次跑几遍 | 本次各 20 次（`h4-h8-rerun.test.mjs`） |
|---|---|---|---|
| H4 自由进入，名和密码都对 → 100% 进入 | AU2「证明对 → 握手 101」（`auth-handshake`） | 1 | H4-1：20 次全 101 |
| H4 自由进入，密码错 → 0 次进入 | AU2「证明错 → 401」（`auth-handshake`） | 1 | H4-2：20 次全 401 |
| H4 限定进入，名单外或密码错 → 0 次进入 | AU3「名单外……随后握手 401」「用别人的口令 401」（`auth-handshake`） | 各 1 | H4-3：名单外 10 次、名单内密码错 10 次，20 次全 401；对照：名单内密码对 101 |
| H4 限定进入，删掉名单条目 → 现有连接 5 s 内全断、再连被拒 | AU6「set-list 移出某人……5 s 内以 4003 removed 关闭，再握手 401」（`auth-members`） | 1 | H4-4：20 轮，每轮页面与渲染两条连接都以 4003 `removed` 关闭，最长 2 ms，再连 401，名单里的人不受影响 |
| H4 自由进入，两台设备自报同一用户名 → `userId` 不同、显示名带「(设备名)」 | AU4（`auth-members`） | 1 | H4-5：20 轮全过 |
| H8 抓握手全部消息，无口令明文 | AU13「全部日志行与所有错误回包里不出现口令、K、证明 m、票据原文」（`auth-main`）。AU13 查的是日志和错误回包，不是线上消息本身 | 1 | H8-1：用产品客户端 `server/auth/client.mjs` 的 `createSharedProject`、`buildAuthProtocols`，给它一个记录每次请求与回包的 `fetch`；抓到建项目 2 次、挑战 5 次、升级请求与响应 5 次（成功 3、失败 2），共 24 段、6524 字节；按原文、十六进制、base64、base64url、URL 编码查四个口令，再把子协议里的 base64url JSON 解开查一遍，命中 0 处 |
| H8 同一来源 1 分钟内错 5 次 → 60 s 冷却，冷却期内口令对也拒；别的来源不受影响 | AU8 四条（`auth-handshake`）：门槛、1 分钟外不累计、nonce 不对也算、创建者操作计入；实现方单测 `auth-impl-units`「rate-limit」「handshake：限速」 | 各 1 | 没有另跑 20 次（计划这一条没要求次数） |

- `h4-h8-rerun.test.mjs` 连跑 3 遍，每遍退出码 0、6 / 6 / 0。每次换一个非回环来源地址，避开限速。
- 跨机那一遍：`REPORT-M6.md` 第 2 节 W5 表 H4 / H8 一行（笔记本来源：错口令 401、对口令 101、错 5 次后冷却期挑战 429、61 s 后恢复 101）。

**出处**：`auth-contract.md` 第 12 节 AU 表；`server/test/auth-handshake.test.mjs`、`auth-members.test.mjs`、`auth-main.test.mjs`；`docs/reports/evidence-M5-M8/h4-h8-rerun.test.mjs`；`REPORT-M6.md` 第 2 节。

**还缺什么**：无。说明两点：
- 补跑用的是测试套件 `auth-kit.mjs` 起的服务（真共享项目文档服务、端口 0），来源地址靠测试钩子改写，不是真局域网；真局域网那一遍是 W5。
- H8-1 抓的是 HTTP 请求、回包与 WebSocket 升级头，没有抓进入之后的数据帧；进入后的消息里不带口令是 AU13（错误回包）与协议设计（只传派生值和 HMAC 证明）保证的。

---

## 9. C10a：手机演示与手机仿真

**缺口**：主计划 C10a 验收要求「手机 demo」（手机扫二维码打开 `/editor`，凭邀请码只填用户名加入；创建者作废邀请码后旧二维码被拒；看到预渲染小尺寸与素材小尺寸；手机上改一处，由笔记本当渲染节点重渲，结果回到手机；截图与操作记录贴进报告）。阶段报告把「真手机扫码」列为待用户项合入，没说仿真算不算替代证据。本节只列事实与建议，不下结论。

**事实**
- **仿真做了什么**：`scripts/probes/c10a-demo-probe.mjs` 第 2 步用桌面 Chrome 的移动端仿真打开邀请链接：`page.emulate` 设 Android Pixel 8 的 UA、视口 412×915、`deviceScaleFactor: 2`、`isMobile`、`hasTouch`，另注入 `navigator.deviceMemory = 4`。
- **仿真覆盖了哪几条**（外网演示第 2 轮，`REPORT-C10a.md` 第 2.15 节，`ok: true`、`fails: []`）：
  - 只填用户名加入、判为低内存档、只 1 个舞台、贴着小尺寸；素材请求只有小尺寸 4 次，原尺寸 0、`/@media` 0；
  - 在手机上改一处，由创建方的渲染节点重渲，新的预渲染小尺寸 330.8 s 回到手机；
  - 作废邀请码后旧邀请被拒、新邀请能进；
  - 低内存档逐帧导出：缺原尺寸时等待、不出片，补齐后 300 帧只用原尺寸。
- **仿真没覆盖的**：
  - 扫二维码本身（iPhone 相机、微信各一次，`c10a-contract.md` 第 12 节）；
  - 真实手机浏览器的内存上限、后台节流、iOS Safari 与微信内置浏览器的媒体与 WebCodecs 行为；仿真跑在桌面 Chrome 内核上，`deviceMemory` 是注入的值；
  - 蜂窝或手机热点网络；
  - iOS 逐帧导出的最长时长与体积（报告第 5 节另列为待用户项）。
- **计划自己的写法**：主计划第 6.5 节时机表 W-C10a 一行把「无头 Chrome 以手机视口打开 `/editor` 预检」写成**可选**预检，验收列写的是「用户用手机扫码」。
- **机器分工**：计划写「笔记本建在云端的项目」「由笔记本（渲染节点）重渲」。`REPORT-C10a.md` 第 2.11～2.15 节由笔记本主会话补完；外网第 2 轮里，创建方（兼渲染节点，dev server 端口 5660）与手机仿真由同一台机器上的同一个探针驱动，手机那一端经阿里云的站点接入。

**建议**（供主会话定）
- 把仿真结果算作「流程与数据面」的替代证据：加入、低内存档判定、只取小尺寸、改后重渲回到手机、作废邀请，这几条仿真与真机走同一套页面代码和服务端路径，结果可信。
- 把「真机」单列为待用户项，范围限定在仿真覆盖不了的四件：扫码进入、iOS Safari 与微信内置浏览器各打开一次并看到小尺寸画面、真机上改一处看到重渲结果、iOS 逐帧导出的时长与体积。
- 如果要求严格按计划原文，C10a 的「手机 demo」应在总报告里记为「部分（仿真通过，真机待用户）」，而不是「通过」。

**出处**：`Master-Execution-Plan.md` C10a 一节验收「手机 demo」与第 6.5 节 W-C10a 一行；`REPORT-C10a.md` 第 2.15、3、5 节；`scripts/probes/c10a-demo-probe.mjs` 文件头第 2 步与 `page.emulate` 一段。

---

## 附：本次的命令与环境

- 工作区：`git -C C:\Users\admin\Documents\PromptCut worktree add .worktrees/evidence-audit -b claude/evidence-audit main`（main 为 `2fa0c1a`）。
- 测试的前缀都是 `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test --test-reporter=spec`，与 `npm test` 相同。
- 起过的进程：dev server 于 5823、5824、5827（各连同舞台端口 +1、+2），文档服务于 5829；`ready-index-probe` 自己起的编辑器于 5820、5824。全部是本次启动，跑完已按进程树结束，端口 5820～5829 已空。
- 取历史代码：`git archive <提交> | tar -x`，放在 scratchpad 或 worktree 下的临时目录，跑完已删，没有建 junction。
- 没做的：没有跑全量 `npm test` 与 `tsc`（本分支只加文档与三个不进 `npm test` 的脚本）；没有连阿里云；没有碰 5190～5192、5203～5205。
