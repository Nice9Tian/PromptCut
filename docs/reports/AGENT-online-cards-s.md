# AGENT 报告：claude/online-cards-s（第二段块 S：安全隔离）

任务书 `docs/plan/sound-online-render-task.md` 第 13、14 条；契约 `docs/plan/online-card-exec-contract.md` 第 3、4、10 节。worktree `.worktrees/online-cards-s`，分支 `claude/online-cards-s`，起点 `d1c2a29c`。端口段 5750～5759、8780～8781。

**核心项的结论：过。** 安全验收探针 `scripts/probes/online-card-security-probe.mjs` 125 条断言全过、0 条不过、1 条已知缺口；恶意用户卡与恶意图卡都读不到项目凭证、设备身份、任何一张票据、编辑页面的任何本机存储与父页面对象，向外部地址发请求的 47 种办法加 13 种导航办法在收集站都是 0 条连接、0 个包、0 个请求。

本文里的代号：块 S 是第二段里「安全隔离」这一块；块 T 是「转译接入」（分支 `claude/online-cards`）；块 N 是「浏览器节点与队列」（分支 `claude/online-cards-n`）；「甲」是主会话对 WebRTC 缺口的裁定（脚本加固后交付并如实写明不是浏览器保证）；OCS-P / N / H / S / M 是本块单测的编号前缀（策略、nginx 模板、舞台加固与闸门、隔离会话、消息校验）。

## 1. 接手的未提交改动怎么处理的

上一个子 Agent 留下约 300 行改动加 12 个新文件，逐个读过后**全部保留**，先做了一次 wip 提交（`91fc0fa0`），再往下做。保留的理由：它的结构对（策略原文只写在 `src/online/stagePolicy.mjs` 一处，nginx 片段、舞台入口的 `<meta>`、本机代理都从它取），而且它找到了浏览器层面拦 WebRTC 的办法（响应头 `Connection-Allowlist`，见第 4 节），比裁定「甲」多一道。接手后改了它的这几处：

| 改了什么 | 为什么 |
|---|---|
| 四个文件从 `src/online/cardRuntime/` 挪到 `src/online/isolation/` | 主会话的规矩：这个分支不造 `cardRuntime/`（归块 T） |
| `/media-s/<会话号>/media/<哈希>` 转给素材服务的路径从 `/media/<哈希>` 改成 `/api/asset/media/<哈希>` | 原来的会 404：素材服务的接口基址是 `/api/asset`（编辑页面这边的素材基址是 `/media/api/asset`）。nginx 模板与 `mediaSRoute` 一起改；编辑页面只在素材基址正是 `/media/api/asset` 时才走 cookie 这条路 |
| nginx 模板里交接请求的来源判断从正则改成整串相等（多一个 `map`） | 原来的正则里域名的点是通配符 |
| 舞台自检的时限改用真实时间的定时器 | 舞台把 `setTimeout` 换成了跟着舞台时间走的那一份（`src/render/stageClock.ts`），不播放时不走；只有 `<meta>` 生效的那种情况会永远等不到结论 |
| 舞台入口的生成从 `vite.config.ts` 抽到 `server/stage-entry.mjs` | 好写单测 |
| 同一张票据并发只发一次交接请求；舞台报的时刻钳到项目时长以内 | 探针里看到交接请求重复发、伪造的「第 1e99 秒」把播放头带出了时间轴 |

## 2. 做了什么

1. **舞台单独入口与策略**。在线构建多产出一个 `stage.html`（由 `index.html` 加一条 `<meta>` 策略得来，引同一份脚本包，`index.html` 一个字不变）；跨源舞台的 iframe 载它，同源单舞台与桌面版的地址不变。舞台源的每个响应带内容安全策略、出口白名单 `Connection-Allowlist: (response-origin)`、`X-DNS-Prefetch-Control: off` 与原有三条；舞台 iframe 带 `sandbox="allow-scripts allow-same-origin"`；编辑页面只加 `frame-src 'self' <两个舞台源>` 一条。
2. **票据换 cookie**。编辑页面每个页面会话一个随机会话号，握手并自检通过后向每个舞台源发 `POST /media-s/<会话号>/_grant`（票据在 `Authorization` 头里、带凭据），舞台源回 `Set-Cookie: pc_rt=…; Path=/media-s/<会话号>/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`；舞台读素材的地址从 `/media/api/asset/media/<哈希>?t=<票据>` 换成 `/media-s/<会话号>/media/<哈希>`，nginx 把 cookie 换成 `Authorization` 头转给素材服务。素材服务没改。`setMediaPolicy` 对隔离的舞台发 `ticket: null`。
3. **「要执行就不放秘密」两道闸**。舞台这一侧 `src/online/isolation/execGate.ts`：是舞台入口、自检通过、父页点头、本文档从没见过票据、没出过加固拦下的事，五样齐了才开；见过票据的文档永久不开，开过的文档不再收票据。编辑页面这一侧 `src/online/stageIsolation.ts`：总开关开着、是双舞台、两台都自检通过并且票据交接成功才判「可执行」；点过一次头之后任何舞台都不再经 RPC 收到票据。
4. **舞台自检**（`isolationCheck.ts`）：跨源；策略在强制而且出自响应头（只有 `<meta>` 兜底不算，那说明托管端的 nginx 没更新）；出口白名单在生效（同源的重定向被它拦下）或者脚本加固装全；加固装上。结果随握手之后的 `pc-stage-isolation` 消息报给父页，父页不信舞台自己下的结论、按各项事实重算。
5. **加固脚本**（`harden.ts`，只在舞台入口装，在任何别的模块之前）：去掉 `RTCPeerConnection`；Trusted Types 缺省策略拒掉带子框架类标签或实体声明的 HTML 串；`createElement` / `createElementNS` / `customElements.define` 不给造子框架类元素；十几个 DOM 插入入口插入前查子树；去掉 `XSLTProcessor`；`XMLHttpRequest` 不给以文档类型取回；`execCommand` 不做；cookie 只读；`MutationObserver` 兜底摘除并上报，上报后父页本次会话不再执行。
6. **父页消息校验**（`stageMessageGuard.ts`，只对在线的跨源舞台启用）：只认 `event.source` 是自己挂的舞台、`event.origin` 是运行配置里那个舞台源的消息；八种舞台事件按白名单与形状校验，数字钳到合理范围，认不出的丢弃；RPC 回包只许普通数据，耗时类的数钳到 0～10 分钟；握手里的能力表只认六项。
7. **总开关**：运行配置 `editor/runtime-config.json` 里 `"onlineCardExec": false` 就整体退回原做法，缺省开（第 6 节）。
8. **本机等价的代理** `scripts/probes/lib/hosted-proxy.mjs`：三个源 `pc.localhost` / `s1.pc.localhost` / `s2.pc.localhost`，路由与 nginx 模板等价，策略头与 `/media-s/` 的判定取自 `stagePolicy.mjs`；可直接运行起一套本机隔离托管组合。
9. **安全验收探针**与攻击夹具（第 3 节）。
10. 单测 46 条（第 5 节）。

## 3. 安全验收探针

`node scripts/probes/online-card-security-probe.mjs`，退出码 0，约 8 分钟。本机托管组合不信回环（素材服务真核票据），在线构建，Chrome for Testing 152.0.7977.75。最后一行：`"ok":true,"pass":125,"fail":0`，比对了 9 个秘密（项目密码、创建者密码、创建者的读写素材票据、交接给舞台源的只读素材票据、页面经文档服务拿到的票据、编辑页面存的凭证、设备身份、探针种在编辑页面各处存储里的记号）。

加载器还没接到舞台上，探针把夹具 `scripts/probes/fixtures/online-card-attacks/probe-evil-attacks.ts` 当「代表卡片代码的脚本」在舞台的帧里用 `new Function("require", "module", "exports", 代码)` 执行（与加载器执行转译结果的办法相同）：舞台 A 里按恶意用户卡跑一遍，舞台 B 里按恶意图卡跑一遍，各自再在舞台起的 blob Worker 里跑声音那一半。同目录的 `probe-evil-card.tsx`、`probe-evil-graph.tsx` 是两张卡的外壳，合流后三份原样 `content.put` 就能经真实加载路径再跑。

逐组结果（原文摘自探针输出，「用户卡 / 图卡」各一条的合并写）：

| 组 | 断言 | 结果 |
|---|---|---|
| 准备 | 写进空项目；创建者凭读写票据传一张图；素材服务不带票据读是 401 | 3 过 |
| A1 前提 | 双舞台握手成功；两台自检通过（跨源、策略出自响应头、加固装上、Trusted Types 在强制）；出口由 `Connection-Allowlist` 管；票据交接成功、本页判「可执行」、两台闸门开着；舞台载的是 `stage.html`；`sandbox` 只有两项；舞台响应的策略与 `stagePolicy.mjs` 逐字相同；编辑页面带 `frame-src`；舞台读素材的地址是 `/media-s/<会话号>/media/<哈希>`、不带 `?t=`；交接请求到了两个舞台源 | 10 过 |
| A2 父页对象 | 读父页与顶层的 14 种属性全部抛 `SecurityError`；另一台舞台读不到；`opener`、`frameElement` 为空 | 6 过 |
| A3 凭证、票据、本机存储 | 舞台里读得到的一切（用户卡倒出约 22 万字符）里没有任何一个秘密、没有任何票据形状的串、没有 `?t=`；localStorage、sessionStorage、IndexedDB、可读 cookie、cookieStore、OPFS、Cache、性能条目、DOM 属性、全局变量与观察口、父页消息 11 项逐项读出来且没有秘密；可读 cookie 是空的；听到了父页下发的项目内容（`setProject`）与取档策略（`setMediaPolicy`，票据是 null）；凭 cookie 读素材的应答头里没有票据，舞台自己发交接请求是 403 | 33 过 |
| A4 图卡干得了活 | 凭 cookie 按 Range 取素材是 206、字节是 PNG 的头；画进 2D 画布、传进 WebGL2 纹理读得回像素 `10,200,30,255`；换一个会话号、不带票据走旧路由都是 401；POST 405、别的命名空间与子路由 404 | 4 过 |
| A5 带不走 | 两张卡各 47 种外传办法加声音线程里的都跑完，收集站 `{"tcp":0,"udp":0,"http":0}`；攻击代码自己也没有一条报「到达」；本文档里 WebRTC 没有构造器；没开出新窗口、顶层地址没变；导航类 13 种（自己跳走两种、带走顶层、带走父页、开窗两种、meta 刷新、链接两种、表单三种、带 download 的链接）每种单开一页，收集站 0 个请求 0 条连接 | 17 过 |
| A6 声音线程 | 没有父页、顶层、文档、localStorage、opener、`RTCPeerConnection`；9 种网络办法都没到；凭同一张 cookie 取得到素材 | 5 过 |
| A7 加固 | 每张卡试 45 条从子框架拿回 `RTCPeerConnection` 的路（含可行性探针那 21 条），一条都没拿到，每条试完舞台里没有留下子框架；有代码试图造子框架之后父页判 `breach`、舞台的闸门关上。可行性探针里拿到过的那两条现在的结果：`XSLT → 抛错:TypeError;没拿到(子框架 0 个)`、`importNode(从取回来的同源文档) → 抛错:TypeError;没拿到(子框架 0 个)` | 5 过 |
| A8 父页对伪造消息 | 30 多种伪造的握手、回包、舞台事件之后父页没崩、没有页面错误；带脚本的 HTML 没进活文档、原型没被污染；存储里没有超范围的数；播放头没被带出时间轴 | 4 过 |
| A9 DNS | 网络日志里没有任何提到受控组那个域名的事件 | 1 过 |
| B 浏览器层面拦 WebRTC | 假设脚本加固被绕过（探针在页面脚本之前留一份原装的构造器）：`{"said":"候选:[\"host\"]","tcp":0,"udp":0}`；再假设「不给造子框架元素」那一层也被绕过：23 个插入入口全部拦下 | 3 过 |
| G 已知缺口 | 只有内容安全策略、没有出口白名单时：自检记 `egress: script`、仍判隔离；脚本加固在的时候收集站是 0 | 2 过，**1 缺口**（见第 4 节） |
| C 对照 | 去掉策略与出口白名单：fetch、no-cors、XHR、sendBeacon、图片、CSS 背景、脚本都到得了收集站；WebRTC 到了 11 个 UDP 包；网络日志里有对对照组那个域名的解析（11 行）——证明上面的「收不到」不是探针瞎了 | 9 过 |
| L 旧 nginx | 本页不执行，原因 `not-isolated`；自检结论 `meta-only`；编辑页面与两个舞台文档的闸门都关着；内置卡照常画；素材照旧走 `?t=`、没有交接请求；没有页面错误 | 7 过 |
| S 总开关关了 | 原因 `switch-off`；闸门都关着；内置卡照常画；素材照旧走 `?t=` | 6 过 |
| N 没有舞台源 | 原因 `single-stage`；同源单舞台；闸门关着（`not-stage`） | 5 过 |
| M 低内存档 | 同上 | 5 过 |

看过的图：探针存的 `a-editor.png`（隔离生效那一组跑完攻击之后的编辑页面）看了两次。第一次界面完好、片段在时间轴上，但播放头显示成 `86400.00 / 6.00 s`——伪造的「第 1e99 秒」被钳到通用上限后仍在时间轴之外；据此加了「舞台报的时刻钳到项目时长」并补了断言。改完再看，播放头是 `8.00 / 8.00 s`，停在时间轴末尾。

「编辑页面不执行」这一组（契约第 10 节）现在只能断言到闸门：编辑页面、同源单舞台、低内存档的舞台文档里 `__pcCardExecGate()` 都是 `{ allowed: false, reason: "not-stage" }`。「模块顶层的记号不出现在这些文档里」要等加载器接上，夹具的两张卡已经在顶层写了记号 `globalThis.__pcEvilLoaded`。

## 4. WebRTC：用上了浏览器层面的拦法，残余缺口的确切表述

**找到并用上的办法**：响应头 `Connection-Allowlist: (response-origin)`。本机实测 Chrome for Testing 152.0.7977.75 与本机安装的 Chrome 154.0.8037.98（都带 `--disable-field-trial-config`，即不靠实验配置）：带这个头的文档里，`RTCPeerConnection` 只收集到本机候选，STUN 的 UDP 包与 TURN 的 TCP 连接一个都没到收集站（不带时 9～10 个 UDP 包）；跨源 `fetch` 报 `ERR_NETWORK_ACCESS_REVOKED`，同源的重定向报 `ERR_UNSAFE_REDIRECT`（舞台自检就靠后一条判断它在不在生效）；空白子框架与 blob Worker 继承它。`webrtc 'block'` 那条指令仍然不生效，照样留在策略里。

顺带看到的一个现象：带这个头时，在空白子框架里用 `RTCPeerConnection` 会让渲染进程卡死（0 个包出去）。它只是把舞台带死，由现有的舞台看守重载；有加固在，卡片代码也造不出子框架。

**残余缺口**（探针 G 组单列，现状是「缺口还在」）：

> 在不认 `Connection-Allowlist` 的浏览器上（Chrome 152 之前、别的内核），WebRTC 一项靠舞台里的脚本加固，不是浏览器的保证：探针仿这种浏览器（只发内容安全策略、不发出口白名单）并假设脚本加固被绕过，STUN / TURN 的包到得了收集站（5 个 UDP 包、1 条 TCP 连接）。万一被绕过，带得走的是本项目的内容与素材；项目凭证、设备身份与票据不在舞台的脚本环境里（跨源、HttpOnly cookie），带不走。舞台自检把这种情况记成 `egress: "script"`，编辑页面的 `onlineCardExec().egress` 读得到。

这一条哪天不成立了（浏览器开始执行 `webrtc 'block'`），探针会打印「注意……这一条缺口已不存在」并记进最后一行 JSON 的 `notes`，不算失败。

加固堵的路：可行性探针拿到过构造器的两条（XSLT 生成元素、XHR 取回文档再 `importNode`）都堵上了——前者删掉了 `XSLTProcessor`，后者是 `createElement` 钩在所有文档共用的原型上、XHR 不给以文档类型取回、插入入口查子树三道。探针另补了 24 条（XML 实体展开、`responseXML`、`Document.parseHTMLUnsafe`、`document.write`、声明式 shadow DOM、改写原型后再造等）。脚本加固的性质没变：它是逐条堵的，不能证明没有下一条；所以上面那句表述里写的是「靠脚本加固」。

要不要对 `egress: "script"` 的浏览器干脆不执行画面那一半（契约里的「乙」只对这些浏览器生效），是个产品决定，记在第 9 节。

## 5. 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | 退出码 0；4478 项、4477 过、0 失败、1 跳过（起点 4432 项，多出的 46 项是本块新增的单测） |
| 桌面构建 | `npm run build` | 退出码 0；`dist/` 里只有 `index.html` 与 `assets/`，没有 `stage.html` |
| 在线构建 | `npx vite build --mode online` | 退出码 0；产出 `dist-online/index.html`、`stage.html`、`assets/`、`catalog/`；`stage.html` 去掉那条 `<meta>` 后与 `index.html` 逐字相同 |
| 安全探针 | `node scripts/probes/online-card-security-probe.mjs` | 退出码 0；`"ok":true,"pass":125,"fail":0`，已知缺口 1 条（缺口还在）。前后完整跑了三遍，都是 0 条不过 |
| 新增单测 | 随 `npm test` | 46 条全过：OCS-P 9（策略原文、cookie、`/media-s/` 判定）、OCS-N 6（nginx 片段与生成结果逐字相同、每个 location 都带策略头、两条路由、README、舞台入口）、OCS-H 8（加固的纯判定、自检结论、执行闸门、启动钩子）、OCS-S 13（隔离会话）、OCS-M 8（消息校验与不可信模式的 RPC 客户端）、C10-SO-06 / 07（总开关） |
| `online-stage-handshake-probe` | `--dist dist-online --base-port 5750` | 退出码 0，`"ok":true`（S4、S1、S2、S3 四个场景） |
| `c10-ui-probe` | `--dist dist-online --proxy-port 5750 --proxy2-port 5753 --doc-port 5754 --asset-port 5755` | 退出码 0，`"ok":true` |
| `c10-browser-probe` | `--base-port 5750 --dist dist-online` | 退出码 1，`"ok":false`：A1～A4、关掉重开、发布清单计划各步都过（A1 播放 10 秒主文档长任务 0、两个舞台是独立的 iframe 目标）；**A5 两条不过**，见下 |
| `stage-isolation-probe` | 从本 worktree 起桌面 dev server（端口 5750～5752），`--origin http://127.0.0.1:5750` | 退出码 0，`"fails": []`；主文档最坏 rAF 间隔 5.9 / 3.8 / 3.6 ms，中位 3.8 ms（门槛 20 ms） |
| `oac-probe` | `--parent-port 5753 --a-port 5754 --b-port 5755` | 退出码 0；同主机换端口不带头 `in-process`、主文档 rAF 间隔约 2500 ms，带 `Origin-Agent-Cluster` 头 `OOP`、6～7 ms（与改动前的结论相同；这个探针自起服务，不经过本块的代码） |

`c10-browser-probe` 的 A5 两条不过：`超时:A5:独立渲染主机认领清单计划并切分完成`、`A5:认领的节点与页面发布方环境不同(主机用测试指纹)`。独立渲染主机（`scripts/render-host.mjs`，桌面那一半的进程）认领了清单计划（`claimed: 1`、`running` 里挂着它），15 分钟没切完，层最后是页面自己的浏览器节点出的（`newLayer.by: "page"`）。**这两条在起点就不过**：块 N 的报告 `AGENT-online-cards-n.md` 第一节独立记了同样的两条（「完整版 A5 在起点就挂」），它没有改这一段；本块的改动都在在线页面一侧的 `ONLINE` 分支里，没碰队列、切分与渲染主机。本块没有再在起点上重跑一遍来对照（一轮 20 多分钟），以块 N 的记录为据。

起点的全量测试（接手的改动原样跑）：4432 项、4430 过、1 失败、1 跳过；那 1 条失败是 `server/test/codex-auth-state.test.mjs` 的已知偶发（`SyntaxError: Unexpected end of JSON input`），之后的两次全量都没再出现。

**原有探针按新做法改了的断言**：

- `online-stage-handshake-probe`：「舞台页请求」原来只认 `/editor`、`/editor/`、`/editor/index.html` 带 `?stage=1`；跨源舞台现在载 `/editor/stage.html?stage=1`，所以代理多认这一个地址（记请求、S2 / S3 里对它回 503），并在有 `stage.html` 时回它。断言的文字与门槛没动。另外建项目后先写进空项目（在线页面加入空项目被拒，这个探针在 main 上同样因此进不去；用的是块 N 的 `lib-seed.mjs`）。
- `c10-ui-probe`、`m7-node-probe`、`lib-seed.mjs`：从块 N 原样摘了它的提交 `be030d93`（写进空项目），内容与块 N 相同，合流时不冲突。本块没有改它们的断言。
- 其余探针没改。它们的代理仿的是没有隔离策略头的旧 nginx，而且三个源都是 `127.0.0.1` 换端口；在这种摆法下舞台自检不过、不执行、素材走 `?t=`，与改动前等价。

**桌面版的舞台**：桌面构建里 `ONLINE` 恒假，改动的每一处都在 `ONLINE` 分支里或以它为条件——舞台地址仍是 `location.pathname?stage=1…`、iframe 不带 `sandbox`、RPC 客户端不开不可信模式、`setMediaPolicy` 原样收、`bootStageGuard` 第一行就返回、GL Worker 的引导脚本一个字不变（只有本文档已经有 Trusted Types 缺省策略时才加那一句）。桌面构建不产出 `stage.html`。实测的两样：`stage-isolation-probe` 在本分支的桌面 dev server 上过；`c10-browser-probe` 里创建者那一侧（桌面 dev server 加它的预渲染进程）照常建项目、预渲染出 300 帧的层。完整的渲染附加项按任务书留到最后在集成分支上跑，本块没跑。

## 6. 总开关怎么用

托管方在 `/opt/promptcut-hosted/editor/runtime-config.json` 里加 `"onlineCardExec": false`（如 `{ "v": 1, "stageOrigins": [...], "onlineCardExec": false }`）。页面每次打开时读，不用重启服务；删掉或写 `true` 就是开。`deploy-hosted --stage-origins` 会重写这个文件，重新部署后要加回去（建议以后给部署脚本加一个参数，本块没动部署脚本）。

关掉之后：不交接票据、舞台照旧经 RPC 拿票据走 `?t=`、两道闸都关（探针 S 组）。

给块 T 的页面一侧接口 `setCardExecGate({ site?, isolated?, reason? })` 的两个来源（本分支没有 `cardRuntime/gate.ts`，合流时接）：

```ts
import { onlineStageState, subscribeOnlineStages } from "src/online/stageOrigins";
import { onlineCardExec, subscribeOnlineCardExec } from "src/online/stageIsolation";
// site：站点配置里的总开关
onlineStageState().cardExec            // boolean，缺省 true；变了经 subscribeOnlineStages 通知
// isolated / reason：握手、自检、票据交接的结论
onlineCardExec()                       // { enabled, reason, detail, egress }；变了经 subscribeOnlineCardExec 通知
// reason: "ok" | "switch-off" | "single-stage" | "pending" | "not-isolated" | "grant-failed" | "breach"
```

`onlineCardExec().enabled` 已经把总开关算进去了，所以也可以只接这一个。

## 7. nginx 模板改了什么、部署的顺序

- `nginx-site-promptcut-stages.conf`（舞台源）：每个 location 改为 `include snippets/promptcut-stage-headers.conf`；新增 `/media-s/<会话号>/_grant`、`/media-s/<会话号>/media/<哈希>`、形状不对的 `/media-s/` 一律 404、`/editor/stage.html`、自检用的 `/editor/_iso/ok`（204）与 `/editor/_iso/redirect`（302）；文件开头三个 `map`（票据形状、来源、cookie）。原来的 `/media` 保留。
- `nginx-site-promptcut.conf`（主站）：`/editor` 的四个 location 各多一行 `include snippets/promptcut-editor-policy.conf`，其余没动。
- 新增两个片段 `nginx-snippet-promptcut-stage-headers.conf`、`nginx-snippet-promptcut-editor-policy.conf`，由 `node scripts/gen-stage-policy-nginx.mjs` 生成（`--check` 核对），放到 `/etc/nginx/snippets/` 下并把 `{{DOMAIN}}` 换掉。
- **顺序：先改 nginx 再换页面**（README 写了，连同改完后的几条 `curl` 核对）。两头都实测了：
  - 旧页面在新 nginx 下照常工作（响应头里故意不放 Trusted Types 那两条，它们只在 `stage.html` 的 `<meta>` 里）。把起点 `d1c2a29c` 的在线构建放到带全套策略头的本机代理后面跑了一遍（临时脚本，没入库）：`{"dual":true,"handshake":"ok"}`，两个舞台（地址仍是 `/editor?stage=1`）都画出内置卡，素材经 `/media/api/asset/media/<哈希>?t=…` 载入成功，页面错误 0、控制台里没有策略拦截、舞台源上没有非 2xx 的请求、交接请求 0。
  - 新页面在旧 nginx 下自检不过、自动不执行、素材照旧走 `?t=`（探针 L 组）。

**没验的一条**：这台机器没有 nginx，也没有 WSL，模板没有在真的 nginx 上过 `nginx -t`。等价性靠两样：单测逐条核模板里的写法与 `stagePolicy.mjs` 同形；本机代理与模板走同一个判定函数。部署时先 `nginx -t`，不过就照错误改模板（最可能出问题的是 `map` 里引用 location 的具名捕获 `$pc_sid`、带变量的 `proxy_pass`）。

## 8. 与块 T 合流要注意的

试合并（`git merge-tree`）只有 `vite.config.ts` 一处文本冲突：两边在同一位置加东西，两边都留——块 T 的 `cardRuntimeDeps` 与 `define`，本块的 `stageEntryPlugin` 与 `plugins` 里的 `stageEntryPlugin()`。

本块在三个共用文件里改的段：

| 文件 | 段 |
|---|---|
| `src/render/stageRpc.ts` | 文件头多一条 import；`createStageRpc` 多第三个参数 `opts: { untrusted?, maxSec? }`，`onMessage` 里多三处 `if (untrusted)`；`StageMediaPolicy` 多一个 `cardExec?` 字段 |
| `src/StageView.tsx` | 两条 import；`setMediaPolicy` 的处理里三行（过执行闸门）；`postStageReady(caps)` 后一行 `announceStageIsolation()` |
| `src/editor/Preview.tsx` | import 四行；两个 ref（`policySeqRef`、`isoByWinRef`）；`pushMediaPolicy` 整段改写并多两个 effect；`message` 监听里多 `pc-stage-isolation` 一支、`pc-stage-ready` 一支加来源校验；`processReady` 里建 RPC 客户端那几行；`__pcPreviewDiag` 多一项 `cardExec`；三个舞台 iframe 各加 `sandbox` |

接的时候必须守的几条：

1. **舞台里执行前问舞台这一侧的闸门**：加载器执行任何用户卡、图卡的模块之前调 `cardExecGate().allowed`（`src/online/isolation/execGate.ts`），为假就不执行、状态记 `not-isolated`；`subscribeCardExecGate` 关上时把已挂的同步卡撤下。页面一侧的 `gate.ts` 只决定发不发模块，不能代替这一道——票据走 `?t=` 的舞台文档里闸门是永久关的。
2. **新增舞台事件要进白名单**：`loadUserCards` 的状态回报如果是新的 `StageEvent` 类型，要在 `src/online/stageMessageGuard.ts` 的 `sanitizeStageEvent` 里加它的形状校验，否则跨源舞台发来的会被丢掉；单测 OCS-M-01 会在这时变红并写明要补什么。新 RPC 的回包只能是普通数据（对象、数组、字符串、数、布尔、null、字节块），深度不超过 12、单个字符串不超过 16 M 字符。
3. **父页从不经 RPC 发票据或凭证**给隔离的舞台；`loadUserCards` 的包里只放转译结果。
4. **声音线程**：舞台里的 Worker 只能从 blob 地址起（`worker-src blob:`）；blob Worker 继承 Trusted Types，Worker 里 `new Function` 之前要先建缺省策略，写法见 `src/render/gl/spawnWorker.ts` 的 `trustedTypesPrelude`（探针的声音那一半就是这么跑的）。Worker 里的 `setTimeout` 是真实时间；舞台窗口里的 `setTimeout` 跟着舞台时间走，要墙钟定时器用 `__pcRealSetTimeout`。
5. **样式与资源**：注入 `<style>` 可以（`style-src 'unsafe-inline'`）；卡片引用的外部图片、字体、样式、脚本在隔离的舞台里一律加载不出来（只许本源、`data:`、`blob:`）。内置的粒子预设 `nasa` 的背景图是外部地址，在隔离的舞台里会缺这张背景图。
6. **子框架类元素**（`iframe`、`object`、`embed` 等）在隔离的舞台里造不出来，快照 HTML 里带这些标签也贴不上；有卡片代码试一次，本页会话就不再执行。
7. 夹具的两张卡经真实加载路径跑的时候，探针把 `runInFrame` 换成「`content.put` 三份夹具 → 放片段 → 读舞台的 `globalThis.__pcEvil`」，断言不用改；「编辑页面不执行」那一组改为断言 `globalThis.__pcEvilLoaded` 只出现在两个舞台里。

## 9. 没做成的、留给主会话或用户的

| 项 | 状态 |
|---|---|
| 模板没在真的 nginx 上验 | 这台机器没有 nginx；部署时 `nginx -t`（第 7 节） |
| 攻击代码没经真实加载路径 | 加载器在块 T；夹具与探针已备好（第 3、8 节） |
| 视频素材经 cookie 这条路 | 探针用的是图片素材加 `fetch` 的 Range 请求；`<video>` 定位取帧没单独验（可行性探针在同样的摆法下验过） |
| cookie 的 `Secure` | 本机代理走 http，发的 cookie 不带 `Secure`；模板里带 |
| 别的浏览器 | 只在 Chrome 152、154 上实测；Firefox、Safari 没有，它们不认 `Connection-Allowlist` 时落到 `egress: "script"` |
| 待用户定：`egress: "script"` 的浏览器要不要不执行画面那一半 | 现在照裁定「甲」执行。若要改，只需在 `judgeIsolation` 里把 `script` 判成不通过，一行 |
| 待用户定：隔离舞台里外部资源加载不出来算不算要写进语义 | 用户看得到区别（引用外链图片的用户卡在线上缺图），属二级；本块没改语义文档 |
| 部署脚本没有总开关的参数 | 第 6 节 |
| 其余探针的代理仍是旧摆法 | 建议集成时把各探针的仿 nginx 代理换成 `lib/hosted-proxy.mjs`，那样它们才在隔离生效的摆法下跑 |

发现：编辑页面的源如果哪天设了带 `Domain=<主机>` 的 cookie，两个舞台子域都看得到（现在编辑页面不设任何 cookie，凭证都在 localStorage 里）；建议在语义或约束里记一句「编辑页面的源不设带 Domain 的 cookie」。

## 10. 对契约的更正建议

`docs/plan/online-card-exec-contract.md`（本分支上是较早的一版）：

- 3.3（一）：策略里 Trusted Types 两条只进 `stage.html` 的 `<meta>`，不进响应头（否则「先改 nginx 再换页面」那段时间旧页面的舞台贴不了快照）；响应头另加 `Connection-Allowlist: (response-origin)`。
- 3.3「舞台自检」：不止「向外部地址发一次 fetch 等违规事件」，是四项（第 2 节第 4 条），而且只认出自响应头的策略；舞台源要多两个自检用的地址 `/editor/_iso/ok`、`/editor/_iso/redirect`。
- 3.4：改为「浏览器层面由 `Connection-Allowlist` 拦，脚本加固是第二道，也是不认这个头的浏览器上唯一的一道」，残余缺口用第 4 节那段话。
- 4.1 第 2、3 步：会话号是 32 位十六进制；`/media-s/<会话号>/…` 只放行 `media/<64 位哈希>[.<扩展名>]`，转到素材服务的 `/api/asset/media/…`；只有编辑页面的素材基址是 `/media/api/asset` 时才走这条路。
- 4.1 第 4 步：`setMediaPolicy` 没有去掉 `ticket` 字段，是对隔离的舞台发 `null`、另带 `cardExec`；没隔离的跨源舞台也照旧用 `?t=`（契约只写了同源单舞台与低内存档）。
- 3.2「协议面」：补一条「舞台报的时刻钳到项目时长以内」。
- 第 8 节的运行状态 `not-isolated`：可以细分出「托管方关了总开关」（`switch-off`），参数面板的说明不同。
- 第 10 节：导航类除了契约列的五种，表单提交与带 `download` 的链接也会把舞台自己带走（被拦下后框架落到错误页，收集站 0 请求），探针把它们归到导航类里单开页面跑。

## 11. 提交

| 提交 | 内容 |
|---|---|
| `91fc0fa0` | wip：接手的未提交改动原样提交，四个文件挪到 `src/online/isolation/` |
| `66416aba` | 从块 N 摘的探针修复（写进空项目，`lib-seed.mjs`） |
| `71e5444d` | 本机代理、cookie 路由的转发路径、来源整串相等、舞台入口生成抽出、诊断带 `cardExec` |
| `01eca992` | 安全验收探针与夹具、自检用真实时间的定时器、README、单测 OCS-P / N / H / S |
| `563daa0a` | 单测 OCS-M 与总开关、时刻钳到项目时长、交接去重、握手探针认舞台入口 |
| 本报告所在的提交 | 报告定稿 |
