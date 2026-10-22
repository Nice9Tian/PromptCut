# AGENT 报告：claude/browser-titlebar

任务：浏览器版（在线构建）不画应用标题栏里的菜单行与窗口按钮（− □ ×）；桌面版不变；不许把功能弄丢。

状态：进行中（开工提交）。

## 摸底（已查）

- 标题栏 `src/ui/WindowTitleBar.tsx` 由 `src/Shell.tsx:152` 无条件挂上；手机布局（`LAYOUT === "mobile"`）早就不挂。
- 菜单项的动作靠事件 `pc-titlebar-command` 交给 `src/editor/TopBar.tsx:519-541` 执行。
- 现有守门测试 `server/test/c10a-online-build.test.mjs`（C10-TITLEBAR-01）断言「在线产物里有标题栏菜单、桌面项置灰」，与本需求相反（见后文）。

(后续各节随进度补写)
