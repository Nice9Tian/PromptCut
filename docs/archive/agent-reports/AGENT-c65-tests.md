# AGENT 报告：C6.5 第一批测试（c65-tests）

分支 `claude/c65-tests`（基于 `claude/c65`），测试方，对抗式：只照 `docs/plan/c65-design.md`（第 2、3、4、6、7、8、10 节，第 11 节 V1～V8）与语义 `document-service.md`（冲突、离线、项目文件）写，没读 `claude/c65-kernel`、`claude/c65-docservice` 的实现。

## 做了什么

| 文件 | 内容 |
|---|---|
| `server/test/c65-kit.mjs` | 公共件：被测模块的载入、随机项目生成（固定种子）、起文档服务、提交与打开、页面同步包装、可断网通道、观察者。**所有设计稿没写死的名字都集中在这里**（假设 A1～A8） |
| `server/test/c65-ops.test.mjs` | 操作格式四种 op、整批原子、根替换、bad-path、JSON 指针转义；`diffProject` 性质测试与确定性；V8 差异计算耗时 |
| `server/test/c65-docservice.test.mjs` | 文档服务：open、提交与 rev、广播、stale 与 since、服务端原子、too-large、覆盖通知、重启回放 |
| `server/test/c65-sync.test.mjs` | 页面同步：V2 两页 400 次交错编辑、V6 离线（按序落地、重放、丢弃）、V7 `.proc`、V4 页面侧备份、V8 回环延迟 |
| `server/test/c65-undo.test.mjs` | 撤销 / 重做：V5 部分撤销、全部没撤成出栈、按写入身份分栈、重做、数字框 300 ms 合并 |

## 编号对应

| 编号 | 用例 | 设计稿依据 |
|---|---|---|
| C65-V1-01～04 | set（建缺的父级）/ remove / insert / move，都按 `@id` 寻址 | 第 2 节「四种操作」 |
| C65-V1-05 | 别人在同一数组插删、挪之后，按 `@id` 的操作仍打中正确对象 | 第 2 节「路径」 |
| C65-V1-06 | 引擎层整批原子：中途失败，传入的文档一处不变，原因 `bad-path` | 第 2 节「原子生效」 |
| C65-V1-07 | 根替换，及同批后续操作作用在新文档上 | 第 2 节「根替换」 |
| C65-V1-08 | bad-path 六种情形 | 第 3 节 `bad-path` |
| C65-V1-09 | 没有 id 的数组整体 set | 第 2 节 |
| C65-V1-10 | JSON 指针的 `~0`、`~1` 转义 | 第 2 节「JSON 指针」 |
| C65-V1-20 | **V1**：1000 个随机项目（固定种子 0xc65），ops 正向、inverse 反向 100% 还原；diffProject 不改输入 | 第 2 节性质测试、V1 |
| C65-V1-21 | 确定性；相同项目差异为空 | 第 2 节「纯函数、确定性」 |
| C65-V1-22 | 带 id 的数组不按下标寻址；只出现四种操作 | 第 2 节 |
| C65-V1-23 | 序列内挪一个片段只产生 move（条数不做硬性要求，只打日志） | 第 2 节「按 id 比对插、删、挪」 |
| C65-V1-24 | 改一个数 → 一条 set，inverse 是原值 | 第 2 节「对象逐键递归」 |
| C65-V1-30 | 服务端整批原子：rev 不加、不广播、内容不变 | 第 2、3 节 |
| C65-V3-01 | `project.open` → `project.state { projectId, rev, project, writers }` | 第 3 节「打开」 |
| C65-V3-02 | `project.op.ok { opId, rev }`，rev 逐次加一 | 第 3 节「提交」 |
| C65-V3-03 | `project.ops` 发给除提交者外的订阅者；actor 取自连接，不认自报；`undoOf` 原样广播 | 第 3 节「提交」「写入身份」 |
| C65-V3-04 | 页面不带 expectRev，按到达顺序、后到的赢 | 第 3 节「期望版本」 |
| C65-V3-05 | **V3**：stale，`currentRev`、`since` 的 rev / actor / paths 与实际一致；被拒不广播、状态不变；重读后写成功 | 第 3 节、V3 |
| C65-V3-06 | too-large（300 KiB 拒，100 KiB 收） | 第 3 节 |
| C65-V3-07 | 文件存储 230 次提交后重启：rev、内容逐字节一致；日志按快照截断（≤ 200 行）；接着往上加 | 第 3 节「project 模块升级」 |
| C65-V4-01～05 | **V4 服务端**：10 分钟内别的写入身份覆盖 → 覆盖方 `ok.overwrote`、被覆盖方一条 `project.overwritten`；超过 10 分钟不通知；同身份不通知、同用户同设备不同页面算不同身份；不同片段不相干、`width`/`fps` 同归 `/meta`；根替换照样通知 | 第 3 节「覆盖通知」 |
| C65-V4-10 | **V4 页面侧**：被覆盖页面先备份自己那一版的实体、再应用新版本；覆盖方不备份 | 第 3 节末条 |
| C65-V2-01 | **V2**：两页各 200 次随机编辑交错提交，两页与文档服务三份逐字节相同 | 第 4 节、V2 |
| C65-V6-01 | **V6**：断线改 20 次，恢复后 20 条按序落地、版本号连续 | 第 6 节 |
| C65-V6-02 | 离线期间别人改过：第一条被拒、整批停下（待发 5 条、服务端不动）；「重放」后全部落地、最后写的赢 | 第 6 节 |
| C65-V6-03 | 同上，「丢弃」：本地回到服务端版本，丢弃前存本地备份，之后照常编辑 | 第 6 节、第 8 节裁定表 |
| C65-V7-01～02 | **V7**：有未确认操作时保存要等；写出的内容与 rev 与文档服务一致；无未确认时立即写 | 第 4 节 `.proc` |
| C65-V8-01 | **V8**：1000 片段项目改一个片段，diff 中位数 ≤ 5 ms（结构共享与整份深拷贝两种） | V8 |
| C65-V8-02 | **V8**：回环下一个页面改完到另一页面看到 ≤ 300 ms（去掉前 2 次预热，取最大值） | V8 |
| C65-V5-01 | **V5**：A 改 c1、c2（一步），B 改 c2，A 撤销：c1 回去、c2 保持 B 的，`skipped` 报 c2 与 B；撤销提交带 `undoOf` 指向 A 那一步、不碰 c2 | 第 8 节、V5 |
| C65-V5-02 | 全部没撤成：出栈、不进重做栈、不产生提交；再撤撤的是更早一步 | 第 8 节裁定表第 1 行 |
| C65-V5-03 | 同用户另一页面的改动不进我的栈；自己后来的改动不挡撤销 | 第 8 节「按写入身份分开」 |
| C65-V5-04 | 重做；新的本地操作清空重做栈 | 第 8 节「重做」 |
| C65-V5-05 | 数字框连续输入 300 ms 内合并成一步 | 第 8 节「栈上限」 |

没覆盖（不在本次清单或不能单进程验）：第 5 节 Agent 服务端副本（c65-agent）、第 7 节 `events` 模块（设计稿没给消息名与字段）、`project.follow` 退出跟踪、`forbidden`、项目分片发回、V9 回归。

## 假设的接口（集成时对账，只改 `c65-kit.mjs`）

| 编号 | 假设 |
|---|---|
| A1 | `server/docservice/json-ops.mjs` 导出 `applyOps(doc, ops)`：成功返回新文档（原地改后返回 undefined 或同一对象也认）；失败抛错且 `err.reason ?? err.code === 'bad-path'`，或返回 `{ ok: false, reason }` |
| A2 | `src/kernel/diffProject.ts` 导出 `diffProject(prev, next) → { ops, inverse }`，Node 能直接载入（见下「载入要求」） |
| A3 | 项目模块仍是 `server/docservice/modules/project.mjs` 的 `projectModule({ store, now })`，升级后接 `project.op`；存储沿用 `createMemoryStore` / `createFileStore({ dir })` |
| A4 | 回包按 `opId` 对应（`project.op.ok`、`project.op.rejected`）；`project.state` 按 `projectId` 对应；版本字段叫 `rev`（旧模块是 `projectRev`） |
| A5 | 覆盖通知的 `entity` 是字符串路径（`/tracks/@t1/clips/@c2`、`/meta`）；`by` 是 actor 对象，至少有 `userId`、`session` |
| A6 | 写入身份 = principal（`userId`、`deviceId`、`role`、`conversation`）+ 消息里的 `session`；测试的 `authenticate` 按 `?user=&dev=&role=&conv=` 给 principal |
| A7 | `src/store/docsync.ts` 导出 `createDocSync({ url, projectId, session, getProject, setProject, now, backup, onOfflineConflict })`，返回对象有 `open()`、`submit({ ops, inverse }, { coalesce? })`、`pendingCount()`、`connected`、`rev`、`resolveOffline('replay'｜'discard')`、`undo()` / `redo()` → `{ skipped: [{ entity, by }] }`、`canUndo()` / `canRedo()`、`saveWhenConfirmed(write(project, rev))`、`close()`；断线后自己重连。详细注释在 `createPage` 上面 |
| A8 | 文件存储下操作日志是 `<dir>/projects/<projectId>.ops.ndjson` |

**载入要求**（不是接口名，但实现必须满足，否则页面侧用例全部载入失败）：`diffProject.ts`、`docsync.ts` 要能被 Node 24 的类型剥离直接 `import`：相对导入写全 `.ts` / `.mjs` 后缀、不用路径别名、只用可擦除的 TS 语法（不用 enum、参数属性），不依赖 DOM（`WebSocket` 用 Node 全局的）。现有 `src/kernel/*.test.mjs` 就是这样载入 `.ts` 的。

## 设计稿歧义（测试的取舍）

1. **move 的 index**：按「挪完后的位置」（先删后插）理解并断言（V1-04）。另一种理解（挪之前的下标）会让 V1-04 第二条失败。建议设计稿写明。
2. **set 的父级是缺失的 `@id`**：没法「连同父级一起建」，应当 bad-path，但设计稿只说 set 会建缺的父级对象；未断言。
3. **remove 父级存在、目标不存在**；**insert 的 index 超过长度**：设计稿没说；未断言。参考实现按 bad-path 处理。
4. **没写过的项目 `project.state.project` 是什么**（null？）以及 **`writers` 的形状**：只断言字段存在、rev 为 0。
5. **根替换覆盖了哪些实体**：只断言「内容改到的 c1」在 `overwrote` 里。
6. **too-large 按整条消息还是 ops 计**：用 300 KiB / 100 KiB 两端避开边界。
7. **离线队列是否合并**：按第 6 节「按顺序」理解为每次编辑一条提交，V6-01 断言 20 条、版本号连续。
8. **全部没撤成时不产生提交**：设计稿没明说，V5-02 断言 rev 不变（按常理推出，有异议可删这一句）。
9. **数字框合并**的 300 ms 是「相邻两次间隔」还是「从第一次起的窗口」：用例的间隔两种理解结果相同；合并怎么告诉 docsync 设计稿没写，假设 `submit(..., { coalesce: key })` + 注入的 `now`。
10. **覆盖备份的时序**：页面要在应用新版本前备份，所以服务端给被覆盖方发 `project.overwritten` 应早于同一次提交的 `project.ops`，或页面自己处理两者的先后。V4-10 只断言备份内容是原来那一版。
11. **V8 差异 ≤ 5 ms** 没说 next 与 prev 是否结构共享；V8-01 两种都要求，比设计稿严一点。
12. **快照截断**：230 次提交后日志 ≤ 200 行，是「每 200 次落盘、日志截断到快照之后」的直接推论。

## 对现有测试的影响（集成时注意）

`server/test/docservice-project.test.mjs`（C6.3 的 P1～P7）断言旧的 `project.state { projectRev, digest, at }` 与 `project.announce`。设计稿第 3 节把 `project.state` 改成 `{ projectId, rev, project, writers }`，与 P1、P2、P4、P6 冲突；旧的 announce / 快照消息是否保留，设计稿没说。需要集成时定：要么升级后仍兼容旧字段，要么改旧测试。

## 验证

- `node --check` 五个文件，退出码全 0。
- 对现在的分支（没有实现）跑 `node --test server/test/c65-*.test.mjs`：42 条，0 过、42 败，36 s；失败原因是 `json-ops.mjs`、`diffProject.ts`、`docsync.ts` 找不到，或旧项目模块不认 `project.op`（等回包 3 s 超时）。这是预期的。
- **测试自身的正确性**：在 scratchpad 里按设计稿写了一套最小参考实现（JSON 引擎、diffProject、项目模块、docsync），临时拷进 worktree 跑，四个文件 **42/42 全过**（ops 16、docservice 13、sync 8、undo 5），跑完删掉、`git checkout` 恢复项目模块，**没有提交**。另做两处变异检查：
  - V2 的交错确实发生：一次运行里 181 次「收到别人操作时本地有未确认操作」、3 次 bad-path 拒绝；
  - 把 docsync 改成「收到别人的操作直接打到本地、不按确认版本重放」后，V2 失败（三份不相等）。
- 没跑全量测试（只加测试文件，不动实现；全量里的 c65 用例在实现合入前必然失败）。

## 需要主会话决定

- 集成时按上面 A1～A8 对账，改 `c65-kit.mjs`；歧义 1、2、3、7、8 建议写回设计稿。
- 旧的 `docservice-project.test.mjs` 怎么处理（见上）。
