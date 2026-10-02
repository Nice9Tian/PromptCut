# 旧外壳更新前还原窗口

主会话专用 worktree/分支 codex/legacy-patch-wake，起点 main 96d308959a822aa7dea41772066d22cdb16ae235。没有调用顾问或子 Agent；不动 PC 用户安装，只修本轮补丁安装器的旧外壳兼容路径。

## 卡点 1：旧外壳的真补丁能更新，但没有先唤回窗口

尺子：同一份真实 PC 补丁在 app=0.7.13、PE shell=0.2.6 的笔记本上，安装前窗口 Min=True，关闭段开始后出现 Min=False 的屏上主窗截图；随后等约 10 秒兜底退出、实际安装退出 0、全部 payload hash 一致。新外壳 0.2.7 仍几秒内干净退出并清锁。通过安装器 native window probe、r5-observe-patch.py 及 verify-installed-patch.mjs 测量。

原补丁 SHA-256 48D21F4F07BCFBAF5DEA437DFBB87525787CA57228517EFD3A55DA6DBF3756FB。旧完整包中 0.2.6 外壳在最小化和正常窗口两次均未观察到唤回；补丁分别 17.373 / 14.184 s 进程归零、实际更新退出 0，2337 文件 hash 全过。保留失败证据，不把更新成功当作唤回成功。PC 原安装只读副本同为 0.2.6，但实际应用字段为 0.7.1；只换 PE 的诊断启动时页面空白，不能当作打开旧草稿的验收证据，已还原旧完整包的 PE。

| # | 轮 | 层 | 父 | 候选 | 改善机制 | g | h | f | 验证 | 状态 | 结果 / 学到 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 三级 | — | 补丁安装器仅对旧外壳补充 Win32 还原/激活 | 不依赖旧单实例回调是否能还原窗口，直接把已定的旧版唤回行为做完 | 2 | 1 | 3 | 真实 HWND 原生还原；新旧壳同一真补丁；G0 | 已试·部分 | 源函数在真 PS 5.1 退出 0，Min=True→False、Foreground=True、Rect=240,54 2422×1453；0.2.7 不进入此路径。待真包及 G0 |
| 2 | 1 | 三级 | — | 取得原 PC 0.2.6 外壳副本复核旧包差异 | 排除历史完整包 PE 的差异 | 2 | 3 | 5 | 只读源/副本 hash、真实 UI | 关闭·无改善 | 源 app 字段为 0.7.1；PE F0784BC4…EBCC。诊断只换 PE 后页面为空，未用此结果冒充 0.7.13 草稿验收；PC 用户安装与进程不动 |
| 3 | 1 | 二级 | — | 把旧壳项只判更新成功，不要求先唤回 | 改掉任务书 R5.4 的判据 | 1 | 5 | 6 | 用户任务书 | 锁住 | 三级未扫空，不能先改判据 |

不修改外壳版本、产品入口、锁政策、像素基线或新外壳退出流程。第 1 行验证通过前不写成完成。

## 实现与直接探针

`Restore-LegacyPatchWindow` 使用 EnumWindows 按现有安装进程 PID 和 `Tauri Window` 类名筛选，再 ShowWindowAsync(SW_RESTORE) / SetForegroundWindow；调用只在 PE 版本低于 0.2.7 时发生。失败只打印不含私有内容的警告，原 10 秒等待与强杀兜底仍执行。WhatIf 在这些副作用前退出。

第一版使用 Process.MainWindowHandle，没有改善；只读窗口表显示 .NET 选的是 0x2F03AC（com.promptcut.desktop-siw 辅助窗），实际主窗为 0x1503B4。这解释了该实现候选的失效，不将它扩大推断为旧单实例回调失效的根因。改用真实窗口枚举后，`node desktop/.cache/a45-install/probe-legacy-window.mjs` 提取并执行本分支的原函数，PS 5.1 exit=0；实际锁住测试草稿的旧安装先最小化，再恢复屏上，窗口表和 `legacy-native-filtered-after.png` 已直接贴入对话。微软原生接口资料：ShowWindowAsync 与 SetForegroundWindow 的官方 Microsoft Learn 页面；没有改系统前台策略。

子分支需跑 tsc、全量测试、desktop/test、真实 PS 5.1 Parser 和两种壳的实际补丁。PC 在线时优先承担没有耗时门槛的 G0 与真补丁构建；所有窗口与耗时判据仍在笔记本。未新增〔裁〕。
