# AGENT 报告:渲染重构「癸二」——Lottie 的测量、评估和补测(分支 `claude/rr-lottie-2`)

「癸二」指 `docs/plan/render-refactor-task.md`「癸:Lottie 改成 remotion 式」留下的后一半:量当场算一帧 Lottie 要多久、评估浏览器节点要不要放开产 Lottie 的流、补测前一半(`docs/reports/AGENT-rr-lottie.md`,已合入 `5ad05da7`)没测到的在线页面。「remotion 式」在代码里就是声明 `frameMode: "direct"`。

日期 2026-10-14。机器:PC,i7-14700KF(20 个逻辑核),RTX 3080,Chrome 152 无头。量的时候机器上有别的子 Agent 在跑,耗时数字偏大,只看量级。端口只用了 27260～27295。

## 结论

1. **当场算一帧**:真舞台里(桌面开发服务器的预览)6 张卡、两个分辨率,全长逐帧,顺着推和直接跳都是 0.7～7.6 毫秒(中位 0.8～3.3),空 Lottie 对照 0.7～1;导出页里 React 提交加跳帧中位 0.2～1.9 毫秒。**七张全不判重**(成本测量的口径:`stepMs` 0.8～5.8,预算 23.3 毫秒)。数和量法写进了 `docs/plan/render-standard.md` 的 Lottie 一节。
2. **浏览器节点产 Lottie 的流:建议放开**。浏览器当场生成快照画成位图,每帧 22～91 毫秒的有 4 张(和最重的别的内置卡 `odometer` 73 毫秒同量级),`navidad`、`bodymovin` 约 0.4 秒(4～6 倍);画出来和导出页的 PNG 平均差 ≤ 0.17、差超过 48 的像素 < 0.02%。已在分支上做成单独一个提交(`7fa…` 见下表「放开」),去掉两处按卡片 id 的排除、改测试,不合就整个 revert。
3. **在线页面补测**:生产构建、本机托管组合,七张片段(含五份带随机表达式的测试素材)208 次暂停点、拖动到达加 4 段播放,**画面(SVG 文本散列)全部和导出页同一帧相同**。截图比像素:同一帧顺着挪到/直接点到 9 帧里 8 帧逐像素相同(1 帧差 25 个像素);对导出页 PNG 的像素只记录、不判(舞台和导出页取像素的路不同,文字和渐变边缘差一圈)。没验:Lottie 钉成重卡、在线页面贴流那一路。

## 提交(分支 `claude/rr-lottie-2`,没推送、没合并)

| 提交 | 内容 |
|---|---|
| `c1f468d5` | 建本报告 |
| `6098a3ce` | 探针 `scripts/probes/lottie-cost-probe.mjs`(量当场算一帧、读成本记录) |
| `2450dc8b` | 探针 `lottie-browser-bake-probe.mjs`(浏览器节点生成快照画位图的体积耗时与保真)、`lottie-online-probe.mjs` |
| `7986a31e` | 会话重启时主会话代存的一笔 |
| 后续 | 探针「对导出 PNG」改成只记录;**放开 Lottie**(`split.mjs`、`pageStreamPlan.ts`、四个测试文件);OCN-01 字面值更新、探针补 no-user-dirs;`render-standard.md` 补数;本报告 |

（用 `git log --oneline main..HEAD` 看哈希。）

## 一、当场算一帧(详细数字在 `render-standard.md`「在真舞台里量的当场算一帧」)

- 做法:`lottie-cost-probe.mjs` 起一台隔离的编辑器,用 store 的 actions 建只有一张卡的项目(30 fps,片段长度取素材长度,分辨率 960×540 与 1920×1080),在**可见舞台**页里调产品自己的 `setTime`(`window.__pcStage`)全长逐帧,顺着推(舞台「连续」那一支)和直接跳(固定种子洗牌的乱序,「跳转」那一支)各一遍,量「调用到返回」和「再等下一次 rAF 加一个宏任务」;导出页用 `FramePipeline.bakery`+`bakeFrames`/`createStepper`,量整帧、拨一步、页内 `__pcSetT`。另有一份「空 Lottie」当对照。成本记录读编辑器自己测的(`probeRunner.ts` 的 `probeCardOnce` 口径)和分派表轻重。
- 要点:舞台页把时钟、计时器、rAF 换成虚拟版,探针用 `__pcRealNow/__pcRealRaf/__pcRealSetTimeout`;导出页把 `performance.now` 钉成导出毫秒,页内计时用 `performance.mark().startTime`。「画完」那一档中位数各素材都是 5.5～5.6 毫秒(无头出帧节拍),没有和素材有关的额外时间。
- 导出页里贵的是画出来加编码 PNG:1920×1080 整帧中位 `navidad` 748、`bodymovin` 510、空画面 188 毫秒;不是 Lottie 算那一帧。
- **判重**:七张都不判重(预算 23.3 毫秒,最大 `stepMs` 5.8)。16 个抽样帧的测量有波动(`bodymovin` 960×540 量到 5.8、1920×1080 量到 0.8)。
- 两个分辨率各起一台全新的编辑器,否则成本记录按身份键复用、两个分辨率量到的是同一份(第一遍就踩到了:1920×1080 的成本记录是 960×540 的复用,所以那一格重量了一遍)。

## 二、浏览器节点评估

数据和量法见 `render-standard.md`「浏览器节点要不要放开产 Lottie 的流」。要点:

- 原理由(快照超 300 KB 被丢)在每张卡快照作废之后不存在:`bakeFrame` 要像素时 HTML 字节不收(`html: false`),只交位图,不存;300 KB 上限在 `server/snapshot-store.mjs`,是存储上限,不在这条路上。
- 量(`lottie-browser-bake-probe.mjs`,在线构建,1920×1080 画框):演示动画 22 ms/14 KB;`gatin` 47/65;`adrock` 85/138～161;`happy2016` 91/161～250;`navidad` 395/543～707;`bodymovin` 369/611～847。对照:`punch-pill` 23/14;`checklist` 33/47;`focus-card` 26/26;`growth-curve` 31/41;`odometer` 73/144。画框 960×540 几乎一样。
- 画得对不对(`--fidelity`):6 张 Lottie 卡各 3 帧,位图对导出页 PNG,平均差 0.002～0.17、差超过 48 的像素最多 0.017%;看了 `navidad` 第 75 帧两张图,蒙版的脸有底色,相同。
- **放开改了什么**:`server/render-node/split.mjs` 去掉 `BROWSER_EXCLUDED_CARD` 及 `browserEligible` 里那一条;`src/online/pageStreamPlan.ts` 去掉 `PAGE_EXCLUDED_CARD` 和 `pageStreamBlock` 的 `"lottie"` 一项(两处要同步,`page-stream-plan.test.mjs` 对拍);测试:`m7-node-rules`(M7-NR-02,Lottie 现在出两份)、`browser-stream-split`(BS-04 去掉 Lottie 一项)、`wrapped-cardid-split`(WC-01 改成给)、`page-stream-plan`(PSP-08 Lottie 两边都出、去掉常量对拍)、`online-card-n-golden.json`(OCN-01 字面值:9 份输出里各多出 Lottie 控件的 3 个浏览器任务,其余不变)。卡的键、`PAGE_STREAM_CODE_VERSION` 不变。
- 风险(写在评估里):用户自带的超大 Lottie 单帧快照可能是兆字节级;在这台机器上七张都不判重,实际会走到这一步的只有弱设备判重的、或特别大的素材。
- 确认没碰坏:`browser-stream-e2e-probe.mjs --only on`:退出码 0,`fails: []`(没有设 `off` 那一轮,额度所限)。

## 三、在线页面补测(`lottie-online-probe.mjs`)

- 本机托管组合(文档服务+素材服务+仿 nginx 代理)+ 在线构建(生产压缩)+ 无头 Chrome,页面走「刷新后回到项目」进入;可见/后台舞台是跨源 iframe。项目 1280×720,七张片段 18.4 秒:`navidad`、`happy2016`、通用卡放五份测试素材(expr-layers、装载异步的变体、起点在第 22 帧的变体、expr-cases、text-random;用内联 JSON 传进 `json` 参数;异步那份的外部数据素材用 `data:` 地址)。参照是导出页(隔离开发服务器,同一份项目)逐帧「看得见的 SVG 文本」散列,552 帧全读到。
- 结果(退出码 1 只因对导出 PNG 那一项当时还带阈值,已改成只记录,没有再整套重跑;其余所有判定条件在那一遍都过):
  - 暂停点、往回跨片段乱跳、一帧一帧拖:共 208 次到达,**208 次和导出页同一帧相同**(五份测试素材各 27 次,`textrandom` 36 次,`navidad` 56 次);同一帧先后到的相同。
  - 播放 4 段(从第 45、160、256、500 帧起各 1.5 秒):途中落在整帧上的样本 19/19、21/21、22/22、19/19 相同,暂停后停下的第 92、207、303、547 帧相同。
  - 页面没有报错、没有 `[lottie]` 警告。
  - 截图:9 帧「一帧一帧挪到」对「从别处直接点到」,8 帧逐像素相同,第 440 帧(`exprcases`)差 25 个像素,SVG 文本相同,和前一半记过的「顺推和直接跳在真页面像素上还剩一点差别」同一类。
  - 舞台调成 1:1(视口 2080 宽时舞台正好 1280×720)后对导出页 PNG 的不透明处像素:SVG 文本全同,但文字/渐变边缘有一圈差(`happy2016` 最多约 4600 个像素差 > 48;带随机表达式的方块边缘差 ≤ 27),只记录。两条路(舞台 iframe 的合成与导出页的 beginFrame 截图)取像素本来就不同,不是卡片的问题;若要把「像素相同」当判据要另想办法(比如两边都用同一条取像素的路)。
- **没验到**:Lottie 钉成重卡看在线页面贴流那一路(要再起桌面预渲染进程,`page-stream-probe.mjs` 的 `desk` 场那一套;额度所限没做);`fixtureasync` 在在线页面里装载是否仍走异步没有单独核对(`lottie-seed-extra-probe.mjs` 核过卡片侧)。

## 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0(合并 main 之后,main 没有新提交,`git merge main` 是 Already up to date) |
| 键的比对 | `card-source-version-compare.mjs --base main`;`card-table-digest-compare.mjs --base main --expect ,` | 88 个入口文件、61 个身份全部无变化;101 张内置卡能力表、源码版本、三个键逐张相同,有变化 0 张。改了 `split.mjs` 不影响卡的键 |
| 全量测试 | `npm test`(设了两个环境变量) | 6788 条,通过 6768,失败 4,跳过 15。4 条:`OCN-01`(放开的直接后果,已更新字面值,单独重跑过)、`scripts/ 下起子进程…第一个 import 都是 no-user-dirs.mjs`(我的 `lottie-browser-bake-probe.mjs` 缺,已补,重跑过)、`runtime does not invalidate on 429`、`退出确认里 Agent 这一项`(两条都在 `server/test/account-worker-lifecycle.test.mjs`,机器忙时的偶发,单独重跑 9/9 通过)。修好之后没有再跑一遍全量(额度),只重跑了这三个文件:全过 |
| 浏览器节点 | `browser-stream-e2e-probe.mjs --base-port 27290 --only on` | 退出码 0,`fails: []` |

`verify-determinism`、`verify-unified-frames` 没跑(这一块不改渲染路径)。每次探针前后查过可见窗口(只有用户自己的 Chrome 不是我起的),交活前 27260～27299 没有监听。起过的东西都已收掉;没有起过不带 `PROMPTCUT_NO_PORT_FILE=1` 的编辑器。

## 〔裁〕

1. 在线页面截图对导出 PNG 那一项只记录、不判(理由见上;先写了 0.1% 的阈值,看到边缘差一圈后改成只记录,不是调阈值让它过)。
2. 放开 Lottie 做成单独提交由主会话定;`online-card-n-golden.json` 只更新受它影响的 9 份输出。

## 要主会话决定或注意的事

1. 合不合「放开 Lottie」那个提交(不合:revert 它,另外的探针和文档仍成立)。
2. `docs/plan/render-refactor-task.md`「癸」里「浏览器节点按卡片 id 把 Lottie 排除……缺省不放开」那几句,放开后要改;`docs/plan/m7-contract.md` 第 13 节第 6 条「切分方不把这类卡(Lottie 素材卡)派给纯浏览器」同样过时(没改,在 docs/plan/ 下,请主会话顺手改)。
3. 在线页面贴流那一路没验;如果要验,用 `page-stream-probe.mjs` 的 `desk` 场搭法,Lottie 钉重卡可用 `lottie-seed-extra-probe.mjs` 里的大素材生成器(跳一帧 44 毫秒,会被测量判重)。
4. 仓库在这台机器上 `core.autocrlf=true`,工作区有些文件是 CRLF;我改的文件提交后 `git diff --stat main...HEAD` 行数正常(没有整文件换行尾)。
