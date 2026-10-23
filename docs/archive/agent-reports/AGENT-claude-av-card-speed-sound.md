# AGENT 报告：claude/av-card-speed-sound

任务：用户 2026-10-23 回「出声。」推翻〔裁〕V21-28（0.7.21 发版时记的一条裁定：声画一体卡——自带画面和声音的卡——挂在变速素材段上仍然不出声）。这次让它预览和导出都照常出声，读素材的那一路随倍率变速变调，与同一版已放开的「音频素材效果卡的声音输入」同一口径；并解决 V21-28 当时留下的问题「声画一体卡的时钟按素材秒算，变速后切分、裁剪时已生成的声音怎么对位」。

分支 `claude/av-card-speed-sound`，从 main `84702232` 切出。提交：`989e605d`（建报告）、`6da940d8`（实现与单测）、`f9b859c7`（导出探针）、`f8e1d74f`（探针加画面一项、1 倍键比对）、本报告定稿一次。没有推送、没有合并。

## V21-28 的问题出在哪、怎么解决

声画一体卡挂在素材段上时（apply_card 之后：片段带 `cardId` / `mediaId` / `nodeId`，节点 `embeddedAudio: true`，输入 `source` 接这段自己的素材），它有一个**卡片时钟**，画面和声音共用：

- 画面：舞台给组件的 `t` = 片段内时间 + `sourceOffset`（`src/kernel/project.ts` 的 `flattenOverlay`）；图卡走 `GraphCard.tsx`，`sourceTime` = 片段内时间 + 节点 `timeOffset`。
- 声音：`audio()` 拿到的 `range.start` = 片段内采样 + 节点 `timeOffset`（`audioSources.ts` 的 `evaluateCardAudio`）。
- 已生成的声音（`clip.cardAudio`，一份 WAV）：记下生成时的源时钟 `sourceOffset`，播放偏移 = 当前源时钟 − `sourceOffset`（`cardAudioRendition.mjs` 的 `resolveCardAudioRendition`）。

三处的「起点」都取 `mediaOffset`（`cardGraph.mjs` 把节点 `timeOffset` 写成 `clip.mediaOffset`，`cardAudioSourceOffset` 也是 `clip.mediaOffset`）。1 倍时没问题；变速时就错了：片段内时间按**时间轴秒**走，而切分、裁剪按倍率推进 `mediaOffset`（`mediaOffsetAfter`：往后 d 秒时间轴，mediaOffset 加 d × speed）。结果 2 倍段在第 d 秒切开，后半段的卡片时钟凭空往前跳 d × (speed − 1) 秒：

- 画面跳一截（探针实测：改前切点前一帧红条 382 像素、切点那一帧跳到 512 像素）；
- 已生成的声音：2 倍时后半段判「预渲染结果未覆盖当前范围，请重新生成」（探针实测，改前 S 项失败）；0.5 倍时覆盖得上，但放的是 WAV 里错位的那一截，而且身份不变、不会被判过期——这就是 V21-28 担心的「已生成的声音怎么对位」。

**解法：变速段上声画一体卡的卡片时钟起点改为 `mediaOffset ÷ speed`**（新函数 `src/kernel/clipTime.mjs` 的 `cardClockOffset`）。

- 1 倍时直接回 `mediaOffset` 原值，逐位不变。
- 切分、裁剪把 mediaOffset 推进 d × speed，卡片时钟起点就推进 d，和切开前那一刻接得上；已生成的声音按「当前源时钟 − 区间起点」照旧对位（后半段偏移 = d），不用重新生成。
- 改速度时（mediaOffset ≠ 0）起点会挪：WAV 按卡片时钟索引，卡自己合成的那部分只是卡片时钟的函数，起点挪了偏移也跟着挪；读素材那部分的变化由身份里的输入倍率（上一支分支加的 `speed`）判过期。挪到 WAV 外面时照常判「未覆盖」，导出前自动重新生成。
- 卡读自己这段素材的那一路**位置一个采样都不变**：起点从 mediaOffset 改成 mediaOffset ÷ speed，读素材那条边的 `offset` 补上同样的差（mediaOffset − mediaOffset ÷ speed），读的仍是 mediaOffset + (片段内时间 + 边的偏移) × speed，和画面取帧（`GraphCard.tsx` 的 `mediaAt`）同一个式子。

**为什么不改 `cardGraph.mjs`**：它在三张内置有声卡的源码导入闭包里（守门测试 `src/render/audioCardSourceVersion.test.mjs`），改一个字就让用户已生成的卡片声音全部判过期。所以和上一支分支给素材节点加倍率一样，放在 `withMediaRates` 里：出画面、出键的几处（舞台、导出页、剪辑段嵌套场景、在线页面卡片计划）本来就在 `projectCardGraph` 之后调它，这次让求声音的两处（`audio/cardAudio.ts`、在线声音线程 `soundEngine.ts`）也调它，画面和声音拿的是同一份图、同一个时钟。没有变速段时 `withMediaRates` 回同一个对象。

**读素材的变速变调是哪一路做的**：卡读 `@clip/<自己>/source` 时走上一支分支的 `varispeedBlock`（按倍率多取、按绝对采样坐标线性插值），这次没改它。卡生成出来的 WAV 本来就是时间轴长度，所以导出混音清单里这一条照 1 倍摆位，不再带 `speed`。

## 改了哪些文件

| 文件 | 改了什么、为什么 |
|---|---|
| `src/kernel/clipTime.mjs`（+ `clipTime.d.mts`） | 新增 `cardClockOffset(clip)`；`withMediaRates` 顺带给「变速素材段的 `nodeId` 指向的、`embeddedAudio` 的卡节点」换 `timeOffset`、补读自己素材那条边的 `offset`（只在 `projectCardGraph` 把 `timeOffset` 写成了 `mediaOffset` 时接手）；`speedMutesSource` 注释更新 |
| `src/kernel/cardAudioRendition.mjs` | `cardAudioSourceOffset` 用 `cardClockOffset`（生成时记的 `sourceOffset` 与播放偏移同一个口径） |
| `src/kernel/project.ts` | `flattenOverlay` 给声画一体卡组件的 `sourceOffset`：变速段用 `cardClockOffset`，1 倍照旧原值 |
| `src/audio/cardAudio.ts` | 求声音的图改用 `audioGraphOf`（`projectCardGraph` 之后接 `withMediaRates`，块缓存键同一份）；删掉 `speedMutesCardAudio`，预览的 `generatedCardAudioClipsAt` 与导出前核对 `assertProjectCardAudio` 不再跳过变速段上的声画一体卡 |
| `src/online/cardRuntime/soundEngine.ts` | 在线声音线程求声音的图同样接 `withMediaRates`（只合成自己声音的声画一体卡在线页面能跑，时钟要一致） |
| `src/kernel/audioPlan.mjs` | 变速视频段只静原声：挂声画一体卡的（已生成的 WAV）照常进导出混音清单，不带 `speed` |
| `server/bakery/mux-audio.mjs` | 只改一句注释（「仍按变速段不出原声办」已不对）。**不在** `BAKERY_FILES` / `CAPTURE_FILES` / `SNAPSHOT_FILES` 里 |
| `src/audio/cardAudio.test.mjs` | 新增 3 个测试 |
| `server/test/clip-speed.test.mjs` | 新增 3 个测试，文件头一句 |
| `scripts/probes/av-card-speed-sound-probe.mjs` | 新探针：导出后测主频、切开后对位、画面时钟 |
| `scripts/probes/av-card-speed-1x-compare.mjs` | 新探针：1 倍改前改后逐字比对 |
| `docs/reports/AGENT-claude-av-card-speed-sound.md` | 本报告 |

没有动：`server/bakery/` 里进指纹的模块（`git diff 84702232 --stat -- server/bakery src/render/createSnapshot.ts src/render/snapshot src/render/snapshotRename.ts src/render/gl/canvasGrab.ts server/frame-pipeline.mjs server/frame-identity.mjs` 只有 `mux-audio.mjs` 一行注释）、`cardGraph.mjs`、`GraphCard.tsx`、`Stage.tsx`、`audioSources.ts`、语义文档。

## 验证

测试命令都带 `PROMPTCUT_ACCOUNT_PROVIDER_ROOT=C:\Users\admin\Documents\VisuHive`、`PROMPTCUT_PASSWORD_ORDER_MODULE=C:\Users\admin\Documents\VisuHive\account\password-order.mjs`、`PROMPTCUT_NO_PORT_FILE=1`。探针只用 5940（舞台 5941、5942），跑完 `netstat` 查 5940～5949 无监听。

1. **类型检查**：`npx tsc -b --force`，退出码 0，零错误（实现提交前跑）。
2. **受影响的测试**（没跑全量）：一条 `npm test -- <60 个文件>`，退出码 0，**405/405 通过**，「✓ npm test 最终结果：零失败」。文件取法：凡测试里引用了 `flattenOverlay`、`withMediaRates`、`soundEngine`、`cardAudioSourceOffset`、`cardClockOffset`、`audioPlanOf`、`kernel/project.ts`、`cardAudio.ts`、`clipTime` 的（38 个），加上 `src/render/cards/*.test.mjs`、`src/audio/*.test.mjs`、`server/test/audio*.test.mjs`、`src/layering.test.mjs`、`src/render/audioCardSourceVersion.test.mjs`（内置有声卡源码版本守门）、`server/bakery/audio-mix.test.mjs`、`server/bakery/mux-audio.test.mjs`、`server/test/cut-segment-audio.test.mjs`、`src/kernel/audioMute.test.mjs`、`cardGraph.test.mjs`、`cardAuthoring.test.mjs`、`cutFlatten.test.mjs`、`videoLayers.test.mjs`，以及键与接缝守门 `accept-018-rest-ssr-seam`、`card-cache-upstream-key`、`card-snapshot-identity`、`host-card-code`、`page-stream-plan`。
   - 新增的 3 个 `cardAudio.test.mjs` 用例在改前的代码上跑（`git stash` 掉实现）：3 个全失败；改后全过。
3. **出声的证据**：`node scripts/probes/av-card-speed-sound-probe.mjs --port 5940`，退出码 0。素材是带 440 Hz 正弦声的 20 秒视频，卡是临时写进改动层的声画一体卡（有画面组件、`audio()` 把输入 `source` 原样交出去），走编辑台的 `prepareExportSounds` 生成声音、`window.__pcIo.exportVideo()` 桌面导出。成片各段中间（去掉两头 0.3 秒）：

   | 段 | 倍率 | 期望 | 过零点测得 | DFT 峰 | 响度 |
   |---|---|---|---|---|---|
   | A | 1× | 440 Hz | 439.6 Hz | 440 Hz | −21.1 dBFS |
   | B | 2× | 880 Hz | 880.0 Hz | 880 Hz | −21.1 dBFS |
   | C | 0.5× | 220 Hz | 220.0 Hz | 220 Hz | −21.1 dBFS |
   | D1（先生成声音、再在 8 秒切开的前半段） | 2× | 880 Hz | 880.0 Hz | 880 Hz | −21.1 dBFS |
   | D2（后半段） | 2× | 880 Hz | 879.6 Hz | 880 Hz | −21.1 dBFS |
   | DX（跨切点 7.5～8.5 秒） | 2× | 880 Hz | 879.5 Hz | 880 Hz | −21.1 dBFS |

   其余各项：N0 导出前四段都要生成；G 生成四段；**S 切开 D 之后清单为空、两半共用同一份 WAV、播放偏移 0 → 2 秒**（后半段 mediaOffset = 8）；E 桌面导出成功且没有再生成声音（`soundSteps: 0`）；**V 画面：切点前一帧（第 239 帧）红条 254 像素、切点那一帧（第 240 帧）256 像素**（卡的红条宽 = 卡片时钟 ÷ 10 秒 × 640，期望都约 256）；E0 页面零报错。看过的图：`out/av-card-speed-sound/frame-239.png`、`frame-240.png`，红条左半幅，两帧几乎一样宽。

   **同一支探针在改前的代码上跑**（`git checkout 84702232 -- src server` 之后跑、跑完 `git checkout HEAD -- src server` 还原，`git status` 只剩未提交的探针改动）：退出码 1。A 440 Hz 照常；**B、C、D1、D2、DX 全部 −200 dBFS（没声音）**；S 失败：「c-… 的卡片声音预渲染结果未覆盖当前范围，请重新生成」；V 失败：切点前一帧 382 像素、切点那一帧 512 像素（卡片时钟跳了 2 秒）。
4. **1 倍逐字不变**：
   - `node scripts/probes/clip-speed-key-compare.mjs --base 84702232`，退出码 0：「✔ 57/57 项逐字相同」（帧身份、轨道前缀、镜像哈希、输入签名、`CardFrameCache.plan` 六个键、混音清单、看画面、导出兼容旁路），变速那一组照常变、「没碰的片段 34 项不变」，「✔ 全部相符」。
   - 它的样例里没有声画一体卡，所以另写了 `node scripts/probes/av-card-speed-1x-compare.mjs --base 84702232`，退出码 0：「✔ 14/14 项逐字相同」。样例是三段挂声画一体卡的素材段（有裁剪起点 0.1 + 0.2 的、节点自带 `timeOffset` 的、没写 mediaOffset 的）和两段声画一体卡片段，各带一份已生成的声音；比卡片图（`projectCardGraph` + `withMediaRates`）、`flattenOverlay` 的卡片表、1 倍片段的源时钟、卡片声音身份、已生成声音的播放偏移、`audioPlanOf`、`buildAudioPlan`，分「整份项目不变速」与「同一项目另有一段 2 倍普通视频」两种情形各 7 项。第一次跑时把 2 倍那段普通视频的源时钟也放进去比，结果那一项不同（3 → 1.5，正是预期的变化），所以这支比对是能发现差别的；定稿版只比 1 倍片段。
5. **渲染附加项**：没跑导出确定性、快照重放、像素基线比对。依据：`verification.md`「按改动范围验证」——画面变化只落在「挂在变速素材段上、`mediaOffset` 不为 0 的声画一体卡」这一种卡上，1 倍的键与卡片表逐字不变（上一条）；像素基线的演示项目里没有变速段（变速是 0.7.21 才有的），全量比对测不到它。对这一种卡做的改前改后比对就是探针的 V 项。

## 二级〔裁〕：用户看得见的其它变化（单列，请用户审）

1. **声画一体卡在变速段上的动画时机变了**（不只是声音）：卡片时钟起点从 mediaOffset 改成 mediaOffset ÷ 倍率。看得出区别的只有「变速段、且起点不是素材第 0 秒」（裁过开头、或切出来的后半段）这种情形：以前切开后后半段的动画会往前跳一截，现在和切开前接得上。理由：画面和声音必须用同一个时钟，声音要能在切分、裁剪后对位，画面就得跟着改；改的方向正好也修掉了画面那一跳。
2. **声画一体卡自己合成的声音（不读素材的那部分，例如 av-pulse 的提示音）在变速段上不变调**，跟卡的动画同速；只有它**读这段素材的声音**随倍率变速变调。理由：卡的动画在变速段上本来就按时间轴秒走（画面一侧从来没有按倍率加速卡片自己的动画），声音要和画面同步。任务书说的「和倍率一致（变速变调）」，在这个口径下指的是读素材的那一路；探针用的是直通卡，所以测得 f / 2f / f/2。如果用户的本意是「整张卡连动画带合成声音都随倍率加速」，那是另一套时钟（卡片时钟 = mediaOffset + 片段内时间 × 倍率，读素材时不再二次变速），画面一侧也要跟着改，没有在这次做。
3. 改速度且 mediaOffset 不为 0 时，已生成的声音可能判「未覆盖，请重新生成」（导出前自动重新生成）。理由见上「解法」第三点。

## 没做成的、没验证的

- **预览没在浏览器里实听**：预览的放开靠单测（`generatedCardAudioClipsAt` 收这一段、`persistentCardAudio` 的偏移对），预览播放器按 `t − start + offset` 放同一份 WAV，这条路没改。
- **在线浏览器导出没测**：在线页面本来就不取素材采样（既有限制），读素材的声画一体卡在线合成不了，用已生成的声音；只合成自己声音的声画一体卡在线声音线程的图已接 `withMediaRates`，`soundThread.test.mjs` 通过，没有新加在线用例。
- **时间轴上的静音标记没改**：桌面时间轴（`ClipMuteBadge.tsx` 的 `clipMuteReason`）、手机版（`FullTimeline.tsx`、`ThumbStrip.tsx`）对变速视频段一律挂「已静音 / 无原声」。挂了声画一体卡（或音频素材效果卡，上一支分支同样没改）的变速段现在是有声音的，「已静音」这个图标会误导。不在这次的文件范围（编辑界面），建议另起一项。
- **语义文档没改**（不在文件清单里，且 main 上同时有人在改语义）。需要的修改见下一节。
- 验收台账没登记两支新探针（台账不在文件清单里）。

## 对任务书或语义的更正建议

1. `docs/semantics/product/project-model.md`「视频段的速度」的声音一条，与这次的行为冲突，建议改：
   - 修改前：「变速的视频段不出原声（挂在它上面的音频效果、声画一体卡的声音同样不出）；……」
   - 修改后：「变速的视频段不出原声（挂在它上面的音频效果同样不出）；挂在它上面的声画一体卡照常出声，卡读这段素材的声音随倍率变速变调，卡自己的动画和合成的声音跟着卡的时钟走，切分、裁剪后与切开前接得上（2026-10-23 用户定「出声。」）；……」
2. `docs/semantics/mechanism/project-model.md`「片段速度」一节建议补一条「声画一体卡的卡片时钟」：起点 = mediaOffset ÷ 倍率（`clipTime.mjs` 的 `cardClockOffset`，1 倍逐位就是 mediaOffset）；在 `withMediaRates` 里换节点 `timeOffset` 并补读自己素材那条边的偏移；`cardAudioSourceOffset` 与 `flattenOverlay` 同一口径；为什么不改 `cardGraph.mjs`。探针清单加 `av-card-speed-sound-probe.mjs`、`av-card-speed-1x-compare.mjs`。
3. `docs/plan/release-021-rulings.md` 的 V21-28 一行，结果栏建议写：「用户 2026-10-23 回『出声。』——本条被推翻。返工在 `claude/av-card-speed-sound`：卡片时钟起点改为 mediaOffset ÷ 倍率，切分、裁剪后已生成的声音照旧对位；测频 1× 439.6 / 2× 880.0 / 0.5× 220.0 Hz，先生成再切开的 2× 段两半 880.0 / 879.6 Hz、不用重新生成；1 倍键比对 57/57 + 14/14」，并另记上面「二级〔裁〕」三条。
4. 任务书里「和倍率一致（变速变调）」对声画一体卡有两种读法（见二级〔裁〕第 2 条），这次按「读素材的那一路变速变调、卡自己的动画与合成声音跟画面走」做，请用户确认。

## 能不能合进 main

可以审。类型检查零错误；受影响的测试 405/405；导出探针全过（改前同一支探针 B、C、D 无声、切开后判未覆盖、画面跳 2 秒）；1 倍键比对 57/57 与 14/14。全量测试按约定由主会话发版前统一跑。需要用户审的是上面三条二级〔裁〕。
