# AGENT 报告：在线浏览器模式改参数后舞台仍贴旧层（claude/stale-layer）

分支 `claude/stale-layer`，起点 main `76eee894`（v0.7.2）。端口段 5750～5759。

任务：交接文件 `HANDOFF-2026-09-29.md` 第 4 节第二条——在线浏览器模式下，成员改了用户卡、图卡或内置重卡的参数后，新结果到之前舞台仍贴改之前那一层。这与语义冲突：`product/platforms.md`「在线浏览器模式」最后一条、`product/rendering.md`「兜底顺序」要求有**这一帧**的预渲染结果才照贴，旧参数的层不是这一帧的结果。按原则 2（语义优先）改代码。

## 1. 做了什么

### 判据：层表每层带「输入签名」`inputSig`

- 新模块 `src/render/layerInputSig.mjs`（带 `.d.mts`），服务端与页面共用：`clipInputSig(project, clipId)` 返回 `i1-<16 位十六进制>`，算不出时返回 null。
  - **进签名**的是项目数据里两边都拿得到的片段输入，与共享快照键 `cardSnapshotIdentity` 的「项目数据那一半」对齐：
    - 片段自身：`cardId`、`params`、`parts`、`emphasis`、`mediaId`、`mediaOffset`、`filter`、`pixelMap`、框宽高 `frame.w/h`、时长 `end − start`、采样相位（`start` 落在帧格里的小数部分）；
    - 片段引用的库条目：`project.filters`、`project.pixelMaps` 里的那一条；素材按 `hash` 算（没有 hash 用 id），不看 url，因为 `renderProject` 会改写 url；
    - 图卡：`project.cardNodes` 里这个节点，以及沿 `inputs` 能走到的全部节点。输入指向别的片段（`@clip/<id>/…`）时，递归取那个片段的输入，再加上它相对本片段的起点差。有环路时不会死循环；
    - 项目：画幅宽高、fps、`camera3dFov`、`themeId`、`style`。
  - **不进签名**：位置、锚点、缩放、旋转、不透明度、淡入淡出、motion、音量与音频效果、整帧平移。这些都不在快照里（A2(5)），改了照贴原来那一层。
  - 卡片源码、字体、环境也不进签名：页面拿不到与节点同口径的值。这几样变了仍靠节点换键、重写层表（和以前一样），见第 5 节。
  - 规范 JSON 用 `cardJson`，哈希用 `changedClips.mjs` 的 `hashString`（FNV-1a 两路，64 位），页面和 Node 都能同步算。
  - `inputSigStale(layerSig, pageSig)`：两边都有签名、算法版本相同、而且值不同，才判过期。任何一边没有签名、或版本前缀不同，都不判过期（向后兼容）。
- **写层表**：`server/artifact-transfer.mjs` 的 `layerMapOf` 按 `entry.project` 给每层写 `inputSig`；片段不在这一版项目里时不写这一项。所有写层表的路都经过它：PC 推送队列的 `publishLayerMap`、独立主机 `vite-plugin-frames.ts` 的 `publishLayerMap` 选项、补渲登记，所以别的成员的计划和桌面自己的预加载都覆盖到了。**不升层表版本号**。
- **页面侧**：`src/render/snapshotSource.ts` 的 `OnlineSnapshotSource`：
  - 新增 `setInputs(project)`，项目换了新对象才重算，签名按项目对象引用缓存；
  - `layers()` 过滤掉签名对不上的层；
  - `publishLayers()` 对发过、但现在不能用的层发空就绪（撤层）。`emitted` 由签名字符串改成记 `{ sig, clipId, kind, key }`；
  - `fetchSnapshot`、预取、`layerClipIds` 都不再给过期层（低内存档据此会对过期的层补渲）；
  - **兜底**：层过期后 `STALE_AWAIT_MS`（15 s，三级数字）之内算「新结果在路上」。这段时间里 `frameConfirmedMissing` 回 false（用户卡、图卡显示沙漏），`coverage` 回 `unknown`（时间轴不挂徽标）。过了还没等到按新输入重写的层表，就和「层表里没有这一层」一样确认缺料（图标、徽标），并在 `tickOnce` 里通知覆盖订阅方；
  - `debug()` 多出 `stale` 与各层的 `inputSig`；
  - `layerRefOf` 新增 `opts.inputSig`，对不上回 null。
- **接线**：`src/editor/Preview.tsx` 建来源时交一次项目，之后每次 `project` 变了都交一次（本页改的、别的成员同步过来的都算）。内置重卡改了参数后就绪区间变空，按在线普通档的兜底走：播放时占位，暂停时活渲。
- **导出**：`src/export/originals.ts` 的 `loadOriginalsIndex` 新增 `project` 选项（`browserExport.ts` 传入）。签名对不上的层不取，这张卡算缺，导出前核对会等着。否则在线导出会把旧参数的画面导出去。

### 为什么选签名，不选版本号

任务书给了两条路。「片段最后一次修改的版本号对产生该层的计划版本」走不通：页面不知道每个片段在哪一版改过，中途加入的成员更不知道，要知道就得拉历史版本。签名只要求两边对同一份项目数据用同一个纯函数计算。探针实测：甲、乙两页经文档服务同步的项目，和节点按 `renderProject` 处理过的项目，三方算出的签名一致（见第 2 节探针的 `sigs`）。改回原来的参数时签名自然相等，所以原来那一层还在就照贴，不用额外逻辑。

## 2. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 错误 |
| 新单测 | `node --test src/render/layerInputSig.test.mjs` | 6/6 通过（SIG-1～6：同一份项目同签名、JSON 往返同签名、改参数变、改回复原；不进快照的字段不变；进快照的字段变；图卡上游与环路；比对与向后兼容；`layerMapOf` 写的与页面算的相同） |
| 新单测 | `node --test src/render/staleLayer.test.mjs` | 5/5 通过（SL-1～5：改参数同步撤层、沙漏期、到期确认、新层换上；改回照贴；旧层表与没给项目时照旧；普通档 v 3 候选与 `layerRefOf`；导出算缺） |
| 相关旧单测 | onlineSnapshotSource、m7-*、c10-*、c10a-*、small-tier、m7-queue、editor/c10a-* | 103/103 通过 |
| 全量测试 | `npm test` | 3867 项：3864 通过、1 失败、2 跳过。失败的是 `server/test/c66-tiers.test.mjs` C66-T1-11（ffmpeg 重封装晚置 moov，与本改动无关）。单独重跑该文件 13/13 通过，判为机器负载下的偶发 |
| G0-R 导出确定性 | dev server `npx vite --port 5750 --strictPort --host 127.0.0.1`；`node scripts/verify-determinism.mjs --url "http://127.0.0.1:5750/?export=1"` | 1800/1800 相同，退出码 0 |
| 像素基线 | `compare-frames.mjs <pc-g0r-base>/out/verify-a/frames <本 worktree>/out/verify-a/frames` | total 1800，different 0，missing 0，退出码 0 |
| 导出与快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5750` | PASS |
| 就绪索引 | `node scripts/probes/ready-index-probe.mjs --port 5753` | 退出码 0，`fails: []` |
| 轨道流 | `stream-produce-probe --origin http://127.0.0.1:5750`，以及加 `--group` | 两次都 PASS，`fails: []` |
| 预览兜底 | `preview-fallback-probe --origin http://127.0.0.1:5750`，以及加 `--page-preload` | 两次都退出码 0、PASS；transparentBeats 均为 0（275 拍 / 274 拍） |
| 在线构建 | `npx vite build --mode online --outDir out/dist-online` | 退出码 0 |
| C10 界面探针 | `node scripts/probes/c10-ui-probe.mjs --dist out/dist-online --proxy-port 5754 --doc-port 5755 --asset-port 5756 --proxy2-port 5757` | 退出码 0，`ok: true` |
| 在线用户卡探针 | `node scripts/probes/online-user-cards-probe.mjs --dist out/dist-online --base-port 5750` | 退出码 0，`ok: true, fails: []`（它自己写的层表是 v 2、不带签名，照旧贴，也验证了向后兼容） |
| **本任务探针** | `node scripts/probes/online-stale-layer-probe.mjs --dist out/dist-online --base-port 5750` | 退出码 0，`ok: true`，最后一行见下 |

本任务探针（新写的 `scripts/probes/online-stale-layer-probe.mjs`）用本机托管组合加三源代理。探针替渲染节点，按乙页面手里的项目、用服务端 `layerMapOf` 写层表，所以层表带真实的 `inputSig`。舞台里装 MutationObserver 记时刻，各文档先对探针进程校钟。覆盖的步骤：

1. 第一版层表下，用户卡 u（同步卡）贴 `SNAP u v1`，内置重卡 b（`probe-slow-stepped`）播放中贴 `SNAP b v1`；
2. 甲改 u 的参数：甲 6 ms、乙 7 ms 后不再贴旧层，都显示沙漏（`awaiting`）。乙的 store 在第 11 ms 才被轮询看到这次修改（每 10 ms 看一次），所以乙从「收到」算起是 0 ms；
3. 改回原来的参数：两页都又贴回 v1；
4. 两页都在播放、都在贴 b 的旧层时，甲改 b：改之后两页再也没贴过 `SNAP b v1`。之后播放是占位（`no-data`）或活渲。再改 u：沙漏；等满 15 s 转成「需要本地 PC 渲染辅助」图标，时间轴出徽标；
5. 写第二版层表：u 约 170 ms 内换上 `SNAP u v2`，图标与徽标撤掉；播放中 b 贴 `SNAP b v2`，之后没有过期层。

最后一行 JSON：

```
{"ok":true,"fails":[],"edit1":{"editToStaleA":6,"editToStaleB":7,"editToSyncB":11,"syncToStaleB":0,"editToGlassA":6,"editToGlassB":7},"revert":true,"edit2":{"bA":["ph:awaiting","ph:no-data"],"bB":["live","ph:no-data"],"iconA":true,"iconB":true},"fresh":{"uA":169,"uB":170,"bA":["ph:no-data","SNAP b v2"],"bB":["ph:no-data","SNAP b v2"]},"maps":{"v1":[{"clipId":"osl-u","inputSig":"i1-45e04af223f9dae1"},{"clipId":"osl-b","inputSig":"i1-e4d57f7b9bf55534"}],"v2":[{"clipId":"osl-u","inputSig":"i1-103fd4ca13b96d09"},{"clipId":"osl-b","inputSig":"i1-56cf19daaab21d7b"}]}}
```

**反证**：临时拿掉 `Preview.tsx` 里两处 `setInputs`，重新构建（`out/dist-online-nosig`，没提交）后跑同一个探针。结果挂 13 项：甲、乙两页改参数后仍贴旧层；乙在改完之后 `nowB.snapText` 仍是 `SNAP u v1`；内置重卡播放中仍贴 `SNAP b v1`；等满也不出图标。这证明探针测得出这个 bug。

**看过的图**（`out/stale-shots/`，未入库）：

- `stale-1-A-v1.png`：绿色 `SNAP u v1`；
- `stale-2-A/B-hourglass.png`：u 的位置只剩沙漏徽标；
- `stale-3-A-icon.png`：「需要本地 PC 渲染辅助」横排图标；
- `stale-4-A/B-v2.png`：橙色 `SNAP u v2`。

右下角的橙色块是暂停时活渲的 b。

所有由我起的进程都已停掉：dev server 5750～5752 的 vite 进程是 npx 起的子进程，停任务后还留着，核对命令行确认是我起的之后结束了它。探针退出时自己收摊。

## 3. 没做成的、以及顺带发现的（不是本改动引入的）

- **卡片源码改了**（例如成员改了用户卡的代码而不是参数）不在签名里，仍要等节点换键、重写层表。页面拿到的是内容库里源码的哈希，节点的代码身份是「定义文件加它一路 import 到的卡片 / 部件文件」的闭包身份，口径对不上，硬比会让所有层永远算过期。要覆盖这一类，得让节点在层表里另写「这张卡的源码在内容库里的哈希」，页面比 `card-source` 的哈希。这要动 `card-sync` 那一路，超出本任务的文件范围，留作后续。
- **暂停时 u 偶尔在旧层与沙漏之间闪一下**：探针静置 6 s，甲闪 1 次、乙闪 2 次（只记不判）。拿掉本改动的构建上照样闪，看起来和舞台换班、父页 5 秒一次的对账重投有关。这与语义「预览里任何一层都不无提示地透明」「来不及的状态很短时不显示占位符」有出入，建议另立一项。
- **播放中重卡每拍在快照与占位（`no-data`）之间交替**：探针的舞台记录里可见，拿掉本改动也一样。可能是预取窗口、L2 就绪与投递节奏的交互，建议与上一条一起查。
- `mechanism/rendering.md` 没改（子 Agent 不直接改语义），建议见第 5 节。

## 4. 契约改处〔裁〕

- `docs/plan/c10-contract.md` 第 9 节新增「旧参数的层」一条：写明判据、`STALE_AWAIT_MS` 兜底、导出算缺、签名取什么不取什么、向后兼容。
- `docs/plan/c10-contract.md` 第 18 节新增 2026-09-29 一条：写明冲突在哪、为什么不升版本号、试过而没取的路。
- `docs/plan/m7-contract.md` D12 补一句：v 3 的层可另带 `inputSig`。
- 代码里标〔裁〕的地方：`server/artifact-transfer.mjs`（`LAYER_MAP_VERSION` 注释与 `layerMapOf`）、`src/render/snapshotSource.ts`（`OnlineLayer.inputSig`）。
- `docs/plan/render-queue-contract.md` 里查不到层表的定义（层表 v 3 定在 M7 契约 D12 与 C10 契约），所以没改它。

## 5. 对语义与任务书的建议

- `mechanism/rendering.md`（三级）建议补一条（主会话定）。**修改前**：没有这一条。**修改后**：「在线页面按层表每层的输入签名（片段在项目数据里的输入：参数、parts、强调、框宽高、时长、采样相位、滤镜与素材、图卡上游、画幅、fps、主题、style）认出旧输入的层，不贴；过期后 15 秒内当结果在路上（沙漏、不挂徽标），过了还没新层按没有结果处理（图标、徽标）。卡片源码、字体、环境的变化靠渲染节点换键重写层表。」
- 任务书说「内置重卡按在线普通档的规则（占位或活渲）」，实测正是这样：播放时 `no-data` 占位，暂停时活渲。
- 任务书第 1 条写的是「用户卡、图卡结果在路上时是沙漏，父页确认没有结果时是图标」。在「层过期」这个新情形里，我把「确认」定为：过期满 `STALE_AWAIT_MS` 还没等到新层表。这是新设的三级数字（15 s），请主会话确认数值。节点忙时新层表可能晚于 15 s，那样中间会先出图标、新层到了再换上。

## 6. 提交

- `ffe85794` 报告：开工
- `f1ef566e` 实现与单测（签名模块、`layerMapOf`、`OnlineSnapshotSource`、`Preview` 接线、导出）
- `4c957a04` 探针 `online-stale-layer-probe.mjs`
- `694ce532` 契约〔裁〕
- 本报告的定稿提交

## 7. 需要主会话定的事

1. `STALE_AWAIT_MS` 取 15 s 是否合适（三级数字）。
2. `mechanism/rendering.md` 是否按第 5 节补这一条。
3. 第 3 节的两处原有闪烁（暂停时旧层与沙漏交替、播放中快照与占位交替）要不要另立任务。
4. 卡片源码变化是否也要纳入判据（需要动 `card-sync` 一路）。
5. 合并与否。

## 8. 追加：c10-browser-probe 用户卡回归的排查（主会话 2026-09-29 派，按交接要求停在这里）

背景：主会话在 `claude/r2-merge`（`2e4b9d48`，stale-layer 与 push-scope 合在一起）上跑 `c10-browser-probe.mjs --user-card --only-a4 --no-video` 挂了。成员页一直没贴上桌面节点渲的用户卡层（`got: null`，最后是图标加徽标，在线来源里没有这一层）；0.7.2 上同一探针是过的。怀疑是输入签名两边对不上。

### 在本分支上的结果：不挂

- 命令：`node scripts/probes/c10-browser-probe.mjs --user-card --only-a4 --no-video --base-port 5750 --dist out/dist-online`
  - 在线构建出自本分支；
  - 另开环境变量 `PC_SIG_DUMP`，配合临时调试补丁（没提交），节点和页面两边都把 `clipInputs` 与签名写到同一个文件。
- 结果：退出码 0，`ok: true, fails: []`。用户卡在 `tU` 之后 521.8 s 贴上，这一层出自创建者的桌面节点（指纹 `258acaaa7c5fe509`，ready 91 帧）。
- 签名对照：节点写层表时给用户卡算的签名 20 次都是 `i1-7d741a8c3803f58e`，成员页按自己 store 里的项目算出的也是 `i1-7d741a8c3803f58e`。页面在线来源的 `stale` 为空，用户卡那一层在可用层里。

### 在 r2-merge 上：复现没跑完

- 做法：本 worktree 临时切到 `2e4b9d48`（detached），带同样的调试补丁，外加 `putLayerMap` 的范围判定记录，构建 `out/dist-online-r2` 后跑同一探针。
- 跑到一半接到交接指令，停掉了，没有最终结果。
- 停之前已看到的：
  - 节点给用户卡写的签名仍是 `i1-7d741a8c3803f58e`，成员页算的相同，`stale` 为空；
  - 成员页在线来源的可用层里**有**用户卡（`c-mummy8vh-1h`）；
  - `putLayerMap` 的范围判定一次都没触发。这条路径是环境变量 `PROMPTCUT_SHARED_CONFIG` 的老路径，配置里没写 `contentId`，所以 `scope` 为 null、不限范围，层表照常写。
- 停之前工作区已恢复到 `claude/stale-layer`，调试补丁丢弃。停掉的自己起的进程有：探针，以及它起的创建者 vite（5755）、render-worker、舞台 vite，都结束了。5750～5759 没有残留监听。

### 结论与怀疑点

- **不是签名两边对不上**：本分支与 r2-merge 上两边算出的签名都相同，页面也没把这一层判成过期。
- 签名的输入只取项目数据里的片段字段。节点侧的加工不改签名：`renderProject` 改写素材地址、管线 `entry()` 给素材加 `_frameSourceStamp`、`structuredClone`。已补单测 SIG-7 覆盖这一点。
- 主会话看到的「在线来源里没有这一层」，在 r2-merge 上这一轮至少到停下时不成立（层在）。更可能是没有**可贴的字节或清单**。本分支上端到端要 520 s 左右，接近探针 1200 s 时限的一半，机器有负载时容易超时。另一种可能：push-scope 那支对推送、补推的改动让用户卡的段迟推或被扣住。它的 `accepts(unit)` 对共享档快照要找「绑定项目里有一版 entry 的 cardPlan 用到这个快照键」；老路径没写 `contentId` 时不限，这一层不会被扣。但自动渲染节点路径（`auto.contentId` 还没交来时先扣着）在别的探针里有可能被扣。这些都没验证。
- 主会话看到的 `online: null`，读的是 `onlineDiag(member).layers`，它只列可用层，过期的层也不在里面。下一轮复现时请同时看 `__pcOnlineSnapshots().stale` 与 `skipped`，就能分清：是过期（签名问题）、这一档不认（`skipped`），还是层表里本来就没有。

### 已改

- `src/render/layerInputSig.test.mjs` 新增 SIG-7（节点侧对项目的加工不改签名），7/7 通过。签名算法本身没改（没找到两边不一致的输入）。

### 没验

- r2-merge 上这个探针的完整结果（中途停了）。
- 改完单测之后的 `npx tsc -b --force`、`npm test` 没重跑。只加了一个单测，没动运行代码。上一轮在本分支跑过：tsc 0 错误，npm test 3864/3867，唯一的失败单独重跑通过。
- 没动渲染代码，G0-R 没重跑。

### 下一步建议

1. 在 r2-merge 上重跑 `c10-browser-probe --user-card --only-a4 --no-video`。失败时取下面几样判断卡在哪一段：
   - 成员页 `__pcOnlineSnapshots()` 的 `layers`、`stale`、`skipped`，以及用户卡那层的 `ready`；
   - 创建者 `GET /api/frames/queue`（或推送队列 `stats()`）里的 `outOfScope`、`deferred`、`layerMapsOutOfScope`。
2. 调试补丁的做法（没入库，照做即可）：
   - `layerMapOf` 里在 `clipInputSig` 之后，把 `{ clipId, sig, inputs: clipInputs(project, clipId) }` 追加写到 `process.env.PC_SIG_DUMP`；
   - 探针等用户卡的循环里，把成员页 `window.__pcStore.getState().project` 的同一份东西也写进去；
   - 两边逐字段比。
3. 如果确是 push-scope 扣住了段（自动节点路径 `contentId` 迟到），按 push-scope 报告里 `rescope()` 的时机去查，不是本分支的范围。

## 主会话审查（2026-09-30，笔记本主会话）

- 第 8 节的回归：空闲笔记本上 r2-merge（合了本分支 `ff4a2ce4`，`05212eed`）三遍都过，用户卡那一步 712.0 / 606.7 / 551.5 s，签名 `i1-7d741a8c3803f58e` 两边一致。时间全在创建者节点逐段渲成员计划的 10 段上（每段 44～121 s）；PC 那次是机器同时跑着几支探针、超过 1200 s 时限，不是签名问题。uc-latency 合入后同一步约 110 s。
- `online-stale-layer-probe --dist` 在 r2-merge 与最终合流上都过（改后 8～11 ms 撤旧层）。
- 第 7 节要定的：`STALE_AWAIT_MS` 15 s 照留（〔裁〕，待用户审）；`mechanism/rendering.md` 已随 r2-merge 补（`2e4b9d48`）；两处原有闪烁与「卡片源码变化纳入判据」记进 `REPORT-post-M8.md` 第 2 轮遗留。
- 合入 main `fe62c17f`。
