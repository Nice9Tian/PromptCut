# AGENT-draft-lock：换草稿时误放刚抢到的草稿锁

分支 `claude/draft-lock`（自 main f119a66d），worktree `.worktrees/draft-lock`。
状态：修复与测试完成，待主会话审查。

## 根因复核

主会话的判断成立，根因在前端，不在 `/api/skill-lock` 服务端，也不在 Rust 外壳。

- `src/StartPage.tsx` 的 `open(id)` 和 `src/Shell.tsx` 的 `?draft=` 路径，顺序都是先 `await openDraft(id)`，再 `setActiveDraftId(id)`。
- `openDraft` → `acquireDraftLock(id)`：先放掉旧锁，再抢到 `id`，于是 `procLock.ts` 里 `heldDraftId = id`。
- `setActiveDraftId(id)`（`src/editor/io/drafts.ts`）：`if (activeDraftId && activeDraftId !== id) void releaseDraftLock();`。`releaseDraftLock()` 不带参数，放的是**当前持有的那把**，也就是刚抢到的 `id`。外壳先松句柄，Node 那边再删 `.proc.lock`。这和现场看到的一致：锁文件建了又删，目录修改时间变过。
- 触发条件是 `activeDraftId` 不为空。这很常见：`startNew` 会设成 `newDraftId()`，`goHome` 不清它。本次启动后第一个打开的草稿不受影响，因为那时 `activeDraftId` 还是 null。

测试复现了这一点：修复前，「startNew 后开 D」「开 A 再开 B」「?draft= 路径」三例里 `lockedDraftId()` 都是 null，并且对新草稿发出了 release。

## 测试先红后绿

新文件 `src/editor/io/draftLock.test.mjs`，写法照 `src/editor/demote.test.mjs`：用 `registerTs.mjs` 解析 ts，`mock.module` 替换 `proc.ts` 和 `store/project.ts`，`fetch` 是假的 `/api/skill-lock` 账本，`window.__TAURI__.core.invoke` 也是假的，用来记录外壳那层的锁。不起服务。

跑法：`node --experimental-test-module-mocks --test src/editor/io/draftLock.test.mjs`

修复前（提交 66fc77a5），退出码 1，7 例中 4 过 3 败：

```
✖ startNew 设过 activeDraftId → 开草稿 D:D 的锁仍被持有      (actual: null, expected: 'D')
✖ 开 A → 开 B:B 持有,A 已放                                   (actual: null, expected: 'B')
✖ Shell 的 ?draft= 路径(openDraft 再 setActiveDraftId),之前有 activeDraftId 也保住锁 (actual: null, expected: 'S')
✔ 同一份草稿打开两次:不出错,锁一直在,只抢了一次
✔ 开着 A 时新建项目 / 从文件打开(设成 null):A 的锁放掉
✔ 开着 A 时 startNew(设成新 id):A 的锁放掉
✔ 没开过草稿时设 null / 新 id:不发多余的 release
ℹ tests 7  pass 4  fail 3
```

修复后（提交 20388365），退出码 0：`ℹ tests 7  pass 7  fail 0`。

## 改动

- `src/editor/io/procLock.ts`：`releaseDraftLock(onlyId?: string)`。给了 `onlyId`、但当前持有的不是它时，直接返回。这个判断在第一个 await 之前同步做完，不受异步放锁的时序影响。不带参数时行为不变（`openDraft` 读取失败时的回滚仍用它）。
- `src/editor/io/drafts.ts`：`setActiveDraftId` 改成 `releaseDraftLock(activeDraftId)`，只放上一份。

没有改服务端协议，没有改 `desktop/src-tauri/src/proc_lock.rs`，也没有改任何调用点。

## 调用路径逐条核对

| 路径 | 做什么 | 修复后 |
|---|---|---|
| `StartPage.open(id)` | openDraft(id) → setActiveDraftId(id) | 新锁保住。上一份由 acquireDraftLock 自己先放掉；setActiveDraftId 带的是旧 id，已经不在手里，所以什么都不做。测试 1、2 覆盖 |
| 同一份开两次 | acquire 见 `heldDraftId === id` 直接返回；setActiveDraftId 里 `activeDraftId === id`，不放 | 不出错，锁不掉。测试 4 覆盖 |
| `Shell` 的 `?draft=` | openDraft → setActiveDraftId | 同 open。测试 3 覆盖 |
| `StartPage.startNew` | setActiveDraftId(newDraftId()) | 手里的是上一份（等于 activeDraftId）→ 放掉。测试 6 覆盖 |
| `TopBar.createProject` | setActiveDraftId(null) | 手里的是 activeDraftId → 放掉。测试 5 覆盖 |
| `openProcPath`（`openPath.ts`） | setActiveDraftId(null) | 同上，放掉 |
| `TopBar.openProjectFile`（.proc / 旧 JSON） | setActiveDraftId(null) | 同上，放掉 |
| procp 导入（`openProjectFile` 的 .procp 分支、`StartPage.openFile`） | setActiveDraftId(null) | 同上，放掉 |
| `JoinForm` 加入共享项目、`Shell` 恢复共享项目 | setActiveDraftId(null) | 同上，放掉 |
| `TopBar.goHome` / syncManager 的 `pc-go-home` | 只派发事件，不碰 activeDraftId，也不放锁 | 没有改，见下节 |

前提是「手里的锁就是 activeDraftId」。现有代码里只有两处会打破它，修复前后都一样，没有变坏：

- 开 B 时抢锁失败（被别的实例占着）：`acquireDraftLock` 已经先把 A 放了，但用户留在开始页，activeDraftId 仍是 A。
- 开 B 时抢到锁、读文件失败：B 被回滚放掉，A 也已经放了。

这两种情况下 store 里那份 A 都没有锁。不过用户此刻在开始页，回不到 A 的编辑器，只能重新点开 A，那时会重新抢锁，所以实际影响不大。

## goHome 的现状与建议

现状：回首页不放锁。`procLock.ts` 注释写着回首页也要放，但代码没做。所以回到开始页之后，刚才那份草稿仍锁在本窗口：另一个实例打不开，本窗口再点开它不受影响（`heldDraftId === id`）。

建议由主会话定。我倾向于在 Shell 的 `pc-go-home` 处理里（`back`）调用 `setActiveDraftId(null)`，它会顺带放掉上一份的锁：

- 好处：和注释、和「一个窗口同一时刻只编辑一个项目」一致；开始页上不编辑任何项目，不该占着锁。
- 代价：回首页后再点开同一份草稿，要重新抢一次锁，读一遍文件，这本来就是开始页「打开」的行为。另外 store 里还留着那个项目；如果以后有「回到编辑器」这类不重新打开的入口，就得先抢锁。目前没有这个入口。
- 放在 Shell 的 `back` 里，而不是 TopBar 的 `goHome` 里：syncManager 也会派发 `pc-go-home`（共享项目被踢出时），一处就能接住两条路径。
- 这一项会改用户可见的行为（另一个实例在本窗口回首页后能打开该草稿），按二级办，所以这次没有动。

## 验证

- worktree 根目录 `npx tsc --noEmit`：退出码 0，无输出。
- `node --experimental-test-module-mocks --test src/editor/io/draftLock.test.mjs`：修复前退出码 1（4/7），修复后退出码 0（7/7）。仓库里没有别的测试引用 `drafts.ts` 或 `procLock.ts`。
- 按任务书，没有跑整套 `npm test`，也没有做真机复核，留给主会话在集成分支上做。

## 没做的与旁注

- goHome 放锁：见上节，待主会话定。
- 预先存在、这次没动的小时序：`setActiveDraftId` 里的放锁不 await。如果马上又抢同一份（例如开着 A 时 startNew，紧接着回首页再开 A），release 和 acquire 两个请求可能乱序到达服务端，把刚抢到的锁删掉。现实中要在几毫秒内完成两次界面操作，概率很低；要彻底修，可以让 procLock 内部把 acquire 串在未完成的 release 之后。
