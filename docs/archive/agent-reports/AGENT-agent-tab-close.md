# AGENT-agent-tab-close

分支 `claude/agent-tab-close`(从 main 5ec3f668 切出)。任务:右侧竖栏「Agent 1」标签要能删除。

## 做了什么
- 「Agent 1」(内部 id `main`)与其它标签一样可关;只剩最后一个标签时 × 仍画出但禁用,悬停提示「至少保留一个 Agent 标签」。关掉当前标签后切到左边那个(在最左则切右边那个)。
- 新建标签取当前最小的空号(新增持久化字段 `num`;老数据按「Agent N」的名字认号,认不出且无角色的按位置给)。声明范围后又清掉范围时,标签名回到 `Agent <num>`,不再按位置算。
- 「主标签」的特殊用途已逐处查过:
  - `liveChat.ts` 的 MAIN_TAB 对话 store 是随项目存取(.proc)的那份,不能销毁:关主标签时把它清空(`replace([])`),其它标签仍是 `dropChatStore`。
  - `agentTabs.load()` 原先会无条件补回 main;改为只在一页都没有(第一次打开)时才补,激活页缺失时落到第一个标签。
  - `useAiChat` 的会话键(`aiSession:*`)、`AiPanel` 的 `pcChatId` 键、`ModelBar` 等都是按 tabId 取值,main 关掉后没有组件再用它,不受影响。`railStore/railLayout/DockPages` 按 agentTabs 增删同步布局,没有特判 main,关 main 走与关其它页相同的路径(实测列表正常)。
- 副作用(已知,未处理):关掉主标签后,项目 .proc 里存的那段「主对话」是空的;剩下的标签与此前所有非主标签一样,刷新后靠会话归档按 id 找回,不随 .proc 走。若要让接替的标签也进 .proc,需要把 .proc 的存取改成指向「第一个标签」,超出本次范围。

## 语义改动(editing.md,一级,用户原话所定)
- 改前:无关于 AI 栏 Agent 标签关闭与编号的规定。
- 改后:在「时间轴」下「剪辑标签」条目之后加一条:AI 栏的 Agent 标签(2026-10-20 用户定,引原话「我发现Agent1那个会话没法删除。这个不符合预期。」)每个都可以关,包括「Agent 1」;最后一个不能关;关当前标签后切到相邻标签;新建取最小空号。
- `product/agent.md` 未改(其中无规定主标签不能关)。

## 文件清单
- `src/ai/agentTabs.ts`:`canCloseTab`、`closeTab`、`addTab` 编号、`load` 不再强补 main、`num` 字段与持久化
- `src/editor/dock/RailBar.tsx`:× 始终渲染,最后一个禁用+提示;去掉 MAIN_TAB 引用
- `src/editor/right/chat/chat.css`:`.pc-rr-x:disabled` 样式
- `src/ai/agentTabsClose.test.mjs`(新):AT-C1～AT-C5
- `docs/semantics/workflow/editing.md`
- 本报告

## 验证
- `npx tsc -b --force`:退出码 0,零错误。
- `node --test src/ai/agentTabsClose.test.mjs src/ai/agentBus.test.mjs`:10 通过 0 失败(AT-C1 最后一个关不掉;AT-C2 关主标签与激活;AT-C3 最小空号;AT-C4 关主后刷新不补回、编号与激活保持;AT-C5 老数据与激活页缺失)。
- 全量 `npm test`(设了 PROMPTCUT_ACCOUNT_PROVIDER_ROOT / PASSWORD_ORDER_MODULE):7179 项,通过 7165,失败 0,跳过 14,退出码 0。
- 本机页面(vite 5360,已关闭):用 DOM 脚本驱动编辑器:初始仅「Agent 1」时 × 禁用、title 为「至少保留一个 Agent 标签」;连开两页得 Agent 1/2/3;点 Agent 1 的 × 后列表为 Agent 2、3,localStorage `pc.agentTabs` 同步;再新建得到 Agent 1。**没有截图**:浏览器窗格截图连续超时(窗口不在前台),以 DOM 读数为证。

## 部署
只需重建在线前端(`vite build --mode online`);没有服务端文件改动。

## 没做成 / 建议
- 截图证据缺(见上)。
- 建议用户确认上面「关主标签后 .proc 里主对话为空」的取舍是否可接受。
