# PromptCut Desktop — 第三方许可证

本文档列出 PromptCut Desktop 安装包中包含或可能包含的第三方软件及其许可证。**分发前请逐项核实**。

---

## 1. Node.js

- **用途**：Sidecar 进程，运行 Vite dev server 提供编辑器后端接口
- **许可证**：MIT License
- **来源**：https://nodejs.org/
- **版权**：Copyright Node.js contributors
- **说明**：安装包中包含完整的 `node.exe` 二进制文件（从构建机的 Node 安装中复制）

## 2. Chrome for Testing

- **用途**：Puppeteer 驱动的导出渲染引擎（虚拟时间逐帧截图）
- **许可证**：Google Chrome for Testing 遵循 Chromium 的 BSD 3-Clause License；包含的各组件有各自的许可证
- **来源**：https://googlechromelabs.github.io/chrome-for-testing/
- **说明**：安装包中包含完整的 Chrome for Testing 二进制文件（约 300 MB）。不包含 chrome-headless-shell。
- **未核实，分发前请确认**：Chrome for Testing 的具体再分发条款是否允许以安装包形式捆绑分发

## 3. FFmpeg

- **用途**：音视频编解码（导出帧合成、音频转 WAV 供语音识别使用）
- **许可证**：**GNU General Public License v3 (GPLv3)**
- **来源**：https://www.gyan.dev/ffmpeg/builds/ （Gyan 的 full build）
- **版权**：Copyright FFmpeg developers
- **重要提示**：Gyan 的 full build 是 **GPL** 构建（启用了 GPL 授权的编解码器），不是 LGPL。以安装包形式分发 GPL 二进制文件，需要满足以下义务：
  1. 随安装包附带 GPL v3 全文（`runtime/ffmpeg/LICENSE` 文件）
  2. 提供对应版本 ffmpeg 源码的获取途径（书面要约或下载链接）
  3. 如果 PromptCut 自身的代码通过进程间通信方式调用 ffmpeg（`spawn('ffmpeg', …)`），一般被视为"聚合"(mere aggregation)而非衍生作品，PromptCut 自身代码不需要 GPL 授权。但 **未核实，分发前请咨询法律意见确认**。
- **安装包内 LICENSE 文件**：`prepare-runtime.mjs` 会从 ffmpeg 安装目录复制 `LICENSE` 和 `README` 到 `runtime/ffmpeg/`

<details>
<summary>GPL v3 全文获取</summary>

完整的 GNU General Public License v3 全文可在以下地址获取：
https://www.gnu.org/licenses/gpl-3.0.txt

对应版本的 ffmpeg 源码可从以下地址获取：
https://www.gyan.dev/ffmpeg/builds/#release-builds （选择对应版本的 source 链接）
或 https://git.ffmpeg.org/ffmpeg.git

</details>

## 4. Tauri 及 Rust 依赖

- **用途**：桌面壳框架，提供窗口、菜单、系统集成
- **许可证**：MIT License 或 Apache-2.0（双许可）
- **来源**：https://tauri.app/
- **包含的 Tauri 插件**：
  - `tauri-plugin-shell`：MIT/Apache-2.0
  - `tauri-plugin-single-instance`：MIT/Apache-2.0
  - `tauri-plugin-opener`：MIT/Apache-2.0
  - `tauri-plugin-window-state`：MIT/Apache-2.0
- **其他 Rust 依赖**：
  - `rfd` (Rusty File Dialogs)：MIT License
  - `serde` / `serde_json`：MIT License 或 Apache-2.0
- **说明**：这些依赖在 Rust 编译时静态链接进 `promptcut.exe`。完整的依赖树可通过 `cargo tree` 查看。
- **未核实，分发前请确认**：运行 `cargo license` 或 `cargo deny check` 确认完整依赖树中没有不兼容的许可证

## 5. WebView2

- **用途**：渲染编辑器界面的浏览器引擎
- **许可证**：Microsoft Edge WebView2 Runtime 许可条款
- **来源**：https://developer.microsoft.com/en-us/microsoft-edge/webview2/
- **说明**：WebView2 Runtime 不随安装包分发。Windows 10/11 通常已预装。若缺失，安装包的 downloadBootstrapper 模式会引导用户在线下载。
- **未核实，分发前请确认**：WebView2 SDK 的再分发条款

## 6. PromptCut npm 依赖

安装包中 `runtime/app/node_modules/` 包含 PromptCut 项目的全部 npm 依赖。主要许可证：

| 包                      | 许可证        | 说明                               |
| ----------------------- | ------------- | ---------------------------------- |
| `react` / `react-dom`   | MIT           | UI 框架                            |
| `motion`                | MIT           | 动画库                             |
| `vite`                  | MIT           | 开发服务器及构建工具                |
| `@vitejs/plugin-react`  | MIT           | Vite 的 React 支持插件             |
| `tailwindcss`           | MIT           | CSS 框架                           |
| `puppeteer`             | Apache-2.0    | Chrome 自动化（导出用）            |
| `pngjs`                 | MIT           | PNG 编解码（确定性验证用）         |
| `typescript`            | Apache-2.0    | TypeScript 编译器（开发依赖）      |

- **未核实，分发前请确认**：运行 `npx license-checker --summary` 确认完整依赖树中没有不兼容的许可证

## 7. 内置 Python（随安装包分发）

- **用途**：语音转文字、镜头识别、运动追踪的运行环境
- **许可证**：PSF License (Python Software Foundation License)
- **来源**：https://www.python.org/downloads/windows/ （Windows embeddable package 3.11.9）
- **说明**：内置 Python 解释器随安装包分发。PSF License 允许再分发。
- **未核实，分发前请确认**：具体使用的 Python 版本的 PSF License 条款

### 7.1 内置 Python 里预装的第三方库（随安装包分发）

这些库**装在解释器的 site-packages 里、随安装包一起发出去**，和第 8 节
「用户自行下载」的性质完全不同 —— 它们的许可证义务在我们这边。

| 库          | 版本   | 许可证       | 用途                                     |
| ----------- | ------ | ------------ | ---------------------------------------- |
| `numpy`     | 2.2.6  | BSD-3-Clause | 运动追踪未装拓展时的模板匹配兜底档所需     |
| `pip`       | 26.2.1 | MIT          | 安装拓展依赖                             |
| `setuptools`| 84.0.0 | MIT          | pip 的依赖                               |
| `wheel`     | 0.48.0 | MIT          | pip 的依赖                               |

**加库到基础运行时要同步改这一节**（改的是 `desktop/scripts/prepare-python.mjs`
里的 `BASE_LIBS`）。基础运行时里的东西不像拓展包那样是用户主动下载的，
漏登记就是我们自己在无证分发。

## 8. 用户自行下载的组件（不随安装包分发）

以下组件**不包含在安装包中**，由用户首次使用语音识别功能时在线下载到 `%APPDATA%\com.promptcut.desktop\`：

| 组件                     | 许可证              | 说明                              |
| ------------------------ | ------------------- | --------------------------------- |
| `faster-whisper`         | MIT                 | 语音识别引擎                      |
| `whisper` (OpenAI)       | MIT                 | 语音识别引擎（备选）              |
| `CTranslate2`            | MIT                 | faster-whisper 的推理后端         |
| `PyTorch`                | BSD-3-Clause        | 深度学习框架                      |
| Whisper 模型权重          | MIT (OpenAI)        | 语音识别模型                      |

由于这些组件由用户主动下载，不构成安装包的一部分，其许可证义务由用户自行承担。

## 9. 拓展库包内的模型权重（随拓展包分发）

拓展库包（`PromptCut-ext-<名字>-<版本>.exe`）是独立于安装包的可选下载，但它**确实
把模型权重分发给了用户**，所以每一份权重都要在这里列清楚。

`desktop/scripts/make-extension.mjs` 里每个模型必须写齐 `title` / `license` /
`source`，缺一项就打不出包——这是硬闸，不指望发布前有人记得回头补文档。打包时还会
把同样的信息写成 `THIRD-PARTY-LICENSES.txt` 放进包里，让拿到包的人不必回仓库查。

| 模型 | 用途 | 许可证 | 来源 |
| --- | --- | --- | --- |
| TransNet V2 (`transnetv2.onnx`) | 镜头切换识别 | MIT | https://github.com/soCzech/TransNetV2 |
| BootsTAPIR (`bootstapir_v2.pt`) | 运动追踪 | Apache-2.0 | https://github.com/google-deepmind/tapnet |

- **TransNet V2**：Copyright (c) Tomáš Souček, Jakub Lokoč。随包的 `.onnx` 由官方
  TensorFlow checkpoint 经官方 `convert_weights.py` 转 PyTorch 后导出，未再训练，
  生成步骤见 [`tools/transnetv2/README.md`](../tools/transnetv2/README.md)。MIT 要求
  保留版权声明和许可证全文，已随包附带。

- **BootsTAPIR**：Copyright (c) Google DeepMind。官方 checkpoint 原样收录，未做
  转换或再训练；官方仓库明确说明 checkpoints 与代码同为 Apache 2.0。本模型的
  PyTorch 推理代码也一并收录在 `python/promptcut_track/vendor/tapnet_torch/`
  （同为 Apache 2.0，仅改了包内 import 路径，模型结构未动，LICENSE 全文在该目录下）。
  Apache 2.0 要求保留版权声明、许可证全文和改动说明，三者均已附带。
  **曾评估 CoTracker3 并否决**：其整个仓库为 CC-BY-NC，禁止商用，既不能随包分发，
  用户拿它做商业剪辑也违约——见下面的检查清单。

拓展包里的 Python 依赖（`wheels/`）各自的许可证见各 wheel 内的 `METADATA`；
当前运动追踪拓展含 torch（BSD-3-Clause）、numpy（BSD-3-Clause）、einshape（Apache-2.0）、dm-tree（Apache-2.0）及它们的传递依赖。
当前镜头识别拓展含 onnxruntime（MIT）、numpy（BSD-3-Clause）、protobuf
（BSD-3-Clause）、flatbuffers（Apache-2.0）、packaging（Apache-2.0 / BSD-2-Clause）。
**未逐一核实，分发前请确认。**

---

## 分发前检查清单

- [ ] 运行 `cargo deny check licenses` 确认 Rust 依赖许可证兼容
- [ ] 运行 `npx license-checker --production --summary` 确认 npm 依赖许可证兼容
- [ ] 确认 `runtime/ffmpeg/LICENSE` 文件存在且包含 GPL v3 全文
- [ ] 确认 ffmpeg 源码获取途径文档已写入安装包或官网
- [ ] 确认 Chrome for Testing 的再分发条款允许捆绑分发
- [ ] 确认 WebView2 SDK 许可条款允许 downloadBootstrapper 模式
- [ ] 确认内置 Python 版本的 PSF License 条款
- [ ] 每加一个随拓展包分发的模型权重，在第 9 节登记，并核实其许可证允许再分发
      （注意有的模型是 CC-BY-NC 之类的非商业授权，**不能**随包发）
- [ ] 核实拓展包内各 wheel 的许可证
- [ ] 若要签名发布，获取代码签名证书并配置 Tauri 签名
