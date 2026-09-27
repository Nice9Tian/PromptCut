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
