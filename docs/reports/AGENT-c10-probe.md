# AGENT 报告：c10-probe（C10 其余 L1 / L2 可行性探针）

分支 `claude/c10-probe`，worktree `.worktrees/c10-probe`，从 main `1dad2b7` 开出。端口段 5420～5429。

状态：进行中（P1 已完成，P2、P3 在跑，P4 已完成）。

代号说明：L1 = 在线浏览器模式里后台舞台当预渲染者；L2 = 页面内 IndexedDB 快照库；D1 / D6 / D7 = 主会话前置核对里待拍板的三点（后台舞台放哪、L2 配额与淘汰、L1 的让路与后台节拍）；OAC = 响应头 `Origin-Agent-Cluster: ?1`；OOPIF = 跨进程 iframe。

## 做了什么

- 新增 `scripts/probes/c10-stage-probe.mjs`（文件头有用法），四个子命令 `p1`～`p4` 加 `calibrate`。自带静态服务，测试页写在脚本里；`createSnapshot` 是 `src/render/createSnapshot.ts` 本体，开跑时用 rolldown 打成 IIFE 放到 `--out`（不入库）。
- 没改产品代码。

## 环境

- Windows 11 Pro，28 逻辑处理器，RTX 3080 / 180 Hz 显示器。puppeteer 25.10.0 自带的 **Chrome/152.0.7977.75**，有头、无头各跑。
- 启动时去掉 puppeteer 缺省的 `--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding` 和它那串 `--disable-features`（其中有 `ProcessPerSiteUpToMainFrameThreshold`），让节流与进程模型接近用户的 Chrome。
- **本机 GPU 路径的 rAF 异常**：带 GPU 时，连一个空白 data: 页的 rAF 都只有 11 次 / 秒（有头、无头都是；`--disable-gpu-vsync` 也一样，再加 `--disable-frame-rate-limit` 才到 59）。加 `--disable-gpu` 走软件合成器后，有头 181 次 / 秒（显示器 180 Hz）、无头 61 次 / 秒。探针缺省加 `--disable-gpu`（`--gpu on` 可关）。推测是机器上其他子 Agent 在用 GPU 或显示器休眠，没深究；结论只比较同一时段的相对值，不受影响。
- **有头 Chrome 刚起来的几秒 rAF 只有 2～3 次 / 秒**，之后跳到 180。探针在测量前等父页 rAF 超过 30 次 / 秒（`waitFps`）。
- 同时有别的子 Agent 在跑测试。每轮开头记 Win32_Processor LoadPercentage，每个用例记测量窗口内 os.cpus() 的系统占用（表里「CPU%」）。
- 子域用 `--host-resolver-rules=MAP *.pc.test 127.0.0.1`，并用 `--unsafely-treat-insecure-origin-as-secure` 让 `editor.pc.test`、`s1.pc.test`、`s2.pc.test` 算安全上下文（线上是 HTTPS）。`.test` 不在公共后缀表里，所以三者同站（站点 `pc.test`）。
- 实验数据在主会话 scratchpad 的 `c10p/` 下（`p1-*.json`、`p2-*.json`、`p3-*.json`、`p4-*.json` 与控制台输出），不入库。

## 旁证：createSnapshot 的代价

`calibrate`：粒子场景每个元素内联样式后约 4 KB HTML。**不带 id** 时 50 / 100 / 200 / 300 / 400 / 600 个元素单帧 17 / 32 / 63 / 91 / 121 / 309 ms。P1 的后台重活取 500 个元素（约 130～300 ms、控件 HTML 约 2.0 MB），P2 的轻场景取 50 个（约 17 ms）。

另见：**每个元素都带 id** 时代价是平方级的：200 / 600 / 1000 / 1400 个元素 130 / 1353 / 3174 / 6541 ms。原因是 `serializeScene` 对每个 id 在整段 HTML 上各跑三遍正则改名（`src/render/createSnapshot.ts` 的 `serializeScene`）。真实卡片 id 不多时不成问题；带大量 id 的卡（例如逐元素带 id 的 SVG）要当心。不在本任务范围，只记下。

## P1 进程隔离与主文档长任务（D1）

### 做法

父页（640×360 的可见舞台 iframe + 同位置 `opacity:0; pointer-events:none` 的后台舞台 iframe，照 `src/editor/Preview.tsx` 的藏法；父页自己跑一条时间轴播放头动画）。可见舞台每个 rAF 推一帧 120 个元素的粒子场景（模拟播放）。每个用例新起浏览器：先量 3 s 基线（后台空闲），再让后台舞台干活、量 6 s。父页与可见舞台各自用 `PerformanceObserver('longtask')` 数长任务、用 rAF 间隔量掉帧。

后台负载三种：
- `busy`：150～300 ms 的忙循环，段间 `setTimeout(0)`；
- `snap`：500 个元素、有状态（每帧由上一帧推出）的场景，每帧 `createSnapshot`（130～300 ms，控件 HTML 约 2.0 MB）；
- `snapidb`：同 `snap`，并把控件 HTML `postMessage` 给父页，父页 `CompressionStream('deflate')` 后写 IndexedDB（L2 的写法）。

布置五种：
- `a-same`：两个舞台与父页同源（`127.0.0.1:5420`）；
- `b-port`：可见舞台、后台舞台各用一个端口（5421、5422），同站跨源，不加 OAC；
- `c-port-oac`：同 b，三个文档都加 OAC；
- `d-sub`：`editor.pc.test` / `s1.pc.test` / `s2.pc.test` 同一个端口，同站跨源（模拟线上子域），不加 OAC；
- `e-sub-oac`：同 d，都加 OAC。

顺序是「轮 → 有头 / 无头 → 负载 → 五种布置」，五种布置在同一时段交替跑，共 3 轮 × 2 × 3 × 5 = 90 例，全部跑完、无报错。

### 结果（各轮数字依次列出）

「LT」是 6 s 加载窗口里的长任务数；「rAF p95」单位 ms。基线 p95：有头 6.2～6.6 ms（180 Hz），无头 17.2～18.1 ms（60 Hz），各布置相同。

| 头 | 负载 | 布置 | 父页 LT | 父页 rAF p95（加载） | 父页 >50 ms 间隔数 | 可见舞台 LT | 可见舞台 rAF p95（加载） | Win32 负载 % | originAgentCluster（父 / 可见 / 后台） |
|---|---|---|---|---|---|---|---|---|---|
| headful | busy | a-same | 29, 29, 31 | 273.3, 297.9, 284.9 | 29, 29, 30 | 29, 29, 29 | 273.3, 297.9, 284.9 | 5, 3, 1 | true/true/true |
| headful | busy | b-port | 30, 29, 29 | 283.1, 280.9, 285.4 | 30, 29, 28 | 30, 29, 27 | 283, 281, 285.4 | 5, 3, 1 | true/true/true |
| headful | busy | c-port-oac | 0, 0, 0 | 6.3, 6.5, 6.5 | 0, 0, 0 | 0, 0, 0 | 6.4, 6.5, 6.5 | 5, 3, 1 | true/true/true |
| headful | busy | d-sub | 28, 28, 29 | 288.3, 276.9, 282.6 | 28, 28, 29 | 28, 28, 29 | 288.3, 276.9, 282.6 | 5, 3, 1 | true/true/true |
| headful | busy | e-sub-oac | 0, 0, 0 | 6.6, 6.2, 6.2 | 0, 0, 0 | 0, 0, 0 | 6.6, 6.2, 6.2 | 5, 3, 1 | true/true/true |
| headful | snap | a-same | 42, 41, 42 | 153, 163, 152.3 | 40, 39, 41 | 39, 38, 40 | 153.1, 163, 152.3 | 5, 3, 1 | true/true/true |
| headful | snap | b-port | 44, 41, 42 | 151.2, 162.4, 152.2 | 42, 39, 41 | 41, 38, 40 | 150.8, 160.5, 151.4 | 5, 3, 1 | true/true/true |
| headful | snap | c-port-oac | 0, 0, 0 | 6.2, 6.5, 6.6 | 0, 0, 0 | 0, 0, 0 | 6.2, 6.5, 6.6 | 5, 3, 1 | true/true/true |
| headful | snap | d-sub | 42, 43, 43 | 153.1, 152.4, 150.9 | 40, 41, 42 | 39, 40, 41 | 152.8, 152.5, 150.7 | 5, 3, 1 | true/true/true |
| headful | snap | e-sub-oac | 0, 0, 0 | 6.5, 6.5, 6.5 | 0, 0, 0 | 0, 0, 0 | 6.5, 6.5, 6.5 | 5, 3, 1 | true/true/true |
| headful | snapidb | a-same | 39, 39, 40 | 163.1, 160.3, 153.4 | 37, 37, 38 | 36, 36, 37 | 160.1, 159.7, 153.1 | 5, 3, 1 | true/true/true |
| headful | snapidb | b-port | 39, 39, 39 | 162.2, 155, 155.5 | 37, 38, 38 | 36, 38, 38 | 161.9, 154, 155 | 5, 3, 1 | true/true/true |
| headful | snapidb | c-port-oac | 0, 0, 0 | 9.4, 9, 8.4 | 0, 1, 0 | 0, 0, 0 | 6.5, 6.5, 6.5 | 5, 3, 1 | true/true/true |
| headful | snapidb | d-sub | 38, 38, 39 | 165.9, 160.8, 155.9 | 37, 37, 37 | 37, 37, 36 | 165.3, 158.5, 155.6 | 5, 3, 1 | true/true/true |
| headful | snapidb | e-sub-oac | 0, 0, 0 | 8.9, 9.4, 8.7 | 0, 0, 0 | 0, 0, 0 | 6.5, 6.5, 6.5 | 5, 3, 1 | true/true/true |
| headless | busy | a-same | 28, 28, 29 | 299.4, 296, 286 | 27, 27, 29 | 27, 26, 29 | 299.5, 296, 286.1 | 15, 5, 11 | true/true/true |
| headless | busy | b-port | 29, 28, 29 | 296.7, 289.1, 290.1 | 28, 28, 28 | 28, 28, 27 | 296.7, 287.2, 290.1 | 15, 5, 11 | true/true/true |
| headless | busy | c-port-oac | 0, 0, 0 | 20, 17.7, 17.5 | 0, 0, 0 | 0, 0, 0 | 17.5, 17.7, 17.5 | 15, 5, 11 | true/true/true |
| headless | busy | d-sub | 30, 28, 29 | 282.9, 293.7, 284.8 | 29, 28, 29 | 29, 28, 29 | 282.9, 293.8, 284.8 | 15, 5, 11 | true/true/true |
| headless | busy | e-sub-oac | 0, 0, 0 | 17.6, 18.5, 20.5 | 0, 0, 0 | 0, 0, 0 | 17.6, 17.5, 17.3 | 15, 5, 11 | true/true/true |
| headless | snap | a-same | 24, 26, 24 | 305.8, 294.9, 310.7 | 22, 24, 22 | 21, 23, 21 | 299, 294.9, 305.9 | 15, 5, 11 | true/true/true |
| headless | snap | b-port | 27, 24, 24 | 292.5, 301, 312.7 | 25, 22, 22 | 24, 21, 21 | 292.5, 300.5, 302.9 | 15, 5, 11 | true/true/true |
| headless | snap | c-port-oac | 0, 0, 0 | 17.6, 17.6, 18 | 0, 0, 0 | 0, 0, 0 | 17.4, 17.6, 17.7 | 15, 5, 11 | true/true/true |
| headless | snap | d-sub | 24, 24, 26 | 308.8, 314, 294.1 | 22, 22, 25 | 21, 21, 25 | 307.1, 314.1, 294.2 | 15, 5, 11 | true/true/true |
| headless | snap | e-sub-oac | 0, 0, 0 | 18, 18, 17.9 | 0, 0, 0 | 0, 0, 0 | 17.5, 17.6, 17.6 | 15, 5, 11 | true/true/true |
| headless | snapidb | a-same | 23, 22, 23 | 326.3, 341, 324.3 | 21, 20, 21 | 20, 19, 20 | 315.4, 333.3, 321 | 15, 5, 11 | true/true/true |
| headless | snapidb | b-port | 23, 22, 23 | 337.7, 341.6, 326.2 | 21, 20, 21 | 20, 19, 20 | 326.6, 328.5, 323.7 | 15, 5, 11 | true/true/true |
| headless | snapidb | c-port-oac | 0, 0, 0 | 18.3, 18.4, 18.3 | 0, 0, 0 | 0, 0, 0 | 17.6, 17.6, 17.6 | 15, 5, 11 | true/true/true |
| headless | snapidb | d-sub | 22, 22, 23 | 337.3, 345.1, 328.8 | 20, 20, 21 | 19, 19, 20 | 334.6, 332.3, 323.2 | 15, 5, 11 | true/true/true |
| headless | snapidb | e-sub-oac | 0, 0, 0 | 19.8, 20, 19.7 | 0, 0, 0 | 0, 0, 0 | 17.6, 17.6, 17.6 | 15, 5, 11 | true/true/true |

补充读数（同一 JSON）：
- **OOPIF**：只有 c、e 两种布置里两个舞台各成一个 `type: iframe` 的独立 target，渲染进程 7 个；a、b、d 没有 OOPIF，渲染进程 5 个。
- **长任务的归属**：a 的父页长任务记为 `same-origin-descendant`，b、d 记为 `cross-origin-descendant`，即后台舞台的任务就在父页的事件循环里跑。
- **加载窗口里父页 rAF 最大间隔**：a / b / d 为 150～360 ms（与单个后台单元等长）；c / e 为有头 7.0～7.5 ms、无头 17.7～31.5 ms。唯一例外：有头 `snapidb` + c 的第 2 轮有一次 66 ms 间隔（没有长任务），见下。
- **后台吞吐**：c / e 下单帧 `createSnapshot` 有头 130～166 ms、无头 255～278 ms；与 a / b / d 相当，没有因隔离变慢。
- **父页写 L2 的代价**（`snapidb`）：每帧控件 HTML 2.0 MB，deflate 后约 61 KB。c / e 下父页从收到消息到写完的 p95 为 15.6～21.2 ms；a / b / d 下因为和后台舞台排在同一线程，p95 为 830～1720 ms。
- `window.originAgentCluster` 在五种布置、三个文档里**全是 true**，没加头的也是：Chrome 152 缺省按源分 agent cluster，但**不因此分进程**。所以这个属性不能用来判断是否隔离，要看 OOPIF。
- 系统 CPU 占用：各用例测量窗口 8～59 %，Win32 负载每轮开头 1～15 %。隔离布置 c / e 的加载窗口 CPU 往往高几个百分点：多出的两个渲染进程与父页真正并行。

### 结论

- **(c) 同站跨源 + OAC 满足判据**：两种负载、有头无头、各 3 轮，父页和可见舞台的长任务都是 0；父页 rAF p95 与基线相同（有头 6.2～6.6 → 6.2～6.6 ms；`snapidb` 时 8.4～9.4 ms，多出的是父页自己 deflate 加写库）；可见舞台 rAF p95 不变。
- **(b) 同站跨源不加 OAC、(d) 子域不加 OAC 与 (a) 同源一样**：后台的每一段重活都成为父页与可见舞台的长任务，一帧 150～300 ms，播放明显卡顿。
- **子域与换端口的效果一样**：e 与 c 数字一致。线上用 `s1.<主机>`、`s2.<主机>` 加 OAC，在 Chrome 152 里就能得到独立进程。没加 OAC 的子域和同源一样卡。
- **可见舞台不受后台舞台拖累**：c / e 下可见舞台的长任务 0、rAF p95 与基线相同。本次测的是两个舞台都跨源的布置；「可见舞台与父页同源、只有后台舞台跨源加 OAC」没单独测，按进程模型推断同样成立（后台在自己的进程里），实施时若采用要补一轮。
- **父页写 L2 的代价在预算内但要留意**：一次性 `postMessage` 2 MB 字符串到父页，父页反序列化再 deflate，有头 9 例里出现过一次 66 ms 的 rAF 间隔（没有记成长任务）。建议舞台里先 deflate（`CompressionStream` 在舞台自己的进程里），再以可转移的 `ArrayBuffer` 交给父页，父页只写库。

