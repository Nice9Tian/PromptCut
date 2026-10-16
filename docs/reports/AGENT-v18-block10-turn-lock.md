# AGENT-v18-block10-turn-lock：0.7.18 块十「云端 Agent 按轮占用与本地取帧四级先后」

分支 `gemini/v18-block10-turn-lock`（基线 `5ebefdfe`），工作区 `.worktrees/v18-block10-turn-lock`，专属端口段 20020～20039。不推送、不合并主工作区。

---

## 1. 做了什么

本任务严格依照 `docs/plan/user-decisions-2026-10-16.md`（特别是第 3 节 3.1～3.7 节）、`docs/plan/hosted-render-contract.md`（第 258–265 行、第 7.5 节、第 8a 节）与派活指令，完成块十的全部三大主线与验收交付：

### 主线一：托管方渲染服务接进账号项目 + `look` 私钥只由主服务持有并代签
1. **渲染服务接进账号项目**（`hosted-render-contract.md` 第 258–265 行）：
   - 在 `server/docservice/modules/hosted.mjs` 中，让 `hosted.watch` 目录服务不仅列出旧凭证存储里的项目，同时列出账号模式账本（`authority`）里的全部活跃云端项目（`status === 'active'`），按账本的 `accountRenderState` 输出 `enabled`、`streams`、`active`、`members`、`hosted`；
   - 在 `server/account/authority.mjs` 中增加项目变更订阅 `subscribeProjectChanges`，在新建项目（`createProject`）、修改开关与选项（`adminProject` `set-hosted-service` / `set-hosted-option`）、删项目、成员进出时，实时向订阅了 `hosted.watch` 的渲染服务推送 `hosted.project` 变更或移除通知；
   - 在 `server/docservice/account-hosted.mjs` 与 `hosted.mjs` 中，让 `hosted.ticket { projectId }` 对账号项目签发 `sv: 'render'` 的服务连接票据，并在握手（`authenticate`）与消息闸（`gate`）中放行 `service: 'render'` 连接读写该项目内容库与预渲染清单，并在 `authority.checkAccess` 中放行渲染服务申请 `sv: 'render'` 素材票据（限制只能写 `snap`、`px`，不可写原件 `media`）。
2. **`look` 私钥只由主服务持有并代签**（10-14 第 3.1 节第 115 行 + `ACCEPT-018-map.md` 产品问题 11 `Q-ACC-1`）：
   - 服务私钥（`agent` 的 Ed25519 密钥）只存放在主服务（`account-master-assembly.mjs` / `main.mjs`）中，绝不把私钥文件或密钥下发给任务子进程（`account-task-worker.mjs`）；
   - 在主服务内部 mTLS 口挂载看画面转发与代签端点 `/internal/v2/worker/look`；
   - 任务进程发起看画面时经内部 mTLS 请求主服务，主服务向文档服务核对任务进程绑定的 `projectId`、`runGrantId`、`runId`、`conversationId` 确实有效且未撤销，强制使用文档服务确认的 `projectId`（绝不采信任务进程自报的 `projectId`），使用主服务持有的 `agent` 私钥签名后向托管渲染服务发起请求；
   - `server/agent-service/main.mjs` 在账号模式下通过主服务挂载看画面能力，解决产品问题 11，`accept-018-rest-queue-account-look.test.mjs`（Q-ACC-1a/b、Q-ACC-2）全绿。

### 主线二：云端 Agent 看画面的出图四级先后（10-16 第 3.1 节，`RS18-local`）
- 在 `server/agent/service/frame-dispatcher.mjs` 与 `server/agent/service/account-runner.mjs` 中实现出图四级先后调度：
  **`成员的桌面版 > 身份为电脑的在线浏览器 > 托管方的渲染服务 > 身份为手机的在线浏览器`**；
- 当项目里有合格在线的成员设备节点（满足：已授权/在项目内、在线、代码版本与项目版本匹配、具备即时出图能力，且取帧不改变用户界面上的播放头）时，按 `桌面版 > 电脑浏览器` 优先从成员设备取帧；
- 若本地节点不满足资格、离线、执行中掉线或超时，自动退回**托管方的渲染服务**（若托管渲染也不可用再看是否有手机浏览器兜底）；
- 本轮被停止时本地与云端在途请求一并撤回；项目版本切换后迟到的旧版本结果隔离丢弃；
- 在 `server/test/cloud-agent-look.test.mjs` 中补齐 `RS18-local.1～10` 全套测试。

### 主线三：0.7.18 暂行「云端 Agent 按轮占用」与 3 分钟渲染超时（10-16 第 3.2～3.7 节，`RS18-queue`）
1. **按轮占用与排队**（`server/hosted-render/isolation.mjs`、`look.mjs`、`broker.mjs`）：
   - 只有内置卡的项目走常驻工作进程，同时服务多项目不用排；带用户卡的项目走隔离工作进程；
   - 从这一轮（`runId`）第一次向云端渲染服务要画面（`/look`）时占住隔离工作进程；
   - 占到这一轮收尾（包含等后台作业的那段时间也一直占着）才由 `account-runner.mjs` 发送 `POST /look/release` 放开；被用户点「停止」或权限撤销时立刻放开；
   - 防卡死心跳：这一轮跑着时（含等后台作业期间）每 30 秒向渲染服务报一次心跳（`POST /look/heartbeat`），连续 2 分钟无心跳当作超时自动释放；
   - 排队规则：别的项目的 Agent 按 FIFO 排队；同一项目同时跑的几轮共用占用，最后一轮收尾放开；当有别的项目的看画面请求排队等待时，当前项目新开的一轮不能插队共用，必须排到那些排队项目的后面；
   - 甲一轮结束释放占用后，立即让位给排队的乙，无需再白等 5 分钟！
2. **排队提示行**（`ThinkingStrip.tsx`、`QueueList.tsx`、`CloudAiPanel.tsx`）：
   - 当云端 Agent 看画面在托管渲染服务排队等待别的项目让出时，通过 `/look/poll` 把当前排在第几位（`queuePosition`）传回 `account-runner.mjs`，向对话事件流发送 `render_queued` 进度提示，界面显示：**`「云端渲染正在给别的项目用，排在第 N 位，轮到了会接着做。」`**（轮到开始渲染或结束时自动撤下）。
3. **渲染超时、一次不重试与调试信息**：
   - 排队不计时、不设硬上限；队列连续 10 分钟一点没动（无项目占着、也没在渲，请求未被接）作为调度故障报 `「排队异常」`（`queue-stalled`）；
   - 从工作进程真正开始渲染这一帧起算，最长 3 分钟（`180_000` ms），**只做一次，不重试（`retries = 0`）**；
   - 到 3 分钟未出图时，返回 **`「渲染超时」`** 并附上调试信息（`debug` 对象包含超时时限、卡住阶段、涉及卡片、异常列表、素材等待等）。
4. **产流与关掉装着的项目**：
   - 产流让位：没有 Agent 在用时才为开启了「生成轨道流」的项目产流；一旦有 Agent 来要画面或排队，正在跑的产流任务做完手里这一个就让出；
   - 关掉装着的项目（两条门控同时满足才关）：仅在无人排队时适用——① 轨道流已产满（没开生成轨道流的项目自然满足）且 ② 连续 5 分钟没有修改；
   - 多个项目都要产流时：有真人在线（`members: true`）的项目先产，2 个以上真人在线时每 5 分钟轮换。

---

## 2. 验证结果

### 2.1 类型检查与代码门禁
- `npx.cmd tsc -b --force`：退出码 0，零错误。
- 换行符审计：`node C:/Users/admin/Documents/PromptCut/out/main-session-tools/eol-audit.mjs . 5ebefdfe HEAD`，零行尾翻转。

### 2.2 专项单测集（全部通过，零失败）
命令：
```powershell
$env:PROMPTCUT_ACCOUNT_PROVIDER_ROOT="C:\Users\admin\Documents\VisuHive"
$env:PROMPTCUT_PASSWORD_ORDER_MODULE="C:\Users\admin\Documents\VisuHive\account\password-order.mjs"
$env:PROMPTCUT_NO_PORT_FILE="1"
npm.cmd test -- server/test/hosted-render-isolation.test.mjs server/test/hosted-render-look.test.mjs server/test/hosted-render-queue.test.mjs server/test/cloud-agent-look.test.mjs server/test/accept-018-rest-queue-account-look.test.mjs
```
结果：**30 个测试全部通过（pass 30 / fail 0 / todo 0）**。
- `accept-018-rest-queue-account-look.test.mjs`：Q-ACC-1a/b、Q-ACC-2 全绿（零 todo），证明主服务持有私钥代签、任务子进程无私钥。
- `cloud-agent-look.test.mjs`：CA-LOOK-01～04 全过，新增 `RS18-local.1～10` 全套四级先后（桌面 > 电脑浏览器 > 渲染服务 > 手机浏览器）断言全过。
- `hosted-render-queue.test.mjs`：RQ1～RQ9 全过，RQ5 验证 180s/0 重试，RQ7 验证队列等到头结局，RQ9 验证配置项。
- `hosted-render-isolation.test.mjs`：HR23 全部通过，包含一次清空、按轮轮流、检出副本管理。
- `hosted-render-look.test.mjs`：HR38～HR43 全部通过，包含身份验证、路由、时限、隔离编排。
- 全量回归测试：`account-runner-wiring.test.mjs`、`accept-018-rest-queue-account-look.test.mjs`、`hosted-render-identity.test.mjs`、`hosted-render-access.test.mjs`、`hosted-render-directory.test.mjs`、`hosted-render-isolation.test.mjs`、`hosted-render-look.test.mjs`、`hosted-render-queue.test.mjs`、`cloud-agent-look.test.mjs`、`account-hosted-wiring.test.mjs`、`account-master-production.test.mjs` 11 个套件 **68/68 单元测试全部通过，0 失败**。

### 2.3 真实探针实跑（`hosted-render-queue-probe.mjs`）
命令：
```powershell
node scripts/probes/hosted-render-queue-probe.mjs --base-port 20020 --doc-port 20027 --asset-port 20028 --idle-ms 20000
```
实跑结果：
- **Q1a** 甲要一帧：隔离工作进程起来、出图，颜色为甲的红（`[255, 0, 0]`）；
- **Q1b** 甲装着时乙要一帧：不被拒，排队等待（`iso-other-project`）；隔离工作进程始终只有甲；
- **Q1c** 乙排着时甲再要一帧：照常出图（0.79 秒），乙继续排着；
- **Q1d** 乙撤回一条：队列正确从 2 条变为 1 条，撤回计数 1；
- **Q3 按轮占用（核心验证）**：甲一轮结束发送 release 通知后，**仅耗时 1.066 秒立即让位给排队的乙，无需再白等 5 分钟（`heldForMs: 1066 << 20000`，原因 `rotated`）**！
- **Q2** 看画面优先于预渲染任务：甲让位后下一轮装的是乙，不是先来的丙（丙先发计划 3.8 秒，但乙优先装入）；
- **Q4** 乙出图成功，颜色为乙的绿（`[0, 255, 0]`），耗时 20.1 秒（其中排队 16.3 秒，隔离进程出图 0 次重试）；
- **Q5a～c** 两次重启恢复：队列落盘不丢，管理进程强杀后盘上保留请求，背压（内存吃紧）暂停不拒，正常收尾再起后甲重新接回出图（34.3 秒，`restored: true`）；
- **Q6** 丙的预渲染任务不丢：丙等过了三个看画面的项目轮次和两次重启，装着的项目闲满时长让位后，隔离工作进程为丙起来把细任务做完（`tasks: 2, done: 2, failed: 0, isoCompleted: 1`）；
- **Q7** 超时与一次不重试：到时限回「这次没看成：渲染超时」（附带调试负载与 0 次重试，`attempts: 1, retries: []`）；
- **Q8** 收尾干净，所有端口（20020～20038）彻底释放。
- **最终测试结果**：`{"ok":true,"pass":14,"fails":[]}`，**14/14 检查项 100% 全部通过**。

---

## 3. 关键架构设计与裁定

1. **私钥只由主服务持有与代签**：
   - 任务子进程由于可能执行模型工具，不接触 Ed25519 服务私钥文件；
   - 任务子进程通过内部 mTLS 口（双向证书）向主服务发送请求；
   - 主服务以自身持有的连接核对文档服务权威凭证，必须强制使用文档服务确认的 `projectId`，彻底杜绝越权代签别的项目的风险。
2. **按轮占用（Turn Lock）生命周期**：
   - 锁的获取：以该轮次第一次调用 `/look` 为准；
   - 锁的持有：延续至该轮次包括后台作业在内的整套生命周期结束；
   - 锁的防死锁：由任务进程每 30 秒发送心跳，2 分钟超时无心跳自动回收；
   - 锁的释放：由任务执行器在 `drain()`（正常收尾）或 `fence()`（取消中断）时无条件显式释放。
3. **出图四级先后（RS18-local）**：
   - 优先利用用户桌面端或电脑浏览器的高性能即时渲染，降低云端压力；
   - 本地取帧严格保持播放头不动（`keepPlayhead: true`）；
   - 严格进行版本切换迟到结果过滤：若在取帧过程中项目版本（rev）发生改变，丢弃该迟到结果并转云端重取，保证读一致性。

---

## 4. 遇到的问题与解决

1. **账号任务进程导入与配置核验**：
   - 修复 `account-task-worker-config.mjs` 中 `checkServerIdentity` 从 `'node:tls'` 正确引入，并在 `validateWorkerSettings` 中对未配置 `keyDir` 且非代理模式的 `look` 配置严守 `'account-worker-settings-look'` 报错。
2. **目录状态与多实例隔离**：
   - 移除 `hosted.mjs` 的 `viewFor` 顶层多余 `streams` 字段，保持其嵌套在 `hosted.render.streams` 下，修复 `HR5` 回归；
   - 彻底删除模块级全局 `accountRuntimes` 与 `projectChangeTriggers` 集合，改为在 `shared-service.mjs` 实例组装时将当前实例的 `accountRuntime` 传入 `hostedModule` 与 `sharedModule`，杜绝跨实例污染。
3. **票据协议与素材票据接通**：
   - 修复 `hosted.ticket` 返回的票据格式为纯 token 字符串（去除逗号与空格拼接），在 `shared-service.mjs` 与 `account-hosted.mjs` 中通过 `hasServiceTicket` 识别并放行渲染工作进程的 `promptcut.ticket.<token>` 连接；
   - 在 `shared.mjs` 的 `serviceTicket` 中补通 `accountRuntime.issueServiceAssetTicket`，并由 `authority.mjs` 在 `checkAccess` 中强制检查只读 `r` 阻断写入、且对 `media` 命名空间永远禁止写入；
   - 在 `account-hosted.mjs` 关键入口补全 `!project || project.status !== 'active'` 拒绝逻辑，防止不存在的项目越权放行。
4. **主服务代签与调度链路强化**：
   - `createWorkerMasterLookClient` 与 `account-runner.mjs` 补齐传递 `runGrantId`、`conversationId`、`assignmentDigest` 与 `signal`，确保主服务 `lookRoute` 通过文档服务校验；
   - `frame-dispatcher.mjs` 适配 `live: true` 与 `deviceKind`，未标注则安全默认为 `browser-pc` 电脑浏览器，本地异常时平滑降级至云端渲染；
   - `look-client.mjs` 补上解构漏掉的 `onProgress`，并在排队位次判定中杜绝误报；超时错误统一包含 `「渲染超时」` 并保留 `err.debug`；
   - `isolation.mjs` 实现基于 FIFO 的队列锁交接与 `unlockProject` / `cancelTurn` 清理，后台作业期间严禁空闲关停，`releaseTurn` 后立即触发 `turn-released` 排空让位（实测 1.066 秒让位）。

---

## 5. 没做成的与后续建议

1. **0.7.19 多项目渲染节点**：
   - 0.7.18 暂行按轮占用作为兜底方案。0.7.19 将实现多项目渲染节点（请求仅加载涉及的具体卡片与素材，不再独占整机/整项目），届时将彻底取消按轮占用限制。
2. **预渲染任务遇到素材服务 507 时的持久队列等待**：
   - 当前在 `server/render-node/host.mjs` 中仍将 507 记为不可重试错误，需在后续渲染重构批次中对齐持久等待逻辑。
