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
| `bc91b10` | 报告 |
| `76dab6f` | 合并 `claude/c10-a4`（`fe00dcc`），无冲突 |
| `ecb8cd2` | 探针：A10 等原尺寸齐再导出 |
| `d4d3663` | 探针：`c10-ui-probe` 的 A6 按 C10 普通档对账 |
| `b45ddc6` | 修：低内存档也给分派表喂项目（`ProbeGate`）；`c10-cost-probe` 排障输出 |
| `8bb0cbe` | 诊断：在线普通档转写文档服务记次数；`c10-browser-probe` 核「测完写进文档服务」 |

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

### G0（PC，`ebd78e3`；合 c10-a4 之后的数字见后文）

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


## 合进 `claude/c10-a4`（`76dab6f`）与之后的修正

主会话中途通知 C10-A4（暂停后追到精确活渲再互换）已在 `claude/c10-a4` 修好（`fe00dcc`），要求在两次探针之间合进来。合并无冲突（改动在 `src/editor/stageSwap.ts`、`Preview.tsx` 一行、`c10-browser-probe.mjs` 的 `--only-a4`、单测两条）。

主会话裁定（〔裁〕，照录）：A4 的修法按语义「停下就精确」修同一缺陷，不算改变桌面行为；诊断 `swapTrace`（内存里最多 40 条）保留；「停下到精确要 7～8 秒」与「播放态补跑估时没算同场重卡」记为后续维护项，不在 C10 里做。

跑 C10-A 验收时查出并修的：

| 提交 | 问题 | 改法 |
|---|---|---|
| `b45ddc6` | **低内存档分派表一直是 null**：`c10-browser` 让在线低内存档整个关掉 `ProbeGate`，连带 `setPlanProject` 也不调了。显示表没有判重的层（手机播放中全部活渲），判定表 `prerenderSet` 为空（补渲一条不发）。`c10-cost-probe` 在 `ecb8cd2` 上两轮都挂在这里（`judgedHeavyClips 0`、`snapshotFeed.heavy 0`）。两个分支各自没撞上：c10-browser 没跑 A9，c10-cost 从 `e067d0b` 拉出、那时 `ProbeGate` 还开着 | `ProbeGate.tsx`：预览是 stage 就 `setPlanProject`，测量（`syncProbeRun`）只在非低内存档排。桌面与在线普通档的行为逐字不变（`staged` 与 `enabled` 在那里相同） |
| `ecb8cd2` | A10 第一次跑（`76dab6f`）导出 9 秒就被取消：「还有 1 个重卡片段没有预渲染原尺寸」——探针进入 A10 时创建者还没把主重卡的清单补满（c10-browser 收口时 A10 没跑过，探针的这一段从没验过） | 探针：导出前核对没过就等 15 秒再导，至多 15 分钟；用最后一次的结果判 |
| `d4d3663` | `c10-ui-probe` 的 A6 三条对照判红：探针写于 c10-browser 之前，替身层表是 v 1、按普通档取小尺寸 `px/` 判；合进 c10-browser 后普通档按层表 v 2 取原尺寸 `snap/` | 探针：替身层表写 v 2（带内容键与指纹）；用户卡那一层 `snap/` 与 `px/` 请求都要 0，内置卡那一层 `snap/` 大于 0；「内置卡就绪帧 > 0」改为「内置卡是在线来源认得的层」（替身没上传字节，普通档的就绪要块进了 L2）。判据的意思（用户卡那一层不发快照请求、内置卡照常）不变 |
| `8bb0cbe` | 在线普通档「测完写进文档服务」的接线没有探针证据 | `Preview.tsx` 给这一路记次数（`window.__pcCostPublish()`）；`c10-browser-probe` 在 A2 之后核：写成的记录数 ≥ L2 里的条数、没有失败 |

## C10-A 本机验收（PC，端口 5420～5427）

在线构建每次改了 `src/` 都重建（`npx vite build --mode online --outDir <scratchpad>/online-dist`），产物里的代码版本与 `frameCode` 同值。

| 编号 | 命令 | 最后一次通过的提交 | 结果与数字 |
|---|---|---|---|
| A1 | `c10-browser-probe --dist <在线构建>` | `8bb0cbe` | 过。两个舞台 5421、5422 与编辑器页 5420 同站跨源，三页都带 OAC，CDP 里各是独立 iframe 目标；宿主能力 A、B 都是 `measure: true, catchUp: true, prerender: false, lowMemory: false`；播放 10 秒主文档长任务 **0**；主重卡快照换了 57 帧；按拍投递 271 次；探针帧 4 帧全部 gzip 字节转移（13948 字节）、字符串 0 |
| A2 | 同上 | `8bb0cbe` | 过。加载遮罩出现又退下；L2 `costs` 4 条、全是 `mode=build`；**测完写进文档服务 4 次、4 条、失败 0**；重开遮罩不再出现、costs 不变、已在 L2 的块重新请求 **0**、L2 命中 3 |
| A3 | 同上 | `8bb0cbe` | 过。成员页 `snap/` 342、`px/` **0**；层表 v 2；每层 `envFingerprint` 都是创建者的 `258acaaa7c5fe509`；跨源舞台的 `/media` 都打自己的源（5421→5421、5422→5422） |
| A4 | 同上（另 `--only-a4` 在 `76dab6f` 过一轮） | `8bb0cbe` | 过。0.1 秒处 `fit` 7、`deadMs` 23.33，两层显示占位；播放到头点到 0.5 秒后追到精确活渲、3 秒后仍是活渲。`--only-a4`（`76dab6f`）的 `swapTrace`：点 0.5 秒 20277 → 播放态收手 22116（`pendingSettleT 0.5`）→ 暂停态补跑 0.5（stale 10）→ 渲完 28381。看过 `a4-settled-live.png`（播放头 0.50、暂停，重层都是卡面、无占位）与 `a4-placeholder-while-playing.png` |
| A5 | 同上 | `8bb0cbe` | 过。创建者关掉后改主重卡：页面发布 `plan:<项目>@2#clips:…`、`open`、无报错；独立渲染主机（host 档、测试指纹 `0c10b0e5f1a9e7d2`）认领 3、完成；新层环境是主机指纹、就绪 60 帧；播放中快照文字 `main-v2` |
| A6～A8 | `c10-ui-probe --dist <在线构建> --proxy-port 5420 --proxy2-port 5423 --doc-port 5421 --asset-port 5422` | `d4d3663` | 过（`ok: true, fails: []`）。A6：用户卡那一层快照请求 **0**、内置卡那一层 `snap/` 235；徽标只在用户卡上、悬停「该模式暂不支持自定义卡」；舞台 1 个常驻「需要本地 PC 渲染辅助」。A7：置灰入口 `disabled` 带表 A 文案、点击后新请求 0、页面错误 0；`/api` 守卫拦截 0、`/api` 请求 0；被覆盖与丢弃的备份都能下载；离线措辞与常驻提示照表 A。A8：`POST merge/…` → 501 `{"ok":false,"error":"not-implemented"}`。看过 `a6-1-user-card.png`、`a7-4-doc-down-unsent.png` |
| A9 | `small-tier-probe --origin http://127.0.0.1:5420`（桌面 dev server） | `b45ddc6` | 过。S1 60 帧 HTML + 60 张 400×225；S2 bad 0；S4 htmlDiff 0 |
| A9 | `lowmem-online-probe --origin http://127.0.0.1:5420 --remote-port 5426`（`VITE_PC_ONLINE=1` 的 dev server） | `b45ddc6` | 过。G1 单舞台、低内存档；G2 小尺寸视频 3、原尺寸 0、`px/` 2、`snap/` **0**（在线来源 `tier: small`、`store: true`：L2 只存小尺寸）；G3 暂停后追一帧 105 ms 画好；G4 缺原尺寸提示「等待上传方」，到齐后导出 h264 60 帧 + aac |
| A9 | `c10a-demo-probe --local --dist <在线构建> --port 5420 --proxy-port 5423 --doc-port 5424 --asset-port 5425` | `b45ddc6` | 过，368 s。手机小尺寸视频 3、原尺寸 0、`px/` 5、`snap/` 0；播放全抑制、停下追一帧 81 ms；界限搜索 1 条记录测 1 次、轻卡判轻、补渲 0、播放中轻卡占位；改卡后新键 6.1 s、新小尺寸 136 s、整段重渲 186 s，认领顺序 `NNNNNBB`；低内存档导出 300 帧 10.000 s + aac，`snap/` 300、素材原尺寸 3、小尺寸 0 |
| A10 | `c10-browser-probe --a10 --ticket-ttl-ms 20000 --dist <在线构建>` | `ecb8cd2` | 过。等原尺寸齐 5 次（约 75 s）后导出 300 帧、85.5 s（票据时限 20 s）；续签 6 次、失败 0；素材地址换票 12 次 |
| 成本 | `c10-cost-probe --dist <在线构建> --port 5420 --proxy-port 5423 --doc-port 5424 --asset-port 5425` | `b45ddc6` | 过。桌面 16 张测完、4.1 s 内 16 条写进文档服务；手机 16 条记录、测 6 次（二分 4）、界限第 9 张（B = 23.33 ms，门槛 24.6 ms）；9 轻 7 重；补渲清单正好是判重的 7 张；播放中 16 层全抑制 |

没跑过的中间结果（都已在后来的提交上重跑通过）：`ebd78e3` 上的完整 `c10-browser-probe` A1～A3、A5 过、A4 两条不过（合 c10-a4 之前）；`76dab6f` 上 A10 不过（探针时序）；`ecb8cd2` 上 `c10-ui-probe` A6 三条不过（探针没对账）、`c10-cost-probe` 两轮不过（`ProbeGate` 缺陷）。

## 合 c10-a4 之后补跑的 G0 与 G0-R

- `8bb0cbe`：`npx tsc -b --force` 退出码 0；`npm test` 退出码 0，tests 3553、pass 3551、fail 0、skipped 2（同上两条）。
- `76dab6f`（合 c10-a4 之后，dev server 5420）：`preview-fallback-probe` fails []，99 / 64 / 55 / 61 拍、透明拍数全 0；`--page-preload` fails []，99 / 66 / 66 / 62 拍、透明拍数全 0；`verify-determinism` 1800 / 1800 相同；与 PC 基准 `d70fce7` 逐像素 total 1800、identical 1800、different 0、missing 0、extra 0。
- `76dab6f` 之后的运行时改动只有 `ProbeGate.tsx`（只影响在线低内存档）与 `Preview.tsx` 的在线诊断计数，桌面导出路径没动，G0-R 没再重跑。`verify-unified-frames`、`ready-index-probe`、`stream-produce-probe --group` 只在 `ebd78e3` 上跑过（c10-a4 只改父页的暂停态调度，不碰预渲染与导出）。

## 与契约、语义的出入

- **测试用环境变量**（〔裁〕已接受，生产不设）：`PROMPTCUT_TEST_ASSET_TICKET_TTL_MS`（`server/auth/protocol.mjs`，5 秒～15 分钟才认）、`PROMPTCUT_TEST_ENV_FINGERPRINT`（`server/frame-pipeline.mjs`）。
- 「只改 kit、不改判据」：`c10-plan-publish.test.mjs` 动了 5 行（见「kit 对账」），判据不变。
- `planPublisher.ts` 的行为小改：挂着的请求落定后，期间到期的那一版马上发（原来再等一轮 0.8 秒防抖）。
- 三级语义补写：`mechanism/platforms.md`「连接状态与离线提示」四个数。没有改一级、二级语义。
- 契约第 18 节第 9 条（`ee00efd`）已在本分支；合进 main 时随本分支一起进。

## 需要主会话定的事

1. `ProbeGate` 的修法（`b45ddc6`）：在线低内存档只关测量、分派表照样喂项目。这是两个实现分支之间的缺陷，按「低内存档显示表全部判重、判定表按界限搜索」（契约第 3 节、第 18 节第 8 条）修回，请审。
2. 两个探针的对账（`ecb8cd2` A10 等原尺寸齐、`d4d3663` A6 按原尺寸判）与 kit 之外改的 5 行测试，请审。
3. 带耗时门槛的留给笔记本：`stream-produce-probe`（不带 `--group`）1080p 编码 ≤ 300 ms、`tiers-probe` T4、各探针的时限断言；本分支在 PC 上只跑不带耗时门槛的各项。
4. 维护项（主会话已裁定不在 C10 做）：停下到精确 7～8 秒；播放态补跑估时没算同场重卡；在线构建剪掉置灰入口背后的调用（已记进 `TODO.md`）。

## 进程与端口

本分支起过的进程（三次 dev server 5420、各探针起的编辑器、预渲染进程、托管组合、代理、独立渲染主机、无头 Chrome）都已结束；dev server 由我按命令行核对后结束（只结束 `vite.js --port 5420` 的那几个）。收尾 `netstat` 查 5420～5429 无监听。各探针都删了自己建的云端项目（`shared.admin.ok`）。没有碰 5190～5192、5203～5205。
