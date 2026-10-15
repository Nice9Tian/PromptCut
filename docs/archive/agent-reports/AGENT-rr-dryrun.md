# 报告：「每张卡的 HTML 快照作废」的修改前 / 修改后文档

分支 `claude/rr-dryrun`，工作区 `.worktrees/rr-dryrun`，基于 `main`（`fc226478`）。只新增两个文件：`docs/plan/html-snapshot-removal-dryrun.md` 和本报告。没有改语义文档、契约、任务书和代码；没有起任何进程，没有跑测试（派活指令：没改代码，不用跑）。

交付的文档下文叫「那份文档」。它最前面是要用户确认的表（16 条），之后依次是结论、逐处修改前后、四处的方案、机制、间隔从 3 改到 15 的影响、返工与取消、〔裁〕重判、三条决定的执行计划、查清与没查清的。〔裁〕指会话定下、等用户审的裁定，编号是 `render-refactor-progress.md`「〔裁〕清单」的行号。

## 读了什么

- 规矩：`developer_guide.md` 索引的六份里和写文档有关的四份（`suggested_agent_behavior.md`、`constraints.md`、`multi_agent.md`、`solution_table.md`），通用规矩，用户 2026-10-13 的决定原文。
- 计划：`render-refactor-task.md` 全文；`prerender-products-contract.md` 全文；`render-standard.md` 全文；`render-refactor-progress.md`（含 `main` 上之后加的「用户 2026-10-13 的决定」一节）。
- 语义：`glossary.md`、`product/rendering.md`、`mechanism/rendering.md`、`product/platforms.md`、`product/cards.md`、`mechanism/cards.md`、`product/asset-service.md` 全文。`mechanism/platforms.md`、`mechanism/asset-service.md` 等只按「快照」「小尺寸」搜了一遍，读了命中的行。
- 代码（读，没有跑）：`server/frame-stream.mjs` 的计划、生产者、稀疏与满密度、队列任务、拉取；`server/bakery/bake.mjs` 的 `bakeStream`；`server/frame-pipeline.mjs` 的 `streamBusy`、`preload` 的先后、`fillCardControls` 开头一段；`server/frame-playback.mjs` 的 `planStreamSegments`；`server/snapshot-tier.mjs`；`server/asset-store/stream-store.mjs` 的就绪区间；`src/render/streamPlayer.ts`；`src/editor/snapshotFeed.ts`；`src/editor/probeRunner.ts`；`src/editor/Preview.tsx` 里低内存档、在线来源、浏览器节点几段；`src/render/snapshotSource.ts` 里流和档位的几处；`src/online/lowMemory.ts`；`src/editor/browserNodeHost.ts` 的 `bakeStream`；`server/bakery/small-bitmap.mjs`、`src/render/bakeSmall.ts` 的文件头；`src/export/onlineExport.ts`、`originals.ts`；`src/render/snapshotGrid.mjs`；`src/kernel/frameMode.mjs`；`src/cards/capabilities.md` 第 3 节；`src/render/audioCardSourceVersion.test.mjs`；`server/remotion-style-check.mjs` 的文件头和认「引用了框架」的那几行；`src/online/cardRuntime/remotionLock.mjs` 的文件头；`src/kernel/remotionStyle/easing.ts`、`spring.ts`；`server/card-authoring-guide.md` 第 4.3 节。
- 分支：`claude/rr-sparse-a`、`rr-sparse-b`、`rr-sparse-c`、`rr-push-exact`、`rr-hosted-streams`、`rr-lottie`、`scrub-streams` 的提交说明和改动的文件清单；稀疏一、`scrub-streams` 两份报告全文，推帧一致性报告的前两节，乙的报告里讲缺口的几段。稀疏二、三的报告是空的，只看了提交说明，没有读它们的代码差异。

## 哪些是查代码得出的

列在那份文档第 9 节「查代码得出的」。最要紧的六条（任务书和用户的决定里都没有提到）：

1. 在线浏览器导出逐帧取每张重卡的 HTML 快照；同步来的用户卡、素材效果卡导出时一律要它。
2. 源依赖卡和框用了三维的卡不进流，判重时只有快照。
3. 低内存档（手机、平板现在走的档）不消费轨道流，只贴从快照缩出来的小尺寸。
4. 连着文档服务时没有稀疏版：队列的流任务和浏览器节点只产满密度。
5. 取帧式从分段第一帧起算，间隔改成 15 以后片段开头会有最多 14 帧截在片段开始之前。
6. 预渲染进程靠快照缺口上报的音讯判断「在播」。

另外核对了一件用户说法里的数：「全部内置卡换键」实际是 101 张里的 42 张（丁的实测，`capabilities.md` 第 3 节）。

## 哪些是我的判断

列在那份文档第 9 节「我的判断」。主要是：四处方案各自的推荐和里面的建议值；桌面上测量和产流不宜同时跑；第 5 件事里「截到的是空画面」（取帧式是查到的，画面没有跑探针看）；庚没有该留的部分；位置矩形可以取消；「要撤掉的东西」那张单子是按读到的入口列的。稀疏版要多久、遮罩的上限、解码器轮转一圈能带几层，都没有量。

## 没查清的

那份文档第 9 节末尾列了 12 条。动手前一定要先核的是第 2 条：云端 Agent 看画面读不读每张卡的快照。其余：托管方的渲染节点缺省开还是关；卡片级指纹锁对轨道流怎么实现；在线页面重卡贴流时分派用的每拍固定成本；手机上解轨道流行不行；流这边有没有「后进来的页面认不出候选」的缺口；三份机制文档没有通读；哪些建卡夹具真的经过建卡检查；在线转译认不认裸导入、声音线程里接不接锁；Remotion 的 `Easing.ease` 的确切曲线；占位符取框的顺序没有另读代码；旧整帧通道的 PNG 现在搭在快照清单里送，清单没有了以后怎么送。

## 对任务书或语义的更正建议

都写成了那份文档第 2 节的「修改前 / 修改后」，等用户确认后由主会话改。两处不在点名范围里、顺带查到的：

- `render-standard.md`「预渲染的产物」那张表的最后一行和「另外四条」的第 2、4 条要跟着作废（那份文档 2.8 节末尾）。
- 契约第 3、4.1、6.4、9.3、11、12、13、16 节也受牵连，不只第 1、2、7 节（那份文档 2.7 节末尾）。

## 没做成的

- 没有播报。用户的决定里「写完用 task-announce 播报」是给主会话的；子 Agent 播报会弹出指向错误会话的信息栏，所以留给主会话。
- 没有跑任何探针去坐实判断里的几条（派活指令只要文档）。

## 提交

| 提交 | 内容 |
|---|---|
| `b736b86b` | 建报告文件 |
| `49fb2f56` | 文档前半：要确认的表、结论、逐处修改前后 |
| 本次 | 文档后半：四处的方案、机制、间隔、返工与取消、〔裁〕重判、执行计划、查清与没查清的；报告 |
