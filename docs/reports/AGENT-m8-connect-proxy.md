# AGENT-m8-connect-proxy 报告

分支 `claude/m8-connect-proxy`，基于 `278eeb9`，收尾前合过 main（`e88d49f`，含 main `211695d`）。worktree `.worktrees/m8-connect-proxy`，端口 5790～5799。

任务：M8 执行计划第 7 节裁定 **D5**（「只能出网的节点」那一侧：云端节点当时已归档，改在本机仿一个只经 HTTP CONNECT 代理出网的独立渲染主机；真「只能出网」的那一侧仍记待跨机复核）。

## 1. 查实

| 项 | 结论 | 依据 |
|---|---|---|
| 本机 Node | v24.19.0，自带 undici 7.29.0 | `node --version`、`process.versions.undici` |
| 主机连文档服务的客户端 | **Node 自带的全局 `WebSocket`（undici）**，不是 `ws` 库。`scripts/render-host.mjs` → 编辑器 vite → 预渲染进程 `server/vite-plugin-frames.ts` 的 `startHostNode` → `render-node/session-link.mjs` 的 `createDocEndpoint`（缺省 `globalThis.WebSocket`） | 读代码 |
| 素材服务 | `server/asset-store/client.mjs` 用全局 `fetch`（推产物、读票据后的上传下载）；素材回退 `server/asset-client.ts` 的 `serveFromFallbacks` 用 `http.request` / `https.request`（不指定 agent → 全局 agent）；`server/media-pull.mjs` 用全局 `fetch` | 读代码 |
| 卡片同步、票据、成本记录 | 卡片同步 `createHostCardSync`、票据 `createTicketSource` 都走同一条 render 会话，不另开连接 | 读代码 |
| 协调口 KV | 探针自己的 `coordClient` 用全局 `fetch` | 读代码 |
| `NODE_USE_ENV_PROXY=1` + 代理变量对它们是否生效 | **全部生效**。实验（本机 127.0.0.2 上起 http/https + ws/wss 目标，经本分支的代理）：全局 `fetch` 与全局 `WebSocket` 不论明文还是 TLS 都走 **CONNECT**（同一进程里 fetch 与 WebSocket 常复用同一条隧道）；`http.get` 走明文目标时是**绝对地址转发**（不是 CONNECT），`https.get` 是 CONNECT。`--use-env-proxy` 与小写变量名同样生效 | 见第 3.1 节 |
| 必须的 `NO_PROXY` | 主机自己的编辑器、预渲染进程、Chrome 调试口、`render-host.mjs` 读诊断都在 127.0.0.1 上；不设 `NO_PROXY=localhost,127.0.0.1,::1` 这些都会被送进代理。探针替主机设好 | 读代码 + 实跑 |
| Chrome | 只加载本机回环上的预渲染源，素材由预渲染进程（Node）转发；Windows 上的 Chrome 不读代理环境变量，也不需要。四轮实跑里进程树没有任何 chrome 直连外部的连接 | 第 3.2 节 `no-direct-tcp` |

结论：**产品代码不用改**。独立渲染主机以 `NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY`（和 `HTTP_PROXY`）、`NO_PROXY=localhost,127.0.0.1,::1` 运行，就只经代理出网，传输照常是 WebSocket。主会话转来的外网事实也吻合：云端节点（Node 22、`NODE_USE_ENV_PROXY=1`，有多个出口地址）上主机的 WebSocket 与 HTTPS 都经代理出网并正常认领、完成（run `c10s0928c/d`）。

## 2. 做了什么

只动了清单内的文件：

| 文件 | 内容 |
|---|---|
| `scripts/probes/m8/connect-proxy.mjs`（新） | 最小出站代理，只用 Node 内置模块：接 `CONNECT` 隧道、绝对地址转发和带 Upgrade 的转发；每条连接记目标 `host:port`、种类、双向字节、时长、错误，不记路径、查询串与请求头；`--allow` 白名单（不在单上回 403 并记 denied）；`GET /__status`（只答回环）给探针跨进程取记录；stdin `status` / `quit`。可当模块 import，也可当命令跑 |
| `scripts/probes/m8-outbound-probe.mjs`（新） | D5 探针。creator 直接用 `ht-w-probe.mjs --role creator`，KV 沿用 `htw.<run>.*`，本脚本不重写；本脚本写 `host` 与 `all` 两个角色。host 没带代理环境变量时带上它们重新起自己；每 5 s 采一次本进程树的 TCP 连接（Windows 用 `Get-CimInstance` 加 `Get-NetTCPConnection`，Linux 用 `/proc` 加 `ss -tanpH`，只认比父进程晚起的子进程，免得父 id 被复用时误算）。`--proxy env` 给已经自带出网代理的云端容器用；`all` 是本机替身，`--proxy-env` 让主机按容器的方式只从环境变量拿代理 |
| 本报告 | |

本机替身怎么仿「远端」：托管组合（文档服务 5790、素材服务 5791，素材登记地址 `http://127.0.0.2:5791/api/asset`）和协调口（5799）都绑在 **127.0.0.2**。127.0.0.1 在 `NO_PROXY` 里、127.0.0.2 不在，所以主机要连它们只能经代理（127.0.0.1:5798），进程树里只要出现对端是 127.0.0.2 的连接，就算直连。creator 的编辑器用 5792～5794，主机用 5795～5797。127.0.0.1 上的 5790、5791 常被别的检出的预渲染进程占到，第一次起就撞上过一回，所以做了这样的调整。

提交（不含合并）：`003d86c`（报告开工）、`daac9de`（代理）、`54022ba`（探针）、`24cc388`（端口布局）、`495b265`（进程树只认晚起的子进程；另记主机的失败 / 丢租约事件）、`9744080`（`--proxy env`、Linux 采样、直连判据改为「对端不是回环也不是代理」、代理地址记录去掉口令）、`229cf2b`（`all --proxy-env`）。合并：`claude/m8-kit`、main 两次（最后一次 `e88d49f`）。

## 3. 验证

### 3.1 查实用的实验（scratchpad，不入库）

`NODE_USE_ENV_PROXY=1 HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:5796 NO_PROXY=localhost,127.0.0.1,::1`，目标在 127.0.0.2：

- 明文目标：fetch、http.get、WebSocket 都成功；代理记到 `CONNECT 127.0.0.2:5795`（fetch 和 WebSocket 共用这一条）与 `FORWARD GET http://127.0.0.2:5795/httpget`。单独跑 WebSocket（大写变量、小写变量、`--use-env-proxy` 三种写法）各记到一条 CONNECT。
- TLS 目标（自签证书加 `NODE_EXTRA_CA_CERTS`）：fetch、https.get、wss 都成功；代理只记到两条 `connect 127.0.0.2:5797`（字节 2325/3416、1737/3192），没有转发。

### 3.2 本机替身（`node scripts/probes/m8-outbound-probe.mjs --role all --out <scratchpad>/rN`）

每轮 16 个细任务（4 条轨道 × 8 s 的 `r6-canvas`，按 60 帧一段切），主机并发 2。四轮都是 **退出码 0、`ok: true`、`fails: []`**，check 全部通过。

| 轮 | 代码 | 模式 | 用时 | 主机 / 发布方完成 | J-全完 | J-恰一 | 传输 | 代理：文档服务 5790 | 代理：素材服务 5791 | 代理：协调口 5799 | TCP 采样 / 到代理 / 直连 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `24cc388` | 显式代理 | 990 s | 13 / 3 | PASS | PASS（17 个 id 各 1 次） | ws，opens 1，resumes 0，legacy false | 1 条 CONNECT，↑329 393 ↓145 767 | 95 条，↑54.6 MB ↓1.42 MB | 51 条（含 creator 那边的 1 条） | 76 / 172 / **0** |
| 2 | `24cc388` | 显式代理 | 1201 s | 13 / 3 | PASS | PASS | ws，1/0/false | 1 条，↑330 853 ↓144 206 | 98 条，↑57.4 MB ↓1.47 MB | 61 条 | 95 / 241 / **0** |
| 3 | `229cf2b` | `--proxy-env` | 965 s | 12 / 4 | PASS | PASS | ws，1/0/false | 1 条，↑305 928 ↓130 361 | 88 条，↑53.1 MB ↓1.34 MB | 49 条 | 85 / 211 / **0** |
| 4 | `229cf2b` | 显式代理 | 793 s | 13 / 3 | PASS | PASS | ws，1/0/false | 1 条，↑321 189 ↓131 495 | 99 条，↑53.3 MB ↓1.38 MB | 42 条 | 74 / 180 / **0** |

每轮代理汇总的种类都只有 `connect`，没有转发，也没有 denied。第 2 轮的结果行（节选，原样）：

```
ok true ms 1201037 run mukcplw8873f fails []
PASS host:host-transport-ws {"transport":"ws","legacy":false,"opens":1,"resumes":0}
PASS host:proxy-covers-docservice {"target":"127.0.0.2:5790","seen":{"conns":1,"up":330853,"down":144206,"kinds":{"connect":1},"denied":0,"errors":0}}
PASS host:proxy-covers-asset {"target":"127.0.0.2:5791","seen":{"conns":98,"up":57350962,"down":1465360,"kinds":{"connect":98},"denied":0,"errors":0}}
PASS host:no-direct-tcp {"samples":95,"toProxyTotal":241,"direct":[],"sampleErrors":[]}
PASS host:render-host-exit {"exitCode":0}
PASS J-all-done {"from":"creator:all-done","detail":{"failed":[]}}
PASS J-exactly-once {"from":"creator:done-exactly-once"}
proxySummary {"conns":160,"denied":0,"kinds":{"connect":160},"up":57713930,"down":1645400,"byTarget":{"127.0.0.2:5799":{"conns":61,...},"127.0.0.2:5790":{"conns":1,...},"127.0.0.2:5791":{"conns":98,...}}}
host {"completed":13,"dedup":0,"claimed":15,"failed":0,"lost":2,"transport":"ws","legacy":false,"assetBase":"http://127.0.0.2:5791/api/asset","tcp":{"samples":95,"maxPids":25,"names":["conhost.exe","node.exe","powershell.exe","chrome-headless-shell.exe"],"toProxyTotal":241,"direct":0}}
```

主机的 `lost` 在各轮里是 1、2、3、0，第 1 轮另有 `failed` 1。这几个任务都被重新认领并完成了，J-全完、J-恰一没受影响。第 3 轮记到三条 `node.lost`，间隔好几分钟，时间点与机器上十来个子智能体同时占 CPU 的时段相符；第 4 轮是 0。这与出站路径无关，只作记录，没有做成判据。

跑完核对：命令行含本分支或 run 目录的进程为 0（只剩我起的一个 `tail` 监视进程，已结束），5790～5799 上没有监听。

### 3.3 基线（合并 main `211695d` 之后）

- `npx tsc -b --force`：退出码 0，输出 0 字节。
- `npm test`：退出码 0，tests 3641、pass 3639、fail 0、skipped 2（是原有的两条，要自己起 dev server 才跑）。

没跑导出确定性、导出与快照重放一致、画面这几项：本分支没动渲染、导出、卡片代码。

## 4. 生效不了的出站连接与建议

**在主机进程树里没找到生效不了的**：四轮 TCP 旁证的直连都是 0，代理记录覆盖了文档服务、素材服务和协调口。下面几条不算缺陷，是限制，照实记下：

1. **`http.request` 走明文目标时不是 CONNECT，是绝对地址转发**（素材回退 `serveFromFallbacks`、`media-pull` 以外的 `http.request` 调用）。本探针的项目里没有素材，没触发到。真实云端只有 https，https 目标走的是 CONNECT，不受影响；只有「只放行 CONNECT 443 的代理 + 明文素材地址」这种组合会失败。建议：不改代码，在 `product/platforms.md` 或 `mechanism/platforms.md` 的「只能出网的节点」里补一句三级机制：只能出网的节点连的服务一律用 https 地址。按 `suggested_agent_behavior.md`，这属三级语义，交主会话定，我没有写。
2. **`NO_PROXY` 必须含回环**。不含时主机连自己的编辑器、预渲染进程、Chrome 调试口都会走代理。`render-host.mjs` 目前不管代理环境变量。建议（三级、可选）：`renderHostEnv` 在 `NODE_USE_ENV_PROXY=1` 时把 `localhost,127.0.0.1,::1` 并进 `NO_PROXY`，省得每个部署自己记。我没改。
3. **UDP 没查**（局域网发现用 UDP）。主机不开局域网发现，不影响本结论。

## 5. 没做成的与更正建议

- **跨机没跑**：本任务要求不连阿里云。给笔记本的命令见 `m8-outbound-probe.mjs` 文件头「跨机」一节，和回复里给的一样。**指纹限制**：ht-w 的 creator 要求主机的环境指纹与它的本机节点相同，PC 与笔记本（或云端容器）的指纹多半不同。main 里如果已经有测试指纹开关 `PROMPTCUT_TEST_ENV_FINGERPRINT`（C10），就在两台的终端里设同一个值；没有的话，creator 改在笔记本上跑。阿里云上的文档服务、素材服务和协调口同在 `8-219-80-16.sslip.io:443` 后面，代理记录按 host:port 分不开三者。
- **对计划 D5 的更正建议**：D5 写的「真『只能出网』的那一侧仍记待跨机复核」可以按主会话转来的云端实测（run `c10s0928c/d`）改成「已由云端节点复核：WebSocket 与 HTTPS 都经代理出网，认领、完成正常」。本替身用来补云端证不了的两点：代理逐条的目标与字节记录，以及进程树没有直连的旁证。云端那一轮如果想要同样的旁证，可以在容器里跑 `--role host --proxy env`，那样有 Linux 的 TCP 采样。
- 没加单测：放在 `server/test/` 就要改 `bakery-deps.test.mjs` 的例外名单，会越出本分支的文件清单。代理的行为由第 3.1 节的实验和四轮实跑覆盖。
