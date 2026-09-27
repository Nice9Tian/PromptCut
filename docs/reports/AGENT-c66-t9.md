# AGENT 报告：c66-t9（C6.6 T9 跨机探针与本机替身）

分支 `claude/c66-t9`，worktree `.worktrees/c66-t9`，起点 `claude/c66-integ` 的 `29c9cb1`；中途按主会话通知 `git merge --no-ff claude/c66-integ`（`851ffe9`，T8 修复），合并提交 `5d27dc5`。不推送、不合并进别处。

T9 是设计稿 `docs/plan/c66-design.md` 第 6 节的第 9 条验收：创建者、观察端、独立渲染主机三方跨机一起跑。T8 是同表第 8 条（卡片同步 5 s 内装上并重测）。

**状态：探针写完；本机替身 `--role all` 没有跑通，按任务书停手。** 卡住的两处都不在探针里：
1. **观察端拿不到素材（确定性，连续 4 次）**：观察端进入共享项目后，项目里那条视频素材一直是 `pending: true`、`hash: null`，素材层无从谈起。根因是产品代码（第 4 节第 1 条）。
2. **重卡片段的 plan 切不出任务或有任务失败（时序类）**：4 次里 1 次切出 3 个细任务（主机做了 2 个、本机节点 1 个 `sink-incomplete` 失败后没人再做），2 次切出 0 个任务（第 4 节第 2、3 条）。

## 1. 脚本：`scripts/probes/c66-t9-probe.mjs`

用法（文件头有全文）：

```
node scripts/probes/c66-t9-probe.mjs --role creator|observer|host|all
     [--hosted <文档服务基址>，缺省 https://8-219-80-16.sslip.io/hosted]
     [--coord <协调口基址>，缺省 https://8-219-80-16.sslip.io/coord]
     [--run <本轮 id>] [--port <编辑器端口>] [--out <截图目录>] [--timeout-min 25] [--keep-temp]
```

- 端口缺省：creator 5590、observer 5593、host 5596（各另占 +1、+2）。`all` 在同一台机器上各起一个子进程跑三个角色。
- 协调口 KV 键 `c66t9.<run>.<名>`：`config`、`host.ready`、`plan`、`editready`、`observer.joined`、`edited`、`observer`、`host`、`creator`、`abort`；`--run` 不给时 creator 生成并写 `c66t9.latest`，另两个从那里取。KV 令牌取环境变量 `PROBE_MAIL_TOKEN`。
- 口令只进 KV 的 `config` 与各角色临时目录里的配置文件，不进 stdout / stderr。stdout 最后一行 `{ role, ok, fails, … }`。
- 每个角色把编辑器输出存到 `--out` 下（`creator-editor.log`、`observer-editor.log`、`render-host.log`），creator 另存预渲染进程的队列诊断 `creator-queue-diag.json`。

与任务书步骤的差异（都是编排上的，没改断言）：
- **config 提前到重卡片段之前写**，creator 等主机报 `host.ready` 之后才加重卡片段、发布 plan。任务书的顺序（先发布、再写 config）下主机起来要几十秒，本机节点早把任务做完了，主机认领不到。
- **改卡的计时握手**：plan 落定后 creator 写 `editready`；观察端做完换档断言、第一轮测量测完、拿到 `editready` 后记 t0、写 `observer.joined`；creator 收到就改卡。两台机器的钟不对齐，观察端只用自己的钟：t0 早于真正改卡（多算一次 KV 往返与 creator 的反应），测出的 installMs / remeasureMs 是上界。
- **主机在本检出里补写探针用户卡**（v1 源码随 config 下发，收尾删掉）。原因见第 4 节第 4 条。

## 2. 每个断言怎么判

**creator**
- 托管端 `/healthz` 通；页面以创建者进入；用户卡传上内容库（`/api/cards/sync/status` 的 `rev ≥ 1`）；上传目标 `GET /api/media/upload-queue` 的 `target.base` 等于 `service.endpoints` 下发的托管端素材服务。
- 导入走素材库的文件输入（`[data-pc="library"] input[type=file]`，`?tiers=1`）。
- 先小后大三重核对：每 100 ms 问一次编辑器的两档登记（`/api/media/tiers`，拿小尺寸哈希）和托管端两档的 `chunks`，「原尺寸已 complete 而小尺寸还没有」的次数必须是 0，小尺寸第一次 complete 不晚于原尺寸；编辑器日志里这个素材是 `tier-start small → tier-done small → tier-start original → tier-done original → item-done`；托管端两档字节的 sha256 与哈希相符；项目里的 `tiers.small` 与两档登记一致。
- plan：基线之后新发布、**切出了细任务**的最新一版，所有细任务 done/failed，3 s 内没有更新的一版；清单拉完；没有失败的细任务；plan 由本机节点认领。
- 汇总：observer、host 两方 `ok`；本机节点完成数加主机完成数等于细任务数；收尾经创建者操作 `delete` 删掉托管端项目。

**observer**
- 编辑器 B 的环境里 `PROMPTCUT_QUEUE_NODE`、`PROMPTCUT_SHARED_CONFIG` 为空（记在 `env`），B 的 `GET /api/frames/queue` 没有节点、`starting: false`。
- 先小后大（tier-switch-probe 的读法）：播放头停在 2.5 s，读可见舞台里显示着的 `<video>` 顶上条纹的帧号。第一次解出画面时来源必须是小尺寸哈希；小尺寸帧号连续 3 次相同算稳定，要在 75 ± 1；换到原尺寸后帧号与小尺寸相差 ≤ 1、`videoWidth` 是 1920；换档期间 rAF 逐帧采样无黑帧、帧号一直在 75 ± 1；换到原尺寸后不退回小尺寸。
- 卡片：进入后 B 有 v1；t0 起 5 s 内 `/api/cards/source` 读到 v2；页面热更新到 v2；重测用 card-sync-probe 的判据（身份键变了，且测量遮罩出现过或成本表里有了新键的记录），`remeasureMs ≤ 5000`，**没放宽**；舞台画出 v2；v2 进了 B 的改动层；有 `installed` 通知（rev ≥ 2）；B 仍在共享项目里。

**host**
- `render-host` 起来（IPC `ready`），诊断 `profile: host`；认领 ≥ 1、完成 ≥ 1、失败 0；plan 里每个细任务的 task.done 次数都恰好是 1；每个细任务的清单在托管端内容库（`content.get snapshot-manifest`），清单里每个块在托管端素材服务（`has`，带只读票据）；IPC `shutdown` 后退出码 0。

## 3. 自测：命令与原始结果

本机临时托管组合与协调口（只绑 127.0.0.1，`PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1` 让回环也要票据，更接近云端）：

```
PROMPTCUT_DATA_DIR=<scratchpad>/t9/hosted-data PROMPTCUT_DOCSERVICE_HOST=127.0.0.1 PROMPTCUT_DOCSERVICE_PORT=8794 PROMPTCUT_ASSET_PORT=8795 PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1 node server/hosted/main.mjs
PROBE_MAIL_TOKEN=<随机 24 字符> node scripts/probes/probe-coord.mjs serve --port 8796
PROBE_MAIL_TOKEN=<同上> node scripts/probes/c66-t9-probe.mjs --role all --hosted http://127.0.0.1:8794 --coord http://127.0.0.1:8796 --out <scratchpad>/t9/runN
```

| 次 | 代码 | 退出码 | 结果（`fails` 原文摘要） |
|---|---|---|---|
| run1 | `6074e0d` | 1 | `creator 出错:Invalid URL`：探针把 `client.mjs` 的 `createSharedProject` 盖在了 `route.mjs` 的上面，已修（`f49fbfb`） |
| run2 | `f49fbfb` | 1 | 观察端 `超时:[observer] 看到视频片段`；plan 3 个细任务，1 个 `sink-incomplete`；`[creator] 托管端素材小尺寸先于原尺寸 complete :: {"small":2209,"original":1106}`（探针的量法错：小尺寸哈希拿得晚，已改，见下） |
| run3 | `5d27dc5` 之后 | 1 | 观察端同上；plan 取到了加重卡之前那一版（0 个任务），探针已改为只认切出了任务的一版（`d08564a`） |
| run4 | `d08564a` 之后 | 1 | 观察端同上；`超时:[creator] 页面发布的 plan 切分完、细任务都落定` |
| run5 | 最终代码 | 1 | 同 run4 |

run2 的细节（这一次三方都走到了底）：
- creator：导入 617～631 ms；两档都 `remuxed`；`uploadOrder` 正是 `tier-start small, tier-done small, tier-start original, tier-done original, item-done`；改卡 73 ms、带备份，托管端 `cardRev` 到 2；托管端项目已删（`deleted: true`）。
- plan `plan:p-muj54so9-95dc97af@2`：3 个细任务，发布到落定 276 819 ms；`0-59`、`120-179` 各 task.done 1 次（主机做的），`60-119` 由本机节点认领后 `sink-incomplete` 失败，之后 0 次 task.done；`applied: 2`，所以 `超时:[creator] 清单拉取完`。
- host：`claimed: 2, completed: 2, failed: 0`；3 份清单都在托管端内容库，140 个块都在托管端素材服务；IPC 退出码 0。唯一失败是 `每个细任务恰好一次 task.done`（`60-119` 为 0）。
- observer：`超时:[observer] 看到视频片段`。

run3 起加了先小后大的新量法，结果 `firstCompleteMs: {"small":984,"original":1088,"polls":5,"originalBeforeSmall":0}`，这一项通过。

run3～run5 观察端的排障输出（`debugProject`，原样节选 run3）：

```
"media":[{"kind":"video","hash":null,"tiers":null,"pending":true}],
"clips":["media:m-muj5yamc-x","c66t9-muj5y5nw7a6f","r6-canvas"],
"view":{"kind":"shared","status":"online", …}
```

片段和卡都同步过来了，只有素材记录停在导入前的样子。同一时刻创建者页面里这条素材有 `hash` 与 `tiers`。

run5 创建者的队列诊断（`creator-queue-diag.json`）：`@1` 在 02:07:05.9 发布、切出 0；主机 02:07:13.6 报 ready；`@2` 在 02:07:14.5 发布（`executor.plan` 的 `controls: 1`，即重卡那一张），`node.plan-split … derived: 0`；之后 10 分钟没有新的发布。

基线（最终代码）：
- `npx tsc -b --force`：退出码 0，输出 0 行。
- `npm test`：退出码 0，`tests 3073`、`pass 3072`、`fail 0`、`cancelled 0`、`skipped 1`（跳过的是「集成:/api/cards/layout 对真实项目返回整数框」，要 5190）。

看过的图：没有可看的换档图（观察端没走到那一步）。截图在 scratchpad `t9/run*/creator/`。

收尾：每次跑完 `src/cards/user/` 里没有残留探针卡，`_scopes.json` 没变，`.pc-work/card-history` 里没有残留；5590～5599、8794～8796 都没有监听（临时托管组合与协调口已停）。用户常驻的 5190～5192 与 5580～5589 没碰。

## 4. 没做成的及原因

1. **观察端看不到素材（产品代码，确定性）**。`src/editor/io/mediaUpload.ts` 的 `applyUploadedMedia` 直接改 `getState().project.media` 里那个对象（`media.url = …`、`media.hash = …`、`media.tiers = …`、`media.pending = undefined`），然后 `actions.setMediaPath` 只拷出一个带新 `path` 的新对象去 `setProject`。共享项目里（C6.5 的 docsync 模式）`setProject` 走 `projectSync.commit` → `DocSync.commit(next)`，它算 `diffProject(local, next)`；store 里的项目就是 docsync 的本地副本，原地改的字段本地副本里也已经有了，diff 只剩 `path`，于是 `hash`、`url`、`tiers`、`pending` 永远到不了文档服务。`writeSmallTier`（同文件）写 `tiers.small` 也是原地改，同样传不上去。本机项目不走 docsync，不受影响，所以之前的探针都没发现。这一条是我读代码加 run3～run5 的现象推出来的，没有改代码验证。**建议**：这两处改成不可变更新（例如新增一个 `actions.updateMedia(id, patch)`，`setProject({ ...p, media: p.media.map(m => m.id === id ? { ...m, ...patch } : m) }, { undoable: false })`）。这个修复不在我的文件清单里，我没有动。
2. **重卡片段切出 0 个细任务（时序，run4、run5）**。`splitPlan` 跳过不在 `prerenderSet` 里的片段（`server/render-node/split.mjs`）。我的判断（未验证）是：加重卡片段之后页面马上触发 preload 发布了这一版，这时页面还没测完这张新卡，预渲染集合里没有它；测完之后项目没再变，没有新的发布，这一版的重卡就一直没人预渲染。run2 那次切出了 3 个任务，但从发布到落定用了 277 s。探针这一侧可以做的：等创建者页面这张卡测完，再做一次无关紧要的编辑逼它重发。但这等于替产品补一次发布，我没有这么做，交主会话定。
3. **本机节点 `sink-incomplete` 之后没人再做（run2，只见过 1 次）**。`local-node.mjs` 以 `retryable: true` 报失败，但诊断里这个任务一直停在 `failed`，此后 0 次 task.done；这一次的预渲染进程日志没留下（预渲染进程的输出只进编辑器进程里 30 段的尾巴），原因没查到。之后探针会把队列诊断存下来。
4. **帧代码指纹与用户卡**。`server/frame-code.mjs` 的 `frameCode` 哈希整个 `src/`，包括 `src/cards/user/*.tsx` 与 `_scopes.json`；plan 和细任务的 `requires.codeVersion` 取它，`filter.mjs` 按它挡认领。所以创建者本检出里多一张用户卡，另一台机器上的独立渲染主机（没有卡片同步）就一个任务都认领不了。探针让主机先写同一张卡，只是为了让 T9 验得下去。真实产品里这意味着「项目里有用户卡，跨机渲染主机就用不上」，要不要把用户卡挪出代码版本、改用 `requires.cardSources` 单独核对，请主会话定。本机替身同一个检出，覆盖不到这一条。
5. **没跑够任务书要的「连跑 2 次全过」**：被第 1、2 条挡住。按任务书「同一断言重跑连续第 2 次仍失败 / 时序竞态类失败：先提交现状，停手」停在这里。T8 的偶发超时这一轮没测到（观察端没走到改卡那一步）。

## 5. 对任务书或语义的更正建议

- 任务书 creator 第 5 步写 config 应在第 4 步发布之前，并且要等主机起来再发布（第 1 节）。
- 第 4 节第 4 条（用户卡进代码版本）建议在 `mechanism/rendering.md` 或渲染主机契约里定一句：独立渲染主机怎么拿到项目里的用户卡。
- 设计稿第 6 节 T9 建议写明观察端的计时是上界，以及跨机时不能用创建者的钟。

## 6. 三种角色的命令模板

在各自机器上本检出的根目录跑（与创建者同一个提交）；环境变量只列名字：

- **PC（creator）**：`PROBE_MAIL_TOKEN` → `node scripts/probes/c66-t9-probe.mjs --role creator [--run <id>] --out <截图目录>`（`--hosted`、`--coord` 缺省就是阿里云）
- **笔记本（observer）**：`PROBE_MAIL_TOKEN` → `node scripts/probes/c66-t9-probe.mjs --role observer --run <id> --out <截图目录>`（不要设 `PROMPTCUT_QUEUE_NODE`、`PROMPTCUT_SHARED_CONFIG`；脚本也会从子进程环境里删掉它们）
- **host（笔记本）**：`PROBE_MAIL_TOKEN` → `node scripts/probes/c66-t9-probe.mjs --role host --run <id> --out <目录>`
- **host（云端）**：`PROBE_MAIL_TOKEN`、`NODE_USE_ENV_PROXY=1`、`PC_CHROME_ARGS=--no-sandbox` → 同上
- 三方用同一个 `--run`；creator 不给 `--run` 时会生成并写进 `c66t9.latest`，另两个不给就去那里取（10 分钟内写的）。

## 7. 提交

`2a6a065` 开工报告；`6074e0d` 初稿；`f49fbfb` createSharedProject；`5d27dc5` 合并 `claude/c66-integ`（`851ffe9`）；之后是先小后大量法与日志、只认切出任务的 plan、观察端提前结束时 creator 不干等、存队列诊断各一次提交；另加本报告的提交。
