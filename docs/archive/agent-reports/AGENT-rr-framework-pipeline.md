# AGENT 报告：渲染重构「框架卡进真管线」补验

- 分支：`claude/rr-framework-pipeline`（基于 `main` 的 `0e2bfc22`）
- 工作区：`.worktrees/rr-framework-pipeline`
- 端口段：27780～27799；探针只占 27780～27782，用完已收，27780～27799 上没有监听。

代号说明：「乙」是渲染重构里做 remotion 式框架的那一项，「丙」是改建卡指南的那一项，二者都已合入 main；丙的报告（`AGENT-rr-guide.md`）只验到指南例子过建卡检查、在线页面的卡片运行时、托管渲染的隔离工作进程。本项补的是：用框架写的用户卡经桌面的预渲染进程产轨道流、经导出页导出、再和编辑器预览对上。「remotion 式」= 声明 `frameMode: "direct"` 的卡，「motion 式」= 声明 `frameMode: "stateful"` 的卡。〔裁〕是我在任务书没写死的地方做的决定。「审阅表」指 `src/cards/capabilities.json`。

## 状态

探针写好，在本工作区连跑多遍，最后两遍（提交后的代码）退出码都是 0、`fails` 为空。没有改产品代码（`src/`、`server/` 一个字没动）。**查出一件要主会话知道的事**：用户卡不在审阅表里，计划里 `compositing` 是 unknown，所以默认下它们**没有单卡轨道流**——这与任务书「钉成重卡后有它们的轨道流」的预期不一致，见「查出来的事」。探针把这一点单独核对并记录，再在探针进程的内存里改计划能力，验流本身（不回放）对这种卡成立。

## 做了什么

新增一支探针 `scripts/probes/framework-card-pipeline-probe.mjs`（文件头写了用法与验收口径）。自己起一台隔离的编辑器（`scripts/lib/dev-server.mjs` 的 `startDevServer`；`no-user-dirs.mjs` 设了 `PROMPTCUT_NO_PORT_FILE=1`；数据目录、导出目录、卡片改动层都在临时目录，检出目录里一个文件都不多），做完收掉进程树并删临时目录。

1. **建卡**：经真的 `POST /api/cards/create` 建三张卡。`fw-title`（DOM 卡：interpolate、Easing、spring、stagger、random、tween）、`fw-colors`（DOM 卡：interpolateColors、noise、loop、pingPong、randomRange、tween），都声明 remotion 式、都引用框架，必须回 200 且源码落进改动层；`fw-bad` 在 remotion 式里用了 `useState`，必须被拒（HTTP 400）、报错带行号（「第 8 行」）、说的是记状态的 hook、没有落盘（对照，证明走的是真检查）。
2. **项目**：1280×720、30 fps、9 秒。`fw-title` 0.7～4.9 秒，`fw-colors` 3.3～7.6 秒（起点都不在整秒上、各 4 秒以上），内置 motion 式卡 `punch-pill` 6.0～9.0 秒作对照。
3. **导出**（走 `scripts/export-frames.mjs`，和桌面导出同一个入口，数据 URL 带项目）：单路两遍、4 路两遍、只导 21 帧（含各卡首帧、每个切口的前一帧、切口、后一帧）。判据按字节，字节不同再比像素。4 路的切口取自导出自己打印的「分片导出」一行，要求每张用户卡的片段中间至少落一个切口、punch-pill 不被切。另核对不空洞（用户卡片段里抽查的每一帧有内容、相邻抽查帧画面不同、第 0 帧透明）。
4. **预渲染**（进程内起 `FramePipeline`，`streamPicked` 钉成全选）：4a 默认行为；4b 探针进程内存里改计划能力后：三条流、`replay` 与 `replayedFrames`、每条流作废两个分段重产（断租约）、每条用户卡的流取五个分段做「不回放直接产」对「回放着产」的逐帧像素比（punch-pill 作对照，必须比出差别）、流库里的分段对回放那一路 PNG 同编码器重编的逐字节比。
5. **预览对导出**：编辑器页（双舞台）载入同一个项目，暂停着点十个时刻（含往回点、同一帧到达两次），每次等回到精确活渲、画面连着三次采样不变，取可见舞台里这张卡的 DOM；导出一侧用同一个项目走导出的 `bakeFrames`（`targetFrames` + `fullFrame`，和第 3 步抽帧同一条路）每帧截完后取同一张卡的 DOM；逐字符比。
6. 输出 JSON（`ok`、`fails`、每一步的关键数）：过程写 stderr，stdout 最后一行是 JSON，同时写进 `--out/result.json` 与 `--json`。

## 验证结果

### 探针（本工作区，全部从 `node scripts/probes/framework-card-pipeline-probe.mjs --out <目录> --json <文件>` 起，无其它参数）

最后两遍（提交 `探针:…加 --default-review` 之后）：退出码 0、0，`fails: []`。其中一遍的关键数（另一遍同样；耗时只记录）：

| 步 | 关键数 |
|---|---|
| 建卡 | 两张 200，源码在改动层；违规卡 400，`第 8 行：用了 useState`，没落盘；`src/cards/user` 没多文件 |
| 导出 | 单路 270 帧；4 路计划 `0-66 67-134 135-178 179-269`，切口 67、135、179：`fw-title`（帧 21～147）里 67、135，`fw-colors`（帧 99～228）里 135、179，`punch-pill`（帧 180～269）没被切；抽 21 帧。单路对 4 路 270/270 字节相同；单路对抽帧 21/21；单路两遍 270/270；4 路两遍 270/270；像素不同 0。用户卡片段里抽查帧不透明像素最小 2438（`fw-title`）、43749（`fw-colors`），相邻抽查帧最大像素差 7 万、21 万；第 0 帧不透明像素 0 |
| 预渲染 4b | 三条流；`fw-title` 流 `replay:false`、`replayedFrames:0`（分段 1～9），`fw-colors` 流 `replay:false`、0（6～15），`punch-pill` 流 `replay:true`（12～17）。作废重产：`fw-title` 作废 [8,2]、`fw-colors` [14,7]，每段断租约（`resets` 各增 4），`replayedFrames` 增量 0；`punch-pill` 作废 [16,13]，增量 154。逐帧比 15 个分段（用户卡 10 个、对照 5 个）：用户卡 `diffPixelsMax` 全是 0，且每个含回放的分段 B 路确实回放了；`punch-pill` 不回放对回放像素差合计 567 万（比得出差别）。流库里的分段对同编码器重编的 10 条逐字节相同 |
| 预览对导出 | 十个时刻都回到精确活渲（每个约 0.5 秒，往 200 帧一次 1 秒）；14 个（时刻，在场的用户卡）对，DOM 与导出同一帧逐字符相同 14/14；第 80、45 帧两次到达（含往回点）DOM 相同；对照：第 45 与 80 帧 `fw-title`、第 120 与 140 帧 `fw-colors` 的 DOM 不同 |

看过的图（`out/fw-probe-final2/shots/`，该目录不入库）：导出帧 `export-single-f120/f200.png`（两张用户卡叠在一起、对照卡出画面；逐字弹入、柱子变色）；预览截图与导出页同一帧（第 160 帧，柱子形状、颜色、圆环对得上；预览在棋盘格透明底上，缩放过）；流分段 A、B 路图（`stream-*-A-direct.png`、`-B-replay.png`）。

### 基线

- `npx tsc -b --force`：退出码 0，无输出。
- `npm test`（同一条命令里设了两个环境变量）：`tests 5785、pass 5780、fail 1`，唯一的失败是已知偶发的 `server/test/artifact-push.test.mjs` 的 W4 用例；单独 `npm test -- server/test/artifact-push.test.mjs server/test/windows-hide-silent-spawn.test.mjs` 重跑：11 条全过，退出码 0（含守门测试 `windows-hide-silent-spawn.test.mjs`）。只加了探针，没有别的文件受影响。
- 不用跑的（没改产品代码）：`verify-determinism`、`verify-unified-frames`、两支键的比对（`card-source-version-compare.mjs`、`card-table-digest-compare.mjs`）——没有卡的键变化。
- 弹窗检查：每次探针前后各查一次可见窗口，没有新窗口；收尾确认 27780～27799 没有监听、没有残留 `chrome-headless-shell`、临时目录 `pc-fw-pipeline-*` 都已删。

## 查出来的事

**用户卡默认没有单卡轨道流（不是代码毛病，是任务书的预期与现行语义不一致）。**

- 现象：用框架写、声明 remotion 式的用户卡，即使 `streamPicked` 钉成全选，桌面预渲染进程里也**不产它的单卡轨道流**；同一项目里内置的 `punch-pill` 有流。
- 最小复现：`node scripts/probes/framework-card-pipeline-probe.mjs --only prerender --default-review`，输出 `steps.prerender.defaultBehavior`：`compositing` 是 `{ clip-title: unknown, clip-colors: unknown, clip-pill: independent }`，`streamClips: ["clip-pill"]`。更短的复现：`cardCapabilities({ id: 'fw-x', frameMode: 'direct', defaults: {} })`（`src/kernel/frameMode.mjs`）回 `compositing: 'unknown'`，内置的 `av-pulse` 回 `independent`。
- 根因线索：`cardCapabilities` 的 `compositing` 只认审阅表（`reviewedCompositing`），没登记的一律 `unknown`；`streamEligible`（`server/frame-stream.mjs`）只收 `independent`；`CardFrameCache.plan` 里 `cacheable = compositing === 'independent'`。用户卡不可能在审阅表里（卡片源码同步也不带审阅表，`docs/semantics/mechanism/platforms.md` 第 71 行同一件事）。语义 `docs/semantics/mechanism/cards.md` 第 44 行写明「审阅表没有覆盖到的卡，一律按下层依赖卡处理」，所以这是设计如此；缺省关着的「依赖下层的流」（`BELOW_STREAMS_DEFAULT=false`，「下层一」刚合入，取像素、贴回舞台、在线读取是后三块）才会收 unknown 卡。
- 影响：「不回放」这一项对用户卡**在现行默认下用不上**——它们没有单卡流可回放或不回放。用户卡在桌面上走活渲 / 本地档整场景快照那条路（我没有验这条路，不在任务范围）。
- 我没有改产品代码。要让用户卡也进单卡流，有两条路，都要主会话或用户定：一是给用户卡一个登记渠道（例如建卡检查已经保证 remotion 式的卡是 t 与参数的纯函数，再加上能查出 `backdrop-filter` 与读像素，就可以由建卡检查在改动层里登记 independent）；二是等「依赖下层的流」打开后让用户卡走它。
- 探针怎么处理：4a 把这个事实作为通过条件核对（用户卡没有单卡流、`punch-pill` 有）；4b 在探针进程里把这两张卡的计划能力改成 independent，验流本身。**4b 验的是「如果审阅表登记了它们」的情形**，已写明在探针文件头与本报告里。以后审阅表有了登记渠道，4a 那三条要跟着改（探针会红，提醒更新）。

## 没做成的与原因

- 没有验「依赖下层的流」（`kind: below`）对用户卡的情形：它缺省关、后三块还没合入，不在本任务范围。
- 预览与导出的比对用 DOM，不比截图像素（理由见下「〔裁〕」第 3 条）。没有做到「预览舞台的屏幕像素对导出 PNG」这一层；这一层在预览是缩放过、叠在主题底上的画面，本来就不可比。

## 我做的裁定

1. 〔裁〕项目用 1280×720 而不是 1920×1080：导出五次（含 4 路）总共秒级，探针全程两分钟内；卡的版面都按百分比写，不依赖 1080p。
2. 〔裁〕第 4 步分 4a / 4b（见上）：任务书的预期（用户卡钉成重卡后有流）与语义不符，探针既要如实记录默认行为，又要验流本身对这种卡成立；4b 的做法只改探针进程里的内存（包住 `pipeline.browserCardPlan`，把这两条输出的 `capabilities.compositing` 改成 `independent`），产品代码不动。
3. 〔裁〕预览对导出比 DOM：预览里舞台是按编辑台缩放显示的（缩放后重新光栅化、叠在主题底上），导出是 1:1 的透明层，两边像素本来不可比；卡是 t 与参数的纯函数，同一个 t 就该渲出同一份 DOM，DOM 逐字符相同加上第 3 步「导出帧在各路之间字节相同」，已经把「画面由 t 决定」两头都钉住。比 DOM 时扣掉舞台自己加在卡外壳里的兄弟节点（`data-pc-placeholder-slot`、快照 / 流 / 代理平面），两边做同样的处理——这是探针第一次比出 14 条不同时发现的：预览外壳的 `innerHTML` 在卡自己的 DOM 后面多一个隐藏的占位槽，卡的 DOM 本身一个字符不差。
4. 〔裁〕导出的比较先字节、字节不同再比像素，像素也不同才算不过；本次所有对比都是字节相同。
5. 〔裁〕每条流作废并重产两个分段（`[末段−1, 首段+1]`，彼此不相邻）而不是原探针的三个：这里每条流段数不同，按各自范围取。
6. 〔裁〕逐帧比的分段取五个以内（首段、首段+1、首段+3、中间、倒数第二）：用户卡的动画在前三段最动，后面落定；只取后面的分段会变成静止画面比静止画面。含挂载帧的那一段，回放着产也没有可回放的帧，探针对这种段要求 `replayed === 0`，对挂载帧在分段之前的要求 `replayed > 0`。
7. 〔裁〕预渲染的等待时限放宽到 30 分钟（只为防卡死）：原探针的 3 分钟在机器忙时不够。耗时只记录。

## 对任务书或语义的更正建议

- 任务书里「把两张用户卡钉成重卡，预渲染完有它们的轨道流」对用户卡不成立（见「查出来的事」）；建议把这句改成「钉成重卡不够，还要审阅表登记它们独立」，或者定下用户卡进流的路（登记渠道 / 依赖下层的流）。
- `docs/semantics/mechanism/cards.md` 第 44 行与 `platforms.md` 第 71 行已经写明未登记卡按下层依赖卡处理；建议在 `mechanism/cards.md` 的「分类以审阅表为准」一节加一句：用框架写的用户卡（remotion 式）因此没有单卡流，是现行取舍；这样以后不会再有人按「direct 就不回放就有流」的预期去验。
- 没有语义冲突需要改。

## 提交

见 `git log claude/rr-framework-pipeline`：报告开工、探针初版、含挂载帧的分段不要求回放、`--default-review`、本报告。
