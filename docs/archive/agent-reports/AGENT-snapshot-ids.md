# AGENT 报告：snapshot-ids（生成快照的 id 改名改成线性）

分支 `claude/snapshot-ids`，worktree `.worktrees/snapshot-ids`，从 main `b7635ad` 开出。端口段 5670～5679（dev server 5670，舞台 5671 / 5672；calibrate 用 5674～5677；ready-index-probe 5673；snapshot-hash-probe 5673 / 5676）。

状态：完成。改动、对拍、代价、G0 与 G0-R 全部跑完，都过（`preview-fallback-probe` 第一遍因 dev server 陈旧没过、重起后过，见「验证」）。

## 任务

`src/render/createSnapshot.ts` 的 `serializeScene` 对每个 id 在整段 HTML 上跑三遍正则改名，带 id 的元素多时是平方级（C10 探针 `docs/archive/agent-reports/AGENT-c10-probe.md`「旁证」：1400 个带 id 的元素约 6.5 s）。改成线性，生成快照的输出逐字节不变。

## 改法

一句话：三条正则各扫整段一遍、每处命中查 id 表决定改不改（`id="…"` 与 `href="#…"` 用后顾不吃前缀，`url(…#…)` 取最后一个 `#` 之后那段），连环改名（集合里同时有 `a` 与 `a__r`）按集合顺序预先算好终点；集合里只要有一个 id 含 `"'()&#$=` 或空白，整趟退回原写法。

- 新文件 `src/render/snapshot/renameSceneIds.ts`：`renameSceneIds(html, ids)`（新写法）与 `renameSceneIdsSequential(html, ids)`（原写法，退回用）。纯字符串函数，Node 单测直接 import。文件头写了「为什么查表和逐个 id 串行改得出同一个结果」的推理。
- `src/render/createSnapshot.ts`：`serializeScene` 里那段循环换成一行 `renameSceneIds(clone.outerHTML, ids)`；收 id 的写法（文档序去重、根 id 排最后）原样不动。
- `server/frame-code.mjs`：`SNAPSHOT_FILES` 加入 `src/render/snapshot/renameSceneIds.ts`（该文件注释的规矩：快照代码拆文件时集合跟着加）。
- `scripts/probes/c10-stage-probe.mjs`：`calibrate` 加 `--ids`（每个粒子带 id）并输出最后一帧整场景 html 的 FNV-1a 哈希，用来对照改前改后。
- 新单测 `src/render/snapshot/renameSceneIds.test.mjs`（对拍 + 代价，见下）。

## 更正：「快照键不变」做不到，按设计会变一次

`server/frame-code.mjs` 的 `snapshotCode()` 是共享快照键里的「渲染器版本」，它按**源码文本**哈希 `SNAPSHOT_FILES`（含 `createSnapshot.ts`）。该文件注释写明「改生成快照的代码 ⇒ 指纹变 ⇒ 共享键变 ⇒ 旧快照自然失效」。所以只要动了 `createSnapshot.ts`，共享键里的 `snapshotCode` 就必然变一次，合入后旧的共享档快照会作废重做一遍。快照**字节**与按字节算的**快照哈希**不变（证据见下）。要让键也不变，只能改 `snapshotCode` 的机制（例如手写版本号），那是另一件事，本任务没做。

## 对拍（输出逐字节不变）

对照是改动前 `createSnapshot.ts` 第 151～162 行原样拷进 `renameSceneIds.test.mjs` 的 `legacySerializeRename`；生产代码里退回用的 `renameSceneIdsSequential` 也和它对拍，免得两份拷贝走样。

| 组 | 内容 | 结果 |
|---|---|---|
| 夹具 11 组 | growth-curve 渐变 + `&quot;` 形式、`:r1:` clipPath、`<use href>` / `xlink:href`；SVG 的 radial/linear 渐变、filter、mask、marker、pattern、textPath，`_r_0_` / `«r0»` / `m.1`，`drop-shadow(...) url(#…)` 叠写，绝对地址与带路径的 `url(…#…)`，`aria-labelledby` / `aria-describedby` / `for`（两边都不改）；`<style>` 与正文里长得像引用的文字、` id=" id="g"` 这种前缀交叠、空 id；连环改名两种先后；13 个非普通 id；空集合；集合里的 id 不在 html 里；两条反例（见下） | 全部相同 |
| 随机 20000 组 | 固定种子 20260927，按碎片拼串（前缀、引号、括号、`#`、`&quot;`、`$`、空白、id 本身），30% 的组混入非普通 id | 全部相同；其中 >10000 组确有改动、>14000 组走新写法（断言钉住，保证对拍有牙齿） |
| 粒子场景 3 组 | 200 / 600 个带 id、互相 `url(#…)` 与 `<use href>` 引用的元素（约 4 KB 内联样式一个）；300 个且一部分 id 以 `__r` 结尾 | 全部相同 |

变异检验（每次只改一处，跑单测看是否拦住）：`id=` 或 `href=` 改成吃前缀、去掉连环改名、去掉退回、非普通 id 的排除里逐个去掉 `"` `'` `(` `)` `&` `#` `$` `=`——都被拦住。只有去掉「空白」这一项单测不挂：推理上空白不影响结果，排除它是保守。

两条反例（为什么 `(` 和 `=` 必须退回）：文本 ` id="url("#g)`、集合 `[g, url(]`——原写法先改 g 再改 `url(`，查表三趟会先改 `url(`、把 `url("#g)` 拆掉；` id="href="#g"`、集合 `[g, href=]` 同理。

真实页面上的对拍：

- **40 张内置卡逐帧整场景 html**：scratchpad 的 `harvest.mjs` 用本分支的 `FramePipeline` + `bakeFrames({ snapshotOnly: true })`，每张卡 1 秒 10 帧（1280×720），记每帧整场景 html 的 sha256。改前（`createSnapshot.ts` 未改时）与改后各跑一遍：**40 张卡、400 帧，0 帧不同**。其中带 id 的卡：lottie-navidad 每帧 242 个 id、lottie-bodymovin 61、lottie-happy2016 5、lottie-adrock 3、growth-curve / lottie / lottie-gatin 各 1。
- **c10-stage-probe calibrate 的粒子场景**：最后一帧整场景 html 的 FNV-1a 哈希改前改后相同（见下表）。

## 代价（改前 / 改后）

机器：Windows 11 Pro，28 逻辑处理器，puppeteer 自带 Chrome/152.0.7977.75 无头。Win32_Processor LoadPercentage 在 calibrate 前后读数 0～7%（calibrate 时机器较闲）；跑 G0-R 时 56～72%（别的子 Agent 在跑）。

`node scripts/probes/c10-stage-probe.mjs calibrate [--ids] --ns 200,600,1000,1400 --port-base 5674`，每档 8 帧，整趟 `createSnapshot` 的单帧耗时 p50（ms）：

| 元素数 | 带 id，改前 | 带 id，改后 | 不带 id，改前 | 不带 id，改后 | 带 id 的整场景哈希（改前 = 改后） |
|---|---|---|---|---|---|
| 200 | 124.3 | 63.3 | 61.8 | 63.3 | effb7490 |
| 600 | 1256.7 | 189.1 | 178.4 | 185.0 | eac98359 |
| 1000 | 3059.1 | 601.0 | 568.3 | 521.0 | 437481ae |
| 1400 | **6301.7** | **851.1** | 806.9 | 733.3 | af566b13 |

- 1400 个带 id 的元素：6.3 s → 0.85 s，与不带 id 的同规模场景（0.73～0.81 s）只差几十毫秒，平方项没了。剩下的 0.8 s 是样式内联（`inlineMs`），和 id 无关，不在本任务范围。
- 单测里的代价用例（`renameSceneIds.test.mjs` 最后一条，1400 个 id、4.7 MB html，只量改名本身）：单独跑 median 17.5 ms，全量测试里 median 32.3 ms，都是 1 批就过；判据中位数 ≤ 400 ms，最多 8 批、批间让出 100 ms（照 `src/kernel/diffProject.test.mjs` 的 `timeIt`）。原写法在同一段 html 上是秒级，退回平方级时每批都会超。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test` | 3121 项：通过 3119、失败 0、跳过 2（`/api/cards/layout` 集成、SKILL 闸门集成，都是要设 `PROMPTCUT_BASE` 才跑的），退出码 0 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5670/?export=1"` | 1800/1800 相同，退出码 0 |
| 导出像素与 main 基准 | `node compare-frames.mjs <pc-main-g0r/out/verify-a/frames> out/verify-a/frames` | total 1800、identical 1800、different 0、missing 0、extra 0，退出码 0 |
| 导出与快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5670` | PASS（no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames），退出码 0 |
| 就绪索引 | `node scripts/probes/ready-index-probe.mjs --port 5673` | `fails: []`，退出码 0 |
| 轨道流生产 | `stream-produce-probe.mjs --origin http://127.0.0.1:5670`，再加 `--group` | 两遍都 `fails: []`、PASS，退出码 0 |
| 兜底顺序 | `preview-fallback-probe.mjs --origin http://127.0.0.1:5670`，再加 `--page-preload` | 两遍 `fails: []`，四个场景（起播 / 跳转 / 超过 6 路流 / 编辑后）透明拍数都是 0，dense / snapshot 层都出现 |
| 块哈希跨进程 | `node scripts/probes/snapshot-hash-probe.mjs --port-a 5673 --port-b 5676` | `ok: true`，10 张卡 300 帧 identical 300、differentFrames 0，退出码 0 |
| 生成快照代价 | `c10-stage-probe.mjs calibrate`（见上表） | 1400 个带 id 6302 → 851 ms，整场景哈希改前改后相同 |

`preview-fallback-probe` 第一遍（两种模式）都没过：`超时:粒子卡的轨道流满密度、快照铺上一截`，K1 记录也超时，透明拍数仍是 0。原因是 dev server 陈旧：我改 `server/frame-code.mjs` 时 vite 自动重启了两次（日志 `server/frame-code.mjs changed, restarting server...`），重启前起的预渲染进程与 render-worker 还挂着，页面连的预渲染没再产出。把自己起的整棵 dev server 进程树结束、重新起 5670 后两遍都过。别的项不受影响：verify-determinism / verify-unified-frames 走导出页、stream-produce-probe 在本进程里自起管线、ready-index-probe 与 snapshot-hash-probe 自起编辑器。

dev server 只用了 5670（舞台 5671 / 5672，预渲染进程由它起在随机端口）；结束的进程都是自己起的那两棵树。

## 没做成的

- 快照**键**不变做不到（见「更正」）：`snapshotCode` 按源码文本哈希，改 `createSnapshot.ts` 就会变一次，合入后共享档快照作废重做一遍。快照字节与快照哈希不变。

## 更正与建议

- 任务书「快照哈希与键都不许变」里的「键」与 `server/frame-code.mjs` 的设计冲突（改生成快照的代码必然换键）。建议把验收改成「快照字节与按字节算的哈希不变；`snapshotCode` 随源码变一次是预期的」。若要让这类纯性能改动不作废旧快照，得另议 `snapshotCode` 的机制（例如快照格式版本号代替源码哈希），那会影响「改了生成快照的代码却忘了换键」的防线，需要主会话定。
- 非普通 id（含 `"'()&#$=` 或空白）仍走原写法，仍是平方级。真实卡片里没见到（40 张内置卡的 id 都是普通 id）；用户卡要是逐元素写这类 id 才会碰上。
- 1400 元素时剩下的 0.8 s 全在样式内联；M7 要逐帧在后台舞台生成快照的话，下一个要看的是 `inlineDOMStyles`。
- 改动后 dev server 因 `server/frame-code.mjs` 变动而自动重启时，旧的预渲染进程会留着，验证前要整棵重起（已在上面记下，可考虑写进 `docs/guides/troubleshooting.md`）。
