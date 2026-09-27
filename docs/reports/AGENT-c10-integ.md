# AGENT-c10-integ：C10 其余集成

分支 `claude/c10-integ`（worktree `.worktrees/c10-integ`），起点 `fcbff6c`。端口段 5420～5429。

派活方：「PromptCut 主会话（PC）」。任务：合 `claude/c10-browser`（`9ad7429`）与 main（`cdeaff9`），做交接文件 `HANDOFF-2026-09-28.md` 第 2.2 节第 2～6 条接线，跑 G0、G0-R 不带耗时门槛的各项与 C10-A 本机验收（A4 除外，由 `claude/c10-a4` 处理）。

## 主会话的裁定（〔裁〕）

- 清单计划用独立的 `#clips:` 键，不与补渲共用 `#backfill:` 键：接受。
- 独立渲染主机写层表（`publishLayerMap` 钩子）：接受；两个只给测试用的环境变量 `PROMPTCUT_TEST_ASSET_TICKET_TTL_MS`、`PROMPTCUT_TEST_ENV_FINGERPRINT`：接受，生产不设。
- A9、A10 由本分支在集成后的代码上跑。
- 云端工作节点已归档，C10 的外网复验与跨机项不经云端。

## 提交

| 提交 | 内容 |
|---|---|
| `9092896` | 报告开工 |
| `c69b096` | 合并 `claude/c10-browser`（`9ad7429`），解五个文件的冲突（见下） |
| `e2c133e` | 合并 main（`cdeaff9`），只有文档，无冲突 |
| `1e74dbc` | c10-kit 对账 K4、K6；发布器等回包期间到期的一版回包后马上发 |
| `ebd78e3` | 接线（交接文件第 2.2 节第 2、3、6 条）、三级数字写进 `mechanism/platforms.md`、TODO 维护项 |

## 冲突怎么解的（`c69b096`）

| 文件 | 两边 | 解法 |
|---|---|---|
| `src/editor/planDispatch.ts` | c10-cost：低内存档两张表（显示表全部判重、判定表按界限搜索），`setPlanAllHeavy` 改名 `setPlanLowMemory`；c10-browser：`deadMs`、`setPlanDeadMs`、`lightCostAt`，仍用旧名 `allHeavy` | 两边并存；两张表都带 `deadMs`；旧名 `setPlanAllHeavy` / `planAllHeavy` 不留（只有 c10-browser 的 Preview 导入过，已换成 `setPlanLowMemory`） |
| `src/editor/snapshotFeed.ts` | c10-ui：用户卡图卡豁免的导入；c10-browser：`fitBeatSwaps`、`SWAP_MS` | 导入并存 |
| `src/render/snapshotSource.ts` | c10-ui：取清单、预取两处循环跳过 `skipLayer`；c10-browser：两处循环改走 `this.layers()`（普通档只认 v 2 且两项齐的层）、原尺寸一档 | 走 `this.layers()`，循环里保留 `skipLayer` 那一行 |
| `src/export/onlineExport.ts` | c10-cost：`heavyOnly`；c10-browser：续签票据的 `mediaUrl` / `freshTicket` | 并存 |
| `src/editor/Preview.tsx` | 导入两边各加一批；在线快照来源 c10-ui 加 `skipLayer`，c10-browser 加 `{ tier, store }` | 导入取并集；构造在线来源时两样都带 |

合并后 `npx tsc -b --force` 零错误；`npm test` 3551 条，6 条失败，全是 C10-T 门开了之后 kit 与实现对不上（C10-LT-01、03，C10-PP-02～05），跳过已是 2。

## kit 对账（`1e74dbc`）

C10-T 的 41 条门在合并后全部打开（跳过回到 2）。判红的 6 条按 `AGENT-c10-browser.md` 的对账表处理：

- **K4 层表**：`layerEntry` / `layerTable` 换成 `layerMapOf` 的真形状（`v: 2`、`kind: 'layer-map'`，每层 `kind`、`key`、`firstFrame`、`count` 齐）。原来的平形层表被 `parseLayerMap` 当成「对不上」，LT-01、03 判红，LT-02、04、05 是因为回空而碰巧过的，现在都真跑通过。
- **K6 发布 plan**：页面发的是清单计划（契约第 18 节第 9 条），结果键 `<projectId>@<projectRev>#clips:<签名>`，工厂要 `clips()`（清单空不发），发布前先 `publisher.hello`。kit 加 `planFactoryDeps`（给固定清单 `PLAN_TEST_CLIPS`；包一层报到应答，假连接断着就照样回 false）与 `planKeyBase`（比 `#clips:` 之前那一段）。
  - **偏离「只改 kit」**：`c10-plan-publish.test.mjs` 动了 5 行——导入这两个函数、工厂调用改走 `planFactoryDeps`、三处结果键比较套上 `planKeyBase`。判据不变（仍是 `parseInbound` 认得、`tasks[0]` 是 plan、键对应这一版、防抖与重发的次数）；结果键的形状本来就列在 kit 头的假设 K6 里，只是字面量写在用例里，kit 够不着。
- **实现的一处修改**（`src/online/planPublisher.ts`）：C10-PP-05 的「回包一直不来」那一种判红。上一版请求挂着（等 15 秒超时）时新一版的防抖已到期、被记成 `again`，原来回包落定后再排一轮防抖，mock 时钟下这一轮不会再推；改为落定后马上发（防抖已经等过了）。真实时钟下只是早 0.8 秒发，行为无别的变化。

C10-T 各文件真跑条数（单跑，`node --experimental-test-module-mocks --test <文件>`，全部 0 失败、0 跳过）：

| 文件 | 条数 |
|---|---|
| `c10-fake-idb` | 7 |
| `c10-l2` | 12 |
| `c10-beat-swap` | 7 |
| `c10-layer-table` | 6 |
| `c10-stages` | 5 |
| `c10-plan-publish` | 6 |
| `c10-ui-gates` | 5 |
| `c10-backup` | 4 |
| `c10-merge-501` | 3 |
| `c10-ticket-renew` | 5 |
| 合计 | 60（桩 7 + 契约 53） |

实现分支自带的 C10 单测：`c10-cost-docservice` 9、`c10-cost-queue` 3、`c10-deploy-stage-origins` 3、`c10-list-plan` 4，全过。

## 接线（`ebd78e3`，交接文件第 2.2 节）

- **第 2 条 在线普通档测完写进文档服务**：两路都接了。`Preview.tsx` 在在线普通档订阅 `onCostRecords`，连着共享项目（`hasDocLink()` 且 `currentSharedLink()` 非空）时当场 `publishSharedCosts({ request: docRequest, projectId: currentDocProjectId(), environment: pageEnvironment(), records })`；另一路是本来就在跑的 `SharedCostRelay`：在线普通档的记录由 `probeRunner` 经 `setPlanCosts` / `mergePlanCosts` 进分派表，`device` 串以本页 UA 与 GPU 渲染器开头、`lowMemory=false`，它每 5 秒补传一次。文档服务按测量时刻留最新，重复无害。
- **第 3 条 低内存档本地复用接 L2**：界限搜索那个 effect 开头 `setLowMemoryCostStore(l2LowMemoryCostStore())`：包一层 `pageL2({ lowMemory: true })` 的 `getCost` / `putCost`，键 `<identityKey>|<envFingerprint>`；与普通档 K1 记录的键 `<identityKey>
<device>` 不相撞，这些记录没有 `device`，普通档读 K1 记录时本来就滤掉。L2 打不开时退回页面内存。
- **第 4 条 kit 对账**：见上一节。
- **第 5 条**：`docs/semantics/mechanism/platforms.md`「在线浏览器模式」补一条「连接状态与离线提示」，写 c10-ui 的四个数（离线类措辞持续 1.5 秒才显示、「已全部提交」显示 4 秒、每 500 毫秒看一次未确认条数、素材到齐后每 5 轮探一次素材服务），各注代码里的常量名。**这是三级语义的补写**（数字本身是 c10-ui 定的、主会话已认，本分支只落到语义文档）。`docs/plan/TODO.md`「已做步骤的遗留」记维护项「在线构建按编译期 `ONLINE` 剪掉置灰入口背后的调用，让 `/api` 棘轮清单变短」。
- **第 6 条 采样帧数**：`probeRunner.ts` 的成本记录加 `samples`（`summarizeProbe` 的 `samples` = 计时趟真实推的帧数）；`cardCostKey.d.mts` 加可选字段并注明只给共享成本记录用、不进判重。旧记录没有时 `samplesOf` 仍按 `device` 串的 `stepN`（16）。

## 验证

### G0（PC，`ebd78e3`）

- `npx tsc -b --force`：退出码 0。
- `npm test`：退出码 0；tests 3551、pass 3549、fail 0、cancelled 0、skipped 2（`集成:/api/cards/layout 对真实项目返回整数框`、`SKILL 闸门:闸关之后无头实例的工具调用不落地`，都是 main 原有的）。
- `npm run build`：退出码 0。`npx vite build --mode online --outDir <scratchpad>/online-dist`：退出码 0；产物里嵌的代码版本 `d43672ff…4c68` 与 `frameCode(cwd)` 同值（在 `index-*.js` 里找到 1 处）。

### G0-R 不带耗时门槛的各项（PC，`ebd78e3`，dev server `npx vite --port 5420 --strictPort --host 127.0.0.1`，舞台 5421 / 5422 带 OAC）

| 项 | 命令 | 结果 |
|---|---|---|
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5420/?export=1"` | 退出码 0；Total 1800、Identical 1800、Different 0（导出 134.8 s，PC 数值不作性能验收） |
| 与 PC 基准逐像素 | `node compare-frames.mjs .worktrees/pc-g0r-base/out/verify-a/frames out/verify-a/frames`（基准 `d70fce7`） | 退出码 0；total 1800、identical 1800、different 0、missing 0、extra 0 |
| 快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5420` | 退出码 0；PASS |
| 就绪索引 | `node scripts/probes/ready-index-probe.mjs --port 5423`（自起编辑器 5423～5425） | 退出码 0；fails [] |
| 组流 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5420 --group` | 退出码 0；PASS、fails [] |
| 兜底透明拍 | `preview-fallback-probe --origin http://127.0.0.1:5420` | 退出码 0；fails []；起播 99 / 跳转 64 / 超过 6 路流 64 / 编辑后 63 拍，透明拍数全 0 |
| 同上，页面自己 preload | 加 `--page-preload` | 退出码 0；fails []；100 / 68 / 61 / 66 拍，透明拍数全 0 |

**留给笔记本（带耗时门槛，PC 上不判）**：`stream-produce-probe`（不带 `--group`）的 1080p 全幅 15 帧编码 ≤ 300 ms 等时限项；`tiers-probe` T4；各探针的时限与加载、换档时间断言。

