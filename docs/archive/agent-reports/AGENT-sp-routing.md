# SP 路由与局域网发现实现报告（claude/sp-routing）

契约：`docs/plan/shared-project-contract.md` 第 3、4、5 节，第 6 节 `--mode lan`，第 7 节 SP2 / SP4 / SP5 / SP6。
方案出处：`docs/plan/direct-connect-plan.md`「设计要点」第 4 条。凭证：`docs/plan/auth-contract.md`（含第 14 节）。
worktree：`.worktrees/sp-routing`，分支 `claude/sp-routing`（基于 `claude/sp`）。端口段 5480～5489，没碰 5190～5192。

## 1. 做了什么

| 契约 | 内容 | 文件 |
|---|---|---|
| 第 3 节 缺省托管地址 | `DEFAULT_HOSTED_URL = 'http://8.219.80.16:8787'`，全仓源码里唯一写出这个 IP 的地方。覆盖顺序 `hostedUrlChoice({ ui, env })` / `resolveHostedUrl`：界面值 → `PROMPTCUT_HOSTED_URL` → 缺省；空串与空白算没设；设了但不是 http(s) / ws(s) 地址的抛 TypeError，不悄悄回落。浏览器里没有 `process`，第 2 级自然跳过 | `server/auth/hosted-default.mjs`（新增） |
| 第 3 节 路由 | `findSharedProject({ name, hostedUrl, uiHostedUrl, lan: { discover, manual, timeoutMs }, fetch })` 回 `{ candidates, errors }`；`pickRoute` 按候选数给 `enter` / `choose` / `not-found`；`createSharedProject({ where: 'hosted' \| 'lan', … })`。浏览器与 Node 通用（只引 `client.mjs`、`hosted-default.mjs`），局域网发现由调用方注入（Node 传 `discoverLan`，浏览器不传，只走手填与托管端） | `server/auth/route.mjs`（新增） |
| 第 4 节 局域网发现 | 只用 `node:dgram`、`node:os`。纯函数：选网卡、子网广播地址、按查询方地址认收包网卡、查询目标、包的编码与校验、周期间隔。主机端 `createLanHost`（逐网卡 `addMembership`，TTL 1，查询单播应答、地址取收包网卡的，15 s ± 3 s 周期通告，单包 ≤ 1 KiB，每 10 s 查网卡变化并重建成员资格）；客户端 `createLanClient`（可常驻收周期通告，45 s 过期）与一次性的 `discoverLan`（500 ms × 3 次查询，组播加子网定向广播，总时限 3 s） | `server/lan/discovery.mjs`（新增） |
| 第 4、5 节 局域网主机 | `PROMPTCUT_LAN_HOST=1` 时编辑器绑 `0.0.0.0`（`vite.config.ts` 里一个插件的 `config` 钩子，能压过桌面壳写死的 `--host 127.0.0.1`）；文档服务与素材服务挂在同一个 http 服务器上随之可达。编辑器绑了非回环地址且凭证存储里有项目时起广播（`createLanHosting`），`shared/create` 后立即通告、创建者操作 `delete` 删光后停、编辑器关闭时停。`PROMPTCUT_LAN_HOST=1` 而凭证存储读不了：拒绝启动。管理接口只认回环：核对了没回退（SPR-2d、探针 `adminFromLan`） | `vite.config.ts`、`server/vite-plugin-docservice.ts`、`server/docservice/shared-service.mjs`（加 `onCreate` / `onDelete` 两个回调，其余不动） |
| 第 6 节 探针 | `--mode lan --role creator`：起局域网主机（`PROMPTCUT_LAN_HOST=1`）、建项目、等 `lan.start`、自己发现自己、传素材与快照、发布假细任务、等全部 `task.done` 与成员结果、以创建者操作删项目后确认发现不到。`--mode lan --role member [--manual <url>]`：发现（记耗时）、局域网来源的管理接口 401、凭证进入、快照、素材（不带票据 401、带票据 200 且 sha256 相符）、`render` 认领并完成。协调走 `--state <目录>`，也可 `--coord <url>`（与互联网模式 `--role coord` 的 KV 同形） | `scripts/probes/shared-project-lan.mjs`（新增，局域网模式的全部逻辑）、`scripts/probes/shared-project-probe.mjs`（本分支只有分派） |
| 第 7 节 单测 | SPR-2a～2e、SPR-4a～4i、SPR-5a～5e、SPR-6a～6c，共 24 条 | `server/test/sp-routing.test.mjs`（新增） |

## 2. 验证

### 基线（worktree 根目录）

```
npx tsc -b --force        → tsc EXIT 0
npm test                  → npm test EXIT 0
ℹ tests 2621
ℹ pass 2620
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```

新增单测单独跑：`node --test server/test/sp-routing.test.mjs` → `tests 24 / pass 24 / fail 0`。其中 SPR-4d（两个 dgram 套接字在本机回环上）实测发现窗口 1.53 s、第一次应答 5 ms；SPR-4i（真 dgram + 挂载模式文档服务，发现之后凭证进入）约 1.6 s，托管端连接数前后相同。

### 本机局域网模式一轮（creator + member，同一台机器，端口 5480）

```
node scripts/probes/shared-project-probe.mjs --mode lan --role creator --port 5480 --state <scratchpad>/lan-state --tasks 3 --hold-min 5   → creator EXIT 0
node scripts/probes/shared-project-probe.mjs --mode lan --role member --state <scratchpad>/lan-state                                      → member EXIT 0
```

member 原始 JSON：

```json
{"ok":true,"mode":"lan","role":"member","name":"lan-probe-13eb77","hosted":"skipped","discovery":{"ms":1542,"firstSeenMs":6,"via":"discover","action":"enter","candidates":1,"errors":[]},"candidate":{"base":"ws://192.168.50.96:5480/docservice","projectId":"sp_zm637s532u56fdtxrzssvt3o2v","hostDeviceName":"lan-probe-host","asset":"http://192.168.50.96:5480/api/asset"},"adminFromLan":{"bare":401,"token":401},"handshake":{"ok":true,"ms":92},"snapshot":{"projectRev":1,"bytes":207,"digestOk":true},"asset":{"noTicket":401,"withTicket":200,"sha256Ok":true},"render":{"claims":3,"completed":3,"dedup":0,"failed":0,"expect":3},"fails":[]}
```

creator 原始 JSON：

```json
{"ok":true,"mode":"lan","role":"creator","port":5480,"name":"lan-probe-13eb77","projectId":"sp_zm637s532u56fdtxrzssvt3o2v","lanAddress":"192.168.50.96","editorOnLan":true,"broadcasting":true,"selfDiscoverMs":1539,"published":3,"completed":3,"duplicateDone":0,"member":{"ok":true,"mode":"lan","role":"member","name":"lan-probe-13eb77","hosted":"skipped","discovery":{"ms":1542,"firstSeenMs":6,"via":"discover","action":"enter","candidates":1,"errors":[]},"candidate":{"base":"ws://192.168.50.96:5480/docservice","projectId":"sp_zm637s532u56fdtxrzssvt3o2v","hostDeviceName":"lan-probe-host","asset":"http://192.168.50.96:5480/api/asset"},"adminFromLan":{"bare":401,"token":401},"handshake":{"ok":true,"ms":92},"snapshot":{"projectRev":1,"bytes":207,"digestOk":true},"asset":{"noTicket":401,"withTicket":200,"sha256Ok":true},"render":{"claims":3,"completed":3,"dedup":0,"failed":0,"expect":3},"fails":[]},"goneAfterDelete":true,"fails":[],"selfFirstSeenMs":13,"lanStopLogged":true,"lanLog":["[docservice] lan.start {\"port\":54887,\"interfaces\":[\"192.168.50.96\"],\"projects\":1}","[docservice] lan.stop {}"]}
```

读法：
- **发现耗时**：`discovery.ms` 1542 ms（`findSharedProject` 整趟，含收集窗口），第一次见到主机在查找开始后 6 ms（`firstSeenMs`）。SP4 的「≤ 5 s」本机满足；跨机在 W6 验。
- 成员经本机局域网地址 `192.168.50.96` 连编辑器，服务端看到的来源不是回环，所以走的是局域网成员的路径：管理接口不带凭证、带令牌项都 401；素材不带票据 401、带票据 200。
- 不给 `--hosted`：全程不问托管端（`hosted: 'skipped'`）。
- 删项目后编辑器日志出现 `lan.stop`，再发现查不到（`goneAfterDelete: true`）。
- **防火墙**：首次监听 UDP 54887 没有弹窗。本机 `node.exe` 已有入站放行规则（`Node.js JavaScript Runtime`，Inbound Allow，Public），网络配置是 Public。没改任何防火墙设置。

### 编辑器照常（改了 vite 的 host 绑定）

`preview-fallback-probe`，worktree 的编辑器，端口 5483（舞台 5484 / 5485）：

| 起法 | 监听 | 命令 | 结果 |
|---|---|---|---|
| `PROMPTCUT_LAN_HOST=1`，不给 `--host` | `0.0.0.0:5483/5484/5485` | `--origin http://127.0.0.1:5483` | EXIT 0，`transparentBeats: 0`，`PASS` |
| 同上 | 同上 | `--page-preload` | EXIT 0，`transparentBeats: 0`，`PASS` |
| 不设，`--host 127.0.0.1` | `127.0.0.1:5483/5484/5485` | `--page-preload` | EXIT 0，`transparentBeats: 0`，`PASS` |

另查了桌面壳的情形：`PROMPTCUT_LAN_HOST=1` 加 `--host 127.0.0.1`（桌面壳 `lib.rs` 写死的参数）起在 5486，netstat 显示 `0.0.0.0:5486/5487/5488`，即环境变量压过了命令行。

起的 dev server 都只结束了自己起的进程树（`taskkill /T`，结束前核对过命令行），收尾时 5480～5489 与 UDP 54887 都没有监听。

## 3. 与契约不一致之处（请主会话裁定）

1. **发现与托管端查询同时进行**（第 3 节写「先在本网段发现，限时 3 s；再向托管端」）：两边结果都列出、谁也不挑，同时进行只省时间，结果相同。
2. **一次性发现不总是等满 3 s**：最后一次查询之后再等 500 ms 就收尾（缺省约 1.5 s），3 s 是上限。要等满（例如为了收齐同名的多台主机）可以传 `timeoutMs` / `graceMs`。
3. **`errors` 的原因词**：托管端 `unreachable`、`timeout`、`http-<状态码>`、`bad-address`；局域网 `timeout`（谁也没应答）、`discover-failed`、`no-interface`、`socket`、手填地址的 `unreachable` / `bad-address`。托管端 404 不算错误，只是没有候选。手填查到了，局域网的 `timeout` 就不再报。
4. **`hostedUrl: null` / `false` 表示这次不问托管端**：探针靠它做到「全程不连托管端」（SP4）。界面值用参数 `uiHostedUrl` 传。
5. **写错的覆盖地址抛错**，不回落到缺省。理由：用户设错了地址却连到别处，比报错更难查。
6. **什么时候广播**：按编辑器**实际绑的地址**判，不只看 `PROMPTCUT_LAN_HOST`。`npm run dev`（本来就 `--host 0.0.0.0`）如果凭证存储里有项目，也会广播。只绑回环时不广播（通告出去的地址别人连不上）。编辑器重启后，凭证存储里已有的项目会重新开始通告（契约只写了「建成后」）。
7. **拒绝启动只在 `PROMPTCUT_LAN_HOST=1` 时**：第 5 节写「绑非回环而凭证存储没加载，拒绝启动（M6a）」，但 M6a 在挂载模式下的实现是「只打 `config.error`，局域网来的一律 401」。为了不改 `npm run dev`（绑 0.0.0.0）的现有行为，我只在显式要求局域网主机时拒绝启动。要不要对所有非回环绑定都拒绝，由主会话定。
8. **`PROMPTCUT_LAN_HOST=1` 压过命令行的 `--host`**：桌面壳按 `--host 127.0.0.1` 拉起编辑器，写在 `server.host` 里会被命令行盖掉，所以改用插件的 `config` 钩子。第 5 节说的「由 C6.5 在运行时打开」没做：vite 的 http 服务器不能在运行时换绑定地址，C6.5 需要带着这个环境变量重启编辑器（或由桌面壳支持），这属于 C6.5 与桌面壳。
9. **收包网卡按子网认**：Node 的 dgram 拿不到收包网卡（没有 IP_PKTINFO），所以按查询方地址与各网卡的子网对号（TTL 1 的查询只可能来自直连网段）。主机一块网卡都没有时，不答查询。
10. **同一轮查询的去重**：同一个查询经组播与子网广播会到两次，主机按「nonce + 查询方」在 250 ms 内只答一次。隔 500 ms 的重发照常作答（重发本来就是为了抵消丢包）。
11. **周期通告只发组播**：第 4 节的子网广播兜底只写了查询，我照此办理。
12. **候选多带的字段**：`base` 统一写成文档服务的 `ws://` 地址（直接交给 `buildAuthProtocols`）；局域网候选另带 `asset`、`via`（`discover` / `manual`）、`firstSeenMs`。同一项目从多块网卡被发现时只列一次（按 `projectId`）。
13. **探针分文件**：局域网模式的全部逻辑在 `scripts/probes/shared-project-lan.mjs`。`shared-project-probe.mjs` 在本分支只是分派。`claude/sp-hosting` 的同名文件（它的工作区里已有，尚未提交）末尾是 `else if (MODE === 'lan') { console.error(...) }`。集成时以那边的文件为准，把这个分支换成 `const { runLan } = await import('./shared-project-lan.mjs'); await runLan(ROLE, argv);` 即可，公共部分不用动。

## 4. 遗留与提醒

- **守门测试会拦 sp-hosting**：`claude/sp-hosting` 工作区里 `server/hosted/main.mjs` 第 16～17 行的注释写了 `ws://8.219.80.16:8787`、`http://8.219.80.16:8788/api/asset`。SPR-6a 按契约只放过 `hosted-default.mjs`（注释也算源码），合并后会失败。建议那边改成 `ws://<公网 IP>:8787` 之类的写法，或者从 `hosted-default.mjs` 引。
- 守门的扫描范围：`git ls-files -co --exclude-standard` 里的代码类扩展名（mjs / js / ts / json / rs / py / ps1 / html 等），排除 `docs/`、`archive/`、`planning/`、`test/` 目录、`*.test.*`、`scripts/probes/`、全部 `.md`。没有 git 时自己遍历目录。
- **跨机没验**：局域网模式跨机（SP4 / SP8 的 W6）、「不同网段发现不到」、AP 隔离与防火墙挡组播的情形，都要在 W6 实地验。跨机时：creator 所在机器起协调口（互联网模式的 `--role coord`，绑局域网地址），两边都给 `--coord <url>`；也可以在 member 上直接给 `--name`、`--password`。探针自建的项目口令只写在 state 目录与协调口里。
- **防火墙**：本机 `node.exe` 已有入站放行，所以没有弹窗。别的机器第一次跑局域网主机时可能弹窗，要放行 `node.exe` 的 UDP 54887 入站（以及编辑器端口的 TCP）。
- 编辑器的凭证存储在 `<root>/out/docservice/auth/`，探针跑完会以创建者操作删掉自己的项目（`--keep` 时保留）。worktree 里这一轮没有留下项目。
- `route.mjs` 还没接到界面上：属于 C6.5（界面上的托管地址、新建时选托管 / 局域网、打开时的候选列表）。

## 5. 提交

```
0afc364 探针:shared-project-probe 的 --mode lan(creator 起局域网主机建项目并广播、member 发现后进入、读快照与素材、认领完成)
f3fbc46 测试:SPR-2/4/5/6(令牌边界、局域网发现两个 dgram 套接字、路由四种组合、托管地址守门与覆盖顺序);插件导出 createLanHosting 供测试注入
a0dc7f6 功能:打开与新建的路由(route.mjs);局域网主机:PROMPTCUT_LAN_HOST=1 绑 0.0.0.0、有共享项目时广播与应答、删光或退出时停
d3c261b 功能:缺省托管地址与覆盖顺序(hosted-default.mjs);局域网发现的主机端与客户端(server/lan/discovery.mjs)
1cb24bd 文档:sp-routing 报告占位
```

回退梯次没触发：探针第一次就通过；单测只有 SPR-4b 第一次失败过一次，原因是测试里写错了期望的网卡顺序（按网卡名的码位排序，`Wi-Fi` 排在 `ppp` 前面），改了期望后通过，实现没改。
