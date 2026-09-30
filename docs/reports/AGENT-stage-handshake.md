# AGENT-stage-handshake

分支 `claude/stage-handshake`(起点 main `f683de74`,0.7.8)。worktree `D:\VectorMPEG7\PromptCut\.worktrees\stage-handshake`。

任务:在线普通档(两个跨源舞台的在线浏览器模式)首次舞台握手的计时改成按舞台页面自己的加载进度算,慢网络下不再永久退回同源单舞台、从而不能当纯浏览器节点。

**需要主会话醒目知道的一条**:等待握手期间预览是空白的(截图 `s1-waiting-25s.png`)。本分支**没有**加「等待期间先用同源单舞台出画面」;舞台页加载超过约 20 秒的慢网络下,空白时长会比现在长(现在约 20 秒就退回单舞台出画面,但从此不再是双舞台)。理由与备选方案见〔裁 3〕,请主会话决定是否接受。没有改二级语义。

## 状态

完成,待主会话审查。验收各项都过(见「验证」)。

## 提交

| 提交 | 内容 |
|---|---|
| `c4ea2c29` | 文档:建本报告 |
| `ddd8bc2a` | 修复:首次握手按每台 iframe 的 `load` 起算 20 秒,另设自挂上起 2 分钟总上限;在线时后台舞台 B 等可见舞台 A 的 `load` 再挂;单测 H1～H9 |
| `57cfd902` | 探针:`scripts/probes/online-stage-handshake-probe.mjs`(S1～S3) |
| (本次) | 文档:报告写完 |

## 做了什么

- 新增 `src/online/stageHandshake.ts`(render 层,定时器可注入):`createStageHandshake({ ids, fail, ok })`,`loaded(id)` 开始或重新起算那一台的 20 秒(`STAGE_HANDSHAKE_TIMEOUT_MS`,数值不变),`ready(id)` 记握手,两台都握上就 `ok()` 并收掉全部定时器;自建起 `STAGE_HANDSHAKE_TOTAL_MS`(120 秒)仍没两台都握上就 `fail()`。退回原因写明哪台超时、哪些已握手、哪些已加载完,例如「舞台 A 加载完 20 秒没握上手(握上手的舞台:B;加载完的舞台:A、B)」。
- `src/editor/Preview.tsx`:
  - 原来那个「挂上就开 20 秒定时器」的 effect 换成上面的计时器;两个舞台 iframe 加 `onLoad` → `loaded(id)`;`pc-stage-ready` 处多调一次 `ready(id)`(原有的 `markStageHandshake("ok")` 那一行保留,重复调用无害)。
  - 诊断口 `window.__pcStageHandshake()`(阶段、每台 `loadedAt` / `readyAt` / `loads`、原因);退回后保留,供探针读。
  - 在线时后台舞台 B 等可见舞台 A 的 iframe `load` 之后才挂(〔裁 2〕);桌面照旧一起挂。
- `src/online/stageOrigins.ts`:只改了 `STAGE_HANDSHAKE_TIMEOUT_MS` 的注释(值不变)。`stageWatch.ts`(握手之后又断的看守)没动,它的重载时限仍是 `STAGE_HANDSHAKE_TIMEOUT_MS`,从重载起算。
- 新增 `src/online/stageHandshake.test.mjs`(H1～H9)与探针 `scripts/probes/online-stage-handshake-probe.mjs`。

## 〔裁〕

1. **总上限 120 秒**(三级)。依据:阿里云最慢那一档约 90 KB/s,舞台页主脚本不压缩 4.26 MB 时两台依次各约 47 秒,压缩后 1.33 MB 各约 15 秒,都落在 2 分钟里。上限压过每台的 20 秒:A 在 110 秒才 `load`,到 120 秒照样退回(H6)。
2. **在线时后台舞台 B 等 A 的 `load` 再挂**(三级)。两个舞台各在自己的源上、各下一遍主脚本,同时下载会平分带宽,A 要多等一倍。B 晚挂以后,A 先独占带宽,用户先看到画面;B 的 20 秒从 B 自己的 `load` 起算,不会因此被判超时。代价是网速正常时双舞台就绪晚一点:本机探针里 B 比 A 晚约 0.03～0.6 秒挂上(S2、S3)。A 回错误页(S2)同样会 `load`,B 照挂。
3. **等待期间不另开同源单舞台出画面**(三级;需要主会话定)。
   - 现状:等待握手时预览是空的(中灰底,截图 `s1-waiting-25s.png`)。旧代码最长空白约 20 秒,然后永久退回同源单舞台出画面。新代码的空白时长等于可见舞台 A 自己的加载时长,上限 120 秒。
   - 不做的理由:(a) 有了〔裁 2〕,A 单独下载,加载时长大致等于编辑器页刚加载同一个主脚本花的时间;网速在「单个舞台 20 秒内能下完」范围里(压缩后的 1.33 MB 要约 67 KB/s 以上),空白时长不比现在长,而且往往更短(以前两台平分带宽);(b) 只有更慢的网络(A 单独下也要 20 秒以上)空白才比现在长,而这种网络下编辑器页自己也要等同样久才打开;(c) 过渡用的同源单舞台要么是第三个舞台(`STAGE_IDS` 与 RPC、互换、看守都按 A/B 两台写),要么让 A 先同源、握上后再换到 s1 重载一次:换源那一次又要在同一条慢网络上下一遍主脚本(除非服务器上的资源缓存头能让之前的预热命中,这一点在仓库里核不到,nginx 配置不在仓库),画面还会再闪一次、项目整份重灌。慢网络下这样做会让双舞台更晚就绪,正和本任务的目的相反。
   - 如果主会话要求空白不超过现在:可选的最小方案是「挂上 20 秒 A 还没握手 → 临时同源单舞台出画面,同时隐藏预热 s1、s2 两个源的舞台页;两台都 `load` 完再换回双舞台」。前提是服务器上 `/editor/assets/` 带长缓存头(本机探针代理带 `immutable`),否则预热没有用。这不是本分支的范围,没做。

## 验证

跑测试和探针前按任务书把 ffmpeg 加进 PATH。端口只用了 6010～6014 与 6020～6024。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0,无输出 |
| 全量测试 | `npm test` | 退出码 0;tests 4177,pass 4175,fail 0,skipped 2 |
| 新单测 | `node --experimental-test-module-mocks --test src/online/stageHandshake.test.mjs` | 10/10 过(数字用例 + H1～H9) |
| 代码指纹 | `node -e 'import("./server/frame-code.mjs")…'` | `00a5264bf8a062ff6e0b5ed0516cccd1 86e443cb6fa838aef64788af6822fd68`,和要求一致 |
| 在线构建 | `npx vite build --mode online --outDir <临时目录>/dist-online` | 退出码 0 |
| 新探针 | `node scripts/probes/online-stage-handshake-probe.mjs --dist <dist-online> --out <shots>`(缺省 base-port 6010、压 40 秒) | 跑 2 遍,都是退出码 0、`ok: true`、`fails: []`(第 1 遍 S1 的「画出」时刻测法有误,改成从挂上起并行盯,第 2 遍的数字见下) |
| 老探针(看守不变) | `node scripts/probes/online-stage-watch-probe.mjs --dist <dist-online> --base-port 6020` | 跑 1 遍,退出码 0、`ok: true`;W2 重载 19.1 s、握回 19.6 s;W3 退回 34.8 s(原因「舞台 A 断开后重载,20 秒内没握回来」)、34.8 s 画回;W4 退回后 60 秒两源都没再收到舞台页请求,reloads 2→2 |

单测用例(H 是本分支单测的编号):
- H1 计时从 `load` 起算:打开 30 秒还没 `load` 不退回;`load` 后 19 秒握上 → ok,定时器全收。
- H2 慢加载:A 40 秒 `load`、1 秒后握上,B 再过 38 秒 `load`、1 秒后握上 → 不退回,双舞台。
- H3 加载完 20 秒没握上 → 退回;19.999 秒不退、20 秒退;退回后迟到的握手不改结果。
- H4 舞台源回错误页(只 `load` 不握手)→ 20 秒退回。
- H5 一直不 `load` → 120 秒退回。H6 总上限压过每台时限。H7 同一台重载(再 `load` 一次)重新起算。H8 握手早于 `load` 也算数。H9 dispose 后不报。
- 看守不变:`src/online/stageWatch.test.mjs` 等都在全量测试里照常过。

探针第 2 遍的数字(时刻都从 A 的舞台页被请求起算):
- **S1 慢加载**(两个舞台源的入口脚本各压 40 秒):25 秒时 `phase: waiting`、handshake `pending`、dual 真,B 还没被请求;A 的主脚本 40.08 s 回完,40.21 s `load`,40.23 s 握手;**40.39 s 可见舞台画出片段**;B 的舞台页 40.29 s 才被请求,80.42 s `load`,80.43 s 握手 → handshake ok、dual 真;`__pcBrowserNode()` 返回 `eligibility: { ok: true }`、`state: idle`、有 nodeId,即能当纯浏览器节点。截图:`s1-waiting-25s.png` 是空白中灰的预览,`s1-dual.png` 是握手后的画面,「金句药丸」片段画出来了。
- **S2 舞台 A 的源回 503**:错误页 0.2 s `load`,B 0.8 s 握手;**20.38 s 退回**,原因「舞台 A 加载完 20 秒没握上手(握上手的舞台:B;加载完的舞台:A、B)」;20.38 s 同源单舞台画出片段;只剩一个舞台 iframe,在编辑器页的源上。
- **S3 舞台 B 的源回 503**:A 0.24 s 握手,B 0.23 s 被请求(在 A `load` 之后);**20.36 s 退回**,原因「舞台 B 加载完 20 秒没握上手(握上手的舞台:A;…)」;20.38 s 单舞台画出片段。
- 截图在 `C:\Users\yuchiron\AppData\Local\Temp\claude\D--VectorMPEG7-PromptCut\dd19d14b-0879-42e4-b4b2-6d8f351421a8\scratchpad\shots-1`、`shots-2`(本机临时目录)。

没跑的:导出确定性、导出与快照重放一致两项没跑,因为本分支没改渲染、导出、卡片、快照,代码指纹也没变。c10、M7 系列浏览器探针没重跑:它们涉及双舞台就绪时刻,B 晚挂(〔裁 2〕)在正常网速下只晚几百毫秒,建议主会话合流时顺带跑一遍 `m7-browser-probe`。所有时限类断言都是在 PC 上跑的,按 `verification.md` 应待笔记本复核。

## 没做成的

- 等待期间用同源单舞台出画面:没做,见〔裁 3〕。

## 语义 dry run(`docs/semantics/mechanism/rendering.md` 第 14 行,三级;本分支没改语义文件)

修改前:

> - 在线普通档两个跨源舞台在 20 秒内握不上手,或握上之后某一台断开(每 5 秒问一次、15 秒没有回包算断开;页面隐藏时不判)、重载后 20 秒内握不回来,或 10 分钟里断到第 4 次,就退回同源单舞台,本页会话内不再回到双舞台,也不再重载;预览不因舞台断开而一直空白〔裁:2026-09-30 `claude/misc-maint`,出处 `docs/plan/c10-contract.md` 第 2 节「握手之后又断」〕。

修改后:

> - 在线普通档两个跨源舞台首次握不上手(某一台的页面加载完后 20 秒内没握上,或自挂上起 2 分钟两台还没都握上),或握上之后某一台断开(每 5 秒问一次、15 秒没有回包算断开;页面隐藏时不判)、重载后 20 秒内握不回来,或 10 分钟里断到第 4 次,就退回同源单舞台,本页会话内不再回到双舞台,也不再重载;预览不因舞台断开而一直空白〔裁:2026-09-30 `claude/misc-maint`,出处 `docs/plan/c10-contract.md` 第 2 节「握手之后又断」〕。首次握手的 20 秒从那一台页面加载完起算,不从挂上起算;后台舞台等可见舞台的页面加载完再挂,慢网络下可见舞台先独占带宽〔裁:2026-09-30 `claude/stage-handshake`,慢网络下舞台页光下载就超过 20 秒,被误判握手失败〕。

另建议同步:`docs/plan/c10-contract.md` 第 39 行「重载后 20 秒(与首次握手同一个时限)」后面补「首次握手的 20 秒从舞台页面加载完起算」;`src/online/stageWatch.ts` 文件头第 4 行「首次握手在 `STAGE_HANDSHAKE_TIMEOUT_MS` 内握不上」同样补一句(任务书说看守不改,所以没动它的注释)。

## 需要主会话决定的事

1. 接不接受〔裁 3〕(等待期间仍是空白,慢网络下空白比现在长);不接受的话,是否按〔裁 3〕末尾的预热方案另开任务(前提:核实阿里云 nginx 给 `/editor/assets/` 的缓存头)。
2. 接不接受〔裁 2〕(在线时 B 等 A 加载完再挂)。
3. 合并;合并前按上面的 dry run 改 `mechanism/rendering.md` 第 14 行。
4. 另一条更彻底的思路(没做,只记下):让舞台页的主脚本直接用编辑器页源上那一份(同站,HTTP 缓存能命中),舞台就几乎不用再下载。要改构建产物的脚本地址,并给 `/editor/assets/` 加 CORS 头,涉及部署,是二级范围的事。
