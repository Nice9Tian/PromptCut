# M6 W5:render-host-probe 跨机模式

worktree `.worktrees/m6-w5`,分支 `claude/m6-w5`(基于 `claude/m6`)。只改了 `scripts/probes/render-host-probe.mjs` 与本报告,产品代码没动。
端口只用 5400～5409(协调服务 5409),没碰 5190～5192。没推送、没合并、没装依赖、没建 junction、没跑 npm ci。

## 1. 改动

全部在 `scripts/probes/render-host-probe.mjs`:

1. **creator `--lan <IP>`、`--coord-port`(缺省 5409)**
   - 编辑器以 `--host 0.0.0.0` 起(端口空闲检查同时查 127.0.0.1 与 0.0.0.0);文档服务、素材服务随之对局域网可达。除素材服务外的 `/api/**` 仍只答回环(`http-guard.mjs`),主机用不到它们。
   - host-a / host-b / host-c / host-bad / member(auth)配置里的 `url` 用 `ws://<IP>:<port>/docservice`。`creator.json`(本机 PC 节点)仍连 127.0.0.1,建项目也走回环(挂载模式只有回环能建,auth-contract 第 4 节)。
   - `--rounds` 在 `--lan` 下缺省改为 `r1:host-a,host-b;r2:host-c;r3:host-bad`。理由:host-bad 连错会让它的来源进入 60 s 冷却(auth-contract 第 9 节),跨机时 host-c 与 host-bad 在同一台笔记本上,同一轮会把 host-c 也拒掉。本机模式缺省不变。
   - 另起探针自己的协调 HTTP 服务(绑 0.0.0.0),背后就是 creator 的 state 目录里原来那批文件,creator 自己的流程一行没变:
     `GET /configs/<名>`(host-a/host-b/host-c/host-bad/auth;还没写出时 404;不给 creator 的)、`POST /ready/<名>`、`GET /round/<轮>`(未完 404)、`POST /result/<名>`、`GET /result/<名>`、`GET /state`(`phase`、`stop`)、`POST /stop`。creator 退出时关掉它。
2. **host / auth-check / check 加 `--coord http://<IP>:<coord-port>`**:经一个小的 `channel` 层,配置从协调服务取(写到本机 `--state` 目录的 `<名>.config.json` 交给 `render-host.mjs`),ready、等轮次、stop、结果都经协调服务,不读写 creator 的 state 目录。不带 `--coord` 时走原来的文件。check 仍须在 creator 那台机器上跑(读创建者帧库、起单机重渲);新增输出 `hostOk:<名>`。
3. **auth-check 判法加强**(本机回环跑时这些非回环项不判,与原来一致):
   - 非回环来源开始前先等「对口令握手 101」(最多 150 s,输出 `initialCooldownWaitMs`):笔记本上先跑的 host-bad 可能让这个来源还在冷却里。
   - 用 rw 票据往素材服务传一块 1 KiB 的真内容(1 片 + complete),读的判法因此落到 200 / 206 而不是「不存在的 404」:不带票据写 401、带票据写 200、收尾 200;带票据 GET 200、Range 206;不带票据 GET 401、Range 401;签名不对的票据 401。
   - `--rate-limit`:先为对口令取好挑战(冷却中挑战本身回 429,对口令的握手根本发不出来——原来的写法在非回环来源上判不出「口令对也 401」),再连错 5 次,用取好的挑战握手 → 401;冷却中新取挑战 → `challenge-429`;等 61 s 后新挑战 + 对口令 → 101。
   - 握手函数拆成 `prepareProtocols`(取挑战)与 `rawHandshake`;挑战失败回 `'challenge-<状态码>'` 而不是抛错。
4. **新角色 `--role stop`**:有 `--coord` 时 `POST /stop`,否则写 `<state>/stop`。

安全提示:协调服务不设鉴权,`/configs/*` 回的是含口令的配置。只在可信局域网里跑,跑完 creator 退出即关。

## 2. 本机验证

### 2.1 跨机模式(`--lan 192.168.50.96` + `--coord http://192.168.50.96:5409`)

编排脚本放在 scratchpad(`w5/run-lan.mjs`,不入库):creator 5400;r1 host-a 5403、host-b 5406 并行;r2 host-c 5403(`--code-version test-code-version-mismatch --expect-claims none`);r3 host-bad 5406(`--expect-handshake 401 --expect-claims none`);check r1/r2/r3 用 5403;auth-check `--rate-limit`;stop。各角色 `--state` 各用各的目录,模拟不共享文件系统。

用的是本机局域网 IP 而不是 127.0.0.1:主机连 `ws://192.168.50.96:5400` 时服务端看到的对端是 192.168.50.96,**不是回环**,所以票据、401、限速与冷却这些非回环判法在本机就真的判了(creator 的 `auth.reject` 日志里 `remote` 都是 192.168.50.96)。跨机真正多出来的只有防火墙与两台机器的环境指纹差异。

全部 10 个角色退出码 0。原始 JSON 行(顺序:host-b、host-a、host-c、host-bad、check r1、r2、r3、auth-check、stop、creator):

```
{"ok":true,"name":"host-b","round":"r1","port":5406,"projectId":"sp_bvzzaqqkocsbk4odu25rojvzxk","claimed":1,"completed":1,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://192.168.50.96:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
{"ok":true,"name":"host-a","round":"r1","port":5403,"projectId":"sp_bvzzaqqkocsbk4odu25rojvzxk","claimed":2,"completed":2,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://192.168.50.96:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
{"ok":true,"name":"host-c","round":"r2","port":5403,"projectId":"sp_bvzzaqqkocsbk4odu25rojvzxk","claimed":0,"completed":0,"dedup":0,"seen":4,"connected":true,"opens":1,"handshake":101,"codeVersion":"test-code-version-mismatch","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":true,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://192.168.50.96:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
{"ok":true,"name":"host-bad","round":"r3","port":5406,"projectId":"sp_bvzzaqqkocsbk4odu25rojvzxk","claimed":0,"completed":0,"dedup":0,"seen":0,"connected":false,"opens":0,"handshake":401,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":5,"assetBase":"http://192.168.50.96:5400/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
{"role":"check","round":"r1","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-a":true,"claimed:host-a":2,"hostOk:host-b":true,"claimed:host-b":1,"completedByNode":{"pc":2,"host-a":2,"host-b":1},"sumCompleted":5,"pcPlanClaimed":true,"reused":0,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
{"role":"check","round":"r2","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-c":true,"claimed:host-c":0,"completedByNode":{"pc":3,"host-c":0},"sumCompleted":3,"pcPlanClaimed":true,"reused":2,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
{"role":"check","round":"r3","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-bad":true,"claimed:host-bad":0,"completedByNode":{"pc":3,"host-bad":0},"sumCompleted":3,"pcPlanClaimed":true,"reused":2,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
{"role":"auth-check","ok":true,"loopback":false,"docHost":"192.168.50.96","projectId":"sp_bvzzaqqkocsbk4odu25rojvzxk","initialCooldownWaitMs":68,"wrongPassword":401,"rightPassword":101,"ticket":true,"assetPutNoTicket":401,"assetPutWithTicket":200,"assetComplete":200,"assetNoTicket":401,"assetWithTicket":200,"assetRangeWithTicket":206,"assetRangeNoTicket":401,"assetBadTicket":401,"wrongStatuses":[401,401,401,401,"challenge-429"],"afterFiveWrong":401,"challengeInCooldown":"challenge-429","afterCooldown":101,"fails":[]}
{"role":"stop","coord":"http://192.168.50.96:5409","ok":true,"fails":[]}
{"role":"creator","port":5400,"state":"C:\\Users\\admin\\AppData\\Local\\Temp\\claude\\C--Users-admin-Documents-PromptCut\\b27266f2-12b6-470f-ae3c-baab02fc8037\\scratchpad\\w5\\lan-192_168_50_96\\state-creator","rounds":[{"round":"r1","hosts":["host-a","host-b"],"planId":"plan:render-host-probe@1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":2,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":61910},{"round":"r2","hosts":["host-c"],"planId":"plan:render-host-probe@2","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":64341},{"round":"r3","hosts":["host-bad"],"planId":"plan:render-host-probe@3","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":2,"pcCompleted":3,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":63861}],"lan":"192.168.50.96","coordPort":5409,"projectId":"sp_bvzzaqqkocsbk4odu25rojvzxk","pc":{"mode":"shared","nodeId":"prerender:DESKTOP-GS40TCK:5400","envFingerprint":"258acaaa7c5fe509","codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee"},"auth":["auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"rate-limited\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"nonce\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"bad-proof\"}","auth.reject {\"remote\":\"192.168.50.96\",\"reason\":\"rate-limited\"}"],"ok":true,"fails":[]}
```

要点:r1 任务 5,pc 2 + host-a 2 + host-b 1;三轮 `duplicateDone 0`、`missingDone 0`、与单机重渲 `identicalBytes: true`;host-c `claimed 0`、代码版本是测试开关的值;host-bad 握手 401、`connected: false`;auth-check `loopback: false`,素材各项 401/200/206 如期,`wrongStatuses [401,401,401,401,"challenge-429"]`、`afterFiveWrong 401`、`challengeInCooldown "challenge-429"`、61 s 后 `afterCooldown 101`。

### 2.2 本机模式回归(不带 `--lan` / `--coord`)

LOCAL_SECTION

## 3. 没做成的、疑点

- 本机两个回环外地址无法模拟两台机器,环境指纹不同、防火墙这两件只有 W5 真跨机才验得到。
- host-a / host-b 要真认领,笔记本的 `envFingerprint` 必须与主 PC 相同(同代码、同依赖、同浏览器版本);不同时它们认领 0、PC 全做,check 仍会过(它只要求各节点完成数之和对得上)。W5 验收要额外看 host-a/host-b 的 `claimed > 0` 与 `envFingerprint` 等于 creator 输出里的 `pc.envFingerprint`,见下面指令草稿。

## 4. 对任务书的更正建议

- 跨机时 host-c 与 host-bad 不能同一轮(同一来源被 host-bad 连错打进冷却),轮次改为三轮 `r1:host-a,host-b;r2:host-c;r3:host-bad`,`--lan` 下已是缺省。
- 「带票据 → 200/206」要有真存在的内容才判得出,auth-check 现在先用 rw 票据上传一块再读。
- 「连错 5 次后口令对也 401」在非回环来源上必须先取好挑战再连错,否则冷却中挑战先回 429,口令对的握手发不出来。

## 5. W5 指令草稿

命令都在**仓库根目录**下执行(两台机器的 worktree 路径不同)。两台机器都要检出同一个提交(`claude/m6-w5` 或合并后的 `claude/m6`),依赖已装好。以下以 PowerShell 写。

**约定**:PC = 192.168.50.96(Windows,node.exe 入站已放行);笔记本 = 192.168.50.247。笔记本只往外连(PC 的 5400 与 5409),本身不需要入站放行。笔记本上 5403～5408 要空着。每条命令最后一行是一行 JSON,`ok: true` 且退出码 0 才算过;`$LASTEXITCODE` 看退出码。

### 步骤 0(PC)起 creator

```powershell
node scripts/probes/render-host-probe.mjs --role creator --port 5400 --lan 192.168.50.96 --coord-port 5409 --timeout-min 30 --hold-min 60
```

一直挂着,直到步骤 7 发 stop 才打出它的 JSON 行。起来要 1～2 分钟(编辑器与预渲染进程)。

### 步骤 1(笔记本)连通性

```powershell
Invoke-RestMethod http://192.168.50.96:5409/state
```

期望:回 `phase`(`starting` / `waiting-hosts` / `waiting-hosts:r1`)、`projectId`、`stop: False`。连不上就查 PC 防火墙与 creator 是否起来,先别往下走。

### 步骤 2(笔记本)r1:host-a 与 host-b 同时跑(两个终端)

```powershell
node scripts/probes/render-host-probe.mjs --role host --name host-a --round r1 --port 5403 --coord http://192.168.50.96:5409
```
```powershell
node scripts/probes/render-host-probe.mjs --role host --name host-b --round r1 --port 5406 --coord http://192.168.50.96:5409
```

各自在 creator 做完 r1 后退出(每个几分钟)。期望每条:`ok: true`、`handshake: 101`、`connected: true`、`opens: 1`、`exitCode: 0`、`failed: 0`、`lost: 0`、`assetBase: "http://192.168.50.96:5400/api/asset"`、`codeVersionOverride: false`。W5 另要看:`claimed` 与 `completed` 大于 0(两台加起来通常 3 个,PC 做剩下的),`envFingerprint` 与 `codeVersion` 等于 creator 最后打出的 `pc.envFingerprint` / `pc.codeVersion`(不等则笔记本环境不同,主机不会认领,记下来报给主会话)。

### 步骤 3(笔记本)r2:host-c(代码版本不同),等步骤 2 两条都退出后

```powershell
node scripts/probes/render-host-probe.mjs --role host --name host-c --round r2 --port 5403 --coord http://192.168.50.96:5409 --code-version test-code-version-mismatch --expect-claims none
```

期望:`ok: true`、`handshake: 101`、`connected: true`、`claimed: 0`、`completed: 0`、`codeVersion: "test-code-version-mismatch"`、`codeVersionOverride: true`、`exitCode: 0`。

### 步骤 4(笔记本)r3:host-bad(口令错),等步骤 3 退出后

```powershell
node scripts/probes/render-host-probe.mjs --role host --name host-bad --round r3 --port 5406 --coord http://192.168.50.96:5409 --expect-handshake 401 --expect-claims none
```

期望:`ok: true`、`handshake: 401`、`connected: false`、`opens: 0`、`claimed: 0`、`connectFailed` 大于 0、`exitCode: 0`。它连错会让笔记本这个来源进入 60 s 冷却,所以不能和 host-c 同一轮。

### 步骤 5(PC)check,等步骤 4 退出后(三条依次跑)

```powershell
node scripts/probes/render-host-probe.mjs --role check --round r1 --port 5403 --coord http://192.168.50.96:5409
node scripts/probes/render-host-probe.mjs --role check --round r2 --port 5403 --coord http://192.168.50.96:5409
node scripts/probes/render-host-probe.mjs --role check --round r3 --port 5403 --coord http://192.168.50.96:5409
```

每条约 2 分钟。期望:`ok: true`、`tasks: 5`、`done: 5`、`duplicateDone: 0`、`missingDone: 0`、`planDoneCount: 1`、`pcPlanClaimed: true`、`identical: true`(`identicalBytes` 预期也是 true)、`differentFrames: 0`、各主机 `hostOk:<名>: true`。r1 的 `completedByNode` 里 host-a、host-b 应有非零;r2、r3 的 `reused: 2`、`sumCompleted: 3`、主机那一项 0。

### 步骤 6(笔记本)auth-check,可与步骤 5 同时跑

```powershell
node scripts/probes/render-host-probe.mjs --role auth-check --rate-limit --coord http://192.168.50.96:5409
```

约 1～4 分钟(先等 host-bad 造成的冷却过去,最多 150 s;限速那段固定等 61 s)。期望:`ok: true`、`loopback: false`、`docHost: "192.168.50.96"`、`wrongPassword: 401`、`rightPassword: 101`、`ticket: true`、`assetPutNoTicket: 401`、`assetPutWithTicket: 200`、`assetComplete: 200`、`assetNoTicket: 401`、`assetWithTicket: 200`、`assetRangeWithTicket: 206`、`assetRangeNoTicket: 401`、`assetBadTicket: 401`、`wrongStatuses` 前几项 401、最后一两项可能是 `"challenge-429"`、`afterFiveWrong: 401`、`challengeInCooldown: "challenge-429"`、`afterCooldown: 101`。

### 步骤 7(任一台)结束 creator

```powershell
node scripts/probes/render-host-probe.mjs --role stop --coord http://192.168.50.96:5409
```

期望 `{"role":"stop",...,"ok":true}`;随后 PC 上 creator 打出 JSON 行并退出码 0。期望:`lan: "192.168.50.96"`、三轮 `done: 5`、`failed: 0`、`doneCounts` 全 1、`pcPlanClaimed: true`;`auth` 里的 `auth.reject` 的 `remote` 应是笔记本 192.168.50.247(`bad-proof`、`rate-limited` 等)。

### 出问题时

- 任一角色 `ok: false`:原样保留整行 JSON 与 `fails`,别重跑覆盖,交回主会话。
- 笔记本角色卡在「从协调服务取配置」:creator 还没建完项目或 5409 不通;超时由 `--timeout-min`(缺省 20)决定。
- 要重来一遍:先 stop(或结束 creator),再从步骤 0 起;creator 起来时会清空它自己的 state 目录,旧项目作废。
