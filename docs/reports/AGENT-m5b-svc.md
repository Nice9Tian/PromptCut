# M5b 文档服务侧（m5b-svc）报告

分支 `claude/rq-m5b-svc`（从 `claude/rq-m5b` 起），worktree `.worktrees/rq-m5b-svc`。
依据：`docs/plan/render-queue-contract.md` J.1、J.2、J.3（`endpoint.mjs`、`index.mjs` 两条）、J.8 svc 行；
`docservice-contract.md`（C6.3，含第 10 节）；`render-queue-contract.md` G.7、G.11；`manifest-contract.md` 第 2 节。

## 进度

- [ ] 存储：`writeBlob` / `readBlob`
- [ ] 项目模块：`project.snapshot.put` / `get`
- [ ] 客户端：`project-client.mjs`
- [ ] `endpoint.mjs`：编辑器里挂的文档服务
- [ ] `index.mjs` 出口
- [ ] 基线与自测
