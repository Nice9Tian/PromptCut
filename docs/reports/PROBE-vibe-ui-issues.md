# 探针与验证结果：氛围式四个纯 UI issue（#11 #10 #6 #5）

分支 `claude/vibe-ui-issues`，2026-10-24。改动范围：氛围式开始页与聊天页的界面（`src/start/`），不碰渲染、不碰画面生成，
所以按 `docs/semantics/guide_files/verification.md`「按改动范围验证」不跑渲染附加项（G0-R）。

## 一、基线三项

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 通过，零错误 |
| 构建（含类型检查） | `npm run build` | 成功（`✓ built in 1.29s`） |
| 在线构建 | `npx vite build --mode online` | 成功（探针要用 `dist-online/`） |
| 影响范围内的测试 | `npm test -- src/ai/cloud/guest-chat-limit.test.mjs src/start/format.test.mjs src/start/orgMerge.test.mjs src/start/orgRealm.test.mjs src/start/orgSync.test.mjs src/start/orgTransport.test.mjs src/start/treeState.test.mjs src/start/vibeOrg.test.mjs src/tailwind-scan.test.mjs src/pageNodeImports.test.mjs` | 60 条全过，零失败 |

挑这几个测试文件的理由：改到的是 `src/start/` 下的界面文件和 `start.css`，上面这些是引用了 `src/start/` 的全部测试
（`guest-chat-limit.test.mjs` 直接比对 `ProjectSidebar.tsx` 源码），加上扫源码与页面入口的那两支。

## 二、探针

| 探针 | 命令 | 结果 |
|---|---|---|
| 在线氛围式真跑一遍 | `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=… PROMPTCUT_PASSWORD_ORDER_MODULE=… PROMPTCUT_NO_PORT_FILE=1 node scripts/probes/vibe-start-probe.mjs --dist dist-online --site-root <VisuHive>/site --out <目录>` | **通过**：最后一行 `{"ok":true, … ,"fails":[]}`，13 步全过，`pageErrors` / `serverErrors` 三个角色都是空。跑了两遍：四个 issue 改完之后一遍，搜索与新建并作一行之后又一遍，两遍都过 |
| 桌面氛围式 | `node scripts/probes/vibe-desktop-probe.mjs --cdp <端口>` | **没跑**：它要先起 Tauri 桌面壳、再连 WebView2 的调试端口，本次改动在壳外的页面里，已改用下面「三、手工验证」在 5203 上逐条看过 |

`vibe-start-probe.mjs` 里原来有一句无条件点「右侧拓展栏」开关；#6 之后拓展栏进会话就自己开了，再点一下反而关上，
所以那一句改成了「没开才点」（`vibe-desktop-probe.mjs` 同一处同样改）。这一支探针跑的是改完之后的代码，通过。

截图（探针自己出的）：

- `PROBE-vibe-ui-issues-shots/10-guest-home.png` —— 游客开始页。就是 issue #10 那一屏：「空白画布」和「这里还没有项目。点第一格的「Create A New」建一个。」都不在了；左侧是**一张**面板（#5）。
- `PROBE-vibe-ui-issues-shots/11-guest-chat.png` —— 游客进会话之后。探针**没有点**拓展栏开关，右侧「画面 / 修改前 / 修改后」自己就展开了（#6）。
- `PROBE-vibe-ui-issues-shots/search-open.jpg` —— 搜索框点开之后盖住「新建项目」的样子（手工截，桌面氛围式）。

## 三、手工验证（桌面氛围式，`npx vite --port 5203`，`/?ui=vibe`）

| issue | 怎么验的 | 结果 |
|---|---|---|
| #5 左侧列表栏统一成一个面板 | 开页面看侧栏 | 分组 / 项目 / 已归档在同一张面板里，段与段之间没有缝、没有各自的边框 |
| #10 冗余内容 | 看「最近项目」那一排 | 第一格底下只剩「新建项目」，没有「空白画布」；一个项目都没有时不再多一句「这里还没有项目…」。列表还在读、读不到时那句话照样出（`props.empty`） |
| #6 进会话后右侧拓展栏自动展开 | 新建项目 → 进聊天页 | 没点开关，右侧拓展栏已经开着 |
| #11 有项目时左侧栏自动展开 | 手动收起侧栏 → 刷新 | 侧栏自己滑开，`localStorage` 的 `pc.start.sideCollapsed` 写回 `0`；再手动收起，当次不再被弹开 |
| 搜索与新建并作一行、点搜索展开遮住新建（2026-10-24 用户追加） | 点搜索框 → 打字 → 移开焦点 → 点清空 | 搜索框向右滑开盖住「新建项目」（240ms），占位字从「搜索」换成「搜项目和对话」；有字时移开焦点仍不收；点 ✕ 或按 Esc 清空后滑回、新建键原样露出。侧栏拖到最窄 190px 时两样仍并排放得下 |

## 四、没跑的和为什么

- 渲染附加项（导出确定性、快照重放、与 main 的像素比对、预渲染探针）：这次只改界面结构与文案，不改渲染、舞台、卡片画面，按「按改动范围验证」不在范围内。
- 全量 `npm test`：按 2026-10-23 的规矩只在发版前跑。
