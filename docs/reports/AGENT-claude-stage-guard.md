# AGENT 报告：claude/stage-guard（舞台源上剩下的跨项目通道）

- 分支：`claude/stage-guard`（从 `gemini/media-cache` 的 `b41d1a42` 开出），worktree `.worktrees/stage-guard`
- 任务：把在线编辑器舞台源上还能把一个项目的路径号（素材地址 `/media-s/<路径号>/media/<哈希>` 里那一段）带给别的项目卡片的通道堵上：卡片自建 Worker 里的持久存储、`window.name`、`BroadcastChannel` / `SharedWorker`、`cookieStore` 写入、Web Locks 的锁名，以及其它能跨文档留存的东西。
- 端口段：6440～6449。

## 进度

- [ ] 各通道的结论与修法
- [ ] 单元测试（含去掉守卫会红的核对）
- [ ] 真实浏览器核对
- [ ] 两个现有探针
- [ ] 类型检查、全量测试
- [ ] 语义措辞建议
