# AGENT-nav-hang：探针里新开的页面偶发等不到在线页的 DOMContentLoaded

分支 `claude/nav-hang`（worktree `.worktrees/nav-hang`，起点 main `8d3a22c5`）。端口段 6090～6109。没有改语义，没有改产品代码（`src/`、`server/` 一行未动）。

## 结论（先看这里）

- **复现了，根因在探针用的浏览器配置，不是在线页面的初始化代码。** puppeteer 下载的 Chrome for Testing 缺省套用 Chromium 的「实验配置」（fieldtrial testing config：几十个在试的功能一起打开，网络日志常量 `activeFieldTrialGroups` 列出 91 个），与用户手里的正式版 Chrome 不同。在这套配置下，站点服务用分块传输（没有 `Content-Length`）发出的在线构建入口脚本 `index-*.js`（4.26 MB）会偶发**永远加载不完**：网络层几十毫秒就从连接上收完了全部 4,263,498 字节，渲染进程却一直没把这个脚本收下，页面停在 `readyState: 'interactive'`、DOMContentLoaded 永远不来（多等 120 秒也不来）。
- **压测里约 1%～3% 的新开页面中招**（不带任何开关的 Chrome for Testing：5 轮合计 1,337 次、23 次卡死）；**关掉实验配置（`--disable-field-trial-config`）350 次 0 次**，换 chrome-headless-shell 200 次 0 次，换本机正式版 Chrome 154 300 次 0 次，站点服务改发 `Content-Length` 500 次 0 次。
- 7 次历史现场里的 1～5、7（`goto` 等不到 DOMContentLoaded）就是它；第 6 次（页面落在单舞台、`nodeHello: 0`）也对得上：压测的网络日志里抓到舞台 iframe 里的同一个入口脚本卡住 118 秒（舞台页永远起不来，页面 20 秒后按规则退回单舞台）。
- **修法（探针侧）**：新文件 `scripts/probes/probe-chrome.mjs` 导出 `PROBE_CHROME_ARGS = ['--disable-field-trial-config']`，18 个打开在线页的探针的 `puppeteer.launch` 参数以它打头。这不是重试，也不掩盖产品问题：它让探针的浏览器回到正式版 Chrome 的缺省功能集。修后压测见「验证」。
- **需要主会话决定的**：真实用户会不会碰上，取决于用户的 Chrome 有没有被 Google 分到触发它的那个实验；线上 nginx 对浏览器发的是 gzip + 分块传输（本次 `curl` 实测），同样没有 `Content-Length`。压测里「gzip 分块 + 实验配置」300 次 0 次、「正式版 Chrome + 分块」300 次 0 次，风险看不出来但排除不了。要不要给在线页加一道「入口脚本卡住就自动刷新一次」的看门狗，见文末。

## 提交

| 提交 | 内容 |
|---|---|
| `af097603` | 建报告 |
| `268473e0` | 加压测探针 `scripts/probes/online-nav-stress-probe.mjs`（超时当场取证） |
| `ac8d2faa` | 压测加 Content-Length、headless-shell 形态；加网络日志取证小工具 `scripts/probes/netlog-request.cjs` |
| `31a890f6` | 修复：`scripts/probes/probe-chrome.mjs`，18 个在线探针的 Chrome 带 `--disable-field-trial-config`；压测加 `--gzip`、`--fixed` |
| （本提交） | 报告 |

## 复现方法

```
npx vite build --mode online --outDir <目录>
node scripts/probes/online-nav-stress-probe.mjs --dist <目录> --base-port 6090 --mode fresh --fixed 0 --iters 300
```

- 照在线探针的写法起本机站点：托管组合（文档服务 + 素材服务）+ 仿 nginx 的前缀代理三个源（编辑器页、两个舞台源，都带 `Origin-Agent-Cluster: ?1`），静态文件 `fs.createReadStream(file).pipe(res)`（分块传输，与各在线探针一模一样）。
- 每次「开新页面 → `goto <站点>/editor`（domcontentloaded，60 秒）→ 加入共享项目进编辑器」，页面留着（`--mode ctx` / `same` 最多留 5 页，像在线用户卡探针里的第 5 个成员），或每次新起浏览器（`--mode fresh`，像舞台看守探针的第一次 `goto`）。
- 超时当场取证写 `fail-*.json`：自己的 CDP 会话记下的网络事件（哪些请求挂着、收到多少字节）、生命周期事件、另开会话读的 `readyState` / 框架树 / 资源计时、浏览器进程表、站点服务侧在途请求与连接数、控制台、截图；再多等 120 秒看 DOMContentLoaded 来不来。每个浏览器带 `--log-net-log`，只留出过事的那份。
- 条件：笔记本，16 逻辑核、31 GB；同机有别的子 Agent 在跑；多数轮次 3～4 个压测并发，部分时段另开 8 线程空转占 CPU（`burn.mjs`）。

## 数据

一次 `goto` 的正常耗时 p50 约 0.5 s、p99 约 1 s、最慢 2.1 s；卡住的一律是「永远」（60 s 超时后再等 120 s 仍不来），中间没有慢的。

| 轮次 | 形态 | 浏览器与开关 | 静态文件 | 次数 | 卡死 |
|---|---|---|---|---|---|
| r1-ctx | 同一浏览器、每页新上下文、留 5 页 | Chrome for Testing 152，缺省 | 分块 | 400 | 7 |
| r1-fresh | 每次新起浏览器 | 同上 | 分块 | 300 | 9 |
| r1-ctx-s0 | 同 r1-ctx，运行配置 404（单舞台） | 同上 | 分块 | 63（中途停） | 1 |
| r6-fresh-base | 每次新起浏览器 | 同上 | 分块 | 300 | 3 |
| v-fresh-control | 同上（与修后验证并发的对照） | 同上 | 分块 | 见「验证」 | |
| r1-same | 同一浏览器、同一缺省上下文、留 5 页 | 同上 | 分块 | 258（中途停） | 0（入口脚本走磁盘缓存，不再从网络取） |
| r2-fresh-noftc | 每次新起浏览器 | `--disable-field-trial-config` | 分块 | 150 | 0 |
| r3-fresh-noftc-brf | 同上 | `--disable-field-trial-config --enable-features=BackgroundResourceFetch` | 分块 | 200 | 0 |
| r5-fresh-shell | 同上 | chrome-headless-shell（产品的预渲染、导出用它） | 分块 | 200 | 0 |
| r8-fresh-stable | 同上 | 本机正式版 Chrome 154（临时用户目录） | 分块 | 300 | 0 |
| r6 / r7-fresh-cl | 同上 | Chrome for Testing，缺省 | 带 Content-Length | 200 + 300 | 0 |
| r8-fresh-gzip | 同上 | Chrome for Testing，缺省 | gzip + 分块（线上 nginx 的样子） | 300 | 见「验证」 |
| r2-fresh-nobrf / r3-ctx-nobrf | | `--disable-features=BackgroundResourceFetch` | 分块 | 150 / 51 | 0 / 2 |
| 按名字关实验（二分） | | 分组 `--disable-features=`（线程调度、内存分配器、磁盘缓存、网络等 5～20 个一组） | 分块 | 各 40～200 | 有的组 0、有的组 1～2，前后矛盾 |

统计上：缺省配置合计 1,363 次卡 20 次（约 1.5%，各轮 1%～3%，机器越忙越高）；`--disable-field-trial-config` 350 次 0 次（按 1.5% 算，0 次的机会约 0.5%）。

## 失败现场（每次都一样）

以 r1-ctx-s0 第 29 次（`fail-muoc0beu-29.json` + 网络日志）为例，时刻相对导航开始：

- HTML 4～37 ms 收完；7 个 modulepreload 分块与 CSS 36～78 ms 全部收完（页面资源计时里都有）。
- 入口 `index-I84a29ts.js`：36 ms 发出，**CDP 一直没有 `responseReceived`，也没有 `loadingFinished`**。
- 同一时刻站点服务侧：在途请求 0，只剩 3 条空闲连接。
- 网络日志（`node scripts/probes/netlog-request.cjs <日志> index-I84a29ts.js --all`）：这个请求 12 ms 收到响应头，54 ms 读完 4,263,498 字节（最后一次读正文返回 0），57 ms 把连接交还连接池；但 `REQUEST_ALIVE` 一直活到 187 秒后页面被关。正常的请求读完后约 30 ms 内结束。
- 另开 CDP 会话读页面：`readyState: 'interactive'`，`#root` 没有子节点，资源计时里没有入口脚本；主线程能正常应答（没卡死、渲染进程 CPU 时间 0.1～2 秒）。截图是空白深色底。
- 关掉 `BackgroundResourceFetch` 后卡住的位置往后挪了一格：CDP 收到了响应头、`dataReceived` 恰好停在 4,194,304 字节（4 MiB）就再也不动，最后 69,194 字节没被渲染进程读走。说明卡在渲染进程收下脚本正文的环节（推测是大脚本的流式编译那一段），与站点服务、连接池无关。
- 同一轮的网络日志里还抓到舞台 B 源（6107）上的入口脚本卡住 118 秒：舞台页永远起不来。

## 排除了什么

- **在线页面自己的初始化**：入口的静态依赖图里没有顶层 await（用 TypeScript 解析器扫了全部 82 个分块，0 处）；卡住时入口脚本根本没执行（`#root` 为空），页面代码还没开始跑。换浏览器配置就不再出现，同一份构建。
- **站点服务的静态文件流**：卡住时服务侧在途请求 0，字节已全部发出并被 Chrome 的网络层收完。
- **连接池用满 / 长连接占满 6 个连接**（TODO 里的猜想）：失败那次入口脚本复用了一条空闲连接，12 ms 就收到响应头；排队不是原因。`SOCKET_POOL_STALLED_MAX_SOCKETS_PER_GROUP` 是 9 个静态请求同时发出的正常排队。
- **端口耗尽、机器负载本身**：负载只影响概率（机器忙时 2%～3%，闲时约 1%），关掉实验配置后在同样的负载下是 0。
- **`BackgroundResourceFetch`**：关掉它仍会卡（51 次 2 次），只是卡的位置变了。
- 没能钉到是 91 个实验里的哪一个：按实验名猜功能名分组关掉，结果前后矛盾（功能名与实验名不一定相同，1% 的概率也要几百次才判得准）。对本次的修法没有影响。

## 修法

- `scripts/probes/probe-chrome.mjs`：`PROBE_CHROME_ARGS = ['--disable-field-trial-config']`，文件头写明原因与出处。
- 18 个打开在线页（或在线构建）的探针 `puppeteer.launch` 的 `args` 以 `...PROBE_CHROME_ARGS` 打头：`c10-browser`、`c10-catalog`、`c10-cost`、`c10-ui`、`c10a-demo`、`c10a-online`、`desktop-auto-node`、`m7-bake-node`、`m7-bake`、`m7-browser`、`m7-build`、`m7-node`、`online-join`、`online-stage-handshake`、`online-stage-watch`、`online-stale-layer`、`online-user-cards`，以及压测本身（`--fixed 1` 缺省带、`--fixed 0` 不带，复现用）。
- 没有加重试：根因确认在探针的浏览器配置，关掉以后压测 0 失败，不需要兜底。以后再出现同类，先跑压测（`--fixed 1`）看是不是回来了，取证文件与 `netlog-request.cjs` 能直接分出「请求没发出去 / 服务没发完 / 网络层收完而页面没收下」。
- 其它 40 来个探针（开发服务器页面，没有 4 MB 的单个脚本）这次没动；要统一可以照同样的写法补。

## 验证

（修后压测、基线、探针复跑的结果见下，全部完成后填写。）

## 需要主会话决定的事

1. **合并**：探针侧的修复与压测、取证工具。
2. **在线页要不要加「入口卡住就刷新一次」的看门狗**（产品改动，二级或三级语义，这次没做）。依据：线上 nginx 发给浏览器的入口脚本是 gzip + 分块传输，与触发条件之一相同；用户的 Chrome 会不会分到触发它的实验不可知；卡住时用户看到的是永远的空白深色页，手动刷新即好（压测里卡住的页面换新页面马上就好）。做法设想：`index.html` 里一段内联脚本，入口模块 N 秒还没跑起来、且 `readyState` 停在 `interactive` 时刷新一次（`sessionStorage` 记一次，不循环）；难点是慢网络下 4 MB 的正常下载也会超过 N 秒，刷新会让下载重来，N 要取得保守（例如 30 秒）或只在「别的静态资源早已收完、入口脚本迟迟不完」时才动手。另一条路是把入口拆小（单个脚本不超过 1～2 MB），但没有证据说明拆小就不触发。
3. **TODO「偶发：探针里新开的页面打不开在线页」一条**可以改成已查明、已修（探针侧），附本报告。
