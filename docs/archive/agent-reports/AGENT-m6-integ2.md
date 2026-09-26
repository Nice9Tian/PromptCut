# M6b 集成对账报告（claude/m6-integ2）

worktree：`.worktrees/m6-integ2`，分支 `claude/m6-integ2`（`claude/m6` = M6a + M6c X6/X7，再合 `claude/m6-host` 与 `claude/m6-host-tests`）。端口只用 5400～5409，单测用端口 0。没推送、没合并、没装依赖、没建 junction。

## 1. 胶水改动（`server/test/render-host-kit.mjs`，只动 `loadHostModule` 及其新增的 `adaptHostModule`，断言与用例没动）

- `loadHostModule` 不再载入假设的 `server/render-host/index.mjs`，改载 `adaptHostModule()`，它包 `server/render-node/host.mjs`：
  - `parseHostConfig`：实现里新增的同名同形函数，直接用；
  - `loadHostConfig(file)` → 实际 `loadHostConfig(env)`：把路径放进 `PROMPTCUT_SHARED_CONFIG`、清掉 `PROMPTCUT_HOST_MAX_CONCURRENT`；
  - `createRenderHost(options)` → 实际的 `createRenderHost({ connect, nodeIdOf, … })`：照 `vite-plugin-frames.ts` 的 `startHostNode` 接线——每项一个 `createWsEndpoint`（`sharedProtocols(entry, { role: 'render' })`），执行器共用测试给的，产物库 `sinkFor({ projectId, entry, endpoint })`；`start` = `host.start()` + 每 `tickMs` 调 `tick()`；`stop` = `shutdown()` → 等 `settled()`（≤ 5 s）→ 关连接；`describe` = `{ nodes: host.nodes(), codeVersion, envFingerprint, maxConcurrent }`。
- 文件头加了对账说明。`startHost` 没改。

## 2. 实现改动

| 改动 | 文件 | 类别 |
|---|---|---|
| `maxConcurrent` 超 4、0、负数、小数、字符串一律抛 `bad-host-config`，不截断（原来夹到 1～4、不合格当没给）；`createRenderHost` 收到超 4 也抛；环境变量覆盖同样校验 | `server/render-node/host.mjs`（`hostMaxConcurrent`） | C（与裁定不符） |
| 新增 `parseHostConfig(raw, { device })`，`loadHostConfig(env)` 读文件后调它（原来经 `loadSharedConfig` 读两遍文件）；`index.mjs` 转出 | `host.mjs`、`render-node/index.mjs` | A 的配套（测试需要纯解析入口；契约第 5 节「配置解析」） |
| 主机配置某项 `role` 给了且不是 `render` → `bad-host-config`（原来接受任何合法角色、连接时一律改 `render`） | `host.mjs` | C（契约第 2 节形状 `role: 'render'`；RHC3「role 不是 render」） |
| 素材回退按基址挑票据：`setMediaFallbackTicket` 的回调每试一个回退基址调一次、参数是基址；新增 `fallbackTicketFor(records)`；主机改用它（原来 `wired[0].ticket`）；PC 节点包成不带参数的调用 | `server/asset-client.ts`、`host.mjs`、`server/vite-plugin-frames.ts` | 任务第 2 项（遗留缺陷） |
| RH1 断言改为超 4 报错、`hostMaxConcurrent` 不合格报错、任意一项取最大值、role≠render 报错；RH4「给 9 按 4 算」改为「给 9 报 `bad-host-config`、给 4 可以」；新增 RH-fallback-ticket | `server/test/render-host.test.mjs` | 按裁定改实现方单测（主会话授权） |
| 契约末尾加「## 6. 集成时的裁定（2026-09-26）」 | `docs/plan/render-host-contract.md` | — |

裁定里「诊断计数累计、completed 不含 dedup」「plan 跳过在节点过滤器与会话层」「并发计入在飞认领」三条，实现本来就符合，没改。

RH-fallback-ticket：两台素材服务（各自的票据签发方）、素材只在第二台；回退基址 `[A, B/]`。对照：回调一律给第一个项目的票据 → 回 401（复现原缺陷）；换成 `fallbackTicketFor` → 206、字节正确，且 A、B 各取一次各自项目的票据；不属于任何项目的基址回 null。

## 3. 验证（worktree 根目录）

```
node --test server/test/render-host*.test.mjs   → tests 31 / pass 31 / fail 0（RHC 20/20，RH 11/11）
  胶水接好后连跑 3 遍 render-host*.test.mjs（当时 RH 10 条）：30/30、30/30、30/30
node --test server/test/auth-impl-client.test.mjs → 7/7（setMediaFallbackTicket 的老用例仍过）
npx tsc -b --force                               → tsc EXIT 0
npm test                                         → EXIT 0
  ℹ tests 2597 / pass 2596 / fail 0 / cancelled 0 / skipped 1（原有的 /api/cards/layout 那条）
```

RHC 各条第一次接上就全过，没有 B 类（测试写错）也没有 D 类新歧义。

G0-R（动了预渲染进程里的 `vite-plugin-frames.ts` 与 `asset-client.ts`）：

| 探针 | 命令 | 结果 |
|---|---|---|
| ready-index-probe | `node scripts/probes/ready-index-probe.mjs --port 5400`（TEMP/TMP 指到 scratchpad） | 退出码 0，`"fails": []`，`snapshot.sameBytes: true` |
| preview-fallback-probe --page-preload | 另起 `npx vite --port 5403 --strictPort --host 127.0.0.1` | 退出码 0，PASS，`beats 289`、`transparentBeats 0`、`taskP90 12.315`、`pageErrors []`、`fails []` |
| preview-fallback-probe | 同一台 dev server | 退出码 0，PASS，`beats 288`、`transparentBeats 0`、`taskP90 13.08`、`fails []` |

跑完用 `taskkill /T` 结束了我起的 5403 进程树；端口 5400～5409 查过无监听残留。

### render-host-probe 完整 H1/H2/H3 序列

编排同 AGENT-m6-host.md 第 3 节（creator 5400；r1 host-a 5403、host-b 5406；r2 host-c 5403 `--code-version test-code-version-mismatch`、host-bad 5406 口令错；check r1/r2 用 5403；auth-check `--rate-limit`）。全部角色退出码 0。原始 JSON 行：

```
== creator
{"role":"creator","port":5400,"state":"C:\\Users\\admin\\AppData\\Local\\Temp\\claude\\C--Users-admin-Documents-PromptCut\\b27266f2-12b6-470f-ae3c-baab02fc8037\\scratchpad\\integ2\\rhp","rounds":[{"round":"r1","hosts":["host-a","host-b"],"planId":"plan:render-host-probe@1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":1,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":58114},{"round":"r2","hosts":["host-c","host-bad"],"planId":"plan:render-host-probe@2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":58284}],"projectId":"sp_yatphacyjlkkgsgbfccajd6tij","pc":{"mode":"shared","nodeId":"prerender:DESKTOP-GS40TCK:5400","envFingerprint":"258acaaa7c5fe509","codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee"},"auth":["auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"127.0.0.1\",\"reason\":\"bad-proof\"}"],"ok":true,"fails":[]}
== host-a
{"ok":true,"name":"host-a","round":"r1","port":5403,"projectId":"sp_yatphacyjlkkgsgbfccajd6tij","claimed":2,"completed":2,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-b
{"ok":true,"name":"host-b","round":"r1","port":5406,"projectId":"sp_yatphacyjlkkgsgbfccajd6tij","claimed":2,"completed":2,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-c
{"ok":true,"name":"host-c","round":"r2","port":5403,"projectId":"sp_yatphacyjlkkgsgbfccajd6tij","claimed":0,"completed":0,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,"codeVersion":"test-code-version-mismatch","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":true,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== host-bad
{"ok":true,"name":"host-bad","round":"r2","port":5406,"projectId":"sp_yatphacyjlkkgsgbfccajd6tij","claimed":0,"completed":0,"dedup":0,"seen":0,"connected":false,"opens":0,"handshake":401,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":10,"assetBase":"http://127.0.0.1:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
== check-r1
{"role":"check","round":"r1","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"claimed:host-a":2,"claimed:host-b":2,"completedByNode":{"pc":1,"host-a":2,"host-b":2},"sumCompleted":5,"pcPlanClaimed":true,"reused":0,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
== check-r2
{"role":"check","round":"r2","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"claimed:host-c":0,"claimed:host-bad":0,"completedByNode":{"pc":3,"host-c":0,"host-bad":0},"sumCompleted":3,"pcPlanClaimed":true,"reused":2,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
== auth-check
{"role":"auth-check","ok":true,"loopback":true,"projectId":"sp_yatphacyjlkkgsgbfccajd6tij","wrongPassword":401,"rightPassword":101,"ticket":true,"assetNoTicket":404,"assetWithTicket":404,"afterFiveWrong":101,"fails":[]}
```

- **H1**：check r1 `duplicateDone 0`、`missingDone 0`，完成数 PC 1 + host-a 2 + host-b 2 = 5；`identical: true`，**`identicalBytes: true`**，`styleOrderOnly: 0`——在含 M6c X6 的基线上，主机产的 240 帧 + 3 个 `index.json` 与单机重渲逐字节相同（上次 M6b 分支上是 `identicalBytes: false`、240 帧只差 style 顺序）。
- **H2**：host-c `seen 4`、`claimed 0`；check r2 `identicalBytes: true`。
- **H3**：host-bad `handshake 401`、`opens 0`、`connectFailed 10`、`claimed 0`。
- auth-check：回环上 `assetNoTicket`/`afterFiveWrong` 按设计不判（`loopback: true`），同上次。

## 4. 失败归类

- A 胶水：RHC1～RHC4、RHC11～RHC20 原先败在载入假设模块，接胶水后全过。
- B 测试写错：无。
- C 实现与契约或裁定不符（已按裁定修）：`maxConcurrent` 截断而非报错；不合格值被忽略而非报错；`role` 非 render 被接受。另修遗留缺陷（素材回退票据）。
- D 契约歧义：无新增。测试方报告第 5 节的 2、3、6、7、8 条由主会话裁定、已写入契约第 6 节；第 4、5 条（哪些字段必填、单个对象是否合法）实现与测试一致（沿用 M6a `normalizeEntry`、单个对象也收），没另写裁定。

## 5. 没做的、建议

- 胶水里 `createRenderHost` 的拼装是照 `startHostNode` 抄的一份，RHC 测的是 `render-node/host.mjs` 的编排，不覆盖 `vite-plugin-frames.ts` 里那份接线本身（由探针覆盖）。若想让单测直接覆盖，可以把 `startHostNode` 里「每项建端点、start + 计时器 tick、release 顺序」抽成 `host.mjs` 的一个函数；本任务范围外，没动。
- `docs/reports/AGENT-m6-host.md` 第 7 节「多台素材服务的回退票据」这条遗留已修，那份报告没改（不在我的文件清单）。
