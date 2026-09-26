# SP 集成对账报告（claude/sp-integ）

状态：做完，等主会话审查。

worktree：`.worktrees/sp-integ`，分支 `claude/sp-integ`（已合并 claude/sp-hosting、claude/sp-routing、claude/sp-tests 与 claude/m6 的 W5 探针跨机模式，起点 `c40a4bd`）。
端口：托管组合 8790 / 8791、协调口 8799、creator 编辑器 5470～5472、host-a 5473～5475、host-b 5476～5478、局域网 creator 5490～5492、协调口 5499、验证用 dev server 5480～5482。没碰 5400～5409、5190～5192。
没推送、没合并、没部署远端、没装依赖、没建 junction、没跑 npm ci；只结束了自己起的进程树（结束前核对过命令行），收尾时 5470～5499、8790～8799 上没有我的监听。

## 1. 做了什么

### 1.1 按裁定核对实现（C 类，按裁定改了实现）

| 裁定 | 核对结果 | 改动 |
|---|---|---|
| 数据目录不存在就启动失败，部署脚本先建 | 已符合（`data-dir`；`deploy-hosted` 远端脚本 `mkdir -p` 数据目录与 `secrets/`） | 无 |
| `.layout` 不符退出码 1、原因 `layout`；内容 `{"v":1,"layout":"shard"\|"flat"}` | 退出码与原因词已符合；**布局名是 `shard2`，不符** | `fs-store.mjs` 的 `LAYOUTS.shard` 改 `'shard'`（`.layout` 与素材端口 `/healthz` 随之）；SPH 用例里 4 处期望跟着改；契约第 10 节两处改名 |
| migrate-check：`--from/--to` 文档服务 http 地址；令牌从环境变量或 secrets/ 读；项目数经管理接口 | 地址与管理接口已符合；**只读环境变量，不符** | 令牌先取 `PROMPTCUT_CLUSTER_TOKEN`，没有再读 `<数据目录>/secrets/cluster-token`（`--data-dir` 或 `PROMPTCUT_DATA_DIR`）；输出加 `tokenFrom` |
| findSharedProject：托管 404 不进 errors、连不上才进 | 已符合 | 无 |
| 局域网候选 base 用 `http://<ip>:<端口>/docservice/` | **实现是 `ws://…/docservice`，不符** | `route.mjs` 加 `candidateBaseOf`，局域网候选 `http://ip:端口/docservice/`、托管候选 `http://主机:端口/`、`createSharedProject` 回的 `base` 同形；连 WebSocket 处（`shared-project-lan.mjs` member）改用 `wsBaseOf(base)`；SPR 用例 8 处期望跟着改 |
| 手填与发现按 base 去重 | **实现按 projectId 去重，不符** | 手填与发现合并时按 `base` 去重（发现的在前）。同一项目经几块网卡被发现，发现这一路自己仍按 projectId 只列一次（裁定只说了手填与发现之间；SPR-5b 的「多网卡只列一次」保留）。补 SPR-5f |
| 局域网发现与托管查询可并行 | 已并行 | 无 |
| 507 在素材服务 HTTP 层映射 | 已符合（`asset-service.ts`） | 无 |
| 凭证存储读不了只在 `PROMPTCUT_LAN_HOST=1` 下拒绝启动 | 已符合（`vite-plugin-docservice.ts`） | 无 |
| 广播按实际绑定；`PROMPTCUT_LAN_HOST` 压过 `--host`；运行时不能换绑定 | 已符合；实测 `--host 127.0.0.1` 加环境变量绑到 `0.0.0.0:5480/5481/5482` | 遗留写进契约第 11 节 |
| SP7 探针 0xC0000409 保留规避 | 互联网模式探针已规避；**局域网模式探针仍 `process.exit`** | `shared-project-lan.mjs` 的 `finish` 改成同样的自然退出（设 `exitCode`、10 s unref 兜底） |

契约末尾加了「## 11. 集成时的裁定（2026-09-26）」，逐条「裁定：理由」，含 C6.5 遗留。

### 1.2 SPC 胶水（只改 `sp-kit.mjs`，断言、用例、期望都没动）

`loadLan()` 改成对上 `server/lan/discovery.mjs`：常量键名换算、`encodeQuery`/`encodeAnnounce`/`decodePacket`（补回 magic、v）、`createLanHost`（`deviceName`→`hostDeviceName`、`docservicePort`→`servicePort`、网卡数组→函数）、`discoverLan`（`targets` 落在实现的注入点：每个目标当一块网卡的定向广播地址，回 `.hosts`）。对法写在 `loadLan` 的注释与文件头 L0。

为了接上，实现侧有两处改动（请主会话复核）：
- **抽出 `createLanTable({ now, expireMs, onChange })`**（不碰套接字的过期表），`createLanClient` 改用它。SPC4-6 要同步地 `see` / `list`，而 `createLanClient` 是 async 且表在闭包里，胶水无从下手。行为差别：`list()` 现在读时就滤掉过期的（原来要等 1 s 一次的 `sweep`）；过期未清的条目再见到算新见到。
- **nonce 放宽到 1～64 位 URL 安全字符**（原 8～64）。契约第 4 节只写 `nonce`、没限长度，SPC4-2 / 4-3 用 `abc123`、`nonce-1`，实现把契约允许的包丢了——归 C。SPR-4c 原来断言 `short` 被拒，改成非法字符与 65 位被拒。

### 1.3 探针

- `shared-project-probe.mjs`：`--mode lan` 改为 `await (await import('./shared-project-lan.mjs')).runLan(ROLE, argv)`；公共部分用 sp-hosting 版；互联网模式新建改走 `route.mjs` 的 `createSharedProject({ where: 'hosted' })`（sp-hosting 报告第 3 节第 4 条）。
- 协调口抽成 `scripts/probes/probe-coord.mjs`：`/healthz`、`PUT /kv/<键>`、`GET /kv/<键>?wait=`，其余路径交给 `extra`。`shared-project-probe`（`--role coord`、`--coord-port`）、`shared-project-lan`、`render-host-probe`（`/configs`、`/ready`、`/round`、`/result`、`/state`、`/stop` 挂在 `extra` 上）都用它，**同一个口两个探针可以共用**（下面的演练里 shared-project-probe 就借了 render-host-probe 的 8799）。顺带修了一个潜在错：局域网模式的协调口客户端原来没拆 `{ ok, value }`，`--coord` 交接会拿不到项目名。
- `render-host-probe.mjs` creator 加 `--hosted <文档服务 http 地址>`：项目建在托管端；`creator.json` 与各主机配置的 `url` 都是托管端；本机编辑器只绑回环、队列模式、凭 `PROMPTCUT_SHARED_CONFIG` 连托管端发布真实 plan；协调口照起（0.0.0.0:`--coord-port`）；`--rounds` 缺省 `r1:host-a,host-b`。auth-check：独立文档服务时素材地址取 `service.endpoints` 下发的（编辑器挂载的照旧同源推，保证 W5 行为不变），输出加 `assetBase`。
- SPR-6a 守门：`server/hosted/main.mjs` 的 IP 在 sp-hosting 的 `b35355e` 已改成占位，集成分支上 SPR-6a / SPC6-3 都过，没再改。

## 2. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| SP 系列 | `node --test server/test/sp-*.test.mjs` | 退出码 0；tests 92 / pass 92 / fail 0；**SPC 53/53、SPH 14/14、SPR 25/25** |
| 集成前的 SP 系列（对照） | 同上，未改时 | tests 91 / pass 81 / fail 10（SPC4-1～4-9 找不到 `lan-discovery.mjs`，SPC5-2 base 是 ws 形） |
| 全量 | `npm test` | 退出码 0；tests 2703 / pass 2702 / fail 0 / cancelled 0 / skipped 1（原有的「集成:/api/cards/layout 对真实项目返回整数框」） |
| 类型 | `npx tsc -b --force` | 退出码 0，零输出 |
| 编辑器 | `PROMPTCUT_LAN_HOST=1 node vite.js --port 5480 --strictPort --host 127.0.0.1`（模拟桌面壳），`preview-fallback-probe --origin http://127.0.0.1:5480 --page-preload` | 监听 `0.0.0.0:5480/5481/5482`；探针退出码 0，`transparentBeats: 0`，`pageErrors: []`，`PASS`（counts dense 504 / snapshot 152 / placeholder 502 / placeholder-delay 27，taskP90 21.0 ms） |

### 2.1 W6 互联网模式的本机演练（任务第 4 项）

编排在 scratchpad 的 `integ/run-hosted.mjs`（不入库）。托管组合：`node server/hosted/main.mjs`，数据目录 scratch 下新建，`secrets/cluster-token` 放随机令牌，环境里没有 `PROMPTCUT_CLUSTER_TOKEN`，`PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1`，绑 0.0.0.0、公网地址写本机局域网 IP 192.168.50.96——所有客户端都经 192.168.50.96 连，服务端看到的来源不是回环，票据路径是真走的。顺序：creator(--hosted, 5470, 协调口 8799) → host-a(5473) 与 host-b(5476) 并行 → check r1(5473) → shared-project-probe 互联网 creator + member（借 8799 的 `/kv`）→ auth-check → stop。

**退出码**：`host-a 0, host-b 0, check-r1 0, sp-creator 0, sp-member 0, auth-check 0, stop 0, creator 0`（托管组合 `1` 是我收尾时 `taskkill /F` 结束的）。

托管组合启动行：
```
{"event":"listen","role":"hosted","host":"0.0.0.0","node":"v24.19.0",...,"docservice":{"port":8790,"publicUrl":"ws://192.168.50.96:8790"},"asset":{"port":8791,"publicUrl":"http://192.168.50.96:8791/api/asset","announced":true},"admin":"token:file","authStore":"ok","loopbackTrust":false}
```

原始 JSON：
```
host-a {"ok":true,"name":"host-a","round":"r1","port":5473,"projectId":"sp_gm6rdnl67ovljajdgvqxo5lbjn","claimed":2,"completed":2,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://192.168.50.96:8791/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
host-b {"ok":true,"name":"host-b","round":"r1","port":5476,"projectId":"sp_gm6rdnl67ovljajdgvqxo5lbjn","claimed":2,"completed":2,"dedup":0,"seen":6,"connected":true,"opens":1,"handshake":101,"codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","envFingerprint":"258acaaa7c5fe509","codeVersionOverride":false,"exitCode":0,"released":0,"failed":0,"lost":0,"connectFailed":0,"assetBase":"http://192.168.50.96:8791/api/asset","maxConcurrent":1,"profile":"host","fails":[]}
check-r1 {"role":"check","round":"r1","ok":true,"tasks":5,"done":5,"duplicateDone":0,"missingDone":0,"planDoneCount":1,"hostOk:host-a":true,"claimed:host-a":2,"hostOk:host-b":true,"claimed:host-b":2,"completedByNode":{"pc":1,"host-a":2,"host-b":2},"sumCompleted":5,"pcPlanClaimed":true,"reused":0,"compared":{"dirs":3,"singleFiles":243,"creatorFiles":243,"htmlFiles":240},"styleOrderOnly":0,"styleOrderWithDuplicateProps":0,"differentFrames":0,"differences":[],"identicalBytes":true,"identical":true,"fails":[]}
sp-creator {"ok":true,"mode":"internet","role":"creator","hosted":"http://192.168.50.96:8790","runId":"muhfv8n2-ca0232","name":"sp-probe-muhfv8n2-ca0232","projectId":"sp_tneq5zmvv75w4zdhc6cvl3ymkg","assetUrl":"http://192.168.50.96:8791/api/asset","snapshot":{"projectId":"sp-probe-project","projectRev":1,"digest":"d7f2fc4a7afc2767044e0dc32d345c2f0754430273bb8f28d70790b904dfb685","bytes":149},"content":{"kind":"snapshot-manifest","key":"sp-probe/muhfv8n2-ca0232","hash":"79a80fbcc123fd0c7402856a9f2a71617e51d26c1277c261f9082fa35d9e183d"},"media":{"hash":"c209f62d61a80e1b1f6b8cd16f29d1c2cc57830f1ef83a3e783bedf936284f3b","bytes":262144},"tasks":{"published":6,"completed":6,"duplicateDone":0,"byCreatorNode":1},"artifactsWritten":1,"member":{...同下 sp-member...},"coord":"http://192.168.50.96:8799","fails":[],"ms":2450}
sp-member {"ok":true,"mode":"internet","role":"member","hosted":"http://192.168.50.96:8790","projectId":"sp_tneq5zmvv75w4zdhc6cvl3ymkg","clusterToken":"unset","enter":{"ok":true,"ms":81},"assetUrl":"http://192.168.50.96:8791/api/asset","snapshot":{"ok":true,"projectRev":1,"parts":1,"bytes":149},"content":{"ok":true},"media":{"bearer":true,"query":true,"noTicket":401,"loopbackTrusted":false},"ticket":{"rw":true,"r":true},"claims":5,"taskDone":5,"artifactsWritten":5,"expectTasks":1,"fails":[],"ms":2442}
auth-check {"role":"auth-check","ok":true,"loopback":false,"docHost":"192.168.50.96","projectId":"sp_gm6rdnl67ovljajdgvqxo5lbjn","initialCooldownWaitMs":71,"wrongPassword":401,"rightPassword":101,"ticket":true,"assetBase":"http://192.168.50.96:8791/api/asset","assetPutNoTicket":401,"assetPutWithTicket":200,"assetComplete":200,"assetNoTicket":401,"assetWithTicket":200,"assetRangeWithTicket":206,"assetRangeNoTicket":401,"assetBadTicket":401,"fails":[]}
stop {"role":"stop","coord":"http://192.168.50.96:8799","ok":true,"fails":[]}
creator {"role":"creator","port":5470,"state":"...\\hosted-run-muhfqwvb\\st-creator","rounds":[{"round":"r1","hosts":["host-a","host-b"],"planId":"plan:render-host-probe@1","tasks":5,"done":5,"failed":0,"doneCounts":[1,1,1,1,1],"reused":0,"pcCompleted":1,"pcDedup":0,"pcPlanClaimed":true,"preloadMs":57984}],"hosted":"http://192.168.50.96:8790","coordPort":8799,"projectId":"sp_gm6rdnl67ovljajdgvqxo5lbjn","pc":{"mode":"shared","nodeId":"prerender:DESKTOP-GS40TCK:5470","envFingerprint":"258acaaa7c5fe509","codeVersion":"d23ea1ad4a77828ada5e5383e386167b675ad4928e25bf385811b10a85d7ceee","url":"ws://192.168.50.96:8790","assetBases":[]},"auth":[],"ok":true,"fails":[]}
```

产物落在托管组合的数据目录里（收尾时数的，跳过 `.chunks`）：
```
assets/px    156 个文件 9191398 字节
assets/snap  180 个文件 4723872 字节
assets/media   2 个文件  263168 字节（两个探针各传了一个素材）
assets/.layout {"v":1,"layout":"shard"}
/admin/inventory（带令牌）：sharedProjects 2，px 156 / 9191398，snap 180 / 4723872，media 2 / 263168（与数文件一致）
```

对照验收：creator 与 host-a / host-b / check 退出码全 0；`duplicateDone 0`；`identicalBytes true`；host-a、host-b 各 `claimed 2`；主机 `assetBase` 是托管端下发的 `http://192.168.50.96:8791/api/asset`；PC 节点 `pc.url` 是托管端文档服务。
读法：`pc.assetBases` 为空，是因为预渲染进程的 `push.asset-base` 日志没进编辑器的输出，这个字段读不到东西（不影响判定；产物确实都在托管端数据目录里）。

### 2.2 局域网模式本机一轮（改了 base 形与协调口之后重跑）

编排 `integ/run-lan.mjs`：`--role coord --port 5499`，`--mode lan --role creator --port 5490 --coord …`，`--mode lan --role member --coord …`（两边 `--state` 各用各的，只经协调口交接）。creator 0、member 0（coord 1 是我结束的）。

```
lan-member {"ok":true,"mode":"lan","role":"member","name":"lan-probe-a1cc3a","hosted":"skipped","discovery":{"ms":1539,"firstSeenMs":11,"via":"discover","action":"enter","candidates":1,"errors":[]},"candidate":{"base":"http://192.168.50.96:5490/docservice/","projectId":"sp_zq2h5hwa3tjcp5o55hrczfb6td","hostDeviceName":"lan-probe-host","asset":"http://192.168.50.96:5490/api/asset"},"adminFromLan":{"bare":401,"token":401},"handshake":{"ok":true,"ms":76},"snapshot":{"projectRev":1,"bytes":207,"digestOk":true},"asset":{"noTicket":401,"withTicket":200,"sha256Ok":true},"render":{"claims":3,"completed":3,"dedup":0,"failed":0,"expect":3},"fails":[]}
lan-creator {"ok":true,"mode":"lan","role":"creator","port":5490,"name":"lan-probe-a1cc3a","projectId":"sp_zq2h5hwa3tjcp5o55hrczfb6td","lanAddress":"192.168.50.96","editorOnLan":true,"broadcasting":true,"selfDiscoverMs":1538,"published":3,"completed":3,"duplicateDone":0,"member":{...同上...},"goneAfterDelete":true,"fails":[],"selfFirstSeenMs":5,"lanStopLogged":true,"lanLog":["[docservice] lan.start {\"port\":54887,\"interfaces\":[\"192.168.50.96\"],\"projects\":1}","[docservice] lan.stop {}"]}
```

## 3. 失败归类

集成前 SP 系列的 10 条失败：

| 用例 | 类 | 说明 |
|---|---|---|
| SPC4-1、4-5、4-6、4-7、4-8、4-9 | A 胶水 | 模块路径与函数形状不同；胶水对上（4-6 另要实现抽出 `createLanTable`） |
| SPC4-2、4-3、4-4 | A + C | 胶水之外，实现把 6～7 位 nonce 当非法——契约第 4 节只写 `nonce`，没限长度，实现改为 1～64 位 |
| SPC5-2 | C | 候选 base 是 ws 形，与裁定「http://<ip>:<端口>/docservice/」不符，按裁定改实现 |

没有 B 类（测试写错）。D 类（契约歧义，只报告）：
1. **多网卡去重**：裁定只定了「手填与发现按 base 去重」。发现这一路同一项目从几块网卡被发现时，我保留了 sp-routing 的做法（按 projectId 只列一次）。如果要求一律按 base，SPR-5b 要改期望。
2. **托管候选 base 的形状**：裁定只定了局域网的；托管候选我也用 http 形、以 `/` 结尾（`http://8.219.80.16:8787/`），`createSharedProject` 回的 `base` 同形。
3. **托管端非 404 的 HTTP 错误**（如 500）：现在进 `errors`（`http-500`），与「连不上才进」字面上不完全一致；我理解为「不是正常答复就进」。

## 4. 给主会话的远端部署命令清单（按最终代码核对）

`$R` 指 `root@8.219.80.16`，`PROMPTCUT_REMOTE_KEY` 与账号见 `docs/local.md`。和 sp-hosting 报告第 6 节的差别：`/healthz` 的 `layout` 是 `shard`；migrate-check 可在服务器上用 `--data-dir` 读令牌。

**一、服务器准备**（ssh 上去）：
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
umask 077
mkdir -p /var/lib/promptcut/hosted/secrets
chmod 700 /var/lib/promptcut /var/lib/promptcut/hosted /var/lib/promptcut/hosted/secrets
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))" > /var/lib/promptcut/hosted/secrets/cluster-token
chmod 600 /var/lib/promptcut/hosted/secrets/cluster-token
# 可选：并入旧文档服务的数据（先停旧服务）
# pm2 stop promptcut-docservice
# mkdir -p /var/lib/promptcut/hosted/docservice && cp -a /opt/promptcut-docservice/data/. /var/lib/promptcut/hosted/docservice/
```
（也可以不在服务器上生成令牌：本机设 `PROMPTCUT_CLUSTER_TOKEN` 后，第二步加 `--write-token`。）

**二、本机部署**（在合入后的仓库根目录）：
```bash
PROMPTCUT_REMOTE=$R node scripts/remote/docservice.mjs probe
PROMPTCUT_REMOTE=$R node scripts/remote/docservice.mjs deploy-hosted --replace-docservice --save
PROMPTCUT_REMOTE=$R node scripts/remote/docservice.mjs status-hosted
```
不加 `--replace-docservice` 而旧的 `promptcut-docservice` 还在 PM2 里时，退出码 3。

**三、防火墙**（服务器上，脚本不改 UFW）：`ufw allow 8788/tcp comment 'promptcut-asset'`；`ufw status numbered`；阿里云安全组放行 TCP 8788。

**四、验证**：
```bash
curl -fsS http://8.219.80.16:8787/healthz      # 有 connections 字段，W6 局域网模式核对「托管端连接数不变」用它
curl -fsS http://8.219.80.16:8788/healthz      # {"ok":true,"role":"asset","layout":"shard"}
pm2 logs promptcut-hosted --lines 50           # 看有没有 ExperimentalWarning 或 .ts 载入错误
```

**五、M8 演练实例**：
```bash
# 服务器上
pm2 stop promptcut-hosted
rsync -aS /var/lib/promptcut/hosted/ /var/lib/promptcut/drill/
find /var/lib/promptcut/hosted -type f | wc -l; du -sb /var/lib/promptcut/hosted
find /var/lib/promptcut/drill  -type f | wc -l; du -sb /var/lib/promptcut/drill
pm2 start promptcut-hosted
ufw allow 8777/tcp comment 'promptcut-drill-doc'; ufw allow 8778/tcp comment 'promptcut-drill-asset'
# 本机
PROMPTCUT_REMOTE=$R node scripts/remote/docservice.mjs deploy-hosted --instance drill
PROMPTCUT_CLUSTER_TOKEN=<令牌> node scripts/probes/shared-project-probe.mjs --role migrate-check --from http://8.219.80.16:8787 --to http://8.219.80.16:8777
# 或在服务器上（需要有仓库的探针），令牌直接从数据目录读：
#   node scripts/probes/shared-project-probe.mjs --role migrate-check --from http://127.0.0.1:8787 --to http://127.0.0.1:8777 --data-dir /var/lib/promptcut/hosted
# 演练完
# pm2 delete promptcut-drill ; ufw delete allow 8777/tcp ; ufw delete allow 8778/tcp
```

## 5. W6 指令草稿

两台机器检出同一个提交（合并后的分支），依赖已装好，命令都在仓库根目录执行，下面用 PowerShell。每条命令最后一行是一行 JSON，`ok: true` 且 `$LASTEXITCODE` 为 0 才算过；`ok: false` 时原样保留整行，别重跑覆盖。

### 5.1 互联网模式（主 PC creator --hosted；笔记本接手机热点）

前提：第 4 节部署完、8787 / 8788 通。笔记本在手机热点下连不到主 PC 的局域网地址，协调口要经服务器转一道（SSH 隧道，只走服务器回环，不开防火墙）：

- 主 PC：`ssh -N -R 127.0.0.1:15409:127.0.0.1:5409 root@8.219.80.16`（私钥见 `docs/local.md`）
- 笔记本：`ssh -N -L 5409:127.0.0.1:15409 root@8.219.80.16` → 笔记本上协调口是 `http://127.0.0.1:5409`

笔记本没有这把私钥时，这一步要主会话另定（例如让两台都接同一个热点，协调口直接用主 PC 在热点上的地址；主机到托管端仍走公网）。

**步骤 0（服务器）记基线**：`du -sb /var/lib/promptcut/hosted; find /var/lib/promptcut/hosted/assets/px -type f | wc -l; pm2 describe promptcut-hosted | grep -i memory; cat /proc/net/dev`。

**步骤 1（主 PC）creator**：
```powershell
node scripts/probes/render-host-probe.mjs --role creator --port 5400 --hosted http://8.219.80.16:8787 --coord-port 5409 --rounds "r1:host-a,host-b;r2:host-c;r3:host-bad" --timeout-min 30 --hold-min 60
```
起来要 1～2 分钟。之后开上面的隧道。

**步骤 2（笔记本）连通性**：`Invoke-RestMethod http://127.0.0.1:5409/state` → `phase` 是 `waiting-hosts:r1`；`Invoke-RestMethod http://8.219.80.16:8788/healthz` → `layout: shard`。

**步骤 3（笔记本）r1，两个终端**：
```powershell
node scripts/probes/render-host-probe.mjs --role host --name host-a --round r1 --port 5403 --coord http://127.0.0.1:5409
node scripts/probes/render-host-probe.mjs --role host --name host-b --round r1 --port 5406 --coord http://127.0.0.1:5409
```
期望：`handshake 101`、`connected true`、`assetBase "http://8.219.80.16:8788/api/asset"`、`failed 0`、`lost 0`、`exitCode 0`；`claimed` 大于 0，`envFingerprint` / `codeVersion` 等于 creator 最后输出的 `pc.*`（不等时主机不会认领，记下来报回）。

**步骤 4（笔记本）r2、r3**（依次）：
```powershell
node scripts/probes/render-host-probe.mjs --role host --name host-c --round r2 --port 5403 --coord http://127.0.0.1:5409 --code-version test-code-version-mismatch --expect-claims none
node scripts/probes/render-host-probe.mjs --role host --name host-bad --round r3 --port 5406 --coord http://127.0.0.1:5409 --expect-handshake 401 --expect-claims none
```

**步骤 5（主 PC）check**：
```powershell
node scripts/probes/render-host-probe.mjs --role check --round r1 --port 5403 --coord http://127.0.0.1:5409
node scripts/probes/render-host-probe.mjs --role check --round r2 --port 5403 --coord http://127.0.0.1:5409
node scripts/probes/render-host-probe.mjs --role check --round r3 --port 5403 --coord http://127.0.0.1:5409
```
期望：`done = tasks`、`duplicateDone 0`、`missingDone 0`、`identical true`（`identicalBytes` 预期 true）、r1 的 `completedByNode` 里 host-a / host-b 非零。

**步骤 6（笔记本）auth-check**：
```powershell
node scripts/probes/render-host-probe.mjs --role auth-check --rate-limit --coord http://127.0.0.1:5409
```
期望：`loopback false`、`docHost "8.219.80.16"`、`assetBase "http://8.219.80.16:8788/api/asset"`、素材各项 401 / 200 / 206 同 W5、`afterFiveWrong 401`、`challengeInCooldown "challenge-429"`、`afterCooldown 101`。

**步骤 7 shared-project-probe 互联网模式**（借同一个协调口的 `/kv`）：
```powershell
# 主 PC
node scripts/probes/shared-project-probe.mjs --mode internet --role creator --hosted http://8.219.80.16:8787 --coord http://127.0.0.1:5409
# 笔记本（环境里不能有 PROMPTCUT_CLUSTER_TOKEN：先 Remove-Item Env:PROMPTCUT_CLUSTER_TOKEN -ErrorAction SilentlyContinue）
node scripts/probes/shared-project-probe.mjs --mode internet --role member --hosted http://8.219.80.16:8787 --coord http://127.0.0.1:5409
```
期望：member `clusterToken "unset"`、`enter.ok`、`media.noTicket 401`、`claims`/`taskDone` 大于 0；creator `tasks.completed = published`、`duplicateDone 0`、`member.ok true`。

**步骤 8 结束**：`node scripts/probes/render-host-probe.mjs --role stop --coord http://127.0.0.1:5409`；creator 打出结果行、退出码 0。关隧道。

**步骤 9（服务器）记占用**：重复步骤 0 的命令，报告里写磁盘占用增量、px 文件数增量、RSS、`/proc/net/dev` 前后差（SP8）。

### 5.2 局域网模式（主 PC lan creator，笔记本同网段 member）

主 PC 192.168.50.96，笔记本同网段。第一次在笔记本上跑可能弹防火墙提示，放行 node.exe（专用网络）。

```powershell
# 主 PC 终端 1：协调口
node scripts/probes/shared-project-probe.mjs --role coord --port 5409 --host 0.0.0.0
# 主 PC 终端 2：局域网主机（起编辑器、建局域网项目、广播）
node scripts/probes/shared-project-probe.mjs --mode lan --role creator --port 5480 --coord http://192.168.50.96:5409 --tasks 3 --hold-min 10
# 笔记本：发现并进入
node scripts/probes/shared-project-probe.mjs --mode lan --role member --coord http://192.168.50.96:5409
```
期望（member）：`discovery.ms` ≤ 5000、`via "discover"`、`candidate.base "http://192.168.50.96:5480/docservice/"`、`adminFromLan {bare:401, token:401}`、`asset {noTicket:401, withTicket:200, sha256Ok:true}`、`render.completed` = 3、`hosted "skipped"`。creator：`broadcasting true`、`completed 3`、`duplicateDone 0`、`goneAfterDelete true`。
发现不到（AP 隔离、组播被挡）时，再跑一次手填兜底，creator 重来后 member 加 `--manual http://192.168.50.96:5480`，期望 `via "manual"`。
SP4「发现与进入期间托管端连接数不变」：member 前后各 `Invoke-RestMethod http://8.219.80.16:8787/healthz`，比 `connections`（member 不给 `--hosted`，全程不问托管端）。
结束后主 PC 终端 1 按 Ctrl+C 关协调口。

## 6. 对任务书与语义的更正建议

- W6 互联网模式「笔记本在手机热点下」时，协调口到不了主 PC——要么用第 5.1 节的 SSH 隧道（笔记本要有服务器私钥），要么两台都接同一个热点。任务书里要定一种。
- `hosting-migration.md` 写「具体命令在 SP 合入时补进本文」，还没补，不在本任务清单里；第 4 节的命令可以直接用。
- `render-host-probe` creator 输出的 `pc.assetBases` 读不到预渲染进程的日志，恒为空，可以删掉或改从诊断接口取。

## 7. 提交

```
e24e94e 报告:sp-integ 开工
b1dfe6d 按集成裁定改实现:.layout 布局名 shard;路由候选 base 改 http 形,手填与发现按 base 去重
52c4dfc SPC 局域网用例接到实现:sp-kit 胶水;实现抽出 createLanTable、nonce 放宽到 1～64 位;补 SPR-5f
d5edf5a SPR-4c:nonce 的拒收用例改成非法字符与超长
34df1f3 探针:--mode lan 接 shared-project-lan.mjs;协调口抽成 probe-coord.mjs;migrate-check 令牌可读 secrets/;render-host-probe creator 加 --hosted
bc057d0 契约:加第 11 节集成时的裁定;第 10 节布局名改 shard
c108bc5 render-host-probe auth-check:挂载的文档服务照旧同源推素材地址
```
另有本报告的提交。
