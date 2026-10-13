# AGENT-v18-newchat：新开的云端对话一直显示「正在重新连接」

分支 `claude/v18-newchat`，起点 main `f87e297a`。端口段 28850～28889（实际用 28850～28861）。

几个词：**事件流**是页面向 Agent 服务读一个对话里发生的事（`GET /agent/v1/conversations/<id>/events`）；**读取通道**是 Agent 服务经文档服务核对"这个账号能不能读这个对话"的那条通道（`server/agent/service/conversation-transports.mjs`），它的规矩是"还没有任何一次读取被文档服务受理时，不放行 2xx 回包"；**边缘代理**是探针夹具里站在浏览器和各服务之间的那层反向代理，上游连接被掐时它回 502，和生产一样；**新对话**指页面刚建的、还没发过第一条消息的云端对话，服务端还没有它；**fresh**是页面给事件流会话（`session.ts`）的一个标记，意思是"这是新对话"。

## 原因

1. 服务端一侧已经改好了（main 上提交 `a11c9a15`）：事件流对"看不到的对话"回 **404**，响应体 `{"ok":false,"code":"no-conversation"}`（第一次改之前是 200 加结束事件，被读取通道掐成 502）。实测响应体的错误码是 `no-conversation`，不是 `not-found`；`not-found` 是路由不存在时的另一个 404。
2. 页面一侧没人处理这个 404：`src/ai/cloud/session.ts` 的重连循环把"不是身份类的任何错误"都当断线，退避后无限重试，同时把连接状态设成"重新连接中"，于是 `CloudAiPanel.tsx` 一直显示「和云端 Agent 的连接断了,正在重新连接……」。也就是说 502 改成 404 以后，页面表现完全没变。
3. 同一个 404 还有另外两种来历：对话被别人设为私有（`conversation-authority.mjs` 第 38 行对非主人也回 `no-conversation`）、被删除。页面单看这个回应分不出是"还没发过消息"还是"已不可读"。

## 做了什么

**判定规则**：只有页面自己知道"这是刚建的、还没发过消息的新对话"（fresh）、并且这次打开之后没读到过它的事件、也没发消息被收下过（known），事件流回 404 `no-conversation` 才算"还不存在"：连接状态停在 idle，不报问题，不重试，等第一条消息。其余一律照原样：不是新对话（历史里选的、记着的旧对话、自动接上的在跑对话）收到同一个 404、读到过之后再 404（被删、被设为私有）、发完第一条消息后偶尔还读不到、502、连不上、没带错误码的 404、`not-found` 的 404，都仍是"重新连接"并一直重试；401/403 和身份类错误仍然停下并给原因。

**改动的文件与行**（相对 main）：
- `src/ai/cloud/session.ts`（+24/−2；减掉的两行是 `open` 的签名与注释）：新增常量说明和 `isAbsent`（第 56～62 行）；变量 `fresh`、`known`（第 80～83 行）；事件到达时 `known = true`（`for await` 里 `attempt = 0` 后一行）；`catch` 里在身份类错误处理之后加 `if (fresh && !known && isAbsent(err)) {…return}`；`send()` 收下后 `known = true`；`open(id, opts?: { fresh?: boolean })` 多一个可选参数并重置两个标记。
- `src/ai/cloud/useCloud.ts`（+13/−6）：新增 `freshKey`（localStorage 键 `pc.cloudFresh:…`，只记这一页当前那个"还没发过消息"的新对话 id，发出第一条消息后清空，刷新页面靠它认出仍是新对话）；`useCloudChat` 初始化处算 `firstFresh` 并在 `session.open(id, { fresh: firstFresh && id === first })`；`send` 成功后清标记；`switchTo(id, fresh = false)` 多一个参数，`newChat` 传 `true`；`openChat` 改成 `(id) => switchTo(id)` 以保持对外签名。
- 与 `claude/v18-chats` 的碰撞点：它也改 `useCloud.ts`、`session.ts`。我的改动集中在 `switchTo`/`newChat`/`openChat`（三行相邻）、`send` 里 `pendingSendRef.current = null` 后一行、初始化 effect 里 `const first` 之后三行和 `session.open` 一行。合并时若冲突，保留两边各自的新增即可，没有语义重叠。
- 新增：`src/ai/cloud/newchat-absent.test.mjs`（页面一侧状态机单测）、`scripts/probes/newchat-events-probe.mjs`（浏览器探针）。
- 服务端一个字没改：`http.mjs` 的 `accountEvents`、`conversation-transports.mjs` 保持现状，读取通道的规矩没动。没有新增界面文字，现有断线提示原文一字未动。

## 改前改后对照（同一支探针 `scripts/probes/newchat-events-probe.mjs`）

探针搭法：账号后端、文档、素材、Agent 服务全用真的（`startAccountRealRunnerFixture`，Agent 服务装真执行器，只有模型是仓库里现成的 mock 提供方），读取通道是真的，Agent 服务前面是夹具的边缘代理，两个无头 Chrome 页面（创建者、成员）只经 DOM 点击与输入。"改前"用 main 起点构建的 `dist-online`，"改后"用本分支构建的，各完整跑一遍（A、B 看 30 秒）。结果文件：`docs/reports/assets/v18-newchat/probe-result-before.json`、`probe-result-after.json`。

| 场景 | 改前：事件流请求 / 页面 | 改后：事件流请求 / 页面 |
|---|---|---|
| A 进项目后停在新对话上，看 30 秒 | 9 次，403×1（开关还没开时）、404×8，持续重试（最后 10 秒仍有 2 次）；30 次采样里 29 次显示「和云端 Agent 的连接断了，正在重新连接……」 | 2 次，403×1、404×1，之后 30 秒 0 次；横幅 0/30 次；连接状态 idle |
| B 点「新对话」再看 30 秒 | 8 次 404；横幅 29/30 | 1 次 404；横幅 0/30；idle |
| C 在新对话里发第一条消息 | 事件流 200，回复出现，live | 事件流 200，回复出现，live（同） |
| D1 刷新，停在有内容的对话 | 200，live | 200，live（同） |
| D2/D5 切到另一个新对话（刷新后、换对话后） | 404×5（10 秒内），横幅 9/10、7/8 | 404×1，横幅 0 |
| D3 刷新，停在没发过消息的新对话上 | 404×7，横幅 15/15 | 404×1，横幅 0/15，idle |
| D4/D6 换回有内容的对话 | 200，live | 200，live（同） |
| E0 成员自己的新对话 | 404×5，横幅 9/10 | 404×1，横幅 0 |
| E3 真故障：成员刷新后落在已被创建者设为私有的对话上 | 404×7，横幅 15/15（重连提示） | 404×7，横幅 15/15（同，仍提示） |
| F1 真故障：Agent 服务停掉，正看着的对话 | 502×4，约 45 秒后出现横幅（页面的"45 秒没有任何字节才算半开"判定） | 同 |
| F2 真故障：Agent 服务停掉时新开对话 | 502×6，横幅 14/15，另弹「云端 Agent 暂时连不上文档服务,请稍后再试。」 | 同 |

页面文字：改前新对话上方显示「和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。」；改后没有这条横幅，面板上只有「新云端对话 · 默认共有」。头部状态点的提示（悬停才看到）：改前「连接中断,重新连接中…」，改后「未连接云端」（现有的 idle 文字，和原来非账号模式下新对话读到"没有"时一致，未改）。

截图（我看过）在 `docs/reports/assets/v18-newchat/`：`before-A-fresh-initial-end.png`（横幅）对 `after-A-fresh-initial-end.png`（安静的空对话）；`before/after-B…`、`before/after-D3-reload-on-unsent-new-chat-end.png`；`after-C-after-first-message.png`（发出第一条消息后：自己的消息、第 1/24 轮、操作记录出现）；`before/after-E3-…`（私有后刷新，两边都有横幅）；`before/after-F1…`、`F2…`（服务停掉，两边都有横幅）。

## 验证

- 单测 `src/ai/cloud/newchat-absent.test.mjs`：15 条全过（账号模式与本机模式各跑一遍的 6 条加 3 条）。三种回应的状态机：还不存在（新对话 404 `no-conversation` 停下、只请求一次、发消息后接上；kick 只再问一次）、真断线（连不上、502、没带错误码的 404、`not-found` 的 404、读到过之后再 404、发完第一条消息后偶尔 404、不是新对话的 404 都一直重连）、被拒（401、403、`disabled` 停下不重试）。**红的时候**：把 `session.ts` 改回 main 版本后，NEWCHAT-1、2、3、7、8 失败（等待连接变 idle 超时 3 秒，因为一直在重连），4、5、6、9 本来就过（它们是"真故障不许被吞"的防线）。
- 相关旧测试：`windows-hide-silent-spawn`、`accept-018-auth-agent-path`（含"不存在的对话…事件流"回 404）、`cloud-chat`、`account-read-revocation`、`account-queue`、`account-conversation-controls` 共 49 条全过。
- `npx tsc -b --force`：退出码 0，无输出。
- 全量 `npm test`：见下面「全量结果」。
- windows-hide 守门（`server/test/windows-hide-silent-spawn.test.mjs`）已含在上面那 49 条里，通过；探针里没有自己起子进程（夹具里起的都带 `windowsHide: true`）。

## 没做成的 / 要注意的

- **本来就不严的一处没动**：创建者把对话设为私有时，成员正开着的页面的事件流不会断也不会提示（探针 E2：20 秒内仍是 live、没有任何提示，改前改后相同）；只有成员刷新或重新打开才会落到 404 横幅（E3）。这是 `http.mjs` 轮询里权限变了就静默 `return`、既不发事件也不关流造成的，不在本任务范围，没碰。若要让成员当场看到「当前账号已无法读取这个对话」，需要服务端在那里发 `access.revoked` 事件或关流。
- **升级前留下的未发消息的新对话**：这一页的 localStorage 里没有 `pc.cloudFresh` 标记，所以升级后第一次打开它仍按旧样子重连；点一次「新对话」就进入新逻辑。（升级前用户本来就看到这个故障，不比以前差。）
- **取舍**：不做"凡是 404 都当没有"，是因为私有和已删除回的是同一个 `no-conversation`，那样会把用户刷新后落在一个不可读的对话上的真故障也吞成空对话（探针 E3 证明这条仍提示）。服务端另分一个错误码也能分，但那要改"不区分不存在与没权限"的有意设计（防泄露存在性），我没动。
- 探针观察到的小事，不是本任务：F1 里 Agent 服务被停后，已经连着的流要等页面自己的 45 秒无字节判定才显示重连横幅（边缘代理没把断掉的上游流收尾）。
- 我读 `docs/local.md` 时，为找那两个环境变量，第一次用 `tail -15` 多读出了该文件末尾若干行其它内容（节点上的工具安装记录，没有密钥，没有写进任何产物）。后面只读了最后两行。

## 对任务书或语义的更正建议

- `docs/semantics/workflow/production.md`（一级）与 `product/agent.md`（二级）可补一句：新开、还没发过消息的云端对话是一个安静的空对话，不显示断线提示、不后台重试；发出第一条消息后才连事件流。
- 契约（`docs/plan/` 里 Agent 服务接口那章，`accountEvents`）补：账号模式下事件流对不存在或不可读的对话回 404 `no-conversation`（不是 200 加结束事件）；页面按"这是不是页面刚建的新对话"分辨正常与故障。
- `docs/reports/AGENT-v18-chats.md` 第 140、144 行那条"已记待办"可以关了。

## 全量结果

两遍（设了 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`，命令 `npm test`）：

- 第一遍：6461 条，6442 过，1 败，6 todo；退出码 1。败的是 `server/test/account-worker-lifecycle.test.mjs` 第 204 行起的一条（"已读之后出了暂时性故障、任务进程放弃了正常结算……槽让出来"，断言处写着期望 `active`、实际 `revoked`）。它不在"机器忙时偶发"名单里，也与本任务无关（任务进程、结算那一块，我没碰）。
- 单独重跑该文件两次：9/9 过、9/9 过。
- 第二遍：6461 条，6443 过，0 败，0 取消，6 todo；`npm test 最终结果：零失败`，退出码 0。
- 判断：这是一条新的偶发（时序类）测试，不是本改动引起；建议主会话把它加进偶发名单，或让做任务进程那一块的人看看第 204～214 行的等待是不是偏紧。我没有改测试。

收工检查：端口 28850～28861 全部释放，无遗留 Chrome、探针、素材子进程；`.worktrees` 里没建 `node_modules`、没新增依赖。构建产物（改前、改后两份 `dist-online`）和 Chrome 配置放在系统临时目录 `pc-newchat`，不在仓库里。
