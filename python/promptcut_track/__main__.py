"""命令行入口：python -m promptcut_track <子命令>

子命令：status / install / track
输出约定和 promptcut_stt、promptcut_shots 一致：stdout 一行一个 JSON，
stderr 是给人看的提示。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional

# 复用听写那套 JSONL：Windows 控制台的 UTF-8 和换行处理有坑，只想维护一份。
from promptcut_stt.jsonl import emit, emit_error, emit_log

from . import __version__
from .tracker import MODEL_FILENAME

REQUIREMENTS = "requirements-track.txt"


def env_paths() -> Dict[str, Optional[str]]:
    return {
        "pylibs": os.environ.get("PROMPTCUT_PYLIBS") or None,
        "models": os.environ.get("PROMPTCUT_MODELS") or None,
        "data_dir": os.environ.get("PROMPTCUT_DATA_DIR") or None,
        "ffmpeg": os.environ.get("PROMPTCUT_FFMPEG") or shutil.which("ffmpeg"),
    }


def models_dir(paths: Dict[str, Optional[str]]) -> str:
    if paths["models"]:
        return paths["models"]
    if paths["data_dir"]:
        return os.path.join(paths["data_dir"], "models")
    return os.path.join(os.path.expanduser("~"), ".promptcut", "models")


def add_pylibs(pylibs: Optional[str]) -> None:
    if pylibs and os.path.isdir(pylibs) and pylibs not in sys.path:
        sys.path.insert(0, pylibs)


def model_path(paths: Dict[str, Optional[str]]) -> str:
    return os.path.join(models_dir(paths), MODEL_FILENAME)


def probe(paths: Dict[str, Optional[str]]) -> Dict[str, Any]:
    """报告能不能跑。两个条件缺一不可：torch 装了，权重文件在。"""
    add_pylibs(paths["pylibs"])
    runtime: Dict[str, Any] = {"installed": False, "version": None}
    try:
        import torch  # noqa: F401

        runtime = {"installed": True, "version": torch.__version__}
    except Exception as exc:
        runtime["error"] = str(exc)

    mp = model_path(paths)
    model = {"path": mp, "exists": os.path.isfile(mp)}
    if model["exists"]:
        model["bytes"] = os.path.getsize(mp)

    return {
        "ready": bool(runtime["installed"] and model["exists"]),
        "runtime": runtime,
        "model": model,
        "ffmpeg": paths["ffmpeg"],
    }


def cmd_status(_args: argparse.Namespace) -> int:
    info = probe(env_paths())
    emit({"event": "status", "version": __version__, **info})
    return 0


def cmd_install(_args: argparse.Namespace) -> int:
    paths = env_paths()
    target = paths["pylibs"]
    if not target:
        emit_error("没有设置 PROMPTCUT_PYLIBS，不知道该把依赖装到哪。")
        return 2

    req = os.path.join(os.path.dirname(os.path.abspath(__file__)), REQUIREMENTS)
    if not os.path.isfile(req):
        emit_error(f"找不到依赖清单 {REQUIREMENTS}")
        return 2

    os.makedirs(target, exist_ok=True)
    # 必须用 sys.executable —— 内置解释器自己的 pip。写死 "python" 会打到系统里
    cmd = [sys.executable, "-m", "pip", "install", "--target", target, "-r", req]
    emit({"event": "log", "line": " ".join(cmd)})

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
    except OSError as exc:
        emit_error(f"无法启动 pip：{exc}")
        return 2

    assert proc.stdout is not None
    for line in proc.stdout:
        emit_log(line.rstrip())
    code = proc.wait()
    if code != 0:
        emit_error(
            f"pip 安装失败（退出码 {code}）。torch 有 190 MB 以上，"
            "常见原因是网络中断或磁盘空间不足。"
        )
        return 1

    info = probe(paths)
    emit({"event": "installed", **info})
    return 0 if info["ready"] else 1


def _parse_points(raw: str) -> List[List[float]]:
    """--points 收 JSON：[[帧号, x, y], ...]，坐标是原始视频像素。"""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"--points 不是合法 JSON：{exc}") from exc
    if not isinstance(data, list) or not data:
        raise ValueError("--points 至少要有一个点")
    out: List[List[float]] = []
    for item in data:
        if not isinstance(item, (list, tuple)) or len(item) != 3:
            raise ValueError("每个点要写成 [帧号, x, y]")
        out.append([float(item[0]), float(item[1]), float(item[2])])
    return out


def cmd_track(args: argparse.Namespace) -> int:
    paths = env_paths()
    info = probe(paths)
    if not info["ready"]:
        emit_error("运动追踪拓展未就绪", detail=info)
        return 2
    if not paths["ffmpeg"]:
        emit_error("找不到 ffmpeg，无法解码视频。")
        return 2
    if not os.path.isfile(args.video):
        emit_error(f"找不到视频文件：{args.video}")
        return 2

    try:
        queries_px = _parse_points(args.points)
    except ValueError as exc:
        emit_error(str(exc))
        return 2

    from .tracker import decode_frames, load_model, scale_points, track

    try:
        frames, src = decode_frames(paths["ffmpeg"], args.video)
    except Exception as exc:
        emit_error(str(exc))
        return 1
    emit({"event": "progress", "phase": "decoded",
          "frames": int(len(frames)), "width": src[0], "height": src[1]})

    # 点的坐标换到模型空间；帧号不变
    xy = scale_points([[p[1], p[2]] for p in queries_px], src, to_model=True)
    queries = [(queries_px[i][0], float(xy[i][0]), float(xy[i][1]))
               for i in range(len(queries_px))]

    model = load_model(info["model"]["path"])

    def on_progress(done: int, total: int) -> None:
        emit({"event": "progress", "phase": "track",
              "percent": round(done * 100 / max(total, 1), 1),
              "frames": done, "total": total})

    try:
        result = track(model, frames, queries, on_progress=on_progress)
    except Exception as exc:
        emit_error(f"追踪失败：{exc}")
        return 1

    # 轨迹换回原始像素坐标再交出去，前端不用关心模型的 256 空间
    back = scale_points(result["tracks"], src, to_model=False)
    emit({
        "event": "result",
        "width": src[0],
        "height": src[1],
        "frames": int(len(frames)),
        "points": [
            {
                "query": queries_px[i],
                "xy": [[round(float(x), 2), round(float(y), 2)] for x, y in back[i]],
                "visible": [bool(v) for v in result["visible"][i]],
            }
            for i in range(len(queries_px))
        ],
    })
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="promptcut_track")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="报告拓展是否就绪").set_defaults(func=cmd_status)
    sub.add_parser("install", help="安装 torch 等依赖").set_defaults(func=cmd_install)

    t = sub.add_parser("track", help="追踪视频里的点")
    t.add_argument("--video", required=True)
    t.add_argument("--points", required=True,
                   help='JSON：[[帧号, x, y], ...]，坐标为原始视频像素')
    t.set_defaults(func=cmd_track)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001
        emit_error(f"未预期的错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
