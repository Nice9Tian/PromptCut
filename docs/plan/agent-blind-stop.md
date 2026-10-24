# 看不了画面时 Agent 不该蒙着眼睛做下去

出处：2026-10-24 云端会话 `cc-mvm5fqj9-y7bk`（项目 `sp_gxmnxgw5j6qgstffwglr2tlyih`，
运行 `run_9c18ac6a-dbfa-4eac-a72a-627cca53c6c4`，08:41:05–09:03 UTC，25 轮，22.6 分钟，零产出）。
那一次 `see_frames({source:"media"})` 连续两次回 `project-assets-read-failed`，模型转头手写了一张
637 行的自定义卡，把 18 轮全花在 `code_cache_*` 上，没调 `create_card`，撞 24 轮上限收场。

本文回答两件事：**它为什么没停下来告诉用户**，以及**怎么改**。

---

## 一、它为什么没停下来

不是模型不守规矩。按当时它拿到的信息，它的行为**正是提示词要求的**。四条机制叠起来才出的事。

### 1. 提示词给了一条做不到的硬要求，又没写做不到时怎么办

`server/ai-system-prompt.md:384`（「交互原则」）：

> **项目里有视频素材,排卡之前必须先用 `see_frames` 的素材模式(`source: "media"`)看过画面**
> …没看过画面就排卡,等于蒙着眼睛决定卡片放左边还是右边。

这是「必须」。但提示词里没有任何一条说：这个「必须」做不到的时候，是该停下来问用户，还是该硬着头皮继续。

### 2. 唯一相关的那条指引，明确叫它**继续**，不是停

`server/agent/service/cloud-tools.mjs:260` 的 `LOOK_NOTE_ON`（每次运行拼进系统提示词）：

> 工具回「这次没看成」时不要反复重试:按 `get_layout` 的规定框和卡片参数继续,做完在汇报里说明哪一步没有看过画面。

同一段还有一句**已经过时**的话：

> `see_frames` 只能看时间轴的画面,素材的镜头拼图(`source: "media"`)云端还没有。

而账号模式下 `mediaFrames` 提供者已经接上了，`server/agent/service/instance.mjs:601` 会把
`source:"media"` 真的派下去执行。于是模型同时收到三条互相矛盾的话：**必须先看素材** / **素材模式云端没有** /
**工具清单里确实有这个工具**。它试了两次、失败、按第 2 条「不要反复重试，继续」往下做——完全照规矩。

另一条同向的偏压在 `server/ai-system-prompt.md:15` 和 `:201`：素材相关的缺失一律「自己去找，**不要停下来**问用户」。

### 3. 错误本身什么也没说

模型两次拿到的只有：

```json
{"error":"project-assets-read-failed","code":"project-assets-read-failed"}
```

一个内部错误码，看不出是服务器侧的读取通道被关了（实际是 `PROMPTCUT_ASSET_RUN_ENABLED=0`，
内部端点回 503 `run-assets-unavailable`，见 `server/hosted/asset-runtime.mjs:136`）。

根源是一处遗漏：`server/agent/service/hosted-media-frames.mjs:293` 的 `readImageMedia()` 直接
`await assets.openRead(...)`，**没有 try/catch**；而同一个文件里**视频**那一支（`:380`–`:386`）有，会包成
`取素材失败(…)` 这样的人话。这次素材是 PNG，走的正是没包的那一支。

对比一下文件里本来就有的好例子（`:369`）：缺 ffmpeg 时回
`{ ok:false, cloudUnavailable:true, error: ff.reason }` —— 带 `cloudUnavailable` 标记、一句人话。
素材字节读不了本该是同一类，却漏成了裸错误码。

### 4. 模型完全不知道自己还剩几轮

`server/harness/agent.mjs:128` 的注释说得很直白：

> 进度这一行只给屏幕看,**不进模型上下文**。

「第 20/24 轮」只画在界面上。模型手里**没有任何轮次预算信息**（`deepAuto` 关着也一样），
所以它按「时间无限」的方式工作：先把一张大卡的源码打磨到满意，再提交。等它准备 `create_card` 时，
轮次已经用完了——那份它自己答应要写的「没看过画面」的汇报，也就永远没交上去。

循环层面现有的闸只有两道，这次都没拦住：

| 闸 | 位置 | 为什么没拦住 |
|---|---|---|
| 连续 3 次完全相同的（工具名+参数+结果）→ 判死循环停下 | `agent.mjs:322` | 只失败了 2 次；且第 2 轮那一轮里还同时调了 `card_authoring_guide`，整轮指纹不同 |
| 到达轮次上限 → 停下收尾 | `agent.mjs:324` | 这个是**事后**才触发的，不是预警 |

`agent.mjs:112` 的执行规则里有一句「遇到重复错误应改变方法或说明阻碍」——它照做了（改变方法：不看画面也做），
「说明阻碍」留到了收尾汇报，而收尾汇报没机会发生。

### 5. 它停下来也无处表达「我在等你」

`report_progress` 的参数只有 `final / stage / done / todo / problems`
（`src/ai/progressReport.ts:14`），**没有「阻塞中、等用户回话」这个语义**。
所以界面上「撞上限停了」和「在等你回话」长得一样，用户分不出来，模型也没有一个明确的「举手」动作。

---

## 二、方案

四层，按性价比排。**第 1、2 层就能根治这次这个场景**，第 3、4 层是通用加固。

### 第 1 层：错误要说人话，并且分级（**已由 PR #20 做完，不要重复改**）

PR #20（分支 `claude/cloud-media-error`）新增了 `mediaFetchError()`，图片和视频两条路共用，
「通道不可用」那一类回 503 并明说「重试也没用」，404 / 403 / 哈希对不上各自分开。
下面原本的设计保留作对照，本层**无需再动代码**。

<details>
<summary>原方案（已实现）</summary>

1. `server/agent/service/hosted-media-frames.mjs:293` 的 `readImageMedia()` 补上 try/catch，
   和视频那一支（`:380`）用同一套映射。顺手把映射提成一个函数，两处共用，避免再漂一次。
2. 给「素材字节读不了」单独一条分支：`openRead` 抛出 503 / `project-assets-*`（即服务端通道不可用，
   不是这张素材的问题）时，返回 `{ ok:false, cloudUnavailable:true, code:'media-read-unavailable', error: … }`，
   文字写清三件事：**读不了的是服务器侧的素材通道**、**这不是你的调用写错了**、**这台节点上所有素材字节都读不了（镜头拼图、转写、主体检测、音频测量同理）**。
3. 404 / `asset-missing` 保持现在的「上传没完成或已被清理」那句——那是素材本身的问题，和通道不可用要分开。

**判据**：错误分两类，模型能据此选不同动作——
*输入错了* → 改参数重试；*能力不可用* → 不重试，走第 2 层的决策。

</details>

### 第 2 层：提示词补「看不了画面时怎么办」，并解掉现有矛盾

1. **解矛盾**：`cloud-tools.mjs` 的 `LOOK_NOTE_ON` 删掉「素材的镜头拼图云端还没有」那句，
   改成按 `provided` 真实情况写（`cloudSystemNote` 已经有 `provided` 参数和 `pendingNotes`
   这套机制，照着 `family('shots')` 的写法加 `family('mediaFrames')` 即可）。
2. **开工就告知**（落地时分成了两半，见下）：原设计是「把能不能读素材字节做成一次性探测，
   和 `look` 一样拼进系统提示词」。实现时拆开了：

   - **静态那半照做**：`see_frames` 在工具表里没有 `provider` 字段（它归 `look`），所以 `provided`
     过滤时会被丢掉——改成由调用方把 `mediaFrames: accountProvided.has('see_frames')` 传进
     `cloudSystemNote`，判据和真正派活那一处同一个条件。提供者没挂上时，提示词第 0 轮就写明。
   - **运行时那半没做成探测**：真要探测「字节读不读得了」必须发一次真实的 `openRead`，而那需要
     项目和运行授权，等于每次运行都先白付一次往返；而且通道可能跑到一半才坏。改成由第 3 层那道
     「同一个工具同一个错误连续 2 次」的闸在**出事的那一刻**注入硬提示，并指回下面的决策表。
     好处是同一套机制对转写、主体检测、代下这些能力一并生效，不用为每种能力各写一次探测。
3. **补决策规则**（写进 `server/ai-system-prompt.md` 的「交互原则」，和 `:384` 那条硬要求挨着）：

   | 情况 | 该做什么 |
   |---|---|
   | 工具回 `cloudUnavailable`，且它是**本次任务的硬前提**（如用户点名「按画面里人物位置排版」） | 调 `final:true` 的 `report_progress`，`problems` 写清少了什么能力、`todo` 写清用户可以怎么办（在电脑上的 PromptCut 里做 / 让管理员开通道），**然后停下，不要继续调工具** |
   | 工具回 `cloudUnavailable`，但任务**不依赖**它（如纯卡片项目） | 按现有规定继续，收尾汇报里写明哪一步没看过画面 |
   | 同一个工具**同一个错误码连续 2 次** | 不许再调第 3 次。要么换路子并在汇报里写明，要么按上一行停下 |

   第一行是这次缺的那一条。判断「是不是硬前提」交给模型，但要给它一句可操作的标准：
   **用户原话里提到画面内容（谁在哪、避开什么、什么时候出现）就是硬前提。**

### 第 3 层：harness 加两道通用闸

1. **轮次预算告知**（治「做了很久什么也没生成」）。在剩余轮次过半和只剩 1/4 时，
   把一条话随工具结果注入模型上下文（`agent.mjs` 里 `appendUserText` 已有现成写法），例如：

   > 还剩 8 轮模型往返。先把能交付的最小版本落到时间轴上（建卡→上轨→看一眼），再回来打磨；
   > 来不及的写进 `report_progress` 的 `todo`。

   `deepAuto` 开着时不注入（现有约定是「不往模型手里塞任何关于轮次的话」，
   见 `agent.mjs:69`），保持一致。
2. **同码连续失败闸**：按 `(工具名, 错误码)` 单独计数，连续 2 次就在工具结果后注入一条硬提示
   （「这个能力这次用不了，不要再调；按系统提示词『看不了画面时怎么办』处理」）；连续 3 次直接
   `outcome = 'stalled'` 停下收尾。现有的整轮指纹闸（`agent.mjs:322`）保留，这是另一个维度，
   不互相替代。

### 第 4 层：让「举手」在界面上看得出来（可以后置）

给 `report_progress` 加一个布尔 `blocked`（缺省 false），服务端 `server/progress-report.mjs`
与 `src/ai/progressReport.ts` 同步解析；界面上 `blocked:true` 的收尾报告画成「等你回话」而不是
「已暂停」。这样「撞上限」和「在等你」用户一眼能分开，模型也有了一个明确的举手动作。

---

## 三、验收

按 `docs/semantics/guide_files/verification.md` 的影响范围：

- `npm run build`（含类型检查）通过；
- 受影响测试零失败：`server/test/see-frames-cloud-reason.test.mjs`、
  `cloud-tools-p1-media-frames.test.mjs`、`cloud-agent-look.test.mjs`、
  `cloud-see-frames-dispatch.test.mjs`、`agent-user-message.test.mjs`、`deep-auto.test.mjs`；
- 新增用例（每条都要有）：
  1. `openRead` 抛 503 时，`see_frames({source:"media"})` 对**图片**素材回 `cloudUnavailable:true`
     且文字里出现「服务器」「素材」字样，不出现裸错误码；
  2. `openRead` 抛 404 时仍回「上传没完成或已被清理」那一支，不被新分支吞掉；
  3. `mediaFrames` 没接上时 `cloudSystemNote` 写「还没有」，接上了就不写（对账现有 `pendingNotes` 的写法）；
  4. 剩余轮次过半 / 剩 1/4 时各注入一条预算提示，`deepAuto` 开着时一条都不注入；
  5. 同一工具同一错误码连续 2 次注入硬提示、连续 3 次 `outcome === 'stalled'`。
- 提示词改动本身不进自动化门槛，但要在一次真实云端运行里复核：把素材通道关着跑一条
  「按画面里人物位置排版」的要求，期望它在 3 轮内交出 `final:true` 且 `blocked` 的报告并停下。

## 四、范围与风险

- **不改**素材通道本身（`PROMPTCUT_ASSET_RUN_ENABLED` 和 10-17 起的 `asset-run-observer-lost`
  是另一条线，见 `docs/local.md`「新节点」一节的时间线）。本文只管「通道坏了的时候 Agent 的行为」。
  两条线互相独立：通道修好之后，这几道闸对别的能力缺失（转写、主体检测、代下）照样有用。
- 第 3 层的轮次提示会**改变模型的工作节奏**（更早落地、更少打磨），这是有意的，但要留一次真实运行观察
  是否变成另一个极端（草草交付）。第 1、2 层没有这个风险，可以先上。
- 第 2 层「硬前提」的判断交给模型，必然有误判。误判成「是硬前提」的代价是多问用户一次，
  误判成「不是」的代价是回到今天这个结局——所以标准要写得宽，宁可多停。
