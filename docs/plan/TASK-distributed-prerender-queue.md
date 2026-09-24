# 任务书：分布式预渲染拉取式任务队列的落地

状态：**计划，未动工**（2026-09-24）。本轮只提交本文，不写生产功能代码。

- 依据：`docs/plan/distributed-prerender-queue.md`（下称「设计」，已审核）。
- 语义：`docs/semantics/architecture/document-service.md`「渲染任务队列」、`platforms.md`「渲染节点」、`rendering.md`「重管线：预渲染」与「查询渲染与预渲染进程」、`asset-storage.md`「预渲染的产物」。
- 开发规则：`docs/semantics/developer_guide.md` 索引下的 `guide_files/`，尤其是 `multi_agent.md`（子 Agent 协议）和 `verification.md`（基线）。

本文与设计冲突时以设计为准，设计与语义冲突时以语义为准。

## 1. 现状与打通顺序

### 1.1 依赖现状

| 依赖 | 在哪 | 状态 | 谁需要它 |
|---|---|---|---|
| 文档服务骨架（WebSocket、`projectRev`、`vite-plugin-docservice.ts`） | `cloud-task.md` 第 6 步 | 未开始 | 队列挂上真连接、页面发布 `plan` 任务、`task.done` 通知 |
| 素材服务空壳与底层 API | `cloud-task.md` 第 5 步 | 未开始 | 第 6 步的前提 |
| A3b 产物入素材服务 | `cloud-task.md` 第 6 步 | 未开始 | 节点「先推素材服务、收全再报完成」、开工前查素材服务去重、跨机取产物 |
| 鉴权凭证（`userId` / `tenantId`） | 文档服务的连接层 | 未设计到接口级 | 纯浏览器节点的用户边界（设计 Q2） |
| 在线浏览器模式 L1 / L2 | `cloud-task.md` 第 10 步 | 未开始 | 纯浏览器节点 |

### 1.2 结论：先做纯内存队列本体（设计第 9 节步骤 2）

**是，优先推进。** 理由：

1. **它不依赖任何未落地的东西。** 设计把队列定为「只记账、只在内存里、单线程同步处理」，本体就是一个纯状态机：输入是「某条连接发来一条消息」和「时钟走到某一刻」，输出是「给某条连接发一条消息」。传输、鉴权、产物存储都可以在接口外面，用假件替代。
2. **它是后面所有步骤的契约中心。** 节点侧、页面侧、文档服务的挂载都照它的消息格式写。先把状态机和第 5 节容错表钉死在测试里，后面几步改的都是外围。
3. **不影响基线。** 本体是一个新模块，这一阶段不被任何插件引用，运行时行为不变，只多一批单测。
4. **风险最集中的部分最早验证。** 乐观锁、令牌栅栏、租约回收、断开宽限、重启 epoch 都在本体里。

同样不依赖前置、可以并行先做的，还有节点侧的纯逻辑：环境指纹、能力过滤、候选挑选、`plan` 任务的切分函数。这些见 M2。

必须等前置的是：挂上文档服务的真连接（M5）、产物走素材服务（M5）、独立渲染主机（M6）、纯浏览器节点（M7）。

### 1.3 总顺序

```
M0 本文 ──► M1 队列本体 ─┬─► M3 进程内联调（本机节点 × 队列，假传输）──┐
            M2 节点纯逻辑 ┘                                              │
            M4 环境指纹进结果键（本机，独立于文档服务）──────────────────┤
                                                                         ▼
      [外部前置] cloud-task 第 5 步 ─► 第 6 步（文档服务 + A3b）──► M5 挂上文档服务
                                                                         │
                                                  M6 独立渲染主机 ◄──────┤
                                   [cloud-task 第 10 步] ─► M7 纯浏览器节点 ◄┘
                                                                         │
                                                                   M8 分布式端到端验收
```

## 2. 阶段划分

| 阶段 | 输入 | 输出 | 依赖 | 验收 |
|---|---|---|---|---|
| **M0 任务书** | 设计、语义 | 本文 | — | 用户审核 |
| **M1 队列本体（设计步骤 2）** | 设计第 3、4、5、8 节；本文第 4 节的接口契约 | `server/render-queue/` 纯模块；第 5 节矩阵全部用例 | M0 | 第 5 节矩阵全绿；`npx tsc -b --force` 零错误；`npm test` 零失败；本体不被任何插件引用 |
| **M2 节点纯逻辑** | 设计第 2、2.1、4.3、4.4 节；现有 `card-cache.mjs` 的 plan 输出形状 | `server/render-node/` 的纯函数：环境指纹、能力过滤、候选挑选（前 K 随机）、`plan` → 细任务切分、节点端会话状态机（认领、续约、让路、放回，传输用接口注入） | M0；契约来自 M1 定稿的消息格式 | 切分函数对现有 card plan 夹具的输出与设计第 2 节段长一致；过滤覆盖 4.3 的规则 0～6；节点状态机对 M1 的假队列跑通 |
| **M3 进程内联调** | M1、M2 | 本机预渲染进程作为节点接到**进程内**的队列上（假传输 + 假产物去重接口），`preload` 仍是默认路径，队列路径在开关后面 | M1、M2 | 两个进程内节点抢同一批任务，每个任务恰好完成一次；中途「断开」一个节点，宽限期后另一个接手；现有探针（`ready-index-probe`、`preview-fallback-probe`）照旧通过 |
| **M4 环境指纹进结果键** | 设计 2.1；`TODO.md`「语义与代码的差距」那一条 | 本机的共享键、本地档键、流键乘上指纹；缓存整体换键一次 | M2 的指纹函数 | 基线全绿；`verify-determinism`、`verify-unified-frames` 通过；`ready-index-probe`、`stream-produce-probe` 通过；导出像素基线不变（指纹只影响预渲染键，不影响导出） |
| **M5 挂上文档服务** | M1～M4；cloud-task 第 6 步交付的文档服务与 A3b | 队列挂到文档服务的 WebSocket；凭证落到 `source.userId` / `tenantId`；页面 `preload` 改为发布 `plan` 任务；节点先推素材服务、收全再报完成；本机就绪索引订阅 `task.done`；离线回落到现在的本机路径 | cloud-task 第 5、6 步 | 本文第 6 节的端到端用例 E1～E6；离线回落用例；基线与探针全绿 |
| **M6 独立渲染主机** | M5 | 无编辑界面的预渲染进程形态、按代码版本分 worker 池、节点鉴权与按 `tenantId` 授权 | M5 | 两台主机加一台本机 PC 同时取活，结果正确；代码版本不同的任务不被认领 |
| **M7 纯浏览器节点** | M5；cloud-task 第 10 步 L1 / L2 | 后台舞台作为节点认领快照任务 | M5、L1、L2 | 纯浏览器只见本人任务（Q2）；只认领 `light` / `medium` 快照任务 |
| **M8 分布式端到端验收** | M5～M7 | 端到端探针与报告 | 全部 | 本文第 6 节全部用例 |

**每个阶段结束都按协作闭环走**：对齐 → 执行 → 验证 → 汇报 → 用户决定；合并进 main 须用户授权。M1 之后每个阶段开工前单独下发指令，本文不自动授权后续阶段。

## 3. 智能体分工

按 `guide_files/multi_agent.md`：每个子 Agent 一个 worktree、一个分支；文件清单互不重叠；端口按 10 个一段，避开 5190～5192（用户常驻）、5203～5205（`dev-test`）、5230～5232（探针惯用）；子 Agent 不建 `node_modules` 的 junction、不推送、不合并。

### 3.1 角色

| 角色 | 职责 | 不做什么 |
|---|---|---|
| **主 Agent（Coordinator）** | 定稿第 4 节的接口契约；派活、回收；逐个读 diff；在集成分支上重跑基线；裁决「实现与测试不一致时谁对」（以设计为准）；向用户汇报、申请合并 | 不写生产代码和测试（仲裁需要时可以改契约文档） |
| **Protocol/State Agent** | 队列本体：状态机、乐观锁、令牌栅栏、租约扫描、断开宽限、epoch、订阅、可见性（纯浏览器只见本人任务）、上限与 TTL、诊断；消息格式校验；常量表 | 不碰传输、不碰节点侧、不写 `server/test/` |
| **Pipeline/Node Agent** | 节点侧：环境指纹、能力过滤、候选挑选、`plan` 切分、节点会话状态机；M3 起接本机预渲染进程；M4 的换键 | 不碰 `server/render-queue/`、不写 `server/test/` |
| **Verification/Test Agent** | 按设计和本文**独立**写测试（不看实现先写），维护假件（假时钟、假连接、假产物库）；第 5 节矩阵；M3 起的进程内联调测试；M5 起的端到端探针 | 不改生产代码；发现实现与设计不符时写进报告，不自己修 |

「独立写测试」是刻意的：测试照设计写、实现照设计写，两边在集成时对账，等于一次对抗审查。

### 3.2 文件清单（互不重叠）

| 角色 | M1 | M2 | M3 起（预留，开工前再确认） | 端口段 |
|---|---|---|---|---|
| Protocol/State | 新建 `server/render-queue/queue.mjs`（状态机）、`server/render-queue/messages.mjs`（消息格式与校验）、`server/render-queue/constants.mjs`（设计第 8 节常量表，含以后的环境变量名）、`server/render-queue/index.mjs`（出口） | — | M5：`server/render-queue/ws-adapter.mjs`（挂文档服务的适配层）；挂载点在 cloud-task 第 6 步的 `vite-plugin-docservice.ts`，届时由主 Agent 协调改动范围 | 不需要 |
| Pipeline/Node | — | 新建 `server/render-node/fingerprint.mjs`、`server/render-node/filter.mjs`、`server/render-node/pick.mjs`、`server/render-node/split.mjs`、`server/render-node/session.mjs`、`server/render-node/index.mjs` | M3：`server/frame-pipeline.mjs` 里节点接入的那一段（新方法，开关后面）、`server/render-node/local-node.mjs`；M4：`server/card-cache.mjs`、`server/card-identity.mjs`、`server/frame-stream.mjs` 的键计算（开工前逐文件确认） | 5240～5249 |
| Verification/Test | 新建 `server/test/render-queue-state.test.mjs`、`server/test/render-queue-fault.test.mjs`（第 5 节矩阵）、`server/test/render-queue-protocol.test.mjs`、`server/test/fake-render-queue-env.mjs`（假时钟、假连接、消息收集器） | 新建 `server/test/render-node-logic.test.mjs`、`server/test/render-node-session.test.mjs` | M3：`server/test/render-queue-inproc.test.mjs`；M5 起：`scripts/probes/render-queue-e2e.mjs`、`scripts/probes/render-queue-proxy.mjs`（延迟 / 丢包代理） | 5250～5259 |
| 主 Agent | `docs/plan/TASK-distributed-prerender-queue.md`（本文）、`docs/plan/TODO.md`、各阶段报告 `docs/reports/REPORT-render-queue-<阶段>.md` | 同左 | 同左 | — |

测试文件平铺在 `server/test/` 下，因为 `npm test` 只收 `server/test/*.test.mjs`，不进子目录；假件照现有的 `fake-runner.mjs` 命名成 `fake-*.mjs`。

### 3.3 分支与节奏（M1 为例）

- 分支：`claude/rq-m1-state`（Protocol/State）、`claude/rq-m1-tests`（Verification/Test），同时开工。
- 第 4 节契约由主 Agent 在派活前定稿，两边只照它写。契约要改，只能由主 Agent 改本文并同时通知两边。
- 两边各自提交、各写报告（`multi_agent.md`：开工先建报告并提交一次，每完成一块提交一次）。
- 主 Agent 收回后建集成分支 `claude/rq-m1`，先合 `state` 再合 `tests`（文件不重叠，不会冲突），跑矩阵：
  - 失败的用例逐条裁决：实现不符设计的退回 Protocol/State；测试不符设计的退回 Verification/Test；设计本身有歧义的，主 Agent 更新设计与本文、报用户。
- 全绿、基线全绿后向用户申请合并 main。
- M2 可以和 M1 同时开工：Pipeline/Node 只依赖第 4 节定稿的消息格式，不依赖 M1 的实现；节点会话状态机的测试先对着 Verification/Test 的假队列跑。

## 4. M1 接口契约（派活前定稿）

```js
// server/render-queue/index.mjs
export function createRenderQueue(options): RenderQueue;

options = {
  now: () => number,                 // 注入时钟；测试用假时钟，生产用 Date.now
  send: (connId, message) => void,   // 队列只经它往外发消息；不认识传输
  constants?: Partial<Constants>,    // 覆盖设计第 8 节的基线值（测试用小值）
  epoch?: string,                    // 缺省随机生成；新实例 = 新 epoch（模拟文档服务重启）
}

RenderQueue = {
  connect(connId, principal),        // principal = { userId, tenantId }，来自连接凭证（M1 由调用方给）
  disconnect(connId),                // 连接断开；宽限计时从这一刻起
  handle(connId, message),           // 处理一条入站消息（设计 4.1 的节点侧与发布方侧消息）
  tick(),                            // 时钟推进后调用：扫租约、扫宽限、扫停滞、扫 DONE_TTL
  describe(),                        // 诊断：epoch、每个任务的 state/version/claim/attempts、每条连接的角色
  readonly epoch: string,
}
```

- **单线程同步**：`handle` 与 `tick` 都是同步函数，执行中不让出事件循环。乐观锁的「比对再加锁」靠这一点成立。
- **不读环境变量、不开计时器**：计时由调用方驱动 `tick()`；M5 的适配层才按 `SWEEP_INTERVAL_MS` 起真计时器。常量表 `constants.mjs` 里写好以后的环境变量名，M1 不读。
- **消息**：字段与设计 4.1 的三张表一致。另定两条：
  - 入站消息格式不对，回 `{ type: 'error', reqId, reason: 'bad-message', detail }`，不改状态；
  - 每条出站消息都带 `epoch`。
- **身份**：节点的 `profile` 来自 `node.hello`；`userId` / `tenantId` 只认 `connect` 时给的 `principal`，消息里自报的忽略。
- **可见性**：`profile: "browser"` 的连接收到的 `queue.snapshot` 和增量消息，只含 `source.userId` 等于它 `principal.userId` 的任务。

## 5. M1 详细任务拆解与测试用例矩阵

### 5.1 任务拆解（Protocol/State Agent）

| 编号 | 内容 | 对应设计 |
|---|---|---|
| S1 | `constants.mjs`：第 8 节常量表的基线值与以后的环境变量名；`createRenderQueue` 合并 `options.constants` | 第 8 节 Q4 |
| S2 | `messages.mjs`：入站消息的字段校验（类型、必填、`id` 形状 `<kind>:<resultKey>:<from>-<to>` 或 `plan:<projectId>@<projectRev>`）；出站消息构造（统一带 `epoch`） | 4.1、第 2 节 |
| S3 | 任务表与发布：`task.publish` 幂等合并（新建 → `open`；已存在 → 加订阅者；已 `done` 且未过 `DONE_TTL` → 立即回 `task.done`）；`source.userId` / `tenantId` 由 `principal` 覆盖；每项目未完成任务上限 `MAX_TASKS_PER_PROJECT`，超出回 `error: 'limit'` | 第 2、3 节 |
| S4 | `task.unsubscribe`：移除订阅；无订阅者的 `open` 任务删除；`claimed` 的留着做完，完成后不通知 | 4.1 |
| S5 | 节点报到与订阅：`node.hello` 记 `profile`、`envFingerprint`、能力（只记录不判断）；`queue.watch` 后回 `queue.snapshot`（按可见性过滤） | 4.1、4.3 规则 0 |
| S6 | 认领：设计 4.2 的伪代码逐行实现，含 `forbidden`（纯浏览器跨用户）、`taken`、`stale`、`gone`；成功后 `version += 1`、`token = version`、租约起算；广播 `task.taken` | 4.2 |
| S7 | 令牌栅栏：`task.progress`（续约 + 记 `progress`）、`task.complete`（→ `done`，通知订阅者 `task.done`，广播 `task.closed`）、`task.release`（→ `open`，`attempts` 不加）、`task.fail`（`attempts += 1`，到上限 → `failed` 并通知订阅者，否则 → `open`）；令牌不符一律回 `task.lease-lost`、不改状态 | 4.1、4.2、第 5 节 |
| S8 | `tick()` 的四项扫描：租约到期、宽限期到期、进度停滞、`DONE_TTL` 到期；回收时 `version += 1`、`claim = null`、`attempts += 1`，广播 `task.opened`，给原认领者发 `task.lease-lost` | 第 5 节 |
| S9 | 连接生命周期：`disconnect` 起宽限计时；宽限内同 `nodeId` 重连且 `hello.resume` 带有效 `{id, token}` → 接续，否则到期回收；发布方断开 → 宽限后移除订阅并按 S4 处理 | 第 5 节 |
| S10 | epoch：实例创建时生成；`hello` 回包带 `epoch`；`resume` 里的认领在本实例不存在时回 `task.lease-lost { reason: 'epoch' }` | 第 5 节「文档服务重启」 |
| S11 | `describe()` 诊断输出 | — |

每一项做完提交一次；报告写进 `docs/reports/REPORT-render-queue-m1-state.md`。

### 5.2 测试用例矩阵（Verification/Test Agent）

约定：

- 用 `fake-render-queue-env.mjs` 的假时钟；常量用基线值。`LEASE 30 s`、`GRACE 10 s`、`STALL 120 s`、`MAX_ATTEMPTS 3`、`SWEEP 5 s`，由测试手动调 `tick()`。
- 每条用例都要断言三样：任务状态（`state` / `version` / `claim` / `attempts`）、发给每条连接的消息、`describe()` 与前两者一致。
- 编号 `F<行>.<序>` 严格对应设计第 5 节容错表的行序（F1 = 第 1 行「认领者 WebSocket 断开」……F9 = 第 9 行）；`P*` 是支撑容错表的协议用例。

#### 容错表用例（`server/test/render-queue-fault.test.mjs`）

| 编号 | 设计第 5 节的行 | 前置 | 操作 | 期望 |
|---|---|---|---|---|
| F1.1 | 认领者 WebSocket 断开 | 节点 A 认领 T（token=t1） | A `disconnect`；推进 9.9 s，`tick` | T 仍 `claimed`，认领者仍是 A；无广播 |
| F1.2 | 同上 | 同 F1.1 | A 断开；5 s 后以同一 `nodeId` 重连，`hello.resume=[{T, t1}]` | 接续成功：T 仍 `claimed`、token 仍 t1、`leaseUntil` 不变；A 之后的 `progress(t1)` 被接受 |
| F1.3 | 同上 | 同 F1.1 | A 断开；推进 10.1 s，`tick` | T → `open`，`version += 1`，`claim = null`，`attempts = 1`；watch 者收到 `task.opened` |
| F1.4 | 同上 | 同 F1.3 之后 | A 以同一 `nodeId` 重连，`resume=[{T, t1}]` | 回 `task.lease-lost`；T 仍 `open`（或已被别人认领），不变 |
| F1.5 | 同上 | A 认领 T1、T2 | A 断开，宽限到期 | T1、T2 都回 `open`，各自 `version += 1` |
| F1.6 | 同上 | A 认领 T；另一个 `nodeId` 的 B 在宽限期内报到 | B `resume=[{T, t1}]` | 回 `lease-lost`（令牌属于 A，不认别的节点） |
| F2.1 | 处理超时 | A 认领 T，`leaseUntil = t0+30 s` | 推进 29.9 s，`tick` | T 仍 `claimed` |
| F2.2 | 同上 | 同上 | 推进 30.1 s，`tick` | T → `open`，`attempts = 1`，`version += 1`；A 收到 `task.lease-lost`；watch 者收到 `task.opened` |
| F2.3 | 同上 | A 认领 T | 每 10 s 发一次 `progress(t1, done 递增)`，共 5 次（50 s） | `leaseUntil` 每次顺延到 `now + 30 s`；50 s 后 T 仍 `claimed` |
| F2.4 | 同上 | A 认领 T | 推进 20 s；发 `progress`；再推进 25 s，`tick` | 续约生效，T 仍 `claimed`（未超时） |
| F3.1 | 进度停滞 | A 于 t=0 认领 T | 从 t=10 s 起每 10 s 发一次 `progress(t1, done=24)`（`done` 不变），每次后 `tick` | 停滞计时从 `done` 最后一次变化（t=10 s 第一次报 24）起算：t=130 s 之前不回收；t=130 s 之后的第一次 `tick` 把 T 回 `open`，`attempts = 1`，A 收到 `lease-lost` |
| F3.2 | 同上 | 同上 | `done` 在 t=100 s 变成 25，之后不变 | 停滞计时从 t=100 s 重新起算：t=220 s 之前不回收，之后的第一次 `tick` 回收 |
| F3.3 | 同上 | A 认领 T，从未发过 `progress` | 推进 30.1 s | 按租约到期回收（F2.2），不需要等 `STALL` |
| F4.1 | 反复失败的任务 | T `open` | A 认领 → `fail(retryable)`；B 认领 → `fail`；C 认领 → `fail` | 第 1、2 次后 T → `open`（`attempts` 1、2）；第 3 次后 → `failed`；订阅者收到失败通知，带 `lastError` |
| F4.2 | 同上 | T `attempts = 2`（先前两次超时回收） | A 认领后超时 | 第三次回收把 T 推到 `failed`：超时、断开和 `fail` 共用一个 `attempts` |
| F4.3 | 同上 | T `failed`，未过 `DONE_TTL` | 同一发布方再 `publish` 同一 `id`；再推进到 `DONE_TTL` 之后发布一次 | TTL 内：仍是 `failed`，回包说明 `failed`，不重新打开；TTL 后：旧任务已删除，新发布成为新的 `open` 任务（见第 8 节 C1） |
| F4.4 | 同上 | T `failed` | 发布方 `publish` 不同 `id` 的新任务（代码或源码换版本后结果键变了） | 新任务正常 `open`，与 T 无关 |
| F4.5 | 同上 | A 认领 T | A `release(t1)` | T → `open`，`attempts` **不加**（主动让路不算失败） |
| F5.1 | 晚到的完成报告 | A 认领 T(t1)；超时回收；B 认领 T(t2) | A 发 `complete(t1)` | 回 A `lease-lost`；T 仍 `claimed` by B、token t2；订阅者**没有**收到 `task.done` |
| F5.2 | 同上 | 同上 | B 发 `complete(t2)` | T → `done`；订阅者收到一次 `task.done`；watch 者收到 `task.closed` |
| F5.3 | 同上 | T 已 `done` | 任何节点再发 `complete`（任何令牌） | 回 `lease-lost`；不重复通知 |
| F5.4 | 同上 | A 认领 T(t1)，超时回收，T `open` | A 发 `progress(t1)` 或 `release(t1)` | 回 `lease-lost`；T 仍 `open`，`version` 不变 |
| F6.1 | 节点推产物推到一半就崩了 | A 认领 T，发过 `progress`，之后既不 `complete` 也不断开（进程卡死） | 推进到租约到期，`tick` | T → `open`，可被重新认领。队列侧只保证「没有 `complete` 就不算完成」；「产物收全才报完成」和「开工前查素材服务」在节点侧与 M5 验证 |
| F6.2 | 同上 | A 认领 T | A 断开且不回来 | 宽限到期回收（同 F1.3），T 没有中间态 |
| F7.1 | 发布方断开 | 发布方 P 发布 T1（`open`）、T2（被 A 认领）；P 是两者唯一的订阅者 | P 断开；宽限到期，`tick` | T1 删除（watch 者收到 `task.closed`）；T2 保留，仍 `claimed` |
| F7.2 | 同上 | 同 F7.1 之后 | A `complete(T2)` | T2 → `done`；**不发** `task.done`（没有订阅者）；`DONE_TTL` 后删除 |
| F7.3 | 同上 | T 有两个订阅者 P、Q | P 断开，宽限到期 | T 保留，订阅者只剩 Q；T 完成时只通知 Q |
| F7.4 | 同上 | P 断开 | 宽限期内以同一身份重连 | 订阅保留，不删任务 |
| F8.1 | 文档服务重启 | 实例 Q1：P 发布 T，A 认领 T(t1) | 丢弃 Q1，建新实例 Q2（新 epoch）；A、P 连上 Q2 | `hello` 回包的 `epoch` 与 Q1 不同；Q2 的任务表为空 |
| F8.2 | 同上 | 同 F8.1 | A 在 Q2 上 `resume=[{T, t1}]` | 回 `lease-lost { reason: 'epoch' }` |
| F8.3 | 同上 | 同 F8.1 | P 在 Q2 上重新 `publish` T | T 在 Q2 上 `open`，`version` 从初值起；A 能正常认领 |
| F8.4 | 同上 | Q1 上 T 已 `done` | P 在 Q2 上重新 `publish` T | T 在 Q2 上是 `open`（Q2 不知道 Q1 的完成）。**这正是节点开工前要查素材服务的原因**，在 M5 验证 |
| F9.1 | 宽限期里两个节点都以为持有同一个任务 | A 认领 T(t1) 后断开 | 宽限期内 B `claim(T, expectVersion=当前)` | 回 B `taken`（T 仍 `claimed`） |
| F9.2 | 同上 | 同上，宽限到期回收 | B 认领 T → t2；A 重连 `resume=[{T, t1}]` | A 收到 `lease-lost`；只有 B 持有 T |
| F9.3 | 同上 | 同 F9.2 | A 用 t1 发 `complete` | `lease-lost`，T 仍由 B 持有；最终只有 B 的 `complete` 生效，订阅者只收到一次 `task.done` |

#### 协议用例（`server/test/render-queue-protocol.test.mjs`）

| 编号 | 内容 | 期望 |
|---|---|---|
| P1 | 两个节点对同一个 `open` 任务、同一 `expectVersion` 连续 `claim`（同一轮事件循环里先后到达） | 先到的 `claimed`，后到的 `taken`；`version` 只加一次 |
| P2 | 节点拿旧 `expectVersion` 认领（任务回收又重开过） | `stale`，回包带当前 `version`；用新版本再认领成功 |
| P3 | 认领不存在的任务 | `gone` |
| P4 | `profile: "browser"` 的节点认领别人的任务（同租户不同用户） | `forbidden`；状态不变 |
| P5 | `profile: "browser"` 的节点 `watch` | `queue.snapshot` 与增量只含本人任务；别人任务的 `opened` / `taken` / `closed` 都收不到 |
| P6 | 本机 PC / 独立主机 `profile` 认领别人（同租户）的任务 | 成功（Q2 的边界只管纯浏览器；按租户授权在 M6） |
| P7 | 消息自报 `userId` 与 `principal` 不同 | 以 `principal` 为准 |
| P8 | 同一 `id` 重复 `publish` | 不新建；订阅者合并；`open` 任务数不变 |
| P9 | 已 `done`、未过 `DONE_TTL` 的任务被再次 `publish` | 立即回 `task.done`；过了 TTL 再发布 → 新的 `open` 任务 |
| P10 | 每项目未完成任务达到 `MAX_TASKS_PER_PROJECT` | 再发布回 `error: 'limit'`；`done` 的不计数 |
| P11 | `unsubscribe` 让 `open` 任务没有订阅者 | 删除并广播 `task.closed` |
| P12 | 入站消息缺字段、`id` 形状不对、未知 `type` | `error: 'bad-message'`，状态不变 |
| P13 | 所有出站消息 | 都带当前 `epoch` |
| P14 | `options.constants` 覆盖 | 覆盖值生效，其余保持基线 |

#### 状态机用例（`server/test/render-queue-state.test.mjs`）

| 编号 | 内容 |
|---|---|
| S-1 | 合法转移全集：`open → claimed`（claim）、`claimed → open`（release / 超时 / 停滞 / 宽限 / 可重试的 fail）、`claimed → done`（complete）、`claimed → failed`（attempts 到上限）；其余转移一律不发生 |
| S-2 | `version` 严格单调：每次状态变化恰好加一；`token` 等于认领那一刻的 `version` |
| S-3 | `describe()` 与内部状态逐字段一致 |
| S-4 | 随机操作序列（固定种子，至少 2000 步：发布 / 认领 / 续约 / 完成 / 放回 / 失败 / 断开 / 重连 / 推进时钟）下的不变量：任何时刻一个任务至多一个有效令牌；`done` 的任务只通知一次；`claimed` 的任务一定有 `leaseUntil > 认领时刻`；纯浏览器连接从未收到别人任务的消息 |

### 5.3 M1 的验收

- 5.2 三张表的全部用例通过。每条 `F*` 用例在测试名里写上它的编号和容错表的行名，便于对账。
- `npx tsc -b --force` 零错误；`npm test` 零失败。
- `server/render-queue/` 不被任何插件引用：`rg "render-queue" server/*.ts server/*.mjs` 只命中测试。所以运行时行为不变，导出与渲染的验证项（`verify-determinism`、`verify-unified-frames`、探针）不用跑。报告里写明没跑、为什么。
- 派活前，第 7 节的 C1～C6 已经用户确认、折回设计。
- 两个子 Agent 的报告，加主 Agent 的集成报告 `docs/reports/REPORT-render-queue-m1.md`：
  - 矩阵每条的结果；
  - 裁决过的「实现与测试不一致」各条及理由；
  - 对设计的更正建议。

## 6. 端到端用例清单（M5 起，Verification/Test 维护）

- **E1**：两个本机节点加一个进程内的第三节点抢 50 个任务，每个任务恰好完成一次，产物都在素材服务里。
- **E2**：认领中途断网（代理丢包），宽限期后被别的节点接手。
- **E3**：文档服务重启，发布方重新发布，全部完成。已在素材服务里的任务开工前查到、直接完成，不重渲。
- **E4**：Agent 突发 50 次修改（间隔 0 / 200 / 900 ms），最终会话的版本与文档服务一致，后台任务不饥饿。
- **E5**：纯浏览器节点只见本人任务；同租户另一用户的任务它看不到也认领不到。
- **E6**：两种环境指纹的节点同时在线，同一版项目的所有细任务只被与 `plan` 认领者同指纹的节点认领。

## 7. 对设计的补充（2026-09-24 用户已确认，已折回设计第 5.1 节）

矩阵要能判对错，下面几处设计原先没有写死，本文按最保守的读法定下，用户已全部采纳。

| 编号 | 问题 | 暂定 | 涉及用例 |
|---|---|---|---|
| C1 | `failed` 的任务留多久 | 和 `done` 一样留 `DONE_TTL`：TTL 内重复发布回「已失败」，不重新打开；TTL 后删除，再发布就是新任务（给「环境临时出问题」留一次重试机会） | F4.3 |
| C2 | 主动放回（`task.release`）算不算一次失败 | 不算，`attempts` 不加。放回是让路（用户开始播放），不是做不了 | F4.5 |
| C3 | 超时、断开回收和 `task.fail` 是否共用 `attempts` | 共用。三者都是「这个节点没做完」，到 `MAX_ATTEMPTS` 一律进 `failed` | F4.2 |
| C4 | 别的 `nodeId` 拿着令牌 `resume` | 拒绝。令牌和认领它的 `nodeId` 绑定 | F1.6 |
| C5 | 发布方断开的宽限期 | 与节点共用 `RECONNECT_GRACE_MS` | F7.1～F7.4 |
| C6 | 入站消息格式不对、每项目上限 | 回 `error`（`bad-message` / `limit`），不改状态；所有出站消息带 `epoch` | P10、P12、P13 |

## 8. 本文不管的

- cloud-task 第 5、6、10 步本身（文档服务、素材服务、A3b、在线浏览器模式）按它们自己的计划做。本文只在 M5、M7 接它们的交付物。
- 鉴权凭证的具体形式（令牌格式、签发）。本文只要求连接层能给出 `principal = { userId, tenantId }`。
