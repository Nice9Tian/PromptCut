# 子 Agent 报告：桌面推送产物的范围（claude/push-scope）

- 分支 `claude/push-scope`，worktree `.worktrees/push-scope`，起点 main `76eee894`（v0.7.2）。
- 端口段 5670～5679。
- 任务：交接文件 `HANDOFF-2026-09-29.md` 第 4 节第三条（第 6 项）——① 同时开着的别的本机项目的帧也会推到绑定项目的素材服务；② 老的环境变量路径起推送时先落本机素材服务，等登记到了才换云端。

## 1. 语义核实的结论

- `product/asset-service.md`「凭票据读写」：票据「只在这个项目内有效」；素材服务按项目部署（「共享项目的素材服务与文档服务在同一处」）。别的项目的字节写进共享项目的素材服务，越过了这条边界。
- `product/platforms.md`「渲染节点」：加入共享项目的桌面应用「自动成为**这个项目**的渲染节点」；纯浏览器节点那条也写明不让别人的项目内容进用户的浏览器。节点的产物范围就是这个项目。
- `product/asset-service.md`「预渲染的产物」：产物「无条件推送到素材服务」——指推到**本项目的**素材服务；别的本机项目没有绑定共享项目时，它的素材服务是本机那一个，不是共享项目的。
- `mechanism/platforms.md`「预留的接口」：「现在只实现推送自己的」。
- 结论：只推绑定项目的产物符合现有语义，不需要改语义文件。老路径没有显式配置项目文档 id 的办法，这一处在契约里加了可选字段（〔裁〕，见第 4 节）。

## 2. 做了什么

| 文件 | 改动 |
|---|---|
| `server/push-scope.mjs`（新） | `createPushScope({ pipeline, contentIds })`：判一段属不属于绑定项目。本地档看 `entryKey` 那一版 entry 的 `project.id`；共享档看绑定项目的 entry 的 card plan 有没有这个快照键（内容寻址，两个项目共用同一份时也算绑定项目的）；轨道流看生产者里这条流的 state 记在哪一版 entry 上，对不上再看成员卡的内容键。找不到 entry 按「不属于」。`contentIds()` 回 `ALL` = 不限，`null` = 还不知道。 |
| `server/artifact-push.mjs` | `createPushQueue` 加 `scope` 选项：不在队里的段进队前判范围，不属于的不进队（`outOfScope` 计数，日志 `push.out-of-scope` 节流）；判不了的扣在内存（最多 5000 段），`rescope()` 再判；`putLayerMap` 只写绑定项目的层表。已在队里、从文件读回的段不再判。 |
| `server/asset-select.mjs`（新） | 从 `vite-plugin-frames.ts` 搬出 `foreignAssetEndpoints`、`selectAssetClient`（为了能单测）。没有 `PROMPTCUT_ASSET_URL`、页面也没给基址时，代理上的方法在「定下来」之前先等：第一份登记（哪怕是空的）、页面交来基址，或等满 10 秒。日志 `push.asset-ready { source, base, why, waitedMs }`。 |
| `server/vite-plugin-frames.ts` | `startArtifactPush` 按 `scopeOf(link, auto)` 建范围：自动节点按 `auto.contentId`（现取），老路径按共享配置的 `contentId`，本机身份不限；限了项目的队列文件放 `push/<host>-<项目 id>/`（原 `autoPushDir` 改名 `pushDirOf`，老路径共用）。`startQueueNode` 的 `publish` 只替绑定项目发布 `plan`（别的项目本机自己产）。`backfillPush` 等页面交来 `contentId` 才补、每拍先 `rescope()`。 |
| `server/auto-render-node.mjs` | 链接上的 `contentId` 改成现取的 getter（页面晚交来的 id 也看得到）。 |
| `server/auth/shared-config.mjs` | 共享配置每项可选 `contentId`，不合格按配置错。 |
| `server/render-node/session-diag.mjs` | 编辑器进程转发的推送行加 `push.asset-ready`、`push.scope`、`push.out-of-scope`、`push.rescope`（安装版用户只交得出编辑器日志）。 |
| `server/test/push-scope.test.mjs`（新） | PS-01～05、AS-01～03，见第 3 节。 |
| `server/test/auto-render-node.test.mjs` | ARN-06 原断言「link 上的 contentId 是起步时的快照」，改为现取（有意的行为变化）。 |
| `scripts/probes/desktop-auto-node-probe.mjs` | 加 A7：桌面绑着共享项目时另开一个不共享的本机项目，核对它的块不到云端。 |
| `docs/plan/render-queue-contract.md`、`docs/plan/auth-contract.md` | J.13 补一条、新增 J.14、第 11 节加 `contentId`，都标〔裁〕。 |

逐项核对任务书第 1 条点名的几处：

- **推送队列的持久化文件**：限了项目的放按项目分的目录，文件里只有这个项目的段；读回不再判（进程刚起时帧库里还没有 entry，判会把绑定项目自己的段丢掉）。
- **补推已有层（`backfillPush`）**：原来就只补 `entry.project.id === contentId` 的，但没交 `contentId` 时补全部——改为不补，交来再补。
- **节点 sink**：认领到的任务来自共享项目的任务队列，照旧推到共享项目的素材服务。但原来本机节点会替**任何**本机项目发布 `plan`（`/preload` 进来就发），别的项目的 plan 进了共享项目的队列，就会被本机或别的节点渲出来、经 sink 推进共享项目的素材服务——这是同一个漏洞的另一条路，一并堵了（只替绑定项目发布）。
- **`frame-pipeline.mjs`**：没改。进队的判断全在推送队列里做；`publishLayerMap` 也没动（在 `putLayerMap` 里挡）。

## 3. 验证

机器上同时有别的子 Agent 在跑，下面各项都是一次过，没有重跑。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出 0，零输出 |
| 新单测 | `node --experimental-test-module-mocks --test server/test/push-scope.test.mjs` | 8/8 通过 |
| 全量测试 | `npm test` | 退出 0；tests 3864，pass 3862，fail 0，skipped 2 |
| 导出确定性 | dev server `npx vite --port 5670 --strictPort --host 127.0.0.1`；`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5670/?export=1"` | 退出 0，1800/1800 相同 |
| 像素基线 | `compare-frames.mjs <pc-g0r-base>\out\verify-a\frames <push-scope>\out\verify-a\frames` | total 1800，identical 1800，different 0，missing 0，extra 0 |
| 导出与快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5670` | 退出 0，PASS |
| ready-index | `node scripts/probes/ready-index-probe.mjs --port 5673` | 退出 0，`fails: []` |
| 轨道流 | `stream-produce-probe --origin http://127.0.0.1:5670`、同上加 `--group` | 两次都退出 0，`fails: []`，PASS |
| 预览兜底 | `preview-fallback-probe --origin http://127.0.0.1:5670`、同上加 `--page-preload` | 两次都退出 0，`transparentBeats: 0`，`fails: []`，PASS |
| 桌面自动节点（含新加的 A7） | `node scripts/probes/desktop-auto-node-probe.mjs --base-port 5670`，本机托管组合，跑两遍 | 两遍都退出 0，`ok: true`，`fails: []` |

单测覆盖：

- PS-01：帧库里同时有项目 A、B（共享档 kA / kB / 两者共用的 kAB，本地档各一版，三条流），绑 A：队里与队列文件里只有 kA、kAB、A 的本地档、A 的流、成员卡 A 也用的那条流；B 的三段加一段找不到 entry 的共 4 段计 `outOfScope`；层表只写 A 的。
- PS-02：不给 scope 或 `ALL` 时全进队（原来的行为）。
- PS-03：项目文档 id 还没到：不进队、不落盘、层表不写；`rescope()` 在还不知道时继续扣着，知道后放行 A 的 2 段、丢掉 B 的 1 段，扣着时的优先级带过去。
- PS-04：换绑定、撤绑定：A、B 各自的目录只有自己的段，帧库根不写老队列文件；绑回 A 读回 A 留下的段。
- PS-05：共享配置的 `contentId` 可选，不合格报错。
- AS-01：没有显式基址时，第一次 `put` 在登记到之前不发，登记到了直接去登记的素材服务（不先落本机）；之后登记变空照旧换回本机。
- AS-02：登记里只有本机自己登记的 → 本机；连不上（等满 `settleMs`）→ 本机；有 `PROMPTCUT_ASSET_URL` → 立即用它、不等。
- AS-03：页面晚给的基址在登记之前被选上。

探针 A7（第一遍）摘要，stdout 最后一行里的相关字段：

```json
{"ok":true,"fails":[],"run":"mumi8g3j9043","target":"local","ms":772859,
 "a1":{"asset":"http://127.0.0.1:5670/media/api/asset","assetSettled":true,"scope":["p-mumi8mdi-49cdfafd"]},
 "a2":{"blocks":120,"present":120},
 "a7":{"ms":360824,"otherDocId":"p-mumi9phz-ba9e5c42","keyB":"cc7c30b0ebcb","frames":120,"blocks":120,"leaked":0,"layerMapMissing":true,"outOfScope":108,"scope":["p-mumi8mdi-49cdfafd"],"published":["p-mumi8mdi-49cdfafd"],"outOfScopeLines":3},
 "a6":{"nodes":[],"layerMapMissing":true},
 "cleanup":{"deleted":[{"projectId":"sp_an47svzab3ik7cgoyeakqfh76x","result":"shared.admin.ok"},{"projectId":"sp_yi52qcfpqldxinzvwimtboijve","result":"shared.admin.ok"}],"listening":[]}}
```

第二遍：`ok: true`，`fails: []`，`ms: 830152`；A7 `blocks: 120, leaked: 0, layerMapMissing: true, outOfScope: 108`，`published` 只有绑定项目。

A7 的核对项：另一个项目 B 的重卡在本机渲满 120 帧；B 的 120 个块（去掉与 A 相同的）在云端素材服务里一个都没有；云端内容库没有 B 的层表；推送诊断 `outOfScope` 108、队里没有 B 的键；本机节点发布过的 plan 只有绑定项目的；编辑器日志里看得到 `push.out-of-scope`；开 B 没有打断共享项目的绑定；绑定项目 H 那一层仍齐、块都在云端。

跑完都停了：探针的 `cleanup.listening` 为空；自己起的 dev server（5670，pid 49800 及子进程）用 `taskkill /T` 停掉，5670～5672 与它的预渲染端口 1718 都已空。

## 4. 〔裁〕与需要主会话定的事

1. **J.13 补一条（三级）**：没有显式基址时第一次推送、拉取先等登记（最多 10 秒）。试过的别的路：只延后 `queue.start()`——挡不住节点 sink 与 `task.done` 拉取，也挡不住登记没到时的读回段，所以放在客户端代理上。
2. **J.14（三级）**：推送只推绑定项目的产物，规则见契约。
3. **auth-contract 第 11 节（三级，改配置格式）**：共享配置加可选 `contentId`。老路径只知道共享空间 id，不知道项目文档 id（两者在共享项目里不同，见 `syncManager.ts` 的 `docProjectId` 与 `project.id`）；试过的别的路：从文档服务取空间的项目真身读 `id`——项目客户端没有 `project.open`，要新加协议调用，改动面大；按本节点发布过的 plan 反推——发布本身就是漏洞的一部分，不能拿来定范围。**没写 `contentId` 的老路径仍然不限**（记一行 `push.scope`），这是有意留的兼容：现有探针与独立渲染主机不带这个字段。要不要改成「不写就只推空间真身」由主会话定。
4. **本机身份的老路径（`PROMPTCUT_PUSH=1` / `PROMPTCUT_QUEUE_NODE=1`，不带共享配置）不限**：连的是本机或自己集群的文档服务，没有共享项目的边界。
5. **没改、只记下的**：`adoptFromManifests`（preload 前从共享项目的内容库拉别的节点的结果）仍对任何项目的 entry 查清单——只是读、查的是哈希键，不送出内容，但会向共享项目的内容库问别的项目的键；在 `frame-pipeline.mjs`（stale-layer 子 Agent 的范围），没动。小尺寸位图（`smallTierEnabled`）在配了推送队列时对所有项目都生成，只写本机、不推。
