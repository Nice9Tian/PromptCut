# AGENT-rr-play-alive:桌面版播放保活

分支 `claude/rr-play-alive`(从 main 162a72be 分出,交活前合过一次 main aa5ee127)。任务:播放期间页面定时向 `/api/data/playhead` 发保活,免得预渲染进程在「播放头下没有缺口」时误判用户不在播放、在播放中恢复产流(违反 `docs/semantics/mechanism/rendering.md`「重管线:预渲染」第 103 行「之后要补的只在暂停时产,播放时不产」)。

## 1. 开工先核的事实(全部对得上)

- `server/frame-pipeline.mjs` 的 `streamBusy()`:`head.playing && now - at < 5000` 或 `now - at < 800`;`at` 是预渲染进程收到 `/api/data/playhead` 的时刻(`server/mirror-store.mjs` 的 `setPlayhead` 盖 `Date.now()`)。队列节点 `server/queue-idle.mjs` 的 `interactionReason` 读的是同一个 `pipeline.playhead()`(门槛:`playing` 且 5 秒内,或 500 毫秒内动过)。
- 页面一侧(`src/render/dataMirror.ts`):播放头那条路播放中不推;播放中能刷新 `at` 的只有 `pushWanted`,而它在没有缺口时不发。`planFeed` 对有流平面的卡不报缺口。
- 推论成立,且已在真环境里复现(下节)。

## 2. 复现(main 代码上)

新探针 `scripts/probes/play-idle-probe.mjs`:真编辑器(`?editor&nosetup=1&preview=stage`)+ 真预渲染进程;项目里八张 `r6-stateful`(每张 6 秒、依次排开,都钉成重卡);等第一张(A)的轨道流盖满全段(稀疏版就算)后,在 A 里循环播放 20 秒(到 6.8 秒跳回 2.0 秒,播放头下只有 A);每 0.5 秒读预渲染进程的 `/api/frames/diagnostics`(已产分段数、截帧数、满密度分段数)和它手里的播放头(`GET /api/data/playhead` 的 `at`、`playing`);页面一侧给 `fetch` 装计数,记发了几条播放头请求、带不带 `wanted`。停下后再读 12 秒看多久恢复产流。

断言:a. 起播 5 秒后到停下前,预渲染进程手里的播放头一直「在播」且最近一次音讯不超过 3.5 秒;b. 同一段里已产分段数、截帧数、满密度分段数一个都没涨;c. 停下后 12 秒内恢复产流;另验场景成立(播放中页面没报过任何缺口)。

main 上(输出 `out/play-idle-before2.json`,退出码 1):

| 项 | 量到 |
|---|---|
| 播放 20 秒里页面发的播放头请求 | 1 条(起播那条);带 `wanted` 的 0 条 |
| 预渲染进程手里的播放头年龄(起播 5 秒后的 30 次采样) | 5.1 秒到 19.9 秒,30 次全部超过 3.5 秒 |
| 起播 5 秒后到停下前预渲染进程产了 | 53 个分段、855 帧,其中 48 个满密度分段 |
| 断言 | a 不过、b 不过;c 通过(因为播放中就没停过产流) |

第一次用四张卡试(`out/play-idle-before.json`)同样不过(46 个分段、734 帧),但活在播放期间就做完了,恢复那一条没有意义,所以加到八张。

顺带看到的:预渲染进程手里 `head.wanted` 长度为 1,是起播之前拖动留下的缺口提示,播放中页面没再报过,它一直留着(见 4.1)。

## 3. 修

只改页面一侧,`src/render/dataMirror.ts`:

- 常量 `PLAYHEAD_KEEPALIVE_MS = 2000`,只写一处。
- 播放中(`playing` 为真)起一个 2 秒的 `setInterval`,到点发 `{ session, t, playing: true }`;`playing` 变假、`started` 变假、disposer 都把它收掉;重复进订阅回调不会起第二个。
- 发送走和 `wanted` 同一条轻路:把原来 `sendWanted` 里的 fetch 抽成 `sendPlayheadLight(body)`(不 await、不读响应、`keepalive: true`、失败静默)。`/api/data/playhead` 的字面量仍只有这一处,在线构建的 `/api` 调用棘轮不变。
- 服务端的 5 秒、800 毫秒两个窗口不改;`server/mirror-store.mjs`、`server/vite-plugin-mirror.ts` 没动(保活不带 `wanted`,白名单两处不用同步改)。
- 只改了两处注释让它们与现状一致:`server/frame-pipeline.mjs` 的 `streamBusy` 注释、`server/queue-idle.mjs` 的 `PLAYING_STALE_MS` 注释(原来写「播放中页面按 100 ms 节流报 wanted」)。没有任何逻辑改动。

## 4. 要想清楚的几点

### 4.1 保活不带 `wanted`,会不会让过时的缺口一直留着误导插队?

不带。服务端 `setPlayhead` 对没带 `wanted` 的这一趟沿用上一次的,所以保活**既不刷新也不清掉**缺口提示。这和现状一致,没有变坏:现状里「停下推一次」和只带 `wanted` 的 100 毫秒路本来就是这样,而没有缺口时页面不发空表,所以拖动之后留下的 `wanted` 本来就会一直留到下一次非空的缺口(复现时的 `wanted: 1` 就是它)。

它能影响什么:`FramePipeline.nextBatchStart` 在批与批之间读 `wanted`,让含那一帧的 4 帧批先跑。过时的提示最多让一张卡的某一批提前,不影响结果的对错,也只在预渲染进程不忙(暂停时)才被读到。所以没有为此改 `normalizeWanted` / 转发体白名单(它们要一起改的约束留着没碰)。如果以后要让「没有缺口」也能清掉提示,要同时改三处:页面发空表、`normalizeWanted` 不把空表当「没报」、转发体白名单;那是另一件事,这里没做。

### 4.2 用什么推节拍,页面隐藏时发不发

用定时器(`setInterval`),不用 store 订阅节流。理由:播放的意图由 `playing` 表达,与 `t` 每帧在不在变无关;播放卡一下(解码等待)时 `t` 不动,但用户还在等画面,这时更不该让预渲染进程抢资源。

页面隐藏(`document.visibilityState === 'hidden'`)时**不发**:用户没在看,这时播放也推不动(播放循环靠 requestAnimationFrame),预渲染进程恢复产流可以接受(任务书同意);回到前台下一拍接着发。隐藏页面里 `setInterval` 本来也只会被限到每秒一次,不会更密。

### 4.3 不发保活的页面

镜像页判据没动:`isMirrorPage()`(只读观看页 `?observe` / `?view`、舞台页 `?stage`、导出页 `?export` 不镜像,`started` 不置位,订阅都不挂,自然没有保活)。停下时原有的「停下推一次」(`schedulePlayhead(400)` 那条等响应的路)没动。

### 4.4 在线页面

`isMirrorPage()` 第一行 `onlinePage()` 为真就返回 false,`startDataMirror()` 直接空转,没有订阅、没有计时器、没有请求。单测核了(在线页面播放 10 秒零请求)。

### 4.5 一个小竞态

保活是 fire-and-forget,理论上一条在路上的 `playing: true` 保活可能晚于「停下推一次」的 `playing: false` 到达,让服务端多当 5 秒「在播」。窗口:停下时先收计时器、400 毫秒后才推停下那一条,在路上的保活在本机回环上早到了;`wanted` 的轻路本来就有同样的性质,没有为此加序号。

## 5. 单测

- `src/render/dataMirrorKeepalive.test.mjs`(页面一侧,13 个):播放 30 秒内每条间隔 ≤ 2 秒(14～16 条,字段 `{session, t, playing: true}`、不带 `wanted`、`keepalive: true`、不挂超时);停下后零条保活、停下那一条照旧;停了又播不叠计时器;隐藏页面不发、回前台接着发;fetch 抛错或被拒静默;disposer 收掉计时器;开始镜像时已在播放也接上;`?observe`、`?view=`、`?stage`、`?export` 四种页面零请求;在线页面零请求。
- `server/test/playhead-keepalive.test.mjs`(服务端一侧,6 个):用注入的时钟(`mock.timers` 的 `Date`)走 30 秒,每 2 秒一条保活,每 250 毫秒问一次 `FramePipeline.prototype.streamBusy` 与 `interactionReason`,全程为忙(`playing`);对照:不保活时 5 秒整转闲(这就是毛病);保活停 5 秒后转闲、之前一直忙;丢一拍(4 秒没音讯)不过期;保活不带 `wanted` 时缺口提示原样沿用;停下推一次后转 `scrub`/忙再转闲。

## 6. 修后的验证

`node scripts/probes/play-idle-probe.mjs --port 27100 --out out/play-idle-after --json out/play-idle-after.json`:退出码 0,`fails: []`。

| 项 | main | 修后 |
|---|---|---|
| 播放 20 秒里页面发的播放头请求 | 1 条 | 11 条,时刻 12、2014、4005、6003、……、20007 毫秒,间隔 2.0 秒上下,全带 `playing: true`、不带 `wanted` |
| 预渲染进程手里播放头年龄(起播 5 秒后 30 次采样) | 5.1～19.9 秒 | 0.19～1.99 秒 |
| 起播 5 秒后到停下前预渲染进程产了 | 53 个分段 / 855 帧 / 48 个满密度分段 | 0 / 0 / 0 |
| 停下后恢复产流 | (从没停过) | 停下后 1.66 秒内多出分段(第一个分段出完才计数,约 1 秒是服务端的静默窗口加生产者醒来) |

修后又跑 `node scripts/probes/sparse-stream-probe.mjs --port 27110 --out out/sparse-after`:退出码 0,`ok: true`,`fails: []`(次序、稀疏版、位置矩形、舞台贴稀疏、补满密度、队列那条路逐条核对都过)。

两个探针都是合入 main(aa5ee127)之前跑的;合入的东西(在线稀疏的几处)没碰 `dataMirror.ts`、`mirror-store.mjs`、`vite-plugin-mirror.ts`,合入后没有重跑这两个探针。

## 7. 基线(合入 main aa5ee127 之后)

- `npx tsc -b --force`:退出码 0,零错误。
- `npm test`(设了两个环境变量):6762 条,通过 6745,失败 1,其余是已有的跳过项。失败的是 `server/test/account-logout-confirmation.test.mjs` 的「退出确认……」,原因是 `listen EADDRINUSE 127.0.0.1:36722`(随机端口被占,机器忙时偶发,与本改动无关)。单独重跑这个文件加上本次两份新测试:24 条全过、0 失败(第二次)。
- `node scripts/probes/card-source-version-compare.mjs --base main`:退出码 0,88 张卡的源码版本 0 变、61 个身份键 0 变。
- `node scripts/probes/card-table-digest-compare.mjs --base main --expect ,`:退出码 0,生成快照的代码指纹改前改后相同,101 张内置卡 0 张变。
- 不跑 `verify-determinism` / `verify-unified-frames`:本改动不碰渲染路径(任务书说明)。
- 窗口检查:每次探针前后查过可见窗口,只有用户自己的 Chrome(进程 26848,不是我起的);交活前确认没有残留的 node、Chrome、ffmpeg(开发服务器 27100/27110、预渲染进程、无头 Chrome 都已收掉)。

## 8. 没做成的 / 要注意的

- **桌面当队列节点那条路**:服务端一侧用 `interactionReason` 的单测核了(它与 `streamBusy` 读同一个 `pipeline.playhead()`,保活让它在整段播放里一直是 `playing`,保活停 5 秒转 `null`)。**没有**在真的队列节点(云端任务、桌面认领)上端到端验过,上面的真环境探针走的是本机预渲染进程自产自用那条路。
- 预渲染进程的端口是它自己选的(这次是 3454),不在分给我的 27100～27139 里;这是现有机制,所有拉起预渲染进程的探针都这样。
- 单测没有对「保活丢在竞态里」加序号(见 4.5)。

## 9. 对任务书或语义的更正建议

- `docs/semantics/mechanism/rendering.md` 第 103 行「之后要补的只在暂停时产,播放时不产」现在由「播放中页面每 2 秒发保活」保证;`mechanism/platforms.md` 或 `mechanism/rendering.md` 里讲「节点只在闲时认领」的地方如果提到「页面播放中按 100 ms 节流报上来」,应改成「每 2 秒保活,有缺口时另报」。我没改语义文档(任务规矩)。这是三级〔裁〕范围的措辞,不改变用户看到的行为。
