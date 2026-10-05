# AGENT 报告：probe-hygiene

分支 `claude/probe-hygiene`，起点 main `76eee894`（v0.7.2）。端口段 5680～5689（实际用了 5683～5688）。

任务：
1. 探针和测试起的编辑器不再覆盖公共的 `%TEMP%\promptcut\port.json`。
2. `asset-lan-probe` 不给 `--asset` 时按局域网发现取放本机项目的素材服务地址。
3. 探针判法三处弱点（`cloud-untouched`、`--assert-no-lan`、`real:tasks>=50`），出处 `REPORT-render-queue-m8.md` 第 13.5 节。
4. 注释里 41 处归档前的 `docs/reports/AGENT-…` 路径：按任务书先不做。

## 提交

| 提交 | 内容 |
|---|---|
| `6c34a360` | 报告开工 |
| `671d2ae7` | 任务 1：`PROMPTCUT_NO_PORT_FILE=1` 开关、公共入口设上、两处 `npx vite` 显式设、守门 `port-file.test.mjs` |
| `8312a018` | 任务 2：`asset-lan-probe` 先按局域网发现取地址；找地址那段拆成 `asset-lan-discover.mjs`，单测含本机替身 |
| `b5340c06` | 任务 3：三处判法改法，抽成纯函数，单测 |
| `98dd5f7d` | 任务 3 补：结果行带非已建立连接的记录，提示语写明「已建立」 |
| `bd9a1bbf` | 依赖方向守门 `bakery-deps.test.mjs` 的名单加三份新测试 |
| `bc62980e` | 报告收尾（第一轮） |
| `a5e81f61` | 主会话审后第二轮：`--assert-no-lan` 改成基线排除；`compare-pitfalls.md` 补 `PROMPTCUT_NO_PORT_FILE` |

## 1. 探针和测试不写公共的 port.json

### 改法

- `server/vite-plugin-ai.ts`：`listening` 回调里原来只有无头实例（`PROMPTCUT_HEADLESS=1`）不写，现在 `PROMPTCUT_NO_PORT_FILE=1` 也不写。
- `scripts/lib/user-dirs.mjs`：新增 `NO_PORT_FILE_ENV`、`markNoPortFile(env)`（设成 `1`，外面设成 `0` 也改成 `1`）。
- `scripts/lib/no-user-dirs.mjs`：一被引入就 `markNoPortFile(process.env)`。已有守门（`no-user-dirs.test.mjs`）要求 `scripts/` 下每个起编辑器或渲染进程的脚本第一个 import 就是它，所以这些脚本和它们用 `{ ...process.env }` 或不给 `env` 起的子进程都带上开关，不用逐个改。
- `server/test/global-setup.mjs`（`npm test` 的全局准备）：同样 `markNoPortFile(process.env)`，覆盖测试里起编辑器的地方。
- 不经 `no-user-dirs.mjs` 的两处用 `npx vite` 起编辑器的探针显式设：`scripts/probes/cold-start-probe.mjs`、`scripts/probes/pixelmap-gl-probe.mjs`（后者本来就把 `TEMP` 指到临时目录，补上开关只为统一）。
- 桌面版（`desktop/src-tauri/src/lib.rs` 直接起 `vite.js`）、`npm run dev`、`vite.config.ts` 都不设它，照旧写。

没有改用「给探针的编辑器单独的 `TEMP`」：那样要逐个改起进程的地方，以后新写的探针还会漏；而且探针进程自己的 `os.tmpdir()`（放产物、Chrome 配置）也会跟着变。

### 起编辑器的探针与测试（守门扫出来的 36 个，逐个核过）

守门 `server/test/port-file.test.mjs` 扫 `scripts/`（不含 `archive/`）里「`<vite 入口>, '--port'`」形状的起进程，和用了带 `vite-plugin-ai` 的配置的同进程 `createServer`，要求第一个 import 是 `no-user-dirs.mjs` 或显式设 `PROMPTCUT_NO_PORT_FILE: '1'`；产品入口另有办法。

| 类别 | 脚本 | 怎么不写 |
|---|---|---|
| 公共启动件 | `scripts/lib/dev-server.mjs`（`startDevServer`，`export-e2e.mjs`、`review-loop-run.mjs` 经它起） | 引 `no-user-dirs.mjs` |
| 公共启动件 | `scripts/probes/m8/procs.mjs`（M8 探针的 `startQueueEditor` 等） | 引 `no-user-dirs.mjs`；本来就把 `TEMP` 指到自己目录 |
| 探针 | `c10-browser-probe`、`c10-catalog-probe`、`c10-cost-probe`、`c10a-demo-probe`、`c66-t9-probe`、`ht-w-probe`、`render-host-probe`、`shared-project-lan`、`card-shots.mjs`、`svg-url-serialize-probe` | 引 `no-user-dirs.mjs`；本来也把 `TEMP` 指到自己目录 |
| 探针 | `c65-editor-probe`、`card-overlay-probe`、`card-sync-probe`、`chat-window-probe`、`m8-migrate-probe`、`online-join-probe`、`placeholder-probe`、`playback-probe`、`png-adopt-probe`、`probe-gate-probe`、`queue-mode-probe`、`ready-index-probe`、`reveal-probe`、`snapshot-hash-probe`、`tiers-probe`、`preview-boxes.mjs`、`verify-playback.mjs`、`verify-playback-project.mjs`、`verify-preview-window.mjs` | 引 `no-user-dirs.mjs`（以前会写公共那份） |
| 探针 | `desktop-auto-node-probe` | 引 `no-user-dirs.mjs`，但它仿桌面壳把 `PROMPTCUT_*` 全摘了再起，开关带不过去；它本来就把 `TEMP` 指到自己目录，不写公共那份。主工作区里这个文件有未提交的改动，本分支没动它 |
| 探针 | `cold-start-probe`、`pixelmap-gl-probe` | 显式设 `PROMPTCUT_NO_PORT_FILE: '1'`（本分支改的） |
| 产品入口 | `scripts/headless.mjs` | `PROMPTCUT_HEADLESS=1`（原有） |
| 产品入口 | `scripts/render-host.mjs` | `TEMP` 指到 `--data/tmp`（原有，`render-host.test.mjs` 断言） |

不在清单里的：`verify-card-*`、`verify-export-frame-content`、`verify-frame-scene-order`、`verify-stale-capture` 用 `vite.prerender.config.ts`（不挂 `vite-plugin-ai`）；`c10a-online-probe`、`m7-build-probe` 等只跑 `vite build`；`server/test/` 里同进程的 `createServer` 都是 `configFile: false`，不挂插件；`server/test/` 里经子进程起编辑器的走全局准备。

### 验证

- 单测 `port-file.test.mjs` 6 项全过：`markNoPortFile`；引入 `no-user-dirs.mjs` 的进程与它 `{ ...process.env }` 起的子进程都是 `1`；全局准备设了它；`vite-plugin-ai.ts` 在写文件之前按它返回；上面的扫描（36 个，`checked >= 25` 且点名 5 个必须认出来的）；桌面版与 `npm run dev` 不设它。
- 实跑 `node scripts/probes/ready-index-probe.mjs --port 5683`：退出码 0，`"fails": []`，用时 59 s。
  - 跑前：`%TEMP%\promptcut\port.json` 存在，修改时间 `2026-09-29T17:54:22.8183714+09:00`，SHA1 `3A0526591C957224BBECB6E50E23629E31FF4F95`，内容 `{"port":5693,…,"pid":14200,…}`。
  - 跑后：修改时间、SHA1、内容都与跑前相同。
- 开关本身的对照（scratchpad 里的一次性脚本，`TEMP` 指到 scratchpad，端口 5686）：不带开关起编辑器，scratchpad 里出现 `promptcut/port.json`（`{"port":5686,…,"stagePorts":[5687,5688]}`）；带开关起，不出现。两台都是自己起、自己 `taskkill` 收的。
- 两次 `npm test` 之后公共 `port.json` 的修改时间与 SHA1 仍同上。
- 公共 `port.json` 现值仍指向已退出的 5693（上一轮留下的，`REPORT-post-M8.md` 已记），本分支不动它。

## 2. asset-lan-probe 按局域网发现取地址

### 改法

- 新文件 `scripts/probes/asset-lan-discover.mjs`（只用 Node 内置与 `server/lan/discovery.mjs`，笔记本不装依赖也能跑）：
  - `lanCandidates(hosts, { projectId, name })`：发现结果里属于这个项目的主机，按首次见到的先后、按素材地址去重；有 `projectId` 按它认，只有名字按名字认（不分大小写）。
  - `discoverLanAsset(want, { discover, timeoutMs = 3000, discoverOptions })`：调 `discoverLan`，有 `projectId` 时不按名字过滤；出错不抛。
  - `firstReachableAsset(bases, { ticket, missingHash })`：按顺序带票据 `GET …/media/<不存在的哈希>/chunks`，取第一个 200 的。
- `scripts/probes/asset-lan-probe.mjs`：没给 `--asset` 时先做 3 s 局域网发现。找到这个项目：按发现的先后取第一个能通的素材地址（`source: 'lan'`）；没给 `--docservice` 时票据也从发现到的那台文档服务取（同 `server/auth/route.mjs` 的选路，也同 `c66-t9-probe` 的 `discoverLanBase`）。找不到（放云端的项目，或不在同一网段）照旧等 `service.endpoints`，超时提示里写明「局域网发现也没找到这个项目」。新增 `--no-lan` 保留老写法。结果行多一个 `lan: { found, ms, candidates, errors }`（只有地址，没有票据）。

### 验证

- `server/test/asset-lan-discover.test.mjs` 5 项全过，其中本机替身一项：真的 `createLanHost`（回环网卡、随机 UDP 端口）通告两个项目，服务端口指向一台只认带票据 `GET …/chunks` 的假素材服务；经真的 `discoverLan` 按 `projectId` 找到 `http://127.0.0.1:<端口>/api/asset` 并试通，只有名字也找到，别的 `projectId` 找不到（探针会退回等 `service.endpoints`）。用时约 4.6 s。
- `asset-lan-probe --bogus` 退出码与用法提示照旧。
- **待跨机复核**：两台机器、真实网卡上的组播与子网广播，以及整条探针（契约 `asset-store-contract.md` 第 265 行：本机请求来自回环、写入不要令牌，第 2 步必然失败，所以这条探针只能在另一台机器上跑）。建议笔记本对 PC 上放本机的项目跑一次 `PROMPTCUT_SHARED_CONFIG=<配置> node scripts/probes/asset-lan-probe.mjs`，核结果行 `source: 'lan'`、`ok: true`。

## 3. 探针判法三处弱点

| 弱点 | 改法 | 纯函数 | 单测 |
|---|---|---|---|
| `--assert-no-lan` 的 TCP 采样不分状态，上一项的 `TIME_WAIT` 被数进去 | 第一轮改成只数 `ESTABLISHED`；主会话审后指出会漏判（两次采样之间建立又关掉的短连接，下一次采样只剩 `TIME_WAIT`，被排除掉），第二轮（`a5e81f61`）改成**基线排除**：`startNoLanWatch` 开始时第一次取到的 netstat 是基线，已有的、对端是这个地址的 (本端, 对端) 对只记进 `baseline`；之后每次采样出现的、不在基线里的，不论状态（`ESTABLISHED`、`TIME_WAIT`、`SYN_SENT`、`CLOSE_WAIT`…）都计入 `maxTcp` / `seen`。第一次 netstat 失败时下一次取到的当基线；判法要求取到基线且基线之后至少采样一次。`m8-e-probe`、`shared-project-probe`、`m8/no-lan.mjs` 三处文件头与提示语改成这个写法，`no-lan-tcp` 结果带 `baselineOk`、`baseline` | `countNewTcpTo`、`judgeNoLanTcp`、`pairKey`（`countTcpTo` 回到任何状态都数） | `m8-no-lan.test.mjs` 10 项：基线里的 `TIME_WAIT` 不算、运行中新出现的 `TIME_WAIT` 算（短连接）、`SYN_SENT` 算、`CLOSE_WAIT` 算、没取到基线或基线后没采样不算过；`startNoLanWatch` 用注入的假 netstat 跑，不做真的局域网发现 |
| `cloud-untouched` 数阿里云总连接数，别人进出就误判 | `m8-e-probe` 放本机时收尾按本轮查：本轮项目名 `m8e-<用例>-<本轮编号>` 在云端 `GET <hosted>/shared/lookup?name=` 回 404 才过；回 200 且 `projectId` 是本轮的（或没有 `projectId`）不过；同名但 `projectId` 不同写明「不是本轮的」照过；连不上或别的状态记 `unreachable` 放过（同以前「读不到就不判」）。前后两次 `/healthz` 的总连接数只记录、不判 | `m8/lib.mjs` 的 `judgeCloudUntouched` | `m8-judges.test.mjs` 3 项 |
| `real:tasks>=50` 标签固定 | 门槛照旧 `min(50, 条数 × 秒数 × 30 / 60)`（向上取整，对整数任务数与以前的判法相同），检查名按门槛写 `real:tasks>=<门槛>`，细节带 `need`、`expected` | `m8/lib.mjs` 的 `realTasksThreshold` | `m8-judges.test.mjs` 1 项（10×10 → 50、4×10 → 20、20×10 → 封顶 50、3×5 → 8） |

没对阿里云和局域网实跑（按任务书）。

## 基线

- 第二轮（`a5e81f61`）：`npx tsc -b --force` 退出码 0；`npm test` 3876 项，通过 3874，失败 0，跳过 2，退出码 0。
- 以下是第一轮：

- `npx tsc -b --force`：退出码 0，零错误（在 `98dd5f7d` 上跑；之后只改了测试文件）。
- `npm test`：
  - 第一次（`98dd5f7d`）：3872 项，通过 3869，失败 1，跳过 2。挂的是 `bakery-deps.test.mjs` 的「server/** 不 import scripts/ 下的模块」：三份新测试 import 了 `scripts/`，名单要显式加。不是负载导致的偶发。
  - 修复（`bd9a1bbf`，把三份新测试加进名单并写明理由）后第二次：3872 项，通过 3870，失败 0，跳过 2，退出码 0。
- 没跑 G0-R：只改了探针、测试和 `vite-plugin-ai.ts` 的写文件开关，没动渲染、预渲染代码（按任务书）。
- 起过的进程：`ready-index-probe`（5683～5685，探针自己收）、对照脚本的两台编辑器（5686～5688，自己 `taskkill`）。收尾时 5680～5689 没有监听。

## 没做成的、没做的

- 任务 4（41 处注释路径）按任务书没做。
- 任务 2 的跨机部分待跨机复核（见上）。
- `cloud-untouched` 的「按本轮用户查」只做到「按本轮的项目查」：云端 `/healthz` 只有总数，文档服务没有公开的按用户或按项目列连接的接口（`router.describeConn` 只在进程内）。用户名只在项目内有意义，本轮项目不在云端，本轮的用户就进不了云端，所以按项目查等价于按本轮用户查进入与否；但「本轮的某个进程向云端发过连接又被拒」这类尝试看不见。要看见，得给托管端加一个按项目或按设备号查连接的只读接口（改服务端，属于二级或三级的改动），本分支没做。

## 建议与需要主会话定的事

1. `no-user-dirs.mjs` 现在管两件事（不继承用户目录、不写公共 `port.json`），文件名只说了前一件。要不要改名（例如 `probe-env.mjs`）？改名会动 40 多个探针的第一行 import，和别的分支冲突，建议等注释路径那 41 处一起做。
2. （第二轮已做，`a5e81f61`）`docs/guides/compare-pitfalls.md` 第 8 节补了：设了 `PROMPTCUT_NO_PORT_FILE=1` 的不写，测试与探针的公共入口都设了它，只有桌面版和 `npm run dev` 起的会写；手动起 dev server 做验证时也建议带上。归档计划里的旧写法没动。
3. `cloud-untouched` 要不要真正按用户或设备查（见上一节），由主会话定；要做的话是服务端的改动。
4. 合并：6 个提交都在 `claude/probe-hygiene`，未推送、未合并。
