# AGENT 报告：rr-source-streams（源依赖卡和外框用了三维变形的卡的轨道流）

分支 `claude/rr-source-streams`，工作区 `.worktrees/rr-source-streams`，从 main `f3e7d5e7` 建，端口段 27060～27099。

要做的事：让两类现在没有轨道流的卡在判重时有流可贴。

- **源依赖卡**（转场、套在视频上的素材效果卡）：连同它用到的视频一起渲，产成一条流，贴的时候顶替那段视频原来的画面。
- **外框用了三维变形的卡**：流里是变形之前的平面画面，贴的时候再做变形。

语义依据：`docs/semantics/mechanism/rendering.md`「重管线：预渲染」里「怎么产，按卡分」一条；用户原话在 `docs/plan/user-decisions-2026-10-13.md` 第 1 节第 7 条。本任务不改语义文档。

## 状态

开工，正在读规则、任务书和现有代码。
