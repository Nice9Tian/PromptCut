"""主体检测：画面里人在哪、哪一侧是空的。

给 AI Agent 配动效卡用 —— 知道人脸和人体的框，才能把卡片放到不遮脸的那一侧。

分两档：
  - light：YuNet（人脸，ONNX）+ RT-DETR-R18（人体，ONNX），只要 onnxruntime；
  - full：light 的全部 + Grounding DINO tiny（开放词汇），要 torch + transformers。

两档的模型都随「拓展库包」发，不走 pip。
"""

__version__ = "1.0.0"
