# AGENT-claude-strip-css

分支 `claude/strip-css`，worktree `.worktrees/strip-css`。执行者：agy（Antigravity CLI，模型 gemini-4-argon-high）+ manager。

## 任务

查手机版（在线浏览器窄屏）传统式编辑器「缩略预览」页里那条横向滚动的缩略时间轴（`.strip-scroll`）
在 iPhone Safari 上**整条不可滚**的布局/CSS 原因。用户报的现象两条：

1. 手指在条上左右划，完全不动；
2. 播放时（时间码已走到 00:05.7 / 00:06.0）条里「当前帧」白线仍停在 0 —— 即程序自己设的 `scrollLeft` 也没生效。

无头 Chrome（安卓仿真 375x812）复现不出来：那里量到 `clientWidth 375 / scrollWidth 455`，滚得动。

## 本路的边界

- 只读分析 + 写最小复现页来验；**不改 `src/` 下的产品代码**（另有两路在改）。
- 可新建文件。交付两件：本报告 + `docs/reports/strip-css-repro.html`。
- 不推送、不合并、不动 `main`。

## 状态

开工（报告骨架已建）。下面几节随分析进度补。

## 结构与 CSS 链条

（待补）

## 嫌疑属性与依据

（待补）

## 复现页

（待补）

## 没能证实的部分

（待补）
