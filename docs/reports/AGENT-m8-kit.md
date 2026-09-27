# AGENT-m8-kit 报告

分支 `claude/m8-kit`，worktree `.worktrees/m8-kit`，端口段 5730～5739（实际用了 5733、5734～5736、5737～5739，托管组合与协调口用端口 0）。
任务：M8 探针的公共件（计划 `docs/plan/m8-plan.md` 第 1 版第 4 节第 1～3 项、第 6 节 `claude/m8-kit` 一行，按末尾「主会话裁定」）。

代号：**M8** 是分布式预渲染队列任务书的最后一个阶段「多端物理联调」；**E1～E6** 是任务书第 6 节的六个端到端用例；
**J-全完 / J-恰一 / J-纯层** 是计划第 2 节开头的三条共用判据（任务全部完成、每个任务恰好一次 `task.done`、没有一层混两种指纹）；
**D3** 是计划第 7 节「恰好一次按 epoch 数」那条裁定；**L19** 是计划第 5 节「T9 协调口第一次 KV 写回 401 没查明」那条遗留；
**K1-X / I1-X** 是计划第 2.2 节两条真实多端复测（指纹前置过滤防锁风暴、按项目的频道隔离）。

## 1. 做了什么

文件都在本分支清单内：`scripts/probes/m8/`（新）、`scripts/probes/render-queue-proxy.mjs`（改）、`server/test/m8-kit.test.mjs`（新）、本报告。

| 文件 | 内容 |
|---|---|
| `scripts/probes/m8/lib.mjs` | 纯逻辑：角色名与本轮 id、设备 id、测试指纹格式；放云端 / 放本机 / 本机替身三种连接参数 `placeParams`；代理目标 `docTargetOf`；端口护栏 `checkPorts`（5190～5192、5203～5205 一律拒）；判据 `judgeAllDone`（J-全完）、`judgeExactlyOnce`（J-恰一，缺省按 epoch，D3）、`judgePureLayers` + `layerObservations`（J-纯层）、`judgeIdenticalBytes`（产物逐字节相同）、`judgeEachWorked`（各节点都干了活、和等于任务数）、`summarizeTimeline` / `takeoverMs`（旁观节点时间线、接手用时）；假任务 `fakeLayerTasks`；结果行 `createResult` / `mergeRoleResults` / `lastJsonLine` |
| `scripts/probes/m8/kv.mjs` | 协调口 KV 的键名约定（`<前缀>.<run>.config / ready.<角色> / signal.<名> / result.<角色> / abort / done`、`<前缀>.latest`）、`roleKv`、`resolveRun`；自带的 KV 客户端在 401 时记一行（状态、响应体、有没有带令牌、令牌长度，不记令牌本身）并隔 500 ms 重试一次（L19），网络错误与 5xx 退避重试到时限 |
| `scripts/probes/m8/procs.mjs` | 进程起停：`startHostedCombo`（本机临时托管组合，只绑回环，信任关，集群令牌现场生成不打印）、`startCoord`（进程内协调口，可开信箱）、`startQueueEditor`（桌面编辑器队列节点，可 `lanHost`、可测试指纹）、`startRenderHost`（独立渲染主机，IPC shutdown）、`startProxy`（代理，`cut/stall/resume/status/quit`）、`runRole`、`killTree`、`childEnv`、`claimPorts` |
| `scripts/probes/m8/conn.mjs` | 连文档服务的角色：`openConn`、`createProbeProject` / `deleteProbeProject`、`startWatcher`（旁观节点）、`startFakeNode`（假节点，可给指纹、可挂 `onMessage` 计数、`takeoverLocked` 透传）、`startFakePublisher`（按 epoch 记 `task.done`、epoch 变了重发）、`sharedEntry` |
| `scripts/probes/m8/resources.mjs` | 阿里云资源采样：经 `ssh … bash -s` 跑只读脚本（pm2 进程表在远端用 node 摘掉环境变量后才传回）、解析 `parseRemoteSample`、差值 `diffSamples`、定时采样 `startSampler`（峰值） |
| `scripts/probes/m8/blackout.ps1` | 计划第 2.6 节 C1 的断网脚本：`-Mode firewall`（首选，只挡给定地址）/ `nic`，恢复保险（先登记 SYSTEM 计划任务 `PC-M8-Blackout-Guard`，登记不上就不断；`finally` 恢复），逐步日志，`-Detach`，`-DryRun`。**只跑过 `-DryRun` 与参数校验**（没有改任何系统设置） |
| `scripts/probes/m8/kit-selftest.mjs` | 本机替身自检（见第 2.3 节） |
| `scripts/probes/render-queue-proxy.mjs` | `--stdin-control` 加 `stall`（开着的与之后新来的连接都只攒不转）、`resume`（按序补发）、`status`、`quit`（Windows 上要汇总行用它）；加 `--close-prob`（按概率断开整条连接）；`--loss` / `--loss-hold-ms` 改叫 `--stall-prob` / `--stall-ms`（旧名保留同义）；`listen` 与 `summary` 行带 `meaning` 字段写明「字节从不丢，不是 IP 丢包率」 |
| `server/test/m8-kit.test.mjs` | M8K-1～19 |

### 主会话中途补的约束（丢包）已照办

主会话转来「代理不能按比例丢数据块」：本代理原本的 `--loss` 就是扣住再按序发、不丢字节；这次把它改叫 `--stall-prob`（旧名同义保留，免得破坏 `ht-w-probe.mjs` 等旧用法），加了按概率断整条连接的 `--close-prob`，帮助、文件头与 `listen` / `summary` 行都写明含义。**判据里请说「10% 的块受扰」，不说「10% 丢包」**；计划第 2.6 节 C3 的命令形状 `--loss 0.1` 仍能用，建议改写成 `--stall-prob 0.1`（见第 4 节）。

## 2. 验证

### 2.1 类型检查

`npx tsc -b --force` → 退出码 0。

### 2.2 全量测试

`npm test` → 退出码 0：tests 3430，pass 3428，fail 0，skipped 2（两条都是既有的：`/api/cards/layout` 集成、SKILL 闸门集成，要自己起 dev server 才跑）。
第一次跑挂了 1 条：依赖方向守门 `bakery-deps.test.mjs`「server/** 不 import scripts/」—— 新单测 import 了 `scripts/probes/m8/`。
按该守门文件头写的做法把 `server/test/m8-kit.test.mjs` 加进例外名单（一行，单独提交 `c21881f`），重跑全过。**这一行越出了本分支的文件清单**，见第 3 节。

### 2.3 本机替身自检（原样结果）

命令（本机临时托管组合 + 协调口开信箱 + creator 与旁观节点 + 两个假节点：node-a 指纹 X 直连，node-b 指纹 Y 经代理，
代理每块 10% 受扰、node-b 第一次持有任务时 stall 3 s 再 resume；4 层 × 5 段 = 20 个假细任务，前两层要求 X、后两层要求 Y）：

```
node scripts/probes/m8/kit-selftest.mjs --role all --keep-temp --out <scratchpad>/st1
```

退出码 0。结果行（stdout 最后一行，节选 `checks` 与计数，原文见下一段）：

```
creator:watcher-watching PASS  {"hello":"node.welcome","watch":"queue.snapshot"}
creator:nodes-ready PASS
creator:node-results PASS
creator:J-all-done PASS        {"total":20,"done":20,"notDone":[]}
creator:J-exactly-once PASS    {"total":20,"epochs":["ca9458e9-dead-498a-a602-256c07e9282e"],"dup":[],"missing":[],"stray":0}
creator:J-pure-layers PASS     {"layers":4,"observed":40,"unknown":0,"mixed":[]}
creator:each-node-worked PASS  {"nodes":2,"idle":[],"sum":20,"total":20}
creator:watcher-saw-done PASS  {"tasks":20,"notClosedDone":[]}
creator:kv-no-401 PASS         {"puts":3,"gets":4,"unauthorized":0,"retries":0}
creator:project-deleted PASS
node-a: config / node-connected / creator-done / node-no-failed  全 PASS
node-b: config / node-connected / proxy-stall-resume / creator-done / node-no-failed  全 PASS
  proxy-stall-resume: {"held":["snapshot:m8-mukb2f414c19-L2:180-239"],"stall":{"event":"control.stall","open":1,"newlyStalled":1},
                       "resume":{"event":"control.resume","open":1,"resumed":1,"stalledMs":3068},"ms":3068}
  node-b stats: claimed 10, completed 10, lost 0, failed 0, resumes 0
  proxySummary: {"conns":1,"chunks":180,"held":18,"stalledConns":1,"stallCommands":1,"resumeCommands":1,"randomCloses":0}
"ok":true,"fails":[]
```

第二轮加上真的独立渲染主机与桌面编辑器队列节点：

```
node scripts/probes/m8/kit-selftest.mjs --role all --real-host --queue-editor --keep-temp --timeout-min 15 --out <scratchpad>/st2
```

退出码 0，`"ok": true`，`"ms": 43939`，`fails: []`，25 条 check 全 PASS，其中：

```
PASS creator:real-host-ready {"readyMs":8004,"envFingerprint":"258acaaa7c5fe509","nodes":1}
PASS creator:real-host-fingerprint-differs {"envFingerprint":"258acaaa7c5fe509"}
PASS creator:queue-editor-active {"activeMs":11377,"envFingerprint":"258acaaa7c5fe509","transport":"ws"}
PASS creator:real-host-claimed-none {"claimed":0,"connected":true}      （真主机指纹与 X、Y 都不同：前置过滤让它一个也没认领）
PASS creator:real-host-exit {"exitCode":0,"released":0}                  （IPC shutdown 正常退出）
PASS creator:queue-editor-stopped {"exitCode":1}                         （结束进程树；taskkill /F 的退出码）
```

跑完核对：命令行含 `m8-kit` 的进程 0 个，5730～5739 上的监听 0 个。

### 2.4 单测与全量测试

`node --test server/test/m8-kit.test.mjs`：19 条全过（tests 19，pass 19，fail 0）。

全量见第 2.2 节。最后一版代码上又跑了一轮自检（`--role all`，不带 --real-host / --queue-editor）：退出码 0，`ok: true`，`ms: 21455`，
20 个任务从发布到全部完成 6413 ms；19 条 check 全过；旁观节点每个任务至多认领一次、放回 0 次；node-b 经代理 179 块里 14 块受扰、stall 3077 ms 后 resume，claimed 10、completed 10、lost 0。

## 3. 没做的与原因、越界

- **越界一行**：`server/test/bakery-deps.test.mjs` 的例外名单加了 `server/test/m8-kit.test.mjs`（提交 `c21881f`）。不加，全量测试红一条；单测只能放在 `server/test/`（`npm test` 只收那里）。
  主会话不同意的话：丢掉 `c21881f`，再把 `server/test/m8-kit.test.mjs` 移出 `npm test` 的范围（那样公共件就没有常驻基线的单测了）。

- **E1～E6 的具体用例**：按任务书留给 `claude/m8-e2e`；公共件的接口已留好（第 5 节）。
- **`blackout.ps1` 没真跑过**：改防火墙 / 网卡属改系统设置，子智能体不做；只跑了 `-DryRun` 与参数校验（坏地址 `evil;rm` → 退出码 2）。真跑前按计划 D1 由主会话在对话里列命令、确认笔记本权限模式；首次建议先跑 P-C1 预检。
- **`resources.mjs` 没连过阿里云**：ssh 目标只在主会话手里；解析用离线样本单测覆盖（M8K-16）。第一次真用时请主会话跑一次 `node -e "import('./scripts/probes/m8/resources.mjs').then(m=>console.log(JSON.stringify(m.sampleRemote())))"`（要 `PROMPTCUT_REMOTE`）。
- **测试指纹开关**（`PROMPTCUT_TEST_ENV_FINGERPRINT`）只在 C10 集成分支之后生效；main 上设了不起作用。公共件的 `fingerprintApplied()` 用来判「开关没生效」，免得 E6 误判。

## 4. 对计划的更正建议

1. 计划第 2.3 节末与第 2.6 节 C3 写「`--loss 0.1`」「代理丢包 10%」：建议改成 `--stall-prob 0.1`、「10% 的块受扰（扣住 200～1000 ms 再按序发）」，需要断线再加 `--close-prob`。旧参数仍可用。
2. 计划第 4 节第 1 项写的路径是 `scripts/probes/m8/lib.mjs` 一个文件；实际拆成同目录六份（lib / kv / procs / conn / resources / blackout.ps1）加自检，`m8-e2e`、`m8-scale` 只 import，不改这些文件。
3. 计划第 1.3 节 / 第 6 节里本机测试用的文档服务「仍在 8790～8799」：公共件的托管组合缺省用端口 0，不占 8790～8799（多个子智能体并行时更不容易撞）。
4. 旁观节点的时间线：队列对 `task.opened / taken / closed` 带合并键，慢连接上会只留最新一条。E2 的「接手用时」用 `takeoverMs` 从时间线量，但「恰好一次」一律以发布方数的 `task.done` 为准（`conn.mjs` 文件头已写）。

## 5. 给 m8-e2e / m8-scale 的用法

```js
import { placeParams, createResult, mergeRoleResults, judgeAllDone, judgeExactlyOnce, judgePureLayers, layerObservations,
  judgeIdenticalBytes, judgeEachWorked, summarizeTimeline, takeoverMs, newRunId, fingerprintOf, fakeLayerTasks } from './m8/lib.mjs';
import { roleKv, resolveRun } from './m8/kv.mjs';
import { startHostedCombo, startCoord, startQueueEditor, startRenderHost, startProxy, runRole } from './m8/procs.mjs';
import { createProbeProject, deleteProbeProject, sharedEntry, startWatcher, startFakeNode, startFakePublisher } from './m8/conn.mjs';
import { startSampler } from './m8/resources.mjs';
```

- **部署**：`const P = placeParams(place, { hosted, coord, lanHost })`；项目配置的 `url` 用 `P.ws`，健康检查读 `P.healthz`，经代理时代理目标用 `P.docPlain`（阿里云是 `8.219.80.16:8787`）；放本机另有 `P.cloudHealthz`，用来判「全程不连阿里云」。
- **角色与 KV**：creator 用 `resolveRun({ coord, prefix: 'm8e', run: arg('--run'), isCreator: true, newRun: newRunId, deadline })`，其它角色 `isCreator: false`；
  `const kv = roleKv({ coord, prefix, run, role })`，然后 `kv.config()/takeConfig()`、`kv.ready()/takeReady(角色)`、`kv.signal('host.holding')/takeSignal()`、`kv.result(r.toJSON())/takeResult(角色)`、`kv.abort()/aborted()`、`kv.done()`。前缀 ≤ 16 字符，拼出的键超 64 字符直接抛错。
- **结果行**：`const r = createResult({ probe, role, run, place, case })`；`r.check(名, ok, detail)`、`r.judge(名, judgeXxx(...))`；最后 `process.stdout.write(JSON.stringify(r.toJSON()) + '\n')`。`--role all` 用 `runRole(脚本, 角色, 参数)` 起子进程、`mergeRoleResults(head, results)` 汇总。
- **三条共用判据**：J-全完 `judgeAllDone(ids, states)`；J-恰一 `judgeExactlyOnce(ids, doneEvents)`（发布方收到的每条 `task.done` 记 `{ id, epoch }`，`startFakePublisher` 已记好；真实发布方用编辑器诊断的 `doneCounts` 时每个 epoch 各算一份）；
  J-纯层 `judgePureLayers(观察)`：真实渲染时由清单或层表逐层给 `{ layer, fingerprint, ref }`，假任务时用 `layerObservations(tasks, completedBy, nodeFingerprints)`；
  产物逐字节相同 `judgeIdenticalBytes(键→字节或 sha256, 同左)`；三方各认领 ≥ 1 用 `judgeEachWorked({ 节点: 数 }, { total })`。
- **旁观节点**：`startWatcher({ entry: sharedEntry({ url: P.ws, projectId, username, password, run, tag: 'watcher' }), projects: [队列项目 id], nodeId })`；
  不给 `fingerprint` 就看得见全部任务；`summarizeTimeline(w.events(id))`；E2 的接手用时 `takeoverMs(w.events(id), stall 的时刻)`（≤ 37 000 判过）。
- **进程**：本机替身 `startHostedCombo({ dir })`（端口 0）、`startCoord({ mailToken })`；桌面队列节点 `startQueueEditor({ port, dir, sharedConfig, fakeFingerprint, lanHost })` → `waitActive()`、`queue()`、`fingerprintApplied()`；
  独立渲染主机 `startRenderHost({ port, dir, config, maxConcurrent, fakeFingerprint })` → `node()`、`shutdown()`、`stop()`。端口先过 `checkPorts`（传 `band` 核在自己的段里）。
- **E2 / C1 第 3 种**：`const px = await startProxy({ listen: '127.0.0.1:<端口>', target: P.docPlain })`，节点的 `url` 用 `px.url`；持有任务时 `await px.stall()`（开着的和新来的连接都不转发，重连也接续不上），到点 `await px.resume()`；`px.stop()` 回汇总行。
  C3：`startProxy({ …, stallProb: 0.1 })`，要断线再加 `closeProb`。
- **E6**：`fakeFingerprint`（16 位小写十六进制，`fingerprintOf('seed')` 可造）给 `startRenderHost` / `startQueueEditor`；只在含 C10 集成的检出上生效，先 `fingerprintApplied()`。
- **C1 第 1、2 种**：`scripts/probes/m8/blackout.ps1 -Mode firewall -Seconds 30 -Remote <地址> -Log <文件> -Detach`（先 `-DryRun` 核命令）。
- **m8-scale（K1-X、I1-X）**：一个进程里循环 `startFakeNode({ entry, nodeId, fingerprint, projects, onMessage })` 开多个节点连接；`onMessage` 数「收到别的项目的消息」；`rec.rejected` 记 `task.claim-rejected`（数 `card-locked`）；
  假任务 `fakeLayerTasks({ run, projectId, layers: [{ fingerprint, segments, extra }] })` 的 `extra` 给卡片锁需要的 `tier / input`；`takeoverLocked` 透传给节点（对照组）。阿里云资源用 `const s = startSampler({ everyMs: 15000 }); … await s.stop()`，回样本、峰值与网卡速率（要 `PROMPTCUT_REMOTE`）。
- **自检当模板**：`scripts/probes/m8/kit-selftest.mjs` 就是 creator / node / all 三种角色的最小写法。
