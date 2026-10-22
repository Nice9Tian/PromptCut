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

