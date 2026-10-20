# AGENT 报告：在线页面层表里剪辑段流的输入签名

分支 `claude/cutseg-layer-sig`，工作区 `.worktrees/cutseg-layer-sig`，基于 main `3267ce84`。
背景：`docs/archive/agent-reports/AGENT-cut-segment-prerender.md`「没做成的」第 2 条——在线页面从层表（托管方写给在线页面的「每条流在哪」的那张表，`server/artifact-transfer.mjs` 的 `layerMapOf`）拿流，剪辑段的那一行没带 `streamKind: 'cut'` 与输入签名，被引用剪辑刚改过、渲染节点还没换键的那一小段，父页可能贴上旧的剪辑段流。

## 状态

做完，等主会话审查。基线全绿：类型检查零错误，全量测试 7219 条零失败；端到端探针（本机隔离托管组合 + 在线构建）全过；导出确定性、快照重放、与 main 的导出像素比对、上一轮剪辑段的四个探针都过。没有推送、没有合并。没有改语义文档（属三级的补漏：把桌面版已有的判据接到在线页面，用户看到的承诺不变）。

## 做法（一句话版）

层表 `streams` 表里剪辑段级的流那一行另带 `streamKind: 'cut'`（签名 `inputSig` 本来就写着）；在线来源解析时保留它，就绪消息照桌面预渲染进程发的层的形状带上 `streamKind: 'cut'` 与 `inputSig`；父页 `cutStreamHeavy` 一行不改——它本来就按 store 里当前的项目比签名，对不上就不贴、照旧活渲。于是在线页面与桌面版同一个判据。

## 做了什么

1. **服务端写层表**（`server/artifact-transfer.mjs` 的 `layerStreamsOf`）：`planStreams` 给的流标着 `solo: 'cut'`、而且是单卡流的形状（`kind: 'card'`、`plane: 'local'`、只有一个成员）时，那一行加 `streamKind: 'cut'`。别的行不加这一项，所以没有剪辑段的项目层表一个字节不变。签名照旧由 `streamInputSig(project, { clipIds, kind })` 算，与桌面预渲染进程发层时带的（`frame-stream.mjs` 的 `belowLayerMark`）是同一个值；剪辑段的片段签名含被引用剪辑任意深度的内容，被引用剪辑一改就变。写层表的两处（本机推送队列、独立渲染主机）都经 `FramePipeline.layerMapStreamOptions` → `layerMapOf`，托管方渲染服务的工作进程也走这里，不用另改。
2. **在线来源**（`src/render/snapshotSource.ts`）：`OnlineStream` 加可选的 `streamKind: "cut"`；`parseLayerStreams` 只对「单卡、包裹层坐标」的行保留它；`streamMessage` 对这种行带上 `streamKind: "cut"` 与 `inputSig`。旧节点写的行（没有 `streamKind`）照旧：消息里不带这两项，父页照贴，与改动前相同。
3. **父页诊断**（`src/editor/snapshotFeed.ts` 的 `snapshotFeedDebug`，只加诊断、不改判据）：`ready` 里每层带上 `streamKind`（有才带）；另列 `staleCut`——就绪索引里有、签名对不上当前项目的剪辑段流。探针用它核对。
4. **测试**
   - `server/test/cutseg-layer-sig.test.mjs`（服务端，LS-1～LS-4）：真的卡片计划 + `planStreams` + `layerMapOf`。LS-1 剪辑段那一行带 `streamKind: 'cut'`，签名与桌面发层时的相同；LS-2 两层深的被引用剪辑改了，旧行签名对不上新项目，渲染节点换键重写后新行对得上；LS-3 **没有剪辑段的项目层表一个字节不变**：固定输入（`server/test/cutseg-layer-sig-fixture.mjs`：单卡流、组流、依赖下层的流、`solo: 'source'` 的流、两层快照层）的 `JSON.stringify(layerMapOf(...))` 的 SHA-256 写死为 `5840986d…a9c21c`（3733 字节），这个值是用主工作区 main `3267ce84` 未改动的 `artifact-transfer.mjs` 对同一份输入算出来的，改动后算出来相同；LS-4 形状不对的（舞台坐标、多成员）即使标了 `solo: 'cut'` 也不带。
   - `src/editor/snapshotFeedCutOnline.test.mjs`（页面，CO-1～CO-3）：真的在线来源（假内容库 + 假素材服务）接真的父页判重；层表那一行用服务端真的 `layerStreamsOf` 写。CO-1 就绪消息带 `streamKind: 'cut'` 与签名，签名对得上、流铺满 → 判重、抑制、发流平面；CO-2 改「里」那张卡（两层深）：store 里是新项目而在线来源还没收到时，父页当场不贴旧流（`cutStreamHeavy` 假、不抑制、不发流平面、诊断 `staleCut: ["S"]`），在线来源收到新项目后撤层，层表换成新行（新键、新签名）后贴新流；CO-3 旧节点写的行（没有 `streamKind` 与签名）照旧贴。
   - 反证：把 `src/render/snapshotSource.ts` 换回 main 的版本跑 CO 测试，CO-1、CO-2 失败（CO-2 恰在「旧流签名对不上:不贴」那一句），CO-3 通过——测试确实钉住了本次补的口子。
5. **端到端探针** `scripts/probes/cut-online-e2e-probe.mjs`（骨架照 `below-online-e2e-probe.mjs`：本机隔离的托管组合 + 在线构建 + 真的桌面预渲染进程当切分方）。场景：剪辑「里」上一张 `punch-pill`（文字 v1），剪辑「中」引用「里」，激活剪辑上剪辑段 S（0.2～2.2 秒）引用「中」——两层嵌套；S 测量落定后钉重。断言 A 层表、B 就绪、C 播放、D 改被引用剪辑、E 新流、F 页面错误，见文件头。

## 文件清单（相对 `3267ce84`）

修改：`server/artifact-transfer.mjs`、`src/render/snapshotSource.ts`、`src/editor/snapshotFeed.ts`（只加诊断）。
新增：`server/test/cutseg-layer-sig.test.mjs`、`server/test/cutseg-layer-sig-fixture.mjs`、`src/editor/snapshotFeedCutOnline.test.mjs`、`scripts/probes/cut-online-e2e-probe.mjs`、本报告、`docs/reports/assets/cutseg-layer-sig/**`。

## 验证

全部在 `a440bba4`（代码与测试的最后一次改动）之后跑；探针脚本另在 `9ccf85c3` 定稿。端口只用 5410～5418。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `node scripts/test-suite.mjs`（即 `npm test`；命令里设 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT`、`PROMPTCUT_PASSWORD_ORDER_MODULE`） | 退出码 0；tests 7219、pass 7205、fail 0、cancelled 0、skipped 14 |
| 新增单测（服务端） | `server/test/cutseg-layer-sig.test.mjs` | LS-1～LS-4 四条全过（也在全量里） |
| 新增单测（页面） | `src/editor/snapshotFeedCutOnline.test.mjs` | CO-1～CO-3 三条全过（也在全量里）；把 `snapshotSource.ts` 换回 main 的版本时 CO-1、CO-2 失败（反证） |
| 端到端（新） | `node scripts/probes/cut-online-e2e-probe.mjs --dist <在线构建> --base-port 5410 --out docs/reports/assets/cutseg-layer-sig` | 退出码 0，`fails: []`，结果 `docs/reports/assets/cutseg-layer-sig/e2e-result.json`，见下 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5410/?export=1"` | 退出码 0；Identical 1800、Different 0 |
| 快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5410 node scripts/verify-unified-frames.mjs` | 退出码 0；PASS |
| 与 main 的导出像素比对 | `bash .worktrees/_export-baseline/check.sh <本树> cutseg-layer-sig 5413` | 退出码 0；240 帧，对 89c15177 第二种结果（A）240/240 逐字节相同，PASS（不含剪辑段的项目像素不变） |
| 上一轮剪辑段预渲染（管线级） | `node scripts/probes/cut-segment-prerender-probe.mjs --port 5416` | 退出码 0，`fails: []`，PASS（逐帧最像自己那一帧，误差 0.24～0.26/255；改两层深的剪辑成本键 `1c7e552f070c88`→`f9f1523b1faaa`） |
| 上一轮剪辑段预渲染（编辑台） | `node scripts/probes/cut-segment-prerender-editor-probe.mjs --port 5416` | 退出码 0，`fails: []`，PASS（改动后当场 `heavyRightAfter: false`，重产 `solo: cut` 满密度 8 段） |
| 上一轮剪辑段界面探针 | `node scripts/probes/cut-nesting-ui-probe.mjs --origin http://127.0.0.1:5410` | 退出码 0 |
| 上一轮剪辑段面板探针 | `node scripts/probes/cut-segment-panel-probe.mjs --origin http://127.0.0.1:5410` | 退出码 0 |

没跑：上一轮的剪辑段声音、有声卡导出、兼容旁路三个探针——本次没碰声音与导出取帧（`snapshotSource.ts` 是在线预览的来源，导出页不用它），导出确定性与像素比对已覆盖画面。

**端到端探针的结果**（`e2e-result.json`）：
- A 层表：S 那一行 `kind: card`、`plane: local`、**`streamKind: cut`**、`inputSig: s1-ac218662…`、`originFrame: 6`、分段 0～3；层表里没有别的行。切分方 8 秒产完满密度。
- B 就绪：在线来源选中切分方那一份，4 段全就绪；父页就绪索引里 S 的流层 `streamKind: "cut"`；`staleCut: []`。
- C 播放：34 个样本里 33 个是这条流在画（`pushed: true`、`errors: 0`，画到第 56 帧跟着播放头），S 的包裹层一直被抑制。
- D 改「里」那张卡的文字（两层深）：改之前父页在发旧流平面；改完 **1 ms** 父页不再发、S 不再判重（`heavyAfter: []`），诊断里认出过期（`staleSeen: true`）；在线来源撤掉旧流；舞台上没有旧键的轨道、S 不抑制、没有占位符（活渲）；随后播放，旧流没有再贴上来。
- E 新流：切分方 8 秒重产；层表换成新行（内容键 `5ae22777…`→`435552bf…`、签名 `s1-ac21…`→`s1-e629…`，仍带 `streamKind: cut`）；甲认出新流、贴它（31/33 个样本在画新键）。
- F 页面零报错。全程 42 秒。

看过的图（`docs/reports/assets/cutseg-layer-sig/`）：`play-v1.png`（贴旧流播放中，药丸写「剪辑段签名 v1」）、`after-edit-live.png`（改完、活渲，写「v2」——没有贴旧流）、`play-v2.png`（贴新流播放中，写「v2」）。

## 第二轮(主会话审后追加):长剪辑段整段产出即可贴流

主会话审过第一轮后，让把上面观察到的那一处也做掉（三级，用户看到的只是更早贴上流）。

**做法**（`src/render/snapshotSource.ts`，只对层表里带 `streamKind: 'cut'` 的行）：
- `loadStreamWindow`：这种行取**整段**的分段清单，其它行仍只取播放头附近的；
- `streamReady`：这种行的就绪区间按「清单里列着（已产出）」算，不要求字节已在本页。这和桌面预渲染进程发的层是同一个口径：就绪区间是已产出的分段，舞台要哪段字节当场去取；
- 字节照旧只按播放头附近取（`prefetchStreams` 没动），父页拿到字节就重投。这一拍的字节还没到时，舞台照「这一拍画不出来」处理：留着上一张，最多一个分段的时长，和桌面一样；
- `cutStreamHeavy` 的判据没改，仍是「整段铺满 + 签名对上」；
- 诊断里每条流另记 `bytes`，即这条流有几段的字节已在本页。

**语义**：`mechanism/rendering.md`「剪辑段」的「贴流」小条补了一句，标〔裁：cutseg-layer-sig 2026-10-21（三级）〕。

**测试**（`src/editor/snapshotFeedCutOnline.test.mjs`）：
- CO-4：8 秒剪辑段，16 段、两份清单。两份清单都取了，就绪区间 `[[0, 15]]`；字节只取了第 0～4 段（另有开头文件），开播就判重、发流平面。播放头挪过去以后，后面那几段的字节才取。
- CO-5：第 12 段还没产出时，就绪区间 `[[0,11],[13,15]]`，不贴、照旧活渲；产出以后贴。
- 反证：换回上一轮的 `snapshotSource.ts`，CO-4、CO-5 都失败。

**端到端探针加 G 一例**：
- 场景：项目改成 10 秒；剪辑「里」加一层会动的粒子，让每个分段的字节都不同。分段字节按哈希去重，画面静止时各段字节相同，数不出取了几段。
- G 的做法：再加一个 8 秒的剪辑段 L（第 1～9 秒，16 段）并钉重。
- 改动后 S 的成本身份可能换了：新身份测出来又没判重时，同样钉重、刷新。这一步原来没有，有一次跑因此等不到重产。
- 双舞台在停下补跑后会换可见的那一台，所以播放计数按舞台分开看。

**第二轮验证**（代码在 `64eadf4b` 定稿，探针在 `d50dbf87` 定稿）：

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，输出 0 行 |
| 全量测试 | `node scripts/test-suite.mjs`（同上设两个环境变量） | 退出码 0；tests 7221、pass 7207、fail 0、cancelled 0、skipped 14 |
| 受影响的测试 | `snapshotFeedCutOnline`、`onlineStreams`、`snapshotFeedBelowOnline`、`onlineSnapshotSource`、`snapshotSource` 五个文件 | 48 条全过 |
| 端到端 | `node scripts/probes/cut-online-e2e-probe.mjs --dist <重建的在线构建> --base-port 5410 --out docs/reports/assets/cutseg-layer-sig` | 退出码 0，`fails: []`（`e2e-result.json`）。G：L 的层表行 `streamKind: cut`、分段 0～15，切分方 8 秒产齐；播放头停在 L 头上时在线来源认 L 整段就绪（`ready: 16`），而字节只有 1 段在本页（`bytes: 1`）；父页判重并发流平面；从第 1.05 秒开播，**第 1.13 秒**舞台已在画 L 的流（30/32 个样本），不报错。A～F 照旧全过（改动后 1 ms 不再发旧流）。 |

看过的图：`play-long.png`，长剪辑段开播不久就在贴流，粒子和「v2」药丸都在。

没重跑：导出确定性、快照重放、像素比对、桌面的剪辑段探针。第二轮只改了在线来源（`snapshotSource.ts` 只在在线浏览器页面里用，导出页、桌面预渲染进程不用它）和测试、探针、文档；第一轮在 `a440bba4` 上跑过的这几项都过。

另记：这一轮的 G 我没有拿旧代码重跑来对照。前一次旧代码对照跑的时候，场景是静止的药丸，各段字节相同，算不出差别。区分新旧的证据是单测 CO-4、CO-5 的反证。

## 没做成的与原因

无。

## 对任务书或语义的更正建议

- 端到端探针的经验：改被引用剪辑之后，在线页面里剪辑段的成本身份会不会换、新身份判不判重并不确定，所以探针要按需再钉一次。这不是缺陷，是测量与钉重的现有行为。
- 在线页面上剪辑段贴流的前提，是有切分方（桌面成员或托管渲染服务「生成轨道流」开着）为它产流；这一点沿用上一轮的说明。

## 部署要换什么

- **服务端**：换 `server/artifact-transfer.mjs`。它被渲染服务 / 预渲染进程（桌面版的预渲染进程、托管方的渲染服务及其工作进程、渲染主机）写层表时用（`FramePipeline.publishLayerMap`、`vite-plugin-frames.ts`）。重启托管方的**渲染服务**（连同工作进程）与渲染主机。文档服务、素材服务、Agent 服务不用换（层表只是内容库里的一条，它们不解析 `streams` 的字段）。
- **改了 `src/`**（`src/render/snapshotSource.ts`、`src/editor/snapshotFeed.ts`）：整份 `src/` 同步进渲染树；**先换在线前端**（重建在线构建、换静态页——在线来源与父页判重都在前端构建里），**再重启渲染服务**。顺序的理由：新渲染服务写的行多一个 `streamKind`，旧前端不认、照旧贴（与现在相同）；新前端读旧层表（没有 `streamKind`）也照旧贴；两种顺序都不会坏，但先换前端能让渲染服务一重启写出的新行马上生效。
- 第二轮的改动全在 `src/render/snapshotSource.ts`（在线前端），服务端不用为它另换。
- 没有剪辑段的项目层表一个字节不变，旧缓存、旧层表照用；有剪辑段的项目，渲染服务重启后下一次写层表时那一行多出 `streamKind: 'cut'`，不用清缓存。
- 桌面版：随下一个补丁一起出（桌面版自己的贴流判据本来就带签名，这次只是让它写给在线页面的层表也带上）。
