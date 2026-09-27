# AGENT 报告：c66-host-cards（独立渲染主机不再因用户卡分池）

分支 `claude/c66-host-cards`，worktree `.worktrees/c66-host-cards`，起点 `claude/c66-t9` 的 `5adf498`（含 C6.6 集成与 T9 探针）。不推送、不合并。

T9 指 C6.6 设计稿（`docs/plan/c66-design.md`）第 6 节验收表第 9 条：创建者、观察端、独立渲染主机三方跨机一起跑的验收。

**状态：代码、单测、契约改完，基线全绿（第 3 节）。T9 本机替身跑了一轮：失败的只有任务书说的两个已知问题。因为 plan 切不出任务，「主机认领并完成」这一条没能在真编辑器里验到，改由单测验（第 4 节）。**

## 1. 冲突与改法（按语义改代码，语义没改）

- **语义**：独立渲染主机「能认领：全部」（`product/platforms.md`「渲染节点」）；每个任务标明要什么能力，节点按自身能力过滤（`mechanism/document-service.md`「渲染任务队列」）；用户卡与改过的卡的源码经内容库 `card-source` 同步，另一端自动装上（`c66-design.md` 第 5 节）。`mechanism/rendering.md` 另说「键相同的结果在哪台节点上产出都可以互相替用，前提还有节点渲染用的代码和卡片源码与发布方一致」。
- **原来的代码**：`frameCode(root)` 哈希整个 `src/`（含 `src/cards/user/*.tsx` 与 `_scopes.json`），节点按它分池。创建者本检出里多一张用户卡，另一台机器上的主机就一个任务都认领不了。
- **改后**：
  1. `frameCode` 不含 `src/cards/user/` 下除装载入口 `index.ts` 以外的文件；改动层本来就不在里面（在数据目录）。另把换行统一成 LF 再哈希（见第 5 节第 3 条）。
  2. 卡片代码单独算一个身份（`vite-plugin-cards.ts` 的 `cardCodeIdentity`）：定义文件加它一路 import 到的卡片 / 部件文件，逐个记「仓库相对路径 + 生效内容（改动层优先）的内容哈希」，整体 sha256 取前 32 位。内容哈希与内容库同一算法，同步过来的卡两端算出同一个身份。用户卡、闭包里有改动层文件的卡算「定制卡」。
  3. 任务上：切分时 `requires.cardSources` 写定制卡的身份。共享档只写这张卡自己的；本地档与轨道流写这一版全部定制卡的（它们画整个场景，本地档的内容键里有 `entry.key`）。
  4. 节点上：`cardSourceVersions`（契约 B.2 本来就有的字段，原来没人填）改成现取现算的视图，每一拍认领时按本机此刻的文件算。本机没有这份代码就按过滤规则 1 `card-source` 不认领，不报错；装上之后下一拍就能认领。卡片源码刚变过的 1.5 s 内一张也不报，等 Vite 作废模块，免得按旧代码渲。
  5. 主机上：每个项目的 `render` 连接上挂一条只读的卡片同步（`createHostCardSync`，`card-sync.mjs` 加 `readOnly`），装进主机自己的改动层；别人改了卡按 `content.watch` 当场装。

### `frameCode` 用在哪、怎么判

| 位置 | 当作什么 | 改不改 |
|---|---|---|
| `vite-plugin-frames.ts` PC 节点 `node.hello.codeVersions`、`planTaskOf` 的 `requires.codeVersion`、代码变了重新报到 | 代码版本 / 池 | 跟着改（不含用户卡）。这正是要改的地方 |
| 同上，独立渲染主机 `startHostNode` 的 `codeVersions` 与代码变了重新报到 | 代码版本 / 池 | 同上 |
| `local-node.mjs` → `splitPlan` 的 `codeVersion`（细任务的 `requires.codeVersion`） | 代码版本 / 池 | 同上 |
| `frameService` 的 `code` → `FramePipeline.entry()` 的 `frameIdentity(project, code)`（整场景键：整场景帧库、MOV、`trackPrefixes`，以及本地档内容键 `<entry.key>/<共享键>`） | 缓存键、结果键 | **不能只跟着改**：否则用户卡改了整场景键不变，旧帧会被当成新的。改为 `code` = 全局代码版本 + 本项目定制卡身份的摘要（`card-code.mjs` 的 `cardEntryCode`），身份在建 entry 时算一次、记在 `entry.cardSources` 上，切分用同一份，保证整场景键与 `requires.cardSources` 出自同一次计算 |
| 共享档快照键（`card-identity.mjs` 的 `cardSnapshotIdentity`） | 结果键 | 不涉及 `frameCode`：键里本来就有这张卡的源码版本（浏览器算的 `sourceVersion`）与 `snapshotCode`，照旧能区分卡片代码 |
| `captureCode`、`snapshotCode` | 截图代码、快照代码（进结果键） | 不含用户卡，本来就不涉及；只统一了换行（第 5 节第 3 条） |
| 卡片级指纹锁（`card-lock.mjs`，锁键 `<kind>:<contentKey>`） | 锁键 | 锁键是内容键，内容键里已有卡片源码版本（共享档）或 `entry.key`（本地档），跟着上一行自动区分；没改 |
| 执行器上下文缓存（`prerender-executor.mjs`，按 `projectId@rev`） | 缓存键 | 加卡片代码版次（`codeStamp`）：同一版项目卡片代码变了（同步装上新卡），要按新代码重算，不然任务对回的是旧的 control |

「同一张卡代码不同，产物绝不能混用」由三层保证：键不同（上表）；节点手里代码不对就不认领（`requires.cardSources`）；认领了执行器仍按本机重算的计划核对内容键与 `entry.key`，对不上抛 `plan-mismatch`（原有）。

## 2. 改动清单

提交见第 7 节。

- `server/frame-code.mjs`：`isUserCardSource`；`frameCode` 跳过用户卡；`textOf` 统一换行。
- `server/card-code.mjs`（新）：`projectCardIds`、`cardEntryCode`、`createCardCodeIndex`（身份缓存、稳定期、节点视图、版次）。只用 Node 内置模块。
- `server/card-overrides.mjs`：`setCardIdentifier` / `cardCodeIdentityOf`（同 `setCardHasher` 的注入方式，帧管线不反向 import 卡片插件）。
- `server/vite-plugin-cards.ts`：`cardCodeIdentity`、`createHostCardSync`；插件启动时注入身份算法。
- `server/card-sync.mjs`：`readOnly`（不上传、不记待上传）。
- `server/frame-pipeline.mjs`：构造参数 `cardSources`；`entry()` 的整场景键；`planForQueue` 的 `cardSourceVersions`。
- `server/render-node/split.mjs`：本地档与流的 `cardSources`。
- `server/render-node/host.mjs`：`createRenderHost` 收 `cardSourceVersions` 放进节点描述。
- `server/prerender-executor.mjs`：`codeStamp`。
- `server/vite-plugin-frames.ts`：每个根一份身份索引、卡片源码变更时清；PC 与主机节点的 `cardSourceVersions`；执行器 `codeStamp`；主机的卡片同步与诊断里的 `cardSync`、`cardCode`。
- `server/test/host-card-code.test.mjs`（新）：HC1～HC6。`server/test/render-node-logic.test.mjs`：B.4 一条用例按新规则改。
- `scripts/probes/c66-t9-probe.mjs`：去掉主机往检出预写用户卡的绕法；主机新断言；`--role all` 加 `--port-base`。
- 契约：`docs/plan/render-queue-contract.md` B.4；`docs/plan/render-host-contract.md` 第 3、4 节与新增第 7 节（第 6 节列明）。

## 3. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行（最后一次提交之后又跑了一遍） |
| 全量测试 | `npm test` | 退出码 0：tests 3078、pass 3077、fail 0、cancelled 0、skipped 1（跳过的是「集成:/api/cards/layout 对真实项目返回整数框」，要 5190） |
| 新单测 | `node --test server/test/host-card-code.test.mjs` | 5/5 通过 |

第一次跑 `npm test` 时 `sp-hosted.test.mjs` 的 SPC7-1 失败，原因是 `EADDRINUSE` 5493：这条用例用固定端口 5492、5493，当时 5493 被别的会话的一个 chrome-headless-shell 网络进程占着（出站连接绑到了这个号，不是我起的进程，没动它）。那个端口放掉之后单独重跑这个文件 12/12 通过，全量重跑也通过（上表）。

新单测（`server/test/host-card-code.test.mjs`）对应任务书要的三条：

- **用户卡不同的两台节点仍在同一池**（HC1）：几份最小检出：多一张用户卡带归属表、用户卡不同带一个依赖文件、CRLF 检出，`frameCode` 都相同；改内核源码、改用户卡装载入口 `index.ts`、改内置卡都会换版本。创建者（有用户卡）发布的任务，没有这张卡的主机过得了代码版本这一关。
- **任务要的卡本机没有就不认领、装上后能认领**（HC2）：用的是真文档服务的内容库、真 WebSocket、真卡片同步（`createHostCardSync`）和进程内真队列加 `createRenderHost`。创建者切出的两个任务（共享档用户卡、本地档内置卡）都带 `requires.cardSources: { price-tag: … }`；主机没有这张卡时 `checkClaimable` 回规则 1 `card-source`，不抛错；队列里看得见 2 个任务、认领 0 次。卡片同步装上之后，主机算出和创建者一样的身份，下一拍认领两个任务，各恰好一次 `task.done`。HC3 接着测改卡：创建者改成 v2，主机按 `content.watch` 把 v2 装进自己的改动层，检出里的底版仍是 v1；v1 的任务不再认领，v2 的能认领、各一次 `task.done`。
- **同一张卡代码不同，产物不混用**（HC4）：`cardEntryCode` 与整场景键 `frameIdentity` 不同；`FramePipeline.entry()` 注入 v1、v2 得到两个不同的 entry（不同目录），没有定制卡时整场景键就是全局代码版本；本地档内容键与结果键不同；共享档键随源码版本不同；手里是 v1 的节点不认领 v2 的任务，反过来也一样；执行器在卡片代码版次变了之后重算上下文，不再用旧的。
- HC5 测身份索引（稳定期、算法没注入时不缓存、只列定制卡）；HC6 测主机的同步只读：本机那份与服务上不同时照样装服务上的（进改动层、底版不动），一条 `content.put` 也不发，项目的 `cardRev` 不被推高。

导出确定性、快照重放一致（`verify-determinism`、`verify-unified-frames`）**没跑**：它们要 5203 的 dev-test，不在我的端口段里。这次改动不碰像素，只改键与认领：整场景键与三个代码指纹的取值变了，导出页面与渲染代码没变。建议主会话合并前照常跑 G0-R（C6.6 集成本来就要跑）。

## 4. T9 本机替身

命令（端口都在 5680～5689，另两个用系统临时端口，理由见第 5 节第 5 条）：

```
PROMPTCUT_DATA_DIR=<scratchpad>/hc/hosted-data PROMPTCUT_DOCSERVICE_HOST=127.0.0.1 PROMPTCUT_DOCSERVICE_PORT=5689 PROMPTCUT_ASSET_PORT=0 PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1 node server/hosted/main.mjs   # 素材服务拿到 6375
PROBE_MAIL_TOKEN=<随机> node scripts/probes/probe-coord.mjs serve --port 0                                                                                                   # 拿到 14055
PROBE_MAIL_TOKEN=<同上> node scripts/probes/c66-t9-probe.mjs --role all --hosted http://127.0.0.1:5689 --coord http://127.0.0.1:14055 --port-base 5680 --out <scratchpad>/hc/run1
```

run1（`muj80x4u123b`，代码 `dcb7c60`），退出码 1，跑了 690 s。三方的失败都是任务书说的两个已知问题，没有一条出自本分支：

- **observer**：`超时:[observer] 看到视频片段`。这就是已知问题「观察端素材不同步」。这一次的排障输出和 T9 报告里的不一样：观察端页面的 `view.kind` 是 `local`、`shared: null`、`media: []`，片段是十张内置卡，看上去是没进（或退出了）共享项目。我没有查，交修它的分支。
- **creator**：`超时:[creator] 页面发布的 plan 切分完、细任务都落定`。这就是已知问题「重卡 plan 切不出任务」。队列诊断（`creator-queue-diag.json`）和 T9 报告 run5 一样：`@1` 切出 0（`controls: 0`），`@2`（加了重卡之后）`executor.plan controls: 1`、`node.plan-split derived: 0`，之后没有新的发布。plan 本身执行成功，`entryKey` 照常算出来，没有执行器报错，所以不是这次整场景键改动引起的。
- **host**：`creator 已中止:plan 没落定`。没有细任务可认领，所以「主机不靠预写也能认领并完成任务」这一条这一轮**没能在真编辑器里验到**，在单测 HC2、HC3 里（真文档服务、真同步、真队列）验了。

host 这一轮验到的：
- 主机没往检出里写卡（绕法已删）。`cardInRepoBefore: true` 是因为本机替身和创建者共用一个检出，创建者自己写了探针卡。
- 主机起来之后，诊断里 `cardSync: [{ enabled: true, connected: true, records: { "src/cards/user/c66t9-muj80x4u123b.tsx": 1 } }]`：它经自己的 render 连接对上了内容库里的探针卡（本机内容相同，只记账、不装）。
- 主机与创建者报的代码版本都是 `0c4be97a9a39`。
- 改卡后装上 v2 这条没走到：观察端没进项目，创建者就没改卡。

收尾：`src/cards/user/` 只剩 `index.ts` 与 `mu-animated-shiny-text.tsx`；`.pc-work/card-history` 没有残留；5680～5689、6375、14055 都已经没有监听（临时托管组合与协调口是我起的，已停）。用户常驻的 5190～5192 没碰。

## 5. 需要主会话决定、或要知道的

1. **本机没有的用户卡装在哪**〔裁，待主会话确认〕：主机同步来的卡，本机已有的文件进主机自己的改动层，仓库里的原卡不动。**本机没有的用户卡照现有装卡路径（`installBundledCards`）写进检出的 `src/cards/user/`**：用户卡的装载入口 `src/cards/user/index.ts` 用 `import.meta.glob("./*.tsx")` 按目录收卡，改动层里单独放一张新卡是装载不到的。桌面版同步、打开 .proc 装卡走的也是这一条。它不改任何原卡，但会在主机的检出里留一个新文件（探针跨机时收尾会删）。如果要求主机一个字节都不写检出，就得让装载入口也扫改动层（改 `index.ts` 的 glob、`findCardFile` 等几处）。影响面大，这次没做。
2. **一次性换键**：`frameCode` 去掉用户卡、三个代码指纹（`frameCode`、`captureCode`、`snapshotCode`）统一换行之后，Windows 检出上的代码版本、整场景键、共享快照键、轨道流键都会换一次。已有的预渲染结果要重做一遍，之后照常复用。统一换行是我顺手加的：仓库是 `text=auto`，Windows 检出是 CRLF、Linux 检出是 LF。不统一的话，云端（Linux）的独立渲染主机和 PC 永远不在同一个池，共享快照键也对不上（执行器会报 `plan-mismatch`），T9 的云端主机角色一样跑不通。不想要这一条可以只撤 `frame-code.mjs` 里的 `textOf`。
3. **一个主机加入几个项目时**，各项目的卡装进同一个改动层。同一个文件在两个项目里版本不同时，后装的盖掉先装的，另一个项目要那张卡的任务就不认领（不会渲错，只是这台主机帮不上那个项目）。写进了 `render-host-contract.md` 第 7 节的「限制」。
4. **装卡之后的稳定期**：卡片源码一变，1.5 s 内节点一张卡也不报。这样 Vite 先作废模块、节点后认领，免得按旧代码渲出来、再被执行器按 `plan-mismatch`（不可重试）判失败。数值是我定的，放在 `server/card-code.mjs` 的 `CARD_CODE_SETTLE_MS`。
5. **端口**：本机替身要 3 个编辑器，各占 3 个号，一共 9 个（5680～5688）；托管组合要 2 个，协调口要 1 个，合计 12 个，比分到的 10 个多。所以文档服务放在 5689，素材服务和协调口用了系统临时端口（`PROMPTCUT_ASSET_PORT=0`、`--port 0`，这次拿到 6375、14055）。探针加了 `--port-base` 给 `--role all` 用。
6. **任务上的卡片要求只列「定制卡」**（用户卡、闭包里有改动层文件的卡）；没改过的内置卡由代码版本覆盖。反方向的情况是：节点本机改过某张内置卡、而任务没列它。这种情况节点照样会认领，执行器按本机重算的内容键核对，对不上就抛 `plan-mismatch`（原有），不会混用。只是这个任务就此失败、不重试，与改动前的行为相同。

## 6. 改了哪些契约

- **`docs/plan/render-queue-contract.md` B.4**（`splitPlan`）：
  - `cardSourceVersions` 的含义改为「这一版用到的定制卡的代码身份」；
  - 本地档快照任务的 `requires.cardSources` 由「只列这张卡」改为「这一版全部定制卡」；
  - 轨道流任务由 `{}` 改为全部；
  - 节末加「c66-host-cards 改」一段：代码版本不含用户卡、换行统一、身份的算法、节点 `cardSourceVersions` 现取现算与稳定期。

  为什么：本地档与流画的是整个场景，本地档内容键里的 `entry.key` 现在带着全部定制卡的身份，节点缺任何一张都会在执行器里对不上。任务字段的形状没变。B.2 规则 1 本来就有 `cardSources` 与 `cardSourceVersions`，没改。
- **`docs/plan/render-host-contract.md`**：
  - 第 3 节注明 `frameCode` 不含用户卡，节点描述另带 `cardSourceVersions`（不进 `node.hello`）；
  - 第 4 节节点侧过滤加 `requires.cardSources`；
  - 新增第 7 节「用户卡与卡片同步」：主机的只读卡片同步、装在哪（含第 5 节第 1 条的〔裁〕）、稳定期、执行器缓存、多项目限制、诊断里的 `cardSync` 与 `cardCode`。

  为什么：主机加入共享项目要自己同步卡（任务书第 3 条），原契约没有这一块。
- `node.hello`、`task.publish` 等消息的形状都没改；语义文档没改。

## 7. 提交

- `86935ac` 报告开工
- `72773f9` 代码：代码版本不含用户卡、卡片代码身份、任务要求、节点视图、主机卡片同步
- `7bc1e7e` 单测 HC1～HC6，B.4 用例按新规则改
- `294ae11` 契约 render-queue B.4、render-host 第 3、4、7 节
- `dcb7c60` 探针 c66-t9：去掉预写绕法、主机新断言、`--port-base`
- 另加本报告写完的一次提交
