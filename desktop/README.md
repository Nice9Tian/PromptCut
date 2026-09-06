# PromptCut Desktop

PromptCut 的 Tauri v2 桌面壳。把编辑器和它依赖的全部运行时——Node、Chrome for Testing、ffmpeg、内置 Python——打成一个 Windows x64 NSIS 安装包。用户双击安装、双击图标就能用，不需要自己装 Node、浏览器或 Python。

## 为什么要把 Node 打包进去

PromptCut 的后端逻辑写在 `vite.config.ts` 的几个插件中间件里（AI 桥、导出、语音转文字）。`vite build` 产出的是纯静态文件，没有这些接口。运行时必须真起一个 Vite dev server，所以安装包里自带了完整的 Node 和项目源码副本，由 Rust 壳以 sidecar 方式启动。

## 构建环境

| 项目         | 版本                                                            |
| ------------ | --------------------------------------------------------------- |
| Node.js      | ≥ 22（推荐 24.x）                                               |
| Rust         | stable msvc（`rustup default stable-x86_64-pc-windows-msvc`）    |
| VS Build Tools | 「使用 C++ 的桌面开发」工作负载                                   |
| WebView2     | Windows 10/11 自带；若缺失，安装包会自动下载 bootstrapper         |
| ffmpeg       | `winget install --id Gyan.FFmpeg -e`                             |
| Tauri CLI    | `npm i`（已在 devDependencies 中）                               |

## 构建步骤

```powershell
cd desktop

# 1. 安装 Tauri CLI
npm install

# 2. 组装 runtime/（复制 app 源码 + npm ci + vite build + Chrome + ffmpeg + node sidecar）
npm run prepare-runtime

# 3. 组装内置 Python（另一个任务负责的脚本）
npm run prepare-python

# 4. 构建安装包（Rust 编译 + NSIS 打包）
npm run build
```

> **首次构建说明**
>
> - `prepare-runtime` 首次运行需要复制 Chrome for Testing（约 500 MB），后续幂等运行会快很多。
> - Rust 首次编译 Tauri 及其依赖约 5–15 分钟，后续增量编译很快。
> - 构建产物在 `src-tauri/target/release/bundle/nsis/` 下。

## 发布：安装包 + 更新补丁

日常改动绝大多数只落在 Node 那一半（`src/`、`server/`、`dist/`），Rust 壳和
Chrome / ffmpeg / Python 三个大块一动不动。完整安装包接近 1 GB，而这些改动本身
通常只有几 MB，所以每次发布产出两个东西：

```powershell
cd desktop
npm run release -- --from-head    # 推荐：源码取自 HEAD
npm run release                   # 源码取自当前工作区
```

`--from-head` 会先从 HEAD 开一棵临时 worktree 当源码，产物因此一定对应某个
commit，而不是把工作区里未提交的东西一起发出去（多人同时改一个工作区时尤其
要紧）。被排除的文件会在日志里逐条列出来。只有源码走 worktree，Chrome /
ffmpeg / Python / Rust 编译缓存还是用 `desktop/` 下原来那份，不会因此变慢。

| 产物                             | 大小     | 什么时候用                                     |
| -------------------------------- | -------- | ---------------------------------------------- |
| `release/PromptCut-<版本>-setup.exe` | ~1 GB    | 第一次安装；外壳版本变了；补丁装不上时的兜底   |
| `release/PromptCut-patch-<版本>.zip` | 几 MB    | 已经装过，只是更新 Node 那半边                 |

补丁包里带 `安装更新.cmd`，用户双击就行。它会核对安装位置和版本、请用户关掉
正在运行的程序、备份当前版本再覆盖，逐个文件校验 SHA-256，任何一步出错都回滚。
`exports`（导出的视频）、`.pc-chats`（AI 会话历史）、`%LOCALAPPDATA%\promptcut`
（设置和密钥）和下载的语音模型都不在补丁的作用范围内。

**两个版本号是分开的**，这正是补丁能成立的前提：

- **应用版本**（根 `package.json`）—— Node 那半边，补丁负责更新它。
- **外壳版本**（`src-tauri/tauri.conf.json`）—— Rust 那半边，只有改了 Rust 代码
  或换了 Chrome / ffmpeg / Python 才需要动。补丁声明自己需要的最低外壳版本，
  对不上就拒绝安装并让用户改用完整安装包。

**依赖变化**由 `package-lock.json` 的哈希自动判断：和上一次发布一致就不打包
`node_modules`（补丁几 MB），不一致就整个带上（补丁约 150 MB，仍比完整包小得多）。
判断基准是 `release/manifest-<版本>.json`，每次发布自动留下一份 —— **别删它**，
删了下一次就只能保守地把依赖整个带上。

其他用法：

```powershell
npm run release -- --patch-only     # 只出补丁，跳过 Rust 编译
npm run release -- --skip-runtime   # runtime 已就绪，直接编译打包
npm run release -- --with-deps      # 强制把 node_modules 打进补丁
npm run make-patch                  # 只跑打补丁这一步
```

在自己机器上验证补丁而不真的写入：

```powershell
powershell -ExecutionPolicy Bypass -File <解压目录>\apply-patch.ps1 -WhatIf
```

## 开发期

开发时不需要每次都跑 `prepare-runtime`。先跑一次组装好 `src-tauri/runtime/`，然后：

```powershell
# 设置环境变量，让壳直接使用已组装好的 runtime，免得每次复制
$env:PROMPTCUT_RUNTIME_DIR = "$PWD\src-tauri\runtime"

# 启动 Tauri 开发模式（Rust 热重载 + 前端 live reload）
npm run dev
```

也可以单独跑 PromptCut 的 dev server（在项目根目录 `npm run dev`），壳会检测到 5210 端口已有实例并直接连上去。

## 验收（冒烟测试）

```powershell
# 需要先构建出可执行文件（cargo build --release 或 npm run build）
npm run smoke
```

`smoke` 会依次执行：

1. **smoke-boot**：启动 exe → 等进程出现 → 等窗口标题含 `PromptCut` → `GET http://127.0.0.1:5210/` 返回 200 → 检查 `/api/stt/status`（记录结果，不作为通过条件）→ 确认后代进程树含 `node.exe`
2. **smoke-shutdown**：`taskkill /F /T` 杀主进程 → 等 5 秒 → 确认进程树全部消失

> **注意**：导出冒烟（smoke-export）本轮未实现，`ALL_RESULT_JSON` 中标记为 `"export": "not-implemented"`。

## 给最终用户

### 安装

- 安装包未签名，首次运行会弹 Windows SmartScreen 提示。点击「更多信息」→「仍要运行」即可。
- 安装到 `%LOCALAPPDATA%\PromptCut`（当前用户），不需要管理员权限。

### 使用

- 导出的视频成品保存在 `%USERPROFILE%\Videos\PromptCut`。
- 语音识别的引擎和模型在首次使用时在线下载，保存在 `%APPDATA%\com.promptcut.desktop`。

### 端口 5210 被占

如果启动时弹「端口被占用」对话框：

```powershell
# 查看谁占了 5210
netstat -ano | findstr :5210
# 根据 PID 找到进程
tasklist /FI "PID eq <PID>"
```

关掉占用端口的程序后重新启动 PromptCut。

### 查看日志

菜单 → 帮助 → 查看运行日志。日志文件在 `%APPDATA%\com.promptcut.desktop\logs\sidecar.log`。

## 目录结构

```
desktop/
  package.json
  README.md
  THIRD-PARTY-LICENSES.md
  .gitignore
  ui/index.html                   启动等待页
  scripts/
    prepare-runtime.mjs           组装 runtime/
    prepare-python.mjs            组装内置 Python（由 python-runtime 任务提供）
    build-release.mjs             出一个版本：安装包 + 更新补丁
    make-patch.mjs                只打更新补丁
    apply-patch.ps1               补丁安装器（随补丁包发给用户，不在这里运行）
    apply-patch.cmd               补丁包里的「安装更新.cmd」
    smoke-procs.mjs               进程树工具（共用）
    smoke-boot.mjs                启动冒烟
    smoke-shutdown.mjs            关闭冒烟
    smoke-all.mjs                 全流程冒烟
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/default.json
    nsis/hooks.nsh
    src/main.rs
    src/lib.rs
    icons/icon-source.svg         图标源文件
    binaries/                     (git ignored) node sidecar
    runtime/                      (git ignored) 运行时组件
  release/                        (git ignored) 发布产物
    PromptCut-<版本>-setup.exe    完整安装包
    PromptCut-patch-<版本>.zip    更新补丁
    manifest-<版本>.json          该版本的文件清单，下一次发布拿它算差异
      app/                        PromptCut 源码副本 + node_modules + dist
      chrome/                     Chrome for Testing
      ffmpeg/                     ffmpeg.exe + ffprobe.exe
      python/                     内置 Python
      VERSIONS.json               各组件版本
```
