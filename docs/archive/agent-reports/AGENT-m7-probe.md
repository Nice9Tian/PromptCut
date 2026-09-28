# AGENT-m7-probe 报告

分支 `claude/m7-probe`（起点 `24c2c57` = `origin/claude/c10-integ`），任务：M7 契约（`docs/plan/m7-contract.md`，M7 = 纯浏览器当渲染节点）第 8 节的可行性探针 P1～P6。端口 5710～5719。

## 做了什么

- 只写探针脚本与本报告，没改产品代码。四个脚本（用法见各文件头）：
  - `scripts/probes/m7-build-probe.mjs`：P6，页面引 `session.mjs` 后在线构建与开发服务器能不能跑；
  - `scripts/probes/m7-bake-probe.mjs`：P1、P2、P3，子命令 `desktop`（本进程起 `FramePipeline` 出桌面预渲染的参照）、`browser`（后台舞台生成快照）、`compare`（逐帧比 HTML、截图比像素）、`small`（`foreignObject` 出小尺寸，与 CDP 截图比）；
  - `scripts/probes/m7-upload-probe.mjs`：P4，父页推 60 块 HTML + 60 张 WebP 到素材服务；
  - `scripts/probes/m7-visibility-probe.mjs`：P5，真 Chrome 里隐藏、最小化、冻结对续约与会话的影响。
- 要改产品代码的实验都放在实验分支 **`claude/m7-probe-exp`**（worktree `.worktrees/m7-probe-exp`），不进本分支：
  - `8b15dfe`：`src/online/m7NodeProbe.ts` + `main.tsx` 引一行（页面直接引 `createNodeSession`），同时 `session.mjs` 改从 `constants.mjs` 取常量（P6 变体 A 就是这个提交去掉 `session.mjs` 那一行）；
  - `66fa49c`：`filter.mjs` 改从 `messages.mjs` 取 `isListPlan`（P6 变体 C）；
  - `1d2abc7`：舞台 `render(t, { jump, bake: { from } })`——快照趟不按一拍预算截断、挂载帧也生成快照、本地帧号小于 `from` 的只推不生成；这是契约 4.3「`bake` RPC」的最小替身（P1～P3 都靠它）；
  - `ef4b45b`、`87d3461`、`1058b4c`：`bake.ready` 就绪闸（照预渲染的 `waitFrameReady`：控件异步活、字体、图片就绪才生成快照，等的时候照样给同一时刻的拍，超过 5 s 记下卡住的活）。

## 环境与负载

- PC（Windows 11）。P1～P4 用 puppeteer 自带的 Chrome 152.0.7977.75（与 `FramePipeline` 的预渲染 Chrome 同一个二进制，桌面指纹 `258acaaa7c5fe509`），无头为主、`--disable-gpu`，启动时去掉 puppeteer 缺省的三个「后台不节流」开关（同 C10 探针）。P5 用本机装的 Google Chrome 154.0.8037.57（有头、一次性配置目录）。
- 同时有十来个子智能体在跑：各轮开头的 Win32 LoadPercentage 在 4～100 之间（每行数据带 `load`），测量窗口里系统 CPU 12～100%。**所有耗时数字只报数，标「待笔记本复核」**（`verification.md`「性能基准机」）；判据是「主文档长任务 0」这类不靠耗时的项。
- 实验分支的开发服务器 `vite --port 5714`（另占 5715、5716 舞台端口）是本会话起的，用完已停；探针自起的静态服务、托管组合都在 5710～5719 之内。

## P6 `session.mjs` 引进页面：构建与运行（D11）

命令：`node scripts/probes/m7-build-probe.mjs --root .worktrees/m7-probe-exp`（构建 + 在 Chrome 里打开 `/editor/?stage=1` 建一个节点会话）；开发服务器用 `--url http://127.0.0.1:5714/?stage=1`。

| 变体 | `vite build --mode online` | 在线构建产物里跑 | 开发服务器（桌面运行环境同款）里跑 |
|---|---|---|---|
| A 只引 `session.mjs`，不改 | 退出码 0，一条警告：`Module "node:crypto" has been externalized … imported by server/render-queue/queue.mjs` | 正常：`node.hello`、`queue.watch`、`task.claim` 都发出（`queue.mjs` 被摇树摇掉，产物里搜不到 `plan-profile`） | **整页挂掉**：pageerror `Module "node:crypto" has been externalized for browser compatibility. Cannot access "node:crypto.randomUUID" in client code.`，`main.tsx` 之后什么都不执行 |
| B `session.mjs` 改从 `constants.mjs` 取常量（契约 D11 的一行） | 退出码 0，**同一条警告还在** | 正常 | **仍然整页挂掉**：`server/render-node/filter.mjs:23` 也从 `../render-queue/index.mjs` 取 `isListPlan` |
| C 再把 `filter.mjs` 改从 `messages.mjs` 取 | 退出码 0，无 `node:` 警告 | 正常，发出 `task.claim` | 正常，发出 `task.claim` |

结论：在线构建本身不会失败（只是警告），真正的坑在开发服务器——页面只要静态引了这条链，桌面开发环境的编辑器整页白屏。要改两处 import（`session.mjs` 与 `filter.mjs`），不是契约写的一处。

## P1 后台舞台生成快照的节拍与隔离（D3）

命令：`node scripts/probes/m7-bake-probe.mjs browser --dist .worktrees/m7-probe-exp/dist-online --layouts cross-oac,same --modes seq,batch4 [--ready] [--rounds 2 --heads both]`。父页 `127.0.0.1:5710`，后台舞台 `127.0.0.1:5712/editor/?stage=1&dual=1&id=B&lm=0`（跨源、每个响应带 `Origin-Agent-Cluster: ?1`，CDP 看得到它是独立的 iframe 目标）；舞台跑隔离单卡工程（就是桌面 `isolatedCardProject` 的输出），每帧 `probe-frame` 带 gzip 字节回父页，父页解压并用 WebCrypto 算 sha256。每张卡 60 帧（2 s @ 30 fps）。

每秒帧数（seq = 从挂载帧顺推一趟；batch4 = 照桌面 4 帧一批、每批从头推），无头，多次运行的范围：

| 卡 | seq | batch4 | 备注 |
|---|---|---|---|
| `punch-pill`（Motion 弹簧） | 65～126 | 23～28 | |
| `mu-number-ticker`（useSpring） | 65～115 | 23～27 | |
| `probe-slow-stepped`（每新时刻烧 40 ms） | 18.5～21 | 2.7～2.8 | 60 帧 seq 2.9～3.2 s |
| `particles`（Canvas 2D，canvasHeavy） | 20～47 | 9～18 | 栅格化画布 p50 11～25 ms/帧 |
| `lottie-bodymovin`（SVG，有动画数据时） | 1.2 | 1.05 | 生成快照 p50 **755～772 ms/帧**，每帧 570～660 KB，超 300 KB 上限 |

主文档：

- 跨源 + OAC：**所有运行（4～5 张卡 × seq/batch4/probe × 6 轮，含有头 2 条）父页长任务 0**，父页 rAF p95 17.2～18.1 ms（无头 60 Hz），有头 p95 6.5 ms；父页每帧解压 + sha256 p95 0.7～8.6 ms（画布卡 250 KB 的帧最重），一次 14.6 ms。
- 对照同源舞台（`same`）：`probe-slow-stepped` seq 长任务 1 条（91 ms）、batch4 15 条（80～86 ms），rAF p95 47～50 ms、最大 94 ms；`mu-number-ticker` 父页每帧 p95 17.7 ms。
- 判据「同站跨源 + OAC 下主文档长任务 0」：过。帧数只报数，待笔记本复核。
- 有头那一轮跑到第 3 张卡时被本机桌面上的窗口挡住，页面转 hidden、`setTimeout` 链掉到 1 次/秒（与 P5 一致），这一轮不完整，只取了前两张卡。

## P2 浏览器生成的快照对不对（D3、D4，只看独立卡）

命令：`desktop`（参照）→ `browser`（各变体）→ `compare`。比法：逐字节（sha256）；不同的用 `compareSnapshotHtml` 找第一处，再按两种归一重比——去掉内联样式里的 CSS 自定义属性（`--*`）、再去掉 `will-change`；另把两边 HTML 按 `capture-snapshot.mjs` 的挂法截整幅图比像素（第 0、1、15、30、59 帧），并与桌面卡片缓存里的活渲 PNG 比。

逐字节相同的帧数 / 去掉 `--*` 后相同 / 再去掉 `will-change` 后相同（每张卡 60 帧）：

| 对比 | pill | ticker | slow | particles | lottie |
|---|---|---|---|---|---|
| 桌面 vs 开发服务器舞台 seq | 23 / 23 / **60** | **60** / 60 / 60 | **60** / 60 / 60 | 0 / 0 / 0 | — |
| 桌面 vs 在线舞台 seq（无就绪闸） | 0 / 58 / **60** | 0 / **60** / 60 | 0 / **60** / 60 | 0 / 0 / 0 | 空（见下） |
| 桌面 vs 在线舞台 seq（就绪闸） | 0 / 23 / **60** | 0 / **60** / 60 | 0 / **60** / 60 | 0 / 0～13 / 0～13 | 0 / 0 / 0（只差元素 id，见下） |
| 桌面 vs 在线舞台 batch4（就绪闸） | 0 / 30 / **60** | 0 / **60** / 60 | 0 / **60** / 60 | 0 / **56** / 56 | 0 / 4 / 4 |
| 在线 seq vs batch4（就绪闸） | 52 / 52 / **60** | **60** | **60** | 9 | **60**（无数据时两边都空） |
| 在线 seq vs 产品现有测量快照趟（`probe: 'snapshot'`） | 1 / 1（只产出 1 帧） | 1 / 1（只产出 1 帧） | 0（0 帧） | — | — |

像素：pill、ticker、slow、lottie 的桌面 HTML 与在线 HTML 截图**逐像素相同**（平均绝对差 0）；桌面 HTML 与活渲 PNG 的差别两边一样（ticker、slow、lottie 近 0；pill 带框、差别桌面与浏览器相同，不是 M7 引入的）。

差别逐条解释：

1. **在线构建压缩了 CSS**：每一帧根元素的内联样式里都有 Tailwind 主题的自定义属性，自定义属性按原文保存，压缩后 `0.4` 成了 `.4`、`150ms` 成了 `.15s`、`rgb(0 0 0 / 0.12)` 成了 `#0000001f`。开发服务器舞台与桌面（都是未压缩 CSS）对 ticker、slow 逐字节相同。像素无差别。
2. **`will-change: opacity`**：Motion 在 WAAPI 动画进行中挂、结束时摘，摘的时机取决于推法（顺推 / 每批从头推），pill 有 18～37 帧差在这一项。像素无差别。
3. **画布卡没有就绪闸就错**：`particles` 在舞台里前 5 帧没有画布元素（tsParticles 异步装载），开发服务器舞台整段是空画布，同源舞台整段没有画布；加了就绪闸后 batch4 与桌面 56/60 相同（差的是第 0～3 帧，桌面第一批也在异步装载中），而**顺推与每批从头推不等价**（0～13/60 相同）。
4. **Lottie 在在线构建里没有动画数据**：素材卡的 `src` 是 `/catalog/lottie/bodymovin.json`，开发服务器有这个路由，`dist-online/` 与托管端没有，所以舞台里 Lottie 卡整段是空的（只剩包裹层，2 个记号对桌面 2534 个）；就绪闸会一直等 `lottie` 这条活（每帧卡满 5 s 的上限）。探针另把 `server/catalog` 挂在 `/catalog/`（`--catalog`）后，画面与桌面逐像素相同，字节只差 lottie-web 的全局元素 id 计数（`__lottie_element_1220` 对 `__lottie_element_2`，取决于这个页面之前建过多少个 Lottie 实例）。
5. 产品现有的测量快照趟（按一拍预算 23 ms 截断）在这台忙机器上每张卡只产出 0～1 帧，产出的那 1 帧与生成快照路逐字节相同。

结论：DOM 独立卡（pill、ticker、slow、有数据的 lottie）的差别全部能逐条解释、像素相同；顺推与 4 帧一批从头推对这些卡等价（字节差只在 `will-change`），代价差 4～7 倍。canvas 卡顺推不等价，但它按重度是 heavy，本来不进浏览器。就绪闸是必需的。

## P3 `foreignObject` 出小尺寸（D5）

命令：`node scripts/probes/m7-bake-probe.mjs small --variant browser-cross-oac-batch4-ready --frames 0,15,30,59 [--css .worktrees/m7-probe-exp/dist-online]`。在舞台的源（5712）上的页面里：HTML 片段 → XHTML → `<svg><foreignObject>`，外层盒子与 `small-bitmap.mjs` 相同（框大小、`scale(smallScale)`、`isolation:isolate`），`data:` 地址 → `Image.decode()` → `drawImage` → `toBlob('image/webp', 0.8)`。与桌面 CDP 截的 `<帧>.small.webp` 解码后逐像素比，差按预乘后算（近乎透明的像素 RGB 不算）。

- **画布污染：没有**。64 次（4 卡 × 4 帧 × 有无样式表 × 2 轮）`getImageData` 与 `toDataURL` 都不抛。
- 不带全局样式表：pill 错得明显（差 > 16 的像素 10%，覆盖面积 8.8% 对 14.9%）。原因：快照只内联「与同标签基线不同」的非继承属性，基线靠重放页的全局样式（`snapshotStyleProps.mjs` 文件头），SVG 图像是独立文档、没有 Tailwind 基础层，`box-sizing` 退回 `content-box`，pill 胖一圈。
- 带全局样式表（把构建出的 CSS 整份放进 `foreignObject` 的 `<style>`，约 100 KB）：

| 卡 | 预乘差 > 16 的像素 | 预乘平均差 | 最大 |
|---|---|---|---|
| ticker | 0% | 0 | 0 |
| particles（第 15、30、59 帧） | 0% | 0 | 0 |
| slow | 0.045～0.05% | 0.03 | 68～74 |
| pill | 0.63～0.88% | 0.39～0.66 | 72～78 |

  差在文字抗锯齿与 pill 的 32 px 模糊光晕边缘（看过差图 `clip-pill-30-diff-css.png` 与两张小图，肉眼看不出不同）。`particles` 第 0 帧 HTML 本身就与桌面不同（P2 第 3 条），不算。
- 字体：内置卡只用系统字体；构建里唯一的 `@font-face` 是 KaTeX（AI 面板的 Markdown 用），卡片没有用到。所以「外部字体退回系统字体」对 M7 范围内的卡不发生，只会出在用户卡上（本来不进浏览器）。
- 每帧耗时（序列化 + 解码 + 画 + 编码 WebP）：12～100 ms，800×450 的卡以 WebP 编码为主（40～55 ms）；这一步在舞台里、测量时父页无长任务。待笔记本复核。

## P4 页面上传一段（60 块 + 60 小尺寸）（D7）

命令：`node scripts/probes/m7-upload-probe.mjs --frames <某卡 60 帧 HTML> --smalls <60 张 WebP> --rounds 3 --concurrency 1,4`。托管组合（`server/hosted/combo.mjs`，临时数据目录）+ 同源前缀代理（父页与 `/media/` 同源，与托管端布置相同），回环按本机信任、所以不核票据；请求照样带 `Authorization: Bearer` 头。每块：WebCrypto sha256 → `GET chunks` → `PUT …/0` → `POST complete`；第二遍同样的块走去重（只查不传）。

| 数据 | 并发 | 首传总耗时 | 每块 p50 / p95 | 去重一遍 | sha256 p95 | 主文档长任务 | rAF p95 |
|---|---|---|---|---|---|---|---|
| 画布卡：60 块 HTML 14.4 MiB + 60 张 WebP 1.5 MiB | 1 | 2.3～3.8 s | 18～29 / 26～52 ms | 0.19～0.50 s | ≤ 0.6 ms | **0** | 17.9～18.5 ms |
| 同上 | 4 | 0.9～1.3 s | 29～39 / 46～69 ms | 0.11～0.19 s | ≤ 0.6 ms | **0** | 20～21.6 ms |
| pill：0.8 MiB + 0.36 MiB（120 块里 44 块内容重复） | 1 | 1.2～1.6 s | 11～17 / 20～23 ms | 0.31～0.34 s | ≤ 0.2 ms | **0** | 17.6～18 ms |
| 同上 | 4 | 0.58 s（3 轮里 2 轮失败，见下） | 23 / 36 ms | 0.15 s | ≤ 0.2 ms | **0** | 18.6 ms |

- 判据「长任务 0」：过（14 趟全 0）。耗时只报数，待笔记本复核（回环、没有网络延迟与票据核对）。
- **发现**：并发推送时，同一哈希的两块同时在飞会撞：一个请求看到 `received: [0]` 就跳过 `PUT` 直接 `complete`，回 `400 incomplete, missing [0]`（pill 3 轮里 2 轮）。页面上传器要按哈希单飞（同一哈希只有一个在飞，其余等它的结果），`incomplete` 时重查 `chunks` 再传。相邻帧内容相同在 DOM 卡上很常见（pill 120 块里 44 块重复）。

## P5 真 Chrome 里隐藏、冻结对续约与会话的影响

命令：`node scripts/probes/m7-visibility-probe.mjs [--scenarios tab,minimize,freeze30,freeze90]`。本进程起 WebSocket 服务（`server/docservice/ws.mjs`，每 5 s 一次 ping），页面照节点的做法：`setInterval(续约, 10 s)`、一条 `setTimeout(0)` 链当逐帧生成快照、`visibilitychange` 变 hidden 立即发 `release`、`freeze` / `resume` 各发一条、断线 0.5 s 后重连。跑了两次（第一次 tab 6.5 min + minimize 2 min + freeze30 + freeze90，第二次 minimize + freeze30 + freeze90）。

- **放回及时**：6 次转 hidden（切标签 1 次、冻结前切走 4 次、一次原因不明的自发 hidden），`release` 都与 `visibilitychange` 在同一个任务里发出，服务端收到两条消息的时刻相同（差 0～1 ms）。
- **隐藏后多久停**：hidden 之后 `setTimeout(0)` 链立刻掉到 1 次/秒（与 C10 探针 P2 一致），逐帧生成快照等于停了。
- **续约**：hidden 的前约 5 分钟 `setInterval(10 s)` 照常（间隔 9.9～10.1 s）；**过了 5 分钟 Chrome 的强化节流接手，间隔变成 14 s、再到 60 s，超过 `LEASE_MS` 30 s**。所以隐藏的页面若还持有任务，5 分钟后会丢认领；按 D8 隐藏时立即放回就不持有，没有影响。会话不受影响：WebSocket 的 ping/pong 在隐藏的 6.5 分钟里全部应答（78 次，0 次没应答）。
- **冻结**（CDP `Page.setWebLifecycleState frozen`，先 hidden 再冻）：冻结期间计时器全停，续约 0 次（间隔 39.5 s、100 s，都超 30 s）；但 WebSocket 的 ping 仍由浏览器网络层应答（30 s 冻结 6～7 次、90 s 冻结 18 次，0 次没应答），**心跳不会在冻结时判死连接**。**恢复时 Chrome 立即关掉 WebSocket**：页面先收到 `resume`，1～14 ms 内服务端收到关闭码 1001（页面侧 1006），4 次冻结 4 次都这样；0.5 s 后重连成功。所以冻结 → 恢复在队列看来是一次断线（宽限 `RECONNECT_GRACE_MS` 10 s 内重连即接续），手里的任务在冻结超过 30 s 时已经丢认领。冻结只会发生在 hidden 之后，D8「隐藏时不等当前帧、立即放回」已经把它覆盖。
- **最小化**没单独测准：两次都在最小化之前页面就已经 hidden（本机桌面上别的窗口与会话在动；探针缺省关掉了「被遮挡算 hidden」仍如此），两分钟里续约照常 10 s。另外第一次冒烟时（遮挡开着）窗口被别的程序挡住 4.7 s 后页面就转 hidden 并放回：**窗口被挡住也算隐藏，节点会让路**。

## 契约里其它未证实项

- D14：`chromeMajorOf` 对 Firefox 131、Safari 17.5 的 UA 都得 5，同一平台与显卡下指纹相同（`6739b2000f7e22e4`）；Edge 与 Chrome 154 同为 154。证实。
- 3.3 末条「测量时推过的帧可直接用」：测量快照趟每张卡只产出 0～1 帧（P2 第 5 条），用处可以忽略。
- 3.4 「一段 60 帧的重卡在浏览器上要 8～15 s」：`probe-slow-stepped`（40 ms/帧）顺推 2.9～3.2 s；Lottie（有数据）50 s，且每帧都超体积。

## 没做成的及原因

- 最小化情形没测干净（原因见 P5）；有头的 P1 只跑完两张卡（窗口被挡住转 hidden）。这两项都属「页面 hidden」的同一种机制，结论不受影响，但要在笔记本上补一次干净的有头运行。
- P4 用回环信任、没核票据（签 `asset` 票据要在凭证存储里建项目，探针里没做）；票据核对是每请求一次 HMAC，量级可忽略，但没实测。
- 没测 `scene-3d`（WebGL，走 glHost 的 Worker 平面，要父页那一侧的 glHost）；它是 canvasHeavy、heavy，不进浏览器。
- 带耗时门槛的数字全部待笔记本复核。

## 对 M7 契约的更正建议

1. **D11 / 第 0 节第 4 行 / 第 5 节末**：要改两处 import——`session.mjs` 改从 `constants.mjs`、`filter.mjs` 改从 `messages.mjs`。风险描述改为「在线构建不失败（摇树），但开发服务器里整页白屏」。建议 `rq-m7-queue` 顺手加一条守门测试：页面会引的 `server/render-node/*.mjs` 传递依赖里不许有 `node:` 内置模块。
2. **D3 / 4.3 加就绪闸**：每帧生成快照前等控件异步活、字体、图片就绪（与预渲染的 `waitFrameReady` 同一判据，等的时候照样给同一时刻的拍、不推时间），**超时就 `fail` 这一段，不产空帧**。没有它，画布卡前几帧没有画布，Lottie（在线没有数据时）整段产出空帧并被当成结果推上去。
3. **4.3 推帧口径**：P2 证明对 DOM 独立卡（含 Motion）逐帧顺推与 4 帧一批从头推结果等价（字节差只在 `will-change`，像素相同），建议定为**顺推**（代价小 4～7 倍）；另写明 canvasHeavy 的卡顺推不等价，靠重度（heavy）挡在浏览器之外，节点侧 `filterClaimable` 再挡一次 `canvasHeavy`。
4. **D1(d) / D10 / D12：同指纹不同字节**。在线构建压缩了 CSS，浏览器产的每一帧字节都与桌面（开发服务器）不同、像素相同；而指纹只看「系统、显卡档、Chrome 主版本」，用户的 Chrome 与某台桌面节点的预渲染 Chrome 主版本相同时，两份任务的结果键相同、字节不同，同一层里会混两种字节（去重对不上，画面无差）。二选一：在线构建关掉 CSS 压缩（`build.cssMinify: false`，改完再跑一遍本探针的 `compare`），或指纹里加一项构建类别。倾向前者（不动三级指纹定义）。另建议 `createSnapshot` 不写 `will-change`（改它会换 `snapshotCode`、全部键作废，要权衡，可以留到下一次动快照代码时一起做）。
5. **D5 / 4.4**：`foreignObject` 可行、不污染画布，但**必须把页面的全局样式表一并放进 `foreignObject`**（快照省略的属性靠它补），否则 pill 这类卡明显走样。带上之后内置卡差 ≤ 0.9% 像素（文字抗锯齿与模糊边缘）。「外部字体退回系统字体」对内置卡不发生，把第 4.4 节那句改成「只影响用户卡（不进浏览器）」。
6. **3.4 的数字**：「60 帧重卡 8～15 s」改为实测：40 ms/帧的推帧卡顺推约 3 s；Lottie 每帧生成快照约 0.77 s、60 帧约 50 s，且每帧 570～660 KB 超 300 KB 上限、全部被丢。建议切分方不给浏览器出这类卡（桌面快照库里已记为超限的内容键，或按卡声明），否则浏览器白干 50 s；D8「当前帧做完」对这类卡要等近 1 s（笔记本上更久）。
7. **在线构建缺 `/catalog/`**（不属 M7，报给主会话）：Lottie 素材卡在在线舞台里没有动画数据、整段空白（C10 的在线预览同样受影响）。要么把 `server/catalog` 部署到 `/editor/` 下并改素材卡的 URL，要么构建时内联。修之前 M7 必须靠第 2 条的就绪闸把这些段 `fail` 掉。
8. **4.5 / 上传器**：按哈希单飞；`complete` 回 `incomplete` 时重查 `chunks` 再传（P4 的撞车）。
9. **3.3 末条「可选优化」**：删掉。测量快照趟每张卡只有 0～1 帧。
10. **第 2 节让路 / 第 5 节会话**：P5 支持 D8。补两句：hidden 超过 5 分钟后计时器每分钟才醒一次，续约靠不住，所以隐藏时必须已经放回（D8 已是）；冻结恢复时 Chrome 会关掉 WebSocket，节点要把 `resume` 当一次重连（HT-a 接续），不要假定连接还在。可以另听 `freeze` 事件再尽力放回一次（冻结事件在切走约 2 s 后到，这时还能发出消息）。
11. D14 证实，裁定不变。D7（父页推送）由 P1、P4 支持：父页每帧解压 + 哈希 + 上传都没有长任务，裁定不变。

## 提交

- `claude/m7-probe`：`03c0936`（报告骨架）、`ef6d0da`（P6 探针）、`b043c6b`（P5、P1～P3 探针初版）、`700559d`（就绪闸选项、归一比对、小尺寸样式表与预乘差、P4 探针）、`cd4aa94`（Lottie、`--catalog`、测量快照趟对照）、本报告的提交。
- `claude/m7-probe-exp`（实验，不合并）：`8b15dfe`、`66fa49c`、`1d2abc7`、`ef4b45b`、`87d3461`、`1058b4c`。

原始数据（JSON、截图、小尺寸与差图）在本会话的临时目录，没有入库；报告里的数都出自那里。
