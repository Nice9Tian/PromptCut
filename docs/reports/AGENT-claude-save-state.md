# AGENT 报告：claude/save-state（保存与修改状态检查）

分支 `claude/save-state`，worktree `.worktrees/save-state`，从 main `99876120` 切出。端口段 5960～5969。

任务：把 `product/document-service.md`「保存与延迟退出的修改处理」第一条、`mechanism/document-service.md`「保存基准与修改状态检查」第一条（保存时暂停前台编辑、等本机写完、失败不覆盖旧保存并恢复编辑）做到语义写的程度。只对桌面版保存 `.proc` / `.procp` 有意义；在线页面的 `saveProject` 是空函数，不动。

## 块一：保存时暂停前台编辑（提交 4ee26602、694ad620、b344b14d）

**做法**

- 先把顶栏 `saveProject` / `savePackedProject` 的流程原样搬进 `src/editor/io/saveFlow.ts`（4ee26602，行为不变），好在 node 里测；顶栏只拼依赖。
- 新文件 `src/editor/saveLock.ts`：保存锁。挑好落点之后上锁（「另存为」要用户手势，挑落点必须是点击后的第一个 await；用户在那个对话框里点取消不算保存、不上锁），到保存结束解锁——成功、等本机写入超时、写盘失败都解锁，`saveFlow.ts` 在 `finally` 里解。
- **怎么拦**：模块载入时在 `window` 的**捕获阶段**挂一组监听，上锁期间对用户输入事件 `preventDefault` + `stopImmediatePropagation`。`window` 捕获是事件路径的第一站，编辑器自己挂在 `window` / `document` / 元素上的处理函数一个都收不到。拦的事件：`keydown keypress beforeinput input compositionstart pointerdown mousedown touchstart click dblclick auxclick contextmenu wheel dragstart dragenter dragover drop paste cut`，外加桌面版标题栏菜单发给顶栏的自定义事件 `pc-titlebar-command`（撤销、重做、新建、打开都走它）。抬手类事件（pointerup、mouseup、keyup、dragend）放行，锁上之前开始的拖动能正常收尾。上锁时先让焦点元素失焦，输入框里已经打完的字在失焦时提交，赶在保存之前落地。
- 这是从输入源头掐断，不是把按钮置灰：快捷键（Delete、Ctrl+Z）、标题栏菜单、鼠标、拖放、剪贴板、Agent 面板里打字回车都到不了改项目那一步。
- **范围**按机制文档那一句只拦「当前设备的前台编辑」。本机 Agent 正在跑的工具调用、素材入库、后台任务是「本机写入」，保存要等它们写完（块二），不拦；别的设备、云端的修改也不拦（语义：「不要求整个云端长期停写」）。
- 保存进行中再点一次保存：不另起一次（`saveFlow` 回 `busy`）。
- 界面：新文件 `src/editor/SaveStatusLayer.tsx`，挂在顶栏里。保存中整页盖一层半透明罩子，中间一张卡写「正在保存项目… 保存完成前暂时不能编辑。」和当前这一步（正在检查本机的修改 / 先等本机这些写入完成：… / 正在写入文件…）。保存的结果（没保存成的原因、保存成了但要说的话）改成顶部一张不挡操作的卡片，「知道了」或 Esc 收起；原来是 `alert`。

**「算完了」的判据**：`saveFlow` 的 `finally` 一定执行 `lock.end()`；锁的状态在 `getSaveLockState()`，界面跟它走。

**改前红、改后绿**

node 单测 `src/editor/saveLock.test.mjs`（node 里没有 DOM，拿 `EventTarget` 当 `window`，编辑器各处的输入处理用同类监听模拟）。改前（只有 4ee26602 的搬家，没有锁）：

```
✖ 保存进行中:快捷键撤销、Delete、拖放、鼠标、粘贴、Agent 面板回车都改不动项目
✖ 被拦下的输入事件取消了缺省动作(浏览器不会再去打字、粘贴、放下文件)
✔ 保存成功结束后恢复编辑:同样的快捷键又能改了
✖ 等确认超时(不写文件)之后恢复编辑
✔ 写盘失败之后恢复编辑
✔ 用户在「另存为」里点取消:整个过程不上锁
✖ 打包保存同样上锁,挑好落点之后到写完之间改不动
✖ 保存进行中再点一次保存:不另起一次
ℹ tests 8 / pass 3 / fail 5
```

（三条「恢复编辑」在改前是平凡地过：改前从来不上锁。改前那次跑的测试文件还没有「标题栏菜单撤销」那一条断言，是后补的。）改后：`ℹ tests 8 / pass 8 / fail 0`。

真页面探针 `scripts/probes/save-state-probe.mjs --phases lock`（5960 端口的编辑器，「另存为」换成页面私有文件系统 OPFS 里的真文件，写盘那一步由探针扣住）。改前（把 `TopBar.tsx`、`saveFlow.ts` 临时换回 4ee26602 的版本跑，跑完换回）：

```
lock.overlay-shown        ✖ overlay null
lock.blocked.deleteKey    ✖ 保存中按 Delete 删掉了一个片段（clips 10 → 9）
lock.blocked.ctrlZ        ✖ Ctrl+Z 把它撤回来了（project 换了对象）
lock.blocked.titlebarUndo ✖ 标题栏「撤销」把探针加的序列撤掉了（tracks 3 → 2）
lock.blocked.clickName    ✖ 点项目名进了改名
lock.blocked.drop / pasteWheel ✖（前几条已经改了项目）
lock.blocked.agentPanel   ✖ Agent 输入框里打进了「把标题改成 X」
lock.marked-saved         ✔ dirty=false —— 但文件里是 3 条序列，项目此时已是 2 条：改前会把保存期间的修改错标成「已保存」
summary 12 项过 4
```

改后：`summary 12 项过 12`，保存中七条路（Delete、Ctrl+Z、标题栏撤销、点项目名、拖放、粘贴与滚轮、Agent 面板打字）项目对象一次都没换，放行后文件写成、内容是保存那一刻的项目，保存后 Delete 又能删（clips 10 → 9）。

拖放那条在真页面上改前也没导进素材（往时间轴派发的 png 拖放，改前改后素材数都是 0），所以真页面上拖放这条不算红绿证据；拖放被拦的证据是 node 单测和 `defaultPrevented`。

截图：`out/save-state-shots/1-saving.png`（保存中：罩子与「正在保存项目… 正在写入文件…」），`out/save-state-shots/2-after-save.png`（保存后）。

## 块二：等本机写完（提交 2bba5190）

**做法**：新文件 `src/editor/io/localWrites.ts` 的 `waitForLocalWrites`，`saveFlow` 在上锁之后、序列化之前调它；总时限 `LOCAL_WRITES_TIMEOUT_MS = 10 秒`（沿用原来等文档服务确认的 10 秒，现在是几样合起来的总时限）。等的时候「正在保存」那层列出正在等哪几样。

「写完」的口径：**已经开始、还没落地的本机写入都落地了**，不是等将来会写项目的任务全跑完。转写、声音生成这类要跑几分钟、最后一次性写回的任务，写回之前项目里没有它的半截东西，保存不等它；它写回之后项目重新变脏，下次保存带上。（这一条是我对语义的理解，见文末「要改的语义」。）

| 机制文档列的一样 | 「算完了」的判据 | 超时（总时限 10 秒）的行为 |
|---|---|---|
| 待提交操作 | 文档服务确认了本页面发出的全部修改、恢复日志落盘（原有的 `whenSaved`）。没接文档服务时本地修改同步落进 store，没有在路上的 | 不写文件，提示沿用原来那句「还有修改没等到文档服务确认……这次没有保存」 |
| 素材入库/上传 | 当前项目里没有「这台设备正在导入」的素材：`pending: true` 且这台设备手里有它的文件（`getMediaFile`）。别的设备正在传的素材也是 pending，但不是本机写入，不等 | 不写文件，提示「还有本机的写入没完成：正在导入的素材（N 个）。原来的文件没有改动，等它们完成后再保存。」 |
| 本机 Agent | 没有 Agent 让页面执行的工具正在跑（`userEditing.ts` 新加的 `agentToolRunning()`，mcpExecutor 和云端 Agent 都用 `beginAgentTool/endAgentTool` 包着工具执行） | 同上，「Agent 正在执行的修改」 |
| 后台写入 | 最近 300 毫秒没有本页面自己的修改落地（`onLocalCommit`）。前台这时已被拦住，还在落地的只能是后台任务、Agent、上锁前开始的输入收尾；等它们停下来，不必一个个去认（卡片配音、自动成片、镜头/主体识别各自的任务表都是私有的，不在我的文件范围里） | 同上，「后台任务正在写入项目」 |
| 渲染 | 预渲染快照随文件存：写盘前向渲染这边要一次已完成的快照（`proc.ts` 新的 `collectFrameSnapshots`，时限 2.5 秒，原有） | **这一样不按「不写文件」办**：快照是可以丢的缓存（原代码注释「Missing/corrupt caches must never prevent saving the project」），项目内容完整，所以照存，但不再静默——标 `snapshotsSkipped`，顶部提示「预渲染快照这次没来得及收进文件……重新打开后会重新预渲染」。要改成「不写文件」只动 `saveFlow.ts` 一处，请定 |

另外两处：

- 等文档服务确认放在最后一步；确认期间又有本页面的修改落地，就再来一轮。
- **序列化之后项目又被本机改了**（写盘那几秒 Agent 或后台任务落了一笔）：文件照存（内容是保存开始那一刻的），但**不标「已保存」**，顶部提示「之后的修改还没保存」。改前会把这种情况标成已保存（块一的真页面红跑里就出现了：文件 3 条序列、项目 2 条、dirty=false）。

**改前红、改后绿**

node 单测 `src/editor/io/localWrites.test.mjs`，改前（`saveFlow.ts` 用 694ad620 的版本，即块一做完、块二没做）：

```
✖ 本机 Agent 的工具还在跑:保存等它写完再序列化,文件里有它最后那一笔
✖ 这台设备正在导入的素材:等它传完;别的设备在传的(本机没有文件)不等
✖ 后台任务连着写:等它停下来(一段时间没有新的落地)再序列化
✖ Agent 一直没写完:到时限不写文件,说清楚在等 Agent;之后恢复编辑
✖ 素材一直没导完:到时限不写文件,提示里有件数
✔ 待文档服务确认的修改等不到:不写文件,沿用原来的说法      ← 原有行为
✖ 序列化之后项目又被本机改了(写盘期间 Agent 落了一笔):文件照存,但不标「已保存」,并告诉用户
✔ 缺省的探测:Agent 工具在跑时 agentToolProbe 记 1;本机正在导入的素材才算  ← 新模块自身的单测
ℹ tests 8 / pass 2 / fail 6
```

改后 `ℹ tests 8 / pass 8 / fail 0`。

`src/editor/io/procWrite.test.mjs`（预渲染快照，`frameClient` 用 `mock.module` 换掉），改前（`proc.ts`、`saveFlow.ts` 用 694ad620 的版本）：`✔ 快照收到了` / `✖ 快照等到时限没收到…（AssertionError: 结果里标出这次没带快照）`，`pass 1 / fail 1`；改后 `pass 2 / fail 0`。

真页面探针 `--phases timeout`：先正常存一版当「上次有效保存」，再让一个 Agent 工具调用开始且不结束（调编辑器自己那份 `userEditing.ts` 实例的 `beginAgentTool`），点保存。改前（`TopBar.tsx`、`saveFlow.ts`、`proc.ts` 换回 694ad620）：

```
timeout.waiting-shown          ✖ 没有等待
timeout.blocked-while-waiting  ✖ 保存时 Ctrl+Z 撤掉了刚加的序列
timeout.notice                 ✖ 没有提示
timeout.no-write               ✖ createWritable 又调了一次，文件被改写（Agent 工具还在跑）
summary 8 项过 4
```

改后 `summary 8 项过 8`：等待层显示「先等本机这些写入完成：· Agent 正在执行的修改」；等的时候 Ctrl+Z 改不动；约 12 秒后（10 秒时限 + 前面的等待）顶部提示「这次没有保存 / 还有本机的写入没完成：Agent 正在执行的修改。原来的文件没有改动，等它们完成后再保存。」；`createWritable` 没再调用、原文件逐字节不变、项目仍是未保存；之后 Ctrl+Z 能用。

截图：`out/save-state-shots/3-waiting.png`（等 Agent），`out/save-state-shots/4-timeout.png`（超时提示）。

## 块三：写到一半失败不覆盖旧保存（提交 de7df888）

**先验浏览器的行为成立不成立**（真 Chrome，探针 `--phases fail` 里的 `browser.swap-file-semantics` 一项，不经我们的代码）：同一个文件句柄 `createWritable()` → 写进 100 个字 → 不 close 也不 abort，期间和之后读原文件，都和原来逐字节相同；再开一个流 abort 掉，原文件仍不变。结论：**「先写临时副本、close 时才替换原文件」在 Chrome 里成立**，原代码靠它确实不会把旧保存写坏。但改前的真页面红跑同时看到两处毛病：

1. 写失败后**临时副本留在了目录里**：OPFS 里列出 `失败探针.proc.crswap` 和 `失败探针.proc` 两个文件（真磁盘上它就留在用户保存的那个目录里，挨着 `.proc`）。
2. 提示是浏览器的原话（`模拟：写到一半磁盘出错`），没说原文件怎样。

（OPFS 与真磁盘走的是同一个 `FileSystemWritableFileStream`，规范也写了 close 之前改动不反映到文件；但我没法在无人值守的探针里拿到真磁盘上的文件句柄——「另存为」是系统对话框——所以真磁盘这一条没有亲手验，见「没做成的」。）

**做法**：新文件 `src/editor/io/safeWrite.ts` 的 `writeToHandle(handle, data)`：内容（含预渲染快照）全备齐了才打开写入流；`createWritable` / `write` / `close` 任一步出错，`abort()` 丢掉临时副本（abort 自己再抛也不管），抛 `SaveWriteError`，说法是「写文件时出错：<原因>\n原来的文件没有改动（上一次保存的内容还在），可以继续编辑后再保存。」`.proc`（`proc.ts` 的 `writeProcToDisk`）和 `.procp`（`saveFlow.ts` 的 `savePackedFile`）都走它。

**失败之后**：`saveFlow` 不清脏标记、不更新本地草稿、在 `finally` 里解锁（恢复编辑），顶部卡片「这次没有保存」+ 上面那句话。之后再存一次（写得进去）照常存成。

**改前红、改后绿**

`src/editor/io/procWrite.test.mjs`（假文件句柄照浏览器的规矩办：写进临时副本、close 才替换、abort 丢掉）。改前（`proc.ts`、`saveFlow.ts` 用 694ad620，即块一做完）：

```
✔ 预渲染快照收到了:随文件存进去,不另行提示
✖ 预渲染快照等到时限没收到:项目照存(不带快照),结果里标出来,并告诉用户   ← 块二
✖ 写到一半出错:原文件逐字节不变,临时副本丢掉(abort),没有 close
✖ 关闭(替换原文件)那一步出错:也 abort,原文件不变
✖ 保存流程里写到一半出错:提示说清原文件没动、不标已保存、不更新草稿、恢复编辑
✔ 出错之后再存一次(这回写得进去):照常存成,原文件换成新内容
✖ 打包保存写到一半出错:包文件不变、abort、提示原文件没动
ℹ tests 7 / pass 2 / fail 5
```

（对 2bba5190 即块二做完再跑一次：打包那条已经过了——块二那次提交顺手给打包保存加了 abort，这一块把它并进 `safeWrite.ts`——其余三条照样红，`pass 4 / fail 3`。）改后 `ℹ tests 7 / pass 7 / fail 0`。

真页面探针 `--phases fail`（先正常存一版，再加一条长名字的序列让新内容和旧的不同，写进一半时抛错）。改前（块二做完的代码）：

```
fail.notice                    ✖ 「这次没有保存 / 模拟：写到一半磁盘出错」，没说原文件
fail.aborted                   ✖ log ["half-written"]，没有 abort
fail.original-byte-identical   ✔ 3942 → 3942 字节（浏览器的临时副本规矩兜住了）
fail.no-leftover-files         ✖ 目录里多了「失败探针.proc.crswap」
fail.still-dirty / edit-restored ✔
browser.swap-file-semantics    ✔
summary 8 项过 5
```

改后 `summary 8 项过 8`：提示「这次没有保存 / 写文件时出错：模拟：写到一半磁盘出错 / 原来的文件没有改动（上一次保存的内容还在），可以继续编辑后再保存。」；log `["half-written","abort"]`、没有 close；原文件 3938 → 3938 字节逐字节相同；目录里只剩 `失败探针.proc`；项目仍是未保存；之后 Ctrl+Z 能用。

截图：`out/save-state-shots/5-write-failed.png`（写失败提示）。

## 越界与意外（请先看）

（主会话 2026-10-22 回复：下面 1、2 两处越界接受；4 那份 port.json 主会话核过，文件已不存在、5190 与 5210 都没在监听，没有实际影响、无需恢复。教训：手工起开发服务器（不经测试夹具）必须带 `PROMPTCUT_NO_PORT_FILE=1`，守门测试 `port-file.test.mjs` 只管经夹具起的那条路。）

**顺手修的真缺陷**：改前「保存期间项目被改过，仍标成已保存」——块一真页面红跑里文件是 3 条序列、项目已是 2 条、dirty=false。现在序列化之后项目变了就不标（块二）。

1. **改了清单外的一个已有文件**：`src/editor/userEditing.ts` 加了两行，导出 `agentToolRunning()`（原来的计数 `agentToolDepth` 是私有的，没有读的口子）。「本机 Agent 写完了没有」只有它能准确回答；不加就只能退而用 Agent 标签页的 `busy`（整轮对话都算忙，而且 `AiPanel.tsx` 卸载时不复位，可能永远卡在忙，保存就永远超时）。纯新增、不改原有行为。不接受的话，块二里「本机 Agent」那一样要换判据。
2. **新建了一个清单外的探针**：`scripts/probes/save-state-probe.mjs`。它是这三块的真页面测试，用法写在文件头；`scripts/acceptance/**` 没碰。
3. `src/editor/sync/syncManager.ts` 最终没改：`whenSaved` 原样当「待提交操作」那一样的判据用。
4. **意外：公共 port.json 被我的开发服务器写过一次。** 第一次在 5960 起编辑器时没设 `PROMPTCUT_NO_PORT_FILE=1`，它在 13:53:57 把 `%TEMP%\promptcut\port.json` 改成指向 5960（桌面版的会话靠这个文件找「用户正在用的实例」）。发现后：结束了这个服务器（只结束了它自己起的进程树），确认文件里的 pid 是它的之后删掉了这个文件，再带 `PROMPTCUT_NO_PORT_FILE=1` 重起。**被覆盖前的内容不知道，没法还原**；当时 5190 没有在监听，也没有桌面版在跑（查了 5xxx 的监听端口），所以它原来多半就是一份过期记录。用户下次起桌面版或 `npm run dev` 会重新写。
5. 开发服务器自己起的预渲染子服务挑了一个空闲端口（5821），在分配的 5960～5969 之外；这是编辑器自带的行为（`server/vite-plugin-prerender.ts` 的 `freePort()`），没有办法指定，记在这里。

## 门槛

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误（a57db22c） |
| 全量测试（第一次，a57db22c） | `npm test`（设了两个 VisuHive 变量，值不写进报告） | `tests 7609 / pass 7593 / fail 1 / skipped 15`，退出码 1。唯一的失败是 `server/test/account-instance-dispatch-core.test.mjs` 的「Agent LP rejects unproved oversize/empty sends…」，`Error: read ECONNRESET`（TLS 读被重置），与本分支无关 |
| 那个文件单跑复核 | `node scripts/test-suite.mjs server/test/account-instance-dispatch-core.test.mjs` | `tests 5 / pass 5 / fail 0`，「零失败」，退出码 0 —— 机器忙时的假失败 |
| 全量测试（第二次，c59542be，代码同 a57db22c） | 同上 | `tests 7609 / pass 7594 / fail 0 / cancelled 0 / skipped 15`，「npm test 最终结果：零失败」，退出码 0；日志 8558 行，有 `ℹ tests` 汇总行；本分支三份单测的用例在日志里 |
| 构建 | `npm run build` | 退出码 0 |
| 本分支的探针 | `node scripts/probes/save-state-probe.mjs --origin http://127.0.0.1:5960 --out out/save-state-shots --phases lock,timeout,fail` | `summary 28 项过 28`，退出码 0（a57db22c） |
| 本分支的单测 | `saveLock.test.mjs` / `io/localWrites.test.mjs` / `io/procWrite.test.mjs` | 8/8、9/9、7/7 |

（中途还跑过一次全量：`tests 7609 / pass 7594 / fail 0`，「零失败」，但那次跑的过程中我改了 `saveFlow.ts`、`localWrites.ts`，不算数。）

渲染附加项（导出确定性、快照重放、像素比对）没跑：这次没改画面、渲染管线、导出取帧；`proc.ts` 只改了「收预渲染快照超时之后怎么说」和写盘收尾，快照本身的内容没动。

## 截图

全在 `out/save-state-shots/`（`out/` 不入库）：

- `1-saving.png`：保存中（罩子 +「正在保存项目… 保存完成前暂时不能编辑。正在写入文件…」）
- `2-after-save.png`：保存完、按 Delete 删掉一个片段之后
- `3-waiting.png`：保存在等本机写入（「先等本机这些写入完成：· Agent 正在执行的修改」）
- `4-timeout.png`：等到时限的提示（「这次没有保存 / 还有本机的写入没完成：Agent 正在执行的修改。原来的文件没有改动，等它们完成后再保存。」）
- `5-write-failed.png`：写到一半失败的提示（「这次没有保存 / 写文件时出错：… / 原来的文件没有改动（上一次保存的内容还在），可以继续编辑后再保存。」）

## 要主会话改的语义（我没动 `docs/semantics/**`）

**1. 「待实施」标记（主会话改）——两处都只能部分去，因为同一节里还有这次没做的条目。**

`docs/semantics/product/document-service.md`「## 保存与延迟退出的修改处理（2026-10-08 用户定，待实施）」（第 87 行）：

| 句子 | 去不去「待实施」 |
|---|---|
| 第 89 行「保存等待本机修改状态检查完成，前台编辑暂时禁用」 | **可以去**（本分支实现） |
| 第 89 行同一句后半「非本机内容固定确定快照并记录哈希、权威时间、历史序号……」 | **可以去**（此前已实施，冲突合并那一块里固定非本机快照的那组用例 CS-01～06） |
| 第 90～93 行：改密后退出设备、邮箱重设、延迟撤回、Agent 已读例外 | **必须留** |
| 第 94 行「确切跨服务时间映射……仍待设计」 | **必须留** |

所以标题的「待实施」得留着（或改成「保存这一条已实施，其余待实施」），只在第 89 行末尾标「已实施」。

`docs/semantics/mechanism/document-service.md`「## 保存基准与修改状态检查（2026-10-08 对齐要求，待实施）」（第 34 行）：

| 句子 | 去不去「待实施」 |
|---|---|
| 第 36 行「本机修改状态检查覆盖……保存暂时禁用前台编辑，等待本机写完；失败不覆盖上次有效保存，并恢复编辑」 | **可以去**（本分支实现） |
| 第 37 行「全局修改状态检查覆盖同项目各设备、云端 Agent、上传/分片、渲染及后台产物……」 | **必须留**（没做，不在这次范围） |
| 第 38 行「非本机内容固定一份确定快照……」 | 可以去（此前已实施，同上 CS-01～06）；句末「快照内容与素材引用/入库状态怎样共同确认待契约落清」这半句本来就说待定，保留 |
| 第 39 行「哈希和时间不替代……待合并表……」 | 我没核对，不下结论 |

所以标题的「待实施」也得留着，直到第 37 行做完。

**2. 第 36 行之后补一条三级机制（dry run，供主会话定）：**

> 修改前：（无）
>
> 修改后：「写完」指已经开始、还没落地的本机写入都落地了；要跑很久、最后一次性写回的任务（转写、声音生成）不等，写回之后项目重新变脏。判据：待提交操作——文档服务确认本页面发出的全部修改、恢复日志落盘；素材入库/上传——没有这台设备正在导入（本机有文件、仍是 pending）的素材，别的设备在传的不等；本机 Agent——没有 Agent 让页面执行的工具正在跑；后台写入——300 毫秒内没有本页面的修改落地；渲染——写盘前收一次已完成的预渲染快照，2.5 秒。前四样共用 10 秒总时限，到时不写文件、列出在等什么。写盘先写临时副本，出错丢掉临时副本，原文件不动。保存之后项目已不是写进文件的那一份时，不标「已保存」。

**3. 两处取舍（主会话 2026-10-22 已确认保留）：**

共同的理由：语义里「等本机写完」管的是**影响存进文件的内容**的写入；不影响文件内容的写入不等，否则就是为了它拒绝保存用户的项目，拿数据风险换一个没有收益的严格。

- **预渲染快照等到时限没收到**：照存文件（不带快照）并提示，不按「超时不写文件」办。快照是缓存，存进文件的项目内容不受影响（原代码也明说「缺了、坏了都不能挡住保存」）；渲染这边忙的时候让用户存不了项目，代价比少一份缓存大。提示照给，不静默。
- **素材服务的原尺寸上传队列不等**：等的是「这台设备把文件导进本机内容库」（不等完 `.proc` 里会是空地址，影响文件内容）；往素材服务传原尺寸的队列断了会续传、不改 `.proc` 的内容，等它的话传大视频的几分钟里用户一直存不了。

建议把这条理由写进第 2 条那段机制里（「只等影响写入文件内容的本机写入」）。

**4. 机制文档第 36 行「本机修改状态检查覆盖……保存」**：保存本身也在清单里。这次的实现是「保存进行中再点一次保存不另起」（`busy`）。建议写明。

## 没做成的、没验到的

- **待用户项：真磁盘上的临时副本行为没有实测**（按 `constraints.md`「需要人在机器旁的物理操作」记为待用户项，不挡这一版）。已验到的范围：真 Chrome、页面私有文件系统（OPFS）里的文件——写到一半出错原文件逐字节不变、abort 之后不留临时副本（探针 fail 段 8/8）。没验到的：真磁盘上的文件句柄只能从系统「另存为」对话框拿，无人值守拿不到；两者走同一个 `FileSystemWritableFileStream`、规范也这样写，但这是推断。桌面版跑在 WebView2 里，也没在 WebView2 上验。要做的事：有人在机器旁对一个已有 `.proc` 点一次保存、让写盘中途出错（或拔掉 U 盘之类），看原文件和同目录有没有 `.crswap` 留下。
- **拖放在真页面上没有红绿证据**：改前改后往时间轴派发 png 拖放都没导进素材，所以真页面上这条不算验过。拖放被拦的证据只有 node 单测（`saveLock.test.mjs`）和被拦事件的 `defaultPrevented`。
- 「后台写入」用的是「300 毫秒没有新落地」这个统一判据，没有逐个接卡片配音、自动成片、镜头/主体识别各自的任务表（都是私有的，在别的文件里）。它们各自是一次性写回，判据够用；如果要精确，需要那几个文件各导出一个「有没有在写」的口子。
- Agent 的判据是「有工具在跑」，只读的工具（看画面、读项目）也算在内，保存会多等它一会儿；要细分得在 `mcpExecutor.ts` 里区分读写工具。
- 打包保存（`.procp`）在锁里还要调原有的 `packProcp()`，它会先把没有哈希的老素材补入库（大文件算哈希可能要一阵），这段时间编辑一直暂停；这是原有行为，没改。
- 在线页面的 `saveProject` 照旧是空函数，没动。

