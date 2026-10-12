# AGENT-rr-noreplay：产流时 remotion 式的卡不从挂载帧回放（服务端一半）

分支 `claude/rr-noreplay`，基于 main（`2adfce53`）。任务书：`docs/plan/prerender-products-contract.md` 第 4.2 节；
`docs/plan/render-refactor-task.md`「戊」现状第 3 条。在线一侧（`src/StageView.tsx` 的 `bakeFrame`）不是这一块。

## 进度

- [ ] `planStreams` 带「要不要回放」
- [ ] `StreamProducer.runSegment` 不要回放的流不传 `mountFrame`、预热传 0
- [ ] 单测
- [ ] 探针：replayed 恒为 0、画面逐帧相同（带对照）、motion 式照旧回放
- [ ] 代码指纹改前改后相同
- [ ] 基线（tsc、npm test、stream-produce-probe、verify-unified-frames、verify-determinism、键的核对）

## 做了什么

（随提交补）

## 验证

（随提交补）

## 没做成的与原因

（暂无）

## 对任务书或语义的更正建议

（暂无）
