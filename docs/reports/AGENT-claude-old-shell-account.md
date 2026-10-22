# AGENT-claude-old-shell-account

分支 `claude/old-shell-account`（从 main `fdbc981d` 切），worktree `.worktrees/old-shell-account`，端口段 5910～5919。

任务：0.2.8 以前的外壳打了补丁以后，桌面版账号入口（云端项目列表、搬到云端）不报错，改成说明「这个功能要装完整安装包」。补丁最低外壳不抬（`MIN_SHELL_VERSION` 不动）。

## 状态

开工，尚未改代码。

## 越界说明（需主 Agent 知晓）

「搬到云端」入口的界面在 `src/editor/sync/CollabSection.tsx`，不在清单内。要给这个入口显示说明，必须在那里加一个状态和一处提示，计划只改这一个文件、改动限于账号云端相关的几行。会在后面的小节里列出逐处改动。
