# C6.6 卡片源码同步（c66-cards）实现报告

分支 `claude/c66-cards`（起点 main `f866754`），worktree `.worktrees/c66-cards`。依据 `docs/plan/c66-design.md` 第 5 节、`docs/plan/cloud-task.md` A6 与 B2、`docs/plan/docservice-contract.md` 第 2 节，以及主会话中途的补充裁定（本机写过的那一版被覆盖也要备份、提示）。

**状态：按回退规则停手，交回主会话。** 探针的「B 重测」一项在两次修正后连续第 2 次没过（见第 3 节）。其余部分已完成：单测 T8-0～T8-7 全过，tsc 0，npm test 0 失败；探针里除「重测」之外的各项（B 装上新版 ≤ 5 s、热更新、身份键变化、不离开共享项目、不碰底版、托管端 cardRev）都过了。G0-R 没跑。

## 1. 做了什么

### 编辑器进程一侧

- **`server/card-sync.mjs`（新）**：同步的核心，只用 Node 内置模块。连接缺省用 `render-node/ws-transport.mjs` 的 `createWsEndpoint`，可以注入。
  - 写：`saved(rel)` 把文件记成待上传，然后 `content.put({ kind: 'card-source', key: 仓库相对路径, body: 源码字符串, session })`。本机按空间记账 `{ rev, hash, mine }`：hash 与内容库的算法相同，`sha256(JSON.stringify(源码))`，先统一成 LF。断线时留在待上传里，连上后补传。
  - 读（只在共享项目里做）：连上后先 `content.watch(['card-source'])` 再 `content.list`，对列表逐条对账；之后每条 `content.changed` 都按同样的规则处理：
    - 服务上的 rev 不比本机记账新：不装。本机在那之后改过的，传上去（A6「本地改了则上传」）；
    - 服务上更新了，本机没有这个文件、或内容已经相同、或本机没改过：直接装；
    - 本机改过、服务上也改过：先备份本机那份，再装服务上的，并发出覆盖提示；
    - **补充裁定**：本机那份就是自己上次写上去的（`mine`）、被别人随后改掉：同样先备份、再提示。本机从没写过的，直接装；
    - 自己的写入在频道里回来时，如果 `previousActor` 是别人，提示覆盖方「你覆盖了 X」；
    - 同一个键有上传在途时，这个键的变化排在上传回包之后处理，旧的变化丢掉。
  - 范围：只认 `src/cards/`、`src/parts/` 下的 `.tsx`、`.ts`、`.css`，测试文件和路径穿越都不认。「用户卡或改过的内置卡」由调用方判定。
  - 本机项目（`local` 空间）：只上传，`cardRev` 照常自增，不 watch、不 list、不装。
- **`server/vite-plugin-cards.ts`**：
  - 新增 `installSyncedFile`，装同步来的文件：
    - 用户卡定义文件交给 `installBundledCards`，与打开 .proc 装卡是同一道审查；
    - 其余文件（改过的内置卡、部件等）走 edit_card 的 `checkSourceEdit`，再用 `writeCardFile` 写进改动层，不碰仓库里的原卡。
  - 装完照 edit_card 的做法作废模块、热更新，并调 `emitCardSourceChange`。
  - 新增 `cardSyncKeys` 与 `builtinCardIds`；`backupBeforeEdit` 改成导出。
  - **B2**：edit_card 改用户卡也备份到 `out/card-edits/`。
  - 接线：edit、create、install 三个端点落盘后调 `saved`。编辑器一起来就绑在本机空间，页面接上共享项目时再换绑。
  - 新端点 `/api/cards/sync/{bind,unbind,ticket,status}`：
    - 共享项目的连接凭 page 角色的连接票据。票据经 HMR 自定义事件 `pc:card-sync` 向页面要，页面签好后 POST 回来；
    - 新装上的用户卡在 `_scopes.json` 里记到这个共享项目名下；
    - 预渲染进程、无头实例、`PROMPTCUT_CARD_SYNC=0` 时不同步。
  - 记账放在改动层旁边（装机版在数据目录里），没有改动层时放 `.pc-work/card-sync/`。
  - **改动层加载钩子挪进独立的 `enforce: 'pre'` 插件**（`vitePluginCards()` 改为返回两个插件）。这是探针查出来的既有缺陷：
    - `?raw` 的加载一直由 vite 自己的 `vite:asset` 先答，原钩子从来轮不到；
    - 结果是注册表里的定制卡源码读到的一直是底版，打包 .proc、源码版本、身份键都受影响；
    - 表现是改动层里的改动画面上生效了，身份键却不变。

### 页面一侧

- **`src/editor/sync/cardSync.ts`（新）**：
  - 绑定：与 `/api/agent/bind` 同一时机，把项目用到的卡报给编辑器进程，包括时间轴片段、卡片图节点、归属表记在本项目名下的；用到的卡变了再报一次；
  - 票据：在本页面的共享项目连接上发 `auth.ticket { kind: 'conn', role: 'page' }`；
  - 气泡：装上、被覆盖（带备份路径）、覆盖了别人、装不上；
  - 装上别人的版本、热更新落地后，发页面事件 `pc-cards-synced`。
- **`src/editor/sync/syncManager.ts`**：在 `bind` 里调 `bindCardSync`，订阅 store 变化，提供票据、气泡、写入者名字三个钩子。
- **`src/editor/ProbeGate.tsx`、`src/editor/probeRunner.ts`**：新增 `requeueProbeRun(project)`（清身份缓存，按当前项目重排）。ProbeGate 收到 `pc-cards-synced` 时调它。

### 测试与探针

- `server/test/card-sync.test.mjs`：T8-0～T8-7。用真实的文档服务内容库、真实 WebSocket，文件操作用真实的 `installSyncedFile` 与 `backupBeforeEdit`，每端一个临时项目根。
- `scripts/probes/card-sync-probe.mjs`：本机托管组合（8790、8791）加两个编辑器（5580、5583，各自有改动层与设备号），stdout 输出一行 JSON。`PROBE_DEBUG=1` 时 stderr 另打页面控制台与服务端的 HMR 日志。

## 2. 验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0（最后一次提交之后又跑了一遍） |
| 全量测试 | `npm test` | 退出码 0：tests 2959、pass 2958、fail 0、skipped 1（最后一次提交之后又跑了一遍） |
| T8 单测 | `node --test server/test/card-sync.test.mjs` | 8/8 通过；连跑 6 遍都是 8/8。T8-1 装上用了 29 ms，变更通知在改后 6 ms 发出 |
| 相关旧测 | card-source、cards、card-overrides | 12/12、50/50、6/6 |
| 探针 | `node scripts/probes/card-sync-probe.mjs` | **没过**，见第 3 节 |
| G0-R | verify-determinism、verify-unified-frames、导出像素对比 | **没跑**：按回退规则停手 |

T8 单测覆盖的内容：

- T8-1：A 改用户卡，B 5 s 内装上并发出变更通知；B 第一次打开共享项目就装上 A 带来的卡。
- T8-2：两端同时改同一张卡，后写的赢；先写方有覆盖提示，备份里是自己那份；后写方收到「你覆盖了 X」。
- T8-3：未改的内置卡不同步，改过的同步；B 本机的未改底版直接换，不备份。
- T8-4：本机空间只上传，cardRev 1→2，别人的写入不装。
- T8-5：断线期间的保存重连后补传；离线时改过的文件，打开时对账后传上去。
- T8-6：审查不过的版本不装，并给提示。
- T8-7（补充裁定）：本机写过的那一版被随后改掉时，先备份再提示；从没写过的一方直接装；装上别人的版本后不再算自己的。

探针最后一次（`muht1n4n`）的结果：

- 过了的：
  - `installMs: 166`，B 的 `/api/cards/source` 读到 v2；
  - `hmrMs: 1110`，B 页面注册表里是 v2；
  - 身份键变了：`4206899c69a24` → `195c5690f94642`；
  - 没有整页刷新，改完后 B 仍在共享项目里；
  - 托管端 `cardRev: 2`，正文是 v2；
  - 底版仍是 v1，A、B 的改动层都是 v2；
  - 两端记账都是 rev 2（A 记为自己写的，B 不是）；
  - B 只收到一条「已装上」通知，没有误报的覆盖提示；
  - A 改用户卡时有 B2 备份。
- 没过的：`b-no-remeasure`，改后 60 s 内既没看到测量遮罩，成本表里也没有新身份键的记录。另外舞台 iframe 里的 v2 记号 15 s 内没取到（`stageMs: null`；改前能取到 v1）。

看过的图：`out/card-sync-probe/muht1n4n-b-2-after.png`。B 仍是「成员：2 人」，时间轴上有「同步探针」片段；页面上叠着「选择 AI 助手」对话框。这个对话框只在打开时出现，说明热更新让 App 重新挂载了。

探针修过的问题（每次原因不同，逐次查明后改的）：

1. 第 1、2 次：页面一侧 `cardSync.ts` 静态引了 `probeRunner`，把 `syncManager` 拉进了卡片热更新的祖先链（`costIdentity` 引的 `cardSourceFiles.mjs` 会 glob 全部卡片源码）。结果改一张卡，`syncManager` 就被重跑，B 退回本机空间。已改为页面事件。
2. 第 3～5 次：B 页面注册表里仍是 v1。原因是 `?raw` 读到的是底版，也就是上面那个改动层加载钩子的既有缺陷。已修。
3. 第 6、8 次：热更新落地、身份键也变了，但探针不重排。第 8 次之前加了显式重排（`pc-cards-synced` → `requeueProbeRun`），仍没看到重测，于是停手。

## 3. 没做成的，以及原因

**T8「B 5 s 内……并重测」的「重测」在真实编辑器里没观察到。** 按回退规则（同一用例连续第 2 次失败）停手，没有继续查。已知事实：

- 热更新会沿导入链重跑 `probeRunner`、`costIdentity`、`planDispatch`、`ProbeGate`，控制台有 `hot updated: /src/editor/ProbeGate.tsx`；
- 链上模块的实例被换掉以后，现有代码并不会因此重排，C6.6 之前本机 edit_card 改卡后也一样；
- 加了显式事件之后仍没看到重测。

怀疑以下三点之一，都没核实：

- 气泡与事件依赖的 HMR 通知 `pc:card-sync` 没到达页面（B 的截图上也没看到「已同步为……」气泡）；
- ProbeGate 的监听挂在旧实例上；
- 重排后的这一轮卡在 `whenStageReady('back')` 或后台舞台上。

下一步建议先在探针里核对 B 页面有没有收到 `pc:card-sync` 通知：看气泡，或在页面里挂一个 `import.meta.hot` 以外的观察点。

舞台 iframe 里没取到 v2 记号，可能和舞台用快照、后台舞台重连有关，也没核实。

G0-R 没跑。这次改了卡片装载，包括 `enforce: 'pre'` 的加载钩子，但它只在有改动层（`PROMPTCUT_CARD_OVERRIDES` / `PROMPTCUT_DATA_DIR`）时生效，开发期的 dev-test 不受影响。主会话合并前应跑 G0-R。

## 4. 设计稿歧义与我的做法

1. **「编辑器进程写」与凭证**：编辑器进程另开一条自己的连接，身份是 page 角色。共享项目用页面签发的连接票据（两分钟过期，重连时再要一张），向页面要票据走 HMR 自定义事件，不走 `vite-plugin-ai.ts` 的 SSE，免得跨插件。
2. **「走现有的 /api/cards/install 路径」**：同一进程内直接调同一套函数（`installBundledCards` 加同样的热更新与变更通知），不绕 HTTP。改过的内置卡与部件原来的 install 不支持，新增 `installSyncedFile`，走 edit_card 的检查。
3. **body 形状**：body 就是源码字符串，这样本机算的哈希能直接和 `content.list` 的 `hash` 比。
4. **打开共享项目时传哪些卡**：只传项目用到的卡（时间轴、卡片图、归属表），不传整台机器的用户卡，避免把别的项目的卡泄露出去（`_scopes.json` 的初衷）。
5. **「改过的内置卡」怎么判**：装机版看改动层里有没有；开发期没有改动层，edit_card 或同步改过的内置文件记在 `edited.json`。
6. **本机从没同步过、但本机有这张用户卡、服务上的又不同**：算「本机改过」，先备份再装，并提示。
7. **一个编辑器进程只绑一个空间**：以最后一次绑定为准，和 Agent 服务端的 bind 相同。多个页面分别开不同的共享项目时会互相抢。
8. **覆盖方提示**：只要这次写入的 `previousActor` 是别的设备或用户就提示，不限时间窗口。B3 的「最近 10 个 rev 或 30 分钟」没在客户端实现。

## 5. 对任务书或语义的更正建议

- 第 5 节「卡换了代码，按现有规则重测」：现有代码里「卡片代码变了、项目没变」并不触发重测（本机 edit_card 也一样），热更新重跑探针模块也不会重排。建议在设计稿里写明要补一个显式触发，并确定触发点，现在是页面事件 `pc-cards-synced`。
- 改动层的 `?raw` 加载缺陷在装机版里一直存在，影响打包 .proc、源码版本和身份键。这次已修，建议在 TODO 的「已做步骤的遗留」里记一笔，由主会话复核。
- `create_card` 带 `overwrite` 时直接写底版；改动层里有旧版时，新内容会被旧版盖住。这是既有问题，这次没改。
- 页面在热更新后会重新弹出「选择 AI 助手」对话框（App 重新挂载），是既有行为。共享项目里别人一改卡，本端就会弹一次，建议另立一项。

## 6. 提交

`796f5d3`（开工）起，逐块提交在 `claude/c66-cards` 上，没有推送、没有合并。探针的截图在 `out/card-sync-probe/`（不入库）。探针结束时已结束自己起的全部进程树，删掉了探针卡的底版和 card-history 条目，还原了归属表。5580～5585、8790、8791 已确认没有监听。
