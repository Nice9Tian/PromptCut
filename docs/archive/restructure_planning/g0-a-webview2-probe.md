# G0-a 桌面壳纯探针报告（第 4 步准入）

任务书 `AGY-TASK-cloud-doc-and-write-race.md` 目标 G 的 G0-a 要求三项都在**桌面版的 WebView2 窗口里**跑过，任一不过第 4 步不开工。本篇是那两段报告里的第一段（G 的验收：「G0 两段报告存档」）。

**结论：三项全过。** 没有一项需要退回「未在真壳里验证」。

| 项 | 判据 | 结果 |
|---|---|---|
| (1) `VideoDecoder.isConfigSupported({ codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware' })` | `supported === true`，且真解码证明背后确实是硬件解码器 | **过** |
| (2) `backdrop-probe.mjs` 在 WebView2 复跑 + 跨源 OOPIF 里 `<video>` 下毛玻璃 | 玻璃底下条纹被抹平，且玻璃外面的条纹仍然锐利（自检） | **过**，9 个用例全过，数字与 Chrome 逐位相同 |
| (3) `oac-probe.mjs` 双端口隔离复测 | 子 iframe 是独立 target，A 死循环 2.5 s 时父页最坏 rAF 间隔仍是一拍量级 | **过**（7 ms / 6 ms），但有一条使用前提，见 §4.3 |

日期 2026-09-19，仓库 HEAD `b5c65dc`，工作区干净。

---

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 Pro 10.0.26200，2560×1440，缩放 100%（96 DPI，`devicePixelRatio = 1`） |
| CPU / 内存 | 28 逻辑核 / 32 GB；开跑前 `\Processor(_Total)\% Processor Time` 为 1.8～7.6 % |
| GPU | NVIDIA GeForce RTX 3080（`0x10de:0x2206`），驱动 **32.0.15.9636**（2026-04-23） |
| **WebView2 运行时** | **153.0.4234.32**（Chromium 153.0.0.0，V8 15.3.12.4，CDP 报 `Edg/153.0.4234.32`） |
| WebView2 的 GPU 状态 | `edge://gpu`：**Video Decode / Video Encode / Canvas / WebGL / WebGPU / Rasterization / Compositing 全部 Hardware accelerated**；Direct Rendering Display Compositor = Disabled，Skia Graphite = Disabled，GPU 进程 sandboxed |
| WebView2 的 GL_RENDERER | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| 对照用 Chrome | **Chrome/152.0.7977.75**（puppeteer 25.10.0 自带）——上一次 backdrop / OAC 实测就是这个大版本 |
| ffmpeg | 9.0.1-full_build（Gyan），libx264 |
| Node | v24.19.0 |

**怎么进的真壳。** `PROMPTCUT_AGENT_CDP=9333` + `PROMPTCUT_RUNTIME_DIR=desktop/src-tauri/runtime` 起 `desktop/src-tauri/target/debug/promptcut.exe`（2026-09-15 构建）。5210 上只挂了一个返回 `PromptCut` 字样的桩 http 服务：`lib.rs:272-285` 探到就判定「已有实例在跑」，于是 `lib.rs:375-378` 直接把主窗导航过去并提前返回，**不起 sidecar、不起 vite、不碰预渲染进程**——纯探针不需要编辑器。`lib.rs:353` 的 `agent_webview::ensure` 仍在提前返回之前执行，所以 agent 子 webview 照常建好。

探针驱动的是这块 agent 子 webview（`about:blank#promptcut-agent`，停在客户区外 `x = -4000`）。它 `on_navigation` 恒返回 true，导航不被壳拦；**停在客户区外照样在合成，`Page.captureScreenshot` 截得到真实画面**——玻璃底下的条纹被抹平、玻璃外面的条纹锐利，这一点本身就是证据（`agent_webview.rs:21-25` 的说法在 WebView2 153 上成立）。

跑完壳和桩服务都已关掉，9333 / 5210 / 52xx 全部释放，没有残留 `promptcut.exe` 或 `msedgewebview2.exe`（剩下的三个 WebView2 实例分别属于 SearchHost、GoogleDriveFS、winauto，与本次无关）。

### 1.1 WebView2 上 CDP 的两个限制

这两条是这次踩出来的，后面谁写连真壳的探针都会撞上：

1. **`Target.createTarget` 开不了新页，而且不是报错、是永远不回包。** puppeteer 的 `browser.newPage()` 会挂死，并且在挂死之前把 agent 子 webview 从 `about:blank#promptcut-agent` 导航成了 `about:blank`。所以 connect 模式一律复用壳里现成的页面，用导航来换用例，绝不试探 `newPage()`。
2. **连着浏览器时 `server.close()` 不返回。** 探针自己起的 http 服务被 WebView2 的 keep-alive 连接吊着，`close()` 的回调永远不来（launch 模式先关浏览器所以撞不上）。要配 `server.closeAllConnections()`。

`page.setViewport`（`Emulation.setDeviceMetricsOverride`）在 WebView2 上正常，`page.screenshot` 正常，`/json/list` 里能看到 `type: 'iframe'` 的 OOPIF target。

---

## 2. (1) WebCodecs / `VideoDecoder`

脚本：`scripts/probes/videodecoder-probe.mjs`（新增）。分两半：`isConfigSupported` 矩阵 + ffmpeg 现做码流的真解码。

### 2.1 `isConfigSupported` 矩阵

四种 `hardwareAcceleration`（`prefer-hardware` / `prefer-software` / `no-preference` / 不写）× 四种配置，**WebView2 里 16 组全部 `supported: true`**，`navigator.mediaCapabilities.decodingInfo` 也全部 `supported: true, smooth: true, powerEfficient: true`。任务书原文那一组（`avc1.640028` + `prefer-hardware`）过。

有一条要记下来：**`isConfigSupported` 不校验 level 与分辨率是否匹配。** `avc1.640028` 是 High@L4.0，MaxFS 是 8192 个宏块；G 的上下拼合一帧是 1920×2176 = 16320 个宏块，放不下 Level 4.0。但把 `codedWidth: 1920, codedHeight: 2176` 连同 `avc1.640028` 一起问，WebView2 照样回 `supported: true`。实际编码时 libx264 按真实尺寸写 SPS（本次 1920×2176 拿到的是 `avc1.640033`，即 High@L5.1），而 G5 写明 `codec` 是「从 `avcC` 拼」，所以线上不会用错——只是**这个 API 的返回值不能拿来判断 level 够不够**。

### 2.2 真解码

码流用 ffmpeg 现做，编码参数照 G3：`libx264 -preset veryfast -crf 16 -g 15 -keyint_min 15 -sc_threshold 0 -bf 0`，`-profile:v high`，`testsrc2` 普通画面，90 帧 @ 30 fps。两种喂法都跑：**AVCC**（`description` = 从 in-band SPS/PPS 拼出的 `avcC`，就是 G5 要用的形态）和 **Annex B**（不带 `description`）。`-bf 0` 保证出帧顺序等于送入顺序。每个配置跑两遍。

- **1920×1080，`avc1.640028`**（SPS 实际写出来就是这个串，不是假设的）：4019 KB / 90 帧。
- **1920×2176，`avc1.640033`**（1080p 卡上下拼合后的整帧尺寸）：7489 KB / 90 帧。

WebView2（`Edg/153.0.4234.32`），两遍：

| 用例 | 首帧 ms | 稳态出帧间隔 p50 / max ms | 90 帧总耗时 ms | 解出来的 codedSize |
|---|---|---|---|---|
| 1080p AVCC `prefer-hardware` 连灌 | 9.6 / 4.3 | 1.5 / 1.6～1.7 | 110.9 / 104.8 | **1920×1088** |
| 1080p AVCC `prefer-hardware` 逐帧等（`optimizeForLatency`） | 2.4 / 1.9 | 0.2 / 1.5～1.6 | 12.9 / 12.5（30 帧） | 1920×1088 |
| 1080p AVCC `prefer-software` 连灌 | 8.6 / 6.5 | 0.6 / 3.4 | 105.2 / 102.6 | **1920×1090** |
| 1080p AVCC `prefer-software` 逐帧等 | 4.8 / 5.0 | 2.9 / 4.4～4.5 | 92.4 / 93.0（30 帧） | 1920×1090 |
| 1080p Annex B `prefer-hardware` 连灌 | 3.1 / 3.8 | 1.5～1.9 / 1.6～2.2 | 102.9 / 133.1 | 1920×1088 |
| 1080p Annex B `prefer-software` 连灌 | 7.0 / 6.4 | 1.0～1.1 / 3.8～4.2 | 124.4 / 126.5 | 1920×1090 |
| **1920×2176 AVCC `prefer-hardware` 连灌** | 7.3 / 5.9 | 2.4～2.7 / 2.7～3.0 | 195.1 / 168.7 | 1920×2176 |
| 1920×2176 AVCC `prefer-software` 连灌 | 13.4 / 12.4 | 0.6 / 5.4～5.6 | 130.9 / 127.6 | 1920×2178 |

**「不只是声称支持」的三条硬证据：**

1. **`prefer-hardware` 与 `prefer-software` 解出来的 codedSize 不一样**：1920×**1088** vs 1920×**1090**（2176 那条是 2176 vs 2178）。1088 是 16 对齐，D3D11 硬件解码器的典型对齐；软件路径给的是另一个数。两条路径走的是**两个不同的解码器实现**，`prefer-hardware` 不是被静默降级成软件。
2. `edge://gpu` 里 **Video Decode: Hardware accelerated**，GPU 进程跑在 RTX 3080 上。
3. `mediaCapabilities.decodingInfo` 的 `powerEfficient: true`。

**对 G 验收的直接对照**：G 要求「冷 seek 到解出目标帧 ≤ 60 ms」。本次单个 IDR 冷解首帧 **1.9～9.6 ms**（1080p）、**5.9～7.3 ms**（1920×2176），离 60 ms 很远——注意这只是解码那一段，G2 说随机访问要「从 IDR 解到目标」，一个分段 15 帧，按上表硬件稳态 1.5 ms/帧（1080p）、2.4～2.7 ms/帧（1920×2176）算，解满 15 帧再加首帧也在 50 ms 以内。分段文件 fetch、解封装的开销不在本探针范围（属 G0-b）。

---

## 3. (2) 毛玻璃能采样到什么

脚本：`scripts/probes/backdrop-probe.mjs`（改造）。8 px 黑白竖条纹当底，上面盖 `backdrop-filter: blur(12px)` 的玻璃，量玻璃底下一行像素的 min/max/mean：条纹还在（max−min ≥ 120）就是**没被模糊**，被抹平成一片灰就是**模糊生效**。

这一版比旧版多了三样：

- 所有用例都走真 http（不再 `setContent`），跨源用例才是真的跨源；
- 加了**自检**：玻璃**外面**那一行必须仍是锐利条纹，否则整条用例判 `INVALID`。旧版「后两项全白」那种情形（画面根本没画出来，min=max=255，会被误判成「模糊生效」）现在会被明确标成 `blank-white` 而不是过；
- 每个用例一个全新文档（launch 模式新开 page，connect 模式重新导航）。

### 3.1 结果（WebView2 153，`--w 400 --h 200`）

| 用例 | 玻璃下（左 / 右） | 结论 |
|---|---|---|
| 同文档，兄弟 2D canvas + WebGL canvas，无 isolation | 112–134 / 112–134 | 模糊 |
| 同上，包裹层 `isolation: isolate` | 112–134 / 112–134 | 模糊，不受影响 |
| 同源 `srcdoc` 透明 iframe 里的玻璃，父文档 canvas | 112–134 / 112–134 | 模糊 |
| 同文档，兄弟 `<video>`（正在播，`readyState 4`，`paused: false`） | 123–134 / 134–145 | 模糊 |
| 同上 + `isolation: isolate` | 123–134 / 134–145 | 模糊 |
| **跨源 OOPIF 里：`<video>` 和玻璃都在 iframe 内**（任务书点名要加的用例） | 123–134 / 134–145 | **模糊** |
| 跨源 OOPIF 里：canvas 和玻璃都在 iframe 内 | 112–134 / 112–134 | 模糊 |
| 跨源 OOPIF 里的玻璃，盖**父文档**的 `<video>` | 123–134 / 134–145 | 模糊 |
| 跨源 OOPIF 里的玻璃，盖**父文档**的 canvas | 112–134 / 112–134 | 模糊 |

九个用例的「玻璃外面」一行都是 `0-255`（锐利），自检全过。跨源那四条都核对过 `/json/list` 里确有 `type: 'iframe'` 的 target（`http://127.0.0.1:5232/...`），即真 OOPIF；父页在 `localhost:5231`，子页在 `127.0.0.1:5232` 且带 `Origin-Agent-Cluster: ?1`。

### 3.2 大尺寸复跑（防 overlay 提升）

Windows 上够大的视频层可能被提升成 DirectComposition overlay，那样玻璃就采样不到它。所以把整套几何放大到 **1280×720** 再跑一遍（视频铺满 1280×720）：**九个用例仍然全部模糊，而且玻璃下是完全平的 `134-134`**（黑白条纹的均值 127.5 加上玻璃自带的 5 % 白），比小尺寸更干净。没有出现 overlay 把视频挡在毛玻璃采样之外的情况。

### 3.3 与 Chrome 的对照

| 用例 | Chrome 152（本次同脚本，headless） | WebView2 153 | 记忆里 2026-09-15 那次 Chrome 152 |
|---|---|---|---|
| 同文档兄弟 canvas，无 isolation | 112–134 | 112–134 | 112–134 |
| 同上 + `isolation: isolate` | 112–134 | 112–134 | 112–134 |
| 同源 srcdoc iframe 盖父文档 canvas | 112–134 | 112–134 | 123–145（旧脚本几何略不同） |
| `<video>` / 跨源 OOPIF 的六个用例 | 见 §3.1，逐项相同 | 见 §3.1 | 未测 |

**WebView2 153 与 Chrome 152 的数字逐位相同**，1280×720 那一轮也拿有窗口的 Chrome 152 对了一遍，同样是 `134-134`。上一次实测里「跨源 OOPIF 和 WebView2 上未测」这条空白，本次补齐。

---

## 4. (3) `Origin-Agent-Cluster` 与进程隔离

脚本：`scripts/probes/oac-probe.mjs`（改造，加 `--connect` / `--only` / `--repeats` / `--reuse-browser` / `--reuse-page`）。父页嵌两个 iframe，A 里死循环 2.5 s，量父页和 B 的最坏 rAF 间隔；同时看 `/json/list` 里子页是不是独立的 `type: 'iframe'` target。每个配置跑两遍。

### 4.1 WebView2 153 的结果

| 配置 | iframe 独立进程 | 父页最坏 rAF 间隔 | B 最坏 rAF 间隔 |
|---|---|---|---|
| localhost 不同端口，无头部 | 否 | 2500～2501 ms | 2500 ms |
| **localhost 不同端口 + `Origin-Agent-Cluster: ?1`** | **是** | **7 ms** | **6 ms** |
| localhost / 127.0.0.1 / 127.0.0.2 | 是 | 7 ms | 6 ms |
| 不同 host + OAC 头 | 是 | 7～8 ms | 6 ms |

两遍完全一致。与 Chrome 152 的 7～9 ms 在同一量级。`window.originAgentCluster` 四种配置都返回 `true`，和上次一样**不能拿它判断进程隔离**，要看 target 列表。

### 4.2 一次假阴性，以及它的根因

第一轮在 WebView2 里跑完整四配置序列时，**带 OAC 头那一档没有隔离**（父页 2500 ms）。这不是 WebView2 的毛病，是探针自己造出来的：

- Chromium 把「某个 origin 是不是 origin-keyed」的判定**按 browsing context group（BrowsingInstance）缓存，一旦定了就不再改**。WebView2 开不了新标签页，所有配置只能在同一个 page 上靠导航切换，于是 BrowsingInstance 一直没换；前一档已经以「不带头」的身份加载过 `localhost:5222`，后一档再给同一个 origin 加上头也不生效。
- 换一组从没加载过的端口（5225 / 5226）在**同一个** WebView2 会话里重跑带头的配置，立刻隔离：父页 7 ms、B 6 ms。
- 反过来在 Chrome 152 里用 `--reuse-page` 复现 WebView2 的处境（一个浏览器、一个 page、同一组端口），**Chrome 也同样不隔离**（父页 2506 ms）；而 `--reuse-browser`（同一浏览器但每档新开 page）下 Chrome 又隔离了（父页 8 ms）。

所以：**判定一致地取决于「这个 origin 在这个 browsing context group 里第一次加载时带没带头」，与 Chrome / WebView2 无关，也与端口无关。**

### 4.3 由此得到的一条使用前提

给舞台 iframe 加 `Origin-Agent-Cluster: ?1` 就能拿到独立进程，这一点在 WebView2 153 上成立。但**必须保证这个 origin 在同一个 browsing context group 里的第一次加载就已经带着这个头**——同一个 origin 先被无头部地加载过一次，之后再补上头，在那一整个 browsing context group 的余生里都不会隔离，而且 `window.originAgentCluster` 仍然骗人地返回 `true`，不会有任何报错。验收时要按 §4.1 的方法量最坏 rAF 间隔，或者数 `type: 'iframe'` 的 target，不能只看响应头发出去了没有。

---

## 5. 对第 4 步的意义

**准入结论：三项全过，第 4 步可以开工。**

- **(1) 过** → G5「每条流一个 `VideoDecoder`（`prefer-hardware`）」在桌面壳里可行，而且拿到的是真硬件解码器（codedSize 1088/1090 的差异是硬证据）。G 验收里「冷 seek 到解出目标帧 ≤ 60 ms」这条，就解码本身而言余量很大。单条流的稳态每帧成本：1080p 1.5 ms、1920×2176（1080p 卡上下拼合）2.4～2.7 ms——这是 G0-b 定「同时活跃的解码器预算（初值 6）」时的起点数字，但 N 条并发的真实吞吐、显存占用、`VideoFrame` 保留预算都属于 G0-b，本探针没测。
- **(2) 过** → 毛玻璃卡不需要为「采样不到下层」单独做流。G1 里「毛玻璃卡（`belowDependent`）不进流」的理由是「它要采样下层、截出来的流和下层对不上」，那条理由不变；本探针排除的是另一种风险——玻璃**根本看不见**下层。实测：流平面是 `<canvas>` 也好、素材段是 `<video>` 也好、玻璃和下层同在一个跨源 OOPIF 里也好，甚至玻璃在跨源 OOPIF 里而下层在父文档，**模糊都正确**；包裹层的 `isolation: isolate`（`Stage.tsx` 现状）不影响；视频放大到铺满 1280×720 也不触发 overlay 提升。G 验收最后一条「毛玻璃卡叠在流 `<canvas>` 和 `<video>` 上时模糊正确」在纯探针这一层已经成立，剩下的是真舞台上的复核。
  - 附带一条与安全/隔离有关的观察：**跨源 OOPIF 里的 `backdrop-filter` 能模糊父文档的内容**（同源 srcdoc 早就能）。也就是说进程隔离挡得住主线程互相卡顿，挡不住合成层面的采样。这只是事实记录，不影响 G 的方案。
- **(3) 过** → E1 的跨源双舞台可以只靠给舞台文档加 `Origin-Agent-Cluster: ?1` 拿到独立进程，不用换 host：舞台里死循环 2.5 s，编辑器父页最坏 rAF 间隔 7 ms、另一个舞台 6 ms。前提见 §4.3——这个 origin 第一次加载就得带头。

**本报告不改任务书的任何方案。** G0-b（编码原型：吞吐、编码耗时、alpha 误差、`frameMs`/`resetMs`/回放曲线、编码器选型、稀疏分段码率）是另一段，与第 4 步并行，另出报告。

---

## 6. 复现

```bash
# 三项都在真壳里跑（壳需先起在 9333，见 §1）
node scripts/probes/videodecoder-probe.mjs --connect --json <out>.json
node scripts/probes/backdrop-probe.mjs     --connect --json <out>.json          # 400x200
node scripts/probes/backdrop-probe.mjs     --connect --w 1280 --h 720 --json <out>.json
node scripts/probes/oac-probe.mjs          --connect --json <out>.json

# 不带 --connect 就是原来的 puppeteer 自带 Chrome 跑法，没变
node scripts/probes/backdrop-probe.mjs                 # headless，加 --headful 则有窗口
node scripts/probes/oac-probe.mjs                      # 每个配置一个全新浏览器

# §4.2 那两个对照
node scripts/probes/oac-probe.mjs --reuse-page   --parent-port 5234 --a-port 5235 --b-port 5236
node scripts/probes/oac-probe.mjs --reuse-browser --parent-port 5227 --a-port 5228 --b-port 5229
node scripts/probes/oac-probe.mjs --connect --only "OAC header" --a-port 5225 --b-port 5226
```

端口：探针默认用 5221–5223（OAC）、5231/5232（backdrop）、5241（WebCodecs），都可用参数改；壳占 5210 与 9333。原始结果 JSON、日志、截图和码流另行存档（见交付清单）。
