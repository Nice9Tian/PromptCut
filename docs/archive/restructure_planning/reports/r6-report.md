# R6 数据面 实施报告

分支：`worktree-agent-afe06c102a1506c38`
worktree：`C:\Users\admin\Documents\PromptCut\.claude\worktrees\agent-afe06c102a1506c38`
起点：`git merge --ff-only main` 成功，落在 `6876dd7`。

## 提交（6 条，main..HEAD）

| 提交 | 内容 |
|---|---|
| `d5b62ea` | unknown 卡进本地档、快照体积上限兜底、就绪索引与 C4 选帧纯函数 |
| `2b48d03` | 锚帧优先、wanted 四处、就绪索引 SSE、探针帧入库、interactive / streamPool |
| `b79ee86` | J3 快照来源接口（页面侧）+ wanted 与批次调度的单测 |
| `3f3f6c0` | 端到端探针 ready-index-probe + 四张固定卡 + 诊断读口 |
| `66402dc` | 预渲染进程的 vite bin 按模块解析；探针每次从冷缓存跑 |
| `2c91eef` | 批次插队的诊断记录配单测 |

## 改了哪些文件

**新建**
- `server/ready-index.mjs` — C3 就绪索引（层表、三种消息、F5 的 stage/claim）
- `server/prerender-set.mjs` — `prerenderSetOf` 窄接口（TODO(R4a)）
- `src/render/snapshotPick.mjs` + `.d.mts` — C4 选帧纯函数（浏览器和 Node 共用）
- `src/render/snapshotSource.ts` — J3 快照来源接口 + `HttpSnapshotSource`
- `src/cards/_probe/r6.tsx` — 探针用的四张固定卡
- `scripts/probes/ready-index-probe.mjs` — 端到端探针
- 单测：`server/test/ready-index.test.mjs`、`server/test/playhead-wanted.test.mjs`、
  `server/test/prerender-schedule.test.mjs`、`src/render/snapshotPick.test.mjs`、
  `src/render/snapshotSource.test.mjs`

**改动**
- `server/snapshot-store.mjs` — `snapshotTier` 的 `unknown`；A3c 上限与诊断
- `server/frame-pipeline.mjs` — 锚帧优先、`renderLocalSnapshots`、帧集合收窄、
  HTML 完整性判据、`wanted` 批次调度、`readyIndex` 发布、F5 扫盘、`interactive` / `streamPool`
- `server/mirror-store.mjs` — `setPlayhead` 的 `wanted` 白名单
- `server/vite-plugin-mirror.ts` — `setPlayhead` 调用与转发体
- `server/vite-plugin-frames.ts` — SSE / 快照 GET / 探针 PUT / 诊断 GET；`frameService` 注入
- `server/vite-plugin-prerender.ts` — vite bin 按模块解析
- `src/render/dataMirror.ts` — `pushWanted`
- `src/cards/capabilities.json` — 三张固定卡的审阅条目
- `src/cards/_probe/index.ts` — 注册四张固定卡
- `server/test/snapshot-store.test.mjs` — 跟着 `unknown` 改口 + A3c 用例

**没碰**：R2 的 `StageView.tsx` / `stageRpc.ts` / `stageBridge.ts` / `Preview.tsx` /
`vite.config.ts` / `src/mcp/common.ts`；R4a 的 `pipelinePlan.mjs` / `pipelineTuning.mjs` /
`costs-store.mjs` / `vite-plugin-costs.ts` / `probe-card-costs.mjs` / `cardCostKey.d.mts`。
**`vite.config.ts` 一行都没改**（CORS 已由 `vite.prerender.config.ts` 的 `corsForEditor`
对所有路径统一放行，SSE 是 GET，够用）。

## 新端点与消息形状（最终定义）

### `GET /api/frames/ready?session=&localRev=`（SSE，预渲染进程，页面直连）
连上先发 `reset` + 每层一条全量 `layer`（已 `done` 再补一条 `done`），之后增量。
每 15 秒一行 `: beat` 注释防代理掐连接。三种消息：

```
{ type: 'reset', localRev }
{ type: 'layer', clipId, kind: 'html' | 'local' | 'stream', key, ranges: [[from, to], …], groupClipIds?: string[] }
{ type: 'done', localRev }
```

`layer` **每次发全量、不发增量**。`key`：共享档 = 共享键；本地档 = `<entry.key>/<共享键>`
（自带一个斜杠）。`stream` 只占位，R8 才产。

### `GET /api/frames/snapshot/<kind>/<key>/<localFrame>`
`text/html; charset=utf-8` + `Cache-Control: public, max-age=31536000, immutable`。
`kind=local` 时路径是 `/snapshot/local/<entryKey>/<sharedKey>/<n>`（两个键段）。
缺帧 404。

### `PUT /api/frames/snapshot`
体 `{ session, localRev, clipId, localFrame, html }`。编辑器进程只转发；预渲染进程按
镜像里的项目用 card plan 反查 `kind` / `key`，**只存审阅表 `independent` 的卡**。
回包：`{ ok, stored, indexed, count }` / `{ ok:false, code:'PLAN_PENDING' }`（202）/
`{ ok:false, code:'MIRROR_MISSING' }`（409）/ `{ ok:true, stored:false, reason:'NOT_INDEPENDENT' }` /
`{ ok:true, stored:true, indexed:false, reason:'OVER_LIMIT' }`。

### `POST /api/data/playhead` 体加可选 `wanted`
`wanted: Array<{ clipId, frame }>`，最多 8 条（`MAX_WANTED`），坏条目丢掉，
只带 `wanted` 的那一趟不冲掉上一次的 `t` / `playing`，也不抹掉上一次的提示。

### `GET /api/frames/diagnostics`（新增，探针用）
`{ ok, oversize: [{ clipId, key, localFrame, bytes, limit, at }], promotions: [{ clipId, start, instead, frame, at }] }`。
**加它的理由**：预渲染进程的 stdout 被编辑器进程的 `keep()` 收走了，任务书要求的
「预渲染日志里对应片段的批被提前」在进程外看不见。

## `prerenderSetOf` 临时接口

`server/prerender-set.mjs`：
- `prerenderSetOf(project, costs, fps, capabilitiesOf) -> Set<clipId>`
- `prerenderSetOfPlan(plan) -> Set<clipId>`（预渲染进程手里有 card plan，走这条）
- `declaredHeavy(capabilities)` — 兜底口径：`direct` 不产，其余（含 `unknown`）都产

标了 `TODO(R4a)`。消费点：`FramePipeline.adoptCardPlan` 把结果记在 `entry.prerenderSet`。
合并 R4a 时把函数体换成 `planPipelines(project, costs, fps).prerenderSet`，调用点不用动。

## 验收

| 项 | 结果 |
|---|---|
| `npx tsc -b --force` | **零错误** |
| `npm test` | **1506 / 1505 通过 / 0 失败 / 1 跳过**（main 基线 1481 / 1480 / 0 / 1；新增 25 条） |
| `scripts/probes/ready-index-probe.mjs` | **8 条全过，`fails: []`**（详见下表） |
| `scripts/probes/editor-preview-smoke.mjs` | **过**（`fails: []`、`errors: []`，`play.t=1.467`、帧 44/44） |
| `scripts/verify-unified-frames.mjs` | **失败，但在 `6876dd7` 上同样失败**（见「没做成」） |

### 端到端探针（冷缓存跑，编辑器 5231）

| 条目 | 实测 |
|---|---|
| ① SSE 第一条是 `reset` | `{"type":"reset","localRev":0}` |
| ① 锚帧先于其他帧 | 锚帧 `[0, 29]`；`done` 时三层的区间都只有 `[[0,0],[29,29]]` |
| ② 区间随生产增长 | `clip-stateful/html` 长到 `[[0,0],[29,29],[52,55]]`，多条 `layer` |
| ③ HTTP 取到的 HTML 与磁盘逐字节相同 | `sameBytes: true`（14382 字节，`immutable`） |
| ④ C4 冷缓存回到区间起点 | 目标第 45 帧 → 段起点 29 → 选中 **29** |
| ⑤ 超限帧落盘但不进索引 | `clip-huge` 1 438 949 字节 > 307 200；盘上有；`clip-huge/html` 层 **不存在** |
| ⑥ `unknown` 卡在 `local` 表 | 层集合 `['clip-canvas/html','clip-stateful/html','clip-unknown/local']` |
| ⑦ 杀进程后按键重建、项目到位才发 `layer` | 重连首条 `reset`；2 秒内 `layer` 条数 **0**；preload 后三层全部重建 |
| ⑧ `wanted` 让批提前 | `{clipId:'clip-stateful', start:52, instead:0, frame:52}` |

### 端口
- 编辑器进程：**5231**（`--strictPort`）。
- 预渲染进程：**落不到 5231～5239**。`server/vite-plugin-prerender.ts` 的 `freePort()`
  用 `listen(0)` 要一个 OS 分配的临时端口，三次跑分别是 8639 / 11744、5853 / 4251、4977。
  这是现有代码的派生方式，没有为探针去改它。探针从 `/api/prerender/info` 读地址，
  不依赖端口号。
- 用完全部关掉：5231～5239 上已无监听进程；临时产物目录已删。

## 逐条对照（任务书原句 → 怎么做的 → 为什么）

1. **「`onSnapshot` / `snapshotFrames` 已落地，你只把帧集合从 `new Set(localFrames)`
   收窄成「本卡缺的那些帧」」** → `fillCardControls` 里
   `snapshotFrames: new Set(localFrames.filter(n => !rangeHas(index.frames, n)))`，
   `targetFrames` 不动（PNG 那一支仍要全部帧）。
2. **「完整性判据 = `index.count === control.count`」** → 循环前读一次 `snapshotIndex`，
   `htmlComplete = index.count === control.count`，和 `cardCache.hasComplete(control)`
   **两个都成立才 `continue`**。原来那句 `if (await hasComplete) continue;` 只看 PNG，
   照抄会让「PNG 齐了、快照缺一段」的键永远补不上。
3. **「`renderLocalSnapshots` 保持 `snapshotOnly: false` + `fullFrame: true`」** →
   逐字照做，`writeFrames: false`、`snapshotFrames: new Set(frames)`、
   `onSnapshot` 从 `controls` 里按 `control.clipId` ↔ `control.snapshotKey` 反查键。
   每帧多截一张丢弃的 PNG 保留为已知代价。
4. **「`snapshotTier` 对 `unknown` 的 stateful 卡改成 `'local'`」** → 删掉
   `if (compositing === 'unknown') return 'none';` 一行，落到末尾的 `return 'local'`。
   配了单测；原单测那条 `unknown → none` 改口，另补一条 `direct → none` 顶替
   「什么时候才不产快照」的覆盖。
5. **「任何一帧快照超过上限……不进就绪索引、不投递，记一条诊断」** →
   `snapshot-store.mjs` 加 `snapshotLimit` / `overSnapshotLimit` / `noteSnapshotSize`，
   三条产快照的路（`fillCardControls`、`recordSnapshots`、`PUT /api/frames/snapshot`）
   都先落盘、再按它决定进不进 `index.json` 和 `layer`。canvas 档按审阅表的
   `canvasHeavy` 取 1 MB。**这里做了一处解释**：任务书说「canvas 位图 1 MB」，
   但落盘的是整份 HTML、位图在里面，没有单独的位图字节；所以对 `canvasHeavy` 的卡
   把**整帧上限**取成 1 MB（它 84%～95% 是位图，量级一致），而不是去解析 data URI。
6. **「`wanted` 要改四处」** → 四处都改了：`mirror-store.setPlayhead` 第四参 +
   白名单；`vite-plugin-mirror` 的调用与转发体；`dataMirror` 新开 `pushWanted`
   （100 ms 固定节流、`keepalive: true`、不读响应），**原有播放头路径一行没动**。
   服务端消费在 `fillCardControls` 的 4 帧批边界（`nextBatchStart`）。
7. **「谁来算 `wanted` 是 R5 的事，你只提供发送口子」** → 只导出
   `pushWanted(wanted)` 和 `resetWantedThrottle()`，没有任何调用方。
8. **「C4 的回溯选帧做成纯函数」** → `src/render/snapshotPick.mjs`（`.d.mts` 配齐），
   `anchorFrames` / `segmentStartOf` / `latestReadyAtOrBefore` / `pickSnapshotFrame` /
   `localWindowOf` / `pickLayerSnapshot`。锚帧集合照 C1 末句的三项算。
   浏览器（`snapshotSource.ts` 的类型来自它）和 Node（`frame-pipeline`、探针）共用。
9. **「33 ms 投递节流和投递基线是父页消费方的事（R5），你不做」** → 没做，
   接口做成两个无状态动词 + 一个订阅，消费方自己排程。
10. **「`FramePipeline` 的 `interactive` 参数与 `streamPool`……R6 只加参数和代码路径，
    默认值保持今天的行为」** → `interactive` 缺省 `true`，`frameService` 两个进程都传
    `true`；`interactive === false` 时 `prewarmUser` 空转、`readFrames` 对
    `user` / `playback` 立即抛 `USE_PRERENDER`。`streamPool` / `streamPoolSize` 是
    `userPool` / `userPoolSize` 的访问器；`leaseStreamBakery` / `returnStreamBakery`
    只在注释里留位。**播放热池的借还和 `stopPlayback()` 一行没动。**
11. **「`?preview=legacy` 的服务端含义……服务端不另读开关」** → 没有加任何开关读取，
    `user` / `playback` lane 旧路径原样保留。
12. **「K1 里『探针推过的帧直接存成死素材』那一条也归你」** → `PUT /api/frames/snapshot`
    做了服务端半边（转发 + 算键 + 只存 `independent` + 进索引 + 超限不进）。
    **页面半边（后台舞台第一趟 post `probe-frame`）不在我范围**，那是 R4 的探针。
13. **「F5 重启恢复」** → `rescanSnapshots()` 在 `frameService` 建实例时跑一次，只
    `stageByKey`；`adoptCardPlan()` 在 card plan 算出来时 `claim()`，认领成功才
    `reset` + 全量 `layer`。探针实测「项目到位之前 `layer` 条数 = 0」。

## 对任务书的更正建议

1. **A3c 的「canvas 位图 ≤ 1 MB」在服务端没有可量的对象。** 落盘的是整份 HTML，
   位图是里面的 `data:image`。建议把这一档明确写成「`canvasHeavy` 的卡整帧上限
   1 MB」（本实现的做法），或者明确要求解析 data URI 单独量——后者在热路径上不划算。
2. **C2 的「完整性判据 = `index.count === control.count`」要和 PNG 的 `hasComplete`
   取并**，任务书只说「另建 HTML 侧的完整性判据」，没说两者的关系。按「都完整才跳过」
   实现，否则快照缺段时永远补不上。
3. **C3 的 `key` 在本地档是 `<entry.key>/<共享键>`，但 `layer` 的 `ranges` 是
   「该层的本地帧」**——任务书没有明写重启扫盘得到的键要按同一形状拼，
   实现里把这一处收口到 `ready-index.mjs` 的 `wireSnapshotKey`（唯一一处）。
4. **「预渲染日志里对应片段的批被提前」在进程外看不见。** 预渲染进程的 stdout 被
   `vite-plugin-prerender.ts` 的 `keep()` 收进内存 tail，不外发。建议把验收改成
   读 `GET /api/frames/diagnostics`（本实现新增），或者让 `vite-plugin-prerender`
   把子进程输出转发到自己的 stdout。
5. **预渲染进程的端口不可能落在 5231～5239。** `freePort()` 是 `listen(0)`，拿的是
   OS 临时端口段。要固定范围得改 `freePort()` 接受一个候选区间。
6. **`scripts/verify-unified-frames.mjs` 在 `6876dd7` 上就不过**（见下），
   「每一步通用的收尾」里这一条目前是红的，不是 R6 引入的。

## 没做成 / 留给后续

1. **`scripts/verify-unified-frames.mjs` 失败：`'mov' !== 'rendered'`（第 46 行）。**
   我把 `server` / `scripts` / `src` 整体 `git checkout 6876dd7 --` 之后重跑，**同样失败、
   同一行、同一个值**，所以不是 R6 引入的。没有去修它（超出本步范围）。
   （另：这条脚本要求 `/@media/<文件名>` 和它写的 `out/media` 同一个根，所以跑它时
   不能设 `PROMPTCUT_EXPORT_DIR`。）
2. **`PUT /api/frames/snapshot` 在 card plan 还没算出来时回 202 `PLAN_PENDING`、不存帧。**
   card plan 要浏览器的 `__pcCardPlan`，预渲染进程在第一次 `preload` / `see_frames`
   之前拿不到。探针帧那时丢掉的代价只是「这一帧由预渲染自己再产一次」。
   要更好，得让预渲染进程能在 Node 侧独立算 plan（A3a 说键本身算得出来，
   但 `environment` / `sourceVersions` 仍来自浏览器）。
3. **`kind: 'stream'` 只留了位**（类型、`READY_KINDS`、`groupClipIds` 字段、
   `setStreamPlanes` 的合成规则写在注释里），R8 才产。
4. **`prerenderSetOf` 是按声明的兜底实现**，接 R4a 的 `planPipelines` 之前，
   分派仍等价于今天（`frameMode === 'stateful'` 就产）。
5. **`IdbSnapshotSource`（在线浏览器模式，L2）没做**——J3 只要求接口 + `HttpSnapshotSource`。
6. **worktree 里留下两个 gitignore 的缓存目录**：`node_modules/`（只有 vite 的
   `.vite` 预构建缓存，29 MB，vite 自己建的，不是安装）和 `out/`（5.7 MB，
   早期几次探针跑的产物）。都可以直接删，删了下一次跑慢一点。
7. **`server/vite-plugin-prerender.ts` 的 vite bin 解析是我加的**（`66402dc`）。
   动机是这个工作副本没有自己的 `node_modules`，写死路径会让预渲染进程起不来；
   顺带也修了 pnpm 非提升布局。如果不希望这条进 R6，可以在合并时单独摘出来。
