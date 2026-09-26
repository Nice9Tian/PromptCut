# M6b 实现报告（claude/m6-host）

契约：`docs/plan/render-host-contract.md`。依据：`docs/plan/auth-contract.md`（M6a）、`docs/reports/AGENT-m6-auth.md`、主执行计划第 7 节 M6、第 12 节。
worktree：`.worktrees/m6-host`，分支 `claude/m6-host`（基于 `claude/m6` 的 `df2a5d8`）。端口只用了 5400～5409，单测用端口 0。

## 1. 做了什么（按契约节号）

| 节 | 内容 | 落在哪 |
|---|---|---|
| 2 怎么起 | `scripts/render-host.mjs`：起不带页面的编辑器 vite（只绑 127.0.0.1，`--port` 缺省 5400），它拉起预渲染进程；给子进程设 `PROMPTCUT_QUEUE_NODE=1`、`PROMPTCUT_NODE_PROFILE=host`、`PROMPTCUT_SHARED_CONFIG=<配置绝对路径>`、`PROMPTCUT_STREAMS`（`--streams`，缺省 0）；起来后打 `[render-host] ready {…}`。SIGINT / SIGTERM / SIGBREAK / IPC `{type:'shutdown'}` → `POST /api/frames/queue/release`（让掉认领、停节点、关连接）→ 打 `[render-host] exit {…}` → 结束编辑器进程树 → 退出码 0 | `scripts/render-host.mjs`；参数与环境变量的两个纯函数 `renderHostArgs` / `renderHostEnv` 在 `server/render-node/host.mjs`（`server/**` 不许引 `scripts/`，单测要用） |
| 2 配置 | 沿用 M6a 的 `PROMPTCUT_SHARED_CONFIG`（一项或数组）；`maxConcurrent` 缺省 1、上限 4 | `server/render-node/host.mjs` 的 `loadHostConfig` |
| 3 每个项目一条连接、一个节点 | 每项一条 `render` 连接（每次重连现取挑战）、一个 `createLocalNode`（`profile: 'host'`）；全局并发闸：每个节点的 `isIdle()` = 全部节点「持有 + 在飞认领」< maxConcurrent | `server/render-node/host.mjs` 的 `createRenderHost` |
| 3 node.hello | `profile: 'host'`、`capabilities: { userCards: true, graphCards: false }`、`codeVersions: [frameCode]`、`envFingerprint` 照本机探测（同 PC 节点，借一次流预渲染间） | 同上；接线在 `server/vite-plugin-frames.ts` 的 `startHostNode` |
| 3 不认领 plan | 节点侧过滤规则 6：`profile: 'host'` 见到 `plan` 回 `plan-on-host`，不发认领；主机也不发布 `plan`（`active()` 恒 false，`/preload` 不走队列） | `server/render-node/filter.mjs` |
| 3 闲时门槛 | 主机只看全局闸，不看执行器的 `isIdle` | `host.mjs` |
| 3 产物 | 每个项目各一份素材客户端，读写带这条连接 `auth.ticket` 取的素材票据；基址：`PROMPTCUT_ASSET_URL` → 这条连接 `service.endpoints` 里的 `asset`（只排除与主机自己编辑器同 host:port 的） → 从文档服务地址推出同进程的 `http(s)://<host>/api/asset`。不回落到主机自己的素材服务。推完收全再 `complete`（沿用 sink） | `vite-plugin-frames.ts` 的 `hostAssetClient` |
| 3 掉线与重连 | 沿用 M5a 传输；重连按 G.7 接续仍持有的认领（主机断线时不 `yieldAll`，与 PC 不同，见第 5 节第 8 条） | `host.mjs` |
| 3 诊断 | `GET /api/frames/queue` → `{ nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost, … }], codeVersion, envFingerprint, maxConcurrent }`；编辑器进程原样转给预渲染进程；PC 节点也答（一项） | `vite-plugin-frames.ts` |
| 4 队列侧 | 认领权限沿用 M6a（本空间任何成员的细任务）；codeVersion / 指纹 / 卡片锁过滤照旧；`plan` 跳过在节点侧 | `filter.mjs` |
| 5 单测 | `server/test/render-host.test.mjs`：RH1～RH6，共 10 条 | — |
| 5 探针 | `scripts/probes/render-host-probe.mjs`：`--role creator | host | check | auth-check`，每个角色最后一行一行 JSON | — |

其它改动：
- PC 节点（`startQueueNode`）：诊断多 `doneCounts`（每个任务收到几次 `task.done`，H1 用）、`summary()`、`release()`；`resolveDocLink` 多带 `projectId`。
- `startArtifactPush`：主机形态跳过（`push.skip { reason: 'host-profile' }`），产物只经各项目节点的 sink 推。
- 测试开关 `PROMPTCUT_TEST_CODE_VERSION`：只改主机节点对外报的 `codeVersions`（H2 用），PC 节点与帧库键都不看它。生产不设。
- `server/render-node/index.mjs` 转出 host.mjs 的几个函数。

### 新增与改动的文件

新增：`scripts/render-host.mjs`、`server/render-node/host.mjs`、`server/test/render-host.test.mjs`、`scripts/probes/render-host-probe.mjs`、本报告。
改动：`server/vite-plugin-frames.ts`、`server/render-node/filter.mjs`、`server/render-node/index.mjs`、`server/test/render-node-logic.test.mjs`（见第 4 节）。
没动：`frame-pipeline`、导出路径、卡片、快照、文档服务与队列本体、语义文档。

## 2. 基线（worktree 根目录）

```
npx tsc -b --force                    → tsc EXIT 0
npm test                              → npm test EXIT 1
ℹ tests 2562
ℹ pass 2501
ℹ fail 60
ℹ cancelled 0
ℹ skipped 1
```

**60 条失败全部是基线原有的**，不是本分支引入的：全部是 `auth-*.test.mjs`（M6a 测试方 `claude/m6-auth-tests` 的 AU 系列），同一个原因：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\server\auth\index.mjs' imported from …\server\test\auth-kit.mjs
```

`auth-kit.mjs` 第 145 行要 `server/auth/index.mjs` 导出 `createSharedHost`（文件头写明是「测试方假设的接口」），而 M6a 实现没有这个文件。对照：把基底 `df2a5d8` 的 `server/ src/ scripts/ package.json` 用 `git archive` 解到 scratchpad 里单跑 `server/test/auth-*.test.mjs`：`tests 105 / pass 44 / fail 61`，其中 60 条是同一个 `ERR_MODULE_NOT_FOUND`（另 1 条是 scratchpad 里没有 `typescript`，环境原因）；本分支单跑同一组：`tests 105 / pass 45 / fail 60`。这 60 条要在集成分支上接好测试方的假设接口（不在本任务文件清单里，没动）。

除这 60 条外失败 0；跳过 1（原有的 `/api/cards/layout` 那条）。第一次全量跑时另有 1 条是本分支引入的（`bakery-deps`「server/** 不 import scripts/ 下的模块」：单测引了 `scripts/render-host.mjs`），已把参数与环境变量的函数搬进 `server/render-node/host.mjs` 修掉，第二次全量跑不再出现。

本阶段新增单测（单跑 `render-host.test.mjs`，10/10 过）：

```
✔ RH1 配置解析:单项、数组、缺字段报错;maxConcurrent 缺省 1、上限 4、环境变量覆盖
✔ RH1 render-host:参数解析与子进程环境变量(契约第 2 节)
✔ RH2 多项目开多条连接:两个共享项目各一条 render 连接、一个 host 节点,各自只做自己项目的任务
✔ RH2 host 节点的 node.hello 字段(profile / codeVersions / capabilities / maxConcurrent)
✔ RH3 plan 跳过:host 见到 plan 不发认领,只认领细任务;同一队列上的 pc 节点照常认领 plan
✔ RH4 并发上限 maxConcurrent=1:两个项目共 6 个任务,全部节点的持有 + 在飞任何一拍都不超过 1,且会到达 1
✔ RH4 并发上限 maxConcurrent=2:两个项目共 6 个任务,全部节点的持有 + 在飞任何一拍都不超过 2,且会到达 2
✔ RH4 并发上限不超过 4:给 9 按 4 算
✔ RH5 退出时让掉认领:每个持有发 task.release,队列立即放回 open,别的节点马上能认领;执行被中止
✔ RH6 代码版本过滤照旧:codeVersion 不同的 host 看得见任务、认领 0 次
```

RH2 第一条用真文档服务（`createSharedDocService` 托管模式，`isLoopback` 恒 false，只能凭证明进入）+ 真 `createWsEndpoint` + `sharedProtocols`；其余用进程内环回队列。

G0-R（动了预渲染进程）：

| 探针 | 命令 | 结果 |
|---|---|---|
| ready-index-probe | `node scripts/probes/ready-index-probe.mjs --port 5400`（`TEMP`/`TMP` 指到 scratchpad） | 退出码 0，`"fails": []` |
| preview-fallback-probe | 另起 `npx vite --port 5403 --strictPort --host 127.0.0.1`，`node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5403 --page-preload` | 退出码 0，`PASS`，`transparentBeats: 0`，`taskP90: 12.403`，`fails: []` |
| 同上，不带 `--page-preload` | 同一台 dev server | 退出码 0，`PASS`，`transparentBeats: 0`，`taskP90: 13.59`，`fails: []` |

没跑 `verify-determinism` 与 `verify-unified-frames`：没动 `frame-pipeline`、导出路径、快照与渲染（只动了 `vite-plugin-frames.ts` 里队列节点的接线和 `/api/frames` 中间件最前面两条新路由）。

## 3. 探针（本机跑通）

拓扑：`creator` 5400（编辑器 + 挂载的局域网模式文档服务与素材服务 + 本机 PC 节点，以创建者身份凭证明进入共享项目）；第 1 轮主机 `host-a` 5403、`host-b` 5406（同代码版本）；第 2 轮 `host-c` 5403（`--code-version test-code-version-mismatch`，即 `PROMPTCUT_TEST_CODE_VERSION`）、`host-bad` 5406（口令错）；`check` 在主机退出后用 5403 另起普通模式编辑器单机重渲。编排脚本在 scratchpad（`run-rhp.sh`，creator 后台、主机依次起），state 目录 `scratchpad/rhp4`。

原始 JSON 行（最后一次完整运行 rhp4；`check` 两行是修正比较函数后对同一次运行的产物重跑的，见第 6 节）：

```
== creator
{"role":"creator","port":5400,"state":"C:\\Users\\admin\\AppData\\Local\\Temp\\claude\\C--Users-admin-Documents-PromptCut\\b27266f2-12b6-470f-ae3c-baab02fc8037\\scratchpad\\rhp4","rounds":[{"round":"r1","hosts":["host-a","host-b"],"planId":"plan:render-host-probe@1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":2,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":62153},{"round":"r2","hosts":["host-c","host-bad"],"planId":"plan:render-host-probe@2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":59971}],"projectId":"sp_hi4fmpqc4m2kw6ynqlugsus5hs","pc":{"mode":"shared","nodeId":"prerender:DESKTOP-GS40TCK:5400","envFingerprint":"258acaaa7c5fe509","codeVersion":"3978093a724d9b0e726bd8395e9265e8ef4808b88d6ef4ce1401793a5d31c2e6"},"auth":["auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}"],"ok":true,"fails":[]}
== host-a
{"ok":true,"name":"host-a","round":"r1","port":5403,"projectId":"sp_hi4fmpqc4m2kw6ynqlugsus5hs","claimed":1,"completed":1,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"3978093a724d9b0e726bd8395e9265e8ef4808b88d6ef4ce1401793a5d31c2e6","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-b
{"ok":true,"name":"host-b","round":"r1","port":5406,"projectId":"sp_hi4fmpqc4m2kw6ynqlugsus5hs","claimed":2,"completed":2,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"3978093a724d9b0e726bd8395e9265e8ef4808b88d6ef4ce1401793a5d31c2e6","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-c
{"ok":true,"name":"host-c","round":"r2","port":5403,"projectId":"sp_hi4fmpqc4m2kw6ynqlugsus5hs","claimed":0,"completed":0,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,"codeVersion":"test-code-version-mismatch","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":true,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-bad
{"ok":true,"name":"host-bad","round":"r2","port":5406,"projectId":"sp_hi4fmpqc4m2kw6ynqlugsus5hs","claimed":0,"completed":0,"dedup":0,"seen":0,"connected":false,"opens":0,"handshake":401,"codeVersion":"3978093a724d9b0e726bd8395e9265e8ef4808b88d6ef4ce1401793a5d31c2e6","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":10,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== check-r1b
{"role":"check","round":"r1","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"claimed:host-a":1,"claimed:host-b":2,"completedByNode":{"pc":2,"host-a":1,"host-b":2},"sumCompleted":5,"pcPlanClaimed":true,"reused":0,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":240,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":false,"identical":true,"fails":[]}
== check-r2b
{"role":"check","round":"r2","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"claimed:host-c":0,"claimed:host-bad":0,"completedByNode":{"pc":3,"host-c":0,"host-bad":0},"sumCompleted":3,"pcPlanClaimed":true,"reused":2,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":240,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":false,"identical":true,"fails":[]}
== auth-check
{"role":"auth-check","ok":true,"loopback":true,"projectId":"sp_hi4fmpqc4m2kw6ynqlugsus5hs","wrongPassword":401,"rightPassword":101,"ticket":true,"assetNoTicket":404,"assetWithTicket":404,"afterFiveWrong":101,"fails":[]}
```

H 系列：
- **H1**：`check r1`：5 个细任务，`duplicateDone: 0`、`missingDone: 0`；完成数 PC 2 + host-a 1 + host-b 2 = 5 = 任务数；`plan` 由发布方的 PC 节点认领（`pcPlanClaimed: true`），主机都没认领 plan；与单机重渲比较 240 个快照帧 + 3 个 `index.json`：`differentFrames: 0`、`identical: true`（`identicalBytes: false`，240 帧只差 `style` 声明先后且没有同名声明，见第 5 节第 9 条）。
- **H2**：`host-c` 代码版本不同：`seen: 4`（看得见本轮任务）、`claimed: 0`；本轮 3 个新任务全由 PC 完成（另 2 个是第 1 轮已完成的同键任务，重复发布直接回 `task.done`）。
- **H3**：`host-bad` 口令错：原始握手 `handshake: 401`；render-host 里 `opens: 0`、`connectFailed: 10`、`connected: false`、`claimed: 0`、`seen: 0`；创建者日志里对应 `auth.reject { reason: 'bad-proof' }`（原因 `nonce` 那几条是 Node WebSocket 在 401 后用同一组子协议重试一次，M6a 报告第 5 节第 5 条）。
- **auth-check**（本机回环）：错口令 401、对口令 101、`auth.ticket` 取到票据；回环来源不要票据（`assetNoTicket: 404` 而不是 401）、连错 5 次后对口令仍 101（回环不计数），这两项按设计只能在别的机器上判（W5），探针在 `loopback: true` 时不判。
- 退出：所有主机实例 `exitCode: 0`。

## 4. 改过的旧测试

`server/test/render-node-logic.test.mjs`（契约改了规则 6，只动断言与节点 profile，没删断言）：
- 「B.2 规则 6：plan 任务 browser 不认，pc / host 认」→「browser 不认、host 不认（M6b），pc 认」：host 那一行从 `accepted` 改为 `rejected(…, 6, 'host')`。
- 「B.2 规则 1：plan 任务只查 codeVersion」：原来用 host 节点测，host 现在被规则 6 拦在后面；四条断言改在 pc 节点上测，内容不变。

## 5. 与契约不一致之处

1. **「所有节点共用同一个预渲染执行器」**：共用的是同一个 `FramePipeline`（`'queue'` lane）和一道全局并发闸；`createPrerenderExecutor` 的对象按项目各一份。理由：执行器按 `projectId@projectRev` 缓存计划、经连接取项目快照，而不同共享项目里的编辑器项目 id 可能相同（例如都叫 `render-host-probe`），共用一个对象会串。并发、渲染间、帧库都是同一份。
2. **`maxConcurrent` 放在哪**：契约只说「另可给」。实现：各项里给的 `maxConcurrent` 取最大值；`PROMPTCUT_HOST_MAX_CONCURRENT`（`render-host --max-concurrent`）优先；缺省 1、上限 4。另外 `'queue'` lane 本身串行，`maxConcurrent > 1` 时认领可以并发，渲染仍一个一个做。
3. **产物推到哪个素材服务**：登记里有 `asset` 就用登记的；没有时从文档服务地址推出 `http(s)://<文档服务 host>/api/asset`（局域网模式文档服务与素材服务同进程）。本机探针里创建者只绑回环，素材服务不登记（`vite-plugin-media.ts` 只在非回环时登记），走的是后一条。另外主机不按 `asset:<本机主机名>` 排除登记（PC 节点会排），因为同一台机器上的主机在逻辑上是另一台设备。
4. **诊断口**：除契约字段外每项多 `nodeId`、`discarded`、`released`、`seen`（看见过的任务数，H2 的旁证）、`held`、`running`、`transport`、`opens`、`connectFailed`、`assetBase`，顶层多 `profile`；节点还没起来时回 `{ nodes: [], starting: true, … }`。PC 节点也答这个口。
5. **退出**：新增 `POST /api/frames/queue/release`（编辑器转给预渲染进程）。Windows 上别的进程发不了真 SIGINT，所以另认 IPC `{ type: 'shutdown' }`（探针用）；编辑器子进程以独立进程组起（`detached` + `windowsHide`），控制台 Ctrl+C 只到 render-host，由它按顺序收尾。
6. **render-host 改了子进程的 `TEMP` / `TMP`**：编辑器 vite 往系统临时目录写 `promptcut/port.json`（给没指定端口的 MCP 兜底），主机若写公共那份，会把同一台机器上用户自己编辑器的 AI 面板指错。另把 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR` 指到 `--data`，并删掉 `PROMPTCUT_DOCSERVICE_URL`、`PROMPTCUT_CLUSTER_TOKEN`、`PROMPTCUT_HEADLESS`、`PROMPTCUT_PUSH`、`PROMPTCUT_ROLE`。
7. **H3「没有凭证」的做法**：本机回环上「什么都不带」是本机身份（进 `local` 空间，握手 101），所以本机只能用「口令错」模拟没有这个项目的有效凭证，得到握手 401；真正「不带凭证 → 401」要非回环来源（W5）。
8. **掉线**：PC 节点断线时 `yieldAll('offline')` 退回本机自己产；主机没有本机可退，断线时保留持有，重连后按 G.7 `resume` 接续（宽限期 10 s 内）。
9. **`identical` 的判法**：契约是「逐像素相同」。快照是 HTML，跨进程只差 `style` 属性里声明的先后（M5b 报告疑点 3；确定化排在 M6c，集成分支上已有 `claude/m6c-snapshot` 的 X6，本分支基底没有）。探针的判法：逐字节相同，或只差声明先后且每个 `style` 里没有同名声明（没有同名声明时先后不影响层叠结果，也就不影响像素）；严格逐字节另报 `identicalBytes`。没有把 HTML 真渲成 PNG 比。
10. **测试开关**：H2 用 `PROMPTCUT_TEST_CODE_VERSION` 覆盖主机对外报的代码版本（任务书允许，只影响 host 节点的 `codeVersions`）。
11. **探针的轮次**：契约的 `creator` 只发布一个 plan；实现按 `--rounds` 可以发多轮，每轮等列出的主机报「起来了」再发，第 2 轮用来跑 H2、H3（端口段只够同时起 creator + 两个主机）。各角色经 `--state` 目录里的文件协调。本机 PC 节点以 `as: 'creator'` 的证明进入（没用本机声明）。
12. **队列侧没加「host 认领 plan 就拒」**：契约第 4 节写的是节点侧跳过，照做；队列仍接受 host 的 plan 认领（旧客户端不受影响）。

## 6. 过程记录（失败与处理）

- 第 1 次完整运行（`rhp`）：H1 过（完成 PC 2 + host-a 2 + host-b 1）。第 2 轮统计有误：诊断里的 `doneCounts` 和本机节点的 id 列表跨轮累计，第 2 轮与第 1 轮同键的 2 个任务被数成 2 次 `task.done`。是探针的统计错误，已改为每轮算差值（`reused` 另列），不是队列重复完成。
- 第 2 次（`rhp2`）：编排脚本把 creator 写成前台运行（`a; b &` 只把 `b` 放后台），主机没起来；我停了脚本，结束了自己起的 creator、编辑器与预渲染进程树。另给 creator 等主机时加了认 `stop`。
- 第 3 次（`rhp3`）：跑的过程中我改了 `server/render-node/index.mjs`（文件头注释），vite 把它当配置依赖、重启了所有编辑器与预渲染进程，creator `fetch failed`、host-a 丢了节点。是我自己引起的，之后跑探针期间不再动工作区文件。
- 第 4 次（`rhp4`）：全部角色按预期结束；但 `check` 的「忽略声明先后」比较把 `&quot;` 实体里的分号当成了分隔符，所有帧都被判为「有同名声明」，`identical: false`。修正比较函数（引号、括号之外才按 `;` 切）后，对同一次运行的产物重跑 `check r1`、`check r2`，都过（上面贴的是这两行）。同一断言修正后第一次重跑就通过，没有触发回退梯次。
- 全量测试第 1 次多 1 条 `bakery-deps` 失败（见第 2 节），已修。

## 7. 遗留

- **全量测试的 60 条 AU 失败**（基线原有，见第 2 节），需要集成分支补 `server/auth/index.mjs` 的 `createSharedHost` 或改测试件。
- **跨机未验**：票据把关、限速、无凭证 401 在本机回环上都被豁免，要在 W5 用 `--role auth-check`（加 `--rate-limit`）从别的机器跑。
- **多台素材服务的回退票据**：主机的 J.6 素材回退（`setMediaFallbackTicket`）是全局一个函数，只用第一个项目的票据；主机加入的项目分属不同素材服务时，别的服务上读素材会 401。要按基址挑票据得改 `asset-client.ts` 的回退接口。
- **流任务**：主机照契约不认领流（`capabilities` 没有 `transcode`，执行器也拒流），留给 M6c。
- **主机的编辑器仍挂着自己的文档服务**（`<root>/out/docservice`）与素材服务，只是没人连；按项目摘要挑项目（计划第 5.1 节）没做，现在是每个连接各看各的队列。
- **跑探针时不能动工作区文件**：vite 会把 `server/` 下被配置引到的文件当配置依赖、改了就重启（第 6 节第 3 条）。
- worktree 里 vite 建了 `node_modules/`（只有 `.vite`、`.vite-prerender`、`.vite-temp` 缓存，查过没有任何 reparse point / junction），没删。

## 8. 顾问调用记录

没有调用。没有同一用例连续两次失败；四次探针运行里的问题都当场定位到探针或我自己的操作（第 6 节），修正后第一次重跑通过。契约的查资料由主会话在 M6a 做过，本阶段没有新的外部规范。
