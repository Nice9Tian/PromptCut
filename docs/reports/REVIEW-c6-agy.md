# C6 审查报告 (docs/plan/cloud-task.md 第 6 步)

## 结论摘要
经审查，第 6 步核心结构的各项前置依赖已基本落地，但计划文档中大量引用的行号及依赖状态（如 R6、R8、A1服务端保留哈希）**已经实现或过期**。核心设计存在显著缺口：清单并发「最后写赢」规则会导致分布式产物覆盖丢失，与指纹锁机制相悖；D1（项目真身云端化）缺乏 store 操作转化及撤销语义，且会破坏 Agent 的读后写一致性。由于 M5b 队列取结果依赖于 `task.done` 与二进制字节入库，并不强依赖内容库的清单推送。建议严格拆解 C6，优先推进频道隔离与产物二进制入库，将 D1/D2 等前端重构逻辑彻底剥离出 M5b 关键路径。

## 1. 符号与行号对齐情况

### 对不上的引用
| 原引用 | 实际位置 | 说明 |
|---|---|---|
| `vite-plugin-media.ts:486` | `server/vite-plugin-media.ts` 约 515 行 | `GET /api/media/local?hashes=` 路由。 |
| `vite-plugin-media.ts:508` | `server/vite-plugin-media.ts` 约 537 行 | `/@media/<hash>` 路由。 |
| `mediaTier.ts:18` | `src/render/mediaTier.ts:37` | `playbackUrl` 函数。 |
| `snapshot-store.mjs:30` | `server/snapshot-store.mjs:32` | `mergeRanges` 函数。 |
| `snapshot-store.mjs:61` | `server/snapshot-store.mjs:66` | `snapshotTier` 函数。且原句称“对 `unknown` 回 `'none'`”**已过期**，目前 stateful 的 unknown 会返回 `'local'`（见 66-72 行）。 |
| `vite-plugin-frames.ts:53-54` | `server/vite-plugin-frames.ts:90` | `/api/media/file?path=` 的回落处理。 |
| `src/kernel/project.ts:115-118 / :140 / :142 / :151` | `src/kernel/project.ts` 116-119, 141, 143, 152 | `MediaTiers` 及对应字段的轻微偏移。 |
| `vite-plugin-ai.ts:207` | `server/vite-plugin-ai.ts:215` | `MIRRORED_TOOLS` 集合，207 行仅为机制注释。 |

### 已核对无误的引用
- `proc.ts:84 / :239`
- `TopBar.tsx:306`
- `drafts.ts:47`
- `vite-plugin-cards.ts:175 / :702 / :1197`
- `server/card-identity.mjs:99`
- `server/frame-code.mjs:71 / :75`
- `server/vite-plugin-media.ts:17 / :67 / :171 / :235`
- `server/vision/http.ts:45`（`resolveMediaUrls`）
- `src/editor/io/mediaUrls.ts:24`（标明了真实相对路径）

此外，A1 服务端关于保留 `/@media/<hash>` 的改写要求（`cloud-task.md:115`）在 `server/vite-plugin-frames.ts:84-91` 和 `server/vision/http.ts:45-60` 中**已落地**，正文相关要求已过期。

## 2. 第 6 步依赖的未落地项状态

- **`snapshot-store` 写入函数**：【已落地】。`server/snapshot-store.mjs` 中的 `commitSnapshots` 已经实现了写文件并调用 `updateIndex`，且已经包含了记录 `oversize` 字段，满足了 A3b 要求。
- **R4 (Unknown 卡片处理)**：【已落地】。`server/snapshot-store.mjs:66-72` 中，`snapshotTier` 对 stateful 的 `unknown` 已明确返回 `'local'`，这正是 `cloud-task.md:141` 中提到「这一改属于 R4 / R6 的范围」的内容，原句已过期。
- **R6 (独立渲染参数与记录)**：【已落地】。`server/frame-pipeline.mjs:141-148` 已经加了 `interactive` 参数，且 `:1100, :1111` 已将超出体积的帧记入了 `index.json` 的 `oversize`。
- **R8 (轨道流生产者与索引)**：【已落地】。`server/frame-pipeline.mjs:314` 实现了轨道流生产者 `StreamProducer`，且 `:1303` 实现了对轨道流清单 `<库根>/streams/<streamKey>/stream.json` 的扫盘恢复。
- **R 系列结论**：由于 R8 已具备 `streamKey` 和 `stream.json` 且 R4/R6 已落地，`cloud-task.md:11` 称「R2～R7 都还没做」、`:141` 以及 `:172` 和决议 4 称「键和 ref 拼法随 R8 定」**均已过期**。A3b 的 `render-manifest` 格式可以根据代码现状直接定案。
- **C3 就绪索引**：【部分落地】。`server/ready-index.mjs` 的 Hub 订阅与重建骨架已存在。缺的是 A3b 的**下载端集成**——即从素材服务拉下来的块，经 `commitSnapshots` 落盘后，发布进就绪 hub（`publishLayer`）的链路还未打通。
- **文档服务相关 (M5a 路由, 内容库)**：【未落地】。`server/docservice/` 下目前只有四个基础文件，并无通用化模块，无文档库、操作日志及 projectRev 实现，`vite-plugin-docservice.ts` 不存在。
- **C5 素材服务**：【已落地】。`server/asset-service.ts` 已经实现了 `handleComplete` 和 `chunkStatus`。

## 3. M5b 对第 6 步的真实依赖与延后项

根据主计划 M5b（Master-Execution-Plan.md 460-470 行）：
- 队列获取执行结果依靠的是通用分发的 `task.done` 信令，并在收到结果后**从素材服务下载字节**。
- 下载的字节同样需要走 `commitSnapshots` 落盘（`cloud-task.md:174` 的要求），这是 A3b 下载端和 M5b **完全共用的部分**，应归属于子阶段 2（产物字节推拉）。
- **核心结论**：M5b 并不强依赖内容库的清单推送与文档数据流重构，**M5b 仅依赖新拆分方案中的子阶段 1 和 2（以及外部的 M5a 和 C5），完全不依赖子阶段 3～6**。建议将 `Master-Execution-Plan.md:462` 改为：「前置：M5a、C5，以及 C6 的子阶段 1（频道隔离）和子阶段 2（产物字节推拉）已合入 main」。

## 4. C6 拆分建议

为了避免 M5b 被其它无关阶段（特别是文档数据流 D1/D2）拖延，请按照以下六个子阶段依次进行（前两个阶段优先保证 M5b 的运行）：

1. **子阶段 1：文档服务核心通用化与频道隔离 (`c6-channels`)**
   - **范围**：文档服务核心层通用频道隔离、背压关闭（5.1 节）。
   - **依赖**：M5a 通用化。
   - **主要改动文件**：`server/docservice/router.mjs`，`server/docservice/service.mjs`。
   - **风险**：环境差异引发 Node 崩溃。
   - **最小验收**：I1~I5 压测通过。
   - **并行**：独立于渲染层，可与 C5 并行。

2. **子阶段 2：产物字节推拉 (`c6-a3b-binary`)**
   - **范围**：A3b 的 `snap/<hash>`、`px/<hash>` 二进制产物向素材服务推送与按哈希拉取；下载端经 `commitSnapshots` 落盘并 `publishLayer` 进就绪 hub；A5 推送优先级与落盘队列。
   - **依赖**：C5。
   - **主要改动文件**：`server/frame-pipeline.mjs`，`server/asset-service.ts`。
   - **风险**：大批量产物并发推送阻塞素材服务的 I/O。
   - **最小验收**：渲染块成功上传素材服务，另一台能按哈希拉回到本地 `controls-html` / `controls-local`。
   - **并行**：此阶段完成后 M5b 即可闭环。

3. **子阶段 3：文档服务本体最小版 (`c6-doc-content`)**
   - **范围**：项目频道、`content.put/get/list` 内容库实现、操作日志落盘至 `out/docservice/<projectId>.ndjson`、`projectRev`/`cardRev` 流转机制、`vite-plugin-docservice.ts` 本地挂载。**不含 D1/D2**。
   - **依赖**：子阶段 1。
   - **主要改动文件**：文档库后端实现文件，新建 `server/vite-plugin-docservice.ts`。
   - **风险**：Vite 挂载的本地端与远程端点出现上下文数据竞争。
   - **最小验收**：前后端能顺畅通过 API 完成基本的版本日志流转，文档能通过本地与远程两种方式落地。
   - **并行**：已移出 M5b 关键路径，可独立排期。

4. **子阶段 4：清单与换机端到端 (`c6-a3b-manifest`)**
   - **范围**：`snapshot-manifest` / `render-manifest` 清单文件的写入与下载，以及 W3 端到端验收。
   - **依赖**：子阶段 2，子阶段 3。
   - **主要改动文件**：`server/frame-pipeline.mjs` 的清单层代码。
   - **风险**：清单「最后写赢」造成内容覆盖丢失。
   - **最小验收**：W3 换机端到端验收（打开同一项目取清单并复用已渲染结果）顺利通过。
   - **并行**：只有在清单机制稳固后进行。

5. **子阶段 5：编辑器数据流重构 (`c6-d-series`)**
   - **范围**：D1（Agent 直接写文档服务）、D2（页面转为监听服务端操作增量）、D4（`MIRRORED_TOOLS` 搬去 Agent 服务端）。
   - **依赖**：子阶段 3。**强烈建议与第 7b 步的 I2（先 ack、再推镜像、再查）同批或在其后做，否则 Agent 会遭遇读后写风暴。**
   - **主要改动文件**：`src/store/project.ts`，`src/store/core.ts`，`src/ai/agentBus.ts`，`src/ai/mcpExecutor.ts`，`server/docservice/` 相关路由，`server/vite-plugin-ai.ts`。
   - **风险**：撤销栈污染，操作转换 schema 不明确导致同步失败。
   - **最小验收**：Agent 直接绕过前端执行工具调用，页面无感同步变更且 `.proc` 在获取 ack 后正常保存。

6. **子阶段 6：两档素材换档与源码同步 (`c6-extras`)**
   - **范围**：A1（两档素材换档逻辑），A6（卡片源码同步）。
   - **依赖**：A1 依赖 C5；A6 依赖子阶段 3（内容库与 `cardRev`）。
   - **主要改动文件**：`src/render/mediaTier.ts`，`src/kernel/project.ts` 及其相关 UI。
   - **风险**：视频换档引发闪烁。
   - **最小验收**：编辑器能无缝在小版与原片间自动换档。

## 5. 语义冲突与设计缺口

1. **「项目真身移到文档服务」的 store 与撤销语义缺失**：
   `cloud-task.md:228` 写道「页面和其他客户端一样收操作」。真实的缺口在于：**文档服务操作的格式 / schema 在第 6 步并没有定义**。目前页面写操作依赖 `src/store/actions/*` 并被压入 `core.ts:84` 的本地 `history` 撤销栈。在 D1 后，页面的 actions 如何转译为文档服务操作？接收到的远端操作如何并入 store 而不错误污染撤销栈？撤销 / 重做语义在此处完全没有交代。
2. **Agent 读后写的时序错位 (`flushDataMirror`)**：
   对于 Agent 写后同步，`cloud-task.md:232` 指出「改由 I2 的『先 ack、再推镜像、再查』保证」。但缺口在于 **I2 属于第 7b 步的任务**。如果在第 6 步强上 D1 而不配套落实 I2，`mcpExecutor.ts:463` 的同步 `flushDataMirror` 失效后将立即导致 Agent 产生错乱的读后写幻觉。
3. **清单并发「最后写赢」与指纹锁的矛盾**：
   `cloud-task.md:168` 规定清单被并发写时「后写的赢，被覆盖的一方收到通知，不加锁、不做按帧合并」。但这与主计划中基于环境和代码片段的「指纹锁」机制产生硬冲突：如果指纹相同，不同的节点完全有可能合法得锁并独立渲染**同一张卡的两个不同区段**。如果后渲染的清单直接把前者覆盖，将导致已完成帧凭空变成盲块。必须调整此决策（见第 6 节）。
4. **本地与远程文档服务共用代码的同构难题**：
   当前 `server/docservice/service.mjs:16` 直接 `import { createServer } from 'node:http'`，在 `:19` 直接按 Node.js 相对路径载入 `../render-queue/messages.mjs`。如果挂载进 Vite 的 `vite-plugin-docservice.ts` 中，Vite 原本就持有自己绑定的 HTTP 拦截器，这将引发冲突。文档库的信令与状态机部分必须先剥离成纯逻辑核心层，而将底层传输解耦。
5. **`[DRAFT]` 协议的定案状态**：
   关于 `cloud-task.md:147` 给出的 `[DRAFT]` 清单设计（包括 `px/<hash>`、`render-manifest`、`oversize` 标记等）。实际上，如第一部分所述，`oversize` 已在 `snapshot-store` 的 `index.json` 中正式落地，而 R8 的 `streamKey` 也已在代码中落实现体。因此，大部分该草案的字段**现在就能直接定案**，只需在后续实现时微调如 `本地档键` 等特定细节，无需等到后续章节来反复 Review。

## 6. 风险最高的三处与缓解

1. **分布式分段渲染清单相互覆盖（数据丢失）**
   - **出处**：`cloud-task.md:168` 「不加锁、不做按帧合并」。
   - **风险**：指纹相同的节点并发产出同一张卡片的不同帧区段，后推的清单直接覆盖先推的。
   - **缓解**：如果要在服务端对清单执行 `mergeRanges` 的深度合并，**这需要用户明确修改文末的决议 11**。如果不改决议，替代方案是：**清单键必须按产出节点的 ID 或是指派的分段范围进行拆分**，让不同节点写入不一样的子键，最终查询时做汇总查询聚合，从而物理避开相互覆盖。
2. **Agent 读后写失效（本地撤销同步风暴）**
   - **出处**：`cloud-task.md:232` 提到用 7b 步的 I2 来填补 `mcpExecutor.ts:463` 的改动。
   - **风险**：由于 7b 步在 D1 之后，Agent 修改后还没等服务端推送更新的镜像就调用 `see_frames` 检查画面，导致拿到错误的结果而继续引发谬误编辑。
   - **缓解**：必须将 **第 7b 步的 I2「先 ack、再推镜像、再查」** 与子阶段 5 绑定落地。要求修改 `server/vite-plugin-ai.ts` 或对应 Agent 服务端钩子，在给 Agent 返回 Tool Execute ACK 之前，先利用后台 Promise 阻塞直到对应 projectRev 的镜像推送完毕。
3. **撤销栈（undo/redo）与云端真实项目源冲突**
   - **出处**：在第 6 步所有有关 D1 的描述中均未涉及 `src/store/core.ts` 的改造方案。
   - **风险**：页面的增量同步会向本地 `history` 意外注入状态，且无法处理 Agent 或多用户的并发回滚。
   - **缓解**：修改 `cloud-task.md` D 系列协议。规定 `src/store/core.ts` 不再维护含有全量对象树的本地 `history` 数组，而是将其改造为**纯服务端的动作指针表（依赖 projectRev 的回退栈）**；页面的 Undo / Redo 由纯粹本地状态恢复变更为向服务端发送 `action: "undo"` 的指令，强制下发恢复全量或逆向 patch。
