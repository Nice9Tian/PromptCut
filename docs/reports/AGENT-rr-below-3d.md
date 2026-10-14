# AGENT 报告：rr-below-3d（依赖下层、外框又用了三维变形的卡产轨道流）

任务书 `docs/plan/render-refactor-task.md`「戊二」剩下的一小项。分支 `claude/rr-below-3d`，从 main db68b916 分出。

## 状态

做成了。带三维外框的毛玻璃卡压在会动的卡和视频上：舞台贴流的画面和导出页同一帧，在这条流收紧的那块区域（就是带三维的那一块）里平均差 2.37（满分 255），84 帧里 84 帧最像的都是同一帧；对前后帧里最像的那一帧是 5.85。同一支探针里不带三维的场景甲是 1.96。

## 1. 做了什么

决定（主会话按建议的「甲」定，二级〔裁〕，用户可以推翻）：给这种卡产**带着三维变形的舞台坐标流**，贴的时候平面照普通的依赖下层的流挂在舞台根下，不再做变形。

改动只有一处规则，别的都是核对：

- `server/frame-stream.mjs`：`BELOW_STREAM_RULES.frame3d` 由 `false` 改成 `true`。`belowStreamEligible` 里独立卡改成一律不进（原来写的是「带三维的独立卡在放宽后走这条路」，那是「单独成流」出现之前留的口子；现在带三维的独立卡归 `soloStreamKind` 的 `spatial`，流里是变形之前的画面。计划里本来就先把它挑走，这里只是让判据自己也说得对）。注释跟着改。
- `src/export/text.ts`：`no-stream` 那句原因由「这张卡片的画面依赖下面的层、外框又用了三维变形，暂时不能单独渲染」改成「这张卡片暂时不能单独渲染」〔裁，文案是草稿〕。这种卡现在有流的形状，不会再落到这个原因；原因码本身留着（别的情形下一张卡在计划里而出不了任何一种流时还会用到，例如算不出键）。
- 没有加版本号：这种卡以前一条流都没有，不存在「旧办法产的分段被新读法拿去贴」。`STREAM_CODE_VERSION`、`BELOW_STREAM_VERSION`、`STREAM_INPUT_SIG_VERSION` 都没动。
- 十个不许改的文件没碰。`src/` 下只改了 `src/export/text.ts` 一行。

## 2. 整条链逐环核对

| 环节 | 结论 | 依据 |
|---|---|---|
| 计划 | 出一条 `kind: below`、`plane: stage`、整个画面为上界的流，不带 `solo`；占一个解码器名额、不参加组流合并；别的流的键和形状不受它带不带三维影响 | 单测 `BL-3d`、`BL-plan`、`SS-below` |
| 键 | 三维那几项在目标卡的缓存内容键里（`server/card-cache.mjs` 的 `appearance.frame` 是整个框），项目的透视 `camera3dFov` 在流键的 `stage` 里。改 `rotateY`、`rotateX`、`translateZ`、`camera3dFov` 任一项键都变 | 单测 `BL-3d`；探针丁第 F 条键由 `0b886f22a682` 变成 `30439ffcfbe2` |
| 输入签名 | `streamInputSig` 的依赖下层那一支带目标卡的整个 `frame`，片段签名带 `camera3dFov`。改任一项签名变，旧流带的签名判过期，父页当场不贴 | 单测 `BL-3d`（四项逐项）；探针丁第 F 条 `staleOld: true` |
| 隔离工程 | 目标卡的框原样保留（三维都在），不像单独成流的三维独立卡那样只留位置和宽高 | 单测 `BL-3d` |
| 差分取层 | 成立。两张都是整幅截图逐像素算，不看卡摆成什么样；藏目标卡压的是包裹层里 `[data-pc-native-layer]` 的不透明度，包裹层的三维矩阵不受影响。每个分段第一帧的两条自检（藏着连截两张相同、撤掉以后和上张相同）全过：12 次实测，`failed: null` | 探针丁 `stream.capture` |
| 收紧矩形、位置矩形 | 按那一层不透明的像素量，所以量到的就是投影以后的那一块：丁是 `{x:84,y:171,w:290,h:204}`；满密度那一趟目标卡改到矩形外面 0 次 | 探针丁 |
| 毛玻璃外框的掩码 | **带三维时不收**（`capture-below.mjs` 的 `axisAligned` 只认平面里不旋转的矩阵，包裹层是 `matrix3d` 就不算；投影以后外框也不是圆角矩形）。玻璃那一块照最小不透明度算，盖回同一份下层仍然等于原画面。丁 90 帧里掩码帧 0，甲 90 帧里 90。代价见第 5 节 | 探针丁、甲的 `glassFrames` |
| 发层 | 带 `streamKind: "below"` 和这一版项目的 `inputSig` | 单测 `BL-3d`；探针丁第 0 条 |
| 舞台贴回 | 平面的画布在舞台根 `.pc-stage` 下，透视挂在里面那一层（`Stage.tsx` 的 AnimClock），平面不是它的子元素，而且自己没有变形：计算样式 `transform: none`，屏幕上的框和样式里的框相同。包裹层是 `matrix3d(…)`、子树藏着。舞台没有 `preserve-3d`，层序照 `zIndex`，平面和这张卡那一层相同；压在上面的药丸那一块对导出页同一帧 2.65，没有对不上的帧 | 探针丁第 B、C 条 |
| 清单计划那条路 | 切分方按自己的指纹出这一条，任务带 `requires.belowDependent`，浏览器那一份不出 | 单测 `BL-list` |
| 在线页面读取（「下层四」） | 读的一侧没有任何按三维挡的地方：`src/online/`、`src/editor/snapshotFeed.ts`、`src/render/streamPlayer.ts` 里搜 `rotateX`、`frame3d` 只有 `pageStreamPlan.ts`（页面自己产不产，这种卡本来就因为「不是独立卡」不产）。层表那一行和平面的依赖下层的流同一种形状。没有另跑在线探针 | 读代码 |
| 导出位图（在线导出） | `exportStreamSpecs` 用同一个 `planStreams`，现在对这种卡回一条依赖下层的流的计划，`exportSpecOf` 认 `kind: below`；渲的是同一套差分取层；页面贴的时候（`src/export/frameCompositor.ts` 的 `stage` 那一支）图放在包裹层后面、同一个父元素，不带变形。所以能渲，`no-stream` 不再对它出现。**没有端到端跑**（要现成的在线构建，不在这次点名的验证里） | 读代码 |

「没接输入、审阅表没覆盖到的卡又带三维外框」走同一条路（单测 `BL-3d` 里的 `user-glass`、`BL-eligible` 的 `unknown`）。接了输入的素材效果卡照旧单独成流（`soloStreamKind` 先挑走，`source-stream.test.mjs` 全过，没改它的判据）。

## 3. 跟着改的断言

| 文件 | 改了什么 |
|---|---|
| `server/test/below-stream.test.mjs` `BL-eligible` | 「框用了三维的照旧不进」改成进；加未知又带三维的进、带三维的独立卡不进；`BELOW_STREAM_RULES` 钉成 `{ sourceDependent: false, frame3d: true }`；「放宽后三维独立卡走这条路」改成「怎么设都不进」，另加「把 `frame3d` 关掉就不进」 |
| 同上 `BL-plan` | 夹具里那张带三维的 `tilt`（odometer）现在出流：两处期望的列表各多一个 `tilt` |
| 同上 `BL-list` | 「清单里有它也不出」改成出一条 `below`、`stage`、切分方自己的一份、任务带 `belowDependent` |
| 同上 新加 `BL-3d` | 计划形状、不带 `solo`、别的流不受影响、改 `rotateY` / `rotateX` / `translateZ` / `camera3dFov` 各一次键和签名都变且旧签名判过期、上面的层改了不变、发层、隔离工程的框原样、用户卡同样、带三维的独立卡仍是 `spatial` |
| `server/test/source-stream.test.mjs` `SS-below` | 计划列表多一条 `below:glass3`（按画家顺序排在 `below:gen` 前面）；「现在没有流」改成「一条依赖下层的流，不是单独成流」。`SS-plan` 只改了用例名（它关着依赖下层的流，断言没动） |

## 4. 验证结果

见文末「验证记录」。

## 5. 没做成的、没验的、要注意的

1. **带三维的毛玻璃没有外框掩码。** 流里玻璃那一块的不透明度是「最小值」，跟着下层的细节起伏。贴回舞台时下层和产流时完全一样就没有差别（探针里下层是各自的流和现放的视频，差 2.37）；下层要是差半帧（活渲的卡追帧的那一小段），下层的清晰细节会从玻璃里透出一点，比平面的毛玻璃卡更明显。要补就得把投影以后的四边形画成掩码（`glassMask` 现在只会画圆角矩形），这次没做。
2. 在线导出对这种卡的导出位图、在线页面读取，都只读了代码，没有端到端跑。
3. `below-paste-editor-probe`（真编辑器里的父页那一侧）没有加带三维的场景：父页按签名撤旧流的代码不分带不带三维，这次由单测和探针丁第 F 条的签名核对盖住。
4. `server/frame-pipeline.mjs` 第 3292 行附近 `exportStreamSpecs` 的注释还举着「依赖下层又带三维外框」当 `no-stream` 的例子，已经过时。没改：那份文件算进代码版本，改一个字别的会话正在跑的在线构建探针会被拒。主会话合入时顺手改。
5. 看到一处和本任务无关的现状：`src/online/pageStreamPlan.ts` 算解码器预算时 `fixed` 只收单独成流的两类卡，没有收依赖下层的流（服务端 `planStreams` 是两样都收）。同屏超过 6 条流又有依赖下层的卡时，页面和切分方对「哪几张并进组流」可能说不到一起。没有验证，没有动，只记一笔。

## 6. 〔裁〕

1. 〔裁 1，二级，主会话 2026-10-14 定〕依赖下层（或没审阅过又没接输入）而外框又用了三维变形的卡产带着三维的舞台坐标流。后果：改三维角度流要重产（独立的三维外框卡不用）。
2. 〔裁 2，文案〕`no-stream` 的提示改成不点名这种卡的一句。

## 7. 对任务书或语义的更正建议

- `docs/semantics/mechanism/rendering.md` 第 108 行附近、`docs/plan/prerender-products-contract.md` 第 232 行、`docs/plan/handoff-render-018.md` 第 26 行：「依赖下层又带三维外框的卡仍然没有流（`BELOW_STREAM_RULES.frame3d` 为 `false`，打开与否待用户定）」改成「出依赖下层的流，三维摆放画进流里，贴的时候平面不再变形；改三维角度要重产；带三维时毛玻璃外框不进掩码」。
- `docs/plan/html-snapshot-removal-dryrun.md` 第 0 节第 7 条如果还写着这一类待定，同样改。

## 验证记录

全部在最后的代码上跑（`main` 就是分出来时的 db68b916，`git merge main` 没有东西可并）。端口只用了 27300～27322。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 全量测试 | `npm test`（一遍） | 退出码 0；6910 条，通过 6894，失败 0，跳过 15，另 1 条是仓库里本来就标成「现状不成立」的待办（`accept-018-rest-ssr-seam` 的 SEAM-2）；没有偶发失败，没有单独重跑 |
| 探针：三维场景 | `node scripts/probes/stream-below-stage-probe.mjs --port 27300 --host-port 27310 --media-port 27311 --scenes d,a` | 退出码 0，`PASS`。丁（三维）：对导出同一帧平均差 2.37，对前后帧里最像的 5.85，84 帧里对错帧 0；拖动停住画的是最后一帧（2.26）；播放 22 拍全是满密度；改三维角度（`rotateY` 18→30、`rotateX` -8→6）：旧签名判过期、键变、旧键不再发、新流 11.6 秒产出，贴新流对新角度的导出页 2.07～2.66，对旧角度的导出页 24.2～27.6；互换那一下空 0 毫秒（对照 151 毫秒）。甲：1.96，对错帧 0 |
| 同一支探针其余场景 | 同上 `--scenes b,u` | 退出码 0，`PASS`。乙 1.13、丙 2.55，对错帧都是 0 |
| `below-late-lower-probe` | `--port 27300` | 退出码 0，`PASS` |
| `stream-source-probe` | `--port 27300 --host-port 27310` | 退出码 0，`PASS` |
| 导出确定性 | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:27320/?export=1"` | 退出码 0，1800 帧相同 1800、不同 0 |
| 导出与重放一致 | `PC_FRAME_TEST_URL=http://127.0.0.1:27320 PC_FRAME_MEDIA_DIR=<那台服务器的素材目录> node scripts/verify-unified-frames.mjs` | 退出码 0，`PASS` |
| 两支键的比对 | `node scripts/probes/card-source-version-compare.mjs --base main`；`node scripts/probes/card-table-digest-compare.mjs --expect ,` | 都是退出码 0；88 个入口变 0，61 个身份变 0；101 张内置卡变 0 张 |

说明两处：

- 探针丁第一遍有 1 条不过，是我新加的那条核对自己写错了（到流平面的父元素上找透视；透视其实挂在包裹层的父元素上，流平面不是它的子元素）。改了核对重跑全过，产品代码没有因此改动。
- 第一遍跑 `verify-unified-frames` 的小脚本自己崩了（引入探针公用模块时环境变量被摘掉，路径成了空的），没有跑到被测代码；改了脚本重跑通过。脚本在 `out/` 下，不入库。

看过的图：`out/rr3d/d1/d-stage-47.png`（舞台贴流）和 `d-export-47.png`（导出页同一帧）——斜着的毛玻璃牌子位置、透视、里面的字、压在上面的药丸都对得上，肉眼看不出差别。

键：卡片的键 0 张变。流的键：已有的流都不变；新出现的只有这种卡各一条依赖下层的流。例外同「下层三」报告写过的那一种：这种卡现在占一个解码器名额，把同屏的流顶过 6 条时，旁边的独立卡会从单卡流换成组流的键。

收尾：自己起的开发服务器、无头浏览器都按进程号收掉了；交活时 27300～27339 没有监听，没有新冒出来的可见窗口。

## 提交

- 125dbe5f 报告：开工
- ccd1083d 流：规则打开，单测跟着改，导出那句原因改掉
- （其后一条）测试：`BL-plan` 跟着规则改
- （其后一条）探针：`stream-below-stage-probe` 加场景丁
- 最后一条：报告
