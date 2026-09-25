# AGENT 报告：c65-integ（C6.5 第一批集成对账）

分支 `claude/c65-integ`（起点 `claude/c65` 的 `3134428`），worktree `.worktrees/c65-integ`。依据 `docs/plan/c65-design.md`，以及三份分支报告 `AGENT-c65-docservice.md`、`AGENT-c65-kernel.md`、`AGENT-c65-tests.md` 和 `c65-ops-spec.md`。

状态：合并、裁定落实、测试对账、验证都做完了，基线与 G0-R 全绿。没有推送，没有合并到别处。

## 1. 合并

依次 `--no-ff` 合并，三次都**没有冲突**：三个分支改的文件互不相交（docservice 只改 `server/docservice/` 与自己新增的测试，kernel 只改 `src/kernel/`、`src/store/`、`src/testing/` 与规范页，tests 只新增 `server/test/c65-*`）。

| 提交 | 内容 |
|---|---|
| `d233bb0` | 合并 `claude/c65-docservice`（`7389b70`） |
| `d711046` | 合并 `claude/c65-kernel`（`0a31bd8`）；`coreActions.ts` 越界按裁定接受 |
| `d792d1e` | 合并 `claude/c65-tests`（`ad53117`） |
| `e8e548c` | 胶水 A1 |
| `2b13189` | 胶水 A7 |
| `f74bb87` | 实体粒度改为顶层字段各一个，页面与服务端一起改 |
| `634554d` | 设计稿第 13 节；规范页同步 |

## 2. 裁定落实

逐条写进了 `c65-design.md` 第 13 节，格式是「裁定：理由」。`c65-ops-spec.md` 已同步：第 4 节实体口径、第 5 节协议补充、第 6 节集成对照结果，开头注明与第 13 节一致。

| 裁定 | 落实情况 |
|---|---|
| `remove` / `move` 的目标不存在 = 空操作，照常落地 | 两端合并前已这样实现（kernel 按裁定对齐过）。差分对照 0 不一致（第 5 节） |
| `set` / `insert` 的父级不存在（含找不到的 `@id`）= `bad-path`，整批拒 | 同上。第 13 节写明了我的理解：`set` 途中缺的**对象键**仍按第 2 节自动建（C65-V1-01 就断言这一点），拒的只是数组里找不到 `@id`、途中遇到标量这类没法建出来的情况 |
| `insert` / `move` 的 `index` 超过长度 = 放到末尾；`move` 的 `index` 指挪完之后的位置 | 两端已一致。C65-V1-04 断言挪完之后的位置，DS-J 与「规范-*」用例钉住越界的情况 |
| 根替换改了哪些实体由服务端统计 | 服务端按新旧值逐实体算，页面按 `*` 算，只用在自己的撤销冲突判定上。C65-V4-05 通过 |
| 实体粒度：项目顶层每个字段各算一个实体（`/meta/name`、`/meta/fps`） | **改了代码**，见下 |
| `project.state` 同时带 `rev` 与 `projectRev`，旧 P1～P7 一条不改、全过 | 服务端本来就同时带这两个字段。`git diff main -- server/test/docservice-project.test.mjs` 为空，P1～P7 都过 |
| 离线期间每次编辑各算一条提交；一处都没撤成时不产生提交 | DocSync 本来就这样做。C65-V6-01（20 条，版本号连续）与 C65-V5-02（`st.rev === revBefore`）通过 |
| 接受 docservice 新增的 `project.upload` 与 `resync`、`forbidden` = 渲染节点连接、`project.overwritten` 带 `writer`、`by` 两边都指对方 | 代码没动，写进了第 13 节和规范页第 5 节。页面侧还没接 `project.upload`（第 7 节遗留） |
| 接受 kernel 改 `src/store/actions/coreActions.ts` | 代码没动。G0-R 导出像素与 main 0 差异 |

**实体粒度改动**（`f74bb87`）：

- 服务端 `server/docservice/json-ops.mjs`：路径取不到成对前缀 `/<名>/@<id>` 时，实体是 `<metaEntity>/<顶层键>`，顶层键照样转义；`segs` 为空时是根实体 `*`。新增 `normalizeEntity`：`/meta/<键>` 只是实体名，不是那个值的路径，按路径再归一会变成 `/meta/meta`，所以 `project.follow` 收到实体名时原样认。
- 服务端 `server/docservice/modules/project.mjs`：`follow` 改用 `normalizeEntity`。覆盖通知与 `since.entities` 都走 `entitiesOf`，自动跟着变。
- 页面 `src/kernel/diffProject.ts`：`entityOfPath` 用同样的口径。新增 `entityValuePath(entity)`，把 `/meta/fps` 换回值的路径 `/fps`，`*` 换回 `""`。
- 页面 `src/store/docsync.ts`：覆盖备份取值时先过 `entityValuePath`。不改的话，覆盖 `/meta/fps` 时备份里的值会是 `undefined`。
- **我自己的延伸，请主会话确认**：顶层**非标量**字段也按顶层键各算一个（`/style/color` → `/meta/style`，整个 `/tracks` 被 `set` 替换 → `/meta/tracks`）。裁定原话只说了标量字段。页面只能看路径、不看值，按「顶层键」划最自然。

**差分对照顺带发现的一处两端不一致（C 类，已修）**：页面的 `entityOfPath` 把 `/@x/@y` 当成一对（名字段以 `@` 开头），服务端不认 `@` 开头的名字段。已改成页面与服务端一致，并加了断言。项目里的键不会以 `@` 开头，实际不会遇到，但两端口径必须相同。

## 3. 测试对账

### 3.1 胶水（只改 `server/test/c65-kit.mjs`）

| 假设 | 实际接口 | 对账 |
|---|---|---|
| A1 `applyOps(doc, ops)` 返回新文档，失败 `reason === 'bad-path'` | 返回 `{ root, effects }`（写时复制），失败抛 `OpError`，`code` 为 `bad-op` 或 `bad-path` | `apply()` 认 `{ root, effects }` 取 `root`；`bad-op` 对外记为 `bad-path`（规范页第 2 节：文档服务对外只有一种） |
| A2 `diffProject(prev, next) → { ops, inverse }` | 一致 | 不用改 |
| A3 `projectModule({ store, now })`、`createMemoryStore` / `createFileStore` | 一致 | 不用改 |
| A4 回包按 `opId` 对应，`project.state` 带 `rev` | 一致（另带 `projectRev`） | 不用改 |
| A5 `entity` 是字符串路径，`by` 至少带 `userId`、`session` | 服务端一致（没带 `role` 的旧式 principal 记成 `{ userId, session }`）；页面 `UndoResult.skipped[].by` 是 `{ actor, session }` | A7 包装里摊平成 `{ ...actor, session }` |
| A6 principal 按查询串给 | 一致 | 不用改 |
| A7 `createDocSync(options)`，自己连网、自己重连 | 导出的是 `DocSync` 类，传输靠注入（`send`、`receive`、`connect` / `disconnect`） | `loadDocSync()` 先载入 `src/testing/registerTs.mjs`（`.ts` 里没写扩展名的相对 import 靠它解析），再用 Node 的全局 `WebSocket` 包一层 `docSyncOverWebSocket`：`submit(_d, {coalesce})` 转成 `ds.commit(页面当前项目, {mergeKey})`，`saveWhenConfirmed` 转成 `whenSettled`，`resolveOffline` 转成 `replayOffline` / `discardOffline`，状态变成 `paused` 时调 `onOfflineConflict`，断线后每 50 ms 重连 |
| A8 日志在 `<dir>/projects/<id>.ops.ndjson` | 一致 | 不用改 |

断言一条没改，第 3.3 节的 B 类除外。

### 3.2 失败归类

合并后第一次跑 `node --test server/test/c65-*.test.mjs`：42 条，过 19、败 23。

| 类 | 用例 | 原因 | 处理 |
|---|---|---|---|
| A（接口名或形状不同） | C65-V1-01～05、07～10、20（10 条） | A1：返回值是 `{ root, effects }`，`bad-op` 与 `bad-path` 的叫法不同 | 胶水 A1 → 16/16 过 |
| A | C65-V2-01、V4-10、V5-01～05、V6-01～03、V7-01～02、V8-02（13 条） | A7：没有 `createDocSync`；`docsync.ts` 里无扩展名的 import 在裸 Node 下解析不到（`ERR_MODULE_NOT_FOUND ... src\kernel\diffProject`） | 胶水 A7 → 13/13 过 |
| B（裁定改了语义） | C65-V4-04 | 原断言「width 与 fps 同归 `/meta`」，与新的实体粒度裁定冲突 | 按新裁定改断言，见 3.3 |
| C（实现与裁定或另一端不一致） | 无测试失败；差分对照发现一处 | 页面把 `@` 开头的段当名字段 | 已修（第 2 节） |
| D（测试本身的问题，只报告） | C65-V1-08 的最后一例 | 用例说「move 的父级（c1.frame）不存在」，但在 `doc0` 里真正的原因是 `move` 的末段 `x` 不是 `@id`，属于格式错。照样回 `bad-path`、照样通过，只是通过的理由和用例描述不一样 | 不改 |

### 3.3 改了的断言（逐条）

**「删除不存在的目标 = bad-path」这一类断言，在 `c65-tests` 提交的文件里没有找到。** 测试方报告第 3 条歧义写的是「remove 父级存在、目标不存在；未断言」，那个取舍只在它 scratchpad 的参考实现里。我逐条查了 `c65-ops.test.mjs` 的 V1-06、V1-08 与 `c65-docservice.test.mjs` 的 V1-30 里用到的 `remove` / `move`，全是父级不存在（`@t9`、`@nope`、`@t404`、`/nope/deep`），新裁定下仍应是 `bad-path`，不用改。所以这一类改了 0 条。

因为实体粒度裁定而改的断言：

| 文件 | 用例 | 改前 | 改后 |
|---|---|---|---|
| `server/test/c65-docservice.test.mjs` | C65-V4-04（B 类） | `/fps` 与 `/width` 算覆盖，`entity === '/meta'` | `/width` 不再覆盖 `/fps`；B 再改 `/fps` 才算覆盖，`entity === '/meta/fps'`。用例名和注释都写明是按裁定改的 |
| `server/test/docservice-json-ops.test.mjs` | DS-J11 | `/width`、`/tracks`、`/style/x/@y` → `/meta` | → `/meta/width`、`/meta/tracks`、`/meta/style`；另加 `/a~1b` 的转义，以及 `normalizeEntity` 四例 |
| 同上 | DS-J12 | `/fps` → `/meta` | → `/meta/fps` |
| `server/test/docservice-project-ops.test.mjs` | DS-P5 的 `since.entities` | `'/meta'` | `'/meta/fps'` |
| `src/kernel/diffProject.test.mjs` | 规范-实体 | `/fps`、`/style/color`、`/tracks`、`/name` → `/meta` | → `/meta/fps`、`/meta/style`、`/meta/tracks`、`/meta/name`；另加 `/a~1b`、`/@x/@y`，以及 `entityValuePath` 三例 |
| `src/store/docsync.test.mjs` | V5 顶层字段那条 | 「别人改了 fps，我撤不回 name」（`skipped = [["/meta","B"]]`） | 反过来：别人改了 fps，我照样撤得回 name，fps 保留 B 的；别人也改了 name 才挡住（`skipped = [["/meta/name","B"]]`） |

旧的 `docservice-project.test.mjs`（P1～P7）没改。

## 4. 验证（原始关键行）

**只跑 c65 / docservice / auth**：`node --test server/test/c65-*.test.mjs server/test/docservice-*.test.mjs server/test/auth-*.test.mjs`，退出码 0：

```
ℹ 交错 399 次；rev 401；ann 落地 200 拒 0；ben 落地 200 拒 0
ℹ tests 254
ℹ pass 254
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

**类型检查**：`npx tsc -b --force`，退出码 0，没有输出。

**全量**：`npm test`，退出码 0：

```
ℹ tests 2726
ℹ suites 0
ℹ pass 2725
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
﹣ 集成:/api/cards/layout 对真实项目返回整数框 (0.1205ms) # SKIP
```

唯一跳过的是既有那条，它要 5190。全量里的 V8 行：

```
✔ C65-V8-01 单次提交的差异计算 ≤ 5 ms（1000 个片段的项目，改一个片段） (61.655ms)
✔ C65-V8-02 本机回环：一个页面改完到另一页面看到变化 ≤ 300 ms (218.0961ms)
"拖动一个片段": "median 0.046 ms, p90 0.059 ms, ops 2",
"整份深拷贝后改一处": "median 2.015 ms, p90 2.325 ms, ops 1"
V8 docsync 提交(1000 片段):median 0.051 ms;经内存假件到 B:median 0.082 ms
```

另外用 kit 单独测了一次真文档服务、真 WebSocket 下的回环延迟（临时脚本，跑完删掉，没有入库）：`V8-02 真文档服务回环(30 次,去掉前 2 次):median 15.50 ms,max 16.04 ms`。这个数值被 `waitFor` 的轮询间隔卡住了，实际延迟更低。

**G0-R**（改了 store 和 kernel）。端口：本分支 dev server 5500（舞台 5501、5502），main 基线 5503（舞台 5504、5505），都以 `PROMPTCUT_PUSH=0` 起。

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5500/?export=1"` | 退出码 0；`Total Frames: 1800` / `Identical: 1800` / `Different: 0` / `All frames are identical. Determinism verified!` |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5500 node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5500` | 退出码 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |
| 导出像素与 main | 临时 `git worktree add --detach .worktrees/c65i-main-baseline main`（`b84fee5`），在 5503 上跑同一条 `verify-determinism`（main 同样 1800/1800 一致），再用 pngjs 逐帧逐像素比两边的 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}` |

收尾：删基线 worktree 之前用 PowerShell 查过 reparse point，`reparse points: 0`，然后 `git worktree remove --force`。我起的两棵 vite 进程树已用 `taskkill /T` 结束：5503 那棵的根是 48776，5500 那棵的根是 51828。结束后 5500～5529 没有监听。没碰 5190～5192，没结束别人的进程。

## 5. 差分对照（沿用 kernel 报告的思路，脚本在本会话 scratchpad，不入库）

每个种子 50000 个随机项目（`src/testing/randomProject.mjs`）。三项对照：

1. **应用结果**：同一份文档、同一串操作分别交给页面 `applyOps` 与服务端 `applyOps`，比较「都成且逐字节相同」和「都败且失败下标相同」。操作有两类来源：一类随手写（非法路径、下标段、单独 `@`、`~` 转义错、非法 `index`、缺 `value`、没有 id 的值），另一类是 `diffProject` 算出的正操作（套到被并发改过的另一份上）和逆操作。
2. **路径→实体**：同一条路径，页面 `entityOfPath` 与服务端 `entityOf(path, {names: tracks/clips/transitions})` 逐个比。
3. **diff 出的操作的实体**：`diffProject` 算出的正、逆操作（不含根替换），页面按路径算的 `entitiesOf(ops)` 与服务端按实际差别算的 `entitiesOf(effects)` 比集合。

| 种子 | 应用：用例 | 都成且相同 | 都败且下标相同 | 不一致 | 路径→实体：用例 | 相同 | 不同 | 实体集合：用例 | 相同 | 页面按容器记 | 其它不同 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100000 | 54832 | 45168 | **0** | 105631 | 105631 | **0** | 100000 | 98892 | 1108 | **0** |
| 2 | 100000 | 54990 | 45010 | **0** | 105527 | 105527 | **0** | 100000 | 98810 | 1190 | **0** |
| 3 | 100000 | 54888 | 45112 | **0** | 105659 | 105659 | **0** | 100000 | 98900 | 1100 | **0** |

「页面按容器记」只有一种情形：在实体之上 `set` 一个容器，例如 `/tracks/@t1/clips` 由不带 id 的数组换成带 id 的数组。页面记容器所属的实体 `/tracks/@t1`，服务端另外逐个记真变了的下级实体 `/tracks/@t1/clips/@c2`。这是规范页第 4 节写明的「两边用法不同」，只影响页面撤销冲突的判定粒度（页面偏保守），不影响内容一致。第 1 项对照在改完实体之后重跑，页面与服务端的引擎代码都没因实体改动而改变应用语义，结果仍是 0 不一致。

## 6. 与设计稿、任务书不一致之处，以及更正建议

1. **顶层非标量字段**也按顶层键各算一个实体（`/meta/style`），属于我对裁定的延伸，请确认（第 2 节）。
2. **`/meta/<键>` 是实体名，不是路径**：凡是要拿实体去取值、跳转的地方（覆盖备份、提示条「点实体名跳过去」、「本地备份…」恢复），都要先换回 `/<键>`。页面已给出 `entityValuePath`，服务端已给出 `normalizeEntity`。`c65-editor` 做提示条跳转时要用它。
3. 设计稿第 3 节「`bad-path`：路径指向不存在的父级，且不是 `set`」已由第 13 节覆盖：`insert` 的父级不存在也是 `bad-path`，`remove` / `move` 的目标不存在是空操作。建议将来改第 3 节原文时直接引用规范页。
4. 设计稿第 4 节「撤回 - 应用远端 - 重放」，实现是「从已确认副本重放」（kernel 报告第 3 节第 1 条）。建议改写原文，结果与原文等价。
5. 测试方的假设 A7（页面同步自己连网）与 kernel 的设计（传输注入）不同。我没有让 `docsync.ts` 去迎合 A7，而是在测试胶水里包了一层，因为页面真正的接线（第 7 节）由 `c65-editor` 做。kit 里的 `docSyncOverWebSocket` 可以当接线的参考：`open` → `connect`，`message` → `receive`，`close` → `disconnect`，断线后重连。

## 7. 遗留

### 仍待 `c65-agent` 做的

- 设计稿第 5 节全部：Agent 服务端的项目副本（`ssrLoadModule` 载入 handler 与 store，副本随 `project.ops` 更新），写工具迁到服务端并带 `expectRev` 提交，`stale` 时回错并附 `since` 摘要，`get_layout` 等 `MIRRORED_TOOLS` 迁到服务端，`mcp-tools.mjs` 逐条标 `side`。
- **本机 `local` 空间里 Agent 的身份**：回环什么都不带时是 `LOCAL_PRINCIPAL`（`role: 'page'`，没有对话号）；`promptcut.role.agent.<n>` 又必须和 tenant 一起用。要让 `actor` 记成「agent + 对话号」，需要给本机声明补一条不带 tenant 的角色项（docservice 报告第 8 节）。
- **M5b 预渲染发布流程与真身冲突**：项目有了真身之后，`announce` 不再发号；`vite-plugin-frames.ts` 的「announce → putSnapshot → 发布 plan」里，只要报上来的内容和真身不逐字节相同，就会得到 `digest-mismatch`。页面一连上文档服务就会产生真身，所以**这一处必须在页面接线之前或同时改**：要么发布方直接用当前 `rev`（节点靠 `snapshot.get`，由真身发回），要么拿真身的文本去算。这一处不在第一批任何分支的清单里。
- AI 栏「撤销这一步」要用到 Agent 那次提交的逆操作：建议 `events.complete` 里带上逆操作，或者存进内容库 `event-detail`（kernel 报告第 5 节）。
- 工具调用事件（`events.create` / `complete` / `text`）的发送方：服务端模块已就绪，发送方在 Agent 服务端。

### 仍待 `c65-editor` 做的

- **页面真接线**：连上 `/docservice`（`local` 空间），用 WebSocket 接 `DocSync`（参考第 6 节第 5 条），调用 `bindStore(ds)`；换项目时先解绑再重建。
- `.proc` 保存改成先 `await ds.whenSettled({ timeoutMs })`（`src/editor/io/proc.ts`），超时给提示。
- 在草稿目录下落盘 `backups/`（`saveBackup` 已给出数据，`kind` 为 `overwritten` 或 `offline-discard`），加「项目」菜单「本地备份…」，恢复就是一次新的写入。
- 离线对话框（「重放」「丢弃」，读 `ds.pausedInfo`）与顶栏「同步已暂停」状态。
- 撤销：只有部分撤回时的提示条（`notice.kind === 'undo'` 的 `skipped` / `failed`，超过 3 处折叠，点实体名跳过去，要先 `entityValuePath`），撤销 / 重做按钮用 `canUndo` / `canRedo` 置灰，数字框的 action 传 `mergeKey`。
- 别人改动的 1.5 s 描边：`DocSync` 还没发「改了哪些实体」的事件，要在 `onOps` 里加一个。
- AI 栏按事件 id 更新记录（`events.event`），列表虚拟化；「撤销这一步」需要 `ds.revertRemote({ opId, inverse })`（待加，复用 `revert` 的冲突检查，`undoOf` 指向 Agent 那次提交）。
- 页面发出超过 256 KiB 的根替换（打开大的旧 `.proc`、Skill 合并结果）时，改走 `project.upload`：在 `DocSync.sendOp` 里按大小分流。服务端已就绪，页面还没接。
- D11 两项菜单、成员列表、创建者操作入口（设计稿第 9 节）。
- 可选：页面撤销冲突改用服务端算好的实体（`project.ops` 带上 `entities`），这样能消除第 5 节里「页面按容器记」的保守判定。
