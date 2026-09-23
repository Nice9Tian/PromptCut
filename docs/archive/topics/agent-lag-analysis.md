# Agent 工作时编辑台为什么还卡:实测归因(2026-09-12)

三端分离(c8e3a71 / 08df898)挪走的是 **Agent 的读和渲染请求**(see_frames / get_project 走预渲染进程和数据镜像),
那一步解决的是「连接被挤满、页面发不出请求」。现在还卡的是另外两件事,都在**编辑台页面自己的主线程**上,
和连接数无关;而且都是「Agent 用得越久越卡」的形状。

测法:puppeteer 开编辑台(`?editor=1`,dev server 5197),灌东京 7 日项目(74 段 / 57 素材),用真实的桥
(`POST /api/mcp/call` → SSE → 页面执行 → `/api/mcp/result`)打一轮工具调用,同时记 PerformanceObserver 的 longtask、
rAF 间隔和 CDP 采样 profile(按函数 inclusive 时间归因)。脚本在会话 scratchpad 的 `lag-harness.mjs` / `chat-harness.mjs`。

## 数字

| 场景 | 主线程长任务 | 每次的代价 |
|---|---|---|
| 空闲(不调工具)6 秒 | 0 个 | 页面忙 9%(预览的 rAF 循环) |
| 60 次调用,读写混合(10 次 `update_clip`),播放头 3 s | 10 个,合计 742 ms | 读工具 3~14 ms;**写工具 ~75 ms** |
| 30 次 `update_clip`,播放头 3 s | 28 个,合计 1.84 s,最长 104 ms | **65 ms / 次** |
| 30 次 `update_clip`,播放头 60 s | 44 个,合计 9.6 s,最长 347 ms | **~320 ms / 次**,页面忙 94% |
| AI 面板:历史 10 轮 × 120 次工具,再流式加 100 个片段 | 每次更新 **~114 ms** | 历史 2 轮 × 30 次时只要 3 ms |

对照真实对话(对话诊断-20260911-142727):一轮 130~190 次工具调用,一场对话十几轮 —— 历史很快就到上面那个量级。

## 主因一:每次改项目,预览把活跃的卡**全部重挂载、从入点补跑到播放头**

`src/editor/Preview.tsx:327`:项目文档一变就 `stage.setProject(project)`。`src/StageView.tsx:364`:
片段布局(id / 卡 / 起止)变了立刻 `renderAt(t, { jump: true })`,只改参数则 200 ms 后也跑同一条;
`renderAt` 的跳转路(`StageView.tsx:~160-250`)把 `t` 附近活跃的卡全部重挂载,从最早的入点按项目 fps
**逐帧 `flushSync` 提交 React** 补跑到 `t`(上限约 6 秒 = 180 帧)。这是为了「预览所见 = 导出所得」刻意做的,
用户手动跳转一次感觉不到;但 Agent 每一次写(`update_clip` / `add_clip` / `set_position`……)都触发一次,
而且**连改视频段的不透明度这种根本不在舞台上的东西**也触发(`layoutKey` 只看 clip 表,`setProject` 不分素材段和卡片段)。
profile 里 `advanceToAsync @ stageClock.ts:90` / `onFrame @ StageView.tsx:183` 占了 30 次写的 9.6 秒里的 9.6 秒。

播放头停在哪决定代价:卡片入点离播放头越远补跑越长。用户通常把播放头停在 Agent 正在改的那一段附近,正是最坏情况。

## 主因二:AI 面板每收到一个流式片段就重渲整段历史

`src/ai/useAiChat.ts:666-673`:每个 delta 都 `setMessages(prev => prev.map(...))`;`src/editor/right/AiPanel.tsx:893`
`messages.map(...)` 没有虚拟化、单条消息没有 `React.memo`;每次重渲对每条消息重做 `partsOf`、`renderMarkdown(p.text)`(:1021)、
`JSON.stringify(t.input, null, 2)`(:941)。历史越长每个片段越贵:1200 次工具的历史下 114 ms / 片段,
一轮几百个片段 = 几十秒的主线程被占满 —— 这就是「Agent 一开始工作界面就卡」的直接体感来源,和三端分离无关。

## 次因(每次写都有,但小)

- `src/ai/mcpExecutor.ts:384`:改卡工具前 `structuredClone` 整个项目,`withVisual` 再 `JSON.stringify` 一份 before + after 发给预渲染源(不占编辑台连接)。实测 ~2 ms / 次。
- `src/render/dataMirror.ts:37-62`:每个写工具回结果前 `flushDataMirror()`,整个项目 `JSON.stringify`(85 KB)同源 POST,服务端同步 `JSON.parse`。实测页面侧 ~1.6 ms / 次,服务端 ~1 ms。agy 的静态分析把它排第一,数字不支持。
- 每次 `setProject` 整棵编辑器重渲:左栏常驻挂载的全部分页(卡片格 / 字幕 / 转场)、时间轴每段的 `AudioWaveform` 重算 paths、`TrackHeader`……没有 memo。profile 里合计约 10 ms / 次。
- **桌面版跑的是 vite dev server**(`desktop/src-tauri/src/lib.rs:386` 直接起 `vite.js`),所以用户拿到的是 React 开发版:`jsxDEV` / `validateProperty` / `logComponentRender` 在写工具的 profile 里占 ~20%。

## 不是原因

- 同源 6 条连接:分离之后编辑台源上只剩 `/api/mcp/events`、当轮 `/api/ai/chat`、2 秒一次的 `/api/ai/setup` 轮询,离打满很远;`/api/ai/visual` 走预渲染源。
- 服务端同步 I/O(`vite-plugin-ai.ts:820` 的 45 KB `readFileSync`、`/api/data/project` 的 `JSON.parse`):毫秒级。
- 三维场景重建(`Scene3DView.tsx:334`):只在活跃卡集合变化时重建,Agent 改参数不触发。

## 建议(按收益 / 代价)

1. **AI 面板**(最大、最容易):单条消息抽成 `React.memo` 组件,`renderMarkdown` / `JSON.stringify(input)` 用 `useMemo` 按 part 缓存;流式增量只替换最后一条(`prev.map` 换成只动尾巴);历史超过 N 条折叠或虚拟化(`react-window`)。预期每片段回到几毫秒。
2. **预览**:Agent 写项目时**不要走重播**。两条路:(a) `setProject` 里区分「只动了素材段 / 不在舞台上的东西」→ 不 `renderAt`;(b) 改卡参数时把 200 ms 的 settle 改成「Agent 这一轮结束再补跑一次」(mcpExecutor 有回合边界),或者播放头不在活跃卡时段内就不补跑。补跑本身可以按预算切片(每帧让出宏任务),别一次 `flushSync` 180 帧。
3. **桌面版用生产构建**:`vite build` 出 dist 由 dev server 静态托管(插件照常),或至少 `--mode production` 关掉 React dev 检查。约省 20%。
4. 小的:`withVisual` 的 before/after 只在 `CLIP_EDIT_TOOLS` 命中时克隆(现在已是),可再改成只传 diff;`AudioWaveform` 的 paths 按 `(mediaId, start, end, width)` memo。

先做 1 和 2(a),这两处占了实测里 95% 以上的长任务时间。

## 修了(同日,提交见 git log)

| 场景 | 修前 | 修后 |
|---|---|---|
| 30 次 `update_clip`(素材段),播放头 3 s | 28 个长任务 1.84 s | 2 个 0.13 s |
| 30 次 `update_clip`(素材段),播放头 60 s | 44 个长任务 9.6 s,单次最长 347 ms | 3 个 0.19 s,最长 67 ms |
| 60 次读写混合 | 10 个 742 ms | 3 个 172 ms |
| AI 面板:1200 次工具的历史,流式 100 片段 | 每片段 ~110 ms | 每片段 15 ms,仍贴底 |

改了什么:
1. **`src/editor/Preview.tsx`**:时间那个 effect 的依赖里有 `stage` / `refreshRects`,它们的引用跟着项目换,于是每次项目变都多跑一次
   `render(t, { jump: true })`(重挂载 + 补跑)—— 这才是 Agent 写一次卡几百毫秒的真正来源;现在只认 `t / playToken / stageReady` 真的变了。
2. **`src/StageView.tsx`**:`setProject` 按 clip 对象引用比出哪些卡片段变了(store 是不可变更新);没有卡变、或变的卡此刻不在画面上,
   不排 200 ms 的补跑。用户改一张活跃卡的参数照旧补跑一次(实测 160 ms,和以前一样)。
3. **`src/editor/right/AiPanel.tsx`**:每条消息抽成 `React.memo` 的 `MessageRow`,只比消息对象、显示模式和它自己的展开 key;回调经 ref 中转保持引用稳定。
   `src/ai/Markdown.tsx`:`renderMarkdown` 按原文缓存。
4. **`src/editor/right/AiPanel.css`**:`.ai-messages > .ai-message { content-visibility: auto }` —— 实测这一条才是大头:
   每个片段的 100 ms 是浏览器把整个消息列表重新布局,不是 React;memo 之后 JS 只剩十几毫秒,布局不加这条还是 100 ms。

没做的:桌面版仍是 React 开发版(建议 3),整棵编辑器左栏每次项目变的重渲(约 10 ms / 次)。
