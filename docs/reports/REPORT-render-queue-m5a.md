# 报告：渲染任务队列 M5a（网络层、集群令牌、服务地址登记、文档服务通用化）

集成分支 `claude/rq-m5a`。2026-09-25 验收通过，按用户「阶段验收全过即自动合并」的授权合入 main。

- 计划：`docs/plan/Master-Execution-Plan.md` 第 5.4 节、第 7 节 M5a（随本分支入库）
- 契约：`docs/plan/render-queue-contract.md` G 节（G.11、G.12 是定稿后按实现方疑点补的细则）
- 语义：main `95f9aa7`（S1、S2 与文档服务定位，用户逐条确认后提交）

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（连跑两遍） | 两遍都是 tests 2250、pass 2249、fail 0、skipped 1（照旧需要 5190 的那条） |
| 新增测试 | `docservice-router`（R）、`docservice-auth`（A）、`docservice-endpoints`（E）、`render-node-ws`（T）、`render-node-deps`（D） | 12 + 11 + 12 + 15 + 3，全过 |
| 既有测试 | `server/test/docservice.test.mjs` | 一个字没改，17/17 通过（R4） |
| 本机回环 | `ws-client-test.mjs ws://127.0.0.1:8790`（令牌模式） | 14/14 |
| 本机 50 任务 | `render-queue-e2e.mjs --role both --tasks 50` | `completed 50`、`duplicateDone 0` |
| 代理注入 | 经 `render-queue-proxy.mjs --delay-ms 200 --loss 0.05` | 50/50，恰好各完成一次 |
| 本机干净断开 | 节点 `--exit-after-claim` | 11.6 s 被接手（≤ 17 s） |
| 本机半开 | 代理 `--stall-after-ms` | 33.4 s 被接手（≤ 37 s） |
| 远端部署 | `scripts/remote/docservice.mjs deploy`（令牌模式） | `/healthz` 有 `protocol`、`modules`、`epoch`；带令牌 14/14；不带令牌握手被拒（退出码 2） |
| 渲染 | — | 没跑 G0-R：本阶段没动 `frame-pipeline.mjs`、导出与页面；`snapshotTier` 只是原样搬家 |

### W1 跨机断言（主 PC 192.168.50.96 × 笔记本 192.168.50.247 × 远端 8.219.80.16:8787）

| 编号 | 结果 | 证据 |
|---|---|---|
| X1 握手 | ✓ | 两端 `node.welcome` 的 epoch 都是 `66cb0fe9…`；笔记本握手 217 ms |
| X2 鉴权 | ✓ | 笔记本带令牌 14/14；不带令牌握手 FAIL、退出码 2 |
| X3 抢同一批任务 | ✓ | 主 PC 发布 50 个：`completed 50`、`duplicateDone 0`；主 PC 认领 25，笔记本 L1 认领 25 |
| X4 双向 | ✓ | 笔记本发布 20 个，主 PC 节点完成：`completed 20`、`dup 0`，done 延迟 p50 2454 ms、p95 4507 ms。主 PC → 笔记本方向见 X3 |
| X5 干净断开 | ✓ | 笔记本 A 16:39:15.95 认领后退出，主 PC `pc-L` 16:39:31.02 完成（任务耗时 300 ms）：`pc-L` 实测接手 **15.07 s**，≤ 17 s |
| X6 半开 | ✓ | 笔记本 B2 经本机代理连接，16:40:58.8 卡住；`pc-L` 16:41:31.14 完成它认领的任务：租约到期后接手，`pc-L` 实测 **34.00 s**，≤ 37 s。服务端 16:41:45.9 才靠心跳断开半开连接，比接手晚，符合设计。B2 重连后收到 `node.lost`。发布方 200/200、dup 0 |
| X7 远端重启 | ✓ | 16:30:13 `pm2 restart`：epoch `66cb0fe9…` → `ac081d61…`；主 PC 约 0.7 s、笔记本约 0.65 s 重连；60/60、dup 0；重新发布的任务在笔记本上走去重完成 |
| X8 地址登记 | ✓ | 主 PC `pc-L` 登记后，笔记本 `--watch-endpoints` 收到 `{ announcerId: 'pc-L', kind: 'render-node', urls: ['http://192.168.50.96:5460/api/asset'] }` |

X6 按用户「物理环境自治」的要求，改用笔记本本机的 TCP 代理模拟拔网（`--stall-after-ms`），没有真去断笔记本的网。第一次重测时，代理卡住之前笔记本一个任务都没认领到，场景没有触发；多发任务、晚一点卡住之后才测到。

## 2. 与对齐时不一致的地方

1. **令牌经跨机消息下发给了 Worker**。计划原来规定令牌不进跨机消息；用户的自治指令要求「自行注入」，笔记本又读不到主 PC 的 `.env.cluster`，只能这样。令牌生成在主 PC 的 `.env.cluster`（已被 `.gitignore` 的 `.env.*` 忽略）；建议 M5 收尾后轮换一次。
2. **多改了三个文件，都在计划的文件清单之外**：
   - `ws.mjs` 的半开处理：对端结束 TCP 却没发关闭帧时，服务端立即断开（G.12 第 8 条）；
   - `snapshotTier` 搬进 `server/snapshot-tier.mjs`：笔记本没有 `node_modules`，而 `local-node → split → snapshot-store → frame-mov → pngjs` 这条链让节点根本起不来。修好后加了守门测试 `render-node-deps`（D0～D2），保证 `server/render-node/`、`server/docservice/`、`server/render-queue/` 只依赖 Node 内置模块。
   - 契约 B 节原先写 `render-node` 用 `snapshot-store.mjs` 的 `snapshotTier`，已同步更正。
3. **`local-node.mjs` 没改**：它的 `start()` 本来就支持重连。计划里写的「加注入点」不需要。

## 过程记录

### 2026-09-25 开工前

- 语义改动 ①～⑨：用户全部同意，授权提交 main，提交为 `95f9aa7`；已合进本分支（`8f1cbe7`）。
- 契约 G 节：`4d08114` 起草，`b17c50a` 定稿。用户授权自动推进，没有逐节审阅。
- 派出三个子 Agent：
  - `claude/rq-m5a-svc`：`opus-dev-high`，G.1～G.6；
  - `claude/rq-m5a-net`：`opus-dev-high`，G.7；
  - `claude/rq-m5a-tests`：`opus-dev`，G.8、G.9，只照契约写。

### W0 笔记本环境回报（2026-09-25）

Worker 会话「分布式工作节点握手」回执原文摘要：

| 项 | 笔记本 | 主 PC | 判定 |
|---|---|---|---|
| 系统 | Windows 11 企业版 10.0.26200，AMD64 | Windows 11 Pro 10.0.26200 | — |
| Node | v24.19.0，npm 11.17.0 | v24.19.0 | ≥ 22 ✓ |
| 仓库 | `D:\VectorMPEG7\PromptCut`，工作区干净，HEAD = origin/main = `9a95ed8` | origin/main `9a95ed8`，本地 main `95f9aa7`（未推送） | ✓ |
| node_modules | 不存在 | 存在 | 见下 |
| 控制面 `/healthz` | 可达：`{"ok":true,"service":"promptcut-docservice",…}` | — | ✓ |
| 局域网 | WLAN `192.168.50.247`，网关 `192.168.50.1` | 以太网 `192.168.50.96`，网关 `192.168.50.1` | 同一 /24 网段 ✓ |
| 互 ping | — | 主 PC ping 笔记本不通 | 多半是 Windows 挡了 ICMP，W2 用 HTTP 实测 |
| 权限模式 | bypassPermissions | bypassPermissions | 跨会话消息不会被挂起 ✓ |
| 环境指纹 | W0 时没有 node_modules，跳过；笔记本在用户授权下装好依赖后补测：`258acaaa7c5fe509`（windows / software / Chrome 152.0.7977.75） | `258acaaa7c5fe509`（windows / software / Chrome 152） | **两台相同**，证实下文第 2 条 |

**W0 引出的两件事**：

1. **笔记本没有 node_modules**。
   - W1 用的 e2e 探针只依赖 `server/render-queue/`、`server/render-node/` 和 `server/test/fake-*.mjs`，这些都只用 Node 内置模块，预计不需要安装；
   - W4 起在笔记本上跑真实预渲染要用 puppeteer，必须 `npm install`，属于安装，到时先问用户。
2. **两台机器的指纹很可能相同**。
   - 指纹只由 OS、GPU 类别、Chrome 主版本三项决定；
   - 预渲染 Chrome 带 `--disable-gpu`，GPU 类别恒为 `software`；
   - 两台都是 Windows，puppeteer 锁定的 Chrome 版本也相同，所以笔记本的指纹大概率也是 `258acaaa7c5fe509`。
   - 这样 M5b 的 E6、K1～K3 和 W4「两种指纹」的前提在真机上不成立。M5b 开工前要定一种做法：
     - 用 `FramePipeline` 可注入的 `environment` 在一台机器上模拟第二种指纹；
     - 或者笔记本改用不同的 Chrome 启动参数（例如开 GPU）。
   - 装好依赖后先实测确认。
