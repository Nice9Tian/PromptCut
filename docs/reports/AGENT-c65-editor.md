# AGENT 报告：c65-editor（C6.5 页面一侧）

分支 `claude/c65-editor`（起点 `806503d` = `claude/c65`：M6 + SP + C6.5 第一批），worktree `.worktrees/c65-editor`。中途按主会话通知 `git merge --no-ff main`（`aa6b579`，main = `2e75bec`，含 M6c X1～X5），无冲突；基线与 G0-R 都在合并后的代码上跑。没有推送，没有合并到别处。

状态：五项任务都做了，基线全绿（tsc 0、`npm test` 2901/2902 过、1 跳过、0 失败），G0-R 前三项全过；预览兜底探针 `--page-preload` 本分支一败一过（main 一过），按回退规则停手交回，见第 2.2 节。

依据：`c65-design.md` 第 4、6、8、9、13 节；`c65-ux-draft.md`、`c65-undo-draft.md`（界面照稿、文案照稿）；`auth-contract.md`、`shared-project-contract.md`；`AGENT-c65-integ.md` 第 7 节遗留；主会话中途两条裁定（AI 栏撤销的冲突口径、`set-creator-password` 不加代数）。

## 1. 做了什么

### 1.1 页面真接线（任务 1）

- **`src/editor/sync/link.ts`（新）**：一条 WebSocket + 一个 `DocSync`。子协议每次连之前现取（共享项目的 nonce 只能用一次）；断线按 0.5 s 起、翻倍、最长 5 s 重连；`project.*` 交给 DocSync，带 `reqId` 的回包交给 `request()`，其余（`shared.*`、`events.*`）交给 `onMessage`；关闭码 4003 / 4004 不再重连。浏览器与 Node 通用，WebSocket 可注入。
- **`src/editor/sync/syncManager.ts`（新）**：页面一侧的同步管理与界面状态小仓库（`useSync`）。
  - 本机项目：连本机编辑器 `/docservice`（回环不带凭证 = `local` 空间），项目号 = `project.id`；
  - 载入（开始页、打开 `.proc`、新建）经 `bindStore(ds, { load })` 接管：同一个本机项目是一次根替换；别的项目换连接、换 DocSync，并把载入的内容以根替换写进去（文件内容为准）；旧连接等手里的提交确认完（≤ 5 s）再关；
  - 共享项目：按进入时的连接（凭证明），项目号 = 共享项目的 `projectId`；在共享项目里载入别的项目 = 离开共享项目回本机空间（不把别的文件整份盖到大家的项目上）；
  - `?join=<项目号>`：第二个页面加入同一个本机项目，内容以文档服务为准、不做根替换、不塞演示卡（V2 真实页面版用；两页开同一份草稿会被草稿独占锁挡住，所以另给了这条路）；
  - 无头实例（`?headless=1`）、只读查看、`/api/docservice/device` 取不到时不接，store 照旧用快照栈。
- **`.proc` 保存等确认**：`writeProcToDisk` 接受「内容生产函数」，挑好落点之后（「另存为」仍是手势里第一个 await）先 `whenSaved(10 s)` = `ds.whenSettled`，再序列化；超时弹「还有修改没等到文档服务确认（可能离线、连接慢，或同步已暂停），这次没有保存。等连上、处理完再保存。」打包保存 `.procp` 同样先等确认。
- **大根替换走 `project.upload`**（`src/store/docsync.ts`）：单条根替换序列化后超过 256 KiB 时，按 128 Ki 字符一片（UTF-8 最坏 4 字节，≤ 512 KiB）先发 `project.upload`，再发 `{ op: 'set', path: '', upload }`；差异本身超过 256 KiB 时，这一条提交改成「根替换 = 落地后的本地副本」再走上传，逆操作仍用差异算的那份（撤得回来）。

### 1.2 撤销（任务 2）

- 快捷键：`Ctrl+Z` 撤销；`Ctrl+Shift+Z`、`Ctrl+Y` 重做（原代码比的是 `e.key === "z"`，按着 Shift 时 key 是大写 `Z`，Ctrl+Shift+Z 其实一直没生效，一并修了）；焦点在输入框时照旧交给输入框。
- 按钮：栈空置灰；悬停提示照稿（文案表第 1、2 条），挂在外层 `span` 上，置灰时也看得到；标题栏「快捷键」弹窗加了 `Ctrl/Cmd + Y 重做`。
- 提示条 `SyncOverlays.tsx`：部分没撤 / 部分没重做 / 全部没撤 / 全部没重做四种标题照稿（第 4、5、8、9 条），列表项「实体名 (由 身份 修改)」，多于 3 处折叠成前 2 处 +「等 N 处 (点击展开)」，约 8 秒消失（悬停时暂停计时）、带关闭按钮；全部没撤时附「你可以 [点击这里] 查看被修改处的现状，或直接手动调整。」。实体名按 `entityValuePath` 换回路径取值，片段可点 → 选中并把播放头挪到它开头，项目设置类实体可点 → 打开项目设置。
- AI 栏「撤销这步」（`AgentUndoButton.tsx`，挂在操作卡 `OpDetailPreview.tsx` 的 `OpCard` 上）：只在「完成」事件带了 `opId` 的操作上出现；按事件的 `callId`（没有就 `eventId`）对上 AI 栏的工具调用；不二次确认；成功后置灰「已撤销」。数据走 `DocSync.revertRemote({ opId, inverse?, rev?, by? })`：以页面身份提交逆操作 + `undoOf`，结果当一次普通修改进页面自己的撤销栈（Ctrl+Z 能把 Agent 的改动恢复回来）。冲突口径按主会话裁定：那一步之后被**不同于那个 Agent 对话**的任何写入（含页面自己后来的、含还没确认的）改过的实体不撤；Agent 自己后来又改的不算。逆操作以事件里的 `inverse` 为准；事件没带时用页面收到那次 `project.ops` 时自己在已确认副本上算的逆操作（每次远端提交都记，留最近 200 次）。

### 1.3 覆盖与离线（任务 3）

- 本地备份落盘：DocSync 的 `saveBackup` → `POST /api/project-backups`（`server/vite-plugin-projects.ts` 新增），写进草稿目录下 `backups/<时间>-<随机>.json`（先写临时文件再改名，最多留 500 份）；备份另记项目名、存它的页面会话。存不下来时出气泡告诉用户。
- 被覆盖时的气泡：稿件第 13 条，把「〔找回入口待裁定〕」换成裁定的入口：「你的近期修改已被 X 覆盖。已将你修改的版本存入草稿备份（「项目」菜单 →「本地备份…」可找回）。」
- 「项目」菜单「本地备份…」（`BackupsDialog.tsx`）：按时间倒序、每个实体一行（离线丢弃的那批按它改到的实体各列一行），写明谁覆盖的（按备份主人的视角说）；只有当前项目的能恢复；「恢复」= 原处还在就替换、原处被删了就按开始时间插回去、备份里没有它就删掉，经 `actions.editCardProject` 以一次新写入落地（进撤销栈、照样通知别人）。
- 离线对话框：标题、说明、两个按钮、关闭按钮悬停文案照稿（第 14～18 条）；`since` 翻成「谁：哪几处」。「丢弃」前 DocSync 先存备份（裁定）。关掉 = 暂不决定，顶栏出「同步已暂停」，点它重新打开（裁定）。
- 顶栏另有「离线」小标记（稿件没有，见第 4 节）。
- 别人的改动描边 1.5 s：DocSync 新增 `remote` 通知（实体 + 写入身份），片段实体 / 序列实体下的片段在时间轴元素上挂 `data-remote-flash`，1.5 s 后摘掉。

### 1.4 D11：共享项目（任务 4）

- 「项目」菜单加「新建共享项目 / 和他人一起编辑」「打开共享项目 / 加入已有项目」（文案表首两行）。
- 新建（`SharedDialogs.tsx`）：字段、分组、校验、状态文案全部照稿；限定进入的名单表（创建者固定第一行、「同创建者密码」、悬停出删除、「如果有独立渲染主机，记得在这里给它也加一条名单。」）；经 `route.mjs` 的 `createSharedProject` 建好后以创建者身份进入，当前项目以根替换写进新项目（DocSync 在 `project.state` 为空时自动种进去）。
  - 纯浏览器（页面不是本机回环打开的）：局域网模式置灰并附稿件原文说明。
  - 本机编辑器没绑在局域网上（没以 `PROMPTCUT_LAN_HOST=1` 启动）时选局域网模式：给出明确提示、要执行的命令与「复制命令」按钮，「创建」不放行。**桌面壳没有重启编辑器的接口**（`desktop/src-tauri/src/lib.rs` 只有标题栏菜单与 `.proc` 锁几个命令），一键重启留给 C10 / 桌面壳。
- 打开：第一步项目名 +「托管地址」（右上角灰字，展开输入框，缺省 `DEFAULT_HOSTED_URL`，「恢复默认」，改过的值记在本机并作为覆盖顺序第 1 级传给 `route.mjs`）；查找由 `findSharedProject` 同时查局域网（浏览器发不了 UDP，本机编辑器新增 `GET /api/docservice/lan-discover?name=` 替页面跑 `discoverLan`，3 s）与托管端；两边都有 → 并列供挑（「找到两个同名项目，你要进哪一个？」「[互联网模式] 托管在阿里云」「[局域网模式] 主机：{设备名}」）；一边连不上而另一边找到 → 角落气泡「阿里云连不上」/「局域网查找失败」；找不到 / 两边都连不上的文案照稿。第二步按模式给字段，「我是创建者」入口，「进入 (59s)」倒计时，错误文案照稿。
- 成员列表（`MembersPanel.tsx`）：顶栏「成员: n 人」；按设备一行；重名带设备名（服务端 `displayName`）；自己那行加粗 +「(自己)」；[创建者] [编辑中] [渲染中] [Agent ×n]；点行展开「用户名 · Agent · 第 n 个对话」；只有自己在线时「只有你自己在线。」。
- 创建者操作：我是创建者时别人那行悬停出红色「踢出」；浮层底部「项目管理（仅创建者可见）」：改项目密码（自由进入）/ 改名单（限定进入）、改创建者密码、已禁入的设备、删除项目。每次先「验证创建者身份」（当场输密码；用新增的只读操作 `list-bans` 做一次证明核对），验证过的 K 只活在这一次操作流程里。踢人确认文案、自由进入下踢完提示改密码、删项目手打项目名才放行、互联网 / 局域网两种删除确认文案，都照稿。改名单里有独立渲染主机的说明（稿件原文）。
- 被操作方：被踢 / 被移出名单 / 项目被删的阻断弹窗（只有「开始页」），被移出名单补一句「找创建者把你加回名单，再重新打开。」（裁定）；「项目密码已被修改。…」气泡（服务端新增 `shared.notice`）。
- 服务端 `server/docservice/modules/shared.mjs`：
  - `set-creator-password { creator: { salt, key } }`：带创建者证明；改完旧密码不能以创建者进入、新密码可以，之后的创建者操作按新密码算证明；成员 / 不带证明 / 证明错 `forbidden`；**不加代数、不作废已发票据**（主会话裁定）；
  - `list-bans`（只读，带证明）：回禁入表，限定进入另带名单用户名（不带盐与 K）——「已禁入的设备」「改名单」要它；
  - `set-list` 的条目可写 `{ username, keep: true }`：沿用此人现有口令（创建者拿不到别人的 K，只增删 / 只改几个人时要它）；
  - `set-password` 成功后给本空间其余连接各发 `shared.notice { event: 'password-changed' }`。

### 1.5 验收探针（新文件）

`scripts/probes/c65-editor-probe.mjs`：puppeteer 真浏览器，三个阶段 `local` / `shared` / `lan`，每项一行 JSON，截图写进 `--out`。托管端用本机起的托管组合（`server/hosted/main.mjs`，5518/5519，数据目录在 scratchpad），**全程没有连真正的阿里云托管端**。

## 2. 验证

### 2.1 基线（合并 main 之后的代码）

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，无输出 |
| 全量测试 | `npm test` | 退出码 0；`ℹ tests 2902` `ℹ pass 2901` `ℹ fail 0` `ℹ cancelled 0` `ℹ skipped 1`；唯一跳过的是既有的「集成:/api/cards/layout 对真实项目返回整数框」（要 5190） |

新增单测：`server/test/c65-shared-admin.test.mjs` 7 条（C65-SA1×2、SA2～SA6），`src/store/docsyncEditor.test.mjs` 7 条（撤这一步 4 条、remote 通知 1 条、真文档服务上的分片上传与超限差异 2 条），全过。旧的 `auth-members` 等 AU 系列一条没改、全过。

### 2.2 G0-R（改了编辑器数据流）

端口：本分支 5510（舞台 5511、5512），main 基线 5513（舞台 5514、5515），都以 `PROMPTCUT_PUSH=0 npx vite <worktree> --port … --strictPort --host 127.0.0.1` 起。main 基线是临时的 `git worktree add --detach .worktrees/c65e-main-baseline main`（`2e75bec`）。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性（本分支） | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5510/?export=1"` | 退出码 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` `All frames are identical. Determinism verified!` |
| 导出确定性（main） | 同上，5513 | 退出码 0；`Total Frames: 1800` `Identical: 1800` `Different: 0` |
| 导出像素与 main | pngjs 逐帧逐像素比两边 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5510 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5510` | 退出码 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 预览兜底（页面自己触发预渲染），本分支第 1 次 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5510 --page-preload --out out/pf-probe --json out/pf-probe/after.json` | **`FAIL 1`**：`"fails": ["超时:粒子卡的轨道流满密度、快照铺上一截"]`，`readyLayers: null`；其余照常 `beats 287`、`transparentBeats 0`、`taskP90 15.418`、`pageErrors []` |
| 同上，main 基线（5513） | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5513 --page-preload` | `PASS`；`beats 279`、`transparentBeats 0`、`taskP90 13.272`、`pageErrors []`、`fails []` |
| 同上，本分支第 2 次 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5510 --page-preload` | `PASS`；`beats 278`、`transparentBeats 0`、`taskP90 17.746`、`pageErrors []`、`fails []` |

**预览兜底探针的一次失败（按回退规则停手，交主会话判断）**：本分支第 1 次在「等粒子卡的轨道流满密度」这一步 600 s 超时，main 基线同条件一次通过，本分支第 2 次通过。两次本分支运行里页面与文档服务的连接都正常（开页 1 条、换空项目 1 条、旧的以 1000 `bye` 退下，没有重连、没有 resync），dev server 日志里没有错误。我找不到页面同步与这一步（数据镜像 → 预渲染进程 → 就绪索引 SSE）之间的直接关系，但也没能证明无关；它属于回退规则说的「偶发 / 时序」一类，我没有再往下查。另外第 2 次的 `taskP90` 17.7 ms 比 main 的 13.3 ms 高（这项只有带 `--baseline` 时才判，历次报告里在 12.3～15.4 之间），是否与页面多了一条 WebSocket 与每次提交的差异计算有关，也需要主会话用 `--baseline` 在同一台机器上对照判定。

### 2.3 浏览器里实际点过（U4）与 V2 真实页面版

`node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5510 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots --phases local`（连跑 3 次，都是 20/20）：

```
{"check":"join-page-gets-docservice-content","ok":true,...}
{"check":"V2-page-real","ok":true,"edits":[100,100],"a":{"sha256":"9e0485445fec8f116ccf7757dc0ce144af7e925122b9baa4e028a14a70b38e6c","rev":150,"status":"online"},"b":{"sha256":"9e0485445fec8f116ccf7757dc0ce144af7e925122b9baa4e028a14a70b38e6c","rev":150,"status":"online"},"doc":{"rev":150,"sha256":"9e0485445fec8f116ccf7757dc0ce144af7e925122b9baa4e028a14a70b38e6c"}}
{"check":"undo-partial-notice","ok":true,"notice":"撤销了，但这几处被后续的新修改覆盖，未做退回：\n×\n片段「模糊浮现 @2.0s」 (由 你在另一个页面 修改)","c2":"B改","c1WasBefore":"A改"}
{"check":"undo-notice-jump-selects","ok":true,...}
{"check":"undo-none-notice","ok":true,"notice":"没撤成。这几处后来都被改过了，保留了现在的样子：\n×\n片段「环形进度 @4.0s」 (由 你在另一个页面 修改)\n你可以 [点击这里] 查看被修改处的现状，或直接手动调整。","c3":"B3"}
{"check":"undo-buttons","ok":true,"undoTitle":"撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的","redoTitle":"重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）",...}
{"check":"undo-buttons-disabled-when-empty","ok":true,"undo":true,"redo":true}
{"check":"ctrl-y-redo","ok":true,...}
{"check":"remote-flash-1.5s","ok":true,"flashed":true,"goneAfter":true}
{"check":"overwritten-toast","ok":true,"toast":"你的近期修改已被 你在另一个页面 覆盖。已将你修改的版本存入草稿备份（「项目」菜单 →「本地备份…」可找回）。\n×"}
{"check":"offline-dialog","ok":true,"chip":"离线","dlg":"×\n断网期间项目有新改动\n你有 3 步断网期间的修改。但这段时间项目有以下改动，可能会和你的修改重叠：\n你在另一个页面：片段「模糊浮现 @12.0s」\n你在另一个页面：片段「文字轮换 @8.0s」\n还要把你的修改加进去吗？\n加进去（可能会盖掉他们刚改的地方）\n不要了，用现在的最新版本"}
{"check":"paused-chip-after-close","ok":true,"pausedChip":"同步已暂停"}
{"check":"paused-chip-reopens-dialog","ok":true}
{"check":"offline-discard","ok":true,"c5":"B5-离线"}
{"check":"offline-dialog-2","ok":true}
{"check":"offline-replay","ok":true,"c5":"重放2","c7":"B7-重放"}
{"check":"backups-list","ok":true,...}
{"check":"backup-restore-is-new-write","ok":true,"revBefore":166,"revAfter":167}
{"check":"agent-undo-step","ok":true,"reverted":{"found":true,"done":true,"state":"done"},...}
{"check":"agent-undo-in-user-stack","ok":true}
{"summary":{"total":20,"passed":20,"failed":[]}}
```

V2 真实页面版：两个真浏览器页面（A `?editor`，B `?editor&join=<A 的项目号>`）同时各做 100 次随机编辑（一半拖动片段、一半改参数，3～28 ms 间隔交错），之后 A、B 两页的项目 JSON 与文档服务 `project.open` 拿到的真身三份 sha256 相同、版本号都是 150。另在 Claude 浏览器面板里手工跑过一次 60 + 60 次：三份 sha256 同为 `b8f9efb8…49e8`、rev 80（`docstate.mjs` 输出 `{"rev":80,"sha256":"b8f9efb8cd1eaf3c77ef24598502a64aee8f8826d433a3ed6badb26d77f949e8","bytes":1908,"clips":10}`）。

`--phases shared`（托管组合 5518）：

```
{"check":"lan-needs-restart-hint","ok":true,...}
{"check":"new-shared-hosted","ok":true,"created":"创建成功，已进入项目。","aView":{"kind":"shared",...,"where":"hosted","username":"alice","creator":true},"status":"online"}
{"check":"open-shared-wrong-password","ok":true,"wrong":"用户名或密码不对。忘了的话找创建者问一下。"}
{"check":"open-shared-enter","ok":true,...两页 sha256 相同}
{"check":"members-list","ok":true,"pop":"alice (自己)\n[创建者]\n[编辑中]\nbob (MacBook)\n[编辑中]\n踢出\nbob (DESKTOP-GS40TCK-vqxC)\n[编辑中]\n[Agent ×1]\n踢出\nbob · Agent · 第 2 个对话\n项目管理（仅创建者可见）\n改项目密码\n改创建者密码\n已禁入的设备\n删除项目"}
{"check":"members-button-badge","ok":true,"btnText":"成员: 3 人"}
{"check":"creator-verify-wrong","ok":true,"verr":"密码错误。"}
{"check":"member-password-changed-toast","ok":true,"pwToast":"项目密码已被修改。你当前的连接不受影响，但下次进入需要新密码。\n×"}
{"check":"kick-confirm-text","ok":true,"kickText":"确定要把 bob (MacBook) 踢出项目吗？\n取消\n踢出"}
{"check":"kick-free-mode-hint","ok":true,"kickToast":"已踢出。自由进入模式下，想彻底挡住，要改项目密码。\n×"}
{"check":"bans-list","ok":true,"bans":"已禁入的设备\nbob\npc-macbook-probe-0001\n撤销\n返回"}
{"check":"delete-needs-typed-name","ok":true}
{"check":"kicked-blocking-dialog","ok":true,"blocked":"你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。\n开始页"}
{"check":"delete-project","ok":true,"aAfter":"local"}
{"summary":{"total":14,"passed":14,"failed":[]}}
```

`--phases lan`（另起 `PROMPTCUT_LAN_HOST=1 PROMPTCUT_PUSH=0 npx vite <worktree> --port 5513 --strictPort`，编辑器绑 `0.0.0.0`）：

```
{"check":"lan-host-editor","ok":true,"device":{"deviceId":"pc-vqxCRm0vQRfjWbzscI-4fc","deviceName":"DESKTOP-GS40TCK-vqxC","lanHost":true,"localEditor":true}}
{"check":"new-shared-lan","ok":true,"created":"创建成功。让成员在同一个网段下查项目名就能进。记住本机要保持开着。"}
{"check":"open-shared-two-candidates","ok":true,"cands":"[局域网模式] 主机：DESKTOP-GS40TCK-vqxC\nc65-lan-muhk7njx\n[互联网模式] 托管在阿里云\nc65-lan-muhk7njx","title":"找到两个同名项目，你要进哪一个？"}
{"summary":{"total":3,"passed":3,"failed":[]}}
```

局域网项目验完以创建者身份删掉了（`shared.admin.ok delete`，再查 `no-project`），不会在以后以局域网主机启动时继续广播。

### 2.4 截图清单（1440×900，`C:\Users\admin\Documents\PromptCut\.worktrees\c65-editor\out\c65-editor-shots\`，未入库）

| 任务书要求 | 文件 |
|---|---|
| 新建共享项目对话框 | `new-shared-dialog.png`（自由进入、互联网）；`new-shared-restricted.png`（限定进入名单表）；`new-shared-lan-restart.png`（局域网要重启的提示）；`new-shared-lan.png`（局域网主机上）；`new-shared-done.png`（创建成功） |
| 打开对话框（含并列候选） | `open-shared-find.png`（托管地址展开）；`open-shared-choose.png`（两个同名候选并列）；`open-shared-verify.png` |
| 成员列表 | `members-list.png`（自己、创建者、重名带设备名、Agent ×1 展开） |
| 创建者操作 | `creator-verify.png`、`creator-change-password.png`、`creator-kick-confirm.png`、`creator-bans.png`、`creator-delete.png` |
| 部分没撤提示条 | `undo-partial-notice.png`；另 `undo-none-notice.png`（全部没撤） |
| 离线对话框 | `offline-dialog.png`；`sync-paused-chip.png`（关掉后顶栏「同步已暂停」） |
| 本地备份列表 | `backups-dialog.png` |
| 其余 | `blocked-kicked.png`（被踢阻断弹窗）、`member-password-changed-toast.png`、`overwritten-toast.png`、`remote-flash.png`（描边）、`v2-page-a.png` / `v2-page-b.png` |

我看过全部截图：对话框、提示条、描边、成员浮层都与稿件一致；顶栏气泡会盖住右上角按钮几秒，是气泡本来的位置。

## 3. 与稿件、设计稿不一致之处（逐条）

1. **稿件没写、我补的文案**（都需要主会话过目）：
   - 局域网模式要重启编辑器的提示与「复制命令」按钮（稿件与裁定都没有这一情形的文案）；
   - 保存等确认超时的提示；
   - 顶栏「离线」小标记（悬停「连不上文档服务：修改照常，先攒在本机，恢复后按顺序提交」）；
   - 提示条里「逆操作落不下去」（父级已被删）的那一项写「(已不存在，没法退回)」——稿件只有「由 X 修改」一种；
   - 「改创建者密码」菜单项、弹窗标题与成功气泡（裁定新增了操作，稿件没有文案）；
   - 「本地备份…」对话框的说明、「(还没有本地备份)」「恢复不了:…」、菜单小字「被覆盖、离线丢弃的修改」；
   - 托管地址格式不对的提示「托管地址不对：要以 http:// 或 https:// 开头。」；
   - 有一步修改被文档服务拒绝 / 离线重放时丢弃的气泡。
2. **「我是创建者」预填创建者名字**：查找接口只回 `{ projectId, name, mode }`，页面不知道创建者叫什么。本机建过的项目（本机记了创建者名）预填并置灰；否则用户名框可编辑、由用户自己填。
3. **登录时「已被踢」提示**：握手失败按契约只回 401、不说原因，浏览器分不出「密码错」和「被踢」。页面记下自己在哪个项目以哪个用户名被踢过（收到 4003 `kicked` 时），之后再以同名进入失败就给「你被创建者踢出了这个项目…」；换设备、清了浏览器存储就只能给「用户名或密码不对」。
4. **「尝试太多次」**：只有取挑战回 429 时能判断出来（握手 401 同样不说原因）；回环来源不计限速，所以本机上演示不出来，截图里没有这一态。
5. **「等 X 处」的 X**：按中文「等 N 处」的习惯取总数（不是剩下的数）。
6. **片段的称呼**：稿件例子「片段「开头空镜」」；我按时间轴上片段的标题（卡片名 / 素材标签）并带开始时间（`片段「模糊浮现 @2.0s」`），同一张卡出现多次时才分得开。
7. **Agent 的称呼**：稿件例子 `Agent「写分镜」` 是对话的标题，页面从写入身份里只拿得到对话号，写成 `Agent「第 2 个对话」`（别人的 Agent 写成成员列表同款「张三 · Agent · 第 2 个对话」）。
8. **本机两页之间的覆盖通知**：本机 `local` 空间里所有页面都是 `userId: 'local'`，靠 `session` 区分，所以「你在另一个页面」会出现在两页互相覆盖时（V2 的随机编辑会产生很多备份，本地备份最多留 500 份）。
9. **新增的服务端操作 `list-bans`、`set-list` 的 `keep`、`shared.notice`**：契约第 7 节没有，是界面要求（禁入列表、改名单、密码被改气泡）逼出来的最小扩展，已补单测。建议写进 `auth-contract.md` 第 7 节（语义文档我没动）。
10. **创建者本机上的局域网项目**：没有用契约里的「本机声明」（`promptcut.tenant.*`）进入，而是和别人一样凭创建者证明经回环进入——本机声明的用户名固定是 `local`，成员列表里会显示成「local」。

## 4. 遗留

- **AI 栏按事件 id 更新记录、列表虚拟化**：没做。AI 栏现在的记录仍来自 SSE；「撤销这步」按事件的 `callId` / `eventId` 对上 SSE 的工具调用，要求 c65-agent 的「完成」事件带 `opId`（必需）、`callId`（强烈建议）、`inverse`、`rev`、`actor`。现在的 `server/docservice/modules/events.mjs` 的 `complete` 只转发固定字段，**`opId` 等不会被广播出去**——c65-agent 那一路改 `events.mjs` 时要把这几个字段带上，集成时对齐。本分支的验收用 `__pcSyncTest.inject` 注入事件验了撤销本身（`agent-undo-step`、`agent-undo-in-user-stack`）；AI 栏里的按钮没有截图（要有一条真实对话才有操作卡）。
- **一键重启成局域网主机**：桌面壳没有重启接口，留给 C10 / 桌面壳（第 1.4 节）。
- **M5b 预渲染发布流程与真身冲突**（`AGENT-c65-integ.md` 第 7 节）：页面一接上就有真身，`PROMPTCUT_QUEUE_NODE=1` 时 `announce` 会与真身摘要对不上。缺省关着，G0-R 不受影响；不在我的清单里，没动。
- **本机 `local` 空间的日志会越积越多**：每次打开页面（新项目号）或打开草稿都会在 `out/docservice` 里多一个项目的日志；没有清理。
- **分片上传的上限**：单次根替换最多 64 片 × 128 Ki 字符 ≈ 8 M 字符；更大的照原样发，由文档服务回 `too-large`，页面出「有一步修改没被文档服务接受」的气泡。
- **`revertRemote` 的冲突检查窗口**：远端写入记录在撤销栈之外只留最近的（≥ 256 条时按撤销栈最老的一步修剪）；Agent 那一步太老、记录已修剪时只按页面还没确认的修改挡。

## 5. 收尾

- 起过的进程都已结束：Claude 浏览器面板的 preview（5510，`preview_stop`）；局域网主机 5513 那棵（根 `cmd` 52752，`taskkill /T`）；G0-R 的本分支 5510（根 51268）、main 基线 5513（根 47328）、托管组合 5518/5519（node 32140），都用 `taskkill /T` 结束。结束后 5510～5519 没有监听。没碰 5190～5192，没结束别人的进程。
- 主工作区 `.claude/launch.json` 临时加过 `c65-editor` 条目（5510），用完从备份原样还原，主工作区 `git status` 干净。
- 临时 worktree `.worktrees/c65e-main-baseline`（main `2e75bec`）：删之前 PowerShell 查 `reparse points: 0`，然后 `git worktree remove --force`。
- 托管组合的数据目录在 scratchpad，没有写进仓库；本 worktree 的 `out/`（截图、`out/docservice`、草稿目录的 `backups/`）未入库。

## 6. 需要主会话决定

- 预览兜底探针的那一次失败（第 2.2 节）怎么认定；`taskP90` 是否要带 `--baseline` 对照。
- 第 3 节我补的文案、第 3 节第 9 条服务端扩展（`list-bans`、`keep`、`shared.notice`）是否接受、是否写进契约。
- 与 c65-agent 集成时对齐「完成」事件的字段（`opId`、`callId`、`inverse`、`rev`、`actor`）以及 `events.mjs` 的转发。
- 合并、返工还是放弃。
