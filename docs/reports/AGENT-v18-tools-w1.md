# AGENT 报告：v18-tools-w1（云端 Agent 的网页操作七个工具）

分支 `claude/v18-tools-w1`，基底 main `41aaa2ce`。2026-10-13。

「W1」是 `docs/plan/cloud-agent-tools-implementation.md` 拆包表里的一个包：云端 Agent 的 `web_open`、`web_view`、`web_click`、`web_type`、`web_scroll`、`web_read`、`web_close` 在 Agent 服务一侧的实现。「G 包」是同一张表里最后那个「中央接线」包（改工具表、把各包接进实例），不在本包。下文「出网闸」指 `server/agent/service/egress.mjs`；「这一轮」指文档服务确认读过一条消息后发给 Agent 的一次运行授权；「收回」指这一轮的授权因对话设为私有、被停止、Agent 被关而失效。对应的验收底稿是 `AGENT-018-prep.md` 2.1 第 20 行与 2.3（云端 Agent 剩余工具的完成条件）。

## 1. 做了什么

新文件，都在租约里；**没有改 `egress.mjs`**（代理另写在 `server/web/hosted/network.mjs`，只用出网闸已有的 `admit` / `admitUrl`），没有碰任何中央文件和桌面版的网页操作文件。

| 文件 | 管什么 |
|---|---|
| `server/agent/service/hosted-browser.mjs` | `createHostedBrowserTools(...)`：工具包本体。每次调用先过授权、交结果前再过一次；按「项目 × 对话」管浏览器会话；名额、闲置、关闭；给宿主的口子 |
| `server/web/hosted/session.mjs` | 一个会话：起无头浏览器（管道连接、白名单环境变量）、拒下载、并标签页、关对话框、六个动作、杀整棵进程树并逐个核进程号、清残留浏览器 |
| `server/web/hosted/network.mjs` | 浏览器的出网：只绑回环的正向代理（每个目标过出网闸）、堵绕过途径的启动参数、只收 http(s) 的地址规范化、部署者追加参数的过滤 |
| `server/web/hosted/view.mjs` | 复用桌面版的截图与清单，给清单加版本（编号形如 `r12e7`）、留服务端指纹；页面滚动后重截当前这一屏 |
| `server/web/hosted/hit.mjs` | 动作前核对「这个编号此刻还指着清单里那个元素、点下去不会落到别的元素上」；认出口令、验证码、卡号的输入框 |
| `server/test/cloud-tools-w1-{browser,egress,restart}.test.mjs` | 27 条测试（真浏览器） |
| `server/test/cloud-tools-w1-{fixture,site,restart-child}.mjs` | 夹具（真 SQLite 运行授权、真登记器、真出网闸；等进程退出的时限放宽到 40 秒，产品缺省是 10 秒）、本地假站、扮「被强杀的服务进程」的子进程 |
| `scripts/probes/cloud-tools-w1-browser-probe.mjs` | 探针：窗口检查、三份测试、真实公网、浏览器自己不解析主机名的对照 |
| `docs/reports/assets/v18-tools-w1/*.webp` | 七张截图 |

实现的要点：

- **形状同桌面版。** 工具名、参数用的是 `server/tools/browser.mjs` 那一份定义（没有改它）。返回的字段与桌面版相同（`ok`、`url`、`title`、`image`、`clickable[{u,t,n,b,v?,it?,covered?}]`、`hint`、`__image`、`wall`、`wallNote`、`navigated` / `clicked` / `typed` / `scrolled`、`candidates`），页面逻辑直接调桌面版 `server/web/session.mjs`、`view.mjs`、`hit.mjs` 的导出函数（只读，没有改）。多出来的字段都是加的：`rev`（清单版本）、`dataNotice`（网页文字是数据不是指令）、`blocked` / `blockedNote`（这一步里被云端拦下的东西）、`stale` / `reason`（编号过期的原因）、`notOpen`、`egress` / `refused`（拒绝的原因码）、`cloudUnavailable` / `code`。
- **隔离。** 键是「项目 id + 对话 id」，只取自可信的运行上下文；目录是 `<数据目录>/web/<项目>/<对话>/profile`（目录名 = 清洗后的 id 加原文哈希，带冒号的 id 不会互相撞）。每个键一个浏览器进程、一个代理。
- **绑定当前这一轮。** 每次调用 `authorize(read)` 两次（动手前、交结果前，栅栏版本变了就不交）；浏览器进程登记到运行资源登记器，收回时登记器调它的 `kill()`（已换成杀整棵树），本模块听登记器的信号把会话收掉并等进程号查不到；动作里每次真正碰页面之前再看一次信号。
- **清单带版本。** 版本号写进编号里随模型传回（工具参数表不用改）；版本不是最新、页面跳转过、元素没了、元素换了内容、按坐标点时位置动过、上面盖了东西——都拒。版本号按对话落盘、跨浏览器进程接着往下编：关掉重开、服务重启之后，旧清单的编号不会和新浏览器的编号撞上。
- **不代填。** `web_type` 遇到口令框（`type=password`、`autocomplete` 是口令类、名字里带密码 / 口令）、验证码（`one-time-code`、名字里带验证码 / OTP）、卡号，直接拒；聚焦之后才变成口令框的也拒。验证码的 iframe 不在清单里，按坐标也点不到。
- **出网。** 见第 3 节的表。
- **没配浏览器如实回。** `runtime.executablePath` 没给或不是文件：六个工具回 `{ ok: false, cloudUnavailable: true, code: 'BROWSER_MISSING', error: '这台节点没有配置浏览器…' }`，不起进程、不建目录、不下载；`web_close` 照常回。

## 2. 验证结果

环境：Windows 11，Node 24.19，puppeteer 25.10 自带的 Chrome for Testing 152.0.7977.75（无头）；另用同版本的 chrome-headless-shell 跑了一条（节点上装的是它）。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -- server/test/cloud-tools-w1-browser.test.mjs server/test/cloud-tools-w1-egress.test.mjs server/test/cloud-tools-w1-restart.test.mjs` | 0 | 27 条通过，0 失败，0 跳过 |
| 同上三份，加 `W1_BROWSER=<本机 puppeteer 缓存里的 chrome-headless-shell.exe 152>` | 0 | 27 条通过，0 失败，0 跳过（整套在节点上装的那种浏览器的 Windows 版上再过一遍） |
| `node scripts/probes/cloud-tools-w1-browser-probe.mjs` | 0 | 「全部通过」；关键行见下 |
| `npm test -- server/test/windows-hide-silent-spawn.test.mjs server/test/bakery-deps.test.mjs` | 0 | 7 条通过（不弹窗守门、server 不引 scripts 守门） |
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test`（全量，设了那两个环境变量） | 1 | 6096 条，通过 6086，失败 2（同一个测试的父子两行，在 `multi-agent-presence.test.mjs`，单独重跑 6 条全过），本包 27 条全过；详见文末「全量基线」 |

探针输出的关键行（原文）：

```
[w1] 探针前看得见的窗口: []
[w1] 测试:通过 27 条,跳过 0 条,退出码 0
[w1] WebRTC:受控 UDP 0 个、候选 0 个;对照 UDP 4 个、候选 1 个
[w1] 通过 出网闸没有开测试例外
[w1] 打开用了 408 毫秒;标题「Example Domain」,地址 https://example.com/,清单 ["r1e1=Learn more"]
[w1] 代理记录里 example.com 的条目: [{"kind":"connect","host":"example.com","port":443,"ok":true,"address":"172.66.147.243"},…]
[w1] 通过 正常出网走的是代理:记录里有这条到 example.com:443 的隧道,连的是出网闸核过的地址
[w1] 通过 真闸拒 http://169.254.169.254/latest/meta-data/ blocked-address
[w1] 通过 真闸拒 http://127.0.0.1:28410/ port
[w1] 通过 真闸拒 http://localhost/ blocked-address
[w1] 通过 真闸拒 http://[::1]/ blocked-address
[w1] 通过 真闸拒 file:///etc/passwd protocol
[w1] 通过 关闭回执 {"childrenClosed":true,"streamsClosed":true,"workPending":0}
[w1] 通过 浏览器进程号都查不到了(6 个)
[w1] 按目录名查残留的浏览器进程: 0
[w1] 不带那条参数:ERR_CONNECTION_REFUSED;带上:ERR_NAME_NOT_RESOLVED(主机名 15 个字符)
[w1] 通过 带上参数后浏览器解析不了任何主机名
[w1] 探针后看得见的窗口: []
[w1] 通过 探针没有带出新的可见窗口
```

看过的图（`docs/reports/assets/v18-tools-w1/`）：`01-open`（假站首页）、`02-click`（点完「打招呼」）、`03-type`（回显框里是「重写」，下面一行「你输入了:重写」，上面「点到了:另一个」）、`04-submit`（搜索结果页「你搜的是:蓝鲸」）、`05-scroll`（滚到底，底部的按钮在图的左下角）、`06-login-wall`（登录页，六个输入框全空）、`10-public-example`（真实的 example.com，深色配色）。**看图时发现一处错**：第一版的 `05-scroll` 截的是页面顶部，而清单是底部那一屏的——桌面版截图的写法在页面滚动后截的是文档顶部（见第 7 节第 1 条）。云端已改成滚动后重截当前这一屏，并加了断言，现在这张图是对的。

### 逐条对验收

**真 Chrome、真页面，每个工具走通**（W1-TOOL-01）：在 127.0.0.1:28380 的假站上打开、看、点（编号；坐标加名字，坐标故意偏到邻居上、按名字救回）、输入（清空、追加、回车提交跳到结果页，站点收到的查询串核过）、滚动（到底后底部的按钮进清单并点得到）、读正文（不返图、截断）、关（进程号查不到；之后五个工具回「没开着」，不偷偷起浏览器）。

**真实公网**：见探针行。经真的出网闸（没有测试例外、系统 DNS）打开了 https://example.com ，代理记录里有到 `example.com:443` 的隧道，连的是出网闸核过的地址。

**绕过途径逐个被拦**（每种一条测试；「内网里的服务」是测试在 127.0.0.1:28391 上起的、没有放行的服务，被连上一次就算漏）：

| 途径 | 测试 | 证据 |
|---|---|---|
| 没在例外里的回环地址（127.0.0.1、localhost、`[::1]`、0.0.0.0、十进制写法） | W1-EGRESS-04、05 | 入口当场拒；页面里用 fetch、XHR、图片、iframe、sendBeacon、WebSocket、preconnect / dns-prefetch / prefetch / preload 去连，每个目标在代理记录里都有明文与隧道两种拒绝，内网服务零连接，页面上没有内网的字 |
| 内网地址（10/8、172.16/12、192.168/16、解析到内网的名字） | 同上 | 同上 |
| metadata（169.254.169.254、`fd00:ec2::254`、IPv4 映射写法、解析到它的名字） | 同上 | 同上。这一类是 Chrome 缺省**不走代理**的（链路本地），靠 `--proxy-bypass-list=<-loopback>` 才到代理 |
| IPv6 的对应范围（`::1`、`fe80::/10`、`fc00::/7`、NAT64、6to4、IPv4 映射） | W1-EGRESS-04、05 | 同上 |
| 上一行那个参数是不是真的管用 | W1-EGRESS-06（对照） | 去掉它，同一个页面直连到了内网服务、拿到了内网的字，而且没经过代理 |
| `file:` 等非 http(s) 协议 | W1-EGRESS-01、04、11 | `file:`、`chrome:`、`view-source:`、`data:`、`javascript:`、`about:`、`ftp:`、`ws:`、`blob:` 等入口当场拒；页面里的 `file:` 链接与 iframe 读不到测试放的本机文件 |
| 下载 | W1-TOOL-04 | 点下载链接、直接打开下载地址都被拒；对话目录、系统下载目录、临时目录里都没有那个文件 |
| 跳转到内网 | W1-EGRESS-07 | 302 到回环、metadata、IPv6 回环、内网、解析成内网的名字、两跳之后到回环；页面里的 meta 跳转；302 到 `file:`——内网服务零连接，结果里告诉了模型「被出网限制拒绝」 |
| DNS 重绑定 | W1-EGRESS-08 | 用可注入的解析函数：名字先指放行的地址，页面开着时改指「内网」（127.0.0.2 同端口），之后同源的请求得到 403、重绑定后的地址零连接、也没有悄悄连回旧地址；一个名字同时指着外网与内网的整个拒 |
| WebRTC | W1-EGRESS-09 | 收集到 0 个候选、假 STUN 收到 0 个 UDP 包；对照（去掉策略参数）收到 4 个 UDP 包、1 个候选 |
| WebSocket | W1-EGRESS-10 | 连放行的站，握手经代理的隧道到达；连内网被拒（在 05 里） |
| DNS 预取 | 探针 | 浏览器自己解析不了任何主机名（对照行见上）；经代理的预取在 05 里被拒 |
| 调试端口、环境变量 | W1-EGRESS-03 | 用管道不开调试端口；环境变量里没有 `PROMPTCUT_*`、代理变量、凭证；部署者追加的参数里改代理、开调试口的被丢掉 |
| 代理自己 | W1-EGRESS-02 | 同一条连接上换目标照样重查；隧道数上限；关闭后连接都断；服务日志里只有原因码与端口 |
| 节点上那种浏览器 | W1-EGRESS-12 | 同版本的 chrome-headless-shell（Windows 版）上：内网那一组、跳转、WebRTC、点、输入、关，同样成立 |

**两个对话同站不串登录态**（W1-ISO-01）：同项目两个对话、另一个项目里同 id 的对话，开同一个站。甲登录后自己看得到会话 cookie 与本地存储；另外两个看到的是「没有登录」「本地存储:空」；站点一侧带着甲那个 cookie 来的请求只有甲自己那一次；三个浏览器进程、三份目录、三个代理，进程树互不重叠。

**取消 / 设私有 / 关闭后进程号查不到、目录按约定清理**：W1-RUN-01（设私有：账本里的真动作加登记器收回 → 进程号逐个查不到；旧上下文七个工具都被拒；宿主按「私有」关对话 → 用户数据目录删掉，只留一个记版本号的小文件）、W1-RUN-02（停止：动作做到一半时收回 → 这次调用报「权限被收回」，进程号查不到，目录留着；按「对话被删」收尾 → 整个目录删掉）、W1-ISO-02（`web_close`：进程没了、目录还在、再打开登录态还在）、W1-CFG-02（闲置超时自动关、名额满时换下闲着的）、W1-CFG-03（服务关闭：回执三项为真，代理端口都连不上了，目录留着）。

**重启后旧浏览器不复活**（W1-RESTART-01、02）：扮服务的子进程被强杀后，它起的浏览器整棵进程树自己退出（逐个进程号核）；新服务里那个对话是「没开着」，旧编号用不了，再打开是新进程、版本号接着往下编；万一有残留的浏览器占着对话目录，新服务起来时杀掉它，没人占着的目录不误杀。

**只读成员、伪造的上下文、别的项目的上下文**（W1-RUN-04、W1-RUN-03）：只读成员七个工具都能用〔裁，见第 5 节〕；凭空写的、改了任一字段的、多带字段的、换了项目或对话的上下文，四个工具各试一遍都抛 `tool-context-*`，没有起浏览器、没有关掉别人的、站点没有收到任何请求；别的项目的真上下文只看得到自己的浏览器（看到的是「没开着」，它的 `web_close` 关不掉这个项目的）；工具参数里塞项目、对话、路径没有用；换了新一轮后旧一轮的上下文过不了授权，新一轮接着用同一个浏览器。

## 3. 出网是怎么堵的

浏览器的出网只留一条路：本会话自己的、只绑回环的正向代理。代理对每个明文请求、每条隧道过出网闸，连到核过的那个地址上。

| 绕过代理的途径 | 怎么堵 |
|---|---|
| 回环、链路本地地址（含 169.254.169.254） | Chrome 对这两类地址缺省不走代理；`--proxy-bypass-list=<-loopback>` 去掉这条缺省，代理再拒 |
| 内网、IPv6 的对应范围 | 都到代理，出网闸的黑名单拒 |
| 浏览器自己解析主机名（含 DNS 预取） | `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`：浏览器一个名字都解析不了，名字只交给代理解析 |
| DNS 重绑定 | 代理每个请求、每条隧道重新解析、核对、连核过的地址；浏览器不解析，没有第二次解析可骗 |
| 跳转 | 浏览器跟的每一跳都是一个新的代理请求 |
| WebSocket | 经代理的隧道，同样过闸 |
| WebRTC | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`（另带不加 force 的同名参数） |
| QUIC / HTTP3 | `--disable-quic` |
| 非 http(s) 协议 | 工具入口只收 http(s)；页面里的请求按协议掐掉（只许 http、https、about、data、blob）；落地后的地址再核一次 |
| 下载 | `Browser.setDownloadBehavior { behavior: 'deny' }` |
| 调试端口 | 用管道连浏览器，不开端口 |
| 浏览器自己的后台请求 | 关掉能关的（`--disable-background-networking` 等）；关不掉的也只能经代理 |

残余面（照实写）：代码这一层管的是「经代理出去的」。浏览器进程里如果还有本表没列的直连途径（将来版本新增的协议、渲染进程被攻破后自己开套接字），靠节点上的系统级出站限制兜底——与契约 9.4d 网页采集的残余面是同一条，写进了第 6 节的部署步骤。另外，本机的 Chrome for Testing 起来时会自己去连几个谷歌的地址（更新、登录探测），这些也只经代理、照样过闸；同版本的 chrome-headless-shell 没有这些请求。

## 4. 没做成的及原因

1. **Linux 上没验。** 只在 Windows 上跑（Chrome for Testing 与 chrome-headless-shell 的 Windows 版各一遍）。Linux 上不同的地方：chrome-headless-shell 的 Linux 版、沙箱（节点上若以 root 跑要 `--no-sandbox`，建议改用非特权用户）、进程组（代码按「浏览器是新进程组的组长、杀负的进程号」写的，没有实测）、清残留浏览器时读 `/proc/<进程号>/cmdline`（没有实测）。步骤见第 6 节。
2. **没有真 mTLS、没有真模型。** 运行授权用的是真 SQLite 的授权库加受控适配器（同 P2 包的做法）；工具由测试直接调。真模型直连的那一条归 G 包的最终组合。
3. **没有用量记账。** 契约里别的服务端工具每次调用记一行用量；网页操作记不记、按什么记（次数？字节？）契约没写，本包没做，留给 G 包与用户定（第 8 节）。
4. **系统提示词没改。** `cloud-tools.mjs` 里「这一版在云端还没有：…网页操作（web_*）」那句与工具表一起归 G 包。
5. **`web_handoff` 不在本包。** 撞上登录、验证码时，云端的结果里写的是「能交给用户时用 web_handoff（发起方不在线时它会明确告诉你）；否则告诉用户、换一个不需要登录的来源」——W2 包做完后若行为不同，这句要跟着改（在 `server/web/hosted/view.mjs` 的 `hostedWallNote` 与 `hit.mjs` 的 `explainSecret`）。

没有卡住两轮不过的地方，没有建解法表。

## 5. 我做的裁定〔裁〕

都是契约没写、我按最保守或最贴近桌面版的做法定的；数字是三级机制。

| # | 裁定 | 理由 | 推翻了要改哪里 |
|---|---|---|---|
| 裁 1 | 七个工具都只要**读**权限，只读成员能用 | 网页操作不改项目；计划里写「read 可由只读成员用，项目变更和资产导入需 write」 | `hosted-browser.mjs` 里两处 `authorize(context, 'read')` |
| 裁 2 | 用户数据目录的去留：`web_close`、闲置、停止、Agent 被关、服务关闭——留；对话设为私有——删（只留版本计数）；对话或项目被删——全删；超过上限——关闭时删 | 「留」是工具说明里对模型说的「登录态还在」；「设为私有就删」是因为能看这个对话的人换了一批，之前攒下的状态不该带过去 | `removeProfileFor` / `removeAllFor` |
| 裁 3 | `web_type` 对口令、验证码、卡号的输入框**硬拒** | 桌面版只在工具说明里约束模型（「不要用它填密码、验证码」），有人在旁边看着；云端没人看着 | `hit.mjs` 的 `probe` 里判 `secret` 的几行 |
| 裁 4 | 没开着浏览器时，只有 `web_open` 会起浏览器；其余回「没开着」 | 桌面版任何一个工具都会懒启动；云端的浏览器会被闲置关、被收回关，悄悄起一个空白页只会让模型对着空页操作 | `hosted-browser.mjs` 的 `call` |
| 裁 5 | 清单编号带版本，写成 `r<版本>e<序号>`；版本按对话落盘、不重用 | 工具参数表与桌面版共用，不能加参数；版本随编号回来最不容易丢 | `view.mjs` 的 `formatUid` / `parseUid` |
| 裁 6 | 按编号点：只核「还是那个元素、内容没变、没被盖住」，位置变了不拒；按坐标点：位置也要没变（容差 6 页面像素） | 按编号点的是同一个元素，点不到别的上面；按坐标点的依据是那张图 | `hit.mjs` 的 `locate`、`MOVE_TOLERANCE_PX` |
| 裁 7 | 新开的标签页、`window.open` 并回当前页；页面弹的对话框自动关掉并在结果里说 | 云端只有一个页，没人去点对话框 | `session.mjs` 的 `keepInOneTab` 与 `dialog` 处理 |
| 裁 8 | 交结果前栅栏版本变了（哪怕授权还在）就不交 | 与作业表「旧栅栏的结果不算数」一个口径 | `hosted-browser.mjs` 的 `call` 末尾 |
| 裁 9 | 资源上限的缺省值（见下表） | 节点的内存本包没有数据，取的是保守值 | `HOSTED_BROWSER_DEFAULTS`，由 `limits` 覆盖 |

资源上限（`createHostedBrowserTools({ limits })` 可逐项覆盖）：

| 项 | 缺省 | 说明 |
|---|---|---|
| `maxBrowsers` | 2 | 整个 Agent 服务进程里同时开着的浏览器数。满了：换下闲够 `evictIdleMs` 的；都在忙就回「已到上限」 |
| `evictIdleMs` | 60 秒 | 闲了这么久才可以被换下 |
| `idleCloseMs` | 10 分钟 | 闲置多久自动关（目录留着） |
| `navigationMs` | 30 秒 | 一个页面最多等多久加载出来 |
| `actionMs` | 50 秒 | 一次工具调用的总时限（宿主给工具的是 60 秒） |
| `settleMs` | 10 秒 | 点击、回车后页面开始跳转的，最多等它落地多久 |
| `launchMs` / `gracefulCloseMs` / `closeMs` | 30 秒 / 3 秒 / 10 秒 | 起浏览器、让它自己退、等进程树真的退出 |
| `maxTypeChars` / `typeDelayMs` | 2000 字 / 5 毫秒 | 一次输入 |
| `maxReadChars` | 20000 字 | `web_read` 一次最多 |
| `maxScrollPx` | 20000 | 一次滚动 |
| `maxTunnels` | 64 | 一个浏览器同时开着的出网隧道 |
| `diskCacheBytes` | 64 MiB | 浏览器磁盘缓存 |
| `maxProfileBytes` | 512 MiB | 用户数据目录上限，超了在关闭时删 |

## 6. 要在 Linux 节点上验的（照着跑）

节点上要有：chrome-headless-shell 152 的绝对路径；Node 22 以上；一份装好的 `node_modules`，里面有 `puppeteer-core`（部署目录里那一份就行，只读着用）。建议以非特权用户跑（浏览器自己的沙箱能用）；以 root 跑要追加 `--no-sandbox`。

用的是专门的自验脚本 `scripts/probes/cloud-tools-w1-linux-demo.mjs`：自带假站，**只用回环地址上由系统分配的随机端口**，只在自己的临时目录里写东西，不连任何现有服务、不出公网，跑完把自己起的进程与目录清干净。授权在脚本里是放行的桩（授权那一面与平台无关，仓库的专用测试里验过）。

**拷哪些文件**（保持相对路径，共 14 个文件，除 `puppeteer-core` 外只用 Node 标准库）：

```
scripts/probes/cloud-tools-w1-linux-demo.mjs
server/test/cloud-tools-w1-site.mjs
server/agent/service/hosted-browser.mjs
server/agent/service/egress.mjs
server/agent/service/workspace.mjs
server/agent/service/perception/runner.mjs
server/web/browser.mjs  server/web/session.mjs  server/web/view.mjs  server/web/hit.mjs
server/web/hosted/session.mjs  server/web/hosted/network.mjs  server/web/hosted/view.mjs  server/web/hosted/hit.mjs
```

**跑什么**（在节点的一个临时目录里；`<部署目录>` 是节点上 PromptCut 的检出，只读它的 `node_modules`）：

```sh
D=$(mktemp -d) && cd "$D"          # 把上面 14 个文件按相对路径放进来
W1_BROWSER=/绝对路径/chrome-headless-shell \
W1_NODE_MODULES=<部署目录>/node_modules \
node scripts/probes/cloud-tools-w1-linux-demo.mjs ; echo "退出码 $?"
# 以 root 跑时在前面加:W1_EXTRA_ARGS="--no-sandbox"
cd / && rm -rf "$D"
```

**期望的输出**：每一项一行 `[w1-linux] 通过 …`，没有 `没过`；末尾三行是 `按目录名查残留进程: 0`、`临时目录已删`、`全部通过`；退出码 0。逐项是：

| 项 | 验的是什么 | 只有 Linux 才走得到 |
|---|---|---|
| 起得来、打得开；看、点、输入、滚动、读 | 节点上的 chrome-headless-shell 经管道连得上、七个工具走得通 | |
| 页面连不到「内网服务」；回环、metadata、内网、IPv6 的请求都到了代理并被拒；放行的只有假站 | 出网那一组启动参数在 Linux 版上同样管用 | |
| WebRTC：UDP 0 个、候选 `[]`；跳转到内网被拒 | 同上 | |
| 浏览器主进程是进程组的组长；进程表里的进程都在这个组里；组里有活进程；按 /proc 里的命令行认得出它 | 起成了进程组（`spawnTree`）；会打印一行「组里共 N 个活进程；其中进程表里没有的 M 个」——那 M 个就是 zygote 之类 | 是 |
| web_close 拿到了退出凭据；关之前组里的进程都不再活着；进程组空了 | 按组杀、按组核（僵尸不算） | 后两项是 |
| 设为私有：除版本计数外全删 | 前一行会打印关了以后目录里有什么（Linux 上应当能看到 `.pki`、`.cache`、`.config` 之类）；删完只剩 `["rev"]` | 看得到那几个目录是 |
| 服务关闭的回执；两个浏览器的进程组都空了 | `close()` 的三项为真 | 后一项是 |
| 服务进程被强杀后，浏览器整棵树自己退了 | 管道一断浏览器自己退，不留孤儿 | 组的那一半是 |
| 新服务起来时清掉了一个残留浏览器；残留浏览器不再活着 | 残留清理按 `/proc/<进程号>/cmdline` 认「是我们的浏览器」 | 是（Windows 上走的是另一条路） |
| 锁文件与登记里写着的那个不相干的进程没有被杀；过期的锁与登记清掉了；那个对话照常能打开网页 | **不误杀**：脚本起一个 `sleep 300` 当「不相干的进程」，把它的进程号写进另一个对话的过期 `SingletonLock` 与登记里 | 是 |

哪一项「没过」，把那一行和它前后几行原样贴回来就行（行里带着原因：还活着的进程号、代理记录、回执）。脚本在本机（Windows，同版本的 chrome-headless-shell）跑过一遍：标「只有 Linux」的项目打印的是 `跳过(不是 Linux)`，其余全过、退出码 0。

脚本验不了、要靠部署保证的：出网闸之外的兜底（运行用户在系统层面出不了内网）；容器里 Agent 服务是 1 号进程时的僵尸进程（代码已按「僵尸算已退」处理，单测 `W1-PROC-01`、`02` 用假的 /proc 验过，真容器里没有验）。

## 7. 要主会话注意的

1. **桌面版的截图在页面滚动后截的是文档顶部。** `server/web/view.mjs` 的 `captureView` 给 `page.screenshot` 传了 `clip: { x: 0, y: 0, … }`；puppeteer 25 在有 `clip` 时按文档坐标截（等于打开了 `captureBeyondViewport`），所以滚动之后图是页面顶部那一屏，清单却是当前这一屏的，图和清单对不上。本包在无头模式下实测到（`out/` 里的对比：滚到 2071 像素后，这种截法的图与首屏逐字节相同）。桌面版是有头模式，本包没有在有头模式下验，也没有改它（只读）；云端一侧在 `server/web/hosted/view.mjs` 里滚动后从滚动位置重截一张。建议另开一件事去核桌面版。
2. **G 包接线时要填什么**：见第 9 节。
   另有两处是做的过程中实测出来、和原先想的不一样的，写在这里免得后来人再踩：（a）**chrome-headless-shell 不锁用户数据目录**（完整的 Chrome 会锁），所以「这份目录是不是被一个活着的浏览器占着」不能只看锁，清残留时改成再看那个进程的命令行里有没有这份目录；（b）**Windows 上 `taskkill /T` 在机器忙时要好几秒到十几秒**，全量测试并行跑时关浏览器因此超过时限——现在先按最近一份进程表逐个直接结束，`taskkill` 只作兜底。（c）**浏览器有不在它自己进程表里的「帮手进程」**：Windows 上完整的 Chrome 有一个崩溃上报的帮手进程（试过三个关它的启动参数都关不掉），chrome-headless-shell 有一个控制台宿主（不开窗口，探针前后查过）。主进程被结束后，崩溃上报的那个实测还会多活几秒到十几秒，并且一直握着和 Agent 服务相连的管道——「整棵树都退了」的证据因此迟迟拿不到。现在起浏览器时在后台问一次系统（Windows 上用 PowerShell 查后代进程），把它们记下一起结束；关的时候万一还没问到，再问一次。Linux 上靠杀进程组，不走这条路。
3. **测试占固定端口** 28380、28390～28392、28400（都在分给本包的段里）；本包三份测试文件互不冲突，但同一台机器上同时跑两份这条分支的全量测试会撞。
4. `server/test/cloud-tools-w1-fixture.mjs` 里抄了一份 `--disable-field-trial-config`（因为 `server/` 不许引 `scripts/`，守门测试会拦）；有一条断言保证它与产品代码里打头的参数一致，探针传的是 `PROBE_CHROME_ARGS` 原件。
5. 这一轮的每次调用是 2 次授权查询（首次绑定这一轮时多 2 次，登记器要的）。连续操作网页时文档服务会多出这些查询。
6. `web_close`、`closeConversation`、`close` 回的「退出了」是证据：记下的每个进程号都查不到、并且主进程的退出与管道关闭两个事件都到了。在时限（缺省 10 秒）里拿不到证据时，`web_close` 抛 `web-close-pending`（进程已经被结束过，只是还没核实），另两个回 `exited: false` / `childrenClosed: false`——不会把「已经发了结束」说成「已经退出」。

## 8. 要用户定的事

1. **只读成员能不能让云端 Agent 上网。** 现在能（裁 1）。背景：只读成员本来就能和云端 Agent 对话、看画面；上网不改项目，但占托管方的浏览器名额与流量。选项：保持能用；或改成要读写权限。后果：改成读写后，只读成员让 Agent「查一下资料」会被拒。建议保持。
2. **对话设为私有时要不要清掉浏览器的登录态。** 现在清（裁 2）。背景：这一版云端的浏览器不代填密码、也还没有「交给用户登录」，目录里实际只有匿名 cookie；等网页接管（W2 包）做完，用户可能在共有对话里登录过某个站。选项：设为私有时清掉（现在的做法）；或留着。后果：清掉则设为私有后要重新登录；留着则私有之前别的成员登录的状态会留给对话的主人。建议清。
3. **同时开着的浏览器数缺省 2 个够不够。** 背景：节点内存本包没有数据；一个无头浏览器两三百兆。满了的表现：别的对话闲置一分钟以上的浏览器被关掉（页面没了、登录态还在），都在用就回「已到上限，稍后再试」。建议先用 2，部署后按节点内存调。
4. **网页操作记不记用量。** 背景：别的云端工具每次调用记一行。选项：按次数记；按流量记；不记。本包没做，等定了由 G 包加。

## 9. G 包接线时要填什么

```js
import { createHostedBrowserTools } from './hosted-browser.mjs';

const web = createHostedBrowserTools({
  resources,          // createRunResources(...) 的返回(要 authorize 与 register)
  egress,             // createEgressGate(...) 的返回(生产不设 testAllow)
  dataDir,            // Agent 服务的数据目录;浏览器目录在它下面的 web/
  runtime: {
    executablePath,   // 节点配置里的浏览器绝对路径(建议环境变量 PROMPTCUT_AGENT_BROWSER);没有就是「没配浏览器」
    extraArgs,        // 可选:['--no-sandbox'] 之类;改代理、开调试口的会被丢掉并记一行日志
    headless,         // 可选:'shell' | 'new';缺省按文件名判
  },
  limits,             // 可选:覆盖第 5 节的表
  log,                // (event, fields) => void
});
```

- **一轮正常结束后浏览器还活着(最长到闲置关闭),页面里的脚本还能经出网闸发请求。对话设为私有、Agent 被关、对话或项目被删这三种事件,宿主必须无条件调 `closeConversation`(项目被删调 `removeProject`),不能只靠 `abortForFence`**——`abortForFence` 只对「当前这一轮」挂着的浏览器管用,一轮已经结束、下一轮还没来的空档里它什么都杀不到。
- **路由**：`web.handles` 里的七个名字 → `web.call(name, args, context)`，`context` 是这一轮的可信 ToolRunContext（`resources.contextFor(...)` 得到的那个对象，原样传）。结果里的 `__image` 照桌面版的办法摘成图片块。
- **工具表**：`cloud-tools.mjs` 里七个 `web_*` 从「还没接上」挪到「服务端另有实现」；`web_handoff` 那一行的说明（「云端的网页操作还没接上」）与系统提示词里「这一版在云端还没有…网页操作」一并改。节点没配浏览器时可以选择不把这七个交给模型（同「没配看画面的口子」的做法），或照旧交给模型由工具如实回——本包两种都支持（`web.describe().configured`）。
- **收回**：对话设为私有、被停止、Agent 被关时照常调 `resources.abortForFence(context, reason)`，浏览器进程会被杀。登记器的 `childTreeWitness` 可以接 `web.treeClosed`（它等到进程号确实查不到才回 true）。
- **设为私有**：另调 `web.closeConversation({ projectId, conversationId }, { reason: 'private' })`（删用户数据目录）。**对话被删**：`{ reason: 'conversation-deleted' }`。**项目被删**：`web.removeProject(projectId)`。三个都等到进程真的退出才回，回的是 `{ wasOpen, exited, alivePids, profileRemoved }`。
- **服务关闭**：`await web.close(reason)`，回 `{ childrenClosed, streamsClosed, workPending }`；放在 `resources.close()` 之前。
- **状态口**：`web.describe()`（`configured`、`open`、各会话的进程号与出网计数）；`web.egressJournal({ projectId, conversationId })` 是一个对话的出网记录（带主机名，只给排障，不要打进日志）。
- **启动**：`await web.ready` 可选（清上一个进程留下的浏览器，回清掉的个数）；不等也行，第一次起浏览器前会等它。

## 10. 对任务书或语义的更正建议

1. `docs/plan/cloud-agent-contract.md` 9.2 表里 browser 一行、9.9 表里「网页接管、`measure_audio_js`｜无头浏览器｜没接上」：接线后改成「网页操作：chrome-headless-shell 的绝对路径（环境变量名由 G 包定）；没配时工具回『这台节点没有配置浏览器』」。
2. 9.5 节只写了工作区 `<数据目录>/work/…`。浏览器的用户数据目录**没有放在工作区里**（工作区的文件工具列得出、读得到里面的文件，cookie 库不该让模型读到），而是 `<数据目录>/web/<项目>/<对话>/`；建议在 9.5 或新开一小节写明，并写上第 5 节裁 2 的去留规则。
3. 9.6 节「网页接管接上时同样经代理」：建议补一句浏览器要额外堵的几条（回环与链路本地缺省不走代理、浏览器自己解析、WebRTC、QUIC、下载、非 http(s) 协议），指向 `server/web/hosted/network.mjs` 文件头的表。
4. `docs/plan/cloud-agent-tools-implementation.md` W1 行写「现有 `egress.mjs` 若需接口由单独 egress owner 串行扩展」：没有用到，可以划掉这半句。
5. `docs/semantics/product/agent.md`（或 `mechanism/agent.md`）目前没有云端网页操作的条目；合入时建议按二级写三句承诺：按对话隔离、不代填凭据、只能访问公网；数字放三级。

## 全量基线

命令：`npm test`（同一条命令里设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`）。一共跑了四遍，如实都记在这里；**算数的是第四遍**（提交 `00b4dd18`；之后只改了本报告、截图，和 `server/web/hosted/session.mjs` 里一句注释的用词，改完重跑了三份专用测试与两条守门测试，34 条全过）。

| 遍 | 代码 | 结果 | 说明 |
|---|---|---|---|
| 1 | 还没改完 | 6096 条，失败 12、取消 1 | 其中 2 条是本包的：`W1-ISO-01` 报「浏览器进程没有在时限内退出」、`W1-RESTART-02` 残留浏览器没被杀掉。是真问题：机器忙时 `taskkill` 要好几秒。改成逐个直接结束进程。其余 10 条在别的文件里（`codex-auth-state` 五条、`artifact-push` 的 W4、一条 `CA-RENDER-01`、一条「account get_selection…」、`asset-project-workers` 一条、一条「L9 cardLockIdleMs…」），本包没有碰 |
| 2 | 提交 `c16c601c` | 6096 条，通过 6087，失败 1，取消 0，跳过 8，103 秒 | 失败的是 `asset-project-workers.test.mjs`：`listen EADDRINUSE … 127.0.0.1:5782`（端口写死，偶发名单里的）。单独重跑：9 条通过。本包 27 条全过 |
| 3 | 提交 `fb12f19f` | 6096 条，失败 18、取消 3，耗时 1766 秒 | 这一遍机器异常地忙：`account-real-runner.test.mjs` 的一个测试进程挂了近半小时不退（我把自己起的这个测试进程按进程号停掉，全量才收尾），别的文件大面积超时。本包有 4 条没过（`W1-TOOL-01`、`W1-ISO-01` 报没在时限内退出，`W1-RESTART-01`、`02` 等进程退出超时）。查出的真原因见第 7 节第 2 条的 c：浏览器有一个「帮手进程」不在它自己的进程表里，主进程没了以后它还握着管道多活十几秒。已改；测试里等进程退出的时限也从卡固定秒数改成放宽到 40～90 秒（只为防卡死） |
| 4 | 提交 `00b4dd18` | **6096 条，通过 6086，失败 2（同一个测试的父子两行），取消 0，跳过 8（都不是本包的），退出码 1，131 秒** | 失败的是 `server/test/multi-agent-presence.test.mjs` 的「MA-X2 成员 B 的页面正在拖 c2…」（断言拿到的是 `undefined`，跑了 15.9 秒）。单独重跑这个文件：6 条通过、0 失败、退出码 0。本包没有碰它用到的任何文件；它不在通用规矩点名的偶发名单里，请主会话重跑基线时留意。**本包 27 条全过** |

第四遍之后另外单独跑过：三份专用测试连跑两遍（27 / 27，其中一遍赶上机器忙、跑了 163 秒，照样全过）、探针一遍（退出码 0，输出见第 2 节）。

`npx tsc -b --force`：退出码 0，零错误（提交 `00b4dd18` 上）。

不弹窗：探针前后各查一次看得见的窗口，都是空；探针结束时按目录名查残留的浏览器进程是 0。

## 11. 审查之后的修改（第二轮，2026-10-13）

主会话的独立审查没找到能绕过代理或出网闸出网的路，也没找到两个对话共用进程、目录或代理的路；提了一条必须改、八条应该改和几条顺手的。下面逐条写改了什么、哪条测试在验。基底是主会话合过 main 的 `d679373d`。本节与前面各节有出入的地方，以本节为准（前面写「27 条」「三份测试」的地方是第一轮当时的数；第 6 节已经整节换成新的）。

审查说「每条一个提交」。实际是 8 个提交：第 2、3、4 条改的是同一段代码（按对话记正在进行的关闭），合成了一个；第 5、7 条都在重写 `hit.mjs` 与动作那一段，合成了一个；顺手的几条合成一个。

| 审查的条目 | 改了什么 | 提交 | 验它的测试 |
|---|---|---|---|
| 必改 1：清残留浏览器在 Linux 上可能误杀无关进程 | 认「是不是我们的浏览器」**只看它自己的命令行里有没有完整的 `--user-data-dir=<这份目录>`**（Linux 读 `/proc/<进程号>/cmdline`，Windows 问系统）；锁文件、登记文件里的进程号只是候选。候选都不是：非 Windows 上把过期的 `SingletonLock` 等三个文件删掉（不删的话新起的完整版 Chrome 可能会对着锁里那个不相干的进程号去「联系旧实例」）。登记里的子进程号不再直接杀 | `c52bd757` | `W1-PROC-03`、`W1-PROC-04`（注入的进程表与假 /proc）；`W1-RESTART-02`（真浏览器） |
| 应改 2：`treeClosed` 不看关闭结果 | 按会话记每次关闭的结果；没核到「都退了」就回 false，之后每次被问时重核，核到了才回 true | `60b6fe89` | `W1-HOST-01` |
| 应改 3：`closeConversation` 回的是缺省值 | 会话已被摘掉、那次关闭还在进行时，先等它；回它的真结果（没拿到退出凭据就是 `exited: false`） | 同上 | `W1-HOST-02` |
| 应改 4：旧的还在关、新的已经起 | 按对话记「最近一次关闭（含删目录）」；同一个对话的下一次启动、下一次 `closeConversation` 都先等它 | 同上 | `W1-HOST-03` |
| 应改 5：`web_type` 聚焦后的复查失败照样打字；核完之后焦点被挪走 | 复查不过（没了、换了内容、被盖住、不再是输入框）一律按过期拒。打字改成**一个字一段**，每段之前、全部打完之后各核一次焦点还在那个输入框上、它没有变成口令框；不在了就停，如实回 `reason: 'focus_moved'` 与已经打出去的字数，不按回车。所以页面中途挪走焦点时最多有一个字进了别处（`typeChunkChars`，缺省 1） | `aacba013` | `W1-TOOL-05` |
| 应改 6：启动参数 | 改成**白名单，整条相等才留**：`--no-sandbox`、`--disable-setuid-sandbox`、`--no-zygote`、`--disable-dev-shm-usage`、`--disable-gpu`、`--disable-software-rasterizer`、`--disable-field-trial-config`。`argPrefix` 过同一道。名单在 `network.mjs` 的 `ALLOWED_EXTRA_ARGS`，有一条断言盯着它与本表一致 | `6a26c931` | `W1-EGRESS-01`、`W1-EGRESS-03` |
| 应改 7：页面控制的文字进了 `error` | `error`、`blockedNote`、`wallNote`、`hint` 全是写死的句子，不拼页面上的字。页面上的字只在单独的字段里：`coveredBy`（盖住它的那层）、`candidates[].n`、`seen`（那个位置上看到的字）、`blocked[].text` / `.name`（对话框文字、下载文件名）、`clicked.n`；带这些字段的结果都带 `dataNotice`。浏览器与 puppeteer 的异常原文不进句子也不进日志（只留 `netError` 这种固定字母的错误码、异常的类名）。**出错的结果也过交结果前的那次授权复核** | 与 5 同一个 | `W1-TOOL-06`、`W1-HOST-06` |
| 应改 8：设私有时只删 `profile`、`.tmp` | 除版本计数（`rev`，一个数）外，会话目录里的东西全删 | `03f68752` | `W1-RUN-01`（先往目录里放 `.pki`、`.cache`、`.config` 再设私有） |
| 应改 9：Linux 上核不到 zygote；容器里僵尸进程 | **浏览器进程改成自己起**：用 `server/agent/service/perception/runner.mjs` 的 `spawnTree`（非 Windows 上是新进程组的组长）、`killTree`（按组杀）、`whenClosed`；puppeteer 不再用它的启动器，只经管道连上去说调试协议（`puppeteer.connect({ transport })`，传输层三十行自己写）。关闭回执在非 Windows 上多核一条「进程组里没有活着的进程」（`groupAlive` 报组还在时，再读 /proc 排掉僵尸）；逐个核进程号时僵尸也按已退算。Windows 没有进程组，照旧逐个结束进程表里的进程与帮手进程，再用 `killTree`（taskkill）兜底 | `b8830e23` | `W1-PROC-01`、`W1-PROC-02`（假 /proc）；全部真浏览器测试都跑在新的起法上；节点上由第 6 节的脚本验 |
| 顺手：`page.goto` 用规范化后的地址 | `admitWebTarget` 回出网闸解析后的 `url.href` | 与 5、7 同一个 | 现有测试（`navigated` 断言） |
| 顺手：每一轮在浏览器进程上挂监听只增不减 | 交给登记器的不再是浏览器进程，而是每一轮一个的小把手；换了新一轮（旧一轮的上下文已过不了授权）就把旧把手摘掉并通知登记器它关了。顺带修掉一个新发现的挂死：登记被拒时登记器等把手的退出事件，而把手还没记下 | 与 9 同一个 | `W1-HOST-04`、`W1-HOST-05` |
| 顺手：带方括号的 IPv6 经 CONNECT | 查过：代理把带括号的原样交给出网闸，出网闸的 `bareHost` 去括号再判，没有问题；补了测试 | `b3152125` | `W1-EGRESS-02`（`[::1]:443`、`[fd00::1]:443`、`[::ffff:127.0.0.1]:443` 等六个） |
| 顺手：WebRTC 走 TCP 的 TURN | 补了测试：TURN 指向本机假服务，零连接；代理记录里有两条指向它的连接、都被拒（那条 TCP 也只能经代理） | `b3152125` | `W1-EGRESS-09` |
| 顺手：下载的对照；弹出页抢发的请求 | 对照：把下载行为设成「允许」文件真的落盘（2048 字节）。弹出页：用「程序里直接提交 `target=_blank` 的表单」绕过并回当前页的那道，新页直奔内网——请求到了代理并被拒，内网服务零连接，多出来的页被关掉并告诉了模型 | `b3152125` | `W1-EGRESS-13`、`W1-EGRESS-14` |
| 顺手：`reapOrphan` 不看 `servicePid` | 查清了：两个服务进程共用数据目录时，新进程的启动清扫**会**把旧进程还在用的浏览器当残留杀掉。改了：启动清扫时，起它的服务进程还活着就不动（旧进程退出时管道一断它自己会退）；真要在同一个对话里起新浏览器时照清（同一份目录不能两个浏览器用，那时文档服务已经只认新进程）。登记里的服务进程号要是被别的进程占了，后果只是清扫时少杀，不会误杀 | `b3152125` | `W1-PROC-05` |

### 第二轮的验证

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm test -- server/test/cloud-tools-w1-{browser,egress,restart,host,process}.test.mjs` | 0 | 42 条通过（真浏览器 31 条：browser 15、egress 14、restart 2；不起浏览器的 11 条：host 6、process 5），0 失败，0 跳过 |
| 同上五份，加 `W1_BROWSER=<chrome-headless-shell 152 的 Windows 版>` | 0 | 42 条通过，0 失败，0 跳过 |
| `npm test -- server/test/windows-hide-silent-spawn.test.mjs server/test/bakery-deps.test.mjs` | 0 | 7 条通过 |
| `node scripts/probes/cloud-tools-w1-browser-probe.mjs` | 0 | 「全部通过」：五份测试 42 条、真实公网（example.com 经代理，记录里有到 443 的隧道）、浏览器自己解析不了主机名、探针前后可见窗口都是 `[]`、残留浏览器进程 0 |
| `node scripts/probes/cloud-tools-w1-linux-demo.mjs`（本机，`W1_BROWSER` 指 chrome-headless-shell） | 0 | 全部通过；标「只有 Linux」的四项打印的是跳过 |
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test`（全量，最后一遍，在最后一次改代码之后） | 1 | 6227 条，通过 6218，失败 1，取消 0，跳过 8（都不是本包的），116 秒。失败的是 `server/test/account-runner-process.test.mjs` 的「真实运行器在任务进程里…」（等停止接口超时，`503/agent-fence-pending`，跑了 116 秒）；单独重跑这个文件：1 条通过、退出码 0。它不引用本包的任何文件（网页操作还没接线）。本包 42 条全过 |

### 第二轮之后仍没做成的

1. **Linux 上还是没验。** 进程组、读 /proc 认浏览器、清残留不误杀、设私有删 `.pki` 等，代码写了、能注入的部分有单测，真机要靠第 6 节的脚本。
2. **容器里的僵尸进程没有在真容器里验**（只有假 /proc 的单测）。
3. **口令框认不出的情形**（判断只看元素自己的 `type`、`autocomplete`、`name`、`id`、`placeholder`、`aria-label`、`title`；审查说如实写、不为堵洞加启发式）：
   - 用普通文本框加样式遮字（`-webkit-text-security`、自定义字体把字画成圆点）做的口令框；
   - 提示语不在元素自己身上：写在旁边的 `<label>`、表格的上一格、`aria-labelledby` / `aria-describedby` 指向的别处、背景图里；
   - 名字用的是名单外的词或别的语言（「通行码」「安全码」「PIN 码」的别的写法、日文韩文等）；
   - 一格一个字的验证码输入（六个没有名字的小方框）；
   - `contenteditable` 的 div、画在 canvas 上或放在别的源的 iframe、shadow DOM 里的自定义输入控件（iframe 与关着的 shadow DOM 里的元素本来就不在清单里，点不到也打不了；开着的 shadow DOM 里的同理）；
   - 页面在打字途中把框从普通框改成口令框：每个字之前会再看一次类型，所以最多漏进去一个字。
   这些情形下 `web_type` 会照常输入模型给的字。输入的是**模型自己给的字**（云端 Agent 手里没有用户的口令）；撞上登录页时结果里有固定的提醒（`wall` / `wallNote`）。
4. 第一轮「没做成的」第 2～5 条照旧（没有真 mTLS 与真模型、没有用量记账、系统提示词与工具表归 G 包、`web_handoff` 不在本包）。
5. **本机跑节点自验脚本时用了分给本包的端口段之外的端口**：脚本按要求用系统分配的随机端口（这次是 1564、1565 等，都在回环上），和派活指令「端口只用 28380～28419」对不上。只跑了这一遍；三份真浏览器测试与探针仍只用分给本包的端口（新增 28393、28401）。

做第二轮时测试自己也出过几次偶发，都查了原因并改了测试而不是放宽产品：`W1-TOOL-05` 里「一聚焦就消失的框」原先靠定时器消失，在 chrome-headless-shell 上定时器来得晚、字先进了它自己（没有进别处）——改成同步消失；「报的按键数等于两个框里的字数」不成立（焦点正在换的那一下，个别按键哪个框都没收到）——改成断言「落到框里的不多于报的」，口令框里最多一个字的断言没有动。
