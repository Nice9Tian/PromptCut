# AGENT 报告：c66-media-sync

分支 `claude/c66-media-sync`（从 `claude/c66-t9` 的 `5adf498` 起）。任务：修 C6.6 T9（C6.6 两档素材阶段的跨机验收探针）暴露的缺陷「共享项目里，观察端永远拿不到新导入的视频」。

**状态：修复与单测完成，基线（类型检查、全量测试）全绿；T9 本机替身的结果见第 4 节。**

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

（T9 结果待补）
