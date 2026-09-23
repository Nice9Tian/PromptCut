# T5a 报告：D3 `see_frames` 回包附实体矩形

分支 `claude/d3-entity-rects`（自 main `787f7d9`），端口段 5260～5269（实际只用了 5260/5261/5262，预渲染子进程随机端口）。

## 做了什么

按 `docs/archive/restructure_planning/r2-r7-task.md` 目标 D 的 D3「第 8 步」实现：预渲染进程给 Agent 渲 `see_frames` 图时附实体矩形。

1. **`server/frame-pipeline.mjs`（只动 layout 一带）**
   - 新增 `measureEntityRects(page)`：放在 `layoutClips` 下面，是给 `captureSnapshot` 的 `afterFonts` 钩子用的页面函数。根传 `#pc-frame-snapshot [data-pc-scene]`，调 `window.__pcSolid.rectsWithBounds(root, { pixels: 'all' })`，回 `Array<{ clipId, box: [x, y, w, h], solid: [x, y, w, h] | null }>`（舞台像素、取整）。
   - `solid: null` 的判定：`bounds()` 在量不到实体时退回包裹层外框（给选中描边兜底），和「实体正好铺满包裹层」区分不开，所以页面函数按 `bounds()` 同一条走法（平面算实体、`isSolid` 元素不再往下、组流平面跳过、快照里的 `<img>` 按 `data-pc-painted-box` 那块算）先问「舞台内有没有实体」，没有就给 `null`；有就用 `bounds` 的值。页面没挂 `__pcSolid` 时回 `null`（不是空数组）。
   - 新增 `entityRects(project, times, { signal })` / `entityRectsNow`，紧挨 `layout` / `layoutNow`：走 agent 车道同一条链；只看 `entry.html`（像素命中答不了实体框，同 `layoutNow`），缺的帧一次 `bakeFrames({ snapshotOnly: true })` 补齐并 `record`；每帧注一次快照、`screenshot: false`、钩子就是 `measureEntityRects`。回 `Map<帧号, 矩形数组 | null>`。
   - `layout` / `layoutNow` 本身没改。
2. **`server/vision/render.ts`（`see_frames` 回包的出口）**
   - `FrameResult` 加 `rects?: EntityRect[] | null`；导出 `EntityRect` 类型。
   - `RenderOpts` 加 `rects?: boolean`，缺省看 `post.shrink`：缩图 = 给模型看的那张（全仓只有 `/api/vision/snapshot` 即 `see_frames` 传 `shrink: true`），预渲染贴图（`bake.ts`）、动图（`ensureGif`）不付这一趟。`runner` 旁路不量。
   - `renderFrames` 在 FramePipeline 那条路上渲完后调 `service.entityRects`，每帧挂 `rects`，并把文字部分（每帧一段、按 clipId 一行，写明舞台尺寸和缩图尺寸）推进 `notes`。`routes.ts` 本来就在渲完之后才把 `notes` 拼成 `note`，所以**不改 `routes.ts`，工具结果的文字部分已经带上矩形**。量不出来不连累图片（记一句话、`rects: null`）；调用方撤了照常往上抛。
   - 导出 `entityRectsNote`（纯函数，文字格式）。
3. **测试**
   - `server/test/cards-layout.test.mjs` 加 3 条：`entityRects` 缺帧合一趟 bake、每帧一次不截图、钩子是 `measureEntityRects`、record 进 `entry.html`；钩子回 null 时那帧是 null；`measureEntityRects` 在假 DOM 上跑，验 `solid` 何时为 null（无实体 / 实体全在舞台外 / 只有组流平面 / painted-box 那块在舞台外）、平面算实体、取整、没挂 `__pcSolid` 回 null。
   - 新增 `server/test/see-frames-rects.test.mjs`（6 条）：把 `render.ts` 用 typescript 转译、四个依赖换桩，验出口：缩图才量、单帧 / 多帧都带、文字格式、显式 `rects` 压过缺省、量不出来不连累图片、撤销往上抛。

### 越界的部分：`routes.ts` 的补丁（没提交，在 `out/d3-routes-rects.patch`）

D3 要求「`see_frames` 每帧的结果加 `rects`」这个**结构化字段**。回包 JSON 是 `server/vision/routes.ts` 逐字段拼的（`frames.push({ t, clipId, width, height })` 和单帧的 `sendJson`），不改它就只有文字部分、没有结构化字段。`routes.ts` 归 T1b-2，所以按任务书只出补丁、不提交。补丁全文：

```diff
diff --git a/server/vision/routes.ts b/server/vision/routes.ts
--- a/server/vision/routes.ts
+++ b/server/vision/routes.ts
@@ -374,7 +374,8 @@ export function registerPrerenderSide(server: ViteDevServer, root: string) {
               clamped.forEach((x, i) => {
                 const r = shots.get(Math.min(maxFrame, Math.max(0, Math.round(x * fpsOf))));
                 if (!r) return;
-                frames.push({ t: x, clipId: clipId || null, width: r.width, height: r.height });
+                // D3:实体矩形(舞台像素坐标),文字那份已经由 renderFrames 写进 notes
+                frames.push({ t: x, clipId: clipId || null, width: r.width, height: r.height, rects: r.rects ?? null });
                 images.push({ mime: "image/png", base64: r.buf.toString("base64"), label: `t=${list[i]}s` });
               });
               return sendJson(res, 200, {
@@ -410,6 +411,8 @@ export function registerPrerenderSide(server: ViteDevServer, root: string) {
               clipId: clipId || null,
               width,
               height,
+              // D3:实体矩形(舞台像素坐标),文字那份已经由 renderOneFrame 写进 notes
+              rects: shot.rects ?? null,
               note: notes.join(" "),
               // 这个形状是和 harness/agent.mjs(以及走 CLI 那条路的 mcp-server.mjs)
               // 约好的:看到 __image 就把它当图片块送进上下文,而不是让 base64
```

下游不用改：`vite-plugin-ai.ts` 的服务端 `see_frames` 单帧原样回 `data`、多帧回 `frames: data.frames`；`src/mcp/handlers/vision.ts` 的兜底同样透传 `frames`。补丁打上后 `npx tsc -b --force` 退出 0，实测结构化字段出现（见下）。

### 没改 `capture-snapshot.mjs` 的原因

任务书说落点是它的 `afterFonts` 钩子。钩子早就在（D4(b) 落地），调用方传函数进去即可，`capture-snapshot.mjs` 本身不需要改。而且它在 `frame-code.mjs` 的 `SNAPSHOT_FILES` 里：改一个字节 `snapshotCode` 就变，全部共享快照作废。所以页面函数放在 `frame-pipeline.mjs` 的 layout 一带（这个文件任何改动都会换 `frameCode`，这是躲不开的）。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出 0（打上 routes 补丁后也是 0） |
| 全量测试 | `npm test` | 退出 0；tests 1778，pass 1777，fail 0，skipped 1 |
| 本任务的测试 | `node --experimental-test-module-mocks --test server/test/cards-layout.test.mjs` | 11 条，pass 10、skipped 1（集成那条）；带 `PC_STAGE_TEST_URL=http://127.0.0.1:6921`（真预渲染进程）时 11/11 pass |
| | `node --test server/test/see-frames-rects.test.mjs` | 6/6 pass |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5260/?export=1"` | 退出 0；Total Frames 1800，Identical 1800，Different 0 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5260 node scripts/verify-unified-frames.mjs` | 退出 0；`PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.` |

导出路径不经过本任务的代码（只在 `see_frames` 缩图那条路上多量一趟），导出像素基线不变。

### 真打一次 `see_frames`（`/api/vision/snapshot`，预渲染进程 `http://127.0.0.1:6921`）

项目：1920×1080、30 fps、3 秒；下层轨 `odo`（odometer，靠左），上层轨 `pill`（punch-pill「Unified」0～3 s）、`late`（punch-pill「Late」2～3 s）。`times: [1, 2.5]`，200，4.1 s。`note` 里新增的部分（原样）：

```
实体矩形(舞台 1920×1080 像素坐标 [x, y, w, h],图片缩到了 768×432,按比例换算;box = 片段包裹层外框,solid = 实体像素的范围,solid 为 null = 这张卡此刻没有实体像素):
t=1s:
pill box=[0, 0, 1920, 1080] solid=[728, 434, 464, 212]
odo box=[0, 0, 1920, 1080] solid=[120, 375, 418, 330]
t=2.5s:
pill box=[0, 0, 1920, 1080] solid=[802, 468, 316, 144]
late box=[0, 0, 1920, 1080] solid=[871, 482, 178, 115]
odo box=[0, 0, 1920, 1080] solid=[120, 375, 418, 330]
```

对着图核（768×432 缩图，×0.4 换算）：

- `odo` [120,375,418,330] → 图上 x 48～215、y 150～282：和深色面板的四条边对得上（两帧都一样）。
- `pill` t=2.5 [802,468,316,144] → x 321～447、y 187～245：就是蓝色胶囊。
- `late` t=2.5 [871,482,178,115] → x 348～420：图上「Unified」中间「nifie」几个字母被一层半透明的蓝盖住发白，正是 `late` 在进场（弹簧缩放 + 淡入）；t=1 时它不在区间内，不出现在列表里。
- `pill` t=1 是 464×212，比看得见的胶囊（约 316×144）大：punch-pill 有一圈 `opacity 0.8→0, scale 0.8→1.5` 的扩散环，t=1 时 opacity 还没到 0，按 `isSolid`（opacity > 0 就算画了）算实体。这是 `solid.ts` 已有的口径，不是本任务引入的；`/api/cards/layout` 同一时刻给的 `contentBox` 也是 `{728,434,464,212}`，两边一致。

其它几次：

- 单帧 `t: 2.5`：文字部分同上那一段。
- `clipId: 'odo', t: 1`（`isolateClip` 保留上下文）：矩形与画面一致（上层轨照旧画出，矩形也列出了 `pill`）。
- blur-text 面板（`t: 0, 2.5`）：`solid=[688, 441, 544, 198]` → 缩图 x 275～493、y 176～255，就是深色面板。
- `/api/cards/layout { project, t: 1 }`：`{"odo":{"contentBox":{"left":120,"top":375,"width":418,"height":330}},"pill":{"contentBox":{"left":728,"top":434,"width":464,"height":212}}}`，和 D3 的 `solid` 逐像素相同（D4 回归正常）。
- 临时打上 `out/d3-routes-rects.patch`、dev server 自动重启后再打一次：`frames[0].rects = [{"clipId":"pill","box":[0,0,1920,1080],"solid":[728,434,464,212]},{"clipId":"odo",...,"solid":[120,375,418,330]}]`，结构化字段出现。验完已 `git checkout` 还原，没有提交。

看过的图：`t=1s`、`t=2.5s` 两张多帧缩图，`clipId: odo` 单帧图，blur-text `t=0` 图（都在 scratchpad，不入库）。

实测里没有碰到天然「此刻没有实体像素」的卡，`solid: null` 由假 DOM 单测覆盖，没有真浏览器证据。

dev server 由我在 5260 起（PID 33192），验完按 PID 连子进程一起结束；没碰 5190～5192、5203。

## 没做成的

- **`see_frames` 回包的结构化 `rects` 字段没提交**：要改 `server/vision/routes.ts`（T1b-2 的文件），补丁在上面。不打补丁时，矩形只出现在工具结果的文字部分（`note`），`FrameResult.rects` 已经就绪。
- 工具说明（`server/tools/vision.mjs` 里 `see_frames` 的 description）没提矩形：不在可写清单里。建议合并时加一句「返回里附每张卡的实体矩形（舞台像素坐标，`solid` 为 null = 此刻没画东西）」。

## 对任务书 / 语义的更正建议

- r2-r7-task.md 的 D3 说落点是「`capture-snapshot.mjs` 的 `afterFonts` 钩子」，任务分派又把 `capture-snapshot.mjs` 列为要改的文件。实际钩子早在 D4(b) 就落地了，D3 只需要传一个钩子函数进去；改这个文件会换 `snapshotCode`、作废全部共享快照，所以建议把措辞改成「经 `captureSnapshot` 的 `afterFonts` 钩子」，不要写成「改 `capture-snapshot.mjs`」。
- D3 的回包出口实际在 `server/vision/routes.ts`（`/api/vision/snapshot`），不在 `render.ts`。以后分派 D3 一类的任务，`routes.ts` 应当和 `render.ts` 放在同一份清单里。
- D3 写的是 `pixels: 'all'`，而 `layoutNow`（D4）用的是 `pixels: 'none'`。在快照 DOM 上两者等价：canvas 已经换成带 `data-pc-painted-box` 的 `<img>`，没有像素可扫。本任务按 D3 原文用 `'all'`。
- `bounds()` 量不到实体时退回包裹层外框，D3 的 `solid: null` 要另判，本任务在页面函数里做了。如果以后在 `solid.ts` 里给 `rectsWithBounds` 加一个「实体为空」的标记（R9 或后续任务，`src/render/**` 本任务不能动），`measureEntityRects` 里的那段走法就可以删掉。

## 待用户定

1. `out/d3-routes-rects.patch` 由谁、在什么时候打进 `routes.ts`（和 T1b-2 协调）。
2. 缺省量矩形的判据用的是 `post.shrink`（缩图 = 给模型看的 see_frames）。这是最保守的做法（不改 `routes.ts`、不让预渲染贴图和动图多付一趟），但属于隐式约定。打补丁的时候可以顺手在 `routes.ts` 的两处 `renderFrames` / `renderOneFrame` 调用里显式传 `rects: true`，这样更清楚。
3. 每次 `see_frames` 都会多做一趟：每帧再注一次快照、不截图（实测多帧两张总共 2.8～4.1 s，其中大头是渲染本身）。要不要给 Agent 一个关掉的参数，由用户定。本任务没加参数，因为那样要改工具的 schema。
4. 文字部分的格式：每帧一段、每张卡一行 `clipId box=[..] solid=[..]`。卡多的时候（例如 30 张卡 × 10 个时刻）会有 300 行，要不要截断由用户定。
