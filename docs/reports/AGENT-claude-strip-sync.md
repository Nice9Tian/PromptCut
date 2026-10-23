# AGENT-claude-strip-sync

分支 `claude/strip-sync`。只查一件事：手机版缩略时间轴（`src/mobile/ThumbStrip.tsx`）**同步逻辑本身**
为什么在「1 段、6 秒、卡片段」的项目上不跟着当前时间走。

本路只读分析为主，可改的文件只有 `src/mobile/ThumbStrip.tsx` 和为它新建的测试文件；CSS 和别的组件由另两路负责，本路不碰。

（开工占位，结论随后写入。）
