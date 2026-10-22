# AGENT-claude-guest-readonly-ui

分支 `claude/guest-readonly-ui`（自 `claude/guest-identity` 6ed389ac 切出）。任务：游客进别人的项目（`viewOnlyReason() === 'read-only-member'`）时，编辑器界面一眼看得出改不了，而不是点了才被服务端拒。

状态：做完，等主 Agent 审，没有推送、没有合并。验证结果见「验证」。

## 做了什么

### 核心（新文件，都在 `src/editor/`）

| 文件 | 作用 |
|---|---|
| `readOnlyCore.ts` | 不依赖 React 的一半：`memberReadOnlyNow()`（只认 `read-only-member`，`?observe` 不算）、`readOnlyState(locked)`（`why` 永远是 `viewOnlyText()`，`title(own)` 锁着回那一句、没锁回控件原来的）、`blockedByReadOnly()` |
| `readOnly.ts` | 组件里用的 `useReadOnly()` / `useMemberReadOnly()`。权限变化时重渲：按需（动态 import）订阅同步管理的通知，**不静态引用** `syncManager`（见下「验证」里第一次全量跑出的三处红） |
| `ReadOnlyFence.tsx` + `readOnly.css` | `<ReadOnlyFence>`：一块表单整体进 `<fieldset disabled>`，值照常显示，悬停是那一句，`display: contents` 不改排版；`<ReadOnlyMarker>`：给 `<html>` 打 `data-pc-readonly="member"` 和 `data-pc-readonly-why`（样式表和 `src/ui` 里的标题栏凭它认） |
| `readOnlyKeys.ts` | 快捷键闸：Delete / Backspace / Ctrl+Z / Ctrl+Y 在 window 捕获阶段先拦（`Editor.tsx` 不在我的清单里，见「没做成」） |

### 覆盖的控件

读写、没进共享项目、`?observe=1` 三种情况下，下面每一项都和原来一样（单测 + 探针都对照过）。

| 区域 | 只读项目里 |
|---|---|
| 顶栏 | 徽标「只能查看」（悬停是那一句）；撤销 / 重做置灰；点项目名不进改名；「保存项目」「打包保存」悬停改成那一句；「项目设置…」能打开但设置项全禁用、「确定」置灰、只剩「关闭」；桌面标题栏菜单里撤销 / 重做 / 保存项目压暗且点了不做；**导出照常** |
| 时间轴 | 片段不能拖、不能拽边（没有拖把手），点一下照常选中；右键只有一行灰字说明（有字幕的素材段留「查看字幕」）；行头静音 / 隐藏 / 锁定置灰、不能拖动换序、不能双击改名、右键「删除序列」置灰；「+ 序列」置灰；「新建序列」落区不画；往时间轴拖卡片 / 素材落不下去（不接 dragover、不记拖放载荷）；字幕条能点着跳转、不能拖 / 拽边 / 双击改字、右键只有说明；剪辑标签：不能新建、改名、切换、关激活的那个 |
| 编辑分区 | 参数面板（开始 / 结束、换卡、所有参数控件、三维、部件、音频、滤镜、剪辑段）整块进围栏；「按住标签左右拖」改数字这类指针控件在处理函数里拦；代码页文本框 `readOnly`（能选中能复制）、「参数重置」置灰、Tab / Ctrl+Enter / 失焦都不应用；节点页本来就是只读的图 |
| 左栏 | 素材库「导入媒体」置灰、空组里的「导入…」占位不出；卡片、部件、素材、音频、转场、强调、滤镜、音频效果、音频预设、主题、剪辑格：不能点、不能拖（`draggable=false`）、悬停是那一句、压暗；素材右键里只留「查看字幕」；字幕分区的「导入 .srt/.vtt」「转写」「铺成字幕轨」「重新转写」置灰 |
| 预览 | 移动、文字工具置灰（选择可用，工具状态强制回「选择」）；右键菜单里「删除」「引用到 AI」置灰；**播放 / 暂停 / 拖播放头 / 看画面照常** |
| 右栏 Agent | 编辑框、发送、附件、「加入队列」、一键配特效、新对话、停止全部禁用，占位文字是那一句；开始页换成「只能查看」说明（预设按钮禁用、没有引导动画）；**对话历史、历史对话、诊断报告照常能读** |
| 不在组件里的路径 | `importMediaFiles` / `importVideoFiles` / `importSrtFile` 在只读时直接抛 `viewOnlyText()`（拖放之类没盖到的路）；`AiPanel` / `CloudAiPanel` 的 `handleSend` 兜底；时间轴「总时长跟着内容走」的自动改写（`durationSync.ts` 和 `timeline/index.tsx` 的 effect）在只读时不做 |
| 手机版 | 顶栏下多一条说明条（手机没有悬停，置灰按钮得有一句话讲清为什么）；子导航栏整排置灰；撤销 / 重做置灰；缩略条长按换顺序、完整时间轴拖动平移 / 改起止 / 对齐按钮不接；Agent 输入区换成那一句说明（开始页同桌面）；**播放、导出、点选看时间轴、读对话照常** |

### 设计决定

1. **导出放开。** 导出只读项目、把成片写到本机，不写项目、不碰云端项目文档。按钮保持可点；只验到「可点」，没有在只读下真跑一次导出（见「没做成」）。
2. **`?observe=1` 不并进来。** 新加的锁只认 `read-only-member`；observe 的行为（保存置灰、徽标、不连桥）原样。两个来源同时有时权限那条优先（`viewOnlyReason()` 本来就这样排）。唯一的字面变化：observe 下「保存项目」「打包保存」置灰时的悬停，从「只读查看模式:改不了这个项目」换成 `viewOnlyText()` 那一句（「这是只读查看模式，改不了这个项目。」），因为任务要求别处不自己编句子。
3. **围栏用 `<fieldset disabled>`** 而不是给每个控件加 `disabled`：参数面板几十个控件，逐个加迟早漏。`NumberField` / `RangeField` / 下拉 / 勾选 / 颜色都是原生元素，一网打尽；围栏管不到的（自绘的指针控件）单独在处理函数里拦。
4. **切换剪辑算写。** `activeCutId` 在项目文档里，`switchCut` 会进撤销栈、会被同步出去、服务端会拒，所以只读下不能切到别的剪辑看（标签、剪辑组、双击剪辑段都不给）。这是现有数据模型的后果，不是我加的限制；要看别的剪辑得有「只在本机界面上看哪条剪辑」的概念，要产品拍板（见「需要你决定」）。
5. **自动写也要拦。** 时间轴会在挂上时按内容末尾自动改项目总时长。游客打开一个总时长和内容末尾对不上的项目，每次进来都会自己发一个写、被服务端 403。已拦。

## 截图

探针 `scripts/probes/guest-readonly-ui-probe.mjs` 截的，全在 `docs/reports/AGENT-claude-guest-readonly-ui-shots/`。

- 读写对照：`rw-full.png`（选中一个片段、编辑分区打开，输入区有引导动画、撤销可点）
- 只读整页：`ro-full.png`：顶栏「只能查看」徽标，撤销 / 重做压暗，右栏「只能查看」说明、编辑框和发送压暗，「+ 序列」和行头图标压暗，动画分区里的卡片格压暗
- 时间轴右键：`ro-timeline.png`（只有一行灰字说明）
- 参数面板：`ro-params.png`（值照常显示，开始 / 结束、换卡下拉、重置、三维滑块和数字框全部压暗）
- 素材库：`ro-library.png`（「导入媒体」压暗）
- 项目菜单：`ro-project-menu.png`（保存项目、打包保存压暗，项目设置可点）
- 项目设置：`ro-settings.png`（顶上一行说明，设置项禁用，只剩「关闭」）
- `?observe=1`：`observe-full.png`（徽标仍是「只读查看」，编辑器其余部分和读写一样可用）
- 手机版：`ro-mobile.png`（说明条 + 子导航栏整排压暗）、`ro-mobile-agent.png`、`ro-mobile-timeline.png`

悬停说明（`title`）在无头截图里画不出来，用探针逐项断言 `title === viewOnlyText()`。

## 验证

以下都在最终提交 99168825 上。

1. 类型检查

```
npx tsc -b --force        → 退出码 0，无输出
```

2. 全量测试（先设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`）

```
npm test
ℹ tests 7741   ℹ pass 7726   ℹ fail 0   ℹ cancelled 0   ℹ skipped 15
✓ npm test 最终结果：零失败        退出码 0
```

`multi-agent-presence` 和 `user-editing` 这次没红，没有重跑。

**第一次全量跑（提交 f889600b）红了三处，都是我的改动引起的，已修，最终那一次全绿：**
- `C10-TITLEBAR-01`（`server/test/c10a-online-build.test.mjs`）：它要求桌面产物里标题栏菜单项的 `disabled` 是恒假的常量。我最初给撤销 / 重做 / 保存加了动态 `disabled`。改成保留原来的 `disabled`，另加 `aria-disabled` + 压暗 + 点了不做。
- `Composer renders account stop authority…`（`src/ai/cloud/account-conversation-controls.test.mjs`）：它按名字替换 Composer 的依赖，我新加的 `../../readOnly` 没人替换。改成 Composer 不自己订阅权限，由 `AiPanel` / `CloudAiPanel` 通过新的可选 props `readOnly` / `readOnlyReason` 传进去（没改那个测试文件）。
- `C10A-MODE-01`（`src/online/modeImportGuard.test.mjs`）：`ClipView → readOnly → syncManager → online/mode.ts` 的静态引用链，Node 单测载入时会抛。`readOnly.ts` 改成按需 `import("./sync/syncManager")` 再订阅。

3. 新单测（14 条，全过）

```
node --experimental-test-module-mocks --test src/editor/readOnly.test.mjs src/editor/readOnlyRender.test.mjs
```

- `src/editor/readOnly.test.mjs`：RO1 权限开关（读写 / 只读 / 退出项目 / 乱传）；RO2 observe 不并进来、两个来源并存时权限优先；RO3 说明永远是 `viewOnlyText()`；RO4 快捷键闸（Delete / Backspace / 撤销 / 重做被拦，空格、输入框里的键不拦，装两次只挂一份）；RO5 只读时拖放载荷不记；RO6 总时长自动对齐只读下不做、读写下做（对照）。
- `src/editor/readOnlyRender.test.mjs`（组件按标记渲染，依赖换桩）：RR1 围栏；RR2 预览工具条；RR3 开始页；RR4 预览卡（标 `edits` 的才锁）；RR5 音频条；RR6 预览右键菜单；RR7 序列行头；RR8 Agent 输入区（含停止、加入队列、「对话没有读取权限」那条原因优先）。每条都同时断言只读、读写、`?observe` 三种。

4. 浏览器探针（真 Chrome，看图 + 断言）

```
node scripts/probes/guest-readonly-ui-probe.mjs --mobile
{"summary":{"total":43,"failed":0,"failedChecks":[]}}
```

43 项全过，分组如下（探针文件头逐条写了验收）：
- R0 读写基线（撤销、「+ 序列」、导入、拖把手、行头按钮、三个预览工具、输入区、参数面板都可用，没有只读标记）
- R1 切成只读（`<html>` 标记、徽标）
- R2 时间轴：行头 / 「+ 序列」/「新建剪辑」置灰且悬停是那一句；没有拖把手；**真拖一个片段、真按 Delete、真右键，项目内容一个字节不变**；点一下仍能选中；右键只有说明；合成的 HTML5 拖放事件被拒、没加片段、「新建序列」落区不画；`importMediaFiles` 抛 `viewOnlyText()`
- R3 参数面板：全部控件禁用（18 个里除了与表单无关的折叠钮全禁用）；代码页文本框只读
- R4 素材库 / 动画：导入置灰；卡片格 `aria-disabled`、不可拖、点一下不加片段
- R5 预览：移动 / 文字置灰、播放照常、导出可点
- R6 Agent：编辑框 / 发送 / 预设禁用，占位是那一句，无引导
- R7 顶栏：撤销重做、改名、项目菜单、设置对话框、桌面标题栏菜单
- R8 `?observe=1` 老路没变
- R9 切回读写后全部恢复，对照的拖放落点重新接受
- M1～M3 手机版（另起一台 `vite --mode online`，`?layout=mobile`）：说明条、子导航栏、撤销置灰、播放与导出照常、Agent 输入区、时间轴点选后拖动不动（**同一动作在读写下会动**，作对照）、对齐按钮置灰

端口只用了 5243（编辑器，舞台 5244、5245）和 5246（手机版，5247、5248），探针自己起、自己收。没有碰 5190～5192、5203、5213、5223、5230～5239。主工作区的 `.claude/launch.json` 一个字没动（探针自己起 dev server，不需要加配置，所以也没有要还原的）。

## 没做成的及原因

1. **「游客」的真实路径没有端到端走过。** 探针里权限是用 `setProjectAccess('r')` 加一次 `pushToast` 的状态通知拨的，没有真去走 syncManager 进项目收到 `access: 'r'`。那一段（服务端发权限 → `SharedView.access` → `patch()` 拨）是主 Agent 那边的，界面这一侧只依赖 `viewOnly.ts` 的接口，我验的是接口之后的部分。
2. **没有在只读下真跑一次导出。** 只验了导出按钮可点。理由「导出不写项目」是读代码得出的，没有实测导出过程中有没有任何写。
3. **`src/Editor.tsx` 不在清单里**：它里面接 Delete / 撤销快捷键。我用 window 捕获阶段的监听（`readOnlyKeys.ts`）从外面拦，靠「监听早挂、先到」。最干净的做法是在 `Editor.tsx` 那个 `onKey` 里直接判断，或者在 store 的 `actions` 层加一道只读闸（见「更正建议」）。
4. **没有 store 层的闸。** `src/store/**` 不在清单里，所以所有拦截都在界面层。我认为有界面没盖到的写路径（比如 MCP 工具通道、将来新加的按钮）时，只有服务端那道会兜底。
5. **手机版的几个浮层没逐个改**：`AssetsSheet`、`CardsSheet`、`ClipsSheet`、`ParamsSheet`、`ConflictSheet` 里的写操作没加只读判断，因为进它们的入口（子导航栏、缩略条的「+」）都已经封了。成员面板（`MembersSheet`）没动。
6. **没做的界面**：项目设置里「多用户协作」那一段（`CollabSection`）没进围栏——游客在别人的共享项目里它的勾选框本来就禁用（`isOn && !iAmCreator`），「确定」我已经置灰；历史对话抽屉里的删除对话、Agent 分页的新建 / 关闭，是对话本身的权限，由服务端按对话判，没动；`ScriptPage`（剧本）存在本机 localStorage，不是项目内容，没动。
7. **悬停提示没有肉眼看过**（无头截图画不出 tooltip），只断言了 `title` 属性。浏览器对禁用按钮和围栏里禁用控件的 tooltip 行为，我没有在有头浏览器里确认。

## 对任务书或语义的更正建议

1. **`viewOnlyText()` 一句话不够贴切。** 「你在这个项目里只能查看，改不了内容。」放在时间轴、参数面板上合适；放在 Agent 输入框的占位上，更贴切的是「……不能给 Agent 发消息」。任务书要求别处不自己编，所以我全用了那一句。如果想要两句，`viewOnly.ts` 里加一个 `viewOnlyAgentText()` 最干净（我不能改那个文件）。
2. **`viewOnly.ts` 缺一个订阅口。** 现在是「`setProjectAccess` 只改变量，靠 `syncManager.patch` 随后的通知让界面重渲」。这是隐含的先后顺序。如果 `viewOnly.ts` 自己带 `subscribeProjectAccess`，`readOnly.ts` 就不用动态 import 同步管理、也不依赖「同一个 `patch` 里先拨后通知」。建议顺手加。
3. **切换剪辑是写（见设计决定 4）。** 游客不能翻别的剪辑。如果产品上要允许，得把「当前看哪条剪辑」从项目文档搬到设备本地状态，这是数据模型的改动，不是界面能解决的。
4. **桌面标题栏菜单项「不置灰」是有构建守门测试的**（`C10-TITLEBAR-01`）。如果以后希望游客时它真置灰，要同时改那条测试。现在我是 `aria-disabled` + 压暗 + 不执行。
5. **`docs/semantics/workflow/editing.md`** 里没有「只读」一节；这次的行为（哪些能用哪些不能用、导出放开、切换剪辑不给）如果要写进语义，建议加在「用户交互修正」前面。语义归主 Agent 改，我没动。

## 需要你决定的

- 合并还是返工。
- 上面「更正建议」第 1、2 条要不要改 `viewOnly.ts`（我来改的话请说一声）。
- 第 3 条产品上要不要让游客翻别的剪辑。

## 提交

```
99168825 只读界面：权限订阅改按需载入（守门测试），输入区只读由面板传入，标题栏菜单项不用 disabled；探针补标题栏；截图
f889600b 只读界面：手机版加说明条、探针补手机时间轴拖动与读写对照
293ce836 只读界面：单测、浏览器探针与视觉压暗
3c729278 只读界面：手机版（子导航栏、缩略条与时间轴拖动、Agent 输入区）
5a80d8f9 只读界面：核心（readOnly、围栏、快捷键闸）与顶栏、时间轴、左栏、预览、右栏 Agent 输入区
d2cb16f8 开工：建只读界面任务报告
```

改动文件：`src/editor/**`（新增 `readOnly.ts`、`readOnlyCore.ts`、`readOnlyKeys.ts`、`ReadOnlyFence.tsx`、`readOnly.css`、两个测试文件；其余是在已有文件里接入）、`src/mobile/**`、`src/ui/WindowTitleBar.tsx`、新增 `scripts/probes/guest-readonly-ui-probe.mjs`、本报告与截图。没有碰 `src/account/**`、`io/viewOnly.ts`、`sync/syncManager.ts`、`server/**`、`docs/semantics/**`、`src/store/**`、`src/Editor.tsx`。
