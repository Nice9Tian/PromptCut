# M4 Pipeline/Node Agent 报告

任务：渲染任务队列 M4「环境指纹进结果键」的实现方，唯一规格是契约 `docs/plan/render-queue-contract.md` 的 E 节（另参考 B.1、B.4，设计 `distributed-prerender-queue.md` 2.1）。
分支 `claude/rq-m4-node`，worktree `.worktrees/rq-m4-node`，基于 d5082a8（契约提交）。

## 状态

E.1～E.6 已全部实现。`tsc` 零错误。`npm test` 有 5 个失败，全部是「调 `plan()` / `planStreams` 时没带指纹」，契约写明这类由 Verification 补输入，没有别的失败。`server/test/` 和 `scripts/probes/` 都没动。

## 做了什么（逐文件）

| 文件 | 改动 |
|---|---|
| `server/bakery/environment.mjs`（新建） | `probeBrowserEnvironment({ browser, page }, { platform, timeoutMs })`。`browser.version()` 和 `page.evaluate(readWebglIdentity)` 并行做，各自受 `timeoutMs` 限制。页面里的函数是自包含的：建一个不挂进文档的 canvas，先试 `webgl2` 再试 `webgl`；有 `WEBGL_debug_renderer_info` 就读 UNMASKED 串，否则读 `RENDERER` / `VENDOR`；读完用 `WEBGL_lose_context` 释放上下文；拿不到上下文就返回两个空串。结果交给 `describeEnvironment`。这个函数从不抛出，超时后还没落定的承诺也接住，不会留下未处理的拒绝。 |
| `server/bakery/index.mjs` | 加了一行出口 `probeBrowserEnvironment`，模块表里加了一行说明。 |
| `server/card-cache.mjs` | 构造参数新增 `envFingerprint`，可以是字符串，也可以是返回字符串的函数。`plan()` 开头解析一次指纹，不是非空字符串就抛错，错误消息含「环境指纹」。每个 control 的键：`cacheContentKey` 取原来 `key` 的算法，`key = resultKeyOf(cacheContentKey, fp)`；`contentKey` 取原来 `snapshotKey` 的算法，`snapshotKey = resultKeyOf(contentKey, fp)`。输出新增 `contentKey`、`cacheContentKey`、`envFingerprint`。`costKey` 不乘指纹。`resultKeyOf` 从 `render-node/fingerprint.mjs` 引入。 |
| `server/frame-stream.mjs` | `planStreams` 新增参数 `envFingerprint`，不是非空字符串就返回 `[]`。单卡流的成员键是 `contentKey ?? (snapshotKey \|\| key)`，组流的成员键是 `cacheContentKey ?? key`。`contentKey = cardStreamIdentity(...)`，`streamKey = resultKeyOf(contentKey, fp)`，spec 新增 `contentKey`、`envFingerprint`。`StreamProducer.update` 传入 `this.pipeline.envFingerprint`，`status().streams[]` 新增 `contentKey`。`STREAM_CODE_VERSION` 没动。 |
| `server/render-node/split.mjs` | 快照内容键改为 `control.contentKey ?? control.snapshotKey`，本地档在前面拼上 `entryKey/`。流内容键改为 `stream.contentKey ?? stream.streamKey`，`input.contentKey` 用的就是它。其余照 B.4。 |
| `server/frame-pipeline.mjs` | 构造参数新增 `environment`；新增 `this.environment`（缺省 null）、getter `envFingerprint`、`ensureEnvironment(bakery)`。`ensureEnvironment` 并发调用共用一次探测，结果整个进程只定一次，`detected: false` 也照样定下；bakery 缺 `browser` 或 `page` 时不探测。调用点有两个，都用了 `await`：`bakery()` 里 `openBakery` 之后、`loadProject` 之前；`leaseStreamBakery()` 里 `openBakery` 之后。`CardFrameCache` 收到的 `envFingerprint` 是 `() => this.envFingerprint`。`diagnostics()` 新增 `environment`，`planDiagnostics()` 的每个 control 新增 `contentKey`、`envFingerprint`。`probeBrowserEnvironment` 按文件名直接引 `./bakery/environment.mjs`，原因见「过程中修掉的问题」。 |
| `server/vite-plugin-frames.ts` | `PUT /api/frames/snapshot`：在 `NOT_INDEPENDENT` 判断之后、写盘之前加了一道闸。请求体的 `envFingerprint` 不是字符串，或者不等于 `control.envFingerprint`，就回 `200 { ok: true, stored: false, reason: 'ENV_MISMATCH' }`，不写盘，也不发层。 |

没有改动的：`card-identity.mjs`、`entry.key`、`costKey`、就绪索引的线格式、路由正则、导出路径、`STREAM_CODE_VERSION`。旧键目录不删。

注释里写清了为什么：指纹整个进程只定一次，是因为中途换指纹会让已经写好的产物成为孤儿、页面上的层要整层重来，而同一进程里所有预渲染间的启动参数和 Chrome 二进制都相同，再探一次也得不到新信息；测量帧回 `ENV_MISMATCH`，是因为这些帧产自用户的浏览器，是另一种环境，按规定不混用；`plan()` 没有指纹就抛错，是因为不带指纹的键等于「哪种环境都认」。

### 过程中修掉的问题

第一版从 `./bakery/index.mjs` 引 `probeBrowserEnvironment`。`agent-lane.test.mjs` 和 `cards-layout.test.mjs` 都用 `mock.module` 替换整个 `bakery/index.mjs`，替身里没有这个出口，这两个文件整体加载失败。这不属于「没带指纹」一类，所以改为按文件名直接引 `./bakery/environment.mjs`（提交 aa833b8），修好后两个文件全部通过。

## 真实 Chrome 自检

脚本在 scratchpad 的 `m4-node/probe-env.mjs`，不入库。起浏览器用的是 puppeteer `headless: 'shell'`，启动参数逐字照抄 `chrome.mjs` 的 CHROME_ARGS（不含 `PC_CHROME_ARGS` 追加项）；再用 `Target.createTarget({ url: 'about:blank', enableBeginFrameControl: true, ... })` 开一页，调用 `probeBrowserEnvironment({ browser, page })`。结果原样如下：

```json
{
  "os": "windows",
  "gpuClass": "software",
  "chromeMajor": 152,
  "fingerprint": "258acaaa7c5fe509",
  "renderer": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  "vendor": "Google Inc. (Google)",
  "chromeVersion": "HeadlessChrome/152.0.7977.75",
  "detected": true,
  "probeMs": 34
}
evaluate after probe: 1+1 = 2
beginFrame after probe: hasDamage = true screenshot bytes = 0
browser closed
```

退出码 0，浏览器已在 `finally` 里关闭。探测之后这一页仍能正常 `evaluate`（1+1 = 2）。顺带发了一次 `beginFrame`，命令正常返回（hasDamage = true）；截图为空，这是空白页上的第一拍，只作参考，不在验收范围内。

### 另外做的验证（都在 scratchpad，不入库）

- **真实预渲染进程端到端**（`pipeline-e2e.mjs`）：在 worktree 起 dev server，端口 5240，舞台端口 5241、5242。用真实 `FramePipeline` 对 `stream-probe-project` 执行 `preload`，指纹在导出页上探测得到，结果如下：
  `environment {"os":"windows","gpuClass":"software","chromeMajor":152,"fingerprint":"258acaaa7c5fe509",...,"detected":true}`
  和空白页上探测到的指纹相同。核对了 7 项：`plans[].controls[]` 的 `snapshotKey === resultKeyOf(contentKey, envFingerprint)`，`streams[]` 的 `streamKey === resultKeyOf(contentKey, environment.fingerprint)`，全部成立。输出 `E2E OK`，退出码 0。
- **既有探针，未改动**：
  - `node scripts/probes/ready-index-probe.mjs --port 5240`：退出码 0，`"fails": []`。
  - `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5240`：退出码 0，`"fails": []`，输出 PASS，`produceMs` 19044。
  两支探针都从空库起跑，新键下的产物照常生产、就绪、能取到。跑完后我用 `taskkill /T` 结束了自己起的 dev server 进程树（PID 40964），确认 5240～5242 已没有监听。
- **不变式脚本**（`invariants.mjs`），全部通过：
  - E.3：两种指纹下 `contentKey` / `cacheContentKey` 相同，`snapshotKey` / `key` 不同，且等于对应的 `resultKeyOf`；`costKey` 相同；键是 64 位十六进制；指纹为 `undefined`、`''` 或函数返回 `null` 时抛错，消息含「环境指纹」。
  - E.4：两种指纹下流的 `contentKey` 相同、`streamKey` 不同；不带指纹返回 `[]`。
  - E.5：共享档任务的 `resultKey === control.snapshotKey`，流任务的 `resultKey === spec.streamKey`，本地档的 `resultKey = resultKeyOf(<entryKey>/<contentKey>, fp)`；两种指纹切出的任务 id 不相交。
  - E.2：注入 `environment` 时不探测；bakery 缺 `browser` 时不探测；并发调用 `version()` 只被调一次；`detected: false` 的结果也定下、之后不再变；`diagnostics().environment` 能看到。
- **失败的既有测试补上指纹后能过**：把 `frame-stream.test.mjs` 和 `card-cache.test.mjs` 复制到 scratchpad，只给 `planStreams` / `new CardFrameCache` 补上 `envFingerprint`，断言不动。结果 23 个测试 23 个通过。这说明这 5 个失败只缺输入，现有断言在新实现下仍成立。

## 基线

- `npx tsc -b --force`：退出码 0，零错误。修复 import 之前和之后各跑了一次。
- `npm test`：共 2086 个测试，通过 2080，失败 5，退出码 1。失败清单：

| # | 测试 | 失败原因 | 是否属于「没带指纹」 |
|---|---|---|---|
| 1 | `card-cache.test.mjs:19` independent controls use local MOV coordinates and never admit unknown Chrome cards | `new CardFrameCache({ root, project })` 没带指纹，`plan()` 抛出「还没有环境指纹」 | 是 |
| 2 | `card-cache.test.mjs:37` required context controls remain explicit misses and phase never covers the end frame | 同上 | 是 |
| 3 | `frame-stream.test.mjs:169` planStreams: one stream per eligible card, … | `planStreams(entry, {})` 没带指纹，返回 `[]`（0 !== 2） | 是 |
| 4 | `frame-stream.test.mjs:197` stream keys: placement-free for single-card streams, … | `planStreams(..., { budget })` 没带指纹，两边都是 `undefined`，notEqual 断言失败 | 是 |
| 5 | `frame-stream.test.mjs:209` isolatedStreamProject: … | `planStreams(..., {})[0]` 是 `undefined`，后面读 `spec.clipIds` 抛 TypeError（同一个文件第 230 行的调用也要补指纹） | 是 |

5 个全部属于「没带指纹」。修复 import 之前的第一轮还多 2 个整文件失败（`agent-lane`、`cards-layout`），已修掉，见上文。

## 没做成的与原因

- **E.6 的闸没有走 HTTP 实测**。要实测，得先在镜像里造好会话版本（`ensureMirrorVersion`），还要已经算出 card plan 的 entry，这套准备本质上是 Verification 那边的探针工作。这里只靠 `tsc` 和代码审阅确认。逻辑只有一个条件判断：`typeof input.envFingerprint !== "string" || input.envFingerprint !== control.envFingerprint`。
- 测试和探针的改动（E.7）按分工留给 Verification Agent。

## 对契约的疑点与我的选择

1. **E.1 的 `timeoutMs` 是按每一步算，还是按整次探测算**，契约没说清。我让两步并行，各自受 `timeoutMs` 限制，所以整次探测最多约 `timeoutMs`。两种理解下，「超时 → 不抛、`detected: false`」都成立。
2. **E.1 的「成功」怎么判**。我的判法：`version()` 返回非空字符串，并且 `evaluate` 返回一个对象，才算成功。`version()` 返回空串，或者 `evaluate` 返回的不是对象，都按失败计。WebGL 两个空串照契约仍算成功。建议契约写明「`version()` 返回非空字符串才算这一步成功」。
3. **E.4 单卡流成员键的回退链**。契约写的是 `control.contentKey ?? control.snapshotKey ?? control.key`，我实现的是 `control.contentKey ?? (control.snapshotKey || control.key)`。两者只在旧形状输入的 `snapshotKey === ''` 时有差别：这样写保留了原代码的 `||` 行为，新形状输入的结果和契约完全相同。
4. **E.5 流任务的 `input.contentKey`**。B.4 原文是 `contentKey: streamKey`，E.5 改了「流内容键」之后，我让 `input.contentKey` 取新的内容键，即 `stream.contentKey ?? streamKey`，和快照任务「`input.contentKey` 就是内容键」一致。建议在 E.5 里明说这一点。
5. **没有指纹时 preload 的行为**。`plan()` 抛错后，`preload` 里的 `catch {}` 让 `cardPlan = []`，接着照常 `adoptCardPlan(entry, [])`，等于这一版项目没有卡。真实进程里不会走到这一步：`acquire` 一定先经过 `bakery()`，指纹在那里已经定下。只有假 bakery（没有 `browser` / `page`）的测试会遇到。行为符合契约，只是提醒一下：以后如果有调用方绕过 `bakery()` 直接 preload，会静默地不产快照。
6. **E.6 的长期去向**。页面的浏览器和预渲染 Chrome 几乎不可能同指纹，因为页面走 GPU，预渲染走 SwiftShader。所以这道闸实际上等于永久关掉测量帧入库。建议在 TODO 里记一条：要么以后删掉这条入库路径，要么等纯浏览器节点（设计第 9 节第 6 步）有了自己的指纹，再让页面带上它。
7. **编辑器进程（`interactive: false`）也会探测**。它的 `bakery()` 同样经过 `ensureEnvironment`，启动参数相同，所以得到的指纹和预渲染进程相同，两边的键一致。这符合预期，记在这里备查。
8. **探测的开销**：每个进程只探一次，在导出页上约 34～42 ms。

## 提交

- b9de486 文档：M4 实现方报告（开工）
- 7a1c011 预渲染：环境探测 probeBrowserEnvironment；card plan 的 key / snapshotKey 乘环境指纹（E.1、E.3）
- 47c6280 预渲染：FramePipeline 定环境指纹并交给 card plan 与轨道流；流键、细任务切分用内容键乘指纹；测量帧入库加环境闸（E.2、E.4～E.6）
- aa833b8 预渲染：frame-pipeline 按文件名引 probeBrowserEnvironment
- 本报告的最终提交
