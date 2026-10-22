# AGENT 报告：claude/browser-titlebar

任务（2026-10-22 用户当场提）：浏览器版（在线构建）不要「显示顶部菜单栏」和 − □ × 三个无用的按钮；桌面版要有、不变；不许把功能弄丢。

状态：做完，等用户决定合并。有一项守门测试要主 Agent 处理（见「没做成的」）。

## 改了什么（逐文件）

- `src/ui/WindowTitleBar.tsx`：`WindowTitleBar` 改成薄外壳，`ONLINE_BUILD ? null : <DesktopTitleBar />`；原来的整份实现改名 `DesktopTitleBar`，一行没动。判别用文件里已有的编译期常量 `ONLINE_BUILD`，不用运行时的窗口 API；在线产物里菜单、窗口按钮、`desktop_titlebar_command` 整段被剪掉（产物里核过，见下）。顶部那段旧注释（「在线页面上菜单置灰」）改成与现状一致。`STORAGE_EVENT`、`takeStorageRequest` 这两个给开始页用的导出没动。
- `src/editor/TopBar.tsx`：「快捷键」「关于 PromptCut」两段说明文字提成模块常量 `SHORTCUTS_TEXT`、`ABOUT_TEXT`（桌面标题栏发来的 `shortcuts`、`about` 命令照用同一份）；在线构建时（`ONLINE_BUILD &&`）在顶栏「⋯」菜单里「皮肤…」下面多两项「快捷键」「关于 PromptCut」，点了弹同一段说明。桌面构建里这两项被剪掉，「⋯」菜单与以前一样只有「皮肤…」。
- `src/ui/windowTitleBarOnline.test.mjs`（新）：构建在线、桌面两份产物到临时目录，核对上面的结果。
- `scripts/probes/browser-titlebar-probe.mjs`（新）：无头 Chrome 探针，自己起两台 dev server（5960 在线、5963 桌面，`PROMPTCUT_NO_PORT_FILE=1`），看真实 DOM 并截图。
- `src/Shell.tsx`、`src/ui/WindowTitleBar.css`：没改。标题栏不画之后 `.pc-app-content` 自然顶到页面最上沿（探针量得顶栏 top = 0；桌面是 44）。

## 七项菜单功能的去向表（在线构建里）

七项都是标题栏菜单里在线页面上没置灰的项。

| 菜单项 | 在线构建里还能不能用 | 入口 |
|---|---|---|
| 文件 · 导出视频 | 能 | 顶栏主按钮「导出视频」`src/editor/TopBar.tsx:816-822`（`<Btn … label="导出视频" primary>`，点了走 `run(() => exportProject())`）；此前就有，不是新加的 |
| 文件 · 返回首页 | 能 | 顶栏「首页」按钮 `src/editor/TopBar.tsx:796`（`<Btn onClick={goHome} label="首页">`） |
| 编辑 · 撤销 | 能 | 顶栏撤销按钮 `src/editor/TopBar.tsx:590-591`（`data-pc="undo-btn"`）；键盘 Ctrl/Cmd+Z（`src/editor/undoKeys.ts`） |
| 编辑 · 重做 | 能 | 顶栏重做按钮 `src/editor/TopBar.tsx:593-594`（`data-pc="redo-btn"`）；键盘 Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y（`src/editor/undoKeys.ts`） |
| 视图 · 皮肤… | 能 | 顶栏「⋯」菜单里的「皮肤…」`src/editor/TopBar.tsx:645-655`（`setSkinOpen(true)`）；此前就有 |
| 帮助 · 快捷键 | 能（**新入口**） | 此前只有标题栏菜单这一个入口。现挪进顶栏「⋯」菜单 `src/editor/TopBar.tsx:656-686`（`data-pc="more-shortcuts"`），仅在线构建 |
| 帮助 · 关于 PromptCut | 能（**新入口**） | 同上，`data-pc="more-about"` |

行号以本分支提交后的 `TopBar.tsx` 为准（上面这几处如有偏差，以 `grep -n 'label="导出视频"\|label="首页"\|data-pc="undo-btn"\|data-pc="redo-btn"\|皮肤…\|more-shortcuts\|more-about' src/editor/TopBar.tsx` 为准）。

查的范围：`grep` 了整个 `src/` 里「快捷键」「关于 PromptCut」「空格 播放/暂停」，说明文字只在 `TopBar.tsx` 的 `onCommand` 里，没有别的入口，所以那两项才挪。手机布局（`LAYOUT === "mobile"`）本来就不挂标题栏，没有受影响。

菜单里在线本来就置灰的项（新建、打开、保存、打开导出文件夹/数据目录、存储、退出、配音设置、语音引擎相关、查看运行日志）：在线页面上点不动，藏掉菜单不算丢功能，不涉及。

小瑕疵：新加的两项在「⋯」菜单里是纯文字、没有图标（`src/ui/icons.tsx` 不在我可改的清单里，也没有合适的现成图标），所以文字没有跟「皮肤…」的图标对齐。要加图标需要放开 `icons.tsx`。

## 验证

门槛（2026-10-22 用户改定：只测改动影响到的部分，全量留到发版前）：

1. `npx tsc -b --force`：退出码 0，零错误（TypeScript 5.9.3）。
2. 测试（`npm test -- <文件>`）：
   - `npm test -- src/ui/windowTitleBarOnline.test.mjs`：`ℹ tests 2`、`ℹ pass 2`、`ℹ fail 0`、`ℹ cancelled 0`，退出码 0。
   - `npm test -- 'src/ui/*.test.mjs' 'src/editor/*.test.mjs'`：`ℹ tests 243`、`ℹ pass 243`、`ℹ fail 0`、`ℹ cancelled 0`，退出码 0（日志 29 KB）。含引用顶栏的 `src/editor/saveLock.test.mjs`。
   - `npm test -- server/test/c10a-online-build.test.mjs src/editor/saveLock.test.mjs src/online/cardRuntime/cardRuntime.test.mjs src/ui/windowTitleBarOnline.test.mjs src/ui/focusZoomReset.test.mjs`：`ℹ tests 41`、`ℹ pass 40`、`ℹ fail 1`。唯一失败是 `C10-TITLEBAR-01`，见下。
   - 没覆盖到的范围：全量测试没跑（按新门槛留到发版前）；`src/online/**`、`server/**` 其余测试没跑。
3. `npm run build`：退出码 0；`npx vite build --mode online`：退出码 0。产物核对：`dist-online/assets/*.js` 里没有 `titlebar-${`、`pc-titlebar-menus`、`应用菜单`；`dist/assets/*.js`（桌面）里都有。
4. 探针 `node scripts/probes/browser-titlebar-probe.mjs`：退出码 0，汇总 `{"summary":{"ok":true,"checks":8,"failed":0}}`（连跑两次都过；第一次开发期间 D3 因菜单收起的时序偶发超时，已在探针里补了等待）。各项：
   - O1 在线：`.pc-titlebar`、`.pc-titlebar-menus`、`.pc-titlebar-window-controls`、`.pc-window-control` 都是 0 个，应用菜单里没有按钮；
   - O2 在线：编辑器顶栏 top = 0，没有空占位条；
   - O3a/O3b 在线：「⋯」菜单项为 `["皮肤…","快捷键","关于 PromptCut"]`；点「快捷键」「关于 PromptCut」各弹出对应说明（dialog 文字对得上）；
   - O4 在线：撤销、重做按钮在，顶栏有「首页」「导出视频」；
   - D1 桌面：`.pc-titlebar` 在；菜单行 `["文件","编辑","视图","帮助"]`；窗口按钮 `["最小化","最大化","关闭"]`；顶栏 top = 44；
   - D2 桌面：「文件」菜单有「导出视频」「返回首页」，「帮助」菜单有「快捷键」「查看运行日志」「关于 PromptCut」；
   - D3 桌面：「⋯」菜单只有「皮肤…」，不重复那两项。

两张重点截图（`out/browser-titlebar/`，该目录被 git 忽略，只在 worktree 里）：

- `online-editor.png`：在线构建的编辑器页面（素材库、预览、Agent 面板、时间轴齐全），最上面直接是编辑器顶栏，没有「文件 编辑 视图 帮助」，右上角没有 − □ ×。我看过图。
- `desktop-editor.png` 与 `desktop-file-menu.png`：桌面模式同一个页面，顶栏上面多一条标题栏，左边「文件 编辑 视图 帮助」，右上角 − □ ×；点「文件」展开出新建项目…退出九项。我看过图。
- 另有 `online-more-menu.png`：在线顶栏「⋯」展开，三项「皮肤…」「快捷键」「关于 PromptCut」。

## 没做成的及原因

1. **守门测试 `server/test/c10a-online-build.test.mjs` 的 `C10-TITLEBAR-01` 现在会红**（失败信息：`在线产物里找不到标题栏菜单项（titlebar-${…}）`）。这条是 2026-09-28 的〔裁〕（「在线页面标题栏菜单同顶栏、桌面项置灰」）定的，断言的正是用户今天要去掉的东西。`server/**` 不在我可改的清单里，所以没动它。需要主 Agent 或用户放行后改写，我建议的改法：把它拆成两句——
   - 在线产物里没有 `titlebar-${`、没有 `desktop_titlebar_command`（取代原来「桌面项置灰、桌面壳命令剪掉」）；
   - 桌面产物里 `titlebar-${` 仍在、`disabled` 是常量假、没有 `onlineUnsupported`、`desktop_titlebar_command` 仍在（原断言的后半段，原样保留即可）。
   我新加的 `src/ui/windowTitleBarOnline.test.mjs` 已经覆盖了「在线没有、桌面有」的产物检查，所以改写时前半句可以直接删掉。该文件头部「C10-TITLEBAR-01」那段注释也要同步改。**合入 main 前必须先处理这一条，否则基线是红的。**
2. 新增的两个菜单项没有图标（见上）。

## 对任务书与语义的更正建议（不动 `docs/semantics/`，只写建议，请用户确认后再写）

1. 任务书说「`src/Shell.tsx:152` 无条件挂上」：属实，但我没改 Shell，由 `WindowTitleBar` 自己在在线构建里不画；效果一样、改动面更小。
2. 任务书说窗口按钮在第 238～242 行：属实。
3. `docs/semantics/product/platforms.md`「在线浏览器」一节建议补一句（放在「入口」那条之后即可）：
   - 修改前：（没有这一句；该节没提标题栏）
   - 修改后：`- **不画应用标题栏**（2026-10-22 用户定）：浏览器里没有应用标题栏（文件、编辑、视图、帮助菜单行，以及最小化、最大化、关闭三个窗口按钮），那些在浏览器里本来就没有作用；菜单里在线还能用的功能在编辑器顶栏上都有入口（导出视频、首页、撤销与重做、皮肤），「快捷键」「关于 PromptCut」放在顶栏「⋯」菜单里。桌面版的标题栏不变。`
4. 旧的〔裁〕要作废：C10 契约第 10 节「在线页面标题栏菜单同顶栏，桌面才有的项置灰」（2026-09-28，见 `src/ui/WindowTitleBar.tsx` 与 `server/test/c10a-online-build.test.mjs` 的旧注释）。该契约文档在 `docs/plan/`，不在我可改的范围，请主 Agent 处理。
5. `docs/semantics/workflow/project.md` 第 11 行「标题栏菜单另有『存储…』直达这里。在线浏览器没有这一块。」不用改，仍然成立。
