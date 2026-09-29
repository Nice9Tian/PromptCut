# AGENT 报告：claude/swap-tuning

分支 `claude/swap-tuning`，工作区 `.worktrees/swap-tuning`，起点 main `98e042d0`。端口段 5700～5709。

任务：
- **任务 A**：`SWAP_MS`（在线普通档播放时换一层快照的每拍成本，`src/render/beatSwap.mjs`）按卡种实测，改成按层取值的表，`fitBeatSwaps` 按各层自己的代价累加装箱；给 `mechanism/rendering.md`「兜底顺序」的修改前 / 修改后建议。
- **任务 C**：区分「连续播放中自然进场」与「从卡中间开始播放」：前者不发起播放态互换，后者照旧按估时决定（`AGENT-pause-precise.md`「没做的与观察」第 1 条；`REPORT-C10.md` 第 6 节第 29 行的维护项）。

状态：进行中。

## 提交

| 提交 | 内容 |
|---|---|
| （本次） | 建报告 |
