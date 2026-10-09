# 018 对话读取关闭验证助手报告

## 开工范围（2026-10-09）

- 基线：`codex/018-conversation-read-close`，提交 `71fca9d2`；工作区初始干净。
- 本阶段只改 `server/test/fixtures/account-conversation-controls-user-path.mjs`、`scripts/probes/account-conversation-controls-probe.mjs` 和本报告。目标是让隔离账号 fixture 使用同一真实 Agent 服务进程的运行客户端与读取控制客户端，验证共享对话被切私有后的实际读取关闭；浏览器探针按新服务语义检查服务端确认，并增加第三个普通成员的真实共享读取与关闭路径。
- 不伪造权限、事件、ACK 或 pending，不更改产品服务源码。若无真实资源可维持未决读取反例，将如实记录未验证项。
- 计划验证：先跑目标 TypeScript 检查和账号对话控制专属测试；随后只对本阶段 fixture/probe 执行定向用例与 `node --check`、`git diff --check`。在线 dist 只输出到系统临时目录。禁止 full、节点、真实模型和 main 操作。

## 真实读取控制 fixture 与三账号探针（进行中）

- fixture 现在用相同的 pinned doc TLS options 建立 `createRunClient` 与 `createConversationControlClient`，control 写入自己临时 fixture 目录的 SQLite receipt 文件，挂到实际 `createConversationClient` 后启动，并等待其 `describe().connected`。没有绕过 Agent read-control 或伪造 fence/ACK。
- fixture 新增第三个网站账号作为普通成员，实际完成项目加入、成员 session 与项目列表读取。fixture 关闭时先关闭 control owner，再按依赖分组关闭子进程、HTTP/doc/run 客户端与本地 store；每一项用 `Promise.allSettled` 收敛并统计失败，receipt SQLite 只由 control client 关闭一次。
- 浏览器探针现拟检查：普通成员通过真实对话历史与 SSE 读取共有消息；owner 切私有必须取得真实 HTTP 200/界面确认；成员旧 events 读取随后须收到真实 403，切换到空白新对话后重新请求历史，列表不得再出现该对话；创建者仍能从真实历史读取该私有对话且没有输入框。若对应 HTTP/资源证据未出现，探针按失败处理；本任务没有构造 pending 资源来模拟未确认。
- 改动后已验证：`npx tsc -b --force --pretty false` 零错误；`node --import=./scripts/lib/test-silent-processes.mjs scripts/test-suite.mjs src/ai/cloud/account-conversation-controls.test.mjs` 7 项通过、0 失败；两个 JS 文件 `node --check` 通过，`git diff --check` 通过。真实在线窗口尚未运行，确认与关闭结果待后续实测。
- 固定提交 `444f5a2e` 的第一次在线探针已保留在 `%TEMP%\pc-conversation-read-close-444f5a2e-once`：10/10 端口检查通过，之后在 fixture 初始化期间失败；没有页面错误、服务进程或 fixture 目录，6620–6629 均确认释放。原因是本子任务进程没有继承两项真实账户 provider 环境变量，fixture 因真实 provider 缺失而拒绝启动。随后 root 提供只读路径，由后续运行命令局部注入，未改全局环境、未使用模拟 provider。探针清理报告另修正为显式标记 `notStarted`，不把“子进程未启动”误写成“已关闭”。
- 第二轮固定源码 `c1b0a2b3` 真实浏览器结果已保留在 `%TEMP%\pc-conversation-read-close-c1b0a2b3-once`：三账号登录、三次 consent、普通成员真实共享事件读取、creator 共享只读及 owner 的私有切换确认均通过；owner visibility POST 为真实 200，页面错误为 0，fixture/子进程清理成功，6620–6629 全部释放。首红是探针误把权限收回后的表现假设为“必须再发一条 403 events 请求”；实际长期事件连接会被关闭，不必建立新的 HTTP 请求，因此不能用该假设判定关闭失败。
- 本轮根据真实连接生命周期重写验收：仅记录脱敏 `/events` 路径、HTTP 状态和 request finished/failed 分类；确认私有切换后原 200 SSE 请求终止。随后分别检查原有成员页面是否自行清掉当前私有消息、真实 history 响应列表和抽屉是否都不再包含该私有对话 ID；这三项都通过后才继续 creator 私有只读核对。检查不切换成员当前对话，也不重开/刷新其会话来伪造正文消失。当前探针改动待固定源码重建后的一次实际浏览器运行。
