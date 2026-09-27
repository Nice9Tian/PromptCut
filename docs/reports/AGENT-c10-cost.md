# AGENT 报告：c10-cost

分支 `claude/c10-cost`，worktree `.worktrees/c10-cost`，起点 `claude/c10-integ` 的 `e067d0b`。端口段 5670～5679。

范围：`docs/plan/c10-contract.md`（C10 其余的契约，下称「契约」）第 3 节低内存档的完整规则，边界照第 18 节第 7、8 条（第 7 条：`c10-browser` 与 `c10-cost` 的分工；第 8 条：低内存档判轻的卡不补渲、播放时占位、停下画出、导出时本机渲）。

术语：「低内存档」是手机、iPad 浏览器的运行档位；「界限搜索」是低内存档按共享成本记录给卡排序、二分测到本机跑不动的第一张卡、以它为界判轻重的做法；「补渲」是为弱设备补做的预渲染任务（`priority: 'backfill'`）；「成本记录」是一张卡的活渲单帧耗时，按「卡片身份 + 环境指纹」存在文档服务。「G0」是基线（类型检查、全量测试、两种构建）；「G0-R」是导出确定性与像素比较。

## 进度

任务书 7 项都做了；本机探针、低内存档回归已跑，结果见「验证」。`c10a-demo-probe --local` 有一项超时没过，见「验证」与「需要主会话定的事」第 1 条。

## 提交

| 提交 | 内容 |
|---|---|
| `586532a` | 建报告 |
| `59a97db` | 文档服务成本记录模块 `server/docservice/modules/costs.mjs`（`cost.put` / `cost.list`），挂进 `shared-service.mjs` 的按空间模块组；托管部署清单加 `server/render-node/fingerprint.mjs`；单测 CC-01～CC-09 |
| `a5c4b06` | 界限搜索纯逻辑 `src/render/boundarySearch.mjs`（+ `.d.mts`）；单测 BS-C01～BS-C10 |
| `35fbe59` | 页面侧共享成本记录 `src/editor/sharedCosts.ts`（`publishSharedCosts` / `listSharedCosts` / `SharedCostRelay`）；单测 SC-01～SC-07 |
| `4929594` | 接进分派与界面：`pipelinePlan.mjs` 加 `lowMemoryLight`；`planDispatch.ts` 分显示表与判定表；补渲只对判重缺产物的层；导出里判轻的卡本机渲；页面驱动 `src/editor/lowMemorySearch.ts`、遮罩 `src/editor/LowMemoryGate.tsx`；`Preview.tsx` 接线（搜索、桌面转写、测量期间的闸门）；单测 CP-01～06、LS-01～05；C10A-L17-H2 按新接口改 |
| `60dc5d7` | 队列优先级补充单测 CQ-01～03 |
| `8ccdac8` | 三级语义：`mechanism/rendering.md`「低内存档」与 `mechanism/document-service.md`「成本记录」补数字与做法 |
| `a06fd5b`、`6bb57ca` | 本机探针 `scripts/probes/c10-cost-probe.mjs` |
| `e879181` | `c10a-demo-probe` 第 2c 步按新规则改 |
| `40ad123`、`742561d` | `lowmem-online-probe` 的 G3 按 c10a 第 17 节改；修低内存档停下追一帧的并发（见「偏离」第 5 条） |

## 做了什么

### 1. 文档服务的成本记录模块与协议（`server/docservice/modules/costs.mjs`）

- 按项目空间各起一份（`spacedModule`，与内容库同一份空间存储），每个项目一条追加日志 `costs/<projectId>`，重启后回放（与只在内存里的渲染任务队列不同）。
- 键 `(identityKey, envFingerprint)`；值 `stepMs`、`samples`、`measuredAt`、`mode`（`dev` / `build`）。同键只留最新一条，「最新」按 `measuredAt` 比（新来的不比已有的旧才替换，同一时刻后到的赢）。
- 协议（请求可带 `reqId`，回包原样带回）：
  - `cost.put { projectId, records: [{ identityKey, stepMs, samples, measuredAt, mode }], environment | envFingerprint }` → `cost.stored { projectId, envFingerprint, count, added, updated, ignored }`。`environment` 是页面报的原始值 `{ platform, userAgent, renderer, vendor }`，服务端用 `describeEnvironment`（预渲染结果键同一套）算指纹；`envFingerprint` 是算好的 16 位十六进制（给 Node 调用方）。二者恰好给一个。
  - `cost.list { projectId, environment? }` → `cost.listing { projectId, records, truncated, envFingerprint? }`：本项目全部记录；带了 `environment` 就顺带回它的指纹（低内存档拿来做本地复用的键）。
  - 出错 `error { reason }`：`bad-message`（形状不对，整条不落）、`forbidden`、`too-large`、`unsupported`。
- 权限：共享项目的空间里 `projectId` 必须等于空间名（连接凭证里的项目），否则 `forbidden`；管理身份一律 `forbidden`；`local` 空间只有本机身份进得来，按 `projectId` 分开存。
- 三级数字：一次最多写 500 条；一个项目最多 20000 条（满了只许替换已有的键）；一次读最多 5000 条，超了按测量时刻从新到旧留、标 `truncated`；`stepMs` 上限 600000 ms。
- 卡片身份用现有的 `cardCostKey`（`src/render/cardCostKey.mjs`，本来就不含机器）。探针证实桌面 dev 与在线构建算出的身份相同（16 张卡全对上）。

### 2. 桌面转写（`src/editor/sharedCosts.ts` 的 `SharedCostRelay`，由 `Preview.tsx` 在非低内存档时起）

- 连着共享项目（页面的共享文档服务连接 `docRequest` 在、`currentSharedLink()` 在）时，每 5 秒核一次：只转写这台浏览器测的记录（`device` 串以本页 UA 和 GPU 渲染器开头、`lowMemory=false`），只转写当前项目用到的卡，按「连接 + 项目」记下传过的「identityKey@measuredAt」，换了连接或项目从头补传（服务端按测量时刻留最新，重复无害）。没连就不写、不报错；失败的下一拍再试。
- 采样帧数：K1 的本机记录没存它，取 `device` 串里的最少样本数 `stepN=`（16）；以后 K1 记录带上 `samples` 就用真值（建议见文末）。
- 不在编辑器进程里做，见「偏离」第 1 条。

### 3. 页面侧的共享成本记录模块（`src/editor/sharedCosts.ts`）

- `publishSharedCosts({ request, projectId, environment, records })`：分批（500 条一批）写，不抛，回 `{ ok, added, updated, ignored, envFingerprint, error? }`。
- `listSharedCosts({ request, projectId, environment })`：读本项目全部记录与本机指纹，失败抛错。
- `toSharedInput(record)`：K1 记录 → 文档服务的形状；`measuredHere(record, env)`：这条记录是不是这台浏览器测的。

### 4. 低内存档的界限搜索

- 纯逻辑 `src/render/boundarySearch.mjs`：代表耗时取中位数（偶数条取中间两条平均）、从小到大排（相同按 identityKey）；二分找第一张 `stepMs × COST_SCALE > B` 的卡；界限两侧各再测 1 张（`BOUNDARY_MARGIN`），实测与排序矛盾时以实测为准、界限挪动、同一侧接着测，多测总数至多 2 张（`BOUNDARY_EXTRA_MAX`）；没有记录的卡按重、不测；测量失败按跑不动算、不存；测量次数上界 ⌈log₂(n+1)⌉ + 2 + 2（`maxMeasurements`）。本地复用经注入的 `store.getCost(key)` / `putCost(key, rec)`，键 `localCostKey(identityKey, envFingerprint)` = `<identityKey>|<envFingerprint>`（与 C10-T 的 L2 用例同形）；缺省实现 `createMemoryCostStore()`。`classifyWithBoundary` 给搜索之后新来的卡判轻重（测过的按实测，有代表耗时的按落在界限哪一侧，没记录的算重）。
- 页面驱动 `src/editor/lowMemorySearch.ts`：取记录 → 用户卡、图卡不参加（按重）→ `boundarySearch`。测量在唯一那个舞台里做：第一次要测时把它临时 `setRole('back', { job: 'probe' })`（舞台的探针闸门只认 `back`），一次只测一个片段（缩水项目，同 `probeRunner.ts`），只走计时趟（`render(…, { probe: 'time' })`；`direct` 卡按播种的随机帧逐帧 `setTime(…, { probe: true })`），单帧耗时按 `summarizeProbe` 同一口径；测完 `setRole('front')`、整份项目重灌、调 `restore()`（`Preview` 把抑制、流平面、快照基线作废并 `stageReady + 1`，时间与投递重来一遍）。不开后台舞台。
- `Preview.tsx`：连上共享项目、项目到了（`ds.rev > 0`）、舞台就绪后，每个共享项目搜一次；之后项目变了按已有界限重判，不再测；取不到记录隔 1 秒再试。测量期间（`lowMemoryMeasuring()`）父页不投快照、不发抑制、不拨时间、不推项目。诊断 `window.__pcLowMemSearch()`。
- 界面：真要在舞台里测时盖加载遮罩 `LowMemoryGate`（与桌面 `ProbeGate` 同一套样式，文案「正在测量这台设备能流畅播放哪些卡（第 i 张，至多 N 张）」）；本地复用全命中就不盖。语义依据 `product/rendering.md`「测量」（打开项目时在加载遮罩下测，测量遮罩是唯一例外）。文案是新拟的，见「需要主会话定的事」。
- 本地复用集成时接 L2：`Preview.tsx` 导出 `setLowMemoryCostStore(store)`，传一个带 `getCost(key)` / `putCost(key, rec)` 的对象即可。

### 5. 接进分派、补渲与导出

- `planPipelines` 加 `opts.lowMemoryLight`（判轻的卡的 identityKey 集合）：给了就不看成本记录与声明，集合里的卡每个位置都判轻、不受预算挤出，其余（含没有身份的）每个位置都判重。不给新选项时桌面分支逐字段不变（CP-05）。
- `planDispatch.ts` 分两张表：
  - **显示表**（`currentPlan`，发给舞台、`snapshotFeed` 按它抑制和选帧）：低内存档仍全部判重（`allHeavy`）。语义 `product/platforms.md`：低内存档播放时只看预渲染小尺寸、不活渲，判轻的卡也一样，没有产物就占位（契约第 18 节第 8 条）。
  - **判定表**（`judgedPlan`）：低内存档按搜索结果（`setPlanLowMemoryLight`）；搜索完成前全部判重、`lowMemoryJudged()` 为假；普通档两张是同一张。
  - `setPlanAllHeavy` 改名 `setPlanLowMemory`。
- 补渲（`lowMemoryBackfill.ts` 的 `missingLayers` 加 `heavy`）：只对判定表判重、又不在层表里的层；搜索完成前一律不发。
- 导出（`originals.ts` 加 `onlyClips`，`browserExport.ts` 加 `heavyOnly`，`onlineExport.ts`）：低内存档只核对、只取判重卡的预渲染原尺寸；判轻的卡层表里有也由本机逐帧渲。普通档不变。
- C10a 过渡做法（判定也全部按重卡）退出。

### 6. 队列优先级

核对 `19c2d19` 仍成立（C10A-L17-Q1～Q6 全过）。补了三条：认领中的 backfill 被 normal 发布升档、租约过期后按 normal 重开并排在别的 backfill 前面（CQ-01）；已完成的 backfill 遇到 normal 发布不另起、发布方收到 `task.done`（CQ-02）；normal 档内整数名次高的先认、`'normal'` 与缺省算 0、backfill 在最后（CQ-03）。

### 7. 三级数字

写进 `mechanism/rendering.md`「低内存档」（余量 1 张、挪界限后至多多测 2 张、上界公式、采样口径、中位数、单舞台测量与遮罩、搜索后新卡的判法、判定只管补渲与导出；「过渡（C10a）」一条注明已退出）与 `mechanism/document-service.md`「成本记录」（「最新」口径、指纹由文档服务算、500 / 20000 / 5000、成员才能读写、持久）。协议写在 `costs.mjs` 文件头与本报告第 1 节。

## 验证

命令都在笔记本（性能基准机）上跑，worktree `.worktrees/c10-cost`。

### G0

- `npx tsc -b --force`：退出码 0。
- `npm test`（PATH 带 ffmpeg）：退出码 0；tests 3433、pass 3431、fail 0、skipped 2（`742561d`）。
- `npm run build`：退出码 0。`npx vite build --mode online`：退出码 0。

### 新单测（全部真跑，0 跳过）

| 文件 | 用例 | 结果 |
|---|---|---|
| `server/test/c10-cost-docservice.test.mjs` | CC-01～CC-09：写入与读全部（指纹由服务端算）、同键留最新与多环境、跨项目隔离、非成员拒、坏形状拒、管理身份拒、日志回放、上限、挂进组装 | 9/9 |
| `src/render/boundarySearch.test.mjs` | BS-C01～BS-C10：中位数代表、二分、余量与测量次数上界（n 取 1～257、界限取 5 种位置）、重侧矛盾挪界限、轻侧矛盾挪界限、无记录按重不测、本地复用不再测、失败按重不存、搜索后新卡的判法、去重与定序 | 10/10 |
| `src/editor/sharedCosts.test.mjs` | SC-01～SC-07：形状转换、对真的共享项目写与读、分批、被拒 / 连不上、桌面转写（只写本机测的、项目用到的；换连接补传；旧记录不盖新）、没连不写、失败重试与单飞 | 7/7 |
| `src/render/c10-cost-plan.test.mjs` | CP-01～CP-06：`lowMemoryLight`、判定表与显示表、补渲只对判重缺产物、导出只取判重卡原尺寸、普通档逐字段不变、`allHeavy` 优先 | 6/6 |
| `src/editor/lowMemorySearch.test.mjs` | LS-01～LS-05：单舞台临时切 back 测量、切回与 restore、遮罩状态、本地复用全命中不碰舞台、用户卡与无记录按重、direct 卡逐帧、取不到记录抛错、项目重灌打断重来 | 5/5 |
| `server/test/c10-cost-queue.test.mjs` | CQ-01～CQ-03 | 3/3 |

### 本机探针 `c10-cost-probe`

`node scripts/probes/c10-cost-probe.mjs --dist <在线构建>`（编辑器 5670，代理 5673，文档服务 5674，素材服务 5675），第 2 轮 `ok: true, fails: []`，45.8 s：

- 桌面版放 16 张 `probe-slow`（`burnMs` 0～40），加载遮罩下测完，桌面单帧耗时 1.8～42 ms（例：burn 21 → 23.9 ms，24 → 26.3 ms）。
- 放云端后 1.2 s 内 `SharedCostRelay` 把 16 条写进文档服务（一次写 16 条）；Node 侧成员连接 `cost.list` 核对：16 条，单帧耗时与桌面相同，指纹 `368b991065c7c541`，`mode: dev`。
- 手机仿真（412×915、`deviceMemory: 4`，判为低内存档）凭邀请链接进入：取到 16 条记录；遮罩出现过；测量 6 次（上界 ⌈log₂17⌉ + 4 = 9，log₂16 + 2 = 6），二分 4 次（第 8、12、10、9 张），余量 2 次（第 7、11 张）；界限第 9 张（代表耗时 26.3 ms，B = 23.33 ms）；手机实测 20.0 / 22.2 ms 判轻，27.2～33.0 ms 判重；burn ≤ 21 的 9 张判轻、≥ 24 的 7 张判重；补渲计划任务的片段清单正好是判重的 7 张，判轻的 0 张；播放中 4 次采样 16 层全部抑制、无活渲（判轻的 9 张占位）。手机指纹 `206526a7fb130978`。
- 第 1 轮只挂探针自身一处：「桌面测完」按空闲时长判，开测前就判了（`6bb57ca` 改为按本机记录核对）；那一轮的搜索部分同样全过（6 次、界限第 9 张）。

### 低内存档回归

- `small-tier-probe --origin http://127.0.0.1:5670`：`ok: true`；60/60 帧有 400×225 小位图，清单 `small` 表对得上，关掉小尺寸时 HTML、`index.json`、键逐字节不变。
- `lowmem-online-probe --origin http://127.0.0.1:5676 --remote-port 5679`（在线模式 dev server）：改 G3 后连跑两轮都是 `ok: true, fails: []`。G1 单舞台、低内存档；G2 小尺寸视频 3、原尺寸 0、`px/` 2、`snap/` 0；G3 播放中重卡抑制，暂停后停下追一帧 370～391 ms 画好、撤掉抑制，舞台只收到一次追一帧；G4 缺原尺寸提示「等待上传方」，到齐后导出 h264 60 帧 2.000 s + aac，用了原尺寸 2 与 `snap/` 60；`apiBlocked: []`。
  - G3 改了什么：原断言「暂停后重卡仍抑制、贴小尺寸、不追活渲」是 c10a 第 17 节之前的规则，在 `e067d0b` 上一样挂（跑过，G3 同样失败）。改为照第 17 节：播放中重卡抑制；暂停后在时限内停下追一帧，重卡画好或超时，画好的撤掉抑制、超时的维持兜底。
  - 改完的 G3 在 `e067d0b` 与本分支上都挂过：追一帧报「画好」，但重卡又回到抑制、也没有小尺寸。探针记下舞台收到的 RPC 是暂停后同一秒发了两次追一帧，后一次把前一次画好的层打断成「没画好」。`742561d` 在 `Preview` 里按「最新 setTime + 秒数」去重后两轮都过（见「偏离」第 5 条）。
  - 协调方要的「用户卡、图卡显示需要本地 PC 渲染辅助」没加进这个探针：内置卡里没有图卡，在线页面加用户卡要登记定制卡源码，超出本探针；停下时跳过这类卡由单测 C10A-L17-S3 覆盖，显示提示归 `c10-ui`（C10-A6）。判轻的卡播放时占位由 `c10-cost-probe` 与 `c10a-demo-probe` 第 2c 步核对（这个探针没有共享连接，不做界限搜索，判定表全部判重）。
- `c10a-demo-probe --local --port 5670 --proxy-port 5673 --doc-port 5674 --asset-port 5675`（`e879181`，修 `742561d` 之前），46 分钟，`ok: false`，只挂 2 项，都是同一件事：「重渲整段完成（新键下每帧两档齐全）」等 900 s 超时（300 帧里 180-239 段没出来）。其余都过：
  - 第 2 步：低内存档、一个同源舞台、播放全部抑制；停下追一帧 150 / 218 ms 画好；视频只拉小尺寸，`px/` 57、`snap/` 0。
  - 第 2c 步（新规则）：取到 1 条记录、测 1 次、轻卡判轻、判重片段 2、补渲 0 条、播放中轻卡占位。
  - 第 3 步：新键 12.3 s、新小尺寸 54.2 s；认领顺序 `NNNNNNNNBB`，新放的卡没有记录、判重、补渲排在 normal 之后。
  - 第 4 步：导出 300 帧 10.000 s + aac，`snap/` 390、素材原尺寸 5。
  - 第 5、6 步过；创建者页面意外重载 0。
  - 超时的是创建方渲染节点的本机判重重渲（normal 任务），这段路本分支没改；这一轮第 1 步就用了 19 分钟（C10a 两轮全程 14～19 分钟），同一台笔记本上另有两个子 Agent 和主会话的探针在跑。按「性能基准机」一节，这仍算挂，要在笔记本空闲时重跑判定，见「需要主会话定的事」。

### G0-R

没跑。本分支没动 `costs-store.mjs`；`pipelinePlan.mjs` 只加了低内存档选项，桌面分支路径不变（CP-05 证明不给新选项时逐字段相同）。已报主会话，主会话同意在集成分支上整体跑 G0-R。

## 偏离契约之处与理由

1. **桌面转写在页面里做，不在编辑器进程里**。任务书写「桌面编辑器进程转写：`PUT /api/data/costs` 时」。编辑器进程没有共享项目文档服务的凭证（Agent 那条要靠页面签发连接票据，`vite-plugin-ai.ts`），页面手里有；语义 `mechanism/document-service.md`「成本记录」写的是「非低内存档的页面测完卡写入」。所以由桌面页面的 `SharedCostRelay` 读 `planDispatch.currentCosts()`（K1 每写一条都并进来）转写，`costs-store.mjs` 与 `vite-plugin-costs.ts` 不动。效果相同：测完且连着共享项目就写，没连不写。另外它也补传接上共享项目之前测过的记录（不补传的话，桌面早就测完的项目永远没有共享记录）。
2. **显示表与判定表分开**。任务书写「低内存档的 `planPipelines` 由 `allHeavy` 换成界限搜索的结果」。判定确实换成了搜索结果（`judgedPlan`），但发给舞台和 `snapshotFeed` 的显示表仍全部判重：语义要求低内存档播放不活渲，判轻的卡也占位（契约第 18 节第 8 条）；要是显示表也按搜索结果，判轻的卡播放时会活渲，舞台还会给它们显示「等后台补跑」那种占位（`placeholderHost.ts` 的 T4）。
3. **搜索完成前不发补渲**。不知道谁重之前发，会给后来判轻的卡发出补渲，违反第 18 节第 8 条。代价是打开项目后晚几秒才发补渲（真要测时只多几秒）。
4. **测量期间把唯一那个舞台临时切成 `back`**。舞台的探针闸门只认 `back`，用这条路不必改 `StageView.tsx`（那是 `c10-browser` 的地盘）。测量期间父页的投递、拨时间、推项目都停着，遮罩挡住画面。
5. **顺手修了 C10a 的一处并发（`742561d`，超出任务书）**。暂停时父页对同一秒发两次停下追一帧，舞台里后一次把前一次画好的层打断，画好的层又回到抑制：用户看到的是暂停后精确画面一闪又变回占位。修法只在 `Preview.settleLowMemoryAt`：同一次 setTime 之后同一秒已经在追就不再发。协调方要求 `lowmem-online-probe` 的 G3 按第 17 节写，改完的 G3 正是被这个 bug 挡住（基线 `e067d0b` 上同样挂）。舞台一侧没改，并发的根在 `StageView.drawLowMemory`（第二次追一帧 `endCatchUp(old, false)` 会把第一次的层移出 `lowMemLive`），建议 `c10-browser` 或集成时再看要不要在舞台里也兜一道。
6. **`c10a-demo-probe` 第 2c 步按新规则改**（`e879181`）：原来断言「轻卡在创建者那边不预渲染、手机为它补渲、小尺寸回到手机、播放时贴着」，新规则下轻卡判轻不补渲，改为断言：手机取到记录、轻卡判轻、重卡片段（钉死记录没有单帧耗时、不转写，按无记录判重）判重、补渲 0 条、播放中轻卡占位。补渲整条路（发布、认领、排在 normal 之后、小尺寸回到手机）由第 3 步新放的卡覆盖：它片段长度不同、卡片身份不同，手机打开时没有它的记录，按重卡补渲。第 3、4 步断言原样不动。

## 给主会话的接线说明

- **在线普通档测完写文档服务**：`c10-browser` 在「测完写进 L2」那一处留的订阅口，接到下面二选一：
  - `publishSharedCosts({ request: docRequest, projectId: currentDocProjectId(), environment: pageEnvironment(), records: records.map((r) => toSharedInput(r)).filter(Boolean) })`（`src/editor/sharedCosts.ts`；`docRequest` 来自 `media/assetTiers.ts`，`currentDocProjectId` 来自 `sync/syncManager.ts`，`pageEnvironment` 来自 `pageEnvironment.mjs`）。只在 `currentSharedLink()` 非空时调；记录要带 `identityKey`、`stepMs`、`measuredAt`、`mode: 'build'`，最好带 `samples`。
  - 或者什么都不接：`Preview.tsx` 在非低内存档时已经起了 `SharedCostRelay`，它读 `planDispatch.currentCosts()`。只要 `c10-browser` 把 L2 里的记录喂进 `setPlanCosts` / `mergePlanCosts`，而且记录的 `device` 串照 `costDeviceString` 拼（以 UA 和 GPU 渲染器开头、`lowMemory=false`），就会自动转写。两条都接也无害（服务端按测量时刻去重）。
- **低内存档本地复用接 L2**：`import { setLowMemoryCostStore } from './editor/Preview'`，在 L2 打开后调 `setLowMemoryCostStore(l2)`（对象要有 `getCost(key)` / `putCost(key, rec)`；键形如 `<identityKey>|<envFingerprint>`，值 `{ identityKey, envFingerprint, stepMs, samples, measuredAt, mode }`）。要在第一次界限搜索之前接上，否则那一轮用页面内存。
- **会冲突的文件**：`src/editor/Preview.tsx`（新增两个 effect、三处闸门、遮罩、settle 去重）、`src/editor/planDispatch.ts`、`src/editor/lowMemoryBackfill.ts`、`src/export/{originals,browserExport,onlineExport}.ts`、`src/render/pipelinePlan.{mjs,d.mts}`、`server/docservice/shared-service.mjs`、`server/hosted/files.mjs`。

## 需要主会话定的事

1. **`c10a-demo-probe` 的重渲超时**：在笔记本空闲时重跑一轮 `--local` 判定（本分支没改渲染节点与预渲染路径；这一轮全程 46 分钟，C10a 时 14～19 分钟）。按性能基准机的规则这一项现在算挂，不自判「机器负载」豁免。
2. **遮罩文案**「正在测量这台设备能流畅播放哪些卡（第 i 张，至多 N 张）」是新拟的（语义只写了在加载遮罩下测），要不要改。
3. **`samples` 的来源**：建议 K1 记录（`probeRunner.ts`）加一个 `samples` 字段存真实采样帧数；现在转写时按 `device` 串的最少样本数 16 填。`probeRunner.ts` 归 `c10-browser` 那边，本分支没动。
4. **搜索之后的新卡**：按打开时取到的记录判，不再取、不再测。桌面随后补测了新卡、写进文档服务，手机这一次会话也不会用（要重开页面）。语义没写，按最小做；要不要定时重取记录，请定。
5. **舞台里的追一帧并发**（「偏离」第 5 条）：要不要在 `StageView` 里也兜一道。

## 仍在运行的进程

无。自己起的 dev server（5670、5676）、探针起的编辑器与预渲染子进程、托管组合、代理都已结束；`netstat` 查 5670～5679 没有监听。
