# AGENT 报告：claude/storage-ui

分支 `claude/storage-ui`，起点 main `35f1fddd`。任务：存储占用计划（`docs/plan/storage-plan.md`）B 部分的界面与导出产物接口——开始页「存储」一块、标题栏菜单「存储…」、`/api/exports*` 四个接口。端口段 5720～5729（探针只用了 5720～5722）。语义照分支 `claude/storage-semantics`（`14f14718`）的 `workflow/project.md`、`product/platforms.md`、`mechanism/platforms.md` 做，本分支没改 `docs/semantics/`。

## 做了什么

### 1. 导出产物接口（计划第 4 节）

- `server/exports-list.mjs`（新）：只管文件系统。
  - 导出目录 = `PROMPTCUT_EXPORT_DIR || <viteRoot>/out`（与 `vite-plugin-export.ts` 的 `outRoot` 同）。
  - 只认导出目录直接下面、名字是 `export-YYYYMMDD-HHMMSS`（同秒重名后缀 `-<1～4 位数字>`）的真目录；`export-vision-*`、同名文件、链接、junction 不认。
  - 每份：`{ id, projectName, projectId, at, finished, running, bytes, deliverables: [{ name, bytes }], intermediateBytes }`，新的在前。`projectName`/`projectId` 读 `project.json` 的 `name`/`id`（没有就 null）；`at` 由目录名按本地时间换成 ISO；`finished` = 有 `preview.mp4`；deliverables 是 `preview.mp4`（成片）、`overlay.mov`（透明层）；中间文件 = 总量 − 成片 − 透明层 − `project.json`（计划第 3.3 节留下的三样）。
  - 走目录、算字节、删除都用 lstat、**不跟链接**：目录里的链接不算大小、删除时跳过且不碰目标。
  - 路径校验：id 过正则（挡掉 `..`、斜杠、vision、别的名字），`lstat` 必须是真目录，`realpath` 的父目录必须是导出目录。
  - 删除与只删中间文件：逐项删，删不掉的（Windows 上被别的进程打开，EBUSY/EPERM）记下，回 `409 { ok: false, error: "有 N 项正被别的程序占用，没删掉（例如 …）。关掉正在用它的程序后再试。" , freedBytes }`；跳过了链接也照实说。
  - 进行中保护（任务书没写，我加的）：本进程有导出在跑（`render-pool-state.mjs` 的 `exportsRunning() > 0`），且这份没有成片、10 分钟内还在写，列表标 `running: true`，删除与只删中间文件回 409「这份导出还在进行」。
  - 另导出 `summarizeExports(root)` → `{ bytes, count, intermediateBytes }`，storage-cap 做 `GET /api/storage` 的 `exports` 一栏可以直接引。
- `server/vite-plugin-exports-list.ts`（新）：`GET /api/exports`、`POST /api/exports/<id>/delete|prune|reveal`；方法不对 405，未知动作 404，id 解码失败 400。reveal 照 `vite-plugin-export.ts` 的 `handleReveal`（explorer / open / xdg-open，不看退出码），按目录 id 打开。
- `vite.config.ts`：`desktopConfig.plugins` 里在 `exportPlugin()` 后面加 `exportsListPlugin()`（在 `apiGuardPlugin` 之后，同源守卫先过）；在线构建（`onlineConfig`）不挂任何接口插件，不用改。

### 2. 开始页「存储」一块（`src/StartPage.tsx`、`src/StartPage.css`）

- `DesktopStartPage` 末尾加 `<StorageSection />`（`data-pc="start-storage"`），样式照「本地草稿」与拓展卡。
- 两张卡：
  - 预渲染缓存：`GET /api/storage` 的 `frameLibrary`：占用 / 上限（缺省时标「（缺省）」）、进度条、上次自动清理（有 `lastEvict` 才出）、上限输入框（GB，5 到磁盘总容量，越界前端先拦、不发请求）+「设定」（`POST /api/storage/cap { bytes }`，JSON）、「清理缓存」（确认框，`POST /api/storage/clear-cache`，完成后「清理完成，腾出 X」）。
  - `/api/storage` 取不到（404、开发服务器回首页 HTML、`ok:false`、回包形状不对都算）时写「暂时取不到。预渲染进程起来后点「刷新」再看。」，「清理缓存」置灰，页面不报错。
  - 导出产物：总大小、份数、其中中间文件多少（由 `/api/exports` 的列表在前端加总）。
- 导出列表（新的在前）：所属项目（没有 `project.json` 显示「未知项目」）、时间、大小、成片与透明层各多大、中间文件多少；未完成的标「未完成」、进行中的标「进行中」。每项「打开所在目录」、「只删中间文件」（有中间文件且不在进行中才出，确认框）、「删除」（确认框：「删除导出「…」？这会删掉磁盘上的文件（X），包括成片与透明层，不能撤销。」）。
- `humanSize` 加了 G 一档（原来到 M 为止，几十 GB 会显示成「51200.0M」）；草稿的显示不受影响。另加 `humanDateTime`（在 `humanDate` 后面补时分：同一天导出几次只有日期分不出）。
- 在线构建：`StartPage` 在线构建里就是 `OnlineStartPage`，`DesktopStartPage` 连同 `StorageSection` 和其中的 `/api/storage*`、`/api/exports*` 调用一起剪掉（下面「验证」里 grep 了产物）；`OnlineStartPage` 没动。

### 3. 标题栏菜单「存储…」（`src/ui/WindowTitleBar.tsx`）

- 「文件」菜单「打开数据目录」下面加 `{ label: "存储…", command: "open-storage", desktopOnly: "存储" }`（在线页面照其它桌面项置灰）。
- 做法照「返回首页」：在编辑器里时把 `go-home` 交给顶栏（`TopBar.tsx` 的 `goHome`，有未保存改动时它问一句），同步听一下有没有真的发出 `pc-go-home`；回去了才留一个待办，开始页挂上时取走并滚到「存储」；在确认框里取消就不留。已经在开始页时发 `pc-open-storage`，开始页自己滚过去。上面几块（草稿、拓展）是异步读出来的，会把「存储」往下推，所以滚过去后 1.5 s 内跟着 ResizeObserver 再滚。
- 没改 `TopBar.tsx`、`Shell.tsx`。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 单测 | `node --test server/test/exports-list.test.mjs` | 10/10 通过，退出码 0 |
| 界面探针 | `node scripts/probes/storage-ui-probe.mjs --port 5720 --out <scratch>/storage-ui-shots` | `"ok":true,"fails":[]`，退出码 0（第一次 U4 三条挂：判据「标题在视野上半」不对，「存储」是最后一块、容器已滚到底时标题停在 510px；判据改成「在视野里且（在上半或已滚到底）」后通过，界面代码没改） |
| 在线构建 | `npx vite build --mode online --outDir <scratch>/online-dist` | 退出码 0；产物里 `/api/storage`、`/api/exports`、`start-storage`、`storage-export`、`暂时取不到`、`只删中间文件`、`pc-open-storage` 都是 0 个文件；「存储…」菜单文字 1 处（置灰的菜单项，与「打开数据目录」等同） |
| 类型检查 | `npx tsc -b --force` | 0 错误，退出码 0 |
| 全量测试 | `npm test` | tests 3886、pass 3884、fail 0、skipped 2（两条原有的集成测试，要外部 dev server），退出码 0；一次过，没有需要重跑的文件。其中 C10A-API-03（在线构建 /api 棘轮）、PRUNE-01 通过 |
| 构建 | `npm run build` | 退出码 0 |

单测覆盖：认得的、同秒后缀、`export-vision-*` 排除、同名文件不认、没有 `project.json` 的也列出、新的在前；中间文件字节；导出目录本身是 junction 的不列不删、目录里的 junction 不算大小、删时跳过且目标还在；`..`、斜杠、反斜杠、vision、别的目录、空与 null 一律 400，不存在的 404；只删中间文件后只剩三样、回腾出字节、再删一次 0；删整份；进行中不让删；Windows 上用 PowerShell 以共享模式 None 握住一个分片，只删中间文件与删除都回 409「占用」、别的照删；路由的回包键、405、404、400、放给下一个中间件。

探针断言（U1～U6 是探针里的断言编号）：U1 列表 3 条新的在前、vision 不列、「未完成」「未知项目」、`/api/storage` 不存在时显示「暂时取不到」且无报错条；U2 只删中间文件后 43.0M → 23.0M、磁盘上只剩 `overlay.mov`/`preview.mp4`/`project.json`；U3 删除后 2 条、目录没了、vision 目录不动；U4 开始页上点「存储…」滚到、从 `?editor` 点也回开始页并滚到，1.7 s 后仍在；U5 拦截模拟 `/api/storage*`：「12.0G / 上限 50.0G（缺省）」、清理后「腾出 9.0G」且变「3.0G」、改上限发一次 `{ bytes: 21474836480 }`（application/json）回显「上限 20.0G」、填 2 不发请求并提示范围；U6 `..`、vision 的 delete/reveal 回 400，不存在的回 404；页面无未捕获错误。

截图（scratch 目录 `C:\Users\admin\AppData\Local\Temp\claude\C--Users-admin-Documents-PromptCut\33960a81-c3e7-4589-8c3f-514fe979f675\scratchpad\storage-ui-shots\`）：`u1-storage.png`、`u2-pruned.png`、`u3-deleted.png`、`u4-menu-from-start.png`、`u4-menu-from-editor.png`、`u5-storage-mocked.png`、`u5-cleared.png`、`u5-cap.png`。看过 u1、u4-menu-from-start、u5-cap：布局正常；u5-cap 里发现越界提示和上一条成功提示同时出现，已改成越界时清掉旧提示，改后重跑探针仍 `ok:true`，u5-cap.png 复看只剩范围提示。

探针的 dev server 带 `PROMPTCUT_NO_PORT_FILE=1`，`PROMPTCUT_EXPORT_DIR`、`PROMPTCUT_DATA_DIR` 指系统临时目录（跑完删掉），先引 `scripts/lib/no-user-dirs.mjs`；没碰 `Videos\PromptCut`。只读看过 `Videos\PromptCut` 下几份真导出的目录结构（`ls`）和一份 `project.json` 的开头。

## 没做成的、没做的

- storage-cap 未合入，真 `/api/storage*` 没法端到端测；界面用拦截按计划第 4 节的回包形状测过。合入后建议重跑本探针（U1 会走 `storage-cache-bytes` 那一支）。
- 「打开所在目录」只测了路径校验，没在探针里点真的：会在用户桌面上弹资源管理器。
- 真机（用户 PC 上看开始页「存储」）是待用户项。

## 对计划与语义的更正建议

- 计划第 4 节 `GET /api/exports` 的回包我多加了 `running`（进行中不让删），建议补进接口约定。
- 计划第 4 节没说删不掉时的回包：本分支是 `409 { ok: false, error, freedBytes, busy, skipped }`，建议补上。
- `/api/storage` 的 `exports` 一栏可由 storage-cap 直接引 `server/exports-list.mjs` 的 `summarizeExports`，免得两份列举规则不一致。
- 标题栏「存储…」在在线页面里是置灰的菜单项（同其它 `desktopOnly` 项）；语义「在线浏览器模式没有这一块」指的是开始页那块，菜单项置灰与 C10 契约第 10 节的做法一致。如要在线页面连菜单项都不出，需另定。
