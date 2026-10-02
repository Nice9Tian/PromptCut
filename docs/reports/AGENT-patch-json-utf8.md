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

- `node --test desktop/test/ps1-json-utf8.test.mjs`：2/2 通过，0 失败，1088 ms。真实 PS 5.1 执行两类安装器的 WhatIf；修前两项均复现 ConvertFrom-Json 错误。测试子进程隔离 APPDATA、LOCALAPPDATA 和 PSModulePath，避免继承 PowerShell 7 的模块目录；没有改系统配置。
- `node .../typescript/bin/tsc -b --force`：退出 0，8.2 s。
- 全量 `node --experimental-test-module-mocks --test-global-setup=server/test/global-setup.mjs --test server/test/*.test.mjs src/**/*.test.mjs tools/report-worker/*.test.mjs`（与 npm test 相同）：退出 0，76.9 s；4224 项，4223 过、0 失败、1 跳过。
- `node --test desktop/test/*.test.mjs`：退出 0，1.2 s；37/37 通过。
- 子分支结果：`out/a45-validation/branch-results.json`；上述结果直接贴进对话。仅改安装器四处编码读取，未修改 src、server、render、Rust 或像素基线，子分支不重复无关渲染性能项。
- 后续待填：集成 G0 复验、PC 从新 main 重打真补丁、笔记本在两种外壳上实际安装；真实包通过之前不把第 1 行写成全部通过。
