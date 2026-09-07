# PromptCut 的 Python 侧

这个目录下的包，都跑在随包分发的内置 Python 上，输出都是 JSONL（一行一个 JSON），
本体都只依赖标准库 + numpy，重依赖按需 import，没装就在 `status` 里如实报告：

| 包 | 干什么 | 重依赖 | 随拓展包发的权重 |
|---|---|---|---|
| `promptcut_stt` | 语音转文字（本文其余部分讲的就是它） | faster-whisper 或 openai-whisper | 无，模型按需下载 |
| `promptcut_shots` | 镜头切换识别 | onnxruntime | `transnetv2.onnx` |
| `promptcut_subject` | 主体检测：人脸 / 人体 / 开放词汇，告诉 AI 卡片该躲开哪块 | light 档 onnxruntime；full 档 torch + transformers | `yunet.onnx`、`rtdetr_r18vd.onnx`、`grounding-dino-tiny/` |
| `promptcut_track` | 运动追踪（任意点） | torch | `bootstapir_v2.pt` |

权重不随安装包发，由**拓展库包**离线送达（轻装档 / 完整档两档，见
[`desktop/README.md`](../desktop/README.md) 的「拓展库包」一节）；没装拓展时
每个包各有自己的兜底档。

---

## promptcut_stt · 语音转文字

PromptCut 的语音转文字包。纯 Python，**本体只依赖标准库**，两个转写引擎按需 import——
没装就在 `status` 里报 `installed: false`，`transcribe` 时给一句人话错误，不会抛堆栈。

跑在随包分发的内置 Python 上（`desktop/src-tauri/runtime/python/python.exe`），
永远不使用系统里的 Python。第三方库和模型权重体积大，首次使用时在线下载到用户数据目录。

所有子命令的正常输出都是**一行一个 JSON**（JSONL），每行写完立刻 flush，
供 node 侧逐行解析。人话提示（缺 ffmpeg、pip 失败原因等）走 stderr。

```
python/
  promptcut_stt/
    __init__.py                    版本号
    __main__.py                    argparse 入口：status / models / install / transcribe
    jsonl.py                       一行一个 JSON 的输出工具
    audio.py                       ffmpeg 抽 16 kHz 单声道 wav
    engines/
      __init__.py                  EngineNotInstalled、resolve_device、cuda_available
      faster_whisper_engine.py     默认引擎（CTranslate2 后端，不需要 torch）
      whisper_engine.py            备选引擎（PyTorch 后端）
  requirements-faster-whisper.txt
  requirements-whisper.txt
  tests/                           标准库 unittest
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `PROMPTCUT_PYLIBS` | 第三方库的安装目录。`install` 的 `--target`；`transcribe`/`status` 启动时会把它插到 `sys.path` 最前面。**未设置时 `install` 直接报错。** |
| `PROMPTCUT_MODELS` | 模型权重的下载目录（引擎的 `download_root`）。 |
| `PROMPTCUT_DATA_DIR` | 兜底：没设 `PROMPTCUT_MODELS` 时用 `<PROMPTCUT_DATA_DIR>/models`。两个都没设就落到系统临时目录，并在 stderr 提醒一句。 |

## 启动方式

包装进 `runtime/python/Lib/site-packages/` 之后：

```
<PROMPTCUT_PYTHON> -I -m promptcut_stt <子命令>
```

`-I` 是隔离模式，忽略当前目录和用户 site。

> **注意 `-I` 与 `PYTHONPATH`**：CPython 的 `-I` 隐含 `-E`，会忽略**包括 `PYTHONPATH` 在内**的所有
> `PYTHON*` 环境变量。所以：
> 1. `PROMPTCUT_PYLIBS` 不能只靠 `PYTHONPATH` 传进来——本包在 `status` / `transcribe` 启动时
>    会自己读这个环境变量并 `sys.path.insert(0, ...)`，隔离模式下依然生效；
> 2. **开发期**（包还在源码树里、没复制进 site-packages）不能用 `-I -m promptcut_stt`，
>    要用 runpy 引导，既保住隔离又能定位到源码：
>
> ```
> <PROMPTCUT_PYTHON> -I -c "import sys,runpy; sys.path.insert(0, r'<repo>\python'); runpy.run_module('promptcut_stt', run_name='__main__', alter_sys=True)" status
> ```

## 子命令

### `status`

报告解释器版本、`PROMPTCUT_PYLIBS` 是否可写、两个引擎是否已装、CUDA 是否可用、
已下载的模型清单、ffmpeg 位置。**什么都没装的时候也必须成功退出 0**，只是 `installed` 全为 false。

```json
{"python": "3.11.9", "executable": "...\\runtime\\python\\python.exe", "package": "0.1.0",
 "pylibs": {"path": "...\\pylibs", "exists": true, "writable": true},
 "models_dir": "...\\models",
 "engines": {"faster-whisper": {"installed": false, "version": null, "error": "未找到模块 faster_whisper"},
             "whisper": {"installed": false, "version": null, "error": "未找到模块 whisper"}},
 "cuda": false, "models": [],
 "ffmpeg": "...\\ffmpeg.EXE"}
```

装好引擎、下载过模型之后：

```json
{"python": "3.11.9", "...": "...",
 "engines": {"faster-whisper": {"installed": true, "version": "1.2.1", "error": null},
             "whisper": {"installed": false, "version": null, "error": "未找到模块 whisper"}},
 "cuda": false,
 "models": [{"name": "models--Systran--faster-whisper-small", "path": "...", "bytes": 486213279}]}
```

### `models`

列可选模型和大致体积，不联网。

```json
{"default_engine": "faster-whisper",
 "engines": {"faster-whisper": {"default": "small",
              "models": [{"name": "tiny", "size": "约 75 MB", "note": "最快，准确率最低，适合快速预览"},
                         {"name": "small", "size": "约 480 MB", "note": "默认；CPU int8 下接近实时，中文可用"},
                         {"name": "large-v3", "size": "约 3.1 GB", "note": "最准；建议配 CUDA，显存约 5 GB"}],
              "note": "CPU 上默认用 int8 量化…"},
             "whisper": {"default": "small", "models": [...], "note": "依赖 PyTorch…"}}}
```

### `install --engine faster-whisper|whisper [--index-url URL] [--extra-index-url URL] [--upgrade]`

用**内置解释器自己的 pip**（`sys.executable -m pip`，绝不写死 `python`）把对应
requirements 装到 `PROMPTCUT_PYLIBS`：

```
<sys.executable> -m pip install --target <PROMPTCUT_PYLIBS> -r <requirements>
```

pip 的每一行输出转成一个 `log` 事件转发出去：

```json
{"event": "start", "engine": "faster-whisper", "target": "...\\pylibs", "requirements": "...\\requirements-faster-whisper.txt", "command": ["...python.exe", "-m", "pip", "install", "--target", "...", "-r", "..."]}
{"event": "log", "line": "Collecting faster-whisper>=1.0.3 (from -r ... (line 3))"}
{"event": "log", "line": "Successfully installed anyio-4.15.1 av-18.1.0 ... faster-whisper-1.2.1 ..."}
{"event": "done", "engine": "faster-whisper", "target": "...\\pylibs", "seconds": 7.7}
```

失败时最后一行是 `{"event":"error","message":"pip 安装失败（退出码 1）…","code":1}`，退出码 1。
`PROMPTCUT_PYLIBS` 没设置时直接报错，不会退回任何默认目录。

### `transcribe --input <媒体> [--engine …] [--model …] [--language zh] [--device auto|cpu|cuda] [--out <json>]`

默认 `--engine faster-whisper --model small --language zh --device auto`。
`--language auto` 或空串表示自动检测。输入不是 16 kHz 单声道 wav 就先用 PATH 上的 ffmpeg
抽一个临时 wav（用完自动删）。模型不在 `PROMPTCUT_MODELS` 里就下载到那儿。

```json
{"event": "start", "engine": "faster-whisper", "model": "small", "language": "zh", "device": "auto", "input": "...\\tts-zh.wav", "models_dir": "...\\models"}
{"event": "audio", "wav": "...\\Temp\\promptcut-stt-aai1xfib\\input-16k.wav", "duration": 5.883813, "converted": true}
{"event": "segment", "index": 0, "start": 0.0, "end": 2.04, "text": "欢迎使用PromptCut"}
{"event": "progress", "done": 2.04, "total": 5.8838125}
{"event": "segment", "index": 1, "start": 2.56, "end": 5.12, "text": "这是一段语音识别测试"}
{"event": "progress", "done": 5.12, "total": 5.8838125}
{"event": "done", "segments": [{"start": 0.0, "end": 2.04, "text": "欢迎使用PromptCut"}, {"start": 2.56, "end": 5.12, "text": "这是一段语音识别测试"}], "text": "欢迎使用PromptCut这是一段语音识别测试", "language": "zh", "engine": "faster-whisper", "model": "small", "duration": 5.8838125, "seconds": 19.4}
```

`--out` 给了就把 `done` 那个对象另存成缩进过的 JSON 文件，并在 `done` 事件里加一个 `"out"` 字段。

`device=auto` 的解析在 `engines/__init__.py::resolve_device`：探到 CUDA 就 `cuda` + `float16`，
否则 `cpu` + `int8`。探测 CUDA 需要 torch，没有 torch 就静默按 CPU 处理——
faster-whisper 走 CTranslate2，本来就不需要 torch，不能让一个可选依赖挡住转写。

## 两个 requirements 的区别

| | faster-whisper | whisper |
|---|---|---|
| 后端 | CTranslate2 | PyTorch |
| 需要 torch | 否 | 是 |
| 安装体积 | 约 270 MB | 约 1 GB 起（CPU 版 torch） |
| CPU 速度 | int8 量化，约 2 倍实时 | 明显更慢 |

`requirements-whisper.txt` 第一行是：

```
--extra-index-url https://download.pytorch.org/whl/cpu
```

用 `--extra-index-url` 而不是 `--index-url`：默认 PyPI 仍然可用，`openai-whisper`
这些只在 PyPI 上的包才能正常装到；torch 则从 PyTorch 官方 CPU 索引取（约 200 MB，
而 PyPI 上的 Windows 轮子带 CUDA，约 2.5 GB）。

**要 GPU 版 torch**，二选一：

1. 把那一行换成对应 CUDA 版本的索引，例如 `--extra-index-url https://download.pytorch.org/whl/cu121`；
2. 或者装完之后单独升级：
   ```
   <PROMPTCUT_PYTHON> -m pip install --target <PROMPTCUT_PYLIBS> --upgrade \
       --extra-index-url https://download.pytorch.org/whl/cu121 torch
   ```
   也可以走子命令：`install --engine whisper --extra-index-url https://download.pytorch.org/whl/cu121 --upgrade`。

faster-whisper 侧要用 GPU 则另外需要 cuBLAS 和 cuDNN 运行库，装好后
`--device cuda`（或 `auto` 探到 CUDA）会自动切 float16。

## 跑单元测试

标准库 unittest，不联网，也不要求引擎已安装（`test_audio` 在没有 ffmpeg 时自动跳过）：

```
cd python
<PROMPTCUT_PYTHON> -I -m unittest discover -s tests -t . -v
```

- `test_jsonl.py` —— 每次输出恰好一行、中文不被转义成 `\uXXXX`、事件字段形状、多行消息仍是一行。
- `test_status.py` —— 用子进程真跑 `status` / `models` / `install` / `transcribe`，
  断言退出码、stdout 恰好一行、契约字段齐全；引擎没装时 `status` 仍然退出 0。
- `test_audio.py` —— 用 ffmpeg 现造一段 2 秒 440 Hz 正弦波 mp4，抽成 wav 后校验
  单声道 / 16000 Hz / 16-bit / 时长约 2 秒；坏文件要抛 `AudioExtractError` 而不是崩。

## 验证记录

2026-09-06，Windows 11 x64，内置解释器 `desktop/src-tauri/runtime/python/python.exe`
（CPython 3.11.9，pip 26.2.1），ffmpeg 9.0.1，无 CUDA（纯 CPU）。
环境：`PROMPTCUT_PYLIBS=out/pylibs`、`PROMPTCUT_MODELS=out/models`。

**单元测试**：`Ran 16 tests ... OK`（16 项全通过，0 跳过，0.6 秒）。

**status（安装前）**：退出 0，一行 JSON，`faster-whisper` 与 `whisper` 的
`installed` 均为 `false`，`error` 为「未找到模块 …」，`cuda: false`，`models: []`，
`pylibs.writable: true`，`ffmpeg` 指向 PATH 上的 ffmpeg。

**install --engine faster-whisper**：退出 0，78 行 JSONL（1 个 start + 76 个 log + 1 个 done），
耗时 **7.7 秒**，`out/pylibs` 体积 **272 MB**。
装到的版本：faster-whisper 1.2.1、ctranslate2 4.8.2、onnxruntime 1.29.0、av 18.1.0、
huggingface-hub 1.30.0、tokenizers 0.23.2、numpy 2.4.6。装完 `status` 里
`faster-whisper.installed` 变为 `true`、`version` 为 `1.2.1`。

**测试音频**：Windows 自带语音合成（`System.Speech`，中文语音 Microsoft Huihui Desktop，zh-CN）
生成 `out/tts-zh.wav`（253 KB，5.88 秒），朗读文本
「欢迎使用 PromptCut，这是一段语音识别测试。」

**transcribe --engine faster-whisper --model small --language zh --device auto**：退出 0。

- 识别文本：**「欢迎使用PromptCut」「这是一段语音识别测试」**（2 段，与原文一致；
  标点由模型自行判断，段间空格未保留）
- 时间轴：`0.00–2.04` / `2.56–5.12`
- 首次运行 **19.4 秒**（含模型下载）；模型缓存后重跑 **2.9 秒**（5.88 秒音频，约 2 倍实时，纯 CPU int8）
- 模型下载体积：`out/models` **464 MiB**（`models--Systran--faster-whisper-small`，486,213,279 字节）
- `--out` 写出的 `out/tts-zh.json` 与 `done` 事件内容一致

**已知提示（不影响结果）**：huggingface-hub 在 Windows 非开发者模式下不能建符号链接，
会 warn 一句「caching files will still work but in a degraded version」，只是缓存多占些磁盘；
另有一句未设 `HF_TOKEN` 的匿名下载限速提醒。两条都在 stderr，属正常现象。
