# AGENT-agent-cut-edit

分支 claude/agent-cut-edit（自 claude/accept-final3 @f7d5e6bf）。任务：云端 Agent 两个工具问题。

1. update_clip 的 params 是合并补丁，描述没说，模型带回旧值把用户「撤销这步」写回。
2. 非活动剪辑里的 clip 找不到，Agent 只能 switch_cut（改共享的 activeCutId）。

## 进度

- [ ] 读规则与语义
- [ ] 问题 1
- [ ] 问题 2
- [ ] 验证

（开工时建，之后逐块补。）
