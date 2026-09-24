# 报告：渲染任务队列 M4（环境指纹进结果键）

集成分支 `claude/rq-m4`，基于 main 的 `d1abd2b`（M3 已合入）。2026-09-24。未合并 main，等用户审核。

- 依据：`docs/plan/distributed-prerender-queue.md` 2.1（设计）、`docs/semantics/architecture/rendering.md`「不同环境的结果不混用」
- 任务书：`docs/plan/TASK-distributed-prerender-queue.md`（M4 行）
- 契约：`docs/plan/render-queue-contract.md` E 节（E.9 是定稿后的补充细则）

分工：
- 实现方（Pipeline/Node）在 `claude/rq-m4-node` 上照契约写实现；
- 测试方（Verification/Test）在 `claude/rq-m4-tests` 上只照契约写测试，没有看实现；
- 两边合进集成分支后由主 Agent 重跑全部基线。

本文并写了两方的报告。

## 1. 结果

| 项 | 命令 / 位置 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | **tests 2104，pass 2103，fail 0，skipped 1**。M3 之后的 2086 条加新增 18 条；跳过的 1 条照旧，需要 5190 的 dev server |
| 新增测试 | `server/test/env-fingerprint-keys.test.mjs` | F1～F8 共 18 条全过。合进集成分支后首跑即全过 |
| 就绪索引探针 | `node scripts/probes/ready-index-probe.mjs`（自带 5231） | 退出码 0，`fails: []`；原有 ①～⑨ 加新增 ⑩ |
| 轨道流探针 | `node scripts/probes/stream-produce-probe.mjs --origin http://127.0.0.1:5230`，另跑一遍带 `--group` | 两遍都 PASS，`fails: []`；含新增的指纹检查 |
| 预览兜底探针 | `node scripts/probes/preview-fallback-probe.mjs --origin http://127.0.0.1:5230`，另跑一遍带 `--page-preload` | 两遍都 PASS |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5230/?export=1"` | 1800/1800 帧逐像素相同 |
| 导出与快照重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:5230 node scripts/verify-unified-frames.mjs` | PASS |
| **导出像素基线不变** | 临时建一个 main（`d1abd2b`）的 worktree 起在 5233，跑同样的两条验证，逐像素对比两边的 PNG | 导出 1800 帧：**1800 相同、0 不同、0 缺失**；unified 的导出帧、`direct.png` 也相同 |
| 测量帧入库闸（E.6） | 临时脚本对 5230 现场发 `PUT /api/frames/snapshot` | 不带指纹、指纹不同 → `200 {stored:false, reason:"ENV_MISMATCH"}`；指纹相同 → `{stored:true, indexed:true}` |

本机预渲染 Chrome 探测到的环境（探针与实现方自检一致，进程重启后也一样）：

```
os windows · gpuClass software · chromeMajor 152 · fingerprint 258acaaa7c5fe509 · detected true
renderer  ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
chrome    HeadlessChrome/152.0.7977.75
```

预渲染用的 Chrome 带 `--disable-gpu` 加 `--enable-unsafe-swiftshader`，WebGL 走 SwiftShader，所以 `gpuClass` 是 `software`。这就是它真实的栅格化环境，没有特判。

## 2. 哪些键变了

算法：`resultKey = resultKeyOf(contentKey, envFingerprint)`，即 `sha256(contentKey + "\n" + fp)`，64 位十六进制。这是 M2 的函数，没有另写；快照、PNG 和流的路由正则都不用改。

| 键 | 用在哪 | 改在哪 | M4 之后 |
|---|---|---|---|
| 共享快照键 `snapshotKey` | `controls-html/<key>/`、就绪索引的 `html` 层、`/api/frames/snapshot/html/<key>/…` | `server/card-cache.mjs` 的 `plan()` | `resultKeyOf(contentKey, fp)`；`contentKey` 是原来的 `cardSnapshotIdentity` |
| 本地档键 `<entry.key>/<snapshotKey>` | `controls-local/<entry.key>/<key>/`、`local` 层 | 同上（随 `snapshotKey` 一起换） | 第二层换成结果键，`entry.key` 不变 |
| 独立卡 PNG 缓存键 `control.key` | `controls/<key>/`、`/api/frames/control/<key>/…` | 同上 | `resultKeyOf(cacheContentKey, fp)`；`cacheContentKey` 是原来的 `cardCacheIdentity` |
| 轨道流键 `streamKey` | `streams/<key>/`、`stream` 层 | `server/frame-stream.mjs` 的 `planStreams` | `resultKeyOf(contentKey, fp)`；流的 `contentKey` 由成员的**内容键**算，不含环境 |
| 细任务结果键（队列） | 任务 id | `server/render-node/split.mjs` | 用内容键重算。共享档任务的结果键等于 `snapshotKey`，流任务的等于 `streamKey` |

**不变**：
- `card-identity.mjs` 的四个函数，内容身份仍然只认内容；
- `costKey`；
- 就绪索引线格式与会话隔离；
- 导出路径。

**指纹从哪里来**：
- 新建 `server/bakery/environment.mjs` 的 `probeBrowserEnvironment`：读 `browser.version()`，在页面里开一个不挂进文档的 WebGL 上下文读 `UNMASKED_RENDERER/VENDOR`，读完立刻释放；
- 两步并行，各自 5 秒超时，从不抛出；
- `FramePipeline.ensureEnvironment` 在本进程仅有的两个 `openBakery` 调用点（`bakery()`、`leaseStreamBakery()`）之后调用，并发时只探测一次。结果整个进程只定一次，探测失败的结果也照样定下，免得中途换键把已写的产物变成孤儿；
- `FramePipeline` 可以直接注入 `environment`，供测试和以后的独立渲染主机用。

**没有指纹就不产键**：
- `CardFrameCache.plan()` 抛错，`planStreams` 回 `[]`；
- 现有调用点都已包在 `try` 里，所以不会产出「哪种环境都认」的键。

**诊断**：
- `/api/frames/diagnostics` 新增 `environment`；
- `plans[].controls[]` 新增 `contentKey`、`envFingerprint`；
- `streams.streams[]` 新增 `contentKey`。

**同一张卡、不同环境的对比断言**（F2）：同一份 browserPlan 喂给只差指纹的两个 `CardFrameCache`，断言：
- `contentKey` / `cacheContentKey` 相同；
- `snapshotKey` / `key` 必然不同；
- `snapshotKey === resultKeyOf(contentKey, fp)`。

F4、F5、F6 对流键、落盘目录、队列任务 id 做了同样的对比：
- 两种环境的目录两两不同；
- 一种环境写的快照和 PNG，另一种读不到；
- 两种指纹切出的任务 id 不相交。

**顺带的现象（不是 M4 改的算法）**：`entry.key` 的值变了。原因是它的因子 `frameCode` 哈希了 `server/frame-pipeline.mjs` 等源文件，本阶段改了这个文件。每次改预渲染管线代码都会这样，是既有行为。

## 3. 怎么保证探针不受损

- **键变了，缓存没了，探针照样全过。** 三支探针都从空库起跑，原有的「产出 → 就绪 → 取得到」断言就是在新键下重新生成产物的证明：
  - `ready-index-probe` 的 ③ 用新的共享键 `GET /api/frames/snapshot/html/<新键>/…` 取到快照；
  - `stream-produce-probe` 在新流键下产出 34 个分段，失败 0。
- **进程重启后键稳定。**
  - `ready-index-probe` 中途杀掉预渲染进程，新进程探测到同一个指纹，按新键扫盘、层原样重建；
  - `stream-produce-probe` 的第 11 步在同一库根上新起一个 `FramePipeline`：3 条流全部重新发出，**0 个分段重新生产**。
  - 指纹是确定的，同一台机器上不会自己换键。
- **探针里加了指纹检查**（测试方写）：
  - `ready-index-probe` ⑩ 与 `stream-produce-probe` 第 13 条，都查诊断里的指纹是 16 位十六进制，且每个 `snapshotKey === resultKeyOf(contentKey, envFingerprint)`；
  - 流探针另查每条 `streamKey === resultKeyOf(contentKey, fingerprint)`；
  - 两遍都过。
- **FramePipeline 其余行为不变**：
  - `preview-fallback-probe` 两种模式、`verify-unified-frames`、`verify-determinism` 全过；
  - 与 main 的导出逐像素相同；
  - M1～M3 的 174 条队列、节点、进程内集成测试照旧全过。
- **旧缓存**：旧键目录不删（用户数据只读不写），成为不再被引用的孤儿目录，占的盘空间要用户自己决定清不清。

## 4. 与对齐时不一致的地方

1. **范围多了独立卡 PNG 缓存键 `control.key`。** 任务书只写了「共享键、本地档键、流键」。PNG 缓存同样产自预渲染 Chrome，不乘指纹就会留下一条跨环境的产物路径，所以一并换了。组流的内容键也因此改取 `cacheContentKey`。
2. **测量帧入库加了环境闸（E.6）。** 页面把测量时推过的帧交给预渲染进程存成共享快照。这些帧产自用户的浏览器（GPU 栅格化），和预渲染 Chrome（SwiftShader）不是同一种环境，写进同一个键就是在同一层里混环境。
   - 现在请求体要带着相同的指纹才存，页面不带，所以**测量帧实际上不再入库**，这些帧由预渲染进程自己补渲；
   - 页面本阶段没改，它只在意 404，回 200 不影响它。

## 5. 发现的语义冲突

- `rendering.md`「预渲染结果的复用」的末句说「测量时推过的帧，只有独立卡能直接当预渲染结果存下」，同一节「不同环境的结果不混用」要求同一版的全部预渲染出自同一种环境。
- 测量在用户的浏览器里做，预渲染在 SwiftShader 里做，两条同时成立的前提（同一种环境）在本机几乎不会出现。
- M4 按后一条执行（上面第 4 节第 2 条），语义文档没有改，需要用户决定前一句怎么处理。可选：
  - 删掉；
  - 改成「测量环境与预渲染环境指纹相同时才存」，页面再补上报指纹。

已记进 `TODO.md`。

## 6. 双方提出的疑点与裁定

已写进契约 E.9：
- 超时按步算，两步并行；
- `version()` 返回空串算失败；
- `plan()` 先解析指纹（空 plan 没有指纹也抛）；
- 单卡流回退写法；
- 流任务的 `input.contentKey` 是流的内容键；
- 本地档任务的 `resultKey` 与落盘目录键不同是有意的，M5 的产物库接口负责换算；
- E.6 实际停掉了测量帧入库。

测试方指出 E.6 和两个 `ensureEnvironment` 调用点没有单测覆盖：
- E.6 由主 Agent 在 5230 上现场核对（第 1 节表末行）；
- 调用点由三支探针的 `environment.detected: true` 间接覆盖。

## 7. 过程记录

- 实现方第一轮有两个整文件测试失败（`agent-lane`、`cards-layout`）：它们用 `mock.module` 替换整个 `bakery/index.mjs`，替身里没有新出口。改为在 `frame-pipeline.mjs` 里按文件名引 `environment.mjs` 修好，没有改测试。
- 测试方有一次用相对路径的 PowerShell 写入落到了主工作区的 `server/test/card-cache.test.mjs`。它发现后用 `git checkout` 还原，主工作区干净；主 Agent 合并前复查 `git status` 为空。
- 两个子分支各有一份子 Agent 报告（`AGENT-m4-node.md`、`AGENT-m4-tests.md`），内容已并进本文，集成分支上删除，原文留在两个子分支的提交里。
- 验证用的 5230（本分支）与 5233（main 基线）两台 dev server、`m4-baseline` 临时 worktree 已关掉、删掉；`.claude/launch.json` 已还原。

## 8. 需要用户决定

1. 合并 `claude/rq-m4` 进 main（`--no-ff`），并清理 `rq-m4`、`rq-m4-node`、`rq-m4-tests` 三个 worktree 与分支。
2. 第 5 节的语义冲突：测量帧入库这条路径是删掉，还是改成页面上报指纹、指纹相同才存。
3. 是否清理本机数据目录里旧键的孤儿目录（`controls-html/`、`controls-local/`、`controls/`、`streams/` 下 M4 之前的键）。本阶段没动。
