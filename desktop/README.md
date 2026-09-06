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

## 发布：安装包 + 更新补丁 + 拓展库包

日常改动绝大多数只落在 Node 那一半（`src/`、`server/`、`dist/`），Rust 壳和
Chrome / ffmpeg / Python 三个大块一动不动。完整安装包压出来 320 MB（装开约 1 GB），
而这些改动本身通常只有几 MB。加上可选能力那些几十 MB 的依赖和模型，一共三种产物：

```powershell
cd desktop
npm run release -- --from-head    # 推荐：源码取自 HEAD
npm run release                   # 源码取自当前工作区
```

`--from-head` 会先从 HEAD 开一棵临时 worktree 当源码，产物因此一定对应某个
commit，而不是把工作区里未提交的东西一起发出去（多人同时改一个工作区时尤其
要紧）。被排除的文件会在日志里逐条列出来。只有源码走 worktree，Chrome /
ffmpeg / Python / Rust 编译缓存还是用 `desktop/` 下原来那份，不会因此变慢。

| 产物                                     | 大小    | 什么时候用                                   |
| ---------------------------------------- | ------- | -------------------------------------------- |
| `release/PromptCut-<版本>-setup.exe`     | ~320 MB | 第一次安装；内核代次变了；补丁装不上时的兜底 |
| `release/PromptCut-patch-<版本>.exe`     | 几 MB起 | 已经装过，只是更新 Node 那半边               |
| `release/PromptCut-ext-<名字>-<版本>.exe` | 几十 MB | 可选能力（语音识别、镜头识别），按需装       |

前两个都是 exe，用户双击就装，不用先解压。补丁那个是 NSIS 自解压壳：把内容解到
`$PLUGINSDIR`（NSIS 退出时自动清，不会在 `%TEMP%` 留几百 MB 残骸），然后运行
`apply-patch.ps1`。它会核对安装位置和内核代次、关掉正在运行的程序（只认可执行
文件在目标目录下的那些）、备份当前版本再覆盖，逐个文件校验 SHA-256，任何一步
出错都回滚。`exports`（导出的视频）、`.pc-chats`（AI 会话历史）、
`%LOCALAPPDATA%\promptcut`（设置和密钥）和下载的语音模型都不在作用范围内。

补丁 exe 接受和脚本一样的参数，装在非默认位置时用得上：

```powershell
PromptCut-patch-0.2.3.exe -InstallDir "D:\PromptCut"
PromptCut-patch-0.2.3.exe -WhatIf          # 只检查，不写入
```

### 版本号怎么排

**两个版本号是分开的**，这正是补丁能成立的前提：

- **应用版本**（根 `package.json`）—— Node 那半边，补丁负责更新它。
- **外壳版本**（`src-tauri/tauri.conf.json`）—— 内核：Rust 外壳、Chrome、ffmpeg、
  内置 Python。这些东西只在完整安装包里，补丁碰不到。

写成 `0.<内核代次>.<修订>`，**中间那一位就是内核代次**：

| 改了什么 | 怎么进位 | 用户怎么升级 |
| --- | --- | --- |
| 只改 Node 那半边（界面、后端逻辑、依赖） | 应用版本末位 +1，如 `0.2.3 → 0.2.4` | 更新补丁 |
| 动了 Rust、Chrome、ffmpeg 或内置 Python | 两个版本号的**中间位**一起 +1，如 `0.2.x → 0.3.0` | 必须用完整安装包 |

所以一眼就能判断：**中间那位一样，补丁能用；不一样，得用完整安装包。**

补丁在 `patch.json` 里记下 `shellGeneration`（外壳版本的前两段，如 `0.2`）和
`minShellVersion`。安装时读已装 `promptcut.exe` 的 ProductVersion：代次不同直接
拒绝，代次相同但外壳比补丁要求的还旧也拒绝。两种情况都会告诉用户改用完整安装包，
并且不会动已装的任何东西。

**`minShellVersion` 是手写的门槛，不是「这次一起编的外壳版本」**（`make-patch.mjs`
顶部的 `MIN_SHELL_VERSION`）。这两件事分开：前者是 Node 这半边真正依赖的外壳能力，
后者只是发布时顺手一起编的。早先把两者当成一回事，结果外壳每动一次（哪怕只是加个
菜单项）就把所有老外壳的用户挡在补丁外面，逼他们下三百多 MB 的完整包只为换一个
11 MB 的 exe。只有当 Node 这半边**硬依赖**某个新外壳能力（缺了就报错或功能不可用）
才抬高它；「有了更好、没有也能降级」的不算。外壳换代时要把它挪到新代次的起点。

同一代次里外壳出了小修（Rust 改了但不影响 runtime 布局），只进外壳版本的末位，
之前的补丁照样能装。

**依赖变化**由 `package-lock.json` 的哈希自动判断：和上一次发布一致就不打包
`node_modules`（补丁几 MB），不一致就整个带上（本例 48 MB，仍远小于完整包）。
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
release\PromptCut-patch-0.2.3.exe -WhatIf
```

### 拓展库包

语音识别和镜头识别要额外的 Python 依赖和模型。默认是运行时 `pip install` 现下载，
断网、内网或者国内网络不通就装不上，而且每台机器都要重下一遍。拓展库包把 wheel
和模型预先打好，**安装过程全程离线**（`pip --no-index`，明确禁掉 PyPI）。

```powershell
npm run make-extension -- shots --model <transnetv2.onnx 的路径>
npm run make-extension -- stt
```

`transnetv2.onnx` 怎么来见 [`tools/transnetv2/README.md`](../tools/transnetv2/README.md)。
产物约 52 MB（26 MB wheel + 30 MB 模型）。

几个要点：

- **wheel 用自带解释器 `pip download`**，不是开发机的 Python。wheel 的 ABI 标签
  （`cp311`）必须和用户机器上那个解释器对得上，否则装上去 import 不了。
- **拓展只带依赖和模型，用到它们的代码在应用里**。所以每个拓展声明 `requiresApp`，
  安装器读 `runtime/VERSIONS.json` 比对，版本太旧**在动手之前**就拒绝——不然用户
  白等一分钟，盘上还多出一堆没人用的 wheel。
- **模型落在 `%APPDATA%\com.promptcut.desktop\models`**，不在安装目录里，卸载软件
  不会把它删掉。依赖落在 `<安装目录>\runtime\pylibs`。
- 装完会让程序自己跑一次 `status` 自检，**只有它回报 `ready: true` 才算成功**；
  文件到位但代码不认，同样算失败。

拓展有自己的版本号，和应用版本、外壳版本三者独立。

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
    patch-installer.nsi           补丁 exe 的自解压外壳(NSIS,须带 UTF-8 BOM)
    make-extension.mjs            打拓展库包(离线依赖 + 模型)
    apply-extension.ps1           拓展包安装器(随包发给用户)
    extension-installer.nsi       拓展 exe 的自解压外壳(同样须带 BOM)
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
      app/                        PromptCut 源码副本 + node_modules + dist
      chrome/                     Chrome for Testing
      ffmpeg/                     ffmpeg.exe + ffprobe.exe
      python/                     内置 Python
      VERSIONS.json               各组件版本
  release/                        (git ignored) 发布产物
    PromptCut-<版本>-setup.exe    完整安装包
    PromptCut-patch-<版本>.exe    更新补丁(双击即装)
    manifest-<版本>.json          该版本的文件清单，下一次发布拿它算差异
    PromptCut-ext-<名字>-<版本>.exe  拓展库包
    ext-<名字>-<版本>.json        拓展包清单
```
