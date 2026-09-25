# M6 阶段报告：独立渲染主机、D9 共享项目的凭证与票据、M6 推迟项

2026-09-26。M6 按计划拆成三段，按顺序做、各自验收，最后一起经 W5 跨机验收后合入 main。

| 段 | 内容 | 契约 |
|---|---|---|
| M6a | D9 全部：共享项目、凭证、连接角色、按空间隔离、票据、错误限速、失败即关；集群令牌退出数据面 | `docs/plan/auth-contract.md`（含第 13 节查资料、第 14 节集成裁定） |
| M6b | 独立渲染主机（`profile: 'host'`）、代码版本过滤、多项目连接 | `docs/plan/render-host-contract.md`（含第 6 节集成裁定） |
| M6c | 第 11.2 节排在 M6 的七项：X1 轨道流走队列、X2 本地档能力闸、X3 `watch: 'all'` 收紧、X4 `plan` 就近认领、X5 闲时门槛、X6 style 顺序确定化、X7 远端卡 PNG | `docs/plan/m6c-contract.md`（含集成裁定） |

合并：`ac551a8`（main，合入 `claude/m6`）。

## 1. 基线

- **main `ac551a8`**：`npx tsc -b --force` 退出码 0；`npm test` 2653 条，2652 通过，0 失败，1 跳过（需要 5190 的那条）。
- **G0-R**（`claude/m6c-integ`，代码与合入的相同）：
  - `verify-determinism` 1800/1800；
  - `verify-unified-frames` PASS；
  - 导出像素与 main 0 差异；
  - `ready-index-probe`、`stream-produce-probe --group`、`preview-fallback-probe`（含 `--page-preload`）都退出码 0。
- **编码基准**：`stream-produce-probe`（不带 `--group`）的 1080p 编码 p50 门槛 300 ms，集成时曾测到 325、337 ms。
  - 交给 codex 在同一时段交替对照：main 平均 255.0 ms、本分支 252.6 ms，配对差 −2.4 ms（p = 0.5），10 次全过；
  - 高负载下 main 自己也到过 348 ms。
  - 裁定为机器负载所致、不是回归〔裁〕，原始数字见 `docs/reports/CODEX-m6c-encode-bench.md`。

## 2. 验收

### M6a（契约第 12 节 AU1～AU14，计划 H4～H10）

- **契约测试**：AU 64/64（对抗式：测试方只照契约写；集成时只改胶水，1 条 D 类歧义由主会话裁定）。
- **实现方自测**：41 条，全过。

### M6b（H1～H3）

- **契约测试**：RHC 20/20；实现方的 RH 测试 11 条。
- **本机探针**：`render-host-probe` 本机完整序列通过。在已含 X6 的基线上 `identicalBytes: true`。

### M6c（X1～X7）

| 项 | 证据 |
|---|---|
| X1 | `queue-mode-probe --streams --peer`：流任务全部经队列完成，另一节点取回的 12 段与产出方 sha256 逐段一致 |
| X2～X5 | 契约测试 MC-X1～X5 全过，单测 17 条全过 |
| X5 实测 | preload 开跑后 2148 ms 认领第一个细任务，这时 preload 仍停在 `html`，73.9 s 后才 ready |
| X6 | 两个预渲染进程对同一项目 300/300 帧哈希相同（main 上是 0/300） |
| X7 | `?preview=legacy` 下远端卡显示真实 PNG：截图显示取回前是沙漏占位，取回后是「R6 推帧卡」；60 张 PNG 与产出方逐字节相同 |

### W5 跨机

- **拓扑**：主 PC 192.168.50.96 是创建者，建局域网模式的共享项目；笔记本 192.168.50.247 起主机实例。
- **代码**：两边都在 `claude/m6` @ `932c72e`。
- **协调**：用 `render-host-probe --lan/--coord`。

| 编号 | 结果（原始 JSON 摘要） |
|---|---|
| H1 | r1：5 个任务，`duplicateDone 0`、`missingDone 0`；PC 2 + host-a 1 + host-b 2；`identicalBytes true`（240 帧，0 差异）；两台主机 `envFingerprint 258acaaa7c5fe509`，与 PC 相同 |
| H2 | host-c（`--code-version test-code-version-mismatch`）`claimed 0` |
| H3 | host-bad（口令错）`handshake 401`、`connected false`、`claimed 0` |
| H4 / H8 | 非回环来源：错口令 401，对口令 101；1 分钟内错 5 次后口令对了也 401；冷却期内挑战回 429；61 s 后恢复 101 |
| H7 | 非回环来源的素材：不带票据写 401、读 401；带票据写 200、读 200、Range 206；伪造票据 401 |
| H5、H6、H9、H10 | 单进程测试覆盖：AU5、AU6、AU10、AU11 |

创建者日志里被拒的握手全部来自 `192.168.50.247`，原因是 `bad-proof`、`rate-limited`、`nonce`。

## 3. 与计划不一致之处

- **M6 拆成三段**：计划写的是三条子分支，实际拆成 M6a、M6b、M6c 三段，理由是影响面大小不同。
- **口令派生函数**：scrypt 改为 PBKDF2-SHA256，60 万次。理由是浏览器没有原生 scrypt，改用 PBKDF2 就不用引依赖（codex 查资料的结论）。
- **每个主机实例只有一个代码版本**：计划原文写「按代码版本分 worker 池」，实际做成要多个版本就起多个实例（D6 本来就是两个实例）。
- **host 认领 `plan`**：现在回 `plan-profile`，由 X4 落实，推翻了 M6b 契约第 6 节原先的裁定。

## 4. 远端操作

本阶段没有动 `8.219.80.16`。W5 全程在局域网内完成。

## 5. 顾问调用记录

| 用途 | 问题 | 结论 | 采纳 |
|---|---|---|---|
| 查资料（codex） | scrypt 参数、浏览器派生函数、挑战应答、`Sec-WebSocket-Protocol`、媒体元素鉴权、HMAC 票据 | 统一用 PBKDF2-SHA256 60 万次；证明带用途前缀；票据带 `kid`、对原始段验签名；查询串票据配 `no-store` 与 `no-referrer` | 采纳；「HTTPS/WSS」不采纳（用户已接受明文）；「票据绑定单个哈希」不采纳 |
| 攻坚（codex worktree 模式） | M6c 集成后 1080p 编码基准 p50 超门槛 | 交替对照没有显著差异，是负载所致；不改代码，报告提交 `c19ea6e` | 采纳 |
| 交互与文案（Gemini） | 本阶段没有用户侧界面 | — | 没有调用：M6 全部在服务端与节点侧 |
| 发散（Gemini） | 没有走到第 3 级 | — | 没有调用 |

## 6. 遗留

排在后续阶段：
- 页面签发连接票据给本机预渲染进程：C6.5；
- 浏览器端的纯 JS 派生兜底，实现已在，接入等 C10；
- X2 判不出经图节点间接引用的本地素材：当前所有节点的 `graphCards` 都是 false，影响为零，写进了契约作为已知限制；
- X1 兜底只看整个 `plan` 有没有流任务。
