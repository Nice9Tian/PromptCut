# PromptCut 桌面壳 · 设计契约(第三阶段)

先读 DESIGN.md、EDITOR-DESIGN.md。本文只讲桌面壳、内置 Python 和语音转文字。改契约先改这里,再改代码。

## 目标

把 PromptCut(Vite + React 编辑器,后端就是 vite.config.ts 里的几个插件:AI 桥、导出、语音转文字)连同
**Node、Chrome for Testing、ffmpeg、Python** 打成一个 Windows x64 NSIS 安装包。用户双击安装、双击图标得到独立窗口(WebView2),
不需要装 Node、浏览器或 Python。

语音转文字(STT)跑在**随包分发的内置 Python** 上,永远不用系统里的 Python;Whisper 系列的库和模型体积大,**首次使用时在线下载**到用户数据目录。

只做 Windows x64,不签名,不做自动更新。

## 目录约定

```
desktop/
  package.json                 脚本入口:prepare-runtime / prepare-python / build / smoke
  DESIGN.md → 见本文
  README.md                    构建步骤、首次运行说明、第三方许可
  ui/index.html                启动等待页(纯静态)
  scripts/prepare-runtime.mjs  组装 runtime/(app + node sidecar + chrome + ffmpeg),幂等
  scripts/prepare-python.mjs   下载并组装 runtime/python/(见「内置 Python」)
  scripts/smoke-*.mjs          启动 / 导出 / STT / 关闭 的烟测
  src-tauri/
    Cargo.toml  build.rs  tauri.conf.json  capabilities/default.json  nsis/hooks.nsh
    src/main.rs  src/lib.rs
    icons/
    binaries/node-x86_64-pc-windows-msvc.exe   (sidecar,不进 git)
    runtime/                                    (不进 git)
      app/        PromptCut 源码副本(含 node_modules、dist)
      chrome/     PUPPETEER_CACHE_DIR 结构
      ffmpeg/     ffmpeg.exe ffprobe.exe + LICENSE
      python/     内置 Python(见下)
      VERSIONS.json  {"node","chrome","ffmpeg","python","app","builtAt"}
python/
  promptcut_stt/               我们自己的 STT 包(纯 Python,随包分发,放进 runtime/python/Lib/site-packages 或 PYTHONPATH)
  requirements-faster-whisper.txt
  requirements-whisper.txt
  README.md
server/vite-plugin-stt.ts      dev server 里的 STT 接口(桌面版里 node sidecar 跑的就是同一个 vite,所以同一份代码)
```

`tauri.conf.json`:`productName: "PromptCut"`,`identifier: "com.promptcut.desktop"`,`bundle.externalBin: ["binaries/node"]`,
`bundle.resources: {"runtime/": "runtime/"}`,`frontendDist: "../ui"`,NSIS `installMode: "currentUser"`,语言 `SimpChinese` + `English`。
开发期例外:环境变量 `PROMPTCUT_RUNTIME_DIR` 存在时直接用它当 runtime 目录。

## 运行时环境(Rust → node sidecar → 子进程全部继承)

| 项 | 值 |
|---|---|
| 可执行 | sidecar `node` |
| 参数 | `<runtime>/app/node_modules/vite/bin/vite.js --port 5210 --strictPort --host 127.0.0.1` |
| cwd | `<runtime>/app` |
| `PATH` | `<runtime>/ffmpeg;<runtime>/python;<runtime>/python/Scripts;<sidecar 目录>;` + 原 PATH |
| `PUPPETEER_CACHE_DIR` | `<runtime>/chrome` |
| `BROWSER` | `none` |
| `PROMPTCUT_EXPORT_DIR` | `%USERPROFILE%\Videos\PromptCut` |
| `PROMPTCUT_PYTHON` | `<runtime>/python/python.exe`(**唯一**允许使用的解释器;没有这个变量时 vite 插件退回 `python/` 目录下的开发期约定,见下) |
| `PROMPTCUT_PYLIBS` | `<app_data_dir>/pylibs`(在线下载的第三方库装到这里,安装目录保持只读) |
| `PROMPTCUT_MODELS` | `<app_data_dir>/models`(Whisper 模型权重) |
| `PROMPTCUT_DATA_DIR` | `<app_data_dir>`(`app.path().app_data_dir()`,一般在 `%APPDATA%\com.promptcut.desktop`) |
| stdout/stderr | 追加写 `<app_log_dir>/sidecar.log` |

端口 **5210**(开发期的 5190–5199 都是各任务自己的 dev server,打包版不能撞上)。

## Rust 行为(desktop/src-tauri)

1. 单实例(`tauri-plugin-single-instance`)。
2. 端口检查:能连 `127.0.0.1:5210` 且 GET `/` 含 `PromptCut` → 复用已有实例;含别的 → 原生对话框「端口被占」退出。
3. 起 sidecar(上表环境);日志落盘。
4. 立刻显示等待页 `ui/index.html`;每 250ms 轮询,GET `/` 返回 200 后导航到 `http://127.0.0.1:5210/`。90 秒超时显示失败原因和日志路径。
5. 窗口:标题 `PromptCut`,1600×960,最小 1200×720,记住尺寸(`tauri-plugin-window-state`)。
6. 原生菜单:文件(打开导出文件夹 / 打开数据目录 / 退出)、工具(**语音识别引擎**:打开 `<app_data_dir>/pylibs` 和模型目录;**重置 Python 库**:删 pylibs 后提示重新下载)、帮助(查看日志 / 关于:壳版本 + VERSIONS.json 各组件版本 + Python 版本)。
7. 退出:`taskkill /F /T /PID <sidecar>`(`/T` 必须:导出时下面挂着 Chrome,转写时挂着 Python)。
8. 外链走系统浏览器(`tauri-plugin-opener`)。**不装 `tauri-plugin-dialog`**(它改写 window.alert/confirm 且被 ACL 拒);原生提示框用 `rfd`。
9. 编辑器地址写 `127.0.0.1` 不写 `localhost`。
10. Python 由 **node 侧按需 spawn**,Rust 不常驻 Python 进程、不链接 libpython。原因:torch/CUDA 的 DLL 装载放进壳进程里既脆弱又杀不掉;子进程随时可以 kill,崩了不带走窗口。「内置」的含义是:解释器随包分发、隔离模式启动、只认 `PROMPTCUT_PYLIBS`,系统 Python 与其 site-packages 一律不可见。

crate:`tauri = "2"`、`tauri-build = "2"`、`tauri-plugin-shell`、`tauri-plugin-single-instance`、`tauri-plugin-opener`、`tauri-plugin-window-state`、`rfd = "0.16"`、`serde`、`serde_json`。

## 内置 Python(desktop/scripts/prepare-python.mjs)

- 来源:python.org 的 **Windows embeddable package**(`python-3.11.x-embed-amd64.zip`,约 11MB),下载到 `runtime/python/`。版本号写在脚本顶部常量,`VERSIONS.json.python` 记录。
- 改 `python311._pth`:保留 `python311.zip` 和 `.`,追加 `Lib\site-packages`,并 **`import site`** 取消注释(否则 `.pth` 和 site-packages 都不生效)。
- 装 pip:下载 `get-pip.py` 用内置解释器执行一次,得到 `Lib/site-packages/pip`(打包时就带上 pip,用户离线也能看到「未安装」状态,在线时才能装库)。
- 把 `python/promptcut_stt/` 复制进 `runtime/python/Lib/site-packages/promptcut_stt/`。
- 幂等:已存在且版本一致就跳过;`--check` 只校验。
- **不预装** faster-whisper / whisper / torch:这些由用户首次使用时在线装到 `PROMPTCUT_PYLIBS`。
- 启动方式统一为:`<PROMPTCUT_PYTHON> -I -m promptcut_stt <子命令>`,环境变量 `PROMPTCUT_PYLIBS=<库目录>`、`PYTHONUTF8=1`。
- **第三方库怎么进 sys.path(2026-09-06 实测修正)**:embeddable 包只要有 `._pth` 就完全接管路径计算,`PYTHONPATH` 被忽略;`-I` 又等于 `-E -s`,把全部 `PYTHON*` 变量都忽略。所以 **`PYTHONPATH` 对内置解释器无效,不要用它**。生效机制是 `prepare-python.mjs` 写进 `Lib/site-packages/promptcut_pylibs.pth` 的一个 site 钩子:启动时读 `PROMPTCUT_PYLIBS`(支持 `;` 分隔多个目录),把存在的目录追加到 `sys.path` 末尾。对 `-m promptcut_stt`、`-m pip`、`-c` 所有入口一致生效。
- 开发期 `promptcut_stt` 还没复制进 site-packages 时,把源码目录也放进 `PROMPTCUT_PYLIBS`:`PROMPTCUT_PYLIBS=<工作目录>\python;<工作目录>\out\pylibs`。

开发期(没有安装包时)约定:`PROMPTCUT_PYTHON` 没设时,vite 插件依次找 `desktop/src-tauri/runtime/python/python.exe`、`python/.venv/Scripts/python.exe`;都没有就报「内置 Python 未就绪,先跑 `npm run prepare-python`」。**永远不回退到 PATH 里的 python。**

## STT 包(python/promptcut_stt)

纯 Python,依赖只有标准库;第三方引擎按需 import。子命令(全部输出 **一行一个 JSON**,便于 node 逐行解析):

| 子命令 | 作用 | 输出 |
|---|---|---|
| `status` | 报告 Python 版本、`PROMPTCUT_PYLIBS` 是否可写、两种引擎是否已装(`import faster_whisper` / `import whisper` 成功与否)、CUDA 是否可用(`torch.cuda.is_available()`,没 torch 就 false)、已下载的模型清单 | `{"python":..., "engines":{"faster-whisper":{"installed":bool,"version":...},"whisper":{...}}, "cuda":bool, "models":[...]}` |
| `install --engine faster-whisper\|whisper [--index-url ...]` | 用 `pip install --target <PROMPTCUT_PYLIBS>`(或 `--prefix`,以能被 PYTHONPATH 找到为准)装对应 requirements 文件;逐行转发 pip 输出成 `{"event":"log","line":...}`,结束 `{"event":"done"}` 或 `{"event":"error","message":...}` | 流 |
| `transcribe --input <媒体或 wav> --engine <e> --model <m> [--language zh] [--device auto\|cpu\|cuda] [--out <json 路径>]` | 输入不是 16k 单声道 wav 就先用 PATH 上的 ffmpeg 抽成临时 wav;模型不在 `PROMPTCUT_MODELS` 就下载(faster-whisper 用 `download_root`,whisper 用 `download_root`);逐段输出 `{"event":"segment","start":..,"end":..,"text":..}` 和 `{"event":"progress","done":秒,"total":秒}`,结束 `{"event":"done","segments":[...],"language":...,"engine":...,"model":...}` | 流 |
| `models` | 列可选模型(faster-whisper:tiny/base/small/medium/large-v3 及 `-int8` 说明;whisper:tiny…large)和各自大约体积 | JSON |

默认引擎 `faster-whisper`、默认模型 `small`(CPU int8 能跑);`device=auto` 时有 CUDA 用 cuda float16,否则 cpu int8。
所有 stderr 也要有意义(pip 失败原因、缺 ffmpeg),node 侧原样转发到界面。

## STT 接口(server/vite-plugin-stt.ts)与 MCP 工具

vite 插件(独立文件,vite.config.ts 只加一行):

- `GET /api/stt/status` → 转发 `status`
- `POST /api/stt/install {engine}` → SSE 流转发 `install`
- `POST /api/stt/transcribe {mediaUrl 或上传的文件, engine, model, language}` → 先把浏览器里的 blob 素材上传到 `<PROMPTCUT_DATA_DIR 或 out>/stt/<id>/input.<ext>`(复用导出插件的上传方式),再 SSE 流转发 `transcribe`;`done` 事件带全部 segments。
- 每个 job 有 id,`DELETE /api/stt/job/<id>` 杀掉 Python 子进程。
- Python 路径解析规则见「内置 Python」;找不到时接口返回 503 和人话提示。

编辑器侧:

- 文档模型加 `MediaAsset.transcript?: { engine, model, language, segments: {start,end,text}[] }`,store 加 `actions.setMediaTranscript(mediaId, transcript)`(**壳负责人已加**,见 src/kernel/project.ts、src/store/project.ts)。
- 左栏媒体条目加「转写」按钮:弹小面板选引擎/模型/语言,未安装引擎时先显示「下载引擎」按钮并流式显示 pip 日志;转写进度条;完成后写进 store。
- MCP 工具(server/mcp-tools.mjs + src/ai/mcpExecutor.ts + src/editor/right/index.tsx 的 EditorApi):
  - `stt_status()` → 同 /api/stt/status
  - `stt_install(engine)` → 阻塞到装完,返回结果摘要(日志尾 20 行)
  - `transcribe_media(mediaId, engine?, model?, language?)` → 转写并写入 store,返回 segments(超过 200 段时返回前 200 段 + 总数)
  - `get_transcript(mediaId)` → 从 store 读
  - 系统提示词里说明:拿到 transcript 后可以用 `caption-track`(字幕卡)或按段落生成动效卡。
- 这些工具在浏览器里执行(和其他工具一样走 mcpExecutor),由浏览器 fetch `/api/stt/*`。

## 组装与验收

1. `cd desktop && npm run prepare-runtime && npm run prepare-python && npm run build`。
2. 跑 `src-tauri/target/release/promptcut.exe`:窗口 10 秒内切到编辑器;`curl http://127.0.0.1:5210/` 有 HTML;进程树里有 node;`GET /api/stt/status` 返回内置 Python 的版本且 `engines.*.installed=false`(干净机器)。
3. 在线机器上:界面点「下载引擎」→ faster-whisper 装进 `%APPDATA%\com.promptcut.desktop\pylibs`;导入一个带人声的 mp4 → 转写 → 字幕段落出现在 store;MCP 工具 `transcribe_media` 同样能跑。
4. 关闭窗口后无残留 node / chrome / python。
5. NSIS 包装到临时目录跑一遍同样检查再卸载;卸载钩子删 `runtime\app\node_modules\.vite` 等缓存,**不删** `%APPDATA%` 里的 pylibs 和 models(用户可能还要用;「重置」菜单项负责删)。
6. 结果写 `desktop/BUILD-REPORT.md`。

## 不做的事

- 不做 macOS / Linux;不签名;不自动更新。
- 不把 whisper / torch / 模型打进安装包。
- 不把导出产物放进安装目录。
