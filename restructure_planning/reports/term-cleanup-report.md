# 用词清理：「预渲染 / 预渲染」→「预渲染」

- 分支 `worktree-agent-a4ffc385d74715ff4`（worktree `C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-a4ffc385d74715ff4`）
- 起点：工作区干净 → `git merge --ff-only main` 拿到 `048074c`
- 提交（4 个，按目录分）：
  - `57bc227` 用词:src 下的注释「预渲染/预渲染」改成「预渲染」
  - `864cc67` 用词:server 下的注释「预渲染/预渲染」改成「预渲染」
  - `3307db4` 用词:scripts / desktop/scripts 下的注释「预渲染/预渲染」改成「预渲染」
  - `9d00979` 用词:docs 下的「预渲染/预渲染」改成「预渲染」
- 规模：**63 个文件、471 行**（`git diff --numstat` 增 471 / 删 471，无整文件重写）

---

## 1. 怎么盘点的

用 TypeScript **parser** 给每一处「预渲染」定位，脚本 `scratchpad/scan-hong.mjs`，
结果 `scratchpad/hong-scan.json`。

> 一开始用的是裸 `ts.createScanner`，**结果是错的**：裸 scanner 没有语法上下文，
> 遇到模板字符串的 `${…}` 之后会失步，把后面整片代码当成一个未闭合的字符串，
> 于是几百行 JSDoc 被报成「字符串字面量」。换成 `ts.createSourceFile` 全量解析、
> 按叶子 token 的 `getLeadingCommentRange` / `getTrailingCommentRange` 取注释区间，才对。

排除 `node_modules` / `out` / `archive`（含 `scripts/archive/`）/ `.claude` / `dist` / `target` / `runtime` / 二进制。

改前全仓库 630 处出现、531 个「文件:行:类别」：

| 类别 | 行数 | 处理 |
| --- | --- | --- |
| 注释（`//`、`/* */`、JSDoc、JSX 注释） | 409 | 改（留 1 处，见 §4） |
| markdown | 72 | 改 60，留 12（见 §4） |
| 字符串字面量 | 46 | **一处没改**，清单见 §3 |
| CSS 注释 | 4 | 改 3，留 1（见 §4） |

改后只剩 60 行，全部是「有意留下」的，逐条列在 §3 / §4。

## 2. 用词表

| 原词 | 改成 |
| --- | --- |
| 预渲染 / 预渲染（动词、名词） | 预渲染 |
| 预预渲染、预预渲染、空闲预预渲染 | 预渲染、空闲预渲染（`预` 不叠） |
| 预渲染间 | 预渲染间（比照用户给的「预渲染页 → 预渲染页」「预渲染进程 → 预渲染进程」；标识符 `bakery`、目录 `server/bakery/` 不动） |
| 预渲染帧 / 逐帧预渲染 | 渲帧 / 逐帧渲 |
| 预渲染好 / 预渲染完 / 预渲染过 / 没预渲染 | 视句子取「预渲染好」或「渲好」 |

句子里已经出现「预渲染」时，动词用仓库本来就在用的单字「渲」（`往下渲`、`自己渲一趟`
是改动前就有的写法），避免「预渲染…预渲染…」这种重复。

### 判断项 A：「现预渲染」没有并入「预渲染」

用户的规则前提是「**预渲染**指离线把画面**提前**做出来」。代码里的「现预渲染」恰恰相反 ——
指用户已经等在那儿、当场起一个 Chrome 渲一张，是和「预预渲染」成对的另一侧。
两边都写成「预渲染」会把这组对比抹平，还会写出「明明预渲染过还要预渲染」这种病句。

所以：**「现预渲染」→「现场渲染」**，「预预渲染 / 空闲预预渲染」→「预渲染」，对比保住。
落点在 `bakePlan.ts:2,4`、`bakeTime.ts:36,63,94,172`、`bakeCoverage.ts:31,181,332`、
`Scene3DView.tsx:227,828`、`RenderBar.tsx:24`、`bakeCoverage.test.mjs:178,187`、`bakeTime.test.mjs:10,77`。
**主会话若想统一成别的词（比如「即时渲染」），这十几处是全部落点。**

### 判断项 B：三处「预渲染」不是指渲画面，按意思另选了词

| 位置 | 原文 | 改成 | 理由 |
| --- | --- | --- | --- |
| `src/kernel/motion.ts:39` | 把一条追踪轨迹**预渲染成**某个卡片段的跟随数据 | **算成** | 这是把坐标换算成数据，没有画面；下一句正好是「三件事在这里一次算清」 |
| `src/mcp/handlers/ai.ts:484` | 从 trackResults 直接**预渲染进** clip | **写进** | 同上，是写数据不是渲图 |
| `docs/3d-layers.md:153,155,170` | **预渲染死**进纹理 | **固化进纹理** | 「预渲染死」重点在「不可逆地并进去」，不是「提前渲好」；「预渲染死进纹理」不成话 |

### 判断项 C：一处改了措辞而不是换词

`docs/decoupling-plan.md:80` 原文「预渲染键跟着代码变、预渲染渲的是改过的卡」——
直译会变成「预渲染键跟着代码变、预渲染渲的是…」，改成「**缓存键**跟着代码变」。

### 对齐

改动波及 5 处靠宽度对齐的地方，都按「CJK 2 列、`─` 1 列」重算过，**显示宽度与改前完全一致**：

- `Scene3DView.tsx:719 / 852`（`/* ── … ── */` 分隔线，852 去掉 2 个 `─`）
- `bakeCoverage.test.mjs:178`（分隔线，去掉 4 个 `─`）
- `bakeTime.ts:12`（`3D 视图(渲中点): 100%` 这张对齐小表，用单字「渲」保住列宽）
- `decoupling-plan.md:264`（ASCII 框图，`空闲预预渲染   │` → `空闲预渲染 │`，去掉 2 个空格）

---

## 3. 字符串字面量清单（46 处，**一处没改**，交主会话决定）

不改的理由：可能被测试钉住（测试名就是断言的一部分）、可能改变 Agent 行为（工具描述）、
或者是用户看得见的文案。**改的时候注意 §4 里那两条注释是指着它们写的。**

### 3.1 MCP 工具描述 / 给 Agent 看的（改了会影响 Agent 行为）

| 位置 | 原文 | 建议 |
| --- | --- | --- |
| `server/tools/cards.mjs:94` | `"把一张卡**预渲染成一张图片**存进素材库,返回它的 URL。…"` | 预渲染成 → 预渲染成 |
| `server/tools/cards.mjs:100` | `"要重新预渲染一次再把新 URL 填回去。所以顺序是「先把卡调好,再预渲染」。"` | 重新预渲染 → 重新渲；再预渲染 → 再渲 |
| `server/tools/cards.mjs:102` | `"两种观感,由 \`bg\` 决定,**预渲染的时候就定死**:"` | 预渲染的时候 → 预渲染的时候 |
| `server/tools/cards.mjs:107` | `"素材段(视频 / 图片)不用预渲染,它本来就是位图,…"` | 不用预渲染 → 不用渲 |
| `server/tools/cards.mjs:111` | `description: "要预渲染哪一张卡(时间轴上的片段 id)"` | 要预渲染 → 要预渲染 |
| `server/tools/cards.mjs:112` | `description: "预渲染哪一刻的样子…预渲染出来是个半透明的中间态"` | 预渲染 → 预渲染；预渲染出来 → 渲出来 |
| `src/cards/native/scene-3d.tsx:271` | `hint: "…用 bake_card 把一张卡预渲染成透明底 PNG 再贴上来最直接;…"` | 预渲染成 → 预渲染成（这条是卡片参数面板的 hint，既给人也给 Agent 看） |

**另外：`server/ai-system-prompt.md:83,84`（2 行）虽然是 markdown，但它是喂给 Agent 的系统提示词，
和上面这批是同一类，所以也没改。**原文：
`再 \`bake_card({…})\` 预渲染成图片` / `**预渲染出来的是快照**——…要重新预渲染。`
它和 `server/tools/cards.mjs` 的描述应当一起改、口径一致。

### 3.2 UI 文案（用户看得见）

| 位置 | 原文 | 建议 |
| --- | --- | --- |
| `src/editor/preview/Scene3DView.tsx:922` | `` `正在预渲染 ${pending} 张卡的贴图…色块是占位,预渲染好会自动换上` `` | 正在渲 … 渲好会自动换上 |
| `src/editor/preview/Scene3DView.tsx:923` | `` `正在预渲染第 ${bakingAt.toFixed(2)} 秒的画面(共 ${pending} 张)…` `` | 正在渲第 … |
| `src/editor/preview/Scene3DView.tsx:837` | `` setErr(`${data.failed.length} 张没预渲染出来:${…}`) `` | 没渲出来 |
| `src/editor/timeline/RenderBar.tsx:109` | `` `空白 = 要等它现预渲染(一张约 4 秒)。已占 ${…}MB` `` | 现预渲染 → 现场渲染（和 §2 判断项 A 同一个词） |
| `src/editor/timeline/RenderBar.tsx:110` | `` `${shown.stale} 张卡刚改过,它们那几段已作废,正在重预渲染` `` | 正在重渲 |

### 3.3 报错信息

| 位置 | 原文 | 建议 |
| --- | --- | --- |
| `server/vision/bake.ts:76` | `throw new Error("这是素材段…直接把它的 URL 当纹理用即可,不用预渲染。")` | 不用预渲染 → 不用渲 |
| `server/vision/bake.ts:252` | `"…就重预渲染一次并传 bg(比如 bg:\"#0b0f17\")。"`（给 Agent 的返回文案） | 重预渲染 → 重渲 |
| `server/vision/bake.ts:253` | `const note = "这是一张**快照**:…要重新预渲染。"`（给 Agent 的返回文案） | 重新预渲染 → 重新渲 |
| `server/vision/render-queue.ts:133` | `` `不是这张卡的问题 —— 过一会儿再看,或者等手上的导出 / 预预渲染跑完。` `` | 预预渲染 → 预渲染 |
| `server/vision/routes.ts:607` | `error: "缺少 clipId:预渲染只能对着一张卡"` | 预渲染 → 预渲染 |
| `server/vite-plugin-ai.ts:271` | `throw new Error(data?.error \|\| '预渲染失败')` | 预渲染失败 → 预渲染失败 |
| `src/editor/preview/Scene3DView.tsx:812` | `` throw new Error(data.error \|\| `预渲染失败(HTTP ${res.status})`) `` | 同上 |
| `src/mcp/handlers/vision.ts:202` | `` throw new Error(data.error \|\| `预渲染失败(HTTP ${res.status})`) `` | 同上 |

### 3.4 日志

| 位置 | 原文 | 建议 |
| --- | --- | --- |
| `scripts/catalog-notes.mjs:59` | `` console.log(`${items.length} 个素材,每个预渲染一段再抽 6 帧…`) `` | 每个渲一段 |

### 3.5 测试名 / 断言消息（**最可能被钉住，改前先跑 `npm test`**）

`src/editor/preview/bakeCoverage.test.mjs`：21、34、39、43、46、63、156、160、174、180、185、219、220、234（14 处）
`src/editor/preview/bakePlan.test.mjs`：91、94、96、117、120、170（6 处）
`src/editor/preview/bakeTime.test.mjs`：61、67、80、93、129（5 处）

全部是 `test("…预渲染…")` 的用例名和 `assert.*(…, "…预渲染…")` 的失败消息。
建议按同一张词表改（预渲染好→渲好、没预渲染→没渲、预预渲染→预渲染、只预渲染一次→只渲一次、
「预渲染没预渲染」→「渲没渲」）。这三个文件的**注释**这次已经改过了，只剩字符串。

---

## 4. 剩下没改的注释 / markdown（14 行，都有出处约束）

| 位置 | 原文 | 为什么留 |
| --- | --- | --- |
| `src/editor/preview/preview.css:349` | ``按 `.pc-3d-note` 去找「正在预渲染…」那条状态提示的人`` | 这是明写着「拿这段文字去搜」的定位锚，指向 §3.2 的 UI 串；串不改它就不能改 |
| `src/editor/preview/Scene3DView.tsx:897` | `按它去找「正在预渲染…」那条会连这个按钮一起匹配到` | 同上，同一个锚 |
| `docs/decoupling-plan.md:245` | `- 「预渲染全都借预渲染的 chrome。但是 Agent 请求优先级排高」` | 在「### 3.1 讨论里定下来的规则（**用户原话**）」下，是逐字引用 |
| `docs/decoupling-plan.md:246` | `- 「用户的前台预渲染培是在交互界面里面的常驻离屏渲染，…」` | 同上（原文里就是「预渲染培」，错字也保留） |
| `docs/render-rebuild-plan.md:168` | `出处:"一个预渲染任务本来就只吃约 1.9 个核…"——提交 \`2dd2cf6\`` | 对一条提交说明的逐字引用，改了就对不上出处 |
| `docs/vision-plugin-refactoring-plan.md:10` | `> 本文档里一律用「预渲染」，不用「预渲染」；…` | 这句话本身就是这条约定；改了会变成「一律用预渲染，不用预渲染」 |
| `docs/plan/r75/agy-r75-01/06/07/08/09/10.md`（6 行） | 「全文零个『预渲染』字」这类自检记录 | `docs/plan/` 整个目录按要求没碰 |
| `server/ai-system-prompt.md:83,84`（2 行） | 见 §3.1 | 是喂给 Agent 的提示词，和工具描述同类 |

**「引用即留、描述即改」这条线是这么划的**：只有明写「去找这段文字」「用户原话」「出处:…」
的才留；其余只是转述 UI 或行为的注释都改了（例如 `server/vision/routes.ts:72`
「3D 视图还会弹一句「N 张没预渲染出来」」→「N 张没渲出来」、`Scene3DView.tsx:761`
「提示却一直挂着"正在预渲染第 X 秒"」→「正在渲第 X 秒」）。这两处和 §3.2 的串是成对的，
串改了它们正好对上；串不改也还看得懂。

---

## 5. 校验

### 5.1 「剥掉注释后逐字节相同」

脚本 `scratchpad/verify-comments-only.mjs`，对 **63 个改动文件全部**跑，两条独立口径：

- **A. `ts.transpileModule({ removeComments: true })` 比产物** —— 53/53 代码文件通过
- **B. parser 定位注释区间、直接从原文抠掉再比** —— 53/53 代码文件通过
- **CSS**：自写的 `/* */` 剥离器（跳过字符串）—— 2/2 通过
- markdown 8 个不参与（纯文本，没有「注释/非注释」之分）

> 「改前」取 `git show HEAD:<path>`。本仓库 `core.autocrlf=true`、`.gitattributes` 是 `* text=auto`，
> 所以 blob 存 LF、工作区是 CRLF；脚本按这条规则把 blob 还原成 checkout 后的样子再比。
> 第一版没还原，53 个文件全部「失败」在 `\r\n` 上 —— 是校验脚本的错，不是改动的错。

### 5.2 行尾

- **逐行行尾符序列（CRLF / LF / 末尾有无换行）改前改后完全一致：63/63。**
- 结构上也有保证：`scratchpad/apply-patch.mjs` 把文件拆成「行内容数组 + 行尾符数组」，
  只替换行内容、行尾符数组原样装回，从不重写行尾。
- `git diff --numstat` 增 471 / 删 471，`--stat` 里没有任何整文件重写。

### 5.3 构建与测试

- `npx tsc -b --force` → **0 错误**（exit 0）
- `npm test` → **tests 1481 / pass 1480 / fail 0 / skipped 1**，和 main 今天的基线一致

### 5.4 改动只落在注释和 markdown 里

除上面两条机器校验外，471 行的 `git diff` 全部逐行看过；每一行 `+/-` 都在
`//`、`/* */`、JSDoc、JSX 注释或 markdown 正文里。

---

## 6. 已知副作用（预期内，不处理）

`server/frame-code.mjs` 的指纹会把一批源文件的**原文**（含注释）一起哈希，
所以这次纯注释改动会让**帧缓存和共享快照失效一次**。这是预期内的。

## 7. 范围判断（可能和主会话的预期不同，列出来）

- **`scripts/archive/export-frames-virtual-time.mjs`（19 处）没碰** —— 「不碰 `archive/`」按
  目录名理解，含 `scripts/archive/`；它是归档脚本，和 `docs/plan/` 同一性质。
- **`scripts/README.md`（1 处）改了** —— 它既不在 `docs/` 也不在仓库根，严格说不在「改」的
  白名单里；但它是描述脚本的文档，留着一个「预预渲染」会和刚改完的 `scripts/*.mjs` 对不上。
- **`src/editor/**/*.css`（3 处）改了** —— 任务写的是「`//`、`/* */`、JSDoc、JSX 注释」，
  CSS 注释也是 `/* */` 且在 `src/` 下，按在范围内处理；`preview.css` 那一处见 §4。
