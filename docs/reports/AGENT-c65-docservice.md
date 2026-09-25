# AGENT 报告：c65-docservice

分支 `claude/c65-docservice`（基于 `claude/c65` 的 `3134428`），worktree `.worktrees/c65-docservice`。
任务：C6.5 设计稿 `docs/plan/c65-design.md` 第 2 节 JSON 路径引擎、第 3 节 `project` 模块升级、第 7 节 `events` 模块、第 10 节 actor 统一。

状态：做完、基线全绿，等主会话审查与集成。没有推送、没有合并。

## 1. 做了什么

| 文件 | 改动 |
|---|---|
| `server/docservice/json-ops.mjs`（新） | 通用 JSON 路径引擎：`parsePath` / `formatPath` / `checkOps` / `applyOps`（写时复制、整批原子）/ `entityOf` / `entitiesOf` / `jsonEqual` / `isIdArray`。只用语言内置能力，不引用任何文件，不认识任何业务名字 |
| `server/docservice/modules/project.mjs` | 持有项目真身：`project.open` 回真身、`project.op` 提交、`project.ops` 广播、`stale`+`since`、`bad-path`、`too-large`、`forbidden`、按 `opId` 幂等、覆盖通知、`project.follow`、快照+日志+截断+重启回放、大项目分片（`project.state.part`）、大的根替换上传（`project.upload`）。旧的 `announce` / `snapshot.put` / `snapshot.get` 全部保留，关系见第 4 节 |
| `server/docservice/modules/events.mjs`（新） | 工具调用事件：`events.create` / `events.complete` / `events.text` / `events.list`，借项目频道广播 `events.event`，完整参数进内容库 `event-detail` |
| `server/docservice/modules/content.mjs` | 把写入抽成内部 `write`，新增 `putFromModule`（事件模块代写 `event-detail` 用）；对外行为不变 |
| `server/docservice/store/index.mjs` | 新增 `rewrite(stream, records)`（文件存储：临时文件+刷盘+改名；内存存储：整条替换），给操作日志截断用 |
| `server/docservice/router.mjs` | `publish` 的发送选项多认一个通用字段 `except`（跳过一条连接），用于「发给除提交者以外的订阅者」。没有业务词，R2 守门照过 |
| `server/docservice/shared-service.mjs` | 按空间把 项目 / 内容库 / 事件 三个实例配成一组（`bundleForSpace`），多挂一个 `events` 模块；删项目时一并丢掉这一组 |
| `server/test/docservice-json-ops.test.mjs`（新） | DS-J1～J12 |
| `server/test/docservice-project-ops.test.mjs`（新） | DS-P1～P12（含 V2 / V3 / V4 的文档服务一侧） |
| `server/test/docservice-events.test.mjs`（新） | DS-E1～E6（含第 10 节 actor、组装层按空间隔离） |

**现有测试一条没改**（`git diff 3134428 --stat -- server/test` 只有上面三个新文件）。

没有写 `docs/plan/c65-ops-spec.md`：动手对齐时发现 `c65-kernel` 的 worktree 里已有一份未提交的草稿，按任务书「对方的规范已在，集成时由主会话对齐」，本分支不写它，精确语义写在本报告第 3 节。我已按那份草稿把引擎里与设计稿不冲突的几处对齐（第 7 节列出），冲突的地方按设计稿做。

## 2. 验证

- `npx tsc -b --force` → 退出码 0（无输出）。
- `npm test` → 退出码 0，关键行原样：

```
ℹ tests 2627
ℹ pass 2626
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```

- 本分支新增用例 30 条（DS-J 12、DS-P 12、DS-E 6），全过。DS-P11 的诊断行（最后一次单跑）：`交错 399 次；rev 401；ann 落地 200 拒 0；ben 落地 200 拒 0`。
- 与文档服务相关的现有测试（`docservice*`、`project-snapshot`、`auth-*`、`content-client`、`sp-*`）在改动过程中单独跑过两次，231/231 过；最终以全量 `npm test` 为准。
- **G0-R 没跑**：没有碰渲染路径（`src/`、`server/bakery/`、`server/frame-*`、`vite.config.ts` 都没动），只改了 `server/docservice/` 与新增测试。
- 没起 dev server，没占 5510～5519 以外的固定端口（测试都用端口 0）；没结束任何进程。

设计稿验收在文档服务一侧的对应：

| 验收 | 用例 | 断言 |
|---|---|---|
| V2 两个页面同改 | DS-P11 | 两条连接各 200 次随机编辑并发提交（相邻两次换人 399 次）；两边按收到的 `project.ops` 与自己的 `ok` 重建的副本、只收 `project.ops` 的旁观者、文档服务重新 `open` 的内容，三份 `JSON.stringify` 逐字节相同；每条连接收到的 `rev` 连续，`ok` 排在它之前的 `ops` 之后 |
| V3 期望版本 | DS-P5 | Agent 读到 rev 1，页面落地 rev 2、3；Agent 带 `expectRev: 1` 写回 `stale`，`currentRev: 3`，`since` 与两次实际提交逐字段相同（`rev`、`opId`、`actor`、`at`、`paths`、`entities`），`sinceComplete: true`；重读后带 `expectRev: 3` 写成功 rev 4 |
| V4 覆盖通知 | DS-P7 | 覆盖方 `ok.overwrote` 恰一条；被覆盖方恰收一条 `project.overwritten`，且先于这一版的 `project.ops`；覆盖方不收 `overwritten`；超过 10 分钟、同一写入身份、退出跟踪的都不通知被覆盖方（本地备份文件是页面侧，不在本分支） |

## 3. 精确的操作语义（`json-ops.mjs`）

**路径**
- JSON 指针：`""` 是根，其余以 `/` 开头；段内先还原 `~1` → `/`、`~0` → `~`（其它 `~x` 是语法错）。
- 段落在**对象**上：按键名取，`@` 开头也是普通键名。
- 段落在**数组**上：必须是 `@<id>`（`@` 后非空），取第一个「普通对象、`id` 是字符串且 `===`」的元素；数字段、找不到都是 `bad-path`。数字 `id` 不认。
- **带 id 的数组**（`isIdArray`）：每个元素是普通对象、有非空字符串 `id`、互不相同；空数组也算。

**四种操作**（按顺序应用在上一条的结果上；任何一条失败整批作废，旧根不变）

| 操作 | 格式要求（不满足 = `bad-op`） | 走不通（= `bad-path`） | 效果 |
|---|---|---|---|
| `set {path, value}` | `value` 存在且不是 `undefined`；`path: ""` 时 `value` 必须是普通对象 | 途经数组段找不到元素；途经值是标量或 `null`；在数组上用非 `@` 段；落点在数组上时元素不存在或 `value` 不是 `id` 相同的普通对象；根是标量 | 对象上：已有键原位替换（位置不变），没有就追加在末尾；途中缺的对象键逐个建成 `{}`（追加在末尾）；**根缺失（还没有真身）时也建成 `{}`**。数组上：原位替换那个元素。`""`：替换整个根 |
| `remove {path}` | `path` 不是 `""` | **父级**不存在或不是容器；落在数组上而末段不是 `@id` | 对象：删键（其余键顺序不变）；数组：删元素。**目标不存在时什么都不做（noop），不算失败** |
| `insert {path, index, value}` | `value` 是带非空字符串 `id` 的普通对象；`index` 是非负安全整数 | `path` 不存在；不是数组；不是带 id 的数组；数组里已有同 `id` | 插到 `min(index, 长度)` |
| `move {path, index}` | `path` 末段是 `@id`；`index` 是非负安全整数 | 元素所在的数组不存在或不是数组 | 拿出后插到 `min(index, 拿出后的长度)`；**元素不存在时什么都不做（noop）** |

- `value` 原样放进去，不深拷贝、不补默认值、不排序键。写时复制只复制路径上经过的容器，所以旧根可以安全地继续被别人读。
- `__proto__` 按普通键写（`defineProperty`），不改原型。
- 文档服务对外的拒绝理由只有四种：`bad-op` 与 `bad-path` 对提交者一样，**都回 `reason: 'bad-path'`**，附 `detail` 与出错那条的 `index`（`ops` 不是数组或为空时 `index: -1`）。

**实体**（覆盖通知与 `since.entities` 用）
- 从根开始取成对的 `/<名>/@<id>` 的最长前缀；第一对的名字不限，之后每一对的名字要在 `names` 里。文档服务里 `names` 缺省是 `['tracks', 'clips', 'transitions']`（`project.mjs` 的 `PROJECT_ENTITY_NAMES`，可由组装层经 `entityNames` 换掉；这是文档服务唯一认识的项目结构）。
  - `/tracks/@t1/clips/@c3/frame/x` → `/tracks/@t1/clips/@c3`；`/tracks/@t1/clips/@c3/parts/@p2/x` → `/tracks/@t1/clips/@c3`；`/tracks/@t1/name` → `/tracks/@t1`；`/filters/@f1/a` → `/filters/@f1`；`/cuts/@k2/tracks/@t1/clips/@c3/start` → `/cuts/@k2/tracks/@t1/clips/@c3`。
  - 一对都取不到的（`/width`、`/style/x/@y`、整个 `/tracks`）→ `/meta`；`entityOf("")` → `*`。
- 一次提交写到哪些实体（`entitiesOf`）：
  - `set` 按**新旧值的实际差别**算：值没变不算写到；整个根替换、或在实体之上 `set` 一个容器（例：整条 `/tracks/@t1`），逐实体比，只记真变了的（新增、删掉、改了的元素各记各的；共同元素的顺序变了记到数组所属的实体）；
  - `remove`、`move` 真删了、真挪了才算，记目标路径所属的实体；`insert` 记新元素所属的实体。

## 4. 项目模块：消息形状清单

所有回包都原样带回请求的 `reqId`。校验不过（`projectId` 不合法、缺 `opId` 等信封层面的错）回 `error { reason: 'bad-message' }`，状态不变。

**入站**

| 消息 | 字段 |
|---|---|
| `project.open` | `projectId` |
| `project.op` | `projectId`、`opId`（1～128 字符）、`ops`、`expectRev?`（非负整数）、`session?`（1～128 字符）、`undoOf?`（1～128 字符） |
| `project.follow` | `projectId`、`entity`（路径，按实体口径归一；`*` 表示全部）、`on`（布尔）、`session?` |
| `project.upload` | `projectId`、`uploadId`、`index`、`count`（≤ 64）、`data`（每片 ≤ 512 KiB）。收齐后必须是 JSON 对象 |
| `project.close` / `project.announce` / `project.snapshot.put` / `project.snapshot.get` | 与 C6.3、M5b 契约相同 |

`project.op` 的 `ops` 里可以有一条 `{ op: 'set', path: '', upload: <uploadId> }`（不带 `value`），引用收齐的上传做根替换；用过一次就删。

**出站**

| 消息 | 字段 | 发给谁 |
|---|---|---|
| `project.state` | `projectId`、`rev`、`projectRev`（= `rev`）、`digest`、`at`、`hasBody`、`writers: [{ entity, actor, at, rev }]`，以及 `project`（没有真身时 `null`）或 `parts`（大项目：分片数） | 请求方 |
| `project.state.part` / `project.state.end` | `{ projectId, rev, index, count, data }` / `{ projectId, rev, digest }` | 请求方，按积压节流 |
| `project.op.ok` | `projectId`、`opId`、`rev`、`overwrote: [{ entity, by, rev, at }]`（总是数组），重复提交另带 `duplicate: true` | 提交者 |
| `project.op.rejected` | `projectId`、`opId`、`reason`、`currentRev`；`stale` 另带 `expectRev`、`since`、`sinceComplete`；`bad-path` 另带 `detail`、`index`；`too-large` / `forbidden` 带 `detail` | 提交者 |
| `project.ops` | `projectId`、`rev`、`opId`、`ops`、`actor`、`at`、`undoOf?`；上传引用的根替换广播时太大，改成不带 `ops` 的 `resync: true` | 项目频道上**除提交这一条连接以外**的订阅者 |
| `project.overwritten` | `projectId`、`entity`、`by`（覆盖方的 actor）、`writer`（被覆盖的那次写入的 actor）、`rev`（覆盖它的新版本）、`at` | 被覆盖的写入身份此刻在线、以那个身份提交或 follow 过的每条连接 |
| `project.following` | `projectId`、`entity`（归一后）、`on` | 请求方 |
| `project.uploaded` | `projectId`、`uploadId`、`received`、`count`、`complete` | 请求方 |

**提交的处理顺序**（一次提交同步处理完，处理下一次之前所有消息都已发出）：校验信封 → 渲染节点连接回 `forbidden` → `opId` 已落地过回 `ok { duplicate }`（先于 `expectRev`）→ `ops` 空或不是数组回 `bad-path` → `JSON.stringify(ops)` 的 UTF-8 字节 > 256 KiB 回 `too-large` → 带了 `expectRev` 且 `!== 当前版本` 回 `stale` → 应用失败回 `bad-path` → 先追加日志再改内存 → 算覆盖 → 回 `ok` → 给被覆盖方发 `project.overwritten` → 频道广播 `project.ops` → 满 200 次提交落快照。

**`stale.since`**：`rev` 在 `(expectRev, 当前]` 的每次提交 `{ rev, opId, actor, at, paths, entities, undoOf? }`，按 `rev` 升序。`paths` 是每条操作写到的位置（`insert` 是新元素的路径，规范写法、去重、每次最多 256 个）。没有真身时由 `announce` 发的号也在里面，形如 `{ rev, actor, at, paths: [], entities: [], announce: true }`。最多列最近 200 次；内存只留最近 1000 次的摘要（快照里也存），列不全时 `sinceComplete: false`。`expectRev` 比当前还大也算 `stale`，`since: []`。

**覆盖通知**
- 写入身份 = `actor` 的 `(userId, deviceId, role, conversation, session)` 五项全等。同一用户同一设备的两个页面会话是两个身份。
- 每个实体记最近写入者 `{ actor, at, rev }`；一次提交写到的实体，若上一个写入者是别的身份且 `now - at ≤ 10 分钟`：`ok.overwrote` 列出（`by` 是**被覆盖方**），被覆盖方收 `project.overwritten`（`by` 是**覆盖方**）。然后该实体的最近写入者换成本次。
- `project.follow { on: false }` 只影响被覆盖方是否收 `project.overwritten`，覆盖方的 `overwrote` 照列。退出跟踪的记录只在内存里，重启丢失。
- 最近写入者存进快照（只存时间窗内的），重启后仍能判覆盖（DS-P8）。

**存储**
- 操作日志 stream `projects/<projectId>.ops`（文件 `projects/<编码>.ops.ndjson`），每行 `{ projectId, rev, opId, ops, actor, at, entities, undoOf? }`；`ops` 是解析过上传引用之后的。
- 真身快照 `projects/<编码>.state-<sha256(projectId) 前 16 位>.json`：`{ v: 1, projectId, rev, at, project, writers, history, opIds }`。文件名带散列：Windows 不分大小写，只差大小写的两个项目编码后同名。
- 每 200 次提交（`snapshotEvery`）先原子写快照，再用 `store.rewrite` 把日志截断到快照之后；同一文件里别的项目（只差大小写）的记录原样留下。截断失败只记日志，日志本身是完整的。
- 第一次用到某个项目：读 C6.3 的版本日志（`projects/<id>`）得到 announce 发的号 → 读快照 → 回放快照之后的日志。回放某条失败就停下并记 `project.replay-failed`（说明日志坏了，不在错的内容上接着回放）。
- `opId` 每个项目记最近 5000 个，跨重启（快照 + 日志）。

**大项目**：内容序列化后 > 256 KiB 时，`project.state` 不带 `project`、带 `parts`，随后按 M5b 同一条节流队列发 `project.state.part` 与 `project.state.end`。分片发送期间别的提交会照常经频道广播过来，**客户端要把 `rev` 大于 `state.rev` 的 `project.ops` 先攒着，拼完再按序应用；`rev` 不大于它的丢掉**。

## 5. 与旧消息的关系（任务书要求写进报告）

- 版本号只有一个：`project.op` 的 `rev` 与 `announce` 的 `projectRev` 是同一个计数器。
- **没有真身**（从没收到过 `project.op`）：`announce` 照 C6.3 发号、记版本日志、广播 `project.rev`，行为一字不变（现有 P1～P7、M5b 快照测试全过）。
- **有了真身**（收到过任意一次 `project.op`，之后永久算有）：摘要以真身为准。`announce` 不再发号，回 `project.announced { projectRev: 当前, changed: false, digest: sha256(JSON.stringify(真身)), authoritative: true, matches: 报上来的摘要是否等于它 }`，不广播 `project.rev`。
- M5b 快照：当前版本登记的摘要就是真身的摘要，所以 `snapshot.put` 只有内容与真身逐字节相同时才收；`snapshot.get` 取当前版本而存储里没有那个文件时，直接由真身发回。
- `project.state` 同时带新旧两套字段：`rev` / `project` / `writers` / `hasBody` 与 `projectRev` / `digest` / `at`；有真身时 `digest` 是真身的摘要。

## 6. 事件模块：消息形状清单

| 入站 | 字段 | 回包 |
|---|---|---|
| `events.create` | `projectId`、`eventId`（`[A-Za-z0-9._:-]{1,128}`）、`tool`（1～128）、`icon?`（≤ 64）、`target?`（≤ 512）、`args?`（参数摘要，≤ 2048）、`detail?`（任意 JSON）、`session?` | `events.ack { projectId, eventId, phase: 'create', detailKey }` |
| `events.complete` | `projectId`、`eventId`、`status`（`ok` / `error` / `cancelled`）、`summary?`（≤ 2048）、`durationMs?`、`session?` | `events.ack { phase: 'complete' }` |
| `events.text` | `projectId`、`eventId`、`text`（≤ 64 Ki 字符）、`session?` | `events.ack { phase: 'text' }` |
| `events.list` | `projectId` | `events.listing { projectId, items }`（内存里每个项目最近 500 条，按 `eventId` 合并） |

- 广播：`events.event { projectId, eventId, phase, …, actor, at }`，`create` 带 `tool / icon / target / args / detailKey`（**不带** `detail`），`complete` 带 `status / summary / durationMs`，`text` 带 `text`。走 `project:<projectId>` 频道，发给除发送连接以外的订阅者，订阅就是 `project.open`。
- `detail` 写进内容库 `event-detail`，键 `<projectId>/<eventId>`，写入身份是发事件的连接；超过内容库上限回 `error { reason: 'too-large' }`，什么都不落、不广播。渲染节点的连接回 `forbidden`。
- 事件不落盘，重启后从新的事件开始。

## 7. 与设计稿、与 c65-kernel 规范草稿不一致之处（请主会话裁定）

**与 c65-kernel 草稿（`c65-kernel` worktree 里未提交的 `docs/plan/c65-ops-spec.md`）对齐了的**：`id` 只认字符串全等；`insert` 要求目标是带 id 的数组；根替换的 `value` 必须是普通对象；格式错误对外也回 `bad-path`；按 `opId` 幂等且先于 `expectRev`；`project.ops` 的 `actor.session` 带会话；实体按「成对前缀 + 名字限定」口径。

**仍不一致、必须在集成时统一的**：

1. **`remove` / `move` 的目标不存在**：本分支按设计稿第 3 节原话「`bad-path`：路径指向不存在的父级，且不是 `set`」，父级在、目标不在时**什么都不做、照常落地**；草稿要求「落点存在」否则 `bad-path`。两边不一致时，页面应用文档服务已接受的 `project.ops` 会失败，副本分叉。二选一即可，我倾向设计稿的做法：两个人同时删同一个片段时，后到的那批不至于整批被拒、连带丢掉同批的其它修改。
2. **根替换的实体**：草稿记 `*`（所有实体）；本分支按实际差别逐实体算（同样适用于在实体之上 `set` 一个容器）。这只影响文档服务的覆盖通知与 `since.entities`，不影响内容一致。逐实体算能避免一次根替换把所有在 10 分钟内写过的人都标成「被覆盖」。`since.paths` 里根替换仍是 `""`，页面按草稿口径自己算 `*` 也行。
3. **根缺失时的 `set`**：本分支允许（建 `{}`），草稿没写。页面的项目永远不是 null，影响不大，可以写进规范。

**对设计稿的补充或偏离**（设计稿有歧义时按最合理的做，逐条列出）：

4. **`overwrote[].by` 与 `project.overwritten.by` 的含义**：设计稿两处都叫 `by`。本分支定为「对方」：覆盖方看到的 `by` 是被覆盖的人，被覆盖方看到的 `by` 是覆盖它的人。`overwritten` 另加 `writer`（被覆盖的那次写入的身份），因为 Agent 服务端一条连接上跑多个对话，要靠它分给对应的对话；同理，提交者自己的连接若也以被覆盖的身份提交过，照样收 `overwritten`。
5. **`overwritten` 先于 `project.ops`**：设计稿要求被覆盖方「先存本地备份，再应用新版本」，所以同一连接上 `overwritten` 排在这一版的 `ops` 之前。
6. **`forbidden` 的判据**：设计稿没写。本分支定为「`role: 'render'` 的连接不能提交、不能发事件」。管理身份本来就进不了空间。
7. **事件走「项目频道」的做法**：核心不许两个模块共用频道前缀，所以事件模块不声明频道，借同一空间项目模块的 `publishToProject` 在 `project:<id>` 上广播；组装层按空间把两者配对。没有另起 `events:` 频道，页面只要 `project.open` 一次。
8. **事件消息名**：设计稿只写了「创建 / 完成、文字回复」。本分支定为入站 `events.create / complete / text / list`，广播统一叫 `events.event`（带 `phase`），回包 `events.ack`。事件只在内存里留最近 500 条，不落盘。
9. **大的根替换**（`project.upload` + `upload` 引用 + 广播 `resync`）：设计稿没有，但它规定单次提交 ≤ 256 KiB，又规定打开旧 `.proc` 用根替换，大项目会进不来。这是补充，主会话可以删掉或换别的做法。
10. **真身快照的文件名**带 `projectId` 的散列（理由见第 4 节「存储」）；日志文件名与设计稿一致。
11. **`writers` 摘要**：`project.state.writers` 只列 10 分钟时间窗内的，按版本从新到旧最多 200 个。
12. **`follow` 的范围**：设计稿形状里没有 `projectId`，本分支要求带；按写入身份记（principal + `session`），只在内存里。

**第 10 节 actor**：M6a 形状的 principal（带 `role`）写入的 `actor` 在内容库、项目日志、`project.ops`、`events.event`、`content.changed.previousActor` 里都是完整的 `{ userId, deviceId, role, conversation, session }`（DS-E4、DS-P12）。**不带 `role` 的旧式身份**（测试里注入的 `authenticate`、M5 的身份）仍记 `{ userId, session }`：现有测试（`docservice-content` 的 N6 与日志字段用例、`docservice-project` P2、`auth-impl-client`）按这个形状断言，改了就要动现有测试，按任务书没有动。真实部署里所有握手出来的 principal 都带 `role`，不受影响。

## 8. 给主会话与其它分支的提醒

- **本机 `local` 空间里 Agent 的身份**：回环什么都不带时是 `LOCAL_PRINCIPAL`（`role: 'page'`、没有 `deviceId`、没有对话号），而 `promptcut.role.agent.<n>` 只能跟 `promptcut.tenant.<id>` 一起用，单独带会被拒（`handshake.mjs`）。所以本机的 Agent 服务端现在只能以 `role: 'page'` 连上、靠 `session` 区分对话，`actor.role` 会是 `page`。设计稿第 5 节说本机 `local` 空间「由本机信任」，要让 `actor` 记成 `agent + 对话号`，需要 `c65-agent`（或 auth）给本机声明补一条不带 tenant 的角色项。本分支没动握手。
- **M5b 队列模式与真身的关系**：`vite-plugin-frames.ts` 的发布流程是「announce 拿号 → putSnapshot 传快照 → 发布 plan」。项目有了真身之后，announce 不再发号；预渲染进程报的内容若与真身不逐字节相同，`putSnapshot` 会回 `digest-mismatch`。集成时要么让发布方直接用当前 `rev`（节点按 `snapshot.get` 取，文档服务会由真身发回），要么改发布方拿真身的文本去算。这一处不在本分支的文件清单里。
- **页面侧分片接收**：大项目的 `project.state` 分片期间，`project.ops` 可能先到，页面要按第 4 节末段攒着。
- 核心 `router.mjs` 只加了一个通用的 `except` 发送选项；业务词守门（R2）与依赖守门（D2）都照过。
