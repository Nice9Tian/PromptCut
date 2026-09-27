# AGENT 报告：c65-kernel

分支 `claude/c65-kernel`（基于 `claude/c65` 的 `3134428`），worktree `.worktrees/c65-kernel`。依据 `docs/plan/c65-design.md` 第 2、4、6、8 节与第 11 节 V1/V2/V5/V6/V7/V8。

状态：做完、基线与 G0-R 全绿，等主会话审查与集成。没有推送、没有合并。中途按主会话裁定把 `applyOps` 与 `c65-docservice` 的服务端引擎逐条对齐（第 4 节）。

## 1. 做了什么

| 文件 | 改动 |
|---|---|
| `src/kernel/diffProject.ts`（新） | 纯函数、确定性。`diffProject(prev, next, {limit?}) → { ops, inverse }`；`applyOps(doc, ops) → {ok, value} \| {ok:false, code:'bad-path', index, detail}`（写时复制、整批原子、先整批查格式再应用）；`getAt`、`entityOfPath` / `entityOfOp` / `entitiesOf` / `entitiesOverlap`、`deepEqual`、`isIdArray`、路径编码。差异：对象逐键递归；两边都是带 id 的数组时先删、再按最长保序子序列只挪不在序列里的元素（每个至多一次 `move`）、插新的，再逐个递归；其余结构不等就整个 `set`；超过 500 条退化成根替换 |
| `docs/plan/c65-ops-spec.md`（新） | 两边共同依据的一页规范：路径、四种操作的格式与「走不通」条件（失败码一律 `bad-path`）、键的顺序、差异与逆操作、实体口径、对文档服务的协议补充、与服务端引擎的逐条对照表 |
| `src/store/docsync.ts`（新） | `DocSync` 类：传输可注入（`send` 进、`receive` 出、`connect` / `disconnect`）；乐观落地 + 按序提交 `project.op`（带 `opId`、`session`、`undoOf?`、离线首条带 `expectRev`）；收 `project.state`（含分片 `project.state.part/end`）、`project.op.ok`、`project.op.rejected`、`project.ops`（含 `resync`）、`project.overwritten`；已确认副本 + 重放未确认操作；离线队列与「重放 / 丢弃」；覆盖与丢弃前的本地备份（`saveBackup` 注入）；按页面会话的撤销 / 重做栈；`whenSettled()`。另有 `bindStore(ds)` 把它接到 store 上 |
| `src/store/core.ts` | 新增 `SetProjectOptions { undoable?, mergeKey? }`、`ProjectSyncHooks`、`attachProjectSync` / `getProjectSync`。`setProject` 在装了挂钩时交给 docsync，没装时照旧；快照栈模式也支持 `mergeKey`（同 key、300 ms 内、中间没有别的修改才合并；不传就与以前逐字一样） |
| `src/store/actions/coreActions.ts` | **越出任务书文件清单的一处**（见第 6 节）：`undo` / `redo` / `loadProject` 装了挂钩时交给 docsync；新增 `canUndo()` / `canRedo()`。没装挂钩时行为不变 |
| `src/kernel/diffProject.test.mjs`（新） | V1-*（7 条）、规范-*（11 条）、V8-*（2 条） |
| `src/store/docsync.test.mjs`（新） | V2-*（8 个种子 + 2 条）、V5-*（8 条）、覆盖通知、V6-*（5 条）、V7-*（3 条）、V8-*、协议-*（3 条）、根替换建项目、被拒撤回 |
| `src/store/docsyncStore.test.mjs`（新） | 接 store 的集成：快照栈照旧、快照栈的 `mergeKey`（V5）、连上后 actions 的撤销与远端改动、`loadProject` 是根替换、解绑后回到快照栈 |
| `src/testing/randomProject.mjs`、`src/testing/memDocService.mjs`（新，仅测试） | 可复现的随机项目 / 随机修改 / 像 action 那样的修改；内存文档服务假件（上下行分队列、随机交错投递、按 `opId` 幂等、`expectRev`、`since`、覆盖通知） |

现有测试一条没改。

## 2. 验证（原始关键行）

- `npx tsc -b --force` → 退出码 0，无输出。
- `npm test`（最后一次，对齐之后）→ 退出码 0：

```
ℹ tests 2654
ℹ pass 2653
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```

  唯一的跳过是既有的 `集成:/api/cards/layout 对真实项目返回整数框 # SKIP`（要 5190）。本分支新增 57 条，全过。

- 验收对应（用例名带编号）：

| 验收 | 用例 | 结果 |
|---|---|---|
| V1 | `V1-1000 个随机项目…` | 1000 个随机项目各做 1～12 次随机修改（换类型、删键、重复 id、改 id、整段反转…），`apply(prev, ops)` 深相等 `next`、`apply(next, inverse)` 深相等 `prev`，经 JSON 往返后也成立；四种操作各出现 > 50 次（实测 set 2582、insert 1334、remove 1147、move 193）。另有「毫不相干的两个项目」200 对、确定性（两次逐字节相同）、500 条退化根替换 |
| V2 | `V2-两个页面各 200 次随机编辑/乱改交错提交…`（种子 1～8） | 两个 DocSync + 内存假件，消息随机交错，夹着撤销 / 重做；结束后 A、B、文档服务三份 `JSON.stringify` 逐字节相同、`rev` 相同、没有未确认的；账对得上：每条发出去的提交要么落地、要么被拒并通知了页面，落地的没有重复。诊断行：`V2 种子 4:落地 A 145、B 155,被拒或重放丢弃 21,撤销 65,最终 rev 307`（被拒的是「改的片段已被对方删了」一类） |
| V5 | `V5-A 改片段 1、2,B 随后改片段 2…` 等 8 条 | 片段 1 回去、片段 2 保持 B2、`skipped = [["/tracks/@t1/clips/@c2","B"]]`；撤销带 `undoOf`、别人照常收到；全部没撤成则出栈不进重做栈；别人改过又被我撤了中间一步也照样挡住；父级被删的那处记 `failed`；300 ms 合并与栈上限 100 |
| V6 | `V6-…` 5 条 | 断线改 20 次，恢复后 20 条按序落地、只有第一条带 `expectRev`；离线期间 B 也改过：第一条 `stale`、整批停下（`status: paused`，其余 19 条没发），「重放」后日志是 `B, A×20` 且都不带 `expectRev`，「丢弃」后本地备份含 20 条与离线时的整份项目、本地回到服务端版本；在途提交已落地但丢了 ok：原 `opId` 重发被去重，不误判冲突 |
| V7 | `V7-…` 3 条 | 有未确认操作时 `whenSettled` 不 resolve，确认完 resolve 的 `rev` 等于文档服务的、内容逐字节相同；离线时超时报错 |
| V8 | `V8-…` 3 条 | 见下 |

- V8 原始行（全量 `npm test` 里并行跑时）：

```
"拖动一个片段": "median 0.039 ms, p90 0.091 ms, ops 2",
"改一个参数": "median 0.045 ms, p90 0.058 ms, ops 1",
"删一个片段": "median 0.041 ms, p90 0.060 ms, ops 1",
"加一个片段": "median 0.041 ms, p90 0.056 ms, ops 1",
"所有序列重建但片段对象不变": "median 0.419 ms, p90 0.609 ms, ops 0",
"整份深拷贝后改一处": "median 2.332 ms, p90 3.864 ms, ops 1"
V8 applyOps 拖动:median 0.008 ms
V8 docsync 提交(1000 片段):median 0.062 ms;经内存假件到 B:median 0.096 ms
```

  1000 片段、10 条序列。「整份深拷贝」是最坏情况（没有共享结构，要逐键比完全部），第一版全量并行时中位数到过 6.51 ms、断言失败一次；改为「相同的键不拼路径」后单跑 3.4 → 2.0 ms，并改成跑三批取中位数最小的那批（全量测试是几十个进程并行，CPU 被抢时单批偏慢），之后全量两次都过。「拖动松手到另一页面看到 ≤ 300 ms」要真文档服务与真连接，本分支只测到内存假件（0.1 ms），端到端留给集成。

- **G0-R**（改了 store）。端口：本分支 dev server 5500（舞台 5501、5502），main 基线 5503（舞台 5504、5505），都以 `PROMPTCUT_PUSH=0` 起。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5500/?export=1"` | `Total Frames: 1800 / Identical: 1800 / Different: 0`，`All frames are identical. Determinism verified!`，退出码 0 |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5500 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5500` | `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`，退出码 0 |
| 导出像素与 main | 临时 `git worktree add --detach .worktrees/c65k-main-baseline main`（`b84fee5`），5503 跑同一条 `verify-determinism`（main 也是 1800/1800），pngjs 逐帧逐像素比两边 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |

  `verify-determinism`（以及拿它的输出与 main 比像素）跑在 `aa983da`（core.ts 与 coreActions.ts 的挂钩已在）；`verify-unified-frames` 跑在对齐提交 `8239e4d` 之后。`8239e4d` 只改 `diffProject.ts`、`docsync.ts` 与测试、规范页，这两个模块运行时没有任何引用方（`grep` 过，只有测试引用），所以 `verify-determinism` 没有重跑；全量测试与类型检查是对齐之后重跑的。

- 收尾：基线 worktree 删之前两个 worktree 都查过，没有 reparse point（junction），已 `git worktree remove --force`。我起的两棵 vite 进程树（5500、5503）已结束。5508 上有一个 `chrome-headless-shell` 在监听，它的父进程是别的 worktree（`m6c-integ`）的预渲染进程（祖先是 5410 的 dev server），不是我起的，没有动。没碰 5190～5192。

## 3. 与设计稿不一致之处、我定的细节（设计稿有歧义时按最合理的做）

1. **「撤回 - 应用远端 - 重放」不靠逆操作撤回**：页面同时留一份「已确认副本」，收到远端操作就应用到它上面，再把未确认的本地操作在上面重放得到本地副本。结果与文档服务里的顺序（先远端、后本地）逐字节一致，比逐条应用逆操作再重放更稳（逆操作恢复的是深相等，不保证键的顺序）。
2. **本地存 `applyOps(prev, ops)` 的结果，不存 `next` 本身**：`set` 新键追加在末尾，所以本地副本的键顺序可能与 action 造出来的 `next` 不同（内容相同），这样三份才能逐字节相同。只在连上文档服务时如此，没连时 store 照旧存 `next`。
3. **提交前后的顺序依据**：页面认定「`ok` 之前在同一连接上收到的 `project.ops` 都排在自己这次提交之前」。服务端已按此实现（报告第 4 节「处理顺序」）。
4. **已发出但重放失败的提交**不当场丢：文档服务那边也会拒，等 `rejected` 再撤；没发出的当场丢并发 `replay-dropped` 通知。`ok` 了却在本地落不下去（两边引擎不一致）就重新 `project.open`。
5. **被拒的提交**：从本地撤回，并把含它的撤销步整步拿掉（逆操作已对不上）。
6. **离线批次被拒暂停期间**：本地副本保持离线时的样子，远端改动只进已确认副本；「重放」时再在最新的已确认副本上重放。暂停期间新的本地修改照样进这一批。
7. **断线时在途的提交**当成没发，重连后用原 `opId` 重发（靠服务端按 `opId` 幂等）；重连后是离线批次的流程（首条带 `offlineRev`）。收到的 `ok.rev` 不大于已确认版本时，说明它早已含在快照里，直接去掉、不再应用。
8. **撤销的冲突判据**：一步的 `rev` 取它第一条提交落地的版本；之后收到的远端写入（按页面口径算实体）只要实体重叠就挡。还没确认的一步不会被挡（之后收到的远端改动都排在它前面）。别人的根替换记 `*`，会挡住自己之前每一步的撤销（偏保守；服务端按实际差别算实体，页面拿不到，见第 5 节建议）。
9. **部分撤销**：先把没被挡的逆操作整批试一次；落不下去再按实体分组逐组试，落不下去的组记 `failed`。落地的那部分以 `diffProject(当前, 撤后)` 作为这次提交，它的逆操作就是重做步。一处都没撤成：出栈、不进重做栈（按第 8 节裁定），`failed` 同样算没撤成。
10. **合并步的 `undoOf`**：数字框合并的一步含多次提交，撤销时 `undoOf` 取其中最后一次的 `opId`。
11. **`load()`**（打开 `.proc`）：一次根替换，不进撤销栈，清空撤销与重做栈；换另一个项目（不同 `projectId`）应先解绑、为新项目另建 `DocSync`。
12. **文档服务还没有这个项目**（`project: null`）：用根替换把本地这一份（连同之前未确认的修改）写进去。
13. **`/meta` 粒度**：按设计稿，`name`、`fps` 等顶层字段同归 `/meta` 一个实体。后果是「别人改了 fps，我撤不回自己改的 name」（有用例钉住）。是否把顶层标量逐字段当实体，请主会话定（改的话两边的实体口径要一起改）。
14. **覆盖备份**：收到 `project.overwritten` 时，取「应用该版本之前的本地副本」里的那个实体存备份（服务端让 `overwritten` 先于那一版的 `ops` 到，页面也兼容反过来的顺序）。落盘由注入的 `saveBackup` 做。

## 4. 与服务端引擎逐条对照（主会话裁定后）

对照对象：`claude/c65-docservice` `7389b70` 的 `server/docservice/json-ops.mjs`（报告第 3 节）。按裁定改了页面一侧：

| 条目 | 改前 | 改后（与服务端一致） |
|---|---|---|
| `remove` 目标不在 | `bad-path` | 空操作、照常落地；父级不在或不是容器仍 `bad-path` |
| `move` 元素不在 | `bad-path` | 空操作；所在数组不在或不是数组 `bad-path` |
| 根缺失时 `set` | 不支持 | 从 `{}` 建起；其余操作 `bad-path` |
| 空 `id`、单独 `@` 的段、`~` 后非 `0/1` | 放行 | 不合法 |
| `index` | 非负整数 | 非负安全整数 |
| 失败下标 | 逐条应用时遇到的第一条 | 先整批查格式，格式错先报；与服务端相同 |
| `set` / `insert` 父级不在、`insert` 越界、`move` 越界 | —— | 本来就一致（`bad-path` / 插到末尾 / 挪到末尾，index 指挪完后的位置） |
| 根替换 | —— | 页面照常整体替换；「哪些实体变了」由服务端统计，页面只在撤销冲突里按 `*` 用 |

差分模糊测试（脚本在本会话 scratchpad，不入库：同一份文档、同一串操作分别交给两边，比「都成 / 都败」、成了是否逐字节相同、败了下标是否相同；操作来源含手写非法操作、页面 diff 出的正操作应用到被并发改过的另一份上、逆操作）：

| 种子 | 用例 | 都成且逐字节相同 | 都败且下标相同 | 不一致 |
|---|---|---|---|---|
| 1 | 50003 | 41613 | 8390 | 0 |
| 2 | 50003 | 41581 | 8422 | 0 |
| 3 | 50003 | 41485 | 8518 | 0 |

同时补了：`project.state` 分片（`parts` + `project.state.part` / `end`，拼完前到的 `rev` 大于快照的 `project.ops` 先攒着）、`project.ops` 带 `resync: true` 时重新 `open`、`actor.session` 作为写入身份、`ok.duplicate`（按 `rev` 不大于已确认版本处理）。用例 `协议-…` 3 条，含「两人同时删同一片段：后到的连同同批的其它修改照常落地」。

## 5. 接口说明

### 给文档服务侧（`c65-docservice`）

页面发的消息：`project.open { projectId }`；`project.op { projectId, opId, session, ops, expectRev?, undoOf? }`。页面依赖的服务端行为（都已在服务端实现，列出以便回归时别动）：

- 按 `opId` 幂等且先于 `expectRev` 检查（断线重发靠它）；
- 同一连接上 `ok` 与 `project.ops` 按 `rev` 有序，`ok` 之前的 `ops` 都排在这次提交之前；
- `project.ops` 的 `actor.session`（或顶层 `session`）标出写入身份；
- `project.state.project` 为 `null` 表示还没有真身。

需要主会话定的：
- **大的根替换**：页面的 `load()` 与建项目的根替换可能超过 256 KiB。服务端补了 `project.upload` + `upload` 引用，页面这边**还没接**（不在设计稿里，服务端报告说可删可换）。定下来后在 `DocSync.sendOp` 里按大小分流即可。
- 页面撤销冲突用的是页面口径的实体（根替换记 `*`）。如果想让它与服务端一样按实际差别，`project.ops` 可以带上服务端算好的 `entities`（`since` 里已有），页面优先用它。

### 给编辑界面侧（`c65-editor`）与接线方

```ts
const ds = new DocSync(getState().project, {
  projectId, session,                 // session:这个页面会话的 id
  send: (msg) => socket.send(JSON.stringify(msg)),
  saveBackup: (b) => writeBackup(b),  // 写草稿目录下 backups/;b.kind 是 "overwritten" 或 "offline-discard"
});
socket.onmessage = (e) => ds.receive(JSON.parse(e.data));
socket.onopen = () => ds.connect();  socket.onclose = () => ds.disconnect();
const unbind = bindStore(ds);        // 之后 setProject / loadProject / undo / redo / canUndo / canRedo 都走 ds
```

- `actions.undo()` / `redo()` 接口不变；新增 `actions.canUndo()` / `canRedo()`（两种模式都能用），按钮置灰用它。部分没撤的结果从 `ds.on("notice")` 的 `{ kind: "undo", redo, result: { done, skipped: [{entity, by}], failed, opId } }` 拿，做第 8 节的提示条。
- 数字框：action 调 `setProject(next, { mergeKey: "<字段标识>" })` 就会 300 ms 内合并成一步（两种模式都支持）。现有 action 都没传，所以现在每次输入仍是一步；要哪些字段合并由编辑界面侧在 action 上加。
- 状态：`ds.status` 是 `idle / connecting / online / offline / paused`，`ds.on("status")` 订阅；`paused` 时顶栏显示「同步已暂停」，`ds.pausedInfo` 给 `{ offlineRev, currentRev, since, queued }`，两个按钮调 `ds.replayOffline()` / `ds.discardOffline()`。
- 别人改动的高亮：`ds.on("project", (p, cause))` 里 `cause === "remote"` 的是别人的改动；要知道改了哪些片段，可从 `notice` 以外再加一个事件，目前没做（需要时在 `onOps` 里发 `entitiesOf(msg.ops)`）。
- `.proc` 保存：先 `await ds.whenSettled({ timeoutMs })`，用它返回的 `{ rev, project }` 写文件；超时 reject，提示用户。`src/editor/io/proc.ts` 本分支没改（不在清单里）。
- 覆盖提示：`notice` 的 `{ kind: "overwritten", entity, by, rev }`；覆盖方的 `{ kind: "overwrote", entities }`。
- AI 栏「撤销这一步」（撤 Agent 的某次提交、进用户自己的栈）本分支没做：需要页面拿到那次提交的逆操作，而 Agent 的提交不在页面的栈上。建议由 `c65-agent` 在 `events.complete` 里带上逆操作（或内容库里存一份），页面拿到后调一个 `ds.revertRemote({ opId, inverse })`（待加，内部复用 `revert` 的冲突检查，`undoOf` 指向那次提交）。

## 6. 越界与没做的

- **越出文件清单**：`src/store/actions/coreActions.ts`（`undo` / `redo` / `loadProject` 转给挂钩、加 `canUndo` / `canRedo`，共 19 行）。任务第 3 条要求两种模式对 actions 的接口一致，`undo` / `redo` 就在这个文件里，不改做不到。新增的 `src/testing/randomProject.mjs`、`memDocService.mjs` 只给测试用。
- **没做**：真连接接线（传输是注入的，由后续分支接）；`backups/` 落盘与「本地备份…」菜单（`saveBackup` 已给出数据）；`proc.ts` 改用 `whenSettled`；大的根替换上传；AI 栏撤销这一步（见上）；别人改动的 1.5 s 高亮。

## 7. 对任务书或设计稿的更正建议

1. 设计稿第 4 节「撤回 - 应用远端 - 重放」建议改写为「从已确认副本重放」（第 3 节第 1 条的理由）。
2. `/meta` 一个实体会让不相干的项目设置互相挡撤销（第 3 节第 13 条），建议定下来。
3. 设计稿第 3 节「`bad-path`：路径指向不存在的父级，且不是 `set`」与本次裁定不完全一致（`insert` 的父级不在也是 `bad-path`，`remove` / `move` 目标不在是空操作）；规范页已写明，设计稿可以引用规范页。
