# AGENT-tailwind-scan

分支 `claude/tailwind-scan`，工作区 `.worktrees/tailwind-scan`，起点 main `7ff0ea8`，端口 5680～5689。

## 任务

开发服务里 Tailwind v4 的 Vite 插件（`@tailwindcss/vite` 4.3.3）自动扫描项目文件找类名；扫到的非模块文件（`docs/` 下的 `.md` 等）一改，它不打日志就让所有打开的页面整页重载（`AGENT-c10a-r2.md`「接手」一节查实）。在入口样式里用 `@source not` 把不含界面类名的范围排除出扫描，并证明样式不变、重载消失。

## 进度

- [ ] 列出实际扫描范围，定排除表
- [ ] 改 `src/index.css`
- [ ] CSS 改前改后逐字节对比（桌面构建、在线构建）
- [ ] 重载对照（改前 / 改后）
- [ ] 基线：tsc、npm test、verify-determinism、导出像素与 main 基准对比
