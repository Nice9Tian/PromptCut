"""faster-whisper 引擎（CTranslate2 后端）。

默认引擎。CPU 上用 int8 量化，不需要 torch，装机体积比 openai-whisper 小很多。
"""

from __future__ import annotations

import importlib.util
from typing import Any, Callable, Dict, List, Optional

from . import EngineNotInstalled, resolve_device

ENGINE_NAME = "faster-whisper"

_MODULE = "faster_whisper"
_DIST = "faster-whisper"


def probe() -> Dict[str, Any]:
    """探测安装状态。任何异常都要吞掉——status 子命令必须永远能成功返回。"""
    result: Dict[str, Any] = {"installed": False, "version": None, "error": None}
    try:
        if importlib.util.find_spec(_MODULE) is None:
            result["error"] = f"未找到模块 {_MODULE}"
            return result
    except Exception as exc:  # find_spec 也可能因为 sys.path 上有坏包而抛
        result["error"] = f"探测 {_MODULE} 失败：{exc}"
        return result

    try:
        module = __import__(_MODULE)
        result["installed"] = True
        version = getattr(module, "__version__", None)
        if not version:
            try:
                from importlib.metadata import version as dist_version

                version = dist_version(_DIST)
            except Exception:
                version = None
        result["version"] = version
    except Exception as exc:
        result["error"] = f"导入 {_MODULE} 失败：{exc}"
    return result


def _load():
    try:
        from faster_whisper import WhisperModel  # type: ignore

        return WhisperModel
    except ImportError as exc:
        raise EngineNotInstalled(
            "faster-whisper 未安装。请先运行 install --engine faster-whisper"
            "（或在界面上点「下载引擎」）。"
        ) from exc


def transcribe(
    wav_path: str,
    model: str,
    language: Optional[str],
    device: Optional[str],
    models_dir: Optional[str],
    on_segment: Callable[[Dict[str, Any]], None],
    on_progress: Callable[[float, Optional[float]], None],
) -> Dict[str, Any]:
    WhisperModel = _load()
    dev, compute_type = resolve_device(device)

    whisper_model = WhisperModel(
        model,
        device=dev,
        compute_type=compute_type,
        download_root=models_dir,
    )

    kwargs: Dict[str, Any] = {"beam_size": 5, "vad_filter": False}
    # language 为空表示自动检测：不传这个参数，让引擎自己判断。
    if language:
        kwargs["language"] = language

    segments_iter, info = whisper_model.transcribe(wav_path, **kwargs)

    total = getattr(info, "duration", None)
    total = float(total) if total else None

    collected: List[Dict[str, Any]] = []
    # segments 是惰性生成器：真正的解码发生在遍历时，所以进度事件必须在这个
    # 循环里发，不能等它跑完。
    for item in segments_iter:
        seg = {
            "start": float(item.start),
            "end": float(item.end),
            "text": (item.text or "").strip(),
        }
        collected.append(seg)
        on_segment(seg)
        on_progress(seg["end"], total)

    return {
        "segments": collected,
        "language": getattr(info, "language", None) or language,
        "duration": total,
    }
