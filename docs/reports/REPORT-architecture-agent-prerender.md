# 架构评估：云端 Agent 同步链路 与 预渲染独立部署

2026-09-24，基于 `main` 的 `7d7c921`（Item 4 与方案 A 已合并）。只读评估，没有改代码。行号以该提交为准。

## 前提

目标一描述的「云端 Agent → 全局文档服务 → 本地编辑器镜像 → 预渲染 preload」链路**在代码里还不存在**。文档服务、`expectedVersion`、`projectRev`、Agent 模式的预渲染进程（`docs/plan/cloud-task.md` 的 I2）只在语义文档和计划里；`server/` 下没有文档服务的实现（计划列在 `cloud-task.md` 的步骤 6，文件标「新」）。

今天 Agent（本地 CLI 或 API 驱动）的每一次写入都走这条路：

1. 编辑器进程 `callToolInternal` 经 SSE 把调用交给页面（`server/vite-plugin-ai.ts:395`）；只读和渲染类工具（`MIRRORED_TOOLS`）在服务端对 `latestMirror()` 执行，body 里带整份项目；
2. 页面按 `TOOL_ROUTES` 改 store，回结果前 `flushDataMirror()`（`src/ai/mcpExecutor.ts:463`）；
3. 镜像推到编辑器进程，编辑器进程转发给预渲染进程；
4. 页面的 preload 调度器发出 `{session, localRev}`。

所以目标一分两部分回答：现有链路的实况，以及接入文档服务之后的推演。

## 目标一：端到端同步稳定性

### 1. 节流与防抖

| 层 | 机制 | 常量 | 结论 |
|---|---|---|---|
| store | 不合并，每次换 `project` 引用 `localRev + 1`（`src/render/dataMirror.ts:249-253`） | — | 不收束 |
| 镜像推送 | 用户编辑防抖；推送链一个在飞、至多一个排队，排队的执行时读最新状态（`dataMirror.ts:130-144`） | 250 ms | 并发工具调用被合并 |
| Agent 写入 | 每个工具调用 `flushDataMirror`，**绕过 250 ms 防抖**（`dataMirror.ts:275-282`） | — | 镜像推送次数 ≈ 工具调用次数 |
| 编辑器 → 预渲染 转发 | `forwardChain` 串行、**不合并**（`server/vite-plugin-mirror.ts`） | 每条超时 15 s | 唯一会积压的地方 |
| preload 调度器 | 防抖、单个在飞、播放和拖动时不发（`src/editor/preview/prerenderPreload.ts`） | 800 ms / 2 s / 4 s | 频率被压得很低 |
| 服务端 `preload()` | 同一 owner、同一版本直接返回；版本换了中止旧的后台代次（`server/frame-pipeline.mjs` 的 `preload`） | `PRELOAD_STALE_MS` 8 s | 不会过载 |
| 后台通道 | 串行链，被中止的代次一开始就退出 | — | 不会堆积 |

结论：

- 下发给预渲染进程的调度指令**不会过载**。
- 真正的风险是**饥饿**：Agent 两次修改的间隔略大于 800 ms 时，每一次 preload 都会中止上一趟后台任务，重卡的预渲染可能一趟都跑不完。
- 镜像转发链串行且不合并，大项目高频修改时会积压。
- 接入文档服务之后（`cloud-task.md:232`），Agent 写入不再经过页面 store，`flushDataMirror` 也就覆盖不到。那时需要在编辑器侧对文档服务下发的版本做「取最新」的合并，现在没有这一层。

### 2. 时序与竞态

不会出错的部分：

- preload 进门领号，比已记录的 localRev 更旧的一律不认，晚发出的那一版一定胜出（`server/ready-index.mjs` 的 `request` / `stale` / `adopt`）。
- 发层按 `entry.key` 过闸，旧版本晚到的层进不了会话。
- 结论：最终生效的一定是最新版本，不会出现「最终渲染的是旧版本」。

会出错或会丢的部分：

1. **预渲染进程没就绪时，转发直接丢弃，不排队**（`vite-plugin-mirror.ts` 的 `forward`）。重启后编辑器补推每个会话的最新一版，并按会话登记表（`server/ready-session-registry.mjs`，最近活跃的至多 8 个会话）串行重放 preload。中间版本丢了没有影响，preload 只要最新一版。
2. **镜像每个会话只保留 8 版**（`server/mirror-store.mjs:23`）。preload 是页面直连预渲染发的，可能比转发先到，预渲染进程于是回编辑器拉那一版；回拉之前编辑器又收了 8 次以上推送的话，那一版已经滑出窗口，回 409。页面整份重推一次，再失败就等调度器 4 s 重试。最终能恢复，但 Agent 快速连续修改时会有几秒空窗。
3. **转发遇到 409 时改发整份，那一版如果已经滑出窗口会被静默跳过**（推断）。影响只限于按那个 localRev 发的请求。
4. **与文档服务脱节无法检测**。`localRev` 是页面自己的计数，和文档服务的 `projectRev` 没有对应关系。多终端时本机最终渲染的是「本机页面最新的那一版」，它是否等于文档服务的最新版，取决于页面是否已应用全部下发，整条链上没有对账点。建议镜像版本和 preload 都带上 `projectRev`，预渲染的诊断读口把它露出来。

### 3. 端到端测试设计

- **夹具**：真实的编辑器进程和预渲染进程（起法同 `scripts/probes/ready-index-probe.mjs`），外加一个无头页面。Agent 用 `POST /api/mcp/call` 驱动；文档服务落地后换成一个假的文档服务（WebSocket 下发）。
- **故障注入**：
  - 在「编辑器 → 预渲染」和「页面 → 预渲染」两段各插一个本地 HTTP 延迟代理，注入延迟、丢包、乱序；
  - 在修改高峰中杀掉预渲染进程，时机分三种：preload 在飞、转发在飞、后台任务进行中；
  - 快速连推 8 版以上，把目标版本挤出窗口；
  - 播放中注入一连串修改。
- **场景矩阵**：连续 N ∈ {10, 50} 次工具调用，间隔 ∈ {0, 50, 200, 900} ms，与上面的故障组合。
- **断言**（安静 T 秒后）：
  - 会话的 `entryKey` 等于编辑器镜像最新版的 `frameIdentity`；
  - 就绪索引每一层的键都属于最新的计划；
  - SSE 消息里 `reset` 之后不再出现旧键的层；
  - preload 次数不超过上界 f(N)（证明收束有效）；
  - 后台任务最终 `ready`（证明没有饥饿）；
  - 没有 5xx，页面没有报错；
  - 记录转发链的最大积压。
- **要补的测试基建**：
  - 诊断读口增加镜像版本、转发队列长度、preload 计数、`projectRev`；
  - 单测补缺口：页面侧 `dataMirror`（推送链、diff 失败回退整份、重推）没有任何单测；转发、补推、回拉这一层的 HTTP 行为也没有测试。

## 目标二：预渲染独立部署

### 1. 耦合审计

两个进程之间没有 IPC 通道，也没有共享内存；有的只是 stdio 尾部捕获（只用于报错）、HTTP 和共享磁盘。耦合比「两台 HTTP 服务」紧得多。

| 类别 | 内容 | 位置 | 远端化之后 |
|---|---|---|---|
| 生命周期 | spawn 注入环境变量（`PROMPTCUT_ROLE`、`PROMPTCUT_CORS_ORIGINS`、`PROMPTCUT_EDITOR_URL`，其余整份继承）；健康检查；退避重启；每次换新端口；`taskkill` | `server/vite-plugin-prerender.ts` | 全部失效，需要独立的服务管理 |
| 编辑器 → 预渲染 | 镜像转发与补推、会话登记表的 preload 重放、成本转发、yield、layout / dom / vision 代理、Agent 工具的 `prerenderPost` | mirror / costs / frames / cards / ai 各插件 | 传输可用，但没有租户命名空间；整份项目最大 64 MB 要跨广域网 |
| 预渲染 → 编辑器 | 镜像回拉（只认一个 `PROMPTCUT_EDITOR_URL`）、preload 上报登记、素材代理 `/@media`、`/api/media/file?path=` | `vite-plugin-mirror.ts`、`vite.prerender.config.ts:63` | 失效：多个编辑器无从寻址；编辑器的 api-guard 拒绝非本机请求；桌面版只绑 127.0.0.1 |
| 页面 → 预渲染 | 帧请求、`/ready` SSE、快照与流的字节、导出（`/reveal` 打开的是预渲染所在主机的资源管理器） | `src/render/frameClient.ts`、`snapshotSource.ts`、`src/editor/io/index.ts` | 地址发现（`/api/prerender/info`）回的是回环地址；CORS 只列本机源；没有鉴权 |
| 共享文件系统 | 帧库（两个进程各建一个 `FramePipeline`、各自扫盘）；编辑器的 `/archive`、`/import` 直接读写预渲染写出的 `html-manifest.json`；`mov.hydrate` 明确依赖「另一个进程渲过的帧」；`ai-visual`、`sheets` 目录 | `server/vite-plugin-frames.ts:30`、`frame-pipeline.mjs` 的 `loadArchive` / `renderMovFrames` / `refreshSnapshots` | 失效 |
| 源码树 | `frameCode` 对整个 `src/` 取哈希并计入帧身份；卡片模块从预渲染进程自己的磁盘加载；用户卡由编辑器写进 `src/cards/user/` | `server/frame-code.mjs:28-40`、`server/vite-plugin-cards.ts` | 版本一不一致，帧身份就全部对不上 |
| 全局单例 | `latestPlayhead`（一个全局的当前会话，决定 `streamBusy` 和 `wanted`）、`this.playback`（新 owner 顶掉旧的）、`backgroundLeaseOwner`、热 Chrome 池、导出的 `lastJobId`、`prerenderState` | `mirror-store.mjs`、`frame-pipeline.mjs`、`prerender-client.mjs:13` | 多租户下互相干扰：一个人在播放，所有人的流生产都暂停 |
| 访问控制 | 预渲染绑 127.0.0.1；两端 api-guard 拒绝非回环请求；没有鉴权 | `server/http-guard.mjs`、`server/vite-plugin-api-guard.ts` | 需要重新设计 |

### 2. 状态管理怎么演进

方案 A（编辑器进程登记会话版本、预渲染重启后重放）放到远端会失效：远端没有父进程；一个预渲染服务多台编辑器；恢复所需的状态必须放在远端一个稳定的层里。

- **分层**：远端拆成常驻的网关 / 调度层和可随时重启的渲染 worker。会话登记表放在网关，内容是「租户 → 会话 → `{localRev 或 projectRev，镜像来源}`」。worker 重启后由网关串行重放 —— 等于把方案 A 平移到网关。
- **隔离**：
  - 会话键加租户前缀，鉴权令牌绑定租户；
  - 就绪索引按「租户 / 会话」分片（现在的 `createReadyHub` 可以直接沿用）；
  - `playhead`、`playback`、后台 lease、`streamBusy` 都改成每租户一份；
  - 后台通道现在是单条串行链，要改成多租户公平队列，否则会队头阻塞。
- **项目来源**：只认单一 `PROMPTCUT_EDITOR_URL` 的回拉不能再用。两个选择：只推不拉（I2 的 Agent 模式就是这样设计的：丢了回 409，由客户端重推）；或者把回拉地址也登记进网关的登记表。
- **网关自身宕机**：跨网络的服务不能假设客户端状态会被保留，这时要靠客户端「幂等地重新注册」（重连后重推镜像、重发 preload）。这是远端服务的常规契约，不是职责倒置。不能接受的话，网关就要把登记表持久化（SQLite、Redis 之类）。

### 3. 重构路径与阻力

按依赖顺序：

1. **预渲染产物改走素材服务**（语义早已要求，计划里的 A3b），编辑器不再读共享磁盘。这是其余步骤的前提。
2. **源码与卡片版本一致**：远端按编辑器版本固定代码（多个版本并存就每个版本一个 worker 池），并同步用户卡（A6）。**阻力最大。**
3. **镜像改成只推 + 租户命名空间**；补推由各编辑器自己负责。
4. **单例租户化**：playhead、playback、lease、热 Chrome 池、导出任务。改动面遍布 `frame-pipeline.mjs`。
5. **网络面**：绑定地址、CORS、鉴权令牌、api-guard、地址发现；整份项目改为只传 diff。
6. **调度**：多租户公平队列、配额、背压。
7. **网关**：登记表与故障恢复。

阻力点：

- 帧身份的哈希和本地源码绑在一起；
- 共享磁盘的依赖是隐式的（`hydrate`、`refreshSnapshots`）；
- 素材要跨广域网读，旧版按绝对路径引用的素材无法远程访问；
- 快照和流的字节现在由页面直连取，跨广域网会带来交互延迟；
- **语义冲突**：`docs/semantics/architecture/platforms.md` 和 `glossary.md` 把预渲染进程定义为「本机进程」，远端的在线重型控件渲染服务只是预留接口。按 `suggested_agent_behavior.md` 原则 2，要先改语义文档再动代码。

## 另外发现的缺陷：开发期成本记录路径不一致

没设 `PROMPTCUT_DATA_DIR` 时，两边的成本记录不在同一个文件：预渲染管线把帧库目录当 root 传进 `prerenderSetOfPlan`，于是读 `<帧库>/out/card-costs.json`；成本插件写的是 `<仓库>/out/card-costs.json`。实测成本因此影响不到预渲染集合。探针和桌面版都设了 `PROMPTCUT_DATA_DIR`，所以测不出来。修复与回归测试在分支 `claude/fix-costs-data-root`。
