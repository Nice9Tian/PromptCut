# AGENT 报告：c66-media-sync

分支 `claude/c66-media-sync`（从 `claude/c66-t9` 的 `5adf498` 起）。任务：修 C6.6 T9（C6.6 两档素材阶段的跨机验收探针）暴露的缺陷「共享项目里，观察端永远拿不到新导入的视频」。

**状态：修复与单测完成，基线（类型检查、全量测试）全绿；T9 本机替身里观察端已拿到带两档哈希的素材记录，素材层能画出来；T9 仍没有整条通过（已知的 plan 问题，以及新暴露的「先小后大」不稳定，见第 4、5 节）。**

## 1. 复现

新单测 `src/editor/io/mediaSharedSync.test.mjs`：创建方页面的 store 接在 docsync（页面到文档服务的同步层）上，文档服务用内存假件 `MemDocService`，观察方是另一个 DocSync。三条：

1. 导入视频（`pending: true`）→ `applyUploadedMedia` 写回入库回包 → 文档服务与观察端都要有 `hash`、`url`、`ext`、`size`、`path`、`tiers.original`，`pending` 清掉；随后 `watchSmallTier` 拿到小版，`tiers.small` 也要到观察端。另查 store 里的旧对象、旧数组没被原地改。
2. 入库失败（回包为 null）时 `pending` 清掉也要到观察端。
3. 打开项目时补转小版（`backfillSmallTiers` 回 ready → `writeSmallTier`）也要到观察端。

修之前（提交 `722638c`）三条全失败：

- 第 1 条：`before.pending` 期望 `true` 实得 `undefined`（旧对象被原地改了）；
- 第 2 条：观察端 `pending` 期望 `undefined` 实得 `true` —— 正是 T9 看到的现象；
- 第 3 条：「不原地改旧对象」断言失败，旧对象的 `tiers` 已经带上了 `small`。

## 2. 根因

与 T9 报告第 4 节第 1 条的判断一致，已由单测证实：`src/editor/io/mediaUpload.ts` 的 `applyUploadedMedia`、`watchSmallTier`（小版后到时那段）、`writeSmallTier` 先原地改 `getState().project.media` 里那条记录，再调 `actions.setMediaPath` 拷一个只带新 `path` 的对象去 `setProject`。共享项目里 store 的项目就是 docsync 的本地副本，`DocSync.commit(next)` 算 `diffProject(local, next)` 时本地副本里的这条记录已经被改过，差异只剩 `path`（或者什么都没有），`hash`、`url`、`ext`、`size`、`tiers`、`pending` 都到不了文档服务。本机项目不走 docsync，不受影响。

## 3. 改了什么

- `src/store/actions/media.ts`：新增 `actions.updateMedia(mediaId, patch)`：拷一份新对象（patch 里值为 `undefined` 的键删掉）、新数组，`setProject(…, { undoable: false })`。和 `setMediaShots` 等同一条提交路径，不进撤销栈。
- `src/editor/io/mediaUpload.ts`：`applyUploadedMedia` 把要写的字段收进一个 patch，一次 `updateMedia`；`watchSmallTier` 拿到小版后改调 `writeSmallTier`；`writeSmallTier` 改用 `updateMedia(id, { tiers })`。三处都不再原地改。注释同步改写。

**别的原地改项目对象的写法**：在 `src/`（kernel、render 之外）按「`变量.字段 = …`」「对项目数组 `push/splice/sort/…`」「`Object.assign`」「`delete x.y`」「从 `getState().project` / `state.project` 取出的变量再写」几种形状查了一遍，另外找到的都不是 store 里的对象：

| 位置 | 为什么不算 |
|---|---|
| `src/editor/io/index.ts` 的 `exportProjectJson`、`exportVideo` 改 `m.url`、`p._note` | 改的是 `JSON.parse(JSON.stringify(project))` 的深拷贝 |
| `src/editor/io/index.ts` 导入旧格式时 `project.media = restored.media` | 新拼的对象，之后才 `loadProject` |
| `src/editor/io/pythonDrop.ts` | 改的是刚解析出来、还没进 store 的文件内容 |
| `src/store/actions/clips.ts:116` `clip.end = …` | `clip` 是刚拷出来的新对象 |
| `src/kernel/parts.ts` `updatePart`、`src/kernel/combine.ts` | 先 `cloneTree` / 深拷贝再改 |
| `src/editor/nodes/layout.ts`、`src/mcp/tools/autoWorkflow.ts` | 改的是本地新建的图节点 / 参数对象 |

所以需要改的只有 `mediaUpload.ts` 这三处。

## 4. 验证

- 新单测：`node --test src/editor/io/mediaSharedSync.test.mjs src/editor/io/mediaTiers.test.mjs` → tests 5，pass 5，fail 0（`mediaTiers` 是原有的两档写回单测，行为没变）。
- `npx tsc -b --force` → 退出码 0，零错误。
- `npm test` → 退出码 0；tests 3076，pass 3075，fail 0，skipped 1（跳过的是「集成:/api/cards/layout 对真实项目返回整数框」，要 5190）。
- T9 本机替身：见下。

### T9 本机替身

本机托管组合（文档服务 5679，素材服务端口给 0 由系统分配，实得 4984）与协调口（端口给 0，实得 7095）只绑 127.0.0.1，数据目录放 scratchpad 的临时目录、跑完已删。`--role all` 把三台编辑器的端口写死在 5590 / 5593 / 5596，不在我的端口段里，所以改成三个角色各起一个进程、同一个 `--run`：creator `--port 5670`、observer `--port 5673`、host `--port 5676`。我的段只有 10 个端口，三台编辑器各占 3 个之后只剩 5679，素材服务与协调口只能交给系统分配（都不在禁用的几段里）。

| 轮 | 结果 | 与本分支有关的 |
|---|---|---|
| ms1 | 三方都 `ok: false` | **观察端素材记录带上了两档**：`projectTiers: { original: a7cea7…, small: d83e0a… }`，进入后 153 ms 就看到视频片段（修之前 T9 连续 4 次卡在「看到视频片段」超时，素材一直 `pending: true, hash: null`）。截图 `ms1-observer-2-original.png` 里素材层已画出条纹视频。但素材层**不是先小后大**：`tierSequence` 是 788 ms 原尺寸（1920 宽）→ 803 ms 小尺寸（800 宽）→ 2479 ms 原尺寸，于是「先以小尺寸出现」「小尺寸停在 2.5 s」「换档前后帧号」「换到原尺寸后不退回」4 条失败。creator 两档上传先小后大通过（`firstCompleteMs` small 2053 / original 2162，`originalBeforeSmall: 0`，日志顺序 `tier-start small → tier-done small → tier-start original → tier-done original → item-done`）。收尾失败是已知的「重卡 plan 切不出任务」：`超时:[creator] 页面发布的 plan 切分完、细任务都落定`，host 随之中止。 |
| ms2 | 作废 | observer 与 host 两个探针进程刚起就 `Fatal process out of memory: Zone`（V8 崩溃；当时本机空闲内存约 12 GB，同时有别的会话在跑 T9，`%TEMP%` 里有它们的 `t9-timing7b/8b` 临时目录）。host 崩溃留下的 vite（5676～5678，本工作树、本轮起的）已由我结束。creator 等 `host.ready` 超时。 |
| ms3 | 三方都 `ok: false` | 观察端素材记录照样带两档（`original: daf2ba…, small: 642b4e…`），**这一轮先小后大**：`tierSequence` 2220 ms 小尺寸（800 宽）→ 2983 ms 原尺寸（1920 宽），`firstShown.tier = small`，换档期间 5 次采样无黑帧、帧号前后相同。失败的是：帧号读到 0 而不是 75（截图 `ms3-observer-1-small.png` 里播放头停在 0.00 s，探针 seek 到 2.5 s 没有留住）、「换档期间逐帧采样」样本不够。host 因 ms2 残留占着 5676 起不来（`端口 5676 被占用`，残留是在 ms3 开跑之后才发现并结束的），creator 等 `host.ready` 超时。 |

结论：本分支要修的「观察端永远拿不到新导入的视频」已修好——两轮有效运行里观察端都拿到了带 `hash`、`tiers.original`、`tiers.small` 的素材记录，素材层画出来了。「先小后大」两轮结果不一致（ms1 先原后小再原，ms3 先小后大）；以前的 T9 走不到这一步，这是新暴露的问题，不在本分支的修复范围里，见第 5 节。

## 5. 没做成的与需要主会话定的

1. **观察端先小后大不稳定（新暴露，未查根因）**。ms1 里观察端第一次解出画面用的是原尺寸，15 ms 后换成小尺寸，1.7 s 后又换回原尺寸。按 `chooseTier`（`src/render/mediaTier.ts`）的规则，还没问过素材服务时给小尺寸、两档都到齐而可播性未知时也给小尺寸，照理不会先出原尺寸。猜测（没验证）：一是探针按 `__pcPreviewDiag().frontId` 选舞台，读到了换前台那一刻的另一台舞台；二是有一条不经 `chooseTier`、直接用 `media.url`（原尺寸）的路（`mediaTier.ts` 注释说 FrameScene 的 placeholder 路用原片）在观察端刚进项目时成了可见舞台。要改渲染或探针，不在本分支清单里。
2. **观察端播放头没停在 2.5 s（ms3）**：探针看到视频片段后立即 `seek(2.5)`，截图里播放头是 0.00。可能是进入共享项目后又有一次状态覆盖把时间拨回 0。属于 T9 探针或进入共享项目的流程。
3. **本机同时跑多个 T9 时资源吃紧**：ms2 的两个探针进程 V8 内存崩溃。建议不要让两个分支同时跑 T9。
4. **scratchpad 目录混用**：T9 会话在同一个 scratchpad 的 `t9/` 下留过 `run1`～`run5`，我的三轮输出写进了 `t9/run1/`～`t9/run3/` 的子目录（`creator/`、`observer/`、`host/` 与 `creator.out` 等），和 T9 的顶层 `run1.out` 这类文件不同名，没有覆盖，但放在了一起。
5. 「重卡 plan 切不出任务」「主机代码版本」按任务书是别的分支在修，这一轮只记录：ms1 里 creator 超时在 plan 落定。

## 6. 对任务书或语义的更正建议

- 语义没有冲突：`product/asset-service.md` 与设计稿第 2 节都说项目里只记两档哈希，本分支没改这一点。
- 建议在 `src/store/README.md` 或约束里加一句「不许原地改 store 里的项目对象，共享项目的同步靠对象身份判变化」；这是规则性内容，按原则 5 应写进 `guide_files/`，由主会话定放哪。
- `c66-t9-probe.mjs --role all` 端口写死，建议加一个 `--base-port`，好让分到别的端口段的会话也能一条命令跑。
