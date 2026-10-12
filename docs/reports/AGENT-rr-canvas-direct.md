# AGENT 报告：rr-canvas-direct（己一：画布与 WebGL 的卡产轨道流时不经过 PNG）

分支 `claude/rr-canvas-direct`，基于 main（`b0a1b111`）。依据：`docs/plan/render-refactor-task.md`「己」、`docs/plan/prerender-products-contract.md` 第 6.1、6.2、6.4、9、13 节，`docs/reports/AGENT-rr-canvas-paths.md`（己零的量法与决定）。

「己一」指：画布卡产轨道流时，从画布直接取像素交给 ffmpeg（不经过截图和 PNG），同时把流的键换一次。

## 状态

开工，尚无改动。
