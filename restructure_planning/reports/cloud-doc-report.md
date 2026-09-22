# cloud-task.md 搬运报告

分支：`worktree-agent-ac8b0bae800b0c48e`（worktree `.claude/worktrees/agent-ac8b0bae800b0c48e`）
起点：`git merge --ff-only main` 到 `048074c`，工作树干净。
产出：只新建 `docs/plan/cloud-task.md`（79 958 字节），没改任何别的文件。

## 材料读过的

- 源文本 `old-taskbook-v111-folded.md`（402 行）按节切片后逐节读：顺序表 1–27、组件与术语 62–90、A0 91–98、A 99–115、B 116–128、D 137–151、F 202–209、I 243–259、J 260–269、L 270–280、约束 293–302、验收 303–325、不做 326–402。
- `docs/plan/r75/fold-notes.md` 的 r75-07 / 08 / 09 / 10 四节逐条核对。
- `docs/plan/r2-r7-task.md`（体例样板 + 指路目标）。
- `render_pipeline_restructure.md` 3.1 / 3.7 / 3.8 / 4 / 5 / 6 / 7。
- `future_planning.md` 第 1 条。
- `user_pinned_goal.md` 全文逐条。

## r75 四节逐条落点

### r75-07（第 5 步：A1 上云、A3b、A5、A6）—— 源文本里**都没折**，本次全部折进

| 条 | 结论 | 落在哪 |
|---|---|---|
| 1 `uploaded` 按两档分开记 | 折进 | A1「上云」段给出 `uploaded?: { small?: boolean; original? : boolean }`；验收 A1 改成「分别翻真」 |
| 2 上传统一分片 + 已收分片查询 | 折进 | A1「上传一律走分片」三条端点（`PUT media/<hash>/<n>`、`GET media/<hash>/chunks`、`POST media/<hash>/complete`）；不做清单加「整件 `PUT media/<hash>`」 |
| 3 内容库接口形状 | 已在源文本（随 r75-08 折过） | 组件表「内容库」行 |
| 4 清单里 `skipped` | 折进 | A3b 的清单形状 `{ key, frames, skipped }` + 「下载端见 skipped 不等」 |
| 5 `playbackUrl` 加 `cloudBase` | 折进 | A1 换档段的签名 |
| 6 A3b 下载落盘走 snapshot-store 同一个写入函数 | 折进 | A3b「下载」段；验收 A3 也加了这条链 |
| 7 顺序倒置（A6、A3b 清单挪第 6 步） | 折进 | 分步表第 5 / 6 步、A6 标题标「第 6 步，不是第 5 步」+「它为什么在第 6 步」、A3b 的「分步」段 |
| 8 `.procp` 只打包原片 | 折进 | 组件表 `.procp` 行 + 验收 A1 |
| 9 原片可播性 `playable` | 折进 | A1「原片可不可播」段、`playbackUrl` 规则、验收 A1；**同时列进「需要定的问题」第 2 条**（fold-notes 要求写进 reply_to_users_goal.md 请用户确认读法，我没有权限改那个文件） |
| a `/api/media/local` 超 100 个哈希分批 | 折进 | A1「预取队列」段 |
| b A5 卡级 / A3b 块级两层 | 折进 | A5 末段 + A3b 的三条规则排序 |

### r75-08（第 6 + 7 步：D1、D2、D4 服务端侧、B）—— 源文本里**已经折过**，本次逐条确认

1（layout 的 `{session, localRev}` 用 I2 那对键）、2（B4 只约束 Agent 写工具 + `since` 回包）、3（D2 事件经文档服务推给页面）、4（`event-detail` 走内容库 + 内容库三条消息）、5（`message_ignore` → `card.unfollow`）、非阻塞 1（备份由接收方做、通知不带路径）、2（「文档服务上的最新版本」）、3（B6 只锁源码写工具）、4（`MIRRORED_TOOLS` 定义）、5（留在页面的工具判据）、6（锁记进操作日志 `type: 'lock'`）、7（v5/v6/v7 是 `cardRev`）、8（`/api/cards/layout` 只在 agent/full、user 回 503）——**13 条全部已在源文本里，本文原样带过来**。
非阻塞 8 的「`/api/cards/layout` 属于 Agent 的路」这一半在源文本 L254(c) 里**还是旧的**（列在「用户的路」），我按 r75-09 第 3 条改了。

### r75-09（第 7b + 8 步：I、D3 预渲染部分）—— 源文本里**只折了第 1 条**

| 条 | 结论 | 落在哪 |
|---|---|---|
| 1 第 8 步的接口面（`afterFonts` 钩子 + `rects`） | 已在源文本的 D3；**不属于本文**（D3 在 r2-r7） | 分步表第 8 步只留指针 |
| 2 插队在 background 链空闲时没人接 | 折进 | I4(b2) 末句「没有批在跑时插队项自己走 `acquire('background')`」 |
| 3 拆分模式下 gif 走 `'user'`、layout 归 Agent 的路 | 折进 | I4(c) 的「一条例外」+ 不做清单 + 本机验收末句 |
| 4 Agent 查询侧的镜像键 + 409 `MIRROR_MISSING` 重推 | 折进 | I2「Agent 侧的查询一律带 I2 推送时的同一对键」段 |
| 非 1 `release('agent')` 改成只重置空闲计时器 | 折进 | I1 的 `/api/cards/dom` 第三点 |
| 非 2 措辞「这个 Chrome 也不空着」 | 折进 | I4(b) |
| 非 3 I0 验收补 `full` 模式跑 Ubuntu | 折进 | I0 验收末句 |

### r75-10（第 9 + 10 步：F1 / F3 / F4、L）

| 条 | 结论 | 落在哪 |
|---|---|---|
| 1 F3 浏览器模式范围句 | **已在源文本**，确认带过来 | F3 末段 |
| 2 本地内容库 GC 两种口径 | **已在源文本**，确认带过来 | F1 |
| 3 F4 `projectRev` 不归零 | **已在源文本**，确认带过来 | F4 + 读法的三个版本号 |
| 4 canvas 重卡按拍换快照 | 折进（源文本是反的） | L4 + 括注说明为什么改 |
| a L 验收补两条断言 | 折进 | L 节验收末句 |
| b IndexedDB 复合键 `[kind, key, localFrame]` | 折进 | L2 |
| c `subscribeReady` 由 L2 每次写入触发 | 折进 | L2 |
| d `deadMs` 放宽成函数 | 折进 | L4「换帧成本进预算」段 |
| e `StreamSource` 签名 | 折进（**带保留**） | L5(2) 给了签名，并注明 `streamKey` 拼法和索引字段要和 R8 对齐；列进「需要定的问题」第 4 条 |

**折不进去的**：没有。r75-09 第 1 条唯一一条不在本文范围（属于 r2-r7 的 D3），已在分步表里指路。

## 2026-09-22 之后的事实，落在哪

- 第 5 / 6 步顺序倒置 → 分步表 + A6 + A3b。
- 内容库 WebSocket 消息 → 组件表。
- 素材上传统一分片 + 已收分片查询 → A1。
- B4 只约束 Agent 写工具 → B4。
- 模式切换 `projectRev` 不归零 → F4 + 读法。
- 拆分模式下 AI 菜单动图不进 Agent 专用 Chrome → I4(c) 例外 + 不做清单。
- 生成快照改名（`createSnapshot` / `src/render/snapshot/*` / `window.__pcCreateSnapshot` / `snapshotCode` / `SNAPSHOT_FILES` / `SceneSnapshot` / `ControlSnapshot`）→ 路径缩写表、A3a、L1、「本文没带走的内容」。旧名字只在「没带走」那一节作为对照出现。
- `frameMs` 删、判重只看 `stepMs` → 「本文没带走的内容」；`mode=dev|build` 拼进 `device`、浏览器模式只看 build → L2 的 `costs` 表 + L 节验收。
- 在线浏览器模式 canvas 重卡不活渲 → L4。
- 快照体积通用兜底（超上限不进索引、不投递、也不上云）→ A3b 第 3 条 + 验收 A3。
- `unknown` 按 `belowDependent`（只有本地档、不上云、不进流）→ 总规则、A3a、A3b、不做清单。
- 解耦后的路径 → 路径缩写表（`src/mcp/routes.mjs`、`src/mcp/common.ts`、`server/vision/*`、`server/bakery/*`）；I4(b)/(b2) 明写落点是 `worker-pool.ts` 和 `render-queue.ts`。

## 行号核对

**在当前 main（`048074c`）上逐个打开核对过的 `文件:行号` 共 62 处**，没有一处标成「b5c65dc 的行号，仅作提示」（读法里写了「行号只作定位提示，以符号名为准」的通用免责）。核过的锚点：

`src/kernel/project.ts:115-118 / :140 / :142 / :151 / :334`；`src/render/mediaTier.ts:18`；`src/editor/io/mediaUrls.ts:24`；`src/editor/io/proc.ts:84 / :239`；`src/editor/io/drafts.ts:47`；`src/editor/TopBar.tsx:306`；`src/mcp/common.ts:42 / :90 / :97`；`src/mcp/routes.mjs:39`；`server/vite-plugin-media.ts:17 / :67 / :171 / :235 / :334 / :447 / :486 / :508`；`server/vite-plugin-frames.ts:53-54 / :86`；`server/vite-plugin-mirror.ts:60 / :121 / :158 / :163 / :196 / :223`；`server/vite-plugin-cards.ts:175 / :702 / :1197 / :1237 / :1239 / :1275-1276 / :1292 / :1296 / :1303`；`server/vite-plugin-prerender.ts:23 / :25 / :58 / :80-88 / :108`；`server/vite-plugin-ai.ts:207 / :253`；`server/prerender-client.mjs:13 / :16 / :21 / :86`；`server/frame-pipeline.mjs:90 / :195 / :292 / :352 / :464 / :732 / :799 / :824 / :931-933`；`server/snapshot-store.mjs:26-27 / :30 / :61 / :72`；`server/card-identity.mjs:99`；`server/frame-code.mjs:71 / :75`；`server/vision/http.ts:45`；`server/vision/render.ts:73`；`server/vision/routes.ts:198 / :249 / :292`；`server/vision/render-queue.ts:115`。

引用但**不带行号**的符号（都 grep 得到）：`storeMediaStream`、`resolveHashFile`、`mediaMiddleware`、`outRoot`、`mergeRanges`、`snapshotDir`、`cardSnapshotIdentity`、`snapshotCode`、`SNAPSHOT_FILES`、`backupBeforeEdit`、`checkCardSource`、`ensureMirror`、`repushMirror`、`findFfmpeg`、`resolveMediaUrls`、`ensureGif`、`enqueue`、`acquire` / `acquireUser` / `release` / `laneChains`、`fillCardControls`、`isolatedCardProject`、`playbackUrl` / `hashFromUrl`、`serializeProc` / `writeProcToDisk`、`frameLayoutOf` / `contentLayoutOf` / `measureContentBoxes`、`MIRRORED_TOOLS`、`proxyToPrerender`。

标「新」（当前不存在、由本任务创建）：`server/vite-plugin-docservice.ts`、`src/render/snapshotSource.ts`（R6 建）、`src/render/streamPlayer.ts`（R8 建）、`src/render/VideoTrack.tsx`（R3 建）、`docs/agent-deploy.md`。

## 与 pinned 冲突 / 内部矛盾

1. **源文本第 5 步的上传顺序与 pinned 架构 1（2026-09-22 版）冲突** —— 源文本写「所有素材的小版先传、原片后传」，pinned 现在是「逐个素材，同一素材先小版后原片，两份都传完才下一个」。**按 pinned 改了**，写在 A1「上传队列的顺序」。
2. **源文本 L277（canvas 卡在浏览器模式下不按拍换快照、活渲）与 pinned 渲染 7 + pinned 平台一节冲突** —— pinned 渲染 7 说重卡播放和拖动只贴死素材、缺就透明。**按 pinned / 3.7 改了**（L4），并在正文括注了原因。
3. **`snapshot-store.mjs:61` 的 `snapshotTier` 对 `unknown` 回 `'none'`，与「`unknown` 按 `belowDependent` 处理」矛盾** —— 代码还没跟上。已在 A3a 明写要改成 `'local'`，并注明这一改属于 R4 / R6 的范围，不在本文的步骤里。
4. **`/api/cards/layout` 在源文本 I4(c) 里被列进「用户的路」，与 D4 / I4(b2) 末句「只服务 Agent 的 `get_layout`」自相矛盾** —— 按 r75-08 非阻塞 8 + r75-09 第 3 条挪到「Agent 的路」。
5. **A3b 的块上传（第 5 步）用不到清单（第 6 步）** —— 顺序倒置带来的新缝。正文写明第 5 步只能自造键列表自验，跨机复用要等第 6 步；列进「需要定的问题」第 1 条。
6. **`uploaded` 字段在 `src/kernel/project.ts` 里根本还没有**（只有 `tiers`），r75-07 第 1 条说的「把 `uploaded: boolean` 改成……」是改**任务书**里的写法，不是改代码。正文按新形状写，并把「存盘带不带它」列进问题第 3 条。

## 提交

见 git log。
