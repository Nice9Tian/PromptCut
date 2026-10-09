# 018 对话读取关闭验证助手报告

## 开工范围（2026-10-09）

- 基线：`codex/018-conversation-read-close`，提交 `71fca9d2`；工作区初始干净。
- 本阶段只改 `server/test/fixtures/account-conversation-controls-user-path.mjs`、`scripts/probes/account-conversation-controls-probe.mjs` 和本报告。目标是让隔离账号 fixture 使用同一真实 Agent 服务进程的运行客户端与读取控制客户端，验证共享对话被切私有后的实际读取关闭；浏览器探针按新服务语义检查服务端确认，并增加第三个普通成员的真实共享读取与关闭路径。
- 不伪造权限、事件、ACK 或 pending，不更改产品服务源码。若无真实资源可维持未决读取反例，将如实记录未验证项。
- 计划验证：先跑目标 TypeScript 检查与经仓库 `npm test -- <target>` wrapper 的专属用例；再执行本阶段 fixture/probe `node --check`、`git diff --check`。在线 dist 只输出到系统临时目录。禁止 full、节点、真实模型和 main 操作。

## 真实读取控制 fixture 与三账号探针（进行中）

- fixture 现在用相同的 pinned doc TLS options 建立 `createRunClient` 与 `createConversationControlClient`，control 写入自己临时 fixture 目录的 SQLite receipt 文件，挂到实际 `createConversationClient` 后启动，并等待其 `describe().connected`。没有绕过 Agent read-control 或伪造 fence/ACK。
- fixture 新增第三个网站账号作为普通成员，实际完成项目加入、成员 session 与项目列表读取。fixture 关闭时先关闭 control owner，再按依赖分组关闭子进程、HTTP/doc/run 客户端与本地 store；每一项用 `Promise.allSettled` 收敛并统计失败，receipt SQLite 只由 control client 关闭一次。
- 浏览器探针检查：普通成员通过真实对话历史与 SSE 读取共有消息；owner 切私有必须取得真实 HTTP 200/界面确认；成员旧 events 连接须结束，当前正文须自行消失，主动打开真实历史后服务端和 UI 列表均不得再出现私有对话；创建者仍能从真实历史读取该私有对话且没有输入框。断流/正文/历史检查彼此独立，不因额外切换成员对话或重载来人为清空正文。
- 改动后已验证：`npx tsc -b --force --pretty false` 零错误；`node --import=./scripts/lib/test-silent-processes.mjs scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs` 7 项通过、0 失败；两个 JS 文件 `node --check` 通过，`git diff --check` 通过。真实在线窗口尚未运行，确认与关闭结果待后续实测。
- 固定提交 `444f5a2e` 的第一次在线探针已保留在 `%TEMP%\pc-conversation-read-close-444f5a2e-once`：10/10 端口检查通过，之后在 fixture 初始化期间失败；没有页面错误、服务进程或 fixture 目录，6620–6629 均确认释放。原因是本子任务进程没有继承两项真实账户 provider 环境变量，fixture 因真实 provider 缺失而拒绝启动。随后 root 提供只读路径，由后续运行命令局部注入，未改全局环境、未使用模拟 provider。探针清理报告另修正为显式标记 `notStarted`，不把“子进程未启动”误写成“已关闭”。
- 第二轮固定源码 `c1b0a2b3` 真实浏览器结果已保留在 `%TEMP%\pc-conversation-read-close-c1b0a2b3-once`：三账号登录、三次 consent、普通成员真实共享事件读取、creator 共享只读及 owner 的私有切换确认均通过；owner visibility POST 为真实 200，页面错误为 0，fixture/子进程清理成功，6620–6629 全部释放。探针把关闭表现限定为“必须新发一条 403 events 请求”是错误假设；更重要的是，约 38.236 秒结束时 `failure-2.png` 中普通成员仍显示原共有正文，这是真实页面缓存缺口，不能用连接被服务端关掉推定正文也消失。后续分别验 SSE 关闭、正文清空及历史隐藏，不能删掉正文检查。
- 固定源码 `0a3a0471` 的下一次实际三账号运行结果保留在 `%TEMP%\pc-conversation-read-close-0a3a0471-once`：前三个账号真实登录、共享读取、普通成员 SSE 200 与 owner 私有切换服务端确认均通过；失败发生在断流检查调用未定义的 `waitFor`，属于探针本身 `ReferenceError`，8.149 秒结束，未检查成员正文或私有历史。截图 `failure-2.png` 显示成员仍可见原共享正文，但该轮在服务端确认之后立即被探针错误中断，不能据此判断是否会自然清除。修复为探针本地轮询后，下一轮将把旧流终止、正文自行消失、真实历史响应与 UI 隐藏分别记为结果；无论断流检查是否失败，仍继续后二项，不切换当前对话/重载会话来人为清空正文。该结果有 0 pageErrors，fixture、子进程关闭成功，`closeFailureCount:0`，6620–6629 全部释放。
- 固定源码 `fd979212` 的三次非验收诊断尝试保留在 `%TEMP%\pc-conversation-read-close-fd979212-once*`：均在登录阶段空白，只有 10 项端口前置检查通过、没有 API 请求或 pageerror，fixture 与 6620–6629 均释放。这不是产品结果。诊断发现三次构建使用了 `npm run build -- --outDir` 的桌面配置；桌面 index 引用 `/assets/...`，而托管探针把在线编辑器资源路由在 `/editor/assets/...`。`vite.config.ts` 的 online 模式才设置 `base: /editor/` 和 `VITE_PC_ONLINE=1`。下一次若重跑必须用 `vite build --mode online`、`site-root` 用根 9380 wrapper 的 `VisuHive\site`，并保留静态资源错误证据，不把空白页当业务结果。
- 新产品修复 lease：`createCloudSession` 仅对 `accountMode` 增加读取失效清理。账号 SSE EOF/断连先清正文、队列、发言者、增量批次、待贴附件与已回答页面请求，再把 seq 归零以重新取票完整重放；HTTP 401/403（业务 code 不论为何）清理并停止重连。旧流启动的异步页面工具因读取 epoch 改变而不能回交结果；`useCloud` 从已有 `cloud.accountMode` 传入模式，LAN 断线续读不变。测试覆盖 EOF 清理/完整重放、迟到页面工具、附件关联、401/403 业务码冲突，以及 LAN 续读兼容。该产品修复尚待正确 online mode 构建后的真实三账号浏览器复验；需再次看到成员正文自然消失并实际历史不含私有 ID，才能报告该项通过。
- 固定产品提交 `72b80d4e` 用 `vite build --mode online` 重建后完成一次真实三账号运行，结果保留在 `%TEMP%\pc-conversation-read-close-72b80d4e-once`：前 21 项账号/共享读取与真实 visibility HTTP 200 都通过；全程 0 pageErrors，fixture 与子进程关闭成功，`closeFailureCount:0`，6620–6629 全部释放。第三成员当前正文自动清空为通过，`06-member-after-private-history-refresh.png` 中打开历史抽屉后列表为空。旧 SSE 的收尾检查在当时探针中为 false，但最终脱敏生命周期记录有该成员请求 `status:200,lifecycle:failed`，并观察到其后 fresh events 尝试得到 502；因此本轮尚未证明所捕获的 200 是切私前那一条旧请求。历史第一次打开抽屉的真实 GET 200，UI 列表隐藏检查也通过；探针随后误把已打开抽屉的按钮再点一次，导致第二个 listener 超时，服务端列表正文检查未完成。现已修探针：在切私前固定保存成员那条 200/open SSE 记录，独立等待它结束；历史侧只读取打开抽屉时那一次真实 GET/响应，不重复点击 toggle。下次三账号运行需以固定的旧流 lifecycle、HTTP 200 历史列表不含该对话 ID，以及当前正文消失作为三项独立结果。
