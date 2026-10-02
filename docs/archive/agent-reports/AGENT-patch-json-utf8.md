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
- 集成 G0：tsc 退出 0、8.9 s；全量 4224 / 4223 / 0 / 1、76.3 s；desktop 37/37、2.4 s。结果在 out/a45-validation/json-integration/branch-results.json，已直接贴入对话。
- PC 从 main 96d308959a822aa7dea41772066d22cdb16ae235 按原 release --from-head --patch-only 出真补丁：13491324 字节，SHA-256 48D21F4F07BCFBAF5DEA437DFBB87525787CA57228517EFD3A55DA6DBF3756FB；真实 stage 脚本与源相同、BOM=True、PS 5.1 ParseFile=0、2337 个 payload 文件全部 hash 一致。
- 笔记本真安装：0.2.7 在 5.309 s 进程/锁归零，显示成功，实际退出 0；2337 文件 hash 一致、29 删除项均不在、重开 Rect=240,54 2422×1453。0.2.6 上同一补丁也退出 0、2337 hash 一致，实际中文清单正确读取；旧壳唤回子项另立 AGENT-legacy-patch-wake，不当成编码问题未修复。
- 当前正式 release 命令从 main 96d30895 退出 0、831 s；完整包已产生。旧壳唤回修复合流后还须重出最终正式包并安装，因此本轮 release 暂未推进。
- 实际 stt 拓展重新构建 6.4 s 退出 0，83992439 字节、SHA-256 B048A5A189A9AF34ECEBF5053334B2393E12EC83216942A0709D2C97363FEA46；成功 NSIS stage 的 apply-extension.ps1 BOM=True、PS 5.1 ParseFile=0，原脚本 WhatIf 退出 0、无写入。未安装可选能力。

## 卡点 2：没有原 0.7.13 完整包，需恢复已授权的旧外壳现场

尺子：笔记本实际 shell=0.2.6、app=0.7.13；旧应用打开测试草稿；真实 0.7.13 payload 文件 hash 全部相同、依赖段 fingerprint 与旧完整包一致；随后对同一份新 0.7.14 真补丁实测兜底更新，最后装回本轮正式包。PC 用户安装完全不动。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 用原 0.7.13 完整包直接降装 | 原版一体恢复 | 1 | 1 | 2 | PC 与笔记本已有产物、GitHub releases | 关闭·无改善 | 两端没有该完整包，公开 releases=[]；可取得真实 0.7.0 完整包（shell 0.2.6）和真实 0.7.13 补丁 |
| 2 | 1 | 三级 | — | 0.7.0 完整包加原 0.7.13 补丁安装器 | 原安装逻辑逐级升应用 | 2 | 2 | 4 | 原包 BOM、manifest 的依赖锁允许值 | 关闭·剪（方向已关） | 原脚本无 BOM；旧清单只允许 0.7.2 / 0.7.13 的整份 lock hash，0.7.0 不匹配；不能通过改清单或伪造锁文件绕过检查 |
| 3 | 1 | 三级 | — | 0.7.0 真完整包恢复 shell，按已核验的原 0.7.13 payload 离线恢复应用文件 | 两份真实产物的 lockDepsHash 完全相同，故依赖无需更换；恢复文件对应旧版本 | 2 | 1 | 3 | 两清单 lockDepsHash；2334 文件 hash；实际 app/PE 和 UI | 验证中 | 两者依赖 fingerprint=0c3aa690…bc96a8；原 0.7.13 payload 2334 文件 hash 全过，无 .env 或用户数据；不修改新补丁，不放宽验收门槛 |
| 4 | 1 | 三级 | — | 另建旧 release worktree 重出 0.7.13 完整包 | 从原提交重构一体包 | 4 | 1 | 5 | 构建、版本和旧代码校验 | 未选 | 第 3 行可以使用现有真实包恢复同一应用与外壳，避免再编一份历史产物 |

读取归档工具来自 7-Zip 官方 26.03 发布。msiexec 管理解包命令被自动策略拒绝，改为官方 7zr 解开官方自解压归档，得到便携 7z；没有执行安装器或改系统配置。源补丁 SHA 与 PC 回执一致；便携 7z 只读取自有测试产物。第 3 行只恢复本轮已授权的笔记本测试安装，保留草稿与窗口状态；不改产品行为，不新增〔裁〕。未调用顾问，没有层扫空。

第 3 行恢复已实际完成：原完整包 NSIS 成功、实际 exit=0；app=0.7.13、PE=0.2.6，2334 文件 hash 零差异，依赖 fingerprint 与两清单相同，A/B 草稿 4554/4555 字节且 SHA 未变，真实页面开 A 且锁 64 字节。旧 `.git` 是常规指针文件，只作为原 payload 校验/恢复，未在安装目录执行 Git；新真实补丁按 removed 清单将它删除。旧壳的唤回差异另在 AGENT-legacy-patch-wake 处理，最后仍需装回正式 0.2.7。
