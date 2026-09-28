# AGENT-m8-e2e 报告

分支 `claude/m8-e2e`，worktree `.worktrees/m8-e2e`，端口段 5740～5749（托管组合与协调口用端口 0）。
基于 `278eeb9`（M8 计划、换行修复、卡片改动层修复、卡片同步接会话层的集成提交），合入 `claude/m8-kit`（`4b18d64`），中途两次合入 main（`d3b674d` 之后的 main、C10 合入后的 main `51f01c4` 之后）。
任务：M8 计划（`docs/plan/m8-plan.md`）第 4 节第 4～6 项。

代号：**M8** = 分布式预渲染队列任务书的最后一个阶段「多端物理联调」；**E1～E6** = 任务书第 6 节的端到端用例（抢活、断网接手、文档服务重启、Agent 突发修改、纯浏览器只见本人任务、两种指纹）；
**J-全完 / J-恰一 / J-纯层** = 计划第 2 节开头的三条共用判据（任务全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹）；
**C1 / C2 / C4 / C5-2** = 计划第 2.6 节的混沌项（节点断网 30 s、云端 `pm2 restart`、放本机时重启 PC 的局域网主机编辑器、放本机时代理侧切断后会话接续）；
**D2 / D3 / D12** = 计划末尾主会话裁定（「主机素材服务重启」按重启整个编辑器进程算、「恰好一次」按 epoch 数、E6 的第二种指纹两种都做）；
**M8-X1** = 放本机版 T9（C6.6 的跨机项：PC 当局域网主机、第二台机器经局域网直连加入）；**L3** = 计划第 5 节「T9 用确定判重的探针卡代替人工钉死」。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `scripts/probes/m8-e-probe.mjs`（新） | E1、E2（含 C1 的 `--stall-s`）、E3（C2 / C4）、E4、E6 的编排。`--place cloud｜lan`；角色 `creator`、`host`、`watcher`（可选的独立旁观节点）、`signal`（给主会话写回远端步骤完成的信号）、`all`（本机替身）；`--fake-fingerprint`、`--via-proxy`、`--stall`、`--stall-s`、`--burst`、`--gaps`、`--keep`。判据用公共件的 `judgeAllDone`、`judgeExactlyOnce`（按 epoch）、`judgePureLayers`、`judgeEachWorked`、`takeoverMs`。用法、KV 键、各用例判据写在文件头 |
| `scripts/probes/ht-w-probe.mjs`（改） | `--place lan`（C5-2）：creator 以局域网主机起编辑器、在本机建局域网项目；host 经局域网发现（`--lan-host` 兜底）找主机，代理转到发现的地址；局域网主机的 `/api/docservice/healthz` 只答回环，`sessions.resumed` 由 creator 在 `host.holding` / `host.resumed` 时读、判 `lan-healthz-resumed` |
| `scripts/probes/c66-t9-probe.mjs`（改） | `--place lan`（M8-X1）；页面外的连接从 `createWsEndpoint` 换成会话层 `createDocEndpoint`（同 `render-host-probe.mjs`）；文件头「主机同步写进 `src/cards/user/`、收尾删掉」改成「同步来的新卡只进改动层」，并加断言（本检出原来没有这张卡时，检出目录里不多出它）；L3 开关 `--heavy slow-stepped｜pinned`，C10 合入 main 之后缺省 `slow-stepped`（`probe-slow-stepped`，不再钉死），`pinned` 留作对照 |

### 1.1 设计要点

- **真实细任务**：同 `ht-w-probe.mjs`：creator 起队列模式编辑器（PC 节点，并发 1），推一份「N 条轨道 × S 秒 `r6-canvas`、参数带本轮盐」的项目、preload，PC 节点认领 `plan`、切分；host 起 `scripts/render-host.mjs`。缺省 E1 10 × 10 s = 50 个细任务。
- **J-恰一**：发布方（PC 编辑器）诊断的 `doneCounts` 差值；epoch 取旁观节点收到的消息里的 `epoch`。E3 按 epoch 分两份（D3）：lan 取结束进程那一刻的计数，云端由 250 ms 一次的轮询取断开那一刻的计数。
- **J-纯层**：每个细任务两条观察——任务的 `requires.envFingerprint`（旁观节点从 `task.opened` 里记）与完成它的节点的指纹（PC 取诊断 `local.completed/dedup`，主机取预渲染进程诊断的 `node.completed/dedup` 事件，每秒收一次）。
- **E1 假任务那一轮**：任务带专用指纹（`fingerprintOf('m8e-fake-tasks')`），真节点被前置过滤挡在外面；PC、host-a、host-b 各起一个同指纹的假节点。
- **E1 与单机重渲逐字节比较**：同 `render-host-probe.mjs` 的 check：另起普通模式编辑器（不走队列、不推送、空帧库）preload 同一份项目，逐个比快照文件。
- **E2**：受害主机经代理连文档服务，第一次持有任务时 `stall`（开着的与新来的连接都只攒不转），写 KV `signal.stall`；creator 从收到信号起按旁观节点的时间线量「放回」（`opened`）与「被别人认领」（`taken`）；接手后写 `takeover`，受害方 `resume`，核它手里的任务一律 `lease-lost`、不再完成。
- **C1（主会话 2026-09-28 更正、`constraints.md`「不动宿主机的网络」）**：受害主机加 `--stall-s 30`：stall 30 s 后自己 resume，不等接手；「被接手（放回 ≤ 37 s）」与「会话保留期内接续、照常由受害方完成」两种结局都认，结果行 `victim.outcomes`、`victim.session.kind`（`new-session`／`resumed`）写明是哪一种。探针不碰网卡、防火墙、系统代理、路由、DNS。
- **E3**：lan（C4）由 creator 结束自己起的局域网主机编辑器进程树、同端口再起（D2）；cloud（C2）写 KV `signal.restart.request` 并把命令打到 stderr（`{"step":"remote-step",…}`），等主会话写 `signal.restart.done`。之后重新推送同一版项目、preload。判 epoch 变了、J-全完、J-恰一（按 epoch）、重启前已完成的任务重启后 0 次重渲、主机重连；lan 另判「重连之后从局域网发现又拿到主机地址」≤ 10 s，云端记 `service.endpoints` 的撤回与重新下发。
- **E4**：后台一版真实任务在跑时，`agent` 角色（成员凭证 + 对话号 1）连项目，对项目真身（`project.op` 带 `expectRev`）三轮突发，每轮 50 次；同时一个 `page` 角色每 100 ms 写一次（不带期望版本）逼出 `stale`，Agent 遇 `stale` 就 `project.open` 重读再写。每轮结束核文档服务的摘要、PC 这边的副本、host 那边的副本三份相同。「页面」是 Node 里按页面同一条协议（`project.open` + 逐版应用 `project.ops`，同一个 `applyOps`）维持的副本，不是浏览器页面。
- **E6**：host-a 加 `--fake-fingerprint`（测试开关 `PROMPTCUT_TEST_ENV_FINGERPRINT`）；先用公共件的 `fingerprintApplied()` 判开关生没生效，不生效整例记跳过与理由。C10 合入后已生效、已真跑（第 2 节）。反方向（主机先认领无指纹的 plan）要在线页面发布，本探针不起在线页面，记跳过理由；纯浏览器节点（D12 的 b）`--browser-node` 只留接口与跳过理由，等 M7。

## 2. 验证

### 2.1 基线

（见第 2.3 节末的最终基线。）

### 2.2 本机替身（--place lan，原样结果行摘录）

（见下。）

## 3. 用法（PC 与第二台机器）

（见下。）

## 4. 需要主会话在远端执行的步骤

（见下。）

## 5. 没做成的、发现的问题、与计划不一致之处

（见下。）
