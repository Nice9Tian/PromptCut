# 子 Agent 报告：渲染服务的容量记账、部署脚本与模板、界面开关（第三段第 3、4 批）

分支 `claude/render-service-ops`，worktree `.worktrees/render-service-ops`，起点 `7b7b1fd8`（第 1 批完成）。契约 `docs/plan/hosted-render-contract.md`。

## 状态

开工。下面随进度补。

## 计划

- 第 4 批：项目设置里「托管方的渲染节点」勾选；成员列表的服务行；`hosted-service-changed` 通知；HR24；浏览器端验证两张截图。
- 第 3 批容量：`server/asset-store/service-usage.mjs`、素材服务记账与 507、删项目清理、按最久没人在线淘汰（先验前提）；HR21。
- 第 3 批部署：`server/hosted/deploy/` 的 PM2 配置模板与 slice 模板、README 一节、`scripts/remote/docservice.mjs` 的渲染服务子命令、`hosting-migration.md` 补迁移与重建；HR22。
