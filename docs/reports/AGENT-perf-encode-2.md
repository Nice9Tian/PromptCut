# AGENT 报告:perf-encode-2(1080p 全幅流 15 帧分段编码,笔记本上留出余量)

- 分支:`claude/perf-encode-2`(从 main `e27fa520`),worktree `.worktrees/perf-enc2`;对照用的 main 检出在 `.worktrees/perf-enc2-base`(detached)。
- 任务:`stream-produce-probe`(不带 `--group`)的「1080p 全幅流 15 帧分段编码 ≤ 300 ms」在笔记本(性能基准机)上 main `9cf43f1f` 的 5 轮 p50 是 300 / 332 / 283 / 311 / 302(中位数 302)。目标:候选 5 轮每轮 ≤ 300、中位数 ≤ 270;优先找产出逐字节不变的路。门槛不改。
- 端口:dev server 5750(舞台 5751、5752);main 对照 5755(5756、5757)。
- 机器:笔记本(AMD Ryzen 7 6800H、16 线程、交流电、Balanced),ffmpeg 9.0.1。

## 进度

- [ ] 在笔记本上拆耗时
- [ ] 逐条试逐字节不变的路
- [ ] 采用的改法与单测
- [ ] main / 候选交替实测
- [ ] 验证(相关单测、tsc)
