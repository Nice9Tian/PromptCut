"""镜头切换检测。

主力是 TransNetV2（ONNX，走 onnxruntime）；没装拓展包时由 node 侧回退到
ffmpeg 的 scdet 滤镜——那条路只认硬切，认不出溶解。
"""

__version__ = "1.0.0"
