# AGENT 报告：c66-host-cards（独立渲染主机不再因用户卡分池）

分支 `claude/c66-host-cards`，worktree `.worktrees/c66-host-cards`，起点 `claude/c66-t9` 的 `5adf498`。不推送、不合并。

**状态：进行中。**

## 任务

C6.6 T9（设计稿 `docs/plan/c66-design.md` 第 6 节第 9 条跨机验收）暴露的代码与语义冲突：`server/frame-code.mjs` 的 `frameCode(root)` 把整个 `src/`（含 `src/cards/user`）哈希成一个代码版本，节点按它分池，另一台机器上的独立渲染主机只要没有创建者的用户卡，就一个任务也认领不了。语义（`product/platforms.md`「渲染节点」、`mechanism/document-service.md`「渲染任务队列」）要求主机「能认领：全部」，按任务标明的能力自己过滤。
