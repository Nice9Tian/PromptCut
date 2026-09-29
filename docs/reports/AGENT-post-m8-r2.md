# AGENT 报告：post-m8-r2

分支 `claude/post-m8-r2`。任务：主会话把 `server/bakery/ffmpeg.mjs` 还原成 main（提交 `e24eafb8`）后，`server/test/storage-leftovers.test.mjs` 里测「`streamPngVideo().abort()` 删输出文件」的用例挂了，要处理掉，并确认没有别处依赖这个行为。

## 做了什么

- 删掉 `server/test/storage-leftovers.test.mjs` 里的用例「streamPngVideo().abort() 删掉写了一半的输出文件」和随之不用的 `import { streamPngVideo } from '../bakery/ffmpeg.mjs'`。只改了这一个测试文件。
- 没有改成测调用方的清理：
  - `MovFrameStore` 中止时自己删临时 MOV，已有用例「MovFrameStore.suspend 中止写入后临时 MOV 不在」覆盖（它的假写入器 `abort` 什么都不删）。
  - 轨道前缀预览（`FramePipeline.prerender`）用的是 `frameVideo` 而不是 `streamPngVideo`，要测它得搭一整套 FramePipeline 场景加 bakery，不起真渲染测不了，按任务书只删。
  - 导出分片 `parts/**` 在取消、失败后由 `pruneExportDir` 删，已有用例「取消、失败的导出……」覆盖。

## 搜过的依赖

`grep streamPngVideo` 覆盖 `server`、`src`、`scripts`、`tests`：
- 生产代码调用方：`server/bakery/export.mjs`（流式 `overlay.mov`）、`server/bakery/export-unified.mjs`（分片 `parts/…`）、`server/frame-mov.mjs`（`MovFrameStore`，中止时自己删）。都在 `server/bakery/` 或已自己删，没改。
- 其它测试里的 `streamPngVideo` 都是桩（抛错或拒绝），不依赖 abort 删文件。
- 没有别的测试依赖这个行为。

## 一处行为差异（供主会话判断，未改）

`docs/reports/AGENT-storage-leaks.md` 第 12 行与第 59 行第 4 条写的是「`streamPngVideo().abort()` 删输出文件，所以导出分片、流式透明层中止即删」。还原后：
- 分片 `parts/**` 仍由 `pruneExportDir` 删，结果不变；
- 单进程流式写的 `overlay.mov` 在渲染途中出错时，写了一半的文件会**留下**（`overlay.mov` 在 `EXPORT_KEEP` 里，`pruneExportDir` 不删）。要删只能放在调用方：`export.mjs` 在 `server/bakery/` 下不能动，`vite-plugin-export.ts` 分不清透明层是渲完了还是写了一半。这回到了 storage-leaks 之前的行为；若语义要求「失败时不留不完整的透明层」，需另开任务（例如先写 `overlay.tmp.mov`、完成后改名，但这仍要改 `export.mjs`，会变快照键，须与用户商定）。

## 验证

- `node --test server/test/storage-leftovers.test.mjs`：退出码 0，tests 11、pass 11、fail 0。
- `node -e "import('./server/frame-code.mjs').then(m=>console.log(m.snapshotCode(process.cwd()), m.captureCode(process.cwd())))"`：`00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与要求一致。
- 按任务书没跑 `npm test` 全量与 `npx tsc`。

## J9 / J10 与顺推

任务：`server/test/prerender-executor.test.mjs`（队列真实执行器的单测，J8～J11 是契约 `docs/plan/render-queue-contract.md` 里执行器的用例号）的 J9 和 J10 中止用例，在 uc-latency 的「一段一趟顺推」下挂了。顺推是指队列细任务一段 60 帧只调一次 `bakeFrames`，不再按 4 帧一批逐批调。要做的：逐批断言保留（关掉顺推照跑），另加顺推模式的 J9b、J10b，并查顺推下的中止语义有没有真问题。

### 挂的原因

- **J9**（共享档逐段渲整张卡，对照 `fillCardControls` 一次渲完）：断言的是执行器三段的 `bakeFrames` 调用记录与一次渲完的 38 批逐项相同。顺推下三段各调一次（targetFrames 0～59、60～119、120～149），记录只有 3 条。落盘文件其实相同，挂的只是调用记录。
- **J10 中止**：中止钩子写的是「第 2 次调 `bakeFrames` 时 abort」。顺推下一段只调一次，钩子永远触发不到，render 正常渲完，所以挂在「中止后 render 拒绝」（`actual: null`）。这是用例的触发方式依赖逐批，**不是中止语义变了**。
- 另外，旧的假 `bakeFrames` 先对全部 targetFrames 调 `onFrame`，再对全部 snapshotFrames 调 `onSnapshot`，而且不看 `signal`。真 `bakeFrames`（`server/bakery/bake.mjs`）是逐帧走：每帧开头看 `signal`，已中止就抛 `{ cancelled: true }`；每帧先生成快照再截图。顺推「每 4 帧入库一次」靠的正是这个顺序，旧的假实现测不到它，也没法在一趟里中途中止。

### 改了什么（只改了测试文件）

- 假 `bakeFrames` 改成真实现的顺序：逐帧，每帧开头看 `signal`；要快照的帧先 `onSnapshot` 再 `onFrame`。新加 `onBakeFrame(rec, frame, phase)` 钩子，每帧开头（`'start'`）和快照后、截图前（`'shot'`）各调一次。改完后原有各用例仍通过。
- **J9、J10 中止**：原断言一字不改，只在执行器用的管线上设 `B.queueSinglePassOff = true`，名字里注明「逐批：关掉一段一趟顺推」。
- **J9b**（顺推，缺省开着；开头先断言三段的 `queueSinglePass` 都判为 true）：
  - 每段只调一次 `bakeFrames`；targetFrames、snapshotFrames 都是整段；out 和三个开关与逐批相同；两者的并集与逐批的 38 批相同；
  - 快照目录（150 帧加 `index.json`）与 PNG 目录（真 `CardFrameCache.put` 落在 `controls/<key>/mov/frames/`，只把要 ffmpeg 的 `finish` 换成桩）都与 `fillCardControls` 一次渲完逐字节相同；
  - 监听 `commitSnapshots`：每次入库不超过 4 帧，从 4 帧边界起、连续，合起来是 0～149；
  - 进度按 4、8、…、n 报（最后一段是 4、8、…、28、30）。
- **J10b**（顺推）：
  - 第 15 帧的快照生成之后、截图之前 abort。这是最苛刻的点：12～15 这一组快照都生成了，本该在第 15 帧截完图时入库，而中止正好落在入库之前。
  - 断言 render 按取消拒绝（`err.cancelled === true`，不是 plan-mismatch），只调了一次 `bakeFrames`；
  - 快照只有 0～11，`index.json` 的 `frames` 是 `[[0,11]]`、`count` 12；入库恰好 3 次，每次一组 4 帧；进度只报到 `[4, 8, 12]`；
  - PNG 只有 0～14，已写的每张与一次渲完逐字节相同，没有写到一半的文件；
  - 用新信号重渲这一段：仍是一趟，targetFrames 0～59（PNG 那一支照旧要整段），snapshotFrames 只补缺的 12～59，进度按 4 帧报；
  - 再渲另外两段后，整张卡的快照与 PNG 与一次渲完逐字节相同。
  - 变异检查：临时去掉 `fillCardControls` 里 `commitProduced` 对 `signal?.aborted` 的判断，J10b 就挂（12～15 会在中止后入库）；还原后通过。中止点放在第 13 帧（一组的中间）时，这个判断去掉也测不出来，因为真 `bakeFrames` 下一帧开头就抛了，所以最后把中止点定在一组的最后一帧。

### 中止语义有没有问题

没有问题，`server/frame-pipeline.mjs` 没改。顺推下：
- 中止后不再生成快照、不再入库：`onSnapshot` 与 `commitProduced` 都先看 `signal`；
- 不再写 PNG：`cardCache.put` 带了 `() => !signal?.aborted` 守卫；
- `bakeFrames` 在下一帧开头抛取消；即便中止落在一段的最后一帧、`bakeFrames` 正常返回，`renderCardSnapshotRange` 在 `runQueueTask` 之后也会判 `signal` 抛取消，所以 render 一定拒绝；
- 入库只在一组 4 帧截完时做，所以 `index.json` 里的区间只到某个 4 帧边界（一段的末尾除外，末尾那组本来就不满 4 帧）。

有一处和逐批不同，但不算错：逐批中止在批与批之间，顺推中止在帧与帧之间。所以顺推中止后，PNG 可能比快照多出不满一组的几帧（J10b 里 PNG 到 14、快照到 11）。每张 PNG 都是整帧原子写入的，重渲时同签名的帧不重写，对结果没有影响。

### 验证

- `node --experimental-test-module-mocks --test server/test/prerender-executor.test.mjs server/test/queue-single-pass.test.mjs server/test/queue-single-pass-fill.test.mjs server/test/frame-video.test.mjs`：退出码 0，tests 19、pass 19、fail 0。其中 `prerender-executor.test.mjs` 占 10 条（J8 两条、J9、J9b、J10 四条、J10b、J11）。
- 没改 `server/frame-pipeline.mjs`，所以没跑 `npx tsc -b --force`。按任务书没跑 `npm test` 全量。
- `node -e "import('./server/frame-code.mjs').then(m=>console.log(m.snapshotCode(process.cwd()), m.captureCode(process.cwd())))"`：`00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`，与要求一致。
