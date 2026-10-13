# AGENT-v18-tools-p1：0.7.18 云端 Agent 工具包 P1（镜头识别部分）

分支 `claude/v18-tools-p1`（从 main `5c286289` 分出），工作区 `.worktrees/v18-tools-p1`，端口段 28600～28639。不推送、不合并。

本文里的代号：

- **P1**：`docs/plan/cloud-agent-tools-implementation.md` 拆包表里的一个包。这次只做它的镜头识别一半（`detect_shots`，以及让 `list_shots` 在云端说清「作业在跑 / 被中断 / 失败」）；素材拼图（`see_frames({source:'media'})`、`hosted-media-frames.mjs`、`media-sheet.mjs`）这次不做。
- **G 包**：拆包表里最后一个包，唯一能改工具总表（`cloud-tools.mjs`）和实例入口的人。

（开工提交；正文随工作补全。）
