# M6c：排在 M6 的推迟项：契约

状态：**定稿**（2026-09-26，主会话）。依据：主执行计划第 11.2 节里排到 M6 的七项；语义 `rendering.md`（「不同环境的结果不混用」「兜底顺序」）、`document-service.md`「渲染任务队列」。〔裁〕是主会话定的细节。

每项一个编号 X1～X7，各自的验收在本节末。

## X1 轨道流走队列

- **执行器**：`server/prerender-executor.mjs` 接受 `kind: 'stream'` 的细任务。
  - 用本机预渲染进程已有的轨道流产出路径（`frame-stream.mjs`），产出 `[from, to]` 这几段；
  - 按 C6.2 / C6.4 的规则推到素材服务（`px/` 命名空间），并写每段的清单（键 `<resultKey>:<from>-<to>`）；
  - 以 `StreamResult` 报完成；
  - 不再抛 `stream-not-supported`。
- **能力**：节点在 `node.hello` 的 `capabilities` 里报 `streams: true | false`：本机探到可用的编码器才是 `true`。
  - 流任务的 `requires.capabilities.streams = true`，节点侧过滤照此执行；
  - 纯浏览器节点一律 `false`（语义：纯浏览器没有轨道流）。
- **编码器**〔裁〕：
  - 段签名里带编码器（`segmentSignature`）。不同机器的编码器可能不同（硬件编码器与 `libx264`），但产出都是标准 H.264，解码端不在乎是哪个编码器编的。
  - 所以编码器**不进结果键、不进卡片锁**，只进清单；取用方照清单里的签名收段。
  - 同一张卡的流仍受指纹锁约束：一张卡的流只出自一种环境（语义「卡片级指纹锁」）。
- **取用**：`applyResult` 收 `StreamResult` 时经 `adoptSegments` 落地，与本机产的段在就绪索引里无差别。
- **开关**：`PROMPTCUT_STREAMS=0` 时不发布流任务，行为与 M5b 相同。

## X2 没有哈希的素材：本地档能力闸

- 细任务的输入里若有**没有内容哈希的素材**（只在发布方本机的本地档），切分时在 `requires` 里写 `localMedia: <发布方 nodeId>`。
- 只有 `nodeId` 等于它的节点能认领。别的节点在节点侧过滤里跳过；队列在前置过滤里也不发给别的节点（与 S2 的指纹前置过滤同一处，是它的扩展）。
- 取代 M5b 靠 `plan-mismatch` 兜底的做法；`plan-mismatch` 这条保留，作为纵深防御。

## X3 `watch: 'all'` 收紧

- M6a 之后，`watch: 'all'` 的范围已经限在本空间之内。再加两条：
  - 只有 `profile` 为 `pc` 或 `host` 的节点能用 `watch: 'all'`；`browser` 用了回 `forbidden`。
  - `host` 用 `watch: 'all'` 时只收第 5.1 节的项目摘要（不收单任务增量）；`pc` 保持现状，因为本机节点依赖全量。

## X4 `plan` 就近认领

- 发布方发布 `plan` 时，在 `requires` 里写 `preferNode: <发布方自己的 nodeId>`（M5b 起，预渲染进程替页面发布，所以就是本机节点）。
- 队列给 `preferNode` 一个独占窗口 `PLAN_PREFER_MS`（缺省 5000 ms）：
  - 窗口内只有它能认领；
  - 窗口过后，任何指纹符合的 `pc` 节点都能认领；
  - `host`、`browser` 始终不认领 `plan`。
- 常量进 `constants.mjs`。

## X5 本机队列节点的闲时门槛放宽

- 现在：本机队列节点要等 preload 到 `ready` 才认领。
- 改为：执行器有空位，并且最近 500 ms 没有交互帧请求（拖动、播放），就可以认领细任务。
- 用户播放或拖动时照语义让路：手里在做的做完，不认领新的。

## X6 快照 style 声明顺序确定化

- `src/render/snapshot/inlineStyles.ts` 输出内联 style 时，按属性名的确定顺序输出，与浏览器枚举 `CSSStyleDeclaration` 的顺序无关。这样同样的内容在不同进程里得到同样的块哈希。
- **像素不许变**：导出像素基线 0 差异，G0-R 全过。
- 块哈希因此会变。这是一次性的：旧缓存按「内容键 + 块哈希」照常失效重产，不需要迁移。

## X7 远端节点渲的卡在本机的 PNG

- 现在：远端节点产的卡，本机没有 PNG 缓存，`?preview=legacy` 下显示占位。
- 改为：`applyResult` 落地远端快照时，若清单里带 PNG 的哈希（C6.2 的 `px/`），一并取回，写进本机 PNG 缓存（经素材服务，语义「字节只走素材服务」）。
- 清单里没有 PNG 的，保持占位，不在本机补渲。

## 分支

| 子分支 | Agent | 内容 | 端口段 |
|---|---|---|---|
| `claude/m6c-stream` | `opus-dev-high` | X1 | 5410～5419 |
| `claude/m6c-queue` | `opus-dev-high` | X2、X3、X4、X5 | —（单测端口 0） |
| `claude/m6c-snapshot` | `opus-dev-high` | X6、X7 | 5420～5429 |
| `claude/m6c-tests` | `opus-dev` | 照本契约独立写 X1～X7 的测试 | 5430～5439 |

M6c 期间 C10、M7 还没开工，借用它们的端口段不冲突。

## 验收

| 编号 | 标准 |
|---|---|
| X1 | 开 `PROMPTCUT_STREAMS=1` 跑 `queue-mode-probe`：流任务全部经队列完成，每个恰好一次 `task.done`；另一节点取用的段与产出方的段 sha256 逐段一致；`stream-produce-probe`（含 `--group`）退出码 0 |
| X2 | 含本地档素材的项目：别的节点对这类任务的认领数为 0，收到的 `task.opened` 为 0 条；发布方节点把它们全部完成 |
| X3 | `browser` 节点 `watch: 'all'` 回 `forbidden`；`host` 用 `watch: 'all'` 时单任务增量 0 条，摘要每项目每周期至多 1 条 |
| X4 | 窗口内别的 `pc` 节点认领 `plan` 回拒绝；窗口过后能认领；`host` 与 `browser` 认领 `plan` 0 次 |
| X5 | preload 未 `ready` 时本机节点已开始认领细任务；模拟拖动期间新认领 0 次 |
| X6 | 同一内容在两个预渲染进程里生成的快照块哈希相同（10 张卡，逐张比）；`verify-determinism` 1800/1800；`verify-unified-frames` PASS；导出像素与 main 0 差异 |
| X7 | 远端节点产的卡，本机 `?preview=legacy` 下显示真实 PNG（截图贴进报告），不是占位 |
| 通用 | G0 加 G0-R；契约 F 节的 Q、N、L、W 系列不改、全过 |
