# AGENT 报告：c65-tests2（C6.5 第二批契约测试）

分支 `claude/c65-tests2`（起点 `claude/c65` 的 `806503d`），worktree `.worktrees/c65-tests2`。

测试方是对抗式的：只照下列文档写，没看 `.worktrees/c65-agent`、`.worktrees/c65-editor`。
- `docs/plan/c65-design.md` 第 5、7、8、9、13 节，第 11 节 V3、V5、V7；
- `c65-undo-draft.md`、`c65-ux-draft.md`；
- `auth-contract.md` 第 7 节；
- `cloud-task.md` 的 D1、D2、D4。

已合入的接口照现状用：文档服务的 project、content、events 模块，`DocSync`，`c65-kit.mjs`，`auth-kit.mjs`。

状态：写完并已提交，没推送、没合并。

## 1. 交付

| 文件 | 内容 |
|---|---|
| `server/test/c65b-kit.mjs` | 公共件。设计稿没写死的接口都集中在这里，编号是假设 B1～B9（第 3 节） |
| `server/test/c65b-agent.test.mjs` | C65B-D1-01～07（D1、D4）、C65B-D2-01～05（D2，以及 AI 栏「撤销这一步」） |
| `server/test/c65b-undo.test.mjs` | C65B-U-01～06（用户侧撤销与重做、快捷键、文案）、C65B-V7-01（页面侧 `.proc`） |
| `server/test/c65b-creator.test.mjs` | C65B-A-01～03（`set-creator-password`） |

提交：`fc0b7bd`（报告开工）、`699dbcd`（测试）、本报告的提交。

## 2. 编号对应

| 编号 | 依据 | 断言 |
|---|---|---|
| C65B-D1-01 | 第 5 节、D1 | 没有页面在线时，写工具照样成功。服务端内容已改，rev 加 1（一次调用对应一次提交）。广播里的 `actor.role` 是 `agent`，`actor.conversation` 是对话号，`userId` 取自连接。写工具不走页面那条路 |
| C65B-D1-02 | 第 5 节、V3 | 读工具回包的 `rev` 等于服务端版本。页面随后改了 c1，Agent 再写 c1 时工具回错，错误里带实体（c1）和改动者（bob），这次写不落地。Agent 重读后 rev 是新的、内容跟上，再写成功 |
| C65B-D1-03 | 第 5 节「读后写一致」 | 写成功后以 ok 的 rev 为准，紧接着再写不会被自己上一次提交挡住；读工具回包的 rev 是最新的 |
| C65B-D1-04 | 第 5 节「副本随 project.ops 保持最新」 | 页面改了 c2，Agent 再读能看到，rev 同步 |
| C65B-D1-05 | 第 5 节「每个对话一个对话号」 | 对话 3、对话 5 各自按自己最后读到的版本作 `expectRev`。5 先写之后 3 再写，回 stale；3 重读后写成功。两次广播的 `actor` 分别带 5 和 3 |
| C65B-D1-06 | 第 5 节、D1 判据、D4 | 每个工具都标了 `side`。写工具（add/update/remove_clip、set_project_meta、set_rect、add_track、create_filter）和 `get_project`、`get_layout` 在 Agent 服务端；`get_selection`、`seek`、`play`、`pause`、`web_handoff` 留在页面 |
| C65B-D1-07 | 第 5 节 | `get_selection`、`seek` 经页面那条路（`callPage`）执行，不产生提交 |
| C65B-D2-01 | 第 7 节、D2 | 每个工具调用产生两条事件，先创建后完成，读工具也一样。创建事件带参数摘要（`args`）和目标（`target` 含 c1）；完成事件带 `status: 'ok'` 和 `durationMs`；两条的 `actor` 都是 agent 加对话号。`event-detail` 里是完整参数 |
| C65B-D2-02 | 任务书「事件带 opId 与 inverse」 | 写工具事件里的 `opId` 就是广播里那次提交的 `opId`。`inverse` 落在当前版本上能把片段还原。只读工具不带 `opId` / `inverse`，对应 AI 栏不显示「撤销这步」。被拒的写：完成事件是 `error`，不带 `opId` |
| C65B-D2-03 | 第 8 节裁定（AI 栏撤销算用户的写入） | Agent 的改动不进页面的撤销栈。按事件撤销后实体恢复；广播带 `undoOf = Agent 的 opId`，`actor.role` 是 `page`，session 是这个页面会话。这一步进了用户的撤销栈，Ctrl+Z（`undo()`）会把 Agent 的改动恢复回来。之后 Agent 拿旧版本写回错（undo 稿第 4 节「对 Agent 的影响」） |
| C65B-D2-04 | 第 8 节「撤销前查冲突」 | Agent 改了 name 与 fps，bob 随后改了 fps。撤销这一步：name 撤回，fps 保留 bob 的值；`skipped` 只有 `/meta/fps`，并写明是 bob 改的 |
| C65B-D2-05 | undo 稿第 4 节「不是最新的一步也能点」 | 撤 Agent 的第一步只动 c1，第二步改的 c2 不受影响 |
| C65B-U-01 | 第 8 节、undo 稿第 2 节 | 部分没撤：`done: true`。`skipped` 列出 3 处，身份能分清：Agent 对话（role 为 agent、对话号 7）、别的成员（bob）、你在另一个页面（userId 相同、session 不同）。只撤了没被别人改过的 c4 |
| C65B-U-02 | 第 8 节裁定、第 13 节 | 全部没撤：`done: false`，列表照样带实体和改动者。这一步出栈、不进重做栈，也不产生提交（rev 不变） |
| C65B-U-03 | 第 8 节「重做同理」 | 部分没重做：返回没重做的实体和改动者，其余照做。全部没重做：这一步不进撤销栈，也出了重做栈，不产生提交 |
| C65B-U-04 | undo 稿第 1 节 | Ctrl+Z 是撤销；Ctrl+Shift+Z、Ctrl+Y 是重做，Cmd 同理；不按修饰键时不算；焦点在 INPUT、TEXTAREA、contentEditable 里时交给输入框 |
| C65B-U-05 | 同上 | 在页面上，Ctrl+Y 与 Ctrl+Shift+Z 都能重做刚撤销的那一步，结果相同 |
| C65B-U-06 | undo 稿文案表 4～9，第 2 节折叠规则 | 四种标题逐字核对。每行包含实体名、改动者和「修改」。恰好 3 处全列出；多于 3 处列前 2 行，再加一行「等 X 处」「点击展开」。全撤成了不弹提示（回 null） |
| C65B-V7-01 | 第 4 节、V7 页面侧 | 用 store、`bindStore(DocSync)` 和内存文档服务假件（`MemDocService`）驱动。有未确认的操作时，`.proc` 不写；确认后才写，写出的 name、tracks 与文档服务这一版相同；如果带了 rev，就是确认的版本 |
| C65B-A-01 | 第 9 节裁定、auth-contract 第 7 节 | 自由进入的项目上，带旧的创建者证明改密码成功。改完后旧密码以 creator 身份进不来（401），新密码进得来（101），项目密码不受影响。之后的创建者操作按旧密码算证明被拒（forbidden），按新密码算就能过 |
| C65B-A-02 | auth-contract 第 7 节 | 以下四种都回 forbidden，且改动不生效：成员按自己的口令算证明、成员不带证明、创建者连接不带证明、证明错 |
| C65B-A-03 | 第 9 节裁定 | 限定进入的项目上同样能改；名单里的成员不受影响 |

## 3. 假设的接口（集成时对账只改 `c65b-kit.mjs`）

| 编号 | 假设 | 为什么要假设 |
|---|---|---|
| B1 | Agent 服务端的项目副本有一个 Node 下能直接驱动的工厂。<br>候选模块：`server/agent-replica.mjs`、`server/agent/replica.mjs`、`server/agent-project.mjs`、`server/agent-docsync.mjs`。<br>候选导出：`createAgentReplica`、`createAgentProject`、`createAgentSide`。<br>参数：`{ projectId, url(conversation), loadModule(spec), callPage(tool,args), now }`；返回的对象有 `open()`、`callTool(name,args,{conversation})`、`close()`。<br>工具结果可以是 throw、`{isError}`、`{ok:false}`，也可以是 MCP 的 `{content:[{type:'text'}]}`，统一规整成 `{ ok, value, text }` | 设计稿只说「用 `ssrLoadModule` 载入 handlers、在服务端起副本」，没写入口。vite 的 `ssrLoadModule` 由测试注入的 `loadModule` 代替 |
| B2 | `mcp-tools.mjs` 的 `side` 分两类：页面侧是 `'browser'`（现有值）或 `'page'`；Agent 侧是 `'server'`（现有值）、`'agent'` 或 `'docservice'` | 设计稿只说「逐条标 side」 |
| B3 | 写工具事件带 `opId`、`inverse`（以及 `rev`，可选）。<br>查找顺序：完成事件 → 创建事件 → `event-detail`。另认 `undo:{opId,inverse}`，以及 `opIds` 取最后一个 | 设计稿第 7 节只列了工具名、图标、目标、摘要、状态、耗时。「带 opId 与 inverse」来自任务书 |
| B4 | AI 栏「撤销这一步」是 `DocSync` 的方法，候选名 `undoForeign`、`undoStep`、`undoAgentStep`、`undoOp`、`revertOp`；也可以是 `docsync.ts` 导出的同名函数 `(ds, info)`。<br>参数 `{ opId, inverse, rev? }`，返回的 `UndoResult` 与 `undo()` 相同 | 设计稿没写页面侧的入口 |
| B5 | 快捷键判定是纯函数。<br>候选模块：`src/editor/undoKeys.ts`、`shortcuts.ts`、`keymap.ts`、`undoShortcut.ts`。<br>候选导出：`undoRedoKey`、`undoRedoAction`、`shortcutAction`、`matchUndoRedo`。<br>输入 KeyboardEvent 形状的对象，返回 `'undo' \| 'redo' \| null` | 现在的判定写在 `Editor.tsx` 的 keydown 里，Node 下没法直接驱动 |
| B6 | `shared.admin { op: 'set-creator-password', creator: { salt, key }, proof }`，证明按旧的创建者 K 算 | 设计稿只给了 op 名 |
| B7 | `proc.ts` 导出「等确认后序列化」的函数，候选 `serializeProcConfirmed`、`serializeProcWhenConfirmed`、`procWhenConfirmed`。<br>也可以不导出，改由 `core.ts` 的同步挂钩多一个 `whenSettled()`，等它完成后调 `serializeProc()` | 设计稿只写了行为 |
| B8 | 提示条文案是纯函数。<br>候选模块：`src/editor/undoNotice.ts`、`undoFeedback.ts`、`src/store/undoNotice.ts`。<br>签名 `(result, { redo, nameOf, whoOf }) → null \| { title, lines }` | undo 稿只给了文案 |
| B9 | 测试里的身份按查询串 `?user=&dev=&role=&conv=` 给出，principal 为 `{ userId: 'user@dev', deviceId, role, conversation }`，与 `docservice-events.test.mjs` 相同 | 只是测试夹具 |

## 4. 验证

```
node --check server/test/c65b-{kit,agent,undo,creator}*.mjs          → 4 个文件 exit=0
node --test --test-concurrency=1 server/test/c65b-*.test.mjs         → exit=1
ℹ tests 22   ℹ pass 3   ℹ fail 19
```

- **现在就通过的**：C65B-U-01～03。它们只依赖已合入的 `DocSync` 和真文档服务，说明第一批的撤销实现已经能区分 Agent 对话、别的成员和另一个页面，重做一侧也符合第 8 节。
- **按预期失败的**：失败都出在新接口还不存在。
  - B1 找不到工厂：D1-01～05、D1-07、D2-01～05，共 11 条。
  - `side` 仍全是 `'browser'`：D1-06。
  - B5 找不到：U-04、U-05。
  - B8 找不到：U-06。
  - B7 找不到：V7-01。
  - 服务端回 `bad-message`（op 只能是 set-password / set-list / kick / unban / delete）：A-01～03。
- **用例自洽的自检**（没提交）：我在 scratchpad 写了一个按设计稿行为的最小假 Agent 副本（`fake-agent-replica.mjs`），临时放到 `server/agent-replica.mjs`。同时临时改了两处：让 events 模块的 complete 广播透传 `opId` / `inverse` / `rev`，给 `bindStore` 的挂钩加 `whenSettled`。又临时加了 B5、B8 的两个小实现。在这些条件下：
  - agent 文件 12 条过 11 条，剩下的是 D1-06，因为 `side` 没改；
  - undo 文件 7 条全过。
  - 这一轮还查出假件自己的两个问题：没按 ok 更新副本，AI 栏撤销进错了栈。测试本身没问题。
  - 临时改动已全部还原，`git status` 干净，只多了本分支的 4 个测试文件。

## 5. 歧义与对任务书 / 设计稿的更正建议

1. **opId / inverse 放在哪。** 已合入的 `events.mjs` 的 `events.complete` 只广播 `status`、`summary`、`durationMs`，不透传别的字段；`event-detail` 又是在创建时写的，那时还没有提交。要让页面拿到 `opId` 和 `inverse`，`c65-agent` 必须二选一：扩展 events 模块，让完成事件带上这两项（我的 B3 首选）；或者在完成时再写一次 detail。建议主会话定下来，写进第 7 节。
2. **AI 栏撤销的冲突判定以谁为「别的写入身份」。** 我只测了没有争议的情形：冲突方是第三人 bob，既不是这个页面，也不是那个 Agent 对话。如果是用户自己这个页面后来改过同一实体，算不算冲突，设计稿没写。
3. **stale 的粒度。** 我只测了「页面改了同一实体」时 Agent 回 stale（D1-02）。按第 3 节原文，版本号不符就 stale，不看实体；D1-05 里两个对话改的是同一实体，也符合这一点。实现如果按实体放行，这两条都不受影响，但第 3 节的原文就要改。
4. **写成功后的 expectRev**（D1-03）。我按「副本以 ok 的 rev 为准」理解：写成功后，这个对话的读版本随之前进，下一次写不需要先重读。第 5 节只说了「最后一次读到的版本」，建议写明写成功也算一次读到。
5. **since 摘要的格式。** 设计稿只说「谁、改了哪些实体」。D1-02 只断言错误全文里出现了实体（c1）和改动者的用户名（bob），没断言字段名。
6. **每个工具调用都发事件。** D2-01 断言读工具 `get_project` 也发两条，这是按 D2「每个工具调用两条」的字面理解。如果只打算给写工具发，需要改设计稿原文。
7. **`set-creator-password` 的适用模式。** 我断言两种模式都能用（A-03）。第 9 节说它「算改项目密码的一部分」，而 `set-password` 只用于自由进入；创建者密码在两种模式下都存在，所以按都能用理解。另外两件事设计稿没写，我都没断言：改完后已发的票据是否作废（generation 要不要加一），创建者在线的连接要不要断开。
8. **折叠行「等 X 处」里的 X。** 可以理解为剩余数（总数减 2），也可以理解为总数，U-06 两种都接受。建议文案表写明。
9. **D4 的 `get_layout` 只断言了 `side`。** 真执行要用预渲染进程，单进程测不了；页面侧的实体框也不在本批范围。
10. **V7 用的是内存假件。** 页面侧 `.proc` 用 `MemDocService` 驱动，因为它能精确控制 ok 什么时候到达。真文档服务上的同一行为，第一批已有 C65-V7-01、C65-V7-02。

## 6. 需要主会话决定

- 合并本分支。注意：并入 `claude/c65` 后，`npm test` 在 `c65-agent`、`c65-editor` 集成之前会有 19 条失败。可以等集成时一起合，也可以先合、集成时再对账 B1～B8。
- 上面第 5 节第 1、2、4、6、7 条建议写进设计稿。
