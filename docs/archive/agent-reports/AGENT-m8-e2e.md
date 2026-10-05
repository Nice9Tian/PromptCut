# AGENT-m8-e2e 报告

分支 `claude/m8-e2e`，worktree `.worktrees/m8-e2e`，端口段 5740～5749（托管组合与协调口用端口 0；本机替身里 ht-w / c66-t9 的协调口用 5749）。
基于 `278eeb9`，合入 `claude/m8-kit`（`4b18d64`），中途两次合入 main（`d3b674d`「不动宿主机的网络」之后的 main；C10 合入后的 main，含 `51f01c4`）。
任务：M8 计划（`docs/plan/m8-plan.md`）第 4 节第 4～6 项。

代号：**M8** = 分布式预渲染队列任务书的最后一个阶段「多端物理联调」；**E1～E6** = 任务书第 6 节的端到端用例（抢活、断网接手、文档服务重启、Agent 突发修改、纯浏览器只见本人任务、两种指纹）；
**J-全完 / J-恰一 / J-纯层** = 计划第 2 节开头的三条共用判据（任务全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹）；
**C1 / C2 / C4 / C5-2** = 计划第 2.6 节的混沌项（节点断网 30 s、云端 `pm2 restart`、放本机时重启 PC 的局域网主机编辑器、放本机时代理侧切断后会话接续）；
**D2 / D3 / D12** = 计划末尾主会话裁定（「主机素材服务重启」按重启整个编辑器进程算、「恰好一次」按 epoch 数、E6 的第二种指纹两种都做）；
**M8-X1** = 放本机版 T9（PC 当局域网主机、第二台机器经局域网直连加入，C6.6 留下的跨机项）；**L3** = 计划第 5 节「T9 用确定判重的探针卡代替人工钉死」。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `scripts/probes/m8-e-probe.mjs`（新） | E1、E2（含 C1 的 `--stall-s`）、E3（C2 / C4）、E4、E6 的编排。`--place cloud｜lan`；角色 `creator`、`host`、`watcher`（可选的独立旁观节点）、`signal`（主会话写回远端步骤完成的信号）、`all`（本机替身）；`--fake-fingerprint`、`--via-proxy`、`--stall`、`--stall-s`、`--burst`、`--gaps`、`--keep`、`--browser-node`。用法、KV 键、各用例判据写在文件头 |
| `scripts/probes/ht-w-probe.mjs`（改） | `--place lan`（C5-2）：creator 以局域网主机起编辑器（`PROMPTCUT_LAN_HOST=1`）、在本机建局域网项目；host 经局域网发现（`--lan-host` 兜底）找主机，代理转到发现的地址；局域网主机的 `/api/docservice/healthz` 只答回环，`sessions.resumed` 由 creator 在 `host.holding` / `host.resumed` 时读，判 `lan-healthz-resumed` |
| `scripts/probes/c66-t9-probe.mjs`（改） | `--place lan`（M8-X1）；页面外的连接从 `createWsEndpoint` 换成会话层 `createDocEndpoint`（同 `render-host-probe.mjs`）；文件头「主机同步写进 `src/cards/user/`、收尾删掉」改为「同步来的新卡只进改动层」，并加断言（本检出原来没有这张卡时检出目录里不多出它）；L3 开关 `--heavy slow-stepped｜pinned`，C10 合入后缺省 `slow-stepped`（不再钉死），`pinned` 留作对照 |

设计要点：

- **真实细任务**同 `ht-w-probe.mjs`：creator 起队列模式编辑器（PC 节点，并发 1），推「N 条轨道 × S 秒 `r6-canvas`、参数带本轮盐」的项目、preload；host 起 `scripts/render-host.mjs`。E1 缺省 10 × 10 s = 50 个细任务。
- **J-恰一**用发布方（PC 编辑器）诊断的 `doneCounts` 差值；epoch 取旁观节点收到的消息里的 `epoch`。E3 按 epoch 分两份（D3）：lan 取结束编辑器进程那一刻的计数，云端由 250 ms 一次的轮询取断开那一刻的计数。
- **J-纯层**：每个细任务两条观察——任务的 `requires.envFingerprint`（旁观节点从 `task.opened` 里记）与完成它的节点的指纹（PC 取诊断 `local.completed/dedup`，主机取预渲染进程诊断里的 `node.completed/dedup` 事件）。
- **E1 假任务那一轮**：任务带专用指纹，真节点被前置过滤挡在外面；PC、host-a、host-b 各起一个同指纹的假节点。另做「与同指纹单机重渲逐字节比较」（同 `render-host-probe.mjs` 的 check）。
- **E2**：受害主机经代理连文档服务，第一次持有任务时 `stall`，写 KV `signal.stall`；creator 从收到信号起按旁观节点的时间线量「放回」（`opened`，判 ≤ 37 s）与「被别人认领」（`taken`，只记录，见第 5 节第 2 条）；接手后写 `takeover`，受害方 `resume`，核它的旧认领作废（`lease-lost`，或断线期间执行已失败、恢复后报的带旧令牌不作数）且不再完成。
- **C1**（主会话 2026-09-28 更正、`constraints.md`「不动宿主机的网络」）：受害主机加 `--stall-s 30`，stall 30 s 后自己 resume，不等接手；「被接手（放回 ≤ 37 s）」与「会话保留期内接续、照常由受害方完成」两种结局都认，结果行 `victim.outcomes`、`victim.session.kind` 写明是哪一种。探针不碰网卡、防火墙、系统代理、路由、DNS。
- **E3**：lan（C4、D2）由 creator 结束自己起的局域网主机编辑器进程树、同端口再起；cloud（C2）写 KV `signal.restart.request`、把命令打到 stderr，等主会话写 `signal.restart.done`。之后重新推送同一版项目、preload。
- **E4**：后台一版真实任务在跑时，`agent` 角色（成员凭证 + 对话号 1）对项目真身 `project.op` 带 `expectRev` 三轮突发（每轮 50 次）；同时一个 `page` 角色每 100 ms 写一次（不带期望版本）逼出 `stale`，Agent 遇 `stale` 就 `project.open` 重读再写；每轮结束核文档服务的摘要、PC 这边的副本、host 那边的副本三份相同。
- **E6**：host 加 `--fake-fingerprint`（测试开关 `PROMPTCUT_TEST_ENV_FINGERPRINT`），先用公共件的 `fingerprintApplied()` 判开关生没生效，不生效整例记跳过与理由。C10 合入前本机替身跑过一次「跳过」（开关没生效，理由正确记下）；C10 合入后已真跑（第 2.2 节）。

提交（不含合并）：`ed810ae` 报告骨架；`474216d` m8-e-probe 初版；`60901b7` 局域网主机素材服务按文档服务地址推等；`370e319` ht-w-probe `--place lan`；`412381b`、`2376482` c66-t9-probe；`c2cce05` 修取回产物的变量遮蔽、加 `--stall-s`；`ce75be6` C10 合入后 c66-t9 缺省 slow-stepped、E2 判据；`1bd9cf2`、`86e4c9f`、`0644d5e` 小修；另有本报告的提交。

## 2. 验证

### 2.1 基线（最后一次合入 main 之后）

- `npx tsc -b --force` → 退出码 0。
- `npm test` → 退出码 0：tests 3634，pass 3632，fail 0，skipped 2。
  （更早一轮 3455 条里挂过 1 条 `artifact-push.test.mjs` W5「按 5 s、30 s 退避重试」——当时本机同时在跑 E1 的三个 Chrome；单独按 `npm test` 的参数重跑该文件 3 次 7/7 全过，不是本分支改动引起的，本分支没动 `server/`。）
- 本分支只改 `scripts/probes/` 与本报告，不动渲染路径，G0-R 不跑。

### 2.2 本机替身（`--place lan`，PC 一台机器上起全部角色；原样摘录结果行）

机器上同时有十来个子智能体在跑，真实细任务很慢（E1 首轮 50 个细任务 35 min）；后几轮加了 `--host-concurrency 1` 减负。局域网地址 192.168.50.96，本机托管组合只用来判「全程不连托管端」。

**E1**（`node scripts/probes/m8-e-probe.mjs --role all --case e1 --place lan --host-concurrency 1 --timeout-min 80`）：退出码 0，`"ok":true`，`"ms":2924951`，`"fails":[]`
```
PASS creator:real:tasks>=50 {"tasks":50}
PASS creator:real:artifacts {"assetUrl":"http://192.168.50.96:5740/api/asset","announced":false,"manifests":50,"missingManifests":[],"blocks":3540,"bytes":206526686,"badBlocks":[]}
PASS creator:real:manifests-applied {"applyErrors":0,"applied":42}
PASS creator:real:J-all-done {"total":50,"done":50,"notDone":[]}
PASS creator:real:J-exactly-once {"total":51,"epochs":["dbfac315-…"],"dup":[],"missing":[],"stray":0}
PASS creator:real:J-pure-layers {"layers":10,"observed":100,"unknown":0,"mixed":[],"attributed":50,"tasks":50}
PASS creator:real:each-worked {"nodes":3,"idle":[],"sum":50,"total":50}        realWork {"pc":9,"host-a":21,"host-b":20}
PASS creator:fake:J-all-done {"total":50,"done":50,"notDone":[]}
PASS creator:fake:J-exactly-once {"total":50,…,"dup":[],"missing":[]}
PASS creator:fake:J-pure-layers {"layers":10,"observed":100,"unknown":0,"mixed":[]}
PASS creator:fake:each-worked {"nodes":3,"idle":[],"sum":50,"total":50}        fake work {"pc":17,"host-a":17,"host-b":16}
PASS creator:real:identical-to-single {"dirs":10,"singleFiles":3010,"creatorFiles":3010,"htmlFiles":3000,"styleOrderOnly":0,"differentFrames":0,"identicalBytes":true,"identical":true}
PASS creator:cloud-untouched {"before":1,"after":1,"reachable":true}
PASS host-a:lan-found {"ms":1561,"via":"discover","firstSeenMs":17}   （host-b 同）
```
首轮（`--host-concurrency 2`）没过：1 个细任务 `stalled`（画面 120 s 不动，机器过载）、另一个「导出页 60 秒没就绪」后重试成功；并暴露探针自己的一个错（取回产物时变量遮蔽，逐段取回一个也没取，`c2cce05` 修）。

**E2 半开接手**（`--case e2 --place lan --clips 4 --seconds 10 --host-concurrency 1`）：退出码 0，`"ok":true`，`"ms":506136`
```
PASS creator:stall-signal {"by":"host-a","held":["snapshot:555ac9…:0-59"]}
PASS creator:reopened<=37s {"limitMs":37000,"per":[{"id":"snapshot:555ac9…:0-59","reopenMs":34038,"ms":119920}]}
PASS creator:taken-over
PASS creator:e2:J-all-done {"total":20,"done":20}   e2:J-exactly-once {"dup":[],"missing":[]}   e2:J-pure-layers {"layers":4,"mixed":[]}
PASS creator:victim-old-claim-void {"lost":[{"id":"snapshot:555ac9…:0-59","sinceResumeMs":1033}],"session":{"opens":[1,2],…}}
PASS creator:victim-no-double-done {"completedHeld":[]}
PASS host-a:proxy-stall-resume {"stall":"control.stall","resume":"control.resume"}
```
前一轮（同命令）只挂 `victim-lease-lost`：受害方的执行在断线期间先失败了（「取不到项目快照…30000 ms 内没有回包」），它那边记成 `failed` 而不是 `lost`，旧认领照样作废、没有第二次 `task.done`。判据改成「旧认领作废」（`0644d5e`）。

**C1 应用层断线 30 s**（`--case e2 --place lan --stall-s 30 --clips 4 --seconds 10 --host-concurrency 1`）：退出码 0，`"ok":true`，`"ms":516219`
```
PASS creator:stall-signal {"held":["snapshot:299777…:180-239"],"seconds":30}
PASS creator:c1-outcome {"limitMs":37000,"per":[{"id":"snapshot:299777…:180-239","outcome":"takeover","ms":30163,"reopenMs":30022}]}
PASS creator:e2:J-all-done {"total":20,"done":20}   J-exactly-once {"dup":[],"missing":[]}   J-pure-layers {"mixed":[]}
PASS creator:victim-old-claim-void   PASS creator:victim-no-double-done {"completedHeld":[]}
victim {"mode":"c1-fixed","session":{"opens":[1,1],"resumes":[0,0],"kind":"unchanged"},"outcomes":["takeover"]}   stalledMs 30084
```
结局是「被接手」（放回 30.0 s、认领 30.2 s）；代理 stall 时 TCP 没断，受害方的会话没有脱开也没有重建（`kind: unchanged`）。

**E3 / C4**（`--case e3 --place lan --clips 4 --seconds 10 --host-concurrency 1 --restart-after-done 4`）：退出码 0，`"ok":true`，`"ms":518425`
```
PASS creator:restart-window {"needDone":4,"planA":{"tasks":20}}          restart {"how":"lan-editor","killMs":603,"upMs":6815}
PASS creator:epoch-changed {"epochA":"cb71f592-…","epochB":"b371cc11-…"}
PASS creator:same-split {"a":20,"b":20}
PASS creator:after:J-all-done {"total":20,"done":20}   after:J-exactly-once   after:J-pure-layers {"mixed":[]}
PASS creator:J-exactly-once-per-epoch {"total":21,"epochs":["cb71f592-…","b371cc11-…"],"dup":[],"missing":[]}
PASS creator:no-rerender-of-done {"doneBeforeRestart":4,"rerendered":[]}
PASS creator:reconnected-host-a {"reconnected":true,…}
PASS creator:endpoint-reannounced-host-a   （lan：重连之后 1618 ms 从局域网发现又拿到主机与素材服务地址，限 10 000 ms）
```
前一轮只挂「重新下发」：编辑器几秒就起来了，每 2 s 一次的发现轮询没撞上「查不到」的窗口；改成量「重连之后第一次查到」（`86e4c9f`）。

**E4**（`--case e4 --place lan --clips 6 --seconds 10 --host-concurrency 1`）：退出码 0，`"ok":true`，`"ms":1198892`
```
gap 0:   landed 50/50, stale 0,  attempts 50, burstMs 118,   rev 52,  server = pc = host-a = 441fa212fe91e338
gap 200: landed 50/50, stale 49, attempts 99, burstMs 10518, rev 197, server = pc = host-a = 1db71e2e33f3bba9
gap 900: landed 50/50, stale 49, attempts 99, burstMs 45417, rev 659, server = pc = host-a = 9c0862452d41c4a3
PASS creator:stale-exercised   PASS creator:background-not-starved (doneDuringBurst 0 / 0 / 1)
PASS creator:background:J-all-done {"total":30,"done":30}   J-exactly-once   J-pure-layers {"layers":6,"mixed":[]}
PASS host-a:replica-matches [{"k":0,"rev":52,"match":true},{"k":1,"rev":197,"match":true},{"k":2,"rev":659,"match":true}]
```

**E6**（C10 合入后；`--case e6 --place lan --host-concurrency 1`）：退出码 0，`"ok":true`，`"ms":954718`
```
host-a ready envFingerprint 6239b3c74bc0b937（测试开关生效；PC 是 258acaaa7c5fe509）
PASS creator:e6:J-all-done {"total":20,"done":20}   e6:J-exactly-once {"dup":[],"missing":[]}   e6:J-pure-layers {"layers":4,"mixed":[]}
PASS creator:other-fingerprint-claimed-0-host-a {"claimed":0,"ids":[],"envFingerprint":"6239b3c74bc0b937"}
skipped: reverse（理由见结果行）
```
C10 合入前同一命令：`"ok":true`，`skipped[0]` = 「测试开关 PROMPTCUT_TEST_ENV_FINGERPRINT 没生效（host-a 报 258acaaa7c5fe509，要 6239b3c74bc0b937）…」。

**C5-2**（`node scripts/probes/ht-w-probe.mjs --role all --place lan --coord http://127.0.0.1:5749 --port 5740 --proxy-port 5746`）：退出码 0，`"ok":true`，`"ms":382801`，27 条全过，其中
```
PASS host:lan-found {"ms":1538,"via":"discover","firstSeenMs":15}
PASS host:cut   PASS host:session-resumed {"resumes":[0,1],"logged":{"detach":true,"resume":true,"open":false,"close":false}}
PASS host:not-new-session {"opens":[1,1]}   PASS host:held-no-lease-lost   PASS host:held-single-claim [{"taken":1,"reopened":0,"closed":["done"],"done":1}]
PASS creator:lan-healthz-resumed {"resumedSignal":true,"before":0,"after":1}
PASS creator:done-exactly-once   PASS creator:host-worked {"pc":3,"host":13,"tasks":16}
```

**M8-X1**（`node scripts/probes/c66-t9-probe.mjs --role all --place lan --coord http://127.0.0.1:5749 --port 5740`，缺省 `--heavy slow-stepped`）：退出码 1，`"ok":false`。creator、host 两角色全过，observer 挂在素材层：
```
creator: heavy {"mode":"slow-stepped","cardId":"probe-slow-stepped","frameMode":"stateful","compositing":"independent","control":{"picked":true,"tier":"shared"}}
         plan {"tasks":8,"done":8,"failed":0,"planDoneCount":1,"pcPlanClaimed":true,"stats":{"applied":8,"applyErrors":0}}
         pause {"skipped":"lan","smallComplete":true,"originalComplete":true}
host:    ok true，discovery found，claimed 5 / completed 5，cardV2 {"ms":223,"rev":2,"inOverlay":true,"baseUntouched":true}
observer: discovery found；installMs 207、remeasureMs 4698（卡片源码 5 s 内装上并重测）；
          FAIL 超时:[observer] 素材层第一次解出画面 → 其后素材换档各条连带失败
```
原因见第 5 节第 1 条（产品缺口，不在本分支文件清单里）。`probe-slow-stepped` 当重卡：两端都判重、进预渲染集合（`picked: true`），不用钉死，L3 已切换。

跑完核对：命令行含 `m8-e2e` / 本探针临时目录的 node、chrome 进程 0 个，5740～5749 上的监听 0 个。

## 3. 用法（PC 与第二台机器）

通用：各机都要 `PROBE_MAIL_TOKEN`（阿里云协调口开着信箱；`probe-coord.mjs serve` 也要它）。PC 端口 5780～5789（creator 5780～5782，E1 单机重渲比较占 5783～5785）。`--run` 两边给同一个；不给时 host 从 KV `m8e.latest` 取 10 分钟内的。
「第二台机器」按主执行计划 2026-09-28 第二次同日补充：笔记本离线期间是云端工作节点（只能出网，另设 `NODE_USE_ENV_PROXY=1`、`PC_CHROME_ARGS=--no-sandbox`，渲染主机原样继承）；笔记本回来后用笔记本（5580～5599）。

### 3.1 m8-e-probe.mjs 放云端（`--coord https://8-219-80-16.sslip.io/coord --hosted https://8-219-80-16.sslip.io/hosted`）

| 用例 | PC | 第二台机器 |
|---|---|---|
| E1 | `node scripts/probes/m8-e-probe.mjs --role creator --case e1 --place cloud --coord <协调口> --hosted <托管端> --port 5780 --run <id>` | `node scripts/probes/m8-e-probe.mjs --role host --name host-a --case e1 --place cloud --coord <协调口> --port 5583 --run <id>`；再起 `--name host-b --port 5586` |
| E2 | creator 同上 `--case e2` | 受害方 `--role host --name host-a --case e2 --place cloud --via-proxy 5596 --proxy-target 8.219.80.16:8787 --stall`；另一台 `--name host-b`。云端工作节点只经 HTTP 代理出网、TCP 代理连不了 8787 时，受害方放 PC（`--port 5786 --via-proxy 5789`），云端当 host-b |
| C1 | 同 E2 | 受害方加 `--stall-s 30` |
| E3（C2） | `--case e3 --hosts host-a`；到时见第 4 节 | `--role host --name host-a --case e3` |
| E4 | `--case e4 [--burst 50 --gaps 0,200,900]` | `--role host --name host-a --case e4` |
| E6 | `--case e6 --hosts host-a` | `--role host --name host-a --case e6 --fake-fingerprint <16 位十六进制>` |

`--keep`：不删探针项目（迁移演练第 0 步要 E1 放云端留下的项目），结果行 `kept` 给项目 id 与名，口令在 PC `--out` 下的 `creator.json`。

### 3.2 m8-e-probe.mjs 放本机（第二台机器要和 PC 同网段，只能是笔记本；云端工作节点不在局域网里）

- PC：`node scripts/probes/probe-coord.mjs serve --host 0.0.0.0 --port 5789`；`node scripts/probes/m8-e-probe.mjs --role creator --case <e1…e6> --place lan --coord http://<PC 局域网地址>:5789 --port 5780 [--lan-ip <PC 局域网地址>] --run <id>`（E3 的 C4 由 creator 自己重启局域网主机编辑器）
- 笔记本：`node scripts/probes/m8-e-probe.mjs --role host --name host-a --case <同> --place lan --coord http://<PC 局域网地址>:5789 --port 5583 --run <id>`，E1、E2 另起 `--name host-b --port 5586`；发现不了加 `--lan-host <PC 局域网地址>:5780`；E2 / C1 的受害方加 `--via-proxy 5596 --stall [--stall-s 30]`；E6 加 `--fake-fingerprint …`
- 本机替身：`node scripts/probes/m8-e-probe.mjs --role all --case <e1…e6> --place lan [--host-concurrency 1]`（5740～5749；`--place cloud` 用本机临时托管组合当托管端，e3 由本进程重启它）

### 3.3 ht-w-probe.mjs `--place lan`（C5-2）

- PC：`probe-coord.mjs serve --host 0.0.0.0 --port 5789`；`node scripts/probes/ht-w-probe.mjs --role creator --place lan --coord http://<PC 局域网地址>:5789 --port 5780 --run <id>`
- 笔记本：`node scripts/probes/ht-w-probe.mjs --role host --place lan --cut proxy --coord http://<PC 局域网地址>:5789 --run <id> --port 5583 --proxy-port 5596 [--lan-host <PC 局域网地址>:5780]`
- 本机替身：`node scripts/probes/ht-w-probe.mjs --role all --place lan --coord <本机协调口> --port 5740 --proxy-port 5746`

### 3.4 c66-t9-probe.mjs `--place lan`（M8-X1）

- PC：`probe-coord.mjs serve --host 0.0.0.0 --port 5789`；`node scripts/probes/c66-t9-probe.mjs --role creator --place lan --coord http://<PC 局域网地址>:5789 --port 5780 --run <id>`
- 笔记本：`--role observer --place lan --coord … --port 5590 --run <id>`；`--role host --place lan --coord … --port 5583 --run <id>`（发现不了加 `--lan-host <PC 局域网地址>:5780`）
- 放云端照旧。两种放法都缺省 `--heavy slow-stepped`，对照旧做法加 `--heavy pinned`。

## 4. 需要主会话在远端执行的步骤

探针不连阿里云做破坏性操作；要远端做的都是「等 KV 信号 → 打印命令 → 等 KV 完成信号」。

| 用例 | 探针等的信号 | 主会话执行 | 写回 |
|---|---|---|---|
| E3 放云端（C2） | KV `m8e.<run>.signal.restart.request`（creator 在 ≥ `--restart-after-done`（缺省 5）个细任务完成、且主机写了 `signal.holding.<名>` 时写；stderr 同时打 `{"step":"remote-step","cmd":…,"then":…,"key":…}`） | `ssh <远端> "pm2 restart promptcut-hosted && pm2 describe promptcut-hosted"`；前后各读一次 `https://8-219-80-16.sslip.io/hosted/healthz`（epoch、sessions） | `node scripts/probes/m8-e-probe.mjs --role signal --coord https://8-219-80-16.sslip.io/coord --run <run> --name restart.done [--value '{"pm2Restarts":<n>}']`（等 30 min） |
| C5-1（`ht-w-probe.mjs --cut external`，本分支未改） | KV `htw.<run>.host.holding` | 阿里云上 `ss -K` 切那台主机到 8787 的连接 | `PUT /coord/kv/htw.<run>.cut.done`（带 `X-Mail-Token`） |

C1、C3、C4、E2、C5-2 都在应用层（本机代理、本机进程），不要远端步骤。

## 5. 没做成的、发现的问题、与计划不一致之处

1. **M8-X1 本机替身没过：放本机的项目里，成员页面拿不到主机的素材服务**（疑似产品缺口，不在本分支文件清单里，没改）。
   局域网主机编辑器不向 `service.endpoints` 登记素材服务（`server/vite-plugin-media.ts` 只在设了 `PROMPTCUT_DOCSERVICE_URL` 时登记）；独立渲染主机对此有兜底（`server/vite-plugin-frames.ts` 的 `hostAssetClient` 从文档服务地址推 `http://<主机>/api/asset`），页面没有：`src/editor/media/assetTiers.ts` 的 `pickAssetEndpoint` 挑不到就留在本地素材服务，`syncManager` 也不用局域网发现通告里的 `asset` 字段。观察端页面因此一直问自己的本地素材服务，视频素材始终解不出画面（`firstShown: null`）。卡片源码同步、主机认领与产物、重测都正常。
   建议：页面在「局域网候选、登记里没有素材服务」时，按文档服务地址推同一进程的素材服务（与 `hostAssetClient` 同一条规则），或用发现通告的 `asset`；修在 `src/editor/media/assetTiers.ts`（二级承诺「成员连本机项目的主机」已覆盖，属代码向语义靠）。修好后重跑第 3.4 节的本机替身。
2. **E2 的「≤ 37 s 被另一节点认领」拆成两条**：放回（`opened`）用时判 ≤ 37 s（本机 34.0 s、34.4 s，C1 30.0 s）；被认领（`taken`）只记录（62 s、120 s）。放回之后要等某个节点有空槽，本机替身上各节点都在做 60～120 s 的长任务。计划第 2.1 节 E2 的判据建议按此改写，或跨机时把 host-b 的并发调大。
3. **E2 受害方的旧认领不一定以 `lease-lost` 收场**：断线期间受害方的执行可能先失败（取项目快照 30 s 超时），恢复后报 `fail` 带旧令牌、不作数。判据写成「旧认领作废（lease-lost 或断线期间执行失败）、受害方不再完成、J-恰一」。
4. **C1 的结局**：代理 `stall` 不断 TCP，受害方会话既没脱开也没重建（`kind: unchanged`），30 s 后租约到期被接手。要证「会话保留期内接续、照常完成」那一种结局，得让 stall 短于租约（如 `--stall-s 10`）；探针两种都认。
5. **局域网主机的健康检查只答回环**：`ht-w-probe` 的 C5-2 由 creator 代读（`lan-healthz-resumed`）；m8-e-probe 的 E3 lan 只能从主机侧量「重连后多久又从局域网发现拿到地址」，不能量 `service.endpoints`（局域网主机不登记，见第 1 条）。
6. **E4 的「页面」是 Node 副本**：按页面同一条协议（`project.open` + 逐版应用 `project.ops`，同一个 `applyOps`、同一摘要算法）维持，不是浏览器页面；「突发期间至少完成 1 个细任务」按三轮合计判（间隔 0 的一轮只有 118 ms）。
7. **E6**：反方向（主机先认领不带指纹的 plan）要在线页面发布，本探针的发布方是桌面编辑器，记跳过理由，建议用 `c10-browser-probe.mjs` 的跨机模式做；纯浏览器节点（D12 的 b）只留 `--browser-node` 接口与跳过理由，等 M7。
8. **E1 缺省 50 个真实细任务在本机替身上很慢**（35～49 min），跨机时注意 `--timeout-min`（缺省 40，本机替身用了 80）。
9. **放本机的跨机项现在都做不了**：云端工作节点不在 PC 的局域网里，笔记本离线；E1～E6 放本机、C5-2、M8-X1 的真跨机那一遍等笔记本（待跨机复核）。
10. 计划第 4 节第 6 项写「L3 要 C10 合入后」：C10 已合入，已切换（缺省 `slow-stepped`）；`pinned` 那段代码留作对照，没删，主会话要删可以直接删。
