# AGENT-m8-scale 报告

分支 `claude/m8-scale`（从 `278eeb9` 拉出，已合 `claude/m8-kit` `4b18d64`），worktree `.worktrees/m8-scale`。
端口段 5750～5759；实际一个固定端口也没占，托管组合与协调口都用端口 0。没连阿里云。

代号：**M8** 是分布式预渲染队列任务书的最后一个阶段「多端物理联调」。**K1-X** 是计划 `docs/plan/m8-plan.md` 第 2.2 节「指纹前置过滤防锁风暴」的真实多端复测（原始定义是主执行计划第 7 节 M5b 的 K1、K2：两种指纹各 4 个节点、200 个任务、一半的卡被另一种指纹锁住）；
**I1-X** 是同节「按项目的频道隔离」的真实多端复测（原始定义是主执行计划 C6 的 I1、I2：20 个项目各 10 个节点，只 watch 本项目，对项目 A 连续做 500 次）。
**D4** 是计划第 7 节「K1 过滤关的对照组在哪跑」，主会话裁定「在 PC 本机跑」。**J-全完 / J-恰一 / J-纯层** 是计划第 2 节开头的三条共用判据（任务全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹）。

## 1. 做了什么

| 文件 | 内容 |
|---|---|
| `scripts/probes/m8-scale-probe.mjs`（新） | 探针本体。角色 `coordinator` / `worker` / `coord+nodes` / `all`（本机替身），用例 `--case k1` / `--case i1`，放法 `--place cloud` / `lan` / `local`。只 import 公共件 `scripts/probes/m8/`，不改公共件。纯逻辑（任务表、节点账本、K1 / K2 / I1 / I2 判据、D4 加载钩子）导出给单测 |
| `server/test/m8-scale.test.mjs`（新） | M8S-1～10，纯逻辑单测；M8S-10 起一个 node 子进程核 D4 钩子真的把 `PREFILTER` 缺省值改成 false、只改这一项 |
| `server/test/bakery-deps.test.mjs`（改一行名单 + 一行注释） | 依赖方向守门的例外名单加 `server/test/m8-scale.test.mjs`（同 m8-kit 的做法）。**越出了计划第 6 节给本分支的文件清单**（只列了 `m8-scale-probe.mjs`）；不加这一行全量测试会红一条 |
| 本报告 | |

### 探针怎么工作

- **一个进程开多个假节点连接**：用公共件 `startFakeNode`（`createLocalNode` + 睡 taskMs 的执行器，即 `render-queue-e2e.mjs` 的写法），profile `pc`，每个节点挂一个账本（`onMessage` 收这条连接上的每条业务消息）。
- **两台机器经协调口 KV 汇总**（前缀 `m8sc`，键名约定同 `scripts/probes/m8/kv.mjs`）：coordinator 建探针共享项目、写 config（含成员口令，只进 KV）；各 worker 读 config、开节点、全部连上后写 `ready.<名>`；coordinator 跑用例、写 `done`；各 worker 把每个节点的计数写 `result.<名>`；coordinator 汇总判据、删项目。worker 没给 `--run` 时从 `m8sc.latest` 取本轮 id。
- **K1**：任务表按 M5b 场景台（`render-queue-prefilter.test.mjs` 的 runStorm）：20 张卡 × 2 种指纹 × 5 段 = 200；卡 0～9 锁指纹 X、10～19 锁 Y；指纹与锁不同的 100 个是死任务（锁之前发布），相同的 100 个是活任务（锁之后发布）。
  锁由发布方连接发 `card.lock`（`PUBLISHER_TYPES` 里有它）。另有一个不带指纹的旁观节点（前置过滤对它不生效），核「死任务从没被认领」。
  - `--order join-first`（缺省，M5b 的顺序）：节点全部报到 → 发布死任务并紧接着（不等回包）锁 20 张卡 → 全部 `card.locked` 后发布活任务。
  - `--order lock-first`：节点报到之前就发布死任务并锁卡，节点只见锁定之后的世界。
  - 「稳态」「竞态窗口」按节点自己的消息顺序切：收到第一条活任务的 `task.opened` 之后是稳态（不靠两台机器的时钟）。每个节点另记它看到的竞态窗口时长（第一次看见本指纹死任务 → 最后一条 hidden 撤回，本机时钟）。
  - K2 计法：活任务里锁指纹与节点不同的，收到就算；死任务在锁定之前的第一次可见不算，撤回之后再可见、或第二次可见才算。
- **I1**：20 个队列项目 `i1p01`～`i1p20`，每个 10 个节点只 watch 本项目；A = `i1p01`，按 `--batch 50` 一批、上一批全完成再发下一批，共 500 个任务。
  队列项目按编号轮流分到 `--spaces` 个探针共享项目里（缺省 2）：同一共享项目里的节点证 watch 隔离，另一个共享项目里的节点证空间隔离。
  I1：非 A 的节点收到 A 的消息 0 条，也收到任何任务消息 0 条。I2：A 的每个任务 `task.closed(done)` 的投递次数 = watch 了 A 的连接数；opened / taken 不许超过（队列对它们带合并键，少了只记偏差）。
- **D4 对照组怎么关过滤**：查过了，没有运行时开关。`QUEUE_ENV.PREFILTER` 只登记了环境变量名，`shared-service.mjs` 挂队列时不传 constants。本探针不改生产代码：`--role all --prefilter off` 起托管组合子进程时，经 NODE_OPTIONS 挂一个模块加载钩子，只把 `server/render-queue/constants.mjs` 里的 `PREFILTER: true` 换成 false，并在子进程 stderr 打一行 `m8scale.prefilter-off` 作凭证，探针核这行在（检查项 `prefilter-off-hook-applied`）。只给本机替身用，coordinator 在 `--place cloud/lan` 下拒绝 `--prefilter off`。
- `--sample`（I1 放云端）用公共件 `startSampler` 采阿里云 RSS、CPU、网卡，要 `PROMPTCUT_REMOTE`。本机没跑。

## 2. 用法（给 PC 与笔记本）

令牌不上命令行：协调口开了信箱时，两边都从环境变量 `PROBE_MAIL_TOKEN` 取。先起 PC（coordinator），再起笔记本；两边也可以都给同一个 `--run <id>`。

```
# K1-X 放云端（经阿里云主实例）
PC     node scripts/probes/m8-scale-probe.mjs --role coord+nodes --place cloud --case k1 --workers pc,laptop --fingerprint X --nodes 4 --tasks 200 --lock-half
笔记本 node scripts/probes/m8-scale-probe.mjs --role worker      --place cloud --case k1 --name laptop --fingerprint Y --nodes 4
       （两边都加 --order lock-first 就是纯稳态那一遍，见第 4 节第 1 条）

# I1-X 放云端（先演练实例：两边加 --hosted <演练实例的文档服务基址>；再主实例）
PC     node scripts/probes/m8-scale-probe.mjs --role coord+nodes --place cloud --case i1 --workers pc,laptop --projects 1-10 --sample
笔记本 node scripts/probes/m8-scale-probe.mjs --role worker      --place cloud --case i1 --name laptop --projects 11-20

# 放本机：两边把 --place cloud 换成 --place lan --lan-host <PC 局域网 ip:端口> --coord <PC 上的协调口>（coordinator 必须在 PC）

# 本机替身（一台机器上 coordinator + 两个 worker 进程模拟两台机器）
node scripts/probes/m8-scale-probe.mjs --role all --case k1
node scripts/probes/m8-scale-probe.mjs --role all --case k1 --order lock-first
node scripts/probes/m8-scale-probe.mjs --role all --case k1 --prefilter off       # D4 对照组
node scripts/probes/m8-scale-probe.mjs --role all --case i1
```

`coord+nodes` 在本机以子进程起一个 worker（`--name` 缺省 pc），其余参数照传。stdout 最后一行是结果行，`ok` 为假时退出码 1，参数不对时退出码 2。

## 3. 验证

### 3.1 基线

- `npx tsc -b --force` → 退出码 0。
- `npm test` → 退出码 0：tests 3465，pass 3463，fail 0，skipped 2（跳过的是既有的两条：`/api/cards/layout` 集成、SKILL 闸门集成）。
- `node --test server/test/m8-scale.test.mjs` → 10 条全过。

### 3.2 本机替身结果（原样摘自各轮 stdout 最后一行的 coordinator 检查项与 totals）

**K1-X，过滤开，`--order join-first`**（`node scripts/probes/m8-scale-probe.mjs --role all --case k1`）：退出码 1。

```
{"ok":false,"run":"mukbyqjs560f","prefilter":true,"fails":["coordinator: K1-card-locked :: {\"mode\":\"prefilter-on\",\"steady\":0,\"race\":8,\"claims\":133,\"raceLimit\":1}"],"ms":8687}
FAIL coordinator:K1-card-locked {"mode":"prefilter-on","steady":0,"race":8,"claims":133,"raceLimit":1}
PASS coordinator:K2-opened-mismatch {"mode":"prefilter-on","openedMismatch":0,"hiddenUnexpected":0}
PASS coordinator:K1-dead-never-claimed {"deadClaimed":0}
PASS coordinator:J-all-done {"total":100,"done":100,"notDone":[]}
PASS coordinator:J-exactly-once {"total":100,"epochs":["9e2fcbfc-eb1d-401b-b5b4-9242f9815974"],"dup":[],"missing":[],"stray":0}
PASS coordinator:J-pure-layers {"layers":20,"observed":200,"unknown":0,"mixed":[]}
PASS coordinator:watcher-dead-never-taken {"deadTaken":[]}
totals {"nodes":8,"claims":133,"claimed":100,"cardLockedRace":8,"cardLockedSteady":0,"openedMismatch":0,"hidden":400,"hiddenUnexpected":0,"deadClaimed":0,"cardLocked":8,"raceWindowMsMax":26}
liveToDoneMs 1880 deadPublishToAllLockedMs 37
```

第一轮同样的命令：`steady 0`、`race 4`、`claims 123`，同样挂在 1% 上（4 次全在 PC 这边的节点，它们的死任务对应后 10 把锁）。

**K1-X，过滤开，`--order lock-first`**：退出码 0。

```
{"ok":true,"run":"mukbyxel51d7","prefilter":true,"fails":[],"ms":8040}
PASS coordinator:K1-card-locked {"mode":"prefilter-on","steady":0,"race":0,"claims":127,"raceLimit":1}
PASS coordinator:K2-opened-mismatch {"mode":"prefilter-on","openedMismatch":0,"hiddenUnexpected":0}
PASS coordinator:K1-dead-never-claimed {"deadClaimed":0}
PASS coordinator:J-all-done {"total":100,"done":100,"notDone":[]}
PASS coordinator:J-exactly-once {"total":100,"epochs":["5a7ffe1f-c748-4d2e-b251-5470676871ad"],"dup":[],"missing":[],"stray":0}
PASS coordinator:J-pure-layers {"layers":20,"observed":200,"unknown":0,"mixed":[]}
PASS coordinator:watcher-dead-never-taken {"deadTaken":[]}
totals {"nodes":8,"claims":127,"claimed":100,"cardLockedRace":0,"cardLockedSteady":0,"openedMismatch":0,"hidden":0,"hiddenUnexpected":0,"deadClaimed":0,"cardLocked":0,"raceWindowMsMax":null}
```

**K1-X，D4 对照组（过滤关，PC 本机）**（`--role all --case k1 --prefilter off`）：退出码 0。

```
{"ok":true,"run":"mukbz3vf0ace","prefilter":false,"fails":[],"ms":11563}
PASS coordinator:K1-card-locked {"mode":"prefilter-off (control)","cardLocked":400,"steady":396,"race":4,"claims":527}
PASS coordinator:K2-opened-mismatch {"mode":"prefilter-off (control)","openedMismatch":400}
PASS coordinator:K1-dead-never-claimed {"deadClaimed":0}
PASS coordinator:J-all-done {"total":100,"done":100,"notDone":[]}
PASS coordinator:J-exactly-once {"total":100,"epochs":["5d3f67e5-3105-440e-aee1-632c60e3201e"],"dup":[],"missing":[],"stray":0}
PASS coordinator:J-pure-layers {"layers":20,"observed":200,"unknown":0,"mixed":[]}
PASS coordinator:watcher-dead-never-taken {"deadTaken":[]}
PASS prefilter-off-hook-applied {"hookApplied":true}
totals {"nodes":8,"claims":527,"claimed":100,"cardLockedRace":4,"cardLockedSteady":396,"openedMismatch":400,"hidden":0,"hiddenUnexpected":0,"deadClaimed":0,"cardLocked":400,"raceWindowMsMax":null}
```

对照组的 `card-locked` 是 400，与 M5b 本机场景台的 400 完全相同（每个死任务被同指纹的 4 个节点各撞一次：100 × 4）。活任务从发布到全部完成 4958 ms，过滤开时是 1880 ms。

**I1-X**（`--role all --case i1`；200 条连接，pc、laptop 两个 worker 各 100 条，2 个探针共享项目）：退出码 0，`ok: true`，`ms: 20069`。

```
PASS coordinator:workers-ready {"missing":[],"nodes":{"pc":100,"laptop":100}}
PASS coordinator:projects-covered {"served":20,"missing":[],"dup":[]}
PASS coordinator:published {"errors":[]}
PASS coordinator:I1-no-cross-project {"nodes":200,"nonANodes":190,"foreign":0,"nonATaskMsgs":0,"offenders":[]}
PASS coordinator:I2-delivery-equals-watchers {"tasks":500,"watchers":10,"closedDoneDelivered":5000,"closedDoneExpected":5000,"closedOff":[],"closedOffCount":0,"over":[],"coalesced":{"openedShort":0,"takenShort":0}}
PASS coordinator:J-all-done {"total":500,"done":500,"notDone":[]}
PASS coordinator:J-exactly-once {"total":500,"epochs":["44f9ba96-c51f-4768-9372-d5be63ace096"],"dup":[],"missing":[],"stray":0}
PASS coordinator:kv-no-401 {"puts":4,"gets":4,"unauthorized":0,"retries":0}
PASS coordinator:project-deleted ×2
perWorker: pc {"nodes":100,"aNodes":10,"taskMsgs":14500,"foreign":0,"completed":500,"lost":0,"failed":0}
           laptop {"nodes":100,"aNodes":0,"taskMsgs":0,"foreign":0,"completed":0,"lost":0,"failed":0}
publishToAllDoneMs 9624；托管端 /healthz 连接数：开跑前 1、全部就绪 201、收尾 2
```

A 的 10 个节点共收 14500 条任务增量 = 500 × (10 条 opened + 9 条 taken + 10 条 closed)，逐任务核对没有偏差，也没有被合并掉的（本机回环不慢）。

**两条命令分开跑**（scratchpad 里的小脚本起临时托管组合与协调口，再各起一个进程：`--role coord+nodes …` 与 `--role worker --name laptop …`；worker 不给 `--run`，从 KV 取）：
K1（`--order lock-first`）两边退出码都是 0，coordinator 15 条检查全过，`localWorker {"code":0,"ok":true}`；I1 两边退出码都是 0，coordinator 11 条检查全过。

跑完核对：命令行含 `m8-scale` / `m8sc` 的 node 进程 0 个；我起的托管组合都已退出（机器上剩下的 `hosted/main.mjs` 属于 `.worktrees/pause-precise`，不是我起的，没碰）。

## 4. 与计划不一致之处、更正建议

第 1～5 条主会话已逐条〔裁〕接受（第 1 条按裁定改了判据），已写进本分支的 `docs/plan/m8-plan.md` 第 2.2 节（原文、为什么改、改成什么）。

1. **K1 的「竞态窗口 ≤ 认领总数的 1%」在计划的规模下结构上过不了**。按 M5b 的顺序（节点先报到，再发布死任务并锁卡），真实连接上会有竞态窗口（本机测到最长 26 ms）：节点收到死任务的 `task.opened` 后、收到 hidden 撤回之前，只要 tick 了就会认领一次，然后被 `card-locked` 拒绝。
   每个节点同时只有一条在飞的认领，所以每阵锁变更最多被拒「节点数」次（8）。而 200 个任务的场景里认领总数只有 120～130，1% 只容得下 1 次。两轮实测分别是 4 次和 8 次，稳态都是 0，K2 都是 0。
   M5b 的场景台在锁定前后不推进时钟，所以窗口是 0。这不是队列的毛病。建议主会话二选一：
   - (a) K1-X 以 `--order lock-first` 判「稳态 0」，`join-first` 那一遍只记竞态窗口的拒绝数与窗口时长，不判 1%；
   - (b) 把竞态上限改成「≤ 节点数」，或者加大任务数（竞态拒绝不随任务数增长）。

   **主会话已〔裁〕（2026-09-28）**：K1 改为稳态拒绝 = 0（硬）、竞态窗口内拒绝 ≤ 本轮节点总数（硬）、窗口时长只记录，两种顺序都跑，`lock-first` 另要求竞态 0。探针（`1b8a811`）与计划第 2.2 节已照改，结果见第 6 节。
2. **D4 对照组**：没有运行时开关，所以没有走计划里的 (a)「演练实例以过滤关的开关起」。按裁定在 PC 本机跑，用加载钩子关过滤，不改生产代码。以后要在演练实例上跑对照组，得先在 `shared-service.mjs` 读 `PROMPTCUT_QUEUE_PREFILTER`（改生产代码，不在本分支范围）。
3. **I1-X「20 个探针共享项目」做不到**：托管模式下同一来源地址每小时只许建 10 个共享项目（`server/auth/http.mjs` 的 `CREATE_PER_HOUR: 10`），PC 在一小时里建 20 个会回 429。
   探针改成：20 个**队列项目**（这正是 I1 的原始定义，按 watch 隔离），分在 `--spaces`（缺省 2）个共享项目里，同时证 watch 隔离与空间隔离。每轮只建 2 个共享项目，K1 每轮建 1 个。建议计划第 2.2 节照此改写。
4. **命令形状**：计划写的 `--role coord+nodes` / `--role nodes`，本探针对应 `coord+nodes` / `worker`（任务书写 coordinator / worker，两种都给了；没有叫 `nodes` 的角色）。另外 worker 要 `--name`；I1 那一行 PC 也要 `--workers pc,laptop`；`--lock-half` 是缺省，写不写都一样。
5. **K2 的计法**是本探针自定的口径（见第 1 节），比 M5b 的「锁定之后收到的 opened」多了「撤回后再可见」一种。M5b 在假时钟下有一个明确的「锁定之后」时刻，跨机没有，所以按节点自己的消息顺序判。
6. **I1-X 的阿里云资源采样**没跑（不连阿里云）。`--sample` 走公共件的 `startSampler`，第一次真用前请主会话照 AGENT-m8-kit 报告第 3 节先试一次 `sampleRemote()`。

## 5. 提交

- `67705c7` 文档：AGENT-m8-scale 报告起稿
- `d37d611` 探针：m8-scale-probe 与纯逻辑单测（含 bakery-deps 名单一行）
- `1a022cb` 探针：K1 加 `--order`、记竞态窗口时长
- `1baed07` 文档：本报告定稿
- `50abb7d` 合并 main（`0d114df`，main 已含 `278eeb9`；进来的是 tailwind 守门、m8-migrate 探针等，与本分支文件不重叠）
- （本段补记的提交）

合并 main 之后重跑：`npx tsc -b --force` 退出码 0；`npm test` 退出码 0，tests 3467，pass 3465，fail 0，skipped 2；
对照组 `--role all --case k1 --prefilter off` 退出码 0，`ok: true`，totals `{"claims":521,"claimed":100,"cardLocked":400,"openedMismatch":400,"deadClaimed":0}`。
- `1b8a811` 探针：K1 判据照〔裁〕改（稳态 0、竞态 ≤ 节点总数、lock-first 竞态 0，窗口时长只记录），单测 M8S-5 同步
- `3347909` 计划第 2.2 节〔裁〕与本报告第 6 节

## 6. 按〔裁〕改判据后的复跑（本机替身，原样结果行）

`--role all --case k1`（join-first）：退出码 0。
```
{"ok":true,"run":"mukca0vi4247","fails":[],"ms":9162}
PASS coordinator:K1-card-locked {"mode":"prefilter-on","order":"join-first","steady":0,"race":6,"raceLimit":8,"claims":131,"raceWindowMsMax":28}
PASS coordinator:K2-opened-mismatch {"mode":"prefilter-on","openedMismatch":0,"hiddenUnexpected":0}
PASS coordinator:K1-dead-never-claimed {"deadClaimed":0}
PASS coordinator:J-all-done {"total":100,"done":100,"notDone":[]}
PASS coordinator:J-exactly-once {"total":100,"epochs":["40e6b420-add5-4f4b-b87c-239bd1f4d886"],"dup":[],"missing":[],"stray":0}
PASS coordinator:J-pure-layers {"layers":20,"observed":200,"unknown":0,"mixed":[]}
PASS coordinator:watcher-dead-never-taken {"deadTaken":[]}
totals {"nodes":8,"claims":131,"claimed":100,"cardLockedRace":6,"cardLockedSteady":0,"openedMismatch":0,"hidden":400,"hiddenUnexpected":0,"deadClaimed":0,"cardLocked":6,"raceWindowMsMax":28}
```

`--role all --case k1 --order lock-first`：退出码 0。
```
{"ok":true,"run":"mukca8hg84b6","fails":[],"ms":8646}
PASS coordinator:K1-card-locked {"mode":"prefilter-on","order":"lock-first","steady":0,"race":0,"raceLimit":0,"claims":121,"raceWindowMsMax":null}
PASS coordinator:K2-opened-mismatch {"mode":"prefilter-on","openedMismatch":0,"hiddenUnexpected":0}
PASS coordinator:K1-dead-never-claimed {"deadClaimed":0}
PASS coordinator:J-all-done {"total":100,"done":100,"notDone":[]}
PASS coordinator:J-exactly-once {"total":100,"epochs":["27660aad-d191-4949-9444-17b5b788297d"],"dup":[],"missing":[],"stray":0}
PASS coordinator:J-pure-layers {"layers":20,"observed":200,"unknown":0,"mixed":[]}
PASS coordinator:watcher-dead-never-taken {"deadTaken":[]}
totals {"nodes":8,"claims":121,"claimed":100,"cardLockedRace":0,"cardLockedSteady":0,"openedMismatch":0,"hidden":0,"hiddenUnexpected":0,"deadClaimed":0,"cardLocked":0,"raceWindowMsMax":null}
```
两轮的其余检查项（workers-ready、two-fingerprints、dead/live-published、locks-granted、worker-results、kv-no-401、project-deleted）全 PASS。

改判据之后：`npx tsc -b --force` 退出码 0；`npm test` 退出码 0，tests 3467，pass 3465，fail 0，skipped 2；`node --test server/test/m8-scale.test.mjs` 10 条全过。
