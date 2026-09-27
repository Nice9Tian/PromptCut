# AGENT 报告：snapshot-ids（生成快照的 id 改名改成线性）

分支 `claude/snapshot-ids`，worktree `.worktrees/snapshot-ids`，从 main `b7635ad` 开出。端口段 5670～5679（dev server 5670，舞台 5671 / 5672；calibrate 用 5674～5677；ready-index-probe 5673；snapshot-hash-probe 5673 / 5676）。

状态：进行中。

## 任务

`src/render/createSnapshot.ts` 的 `serializeScene` 对每个 id 在整段 HTML 上跑三遍正则改名，带 id 的元素多时是平方级（C10 探针 `docs/reports/AGENT-c10-probe.md`「旁证」：1400 个带 id 的元素约 6.5 s）。改成线性，生成快照的输出逐字节不变。

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
