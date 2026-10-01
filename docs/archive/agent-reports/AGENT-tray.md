# AGENT-tray：A5 后台运行（托盘、关窗不退出、悬浮窗与 SKILL 解耦）

分支 `claude/tray`（起点 `claude/skill-mcp` 的 `19dee607`），worktree `.worktrees/tray`。做的是计划 `docs/plan/agent-workflow-plan.md` 的 A5（「Agent 与工作方式」计划的第 5 段：桌面应用关闭编辑界面后转为托盘图标和悬浮窗继续运行；A4 是第 4 段「SKILL 改为桌面 APP 经 MCP 直连」，在同一条分支链上、也还没合入）。

> **醒目**：没有改二级语义。有一处**一级语义冲突要用户定**：标题栏菜单里原有的「文件 → 退出」仍能退出软件，而 `user-workflow.md` 写的是「只有在托盘图标或悬浮窗上右键选择关闭，软件才退出」。删它属于删用户看得见的功能（一级），本段没删，只把它接到与右键「关闭」同一条退出路径上，见第 9 节第 1 条。

## 1. 状态

**代码完成，本机能做的验证全绿，停在分支上不合入。** 主会话审过：「文件 → 退出」保留、列给用户定；防节流参数保留；版本号合入时由主会话改（应用末位 +1、外壳 0.2.6 → 0.2.7）；第 3 条（更新补丁）已在本分支补上（4.7）。 完整安装包与实机验收只能在 PC 上做，列在第 7 节。外壳版本号没改，建议见第 8 节。

## 2. 提交

| 提交 | 内容 |
|---|---|
| `fcab7991` | 建报告 |
| `da9f0e5b` | 功能：托盘、关窗收起、悬浮窗与 SKILL 解耦、右键关闭才退出；WebView2 启动参数；单测 |
| `0d244ecf` | 修：主窗口按 `Window` 查（见 4.4）；最大化状态的退出与挪回 |
| `a0a8f1e9` | 文档：`desktop/README.md` 的 SKILL 悬浮窗几节改写为「后台运行」 |
| `71138a46` | 报告 |
| （本提交） | 主会话第 3 条决定：外壳认 `--quit`，更新补丁先请求干净退出；单测、实跑、报告 |

## 3. 改了哪些文件

`desktop/src-tauri/src/background.rs`（新）、`skill_shell.rs`（重写）、`lib.rs`、`agent_webview.rs`、`Cargo.toml`（tauri 开 `tray-icon` 特性，`Cargo.lock` 不用变：`tray-icon` 已在锁里）、`desktop/ui/overlay.html`（重写）、`desktop/ui/overlay-summary.js`（新）、`desktop/test/overlay-summary.test.mjs`（新）、`desktop/README.md`；主会话追加的 `desktop/scripts/apply-patch.ps1`。仓库根目录的代码一行没动，`capabilities/` 没动（悬浮窗沿用 `skill-overlay` 这个窗口标签，权限清单里本来就放行了它和 `start-dragging`）。

## 4. 做了什么

### 4.1 状态机（`background.rs`）

三态：编辑界面开着 / 收起 / 正在退出。事件：关窗、要打开（托盘左键、悬浮窗单击、菜单「打开编辑界面」、再启动一次）、要退出（托盘或悬浮窗菜单「关闭」、标题栏菜单「退出」）、SKILL 打开、SKILL 关掉。纯函数 `transition` 给出动作（收起 / 挪回 / 提到前面 / 退出 / 放行关窗），窗口层只照做。规则：

- 开着时关窗 → 收起（拦下关窗）；收起时再关窗 → 不动；只有「要退出」才退出；退出途中关窗放行。
- 变成 SKILL 的那一下收起（SKILL 缺省关闭编辑界面）；之后用户自己打开的不再收回去；回到传统式时若收着就打开。

### 4.2 托盘与菜单

托盘图标用应用图标、提示「PromptCut」，常在；左键单击打开编辑界面，右键菜单「打开编辑界面 / 关闭」。悬浮窗右键弹同样两项的原生菜单（外壳 `popup_menu`）。两处的点击都从 app 级 `on_menu_event` 进状态机（托盘自己的菜单回调不接，免得一下触发两次）。「关闭」走 `app.exit(0)`，sidecar 整棵树清理、`.proc` 锁释放仍在 `RunEvent::ExitRequested | Exit` 里做，和原来标题栏「退出」是同一条路。

### 4.3 收起：挪到屏幕外，不 hide（任务第 4 条）

主窗保持「可见」，挪到所有显示器最左边再往左一个窗宽加 256 像素（`offscreen_position`），`set_skip_taskbar(true)`、`set_focusable(false)`（`WS_EX_NOACTIVATE`）；最大化的先还原再挪，记下还原后的位置；挪回时回到记下的位置（已经不在任何显示器上就居中），原来最大化的再最大化，然后显示、取焦点。WebView2 启动参数（主窗、agent 子 webview、悬浮窗三处共用 `agent_webview::browser_args`）加了 `CalculateNativeWinOcclusion` 进 `--disable-features`，并加 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`。

退出前：收起状态下先 `hide()` 主窗，再挪回收起前的位置，然后退出——不然 window-state 插件退出时记下的是屏幕外坐标。为此 window-state 不再记「可见」这一位（否则藏着退出，下次启动主窗出不来）。

### 4.4 顺手发现并修掉的两个老毛病

1. **`get_webview_window("main")` 返回 None。** 主窗口里加了 agent 的子 webview（`agent_webview.rs`）之后它就不再是「一个窗口一个 webview」的 `WebviewWindow`。原来 SKILL 收起用的 `main.hide()`、单实例插件里「第二次启动叫回窗口」都靠这个查法，所以**一直是悄悄失效的**（本机开发构建实测：第一次写的收起代码也因此不动，改成 `get_window("main")` 才好）。现在窗口层操作一律在 `Window` 上。
2. **悬浮窗没带 WebView2 启动参数。** 同一个用户数据目录下参数不同，第二个 webview 会建不出来（`agent_webview.rs` 里写着）。现在悬浮窗带上同一串，本机实测建得出来。

### 4.5 悬浮窗与 SKILL 解耦（`skill_shell.rs`、`overlay.html`、`overlay-summary.js`）

- 编辑界面收起就出现，打开就隐藏；第一次收起时才建，之后只显示 / 隐藏；右上角。
- 单击打开编辑界面；按下后挪超过 4 像素算拖（交给外壳 `startDragging`，原来的 `-webkit-app-region: drag` 在 WebView2 上不起作用）；右键弹原生菜单。页面加载完发 `pc-overlay-ready`，外壳把状态重推一遍。
- 非 SKILL：「PromptCut 在后台运行 / 编辑界面已收起，Agent 照常工作」。
- SKILL：外壳每秒取一次编辑器进程的 `GET /api/agent/desktop`（A4 的桌面会话分组，只挑厂商、正在做的、上一步），悬浮窗写「Claude Code 正在改卡片」「Codex 上一步失败：删卡片」「等桌面 APP 的 Agent 接入」「编辑器没有响应」等；只在收起且 SKILL 时取。
- SKILL 下「上一步动作」预览照旧：A4 之后由用户这份页面渲、交回 `/api/skill-mode/last-action` 写到 skillRoot，外壳盯 `last-action.json` 的修改时间推 `pc-skill-preview`。
- 删掉：无头实例时代的四步启动进度块（读任务目录 `job.json`）、从 `procPath` 数卡片——A4 之后状态文件不再写 `jobId`、`procPath`，这两块早已没有数据。

### 4.6 `lib.rs`

关窗拦截、第二次启动、标题栏「退出」都改走状态机；启动时装菜单处理、托盘（建不出来只记日志，悬浮窗仍能叫回与关闭）、状态文件 watcher。

### 4.7 `--quit` 与更新补丁（主会话第 3 条决定）

- 外壳：单实例插件的回调里解析第二次启动的参数（纯函数 `second_launch`），带 `--quit`（不分大小写）就走和托盘「关闭」同一条退出路径（收起状态下先把主窗挪回原位、sidecar 清理、`.proc` 锁释放）；同时带着 `.proc` 也按退出办。不带的行为不变（唤回编辑界面、打开 `.proc`）。带 `--quit` 却没有别的实例在跑时（启动流程走到了 setup），本进程直接退出 0，不反过来起一份新的。
- `desktop/scripts/apply-patch.ps1`：关 PromptCut 时先 `Start-Process <安装目录>\promptcut.exe --quit`，每 0.5 秒看一次、最多等 10 秒；还在的再按原来的 `CloseMainWindow` + 2 秒 + `Stop-Process -Force` 兜底。脚本注释写明：0.2.6 及更早的外壳不认 `--quit`，当成普通的第二次启动只唤回窗口，等满 10 秒后照旧强杀，不比以前差；0.2.7 起 `CloseMainWindow` 只会收起，兜底靠强杀。

## 5. 〔裁〕清单（三级）

1. **收起用「挪到屏幕外」而不是 `hide()`，也不把页面侧工具的绑定挪到服务端。** 理由：`hide()` 会让 WebView2 停渲染（计划与 `agent_webview.rs` 都记着）；挪到屏幕外是仓库里已经用过的做法（agent 子 webview 停在 x = -4000），改动只在外壳，不动 Node 与页面；把 `side: "page"` 的绑定移到服务端会牵动 A4 的工具分工与渲染（悬浮窗预览本身就要页面渲），范围远超本段。本机实测收起后页面 `visibilityState` 仍是 `visible`、rAF 与计时器不降（第 6 节）。
2. **屏幕外坐标**：所有显示器最左边再往左一个窗宽加 256 像素、上沿对齐最上面的显示器；不用 -32000（Windows 给最小化窗口的坐标），也不写死 -4000（副屏排在左边时负坐标可能正好在屏上）。
3. **WebView2 启动参数关掉遮挡判断与后台降频。** 本机 A/B：去掉这几项、窗口挪到屏幕外，页面照样 `visible`、rAF 120 帧/秒、计时器 10 次/秒——**在这台笔记本的 WebView2 上没有差别**。仍保留，防的是别的 WebView2 版本把屏幕外窗口判成被挡住；代价是用户自己把编辑界面最小化时页面也不降频（多用一点 CPU）。主会话可以决定去掉。
4. SKILL 与编辑界面：只在「变成 SKILL」的那一下收起，之后用户自己打开的不收回；回到传统式时若收着就打开。
5. 悬浮窗交互：单击打开（语义写「点击」；原来要双击），拖动阈值 4 像素，右键原生菜单；菜单两项「打开编辑界面」「关闭」，托盘与悬浮窗相同。
6. 悬浮窗的 SKILL 进度取 `/api/agent/desktop`，每秒一次，只在收起且 SKILL 时取，只推悬浮窗用得上的字段。
7. 收起前是最大化、又在收起状态下退出：只还原位置不再最大化，下次启动是普通窗口（藏着的窗口一最大化就会显示，而且本机实测退出那一刻最大化来不及生效，window-state 记下的是最大化坐标加普通尺寸）。
8. 挪回最大化窗口时先偏一个像素再挪回：window-state 插件把「最大化之前的位置」记成最后一次移动之前的坐标，还原位置恰好等于最大化坐标时不发移动事件，会把屏幕外坐标记成「最大化之前的位置」，下次启动取消最大化窗口就看不见了（本机实测踩到）。
9. 标题栏菜单「退出」保留、接到同一条退出路径（见第 9 节第 1 条，待用户定）。
10. 悬浮窗窗口标签仍叫 `skill-overlay`，为的是不动两份权限清单。

## 6. 验证

### 6.1 本机怎么编 Rust（这台笔记本只有 GNU 工具链）

GNU 工具链编 tauri 缺两样：`dlltool` 要调的汇编器 `as`、资源编译器 `windres`。没装任何系统级东西，也没下载工具链，只在会话临时目录里放了两个自己编的小替身（只用于本机验证，不进仓库）：

- `dlltool` 替身：把 rustc 给 dlltool 的参数翻成 `rust-lld -flavor link -lib -def:… -out:…`（Rust 自带的 lld 能直接从 .def 出导入库），经 `RUSTFLAGS=-C dlltool=…` 交给 rustc；配合 `-C linker-flavor=ld.lld -C linker=rust-lld`（用 GNU ld 链接 lld 出的导入库时构建脚本会崩）。
- `windres` 替身：只在 `--output` 处放一个空的 COFF 目标文件，所以本机编出来的 exe 没有图标与版本资源。正式包在 PC 上用真的工具链。
- `TAURI_CONFIG` 覆盖掉本机没有的 `externalBin`、`resources`。

### 6.2 结果

| 命令 | 结果 |
|---|---|
| `cargo check`（`desktop/src-tauri`，上述包装） | 退出码 0，0 条警告 |
| `cargo test --lib`（编出测试 exe；Windows 要 Common-Controls 6 的清单，放了旁置 `.manifest` 再跑） | 24 过 0 败：状态机 7 条、屏幕外坐标与还原 4 条、菜单 id、HTTP 拆包 3 条、状态文件解析、会话字段裁剪、悬浮窗高度、WebView2 参数、`--quit` 参数解析 4 条、原有 `chrome_path` 1 条 |
| `cargo clippy` | 没跑：本机工具链没装 clippy 组件（装要改用户的 rustup，没做） |
| `node --test desktop/test/*.test.mjs` | 23 过 0 败（新增 OV-1～OV-7，原有 16 条） |
| `npx tsc -b --force` | 退出码 0 |
| `npm test` | 退出码 0；tests 4065，pass 4064，fail 0，skipped 1（与 A4 之后相同） |
| `snapshotCode` / `captureCode` | `00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，不变 |

### 6.3 本机开发构建实跑（隔离运行）

把 `crate-type` 临时改成只出 rlib（lld 链 cdylib 会超出导出符号上限；改动没提交）编出 `promptcut.exe`，放在会话临时目录里跑：`identifier` 改成 `com.promptcut.desktop.devtray`、`USERPROFILE` 指到临时目录（应用数据、WebView2 数据、导出目录、SKILL 目录都落在临时目录里，没碰用户目录，也没碰已装的桌面版——这台机器上没有）、sidecar 是一个立刻退出的替身（所以页面停在启动等待页）、agent 调试端口用 5905。经调试协议在页面里执行脚本、用 Win32 读窗口矩形与扩展样式。**截屏在这台机器上拿不到**（`CopyFromScreen` 报句柄无效，computer-use 也无法选中这个开发构建），所以托盘图标长什么样、右键菜单、真人点击没看过图。

| 步骤 | 看到的 |
|---|---|
| 启动 | 主窗在屏上（2400×1440 物理像素，本机 150% 缩放） |
| 页面里 `getCurrentWindow().close()`（等同点 ×） | 主窗挪到 (-2678, 0)，扩展样式多了 `WS_EX_NOACTIVATE`，仍可见；悬浮窗出现在右上角（232×72 逻辑像素），文字「PromptCut 在后台运行」 |
| 收起前 / 收起后页面 2 秒 | 都是 `visibilityState: visible`、rAF 240 次、计时器 20 次（开着 / 屏幕外无差别） |
| 悬浮页发 `pc-overlay-open`（等同单击） | 主窗回到原位、去掉 `NOACTIVATE`，悬浮窗隐藏 |
| 写状态文件 `active: true` | 3 秒内收起；悬浮窗「SKILL 模式 / 编辑器没有响应」（本机没有编辑器进程，正确） |
| SKILL 下单击悬浮窗打开，再等 3 秒 | 没被收回 |
| 编辑界面开着时写 `active: false` | 不动；收着时写 `active: false` → 打开 |
| 最大化 → 关窗 → 单击悬浮窗 | 收起时还原并挪走；打开时回原位并重新最大化 |
| 收起状态下 `desktop_titlebar_command('quit')`（与右键「关闭」同一条路） | 进程退出码 0，替身 sidecar 被 taskkill；`.window-state.json` 里主窗是收起前的位置，不是屏幕外坐标 |
| 收起状态下再启动一次 | 第二个进程退出码 0，原来的主窗回到屏上 |
| 没有实例在跑时 `promptcut.exe --quit` | 立刻退出 0，没有留下进程、没起窗口 |
| 收起状态下再启动一次带 `--quit`（更新补丁的做法） | 发参数的进程退出 0；原来那份退出 0，sidecar 替身被清；`.window-state.json` 在退出那一刻重写，主窗位置是收起前的屏上坐标 |
| 去掉 4.3 那几项 WebView2 参数重编再测 | 屏幕外照样 `visible`、rAF 240、计时器 20（见〔裁〕3） |

踩到并修掉的：`get_webview_window("main")` 为 None（4.4）；最大化状态下退出与挪回时 window-state 记到屏幕外坐标（〔裁〕7、8；用修之前留下的坏状态启动一次，取消最大化时窗口确实跑到了屏幕外，修之后的状态文件里「最大化之前的位置」在屏上）。

另见：CDP 触发的打开之后页面 `document.hasFocus()` 为 false——Windows 不让非前台进程抢焦点，真人点托盘或悬浮窗时进程有前台权限，要在 PC 上看（第 7 节第 3 步）。

## 7. 待跨机项（PC 上做）

**出包**：`cd desktop && npm run release -- --from-head`（改了外壳，不能 `--patch-only`）。版本号先按第 8 节定好再出。出完在一台装好的 PC 上验：

1. **关窗不退出**：打开 PromptCut，点标题栏 ×。看：编辑界面消失、任务栏上没有它、Alt+Tab 里**不该**能切到一个看不见的窗口（若能切到，记下来：`set_skip_taskbar` 只去掉任务栏按钮，可能还要加工具窗口样式）；托盘里有 PromptCut 图标；屏幕右上角有悬浮窗「PromptCut 在后台运行」；任务管理器里 `promptcut.exe` 与 `node.exe` 都还在。
2. **收起时页面照常干活**：收起状态下在 AI 栏以外让 Agent 调一次 `side: "page"` 的工具（例如桌面 APP 会话调 `get_selection`，或命令行 Agent 调 `seek`），应当正常返回、不超时；过 5 分钟再调一次（Chromium 对隐藏页面的强降频 5 分钟后才生效），仍正常。SKILL 下让桌面会话做一次时间轴操作，悬浮窗下方应出现「上一步」画面。
3. **唤回**：托盘图标左键单击 → 编辑界面回到原来位置并在最前面、能直接打字；再关一次，单击悬浮窗 → 同上；托盘右键 →「打开编辑界面」→ 同上；收起状态下双击桌面快捷方式再启动一次 → 同上；最大化状态下关、再唤回 → 仍是最大化。
4. **悬浮窗**：按住拖动能挪位置，拖完不会弹出编辑界面。
5. **右键关闭才退出**：托盘右键 →「关闭」→ 托盘图标、悬浮窗消失，`promptcut.exe`、`node.exe`、`ffmpeg.exe` 都不在了；再开一次、收起后悬浮窗右键 →「关闭」→ 同上；再开，窗口出现在上次关之前的位置（不是屏幕外）。
6. **SKILL**：顶栏切到 SKILL → 编辑界面收起，悬浮窗写「SKILL 模式」和会话状态；让 Claude Code 连进来做事，悬浮窗写「Claude Code 正在……」；单击悬浮窗打开编辑界面，SKILL 仍开着、不会自己再收回；切回传统式 → 悬浮窗不再显示 SKILL。
7. **多显示器**（有的话）：副屏排在主屏左边，收起后副屏上不应看到窗口的任何一部分。
8. **补丁脚本经 `--quit` 干净退出**：装好 0.2.7 的完整安装包，开着 PromptCut（开一个 `.proc`、再把编辑界面收到后台），运行一份更新补丁（同代次、`--from-head` 出的即可）。看：补丁输出「正在关闭 PromptCut…」后几秒内就「已关闭」（不是等 10 秒再强杀）；补丁装完再开 PromptCut，窗口在收起前的位置；那份 `.proc` 旁边没有残留的 `.proc.lock`。再在 0.2.6 的机器上跑同一份补丁：窗口先被唤回，约 10 秒后被强杀，补丁照样装上。

## 8. 外壳版本号建议（没改，主会话合入时定）

`git_and_release.md` 的表：Node 那一半（A4）不依赖新外壳也能跑（老外壳上只是没有托盘、关窗仍直接退出、SKILL 收起本来就不起作用），属于「动了 Rust，但老外壳上能降级运行」→ **应用版本末位 +1，外壳 0.2.6 → 0.2.7**，`minShellVersion` 不动。A4 与 A5 同发，用户要拿到托盘与后台运行得装完整安装包；只装补丁的用户功能照常，只是没有后台运行。

## 9. 需要主会话 / 用户决定的事

1. **（一级，问用户）标题栏菜单「文件 → 退出」留不留。** 语义写「只有在托盘图标或悬浮窗上右键选择关闭，软件才退出」。现在它还在，退出时与右键「关闭」同一条路（先挪回原位、清子进程、放锁）。选项：a) 删掉（删用户看得见的功能，一级）；b) 保留并在语义里补一句「标题栏菜单的退出同右键关闭」（一级 dry run 见第 10 节第 2 条）。本段倾向 b，没改。
2. 〔裁〕3 的 WebView2 参数要不要保留（本机 A/B 没差别）。
3. ~~`apply-patch.ps1` 的关闭方式~~：主会话已定，本分支加了 `--quit`（4.7）。
4. 窗口标题栏 × 的无障碍名还是「关闭」（`src/ui/WindowTitleBar.tsx`，不在本段文件清单），是否改成「收到后台」之类，由主会话定。

## 10. 对计划与语义的更正建议（dry run，语义文件没改）

1. **`docs/semantics/mechanism/platforms.md`「桌面应用」加几条（三级）。**
   - 修改前：（「桌面应用」一节只有「可以请求本机的预渲染进程」和局域网跨源两条。）
   - 修改后（在两条后面加）：
     > - **后台运行**〔裁：2026-09-30 `claude/tray`，出处 `docs/plan/agent-workflow-plan.md` A5〕：
     >   - 收起编辑界面不隐藏窗口（WebView2 隐藏后停渲染，页面侧的 Agent 工具会停），而是把主窗挪到所有显示器最左边再往左一个窗宽加 256 像素，不进任务栏、不抢焦点；打开时回到原位（显示器没了就居中），原来最大化的再最大化。
   >   - WebView2 启动参数关掉遮挡判断与后台降频。
     >   - 进 SKILL 的那一下收起，之后用户打开的不再收回；回到传统式时若收着就打开。
     >   - 悬浮窗单击打开，右键与托盘右键相同两项：「打开编辑界面」「关闭」；SKILL 下显示桌面会话在做什么和上一步动作的画面。
     >   - 退出前把主窗挪回收起前的位置，下次启动窗口在原处。
2. **`docs/semantics/user-workflow.md`「后台运行」（一级，只 dry run，按第 9 节第 1 条的决定取舍）。**
   - 修改前：「……只有在托盘图标或悬浮窗上右键选择关闭，软件才退出。浏览器中关闭页面即结束本次编辑。」
   - 修改后（选 b 时）：「……只有在托盘图标或悬浮窗上右键选择关闭（或编辑界面菜单里的退出），软件才退出。浏览器中关闭页面即结束本次编辑。」
3. **计划 `docs/plan/agent-workflow-plan.md` 第 3 节 A5**：「沿用挪到屏幕外的做法或把绑定移到服务端」→「采用挪到屏幕外（外壳不 hide 主窗）；本机开发构建实测屏幕外页面照常可见、出帧，实机长时间运行在 PC 上验」。
4. **A4 报告 `docs/reports/AGENT-skill-mcp.md` 第 7 节「Rust 外壳没动」那条**补一句：老外壳里 SKILL 收起（`main.hide()`）其实从加 agent 子 webview 起就没生效过（`get_webview_window("main")` 为 None），悬浮窗也可能因启动参数不同建不出来；A5 已改。
5. **`docs/plan/TODO.md`「工作方式」**：「关闭编辑界面转为托盘和悬浮窗后台运行」合入后划掉；「文档」里挂的 `desktop/README.md` SKILL 悬浮窗几节已随本段改写。

## 11. 本机留下的东西

- `desktop/src-tauri/target/`（被忽略，几个 G）：本机检查与开发构建的产物，可以删。
- 会话临时目录 `scratchpad/tray/`：两个替身、开发构建、隔离运行用的临时用户目录。自己起的进程都已退出（`tasklist` 里没有 `promptcut.exe`）。
