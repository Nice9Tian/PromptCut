# C6.5 路径操作规范

页面（`src/kernel/diffProject.ts` 的 `applyOps`）和文档服务（`server/docservice/json-ops.mjs`）各有一份应用路径操作的实现，两边必须逐条按本页的语义做，才能保证同一串操作在两边得到**逐字节相同**的结果（`JSON.stringify` 相同，含键的顺序）。依据 `c65-design.md` 第 2、3 节；本页只补那两节没写死的细节，与之冲突时以设计稿为准并回报。

## 1. 路径

- 形式是 JSON 指针（RFC 6901）：`""` 是根；其余以 `/` 开头，逐段用 `/` 分隔；段内 `~` 写成 `~0`、`/` 写成 `~1`，先按这两条还原再解释。
- 一段落在**对象**上：按键名取，`@` 开头也只是普通键名。
- 一段落在**数组**上：必须是 `@<id>`，取数组里 `id === <id>` 的那个元素；找不到就是 `bad-path`。**不支持下标**（`/0` 落在数组上一律 `bad-path`）。
- **带 id 的数组**：每个元素都是普通对象、都有字符串 `id`、`id` 互不相同。空数组也算。不满足的数组整体当一个值，只能用 `set` 整个替换。

## 2. 四种操作

一次提交 `ops` 按顺序逐条应用在上一条的结果上；任何一条失败，整批不生效，原对象不变（原子），失败码一律 `bad-path`，附失败那条的下标。

| 操作 | 形状 | 前置条件（不满足即 `bad-path`） | 效果 |
|---|---|---|---|
| `set` | `{op, path, value}` | `value` 不是 `undefined`；路径途经的数组段能找到元素；途经的值不是基本类型；落点在数组上时，那个元素存在，且 `value` 是普通对象、`value.id` 等于该段的 id | 落点在对象上：键已存在就原位替换（**键的位置不变**），不存在就**追加在末尾**；途中缺的对象级父键逐个建成 `{}`（同样追加在末尾）。落点在数组上：原位替换那个元素。`path: ""` 是根替换，`value` 必须是普通对象 |
| `remove` | `{op, path}` | 路径不是根；落点存在 | 对象：删掉这个键（其余键顺序不变）。数组：删掉这个元素 |
| `insert` | `{op, path, index, value}` | `path` 指向一个已存在的带 id 的数组；`value` 是普通对象、有字符串 `id`，且数组里没有同 id 的元素；`index` 是非负整数 | 插到 `min(index, 长度)` 处（**越界夹到末尾，不算失败**：别人并发删了元素时仍能落地） |
| `move` | `{op, path, index}` | `path` 的最后一段是数组上的 `@<id>`，元素存在；`index` 是非负整数 | 先把元素拿出来，再插到 `min(index, 拿出后的长度)` 处 |

- 不认识的 `op`、缺字段、`path` 不是字符串，也按 `bad-path` 处理（文档服务的拒绝理由只有 `stale / bad-path / too-large / forbidden` 四种）。
- `value` 原样放进去，不深拷贝、不补默认值、不排序键。

## 3. 差异与逆操作（只在页面一侧）

`diffProject(prev, next) → { ops, inverse }`：`applyOps(prev, ops)` 深相等 `next`，`applyOps(next, inverse)` 深相等 `prev`。

- 对象逐键递归：`prev` 有、`next` 没有（或是 `undefined`）的出 `remove`；反之出 `set`；两边都有的递归。
- 两边都是带 id 的数组：先 `remove` 消失的元素，再按 `next` 的顺序把新元素 `insert`、把不在最长保序子序列里的旧元素 `move` 到位（每个元素至多挪一次），最后对两边都有的元素逐个递归。
- 其余情况（基本类型、不带 id 的数组、类型变了）：结构不等就整个 `set`。
- 单次超过 500 条时改成一条根替换 `{op:"set", path:"", value: next}`，逆操作是根替换回 `prev`。
- 键的顺序不在「深相等」之内：页面乐观落地时本地存的是 `applyOps(prev, ops)` 的结果而不是 `next` 本身，所以页面副本与文档服务副本的键顺序一致。

## 4. 实体（覆盖通知与撤销冲突用）

一条操作写到的**实体**，由它的有效路径决定（`insert` 的有效路径是 `path + "/@" + value.id`，其余就是 `path`）：

- 从根开始取 `/<名>/@<id>` 成对的最长前缀：第一对的名字不限；之后每一对的名字只能是 `tracks`、`clips`、`transitions`。
  - `/tracks/@t1/clips/@c3/frame/x` → `/tracks/@t1/clips/@c3`（片段）
  - `/tracks/@t1/name` → `/tracks/@t1`（序列）
  - `/tracks/@t1/clips/@c3/parts/@p2/x` → `/tracks/@t1/clips/@c3`（部件归片段）
  - `/cuts/@k2/tracks/@t1/clips/@c3/start` → `/cuts/@k2/tracks/@t1/clips/@c3`
  - `/filters/@f1/strength`、`/media/@m1/transcript` → `/filters/@f1`、`/media/@m1`
- 取不到任何一对：根替换（`""`）是 `*`，表示所有实体；其余（`/name`、`/fps`、`/style/...`、整个 `/tracks` 被 `set` 替换）都归 `/meta`。
- 两个实体相同、或其中一个是 `*`，就算写到了同一处。

## 5. 提交协议的补充要求（给文档服务）

- **按 `opId` 幂等**：同一 `opId` 再次提交时，若已落地过，直接回 `project.op.ok { opId, rev: <当初的 rev> }`，不再应用、不再广播；这一步先于 `expectRev` 检查。页面断线时在途的提交不知道落没落地，重连后会用原 `opId` 重发。
- **同一连接上按 rev 有序**：文档服务串行处理提交；给提交者的 `ok` 与给其它订阅者的 `project.ops` 都在该次提交落地后、处理下一次提交之前发出。页面据此认定：`ok` 之前收到的 `project.ops` 都排在自己这次提交之前。
- `project.ops` 带 `session`（或在 `actor.session` 里），页面据此区分「别的写入身份」。
- `project.state` 在项目不存在时回 `project: null, rev: 0`，页面随后用根替换把本地项目写进去。
