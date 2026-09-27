# AGENT-online-prune 报告

分支 `claude/online-prune`，基于 `claude/c10-integ`（24c2c57）。任务：M8 遗留 L24（M8 执行计划第 5 节遗留表里的一条维护项）——在线构建按编译期的 `ONLINE` 剪掉置灰入口背后的调用，让 `/api` 棘轮清单变短。棘轮清单指 `server/test/c10a-online-api-paths.json`：在线构建产物里还允许出现的 `/api` 路径，只许减不许增。

## 结论

- `/api` 棘轮清单从 **120 条减到 20 条**。
- 在线构建 `assets/` 从 7,406,801 字节降到 7,030,435 字节（少 376,366 字节，约 5.1%）；其中 JS 从 6,031,394 字节降到 5,655,028 字节（少 376,366 字节，约 6.2%）。
- 桌面行为不变；在线页面上看得见的行为不变（入口仍在、仍置灰、悬停说明照旧）。
- 渲染路径（`src/render/`、`Preview.tsx`、`stageSwap*`、卡片）没有改，所以没有跑 G0-R。

## 关键发现：为什么原来一条都没剪掉

实测（vite 8.2.2，打包器 rolldown）：

1. **rolldown 摇树时不认从别的模块引进来的常量。** `mode.ts` 的 `ONLINE` 引到别的模块里，要到之后的常量内联、压缩阶段才换成 `true`；那时只能去掉就地写的函数字面量（`collab.ts` 的 `postEnqueue = ONLINE ? null : async () => …` 就是这样剪掉的），它引用的模块和顶层函数照样留在产物里。打开 `optimization.inlineConst: true` 也一样（内联发生在摇树之后），试过不采用。
2. **运行期标记 `onlinePage()` 当然也剪不掉。** 压缩后它变成 `function(){return!0}`，但调用处不内联。
3. **本模块里写的常量摇树认得。** 在用到的模块里就地写一行

   ```ts
   const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
   ```

   Vite 把 `import.meta.env.VITE_PC_ONLINE` 换成字面量后，rolldown 在摇树时就能判定分支死活，连同只被死分支引用的模块一起剪掉。值和 `ONLINE` 相同（在线构建、`VITE_PC_ONLINE=1` 起的开发服务都为真）；Node 单测里没有 `import.meta.env`，为 false，不会像静态引 `mode.ts` 那样当场抛错，所以会被单测载入的模块也能用。
4. **有副作用的顶层语句会把整棵子树拖进来。** 例如 `mcp/api.ts` 的 `editorApi = { ...a, ...b }`（展开写法算副作用）、`MessageList.tsx` 的 `React.memo(...)`（模块因 `chat.css` 的引入被带进来，这一行又算副作用）。这两处标 `/* @__PURE__ */` 后才剪掉背后的工具执行器和工具图示。
5. **`if (ONLINE_BUILD) throw/return` 之后的代码 rolldown 当死代码去掉。** 所以一个函数开头加一行早退就能剪掉它后面的 `fetch`。

写法与理由记在 `src/online/pageFlag.ts` 的「在线构建剪枝」注释里。

## 剪掉了哪些调用

| 提交 | 位置 | 做法 | 剪掉的 `/api` |
|---|---|---|---|
| 769eba1 | `src/editor/dock/DockPages.tsx` | Agent 页按就地常量选占位页，不挂 `AiPanel` | `/api/ai/*`（模型、配置、对话、诊断、安装等）、`/api/chats/*` |
| 2d012f4 | `src/editor/right/index.tsx` | 不连工具执行器；采集登录框、配音设置框、交出浏览器浮层在线不挂（打开它们的入口在线都置灰或不存在） | `/api/mcp/*`、`/api/web/*`、`/api/collect/*` 的一部分、`/api/voice/*` 的一部分 |
| 2d012f4 | `src/StartPage.tsx` | 拆成 `OnlineStartPage`（只有「加入别人的项目」）与 `DesktopStartPage`，按就地常量二选一 | 草稿列表、拓展功能卡背后的 `/api/projects`、`/api/stt|shots|track|subject|collect|voice` 状态与安装 |
| 0965725 | `src/mcp/api.ts` | `editorApi` 改成 `/* @__PURE__ */ Object.assign({}, …)`，没人用就整表剪掉 | 各 handler 背后的 `/api/cards/create|edit|source|dom|guide`、`/api/vision/bake|sheet|snapshot`、`/api/audio/measure` 等 |
| 748417c | `src/editor/TopBar.tsx` | 在线置灰的新建、打开、保存、打包保存在在线构建里换成空函数；Skill 对话框在线不挂（SKILL 一格置灰） | `/api/media/local`、`/api/skill/start` |
| 71c73c0 | `src/editor/right/chat/MessageList.tsx` | `React.memo` 标纯调用 | `/api/ai/visual/` |
| 1b17e94 | `src/editor/ModeSwitch.tsx`、`src/editor/io/proc.ts` | 在线构建不订阅、不退出 SKILL 模式，存盘不盖 SKILL 戳（在线进不了 SKILL 模式） | `/api/skill-mode*`、`/api/skill/jobs*` |
| 223256c | `src/editor/io/stt.ts` | 三个入口一进来就报「在线浏览器模式暂不支持语音识别…」 | `/api/stt/*` |
| 1c46827 | `src/editor/io/mediaUpload.ts`、`src/editor/cardScope.ts` | 入库、补算哈希、小版轮询与补转在在线构建里直接回空；归属表直接回空 | `/api/media/upload/`、`/api/media/adopt`、`/api/media/tiers`、`/api/media/tiers/backfill`、`/api/cards/scopes` |
| d67e5b3 | `src/editor/timeline/ShotMarkers.tsx`、`src/Shell.tsx` | 镜头缩略图在两个标记里再判一次；开始页启动参数（草稿、按路径打开、无头钩子）和桌面壳打开文件在线构建里不接 | `/api/shots/thumb/`、`/api/projects/`、`/api/skill/open-path` |
| 67db371 | `src/editor/sync/syncManager.ts`、`src/editor/sync/cardSync.ts`、`src/editor/io/procLock.ts` | 绑定写成 `!ONLINE_BUILD && !ONLINE`（单测把 `mode.ts` 换成在线桩时照旧按 `ONLINE` 走）；卡片同步的「项目变了再报」与草稿锁在线构建里早退 | `/api/agent/bind`、`/api/cards/sync/bind`、`/api/skill-lock/*` |
| 6856e9d | `server/test/c10a-online-api-paths.json`、`server/test/c10a-online-build.test.mjs`、`src/online/onlinePrune.test.mjs` | 清单缩到 20 条；C10A-API-03 改成清单与产物逐条一致（产物里已没有的路径留在清单里也判红）；新守门核对就地常量逐字相同 | — |

## 清单对比

前（120 条）：见 `git show 24c2c57:server/test/c10a-online-api-paths.json`。

后（20 条）：

```
/api/asset  /api/cards/install  /api/data/costs  /api/data/diff  /api/data/playhead  /api/data/project
/api/export  /api/frames/  /api/frames/snapshot  /api/frames/snapshot/  /api/frames/stream/
/api/media/file  /api/media/prefetch  /api/media/remote  /api/media/upload-queue/target
/api/prerender/info  /api/ui-render/bake-batch  /api/vision/bake-batch  /api/vision/bake-evict  /api/vision/bake-status
```

留下的都不在置灰入口背后，是和桌面共用、运行期按宿主能力分支的调用：渲染与快照（`frames`、`prerender`、`data`、`vision/bake-*`、`ui-render`，在 `src/render/`、`Preview.tsx`、`Scene3DView.tsx`、`probeRunner.ts` 里）、素材分档（`assetTiers.ts`、`mediaUrls.ts`）、导出（`io/index.ts` 按 `ONLINE` 分到在线导出）。`/api/cards/install` 在「合并 Skill 结果…」背后，那一项在线**没有置灰**（见下文「没做的」）。

## 验证

都在 worktree `C:\Users\admin\Documents\PromptCut\.worktrees\online-prune`、提交 6856e9d 上跑。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零输出 |
| 全量测试 | `npm test` | 退出码 0；tests 3565，pass 3563，fail 0，skipped 2。相关用例：C10A-API-01～04（03 已改成逐条一致）、C10-RA-01（清单是基线的子集）、C10A-MODE-01/02、PRUNE-01/02 全过 |
| 在线构建 | `npx vite build --mode online` | 退出码 0；`/api` 路径 20 条，与清单一致；`assets/` 7,030,435 字节，JS 5,655,028 字节；主块 `index-*.js` 4,351.80 kB → 4,046.82 kB |
| 网页构建 | `npm run build` | 退出码 0 |
| 在线开始页 | 用 5810 端口的静态服务把 `dist-online/` 挂在 `/editor/` 下，浏览器打开 | 只有「加入别人的项目」表单；网络记录里没有 `/api` 请求，唯一的 404 是部署才有的 `/editor/runtime-config.json`（预期内，读不到就退回单舞台） |
| G0-R | — | 没跑：渲染路径没改 |

没跑的：`c10-browser-probe` 等要托管文档服务的在线探针（进编辑器看置灰入口）没跑，本机没搭托管组合；置灰入口的悬停文案与禁用态由单测（c10-ui-gates 等）覆盖，本分支没改那些 JSX 的禁用、文案部分。

前后数字（同一台机器、同一套依赖，产物写进临时目录量的）：

| | 前（24c2c57） | 后（6856e9d） | 变化 |
|---|---|---|---|
| `/api` 棘轮清单 | 120 | 20 | −100 |
| `assets/` 总字节 | 7,406,801 | 7,030,435 | −376,366 |
| 其中 JS 字节 | 6,031,394 | 5,655,028 | −376,366 |

## 没做的及原因

- **渲染、快照、素材分档、导出里的 `/api` 调用**：不在置灰入口背后，动它们要改渲染路径（还会碰 `Preview.tsx`，与改 `stageSwap*` 的分支相邻），不在本任务范围。
- **`/api/cards/install`**：在顶栏「⋯ → 合并 Skill 结果…」背后（`combineImport.ts` → `procCards.ts`）。这一项在线页面上**没有置灰**，点得到；标题栏菜单发来的同名命令在线却被挡掉。剪掉它会改在线页面看得见的行为，没有动。建议主会话定：这一项在线是否应当置灰（C10 契约第 10 节的置灰清单里没有它）。
- 顶栏「配音设置」按钮的 `onClick`（`openVoiceSettings`）没换：它只改本页的状态，背后没有 `/api`。

## 对任务书或语义的更正建议

- TODO.md 这一条写「做法同 `collab.ts`」。实测 `collab.ts` 那种写法（引 `mode.ts` 的 `ONLINE`）只剪得掉就地的函数字面量，剪不掉模块；要剪模块得在用到的模块里就地写 `ONLINE_BUILD`（见上文「关键发现」）。建议把 TODO.md 这一条标为已做并改掉「做法同 `collab.ts`」。
- `mechanism/platforms.md`「在线浏览器模式」可以补一句三级机制：在线构建靠各模块就地的编译期常量剪掉桌面才有的调用，棘轮清单与产物逐条一致。是否写进语义由主会话定，本分支没有改语义文档。
