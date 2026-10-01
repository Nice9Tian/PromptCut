# A4 + A5 真机验收：剩余项测试计划

写于 2026-10-02 03:45，由笔记本上做这轮验收的主会话（下称「主会话」）交给接手测试的会话。用户 03:40 叫停了主会话的电脑操作，剩下的项按本计划由别的会话来测。

- **A4**：桌面 APP 里的 Agent（Claude Code、Codex）经 MCP 直接连 PromptCut。包括「登记到 Claude Code / Codex」和 SKILL 模式。
- **A5**：关窗不退出、收到后台。包括托盘、悬浮窗、右键「关闭」才真正退出、补丁经 `--quit` 关掉 PromptCut。
- 8 步清单的原文在本分支 `docs/reports/AGENT-tray.md` 第 7 节。本计划沿用那份的步号；剩余项另编 R1～R8。

## 0. 开工前

- 先读 `AGENTS.md`，再按它读 `docs/semantics/developer_guide.md`、`guide_files/suggested_agent_behavior.md`、`guide_files/constraints.md`。
- 本计划只管测、记、回报。不改代码，不合并，不写 main，不出包。补丁只在 PC 上打。
- 用户的硬性要求（原话摘要）：
  - 笔记本上的安装可以覆盖。PC 上用户在用的桌面版不许动。
  - 电脑操作期间不要同时跑带耗时门槛的项。
  - 做不了的照实记，不硬判，不算过也不算挂。
  - 每一步截图贴进对话，写明看到了什么、判过还是没过。
  - 「文件 → 退出」菜单项留不留由用户定，先保留。
- 端口：PC 辅助用 5560～5579，笔记本辅助用 5580～5599。5190～5192 谁都不用。PC 上的 `.worktrees/pc-g0r-base` 不碰。

## 1. 被测对象

| 项 | 值 |
|---|---|
| 提交 | `claude/a45-merge` 的 71f7a9ed（main 0.7.13 合进来，再把版本号改成 0.7.14、外壳 0.2.7） |
| 安装包 | `D:\VectorMPEG7\PromptCut\.worktrees\a45-merge\desktop\release\PromptCut-0.7.14-setup.exe`，433,632,116 字节 |
| SHA-256 | `AC2DBD2626E0E22CE8AF90A2D34937698B9B60DDAD6761ADC0BF1CB38B8FEA74` |
| 出包 | 2026-10-02 02:08 在笔记本上出（rustc 1.99.0 MSVC、NSIS 3.11）。和 PC 出的那份（SHA-256 26397283…）哈希不同，属正常 |
| 和正式包的差别 | 没内联 `VITE_DIAG_*`，诊断上报地址为空。与 A4、A5 无关 |
| 安装位置 | `C:\Users\yuchiron\AppData\Local\PromptCut`（外壳 0.2.7，运行时 0.7.14） |
| 草稿目录 | `C:\Users\yuchiron\AppData\Local\PromptCut\runtime\app\.pc-projects\` |
| 窗口位置记录 | `C:\Users\yuchiron\AppData\Roaming\com.promptcut.desktop\.window-state.json`（物理像素） |
| 外壳日志 | `C:\Users\yuchiron\AppData\Local\com.promptcut.desktop\logs\sidecar.log` |
| SKILL 目录 | `C:\Users\yuchiron\Documents\PromptCut-Skill\`，内有 skill-state.json、last-action.png/json、mcp-register\（登记前的备份） |
| 笔记本 | Windows 11 26200。**只有一块屏**（DISPLAY1）。系统 ANSI 代码页是 **GBK（936）** |

## 2. 交接时的现场（03:40）

- PromptCut 在跑：promptcut.exe 和 4 个 node.exe，02:58:27 起。是主会话经 `explorer.exe` 启动的，测试会话可以关掉它、重开它。
- 编辑界面展开，**SKILL 模式开着**。
- 开着的项目是草稿「未命名」，id `20261002-a45tst`，文件 `.pc-projects\20261002-a45tst.proc`。草稿是主会话造的：用 PromptCut 自己的 get_project 拿当前项目，再 PUT 到 `/api/projects/<id>`，等同「保存项目」挑完文件之后那一步。
  - 草稿上有一处未保存的改动：Claude Code 会话把「数字滚动」在 1 s 处切开了，片段数 10 → 11。
  - 这份草稿**现在没有锁**，原因见第 4 节缺陷 2。
- 悬浮窗被拖到了屏幕中间（约在截图坐标 550～723 × 423～475）。
- 已登记到两边：
  - `C:\Users\yuchiron\.claude.json` 有 `mcpServers.promptcut`：stdio，command 为 PromptCut 自带的 node.exe，args 为 `runtime\app\server\mcp-server.mjs`，env 为空。
  - `C:\Users\yuchiron\.codex\config.toml` 末尾多了 `[mcp_servers.promptcut]` 一节。
  - 备份：PromptCut 自己的在 `Documents\PromptCut-Skill\mcp-register\` 下（`claude-code-20261001-182021-.claude.json`、`codex-20261001-182049-config.toml`）。主会话另复制了一份到它的临时目录 `backup-a45-register\`，和 PromptCut 的备份逐字节相同。
- 存储上限已调到 500 GB。03:01 时预渲染缓存 312.8 MB。
- 别碰的东西：
  - 一个最小化的「Windows Security」窗口：属于 PickerHost.exe，02:35:37 起就在，疑似首次启动时 node.exe 监听端口引出的防火墙提示。约束不许改防火墙，所以别点它。
  - 桌面图标被用户设成隐藏（HideIcons=1）。别改。

## 3. 已完成的项（不用重做）

| 步 | 内容 | 结果 | 依据 |
|---|---|---|---|
| 装前 | 有没有 PromptCut 在跑；记缓存；调上限 | 完成 | 装前没有 PromptCut 进程，预渲染缓存 0 B；首次启动后开始页「存储」改成 500 G，提示「缓存上限已改为 500.0G。」 |
| 1 | 关窗不退出 | **过** | 点 × 后编辑界面消失，任务栏按钮没了。Ctrl+Alt+Tab 切换器里只有记事本、Claude、Windows Security，没有 PromptCut。托盘溢出区有 PromptCut 图标（悬停提示「PromptCut」）。悬浮窗写「PromptCut 在后台运行 / 编辑界面已收起，Agent 照常工作」。进程表里 promptcut.exe 和 4 个 node.exe 都在 |
| 2 | 收起时页面侧工具照常（传统式，命令行身份） | **过** | 03:10:53 调 seek(t=3) 返回 ok，27 ms；get_selection 返回 ok，11 ms。03:15:56（5 分钟后，一直收着）调 seek(t=7) 返回 ok，30 ms；get_selection 返回 ok，12 ms。唤回后播放头停在 7.00 s，证明调用确实作用到了页面 |
| 2 | SKILL 下「上一步」画面 | **过** | Claude Code 会话做了 split_clip。悬浮窗下方出现预览块：切开后的那一帧，配文「上一步 切开卡片 · 0.5s · 03:22:15」 |
| 3 | 托盘左键唤回 | **过** | 回到原位（物理像素 240,54），在最前（前台窗口就是它），搜索框能直接打字 |
| 3 | 单击悬浮窗唤回 | **过** | 同上。悬浮窗再出现时在上次拖到的位置 |
| 3 | 收起时再启动一次 | **过（等价路径）** | 桌面图标被隐藏，没法双击，改用 `explorer.exe` 打开同一个桌面快捷方式，和双击走同一条 ShellExecute。窗口回到原位、在最前、能打字；进程仍是 5 个，没有多开 |
| 3 | 最大化时关、再唤回 | **过** | 托盘唤回后 IsZoomed=True |
| 4 | 悬浮窗拖动 | **过** | 拖到屏幕中间，编辑界面没弹出来（主窗仍在屏幕外 x=-2678） |
| 6 | 进 SKILL、Claude Code 连进来 | **部分过** | 进 SKILL 后编辑界面收起，悬浮窗写「SKILL 模式」和会话状态。<br>`claude -p` 经登记的 MCP 做了一次时间轴操作（03:22:00～03:22:17，切开「数字滚动」，新片段 c-mupv2qh9-1）。<br>悬浮窗依次写「Claude Code 上一步：切开卡片」「Claude Code 上一步：读项目」。<br>单击悬浮窗后编辑界面打开，顶栏 SKILL 仍高亮。<br>AI 栏出现「Claude Code 会话 GhXI」分组；Agent 操作记录里有 split_clip，旁边有「撤销这步」 |
| 登记 | 「登记到 Claude Code / Codex」 | 完成 | 两张卡都显示「已登记」，配置与备份核对过，见第 2 节 |
| 8 | 关闭段预演（不是正式第 8 步） | 关闭段过 | 用 quit-test 镜像补丁脚本的关闭段跑过一次。当时 PromptCut 正被一个模态保存框锁着，发 `--quit` 后 1.45 s 内 5 个进程全退，没走强杀兜底。日志在 `quit-test-prerun.log` |

截图都在笔记本的 `C:\Users\yuchiron\.claude\projects\D--VectorMPEG7-PromptCut\dd19d14b-0879-42e4-b4b2-6d8f351421a8\tool-results\` 下，文件名形如 `mcp-computer-use-blob-<时间戳>-<后缀>.jpg`。主会话把它们整理进报告时再按步号挑出来。

## 4. 这份构建里已知的缺陷（测到时照记，不算新发现）

1. **随包发给用户的 .ps1 在中文系统上解析失败。**
   - 涉及三份：`apply-patch.ps1`（补丁）、`apply-extension.ps1`（扩展包）、`nsis\report.ps1`（安装失败时生成报告）。另有运行时写出的 `send-prompt.ps1`。
   - 原因：都是不带 BOM 的 UTF-8。Windows PowerShell 5.1 按 ANSI 代码页读，GBK 下 ParseFile 分别报 5、13、4 个错。`apply-patch.cmd` 里先 `chcp 65001` 也没用，已实测。
   - 后果：**这台笔记本上，现有补丁脚本一行都跑不起来。**
   - 修复在 `claude/ps1-bom`（1398e237），未合入。加 BOM 后三份都是 0 错误，另有守门测试。
2. **打开草稿后锁被立刻放掉。**
   - 触发路径：「开始创作 → 返回首页 → 开草稿」，或「开草稿 A → 返回首页 → 开草稿 B」。之后刚打开的草稿旁没有 `.proc.lock`，另一个实例能同时打开、互相覆盖。
   - 原因：`setActiveDraftId` 放掉的是「当前持有的锁」，而那时持有的已经是刚抢到的新锁。
   - 只有本次启动后第一个打开的草稿才真的锁着。
   - 修复在 `claude/draft-lock`（c47f2abf），未合入。新测试修前 3 例失败，修后 7 例全过。
3. **收起是把主窗挪到屏幕外，不是隐藏。**
   - 收起后主窗在物理坐标 x=-2678，IsWindowVisible 仍为真，同时加了 WS_EX_NOACTIVATE。
   - 单屏上任务栏和 Alt+Tab 都看不到它（第 1 步已过）。但第 7 步的场景（副屏排在主屏左边）正好可能露出窗口，见 R6。
4. **悬浮窗的「正在……」只在工具调用进行中显示。**
   - 悬浮窗收到的会话字段里有「正在做的」（current）和「上一步」（last）。调用结束就变成「上一步：…」。
   - 毫秒级的调用几乎抓不到「正在」，见 R1.2。
5. **系统保存框归 msedgewebview2.exe。**
   - 「保存项目 / 打开项目 / 另存为」走网页的文件系统访问接口，弹出的系统框属于 msedgewebview2.exe。用户没授权电脑操作工具控制 msedgewebview2.exe。
   - 主会话第一次点「保存项目」时，这个框被截图工具藏掉，又以模态方式锁住了主窗，只好用 `--quit` 关掉重开。
   - **测试时别点这些菜单。** 要存草稿用 `a45-make-draft.mjs`，见第 6 节。

## 5. 剩余测试项

标注：**[会话]** 测试会话用电脑操作工具能做；**[人手]** 电脑操作工具做不到，要用户自己点；**[授权]** 要用户先点头。

### R1　第 6 步余项（笔记本）[会话]

**R1.1 Codex 会话连进来**
- 步骤：
  1. 编辑界面保持 SKILL。
  2. 在一个 Claude 桌面 App 里的会话的 Bash 中跑（`codex` 是 npm 全局的 0.159.2，只在 Claude 桌面 App 起的进程里看得见）：
     `codex exec --skip-git-repo-check "请只用 promptcut 这个 MCP 服务的工具：先调 get_project，再对序列 1 里第二个片段调 split_clip，t 取它起止时间的正中间，最后用一句中文回复切开后两段的 id。"`
  3. MCP 调用若因审批被拒，可加 `-c approval_policy="never"`（沙箱仍是默认的只读）。**不许用** `--dangerously-bypass-approvals-and-sandbox`。
- 判据：
  - 调用成功。
  - AI 栏出现「Codex」会话分组，显示会话号和上一步。
  - 收起时悬浮窗写「Codex 上一步：…」或「Codex 正在……」。
  - 悬浮窗下方「上一步」画面换成这次切开的那一帧。
- 证据：codex 的输出；AI 栏截图；悬浮窗截图。

**R1.2 抓「正在……」**
- 步骤：
  1. 编辑界面收起（SKILL 下点 ×）。
  2. 让任一桌面会话调一个要跑几秒的工具，例如 `see_frames`：`claude -p "请只用 promptcut 的 see_frames 工具看一下 0 到 3 秒的画面，然后一句话描述" --allowedTools "mcp__promptcut"`。
  3. 调用进行中每 1～2 秒截一次悬浮窗。
- 判据：至少一张截图里悬浮窗写「Claude Code 正在……」（或 Codex）。
- 抓不到时：把 see_frames 换成更慢的工具再试。仍抓不到就记「做不了：调用太快」，附上看到的「上一步：…」截图，不算挂。

**R1.3 打开后 SKILL 不会自己再收回**
- 步骤：单击悬浮窗打开编辑界面，计时观察 60 s。
- 判据：编辑界面一直展开，顶栏 SKILL 一直高亮。主会话只看到打开那一刻，没有持续观察。

**R1.4 切回传统式**
- 步骤：
  1. 顶栏点「传统式」。
  2. 点 × 收起。
- 判据：悬浮窗写「PromptCut 在后台运行」，不再出现「SKILL 模式」和会话状态。

**R1.5 传统式下桌面会话被拦（回归）**
- 步骤：在传统式下跑 `claude -p "调 promptcut 的 get_project" --allowedTools "mcp__promptcut"`。
- 判据：
  - 返回「PromptCut 现在不在 SKILL 模式……」的提示，项目没有改动。
  - AI 栏该会话分组写「上一步失败」。
- 主会话已见过同样的拦截，提示文案见 AI 栏，此项只为回归。

### R2　第 3 步余项：托盘右键 →「打开编辑界面」[人手]

- 电脑操作工具把资源管理器（托盘属于它）只授权到「点击」级，右键被拦。工具明确要求不得绕开。
- 步骤：收起后，在托盘溢出区的 PromptCut 图标上右键 →「打开编辑界面」。
- 判据：编辑界面回到原位、在最前、能打字。
- 用户点完，测试会话负责用 `win-styles.ps1` 核对位置和前台并截图。

### R3　第 5 步：右键关闭才退出

**R3.1 托盘右键 →「关闭」[人手]**
- 原因同 R2。
- 判据：
  - 托盘图标、悬浮窗消失。
  - `proc-table.ps1` 的输出里 PromptCut 名下进程数为 0：promptcut.exe、node.exe、ffmpeg.exe 都不留。

**R3.2 悬浮窗右键 →「关闭」[会话]**
- 悬浮窗属于 promptcut.exe，是完整级，可以右键。
- 步骤：
  1. 用 `explorer.exe "C:\Users\yuchiron\Desktop\PromptCut.lnk"` 再开。
  2. 点 × 收起。
  3. 在悬浮窗上右键 →「关闭」。
- 未保存改动：草稿上有未保存的改动时，可能先弹确认。选「不保存 / 继续」即可，那是测试草稿。别选会弹系统保存框的路，见缺陷 5。
- 判据：
  - 托盘图标、悬浮窗消失。
  - 进程表 PromptCut 名下为 0。贴 `proc-table.ps1` 的完整输出。

**R3.3 再开，窗口在上次关之前的位置**
- 步骤：
  1. 关之前先跑一次 `win-styles.ps1`，记下主窗的 Rect（展开时的值）。
  2. 关掉，再开。
  3. 再跑一次 `win-styles.ps1`，并读 `.window-state.json`。
- 判据：再开后主窗 Rect 与关前展开时一致，不是 x=-2678 这类屏幕外坐标。

### R4　第 8 步（用本构建，关闭段用 quit-test 镜像）[会话]

真补丁暂时没法在笔记本上跑，原因见缺陷 1 和 R5。这一项先验证 0.2.7 外壳对 `--quit` 的响应和锁的释放。`quit-test.ps1` 照抄 `apply-patch.ps1` 的关闭段：发 `--quit`，每 0.5 s 查一次、最多等 10 s，超时才 CloseMainWindow 加 Stop-Process。它只多记时间，不换任何文件。

- 步骤：
  1. 如 PromptCut 在跑，先关掉：悬浮窗右键「关闭」，或跑一次 quit-test。
  2. 用桌面快捷方式重开。
  3. **先**在开始页「本地草稿」里点开 `未命名`（20261002-a45tst）。在这之前不要点「开始创作」，否则会撞上缺陷 2，草稿不加锁。
  4. 确认 `.pc-projects\20261002-a45tst.proc.lock` 存在。贴 `ls` 输出。
  5. 跑一次 `win-styles.ps1`，记下展开时的 Rect，然后点 × 收起。
  6. 跑 `explorer.exe "D:\VectorMPEG7\PromptCut\.worktrees\a45-merge\desktop\.cache\a45-install\quit-test.cmd"`。等 `quit-test.log` 出现 `QUIT_TEST_DONE`，贴全文。
  7. 跑 `proc-table.ps1`，贴输出。
  8. `ls .pc-projects`，看锁有没有留下。
  9. 再开 PromptCut，跑 `win-styles.ps1`。
- 判据：
  - 日志里「正在关闭 PromptCut…」之后几秒内就「已关闭」，`fallback used: False`。
  - 进程表 PromptCut 名下为 0。
  - `.proc.lock` 不在。
  - 再开时窗口在收起前（展开时）的位置。

### R5　第 8 步（真补丁）[授权] + PC 出包

**R5.1 出补丁（PC 辅助）**
- 需用户先定：这轮集成要不要并入 `claude/ps1-bom`，见第 8 节。
- 并入后，PC 辅助在含那条修复的分支上出同代次补丁：`cd desktop && npm run release -- --from-head --patch-only`，目标是 0.7.14、外壳 0.2.7。
- 不并入的话，现有补丁脚本在笔记本（GBK）上必然解析失败。那就只能记「做不了」，或者先测一次「失败是什么样」：补丁窗口里的报错截图、PromptCut 是否没被关、安装目录是否没被改。

**R5.2 取包**
- PC 辅助在 5560～5579 段起只读静态文件服务，只暴露那一个补丁文件。
- 笔记本下载到临时目录，核对 SHA-256 与 PC 上算的一致，取完让 PC 辅助停掉服务。

**R5.3 在笔记本上打补丁**
- 前置：照 R4 第 1～5 步开好草稿、确认有锁、记下 Rect、收起。
- 步骤：经 `explorer.exe` 运行补丁（`安装更新.cmd` 或补丁 exe）。不要从 Claude 桌面 App 起的 shell 里直接跑，原因见第 6 节「MSIX 虚拟化」。
- 判据：
  - 补丁窗口「正在关闭 PromptCut…」之后几秒内「已关闭」，不是等 10 秒再强杀。
  - 补丁装完再开，窗口在收起前的位置。
  - `.proc.lock` 不在。
- 证据：补丁窗口截图、进程表、`ls`、`win-styles.ps1`。

**R5.4 在 0.2.6 外壳上跑同一份补丁**
- 判据：窗口先被唤回，约 10 秒后被强杀，补丁照样装上。
- 需要一台装着外壳 0.2.6（0.7.13）的机器：
  - PC 上那份是用户在用的，**不许动**。
  - 笔记本要先降装 0.7.13 完整包，用户原先只授权装本机构建的那份。所以这一项要么用户自己在 PC 上验，要么用户点头后在笔记本上降装再测。

### R6　第 7 步：多显示器 [人手]

- 笔记本只有一块屏，**记「待用户在 PC 上验」**。PC 上的桌面版是用户在用的，测试会话不碰。
- 要点：副屏排在主屏**左边**时，收起后副屏上不应看到窗口的任何一部分。缺陷 3 说明收起是挪到 x=-2678，这一项很可能出问题，请用户重点看。
- 笔记本若临时接了副屏，测试会话也可以测：
  1. 系统设置里把副屏排到左边。这是用户的显示设置，[授权]。
  2. 收起。
  3. 截副屏，并跑 `win-styles.ps1` 看主窗 Rect 是否落在副屏范围内。

### R7　两条修复的复验 [会话]（等含修复的构建）

`claude/ps1-bom` 和 `claude/draft-lock` 并入集成分支、出了新包或补丁之后再做：
- 草稿锁：
  - 「开始创作 → 返回首页 → 开草稿」后 `.proc.lock` 在。
  - 「开 A → 返回首页 → 开 B」后 B 的锁在、A 的锁不在。
- BOM：新包安装目录里的 `apply-extension.ps1`、补丁里的 `apply-patch.ps1`，用 `parse-as.ps1` 或 ParseFile 在笔记本上解析都是 0 错误。然后按 R5.3 真打一次补丁。

2026-10-02 接手核对包结构后的更正：`apply-extension.ps1` 属于独立拓展包，由 `make-extension.mjs` 复制到包 payload，`extension-installer.nsi` 从临时插件目录执行，完整安装目录不留它。BOM 复验应从实际拓展包解出的 payload，或成功打包并用 `--keep-stage` 保留的真实 NSIS 收集目录取它；不以源文件或完整安装目录的不存在来判随包结果。真补丁仍按 R5 执行。

### R8　收尾 [授权]

- 撤销登记（默认测完撤销，用户要留着就跳过）：
  - 在 SKILL 对话框里分别点两张卡的「撤销登记」。
  - 核对 `.claude.json` 已没有 `mcpServers.promptcut`。只比这一个键，Claude Code 自己随时在写这个文件的其它部分。
  - 核对 `config.toml` 与 `Documents\PromptCut-Skill\mcp-register\codex-20261001-182049-config.toml` 逐字节相同。
- 退出 SKILL，关掉 PromptCut，并跑 `proc-table.ps1` 确认 PromptCut 名下为 0。
- 测试草稿 `20261002-a45tst` 留着，主会话写报告时还要看。

## 6. 工具与环境坑（必读）

**检查脚本**都在笔记本的 `D:\VectorMPEG7\PromptCut\.worktrees\a45-merge\desktop\.cache\a45-install\` 下（被 git 忽略，PC 上没有）。

| 脚本 | 用法 | 做什么 |
|---|---|---|
| `proc-table.ps1` | `powershell.exe -NoProfile -File <路径>` | 列 promptcut.exe / node.exe / ffmpeg.exe，标出可执行文件或命令行在安装目录下的那些，第一行是 PromptCut 名下的个数 |
| `win-styles.ps1` | 同上 | 列 PromptCut 的两个顶层窗口（主窗、悬浮窗）：Visible、Max、Foreground、扩展样式、Rect（物理像素）。主窗收起时 Rect 在 x=-2678 |
| `fg-window.ps1` | 同上 | 当前前台窗口属于哪个进程 |
| `list-windows.ps1` | `-Names promptcut,pickerhost` | 列指定进程的所有顶层窗口 |
| `quit-test.cmd` / `.ps1` | `explorer.exe <quit-test.cmd 的路径>` | 镜像补丁关闭段，结果写 `quit-test.log` |
| `a45-mcp-call.mjs` | `node <路径> --caller cli --tool seek --args "{\"t\":3}"` | 照登记的命令起 MCP 进程调一个工具，打印耗时与结果。`--caller cli` 是 AI 栏命令行工具的身份，传统式下也放行；不带它就是桌面会话身份，传统式下会被拦。`--list --schema --tool X` 看参数格式 |
| `a45-make-draft.mjs` | `node <路径> [草稿id]` | 用当前项目造一份草稿，绕开系统保存框。要求编辑界面开着项目 |
| `parse-as.ps1` | `-Path <ps1> -CodePage 936` | 按指定代码页解析一份 .ps1，报错误数 |

**环境坑**：
- **MSIX 虚拟化**：从 Claude 桌面 App 起的进程，对 `%LOCALAPPDATA%` 的新写入会被重定向到 Claude 包的私有目录。因此启动 PromptCut、跑安装包、跑补丁、跑 quit-test 一律经 `explorer.exe <路径>`，让它在包外运行。npm 全局的 `claude`、`codex` 也只在包内看得见。
- **电脑操作工具的分级**：
  - 资源管理器（桌面、任务栏、托盘）只到「点击」级：能左键，不能右键、不能按键、不能拖放到它上面。
  - 拖悬浮窗时，拖动路径全程都不能经过桌面。主会话的做法是先把记事本最大化垫在下面，再按下、分几步移动、松开，测完把记事本还原大小再关。记事本会恢复用户上次开着的文件（task_list.md），别改它。
  - 截图时，没授权的应用窗口会被藏起来，模态框也可能因此看不见。
  - msedgewebview2.exe 用户没授权。页面里的 JS 确认框（「127.0.0.1:5210 says」）能正常点。
  - 实测用到的授权：PromptCut（完整）、File Explorer（点击）、Notepad（完整）、Pickerhost（完整）、系统组合键。
- **GBK**：含中文的 .ps1 必须带 UTF-8 BOM，否则这台机器上会读歪。主会话第一次跑 quit-test 就因此没把 `--quit` 发出去。自己新写的 .ps1 记得加 BOM。
- **内联脚本**：Bash 里内联的 JS 别写反斜杠路径，用正斜杠，反斜杠会被吞。
- **不动网络**：不点防火墙提示，不改代理、路由、DNS、防火墙。
- **令牌、密钥**：值不打印、不进提交和消息。

## 7. 证据与回报

- 每一项一行：编号、看到了什么、判定（过 / 没过 / 做不了 + 原因）、截图路径、命令输出。截图和输出直接贴在测试会话的对话里。
- 笔记本上的结果另写一份到 `D:\VectorMPEG7\PromptCut\.worktrees\a45-merge\desktop\.cache\a45-install\results.md`。
- PC 上的结果写在 PC 会话里。
- 做完用跨会话消息告诉主会话（或用户指定的会话）：一句话结论加 results.md 的位置。主会话据此写 `REPORT-post-M8.md` 第 15 轮。
- 测试中又发现新缺陷：只记现象、复现步骤和证据，不改代码。

## 8. 待用户定

1. `claude/ps1-bom`、`claude/draft-lock` 两条修复是否并入这轮集成（和 `claude/a45-merge`、`claude/release-no-git` 一起）。不并入，R5 真补丁在中文系统上做不了。
2. 「返回首页」时放不放草稿锁。
   - 现在不放：回首页后草稿仍锁在本窗口。
   - 子 Agent 建议在 Shell 的 `pc-go-home` 处理里调 `setActiveDraftId(null)`。
   - 改了用户看得到区别，按二级办，没动。
3. 托盘右键的两项（R2、R3.1）要用户自己点。
4. 多显示器（R6）请用户在 PC 上验。
5. 降装 0.7.13 测 R5.4，还是由用户在 PC 上验。
6. 测完撤不撤销登记（R8）。
7. 「文件 → 退出」菜单项留不留（照旧先保留）。

## 9. 测完之后（主会话的事，不在本计划内）

- 把结果写进 `REPORT-post-M8.md` 第 15 轮。
- 能判的项都过：在集成分支上把整套跑一次（`guide_files/verification.md`），用户授权后合入 main、判 release、出正式版。安装包和补丁在 PC 上出；合入后 PC 要把 `.gitattributes` 新管的那几个文件重新检出一次。
- 有没过的：按 `guide_files/solution_table.md` 办。
