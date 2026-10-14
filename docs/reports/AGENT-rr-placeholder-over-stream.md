# rr-placeholder-over-stream

修一个产品问题:轨道流已经在画的时候,占位符还盖在上面(`online-stream-play-probe` 的 S6,组流起播那一项)。

## 复现到的原因

改之前在本分支(= main)上跑 `online-stream-play-probe`,退出码 1,只有 S6「没有显示占位符」不过:t=0.833～1.0 的 5 个样本里两张卡的占位符槽都显示着,槽上的 `data-pc-placeholder-reason` 都是 `awaiting`,没有快照。

也就是 `src/render/placeholderHost.ts` 的 `placeholderWanted` 里 T2(「这一帧快照还没到」,`.pc-awaiting`)那一行:它对 `awaiting` 里的每张卡无条件写上 `awaiting`,不看 `streamShowing`。T1(被抑制)那一支早就看流在不在画,所以两张卡先被 T1 放过,又被 T2 加回来;直到舞台 500 毫秒兜底把 `awaiting` 清空才撤。

## 改法

`placeholderWanted` 的 T2 加一个条件:这张卡在 `streamShowing` 里就不显示。`streamShowing` 是 `StreamPlayer.showingClips()`:预算以内的每条轨道(单卡流、组流、依赖下层的流)只要有画面(`lastDrawn` 不为空,留着上一张的那一段也算;到时清空后才不算)就把它的每个成员列进去。超出预算而不发流的层没有轨道、不在里面,照旧显示,位置照清单的矩形(没动 `geometryFor`、`keepTopOfGroups`)。

桌面版和在线页面的舞台是同一份 `StageView.tsx`,都经 `refreshPlaceholders` → `placeholderWanted`,只有这一处判据,一处改了两边都对。T3(不可见地追帧)在 `StageView.tsx` 里本来就按流在不在画筛过,没动。

探针 `online-stream-play-probe.mjs`:采样里多记一项占位原因(`reason`),S6 失败详情带上它;断言没动。

## 单测

`src/render/placeholderHost.test.mjs` 新增一条:流在画(组流的两个成员)不显示;只有一张的流在画时另一张照旧显示;流没画、快照没到显示 `awaiting`;超出预算的层(不在 `streamShowing` 里)显示,同组只留最上面一张。

## 验证

各跑一遍(端口 27500～27539):

| 项 | 退出码 | 关键行 |
|---|---|---|
| `online-stream-play-probe --base-port 27500`(改前) | 1 | 只有 S6 不过,5 个样本 `aWhy/bWhy: awaiting` |
| 同上(改后) | 0 | `fails: []`(S6 在内) |
| `stream-budget-probe --port 27510 --host-port 27515` | 0 | `fails: []`、`ok: true`(超预算的占位符与位置的断言都在里面) |
| `stream-scrub-stage-probe --port 27520 --host-port 27525` | 0 | `fails: []`、PASS |
| `stream-below-stage-probe --port 27530 …`(缺省场景) | 0 | `fails: []`、PASS |
| `git merge main` | 0 | Already up to date(main@3f3f81a5) |
| `npx tsc -b --force` | 0 | 零错误 |
| `npm test`(设好两个账号环境变量,一遍) | 0 | 6958 条:过 6942,失败 0,跳过 15,待办 1;没有偶发 |
| `card-source-version-compare --base main` | 0 | 源码版本变 10 项(丙组那几张卡的闭包),身份 0 变 |
| `card-table-digest-compare --expect ,` | 报 6 张 | focus-card、lottie、particles、probe-slow、probe-slow-stepped、terminal-3d:能力表、注册表定义都同,只有源码版本变(「键(定源码)同」) |

键:变的就是丙组那 6 张(`placeholderHost.ts` 在它们的源码闭包里),属预期;别的卡没变。没碰导出,`verify-determinism`、`verify-unified-frames` 按派活指令没跑。探针前后查过,没有新冒出的可见窗口,端口段里没有残留的监听。

## 没做成的

无。

## 对任务书或语义的更正建议

无。`mechanism/rendering.md` 的兜底顺序本来就是这个意思,代码照它改。没有裁定。
