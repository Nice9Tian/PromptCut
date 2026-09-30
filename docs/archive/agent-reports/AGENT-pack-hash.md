# AGENT 报告：pack-hash（打包保存与放云端补入库）

分支 `claude/pack-hash`，worktree `.worktrees/pack-hash`，起点 main `6cb029a7`。任务书：`docs/plan/TODO.md`「已做步骤的遗留」第一条（用户真机缺陷：「打包保存…」把没有哈希的素材悄悄跳过，老项目里的配音没进 `.procp`）。

## 需要主会话先看的一处（超出任务书写明范围的修复，三级〔裁〕）

往返探针在第二个实例上导出时暴露了一个**任务书没写到的同链缺陷**：包里的 `project.proc` 带着打包那台机器上的 `path`，而导出那一侧（`server/vite-plugin-export.ts` 第 177 行）见到 `path` 就把素材地址改写成 `/api/media/file?path=…`、不看有没有哈希，于是在另一台机器上打开包、导出，视频解码失败（`Video decode failed: /api/media/file?path=<A 机器的路径>`），配音同理会是静音。这意味着**修了打包之后，用户真机验收第 4 条（另一台机器打开、导出有声）照样过不了**。

我没有改导出代码（那会碰导出取素材的路径，要跑全套 G0-R，而且另一个子 Agent 正在改导出取帧），而是在打开包时处理：`loadProcpFile` 对**包里带着字节的素材**去掉 `path`（`dropPackedPaths`），这些素材只认 `/@media/<hash>`。老版本打的包也一并受益（用户那个包里的视频也带着 `C:\Users\admin\...` 的 path）。见〔裁 1〕。

同类问题在「在另一台机器上打开带哈希、带 path 的 `.proc`」时仍然存在（不经包），建议另开一项修导出那一侧（见「需要主会话决定的事」）。

## 状态

完成，等主会话审查。基线全绿：`npx tsc -b --force` 0 错误；`npm test` 4177 项、通过 4175、失败 0、跳过 2；代码指纹不变；往返探针退出码 0、`fails: []`。

## 提交

| 提交 | 内容 |
|---|---|
| `7de39cbf` | 文档：建本报告 |
| `1f871d42` | 修复：统一补入库 `ingestUnhashedMedia`，三处调用；打包与放云端补不上的列给用户；`mediaEntries` / `existingMediaItems` 守门；单测 |
| `bdad6df4` | 探针：`procp-roundtrip-probe.mjs`；修复：打开包时去掉打包方机器的 `path`；提示文案；打包菜单项加 `data-pc="menu-pack"` |
| `3f847f29` | 测试：打开项目后后台补入库、补不上的后台不反复试 |

## 做了什么

改动文件：`src/editor/io/mediaUpload.ts`、`src/editor/io/procp.ts`、`src/editor/media/assetTiers.ts`、`src/editor/sync/collab.ts`、`src/editor/TopBar.tsx`，测试 `src/editor/io/procp.test.mjs`、`src/editor/media/enqueueExisting.test.mjs`、`src/editor/io/tierBackfill.test.mjs`，新探针 `scripts/probes/procp-roundtrip-probe.mjs`。没有碰 `mediaSource.ts`、`frameMedia.ts`、`Preview.tsx`、`stageHandshake.ts`。

1. **统一的补入库**（`mediaUpload.ts` 的 `ingestUnhashedMedia`）：素材表里没有合法哈希、不在导入中的条目，按来源分组（同一文件只补一次，打包与后台同时触发也只补一次）：
   - 先 `adoptServerMedia`：候选路径依次是地址里 `path=` 的那条、素材的 `path`（服务端只收素材目录内的，就地算哈希、硬链接进内容库）；
   - 服务端不收（不在素材目录内、换了机器路径对不上、文件名解码不一致）时，经现有读接口取字节：素材原地址（`/api/media/file?path=…` 或 `/@media/<文件名>`）、按每条路径拼的 `/api/media/file?path=…`、按文件名拼的 `/@media/<文件名>`，取到就走 `uploadMediaFile`（`/api/media/upload/<名字>?tiers=1`）入库；回退页面（`text/html`）不算素材；
   - 结果用 `applyUploadedMedia` 写回（`actions.updateMedia`，换新对象，单测断言旧对象没被改）；
   - 回 `{ ingested, failed }`；在线构建与只读页面直接回空。
2. **三处调用**：
   - ① 打包前：`packProcp()` 先 `await ingestUnhashedMedia()` 再 `serializeProc()`，包内 `project.proc` 因此带哈希；
   - ② 放云端：`collab.ts` 的 `queueExistingMedia()` 先补入库，再 `enqueueExistingMedia`；
   - ③ 打开项目后：`startTierBackfill` 同一时机（1.5 s 后）`ingestUnhashedMedia({ background: true })`，再 `backfillSmallTiers()`。不用改 `Preview.tsx`（它已经在调 `startTierBackfill`）。
3. **不许再静默**：
   - `mediaEntries()` 回 `{ entries, unhashed }`；`packProcpFrom` 回 `{ blob, missing }`，`missing` = 没哈希的 + 有哈希但内容库里取不到的（每条引用它的记录都列）。顶栏「打包保存…」写完包后，`missing` 不空就 `alert(packMissingMessage(missing))`（和这个功能已有的提示同一种方式），列出名字（去重、最多 12 条，其余写「另有 N 条」）；
   - `existingMediaItems()` 回 `{ items, skipped }`，`enqueueExistingMedia` 结果带 `skipped`；放云端时把 `skipped`（不含还在导入的）和队列回的 `missing`（按哈希换回名字）用同步气泡（`pushToast`，警告色，不自动消失）列给用户。
4. **打开包时去掉打包方机器的 `path`**（〔裁 1〕）：`unpackProcp` 多回 `landed`（这个包带来、现在在本地内容库里的哈希），`loadProcpFile` 用 `dropPackedPaths` 去掉这些素材的 `path`。

## 〔裁〕

以下都是三级（机制，用户看不出区别或只是提示细节），语义没写到、按任务书精神定的；用户合入前可推翻。

- **〔裁 1〕打开 `.procp` 时，包里带着字节的素材去掉 `path`。** 试过的路：不改的话导出在另一台机器上必失败（探针第二次运行实测）；改导出那一侧要跑全套 G0-R 且与另一子 Agent 的导出改动撞车；在装包时去掉 `path` 救不了老版本打的包。所以放在打开包这一步。建议写进 `mechanism/` 的项目文件或素材服务那一本：「打开打包件时，随包带来字节的素材以哈希为准，不保留打包方机器上的绝对路径」。
- **〔裁 2〕后台补入库补不上的，同一页面会话里后台不再试**；打包与放云端每次都再试一次。避免补入库写回素材表触发下一轮检查时，对真的不在的文件反复发请求。
- **〔裁 3〕派生的「只要声音」素材**（`soundOf`，和源视频同一个文件）：源视频有哈希就直接用它的哈希，不挂视频的两档；地址本身就是 `/@media/<64 位哈希>` 却没有 `hash` 字段的，直接从地址取哈希。
- **〔裁 4〕还在导入的素材（`pending`）不补**（入库由导入那一路负责）；打包时它们没有哈希，照样列进缺失清单；放云端的气泡不列它们（入库后由导入那一路上传）。
- **〔裁 5〕提示方式**：打包用 `alert`（顶栏打包这条路上已有的提示方式）；放云端用同步气泡（开启是异步的，那时设置对话框可能已关）。
- 打包菜单项加了 `data-pc="menu-pack"`（给探针点，不影响界面）。

## 验证

跑测试和探针前都设了任务书给的 ffmpeg `PATH`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，0 错误（最后一次在 `3f847f29` 上） |
| 全量测试 | `npm test` | 退出码 0；tests 4177、pass 4175、fail 0、skipped 2、cancelled 0（跑 1 遍，在 `3f847f29` 上） |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与基线一致 |
| 本任务单测 | `node --test src/editor/io/procp.test.mjs` | 11 过 0 败 |
| | `node --test src/editor/media/enqueueExisting.test.mjs` | 4 过 0 败（EQE-1～EQE-4，EQE-4 新增） |
| | `node --test src/editor/io/tierBackfill.test.mjs src/editor/io/mediaSharedSync.test.mjs` | 全过 |
| 往返探针 | `node scripts/probes/procp-roundtrip-probe.mjs --port-a 6050 --port-b 6060 --out <临时> --keep --user-procp <用户包副本>` | 退出码 0、`ok: true`、`fails: []`（最终一遍在 `bdad6df4`+ 上） |
| G0-R | 没跑 | 没改导出与取帧代码（`server/`、`src/render/` 一行没动，指纹不变）；〔裁 1〕只改打开包时喂给项目的数据，G0-R 的基线项目不经打包件 |

验收逐条：

1. **单测（`procp.test.mjs`）**：「补入库后装包」一条——项目含带哈希的视频、只有 `path` 的音频（反斜杠路径）、地址为 `/api/media/file?path=…` 的音频（文件名带中文）→ 补入库 `failed: []`、两条补上哈希、旧对象没被原地改 → 装包 `missing: []`，包里三份素材字节，包内 `project.proc` 三条都带哈希 → 拆到空库 `stored: 3`，`restoreMediaUrls(...).missing` 为 `[]`。「文件真的不在了」一条——文件不存在的配音和一条「(缺失)」图片 → 补入库 `failed` 与装包 `missing` 都列出这两条，提示文案含「2 条素材」和两条名字（「(缺失)」前缀不重复显示）。另有：换机器路径对不上时经 `/@media/<文件名>` 兜底入库；派生声音跟源视频哈希、`pending` 不动；有哈希但内容库里没有的每条引用都列；`dropPackedPaths`；`landed`。
2. **守门**：`mediaEntries()` 单测断言没哈希、哈希不合法的条目出现在 `unhashed`；`existingMediaItems()` 的 EQE-4 断言出现在 `skipped`（还在导入的标 `pending`），入队结果也带着它们。
3. **往返探针**（最终一遍的关键数）：
   - A：存盘里老配音只有 `path`、没有哈希；再打开后地址是 `/api/media/file?path=…`；打包前那一刻老配音哈希为 `null`（所以是打包这一步的补入库补上的，后台那一轮还没赶上）；从顶栏打包，包里 `project.proc` + 3 份素材，包内三条都带哈希，没有弹缺素材提示；
   - B（开跑前数据目录与导出目录为空）：打开包，三条素材都按哈希还原、没有「(缺失)」，三条 `/@media/<hash>` 都是 200；导出 3 s 成片有 AAC 音轨，老配音那段（0.2～1.3 s）`rmsDb -24.5`、`440 Hz`，新配音那段（1.7～2.8 s）`rmsDb -24.6`、`880 Hz`——两条配音都在、各在各的位置；
   - 探针跑了 4 遍：第 1 遍暴露导出读另一台机器 `path` 的缺陷（→〔裁 1〕），第 2 遍主体全过、用户老包那一段因为把 177 MB 的包经 `evaluate` 传进页面把浏览器撑崩（探针自身的问题，改成页面按文件名从 B 的临时素材目录取），第 3、4 遍全过。没有看图（这一项不动画面）。
4. **真机验收**：用户做，未做。
5. **G0**：tsc、全量测试见上；G0-R 没跑，理由见上表。

## 用用户的老包核对的结果

用户包（只读，复制到 `scratchpad/pack-hash/userpack/` 后再复制进探针 B 的临时素材目录）：9 条素材，1 条视频带哈希，8 条配音只有 `path`（`C:\Users\admin\Videos\PromptCut\media\voice-…mp3`）、地址 `/api/media/file?path=…`、没有哈希；包里只有那条视频——正是这个缺陷的现场。新代码在空库实例里：

- 照常打开，页面没有报错，素材表 9 条；
- 从顶栏再打包：包里是 `project.proc` + 那条视频（177 MB），弹一次提示框，列出 8 条配音的名字：「包已保存，但下面 8 条素材本机找不到文件，没有装进包里（换台机器打开这个包，这些素材放不出来）：· voice-20260929-061646-决赛回放开场-c41a.mp3 …（共 8 条）」。

与任务书的一处出入：任务书说「缺的素材照常标缺失」。现有代码里这 8 条**不会**被标「(缺失)」：它们有 `path`，`restoreMediaUrls` 第二支给它们拼了 `/api/media/file?path=…`，只是在这台机器上取不到（403）。这是改动前就有的行为，本任务没动；如果希望在素材表里标出来，另开一项（见下）。

## 没做成的 / 没覆盖的

- 「放云端」那一处（`collab.ts` 的 `queueExistingMedia`）没有端到端验证：需要托管端与 rw 票据，探针没搭。覆盖到的是它用到的 `ingestUnhashedMedia`、`existingMediaItems`、`enqueueExistingMedia` 的单测；气泡文案函数 `uploadMissingMessage` 没有单测。
- 放云端之后才被后台补入库补上哈希的素材，会不会自动进上传队列，我没有核实（放云端时的那次补入库是在入队之前 `await` 的，这条路是对的；后台那条是另一时机）。

## 发版通知要写的那句

老项目里以前生成的配音，从这一版起打包和放云端时会一并带上。（建议补半句：本机已经找不到文件的素材，打包和放云端时会列出名字提醒。）

## 需要主会话决定的事

1. 合并 `claude/pack-hash`，还是返工。
2. 〔裁 1〕～〔裁 5〕是否认可；〔裁 1〕要不要写进 `mechanism/` 的哪一本。
3. 是否另开一项修导出那一侧：`server/vite-plugin-export.ts` 第 177 行对带哈希的素材也按 `path` 改写地址，与 `server/render-project.mjs`「有哈希就只认 `/@media/<hash>`」的规矩不一致；不经打包件、在另一台机器上打开带 path 的 `.proc` 或共享项目导出时仍会读错文件。碰导出取素材的路径，要跑全套 G0-R。
4. 是否另开一项：打开项目时，只有 `path`、而本机取不到那个文件的素材，在素材表里标「(缺失)」（现在是不标、静默放不出来）。

## 主会话审查（2026-09-30，笔记本主会话）

- 用户真机缺陷之一（随 0.7.9）。审过 `ingestUnhashedMedia`（先走 adopt，服务端不收再取字节入库，结果换新对象写回）、三处调用、`mediaEntries()` 与 `existingMediaItems()` 把跳过的条目放进返回值并提示用户。〔裁〕1～5 照留，待用户审；〔裁 1〕（打开包时带字节的素材去掉路径、只按哈希找）记在本报告，没另写进语义。
- 导出那一侧（`vite-plugin-export.ts` 约 177 行按路径读）、只有路径又取不到的素材不标缺失、放云端后才补上哈希的素材进不进上传队列，三条记进 TODO 的「跨机器打开项目时的素材路径」。
- 用用户发来的老包（只有视频、缺 8 条配音）核过：新代码打开照常、再打包时列出 8 条配音的名字。主会话在集成分支 `claude/r9-merge` 上重跑整套，`procp-roundtrip-probe` 见 `docs/reports/REPORT-post-M8.md` 第 9 轮。合入 main `b543b88e`。
