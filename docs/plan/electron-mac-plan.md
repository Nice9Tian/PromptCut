# 计划：下一个大版本支持 macOS——换 Electron，但只换「壳」这一层；预渲染那条路一字不动

2026-10-01 用户定方向：下一个大版本支持 Mac，桌面壳从 Tauri v2 迁到 Electron。本文是评估与计划，尚未排期、未动工。规则见 `docs/semantics/guide_files/`；平台承诺见 `docs/semantics/product/platforms.md`。

## 两个被推翻的前提

- **Electron 离屏渲染的 paint 替代不了 beginFrame，也不需要替代。** 预渲染与导出不在壳的 WebView 里做，是另起 puppeteer 驱动的 chrome-headless-shell，用 `HeadlessExperimental.beginFrame`「帧时间由我们给」逐帧截图（`server/bakery/chrome.mjs` 头注：「HeadlessExperimental 域只在它里面有」）。这条路与壳无关，换壳后照旧。Electron 的 paint 是合成器按墙钟出帧，文档原话「When nothing is happening on a webpage, no frames are generated」「the frame has to be copied from the GPU to the CPU bitmap」，没有虚拟时间，只能得到「此刻画成什么样」，得不到「第 n 帧应该是什么样」，会动导出像素基线。
- **支持 Mac 不必换壳；换壳的真正理由是内核一致与调试协议。** `@puppeteer/browsers` 支持 `mac` 与 `mac_arm`，chrome-headless-shell 在 Mac 上有得装。Tauri 在 Mac 上用系统的 WKWebView（Tauri 文档：「older macOS versions don't receive WebKit updates」），而编辑器、Agent 上网、舞台隔离都是按 Chromium 做的。

## 假设

- 用户手上有或会有一台 Mac 做测试；Apple 签名与公证的年费用户接受（按 `constraints.md`「新增费用要绕，不停」记为待用户项，不由会话发起）。
- 大版本允许桌面壳整体重做、补丁机制重做。

## 推荐方案

- **编辑器 UI 跑在 Electron 的 Chromium 里**，Windows 与 Mac 同一内核。
- **预渲染与导出继续用 chrome-headless-shell + beginFrame**，`server/bakery/` 不改，像素基线不动。
- **Agent 上网的子窗口**从 WebView2 子 webview（`desktop/src-tauri/src/agent_webview.rs`：「WebView2 支持 --remote-debugging-port……Node 那边的 puppeteer 代码原样连上来就能用」）换成 Electron 的 WebContentsView，同样开 `--remote-debugging-port`，Node 侧 puppeteer 代码不改。WKWebView 没有这个协议，这是 Tauri 留在 Mac 上最硬的一堵墙。
- **砍掉整套 Chrome for Testing**（`desktop/scripts/prepare-runtime.mjs`：「chrome —— 完整 Chrome，给网页工具 / 采集用（server/web/browser.mjs）」，实测 429 MB），网页工具与采集改用 Electron 自己的 webContents；chrome-headless-shell（270 MB）留着。

**候选路线与为什么不选**

| 路线 | 为什么不选 |
|---|---|
| Tauri 留着、Mac 用 WKWebView | UI 与导出两个内核：字体、滤镜、画布边缘会出肉眼可见差异；预渲染产物是 Chromium 画的、贴回 WebKit 页面里对不上（`src/export/frameCompositor.ts` 头注：预渲染、导出与页面是「同一份页面与钉时间的办法」）；Agent 上网没有调试协议；`showSaveFilePicker` 不支持（有回退）；舞台的进程隔离靠 `Origin-Agent-Cluster: ?1`（`server/vite-plugin-stage-ports.ts`），只在 Chrome 152 实测过，WebKit 下是否真隔离未核实 |
| Tauri 留着、Mac 底层换 CEF 插件 | Gemini 讨论第 1 轮提的；「tauri-plugin-cef」是否存在、成熟度如何未核实，不当候选 |
| Electron 离屏 paint 替代 beginFrame | 见「两个被推翻的前提」；另外 paint 缺省是 CPU 拷贝模式，共享纹理要自写原生模块 |

## 步骤

1. **Windows 上先做 Electron 壳原型**（预计 1～2 天）：主进程起现有的 Node 侧（vite 中间件那套）、加载编辑器、三个舞台源、Agent 子窗口带调试端口。完成的标志：编辑器能开、能预渲染、能导出；G0 与 G0-R 在 Windows 上全过、像素基线 0 差异。这一步不碰 Mac，先证明「壳换了、管线没变」。
2. **Rust 壳的平台专用逻辑改写成 Electron 等价物**：`desktop/src-tauri/src/` 里 6 处 `#[cfg(windows)]`（进程锁、关窗杀进程、Agent 子窗口、标题栏颜色），加托盘与悬浮窗。产出：Electron 主进程模块一一对应。
3. **Mac 上跑同一套**：装 `mac_arm` 的 chrome-headless-shell、Mac 版 ffmpeg 与内置 Python（wheel 按 Mac ABI 用自带解释器重下，`desktop/README.md`「wheel 用自带解释器 pip download」）。完成的标志：Mac 上 G0-R 全过。**像素基线按平台各一份**：Mac 的首版基线由 Mac 首次导出定，与 Windows 那份不互比；这条要写进 `guide_files/verification.md`。
4. **打包与更新**：electron-builder 出 dmg 与 nsis；补丁机制（现在是 NSIS 只换 Node 那半边，`desktop/README.md`「补丁（Node 那半边，几 MB）和完整安装包（318 MB）」）按 Electron 重做，沿用「只换 runtime/app」的思路或 asar 差分。签名与公证是待用户项。
5. **发版前**：整套验证在两个平台各跑一次（`verification.md`「子分支与集成分支各跑什么」，整套只在集成分支跑）。

## 优点 / 缺点 / 限制

- **优点：两个平台、编辑与导出一个内核。** 出处：Gemini 讨论第 1 轮「割裂了编辑态与导出态的渲染内核，这会破坏所见即所得」，机制已核实（同上 `frameCompositor.ts` 头注）。
- **优点：包不会更大，可能更小。** 砍掉 429 MB 整套 Chrome；Electron 本体约 200 MB（一般经验，无原文）。出处：`desktop/README.md`「完整安装包压出来 320 MB（装开约 1 GB）」；验证：`du -sh desktop/src-tauri/runtime/chrome/*` → chrome 429M、chrome-headless-shell 270M。
- **缺点：壳的 Rust 代码作废、重写。** 出处：验证 `grep -c "" desktop/src-tauri/src/lib.rs` → 695 行，另有 6 个平台专用模块。
- **缺点：补丁机制要重做。** 出处：`desktop/README.md` 同上。
- **缺点（未核实）：Electron 内存占用高于 WebView2**，每个窗口一个渲染进程。一般经验。
- **限制：像素基线跨平台不可比。** 同一份 Chromium 在 Mac 与 Windows 上字体栅格化不同，是内核之外的系统差异；主计划第 8 节要求「0 不同、0 缺失」，只能按平台各立一份。一般经验。
- **限制：签名、公证、Mac 机器都是费用与物理操作**，按 `constraints.md` 记为待用户项，不停。

## 第一步（半小时）

在 PC 上写一个 30 行的 Electron 主进程，`npx electron .` 直接加载正在跑的 dev-test（5203），看编辑器能不能开、三个舞台源能不能起、控制台有没有报错。不改仓库任何文件；结果决定第 1 步值不值得投两天。

## 顾问调用记录

Gemini（agy）讨论一轮，2026-10-01：提出三条替代路线（Tauri+CEF 未核实；全 Wasm 导出管线，成本极高且动基线，不采纳；Electron 并砍掉打包的 Chrome，采纳），指出薄弱环节（两个内核破坏所见即所得，采纳），对 paint 与 WKWebView 的判断已按上文标注核实或标未核实。它称「利用 Electron 隐藏的 BrowserWindow 挂载 CDP 跑导出」与代码注释矛盾（beginFrame 只在 chrome-headless-shell 里有），不采纳。
