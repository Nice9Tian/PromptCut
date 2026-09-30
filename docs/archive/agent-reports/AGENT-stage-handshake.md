# AGENT-stage-handshake

分支 `claude/stage-handshake`(起点 main `f683de74`,0.7.8)。worktree `D:\VectorMPEG7\PromptCut\.worktrees\stage-handshake`。

任务:在线普通档(两个跨源舞台的在线浏览器模式)首次舞台握手的计时改成按舞台页面自己的加载进度算,慢网络下不再永久退回同源单舞台、从而不能当纯浏览器节点。主会话审过第一版后追加:等待期间不许比现在空白更久,要按「过渡的同源单舞台 + 隐藏预热 + 换回双舞台」做。

没有改二级语义。

## 状态

第二版完成,待主会话审查。验收各项都过(见「验证」)。

## 提交

| 提交 | 内容 |
|---|---|
| `c4ea2c29` | 文档:建本报告 |
| `ddd8bc2a` | 修复:首次握手按每台 iframe 的 `load` 起算 20 秒,另设自挂上起 2 分钟总上限;在线时后台舞台 B 等可见舞台 A 的 `load` 再挂;单测 H1～H9 |
| `57cfd902` | 探针:`scripts/probes/online-stage-handshake-probe.mjs`(S1～S3) |
| `f8f1b0ed` | 文档:第一版报告 |
| `2815c853` | 修复:首次握手过渡期(20 秒没握上先出同源单舞台画面、跨源两台改作隐藏预热、握上后原元素接任换回双舞台、盖板衔接、只换一次、总上限到点留在单舞台);单测 H10～H15;探针加 S4、S1 改按过渡期断言 |
| (本次) | 文档:报告改写成第二版 |

## 做了什么

### 计时(`src/online/stageHandshake.ts`,render 层,定时器可注入)

- 每台舞台的 20 秒(`STAGE_HANDSHAKE_TIMEOUT_MS`,数值不变)从那一台 iframe 的 `load` 起算;同一台再 `load` 一次就重新起算。
- 自挂上起 `STAGE_HANDSHAKE_TOTAL_MS`(120 秒)仍没两台都握上 → `fail`。
- **过渡期**:自挂上起 `STAGE_INTERIM_AFTER_MS`(20 秒)可见舞台 A 还没握上 → 报 `interim`。过渡期里计时照旧进行(预热的那两台照样报 `loaded` / `ready`):两台都握上 → `ok`(换回双舞台);某台加载完 20 秒没握上,或到总上限 → `fail`(留在单舞台)。
- 退回原因写明哪台超时、哪些已握手、哪些已加载完。

### 状态(`src/online/stageOrigins.ts`)

- `Handshake` 加 `interim`:`stageLayout` 在 `interim` 时回单舞台(和退回单舞台同一条路)。
- `markStageHandshake("interim")` 只能从 `pending` 进;换回之后(`ok`)或退回之后(`failed`)都进不了过渡期。所以只换一次:换回后再出问题照「握手之后又断」的看守走 `failed`,不再来回切。
- 状态里加 `interimAt`(进过渡期的时刻),Preview 据此做换回那一下的画面衔接。

### 页面(`src/editor/Preview.tsx`、`src/editor/previewMode.ts`)

- `previewMode.ts`:新增 `interimStage()`(过渡期);`stageSrc(id, { dual })` 可以指定按双舞台或单舞台的形状给地址。
- 舞台 iframe 改成按槽位挂,槽位顺序固定、按槽位作 key:`single`(同源单舞台)、`dualA`、`dualB`(跨源的 A、B)。
  - 等握手时:`dualA`、`dualB`。
  - 过渡期:`single` 当可见舞台 A(同源,走编辑器页自己的源,主脚本已在缓存里,马上出画面);`dualA`、`dualB` 改作隐藏的预热 iframe(`opacity: 0`、挡指针、不建 RPC),原来的下载不中断。B 仍等 A 的 `load` 再挂。
  - 换回双舞台:`dualA`、`dualB` 还是同一个元素。key 和先后顺序都不变,React 不会挪动它,iframe 不重新加载,直接接任 A、B。页面照它们预热时发来的 `pc-stage-ready`(按窗口记在 `readyByWinRef`)补一遍握手:建 RPC、定角色、灌项目、登记看守。
  - `single` 留作盖板,见〔裁 4〕。
  - 退回单舞台:只剩 `single`。
- 握手处理本体抽成 `processReadyRef`,消息与补握手共用;过渡期里同源单舞台的握手不记进首次握手计时。
- 首次握手计时的 effect 跟着「双舞台或过渡期」走:跨过「双舞台 → 过渡期 → 换回」时不重建。
- 诊断:`window.__pcStageHandshake()`(阶段、`interimAt`、每台时刻)、`__pcPreviewDiag().handover`(盖板因为什么、多久撤下)。
- `stageWatch.ts`(握手之后又断的看守)没动。

### 长缓存的前提

- 线上已有:主会话核实 `https://8-219-80-16.sslip.io/editor/assets/index-*.js` 回 `Cache-Control: public, max-age=31536000, immutable`。
- 本机探针代理给 `/editor/assets/` 回同样的头(原来就有)。
- 另外,因为预热 iframe 就是原来那个元素、下载没断,换回时跨源舞台页各只请求一次(探针核了),所以换回本身并不依赖缓存命中。缓存只影响过渡期里同源单舞台的加载速度。

## 〔裁〕

1. **总上限 120 秒**(三级,主会话已认可)。
2. **在线时后台舞台 B 等 A 的 `load` 再挂**(三级,主会话已认可)。过渡期里预热的 B 也照此办。
3. **过渡期从挂上 20 秒起、条件是「A 还没握上」**(三级)。
   - 20 秒是原来退回单舞台的时刻,所以等待期间的空白不比原来长。
   - A 已 `load` 但还没握上的也进过渡期,先出画面;若 A 真坏了,20 秒后按「加载完 20 秒没握上」失败,留在单舞台。
   - A 在第 20 秒前后恰好握上的,会进过渡期又马上换回,仍只换一次。
4. **换回那一下的画面衔接**(三级)。
   - 做法:同源单舞台不拆,改作盖板(停在最后一帧,不连 RPC,挡指针);新的可见舞台 A 先保持 `opacity: 0` 在底下画。等它第一次 `setTime` 回包(已按新项目落好当前帧)后再过 `STAGE_HANDOVER_SETTLE_MS`(150 ms),或播放中报来第一拍,再一次撤盖板、露出新舞台。最多等 `STAGE_HANDOVER_MAX_MS`(3 秒)。
   - 实测:探针两次换回都由 `setTime` 触发,盖板在约 200 ms 后撤下;出画面之后每 100 ms 采样,最长空白 120 ms(S4)、300 ms(S1),都是采样间隔量级,没看到闪白。
   - 已知代价:如果换回时正在播放,盖板那几百毫秒是定格画面。
5. **过渡期的计时若被打断**(例如过渡期中改判低内存档):计时器按失败收场,留在单舞台。这是兜底,正常流程走不到。

## 验证

跑测试和探针前按任务书把 ffmpeg 加进 PATH。端口只用了 6010～6014、6020～6024。在线构建用 `npx vite build --mode online --outDir <临时目录>/dist-online`,退出码 0。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,无输出 |
| 全量测试 | `npm test` | 退出码 0;tests 4184,pass 4182,fail 0,skipped 2 |
| 握手相关单测 | `node --test src/online/stageHandshake.test.mjs src/online/stageOrigins.test.mjs src/online/stageWatch.test.mjs` | 30/30 过 |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`,不变 |
| 新探针(全部 4 个场景) | `node scripts/probes/online-stage-handshake-probe.mjs --dist <dist-online> --out <shots-4>` | 退出码 0、`ok: true`、`fails: []`,跑 1 遍。S4 单独还跑过 1 遍(退出码 0,`ok: true`) |
| 老探针(看守不变) | `node scripts/probes/online-stage-watch-probe.mjs --dist <dist-online> --base-port 6020` | 第二版代码上跑 1 遍:退出码 0、`ok: true`;W2 重载 19.0 s、握回 19.5 s;W3 34.9 s 退回(原因「舞台 A 断开后重载,20 秒内没握回来」)、34.9 s 画回;W4 退回后 60 秒两源没再收到舞台页请求,reloads 2→2 |

单测(H 是本分支单测的编号):
- H1～H9(第一版,没给 `interim` 回调时的行为):计时从 `load` 起算;40 秒才 `load` 不退回;加载完 20 秒没握上退回;错误页 20 秒退回;120 秒总上限;总上限压过每台时限;重载重新起算;握手早于 `load`;dispose 后不报。
- 过渡期:
  - H10 A 20 秒没握上 → `interim`、布局单舞台、不算失败。
  - H11 预热完成(A 40 秒 `load` 并握上、B 随后握上)→ `ok`、布局双舞台;之后总上限不再起作用。
  - H12 只换一次:`ok` 之后 `interim` 不生效;看守判 `failed` 后 `interim`、`ok` 都不生效。
  - H13 总上限到点预热还没好 → `failed`、留在单舞台;迟到的预热握手不换回。
  - H14 A 20 秒内握上 → 不进过渡期。
  - H15 过渡期里预热的舞台加载完 20 秒没握上 → `failed`。
- 另有两条数字用例(20 秒、2 分钟)。

探针数字(时刻都从 A 的舞台页被请求起算,全量那一遍):
- **S4:只压 A 的主脚本 40 秒**
  - 20.00 s 进过渡期,20.19 s 同源单舞台画出片段。
  - A 40.24 s `load`、40.27 s 握上;B 随后挂,40.58 s 握上。
  - 换回双舞台,盖板因 `setTime` 在 201 ms 后撤下,跨源 A 画出片段。
  - 出画面后最长空白 120 ms。跨源舞台页 A、B、同源各只请求 1 次。
  - `__pcBrowserNode()` 返回 `eligibility.ok: true`。
- **S1:两台各压 40 秒**
  - 20.00 s 进过渡期,20.34 s 出画面。
  - A 40.39 s 握上,B 80.77 s 握上;81.0 s 换回,盖板 214 ms 撤下。
  - 最长空白 300 ms;各只请求 1 次;资格恢复。
- **S2:A 的源回 503**:先进过渡期出画面,20.21 s 失败,原因「舞台 A 加载完 20 秒没握上手(握上手的舞台:B;…)」;20.25 s 同源单舞台画出片段;只剩一个舞台 iframe,在编辑器页的源上。
- **S3:B 的源回 503**:A 已握上,不进过渡期;20.45 s 失败,原因「舞台 B 加载完 20 秒没握上手(握上手的舞台:A;…)」;20.46 s 出画面。
- **看过的图**(`shots-4`):`s4-interim-25s.png` 是过渡期里同源单舞台画的片段(不再是空白中灰);`s4-dual.png` 是换回双舞台后跨源舞台画的同一画面。截图在本机临时目录 `C:\Users\yuchiron\AppData\Local\Temp\claude\D--VectorMPEG7-PromptCut\dd19d14b-0879-42e4-b4b2-6d8f351421a8\scratchpad\shots-4`。

没跑的:
- 导出确定性、导出与快照重放一致:本分支没改渲染、导出、卡片、快照,代码指纹也没变。
- c10、M7 系列浏览器探针没重跑,建议合流时顺带跑 `m7-browser-probe`。
- 时限类断言都在 PC 上跑,按 `verification.md` 待笔记本复核。

## 没做成的

无。

## 语义 dry run(`docs/semantics/mechanism/rendering.md` 第 14 行,三级;本分支没改语义文件)

修改前:

> - 在线普通档两个跨源舞台在 20 秒内握不上手,或握上之后某一台断开(每 5 秒问一次、15 秒没有回包算断开;页面隐藏时不判)、重载后 20 秒内握不回来,或 10 分钟里断到第 4 次,就退回同源单舞台,本页会话内不再回到双舞台,也不再重载;预览不因舞台断开而一直空白〔裁:2026-09-30 `claude/misc-maint`,出处 `docs/plan/c10-contract.md` 第 2 节「握手之后又断」〕。

修改后:

> - 在线普通档两个跨源舞台首次握手:每一台从自己的页面加载完起 20 秒内要握上;可见舞台挂上 20 秒还没握上,先用同源单舞台出画面,两个跨源舞台在隐藏处接着加载,两台都握上后换回双舞台(只换一次,换回时新的可见舞台画好当前帧再露出来);某一台加载完 20 秒没握上,或自挂上起 2 分钟两台还没都握上,就留在同源单舞台。后台舞台等可见舞台的页面加载完再挂〔裁:2026-09-30 `claude/stage-handshake`,慢网络下舞台页光下载就超过 20 秒,被误判握手失败〕。
> - 握上之后某一台断开(每 5 秒问一次、15 秒没有回包算断开;页面隐藏时不判)、重载后 20 秒内握不回来,或 10 分钟里断到第 4 次,就退回同源单舞台,本页会话内不再回到双舞台,也不再重载;预览不因舞台断开而一直空白〔裁:2026-09-30 `claude/misc-maint`,出处 `docs/plan/c10-contract.md` 第 2 节「握手之后又断」〕。

另建议同步:
- `docs/plan/c10-contract.md` 第 38 行「舞台握手失败时退回……同源单舞台」后面补过渡期一句,第 39 行「重载后 20 秒(与首次握手同一个时限)」补「首次握手的 20 秒从舞台页面加载完起算」。
- `src/online/stageWatch.ts` 文件头第 4 行同样补一句(任务书说看守不改,所以没动它的注释)。

## 需要主会话决定的事

1. 审〔裁 3〕〔裁 4〕〔裁 5〕。
2. 合并;合并前按上面的 dry run 改 `mechanism/rendering.md` 第 14 行。
3. 更彻底的思路(没做,只记下):让舞台页的主脚本直接用编辑器页源上那一份(同站,HTTP 缓存能命中),舞台就几乎不用再下载。这要改构建产物的脚本地址,并给 `/editor/assets/` 加 CORS 头,涉及部署。

## 主会话审查（2026-09-30，笔记本主会话）

- 起因是 0.7.8 的阿里云真机路径探针失败（慢网络下两个舞台首次握手 20 秒超时、永久单舞台、当不了节点）。第一版等待期间预览空白、网慢时比原来长，主会话不接受（「不许开不出画面」），要求改成 20 秒没握上先用同源单舞台出画面、隐藏预热、握上后换回双舞台，已做。〔裁〕1～5 照留，待用户审。
- 采纳语义 dry run：`mechanism/rendering.md` 原第 14 行拆成「首次握手」「握上之后又断」两条（三级〔裁〕）。报告建议的两处注释（`c10-contract.md` 第 39 行、`stageWatch.ts` 文件头）随后顺手改。
- 主会话在 `claude/r9-merge` 上重跑整套，`online-stage-handshake-probe` 与 M7 本机等见 `docs/reports/REPORT-post-M8.md` 第 9 轮。合入 main `b543b88e`。
