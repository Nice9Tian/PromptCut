# 报告：在线浏览器的新版本提示与换代保留（`gemini/editor-update-notice`）

- **日期**：2026-10-23
- **分支**：`gemini/editor-update-notice`（自本机 main `0e16b291` 建；语义提交 `55525690`）
- **工作区**：`.worktrees/editor-update`
- **执行**：agy（Gemini 4 Argon，沙盒内）写代码；agy manager（Claude）审查、提交、在沙盒外跑验收
- **实现的语义**：`docs/semantics/product/platforms.md`「新版本提示」；`docs/semantics/mechanism/platforms.md`「新版本提示」「换代保留」。语义文件未改。
- **状态**：任务书 7 项都做了，验收三条命令都过；未合并、未推送，等主会话审查

---

## 1. 做了什么

| 提交 | 内容 |
|---|---|
| `e39e4d7b` | 建本报告 |
| `f98325f9` | 在线构建产出 `version.json`；新版本检查逻辑 `src/online/updateCheck.ts` 与单测 UPD-01～07 |
| `cc28dbdd` | 换代保留前 3 代（`server/hosted/deploy.mjs`）；测试 DEP-4/6 改按 3 代，新加 DEP-7、DEP-8；README 一段 |
| `03073565` | 提示条 `src/editor/sync/UpdateNotice.tsx` 与 `updateNotice.css`；`src/main.tsx` 挂载；`updateCheck` 去掉 `fetch` 的别名 `fetchImpl` |
| `8ba91249` | 探针 `scripts/probes/update-notice-probe.mjs` |

### 1.1 version.json（任务书第 1 项）

- `vite.config.ts` 加插件 `promptcut-version-json`（`apply: "build"`，`generateBundle` 里 `emitFile`），只挂在在线构建（`onlineConfig`）的 `plugins` 里，产出 `dist-online/version.json` = `{"codeVersion":"<值>"}`，值与 `__PC_CODE_VERSION__` 用同一个 `codeVersion` 变量。桌面构建、开发服务不变。
- 托管端 nginx 的 `location /editor/` 已对 `/editor/version.json` 回 `Cache-Control: no-store`，语义里「和页面一样不缓存」不用改 nginx。

### 1.2 新版本检查 `src/online/updateCheck.ts`（第 2 项）

- `startUpdateCheck(env)` 回 `{ getState, subscribe, stop }`，直接交给 `useSyncExternalStore`；状态 `{ hasUpdate, currentVersion, latestVersion }`，没变时 `getState()` 回同一个冻结对象。
- 可注入：`base`（缺省 `/editor/`）、`codeVersion`（缺省 `buildInfo.ts` 的 `CODE_VERSION`）、`fetch`、`visibility`（缺省 `document`）、`intervalMs`（缺省 `UPDATE_CHECK_INTERVAL_MS` = 10 分钟）、`setInterval` / `clearInterval`。
- 行为：启动时不取；`visibilitychange` 且 `visible` 时取；在前台时每 10 分钟取，后台时计时到点也不取；`fetch(<base>version.json, { cache: "no-store" })`；同一时刻只一个请求；`codeVersion` 为 null（开发构建）时不挂监听、不起计时、永不取。
- 失败（抛错、非 2xx、非 JSON——nginx 在文件不存在时 `try_files` 回落成 `index.html` 并回 200、缺字段、空串）这一次不算，状态不变：不会挂出提示，也不会撤掉已挂的提示。
- 取到与本页相同的版本（例如服务端回退了）时提示撤下；不同就挂上。
- 层级：在 `src/online/`，不引 `src/editor/`，不静态引 `./mode`，不读 `import.meta.env`（`base` 由调用方传）。

### 1.3 提示条（第 3 项）与挂载（第 4 项）

- `src/editor/sync/UpdateNotice.tsx` 导出 `mountUpdateNotice()` 与文案常量 `UPDATE_NOTICE_TEXT`；模块顶层无副作用。
- 挂载条件（全部满足才挂）：在线构建（`ONLINE`）；路径不是舞台入口 `stage.html`（`isStageEntryPath`）；查询里没有 `stage`、`export`、`audioMix`、`proto`（与 `boot.ts` 的编辑器页判断同一条，再加上 `main.tsx` 选别的视图的几项）；整页只挂一次。挂在 `body` 末尾自己的容器 `#pc-update-notice-root` 上，自己一个 React 根。
- 第一步：底部居中常驻小条「有新版本，刷新后使用。」+「刷新」（`data-pc="update-notice"`、`data-step="notice"`）。
- 「只在这个页面里、没提交的改动」用 `useSync((v) => unsentAtRisk(v.status, v.unconfirmed, v.offlineStore))` 读：`syncManager.ts` 的 `useSync` 与 `onlineStatus.ts` 的 `unsentAtRisk` 都只读引用，没改这两个文件。这正是 `SyncOverlays.tsx` 挂浏览器离开确认用的同一个判断（`offlineStore === "page"`，离线或暂停，`unconfirmed > 0`）。
- 有这种改动时点「刷新」，原地换成第二步「还有只在这个页面里、没提交的改动，刷新会丢失。」+「仍要刷新」/「先不刷新」（`data-step="confirm"`）；改动没了自动回第一步。没有用 `window.confirm` / `alert`。
- 样式照 `.pc-offline-unsent` 的做法与变量：`bottom: 72px`（在离线常驻提示 36px 的上方）、`z-index: 950`；按钮用现有的 `pc-btn` / `pc-btn--primary`。
- `src/main.tsx` 只加两行：import 放在现有 import 最后，在 `createRoot(...).render(view)` 之后调 `mountUpdateNotice()`。`src/Shell.tsx`、`src/online/boot.ts` 没碰。

### 1.4 换代保留前 3 代（第 5 项）

- `editorSwapLines()`：新目录先写本代清单 `.assets-own`；再按旧目录的 `editor/.assets-own`（上一代）、`.assets-own.1`（上上一代）、`.assets-own.2`（上上上一代）三份清单，把旧 `assets/` 里还在、新目录里还没有的文件补进去（新的不盖，`.gz` 照旧随原文件补）；然后把旧的 `.assets-own`、`.assets-own.1` 顺延成新目录的 `.assets-own.1`、`.assets-own.2`，再早的清单丢掉。
- 缺的清单当空：服务器上现在只有 `.assets-own`，第一次跑新脚本照常工作（DEP-7 后半测了这条）。
- 没有 `index.html` 时 `exit 4`、`editor.prev` 整目录换名、`runtime-config.json` 跟着换代保留，这几样都照旧。
- `server/hosted/deploy/README.md` 加一段：手工换在线构建也必须走这套换代步骤（`deploy-hosted --editor`），不要整目录覆盖 `editor/`。

### 1.5 测试（第 6 项）与探针（第 7 项）

- `src/online/updateCheck.test.mjs`：UPD-01～07（启动不取、前后台、10 分钟计时、URL 与 no-store、相同 / 不同、null、各种失败不改状态、单飞、stop）。
- `server/test/deploy-editor.test.mjs`：DEP-4、DEP-6 改按 3 代断言，覆盖面不减；DEP-7 连续换代 6 次，每次核 `editor/assets/` 的完整文件列表与三份清单，再测从旧布局（只有 `.assets-own`）升上来；DEP-8 用仓库的 TS 解析钩子载入 `vite.config.ts`，核在线配置的插件产出 `version.json` 且值与 `define.__PC_CODE_VERSION__` 相同，桌面配置没有这个插件。`server/test/c10-deploy-stage-origins.test.mjs` 没被弄红，未改。
- 探针 `scripts/probes/update-notice-probe.mjs`：构建在线包（临时目录，不碰 worktree 的 `dist-online/`；`--dist` 可复用），仿 nginx 静态服务 `/editor/`（缺省端口 6410，只收 6410～6419），无头 Chrome。判据：
  - U0 `version.json` 非空，且原样出现在 `assets/*.js` 里；
  - U1 打开 `/editor/` 后不取、不提示；
  - U2 版本不变时切后台再切回前台，只取一次、不提示；
  - U3 服务端换版本后再切一次，提示条出现，文字与「刷新」按钮对；
  - U4 点「刷新」后页面重新载入；
  - U5 `?stage=1`、`stage.html`、`?export=1`、`?audioMix=1` 切前后台都不取、不挂。
  - 切前后台用真的标签页切换（`bringToFront`），无头 Chrome 里有效；不行时退回页面内模拟，输出里写明用的是哪种。

## 2. 验证结果（manager 在 worktree、沙盒外跑）

1. `npx tsc -b --force`（HEAD `8ba91249`）：退出码 0，零输出（零错误）。
2. `npm test`（全量，设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，单独一条命令，HEAD `8ba91249`）：

   ```
   ℹ tests 7686
   ℹ suites 0
   ℹ pass 7671
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 15
   ℹ todo 0
   ℹ duration_ms 239743.4261
   ✓ npm test 最终结果：零失败
   ```

   本任务相关的 DEP-1～8、UPD-01～07、C10-DS-01～03、C10A-API-01～08、C10-CATALOG-01/02、C10A-MODE-01/02、PRUNE-01/02、分层守门都跑了且通过。15 个跳过都是原有的环境跳过（真实转写依赖、POSIX 权限、symlink、真实渲染服务），与本任务无关。没有失败，不用单独重跑。
3. `node scripts/probes/update-notice-probe.mjs`：探针改完后连跑三次都通过（退出码 0，`ok: true`，`visibility: "tab-switch"`，连构建 17～21 秒）。其中一次的计数：U1 `version.json` 请求 0；U2 0→1；U3 1→2 并出现提示条（`data-step: "notice"`）；U4 `index.html` 请求 1→2、标记消失；U5 四条路由 `version.json` 计数始终是 2、都没有提示条；最后 `reqCounts = { indexHtml: 5, fallback: 5, versionJson: 2 }`。探针第一版也过了，但审出 U5 的竞态（见第 4 节第 5 条），已改。
4. 看图：manager 截了桌面（1280×800）与手机（390×844）尺寸的开始页提示条。桌面上底部居中一行，样式正常；手机上条子只有半屏宽、文字折成两行（见第 4 节第 2 条）。截图在 manager 会话的临时目录，未入库。

## 3. 没做成的及原因

- **第二步（只在本页的未提交改动在时的「仍要刷新」/「先不刷新」）没有自动化覆盖**：探针用的是生产构建、没有后端，造不出「离线且改动只在本页」的状态；`syncManager.ts` 的测试钩子 `__pcSyncTest` 只在开发模式有。判断本身复用 `unsentAtRisk`（`onlineSync.test.mjs` 已测），组件里的分支只经 manager 读代码审过。要测它，需要在有文档服务的探针里做（例如 c10 系列那种本机托管组合），或者由主会话另定办法。
- **探针还没登记进验收清单**：`scripts/acceptance/` 的 `--check-coverage` 第 ① 类（每个探针要登记或写明排除原因）在发版前跑，不在 `npm test` 里。登记要改 `scripts/acceptance/*-manifest.mjs`，不在本任务能改的文件里，留给主会话。

## 4. 对任务书或语义的更正建议（含范围外发现）

1. **渲染服务比对代码版本会被保留的旧代骗过**（agy 发现，manager 读代码核实；范围外，没改）：`server/hosted-render/main.mjs` 的 `editorHasCodeVersion(editorDir, version)` 递归扫在线页面目录下所有 `.js`、`.html`，只要有一个文件含这个版本串就判「一致」。`editor/assets/` 里现在保留前 3 代的脚本，渲染服务停在这 3 代之内的旧版本时，也会被判成与在线页面一致（以前只留一代时，上一代就有同样的问题）。建议改成先读 `editor/version.json`（只有本代的 `codeVersion`），读不到再退回扫描。
2. **手机上提示条折行**（前端，建议交给 Claude 子 Agent 审查与修）：`.pc-update-notice` 用 `left: 50%` + `translateX(-50%)` 定位，收缩适配的宽度最多只有视口的一半，390 px 宽的手机上「有新版本，刷新后使用。」折成两行。一行修法：给 `.pc-update-notice` 加 `width: max-content;`（保留 `max-width: calc(100vw - 32px)`）。现有 `.pc-offline-unsent` 用的是同一种定位，文字更长，可能有同样的问题。
3. **第二步之后浏览器还会再问一次**：改动只在本页时，`SyncOverlays.tsx` 已挂 `beforeunload` 离开确认；在提示条上点「仍要刷新」后，浏览器还会弹它自己的「离开此网站？」。不违反任务书（不是我们弹的），但用户会被问两次；要不要在「仍要刷新」时先撤掉那个监听，由主会话定（要改 `SyncOverlays.tsx`，不在本任务范围）。
4. **提示条的位置**：底部居中 `bottom: 72px` 是 manager 定的，为的是不和离线常驻提示重叠，没有设计稿依据。手机界面（`src/mobile/`）底部有没有别的控件会被它挡住，没有核过，一并交给 Claude 子 Agent 审。
5. **探针第一版的竞态（已修）**：U1～U4 的主页面在 U5 时还开着，每关一个子页面它就回到前台又取一次 `version.json`，U5 只是碰巧没算进去。改成进 U5 前关掉主页面，U5 每条路由各用一个新的浏览器上下文。

## 5. 执行说明

- agy 在沙盒里只写得了 manager 给了精确写权限的文件：`tsc -b` 写不了 `tsconfig.tsbuildinfo`（它改用 `tsc --noEmit` 自查）；Git Bash 起不来，DEP-4/6/7 在沙盒里跳过；探针在沙盒里跑不了（在线构建要写允许范围外的临时文件，Chrome 装在用户目录下）。所以第 2 节的结果都由 manager 在沙盒外跑。
- 端口只用了 6410（探针）与 6412（manager 截图）；没起 dev server；没有结束不是自己启动的进程。