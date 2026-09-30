"""PromptCut 运动追踪拓展：BootsTAPIR 任意点追踪。"""

__version__ = "0.1.0"

# 视频参数可以是素材服务上的 http(s) 地址:Node 侧经素材服务的接口取字节,不再递本机路径
# (docs/semantics/product/agent.md「素材与产物」)。解码全在 ffmpeg / ffprobe 子进程里,它们自己按 Range 取。
# Node 侧按 ACCEPTS_URL 判断这份包认不认地址;老包没有这个标记时,Node 先把字节流到临时文件再递路径。
ACCEPTS_URL = True


def is_media_url(value: str) -> bool:
    """素材服务上的地址(http / https)。只认这两种协议,别的一律当本机路径看。"""
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))
