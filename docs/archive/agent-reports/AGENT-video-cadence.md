# AGENT 报告：图卡视频源慢放节奏修复（claude/video-cadence）

- 任务：`docs/plan/TODO.md`「已做步骤的遗留」里「用户真机缺陷」一条（图卡的视频输入源在 0.5 倍慢放导出时节奏不均），以那一条为准逐条做；追加任务：同一条的第 3 条「真机验收」在笔记本上做。
- worktree：`.worktrees/video-cadence`，分支 `claude/video-cadence`，起点 main `4f0d234b`。端口只用了 6030～6042。
- 代号：**G0** 是每个阶段合并前的通用门槛（类型检查、全量测试等），**G0-R** 是改到渲染时另加的一组（导出确定性、像素基线、快照重放、预渲染探针），都在 `docs/plan/Master-Execution-Plan.md` 第 8 节；**VC-01～05** 是本分支新增单测的编号（video cadence）；**〔裁〕** 是执行中由会话按最小修改定下、等用户合入前审的语义改动标记。

## 状态

代码、探针、单测、G0、G0-R 全部做完并通过；真机验收（用户的 9tian666 包，改前改后各导一次）改前复现、改后通过，见第 7 节。没有改二级语义；三级语义的最终措辞见第 8 节，由主会话合入时写进 `docs/semantics/mechanism/cards.md`（本分支没动语义文件）。

## 1. 提交

| 提交 | 内容 |
|---|---|
| `353260c0` | 文档：建本报告 |
| `67a123fd` | 探针：`scripts/probes/video-source-cadence-probe.mjs`（改前 7 个用例 6 个失败） |
| `ea9fdfa6` | 修复：`src/render/cards/mediaSource.ts` seek 目标加 2 ms |
| `d9c97483` | 修复：`src/render/frameMedia.ts` 同款加 2 ms（探针改前时间轴片段用例也失败） |
| `db1f1569` | 测试：`src/render/cards/mediaSource.test.mjs`（VC-01～05） |
| `61a0b09c` | 计划：G0-R「预渲染探针」一行加 `video-source-cadence-probe` |
| （本次） | 文档：报告定稿 |

## 2. 改前探针抓到的缺陷（实测 m(n)）

探针做法按 TODO 第 2 条：ffmpeg 合成 64×64、第 n 帧整幅灰度 16 × (n mod 16) 的素材（30 fps 与 25 fps 各一份），项目 30 fps、256×144，七个用例各 60 帧首尾相接排在时间轴上，单进程导出 PNG，读中心 16×16 平均灰度还原源帧号 m(n)，断言 m(n) = floor((offset + rate × n / 30) × 源帧率 + 1e-6)。与 TODO 的出入：素材取 **3 s** 而不是 2 s（用例③ mediaOffset 0.35 要取到第 69 帧，2 s 只有 60 帧）；另加了一个「25 fps 素材走时间轴片段」的用例；直通图卡 `probe-cadence-pass` 由探针写进临时的卡片改动层（`PROMPTCUT_CARD_OVERRIDES`），检出目录一个文件都不写。

改前（起点代码）退出码 1，7 个用例 6 个失败（灰度读数离 16 的倍数最大 1，读数可信）：

| 用例 | 片段起点 | 不符帧数 | 实测 m(n) 前 12 帧 | 期望 |
|---|---|---|---|---|
| ①图卡 rate 0.5 offset 0 | 0 s | 10 | 0,0,1,1,**1**,2,3,3,4,4,**4**,5 | 0,0,1,1,2,2,3,3,4,4,5,5 |
| ①图卡 rate 0.5 offset 0.35 | 2 s | 13 | 10,**10**,11,12,12,13,13,**13**,14,**14**,15,16 | 10,11,11,12,12,13,13,14,14,15,15,16 |
| ②图卡 rate 1 offset 0 | 4 s | 27 | 0,1,**1**,**2**,4,**4**,6,7,**7**,**8**,10,**10** | 0,1,2,…,11 |
| ③时间轴片段 mediaOffset 0 | 6 s | 27 | 同② | 0,1,2,…,11 |
| ③时间轴片段 mediaOffset 0.35 | 8 s | 0 | 10,11,…（全对，目标落在帧中间） | |
| ④图卡 25 fps 素材 rate 1 | 10 s | 4 | n=6/18/36/48 取到前一帧 | floor(n×25/30) |
| ④时间轴片段 25 fps 素材 | 12 s | 4 | 同上 | |

用例① offset 0 的节奏正好是用户成片上的「新、重、新、重、重、新……」六帧一循环。rate 1 的片段起点不在 0 时同样大面积错（局部时间 = 播放头 − 起点，浮点误差把大半边界目标压到边界之前），时间轴普通视频片段（`frameMedia.ts`）与图卡一样中招。

只修 `mediaSource.ts` 之后：图卡用例全过，③ mediaOffset 0 与 ④时间轴片段仍失败（27 / 4 帧），所以按 TODO「探针不过再用同款修法」把 `frameMedia.ts` 一起修了。

## 3. 修法

- `src/render/cards/mediaSource.ts`：新增导出 `CARD_SEEK_LEAD = 0.002` 与 `cardSeekTarget(time, duration)`：`max(0, time) + 0.002`，时长已知时夹到 `duration − 0.0001`。`frame()` 设给 `currentTime` 的就是它。不依赖素材帧率。
- `src/render/frameMedia.ts`：模块顶上 `SEEK_LEAD = 0.002`（注释写明与 `CARD_SEEK_LEAD` 同一个数；不从 `mediaSource.ts` import，因为这个模块要在 React 之前装好、不拉素材分档那串依赖）。seek 目标 = `max(0, data-pc-media-time) + SEEK_LEAD`，夹法不变；出画判断里原来写死的 `0.002` 容差改用同一个常量，`want` 用加过偏移的目标。
- 代码指纹：`snapshotCode` / `captureCode` 不变（`00a5264bf8a062ff6e0b5ed0516cccd1` / `86e443cb6fa838aef64788af6822fd68`，与任务书给的相同）；两个文件都在 `src/` 下，只影响代码版本（frameCode）。

## 4. 改后探针与单测

- 探针（两处都修之后）：`node scripts/probes/video-source-cadence-probe.mjs --port 6030` 退出码 0，`fails: []`，七个用例 m(n) 与期望逐帧相同（rate 0.5 是 0,0,1,1,2,2…；offset 0.35 是 10,11,11,12…；rate 1 是 n；25 fps 是 0,0,1,2,3,4,5,5,…）。
- 单测 `src/render/cards/mediaSource.test.mjs`（经 vite `ssrLoadModule` 加载，假视频元素按 Chrome 的取法：帧时间戳四舍五入到整微秒、seek 目标截断到微秒、取时间戳 ≤ 目标的最后一帧）：
  - VC-01 假元素复现缺陷（原样 seek 到 2/30、5/30 取到前一帧；123/30 − 4 取到第 2 帧而不是第 3 帧）；
  - VC-02 目标正好等于 k/30 取第 k 帧（k = 0…89）；
  - VC-03 0.5 倍慢放 0,0,1,1…，片段起点 0 / 4 / 6 / 17.87 / 32.37 都对；
  - VC-04 offset 0.35 与 25 fps 素材；
  - VC-05 `cardSeekTarget` 的夹法与实际设给 `currentTime` 的值。
  - 新代码 5/5 通过；把 `mediaSource.ts` 换回起点版本跑，VC-02～05 失败、VC-01 通过（确认单测抓得住这个缺陷）。

## 5. G0

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0 |
| 全量测试 | `npm test` | tests 4172、pass 4170、fail 0、skipped 2，退出码 0 |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264b…` / `86e443cb…`，不变 |

## 6. G0-R（dev server 6033，`PROMPTCUT_NO_PORT_FILE=1`）

| 项 | 结果 |
|---|---|
| 导出确定性 `verify-determinism.mjs --url http://127.0.0.1:6033/?export=1` | 1800/1800 帧逐像素相同，退出码 0 |
| 导出像素基线（与 `.worktrees/main-g0r/out/verify-a/frames` 逐像素比） | 基准 1800、新 1800，**0 不同、0 缺失、0 多出**。不需要重定基线（导出页默认的演示项目里没有视频） |
| `verify-unified-frames.mjs`（`PC_FRAME_TEST_URL=http://127.0.0.1:6033`；项目里有一段 mediaOffset 0.4 的时间轴视频，覆盖到 `frameMedia.ts`） | PASS |
| `stream-produce-probe` | 第一次退出码 1，唯一一条失败是耗时门槛（1080p 全幅流 15 帧分段编码 p50 549 ms > 300 ms，当时本机还有别的探针在跑）；重跑一次退出码 0、`fails: []`、p50 282 ms。本分支不碰编码 |
| `stream-produce-probe --group` | 退出码 0，`fails: []` |
| `preview-fallback-probe` / `--page-preload` | 都是退出码 0，`fails: []` |
| `ready-index-probe --port 6036` | 退出码 0，`fails: []` |
| `query-render-probe --port 6039` | 退出码 0，`fails: []` |
| `video-source-cadence-probe --port 6030`（新） | 退出码 0，`fails: []`（见第 4 节） |

## 7. 真机验收（TODO 第 3 条）

**结论：改前复现了用户看到的「新、新、重、新、重、重」六帧一循环；改后六个 0.5 倍段在能判定的帧上严格「新、重」交替，0 处违反；六个 1 倍速段改后全部逐帧对得上原素材。** 另发现改前有两个 1 倍速段也是坏的（每 3 帧重一帧），改后好了。

### 做法

- 包：主会话给的 `scratchpad/user-procp/9tian666_pack.procp`（只读），复制解包到 `scratchpad/accept/pkg/`（`project.proc` + 一条 72.53 s、30 fps、1920×1080、无 B 帧的 h264 原素材）。包里的 `cards` 带了项目用到的四张画面卡（`finals-replay-video`、`finals-broadcast-wipe`、`finals-opening-motion`、`sniper-react-motion`）；两张音频图卡（`finals-game-audio`、`finals-broadcast-sfx`）与 8 条配音不在包里，只影响声音，验收只看画面。
- 没有走页面上的「打开 .procp」：直接把 `project.proc` 的 `project` 字段写成导出页读的 `project.json`，素材按哈希名硬链接进临时导出目录的 `media/`，四张卡写进临时的卡片改动层——和编辑器打开包之后导出页拿到的是同一份项目与素材。`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR` / `PROMPTCUT_PROJECTS_DIR` / `PROMPTCUT_CARD_OVERRIDES` 全指到 `scratchpad/accept/run-<改前|改后>/`，端口 6040～6042，没碰 `Videos\PromptCut`。
- 导出：`exportFrames`（`--no-video`，单进程）整片 2913 帧，帧直接在内存里处理不落盘（改后 2089 s、改前 2001 s；dev server 都没重启）。改前用起点 `4f0d234b` 的 `mediaSource.ts` 与 `frameMedia.ts`（本分支与起点在 `src/` 下只差这两个文件，临时换回、导完换回，未提交）；改后用本分支。
- 分析（脚本 `scratchpad/accept/accept-export.mjs`、`accept-analyze.mjs`）：
  - 每帧算整帧亮度的相邻帧平均绝对差（等价于 `tblend=all_mode=difference` 之后 `signalstats` 的 YAVG，只是在未压缩的 PNG 上算，不受编码影响），另存 192×108 的缩小灰度图；
  - 每个回放段按节点的 offset / rate 算规则帧 m(n) = floor((offset + rate × (T − 段起点)) × 30 + 1e-6)，把相邻两帧规则上「同一源帧（该重）/ 换源帧（该新）」与导出实际的相邻帧差比：该重的帧差应在噪声里，该新且原素材这两帧本身差得明显的，导出帧差应跟得上；原素材这两帧几乎一样（静止画面）的记「无法判定」；
  - 排除：每段开头 0.42 s、所有斜切转场卡的时段（段中间也有，如 22.633、65.999 s）、片头卡（0～5.4 s）、结尾 0.5 s 淡出；帧差只看画面中部并去掉左上角战术标注框与顶部条（`sniper-react-motion` 叠加层自己有进出场动画，帧差 0.5 上下，换源帧一般 10 以上）。

### 结果（改前 → 改后；「违反」= 该重却新 + 该新却重；序列取每段能判的前 24 帧，N 新、R 重）

| 段（s） | rate | 判了几帧 | 改前违反 | 改后违反 | 无法判定（前/后） | 改前序列 | 改后序列 |
|---|---|---|---|---|---|---|---|
| 0～11.867 | 1 | 187 | 62（该新却重 62，帧 164、167、170…每 3 帧一次） | 0 | 0 / 0 | NRNNRNNRNNRNNRNNRNNRNNRN | NNNNNNNNNNNNNNNNNNNNNNNN |
| 11.867～17.867 | 1 | 153 | 0 | 0 | 0 / 0 | 全 N | 全 N |
| **17.867～26.367** | 0.5 | 235 | 86（该重却新 44：550、556、562…；该新却重 42：555、561、567…） | **0** | 0 / 0 | NNRNRRNNRNRRNNRNRRNNRNRR | RNRNRNRNRNRNRNRNRNRNRNRN |
| 26.367～32.367 | 1 | 167 | 0 | 0 | 10 / 10 | （静止画面处有 R，前后相同） | 同左 |
| **32.367～40.433** | 0.5 | 229 | 121（该重却新 61、该新却重 60；985、986、987、990…） | **0** | 3 / 3 | NRNNRRNNRNRRNRNNRRNNRNRR | RNRNRNRNRNRNRNRNRNRNRNRN |
| 40.433～46.433 | 1 | 167 | 0 | 0 | 1 / 1 | 全 N | 全 N |
| **46.433～54.967** | 0.5 | 243 | 91（46 + 45；1407、1412、1413…） | **0** | 0 / 0 | NNRNRRNNRNRNRNRNRRNNRNRR | RNRNRNRNRNRNRNRNRNRNRNRN |
| 54.967～60.967 | 1 | 160 | 0 | 0 | 0 / 0 | 全 N（静止处 RR，前后相同） | 同左 |
| **60.967～69.967** | 0.5 | 249 | 79（40 + 39；1843、1848、1849…） | **0** | 0 / 0 | NNRNRRNNRNRRNNRNRRNNRNRR | RNRNRNRNRNRNRNRNRNRNRNRN |
| 69.967～75.967 | 1 | 167 | 52（该新却重 52，帧 2113、2116、2119…每 3 帧一次） | 0 | 1 / 0 | RNNRNNRNNRNNRNNRNNRNNRNN | 全 N |
| **75.967～83.467** | 0.5 | 212 | 98（49 + 49；2295、2296、2301…） | **0** | 0 / 0 | NRRNNRNRRNNRNRRNNRNRRNNR | NRRRNRNRNRNR…（开头 RR 是原素材静止帧，已记无法判定） |
| **83.467～97.118** | 0.5 | 382 | 79（47 + 32） | **0** | 131 / 125 | NNNNNNNNNNNNNNNNNRRNRNNR | NRNRNRNRNRNRNRNRNRNRNRNR |

- 改前 0.5 倍段就是「新、新、重、新、重、重」（NNRNRR）六帧一循环，与用户在成片上测到的一致；改后在能判的帧上严格交替。
- 最后一段有 125 帧无法判定：原素材 66～72 s 大段是几乎静止的画面（相邻源帧差 0.01～0.6），换没换源帧从像素上分不出来；能判的 253 帧 0 违反。
- 1 倍速段：改前 0～11.867 与 69.967～75.967 两段每 3 帧重一帧（这两段 offset 是 0 与 60.1，落在帧边界上；别的 1 倍速段 offset 如 9.85 落在帧中间，所以没事），改后全对。改前本来就对的四个 1 倍速段（11.867、26.367、40.433、54.967 起），改前改后的缩小图逐帧完全相同（各 180 帧），说明修复只动了取错的帧。
- 用 NCC（归一化相关）在原素材里直接找每帧最像的源帧，结果与上表一致：改后规则不符只出现在原素材静止的那几段（匹配本身分不出），改前在 0.5 倍段与那两个 1 倍速段成片地差一帧。

## 8. 三级语义最终措辞（主会话合入时写进 `docs/semantics/mechanism/cards.md`，标〔裁〕）

按实际实现核对过，与 TODO 原文只差最后一句补了「与时间轴视频片段同一个数」：

> 〔裁〕图卡的视频输入源在时刻 t 取素材里时间戳不超过 t 的最后一帧；t 正好落在帧边界时取边界上这一帧。变速与偏移先算出 t 再取帧。实现上 seek 目标加 2 ms，不依赖素材帧率。时间轴视频片段的导出取帧按同一句理解，也加同样的 2 ms。

建议〔裁〕说明写：试过什么——原样 seek（缺陷本身）；为什么不按帧率对齐帧中心——素材帧率在导出页拿不到可靠值（`media.fps` 常缺），且 2 ms 已小于 500 fps 以下任何素材的一帧；改了什么——两处 seek 目标 +2 ms。

## 9. `frameMedia.ts` 要不要同款修法

要，已修。改前探针的时间轴片段用例（③ mediaOffset 0、④时间轴片段 25 fps）失败 27 / 4 帧，模式与图卡一样；修后全过。`server/export-compose.mjs`（ffmpeg 旁路合成）本来就按「时间戳 ≤ 目标的最后一帧」取（`fps=round=up`），不用改。

## 10. 对任务书与语义的更正建议

- TODO 第 2 条的素材时长 2 s 不够用例③ mediaOffset 0.35 用，应写 3 s（探针已按 3 s）。
- TODO「修法」一句里「素材帧率已知时对齐到帧中心」与三级语义原文「不依赖素材帧率」矛盾；按任务书与语义原文做的是一律 +2 ms，建议删掉「对齐到帧中心」那半句。
- TODO 写「1 倍速段与原素材逐帧对得上」不完全准：真机验收的改前导出里 0～11.867 与 69.967～75.967 两个 1 倍速段每 3 帧重一帧（0～5.4 s 被片头卡盖着，可能因此没被注意到）；改前探针用例② 也显示 1 倍速会中招。建议 TODO 与通知用户时写「慢放段和部分原速段的画面会变，是修正」。

## 11. 需要主会话决定的事

- 合并本分支（`--no-ff`），合入时写第 8 节的三级语义〔裁〕。
- 修好随下一个补丁版本发；通知用户时写明「慢放段（以及 offset 落在帧边界上的原速段）的画面会变，是修正」。
- 真机验收是在笔记本上用包里的项目直接导出做的，没有经页面「打开 .procp」那一步；要不要再在编辑器里手动打开包导一次成片（带 mp4 编码）复核，由主会话定。

## 主会话审查（2026-09-30，笔记本主会话）

- 用户真机缺陷之二（随 0.7.9）。审过两处 seek 目标 +2 ms（`cardSeekTarget`、`frameMedia.ts` 与出画容差共用同一常量）；节奏探针改前 7 个用例 6 个失败、改后全过；单测 VC-01～05 改前 4 条失败。
- 真机验收（用户发来的 `9tian666_pack.procp`，笔记本、会话自己的临时数据目录）：主会话核过 `accept/before-analyze.txt` 与 `after-analyze.txt` 的 consistency 统计——改前六个 0.5 倍段每段 40～61 处「该重复却变了」和同样多的「该变却重复了」，1 倍速第 1、10 段各 62、52 处「该变却重复了」；改后 12 段两项全是 0（素材静止分不出新旧的帧另计：10、3、1、125）。粗指标 `ruleMismatch` 只看像素差、不看素材内容，素材静止时会误数，不作判据。
- 导出像素基线 0 不同、0 缺失，不重定。采纳语义：`mechanism/cards.md` 新增「图卡的视频输入源取帧」（三级〔裁〕）。TODO 那条的几处更正（探针素材 3 s、去掉「帧率已知时对齐帧中心」、改前 1 倍速段并非全都对）照报告记。
- 合入 main `b543b88e`。
