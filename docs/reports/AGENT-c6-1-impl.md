# C6.1 实现方报告（c6-1-impl）

- 分支：`claude/c6-1-impl`（从 `claude/c6-1` 的 80fc64c 拉出）
- 依据：`docs/plan/render-queue-contract.md` H 节（H.1～H.4），G 节（G.2、G.3、G.11、G.12）
- 可改文件（H.6）：`server/docservice/router.mjs`、`service.mjs`、`ws.mjs`、`modules/render-queue.mjs`

## 进度

- [ ] H.1 频道 API
- [ ] H.2 出站队列与背压
- [ ] H.3 队列模块：合并键、摘要订阅
- [ ] H.4 可观测
- [ ] 自测
- [ ] 基线：tsc、npm test
