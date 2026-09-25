# M6c 快照分支报告（X6、X7）

分支 `claude/m6c-snapshot`（基于 `f98569a`，即派出时的 `claude/m6`），worktree `.worktrees/m6c-snapshot`，端口段 5420～5429。契约：`docs/plan/m6c-contract.md` 的 X6、X7。

状态：X6、X7 做完，验收项全部有证据；需要主会话处理的两件事见「遗留」第 1、2 条。

## 1. 做了什么

### X6 快照 style 声明顺序确定化

- `src/render/snapshot/inlineStyles.ts`：`buildStyle` 不再按 `CSSStyleDeclaration` 的枚举顺序直接拼串。它先把声明收成 `[属性名, 值]`，最后交给新导出的 `serializeDeclarations` 排序后拼接。`will-change` 合并后那一条也进同一张表。
- 排序规则是先分三组，组内按 UTF-16 码元序（`<`，不用 `localeCompare`）。三组依次是：无前缀的标准属性、`-webkit-` 这类前缀属性、自定义属性 `--*`。
  - 分组的依据是 Chrome 152 的实测：它自己的枚举就是「标准属性按字母 → 前缀属性按字母 → 自定义属性」三段，标准段 440 个、前缀段 36 个，段内逆序都是 0。
  - 同一块声明里有几对是「后写的赢」。例如简写 `mask-position` 会展开成 `-webkit-mask-position-x/y`；`writing-mode` 与 `-webkit-writing-mode` 是同一个值的两个名字，另外还有 4 对这样的双名属性。
  - 如果整串只按名字排，前缀属性会挪到标准属性前面，这几对的先后就反过来了。分组排序与 Chrome 原来的先后一致，真正排定的只有自定义属性那一段，以及 `will-change`。
  - 实测时的探测脚本写在 scratchpad，结论记在本节。
- 块哈希因此会变。`inlineStyles.ts` 本来就在 `frame-code.mjs` 的 `SNAPSHOT_FILES` 里，快照内容键随之变化，旧缓存按键失效后重产，不需要迁移（与契约一致）。

### X7 远端节点渲的卡在本机的 PNG

契约写的是：若 C6.2 / C6.4 的产出方不在清单里写 PNG 哈希，就在推送侧补上。现状确实没有写，所以两侧都做了。

- **推送侧**（`server/artifact-transfer.mjs` 的 `collectSnapshotResult`）：快照清单新增可选字段。

  ```js
  pngs: [{ key, fps, frames: [[localFrame, hash, bytes], …] }]
  ```

  - `key` 是卡的 PNG 缓存键，即 `CardFrameCache.plan` 的 `key`（结果键）。
  - 来源：本机活着的 entry 里，`cacheable`、档位相同、共享键（或锁换键前的 `ownSnapshotKey`）等于这一段目录键的 control。同一张卡摆几次共用一份快照，但 PNG 按摆放各一份，所以可能有多个 `key`。
  - 只列 `MovFrameStore.valid` 的帧：capture 与卡键对得上，全透明帧已二次确认。
  - 字节取盘上原样，包括 PNG 里的产出记录。读完会按字节里的记录再核一遍。
  - 带上 `pngs` 会让清单超过 256 KiB 时就不带，快照照常交付。
  - 没有 PNG 时不出现这个字段，旧的拉取方忽略它（C6.2 第 3 节「不认识的字段忽略」）。
- **块进 `px`**：`resultBlocks` 把 `pngs` 的块按 `ext: 'png'` 放进 `px` 命名空间。`pushResult`、C6.4 的去重 `blocksPresent`、推送队列都经它，因此都自动带上 PNG。
- **拉取侧**（`applySnapshotResult` 末尾的 `applyPngFrames`）：
  - 本机已有效的帧跳过、不下载，其余从 `px` 拉，并校验 sha256。
  - 字节里的产出记录必须满足两条才收：`cards` 等于这个键，并且与本机认的记录相符（同一份抓帧代码）。
  - 经 `MovFrameStore.put` 原样落盘，带上对方的渲染遍数。
  - 写到哪个 store：有 entry 用到这个键，就用那个 entry 的 `CardFrameCache.store(key)`；没有就在 `controls/<key>/` 上另开一个 `MovFrameStore`。
  - PNG 拉不到或对不上只记数（`png: { listed, written, skipped, fetched, mismatched, failed }`），不让这一段快照的落地失败。PNG 的下载块数并进 `fetched`。
  - 清单里没有 `pngs` 的，行为与原来逐字节相同：保持占位，不在本机补渲。
- `server/frame-mov.mjs`：`MovFrameStore.put` 加了可选的第 4 个参数 `{ renders }`，缺省为 1，原有调用不变。对方已二次确认的全透明帧，落到本机后不再算「待确认」。
- 两条接入路径都经 `applyResult`：M5b 队列的 `task.done`，以及 C6.4 的 `adoptFromManifests`（换机取用）。

## 2. 文件

| 文件 | 改动 |
|---|---|
| `src/render/snapshot/inlineStyles.ts` | X6：`serializeDeclarations`，`buildStyle` 改为收集后排序 |
| `server/artifact-transfer.mjs` | X7：`collectPngFrames`、`pngSourcesFor`、`validPngs`、`applyPngFrames`、`pngTargetFor`，`resultBlocks` 带 PNG |
| `server/frame-mov.mjs` | X7：`put(frame, buf, signature, { renders })` |
| `server/test/snapshot-style-order.test.mjs`（新） | X6-1～X6-5 |
| `server/test/artifact-png.test.mjs`（新） | X7-1～X7-7 |
| `scripts/probes/snapshot-hash-probe.mjs`（新） | X6 跨进程探针 |
| `scripts/probes/png-adopt-probe.mjs`（新） | X7 可视验收探针 |
| `docs/reports/AGENT-m6c-snapshot.md` | 本报告 |

## 3. 单测

用例名都带编号。在 `npm test` 里全过（见第 5 节原始行）：

| 编号 | 内容 |
|---|---|
| X6-1 | 同一组声明洗牌 50 次，拼出同一个串 |
| X6-2 | 三组顺序、组内码元序（大写先于小写） |
| X6-3 | 没有自定义属性时，输出与按 Chrome 枚举顺序拼的旧串逐字节相同（`mask-position` 仍在 `-webkit-mask-position-x/y` 之前） |
| X6-4 | 转译 `inlineStyles.ts`，假 DOM 上把同一份计算样式按 22 种枚举顺序喂给 `inlineDOMStyles`，得出同一份快照；判据不变（和父元素相同的继承属性照省，自带内联的照强制内联） |
| X6-5 | `will-change` 合并后按名字落位、只出现一次 |
| X7-1 | 推送侧：`pngs` 只列有效帧（未确认的全透明帧、缺 PNG 的帧不列），哈希是盘上字节的，块在 `px`、不在 `snap` |
| X7-2 | 拉取侧：B 的 PNG 与 A 逐字节相同，二次确认过的全透明帧带着 `renders: 2` 落地；`renderState` 从 60 帧缺料变为 58 帧真实 PNG，只剩对方也没有的 2 帧 |
| X7-3 | 清单没有 `pngs`：不下载任何像素块、不建 PNG 目录，仍是缺料 |
| X7-4 | 本机已有的 10 帧跳过不下载；capture 不同的节点一帧都不收（`mismatched: 58`） |
| X7-5 | 本机没有 entry 用这个键：照样写进 `controls/<key>/`，之后开的 `CardFrameCache` 查得到 |
| X7-6 | 3 块 PNG 在素材服务上不见了：快照照常落地、不抛，`png.failed: 3` |
| X7-7 | 同一张卡摆 70 次，PNG 条目超过 256 KiB：清单不带 `pngs`，快照清单照常交付 |

## 4. 探针

### X6：两个预渲染进程逐张比块哈希（10 张卡）

`node scripts/probes/snapshot-hash-probe.mjs`

- 做法：前后各起一套编辑器 + 预渲染进程（普通模式、空帧库、`PROMPTCUT_PUSH=0`、`PROMPTCUT_STREAMS=0`），preload 同一个 10 张卡的项目，逐帧比 `controls-html/<共享键>/<帧>.html` 的 sha256。
- 10 张卡：`ui-callout`、`entity-chips`、`focus-card`、`lottie-adrock`、`mu-animated-shiny-text`、`r6-stateful`、`pin-board`、`punch-pill`、`quote-lockup`、`r6-canvas`。

**本分支**：退出码 0。末行：

```
{"ok":true,"cards":10,"frames":300,"identical":300,"differentFrames":0,"styleOrderOnly":0,"fails":[]}
```

逐卡结果，哈希栏是 30 帧 sha256 串起来再取 sha256 的前 16 位：

| 卡 | A 帧数 | B 帧数 | 相同 | A 哈希 | B 哈希 |
|---|---|---|---|---|---|
| ui-callout | 30 | 30 | 30 | 02051dd7fdfdd41c | 02051dd7fdfdd41c |
| entity-chips | 30 | 30 | 30 | d44a187e250d21b3 | d44a187e250d21b3 |
| focus-card | 30 | 30 | 30 | 33b2745d9cef3cc7 | 33b2745d9cef3cc7 |
| lottie-adrock | 30 | 30 | 30 | f37bff293201c56f | f37bff293201c56f |
| mu-animated-shiny-text | 30 | 30 | 30 | 99826602547f2635 | 99826602547f2635 |
| r6-stateful | 30 | 30 | 30 | 883b510d88bc059e | 883b510d88bc059e |
| pin-board | 30 | 30 | 30 | f894c106040b25c6 | f894c106040b25c6 |
| punch-pill | 30 | 30 | 30 | 603526a4ce87532a | 603526a4ce87532a |
| quote-lockup | 30 | 30 | 30 | 7102b728596f05e9 | 7102b728596f05e9 |
| r6-canvas | 30 | 30 | 30 | eca8ae8fcb6d528a | eca8ae8fcb6d528a |

**对照（main `4130a5f`，同一探针 `--root <main 的临时 worktree>`）**：退出码 1。末行：

```
{"ok":false,"cards":10,"frames":300,"identical":0,"differentFrames":300,"styleOrderOnly":300,…}
```

300 帧全不同，而且全部只差 style 声明的先后，每张卡两边的哈希都不同。

另外，在把两张 R6 卡换进来之前跑过一版：10 张全是 DOM 卡，用 `mu-number-ticker`、`type-shift` 代替两张 R6 卡。这一版在 main 和本分支上都是 300/300 相同。可见改动前的不确定是项目里的某些卡（带 `<style>` 与 Tailwind 类的 `r6-*`）触发的，而且一触发就波及整个项目的每张卡。这与 `AGENT-m5b-pipeline.md` 当时的发现一致。

第一版探针还带过 `caption-track`，它是 `direct` 卡，不产快照，探针因此判失败。这是探针选卡的错，不是代码的问题，已换成 `ui-callout`。

### X7：本机两套预渲染进程模拟「远端产、本机取」

`node scripts/probes/png-adopt-probe.mjs`

结果：退出码 0，`fails: []`，`notes: []`。流程：

1. 独立文档服务 D 占 5429。
2. **A（远端）**：5420，连 D，`PROMPTCUT_PUSH=1`。legacy 页面载入项目（`r6-stateful`，2 秒 = 60 帧），preload 到 ready、推送队列清空。A 产出 60 帧 PNG，推送计数 `pushed 2, manifests 2, failures 0`。`uploaded 0` 是因为同一检出里前几次运行已经推过这些块。
3. **B（本机）**：5423，连 D，素材服务指向 A（`PROMPTCUT_ASSET_URL`）。
   - **取之前**：探针用自己的会话把同一份项目推进 B 的镜像，调 legacy 整帧通道 `/api/frames/see`，结果是 `{"source":"preview","incomplete":true,"missing":["clip-remote"]}`，即占位。
   - **取之后**：B 的页面 `?preview=legacy` 打开同一份项目，页面自己触发 preload。换机取用的计数是 `{"manifests":1,"fetched":120,"written":60,…,"failed":0}`，其中 120 = 60 块快照 + 60 块 PNG。再调 `see`，结果是 `{"source":"mov","incomplete":false,"missing":[]}`。页面上的整帧 `<img>` 换成 `…/mov/frames/000030.png`，没有报错条。
   - B 的 PNG 缓存与 A 逐字节相同：`{"a":60,"b":60,"identical":60}`。
   - 这张卡的 `controls/<key>/mov/full.mov`：A 有，B 没有。B 的 `fillCardControls` 见 HTML 与 PNG 都齐就跳过了，没有为这张卡跑过 PNG 那一支。B 整帧 MOV 里的这一层，贴的是取回的 PNG（经 `_cardRender`）。

**截图**（在本 worktree 的 `out/` 下，不入库）：

| 文件 | 内容 |
|---|---|
| `C:\Users\admin\Documents\PromptCut\.worktrees\m6c-snapshot\out\png-adopt-probe\legacy-before.png` | B 的 `?preview=legacy` 页面在取回之前：卡的位置是沙漏占位 |
| `C:\Users\admin\Documents\PromptCut\.worktrees\m6c-snapshot\out\png-adopt-probe\legacy-after.png` | 取回之后：同一页面显示真实的「R6 推帧卡」 |
| `C:\Users\admin\Documents\PromptCut\.worktrees\m6c-snapshot\out\png-adopt-probe\legacy-before-frame.png` | 取之前 legacy 通道回的整帧：灰底、沙漏、虚线框 |
| `C:\Users\admin\Documents\PromptCut\.worktrees\m6c-snapshot\out\png-adopt-probe\legacy-after-frame.png` | 取之后 legacy 通道回的整帧：真实卡面 |

四张我都看过，内容与上表一致。

**探针带了一个垫片，原因见「遗留」第 1 条。** 基线上 `?preview=legacy` 页面发整帧请求的去向是错的，页面只有一条 503 报错、没有画面。探针在浏览器里把 `UnifiedPreview.tsx` 这一个模块的 `target: "user"` 换成 `target: "prerender"`，产品代码没改。诊断里 `legacyShim: 4`，表示页面加载了 4 次这个模块，都换上了。

## 5. 基线与 G0-R

原始关键行如下。端口：dev server 5426（舞台 5427、5428），各探针自起的编辑器用 5420～5425，文档服务 5429。预渲染进程的端口由 `listenSafe` 随机取。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试（本分支） | `npm test` | `tests 2564 / pass 2503 / fail 60 / cancelled 0 / skipped 1`，退出码 1。60 条失败全是 AU（M6a 鉴权契约测试），原因都是 `Cannot find module …\server\auth\index.mjs`：派出时的基线 `f98569a` 没有这个文件（`git show f98569a:server/auth/index.mjs` 不存在），它在 `claude/m6` 之后的 `f888982` 里。非 AU 的失败 0 条；X6-*、X7-* 12 条全过 |
| 全量测试（合进 `claude/m6` 之后） | 临时 worktree 以 `claude/m6`（`f888982`）为底，`merge --no-ff` 本分支，再跑 `npm test` 与 `npx tsc -b --force` | `tests 2564 / pass 2563 / fail 0 / cancelled 0 / skipped 1`，退出码 0。唯一的跳过是 `集成:/api/cards/layout 对真实项目返回整数框 # SKIP`（要 5190 的那一条）。tsc 退出码 0 |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5426/?export=1"` | `Total Frames: 1800 / Identical: 1800 / Different: 0`，退出码 0 |
| 快照重放一致 | `node scripts/verify-unified-frames.mjs --origin http://127.0.0.1:5426` | `PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; streamed video contains all 10 frames.`，退出码 0 |
| 导出像素与 main | 临时 `git worktree add --detach .worktrees/m6c-main-baseline main`（`4130a5f`），在 5426 起它的 dev server 跑同一条 `verify-determinism`（main 自己也是 1800/1800），再用 pngjs 逐帧逐像素比两边的 `out/verify-a/frames` | `{"frames":1800,"sameBytes":1800,"diffFrames":0,"diffPixels":0,"missing":0,"extra":0}`：0 不同、0 缺失，而且逐字节相同 |
| ready-index-probe | `node scripts/probes/ready-index-probe.mjs --port 5426` | 退出码 0，`"fails": []` |
| stream-produce-probe | `… --origin http://127.0.0.1:5426` | `PASS`，退出码 0 |
| stream-produce-probe `--group` | 同上加 `--group` | `PASS`，退出码 0；组流 `groupClipIds` 三张 |
| preview-fallback-probe | `… --origin http://127.0.0.1:5426` | `PASS`，退出码 0；`transparentBeats: 0` |
| preview-fallback-probe `--page-preload` | 同上加 `--page-preload` | `PASS`，退出码 0；`transparentBeats: 0` |

- 5426 的 dev server 以 `PROMPTCUT_PUSH=0` 起，即不配推送队列的缺省状态（同 C6.4 第 8 节的口径），轨道流开着。
- 导出不生成快照（`inlineStyles.ts` 文件头第 4 条），所以 X6 对导出像素本来就不该有影响，上表确认了。

收尾：

- 两个临时 worktree（`m6c-main-baseline`、`m6c-snap-mergecheck`）删之前查过，没有 reparse point（junction）。main 的那个里只有 vite 生成的 `node_modules/.vite*` 普通目录。两个都已 `git worktree remove --force`。
- 我起的进程都结束了，5420～5429 上没有残留监听。没碰 5190～5192，也没结束别人的进程。

## 6. 与契约不一致之处、我定的细节

1. **X6 的「按属性名的确定顺序」**：做成「三组、组内按名」，而不是整串一条名字序。理由见第 1 节：与 Chrome 自己的先后一致，前缀属性与标准属性之间「后写的赢」的几对不会反过来。这仍然满足契约的「与浏览器枚举顺序无关」：组内顺序是我定的，不依赖浏览器。
2. **X7 清单字段的形状**：契约只说「清单里带 PNG 的哈希」，我定为 `pngs: [{ key, fps, frames }]`（第 1 节）。一段快照可以带多个 PNG 键，因为同一张卡的每个摆放各有一份 PNG。
3. **PNG 失败不让快照失败**：快照块拉不到时 `applyResult` 会抛错（C6.2 T8）；PNG 拉不到、对不上只记数、不抛。理由：PNG 只是 legacy 通道的料，不应让就绪索引那一侧的落地失败。
4. **PNG 让清单超限就不带**：快照清单超限是报错（C6.2 第 3 节），PNG 超限只是整段不带 PNG。
5. **只收产出记录对得上的 PNG**：capture（抓帧代码）不同的不收。这符合语义「前提还有节点渲染用的代码与发布方一致」；而且即使收下，本机的 `lookup` 也会把它逐出。
6. **`frame-mov.mjs` 在任务点名的文件之外**：任务说的是「PNG 缓存相关」，这里只加了一个缺省不变的参数。

## 7. 遗留（需要主会话决定）

1. **`?preview=legacy` 页面在基线上看不到画面（与 X7 无关的既有问题）。**
   - 现象：`src/editor/preview/UnifiedPreview.tsx` 第 46 行 `see_frames(project, [requested], controller.signal, { target: "user", lane: "user" })` 把整帧请求发给编辑器进程。编辑器进程是 `interactive: false`，对 user lane 回 503「交互帧请求请直接打预渲染进程。」。
   - 实测：页面每次取帧都是 `503 http://127.0.0.1:5420/api/frames/see`，预览区只有一条红色报错。
   - 建议：把 `target: "user"` 改成 `target: "prerender"`，即 `see_frames` 的缺省值，与 `frameClient.ts` 里 D5 的注释一致。
   - 这个文件不在我的范围里，我没改。X7 的可视验收靠探针里的垫片完成（第 4 节）。
   - 契约 X7 的截图验收要在这一行修好之后，才能在真实页面上不借垫片复现。
2. **本分支的 `npm test` 有 60 条 AU 失败**：来自派出时的基线缺 `server/auth/index.mjs`，与本分支的改动无关。合进 `claude/m6`（`f888982`）后全绿（第 5 节）。合并时以 `claude/m6` 的最新头为底即可，两边没有重叠的文件。
3. **换机取用不补旧段的 PNG**：`adoptFromManifests` 判断「本机是不是已经有这一段」时只看快照。X7 之前已经取回快照、缺 PNG 的段，不会再去取 PNG。只影响升级前留下的缓存；新取的段不受影响。
4. **不在 X7 范围内、但可能被问到的一点**：普通模式下，本机后台那一趟最后会把整帧 MOV 渲出来（后台 lane 不画占位），所以即使没有 X7，legacy 通道在 MOV 就绪后也会显示画面。X7 真正起作用的是两处：一是 MOV 就绪之前的 user lane；二是队列模式下本机不跑 `fillCardControls` 的卡，这一点在 X7-2 用 `renderState` 验证。探针里 B 的整帧 MOV 贴的就是取回的 PNG，因为 B 没有为这张卡跑过 PNG 那一支。

## 8. 提交

都在 `claude/m6c-snapshot` 上，没有推送、没有合并：

- `015ffa6` 报告开工
- `971c52e` X6
- `5b31390` X7
- `a16807d` 及之后几次：两个探针的迭代（选卡、垫片、对照会话）
- 本报告
