# 验证

展开 `../agent-guide.md` 的「验证」一节。从属于 `agent-guide.md`，与它冲突时以它为准。

## 基线

| 项 | 命令 | 通过标准 | 什么时候必跑 |
|---|---|---|---|
| 类型检查 | `npx tsc -b --force` | 零错误 | 每次 |
| 全量测试 | `npm test` | 零失败 | 每次 |
| 导出确定性 | `node scripts/verify-determinism.mjs` | 同一段导两遍，逐像素相同 | 改到渲染、导出、卡片 |
| 导出与快照重放一致 | `node scripts/verify-unified-frames.mjs` | 整条通过 | 改到快照、预渲染、渲染 |
| 画面 | 看图，或跑 `scripts/probes/` 下对应的探针（用法见各脚本文件头） | 画面正确、探针全过 | 改到用户看得见的画面 |

## 证据

- 每一项的结果（命令、通过数或退出码、看过的图）直接出现在对话里，汇报时引用。
- 没跑的项要写明没跑、为什么。

## 验证环境

- 验证用 `.claude/launch.json` 的 `dev-test`（5203）。不用 5190（`npm run dev`），那台通常是用户在用的。
- 每台 dev server 另占「端口 +1」「端口 +2」当舞台端口，三个连号都要空着。

## 会造成真实损失的操作

- **删含 junction 的目录**：先在 PowerShell 里用 `[System.IO.Directory]::Delete('<junction 路径>')` 只拆链接，用 `Test-Path` 确认没了再删，确认失败就中止。不要在 Git Bash 里用 `cmd //c rmdir`。
- **有 Agent 会话在跑时不装补丁**：补丁会整棵覆盖桌面版的运行时副本，会话里浏览器侧的工具会集体超时几分钟。

## 参考

- 各种测法：`scripts/README.md`「测法」一节。
- 按症状排障：`docs/guides/troubleshooting.md`。
- 逐帧对账的陷阱：`docs/guides/compare-pitfalls.md`。
