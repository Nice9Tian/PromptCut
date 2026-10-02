# 补丁与拓展安装器读取 UTF-8 清单

主会话专用分支 `codex/patch-json-utf8`，从 main `d4da0fffa022383faecf1f368ff244ee1f6eb291` 开始。未调用顾问；按用户要求自己换角度重列候选。只修 PowerShell 安装器，不动产品语义、渲染代码、像素基线、版本号或 PC 用户安装。

## 卡点 1：中文系统上真补丁在关闭应用前退出

尺子：同一份 PC 真补丁在笔记本 PowerShell 5.1 完成更新；清单/版本 JSON 的原中文文本正确解码，补丁和拓展的 `-WhatIf` 真脚本都退出 0，不写入测试安装目录。

实际 PC 补丁来自 d4da0fff，13,488,404 字节，SHA-256 `38064DF5183FF819A09678C49DBC8B709BFF1A9B4369FFDA11351FD9EF1A4A40`。真实 NSIS 解出的 apply-patch.ps1 带 BOM、脚本解析 0 错，但 `Get-Content -Raw` 默认按系统 ANSI 读取无 BOM 的 UTF-8 patch.json，ConvertFrom-Json 报 ArgumentException，退出 1。两次都未关闭应用、未更新文件；锁仍在。提取的真实 patch.json 在 Windows PowerShell 5.1.26100.9444 中默认读取失败、显式 UTF8 读取成功。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 安装器显式按 UTF-8 读取包清单及 VERSIONS.json | 按实际生成的 JSON 编码解码，避免中文吃掉引号 | 1 | 1 | 2 | Windows PS 5.1 真脚本 WhatIf；真 NSIS 补丁；G0 | 验证中 | 补丁和拓展各有两处同源读取；一并最小修正，不改变包格式 |
| 2 | 1 | 三级 | — | 给所有 JSON 写入 BOM | PS 5.1 可以自动识别 | 2 | 2 | 4 | 包清单/已有版本兼容性 | 未选 | 仍不能修复已安装的无 BOM 版本 JSON，且要改多个生成器 |
| 3 | 1 | 三级 | — | JSON 中文全部转 Unicode escape | JSON 可只含 ASCII | 2 | 3 | 5 | 原格式兼容、生成器完整枚举 | 未选 | 仍不能修复既有版本 JSON，改面大于读取处 |

第 1 行有直接机制，不需要升到二级，无新增〔裁〕。R5 原始失败证据位于集成目录 desktop/.cache/a45-install/r5-027-r1-extracted、r5-027-r1-patch-console.txt 和 observation.json，截图与 PS 5.1 默认/UTF8 两种读取结果已直接贴入对话。当前发布构建已成功但真补丁验收未过，暂不推进 release。

## 验证记录

待填：新增真脚本编码回归、类型检查、全量测试、桌面脚本、集成复验、PC 重打补丁及笔记本真包实测。
