# AGENT-agent-cut-overview

分支 `claude/agent-cut-overview`(自 main 90ae8cff)。任务:云端 Agent 明明有就地改别的剪辑里片段的工具,线上(2026-10-21)新对话里仍然 `switch_cut` -> `update_clip` -> `switch_cut`(两次尝试两次都这样)。

判断(三级,不改语义):模型要先拿到 clipId,而它自然先读的 `get_project` / 工具回包里的 `timeline` 只有激活剪辑的片段,切过去是它「看进」剪辑2 的办法;`list_cuts({cutId})` 是多出来的一跳,它不走。

## 计划

1. `src/kernel/cutsIndex.mjs`(新):停放剪辑的紧凑片段索引(剪辑 id/名、片段 id、卡/素材、标签、起止),有总量上限,超出给计数与指路。
2. `get_project`(页面 handler、云端 `projectView`、桌面镜像)带 `parkedCuts`;`list_cuts` 不带 `cutId` 也带;`timelineDigest` 回包带轻量的 `otherCuts` 提示。
3. `switch_cut` 回包 `note`:切换会让所有成员的界面一起翻,改已有片段不需要它。
4. 工具说明与系统提示词:把「不用切」放到多条剪辑一节最前。
5. 测试:索引纯函数、get_project / list_cuts / digest / switch_cut、云端端到端(模型只读 get_project 就能找到并改停放剪辑里的片段,全程没有 switch_cut)。

## 做了什么

(随提交补)

## 验证结果

(随提交补)

## 没做 / 已知限制

(随提交补)

## 部署清单

(随提交补)
