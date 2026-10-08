# 0.7.18 云端 Agent 全员选区实际工具接线

工作树 `codex/018-agent-live-selection`，起点 `34e6b7ba422f2d673ed333d3a8c1fa85a7c0a3b4`。本叶只改 accountMode 下 `get_selection` 从 Agent 的实际 doc data connection 查询 doc 权威全员选区；不改 LAN/local、doc 选区权威、run 授权、UI 或正式部署。

## 接口与目标

已拍板语义：返回项目内所有在线有效成员的每页选区和可信用户名，发起成员名后标「（当前用户）」；发起成员全部页面离线时只补该条持久消息的发送时快照，明示「非实时」。doc `selection.query` 已按 runGrant、项目和前后 fence 核验，本叶消费者不接收工具参数或页面自报身份/快照。doc 拒绝、超时或上下文不匹配时必须显式失败，不回退旧单人页面/快照结果。

## 固定源码和数据路径

源码/专属测试固定 `3f17b10a32bcf71ccafaec979c663aaad8eda7b7`。`createExistingHostedRunnerFactory` 仅从 doc-admitted grant 构造不可变 `{projectId,conversationId,runId,runGrantId}`；Agent 工具参数中的 project/username 不参与查询。accountMode 的 `get_selection` 经本轮 data executor 连接发送 `selection.query {projectId,runGrantId}`；请求前后核对实例绑定、conversation、run 与项目，响应要求 doc 的 `selection.state`/同项目及完整成员/页面基本结构。返回 doc 的可信 displayName、live、items、missing 和非实时 snapshot note，不自行给成员重算标签。doc 的 error/超时/无效响应一律 `selection-unavailable`，没有旧页面或单人消息快照退路。LAN/local 仍走原反向页面通道；`seek/play/pause` 行为未改。

## 首次失败和目标验证

- 新目标 `npm test -- server/test/agent-live-selection.test.mjs` 第一次 exit 1：真实模型已进工具路由，但断言 `state.ok` 为 false；第二次仅增强断言诊断，仍 exit 1，同一位置。第三次增加安全原因日志后 exit 1，明确 `run-binding`，模型 `tool_call/tool_result` 已发生。原因是夹具直接调用 `createAgentInstance.callTool` 时误用 agent-side 的 `{agent}` options 形状；该 instance 方法实际第三参数为 agent 字符串。纠正夹具为 `'conv1'`，没有放宽产品验证或更改 doc 权限。两次原始失败及第三次诊断都保留在对话工具输出，不冒作通过。
- 修正后首次真实数据路径目标 1/1、0 失败/取消/跳过，exit 0，2498.4978 ms。夹具为真实 `createDocService`+`projectModule`+`mountSelection`、真实 WebSocket `listen(0)`、实际 `createAgentInstance.startHostedRun` 经显式模拟模型触发 `get_selection` 工具，再从同一活动轮次调工具核结果。覆盖 Alice 同账号两页、Bob 在线、Carol 空选区、可信用户名与「（当前用户）」、缺失 clip ID、伪造工具参数不影响查询、Alice 离线仅其份 doc 持久快照非实时且 Bob 仍实时，以及 grant 拒绝/上游不可达绝不退回旧快照。测试清理等待页面 WebSocket、doc listener 和 Vite 关闭；这是夹具账号 provider，不是生产注册或付费模型执行。
- 固定 3f 的 `node ..\..\node_modules\typescript\bin\tsc -b --force` exit 0，12.948 s；旧云端/LAN 工具回归 `npm test -- server/test/cloud-agent-service.test.mjs` 18/18，exit 0，14385.9542 ms，包含原 CA-PAGE-01 单人页面路径行为。该旧测试不代表新账号模式通过，新账号模式证据为上一项。

固定 3f 的首次且唯一全量 `npm test` 使用 VH `018-active-run-order` HEAD `327ff674f16d9ddf83d5697f4c78f63847a82768` 的真实 provider/root 和 `account/password-order.mjs`，仅测试进程设置规范 `PSModulePath=C:\Windows\System32\WindowsPowerShell\v1.0\Modules`、cuda_Vit Python、主仓库 out/pylibs/out/models 与绝对 file URL 的静默 Node preload。原始日志 `C:\Users\admin\AppData\Local\Temp\pc-018-agent-live-selection-full-1.log`：**5164 tests / 5162 pass / 0 fail / 0 cancelled / 2 skip / 0 todo，duration 73908.776 ms，wall 75072 ms，exit 0**，没有文件级原生异常自动重跑。运行前后 5730/5760/5770/5790/5820/5860/5920 各十端口均零 LISTEN，无匹配本叶 owned Node 子进程，受测源码前后同 3f。

真实实例注册/恢复、中央生产 grant 授予、付费模型、TLS 与节点部署由其它叶负责；本叶的账户模式通过证据是显式可信 run-provider 夹具+真实 doc 传输/实际 Agent 工具，不能冒称生产服务已上线。
