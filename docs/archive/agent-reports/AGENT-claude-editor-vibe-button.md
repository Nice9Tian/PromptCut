# AGENT-claude-editor-vibe-button

分支 `claude/editor-vibe-button`（基于 `claude/vibe-wire`）。两件事：顶栏加「氛围式」那一格，以及**桌面版的氛围式**。

用户 2026-10-23 的两句话定的范围：

- 「在原版顶部加一个氛围式按钮（对应名词表的 vibe 式）然后把 UI 跑通。点击卡片进入传统式。不点的话左侧列表栏可以使用氛围式和 Agent 对话或者管理项目。」
- 「桌面版也要可以用。云端不是必须。因为聊天窗可以走用户的 CLI 或者 API。」
- `/goal`：「桌面版氛围式交给你在分支做好。完成后从 rust 壳启动做实际测试。」

## 做了什么

### 一、顶栏那一格（先做的那一半）

`src/editor/ModeSwitch.tsx` 从两格变三格：**氛围式 / 传统式 / SKILL**，顺序照 `user-workflow.md`「工作方式」那张表。

氛围式**是个去处，不是个状态**——人在编辑界面里就不可能同时在氛围式，所以滑块永远不会停在这一格；点它等于离开编辑界面、回到氛围式那一屏，从那儿点一张项目卡片又回到传统式。实现上它调 `TopBar.tsx` 的 `goVibe()`，和「回首页」共用 `pc-go-home` 这条路。

### 二、名词统一成「氛围式」

名词表和语义文档里原来写「Vibe 模式」。用户定「不留 vibe 式，扫描所有语义文档都换成氛围式，不解释原名」，已全部换完（`glossary.md`、`user-workflow.md`、`docs/plan/user-decisions-2026-10-23.md`、`docs/plan/release-021-rulings.md`）。

### 三、桌面版的氛围式（这一轮的主要工作）

原来氛围式那一屏只有在线浏览器有，桌面版那一格是置灰的。现在两边都有。

新增三个文件：

| 文件 | 管什么 |
|---|---|
| `src/start/vibeAgent.ts` | 聊天页和 Agent 之间的那层约定（`VibeAgent`）。原来 `ChatView` 认的是云端那一份的具体类型，现在认这个接口 |
| `src/start/useVibeLocal.ts` | 把 AI 栏那一套（`useAiChat` + `agentTabs` + `chatQueue`）翻成 `VibeAgent` |
| `src/start/DesktopStart.tsx` | 桌面版的氛围式那一屏 |

界面部件（顶栏、侧栏、说一句话的输入框、项目那一排、聊天页、右侧拓展栏、详细编辑）和在线那一屏**共用同一批**，只换数据来源：

|  | 在线浏览器 | 桌面版 |
|---|---|---|
| 身份 | 网站账号 / 游客 | 没有账号，就是这台机器（顶栏不出现账号那一块） |
| 项目 | 云端文档服务的项目列表 | 本机草稿（`src/editor/io/drafts.ts`，和传统开始页「本地草稿」是同一批） |
| 对话 | 云端 Agent | 本机的 CLI / API Agent，**和编辑界面 AI 栏是同一段对话**（同一套 `agentTabs` 分页） |
| 画面、详细编辑 | 一样 | 一样（读的都是 store 里的当前项目） |

进出口：

- 传统开始页顶上加了「氛围式」，点它进；地址记成 `?ui=vibe`，**刷新后还在这一屏**。
- 编辑界面顶栏那一格「氛围式」桌面版不再置灰，点它回这一屏。
- 氛围式顶栏右边的「拓展与存储」回传统开始页——打开项目文件、加入别人的项目、拓展功能、存储这四块只有那一页有。
- 顶栏「配置 Agent」开的是编辑界面 AI 栏那同一个配置窗口；选好之后那颗键显示成「Agent：Claude Code」。

**桌面版的缺省仍是传统开始页**。「在线浏览器登录后的默认界面」那一条（`user-workflow.md`「工作方式」）说的是在线；改桌面版的缺省界面是一级改动，不由会话定，留给用户拍板。

### 四、自动保存（实测挖出来的）

第一轮实测发现：氛围式里 Agent 改完项目，一回首页就没了——这一屏没有「保存项目」那颗键，而编辑器是手动存的。语义里本来就写着「草稿自动保存在本机」（`workflow/project.md`），所以按语义补上：

- `DesktopStart.tsx`：改动落定（这一轮跑完）后 2.5 秒存一次；换项目、进传统式之前各存一次。
- `TopBar.tsx` 的 `goVibe()`：桌面版**先把草稿存了再走**，不像「回首页」那样只警告一句。存的只是本机草稿、不是用户另存过的那个 `.proc`，所以不清脏标记，顶栏那颗「*」照旧提醒文件还没写。在线页面没有本机草稿这回事，仍旧先问一句。

## 验证

### 真跑一遍：从 Rust 壳启动

`scripts/probes/vibe-desktop-probe.mjs`（新增）。**跑在真的桌面壳里**，不是浏览器标签页：

- Tauri 壳给自己的 WebView2 开了调试端口（`desktop/src-tauri/src/agent_webview.rs`），探针连那个端口拿到主窗那一页，再点、再截图——截的就是桌面应用窗口里的内容（截图上能看到 PromptCut 自己的标题栏「文件 编辑 视图 帮助」和 Windows 的窗口按钮）。
- 壳里跑的是本分支：壳启动时先探 5210，**探到已经有一份在服务就不自己起 sidecar，直接导航过去**（`lib.rs` 的 `existing_instance`）。所以先在这个 worktree 里起 `vite --port 5210`，壳里显示的就是本分支。

走的路与结果（最后一行 `{"ok":true, "fails":[]}`）：

| 步 | 验到什么 | 图 |
|---|---|---|
| classic | 传统开始页上多了「氛围式」 | `01-classic-start.png` |
| vibe | 点它进氛围式那一屏；地址 `?ui=vibe`；顶栏没有账号那一块；空态写「本机还没有项目」 | `02-vibe-home.png` |
| reload | 刷新后还在这一屏 | — |
| say | 说一句话 → 按这句话命名的本机项目建好、进聊天页、这句话在对话里；侧栏多一个项目 | `03-chat-after-say.png` |
| agent | 本机 Agent（Claude Code）真的接上并开跑；输入框下面写「在本机运行，关掉软件这一轮就停了。」 | `04-agent-reply.png` |
| autosave | 没按任何保存键，草稿已自己落盘 | — |
| chats | 「新对话」真的多出 Agent 2（= AI 栏的第二个分页） | `05-two-chats.png` |
| home | 回首页，新项目列在侧栏和那一排里，带时长和「上次打开」 | `06-home-with-project.png` |
| ext | 右侧拓展栏打得开（画面 / 修改前 / 修改后） | `07-ext-panel.png` |
| detail | 详细编辑打得开，真舞台真时间轴；舞台宽高比 `1080 / 1920`，证明开始页上点的 9:16 真落下去了 | `08-detail-edit.png` |
| editor | 「进入传统式」进编辑界面；顶栏三格，**氛围式那一格不再置灰**；AI 栏里就是刚才那两个 Agent 分页 | `09-editor-modeswitch.png` |
| back | 点顶栏「氛围式」回这一屏；**没有弹「有未保存的改动」**（已经先存了） | `10-back-to-vibe.png` |
| classic-again | 「拓展与存储」回传统开始页，地址上的 `?ui=vibe` 去掉 | `11-classic-again.png` |

自动保存的硬证据：这一轮跑完之后盘上那份草稿是

```
{"id":"20261023-qm9rsi","name":"做一支 15 秒的产品短片，开头一句话点题 de…","clips":10,"duration":20,"size":4642}
```

10 个片段、20 秒，全是本机 Agent 做的，用户一次保存都没按过。

### 基线

- `npx tsc -b --force`：零错误。
- 受影响的测试 43 项全过：`src/layering.test.mjs`（分层守门）、`src/pageNodeImports.test.mjs`、`src/start/treeState.test.mjs`、`src/start/vibeOrg.test.mjs`、`src/editor/io/localWrites.test.mjs`、`src/editor/io/procWrite.test.mjs`、`src/editor/saveLock.test.mjs`。
- `server/test/c10a-online-build.test.mjs` 11 项全过——其中 C10A-API-03（在线产物的 `/api/` 路径棘轮）和 C10A-API-07（在线产物里没有桌面专用标识）说明 `DesktopStart` 确实被在线构建剪掉了，没有混进在线包。

### 五、详细编辑的时间轴做成可调（同日补）

本报告上一版把「详细编辑的时间轴改不了」列成语义冲突交给用户。用户 2026-10-23 的裁定是：**把时间轴做成可调，在这一支里做**。做完之后那条冲突就没有了，语义里那句话（`user-workflow.md`「工作方式」的「那里的时间轴可调」）不用改。

做法是**不另画一条**，直接挂编辑界面那条真时间轴（`src/editor/timeline/` 的 `TimelineView`）：

- 原来的 `DetailEdit.tsx` 自己画了一套只读轨道（序列名一列 + 色块，拖不动）。现在整段换掉，行高、缩放、剪辑标签都用它自带的那一条工具栏，这一页不再另给一套。拖动、裁剪、跨序列、吸附、分割、复制、静音、置顶置底、删除、「拖到这里新建一条序列」全都跟着来了。
- `TimelineView` 新增一个可选 prop `quoteClip`：**右键菜单顶上多一项「引用到输入框」**。这是详细编辑独有的（编辑界面没有那个输入框，不传就不出现）。它只读不写，所以只读成员（游客）也给。
  串下去的路：`TimelineView` → `TimelineProvider` → `useTimelineContext` → `ClipView` 的右键菜单。
- `start.css` 里 `.ps-detail-tl` 从 `flex: 0 0 auto` 改成定高（真时间轴是 `h-full`，框没高度会塌），顺手删掉只给那版只读轨道用的约 2 KB 样式。
- 一并改掉另外两处还写着「只看不改」的说明：`src/start/OnlineStart.tsx` 的文件头、`docs/plan/user-decisions-2026-10-23.md` 的更正那一节（加一句「代码同日跟上」）。

**在线那一屏也跟着变了**：`DetailEdit.tsx` 是两边共用的，所以在线浏览器的详细编辑同样换成了真时间轴。只读成员照旧拖不动（`ClipView` 的 `frozen` 认 `useReadOnly()`）。

## 验证（时间轴那一段）

探针加了两步，都在真壳窗口里：

| 步 | 验到什么 | 结果 |
|---|---|---|
| detail | 详细编辑里挂的是 `[data-pc="start-detail-tl"] [data-pc="timeline"]`，也就是编辑界面那条真时间轴 | `realTimeline: true` |
| drag | 按住一段往右拖，再从 store 里读它的起点 | `start 1 → 2.2`（`selAfterDown` 证明按下那一刻它被选中了，`at` 证明指针落在 `.pc-clip` 上） |
| ctxmenu | 右键菜单的全部项 | `["引用到输入框","复制","静音片段","调整声音音量…","音画分离","在播放头处分割","置顶","置底","删除"]` —— 真时间轴那一套，加上这一页独有的第一项 |

拖的那一段由探针自己放（`addCardClip`），不等模型：这一步验的是「拖得动」，不该卡在等 Agent 干活。

全套十二步 `{"ok":true,"fails":[]}`；`tsc -b --force` 零错误；受影响测试 68 项全过（在上一轮基础上加了 `src/editor/timeline/*.test.mjs`、`src/editor/readOnly*.test.mjs`、`src/editor/userEditingCore.test.mjs`）。

## 待用户项

1. **桌面版的缺省界面**。现在缺省仍是传统开始页，氛围式要点一下。用户说过「以后 vibe 式是默认状态」，但那句话的上下文是在线浏览器；桌面版改缺省是一级改动，等用户明说。
2. **合并顺序**。这一支基于 `claude/vibe-wire`，要等它先合进 main，再合这一支。
3. `scripts/probes/vibe-start-probe.mjs`（在线那条探针，`claude/vibe-wire` 写的）里记录详细编辑时还在读 `.ps-detail-lane` / `[data-pc="start-detail-clip"]` 这两个已经不存在的选择器。它只是**记录**，不参与判定，所以探针不会因此变红；没去改它是为了少跟那一支抢同一个文件。合并之后顺手改掉即可。

## 这一支动过的文件

新增：`src/start/vibeAgent.ts`、`src/start/useVibeLocal.ts`、`src/start/DesktopStart.tsx`、`scripts/probes/vibe-desktop-probe.mjs`、本报告与 `docs/reports/AGENT-claude-editor-vibe-button-shots/`。

改动：`src/StartPage.tsx`、`src/editor/ModeSwitch.tsx`、`src/editor/ModeSwitch.css`、`src/editor/TopBar.tsx`、`src/editor/timeline/index.tsx`、`src/editor/timeline/TimelineContext.tsx`、`src/editor/timeline/ClipView.tsx`、`src/start/ChatView.tsx`、`src/start/DetailEdit.tsx`、`src/start/OnlineStart.tsx`、`src/start/TopBar.tsx`、`src/start/start.css`、`src/start/useVibeCloud.ts`、`docs/semantics/glossary.md`、`docs/semantics/user-workflow.md`、`docs/plan/user-decisions-2026-10-23.md`、`docs/plan/release-021-rulings.md`。

和 `claude/vibe-wire` 的重叠：`ChatView.tsx`（换了 prop 的类型，两行）、`start/TopBar.tsx`（账号那一块改成可选）、`useVibeCloud.ts`（`VibeCloud` 改成继承 `VibeAgent`，加三个字段）、`DetailEdit.tsx`（时间轴整段换成真时间轴）、`start.css`（`.ps-detail-tl` 改定高，删掉只读轨道的样式）、`OnlineStart.tsx`（文件头一句话）。`src/editor/timeline/` 那三个文件只加了一个可选 prop，编辑界面不传就和原来一模一样。
