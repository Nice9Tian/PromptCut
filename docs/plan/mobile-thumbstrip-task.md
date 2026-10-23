# 任务书：手机版传统式的缩略时间轴要能显示出东西

2026-10-23 用户在 0.7.21 发版会话里当场加的一项。用户原话：

> 额外派Agent去解决下手机版-传统式-缩略时间轴。有时候显示不出来任何东西（有时候只有动画卡片）。需要一个算法来精简的匹配。这个不是主要功能，先跑通（能显示出来东西，开始时间-结尾时间都有缩略图）合并入即可，不要挡住发版（我授权）。

分支 `claude/mobile-thumbstrip`，worktree `.worktrees/mobile-thumbstrip`，报告 `docs/reports/AGENT-claude-mobile-thumbstrip.md`，端口段 **6450～6459**。随 0.7.21 发，但**不挡发版**：到发版那一刻没做完就留在分支上，记进报告。

## 症状

手机版（传统式工作方式）的缩略时间轴有时**一个块都不显示**，有时**只显示动画卡片**。

## 已经定位到的直接原因（主会话读代码所得，实施者要自己复核）

`src/mobile/mainContent.ts` 的「主要内容」只认三种段：

```
isMainKind() → clipKind(p, clip) 是 "video" | "image" | "cut"
```

`clipKind()` 对没有 `mediaId`、没有 `cutId` 的段回 `"card"`，而卡片段不算主要内容。于是：

- 整条时间轴只有卡片段的项目（纯动画、纯文字、纯特效），`mainClipsOf()` 回空数组 → 缩略时间轴什么都没有。
- `mainTrackOf()` 从最底下一条往上找「有主要内容的那条」，都没有就回最底下那条；但 `mainClipsOf()` 随后又按 `isMainKind` 过一遍，所以这条兜底实际上兜不住。

文件头上本来就记着这件事：

> TODO(用户 2026-10-20，演示稿 `prototypes/mobile-ui-demo/index.html` 的 `mainClips()`)：要有自动判断「主要内容」的算法，按内容判断哪些片段算主要内容；现在先按主轨取。

这次就是把这条 TODO 做掉，但**只做到「跑通」**：精简、能显示、不追求聪明。

## 要做到什么（验收标准）

1. **任何项目都显示出东西**：包括只有卡片段的项目、只有一个段的项目、段之间有空档的项目、有转场的项目、有剪辑段嵌套的项目。缩略时间轴不出现「整条空白」。
2. **开始时刻与结尾时刻都有缩略图**：第一个块对应时间轴起点那一刻、最后一个块对应结尾那一刻，两端都要有图。能取到真画面的取真画面（视频取入点那一帧、图片取缩略图，走现成的 `usePreviewMediaUrl` / `thumbs.ts`，不另造取素材的路）；取不到真画面的（卡片段等）照现有兜底办：取色底色 + 类型图标 + 时长，**不留空白、不出破图**。
3. **主要内容的选取算法写清楚**：规则写在 `mainContent.ts` 的文件头里（几句话能说完），并有**纯函数单测**覆盖上面第 1 条列的每一种项目形状。建议的最简规则（实施者可以改，改了要在报告里说明理由）：
   - 先按现在的办法取（主轨上的视频 / 图片 / 剪辑段 + 被它们溶解过去的后一段）；
   - 取到的块**覆盖不住整条时间轴**（空档超过某个比例，或一个都没取到）时，把其余序列上的段按时间补进来，一直补到能覆盖；补的时候同一时刻只留一个（挑持续时间长的那个，时长相同挑序列更靠下的），避免同一时刻冒出一堆块。
   - 阈值、取舍这类数字属三级，自己定，写进 `docs/semantics/mechanism/` 对应的那一本或代码注释，不要散落。
4. **顺序与时间对得上**：块按时间先后排；按住拖动 = 调整当前时间这套交互不许坏（`ThumbStrip.tsx` 里 `posFromScroll` / `timeAtCardPos` / `cardPosAtTime` 那一组）。
5. **不许回归**：手机版现有的测试（`src/mobile/*.test.mjs`，含 `thumbs.test.mjs`、`mobile.test.mjs`）全过；`npx tsc -b --force` 零错误。
6. **真看一眼**：用仓库里的 puppeteer 无头跑在线构建，手机仿真（390 宽）进一个只有卡片段的项目和一个有视频段的项目，各截一张缩略时间轴的图，图放 `docs/reports/AGENT-claude-mobile-thumbstrip-shots/`，报告里写清每张图证明了什么。内置浏览器窗格隐藏时 CSS 动画会停在第 0 帧、截图像空白，所以**不要用内置浏览器窗格截图**。

## 能改哪些文件

- `src/mobile/mainContent.ts`（主要内容的算法，主战场）
- `src/mobile/ThumbStrip.tsx`、`src/mobile/Thumb.tsx`、`src/mobile/thumbs.ts`（显示与取图兜底）
- `src/mobile/mobile.css`（只在布局挡着显示时改）
- 上述文件对应的测试：`src/mobile/*.test.mjs`（可新建 `mainContent.test.mjs`）
- 报告与截图：`docs/reports/AGENT-claude-mobile-thumbstrip*`
- 语义：见下一节

**别的文件一个都不要动**，特别是：桌面版时间轴（`src/editor/timeline/`）、`src/kernel/`、`server/`、别的 worktree。`src/mobile/` 下列表之外的文件（`MobileEditor.tsx`、`FullTimeline.tsx`、`MobileStart.tsx`、`sheets.tsx`、`ui.tsx` 等）**不要改**：另外三条在飞分支（`claude/guest-identity`、`claude/browser-start-ui`、`claude/clip-speed`）正在改它们，主会话最后要人工解冲突，你的 diff 越小越好。

## 语义怎么写

- 「缩略时间轴只放主要内容」是**一级**（`docs/semantics/workflow/editing.md`「手机版界面」），会话不许自行改。但「没有视频 / 图片 / 剪辑段时，卡片段也显示出来」这一条**是用户 2026-10-23 当场定的**（原话见本文开头），所以照用户的话写进一级那一句，并在括号里注明「2026-10-23 用户定」。
- 具体算法、阈值、取不到真画面时的兜底表现属**三级**，写进 `docs/semantics/mechanism/` 里手机版界面那一处（没有就近加一节），标〔裁：子 Agent <分支名> 2026-10-23，三级〕。
- 二级（用户看得到区别但用户没明说）的改动：标〔裁〕并**立刻在报告里单列一节**，主会话会当场打印给用户并记进 `docs/plan/release-021-rulings.md`。

## 规矩

- 规则从 `AGENTS.md` 进入（`docs/semantics/developer_guide.md` 索引的 `guide_files/`）。先读 `suggested_agent_behavior.md`、`constraints.md`、`multi_agent.md`。
- 开工先建报告文件并提交一次；每完成一块提交一次；**不推送、不合并、不切别的分支**。
- 跑测试只跑受影响的文件，**不要跑全量 `npm test`**（主会话在最终 main 上统一跑一次）。跑测试的那条命令里设这两个环境变量，**必须用反斜杠**：
  - `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`
  - `PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`
- 起任何开发服务器 / 探针一律带 `PROMPTCUT_NO_PORT_FILE=1`，端口只用 6450～6459，不要碰 5190～5192、5203 和 6410～6449（别的 Agent 在用）。
- 子进程静默后台运行（Node `windowsHide: true`，PowerShell `-WindowStyle Hidden`），不把窗口弹到前台。
- 不碰用户常驻的编辑器、桌面版运行时副本、用户数据目录；不结束不是自己启动的进程；不动宿主机网络。
- `docs/local.md` 里的值不许打印、不许写进提交与报告。

## 报告要写什么

`docs/reports/AGENT-claude-mobile-thumbstrip.md`：做了什么（按提交列）、最终选的算法规则与为什么、验收六条逐条的结果与证据（命令原样输出的关键行、截图路径）、没做成的与原因、对任务书或语义的更正建议、标了哪些〔裁〕（二级单列一节）。
