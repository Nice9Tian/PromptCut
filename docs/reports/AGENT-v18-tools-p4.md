# AGENT-v18-tools-p4：0.7.18 云端 Agent 工具包 P4「主体识别」

分支 `claude/v18-tools-p4`（从 main `d7075a58` 分出），工作区 `.worktrees/v18-tools-p4`，端口段 28340～28379。不推送、不合并。

本文里的代号：

- **P4**：`docs/plan/cloud-agent-tools-implementation.md` 工具拆包表里的一个包，管 `subject_status`、`subject_install`、`detect_subjects`、`list_subjects` 四个工具在云端 Agent 服务一侧的实现。
- **F0**：同一张表里先行的公共地基（`tool-context.mjs`、`tool-jobs.mjs`、`project-assets.mjs`、`run-resources.mjs`），已在 main，这个包只调用不修改。
- **G 包**：表里最后一个包，唯一能改工具总表（`cloud-tools.mjs`）和实例入口的人。
- **light / full 两档**：主体检测的两档引擎。light 是 YuNet 人脸加 RT-DETR 人体（onnxruntime），只认 person 和 face，提示词不生效；full 再加 Grounding DINO，能按提示词找任意名词。

（进行中，下面各节在交活前补全。）
